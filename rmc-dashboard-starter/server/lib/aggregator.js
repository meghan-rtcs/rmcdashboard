// ── Dashboard aggregator ─────────────────────────────────────────────────────
// Queries the SQLite tables (populated by sync.js) and assembles the JSON
// payload consumed by the frontend. Reference METRIC-MAPPING.md for the
// calculation behind every metric. Chart data uses the income_statement_12_month
// AppFolio endpoint via a live call, falling back gracefully when unavailable.
import { query, queryOne } from "./db.js";
import { appfolio } from "./appfolio.js";

const num = (v) => (v == null || isNaN(v) ? 0 : Number(v));
const round = (v, d = 1) => {
  const f = Math.pow(10, d);
  return Math.round(num(v) * f) / f;
};

function buildKpi(value, prevYear = 0, opts = {}) {
  return { value: value ?? 0, prevYear: prevYear ?? 0, ...opts };
}

function one(sql, params = []) {
  try {
    return queryOne(sql, params) || {};
  } catch {
    return {};
  }
}

function many(sql, params = []) {
  try {
    return query(sql, params) || [];
  } catch {
    return [];
  }
}

// ── Date-range window ───────────────────────────────────────────────────────
// A global filter lets the user scope time-windowed (activity) metrics to a
// preset range. Point-in-time metrics (current occupancy, delinquency, open
// work orders, etc.) ignore it. Values are drawn from a fixed whitelist, so
// they are safe to interpolate into SQL.
const RANGE_LABELS = {
  this_month: "this month",
  last_month: "last month",
  this_quarter: "this quarter",
  last_quarter: "last quarter",
  this_year: "this year",
  last_year: "last year",
};
export const DEFAULT_RANGE = "this_month";
export function normalizeRange(range) {
  return Object.prototype.hasOwnProperty.call(RANGE_LABELS, range)
    ? range
    : DEFAULT_RANGE;
}
// Calendar bounds [start, end) for a range key, as local YYYY-MM-DD strings.
function rangeBounds(range) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const q = Math.floor(m / 3);
  const d = (yy, mm) => {
    const dt = new Date(yy, mm, 1);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-01`;
  };
  switch (normalizeRange(range)) {
    case "this_month": return [d(y, m), d(y, m + 1)];
    case "last_month": return [d(y, m - 1), d(y, m)];
    case "this_quarter": return [d(y, q * 3), d(y, q * 3 + 3)];
    case "last_quarter": return [d(y, q * 3 - 3), d(y, q * 3)];
    case "this_year": return [d(y, 0), d(y + 1, 0)];
    case "last_year": return [d(y - 1, 0), d(y, 0)];
  }
}
// SQL boolean clause: is `col` within the selected calendar period? Bounds are
// server-computed date literals (never user input), so safe to interpolate.
function within(col, range) {
  const [start, end] = rangeBounds(range);
  return `${col} >= '${start}' AND ${col} < '${end}'`;
}
function rangeLabel(range) {
  return RANGE_LABELS[normalizeRange(range)];
}

// ── Sections ──────────────────────────────────────────────────────────────

function buildOccupancy() {
  const totalUnits = num(one("SELECT COUNT(*) c FROM units").c);
  const occupied = num(
    one(
      "SELECT COUNT(*) c FROM units WHERE occupancy_status IN ('Occupied','Current') OR (tenant_name IS NOT NULL AND tenant_name != '')"
    ).c
  );
  const vacant = Math.max(totalUnits - occupied, 0);
  const vacantNotRented = num(
    one(
      "SELECT COUNT(*) c FROM units WHERE occupancy_status LIKE '%Vacant%' AND occupancy_status LIKE '%Unrented%'"
    ).c
  );
  const vacantRented = num(
    one(
      "SELECT COUNT(*) c FROM units WHERE occupancy_status LIKE '%Vacant%' AND occupancy_status LIKE '%Rented%' AND occupancy_status NOT LIKE '%Unrented%'"
    ).c
  );
  const avgDaysVacant = round(
    one("SELECT AVG(days_vacant) a FROM vacancies WHERE days_vacant > 0").a
  );
  const properties = num(one("SELECT COUNT(*) c FROM properties").c);
  const owners = num(one("SELECT COUNT(*) c FROM owners").c);
  const rate = totalUnits ? round((occupied / totalUnits) * 100) : 0;

  return {
    rate,
    totalUnits,
    occupied,
    vacant,
    vacantNotRented,
    vacantRented,
    avgDaysVacant,
    properties,
    owners,
  };
}

function buildLeasing(range) {
  const renewalDenom = num(
    one(
      `SELECT COUNT(*) c FROM renewals WHERE ${within("lease_end", range)}`
    ).c
  );
  const renewalsCount = num(
    one(
      `SELECT COUNT(*) c FROM renewals WHERE renewal_status = 'Renewed' AND ${within("lease_end", range)}`
    ).c
  );
  const renewalRate = renewalDenom
    ? round((renewalsCount / renewalDenom) * 100)
    : 0;

  const mtmLeases = num(
    one(
      "SELECT COUNT(*) c FROM renewals WHERE renewal_status = 'Month To Month'"
    ).c
  );
  const fixedLeases = num(
    one("SELECT COUNT(*) c FROM units WHERE lease_to >= date('now')").c
  );
  const appsSubmitted = num(
    one(
      `SELECT COUNT(*) c FROM applications WHERE ${within("received_date", range)}`
    ).c
  );
  const moveins = num(
    one(
      `SELECT COUNT(*) c FROM units WHERE ${within("move_in_date", range)}`
    ).c
  );
  const appsPerMovein = moveins ? round(appsSubmitted / moveins) : 0;
  const avgTenancyMonths = round(
    one(
      "SELECT AVG((julianday('now') - julianday(move_in_date)) / 30.44) a FROM units WHERE move_in_date IS NOT NULL AND move_in_date != ''"
    ).a
  );

  return {
    renewalRate,
    renewalsCount,
    mtmLeases,
    fixedLeases,
    appsSubmitted,
    moveins,
    appsPerMovein,
    avgTenancyMonths,
  };
}

async function buildFinancials() {
  const delinquent = round(
    one("SELECT SUM(amount_receivable) s FROM delinquency").s,
    2
  );
  const delinquentCount = num(
    one("SELECT COUNT(*) c FROM delinquency WHERE amount_receivable > 0").c
  );
  const totalRent = num(
    one("SELECT SUM(current_rent) s FROM units WHERE current_rent > 0").s
  );
  const delinquencyRate = totalRent
    ? round((delinquent / totalRent) * 100)
    : 0;

  const aging = one(
    "SELECT SUM(current_amount) current, SUM(thirty_plus) thirty, SUM(sixty_plus) sixty, SUM(ninety_plus) ninety FROM delinquency"
  );
  const avgRentPerDoor = round(
    one("SELECT AVG(current_rent) a FROM units WHERE current_rent > 0").a,
    2
  );

  // Gross / net income come from a live YTD income statement; degrade gracefully.
  let grossIncome = 0;
  let netIncome = 0;
  try {
    const year = new Date().getFullYear();
    const rows = await appfolio.incomeStatement(
      year + "-" + String(new Date().getMonth() + 1).padStart(2, "0"),
      { posted_on_from: year + "-01" }
    );
    if (Array.isArray(rows)) {
      const find = (re) =>
        rows.find((r) => re.test((r.account_name || "").trim()));
      const totalIncome = num(parseFloat(find(/^total income$/i)?.year_to_date));
      const totalExpense = num(parseFloat(find(/^total expense$/i)?.year_to_date));
      grossIncome = round(totalIncome, 2);
      netIncome = round(totalIncome - totalExpense, 2);
    }
  } catch (e) {
    console.warn("[aggregator] income_statement unavailable:", e.message);
  }

  return {
    delinquent,
    delinquentCount,
    delinquencyRate,
    aging: {
      current: round(aging.current, 2),
      thirtyPlus: round(aging.thirty, 2),
      sixtyPlus: round(aging.sixty, 2),
      ninetyPlus: round(aging.ninety, 2),
    },
    avgRentPerDoor,
    grossIncome,
    netIncome,
  };
}

function buildMarketing(range) {
  const inquiries = num(
    one(
      `SELECT COUNT(*) c FROM guest_cards WHERE ${within("received_date", range)}`
    ).c
  );
  const activeProspects = num(
    one(
      "SELECT COUNT(*) c FROM guest_cards WHERE LOWER(status) IN ('active','prequalified','waitlisted')"
    ).c
  );
  const showingsTotal = num(
    one(
      `SELECT COUNT(*) c FROM showings WHERE ${within("showing_date", range)}`
    ).c
  );
  const showingsCompleted = num(
    one(
      `SELECT COUNT(*) c FROM showings WHERE status = 'Completed' AND ${within("showing_date", range)}`
    ).c
  );
  const showingsScheduleable = num(
    one(
      `SELECT COUNT(*) c FROM showings WHERE status NOT IN ('Canceled','Prospect Canceled','Canceled (Unconfirmed)') AND ${within("showing_date", range)}`
    ).c
  );
  const showingCompletionRate = showingsScheduleable
    ? round((showingsCompleted / showingsScheduleable) * 100)
    : 0;
  const noShows = num(
    one(
      `SELECT COUNT(*) c FROM showings WHERE status = 'No Show' AND ${within("showing_date", range)}`
    ).c
  );
  const unitsOnMarket = num(one("SELECT COUNT(*) c FROM vacancies").c);

  const inquiriesBySource = many(
    `SELECT COALESCE(NULLIF(source,''),'Unknown') source, COUNT(*) count FROM guest_cards WHERE ${within("received_date", range)} GROUP BY source ORDER BY count DESC LIMIT 12`
  ).map((r) => ({ source: r.source, count: num(r.count) }));

  // Conversion funnel over the selected date window so each stage is a strict
  // subset of the one above it. "Approved" = applications that passed screening
  // (approved, now converting, or fully converted/leased); "Converted" = leases
  // signed.
  const funnel = {
    inquiries: num(
      one(
        `SELECT COUNT(*) c FROM guest_cards WHERE ${within("received_date", range)}`
      ).c
    ),
    applications: num(
      one(
        `SELECT COUNT(*) c FROM applications WHERE ${within("received_date", range)}`
      ).c
    ),
    approved: num(
      one(
        `SELECT COUNT(*) c FROM applications WHERE status IN ('Approved','Converting','Converted') AND ${within("received_date", range)}`
      ).c
    ),
    converted: num(
      one(
        `SELECT COUNT(*) c FROM applications WHERE status = 'Converted' AND ${within("received_date", range)}`
      ).c
    ),
  };

  return {
    inquiries,
    activeProspects,
    showingsTotal,
    showingsCompleted,
    showingCompletionRate,
    noShows,
    unitsOnMarket,
    inquiriesBySource,
    funnel,
  };
}

function buildMaintenance() {
  const openWorkOrders = num(
    one(
      "SELECT COUNT(*) c FROM work_orders WHERE status NOT IN ('Completed','Canceled','Completed No Need To Bill')"
    ).c
  );
  const avgDaysToComplete = round(
    one(
      "SELECT AVG(julianday(completed_date) - julianday(created_date)) a FROM work_orders WHERE completed_date IS NOT NULL AND completed_date != '' AND created_date IS NOT NULL AND created_date != '' AND completed_date >= created_date"
    ).a
  );

  const priorityRows = many(
    "SELECT LOWER(COALESCE(priority,'')) priority, COUNT(*) c FROM work_orders GROUP BY LOWER(priority)"
  );
  const byPriority = { urgent: 0, normal: 0, low: 0 };
  for (const r of priorityRows) {
    const p = (r.priority || "").toLowerCase();
    if (p.includes("urgent") || p.includes("high") || p.includes("emergency"))
      byPriority.urgent += num(r.c);
    else if (p.includes("low")) byPriority.low += num(r.c);
    else byPriority.normal += num(r.c);
  }

  const typeRows = many(
    "SELECT LOWER(COALESCE(work_order_type,'')) t, COUNT(*) c FROM work_orders GROUP BY LOWER(work_order_type)"
  );
  const byType = { internal: 0, tenantRequested: 0, unitTurn: 0 };
  for (const r of typeRows) {
    const t = (r.t || "").toLowerCase();
    if (t.includes("turn")) byType.unitTurn += num(r.c);
    else if (t.includes("tenant") || t.includes("resident"))
      byType.tenantRequested += num(r.c);
    else byType.internal += num(r.c);
  }

  return { openWorkOrders, avgDaysToComplete, byPriority, byType };
}

// ── Operations (billable hours, move-in quality, WO aging, insurance) ──────

const WO_OPEN = "status NOT IN ('Completed','Canceled','Completed No Need To Bill')";
// Work considered part of a normal unit turn — excluded when judging whether a
// move-in generated maintenance requests.
const TURNOVER_WO =
  "(LOWER(COALESCE(work_order_type,'')) LIKE '%turn%' OR " +
  "LOWER(COALESCE(description,'')) LIKE '%lock%' OR " +
  "LOWER(COALESCE(description,'')) LIKE '%rekey%' OR " +
  "LOWER(COALESCE(description,'')) LIKE '%re-key%' OR " +
  "LOWER(COALESCE(description,'')) LIKE '%blind%' OR " +
  "LOWER(COALESCE(description,'')) LIKE '%make ready%' OR " +
  "LOWER(COALESCE(description,'')) LIKE '%make-ready%')";

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

// Mon–Fri days from the 1st of the period through today (inclusive).
function workdaysElapsed(period) {
  const [y, m] = period.split("-").map(Number);
  const today = new Date();
  const isCurrent = today.toISOString().slice(0, 7) === period;
  const last = isCurrent ? today.getDate() : new Date(y, m, 0).getDate();
  let count = 0;
  for (let d = 1; d <= last; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

export function computeBillableHours(period) {
  period = /^\d{4}-\d{2}$/.test(period || "") ? period : currentPeriod();
  const monthStart = `${period}-01`;
  const monthEnd = `${period}-31`;
  const logged = many(
    "SELECT tech, SUM(worked_hours) h, COUNT(*) entries FROM labor_entries WHERE work_date >= ? AND work_date <= ? AND tech != '' GROUP BY tech",
    [monthStart, monthEnd]
  );
  const adjustments = many(
    "SELECT tech, pto_hours, extra_hours FROM labor_adjustments WHERE period = ?",
    [period]
  );
  const byTech = new Map();
  for (const r of logged) {
    byTech.set(r.tech, { tech: r.tech, logged: round(num(r.h), 2), entries: num(r.entries), pto: 0, extra: 0 });
  }
  for (const a of adjustments) {
    const t = byTech.get(a.tech) || { tech: a.tech, logged: 0, entries: 0, pto: 0, extra: 0 };
    t.pto = round(num(a.pto_hours), 2);
    t.extra = round(num(a.extra_hours), 2);
    byTech.set(a.tech, t);
  }
  const workdays = workdaysElapsed(period);
  const baseHours = workdays * 8;
  const techs = [...byTech.values()].map((t) => {
    const available = Math.max(baseHours - t.pto, 0);
    const billable = round(t.logged + t.extra, 2);
    return {
      ...t,
      available: round(available, 2),
      billable,
      utilization: available ? round((billable / available) * 100) : 0,
    };
  }).sort((a, b) => b.billable - a.billable);

  const totals = techs.reduce(
    (acc, t) => ({
      logged: acc.logged + t.logged,
      pto: acc.pto + t.pto,
      extra: acc.extra + t.extra,
      available: acc.available + t.available,
      billable: acc.billable + t.billable,
    }),
    { logged: 0, pto: 0, extra: 0, available: 0, billable: 0 }
  );

  return {
    period,
    workdays,
    baseHours,
    techs,
    totalLogged: round(totals.logged, 2),
    totalPto: round(totals.pto, 2),
    totalExtra: round(totals.extra, 2),
    totalAvailable: round(totals.available, 2),
    totalBillable: round(totals.billable, 2),
    utilization: totals.available ? round((totals.billable / totals.available) * 100) : 0,
  };
}

// Move-ins in the window, each flagged with the number of non-turnover work
// orders created in the 30 days following move-in.
function computeMoveInWo(range) {
  const rows = many(
    `SELECT u.property_name, u.unit_name, u.tenant_name, u.move_in_date,
            SUM(CASE WHEN w.id IS NOT NULL AND NOT ${TURNOVER_WO} THEN 1 ELSE 0 END) wo_count,
            SUM(CASE WHEN w.id IS NOT NULL AND ${TURNOVER_WO} THEN 1 ELSE 0 END) turnover_wos
     FROM units u
     LEFT JOIN work_orders w
       ON w.unit_id = u.id AND w.created_date != ''
      AND w.created_date >= u.move_in_date
      AND w.created_date <= date(u.move_in_date, '+30 days')
     WHERE u.move_in_date != '' AND ${within("u.move_in_date", range)}
     GROUP BY u.id
     ORDER BY u.move_in_date DESC`
  );
  return rows.map((r) => ({
    property_name: r.property_name,
    unit_name: r.unit_name,
    tenant_name: r.tenant_name,
    move_in_date: r.move_in_date,
    wo_count: num(r.wo_count),
    turnover_wos: num(r.turnover_wos),
    clean: num(r.wo_count) === 0 ? "Yes" : "No",
  }));
}

function expCounts(table, col, where = "1=1") {
  const expired = num(one(
    `SELECT COUNT(*) c FROM ${table} WHERE ${where} AND ${col} != '' AND date(${col}) < date('now')`
  ).c);
  const expiring = num(one(
    `SELECT COUNT(*) c FROM ${table} WHERE ${where} AND ${col} != '' AND date(${col}) >= date('now') AND date(${col}) <= date('now','+60 days')`
  ).c);
  const tracked = num(one(
    `SELECT COUNT(*) c FROM ${table} WHERE ${where} AND ${col} != ''`
  ).c);
  return { expired, expiring, tracked };
}

function buildOperations(range) {
  // 1. Billable hours (current month)
  const billableHours = computeBillableHours();

  // 2. Move-in quality
  const moveInRows = computeMoveInWo(range);
  const withWo = moveInRows.filter((r) => r.wo_count > 0).length;
  const moveInQuality = {
    total: moveInRows.length,
    withWo,
    withoutWo: moveInRows.length - withWo,
    cleanRate: moveInRows.length
      ? round(((moveInRows.length - withWo) / moveInRows.length) * 100)
      : 0,
  };

  // 3. Work order aging
  const openOver30 = num(one(
    `SELECT COUNT(*) c FROM work_orders WHERE ${WO_OPEN} AND created_date != '' AND date(created_date) <= date('now','-30 days')`
  ).c);
  const avgOpenAge = round(one(
    `SELECT AVG(julianday('now') - julianday(created_date)) a FROM work_orders WHERE ${WO_OPEN} AND created_date != ''`
  ).a);
  const closed = one(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN julianday(completed_date) - julianday(created_date) <= 30 THEN 1 ELSE 0 END) fast
     FROM work_orders
     WHERE completed_date != '' AND created_date != '' AND completed_date >= created_date
       AND ${within("completed_date", range)}`
  );
  const woAging = {
    openOver30,
    avgOpenAge,
    closedTotal: num(closed.total),
    closedWithin30Pct: num(closed.total) ? round((num(closed.fast) / num(closed.total)) * 100) : 0,
  };

  // 4-6. Insurance compliance (point-in-time)
  const tenantWhere = "status = 'Current'";
  const insurance = {
    tenants: expCounts("tenant_insurance", "insurance_expiration", tenantWhere),
    vendors: expCounts("vendors", "liability_expires", "status != 'do_not_use'"),
    owners: expCounts("properties", "insurance_expiration"),
  };
  insurance.tenants.commercialTracked = num(one(
    `SELECT COUNT(*) c FROM tenant_insurance WHERE ${tenantWhere} AND insurance_expiration != ''
     AND (LOWER(COALESCE(tenant_type,'')) LIKE '%commercial%' OR COALESCE(commercial_lease_type,'') != '')`
  ).c);
  insurance.vendors.missing = num(one(
    "SELECT COUNT(*) c FROM vendors WHERE status != 'do_not_use' AND COALESCE(liability_expires,'') = ''"
  ).c);
  insurance.owners.missing = num(one(
    "SELECT COUNT(*) c FROM properties WHERE COALESCE(insurance_expiration,'') = ''"
  ).c);

  return { billableHours, moveInQuality, woAging, insurance };
}

