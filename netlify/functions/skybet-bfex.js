// Thin proxy to the DO box's /api/skybet-bfex (5-day fixtures + SkyBet back odds + Betfair
// lay odds/liquidity). Same pattern as betfair-proxy.js — the real work is DO-box only
// (Betfair cert + SkyBet geo-fence). The Freeze Builder page calls this.
const http = require('http');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const full = (event.queryStringParameters || {}).full;
  const host = process.env.LEDGER_DO_HOST || '178.128.40.248';
  const port = process.env.LEDGER_DO_PORT || '3000';

  return new Promise((resolve) => {
    const url = `http://${host}:${port}/api/skybet-bfex${full === '1' ? '?full=1' : ''}`;
    const req = http.get(url, { timeout: 55000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ statusCode: 200, headers: CORS, body: data }));
    });
    req.on('error', (err) => resolve({
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message }),
    }));
    req.on('timeout', () => { req.destroy(); resolve({
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'skybet-bfex upstream timed out' }),
    }); });
  });
};
