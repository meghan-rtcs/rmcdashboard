---
name: Operations metric definitions
description: Agreed business rules behind the Operations tab KPIs — change only with user sign-off
---

# Operations tab metric rules (user-approved July 2026)

- **Billable hours / utilization**: current month only. Available = elapsed weekdays (Mon–Fri) × 8h per tech − manually entered PTO. Billable = AppFolio work-order labor hours + manually entered "other billable" (off-AppFolio project) hours. Manual entries live in `labor_adjustments` (period+tech PK), editable in the dashboard UI.
  **Why:** techs do billable project work not tracked in AppFolio, and PTO must not count against utilization.
- **Move-in quality**: a move-in is "clean" if no work orders are created within 30 days after move-in, *excluding turnover work* (work order type containing "turn", or description mentioning lock/rekey/blind/make ready). Turnover WOs are expected and don't indicate a bad turn.
- **Insurance "expiring soon"** window is 60 days everywhere (tenant, vendor, owner/property).
- **Vendors flagged do-not-use** are excluded from vendor insurance compliance counts.
- **How to apply:** if these thresholds/exclusions need changing, confirm with the user first — they were explicitly approved.
