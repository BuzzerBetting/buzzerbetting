// netlify/functions/oc-boost-ev.js
//
// Thin proxy to the DO server's /api/oc-boost-ev (server.js) — the +EV subset of Oddschecker
// Price Boosts (only markets with a fair-odds source built: AGS/FGS/CARDS/SOT/HEADER/OTB —
// see oc-scraper/oc/logic_boosts.MARKETS_WITH_FAIR_SOURCE), written by oc_boosts_scraper.py
// every ~3 min. Same read-only contract as oc-ev.js. Powers the Oddschecker +EV page's
// boosts section — each row is a normal {t,match,mkt,sel,fair,bk,odds,ev} bet plus
// boost:true, so the frontend renders the same red "B" icon shown on Today's Matches.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/oc-boost-ev`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
