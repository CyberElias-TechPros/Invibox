import { useEffect, useState } from "react";
import { request } from "./api";
import { download, csvCell } from "./files";

import { CommerceExtrasAdmin } from "./RemainingModules";
const money = (n: number) => `NGN ${(n / 100).toLocaleString()}`;
const resources = [
  ["guests", "guest_limit", "Guest places (including plus-ones)"],
  ["occasions", "occasion_limit", "Occasions"],
  ["collaborators", "collaborator_limit", "Collaborators (owner excluded)"],
  ["photos", "photo_limit", "Photos, including upload reservations"],
  ["storage", "storage_limit", "Photo storage"],
  ["messages", "message_limit", "Lifetime queued recipients"],
];
const quantity = (key: string, n: number) =>
  key === "storage" ? `${Math.round(n / 1048576)} MiB` : n.toLocaleString();
const post = (path: string, body: unknown = {}) =>
  request<any>(path, { method: "POST", body: JSON.stringify(body) });
const pending = (status: string) => !["paid", "rejected"].includes(status);
function Proof({ password, setPassword, code, setCode }: any) {
  return (
    <div className="form-grid">
      <label>
        Password for financial changes
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label>
        Financial verification code (authenticator/recovery, if enabled)
        <input
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
    </div>
  );
}
export function BillingPanel({ eventId }: { eventId: string }) {
  const [data, setData] = useState<any>(null),
    [plans, setPlans] = useState<any[]>([]);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const storageKey = `invibox:billing:${eventId}`;
  const load = async () => {
    const [bill, catalog] = await Promise.all([
      request<any>(`/events/${eventId}/billing`),
      request<any>("/plans"),
    ]);
    setData(bill);
    setPlans(catalog.plans);
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (
        saved &&
        bill.orders.some(
          (o: any) => o.request_key === saved.key && !pending(o.status),
        )
      )
        localStorage.removeItem(storageKey);
    } catch {
      /* Local recovery is optional; the server ledger is authoritative. */
    }
  };
  useEffect(() => {
    setData(null);
    load().catch((e) => setMessage(e.message));
  }, [eventId]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };
  const checkout = async (
    product: string,
    price: number,
    existingKey?: string,
  ) => {
    let key = existingKey;
    if (!key) {
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
        if (saved?.product === product && saved.price === price)
          key = saved.key;
      } catch {
        /* Server also prevents concurrent purchases. */
      }
      key ||= crypto.randomUUID();
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ key, product, price }),
        );
      } catch {
        /* Recover from the order list if storage is unavailable. */
      }
    }
    const result = await request<any>(`/events/${eventId}/billing/checkout`, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ product, expectedPriceMinor: price }),
    });
    if (result.checkoutUrl) location.assign(result.checkoutUrl);
    else
      setMessage(
        result.message ||
          (result.status === "paid"
            ? "Payment verified. Your event limits are updated."
            : `Order ${result.reference}: ${result.status}. Check its status below before paying again.`),
      );
  };
  return (
    <section
      className="card content-editor"
      aria-label="Event packages and usage"
    >
      <h2>Packages & usage</h2>
      <p>
        One-time purchases for this event, not a subscription. Contributions
        from guests are separate from package purchases.
      </p>
      <p>
        Paid prices below are proposed until activated by the operator. Upgrades
        charge the full displayed price, with no proration. Purchased packs
        carry forward on upgrades, up to event safety limits. Message credits
        count queued recipients, not successful deliveries.
      </p>
      {message && (
        <p role="status" className="save-banner">
          {message}
        </p>
      )}
      {!data ? (
        <p>Loading package information…</p>
      ) : (
        <>
          <h3>Current package: {data.entitlement.plan_code}</h3>
          <div className="commerce-usage">
            {resources.map(([key, field, label]) => (
              <div key={key}>
                <span>{label}</span>
                <strong>
                  {quantity(
                    key,
                    key === "messages"
                      ? data.entitlement.messages_used
                      : data.usage[key],
                  )}{" "}
                  / {quantity(key, data.entitlement[field])}
                </strong>
              </div>
            ))}
          </div>
          <div className="commerce-plans">
            {plans.map((plan) => {
              const caps = JSON.parse(plan.limits_json);
              return (
                <article className="commerce-plan" key={plan.code}>
                  <h3>{plan.name}</h3>
                  <strong>
                    {money(plan.price_minor)}{" "}
                    {plan.kind === "pack" ? "per pack" : "per event"}
                  </strong>
                  {!plan.active && <p>Draft · Not on sale</p>}
                  <ul>
                    {resources
                      .filter(([key]) => caps[key] > 0)
                      .map(([key, , label]) => (
                        <li key={key}>
                          {quantity(key, caps[key])} {label.toLowerCase()}
                        </li>
                      ))}
                  </ul>
                  {plan.code === "free" ? (
                    <p>Included automatically. No queued outbound messages.</p>
                  ) : (
                    <button
                      className="btn primary"
                      disabled={
                        busy ||
                        !plan.active ||
                        data.orders.some((o: any) => pending(o.status)) ||
                        (plan.kind === "plan" &&
                          plan.tier <= data.entitlement.tier)
                      }
                      onClick={() =>
                        act(() => checkout(plan.code, plan.price_minor))
                      }
                    >
                      Buy {plan.name}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
          <h3>Package orders & receipts</h3>
          <p>
            Limits change only after server verification, never just from a
            checkout redirect. An uncertain order must be reconciled before
            another purchase. Contact your platform operator with its reference
            if it remains unresolved.
          </p>
          <div className="editor-actions">
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() => act(load)}
            >
              Refresh package status
            </button>
            <button
              className="btn ghost"
              onClick={() =>
                download(
                  "package-orders.csv",
                  [
                    ["Reference", "Product", "NGN", "Status", "Paid at"],
                    ...data.orders.map((o: any) => [
                      o.reference,
                      o.product_code,
                      o.amount_minor / 100,
                      o.status,
                      o.paid_at || "",
                    ]),
                  ]
                    .map((row) => row.map(csvCell).join(","))
                    .join("\r\n"),
                  "text/csv",
                )
              }
            >
              Export displayed orders
            </button>
          </div>
          {!data.orders.length && <p>No package purchases yet.</p>}
          {data.orders.map((order: any) => (
            <div className="payment-row" key={order.reference}>
              <div>
                <b>
                  {order.product_code} · {money(order.amount_minor)} ·{" "}
                  {order.status}
                </b>
                <p>{order.reference}</p>
                {order.paid_at && (
                  <small>
                    Payment verified {order.paid_at}. This record is not a tax
                    invoice.
                  </small>
                )}
              </div>
              {pending(order.status) && (
                <div className="editor-actions">
                  <button
                    className="btn ghost"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await post(
                          `/events/${eventId}/billing/${order.reference}/reconcile`,
                        );
                        setMessage(
                          "Provider check complete. See the order status below.",
                        );
                      })
                    }
                  >
                    Check payment
                  </button>
                  {["reserved", "initialized"].includes(order.status) && (
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          checkout(
                            order.product_code,
                            order.amount_minor,
                            order.request_key,
                          ),
                        )
                      }
                    >
                      Continue existing checkout
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          <small>
            Showing the latest 50 orders. The event data export includes the
            full package ledger.
          </small>
        </>
      )}
    </section>
  );
}
export function BillingReturn() {
  const eventId =
    new URLSearchParams(location.search).get("billingEvent") || "";
  return (
    <main className="account-page">
      <a href="/app">← Workspace</a>
      <h1>Package payment status</h1>
      <p>
        Returning from checkout is not proof of payment. Use “Check payment” to
        verify the order.
      </p>
      {eventId && <BillingPanel eventId={eventId} />}
    </main>
  );
}
export function PayoutPanel() {
  const [account, setAccount] = useState<any>(undefined),
    [banks, setBanks] = useState<any[]>([]);
  const [bankCode, setBankCode] = useState(""),
    [accountNumber, setAccountNumber] = useState(""),
    [businessName, setBusinessName] = useState("");
  const [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const load = async () =>
    setAccount((await request<any>("/account/payout")).account);
  useEffect(() => {
    load().catch((e) => setMessage(e.message));
  }, []);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
      setPassword("");
      setCode("");
    }
  };
  return (
    <section className="card content-editor">
      <h2>Organizer payout account</h2>
      <p>
        Guest contributions route to your verified Paystack subaccount. Invibox
        currently takes no contribution commission; Paystack processing fees are
        borne by your subaccount. Provider settlement timing and eligibility
        apply. Package purchases instead pay Invibox.
      </p>
      {message && <p role="status">{message}</p>}
      {account === undefined ? (
        <p>Loading payout status…</p>
      ) : account ? (
        <>
          <p>
            <b>{account.state}</b> · {account.bank_name || account.bank_code} ·
            account ending {account.last_four}
          </p>
          <p>{account.account_name}</p>
          <small>Onboarding reference: {account.request_id}</small>
          {account.review_reason && <p>Review note: {account.review_reason}</p>}
          <p>
            Bank resolution alone is not approval. Provider verification and an
            operator identity review are required. For an uncertain request or a
            bank change, contact the operator—do not open duplicate subaccounts.
            Blocking new payments does not cancel existing provider checkouts or
            settlements.
          </p>
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() => act(load)}
          >
            Refresh payout status
          </button>
        </>
      ) : (
        <>
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() =>
              act(async () =>
                setBanks((await request<any>("/account/payout/banks")).banks),
              )
            }
          >
            Load supported Nigerian banks
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              act(async () => {
                const result = await post("/account/payout", {
                  bankCode,
                  accountNumber,
                  businessName,
                  password,
                  code: code || undefined,
                  consent,
                });
                setAccountNumber("");
                setMessage(result.message);
                await load();
              });
            }}
          >
            <label>
              Bank
              <select
                required
                value={bankCode}
                onChange={(e) => setBankCode(e.target.value)}
              >
                <option value="">Choose a bank</option>
                {banks.map((bank) => (
                  <option key={bank.code} value={bank.code}>
                    {bank.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Ten-digit account number
              <input
                required
                inputMode="numeric"
                pattern="[0-9]{10}"
                maxLength={10}
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              Organizer or business name
              <input
                required
                minLength={2}
                maxLength={100}
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
              />
            </label>
            <Proof {...{ password, setPassword, code, setCode }} />
            <label className="check-row">
              <input
                type="checkbox"
                required
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              I am authorized to use this account and consent to bank
              resolution, provider onboarding and identity review. Invibox
              stores only masked bank details and a protected verification
              fingerprint, not the full account number.
            </label>
            <button className="btn primary" disabled={busy || !banks.length}>
              {busy ? "Submitting…" : "Submit for payout review"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
export default function CommerceAdmin() {
  const [data, setData] = useState<any>(null),
    [plans, setPlans] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null);
  const [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [reason, setReason] = useState(""),
    [subaccountCode, setSubaccountCode] = useState("");
  const [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const load = async () => {
    const [review, catalog] = await Promise.all([
      request<any>("/admin/commerce"),
      request<any>("/plans"),
    ]);
    setData(review);
    setPlans(catalog.plans);
  };
  useEffect(() => {
    load().catch((e) => setMessage(e.message));
  }, []);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
      await load();
      setMessage("Action completed. Review the refreshed records.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
      setPassword("");
      setCode("");
    }
  };
  const credentials = { password, code: code || undefined };
  return (
    <main className="account-page">
      <a href="/app/account">← Account</a>
      <h1>Commerce operations</h1>
      {message && <p role="status">{message}</p>}
      {data && (
        <>
          <section className="card content-editor">
            <h2>Financial step-up</h2>
            <p>
              Configuration, payout approval, blocking and order closure require
              your current password and MFA if enabled. Credentials clear after
              each action. Do not include identity documents, account numbers or
              secrets in review notes.
            </p>
            <Proof {...{ password, setPassword, code, setCode }} />
            <label>
              Review reason (at least 10 characters)
              <textarea
                value={reason}
                minLength={10}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </section>
          <section className="card content-editor">
            <h2>Package catalog</h2>
            <p>
              Draft prices are not approved business policy. Activate only after
              price, cost, refund and provider acceptance reviews. Changes
              affect future orders, not previously purchased entitlements.
            </p>
            <label>
              Package
              <select
                value={selected?.code || ""}
                onChange={(e) => {
                  const plan = plans.find((p) => p.code === e.target.value);
                  setSelected(
                    plan
                      ? { ...plan, limits: JSON.parse(plan.limits_json) }
                      : null,
                  );
                }}
              >
                <option value="">Choose a package</option>
                {plans.map((plan) => (
                  <option key={plan.code} value={plan.code}>
                    {plan.name} ({plan.active ? "active" : "draft"})
                  </option>
                ))}
              </select>
            </label>
            {selected && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (
                    !confirm(
                      "Save these prices and limits? Active paid products become purchasable when Paystack is configured.",
                    )
                  )
                    return;
                  act(async () => {
                    await request(`/admin/plans/${selected.code}`, {
                      method: "PATCH",
                      body: JSON.stringify({
                        ...credentials,
                        name: selected.name,
                        priceMinor: selected.price_minor,
                        limits: selected.limits,
                        active: !!selected.active,
                      }),
                    });
                    setSelected(null);
                  });
                }}
              >
                <label>
                  Display name
                  <input
                    required
                    value={selected.name}
                    onChange={(e) =>
                      setSelected({ ...selected, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  Price (NGN)
                  <input
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    value={selected.price_minor / 100}
                    onChange={(e) =>
                      setSelected({
                        ...selected,
                        price_minor: Math.round(Number(e.target.value) * 100),
                      })
                    }
                  />
                </label>
                <div className="form-grid">
                  {resources.map(([key, , label]) => (
                    <label key={key}>
                      {label}
                      {key === "storage" ? " (bytes)" : ""}
                      <input
                        required
                        type="number"
                        min="0"
                        step="1"
                        value={selected.limits[key]}
                        onChange={(e) =>
                          setSelected({
                            ...selected,
                            limits: {
                              ...selected.limits,
                              [key]: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={!!selected.active}
                    onChange={(e) =>
                      setSelected({ ...selected, active: e.target.checked })
                    }
                  />
                  Active / available to purchase
                </label>
                <button className="btn primary" disabled={busy}>
                  Save catalog entry
                </button>
              </form>
            )}
          </section>
          <section className="card content-editor">
            <h2>Payout review</h2>
            <p>
              Approval requires provider active/verified status, matching bank
              details and owner metadata, plus your independent
              identity/authority review. Never approve solely because bank
              resolution returned a name.
            </p>
            <label>
              Provider subaccount code (for uncertain requests)
              <input
                value={subaccountCode}
                placeholder="ACCT_…"
                onChange={(e) => setSubaccountCode(e.target.value)}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              I have independently reviewed identity and authority to receive
              these contributions.
            </label>
            {data.accounts.length === 0 && <p>No payout requests.</p>}
            {data.accounts.map((a: any) => (
              <div className="payment-row" key={a.user_id}>
                <div>
                  <b>
                    {a.email} · {a.state}
                  </b>
                  <p>
                    {a.account_name} · {a.bank_name} · ending {a.last_four}
                  </p>
                  <small>
                    Request {a.request_id} ·{" "}
                    {a.subaccount_code || "Provider creation unresolved"}
                  </small>
                </div>
                <div className="editor-actions">
                  <button
                    className="btn primary"
                    disabled={
                      busy ||
                      !reviewed ||
                      reason.trim().length < 10 ||
                      !password
                    }
                    onClick={() =>
                      act(async () => {
                        await post(`/admin/payouts/${a.user_id}/verify`, {
                          ...credentials,
                          reason,
                          subaccountCode: a.subaccount_code || subaccountCode,
                          identityReviewed: reviewed,
                        });
                        setReviewed(false);
                      })
                    }
                  >
                    Verify & approve
                  </button>
                  <button
                    className="btn ghost"
                    disabled={busy || reason.trim().length < 10 || !password}
                    onClick={() =>
                      act(async () => {
                        await post(`/admin/payouts/${a.user_id}/block`, {
                          ...credentials,
                          reason,
                        });
                      })
                    }
                  >
                    Block new contributions
                  </button>
                  <button
                    className="btn ghost"
                    disabled={
                      busy ||
                      a.state !== "blocked" ||
                      !password ||
                      reason.trim().length < 10
                    }
                    onClick={() => {
                      if (
                        confirm(
                          "Has provider support confirmed the old subaccount is absent or inactive, with all outstanding checkouts and settlements reviewed? Existing payment routing will not change.",
                        )
                      )
                        act(async () => {
                          await post(`/admin/payouts/${a.user_id}/reset`, {
                            ...credentials,
                            reason,
                            confirmation:
                              "Provider absent or inactive; settlements reviewed",
                          });
                        });
                    }}
                  >
                    Allow bank replacement after review
                  </button>
                </div>
              </div>
            ))}
          </section>
          <section className="card content-editor">
            <h2>Unresolved package orders</h2>
            <p>
              Never close an ambiguous order just to retry a charge. First
              confirm in Paystack that no payment was received and cancel the
              old checkout with provider support. Late verified payments still
              receive their purchased entitlements and require
              duplicate-payment/refund review.
            </p>
            {!data.orders.length && <p>No unresolved orders.</p>}
            {data.orders.map((o: any) => (
              <div className="payment-row" key={o.reference}>
                <div>
                  <b>
                    {o.product_code} · {money(o.amount_minor)} · {o.status}
                  </b>
                  <p>{o.reference}</p>
                  <small>Event {o.event_id}</small>
                </div>
                <div className="editor-actions">
                  <button
                    className="btn ghost"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await post(`/admin/billing/${o.reference}/reconcile`);
                      })
                    }
                  >
                    Reconcile
                  </button>
                  <button
                    className="btn ghost"
                    disabled={busy || !password || reason.trim().length < 10}
                    onClick={() => {
                      if (
                        confirm(
                          "Have you confirmed no payment was received AND cancelled this checkout with Paystack? This is not automatic cancellation.",
                        )
                      )
                        act(async () => {
                          await post(`/admin/billing/${o.reference}/close`, {
                            ...credentials,
                            reason,
                            confirmation:
                              "Provider checkout cancelled; no payment received",
                          });
                        });
                    }}
                  >
                    Close after provider cancellation
                  </button>
                </div>
              </div>
            ))}
          </section>
          <CommerceExtrasAdmin />
        </>
      )}
    </main>
  );
}
