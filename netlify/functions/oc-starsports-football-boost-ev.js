// netlify/functions/oc-starsports-football-boost-ev.js
//
// Thin proxy to the DO server's /api/starsports-football-boost-ev (server.js) — StarSports'
// individual-match football boosts other than a plain win-acca/horse-double, written by
// oc-scraper's starsports_football_boost_scan.py via the shared oc/football_boost_markets.py
// engine. Same read-only contract as oc-ev.js. Powers the "Normal +EV" page.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/starsports-football-boost-ev`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
