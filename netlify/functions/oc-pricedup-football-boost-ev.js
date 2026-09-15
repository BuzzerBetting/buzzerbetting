// netlify/functions/oc-pricedup-football-boost-ev.js
//
// Thin proxy to the DO server's /api/pricedup-football-boost-ev (server.js) — PricedUp's
// individual-match football boosts other than a plain win-acca/horse-double (Win To Nil,
// Win & BTTS, Correct Score, HT/FT, Over 2.5, BTTS, AGS/FGS), written by oc-scraper's
// pricedup_football_boost_scan.py via the shared oc/football_boost_markets.py engine. Same
// read-only contract as oc-ev.js/oc-pricedup-acca-ev.js. Powers the "Normal +EV" page.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/pricedup-football-boost-ev`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
