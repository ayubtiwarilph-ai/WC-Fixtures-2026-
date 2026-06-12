/* ============================================================
   WC26 Tracker — client-side logic
   No build step. No external JS dependencies.
   ============================================================ */

(() => {
  'use strict';

  // ---------- Config ----------
  // Multiple mirrors for the same CC0 dataset, tried in order. jsDelivr's GitHub mirror
  // sends explicit CORS headers and a JSON content-type, which is more consistently
  // reliable from a github.io origin than raw.githubusercontent.com (which occasionally
  // serves text/plain and can be blocked by ad/privacy extensions on some hosts).
  const FIXTURES_URLS = [
    'https://cdn.jsdelivr.net/gh/openfootball/worldcup.json@master/2026/worldcup.json',
    'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json'
  ];
  const GROUPS_URLS = [
    'https://cdn.jsdelivr.net/gh/openfootball/worldcup.json@master/2026/worldcup.groups.json',
    'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.groups.json'
  ];
  const GROUPS_CACHE_KEY = 'wc26_groups_cache_v1';
  const CACHE_KEY = 'wc26_fixtures_cache_v1';
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  const LIVE_POLL_MS = 60 * 1000;          // 60 seconds
  const MATCH_WINDOW_MS = 2.25 * 60 * 60 * 1000; // assume ~2h15m incl. stoppage
  const NPT_OFFSET_MIN = 5 * 60 + 45; // UTC+5:45, no DST

  // football-data.org token (optional). User can set window.FD_TOKEN before this script,
  // or it stays null and live polling is skipped gracefully.
  const FD_TOKEN = window.FD_TOKEN || null;
  const FD_BASE = 'https://api.football-data.org/v4';

  // ---------- Country name -> flag emoji ----------
  // Maps common World Cup team names to ISO codes for flag emoji.
  const FLAG_MAP = {
    'Mexico':'MX','South Africa':'ZA','South Korea':'KR','Korea Republic':'KR','Czech Republic':'CZ','Czechia':'CZ',
    'Canada':'CA','Bosnia & Herzegovina':'BA','Bosnia and Herzegovina':'BA','Qatar':'QA','Switzerland':'CH',
    'Brazil':'BR','Morocco':'MA','Haiti':'HT','Scotland':'GB-SCT',
    'USA':'US','United States':'US','Paraguay':'PY','Australia':'AU','Turkey':'TR','Türkiye':'TR',
    'Germany':'DE','Curacao':'CW','Curaçao':'CW','Ivory Coast':'CI',"Côte d'Ivoire":'CI','Ecuador':'EC',
    'Netherlands':'NL','Japan':'JP','Sweden':'SE','Tunisia':'TN',
    'Belgium':'BE','Egypt':'EG','Iran':'IR','New Zealand':'NZ',
    'Spain':'ES','Cape Verde':'CV','Saudi Arabia':'SA','Uruguay':'UY',
    'France':'FR','Senegal':'SN','Iraq':'IQ','Norway':'NO',
    'Argentina':'AR','Algeria':'DZ','Austria':'AT','Jordan':'JO',
    'Portugal':'PT','DR Congo':'CD','Congo DR':'CD','Uzbekistan':'UZ','Colombia':'CO',
    'England':'GB-ENG','Croatia':'HR','Ghana':'GH','Panama':'PA'
  };

  // For ISO-3166-1 alpha-2 codes, build a regional-indicator flag.
  function isoToFlagEmoji(iso){
    if (!iso || iso.length !== 2) return null;
    const A = 0x1F1E6;
    const codePoints = iso.toUpperCase().split('').map(c => A + (c.charCodeAt(0) - 65));
    return String.fromCodePoint(...codePoints);
  }
  // Special non-ISO subdivision flags (England, Scotland, Wales) via tag sequences.
  const SPECIAL_FLAGS = {
    'GB-ENG': '🏴', // England (best-effort; falls back to GB if unsupported)
    'GB-SCT': '🏴', // Scotland
    'GB-WLS': '🏴'  // Wales
  };
  function flagFor(teamName){
    const iso = FLAG_MAP[teamName];
    if (!iso) return '🏳️';
    if (iso.startsWith('GB-')) return SPECIAL_FLAGS[iso] || isoToFlagEmoji('GB');
    return isoToFlagEmoji(iso) || '🏳️';
  }

  // ---------- DOM refs ----------
  const $ = (sel) => document.querySelector(sel);
  const clockNPT = $('#clock-npt');
  const clockLocal = $('#clock-local');
  const searchInput = $('#search-input');
  const filterBtns = document.querySelectorAll('.filter-btn');
  const fixturesList = $('#fixtures-list');
  const statusRegion = $('#status-region');
  const countdownTimer = $('#countdown-timer');
  const nextMatchLine = $('#next-match-line');
  const tabFixtures = $('#tab-fixtures');
  const tabStandings = $('#tab-standings');
  const panelFixtures = $('#panel-fixtures');
  const panelStandings = $('#panel-standings');
  const standingsWrap = $('#standings-wrap');
  const standingsStatus = $('#standings-status');

  // ---------- State ----------
  let matches = [];     // normalized match objects
  let groups = [];      // [{name, teams:[...]}]
  let activeFilter = 'all';
  let searchTerm = '';

  // ---------- Utilities ----------
  function pad(n){ return String(n).padStart(2,'0'); }

  // Convert a Date (true UTC instant) to its "wall clock" representation in Nepal time (UTC+5:45).
  // Date.getTime() is always a UTC epoch ms value, independent of the browser's local timezone,
  // so we simply add the fixed NPT offset and read back with the UTC getters.
  function toNPT(date){
    return new Date(date.getTime() + NPT_OFFSET_MIN * 60000);
  }
  function fmtTime(d){ return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
  function fmtDate(d){
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  // ---------- Live clocks ----------
  function tickClocks(){
    const now = new Date();
    const npt = toNPT(now);
    clockNPT.textContent = `${fmtTime(npt)}:${pad(npt.getUTCSeconds())}`;
    clockLocal.textContent = now.toLocaleTimeString();
  }
  setInterval(tickClocks, 1000);
  tickClocks();

  // ---------- Fetch helper with mirror fallback ----------
  // Tries each URL in order; returns parsed JSON from the first that succeeds.
  // Collects per-URL errors so the status message can be diagnostic if all fail.
  async function fetchJsonWithFallback(urls){
    const errors = [];
    for (const url of urls){
      try{
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
        const text = await res.text();
        return JSON.parse(text);
      } catch (err){
        errors.push(`${new URL(url).hostname}: ${err.message}`);
      }
    }
    throw new Error(errors.join(' | '));
  }

  // ---------- Fetch + normalize fixtures ----------
  async function loadFixtures(){
    // Try cache first for instant render
    const cached = readCache();
    if (cached){
      matches = cached.matches;
      render();
    }

    try{
      const data = await fetchJsonWithFallback(FIXTURES_URLS);
      matches = normalize(data);
      writeCache(matches);
      statusRegion.textContent = `Loaded ${matches.length} fixtures · Source: openfootball/worldcup.json · ` +
        `Last fetched ${new Date().toLocaleString()}`;
      render();
      renderStandings();
      renderBracket();
      startLivePolling();
    } catch (err){
      if (cached){
        statusRegion.textContent = `Live fixture feed unavailable (${err.message}). Showing cached data from ` +
          `${new Date(cached.ts).toLocaleString()}.`;
      } else {
        statusRegion.textContent = `Could not load fixtures (${err.message}). Please check your connection and reload, or open the browser console for details.`;
        fixturesList.innerHTML = `<div class="empty-state">No fixture data available offline.<br>Error: ${escapeHtml(err.message)}</div>`;
      }
      console.error('WC26 Tracker: fixture load failed:', err);
    }
  }

  // ---------- Fetch group rosters (for standings table) ----------
  async function loadGroups(){
    const cached = readGroupsCache();
    if (cached){
      groups = cached.groups;
      renderStandings();
    }
    try{
      const data = await fetchJsonWithFallback(GROUPS_URLS);
      groups = data.groups || [];
      try{ localStorage.setItem(GROUPS_CACHE_KEY, JSON.stringify({ ts: Date.now(), groups })); } catch {}
      renderStandings();
    } catch (err){
      if (!cached){
        standingsStatus.textContent = `Could not load group rosters (${err.message}).`;
      }
      console.error('WC26 Tracker: groups load failed:', err);
    }
  }
  function readGroupsCache(){
    try{
      const raw = localStorage.getItem(GROUPS_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function readCache(){
    try{
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts > CACHE_TTL_MS * 4) return parsed; // still usable as last resort
      return parsed;
    } catch { return null; }
  }
  function writeCache(matches){
    try{
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), matches }));
    } catch { /* ignore quota errors */ }
  }

  // openfootball worldcup.json schema (flat): { name, matches: [ {round,date,time,team1,team2,group,ground,score1?,score2?,score?} ] }
  // `time` is like "13:00 UTC-6" — local kickoff time with a UTC offset that must be parsed.
  function parseKickoffToUTC(dateStr, timeStr){
    if (!dateStr || !timeStr) return null;
    const m = timeStr.match(/^(\d{1,2}):(\d{2})\s*UTC([+-]\d{1,2})(?::?(\d{2}))?$/i);
    if (!m) {
      // Fallback: assume already UTC "HH:MM"
      const d = new Date(`${dateStr}T${timeStr.padStart(5,'0')}:00Z`);
      return isNaN(d.getTime()) ? null : d;
    }
    const [, hh, mm, offHours, offMins] = m;
    const offsetMinutesTotal = (parseInt(offHours,10) * 60) + (offHours.startsWith('-') ? -1 : 1) * (parseInt(offMins || '0',10));
    // Local kickoff as if UTC, then subtract the offset to get true UTC instant.
    const localAsUtc = new Date(`${dateStr}T${hh.padStart(2,'0')}:${mm}:00Z`);
    if (isNaN(localAsUtc.getTime())) return null;
    return new Date(localAsUtc.getTime() - offsetMinutesTotal * 60000);
  }

  function normalize(data){
    const list = data.matches || [];
    const out = list.map((m, idx) => {
      const utcDate = parseKickoffToUTC(m.date, m.time);
      let score1 = m.score1 != null ? m.score1 : (m.score && m.score.ft ? m.score.ft[0] : null);
      let score2 = m.score2 != null ? m.score2 : (m.score && m.score.ft ? m.score.ft[1] : null);
      return {
        id: `${idx}-${m.team1}-${m.team2}-${m.date}`,
        round: m.round || '',
        group: m.group || null,
        date: m.date || null,
        utc: utcDate,
        team1: m.team1 || '?',
        team2: m.team2 || '?',
        score1, score2,
        venue: m.ground || m.stadium || m.venue || null,
        status: 'scheduled' // overwritten by computeStatus()
      };
    });
    out.forEach(computeStatus);
    out.sort((a,b) => (a.utc?.getTime() ?? 0) - (b.utc?.getTime() ?? 0));
    return out;
  }

  function computeStatus(m){
    if (m.score1 != null && m.score2 != null){
      m.status = 'finished';
      return;
    }
    if (!m.utc){ m.status = 'scheduled'; return; }
    const now = Date.now();
    const start = m.utc.getTime();
    if (now < start) m.status = 'scheduled';
    else if (now >= start && now <= start + MATCH_WINDOW_MS) m.status = 'live';
    else m.status = 'finished'; // window passed but no score yet (feed lag)
  }

  // ---------- Live score polling (football-data.org, optional) ----------
  let pollHandle = null;
  function startLivePolling(){
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(pollLiveScores, LIVE_POLL_MS);
    pollLiveScores();
  }

  async function pollLiveScores(){
    matches.forEach(computeStatus);
    const liveOrRecent = matches.filter(m => m.status === 'live');
    render(); // refresh statuses/countdown even without API

    if (!FD_TOKEN || liveOrRecent.length === 0) return;

    try{
      const res = await fetch(`${FD_BASE}/competitions/WC/matches?status=LIVE`, {
        headers: { 'X-Auth-Token': FD_TOKEN }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      (data.matches || []).forEach(fm => {
        const home = fm.homeTeam?.name, away = fm.awayTeam?.name;
        const match = matches.find(m =>
          m.status !== 'finished' &&
          m.team1?.toLowerCase().includes(home?.toLowerCase().split(' ')[0]) &&
          m.team2?.toLowerCase().includes(away?.toLowerCase().split(' ')[0])
        );
        if (match && fm.score?.fullTime){
          match.score1 = fm.score.fullTime.home ?? match.score1;
          match.score2 = fm.score.fullTime.away ?? match.score2;
          if (fm.status === 'FINISHED') match.status = 'finished';
        }
      });
      render();
      renderStandings();
    } catch {
      // Silent fail — fixture-only mode continues.
    }
  }

  // ---------- Countdown to next match ----------
  function tickCountdown(){
    const now = Date.now();
    const next = matches.find(m => m.utc && m.utc.getTime() > now);
    if (!next){
      nextMatchLine.textContent = matches.length ? 'No more upcoming matches scheduled.' : '—';
      countdownTimer.textContent = '--:--:--:--';
      return;
    }
    const diff = next.utc.getTime() - now;
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    countdownTimer.innerHTML =
      `${pad(days)}<span>d</span> ${pad(hours)}<span>h</span> ${pad(mins)}<span>m</span> ${pad(secs)}<span>s</span>`;
    nextMatchLine.textContent =
      `${flagFor(next.team1)} ${next.team1} vs ${next.team2} ${flagFor(next.team2)}` +
      (next.group ? ` · ${next.group}` : '') +
      ` · ${fmtTime(toNPT(next.utc))} NPT`;
  }
  setInterval(tickCountdown, 1000);

  // ---------- Rendering ----------
  function matchMatchesFilters(m){
    if (activeFilter !== 'all' && m.status !== activeFilter) return false;
    if (searchTerm){
      const haystack = `${m.team1} ${m.team2} ${m.group || ''} ${m.round}`.toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }
    return true;
  }

  function render(){
    matches.forEach(computeStatus);
    tickCountdown();

    const filtered = matches.filter(matchMatchesFilters);

    if (filtered.length === 0){
      fixturesList.innerHTML = `<div class="empty-state">No matches match your search/filter.</div>`;
      return;
    }

    // Group by date (Nepal-local day for readability)
    const dayGroups = new Map();
    filtered.forEach(m => {
      const key = m.utc ? fmtDate(toNPT(m.utc)) : (m.date || 'TBD');
      if (!dayGroups.has(key)) dayGroups.set(key, []);
      dayGroups.get(key).push(m);
    });

    let html = '';
    dayGroups.forEach((list, dayLabel) => {
      const gregUtc = list[0].utc ? fmtDate(list[0].utc) : '';
      html += `<section class="day-group">
        <h2 class="day-heading">
          <span>${dayLabel} <span style="color:var(--muted); font-weight:400;">(Nepal time)</span></span>
          <span class="greg">UTC date: ${gregUtc}</span>
        </h2>`;
      list.forEach(m => { html += renderMatchCard(m); });
      html += `</section>`;
    });

    fixturesList.innerHTML = html;
  }

  function renderMatchCard(m){
    const npt = m.utc ? toNPT(m.utc) : null;
    const nptTime = npt ? fmtTime(npt) : 'TBD';
    const utcTime = m.utc ? `${fmtTime(m.utc)} UTC` : '';
    const hasScore = m.score1 != null && m.score2 != null;

    const statusLabel = { live:'Live', finished:'Final', scheduled:'Scheduled' }[m.status] || m.status;

    return `
      <article class="match-card" tabindex="0"
        aria-label="${m.team1} versus ${m.team2}, ${statusLabel}, ${nptTime} Nepal time">
        <div class="match-time">
          <div class="npt">${nptTime}</div>
          <div class="utc">${utcTime}</div>
        </div>
        <div class="teams">
          <span class="team"><span class="flag" aria-hidden="true">${flagFor(m.team1)}</span> ${escapeHtml(m.team1)}</span>
          ${hasScore
            ? `<span class="score">${m.score1} – ${m.score2}</span>`
            : `<span class="vs">vs</span>`}
          <span class="team">${escapeHtml(m.team2)} <span class="flag" aria-hidden="true">${flagFor(m.team2)}</span></span>
        </div>
        <div class="meta">
          <span class="status-badge ${m.status}">${statusLabel}</span>
          <span>${m.group ? m.group : m.round}</span>
          ${m.venue ? `<span>${escapeHtml(m.venue)}</span>` : ''}
        </div>
      </article>`;
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ---------- Standings (Groups & Table) ----------
  function computeGroupStandings(groupName, teams){
    const table = new Map();
    teams.forEach(t => table.set(t, {
      team: t, played:0, won:0, drawn:0, lost:0, gf:0, ga:0, gd:0, pts:0
    }));

    matches
      .filter(m => m.group === groupName && m.score1 != null && m.score2 != null)
      .forEach(m => {
        const a = table.get(m.team1);
        const b = table.get(m.team2);
        if (!a || !b) return; // team not in this group's roster (shouldn't happen)
        a.played++; b.played++;
        a.gf += m.score1; a.ga += m.score2;
        b.gf += m.score2; b.ga += m.score1;
        if (m.score1 > m.score2){ a.won++; b.lost++; a.pts += 3; }
        else if (m.score1 < m.score2){ b.won++; a.lost++; b.pts += 3; }
        else { a.drawn++; b.drawn++; a.pts += 1; b.pts += 1; }
      });

    const rows = Array.from(table.values());
    rows.forEach(r => { r.gd = r.gf - r.ga; });
    // Sort: points desc, goal difference desc, goals for desc, name asc (head-to-head not computed)
    rows.sort((x,y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.team.localeCompare(y.team));
    return rows;
  }

  function renderStandings(){
    if (!groups.length) return;

    let html = '';
    groups.forEach(g => {
      const rows = computeGroupStandings(g.name, g.teams);
      html += `<div class="group-table">
        <h3>${escapeHtml(g.name)}</h3>
        <table class="standings">
          <caption class="visually-hidden">${escapeHtml(g.name)} standings: position, team, played, won, drawn, lost, goals for, goals against, goal difference, points</caption>
          <thead>
            <tr>
              <th scope="col">Team</th>
              <th scope="col">P</th>
              <th scope="col">W</th>
              <th scope="col">D</th>
              <th scope="col">L</th>
              <th scope="col">GF</th>
              <th scope="col">GA</th>
              <th scope="col">GD</th>
              <th scope="col">Pts</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td class="team-cell"><span class="flag" aria-hidden="true">${flagFor(r.team)}</span> ${escapeHtml(r.team)}</td>
                <td>${r.played}</td>
                <td>${r.won}</td>
                <td>${r.drawn}</td>
                <td>${r.lost}</td>
                <td>${r.gf}</td>
                <td>${r.ga}</td>
                <td>${r.gd > 0 ? '+' + r.gd : r.gd}</td>
                <td class="pts">${r.pts}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="standings-legend"><span><span class="swatch" aria-hidden="true"></span>Top 2 advance to Round of 32 (8 best third-placed teams also qualify)</span></div>
      </div>`;
    });

    standingsWrap.innerHTML = html;
    standingsStatus.textContent = `Standings computed from ${matches.filter(m => m.score1 != null && m.score2 != null).length} completed match result(s) in the fixture feed.`;
  }

  // ---------- Tab switching ----------
  function activateTab(tab){
    const isFixtures = tab === 'fixtures';
    tabFixtures.setAttribute('aria-selected', String(isFixtures));
    tabStandings.setAttribute('aria-selected', String(!isFixtures));
    panelFixtures.hidden = !isFixtures;
    panelStandings.hidden = isFixtures;
  }
  tabFixtures.addEventListener('click', () => activateTab('fixtures'));
  tabStandings.addEventListener('click', () => activateTab('standings'));
  // Arrow-key navigation between tabs
  [tabFixtures, tabStandings].forEach((btn, i, arr) => {
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
        e.preventDefault();
        const next = arr[(i + (e.key === 'ArrowRight' ? 1 : -1) + arr.length) % arr.length];
        next.focus();
        next.click();
      }
    });
  });

  // ---------- Event wiring ----------
  searchInput.addEventListener('input', (e) => {
    searchTerm = e.target.value.trim().toLowerCase();
    render();
  });

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      activeFilter = btn.dataset.filter;
      render();
    });
    // Keyboard: Enter/Space already trigger click on buttons natively.
  });

  // Periodic full re-fetch (every 6h) while tab stays open
  setInterval(loadFixtures, CACHE_TTL_MS);
  setInterval(loadGroups, CACHE_TTL_MS);

  // ---------- Init ----------
  loadFixtures();
  loadGroups();
  // Re-check statuses every 30s even if live polling/API is unavailable,
  // so "scheduled" -> "live" -> "finished" transitions happen on time.
  setInterval(render, 30 * 1000);

})();
