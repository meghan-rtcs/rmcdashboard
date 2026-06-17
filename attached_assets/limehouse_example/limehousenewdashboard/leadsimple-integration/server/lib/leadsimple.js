// ── LeadSimple REST API client ────────────────────────────────────────────────
// Follows the same pattern as buildium.js / rentengine.js.
// Env var: LEADSIMPLE_API_KEY

const BASE = "https://api.leadsimple.com/rest";

function headers() {
  const key = process.env.LEADSIMPLE_API_KEY;
  if (!key) throw new Error("Missing LEADSIMPLE_API_KEY");
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
}

async function request(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(`${k}[]`, String(x)));
    else url.searchParams.append(k, String(v));
  }
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LeadSimple ${res.status} ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// LeadSimple pagination: page (1-indexed), per_page max 200
async function listAll(path, params = {}, { pageSize = 200, max = 10000 } = {}) {
  const out = [];
  let page = 1;
  while (out.length < max) {
    const result = await request(path, { ...params, per_page: pageSize, page });
    const items = Array.isArray(result) ? result : (result?.data || []);
    if (items.length === 0) break;
    out.push(...items);
    if (items.length < pageSize) break;
    page += 1;
    if (page > 200) break; // safety
  }
  return out;
}

export const leadsimple = {
  // Tasks
  listTasks: (dueType, opts = {}) =>
    listAll("/tasks", { due_type: dueType, ...opts }),
  listTasksSince: (unixTs) =>
    listAll("/tasks", { updated_since: unixTs }),

  // Processes
  listProcesses: (processTypeId, opts = {}) =>
    listAll("/processes", { process_type_id: processTypeId, ...opts }),
  listAllProcesses: (opts = {}) =>
    listAll("/processes", opts),
  getProcess: (id) => request(`/processes/${id}`),

  // Process types + stages
  listProcessTypes: () => listAll("/process_types"),
  getProcessType: (id) => request(`/process_types/${id}`),
  getProcessTypeStages: (id) => listAll(`/process_types/${id}/stages`),

  // Users
  listUsers: () => request("/users"),

  // Deals (pipeline side)
  listDeals: (pipelineId) =>
    listAll(pipelineId ? `/pipelines/${pipelineId}/deals` : "/deals"),

  // Conversations (for future response-time metrics)
  listConversations: (opts = {}) =>
    listAll("/conversations", opts),

  // Raw access
  raw: request,
};
