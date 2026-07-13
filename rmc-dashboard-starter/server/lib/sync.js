// ── AppFolio → SQLite sync ───────────────────────────────────────────────────
import { appfolio } from "./appfolio.js";
import { getDb, clearTable, upsertMany, run, query } from "./db.js";

const TS = () => new Date().toISOString();
const safe = (p, fb) => p.catch(e => { console.warn("[sync] non-fatal:", e.message); return fb; });

export async function syncAll() {
  const start = Date.now();
  const errors = [];
  let totalRecords = 0;
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const yearAgoIso = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).toISOString().slice(0, 10);
  const currentMonth = todayIso.slice(0, 7);
  const yearAgoMonth = yearAgoIso.slice(0, 7);
  const synced_at = TS();

  console.log("[sync] Starting AppFolio sync...");

  // ── 1. Rent Roll (occupancy, rent, lease dates, tenant info) ────────────
  try {
    const rows = await appfolio.rentRoll(todayIso);
    clearTable("units");
    const mapped = rows.map((r, i) => ({
      id: r.unit_id ? String(r.unit_id) : `rr-${i}`,
      property_name: r.property_name || r.property || "",
      property_id: r.property_id ? String(r.property_id) : "",
      unit_name: r.unit || r.unit_name || "",
      address: r.property_address || r.property_street || "",
      city: r.property_city || "", state: r.property_state || "", zip: r.property_zip || "",
      bedrooms: r.bedrooms ? Number(r.bedrooms) : null,
      bathrooms: r.bathrooms ? Number(r.bathrooms) : null,
      sqft: r.sqft || r.square_feet ? Number(r.sqft || r.square_feet) : null,
      market_rent: r.market_rent ? parseFloat(r.market_rent) : null,
      current_rent: r.rent || r.current_rent ? parseFloat(r.rent || r.current_rent) : null,
      rent_status: r.rent_status || r.status || "",
      occupancy_status: r.status || r.occupancy_status || "",
      tenant_name: r.tenant || r.tenant_name || "",
      tenant_id: r.tenant_id ? String(r.tenant_id) : "",
      lease_from: r.lease_from || r.lease_start || "",
      lease_to: r.lease_to || r.lease_end || "",
      move_in_date: r.move_in || r.move_in_date || "",
      move_out_date: r.move_out || r.move_out_date || "",
      past_due: r.past_due ? parseFloat(r.past_due) : 0,
      tags: r.tags || "",
      synced_at,
    }));
    const cols = Object.keys(mapped[0] || {});
    if (mapped.length) upsertMany("units", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Rent roll: ${mapped.length} units`);
  } catch (e) { errors.push(`rent_roll: ${e.message}`); console.error("[sync]", e.message); }

  // ── 2. Delinquency ──────────────────────────────────────────────────────
  try {
    const rows = await appfolio.delinquency();
    clearTable("delinquency");
    const mapped = rows.map((r, i) => ({
      property_name: r.property_name || r.property || "",
      property_id: r.property_id ? String(r.property_id) : "",
      unit: r.unit || "", unit_id: r.unit_id ? String(r.unit_id) : "",
      tenant_name: r.name || r.tenant || "",
      tenant_id: r.tenant_id ? String(r.tenant_id) : "",
      tenant_status: r.tenant_status || r.status || "",
      amount_receivable: r.amount_receivable ? parseFloat(r.amount_receivable) : 0,
      current_amount: r.current ? parseFloat(r.current) : 0,
      thirty_plus: r["30_plus"] ? parseFloat(r["30_plus"]) : 0,
      sixty_plus: r["60_plus"] ? parseFloat(r["60_plus"]) : 0,
      ninety_plus: r["90_plus"] ? parseFloat(r["90_plus"]) : 0,
      in_collections: r.in_collections ? parseFloat(r.in_collections) : 0,
      synced_at,
    }));
    const cols = ["property_name","property_id","unit","unit_id","tenant_name","tenant_id",
      "tenant_status","amount_receivable","current_amount","thirty_plus","sixty_plus",
      "ninety_plus","in_collections","synced_at"];
    if (mapped.length) upsertMany("delinquency", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Delinquency: ${mapped.length} rows`);
  } catch (e) { errors.push(`delinquency: ${e.message}`); console.error("[sync]", e.message); }

  // ── 3. Renewals (full history, deduplicated) ─────────────────────────────
  // renewal_summary needs statuses:["all"] to include non-renewed outcomes, but
  // AppFolio then emits the SAME renewal event twice — once "Canceled by User"
  // (a superseded draft) and once "Renewed". Dedupe each event by
  // occupancy + lease period, keeping the "Renewed" row when present so the
  // renewal-rate denominator counts each opportunity exactly once.
  try {
    const futureIso = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
      .toISOString().slice(0, 10);
    const rows = await appfolio.renewalSummary("2010-01-01", futureIso, { statuses: ["all"] });
    clearTable("renewals");
    const byEvent = new Map();
    for (const r of rows) {
      const key = `${r.occupancy_id ?? r.lease_uuid ?? ""}|${r.lease_start || ""}|${r.lease_end || ""}`;
      const existing = byEvent.get(key);
      if (!existing || (r.status === "Renewed" && existing.status !== "Renewed")) {
        byEvent.set(key, r);
      }
    }
    const mapped = [...byEvent.values()].map(r => ({
      property_name: r.property_name || r.property || "",
      property_id: r.property_id ? String(r.property_id) : "",
      unit: r.unit_name || r.unit || "", unit_id: r.unit_id ? String(r.unit_id) : "",
      tenant_name: r.tenant_name || r.tenant || "",
      lease_start: r.lease_start || "",
      lease_end: r.lease_end || "",
      renewal_status: r.status || r.renewal_status || "",
      new_lease_start: r.lease_start || "",
      new_lease_end: r.lease_end || "",
      previous_rent: r.previous_rent ? parseFloat(r.previous_rent) : null,
      new_rent: r.rent ? parseFloat(r.rent) : (r.new_rent ? parseFloat(r.new_rent) : null),
      synced_at,
    }));
    const cols = ["property_name","property_id","unit","unit_id","tenant_name",
      "lease_start","lease_end","renewal_status","new_lease_start","new_lease_end",
      "previous_rent","new_rent","synced_at"];
    if (mapped.length) upsertMany("renewals", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Renewals: ${mapped.length} rows (${rows.length} raw, deduped)`);
  } catch (e) { errors.push(`renewals: ${e.message}`); console.error("[sync]", e.message); }

  // ── 4. Showings (trailing 12 months) ────────────────────────────────────
  try {
    const rows = await appfolio.showings(yearAgoIso, todayIso, { statuses: ["all"] });
    clearTable("showings");
    const mapped = rows.map(r => ({
      property_name: r.property_name || r.property || "",
      property_id: r.property_id ? String(r.property_id) : "",
      unit: r.unit || "", unit_id: r.unit_id ? String(r.unit_id) : "",
      showing_date: r.showing_date || r.date || "",
      showing_time: r.showing_time || r.time || "",
      status: r.status || "",
      assigned_user: r.assigned_user || r.agent || "",
      prospect_name: r.prospect_name || r.guest_card_name || "",
      synced_at,
    }));
    const cols = ["property_name","property_id","unit","unit_id","showing_date",
      "showing_time","status","assigned_user","prospect_name","synced_at"];
    if (mapped.length) upsertMany("showings", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Showings: ${mapped.length} rows`);
  } catch (e) { errors.push(`showings: ${e.message}`); console.error("[sync]", e.message); }

  // ── 5. Applications (trailing 12 months) ────────────────────────────────
  try {
    const rows = await appfolio.rentalApplications(yearAgoIso, todayIso, { rental_application_statuses: ["all"] });
    clearTable("applications");
    const mapped = rows.map(r => ({
      property_name: r.property_name || r.property || "",
      property_id: r.property_id ? String(r.property_id) : "",
      unit: r.unit || "", unit_id: r.unit_id ? String(r.unit_id) : "",
      applicant_name: r.applicant_name || r.applicants || r.name || "",
      received_date: (r.received || r.received_date || r.received_on || "").slice(0, 10),
      status: r.status || r.application_status || "",
      decision_date: r.decision_date || r.decision_made_at || "",
      synced_at,
    }));
    const cols = ["property_name","property_id","unit","unit_id","applicant_name",
      "received_date","status","decision_date","synced_at"];
    if (mapped.length) upsertMany("applications", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Applications: ${mapped.length} rows`);
  } catch (e) { errors.push(`applications: ${e.message}`); console.error("[sync]", e.message); }

  // ── 6. Vacancies ────────────────────────────────────────────────────────
  try {
    const rows = await appfolio.unitVacancyDetail({ level_of_detail: "detail_view" });
    clearTable("vacancies");
    const mapped = rows.map(r => ({
      property_name: r.property_name || r.property || "",
      property_id: r.property_id ? String(r.property_id) : "",
      unit: r.unit || r.unit_name || "",
      unit_id: r.unit_id ? String(r.unit_id) : "",
      available_date: r.available_date || r.available_on || "",
      days_vacant: r.days_vacant ? Number(r.days_vacant) : 0,
      market_rent: (r.market_rent || r.computed_market_rent || r.schd_rent)
        ? parseFloat(r.market_rent || r.computed_market_rent || r.schd_rent)
        : null,
      advertised_rent: r.advertised_rent ? parseFloat(r.advertised_rent) : null,
      status: r.status || r.vacancy_status || r.unit_status || "",
      synced_at,
    }));
    const cols = ["property_name","property_id","unit","unit_id","available_date",
      "days_vacant","market_rent","advertised_rent","status","synced_at"];
    if (mapped.length) upsertMany("vacancies", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Vacancies: ${mapped.length} rows`);
  } catch (e) { errors.push(`vacancies: ${e.message}`); console.error("[sync]", e.message); }

  // ── 7. Work Orders (all open + last 12 months completed) ────────────────
  try {
    const rows = await appfolio.workOrders({
      status_date: "all",
      status_date_range_from: yearAgoIso,
      status_date_range_to: todayIso,
      work_order_statuses: ["0","1","2","9","3","6","8","12","4","7"],
    });
    clearTable("work_orders");
    const mapped = rows.map(r => ({
      id: r.work_order_id ? String(r.work_order_id) : r.work_order_number || `wo-${Math.random()}`,
      property_name: r.property_name || r.property || "",
      property_id: r.property_id ? String(r.property_id) : "",
      unit: r.unit || "", unit_id: r.unit_id ? String(r.unit_id) : "",
      description: r.description || r.summary || "",
      status: r.status || r.work_order_status || "",
      priority: r.priority || "",
      work_order_type: r.work_order_type || r.type || "",
      assigned_user: r.assigned_user || r.assigned_to || "",
      vendor_name: r.vendor_name || r.vendor || "",
      created_date: (r.created_at || r.created_on || r.created_date || "").slice(0, 10),
      scheduled_date: r.scheduled_start || r.scheduled_date || "",
      completed_date: r.completed_on || r.completed_date || "",
      total_cost: r.total_cost ? parseFloat(r.total_cost) : 0,
      synced_at,
    }));
    const cols = ["id","property_name","property_id","unit","unit_id","description",
      "status","priority","work_order_type","assigned_user","vendor_name",
      "created_date","scheduled_date","completed_date","total_cost","synced_at"];
    if (mapped.length) upsertMany("work_orders", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Work orders: ${mapped.length}`);
  } catch (e) { errors.push(`work_orders: ${e.message}`); console.error("[sync]", e.message); }

  // ── 8. Owners ───────────────────────────────────────────────────────────
  try {
    const rows = await appfolio.ownerDirectory();
    clearTable("owners");
    const mapped = rows.map(r => ({
      id: r.owner_id ? String(r.owner_id) : r.name || `own-${Math.random()}`,
      owner_name: r.name || r.owner_name || "",
      email: r.email || "", phone: r.phone || "",
      property_count: r.property_count ? Number(r.property_count) : 0,
      status: r.status || "active",
      synced_at,
    }));
    const cols = ["id","owner_name","email","phone","property_count","status","synced_at"];
    if (mapped.length) upsertMany("owners", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Owners: ${mapped.length}`);
  } catch (e) { errors.push(`owners: ${e.message}`); console.error("[sync]", e.message); }

  // ── 9. Properties ──────────────────────────────────────────────────────
  try {
    const rows = await appfolio.propertyDirectory();
    clearTable("properties");
    const mapped = rows.map(r => ({
      id: r.property_id ? String(r.property_id) : r.property_name || `prop-${Math.random()}`,
      property_name: r.property_name || r.name || "",
      address: r.address || r.street || "",
      city: r.city || "", state: r.state || "", zip: r.zip || "",
      unit_count: r.unit_count ? Number(r.unit_count) : (r.units ? Number(r.units) : 0),
      property_type: r.property_type || r.type || "",
      insurance_expiration: r.insurance_expiration || "",
      owners: r.owners || "",
      synced_at,
    }));
    const cols = ["id","property_name","address","city","state","zip","unit_count","property_type","insurance_expiration","owners","synced_at"];
    if (mapped.length) upsertMany("properties", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Properties: ${mapped.length}`);
  } catch (e) { errors.push(`properties: ${e.message}`); console.error("[sync]", e.message); }

  // ── 10. Guest Cards (trailing 12 months) ────────────────────────────────
  try {
    const rows = await appfolio.guestCardInquiries(yearAgoIso, todayIso, { guest_card_statuses: ["all"] });
    clearTable("guest_cards");
    const mapped = rows.map(r => ({
      property_name: r.property_name || r.property || "",
      property_id: r.property_id ? String(r.property_id) : "",
      unit: r.unit || "", unit_id: r.unit_id ? String(r.unit_id) : "",
      prospect_name: r.name || r.prospect_name || "",
      source: r.source || r.guest_card_source || "",
      status: r.status || "",
      received_date: (r.received || r.received_date || r.received_on || "").slice(0, 10),
      assigned_user: r.assigned_user || "",
      synced_at,
    }));
    const cols = ["property_name","property_id","unit","unit_id","prospect_name",
      "source","status","received_date","assigned_user","synced_at"];
    if (mapped.length) upsertMany("guest_cards", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Guest cards: ${mapped.length}`);
  } catch (e) { errors.push(`guest_cards: ${e.message}`); console.error("[sync]", e.message); }

  // ── 11. Vendors ─────────────────────────────────────────────────────────
  try {
    const rows = await appfolio.vendorDirectory();
    clearTable("vendors");
    const mapped = rows.map(r => ({
      id: r.vendor_id ? String(r.vendor_id) : r.name || `v-${Math.random()}`,
      vendor_name: r.company_name || r.name || r.vendor_name || "",
      vendor_type: r.vendor_type || r.type || "",
      workers_comp_expires: r.workers_comp_expires || r.workers_comp_expiration || "",
      liability_expires: r.liability_ins_expires || r.liability_insurance_expiration || "",
      auto_ins_expires: r.auto_ins_expires || "",
      epa_cert_expires: r.epa_cert_expires || "",
      state_lic_expires: r.state_lic_expires || "",
      status: r.do_not_use_for_work_order === "Yes" ? "do_not_use" : (r.status || "active"),
      synced_at,
    }));
    const cols = ["id","vendor_name","vendor_type","workers_comp_expires","liability_expires",
      "auto_ins_expires","epa_cert_expires","state_lic_expires","status","synced_at"];
    if (mapped.length) upsertMany("vendors", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Vendors: ${mapped.length}`);
  } catch (e) { errors.push(`vendors: ${e.message}`); console.error("[sync]", e.message); }

  // ── 12. Maintenance labor entries (trailing 12 months) ──────────────────
  try {
    const rows = await appfolio.workOrderLaborSummary(yearAgoIso, todayIso);
    clearTable("labor_entries");
    const mapped = rows.map((r, i) => ({
      id: r.labor_detail_id ? String(r.labor_detail_id) : `le-${i}`,
      work_date: (r.date || "").slice(0, 10),
      tech: r.maintenance_tech || "",
      property_name: r.property_name || "",
      unit: r.unit_name || r.unit || "",
      worked_hours: r.worked_hours != null && r.worked_hours !== "" ? parseFloat(r.worked_hours)
        : (r.hours != null && r.hours !== "" ? parseFloat(r.hours) : 0),
      work_order_number: r.work_order_number ? String(r.work_order_number) : "",
      work_order_status: r.work_order_status || "",
      description: r.description || "",
      work_order_id: r.work_order_id ? String(r.work_order_id) : "",
      synced_at,
    }));
    const cols = ["id","work_date","tech","property_name","unit","worked_hours",
      "work_order_number","work_order_status","description","work_order_id","synced_at"];
    if (mapped.length) upsertMany("labor_entries", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Labor entries: ${mapped.length}`);
  } catch (e) { errors.push(`labor_entries: ${e.message}`); console.error("[sync]", e.message); }

  // ── 13. Tenant insurance (from tenant_directory) ────────────────────────
  try {
    const rows = await appfolio.tenantDirectory();
    clearTable("tenant_insurance");
    const mapped = rows.map(r => ({
      tenant_name: r.tenant || [r.first_name, r.last_name].filter(Boolean).join(" ") || r.company_name || "",
      property_name: r.property_name || r.property || "",
      unit: r.unit || "",
      tenant_type: r.tenant_type || "",
      commercial_lease_type: r.commercial_lease_type || "",
      status: r.status || "",
      insurance_company: r.insurance_company_name || "",
      policy_number: r.insurance_policy_number || "",
      insurance_expiration: r.insurance_expiration || "",
      synced_at,
    }));
    const cols = ["tenant_name","property_name","unit","tenant_type","commercial_lease_type",
      "status","insurance_company","policy_number","insurance_expiration","synced_at"];
    if (mapped.length) upsertMany("tenant_insurance", mapped, cols);
    totalRecords += mapped.length;
    console.log(`[sync] Tenant insurance: ${mapped.length} tenants`);
  } catch (e) { errors.push(`tenant_insurance: ${e.message}`); console.error("[sync]", e.message); }

  // ── Sync log ────────────────────────────────────────────────────────────
  const duration = Date.now() - start;
  run(`INSERT INTO sync_log (started_at, completed_at, status, records, errors, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    [new Date(start).toISOString(), TS(), errors.length ? "partial" : "ok", totalRecords,
     errors.length ? errors.join("; ") : null, duration]);

  console.log(`[sync] Done. ${totalRecords} records, ${errors.length} errors, ${Math.round(duration/1000)}s`);
  return { ok: errors.length === 0, errors, totalRecords, durationMs: duration };
}
