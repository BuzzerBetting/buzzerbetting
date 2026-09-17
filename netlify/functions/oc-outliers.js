// netlify/functions/oc-outliers.js
//
// Thin proxy to the DO server's /api/oc-outliers (server.js) — the Bet Alerts "Outliers" tab
// feed: a single bookmaker's price that's >=50% above the next-best price in its own market's
// ladder (see oc_cache.store_oc_outliers / scripts/oc_outliers_scan.py), not a value bet —
// deliberately unrelated to any fair-odds model. Same read-only contract as the other oc-*.js
// proxies.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/oc-outliers`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
