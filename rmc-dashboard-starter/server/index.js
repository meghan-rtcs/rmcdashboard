import express from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { getDb, query } from "./lib/db.js";
import { syncAll } from "./lib/sync.js";
import { normalizeRange } from "./lib/aggregator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0";

// ── Password protection (cookie session, password only) ───────────────────
// Gates the entire dashboard — static page, API, everything — behind a single
// password supplied via the DASHBOARD_PASSWORD env var. Users sign in on a
// custom /login.html page (password only, no username); success sets an
// HttpOnly session cookie derived from the password, so changing the
// password invalidates all existing sessions.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const SESSION_TOKEN = crypto
  .createHmac("sha256", DASHBOARD_PASSWORD || "unconfigured")
  .update("rmc-dashboard-session-v1")
  .digest("hex");
const SESSION_COOKIE = "rmc_auth";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days
// SameSite=None + Secure so the cookie works inside HTTPS iframe previews.
const COOKIE_ATTRS = "; HttpOnly; Path=/; SameSite=None; Secure";

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

app.use(express.json());

app.post("/api/login", (req, res) => {
  if (!DASHBOARD_PASSWORD) {
    return res.status(500).json({ error: "DASHBOARD_PASSWORD is not configured on the server." });
  }
  const password = String((req.body && req.body.password) || "");
  if (!safeEqual(password, DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  res.set("Set-Cookie", `${SESSION_COOKIE}=${SESSION_TOKEN}; Max-Age=${SESSION_MAX_AGE}${COOKIE_ATTRS}`);
  res.json({ ok: true });
});

const PUBLIC_PATHS = new Set(["/login.html", "/logo.png", "/favicon.ico"]);

app.use((req, res, next) => {
  // Fail closed: if no password is configured, the dashboard stays locked
  // rather than silently serving unprotected data.
  if (!DASHBOARD_PASSWORD) {
    return res
      .status(500)
      .send("DASHBOARD_PASSWORD is not configured on the server.");
  }
  if (PUBLIC_PATHS.has(req.path)) return next();
  const token = getCookie(req, SESSION_COOKIE);
  if (token && safeEqual(token, SESSION_TOKEN)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Authentication required" });
  }
  return res.redirect("/login.html");
});

// Behind the auth gate: only signed-in users can log out their session.
app.post("/api/logout", (req, res) => {
  res.set("Set-Cookie", `${SESSION_COOKIE}=; Max-Age=0${COOKIE_ATTRS}`);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "..", "public")));

// ── Initialize DB ─────────────────────────────────────────────────────────
getDb();

// ── API: Dashboard data ───────────────────────────────────────────────────
// The dashboard is expensive to build (live AppFolio report calls), and its data
// only changes after a sync. Cache the built payload in memory with a short TTL
// and clear it whenever a sync runs, so repeat page loads are instant.
// Cache is keyed by the selected date range so each window keeps its own entry.
const dashboardCache = new Map(); // range -> { data, at }
const dashboardPromise = new Map(); // range -> in-flight promise
const DASHBOARD_TTL_MS = 5 * 60 * 1000;
function clearDashboardCache() { dashboardCache.clear(); dashboardPromise.clear(); }

// Build the dashboard for a given range, coalescing concurrent cache-misses
// into a single in-flight build so a burst of requests doesn't fan out into
// many expensive AppFolio report calls.
function getDashboard(range) {
  const hit = dashboardCache.get(range);
  if (hit && Date.now() - hit.at < DASHBOARD_TTL_MS) {
    return Promise.resolve(hit.data);
  }
  if (dashboardPromise.has(range)) return dashboardPromise.get(range);
  const p = (async () => {
    const { buildDashboard } = await import("./lib/aggregator.js");
    const data = await buildDashboard(range);
    dashboardCache.set(range, { data, at: Date.now() });
    return data;
  })().finally(() => { dashboardPromise.delete(range); });
  dashboardPromise.set(range, p);
  return p;
}

app.get("/api/dashboard", async (req, res) => {
  try {
    const range = normalizeRange(String(req.query.range || "this_month"));
    const data = await getDashboard(range);
    res.json(data);
  } catch (err) {
    console.error("[api] Dashboard error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Drilldown (raw records behind a single KPI) ──────────────────────
app.get("/api/drilldown/:key", async (req, res) => {
  try {
    const { getDrilldown } = await import("./lib/aggregator.js");
    const dd = await getDrilldown(req.params.key, normalizeRange(String(req.query.range || "this_month")));
    if (!dd) return res.status(404).json({ error: "Unknown drilldown: " + req.params.key });
    res.json(dd);
  } catch (err) {
    console.error("[api] Drilldown error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Labor adjustments (PTO + off-AppFolio billable hours per tech) ────
app.get("/api/labor-adjustments", async (req, res) => {
  try {
    const { computeBillableHours } = await import("./lib/aggregator.js");
    const period = String(req.query.period || "");
    res.json(computeBillableHours(period));
  } catch (err) {
    console.error("[api] Labor adjustments error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/labor-adjustments", async (req, res) => {
  try {
    const { period, tech, pto_hours, extra_hours } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(String(period || ""))) {
      return res.status(400).json({ error: "period must be YYYY-MM" });
    }
    if (!tech || typeof tech !== "string" || !tech.trim()) {
      return res.status(400).json({ error: "tech is required" });
    }
    const pto = Number(pto_hours);
    const extra = Number(extra_hours);
    if (!Number.isFinite(pto) || pto < 0 || pto > 744 ||
        !Number.isFinite(extra) || extra < 0 || extra > 744) {
      return res.status(400).json({ error: "hours must be between 0 and 744" });
    }
    const { run } = await import("./lib/db.js");
    run(
      `INSERT INTO labor_adjustments (period, tech, pto_hours, extra_hours, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(period, tech) DO UPDATE SET
         pto_hours = excluded.pto_hours,
         extra_hours = excluded.extra_hours,
         updated_at = excluded.updated_at`,
      [period, tech.trim(), pto, extra, new Date().toISOString()]
    );
    clearDashboardCache();
    const { computeBillableHours } = await import("./lib/aggregator.js");
    res.json(computeBillableHours(period));
  } catch (err) {
    console.error("[api] Labor adjustments save error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Single-flight sync guard (shared by manual + scheduled triggers) ───────
let syncPromise = null;
function runSync() {
  if (syncPromise) return syncPromise;
  syncPromise = syncAll().finally(() => { syncPromise = null; clearDashboardCache(); });
  return syncPromise;
}

// ── API: Trigger sync ─────────────────────────────────────────────────────
app.post("/api/sync", async (req, res) => {
  try {
    const result = await runSync();
    res.json(result);
  } catch (err) {
    console.error("[api] Sync error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Sync status ──────────────────────────────────────────────────────
app.get("/api/sync/status", (req, res) => {
  const last = query("SELECT * FROM sync_log ORDER BY id DESC LIMIT 1")[0];
  res.json(last || { status: "never" });
});

// ── Scheduled sync (every 2 hours) ───────────────────────────────────────
async function scheduledSync() {
  try {
    console.log("[scheduler] Starting sync...");
    await runSync();
  } catch (err) {
    console.error("[scheduler] Sync failed:", err.message);
  }
}

// Run initial sync after 5s, then every 2 hours
setTimeout(scheduledSync, 5000);
setInterval(scheduledSync, 2 * 60 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`RMC Dashboard running on port ${PORT}`);
});
