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
      "SELECT COUNT(*) c FROM units WHERE occupancy_status LIKE '%Vacant%' AND (lease_to IS NULL OR lease_to = '' OR lease_to < date('now'))"
    ).c
  );
  const vacantRented = num(
    one(
      "SELECT COUNT(*) c FROM units WHERE occupancy_status LIKE '%Vacant%' AND lease_to >= date('now')"
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

function buildLeasing() {
  const renewalDenom = num(
    one(
      "SELECT COUNT(*) c FROM renewals WHERE lease_end >= date('now','-12 months')"
    ).c
  );
  const renewalsCount = num(
    one(
      "SELECT COUNT(*) c FROM renewals WHERE renewal_status = 'Renewed' AND lease_end >= date('now','-12 months')"
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
      "SELECT COUNT(*) c FROM applications WHERE received_date >= date('now','-12 months')"
    ).c
  );
  const moveins = num(
    one(
      "SELECT COUNT(*) c FROM units WHERE move_in_date >= date('now','-12 months')"
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

function buildMarketing() {
  const inquiries = num(
    one(
      "SELECT COUNT(*) c FROM guest_cards WHERE received_date >= date('now','-30 days')"
    ).c
  );
  const activeProspects = num(
    one(
      "SELECT COUNT(*) c FROM guest_cards WHERE LOWER(status) IN ('active','prequalified','waitlisted')"
    ).c
  );
  const showingsTotal = num(
    one(
      "SELECT COUNT(*) c FROM showings WHERE showing_date >= date('now','-30 days')"
    ).c
  );
  const showingsCompleted = num(
    one("SELECT COUNT(*) c FROM showings WHERE status = 'Completed'").c
  );
  const showingsScheduleable = num(
    one(
      "SELECT COUNT(*) c FROM showings WHERE status NOT IN ('Canceled','Prospect Canceled','Canceled (Unconfirmed)')"
    ).c
  );
  const showingCompletionRate = showingsScheduleable
    ? round((showingsCompleted / showingsScheduleable) * 100)
    : 0;
  const noShows = num(
    one("SELECT COUNT(*) c FROM showings WHERE status = 'No Show'").c
  );
  const unitsOnMarket = num(one("SELECT COUNT(*) c FROM vacancies").c);

  const inquiriesBySource = many(
    "SELECT COALESCE(NULLIF(source,''),'Unknown') source, COUNT(*) count FROM guest_cards WHERE received_date >= date('now','-12 months') GROUP BY source ORDER BY count DESC LIMIT 12"
  ).map((r) => ({ source: r.source, count: num(r.count) }));

  const funnel = {
    inquiries: num(
      one(
        "SELECT COUNT(*) c FROM guest_cards WHERE received_date >= date('now','-30 days')"
      ).c
    ),
    showings: showingsTotal,
    applications: num(
      one(
        "SELECT COUNT(*) c FROM applications WHERE received_date >= date('now','-30 days')"
      ).c
    ),
    approved: num(
      one("SELECT COUNT(*) c FROM applications WHERE status = 'Approved'").c
    ),
    converted: num(
      one("SELECT COUNT(*) c FROM applications WHERE status = 'Converted'").c
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
      "SELECT AVG(julianday(completed_date) - julianday(created_date)) a FROM work_orders WHERE completed_date IS NOT NULL AND completed_date != '' AND created_date IS NOT NULL AND created_date != ''"
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
    else if (t.includes("tenant")) byType.tenantRequested += num(r.c);
    else byType.internal += num(r.c);
  }

  return { openWorkOrders, avgDaysToComplete, byPriority, byType };
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

// ── Entry point ───────────────────────────────────────────────────────────

export async function buildDashboard() {
  const occupancy = buildOccupancy();
  const leasing = buildLeasing();
  const marketing = buildMarketing();
  const maintenance = buildMaintenance();
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
