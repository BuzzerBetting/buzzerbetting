const https = require('https');
const http = require('http');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const { home, away } = event.queryStringParameters || {};
  if (!home || !away) return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'home and away required' })
  };

  return new Promise((resolve) => {
    const url = `http://178.128.40.248:3000/api/betfair?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        statusCode: 200, headers: CORS, body: data
      }));
    }).on('error', (err) => resolve({
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message })
    }));
  });
};
