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
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "";
const OWNER_COOKIE = "rmc_owner";
const OWNER_SESSION_MAX_AGE = 8 * 60 * 60; // owner access expires the same day
const COOKIE_ATTRS = "; HttpOnly; Path=/; SameSite=Lax; Secure";
const ownerLoginAttempts = new Map();

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

function makeOwnerSession() {
  const payload = Buffer.from(JSON.stringify({
    role: "owner", exp: Date.now() + OWNER_SESSION_MAX_AGE * 1000,
    nonce: crypto.randomBytes(18).toString("base64url"),
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", OWNER_PASSWORD).update(payload).digest("base64url");
  return payload + "." + sig;
}
function validOwnerSession(token) {
  if (!OWNER_PASSWORD || !token || !token.includes(".")) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = crypto.createHmac("sha256", OWNER_PASSWORD).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.role === "owner" && Number(data.exp) > Date.now();
  } catch { return false; }
}
function sameOrigin(req) {
  const origin = req.get("origin");
  // Browsers send Origin for fetch/XHR mutations. Reject missing or foreign
  // origins so authenticated cookies cannot be used cross-site. Compare hosts
  // rather than req.protocol because the hosted TLS proxy terminates HTTPS
  // before Express receives the request.
  try { return !!origin && new URL(origin).host === req.get("host"); } catch { return false; }
}
function requireSameOrigin(req, res, next) {
  if (!sameOrigin(req)) return res.status(403).json({ error: "Same-origin request required" });
  next();
}
function requireOwner(req, res, next) {
  if (!validOwnerSession(getCookie(req, OWNER_COOKIE))) {
    return res.status(403).json({ error: "Owner sign-in required" });
  }
  next();
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

app.post("/api/owner/login", requireSameOrigin, (req, res) => {
  if (!OWNER_PASSWORD) return res.status(503).json({ error: "OWNER_PASSWORD is not configured on the server." });
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const prior = ownerLoginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > prior.resetAt) { prior.count = 0; prior.resetAt = now + 15 * 60 * 1000; }
  if (prior.count >= 5) {
    res.set("Retry-After", String(Math.ceil((prior.resetAt - now) / 1000)));
    return res.status(429).json({ error: "Too many attempts. Try again later." });
  }
  const password = String((req.body && req.body.password) || "");
  if (!safeEqual(password, OWNER_PASSWORD)) {
    prior.count++;
    ownerLoginAttempts.set(ip, prior);
    return res.status(401).json({ error: "Incorrect password" });
  }
  ownerLoginAttempts.delete(ip);
  res.set("Set-Cookie", `${OWNER_COOKIE}=${makeOwnerSession()}; Max-Age=${OWNER_SESSION_MAX_AGE}${COOKIE_ATTRS}`);
  res.json({ ok: true, expiresIn: OWNER_SESSION_MAX_AGE });
});

const PUBLIC_PATHS = new Set(["/login.html", "/owner-login.html", "/logo.png", "/favicon.ico"]);

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
  res.set("Set-Cookie", [`${SESSION_COOKIE}=; Max-Age=0${COOKIE_ATTRS}`, `${OWNER_COOKIE}=; Max-Age=0${COOKIE_ATTRS}`]);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "..", "public")));

// ── Initialize DB ─────────────────────────────────────────────────────────
getDb();

// ── API: Dashboard data ───────────────────────────────────────────────────
// The dashboard is expensive to build (live AppFolio report calls), and its data
// only changes after a sync. Cache the built payload in memory with a short TTL
// and clear it whenever a sync runs, so repeat page loads are instant.
// Cache is keyed by Activity Period and property-group scope.
const dashboardCache = new Map(); // range|scope -> { data, at }
const dashboardPromise = new Map(); // range|scope -> in-flight promise
const DASHBOARD_TTL_MS = 5 * 60 * 1000;
function clearDashboardCache() { dashboardCache.clear(); dashboardPromise.clear(); }

