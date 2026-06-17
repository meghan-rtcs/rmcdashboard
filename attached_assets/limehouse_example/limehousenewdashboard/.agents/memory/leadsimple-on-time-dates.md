---
name: LeadSimple on-time / compliance is calendar-date based
description: Why LeadSimple "on time" KPIs must compare ET calendar dates, not UTC timestamps
---

LeadSimple task due dates are effectively DAY-based: a task "due Mar 9" should count as on time if completed any time that day, even if `completed_at` is a few hours past the `due_at` time-of-day. The `due_at` time-of-day just reflects when the task was scheduled, not a hard intraday deadline.

**Rule:** "On time" = completed on or before the due date's calendar day, evaluated in **America/New_York** (the business runs ET; timestamps are stored UTC with `Z`). Compare `YYYY-MM-DD` strings produced via `Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" })` (fixed-width, so string `<=` is correct).

**Why:** Comparing full UTC timestamps (`completed_at <= due_at`) marked same-day-but-later completions as LATE, badly understating Task Completion Rate and Workflow Compliance. Using UTC dates (not ET) would also wrongly bump a late-evening ET completion to the next day.

**How to apply:** Any new LeadSimple KPI that judges a task against its due date (task completion, workflow compliance late/anyLate, admin/renewal follow-up, property readiness, etc.) must use the shared `isCompletedOnTime` / `isLate` helpers. **Exception:** duration/response-time metrics (within 24h/48h, processing time) are genuinely elapsed-time based and must stay timestamp-based — do NOT convert those to date comparisons.
