// ── SQLite DB for RMC Dashboard ──────────────────────────────────────────────
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Tests may point SQLite at an isolated temporary file; production continues
// to use the persistent dashboard data path.
const DB_PATH = process.env.RMC_DB_PATH || path.join(__dirname, "..", "..", "data", "rmc.db");

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

    -- Per-charge receivables (from aged_receivables_detail) — lets delinquency
    -- be split by charge type (rent vs utilities vs other).
    CREATE TABLE IF NOT EXISTS receivable_charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_name TEXT, property_id TEXT,
      unit_name TEXT, unit_id TEXT,
      payer_name TEXT, occupancy_id TEXT,
      account_name TEXT,
      charge_category TEXT,
      posting_date TEXT,
      amount_receivable REAL DEFAULT 0,
      thirty_plus REAL DEFAULT 0,
      sixty_plus REAL DEFAULT 0,
      ninety_plus REAL DEFAULT 0,
      synced_at TEXT
    );

    -- Owner insurance policies (from owner_insurance report). AppFolio is
    -- phasing out the property-page expiration date, so this report is the
    -- source of truth for property/owner insurance compliance.
    CREATE TABLE IF NOT EXISTS owner_insurance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT, policy_number TEXT,
      properties TEXT, owners TEXT,
      start_date TEXT, expiration_date TEXT,
      type TEXT, additionally_insured TEXT,
      synced_at TEXT
    );

    -- Lease history (from lease_history report, ~2yr window) — used for
    -- turnover-to-re-lease vacancy gap KPI on the Team Performance tab.
    CREATE TABLE IF NOT EXISTS lease_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_name TEXT, property_id TEXT,
      unit_name TEXT, unit_id TEXT,
      tenant_name TEXT, status TEXT, renewal TEXT,
      lease_start TEXT, lease_end TEXT,
      move_in TEXT, move_out TEXT,
      synced_at TEXT
    );

    -- Inspections (from inspection_detail report) — Building Walkthroughs
    -- feed the Team Performance inspection KPI.
    CREATE TABLE IF NOT EXISTS inspections (
      inspection_id TEXT PRIMARY KEY,
      inspection_name TEXT,
      property_name TEXT, property_id TEXT,
      unit TEXT, unit_id TEXT,
      status TEXT,
      inspected_on TEXT, marked_done_on TEXT, marked_done_by TEXT,
      created_on TEXT,
      synced_at TEXT
    );

    -- Team Performance: KPI definitions (editable config, not hardcoded)
    CREATE TABLE IF NOT EXISTS kpi_config (
      id TEXT PRIMARY KEY,
      department TEXT,
      label TEXT, description TEXT,
      scope TEXT,               -- 'department' | 'individual'
      assigned_to TEXT,         -- employee id for individual scope
      data_source TEXT,
      direction TEXT,           -- 'higher_is_better' | 'lower_is_better'
      unit TEXT,                -- 'percent' | 'days' | 'count' | 'currency'
      tiers TEXT,               -- JSON {good:{threshold,payout},better:{...},best:{...}} (thresholds may be null = not configured)
      active INTEGER DEFAULT 1,
      effective_quarter TEXT,
      sort INTEGER DEFAULT 0
    );

    -- Team Performance: employee roster with department weight allocations
    CREATE TABLE IF NOT EXISTS kpi_roster (
      id TEXT PRIMARY KEY,
      name TEXT, role TEXT,
      allocations TEXT,         -- JSON {"Property Management":1,"Maintenance":0.5,...}
      active INTEGER DEFAULT 1,
      sort INTEGER DEFAULT 0
    );

    -- Team Performance: locked quarter snapshots (bonuses already paid must
    -- not change when AppFolio data is edited retroactively)
    CREATE TABLE IF NOT EXISTS quarter_results (
      quarter TEXT PRIMARY KEY, -- e.g. '2026-Q3'
      payload TEXT,             -- JSON of full computed team performance
      snapshot_at TEXT
    );

    -- Team Performance: per-employee per-quarter scheduled-hours overrides
    CREATE TABLE IF NOT EXISTS team_overrides (
      quarter TEXT NOT NULL,
      employee TEXT NOT NULL,
      scheduled_hours REAL,
      PRIMARY KEY (quarter, employee)
    );

    -- Other billable hours from the shared Google Sheet ("Entry Log" tab).
    -- Only rows with an Approved By value count toward utilization; all rows
    -- are stored so the dashboard can show a pending/approved audit view.
    CREATE TABLE IF NOT EXISTS sheet_billable_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      row_number INTEGER,       -- sheet row (for auditability)
      work_date TEXT,           -- YYYY-MM-DD
      employee TEXT,
      hours REAL DEFAULT 0,
      description TEXT,
      property_unit TEXT,
      approved_by TEXT,
      approved_date TEXT,
      quarter TEXT,             -- as written in the sheet, e.g. 'Q3 2026'
      notes TEXT,
      synced_at TEXT
    );

    -- Small key/value store for app state (e.g. sheet sync status)
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
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
      group_labels TEXT,
      synced_at TEXT
    );

    -- Groups are discovered only from fields returned by AppFolio's verified
    -- property_directory report. No group endpoint is guessed or invented.
    CREATE TABLE IF NOT EXISTS property_groups (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      source_field TEXT NOT NULL,
      synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS property_group_members (
      group_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      PRIMARY KEY (group_id, property_id)
    );
    CREATE INDEX IF NOT EXISTS idx_property_group_members_property ON property_group_members(property_id);

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

    -- Maintenance labor entries (from work_order_labor_summary)
    CREATE TABLE IF NOT EXISTS labor_entries (
      id TEXT PRIMARY KEY,
      work_date TEXT,          -- YYYY-MM-DD
      tech TEXT,
      property_name TEXT, unit TEXT,
      worked_hours REAL DEFAULT 0,
      work_order_number TEXT,
      work_order_status TEXT,
      description TEXT,
      work_order_id TEXT,
      synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_labor_date ON labor_entries(work_date);
    CREATE INDEX IF NOT EXISTS idx_labor_tech ON labor_entries(tech);

    -- Manual monthly adjustments per tech: PTO/sick + billable hours worked
    -- outside AppFolio (special projects). Keyed by month + tech.
    CREATE TABLE IF NOT EXISTS labor_adjustments (
      period TEXT NOT NULL,    -- YYYY-MM
      tech TEXT NOT NULL,
      pto_hours REAL DEFAULT 0,
      extra_hours REAL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (period, tech)
    );

    -- Tenant insurance (from tenant_directory)
    CREATE TABLE IF NOT EXISTS tenant_insurance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_name TEXT,
      property_name TEXT, unit TEXT,
      tenant_type TEXT,           -- e.g. Commercial / Residential
      commercial_lease_type TEXT,
      status TEXT,
      insurance_company TEXT,
      policy_number TEXT,
      insurance_expiration TEXT,  -- YYYY-MM-DD
      synced_at TEXT
    );

    -- Owner-editable program settings and owner-only discretionary reviews.
    CREATE TABLE IF NOT EXISTS team_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discretionary_reviews (
      quarter TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      answers TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (quarter, employee_id)
    );
  `);

  // Additive columns on existing tables (ignore "duplicate column" errors).
  const addCol = (table, col, type) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {}
  };
  addCol("vendors", "auto_ins_expires", "TEXT");
  addCol("vendors", "epa_cert_expires", "TEXT");
  addCol("vendors", "state_lic_expires", "TEXT");
  addCol("properties", "insurance_expiration", "TEXT");
  addCol("properties", "owners", "TEXT");
  addCol("properties", "group_labels", "TEXT");
  addCol("vendors", "custom_fields", "TEXT");
  addCol("units", "rentable", "TEXT");
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
