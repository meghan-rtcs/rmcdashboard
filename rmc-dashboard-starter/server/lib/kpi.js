// ── Team Performance (KPIs & Bonuses) engine ─────────────────────────────────
// Config-driven quarterly KPI scorecard: department + individual KPIs, tiered
// payouts (Good/Better/Best), share-weighted department splits, quarter
// snapshots/locking, and per-KPI drilldowns. Nothing about thresholds or
// payouts is hardcoded here — all definitions live in kpi_config / kpi_roster.
import { query, queryOne, run } from "./db.js";
import { DEFAULT_TEAM_SETTINGS, REQUIRED_KPI_DEFAULTS } from "./team-settings.js";

const num = (v) => (v == null || isNaN(v) ? 0 : Number(v));
const round = (v, d = 1) => {
  const f = Math.pow(10, d);
  return Math.round(num(v) * f) / f;
};
const one = (sql, params = []) => { try { return queryOne(sql, params) || {}; } catch { return {}; } };
const many = (sql, params = []) => { try { return query(sql, params) || []; } catch { return []; } };

// Non-revenue units: AppFolio exposes no explicit non-revenue flag via the API;
// `rentable = 'No'` from the unit directory is the closest signal.
const REVENUE_UNIT = "COALESCE(u.rentable,'') != 'No'";

// Turnover work orders don't count against move-in quality (user-approved rule)
const TURNOVER_WO =
  "(LOWER(COALESCE(w.work_order_type,'')) LIKE '%turn%' OR " +
  "LOWER(COALESCE(w.description,'')) LIKE '%lock%' OR " +
  "LOWER(COALESCE(w.description,'')) LIKE '%rekey%' OR " +
  "LOWER(COALESCE(w.description,'')) LIKE '%re-key%' OR " +
  "LOWER(COALESCE(w.description,'')) LIKE '%blind%' OR " +
  "LOWER(COALESCE(w.description,'')) LIKE '%make ready%')";

// ── Quarters ────────────────────────────────────────────────────────────────

export function currentQuarter() {
  const d = new Date();
  // Use UTC getters so this stays in sync with quarterBounds(), which uses
  // Date.UTC. Local-time getters would disagree on non-UTC hosts around
  // midnight on quarter boundaries.
  return d.getUTCFullYear() + "-Q" + (Math.floor(d.getUTCMonth() / 3) + 1);
}
export function quarterBounds(q) {
  const m = /^(\d{4})-Q([1-4])$/.exec(String(q || ""));
  if (!m) return null;
  const y = Number(m[1]), qi = Number(m[2]);
  const start = new Date(Date.UTC(y, (qi - 1) * 3, 1));
  const end = new Date(Date.UTC(y, qi * 3, 1)); // exclusive
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}
export function normalizeQuarter(q) {
  return quarterBounds(q) ? q : currentQuarter();
}
export function listQuarters() {
  // Keep the requested retroactive 2026 Q1–Q3 periods available even before
  // the calendar reaches them; future periods are shown as unavailable.
  const out = [];
  const cur = currentQuarter() > "2026-Q3" ? currentQuarter() : "2026-Q3";
  const [cy, cq] = cur.split("-Q").map(Number);
  for (let y = 2025; y <= cy; y++) {
    for (let qi = 1; qi <= 4; qi++) {
      if (y === cy && qi > cq) break;
      out.push(y + "-Q" + qi);
    }
  }
  return out.reverse();
}
function workdaysBetween(startIso, endIsoExcl) {
  let n = 0;
  const d = new Date(startIso + "T00:00:00Z");
  const end = new Date(endIsoExcl + "T00:00:00Z");
  while (d < end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}
function monthsInQuarter(q) {
  const [start] = quarterBounds(q);
  const y = start.slice(0, 4), m0 = Number(start.slice(5, 7));
  return [0, 1, 2].map((i) => y + "-" + String(m0 + i).padStart(2, "0"));
}

// ── Seed config (first run only — everything editable afterwards) ──────────

const T = (g, b, be, pg, pb, pbe) => JSON.stringify({
  good: { threshold: g, payout: pg }, better: { threshold: b, payout: pb }, best: { threshold: be, payout: pbe },
});
const NULL_TIERS = JSON.stringify({
  good: { threshold: null, payout: 0 }, better: { threshold: null, payout: 0 }, best: { threshold: null, payout: 0 },
});

export function getTeamSettings() {
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(DEFAULT_TEAM_SETTINGS)) {
    run("INSERT OR IGNORE INTO team_settings (key, value, updated_at) VALUES (?, ?, ?)",
      [key, JSON.stringify(value), now]);
  }
  const rows = many("SELECT key, value FROM team_settings");
  const stored = Object.fromEntries(rows.map((r) => {
    try { return [r.key, JSON.parse(r.value)]; } catch { return [r.key, r.value]; }
  }));
  return { ...DEFAULT_TEAM_SETTINGS, ...stored };
}

