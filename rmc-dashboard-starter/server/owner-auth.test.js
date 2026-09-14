import assert from "node:assert/strict";
import test from "node:test";
import { app } from "./index.js";
import { queryOne } from "./lib/db.js";

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
    ["/api/team/config", { id: "pm_vacancy_days", active: true }],
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
  assert.equal((await request("/api/team/config", {}, `${ceoCookie}; ${ownerCookie}`)).status, 200);

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