// Keep the latest successful observation for each month, never invent past data.
import { getDb } from "./db.js";

export function recordOccupancyMonth(observedAt) {
  const db = getDb();
  const { total, occupied } = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN occupancy_status IN ('Occupied','Current')
      OR (tenant_name IS NOT NULL AND tenant_name != '') THEN 1 ELSE 0 END) AS occupied
    FROM units WHERE COALESCE(rentable,'') != 'No'`).get();
  if (!total) return;
  const month = observedAt.slice(0, 7);
  const value = Math.round(occupied / total * 1000) / 10;
  db.transaction(() => {
    db.prepare("DELETE FROM monthly_snapshots WHERE metric = 'occupancy_rate' AND month = ?").run(month);
    db.prepare("INSERT INTO monthly_snapshots (month, metric, value, created_at) VALUES (?, 'occupancy_rate', ?, ?)")
      .run(month, value, observedAt);
  })();
}

export function occupancyHistory(months) {
  const rows = getDb().prepare(`SELECT month, value FROM monthly_snapshots
    WHERE metric = 'occupancy_rate' AND value IS NOT NULL
    ORDER BY created_at, id`).all();
  const values = new Map(rows.filter(r => Number.isFinite(r.value)).map(r => [r.month, r.value]));
  const first = months.findIndex(month => values.has(month));
  if (first === -1) return [];
  const last = months.findLastIndex(month => values.has(month));
  return months.slice(first, last + 1).map(month => ({
    month, rate: values.has(month) ? values.get(month) : null,
  }));
}