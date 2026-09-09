// netlify/functions/oc-boosts.js
//
// Thin proxy to the DO server's /api/oc-boosts (server.js) — which matches currently have a
// qualifying Oddschecker Price Boost (see oc-scraper/oc/logic_boosts.py's TARGET_MARKETS),
// written by oc_boosts_scraper.py every ~3 min alongside the main OC scan. Existence only —
// no prices here by design (see oc-boost-ev.js for the actual +EV boosted prices). Powers
// the Today's Matches "B" icon.
//
// matches[] shape: { match_id, match, utc_time, count, markets: {AGS: 2, HEADER: 1, ...} }.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/oc-boosts`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