// ── Charts ──────────────────────────────────────────────────────────────────

function monthsBack(n) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(m.toISOString().slice(0, 7));
  }
  return out;
}

async function buildCharts() {
  const months = monthsBack(12);

  let monthlyRevenue = months.map((month) => ({
    month,
    gross: 0,
    net: 0,
    expense: 0,
  }));

  // Live 12-month cash flow gives per-month income/expense totals; degrade gracefully.
  try {
    const rows = await appfolio.twelveMonthCashFlow(months[0], months[months.length - 1]);
    if (Array.isArray(rows) && rows.length) {
      const pick = (re) => rows.find((r) => re.test((r.account_name || "").trim()));
      const incomeRow = pick(/^total income$/i);
      const expenseRow = pick(/^total expense$/i);
      const toMap = (row) => {
        const map = {};
        (row?.months || []).forEach((m) => { map[m.id] = Math.abs(num(parseFloat(m.value))); });
        return map;
      };
      const inc = toMap(incomeRow);
      const exp = toMap(expenseRow);
      if (incomeRow || expenseRow) {
        monthlyRevenue = months.map((m) => {
          const gross = round(inc[m] || 0, 2);
          const expense = round(exp[m] || 0, 2);
          return { month: m, gross, expense, net: round(gross - expense, 2) };
        });
      }
    }
  } catch (e) {
    console.warn("[aggregator] twelve_month_cash_flow unavailable:", e.message);
  }

  // Occupancy / delinquency trends from monthly_snapshots when present.
  const occRows = many(
    "SELECT month, value FROM monthly_snapshots WHERE metric = 'occupancy_rate' ORDER BY month"
  );
  const occMap = Object.fromEntries(occRows.map((r) => [r.month, num(r.value)]));
  const occupancyTrend = months.map((m) => ({
    month: m,
    rate: round(occMap[m] || 0),
  }));

  const delRows = many(
    "SELECT month, value FROM monthly_snapshots WHERE metric = 'delinquency_total' ORDER BY month"
  );
  const delMap = Object.fromEntries(delRows.map((r) => [r.month, num(r.value)]));
  const delinquencyTrend = months.map((m) => ({
    month: m,
    total: round(delMap[m] || 0, 2),
  }));

  return { monthlyRevenue, occupancyTrend, delinquencyTrend };
}

