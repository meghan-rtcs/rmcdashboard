---
name: Team Performance KPI/bonus engine
description: Durable rules behind the Team Performance tab — quarter locking, point-in-time KPIs, non-revenue units, and deferred scope
---

# Team Performance (KPIs & Bonuses) — durable decisions

- All KPI thresholds/payouts/roster live in `kpi_config`/`kpi_roster` DB tables (editable in the UI). Payout dollar amounts were seeded at $0 — the client has not provided them yet. TBD KPIs (days on market, days to lease, WO time-to-completion) are inactive with null thresholds; Bookkeeping thresholds are also unset.
  **Why:** spec required nothing hardcoded and explicitly forbade guessing TBD thresholds.
- **Point-in-time KPIs** (owner/vendor/renters insurance %, delinquent rent) reflect live AppFolio state and cannot be reconstructed for a past quarter — for historical quarters they show null unless a locked snapshot exists. Quarters must be snapshotted before they close; future quarters cannot be snapshotted.
  **Why:** architect review flagged that scoring today's state as a past quarter's result would corrupt paid bonuses.
- **Non-revenue units**: AppFolio's API exposes no non-revenue flag/reason/date. User approved using unit_directory `rentable = 'No'` (16 units, absent from rent roll — sync inserts them) with unit tags as best-available reason; days-flagged is not available. These units are excluded from occupancy/vacancy metrics.
- Vacancy-gap KPI uses lease_history (2-yr sync window): gap = move_in − previous occupancy's COALESCE(move_out, lease_end) per unit; gaps <0 or ≥730d excluded.
- Inspection KPI credits property `unit_count` for properties with a "Building walkthrough" inspection completed in the quarter, deduped per property.
- Tier thresholds are stored as the tier's lower bound; config saves enforce monotonic thresholds per direction and non-decreasing payouts.
- **Deferred by user (Aug 2026):** Google Sheets integration for "other billable hours" (manual entry kept); §8.2 Operations bug (user said ignore); Opiniion review bonus (out of scope but leave data-model room).
