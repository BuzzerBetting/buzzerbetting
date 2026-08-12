// netlify/functions/oddschecker.js
// Calls https://www.oddschecker.com/api/markets/v2/all-odds with whichever market IDs are
// actually provided — each market is its own named query param and genuinely optional, so
// a game missing (say) Headed SOT or OTB SOT markets can still be scanned for whichever
// ones it does have, rather than requiring all 4 every time.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer': 'https://www.oddschecker.com/',
};
// key here must match the query param name the frontend sends (?header=..., ?otb=..., etc)
const TARGET_MARKETS = [
  { key: 'header',     label: 'To Score a Header' },
  { key: 'otb',        label: 'To Score From Outside Penalty Box' },
  { key: 'headed_sot', label: 'Player Headed Shots On Target' },
  { key: 'sot_otb',    label: 'Player Shots On Target Outside Box' },
];
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const p = event.queryStringParameters || {};
  const debug = p.debug === '1';

  // Each market is now its own named param, all optional — only the ones actually
  // provided get fetched and returned. Preserves TARGET_MARKETS order regardless of which
  // ones are present.
  const provided = TARGET_MARKETS
    .map(t => ({ ...t, id: (p[t.key] || '').trim() }))
    .filter(t => t.id);

  if (!provided.length) {
    return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Provide at least one market ID: ?header=X, ?otb=X, ?headed_sot=X, ?sot_otb=X (any combination, all optional)' })
    };
  }

  try {
    const marketIds = provided.map(t => t.id);
    const oddsUrl = `https://www.oddschecker.com/api/markets/v2/all-odds?market-ids=${marketIds.join(',')}&repub=OC`;
    const res = await fetch(oddsUrl, { headers: HEADERS });
    if (!res.ok) {
      return {
        statusCode: 502, headers: CORS,
        body: JSON.stringify({ ok: false, error: `Odds API ${res.status}` })
      };
    }
    const raw = await res.json();
    const bets = Array.isArray(raw.bets) ? raw.bets : Array.isArray(raw) ? raw : [];
    // Group by marketId then by player name
    const byMarket = {};
    for (const bet of bets) {
      if (bet.status !== 'ACTIVE') continue;
      const mid = String(bet.marketId ?? '');
      if (!byMarket[mid]) byMarket[mid] = {};
      const name = bet.name ?? '';
      if (!name) continue;
      const code = bet.bookmakerCode ?? '';
      const dec = parseFloat(bet.oddsDecimal ?? 0);
      if (!code || dec <= 1) continue;
      if (!byMarket[mid][name]) byMarket[mid][name] = {};
      byMarket[mid][name][code] = dec;
    }
    const markets = {};
    provided.forEach(t => {
      const group = byMarket[t.id] ?? {};
      markets[t.key] = Object.entries(group).map(([name, odds]) => {
        const best = Math.max(...Object.values(odds));
        return { name, odds, best, bestBook: Object.entries(odds).find(([,v]) => v === best)?.[0] ?? '' };
      }).sort((a, b) => a.best - b.best);
    });
    const total = Object.values(markets).reduce((n, arr) => n + arr.length, 0);
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true,
        totalPlayers: total,
        marketsIncluded: provided.map(t => t.key),
        markets,
        ...(debug ? { _raw: raw } : {})
      })
    };
  } catch (err) {
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
