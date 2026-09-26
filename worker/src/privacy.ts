import type { Hono, MiddlewareHandler, Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv, Bindings } from "./types";
import { json } from "./validation";
import { confirmPassword } from "./account";
import { uid } from "./security";

export async function purgeMedia(env: Bindings) {
  const rows = await env.DB.prepare(
    "SELECT object_key FROM media_deletions ORDER BY created_at LIMIT 50",
  ).all<{ object_key: string }>();
  if (!rows.results.length) return;
  await env.MEDIA.delete(rows.results.map((row) => row.object_key));
  await env.DB.batch(
    rows.results.map((row) =>
      env.DB.prepare("DELETE FROM media_deletions WHERE object_key=?").bind(
        row.object_key,
      ),
    ),
  );
}
async function owner(c: Context<AppEnv>) {
  const event = await c.env.DB.prepare(
    "SELECT * FROM events WHERE id=? AND owner_id=?",
  )
    .bind(c.req.param("eventId"), c.get("userId"))
    .first<any>();
  if (!event)
    throw new HTTPException(404, { message: "Owned event not found" });
  return event;
}
export function registerPrivacyRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.post(
    "/api/v1/events/:eventId/export",
    authenticate,
    rateLimit,
    async (c) => {
      const event = await owner(c);
      const { password } = await json(
        c.req.raw,
        z.object({ password: z.string().max(128) }),
      );
      await confirmPassword(c, password);
      // Fixed allowlisted projections: never export passwords, token hashes, reset links or checkout URLs.
      const queries: Record<string, string> = {
        guests:
          "SELECT id,name,email,phone,group_id,household_id,language,status,email_opt_in,sms_opt_in,whatsapp_opt_in,communication_consent_at,party_size,meal,dietary_notes,plus_one_name,table_name,checked_in_at,created_at FROM guests WHERE event_id=?",
        groups: "SELECT id,name,kind FROM guest_groups WHERE event_id=?",
        households:
          "SELECT id,name,seat_limit FROM households WHERE event_id=?",
        occasions: "SELECT * FROM occasions WHERE event_id=?",
        access:
          "SELECT a.* FROM guest_occasion_access a JOIN guests g ON g.id=a.guest_id WHERE g.event_id=?",
        sections: "SELECT * FROM experience_sections WHERE event_id=?",
        seating: "SELECT * FROM seating_tables WHERE event_id=?",
        budgets: "SELECT * FROM budgets WHERE event_id=?",
        vendors: "SELECT * FROM vendors WHERE event_id=?",
        media:
          "SELECT id,guest_id,mime_type,size_bytes,caption,status,created_at FROM media WHERE event_id=?",
        payments:
          "SELECT reference,purpose,amount_minor,currency,status,paid_at,created_at FROM payments WHERE event_id=?",
        announcements:
          "SELECT id,channel,audience,message,status,sent_count,created_at FROM announcements WHERE event_id=?",
      };
      // D1 batch provides a consistent snapshot across the selected collections.
      const results = await c.env.DB.batch(
        Object.values(queries).map((sql) =>
          c.env.DB.prepare(sql).bind(event.id),
        ),
      );
      return c.json({
        exportedAt: new Date().toISOString(),
        event,
        collections: Object.fromEntries(
          Object.keys(queries).map((key, i) => [key, results[i].results]),
        ),
        note: "Media bytes, backups and provider-held records are not embedded. This file contains private guest information; store it securely.",
      });
    },
  );
  app.post(
    "/api/v1/events/:eventId/erase-guest/:guestId",
    authenticate,
    rateLimit,
    async (c) => {
      const event = await owner(c);
      const { password } = await json(
        c.req.raw,
        z.object({ password: z.string().max(128) }),
      );
      await confirmPassword(c, password);
      const guest = await c.env.DB.prepare(
        "SELECT id FROM guests WHERE id=? AND event_id=?",
      )
        .bind(c.req.param("guestId"), event.id)
        .first<any>();
      if (!guest) throw new HTTPException(404, { message: "Guest not found" });
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT OR IGNORE INTO media_deletions(object_key) SELECT object_key FROM media WHERE guest_id=? AND event_id=?",
        ).bind(guest.id, event.id),
        c.env.DB.prepare(
          "DELETE FROM media WHERE guest_id=? AND event_id=?",
        ).bind(guest.id, event.id),
        c.env.DB.prepare(
          "DELETE FROM analytics_events WHERE guest_id=? AND event_id=?",
        ).bind(guest.id, event.id),
        c.env.DB.prepare(
          "DELETE FROM audit_logs WHERE event_id=? AND entity_id=?",
        ).bind(event.id, guest.id),
        c.env.DB.prepare("DELETE FROM guests WHERE id=? AND event_id=?").bind(
          guest.id,
          event.id,
        ),
      ]);
      return c.json(
        {
          ok: true,
          storageCleanup: "queued",
          note: "Guest links are revoked. Linked files are inaccessible and queued for deletion. Financial records are retained without the guest link. Backups and provider-held records follow operator retention policies.",
        },
        202,
      );
    },
  );
  app.post(
    "/api/v1/events/:eventId/delete",
    authenticate,
    rateLimit,
    async (c) => {
      const event = await owner(c);
      if (event.lifecycle !== "archived")
        throw new HTTPException(409, {
          message: "Archive the event before deleting it.",
        });
      const body = await json(
        c.req.raw,
        z.object({ password: z.string().max(128), confirmation: z.string() }),
      );
      if (body.confirmation !== event.title)
        throw new HTTPException(422, {
          message: "Type the exact event title to confirm deletion",
        });
      const user = await confirmPassword(c, body.password),
        guard = uid("guard");
      // The retention trigger also protects against a payment appearing after this request begins.
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO account_action_guards(id,user_id,password_hash) VALUES(?,?,?)",
        ).bind(guard, user.id, user.password_hash),
        c.env.DB.prepare(
          "INSERT OR IGNORE INTO media_deletions(object_key) SELECT object_key FROM media WHERE event_id=?",
        ).bind(event.id),
        c.env.DB.prepare("DELETE FROM audit_logs WHERE event_id=?").bind(
          event.id,
        ),
        c.env.DB.prepare("DELETE FROM events WHERE id=? AND owner_id=?").bind(
          event.id,
          user.id,
        ),
        c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
          guard,
        ),
      ]);
      return c.json(
        {
          ok: true,
          storageCleanup: "queued",
          note: "Event data and access removed. Referenced R2 files are queued for deletion. Backups and provider-held data follow separate retention policies.",
        },
        202,
      );
    },
  );
}
