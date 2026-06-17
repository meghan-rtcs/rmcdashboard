---
name: Dashboard cache refresh
description: How the served dashboard cache is rebuilt and the post-sync hook that keeps scheduled syncs visible
---

# Dashboard cache refresh

`server/index.js` serves an in-memory `cachedPayload` (built by `buildDashboard()`
from SQLite). It is only rebuilt on server start, on `POST /api/sync`, or via the
post-sync hook. Scheduled cron syncs (`server/lib/scheduler.js`) only WRITE to
SQLite — they do not own the cache.

**Rule:** any code path that updates the DB on a schedule must trigger a dashboard
rebuild, or the new data won't surface until a manual sync or restart.

**Why:** the overnight LeadSimple sync (and Buildium crons) finish in the
background; without a rebuild the user sees stale KPIs every morning.

**How to apply:** the scheduler exposes `setPostSyncHook(fn)`; `index.js`
registers `refreshDashboard` against it, and both `runSync` and
`runLeadSimpleSync` call the hook after their DB writes complete.

`refreshDashboard()` uses a `building` guard plus a `rebuildPending` dirty-flag:
a refresh requested while a build is in flight re-runs once on completion rather
than being dropped — important when two scheduled syncs finish back-to-back.
