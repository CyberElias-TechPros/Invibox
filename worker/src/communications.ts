import type { Hono, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv, Bindings } from "./types";
import { hmacSha512, sha256 } from "./security";
import { constantTimeEqual } from "./domain";
import { json } from "./validation";
const channels = z.enum(["email", "sms", "whatsapp"]);
export async function unsubscribeSignature(
  env: Bindings,
  guestId: string,
  channel: string,
) {
  const secret =
    env.SESSION_PEPPER ||
    (env.APP_ENV === "development" ? "development-unsubscribe-key" : "");
  if (!secret) throw new Error("Unsubscribe signing is not configured");
  return hmacSha512(secret, `invibox:unsubscribe:${guestId}:${channel}`);
}
export async function withUnsubscribe(
  env: Bindings,
  guestId: string,
  channel: string,
  message: string,
) {
  const signature = await unsubscribeSignature(env, guestId, channel);
  return `${message}\n\nStop ${channel} event updates: ${env.APP_ORIGIN}/unsubscribe?guest=${encodeURIComponent(guestId)}&channel=${channel}&signature=${signature}`;
}
export function registerCommunicationRoutes(
  app: Hono<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.post("/api/v1/public/preferences", rateLimit, async (c) => {
    const body = await json(
      c.req.raw,
      z.object({
        token: z.string().min(20).max(200),
        email: z.boolean(),
        sms: z.boolean(),
        whatsapp: z.boolean(),
      }),
    );
    const result = await c.env.DB.prepare(
      "UPDATE guests SET email_opt_in=?,sms_opt_in=?,whatsapp_opt_in=?,communication_consent_at=CURRENT_TIMESTAMP,communication_consent_source='guest_link' WHERE access_token_hash=?",
    )
      .bind(
        body.email ? 1 : 0,
        body.sms ? 1 : 0,
        body.whatsapp ? 1 : 0,
        await sha256(body.token),
      )
      .run();
    if (!result.meta.changes)
      throw new HTTPException(404, { message: "Invitation not found" });
    return c.json({ ok: true });
  });
  app.post("/api/v1/public/unsubscribe", rateLimit, async (c) => {
    const body = await json(
      c.req.raw,
      z.object({
        guest: z.string().min(1).max(100),
        channel: channels,
        signature: z.string().regex(/^[a-f0-9]{128}$/),
      }),
    );
    if (
      !constantTimeEqual(
        body.signature,
        await unsubscribeSignature(c.env, body.guest, body.channel),
      )
    )
      throw new HTTPException(403, {
        message:
          "This unsubscribe link is invalid. Open your invitation to manage preferences.",
      });
    // Channel is enum-validated, never an arbitrary SQL identifier. Signed links can only opt out.
    await c.env.DB.prepare(
      `UPDATE guests SET ${body.channel}_opt_in=0,communication_consent_at=CURRENT_TIMESTAMP,communication_consent_source='signed_unsubscribe' WHERE id=?`,
    )
      .bind(body.guest)
      .run();
    return c.json({
      ok: true,
      message:
        "You will no longer receive this channel’s event updates. Messages already accepted by a provider cannot be recalled.",
    });
  });
}
