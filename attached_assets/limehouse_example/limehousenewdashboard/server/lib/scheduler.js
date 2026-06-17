import cron from "node-cron";
import { syncAll } from "./sync.js";
import { syncLeadSimple } from "./ls-sync.js";

let syncing = false;
let lsSyncing = false;

// Optional hook the HTTP layer registers so that scheduled syncs (which only
// write to SQLite) also rebuild the in-memory dashboard cache that /api/dashboard
// serves. Without this, an overnight sync wouldn't surface until a manual sync
// or a server restart.
let postSyncHook = null;
export function setPostSyncHook(fn) {
  postSyncHook = typeof fn === "function" ? fn : null;
}
async function runPostSyncHook() {
  if (!postSyncHook) return;
  try {
    await postSyncHook();
  } catch (err) {
    console.error("[scheduler] Post-sync dashboard refresh failed:", err.message);
  }
}

async function runSync(type = "incremental") {
  if (syncing) {
    console.log("[scheduler] Sync already in progress, skipping");
    return;
  }
  syncing = true;
  try {
    await syncAll(type);
    await runPostSyncHook();
  } catch (err) {
    console.error("[scheduler] Sync failed:", err.message);
  } finally {
    syncing = false;
  }
}

// LeadSimple has a strict per-window record rate limit, so a full pull is slow
// (several minutes of paced requests). It runs on its own overnight schedule,
// independent of the frequent Buildium sync, and persists to SQLite. The
// dashboard always reads the last persisted snapshot.
async function runLeadSimpleSync() {
  if (lsSyncing) {
    console.log("[scheduler] LeadSimple sync already in progress, skipping");
    return;
  }
  lsSyncing = true;
  try {
    const result = await syncLeadSimple();
    console.log(`[scheduler] LeadSimple sync done — ${result.totalRecords} records, ${result.errors.length} errors`);
    await runPostSyncHook();
  } catch (err) {
    console.error("[scheduler] LeadSimple sync failed:", err.message);
  } finally {
    lsSyncing = false;
  }
}

export function startScheduler() {
  // 6:00 AM ET (10:00 UTC) — morning sync
  cron.schedule("0 10 * * *", () => {
    console.log("[scheduler] Morning sync triggered");
    runSync("incremental");
  });

  // 9:00 PM ET (01:00 UTC next day) — evening sync
  cron.schedule("0 1 * * *", () => {
    console.log("[scheduler] Evening sync triggered");
    runSync("incremental");
  });

  // Midnight UTC — daily property roster snapshot for doors gained/lost tracking
  cron.schedule("5 0 * * *", () => {
    console.log("[scheduler] Midnight property snapshot sync triggered");
    runSync("incremental");
  });

  // Extra snapshots on rent collection windows:
  // Day 1-5 and Day 8-12 of each month at noon UTC
  // (captures "by 3rd" and "by 10th" windows)
  cron.schedule("0 16 1-5,8-12 * *", () => {
    console.log("[scheduler] Rent collection snapshot triggered");
    runSync("incremental");
  });

  // LeadSimple overnight sync — 3:00 AM ET (07:00 UTC), off-peak so the slow,
  // rate-limited pull doesn't compete with daytime API usage.
  cron.schedule("0 7 * * *", () => {
    console.log("[scheduler] LeadSimple overnight sync triggered");
    runLeadSimpleSync();
  });

  console.log("[scheduler] Cron jobs registered (6 AM ET, 9 PM ET, rent-window snapshots, 3 AM ET LeadSimple)");
}

export { runSync, runLeadSimpleSync };
