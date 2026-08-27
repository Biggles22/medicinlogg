import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const projectRef = process.argv[2];
assert.match(projectRef || "", /^[a-z]{20}$/, "Pass the linked Supabase project ref");
const projectUrl = `https://${projectRef}.supabase.co`;
const keys = JSON.parse(execFileSync("npx", ["--yes", "supabase", "projects", "api-keys", "--project-ref", projectRef, "--output", "json"], { encoding: "utf8" }));
const publishableKey = keys.find((key) => key.type === "publishable")?.api_key;
const serviceKey = keys.find((key) => key.id === "service_role")?.api_key;
assert.ok(publishableKey && serviceKey);

const suffix = randomBytes(8).toString("hex");
const password = randomBytes(36).toString("base64url");
const emails = [`push-a-${suffix}@example.invalid`, `push-b-${suffix}@example.invalid`];
const userIds = [];

async function api(path, { token, admin = false, method = "GET", body } = {}) {
  const key = admin ? serviceKey : publishableKey;
  return fetch(`${projectUrl}${path}`, {
    method,
    headers: {
      apikey: key,
      ...(token || admin ? { Authorization: `Bearer ${token || serviceKey}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function json(response, status = 200) {
  const errorText = response.status === status ? "" : await response.clone().text();
  assert.equal(response.status, status, errorText);
  return response.status === 204 ? null : response.json();
}

async function createUser(email) {
  const data = await json(await api("/auth/v1/admin/users", { admin: true, method: "POST", body: { email, password, email_confirm: true } }));
  userIds.push(data.id);
  return data.id;
}

async function token(email) {
  return (await json(await api("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } }))).access_token;
}

function dose(id, scheduled, status = "planned", taken = null) {
  return {
    client_record_id: id, scheduled_at: scheduled, taken_at: taken,
    timezone: "Europe/Stockholm", medication_name: "Synthetic", dose: "synthetic-unit",
    status, note: null, display_order: 1,
    source_created_at: "2026-08-27T17:00:00Z", source_updated_at: "2026-08-27T17:01:00Z",
  };
}

async function register(tokenValue, endpoint) {
  return json(await api("/rest/v1/rpc/register_push_subscription", { token: tokenValue, method: "POST", body: {
    subscription_endpoint: endpoint,
    subscription_p256dh: "synthetic-p256dh-key-material-000000000000000000000000000000000000",
    subscription_auth: "synthetic-auth-key-000000000000",
    subscription_user_agent: "Synthetic QA",
  } }));
}

try {
  const userA = await createUser(emails[0]);
  const userB = await createUser(emails[1]);
  const tokenA = await token(emails[0]);
  const tokenB = await token(emails[1]);
  const endpointA1 = `https://push.example.invalid/${suffix}/a1`;
  const endpointA2 = `https://push.example.invalid/${suffix}/a2`;
  const endpointB = `https://push.example.invalid/${suffix}/b1`;
  await register(tokenA, endpointA1);
  await register(tokenA, endpointA2);
  await register(tokenB, endpointB);
  await json(await api("/rest/v1/rpc/set_notification_preferences", { token: tokenA, method: "POST", body: { preferences_enabled: true } }));
  await json(await api("/rest/v1/rpc/set_notification_preferences", { token: tokenB, method: "POST", body: { preferences_enabled: true } }));

  const rowsA = [
    dose("push-a-slot-med-1", "2026-08-27T20:10:00+02:00"),
    dose("push-a-slot-med-2", "2026-08-27T20:10:00+02:00"),
    dose("push-a-already-taken", "2026-08-27T21:10:00+02:00", "taken", "2026-08-27T21:02:00+02:00"),
    dose("push-a-taken-late", "2026-08-27T17:10:00+02:00", "taken", "2026-08-27T17:12:00+02:00"),
    dose("push-a-next-after-late", "2026-08-27T23:10:00+02:00"),
    dose("push-a-missed", "2026-08-27T14:10:00+02:00", "skipped"),
  ];
  const rowsB = [dose("push-b-slot", "2026-08-27T20:10:00+02:00")];
  await json(await api("/rest/v1/rpc/sync_dose_logs", { token: tokenA, method: "POST", body: { records: rowsA } }));
  await json(await api("/rest/v1/rpc/sync_dose_logs", { token: tokenB, method: "POST", body: { records: rowsB } }));

  const scheduleA = await json(await api("/rest/v1/dose_logs?select=client_record_id,scheduled_at,taken_at,status&order=scheduled_at", { token: tokenA }));
  assert.equal(scheduleA.find((row) => row.client_record_id === "push-a-taken-late").taken_at, "2026-08-27T15:12:00+00:00");
  assert.equal(scheduleA.find((row) => row.client_record_id === "push-a-next-after-late").scheduled_at, "2026-08-27T21:10:00+00:00", "late actual intake does not move next planned dose");
  assert.equal(scheduleA.find((row) => row.client_record_id === "push-a-missed").status, "skipped", "missed dose does not alter another schedule row");

  const referenceTime = "2026-08-27T18:05:30Z";
  await json(await api("/rest/v1/rpc/enqueue_due_medication_reminders", { admin: true, method: "POST", body: { reference_time: referenceTime } }));
  await json(await api("/rest/v1/rpc/enqueue_due_medication_reminders", { admin: true, method: "POST", body: { reference_time: referenceTime } }));
  const deliveriesA = await json(await api(`/rest/v1/notification_deliveries?select=id,user_id,planned_dose_id,subscription_id,reminder_at,status&user_id=eq.${userA}`, { admin: true }));
  const deliveriesB = await json(await api(`/rest/v1/notification_deliveries?select=id,user_id,planned_dose_id,subscription_id,reminder_at,status&user_id=eq.${userB}`, { admin: true }));
  assert.equal(deliveriesA.length, 2, "duplicate schedule rows produce one delivery per device");
  assert.equal(deliveriesB.length, 1, "second user gets only their device delivery");
  assert.ok(deliveriesA.every((row) => row.reminder_at === "2026-08-27T18:05:00+00:00"), "20:10 CEST produces a 20:05 CEST reminder");
  assert.ok([401, 403].includes((await api("/rest/v1/notification_deliveries?select=id", { token: tokenA })).status), "delivery outbox is server-only");
  assert.equal((await json(await api("/rest/v1/push_subscriptions?select=endpoint", { token: tokenA }))).length, 2);
  assert.equal((await json(await api("/rest/v1/push_subscriptions?select=endpoint", { token: tokenB }))).length, 1);

  const firstClaim = await json(await api("/rest/v1/rpc/claim_due_notification_deliveries", { admin: true, method: "POST", body: { reference_time: referenceTime, batch_size: 100 } }));
  const secondClaim = await json(await api("/rest/v1/rpc/claim_due_notification_deliveries", { admin: true, method: "POST", body: { reference_time: referenceTime, batch_size: 100 } }));
  assert.equal(firstClaim.length, 3);
  assert.equal(secondClaim.length, 0, "parallel/double cron cannot claim the same deliveries twice");

  const permanent = firstClaim.find((row) => row.endpoint === endpointA1);
  const temporary = firstClaim.find((row) => row.endpoint === endpointA2);
  await json(await api("/rest/v1/rpc/complete_notification_delivery", { admin: true, method: "POST", body: {
    target_delivery_id: permanent.delivery_id, delivery_succeeded: false, permanent_failure: true,
    error_code: "push_http_410", reference_time: referenceTime,
  } }));
  await json(await api("/rest/v1/rpc/complete_notification_delivery", { admin: true, method: "POST", body: {
    target_delivery_id: temporary.delivery_id, delivery_succeeded: false, permanent_failure: false,
    error_code: "push_http_503", reference_time: referenceTime,
  } }));
  const subscriptionsA = await json(await api(`/rest/v1/push_subscriptions?select=endpoint,disabled_at&user_id=eq.${userA}&order=endpoint`, { admin: true }));
  assert.ok(subscriptionsA.find((row) => row.endpoint === endpointA1).disabled_at, "410 disables the invalid endpoint");
  assert.equal(subscriptionsA.find((row) => row.endpoint === endpointA2).disabled_at, null, "temporary failure keeps subscription active");
  const temporaryDelivery = await json(await api(`/rest/v1/notification_deliveries?select=status,next_attempt_at,last_error_code&id=eq.${temporary.delivery_id}`, { admin: true }));
  assert.equal(temporaryDelivery[0].status, "failed");
  assert.ok(temporaryDelivery[0].next_attempt_at, "temporary failure is scheduled for retry");

  console.log("Web Push synthetic QA passed");
} finally {
  for (const userId of userIds) await api(`/auth/v1/admin/users/${userId}`, { admin: true, method: "DELETE" }).catch(() => {});
}
