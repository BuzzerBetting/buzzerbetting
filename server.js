const express = require('express');
const app = express();
const ledgerRouter = require('./ledger-routes');
app.use(express.json());

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

app.listen(PORT, () => console.log(`BuzzerBetting server running on port ${PORT}`));
