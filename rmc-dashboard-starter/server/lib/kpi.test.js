import test from "node:test";
import assert from "node:assert/strict";
import { scoreTier, quarterBounds, incentiveShares } from "./kpi.js";
import { getTeamQuarter, snapshotQuarter } from "./kpi.js";
import { vendorIsExempt } from "./aggregator.js";
import { getDb, run } from "./db.js";
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
});