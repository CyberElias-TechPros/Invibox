import type { Hono, Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv, Bindings } from "./types";
import { json } from "./validation";
import { uid, hmacSha512 } from "./security";
import { confirmPassword, requireVerified } from "./account";
import { proof as mfaProof } from "./mfa";
import { paymentMatches } from "./domain";
const limits = z.object({
  guests: z.number().int().min(0).max(5000),
  occasions: z.number().int().min(0).max(100),
  collaborators: z.number().int().min(0).max(100),
  photos: z.number().int().min(0).max(2000),
  storage: z.number().int().min(0).max(2147483648),
  messages: z.number().int().min(0).max(100000),
});
function payoutKey(env: Bindings) {
  if (!env.PAYOUT_VERIFICATION_KEY || env.PAYOUT_VERIFICATION_KEY.length < 32)
    throw new HTTPException(503, {
      message: "Payout verification key is not configured",
    });
  return env.PAYOUT_VERIFICATION_KEY;
}
export async function paystack(env: Bindings, path: string, body?: unknown) {
  if (!env.PAYSTACK_SECRET_KEY)
    throw new HTTPException(503, { message: "Paystack is not configured" });
  try {
    const response = await fetch(`https://api.paystack.co${path}`, {
      method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data: any = await response.json();
    if (!response.ok || !data.status)
      throw new HTTPException(502, {
        message:
          "Paystack could not complete this request. Verify the existing reference before retrying.",
      });
    return data.data;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(502, {
      message:
        "Paystack is unavailable. Reconcile existing requests before retrying.",
    });
  }
}
async function owner(c: Context<AppEnv>) {
  const event = await c.env.DB.prepare(
    "SELECT * FROM events WHERE id=? AND owner_id=?",
  )
    .bind(c.req.param("eventId"), c.get("userId"))
    .first<any>();
  if (!event)
    throw new HTTPException(404, { message: "Owned event not found" });
  return event;
}
async function admin(c: Context<AppEnv>) {
  const user = await c.env.DB.prepare(
    "SELECT id FROM users WHERE id=? AND platform_role='admin' AND disabled_at IS NULL",
  )
    .bind(c.get("userId"))
    .first();
  if (!user)
    throw new HTTPException(403, {
      message: "Platform administrator access required",
    });
}
async function security(c: Context<AppEnv>, password: string, code?: string) {
  const user = await confirmPassword(c, password);
  const enabled = await c.env.DB.prepare(
    "SELECT enabled_at FROM mfa_credentials WHERE user_id=? AND enabled_at IS NOT NULL",
  )
    .bind(user.id)
    .first();
  const guard = uid("guard"),
    stmts = [
      c.env.DB.prepare(
        "INSERT INTO account_action_guards(id,user_id,password_hash) VALUES(?,?,?)",
      ).bind(guard, user.id, user.password_hash),
    ];
  if (enabled) {
    if (!code)
      throw new HTTPException(401, {
        message:
          "Authenticator or recovery code required for this financial change",
      });
    stmts.push(await mfaProof(c, user.id, code, "verify"));
  }
  return {
    user,
    stmts,
    cleanup: [
      c.env.DB.prepare("DELETE FROM account_action_guards WHERE id=?").bind(
        guard,
      ),
      c.env.DB.prepare("DELETE FROM mfa_proof_guards WHERE user_id=?").bind(
        user.id,
      ),
    ],
  };
}
function payoutGuard(c: Context<AppEnv>, account: any) {
  const id = uid("review");
  return {
    claim: c.env.DB.prepare(
      "INSERT INTO payout_review_guards(id,user_id,request_id,expected_state,expected_subaccount) VALUES(?,?,?,?,?)",
    ).bind(
      id,
      account.user_id,
      account.request_id,
      account.state,
      account.subaccount_code,
    ),
    release: c.env.DB.prepare(
      "DELETE FROM payout_review_guards WHERE id=?",
    ).bind(id),
  };
}
function noSplit(value: unknown) {
  return (
    value == null ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
}
export async function settleBilling(env: Bindings, data: any) {
  const order = await env.DB.prepare(
    "SELECT * FROM billing_orders WHERE reference=?",
  )
    .bind(data.reference)
    .first<any>();
  if (!order) return false;
  if (
    !paymentMatches(order, data) ||
    !noSplit(data.subaccount) ||
    !noSplit(data.split)
  )
    throw new HTTPException(422, {
      message:
        "Package payment reference, amount, currency or status does not match",
    });
  await env.DB.prepare(
    "UPDATE billing_orders SET status='paid',paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP) WHERE reference=? AND status<>'paid'",
  )
    .bind(order.reference)
    .run();
  return true;
}
export async function reconcileOrder(env: Bindings, reference: string) {
  await env.DB.prepare(
    "UPDATE billing_orders SET last_verified_at=CURRENT_TIMESTAMP WHERE reference=?",
  )
    .bind(reference)
    .run();
  const data = await paystack(
    env,
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );
  if (data.status === "success") await settleBilling(env, data);
  return data;
}
export async function reconcileBilling(env: Bindings) {
  const rows = await env.DB.prepare(
    "SELECT reference FROM billing_orders WHERE status IN ('requesting','initialized','uncertain') AND created_at>datetime('now','-7 days') AND (last_verified_at IS NULL OR julianday(last_verified_at)<julianday('now','-30 minutes')) ORDER BY COALESCE(last_verified_at,created_at) LIMIT 5",
  ).all<{ reference: string }>();
  for (const row of rows.results) {
    try {
      await reconcileOrder(env, row.reference);
    } catch {
      console.warn(
        JSON.stringify({ code: "BILLING_RECONCILIATION_UNAVAILABLE" }),
      );
    }
  }
}
export function contributionMatches(payment: any, data: any) {
  return (
    paymentMatches(payment, data) &&
    (!payment.subaccount_code ||
      (data.subaccount?.subaccount_code || data.subaccount) ===
        payment.subaccount_code)
  );
}
export function registerCommerceRoutes(
  app: Hono<AppEnv>,
  authenticate: MiddlewareHandler<AppEnv>,
  rateLimit: MiddlewareHandler<AppEnv>,
) {
  app.get("/api/v1/plans", async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT * FROM plan_catalog ORDER BY kind DESC,tier,price_minor",
    ).all();
    return c.json({ plans: rows.results });
  });
  app.get("/api/v1/events/:eventId/billing", authenticate, async (c) => {
    const event = await owner(c);
    const entitlement = await c.env.DB.prepare(
      "SELECT * FROM event_entitlements WHERE event_id=?",
    )
      .bind(event.id)
      .first();
    const orders = await c.env.DB.prepare(
      "SELECT reference,product_code,amount_minor,currency,status,created_at,paid_at,checkout_url,request_key FROM billing_orders WHERE event_id=? ORDER BY created_at DESC LIMIT 50",
    )
      .bind(event.id)
      .all();
    const usage = await c.env.DB.prepare(
      "SELECT (SELECT COALESCE(SUM(party_size),0) FROM guests WHERE event_id=?) AS guests,(SELECT COUNT(*) FROM occasions WHERE event_id=?) AS occasions,(SELECT COUNT(*) FROM event_members WHERE event_id=? AND role<>'owner') AS collaborators,(SELECT COUNT(*) FROM media WHERE event_id=?) AS photos,(SELECT COALESCE(SUM(size_bytes),0) FROM media WHERE event_id=?) AS storage",
    )
      .bind(event.id, event.id, event.id, event.id, event.id)
      .first();
    return c.json({ entitlement, usage, orders: orders.results });
  });
  app.post(
    "/api/v1/events/:eventId/billing/checkout",
    authenticate,
    rateLimit,
    async (c) => {
      const event = await owner(c);
      await requireVerified(c);
      if (["completed", "archived"].includes(event.lifecycle))
        throw new HTTPException(409, {
          message: "This event is closed to package purchases",
        });
      if (!c.env.PAYSTACK_SECRET_KEY)
        throw new HTTPException(503, {
          message: "Package checkout is not configured",
        });
      const body = await json(
          c.req.raw,
          z.object({
            product: z.string().max(60),
            expectedPriceMinor: z.number().int().positive(),
          }),
        ),
        key = c.req.header("Idempotency-Key");
      if (!key || !/^[a-zA-Z0-9_-]{20,100}$/.test(key))
        throw new HTTPException(428, {
          message: "A stable checkout Idempotency-Key is required",
        });
      let order = await c.env.DB.prepare(
        "SELECT * FROM billing_orders WHERE event_id=? AND request_key=?",
      )
        .bind(event.id, key)
        .first<any>();
      if (
        order &&
        (order.product_code !== body.product ||
          order.amount_minor !== body.expectedPriceMinor)
      )
        throw new HTTPException(409, {
          message: "This checkout key belongs to another package",
        });
      if (!order) {
        const product = await c.env.DB.prepare(
          "SELECT * FROM plan_catalog WHERE code=? AND active=1 AND price_minor>0",
        )
          .bind(body.product)
          .first<any>();
        if (!product)
          throw new HTTPException(409, {
            message: "This package is not available for purchase",
          });
        if (product.price_minor !== body.expectedPriceMinor)
          throw new HTTPException(409, {
            message: "The package price changed. Refresh before purchasing.",
          });
        const q = await c.env.DB.prepare(
          "SELECT * FROM event_entitlements WHERE event_id=?",
        )
          .bind(event.id)
          .first<any>();
        if (product.kind === "plan" && product.tier <= q.tier)
          throw new HTTPException(409, {
            message: "This event already has this package level or higher",
          });
        const caps = limits.parse(JSON.parse(product.limits_json));
        if (
          product.kind === "pack" &&
          (q.guest_limit + caps.guests > 5000 ||
            q.photo_limit + caps.photos > 2000 ||
            q.storage_limit + caps.storage > 2147483648 ||
            q.occasion_limit + caps.occasions > 100 ||
            q.collaborator_limit + caps.collaborators > 100 ||
            q.message_limit + caps.messages > 100000)
        )
          throw new HTTPException(409, {
            message: "This pack exceeds the supported event capacity",
          });
        await c.env.DB.prepare(
          "INSERT INTO billing_orders(reference,event_id,owner_id,request_key,product_code,kind,tier,amount_minor,limits_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        )
          .bind(
            uid("bill"),
            event.id,
            event.owner_id,
            key,
            product.code,
            product.kind,
            product.tier,
            product.price_minor,
            JSON.stringify(caps),
          )
          .run();
        order = await c.env.DB.prepare(
          "SELECT * FROM billing_orders WHERE event_id=? AND request_key=?",
        )
          .bind(event.id, key)
          .first<any>();
      }
      if (!order)
        throw new HTTPException(409, {
          message:
            "An existing package order needs reconciliation before another purchase.",
        });
      if (order.status === "rejected")
        throw new HTTPException(409, {
          message:
            "This order was closed by support. Start a new purchase only if you still need it.",
        });
      if (order.status === "paid")
        return c.json({ reference: order.reference, status: "paid" });
      if (order.checkout_url)
        return c.json({
          reference: order.reference,
          status: order.status,
          checkoutUrl: order.checkout_url,
        });
      const claimed = await c.env.DB.prepare(
        "UPDATE billing_orders SET status='requesting' WHERE reference=? AND status='reserved' RETURNING reference",
      )
        .bind(order.reference)
        .first();
      if (!claimed)
        return c.json(
          {
            reference: order.reference,
            status: order.status,
            message:
              "An existing checkout is awaiting reconciliation. Do not pay again.",
          },
          202,
        );
      try {
        const user = await c.env.DB.prepare(
          "SELECT email FROM users WHERE id=?",
        )
          .bind(event.owner_id)
          .first<any>();
        const data = await paystack(c.env, "/transaction/initialize", {
          email: user.email,
          amount: order.amount_minor,
          currency: "NGN",
          reference: order.reference,
          callback_url: `${c.env.APP_ORIGIN}/app?billing=${encodeURIComponent(order.reference)}&billingEvent=${encodeURIComponent(event.id)}`,
          metadata: {
            kind: "invibox_package",
            event_id: event.id,
            product_code: order.product_code,
          },
        });
        const url = new URL(data.authorization_url);
        if (
          url.protocol !== "https:" ||
          url.hostname !== "checkout.paystack.com" ||
          url.username ||
          url.password
        )
          throw new Error("Invalid checkout URL");
        await c.env.DB.prepare(
          "UPDATE billing_orders SET status='initialized',checkout_url=? WHERE reference=? AND status='requesting'",
        )
          .bind(url.href, order.reference)
          .run();
        const final = await c.env.DB.prepare(
          "SELECT status FROM billing_orders WHERE reference=?",
        )
          .bind(order.reference)
          .first<any>();
        return c.json(
          {
            reference: order.reference,
            status: final.status,
            ...(final.status === "initialized"
              ? { checkoutUrl: url.href }
              : {}),
          },
          201,
        );
      } catch {
        await c.env.DB.prepare(
          "UPDATE billing_orders SET status='uncertain' WHERE reference=? AND status='requesting'",
        )
          .bind(order.reference)
          .run();
        return c.json(
          {
            reference: order.reference,
            status: "uncertain",
            message:
              "Provider result is uncertain. Reconcile this reference; do not create a replacement charge.",
          },
          202,
        );
      }
    },
  );
  app.post(
    "/api/v1/events/:eventId/billing/:reference/reconcile",
    authenticate,
    rateLimit,
    async (c) => {
      const event = await owner(c);
      const order = await c.env.DB.prepare(
        "SELECT reference,status FROM billing_orders WHERE event_id=? AND reference=?",
      )
        .bind(event.id, c.req.param("reference"))
        .first<any>();
      if (!order) throw new HTTPException(404, { message: "Order not found" });
      if (order.status !== "paid") await reconcileOrder(c.env, order.reference);
      return c.json({ ok: true });
    },
  );
  app.get("/api/v1/account/payout", authenticate, async (c) =>
    c.json({
      account: await c.env.DB.prepare(
        "SELECT request_id,bank_code,bank_name,account_name,last_four,state,created_at,review_reason FROM payout_accounts WHERE user_id=?",
      )
        .bind(c.get("userId"))
        .first(),
    }),
  );
  app.get("/api/v1/account/payout/banks", authenticate, rateLimit, async (c) =>
    c.json({
      banks: await paystack(
        c.env,
        "/bank?country=nigeria&currency=NGN&perPage=100",
      ),
    }),
  );
  app.post("/api/v1/account/payout", authenticate, rateLimit, async (c) => {
    await requireVerified(c);
    if (!c.env.PAYSTACK_SECRET_KEY)
      throw new HTTPException(503, {
        message: "Organizer payout onboarding is not configured",
      });
    const body = await json(
      c.req.raw,
      z.object({
        password: z.string().max(128),
        code: z.string().max(64).optional(),
        bankCode: z.string().regex(/^[0-9]{3,10}$/),
        accountNumber: z.string().regex(/^[0-9]{10}$/),
        businessName: z.string().trim().min(2).max(100),
        consent: z.literal(true),
      }),
    );
    payoutKey(c.env);
    const auth = await security(c, body.password, body.code);
    const existing = await c.env.DB.prepare(
      "SELECT state FROM payout_accounts WHERE user_id=?",
    )
      .bind(auth.user.id)
      .first();
    if (existing)
      throw new HTTPException(409, {
        message:
          "A payout request already exists. Contact the platform operator to reconcile or replace it; do not create duplicate accounts.",
      });
    const banks = await paystack(
      c.env,
      "/bank?country=nigeria&currency=NGN&perPage=100",
    );
    const bank = banks.find((b: any) => b.code === body.bankCode);
    if (!bank)
      throw new HTTPException(422, {
        message: "Choose a supported Nigerian bank",
      });
    const resolved = await paystack(
      c.env,
      `/bank/resolve?account_number=${body.accountNumber}&bank_code=${body.bankCode}`,
    );
    if (
      !resolved.account_name ||
      resolved.account_number !== body.accountNumber
    )
      throw new HTTPException(422, {
        message: "Bank account could not be resolved",
      });
    const requestId = uid("payout");
    const hash = await hmacSha512(
      payoutKey(c.env),
      `${body.bankCode}:${body.accountNumber}`,
    );
    await c.env.DB.batch([
      ...auth.stmts,
      c.env.DB.prepare(
        "INSERT INTO payout_accounts(request_id,user_id,request_hash,bank_code,bank_name,account_name,last_four,state) VALUES(?,?,?,?,?,?,?,'requesting')",
      ).bind(
        requestId,
        auth.user.id,
        hash,
        body.bankCode,
        bank.name,
        resolved.account_name,
        body.accountNumber.slice(-4),
      ),
      ...auth.cleanup,
    ]);
    try {
      const data = await paystack(c.env, "/subaccount", {
        business_name: body.businessName,
        bank_code: body.bankCode,
        account_number: body.accountNumber,
        percentage_charge: 0,
        primary_contact_email: auth.user.email,
        metadata: JSON.stringify({
          invibox_owner_id: auth.user.id,
          invibox_request_id: requestId,
        }),
      });
      if (!/^ACCT_[a-zA-Z0-9]+$/.test(data.subaccount_code || ""))
        throw new Error("Invalid subaccount");
      await c.env.DB.prepare(
        "UPDATE payout_accounts SET subaccount_code=COALESCE(subaccount_code,?),bank_name=?,state=CASE WHEN state='requesting' THEN 'review' ELSE state END WHERE user_id=? AND request_id=?",
      )
        .bind(data.subaccount_code, bank.name, auth.user.id, requestId)
        .run();
      return c.json(
        {
          state: "review",
          message:
            "Bank details resolved. Platform identity review and Paystack verification are required before contributions can be accepted.",
        },
        202,
      );
    } catch {
      await c.env.DB.prepare(
        "UPDATE payout_accounts SET state='uncertain' WHERE user_id=? AND request_id=? AND state='requesting'",
      )
        .bind(auth.user.id, requestId)
        .run();
      return c.json(
        {
          state: "uncertain",
          message:
            "The provider result is uncertain. The operator must reconcile this request; do not submit again.",
        },
        202,
      );
    }
  });
  app.get("/api/v1/admin/commerce", authenticate, async (c) => {
    await admin(c);
    const accounts = await c.env.DB.prepare(
      "SELECT p.user_id,p.request_id,u.email,p.bank_name,p.account_name,p.last_four,p.state,p.subaccount_code FROM payout_accounts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 100",
    ).all();
    const orders = await c.env.DB.prepare(
      "SELECT reference,event_id,owner_id,product_code,amount_minor,status FROM billing_orders WHERE status IN ('reserved','requesting','uncertain','initialized') ORDER BY created_at LIMIT 100",
    ).all();
    return c.json({ accounts: accounts.results, orders: orders.results });
  });
  app.patch("/api/v1/admin/plans/:code", authenticate, rateLimit, async (c) => {
    await admin(c);
    const body = await json(
      c.req.raw,
      z.object({
        password: z.string().max(128),
        code: z.string().max(64).optional(),
        name: z.string().min(2).max(100),
        priceMinor: z.number().int().min(0).max(100000000),
        limits,
        active: z.boolean(),
      }),
    );
    const auth = await security(c, body.password, body.code),
      code = c.req.param("code");
    if (
      !(await c.env.DB.prepare("SELECT code FROM plan_catalog WHERE code=?")
        .bind(code)
        .first())
    )
      throw new HTTPException(404, { message: "Package not found" });
    if (
      code === "free" &&
      (body.priceMinor !== 0 ||
        !body.active ||
        body.limits.guests < 1 ||
        body.limits.occasions < 1)
    )
      throw new HTTPException(422, {
        message:
          "The free package must remain available with a zero price and usable limits",
      });
    if (code !== "free" && body.priceMinor < 10000)
      throw new HTTPException(422, {
        message: "Paid packages require a price of at least NGN 100",
      });
    await c.env.DB.batch([
      ...auth.stmts,
      c.env.DB.prepare(
        "UPDATE plan_catalog SET name=?,price_minor=?,limits_json=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE code=?",
      ).bind(
        body.name,
        body.priceMinor,
        JSON.stringify(body.limits),
        body.active ? 1 : 0,
        code,
      ),
      c.env.DB.prepare(
        "INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,metadata_json,request_id) VALUES(?,?,'plan.update','plan',?,?,?)",
      ).bind(
        uid("aud"),
        auth.user.id,
        code,
        JSON.stringify({ priceMinor: body.priceMinor, active: body.active }),
        c.get("requestId"),
      ),
      ...auth.cleanup,
    ]);
    return c.json({ ok: true });
  });
  app.post(
    "/api/v1/admin/billing/:reference/reconcile",
    authenticate,
    rateLimit,
    async (c) => {
      await admin(c);
      const found = await c.env.DB.prepare(
        "SELECT reference FROM billing_orders WHERE reference=?",
      )
        .bind(c.req.param("reference"))
        .first();
      if (!found) throw new HTTPException(404, { message: "Order not found" });
      await reconcileOrder(c.env, c.req.param("reference"));
      return c.json({ ok: true });
    },
  );
  app.post(
    "/api/v1/admin/billing/:reference/close",
    authenticate,
    rateLimit,
    async (c) => {
      await admin(c);
      const body = await json(
        c.req.raw,
        z.object({
          password: z.string().max(128),
          code: z.string().max(64).optional(),
          reason: z.string().trim().min(10).max(500),
          confirmation: z.literal(
            "Provider checkout cancelled; no payment received",
          ),
        }),
      );
      const auth = await security(c, body.password, body.code),
        reference = c.req.param("reference");
      const order = await c.env.DB.prepare(
        "SELECT status FROM billing_orders WHERE reference=?",
      )
        .bind(reference)
        .first<any>();
      if (!order) throw new HTTPException(404, { message: "Order not found" });
      if (order.status === "paid")
        throw new HTTPException(409, {
          message:
            "Paid orders cannot be closed. Use the refund review process.",
        });
      // Provider dashboard review/cancellation is a prerequisite, not inferred from a transient 404 or abandoned status.
      await c.env.DB.batch([
        ...auth.stmts,
        c.env.DB.prepare(
          "UPDATE billing_orders SET status='rejected',checkout_url=NULL,review_reason=? WHERE reference=? AND status<>'paid'",
        ).bind(body.reason, reference),
        c.env.DB.prepare(
          "INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,metadata_json,request_id) VALUES(?,?,'billing.close','billing_order',?,?,?)",
        ).bind(
          uid("aud"),
          auth.user.id,
          reference,
          JSON.stringify({
            reason: body.reason,
            confirmation: body.confirmation,
          }),
          c.get("requestId"),
        ),
        ...auth.cleanup,
      ]);
      return c.json({ ok: true });
    },
  );
  app.post(
    "/api/v1/admin/payouts/:userId/block",
    authenticate,
    rateLimit,
    async (c) => {
      await admin(c);
      const body = await json(
        c.req.raw,
        z.object({
          password: z.string().max(128),
          code: z.string().max(64).optional(),
          reason: z.string().trim().min(10).max(500),
        }),
      );
      const auth = await security(c, body.password, body.code),
        id = c.req.param("userId");
      if (
        !(await c.env.DB.prepare(
          "SELECT user_id FROM payout_accounts WHERE user_id=?",
        )
          .bind(id)
          .first())
      )
        throw new HTTPException(404, { message: "Payout request not found" });
      await c.env.DB.batch([
        ...auth.stmts,
        c.env.DB.prepare(
          "UPDATE payout_accounts SET state='blocked',reviewed_by=?,review_reason=?,reviewed_at=CURRENT_TIMESTAMP WHERE user_id=?",
        ).bind(auth.user.id, body.reason, id),
        c.env.DB.prepare(
          "INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,metadata_json,request_id) VALUES(?,?,'payout.block','user',?,?,?)",
        ).bind(
          uid("aud"),
          auth.user.id,
          id,
          JSON.stringify({ reason: body.reason }),
          c.get("requestId"),
        ),
        ...auth.cleanup,
      ]);
      return c.json({ ok: true });
    },
  );
  app.post(
    "/api/v1/admin/payouts/:userId/reset",
    authenticate,
    rateLimit,
    async (c) => {
      await admin(c);
      const body = await json(
        c.req.raw,
        z.object({
          password: z.string().max(128),
          code: z.string().max(64).optional(),
          reason: z.string().trim().min(10).max(500),
          confirmation: z.literal(
            "Provider absent or inactive; settlements reviewed",
          ),
        }),
      );
      const auth = await security(c, body.password, body.code),
        id = c.req.param("userId");
      const account = await c.env.DB.prepare(
        "SELECT * FROM payout_accounts WHERE user_id=?",
      )
        .bind(id)
        .first<any>();
      if (!account || account.state !== "blocked")
        throw new HTTPException(409, {
          message: "Block this payout request before reviewing a replacement.",
        });
      if (account.subaccount_code) {
        const data = await paystack(
          c.env,
          `/subaccount/${account.subaccount_code}`,
        );
        if (
          data.active !== false ||
          data.subaccount_code !== account.subaccount_code
        )
          throw new HTTPException(409, {
            message:
              "The previous provider subaccount must be deactivated before replacement.",
          });
      }
      const guard = payoutGuard(c, account);
      await c.env.DB.batch([
        ...auth.stmts,
        guard.claim,
        c.env.DB.prepare(
          "DELETE FROM payout_accounts WHERE user_id=? AND state='blocked' AND request_hash=?",
        ).bind(id, account.request_hash),
        c.env.DB.prepare(
          "INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,metadata_json,request_id) VALUES(?,?,'payout.reset','user',?,?,?)",
        ).bind(
          uid("aud"),
          auth.user.id,
          id,
          JSON.stringify({
            reason: body.reason,
            confirmation: body.confirmation,
            previousSubaccount: account.subaccount_code,
            bank: account.bank_name,
            lastFour: account.last_four,
          }),
          c.get("requestId"),
        ),
        guard.release,
        ...auth.cleanup,
      ]);
      return c.json({
        ok: true,
        message:
          "The organizer may submit new bank details. Existing payment routing is unchanged.",
      });
    },
  );
  app.post(
    "/api/v1/admin/payouts/:userId/verify",
    authenticate,
    rateLimit,
    async (c) => {
      await admin(c);
      const body = await json(
        c.req.raw,
        z.object({
          password: z.string().max(128),
          code: z.string().max(64).optional(),
          subaccountCode: z.string().regex(/^ACCT_[a-zA-Z0-9]+$/),
          identityReviewed: z.literal(true),
          reason: z.string().trim().min(10).max(500),
        }),
      );
      const auth = await security(c, body.password, body.code),
        id = c.req.param("userId");
      const account = await c.env.DB.prepare(
        "SELECT * FROM payout_accounts WHERE user_id=?",
      )
        .bind(id)
        .first<any>();
      if (!account)
        throw new HTTPException(404, { message: "Payout request not found" });
      const data = await paystack(c.env, `/subaccount/${body.subaccountCode}`);
      let metadata;
      try {
        metadata =
          typeof data.metadata === "string"
            ? JSON.parse(data.metadata)
            : data.metadata;
      } catch {
        throw new HTTPException(409, {
          message: "Provider ownership metadata is invalid",
        });
      }
      if (
        data.subaccount_code !== body.subaccountCode ||
        String(data.settlement_bank).trim().toLowerCase() !==
          String(account.bank_name).trim().toLowerCase() ||
        (data.bank_code && String(data.bank_code) !== account.bank_code) ||
        data.active !== true ||
        data.is_verified !== true ||
        metadata?.invibox_owner_id !== id ||
        metadata?.invibox_request_id !== account.request_id ||
        (await hmacSha512(
          payoutKey(c.env),
          `${account.bank_code}:${data.account_number}`,
        )) !== account.request_hash
      )
        throw new HTTPException(409, {
          message:
            "Provider verification, ownership metadata or bank details do not match. Do not approve this payout account.",
        });
      const guard = payoutGuard(c, account);
      await c.env.DB.batch([
        ...auth.stmts,
        guard.claim,
        c.env.DB.prepare(
          "UPDATE payout_accounts SET state='verified',subaccount_code=?,bank_name=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=?,review_reason=? WHERE user_id=? AND request_hash=? AND state=?",
        ).bind(
          body.subaccountCode,
          data.settlement_bank || account.bank_code,
          auth.user.id,
          body.reason,
          id,
          account.request_hash,
          account.state,
        ),
        c.env.DB.prepare(
          "INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,metadata_json,request_id) VALUES(?,?,'payout.verify','user',?,?,?)",
        ).bind(
          uid("aud"),
          auth.user.id,
          id,
          JSON.stringify({ reason: body.reason }),
          c.get("requestId"),
        ),
        guard.release,
        ...auth.cleanup,
      ]);
      return c.json({ ok: true });
    },
  );
}
