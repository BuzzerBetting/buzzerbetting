// netlify/functions/oc-starsports-acca-ev.js
//
// Thin proxy to the DO server's /api/starsports-acca-ev (server.js) — StarSports simple win-acca
// football +EV bets, written by oc-scraper's starsports_acca_ev_scan.py (each team's own BFEX
// MATCH_ODDS fair odds multiplied together, compared against StarSports' boosted price). Same
// read-only contract as oc-ev.js/oc-pricedup-acca-ev.js. Powers the "Normal +EV" page — each
// row is a normal {t,match,mkt,sel,fair,bk,odds,ev} bet, mkt:'Win Acca', merged into the same
// table as the regular Oddschecker/PricedUp/Paddy Power bets.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/starsports-acca-ev`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
