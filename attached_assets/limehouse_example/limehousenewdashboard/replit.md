# Limehouse Property Management Dashboard

A static React dashboard (Babel-in-browser) for Limehouse Property Management, served by a small Node/Express backend that pulls live operating data from Buildium and RentEngine.

## Architecture

- **Frontend** (`Limehouse Revamp/`)
  - `Limehouse Dashboard - A.html` — the only entry page (single-variant production view)
  - `components/var-a.jsx`, `shared.jsx`, `app-a.jsx`, `tweaks-panel.jsx` — React components compiled with `@babel/standalone` in the browser
  - The HTML bootstraps by `fetch()`ing `/api/dashboard`, populating `window.LIMEHOUSE_DATA` / `LIMEHOUSE_DRILLDOWNS` / `LIMEHOUSE_SYNC`, then injecting Babel-compiled `<script>` tags. Each compiled script is wrapped in an IIFE so top-level `const useState = …` declarations don't collide across files.
  - The header "Sync now" button POSTs to `/api/sync` and reloads.

- **Backend** (`server/`)
  - `index.js` — Express app, port 5000. `GET /` sends `Limehouse Dashboard - A.html`; the rest of `Limehouse Revamp/` is served statically. Exposes:
    - `GET /api/dashboard` — full payload (`{ dashboard, drilldowns, sync }`)
    - `POST /api/sync` — forces a refresh
    - `GET /api/sync-status` — `{ fetchedAt, fetching, isStale, lastError, lastErrorAt, ttlMs }`
  - `lib/cache.js` — in-memory cache with 10-minute TTL and background refresh on demand
  - `lib/buildium.js` — Buildium v1 REST client (`x-buildium-client-id` / `x-buildium-client-secret` headers, `limit`/`offset` pagination)
  - `lib/rentengine.js` — RentEngine public v1 client (`Authorization: Bearer …`, `limit` + `page_number` pagination, max 100 per page; handles bare-array and `{data, page}` envelope responses)
  - `lib/aggregator.js` — pulls from both APIs in parallel and produces the dashboard shape consumed by the frontend
  - `lib/history.js` — JSON-file persistence (`server/data/sync-history.json`) of one snapshot per (year, month, day) capturing `{totalLeases, paidLeases, delinquentLeases, delinquentTotal}`. Used to derive "Rent by 3rd / 10th" — for each calendar month with a snapshot whose `dayOfMonth ≤ N`, we treat the latest such snapshot as the "by day N" observation and average the % paid across the trailing 6 months.

## Data Sources

