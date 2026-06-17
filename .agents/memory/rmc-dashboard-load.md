---
name: RMC dashboard load latency vs screenshots
description: Why app-preview screenshots of the RMC dashboard show "Loading…" and it is not a bug
---

`/api/dashboard` recomputes every aggregation (occupancy/leasing/financials/marketing/maintenance + buildCharts) synchronously per request — ~2.4s normally, slower while a sync is running (SQLite contention). The frontend fetches it client-side after mount, so app-preview screenshots almost always capture the "Loading dashboard…" state even though the header/logo/nav have rendered.

**Why:** No bug — purely screenshot-vs-fetch timing. Confirm health via `curl /api/dashboard` (200 + data) and a clean browser console rather than chasing the loading screen.

**How to apply:** If asked to speed up first paint, cache the dashboard aggregation result (it only changes after a sync) instead of recomputing per request.

Drilldowns are lazy: each KPI tile fetches `GET /api/drilldown/:key` on click. Keys index a fixed server-side registry (`drillRegistry()` / `getDrilldown(key)` in aggregator.js) — never interpolate the key into SQL.
