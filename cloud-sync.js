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
  let refreshPromise = null;
  let loginCodeRequested = false;
  let fingerprints = stateFingerprints(readLocalState());

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

  function readLocalState() {
    try { return JSON.parse(localStorage.getItem(stateKey) || "{}"); } catch (_) { return {}; }
  }

  function itemFingerprint(item) {
    const { createdAt, updatedAt, ...content } = item;
    void createdAt; void updatedAt;
    return JSON.stringify(content);
  }

  function stateFingerprints(rawState) {
    return new Map([
      ...(rawState.entries || []).map((item) => [`dose:${item.id}`, itemFingerprint(item)]),
      ...(rawState.observations || []).map((item) => [`observation:${item.id}`, itemFingerprint(item)]),
    ]);
  }

  function headers(extra) {
    return {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async function refreshSession() {
    if (!session?.refresh_token) return false;
    if (!refreshPromise) refreshPromise = (async () => {
      const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST", headers: { apikey: config.supabaseAnonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!response.ok) return false;
      const refreshed = await response.json();
      session = { ...refreshed, expires_at: Math.floor(Date.now() / 1000) + refreshed.expires_in };
      localStorage.setItem(sessionStorageKey(), JSON.stringify(session));
      return true;
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function request(path, options, retried = false) {
    const response = await fetch(`${config.supabaseUrl}${path}`, { ...options, headers: headers(options?.headers) });
    if (response.status === 401 && !retried && await refreshSession()) return request(path, options, true);
    if (response.status === 401) {
      session = null;
      localStorage.removeItem(sessionStorageKey());
      renderStatus();
    }
    if (!response.ok) {
      const body = await response.clone().json().catch(() => ({}));
      const detail = body.message || body.msg || body.error_description || body.error || "okänt fel";
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async function requestAll(path) {
    const pageSize = 1000;
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const separator = path.includes("?") ? "&" : "?";
      const page = await request(`${path}${separator}limit=${pageSize}&offset=${offset}`, { method: "GET" });
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
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

  function localParts(timestamp) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  }

  function remoteDose(row) {
    const scheduled = localParts(row.scheduled_at);
    const taken = row.taken_at ? localParts(row.taken_at) : null;
    return {
      id: row.client_record_id, date: scheduled.date, time: scheduled.time,
      medicine: row.medication_name, dose: row.dose || "", status: row.status,
      note: row.note || "", order: row.display_order || 0, ...(taken ? { takenTime: taken.time } : {}),
      createdAt: row.source_created_at || row.created_at,
      updatedAt: row.source_updated_at || row.updated_at,
    };
  }

  function remoteObservation(row) {
    const observed = localParts(row.observed_at);
    return {
      id: row.client_record_id, date: observed.date, time: observed.time,
      text: row.text, category: row.category || null, severity: row.severity,
      createdAt: row.source_created_at || row.created_at,
      updatedAt: row.source_updated_at || row.updated_at,
    };
  }

  function mergeById(localItems, remoteItems, deletedIds) {
    const merged = new Map(localItems.map((item) => [item.id, item]));
    for (const item of remoteItems) {
      const local = merged.get(item.id);
      if (!local || Date.parse(item.updatedAt || 0) >= Date.parse(local.updatedAt || 0)) merged.set(item.id, item);
    }
    for (const id of deletedIds) merged.delete(id);
    return [...merged.values()];
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
        display_order: entry.order || 0,
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
      const state = readLocalState();
      const data = payloads(state);
      const deletions = [
        ...(syncState.deletedDoses || []).map((item) => ({
          record_type: "dose", client_record_id: typeof item === "string" ? item : item.id,
          deleted_at: typeof item === "string" ? new Date().toISOString() : item.deletedAt,
        })),
        ...(syncState.deletedObservations || []).map((item) => ({
          record_type: "observation", client_record_id: typeof item === "string" ? item : item.id,
          deleted_at: typeof item === "string" ? new Date().toISOString() : item.deletedAt,
        })),
      ];
      if (deletions.length) {
        await request("/rest/v1/rpc/sync_deletions", { method: "POST", body: JSON.stringify({ records: deletions }) });
      }
      for (let offset = 0; offset < data.doses.length; offset += 100) {
        await request("/rest/v1/rpc/sync_dose_logs", { method: "POST", body: JSON.stringify({ records: data.doses.slice(offset, offset + 100) }) });
      }
      for (let offset = 0; offset < data.observations.length; offset += 100) {
        await request("/rest/v1/rpc/sync_observations", { method: "POST", body: JSON.stringify({ records: data.observations.slice(offset, offset + 100) }) });
      }
      const [remoteDoses, remoteObservations, remoteDeletions] = await Promise.all([
        requestAll("/rest/v1/dose_logs?select=client_record_id,scheduled_at,taken_at,medication_name,dose,status,note,display_order,source_created_at,source_updated_at,created_at,updated_at"),
        requestAll("/rest/v1/observations?select=client_record_id,observed_at,text,category,severity,source_created_at,source_updated_at,created_at,updated_at"),
        requestAll("/rest/v1/deleted_records?select=record_type,client_record_id,deleted_at"),
      ]);
      const deletedDoseIds = new Set(remoteDeletions.filter((row) => row.record_type === "dose").map((row) => row.client_record_id));
      const deletedObservationIds = new Set(remoteDeletions.filter((row) => row.record_type === "observation").map((row) => row.client_record_id));
      state.entries = mergeById(state.entries || [], remoteDoses.map(remoteDose), deletedDoseIds);
      state.observations = mergeById(state.observations || [], remoteObservations.map(remoteObservation), deletedObservationIds);
      localStorage.setItem(stateKey, JSON.stringify(state));
      fingerprints = stateFingerprints(state);
      window.dispatchEvent(new CustomEvent("medicinkoll:state-synced", { detail: state }));
      syncState.migrated = true;
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
    for (const [type, items] of [["dose", rawState.entries || []], ["observation", rawState.observations || []]]) {
      for (const item of items) {
        const key = `${type}:${item.id}`;
        const fingerprint = itemFingerprint(item);
        if (!item.createdAt) item.createdAt = now;
        if (!item.updatedAt || fingerprints.get(key) !== fingerprint) item.updatedAt = now;
        fingerprints.set(key, fingerprint);
      }
    }
    localStorage.setItem(stateKey, JSON.stringify(rawState));
    syncState.pending = true;
    saveSyncState();
    sync();
    window.dispatchEvent(new CustomEvent("medicinkoll:session-ready"));
  }

  function queueDelete(type, id) {
    const key = type === "dose" ? "deletedDoses" : "deletedObservations";
    const existing = (syncState[key] || []).filter((item) => (typeof item === "string" ? item : item.id) !== id);
    syncState[key] = [...existing, { id, deletedAt: new Date().toISOString() }];
    fingerprints.delete(`${type}:${id}`);
    syncState.pending = true;
    saveSyncState();
    // The caller removes the item locally and then calls queueSync(). Starting
    // here would race with that save and could upsert the just-deleted record.
  }

  function sessionStorageKey() { return "medicinlogg.session.v1"; }

  async function sendLoginCode(email) {
    if (!configured) throw new Error("missing_configuration");
    const response = await fetch(`${config.supabaseUrl}/auth/v1/otp`, {
      method: "POST",
      headers: { apikey: config.supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: true }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.msg || error.message || "sign_in_failed");
    }
    loginCodeRequested = true;
    renderStatus();
  }

  async function verifyLoginCode(email, token) {
    if (!configured) throw new Error("missing_configuration");
    if (!/^\d{6}$/.test(token)) throw new Error("Koden ska bestå av sex siffror");
    const response = await fetch(`${config.supabaseUrl}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: config.supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, token, type: "email" }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.msg || error.message || error.error_description || "invalid_code");
    }
    const verified = await response.json();
    session = {
      ...verified,
      expires_at: verified.expires_at || Math.floor(Date.now() / 1000) + Number(verified.expires_in || 3600),
    };
    localStorage.setItem(sessionStorageKey(), JSON.stringify(session));
    loginCodeRequested = false;
    syncState.lastError = null;
    syncState.pending = true;
    saveSyncState();
    renderStatus();
    window.dispatchEvent(new CustomEvent("medicinkoll:session-ready"));
    await sync();
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
      if (!await refreshSession()) {
        session = null;
        localStorage.removeItem(sessionStorageKey());
      }
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
    await window.medicinkollPush?.disableCurrentSubscription(false).catch(() => {});
    if (session) await fetch(`${config.supabaseUrl}/auth/v1/logout`, { method: "POST", headers: headers() }).catch(() => {});
    session = null;
    loginCodeRequested = false;
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
    else if (syncState.lastError) {
      root.textContent = navigator.onLine ? `Synkfel: ${syncState.lastError}` : "Offline – sparat lokalt";
      root.title = syncState.lastError;
    }
    else if (syncState.pending) root.textContent = navigator.onLine ? "Väntar på synk" : "Offline – sparat lokalt";
    else root.textContent = "Synkad";
    if (!syncState.lastError) root.removeAttribute("title");
    document.querySelector("#cloudSignOutBtn")?.classList.toggle("hidden", !session);
    document.querySelector("#cloudSignInForm")?.classList.toggle("hidden", Boolean(session));
    document.querySelector("#cloudVerifyForm")?.classList.toggle("hidden", Boolean(session) || !loginCodeRequested);
    const deleteButton = document.querySelector("#deleteCloudAccountBtn");
    if (deleteButton) deleteButton.disabled = !session;
    const disconnectButton = document.querySelector("#disconnectGptBtn");
    if (disconnectButton) disconnectButton.disabled = !session;
  }

  window.addEventListener("online", sync);
  window.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  window.medicinkollCloud = { queueSync, queueDelete, sync, sendLoginCode, verifyLoginCode, signOut, deleteAccount, disconnectGpt, configured, getSession: () => session, localTimestamp, apiRequest: request };
  if (window.MEDICINKOLL_TEST) window.medicinkollCloudTest = { mergeById, remoteDose, remoteObservation, itemFingerprint };
  document.addEventListener("DOMContentLoaded", consumeAuthCallback);
})();
