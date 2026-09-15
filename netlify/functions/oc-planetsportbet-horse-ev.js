// netlify/functions/oc-planetsportbet-horse-ev.js
//
// Thin proxy to the DO server's /api/planetsportbet-horse-ev (server.js) — PlanetSportBet
// jockey "Enhanced Double" horse racing +EV bets, written by oc-scraper's
// planetsportbet_horse_ev_scan.py (each leg resolved by horse name + local time across every
// today's BFEX race, since these rows don't name a track — see that file's docstring). Same
// read-only contract as oc-ev.js/oc-pricedup-horse-ev.js. Powers the "Normal +EV" page.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/planetsportbet-horse-ev`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
