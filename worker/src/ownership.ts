import type { Hono, MiddlewareHandler, Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./types";
import { json } from "./validation";
import { uid, randomToken, sha256 } from "./security";
import { confirmPassword } from "./account";
import { proof as mfaProof } from "./mfa";

async function ownerEvent(c: Context<AppEnv>, eventId: string) {
  const row = await c.env.DB.prepare(
    "SELECT * FROM events WHERE id=? AND owner_id=?",
  )
    .bind(eventId, c.get("userId"))
    .first<any>();
  if (!row) throw new HTTPException(404, { message: "Owned event not found" });
  return row;
}

export function registerOwnershipRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.post(
    "/api/v1/events/:eventId/transfer",
    authenticate,
    rateLimit,
    async (c) => {
      const event = await ownerEvent(c, c.req.param("eventId"));
      const body = await json(
        c.req.raw,
        z.object({
          toEmail: z
            .string()
            .email()
            .transform((x) => x.toLowerCase()),
          password: z.string().max(128),
          code: z.string().max(64).optional(),
        }),
      );
      const user = await confirmPassword(c, body.password);
      const enabled = await c.env.DB.prepare(
        "SELECT 1 FROM mfa_credentials WHERE user_id=? AND enabled_at IS NOT NULL",
      )
        .bind(user.id)
        .first();
      const guardId = uid("guard");
      const stmts: any[] = [
        c.env.DB.prepare(
          "INSERT INTO account_action_guards(id,user_id,password_hash) VALUES(?,?,?)",
        ).bind(guardId, user.id, user.password_hash),
      ];
      if (enabled) {
        if (!body.code)
          throw new HTTPException(401, {
            message: "Authenticator code required for ownership transfer",
          });
        stmts.push(await mfaProof(c, user.id, body.code, "verify"));
      }
      const target = await c.env.DB.prepare(
        "SELECT id,email FROM users WHERE email=? AND disabled_at IS NULL",
      )
        .bind(body.toEmail)
        .first<any>();
      if (!target)
        throw new HTTPException(404, { message: "Target organizer not found" });
      if (target.id === user.id)
        throw new HTTPException(409, {
          message: "Cannot transfer to yourself",
        });
      const token = randomToken();
      const transferId = uid("xfer");
      stmts.push(
        c.env.DB.prepare(
          "INSERT INTO ownership_transfers(id,event_id,from_user_id,to_user_id,to_email,token_hash,status,expires_at) VALUES(?,?,?,?,?,?,?,?)",
        ).bind(
          transferId,
          event.id,
          user.id,
          target.id,
          target.email,
          await sha256(token),
          "pending",
          new Date(Date.now() + 7 * 86400000).toISOString(),
        ),
        c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
          guardId,
        ),
        c.env.DB.prepare("DELETE FROM mfa_proof_guards WHERE user_id=?").bind(
          user.id,
        ),
      );
      await c.env.DB.batch(stmts);
      return c.json(
        {
          id: transferId,
          token,
          expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        },
        201,
      );
    },
  );

  app.get("/api/v1/events/:eventId/transfers", authenticate, async (c) => {
    await ownerEvent(c, c.req.param("eventId"));
    const rows = await c.env.DB.prepare(
      "SELECT id,to_email,status,expires_at,created_at FROM ownership_transfers WHERE event_id=? ORDER BY created_at DESC LIMIT 20",
    )
      .bind(c.req.param("eventId"))
      .all();
    return c.json({ transfers: rows.results });
  });

  app.post(
    "/api/v1/transfers/:transferId/accept",
    authenticate,
    rateLimit,
    async (c) => {
      const body = await json(
        c.req.raw,
        z.object({
          token: z.string().min(20),
          password: z.string().max(128),
          code: z.string().max(64).optional(),
        }),
      );
      const transfer = await c.env.DB.prepare(
        "SELECT * FROM ownership_transfers WHERE id=? AND status='pending' AND julianday(expires_at)>julianday('now')",
      )
        .bind(c.req.param("transferId"))
        .first<any>();
      if (!transfer)
        throw new HTTPException(404, {
          message: "Transfer not found or expired",
        });
      if (transfer.to_user_id !== c.get("userId"))
        throw new HTTPException(403, {
          message: "This transfer is not for your account",
        });
      if ((await sha256(body.token)) !== transfer.token_hash)
        throw new HTTPException(403, { message: "Invalid transfer token" });
      const user = await confirmPassword(c, body.password);
      const enabled = await c.env.DB.prepare(
        "SELECT 1 FROM mfa_credentials WHERE user_id=? AND enabled_at IS NOT NULL",
      )
        .bind(user.id)
        .first();
      const guardId = uid("guard");
      const stmts: any[] = [
        c.env.DB.prepare(
          "INSERT INTO account_action_guards(id,user_id,password_hash) VALUES(?,?,?)",
        ).bind(guardId, user.id, user.password_hash),
      ];
      if (enabled) {
        if (!body.code)
          throw new HTTPException(401, {
            message: "Authenticator code required to accept ownership",
          });
        stmts.push(await mfaProof(c, user.id, body.code, "verify"));
      }
      stmts.push(
        c.env.DB.prepare(
          "UPDATE events SET owner_id=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_id=?",
        ).bind(transfer.to_user_id, transfer.event_id, transfer.from_user_id),
        c.env.DB.prepare(
          "INSERT INTO event_members(event_id,user_id,role) VALUES(?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET role='owner'",
        ).bind(transfer.event_id, transfer.from_user_id, "admin"),
        c.env.DB.prepare(
          "INSERT INTO event_members(event_id,user_id,role) VALUES(?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET role='owner'",
        ).bind(transfer.event_id, transfer.to_user_id, "owner"),
        c.env.DB.prepare(
          "UPDATE ownership_transfers SET status='accepted',decided_at=CURRENT_TIMESTAMP WHERE id=?",
        ).bind(transfer.id),
        c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
          guardId,
        ),
        c.env.DB.prepare("DELETE FROM mfa_proof_guards WHERE user_id=?").bind(
          user.id,
        ),
      );
      const res = await c.env.DB.batch(stmts);
      if (!res[3].meta.changes)
        throw new HTTPException(409, {
          message: "Event ownership changed during transfer",
        });
      return c.json({ ok: true });
    },
  );

  app.post("/api/v1/transfers/:transferId/reject", authenticate, async (c) => {
    const transfer = await c.env.DB.prepare(
      "SELECT * FROM ownership_transfers WHERE id=? AND to_user_id=? AND status='pending'",
    )
      .bind(c.req.param("transferId"), c.get("userId"))
      .first();
    if (!transfer)
      throw new HTTPException(404, { message: "Transfer not found" });
    await c.env.DB.prepare(
      "UPDATE ownership_transfers SET status='rejected',decided_at=CURRENT_TIMESTAMP WHERE id=?",
    )
      .bind(c.req.param("transferId"))
      .run();
    return c.json({ ok: true });
  });
}
