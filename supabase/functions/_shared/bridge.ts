import { createClient } from "npm:@supabase/supabase-js@2";

export const bridgeCors = {
  "Access-Control-Allow-Origin": "https://biggles22.github.io",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store",
};

export function adminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("server_configuration_error");
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function publicAuthClient(authorization?: string) {
  const url = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !publishableKey) throw new Error("server_configuration_error");
  return createClient(url, publishableKey, {
    global: { headers: authorization ? { Authorization: authorization } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function bridgeConfig() {
  const clientId = Deno.env.get("GPT_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GPT_OAUTH_CLIENT_SECRET");
  const consentUrl = Deno.env.get("GPT_OAUTH_CONSENT_URL");
  const redirectUris = (Deno.env.get("GPT_OAUTH_REDIRECT_URIS") || "").split(",").filter(Boolean);
  if (!clientId || !clientSecret || !consentUrl || !redirectUris.length) throw new Error("server_configuration_error");
  return { clientId, clientSecret, consentUrl, redirectUris };
}

export function randomToken(prefix: string, bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  const value = btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${prefix}${value}`;
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function secureEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...bridgeCors, "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function redirectResponse(url: string) {
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
}

export function oauthError(code: string, description: string, status = 400) {
  return jsonResponse({ error: code, error_description: description }, status);
}
