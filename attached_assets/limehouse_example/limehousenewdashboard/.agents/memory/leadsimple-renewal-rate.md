---
name: LeadSimple Lease Renewal Rate semantics
description: What counts as a renewal and what belongs in the renewal-rate denominator
---

The "07 Lease Renewal Process" in LeadSimple ends in one of several stages (stage_name / stage_status):
- `Lease Renewed` (completed) — the only actual renewal.
- `Owner/Tenant Non-Renewal` (backlog), `Owner Terminating Management` / `Owner Relisting` / `Owner Selling Property` (all canceled) — the tenancy ends; these are NOT renewals.
- `Send Lease`, `Upcoming` (working) — still in progress, no decision yet.

**Rules:**
1. **Renewed** is checked POSITIVELY: `stage_status === "completed" && stage_name includes "renewed"`. Do not infer renewal from "closed and not in a known non-renewal list" — that wrongly counted canceled terminations/relisting/selling as renewals (they're closed with a `closed_at` but the lease did not renew).
2. **Renewal rate denominator = decided processes only** = renewed + non-renewal outcomes. In-progress processes (Send Lease, Upcoming) are excluded and surfaced separately as `pending`. Including them understated the rate badly (was 39% vs true ~61%).

**Why:** A KPI literally named "Lease Renewal Rate" must measure decided outcomes, not pipeline conversion. Counting pending processes as "not renewed", or counting canceled non-renewals as "renewed", both distort it enough to invert conclusions.

**How to apply:** If LeadSimple adds new renewal stages, extend `isNonRenewalOutcome()` for new end-of-tenancy outcomes; the positive `isRenewed` check means a new completed stage won't be silently miscounted as a renewal. Note backlog `Owner/Tenant Non-Renewal` has no `closed_at`, so never gate "decided" on `closed_at` alone.
