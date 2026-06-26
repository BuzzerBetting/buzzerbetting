// netlify/functions/oddschecker.js
// Fetches OC match page, extracts market IDs from embedded JSON,
// then calls www.oddschecker.com/api/markets/v2/all-odds

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-GB,en;q=0.9',
};

const COMP_MAP = {
  'world cup':            'world-cup',
  'premier league':       'english/premier-league',
  'championship':         'english/championship',
  'fa cup':               'english/fa-cup',
  'efl cup':              'english/league-cup',
  'champions league':     'champions-league',
  'europa league':        'europa-league',
  'conference league':    'europa-conference-league',
  'nations league':       'nations-league',
  'euros':                'european-championship',
  'euro':                 'european-championship',
  'la liga':              'spanish/la-liga',
  'bundesliga':           'german/bundesliga',
  'serie a':              'italian/serie-a',
  'ligue 1':              'french/ligue-1',
  'eredivisie':           'dutch/eredivisie',
  'primeira liga':        'portuguese/primeira-liga',
  'scottish premiership': 'scottish/premiership',
  'mls':                  'usa/major-league-soccer',
};

const TARGET_MARKETS = [
  { key: 'header',     match: /to score a header/i },
  { key: 'otb',        match: /to score from outside penalty box/i },
  { key: 'headed_sot', match: /player headed shots on target/i },
  { key: 'sot_otb',    match: /player shots on target outside box/i },
];

function slugify(str) {
  return (str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function getCompSlug(competition) {
  const c = (competition || '').toLowerCase().trim();
  for (const [key, val] of Object.entries(COMP_MAP)) {
    if (c.includes(key)) return val;
  }
  return slugify(competition);
}

// Extract market IDs from OC page HTML by matching marketTypeName
function extractMarketIds(html) {
  const result = {};

  // Find all market objects in the embedded JSON
  // Pattern: "12345":{"ocMarketId":12345,...,"marketTypeName":"To Score a Header",...}
  const re = /"(\d{8,12})"\s*:\s*\{[^}]*"marketTypeName"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    const name = m[2];
    for (const t of TARGET_MARKETS) {
      if (t.match.test(name) && !result[t.key]) {
        result[t.key] = id;
      }
    }
  }
  return result;
}

// Parse all-odds response into our shape
function parseAllOdds(data, marketKey) {
  const players = [];
  const bets = data.bets ?? data.odds ?? [];

  // Group by selection name
  const byName = {};
  for (const bet of bets) {
    if (bet.status !== 'ACTIVE') continue;
    const name = bet.name ?? bet.selectionName ?? '';
    if (!name || name.toLowerCase() === 'other') continue;
    const code = bet.bookmakerCode ?? bet.bookieCode ?? '';
    const dec = parseFloat(bet.oddsDecimal ?? bet.decimal ?? 0);
    if (!code || dec <= 1) continue;
    if (!byName[name]) byName[name] = {};
    byName[name][code] = dec;
  }

  for (const [name, odds] of Object.entries(byName)) {
    const best = Math.max(...Object.values(odds));
    players.push({
      name,
      odds,
      best,
      bestBook: Object.entries(odds).find(([, v]) => v === best)?.[0] ?? ''
    });
  }

  return players.sort((a, b) => a.best - b.best);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const p = event.queryStringParameters || {};
  const debug = p.debug === '1';
  const home = p.home;
  const away = p.away;
  const competition = p.competition;

  if (!home || !away) {
    return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'home and away required' })
    };
  }

  const compSlug  = getCompSlug(competition);
  const matchSlug = `${slugify(home)}-v-${slugify(away)}`;
  const pageUrl   = `https://www.oddschecker.com/football/${compSlug}/${matchSlug}/winner`;

  try {
    // Step 1: fetch OC match page and extract market IDs
    const pageRes = await fetch(pageUrl, { headers: PAGE_HEADERS });
    if (!pageRes.ok) {
      return {
        statusCode: 502, headers: CORS,
        body: JSON.stringify({ ok: false, error: `OC page ${pageRes.status}`, url: pageUrl })
      };
    }

    const html = await pageRes.text();
    const marketIds = extractMarketIds(html);

    if (!Object.keys(marketIds).length) {
      return {
        statusCode: 404, headers: CORS,
        body: JSON.stringify({
          ok: false,
          error: 'Could not find market IDs in OC page',
          url: pageUrl,
          hint: debug ? html.slice(0, 500) : undefined
        })
      };
    }

    // Step 2: fetch all-odds for found market IDs
    const ids = Object.values(marketIds).join(',');
    const oddsUrl = `https://www.oddschecker.com/api/markets/v2/all-odds?market-ids=${ids}&repub=OC`;
    const oddsRes = await fetch(oddsUrl, { headers: PAGE_HEADERS });

    if (!oddsRes.ok) {
      return {
        statusCode: 502, headers: CORS,
        body: JSON.stringify({ ok: false, error: `Odds API ${oddsRes.status}`, url: oddsUrl })
      };
    }

    const raw = await oddsRes.json();
    const debug_raw = debug ? raw : undefined;

    // Step 3: split odds by market
    // all-odds returns a flat array — each bet has a marketId field
    const bets = raw.bets ?? raw.odds ?? raw ?? [];
    const markets = Object.fromEntries(TARGET_MARKETS.map(t => [t.key, []]));

    // Group bets by marketId, then parse each group
    const byMarket = {};
    for (const bet of (Array.isArray(bets) ? bets : [])) {
      const mid = String(bet.marketId ?? bet.market?.id ?? '');
      if (!byMarket[mid]) byMarket[mid] = [];
      byMarket[mid].push(bet);
    }

    for (const [key, id] of Object.entries(marketIds)) {
      const marketBets = byMarket[id] ?? [];
      const byName = {};
      for (const bet of marketBets) {
        if (bet.status !== 'ACTIVE') continue;
        const name = bet.name ?? bet.selectionName ?? '';
        if (!name) continue;
        const code = bet.bookmakerCode ?? bet.bookieCode ?? '';
        const dec = parseFloat(bet.oddsDecimal ?? 0);
        if (!code || dec <= 1) continue;
        if (!byName[name]) byName[name] = {};
        byName[name][code] = dec;
      }
      markets[key] = Object.entries(byName).map(([name, odds]) => {
        const best = Math.max(...Object.values(odds));
        return { name, odds, best, bestBook: Object.entries(odds).find(([,v]) => v === best)?.[0] ?? '' };
      }).sort((a, b) => a.best - b.best);
    }

    const total = Object.values(markets).reduce((n, arr) => n + arr.length, 0);

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true,
        match: `${home} v ${away}`,
        marketIds,
        totalPlayers: total,
        markets,
        ...(debug ? { _raw: raw } : {})
      })
    };

  } catch (err) {
    console.error('oddschecker error:', err);
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
