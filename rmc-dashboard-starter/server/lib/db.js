// ── SQLite DB for RMC Dashboard ──────────────────────────────────────────────
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "..", "data", "rmc.db");

let db;
export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  migrate();
  return db;
}

function migrate() {
  db.exec(`
    -- Units (from unit_directory + rent_roll)
    CREATE TABLE IF NOT EXISTS units (
      id TEXT PRIMARY KEY,
      property_name TEXT, property_id TEXT,
      unit_name TEXT, address TEXT, city TEXT, state TEXT, zip TEXT,
      bedrooms INTEGER, bathrooms INTEGER, sqft INTEGER,
      market_rent REAL, current_rent REAL,
      rent_status TEXT, occupancy_status TEXT,
      tenant_name TEXT, tenant_id TEXT,
      lease_from TEXT, lease_to TEXT,
      move_in_date TEXT, move_out_date TEXT,
      past_due REAL DEFAULT 0,
      tags TEXT,
      synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_units_status ON units(occupancy_status);
    CREATE INDEX IF NOT EXISTS idx_units_property ON units(property_id);

    -- Delinquency (from delinquency report)
    CREATE TABLE IF NOT EXISTS delinquency (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_name TEXT, property_id TEXT,
      unit TEXT, unit_id TEXT,
      tenant_name TEXT, tenant_id TEXT,
      tenant_status TEXT,
      amount_receivable REAL DEFAULT 0,
      current_amount REAL DEFAULT 0,
      thirty_plus REAL DEFAULT 0,
      sixty_plus REAL DEFAULT 0,
      ninety_plus REAL DEFAULT 0,
      in_collections REAL DEFAULT 0,
      synced_at TEXT
    );

    -- Renewals (from renewal_summary)
    CREATE TABLE IF NOT EXISTS renewals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_name TEXT, property_id TEXT,
      unit TEXT, unit_id TEXT,
      tenant_name TEXT,
      lease_start TEXT, lease_end TEXT,
      renewal_status TEXT,  -- Renewed, Did Not Renew, Month To Month, Pending
      new_lease_start TEXT, new_lease_end TEXT,
      previous_rent REAL, new_rent REAL,
      synced_at TEXT
    );

    -- Showings (from showings report)
    CREATE TABLE IF NOT EXISTS showings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_name TEXT, property_id TEXT,
      unit TEXT, unit_id TEXT,
      showing_date TEXT, showing_time TEXT,
      status TEXT,  -- Completed, Scheduled, Canceled, No Show, etc.
      assigned_user TEXT,
      prospect_name TEXT,
      synced_at TEXT
    );

    -- Applications (from rental_applications)
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_name TEXT, property_id TEXT,
      unit TEXT, unit_id TEXT,
      applicant_name TEXT,
      received_date TEXT,
      status TEXT,  -- New, In Review, Approved, Denied, Converted, etc.
      decision_date TEXT,
      synced_at TEXT
    );

    -- Guest cards / inquiries (from guest_card_inquiries)
    CREATE TABLE IF NOT EXISTS guest_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_name TEXT, property_id TEXT,
      unit TEXT, unit_id TEXT,
      prospect_name TEXT,
      source TEXT,
      status TEXT,
      received_date TEXT,
      assigned_user TEXT,
      synced_at TEXT
    );

    -- Vacancies (from unit_vacancy_detail)
    CREATE TABLE IF NOT EXISTS vacancies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_name TEXT, property_id TEXT,
      unit TEXT, unit_id TEXT,
      available_date TEXT,
      days_vacant INTEGER DEFAULT 0,
      market_rent REAL,
      advertised_rent REAL,
      status TEXT,
      synced_at TEXT
    );

    -- Work orders (from work_order report)
    CREATE TABLE IF NOT EXISTS work_orders (
      id TEXT PRIMARY KEY,
      property_name TEXT, property_id TEXT,
      unit TEXT, unit_id TEXT,
      description TEXT,
      status TEXT,
      priority TEXT,
      work_order_type TEXT,
      assigned_user TEXT,
      vendor_name TEXT,
      created_date TEXT, scheduled_date TEXT, completed_date TEXT,
      total_cost REAL DEFAULT 0,
      synced_at TEXT
    );

    -- Income statement rows (from income_statement or cash_flow)
    CREATE TABLE IF NOT EXISTS income_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_name TEXT,
      account_number TEXT,
      month_to_date REAL DEFAULT 0,
      year_to_date REAL DEFAULT 0,
      last_year_to_date REAL DEFAULT 0,
      report_month TEXT,  -- YYYY-MM
      synced_at TEXT
    );

    -- Owners (from owner_directory)
    CREATE TABLE IF NOT EXISTS owners (
      id TEXT PRIMARY KEY,
      owner_name TEXT,
      email TEXT, phone TEXT,
      property_count INTEGER DEFAULT 0,
      status TEXT,
      synced_at TEXT
    );

    -- Vendors (from vendor_directory)
    CREATE TABLE IF NOT EXISTS vendors (
      id TEXT PRIMARY KEY,
      vendor_name TEXT,
      vendor_type TEXT,
      workers_comp_expires TEXT,
      liability_expires TEXT,
      status TEXT,
      synced_at TEXT
    );

    -- Properties (from property_directory)
    CREATE TABLE IF NOT EXISTS properties (
      id TEXT PRIMARY KEY,
      property_name TEXT,
      address TEXT, city TEXT, state TEXT, zip TEXT,
      unit_count INTEGER DEFAULT 0,
      property_type TEXT,
      synced_at TEXT
    );

    -- Security deposits (from security_deposit_funds_detail)
    CREATE TABLE IF NOT EXISTS security_deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_name TEXT, property_id TEXT,
      unit TEXT, unit_id TEXT,
      tenant_name TEXT, tenant_id TEXT,
      deposit_held REAL DEFAULT 0,
      synced_at TEXT
    );

    -- Sync log
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT,
      completed_at TEXT,
      status TEXT,
      records INTEGER DEFAULT 0,
      errors TEXT,
      duration_ms INTEGER
    );

    -- Monthly snapshots for trend data
    CREATE TABLE IF NOT EXISTS monthly_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT,  -- YYYY-MM
      metric TEXT,
      value REAL,
      created_at TEXT
    );
  `);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function query(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

export function queryOne(sql, params = []) {
  return getDb().prepare(sql).get(...params);
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

export function clearTable(table) {
  getDb().exec(`DELETE FROM ${table}`);
}

export function upsertMany(table, rows, cols) {
  if (!rows.length) return;
  const placeholders = cols.map(() => "?").join(",");
  const stmt = getDb().prepare(
    `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`
  );
  const tx = getDb().transaction(() => {
    for (const row of rows) {
      stmt.run(...cols.map(c => row[c] ?? null));
    }
  });
  tx();
}
