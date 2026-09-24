const express = require('express');
const app = express();
const ledgerRouter = require('./ledger-routes');
app.use(express.json({ limit: '8mb' })); // headroom for the base64 screenshot in POST /api/ledger/parse-betslip

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve index.html
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// Mount each function as a route
const wrap = (handler) => async (req, res) => {
  const event = {
    httpMethod: req.method,
    queryStringParameters: req.query || {},
    body: JSON.stringify(req.body) || '',
    headers: req.headers
  };
  const result = await handler(event);
  res.status(result.statusCode || 200)
     .set(result.headers || {})
     .send(result.body);
};

app.all('/api/betfair', wrap(require('./netlify/functions/betfair').handler));
app.all('/api/betfair-dogs', wrap(require('./netlify/functions/betfair-dogs').handler));
app.all('/api/betfair-f1', wrap(require('./netlify/functions/betfair-f1').handler));
app.all('/api/betfair-horses', wrap(require('./netlify/functions/betfair-horses').handler));
app.all('/api/betfair-match-odds', wrap(require('./netlify/functions/betfair-match-odds').handler));
app.all('/api/ddhh', wrap(require('./netlify/functions/ddhh').handler));
app.all('/api/sheets', wrap(require('./netlify/functions/sheets').handler));
app.all('/api/bb-odds', wrap(require('./netlify/functions/bb-odds').handler));
app.all('/api/bb-lead', wrap(require('./netlify/functions/bb-lead').handler));
app.all('/api/fixtures', wrap(require('./netlify/functions/fixtures').handler));
app.all('/api/lineups', wrap(require('./netlify/functions/lineups').handler));
app.all('/api/oddschecker', wrap(require('./netlify/functions/oddschecker').handler));
app.all('/api/player-stats', wrap(require('./netlify/functions/player-stats').handler));
// skybet-accafreeze-lib.js (repo root, NOT netlify/functions) — must run from this UK-based box,
// not Netlify's US function IP; see that file's header comment for why.
app.all('/api/skybet-accafreeze', wrap(require('./skybet-accafreeze-lib').handler));
// skybet-bfex-lib.js — SkyBet 5-day fixtures + back odds joined to Betfair MATCH_ODDS lay
// prices/liquidity. Backend only (feeds the acca builder), DO-box only (SkyBet geo-fence +
// Betfair cert on /root). See that file's header.
app.all('/api/skybet-bfex', wrap(require('./skybet-bfex-lib').handler));
app.use('/api/ledger', ledgerRouter);

const PORT = process.env.PORT || 3000;
const https = require('https');
app.get('/api/oc-fgs-find', async (req, res) => {
  const { home, away } = req.query;
  if (!home || !away) return res.json({ ok: false, error: 'home and away required' });
  
  const slug = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const matchSlug = `${slug(home)}-v-${slug(away)}`;
  const comps = ['football/world-cup','football/english/premier-league','football/english/championship','football/english/league-1','football/english/league-2','football/champions-league','football/europa-league'];
  
  for (const comp of comps) {
    try {
      const html = await new Promise((resolve, reject) => {
        https.get(`https://www.oddschecker.com/${comp}/${matchSlug}/winner`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html' }
        }, r => {
          if (r.statusCode !== 200) return resolve(null);
          let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d));
        }).on('error', reject);
      });
      if (!html) continue;
      const m = html.match(/id="market_(\d+)"[^>]*>\s*<[^>]*>\s*<h2[^>]*>First Goalscorer/);
      if (m) return res.json({ ok: true, marketId: m[1], comp });
    } catch(e) { continue; }
  }
  res.json({ ok: false, error: 'FGS market not found' });
});

// GET /api/oc-cache — reads pre-scraped AGS/FGS data written by oc-scraper/ (a Python
// service, see oc-scraper/README.md, running independently under its own systemd timer every
// 10 minutes — this endpoint just reads whatever it last wrote, never scrapes live itself).
// Much more reliable than /api/oc-fgs-find above, which live-scrapes on every call with no
// Cloudflare cookie handling at all.
//   ?match_id=123        — exact match on the FotMob match id oc-scraper's CSV feed used
//   ?home=X&away=Y        — fallback fuzzy team-name match against the cached slug
//   (no params)            — lists every match currently cached, for browsing/debugging
const fs = require('fs');
const OC_CACHE_DIR = require('path').join(__dirname, 'oc-scraper', 'data', 'oc_cache');

