// netlify/functions/ledger.js
//
// Proxies all /api/ledger/* calls to the DO server, injecting the
// LEDGER_API_KEY secret server-side so it never reaches the browser.
//
// Set LEDGER_API_KEY as an environment variable in Netlify's site settings
// (Site configuration → Environment variables) — it must match the value
// set on the DO server.
//
// Frontend usage:
//   fetch('/.netlify/functions/ledger?path=accounts')
//   fetch('/.netlify/functions/ledger?path=accounts/12/deposit', {
//     method: 'POST', body: JSON.stringify({ amount: 50 })
//   })
//   fetch('/.netlify/functions/ledger?path=bets/5/settle', {
//     method: 'PATCH', body: JSON.stringify({ result: 'won', pl: 45 })
//   })

const http = require('http');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const DO_HOST = '178.128.40.248';
const DO_PORT = 3000;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const subPath = (event.queryStringParameters && event.queryStringParameters.path) || '';
  if (!subPath) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'path query param required' }) };
  }
  if (!process.env.LEDGER_API_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: 'LEDGER_API_KEY not configured in Netlify env vars' }) };
  }

  return new Promise((resolve) => {
    const bodyStr = event.body ? event.body : undefined;
    const options = {
      hostname: DO_HOST,
      port: DO_PORT,
      path: '/api/ledger/' + subPath,
      method: event.httpMethod,
      headers: {
        'Content-Type': 'application/json',
        'x-ledger-key': process.env.LEDGER_API_KEY,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        statusCode: res.statusCode || 200,
        headers: CORS,
        body: data
      }));
    });

    req.on('error', (err) => resolve({
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message })
    }));

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
};
