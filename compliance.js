// Partner compliance: for orders to a pin code on the preferred-partner list, did we actually ship with the
// partner we said we would. Built entirely from the per-order detail already collected for the Daily report
// (see report.js / reportstore.js) — no extra Nimbus or Shiprocket calls.
//
// Match rule: exact, case-insensitive, including the Surface/Air suffix — "Delhivery Air" does not count as
// a match for a pin code whose preferred partner is "Delhivery Surface".
// Orders that haven't shipped yet (no courier used) are left out of the percentage; they show as "pending".

const norm = (s) => String(s || '').trim().toLowerCase();

// dayRows: [{ day, orders: [...] }] as returned by report.dailyFunnel / reportstore.get.
// pinMap: Map(pincode -> preferred partner), the same one server.js loads from data/pincodes.csv.
function byPincode(dayRows, pinMap) {
  const stats = new Map(); // pincode -> { pincode, preferred, total, shipped, matched, pending }
  for (const day of dayRows) {
    for (const o of day.orders) {
      if (!o.pincode) continue;
      const preferred = pinMap.get(o.pincode);
      if (!preferred) continue; // not one of the 100 tracked pin codes
      if (!stats.has(o.pincode)) stats.set(o.pincode, { pincode: o.pincode, preferred, total: 0, shipped: 0, matched: 0, pending: 0 });
      const s = stats.get(o.pincode);
      s.total++;
      if (o.courier) {
        s.shipped++;
        if (norm(o.courier) === norm(preferred)) s.matched++;
      } else {
        s.pending++;
      }
    }
  }
  const rows = [...stats.values()].map((s) => ({ ...s, pct: s.shipped ? Math.round((s.matched / s.shipped) * 100) : null }));
  rows.sort((a, b) => b.total - a.total);
  return rows;
}

function summarize(rows) {
  const s = rows.reduce((a, r) => ({ total: a.total + r.total, shipped: a.shipped + r.shipped, matched: a.matched + r.matched, pending: a.pending + r.pending }),
    { total: 0, shipped: 0, matched: 0, pending: 0 });
  return { ...s, pct: s.shipped ? Math.round((s.matched / s.shipped) * 100) : null };
}

// Every order for one pin code, across the requested days, newest first.
function ordersForPincode(dayRows, pinMap, pincode) {
  const preferred = pinMap.get(pincode) || null;
  const out = [];
  for (const day of dayRows) {
    for (const o of day.orders) {
      if (o.pincode !== pincode) continue;
      out.push({
        date: day.day, orderNo: o.orderNo, customer: o.customer, preferred, actual: o.courier || null,
        match: !o.courier ? null : norm(o.courier) === norm(preferred), platform: o.platform, awb: o.awb, amount: o.amount, payment: o.payment,
      });
    }
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { preferred, orders: out };
}

module.exports = { byPincode, summarize, ordersForPincode };
