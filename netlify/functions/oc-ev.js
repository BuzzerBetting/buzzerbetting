// netlify/functions/oc-ev.js
//
// Thin proxy to the DO server's GET /api/oc-ev (server.js), which just reads whatever
// oc-scraper's ev_engine.py last wrote to data/oc_ev_bets.json — the actual comparison
// (lineup-confirm gating, BFEX fair-odds derivation, Oddschecker scraping, EV% filtering)
// all happens server-side on the DO droplet, same as /api/oc-cache. No API key needed —
// this route isn't behind LEDGER_API_KEY on the DO server, same as oc-cache.
//
// Same DO_HOST/DO_PORT env-var pattern as ledger.js/fixtures.js, so each independent
// deployment can point at its own backend without editing this file.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/oc-ev`);
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