export function updateTeamSettings(patch) {
  const current = getTeamSettings();
  const allowed = new Set(Object.keys(DEFAULT_TEAM_SETTINGS));
  for (const [key, value] of Object.entries(patch || {})) {
    if (!allowed.has(key)) continue;
    run(`INSERT INTO team_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), new Date().toISOString()]);
  }
  return getTeamSettings();
}

export function seedKpiConfig() {
  if (num(one("SELECT COUNT(*) c FROM kpi_roster").c) === 0) {
    const roster = [
      ["john", "John Fedele", "Senior Property Manager", { "Property Management": 1 }, 1],
      ["fabian", "Fabian Buenrostro", "Maintenance Coordinator", { "Property Management": 0.5, "Maintenance": 0.5 }, 2],
      ["bong", "Lobrigo \"Bong\" Manasan", "Maintenance Technician", {}, 3],
      ["scott", "Scott C. Scott", "Maintenance Technician", {}, 4],
      ["melinda", "Melinda Greene", "Bookkeeper", { "Bookkeeping": 1 }, 5],
    ];
    for (const [id, name, role, alloc, sort] of roster) {
      run("INSERT INTO kpi_roster (id, name, role, allocations, active, sort) VALUES (?, ?, ?, ?, 1, ?)",
        [id, name, role, JSON.stringify(alloc), sort]);
    }
  }
  // Mark is removed from live configuration and live roster. Historical
  // snapshot dollar amounts are intentionally not recalculated here.
  run("DELETE FROM kpi_roster WHERE id = 'mark'");
  run("UPDATE kpi_config SET assigned_to = 'john' WHERE id = 'pm_inspections'");
  // Historical payouts are frozen. Remove the departed employee's personally
  // identifying roster/KPI references from snapshot payloads without changing
  // the other employees' frozen amounts or re-splitting any historical pool.
  for (const row of many("SELECT quarter, payload FROM quarter_results")) {
    try {
      const payload = JSON.parse(row.payload);
      const removed = (payload.employees || []).filter((e) => e.id === "mark");
      let changed = removed.length > 0;
      if (removed.length) {
        payload.employees = payload.employees.filter((e) => e.id !== "mark");
        payload.historicalUnallocatedBonus = round(num(payload.historicalUnallocatedBonus) +
          removed.reduce((sum, e) => sum + num(e.earned), 0), 2);
        payload.historicalAdjustment = "Retired share removed; remaining frozen employee amounts were not redistributed.";
      }
      for (const k of payload.kpis || []) {
        if (k.assignedTo === "mark") {
          k.assignedTo = "john"; k.assignedName = "John Fedele"; changed = true;
        }
      }
      for (const d of payload.departments || []) {
        if (Array.isArray(d.members)) {
          const before = d.members.length;
          d.members = d.members.filter((m) => m.id !== "mark");
          changed ||= before !== d.members.length;
        }
        for (const k of d.individualKpis || []) {
          if (k.assignedTo === "mark") {
            k.assignedTo = "john"; k.assignedName = "John Fedele"; changed = true;
          }
        }
      }
      if (changed) run("UPDATE quarter_results SET payload = ? WHERE quarter = ?", [JSON.stringify(payload), row.quarter]);
    } catch { /* never replace a malformed frozen snapshot */ }
  }
  if (num(one("SELECT COUNT(*) c FROM kpi_config").c) === 0) {
    // Payout dollar amounts are placeholders ($0) until the client provides
    // them — tiers are scored but pay nothing until config is updated.
    const rows = [
      // Property Management — department
      ["pm_vacancy_days", "Property Management", "Vacancy Time (Turnover → Re-lease)",
        "Average days from previous tenant move-out to new tenant move-in, for re-leases in the quarter. Non-revenue units excluded.",
        "department", null, "AppFolio lease history + unit directory", "lower_is_better", "days",
        T(30, 20, 10, 0, 0, 0), 1, 1],
      ["pm_owner_insurance", "Property Management", "Owner Insurance Current",
        "Percent of properties covered by an active (unexpired) owner insurance policy.",
        "department", null, "AppFolio owner_insurance report", "higher_is_better", "percent",
        T(70, 80, 90, 0, 0, 0), 1, 2],
      ["pm_days_on_market", "Property Management", "Days on Market",
        "Not yet configured — thresholds pending from client.",
        "department", null, "AppFolio", "lower_is_better", "days", NULL_TIERS, 0, 3],
      ["pm_days_to_lease", "Property Management", "Days to Lease",
        "Not yet configured — thresholds pending from client.",
        "department", null, "AppFolio", "lower_is_better", "days", NULL_TIERS, 0, 4],
      // Property Management — individual (John; Scott/Bong are contributors)
      ["pm_inspections", "Property Management", "Building Inspections (Units Inspected)",
        "Average units inspected per month from Building Walkthroughs. John is accountable; Scott and Bong contribute.",
        "individual", "john", "AppFolio inspection_detail report", "higher_is_better", "count",
        T(40, 50, 60, 0, 0, 0), 1, 5],
      // Maintenance — department
      ["mnt_clean_movein", "Maintenance", "Move-ins with no work orders",
        "Percent of bonus-eligible-group move-ins with zero non-turnover work orders in the first 30 days.",
        "department", null, "AppFolio work orders + rent roll", "higher_is_better", "percent",
        T(70, 80, 90, 0, 0, 0), 1, 1],
      ["mnt_wo_30days", "Maintenance", "Work Orders Completed ≤ 30 Days",
        "Percent of work orders completed in the quarter that were closed within 30 days of creation.",
        "department", null, "AppFolio work orders", "higher_is_better", "percent",
        T(80, 90, 95, 0, 0, 0), 1, 2],
      ["mnt_wo_ttc", "Maintenance", "Work Order Time to Completion",
        "Not yet configured — thresholds pending from client.",
        "department", null, "AppFolio work order timestamps", "lower_is_better", "days", NULL_TIERS, 0, 3],
      // Maintenance — individual (per tech)
      ["mnt_util_bong", "Maintenance", "Billable Hours Utilization — Bong",
        "(AppFolio billable + approved other billable) / (scheduled − PTO/sick). Scored independently per tech.",
        "individual", "bong", "AppFolio labor + manual adjustments", "higher_is_better", "percent",
        T(75, 85, 95, 0, 0, 0), 1, 4],
      ["mnt_util_scott", "Maintenance", "Billable Hours Utilization — Scott",
        "(AppFolio billable + approved other billable) / (scheduled − PTO/sick). Scored independently per tech.",
        "individual", "scott", "AppFolio labor + manual adjustments", "higher_is_better", "percent",
        T(75, 85, 95, 0, 0, 0), 1, 5],
      // Bookkeeping — department (all thresholds TBD from client)
      ["bk_delinquent_rent", "Bookkeeping", "Delinquent Rent (Rent Only)",
        "Month-end rent-only delinquency as a percent of monthly rent; utilities and other charges excluded.",
        "department", null, "AppFolio aged receivables (rent charges)", "lower_is_better", "percent", T(10, 5, 2, 0, 0, 0), 1, 1],
      ["bk_vendor_ins", "Bookkeeping", "Vendor Insurance Current %",
        "Percent of active vendors (do-not-use excluded) with an unexpired liability policy.",
        "department", null, "AppFolio vendor directory", "higher_is_better", "percent", NULL_TIERS, 1, 2],
      ["bk_renters_ins", "Bookkeeping", "Renter's Insurance Tracking %",
        "Percent of current tenants with a renter's insurance policy on file.",
        "department", null, "AppFolio tenant directory", "higher_is_better", "percent", NULL_TIERS, 1, 3],
    ];
    for (const [id, dept, label, desc, scope, assigned, src, dir, unit, tiers, active, sort] of rows) {
      run(`INSERT INTO kpi_config (id, department, label, description, scope, assigned_to, data_source, direction, unit, tiers, active, effective_quarter, sort)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, dept, label, desc, scope, assigned, src, dir, unit, tiers, active, "2026-Q3", sort]);
    }
  }
  // Mandatory client thresholds are applied to existing starter configuration.
  // Dollar payouts are intentionally not stored per KPI: the program splits
  // the owner's configurable quarterly amount evenly across weighted KPIs.
  if (!one("SELECT value FROM app_state WHERE key = 'kpi_thresholds_v2'").value) {
    for (const [id, thresholds] of Object.entries(REQUIRED_KPI_DEFAULTS)) {
      const c = one("SELECT tiers FROM kpi_config WHERE id = ?", [id]);
      if (!c.tiers) continue;
      const old = JSON.parse(c.tiers || "{}");
      const tiers = Object.fromEntries(["good", "better", "best"].map((tier) => [
        tier, { threshold: thresholds[tier], payout: num(old[tier]?.payout) },
      ]));
      run("UPDATE kpi_config SET tiers = ? WHERE id = ?", [JSON.stringify(tiers), id]);
    }
    run("INSERT OR REPLACE INTO app_state (key, value) VALUES ('kpi_thresholds_v2', '1')");
  }
  run("UPDATE kpi_config SET label = ?, description = ?, assigned_to = 'john' WHERE id = 'pm_inspections'",
    ["Building Inspections (Units / Month)", "Average units inspected each month from Building Walkthroughs. John is accountable; Scott and Bong are contributors."]);
  run("UPDATE kpi_config SET label = ?, description = ? WHERE id = 'mnt_clean_movein'",
    ["Move-ins with no work orders", "Percent of counted move-ins with zero non-turnover work orders in the first 30 days. Property scope follows this KPI's override or inherits the global setting."]);
}

// ── KPI value computation ───────────────────────────────────────────────────
// Each computer returns { value, detail?, dataQuality? } for a quarter window.

function kpiVacancyDays(qs, qe, scope) {
  const group = selectedGroupClause("p", scope.id);
  // Gap = new tenant move_in minus previous occupancy's move_out (or lease_end)
  // on the same unit, for move-ins inside the quarter. Non-revenue excluded.
  const leases = many(
    `SELECT lh.unit_id, lh.move_in FROM lease_history lh
     JOIN units u ON u.id = lh.unit_id
     LEFT JOIN properties p ON p.id = u.property_id
     WHERE lh.move_in >= ? AND lh.move_in < ? AND lh.unit_id != '' AND ${REVENUE_UNIT}${group.sql}`,
    [qs, qe, ...group.params]
  );
  const gaps = [];
  for (const l of leases) {
    const prev = one(
      `SELECT COALESCE(NULLIF(move_out,''), lease_end) prev_end FROM lease_history
       WHERE unit_id = ? AND move_in < ? AND COALESCE(NULLIF(move_out,''), lease_end) != ''
       ORDER BY move_in DESC LIMIT 1`,
      [l.unit_id, l.move_in]
    );
    if (!prev.prev_end) continue;
    const days = (new Date(l.move_in) - new Date(prev.prev_end)) / 86400000;
    if (days >= 0 && days < 730) gaps.push(days);
  }
  return {
    value: gaps.length ? round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
    detail: gaps.length + " re-lease" + (gaps.length === 1 ? "" : "s") + " with measurable turnover gap",
    dataQuality: leases.length > 0 && gaps.length === 0
      ? "Move-ins found but no prior move-out recorded — AppFolio lease history may be incomplete." : null,
  };
}

