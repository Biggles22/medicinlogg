import { adminClient, bridgeCors, jsonResponse, oauthError, publicAuthClient } from "../_shared/bridge.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: bridgeCors });
  if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);
  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return oauthError("authentication_required", "Sign in required", 401);
    const auth = publicAuthClient(authorization);
    const { data, error } = await auth.auth.getUser(authorization.slice(7));
    if (error || !data.user) return oauthError("authentication_required", "Invalid or expired session", 401);
    const admin = adminClient();
    const { error: revokeError } = await admin.from("gpt_oauth_tokens").update({ revoked_at: new Date().toISOString() })
      .eq("user_id", data.user.id).is("revoked_at", null);
    if (revokeError) return oauthError("server_error", "Access could not be revoked", 500);
    return jsonResponse({ revoked: true });
  } catch (_) {
    return oauthError("server_error", "Revocation service unavailable", 500);
  }
});
