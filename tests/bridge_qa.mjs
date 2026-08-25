import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const projectRef = process.argv[2];
const bridgeSecret = process.env.GPT_BRIDGE_TEST_SECRET;
assert.match(projectRef || "", /^[a-z]{20}$/);
assert.ok(bridgeSecret, "GPT_BRIDGE_TEST_SECRET is required");
const projectUrl = `https://${projectRef}.supabase.co`;
const clientId = "960f3173-7833-44c7-9c49-a54f337bcf07";
const redirectUri = "https://chatgpt.com/aip/g-773c0f67ee8cfb6c55c147b4d4a910a8715e058f/oauth/callback";
const keys = JSON.parse(execFileSync("npx", ["--yes", "supabase", "projects", "api-keys", "--project-ref", projectRef, "--output", "json"], { encoding: "utf8" }));
const publishableKey = keys.find((key) => key.type === "publishable")?.api_key;
const serviceKey = keys.find((key) => key.id === "service_role")?.api_key;
assert.ok(publishableKey && serviceKey);

const suffix = randomBytes(8).toString("hex");
const email = `qa-bridge-${suffix}@example.invalid`;
const password = randomBytes(36).toString("base64url");
let userId;

async function request(path, { method = "GET", headers = {}, body, redirect = "follow" } = {}) {
  return fetch(`${projectUrl}${path}`, { method, headers, body, redirect });
}

async function json(response, expected = 200) {
  assert.equal(response.status, expected);
  return expected === 204 ? null : response.json();
}

function basic(secret = bridgeSecret) {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
}

try {
  const created = await json(await request("/auth/v1/admin/users", {
    method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  }));
  userId = created.id;
  const signedIn = await json(await request("/auth/v1/token?grant_type=password", {
    method: "POST", headers: { apikey: publishableKey, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  }));
  const userToken = signedIn.access_token;
  await json(await request("/rest/v1/rpc/sync_dose_logs", {
    method: "POST", headers: { apikey: publishableKey, Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{
      client_record_id: "qa-bridge-dose", scheduled_at: "2026-08-25T08:00:00+02:00",
      taken_at: "2026-08-25T08:07:00+02:00", timezone: "Europe/Stockholm",
      medication_name: "Synthetic Bridge", dose: "synthetic-unit", status: "taken", note: null,
      source_created_at: "2026-08-25T06:00:00Z", source_updated_at: "2026-08-25T06:07:00Z",
    }] }),
  }));

  const authorizeUrl = new URL(`${projectUrl}/functions/v1/oauth-authorize`);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "openid email", state: "synthetic-bridge-state" })) authorizeUrl.searchParams.set(key, value);
  const authorize = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorize.status, 302, "Bridge accepts GPT flow without PKCE");
  const consentLocation = new URL(authorize.headers.get("location"));
  assert.equal(consentLocation.origin, "https://biggles22.github.io");
  const authorizationId = consentLocation.searchParams.get("bridge_authorization_id");
  assert.match(authorizationId || "", /^mk_auth_/);

  const consentHeaders = { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" };
  const details = await json(await request(`/functions/v1/oauth-consent?authorization_id=${encodeURIComponent(authorizationId)}`, { headers: consentHeaders }));
  assert.equal(details.client.name, "PS Medicinkoll");
  assert.equal(details.scope, "openid email");
  const approval = await json(await request("/functions/v1/oauth-consent", {
    method: "POST", headers: consentHeaders, body: JSON.stringify({ authorization_id: authorizationId, action: "approve" }),
  }));
  const callback = new URL(approval.redirect_url);
  assert.equal(callback.origin, "https://chatgpt.com");
  assert.equal(callback.searchParams.get("state"), "synthetic-bridge-state");
  const code = callback.searchParams.get("code");
  assert.match(code || "", /^mk_code_/);

  const tokenBody = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  assert.equal((await request("/functions/v1/oauth-token", { method: "POST", headers: { Authorization: basic("wrong-secret"), "Content-Type": "application/x-www-form-urlencoded" }, body: tokenBody })).status, 401);
  const tokens = await json(await request("/functions/v1/oauth-token", {
    method: "POST", headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" }, body: tokenBody,
  }));
  assert.match(tokens.access_token, /^mk_at_/);
  assert.match(tokens.refresh_token, /^mk_rt_/);
  assert.equal((await request("/functions/v1/oauth-token", { method: "POST", headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" }, body: tokenBody })).status, 400, "Authorization code is single-use");

  const contextPath = "/functions/v1/medication-context?from=2026-08-25&to=2026-08-25";
  const context = await json(await request(contextPath, { headers: { Authorization: `Bearer ${tokens.access_token}` } }));
  assert.equal(context.dose_logs.length, 1);
  assert.equal(context.dose_logs[0].medication_name, "Synthetic Bridge");

  const refreshed = await json(await request("/functions/v1/oauth-token", {
    method: "POST", headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
  }));
  assert.notEqual(refreshed.access_token, tokens.access_token);
  assert.equal((await request(contextPath, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401, "Old access token invalid after rotation");
  assert.equal((await request(contextPath, { headers: { Authorization: `Bearer ${refreshed.access_token}` } })).status, 200);

  await json(await request("/functions/v1/oauth-revoke", { method: "POST", headers: consentHeaders, body: "{}" }));
  assert.equal((await request(contextPath, { headers: { Authorization: `Bearer ${refreshed.access_token}` } })).status, 401);
  assert.equal((await request("/functions/v1/oauth-token", {
    method: "POST", headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token }),
  })).status, 400);
  console.log("OAuth bridge synthetic QA passed");
} finally {
  if (userId) {
    await request(`/auth/v1/admin/users/${userId}`, { method: "DELETE", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }).catch(() => {});
  }
}
