import { query, queryOne } from "./db.js";
import { buildLeadSimpleKpis } from "./ls-aggregator.js";
import { rentengine } from "./rentengine.js";
import { buildium } from "./buildium.js";

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ── SIGN CONVENTION ──────────────────────────────────────────────────────────
// After running /api/test-gl, set this based on Buildium's actual behavior.
// If income GL entries come back NEGATIVE (standard credit convention): true
// If income GL entries come back POSITIVE: false
const NEGATE_INCOME = false;
const NEGATE_EXPENSE = false;

function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : 0; }
function buildKpi(value, prevYear = 0, opts = {}) {
  return { value: value ?? 0, prevYear: prevYear ?? 0, ...opts };
}
function toET(d) {
  return new Date(d).toLocaleString("en-US", { timeZone: "America/New_York" });
}
function safe(promise, fallback) {
  return promise.catch((err) => { console.warn("[agg] non-fatal:", err.message); return fallback; });
}

// Run an async mapper over items with a concurrency cap. Used to avoid
// Buildium / RentEngine 429s when we'd otherwise fire 50+ calls in parallel.
async function pMap(items, concurrency, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function buildDashboard() {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const syncedAt = toET(now).replace(",", " ·");
  const yearAgoIso = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).toISOString().slice(0, 10);

  // ── RentEngine data (still live — not in DB yet) ───────────────────────
  const yearAgoFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString();
  const [reUnits, reProspects, reAppGroups, bdApplicants, bdVendors] = await Promise.all([
    safe(rentengine.listUnits(), []),
    safe(rentengine.listProspects(yearAgoFrom, now.toISOString()), []),
    safe(rentengine.listApplicationGroups({ createdAfter: yearAgoFrom, createdBefore: now.toISOString() }), []),
    safe(buildium.listApplicants(), []),
    safe(buildium.listVendors(["Active"]), []),
  ]);

  // Per-unit leasing performance (true days_on_market, showings, calls,
  // texts, applications, property_health) — one call per unit, run in
  // parallel. Each call is wrapped in safe() so a single 404/500 won't
  // poison the whole sync.
  const perfPeriodEnd = now.toISOString();
  const perfList = await Promise.all(
    reUnits.map(u => safe(rentengine.unitLeasingPerformance(u.id, yearAgoFrom, perfPeriodEnd), null))
  );
  const perfByUnit = new Map();
  perfList.forEach((p, i) => { if (p) perfByUnit.set(reUnits[i].id, p); });

  // Buildium applications submitted in the trailing 12 months
  // Each applicant record has Applications[] with ApplicationSubmittedDateTime.
  const yearAgoMs = new Date(yearAgoIso).getTime();
  const submittedApps = [];
  for (const a of bdApplicants) {
    for (const app of a.Applications || []) {
      const ts = app.ApplicationSubmittedDateTime;
      if (!ts) continue;
      const t = new Date(ts).getTime();
      if (t >= yearAgoMs && t <= now.getTime()) {
        submittedApps.push({ applicant: a, app });
      }
    }
  }

  // ── META ─────────────────────────────────────────────────────────────────
  const totalUnits = queryOne("SELECT COUNT(*) as c FROM units u JOIN properties p ON u.property_id = p.id WHERE p.is_active = 1")?.c || 0;
  const activeLeaseCount = queryOne("SELECT COUNT(*) as c FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id WHERE l.status = 'Active' AND p.is_active = 1")?.c || 0;

  const meta = {
    syncedAt, buildiumUnits: totalUnits, rentEngineUnits: reUnits.length, activeLeases: activeLeaseCount,
    liveMetrics: [
      "delinquent","delinquentCount","rentCollectedBy3rd","rentCollectedBy10th",
      "avgRentPerDoor","rpu","grossIncome","netIncome",
      "occupancy","totalUnits","vacantNotRented","vacantRented","avgDaysVacant",
      "doorsLost","netDoors","ownersTotal","ownersGained",
      "renewalRate","renewalsCount","fixedLeases","mtmLeases",
      "appsSubmitted","moveins","appsPerMovein","evictionsPending",
      "avgDaysOnMarket","medianDaysOnMarket","unitsOnMarket","newProspects",
      "showingsCompleted","totalCalls","totalTexts","completionRate",
      "avgTenancyMonths","avgSdWithheld","avgSdWithheldPct",
    ],
  };

  // Fetch ALL leases (active/past/future) once from Buildium. We need the
  // Tenants[] + MoveOutData[] arrays (not stored locally) for both the SD
  // calc below and the tenancy-length calc that chains renewals per tenant.
  const allLeasesAPI = await safe(buildium.listAllLeases(), []);
  const allPastFromAPI = allLeasesAPI.filter(l => l.LeaseStatus === "Past");

  // ── TENANCY LENGTH (trailing 12 months of move-outs) ──────────────────
  // Chain renewals: a tenant's true tenancy starts at their FIRST MoveInDate
  // on the unit (across all leases they appear on for that unit) and ends at
  // their MoveOutDate on the most recent lease. Lease start/end dates reset
  // every renewal in Buildium, so they undercount tenancy.
  const earliestMoveInByTenantUnit = new Map();
  for (const l of allLeasesAPI) {
    const unitId = l.UnitId;
    if (!unitId) continue;
    for (const t of (l.Tenants || [])) {
      const key = `${t.Id}-${unitId}`;
      const candidate = t.MoveInDate || l.LeaseFromDate;
      if (!candidate) continue;
      const existing = earliestMoveInByTenantUnit.get(key);
      if (!existing || candidate < existing) earliestMoveInByTenantUnit.set(key, candidate);
    }
  }

  // Active-property scope (matches every other metric in this file).
  const activePropIds = new Set(
    query("SELECT id FROM properties WHERE is_active = 1").map(r => r.id)
  );

  // Aggregate move-outs by (tenantId, unitId) so a tenant counted on multiple
  // lease records (or duplicate MoveOutData rows) collapses to ONE record at
  // their LATEST move-out for that unit. Then compute earliest move-in across
  // all leases for that (tenant, unit) pair.
  const moveOutsByKey = new Map(); // key -> { latestMoveOut, lease }
  for (const lease of allPastFromAPI) {
    if (!activePropIds.has(lease.PropertyId)) continue;
    for (const mo of (lease.MoveOutData || [])) {
      if (!mo.TenantId || !mo.MoveOutDate) continue;
      if (mo.MoveOutDate < yearAgoIso || mo.MoveOutDate > todayIso) continue;
      const key = `${mo.TenantId}|${lease.UnitId}`;
      const existing = moveOutsByKey.get(key);
      if (!existing || mo.MoveOutDate > existing.latestMoveOut) {
        moveOutsByKey.set(key, { latestMoveOut: mo.MoveOutDate, lease, tenantId: mo.TenantId });
      }
    }
  }

  const tenancyDays = [];
  for (const [key, { latestMoveOut, lease, tenantId }] of moveOutsByKey) {
    const earliest = earliestMoveInByTenantUnit.get(`${tenantId}-${lease.UnitId}`) || lease.LeaseFromDate;
    if (!earliest) continue;
    const days = Math.floor((new Date(latestMoveOut) - new Date(earliest)) / 86400000);
    if (!Number.isFinite(days) || days <= 0) continue;
    tenancyDays.push({
      tenantId,
      leaseId: lease.Id,
      propertyId: lease.PropertyId,
      unitNumber: lease.UnitNumber,
      from: earliest,
      to: latestMoveOut,
      days,
    });
  }
  const avgTenancyDays = tenancyDays.length
    ? Math.round(tenancyDays.reduce((s, r) => s + r.days, 0) / tenancyDays.length)
    : 0;
  const avgTenancyMonths = avgTenancyDays
    ? +(avgTenancyDays / 30.4375).toFixed(1)
    : 0;

  // ── SECURITY DEPOSIT WITHHELD ──────────────────────────────────────────
  // For each Past lease whose move-out (LeaseToDate) falls between 13 months
  // ago and 30 days ago — Limehouse posts the formal "Applied Deposit"
  // reconciliation roughly 30 days after move-out, so this window only
  // includes move-outs that have had time to be reconciled on the ledger.
  // Withheld = sum of |TotalAmount| across Buildium "ApplyDeposit"
  // transactions on that lease (capped at the original SD).
  // Uses pMap to throttle the per-lease transactions calls so we don't
  // trigger 429 rate-limit errors.
  // ms-math (not calendar math) to avoid Date overflow on month-end boundaries.
  const sdWindowEndIso = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const sdWindowStartIso = new Date(now.getTime() - 395 * 86400000).toISOString().slice(0, 10);
  const sdEligible = allPastFromAPI.filter(l => {
    if (!activePropIds.has(l.PropertyId)) return false;
    const sd = l.AccountDetails?.SecurityDeposit || 0;
    return sd > 0 && l.LeaseToDate && l.LeaseToDate >= sdWindowStartIso && l.LeaseToDate <= sdWindowEndIso;
  });
  const propByLeaseId = new Map(allPastFromAPI.map(l => [l.Id, { propertyId: l.PropertyId, unitNumber: l.UnitNumber }]));
  const txnLists = await pMap(sdEligible, 5, l => safe(buildium.leaseTransactions(l.Id), []));

  const sdRecords = [];
  sdEligible.forEach((lease, i) => {
    const leaseId = lease.Id;
    const sd = lease.AccountDetails?.SecurityDeposit || 0;
    const txns = txnLists[i] || [];
    // Buildium uses TransactionTypeEnum=ApplyDeposit for BOTH security-deposit
    // reconciliations AND monthly prepayment applications. Filter by memo.
    // Surveyed memo variants across 20 reconciled leases:
    //   "Deposit applied to balances"           (standard SD reconciliation)
    //   "Security Deposit applied to balances"  (less common SD variant)
    //   "Prepayment applied to balances"        (EXCLUDED — monthly prepay)
    // Both SD variants contain "deposit applied" (case-insensitive); the
    // prepayment variant does not. Cap-at-SD acts as a defense-in-depth
    // safety net if a future memo variant slips through.
    let withheld = 0;
    let applyDepositCount = 0;
    for (const t of txns) {
      if (t.TransactionTypeEnum !== "ApplyDeposit") continue;
      const memo = (t.Journal?.Memo || "").toLowerCase();
      if (!memo.includes("deposit applied")) continue; // skip "Prepayment applied"
      withheld += Math.abs(t.TotalAmount || 0);
      applyDepositCount += 1;
    }
    if (applyDepositCount === 0) return; // skip un-reconciled move-outs
    // Cap at SD: by accounting definition you can't withhold more than the
    // deposit. Anything beyond becomes a tenant debt / write-off, not a
    // "withholding". This also defends against any other ApplyDeposit memo
    // variants that might slip through the filter above.
    const cappedWithheld = Math.min(withheld, sd);
    const meta = propByLeaseId.get(leaseId) || {};
    sdRecords.push({
      leaseId,
      propertyId: meta.propertyId,
      unitNumber: meta.unitNumber,
      moveOutDate: lease.LeaseToDate,
      sd,
      withheld: cappedWithheld,
      pct: sd > 0 ? Math.min(100, +((cappedWithheld / sd) * 100).toFixed(1)) : 0,
    });
  });
  const avgSdWithheld = sdRecords.length
    ? Math.round(sdRecords.reduce((s, r) => s + r.withheld, 0) / sdRecords.length)
    : 0;
  const avgSdWithheldPct = sdRecords.length
    ? +(sdRecords.reduce((s, r) => s + r.pct, 0) / sdRecords.length).toFixed(1)
    : 0;

  // ── OCCUPANCY (using IsUnitOccupied) ───────────────────────────────────
  // Source of truth for occupancy = active leases (matches the "208 leases" header
  // and avoids stale Buildium `is_occupied` flags that linger after move-out).
  const occupiedUnits = queryOne(`SELECT COUNT(DISTINCT l.unit_id) as c FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id WHERE l.status = 'Active' AND p.is_active = 1`)?.c || 0;
  const vacantUnits = Math.max(totalUnits - occupiedUnits, 0);

  const futureLeaseUnitIds = query(`SELECT DISTINCT l.unit_id FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id WHERE l.status = 'Future' AND l.from_date > ? AND p.is_active = 1 AND l.unit_id NOT IN (SELECT unit_id FROM leases WHERE status = 'Active')`, [todayIso]);
  const vacantRentedCount = futureLeaseUnitIds.length;
  const vacantNotRentedCount = Math.max(vacantUnits - vacantRentedCount, 0);

  const vacantDaysRows = query(`SELECT u.id as unit_id, MAX(l.to_date) as last_end FROM units u JOIN properties p ON u.property_id = p.id LEFT JOIN leases l ON l.unit_id = u.id AND l.status = 'Past' WHERE p.is_active = 1 AND u.id NOT IN (SELECT unit_id FROM leases WHERE status = 'Active') GROUP BY u.id HAVING last_end IS NOT NULL`);
  const vacantDays = vacantDaysRows.map(r => Math.max(0, Math.floor((now - new Date(r.last_end)) / 86400000))).filter(d => Number.isFinite(d));
  const avgDaysVacant = vacantDays.length ? Math.round(vacantDays.reduce((a, b) => a + b, 0) / vacantDays.length) : 0;

  // ── DOORS ──────────────────────────────────────────────────────────────
  // Source of truth: daily property_snapshots table. Compare today's roster
  // (latest snapshot) against the oldest snapshot in the trailing 12 months.
  // Properties present today but missing from the baseline → gained. The
  // reverse → lost. This replaces the old owner-agreement-date method, which
  // depended on PM staff filling in agreement start/end dates in Buildium.
  const latestSnapDate = queryOne("SELECT MAX(snapshot_date) as d FROM property_snapshots")?.d;
  const baselineSnapDate = queryOne(
    "SELECT MIN(snapshot_date) as d FROM property_snapshots WHERE snapshot_date >= ?",
    [yearAgoIso]
  )?.d;
  const todaySnap = latestSnapDate
    ? query("SELECT property_id, name, unit_count FROM property_snapshots WHERE snapshot_date = ?", [latestSnapDate])
    : [];
  const baselineSnap = baselineSnapDate
    ? query("SELECT property_id, name, unit_count FROM property_snapshots WHERE snapshot_date = ?", [baselineSnapDate])
    : [];
  const todayMap = new Map(todaySnap.map(r => [r.property_id, r]));
  const baselineMap = new Map(baselineSnap.map(r => [r.property_id, r]));

  // Need at least two distinct snapshot dates to derive a diff.
  const haveDiff = latestSnapDate && baselineSnapDate && latestSnapDate !== baselineSnapDate;
  const propsGained = haveDiff
    ? todaySnap.filter(r => !baselineMap.has(r.property_id))
    : [];
  const propsLost = haveDiff
    ? baselineSnap.filter(r => !todayMap.has(r.property_id))
    : [];
  const doorsAdded = propsGained.reduce((s, r) => s + (r.unit_count || 0), 0);
  const doorsLost = propsLost.reduce((s, r) => s + (r.unit_count || 0), 0);
  const ownersTotal = queryOne("SELECT COUNT(*) as c FROM owners WHERE is_active = 1")?.c || 0;
  const netDoors = doorsAdded - doorsLost;
  const doorsCoverageDays = baselineSnapDate
    ? Math.floor((new Date(latestSnapDate) - new Date(baselineSnapDate)) / 86400000)
    : 0;

  const occupancy = {
    rate: buildKpi(pct(occupiedUnits, totalUnits), 0, { unit: "%" }),
    occupiedUnits, totalUnits,
    vacantNotRented: buildKpi(vacantNotRentedCount, 0, { invertDelta: true }),
    vacantRented: buildKpi(vacantRentedCount, 0),
    avgDaysVacant: buildKpi(avgDaysVacant, 0, { invertDelta: true }),
    doorsAdded: buildKpi(doorsAdded, 0),
    doorsLost: buildKpi(doorsLost, 0, { invertDelta: true }),
    netDoors: buildKpi(netDoors, 0),
    ownersTotal: buildKpi(ownersTotal, 0),
    ownersGained: buildKpi(propsGained.length, 0),
  };

  // ── LEASING ────────────────────────────────────────────────────────────
  const fixedLeases = queryOne(`SELECT COUNT(*) as c FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id WHERE l.status = 'Active' AND p.is_active = 1 AND (l.type = 'Fixed' OR l.type = 'FixedWithRollover')`)?.c || 0;
  const mtmLeases = queryOne(`SELECT COUNT(*) as c FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id WHERE l.status = 'Active' AND p.is_active = 1 AND l.type = 'AtWill'`)?.c || 0;

  const renewalsInWindow = queryOne(`SELECT COUNT(*) as c FROM renewal_history WHERE created_at >= ?`, [yearAgoIso])?.c || 0;
  const churnedInWindow = queryOne(`SELECT COUNT(*) as c FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id WHERE l.status = 'Past' AND p.is_active = 1 AND l.to_date >= ? AND l.to_date <= ?`, [yearAgoIso, todayIso])?.c || 0;
  const renewalDenominator = renewalsInWindow + churnedInWindow;
  const renewalRate = renewalDenominator ? Math.round((renewalsInWindow / renewalDenominator) * 1000) / 10 : 0;
  const evictionsPendingCount = queryOne(`SELECT COUNT(*) as c FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id WHERE l.status = 'Active' AND l.is_eviction_pending = 1 AND p.is_active = 1`)?.c || 0;

  const appsSubmitted = submittedApps.length;
  // Move-ins from Buildium: leases that started in the trailing 12 months and aren't Future
  const moveinsRows = query(`SELECT l.id, l.from_date FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id WHERE p.is_active = 1 AND l.status != 'Future' AND l.from_date >= ? AND l.from_date <= ?`, [yearAgoIso, todayIso]);
  const moveins = moveinsRows.length;

  const leasing = {
    renewalRate: buildKpi(renewalRate, 0, { unit: "%" }),
    renewalsCount: buildKpi(renewalsInWindow, 0),
    mtmLeases: buildKpi(mtmLeases, 0, { invertDelta: true }),
    fixedLeases: buildKpi(fixedLeases, 0),
    appsSubmitted: buildKpi(appsSubmitted, 0),
    moveins: buildKpi(moveins, 0),
    appsPerMovein: buildKpi(moveins ? +(appsSubmitted / moveins).toFixed(1) : 0, 0),
    evictionsPending: buildKpi(evictionsPendingCount, 0, { invertDelta: true }),
    avgTenancyMonths: buildKpi(avgTenancyMonths, 0, { unit: "mo" }),
  };

  // ── FINANCIALS ─────────────────────────────────────────────────────────
  const latestSnap = queryOne("SELECT * FROM daily_snapshots ORDER BY date DESC LIMIT 1");
  const delinquentCount = latestSnap?.delinquent_count || 0;
  // Pull the exact (un-rounded) total from outstanding_snapshots so the tile shows cents.
  const latestObSnapDate = queryOne("SELECT MAX(snapshot_date) as d FROM outstanding_snapshots")?.d;
  const exactDelinqRow = latestObSnapDate ? queryOne("SELECT SUM(total_balance) as t FROM outstanding_snapshots WHERE snapshot_date = ?", [latestObSnapDate]) : null;
  const delinquentTotal = exactDelinqRow?.t ?? (latestSnap?.delinquent_total || 0);

  const rentResult = queryOne(`SELECT AVG(l.rent) as avg_rent, SUM(l.rent) as total_rent FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id WHERE l.status = 'Active' AND p.is_active = 1 AND l.rent > 0`);
  const avgRentPerLease = Math.round(rentResult?.avg_rent || 0);
  const totalRentPotential = rentResult?.total_rent || 0;

  // Monthly GL income (last 12 months)
  const months = [];
  const ytdMonthCount = now.getUTCMonth() + 1;
  for (let i = 0; i < ytdMonthCount; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), i, 1));
    months.push({
      label: MONTH_LABELS[d.getUTCMonth()], year: d.getUTCFullYear(),
      start: d.toISOString().slice(0, 10),
      end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10),
    });
  }

  const incSign = NEGATE_INCOME ? "ABS(amount)" : "amount";
  const expSign = NEGATE_EXPENSE ? "ABS(amount)" : "amount";

  // Income tiles + YoY chart read from gl_company_cash — Cash basis, Company
  // entity only — to match Buildium's "Cash Flow Statement" report exactly.
  // Keep raw cents end-to-end — rounding each month and then summing causes
  // the drilldown total to drift a few dollars off the tile and off Buildium.
  const incomeByMonth = months.map(m => {
    const row = queryOne(`SELECT SUM(CASE WHEN gl_account_type = 'Income' THEN ${incSign} ELSE 0 END) as gross, SUM(CASE WHEN gl_account_type = 'Expense' THEN ${expSign} ELSE 0 END) as expense FROM gl_company_cash WHERE date >= ? AND date <= ?`, [m.start, m.end]);
    const gross = +(row?.gross || 0);
    const expense = +(row?.expense || 0);
    return { month: m.label, gross, net: gross - expense, _expense: expense };
  });
  const grossIncomeTotal = incomeByMonth.reduce((s, m) => s + m.gross, 0);
  const netIncomeTotal = incomeByMonth.reduce((s, m) => s + m.net, 0);

  // RPU = last complete month total income / units. Pulls from gl_company_cash
  // (the same Cash-basis Company-entity source as the Gross income tile) so the
  // numerator equals that month's reported gross income exactly.
  const lcm = months.length >= 2 ? months[months.length - 2] : months[0]; // last complete month
  const rpuIncome = lcm ? (queryOne(`SELECT SUM(CASE WHEN gl_account_type = 'Income' THEN ${incSign} ELSE 0 END) as inc FROM gl_company_cash WHERE date >= ? AND date <= ?`, [lcm.start, lcm.end])?.inc || 0) : 0;
  const rpuValue = totalUnits ? Math.round(rpuIncome / totalUnits) : 0;

  // Rent collection by Nth (from daily_snapshots)
  function rentByDay(N) {
    let paid = 0, total = 0, counted = 0;
    for (let i = 0; i < 6; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const prefix = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const snap = queryOne(`SELECT * FROM daily_snapshots WHERE date LIKE ? AND CAST(substr(date, 9, 2) AS INTEGER) BETWEEN ? AND ? ORDER BY date ASC LIMIT 1`, [`${prefix}%`, N, N + 5]);
      if (snap && snap.active_leases) { paid += snap.paid_lease_count; total += snap.active_leases; counted++; }
    }
    return { value: total ? Math.round((paid / total) * 1000) / 10 : 0, monthsCounted: counted };
  }
  const by3rd = rentByDay(3);
  const by10th = rentByDay(10);

  // YTD income (Jan 1 of current year to today)
  const ytdStart = now.getUTCFullYear() + "-01-01";
  const ytdGross = queryOne(`SELECT SUM(CASE WHEN gl_account_type = 'Income' THEN amount ELSE 0 END) as total FROM gl_company_cash WHERE date >= ?`, [ytdStart])?.total || 0;
  const ytdExpense = queryOne(`SELECT SUM(CASE WHEN gl_account_type = 'Expense' THEN amount ELSE 0 END) as total FROM gl_company_cash WHERE date >= ?`, [ytdStart])?.total || 0;
  const ytdNet = ytdGross - ytdExpense;

  const financials = {
    rentCollectedBy3rd: buildKpi(by3rd.value, 0, { unit: "%" }),
    rentCollectedBy10th: buildKpi(by10th.value, 0, { unit: "%" }),
    avgRentPerDoor: buildKpi(avgRentPerLease, 0, { unit: "$" }),
    rpu: buildKpi(rpuValue, 0, { unit: "$" }),
    grossIncome: buildKpi(ytdGross, 0, { unit: "$", decimals: 2 }),
    netIncome: buildKpi(ytdNet, 0, { unit: "$", decimals: 2 }),
    delinquent: buildKpi(Math.round(delinquentTotal * 100) / 100, 0, { unit: "$", invertDelta: true }),
    delinquentCount: buildKpi(delinquentCount, 0, { invertDelta: true }),
    avgSdWithheld: buildKpi(avgSdWithheld, 0, { unit: "$" }),
    avgSdWithheldPct: buildKpi(avgSdWithheldPct, 0, { unit: "%" }),
  };

  // ── MARKETING (RentEngine) ─────────────────────────────────────────────
  const newProspects = reProspects.length;
  const sourceCounts = {};
  // Normalize source names: RentEngine stores casing inconsistently
  // (e.g. "Rent.com" vs "rent.com" vs "rent" — all the same source).
  const SOURCE_CANONICAL = {
    "rent.com": "Rent.com", "rent": "Rent.com",
    "zillow": "Zillow", "apartments.com": "Apartments.com",
    "trulia": "Trulia", "realtor.com": "Realtor.com",
    "homes.com": "Homes.com", "hotpads": "HotPads",
    "zumper": "Zumper", "rentengine": "RentEngine",
    "website widget": "Website Widget", "text message": "Text Message",
    "text ai": "Text AI", "phone call": "Phone Call",
    "for rent sign": "For Rent Sign", "other": "Other",
  };
  const canonSource = (s) => {
    if (!s) return "Other";
    return SOURCE_CANONICAL[s.trim().toLowerCase()] || s;
  };
  for (const p of reProspects) { const s = canonSource(p.source); sourceCounts[s] = (sourceCounts[s] || 0) + 1; }
  const SOURCE_COLORS = { Zillow: "#3d8c1f", "Apartments.com": "#2471a3", Trulia: "#7d3c98", Direct: "#d68910", Other: "#aab5a3" };
  const prospectsBySource = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, color: SOURCE_COLORS[label] || "#aab5a3" }));

  // "Units on market" = anything in RentEngine that isn't actively leased.
  // We deliberately do NOT gate on `is_occupied` — that flag often lags reality
  // in RentEngine (units stay flagged occupied after move-out until the listing
  // is republished). Counting by status matches what staff see in RentEngine.
  const reAvailable = reUnits.filter(u => !/leased/i.test(u.status || ""));
  const unitsOnMarket = reAvailable.length;
  // True days-on-market from RentEngine per-unit reporting (only on-market units).
  const dom = reAvailable
    .map(u => perfByUnit.get(u.id)?.days_on_market)
    .filter(v => v != null && Number.isFinite(v));
  const avgDaysOnMarket = dom.length ? Math.round(dom.reduce((a, b) => a + b, 0) / dom.length) : 0;
  const sortedDom = [...dom].sort((a, b) => a - b);
  const medianDaysOnMarket = sortedDom.length ? sortedDom[Math.floor(sortedDom.length / 2)] : 0;

  // Roll-ups across ALL RE units in the trailing 12 months (showings, calls,
  // texts, applications) from the same per-unit reporting endpoint.
  let showingsScheduled = 0, showingsCompleted = 0, totalCalls = 0, totalTexts = 0, appsRequestedRE = 0, appsSubmittedRE = 0;
  for (const p of perfByUnit.values()) {
    showingsScheduled += p.showings_scheduled || 0;
    showingsCompleted += p.showings_completed || 0;
    totalCalls        += p.total_calls || 0;
    totalTexts        += p.outbound_texts || 0;
    appsRequestedRE   += p.applications_requested || 0;
    appsSubmittedRE   += p.applications_submitted || 0;
  }
  const completionRate = showingsScheduled > 0
    ? Math.round((showingsCompleted / showingsScheduled) * 1000) / 10
    : 0;

  const marketing = {
    unitsOnMarket: buildKpi(unitsOnMarket, 0, { invertDelta: true }),
    avgDaysOnMarket: buildKpi(avgDaysOnMarket, 0, { invertDelta: true }),
    medianDaysOnMarket: buildKpi(medianDaysOnMarket, 0, { invertDelta: true }),
    newProspects: buildKpi(newProspects, 0),
    showingsCompleted: buildKpi(showingsCompleted, 0),
    totalCalls: buildKpi(totalCalls, 0),
    totalTexts: buildKpi(totalTexts, 0),
    completionRate: buildKpi(completionRate, 0, { unit: "%" }),
  };

  // ── SPARKLINES ─────────────────────────────────────────────────────────
  const flat = v => Array(12).fill(v);
  const prospectsByMonth = months.map(() => 0);
  for (const p of reProspects) { const d = new Date(p.created_at); const idx = months.findIndex(m => m.start.slice(0, 7) === d.toISOString().slice(0, 7)); if (idx >= 0) prospectsByMonth[idx]++; }

  const renewalsByMonthCount = months.map(m => queryOne(`SELECT COUNT(*) as c FROM renewal_history WHERE created_at >= ? AND created_at < ?`, [m.start, m.end])?.c || 0);

  const spark = {
    occupancy: flat(occupancy.rate.value),
    rentCollected3rd: flat(by3rd.value), rentCollected10th: flat(by10th.value),
    doorsAdded: flat(0), doorsLost: flat(0),
    renewalRate: renewalsByMonthCount,
    avgRent: flat(avgRentPerLease), rpu: flat(rpuValue),
    grossIncome: incomeByMonth.map(m => m.gross), netIncome: incomeByMonth.map(m => m.net),
    daysOnMarket: flat(avgDaysOnMarket),
    delinquent: flat(financials.delinquent.value),
    prospects: prospectsByMonth, showings: flat(0),
  };

  // ── CHART DATA ─────────────────────────────────────────────────────────
  // Per-month rent collection — pulled from the same daily_snapshots source
  // that drives the by-3rd / by-10th KPI tiles. For each month we look for a
  // snapshot taken on day N..N+5 (matches rentByDay window) and use it as the
  // "% paid by day N" reading. Months with no snapshot stay at 0.
  function rentMonth(monthStart, N) {
    const prefix = monthStart.slice(0, 7); // YYYY-MM
    const snap = queryOne(`SELECT * FROM daily_snapshots WHERE date LIKE ? AND CAST(substr(date, 9, 2) AS INTEGER) BETWEEN ? AND ? ORDER BY date ASC LIMIT 1`, [`${prefix}%`, N, N + 5]);
    if (!snap || !snap.active_leases) return 0;
    return Math.round((snap.paid_lease_count / snap.active_leases) * 1000) / 10;
  }
  const rentCollectionByMonth = months.map(m => ({
    month: m.label,
    by3rd: rentMonth(m.start, 3),
    by10th: rentMonth(m.start, 10),
  }));
  const doorsMonthly = months.map(m => ({ month: m.label, added: 0, lost: 0 }));
  const renewalsByMonth = months.map((m, i) => ({ month: m.label, count: renewalsByMonthCount[i] || 0 }));
  // Occupancy trend — for each month use the latest snapshot taken on or
  // before that month's end (so the line steps with real changes). Months
  // before any snapshot fall back to the earliest snapshot's rate so the
  // chart isn't broken; once historical snapshots accumulate the line will
  // reflect actual month-by-month movement.
  const earliestSnap = queryOne(`SELECT total_units, occupied_units FROM daily_snapshots WHERE total_units > 0 ORDER BY date ASC LIMIT 1`);
  const earliestRate = earliestSnap ? Math.round((earliestSnap.occupied_units / earliestSnap.total_units) * 1000) / 10 : occupancy.rate.value;
  const occupancyTrend = months.map(m => {
    const snap = queryOne(`SELECT total_units, occupied_units FROM daily_snapshots WHERE date <= ? AND total_units > 0 ORDER BY date DESC LIMIT 1`, [m.end]);
    const rate = snap ? Math.round((snap.occupied_units / snap.total_units) * 1000) / 10 : earliestRate;
    return { month: m.label, rate };
  });
  const delinquentTrend = months.map(m => ({ month: m.label, amount: +(financials.delinquent.value / 1000).toFixed(1) }));

  // Aging buckets from latest outstanding snapshot
  const latestObDate = queryOne("SELECT MAX(snapshot_date) as d FROM outstanding_snapshots")?.d;
  const agingBuckets = [
    { label: "0–30", amount: 0, color: "#d68910" }, { label: "31–60", amount: 0, color: "#3d8c1f" },
    { label: "61–90", amount: 0, color: "#c0392b" }, { label: "90+", amount: 0, color: "#8b1f15" },
  ];
  if (latestObDate) {
    const ag = queryOne("SELECT SUM(balance_0_30) as b0, SUM(balance_31_60) as b1, SUM(balance_61_90) as b2, SUM(balance_over_90) as b3 FROM outstanding_snapshots WHERE snapshot_date = ?", [latestObDate]);
    if (ag) { agingBuckets[0].amount = Math.round(ag.b0 || 0); agingBuckets[1].amount = Math.round(ag.b1 || 0); agingBuckets[2].amount = Math.round(ag.b2 || 0); agingBuckets[3].amount = Math.round(ag.b3 || 0); }
  }

  // Property health from RentEngine per-unit reporting (on-market units only).
  // Off-market = vacant units that aren't currently listed in RentEngine.
  const healthCounts = { Healthy: 0, "At-risk": 0, Waitlist: 0, "On Hold": 0, "Off-Market": 0, Commercial: 0 };
  for (const u of reAvailable) {
    const h = perfByUnit.get(u.id)?.property_health || "Unknown";
    if (healthCounts[h] != null) healthCounts[h] += 1;
    else healthCounts[h] = 1;
  }
  // Treat any vacant unit not in RE as Off-Market.
  healthCounts["Off-Market"] = Math.max(vacantUnits - unitsOnMarket, 0);
  const marketingFunnel = [
    { label: "Prospects", value: newProspects },
    { label: "Showings scheduled", value: showingsScheduled },
    { label: "Showings completed", value: showingsCompleted },
    { label: "Applications", value: appsSubmitted },
    { label: "Move-ins", value: moveins },
  ];

  // ── YoY Chart Data ─────────────────────────────────────────────────────
  // Income YoY — gross and net per month per year (from gl_company_cash, same
  // source as the YTD tiles). Powers the two side-by-side year-over-year line
  // charts on the dashboard.
  const incYoY = query(`SELECT CAST(strftime('%Y', date) AS INTEGER) as year, CAST(strftime('%m', date) AS INTEGER) as month, SUM(CASE WHEN gl_account_type = 'Income' THEN ${incSign} ELSE 0 END) as gross, SUM(CASE WHEN gl_account_type = 'Expense' THEN ${expSign} ELSE 0 END) as expense FROM gl_company_cash GROUP BY year, month ORDER BY year, month`);
  const grossByYear = {}, netByYear = {}, goiByYear = {};
  for (const r of incYoY) {
    if (!grossByYear[r.year]) { grossByYear[r.year] = {}; netByYear[r.year] = {}; goiByYear[r.year] = {}; }
    grossByYear[r.year][r.month] = Math.round(r.gross);
    netByYear[r.year][r.month]   = Math.round(r.gross - r.expense);
    goiByYear[r.year][r.month]   = Math.round(r.gross - r.expense); // alias kept for any old refs
  }

  // RPU YoY uses the same gl_company_cash source as the RPU tile so the line
  // chart and the tile agree (both = company gross income per unit).
  const rpuYoY = query(`SELECT CAST(strftime('%Y', date) AS INTEGER) as year, CAST(strftime('%m', date) AS INTEGER) as month, SUM(CASE WHEN gl_account_type = 'Income' THEN ${incSign} ELSE 0 END) as inc FROM gl_company_cash GROUP BY year, month ORDER BY year, month`);
  const rpuByYear = {};
  for (const r of rpuYoY) {
    if (!rpuByYear[r.year]) rpuByYear[r.year] = {};
    const snapUnits = queryOne("SELECT total_units FROM daily_snapshots WHERE date LIKE ? ORDER BY date DESC LIMIT 1", [`${r.year}-${String(r.month).padStart(2, "0")}%`])?.total_units || totalUnits;
    rpuByYear[r.year][r.month] = snapUnits > 0 ? Math.round(r.inc / snapUnits) : 0;
  }

  // ── ROLE KPIS (Performance by Role section, CEO view) ──────────────────
  // Wires 7 KPIs to live Buildium/RentEngine data; remaining KPIs are left
  // null (rendered as gray dashes). Frontend computes RAG status from
  // value/target/direction so the data shape stays simple.
  const occupancyRate = occupancy.rate.value;
  const delinquencyRate = totalRentPotential > 0
    ? Math.round((delinquentTotal / totalRentPotential) * 1000) / 10
    : null;

  // Vendor compliance — active vendors with TaxPayerId AND non-expired insurance.
  const todayMs = now.getTime();
  let vendorCompliancePct = null;
  let vendor1099Pct = null;
  if (Array.isArray(bdVendors) && bdVendors.length) {
    const compliant = bdVendors.filter(v => {
      const tax = v.VendorTaxInformation || v.TaxInformation || v.VendorMessage?.TaxInformation;
      const ins = v.VendorInsurance || v.VendorMessage?.VendorInsurance;
      const hasTax = !!(tax?.TaxPayerId && String(tax.TaxPayerId).trim());
      const insExp = ins?.ExpirationDate ? new Date(ins.ExpirationDate).getTime() : 0;
      return hasTax && insExp > todayMs;
    }).length;
    vendorCompliancePct = Math.round((compliant / bdVendors.length) * 1000) / 10;

    const v1099 = bdVendors.filter(v => {
      const tax = v.VendorTaxInformation || v.TaxInformation || v.VendorMessage?.TaxInformation;
      return tax && tax.IncludeIn1099 === true;
    });
    if (v1099.length) {
      const ok = v1099.filter(v => {
        const tax = v.VendorTaxInformation || v.TaxInformation || v.VendorMessage?.TaxInformation;
        return !!(tax?.TaxPayerId && String(tax.TaxPayerId).trim());
      }).length;
      vendor1099Pct = Math.round((ok / v1099.length) * 1000) / 10;
    }
  }

  // ── RECONCILIATION ACCURACY ────────────────────────────────────────────
  // Pull reconciliations for each active bank account. "Accuracy" = % of
  // expected monthly reconciliations (one per active bank account per month)
  // completed in the last 12 fully-elapsed months.
  let reconAccuracyPct = null;
  let reconTotalDone = 0;
  let reconTotalExpected = 0;
  const reconRowsRaw = [];
  const bankAccounts = await safe(buildium.listBankAccounts(), []);
  const activeBankAccounts = (bankAccounts || []).filter(b => b.GLAccount?.IsActive !== false);
  if (activeBankAccounts.length) {
    const expectedMonths = [];
    const mc = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    for (let i = 0; i < 12; i++) {
      expectedMonths.push(`${mc.getFullYear()}-${String(mc.getMonth() + 1).padStart(2, "0")}`);
      mc.setMonth(mc.getMonth() - 1);
    }
    const reconLists = await pMap(activeBankAccounts, 5, b => safe(buildium.listReconciliations(b.Id), []));
    activeBankAccounts.forEach((b, i) => {
      const finished = (reconLists[i] || []).filter(r => r.IsFinished);
      finished.sort((a, c) => (c.StatementEndingDate || "").localeCompare(a.StatementEndingDate || ""));
      const doneMonths = new Set(finished.map(r => (r.StatementEndingDate || "").slice(0, 7)));
      const monthsDone = expectedMonths.filter(m => doneMonths.has(m)).length;
      reconTotalExpected += expectedMonths.length;
      reconTotalDone += monthsDone;
      reconRowsRaw.push({
        name: b.GLAccount?.Name || `#${b.Id}`,
        lastFinished: finished[0]?.StatementEndingDate || null,
        monthsDone,
      });
    });
    if (reconTotalExpected > 0) {
      reconAccuracyPct = Math.round((reconTotalDone / reconTotalExpected) * 1000) / 10;
    }
    reconRowsRaw.sort((a, c) => c.monthsDone - a.monthsDone || a.name.localeCompare(c.name));
  }

  // ── RENT PROCESSING ACCURACY ───────────────────────────────────────────
  // For every active lease, count Payment vs ReversePayment transactions in
  // the trailing 90 days. accuracy = 1 − (reversals ÷ payments). Throttled
  // to concurrency 5 to stay under Buildium's rate limit. Adds ~30–60s per
  // full sync; cached for 10 min.
  let rentProcessingPct = null;
  let rpPayments = 0;
  let rpReversals = 0;
  const rentReversalRowsRaw = [];
  const activeLeasesForRP = allLeasesAPI.filter(l => l.LeaseStatus === "Active");
  const rpWindowStartIso = new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  if (activeLeasesForRP.length) {
    const rpTxnLists = await pMap(activeLeasesForRP, 5, l => safe(buildium.leaseTransactions(l.Id), []));
    activeLeasesForRP.forEach((lease, i) => {
      const txs = rpTxnLists[i] || [];
      for (const t of txs) {
        if (!t.Date || t.Date < rpWindowStartIso) continue;
        const type = t.TransactionTypeEnum || t.TransactionType;
        if (type === "Payment") rpPayments++;
        else if (type === "ReversePayment") {
          rpReversals++;
          rentReversalRowsRaw.push({
            propertyId: lease.PropertyId,
            unitNumber: lease.UnitNumber,
            date: t.Date,
            amount: Math.abs(Number(t.TotalAmount) || 0),
          });
        }
      }
    });
    if (rpPayments > 0) {
      rentProcessingPct = Math.round(((rpPayments - rpReversals) / rpPayments) * 1000) / 10;
    }
    rentReversalRowsRaw.sort((a, c) => (c.date || "").localeCompare(a.date || ""));
  }

  const roleKpis = {
    asOf: todayIso,
    vendorCount: Array.isArray(bdVendors) ? bdVendors.length : 0,
    roles: [
      {
        abbrev: "PM", name: "Portfolio Manager", people: 3,
        kpis: [
          { name: "Portfolio Occupancy Rate", source: "BD", target: 95, direction: "gte", format: "pct", value: occupancyRate,    drillKey: "kpiOccupancyRate" },
          { name: "Delinquency Rate",         source: "BD", target: 3,  direction: "lte", format: "pct", value: delinquencyRate,  drillKey: "kpiDelinquencyRate" },
        ],
      },
      {
        abbrev: "APM", name: "Assistant Property Manager", people: 2,
        kpis: [
          { name: "Showing Completion Rate", source: "RE", target: 95, direction: "gte", format: "pct", value: completionRate || null, drillKey: "kpiShowingCompletion" },
        ],
      },
      {
        abbrev: "BC", name: "Bookkeeping Coordinator", people: 1,
        kpis: [
          { name: "Reconciliation Accuracy",  source: "BD", target: 100, direction: "gte", format: "pct", value: reconAccuracyPct,    drillKey: "kpiReconciliation" },
          { name: "Rent Processing Accuracy", source: "BD", target: 100, direction: "gte", format: "pct", value: rentProcessingPct,   drillKey: "kpiRentProcessing" },
          { name: "Vendor Compliance",        source: "BD", target: 100, direction: "gte", format: "pct", value: vendorCompliancePct, drillKey: "kpiVendorCompliance" },
          { name: "1099 Compliance",          source: "BD", target: 100, direction: "gte", format: "pct", value: vendor1099Pct, targetLabel: "100% by Jan", drillKey: "kpi1099Compliance" },
        ],
      },
    ],
  };

  // ── ASSEMBLE ───────────────────────────────────────────────────────────
  const dashboard = {
    meta, spark, financials, occupancy, leasing, marketing,
    rentCollectionByMonth, doorsMonthly, renewalsByMonth,
    healthCounts, agingBuckets, prospectsBySource, marketingFunnel,
    delinquentTrend, incomeMonthly: incomeByMonth, occupancyTrend,
    rentIncreaseDistribution: [], rentCollectionDetail: [], doorsAddedDetail: [],
    goiByYear, rpuByYear, grossByYear, netByYear,
    roleKpis,
  };

  // ── DRILLDOWNS (simplified — full list for each tile) ──────────────────
  const propMap = new Map(query("SELECT id, name FROM properties").map(p => [p.id, p.name]));
  const propName = pid => propMap.get(pid) || `#${pid || "—"}`;
  // RentEngine units carry a full postal address (with unit) under `address`.
  // Prefer the human-readable address over the opaque numeric RentEngine id.
  const reAddr = u => u?.address?.formatted_address || `#${u?.id ?? "—"}`;
  const notWired = (title, reason) => ({ title, cols: ["Note"], rows: [[reason]], summary: "No data" });
  const activeLeaseRows = query(`SELECT l.id, l.property_id, u.unit_number, l.rent, l.type, l.from_date, l.to_date FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id WHERE l.status = 'Active' AND p.is_active = 1 ORDER BY l.rent DESC LIMIT 500`);

  const drilldowns = {
    delinquent: { title: "Delinquent leases", cols: ["Property", "Unit", "Balance"], rows: latestObDate ? query(`SELECT o.lease_id, o.total_balance, l.property_id, u.unit_number FROM outstanding_snapshots o LEFT JOIN leases l ON l.id = o.lease_id LEFT JOIN units u ON u.id = l.unit_id WHERE o.snapshot_date = ? ORDER BY o.total_balance DESC LIMIT 200`, [latestObDate]).map(r => [propName(r.property_id), r.unit_number || "—", `$${(r.total_balance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`]) : [], summary: `${delinquentCount} leases · $${(delinquentTotal ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
    occupancy: { title: "Occupied units", cols: ["Property", "Unit", "Rent"], rows: activeLeaseRows.map(l => [propName(l.property_id), l.unit_number || "—", l.rent ? `$${Math.round(l.rent).toLocaleString()}` : "—"]), summary: `${occupiedUnits}/${totalUnits} · ${pct(occupiedUnits, totalUnits)}%` },
    totalUnits: { title: "All units", cols: ["Property", "Unit", "Occupied"], rows: query("SELECT u.id, u.property_id, u.unit_number, u.is_occupied FROM units u JOIN properties p ON u.property_id = p.id WHERE p.is_active = 1 LIMIT 500").map(u => [propName(u.property_id), u.unit_number || "—", u.is_occupied ? "yes" : "no"]), summary: `${totalUnits} units` },
    vacantNotRented: { title: "Vacant (no future lease)", cols: ["Property", "Unit"], rows: query(`SELECT u.id, u.property_id, u.unit_number FROM units u JOIN properties p ON u.property_id = p.id WHERE p.is_active = 1 AND u.id NOT IN (SELECT unit_id FROM leases WHERE status = 'Active') AND u.id NOT IN (SELECT DISTINCT unit_id FROM leases WHERE status = 'Future' AND from_date > ?) LIMIT 500`, [todayIso]).map(u => [propName(u.property_id), u.unit_number || "—"]), summary: `${vacantNotRentedCount} vacant` },
    vacantRented: { title: "Vacant with future lease", cols: ["Property", "Unit", "Lease starts"], rows: futureLeaseUnitIds.length ? query(`SELECT u.unit_number, u.property_id, l.from_date FROM leases l JOIN units u ON l.unit_id = u.id WHERE l.status = 'Future' AND l.from_date > ? AND u.id NOT IN (SELECT unit_id FROM leases WHERE status = 'Active') LIMIT 200`, [todayIso]).map(r => [propName(r.property_id), r.unit_number || "—", r.from_date || "—"]) : [], summary: `${vacantRentedCount} pre-leased` },
    avgDaysVacant: { title: "Vacant units", cols: ["Property", "Unit", "Days vacant"], rows: query(`SELECT u.id, u.property_id, u.unit_number, MAX(l.to_date) as last_end FROM units u JOIN properties p ON u.property_id = p.id LEFT JOIN leases l ON l.unit_id = u.id AND l.status = 'Past' WHERE p.is_active = 1 AND u.id NOT IN (SELECT unit_id FROM leases WHERE status = 'Active') GROUP BY u.id ORDER BY last_end DESC LIMIT 500`).map(r => [propName(r.property_id), r.unit_number || "—", r.last_end ? String(Math.max(0, Math.floor((now - new Date(r.last_end)) / 86400000))) : "Never rented"]), summary: `Avg ${avgDaysVacant} days · ${vacantUnits} vacant (${vacantDaysRows.length} with prior leases)` },
    doorsAdded: {
      title: "Doors added (trailing 12 mo)",
      cols: ["Property", "Doors"],
      rows: propsGained.map(p => [p.name || `#${p.property_id}`, String(p.unit_count || 0)]),
      summary: haveDiff
        ? `${doorsAdded} doors across ${propsGained.length} properties (vs roster on ${baselineSnapDate})`
        : `Baseline pending — ${doorsCoverageDays} day(s) of snapshot coverage so far`,
      note: `Properties on the active roster today (${latestSnapDate || "—"}) that were NOT on the roster ${doorsCoverageDays} day(s) ago (${baselineSnapDate || "—"}). A daily snapshot is taken automatically with every sync; the trailing-12-month baseline will be reached once snapshots have accumulated for a full year.`,
    },
    doorsLost: {
      title: "Doors lost (trailing 12 mo)",
      cols: ["Property", "Doors"],
      rows: propsLost.map(p => [p.name || `#${p.property_id}`, String(p.unit_count || 0)]),
      summary: haveDiff
        ? `${doorsLost} doors across ${propsLost.length} properties (vs roster on ${baselineSnapDate})`
        : `Baseline pending — ${doorsCoverageDays} day(s) of snapshot coverage so far`,
      note: `Properties that were on the active roster ${doorsCoverageDays} day(s) ago (${baselineSnapDate || "—"}) but are NOT on the roster today (${latestSnapDate || "—"}). Unit count reflects the door count at the baseline date (i.e. what was lost).`,
    },
    netDoors: {
      title: "Net doors (trailing 12 mo)",
      cols: ["Type", "Count"],
      rows: [["Doors added", String(doorsAdded)], ["Doors lost", String(doorsLost)], ["Net", String(netDoors >= 0 ? "+" + netDoors : netDoors)]],
      summary: `Net ${netDoors >= 0 ? "+" + netDoors : netDoors}`,
      note: `Diffs today's property roster (${latestSnapDate || "—"}) against the oldest snapshot in the trailing 12 months (${baselineSnapDate || "—"}, ${doorsCoverageDays} day(s) of coverage). Captured automatically via a daily snapshot — no manual data entry required.`,
    },
    ownersGained: {
      title: "Properties gained (trailing 12 mo)",
      cols: ["Property", "Doors"],
      rows: propsGained.map(p => [p.name || `#${p.property_id}`, String(p.unit_count || 0)]),
      summary: `${propsGained.length} properties`,
    },
    ownersTotal: { title: "All owners", cols: ["Owner", "Active", "Start", "End"], rows: query("SELECT name, is_active, agreement_start, agreement_end FROM owners LIMIT 500").map(o => [o.name, o.is_active ? "yes" : "no", o.agreement_start || "—", o.agreement_end || "—"]), summary: `${ownersTotal} owners` },
    renewalRate: { title: "Renewals", cols: ["Property", "Unit", "Status", "From", "To", "Rent"], rows: query(`SELECT r.status, r.from_date, r.to_date, r.rent, l.property_id, u.unit_number FROM renewal_history r LEFT JOIN leases l ON l.id = r.lease_id LEFT JOIN units u ON u.id = l.unit_id WHERE r.created_at >= ? ORDER BY r.created_at DESC LIMIT 200`, [yearAgoIso]).map(r => [propName(r.property_id), r.unit_number || "—", r.status, r.from_date || "—", r.to_date || "—", r.rent != null ? `$${Math.round(r.rent)}` : "—"]), summary: `${renewalsInWindow} renewals · ${renewalRate}%` },
    renewalsCount: { title: "Renewals", cols: ["Property", "Unit", "From", "To"], rows: query(`SELECT r.from_date, r.to_date, l.property_id, u.unit_number FROM renewal_history r LEFT JOIN leases l ON l.id = r.lease_id LEFT JOIN units u ON u.id = l.unit_id WHERE r.created_at >= ? ORDER BY r.created_at DESC LIMIT 200`, [yearAgoIso]).map(r => [propName(r.property_id), r.unit_number || "—", r.from_date || "—", r.to_date || "—"]), summary: `${renewalsInWindow}` },
    fixedLeases: { title: "Fixed leases", cols: ["Property", "Unit", "From", "To"], rows: activeLeaseRows.filter(l => l.type === "Fixed" || l.type === "FixedWithRollover").map(l => [propName(l.property_id), l.unit_number || "—", l.from_date || "—", l.to_date || "—"]), summary: `${fixedLeases}` },
    mtmLeases: { title: "MTM leases", cols: ["Property", "Unit"], rows: activeLeaseRows.filter(l => l.type === "AtWill").map(l => [propName(l.property_id), l.unit_number || "—"]), summary: `${mtmLeases}` },
    evictionsPending: { title: "Evictions", cols: ["Property", "Unit"], rows: query("SELECT u.property_id, u.unit_number FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id WHERE l.status = 'Active' AND l.is_eviction_pending = 1 AND p.is_active = 1 LIMIT 200").map(l => [propName(l.property_id), l.unit_number || "—"]), summary: `${evictionsPendingCount}` },
    avgRentPerDoor: { title: "Leases by rent", cols: ["Property", "Unit", "Rent"], rows: activeLeaseRows.map(l => [propName(l.property_id), l.unit_number || "—", l.rent ? `$${Math.round(l.rent).toLocaleString()}` : "—"]), summary: `Avg $${avgRentPerLease}` },
    rpu: { title: `RPU — ${lcm ? lcm.label : 'last month'}`, cols: ["Month", "RPU"], rows: incomeByMonth.map(m => [m.month, `$${(totalUnits ? Math.round((m.gross) / totalUnits) : 0).toLocaleString()}`]), summary: `$${rpuValue.toLocaleString()}/unit` },
    grossIncome: { title: "Gross income — YTD", cols: ["Month", "Gross"], rows: incomeByMonth.map(m => [m.month, `$${m.gross.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`]), summary: `$${grossIncomeTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
    netIncome: { title: "Net income — YTD", cols: ["Month", "Gross", "Expense", "Net"], rows: incomeByMonth.map(m => [m.month, `$${m.gross.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, `$${(m._expense || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, `$${m.net.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`]), summary: `$${netIncomeTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
    rentCollectedBy3rd: { title: "Rent by 3rd", cols: ["Note"], rows: [["Snapshots accumulate over time."]], summary: `${by3rd.value}% (${by3rd.monthsCounted} months)` },
    rentCollectedBy10th: { title: "Rent by 10th", cols: ["Note"], rows: [["Snapshots accumulate over time."]], summary: `${by10th.value}% (${by10th.monthsCounted} months)` },
    newProspects: { title: "Prospects", cols: ["Name", "Source", "Created"], rows: reProspects.slice(-200).reverse().map(p => [p.name || "—", p.source || "—", (p.created_at || "").slice(0, 10)]), summary: `${newProspects} prospects` },
    appsSubmitted: { title: "Applications submitted (last 12 mo)", cols: ["Applicant", "Status", "App #", "Submitted"], rows: submittedApps.slice().sort((x, y) => (y.app.ApplicationSubmittedDateTime || "").localeCompare(x.app.ApplicationSubmittedDateTime || "")).slice(0, 500).map(({ applicant, app }) => [`${applicant.FirstName || ""} ${applicant.LastName || ""}`.trim() || "—", app.ApplicationStatus || applicant.Status || "—", app.ApplicationNumber || String(app.Id || ""), (app.ApplicationSubmittedDateTime || "").slice(0, 10)]), summary: `${appsSubmitted} applications submitted` },
    moveins: { title: "Move-ins (last 12 mo)", cols: ["Property", "Unit", "Start"], rows: query(`SELECT l.from_date, l.property_id, u.unit_number FROM leases l JOIN units u ON l.unit_id = u.id JOIN properties p ON u.property_id = p.id WHERE p.is_active = 1 AND l.status != 'Future' AND l.from_date >= ? AND l.from_date <= ? ORDER BY l.from_date DESC LIMIT 200`, [yearAgoIso, todayIso]).map(r => [propName(r.property_id), r.unit_number || "—", r.from_date || "—"]), summary: `${moveins} move-ins` },
    appsPerMovein: { title: "Funnel", cols: ["Stage", "Count"], rows: [["Apps", String(appsSubmitted)], ["Move-ins", String(moveins)], ["Ratio", moveins ? (appsSubmitted / moveins).toFixed(1) : "—"]], summary: moveins ? `${(appsSubmitted / moveins).toFixed(1)} apps per move-in` : "—" },
    completionRate: { title: "Showing completion rate", cols: ["Address", "Status", "Scheduled", "Completed", "Rate"], rows: reUnits.map(u => { const p = perfByUnit.get(u.id); if (!p || !p.showings_scheduled) return null; const r = Math.round((p.showings_completed / p.showings_scheduled) * 1000) / 10; return [reAddr(u), u.status || "—", String(p.showings_scheduled), String(p.showings_completed), `${r}%`]; }).filter(Boolean), summary: `${showingsCompleted}/${showingsScheduled} = ${completionRate}%`, note: "Sum of showings_completed ÷ sum of showings_scheduled across all RentEngine units in the trailing 12 months." },
    showingsCompleted: { title: "Showings completed (last 12 mo)", cols: ["Unit", "Status", "Scheduled", "Completed"], rows: reUnits.map(u => { const p = perfByUnit.get(u.id); if (!p || (!p.showings_scheduled && !p.showings_completed)) return null; return [String(u.id), u.status || "—", String(p.showings_scheduled || 0), String(p.showings_completed || 0)]; }).filter(Boolean), summary: `${showingsCompleted} completed · ${showingsScheduled} scheduled`, note: "From RentEngine /reporting/leasing-performance/units, summed across all units in the trailing 12 months." },
    totalCalls: { title: "Calls (last 12 mo)", cols: ["Unit", "Status", "Calls"], rows: reUnits.map(u => { const p = perfByUnit.get(u.id); if (!p || !p.total_calls) return null; return [String(u.id), u.status || "—", String(p.total_calls)]; }).filter(Boolean).sort((a, b) => Number(b[2]) - Number(a[2])), summary: `${totalCalls} calls`, note: "From RentEngine /reporting/leasing-performance/units total_calls field, summed across all units in the trailing 12 months." },
    totalTexts: { title: "Outbound texts (last 12 mo)", cols: ["Unit", "Status", "Texts"], rows: reUnits.map(u => { const p = perfByUnit.get(u.id); if (!p || !p.outbound_texts) return null; return [String(u.id), u.status || "—", String(p.outbound_texts)]; }).filter(Boolean).sort((a, b) => Number(b[2]) - Number(a[2])), summary: `${totalTexts} texts`, note: "From RentEngine /reporting/leasing-performance/units outbound_texts field, summed across all units in the trailing 12 months." },
    unitsOnMarket: { title: "On market", cols: ["Address", "Status", "Health", "Days"], rows: reAvailable.slice(0, 200).map(u => { const p = perfByUnit.get(u.id); const d = p?.days_on_market != null ? p.days_on_market : (u.created_at ? Math.floor((now - new Date(u.created_at)) / 86400000) : 0); return [reAddr(u), u.status || "—", p?.property_health || "—", String(d)]; }), summary: `${unitsOnMarket} listed`, note: "All RentEngine units whose status is not 'Leased' (Available + On Hold). The 'is_occupied' flag is intentionally ignored because it lags reality. Days and Health come from RentEngine's per-unit leasing-performance report." },
    avgDaysOnMarket: { title: "Days on market", cols: ["Address", "Status", "Health", "Days"], rows: reAvailable.slice(0, 200).map(u => { const p = perfByUnit.get(u.id); const d = p?.days_on_market != null ? p.days_on_market : (u.created_at ? Math.floor((now - new Date(u.created_at)) / 86400000) : 0); return [reAddr(u), u.status || "—", p?.property_health || "—", String(d)]; }), summary: `Avg ${avgDaysOnMarket} · Median ${medianDaysOnMarket}`, note: "True days_on_market from RentEngine's per-unit leasing-performance report (resets when a unit is re-listed)." },
    medianDaysOnMarket: { title: "Median DOM", cols: ["ID", "Days"], rows: [], summary: `Median ${medianDaysOnMarket} days` },
    avgTenancyMonths: {
      title: "Avg length of tenancy (last 12 mo move-outs)",
      cols: ["Tenant ID", "Property", "Unit", "Moved in", "Moved out", "Months", "Years"],
      rows: tenancyDays
        .slice()
        .sort((a, b) => b.days - a.days)
        .map(r => [
          String(r.tenantId),
          propName(r.propertyId),
          r.unitNumber || "—",
          r.from,
          r.to,
          (r.days / 30.4375).toFixed(1),
          (r.days / 365.25).toFixed(1),
        ]),
      summary: `Avg ${avgTenancyMonths} mo (${(avgTenancyMonths / 12).toFixed(1)} yrs) · ${tenancyDays.length} tenants moved out`,
      note: "Per-tenant tenancy = (move-out date) − (earliest move-in date on that unit across all of the tenant's leases). This chains renewals, since Buildium creates a new lease record with a new LeaseFromDate every time a tenant renews. Window: tenants whose MoveOutDate falls in the trailing 12 months.",
    },
    avgSdWithheld: {
      title: "Avg SD withheld (last 12 mo move-outs)",
      cols: ["Property", "Unit", "Move-out", "SD", "Withheld", "%"],
      rows: sdRecords
        .slice()
        .sort((a, b) => b.pct - a.pct)
        .map(r => [
          propName(r.propertyId),
          r.unitNumber || "—",
          r.moveOutDate || "—",
          `$${r.sd.toLocaleString()}`,
          `$${r.withheld.toLocaleString()}`,
          `${r.pct}%`,
        ]),
      summary: `Avg $${avgSdWithheld.toLocaleString()} (${avgSdWithheldPct}%) · ${sdRecords.length} reconciled move-outs`,
      note: "Sum of |TotalAmount| of Buildium 'Applied Deposit' transactions per lease (only the SD reconciliation entries — memo 'Deposit applied to balances' — not monthly prepayment applications), capped at the original SD. Window is move-outs between 13 months ago and 30 days ago (Limehouse posts the reconciliation ~30 days after move-out). Leases with no Applied Deposit posting are excluded.",
    },
    avgSdWithheldPct: {
      title: "Avg SD withheld % (last 12 mo move-outs)",
      cols: ["Property", "Unit", "Move-out", "SD", "Withheld", "%"],
      rows: sdRecords
        .slice()
        .sort((a, b) => b.pct - a.pct)
        .map(r => [
          propName(r.propertyId),
          r.unitNumber || "—",
          r.moveOutDate || "—",
          `$${r.sd.toLocaleString()}`,
          `$${r.withheld.toLocaleString()}`,
          `${r.pct}%`,
        ]),
      summary: `Avg ${avgSdWithheldPct}% withheld · ${sdRecords.length} reconciled move-outs`,
      note: "Per-lease withheld ÷ original SD, averaged. Source: Buildium 'Applied Deposit' transactions on each past lease.",
    },

    // ── Performance by Role KPI drilldowns ──────────────────────────────
    kpiOccupancyRate: {
      title: "Portfolio Occupancy Rate",
      cols: ["Property", "Unit", "Occupied"],
      rows: query(`SELECT u.unit_number, p.name as pname, u.is_occupied FROM units u JOIN properties p ON u.property_id = p.id WHERE p.is_active = 1 ORDER BY p.name, u.unit_number`).map(r => [r.pname, r.unit_number || "—", r.is_occupied ? "yes" : "no"]),
      summary: `${occupiedUnits} / ${totalUnits} = ${occupancyRate}% · target ≥95%`,
      note: `Formula: occupied units ÷ total active units. ${occupiedUnits} of ${totalUnits} active units are flagged IsUnitOccupied in Buildium.`,
    },
    kpiDelinquencyRate: {
      title: "Delinquency Rate",
      cols: ["Property", "Unit", "Balance"],
      rows: latestObSnapDate ? query(`SELECT o.total_balance, l.property_id, u.unit_number FROM outstanding_snapshots o LEFT JOIN leases l ON l.id = o.lease_id LEFT JOIN units u ON u.id = l.unit_id WHERE o.snapshot_date = ? ORDER BY o.total_balance DESC`, [latestObSnapDate]).map(r => [propName(r.property_id), r.unit_number || "—", `$${(r.total_balance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`]) : [],
      summary: `$${(delinquentTotal || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} delinquent ÷ $${(totalRentPotential || 0).toLocaleString()} rent roll = ${delinquencyRate}% · target ≤3%`,
      note: `Formula: sum of TotalBalance across active leases with a positive balance ÷ sum of monthly rent across all active leases. Source: Buildium /leases/outstandingbalances and the rent field on active leases.`,
    },
    kpiShowingCompletion: {
      title: "Showing Completion Rate",
      cols: ["Address", "Status", "Scheduled", "Completed", "Rate"],
      rows: reUnits.map(u => { const p = perfByUnit.get(u.id); if (!p || !p.showings_scheduled) return null; const r = Math.round((p.showings_completed / p.showings_scheduled) * 1000) / 10; return [reAddr(u), u.status || "—", String(p.showings_scheduled), String(p.showings_completed), `${r}%`]; }).filter(Boolean),
      summary: `${showingsCompleted} completed ÷ ${showingsScheduled} scheduled = ${completionRate}% · target ≥95%`,
      note: `Formula: Σ showings_completed ÷ Σ showings_scheduled across all RentEngine units in the trailing 12 months. Source: RentEngine /reporting/leasing-performance/units/{unitId}.`,
    },
    kpiReconciliation: {
      title: "Reconciliation Accuracy",
      cols: ["Bank Account", "Last Reconciled", "Months Done (last 12)", "Status"],
      rows: reconRowsRaw.map(r => [
        r.name,
        r.lastFinished || "never",
        `${r.monthsDone} / 12`,
        r.monthsDone === 12 ? "on track" : (r.monthsDone === 0 ? "never reconciled" : "lagging"),
      ]),
      summary: reconAccuracyPct != null
        ? `${reconTotalDone} / ${reconTotalExpected} expected reconciliations completed = ${reconAccuracyPct}% · target 100%`
        : "No active bank accounts found",
      note: `Formula: across all ${activeBankAccounts.length} active bank accounts, count how many of the last 12 completed months have a finished reconciliation (StatementEndingDate falls in that month and IsFinished=true). Accuracy = done ÷ expected (${activeBankAccounts.length} accounts × 12 months = ${activeBankAccounts.length * 12} expected). Source: Buildium /v1/bankaccounts and /v1/bankaccounts/{id}/reconciliations.`,
    },
    kpiRentProcessing: {
      title: "Rent Processing Accuracy",
      cols: ["Property", "Unit", "Reversed Date", "Amount"],
      rows: rentReversalRowsRaw.length
        ? rentReversalRowsRaw.map(r => [
            propName(r.propertyId),
            r.unitNumber || "—",
            r.date,
            `$${r.amount.toFixed(2)}`,
          ])
        : [["—", "—", "—", "No reversed payments in the last 90 days"]],
      summary: rentProcessingPct != null
        ? `${rpReversals} reversed ÷ ${rpPayments} payments in last 90 days = ${rentProcessingPct}% clean · target 100%`
        : "No payments recorded in last 90 days",
      note: `Formula: 1 − (ReversePayment count ÷ Payment count) across every active lease, looking at the trailing 90 days. Each reversal is a tenant payment that bounced, was charged back, or had to be undone for any reason. Source: Buildium /v1/leases/{leaseId}/transactions filtered by TransactionTypeEnum = Payment / ReversePayment. ${activeLeasesForRP.length} active leases checked.`,
    },
    kpiVendorCompliance: (() => {
      const todayMsLocal = todayMs;
      const rows = (bdVendors || []).map(v => {
        const tax = v.TaxInformation || v.VendorTaxInformation || v.VendorMessage?.TaxInformation;
        const ins = v.VendorInsurance || v.VendorMessage?.VendorInsurance;
        const hasTax = !!(tax?.TaxPayerId && String(tax.TaxPayerId).trim());
        const expDate = ins?.ExpirationDate || "";
        const expMs = expDate ? new Date(expDate).getTime() : 0;
        const insOk = expMs > todayMsLocal;
        const compliant = hasTax && insOk;
        const reasons = [];
        if (!hasTax) reasons.push("missing TaxPayerId");
        if (!expDate) reasons.push("no insurance on file");
        else if (!insOk) reasons.push(`insurance expired ${expDate.slice(0, 10)}`);
        const name = v.CompanyName || `${v.FirstName || ""} ${v.LastName || ""}`.trim() || `#${v.Id}`;
        return {
          name,
          hasTax, expDate: expDate ? expDate.slice(0, 10) : "—", insOk, compliant,
          status: compliant ? "compliant" : reasons.join(" + "),
        };
      });
      rows.sort((a, b) => Number(a.compliant) - Number(b.compliant) || a.name.localeCompare(b.name));
      const okCount = rows.filter(r => r.compliant).length;
      return {
        title: "Vendor Compliance",
        cols: ["Vendor", "TaxPayerId", "Insurance Expires", "Status"],
        rows: rows.map(r => [r.name, r.hasTax ? "yes" : "no", r.expDate, r.status]),
        summary: `${okCount} compliant ÷ ${rows.length} active vendors = ${vendorCompliancePct ?? "—"}% · target 100%`,
        note: `Formula: active vendors where TaxPayerId is populated AND VendorInsurance.ExpirationDate > today, ÷ total active vendors. Source: Buildium /v1/vendors?statuses=Active, reading TaxInformation.TaxPayerId and VendorInsurance.ExpirationDate on each record.`,
      };
    })(),
    kpi1099Compliance: (() => {
      const rows = (bdVendors || []).filter(v => {
        const tax = v.TaxInformation || v.VendorTaxInformation || v.VendorMessage?.TaxInformation;
        return tax && tax.IncludeIn1099 === true;
      }).map(v => {
        const tax = v.TaxInformation || v.VendorTaxInformation || v.VendorMessage?.TaxInformation;
        const hasTax = !!(tax?.TaxPayerId && String(tax.TaxPayerId).trim());
        const name = v.CompanyName || `${v.FirstName || ""} ${v.LastName || ""}`.trim() || `#${v.Id}`;
        const taxType = tax?.TaxPayerIdType || "—";
        return { name, hasTax, taxType, status: hasTax ? "compliant" : "missing TaxPayerId" };
      });
      rows.sort((a, b) => Number(a.hasTax) - Number(b.hasTax) || a.name.localeCompare(b.name));
      const okCount = rows.filter(r => r.hasTax).length;
      return {
        title: "1099 Compliance",
        cols: ["Vendor", "Tax ID Type", "TaxPayerId", "Status"],
        rows: rows.map(r => [r.name, r.taxType, r.hasTax ? "yes" : "no", r.status]),
        summary: `${okCount} with TaxPayerId ÷ ${rows.length} flagged IncludeIn1099 = ${vendor1099Pct ?? "—"}% · target 100% by Jan`,
        note: `Formula: vendors where IncludeIn1099 is true AND TaxPayerId is populated, ÷ vendors where IncludeIn1099 is true. Source: Buildium /v1/vendors?statuses=Active, reading TaxInformation.IncludeIn1099 and TaxInformation.TaxPayerId.`,
      };
    })(),
  };

  let lsKpis = null, lsDrilldowns = {}, lsSummary = null;
  try {
    const ls = buildLeadSimpleKpis();
    lsKpis = ls.lsKpis;
    lsDrilldowns = ls.lsDrilldowns;
    lsSummary = ls.lsSummary;
  } catch (err) {
    console.warn("[agg] LeadSimple KPIs failed:", err.message);
  }

  return {
    dashboard: { ...dashboard, lsKpis, lsSummary },
    drilldowns: { ...drilldowns, ...lsDrilldowns },
  };
}
