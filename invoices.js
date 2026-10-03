// Invoice filtering: given a Shopify invoice ZIP (one PDF per order, named "#<order number>.pdf"), work out
// which of those orders have actually been booked (an AWB assigned, via Nimbus or Shiprocket — the exact
// same live check used by the Daily report and Partner compliance), and build a ZIP with only those invoices.
const report = require('./report.js');
const sheets = require('./sheets.js');

// Shopify names these exports "invoice-<fromISO>-<toISO>.zip" in UTC; convert to the IST calendar day(s)
// that covers, so we scan the right Nimbus/Shiprocket data without asking the user for the range.
function dateRangeFromFilename(name) {
  const m = name.match(/invoice-(\d{4}-\d{2}-\d{2}T[\d_.]+Z)-(\d{4}-\d{2}-\d{2}T[\d_.]+Z)/i);
  if (!m) return null;
  const toIso = (s) => s.replace(/_/g, ':');
  const start = new Date(toIso(m[1])), end = new Date(toIso(m[2]));
  if (isNaN(start) || isNaN(end)) return null;
  const istDay = (d) => new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  return { from: istDay(start), to: istDay(new Date(end.getTime() - 1000)) }; // end is exclusive in the export name
}

// order number (any formatting) -> { shipped, platform, awb, courier, stage }, booked = has an AWB at all
async function checkOrders(orderNumbers, from, to) {
  const { rows } = await report.dailyFunnel(from, to, 0); // minAmount 0: never exclude an order just because it's cheap
  const byNo = new Map();
  for (const row of rows) for (const o of row.orders) byNo.set(sheets.norm(o.orderNo), o);

  const result = new Map();
  for (const raw of orderNumbers) {
    const o = byNo.get(sheets.norm(raw));
    result.set(raw, o
      ? { shipped: o.stage !== 'notBooked', platform: o.platform, awb: o.awb, courier: o.courier, stage: o.stage }
      : { shipped: false, platform: null, awb: null, courier: null, stage: 'notFound' });
  }
  return result;
}

module.exports = { dateRangeFromFilename, checkOrders };
