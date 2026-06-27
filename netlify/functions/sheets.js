// netlify/functions/sheets.js
// Proxies Google Apps Script requests server-side to avoid CORS issues
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { url, tab } = event.queryStringParameters || {};
  if (!url) return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'url parameter required' })
  };

  try {
    const target = tab ? `${url}?tab=${encodeURIComponent(tab)}` : url;
    const res = await fetch(target, {
      redirect: 'follow',
      headers: { 'User-Agent': 'BuzzerBetting/1.0' }
    });
    if (!res.ok) return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: `Sheet returned HTTP ${res.status}` })
    };
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch(e) { return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: 'Sheet response was not valid JSON — check your Apps Script is deployed correctly' }) }; }
    return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
