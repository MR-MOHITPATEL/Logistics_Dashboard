// Daily shipping funnel: how many orders came in each day, and how many are Booked / In Transit / Delivered / RTO.
// Total orders + which orders exist come from Nimbus's own order list (verified to match Shopify's daily count).
// Each order's stage comes from wherever it was actually shipped: Nimbus (if it has a Nimbus AWB) or Shiprocket
// (if Nimbus shows it "fulfilled" elsewhere). An order with neither is Not booked yet.
const nb = require('./nimbus.js');
const sr = require('./shiprocket.js');
const sheets = require('./sheets.js');

const IST_OFFSET = 5.5 * 3600 * 1000;
const istDay = (iso) => new Date(new Date(iso).getTime() + IST_OFFSET).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(new Date(day + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);

// Every order lands in exactly one of these current-position "stages". The dashboard then derives its
// display columns from the stages: notBooked, pendingPickup and beyond -> Booked (has an AWB); pickedUp and
// beyond -> Shipped; and inTransit/delivered/rto split the shipped ones by where they are right now.
const STAGES = ['notBooked', 'pendingPickup', 'inTransit', 'delivered', 'rto'];

// ---- Shiprocket status text -> stage (mapping built from real order data, Sep 2026) ----
function bucketShiprocket(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'NEW') return 'notBooked';
  if (s === 'CANCELED' || s === 'CANCELLED') return 'cancelled';
  if (['PICKUP SCHEDULED', 'READY TO SHIP', 'OUT FOR PICKUP'].includes(s)) return 'pendingPickup';
  if (s.includes('RTO')) return 'rto';
  if (s === 'DELIVERED') return 'delivered';
  return 'inTransit'; // PICKED UP, SHIPPED, IN TRANSIT-EN-ROUTE, OUT FOR DELIVERY, UNDELIVERED-1ST ATTEMPT, etc.
}

// ---- Nimbus tracking text -> stage (real values seen: "pending pickup", "picked"; others inferred, flagged if unrecognised) ----
function bucketNimbusShipStatus(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return { bucket: 'pendingPickup', known: true };
  if (s.includes('pending pickup') || s.includes('out for pickup')) return { bucket: 'pendingPickup', known: true };
  if (s.includes('rto')) return { bucket: 'rto', known: true };
  if (s.includes('deliver') && !s.includes('out for delivery')) return { bucket: 'delivered', known: true };
  if (s.includes('picked') || s.includes('transit') || s.includes('shipped') || s.includes('ndr') || s.includes('undeliver') || s.includes('out for delivery')) return { bucket: 'inTransit', known: true };
  return { bucket: 'inTransit', known: false }; // seen for the first time; counted as moving, flagged for review
}

// Every Nimbus order in [fromDay, toDay] (inclusive, IST calendar days), newest first, tagged with its IST day.
async function nimbusOrdersInRange(fromDay, toDay) {
  const out = [];
  for (let page = 1; page <= 400; page++) {
    const r = await nb.call('/v2/orders?page=' + page + '&limit=100', {});
    const list = r.data || [];
    if (!list.length) break;
    let crossedBelow = false;
    for (const o of list) {
      const d = istDay(o.order_date);
      if (d < fromDay) { crossedBelow = true; break; }
      if (d <= toDay) out.push({ ...o, _day: d });
    }
    if (crossedBelow) break;
  }
  return out;
}

async function trackAwbs(awbs) {
  const map = new Map();
  for (let i = 0; i < awbs.length; i += 100) {
    const r = await nb.call('/v2/tracking/bulk', { method: 'POST', body: { awbs: awbs.slice(i, i + 100) } });
    for (const x of r.data?.found || []) map.set(x.shipment?.awb, x.latest?.shipStatus || '');
  }
  return map;
}

// Shiprocket order status by order number, for every order Shiprocket created in [fromDay-1, toDay+1]
// (padded a day either side: Shiprocket's own created_at can lag Nimbus's order_date slightly).
async function shiprocketStatusMap(fromDay, toDay) {
  const from = addDays(fromDay, -1), to = addDays(toDay, 1);
  const map = new Map();
  for (let page = 1; page <= 200; page++) {
    const r = await sr.listOrders({ from, to, page, perPage: 100 });
    for (const o of r.data) map.set(sheets.norm(o.channel_order_id), o.status);
    if (page >= r.totalPages) break;
  }
  return map;
}

// The funnel for every day in [fromDay, toDay], inclusive. minAmount excludes test orders, same rule as the Orders page.
async function dailyFunnel(fromDay, toDay, minAmount) {
  const nimbusOrders = await nimbusOrdersInRange(fromDay, toDay);
  const qualifying = nimbusOrders.filter((o) => Number(o.total_amount) >= minAmount && o.order_status !== 'cancelled');
  const nimbusBooked = qualifying.filter((o) => o.shipment?.awb);
  const elsewhere = qualifying.filter((o) => !o.shipment?.awb && o.order_status !== 'created');

  const [awbTrack, srMap] = await Promise.all([
    trackAwbs(nimbusBooked.map((o) => o.shipment.awb)),
    elsewhere.length ? shiprocketStatusMap(fromDay, toDay) : Promise.resolve(new Map()),
  ]);

  const days = new Map(); // day -> { day, total, notBooked, pendingPickup, inTransit, delivered, rto }
  const dayRow = (d) => {
    if (!days.has(d)) days.set(d, { day: d, total: 0, ...Object.fromEntries(STAGES.map((s) => [s, 0])) });
    return days.get(d);
  };
  const unknownStatuses = new Set();

  for (const o of qualifying) {
    const row = dayRow(o._day);
    row.total++;
    if (o.shipment?.awb) {
      const { bucket, known } = bucketNimbusShipStatus(awbTrack.get(o.shipment.awb));
      row[bucket]++;
      if (!known) unknownStatuses.add(awbTrack.get(o.shipment.awb));
    } else if (o.order_status === 'created') {
      row.notBooked++;
    } else {
      const status = srMap.get(sheets.norm(o.order_number));
      row[status ? bucketShiprocket(status) : 'notBooked']++;
    }
  }

  // fill in days with zero orders so the report shows a complete date range
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) dayRow(d);
  const rows = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).map(withDisplayColumns);
  return { rows, unknownStatuses: [...unknownStatuses] };
}

// Booked and Shipped are cumulative gates derived from the stage counts: Booked = has an AWB at all
// (pendingPickup and everything past it); Shipped = has actually been picked up (everything past pendingPickup).
function withDisplayColumns(row) {
  const shipped = row.inTransit + row.delivered + row.rto;
  return { ...row, booked: shipped + row.pendingPickup, shipped };
}

module.exports = { dailyFunnel, bucketShiprocket, bucketNimbusShipStatus, withDisplayColumns, STAGES };
