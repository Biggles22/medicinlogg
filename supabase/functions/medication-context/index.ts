import { authenticatedClient, dateRange, enforceRateLimit, handleError, json, preflight } from "../_shared/api.ts";

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  try {
    const { client, user, authKind } = await authenticatedClient(request);
    await enforceRateLimit(client, "medication-context", user.id, authKind);
    const range = dateRange(request, 31, 7);
    const [doses, observations] = await Promise.all([
      client.from("dose_logs")
        .select("id,scheduled_at,taken_at,medication_name,dose,status,note")
        .eq("user_id", user.id)
        .gte("scheduled_at", range.start).lt("scheduled_at", range.endExclusive)
        .order("scheduled_at"),
      client.from("observations")
        .select("observed_at,text,category,severity")
        .eq("user_id", user.id)
        .gte("observed_at", range.start).lt("observed_at", range.endExclusive)
        .order("observed_at"),
    ]);
    if (doses.error || observations.error) throw new Error("query_failed");
    return json({
      from: range.from,
      to: range.to,
      timezone: "Europe/Stockholm",
      dose_logs: doses.data,
      observations: observations.data,
    });
  } catch (error) {
    return handleError(error);
  }
});
