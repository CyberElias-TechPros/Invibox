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

export function registerExtraRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  // Transport
  app.get("/api/v1/events/:eventId/transport", authenticate, async (c) => {
    await ownEvent(c, c.req.param("eventId"));
    const rows = await c.env.DB.prepare(
      "SELECT * FROM transport_bookings WHERE event_id=? ORDER BY created_at DESC LIMIT 100",
    )
      .bind(c.req.param("eventId"))
      .all();
    return c.json({ bookings: rows.results });
  });
  app.post(
    "/api/v1/events/:eventId/transport",
    authenticate,
    rateLimit,
    async (c) => {
      const body = await json(
        c.req.raw,
        z.object({
          guestId: z.string().max(100),
          mode: z.string().min(2).max(50),
          details: z.record(z.string(), z.unknown()).default({}),
          status: z
            .enum(["pending", "confirmed", "canceled"])
            .default("pending"),
        }),
      );
      const id = uid("trn");
      await c.env.DB.prepare(
        "INSERT INTO transport_bookings(id,event_id,guest_id,mode,details_json,status) VALUES(?,?,?,?,?,?)",
      )
        .bind(
          id,
          c.req.param("eventId"),
          body.guestId,
          body.mode,
          JSON.stringify(body.details),
          body.status,
        )
        .run();
      return c.json({ id }, 201);
    },
  );

  // Accommodations
  app.get("/api/v1/events/:eventId/accommodations", authenticate, async (c) => {
    await ownEvent(c, c.req.param("eventId"));
    const rows = await c.env.DB.prepare(
      "SELECT * FROM accommodations WHERE event_id=?",
    )
      .bind(c.req.param("eventId"))
      .all();
    const assigns = await c.env.DB.prepare(
      "SELECT a.id,a.accommodation_id,a.guest_id,g.name FROM accommodation_assignments a JOIN accommodations ac ON ac.id=a.accommodation_id JOIN guests g ON g.id=a.guest_id WHERE ac.event_id=?",
    )
      .bind(c.req.param("eventId"))
      .all();
    return c.json({
      accommodations: rows.results,
      assignments: assigns.results,
    });
  });
  app.post(
    "/api/v1/events/:eventId/accommodations",
    authenticate,
    rateLimit,
    async (c) => {
      const body = await json(
        c.req.raw,
        z.object({
          name: z.string().min(2).max(100),
          capacity: z.number().int().min(1).max(1000),
        }),
      );
      const id = uid("acc");
      await c.env.DB.prepare(
        "INSERT INTO accommodations(id,event_id,name,capacity) VALUES(?,?,?,?)",
      )
        .bind(id, c.req.param("eventId"), body.name, body.capacity)
        .run();
      return c.json({ id }, 201);
    },
  );
  app.post(
    "/api/v1/events/:eventId/accommodations/:accId/assign",
    authenticate,
    rateLimit,
    async (c) => {
      const body = await json(
        c.req.raw,
        z.object({ guestId: z.string().max(100) }),
      );
      const acc = await c.env.DB.prepare(
        "SELECT * FROM accommodations WHERE id=? AND event_id=?",
      )
        .bind(c.req.param("accId"), c.req.param("eventId"))
        .first<any>();
      if (!acc)
        throw new HTTPException(404, { message: "Accommodation not found" });
      if (acc.allocated >= acc.capacity)
        throw new HTTPException(409, { message: "Accommodation full" });
      const id = uid("aass");
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO accommodation_assignments(id,accommodation_id,guest_id) VALUES(?,?,?)",
        ).bind(id, acc.id, body.guestId),
        c.env.DB.prepare(
          "UPDATE accommodations SET allocated=allocated+1 WHERE id=?",
        ).bind(acc.id),
      ]);
      return c.json({ id }, 201);
    },
  );

  // Registry
  app.get("/api/v1/events/:eventId/registry", authenticate, async (c) => {
    await ownEvent(c, c.req.param("eventId"));
    const items = await c.env.DB.prepare(
      "SELECT * FROM registry_items WHERE event_id=?",
    )
      .bind(c.req.param("eventId"))
      .all();
    const fulfills = await c.env.DB.prepare(
      "SELECT rf.* FROM registry_fulfillments rf JOIN registry_items ri ON ri.id=rf.item_id WHERE ri.event_id=?",
    )
      .bind(c.req.param("eventId"))
      .all();
    return c.json({ items: items.results, fulfillments: fulfills.results });
  });
  app.post(
    "/api/v1/events/:eventId/registry",
    authenticate,
    rateLimit,
    async (c) => {
      const body = await json(
        c.req.raw,
        z.object({
          title: z.string().min(2).max(200),
          url: z.string().url().optional(),
          desiredQuantity: z.number().int().min(1).max(1000).default(1),
        }),
      );
      const id = uid("reg");
      await c.env.DB.prepare(
        "INSERT INTO registry_items(id,event_id,title,url,desired_quantity) VALUES(?,?,?,?,?)",
      )
        .bind(
          id,
          c.req.param("eventId"),
          body.title,
          body.url || null,
          body.desiredQuantity,
        )
        .run();
      return c.json({ id }, 201);
    },
  );
  app.post(
    "/api/v1/events/:eventId/registry/:itemId/fulfill",
    authenticate,
    rateLimit,
    async (c) => {
      const body = await json(
        c.req.raw,
        z.object({
          guestId: z.string().max(100).optional(),
          quantity: z.number().int().min(1).max(100),
        }),
      );
      const item = await c.env.DB.prepare(
        "SELECT * FROM registry_items WHERE id=? AND event_id=?",
      )
        .bind(c.req.param("itemId"), c.req.param("eventId"))
        .first<any>();
      if (!item)
        throw new HTTPException(404, { message: "Registry item not found" });
      const id = uid("rful");
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO registry_fulfillments(id,item_id,guest_id,quantity) VALUES(?,?,?,?)",
        ).bind(id, item.id, body.guestId || null, body.quantity),
        c.env.DB.prepare(
          "UPDATE registry_items SET fulfilled_quantity=fulfilled_quantity+? WHERE id=?",
        ).bind(body.quantity, item.id),
      ]);
      return c.json({ id }, 201);
    },
  );

  // Waitlist
  app.get("/api/v1/events/:eventId/waitlist", authenticate, async (c) => {
    await ownEvent(c, c.req.param("eventId"));
    const rows = await c.env.DB.prepare(
      "SELECT * FROM waitlist_entries WHERE event_id=? ORDER BY created_at LIMIT 100",
    )
      .bind(c.req.param("eventId"))
      .all();
    return c.json({ waitlist: rows.results });
  });
  app.post("/api/v1/events/:eventId/waitlist", async (c) => {
    const body = await json(
      c.req.raw,
      z.object({
        email: z
          .string()
          .email()
          .transform((x) => x.toLowerCase()),
        name: z.string().min(2).max(100),
      }),
    );
    const id = uid("wlist");
    await c.env.DB.prepare(
      "INSERT INTO waitlist_entries(id,event_id,email,name) VALUES(?,?,?,?)",
    )
      .bind(id, c.req.param("eventId"), body.email, body.name)
      .run();
    return c.json({ id }, 201);
  });
  app.post(
    "/api/v1/events/:eventId/waitlist/:entryId/invite",
    authenticate,
    rateLimit,
    async (c) => {
      await ownEvent(c, c.req.param("eventId"));
      const entry = await c.env.DB.prepare(
        "SELECT * FROM waitlist_entries WHERE id=? AND event_id=? AND status='waiting'",
      )
        .bind(c.req.param("entryId"), c.req.param("eventId"))
        .first();
      if (!entry)
        throw new HTTPException(404, { message: "Waitlist entry not found" });
      await c.env.DB.prepare(
        "UPDATE waitlist_entries SET status='invited' WHERE id=?",
      )
        .bind(c.req.param("entryId"))
        .run();
      return c.json({ ok: true });
    },
  );
}
