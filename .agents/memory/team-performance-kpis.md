---
name: Team Performance KPI/bonus engine
description: Durable rules behind the Team Performance tab — quarter locking, point-in-time KPIs, non-revenue units, and deferred scope
---

# Team Performance (KPIs & Bonuses) — durable decisions

- Owner access uses first-run password creation, not a configured owner password. Recovery uses the existing shared CEO View password and explicit confirmation, clears the credential, and invalidates prior owner sessions.
  **Why:** the user explicitly chose self-service setup and shared-CEO recovery after being warned that anyone knowing that shared password can take over owner access.
  **How to apply:** do not request an owner-password secret; preserve separate server-checked owner authorization and never install a test credential in the real database.

- Incentives use at most four evenly weighted KPIs per employee and a configurable $1,000 quarterly cap, with Good/Better/Best paying 50%/75%/100%; below Good pays zero. Discretionary answers and calculations require a separate owner session, not the shared CEO gate.
  **Why:** the client replaced department pool payouts with employee-level caps and explicitly required private owner scoring.
  **How to apply:** preserve cent-exact caps, owner-only authorization, and distinguish frozen payouts from explicit retroactive re-scoring.
- **Point-in-time KPIs** (owner/vendor/renters insurance %, delinquent rent) reflect live AppFolio state and cannot be reconstructed for a past quarter — for historical quarters they show null unless a locked snapshot exists. Quarters must be snapshotted before they close; future quarters cannot be snapshotted.
  **Why:** architect review flagged that scoring today's state as a past quarter's result would corrupt paid bonuses.
- **Non-revenue units**: AppFolio's API exposes no non-revenue flag/reason/date. User approved using unit_directory `rentable = 'No'` (16 units, absent from rent roll — sync inserts them) with unit tags as best-available reason; days-flagged is not available. These units are excluded from occupancy/vacancy metrics.
- Vacancy-gap KPI uses lease_history (2-yr sync window): gap = move_in − previous occupancy's COALESCE(move_out, lease_end) per unit; gaps <0 or ≥730d excluded.
- Inspection KPI credits property `unit_count` for properties with a "Building walkthrough" inspection completed in the quarter, deduped per property.
- Tier thresholds are stored as the tier's lower bound; config saves enforce monotonic thresholds per direction and non-decreasing payouts.
- Bonus eligibility defaults to all properties until the owner selects an AppFolio group. The verified report exposes comma-separated property_group_id values but not group names.
  **Why:** the eligible group did not yet exist when requested; names or client exclusions must not be guessed.
  **How to apply:** use exact ID membership, transparent ID labels, and never treat a missing selected group as all properties.
- Per-KPI property-group overrides inherit the global selection when unset. The client intends to narrow Clean Move-ins to a “Quality Turns” group, not narrow the rest of the portfolio.
  **Why:** some clients control their own turns; those properties should not penalize the maintenance team. Use the user-supplied group assignment in config rather than guessing membership.
  **How to apply:** keep assignments configurable, preserve owner-entered names across discovery syncs, and report unavailable rather than fabricate scoped results for unattributable data.
- Locked historical drilldowns must use captured evidence, never present-day configuration or group membership. Legacy snapshots lacking that evidence must explicitly show it as unavailable.
  **Why:** preserving only a group ID does not preserve the original property set after membership changes.
  **How to apply:** freeze drilldown evidence alongside new snapshots; retroactive threshold scoring must not change captured values or scope.
