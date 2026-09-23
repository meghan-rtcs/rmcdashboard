import test from "node:test";
import assert from "node:assert/strict";
import { scoreTier, quarterBounds, incentiveShares } from "./kpi.js";
import { computeTeamQuarter, getTeamDrilldown, getTeamQuarter, snapshotQuarter } from "./kpi.js";
import { vendorIsExempt } from "./aggregator.js";
import { getDb, queryOne, run } from "./db.js";
import { propertyGroupValues } from "./sync.js";
import { DEFAULT_TEAM_SETTINGS, REQUIRED_KPI_DEFAULTS } from "./team-settings.js";

test("lower-is-better delinquency thresholds award the highest met tier", () => {
  const tiers = Object.fromEntries(Object.entries(REQUIRED_KPI_DEFAULTS.bk_delinquent_rent)
    .map(([name, threshold]) => [name, { threshold, payout: 0 }]));
  assert.equal(scoreTier(1.9, tiers, "lower_is_better", true).tier, "best");
  assert.equal(scoreTier(2, tiers, "lower_is_better", true).tier, "better");
  assert.equal(scoreTier(4.99, tiers, "lower_is_better", true).tier, "better");
  assert.equal(scoreTier(5, tiers, "lower_is_better", true).tier, "good");
  assert.equal(scoreTier(9.99, tiers, "lower_is_better", true).tier, "good");
  assert.equal(scoreTier(10, tiers, "lower_is_better", true).tier, "none");
});

test("inspection and program defaults match the approved values", () => {
  assert.deepEqual(REQUIRED_KPI_DEFAULTS.pm_inspections, { good: 40, better: 50, best: 60 });
  assert.deepEqual(DEFAULT_TEAM_SETTINGS.tier_payouts, { good: 0.5, better: 0.75, best: 1 });
  assert.equal(DEFAULT_TEAM_SETTINGS.quarterly_incentive, 1000);
  assert.equal(DEFAULT_TEAM_SETTINGS.discretionary_questions.length, 7);
});

test("quarter boundaries are calendar-aligned for retroactive Q1–Q3 scoring", () => {
  assert.deepEqual(quarterBounds("2026-Q1"), ["2026-01-01", "2026-04-01"]);
  assert.deepEqual(quarterBounds("2026-Q3"), ["2026-07-01", "2026-10-01"]);
});

test("strict mode is KPI-specific and does not change inclusive operational thresholds", () => {
  const tiers = { good: { threshold: 30 }, better: { threshold: 20 }, best: { threshold: 10 } };
  assert.equal(scoreTier(30, tiers, "lower_is_better").tier, "good");
  assert.equal(scoreTier(30, tiers, "lower_is_better", true).tier, "none");
});

test("vendor custom exemptions require an affirmative value, never a truthy 'No'", () => {
  assert.equal(vendorIsExempt({ liability_expires: "", custom_fields: '{"exempt":"No"}' }, "exempt"), false);
  assert.equal(vendorIsExempt({ liability_expires: "", custom_fields: '{"exempt":"yes"}' }, "exempt"), true);
  assert.equal(vendorIsExempt({ liability_expires: "", custom_fields: '{"exempt":true}' }, "exempt"), true);
});

test("AppFolio comma-separated property_group_id values preserve exact IDs", () => {
  const groups = propertyGroupValues({ property_group_id: "1, 10, 14" });
  assert.deepEqual(groups.map((g) => g.id), ["1", "10", "14"]);
  assert.deepEqual(groups.map((g) => g.label), ["AppFolio group 1", "AppFolio group 10", "AppFolio group 14"]);
  assert.notEqual(groups[0].id, groups[1].id);
});

test("even KPI shares retain every cent of a $1,000 incentive", () => {
  const shares = incentiveShares(1000, 3);
  assert.deepEqual(shares, [333.34, 333.33, 333.33]);
  assert.equal(shares.reduce((sum, value) => sum + value, 0), 1000);
});

test("closed snapshot replacement is explicitly protected and retro snapshots are re-scored", () => {
  getDb();
  snapshotQuarter("2020-Q2", true); // initializes the KPI configuration in isolated test SQLite
  const payload = {
    kpis: [{ id: "bk_delinquent_rent", value: 5, tier: "best", active: true, configured: true }],
    departments: [], employees: [], historicalUnallocatedBonus: 125,
    historicalAdjustment: "Retired share removed; remaining frozen employee amounts were not redistributed.",
  };
  run("INSERT INTO quarter_results (quarter, payload, snapshot_at) VALUES (?, ?, ?)",
    ["2020-Q1", JSON.stringify(payload), "2020-04-01T00:00:00.000Z"]);
  assert.throws(() => snapshotQuarter("2020-Q1"), (err) => err.statusCode === 409);
  const viewed = getTeamQuarter("2020-Q1", true);
  assert.equal(viewed.retroactive, true);
  assert.equal(viewed.kpis[0].tier, "good"); // strict <5 means an exact 5 is only Good
  assert.equal("historicalUnallocatedBonus" in viewed, false); // never leaks to the team API object
  const oldDrilldown = getTeamDrilldown("team_bk_delinquent_rent", "2020-Q1");
  assert.equal(oldDrilldown.historicalUnavailable, true);
  assert.match(oldDrilldown.scopeNotice, /historical property scope was not captured/i);
  assert.match(oldDrilldown.scopeNotice, /not substituted/i);
});

