// netlify/functions/bet-alerts-arbs.js
//
// Thin proxy to the DO server's /api/oc-arbs (server.js) — the "Arbs" edge on the Bet
// Alerts page. Same read-only contract as oc-ev.js / oc-calc-ev.js: GET returns whatever
// the scraper last wrote, no live scraping here.
//
// The oc-scraper side that writes oc_arb_bets.json doesn't exist yet, so this currently
// always returns an empty feed ({ ok:true, updated:null, bets:[] }) and the Arbs tab shows
// its empty state. Wiring it now means the tab lights up with zero frontend changes once
// the scraper starts producing the file.
//
// Bets array shape: { t, match, mkt, sel, fair, bk, odds, ev, legs?:[{bk,odds,sel}], profit_pct? }.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/oc-arbs`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
