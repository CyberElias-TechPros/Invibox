import type { Hono, Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Bindings } from "./types";
import { sha256, uid } from "./security";
const imageTypes = ["image/jpeg", "image/png", "image/webp"];
async function guest(c: Context<AppEnv>, reading = true) {
  const token = c.req.header("Authorization")?.replace(/^Guest /, "") || "";
  if (token.length < 20 || token.length > 200)
    throw new HTTPException(401, {
      message: "A valid personal invitation is required",
    });
  const record = await c.env.DB.prepare(
    "SELECT g.id,g.event_id,e.lifecycle,e.settings_json FROM guests g JOIN events e ON e.id=g.event_id WHERE g.access_token_hash=? AND e.slug=?",
  )
    .bind(await sha256(token), c.req.param("slug"))
    .first<any>();
  if (
    !record ||
    (reading &&
      !["published", "active", "live", "completed"].includes(record.lifecycle))
  )
    throw new HTTPException(404, { message: "Invitation not found" });
  return {
    ...record,
    tokenHash: await sha256(token),
    settings: JSON.parse(record.settings_json),
  };
}
export async function cleanAbandonedUploads(env: Bindings) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO media_deletions(object_key) SELECT object_key FROM media_uploads WHERE julianday(expires_at)<=julianday('now') AND NOT EXISTS(SELECT 1 FROM media m WHERE m.object_key=media_uploads.object_key AND m.upload_state='ready')",
    ),
    env.DB.prepare(
      "DELETE FROM media WHERE upload_state='uploading' AND object_key IN (SELECT object_key FROM media_uploads WHERE julianday(expires_at)<=julianday('now'))",
    ),
    env.DB.prepare(
      "DELETE FROM media_uploads WHERE julianday(expires_at)<=julianday('now')",
    ),
  ]);
}
export function registerGuestMediaRoutes(
  app: Hono<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.post("/api/v1/public/events/:slug/media", async (c) => {
    const g = await guest(c);
    if (
      !g.settings.guestUploads ||
      !["published", "active", "live"].includes(g.lifecycle)
    )
      throw new HTTPException(409, {
        message: "Guest uploads are closed for this event",
      });
    const form = await c.req.formData(),
      file = form.get("file");
    if (form.get("consent") !== "true")
      throw new HTTPException(422, {
        message:
          "Confirm permission to upload and share this photo with invited guests after moderation",
      });
    if (
      !(file instanceof File) ||
      !imageTypes.includes(file.type) ||
      !file.size ||
      file.size > 10 * 1024 * 1024
    )
      throw new HTTPException(415, {
        message: "Upload a JPEG, PNG or WebP photo up to 10 MB",
      });
    const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer()),
      ascii = new TextDecoder().decode(bytes);
    const valid =
      file.type === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : file.type === "image/png"
          ? bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10"
          : ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
    if (!valid)
      throw new HTTPException(415, {
        message: "File content does not match its media type",
      });
    const id = uid("med"),
      key = `events/${g.event_id}/guest/${id}`;
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO media(id,event_id,guest_id,object_key,mime_type,size_bytes,caption,share_with_guests,upload_state,consent_at) SELECT ?,?,?,?,?,?,?,1,'uploading',CURRENT_TIMESTAMP WHERE EXISTS(SELECT 1 FROM guests WHERE id=? AND access_token_hash=?)",
      ).bind(
        id,
        g.event_id,
        g.id,
        key,
        file.type,
        file.size,
        String(form.get("caption") || "").slice(0, 500),
        g.id,
        g.tokenHash,
      ),
      c.env.DB.prepare(
        "INSERT INTO media_uploads(object_key,expires_at) VALUES(?,?)",
      ).bind(key, new Date(Date.now() + 3600000).toISOString()),
    ]);
    // Recheck reservation before touching storage: token rotation/deletion may have won the transaction.
    const reserved = await c.env.DB.prepare("SELECT id FROM media WHERE id=?")
      .bind(id)
      .first();
    if (!reserved) {
      await c.env.DB.prepare("DELETE FROM media_uploads WHERE object_key=?")
        .bind(key)
        .run();
      throw new HTTPException(409, {
        message: "Invitation changed; reload before uploading",
      });
    }
    try {
      await c.env.MEDIA.put(key, file.stream(), {
        httpMetadata: { contentType: file.type },
      });
      const saved = await c.env.DB.prepare(
        "UPDATE media SET upload_state='ready' WHERE id=?",
      )
        .bind(id)
        .run();
      if (!saved.meta.changes)
        throw new HTTPException(409, {
          message: "This upload was withdrawn while being stored",
        });
    } catch (error) {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT OR IGNORE INTO media_deletions(object_key) VALUES(?)",
        ).bind(key),
        c.env.DB.prepare("DELETE FROM media WHERE id=?").bind(id),
      ]);
      throw error;
    } finally {
      await c.env.DB.prepare("DELETE FROM media_uploads WHERE object_key=?")
        .bind(key)
        .run();
    }
    return c.json({ id, status: "pending" }, 201);
  });
  app.get("/api/v1/public/events/:slug/media", async (c) => {
    const g = await guest(c),
      cursor = c.req.query("cursor") || "";
    if (cursor.length > 100)
      throw new HTTPException(422, { message: "Invalid cursor" });
    const rows = await c.env.DB.prepare(
      "SELECT id,mime_type,caption,status,created_at,guest_id=? AS own FROM media WHERE event_id=? AND upload_state='ready' AND id>? AND (guest_id=? OR (status='approved' AND share_with_guests=1 AND ?=1)) AND mime_type IN ('image/jpeg','image/png','image/webp') ORDER BY id LIMIT 25",
    )
      .bind(g.id, g.event_id, cursor, g.id, g.settings.guestGallery ? 1 : 0)
      .all<any>();
    return c.json({
      items: rows.results.slice(0, 24),
      nextCursor: rows.results.length > 24 ? rows.results[23].id : null,
      galleryEnabled: Boolean(g.settings.guestGallery),
      uploadsEnabled:
        Boolean(g.settings.guestUploads) &&
        ["published", "active", "live"].includes(g.lifecycle),
    });
  });
  app.get("/api/v1/public/events/:slug/media/:mediaId/file", async (c) => {
    const g = await guest(c);
    const media = await c.env.DB.prepare(
      "SELECT object_key,mime_type FROM media WHERE id=? AND event_id=? AND upload_state='ready' AND (guest_id=? OR (status='approved' AND share_with_guests=1 AND ?=1)) AND mime_type IN ('image/jpeg','image/png','image/webp')",
    )
      .bind(
        c.req.param("mediaId"),
        g.event_id,
        g.id,
        g.settings.guestGallery ? 1 : 0,
      )
      .first<any>();
    if (!media) throw new HTTPException(404, { message: "Photo not found" });
    const object = await c.env.MEDIA.get(media.object_key);
    if (!object) throw new HTTPException(404, { message: "Photo not found" });
    return new Response(object.body, {
      headers: {
        "Content-Type": media.mime_type,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
  app.delete("/api/v1/public/events/:slug/media/:mediaId", async (c) => {
    const g = await guest(c, false),
      id = c.req.param("mediaId");
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO media_deletions(object_key) SELECT object_key FROM media WHERE id=? AND guest_id=? AND event_id=?",
      ).bind(id, g.id, g.event_id),
      c.env.DB.prepare(
        "DELETE FROM media WHERE id=? AND guest_id=? AND event_id=?",
      ).bind(id, g.id, g.event_id),
    ]);
    return c.body(null, 204);
  });
}
