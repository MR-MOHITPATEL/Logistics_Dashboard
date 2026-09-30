const crypto = require('crypto');
const fs = require('fs');

let token = null, tokenExp = 0;
let cache = { at: 0, map: new Map(), phones: new Map() };
// This sheet is large enough that Google is currently slow to serve it (measured 2-5 minutes on a bad day),
// so a short TTL made ordinary page loads pay that cost constantly. 5 minutes trades some staleness for that;
// Refresh on the Orders page always bypasses this and reads live.
const TTL = 5 * 60 * 1000;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const colLetter = (i) => (i < 26 ? '' : colLetter(Math.floor(i / 26) - 1)) + String.fromCharCode(65 + (i % 26));

// A single GET, retried a few times with backoff — this sheet's size occasionally trips a transient
// Google-side "service unavailable" (or, for the old full-width fetch, just takes minutes).
async function getValues(range, attempt = 1) {
  const MAX = 4;
  let res;
  try {
    res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${process.env.SHEET_ID}/values/${encodeURIComponent(range)}`, {
      headers: { Authorization: 'Bearer ' + (await accessToken()) },
    });
  } catch (e) {
    if (attempt >= MAX) throw new Error('Google Sheets unreachable: ' + e.message);
    await sleep(500 * 2 ** (attempt - 1));
    return getValues(range, attempt + 1);
  }
  const d = await res.json().catch(() => ({}));
  if (d.error && /unavailable|backend|timeout/i.test(d.error.message || '') && attempt < MAX) {
    await sleep(1000 * attempt);
    return getValues(range, attempt + 1);
  }
  if (d.error) throw new Error('Google Sheets: ' + d.error.message);
  return d.values || [];
}

// Map of order number -> Disposition text, read fresh from the sheet unless cached < 20s ago.
// The sheet has 18,000+ rows and 30+ columns; we only need 3, so read the header row first to find which
// columns those are, then fetch just those columns instead of the whole sheet (was taking minutes at full width).
async function dispositions(force = false) {
  if (!force && Date.now() - cache.at < TTL) return cache.map;
  const tab = process.env.SHEET_TAB;
  const [head = []] = await getValues(`'${tab}'!1:1`);
  const col = (name) => head.findIndex((h) => String(h).trim().toLowerCase() === name);
  const idIdx = col('order_id'), dispIdx = col('disposition'), phoneIdx = col('phone');
  if (idIdx < 0 || dispIdx < 0) throw new Error('Sheet is missing an Order_ID or Disposition column');

  const idCol = colLetter(idIdx), dispCol = colLetter(dispIdx), phoneCol = phoneIdx >= 0 ? colLetter(phoneIdx) : null;
  const [ids, disps, phones] = await Promise.all([
    getValues(`'${tab}'!${idCol}2:${idCol}`),
    getValues(`'${tab}'!${dispCol}2:${dispCol}`),
    phoneCol ? getValues(`'${tab}'!${phoneCol}2:${phoneCol}`) : Promise.resolve([]),
  ]);

  const map = new Map(), phoneMap = new Map();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]?.[0];
    if (!id) continue;
    map.set(norm(id), String(disps[i]?.[0] ?? '').trim()); // later rows win
    const ph = String(phones[i]?.[0] ?? '').replace(/\D/g, '').slice(-10);
    if (ph.length === 10) phoneMap.set(norm(id), ph);
  }
  cache = { at: Date.now(), map, phones: phoneMap };
  return map;
}

// customer phone for an order, read from the sheet (Shiprocket masks phone numbers in its API). '' when not there yet.
async function phoneFor(orderNo) {
  await dispositions(false);
  const p = cache.phones.get(norm(orderNo));
  if (p) return p;
  await dispositions(true); // maybe the row was added a moment ago
  return cache.phones.get(norm(orderNo)) || '';
}

module.exports = { dispositions, phoneFor, norm };
