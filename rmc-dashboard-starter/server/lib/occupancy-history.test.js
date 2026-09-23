import test from "node:test";
import assert from "node:assert/strict";
import { getDb } from "./db.js";
import { occupancyHistory, recordOccupancyMonth } from "./occupancy-history.js";

test("occupancy history starts with observed data, preserves zero and gaps, and updates only its month", () => {
  const db = getDb();
  db.exec("DELETE FROM monthly_snapshots; DELETE FROM units;");
  const months = ["2026-01", "2026-02", "2026-03", "2026-04"];
  assert.deepEqual(occupancyHistory(months), []);
  recordOccupancyMonth("2026-02-01T00:00:00Z");
  assert.deepEqual(occupancyHistory(months), []);
  db.exec(`INSERT INTO units (id, rentable, occupancy_status) VALUES
    ('occupied', 'Yes', 'Occupied'), ('vacant', 'Yes', 'Vacant'), ('excluded', 'No', 'Vacant')`);
  recordOccupancyMonth("2026-02-01T00:00:00Z");
  assert.deepEqual(occupancyHistory(months), [{month: "2026-02", rate: 50}]);
  db.exec("UPDATE units SET occupancy_status = 'Vacant'");
  recordOccupancyMonth("2026-04-01T00:00:00Z");
  assert.deepEqual(occupancyHistory(months), [
    {month: "2026-02", rate: 50}, {month: "2026-03", rate: null}, {month: "2026-04", rate: 0},
  ]);
  db.exec("UPDATE units SET occupancy_status = 'Occupied' WHERE id = 'vacant'");
  recordOccupancyMonth("2026-04-02T00:00:00Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM monthly_snapshots").get().n, 2);
  assert.equal(occupancyHistory(months).at(-1).rate, 50);
  assert.equal(occupancyHistory(months)[0].rate, 50);
});