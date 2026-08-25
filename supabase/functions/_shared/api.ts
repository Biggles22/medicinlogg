import { createClient } from "npm:@supabase/supabase-js@2";
import { adminClient, sha256 } from "./bridge.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "https://chat.openai.com",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

export function preflight(request: Request): Response | null {
  return request.method === "OPTIONS" ? new Response(null, { status: 204, headers: corsHeaders }) : null;
}

export async function authenticatedClient(request: Request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) throw new ApiError(401, "authentication_required");
  const token = authorization.slice(7);
  if (token.startsWith("mk_at_")) {
    const client = adminClient();
    const { data, error } = await client.from("gpt_oauth_tokens").select("user_id")
      .eq("access_token_hash", await sha256(token)).is("revoked_at", null)
      .gt("access_expires_at", new Date().toISOString()).maybeSingle();
    if (error || !data) throw new ApiError(401, "invalid_or_expired_token");
    return { client, user: { id: data.user_id }, authKind: "bridge" as const };
  }
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) throw new ApiError(500, "server_configuration_error");
  const client = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, "invalid_or_expired_token");
  return { client, user: data.user, authKind: "supabase" as const };
}

export async function enforceRateLimit(client: ReturnType<typeof createClient>, route: string, userId: string, authKind: "bridge" | "supabase") {
  const rpc = authKind === "bridge" ? "consume_bridge_rate_limit" : "consume_api_rate_limit";
  const params = authKind === "bridge"
    ? { target_user_id: userId, route_name: route, allowed_per_minute: 10 }
    : { route_name: route, allowed_per_minute: 10 };
  const { data, error } = await client.rpc(rpc, params);
  if (error) throw new ApiError(500, "rate_limit_check_failed");
  if (!data) throw new ApiError(429, "rate_limit_exceeded");
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export function handleError(error: unknown): Response {
  if (error instanceof ApiError) return json({ error: error.code }, error.status);
  // Never serialize database errors: they can contain health data or query details.
  return json({ error: "internal_server_error" }, 500);
}

export function dateRange(request: Request, maxDays: number, defaultDays?: number) {
  const params = new URL(request.url).searchParams;
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const defaultFromDate = new Date(today);
  defaultFromDate.setUTCDate(defaultFromDate.getUTCDate() - ((defaultDays ?? 1) - 1));
  const from = params.get("from") ?? (defaultDays ? defaultFromDate.toISOString().slice(0, 10) : null);
  const to = params.get("to") ?? (defaultDays ? defaultTo : null);
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new ApiError(400, "invalid_date_range");
  }
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw new ApiError(400, "invalid_date_range");
  const start = stockholmMidnight(from);
  const dayAfterTo = new Date(`${to}T12:00:00Z`);
  dayAfterTo.setUTCDate(dayAfterTo.getUTCDate() + 1);
  const nextDate = dayAfterTo.toISOString().slice(0, 10);
  const endExclusive = stockholmMidnight(nextDate);
  const days = Math.ceil((endExclusive.getTime() - start.getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 1 || days > maxDays) throw new ApiError(400, "invalid_date_range");
  return { from, to, start: start.toISOString(), endExclusive: endExclusive.toISOString() };
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

function stockholmMidnight(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = desiredUtc;
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let i = 0; i < 2; i += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const representedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    guess -= representedAsUtc - desiredUtc;
  }
  return new Date(guess);
}

export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}
