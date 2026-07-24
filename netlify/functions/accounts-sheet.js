// netlify/functions/accounts-sheet.js
//
// Proxies Bulk Account Entry requests to the dedicated Accounts Google Sheet
// Apps Script, injecting the ACCOUNTS_API_KEY secret server-side so it never
// reaches the browser.
//
// Set ACCOUNTS_API_KEY as an environment variable in Netlify's site settings
// (Site configuration → Environment variables) — it must match the Script
// Property of the same name set on the Accounts Apps Script.
//
// Frontend usage:
//   fetch('/.netlify/functions/accounts-sheet', {
//     method: 'POST',
//     headers: {'Content-Type':'application/json'},
//     body: JSON.stringify({ bookie: 'PaddyPower', names: ['James Parker', 'Alex Wood'] })
//   })

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const ACCOUNTS_SHEET_URL = 'https://script.google.com/macros/s/AKfycbzQN4KVRPjYn1om8tprGzNMB-RTTSKk0SuhChBBlK1fTvCxGyxnsgeO8PnicCXxP48BNw/exec';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok:false, error:'POST only' }) };

  if (!process.env.ACCOUNTS_API_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: 'ACCOUNTS_API_KEY not configured in Netlify env vars' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok:false, error:'Invalid JSON body' }) };
  }
  payload.secret = process.env.ACCOUNTS_API_KEY; // injected server-side, never sent by the browser

  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(payload);

    function doRequest(url, remainingRedirects) {
      const req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
      }, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && remainingRedirects > 0) {
          res.resume(); // discard this response body, follow the redirect instead
          return doRequest(res.headers.location, remainingRedirects - 1);
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode || 200, headers: CORS, body: data }));
      });
      req.on('error', (err) => resolve({ statusCode: 200, headers: CORS, body: JSON.stringify({ ok:false, error: err.message }) }));
      req.write(bodyStr);
      req.end();
    }

    doRequest(ACCOUNTS_SHEET_URL, 3);
  });
};
