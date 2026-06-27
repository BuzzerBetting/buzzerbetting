exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { url, tab } = event.queryStringParameters || {};
  if (!url) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'url required' }) };

  try {
    const target = tab ? `${url}?tab=${encodeURIComponent(tab)}` : url;
    const res = await fetch(target, { redirect: 'follow' });
    const data = await res.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
