# RMC Dashboard — Build Instructions

You are building a KPI dashboard for Real Management Company (RMC), a property management company. The infrastructure is already in place — you need to build the **aggregator** (server/lib/aggregator.js) and the **frontend** (public/index.html with inline React).

## What's already built (DO NOT modify unless fixing bugs):
- `server/lib/appfolio.js` — AppFolio v2 Reports API client (POST-based, Basic Auth, pagination, rate limiting)
- `server/lib/db.js` — SQLite schema with tables: units, delinquency, renewals, showings, applications, guest_cards, vacancies, work_orders, owners, vendors, properties, security_deposits, income_rows, sync_log
- `server/lib/sync.js` — Pulls data from AppFolio API into SQLite (rent_roll, delinquency, renewals, showings, applications, vacancies, work_orders, owners, properties, guest_cards, vendors)
- `server/index.js` — Express server with /api/dashboard, /api/sync, scheduled sync every 2 hours
- `package.json` — Dependencies: better-sqlite3, express
- `METRIC-MAPPING.md` — Complete mapping of every dashboard metric to its SQL calculation

## Environment variables (already in Replit Secrets):
- `APPFOLIO_CLIENT_ID`
- `APPFOLIO_CLIENT_SECRET`
- `APPFOLIO_DOMAIN`

## What you need to build:

### 1. `server/lib/aggregator.js`

Create a `buildDashboard()` function that queries the SQLite tables and returns a JSON payload for the frontend. Reference METRIC-MAPPING.md for every calculation.

The return shape should be:
```js
{
  dashboard: {
    meta: { syncedAt, totalUnits, totalProperties, totalOwners },
    occupancy: {
      rate, totalUnits, occupied, vacant, vacantNotRented, vacantRented,
      avgDaysVacant, properties, owners
    },
    leasing: {
      renewalRate, renewalsCount, mtmLeases, fixedLeases,
      appsSubmitted, moveins, appsPerMovein, avgTenancyMonths
    },
    financials: {
      delinquent, delinquentCount, delinquencyRate,
      aging: { current, thirtyPlus, sixtyPlus, ninetyPlus },
      avgRentPerDoor, grossIncome, netIncome
    },
    marketing: {
      inquiries, activeProspects, showingsTotal, showingsCompleted,
      showingCompletionRate, noShows, unitsOnMarket,
      inquiriesBySource: [{ source, count }],
      funnel: { inquiries, showings, applications, approved, converted }
    },
    maintenance: {
      openWorkOrders, avgDaysToComplete,
      byPriority: { urgent, normal, low },
      byType: { internal, tenantRequested, unitTurn }
    },
    charts: {
      monthlyRevenue: [{ month, gross, net, expense }],  // 12 months
      occupancyTrend: [{ month, rate }],                  // 12 months
      delinquencyTrend: [{ month, total }],               // 12 months
    }
  },
  sync: { lastSync, status, duration }
}
```

For charts, use the `income_statement_12_month` endpoint via live API call in the aggregator (import appfolio from "./appfolio.js"), or use the income_rows table if pre-synced. The aggregator can mix SQLite queries with live API calls where needed (same pattern as Limehouse's aggregator).

Each metric should use the `buildKpi(value, prevYear, opts)` pattern:
```js
function buildKpi(value, prevYear = 0, opts = {}) {
  return { value: value ?? 0, prevYear: prevYear ?? 0, ...opts };
}
```

### 2. `public/index.html`

Single-file React app (React 18 from CDN, no build step). This is a single HTML file with all CSS and JSX inline. Use Babel standalone for JSX transformation.

**Structure:**
```html
<!DOCTYPE html>
<html>
<head>
  <title>RMC Dashboard</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    // App code here
  </script>
</body>
</html>
```

**Branding — RMC colors (from their logo):**
- Primary gold: `#F5A623`
- Dark gold (hover): `#D48B1A`
- Black: `#1A1A1A`
- Warm white bg: `#FFFAF2`
- Card bg: `#FFFFFF`
- Border: `#E8E0D4`
- Muted text: `#6B6B6B`
- Green (good): `#2D8C3E`
- Red (bad): `#C0392B`
- Amber (warning): `#D68910`

**Header:** Company name "Real Management Company" with tagline "See what's possible.℠" in the gold color. No logo image needed — just styled text.

**Layout — 3 tabs:**
1. **Dashboard** (default) — Main metrics grid similar to Limehouse:
   - Top summary bar: Occupancy Rate, Total Units, Delinquency Rate, Avg Rent/Door
   - Occupancy section: occupied/vacant counts, avg days vacant, units on market
   - Leasing section: renewal rate, MTM vs fixed, apps submitted, move-ins
   - Marketing section: inquiries, showings (completed/no-show/total), leasing funnel
   - Financial section: delinquent total with 30/60/90+ breakdown, gross/net income
   - Maintenance section: open WOs, avg days to complete, by priority
   - Charts: 12-month revenue trend, occupancy trend

2. **Leasing & Marketing** — Detailed leasing funnel view:
   - Inquiry sources breakdown
   - Showing stats by agent
   - Application pipeline (New → In Review → Approved → Converted)
   - Vacancy list with days vacant and market rent

3. **CEO View** — Password protected (password: `RMCRTCS`):
   - Financial deep dive (full P&L summary)
   - Delinquency details
   - Renewal performance
   - Owner/property count trends

**KPI card pattern:**
```jsx
function KpiCard({ label, value, unit, delta, invertDelta }) {
  // value with unit prefix/suffix
  // delta arrow (green up / red down, inverted for metrics where lower is better)
  // Clean, minimal card with gold accent on left border
}
```

**Important design rules:**
- No external CSS frameworks. All CSS is inline styles in the JSX.
- Mobile responsive: use CSS grid with auto-fit columns
- Fetch data from `/api/dashboard` on mount, show loading state
- Include a "Sync Now" button that POSTs to `/api/sync` and refreshes
- Show last sync time in the header
- Password protection for CEO View: simple state-based gate (no server auth needed)

### 3. Fix the db.js async import issue

The `getDb()` function uses `await import("fs")` but isn't async. Fix it:
```js
import fs from "fs";
// ... then use fs.mkdirSync directly instead of dynamic import
```

## What NOT to include:
- No LeadSimple integration (RMC doesn't use it)
- No Team Performance / bonus calculator tab (that was Limehouse-specific)
- No RentEngine references (AppFolio replaces it entirely)
- No Buildium references

## After building, test:
1. `npm install`
2. Start the server (it will auto-sync after 5 seconds)
3. Watch console for `[sync]` lines confirming data pull
4. Open the dashboard in browser
5. If any AppFolio endpoint returns empty or errors, check the sync log and adjust the field mapping in sync.js (AppFolio field names vary slightly between accounts)
