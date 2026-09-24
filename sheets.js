const crypto = require('crypto');
const fs = require('fs');

let token = null, tokenExp = 0;
let cache = { at: 0, map: new Map() };
const TTL = 20 * 1000; // paging/courier lookups reuse the sheet for 20s; Refresh bypasses this

function loadKey() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return JSON.parse(fs.readFileSync(process.env.GOOGLE_KEY_FILE, 'utf8'));
}

async function accessToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const k = loadKey();
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b({ alg: 'RS256', typ: 'JWT' }) + '.' + b({
    iss: k.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(k.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('Google auth failed: ' + (d.error_description || d.error));
  token = d.access_token; tokenExp = Date.now() + d.expires_in * 1000;
  return token;
}

const norm = (v) => String(v ?? '').replace('#', '').trim();

// Map of order number -> Disposition text, read fresh from the sheet unless cached < 20s ago
async function dispositions(force = false) {
  if (!force && Date.now() - cache.at < TTL) return cache.map;
  const range = encodeURIComponent(`'${process.env.SHEET_TAB}'!A:Z`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${process.env.SHEET_ID}/values/${range}`, {
    headers: { Authorization: 'Bearer ' + (await accessToken()) },
  });
  const d = await res.json();
  if (d.error) throw new Error('Google Sheets: ' + d.error.message);
  const [head = [], ...rows] = d.values || [];
  const col = (name) => head.findIndex((h) => String(h).trim().toLowerCase() === name);
  const idCol = col('order_id'), dispCol = col('disposition');
  if (idCol < 0 || dispCol < 0) throw new Error('Sheet is missing an Order_ID or Disposition column');
  const map = new Map();
  for (const r of rows) if (r[idCol]) map.set(norm(r[idCol]), String(r[dispCol] ?? '').trim()); // later rows win
  cache = { at: Date.now(), map };
  return map;
}

module.exports = { dispositions, norm };
