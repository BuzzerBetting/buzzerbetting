export const handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { eventId, home, away } = event.queryStringParameters || {};
  if (!eventId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'eventId required' }) };

  const hash    = process.env.BB_HASH;
  const cookies = process.env.BB_COOKIES;
  if (!hash || !cookies) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BB_HASH or BB_COOKIES not set' }) };

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // ── Name normalisation ─────────────────────────────────────────────────────
  function norm(n) {
    return (n || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fuzzyMatch(a, b) {
    const na = norm(a), nb = norm(b);
    if (na === nb) return true;
    const wa = na.split(' '), wb = nb.split(' ');
    const [shorter, longer] = wa.length <= wb.length ? [wa, nb] : [wb, na];
    if (shorter.filter(w => w.length > 1).every(w => longer.includes(w))) return true;
    // Near-match: catches Willian/William, Moseis/Moises etc (1 char difference)
    const pairMatch = (a, b) => a.length >= 4 && b.length >= 4 &&
      Math.abs(a.length - b.length) <= 1 &&
      [...a].filter((c, i) => c !== (b[i] || '')).length <= 1;
    return wa.some(a => wb.some(b => pairMatch(a, b))) &&
      wa.filter(w => w.length > 3).some(a => wb.some(b => pairMatch(a, b)));
  }

  // ── Match a BB event string against home/away team names ───────────────────
  // BB event strings look like: "Ecuador v Germany", "Man City vs Liverpool"
  function matchByTeams(bbEvent, homeTeam, awayTeam) {
    if (!bbEvent || !homeTeam || !awayTeam) return false;
    const e = norm(bbEvent);
    // Try both "home v away" and "away v home" orderings
    return (fuzzyMatch(homeTeam, e.split(' v ')[0]) && fuzzyMatch(awayTeam, e.split(' v ')[1])) ||
           (fuzzyMatch(awayTeam, e.split(' v ')[0]) && fuzzyMatch(homeTeam, e.split(' v ')[1])) ||
           // Also handle "vs" separator
           (fuzzyMatch(homeTeam, e.split(' vs ')[0]) && fuzzyMatch(awayTeam, e.split(' vs ')[1])) ||
           (fuzzyMatch(awayTeam, e.split(' vs ')[0]) && fuzzyMatch(homeTeam, e.split(' vs ')[1])) ||
           // Fallback: both team names appear somewhere in the event string
           (e.includes(norm(homeTeam).split(' ').pop()) && e.includes(norm(awayTeam).split(' ').pop()));
  }

  try {
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`https://www.bookiebashing.net/node/rest/goals/list?t=${ts}`, {
      headers: {
        'User-Agent': UA,
        'Cookie': cookies,
        'X-BB-Hash': hash,
        'X-BB-User': 'user',
        'X-BB-Userid': '11815',
        'X-BB-Userlevel': '1',
        'Referer': 'https://www.bookiebashing.net/tools/daily/',
        'Origin': 'https://www.bookiebashing.net'
      }
    });

    const text = await res.text();
    if (text.trim().startsWith('<')) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false, error: 'BB returned HTML — hash or cookies may have expired'
    })};

    const list = JSON.parse(text);

    // ── Find the match ─────────────────────────────────────────────────────
    // 1. Try exact eventId match (in case BB ever uses FotMob IDs)
    let match = list.find(m =>
      String(m.eventId) === String(eventId) ||
      String(m.id)      === String(eventId) ||
      String(m._id)     === String(eventId)
    );

    // 2. Try team name matching if we have home/away
    if (!match && home && away) {
      match = list.find(m => matchByTeams(m.event || m.name || m.eventName, home, away));
    }

    if (!match) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false,
      error: `Match not found in BB list (tried eventId ${eventId}${home ? ` and teams "${home}" vs "${away}"` : ''})`,
      available: list.slice(0, 15).map(m => ({ id: m.id || m._id, eventId: m.eventId, event: m.event || m.name || m.eventName }))
    })};

    // ── Build player odds map ──────────────────────────────────────────────
    const playerOdds = {};

    const playerXg = match.playerXg || {};
    for (const [name, data] of Object.entries(playerXg)) {
      if (name === 'No Goalscorer') continue;
      playerOdds[name] = {
        name,
        fgs: data.firstBbp    || null,
        ags: data.anytimeBbp  || null,
        bfexAgs: data.anytimeExchange?.back || null,
        sot: null
      };
    }

    const sots = match.sots || [];
    for (const entry of sots) {
      const sotName = entry.selection?.name;
      const sotBack = entry.back;
      if (!sotName || !sotBack) continue;
      const matchedKey = Object.keys(playerOdds).find(k => fuzzyMatch(k, sotName));
      if (matchedKey) {
        if (!playerOdds[matchedKey].sot || sotBack < playerOdds[matchedKey].sot)
          playerOdds[matchedKey].sot = sotBack;
      } else {
        playerOdds[sotName] = playerOdds[sotName] || { name: sotName, fgs: null, ags: null, bfexAgs: null, sot: sotBack };
        if (!playerOdds[sotName].sot || sotBack < playerOdds[sotName].sot)
          playerOdds[sotName].sot = sotBack;
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: true,
      eventId,
      event: match.event || match.name || match.eventName,
      players: Object.values(playerOdds)
    })};

  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
