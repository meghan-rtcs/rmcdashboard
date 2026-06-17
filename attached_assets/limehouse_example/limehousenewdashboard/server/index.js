import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { getDb, query as dbQuery } from "./lib/db.js";
import { syncAll, testGL } from "./lib/sync.js";
import { buildDashboard } from "./lib/aggregator.js";
import { startScheduler, runSync, runLeadSimpleSync, setPostSyncHook } from "./lib/scheduler.js";
import { buildium } from "./lib/buildium.js";
import { getBundle, warmBundle } from "./lib/bundle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.join(__dirname, "..", "Limehouse Revamp");
const PORT = Number(process.env.PORT || 5000);

// Initialize database on startup
getDb();
import { migrateLeadSimple } from "./lib/ls-sync.js";
migrateLeadSimple();

const app = express();
app.disable("etag");
app.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
app.use(express.json());

// ── Dashboard data ───────────────────────────────────────────────────────────
let cachedPayload = null;
let cachedAt = null;
let building = false;
let rebuildPending = false;

async function refreshDashboard() {
  // If a build is already running, mark that another rebuild is needed and
  // return. The in-flight build will re-run once on completion so a refresh
  // requested mid-build (e.g. two scheduled syncs finishing back-to-back) still
  // picks up the latest DB state instead of being silently dropped.
  if (building) {
    rebuildPending = true;
    return;
  }
  building = true;
  try {
    do {
      rebuildPending = false;
      cachedPayload = await buildDashboard();
      cachedAt = Date.now();
      console.log(`[server] Dashboard built at ${new Date(cachedAt).toISOString()}`);
    } while (rebuildPending);
  } catch (err) {
    console.error("[server] Dashboard build error:", err);
  } finally {
    building = false;
  }
}

// Let scheduled syncs (Buildium + overnight LeadSimple) rebuild the served
// dashboard cache once their DB writes complete.
setPostSyncHook(refreshDashboard);

app.get("/api/dashboard", async (req, res) => {
  if (!cachedPayload) {
    // Try to build from DB data if available
    try {
      await refreshDashboard();
    } catch (e) { /* ignore */ }
  }
  if (!cachedPayload) {
    res.status(503).json({ error: "Data not yet loaded. Run a sync first.", fetching: building });
    return;
  }
  res.json({
    ...cachedPayload,
    sync: { fetchedAt: cachedAt, isStale: cachedAt ? Date.now() - cachedAt > 600000 : true },
  });
});

