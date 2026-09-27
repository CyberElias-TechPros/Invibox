import type { Hono, MiddlewareHandler, Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./types";
import { json } from "./validation";
import { uid } from "./security";

async function ownEvent(c: Context<AppEnv>, eventId: string) {
  const row = await c.env.DB.prepare(
    "SELECT * FROM events WHERE id=? AND owner_id=?",
  )
    .bind(eventId, c.get("userId"))
    .first();
  if (!row) throw new HTTPException(404, { message: "Owned event not found" });
  return row;
}

export function registerTicketRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.get("/api/v1/events/:eventId/tickets", authenticate, async (c) => {
    await ownEvent(c, c.req.param("eventId"));
    const rows = await c.env.DB.prepare(
      "SELECT * FROM ticket_types WHERE event_id=?",
    )
      .bind(c.req.param("eventId"))
      .all();
    return c.json({ ticketTypes: rows.results });
  });
  app.post(
    "/api/v1/events/:eventId/tickets",
    authenticate,
    rateLimit,
    async (c) => {
      const event = await ownEvent(c, c.req.param("eventId"));
      const body = await json(
        c.req.raw,
        z.object({
          name: z.string().trim().min(2).max(100),
          capacity: z.number().int().min(1).max(100000),
          priceMinor: z.number().int().min(0).max(100000000),
        }),
      );
      const id = uid("tkt");
      await c.env.DB.prepare(
        "INSERT INTO ticket_types(id,event_id,name,capacity,price_minor) VALUES(?,?,?,?,?)",
      )
        .bind(id, event.id, body.name, body.capacity, body.priceMinor)
        .run();
      return c.json({ id }, 201);
    },
  );
  app.delete(
    "/api/v1/events/:eventId/tickets/:ticketId",
    authenticate,
    async (c) => {
      await ownEvent(c, c.req.param("eventId"));
      await c.env.DB.prepare(
        "DELETE FROM ticket_types WHERE id=? AND event_id=?",
      )
        .bind(c.req.param("ticketId"), c.req.param("eventId"))
        .run();
      return c.body(null, 204);
    },
  );
  app.post(
    "/api/v1/events/:eventId/tickets/:ticketId/hold",
    authenticate,
    rateLimit,
    async (c) => {
      const body = await json(
        c.req.raw,
        z.object({
          guestId: z.string().max(100),
          quantity: z.number().int().min(1).max(30),
        }),
      );
      const id = uid("thold");
      await c.env.DB.prepare(
        "INSERT INTO ticket_holds(id,ticket_type_id,guest_id,quantity,status,expires_at) VALUES(?,?,?,?,?,?)",
      )
        .bind(
          id,
          c.req.param("ticketId"),
          body.guestId,
          body.quantity,
          "held",
          new Date(Date.now() + 15 * 60000).toISOString(),
        )
        .run();
      return c.json({ id, status: "held" }, 201);
    },
  );
  app.post(
    "/api/v1/events/:eventId/tickets/holds/:holdId/confirm",
    authenticate,
    rateLimit,
    async (c) => {
      const hold = await c.env.DB.prepare(
        "SELECT * FROM ticket_holds WHERE id=? AND status='held' AND julianday(expires_at)>julianday('now')",
      )
        .bind(c.req.param("holdId"))
        .first<any>();
      if (!hold)
        throw new HTTPException(404, { message: "Hold not found or expired" });
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE ticket_holds SET status='confirmed' WHERE id=?",
        ).bind(hold.id),
        c.env.DB.prepare("UPDATE ticket_types SET sold=sold+? WHERE id=?").bind(
          hold.quantity,
          hold.ticket_type_id,
        ),
      ]);
      return c.json({ ok: true });
    },
  );
}
