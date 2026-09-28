import { useState } from "react";
import { api } from "./api";
import { download } from "./files";
import { useEventStore } from "./useStore";
export default function EventPrivacy() {
  const { event, eventId, guests, refresh } = useEventStore();
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [guestId, setGuestId] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  if (event?.member_role !== "owner") return null;
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
    }
  };
  return (
    <section className="card content-editor">
      <h3>Privacy & data management</h3>
      <p>
        These actions require the event owner’s password. Exports contain
        private guest information. Deletion removes application access
        immediately and queues referenced files for storage cleanup. Provider
        records and backups have separate retention policies.
      </p>
      {message && <p role="status">{message}</p>}
      <label>
        Current password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <button
        className="btn ghost"
        disabled={busy || !password}
        onClick={() =>
          act(async () => {
            const result = await api.exportEvent(eventId, password);
            download(
              `${event.slug}-export.json`,
              JSON.stringify(result, null, 2),
              "application/json",
            );
            setMessage("Event export downloaded. Store it securely.");
          })
        }
      >
        Export event data
      </button>
      <label>
        Guest to erase
        <select value={guestId} onChange={(e) => setGuestId(e.target.value)}>
          <option value="">Choose a guest</option>
          {guests.map((guest) => (
            <option key={guest.id} value={guest.id}>
              {guest.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="btn ghost"
        disabled={busy || !password || !guestId}
        onClick={() => {
          if (
            !confirm(
              "Permanently erase this guest and revoke their invitation? Financial records remain without the guest link.",
            )
          )
            return;
          act(async () => {
            const result = await api.eraseGuest(eventId, guestId, password);
            setGuestId("");
            await refresh();
            setMessage(result.note);
          });
        }}
      >
        Erase selected guest
      </button>
      <hr />
      <h3>Delete archived event</h3>
      <p>
        Events with payment records cannot be automatically deleted. Use a
        reviewed retention process instead. Archive the event first.
      </p>
      <label>
        Type “{event.title}” to confirm
        <input
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        />
      </label>
      <button
        className="btn ghost"
        disabled={
          busy ||
          !password ||
          confirmation !== event.title ||
          event.lifecycle !== "archived"
        }
        onClick={() => {
          if (
            !confirm(
              "Permanently delete this event and its guest data? This cannot be undone in the app.",
            )
          )
            return;
          act(async () => {
            await api.deleteEvent(eventId, password, confirmation);
            location.assign("/app");
          });
        }}
      >
        Permanently delete event
      </button>
    </section>
  );
}
