import { useEffect, useState } from "react";
import { api } from "./api";
export function AnnouncementHistory({ eventId }: { eventId: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const result = await api.announcements(eventId);
      setRows(result.announcements);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load messages");
    }
  };
  useEffect(() => {
    load();
  }, [eventId]);
  return (
    <section className="card content-editor">
      <h3>Announcement history</h3>
      <p>
        “Accepted” means the provider accepted the request, not that a guest
        read or received it. Failed recipients can be retried; accepted
        recipients are skipped.
      </p>
      <button className="btn ghost" onClick={load}>
        Refresh status
      </button>
      {error && <p role="alert">{error}</p>}
      {!rows.length && <p>No announcements yet.</p>}
      {rows.map((row) => (
        <div key={row.id}>
          <b>
            {row.channel} · {row.status}
          </b>
          <p>{row.message}</p>
          <small>
            {row.sent_count || 0} accepted · {row.failed_count || 0} failed
          </small>
          {row.status === "failed" && (
            <button
              className="btn ghost"
              disabled={busy}
              onClick={async () => {
                if (
                  !confirm(
                    "Retry failed recipients? A provider timeout can mean a previous request was accepted without confirmation.",
                  )
                )
                  return;
                setBusy(true);
                try {
                  await api.retryAnnouncement(eventId, row.id);
                  await load();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Retry failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Retry failed recipients
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
