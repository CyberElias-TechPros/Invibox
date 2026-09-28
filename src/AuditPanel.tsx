import { useEffect, useState } from "react";
import { api } from "./api";
export default function AuditPanel({ eventId }: { eventId: string }) {
  const [audit, setAudit] = useState<any[]>([]),
    [consents, setConsents] = useState<any[]>([]),
    [filter, setFilter] = useState(""),
    [error, setError] = useState("");
  const load = async () => {
    try {
      const [a, c] = await Promise.all([
        api.audit(eventId),
        api.consents(eventId),
      ]);
      setAudit(a.entries);
      setConsents(c.entries);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load audit records");
    }
  };
  useEffect(() => {
    load();
  }, [eventId]);
  return (
    <section className="card content-editor">
      <h3>Audit & communication consent</h3>
      <p>
        Latest 100 records in each list. This is recorded application activity,
        not a complete forensic log. Consent records identify the invitation
        capability used, not independently verified personal identity. Full
        retained consent history is included in owner event exports.
      </p>
      <button className="btn ghost" onClick={load}>
        Refresh audit records
      </button>
      {error && <p role="alert">{error}</p>}
      <label>
        Filter recorded actions
        <input value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <details>
        <summary>Recorded actions ({audit.length})</summary>
        {audit
          .filter((row) => row.action.includes(filter))
          .map((row, i) => (
            <div className="audit-row" key={i}>
              <b>{row.action}</b>
              <p>
                {row.entity_type} · {row.entity_id} · {row.created_at}
              </p>
              <small>
                Actor: {row.actor_id || "removed"} · Request: {row.request_id}
              </small>
            </div>
          ))}
      </details>
      <details>
        <summary>Communication preference history ({consents.length})</summary>
        {consents.map((row) => (
          <div className="audit-row" key={row.id}>
            <b>
              {row.source} · {row.created_at}
            </b>
            <p>Guest: {row.guest_id}</p>
            <small>
              Email: {row.email_opt_in ? "on" : "off"} · SMS:{" "}
              {row.sms_opt_in ? "on" : "off"} · WhatsApp:{" "}
              {row.whatsapp_opt_in ? "on" : "off"} · {row.policy_version}
            </small>
          </div>
        ))}
      </details>
    </section>
  );
}
export function GuestMediaSettings({
  eventId,
  settings,
  onSaved,
}: {
  eventId: string;
  settings: { guestUploads?: boolean; guestGallery?: boolean };
  onSaved: () => Promise<void>;
}) {
  const [uploads, setUploads] = useState(Boolean(settings.guestUploads)),
    [gallery, setGallery] = useState(Boolean(settings.guestGallery)),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    setUploads(Boolean(settings.guestUploads));
    setGallery(Boolean(settings.guestGallery));
  }, [eventId, settings.guestUploads, settings.guestGallery]);
  return (
    <section className="card content-editor">
      <h3>Guest photo sharing</h3>
      <p>
        Off by default. Invited guests must consent to sharing their photos;
        uploads remain private until staff approval. The gallery is event-wide,
        not limited by occasion assignments.
      </p>
      <label>
        <input
          type="checkbox"
          checked={uploads}
          onChange={(e) => setUploads(e.target.checked)}
        />
        Allow guest photo uploads
      </label>
      <label>
        <input
          type="checkbox"
          checked={gallery}
          onChange={(e) => setGallery(e.target.checked)}
        />
        Show approved, shareable photos to invited guests
      </label>
      <button
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.updateEvent(eventId, {
              settings: { guestUploads: uploads, guestGallery: gallery },
            });
            await onSaved();
            setMessage("Guest photo settings saved.");
          } catch (e) {
            setMessage(
              e instanceof Error ? e.message : "Could not save settings",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Save photo settings
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
