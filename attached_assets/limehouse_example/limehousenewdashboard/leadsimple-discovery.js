/**
 * LeadSimple Discovery Script
 * ----------------------------
 * Run this once in your Replit shell:
 *   LEADSIMPLE_API_KEY=your_key_here node leadsimple-discovery.js
 *
 * Or add LEADSIMPLE_API_KEY to your Replit Secrets first, then just:
 *   node leadsimple-discovery.js
 *
 * It pulls:
 *   1. All process types (id + name)
 *   2. A sample of tasks (to see distinct kind values)
 *   3. All users (to map assignees to roles)
 * And writes everything to leadsimple-discovery.json
 */

const API_KEY = process.env.LEADSIMPLE_API_KEY;
if (!API_KEY) {
  console.error("Missing LEADSIMPLE_API_KEY. Set it as an env var or Replit Secret.");
  process.exit(1);
}

const BASE = "https://api.leadsimple.com/rest";
const headers = {
  "Authorization": `Bearer ${API_KEY}`,
  "Accept": "application/json",
};

async function get(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText} — ${path}\n${text}`);
  }
  return res.json();
}

async function main() {
  const output = {};

  // 1. Process types
  console.log("Pulling process types...");
  try {
    const ptPage1 = await get("/process_types", { per_page: 200 });
    const processTypes = Array.isArray(ptPage1) ? ptPage1 : (ptPage1.data || ptPage1.process_types || [ptPage1]);
    output.processTypes = processTypes.map(pt => ({
      id: pt.id,
      name: pt.name,
      created_at: pt.created_at,
    }));
    console.log(`  Found ${output.processTypes.length} process types`);
  } catch (err) {
    console.error("  Error pulling process types:", err.message);
    output.processTypes = { error: err.message };
  }

  // 2. Sample tasks -- pull 50 upcoming and 50 completed to see kind values
  console.log("Pulling sample tasks...");
  try {
    const [upcoming, completed] = await Promise.all([
      get("/tasks", { per_page: 50, due_type: "upcoming" }),
      get("/tasks", { per_page: 50, due_type: "completed" }),
    ]);
    const upArr = Array.isArray(upcoming) ? upcoming : (upcoming.data || upcoming.tasks || []);
    const compArr = Array.isArray(completed) ? completed : (completed.data || completed.tasks || []);
    const allTasks = [...upArr, ...compArr];

    // Extract distinct kind values
    const taskKinds = [...new Set(allTasks.map(t => t.kind).filter(Boolean))];
    const stepKinds = [...new Set(allTasks.map(t => t.step?.kind).filter(Boolean))];

    // Keep a few sample tasks (trimmed) so we can see the shape
    const samples = allTasks.slice(0, 10).map(t => ({
      id: t.id,
      kind: t.kind,
      description: t.description,
      due_at: t.due_at,
      completed_at: t.completed_at,
      skipped: t.skipped,
      auto_send: t.auto_send,
      step_kind: t.step?.kind,
      step_description: t.step?.description,
      step_delay_minutes: t.step?.delay_minutes,
      assignee_name: t.assignee?.name,
      assignee_email: t.assignee?.email,
      process_type_name: t.process?.process_type?.name,
      process_name: t.process?.name,
      process_stage: t.process?.stage?.name,
      deal_name: t.deal?.name,
      deal_pipeline: t.deal?.pipeline?.name,
      deal_stage: t.deal?.stage?.name,
    }));

    output.taskKinds = taskKinds;
    output.stepKinds = stepKinds;
    output.taskSamples = samples;
    output.taskCounts = { upcoming: upArr.length, completed: compArr.length };
    console.log(`  Task kinds: ${taskKinds.join(", ") || "(none found)"}`);
    console.log(`  Step kinds: ${stepKinds.join(", ") || "(none found)"}`);
    console.log(`  Sampled ${allTasks.length} tasks total`);
  } catch (err) {
    console.error("  Error pulling tasks:", err.message);
    output.tasks = { error: err.message };
  }

  // 3. Users
  console.log("Pulling users...");
  try {
    const users = await get("/users");
    const userArr = Array.isArray(users) ? users : (users.data || users.users || []);
    output.users = userArr.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      created_at: u.created_at,
    }));
    console.log(`  Found ${output.users.length} users`);
  } catch (err) {
    console.error("  Error pulling users:", err.message);
    output.users = { error: err.message };
  }

  // 4. Pipelines (deals side -- in case some KPIs use deals not processes)
  console.log("Pulling pipelines...");
  try {
    const pipelines = await get("/pipelines", { per_page: 200 });
    const pipArr = Array.isArray(pipelines) ? pipelines : (pipelines.data || pipelines.pipelines || []);
    output.pipelines = pipArr.map(p => ({
      id: p.id,
      name: p.name,
      created_at: p.created_at,
    }));
    console.log(`  Found ${output.pipelines.length} pipelines`);
  } catch (err) {
    console.error("  Error pulling pipelines:", err.message);
    output.pipelines = { error: err.message };
  }

  // Write output
  const outPath = "leadsimple-discovery.json";
  const fs = await import("fs");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nDone! Results written to ${outPath}`);
  console.log("Upload that file back to Claude and we can map everything.");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