test("per-KPI property scopes inherit, narrow values and drilldowns, and freeze in snapshots", () => {
  getDb();
  for (const table of ["quarter_results", "property_group_members", "property_group_config", "property_groups",
    "work_orders", "units", "properties"]) run(`DELETE FROM ${table}`);
  run("INSERT INTO properties (id, property_name, unit_count) VALUES ('p1','Alpha',1),('p2','Beta',1)");
  run("INSERT INTO property_groups (id,label,source_field,synced_at) VALUES ('group:1','AppFolio group 1','property_group_id','now'),('group:2','AppFolio group 2','property_group_id','now')");
  run("INSERT INTO property_group_members (group_id,property_id) VALUES ('group:1','p1'),('group:2','p2')");
  run("INSERT INTO property_group_config (group_id,display_name,updated_at) VALUES ('group:1','Quality Turns','now')");
  run(`INSERT INTO units (id,property_id,property_name,unit_name,move_in_date,rentable)
       VALUES ('u1','p1','Alpha','1','2020-01-10','Yes'),('u2','p2','Beta','2','2020-01-11','Yes')`);
  run(`INSERT INTO work_orders (id,property_id,property_name,unit_id,unit,description,status,assigned_user,created_date,completed_date)
       VALUES ('wo1','p1','Alpha','u1','1','Repair','Completed','Scott','2020-01-12','2020-01-15'),
              ('wo2','p2','Beta','u2','2','Repair','Completed','Scott','2020-01-12','2020-03-30')`);
  run(`INSERT INTO team_settings (key,value,updated_at) VALUES ('bonus_eligible_property_group','"group:1"','now')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

  // With no global and no override, null inherits the all-properties default.
  run("UPDATE team_settings SET value = '\"\"' WHERE key = 'bonus_eligible_property_group'");
  run("UPDATE kpi_config SET property_group_override = NULL WHERE id = 'mnt_clean_movein'");
  let result = computeTeamQuarter("2020-Q1");
  let clean = result.kpis.find((k) => k.id === "mnt_clean_movein");
  assert.equal(clean.propertyScope.source, "all");
  assert.equal(clean.detail, "0 clean of 2 move-ins");

  // Null means inherit the global Quality Turns group.
  run("UPDATE team_settings SET value = '\"group:1\"' WHERE key = 'bonus_eligible_property_group'");
  run("UPDATE kpi_config SET property_group_override = NULL WHERE id = 'mnt_clean_movein'");
  result = computeTeamQuarter("2020-Q1");
  clean = result.kpis.find((k) => k.id === "mnt_clean_movein");
  assert.equal(clean.propertyScope.id, "group:1");
  assert.equal(clean.propertyScope.source, "global");
  assert.equal(clean.propertyScope.label, "Quality Turns");
  assert.equal(clean.detail, "0 clean of 1 move-ins");
  let drill = getTeamDrilldown("team_mnt_clean_movein", "2020-Q1");
  assert.deepEqual(drill.rows.map((r) => r.property_name), ["Alpha"]);
  assert.match(drill.scopeNotice, /Quality Turns/);

  // A KPI override supersedes global and drives both value and row identity.
  run("UPDATE kpi_config SET property_group_override = 'group:2' WHERE id = 'mnt_clean_movein'");
  result = computeTeamQuarter("2020-Q1");
  clean = result.kpis.find((k) => k.id === "mnt_clean_movein");
  assert.equal(clean.propertyScope.source, "kpi_override");
  assert.equal(clean.propertyScope.differsFromGlobal, true);
  assert.equal(clean.detail, "0 clean of 1 move-ins");
  drill = getTeamDrilldown("team_mnt_clean_movein", "2020-Q1");
  assert.deepEqual(drill.rows.map((r) => r.property_name), ["Beta"]);

  // Work-order KPI is another property-attributable source and cannot ignore scope.
  run("UPDATE kpi_config SET property_group_override = 'group:1' WHERE id = 'mnt_wo_30days'");
  result = computeTeamQuarter("2020-Q1");
  const wo = result.kpis.find((k) => k.id === "mnt_wo_30days");
  assert.equal(wo.value, 100);
  assert.deepEqual(getTeamDrilldown("team_mnt_wo_30days", "2020-Q1").rows.map((r) => r.property_name), ["Alpha"]);

  // Mixed-attribution metrics fail visibly instead of fabricating a scoped result.
  run("UPDATE kpi_config SET property_group_override = 'group:1' WHERE id = 'mnt_util_scott'");
  const utilization = computeTeamQuarter("2020-Q1").kpis.find((k) => k.id === "mnt_util_scott");
  assert.equal(utilization.value, null);
  assert.match(utilization.dataQuality, /no reliable property ID/);
  const utilizationDrill = getTeamDrilldown("team_mnt_util_scott", "2020-Q1");
  assert.equal(utilizationDrill.rows.length, 0);
  assert.match(utilizationDrill.scopeNotice, /cannot be computed/);

  // An older payload that captured scope/value but not drilldown rows must not
  // pretend current live rows are exact historical evidence.
  run("UPDATE kpi_config SET property_group_override = 'group:1' WHERE id = 'mnt_clean_movein'");
  const frozen = computeTeamQuarter("2020-Q1");
  run("INSERT INTO quarter_results (quarter,payload,snapshot_at) VALUES ('2020-Q1',?,'2020-04-01T00:00:00Z')", [JSON.stringify(frozen)]);
  run("UPDATE kpi_config SET property_group_override = 'group:2' WHERE id = 'mnt_clean_movein'");
  const locked = getTeamQuarter("2020-Q1");
  const retro = getTeamQuarter("2020-Q1", true);
  assert.equal(locked.kpis.find((k) => k.id === "mnt_clean_movein").propertyScope.id, "group:1");
  assert.equal(retro.kpis.find((k) => k.id === "mnt_clean_movein").propertyScope.id, "group:1");
  assert.equal(retro.kpis.find((k) => k.id === "mnt_clean_movein").value,
    frozen.kpis.find((k) => k.id === "mnt_clean_movein").value);
  const legacyDrilldown = getTeamDrilldown("team_mnt_clean_movein", "2020-Q1");
  assert.equal(legacyDrilldown.historicalUnavailable, true);
  assert.match(legacyDrilldown.scopeNotice, /older snapshot did not capture/i);

  // New snapshots freeze records as well as scope/value. Later config,
  // membership, and source-record changes cannot alter the locked drilldown.
  run("DELETE FROM quarter_results WHERE quarter = '2020-Q1'");
  run("UPDATE kpi_config SET property_group_override = 'group:1' WHERE id = 'mnt_clean_movein'");
  snapshotQuarter("2020-Q1", true);
  const capturedValue = getTeamQuarter("2020-Q1").kpis.find((k) => k.id === "mnt_clean_movein").value;
  run("UPDATE kpi_config SET property_group_override = 'group:2' WHERE id = 'mnt_clean_movein'");
  run("DELETE FROM property_group_members WHERE group_id = 'group:1'");
  run("INSERT OR REPLACE INTO property_group_members (group_id,property_id) VALUES ('group:1','p2')");
  run("UPDATE units SET property_name = 'Changed after lock' WHERE id = 'u1'");
  run("DELETE FROM work_orders WHERE id = 'wo1'");
  const frozenRows = getTeamDrilldown("team_mnt_clean_movein", "2020-Q1");
  assert.deepEqual(frozenRows.rows.map((r) => r.property_name), ["Alpha"]);
  assert.equal(frozenRows.propertyScope.id, "group:1");
  assert.equal(getTeamQuarter("2020-Q1").kpis.find((k) => k.id === "mnt_clean_movein").value, capturedValue);
  assert.equal(getTeamQuarter("2020-Q1", true).kpis.find((k) => k.id === "mnt_clean_movein").value, capturedValue);
});

test("property display names survive discovery replacement and invalid scopes fail closed", () => {
  run("DELETE FROM property_groups");
  run("INSERT INTO property_groups (id,label,source_field,synced_at) VALUES ('group:1','AppFolio group 1','property_group_id','later')");
  assert.equal(queryOne(`SELECT COALESCE(pgc.display_name,pg.label) label FROM property_groups pg
    LEFT JOIN property_group_config pgc ON pgc.group_id=pg.id WHERE pg.id='group:1'`).label, "Quality Turns");

  run("UPDATE kpi_config SET property_group_override = 'missing-group' WHERE id = 'mnt_clean_movein'");
  const kpi = computeTeamQuarter("2020-Q2").kpis.find((k) => k.id === "mnt_clean_movein");
  assert.equal(kpi.propertyScope.valid, false);
  assert.equal(kpi.value, null);
  assert.match(kpi.dataQuality, /not present/);
});