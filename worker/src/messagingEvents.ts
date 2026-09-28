import type { Hono, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Bindings } from "./types";
import { uid, hmacSha512 } from "./security";
import { constantTimeEqual } from "./domain";

export async function verifyResendWebhook(
  env: Bindings,
  raw: string,
  signature: string,
) {
  if (!env.RESEND_WEBHOOK_SECRET) return; // optional
  const expected = await hmacSha512(env.RESEND_WEBHOOK_SECRET, raw);
  if (!constantTimeEqual(signature, expected))
    throw new HTTPException(401, { message: "Invalid Resend signature" });
}

export function registerMessagingCallbackRoutes(
  app: Hono<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.post("/api/v1/webhooks/resend", rateLimit, async (c) => {
    const raw = await c.req.text();
    const sig =
      c.req.header("x-resend-signature") ||
      c.req.header("svix-signature") ||
      "";
    if (c.env.RESEND_WEBHOOK_SECRET) await verifyResendWebhook(c.env, raw, sig);
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new HTTPException(422, { message: "Invalid JSON" });
    }
    const eventType = payload.type || payload.event;
    const providerId = String(
      payload.data?.email_id || payload.data?.id || payload.id || uid("re"),
    );
    const email = payload.data?.to || payload.data?.email;
    const typeMap: Record<string, string> = {
      "email.delivered": "delivered",
      "email.bounced": "bounced",
      "email.complained": "complained",
      "email.opened": "opened",
      "email.clicked": "clicked",
      "email.failed": "failed",
    };
    const mapped =
      typeMap[eventType] ||
      (eventType?.includes("bounced")
        ? "bounced"
        : eventType?.includes("complained")
          ? "complained"
          : eventType?.includes("delivered")
            ? "delivered"
            : "failed");
    try {
      await c.env.DB.prepare(
        "INSERT INTO message_events(id,provider,provider_event_id,channel,type) VALUES(?,?,?,?,'email',?) ON CONFLICT(provider_event_id) DO NOTHING",
      )
        .bind(uid("mevt"), "resend", providerId, mapped)
        .run();
      if (email && (mapped === "bounced" || mapped === "complained")) {
        await c.env.DB.prepare(
          "INSERT INTO suppression_list(id,channel,address,reason) VALUES(?,?,?,?) ON CONFLICT(channel,address) DO NOTHING",
        )
          .bind(uid("sup"), "email", String(email).toLowerCase(), mapped)
          .run();
      }
    } catch {}
    return c.json({ ok: true });
  });

  app.post("/api/v1/webhooks/twilio", rateLimit, async (c) => {
    const form = await c.req.formData();
    const messageSid = String(form.get("MessageSid") || "");
    const status = String(form.get("MessageStatus") || "");
    const to = String(form.get("To") || "");
    const typeMap: Record<string, string> = {
      delivered: "delivered",
      failed: "failed",
      undelivered: "bounced",
      bounced: "bounced",
    };
    const mapped = typeMap[status] || "failed";
    if (messageSid) {
      await c.env.DB.prepare(
        "INSERT INTO message_events(id,provider,provider_event_id,channel,type) VALUES(?,?,?,?,?) ON CONFLICT(provider_event_id) DO NOTHING",
      )
        .bind(
          uid("mevt"),
          "twilio",
          messageSid,
          to.startsWith("whatsapp") ? "whatsapp" : "sms",
          mapped,
        )
        .run();
      if (mapped === "bounced" && to) {
        await c.env.DB.prepare(
          "INSERT INTO suppression_list(id,channel,address,reason) VALUES(?,?,?,?) ON CONFLICT(channel,address) DO NOTHING",
        )
          .bind(
            uid("sup"),
            to.startsWith("whatsapp") ? "whatsapp" : "sms",
            to,
            mapped,
          )
          .run();
      }
    }
    return c.json({ ok: true });
  });

  app.get("/api/v1/events/:eventId/suppressions", async (c) => {
    // owner check via existing ownEvent helper inline
    const userId = (c as any).get("userId");
    if (!userId) throw new HTTPException(401, { message: "Auth required" });
    const event = await c.env.DB.prepare(
      "SELECT id FROM events WHERE id=? AND (owner_id=? OR EXISTS(SELECT 1 FROM event_members WHERE event_id=? AND user_id=?))",
    )
      .bind(c.req.param("eventId"), userId, c.req.param("eventId"), userId)
      .first();
    if (!event) throw new HTTPException(404, { message: "Event not found" });
    const rows = await c.env.DB.prepare(
      "SELECT * FROM suppression_list ORDER BY created_at DESC LIMIT 100",
    ).all();
    return c.json({ suppressions: rows.results });
  });
}
