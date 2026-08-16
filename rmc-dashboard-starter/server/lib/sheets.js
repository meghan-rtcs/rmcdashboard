// ── Google Sheet: Other Billable Hours Log ──────────────────────────────────
// Reads the shared "RMC - Other Billable Hours Log" sheet through Replit's
// Google Sheets connection (OAuth handled by the platform — no keys in code).
// Only rows with an "Approved By" value count toward billable-hours
// utilization; every row is stored so the dashboard can show an audit view of
// pending vs approved hours. Sync failures are recorded in app_state and
// surfaced in the UI rather than failing silently.
import { ReplitConnectors } from "@replit/connectors-sdk";
import { getDb, clearTable, run, queryOne } from "./db.js";

const SPREADSHEET_ID = "15xXB5YQTWUTKQYIFphI872akCHNALljn6-QupzuI0Sw";
const RANGE = "'Entry Log'!A2:K2000"; // header on row 1

function toIso(d) {
  // Sheet dates are MM/DD/YYYY
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(d || "").trim());
  if (!m) return "";
  return m[3] + "-" + m[1].padStart(2, "0") + "-" + m[2].padStart(2, "0");
}

function setState(key, value) {
  run("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(value)]);
}

export function getSheetSyncStatus() {
  try {
    const row = queryOne("SELECT value FROM app_state WHERE key = 'sheet_sync'");
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}

export async function syncSheetHours() {
  getDb();
  try {
    const connectors = new ReplitConnectors();
    const res = await connectors.proxy("google-sheet",
      `/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(RANGE)}`, { method: "GET" });
    if (!res.ok) throw new Error("Sheets API HTTP " + res.status);
    const data = await res.json();
    const values = data.values || [];
    const synced_at = new Date().toISOString();
    const rows = [];
    values.forEach((v, i) => {
      const [date, employee, _start, _end, hours, description, propertyUnit, approvedBy, approvedDate, quarter, notes] = v;
      const iso = toIso(date);
      if (!iso || !employee) return; // blank/incomplete row
      if (/example row/i.test(description || "")) return; // template example row
      rows.push({
        row_number: i + 2, // A2 offset
        work_date: iso,
        employee: String(employee).trim(),
        hours: parseFloat(hours) || 0,
        description: description || "",
        property_unit: propertyUnit || "",
        approved_by: (approvedBy || "").trim(),
        approved_date: toIso(approvedDate),
        quarter: quarter || "",
        notes: notes || "",
        synced_at,
      });
    });
    const dbi = getDb();
    const tx = dbi.transaction(() => {
      clearTable("sheet_billable_hours");
      const ins = dbi.prepare(
        `INSERT INTO sheet_billable_hours (row_number, work_date, employee, hours, description, property_unit, approved_by, approved_date, quarter, notes, synced_at)
         VALUES (@row_number, @work_date, @employee, @hours, @description, @property_unit, @approved_by, @approved_date, @quarter, @notes, @synced_at)`);
      for (const r of rows) ins.run(r);
    });
    tx();
    const approved = rows.filter((r) => r.approved_by);
    const status = {
      ok: true, at: synced_at, error: null,
      rows: rows.length,
      approvedRows: approved.length,
      approvedHours: Math.round(approved.reduce((s, r) => s + r.hours, 0) * 100) / 100,
      pendingHours: Math.round(rows.filter((r) => !r.approved_by).reduce((s, r) => s + r.hours, 0) * 100) / 100,
    };
    setState("sheet_sync", status);
    console.log(`[sheets] Other billable hours: ${rows.length} rows (${approved.length} approved)`);
    return status;
  } catch (e) {
    // Record the failure but keep the last-known-good rows in the table.
    const prev = getSheetSyncStatus() || {};
    const status = { ...prev, ok: false, error: e.message, failedAt: new Date().toISOString() };
    setState("sheet_sync", status);
    console.error("[sheets] Sync failed:", e.message);
    return status;
  }
}
