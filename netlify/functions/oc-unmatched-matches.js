// netlify/functions/oc-unmatched-matches.js
//
// Thin proxy to the DO server's /api/oc-unmatched-matches (server.js) — the Bet Alerts
// "OC Coverage" tab feed: today's fixtures the Oddschecker scraper couldn't find a match page
// for (see oc_cache.store_oc_unmatched_matches), not value bets. Same read-only contract as
// oc-bet-alert-errors.js.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/oc-unmatched-matches`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
