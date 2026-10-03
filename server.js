const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const invoices = require('./invoices');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sr = require('./shiprocket');
const sheets = require('./sheets');
const history = require('./history');
const nimbus = require('./nimbus');
const report = require('./report');
const reportstore = require('./reportstore');
const compliance = require('./compliance');

const app = express();
app.use(express.json());

// ---------- pin code -> preferred partner ----------
const pinMap = new Map();
for (const line of fs.readFileSync(path.join(__dirname, 'data', 'pincodes.csv'), 'utf8').split(/\r?\n/).slice(1)) {
  const [pin, ...rest] = line.split(',');
  if (pin && rest.length) pinMap.set(pin.trim(), rest.join(',').trim());
}

// ---------- shared-password auth (signed cookie) ----------
const secret = process.env.SESSION_SECRET || 'dev-secret';
const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('hex');
const COOKIE = 'lg_session';
function authed(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return Number(exp) > Date.now() && sig === sign(exp);
}
app.post('/api/login', (req, res) => {
  const ok = req.body.password && req.body.password === process.env.DASHBOARD_PASSWORD;
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  const exp = String(Date.now() + 12 * 3600 * 1000);
  res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'auth' })));

// ---------- orders ----------
// Nimbus builds its shipment from the Shiprocket order data, so keep the recent orders in memory
const rawOrders = new Map();
function cacheOrders(list) {
  for (const o of list) rawOrders.set(o.id, o);
  while (rawOrders.size > 5000) rawOrders.delete(rawOrders.keys().next().value);
}
let pickups = { at: 0, list: [] };
async function pickupFor(o) {
  if (Date.now() - pickups.at > 3600 * 1000 || !pickups.list.length) {
    const d = await sr.api('/settings/company/pickup');
    pickups = { at: Date.now(), list: (d.data && d.data.shipping_address) || [] };
  }
  return pickups.list.find((l) => l.pickup_location === o.pickup_location) || pickups.list.find((l) => l.is_primary_location) || pickups.list[0];
}
const STALE = 'Order data is out of date. Press Refresh and try again.';

