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

**Empty reports for this account:** `renewal_summary.json` and `showings.json` return 0 rows even over a 2-year window with no status filter. Renewals/standalone-showings data is simply not exposed via those reports here; showing activity is embedded per-guest-card (`showings` count field on `guest_card_inquiries`). Don't chase a code bug — it's a data-availability gap.
