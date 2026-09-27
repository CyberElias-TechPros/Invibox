import type { Hono, MiddlewareHandler, Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./types";
import { json } from "./validation";
import {
  base32,
  encryptSecret,
  decryptSecret,
  matchTotp,
  mfaAvailable,
} from "./totp";
import { uid, randomToken, sha256, cookie, clearCookie } from "./security";
import { confirmPassword } from "./account";
const codeSchema = z.string().trim().min(6).max(64);
function configured(c: Context<AppEnv>) {
  if (!mfaAvailable(c.env))
    throw new HTTPException(503, {
      message:
        "Authenticator encryption is not configured. Contact the operator.",
    });
}
export async function loginChallenge(
  c: Context<AppEnv>,
  user: { id: string; auth_version: number },
) {
  const enabled = await c.env.DB.prepare(
    "SELECT enabled_at FROM mfa_credentials WHERE user_id=? AND enabled_at IS NOT NULL",
  )
    .bind(user.id)
    .first();
  if (!enabled) return null;
  const challenge = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO mfa_challenges(token_hash,user_id,auth_version,expires_at) VALUES(?,?,?,?)",
  )
    .bind(
      await sha256(challenge),
      user.id,
      user.auth_version,
      new Date(Date.now() + 300000).toISOString(),
    )
    .run();
  c.header("Set-Cookie", clearCookie());
  return c.json({ mfaRequired: true, challengeToken: challenge });
}
export async function proof(
  c: Context<AppEnv>,
  userId: string,
  code: string,
  mode: "enable" | "verify",
) {
  const window = Math.floor(Date.now() / 300000);
  const attempts = await c.env.DB.prepare(
    "INSERT INTO mfa_attempts(user_id,window_start,attempts) VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET attempts=CASE WHEN window_start=excluded.window_start THEN attempts+1 ELSE 1 END,window_start=excluded.window_start RETURNING attempts",
  )
    .bind(userId, window)
    .first<{ attempts: number }>();
  if ((attempts?.attempts || 0) > 20) {
    c.header(
      "Retry-After",
      String(300 - (Math.floor(Date.now() / 1000) % 300)),
    );
    throw new HTTPException(429, {
      message:
        "Too many authenticator attempts for this account. Wait up to five minutes before trying again.",
    });
  }
  const record = await c.env.DB.prepare(
    "SELECT * FROM mfa_credentials WHERE user_id=?",
  )
    .bind(userId)
    .first<any>();
  if (
    !record ||
    (mode === "verify" && !record.enabled_at) ||
    (mode === "enable" &&
      (record.enabled_at ||
        Date.parse(record.pending_expires_at) <= Date.now()))
  )
    throw new HTTPException(409, {
      message:
        "Authenticator setup changed or expired. Reload account security.",
    });
  const recovery =
    mode === "verify" && /^[a-fA-F0-9-]{32,39}$/.test(code)
      ? await sha256(`${userId}:${code.replaceAll("-", "").toLowerCase()}`)
      : null;
  let counter = -1;
  if (!recovery) {
    configured(c);
    counter = await matchTotp(
      await decryptSecret(c.env, userId, record.secret_ciphertext),
      code,
    );
  }
  if (counter < 0 && !recovery)
    throw new HTTPException(401, {
      message:
        "Invalid authenticator code. Check the device clock or use a recovery code.",
    });
  return c.env.DB.prepare(
    "INSERT INTO mfa_proof_guards(id,user_id,secret_ciphertext,mode,counter,recovery_hash) VALUES(?,?,?,?,?,?)",
  ).bind(
    uid("proof"),
    userId,
    record.secret_ciphertext,
    mode,
    counter,
    recovery,
  );
}
function revoke(c: Context<AppEnv>, userId: string) {
  return [
    c.env.DB.prepare(
      "UPDATE users SET auth_version=auth_version+1 WHERE id=?",
    ).bind(userId),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(userId),
    c.env.DB.prepare("DELETE FROM mfa_challenges WHERE user_id=?").bind(userId),
  ];
}
async function recoveryCodes(c: Context<AppEnv>, userId: string) {
  const codes = Array.from({ length: 10 }, () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join(""),
  );
  const statements = await Promise.all(
    codes.map(async (code) =>
      c.env.DB.prepare(
        "INSERT INTO mfa_recovery_codes(user_id,code_hash) VALUES(?,?)",
      ).bind(userId, await sha256(`${userId}:${code}`)),
    ),
  );
  return {
    codes: codes.map((code) => code.match(/.{4}/g)!.join("-")),
    statements,
  };
}
export function registerMfaRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.post("/api/v1/auth/mfa", async (c) => {
    const body = await json(
      c.req.raw,
      z.object({
        challengeToken: z.string().min(20).max(200),
        code: codeSchema,
      }),
    );
    const hash = await sha256(body.challengeToken);
    const challenge = await c.env.DB.prepare(
      "UPDATE mfa_challenges SET attempts=attempts+1 WHERE token_hash=? AND attempts<5 AND julianday(expires_at)>julianday('now') AND EXISTS(SELECT 1 FROM users u WHERE u.id=mfa_challenges.user_id AND u.auth_version=mfa_challenges.auth_version AND u.disabled_at IS NULL) RETURNING user_id,auth_version",
    )
      .bind(hash)
      .first<any>();
    if (!challenge)
      throw new HTTPException(401, {
        message:
          "Sign-in challenge expired or exhausted. Sign in with your password again.",
      });
    const token = randomToken(),
      guard = await proof(c, challenge.user_id, body.code, "verify");
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO mfa_login_claims(token_hash) VALUES(?)",
      ).bind(hash),
      guard,
      c.env.DB.prepare(
        "INSERT INTO sessions(id,user_id,token_hash,expires_at,user_agent,auth_version) VALUES(?,?,?,?,?,?)",
      ).bind(
        uid("ses"),
        challenge.user_id,
        await sha256(token + (c.env.SESSION_PEPPER || "")),
        new Date(Date.now() + 30 * 86400000).toISOString(),
        c.req.header("user-agent") || null,
        challenge.auth_version,
      ),
      c.env.DB.prepare("DELETE FROM mfa_proof_guards WHERE user_id=?").bind(
        challenge.user_id,
      ),
      c.env.DB.prepare("DELETE FROM mfa_login_claims WHERE token_hash=?").bind(
        hash,
      ),
    ]);
    c.header("Set-Cookie", cookie(token));
    const user = await c.env.DB.prepare(
      "SELECT id,email,full_name AS name FROM users WHERE id=?",
    )
      .bind(challenge.user_id)
      .first();
    return c.json({ user });
  });
  app.get("/api/v1/account/mfa", authenticate, async (c) => {
    const record = await c.env.DB.prepare(
      "SELECT enabled_at FROM mfa_credentials WHERE user_id=?",
    )
      .bind(c.get("userId"))
      .first<any>();
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM mfa_recovery_codes WHERE user_id=?",
    )
      .bind(c.get("userId"))
      .first<any>();
    return c.json({
      enabled: Boolean(record?.enabled_at),
      enabledAt: record?.enabled_at || null,
      recoveryCodesRemaining: count?.count || 0,
      available: mfaAvailable(c.env),
    });
  });
  app.post("/api/v1/account/mfa/setup", authenticate, rateLimit, async (c) => {
    configured(c);
    const body = await json(
      c.req.raw,
      z.object({ password: z.string().max(128) }),
    );
    const user = await confirmPassword(c, body.password),
      guardId = uid("guard");
    const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
    const result = await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO account_action_guards(id,user_id,password_hash) VALUES(?,?,?)",
      ).bind(guardId, user.id, user.password_hash),
      c.env.DB.prepare(
        "INSERT INTO mfa_credentials(user_id,secret_ciphertext,pending_expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET secret_ciphertext=excluded.secret_ciphertext,pending_expires_at=excluded.pending_expires_at,last_counter=-1 WHERE mfa_credentials.enabled_at IS NULL",
      ).bind(
        user.id,
        await encryptSecret(c.env, user.id, secret),
        new Date(Date.now() + 600000).toISOString(),
      ),
      c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
        guardId,
      ),
    ]);
    if (!result[1].meta.changes)
      throw new HTTPException(409, {
        message:
          "Authenticator already enabled. Disable it before replacing it.",
      });
    return c.json({
      secret,
      uri: `otpauth://totp/${encodeURIComponent(`Invibox:${user.email}`)}?secret=${secret}&issuer=Invibox&algorithm=SHA1&digits=6&period=30`,
    });
  });
  for (const action of ["enable", "disable", "recovery"] as const)
    app.post(
      `/api/v1/account/mfa/${action}`,
      authenticate,
      rateLimit,
      async (c) => {
        const body = await json(
          c.req.raw,
          z.object({ password: z.string().max(128), code: codeSchema }),
        );
        const user = await confirmPassword(c, body.password),
          guardId = uid("guard");
        const guard = await proof(
          c,
          user.id,
          body.code,
          action === "enable" ? "enable" : "verify",
        );
        const recovery =
          action === "disable" ? null : await recoveryCodes(c, user.id);
        const statements = [
          c.env.DB.prepare(
            "INSERT INTO account_action_guards(id,user_id,password_hash) VALUES(?,?,?)",
          ).bind(guardId, user.id, user.password_hash),
          guard,
          c.env.DB.prepare(
            "DELETE FROM mfa_recovery_codes WHERE user_id=?",
          ).bind(user.id),
        ];
        if (action === "disable")
          statements.push(
            c.env.DB.prepare(
              "DELETE FROM mfa_credentials WHERE user_id=?",
            ).bind(user.id),
          );
        else {
          if (action === "enable")
            statements.push(
              c.env.DB.prepare(
                "UPDATE mfa_credentials SET enabled_at=CURRENT_TIMESTAMP WHERE user_id=?",
              ).bind(user.id),
            );
          statements.push(...recovery!.statements);
        }
        if (action !== "recovery") statements.push(...revoke(c, user.id));
        statements.push(
          c.env.DB.prepare("DELETE FROM mfa_proof_guards WHERE user_id=?").bind(
            user.id,
          ),
          c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
            guardId,
          ),
        );
        await c.env.DB.batch(statements);
        if (action !== "recovery") c.header("Set-Cookie", clearCookie());
        return c.json({
          ok: true,
          recoveryCodes: recovery?.codes,
          signInRequired: action !== "recovery",
        });
      },
    );
}
