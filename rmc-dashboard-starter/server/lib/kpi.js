// ── Team Performance (KPIs & Bonuses) engine ─────────────────────────────────
// Config-driven quarterly KPI scorecard: department + individual KPIs, tiered
// payouts (Good/Better/Best), share-weighted department splits, quarter
// snapshots/locking, and per-KPI drilldowns. Nothing about thresholds or
// payouts is hardcoded here — all definitions live in kpi_config / kpi_roster.
import { query, queryOne, run } from "./db.js";

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
  return d.getFullYear() + "-Q" + (Math.floor(d.getMonth() / 3) + 1);
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
  // From 2025-Q1 through the current quarter, newest first.
  const out = [];
  const cur = currentQuarter();
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

export function seedKpiConfig() {
  if (num(one("SELECT COUNT(*) c FROM kpi_roster").c) === 0) {
    const roster = [
      ["john", "John Fedele", "Senior Property Manager", { "Property Management": 1 }, 1],
      ["mark", "Mark Felix", "Associate Property Manager", { "Property Management": 1 }, 2],
      ["fabian", "Fabian Buenrostro", "Maintenance Coordinator", { "Property Management": 0.5, "Maintenance": 0.5 }, 3],
      ["bong", "Lobrigo \"Bong\" Manasan", "Maintenance Technician", {}, 4],
      ["scott", "Scott C. Scott", "Maintenance Technician", {}, 5],
      ["melinda", "Melinda Greene", "Bookkeeper", { "Bookkeeping": 1 }, 6],
    ];
    for (const [id, name, role, alloc, sort] of roster) {
      run("INSERT INTO kpi_roster (id, name, role, allocations, active, sort) VALUES (?, ?, ?, ?, 1, ?)",
        [id, name, role, JSON.stringify(alloc), sort]);
    }
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
      // Property Management — individual (Mark)
      ["pm_inspections", "Property Management", "Building Inspections (Units Inspected)",
        "Units credited from 'Building Walkthrough' inspections completed in the quarter (units inspected, not properties).",
        "individual", "mark", "AppFolio inspection_detail report", "higher_is_better", "count",
        T(125, 146, 182, 0, 0, 0), 1, 5],
      // Maintenance — department
      ["mnt_clean_movein", "Maintenance", "Clean Move-in %",
        "Percent of move-ins in the quarter with zero non-turnover work orders in the first 30 days.",
        "department", null, "AppFolio work orders + rent roll", "higher_is_better", "percent",
        T(70, 80, 90, 0, 0, 0), 1, 1],
      ["mnt_wo_30days", "Maintenance", "Work Orders Completed ≤ 30 Days",
        "Percent of work orders completed in the quarter that were closed within 30 days of creation.",
        "department", null, "AppFolio work orders", "higher_is_better", "percent",
        T(75, 85, 95, 0, 0, 0), 1, 2],
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
        "Outstanding rent charges only — utility billbacks and other charges excluded (config-driven charge-type list).",
        "department", null, "AppFolio aged receivables (rent charges)", "lower_is_better", "currency", NULL_TIERS, 1, 1],
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
}

// ── KPI value computation ───────────────────────────────────────────────────
// Each computer returns { value, detail?, dataQuality? } for a quarter window.

