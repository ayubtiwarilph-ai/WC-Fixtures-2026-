/* ============================================================
   WC26 Tracker — client-side logic
   No build step. No external JS dependencies.
   ============================================================ */

(() => {
  'use strict';

  // ---------- Config ----------
  // Multiple mirrors for the same CC0 dataset, tried in order.
  // raw.githubusercontent.com is tried FIRST because it always serves the latest commit
  // (no caching delay) — important since match scores are added to this file as the
  // tournament progresses. jsDelivr's GitHub mirror is a fallback for when raw.github
  // is unreachable, but jsDelivr aggressively caches files for hours/days, so a score
  // update can take a long time to appear there.
  const FIXTURES_URLS = [
    'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json',
    'https://cdn.jsdelivr.net/gh/openfootball/worldcup.json@master/2026/worldcup.json'
  ];
  const GROUPS_URLS = [
    'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.groups.json',
    'https://cdn.jsdelivr.net/gh/openfootball/worldcup.json@master/2026/worldcup.groups.json'
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
  const tabBracket = $('#tab-bracket');
  const panelBracket = $('#panel-bracket');
  const bracketWrap = $('#bracket-wrap');
  const bracketStatus = $('#bracket-status');
  const roundSelector = $('#round-selector');

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
    const cacheBuster = `cb=${Date.now()}`;
    for (const url of urls){
      const bustUrl = url + (url.includes('?') ? '&' : '?') + cacheBuster;
      try{
        const res = await fetch(bustUrl, { cache: 'no-store' });
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
      renderStandings();
      renderBracket();
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
      renderBracket();
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
      // Revive `utc` fields back into Date objects (JSON has no Date type).
      parsed.matches = (parsed.matches || []).map(m => ({
        ...m,
        utc: m.utc ? new Date(m.utc) : null
      }));
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
        num: m.num != null ? m.num : null,
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

  // ---------- Knockout bracket ----------
  const BRACKET_ROUNDS = ['Round of 32', 'Round of 16', 'Quarter-final', 'Semi-final', 'Final'];

  // Resolve a placeholder code like "1A" (group winner), "2B" (group runner-up),
  // "3C/D/F/G/H" (best third-placed team), "W97" (winner of match #97), or "L101"
  // (loser of match #101) into a display object { name, flag, resolved, placeholder }.
  function resolveSlot(code, matchByNum){
    if (!code) return { name: '?', resolved: false, placeholder: '?' };

    // Winner / loser of a specific match number
    let m = code.match(/^([WL])(\d+)$/);
    if (m){
      const [, wl, numStr] = m;
      const ref = matchByNum.get(Number(numStr));
      if (!ref || ref.score1 == null || ref.score2 == null){
        return { name: null, resolved: false, placeholder: `${wl === 'W' ? 'Winner' : 'Loser'} of Match ${numStr}` };
      }
      const team1Won = ref.score1 > ref.score2;
      // Penalty-shootout winners aren't in this dataset's score field; ties at this
      // stage would need extra-time/penalty data we don't have, so draws stay unresolved.
      if (ref.score1 === ref.score2){
        return { name: null, resolved: false, placeholder: `${wl === 'W' ? 'Winner' : 'Loser'} of Match ${numStr} (pens)` };
      }
      const winnerCode = team1Won ? ref.team1 : ref.team2;
      const loserCode = team1Won ? ref.team2 : ref.team1;
      // The referenced match's own team fields may themselves be unresolved
      // placeholders (e.g. "2A"), so resolve recursively.
      return resolveTeamField(wl === 'W' ? winnerCode : loserCode, matchByNum);
    }

    // Group winner / runner-up, e.g. "1A" or "2B"
    m = code.match(/^([12])([A-L])$/);
    if (m){
      const [, pos, groupLetter] = m;
      const groupName = `Group ${groupLetter}`;
      const group = groups.find(g => g.name === groupName);
      if (!group) return { name: null, resolved: false, placeholder: code };
      const rows = computeGroupStandings(groupName, group.teams);
      const allPlayed = rows.every(r => r.played === group.teams.length - 1);
      if (!allPlayed) return { name: null, resolved: false, placeholder: `${pos === '1' ? '1st' : '2nd'} ${groupName}` };
      const team = rows[Number(pos) - 1];
      return { name: team.team, resolved: true };
    }

    // Best third-placed team across several groups, e.g. "3C/D/F/G/H"
    m = code.match(/^3([A-L](?:\/[A-L])+)$/);
    if (m){
      const letters = m[1].split('/');
      return { name: null, resolved: false, placeholder: `Best 3rd place: Grp ${letters.join('/')}` };
    }

    // Already a real team name (shouldn't normally happen pre-tournament)
    return { name: code, resolved: true };
  }

  const ALL_BRACKET_ROUNDS = [...BRACKET_ROUNDS, 'Match for third place'];
  let activeBracketRound = null; // set on first render

  function renderBracket(){
    const matchByNum = new Map();
    matches.forEach(m => { if (m.num != null) matchByNum.set(m.num, m); });

    const byRound = new Map();
    ALL_BRACKET_ROUNDS.forEach(r => byRound.set(r, []));
    matches.forEach(m => {
      if (byRound.has(m.round)) byRound.get(m.round).push(m);
    });
    ALL_BRACKET_ROUNDS.forEach(r => byRound.get(r).sort((a,b) => (a.num ?? 0) - (b.num ?? 0)));

    if (byRound.get('Round of 32').length === 0){
      bracketWrap.innerHTML = `<div class="empty-state">Knockout fixtures not found in the feed.</div>`;
      roundSelector.innerHTML = '';
      return;
    }

    // Build round-selector pills once (idempotent — only rebuild if empty)
    if (!roundSelector.dataset.built){
      roundSelector.innerHTML = ALL_BRACKET_ROUNDS.map(r => {
        const label = r === 'Match for third place' ? 'Third Place' : r;
        return `<button class="filter-btn" data-round="${escapeHtml(r)}" aria-pressed="false">${escapeHtml(label)}</button>`;
      }).join('');
      roundSelector.dataset.built = '1';
      roundSelector.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => setActiveBracketRound(btn.dataset.round));
      });
      activeBracketRound = 'Round of 32';
    }

    // Sync pressed state
    roundSelector.querySelectorAll('.filter-btn').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.round === activeBracketRound));
    });

    const roundMatches = byRound.get(activeBracketRound) || [];
    if (roundMatches.length === 0){
      bracketWrap.innerHTML = `<div class="empty-state">No matches found for this round.</div>`;
    } else {
      bracketWrap.innerHTML = roundMatches.map(m => renderBracketBox(m, matchByNum)).join('');
    }

    const resolvedCount = matches.filter(m => ALL_BRACKET_ROUNDS.includes(m.round) && m.score1 != null).length;
    const totalCount = matches.filter(m => ALL_BRACKET_ROUNDS.includes(m.round)).length;
    bracketStatus.textContent = `${resolvedCount} of ${totalCount} knockout matches completed. ` +
      `Team names fill in automatically as results arrive.`;
  }

  function setActiveBracketRound(roundName){
    activeBracketRound = roundName;
    renderBracket();
  }

  const PLACEHOLDER_RE = /^([WL]\d+|[123][A-L]|3[A-L](?:\/[A-L])+)$/;
  function resolveTeamField(code, matchByNum){
    if (PLACEHOLDER_RE.test(code)) return resolveSlot(code, matchByNum);
    return { name: code, resolved: true };
  }

  function renderBracketBox(m, matchByNum){
    const slot1 = resolveTeamField(m.team1, matchByNum);
    const slot2 = resolveTeamField(m.team2, matchByNum);

    const hasScore = m.score1 != null && m.score2 != null;
    const team1Wins = hasScore && m.score1 > m.score2;
    const team2Wins = hasScore && m.score2 > m.score1;

    const renderTeam = (slot, score, isWinner) => {
      const label = slot.resolved
        ? `<span class="flag" aria-hidden="true">${flagFor(slot.name)}</span> ${escapeHtml(slot.name)}`
        : `<span class="placeholder">${escapeHtml(slot.placeholder || 'TBD')}</span>`;
      return `<div class="bx-team${isWinner ? ' winner' : ''}">
        <span class="bx-name">${label}</span>
        ${hasScore ? `<span class="bx-score">${score}</span>` : ''}
      </div>`;
    };

    const npt = m.utc ? toNPT(m.utc) : null;
    const dateLabel = npt ? `${fmtDate(npt).split(',')[0]} ${fmtTime(npt)} NPT` : (m.date || 'TBD');
    const statusClass = m.status === 'live' ? 'live' : (hasScore ? 'finished' : '');

    return `<div class="bracket-box ${statusClass}">
      <div class="bx-meta"><span>${escapeHtml(m.venue || '')}</span><span>${escapeHtml(dateLabel)}</span></div>
      ${renderTeam(slot1, m.score1, team1Wins)}
      ${renderTeam(slot2, m.score2, team2Wins)}
    </div>`;
  }

  // ---------- Tab switching ----------
  const TABS = {
    fixtures: { btn: tabFixtures, panel: panelFixtures },
    standings: { btn: tabStandings, panel: panelStandings },
    bracket: { btn: tabBracket, panel: panelBracket }
  };
  function activateTab(name){
    Object.entries(TABS).forEach(([key, { btn, panel }]) => {
      const active = key === name;
      btn.setAttribute('aria-selected', String(active));
      panel.hidden = !active;
    });
  }
  Object.entries(TABS).forEach(([name, { btn }]) => {
    btn.addEventListener('click', () => activateTab(name));
  });
  // Arrow-key navigation between tabs
  const tabOrder = [tabFixtures, tabStandings, tabBracket];
  tabOrder.forEach((btn, i) => {
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
        e.preventDefault();
        const next = tabOrder[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabOrder.length) % tabOrder.length];
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
  setInterval(() => { render(); renderBracket(); }, 30 * 1000);

})();
