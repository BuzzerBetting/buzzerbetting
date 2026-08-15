// netlify/functions/oddschecker.js
// Calls www.oddschecker.com/api/markets/v2/all-odds with provided market IDs

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

  // Expect 4 market IDs in order: header, otb, headed_sot, sot_otb
  const marketIds = (p['market-ids'] || '').split(',').map(s => s.trim()).filter(Boolean);

  if (marketIds.length !== 4) {
    return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Provide ?market-ids=headerID,otbID,headedSOTID,sotOTBID' })
    };
  }

  try {
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
    TARGET_MARKETS.forEach((t, i) => {
      const mid = marketIds[i];
      const group = byMarket[mid] ?? {};
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
