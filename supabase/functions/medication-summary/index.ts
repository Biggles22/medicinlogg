import { authenticatedClient, dateRange, enforceRateLimit, handleError, json, percentile, preflight } from "../_shared/api.ts";

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  try {
    const { client } = await authenticatedClient(request);
    await enforceRateLimit(client, "medication-summary");
    const range = dateRange(request, 366);
    const { data, error } = await client.from("dose_logs")
      .select("scheduled_at,taken_at,medication_name,dose,status")
      .gte("scheduled_at", range.start).lt("scheduled_at", range.endExclusive)
      .order("scheduled_at");
    if (error) throw new Error("query_failed");
    const delays = data.filter((row) => row.status === "taken" && row.taken_at)
      .map((row) => Math.round((Date.parse(row.taken_at) - Date.parse(row.scheduled_at)) / 60_000));
    const byMedication = new Map<string, { name: string; dose: string; scheduled: number; taken: number; skipped: number }>();
    const byDay = new Map<string, { date: string; scheduled: number; taken: number; skipped: number }>();
    for (const row of data) {
      const medKey = `${row.medication_name}\u0000${row.dose}`;
      const med = byMedication.get(medKey) ?? { name: row.medication_name, dose: row.dose, scheduled: 0, taken: 0, skipped: 0 };
      med.scheduled += 1;
      if (row.status === "taken") med.taken += 1;
      if (row.status === "skipped") med.skipped += 1;
      byMedication.set(medKey, med);
      const dayKey = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date(row.scheduled_at));
      const day = byDay.get(dayKey) ?? { date: dayKey, scheduled: 0, taken: 0, skipped: 0 };
      day.scheduled += 1;
      if (row.status === "taken") day.taken += 1;
      if (row.status === "skipped") day.skipped += 1;
      byDay.set(dayKey, day);
    }
    const average = delays.length ? Math.round((delays.reduce((sum, value) => sum + value, 0) / delays.length) * 10) / 10 : null;
    return json({
      period: { from: range.from, to: range.to },
      scheduled_count: data.length,
      taken_count: data.filter((row) => row.status === "taken").length,
      skipped_count: data.filter((row) => row.status === "skipped").length,
      unresolved_count: data.filter((row) => row.status === "planned").length,
      delay_minutes: { median: percentile(delays, 0.5), average, p90: percentile(delays, 0.9), maximum: delays.length ? Math.max(...delays) : null },
      by_medication: [...byMedication.values()],
      by_day: [...byDay.values()],
    });
  } catch (error) {
    return handleError(error);
  }
});
