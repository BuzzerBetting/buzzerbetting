// netlify/functions/betfair-dogs-proxy.js
// Thin Netlify-side proxy to the DO server's /api/betfair-dogs — mirrors betfair-proxy.js
// exactly. The actual netlify/functions/betfair-dogs.js (cert-based Betfair login) only ever
// runs on the DO server via server.js; it can't run here since the client cert lives only on
// that server's filesystem. This is the function the frontend actually calls.
const http = require('http');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { action, marketId } = event.queryStringParameters || {};
  if (!action) return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'action required' })
  };

  const qs = 'action=' + encodeURIComponent(action) + (marketId ? '&marketId=' + encodeURIComponent(marketId) : '');

  return new Promise((resolve) => {
    const url = `http://178.128.40.248:3000/api/betfair-dogs?${qs}`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        statusCode: 200, headers: CORS, body: data
      }));
    }).on('error', (err) => resolve({
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message })
    }));
  });
};
