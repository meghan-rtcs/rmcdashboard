// ── LeadSimple KPI aggregator ────────────────────────────────────────────────
// Reads from ls_tasks / ls_processes tables and produces KPI values
// plus drilldown data for the LeadSimple dashboard tab.

import { query, queryOne } from "./db.js";
import { PROCESS_TYPES } from "./ls-sync.js";

// ── Role mapping (email -> role) ────────────────────────────────────────────
const ROLE_MAP = {
  "assistant@limehousepm.com": { role: "Administrative Assistant", abbrev: "AA", name: "Belinda Jean Dabandan" },
  "dana@limehousepm.com": { role: "Portfolio Manager", abbrev: "PM", name: "Dana Sampson" },
  "addison@limehousepm.com": { role: "Assistant Property Manager", abbrev: "APM", name: "Addison Winter" },
};

// All KPI roles from the doc, including unassigned ones
const ALL_ROLES = [
  { abbrev: "AA",  role: "Administrative Assistant",     email: "assistant@limehousepm.com" },
  { abbrev: "APM", role: "Assistant Property Manager",   email: "addison@limehousepm.com" },
  { abbrev: "LS",  role: "Leasing Specialist",           email: null },
  { abbrev: "PM",  role: "Portfolio Manager",             email: "dana@limehousepm.com" },
];

function pct(n, d, decimals = 1) {
  if (!d) return null;
  return Math.round((n / d) * Math.pow(10, decimals + 2)) / Math.pow(10, decimals);
}

function businessHoursBetween(start, end) {
  // Simplified: count calendar hours, multiply by 5/7 to approximate biz hours
  // A more precise version would exclude weekends and holidays
  if (!start || !end) return null;
  const ms = new Date(end) - new Date(start);
  if (ms < 0) return 0;
  const hours = ms / (1000 * 60 * 60);
  return Math.round(hours * (5 / 7) * 10) / 10;
}

// ── On-time helpers (calendar-date based, business timezone) ─────────────────
// LeadSimple due dates are effectively day-based: a task "due Mar 9" should count
// as on time if it's completed any time that day, even if the completed_at
// timestamp is a few hours past the due_at time-of-day (which just reflects when
// the task was scheduled, not a hard intraday deadline). So we compare CALENDAR
// DATES, not exact timestamps, and we do it in the business's timezone (ET) so a
// late-evening ET completion isn't bumped to the next UTC day.
const BIZ_TZ = "America/New_York";
const _dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: BIZ_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});
function bizDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return _dateFmt.format(d); // YYYY-MM-DD, safe for string comparison
}
// On time = completed on or before the due date's calendar day.
function isCompletedOnTime(due_at, completed_at) {
  if (!due_at) return true;            // no due date -> treat as on time
  if (!completed_at) return false;     // due but not completed -> not on time
  const dd = bizDate(due_at), cd = bizDate(completed_at);
  if (!dd || !cd) return true;         // unparseable -> don't penalize
  return cd <= dd;
}
// Late = completed strictly after the due date's calendar day.
function isLate(due_at, completed_at) {
  if (!due_at || !completed_at) return false;
  const dd = bizDate(due_at), cd = bizDate(completed_at);
  if (!dd || !cd) return false;
  return cd > dd;
}

