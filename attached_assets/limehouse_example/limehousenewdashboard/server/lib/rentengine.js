const BASE = "https://app.rentengine.io/api/public/v1";

function headers() {
  const token = process.env.RENTENGINE_API_TOKEN;
  if (!token) throw new Error("Missing RENTENGINE_API_TOKEN");
  return {
    Authorization: `Bearer ${token}`,
    accept: "application/json",
  };
}

async function request(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) url.searchParams.append(k, v.join(","));
    else url.searchParams.append(k, String(v));
  }
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`RentEngine ${res.status} ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// RentEngine pagination: page_number (0-indexed), limit max 100
async function listAll(path, params = {}, { pageSize = 100, max = 5000 } = {}) {
  const out = [];
  let page = 0;
  while (out.length < max) {
    const result = await request(path, { ...params, limit: pageSize, page_number: page });
    const items = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
    if (items.length === 0) break;
    out.push(...items);
    if (items.length < pageSize) break;
    page += 1;
    if (page > 100) break; // safety
  }
  return out;
}

export const rentengine = {
  listUnits: () => listAll("/units"),
  listProperties: () => listAll("/multifamily_properties"),
  listProspects: (createdAfter, createdBefore) =>
    listAll("/prospects", { created_after: createdAfter, created_before: createdBefore }),
  listApplicationGroups: ({ createdAfter, createdBefore } = {}) =>
    listAll("/rental_application_groups", {
      created_after: createdAfter,
      created_before: createdBefore,
    }),
  listMarketingListings: (accountId) =>
    accountId ? request(`/marketing/listings/${accountId}`) : null,
  // Per-unit leasing performance: true days_on_market plus showings, calls,
  // texts, applications, prospects, and property_health for the period.
  unitLeasingPerformance: (unitId, start, end) =>
    request(`/reporting/leasing-performance/units/${unitId}`, { start, end }),
  raw: request,
};
