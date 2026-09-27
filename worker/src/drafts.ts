import type { Hono, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./types";
import { json } from "./validation";
import { uid } from "./security";

export function registerDraftRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.get("/api/v1/events/:eventId/drafts", authenticate, async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT id,content_json,created_at FROM draft_snapshots WHERE event_id=? AND user_id=? ORDER BY created_at DESC LIMIT 20",
    )
      .bind(c.req.param("eventId"), c.get("userId"))
      .all();
    return c.json({
      drafts: rows.results.map((r: any) => ({
        id: r.id,
        content: JSON.parse(r.content_json),
        createdAt: r.created_at,
      })),
    });
  });
  app.post(
    "/api/v1/events/:eventId/drafts",
    authenticate,
    rateLimit,
    async (c) => {
      const body = await json(
        c.req.raw,
        z.object({ content: z.record(z.string(), z.unknown()) }),
      );
      const id = uid("draft");
      await c.env.DB.prepare(
        "INSERT INTO draft_snapshots(id,event_id,user_id,content_json) VALUES(?,?,?,?)",
      )
        .bind(
          id,
          c.req.param("eventId"),
          c.get("userId"),
          JSON.stringify(body.content),
        )
        .run();
      // Keep only latest 20 per user per event
      await c.env.DB.prepare(
        "DELETE FROM draft_snapshots WHERE id IN (SELECT id FROM draft_snapshots WHERE event_id=? AND user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 20)",
      )
        .bind(c.req.param("eventId"), c.get("userId"))
        .run();
      return c.json({ id }, 201);
    },
  );
  app.delete(
    "/api/v1/events/:eventId/drafts/:draftId",
    authenticate,
    async (c) => {
      await c.env.DB.prepare(
        "DELETE FROM draft_snapshots WHERE id=? AND event_id=? AND user_id=?",
      )
        .bind(c.req.param("draftId"), c.req.param("eventId"), c.get("userId"))
        .run();
      return c.body(null, 204);
    },
  );
}
