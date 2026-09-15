// netlify/functions/oc-williamhill-horse-ev.js
//
// Thin proxy to the DO server's /api/williamhill-horse-ev (server.js) — William Hill "Both To
// Win" horse racing double +EV bets, written by oc-scraper's williamhill_horse_ev_scan.py
// (pulled directly from WH's public search API, each leg's own BFEX WIN-market fair odds
// multiplied together — see that file's docstring). Same read-only contract as
// oc-ev.js/oc-pricedup-horse-ev.js. Powers the "Normal +EV" page.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/williamhill-horse-ev`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
