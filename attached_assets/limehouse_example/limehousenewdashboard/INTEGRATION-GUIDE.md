# LeadSimple Integration Guide

Drop the 3 new files into `server/lib/`, then make the changes below.
Each section shows the EXACT line to find and what to replace it with.

---

## 1. Add env var

Add `LEADSIMPLE_API_KEY` to your Replit Secrets (or .env file).

---

## 2. New files (just drop in)

```
server/lib/leadsimple.js    -- API client
server/lib/ls-sync.js       -- sync + DB tables
server/lib/ls-aggregator.js -- KPI calculations + drilldowns
```

---

## 3. server/lib/db.js

At the BOTTOM of the `migrate()` function, right before the closing `});`
for the `db.exec(...)` block (around line 199), add this import call.

**Actually -- ls-sync.js handles its own migration.** No changes needed to db.js.
Just make sure `migrateLeadSimple()` gets called at startup (see index.js below).

---

## 4. server/lib/sync.js

### Add import at top (after the existing imports, ~line 2):

FIND:
```js
import { getDb, upsertMany, clearTable, run, query, queryOne } from "./db.js";
```

REPLACE WITH:
```js
import { getDb, upsertMany, clearTable, run, query, queryOne } from "./db.js";
import { syncLeadSimple, migrateLeadSimple } from "./ls-sync.js";
```

### Add LS sync call at the end of syncAll():

Find the `syncAll` function. At the end, right before it returns,
add a LeadSimple sync call. Look for the final return statement and
add this block before it:

```js
  // ── LeadSimple ──────────────────────────────────────────────────────
  try {
    const lsResult = await syncLeadSimple();
    if (lsResult.errors.length) errors.push(...lsResult.errors.map(e => `[LS] ${e}`));
    totalRecords += lsResult.totalRecords;
  } catch (err) {
    console.error("[sync] LeadSimple sync failed:", err.message);
    errors.push(`LeadSimple: ${err.message}`);
  }
```

---

## 5. server/lib/aggregator.js

### Add import at top:

FIND:
```js
import { query, queryOne } from "./db.js";
```

REPLACE WITH:
```js
import { query, queryOne } from "./db.js";
import { buildLeadSimpleKpis } from "./ls-aggregator.js";
```

### Add LS KPIs to the return value:

FIND (around line 950):
```js
  return { dashboard, drilldowns };
```

REPLACE WITH:
```js
  // ── LeadSimple KPIs ─────────────────────────────────────────────────
  let lsKpis = null, lsDrilldowns = {}, lsSummary = null;
  try {
    const ls = buildLeadSimpleKpis();
    lsKpis = ls.lsKpis;
    lsDrilldowns = ls.lsDrilldowns;
    lsSummary = ls.lsSummary;
  } catch (err) {
    console.warn("[agg] LeadSimple KPIs failed:", err.message);
  }

  return {
    dashboard: { ...dashboard, lsKpis, lsSummary },
    drilldowns: { ...drilldowns, ...lsDrilldowns },
  };
```

---

## 6. server/index.js

### Add migrate call at startup:

FIND:
```js
// Initialize database on startup
getDb();
```

REPLACE WITH:
```js
// Initialize database on startup
getDb();

// Run LeadSimple migration (creates LS tables if missing)
import { migrateLeadSimple } from "./lib/ls-sync.js";
migrateLeadSimple();
```

---

## 7. Limehouse Dashboard - A.html

### Expose LS data on window:

FIND:
```js
    window.LIMEHOUSE_DATA = payload.dashboard;
    window.LIMEHOUSE_DRILLDOWNS = payload.drilldowns;
    window.LIMEHOUSE_SYNC = payload.sync;
```

REPLACE WITH:
```js
    window.LIMEHOUSE_DATA = payload.dashboard;
    window.LIMEHOUSE_DRILLDOWNS = payload.drilldowns;
    window.LIMEHOUSE_SYNC = payload.sync;
    window.LIMEHOUSE_LS_KPIS = payload.dashboard.lsKpis;
    window.LIMEHOUSE_LS_SUMMARY = payload.dashboard.lsSummary;
```

---

## 8. Limehouse Revamp/components/var-a.jsx

### Three changes:

### 8a. Add LS data reference near the top of the IIFE (after the DRILL line):

FIND:
```js
  const DRILL = window.LIMEHOUSE_DRILLDOWNS;
```

REPLACE WITH:
```js
  const DRILL = window.LIMEHOUSE_DRILLDOWNS;
  const LS_KPIS = window.LIMEHOUSE_LS_KPIS;
  const LS_SUMMARY = window.LIMEHOUSE_LS_SUMMARY;
```

### 8b. Add the LeadSimple tab to the tab nav:

FIND:
```js
          {[{id:'dashboard',label:'Dashboard'},{id:'ceo',label:'CEO View'}].map(t => (
```

REPLACE WITH:
```js
          {[{id:'dashboard',label:'Dashboard'},{id:'leadsimple',label:'LeadSimple'},{id:'ceo',label:'CEO View'}].map(t => (
```

### 8c. Add the tab content routing:

FIND:
```js
        {tab === 'ceo' ? <CeoView mobile={mobile} SD={SD} showSource={showSource} setDrillKey={setDrillKey} k={k} /> : (<>
```

REPLACE WITH:
```js
        {tab === 'ceo' ? <CeoView mobile={mobile} SD={SD} showSource={showSource} setDrillKey={setDrillKey} k={k} />
         : tab === 'leadsimple' ? <LeadSimpleView mobile={mobile} setDrillKey={setDrillKey} />
         : (<>
```

### 8d. Add the LeadSimpleView component (paste BEFORE the CeoView function):

See the full component code in LEADSIMPLE-TAB.jsx (separate file).

---

## What each KPI shows

| Role | KPI | Status | Notes |
|------|-----|--------|-------|
| Admin Assistant (Belinda) | Task Completion Rate | LIVE | Fully from LS |
| Admin Assistant (Belinda) | Workflow Compliance | LIVE | Fully from LS |
| Admin Assistant (Belinda) | Resident Response Time | PARTIAL | Also needs internal comm log |
| Admin Assistant (Belinda) | Admin Follow-Up Support | PARTIAL | Also needs internal comm log |
| Asst PM (Addison) | Resident Response Time | PARTIAL | Also needs internal comm log |
| Asst PM (Addison) | Property Readiness | PARTIAL | Also needs Buildium move-in |
| Leasing Specialist | Applicant Response | UNASSIGNED | No one in LS for this role |
| Leasing Specialist | App Processing Time | UNASSIGNED | No one in LS for this role |
| Leasing Specialist | Renewal Follow-Up | UNASSIGNED | No one in LS for this role |
| Portfolio Manager (Dana) | Lease Renewal Rate | PARTIAL | Also needs Buildium lease data |
