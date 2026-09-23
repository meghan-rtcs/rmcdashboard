import express from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { getDb, query, run } from "./lib/db.js";
import { syncAll } from "./lib/sync.js";
import { normalizeRange } from "./lib/aggregator.js";
import {
  clearOwnerPassword,
  makeOwnerSession,
  ownerSetupRequired,
  setInitialOwnerPassword,
  validOwnerPassword,
  validOwnerSession,
  verifyOwnerPassword,
} from "./lib/owner-auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0";

// ── Dashboard and owner session protection ─────────────────────────────────
// The established dashboard/CEO password continues to gate the normal
// dashboard. Owner access is a separate, persisted credential managed below.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const SESSION_TOKEN = crypto
  .createHmac("sha256", DASHBOARD_PASSWORD || "unconfigured")
  .update("rmc-dashboard-session-v1")
  .digest("hex");
const SESSION_COOKIE = "rmc_auth";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days
const OWNER_COOKIE = "rmc_owner";
const OWNER_SESSION_MAX_AGE = 8 * 60 * 60; // owner access expires the same day
const COOKIE_ATTRS = "; HttpOnly; Path=/; SameSite=Lax; Secure";
const ownerLoginAttempts = new Map();
// This is the SHA-256 verifier for the pre-existing CEO View password. The
// CEO screen remains unchanged; reset verification is moved server-side so a
// caller cannot merely claim that it unlocked the client-side gate.
const CEO_VIEW_PASSWORD_HASH = "069233e7e1a56a244a0a2f5b4a1a7b43dd29d2bb1c4d9a5398c7212a66419371";

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function validCeoViewPassword(password) {
  const digest = crypto.createHash("sha256").update(String(password)).digest("hex");
  return safeEqual(digest, CEO_VIEW_PASSWORD_HASH);
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

function ownerAttemptAllowed(req, res) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const prior = ownerLoginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > prior.resetAt) { prior.count = 0; prior.resetAt = now + 15 * 60 * 1000; }
  if (prior.count >= 5) {
    res.set("Retry-After", String(Math.ceil((prior.resetAt - now) / 1000)));
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return null;
  }
  return { ip, prior };
}
function failedOwnerAttempt(attempt) {
  attempt.prior.count++;
  ownerLoginAttempts.set(attempt.ip, attempt.prior);
}
function clearOwnerAttempts(attempt) {
  ownerLoginAttempts.delete(attempt.ip);
}

// This endpoint intentionally returns only setup state and is public so the
// owner-login page can decide whether to show setup or sign-in.
app.get("/api/owner/status", (_req, res) => {
  res.json({ setupRequired: ownerSetupRequired() });
});

app.post("/api/owner/setup", requireSameOrigin, async (req, res) => {
  const attempt = ownerAttemptAllowed(req, res);
  if (!attempt) return;
  if (ownerSetupRequired()) return res.status(409).json({ error: "Owner access has not been set up yet." });
  const password = String((req.body && req.body.password) || "");
  const confirmation = String((req.body && req.body.confirmPassword) || "");
  if (!validOwnerPassword(password) || !safeEqual(password, confirmation)) {
    failedOwnerAttempt(attempt);
    return res.status(400).json({ error: "Password must be at least 12 characters and match confirmation." });
  }
  const created = await setInitialOwnerPassword(password);
  if (!created.ok && created.reason === "already_configured") {
    return res.status(409).json({ error: "Owner access has already been configured. Sign in instead." });
  }
  if (!created.ok) return res.status(400).json({ error: "Password must be at least 12 characters." });
  clearOwnerAttempts(attempt);
  res.set("Set-Cookie", `${OWNER_COOKIE}=${makeOwnerSession(OWNER_SESSION_MAX_AGE)}; Max-Age=${OWNER_SESSION_MAX_AGE}${COOKIE_ATTRS}`);
  res.status(201).json({ ok: true, expiresIn: OWNER_SESSION_MAX_AGE });
});

app.post("/api/owner/login", requireSameOrigin, async (req, res) => {
  const attempt = ownerAttemptAllowed(req, res);
  if (!attempt) return;
  if (ownerSetupRequired()) return res.status(409).json({ error: "Owner access has not been set up yet." });
  const password = String((req.body && req.body.password) || "");
  if (!(await verifyOwnerPassword(password))) {
    failedOwnerAttempt(attempt);
    return res.status(401).json({ error: "Incorrect password" });
  }
  clearOwnerAttempts(attempt);
  res.set("Set-Cookie", `${OWNER_COOKIE}=${makeOwnerSession(OWNER_SESSION_MAX_AGE)}; Max-Age=${OWNER_SESSION_MAX_AGE}${COOKIE_ATTRS}`);
  res.json({ ok: true, expiresIn: OWNER_SESSION_MAX_AGE });
});

