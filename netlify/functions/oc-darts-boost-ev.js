// netlify/functions/oc-darts-boost-ev.js
//
// Thin proxy to the DO server's /api/darts-boost-ev (server.js) — darts boosted doubles/trebles
// from PricedUp/StarSports/DragonBet/PlanetSportBet, written by oc-scraper's
// darts_boost_ev_scan.py. Same read-only contract as oc-williamhill-tennis-acca-ev.js.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/darts-boost-ev`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
