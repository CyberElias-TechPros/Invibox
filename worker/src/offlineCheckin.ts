import type { Hono, MiddlewareHandler, Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./types";
import { json } from "./validation";
import { uid } from "./security";

async function ownEvent(c: Context<AppEnv>, eventId: string) {
  const row = await c.env.DB.prepare(
    "SELECT * FROM events WHERE id=? AND (owner_id=? OR EXISTS(SELECT 1 FROM event_members WHERE event_id=? AND user_id=? AND role IN ('owner','admin','checkin_staff','guest_manager')))",
  )
    .bind(eventId, c.get("userId"), eventId, c.get("userId"))
    .first();
  if (!row) throw new HTTPException(404, { message: "Event not found" });
  return row;
}

export function registerOfflineRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.post(
    "/api/v1/events/:eventId/checkin/offline/sync",
    authenticate,
    rateLimit,
    async (c) => {
      const event = await ownEvent(c, c.req.param("eventId"));
      const body = await json(
        c.req.raw,
        z.object({
          deviceId: z.string().min(2).max(100),
          checkins: z
            .array(
              z.object({
                guestId: z.string().max(100),
                checkedInAt: z.string().datetime({ offset: true }),
                checkedIn: z.boolean(),
              }),
            )
            .max(500),
        }),
      );
      const results: any[] = [];
      for (const item of body.checkins) {
        const guest = await c.env.DB.prepare(
          "SELECT id,checked_in_at FROM guests WHERE id=? AND event_id=?",
        )
          .bind(item.guestId, event.id)
          .first<any>();
        if (!guest) {
          results.push({ guestId: item.guestId, status: "not_found" });
          continue;
        }
        // Conflict resolution: last write wins by checked_in_at timestamp, but we preserve first check-in time if already checked in and new is later uncheck? Actually check-in is monotonic: once checked in, stays unless explicitly unchecked by staff.
        // For offline, we treat checkedIn=true as setting checked_in_at to earliest known time, checkedIn=false as clearing only if server was unchecked or device timestamp is newer than server's last update
        if (item.checkedIn) {
          const existing = guest.checked_in_at
            ? Date.parse(guest.checked_in_at)
            : 0;
          const incoming = Date.parse(item.checkedInAt);
          const effective =
            existing && existing < incoming
              ? guest.checked_in_at
              : item.checkedInAt;
          await c.env.DB.batch([
            c.env.DB.prepare(
              "INSERT INTO offline_checkin_queue(id,event_id,guest_id,checked_in_at,device_id,synced_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(event_id,guest_id,device_id,checked_in_at) DO NOTHING",
            ).bind(
              uid("off"),
              event.id,
              item.guestId,
              item.checkedInAt,
              body.deviceId,
            ),
            c.env.DB.prepare(
              "UPDATE guests SET checked_in_at=COALESCE(checked_in_at,?),updated_at=CURRENT_TIMESTAMP WHERE id=? AND event_id=?",
            ).bind(effective, item.guestId, event.id),
          ]);
          results.push({
            guestId: item.guestId,
            status: "checked_in",
            at: effective,
          });
        } else {
          // Only allow offline uncheck if device timestamp is newer than server's checked_in_at and user is not just guest_manager? For safety, allow but audit
          await c.env.DB.batch([
            c.env.DB.prepare(
              "INSERT INTO offline_checkin_queue(id,event_id,guest_id,checked_in_at,device_id,synced_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)",
            ).bind(
              uid("off"),
              event.id,
              item.guestId,
              item.checkedInAt,
              body.deviceId,
            ),
            c.env.DB.prepare(
              "UPDATE guests SET checked_in_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND event_id=? AND (checked_in_at IS NULL OR julianday(?)>julianday(checked_in_at))",
            ).bind(item.guestId, event.id, item.checkedInAt),
          ]);
          results.push({ guestId: item.guestId, status: "unchecked" });
        }
      }
      return c.json({ results });
    },
  );

  app.get(
    "/api/v1/events/:eventId/checkin/offline/pending",
    authenticate,
    async (c) => {
      await ownEvent(c, c.req.param("eventId"));
      const rows = await c.env.DB.prepare(
        "SELECT guest_id,checked_in_at,device_id,created_at FROM offline_checkin_queue WHERE event_id=? AND synced_at IS NOT NULL ORDER BY created_at DESC LIMIT 100",
      )
        .bind(c.req.param("eventId"))
        .all();
      return c.json({ queue: rows.results });
    },
  );
}
