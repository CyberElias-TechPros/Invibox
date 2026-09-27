import { useEffect, useState } from "react";
import { api } from "./api";
import { csvCell, download } from "./files";
export default function PaymentsPanel({ eventId }: { eventId: string }) {
  const [data, setData] = useState<{
    payments: any[];
    totals: { count: number; paid_minor: number };
  }>({ payments: [], totals: { count: 0, paid_minor: 0 } });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = async () => {
    try {
      setData(await api.payments(eventId));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load payments");
    }
  };
  useEffect(() => {
    load();
  }, [eventId]);
  return (
    <section className="card content-editor">
      <h3>Contribution ledger</h3>
      <p>
        {data.totals.count} payment records · NGN{" "}
        {(data.totals.paid_minor / 100).toLocaleString()} confirmed paid.
      </p>
      <p>
        Showing the latest 100 records. Event data export contains the full
        ledger. This ledger does not indicate merchant payout or refund
        settlement.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="editor-actions">
        <button className="btn ghost" disabled={busy} onClick={load}>
          Refresh payments
        </button>
        <button
          className="btn ghost"
          onClick={() =>
            download(
              "contributions.csv",
              [
                ["Reference", "Purpose", "NGN", "Status", "Created"],
                ...data.payments.map((p) => [
                  p.reference,
                  p.purpose,
                  p.amount_minor / 100,
                  p.status,
                  p.created_at,
                ]),
              ]
                .map((row) => row.map(csvCell).join(","))
                .join("\r\n"),
              "text/csv",
            )
          }
        >
          Export displayed rows
        </button>
      </div>
      {!data.payments.length && <p>No contributions yet.</p>}
      {data.payments.map((p) => (
        <div className="payment-row" key={p.reference}>
          <span>
            <b>
              NGN {(p.amount_minor / 100).toLocaleString()} · {p.status}
            </b>
            <p>{p.reference}</p>
            <small>
              {p.purpose} · {p.created_at} · checkout {p.initialization_state}
            </small>
          </span>
          {["pending", "initialized"].includes(p.status) && (
            <button
              className="btn ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.reconcilePayment(eventId, p.reference);
                  await load();
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Verification failed",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Verify with Paystack
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