// ── Main builder ────────────────────────────────────────────────────────────
export function buildLeadSimpleKpis() {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);

  // Trailing 90 days for task metrics
  const d90 = new Date(now);
  d90.setDate(d90.getDate() - 90);
  const d90Iso = d90.toISOString();

  // Trailing 30 days for more recent view
  const d30 = new Date(now);
  d30.setDate(d30.getDate() - 30);
  const d30Iso = d30.toISOString();

  // ════════════════════════════════════════════════════════════════════════
  // 1. TASK COMPLETION RATE (Admin Assistant)
  //    % of tasks completed on or before due_at
  //    Source: "LeadSimple task data"
  // ════════════════════════════════════════════════════════════════════════

  const completedTasks90d = query(`
    SELECT id, description, due_at, completed_at, assignee_email, assignee_name,
           process_type_name, process_name, kind
    FROM ls_tasks
    WHERE completed_at IS NOT NULL
      AND completed_at >= ?
      AND skipped = 0
  `, [d90Iso]);

  function taskCompletionForEmail(email) {
    const tasks = email
      ? completedTasks90d.filter(t => t.assignee_email === email)
      : completedTasks90d;
    if (tasks.length === 0) return { rate: null, onTime: 0, total: 0, rows: [] };
    let onTime = 0;
    const rows = tasks.map(t => {
      const isOnTime = isCompletedOnTime(t.due_at, t.completed_at);
      if (isOnTime) onTime++;
      return {
        description: t.description || "(no description)",
        due_at: t.due_at || "none",
        completed_at: t.completed_at,
        on_time: isOnTime,
        assignee: t.assignee_name || t.assignee_email || "unassigned",
        process: t.process_type_name || t.process_name || "standalone",
      };
    });
    return { rate: pct(onTime, tasks.length), onTime, total: tasks.length, rows };
  }

  const aaTaskCompletion = taskCompletionForEmail("assistant@limehousepm.com");
  const companyTaskCompletion = taskCompletionForEmail(null);

  // ════════════════════════════════════════════════════════════════════════
  // 2. WORKFLOW COMPLIANCE (Admin Assistant)
  //    Processes where ALL tasks completed on time and none skipped
  //    Source: "LeadSimple workflow data / task audit"
  // ════════════════════════════════════════════════════════════════════════

  function workflowComplianceForEmail(email) {
    // Get all processes that have tasks assigned to this user
    const processIds = query(`
      SELECT DISTINCT process_id FROM ls_tasks
      WHERE assignee_email = ? AND process_id IS NOT NULL
    `, [email]).map(r => r.process_id);

    if (processIds.length === 0) return { rate: null, compliant: 0, total: 0, rows: [] };

    let compliant = 0;
    const rows = [];
    for (const pid of processIds) {
      const tasks = query(`
        SELECT id, description, due_at, completed_at, skipped, assignee_email
        FROM ls_tasks WHERE process_id = ?
      `, [pid]);
      const proc = queryOne("SELECT name, process_type_name, stage_name FROM ls_processes WHERE id = ?", [pid]);
      const anySkipped = tasks.some(t => t.skipped);
      const anyLate = tasks.some(t => isLate(t.due_at, t.completed_at));
      const anyIncomplete = tasks.some(t => !t.completed_at && !t.skipped);
      const isCompliant = !anySkipped && !anyLate;
      if (isCompliant) compliant++;
      rows.push({
        process: proc?.name || pid,
        type: proc?.process_type_name || "unknown",
        taskCount: tasks.length,
        skipped: tasks.filter(t => t.skipped).length,
        late: tasks.filter(t => isLate(t.due_at, t.completed_at)).length,
        incomplete: tasks.filter(t => !t.completed_at && !t.skipped).length,
        compliant: isCompliant,
      });
    }
    return { rate: pct(compliant, processIds.length), compliant, total: processIds.length, rows };
  }

  const aaWorkflowCompliance = workflowComplianceForEmail("assistant@limehousepm.com");

  // ════════════════════════════════════════════════════════════════════════
  // 3. RESIDENT RESPONSE TIME (Admin Assistant + APM)
  //    Email/communication tasks completed within 24 biz hours
  //    Source: "LeadSimple communication tasks"
  // ════════════════════════════════════════════════════════════════════════

  function responseTimeForEmail(email) {
    const commTasks = query(`
      SELECT id, description, due_at, completed_at, created_at, kind,
             assignee_email, assignee_name, process_type_name
      FROM ls_tasks
      WHERE assignee_email = ?
        AND completed_at IS NOT NULL
        AND completed_at >= ?
        AND (kind = 'email' OR LOWER(description) LIKE '%respond%'
             OR LOWER(description) LIKE '%follow%up%' OR LOWER(description) LIKE '%call%'
             OR LOWER(description) LIKE '%contact%' OR LOWER(description) LIKE '%notify%'
             OR LOWER(description) LIKE '%reach out%' OR LOWER(description) LIKE '%check in%')
    `, [email, d90Iso]);

    if (commTasks.length === 0) return { rate: null, within24: 0, total: 0, avgHours: null, rows: [] };

    let within24 = 0;
    let totalHours = 0;
    let measurable = 0;
    const rows = commTasks.map(t => {
      // Measure from due_at (when task became actionable) to completed_at
      // If no due_at, use created_at as the start
      const start = t.due_at || t.created_at;
      const hours = businessHoursBetween(start, t.completed_at);
      if (hours !== null) {
        if (hours <= 24) within24++;
        totalHours += hours;
        measurable++;
      }
      return {
        description: t.description || "(no description)",
        kind: t.kind,
        start,
        completed_at: t.completed_at,
        hours: hours !== null ? hours : "n/a",
        within24: hours !== null ? hours <= 24 : null,
        process: t.process_type_name || "standalone",
      };
    });

    return {
      rate: pct(within24, commTasks.length),
      within24,
      total: commTasks.length,
      avgHours: measurable ? Math.round((totalHours / measurable) * 10) / 10 : null,
      rows,
    };
  }

  const aaResponseTime = responseTimeForEmail("assistant@limehousepm.com");
  const apmResponseTime = responseTimeForEmail("addison@limehousepm.com");

  // ════════════════════════════════════════════════════════════════════════
  // 4. ADMIN FOLLOW-UP SUPPORT (Admin Assistant)
  //    Follow-up tasks completed on time
  //    Source: "LeadSimple follow-up tasks"
  // ════════════════════════════════════════════════════════════════════════

  const aaFollowUpTasks = query(`
    SELECT id, description, due_at, completed_at, process_type_name, process_name
    FROM ls_tasks
    WHERE assignee_email = 'assistant@limehousepm.com'
      AND completed_at IS NOT NULL
      AND completed_at >= ?
      AND (LOWER(description) LIKE '%follow%up%' OR LOWER(description) LIKE '%follow-up%'
           OR LOWER(description) LIKE '%check in%' OR LOWER(description) LIKE '%confirm%')
  `, [d90Iso]);

  const aaFollowUp = (() => {
    if (aaFollowUpTasks.length === 0) return { rate: null, onTime: 0, total: 0, rows: [] };
    let onTime = 0;
    const rows = aaFollowUpTasks.map(t => {
      const isOnTime = isCompletedOnTime(t.due_at, t.completed_at);
      if (isOnTime) onTime++;
      return {
        description: t.description,
        due_at: t.due_at || "none",
        completed_at: t.completed_at,
        on_time: isOnTime,
        process: t.process_type_name || t.process_name || "standalone",
      };
    });
    return { rate: pct(onTime, aaFollowUpTasks.length), onTime, total: aaFollowUpTasks.length, rows };
  })();

  // ════════════════════════════════════════════════════════════════════════
  // 5. APPLICATION PROCESSING TIME (Leasing Specialist -- UNASSIGNED)
  //    Time from process created_at to closed_at for Applications Process
  //    Source: "LeadSimple workflow data"
  // ════════════════════════════════════════════════════════════════════════

  const appProcesses = query(`
    SELECT id, name, created_at, closed_at, time_to_close, stage_name, stage_status
    FROM ls_processes
    WHERE process_type_id = ?
      AND created_at >= ?
  `, [PROCESS_TYPES.APPLICATIONS, d90Iso]);

  const appProcessingTime = (() => {
    const closed = appProcesses.filter(p => p.closed_at);
    if (closed.length === 0) return { avgHours: null, within48: 0, total: appProcesses.length, closedCount: 0, rows: [] };
    let within48 = 0;
    let totalHours = 0;
    const rows = closed.map(p => {
      const hours = (new Date(p.closed_at) - new Date(p.created_at)) / (1000 * 60 * 60);
      if (hours <= 48) within48++;
      totalHours += hours;
      return {
        name: p.name,
        created_at: p.created_at,
        closed_at: p.closed_at,
        hours: Math.round(hours * 10) / 10,
        within48: hours <= 48,
      };
    });
    return {
      avgHours: Math.round((totalHours / closed.length) * 10) / 10,
      within48,
      total: appProcesses.length,
      closedCount: closed.length,
      rows,
    };
  })();

  // ════════════════════════════════════════════════════════════════════════
  // 6. RENEWAL FOLLOW-UP TIMELINESS (Leasing Specialist -- UNASSIGNED)
  //    Tasks in Lease Renewal Process completed within workflow timelines
  //    Source: "LeadSimple renewal workflow"
  // ════════════════════════════════════════════════════════════════════════

  const renewalTasks = query(`
    SELECT id, description, due_at, completed_at, assignee_email, assignee_name,
           process_name, process_stage
    FROM ls_tasks
    WHERE process_type_id = ?
      AND completed_at IS NOT NULL
      AND completed_at >= ?
  `, [PROCESS_TYPES.RENEWAL, d90Iso]);

  const renewalFollowUp = (() => {
    if (renewalTasks.length === 0) return { rate: null, onTime: 0, total: 0, rows: [] };
    let onTime = 0;
    const rows = renewalTasks.map(t => {
      const isOnTime = isCompletedOnTime(t.due_at, t.completed_at);
      if (isOnTime) onTime++;
      return {
        description: t.description,
        due_at: t.due_at || "none",
        completed_at: t.completed_at,
        on_time: isOnTime,
        assignee: t.assignee_name || "unassigned",
        process: t.process_name,
        stage: t.process_stage,
      };
    });
    return { rate: pct(onTime, renewalTasks.length), onTime, total: renewalTasks.length, rows };
  })();

  // ════════════════════════════════════════════════════════════════════════
  // 7. LEASE RENEWAL RATE (Portfolio Manager -- partial, LS component)
  //    Renewal processes completed vs total started
  //    Source: "LeadSimple renewal workflow" (also needs Buildium)
  // ════════════════════════════════════════════════════════════════════════

  const renewalProcesses = query(`
    SELECT id, name, stage_name, stage_status, created_at, closed_at
    FROM ls_processes
    WHERE process_type_id = ?
      AND created_at >= ?
  `, [PROCESS_TYPES.RENEWAL, new Date(now.getFullYear(), now.getMonth() - 12, 1).toISOString()]);

  // A renewal process only counts as an actual renewal if the lease was renewed.
  // Any outcome where the tenancy ends -- owner/tenant non-renewal, owner
  // terminating management, owner relisting, owner selling the property -- is NOT
  // a renewal even though the process is "closed". Canceled processes are never
  // renewals by definition.
  const isNonRenewalOutcome = (stage) => {
    const s = (stage || "").toLowerCase();
    return (
      s.includes("non-renewal") ||
      s.includes("not renewing") ||
      s.includes("terminating management") || // owner terminating management
      s.includes("relisting") ||              // owner relisting
      s.includes("selling")                   // owner selling property
    );
  };
  // Renewed = the lease was actually renewed (positive terminal outcome), not
  // merely "closed". Checked positively so a new canceled/non-renewal stage can
  // never be mistaken for a renewal.
  const isRenewed = (p) =>
    p.stage_status === "completed" &&
    (p.stage_name || "").toLowerCase().includes("renewed") &&
    !isNonRenewalOutcome(p.stage_name);
  const renewalRate = (() => {
    if (renewalProcesses.length === 0) {
      return { rate: null, renewed: 0, total: 0, pending: 0, rows: [] };
    }
    // The rate only counts processes that have reached a renewal DECISION:
    // either renewed, or a non-renewal outcome (owner/tenant non-renewal, owner
    // terminating management, relisting, selling). Still-in-progress processes
    // ("Send Lease", "Upcoming") have no decision yet, so including them in the
    // denominator would understate the true renewal rate -- they're excluded and
    // surfaced separately as `pending`.
    const isDecided = (p) => isRenewed(p) || isNonRenewalOutcome(p.stage_name);
    const decided = renewalProcesses.filter(isDecided);
    const renewed = decided.filter(isRenewed);
    const rows = renewalProcesses.map(p => ({
      name: p.name,
      stage: p.stage_name,
      status: p.stage_status,
      created_at: p.created_at,
      closed_at: p.closed_at || "open",
      renewed: isRenewed(p),
      decided: isDecided(p),
    }));
    return {
      rate: pct(renewed.length, decided.length),
      renewed: renewed.length,
      total: decided.length,
      pending: renewalProcesses.length - decided.length,
      rows,
    };
  })();

  // ════════════════════════════════════════════════════════════════════════
  // 8. PROPERTY READINESS (APM -- partial, LS component)
  //    Move In Process tasks completed on time
  //    Source: "LeadSimple task completion"
  // ════════════════════════════════════════════════════════════════════════

  const moveInTasks = query(`
    SELECT id, description, due_at, completed_at, assignee_email, assignee_name,
           process_name, process_stage
    FROM ls_tasks
    WHERE process_type_id = ?
      AND completed_at IS NOT NULL
      AND completed_at >= ?
  `, [PROCESS_TYPES.MOVE_IN, d90Iso]);

  const propertyReadiness = (() => {
    const apmTasks = moveInTasks.filter(t => t.assignee_email === "addison@limehousepm.com");
    const tasks = apmTasks.length > 0 ? apmTasks : moveInTasks; // fallback to all if APM has none
    if (tasks.length === 0) return { rate: null, onTime: 0, total: 0, rows: [] };
    let onTime = 0;
    const rows = tasks.map(t => {
      const isOnTime = isCompletedOnTime(t.due_at, t.completed_at);
      if (isOnTime) onTime++;
      return {
        description: t.description,
        due_at: t.due_at || "none",
        completed_at: t.completed_at,
        on_time: isOnTime,
        assignee: t.assignee_name || "unassigned",
        process: t.process_name,
      };
    });
    return { rate: pct(onTime, tasks.length), onTime, total: tasks.length, rows };
  })();

  // ════════════════════════════════════════════════════════════════════════
  // 9. APPLICANT RESPONSE TIMELINESS (Leasing Specialist -- UNASSIGNED)
  //    First task in Applications Process completed within 24 hours
  //    Source: "LeadSimple + RentEngine"
  // ════════════════════════════════════════════════════════════════════════

  // Group application tasks by process, find the first task
  const allAppTasks = query(`
    SELECT id, description, due_at, completed_at, created_at, process_id,
           process_name, assignee_name
    FROM ls_tasks
    WHERE process_type_id = ?
      AND completed_at IS NOT NULL
      AND completed_at >= ?
    ORDER BY process_id, due_at ASC
  `, [PROCESS_TYPES.APPLICATIONS, d90Iso]);

  const applicantResponse = (() => {
    // Group by process_id, take first completed task per process
    const byProcess = new Map();
    for (const t of allAppTasks) {
      if (!t.process_id) continue;
      if (!byProcess.has(t.process_id)) byProcess.set(t.process_id, t);
    }
    const firstTasks = [...byProcess.values()];
    if (firstTasks.length === 0) return { rate: null, within24: 0, total: 0, rows: [] };
    let within24 = 0;
    const rows = firstTasks.map(t => {
      const hours = (new Date(t.completed_at) - new Date(t.created_at || t.due_at)) / (1000 * 60 * 60);
      if (hours <= 24) within24++;
      return {
        process: t.process_name,
        description: t.description,
        hours: Math.round(hours * 10) / 10,
        within24: hours <= 24,
        assignee: t.assignee_name || "unassigned",
      };
    });
    return { rate: pct(within24, firstTasks.length), within24, total: firstTasks.length, rows };
  })();

  // ════════════════════════════════════════════════════════════════════════
  // WHO IS COVERING THE (UNASSIGNED) LEASING SPECIALIST WORK
  //   No one holds the LS role in LeadSimple, but the Applications + Renewal
  //   workflow tasks are still being done by someone. Surface those people so
  //   the role card shows who is actually handling the work.
  // ════════════════════════════════════════════════════════════════════════

  function assigneesForProcessTypes(processTypeIds) {
    const placeholders = processTypeIds.map(() => "?").join(",");
    const rows = query(`
      SELECT assignee_name, assignee_email, COUNT(*) AS task_count
      FROM ls_tasks
      WHERE process_type_id IN (${placeholders})
        AND assignee_name IS NOT NULL
        AND assignee_name != ''
      GROUP BY assignee_email
      ORDER BY task_count DESC
    `, processTypeIds);
    return rows.map(r => ({
      name: (r.assignee_name || "").replace(/\s+/g, " ").trim(),
      email: r.assignee_email,
      taskCount: r.task_count,
    }));
  }

  const lsCoverage = assigneesForProcessTypes([PROCESS_TYPES.APPLICATIONS, PROCESS_TYPES.RENEWAL]);
  const lsCoveredBy = lsCoverage.length
    ? lsCoverage.map(a => `${a.name} (${a.taskCount})`).join(", ")
    : null;

  // ════════════════════════════════════════════════════════════════════════
  // ASSEMBLE: roles array with KPIs and assignment status
  // ════════════════════════════════════════════════════════════════════════

  const lsKpis = {
    asOf: todayIso,
    window: "90 days",
    roles: [
      {
        abbrev: "AA",
        name: "Administrative Assistant",
        person: "Belinda Jean Dabandan",
        assigned: true,
        kpis: [
          {
            name: "Task Completion Rate",
            source: "LS", target: 95, direction: "gte", format: "pct",
            value: aaTaskCompletion.rate,
            detail: `${aaTaskCompletion.onTime} on time / ${aaTaskCompletion.total} completed`,
            drillKey: "lsTaskCompletion",
          },
          {
            name: "Workflow Compliance",
            source: "LS", target: 100, direction: "gte", format: "pct",
            value: aaWorkflowCompliance.rate,
            detail: `${aaWorkflowCompliance.compliant} compliant / ${aaWorkflowCompliance.total} processes`,
            drillKey: "lsWorkflowCompliance",
          },
          {
            name: "Resident Response Time",
            source: "LS", target: 24, direction: "lte", format: "hours",
            value: aaResponseTime.avgHours,
            detail: `${aaResponseTime.within24}/${aaResponseTime.total} within 24h`,
            drillKey: "lsResidentResponseAA",
            partial: true,
            partialNote: "LS component only -- also needs internal communication log",
          },
          {
            name: "Admin Follow-Up Support",
            source: "LS", target: 100, direction: "gte", format: "pct",
            value: aaFollowUp.rate,
            detail: `${aaFollowUp.onTime} on time / ${aaFollowUp.total} follow-up tasks`,
            drillKey: "lsFollowUpSupport",
            partial: true,
            partialNote: "LS component only -- also needs internal communication log",
          },
        ],
      },
      {
        abbrev: "APM",
        name: "Assistant Property Manager",
        person: "Addison Winter",
        assigned: true,
        kpis: [
          {
            name: "Resident Response Time",
            source: "LS", target: 24, direction: "lte", format: "hours",
            value: apmResponseTime.avgHours,
            detail: `${apmResponseTime.within24}/${apmResponseTime.total} within 24h`,
            drillKey: "lsResidentResponseAPM",
            partial: true,
            partialNote: "LS component only -- also needs internal communication log",
          },
          {
            name: "Property Readiness",
            source: "LS", target: 100, direction: "gte", format: "pct",
            value: propertyReadiness.rate,
            detail: `${propertyReadiness.onTime} on time / ${propertyReadiness.total} move-in tasks`,
            drillKey: "lsPropertyReadiness",
            partial: true,
            partialNote: "LS component only -- also needs Buildium move-in schedule",
          },
        ],
      },
      {
        abbrev: "LS",
        name: "Leasing Specialist",
        person: null,
        assigned: false,
        coveredBy: lsCoveredBy,
        coverage: lsCoverage,
        unassignedNote: lsCoveredBy
          ? `No one holds the Leasing Specialist role in LeadSimple. This work is being handled by: ${lsCoveredBy}.`
          : "No one is currently assigned to the Leasing Specialist role in LeadSimple. Tasks in these workflows are being handled by other team members.",
        kpis: [
          {
            name: "Applicant Response Timeliness",
            source: "LS+RE", target: 95, direction: "gte", format: "pct",
            value: applicantResponse.rate,
            detail: `${applicantResponse.within24}/${applicantResponse.total} within 24h (all assignees)`,
            drillKey: "lsApplicantResponse",
            partial: true,
            partialNote: "LS component only -- also needs RentEngine data",
          },
          {
            name: "Application Processing Time",
            source: "LS", target: 48, direction: "lte", format: "hours",
            value: appProcessingTime.avgHours,
            detail: `${appProcessingTime.within48}/${appProcessingTime.closedCount} within 48h (${appProcessingTime.total} total)`,
            drillKey: "lsAppProcessingTime",
          },
          {
            name: "Renewal Follow-Up Timeliness",
            source: "LS", target: 95, direction: "gte", format: "pct",
            value: renewalFollowUp.rate,
            detail: `${renewalFollowUp.onTime} on time / ${renewalFollowUp.total} renewal tasks (all assignees)`,
            drillKey: "lsRenewalFollowUp",
          },
        ],
      },
      {
        abbrev: "PM",
        name: "Portfolio Manager",
        person: "Dana Sampson",
        assigned: true,
        kpis: [
          {
            name: "Lease Renewal Rate",
            source: "LS+BD", target: 70, direction: "gte", format: "pct",
            value: renewalRate.rate,
            detail: `${renewalRate.renewed} renewed / ${renewalRate.total} decided (${renewalRate.pending} still in progress, trailing 12 mo)`,
            drillKey: "lsRenewalRate",
            partial: true,
            partialNote: "LS process outcomes -- combine with Buildium lease data for full picture",
          },
        ],
      },
    ],
  };

  // ════════════════════════════════════════════════════════════════════════
  // DRILLDOWNS
  // ════════════════════════════════════════════════════════════════════════

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "none";
  const yesNo = (v) => v ? "yes" : "no";

  const lsDrilldowns = {
    lsTaskCompletion: {
      title: "Task Completion Rate -- Administrative Assistant (90d)",
      cols: ["Task", "Process", "Due", "Completed", "On Time"],
      rows: aaTaskCompletion.rows.map(r => [
        r.description, r.process, fmtDate(r.due_at), fmtDate(r.completed_at), yesNo(r.on_time),
      ]),
      summary: `${aaTaskCompletion.rate ?? "n/a"}% on time (${aaTaskCompletion.onTime}/${aaTaskCompletion.total}) -- target >= 95%`,
      note: "Tasks assigned to Belinda (assistant@limehousepm.com) completed in the trailing 90 days. On time = completed on or before the due date's calendar day (ET).",
    },
    lsWorkflowCompliance: {
      title: "Workflow Compliance -- Administrative Assistant (90d)",
      cols: ["Process", "Type", "Tasks", "Skipped", "Late", "Incomplete", "Compliant"],
      rows: aaWorkflowCompliance.rows.map(r => [
        r.process, r.type, String(r.taskCount), String(r.skipped), String(r.late), String(r.incomplete), yesNo(r.compliant),
      ]),
      summary: `${aaWorkflowCompliance.rate ?? "n/a"}% compliant (${aaWorkflowCompliance.compliant}/${aaWorkflowCompliance.total}) -- target 100%`,
      note: "Processes with tasks assigned to Belinda. Compliant = all tasks completed on time, none skipped.",
    },
    lsResidentResponseAA: {
      title: "Resident Response Time -- Admin Assistant (90d)",
      cols: ["Task", "Kind", "Start", "Completed", "Hours", "Within 24h"],
      rows: aaResponseTime.rows.map(r => [
        r.description, r.kind, fmtDate(r.start), fmtDate(r.completed_at), String(r.hours), r.within24 == null ? "n/a" : yesNo(r.within24),
      ]),
      summary: `Avg ${aaResponseTime.avgHours ?? "n/a"} hours -- ${aaResponseTime.within24}/${aaResponseTime.total} within 24 biz hours -- target <= 24h`,
      note: "Communication tasks (emails, follow-ups, calls) assigned to Belinda. Hours measured from due_at to completed_at, adjusted for business hours (approx).",
    },
    lsResidentResponseAPM: {
      title: "Resident Response Time -- Asst. Property Manager (90d)",
      cols: ["Task", "Kind", "Start", "Completed", "Hours", "Within 24h"],
      rows: apmResponseTime.rows.map(r => [
        r.description, r.kind, fmtDate(r.start), fmtDate(r.completed_at), String(r.hours), r.within24 == null ? "n/a" : yesNo(r.within24),
      ]),
      summary: `Avg ${apmResponseTime.avgHours ?? "n/a"} hours -- ${apmResponseTime.within24}/${apmResponseTime.total} within 24 biz hours -- target <= 24h`,
      note: "Communication tasks assigned to Addison (addison@limehousepm.com).",
    },
    lsFollowUpSupport: {
      title: "Admin Follow-Up Support (90d)",
      cols: ["Task", "Process", "Due", "Completed", "On Time"],
      rows: aaFollowUp.rows.map(r => [
        r.description, r.process, fmtDate(r.due_at), fmtDate(r.completed_at), yesNo(r.on_time),
      ]),
      summary: `${aaFollowUp.rate ?? "n/a"}% on time (${aaFollowUp.onTime}/${aaFollowUp.total}) -- target 100%`,
      note: "Tasks containing 'follow up', 'check in', or 'confirm' assigned to Belinda.",
    },
    lsApplicantResponse: {
      title: "Applicant Response Timeliness (90d)",
      cols: ["Application", "First Task", "Hours to Complete", "Within 24h", "Assignee"],
      rows: applicantResponse.rows.map(r => [
        r.process, r.description, String(r.hours), yesNo(r.within24), r.assignee,
      ]),
      summary: `${applicantResponse.rate ?? "n/a"}% within 24h (${applicantResponse.within24}/${applicantResponse.total}) -- target >= 95%`,
      note: "First completed task per Applications Process. No Leasing Specialist assigned -- showing all assignees.",
    },
    lsAppProcessingTime: {
      title: "Application Processing Time (90d)",
      cols: ["Application", "Created", "Closed", "Hours", "Within 48h"],
      rows: appProcessingTime.rows.map(r => [
        r.name, fmtDate(r.created_at), fmtDate(r.closed_at), String(r.hours), yesNo(r.within48),
      ]),
      summary: `Avg ${appProcessingTime.avgHours ?? "n/a"} hours -- ${appProcessingTime.within48}/${appProcessingTime.closedCount} within 48h -- target <= 48h`,
      note: "Applications Process: created_at to closed_at. No Leasing Specialist assigned.",
    },
    lsRenewalFollowUp: {
      title: "Renewal Follow-Up Timeliness (90d)",
      cols: ["Task", "Process", "Stage", "Due", "Completed", "On Time", "Assignee"],
      rows: renewalFollowUp.rows.map(r => [
        r.description, r.process, r.stage, fmtDate(r.due_at), fmtDate(r.completed_at), yesNo(r.on_time), r.assignee,
      ]),
      summary: `${renewalFollowUp.rate ?? "n/a"}% on time (${renewalFollowUp.onTime}/${renewalFollowUp.total}) -- target >= 95%`,
      note: "Completed tasks in Lease Renewal Process. No Leasing Specialist assigned -- showing all assignees.",
    },
    lsRenewalRate: {
      title: "Lease Renewal Rate -- LS Process View (12 mo)",
      cols: ["Process", "Stage", "Status", "Created", "Closed", "Renewed"],
      rows: renewalRate.rows.map(r => [
        r.name, r.stage, r.status, fmtDate(r.created_at), r.closed_at === "open" ? "open" : fmtDate(r.closed_at), yesNo(r.renewed),
      ]),
      summary: `${renewalRate.rate ?? "n/a"}% renewed (${renewalRate.renewed}/${renewalRate.total} decided; ${renewalRate.pending} still in progress) -- target >= 70%`,
      note: "Lease Renewal Processes in trailing 12 months. Rate = renewed / decided, where 'decided' excludes still-in-progress processes (e.g. Send Lease, Upcoming). 'Renewed' = a completed Lease Renewed outcome; non-renewal outcomes (owner/tenant non-renewal, owner terminating management, owner relisting, owner selling) count as not renewed. Combine with Buildium lease data for full metric.",
    },
    lsPropertyReadiness: {
      title: "Property Readiness -- Move In Tasks (90d)",
      cols: ["Task", "Process", "Due", "Completed", "On Time", "Assignee"],
      rows: propertyReadiness.rows.map(r => [
        r.description, r.process, fmtDate(r.due_at), fmtDate(r.completed_at), yesNo(r.on_time), r.assignee,
      ]),
      summary: `${propertyReadiness.rate ?? "n/a"}% on time (${propertyReadiness.onTime}/${propertyReadiness.total}) -- target 100%`,
      note: "Tasks in Move In Process. Also needs Buildium move-in schedule for full metric.",
    },
  };

  // ════════════════════════════════════════════════════════════════════════
  // COMPANY-WIDE SUMMARY STATS (for the tab header)
  // ════════════════════════════════════════════════════════════════════════

  const totalUpcoming = queryOne("SELECT COUNT(*) as c FROM ls_tasks WHERE completed_at IS NULL AND skipped = 0")?.c || 0;
  const totalOverdue = queryOne(`
    SELECT COUNT(*) as c FROM ls_tasks
    WHERE completed_at IS NULL AND skipped = 0 AND due_at < ?
  `, [now.toISOString()])?.c || 0;
  const activeProcesses = queryOne("SELECT COUNT(*) as c FROM ls_processes WHERE closed_at IS NULL")?.c || 0;

  const lsSummary = {
    openTasks: totalUpcoming,
    overdueTasks: totalOverdue,
    activeProcesses,
    companyTaskCompletionRate: companyTaskCompletion.rate,
    companyTasksOnTime: companyTaskCompletion.onTime,
    companyTasksTotal: companyTaskCompletion.total,
  };

  return { lsKpis, lsDrilldowns, lsSummary };
}
