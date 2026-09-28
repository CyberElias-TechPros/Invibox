import type { Bindings } from "./types";
import { uid } from "./security";

function taxRate(env: Bindings): number {
  const bps = parseInt(env.TAX_RATE_BPS || "0", 10);
  if (isNaN(bps) || bps < 0 || bps > 10000) return 0;
  return bps;
}

export async function generateInvoice(
  env: Bindings,
  opts: {
    userId: string;
    eventId?: string;
    billingReference?: string;
    subscriptionId?: string;
    amountMinor: number;
    currency?: string;
  },
) {
  const rate = taxRate(env);
  const tax = Math.round((opts.amountMinor * rate) / 10000);
  const total = opts.amountMinor + tax;
  const id = uid("inv");
  const number = `INV-${Date.now()}-${id.slice(-6).toUpperCase()}`;
  await env.DB.prepare(
    "INSERT INTO invoices(id,invoice_number,user_id,event_id,billing_reference,subscription_id,amount_minor,tax_minor,total_minor,currency,status,issued_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      number,
      opts.userId,
      opts.eventId || null,
      opts.billingReference || null,
      opts.subscriptionId || null,
      opts.amountMinor,
      tax,
      total,
      opts.currency || "NGN",
      "issued",
      new Date().toISOString(),
    )
    .run();
  return { id, number, tax, total };
}

export async function getInvoices(env: Bindings, userId: string) {
  const rows = await env.DB.prepare(
    "SELECT id,invoice_number,event_id,billing_reference,subscription_id,amount_minor,tax_minor,total_minor,currency,status,issued_at FROM invoices WHERE user_id=? ORDER BY issued_at DESC LIMIT 50",
  )
    .bind(userId)
    .all();
  return rows.results;
}
