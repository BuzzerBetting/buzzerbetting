export const handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { eventId } = event.queryStringParameters || {};
  if (!eventId) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'eventId required' }) };

  const hash    = process.env.BB_HASH;
  const cookies = process.env.BB_COOKIES;
  if (!hash || !cookies) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'BB_HASH or BB_COOKIES not set' }) };

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // ── Name normalisation for fuzzy matching ──────────────────────────────────
  // Strips accents, lowercases, removes punctuation so "Hincapié" matches "Hincapie"
  function normName(n) {
    return (n || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '') // remove punctuation
      .trim();
  }

  // Returns true if every word in nameA appears in nameB or vice versa
  function fuzzyMatch(a, b) {
    const na = normName(a);
    const nb = normName(b);
    if (na === nb) return true;
    const wa = na.split(' ');
    const wb = nb.split(' ');
    // All words of shorter name must appear in longer name
    const [shorter, longer] = wa.length <= wb.length ? [wa, nb] : [wb, na];
    return shorter.every(w => w.length > 1 && longer.includes(w));
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
    const match = list.find(m =>
      String(m.eventId) === String(eventId) ||
      String(m.id)      === String(eventId) ||
      String(m._id)     === String(eventId)
    );

    if (!match) return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: false,
      error: `Match ${eventId} not found in BB list`,
      available: list.slice(0, 10).map(m => ({ eventId: m.eventId, event: m.event }))
    })};

    // ── Build player odds map ──────────────────────────────────────────────
    const playerOdds = {};

    // AGS + FGS from playerXg
    const playerXg = match.playerXg || {};
    for (const [name, data] of Object.entries(playerXg)) {
      if (name === 'No Goalscorer') continue;
      playerOdds[name] = {
        name,
        fgs: data.firstBbp    || null,
        ags: data.anytimeBbp  || null,
        bfexAgs: data.anytimeExchange?.back || null,
        sot: null  // filled below
      };
    }

    // SOT from sots array — pick the best (lowest) back price per player
    const sots = match.sots || [];
    for (const entry of sots) {
      const sotName = entry.selection?.name;
      const sotBack = entry.back;
      if (!sotName || !sotBack) continue;

      // Find matching player in our map using fuzzy match
      const matchedKey = Object.keys(playerOdds).find(k => fuzzyMatch(k, sotName));
      if (matchedKey) {
        // Keep lowest (best) SOT price if player appears multiple times
        if (!playerOdds[matchedKey].sot || sotBack < playerOdds[matchedKey].sot) {
          playerOdds[matchedKey].sot = sotBack;
        }
      } else {
        // Player exists in SOT but not in playerXg — add them
        playerOdds[sotName] = playerOdds[sotName] || { name: sotName, fgs: null, ags: null, bfexAgs: null, sot: sotBack };
        if (!playerOdds[sotName].sot || sotBack < playerOdds[sotName].sot) {
          playerOdds[sotName].sot = sotBack;
        }
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: true,
      eventId,
      event: match.event,
      players: Object.values(playerOdds)
    })};

  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
