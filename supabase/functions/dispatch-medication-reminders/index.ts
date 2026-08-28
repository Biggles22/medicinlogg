import webpush from "npm:web-push@3.6.7";
import { adminClient, secureEqual } from "../_shared/bridge.ts";

type ClaimedDelivery = {
  delivery_id: string;
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  attempt_count: number;
};

function requiredSecret(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error("server_configuration_error");
  return value;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  try {
    const expectedCronSecret = requiredSecret("REMINDER_CRON_SECRET");
    if (!secureEqual(request.headers.get("x-cron-secret") || "", expectedCronSecret)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    webpush.setVapidDetails(
      requiredSecret("VAPID_SUBJECT"),
      requiredSecret("VAPID_PUBLIC_KEY"),
      requiredSecret("VAPID_PRIVATE_KEY"),
    );
    const admin = adminClient();
    const { data, error } = await admin.rpc("claim_due_notification_deliveries", { batch_size: 100 });
    if (error) throw new Error("claim_failed");

    let sent = 0;
    let failed = 0;
    let disabled = 0;
    for (const delivery of (data || []) as ClaimedDelivery[]) {
      try {
        await webpush.sendNotification({
          endpoint: delivery.endpoint,
          keys: { p256dh: delivery.p256dh, auth: delivery.auth },
        }, JSON.stringify({
          title: "Medicinkoll",
          body: "Planerad medicinering om 10 minuter.",
          url: "/medicinlogg/",
        }), { TTL: 300, urgency: "high" });
        const completion = await admin.rpc("complete_notification_delivery", {
          target_delivery_id: delivery.delivery_id,
          delivery_succeeded: true,
          permanent_failure: false,
          error_code: null,
        });
        if (completion.error) throw new Error("completion_failed");
        sent += 1;
      } catch (pushError) {
        const statusCode = Number((pushError as { statusCode?: number }).statusCode || 0);
        const permanent = statusCode === 404 || statusCode === 410;
        await admin.rpc("complete_notification_delivery", {
          target_delivery_id: delivery.delivery_id,
          delivery_succeeded: false,
          permanent_failure: permanent,
          error_code: statusCode ? `push_http_${statusCode}` : "push_transport_error",
        });
        failed += 1;
        if (permanent) disabled += 1;
      }
    }
    return Response.json({ claimed: data?.length || 0, sent, failed, disabled }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (_) {
    return Response.json({ error: "reminder_dispatch_failed" }, { status: 500 });
  }
});
