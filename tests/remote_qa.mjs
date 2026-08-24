import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const projectRef = process.argv[2];
assert.match(projectRef || "", /^[a-z]{20}$/, "Pass the linked Supabase project ref");
const projectUrl = `https://${projectRef}.supabase.co`;
const keys = JSON.parse(execFileSync("npx", ["--yes", "supabase", "projects", "api-keys", "--project-ref", projectRef, "--output", "json"], { encoding: "utf8" }));
const publishableKey = keys.find((key) => key.type === "publishable")?.api_key;
const serviceKey = keys.find((key) => key.id === "service_role")?.api_key;
assert.ok(publishableKey && serviceKey, "Required project keys were not returned by CLI");

const suffix = randomBytes(8).toString("hex");
const password = randomBytes(36).toString("base64url");
const emails = [`qa-a-${suffix}@example.invalid`, `qa-b-${suffix}@example.invalid`];
const userIds = [];

async function api(path, { token, admin = false, method = "GET", body, omitApiKey = false } = {}) {
  const key = admin ? serviceKey : publishableKey;
  return fetch(`${projectUrl}${path}`, {
    method,
    headers: {
      ...(!omitApiKey ? { apikey: key } : {}),
      ...(token || admin ? { Authorization: `Bearer ${token || serviceKey}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function json(response, status = 200) {
  assert.equal(response.status, status);
  return response.status === 204 ? null : response.json();
}

async function createUser(email) {
  const data = await json(await api("/auth/v1/admin/users", { admin: true, method: "POST", body: { email, password, email_confirm: true } }));
  userIds.push(data.id);
  return data.id;
}

async function token(email) {
  const data = await json(await api("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } }));
  return data.access_token;
}

const dosesA = [
  ["qa-a-0800", "08:00", "08:07", "taken"],
  ["qa-a-1100", "11:00", "11:43", "taken"],
  ["qa-a-1400", "14:00", null, "skipped"],
].map(([id, scheduled, taken, status]) => ({
  client_record_id: id,
  scheduled_at: `2026-08-24T${scheduled}:00+02:00`,
  taken_at: taken ? `2026-08-24T${taken}:00+02:00` : null,
  timezone: "Europe/Stockholm",
  medication_name: "Synthetic A",
  dose: "synthetic-unit",
  status,
  note: null,
  source_created_at: "2026-08-24T06:00:00Z",
  source_updated_at: "2026-08-24T12:00:00Z",
}));
const dosesB = [{
  client_record_id: "qa-b-0900", scheduled_at: "2026-08-24T09:00:00+02:00",
  taken_at: "2026-08-24T09:01:00+02:00", timezone: "Europe/Stockholm",
  medication_name: "Synthetic B", dose: "synthetic-unit", status: "taken", note: null,
  source_created_at: "2026-08-24T07:00:00Z", source_updated_at: "2026-08-24T07:01:00Z",
}];

try {
  await createUser(emails[0]);
  await createUser(emails[1]);
  const tokenA = await token(emails[0]);
  const tokenB = await token(emails[1]);

  await json(await api("/rest/v1/rpc/sync_dose_logs", { token: tokenA, method: "POST", body: { records: dosesA } }));
  await json(await api("/rest/v1/rpc/sync_dose_logs", { token: tokenA, method: "POST", body: { records: dosesA } }));
  await json(await api("/rest/v1/rpc/sync_dose_logs", { token: tokenB, method: "POST", body: { records: dosesB } }));
  for (const [tokenValue, id, text] of [[tokenA, "qa-a-observation", "Synthetic test observation"], [tokenB, "qa-b-observation", "Synthetic B observation"]]) {
    await json(await api("/rest/v1/rpc/sync_observations", { token: tokenValue, method: "POST", body: { records: [{
      client_record_id: id, observed_at: "2026-08-24T10:45:00+02:00", timezone: "Europe/Stockholm", text,
      category: null, severity: null, source_created_at: "2026-08-24T08:45:00Z", source_updated_at: "2026-08-24T08:45:00Z",
    }] } }));
  }

  const aDoses = await json(await api("/rest/v1/dose_logs?select=client_record_id&order=client_record_id", { token: tokenA }));
  const bDoses = await json(await api("/rest/v1/dose_logs?select=client_record_id&order=client_record_id", { token: tokenB }));
  assert.equal(aDoses.length, 3, "A sees exactly A's three idempotent rows");
  assert.equal(bDoses.length, 1, "B sees exactly B's row");
  assert.ok(aDoses.every((row) => row.client_record_id.startsWith("qa-a-")), "A cannot read B");
  assert.ok(bDoses.every((row) => row.client_record_id.startsWith("qa-b-")), "B cannot read A");

  assert.equal((await api("/functions/v1/medication-context?from=2026-08-24&to=2026-08-24")).status, 401);
  assert.equal((await api("/functions/v1/medication-context?from=2026-08-24&to=2026-08-24", { token: "invalid.synthetic.token" })).status, 401);
  const context = await json(await api("/functions/v1/medication-context?from=2026-08-24&to=2026-08-24", { token: tokenA }));
  assert.equal(context.dose_logs.length, 3);
  assert.equal(context.observations.length, 1);
  assert.ok(context.dose_logs.every((row) => row.medication_name === "Synthetic A"));
  const oauthOnlyContext = await json(await api("/functions/v1/medication-context?from=2026-08-24&to=2026-08-24", { token: tokenA, omitApiKey: true }));
  assert.equal(oauthOnlyContext.dose_logs.length, 3, "GPT API accepts OAuth Bearer token without frontend API key");

  const summary = await json(await api("/functions/v1/medication-summary?from=2026-08-24&to=2026-08-24", { token: tokenA }));
  assert.deepEqual([summary.scheduled_count, summary.taken_count, summary.skipped_count, summary.unresolved_count], [3, 2, 1, 0]);
  assert.deepEqual(summary.delay_minutes, { median: 7, average: 25, p90: 43, maximum: 43 });
  const current = await json(await api("/functions/v1/current-medications", { token: tokenA }));
  assert.equal(current.source, "Medicinkoll user log");
  assert.deepEqual(current.medications.map((item) => item.name), ["Synthetic A"]);

  let sawRateLimit = false;
  for (let requestNumber = 0; requestNumber < 65; requestNumber += 1) {
    const response = await api("/functions/v1/current-medications", { token: tokenA });
    if (response.status === 429) { sawRateLimit = true; break; }
    assert.equal(response.status, 200);
  }
  assert.ok(sawRateLimit, "API rate limit must return 429");

  await json(await api("/functions/v1/delete-account", { token: tokenA, method: "DELETE" }), 204);
  userIds.shift();
  assert.equal((await api("/functions/v1/medication-context?from=2026-08-24&to=2026-08-24", { token: tokenA })).status, 401);
  console.log("Remote synthetic QA passed");
} finally {
  for (const userId of userIds) {
    await api(`/auth/v1/admin/users/${userId}`, { admin: true, method: "DELETE" }).catch(() => {});
  }
}
