const BASE = "https://api.buildium.com/v1";

function headers() {
  const id = process.env.BUILDIUM_CLIENT_ID;
  const secret = process.env.BUILDIUM_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("Missing BUILDIUM_CLIENT_ID / BUILDIUM_CLIENT_SECRET");
  }
  return {
    "x-buildium-client-id": id,
    "x-buildium-client-secret": secret,
    accept: "application/json",
  };
}

async function request(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.append(k, String(v));
  }
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Buildium ${res.status} ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function listAll(path, params = {}, { pageSize = 1000, max = 5000 } = {}) {
  const out = [];
  let offset = 0;
  while (out.length < max) {
    const page = await request(path, { ...params, limit: pageSize, offset });
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

export const buildium = {
  listUnits: () => listAll("/rentals/units"),
  listProperties: () => listAll("/rentals"),
  listOwners: () => listAll("/rentals/owners"),
  listTenants: () => listAll("/leases/tenants"),
  listLeases: (statuses = ["Active"]) =>
    listAll("/leases", { leasestatuses: statuses }, { pageSize: 1000, max: 50000 }),
  listAllLeases: () =>
    listAll("/leases", { leasestatuses: ["Active", "Past", "Future"] }, { pageSize: 1000, max: 50000 }),
  listOutstandingBalances: () =>
    listAll("/leases/outstandingbalances", { leasestatuses: ["Active"] }),
  listRentSchedules: () =>
    listAll("/leases/rent", {}, { pageSize: 1000, max: 50000 }),
  listGLAccounts: () =>
    listAll("/glaccounts", {}, { pageSize: 200, max: 1000 }),
  getGLReport: (params) =>
    listAll("/generalledger", { accountingbasis: "Accrual", ...params }, { pageSize: 200, max: 5000 }),
  listGLTransactions: (params) =>
    listAll("/generalledger/transactions", params, { pageSize: 1000, max: 100000 }),
  listRenewalHistory: (params) =>
    listAll("/leases/renewalhistory", params, { pageSize: 1000, max: 50000 }),
  listApplicants: () =>
    listAll("/applicants", {}, { pageSize: 1000, max: 50000 }),
  leaseTransactions: (leaseId) =>
    listAll(`/leases/${leaseId}/transactions`, {}, { pageSize: 1000, max: 5000 }),
  listVendors: (statuses = ["Active"]) =>
    listAll("/vendors", { statuses }, { pageSize: 1000, max: 20000 }),
  listUserRoles: () =>
    listAll("/userroles", {}, { pageSize: 1000, max: 5000 }),
  listBankAccounts: () =>
    listAll("/bankaccounts", {}, { pageSize: 100, max: 1000 }),
  listReconciliations: (bankAccountId) =>
    listAll(`/bankaccounts/${bankAccountId}/reconciliations`, {}, { pageSize: 100, max: 5000 }),
  listUsers: (params = {}) =>
    listAll("/users", params, { pageSize: 1000, max: 20000 }),
  raw: request,
};
