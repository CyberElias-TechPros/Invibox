import type { Hono, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./types";
import { json } from "./validation";
import { uid } from "./security";

async function ownEvent(c: any, eventId: string) {
  const row = await c.env.DB.prepare(
    "SELECT * FROM events WHERE id=? AND (owner_id=? OR EXISTS(SELECT 1 FROM event_members WHERE event_id=? AND user_id=?))",
  )
    .bind(eventId, c.get("userId"), eventId, c.get("userId"))
    .first();
  if (!row) throw new HTTPException(404, { message: "Event not found" });
  return row;
}

export function registerScheduledRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.post(
    "/api/v1/events/:eventId/announcements/:announcementId/schedule",
    authenticate,
    rateLimit,
    async (c) => {
      await ownEvent(c, c.req.param("eventId"));
      const body = await json(
        c.req.raw,
        z.object({ sendAt: z.string().datetime({ offset: true }) }),
      );
      const sendAt = Date.parse(body.sendAt);
      if (sendAt < Date.now() + 60000)
        throw new HTTPException(422, {
          message: "Scheduled time must be at least 1 minute in future",
        });
      const id = uid("sched");
      await c.env.DB.prepare(
        "INSERT INTO scheduled_announcements(id,announcement_id,send_at) VALUES(?,?,?)",
      )
        .bind(id, c.req.param("announcementId"), body.sendAt)
        .run();
      return c.json({ id }, 201);
    },
  );
  app.get("/api/v1/events/:eventId/scheduled", authenticate, async (c) => {
    await ownEvent(c, c.req.param("eventId"));
    const rows = await c.env.DB.prepare(
      "SELECT sa.id,sa.announcement_id,sa.send_at,sa.status,a.channel,a.message FROM scheduled_announcements sa JOIN announcements a ON a.id=sa.announcement_id WHERE a.event_id=? ORDER BY sa.send_at LIMIT 50",
    )
      .bind(c.req.param("eventId"))
      .all();
    return c.json({ scheduled: rows.results });
  });
  app.delete(
    "/api/v1/events/:eventId/scheduled/:schedId",
    authenticate,
    async (c) => {
      await ownEvent(c, c.req.param("eventId"));
      await c.env.DB.prepare(
        "UPDATE scheduled_announcements SET status='canceled' WHERE id=?",
      )
        .bind(c.req.param("schedId"))
        .run();
      return c.body(null, 204);
    },
  );
}

export async function dispatchScheduled(env: any) {
  const due = await env.DB.prepare(
    "SELECT sa.id,sa.announcement_id FROM scheduled_announcements sa WHERE sa.status='scheduled' AND julianday(sa.send_at)<=julianday('now') LIMIT 10",
  ).all();
  for (const row of due.results as any[]) {
    // Mark sent and enqueue actual sending via existing announcement flow (reuse announcement retry logic)
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE scheduled_announcements SET status='sent' WHERE id=?",
      ).bind(row.id),
      env.DB.prepare(
        "UPDATE announcements SET status='queued' WHERE id=? AND status='sent'",
      ).bind(row.announcement_id),
    ]);
  }
}
