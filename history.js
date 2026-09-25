// Shipping history: Postgres when DATABASE_URL is set (Railway), otherwise a local JSON file.
const fs = require('fs');
const path = require('path');

let pool = null;
const FILE = process.env.HISTORY_FILE || path.join(__dirname, 'data', 'history.json');

async function init(injectedPool) {
  if (injectedPool || process.env.DATABASE_URL) {
    if (injectedPool) pool = injectedPool;
    else {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
    }
    await pool.query(`create table if not exists shipments (
      id serial primary key,
      shipped_at timestamptz not null default now(),
      order_id bigint, order_no text, shipment_id bigint, customer text, pincode text, payment text,
      amount numeric, courier text, requested text, suggested text, awb text, pickup text,
      ok boolean not null, error text)`);
    await pool.query('create index if not exists shipments_shipped_at on shipments (shipped_at desc)');
  }
}
const storage = () => (pool ? 'database' : 'file');

const readFile = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; } };

async function add(e) {
  if (pool) {
    await pool.query(
      `insert into shipments (order_id, order_no, shipment_id, customer, pincode, payment, amount, courier, requested, suggested, awb, pickup, ok, error)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [e.orderId, e.orderNo, e.shipmentId, e.customer, e.pincode, e.payment, e.amount, e.courier, e.requested, e.suggested, e.awb, e.pickup, e.ok, e.error]);
  } else {
    const all = readFile();
    all.push({ ...e, shippedAt: new Date().toISOString() });
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(all));
  }
}

const fromDb = (r) => ({
  id: r.id, shippedAt: new Date(r.shipped_at).toISOString(), orderId: r.order_id == null ? null : Number(r.order_id), orderNo: r.order_no,
  customer: r.customer, pincode: r.pincode, payment: r.payment, amount: r.amount == null ? null : Number(r.amount),
  courier: r.courier, requested: r.requested, suggested: r.suggested, awb: r.awb, pickup: r.pickup, ok: r.ok, error: r.error,
});

// f: { from, to (ISO instants), q, result: 'ok'|'failed', courier, payment, limit, offset }
async function list(f) {
  const limit = 'limit' in f ? f.limit : 50, offset = f.offset ?? 0; // limit: null means no limit (CSV export)
  if (pool) {
    const conds = [], params = [];
    const add$ = (sql, v) => { params.push(v); conds.push(sql.replaceAll('?', '$' + params.length)); };
    if (f.from) add$('shipped_at >= ?', f.from);
    if (f.to) add$('shipped_at <= ?', f.to);
    if (f.result === 'ok') conds.push('ok = true');
    if (f.result === 'failed') conds.push('ok = false');
    if (f.courier) add$('courier = ?', f.courier);
    if (f.payment) add$('payment = ?', f.payment);
    if (f.q) add$("(order_no ilike ? or customer ilike ? or awb ilike ? or pincode ilike ?)", '%' + f.q + '%');
    const where = conds.length ? 'where ' + conds.join(' and ') : '';
    const total = Number((await pool.query(`select count(*) as n from shipments ${where}`, params)).rows[0].n);
    const lim = limit == null ? '' : ` limit ${Number(limit)} offset ${Number(offset)}`;
    const rows = (await pool.query(`select * from shipments ${where} order by shipped_at desc, id desc${lim}`, params)).rows.map(fromDb);
    const couriers = (await pool.query("select distinct courier from shipments where courier is not null order by courier")).rows.map((r) => r.courier);
    return { rows, total, couriers };
  }
  let all = readFile();
  const couriers = [...new Set(all.map((r) => r.courier).filter(Boolean))].sort();
  const q = (f.q || '').toLowerCase();
  all = all.filter((r) =>
    (!f.from || r.shippedAt >= f.from) && (!f.to || r.shippedAt <= f.to) &&
    (f.result !== 'ok' || r.ok) && (f.result !== 'failed' || !r.ok) &&
    (!f.courier || r.courier === f.courier) && (!f.payment || r.payment === f.payment) &&
    (!q || [r.orderNo, r.customer, r.awb, r.pincode].join(' ').toLowerCase().includes(q)));
  all.sort((a, b) => (a.shippedAt < b.shippedAt ? 1 : -1));
  return { rows: limit == null ? all : all.slice(offset, offset + limit), total: all.length, couriers };
}

module.exports = { init, add, list, storage };
