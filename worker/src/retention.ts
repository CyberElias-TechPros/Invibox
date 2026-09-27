import type { Hono, MiddlewareHandler, Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv, Bindings } from "./types";
import { json } from "./validation";
import { uid } from "./security";
import { confirmPassword } from "./account";
import { proof as mfaProof } from "./mfa";

async function admin(c: Context<AppEnv>) {
  const u = await c.env.DB.prepare(
    "SELECT id FROM users WHERE id=? AND platform_role='admin'",
  )
    .bind(c.get("userId"))
    .first();
  if (!u) throw new HTTPException(403, { message: "Admin required" });
}

export function registerRetentionRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.get("/api/v1/admin/retention", authenticate, async (c) => {
    await admin(c);
    const rows = await c.env.DB.prepare(
      "SELECT * FROM retention_policies ORDER BY category",
    ).all();
    return c.json({ policies: rows.results });
  });
  app.patch(
    "/api/v1/admin/retention/:category",
    authenticate,
    rateLimit,
    async (c) => {
      await admin(c);
      const body = await json(
        c.req.raw,
        z.object({
          retainDays: z.number().int().min(0).max(3650),
          password: z.string().max(128),
          code: z.string().max(64).optional(),
          reason: z.string().min(10).max(500),
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
          throw new HTTPException(401, { message: "MFA required" });
        stmts.push(await mfaProof(c, user.id, body.code, "verify"));
      }
      stmts.push(
        c.env.DB.prepare(
          "UPDATE retention_policies SET retain_days=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE category=?",
        ).bind(body.retainDays, user.id, c.req.param("category")),
        c.env.DB.prepare(
          "INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,metadata_json,request_id) VALUES(?,?,'retention.update','retention_policy',?,?,?)",
        ).bind(
          uid("aud"),
          user.id,
          c.req.param("category"),
          JSON.stringify({ retainDays: body.retainDays, reason: body.reason }),
          (c as any).get("requestId"),
        ),
        c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
          guardId,
        ),
        c.env.DB.prepare("DELETE FROM mfa_proof_guards WHERE user_id=?").bind(
          user.id,
        ),
      );
      await c.env.DB.batch(stmts);
      return c.json({ ok: true });
    },
  );
}

export async function applyRetention(env: Bindings) {
  const policies = await env.DB.prepare(
    "SELECT category,retain_days FROM retention_policies",
  ).all<{ category: string; retain_days: number }>();
  const map = new Map(policies.results.map((r) => [r.category, r.retain_days]));
  const tasks: any[] = [];
  if (map.has("analytics"))
    tasks.push(
      env.DB.prepare(
        "DELETE FROM analytics_events WHERE occurred_at < datetime('now', ? )",
      ).bind(`-${map.get("analytics")} days`),
    );
  if (map.has("audit"))
    tasks.push(
      env.DB.prepare(
        "DELETE FROM audit_logs WHERE created_at < datetime('now', ? ) AND event_id IS NOT NULL",
      ).bind(`-${map.get("audit")} days`),
    ); // keep platform audit longer if needed
  // media, announcements, consents, payments, billing are financial/operational and require reviewed deletion, not automatic purge here
  if (tasks.length) await env.DB.batch(tasks);
}
