// ── LeadSimple data sync ─────────────────────────────────────────────────────
// Syncs tasks (upcoming + completed) and processes into SQLite.
// Called from the main sync.js module.

import { leadsimple } from "./leadsimple.js";
import { getDb, upsertMany, clearTable, query } from "./db.js";

const TS = () => new Date().toISOString();

function safe(promise, fallback) {
  return promise.catch((err) => {
    console.warn("[ls-sync] non-fatal:", err.message);
    return fallback;
  });
}

// ── DB Schema (call once at startup) ────────────────────────────────────────
export function migrateLeadSimple() {
  const db = getDb();
  db.exec(`
    -- LeadSimple tasks
    CREATE TABLE IF NOT EXISTS ls_tasks (
      id TEXT PRIMARY KEY,
      kind TEXT,
      description TEXT,
      due_at TEXT,
      completed_at TEXT,
      skipped INTEGER DEFAULT 0,
      auto_send INTEGER DEFAULT 0,
      assignee_id TEXT,
      assignee_name TEXT,
      assignee_email TEXT,
      step_kind TEXT,
      step_description TEXT,
      step_delay_minutes INTEGER,
      process_id TEXT,
      process_type_id TEXT,
      process_type_name TEXT,
      process_name TEXT,
      process_stage TEXT,
      deal_id TEXT,
      deal_name TEXT,
      deal_pipeline TEXT,
      deal_stage TEXT,
      created_at TEXT,
      updated_at TEXT,
      synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ls_tasks_assignee ON ls_tasks(assignee_email);
    CREATE INDEX IF NOT EXISTS idx_ls_tasks_process_type ON ls_tasks(process_type_id);
    CREATE INDEX IF NOT EXISTS idx_ls_tasks_due ON ls_tasks(due_at);
    CREATE INDEX IF NOT EXISTS idx_ls_tasks_completed ON ls_tasks(completed_at);

    -- LeadSimple processes
    CREATE TABLE IF NOT EXISTS ls_processes (
      id TEXT PRIMARY KEY,
      name TEXT,
      stage_id TEXT,
      stage_name TEXT,
      stage_status TEXT,
      process_type_id TEXT,
      process_type_name TEXT,
      assignee_id TEXT,
      assignee_name TEXT,
      assignee_email TEXT,
      due_at TEXT,
      closed_at TEXT,
      time_to_close INTEGER,
      created_at TEXT,
      updated_at TEXT,
      synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ls_proc_type ON ls_processes(process_type_id);
    CREATE INDEX IF NOT EXISTS idx_ls_proc_stage ON ls_processes(stage_status);

    -- LeadSimple process types (reference)
    CREATE TABLE IF NOT EXISTS ls_process_types (
      id TEXT PRIMARY KEY,
      name TEXT,
      synced_at TEXT
    );

    -- LeadSimple users (reference for role mapping)
    CREATE TABLE IF NOT EXISTS ls_users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      role TEXT,
      synced_at TEXT
    );
  `);
}

// ── Role mapping ────────────────────────────────────────────────────────────
// Maps LeadSimple user emails to KPI roles.
// Update this when staff changes.
const ROLE_MAP = {
  "assistant@limehousepm.com": "Administrative Assistant",
  "dana@limehousepm.com": "Portfolio Manager",
  "addison@limehousepm.com": "Assistant Property Manager",
};

// Process type IDs for KPI-relevant workflows
export const PROCESS_TYPES = {
  APPLICATIONS:  "4785085c-d08b-4958-b32c-8d28b43ee020", // 05 Applications Process
  MOVE_IN:       "004d2402-f868-421d-b0de-4592c1083922", // 06 Move In Process
  RENEWAL:       "73a864ab-484c-405d-9def-5401a5134591", // 07 Lease Renewal Process
  DELINQUENCY:   "89e673a3-babe-4b11-8b9d-755af579c3d8", // 08 Delinquency Process
  INSPECTIONS:   "2ef33b63-6cc0-40bc-9176-c2209fdf39ef", // 09 Inspections Process
  MAKE_READY:    "94a6ca5f-8b94-4ac7-b689-a479f4870e59", // 03 Make Ready Process
  MARKETING:     "b8241168-fd3c-46fe-ae44-4f242beab643", // 04 Marketing Process
};

// ── Sync functions ──────────────────────────────────────────────────────────

const TASK_COLS = [
  "id", "kind", "description", "due_at", "completed_at", "skipped",
  "auto_send", "assignee_id", "assignee_name", "assignee_email",
  "step_kind", "step_description", "step_delay_minutes",
  "process_id", "process_type_id", "process_type_name", "process_name",
  "process_stage", "deal_id", "deal_name", "deal_pipeline", "deal_stage",
  "created_at", "updated_at", "synced_at",
];

