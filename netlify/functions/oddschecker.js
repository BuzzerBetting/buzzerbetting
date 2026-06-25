// netlify/functions/oddschecker.js
// Uses OC's internal bet-builder API (not HTML scraping).
// Flow: fetch match page → extract subeventId → hit markets API.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

const OC_API_KEY = 'd6f0f240-dbe4-40eb-a133-63a6d81191e6';
const OC_BOOKIE_CODES = 'SK,PP,SX,B3,KN,UN,WH,LD,CE,WA';

const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Cache-Control': 'no-cache'
};

const API_HEADERS = {
  'x-api-key': OC_API_KEY,
  'Accept': 'application/json',
  'Origin': 'https://www.oddschecker.com',
  'Referer': 'https://www.oddschecker.com/'
};

// FotMob competition name → OC URL path segment
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

// The four markets we care about
const TARGET_MARKETS = [
  { key: 'header',     label: 'To Score a Header',                   match: /to score a header/i },
  { key: 'otb',        label: 'To Score From Outside Penalty Box',   match: /outside penalty box/i },
  { key: 'headed_sot', label: 'Player Headed Shots On Target',       match: /headed shots on target/i },
  { key: 'sot_otb',   label: 'Player Shots On Target Outside Box',  match: /shots on target outside/i },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Extract subeventId from OC page HTML.
// OC embeds server-rendered JSON near the bottom, e.g.:
//   "subeventConfig":{"subeventId":"101540856",...}
function extractEventId(html) {
  const patterns = [
    /"subeventId"\s*:\s*"?(\d{7,12})"?/,
    /"subevent[Ii]d"\s*:\s*"?(\d{7,12})"?/,
    /subevents\/(\d{7,12})/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
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

// Parse the markets API response into our shape
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

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const p = event.queryStringParameters || {};
  const debug = p.debug === '1';

  // Accept either:
  //   ?home=Ecuador&away=Germany&competition=World Cup
  //   ?slug=football/world-cup/ecuador-v-germany
  //   ?eventId=101540856
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
    // ── Step 1: resolve eventId if not supplied ──
    if (!eventId) {
      const pageUrl = `https://www.oddschecker.com/${ocSlug}/winner`;
      const pageRes = await fetch(pageUrl, { headers: PAGE_HEADERS, redirect: 'follow' });

      if (!pageRes.ok) {
        return {
          statusCode: 502, headers: CORS,
          body: JSON.stringify({ ok: false, error: `OC page ${pageRes.status}`, url: pageUrl })
        };
      }

      const html = await pageRes.text();
      eventId = extractEventId(html);

      if (!eventId) {
        return {
          statusCode: 404, headers: CORS,
          body: JSON.stringify({
            ok: false,
            error: 'Could not find subeventId in OC page — try ?eventId=XXXXXXXX directly',
            hint: debug ? html.slice(html.indexOf('subeventId'), html.indexOf('subeventId') + 300) : undefined
          })
        };
      }
    }

    // ── Step 2: hit the markets API ──
    const apiUrl = `https://api.oddschecker.com/bet-builder/v1/subevents/${eventId}/markets?bookieCodes=${OC_BOOKIE_CODES}`;
    const apiRes = await fetch(apiUrl, { headers: API_HEADERS });

    if (!apiRes.ok) {
      const body = await apiRes.text();
      return {
        statusCode: 502, headers: CORS,
        body: JSON.stringify({ ok: false, error: `Markets API ${apiRes.status}`, detail: body })
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