function ocNorm(n) {
  return (n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function ocFuzzyMatch(a, b) {
  const na = ocNorm(a), nb = ocNorm(b);
  if (!na || !nb) return false;
  return na === nb || nb.includes(na) || na.includes(nb);
}
function readOcCacheFiles() {
  if (!fs.existsSync(OC_CACHE_DIR)) return [];
  return fs.readdirSync(OC_CACHE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(require('path').join(OC_CACHE_DIR, f), 'utf8')); }
      catch (e) { return null; }
    })
    .filter(Boolean);
}

app.get('/api/oc-cache', (req, res) => {
  const { match_id, home, away } = req.query;
  const entries = readOcCacheFiles();

  if (!match_id && !home && !away) {
    return res.json({
      ok: true,
      count: entries.length,
      matches: entries.map(e => ({ match_slug: e.match_slug, match_id: e.match_id || null, market_types: e.market_types, timestamp: e.timestamp }))
    });
  }

  let hit = null;
  if (match_id) {
    hit = entries.find(e => String(e.match_id) === String(match_id));
  }
  if (!hit && home && away) {
    // Slugs look like "arsenal-v-chelsea" — split on "-v-" and fuzzy-match each side.
    hit = entries.find(e => {
      const parts = (e.match_slug || '').split('-v-');
      if (parts.length !== 2) return false;
      const [a, b] = parts.map(p => p.replace(/-/g, ' '));
      return (ocFuzzyMatch(home, a) && ocFuzzyMatch(away, b)) || (ocFuzzyMatch(away, a) && ocFuzzyMatch(home, b));
    });
  }

  if (!hit) return res.json({ ok: false, error: 'No cached AGS/FGS data for that match yet — either not scraped, or oc-scraper found no AGS/FGS markets for it.' });
  res.json({ ok: true, ...hit });
});

