---
name: RMC global date-range filter
description: Which dashboard metrics the global date filter scopes vs leaves point-in-time, and the safe range-handling pattern.
---

# Global date-range filter

The dashboard has a global date-range filter (presets `15d/30d/90d/6mo/12mo/all`, default `30d`). It scopes ONLY time-windowed "activity" metrics; point-in-time metrics intentionally ignore it.

**Windowed (scope to selected range):** leasing renewals + renewal-rate denominator, applications submitted, move-ins; marketing inquiries, inquiries-by-source, conversion funnel (all 4 stages), showings total/completed/scheduleable-denominator/no-shows — plus every corresponding drilldown.

**NOT windowed (always current / fixed series):** occupancy snapshot, active fixed leases (future `lease_to`), avg tenancy, delinquency, avg rent/door, open work orders, YTD income, and the 12-month revenue/occupancy/delinquency charts.

**Why:** a date window is only meaningful for flow/activity counts; point-in-time balances and "now" snapshots don't have a window. Mixing them would mislead.

**How to apply:**
- Range → SQL via `within(col, range)` in `aggregator.js`: returns `col >= date('now', MOD)` from a fixed `RANGE_MODIFIERS` whitelist, or `1=1` for `all`. Only the whitelisted constant is interpolated, so it is injection-safe. Never interpolate a raw query param into SQL.
- Thread `range` through `buildDashboard → buildLeasing/buildMarketing`, and `getDrilldown(key, range) → drillRegistry(range)`. New windowed queries must use `within(...)`, and their drilldowns must match.
- API routes (`/api/dashboard`, `/api/drilldown/:key`) must call exported `normalizeRange()` BEFORE using `range` as the per-range cache-Map key, or arbitrary `?range=` values create unbounded cache entries.
- Frontend subtitles/labels for windowed cards use the `rangeLabel` prop — don't hardcode "(30d)"/"12 months".

Note: showings and renewals legitimately return 0 from AppFolio for this account (data availability, not a code bug), so a windowed showings count of 0 is expected.
