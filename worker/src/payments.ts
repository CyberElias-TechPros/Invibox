import { contributionMatches } from "./commerce";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv, Bindings } from "./types";
import { json } from "./validation";
import { sha256, uid } from "./security";

export async function reconcilePayment(env: Bindings, reference: string) {
  let payment = await env.DB.prepare(
    "SELECT id,reference,purpose,amount_minor,currency,status,paid_at,initialization_state,subaccount_code FROM payments WHERE reference=?",
  )
    .bind(reference)
    .first<any>();
  if (!payment) throw new HTTPException(404, { message: "Payment not found" });
  if (
    env.PAYSTACK_SECRET_KEY &&
    ["pending", "initialized"].includes(payment.status)
  ) {
    await env.DB.prepare(
      "UPDATE payments SET last_verified_at=CURRENT_TIMESTAMP WHERE id=?",
    )
      .bind(payment.id)
      .run();
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    const result: any = await response.json();
    if (
      response.ok &&
      result.status &&
      contributionMatches(payment, result.data)
    ) {
      await env.DB.prepare(
        "UPDATE payments SET status='paid',paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','initialized')",
      )
        .bind(payment.id)
        .run();
      payment = await env.DB.prepare(
        "SELECT id,reference,purpose,amount_minor,currency,status,paid_at,initialization_state,subaccount_code FROM payments WHERE id=?",
      )
        .bind(payment.id)
        .first<any>();
    }
  }
  return payment;
}
export async function initializePayment(c: Context<AppEnv>) {
  if (!c.env.PAYSTACK_SECRET_KEY)
    throw new HTTPException(503, {
      message: "Gift payments are not configured for this environment",
    });
  const body = await json(
    c.req.raw,
    z.object({
      slug: z.string().min(2).max(100),
      token: z.string().max(200).optional(),
      email: z
        .string()
        .email()
        .max(254)
        .transform((x) => x.toLowerCase()),
      amount: z
        .number()
        .min(100)
        .max(100000000)
        .refine(
          (x) => Math.abs(x * 100 - Math.round(x * 100)) < 0.00001,
          "Use at most two decimal places",
        ),
      purpose: z.enum(["gift", "contribution"]).default("gift"),
    }),
  );
  const requestKey = c.req.header("Idempotency-Key");
  if (!requestKey || !/^[a-zA-Z0-9_-]{20,100}$/.test(requestKey))
    throw new HTTPException(428, {
      message: "A stable payment Idempotency-Key is required",
    });
  const event = await c.env.DB.prepare(
    "SELECT e.id,e.owner_id,e.visibility,e.settings_json,u.email_verified_at FROM events e JOIN users u ON u.id=e.owner_id WHERE slug=? AND lifecycle IN ('published','active','live')",
  )
    .bind(body.slug)
    .first<any>();
  if (!event)
    throw new HTTPException(404, {
      message: "Event is not accepting payments",
    });
  const guest = body.token
    ? await c.env.DB.prepare(
        "SELECT id FROM guests WHERE event_id=? AND access_token_hash=?",
      )
        .bind(event.id, await sha256(body.token))
        .first<any>()
    : null;
  if ((body.token && !guest) || (event.visibility !== "public" && !guest))
    throw new HTTPException(404, { message: "Invitation not found" });
  if (c.env.APP_ENV !== "development" && !event.email_verified_at)
    throw new HTTPException(403, {
      message:
        "The organizer must verify their account before accepting contributions",
    });
  if (!JSON.parse(event.settings_json).capabilities?.includes("gifts"))
    throw new HTTPException(409, {
      message: "Gifting is not enabled for this event",
    });
  const payout = await c.env.DB.prepare(
    "SELECT subaccount_code FROM payout_accounts WHERE user_id=? AND state='verified'",
  )
    .bind(event.owner_id)
    .first<{ subaccount_code: string }>();
  if (!payout?.subaccount_code)
    throw new HTTPException(409, {
      message:
        "The organizer must complete verified payout onboarding before accepting contributions. No fallback to the platform merchant is allowed.",
    });
  const amountMinor = Math.round(body.amount * 100);
  const payloadHash = await sha256(
    JSON.stringify({
      eventId: event.id,
      guestId: guest?.id || null,
      email: body.email,
      amountMinor,
      purpose: body.purpose,
    }),
  );
  await c.env.DB.prepare(
    "INSERT INTO payments(id,event_id,guest_id,provider,reference,purpose,amount_minor,status,request_key,request_hash,initialization_state,subaccount_code) VALUES(?,?,?,'paystack',?,?,?,'pending',?,?,'reserved',?) ON CONFLICT DO NOTHING",
  )
    .bind(
      uid("pmt"),
      event.id,
      guest?.id || null,
      uid("pay"),
      body.purpose,
      amountMinor,
      requestKey,
      payloadHash,
      payout.subaccount_code,
    )
    .run();
  let payment = await c.env.DB.prepare(
    "SELECT * FROM payments WHERE event_id=? AND request_key=?",
  )
    .bind(event.id, requestKey)
    .first<any>();
  if (payment.request_hash !== payloadHash)
    throw new HTTPException(409, {
      message:
        "This payment key was used for a different contribution. Do not reuse it with changed details.",
    });
  if (["paid", "refunded"].includes(payment.status))
    return c.json({
      reference: payment.reference,
      status: payment.status,
      message:
        "This contribution already has a final status. No new charge was created.",
    });
  if (
    !payment.subaccount_code ||
    payment.subaccount_code !== payout.subaccount_code
  )
    throw new HTTPException(409, {
      message:
        "This existing payment uses a previous payout route. The organizer must reconcile it before any new checkout; do not pay twice.",
    });
  if (payment.checkout_url)
    return c.json({
      reference: payment.reference,
      status: "initialized",
      checkoutUrl: payment.checkout_url,
    });
  if (payment.initialization_state === "rejected")
    throw new HTTPException(409, {
      message:
        "This checkout request was rejected. Start a new contribution only after correcting the details.",
    });
  const claimed = await c.env.DB.prepare(
    "UPDATE payments SET initialization_state='requesting',updated_at=CURRENT_TIMESTAMP WHERE id=? AND initialization_state='reserved' RETURNING id",
  )
    .bind(payment.id)
    .first();
  if (!claimed) {
    try {
      payment = await reconcilePayment(c.env, payment.reference);
    } catch {
      /* Return the stored capability; never create a second checkout. */
    }
    return c.json(
      {
        reference: payment.reference,
        status: payment.status === "paid" ? "paid" : "pending",
        message:
          "This request already exists. If checkout did not open, keep this reference and contact the organizer; do not pay again until it is reconciled.",
      },
      payment.status === "paid" ? 200 : 202,
    );
  }
  try {
    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${c.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: body.email,
          amount: amountMinor,
          currency: "NGN",
          reference: payment.reference,
          subaccount: payment.subaccount_code,
          transaction_charge: 0,
          bearer: "subaccount",
          callback_url: `${c.env.APP_ORIGIN}/invite/${body.slug}?payment=${encodeURIComponent(payment.reference)}`,
          metadata: {
            event_id: event.id,
            payment_id: payment.id,
            purpose: body.purpose,
          },
        }),
      },
    );
    const result: any = await response.json();
    if (!response.ok || !result.status) {
      if (
        response.status >= 400 &&
        response.status < 500 &&
        ![408, 409, 425, 429].includes(response.status)
      ) {
        await c.env.DB.prepare(
          "UPDATE payments SET status='failed',initialization_state='rejected',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'",
        )
          .bind(payment.id)
          .run();
        throw new HTTPException(422, {
          message:
            "Checkout was rejected by the provider. Check the receipt email and contact the organizer before starting another contribution.",
        });
      }
      throw new Error("Ambiguous provider result");
    }
    const url = new URL(result.data?.authorization_url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "checkout.paystack.com" ||
      url.username ||
      url.password
    )
      throw new Error("Unexpected checkout URL");
    await c.env.DB.prepare(
      "UPDATE payments SET status=CASE WHEN status='pending' THEN 'initialized' ELSE status END,initialization_state='ready',checkout_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    )
      .bind(url.href, payment.id)
      .run();
    const stored = await c.env.DB.prepare(
      "SELECT status FROM payments WHERE id=?",
    )
      .bind(payment.id)
      .first<{ status: string }>();
    if (stored?.status === "paid")
      return c.json({
        reference: payment.reference,
        status: "paid",
        message:
          "Payment has already been confirmed. No additional checkout is required.",
      });
    return c.json(
      {
        reference: payment.reference,
        status: "initialized",
        checkoutUrl: url.href,
      },
      201,
    );
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    await c.env.DB.prepare(
      "UPDATE payments SET initialization_state='uncertain',updated_at=CURRENT_TIMESTAMP WHERE id=? AND initialization_state='requesting'",
    )
      .bind(payment.id)
      .run();
    return c.json(
      {
        reference: payment.reference,
        status: "pending",
        message:
          "The provider response was interrupted. Your request is saved; do not create another payment. Check this reference with your organizer.",
      },
      202,
    );
  }
}