function kpiVacancyDays(qs, qe) {
  // Gap = new tenant move_in minus previous occupancy's move_out (or lease_end)
  // on the same unit, for move-ins inside the quarter. Non-revenue excluded.
  const leases = many(
    `SELECT lh.unit_id, lh.move_in FROM lease_history lh
     JOIN units u ON u.id = lh.unit_id
     WHERE lh.move_in >= ? AND lh.move_in < ? AND lh.unit_id != '' AND ${REVENUE_UNIT}`,
    [qs, qe]
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

function kpiOwnerInsurance() {
  const total = num(one("SELECT COUNT(*) c FROM properties WHERE TRIM(COALESCE(property_name,'')) != ''").c);
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
       )`).c);
  return {
    value: total ? round((covered / total) * 100) : null,
    detail: covered + " of " + total + " properties covered by an active policy",
  };
}

function kpiCleanMoveIn(qs, qe) {
  const rows = many(
    `SELECT u.id, SUM(CASE WHEN w.id IS NOT NULL AND NOT ${TURNOVER_WO} THEN 1 ELSE 0 END) wo_count
     FROM units u
     LEFT JOIN work_orders w
       ON w.unit_id = u.id AND w.created_date != ''
      AND w.created_date >= u.move_in_date
      AND w.created_date <= date(u.move_in_date, '+30 days')
     WHERE u.move_in_date >= ? AND u.move_in_date < ? AND ${REVENUE_UNIT}
     GROUP BY u.id`,
    [qs, qe]
  );
  const clean = rows.filter((r) => num(r.wo_count) === 0).length;
  return {
    value: rows.length ? round((clean / rows.length) * 100) : null,
    detail: clean + " clean of " + rows.length + " move-ins",
  };
}

function kpiWo30Days(qs, qe) {
  const r = one(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN julianday(completed_date) - julianday(created_date) <= 30 THEN 1 ELSE 0 END) fast
     FROM work_orders
     WHERE completed_date != '' AND created_date != '' AND completed_date >= created_date
       AND completed_date >= ? AND completed_date < ?`,
    [qs, qe]
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
    detail: num(r.fast) + " of " + num(r.total) + " completed within 30 days",
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

function kpiInspections(qs, qe) {
  // Units credited: sum of unit_count for properties with a Building
  // Walkthrough completed in the quarter (deduped per property).
  const rows = many(
    `SELECT i.property_id, MAX(COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on)) done_on,
            COALESCE(p.unit_count, 0) unit_count
     FROM inspections i
     LEFT JOIN properties p ON p.id = i.property_id
     WHERE LOWER(i.inspection_name) LIKE '%building walkthrough%'
       AND COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on) >= ?
       AND COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on) < ?
     GROUP BY i.property_id`,
    [qs, qe]
  );
  const units = rows.reduce((s, r) => s + num(r.unit_count), 0);
  const zeroCount = rows.filter((r) => num(r.unit_count) === 0).length;
  return {
    value: rows.length ? units : (rows.length === 0 ? 0 : units),
    detail: units + " units across " + rows.length + " properties inspected",
    dataQuality: zeroCount > 0
      ? zeroCount + " inspected propert" + (zeroCount === 1 ? "y has" : "ies have") + " no unit count on file — units may be under-credited." : null,
  };
}

function kpiDelinquentRent() {
  // Rent-only delinquency: utility billbacks and other non-rent charge types
  // excluded by construction (receivable_charges categorizes each charge).
  const r = one("SELECT SUM(amount_receivable) s, COUNT(DISTINCT COALESCE(NULLIF(occupancy_id,''), payer_name)) c FROM receivable_charges WHERE charge_category = 'Rent'");
  return { value: round(num(r.s), 2), detail: num(r.c) + " accounts owing rent" };
}

function kpiVendorIns() {
  const total = num(one("SELECT COUNT(*) c FROM vendors WHERE status != 'do_not_use'").c);
  const current = num(one(
    "SELECT COUNT(*) c FROM vendors WHERE status != 'do_not_use' AND COALESCE(liability_expires,'') != '' AND date(liability_expires) >= date('now')").c);
  return { value: total ? round((current / total) * 100) : null, detail: current + " of " + total + " active vendors current" };
}

function kpiRentersIns() {
  const total = num(one("SELECT COUNT(*) c FROM tenant_insurance WHERE status = 'Current'").c);
  const tracked = num(one(
    "SELECT COUNT(*) c FROM tenant_insurance WHERE status = 'Current' AND insurance_expiration != ''").c);
  return { value: total ? round((tracked / total) * 100) : null, detail: tracked + " of " + total + " current tenants tracked" };
}

const COMPUTERS = {
  pm_vacancy_days: (qs, qe) => kpiVacancyDays(qs, qe),
  pm_owner_insurance: () => kpiOwnerInsurance(),
  pm_days_on_market: () => ({ value: null, detail: "Not yet configured" }),
  pm_days_to_lease: () => ({ value: null, detail: "Not yet configured" }),
  pm_inspections: (qs, qe) => kpiInspections(qs, qe),
  mnt_clean_movein: (qs, qe) => kpiCleanMoveIn(qs, qe),
  mnt_wo_30days: (qs, qe) => kpiWo30Days(qs, qe),
  mnt_wo_ttc: () => ({ value: null, detail: "Not yet configured" }),
  mnt_util_bong: (qs, qe, q, emp) => kpiUtilization(qs, qe, q, emp),
  mnt_util_scott: (qs, qe, q, emp) => kpiUtilization(qs, qe, q, emp),
  bk_delinquent_rent: () => kpiDelinquentRent(),
  bk_vendor_ins: () => kpiVendorIns(),
  bk_renters_ins: () => kpiRentersIns(),
};

// ── Tier scoring ────────────────────────────────────────────────────────────

function scoreTier(value, tiers, direction) {
  // Highest tier whose threshold is met, respecting direction. Null thresholds
  // = not configured → no tier, no payout.
  if (value == null) return { tier: null, payout: 0 };
  const order = ["best", "better", "good"];
  for (const t of order) {
    const th = tiers[t] && tiers[t].threshold;
    if (th == null) continue;
    const met = direction === "lower_is_better" ? value <= th : value >= th;
    if (met) return { tier: t, payout: num(tiers[t].payout) };
  }
  return { tier: "none", payout: 0 };
}

// ── Full quarter computation ────────────────────────────────────────────────

export function computeTeamQuarter(quarter) {
  seedKpiConfig();
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
  const isCurrentQ = quarter === currentQuarter();

  const kpis = configs.map((c) => {
    const emp = c.assigned_to ? empById.get(c.assigned_to) : null;
    let comp = { value: null, detail: null };
    if (c.active) {
      if (!isCurrentQ && POINT_IN_TIME.has(c.id)) {
        comp = { value: null, detail: "Point-in-time metric — not measurable for a past quarter without a locked snapshot",
          dataQuality: "This KPI reflects live AppFolio state. Snapshot each quarter before it closes to preserve its value." };
      } else {
        const fn = COMPUTERS[c.id];
        comp = fn ? fn(qs, qe, quarter, emp ? emp.name : null) : { value: null, detail: "No computation wired for this KPI" };
      }
    }
    const configured = ["good", "better", "best"].some((t) => c.tiers[t] && c.tiers[t].threshold != null);
    const { tier, payout } = c.active && configured ? scoreTier(comp.value, c.tiers, c.direction) : { tier: null, payout: 0 };
    const maxPayout = configured ? Math.max(...["good", "better", "best"].map((t) => num(c.tiers[t] && c.tiers[t].payout))) : 0;
    return {
      id: c.id, department: c.department, label: c.label, description: c.description,
      scope: c.scope, assignedTo: c.assigned_to, assignedName: emp ? emp.name : null,
      dataSource: c.data_source, direction: c.direction, unit: c.unit,
      tiers: c.tiers, active: !!c.active, configured,
      value: comp.value, detail: comp.detail || null, dataQuality: comp.dataQuality || null,
      tier, payout: round(payout, 2), maxPayout: round(maxPayout, 2),
      drill: "team_" + c.id,
    };
  });

  // Department rollups with share-weighted member splits
  const deptNames = [...new Set(configs.map((c) => c.department))];
  const departments = deptNames.map((dept) => {
    const deptKpis = kpis.filter((k) => k.department === dept && k.scope === "department");
    const indKpis = kpis.filter((k) => k.department === dept && k.scope === "individual");
    const members = roster.filter((r) => num(r.allocations[dept]) > 0)
      .map((r) => ({ id: r.id, name: r.name, weight: num(r.allocations[dept]) }));
    const totalWeight = members.reduce((s, m) => s + m.weight, 0);
    members.forEach((m) => { m.share = totalWeight ? round(m.weight / totalWeight, 4) : 0; });
    const earned = deptKpis.reduce((s, k) => s + k.payout, 0);
    const max = deptKpis.reduce((s, k) => s + k.maxPayout, 0);
    return { department: dept, kpis: deptKpis, individualKpis: indKpis, members,
      earned: round(earned, 2), max: round(max, 2) };
  });

  // Per-employee earnings
  const employees = roster.map((r) => {
    const breakdown = [];
    let earned = 0, max = 0;
    for (const d of departments) {
      const m = d.members.find((x) => x.id === r.id);
      if (!m) continue;
      const share = m.share;
      for (const k of d.kpis) {
        breakdown.push({ kpi: k.label, department: d.department, type: "department",
          share, payout: round(k.payout * share, 2), maxPayout: round(k.maxPayout * share, 2), tier: k.tier });
        earned += k.payout * share; max += k.maxPayout * share;
      }
    }
    for (const k of kpis.filter((x) => x.scope === "individual" && x.assignedTo === r.id)) {
      breakdown.push({ kpi: k.label, department: k.department, type: "individual",
        share: 1, payout: k.payout, maxPayout: k.maxPayout, tier: k.tier });
      earned += k.payout; max += k.maxPayout;
    }
    return { id: r.id, name: r.name, role: r.role, allocations: r.allocations,
      earned: round(earned, 2), max: round(max, 2), breakdown };
  });

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
    sheetSync,
    kpis, departments, employees,
    quarters: listQuarters(),
  };
}

// ── Snapshots (quarter locking) ─────────────────────────────────────────────

export function getTeamQuarter(quarter) {
  quarter = normalizeQuarter(quarter);
  const snap = one("SELECT payload, snapshot_at FROM quarter_results WHERE quarter = ?", [quarter]);
  if (snap.payload && quarter !== currentQuarter()) {
    const data = JSON.parse(snap.payload);
    data.snapshot = { at: snap.snapshot_at, locked: true };
    data.quarters = listQuarters();
    return data;
  }
  const data = computeTeamQuarter(quarter);
  if (snap.payload) data.snapshot = { at: snap.snapshot_at, locked: false }; // current quarter: snapshot exists but live shown
  else if (!data.isCurrent) data.notLocked = true; // historical, never snapshotted
  return data;
}

export function snapshotQuarter(quarter) {
  quarter = normalizeQuarter(quarter);
  if (quarter > currentQuarter()) throw new Error("Cannot snapshot a future quarter");
  const data = computeTeamQuarter(quarter);
  run(`INSERT INTO quarter_results (quarter, payload, snapshot_at) VALUES (?, ?, ?)
       ON CONFLICT(quarter) DO UPDATE SET payload = excluded.payload, snapshot_at = excluded.snapshot_at`,
    [quarter, JSON.stringify(data), new Date().toISOString()]);
  return { ok: true, quarter, snapshotAt: new Date().toISOString() };
}

// ── Drilldowns ──────────────────────────────────────────────────────────────

const LIM = 500;
export function getTeamDrilldown(key, quarter) {
  seedKpiConfig();
  quarter = normalizeQuarter(quarter);
  const [qs, qe] = quarterBounds(quarter);
  const id = key.replace(/^team_/, "");
  const mk = (title, cols, rows) => ({ title: title + " — " + quarter, cols, rows });
  switch (id) {
    case "pm_vacancy_days": {
      const leases = many(
        `SELECT lh.property_name, lh.unit_name, lh.tenant_name, lh.move_in, lh.unit_id FROM lease_history lh
         JOIN units u ON u.id = lh.unit_id
         WHERE lh.move_in >= ? AND lh.move_in < ? AND lh.unit_id != '' AND ${REVENUE_UNIT}
         ORDER BY lh.move_in DESC LIMIT ${LIM}`, [qs, qe]);
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
      return mk("Owner Insurance Policies", [
        { key: "provider", label: "Provider" }, { key: "policy_number", label: "Policy #" },
        { key: "type", label: "Type" }, { key: "properties", label: "Properties" },
        { key: "expiration_date", label: "Expires" }],
        many(`SELECT provider, policy_number, type, properties, expiration_date FROM owner_insurance ORDER BY expiration_date LIMIT ${LIM}`));
    case "pm_inspections": {
      const rows = many(
        `SELECT i.property_name, COALESCE(p.unit_count, 0) unit_count,
                MAX(COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on)) inspected,
                COUNT(*) inspection_rows
         FROM inspections i LEFT JOIN properties p ON p.id = i.property_id
         WHERE LOWER(i.inspection_name) LIKE '%building walkthrough%'
           AND COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on) >= ?
           AND COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on) < ?
         GROUP BY i.property_id ORDER BY inspected DESC LIMIT ${LIM}`, [qs, qe]);
      // Rolling YTD % of portfolio
      const yStart = quarter.slice(0, 4) + "-01-01";
      const ytdUnits = num(one(
        `SELECT SUM(uc) s FROM (
           SELECT COALESCE(p.unit_count, 0) uc FROM inspections i
           LEFT JOIN properties p ON p.id = i.property_id
           WHERE LOWER(i.inspection_name) LIKE '%building walkthrough%'
             AND COALESCE(NULLIF(i.marked_done_on,''), i.inspected_on) >= ?
           GROUP BY i.property_id)`, [yStart]).s);
      const totalUnits = num(one("SELECT COUNT(*) c FROM units").c);
      const pct = totalUnits ? round((ytdUnits / totalUnits) * 100) : 0;
      return { title: `Building Walkthroughs — ${quarter} (YTD: ${ytdUnits} units = ${pct}% of portfolio)`,
        cols: [
          { key: "property_name", label: "Property" }, { key: "unit_count", label: "Units Credited" },
          { key: "inspected", label: "Inspection Date" }, { key: "inspection_rows", label: "Walkthroughs" }],
        rows };
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
           WHERE u.move_in_date >= ? AND u.move_in_date < ? AND ${REVENUE_UNIT}
           GROUP BY u.id ORDER BY u.move_in_date DESC LIMIT ${LIM}`, [qs, qe]));
    case "mnt_wo_30days":
      return mk("Work Orders Completed in Quarter", [
        { key: "property_name", label: "Property" }, { key: "unit", label: "Unit" },
        { key: "description", label: "Description" }, { key: "created_date", label: "Created" },
        { key: "completed_date", label: "Completed" }, { key: "days", label: "Days" }],
        many(
          `SELECT property_name, unit, description, created_date, completed_date,
                  CAST(julianday(completed_date) - julianday(created_date) AS INTEGER) days
           FROM work_orders
           WHERE completed_date != '' AND created_date != '' AND completed_date >= created_date
             AND completed_date >= ? AND completed_date < ?
           ORDER BY days DESC LIMIT ${LIM}`, [qs, qe]));
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
        many(`SELECT property_name, unit_name, payer_name, posting_date, amount_receivable
              FROM receivable_charges WHERE charge_category = 'Rent' AND amount_receivable != 0
              ORDER BY amount_receivable DESC LIMIT ${LIM}`));
    case "bk_vendor_ins":
      return mk("Vendors — Liability Insurance", [
        { key: "vendor_name", label: "Vendor" }, { key: "liability_expires", label: "Liability Expires" },
        { key: "status", label: "Status" }],
        many(`SELECT vendor_name, liability_expires, status FROM vendors WHERE status != 'do_not_use' ORDER BY COALESCE(NULLIF(liability_expires,''),'9999') LIMIT ${LIM}`));
    case "bk_renters_ins":
      return mk("Current Tenants — Renter's Insurance", [
        { key: "tenant_name", label: "Tenant" }, { key: "property_name", label: "Property" },
        { key: "unit", label: "Unit" }, { key: "insurance_company", label: "Carrier" },
        { key: "insurance_expiration", label: "Expires" }],
        many(`SELECT tenant_name, property_name, unit, insurance_company, insurance_expiration
              FROM tenant_insurance WHERE status = 'Current' ORDER BY CASE WHEN insurance_expiration = '' THEN 1 ELSE 0 END, insurance_expiration LIMIT ${LIM}`));
    default:
      return null;
  }
}
