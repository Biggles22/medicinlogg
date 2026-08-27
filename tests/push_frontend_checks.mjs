import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const window = {
  MEDICINKOLL_CONFIG: { vapidPublicKey: "synthetic-public-key" },
  MEDICINKOLL_TEST: true,
  PushManager: class {},
  Notification: {
    permission: "denied",
    async requestPermission() { return "denied"; },
  },
  medicinkollCloud: {
    getSession() { return { access_token: "synthetic" }; },
    localTimestamp(date, time) { return new Date(`${date}T${time}:00+02:00`).toISOString(); },
  },
  addEventListener() {},
};
const document = { addEventListener() {}, getElementById() { return null; } };
const localStorage = { getItem() { return null; } };
const navigator = {
  onLine: false,
  userAgent: "Synthetic offline PWA",
  serviceWorker: { ready: Promise.resolve({ pushManager: {} }) },
};
vm.runInNewContext(readFileSync("push-notifications.js", "utf8"), {
  window, document, localStorage, navigator, Notification: window.Notification,
  Date, JSON, Uint8Array, atob, setInterval() {},
});

const { nextPlannedSlot, urlBase64ToUint8Array } = window.medicinkollPushTest;
assert.ok(urlBase64ToUint8Array("AQID").every((value, index) => value === index + 1));
const state = { entries: [
  { id: "taken-late", date: "2026-08-27", time: "20:10", takenTime: "20:12", status: "taken" },
  { id: "next-planned", date: "2026-08-27", time: "23:10", status: "planned" },
] };
assert.equal(nextPlannedSlot(new Date("2026-08-27T18:15:00Z"), state).id, "next-planned", "actual intake does not move the next planned slot");
await assert.rejects(window.medicinkollPush.enable(), /blockerade/, "permission denied is handled after a user action");

const serviceWorker = readFileSync("sw.js", "utf8");
assert.match(serviceWorker, /addEventListener\("push"/);
assert.match(serviceWorker, /addEventListener\("notificationclick"/);
assert.match(serviceWorker, /Planerad medicinering om 5 minuter/);
assert.doesNotMatch(serviceWorker, /medication_name|dose_logs/, "notification content contains no medication details");
const cloudSync = readFileSync("cloud-sync.js", "utf8");
assert.match(cloudSync, /disableCurrentSubscription\(false\)/, "logout disables only the current device subscription");
console.log("Web Push frontend checks passed");
