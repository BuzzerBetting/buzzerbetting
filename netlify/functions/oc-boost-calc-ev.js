// netlify/functions/oc-boost-calc-ev.js
//
// Thin proxy to the DO server's /api/oc-boost-calc-ev (server.js) — the "calculated" family
// of Oddschecker Price Boosts: OTB-SoT / Headed-SoT / Assist boosts, where Betfair has no
// direct market, so the fair price is the fair_resolver priority chain (BFEX green -> else
// the OC-ladder-devig / BB stage-1 combo) plus the FotMob on-target split (see oc-scraper's
// ev_engine.compute_boost_calc_ev_bets). Written by oc_boosts_scraper.py each cycle. Merged
// into the Calculated +EV page alongside oc-calc-ev.js; every row is tagged boost:true so it
// gets the same "B" icon. GET only.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/oc-boost-calc-ev`, { method: 'GET' });
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
