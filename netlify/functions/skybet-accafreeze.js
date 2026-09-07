// netlify/functions/skybet-accafreeze.js
//
// Thin proxy to the DO server's /api/skybet-accafreeze (server.js), same pattern as
// oc-ev.js/fixtures.js. The real scraping logic lives in skybet-accafreeze-lib.js at the repo
// root and only ever runs on the DO box — moved there 2026-09-07 after discovering SkyBet
// blocks the request outright when it comes from Netlify's US-based function IP (almost
// certainly its UK/Ireland gambling-license geo-fence; the DO droplet is London-based). Calling
// this same file from here would just 403 again, so don't be tempted to inline the logic back —
// see skybet-accafreeze-lib.js's header comment for the full story.
//
// Same DO_HOST/DO_PORT env-var pattern as ledger.js/fixtures.js/oc-ev.js, so each independent
// deployment can point at its own backend without editing this file.
const DO_HOST = process.env.LEDGER_DO_HOST || '178.128.40.248';
const DO_PORT = process.env.LEDGER_DO_PORT ? Number(process.env.LEDGER_DO_PORT) : 3000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const res = await fetch(`http://${DO_HOST}:${DO_PORT}/api/skybet-accafreeze`);
    if (!res.ok) throw new Error(`DO server returned HTTP ${res.status}`);
    const d = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(d) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
