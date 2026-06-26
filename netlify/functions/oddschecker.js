// netlify/functions/oddschecker.js
// Uses OC's internal bet-builder API.
// Event ID lookup: tries OC events API first (no 403), falls back to slug-based guess.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const OC_API_KEY = 'd6f0f240-dbe4-40eb-a133-63a6d81191e6';
const OC_BOOKIE_CODES = 'SK,PP,SX,B3,KN,UN,WH,LD,CE,WA';

const API_HEADERS = {
  'api-key': OC_API_KEY,
  'accept': 'application/json',
  'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
  'country-code': 'GB',
  'subdivision-code': 'NIR',
  'repub': 'OC',
  'origin': 'https://www.oddschecker.com',
  'referer': 'https://www.oddschecker.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
};

const COMP_MAP = {
  'premier league':       'english/premier-league',
  'championship':         'english/championship',
  'fa cup':               'english/fa-cup',
  'efl cup':              'english/league-cup',
  'champions league':     'champions-league',
  'europa league':        'europa-league',
  'conference league':    'europa-conference-league',
  'world cup':            'world-cup',
  'nations league':       'nations-league',
  'euros':                'european-championship',
  'euro':                 'european-championship',
  'la liga':              'spanish/la-liga',
  'bundesliga':           'german/bundesliga',
  '2. bundesliga':        'german/2-bundesliga',
  'serie a':              'italian/serie-a',
  'ligue 1':              'french/ligue-1',
  'eredivisie':           'dutch/eredivisie',
  'primeira liga':        'portuguese/primeira-liga',
  'scottish premiership': 'scottish/premiership',
  'mls':                  'usa/major-league-soccer',
};

const TARGET_MARKETS = [
  { key: 'header',     label: 'To Score a Header',                 match: /to score a header/i },
  { key: 'otb',        label: 'To Score From Outside Penalty Box', match: /outside penalty box/i },
  { key: 'headed_sot', label: 'Player Headed Shots On Target',     match: /headed shots on target/i },
  { key: 'sot_otb',    label: 'Player Shots On Target Outside Box',match: /shots on target outside/i },
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

function fractionalToDecimal(str) {
  if (!str) return null;
  if (typeof str === 'number') return str > 1 ? str : null;
  const s = String(str).trim();
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number);
    return d ? parseFloat((n / d + 1).toFixed(3)) : null;
  }
  const n = parseFloat(s);
  return isNaN(n) || n <= 1 ? null : n;
}

function parseMarkets(data) {
  const result = Object.fromEntries(TARGET_MARKETS.map(m => [m.key, []]));

  const markets =
    data.markets ??
    data.data?.markets ??
    (Array.isArray(data) ? data : []);

  for (const market of markets) {
    const marketName =
      market.marketTypeName ??
      market.marketName ??
      market.name ?? '';

    const target = TARGET_MARKETS.find(t => t.match.test(marketName));
    if (!target) continue;

    const selections = market.selections ?? market.runners ?? market.bets ?? [];

    for (const sel of selections) {
      const playerName = sel.name ?? sel.selectionName ?? sel.betName ?? '';
      if (!playerName || playerName.toLowerCase() === 'other') continue;

      const odds = {};

      if (Array.isArray(sel.prices)) {
        for (const p of sel.prices) {
          const code = p.bookieCode ?? p.bookie;
          const dec  = p.decimal ?? p.decimalOdds ?? p.price;
          if (code && dec && dec > 1) odds[code] = parseFloat(dec);
        }
      }

      if (sel.odds && typeof sel.odds === 'object') {
        for (const [code, raw] of Object.entries(sel.odds)) {
          if (odds[code]) continue;
          const dec = fractionalToDecimal(raw);
          if (dec) odds[code] = dec;
        }
      }

      if (sel.bookmakerCode && sel.oddsDecimal > 1) {
        odds[sel.bookmakerCode] = sel.oddsDecimal;
      }

      if (!Object.keys(odds).length) continue;

      const best = Math.max(...Object.values(odds));
      result[target.key].push({
        name: playerName,
        odds,
        best,
        bestBook: Object.entries(odds).find(([, v]) => v === best)?.[0] ?? ''
      });
    }

    result[target.key].sort((a, b) => b.best - a.best);
  }

  return result;
}

// Try OC's events API to find the subeventId from a URL slug
async function lookupEventId(ocSlug) {
  // Try the OC events API with the url param
  const attempts = [
    `https://api.oddschecker.com/api/v2/events?url=/${ocSlug}`,
    `https://api.oddschecker.com/api/v1/events?url=/${ocSlug}`,
    `https://api.oddschecker.com/v1/events?sportUrl=/football&url=/${ocSlug}`,
  ];

  for (const url of attempts) {
    try {
      const res = await fetch(url, { headers: API_HEADERS });
      if (!res.ok) continue;
      const json = await res.json();
      // Look for subeventId anywhere in the response
      const str = JSON.stringify(json);
      const m = str.match(/"subeventId"\s*:\s*"?(\d{7,12})"?/) ||
                str.match(/"id"\s*:\s*"?(\d{7,12})"?/) ||
                str.match(/"eventId"\s*:\s*"?(\d{7,12})"?/);
      if (m) return m[1];
    } catch (e) {}
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const p = event.queryStringParameters || {};
  const debug = p.debug === '1';

  let ocSlug    = p.slug ?? null;
  let eventId   = p.eventId ?? null;
  const home        = p.home;
  const away        = p.away;
  const competition = p.competition;

  if (!eventId && !ocSlug && home && away) {
    const compSlug  = getCompSlug(competition);
    const matchSlug = `${slugify(home)}-v-${slugify(away)}`;
    ocSlug = `football/${compSlug}/${matchSlug}`;
  }

  if (!eventId && !ocSlug) {
    return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Provide home+away, slug, or eventId' })
    };
  }

  try {
    // ── Step 1: resolve eventId via OC API ──
    if (!eventId) {
      eventId = await lookupEventId(ocSlug);

      if (!eventId) {
        return {
          statusCode: 404, headers: CORS,
          body: JSON.stringify({
            ok: false,
            error: 'Could not find event ID via OC API — pass ?eventId=XXXXXXXX directly',
            slug: ocSlug,
            hint: 'Open OC in browser, find the match, check Network tab for subeventId'
          })
        };
      }
    }

    // ── Step 2: hit the markets API (try both endpoints) ──
    const endpoints = [
      `https://api.oddschecker.com/bet-builder/v1/subevents/${eventId}/prepopulated-bets?bookieCodes=${OC_BOOKIE_CODES}`,
      `https://api.oddschecker.com/bet-builder/v1/subevents/${eventId}/markets?bookieCodes=${OC_BOOKIE_CODES}`,
    ];

    let apiRes = null;
    let endpointUsed = '';
    for (const url of endpoints) {
      const r = await fetch(url, { headers: API_HEADERS });
      if (r.ok) { apiRes = r; endpointUsed = url; break; }
    }

    if (!apiRes) {
      return {
        statusCode: 502, headers: CORS,
        body: JSON.stringify({ ok: false, error: 'Markets API 404 on all endpoints', eventId })
      };
    }

    const raw     = await apiRes.json();
    const markets = parseMarkets(raw);
    const total   = Object.values(markets).reduce((n, arr) => n + arr.length, 0);

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true,
        eventId,
        slug: ocSlug,
        totalPlayers: total,
        markets,
        ...(debug ? { _raw: raw } : {})
      })
    };

  } catch (err) {
    console.error('oddschecker.js error:', err);
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