function kpiOwnerInsurance(scope) {
  const group = selectedGroupClause("p", scope.id);
  const total = num(one(`SELECT COUNT(*) c FROM properties p
    WHERE TRIM(COALESCE(property_name,'')) != ''${group.sql}`, group.params).c);
  const covered = num(one(
    `SELECT COUNT(*) c FROM properties p
     WHERE TRIM(COALESCE(p.property_name,'')) != ''
       AND EXISTS (
         SELECT 1 FROM owner_insurance oi
         WHERE oi.properties != '' AND COALESCE(oi.expiration_date,'') != ''
           AND date(oi.expiration_date) >= date('now')
            AND (
              lower(trim(oi.properties)) = lower(trim(p.property_name))
              OR instr(',' || lower(replace(oi.properties, ', ', ',')) || ',',
                       ',' || lower(trim(p.property_name)) || ',') > 0
             )
        )${group.sql}`, group.params).c);
  return {
    value: total ? round((covered / total) * 100) : null,
    detail: covered + " of " + total + " properties covered by an active policy",
  };
}

function selectedGroupClause(alias, groupId) {
  if (!groupId) return { sql: "", params: [] };
  const group = one("SELECT label FROM property_groups WHERE id = ?", [groupId]);
  if (!group.label) return { sql: " AND 1 = 0", params: [] };
  return { sql: ` AND EXISTS (SELECT 1 FROM property_group_members pgm WHERE pgm.group_id = ? AND pgm.property_id = ${alias}.id)`, params: [groupId] };
}

function groupInfo(groupId) {
  if (!groupId) return { id: null, label: "All properties", rawId: null, valid: true };
  const row = one(`SELECT pg.id, pg.label raw_label, COALESCE(NULLIF(pgc.display_name,''), pg.label) label
    FROM property_groups pg LEFT JOIN property_group_config pgc ON pgc.group_id = pg.id WHERE pg.id = ?`, [groupId]);
  return row.id
    ? { id: row.id, label: row.label, rawId: row.id.includes(":") ? row.id.slice(row.id.indexOf(":") + 1) : row.id, valid: true }
    : { id: groupId, label: "Unavailable property group", rawId: groupId, valid: false };
}

function effectiveScope(config, settings) {
  const override = config.property_group_override || null;
  const info = groupInfo(override || settings.bonus_eligible_property_group || null);
  return { ...info, source: override ? "kpi_override" : (settings.bonus_eligible_property_group ? "global" : "all"),
    differsFromGlobal: !!override && override !== (settings.bonus_eligible_property_group || null) };
}

function unavailableScopedMetric(scope, reason) {
  return {
    value: null,
    detail: "Unavailable for property-scoped calculation",
    dataQuality: `${reason} The ${scope.label} scope was not silently ignored.`,
  };
}

function kpiCleanMoveIn(qs, qe, scope) {
  const group = selectedGroupClause("p", scope.id);
  const rows = many(
    `SELECT u.id, SUM(CASE WHEN w.id IS NOT NULL AND NOT ${TURNOVER_WO} THEN 1 ELSE 0 END) wo_count
     FROM units u
     LEFT JOIN work_orders w
       ON w.unit_id = u.id AND w.created_date != ''
      AND w.created_date >= u.move_in_date
      AND w.created_date <= date(u.move_in_date, '+30 days')
      LEFT JOIN properties p ON p.id = u.property_id
      WHERE u.move_in_date >= ? AND u.move_in_date < ? AND ${REVENUE_UNIT}${group.sql}
     GROUP BY u.id`,
    [qs, qe, ...group.params]
  );
  const clean = rows.filter((r) => num(r.wo_count) === 0).length;
  return {
    value: rows.length ? round((clean / rows.length) * 100) : null,
    detail: clean + " clean of " + rows.length + " move-ins",
  };
}

