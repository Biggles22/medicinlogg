import { adminClient, bridgeConfig, oauthError, randomToken, redirectResponse, sha256 } from "../_shared/bridge.ts";

Deno.serve(async (request) => {
  if (request.method !== "GET") return oauthError("invalid_request", "GET required", 405);
  try {
    const config = bridgeConfig();
    const params = new URL(request.url).searchParams;
    const clientId = params.get("client_id") || "";
    const redirectUri = params.get("redirect_uri") || "";
    const state = params.get("state") || "";
    const responseType = params.get("response_type") || "";
    const requestedScopes = (params.get("scope") || "email").split(/\s+/).filter(Boolean);
    if (clientId !== config.clientId) return oauthError("invalid_client", "Unknown client ID", 400);
    if (!config.redirectUris.includes(redirectUri)) return oauthError("invalid_redirect_uri", `Redirect URI is not registered: ${redirectUri || "[missing]"}`, 400);
    if (responseType !== "code" || !state || state.length > 1024) return oauthError("invalid_request", "response_type=code and state are required", 400);
    if (requestedScopes.some((scope) => !["openid", "email"].includes(scope))) return oauthError("invalid_scope", "Unsupported scope", 400);

    const authorizationId = randomToken("mk_auth_");
    const admin = adminClient();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const { error } = await admin.from("gpt_oauth_requests").insert({
      authorization_id_hash: await sha256(authorizationId), client_id: clientId,
      redirect_uri: redirectUri, state, scope: requestedScopes.join(" "), expires_at: expiresAt,
    });
    if (error) return oauthError("server_error", "Authorization could not be started", 500);
    const consent = new URL(config.consentUrl);
    consent.searchParams.set("bridge_authorization_id", authorizationId);
    return redirectResponse(consent.toString());
  } catch (_) {
    return oauthError("server_error", "Authorization server unavailable", 500);
  }
});
