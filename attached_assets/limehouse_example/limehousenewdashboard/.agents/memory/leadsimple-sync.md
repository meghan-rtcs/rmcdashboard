---
name: LeadSimple rate limits & sync
description: How the LeadSimple integration's rate limit works and why its pull is decoupled from the main sync
---

# LeadSimple sync

**Rate limit is per-WINDOW RECORD count, not request count.** LeadSimple returns
`x-ratelimit-metric-records-limit` (~2000), `x-ratelimit-metric-records-count`,
and `x-ratelimit-retry-after` (seconds). Old clients that only read `retry-after`
(absent) plus a `safe()` wrapper that swallowed 429s silently dropped the
completed-task and process pages — which is why those KPIs were null/zero while
only Workflow Compliance had data. Completed tasks DO return `completed_at` when
actually fetched.

**Why slow:** the account has ~10k completed tasks + ~1.8k processes; pacing
around the record budget means a full pull takes several minutes of paced
requests with proactive pauses + 429 retries.

**How to apply / current design:**
- The full LS pull is decoupled from the frequent Buildium `syncAll` — it runs on
  its own overnight cron (3 AM ET / `0 7 * * *` UTC) and via a fire-and-forget
  `POST /api/sync-leadsimple` endpoint, both guarded against concurrent runs.
- Data persists to SQLite (`ls_tasks`, `ls_processes`, `ls_users`); the dashboard
  always reads the last persisted snapshot. `GET /api/leadsimple-status` reports
  `{tasks, completedTasks, processes, lastSynced}` for verification.
- For the unassigned Leasing Specialist role, the dashboard surfaces who actually
  does the work (`coveredBy` / `unassignedNote`), derived by grouping task
  assignees across the APPLICATIONS + RENEWAL process types.

**Verifying:** don't rely on `refresh_all_logs` alone (often stale). Poll
`/api/leadsimple-status` and read the newest `/tmp/logs/Start_application_*.log`.
The status' `lastSynced`/counts only change at the END of a pull (snapshot is
swapped in atomically), so they sit at old values for minutes mid-pull — that is
normal, not a hang.
