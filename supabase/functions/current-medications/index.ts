import { authenticatedClient, enforceRateLimit, handleError, json, preflight } from "../_shared/api.ts";

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  try {
    const { client } = await authenticatedClient(request);
    await enforceRateLimit(client, "current-medications");
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 30);
    const { data, error } = await client.from("dose_logs")
      .select("medication_name,dose,scheduled_at")
      .gte("scheduled_at", since.toISOString()).order("scheduled_at");
    if (error) throw new Error("query_failed");
    const grouped = new Map<string, { name: string; dose: string; planned_times: Set<string> }>();
    for (const row of data) {
      const key = `${row.medication_name}\u0000${row.dose}`;
      const item = grouped.get(key) ?? { name: row.medication_name, dose: row.dose, planned_times: new Set<string>() };
      item.planned_times.add(new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(row.scheduled_at)));
      grouped.set(key, item);
    }
    return json({
      source: "Medicinkoll user log",
      medications: [...grouped.values()].map((item) => ({ ...item, planned_times: [...item.planned_times].sort() })),
    });
  } catch (error) {
    return handleError(error);
  }
});
