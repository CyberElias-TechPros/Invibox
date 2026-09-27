import type { Hono, MiddlewareHandler, Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./types";
import { json } from "./validation";
import { uid } from "./security";

async function ownEvent(c: Context<AppEnv>, eventId: string) {
  const row = await c.env.DB.prepare(
    "SELECT * FROM events WHERE id=? AND (owner_id=? OR EXISTS(SELECT 1 FROM event_members WHERE event_id=? AND user_id=? AND role IN ('owner','admin','designer')))",
  )
    .bind(eventId, c.get("userId"), eventId, c.get("userId"))
    .first();
  if (!row)
    throw new HTTPException(404, {
      message: "Event not found or insufficient role",
    });
  return row;
}

export function registerThemeRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.get("/api/v1/events/:eventId/themes", authenticate, async (c) => {
    await ownEvent(c, c.req.param("eventId"));
    const rows = await c.env.DB.prepare(
      "SELECT id,name,theme_json,created_at FROM theme_presets WHERE event_id=? ORDER BY created_at DESC LIMIT 20",
    )
      .bind(c.req.param("eventId"))
      .all();
    return c.json({
      themes: rows.results.map((r: any) => ({
        id: r.id,
        name: r.name,
        theme: JSON.parse(r.theme_json),
        createdAt: r.created_at,
      })),
    });
  });
  app.post(
    "/api/v1/events/:eventId/themes",
    authenticate,
    rateLimit,
    async (c) => {
      const body = await json(
        c.req.raw,
        z.object({
          name: z.string().trim().min(2).max(100),
          theme: z.record(z.string(), z.unknown()),
        }),
      );
      const id = uid("thm");
      await c.env.DB.prepare(
        "INSERT INTO theme_presets(id,event_id,name,theme_json) VALUES(?,?,?,?)",
      )
        .bind(id, c.req.param("eventId"), body.name, JSON.stringify(body.theme))
        .run();
      return c.json({ id }, 201);
    },
  );
  app.put(
    "/api/v1/events/:eventId/themes/:themeId/apply",
    authenticate,
    rateLimit,
    async (c) => {
      const preset = await c.env.DB.prepare(
        "SELECT theme_json FROM theme_presets WHERE id=? AND event_id=?",
      )
        .bind(c.req.param("themeId"), c.req.param("eventId"))
        .first<any>();
      if (!preset) throw new HTTPException(404, { message: "Theme not found" });
      await c.env.DB.prepare(
        "UPDATE events SET theme_json=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      )
        .bind(preset.theme_json, c.req.param("eventId"))
        .run();
      return c.json({ ok: true });
    },
  );
  app.get("/api/v1/events/:eventId/translations", authenticate, async (c) => {
    await ownEvent(c, c.req.param("eventId"));
    const rows = await c.env.DB.prepare(
      "SELECT locale,key,value FROM event_translations WHERE event_id=?",
    )
      .bind(c.req.param("eventId"))
      .all();
    return c.json({ translations: rows.results });
  });
  app.put(
    "/api/v1/events/:eventId/translations",
    authenticate,
    rateLimit,
    async (c) => {
      await ownEvent(c, c.req.param("eventId"));
      const body = await json(
        c.req.raw,
        z.object({
          translations: z
            .array(
              z.object({
                locale: z.enum(["en", "yo", "ig", "ha"]),
                key: z.string().min(1).max(100),
                value: z.string().min(1).max(1000),
              }),
            )
            .max(200),
        }),
      );
      const stmts = body.translations.map((t) =>
        c.env.DB.prepare(
          "INSERT INTO event_translations(event_id,locale,key,value) VALUES(?,?,?,?) ON CONFLICT(event_id,locale,key) DO UPDATE SET value=excluded.value",
        ).bind(c.req.param("eventId"), t.locale, t.key, t.value),
      );
      if (stmts.length) await c.env.DB.batch(stmts);
      return c.json({ ok: true });
    },
  );
}
