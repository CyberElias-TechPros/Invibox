import type { Bindings } from "./types";
import { uid } from "./security";
import { paystack } from "./commerce";

export async function ingestSettlements(env: Bindings) {
  if (!env.PAYSTACK_SECRET_KEY) return;
  try {
    // List recent settlements; Paystack API: /settlement?perPage=...
    const data = await paystack(env, "/settlement?perPage=10");
    const batches = Array.isArray(data) ? data : data.data || [];
    for (const b of batches.slice(0,5)) {
      const batchId = String(b.id || b.settlement_code || b.reference);
      const existing = await env.DB.prepare("SELECT id FROM settlement_batches WHERE provider_batch_id=?").bind(batchId).first();
      if (existing) continue;
      const id = uid("stl");
      await env.DB.prepare("INSERT INTO settlement_batches(id,provider_batch_id,total_minor,fee_minor,net_minor,currency,settled_at) VALUES(?,?,?,?,?,?,?)")
        .bind(id, batchId, Math.round((b.total_amount||0)*100)||0, Math.round((b.fees||0)*100)||0, Math.round(((b.total_amount||0)-(b.fees||0))*100)||0, b.currency||"NGN", b.settlement_date||b.createdAt||new Date().toISOString()).run();
      // Fetch transactions for this settlement if API supports, else skip items
      try {
        const txs = await paystack(env, `/settlement/${batchId}/transactions?perPage=20`);
        const items = Array.isArray(txs) ? txs : txs.data || [];
        for (const t of items.slice(0,20)) {
          if (!t.reference) continue;
          const pay = await env.DB.prepare("SELECT reference,subaccount_code FROM payments WHERE reference=?").bind(t.reference).first<any>();
          if (!pay) continue;
          await env.DB.batch([
            env.DB.prepare("INSERT INTO settlement_items(id,batch_id,payment_reference,subaccount_code,amount_minor,fee_minor,net_minor) VALUES(?,?,?,?,?,?,?)")
              .bind(uid("stli"), id, t.reference, pay.subaccount_code||null, Math.round((t.amount||0)), Math.round((t.fees||0)), Math.round((t.amount||0)-(t.fees||0))),
            env.DB.prepare("UPDATE payments SET settlement_batch_id=?,settlement_status='settled',updated_at=CURRENT_TIMESTAMP WHERE reference=?").bind(id, t.reference)
          ]);
        }
      } catch {}
    }
  } catch (e) {
    console.warn(JSON.stringify({ code: "SETTLEMENT_INGESTION_UNAVAILABLE" }));
  }
}
