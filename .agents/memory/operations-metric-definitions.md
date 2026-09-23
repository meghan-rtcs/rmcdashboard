---
name: Operations metric definitions
description: Agreed business rules behind the Operations tab KPIs — change only with user sign-off
---

# Operations tab metric rules (user-approved July 2026)

- **Occupancy trend history:** start with actual recorded observations, not reconstructed history or zero-filled missing months. Keep the latest successful observation within each month.
  **Why:** the user asked to start the trend only when data exists after the prior zero-filled chart misleadingly appeared flat.
  **How to apply:** do not backfill earlier months with current occupancy; label observations as recorded monthly values rather than historical month-end measurements.

- **Billable hours / utilization**: follows the global Activity Period (month, quarter, or year). Available = weekdays (Mon–Fri) in the selected period, capped at today for an in-progress period, × 8h per tech − monthly PTO. Billable = AppFolio work-order labor hours + approved "other billable" Google Sheet hours. PTO remains monthly and is editable only when a single month is selected.
  **Why:** the client expects July/August and quarterly maintenance history to appear when changing the period; approved off-AppFolio work must reconcile visibly to the shared sheet and PTO must not count against utilization.
- **Move-in quality**: a move-in is "clean" if no work orders are created within 30 days after move-in, *excluding turnover work* (work order type containing "turn", or description mentioning lock/rekey/blind/make ready). Turnover WOs are expected and don't indicate a bad turn.
- **Insurance "expiring soon"** window is 60 days everywhere (tenant, vendor, owner/property).
- **Vendors flagged do-not-use** are excluded from vendor insurance compliance counts.
- **How to apply:** if these thresholds/exclusions need changing, confirm with the user first — they were explicitly approved.