| Metric | Source | Notes |
| --- | --- | --- |
| Total units, occupancy, owners | Buildium `/rentals/units`, `/leases?statuses=Active`, `/rentals/owners` | Occupied = unique `UnitId` set across active leases |
| Avg rent / door, RPU | Buildium active leases (`AccountDetails.Rent`) | |
| Total delinquent + aging buckets | Buildium `/leases/outstandingbalances` | Uses `Balance0To30Days`, `Balance31To60Days`, `Balance61To90Days`, `BalanceOver90Days` |
| Gross / net income (12 mo) | Buildium `/glaccounts` + `/generalledger/transactions` | Filters journal lines to `Type=Income` and `Type=Expense` GL accounts; sums `Journal.Lines[].Amount` per month |
| Lease type counts (fixed vs MTM) | Buildium active leases (`LeaseType`) | |
| New prospects, source breakdown | RentEngine `/prospects?created_after=&created_before=` | |
| Applications submitted | Buildium `/applicants` | Each applicant record has `Applications[]` with `ApplicationSubmittedDateTime`; we count submissions in the trailing 12 months. RentEngine's `/rental_application_groups` returned 0 for this account, so Buildium is the system of record. |
| Units on market | RentEngine `/units` filtered by `status` | |
| Avg / median days on market | RentEngine `/units` (created_at) | Days since `created_at` for units where `!is_occupied` and `status` is Available/Listed |
| Rent by 3rd / 10th | Sync-history snapshots (`server/data/sync-history.json`) | Each successful sync records `{paidLeases, totalLeases}`. Tile = avg paid% across the latest snapshot of each of the last 6 months whose dayOfMonth ≤ N. Empty/zero until snapshots accumulate across months. |
| Renewal rate / count | Buildium `/leases` (all statuses) + `/leases/tenants` | Detects consecutive leases on the same unit where the new lease starts within −30..+60 days of the previous one's end and shares a tenant identity (matched by lowercased email, falling back to name+DOB). Rate = renewals / leases that ended in the period. |
| Evictions pending | Buildium active leases (`IsEvictionPending`) | |
| Vacant rented | Buildium `/leases?statuses=Future` | Units not in active-lease set with a Future lease whose `LeaseFromDate > today` |
| Avg days vacant | Buildium past leases (`MoveOutData[].MoveOutDate` / `LeaseToDate`) | For each currently-vacant unit, days since the most recent past-lease end |
| Doors gained / lost / net | Local `property_snapshots` table | Daily snapshot of the active property roster (one row per active property per UTC day, captured automatically on every sync). Gained = properties on today's roster but missing from the oldest snapshot in the trailing 12 months; Lost = vice versa. Door counts come from `unit_count` at each snapshot date. No manual data entry required (replaces the prior dependency on `ManagementAgreement*` dates, which staff rarely populated). Requires 1 full year of snapshots to reach a true trailing-12mo baseline. |
| Avg length of tenancy | Buildium all leases + `MoveOutData` / `Tenants[].MoveInDate` | Per-tenant: chains all leases for a `(tenantId, unitId)` pair, takes earliest MoveInDate → latest MoveOutDate. Window: tenants whose latest MoveOutDate is in the trailing 12 months. Chaining is essential because Buildium creates a new lease record with a new LeaseFromDate at every renewal. |
| Avg SD withheld ($, %) | Buildium `/leases/{id}/transactions` per past lease | Sums `|TotalAmount|` of `ApplyDeposit` transactions whose memo contains "deposit applied" (excludes "Prepayment applied to balances" — same TransactionTypeEnum but different concept). Capped at original SecurityDeposit as a safety belt. Window: move-outs from 13 months ago through 30 days ago (gives time for reconciliation, which Limehouse posts ~30 days after move-out). Per-lease API calls throttled to concurrency 5 via `pMap`. |

Metrics that still return `0` because no derivable source exists in the live API responses: showings, calls, texts, rent-increase distribution. Some date-driven metrics may also legitimately read `0` (e.g. owners gained = 0 when all populated `ManagementAgreementStartDate` values are older than 12 months) — those are real, not placeholder.

## Scheduled Jobs (`server/lib/scheduler.js`)

`node-cron` runs `syncAll("incremental")` on multiple schedules:
- 6 AM ET (`0 10 * * *` UTC) — morning sync
- 9 PM ET (`0 1 * * *` UTC) — evening sync
- **00:05 UTC daily** (`5 0 * * *`) — midnight sync. Primary purpose is to capture a fresh `property_snapshots` row each day for doors gained/lost diffing.
- Day 1–5 and 8–12 of each month at noon UTC — extra snapshots for the "Rent by 3rd/10th" tiles.

Each sync also calls `recordPropertySnapshot()`, which atomically deletes + re-inserts the current active property roster for today's UTC date (idempotent — multiple same-day runs converge on the latest state).

## Caching & Refresh

- `lib/cache.js` keeps the latest aggregated payload in memory. TTL is 10 minutes.
- The first request after server start triggers an initial refresh; subsequent requests serve the cached payload.
- `POST /api/sync` forces a refresh; the front-end "Sync now" button calls this and then reloads.
- A background refresh kicks off automatically on stale reads while still serving the previous payload.

## Environment / Secrets

Required (already configured):

- `BUILDIUM_CLIENT_ID`
- `BUILDIUM_CLIENT_SECRET`
- `RENTENGINE_API_TOKEN`

Postgres env vars (`DATABASE_URL`, `PG*`) are present but unused by this app.

## Workflow

`Start application` runs `node server/index.js` on port 5000, which is what the preview proxies.

## Notes

- Mock data has been removed entirely. The previous `Limehouse Revamp/data/mock-data.js` and `data/drilldowns.js` were deleted.
- The multi-variant comparison page and B/C variants have been removed; only the single-variant A page is exposed.
- The OpenAPI spec for RentEngine lives at `attached_assets/openapi_1777396695311.json` (kept as a reference).
- `server/data/sync-history.json` accumulates one snapshot per UTC day. It must persist across deploys for the "Rent by Nth" tiles to backfill — keep deploying as a VM (filesystem persistence) rather than autoscale.