// ── Drilldowns ────────────────────────────────────────────────────────────
// Raw records behind every KPI tile, keyed by the same drill key the frontend
// passes on each card. Each entry: { title, cols:[{key,label,money?,pct?}], rows }.

function drillRegistry(range) {
  const dd = {};
  const make = (title, cols, sql) => ({ title, cols, sql });

  const unitCols = [
    { key: "property_name", label: "Property" },
    { key: "unit_name", label: "Unit" },
    { key: "tenant_name", label: "Tenant" },
    { key: "current_rent", label: "Rent", money: true },
    { key: "occupancy_status", label: "Status" },
    { key: "lease_to", label: "Lease End" },
  ];
  const delCols = [
    { key: "property_name", label: "Property" },
    { key: "unit", label: "Unit" },
    { key: "tenant_name", label: "Tenant" },
    { key: "amount_receivable", label: "Total Due", money: true },
    { key: "current_amount", label: "Current", money: true },
    { key: "thirty_plus", label: "30+", money: true },
    { key: "sixty_plus", label: "60+", money: true },
    { key: "ninety_plus", label: "90+", money: true },
  ];
  const vacCols = [
    { key: "property_name", label: "Property" },
    { key: "unit", label: "Unit" },
    { key: "status", label: "Status" },
    { key: "days_vacant", label: "Days Vacant" },
    { key: "market_rent", label: "Market Rent", money: true },
    { key: "advertised_rent", label: "Advertised", money: true },
    { key: "available_date", label: "Available" },
  ];
  const appCols = [
    { key: "property_name", label: "Property" },
    { key: "unit", label: "Unit" },
    { key: "applicant_name", label: "Applicant" },
    { key: "status", label: "Status" },
    { key: "received_date", label: "Received" },
    { key: "decision_date", label: "Decision" },
  ];
  const gcCols = [
    { key: "prospect_name", label: "Prospect" },
    { key: "property_name", label: "Property" },
    { key: "source", label: "Source" },
    { key: "status", label: "Status" },
    { key: "received_date", label: "Received" },
    { key: "assigned_user", label: "Agent" },
  ];
  const showCols = [
    { key: "property_name", label: "Property" },
    { key: "unit", label: "Unit" },
    { key: "prospect_name", label: "Prospect" },
    { key: "status", label: "Status" },
    { key: "showing_date", label: "Date" },
    { key: "assigned_user", label: "Agent" },
  ];
  const woCols = [
    { key: "property_name", label: "Property" },
    { key: "unit", label: "Unit" },
    { key: "description", label: "Description" },
    { key: "priority", label: "Priority" },
    { key: "work_order_type", label: "Type" },
    { key: "status", label: "Status" },
    { key: "created_date", label: "Created" },
  ];
  const renCols = [
    { key: "property_name", label: "Property" },
    { key: "unit", label: "Unit" },
    { key: "tenant_name", label: "Tenant" },
    { key: "renewal_status", label: "Status" },
    { key: "lease_end", label: "Lease End" },
    { key: "previous_rent", label: "Prev Rent", money: true },
    { key: "new_rent", label: "New Rent", money: true },
  ];

  const LIM = 1000;
  const occWhere =
    "occupancy_status IN ('Occupied','Current') OR (tenant_name IS NOT NULL AND tenant_name != '')";

  // Occupancy
  dd.occupancy = make("Occupied Units", unitCols,
    `SELECT property_name, unit_name, tenant_name, current_rent, occupancy_status, lease_to FROM units WHERE ${occWhere} ORDER BY property_name, unit_name LIMIT ${LIM}`);
  dd.occupied = dd.occupancy;
  dd.units = make("All Units", unitCols,
    `SELECT property_name, unit_name, tenant_name, current_rent, occupancy_status, lease_to FROM units ORDER BY property_name, unit_name LIMIT ${LIM}`);
  dd.rentRoll = make("Units with Rent", unitCols,
    `SELECT property_name, unit_name, tenant_name, current_rent, occupancy_status, lease_to FROM units WHERE current_rent > 0 ORDER BY current_rent DESC LIMIT ${LIM}`);
  dd.vacant = make("Vacant Units", unitCols,
    `SELECT property_name, unit_name, tenant_name, current_rent, occupancy_status, lease_to FROM units WHERE NOT (${occWhere}) ORDER BY property_name, unit_name LIMIT ${LIM}`);
  dd.vacantNotRented = make("Vacant — Not Rented", unitCols,
    `SELECT property_name, unit_name, tenant_name, current_rent, occupancy_status, lease_to FROM units WHERE occupancy_status LIKE '%Vacant%' AND occupancy_status LIKE '%Unrented%' ORDER BY property_name LIMIT ${LIM}`);
  dd.vacantRented = make("Vacant — Rented", unitCols,
    `SELECT property_name, unit_name, tenant_name, current_rent, occupancy_status, lease_to FROM units WHERE occupancy_status LIKE '%Vacant%' AND occupancy_status LIKE '%Rented%' AND occupancy_status NOT LIKE '%Unrented%' ORDER BY property_name LIMIT ${LIM}`);
  dd.vacancies = make("Vacancies on Market", vacCols,
    `SELECT property_name, unit, status, days_vacant, market_rent, advertised_rent, available_date FROM vacancies ORDER BY days_vacant DESC LIMIT ${LIM}`);

  // Leasing
  dd.renewals = make(`Renewals (${rangeLabel(range)})`, renCols,
    `SELECT property_name, unit, tenant_name, renewal_status, lease_end, previous_rent, new_rent FROM renewals WHERE ${within("lease_end", range)} ORDER BY lease_end DESC LIMIT ${LIM}`);
  dd.mtm = make("Month-to-Month Leases", renCols,
    `SELECT property_name, unit, tenant_name, renewal_status, lease_end, previous_rent, new_rent FROM renewals WHERE renewal_status = 'Month To Month' LIMIT ${LIM}`);
  dd.fixedLeases = make("Active Fixed Leases", unitCols,
    `SELECT property_name, unit_name, tenant_name, current_rent, occupancy_status, lease_to FROM units WHERE lease_to >= date('now') ORDER BY lease_to LIMIT ${LIM}`);
  dd.applications = make(`Applications (${rangeLabel(range)})`, appCols,
    `SELECT property_name, unit, applicant_name, status, received_date, decision_date FROM applications WHERE ${within("received_date", range)} ORDER BY received_date DESC LIMIT ${LIM}`);
  dd.moveins = make(`Move-ins (${rangeLabel(range)})`, unitCols,
    `SELECT property_name, unit_name, tenant_name, current_rent, occupancy_status, move_in_date AS lease_to FROM units WHERE ${within("move_in_date", range)} ORDER BY move_in_date DESC LIMIT ${LIM}`);

  // Marketing
  dd.inquiries = make(`Inquiries (${rangeLabel(range)})`, gcCols,
    `SELECT prospect_name, property_name, source, status, received_date, assigned_user FROM guest_cards WHERE ${within("received_date", range)} ORDER BY received_date DESC LIMIT ${LIM}`);
  dd.activeProspects = make("Active Prospects", gcCols,
    `SELECT prospect_name, property_name, source, status, received_date, assigned_user FROM guest_cards WHERE LOWER(status) IN ('active','prequalified','waitlisted') ORDER BY received_date DESC LIMIT ${LIM}`);
  dd.showings = make(`Showings (${rangeLabel(range)})`, showCols,
    `SELECT property_name, unit, prospect_name, status, showing_date, assigned_user FROM showings WHERE ${within("showing_date", range)} ORDER BY showing_date DESC LIMIT ${LIM}`);
  dd.showingsCompleted = make("Completed Showings", showCols,
    `SELECT property_name, unit, prospect_name, status, showing_date, assigned_user FROM showings WHERE status = 'Completed' AND ${within("showing_date", range)} ORDER BY showing_date DESC LIMIT ${LIM}`);
  dd.noShows = make("No-Show Showings", showCols,
    `SELECT property_name, unit, prospect_name, status, showing_date, assigned_user FROM showings WHERE status = 'No Show' AND ${within("showing_date", range)} ORDER BY showing_date DESC LIMIT ${LIM}`);

  // Financials
  dd.delinquency = make("Delinquent Accounts", delCols,
    `SELECT property_name, unit, tenant_name, amount_receivable, current_amount, thirty_plus, sixty_plus, ninety_plus FROM delinquency WHERE amount_receivable > 0 ORDER BY amount_receivable DESC LIMIT ${LIM}`);
  dd.delinquencyCurrent = make("Current Balances", delCols,
    `SELECT property_name, unit, tenant_name, amount_receivable, current_amount, thirty_plus, sixty_plus, ninety_plus FROM delinquency WHERE current_amount > 0 ORDER BY current_amount DESC LIMIT ${LIM}`);
  dd.delinquency30 = make("30+ Days Past Due", delCols,
    `SELECT property_name, unit, tenant_name, amount_receivable, current_amount, thirty_plus, sixty_plus, ninety_plus FROM delinquency WHERE thirty_plus > 0 ORDER BY thirty_plus DESC LIMIT ${LIM}`);
  dd.delinquency60 = make("60+ Days Past Due", delCols,
    `SELECT property_name, unit, tenant_name, amount_receivable, current_amount, thirty_plus, sixty_plus, ninety_plus FROM delinquency WHERE sixty_plus > 0 ORDER BY sixty_plus DESC LIMIT ${LIM}`);
  dd.delinquency90 = make("90+ Days Past Due", delCols,
    `SELECT property_name, unit, tenant_name, amount_receivable, current_amount, thirty_plus, sixty_plus, ninety_plus FROM delinquency WHERE ninety_plus > 0 ORDER BY ninety_plus DESC LIMIT ${LIM}`);

  // Maintenance
  const woOpen = "status NOT IN ('Completed','Canceled','Completed No Need To Bill')";
  dd.openWorkOrders = make("Open Work Orders", woCols,
    `SELECT property_name, unit, description, priority, work_order_type, status, created_date FROM work_orders WHERE ${woOpen} ORDER BY created_date DESC LIMIT ${LIM}`);
  dd.completedWorkOrders = make("Completed Work Orders", woCols,
    `SELECT property_name, unit, description, priority, work_order_type, status, created_date FROM work_orders WHERE completed_date IS NOT NULL AND completed_date != '' ORDER BY completed_date DESC LIMIT ${LIM}`);
  const urgentLike = "(LOWER(priority) LIKE '%urgent%' OR LOWER(priority) LIKE '%high%' OR LOWER(priority) LIKE '%emergency%')";
  const lowLike = "LOWER(priority) LIKE '%low%'";
  dd.woUrgent = make("Urgent / High Priority Work Orders", woCols,
    `SELECT property_name, unit, description, priority, work_order_type, status, created_date FROM work_orders WHERE ${urgentLike} ORDER BY created_date DESC LIMIT ${LIM}`);
  dd.woLow = make("Low Priority Work Orders", woCols,
    `SELECT property_name, unit, description, priority, work_order_type, status, created_date FROM work_orders WHERE ${lowLike} ORDER BY created_date DESC LIMIT ${LIM}`);
  dd.woNormal = make("Normal Priority Work Orders", woCols,
    `SELECT property_name, unit, description, priority, work_order_type, status, created_date FROM work_orders WHERE NOT ${urgentLike} AND NOT ${lowLike} ORDER BY created_date DESC LIMIT ${LIM}`);
  dd.woUnitTurn = make("Unit Turn Work Orders", woCols,
    `SELECT property_name, unit, description, priority, work_order_type, status, created_date FROM work_orders WHERE LOWER(work_order_type) LIKE '%turn%' ORDER BY created_date DESC LIMIT ${LIM}`);

  // Portfolio
  dd.properties = make("Properties", [
    { key: "property_name", label: "Property" },
    { key: "address", label: "Address" },
    { key: "city", label: "City" },
    { key: "state", label: "State" },
    { key: "unit_count", label: "Units" },
    { key: "property_type", label: "Type" },
  ], `SELECT property_name, address, city, state, unit_count, property_type FROM properties ORDER BY property_name LIMIT ${LIM}`);
  // Operations — billable hours
  const laborCols = [
    { key: "work_date", label: "Date" },
    { key: "tech", label: "Tech" },
    { key: "property_name", label: "Property" },
    { key: "unit", label: "Unit" },
    { key: "worked_hours", label: "Hours" },
    { key: "work_order_number", label: "WO #" },
    { key: "description", label: "Description" },
  ];
  const period = currentPeriod();
  dd.laborEntries = make(`Billable Labor Entries (${period})`, laborCols,
    `SELECT work_date, tech, property_name, unit, worked_hours, work_order_number, description FROM labor_entries WHERE work_date >= '${period}-01' ORDER BY work_date DESC LIMIT ${LIM}`);

  // Operations — move-in quality (computed rows)
  const moveInCols = [
    { key: "property_name", label: "Property" },
    { key: "unit_name", label: "Unit" },
    { key: "tenant_name", label: "Tenant" },
    { key: "move_in_date", label: "Move-in" },
    { key: "wo_count", label: "Work Orders (30d)" },
    { key: "turnover_wos", label: "Turnover WOs (excluded)" },
    { key: "clean", label: "No WOs?" },
  ];
  dd.moveInsClean = { title: `Move-ins with No Work Orders (${rangeLabel(range)})`, cols: moveInCols,
    rowsFn: () => computeMoveInWo(range).filter((r) => r.wo_count === 0) };
  dd.moveInsWithWo = { title: `Move-ins that Generated Work Orders (${rangeLabel(range)})`, cols: moveInCols,
    rowsFn: () => computeMoveInWo(range).filter((r) => r.wo_count > 0) };
  dd.moveInsAll = { title: `Move-ins vs Work Orders (${rangeLabel(range)})`, cols: moveInCols,
    rowsFn: () => computeMoveInWo(range) };

  // Operations — work order aging
  const woAgeCols = [
    { key: "property_name", label: "Property" },
    { key: "unit", label: "Unit" },
    { key: "description", label: "Description" },
    { key: "vendor_name", label: "Vendor" },
    { key: "status", label: "Status" },
    { key: "created_date", label: "Created" },
    { key: "days_open", label: "Days Open" },
  ];
  dd.woOver30 = make("Open Work Orders — 30+ Days Old", woAgeCols,
    `SELECT property_name, unit, description, vendor_name, status, created_date, CAST(julianday('now') - julianday(created_date) AS INTEGER) days_open FROM work_orders WHERE ${WO_OPEN} AND created_date != '' AND date(created_date) <= date('now','-30 days') ORDER BY created_date ASC LIMIT ${LIM}`);
  dd.woClosed = make(`Completed Work Orders (${rangeLabel(range)})`, [
    { key: "property_name", label: "Property" },
    { key: "unit", label: "Unit" },
    { key: "description", label: "Description" },
    { key: "created_date", label: "Created" },
    { key: "completed_date", label: "Completed" },
    { key: "days_to_close", label: "Days to Close" },
  ], `SELECT property_name, unit, description, created_date, completed_date, CAST(julianday(completed_date) - julianday(created_date) AS INTEGER) days_to_close FROM work_orders WHERE completed_date != '' AND created_date != '' AND completed_date >= created_date AND ${within("completed_date", range)} ORDER BY completed_date DESC LIMIT ${LIM}`);

  // Operations — insurance compliance
  const tenantInsCols = [
    { key: "tenant_name", label: "Tenant" },
    { key: "property_name", label: "Property" },
    { key: "unit", label: "Unit" },
    { key: "tenant_type", label: "Type" },
    { key: "insurance_company", label: "Carrier" },
    { key: "policy_number", label: "Policy #" },
    { key: "insurance_expiration", label: "Expires" },
  ];
  const tenantInsBase = `SELECT tenant_name, property_name, unit, tenant_type, insurance_company, policy_number, insurance_expiration FROM tenant_insurance WHERE status = 'Current' AND insurance_expiration != ''`;
  dd.tenantInsExpired = make("Tenant Insurance — Expired", tenantInsCols,
    `${tenantInsBase} AND date(insurance_expiration) < date('now') ORDER BY insurance_expiration ASC LIMIT ${LIM}`);
  dd.tenantInsExpiring = make("Tenant Insurance — Expiring in 60 Days", tenantInsCols,
    `${tenantInsBase} AND date(insurance_expiration) >= date('now') AND date(insurance_expiration) <= date('now','+60 days') ORDER BY insurance_expiration ASC LIMIT ${LIM}`);
  dd.tenantInsAll = make("Tenant Insurance — All Tracked Policies", tenantInsCols,
    `${tenantInsBase} ORDER BY insurance_expiration ASC LIMIT ${LIM}`);

  const vendorInsCols = [
    { key: "vendor_name", label: "Vendor" },
    { key: "vendor_type", label: "Type" },
    { key: "liability_expires", label: "Liability Expires" },
    { key: "workers_comp_expires", label: "Workers Comp" },
    { key: "auto_ins_expires", label: "Auto" },
    { key: "state_lic_expires", label: "State License" },
  ];
  const vendorInsBase = `SELECT vendor_name, vendor_type, liability_expires, workers_comp_expires, auto_ins_expires, state_lic_expires FROM vendors WHERE status != 'do_not_use'`;
  dd.vendorInsExpired = make("Vendor Liability Insurance — Expired", vendorInsCols,
    `${vendorInsBase} AND liability_expires != '' AND date(liability_expires) < date('now') ORDER BY liability_expires ASC LIMIT ${LIM}`);
  dd.vendorInsExpiring = make("Vendor Liability Insurance — Expiring in 60 Days", vendorInsCols,
    `${vendorInsBase} AND liability_expires != '' AND date(liability_expires) >= date('now') AND date(liability_expires) <= date('now','+60 days') ORDER BY liability_expires ASC LIMIT ${LIM}`);
  dd.vendorInsMissing = make("Vendors — No Liability Insurance on File", vendorInsCols,
    `${vendorInsBase} AND COALESCE(liability_expires,'') = '' ORDER BY vendor_name LIMIT ${LIM}`);
  dd.vendorInsAll = make("Vendor Insurance — All Tracked", vendorInsCols,
    `${vendorInsBase} AND liability_expires != '' ORDER BY liability_expires ASC LIMIT ${LIM}`);

  const ownerInsCols = [
    { key: "property_name", label: "Property" },
    { key: "owners", label: "Owner" },
    { key: "address", label: "Address" },
    { key: "insurance_expiration", label: "Insurance Expires" },
  ];
  dd.ownerInsExpired = make("Property Insurance — Expired", ownerInsCols,
    `SELECT property_name, owners, address, insurance_expiration FROM properties WHERE COALESCE(insurance_expiration,'') != '' AND date(insurance_expiration) < date('now') ORDER BY insurance_expiration ASC LIMIT ${LIM}`);
  dd.ownerInsExpiring = make("Property Insurance — Expiring in 60 Days", ownerInsCols,
    `SELECT property_name, owners, address, insurance_expiration FROM properties WHERE COALESCE(insurance_expiration,'') != '' AND date(insurance_expiration) >= date('now') AND date(insurance_expiration) <= date('now','+60 days') ORDER BY insurance_expiration ASC LIMIT ${LIM}`);
  dd.ownerInsMissing = make("Properties — No Insurance Expiration on File", ownerInsCols,
    `SELECT property_name, owners, address, insurance_expiration FROM properties WHERE COALESCE(insurance_expiration,'') = '' ORDER BY property_name LIMIT ${LIM}`);
  dd.ownerInsAll = make("Property Insurance — All Tracked", ownerInsCols,
    `SELECT property_name, owners, address, insurance_expiration FROM properties WHERE COALESCE(insurance_expiration,'') != '' ORDER BY insurance_expiration ASC LIMIT ${LIM}`);

  dd.owners = make("Owners", [
    { key: "owner_name", label: "Owner" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "property_count", label: "Properties" },
    { key: "status", label: "Status" },
  ], `SELECT owner_name, email, phone, property_count, status FROM owners ORDER BY owner_name LIMIT ${LIM}`);

  return dd;
}

