import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "./lib/db.js";
import { syncAll } from "./lib/sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// ── Initialize DB ─────────────────────────────────────────────────────────
getDb();

// ── API: Dashboard data ───────────────────────────────────────────────────
app.get("/api/dashboard", async (req, res) => {
  try {
    // Import aggregator dynamically (will be built next)
    const { buildDashboard } = await import("./lib/aggregator.js");
    const data = await buildDashboard();
    res.json(data);
  } catch (err) {
    console.error("[api] Dashboard error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Trigger sync ─────────────────────────────────────────────────────
app.post("/api/sync", async (req, res) => {
  try {
    const result = await syncAll();
    res.json(result);
  } catch (err) {
    console.error("[api] Sync error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Sync status ──────────────────────────────────────────────────────
app.get("/api/sync/status", (req, res) => {
  const { query: q } = await import("./lib/db.js");
  const last = q("SELECT * FROM sync_log ORDER BY id DESC LIMIT 1")[0];
  res.json(last || { status: "never" });
});

// ── Scheduled sync (every 2 hours) ───────────────────────────────────────
let syncRunning = false;
async function scheduledSync() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    console.log("[scheduler] Starting sync...");
    await syncAll();
  } catch (err) {
    console.error("[scheduler] Sync failed:", err.message);
  } finally {
    syncRunning = false;
  }
}

// Run initial sync after 5s, then every 2 hours
setTimeout(scheduledSync, 5000);
setInterval(scheduledSync, 2 * 60 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`RMC Dashboard running on port ${PORT}`);
});
