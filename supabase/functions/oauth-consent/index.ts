import { adminClient, bridgeConfig, bridgeCors, jsonResponse, oauthError, publicAuthClient, randomToken, sha256 } from "../_shared/bridge.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: bridgeCors });
  if (!["GET", "POST"].includes(request.method)) return oauthError("invalid_request", "Method not allowed", 405);
  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return oauthError("authentication_required", "Sign in required", 401);
    const auth = publicAuthClient(authorization);
    const { data: userData, error: userError } = await auth.auth.getUser(authorization.slice(7));
    if (userError || !userData.user) return oauthError("authentication_required", "Invalid or expired session", 401);

    const input = request.method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await request.json();
    const authorizationId = typeof input.authorization_id === "string" ? input.authorization_id : "";
    if (!authorizationId.startsWith("mk_auth_")) return oauthError("invalid_request", "Invalid authorization request", 400);
    const hash = await sha256(authorizationId);
    const admin = adminClient();

    if (request.method === "GET") {
      const { data, error } = await admin.from("gpt_oauth_requests").select("client_id,redirect_uri,scope,expires_at")
        .eq("authorization_id_hash", hash).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (error || !data) return oauthError("invalid_request", "Authorization request expired", 400);
      return jsonResponse({ authorization_id: authorizationId, client: { name: "PS Medicinkoll" }, redirect_uri: data.redirect_uri, scope: data.scope });
    }

    const action = typeof input.action === "string" ? input.action : "";
    if (!['approve', 'deny'].includes(action)) return oauthError("invalid_request", "Invalid consent action", 400);
    const { data: authRequest, error: deleteError } = await admin.from("gpt_oauth_requests").delete()
      .eq("authorization_id_hash", hash).gt("expires_at", new Date().toISOString())
      .select("client_id,redirect_uri,state,scope").maybeSingle();
    if (deleteError || !authRequest) return oauthError("invalid_request", "Authorization request expired or consumed", 400);
    const callback = new URL(authRequest.redirect_uri);
    callback.searchParams.set("state", authRequest.state);
    if (action === "deny") {
      callback.searchParams.set("error", "access_denied");
      return jsonResponse({ redirect_url: callback.toString() });
    }
    const code = randomToken("mk_code_");
    const { error: codeError } = await admin.from("gpt_oauth_codes").insert({
      code_hash: await sha256(code), user_id: userData.user.id, client_id: authRequest.client_id,
      redirect_uri: authRequest.redirect_uri, scope: authRequest.scope,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    if (codeError) return oauthError("server_error", "Authorization code could not be issued", 500);
    callback.searchParams.set("code", code);
    return jsonResponse({ redirect_url: callback.toString() });
  } catch (_) {
    return oauthError("server_error", "Consent service unavailable", 500);
  }
});
