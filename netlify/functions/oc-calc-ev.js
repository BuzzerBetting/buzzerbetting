// netlify/functions/oc-calc-ev.js
//
// Thin proxy to the DO server's /api/oc-calc-ev (server.js) — the "calculated" counterpart
// to oc-ev.js. Reads oc_calc_ev_bets.json: Header/Outside-the-Box goal bets, where the fair
// price is derived (BFEX AGS x FotMob headed/OTB shot-share via ev_engine.
// compute_header_otb_ev_bets) rather than read straight off a matching Betfair market —
// that direct-comparison family (AGS/FGS/Cards/SOT) stays on oc-ev.js/the Oddschecker +EV
// page. Both files are written by the same oc-scraper run every 10 minutes (or on-demand via
// POST /.netlify/functions/oc-ev, which refreshes both), so no separate refresh route needed
// here — GET only.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/oc-calc-ev`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
