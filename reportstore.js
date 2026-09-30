// Persisted daily-funnel snapshots, so the Daily report page reads instantly instead of recomputing on
// every visit. Postgres when DATABASE_URL is set (Railway, shared with shipping history), otherwise a
// local JSON file. Same storage pattern as history.js.
const fs = require('fs');
const path = require('path');
const { STAGES } = require('./report.js');

let pool = null;
const FILE = process.env.REPORT_FILE || path.join(__dirname, 'data', 'report.json');

async function init(injectedPool) {
  if (injectedPool) pool = injectedPool;
  else if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
  }
  if (pool) {
    await pool.query(`create table if not exists report_days (
      day date primary key,
      total integer not null,
      not_booked integer not null default 0,
      pending_pickup integer not null default 0,
      in_transit integer not null default 0,
      delivered integer not null default 0,
      rto integer not null default 0,
      orders jsonb not null default '[]',
      updated_at timestamptz not null default now())`);
    await pool.query("alter table report_days add column if not exists orders jsonb not null default '[]'");
  }
}
const storage = () => (pool ? 'database' : 'file');
const readFile = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; } }; // day -> row

const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
function fromRow(row) {
  const base = { day: typeof row.day === 'string' ? row.day : row.day.toISOString().slice(0, 10), total: Number(row.total), orders: row.orders || [] };
  for (const s of STAGES) base[s] = Number(row[snake(s)]);
  return base;
}

async function upsert(rows) {
  if (!rows.length) return;
  if (pool) {
    const values = [], params = [];
    rows.forEach((r, i) => {
      const b = i * 8;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},now())`);
      params.push(r.day, r.total, r.notBooked, r.pendingPickup, r.inTransit, r.delivered, r.rto, JSON.stringify(r.orders || []));
    });
    await pool.query(
      `insert into report_days (day, total, not_booked, pending_pickup, in_transit, delivered, rto, orders, updated_at) values ${values.join(',')}
       on conflict (day) do update set total=excluded.total, not_booked=excluded.not_booked, pending_pickup=excluded.pending_pickup,
         in_transit=excluded.in_transit, delivered=excluded.delivered, rto=excluded.rto, orders=excluded.orders, updated_at=now()`,
      params);
  } else {
    const all = readFile();
    for (const r of rows) all[r.day] = { day: r.day, total: r.total, notBooked: r.notBooked, pendingPickup: r.pendingPickup, inTransit: r.inTransit, delivered: r.delivered, rto: r.rto, orders: r.orders || [] };
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(all));
  }
}

// Returns Map(day -> row) for whichever days in [fromDay, toDay] are already stored.
async function get(fromDay, toDay) {
  const map = new Map();
  if (pool) {
    const r = await pool.query('select * from report_days where day between $1::date and $2::date', [fromDay, toDay]);
    for (const row of r.rows) { const x = fromRow(row); map.set(x.day, x); }
  } else {
    const all = readFile();
    for (const d of Object.keys(all)) if (d >= fromDay && d <= toDay) map.set(d, all[d]);
  }
  return map;
}

module.exports = { init, storage, upsert, get };
