import assert from "node:assert/strict";
import test from "node:test";
import { app } from "./index.js";
import { queryOne, run } from "./lib/db.js";

const CEO_PASSWORD = process.env.DASHBOARD_PASSWORD;
const CEO_VIEW_PASSWORD = "RTCS"; // Existing client-side CEO View credential.
assert.equal(process.env.RMC_TEST_MODE, "1", "owner HTTP tests must run in test mode");
assert.ok(CEO_PASSWORD, "test-only CEO password must be configured by the test command");

let server;
let baseUrl;

function cookie(response) {
  const value = response.headers.get("set-cookie");
  return value ? value.split(";")[0] : "";
}
function originHeaders(cookies = "") {
  return {
    Origin: baseUrl,
    ...(cookies ? { Cookie: cookies } : {}),
  };
}
async function request(path, options = {}, cookies = "") {
  const headers = { ...originHeaders(cookies), ...(options.headers || {}) };
  return fetch(baseUrl + path, { ...options, headers });
}
async function json(response) {
  return { response, body: await response.json() };
}

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

test("owner setup, separate sessions, reset, and owner API authorization", async () => {
  let result = await json(await request("/api/owner/status"));
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { setupRequired: true });

  result = await json(await request("/api/owner/setup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "short", confirmPassword: "short" }),
  }));
  assert.equal(result.response.status, 400);

  result = await json(await request("/api/owner/setup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "owner-password-A", confirmPassword: "does-not-match" }),
  }));
  assert.equal(result.response.status, 400);

  // Two concurrent first-run requests must result in exactly one credential.
  const race = await Promise.all(["owner-password-A", "owner-password-B"].map((password) =>
    request("/api/owner/setup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, confirmPassword: password }),
    })
  ));
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  const ownerPassword = race[0].status === 201 ? "owner-password-A" : "owner-password-B";
  const initialOwnerCookie = cookie(race.find((r) => r.status === 201));
  assert.match(initialOwnerCookie, /^rmc_owner=/);
  const stored = queryOne("SELECT value FROM app_state WHERE key = ?", ["owner_auth_v1"]).value;
  assert.equal(stored.includes(ownerPassword), false, "the database must not store an owner password");
  const duplicate = await request("/api/owner/setup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "another-owner-password", confirmPassword: "another-owner-password" }),
  });
  assert.equal(duplicate.status, 409);

  result = await json(await request("/api/owner/status"));
  assert.deepEqual(result.body, { setupRequired: false });

  result = await json(await request("/api/owner/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong-owner-password" }),
  }));
  assert.equal(result.response.status, 401);

  const loginResponse = await request("/api/owner/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  assert.equal(loginResponse.status, 200);
  const ownerCookie = cookie(loginResponse);
  assert.match(ownerCookie, /^rmc_owner=/);

  // A dashboard/CEO session alone must not expose scores, questions, answers,
  // settings, or calculated bonus APIs.
  const ceoLogin = await request("/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: CEO_PASSWORD }),
  });
  assert.equal(ceoLogin.status, 200);
  const ceoCookie = cookie(ceoLogin);
  result = await json(await request("/api/owner/session", {}, ceoCookie));
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { owner: false }, "CEO access must not be reported as owner access");
  result = await json(await request("/api/labor-adjustments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ period: "2026-07", tech: "Scott Scott", pto_hours: 64, extra_hours: 0 }),
  }, ceoCookie));
  assert.equal(result.response.status, 403);
  assert.deepEqual(result.body, { error: "Owner sign-in required" });
  for (const path of [
    "/api/team",
    "/api/team/drilldown/team_pm_owner_insurance",
    "/api/labor-adjustments?period=2026-07",
    "/api/team/config",
    "/api/owner/historical-adjustments",
    "/api/owner/scorecard?quarter=2026-Q3",
  ]) {
    const response = await request(path, {}, ceoCookie);
    assert.equal(response.status, 403, `${path} must require an owner session`);
  }
  for (const [path, body] of [
    ["/api/owner/settings", {}],
    ["/api/labor-adjustments", { period: "2026-07", tech: "Test", pto_hours: 0, extra_hours: 0 }],
    ["/api/owner/scorecard", { quarter: "2026-Q3", employee_id: "john", answers: [] }],
    ["/api/team/config", { id: "pm_vacancy_days", property_group_override: "group:http-contract" }],
    ["/api/team/property-group-label", { group_id: "group:http-contract", display_name: "Quality Turns" }],
    ["/api/team/override", { quarter: "2026-Q3", employee: "Bong", scheduled_hours: 160 }],
    ["/api/team/snapshot", { quarter: "2026-Q3" }],
  ]) {
    const response = await request(path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, ceoCookie);
    assert.equal(response.status, 403, `${path} must require an owner session`);
  }

  // Owner access is additive: a dashboard session never becomes an owner
  // session, and the owner cookie is required alongside the normal gate.
  const authorizedCookies = `${ceoCookie}; ${ownerCookie}`;
  assert.equal((await request("/api/team/config", {}, authorizedCookies)).status, 200);
  result = await json(await request("/api/owner/session", {}, authorizedCookies));
  assert.deepEqual(result.body, { owner: true });

  // Item 3 contract: a discovered AppFolio group can be assigned per KPI,
  // cleared back to global inheritance, and given an owner-managed display name.
  const groupId = "group:http-contract";
  run("INSERT INTO property_groups (id, label, source_field, synced_at) VALUES (?, ?, ?, ?)",
    [groupId, "AppFolio group HTTP contract", "property_group_id", new Date().toISOString()]);

  result = await json(await request("/api/team/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "pm_vacancy_days", property_group_override: groupId }),
  }, authorizedCookies));
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { ok: true });

  result = await json(await request("/api/team/config", {}, authorizedCookies));
  let vacancyConfig = result.body.configs.find((config) => config.id === "pm_vacancy_days");
  assert.equal(vacancyConfig.property_group_override, groupId);

  result = await json(await request("/api/team/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "pm_vacancy_days", property_group_override: null }),
  }, authorizedCookies));
  assert.equal(result.response.status, 200);
  result = await json(await request("/api/team/config", {}, authorizedCookies));
  vacancyConfig = result.body.configs.find((config) => config.id === "pm_vacancy_days");
  assert.equal(vacancyConfig.property_group_override, null);

  const beforeRejectedUpdate = {
    active: vacancyConfig.active,
    tiers: vacancyConfig.tiers,
    property_group_override: vacancyConfig.property_group_override,
  };
  result = await json(await request("/api/team/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "pm_vacancy_days",
      property_group_override: "group:not-discovered",
      active: !Boolean(vacancyConfig.active),
      tiers: {
        good: { threshold: null, payout: 123 },
        better: { threshold: null, payout: 123 },
        best: { threshold: null, payout: 123 },
      },
    }),
  }, authorizedCookies));
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /not discovered/i);
  result = await json(await request("/api/team/config", {}, authorizedCookies));
  vacancyConfig = result.body.configs.find((config) => config.id === "pm_vacancy_days");
  assert.deepEqual({
    active: vacancyConfig.active,
    tiers: vacancyConfig.tiers,
    property_group_override: vacancyConfig.property_group_override,
  }, beforeRejectedUpdate, "unknown group validation must happen before tiers or active are changed");

  result = await json(await request("/api/team/property-group-label", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_id: groupId, display_name: "Quality Turns" }),
  }, authorizedCookies));
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { ok: true });

  result = await json(await request("/api/owner/settings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bonus_eligible_property_group: groupId }),
  }, authorizedCookies));
  assert.equal(result.response.status, 200);
  assert.equal(result.body.settings.bonus_eligible_property_group, groupId);

  // This directory endpoint requires only the normal dashboard session, not
  // the separate Owner cookie, and exposes both the friendly and raw labels.
  result = await json(await request("/api/property-groups", {}, ceoCookie));
  assert.equal(result.response.status, 200);
  const displayedGroup = result.body.groups.find((group) => group.id === groupId);
  assert.deepEqual(displayedGroup, {
    id: groupId,
    appfolio_id: "http-contract",
    raw_label: "AppFolio group HTTP contract",
    source_field: "property_group_id",
    label: "Quality Turns",
  });

  result = await json(await request("/api/labor-adjustments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ period: "2026-07", tech: "Scott Scott", pto_hours: 745, extra_hours: 0 }),
  }, authorizedCookies));
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error, "PTO / Sick hours for Scott Scott must be between 0 and 744.");

  result = await json(await request("/api/owner/settings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quarterly_incentive: -1 }),
  }, authorizedCookies));
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error, "Quarterly incentive must be a non-negative number.");

  result = await json(await request("/api/owner/reset", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ceoPassword: CEO_VIEW_PASSWORD, confirmReset: false }),
  }));
  assert.equal(result.response.status, 400);
  result = await json(await request("/api/owner/reset", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ceoPassword: "wrong-ceo-password", confirmReset: true }),
  }));
  assert.equal(result.response.status, 401);
  result = await json(await request("/api/owner/reset", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ceoPassword: CEO_VIEW_PASSWORD, confirmReset: true }),
  }));
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { ok: true, setupRequired: true });
  assert.deepEqual((await (await request("/api/owner/status")).json()), { setupRequired: true });

  // Reset invalidates every old owner cookie, and a fresh setup gets a new
  // generation rather than reviving any previously issued session.
  const oldCookies = `${ceoCookie}; ${initialOwnerCookie}`;
  assert.equal((await request("/api/team/config", {}, oldCookies)).status, 403);
  const newPassword = "owner-password-new";
  const newSetup = await request("/api/owner/setup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: newPassword, confirmPassword: newPassword }),
  });
  assert.equal(newSetup.status, 201);
  const newOwnerCookie = cookie(newSetup);
  assert.equal((await request("/api/team/config", {}, `${ceoCookie}; ${newOwnerCookie}`)).status, 200);
  assert.deepEqual((await (await request("/api/owner/status")).json()), { setupRequired: false });
});