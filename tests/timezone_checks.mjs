import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const values = new Map();
const localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
const sandbox = {
  window: { MEDICINKOLL_CONFIG: {}, addEventListener() {} },
  document: { addEventListener() {}, querySelector() { return null; }, hidden: false },
  navigator: { onLine: false }, localStorage, history: {}, location: {}, crypto: globalThis.crypto,
  Intl, Date, URLSearchParams, URL, Map, Set, JSON, RegExp, Number, Object, String, Boolean,
  setTimeout() {}, clearTimeout() {}, fetch() { throw new Error("unexpected fetch"); }, console,
};
vm.runInNewContext(readFileSync("cloud-sync.js", "utf8"), sandbox);
const timestamp = sandbox.window.medicinkollCloud.localTimestamp;
assert.equal(timestamp("2026-01-15", "08:00"), "2026-01-15T07:00:00.000Z", "CET conversion");
assert.equal(timestamp("2026-07-15", "08:00"), "2026-07-15T06:00:00.000Z", "CEST conversion");
assert.equal(timestamp("2026-03-29", "01:30"), "2026-03-29T00:30:00.000Z", "before DST switch");
assert.equal(timestamp("2026-03-29", "03:30"), "2026-03-29T01:30:00.000Z", "after DST switch");
console.log("Timezone checks passed");
