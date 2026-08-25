(function () {
  "use strict";

  const config = window.MEDICINKOLL_CONFIG || {};
  const syncKey = "medicinlogg.sync.v1";
  const stateKey = "medicinlogg.v2";
  const timezone = "Europe/Stockholm";
  const configured = /^https:\/\/[^/]+\.supabase\.co$/.test(config.supabaseUrl || "") && Boolean(config.supabaseAnonKey);
  let session = null;
  let syncing = false;
  let retryTimer = null;

  const syncState = loadSyncState();

  function loadSyncState() {
    try {
      return { pending: true, migrated: false, deletedDoses: [], deletedObservations: [], ...JSON.parse(localStorage.getItem(syncKey)) };
    } catch (_) {
      return { pending: true, migrated: false, deletedDoses: [], deletedObservations: [] };
    }
  }

  function saveSyncState() {
    localStorage.setItem(syncKey, JSON.stringify(syncState));
    renderStatus();
  }

  function headers(extra) {
    return {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async function request(path, options) {
    const response = await fetch(`${config.supabaseUrl}${path}`, { ...options, headers: headers(options?.headers) });
    if (response.status === 401) {
      session = null;
      localStorage.removeItem("medicinlogg.session.v1");
      renderStatus();
    }
    if (!response.ok) throw new Error(`request_failed_${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  function localTimestamp(date, time) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const clock = /^(\d{2}):(\d{2})$/.exec(time);
    if (!match || !clock) throw new Error("invalid_local_timestamp");
    const desiredUtc = Date.UTC(+match[1], +match[2] - 1, +match[3], +clock[1], +clock[2]);
    let guess = desiredUtc;
    const formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    for (let i = 0; i < 2; i += 1) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
      const represented = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
      guess -= represented - desiredUtc;
    }
    const value = new Date(guess);
    if (Number.isNaN(value.getTime())) throw new Error("invalid_local_timestamp");
    return value.toISOString();
  }

  function normalizeState(rawState) {
    const now = new Date().toISOString();
    let changed = false;
    for (const item of [...(rawState.entries || []), ...(rawState.observations || [])]) {
      if (!item.id) { item.id = crypto.randomUUID(); changed = true; }
      if (!item.createdAt) { item.createdAt = now; changed = true; }
      if (!item.updatedAt) { item.updatedAt = item.createdAt; changed = true; }
    }
    if (changed) localStorage.setItem(stateKey, JSON.stringify(rawState));
    return rawState;
  }

  function payloads(rawState) {
    const current = normalizeState(rawState);
    return {
      doses: (current.entries || []).map((entry) => ({
        client_record_id: entry.id,
        scheduled_at: localTimestamp(entry.date, entry.time),
        taken_at: entry.status === "taken" ? localTimestamp(entry.date, entry.takenTime || entry.time) : null,
        timezone,
        medication_name: entry.medicine,
        dose: entry.dose || "",
        status: entry.status,
        note: entry.note || null,
        source_created_at: entry.createdAt,
        source_updated_at: entry.updatedAt,
      })),
      observations: (current.observations || []).map((item) => ({
        client_record_id: item.id,
        observed_at: localTimestamp(item.date, item.time),
        timezone,
        text: item.text,
        category: item.category || null,
        severity: Number.isInteger(item.severity) ? item.severity : null,
        source_created_at: item.createdAt,
        source_updated_at: item.updatedAt,
      })),
    };
  }

  async function sync() {
    if (!configured || !session || syncing || !navigator.onLine) return;
    syncing = true;
    renderStatus("Synkar…");
    try {
      const state = JSON.parse(localStorage.getItem(stateKey) || "{}");
      const data = payloads(state);
      for (const id of syncState.deletedDoses || []) {
        await request(`/rest/v1/dose_logs?client_record_id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      }
      for (const id of syncState.deletedObservations || []) {
        await request(`/rest/v1/observations?client_record_id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      }
      for (let offset = 0; offset < data.doses.length; offset += 100) {
        await request("/rest/v1/rpc/sync_dose_logs", { method: "POST", body: JSON.stringify({ records: data.doses.slice(offset, offset + 100) }) });
      }
      for (let offset = 0; offset < data.observations.length; offset += 100) {
        await request("/rest/v1/rpc/sync_observations", { method: "POST", body: JSON.stringify({ records: data.observations.slice(offset, offset + 100) }) });
      }
      const [doseCount, observationCount] = await Promise.all([
        request("/rest/v1/dose_logs?select=id", { method: "GET", headers: { Prefer: "count=exact", Range: "0-0" } }),
        request("/rest/v1/observations?select=id", { method: "GET", headers: { Prefer: "count=exact", Range: "0-0" } }),
      ]);
      // Queries above also prove that the JWT/RLS path works. Exact migration
      // verification is performed by matching stable client IDs on first sync.
      if (!syncState.migrated) {
        const [doseIds, observationIds] = await Promise.all([
          request("/rest/v1/dose_logs?select=client_record_id", { method: "GET" }),
          request("/rest/v1/observations?select=client_record_id", { method: "GET" }),
        ]);
        const doseSet = new Set(doseIds.map((row) => row.client_record_id));
        const observationSet = new Set(observationIds.map((row) => row.client_record_id));
        syncState.migrated = data.doses.every((row) => doseSet.has(row.client_record_id))
          && data.observations.every((row) => observationSet.has(row.client_record_id));
      }
      void doseCount; void observationCount;
      syncState.pending = false;
      syncState.deletedDoses = [];
      syncState.deletedObservations = [];
      syncState.lastSyncedAt = new Date().toISOString();
      delete syncState.lastError;
      saveSyncState();
    } catch (error) {
      syncState.pending = true;
      syncState.lastError = error.message;
      saveSyncState();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(sync, 30_000);
    } finally {
      syncing = false;
      renderStatus();
    }
  }

  function queueSync(rawState) {
    const now = new Date().toISOString();
    for (const item of [...(rawState.entries || []), ...(rawState.observations || [])]) {
      item.updatedAt = now;
    }
    localStorage.setItem(stateKey, JSON.stringify(rawState));
    syncState.pending = true;
    saveSyncState();
    sync();
  }

  function queueDelete(type, id) {
    const key = type === "dose" ? "deletedDoses" : "deletedObservations";
    syncState[key] = [...new Set([...(syncState[key] || []), id])];
    syncState.pending = true;
    saveSyncState();
    // The caller removes the item locally and then calls queueSync(). Starting
    // here would race with that save and could upsert the just-deleted record.
  }

  function sessionStorageKey() { return "medicinlogg.session.v1"; }

  async function signIn(email) {
    if (!configured) throw new Error("missing_configuration");
    const response = await fetch(`${config.supabaseUrl}/auth/v1/otp`, {
      method: "POST",
      headers: { apikey: config.supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: true, redirect_to: location.origin + location.pathname + location.search }),
    });
    if (!response.ok) throw new Error("sign_in_failed");
  }

  async function consumeAuthCallback() {
    if (!configured) return;
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.get("access_token")) {
      session = {
        access_token: hash.get("access_token"),
        refresh_token: hash.get("refresh_token"),
        expires_at: Math.floor(Date.now() / 1000) + Number(hash.get("expires_in") || 3600),
      };
      localStorage.setItem(sessionStorageKey(), JSON.stringify(session));
      history.replaceState(null, "", location.pathname + location.search);
    } else {
      try { session = JSON.parse(localStorage.getItem(sessionStorageKey())); } catch (_) { session = null; }
    }
    if (session?.expires_at <= Math.floor(Date.now() / 1000) + 60 && session.refresh_token) {
      const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST", headers: { apikey: config.supabaseAnonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (response.ok) {
        const refreshed = await response.json();
        session = { ...refreshed, expires_at: Math.floor(Date.now() / 1000) + refreshed.expires_in };
        localStorage.setItem(sessionStorageKey(), JSON.stringify(session));
      } else session = null;
    }
    renderStatus();
    const next = new URLSearchParams(location.search).get("next") || localStorage.getItem("medicinlogg.oauth.next.v1");
    if (session && next) {
      const destination = new URL(next, location.origin);
      const appBase = new URL("./", location.origin + location.pathname).pathname;
      if (destination.origin === location.origin && destination.pathname.startsWith(appBase)) {
        localStorage.removeItem("medicinlogg.oauth.next.v1");
        location.replace(destination.pathname + destination.search);
        return;
      }
    }
    sync();
  }

  async function signOut() {
    if (session) await fetch(`${config.supabaseUrl}/auth/v1/logout`, { method: "POST", headers: headers() }).catch(() => {});
    session = null;
    localStorage.removeItem(sessionStorageKey());
    renderStatus();
  }

  async function deleteAccount() {
    if (!session) throw new Error("authentication_required");
    await request("/functions/v1/delete-account", { method: "DELETE" });
    session = null;
    localStorage.removeItem(sessionStorageKey());
    localStorage.removeItem(syncKey);
    renderStatus();
  }

  async function disconnectGpt() {
    if (!session) throw new Error("authentication_required");
    await request("/functions/v1/oauth-revoke", { method: "POST", body: "{}" });
  }

  function renderStatus(custom) {
    const root = document.querySelector("#cloudStatus");
    if (!root) return;
    if (!configured) root.textContent = "Molnsynk ej konfigurerad";
    else if (!session) root.textContent = "Inte inloggad";
    else if (custom) root.textContent = custom;
    else if (syncState.pending) root.textContent = navigator.onLine ? "Väntar på synk" : "Offline – sparat lokalt";
    else root.textContent = "Synkad";
    document.querySelector("#cloudSignOutBtn")?.classList.toggle("hidden", !session);
    document.querySelector("#cloudSignInForm")?.classList.toggle("hidden", Boolean(session));
    const deleteButton = document.querySelector("#deleteCloudAccountBtn");
    if (deleteButton) deleteButton.disabled = !session;
    const disconnectButton = document.querySelector("#disconnectGptBtn");
    if (disconnectButton) disconnectButton.disabled = !session;
  }

  window.addEventListener("online", sync);
  window.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  window.medicinkollCloud = { queueSync, queueDelete, sync, signIn, signOut, deleteAccount, disconnectGpt, configured, getSession: () => session, localTimestamp };
  document.addEventListener("DOMContentLoaded", consumeAuthCallback);
})();
