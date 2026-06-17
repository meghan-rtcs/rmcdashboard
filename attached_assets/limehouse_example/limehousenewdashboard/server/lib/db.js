import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "limehouse.sqlite");

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");
  migrate(_db);
  return _db;
}

function migrate(db) {
  db.exec(`
    -- GL entries — the big historical table for income/expense
    CREATE TABLE IF NOT EXISTS gl_entries (
      id INTEGER PRIMARY KEY,
      gl_account_id INTEGER NOT NULL,
      gl_account_name TEXT,
      gl_account_type TEXT,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      transaction_type TEXT,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gl_date ON gl_entries(date);
    CREATE INDEX IF NOT EXISTS idx_gl_acct ON gl_entries(gl_account_id);
    CREATE INDEX IF NOT EXISTS idx_gl_type ON gl_entries(gl_account_type);

    -- GL accounts reference (parent + sub-accounts, flattened)
    CREATE TABLE IF NOT EXISTS gl_accounts (
      id INTEGER PRIMARY KEY,
      account_number TEXT,
      name TEXT,
      type TEXT,
      sub_type TEXT,
      parent_id INTEGER,
      is_active INTEGER DEFAULT 1,
      synced_at TEXT
    );

    -- Cash-basis GL entries scoped to the management Company entity only.
    -- This mirrors the Buildium "Cash Flow Statement" report and is what
    -- the income tiles + YoY chart read from. (gl_entries above is the
    -- accrual all-entities feed used elsewhere.)
    CREATE TABLE IF NOT EXISTS gl_company_cash (
      id INTEGER NOT NULL,
      gl_account_id INTEGER NOT NULL,
      gl_account_name TEXT,
      gl_account_type TEXT,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      transaction_type TEXT,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (id, gl_account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gcc_date ON gl_company_cash(date);
    CREATE INDEX IF NOT EXISTS idx_gcc_type ON gl_company_cash(gl_account_type);

    -- Daily metric snapshots (for YoY + rent collection)
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      date TEXT PRIMARY KEY,
      total_units INTEGER,
      occupied_units INTEGER,
      active_leases INTEGER,
      delinquent_count INTEGER,
      delinquent_total REAL,
      total_expected_rent REAL,
      paid_lease_count INTEGER,
      gross_income_mtd REAL,
      synced_at TEXT
    );

    -- Outstanding balance snapshots (per-lease, for rent collection by day)
    CREATE TABLE IF NOT EXISTS outstanding_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      day_of_month INTEGER NOT NULL,
      lease_id INTEGER NOT NULL,
      total_balance REAL,
      balance_0_30 REAL,
      balance_31_60 REAL,
      balance_61_90 REAL,
      balance_over_90 REAL
    );
    CREATE INDEX IF NOT EXISTS idx_ob_date ON outstanding_snapshots(snapshot_date);

    -- Leases (refreshed each sync)
    CREATE TABLE IF NOT EXISTS leases (
      id INTEGER PRIMARY KEY,
      unit_id INTEGER,
      property_id INTEGER,
      status TEXT,
      type TEXT,
      from_date TEXT,
      to_date TEXT,
      rent REAL,
      is_eviction_pending INTEGER DEFAULT 0,
      synced_at TEXT
    );

    -- Rent schedules (refreshed each sync)
    CREATE TABLE IF NOT EXISTS rent_schedules (
      id INTEGER PRIMARY KEY,
      lease_id INTEGER NOT NULL,
      start_date TEXT,
      end_date TEXT,
      total_amount REAL,
      rent_cycle TEXT,
      synced_at TEXT
    );

    -- Units (refreshed each sync)
    CREATE TABLE IF NOT EXISTS units (
      id INTEGER PRIMARY KEY,
      property_id INTEGER,
      unit_number TEXT,
      building_name TEXT,
      market_rent REAL,
      is_occupied INTEGER,
      is_listed INTEGER,
      synced_at TEXT
    );

    -- Properties (refreshed each sync)
    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY,
      name TEXT,
      is_active INTEGER DEFAULT 1,
      number_units INTEGER,
      synced_at TEXT
    );

    -- Owners (refreshed each sync)
    CREATE TABLE IF NOT EXISTS owners (
      id INTEGER PRIMARY KEY,
      name TEXT,
      is_active INTEGER DEFAULT 1,
      agreement_start TEXT,
      agreement_end TEXT,
      property_ids TEXT,
      synced_at TEXT
    );

    -- Renewal history
    CREATE TABLE IF NOT EXISTS renewal_history (
      id INTEGER PRIMARY KEY,
      lease_id INTEGER,
      status TEXT,
      from_date TEXT,
      to_date TEXT,
      type TEXT,
      rent REAL,
      created_at TEXT,
      synced_at TEXT
    );

    -- Tenants
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      lease_id INTEGER,
      synced_at TEXT
    );

    -- Daily property roster snapshots (one row per active property per UTC day).
    -- Used to compute doors gained/lost by diffing today's roster against the
    -- oldest snapshot in the trailing 12 months. PK on (snapshot_date,
    -- property_id) so re-running the snapshot in the same day is a no-op.
    CREATE TABLE IF NOT EXISTS property_snapshots (
      snapshot_date TEXT NOT NULL,
      property_id INTEGER NOT NULL,
      name TEXT,
      unit_count INTEGER,
      PRIMARY KEY (snapshot_date, property_id)
    );
    CREATE INDEX IF NOT EXISTS idx_property_snapshots_date ON property_snapshots(snapshot_date);

    -- Sync log
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT,
      completed_at TEXT,
      sync_type TEXT,
      status TEXT,
      error_message TEXT,
      records_synced INTEGER DEFAULT 0,
      details TEXT
    );
  `);

  // Idempotent column adds for existing DBs
  const cols = db.prepare("PRAGMA table_info(gl_accounts)").all().map(c => c.name);
  if (!cols.includes("parent_id")) {
    db.exec("ALTER TABLE gl_accounts ADD COLUMN parent_id INTEGER");
  }
}

// ── Helper functions ─────────────────────────────────────────────────────────

export function upsertMany(table, rows, columns) {
  if (!rows.length) return 0;
  const db = getDb();
  const placeholders = columns.map(() => "?").join(", ");
  const cols = columns.join(", ");
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`
  );
  const tx = db.transaction((data) => {
    let count = 0;
    for (const row of data) {
      stmt.run(...columns.map((c) => row[c] ?? null));
      count++;
    }
    return count;
  });
  return tx(rows);
}

export function clearTable(table) {
  getDb().exec(`DELETE FROM ${table}`);
}

// Atomically replace a table's entire contents: deletes existing rows and
// inserts the new ones inside a single transaction, so an interruption can
// never leave the table empty or half-populated.
export function replaceTable(table, rows, columns) {
  const db = getDb();
  const placeholders = columns.map(() => "?").join(", ");
  const cols = columns.join(", ");
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`
  );
  const tx = db.transaction((data) => {
    db.exec(`DELETE FROM ${table}`);
    let count = 0;
    for (const row of data) {
      stmt.run(...columns.map((c) => row[c] ?? null));
      count++;
    }
    return count;
  });
  return tx(rows);
}

export function query(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

export function queryOne(sql, params = []) {
  return getDb().prepare(sql).get(...params);
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}
