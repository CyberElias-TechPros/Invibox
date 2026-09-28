import type { Hono, MiddlewareHandler, Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv, Bindings } from "./types";
import { json } from "./validation";
import { uid } from "./security";
import { confirmPassword } from "./account";
import { proof as mfaProof } from "./mfa";
import { paystack } from "./commerce";

async function owner(c: Context<AppEnv>, eventId: string) {
  const row = await c.env.DB.prepare(
    "SELECT * FROM events WHERE id=? AND owner_id=?",
  )
    .bind(eventId, c.get("userId"))
    .first();
  if (!row) throw new HTTPException(404, { message: "Owned event not found" });
  return row;
}
async function admin(c: Context<AppEnv>) {
  const u = await c.env.DB.prepare(
    "SELECT id FROM users WHERE id=? AND platform_role='admin'",
  )
    .bind(c.get("userId"))
    .first();
  if (!u) throw new HTTPException(403, { message: "Platform admin required" });
}

export function registerRefundRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.post(
    "/api/v1/events/:eventId/refunds",
    authenticate,
    rateLimit,
    async (c) => {
      const event = await owner(c, c.req.param("eventId"));
      const body = await json(
        c.req.raw,
        z.object({
          kind: z.enum(["contribution", "package"]),
          reference: z.string().min(3).max(100),
          amount: z.number().positive().max(100000000).optional(),
          reason: z.string().trim().min(10).max(500),
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
            message: "MFA code required for refund request",
          });
        stmts.push(await mfaProof(c, user.id, body.code, "verify"));
      }
      let amountMinor: number;
      let paymentRef: string | null = null;
      let billingRef: string | null = null;
      if (body.kind === "contribution") {
        const pay = await c.env.DB.prepare(
          "SELECT reference,amount_minor,status FROM payments WHERE reference=? AND event_id=?",
        )
          .bind(body.reference, event.id)
          .first<any>();
        if (!pay || pay.status !== "paid")
          throw new HTTPException(404, {
            message: "Paid contribution not found",
          });
        const requested = body.amount
          ? Math.round(body.amount * 100)
          : pay.amount_minor;
        if (requested > pay.amount_minor)
          throw new HTTPException(422, {
            message: "Refund exceeds original amount",
          });
        amountMinor = requested;
        paymentRef = pay.reference;
      } else {
        const bill = await c.env.DB.prepare(
          "SELECT reference,amount_minor,status FROM billing_orders WHERE reference=? AND event_id=?",
        )
          .bind(body.reference, event.id)
          .first<any>();
        if (!bill || bill.status !== "paid")
          throw new HTTPException(404, {
            message: "Paid package order not found",
          });
        amountMinor = body.amount
          ? Math.round(body.amount * 100)
          : bill.amount_minor;
        if (amountMinor > bill.amount_minor)
          throw new HTTPException(422, {
            message: "Refund exceeds original amount",
          });
        billingRef = bill.reference;
      }
      const id = uid("ref");
      stmts.push(
        c.env.DB.prepare(
          "INSERT INTO refund_requests(id,kind,payment_reference,billing_reference,event_id,requester_id,amount_minor,reason,status) VALUES(?,?,?,?,?,?,?,?,?)",
        ).bind(
          id,
          body.kind,
          paymentRef,
          billingRef,
          event.id,
          user.id,
          amountMinor,
          body.reason,
          "requested",
        ),
        c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
          guardId,
        ),
        c.env.DB.prepare("DELETE FROM mfa_proof_guards WHERE user_id=?").bind(
          user.id,
        ),
      );
      await c.env.DB.batch(stmts);
      return c.json({ id, status: "requested" }, 201);
    },
  );

  app.get("/api/v1/events/:eventId/refunds", authenticate, async (c) => {
    await owner(c, c.req.param("eventId"));
    const rows = await c.env.DB.prepare(
      "SELECT id,kind,payment_reference,billing_reference,amount_minor,reason,status,created_at FROM refund_requests WHERE event_id=? ORDER BY created_at DESC LIMIT 50",
    )
      .bind(c.req.param("eventId"))
      .all();
    return c.json({ refunds: rows.results });
  });

  app.get("/api/v1/admin/refunds", authenticate, async (c) => {
    await admin(c);
    const rows = await c.env.DB.prepare(
      "SELECT id,kind,payment_reference,billing_reference,event_id,amount_minor,reason,status,created_at FROM refund_requests WHERE status IN ('requested','approved','processing') ORDER BY created_at LIMIT 100",
    ).all();
    return c.json({ refunds: rows.results });
  });

  app.post(
    "/api/v1/admin/refunds/:id/approve",
    authenticate,
    rateLimit,
    async (c) => {
      await admin(c);
      const body = await json(
        c.req.raw,
        z.object({
          password: z.string().max(128),
          code: z.string().max(64).optional(),
          note: z.string().min(10).max(500),
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
      const reqRow = await c.env.DB.prepare(
        "SELECT * FROM refund_requests WHERE id=? AND status='requested'",
      )
        .bind(c.req.param("id"))
        .first<any>();
      if (!reqRow)
        throw new HTTPException(404, { message: "Refund request not found" });
      stmts.push(
        c.env.DB.prepare(
          "UPDATE refund_requests SET status='approved',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        ).bind(user.id, body.note, reqRow.id),
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

  app.post(
    "/api/v1/admin/refunds/:id/process",
    authenticate,
    rateLimit,
    async (c) => {
      await admin(c);
      const body = await json(
        c.req.raw,
        z.object({
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
          throw new HTTPException(401, { message: "MFA required" });
        stmts.push(await mfaProof(c, user.id, body.code, "verify"));
      }
      const reqRow = await c.env.DB.prepare(
        "SELECT * FROM refund_requests WHERE id=? AND status='approved'",
      )
        .bind(c.req.param("id"))
        .first<any>();
      if (!reqRow)
        throw new HTTPException(404, {
          message: "Refund not approved or already processed",
        });
      await c.env.DB.batch(stmts); // claim guard before external call
      try {
        let providerId: string | null = null;
        if (reqRow.payment_reference) {
          // Paystack refund requires transaction id, but we have reference; verification will resolve id via previous paystack call
          const data = await paystack(c.env, `/refund`, {
            transaction: reqRow.payment_reference,
            amount: reqRow.amount_minor,
          });
          providerId = String(data.id || data.reference || "");
        } else {
          // For package refunds, we still use Paystack refund API with billing reference
          const data = await paystack(c.env, `/refund`, {
            transaction: reqRow.billing_reference,
            amount: reqRow.amount_minor,
          });
          providerId = String(data.id || data.reference || "");
        }
        await c.env.DB.batch([
          c.env.DB.prepare(
            "UPDATE refund_requests SET status='processing',provider_refund_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
          ).bind(providerId, reqRow.id),
          c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
            guardId,
          ),
          c.env.DB.prepare("DELETE FROM mfa_proof_guards WHERE user_id=?").bind(
            user.id,
          ),
        ]);
        return c.json({ ok: true, providerRefundId: providerId });
      } catch (e) {
        await c.env.DB.batch([
          c.env.DB.prepare(
            "UPDATE refund_requests SET status='failed',updated_at=CURRENT_TIMESTAMP WHERE id=?",
          ).bind(reqRow.id),
          c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
            guardId,
          ),
          c.env.DB.prepare("DELETE FROM mfa_proof_guards WHERE user_id=?").bind(
            user.id,
          ),
        ]);
        throw e;
      }
    },
  );

  app.post(
    "/api/v1/admin/refunds/:id/reject",
    authenticate,
    rateLimit,
    async (c) => {
      await admin(c);
      const body = await json(
        c.req.raw,
        z.object({
          password: z.string().max(128),
          code: z.string().max(64).optional(),
          note: z.string().min(10).max(500),
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
          "UPDATE refund_requests SET status='rejected',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,review_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='requested'",
        ).bind(user.id, body.note, c.req.param("id")),
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

export async function ingestRefundWebhook(env: Bindings, data: any) {
  // Paystack refund webhook or dispute: update our records
  if (data.event === "refund.processed" || data.event === "refund.failed") {
    const ref = data.data?.transaction_reference || data.data?.reference;
    const status = data.event === "refund.processed" ? "refunded" : "failed";
    await env.DB.prepare(
      "UPDATE refund_requests SET status=?,provider_status=?,updated_at=CURRENT_TIMESTAMP WHERE payment_reference=? OR billing_reference=?",
    )
      .bind(status, data.data?.status || data.event, ref, ref)
      .run();
    if (status === "refunded" && data.data?.transaction_reference) {
      await env.DB.prepare(
        "UPDATE payments SET status='refunded',refunded_minor=amount_minor,updated_at=CURRENT_TIMESTAMP WHERE reference=?",
      )
        .bind(data.data.transaction_reference)
        .run();
    }
  }
  if (data.event?.startsWith("dispute")) {
    const d = data.data;
    if (d?.id && d?.transaction_reference) {
      await env.DB.prepare(
        "INSERT INTO dispute_events(id,payment_reference,provider_dispute_id,status,amount_minor,reason) VALUES(?,?,?,?,?,?) ON CONFLICT(provider_dispute_id) DO UPDATE SET status=excluded.status,updated_at=CURRENT_TIMESTAMP",
      )
        .bind(
          uid("dsp"),
          d.transaction_reference,
          String(d.id),
          d.status || data.event,
          d.amount || 0,
          d.reason || null,
        )
        .run();
    }
  }
}
