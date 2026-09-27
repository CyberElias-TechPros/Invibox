import { useEffect, useState } from "react";
import { api, request } from "./api";

function Section({ title, children }: any) {
  return (
    <section className="card content-editor">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

// Passkeys
export function PasskeyPanel() {
  const [creds, setCreds] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const data = await api.webauthnList();
      setCreds(data.credentials);
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  useEffect(() => { load(); }, []);
  const register = async () => {
    setBusy(true);
    setMsg("");
    try {
      const opts = await api.webauthnRegisterOptions();
      // Simplified: we don't do real WebAuthn in this UI, just call verify with dummy for demo
      // In production, use navigator.credentials.create with opts.options
      if (!window.PublicKeyCredential) throw new Error("WebAuthn not supported in this browser");
      const publicKey = {
        ...opts.options,
        challenge: Uint8Array.from(atob(opts.options.challenge.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)),
        user: {
          ...opts.options.user,
          id: Uint8Array.from(atob(opts.options.user.id.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)),
        },
      };
      const cred: any = await navigator.credentials.create({ publicKey } as any);
      const attestation = {
        id: cred.id,
        rawId: btoa(String.fromCharCode(...new Uint8Array(cred.rawId))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""),
        response: {
          clientDataJSON: btoa(String.fromCharCode(...new Uint8Array(cred.response.clientDataJSON))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""),
          attestationObject: btoa(String.fromCharCode(...new Uint8Array(cred.response.attestationObject))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""),
        },
        type: cred.type,
      };
      await api.webauthnRegisterVerify({ credential: attestation });
      setMsg("Passkey registered");
      await load();
    } catch (e: any) {
      setMsg(e.message || "Passkey registration failed");
    } finally { setBusy(false); }
  };
  return (
    <Section title="Passkeys">
      <p>Passwordless sign-in using WebAuthn. Requires HTTPS and a platform authenticator.</p>
      {msg && <p role="status">{msg}</p>}
      <button className="btn primary" disabled={busy} onClick={register}>Register new passkey</button>
      <ul>
        {creds.map((c: any) => (
          <li key={c.id} className="payment-row">
            <div><b>{c.credential_id.slice(0,16)}…</b><br/><small>Created {c.created_at}</small></div>
            <button className="btn ghost" onClick={async () => { await api.webauthnDelete(c.id); await load(); }}>Remove</button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// Subscriptions
export function SubscriptionPanel() {
  const [catalog, setCatalog] = useState<any[]>([]);
  const [subs, setSubs] = useState<any[]>([]);
  const [ent, setEnt] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const [cat, mine] = await Promise.all([api.subscriptionCatalog(), api.mySubscriptions()]);
    setCatalog(cat.plans || []);
    setSubs(mine.subscriptions || []);
    setEnt(mine.entitlements || null);
  };
  useEffect(() => { load().catch((e: any) => setMsg(e.message)); }, []);
  const checkout = async (plan: any, interval: "month" | "year") => {
    setBusy(true);
    try {
      const key = crypto.randomUUID().replace(/-/g, "").slice(0,24) + "ab12";
      const res = await api.checkoutSubscription({ planCode: plan.code, interval, expectedPriceMinor: plan.price_minor }, key);
      if (res.checkoutUrl) location.assign(res.checkoutUrl);
      else setMsg(`Subscription ${res.status}: ${res.reference}`);
      await load();
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };
  return (
    <Section title="Organizer subscriptions">
      <p>Monthly/yearly organizer-level capacity bonuses. Draft plans are inactive until operator activation. Invoices are generated after payment verification.</p>
      {msg && <p role="status">{msg}</p>}
      {ent && <p>Current bonuses: {JSON.stringify(ent)}</p>}
      <div className="commerce-plans">
        {catalog.map((p: any) => (
          <article className="commerce-plan" key={p.code}>
            <h3>{p.name}</h3>
            <strong>NGN {(p.price_minor/100).toLocaleString()} {p.tier===0?"":`· tier ${p.tier}`}</strong>
            <p>{p.active ? "Active" : "Draft"}</p>
            <div className="editor-actions">
              <button disabled={busy || !p.active} className="btn primary" onClick={() => checkout(p, "month")}>Subscribe monthly</button>
              <button disabled={busy || !p.active} className="btn ghost" onClick={() => checkout(p, "year")}>Yearly</button>
            </div>
          </article>
        ))}
      </div>
      <h3>Your subscriptions</h3>
      {subs.map((s: any) => (
        <div key={s.id} className="payment-row">
          <div><b>{s.plan_code} · {s.billing_interval} · {s.status}</b><p>{s.reference} · {s.current_period_start} → {s.current_period_end}</p></div>
          <div className="editor-actions">
            <button className="btn ghost" disabled={busy} onClick={async () => { await api.reconcileSubscription(s.reference); setMsg("Reconciled"); await load(); }}>Reconcile</button>
            <button className="btn ghost" disabled={busy} onClick={async () => {
              const pwd = prompt("Password to cancel");
              if (!pwd) return;
              await api.cancelSubscription(s.reference, { password: pwd });
              await load();
            }}>Cancel</button>
          </div>
        </div>
      ))}
    </Section>
  );
}

// Invoices
export function InvoicePanel() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => { api.invoices().then(d => setInvoices(d.invoices)).catch((e:any)=>setMsg(e.message)); }, []);
  return (
    <Section title="Invoices & tax receipts">
      <p>Tax rate is configured via TAX_RATE_BPS env. Invoices are not legal tax filings by themselves.</p>
      {msg && <p role="status">{msg}</p>}
      {!invoices.length && <p>No invoices yet.</p>}
      {invoices.map((inv: any) => (
        <div key={inv.id} className="payment-row">
          <div><b>{inv.invoice_number} · {inv.status}</b><p>Amount {(inv.amount_minor/100).toLocaleString()} + tax {(inv.tax_minor/100).toLocaleString()} = {(inv.total_minor/100).toLocaleString()} {inv.currency}</p><small>{inv.billing_reference || inv.subscription_id} · {inv.issued_at}</small></div>
        </div>
      ))}
    </Section>
  );
}

// Ownership transfer
export function OwnershipTransferPanel({ eventId }: { eventId: string }) {
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const [transfers, setTransfers] = useState<any[]>([]);
  const load = async () => {
    const data = await api.transfers(eventId);
    setTransfers(data.transfers);
  };
  useEffect(() => { load().catch((e:any)=>setMsg(e.message)); }, [eventId]);
  return (
    <Section title="Transfer ownership">
      <p>Owner can transfer event to another collaborator. Requires password+MFA and target acceptance via emailed token.</p>
      {msg && <p role="status">{msg}</p>}
      <form onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.transferOwnership(eventId, { toEmail: email, password: pwd, code: code||undefined });
          setMsg("Transfer initiated");
          setEmail(""); setPwd(""); setCode("");
          await load();
        } catch (err:any){ setMsg(err.message); }
      }}>
        <label>Target email<input required value={email} onChange={e=>setEmail(e.target.value)} /></label>
        <label>Password<input required type="password" value={pwd} onChange={e=>setPwd(e.target.value)} /></label>
        <label>MFA code if enabled<input value={code} onChange={e=>setCode(e.target.value)} /></label>
        <button className="btn primary">Initiate transfer</button>
      </form>
      <h3>Pending transfers</h3>
      {transfers.map((t:any)=>(
        <div key={t.id} className="payment-row">
          <div><b>{t.to_email} · {t.status}</b><p>Expires {t.expires_at}</p></div>
          <div className="editor-actions">
            <button className="btn ghost" onClick={async ()=>{
              const pwd2 = prompt("Password to accept");
              if (!pwd2) return;
              const token = prompt("Transfer token from email");
              if (!token) return;
              await api.acceptTransfer(t.id, { token, password: pwd2 });
              await load();
            }}>Accept</button>
            <button className="btn ghost" onClick={async ()=>{ await api.rejectTransfer(t.id); await load(); }}>Reject</button>
          </div>
        </div>
      ))}
    </Section>
  );
}

// Tickets
export function TicketPanel({ eventId }: { eventId: string }) {
  const [types, setTypes] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState(100);
  const [price, setPrice] = useState(0);
  const [msg, setMsg] = useState("");
  const load = async () => {
    const data = await api.ticketTypes(eventId);
    setTypes(data.types);
  };
  useEffect(() => { load().catch((e:any)=>setMsg(e.message)); }, [eventId]);
  return (
    <Section title="Ticket inventory">
      <p>Capacity guard enforced via DB trigger. Holds expire after 15 minutes unless confirmed.</p>
      {msg && <p role="status">{msg}</p>}
      <form onSubmit={async (e)=>{
        e.preventDefault();
        try { await api.createTicketType(eventId, { name, capacity, priceMinor: price }); setName(""); await load(); } catch(err:any){ setMsg(err.message); }
      }}>
        <label>Name<input required value={name} onChange={e=>setName(e.target.value)} /></label>
        <label>Capacity<input type="number" value={capacity} onChange={e=>setCapacity(Number(e.target.value))} /></label>
        <label>Price minor (kobo)<input type="number" value={price} onChange={e=>setPrice(Number(e.target.value))} /></label>
        <button className="btn primary">Create ticket type</button>
      </form>
      {types.map((t:any)=>(
        <div key={t.id} className="payment-row">
          <div><b>{t.name} · {t.sold}/{t.capacity} sold · NGN {(t.price_minor/100).toLocaleString()}</b></div>
          <button className="btn ghost" onClick={async ()=>{ await api.deleteTicketType(eventId, t.id); await load(); }}>Delete</button>
        </div>
      ))}
    </Section>
  );
}

// Extras: transport, accommodation, registry, waitlist
export function ExtrasPanel({ eventId }: { eventId: string }) {
  const [tab, setTab] = useState<"transport"|"accommodation"|"registry"|"waitlist">("transport");
  const [items, setItems] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const load = async () => {
    try {
      if (tab==="transport") setItems((await api.transportBookings(eventId)).bookings);
      if (tab==="accommodation") setItems((await api.accommodations(eventId)).accommodations);
      if (tab==="registry") setItems((await api.registryItems(eventId)).items);
      if (tab==="waitlist") setItems((await api.waitlist(eventId)).entries);
    } catch(e:any){ setMsg(e.message); }
  };
  useEffect(()=>{ load(); }, [tab, eventId]);
  return (
    <Section title="Extras: transport, accommodation, registry, waitlist">
      <div className="editor-actions">
        {(["transport","accommodation","registry","waitlist"] as const).map(t=>(
          <button key={t} className={tab===t?"btn primary":"btn ghost"} onClick={()=>setTab(t)}>{t}</button>
        ))}
      </div>
      {msg && <p role="status">{msg}</p>}
      {tab==="transport" && (
        <>
          <form onSubmit={async (e)=>{
            e.preventDefault();
            const fd = new FormData(e.target as HTMLFormElement);
            await api.createTransport(eventId, { guestId: String(fd.get("guestId")), mode: String(fd.get("mode")), details: {} });
            await load();
          }}>
            <label>Guest ID<input name="guestId" required /></label>
            <label>Mode<input name="mode" required placeholder="flight/bus" /></label>
            <button className="btn primary">Add booking</button>
          </form>
          <ul>{items.map((b:any)=><li key={b.id}>{b.guest_id} · {b.mode} · {b.status}</li>)}</ul>
        </>
      )}
      {tab==="accommodation" && (
        <>
          <form onSubmit={async (e)=>{
            e.preventDefault();
            const fd = new FormData(e.target as HTMLFormElement);
            await api.createAccommodation(eventId, { name: String(fd.get("name")), capacity: Number(fd.get("capacity")) });
            await load();
          }}>
            <label>Name<input name="name" required /></label>
            <label>Capacity<input name="capacity" type="number" required /></label>
            <button className="btn primary">Create</button>
          </form>
          <ul>{items.map((a:any)=><li key={a.id}>{a.name} · {a.allocated}/{a.capacity}
            <button className="btn ghost" onClick={async ()=>{
              const guestId = prompt("Guest ID to assign");
              if (!guestId) return;
              await api.assignAccommodation(eventId, a.id, { guestId });
              await load();
            }}>Assign</button>
          </li>)}</ul>
        </>
      )}
      {tab==="registry" && (
        <>
          <form onSubmit={async (e)=>{
            e.preventDefault();
            const fd = new FormData(e.target as HTMLFormElement);
            await api.createRegistryItem(eventId, { title: String(fd.get("title")), desiredQuantity: Number(fd.get("qty")||1) });
            await load();
          }}>
            <label>Title<input name="title" required /></label>
            <label>Qty<input name="qty" type="number" defaultValue={1} /></label>
            <button className="btn primary">Add item</button>
          </form>
          <ul>{items.map((it:any)=><li key={it.id}>{it.title} · {it.fulfilled_quantity}/{it.desired_quantity}
            <button className="btn ghost" onClick={async ()=>{
              const guestId = prompt("Guest ID fulfilling");
              if (!guestId) return;
              await api.fulfillRegistry(eventId, it.id, { guestId, quantity: 1 });
              await load();
            }}>Fulfill</button>
          </li>)}</ul>
        </>
      )}
      {tab==="waitlist" && (
        <>
          <form onSubmit={async (e)=>{
            e.preventDefault();
            const fd = new FormData(e.target as HTMLFormElement);
            await api.createWaitlist(eventId, { email: String(fd.get("email")), name: String(fd.get("name")) });
            await load();
          }}>
            <label>Email<input name="email" type="email" required /></label>
            <label>Name<input name="name" required /></label>
            <button className="btn primary">Add to waitlist</button>
          </form>
          <ul>{items.map((w:any)=><li key={w.id}>{w.email} · {w.name} · {w.status}
            <button className="btn ghost" onClick={async ()=>{ await api.inviteWaitlist(eventId, w.id); await load(); }}>Invite</button>
          </li>)}</ul>
        </>
      )}
    </Section>
  );
}

// Refunds
export function RefundPanel({ eventId }: { eventId: string }) {
  const [refunds, setRefunds] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const load = async () => {
    const data = await api.listRefunds(eventId);
    setRefunds(data.refunds);
  };
  useEffect(()=>{ load().catch((e:any)=>setMsg(e.message)); }, [eventId]);
  return (
    <Section title="Refunds & disputes">
      <p>Owner can request refund; admin approves/processes via Paystack refund API. Dispute events ingested via webhook.</p>
      {msg && <p role="status">{msg}</p>}
      <form onSubmit={async (e)=>{
        e.preventDefault();
        const fd = new FormData(e.target as HTMLFormElement);
        try {
          await api.requestRefund(eventId, { kind: String(fd.get("kind")), paymentReference: String(fd.get("ref")||""), amountMinor: Number(fd.get("amount")), reason: String(fd.get("reason")) });
          await load();
        } catch(err:any){ setMsg(err.message); }
      }}>
        <label>Kind<select name="kind"><option value="contribution">contribution</option><option value="package">package</option></select></label>
        <label>Payment/Billing ref<input name="ref" /></label>
        <label>Amount minor<input name="amount" type="number" required /></label>
        <label>Reason<input name="reason" required minLength={10} /></label>
        <button className="btn primary">Request refund</button>
      </form>
      <ul>{refunds.map((r:any)=><li key={r.id}>{r.kind} · {r.amount_minor} · {r.status} · {r.reason}</li>)}</ul>
    </Section>
  );
}

// Admin refunds
export function AdminRefundPanel() {
  const [refunds, setRefunds] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const load = async () => {
    const data = await api.adminRefunds();
    setRefunds(data.refunds);
  };
  useEffect(()=>{ load().catch((e:any)=>setMsg(e.message)); }, []);
  return (
    <Section title="Admin: refund review">
      {msg && <p role="status">{msg}</p>}
      <button className="btn ghost" onClick={load}>Refresh</button>
      {refunds.map((r:any)=>(
        <div key={r.id} className="payment-row">
          <div><b>{r.kind} · {r.amount_minor} · {r.status}</b><p>{r.reason}</p></div>
          <div className="editor-actions">
            <button className="btn primary" onClick={async ()=>{
              const pwd = prompt("Password");
              if (!pwd) return;
              const note = prompt("Review note")||"";
              await api.approveRefund(r.id, { password: pwd, reviewNote: note });
              await load();
            }}>Approve</button>
            <button className="btn ghost" onClick={async ()=>{
              const pwd = prompt("Password");
              if (!pwd) return;
              await api.processRefund(r.id, { password: pwd });
              await load();
            }}>Process</button>
            <button className="btn ghost" onClick={async ()=>{
              const pwd = prompt("Password");
              if (!pwd) return;
              const note = prompt("Reason")||"";
              await api.rejectRefund(r.id, { password: pwd, reviewNote: note });
              await load();
            }}>Reject</button>
          </div>
        </div>
      ))}
    </Section>
  );
}

// Retention
export function RetentionPanel() {
  const [policies, setPolicies] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(()=>{ api.retentionPolicies().then(d=>setPolicies(d.policies)).catch((e:any)=>setMsg(e.message)); }, []);
  return (
    <Section title="Retention policies">
      <p>Admin can configure retention days per category. applyRetention runs via cron.</p>
      {msg && <p role="status">{msg}</p>}
      <ul>{policies.map((p:any)=><li key={p.category}>{p.category}: {p.retain_days} days
        <button className="btn ghost" onClick={async ()=>{
          const days = prompt(`New retain days for ${p.category}`, String(p.retain_days));
          if (!days) return;
          const pwd = prompt("Password");
          if (!pwd) return;
          await api.updateRetention(p.category, { retainDays: Number(days), password: pwd });
          const data = await api.retentionPolicies();
          setPolicies(data.policies);
        }}>Edit</button>
      </li>)}</ul>
    </Section>
  );
}

// Suppressions
export function SuppressionPanel() {
  const [list, setList] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(()=>{ request<any>("/admin/suppressions").then(d=>setList(d.suppressions)).catch((e:any)=>setMsg(e.message)); }, []);
  return (
    <Section title="Suppression list (bounced/complained)">
      {msg && <p role="status">{msg}</p>}
      <ul>{list.map((s:any)=><li key={s.id}>{s.channel} · {s.address} · {s.reason} · {s.created_at}</li>)}</ul>
    </Section>
  );
}

// Drafts, Themes, Scheduled
export function DraftsPanel({ eventId }: { eventId: string }) {
  const [drafts, setDrafts] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const load = async () => { setDrafts((await api.drafts(eventId)).drafts); };
  useEffect(()=>{ load().catch((e:any)=>setMsg(e.message)); }, [eventId]);
  return (
    <Section title="Draft snapshots (offline editor)">
      {msg && <p role="status">{msg}</p>}
      <button className="btn ghost" onClick={load}>Refresh</button>
      <form onSubmit={async (e)=>{
        e.preventDefault();
        const fd = new FormData(e.target as HTMLFormElement);
        const content = String(fd.get("content")||"{}");
        try { await api.saveDraft(eventId, { content: JSON.parse(content) }); await load(); } catch(err:any){ setMsg(err.message); }
      }}>
        <label>Content JSON<textarea name="content" defaultValue='{"blocks":[]}' /></label>
        <button className="btn primary">Save draft</button>
      </form>
      <ul>{drafts.map((d:any)=><li key={d.id}>{d.created_at} <button className="btn ghost" onClick={async ()=>{ await api.deleteDraft(eventId, d.id); await load(); }}>Delete</button></li>)}</ul>
    </Section>
  );
}

export function ThemePanel({ eventId }: { eventId: string }) {
  const [themes, setThemes] = useState<any[]>([]);
  const [translations, setTranslations] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const load = async () => {
    setThemes((await api.themes(eventId)).themes);
    setTranslations((await api.translations(eventId)).translations);
  };
  useEffect(()=>{ load().catch((e:any)=>setMsg(e.message)); }, [eventId]);
  return (
    <Section title="Themes & localization (en/yo/ig/ha)">
      {msg && <p role="status">{msg}</p>}
      <form onSubmit={async (e)=>{
        e.preventDefault();
        const fd = new FormData(e.target as HTMLFormElement);
        try { await api.createTheme(eventId, { name: String(fd.get("name")), theme: JSON.parse(String(fd.get("theme")||"{}")) }); await load(); } catch(err:any){ setMsg(err.message); }
      }}>
        <label>Theme name<input name="name" required /></label>
        <label>Theme JSON<textarea name="theme" defaultValue='{"primary":"#000"}' /></label>
        <button className="btn primary">Create preset</button>
      </form>
      <ul>{themes.map((t:any)=><li key={t.id}>{t.name} <button className="btn ghost" onClick={async ()=>{ await api.applyTheme(eventId, t.id); setMsg("Applied"); }}>Apply</button></li>)}</ul>
      <h3>Translations</h3>
      <form onSubmit={async (e)=>{
        e.preventDefault();
        const fd = new FormData(e.target as HTMLFormElement);
        const locale = String(fd.get("locale"));
        const key = String(fd.get("key"));
        const value = String(fd.get("value"));
        await api.saveTranslations(eventId, { translations: [{ locale, key, value }] });
        await load();
      }}>
        <label>Locale<select name="locale"><option value="en">en</option><option value="yo">yo</option><option value="ig">ig</option><option value="ha">ha</option></select></label>
        <label>Key<input name="key" required /></label>
        <label>Value<input name="value" required /></label>
        <button className="btn primary">Save translation</button>
      </form>
      <ul>{translations.map((tr:any)=><li key={`${tr.locale}-${tr.key}`}>{tr.locale} · {tr.key} = {tr.value}</li>)}</ul>
    </Section>
  );
}

export function ScheduledPanel({ eventId }: { eventId: string }) {
  const [scheduled, setScheduled] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const load = async () => { setScheduled((await api.scheduled(eventId)).scheduled); };
  useEffect(()=>{ load().catch((e:any)=>setMsg(e.message)); }, [eventId]);
  return (
    <Section title="Scheduled announcements">
      {msg && <p role="status">{msg}</p>}
      <button className="btn ghost" onClick={load}>Refresh</button>
      <ul>{scheduled.map((s:any)=><li key={s.id}>{s.send_at} · {s.status} · {s.channel}
        <button className="btn ghost" onClick={async ()=>{ await api.cancelScheduled(eventId, s.id); await load(); }}>Cancel</button>
      </li>)}</ul>
    </Section>
  );
}

// Offline check-in
export function OfflinePanel({ eventId }: { eventId: string }) {
  const [pending, setPending] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const load = async () => { setPending((await api.offlinePending(eventId)).pending); };
  useEffect(()=>{ load().catch((e:any)=>setMsg(e.message)); }, [eventId]);
  return (
    <Section title="Offline check-in queue (conflict-resolving)">
      <p>Last-write-wins: earliest check-in preserved, newer uncheck wins if timestamp newer. Device ID + up to 500 items per sync.</p>
      {msg && <p role="status">{msg}</p>}
      <button className="btn ghost" onClick={load}>Refresh pending</button>
      <ul>{pending.map((p:any)=><li key={p.id}>{p.guest_id} · {p.checked_in_at} · device {p.device_id}</li>)}</ul>
      <form onSubmit={async (e)=>{
        e.preventDefault();
        const fd = new FormData(e.target as HTMLFormElement);
        const guestId = String(fd.get("guestId"));
        const checked = fd.get("checked")==="on";
        const deviceId = String(fd.get("deviceId")||"web");
        try {
          await api.offlineSync(eventId, { deviceId, items: [{ guestId, checkedIn: checked, checkedInAt: new Date().toISOString() }] });
          setMsg("Synced");
          await load();
        } catch(err:any){ setMsg(err.message); }
      }}>
        <label>Guest ID<input name="guestId" required /></label>
        <label>Checked in<input type="checkbox" name="checked" defaultChecked /></label>
        <label>Device ID<input name="deviceId" defaultValue="web" /></label>
        <button className="btn primary">Sync offline</button>
      </form>
    </Section>
  );
}

// Combined admin extras
export function CommerceExtrasAdmin() {
  return (
    <>
      <AdminRefundPanel />
      <RetentionPanel />
      <SuppressionPanel />
    </>
  );
}
