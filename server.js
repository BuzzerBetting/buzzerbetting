const express = require('express');
const app = express();
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
app.all('/api/sheets', wrap(require('./netlify/functions/sheets').handler));
app.all('/api/bb-odds', wrap(require('./netlify/functions/bb-odds').handler));
app.all('/api/fixtures', wrap(require('./netlify/functions/fixtures').handler));
app.all('/api/lineups', wrap(require('./netlify/functions/lineups').handler));
app.all('/api/oddschecker', wrap(require('./netlify/functions/oddschecker').handler));
app.all('/api/player-stats', wrap(require('./netlify/functions/player-stats').handler));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BuzzerBetting server running on port ${PORT}`));