// Orders shipped through Nimbus in the last 7 days are checked with Nimbus: if it says cancelled, the order is released
// (goes back to Ready to ship). Results are cached for 5 minutes; Refresh checks again straight away.
const nbStatus = new Map(); // awb -> { at, cancelled }
async function dropCancelled(ext, force) {
  const now = Date.now(), todo = [];
  for (const [id, x] of ext) {
    if (x.platform !== 'nimbus' || !x.awb || now - new Date(x.shippedAt).getTime() > 7 * 864e5) continue;
    const c = nbStatus.get(x.awb);
    if (!force && c && now - c.at < 5 * 60 * 1000) { if (c.cancelled) ext.delete(id); continue; }
    todo.push([id, x]);
  }
  const worker = async () => {
    while (todo.length) {
      const [id, x] = todo.shift();
      const cancelled = await nimbus.isCancelled(x.awb);
      nbStatus.set(x.awb, { at: Date.now(), cancelled: cancelled === true });
      if (cancelled === true) {
        try { await history.markCancelled({ awb: x.awb }); } catch (e) { console.error('could not mark cancelled:', e.message); }
        ext.delete(id);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return ext;
}

const isoDay = (d) => d.toISOString().slice(0, 10);
const PAGE = 10; // smaller pages mean fewer Shiprocket page-scans needed to fill one, so the first screen shows sooner
const MIN_AMOUNT = Number(process.env.MIN_AMOUNT ?? 500);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function shape(o, disp, ext) {
  const shipment = (o.shipments && o.shipments[0]) || {};
  const pin = String(o.customer_pincode || '').trim();
  // units = "Pack of N" from the end of the product name x ordered quantity (falls back to the ordered quantity)
  const packOf = (name) => { const m = String(name || '').match(/pack\s+of\s+(\d+)\s*$/i); return m ? parseInt(m[1], 10) : 1; };
  const items = (o.products || []).map((p) => ({ sku: p.channel_sku || p.sku || '', name: p.name, qty: (Number(p.quantity) || 0) * packOf(p.name), ordered: Number(p.quantity) || 0, price: Number(p.price) || 0 }));
  const productAmount = items.reduce((n, p) => n + p.price * p.ordered, 0); // price is per ordered item, not per unit in the pack
  return {
    orderId: o.id,
    channelOrderId: o.channel_order_id,
    shipmentId: shipment.id || null,
    placedAt: o.channel_created_at || o.created_at,
    customer: o.customer_name,
    address: [o.customer_address, o.customer_address_2, o.customer_city, o.customer_state].filter(Boolean).join(', '),
    pincode: pin,
    payment: String(o.payment_method || '').toLowerCase(),
    units: items.reduce((n, p) => n + p.qty, 0),
    amount: Number(o.total) || productAmount, // what the customer pays (incl. COD charge), as Shiprocket shows it
    productAmount: productAmount || Number(o.total) || 0, // product value only; used for the minimum-amount rule
    items,
    status: ext ? 'SHIPPED VIA ' + ext.platform.toUpperCase() : o.status,
    viaOther: !!ext,
    platform: ext ? ext.platform : 'shiprocket',
    awb: ext ? ext.awb : shipment.awb_code || shipment.awb || null,
    courier: ext ? ext.courier : shipment.courier || null,
    suggested: pinMap.get(pin) || null,
    disposition: disp ? (disp.get(sheets.norm(o.channel_order_id)) ?? '') : null,
  };
}

// Column filters sent by the dashboard as JSON: lists (exact values), ranges (min/max), text (contains)
function parseFilters(raw) {
  let f = {};
  try { f = JSON.parse(raw || '{}') || {}; } catch (e) { /* ignore bad input */ }
  const list = (k) => (Array.isArray(f[k]) ? f[k].map((v) => String(v).toLowerCase()) : null);
  const range = (k) => (f[k] && typeof f[k] === 'object' ? { min: f[k].min === '' || f[k].min == null ? null : Number(f[k].min), max: f[k].max === '' || f[k].max == null ? null : Number(f[k].max) } : null);
  const text = (k) => (typeof f[k] === 'string' && f[k].trim() ? f[k].trim().toLowerCase() : null);
  return {
    payment: list('payment'), disposition: list('disposition'), partner: list('partner'),
    amount: range('amount'), qty: range('qty'),
    order: text('order'), customer: text('customer'), address: text('address'), pin: text('pin'), sku: text('sku'),
  };
}
const inRange = (n, r) => !r || ((r.min == null || n >= r.min) && (r.max == null || n <= r.max));
const has = (hay, needle) => !needle || String(hay || '').toLowerCase().includes(needle);
function matches(o, F, q) {
  if (F.payment && F.payment.length && !F.payment.includes(o.payment)) return false;
  if (F.disposition && F.disposition.length && o.disposition !== null && !F.disposition.includes(o.disposition.toLowerCase())) return false;
  if (F.partner && F.partner.length && !F.partner.includes((o.suggested || '').toLowerCase())) return false;
  if (!inRange(o.amount, F.amount) || !inRange(o.units, F.qty)) return false;
  if (!has(o.channelOrderId, F.order) || !has(o.customer, F.customer) || !has(o.address, F.address) || !has(o.pincode, F.pin)) return false;
  if (F.sku && !o.items.some((i) => has(i.sku + ' ' + i.name, F.sku))) return false;
  if (q && ![o.channelOrderId, o.customer, o.pincode, o.address, o.items.map((i) => i.sku).join(' ')].join(' ').toLowerCase().includes(q)) return false;
  return true;
}

// dropdown choices for the list filters
app.get('/api/filter-options', async (req, res) => {
  let disposition = [], warning = null;
  try { disposition = [...new Set([...(await sheets.dispositions(false)).values()].filter(Boolean))].sort((a, b) => a.localeCompare(b)); }
  catch (e) { warning = e.message; }
  const partner = [...new Set(pinMap.values())].sort();
  res.json({ disposition, partner, warning });
});

// Reads Shiprocket 100 at a time from `cursor`, keeps only orders passing the filters, until a page of 50 is full.
app.get('/api/orders', async (req, res) => {
  try {
    const to = DAY.test(req.query.to) ? req.query.to : isoDay(new Date());
    const from = DAY.test(req.query.from) ? req.query.from : isoDay(new Date(Date.now() - 7 * 864e5));
    const view = ['ready', 'shipped', 'all'].includes(req.query.view) ? req.query.view : 'ready';
    const F = parseFilters(req.query.f);
    const q = String(req.query.q || '').trim().toLowerCase();
    const fresh = req.query.refresh === '1';
    const [cp, ci] = String(req.query.cursor || '1:0').split(':').map((n) => parseInt(n, 10) || 0);

    let disp = null, sheetWarning = null;
    // Google Sheets can be slow (large sheet) — start it now but don't block on it yet; it only needs to be
    // ready by the time we shape the first order, so it runs alongside the first Shiprocket fetch instead of
    // before it (the two slow things happen at once, not one after the other).
    const dispPromise = sheets.dispositions(fresh).catch((e) => { sheetWarning = e.message; return null; });

    const keep = (o) =>
      (view !== 'ready' || !o.viaOther) && // shipped through Nimbus: no longer ready
      (view !== 'shipped' || o.viaOther || String(o.status).toUpperCase() !== 'NEW') && // Shiprocket can't filter "not new"
      matches(o, F, q) &&
      o.productAmount >= MIN_AMOUNT; // orders under the minimum product amount are always hidden

    const out = [];
    let p = Math.max(cp, 1), i = ci, next = null, scanned = 0, hidden = 0, capped = false, firstFetch = true;
    while (true) {
      const args = { from, to, perPage: 100, newOnly: view === 'ready', fresh };
      const srPromise = Promise.all([ // read the next page in parallel so it is already cached if we need it
        sr.listOrders({ ...args, page: p }),
        sr.listOrders({ ...args, page: p + 1 }).catch(() => null),
      ]);
      let r;
      if (firstFetch) { [[r], disp] = await Promise.all([srPromise, dispPromise]); firstFetch = false; }
      else [r] = await srPromise;
      scanned++;
      cacheOrders(r.data);
      let ext = new Map();
      try { ext = await dropCancelled(await history.shippedElsewhere(r.data.map((x) => x.id)), fresh); } catch (e) { /* history unavailable: treat as none */ }
      for (; i < r.data.length && out.length < PAGE; i++) {
        const o = shape(r.data[i], disp, ext.get(r.data[i].id));
        if (keep(o)) out.push(o); else hidden++;
      }
      const more = i < r.data.length ? { p, i } : p < r.totalPages ? { p: p + 1, i: 0 } : null;
      if (out.length >= PAGE || !more) { next = more; break; }
      if (scanned >= 12) { next = more; capped = true; break; } // safety cap; user can press Next to continue
      p = more.p; i = more.i;
    }
    res.json({ orders: out, nextCursor: next ? `${next.p}:${next.i}` : null, hidden, capped, minAmount: MIN_AMOUNT, from, to, sheetWarning });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// couriers that can serve this order (dropdown options). ?platform=nimbus returns priced Nimbus options instead.
app.get('/api/couriers/:orderId', async (req, res) => {
  try {
    if (req.query.platform === 'nimbus') {
      const o = rawOrders.get(Number(req.params.orderId));
      if (!o) return res.status(409).json({ error: STALE });
      const list = await nimbus.serviceable(o, await pickupFor(o));
      const slab = nimbus.lightest(list);
      const fmt = (c) => { const [d, m] = String(c.edd).split('-'); return `${nimbus.displayName(c, slab)} · ₹${c.total_charges} · by ${d}/${m}`; };
      const pre = req.query.partner ? nimbus.choose(list, String(req.query.partner)) : null;
      return res.json({ couriers: slab.sort(nimbus.byPrice).map((c) => ({ value: 'id:' + c.id, label: fmt(c) })), preselect: pre ? 'id:' + pre.id : null });
    }
    const list = await sr.serviceableCouriers(req.params.orderId);
    res.json({ couriers: [...new Set(list.map(c => c.courier_name))].sort() });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- ship (single or bulk) ----------
async function shipOne({ orderId, shipmentId, partner }) {
  const couriers = await sr.serviceableCouriers(orderId);
  if (!couriers.length) throw new Error('No courier serviceable for this order');
  let pick;
  if (partner && partner !== 'AUTO') {
    const p = partner.toLowerCase();
    pick = couriers.filter(c => c.courier_name.toLowerCase().includes(p)).sort((a, b) => a.rate - b.rate)[0];
    if (!pick) throw new Error(`${partner} not serviceable here. Available: ${[...new Set(couriers.map(c => c.courier_name))].join(', ')}`);
  } else {
    pick = couriers.find(c => c.courier_company_id === (couriers.find(x => x.is_recommended) || {}).courier_company_id) || couriers[0];
  }
  const r = await sr.assignAwb(shipmentId, pick.courier_company_id);
  if (r.awb_assign_status === 0) throw new Error(r.message || 'AWB assignment failed');
  let pickup = 'requested';
  try { await sr.generatePickup(shipmentId); } catch (e) { pickup = `pickup failed: ${e.message}`; }
  let awb = r?.response?.data?.awb_code;
  if (!awb) { // fall back to reading the order back from Shiprocket
    try {
      const d = await sr.api(`/orders/show/${orderId}`);
      const sh = d?.data?.shipments;
      awb = (Array.isArray(sh) ? sh[0] : sh)?.awb || d?.data?.awb_data?.awb || null;
    } catch (e) { /* AWB is still on the order in Shiprocket */ }
  }
  return { courier: pick.courier_name, awb: awb || null, pickup };
}

async function shipNimbus(it) {
  const already = (await history.shippedElsewhere([Number(it.orderId)])).get(Number(it.orderId));
  if (already) throw new Error(`Already shipped through ${already.platform}${already.awb ? ', AWB ' + already.awb : ''}`);
  const o = rawOrders.get(Number(it.orderId));
  if (!o) throw new Error(STALE);
  let phone = '';
  try { phone = await sheets.phoneFor(o.channel_order_id); } catch (e) { throw new Error('Could not read the phone number from the Google Sheet: ' + e.message); }
  if (!phone) throw new Error(`No phone number for order ${o.channel_order_id} in the Google Sheet yet, and Nimbus needs one`);
  const pk = await pickupFor(o);
  if (!pk) throw new Error('No pickup address found in Shiprocket');
  const list = await nimbus.serviceable(o, pk);
  if (!list.length) throw new Error('No Nimbus courier serves this pin code');
  const pick = nimbus.choose(list, it.partner);
  if (!pick) { const slab = nimbus.lightest(list); throw new Error(`${it.partner} is not available through Nimbus for this order. Available: ${[...new Set(slab.map((c) => nimbus.displayName(c, slab)))].join(', ')}`); }
  const r = await nimbus.createShipment(o, pick.id, pk, process.env.NIMBUS_WAREHOUSE, phone);
  return { courier: pick.name, awb: r.awb, pickup: 'requested' };
}

app.post('/api/ship', async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const results = [];
  for (const it of items) { // sequential to respect the platforms' rate limits
    const m = it.meta || {};
    const platform = it.platform === 'nimbus' ? 'nimbus' : 'shiprocket';
    const base = {
      orderId: it.orderId, orderNo: m.orderNo, shipmentId: it.shipmentId, customer: m.customer, pincode: m.pincode,
      payment: m.payment, amount: m.amount, requested: it.partner === 'AUTO' ? null : it.partner, suggested: m.suggested || null, platform,
    };
    let r;
    try { r = { orderId: it.orderId, platform, ok: true, ...(await (platform === 'nimbus' ? shipNimbus(it) : shipOne(it))) }; }
    catch (e) { r = { orderId: it.orderId, platform, ok: false, error: e.message }; }
    try { await history.add({ ...base, courier: r.courier || null, awb: r.awb || null, pickup: r.pickup || null, ok: r.ok, error: r.error || null }); }
    catch (e) { r.historySaved = false; console.error('history save failed:', e.message); } // shipping already happened; just tell the user
    results.push(r);
  }
  res.json({ results });
});

// ---------- shipping history ----------
const IST = '+05:30';
function historyFilters(q) {
  const f = { q: String(q.q || '').trim(), result: ['ok', 'failed', 'cancelled'].includes(q.result) ? q.result : '', courier: String(q.courier || ''), payment: ['cod', 'prepaid'].includes(q.payment) ? q.payment : '', platform: ['shiprocket', 'nimbus'].includes(q.platform) ? q.platform : '' };
  if (DAY.test(q.from)) f.from = new Date(`${q.from}T00:00:00.000${IST}`).toISOString();
  if (DAY.test(q.to)) f.to = new Date(`${q.to}T23:59:59.999${IST}`).toISOString();
  return f;
}
app.get('/api/history', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1), size = 50;
    const r = await history.list({ ...historyFilters(req.query), limit: size, offset: (page - 1) * size });
    res.json({ ...r, page, size, totalPages: Math.max(1, Math.ceil(r.total / size)), storage: history.storage() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// manual fallback: the shipment was cancelled in Nimbus, so free the order
app.post('/api/history/:id/cancel', async (req, res) => {
  try {
    const n = await history.markCancelled({ id: Number(req.params.id) });
    res.json({ ok: n > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/history.csv', async (req, res) => {
  try {
    const { rows } = await history.list({ ...historyFilters(req.query), limit: null });
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const when = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const head = ['Shipped at (IST)', 'Platform', 'Order', 'Customer', 'Pin', 'Payment', 'Amount', 'Courier', 'Suggested partner', 'AWB', 'Pickup', 'Result', 'Error'];
    const lines = rows.map((r) => [when(r.shippedAt), r.platform, r.orderNo, r.customer, r.pincode, r.payment, r.amount, r.courier, r.suggested, r.awb, r.pickup, r.cancelledAt ? 'Cancelled' : r.ok ? 'Shipped' : 'Failed', r.error].map(cell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="shipping-history.csv"');
    res.send('\ufeff' + [head.map(cell).join(','), ...lines].join('\r\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- daily shipping funnel (Booked / Shipped / In Transit / Delivered / RTO per day) ----------
// A background job keeps the last REPORT_WINDOW_DAYS pre-computed in reportstore (Postgres on Railway),
// so most page loads are instant. A request for days outside that window, or a forced refresh, falls back
// to computing live (slow: scans every Nimbus order plus a Shiprocket sweep) and saves the result for next time.
const REPORT_WINDOW_DAYS = 10;
const REPORT_REFRESH_MS = 20 * 60 * 1000;
let reportRefreshing = false;
async function refreshReportWindow() {
  if (reportRefreshing) return; // don't overlap a slow run with the next timer tick
  reportRefreshing = true;
  try {
    const to = isoDay(new Date());
    const from = isoDay(new Date(Date.now() - (REPORT_WINDOW_DAYS - 1) * 864e5));
    const r = await report.dailyFunnel(from, to, MIN_AMOUNT);
    await reportstore.upsert(r.rows);
    console.log(`Daily report: refreshed ${from}..${to} (${r.rows.length} days)`);
  } catch (e) { console.error('Daily report background refresh failed:', e.message); }
  reportRefreshing = false;
}

function summarize(rows) {
  const sum = { total: 0, ...Object.fromEntries(report.STAGES.map((s) => [s, 0])) };
  for (const r of rows) { sum.total += r.total; for (const s of report.STAGES) sum[s] += r[s]; }
  return report.withDisplayColumns(sum);
}
const stripOrders = ({ orders, ...r }) => r; // the aggregate table doesn't need the per-order detail; /api/report/day and /api/compliance* do

// Shared by /api/report and /api/compliance*: the day rows (with per-order detail) for [from, to], from the
// pre-computed cache when every day in range is already stored, otherwise computed live and cached for next time.
async function getRangeRows(from, to, refresh) {
  if (!refresh) {
    const stored = await reportstore.get(from, to);
    const days = []; for (let d = from; d <= to; d = new Date(new Date(d).getTime() + 864e5).toISOString().slice(0, 10)) days.push(d);
    if (days.every((d) => stored.has(d))) return { rows: days.map((d) => report.withDisplayColumns(stored.get(d))), unknownStatuses: [], source: 'store' };
  }
  const r = await report.dailyFunnel(from, to, MIN_AMOUNT);
  reportstore.upsert(r.rows).catch((e) => console.error('report cache save failed:', e.message));
  return { rows: r.rows, unknownStatuses: r.unknownStatuses, source: 'live' };
}

function parseRange(req) {
  const to = DAY.test(req.query.to) ? req.query.to : isoDay(new Date());
  const from = DAY.test(req.query.from) ? req.query.from : isoDay(new Date(Date.now() - 6 * 864e5));
  if (from > to) throw Object.assign(new Error('From date must be before the To date'), { status: 400 });
  if ((new Date(to) - new Date(from)) / 864e5 > 31) throw Object.assign(new Error('Pick a range of 31 days or less'), { status: 400 });
  return { from, to };
}

app.get('/api/report', async (req, res) => {
  try {
    if (!nimbus.configuredV2()) return res.status(409).json({ error: 'Nimbus reporting is not set up: add NIMBUS_API_KEY and NIMBUS_API_SECRET' });
    const { from, to } = parseRange(req);
    const { rows, unknownStatuses, source } = await getRangeRows(from, to, !!req.query.refresh);
    res.json({ rows: rows.map(stripOrders), summary: summarize(rows), unknownStatuses, from, to, source });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// every individual order for one day, for manual verification. Reads the same cache as /api/report when
// available; a day outside the pre-computed window is fetched live (slow) and cached for next time.
app.get('/api/report/day', async (req, res) => {
  try {
    if (!nimbus.configuredV2()) return res.status(409).json({ error: 'Nimbus reporting is not set up: add NIMBUS_API_KEY and NIMBUS_API_SECRET' });
    const day = req.query.day;
    if (!DAY.test(day)) return res.status(400).json({ error: 'Invalid date' });

    let orders;
    if (!req.query.refresh) {
      const stored = await reportstore.get(day, day);
      if (stored.has(day)) orders = stored.get(day).orders;
    }
    if (!orders) {
      const r = await report.dailyFunnel(day, day, MIN_AMOUNT);
      orders = r.rows[0]?.orders || [];
      reportstore.upsert(r.rows).catch((e) => console.error('report cache save failed:', e.message));
    }
    res.json({ day, orders });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- pin code partner compliance: did we ship with the pin code's preferred partner ----------
// Built from the same per-order detail as the Daily report (no extra Nimbus/Shiprocket calls).
app.get('/api/compliance', async (req, res) => {
  try {
    if (!nimbus.configuredV2()) return res.status(409).json({ error: 'Nimbus reporting is not set up: add NIMBUS_API_KEY and NIMBUS_API_SECRET' });
    const { from, to } = parseRange(req);
    const { rows, source } = await getRangeRows(from, to, !!req.query.refresh);
    const pincodes = compliance.byPincode(rows, pinMap);
    res.json({ pincodes, summary: compliance.summarize(pincodes), from, to, source });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get('/api/compliance/pincode', async (req, res) => {
  try {
    if (!nimbus.configuredV2()) return res.status(409).json({ error: 'Nimbus reporting is not set up: add NIMBUS_API_KEY and NIMBUS_API_SECRET' });
    const pincode = String(req.query.pincode || '').trim();
    if (!pincode) return res.status(400).json({ error: 'Missing pincode' });
    const { from, to } = parseRange(req);
    const { rows } = await getRangeRows(from, to, !!req.query.refresh);
    res.json({ pincode, ...compliance.ordersForPincode(rows, pinMap, pincode), from, to });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// ---------- invoices: keep only the invoices for orders actually booked (Shiprocket or Nimbus) ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const pendingZips = new Map(); // download id -> { buffer, at }
setInterval(() => { const cutoff = Date.now() - 30 * 60 * 1000; for (const [id, x] of pendingZips) if (x.at < cutoff) pendingZips.delete(id); }, 5 * 60 * 1000);

app.post('/api/invoices/check', upload.single('zip'), async (req, res) => {
  try {
    if (!nimbus.configuredV2()) return res.status(409).json({ error: 'Nimbus reporting is not set up: add NIMBUS_API_KEY and NIMBUS_API_SECRET' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let zip;
    try { zip = new AdmZip(req.file.buffer); } catch (e) { return res.status(400).json({ error: 'Could not read that file as a ZIP' }); }
    const entries = zip.getEntries().filter((e) => !e.isDirectory && /\.pdf$/i.test(e.entryName));
    if (!entries.length) return res.status(400).json({ error: 'No PDF files found inside the ZIP' });

    const detected = invoices.dateRangeFromFilename(req.file.originalname);
    const from = DAY.test(req.query.from) ? req.query.from : detected?.from;
    const to = DAY.test(req.query.to) ? req.query.to : detected?.to;
    if (!from || !to) return res.status(400).json({ error: "Could not detect the date range from the file name. Pick a From/To date and try again." });
    if ((new Date(to) - new Date(from)) / 864e5 > 31) return res.status(400).json({ error: 'Pick a range of 31 days or less' });

    const orderNumbers = entries.map((e) => e.entryName.replace(/\.pdf$/i, ''));
    const checked = await invoices.checkOrders(orderNumbers, from, to);

    const out = new AdmZip();
    const results = entries.map((e) => {
      const no = e.entryName.replace(/\.pdf$/i, '');
      const c = checked.get(no) || { shipped: false, platform: null, awb: null, courier: null };
      if (c.shipped) out.addFile(e.entryName, e.getData());
      return { orderNo: no, ...c };
    });

    const shippedCount = results.filter((r) => r.shipped).length;
    const downloadId = crypto.randomBytes(12).toString('hex');
    pendingZips.set(downloadId, { buffer: out.toBuffer(), at: Date.now(), name: req.file.originalname.replace(/\.zip$/i, '') + '-shipped-only.zip' });

    res.json({ results, total: results.length, shippedCount, from, to, detectedFromFile: !!detected, downloadId });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/invoices/download/:id', (req, res) => {
  const z = pendingZips.get(req.params.id);
  if (!z) return res.status(404).send('This link has expired. Re-check the ZIP to download it again.');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${z.name}"`);
  res.send(z.buffer);
});

app.use(express.static(path.join(__dirname, 'public')));
Promise.all([
  history.init().catch((e) => console.error('History database unavailable, using a local file instead:', e.message)),
  reportstore.init().catch((e) => console.error('Report cache database unavailable, using a local file instead:', e.message)),
]).finally(() => {
  app.listen(process.env.PORT || 3000, () => console.log('Dashboard on :' + (process.env.PORT || 3000) + ' | history stored in ' + history.storage() + ' | report cache in ' + reportstore.storage()));
  if (nimbus.configuredV2()) {
    refreshReportWindow(); // fills the cache on startup instead of waiting REPORT_REFRESH_MS for the first pass
    setInterval(refreshReportWindow, REPORT_REFRESH_MS);
  }
});
