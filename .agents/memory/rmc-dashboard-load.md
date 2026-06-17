---
name: RMC dashboard load latency & caching
description: How /api/dashboard caching works and why early screenshots can still show "Loading…"
---

`buildDashboard()` recomputes every aggregation (occupancy/leasing/financials/marketing/maintenance + buildCharts) and makes live AppFolio report calls (`twelve_month_cash_flow`, `income_statement`) — ~2s+ per build, slower during a sync (SQLite contention).

`/api/dashboard` is wrapped in an in-memory cache in `server/index.js`: 5-min TTL, single-flight coalescing (concurrent misses share one build), and the cache is cleared on sync completion via `runSync().finally(clearDashboardCache)`. So the FIRST request after boot/sync/TTL-expiry takes ~2s; every subsequent request is instant (~3ms).

**Why:** A chart-heavy frontend made the per-request 2s blank load a real UX regression. Caching is correct because dashboard data only changes after a sync.

**How to apply:** To screenshot the rendered UI, prime the cache first (`curl /api/dashboard` once, or just reload after the workflow's restart screenshot already primed it), then capture — otherwise the very first navigation can still catch the "Loading…" client-fetch state. Confirm health via `curl /api/dashboard` (200 + data) and a clean browser console.

Drilldowns are lazy: each KPI tile / chart card fetches `GET /api/drilldown/:key` on click. Keys index a fixed server-side registry (`drillRegistry()` / `getDrilldown(key)` in aggregator.js) — never interpolate the key into SQL.

Frontend is a SINGLE-file React 18 + Babel CDN app (`public/index.html`). It mimics the Limehouse example's chart-rich information design (few hero tiles per section + inline-SVG LineChart/DualBars/Donut/HBars/Funnel/Sparkline) in RMC's gold/cream brand. CEO tab gate is client-side only (password `RMCRTCS`) — a soft UI gate, not real access control.