// GET /api/oc-ev — reads the pre-computed Oddschecker-vs-BFEX +EV bet list written by
// oc-scraper's ev_engine.py (same scraper/timer as /api/oc-cache above — see its README).
// Only ever a read of the last completed run's output; the comparison itself (lineup-confirm
// gating, BFEX fair-odds derivation, EV% filtering) all happens in the Python service.
const OC_EV_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'oc_ev_bets.json');
app.get('/api/oc-ev', (req, res) => {
  if (!fs.existsSync(OC_EV_PATH)) return res.json({ ok: true, updated: null, bets: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(OC_EV_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading oc_ev_bets.json: ' + e.message });
  }
});

// GET /api/oc-calc-ev — the "calculated" counterpart to /api/oc-ev above: Header and
// Outside-the-Box goal bets, where Betfair has no direct market to compare Oddschecker's
// price against (see ev_engine.compute_header_otb_ev_bets — fair price is BFEX AGS x
// FotMob headed/OTB shot-share, not a straight BFEX price read). Deliberately a separate
// file/feed from oc_ev_bets.json rather than merged into it — Oddschecker +EV is reserved
// for markets with a direct 1:1 Betfair comparison (AGS/FGS/Cards/SOT); anything requiring
// the app's own GSM-style calculation belongs on the Calculated +EV page instead, same
// split as before this got automated, just without manual market-ID entry any more.
const OC_CALC_EV_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'oc_calc_ev_bets.json');
app.get('/api/oc-calc-ev', (req, res) => {
  if (!fs.existsSync(OC_CALC_EV_PATH)) return res.json({ ok: true, updated: null, bets: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(OC_CALC_EV_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading oc_calc_ev_bets.json: ' + e.message });
  }
});

// GET /api/pricedup-horse-ev — PricedUp Enhanced-Double horse racing +EV bets, written by
// oc-scraper's pricedup_horse_ev_scan.py (see that file's docstring): each leg's own BFEX
// WIN-market fair odds (bfex_fair.derive_bfex_fair, the exact same per-runner methodology
// oc-ev.js's other markets use) multiplied together for the double's fair odds, compared
// against PricedUp's own boosted price. Merged into the same "Normal +EV" (renamed from
// Oddschecker +EV, 2026-09-14) table client-side, same read-only contract as /api/oc-ev.
const PRICEDUP_HORSE_EV_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'pricedup_horse_ev_bets.json');
app.get('/api/pricedup-horse-ev', (req, res) => {
  if (!fs.existsSync(PRICEDUP_HORSE_EV_PATH)) return res.json({ ok: true, updated: null, bets: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(PRICEDUP_HORSE_EV_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading pricedup_horse_ev_bets.json: ' + e.message });
  }
});

// GET /api/pricedup-acca-ev — PricedUp simple win-acca ("Team A & Team B Both To Win" /
// "Team A, B & C All To Win") football +EV bets, written by oc-scraper's
// pricedup_acca_ev_scan.py: each team's own BFEX MATCH_ODDS fair odds
// (bfex_fair.derive_bfex_fair) multiplied together for the acca's fair odds, compared
// against PricedUp's boosted price. Same read-only contract as /api/oc-ev, merged into the
// same "Normal +EV" table client-side alongside the regular bets and the horse doubles.
const PRICEDUP_ACCA_EV_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'pricedup_acca_ev_bets.json');
app.get('/api/pricedup-acca-ev', (req, res) => {
  if (!fs.existsSync(PRICEDUP_ACCA_EV_PATH)) return res.json({ ok: true, updated: null, bets: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(PRICEDUP_ACCA_EV_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading pricedup_acca_ev_bets.json: ' + e.message });
  }
});

// GET /api/paddypower-horse-ev — Paddy Power "Racing Specials" (POWER_PRICES) horse double
// +EV bets, written by oc-scraper's paddypower_horse_ev_scan.py: same principle as
// /api/pricedup-horse-ev above, each leg's own BFEX WIN-market fair odds multiplied
// together, compared against Paddy Power's own decimal price. Merged into the same "Normal
// +EV" table client-side, alongside the regular bets, PricedUp horse doubles, and PricedUp
// win accas.
const PADDYPOWER_HORSE_EV_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'paddypower_horse_ev_bets.json');
app.get('/api/paddypower-horse-ev', (req, res) => {
  if (!fs.existsSync(PADDYPOWER_HORSE_EV_PATH)) return res.json({ ok: true, updated: null, bets: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(PADDYPOWER_HORSE_EV_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading paddypower_horse_ev_bets.json: ' + e.message });
  }
});

// GET /api/starsports-acca-ev — StarSports simple win-acca football +EV bets, written by
// oc-scraper's starsports_acca_ev_scan.py: same principle as /api/pricedup-acca-ev above,
// each team's own BFEX MATCH_ODDS fair odds multiplied together, compared against StarSports'
// own boosted price. Merged into the same "Normal +EV" table client-side.
const STARSPORTS_ACCA_EV_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'starsports_acca_ev_bets.json');
app.get('/api/starsports-acca-ev', (req, res) => {
  if (!fs.existsSync(STARSPORTS_ACCA_EV_PATH)) return res.json({ ok: true, updated: null, bets: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(STARSPORTS_ACCA_EV_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading starsports_acca_ev_bets.json: ' + e.message });
  }
});

// GET /api/dragonbet-acca-ev, /api/planetsportbet-acca-ev — same principle as
// /api/starsports-acca-ev above, for DragonBet's DragonBoosts and PlanetSportBet's Rocket
// Boosts win-accas respectively. Merged into the same "Normal +EV" table client-side.
const DRAGONBET_ACCA_EV_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'dragonbet_acca_ev_bets.json');
app.get('/api/dragonbet-acca-ev', (req, res) => {
  if (!fs.existsSync(DRAGONBET_ACCA_EV_PATH)) return res.json({ ok: true, updated: null, bets: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(DRAGONBET_ACCA_EV_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading dragonbet_acca_ev_bets.json: ' + e.message });
  }
});

const PLANETSPORTBET_ACCA_EV_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'planetsportbet_acca_ev_bets.json');
app.get('/api/planetsportbet-acca-ev', (req, res) => {
  if (!fs.existsSync(PLANETSPORTBET_ACCA_EV_PATH)) return res.json({ ok: true, updated: null, bets: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(PLANETSPORTBET_ACCA_EV_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading planetsportbet_acca_ev_bets.json: ' + e.message });
  }
});

// GET /api/williamhill-acca-ev — William Hill's own simple win-accas, written by oc-scraper's
// williamhill_acca_ev_scan.py: same principle as /api/starsports-acca-ev above, each team's own
// BFEX MATCH_ODDS fair odds multiplied together, compared against William Hill's own boosted
// price. Unlike the other acca feeds this one needs no Tampermonkey userscript — pulled
// straight from WH's own public search API. Merged into the same "Normal +EV" table client-side.
const WILLIAMHILL_ACCA_EV_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'williamhill_acca_ev_bets.json');
app.get('/api/williamhill-acca-ev', (req, res) => {
  if (!fs.existsSync(WILLIAMHILL_ACCA_EV_PATH)) return res.json({ ok: true, updated: null, bets: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(WILLIAMHILL_ACCA_EV_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading williamhill_acca_ev_bets.json: ' + e.message });
  }
});

// GET /api/planetsportbet-horse-ev — PlanetSportBet jockey "Enhanced Double" horse racing +EV
// bets, written by oc-scraper's planetsportbet_horse_ev_scan.py: each leg's own BFEX WIN-market
// fair odds multiplied together, compared against PlanetSportBet's own boosted price — resolved
// by (horse name, local time) across every today's race since these rows don't name a track.
// Merged into the same "Normal +EV" table client-side.
const PLANETSPORTBET_HORSE_EV_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'planetsportbet_horse_ev_bets.json');
app.get('/api/planetsportbet-horse-ev', (req, res) => {
  if (!fs.existsSync(PLANETSPORTBET_HORSE_EV_PATH)) return res.json({ ok: true, updated: null, bets: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(PLANETSPORTBET_HORSE_EV_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading planetsportbet_horse_ev_bets.json: ' + e.message });
  }
});

// GET /api/williamhill-horse-ev — William Hill "Both To Win" horse racing double +EV bets,
// written by oc-scraper's williamhill_horse_ev_scan.py: each leg's own BFEX WIN-market fair
// odds multiplied together, compared against William Hill's own boosted price (pulled
// directly from WH's public search API — no Tampermonkey scraper needed for this one). Merged
// into the same "Normal +EV" table client-side.
const WILLIAMHILL_HORSE_EV_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'williamhill_horse_ev_bets.json');
app.get('/api/williamhill-horse-ev', (req, res) => {
  if (!fs.existsSync(WILLIAMHILL_HORSE_EV_PATH)) return res.json({ ok: true, updated: null, bets: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(WILLIAMHILL_HORSE_EV_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading williamhill_horse_ev_bets.json: ' + e.message });
  }
});

// GET /api/pricedup-football-boost-ev, /api/starsports-football-boost-ev,
// /api/planetsportbet-football-boost-ev, /api/dragonbet-football-boost-ev — each bookmaker's
// individual-match football boosts that aren't a plain win-acca/horse-double (Win To Nil,
// Win & BTTS, Correct Score, HT/FT, Over 2.5, BTTS, AGS/FGS) — see
// oc-scraper/oc/football_boost_markets.py for the shared parsing/pricing engine every one of
// the four *_football_boost_scan.py scripts uses. Merged into the "Normal +EV" table client-side.
const FOOTBALL_BOOST_EV_ROUTES = {
  '/api/pricedup-football-boost-ev': 'pricedup_football_boost_ev_bets.json',
  '/api/starsports-football-boost-ev': 'starsports_football_boost_ev_bets.json',
  '/api/planetsportbet-football-boost-ev': 'planetsportbet_football_boost_ev_bets.json',
  '/api/dragonbet-football-boost-ev': 'dragonbet_football_boost_ev_bets.json',
};
for (const [route, filename] of Object.entries(FOOTBALL_BOOST_EV_ROUTES)) {
  const filePath = require('path').join(__dirname, 'oc-scraper', 'data', filename);
  app.get(route, (req, res) => {
    if (!fs.existsSync(filePath)) return res.json({ ok: true, updated: null, bets: [] });
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
    } catch (e) {
      res.json({ ok: false, error: `Failed reading ${filename}: ` + e.message });
    }
  });
}

// GET /api/bet-alert-errors — the Bet Alerts "Errors" tab: market-integrity flags (a
// bookmaker's market still open past when it should have suspended), not value bets. First
// fed by paddypower_horse_ev_scan.py (Paddy Power's "Racing Specials" doubles occasionally
// staying open after their first leg's race has already gone off) via
// oc_cache.store_bet_alert_errors, but the shape is bookmaker-agnostic for future sources.
const BET_ALERT_ERRORS_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'bet_alert_errors.json');
app.get('/api/bet-alert-errors', (req, res) => {
  if (!fs.existsSync(BET_ALERT_ERRORS_PATH)) return res.json({ ok: true, updated: null, rows: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(BET_ALERT_ERRORS_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, rows: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading bet_alert_errors.json: ' + e.message });
  }
});

// GET /api/oc-unmatched-matches — the Bet Alerts "OC Coverage" tab (2026-09-17,
// user-requested): today's fixtures oc_scraper_service._resolve_oc_url couldn't find an
// Oddschecker page for. Every one of these gets zero AGS/FGS/Cards/SOT/Header/OTB coverage
// for the whole night, and previously the only trace was a WARNING log line nobody watched —
// see oc_cache.store_oc_unmatched_matches's own docstring for the Man City v Norwich case
// that prompted this. Same read-shape as /api/bet-alert-errors above.
const OC_UNMATCHED_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'oc_unmatched_matches.json');
app.get('/api/oc-unmatched-matches', (req, res) => {
  if (!fs.existsSync(OC_UNMATCHED_PATH)) return res.json({ ok: true, updated: null, rows: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(OC_UNMATCHED_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, rows: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading oc_unmatched_matches.json: ' + e.message });
  }
});

// GET /api/oc-outliers — the Bet Alerts "Outliers" tab (2026-09-17, user-requested):
// scripts/oc_outliers_scan.py's model-free check — a single bookmaker's price that's >=50%
// above the next-best price in its own market's ladder, gated on at least 5 bookmakers
// quoting it. Same read-shape as /api/bet-alert-errors above.
const OC_OUTLIERS_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'oc_outliers.json');
app.get('/api/oc-outliers', (req, res) => {
  if (!fs.existsSync(OC_OUTLIERS_PATH)) return res.json({ ok: true, updated: null, rows: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(OC_OUTLIERS_PATH, 'utf8'));
    res.json({ ok: true, updated: payload.updated || null, rows: payload.bets || [] });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading oc_outliers.json: ' + e.message });
  }
});

// GET /api/oc-f1-ew, /api/oc-arbs, /api/oc-dnf — the new Bet Alerts edges (F1 Each-Way,
// Arbs, DNFs). Same "just read whatever the scraper last wrote" contract as /api/oc-ev and
// /api/oc-calc-ev above; the oc-scraper side that writes these JSON files doesn't exist yet,
// so until it does these simply return an empty feed and the Bet Alerts tab shows its
// empty state. Bets array shape: { t, match, mkt, sel, fair, bk, odds, ev } plus optional
// per-edge extras (F1 EW: place_terms; Arbs: legs[], profit_pct).
const BET_ALERT_FEED_PATHS = {
  '/api/oc-f1-ew': require('path').join(__dirname, 'oc-scraper', 'data', 'oc_f1_ew_bets.json'),
  '/api/oc-arbs':  require('path').join(__dirname, 'oc-scraper', 'data', 'oc_arb_bets.json'),
  '/api/oc-dnf':   require('path').join(__dirname, 'oc-scraper', 'data', 'oc_dnf_bets.json'),
  // Oddschecker Price Boosts +EV — same {t,match,mkt,sel,fair,bk,odds,ev} shape as the other
  // feeds above, each row additionally tagged boost:true (see oc_boosts_scraper.py). Covers
  // markets with a fair-odds source: AGS/FGS/CARDS/SOT (direct BFEX), HEADER/OTB (BFEX AGS x
  // FotMob shot-share), and GOALS_2PLUS/GOALS_3PLUS/SOT_2PLUS/SOT_3PLUS (Poisson from the
  // BFEX "1+" fair).
  '/api/oc-boost-ev': require('path').join(__dirname, 'oc-scraper', 'data', 'oc_boost_ev_bets.json'),
  // Oddschecker Price Boosts, calculated family — OTB-SoT / Headed-SoT / Assist boosts,
  // priced by the fair_resolver priority chain (BFEX green -> else OC-ladder-devig / BB
  // stage-1 combo) + the FotMob on-target split (see ev_engine.compute_boost_calc_ev_bets).
  // No direct Betfair market, so these surface on the Calculated +EV page, merged with
  // /api/oc-calc-ev rather than Oddschecker +EV. Rows tagged boost:true.
  '/api/oc-boost-calc-ev': require('path').join(__dirname, 'oc-scraper', 'data', 'oc_boost_calc_ev_bets.json'),
};
for (const [route, filePath] of Object.entries(BET_ALERT_FEED_PATHS)) {
  app.get(route, (req, res) => {
    if (!fs.existsSync(filePath)) return res.json({ ok: true, updated: null, bets: [] });
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      res.json({ ok: true, updated: payload.updated || null, bets: payload.bets || [] });
    } catch (e) {
      res.json({ ok: false, error: `Failed reading ${require('path').basename(filePath)}: ` + e.message });
    }
  });
}

// GET /api/oc-boosts — which matches currently have a qualifying Price Boost (any of
// logic_boosts.TARGET_MARKETS), written by oc_boosts_scraper.py every ~3 min alongside the
// main scan. Existence only (match_id + counts per market) — no prices here by design; the
// user only ever wants to SEE an actual boosted price once it's confirmed +EV, on the
// Oddschecker +EV page via /api/oc-boost-ev above. Powers the Today's Matches "B" icon.
const OC_BOOSTS_PATH = require('path').join(__dirname, 'oc-scraper', 'data', 'oc_boosts.json');
app.get('/api/oc-boosts', (req, res) => {
  if (!fs.existsSync(OC_BOOSTS_PATH)) return res.json({ ok: true, updated: null, matches: [] });
  try {
    const payload = JSON.parse(fs.readFileSync(OC_BOOSTS_PATH, 'utf8'));
    res.json({
      ok: true,
      updated: payload.updated || null,
      targetMarkets: payload.targetMarkets || [],
      marketsWithFairSource: payload.marketsWithFairSource || [],
      matches: payload.matches || [],
    });
  } catch (e) {
    res.json({ ok: false, error: 'Failed reading oc_boosts.json: ' + e.message });
  }
});

// POST /api/oc-ev/refresh — kicks off the same run_pipeline.sh the systemd timer fires every
// 10 minutes, on demand. Deliberately fire-and-forget (returns immediately, doesn't wait for
// the scrape to finish) rather than blocking the request: a full run takes 15-60s depending
// on how many matches are live, well past Netlify functions' ~10-26s timeout, so the proxy
// (oc-ev.js) awaiting this synchronously would time out mid-scrape. The frontend instead
// polls GET /api/oc-ev afterward and re-renders once `updated` moves past the timestamp it
// had before triggering — see initOddscheckerEV/refreshOddscheckerEV in index.html.
const { spawn } = require('child_process');
const OC_SCRAPER_DIR = require('path').join(__dirname, 'oc-scraper');
let ocEvRefreshInFlight = false;
app.post('/api/oc-ev/refresh', (req, res) => {
  if (ocEvRefreshInFlight) {
    return res.json({ ok: true, started: false, alreadyRunning: true });
  }
  ocEvRefreshInFlight = true;
  const child = spawn('bash', ['run_pipeline.sh'], { cwd: OC_SCRAPER_DIR, stdio: 'ignore', detached: true });
  child.on('error', (e) => { ocEvRefreshInFlight = false; console.error('[oc-ev refresh] failed to start:', e.message); });
  child.on('exit', () => { ocEvRefreshInFlight = false; });
  child.unref();
  res.json({ ok: true, started: true });
});

app.listen(PORT, () => console.log(`BuzzerBetting server running on port ${PORT}`));

// Background: watch FotMob for lineups flipping to confirmed and feed the header bell.
require('./notifications-poller').startLineupNotifier();

// Background: keep the SkyBet-odds cache for /api/skybet-bfex warm (incremental, every 15 min).
require('./skybet-bfex-lib').startWarmer();

// Background: resolve freeze-acca fodder results + auto-settle lost accas (every 15 min).
require('./freeze-acca-poller').start();
