// netlify/functions/oc-paddypower-horse-ev.js
//
// Thin proxy to the DO server's /api/paddypower-horse-ev (server.js) — Paddy Power "Racing
// Specials" (POWER_PRICES) horse double +EV bets, written by oc-scraper's
// paddypower_horse_ev_scan.py. Same read-only contract as oc-pricedup-horse-ev.js. Powers
// the "Normal +EV" page — each row is a normal {t,match,mkt,sel,fair,bk,odds,ev} bet,
// mkt:'Horse Double', merged into the same table as the regular Oddschecker bets and the
// PricedUp doubles.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/paddypower-horse-ev`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
