(async function () {
  "use strict";
  const status = document.querySelector("#status");
  const allow = document.querySelector("#allow");
  const deny = document.querySelector("#deny");
  const config = window.MEDICINKOLL_CONFIG || {};
  const authorizationId = new URLSearchParams(location.search).get("authorization_id");
  let session;
  try { session = JSON.parse(localStorage.getItem("medicinlogg.session.v1")); } catch (_) { session = null; }

  function fail(message) {
    status.textContent = message;
    status.setAttribute("role", "alert");
    allow.disabled = true;
    deny.disabled = true;
  }

  if (!authorizationId) return fail("Auktoriserings-ID saknas. Starta anslutningen igen från PS Medicinkoll.");
  if (!config.supabaseUrl || !config.supabaseAnonKey) return fail("Medicinkoll är inte konfigurerad för molnanslutning.");
  if (!session?.access_token) {
    const next = location.pathname + location.search;
    location.replace(`../../?next=${encodeURIComponent(next)}`);
    return;
  }

  const headers = {
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
  };
  const endpoint = `${config.supabaseUrl}/auth/v1/oauth/authorizations/${encodeURIComponent(authorizationId)}`;
  let details;
  try {
    const response = await fetch(endpoint, { headers });
    if (response.status === 401) {
      localStorage.removeItem("medicinlogg.session.v1");
      location.replace(`../../?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    if (!response.ok) throw new Error("invalid_authorization");
    details = await response.json();
    if (details.redirect_url && !details.authorization_id) {
      location.assign(details.redirect_url);
      return;
    }
  } catch (_) {
    return fail("Auktoriseringsförfrågan är ogiltig eller har löpt ut.");
  }

  document.querySelector("#clientName").textContent = details.client?.name || "Okänd tjänst";
  document.querySelector("#scopes").textContent = (details.scope || "").split(" ").filter(Boolean).join(", ") || "Läsåtkomst";
  document.querySelector("#details").hidden = false;
  status.textContent = "Välj om du vill ge denna läsåtkomst.";
  allow.disabled = false;
  deny.disabled = false;

  async function decide(action) {
    allow.disabled = true;
    deny.disabled = true;
    status.textContent = action === "approve" ? "Godkänner…" : "Avbryter…";
    try {
      const response = await fetch(`${endpoint}/consent`, { method: "POST", headers, body: JSON.stringify({ action }) });
      const result = await response.json();
      if (!response.ok || !result.redirect_url) throw new Error("decision_failed");
      location.assign(result.redirect_url);
    } catch (_) {
      fail("Beslutet kunde inte sparas. Starta anslutningen igen.");
    }
  }
  allow.addEventListener("click", () => decide("approve"));
  deny.addEventListener("click", () => decide("deny"));
})();
