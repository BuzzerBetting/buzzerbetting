// netlify/functions/oc-bet-alert-errors.js
//
// Thin proxy to the DO server's /api/bet-alert-errors (server.js) — the Bet Alerts "Errors"
// tab feed: market-integrity flags (a bookmaker's market still open past when it should have
// suspended), not value bets. Same read-only contract as the other oc-*.js proxies. Polled
// globally (not just while the Errors tab is open) so a new entry can trigger a sound alert
// regardless of which page the user is currently on.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/bet-alert-errors`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
