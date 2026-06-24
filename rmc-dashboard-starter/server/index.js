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

// ── Password protection (HTTP Basic Auth) ─────────────────────────────────
// Gates the entire dashboard — static page, API, everything — behind a single
// password supplied via the DASHBOARD_PASSWORD env var. Any username is
// accepted; only the password is checked (with a constant-time comparison).
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

app.use((req, res, next) => {
  // Fail closed: if no password is configured, the dashboard stays locked
  // rather than silently serving unprotected data.
  if (!DASHBOARD_PASSWORD) {
    return res
      .status(500)
      .send("DASHBOARD_PASSWORD is not configured on the server.");
  }
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (safeEqual(password, DASHBOARD_PASSWORD)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="RMC Dashboard", charset="UTF-8"');
  return res.status(401).send("Authentication required.");
});

app.use(express.json());
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
    const range = normalizeRange(String(req.query.range || "30d"));
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
    const dd = await getDrilldown(req.params.key, normalizeRange(String(req.query.range || "30d")));
    if (!dd) return res.status(404).json({ error: "Unknown drilldown: " + req.params.key });
    res.json(dd);
  } catch (err) {
    console.error("[api] Drilldown error:", err);
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
