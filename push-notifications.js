(function () {
  "use strict";

  const config = window.MEDICINKOLL_CONFIG || {};
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  function element(id) { return document.getElementById(id); }

  function urlBase64ToUint8Array(value) {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  }

  function localState() {
    try { return JSON.parse(localStorage.getItem("medicinlogg.v2") || "{}"); } catch (_) { return {}; }
  }

  function nextPlannedSlot(now = new Date(), state = localState()) {
    return (state.entries || [])
      .filter((entry) => entry.status === "planned")
      .map((entry) => ({ ...entry, timestamp: window.medicinkollCloud.localTimestamp(entry.date, entry.time) }))
      .filter((entry) => Date.parse(entry.timestamp) > now.getTime())
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))[0] || null;
  }

  function renderNextDose() {
    const root = element("nextReminderDose");
    if (!root || !window.medicinkollCloud) return;
    const next = nextPlannedSlot();
    if (!next) {
      root.textContent = "Ingen kommande planerad dos i den lokala loggen.";
      return;
    }
    const milliseconds = Math.max(0, Date.parse(next.timestamp) - Date.now());
    const totalMinutes = Math.ceil(milliseconds / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    root.textContent = `Nästa planerade dos: ${next.date} ${next.time} · om ${hours ? `${hours} tim ` : ""}${minutes} min.`;
  }

  async function currentSubscription() {
    if (!supported) return null;
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
  }

  async function enable() {
    if (!supported) throw new Error("Push stöds inte här. På iPhone krävs en installerad hemskärmsapp.");
    if (!window.medicinkollCloud.getSession()) throw new Error("Logga in på Molnsynk först.");
    if (!config.vapidPublicKey) throw new Error("Påminnelser är inte serverkonfigurerade.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(permission === "denied" ? "Notiser är blockerade i enhetens inställningar." : "Notistillstånd gavs inte.");
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
    });
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("Enheten lämnade en ofullständig push-prenumeration.");
    await window.medicinkollCloud.apiRequest("/rest/v1/rpc/register_push_subscription", {
      method: "POST",
      body: JSON.stringify({
        subscription_endpoint: json.endpoint,
        subscription_p256dh: json.keys.p256dh,
        subscription_auth: json.keys.auth,
        subscription_user_agent: navigator.userAgent,
      }),
    });
    await window.medicinkollCloud.apiRequest("/rest/v1/rpc/set_notification_preferences", {
      method: "POST", body: JSON.stringify({ preferences_enabled: true }),
    });
    await renderStatus("Påminnelser aktiverade");
  }

  async function disableCurrentSubscription(disableAll = true) {
    const subscription = await currentSubscription();
    if (subscription && window.medicinkollCloud.getSession()) {
      await window.medicinkollCloud.apiRequest("/rest/v1/rpc/disable_push_subscription", {
        method: "POST", body: JSON.stringify({ subscription_endpoint: subscription.endpoint }),
      }).catch(() => {});
    }
    if (subscription) await subscription.unsubscribe().catch(() => false);
    if (disableAll && window.medicinkollCloud.getSession()) {
      await window.medicinkollCloud.apiRequest("/rest/v1/rpc/set_notification_preferences", {
        method: "POST", body: JSON.stringify({ preferences_enabled: false }),
      });
    }
    await renderStatus(disableAll ? "Påminnelser avstängda" : undefined);
  }

  async function renderStatus(message) {
    const status = element("pushStatus");
    const enableButton = element("enablePushBtn");
    const disableButton = element("disablePushBtn");
    if (!status) return;
    renderNextDose();
    if (!supported) {
      status.textContent = "Push är inte tillgängligt här. På iPhone/iPad: installera appen på hemskärmen och öppna den där.";
      enableButton.disabled = true;
      disableButton.disabled = true;
      return;
    }
    if (!window.medicinkollCloud.getSession()) {
      status.textContent = "Logga in på Molnsynk för att hantera påminnelser.";
      enableButton.disabled = true;
      disableButton.disabled = true;
      return;
    }
    const subscription = await currentSubscription();
    const preferences = await window.medicinkollCloud.apiRequest("/rest/v1/notification_preferences?select=enabled,minutes_before&limit=1", { method: "GET" }).catch(() => []);
    const active = Boolean(subscription && preferences[0]?.enabled && Notification.permission === "granted");
    status.textContent = message || (active ? "Aktiverad · 5 minuter före planerad dos" : Notification.permission === "denied" ? "Avstängd · notiser är blockerade i enheten" : "Avstängd");
    enableButton.disabled = active;
    disableButton.disabled = !subscription && !preferences[0]?.enabled;
  }

  document.addEventListener("DOMContentLoaded", () => {
    element("enablePushBtn")?.addEventListener("click", async () => {
      try { await enable(); } catch (error) { element("pushStatus").textContent = error.message; }
    });
    element("disablePushBtn")?.addEventListener("click", async () => {
      try { await disableCurrentSubscription(true); } catch (error) { element("pushStatus").textContent = error.message; }
    });
    renderStatus().catch(() => {});
    renderNextDose();
    setInterval(renderNextDose, 30_000);
  });
  window.addEventListener("medicinkoll:session-ready", () => renderStatus().catch(() => {}));
  window.addEventListener("medicinkoll:state-synced", renderNextDose);
  window.medicinkollPush = { enable, disableCurrentSubscription, renderStatus };
  if (window.MEDICINKOLL_TEST) window.medicinkollPushTest = { urlBase64ToUint8Array, nextPlannedSlot };
})();