function kpiWo30Days(qs, qe, scope) {
  const group = selectedGroupClause("p", scope.id);
  const r = one(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN julianday(completed_date) - julianday(created_date) <= 30 THEN 1 ELSE 0 END) fast
     FROM work_orders w LEFT JOIN properties p ON p.id = w.property_id
      WHERE completed_date != '' AND created_date != '' AND completed_date >= created_date
        AND completed_date >= ? AND completed_date < ?
         AND (LOWER(COALESCE(assigned_user,'')) LIKE '%bong%' OR LOWER(COALESCE(assigned_user,'')) LIKE '%scott%')${group.sql}`,
    [qs, qe, ...group.params]
  );
  // Data-quality: work orders stuck in New/Assigned for 30+ days suggest
  // statuses aren't being moved, which silently skews completion metrics.
  const stuck = num(one(
    `SELECT COUNT(*) c FROM work_orders
     WHERE status IN ('New','Assigned') AND created_date != ''
       AND julianday('now') - julianday(created_date) > 30`).c);
  const open = num(one(
    `SELECT COUNT(*) c FROM work_orders
     WHERE status NOT IN ('Completed','Canceled','Completed No Need To Bill')`).c);
  return {
    value: num(r.total) ? round((num(r.fast) / num(r.total)) * 100) : null,
    detail: num(r.fast) + " of " + num(r.total) + " in-house (Bong/Scott) work orders completed within 30 days",
    dataQuality: open > 0 && stuck / open > 0.3
      ? stuck + " open work orders have sat in New/Assigned for 30+ days — status data may be unreliable." : null,
  };
}

export function computeQuarterUtilization(qs, qe, quarter) {
  // Quarterly utilization per tech, same rules as the monthly Operations
  // worksheet: billable = AppFolio labor + manual "other billable"; available
  // = scheduled hours (8h × elapsed workdays, overridable per employee per
  // quarter) − PTO/sick. PTO never counts against the tech.
  const today = new Date().toISOString().slice(0, 10);
  const effEnd = qe > today ? today : qe; // current quarter: elapsed only
  const defaultScheduled = workdaysBetween(qs, effEnd) * 8;
  const months = monthsInQuarter(quarter);
  const logged = many(
    "SELECT tech, SUM(worked_hours) h, COUNT(*) entries FROM labor_entries WHERE work_date >= ? AND work_date < ? AND tech != '' GROUP BY tech",
    [qs, qe]
  );
  // PTO still comes from the manual worksheet; "other billable" hours now
  // come exclusively from the approved rows of the shared Google Sheet
  // (replacing direct in-dashboard entry, per spec).
  const adj = many(
    `SELECT tech, SUM(pto_hours) pto FROM labor_adjustments WHERE period IN (${months.map(() => "?").join(",")}) GROUP BY tech`,
    months
  );
  const sheet = many(
    "SELECT employee, SUM(hours) h FROM sheet_billable_hours WHERE approved_by != '' AND work_date >= ? AND work_date < ? GROUP BY employee",
    [qs, qe]
  );
  const overrides = many("SELECT employee, scheduled_hours FROM team_overrides WHERE quarter = ?", [quarter]);
  const ovMap = new Map(overrides.map((o) => [o.employee.toLowerCase(), num(o.scheduled_hours)]));
  const byTech = new Map();
  for (const r of logged) byTech.set(r.tech, { tech: r.tech, logged: round(num(r.h), 2), entries: num(r.entries), pto: 0, extra: 0 });
  for (const a of adj) {
    const t = byTech.get(a.tech) || { tech: a.tech, logged: 0, entries: 0, pto: 0, extra: 0 };
    t.pto = round(num(a.pto), 2);
    byTech.set(a.tech, t);
  }
  for (const s of sheet) {
    // Match sheet employee names to AppFolio tech names on shared name words
    const t = matchTech([...byTech.values()], s.employee) || (() => {
      const nt = { tech: s.employee, logged: 0, entries: 0, pto: 0, extra: 0 };
      byTech.set(s.employee, nt);
      return nt;
    })();
    t.extra = round(t.extra + num(s.h), 2);
  }
  return [...byTech.values()].map((t) => {
    const scheduled = ovMap.has(t.tech.toLowerCase()) && ovMap.get(t.tech.toLowerCase()) > 0
      ? ovMap.get(t.tech.toLowerCase()) : defaultScheduled;
    const available = Math.max(scheduled - t.pto, 0);
    const billable = round(t.logged + t.extra, 2);
    return { ...t, scheduled: round(scheduled, 2), available: round(available, 2), billable,
      utilization: available ? round((billable / available) * 100) : 0 };
  });
}

function matchTech(techs, employeeName) {
  // labor_entries tech names come from AppFolio; match loosely on any word of
  // the roster name (e.g. 'Bong' matches 'Lobrigo "Bong" Manasan').
  const words = employeeName.toLowerCase().replace(/["']/g, "").split(/[\s,]+/).filter((w) => w.length > 2);
  return techs.find((t) => {
    const tl = t.tech.toLowerCase();
    return words.some((w) => tl.includes(w));
  });
}

function kpiUtilization(qs, qe, quarter, employeeName) {
  const techs = computeQuarterUtilization(qs, qe, quarter);
  const t = matchTech(techs, employeeName);
  if (!t) return { value: null, detail: "No labor entries found for " + employeeName + " this quarter" };
  return {
    value: t.utilization,
    detail: t.billable + "h billable of " + t.available + "h available (" + t.pto + "h PTO excluded)",
  };
}

function kpiInspections(qs, qe, scope) {
  const group = selectedGroupClause("p", scope.id);
  // Units credited: sum of unit_count for properties with a Building
  // Walkthrough completed in the quarter (deduped per property).
  const rows = many(
    `SELECT i.property_id, MAX(COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on)) done_on,
            COALESCE(p.unit_count, 0) unit_count
     FROM inspections i
     LEFT JOIN properties p ON p.id = i.property_id
     WHERE LOWER(i.inspection_name) LIKE '%building walkthrough%'
       AND COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on) >= ?
        AND COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on) < ?${group.sql}
     GROUP BY i.property_id`,
    [qs, qe, ...group.params]
  );
  const units = rows.reduce((s, r) => s + num(r.unit_count), 0);
  const months = Math.max(1, Math.round((new Date(qe) - new Date(qs)) / 2629800000));
  const zeroCount = rows.filter((r) => num(r.unit_count) === 0).length;
  return {
    value: rows.length ? round(units / months, 1) : 0,
    detail: units + " units across " + rows.length + " properties inspected (" + round(units / months, 1) + "/month); contributors: Scott and Bong",
    dataQuality: zeroCount > 0
      ? zeroCount + " inspected propert" + (zeroCount === 1 ? "y has" : "ies have") + " no unit count on file — units may be under-credited." : null,
  };
}

function kpiDelinquentRent(scope) {
  // Rent-only delinquency: utility billbacks and other non-rent charge types
  // excluded by construction (receivable_charges categorizes each charge).
  const chargeGroup = selectedGroupClause("p", scope.id);
  const unitGroup = selectedGroupClause("p", scope.id);
  const r = one(`SELECT SUM(rc.amount_receivable) s, COUNT(DISTINCT COALESCE(NULLIF(rc.occupancy_id,''), rc.payer_name)) c
    FROM receivable_charges rc LEFT JOIN properties p ON p.id = rc.property_id
    WHERE rc.charge_category = 'Rent'${chargeGroup.sql}`, chargeGroup.params);
  const rent = num(one(`SELECT SUM(u.current_rent) s FROM units u LEFT JOIN properties p ON p.id = u.property_id
    WHERE u.current_rent > 0${unitGroup.sql}`, unitGroup.params).s);
  return { value: rent ? round((num(r.s) / rent) * 100, 2) : null,
    detail: num(r.c) + " accounts owing rent; " + (rent ? "$" + round(num(r.s), 2) + " / $" + round(rent, 2) + " monthly rent" : "monthly rent denominator unavailable"),
    dataQuality: "Provisional current-state reading — capture a locked month-end/quarter-end result before treating delinquency as final." };
}

function kpiVendorIns(settings) {
  const vendors = many("SELECT liability_expires, custom_fields FROM vendors WHERE status != 'do_not_use'");
  const customKey = String(settings.vendor_exemption_field || "");
  const isExempt = (v) => {
    const overTenYears = v.liability_expires && new Date(v.liability_expires) > new Date(Date.now() + 10 * 365.25 * 86400000);
    let custom = false;
    try {
      const value = JSON.parse(v.custom_fields || "{}")[customKey];
      custom = value === true || value === 1 || ["yes", "true", "1", "y"].includes(String(value || "").trim().toLowerCase());
    } catch {}
    return overTenYears || custom;
  };
  const exempt = vendors.filter(isExempt).length;
  const counted = vendors.filter((v) => !isExempt(v));
  const current = counted.filter((v) => v.liability_expires && new Date(v.liability_expires) >= new Date()).length;
  return { value: counted.length ? round((current / counted.length) * 100) : null,
    detail: current + " of " + counted.length + " active vendors current; " + exempt + " exempt" };
}

function kpiRentersIns(scope) {
  const group = selectedGroupClause("p", scope.id);
  const total = num(one(`SELECT COUNT(*) c FROM tenant_insurance ti
    LEFT JOIN properties p ON lower(trim(p.property_name)) = lower(trim(ti.property_name))
    WHERE ti.status = 'Current'${group.sql}`, group.params).c);
  const tracked = num(one(
    `SELECT COUNT(*) c FROM tenant_insurance ti
     LEFT JOIN properties p ON lower(trim(p.property_name)) = lower(trim(ti.property_name))
     WHERE ti.status = 'Current' AND ti.insurance_expiration != ''${group.sql}`, group.params).c);
  return { value: total ? round((tracked / total) * 100) : null, detail: tracked + " of " + total + " current tenants tracked" };
}

const COMPUTERS = {
  pm_vacancy_days: (qs, qe, q, emp, settings, scope) => kpiVacancyDays(qs, qe, scope),
  pm_owner_insurance: (qs, qe, q, emp, settings, scope) => kpiOwnerInsurance(scope),
  pm_days_on_market: () => ({ value: null, detail: "Not yet configured" }),
  pm_days_to_lease: () => ({ value: null, detail: "Not yet configured" }),
  pm_inspections: (qs, qe, q, emp, settings, scope) => kpiInspections(qs, qe, scope),
  mnt_clean_movein: (qs, qe, q, emp, settings, scope) => kpiCleanMoveIn(qs, qe, scope),
  mnt_wo_30days: (qs, qe, q, emp, settings, scope) => kpiWo30Days(qs, qe, scope),
  mnt_wo_ttc: () => ({ value: null, detail: "Not yet configured" }),
  mnt_util_bong: (qs, qe, q, emp, settings, scope) => scope.id
    ? unavailableScopedMetric(scope, "Approved sheet hours and PTO/scheduled-hour adjustments have no reliable property ID.")
    : kpiUtilization(qs, qe, q, emp),
  mnt_util_scott: (qs, qe, q, emp, settings, scope) => scope.id
    ? unavailableScopedMetric(scope, "Approved sheet hours and PTO/scheduled-hour adjustments have no reliable property ID.")
    : kpiUtilization(qs, qe, q, emp),
  bk_delinquent_rent: (qs, qe, q, emp, settings, scope) => kpiDelinquentRent(scope),
  bk_vendor_ins: (qs, qe, q, emp, settings, scope) => scope.id
    ? unavailableScopedMetric(scope, "Vendor records are not attributable to properties.")
    : kpiVendorIns(settings),
  bk_renters_ins: (qs, qe, q, emp, settings, scope) => kpiRentersIns(scope),
};

// ── Tier scoring ────────────────────────────────────────────────────────────

export function scoreTier(value, tiers, direction, strict = false) {
  // Highest tier whose threshold is met, respecting direction. Null thresholds
  // = not configured → no tier, no payout.
  if (value == null) return { tier: null, payout: 0 };
  const order = ["best", "better", "good"];
  for (const t of order) {
    const th = tiers[t] && tiers[t].threshold;
    if (th == null) continue;
    const met = direction === "lower_is_better" ? (strict ? value < th : value <= th) : value >= th;
    if (met) return { tier: t, payout: num(tiers[t].payout) };
  }
  return { tier: "none", payout: 0 };
}

// ── Full quarter computation ────────────────────────────────────────────────

export function incentiveShares(total, count) {
  if (!count) return [];
  const cents = Math.round(num(total) * 100);
  const base = Math.floor(cents / count);
  const remainder = cents - base * count;
  return Array.from({ length: count }, (_, index) => (base + (index < remainder ? 1 : 0)) / 100);
}

export function computeTeamQuarter(quarter, propertyGroupScope = "configured", { forcePointInTime = false } = {}) {
  seedKpiConfig();
  const settings = { ...getTeamSettings() };
  if (propertyGroupScope === "all") settings.bonus_eligible_property_group = "";
  else if (propertyGroupScope && propertyGroupScope !== "configured") settings.bonus_eligible_property_group = propertyGroupScope;
  quarter = normalizeQuarter(quarter);
  const [qs, qe] = quarterBounds(quarter);
  const roster = many("SELECT * FROM kpi_roster WHERE active = 1 ORDER BY sort").map((r) => ({
    ...r, allocations: JSON.parse(r.allocations || "{}"),
  }));
  const empById = new Map(roster.map((r) => [r.id, r]));
  const configs = many("SELECT * FROM kpi_config ORDER BY department, sort").map((c) => ({
    ...c, tiers: JSON.parse(c.tiers || "{}"),
  }));

  // Point-in-time KPIs measure the *current* state of AppFolio (insurance
  // coverage, receivables) — they cannot be reconstructed for a past quarter.
  // For historical quarters they only exist via a locked snapshot; computing
  // them live would score today's state as if it were the quarter's result.
  const POINT_IN_TIME = new Set(["pm_owner_insurance", "bk_delinquent_rent", "bk_vendor_ins", "bk_renters_ins"]);
  // Snapshots explicitly force these live-state metrics to be computed. This
  // keeps a quarter-close snapshot complete if its final sync crosses midnight.
  const isCurrentQ = forcePointInTime || quarter === currentQuarter();

  const kpis = configs.map((c) => {
    const emp = c.assigned_to ? empById.get(c.assigned_to) : null;
    const propertyScope = effectiveScope(c, settings);
    let comp = { value: null, detail: null };
    if (c.active) {
      if (!propertyScope.valid) {
        comp = unavailableScopedMetric(propertyScope, `Configured group ID ${propertyScope.rawId} is not present in the latest verified property directory.`);
      } else if (!isCurrentQ && POINT_IN_TIME.has(c.id)) {
        comp = { value: null, detail: "Point-in-time metric — not measurable for a past quarter without a locked snapshot",
          dataQuality: "This KPI reflects live AppFolio state. Snapshot each quarter before it closes to preserve its value." };
      } else {
        const fn = COMPUTERS[c.id];
        comp = fn ? fn(qs, qe, quarter, emp ? emp.name : null, settings, propertyScope) : { value: null, detail: "No computation wired for this KPI" };
      }
    }
    const configured = ["good", "better", "best"].some((t) => c.tiers[t] && c.tiers[t].threshold != null);
    const { tier } = c.active && configured ? scoreTier(comp.value, c.tiers, c.direction, c.id === "bk_delinquent_rent") : { tier: null };
    return {
      id: c.id, department: c.department, label: c.label, description: c.description,
      scope: c.scope, assignedTo: c.assigned_to, assignedName: emp ? emp.name : null,
      dataSource: c.data_source, direction: c.direction, unit: c.unit,
      tiers: c.tiers, active: !!c.active, configured,
      value: comp.value, detail: comp.detail || null, dataQuality: comp.dataQuality || null,
      propertyScope,
      tier, payout: 0, maxPayout: 0,
      drill: "team_" + c.id,
    };
  });

  // Department rollups identify which employees receive each shared result.
  const deptNames = [...new Set(configs.map((c) => c.department))];
  const departments = deptNames.map((dept) => {
    const deptKpis = kpis.filter((k) => k.department === dept && k.scope === "department");
    const indKpis = kpis.filter((k) => k.department === dept && k.scope === "individual");
    const members = roster.filter((r) => num(r.allocations[dept]) > 0)
      .map((r) => ({ id: r.id, name: r.name, weight: num(r.allocations[dept]) }));
    const totalWeight = members.reduce((s, m) => s + m.weight, 0);
    members.forEach((m) => { m.share = totalWeight ? round(m.weight / totalWeight, 4) : 0; });
    return { department: dept, kpis: deptKpis, individualKpis: indKpis, members, earned: 0, max: 0 };
  });

  // Per-employee bonuses: at most four weighted KPI results, all weighted
  // equally. Department results apply to each department member, rather than
  // being a share-weighted pool. Extra configured results are visible as
  // expectations but cannot silently inflate the quarterly incentive.
  const employees = roster.map((r) => {
    const candidates = [];
    for (const d of departments) {
      const m = d.members.find((x) => x.id === r.id);
      if (!m) continue;
      for (const k of d.kpis) {
        if (k.active && k.configured) candidates.push({ ...k, type: "department" });
      }
    }
    for (const k of kpis.filter((x) => x.scope === "individual" && x.assignedTo === r.id)) {
      if (k.active && k.configured) candidates.push({ ...k, type: "individual" });
    }
    const weighted = candidates.slice(0, 4);
    const expectations = candidates.slice(4);
    const possibleShares = incentiveShares(settings.quarterly_incentive, weighted.length);
    const payouts = settings.tier_payouts || {};
    const breakdown = weighted.map((k, index) => ({
      kpi: k.label, department: k.department, type: k.type, share: 1,
      tier: k.tier, payout: round(possibleShares[index] * num(payouts[k.tier]), 2),
      maxPayout: possibleShares[index],
    }));
    const earned = breakdown.reduce((s, b) => s + b.payout, 0);
    const max = breakdown.reduce((s, b) => s + b.maxPayout, 0);
    return { id: r.id, name: r.name, role: r.role, allocations: r.allocations,
      earned: round(earned, 2), max: round(max, 2), breakdown,
      weightedKpiCount: weighted.length,
      expectations: expectations.map((k) => ({ kpi: k.label, tier: k.tier, department: k.department })),
      quarterlyIncentive: num(settings.quarterly_incentive),
      ytdEarned: round(earned, 2),
      ytdPossible: round(max, 2),
      stretch: { status: "pending", eligible: false, reason: "Historical quarter snapshots are required." },
    };
  });

  // Add prior locked 2026 results to YTD. Old-format snapshots are deliberately
  // not reinterpreted as new payouts; they remain frozen and are called out.
  const prior = many("SELECT quarter, payload FROM quarter_results WHERE quarter LIKE ? AND quarter < ?", [`${quarter.slice(0, 4)}-Q%`, quarter]);
  for (const s of prior) {
    try {
      const old = JSON.parse(s.payload);
      for (const e of employees) {
        const oldEmp = (old.employees || []).find((x) => x.id === e.id);
        if (oldEmp && Number.isFinite(Number(oldEmp.earned))) {
          e.ytdEarned = round(e.ytdEarned + num(oldEmp.earned), 2);
          e.ytdPossible = round(e.ytdPossible + num(oldEmp.max), 2);
        }
      }
    } catch { /* corrupted snapshot remains unavailable rather than invented */ }
  }
  for (const e of employees) e.stretch = stretchStatus(e.id, quarter.slice(0, 4), settings);

  // Google Sheet ("other billable hours") sync health + quarter totals for
  // the audit view — the UI must show failures visibly, never silently.
  let sheetSync = null;
  try {
    const st = one("SELECT value FROM app_state WHERE key = 'sheet_sync'");
    sheetSync = st.value ? JSON.parse(st.value) : null;
  } catch { /* table may predate feature */ }
  const sq = one(
    `SELECT SUM(CASE WHEN approved_by != '' THEN hours ELSE 0 END) approved,
            SUM(CASE WHEN approved_by = '' THEN hours ELSE 0 END) pending,
            COUNT(*) rows FROM sheet_billable_hours WHERE work_date >= ? AND work_date < ?`, [qs, qe]);
  if (sheetSync) sheetSync.quarterHours = { approved: round(num(sq.approved), 2), pending: round(num(sq.pending), 2), rows: num(sq.rows) };

  return {
    quarter, quarterStart: qs, quarterEnd: qe,
    isCurrent: quarter === currentQuarter(),
    computedAt: new Date().toISOString(),
    snapshot: null,
    settings: { quarterlyIncentive: num(settings.quarterly_incentive), stretchBonus: num(settings.stretch_bonus), tierPayouts: settings.tier_payouts },
    sheetSync,
    kpis, departments, employees,
    quarters: listQuarters(),
  };
}

// Re-score captured historical values against the current thresholds. Snapshot
// values are the historical evidence; no live current-state metric is used to
// fabricate a prior period. The original locked payout is not returned as a
// retroactive score.
function rescoreSnapshot(payload, quarter, settings = getTeamSettings()) {
  const data = JSON.parse(JSON.stringify(payload));
  const configs = new Map(many("SELECT * FROM kpi_config").map((c) => [c.id, { ...c, tiers: JSON.parse(c.tiers || "{}") }]));
  data.kpis = (data.kpis || []).map((k) => {
    const c = configs.get(k.id);
    if (!c) return { ...k, tier: null, dataQuality: "Historical KPI definition is no longer available." };
    const tier = k.value == null ? null : scoreTier(k.value, c.tiers, c.direction, c.id === "bk_delinquent_rent").tier;
    return { ...k, label: c.label, description: c.description, direction: c.direction, unit: c.unit, tiers: c.tiers,
      configured: !!c.active && ["good", "better", "best"].some((t) => c.tiers[t]?.threshold != null),
      active: !!c.active, tier, payout: 0, maxPayout: 0,
      dataQuality: k.value == null ? (k.dataQuality || "Unavailable historical point-in-time metric.") : k.dataQuality };
  });
  const byId = new Map(data.kpis.map((k) => [k.id, k]));
  data.departments = (data.departments || []).map((d) => ({
    ...d,
    kpis: (d.kpis || []).map((k) => byId.get(k.id) || k),
    individualKpis: (d.individualKpis || []).map((k) => byId.get(k.id) || k),
  }));
  data.employees = (data.employees || []).map((employee) => {
    const candidates = data.kpis.filter((k) => k.active && k.configured &&
      ((k.scope === "individual" && k.assignedTo === employee.id) ||
        (k.scope === "department" && num((employee.allocations || {})[k.department]) > 0)))
      .slice(0, 4);
    const possibleShares = incentiveShares(settings.quarterly_incentive, candidates.length);
    const breakdown = candidates.map((k, index) => ({
      kpi: k.label, department: k.department, type: k.scope, tier: k.tier, share: 1,
      payout: round(possibleShares[index] * num(settings.tier_payouts?.[k.tier]), 2), maxPayout: possibleShares[index],
    }));
    return { ...employee, breakdown, weightedKpiCount: candidates.length,
      expectations: [], earned: round(breakdown.reduce((s, b) => s + b.payout, 0), 2),
      max: round(breakdown.reduce((s, b) => s + b.maxPayout, 0), 2),
      ytdEarned: round(breakdown.reduce((s, b) => s + b.payout, 0), 2),
      ytdPossible: round(breakdown.reduce((s, b) => s + b.maxPayout, 0), 2) };
  });
  data.retroactive = true;
  data.retroactiveNotice = "Historical captured values have been re-scored using current thresholds. Missing point-in-time values remain unavailable.";
  return data;
}

function stretchStatus(employeeId, year, settings) {
  const expected = [1, 2, 3, 4].map((n) => `${year}-Q${n}`);
  const snapshots = new Map(many("SELECT quarter, payload FROM quarter_results WHERE quarter LIKE ?", [`${year}-Q%`]).map((r) => [r.quarter, r.payload]));
  const results = [];
  for (const quarter of expected) {
    const raw = snapshots.get(quarter);
    if (!raw) return { status: "pending", eligible: false, reason: `${quarter} has no locked snapshot.` };
    try {
      const e = rescoreSnapshot(JSON.parse(raw), quarter, settings).employees.find((x) => x.id === employeeId);
      if (!e || !Array.isArray(e.breakdown) || !e.breakdown.length) return { status: "pending", eligible: false, reason: `${quarter} has no complete KPI result.` };
      if (e.breakdown.some((b) => b.tier == null)) return { status: "pending", eligible: false, reason: `${quarter} contains an unavailable KPI result.` };
      results.push(...e.breakdown);
    } catch { return { status: "pending", eligible: false, reason: `${quarter} snapshot cannot be evaluated.` }; }
  }
  if (results.some((b) => b.tier === "good" || b.tier === "none")) {
    return { status: "not eligible", eligible: false, reason: "A Good or Below Good KPI result disqualifies the stretch bonus." };
  }
  const bestRatio = results.filter((b) => b.tier === "best").length / results.length;
  return bestRatio >= num(settings.stretch_best_ratio)
    ? { status: "eligible", eligible: true, bestRatio: round(bestRatio * 100, 1), amount: num(settings.stretch_bonus) }
    : { status: "not eligible", eligible: false, bestRatio: round(bestRatio * 100, 1), reason: "Fewer than " + (num(settings.stretch_best_ratio) * 100) + "% of KPI-quarter results are Best." };
}

// ── Snapshots (quarter locking) ─────────────────────────────────────────────

export function getTeamQuarter(quarter, retroactive = false, propertyGroupScope = "configured") {
  seedKpiConfig();
  quarter = normalizeQuarter(quarter);
  const snap = one("SELECT payload, snapshot_at FROM quarter_results WHERE quarter = ?", [quarter]);
  if (snap.payload && quarter !== currentQuarter()) {
    const data = retroactive ? rescoreSnapshot(JSON.parse(snap.payload), quarter) : JSON.parse(snap.payload);
    delete data.historicalUnallocatedBonus;
    delete data.historicalAdjustment;
    data.snapshot = { at: snap.snapshot_at, locked: true };
    data.quarters = listQuarters();
    if (retroactive) {
      data.employees.forEach((e) => { e.stretch = stretchStatus(e.id, quarter.slice(0, 4), getTeamSettings()); });
    }
    return data;
  }
  const data = computeTeamQuarter(quarter, propertyGroupScope);
  if (snap.payload) data.snapshot = { at: snap.snapshot_at, locked: false }; // current quarter: snapshot exists but live shown
  else if (!data.isCurrent) data.notLocked = true; // historical, never snapshotted
  return data;
}

export function historicalAdjustments() {
  return many("SELECT quarter, payload FROM quarter_results ORDER BY quarter").flatMap((row) => {
    try {
      const payload = JSON.parse(row.payload);
      return num(payload.historicalUnallocatedBonus) > 0 ? [{
        quarter: row.quarter,
        amount: num(payload.historicalUnallocatedBonus),
        note: payload.historicalAdjustment || "Retired share was not redistributed.",
      }] : [];
    } catch { return []; }
  });
}

export function snapshotQuarter(quarter, replaceExisting = false) {
  quarter = normalizeQuarter(quarter);
  if (quarter > currentQuarter()) throw new Error("Cannot snapshot a future quarter");
  if (quarter !== currentQuarter() && one("SELECT quarter FROM quarter_results WHERE quarter = ?", [quarter]).quarter && !replaceExisting) {
    const err = new Error("Closed quarter is already locked. Explicit owner replacement is required.");
    err.statusCode = 409;
    throw err;
  }
  const data = computeTeamQuarter(quarter, "configured", { forcePointInTime: true });
  // Freeze the records shown behind each KPI along with the calculated values.
  // Group membership and source rows are mutable AppFolio state, so retaining
  // only a group ID would let a historical drilldown silently change later.
  data.snapshotDrilldowns = {};
  for (const kpi of data.kpis || []) {
    if (kpi.value == null) {
      data.snapshotDrilldowns[kpi.id] = {
        title: `${kpi.label} — ${quarter}`,
        cols: [], rows: [], propertyScope: kpi.propertyScope,
        scopeNotice: "This KPI value was unavailable when the snapshot was taken. Current live records are not substituted.",
        historicalUnavailable: true,
      };
    } else {
      const drilldown = getTeamDrilldown(kpi.drill, quarter, "configured", {
        ignoreSnapshot: true,
        forcedScope: kpi.propertyScope,
      });
      if (drilldown) data.snapshotDrilldowns[kpi.id] = drilldown;
    }
  }
  run(`INSERT INTO quarter_results (quarter, payload, snapshot_at) VALUES (?, ?, ?)
       ON CONFLICT(quarter) DO UPDATE SET payload = excluded.payload, snapshot_at = excluded.snapshot_at`,
    [quarter, JSON.stringify(data), new Date().toISOString()]);
  return { ok: true, quarter, snapshotAt: new Date().toISOString() };
}

// ── Drilldowns ──────────────────────────────────────────────────────────────

const LIM = 500;
export function getTeamDrilldown(key, quarter, propertyGroupScope = "configured", options = {}) {
  seedKpiConfig();
  quarter = normalizeQuarter(quarter);
  const [qs, qe] = quarterBounds(quarter);
  const id = key.replace(/^team_/, "");
  const settings = { ...getTeamSettings() };
  if (propertyGroupScope === "all") settings.bonus_eligible_property_group = "";
  else if (propertyGroupScope && propertyGroupScope !== "configured") settings.bonus_eligible_property_group = propertyGroupScope;
  const config = one("SELECT * FROM kpi_config WHERE id = ?", [id]);
  let propertyScope = options.forcedScope || effectiveScope(config, settings);
  const locked = options.ignoreSnapshot ? {} : one("SELECT payload FROM quarter_results WHERE quarter = ?", [quarter]);
  if (locked.payload && quarter !== currentQuarter()) {
    try {
      const payload = JSON.parse(locked.payload);
      const frozenDrilldown = payload.snapshotDrilldowns?.[id];
      if (frozenDrilldown) return JSON.parse(JSON.stringify(frozenDrilldown));
      const frozenKpi = (payload.kpis || []).find((k) => k.id === id);
      const scopeText = frozenKpi?.propertyScope
        ? `Captured scope: ${frozenKpi.propertyScope.label}${frozenKpi.propertyScope.rawId ? ` (raw ID: ${frozenKpi.propertyScope.rawId})` : ""}.`
        : "The historical property scope was not captured.";
      return {
        title: `Historical drilldown unavailable — ${quarter}`,
        cols: [],
        rows: [],
        propertyScope: frozenKpi?.propertyScope || null,
        scopeNotice: `${scopeText} This older snapshot did not capture its drilldown records, so current configuration, group membership, and live source rows are not substituted.`,
        historicalUnavailable: true,
      };
    } catch {
      return {
        title: `Historical drilldown unavailable — ${quarter}`,
        cols: [], rows: [], propertyScope: null, historicalUnavailable: true,
        scopeNotice: "The locked snapshot cannot be read. Live records are not substituted for historical evidence.",
      };
    }
  }
  const group = selectedGroupClause("p", propertyScope.id);
  const mk = (title, cols, rows, notice = null) => ({
    title: title + " — " + quarter, cols, rows, propertyScope,
    scopeNotice: notice || (propertyScope.id ? `Counted property scope: ${propertyScope.label} (raw ID: ${propertyScope.rawId})` : "Counted property scope: All properties"),
  });
  if (!propertyScope.valid) return mk("Property scope unavailable", [], [],
    `Configured group ID ${propertyScope.rawId} is not present in the latest property directory. No properties were substituted.`);
  switch (id) {
    case "pm_vacancy_days": {
      const leases = many(
        `SELECT lh.property_name, lh.unit_name, lh.tenant_name, lh.move_in, lh.unit_id FROM lease_history lh
         JOIN units u ON u.id = lh.unit_id LEFT JOIN properties p ON p.id = u.property_id
          WHERE lh.move_in >= ? AND lh.move_in < ? AND lh.unit_id != '' AND ${REVENUE_UNIT}${group.sql}
          ORDER BY lh.move_in DESC LIMIT ${LIM}`, [qs, qe, ...group.params]);
      const rows = leases.map((l) => {
        const prev = one(
          `SELECT COALESCE(NULLIF(move_out,''), lease_end) prev_end FROM lease_history
           WHERE unit_id = ? AND move_in < ? AND COALESCE(NULLIF(move_out,''), lease_end) != ''
           ORDER BY move_in DESC LIMIT 1`, [l.unit_id, l.move_in]);
        const gap = prev.prev_end ? Math.round((new Date(l.move_in) - new Date(prev.prev_end)) / 86400000) : null;
        return { property_name: l.property_name, unit_name: l.unit_name, tenant_name: l.tenant_name,
          prev_move_out: prev.prev_end || "(no prior record)", move_in: l.move_in,
          gap_days: gap != null && gap >= 0 && gap < 730 ? gap : "(excluded)" };
      });
      return mk("Vacancy Time — Re-leases", [
        { key: "property_name", label: "Property" }, { key: "unit_name", label: "Unit" },
        { key: "tenant_name", label: "New Tenant" }, { key: "prev_move_out", label: "Prev Move-out" },
        { key: "move_in", label: "Move-in" }, { key: "gap_days", label: "Vacant Days" }], rows);
    }
    case "pm_owner_insurance":
      return mk("Owner Insurance by Property", [
        { key: "property_name", label: "Property" }, { key: "covered", label: "Current Coverage" }],
        many(`SELECT p.property_name,
          CASE WHEN EXISTS (SELECT 1 FROM owner_insurance oi WHERE oi.properties != ''
            AND COALESCE(oi.expiration_date,'') != '' AND date(oi.expiration_date) >= date('now')
            AND (lower(trim(oi.properties)) = lower(trim(p.property_name))
              OR instr(',' || lower(replace(oi.properties, ', ', ',')) || ',',
                       ',' || lower(trim(p.property_name)) || ',') > 0)) THEN 'Yes' ELSE 'No' END covered
          FROM properties p WHERE TRIM(COALESCE(p.property_name,'')) != ''${group.sql}
          ORDER BY p.property_name LIMIT ${LIM}`, group.params));
    case "pm_inspections": {
      const rows = many(
        `SELECT i.property_name, COALESCE(p.unit_count, 0) unit_count,
                MAX(COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on)) inspected,
                COUNT(*) inspection_rows
         FROM inspections i LEFT JOIN properties p ON p.id = i.property_id
         WHERE LOWER(i.inspection_name) LIKE '%building walkthrough%'
           AND COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on) >= ?
            AND COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on) < ?${group.sql}
          GROUP BY i.property_id ORDER BY inspected DESC LIMIT ${LIM}`, [qs, qe, ...group.params]);
      // Rolling YTD % of portfolio
      const yStart = quarter.slice(0, 4) + "-01-01";
      const ytdUnits = num(one(
        `SELECT SUM(uc) s FROM (
           SELECT COALESCE(p.unit_count, 0) uc FROM inspections i
           LEFT JOIN properties p ON p.id = i.property_id
           WHERE LOWER(i.inspection_name) LIKE '%building walkthrough%'
              AND COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on) >= ?${group.sql}
            GROUP BY i.property_id)`, [yStart, ...group.params]).s);
      const unitGroup = selectedGroupClause("p", propertyScope.id);
      const totalUnits = num(one(`SELECT COUNT(*) c FROM units u LEFT JOIN properties p ON p.id = u.property_id
        WHERE 1=1${unitGroup.sql}`, unitGroup.params).c);
      const pct = totalUnits ? round((ytdUnits / totalUnits) * 100) : 0;
      return mk(`Building Walkthroughs (YTD: ${ytdUnits} units = ${pct}% of portfolio)`, [
          { key: "property_name", label: "Property" }, { key: "unit_count", label: "Units Credited" },
          { key: "inspected", label: "Inspection Date" }, { key: "inspection_rows", label: "Walkthroughs" }],
        rows);
    }
    case "mnt_clean_movein":
      return mk("Move-ins & Non-turnover Work Orders", [
        { key: "property_name", label: "Property" }, { key: "unit_name", label: "Unit" },
        { key: "tenant_name", label: "Tenant" }, { key: "move_in_date", label: "Move-in" },
        { key: "wo_count", label: "Non-turnover WOs" }, { key: "clean", label: "Clean" }],
        many(
          `SELECT u.property_name, u.unit_name, u.tenant_name, u.move_in_date,
                  SUM(CASE WHEN w.id IS NOT NULL AND NOT ${TURNOVER_WO} THEN 1 ELSE 0 END) wo_count,
                  CASE WHEN SUM(CASE WHEN w.id IS NOT NULL AND NOT ${TURNOVER_WO} THEN 1 ELSE 0 END) = 0 THEN 'Yes' ELSE 'No' END clean
            FROM units u
           LEFT JOIN work_orders w ON w.unit_id = u.id AND w.created_date != ''
             AND w.created_date >= u.move_in_date AND w.created_date <= date(u.move_in_date, '+30 days')
            LEFT JOIN properties p ON p.id = u.property_id
            WHERE u.move_in_date >= ? AND u.move_in_date < ? AND ${REVENUE_UNIT}${group.sql}
            GROUP BY u.id ORDER BY u.move_in_date DESC LIMIT ${LIM}`, [qs, qe, ...group.params]));
    case "mnt_wo_30days":
      return mk("Work Orders Completed in Quarter", [
        { key: "property_name", label: "Property" }, { key: "unit", label: "Unit" },
        { key: "description", label: "Description" }, { key: "created_date", label: "Created" },
        { key: "completed_date", label: "Completed" }, { key: "days", label: "Days" }],
        many(
          `SELECT w.property_name, w.unit, w.description, w.created_date, w.completed_date,
                  CAST(julianday(w.completed_date) - julianday(w.created_date) AS INTEGER) days
           FROM work_orders w LEFT JOIN properties p ON p.id = w.property_id
           WHERE w.completed_date != '' AND w.created_date != '' AND w.completed_date >= w.created_date
              AND w.completed_date >= ? AND w.completed_date < ?
               AND (LOWER(COALESCE(w.assigned_user,'')) LIKE '%bong%' OR LOWER(COALESCE(w.assigned_user,'')) LIKE '%scott%')${group.sql}
            ORDER BY days DESC LIMIT ${LIM}`, [qs, qe, ...group.params]));
    case "sheet_hours": {
      // Audit/reconciliation view: every sheet row in the quarter with its
      // approval status, so pending vs counted hours are transparent.
      return mk("Other Billable Hours (Google Sheet)", [
        { key: "work_date", label: "Date" }, { key: "employee", label: "Employee" },
        { key: "hours", label: "Hours" }, { key: "description", label: "Project / Description" },
        { key: "property_unit", label: "Property / Unit" }, { key: "status", label: "Status" },
        { key: "approved_by", label: "Approved By" }, { key: "approved_date", label: "Approved Date" },
        { key: "notes", label: "Notes" }],
        many(
          `SELECT work_date, employee, hours, description, property_unit,
                  CASE WHEN approved_by != '' THEN 'Approved (counted)' ELSE 'Pending (not counted)' END status,
                  approved_by, approved_date, notes
           FROM sheet_billable_hours
           WHERE work_date >= ? AND work_date < ?
           ORDER BY work_date DESC LIMIT ${LIM}`, [qs, qe]));
    }
    case "mnt_util_bong":
    case "mnt_util_scott": {
      if (propertyScope.id) return mk("Labor Entries", [], [],
        "This KPI cannot be computed for a property group: approved sheet hours and PTO/scheduled-hour adjustments have no reliable property ID. No unscoped rows are shown.");
      const emp = id === "mnt_util_bong" ? "Bong" : "Scott";
      return mk("Labor Entries — " + emp, [
        { key: "work_date", label: "Date" }, { key: "property_name", label: "Property" },
        { key: "unit", label: "Unit" }, { key: "worked_hours", label: "Hours" },
        { key: "work_order_number", label: "WO #" }, { key: "description", label: "Description" }],
        many(
          `SELECT work_date, property_name, unit, worked_hours, work_order_number, description
           FROM labor_entries
           WHERE work_date >= ? AND work_date < ? AND LOWER(tech) LIKE ?
           ORDER BY work_date DESC LIMIT ${LIM}`, [qs, qe, "%" + emp.toLowerCase() + "%"]));
    }
    case "bk_delinquent_rent":
      return mk("Delinquent Rent Charges (Rent Only)", [
        { key: "property_name", label: "Property" }, { key: "unit_name", label: "Unit" },
        { key: "payer_name", label: "Tenant" }, { key: "posting_date", label: "Posted" },
        { key: "amount_receivable", label: "Amount Due", money: true }],
        many(`SELECT rc.property_name, rc.unit_name, rc.payer_name, rc.posting_date, rc.amount_receivable
              FROM receivable_charges rc LEFT JOIN properties p ON p.id = rc.property_id
              WHERE rc.charge_category = 'Rent' AND rc.amount_receivable != 0${group.sql}
              ORDER BY rc.amount_receivable DESC LIMIT ${LIM}`, group.params));
    case "bk_vendor_ins":
      {
        if (propertyScope.id) return mk("Vendors — Liability Insurance", [], [],
          "Vendor records have no property attribution, so this KPI is unavailable for the selected property group. No unscoped vendor rows are shown.");
        const key = String(settings.vendor_exemption_field || "");
        const rows = many(`SELECT vendor_name, liability_expires, status, custom_fields FROM vendors WHERE status != 'do_not_use'`)
          .filter((v) => {
            const dateExempt = v.liability_expires && new Date(v.liability_expires) > new Date(Date.now() + 10 * 365.25 * 86400000);
            let custom = false;
            try {
              const value = JSON.parse(v.custom_fields || "{}")[key];
              custom = value === true || value === 1 || ["yes", "true", "1", "y"].includes(String(value || "").trim().toLowerCase());
            } catch {}
            return !dateExempt && !custom;
          }).sort((a, b) => String(a.liability_expires || "9999").localeCompare(String(b.liability_expires || "9999"))).slice(0, LIM);
      return mk("Vendors — Liability Insurance", [
        { key: "vendor_name", label: "Vendor" }, { key: "liability_expires", label: "Liability Expires" },
        { key: "status", label: "Status" }],
        rows);
      }
    case "bk_renters_ins":
      return mk("Current Tenants — Renter's Insurance", [
        { key: "tenant_name", label: "Tenant" }, { key: "property_name", label: "Property" },
        { key: "unit", label: "Unit" }, { key: "insurance_company", label: "Carrier" },
        { key: "insurance_expiration", label: "Expires" }],
        many(`SELECT ti.tenant_name, ti.property_name, ti.unit, ti.insurance_company, ti.insurance_expiration
              FROM tenant_insurance ti LEFT JOIN properties p ON lower(trim(p.property_name)) = lower(trim(ti.property_name))
              WHERE ti.status = 'Current'${group.sql}
              ORDER BY CASE WHEN ti.insurance_expiration = '' THEN 1 ELSE 0 END, ti.insurance_expiration LIMIT ${LIM}`, group.params));
    default:
      return null;
  }
}