// ── Sync trigger ─────────────────────────────────────────────────────────────
app.post("/api/sync", async (req, res) => {
  try {
    const result = await syncAll("manual");
    // Rebuild dashboard after sync
    await refreshDashboard();
    res.json({ ok: result.ok, errors: result.errors, records: result.totalRecords });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── LeadSimple sync (slow / rate-limited; runs in background) ─────────────────
// Kicks off the LeadSimple pull without blocking the request. The pull paces
// itself around LeadSimple's per-window record rate limit (can take several
// minutes), persists to SQLite, and the dashboard reads the last snapshot.
app.post("/api/sync-leadsimple", (req, res) => {
  runLeadSimpleSync(); // fire-and-forget; guarded against concurrent runs
  res.json({ ok: true, started: true, note: "LeadSimple sync started in background; this can take several minutes due to rate limits." });
});

app.get("/api/leadsimple-status", (req, res) => {
  try {
    const tasks = dbQuery("SELECT COUNT(*) AS total, SUM(completed_at IS NOT NULL) AS completed FROM ls_tasks")[0] || {};
    const processes = dbQuery("SELECT COUNT(*) AS c FROM ls_processes")[0]?.c || 0;
    const lastSynced = dbQuery("SELECT MAX(synced_at) AS at FROM ls_tasks")[0]?.at || null;
    res.json({ tasks: tasks.total || 0, completedTasks: tasks.completed || 0, processes, lastSynced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sync status ──────────────────────────────────────────────────────────────
app.get("/api/sync-status", (req, res) => {
  try {
    const lastSync = dbQuery("SELECT * FROM sync_log ORDER BY id DESC LIMIT 1")[0];
    const entryCount = dbQuery("SELECT COUNT(*) as c FROM gl_entries")[0]?.c || 0;
    const unitCount = dbQuery("SELECT COUNT(*) as c FROM units")[0]?.c || 0;
    res.json({ lastSync, glEntries: entryCount, units: unitCount, dashboardCachedAt: cachedAt, dashboardBuilding: building });
  } catch (err) {
    res.json({ error: err.message, dashboardCachedAt: cachedAt, dashboardBuilding: building });
  }
});

// ── GL Test Endpoint (Option A: GL Report) ───────────────────────────────────
// Run this once to check whether income amounts are positive or negative.
// Look at the "accountType: Income" entries and check if TotalAmount/sampleEntries
// amounts are positive or negative. This determines the NEGATE_INCOME flag.
app.get("/api/test-gl", async (req, res) => {
  try {
    const result = await testGL();
    res.json({
      instruction: "Look at entries where accountType = 'Income'. If amounts are NEGATIVE, keep NEGATE_INCOME = true in aggregator.js. If POSITIVE, set it to false.",
      data: result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sync log ─────────────────────────────────────────────────────────────────
app.get("/api/sync-log", (req, res) => {
  try { res.json(dbQuery("SELECT * FROM sync_log ORDER BY id DESC LIMIT 20")); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Debug: Buildium users + roles ────────────────────────────────────────────
function esc(s) {
  if (s === null || s === undefined || s === "") return "—";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

app.get("/debug/buildium-users", async (req, res) => {
  try {
    const [roles, users] = await Promise.all([
      buildium.listUserRoles(),
      buildium.listUsers(),
    ]);

    // Build role lookup
    const roleById = new Map();
    for (const r of roles) {
      const id = pick(r, "Id", "id");
      if (id !== undefined) roleById.set(id, r);
    }

    // Filter to staff users
    const isStaff = (u) => {
      const t = pick(u, "UserTypes", "userTypes", "UserType", "userType");
      if (!t) return false;
      const arr = Array.isArray(t) ? t : [t];
      return arr.some((x) => String(x).toLowerCase().includes("staff"));
    };
    const staffList = users.filter(isStaff);

    // The /v1/users list endpoint does NOT include role assignments.
    // Hydrate each staff user with /v1/users/{id} which returns UserRole.
    async function hydrate(u) {
      try {
        const d = await buildium.raw(`/users/${u.Id}`);
        return { ...u, ...d };
      } catch (e) {
        return { ...u, _hydrateError: e.message };
      }
    }
    const CONCURRENCY = 5;
    const staff = [];
    for (let i = 0; i < staffList.length; i += CONCURRENCY) {
      const batch = await Promise.all(staffList.slice(i, i + CONCURRENCY).map(hydrate));
      staff.push(...batch);
    }

    // Count users per role (using hydrated UserRole)
    const userCountByRole = new Map();
    for (const u of staff) {
      const roleId = u.UserRole?.Id;
      if (roleId !== undefined && roleId !== null) {
        userCountByRole.set(roleId, (userCountByRole.get(roleId) || 0) + 1);
      }
    }

    // ── Roles table
    const rolesRows = roles.map((r) => {
      const id = pick(r, "Id", "id");
      const name = pick(r, "Name", "name");
      const desc = pick(r, "Description", "description");
      return `<tr>
        <td>${esc(id)}</td>
        <td>${esc(name)}</td>
        <td>${esc(desc)}</td>
        <td style="text-align:right">${userCountByRole.get(id) || 0}</td>
      </tr>`;
    }).join("");

    // ── Staff users table
    const staffRows = staff.map((u) => {
      const id = pick(u, "Id", "id");
      const first = pick(u, "FirstName", "firstName") || "";
      const last = pick(u, "LastName", "lastName") || "";
      const full = pick(u, "FullName", "fullName") || `${first} ${last}`.trim();
      const email = pick(u, "Email", "email");
      const types = pick(u, "UserTypes", "userTypes", "UserType", "userType");
      const typesStr = Array.isArray(types) ? types.join(", ") : (types || "");
      const roleId = u.UserRole?.Id;
      const roleName = u.UserRole?.Name || roleById.get(roleId)?.Name || "";
      const lastLogin = pick(u, "LastLogin", "LastLoginDateTime", "lastLoginDateTime");
      return `<tr>
        <td>${esc(id)}</td>
        <td>${esc(full)}</td>
        <td>${esc(email)}</td>
        <td>${esc(typesStr)}</td>
        <td>${esc(roleName)}</td>
        <td>${esc(roleId)}</td>
        <td>${esc(lastLogin)}</td>
      </tr>`;
    }).join("");

    const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Buildium Users & Roles (debug)</title>
<style>
  body { font: 13px/1.4 -apple-system, system-ui, sans-serif; margin: 24px; color: #1c2119; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; }
  .meta { color: #6a766a; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #d8dcd2; padding: 6px 9px; text-align: left; vertical-align: top; }
  th { background: #f4f6f1; font-weight: 600; }
  tr:nth-child(even) td { background: #fafbf8; }
  code { background: #f4f6f1; padding: 1px 5px; border-radius: 3px; }
</style></head><body>
<h1>Buildium Users &amp; Roles — debug</h1>
<div class="meta">
  Pulled live from Buildium API at ${new Date().toISOString()}.
  <code>GET /v1/userroles</code> · <code>GET /v1/users?status=Active</code>
</div>

<h2>Section 1 · User Roles (${roles.length})</h2>
<table>
  <thead><tr><th>Role ID</th><th>Role Name</th><th>Description</th><th style="text-align:right"># of Staff Users</th></tr></thead>
  <tbody>${rolesRows || `<tr><td colspan="4">No roles returned</td></tr>`}</tbody>
</table>

<h2>Section 2 · Active Staff Users (${staff.length} of ${users.length} active users)</h2>
<table>
  <thead><tr><th>User ID</th><th>Name</th><th>Email</th><th>User Type</th><th>Role Name</th><th>Role ID</th><th>Last Login</th></tr></thead>
  <tbody>${staffRows || `<tr><td colspan="7">No staff users returned</td></tr>`}</tbody>
</table>

</body></html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    res.status(500).send(`<pre style="color:#b00;font:13px/1.4 monospace;padding:20px">Error: ${esc(err.message)}\n\n${esc(err.stack || "")}</pre>`);
  }
});

// ── Precompiled JSX bundle ───────────────────────────────────────────────────
// One ready-to-run JS file compiled server-side (see lib/bundle.js). Replaces
// shipping @babel/standalone + raw .jsx and compiling in the browser on every
// load. Cacheable via ETag so reloads are instant.
app.get("/app-bundle.js", (req, res) => {
  try {
    const { code, etag } = getBundle();
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache"); // revalidate via ETag, don't refetch body
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) { res.status(304).end(); return; }
    res.send(code);
  } catch (err) {
    console.error("[bundle] serve error:", err.message);
    res.status(500).type("application/javascript").send(`console.error(${JSON.stringify("Bundle compile failed: " + err.message)});`);
  }
});

// ── Static files ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(STATIC_ROOT, "Limehouse Dashboard - A.html"));
});
app.use(express.static(STATIC_ROOT, { etag: false, lastModified: false }));

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] Static root: ${STATIC_ROOT}`);

  // Precompile the frontend bundle so the first page load is already warm
  warmBundle();

  // Start the cron scheduler
  startScheduler();

  // Initial sync + dashboard build
  console.log("[server] Starting initial sync...");
  try {
    await syncAll("full");
    await refreshDashboard();
    console.log("[server] Initial sync and dashboard build complete");
  } catch (err) {
    console.error("[server] Initial sync failed:", err.message);
    // Try to build dashboard from whatever data is in DB
    try { await refreshDashboard(); } catch (e) { /* ignore */ }
  }
});
