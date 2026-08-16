// netlify/functions/ledger.js
//
// Proxies all /api/ledger/* calls to the DO server, injecting the
// LEDGER_API_KEY secret server-side so it never reaches the browser.
// Also forwards the per-user x-session-token header (if present) through
// to the DO backend, so it can resolve who's making the request and
// enforce Admin/Staff role restrictions.
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
  'Access-Control-Allow-Headers': 'Content-Type, x-session-token',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};
// Read from env vars first so each independent deployment (each with its own DO server)
// can point at its own backend without editing this file — falls back to the original
// hardcoded values only if unset, so the existing deployment needs zero changes.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;
exports.handler = async (event) => {
  const method = event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET';
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const subPath = (event.queryStringParameters && event.queryStringParameters.path) || '';
  if (!subPath) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'path query param required' }) };
  }
  if (!process.env.LEDGER_API_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: 'LEDGER_API_KEY not configured in Netlify env vars' }) };
  }
  // Incoming header names can arrive in any case — normalize to find x-session-token
  // regardless of how the browser/fetch sent it.
  const incomingHeaders = event.headers || {};
  const sessionToken = incomingHeaders['x-session-token'] || incomingHeaders['X-Session-Token'] || incomingHeaders['X-SESSION-TOKEN'];
  return new Promise((resolve) => {
    const bodyStr = event.body ? event.body : undefined;
    const options = {
      hostname: DO_HOST,
      port: DO_PORT,
      path: '/api/ledger/' + subPath,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'x-ledger-key': process.env.LEDGER_API_KEY,
        ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
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
