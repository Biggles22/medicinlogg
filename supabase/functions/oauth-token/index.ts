import { adminClient, bridgeConfig, jsonResponse, oauthError, randomToken, secureEqual, sha256 } from "../_shared/bridge.ts";

function clientCredentials(request: Request, body: URLSearchParams) {
  const basic = request.headers.get("Authorization");
  if (basic?.startsWith("Basic ")) {
    try {
      const decoded = atob(basic.slice(6));
      const separator = decoded.indexOf(":");
      return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
    } catch (_) { return { clientId: "", clientSecret: "" }; }
  }
  return { clientId: body.get("client_id") || "", clientSecret: body.get("client_secret") || "" };
}

function tokenPayload(accessToken: string, refreshToken: string, scope: string) {
  return { access_token: accessToken, token_type: "bearer", expires_in: 3600, refresh_token: refreshToken, scope };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);
  try {
    const body = new URLSearchParams(await request.text());
    const credentials = clientCredentials(request, body);
    const config = bridgeConfig();
    if (!secureEqual(credentials.clientId, config.clientId) || !secureEqual(credentials.clientSecret, config.clientSecret)) {
      return oauthError("invalid_client", "Client authentication failed", 401);
    }
    const admin = adminClient();
    const grantType = body.get("grant_type");
    const accessToken = randomToken("mk_at_");
    const refreshToken = randomToken("mk_rt_", 48);
    const accessExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();

    if (grantType === "authorization_code") {
      const code = body.get("code") || "";
      const redirectUri = body.get("redirect_uri") || "";
      if (!code.startsWith("mk_code_") || !config.redirectUris.includes(redirectUri)) return oauthError("invalid_grant", "Invalid authorization code", 400);
      const { data: codeRow, error } = await admin.from("gpt_oauth_codes").update({ consumed_at: new Date().toISOString() })
        .eq("code_hash", await sha256(code)).eq("client_id", config.clientId).eq("redirect_uri", redirectUri)
        .is("consumed_at", null).gt("expires_at", new Date().toISOString())
        .select("user_id,scope").maybeSingle();
      if (error || !codeRow) return oauthError("invalid_grant", "Authorization code expired or consumed", 400);
      const { error: tokenError } = await admin.from("gpt_oauth_tokens").insert({
        user_id: codeRow.user_id, client_id: config.clientId,
        access_token_hash: await sha256(accessToken), refresh_token_hash: await sha256(refreshToken),
        scope: codeRow.scope, access_expires_at: accessExpiresAt, refresh_expires_at: refreshExpiresAt,
      });
      if (tokenError) return oauthError("server_error", "Token could not be issued", 500);
      return jsonResponse(tokenPayload(accessToken, refreshToken, codeRow.scope));
    }

    if (grantType === "refresh_token") {
      const suppliedRefreshToken = body.get("refresh_token") || "";
      const { data: tokenRow, error } = await admin.from("gpt_oauth_tokens").select("id,user_id,scope")
        .eq("refresh_token_hash", await sha256(suppliedRefreshToken)).eq("client_id", config.clientId)
        .is("revoked_at", null).gt("refresh_expires_at", new Date().toISOString()).maybeSingle();
      if (error || !tokenRow) return oauthError("invalid_grant", "Refresh token invalid or revoked", 400);
      const { error: rotateError } = await admin.from("gpt_oauth_tokens").update({
        access_token_hash: await sha256(accessToken), refresh_token_hash: await sha256(refreshToken),
        access_expires_at: accessExpiresAt, refresh_expires_at: refreshExpiresAt,
      }).eq("id", tokenRow.id).is("revoked_at", null);
      if (rotateError) return oauthError("server_error", "Token could not be refreshed", 500);
      return jsonResponse(tokenPayload(accessToken, refreshToken, tokenRow.scope));
    }
    return oauthError("unsupported_grant_type", "Unsupported grant type", 400);
  } catch (_) {
    return oauthError("server_error", "Token service unavailable", 500);
  }
});
