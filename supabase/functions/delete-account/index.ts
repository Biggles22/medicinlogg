import { createClient } from "npm:@supabase/supabase-js@2";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "DELETE, OPTIONS", "Content-Type": "application/json" };
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "DELETE") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
  const authorization = request.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!authorization?.startsWith("Bearer ") || !url || !anonKey || !serviceKey) return new Response(JSON.stringify({ error: "authentication_required" }), { status: 401, headers });
  const verifier = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await verifier.auth.getUser(authorization.slice(7));
  if (error || !data.user) return new Response(JSON.stringify({ error: "invalid_or_expired_token" }), { status: 401, headers });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const deletion = await admin.auth.admin.deleteUser(data.user.id);
  if (deletion.error) return new Response(JSON.stringify({ error: "account_deletion_failed" }), { status: 500, headers });
  return new Response(null, { status: 204, headers });
});
