---
name: AppFolio report endpoint names (this account)
description: Which AppFolio /reports/*.json endpoints exist vs 400 for the RMC account, and their useful fields
---

AppFolio report names are account-specific — probe with a live POST before trusting a name.

**Why:** Several plausible report names return HTTP 400 `{"message":["Id is not a valid report."]}` in this account, which silently zeroed out dashboard metrics until the correct names were found.

**How to apply:** When a metric is always 0 or a sync step 400s, probe `POST https://<domain>.appfolio.com/api/v2/reports/<name>` (Basic auth, `{paginate_results:false}`) to confirm the report exists and inspect its keys.

Confirmed for this account:
- `unit_vacancy.json` — 200. Fields: days_vacant, available_on, computed_market_rent, advertised_rent, schd_rent, unit_status, unit_id, property_id, property_name. (NOT `unit_vacancy_detail.json` / `vacancy.json` → 400.)
- `income_statement.json` — 200. Fields: account_name, month_to_date, year_to_date, last_year_to_date. Has summary rows `Total Income` and `Total Expense` (use year_to_date). Gross = Total Income; Net = Total Income − Total Expense.
- `twelve_month_cash_flow.json` — 200. Per-account `months:[{id:"YYYY-MM",value}]` + `total`; has `Total Income`/`Total Expense` rows. Ideal source for a 12-month revenue chart. (NOT `income_statement_12_month.json` / `cash_flow_12_month.json` → 400.)

**Relative pagination URLs:** AppFolio `next_page_url` can be relative; resolve it to absolute against the API base before refetching, or pagination breaks.

**Date field is `received`, NOT `received_date`/`received_on`:** `guest_card_inquiries.json` and `rental_applications.json` return their inquiry/application date in a field literally named `received` (ISO timestamp like `2025-09-04T22:50:06Z`). Mapping only `received_date || received_on` stored blank, which silently zeroed ALL date-windowed marketing/funnel metrics while the rows existed. Slice to `received.slice(0,10)` for clean `date('now',...)` comparisons. Application status field is `status` (values: Converted, Converting, Canceled, Denied, Decision Pending — NO `Approved`); guest-card inquiry source is `source` (Zillow Rental Network dominates), application source is `lead_source`/`applicant_reported_source`.

**`work_order.json` field quirks:** creation date is `created_at` (NOT `created_on`/`created_date` — those don't exist, so mapping only those left the column blank and zeroed avg-days-to-complete). `created_at` is the AppFolio *data-entry* date: for migrated/legacy work orders it lands years AFTER the real historical `completed_on`, producing ~2000 rows with completed < created and a nonsensical negative average — guard turnaround calcs with `completed_date >= created_date`. `work_order_type` values are `Resident` (= tenant-requested), `Internal`, `Unit Turn`. Completion date is `completed_on`.

**`units` occupancy_status values:** `Current` (occupied), `Vacant-Rented`, `Vacant-Unrented`, `Notice-Rented`, `Evict`. Derive vacant-rented vs vacant-not-rented from this status (`%Vacant%`+`%Rented%` excluding `%Unrented%` vs `%Vacant%`+`%Unrented%`), NOT from `lease_to` which is unpopulated for vacant units.

**`renewal_summary.json` — needs a WIDE window AND `statuses:["all"]`, then dedupe.** It is NOT empty (earlier belief was wrong): a trailing-12-month window returned 0 only because this account's renewals are historical (all 2020–2021). Use `start_on_from:"2010-01-01"` to a future `start_on_to`. `start_on` filters by the *new* lease's start. Without `statuses:["all"]` it returns only `Renewed` (53); with it you also get `Canceled by User` (→69) which you NEED for a real renewal-rate denominator. AppFolio then emits the SAME renewal event twice — once `Canceled by User` (superseded draft) and once `Renewed`. Dedupe by `occupancy_id|lease_start|lease_end`, keeping the `Renewed` row when present (genuinely distinct renewals of one lease have different lease_end, so they survive). Fields: new lease = `lease_start`/`lease_end`, prior = `previous_lease_start/end`; new rent = `rent` (NOT `new_rent`); unit = `unit_name`; status = `status`. No `Month To Month` status appears here, so MTM-lease metrics stay legitimately 0.

**Labor / tickler / insurance sources (probed, confirmed):**
- `work_order_labor_summary.json` — 200. Filter `labor_performed_from/to`. Fields: `worked_hours`, `hours`, `maintenance_tech`, `date`, `work_order_number/status`, `unit_turn_id`, timer fields. Basis for billable-hours metrics.
- `tenant_tickler.json` — 200. Event-style rows: `event`, `occurred_date`, `move_in_date`, `move_out_date`, `lease_from/to`, tenant/unit/property ids. (NOT `tickler.json` → 400.)
- `renters_insurance.json` → 400 (not a valid report). Tenant insurance lives on `tenant_directory`: `insurance_company_name`, `insurance_expiration`, `insurance_policy_number` (populated for many tenants).
- `vendor_directory` insurance fields: `liability_ins_expires`, `workers_comp_expires`, `auto_ins_expires`, `epa_cert_expires`, `state_lic_expires`, `contract_expires`.
- `property_directory` has `insurance_expiration` (owner/property policy) + `home_warranty_expiration`, `contract_expirations`.

**`showings.json` empty for this account:** returns 0 rows even over a 2-year window. Standalone-showings data isn't exposed here; showing activity is embedded per-guest-card (`showings` count field on `guest_card_inquiries`). Don't chase a code bug — it's a data-availability gap.

**`late_fee_policy_comparison.json`** — 200, valid. One row per policy: property-level defaults (occupancy_id null) + per-occupancy overrides. Fields: late_fee_type (Flat/Percentage), late_fee_base_amount, late_fee_daily_amount, eligible_charge_type (All/Recurring Rent Only), rent_grace_days, effective_date/end_date, property_id, occupancy_id. Resolve active policy per occupancy: filter effective_date<=today<end_date, occupancy override beats property default, latest effective_date wins. Delinquency report itself has NO policy field (its `late` field = count of late payments).

**`aged_receivables_detail.json`** — 200, valid. One row per unpaid charge with `account_name` (GL account: Rent, Tenant Utilities, Utilities - Water/Electric/Gas, Pass Thru Income, etc.), aging buckets, occupancy/unit ids. "Owner Withdrawal" rows are non-tenant clearing entries — exclude them and the report total exactly matches the delinquency report total. Delinquency is split Rent/Utilities/Other from this report at sync time (table receivable_charges); tile amounts are NET (credits included) so they reconcile with the total.
