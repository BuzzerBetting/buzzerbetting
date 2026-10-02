// netlify/functions/bet-alerts-nfltd.js
//
// Thin proxy to the DO server's /api/nfl-td-ev (server.js) — the "NFL TDs" edge on the Bet Alerts
// page: NetBet / William Hill / Paddy Power 2+/3+ touchdown prices above a Poisson fair built
// from the Betfair anytime-TD price (oc-scraper/scripts/nfl_td_scan.py, 2026-10-02).
//
// Bets array shape: { t, d, match, mkt, sel, fair, bk, odds, ev, url, fair1, bfTraded }.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/nfl-td-ev`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