// Returns a single drilldown { title, cols, rows } for the given key, or null.
export async function getDrilldown(key, range) {
  if (key === "income" || key === "grossIncome" || key === "netIncome") {
    const charts = await buildCharts();
    return {
      title: "Monthly Income & Expense (12 mo)",
      cols: [
        { key: "month", label: "Month" },
        { key: "gross", label: "Gross Income", money: true },
        { key: "expense", label: "Expense", money: true },
        { key: "net", label: "Net Income", money: true },
      ],
      rows: (charts.monthlyRevenue || []).slice().reverse(),
    };
  }
  const def = drillRegistry(range)[key];
  if (!def) return null;
  const rows = def.rowsFn ? def.rowsFn() : def.sql ? many(def.sql) : [];
  return { title: def.title, cols: def.cols, rows };
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function buildDashboard(range) {
  const occupancy = buildOccupancy();
  const leasing = buildLeasing(range);
  const marketing = buildMarketing(range);
  const maintenance = buildMaintenance();
  const operations = buildOperations(range);
  const [financials, charts] = await Promise.all([
    buildFinancials(),
    buildCharts(),
  ]);

  const lastSync =
    one("SELECT * FROM sync_log ORDER BY id DESC LIMIT 1") || {};

  const meta = {
    syncedAt: lastSync.completed_at || null,
    totalUnits: occupancy.totalUnits,
    totalProperties: occupancy.properties,
    totalOwners: occupancy.owners,
  };

  return {
    dashboard: {
      meta,
      occupancy,
      leasing,
      financials,
      marketing,
      maintenance,
      operations,
      charts,
    },
    sync: {
      lastSync: lastSync.completed_at || null,
      status: lastSync.status || "never",
      duration: lastSync.duration_ms || 0,
    },
  };
}

export { buildKpi };
