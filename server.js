const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sr = require('./shiprocket');
const sheets = require('./sheets');
const history = require('./history');

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
const isoDay = (d) => d.toISOString().slice(0, 10);
const PAGE = 50;
const MIN_AMOUNT = Number(process.env.MIN_AMOUNT ?? 500);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function shape(o, disp) {
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
    status: o.status,
    awb: shipment.awb_code || shipment.awb || null,
    courier: shipment.courier || null,
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
    try { disp = await sheets.dispositions(req.query.refresh === '1'); }
    catch (e) { sheetWarning = e.message; } // orders still load if the sheet is unreachable

    const keep = (o) =>
      (view !== 'shipped' || String(o.status).toUpperCase() !== 'NEW') && // Shiprocket can't filter "not new"
      matches(o, F, q) &&
      o.productAmount >= MIN_AMOUNT; // orders under the minimum product amount are always hidden

    const out = [];
    let p = Math.max(cp, 1), i = ci, next = null, scanned = 0, hidden = 0, capped = false;
    while (true) {
      const args = { from, to, perPage: 100, newOnly: view === 'ready', fresh };
      const [r] = await Promise.all([ // read the next page in parallel so it is already cached if we need it
        sr.listOrders({ ...args, page: p }),
        sr.listOrders({ ...args, page: p + 1 }).catch(() => null),
      ]);
      scanned++;
      for (; i < r.data.length && out.length < PAGE; i++) {
        const o = shape(r.data[i], disp);
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

// couriers Shiprocket says can serve this order (dropdown options)
app.get('/api/couriers/:orderId', async (req, res) => {
  try {
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

app.post('/api/ship', async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const results = [];
  for (const it of items) { // sequential to respect Shiprocket rate limits
    const m = it.meta || {};
    const base = {
      orderId: it.orderId, orderNo: m.orderNo, shipmentId: it.shipmentId, customer: m.customer, pincode: m.pincode,
      payment: m.payment, amount: m.amount, requested: it.partner === 'AUTO' ? null : it.partner, suggested: m.suggested || null,
    };
    let r;
    try { r = { orderId: it.orderId, ok: true, ...(await shipOne(it)) }; }
    catch (e) { r = { orderId: it.orderId, ok: false, error: e.message }; }
    try { await history.add({ ...base, courier: r.courier || null, awb: r.awb || null, pickup: r.pickup || null, ok: r.ok, error: r.error || null }); }
    catch (e) { r.historySaved = false; console.error('history save failed:', e.message); } // shipping already happened; just tell the user
    results.push(r);
  }
  res.json({ results });
});

// ---------- shipping history ----------
const IST = '+05:30';
function historyFilters(q) {
  const f = { q: String(q.q || '').trim(), result: ['ok', 'failed'].includes(q.result) ? q.result : '', courier: String(q.courier || ''), payment: ['cod', 'prepaid'].includes(q.payment) ? q.payment : '' };
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
app.get('/api/history.csv', async (req, res) => {
  try {
    const { rows } = await history.list({ ...historyFilters(req.query), limit: null });
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const when = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const head = ['Shipped at (IST)', 'Order', 'Customer', 'Pin', 'Payment', 'Amount', 'Courier', 'Suggested partner', 'AWB', 'Pickup', 'Result', 'Error'];
    const lines = rows.map((r) => [when(r.shippedAt), r.orderNo, r.customer, r.pincode, r.payment, r.amount, r.courier, r.suggested, r.awb, r.pickup, r.ok ? 'Shipped' : 'Failed', r.error].map(cell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="shipping-history.csv"');
    res.send('\ufeff' + [head.map(cell).join(','), ...lines].join('\r\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static(path.join(__dirname, 'public')));
history.init()
  .catch((e) => console.error('History database unavailable, using a local file instead:', e.message))
  .finally(() => app.listen(process.env.PORT || 3000, () => console.log('Dashboard on :' + (process.env.PORT || 3000) + ' | history stored in ' + history.storage())));
