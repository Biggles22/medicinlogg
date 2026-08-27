import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const values = new Map();
const window = {
  MEDICINKOLL_CONFIG: {}, MEDICINKOLL_TEST: true,
  addEventListener() {}, dispatchEvent() {},
};
const document = { addEventListener() {}, querySelector() { return null; }, hidden: false };
const localStorage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, value); },
  removeItem(key) { values.delete(key); },
};
vm.runInNewContext(readFileSync("cloud-sync.js", "utf8"), {
  window, document, localStorage, navigator: { onLine: false }, Intl, Date, Map, Set,
  JSON, URL, URLSearchParams, crypto, clearTimeout, setTimeout, CustomEvent: class {},
});

const { mergeById, remoteDose, remoteObservation, itemFingerprint } = window.medicinkollCloudTest;
const plain = (value) => JSON.parse(JSON.stringify(value));
const old = { id: "same", medicine: "Old", updatedAt: "2026-08-27T08:00:00Z" };
const newer = { id: "same", medicine: "New", updatedAt: "2026-08-27T09:00:00Z" };
assert.deepEqual(plain(mergeById([old], [newer], new Set())), [newer], "newer remote edit wins");
assert.deepEqual(plain(mergeById([newer], [old], new Set())), [newer], "older remote edit cannot overwrite local");
assert.deepEqual(plain(mergeById([newer], [], new Set(["same"]))), [], "tombstone removes a stale local record");
assert.equal(itemFingerprint({ ...newer, updatedAt: "2099-01-01", createdAt: "2000-01-01" }), itemFingerprint(newer), "timestamps do not make unchanged content dirty");

const dose = remoteDose({
  client_record_id: "dose-1", scheduled_at: "2026-08-27T06:12:00Z", taken_at: "2026-08-27T06:15:00Z",
  medication_name: "Test", dose: "1 mg", status: "taken", note: null,
  source_created_at: "2026-08-27T06:00:00Z", source_updated_at: "2026-08-27T06:16:00Z",
});
assert.deepEqual({ date: dose.date, time: dose.time, takenTime: dose.takenTime }, { date: "2026-08-27", time: "08:12", takenTime: "08:15" });
const observation = remoteObservation({
  client_record_id: "obs-1", observed_at: "2026-01-15T07:30:00Z", text: "Test",
  category: null, severity: null, source_created_at: "2026-01-15T07:30:00Z", source_updated_at: "2026-01-15T07:30:00Z",
});
assert.deepEqual({ date: observation.date, time: observation.time }, { date: "2026-01-15", time: "08:30" });
console.log("Two-way merge checks passed");
