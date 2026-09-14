// ── AppFolio v2 Reports API client ───────────────────────────────────────────
// POST-based Reports API with Basic Auth.
// Env vars: APPFOLIO_CLIENT_ID, APPFOLIO_CLIENT_SECRET, APPFOLIO_DOMAIN
//
// Rate limit: 7 requests per 15 seconds (next_page_url calls are exempt).
// Pagination: 5000 rows per page via next_page_url (valid for 30 min).

const DOMAIN = () => process.env.APPFOLIO_DOMAIN;
const BASE = () => `https://${DOMAIN()}.appfolio.com/api/v2/reports`;

function authHeader() {
  const id = process.env.APPFOLIO_CLIENT_ID;
  const secret = process.env.APPFOLIO_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Missing APPFOLIO_CLIENT_ID or APPFOLIO_CLIENT_SECRET");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

// Simple rate limiter: max 7 calls per 15s window
let callLog = [];
async function rateWait() {
  const now = Date.now();
  callLog = callLog.filter(t => now - t < 15000);
  if (callLog.length >= 6) { // leave 1 slot buffer
    const oldest = callLog[0];
    const waitMs = 15000 - (now - oldest) + 200;
    if (waitMs > 0) {
      console.log(`[af] Rate limit pause ${Math.round(waitMs / 1000)}s`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  callLog.push(Date.now());
}

async function postReport(endpoint, body = {}, opts = {}) {
  await rateWait();
  const url = `${BASE()}/${endpoint}`;
  console.log(`[af] POST ${endpoint}`);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`[af] fetch threw for ${endpoint}: ${e.message} | cause: ${e.cause?.message || e.cause?.code || "n/a"}`);
    throw e;
  }
  if (res.status === 429) {
    console.warn("[af] 429 — waiting 16s and retrying");
    await new Promise(r => setTimeout(r, 16000));
    return postReport(endpoint, body, opts);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AppFolio ${res.status} ${endpoint}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Fetch all pages of a paginated report
async function fetchAll(endpoint, body = {}) {
  const first = await postReport(endpoint, body);

  // If paginate_results=false was set, response is a flat array
  if (Array.isArray(first)) return first;

  const rows = first.results || [];
  let nextUrl = first.next_page_url;

  while (nextUrl) {
    // next_page_url calls are NOT rate limited.
    // AppFolio returns a relative path here, so resolve it against the host origin.
    const absUrl = /^https?:\/\//i.test(nextUrl)
      ? nextUrl
      : new URL(nextUrl, `https://${DOMAIN()}.appfolio.com`).href;
    console.log(`[af] next_page (${rows.length} rows so far)`);
    const res = await fetch(absUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(),
      },
      body: JSON.stringify({}), // no filters allowed on next_page
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[af] next_page error ${res.status}: ${text.slice(0, 200)}`);
      break;
    }
    const page = await res.json();
    if (Array.isArray(page)) { rows.push(...page); break; }
    rows.push(...(page.results || []));
    nextUrl = page.next_page_url || null;
  }

  return rows;
}

// ── Report helpers ──────────────────────────────────────────────────────────

export const appfolio = {
  // Generic access for probing/one-off reports
  raw: (endpoint, body = {}) => fetchAll(endpoint, body),
  // Core property/unit data
  unitDirectory: (body = {}) => fetchAll("unit_directory.json", body),
  propertyDirectory: (body = {}) => fetchAll("property_directory.json", body),
  ownerDirectory: (body = {}) => fetchAll("owner_directory.json", body),
  tenantDirectory: (body = {}) => fetchAll("tenant_directory.json", body),
  vendorDirectory: (body = {}) => fetchAll("vendor_directory.json", body),

  // Occupancy & vacancy
  occupancySummary: (asOfTo) => fetchAll("occupancy_summary.json", { as_of_to: asOfTo }),
  unitVacancyDetail: (body = {}) => fetchAll("unit_vacancy.json", body),

  // Rent & leasing
  rentRoll: (asOfTo) => fetchAll("rent_roll.json", { as_of_to: asOfTo }),
  rentRollItemized: (asOfTo, body = {}) => fetchAll("rent_roll_itemized.json", { as_of_to: asOfTo, ...body }),
  renewalSummary: (fromMonth, toMonth, body = {}) =>
    fetchAll("renewal_summary.json", { start_on_from: fromMonth, start_on_to: toMonth, ...body }),
  leaseHistory: (fromMonth, toMonth, body = {}) =>
    fetchAll("lease_history.json", { lease_history_filter_by: "Lease Start Date", start_on_from: fromMonth, start_on_to: toMonth, ...body }),
  leaseExpirationDetail: (fromMonth, toMonth, body = {}) =>
    fetchAll("lease_expiration_detail_by_month.json", { filter_lease_date_range_by: "Lease Expiration Date", ends_on_from: fromMonth, ends_on_to: toMonth, ...body }),
  leaseExpirationSummary: (fromMonth) =>
    fetchAll("lease_expiration_summary_by_month.json", { ends_on_from: fromMonth }),
  leasingSummary: (fromDate, toDate, body = {}) =>
    fetchAll("leasing_summary.json", { posted_on_from: fromDate, posted_on_to: toDate, ...body }),
  rentalApplications: (fromDate, toDate, body = {}) =>
    fetchAll("rental_applications.json", { received_on_from: fromDate, received_on_to: toDate, ...body }),

  // Marketing / leasing funnel
  showings: (fromDate, toDate, body = {}) =>
    fetchAll("showings.json", { showing_date_from: fromDate, showing_date_to: toDate, ...body }),
  guestCardInquiries: (fromDate, toDate, body = {}) =>
    fetchAll("guest_card_inquiries.json", { received_on_from: fromDate, received_on_to: toDate, ...body }),
  guestCardInterests: (fromDate, toDate, body = {}) =>
    fetchAll("guest_card_interests.json", { received_on_from: fromDate, received_on_to: toDate, ...body }),
  leasingFunnelPerformance: (fromDate, toDate, body = {}) =>
    fetchAll("leasing_funnel_performance.json", { received_on_from: fromDate, received_on_to: toDate, ...body }),
  leasingAgentPerformance: (fromDate, toDate, body = {}) =>
    fetchAll("leasing_agent_performance.json", { received_on_from: fromDate, received_on_to: toDate, ...body }),
  prospectSourceTracking: (fromDate, toDate, body = {}) =>
    fetchAll("prospect_source_tracking.json", { received_on_from: fromDate, received_on_to: toDate, ...body }),

  // Financials
  incomeStatement: (asOfMonth, body = {}) =>
    fetchAll("income_statement.json", { posted_on_to: asOfMonth, ...body }),
  incomeStatement12Month: (fromMonth, toMonth, body = {}) =>
    fetchAll("income_statement_12_month.json", { posted_on_from: fromMonth, posted_on_to: toMonth, ...body }),
  incomeStatementDateRange: (fromDate, toDate, body = {}) =>
    fetchAll("income_statement_date_range.json", { posted_on_from: fromDate, posted_on_to: toDate, ...body }),
  cashFlow: (fromDate, toDate, body = {}) =>
    fetchAll("cash_flow.json", { posted_on_from: fromDate, posted_on_to: toDate, ...body }),
  cashFlow12Month: (fromMonth, toMonth, body = {}) =>
    fetchAll("cash_flow_12_month.json", { posted_on_from: fromMonth, posted_on_to: toMonth, ...body }),
  twelveMonthCashFlow: (fromMonth, toMonth, body = {}) =>
    fetchAll("twelve_month_cash_flow.json", { posted_on_from: fromMonth, posted_on_to: toMonth, ...body }),
  generalLedger: (fromDate, toDate, body = {}) =>
    fetchAll("general_ledger.json", { posted_on_from: fromDate, posted_on_to: toDate, ...body }),
  balanceSheet: (asOfDate, body = {}) =>
    fetchAll("balance_sheet.json", { posted_on_to: asOfDate, ...body }),
  accountTotals: (fromDate, toDate, body = {}) =>
    fetchAll("account_totals.json", { posted_on_from: fromDate, posted_on_to: toDate, ...body }),

  // Delinquency
  delinquency: (body = {}) => fetchAll("delinquency.json", body),
  agedReceivablesDetail: (body = {}) => fetchAll("aged_receivables_detail.json", body),
  // AppFolio silently defaults this report to a short upcoming-expiration
  // window when no filters are supplied. Request a wide range so insurance
  // compliance reflects the complete active policy inventory.
  ownerInsurance: (body = {}) =>
    fetchAll("owner_insurance.json", {
      expires_on_from: "2000-01-01",
      expires_on_to: "2100-12-31",
      ...body,
    }),
  inspectionDetail: (body = {}) => fetchAll("inspection_detail.json", body),
  delinquencyAsOf: (asOfDate, body = {}) =>
    fetchAll("delinquency_as_of.json", { occurred_on_to: asOfDate, ...body }),
  agedReceivableDetail: (asOfDate, body = {}) =>
    fetchAll("aged_receivable_detail.json", { occurred_on_to: asOfDate, ...body }),
  tenantUnpaidChargesSummary: (asOfDate, body = {}) =>
    fetchAll("tenant_unpaid_charges_summary.json", { occurred_on_to: asOfDate, ...body }),

  // Security deposits
  securityDepositFundsDetail: (asOfDate, body = {}) =>
    fetchAll("security_deposit_funds_detail.json", { occurred_on_to: asOfDate, ...body }),

  // Maintenance
  workOrders: (body = {}) => fetchAll("work_order.json", body),
  workOrderLaborSummary: (fromDate, toDate, body = {}) =>
    fetchAll("work_order_labor_summary.json", { labor_performed_from: fromDate, labor_performed_to: toDate, ...body }),
  unitTurnDetail: (body = {}) => fetchAll("unit_turn_detail.json", body),

  // Inspections
  inspectionDetail: (body = {}) => fetchAll("inspection_detail.json", body),
  unitInspection: (asOfDate, body = {}) =>
    fetchAll("unit_inspection.json", { last_inspection_on_from: asOfDate, ...body }),

  // Workflows / activities
  activitiesSummary: (fromDate, toDate, body = {}) =>
    fetchAll("activities_summary.json", { due_at_from: fromDate, due_at_to: toDate, ...body }),
  inProgressWorkflows: (body = {}) => fetchAll("in_progress_workflows.json", body),
  completedWorkflows: (fromDate, toDate, body = {}) =>
    fetchAll("completed_workflows.json", { date_range_from: fromDate, date_range_to: toDate, ...body }),

  // Tenant financials
  tenantTransactionsSummary: (month, body = {}) =>
    fetchAll("tenant_transactions_summary.json", { month_of_to: month, ...body }),
  receivablesActivity: (fromDate, toDate, body = {}) =>
    fetchAll("receivables_activity.json", { receipt_date_from: fromDate, receipt_date_to: toDate, ...body }),
  chargeDetail: (fromDate, toDate, body = {}) =>
    fetchAll("charge_detail.json", { charge_date_from: fromDate, charge_date_to: toDate, ...body }),
  residentFinancialActivity: (fromDate, toDate, body = {}) =>
    fetchAll("resident_financial_activity.json", { occurred_on_from: fromDate, occurred_on_to: toDate, ...body }),
  incomeRegister: (fromDate, toDate, body = {}) =>
    fetchAll("income_register.json", { receipt_date_from: fromDate, receipt_date_to: toDate, ...body }),

  // Surveys
  surveyResponses: (fromDate, toDate, body = {}) =>
    fetchAll("survey_responses.json", { occurred_on_from: fromDate, occurred_on_to: toDate, ...body }),

  // Owner
  ownerLeasing: (fromDate, toDate, body = {}) =>
    fetchAll("owner_leasing.json", { received_on_from: fromDate, received_on_to: toDate, ...body }),

  // Bills / expenses
  billDetail: (fromDate, toDate, body = {}) =>
    fetchAll("bill_detail.json", { occurred_on_from: fromDate, occurred_on_to: toDate, ...body }),
  expenseRegister: (fromDate, toDate, body = {}) =>
    fetchAll("expense_register.json", { occurred_on_from: fromDate, occurred_on_to: toDate, ...body }),
  checkRegister: (fromDate, toDate, body = {}) =>
    fetchAll("check_register.json", { occurred_on_from: fromDate, occurred_on_to: toDate, ...body }),

  // Saved reports
  savedReport: (uuid, opts = {}) => {
    const url = `https://${DOMAIN()}.appfolio.com/api/v2/reports/saved/${uuid}.json`;
    // GET request, not POST
    return fetch(url, {
      headers: { "Content-Type": "application/json", Authorization: authHeader() },
    }).then(r => r.json()).then(d => d.results || d);
  },

  // Raw access for any endpoint
  raw: postReport,
  rawAll: fetchAll,
};
