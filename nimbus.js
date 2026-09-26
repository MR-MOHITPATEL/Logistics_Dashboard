// NimbusPost API (https://api.nimbuspost.com/v1). Orders come from Shiprocket's order data; this creates the shipment in Nimbus.
const BASE = 'https://api.nimbuspost.com/v1';
let token = null;
let tokenAt = 0;

const configured = () => !!(process.env.NIMBUS_EMAIL && process.env.NIMBUS_PASSWORD);

function errorText(d) {
  if (!d) return '';
  if (typeof d.message === 'string' && d.message) return d.message.trim();
  if (typeof d.data === 'string') return d.data;
  return JSON.stringify(d).slice(0, 300);
}

async function login() {
  if (!configured()) throw new Error('Nimbus is not set up: add NIMBUS_EMAIL and NIMBUS_PASSWORD');
  const res = await fetch(`${BASE}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.NIMBUS_EMAIL, password: process.env.NIMBUS_PASSWORD }),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.status || typeof d.data !== 'string') throw new Error('Nimbus login failed: ' + errorText(d));
  token = d.data;
  tokenAt = Date.now();
}

async function call(path, { method = 'GET', body } = {}, retry = true) {
  if (!token || Date.now() - tokenAt > 6 * 3600 * 1000) await login();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 401 || res.status === 403) && retry) { token = null; return call(path, { method, body }, false); }
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.status === false) throw new Error(errorText(d) || `Nimbus ${res.status}`);
  return d;
}

// ---- turning a Shiprocket order into Nimbus's package / address fields ----
const phone10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const isCod = (o) => String(o.payment_method || '').toLowerCase() === 'cod';

function packageOf(o) {
  const sh = (o.shipments && o.shipments[0]) || {};
  const dims = String(sh.dimensions || '').split('x').map(Number);
  const [length, breadth, height] = [0, 1, 2].map((i) => Math.max(1, Math.ceil(dims[i] || 10)));
  const weight = Math.max(100, Math.round((Number(sh.weight) || 0.5) * 1000)); // grams
  return { weight, length, breadth, height };
}

// couriers that can deliver this order, each with price and delivery date
async function serviceable(o, pickup) {
  const pkg = packageOf(o);
  const d = await call('/courier/serviceability', {
    method: 'POST',
    body: {
      origin: String(pickup.pin_code), destination: String(o.customer_pincode),
      payment_type: isCod(o) ? 'cod' : 'prepaid', order_amount: Number(o.total) || 0,
      weight: pkg.weight, length: pkg.length, breadth: pkg.breadth, height: pkg.height,
    },
  });
  return d.data || [];
}

// Nimbus lists each courier several times by weight slab. Keep the lightest slab, which is the one that fits our parcels.
// min_weight is in grams, except freight couriers like Shree-Maruti which report kilograms (30 = 30 kg), so normalise first.
const minGrams = (c) => (c.min_weight < 100 ? c.min_weight * 1000 : c.min_weight);
function lightest(list) {
  if (!list.length) return [];
  const min = Math.min(...list.map(minGrams));
  return list.filter((c) => minGrams(c) === min);
}
const eddTime = (c) => { const [d, m, y] = String(c.edd || '').split('-').map(Number); return y ? new Date(y, m - 1, d).getTime() : Infinity; };
const byPrice = (a, b) => a.total_charges - b.total_charges;

// partner: 'AUTO' | 'id:<nimbus courier id>' | a name from the pin code list, e.g. "Delhivery Surface" or "Xpressbees Air".
// Nimbus names have no Surface/Air, so: Surface or plain name -> cheapest entry; Air -> fastest entry (cheapest if none is faster).
function choose(list, partner) {
  const slab = lightest(list);
  if (!partner || partner === 'AUTO') return [...slab].sort(byPrice)[0] || null;
  if (partner.startsWith('id:')) return list.find((c) => c.id === partner.slice(3)) || null;
  const p = partner.toLowerCase();
  const wantsAir = /\bair\b/.test(p);
  const base = p.replace(/\b(surface|air|express)\b/g, '').trim();
  const mine = slab.filter((c) => c.name.toLowerCase().includes(base));
  if (!mine.length) return null;
  if (wantsAir) {
    const fastest = Math.min(...mine.map(eddTime));
    return mine.filter((c) => eddTime(c) === fastest).sort(byPrice)[0];
  }
  return [...mine].sort(byPrice)[0];
}

function shipmentBody(o, courierId, pickup, warehouseName, customerPhone) {
  const pkg = packageOf(o);
  return {
    order_number: String(o.channel_order_id),
    payment_type: isCod(o) ? 'cod' : 'prepaid',
    order_amount: Number(o.total) || 0, // for COD this is what the courier collects
    shipping_charges: 0, discount: 0, cod_charges: 0,
    package_weight: pkg.weight, package_length: pkg.length, package_breadth: pkg.breadth, package_height: pkg.height,
    request_auto_pickup: 'yes',
    courier_id: courierId,
    consignee: {
      name: o.customer_name, address: o.customer_address, address_2: o.customer_address_2 || '',
      city: o.customer_city, state: o.customer_state, pincode: String(o.customer_pincode),
      phone: phone10(customerPhone || o.customer_phone_unmasked),
    },
    pickup: {
      warehouse_name: warehouseName || pickup.pickup_location, name: pickup.name || pickup.pickup_location,
      address: pickup.address, address_2: pickup.address_2 || '', city: pickup.city, state: pickup.state,
      pincode: String(pickup.pin_code), phone: phone10(pickup.phone),
    },
    order_items: (o.products || []).map((p) => ({ name: p.name, qty: Number(p.quantity) || 1, price: Number(p.price) || 0, sku: p.channel_sku || p.sku || '' })),
  };
}

async function createShipment(o, courierId, pickup, warehouseName, customerPhone) {
  const body = shipmentBody(o, courierId, pickup, warehouseName, customerPhone);
  const d = await call('/shipments', { method: 'POST', body });
  const r = d.data || {};
  return { awb: r.awb_number || r.awb || null, shipmentId: r.shipment_id || null, label: r.label || null };
}

// true when Nimbus says the shipment is cancelled, false when it says anything else, null when we could not find out
async function isCancelled(awb) {
  try {
    const d = await call('/shipments/track/' + encodeURIComponent(awb));
    const x = d.data || {};
    const text = [x.status, x.current_status, x.shipment_status, x.tracking_status].filter((v) => typeof v === 'string').join(' ');
    return /cancel/i.test(text);
  } catch (e) { return null; }
}

module.exports = { isCancelled, configured, serviceable, lightest, choose, createShipment, shipmentBody, byPrice };