function flattenTask(t) {
  return {
    id: t.id,
    kind: t.kind || null,
    description: t.description || null,
    due_at: t.due_at || null,
    completed_at: t.completed_at || null,
    skipped: t.skipped ? 1 : 0,
    auto_send: t.auto_send ? 1 : 0,
    assignee_id: t.assignee?.id || null,
    assignee_name: t.assignee?.name || null,
    assignee_email: t.assignee?.email || null,
    step_kind: t.step?.kind || null,
    step_description: t.step?.description || null,
    step_delay_minutes: t.step?.delay_minutes != null ? Number(t.step.delay_minutes) : null,
    process_id: t.process?.id || null,
    process_type_id: t.process?.process_type?.id || t.process?.process_type_id || null,
    process_type_name: t.process?.process_type?.name || null,
    process_name: t.process?.name || null,
    process_stage: t.process?.stage?.name || null,
    deal_id: t.deal?.id || null,
    deal_name: t.deal?.name || null,
    deal_pipeline: t.deal?.pipeline?.name || null,
    deal_stage: t.deal?.stage?.name || null,
    created_at: t.created_at || null,
    updated_at: t.updated_at || null,
    synced_at: TS(),
  };
}

const PROCESS_COLS = [
  "id", "name", "stage_id", "stage_name", "stage_status",
  "process_type_id", "process_type_name",
  "assignee_id", "assignee_name", "assignee_email",
  "due_at", "closed_at", "time_to_close",
  "created_at", "updated_at", "synced_at",
];

function flattenProcess(p) {
  // assignee_roles can be an array; pick first user-type role
  const assignee = p.user || null;
  return {
    id: p.id,
    name: p.name || null,
    stage_id: p.stage?.id || null,
    stage_name: p.stage?.name || null,
    stage_status: p.stage?.status || null,
    process_type_id: p.process_type?.id || p.process_type_id || null,
    process_type_name: p.process_type?.name || null,
    assignee_id: assignee?.id || null,
    assignee_name: assignee?.name || null,
    assignee_email: assignee?.email || null,
    due_at: p.due_at || null,
    closed_at: p.closed_at || null,
    time_to_close: p.time_to_close || null,
    created_at: p.created_at || null,
    updated_at: p.updated_at || null,
    synced_at: TS(),
  };
}

export async function syncLeadSimple() {
  const now = TS();
  console.log("[ls-sync] Starting LeadSimple sync...");
  const errors = [];
  let totalRecords = 0;

  // 1. Process types (reference table)
  try {
    const types = await leadsimple.listProcessTypes();
    const ptArr = Array.isArray(types) ? types : (types?.data || []);
    clearTable("ls_process_types");
    upsertMany("ls_process_types", ptArr.map(pt => ({
      id: pt.id, name: pt.name, synced_at: now,
    })), ["id", "name", "synced_at"]);
    totalRecords += ptArr.length;
    console.log(`[ls-sync] Process types: ${ptArr.length}`);
  } catch (err) {
    console.error("[ls-sync] Process types error:", err.message);
    errors.push(`process_types: ${err.message}`);
  }

  // 2. Users (with role mapping)
  try {
    const users = await leadsimple.listUsers();
    const userArr = Array.isArray(users) ? users : (users?.data || []);
    clearTable("ls_users");
    upsertMany("ls_users", userArr.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: ROLE_MAP[u.email] || null,
      synced_at: now,
    })), ["id", "name", "email", "role", "synced_at"]);
    totalRecords += userArr.length;
    console.log(`[ls-sync] Users: ${userArr.length}`);
  } catch (err) {
    console.error("[ls-sync] Users error:", err.message);
    errors.push(`users: ${err.message}`);
  }

  // 3. Tasks -- pull both upcoming and completed
  try {
    const [upcoming, completed] = await Promise.all([
      safe(leadsimple.listTasks("upcoming"), []),
      safe(leadsimple.listTasks("completed"), []),
    ]);
    const upArr = Array.isArray(upcoming) ? upcoming : (upcoming?.data || []);
    const compArr = Array.isArray(completed) ? completed : (completed?.data || []);
    const allTasks = [...upArr, ...compArr];

    // Deduplicate by id (in case a task appears in both)
    const seen = new Set();
    const unique = allTasks.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    clearTable("ls_tasks");
    const rows = unique.map(flattenTask);
    upsertMany("ls_tasks", rows, TASK_COLS);
    totalRecords += rows.length;
    console.log(`[ls-sync] Tasks: ${rows.length} (${upArr.length} upcoming, ${compArr.length} completed)`);
  } catch (err) {
    console.error("[ls-sync] Tasks error:", err.message);
    errors.push(`tasks: ${err.message}`);
  }

  // 4. Processes -- pull for each KPI-relevant process type
  try {
    let procTotal = 0;
    clearTable("ls_processes");
    for (const [label, ptId] of Object.entries(PROCESS_TYPES)) {
      const procs = await safe(leadsimple.listProcesses(ptId), []);
      const arr = Array.isArray(procs) ? procs : (procs?.data || []);
      const rows = arr.map(flattenProcess);
      if (rows.length) {
        upsertMany("ls_processes", rows, PROCESS_COLS);
      }
      procTotal += rows.length;
      console.log(`[ls-sync]   ${label}: ${rows.length} processes`);
    }
    totalRecords += procTotal;
    console.log(`[ls-sync] Processes total: ${procTotal}`);
  } catch (err) {
    console.error("[ls-sync] Processes error:", err.message);
    errors.push(`processes: ${err.message}`);
  }

  console.log(`[ls-sync] Done. ${totalRecords} records, ${errors.length} errors.`);
  return { ok: errors.length === 0, errors, totalRecords };
}
