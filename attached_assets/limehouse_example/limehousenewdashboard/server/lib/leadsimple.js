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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// LeadSimple enforces a per-window *record* rate limit (HTTP 429 with
// "Rate limit exceeded for records"). The relevant headers are:
//   x-ratelimit-metric-records-limit  (e.g. 2000 records per window)
//   x-ratelimit-metric-records-count  (records consumed this window)
//   x-ratelimit-retry-after           (seconds until the window resets)
// We track the remaining record budget across calls and proactively pause when
// the next page wouldn't fit, then retry on any 429 using the API's own
// retry-after value. This keeps completed-task and process pages from being
// silently dropped (which previously left every completion-based KPI null).
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

const rateState = { remaining: Infinity, resetAfterSec: 30 };

function captureRateState(res) {
  const limit = num(res.headers.get("x-ratelimit-metric-records-limit"));
  const count = num(res.headers.get("x-ratelimit-metric-records-count"));
  const retryAfter = num(res.headers.get("x-ratelimit-retry-after"));
  if (limit != null && count != null) rateState.remaining = Math.max(0, limit - count);
  if (retryAfter != null && retryAfter > 0) rateState.resetAfterSec = retryAfter;
}

async function request(path, params = {}, attempt = 0) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(`${k}[]`, String(x)));
    else url.searchParams.append(k, String(v));
  }
  const res = await fetch(url, { headers: headers() });
  captureRateState(res);

  if (res.status === 429) {
    const MAX_RETRIES = 10;
    if (attempt >= MAX_RETRIES) {
      throw new Error(`LeadSimple 429 ${path}: rate limit exceeded after ${MAX_RETRIES} retries`);
    }
    const retryAfter =
      num(res.headers.get("x-ratelimit-retry-after")) ||
      num(res.headers.get("retry-after")) || 30;
    const waitMs = (retryAfter + 1) * 1000;
    console.warn(`[leadsimple] 429 on ${path}; window resets in ~${retryAfter}s (retry ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(waitMs);
    return request(path, params, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LeadSimple ${res.status} ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// LeadSimple pagination: page (1-indexed), per_page max 200.
// Before each page, if the tracked record budget is too low to cover the next
// page, proactively wait for the window to reset instead of forcing a 429.
async function listAll(path, params = {}, { pageSize = 200, max = 10000 } = {}) {
  const out = [];
  let page = 1;
  while (out.length < max) {
    if (rateState.remaining < pageSize) {
      const waitMs = (rateState.resetAfterSec + 1) * 1000;
      console.warn(`[leadsimple] record budget low (${rateState.remaining} left); pausing ~${rateState.resetAfterSec}s before ${path} p${page}`);
      await sleep(waitMs);
      rateState.remaining = Infinity; // assume reset; the next response corrects it
    }
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
