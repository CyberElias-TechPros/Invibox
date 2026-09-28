import type { Hono, Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./types";
import { json } from "./validation";
import {
  clearCookie,
  getCookie,
  hashPassword,
  randomToken,
  sha256,
  uid,
  verifyPassword,
} from "./security";
import { sendEmail } from "./providers";

export async function requireVerified(c: Context<AppEnv>) {
  if (c.env.APP_ENV === "development") return;
  const user = await c.env.DB.prepare(
    "SELECT email_verified_at FROM users WHERE id=?",
  )
    .bind(c.get("userId"))
    .first<{ email_verified_at: string | null }>();
  if (!user?.email_verified_at)
    throw new HTTPException(403, {
      message:
        "Verify your account email before publishing, inviting collaborators or using paid integrations.",
    });
}
export async function issueVerification(c: Context<AppEnv>, userId: string) {
  const user = await c.env.DB.prepare(
    "SELECT email,full_name,email_verified_at FROM users WHERE id=?",
  )
    .bind(userId)
    .first<any>();
  if (user.email_verified_at) return { ok: true, alreadyVerified: true };
  const demo = c.env.APP_ENV === "development" && c.env.DEMO_MODE === "true";
  if ((!c.env.RESEND_API_KEY || !c.env.EMAIL_FROM) && !demo)
    throw new HTTPException(503, {
      message: "Verification email is not configured. Contact the operator.",
    });
  const token = randomToken();
  const issued = await c.env.DB.prepare(
    "INSERT INTO email_verifications(user_id,token_hash,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=CURRENT_TIMESTAMP WHERE julianday(email_verifications.created_at)<julianday('now','-1 minute') RETURNING user_id",
  )
    .bind(
      userId,
      await sha256(token),
      new Date(Date.now() + 86400000).toISOString(),
    )
    .first();
  if (!issued)
    throw new HTTPException(429, {
      message:
        "Please wait one minute before requesting another verification link.",
    });
  let delivered = false;
  try {
    await sendEmail(
      c.env,
      { name: user.full_name, email: user.email },
      `Verify your Invibox email using this one-day link: ${c.env.APP_ORIGIN}/app?verify=${encodeURIComponent(token)}`,
      "Verify your Invibox email",
    );
    delivered = true;
  } catch {
    if (!demo)
      throw new HTTPException(502, {
        message: "Verification email could not be sent. Retry in one minute.",
      });
  }
  return { ok: true, delivered, ...(demo ? { demoToken: token } : {}) };
}
export async function confirmPassword(c: Context<AppEnv>, password: string) {
  const user = await c.env.DB.prepare(
    "SELECT id,email,full_name,password_hash FROM users WHERE id=?",
  )
    .bind(c.get("userId"))
    .first<any>();
  if (!user || !(await verifyPassword(password, user.password_hash)))
    throw new HTTPException(403, {
      message: "Your current password is incorrect",
    });
  return user;
}
export function registerAccountRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.post("/api/v1/auth/email/request", authenticate, async (c) =>
    c.json(await issueVerification(c, c.get("userId"))),
  );
  app.post("/api/v1/auth/email/verify", async (c) => {
    const { token } = await json(
      c.req.raw,
      z.object({ token: z.string().min(20).max(200) }),
    );
    const hash = await sha256(token);
    // UPDATE and token consumption share one transaction. Possession proves mailbox access; no session is created.
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE users SET email_verified_at=COALESCE(email_verified_at,CURRENT_TIMESTAMP) WHERE id IN (SELECT user_id FROM email_verifications WHERE token_hash=? AND julianday(expires_at)>julianday('now'))",
      ).bind(hash),
      c.env.DB.prepare(
        "DELETE FROM email_verifications WHERE token_hash=?",
      ).bind(hash),
    ]);
    if (!results[0].meta.changes)
      throw new HTTPException(400, {
        message: "Verification link is invalid or expired. Request a new link.",
      });
    return c.json({ ok: true });
  });
  app.get("/api/v1/account/sessions", authenticate, async (c) => {
    const hash = await sha256(
      getCookie(c.req.header("cookie"), "invibox_session")! +
        (c.env.SESSION_PEPPER || ""),
    );
    const rows = await c.env.DB.prepare(
      "SELECT id,user_agent,created_at,expires_at,token_hash=? AS current FROM sessions WHERE user_id=? AND julianday(expires_at)>julianday('now') AND auth_version=(SELECT auth_version FROM users WHERE id=?) ORDER BY created_at DESC LIMIT 100",
    )
      .bind(hash, c.get("userId"), c.get("userId"))
      .all<any>();
    return c.json({
      sessions: rows.results.map((row) => ({
        ...row,
        current: Boolean(row.current),
      })),
    });
  });
  app.delete(
    "/api/v1/account/sessions/:sessionId",
    authenticate,
    rateLimit,
    async (c) => {
      await c.env.DB.prepare("DELETE FROM sessions WHERE id=? AND user_id=?")
        .bind(c.req.param("sessionId"), c.get("userId"))
        .run();
      return c.body(null, 204);
    },
  );
  app.post(
    "/api/v1/account/sessions/revoke-others",
    authenticate,
    rateLimit,
    async (c) => {
      const { password } = await json(
        c.req.raw,
        z.object({ password: z.string().max(128) }),
      );
      const user = await confirmPassword(c, password);
      const hash = await sha256(
        getCookie(c.req.header("cookie"), "invibox_session")! +
          (c.env.SESSION_PEPPER || ""),
      );
      const guard = uid("guard");
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO account_action_guards(id,user_id,password_hash) VALUES(?,?,?)",
        ).bind(guard, user.id, user.password_hash),
        c.env.DB.prepare(
          "UPDATE users SET auth_version=auth_version+1 WHERE id=?",
        ).bind(user.id),
        c.env.DB.prepare(
          "UPDATE sessions SET auth_version=(SELECT auth_version FROM users WHERE id=?) WHERE token_hash=? AND user_id=?",
        ).bind(user.id, hash, user.id),
        c.env.DB.prepare(
          "DELETE FROM sessions WHERE user_id=? AND token_hash<>?",
        ).bind(user.id, hash),
        c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
          guard,
        ),
      ]);
      return c.json({ ok: true });
    },
  );
  app.post("/api/v1/account/password", authenticate, rateLimit, async (c) => {
    const body = await json(
      c.req.raw,
      z.object({
        currentPassword: z.string().max(128),
        newPassword: z.string().min(10).max(128),
      }),
    );
    const user = await confirmPassword(c, body.currentPassword),
      guard = uid("guard");
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO account_action_guards(id,user_id,password_hash) VALUES(?,?,?)",
      ).bind(guard, user.id, user.password_hash),
      c.env.DB.prepare(
        "UPDATE users SET password_hash=?,auth_version=auth_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(await hashPassword(body.newPassword), user.id),
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id),
      c.env.DB.prepare(
        "DELETE FROM password_reset_tokens WHERE user_id=?",
      ).bind(user.id),
      c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
        guard,
      ),
    ]);
    c.header("Set-Cookie", clearCookie());
    return c.json({ ok: true, signInRequired: true });
  });
  app.post("/api/v1/account/export", authenticate, rateLimit, async (c) => {
    const { password } = await json(
      c.req.raw,
      z.object({ password: z.string().max(128) }),
    );
    const user = await confirmPassword(c, password);
    const profile = await c.env.DB.prepare(
      "SELECT id,email,full_name,email_verified_at,created_at,updated_at FROM users WHERE id=?",
    )
      .bind(user.id)
      .first();
    const memberships = await c.env.DB.prepare(
      "SELECT event_id,role,created_at FROM event_members WHERE user_id=?",
    )
      .bind(user.id)
      .all();
    const events = await c.env.DB.prepare(
      "SELECT id,slug,title,event_type,lifecycle,starts_at,timezone,location,created_at FROM events WHERE owner_id=?",
    )
      .bind(user.id)
      .all();
    return c.json({
      exportedAt: new Date().toISOString(),
      profile,
      memberships: memberships.results,
      ownedEvents: events.results,
      payout: await c.env.DB.prepare(
        "SELECT request_id,bank_code,bank_name,account_name,last_four,state,created_at,review_reason FROM payout_accounts WHERE user_id=?",
      )
        .bind(user.id)
        .first(),
      note: "For guest, schedule and media records use the owner-only export in each event. Media bytes and provider-held data are not embedded.",
    });
  });
  app.post("/api/v1/account/delete", authenticate, rateLimit, async (c) => {
    const body = await json(
      c.req.raw,
      z.object({
        password: z.string().max(128),
        confirmation: z.string().max(254),
      }),
    );
    const user = await confirmPassword(c, body.password);
    if (body.confirmation.toLowerCase() !== user.email.toLowerCase())
      throw new HTTPException(422, {
        message: "Type your account email to confirm deletion",
      });
    const active = await c.env.DB.prepare(
      "SELECT id FROM events WHERE owner_id=? AND lifecycle<>'archived' LIMIT 1",
    )
      .bind(user.id)
      .first();
    if (active)
      throw new HTTPException(409, {
        message:
          "Archive all events you own before deleting your account. Export your data first.",
      });
    const guard = uid("guard");
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO account_action_guards(id,user_id,password_hash) VALUES(?,?,?)",
      ).bind(guard, user.id, user.password_hash),
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO media_deletions(object_key) SELECT m.object_key FROM media m JOIN events e ON e.id=m.event_id WHERE e.owner_id=?",
      ).bind(user.id),
      c.env.DB.prepare(
        "DELETE FROM audit_logs WHERE event_id IN (SELECT id FROM events WHERE owner_id=?)",
      ).bind(user.id),
      c.env.DB.prepare("DELETE FROM events WHERE owner_id=?").bind(user.id),
      c.env.DB.prepare(
        "UPDATE audit_logs SET actor_id=NULL,metadata_json='{}' WHERE actor_id=?",
      ).bind(user.id),
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id),
      c.env.DB.prepare(
        "DELETE FROM password_reset_tokens WHERE user_id=?",
      ).bind(user.id),
      c.env.DB.prepare("DELETE FROM email_verifications WHERE user_id=?").bind(
        user.id,
      ),
      c.env.DB.prepare("DELETE FROM team_invitations WHERE email=?").bind(
        user.email,
      ),
      c.env.DB.prepare("DELETE FROM payout_accounts WHERE user_id=?").bind(
        user.id,
      ),
      c.env.DB.prepare("DELETE FROM mfa_credentials WHERE user_id=?").bind(
        user.id,
      ),
      c.env.DB.prepare("DELETE FROM mfa_challenges WHERE user_id=?").bind(
        user.id,
      ),
      c.env.DB.prepare("DELETE FROM event_members WHERE user_id=?").bind(
        user.id,
      ),
      c.env.DB.prepare(
        "UPDATE users SET email=?,full_name='Deleted account',password_hash=?,email_verified_at=NULL,disabled_at=CURRENT_TIMESTAMP,auth_version=auth_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ).bind(
        `${uid("deleted")}@deleted.invalid`,
        await hashPassword(randomToken()),
        user.id,
      ),
      c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
        guard,
      ),
    ]);
    c.header("Set-Cookie", clearCookie());
    return c.json(
      {
        ok: true,
        note: "Account disabled and profile anonymized; owned event data removed and referenced files queued for deletion. An anonymous actor record remains for shared-event referential integrity. Provider-held records and backups have separate retention policies.",
      },
      202,
    );
  });
}
