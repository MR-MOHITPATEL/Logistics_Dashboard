const BASE = 'https://apiv2.shiprocket.in/v1/external';
let token = null;
let tokenAt = 0;

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.SHIPROCKET_EMAIL, password: process.env.SHIPROCKET_PASSWORD }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(data.message || 'Shiprocket login failed');
  token = data.token;
  tokenAt = Date.now();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A day scan makes many sequential calls; a single dropped connection or rate-limit response anywhere in that
// sequence shouldn't abort the whole thing, so those get a few retries with backoff (retryAuth is separate:
// one retry after refreshing an expired token).
async function api(path, { method = 'GET', body } = {}, retryAuth = true, attempt = 1) {
  // tokens last 10 days; refresh after 8
  if (!token || Date.now() - tokenAt > 8 * 24 * 3600 * 1000) await login();
  const MAX = 4;
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (attempt >= MAX) throw new Error(`Shiprocket unreachable after ${MAX} tries: ${e.message}`);
    await sleep(500 * 2 ** (attempt - 1));
    return api(path, { method, body }, retryAuth, attempt + 1);
  }
  if (res.status === 401 && retryAuth) { token = null; return api(path, { method, body }, false, attempt); }
  if (res.status === 429 && attempt < MAX) { await sleep(2000 * attempt); return api(path, { method, body }, retryAuth, attempt + 1); }
  if (res.status >= 500 && attempt < MAX) { await sleep(500 * 2 ** (attempt - 1)); return api(path, { method, body }, retryAuth, attempt + 1); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Shiprocket ${res.status}`);
  return data;
}

// one page of orders from Shiprocket; newOnly=true returns only status NEW (code 1). Cached 30s unless fresh=true.
const pageCache = new Map();
async function listOrders({ from, to, page = 1, perPage = 50, newOnly = false, fresh = false }) {
  const q = new URLSearchParams({ per_page: perPage, page, sort: 'DESC', sort_by: 'created_at' });
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (newOnly) { q.set('filter_by', 'status'); q.set('filter', '1'); }
  const key = q.toString();
  const hit = pageCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 30000) return hit.value;
  const d = await api(`/orders?${q}`);
  const p = d.meta?.pagination || {};
  const value = { data: d.data || [], total: p.total || 0, totalPages: p.total_pages || 1, page: p.current_page || page };
  pageCache.set(key, { at: Date.now(), value });
  if (pageCache.size > 60) pageCache.delete(pageCache.keys().next().value);
  return value;
}

async function serviceableCouriers(orderId) {
  const d = await api(`/courier/serviceability?order_id=${orderId}`);
  return d?.data?.available_courier_companies || [];
}

const assignAwb = (shipmentId, courierId) =>
  api('/courier/assign/awb', { method: 'POST', body: { shipment_id: shipmentId, courier_id: courierId } });
const generatePickup = (shipmentId) =>
  api('/courier/generate/pickup', { method: 'POST', body: { shipment_id: [shipmentId] } });

module.exports = { api, listOrders, serviceableCouriers, assignAwb, generatePickup };
