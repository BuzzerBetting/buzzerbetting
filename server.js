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
app.all('/api/ddhh', wrap(require('./netlify/functions/ddhh').handler));
app.all('/api/sheets', wrap(require('./netlify/functions/sheets').handler));
app.all('/api/bb-odds', wrap(require('./netlify/functions/bb-odds').handler));
app.all('/api/fixtures', wrap(require('./netlify/functions/fixtures').handler));
app.all('/api/lineups', wrap(require('./netlify/functions/lineups').handler));
app.all('/api/oddschecker', wrap(require('./netlify/functions/oddschecker').handler));
app.all('/api/player-stats', wrap(require('./netlify/functions/player-stats').handler));
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
