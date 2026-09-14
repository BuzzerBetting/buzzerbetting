// netlify/functions/oc-pricedup-horse-ev.js
//
// Thin proxy to the DO server's /api/pricedup-horse-ev (server.js) — PricedUp Enhanced-
// Double horse racing +EV bets, written by oc-scraper's pricedup_horse_ev_scan.py (each
// leg's BFEX WIN-market fair odds multiplied together, compared against PricedUp's boosted
// price). Same read-only contract as oc-ev.js/oc-boost-ev.js. Powers the "Normal +EV" page
// (renamed from Oddschecker +EV, 2026-09-14) — each row is a normal
// {t,match,mkt,sel,fair,bk,odds,ev} bet, mkt:'Horse Double', merged into the same table as
// the regular Oddschecker-vs-BFEX bets.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/pricedup-horse-ev`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