// Build the dashboard for a given range, coalescing concurrent cache-misses
// into a single in-flight build so a burst of requests doesn't fan out into
// many expensive AppFolio report calls.
function getDashboard(range, propertyGroupScope) {
  const key = `${range}|${propertyGroupScope}`;
  const hit = dashboardCache.get(key);
  if (hit && Date.now() - hit.at < DASHBOARD_TTL_MS) {
    return Promise.resolve(hit.data);
  }
  if (dashboardPromise.has(key)) return dashboardPromise.get(key);
  const p = (async () => {
    const { buildDashboard } = await import("./lib/aggregator.js");
    const data = await buildDashboard(range, propertyGroupScope);
    dashboardCache.set(key, { data, at: Date.now() });
    return data;
  })().finally(() => { dashboardPromise.delete(key); });
  dashboardPromise.set(key, p);
  return p;
}

app.get("/api/dashboard", async (req, res) => {
  try {
    const range = normalizeRange(String(req.query.range || "this_month"));
    const propertyGroupScope = String(req.query.propertyGroup || "configured");
    const data = await getDashboard(range, propertyGroupScope);
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
    const dd = await getDrilldown(req.params.key, normalizeRange(String(req.query.range || "this_month")), String(req.query.propertyGroup || "configured"));
    if (!dd) return res.status(404).json({ error: "Unknown drilldown: " + req.params.key });
    res.json(dd);
  } catch (err) {
    console.error("[api] Drilldown error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/property-groups", (_req, res) => {
  res.json({ groups: query("SELECT id, label, source_field FROM property_groups ORDER BY label") });
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

// ── API: Team Performance (KPIs & Bonuses) ─────────────────────────────────
app.get("/api/team", async (req, res) => {
  try {
    const { getTeamQuarter } = await import("./lib/kpi.js");
    res.json(getTeamQuarter(String(req.query.quarter || ""), String(req.query.retroactive || "") === "1", String(req.query.propertyGroup || "configured")));
  } catch (err) {
    console.error("[api] Team error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/team/drilldown/:key", async (req, res) => {
  try {
    const { getTeamDrilldown } = await import("./lib/kpi.js");
    const dd = getTeamDrilldown(req.params.key, String(req.query.quarter || ""), String(req.query.propertyGroup || "configured"));
    if (!dd) return res.status(404).json({ error: "Unknown drilldown: " + req.params.key });
    res.json(dd);
  } catch (err) {
    console.error("[api] Team drilldown error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Snapshot (lock) a quarter's results so retroactive AppFolio edits can't
// change already-paid bonuses. Re-snapshotting overwrites with a new timestamp.
app.post("/api/team/snapshot", requireSameOrigin, requireOwner, async (req, res) => {
  try {
    const { snapshotQuarter } = await import("./lib/kpi.js");
    const quarter = String((req.body && req.body.quarter) || "");
    if (!/^\d{4}-Q[1-4]$/.test(quarter)) return res.status(400).json({ error: "quarter must be YYYY-QN" });
    res.json(snapshotQuarter(quarter, !!req.body.replaceExisting));
  } catch (err) {
    console.error("[api] Snapshot error:", err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// KPI config editor (thresholds, payouts, active flags)
app.get("/api/team/config", async (req, res) => {
  if (!validOwnerSession(getCookie(req, OWNER_COOKIE))) return res.status(403).json({ error: "Owner sign-in required" });
  try {
    const { seedKpiConfig, getTeamSettings } = await import("./lib/kpi.js");
    seedKpiConfig();
    const configs = query("SELECT * FROM kpi_config ORDER BY department, sort").map((c) => ({ ...c, tiers: JSON.parse(c.tiers || "{}") }));
    const roster = query("SELECT * FROM kpi_roster ORDER BY sort").map((r) => ({ ...r, allocations: JSON.parse(r.allocations || "{}") }));
    const propertyGroups = query("SELECT id, label, source_field FROM property_groups ORDER BY label");
    const vendorFields = new Set();
    query("SELECT custom_fields FROM vendors WHERE custom_fields != ''").forEach((r) => {
      try { Object.keys(JSON.parse(r.custom_fields || "{}")).forEach((k) => vendorFields.add(k)); } catch {}
    });
    res.json({ configs, roster, settings: getTeamSettings(), propertyGroups, vendorExemptionFields: [...vendorFields].sort(), vendorExemptionUnavailable: vendorFields.size === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/owner/session", (req, res) => {
  res.json({ owner: validOwnerSession(getCookie(req, OWNER_COOKIE)) });
});

app.post("/api/owner/settings", requireSameOrigin, requireOwner, async (req, res) => {
  try {
    const { updateTeamSettings } = await import("./lib/kpi.js");
    const patch = req.body || {};
    if (patch.quarterly_incentive != null && (!Number.isFinite(Number(patch.quarterly_incentive)) || Number(patch.quarterly_incentive) < 0)) {
      return res.status(400).json({ error: "quarterly_incentive must be a non-negative number" });
    }
    if (patch.stretch_bonus != null && (!Number.isFinite(Number(patch.stretch_bonus)) || Number(patch.stretch_bonus) < 0)) {
      return res.status(400).json({ error: "stretch_bonus must be a non-negative number" });
    }
    if (patch.tier_payouts != null) {
      const p = patch.tier_payouts;
      if (!["good", "better", "best"].every((k) => Number.isFinite(Number(p[k])) && Number(p[k]) >= 0 && Number(p[k]) <= 1)) {
        return res.status(400).json({ error: "tier_payouts must contain Good, Better, and Best values from 0 to 1" });
      }
    }
    if (patch.discretionary_questions != null &&
      (!Array.isArray(patch.discretionary_questions) || patch.discretionary_questions.length < 7 ||
       patch.discretionary_questions.length > 10 || !patch.discretionary_questions.every((q) => typeof q === "string" && q.trim()))) {
      return res.status(400).json({ error: "discretionary_questions must contain 7 to 10 non-empty questions" });
    }
    if (patch.discretionary_max_by_role != null &&
      (typeof patch.discretionary_max_by_role !== "object" || Object.values(patch.discretionary_max_by_role)
        .some((v) => !Number.isFinite(Number(v)) || Number(v) < 0))) {
      return res.status(400).json({ error: "discretionary role maximums must be non-negative numbers" });
    }
    if (patch.bonus_eligible_property_group &&
      !query("SELECT id FROM property_groups WHERE id = ?", [patch.bonus_eligible_property_group]).length) {
      return res.status(400).json({ error: "Selected property group was not discovered in the verified AppFolio property directory" });
    }
    const settings = updateTeamSettings(patch);
    clearDashboardCache();
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/owner/historical-adjustments", requireOwner, async (_req, res) => {
  try {
    const { historicalAdjustments } = await import("./lib/kpi.js");
    res.json({ adjustments: historicalAdjustments() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/owner/scorecard", requireOwner, (req, res) => {
  try {
    const quarter = String(req.query.quarter || "");
    if (!/^\d{4}-Q[1-4]$/.test(quarter)) return res.status(400).json({ error: "quarter must be YYYY-QN" });
    const roster = query("SELECT id, name, role FROM kpi_roster WHERE active = 1 ORDER BY sort");
    const reviews = query("SELECT employee_id, answers, updated_at FROM discretionary_reviews WHERE quarter = ?", [quarter])
      .map((r) => ({ ...r, answers: JSON.parse(r.answers || "[]") }));
    res.json({ quarter, roster, reviews });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/owner/scorecard", requireSameOrigin, requireOwner, (req, res) => {
  try {
    const { quarter, employee_id, answers } = req.body || {};
    if (!/^\d{4}-Q[1-4]$/.test(String(quarter || ""))) return res.status(400).json({ error: "quarter must be YYYY-QN" });
    if (!query("SELECT id FROM kpi_roster WHERE id = ? AND active = 1", [employee_id]).length) return res.status(404).json({ error: "Unknown active employee" });
    if (!Array.isArray(answers) || !answers.every((a) => a === "na" || [0, 1, 2].includes(Number(a)))) {
      return res.status(400).json({ error: "answers must be 0, 1, 2, or na" });
    }
    run(`INSERT INTO discretionary_reviews (quarter, employee_id, answers, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(quarter, employee_id) DO UPDATE SET answers = excluded.answers, updated_at = excluded.updated_at`,
      [quarter, employee_id, JSON.stringify(answers), new Date().toISOString()]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/team/config", requireSameOrigin, requireOwner, async (req, res) => {
  try {
    const { id, tiers, active } = req.body || {};
    if (!id || typeof id !== "string") return res.status(400).json({ error: "id required" });
    const { run, queryOne } = await import("./lib/db.js");
    const existing = queryOne("SELECT id, direction FROM kpi_config WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Unknown KPI: " + id });
    if (tiers != null) {
      for (const t of ["good", "better", "best"]) {
        const tier = tiers[t] || {};
        if (tier.threshold != null && tier.threshold !== "" && !Number.isFinite(Number(tier.threshold)))
          return res.status(400).json({ error: t + " threshold must be a number or empty" });
        if (!Number.isFinite(Number(tier.payout || 0)) || Number(tier.payout || 0) < 0)
          return res.status(400).json({ error: t + " payout must be a non-negative number" });
      }
      const clean = {};
      for (const t of ["good", "better", "best"]) {
        const tier = tiers[t] || {};
        clean[t] = { threshold: tier.threshold == null || tier.threshold === "" ? null : Number(tier.threshold),
                     payout: Number(tier.payout || 0) };
      }
      // Semantic validation: thresholds must get progressively stricter
      // (Good → Better → Best) in the KPI's direction, and payouts must not
      // decrease as the tier improves — otherwise scoring becomes arbitrary.
      const lower = existing.direction === "lower_is_better";
      const seq = ["good", "better", "best"].map((t) => clean[t]);
      for (let i = 1; i < seq.length; i++) {
        const prev = seq.slice(0, i).reverse().find((s) => s.threshold != null);
        if (prev && seq[i].threshold != null) {
          const ok = lower ? seq[i].threshold < prev.threshold : seq[i].threshold > prev.threshold;
          if (!ok) return res.status(400).json({ error: "Thresholds must get progressively " + (lower ? "lower" : "higher") + " from Good to Best" });
        }
        const prevP = seq.slice(0, i).reverse().find((s) => s.threshold != null);
        if (prevP && seq[i].threshold != null && seq[i].payout < prevP.payout)
          return res.status(400).json({ error: "A better tier cannot pay less than a lower tier" });
      }
      run("UPDATE kpi_config SET tiers = ? WHERE id = ?", [JSON.stringify(clean), id]);
    }
    if (active != null) run("UPDATE kpi_config SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-employee per-quarter scheduled-hours override (utilization denominator)
app.post("/api/team/override", requireSameOrigin, requireOwner, async (req, res) => {
  try {
    const { quarter, employee, scheduled_hours } = req.body || {};
    if (!/^\d{4}-Q[1-4]$/.test(String(quarter || ""))) return res.status(400).json({ error: "quarter must be YYYY-QN" });
    if (!employee || typeof employee !== "string") return res.status(400).json({ error: "employee required" });
    const h = Number(scheduled_hours);
    if (!Number.isFinite(h) || h < 0 || h > 744) return res.status(400).json({ error: "scheduled_hours must be 0–744" });
    const { run } = await import("./lib/db.js");
    if (h === 0) run("DELETE FROM team_overrides WHERE quarter = ? AND employee = ?", [quarter, employee.trim()]);
    else run(`INSERT INTO team_overrides (quarter, employee, scheduled_hours) VALUES (?, ?, ?)
              ON CONFLICT(quarter, employee) DO UPDATE SET scheduled_hours = excluded.scheduled_hours`,
      [quarter, employee.trim(), h]);
    res.json({ ok: true });
  } catch (err) {
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