app.post("/api/owner/reset", requireSameOrigin, (req, res) => {
  const attempt = ownerAttemptAllowed(req, res);
  if (!attempt) return;
  // The established CEO View credential is verified server-side. It is not an
  // owner credential; no owner secret appears in config or source.
  const ceoPassword = String((req.body && req.body.ceoPassword) || "");
  if (!validCeoViewPassword(ceoPassword)) {
    failedOwnerAttempt(attempt);
    return res.status(401).json({ error: "CEO View password is incorrect." });
  }
  if (req.body?.confirmReset !== true) {
    return res.status(400).json({ error: "Reset confirmation is required." });
  }
  if (!clearOwnerPassword()) return res.status(409).json({ error: "Owner access is already awaiting setup." });
  clearOwnerAttempts(attempt);
  res.set("Set-Cookie", `${OWNER_COOKIE}=; Max-Age=0${COOKIE_ATTRS}`);
  res.json({ ok: true, setupRequired: true });
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
    const dd = getTeamDrilldown(req.params.key, String(req.query.quarter || ""), String(req.query.propertyGroup || "configured"));
    if (!dd) return res.status(404).json({ error: "Unknown drilldown: " + req.params.key });
    res.json(dd);
  } catch (err) {
    console.error("[api] Drilldown error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/property-groups", (_req, res) => {
  res.json({ groups: query(`SELECT pg.id, CASE WHEN instr(pg.id, ':') > 0 THEN substr(pg.id, instr(pg.id, ':') + 1) ELSE pg.id END appfolio_id,
    pg.label raw_label, pg.source_field,
    COALESCE(NULLIF(pgc.display_name,''), pg.label) label
    FROM property_groups pg LEFT JOIN property_group_config pgc ON pgc.group_id = pg.id
    ORDER BY COALESCE(NULLIF(pgc.display_name,''), pg.label)`) });
});

// ── API: Labor adjustments (PTO + off-AppFolio billable hours per tech) ────
app.get("/api/labor-adjustments", requireOwner, async (req, res) => {
  try {
    const { computeBillableHours } = await import("./lib/aggregator.js");
    const period = String(req.query.period || "");
    res.json(computeBillableHours(period));
  } catch (err) {
    console.error("[api] Labor adjustments error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/labor-adjustments", requireSameOrigin, requireOwner, async (req, res) => {
  try {
    const { period, tech, pto_hours, extra_hours } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(String(period || ""))) {
      return res.status(400).json({ error: "Activity period must use YYYY-MM format." });
    }
    if (!tech || typeof tech !== "string" || !tech.trim()) {
      return res.status(400).json({ error: "Technician name is required." });
    }
    const pto = Number(pto_hours);
    const extra = Number(extra_hours);
    if (!Number.isFinite(pto) || pto < 0 || pto > 744) {
      return res.status(400).json({ error: `PTO / Sick hours for ${tech.trim()} must be between 0 and 744.` });
    }
    if (!Number.isFinite(extra) || extra < 0 || extra > 744) {
      return res.status(400).json({ error: `Other Billable hours for ${tech.trim()} must be between 0 and 744.` });
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
app.get("/api/team", requireOwner, async (req, res) => {
  try {
    const { getTeamQuarter } = await import("./lib/kpi.js");
    res.json(getTeamQuarter(String(req.query.quarter || ""), String(req.query.retroactive || "") === "1", String(req.query.propertyGroup || "configured")));
  } catch (err) {
    console.error("[api] Team error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/team/drilldown/:key", requireOwner, async (req, res) => {
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
    const quarter = String(req.query.quarter || "");

    const { seedKpiConfig, getTeamSettings } = await import("./lib/kpi.js");
    if (!/^\d{4}-Q[1-4]$/.test(quarter)) return res.status(400).json({ error: "Quarter must use YYYY-QN format." });
    res.json(snapshotQuarter(quarter, !!req.body.replaceExisting));
  } catch (err) {
    console.error("[api] Snapshot error:", err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// KPI config editor (thresholds, payouts, active flags)
app.get("/api/team/config", requireOwner, async (req, res) => {
  try {
    const { seedKpiConfig, getTeamSettings } = await import("./lib/kpi.js");
    seedKpiConfig();
    const configs = query("SELECT * FROM kpi_config ORDER BY department, sort").map((c) => ({ ...c, tiers: JSON.parse(c.tiers || "{}") }));
    const roster = query("SELECT id, name, role FROM kpi_roster WHERE active = 1 ORDER BY sort");

    const patch = req.body || {};
    const propertyGroups = query(`SELECT pg.id, CASE WHEN instr(pg.id, ':') > 0 THEN substr(pg.id, instr(pg.id, ':') + 1) ELSE pg.id END appfolio_id,
      pg.label raw_label, pg.source_field,
      COALESCE(NULLIF(pgc.display_name,''), pg.label) label,
      COALESCE(pgc.display_name,'') display_name
      FROM property_groups pg LEFT JOIN property_group_config pgc ON pgc.group_id = pg.id
      ORDER BY COALESCE(NULLIF(pgc.display_name,''), pg.label)`);
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
      return res.status(400).json({ error: "Quarterly incentive must be a non-negative number." });
    }
    if (patch.stretch_bonus != null && (!Number.isFinite(Number(patch.stretch_bonus)) || Number(patch.stretch_bonus) < 0)) {
      return res.status(400).json({ error: "Stretch bonus must be a non-negative number." });
    }
    if (patch.tier_payouts != null) {
      const p = patch.tier_payouts;
      if (!["good", "better", "best"].every((k) => Number.isFinite(Number(p[k])) && Number(p[k]) >= 0 && Number(p[k]) <= 1)) {
        return res.status(400).json({ error: "Good, Better, and Best payout percentages must each be between 0% and 100%." });
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

app.get("/api/owner/scorecard", requireOwner, async (req, res) => {
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
    const { id, tiers, active, property_group_override } = req.body || {};
    if (!id || typeof id !== "string") return res.status(400).json({ error: "KPI is required." });
    const { run, queryOne } = await import("./lib/db.js");
    const existing = queryOne("SELECT id, direction FROM kpi_config WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Unknown KPI: " + id });
    if (property_group_override !== undefined) {
      if (property_group_override !== null && typeof property_group_override !== "string")
        return res.status(400).json({ error: "Property-group override must be a group ID or null (inherit global)." });
      if (property_group_override && !query("SELECT id FROM property_groups WHERE id = ?", [property_group_override]).length)
        return res.status(400).json({ error: "Selected KPI property group was not discovered in the verified AppFolio property directory." });
    }
    if (tiers != null) {
      for (const t of ["good", "better", "best"]) {
        const tier = tiers[t] || {};
        if (tier.threshold != null && tier.threshold !== "" && !Number.isFinite(Number(tier.threshold)))
          return res.status(400).json({ error: `${t[0].toUpperCase() + t.slice(1)} threshold for ${id} must be a number or empty.` });
        if (!Number.isFinite(Number(tier.payout || 0)) || Number(tier.payout || 0) < 0)
          return res.status(400).json({ error: `${t[0].toUpperCase() + t.slice(1)} payout for ${id} must be a non-negative number.` });
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
    if (property_group_override !== undefined) {
      run("UPDATE kpi_config SET property_group_override = ? WHERE id = ?", [property_group_override || null, id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/team/property-group-label", requireSameOrigin, requireOwner, (req, res) => {
  try {
    const groupId = String(req.body?.group_id || "");
    const displayName = String(req.body?.display_name || "").trim();
    if (!groupId || !query("SELECT id FROM property_groups WHERE id = ?", [groupId]).length)
      return res.status(400).json({ error: "Property group is missing or is not a discovered AppFolio group." });
    if (!displayName) {
      run("DELETE FROM property_group_config WHERE group_id = ?", [groupId]);
    } else {
      if (displayName.length > 100) return res.status(400).json({ error: "Property-group display name must be 100 characters or fewer." });
      run(`INSERT INTO property_group_config (group_id, display_name, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(group_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
        [groupId, displayName, new Date().toISOString()]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-employee per-quarter scheduled-hours override (utilization denominator)
app.post("/api/team/override", requireSameOrigin, requireOwner, async (req, res) => {
  try {
    const { quarter, employee, scheduled_hours } = req.body || {};
    if (!/^\d{4}-Q[1-4]$/.test(String(quarter || ""))) return res.status(400).json({ error: "Quarter must use YYYY-QN format." });
    if (!employee || typeof employee !== "string") return res.status(400).json({ error: "Employee name is required." });
    const h = Number(scheduled_hours);
    if (!Number.isFinite(h) || h < 0 || h > 744) return res.status(400).json({ error: "Scheduled hours must be between 0 and 744." });
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

// Pull only the Google Sheet so approved off-AppFolio hours can be refreshed
// without waiting for the next full AppFolio sync.
app.post("/api/sheet/sync", requireSameOrigin, async (_req, res) => {
  try {
    const { syncSheetHours } = await import("./lib/sheets.js");
    const status = await syncSheetHours();
    clearDashboardCache();
    res.status(status.ok ? 200 : 502).json(status);
  } catch (err) {
    console.error("[api] Sheet sync error:", err);
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

// ── Scheduled quarter snapshot (calendar-aware, fires on the last day of each quarter) ─
// Guards against the "someone forgot to click Snapshot" problem: on the final
// day of each quarter the server automatically runs a final AppFolio sync and
// then locks the KPI results so that retroactive edits can never silently
// change paid bonuses.
//
// Design decisions:
//   • Uses UTC throughout — currentQuarter() and quarterBounds() are both UTC-
//     based, so today's date is compared in UTC to avoid local/UTC skew on
//     quarter-boundary nights.
//   • Fires at a fixed UTC wall-clock time (23:45 UTC) each day via a
//     recursive setTimeout rather than a fixed 24-hour interval, so the check
//     never drifts away from a calendar day boundary.
//   • Awaits runSync() before calling snapshotQuarter() so the snapshot always
//     captures the freshest AppFolio data; a sync already in progress is
//     reused via the single-flight guard in runSync().
//   • Idempotent: if a snapshot whose UTC date matches today already exists,
//     the job skips — safe across server restarts on the last day.

// Target UTC time for the daily quarter-close check.
const SNAPSHOT_CHECK_HOUR_UTC = 23;
const SNAPSHOT_CHECK_MIN_UTC  = 45;
async function scheduledQuarterSnapshot() {
  try {
    const { snapshotQuarter, currentQuarter, quarterBounds } = await import("./lib/kpi.js");

    const quarter = currentQuarter(); // UTC-based
    const bounds  = quarterBounds(quarter);
    if (!bounds) return;

    // Last day of the quarter = one day before the exclusive end date (UTC).
    const endExcl = new Date(bounds[1] + "T00:00:00Z");
    endExcl.setUTCDate(endExcl.getUTCDate() - 1);
    const lastDay = endExcl.toISOString().slice(0, 10);
    const today   = new Date().toISOString().slice(0, 10); // UTC date

    if (today !== lastDay) return; // not the last day — nothing to do

    // Skip if a snapshot already exists for today (handles server restarts on
    // the last day — no need to re-stamp an already-locked quarter).
    const existing = query(
      "SELECT snapshot_at FROM quarter_results WHERE quarter = ?",
      [quarter]
    )[0];
    if (existing && existing.snapshot_at && existing.snapshot_at.slice(0, 10) === today) {
      console.log(`[scheduler] Quarter ${quarter} already snapshotted today — skipping.`);
      return;
    }

    // Run a final sync first so the snapshot captures up-to-date AppFolio data.
    // runSync() is single-flight: if a sync is already in progress it reuses it.
    console.log(`[scheduler] Last day of ${quarter} — running final sync before snapshot...`);
    await runSync();

    console.log(`[scheduler] Snapshotting quarter ${quarter}...`);
    const result = snapshotQuarter(quarter);
    console.log(`[scheduler] Quarter ${quarter} auto-snapshot complete at ${result.snapshotAt}`);
  } catch (err) {
    console.error("[scheduler] Quarter snapshot failed:", err.message);
  }
}

// Schedule the check at SNAPSHOT_CHECK_HOUR_UTC:SNAPSHOT_CHECK_MIN_UTC UTC each
// day using a recursive setTimeout so the trigger stays anchored to a fixed
// wall-clock time rather than drifting with a setInterval.
function scheduleNextQuarterSnapshot() {
  const now  = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    SNAPSHOT_CHECK_HOUR_UTC, SNAPSHOT_CHECK_MIN_UTC, 0, 0
  ));
  // If we're already past today's target time, aim for tomorrow.
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next - now;
  setTimeout(async () => {
    await scheduledQuarterSnapshot();
    scheduleNextQuarterSnapshot(); // reschedule for the next day
  }, delay);
}

// Do not schedule external sync work when the app is imported by the isolated
// HTTP auth tests. Normal application startup is unchanged.
if (process.env.RMC_TEST_MODE !== "1") {
  setTimeout(scheduledSync, 5000);
  setInterval(scheduledSync, 2 * 60 * 60 * 1000);
  scheduleNextQuarterSnapshot();
  app.listen(PORT, () => {
    console.log(`RMC Dashboard running on port ${PORT}`);
  });
}

export { app };
