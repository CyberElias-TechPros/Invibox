import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useEventStore } from "./useStore";
export function GuestAccess({
  guest,
  onClose,
  notify,
}: {
  guest: { id: string | number; name: string };
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const { eventId, schedule } = useEventStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    api
      .guestAccess(eventId, guest.id)
      .then((result) => setSelected(result.occasionIds))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, [eventId, guest.id]);
  return (
    <dialog ref={dialog} className="access-dialog" onCancel={onClose}>
      <h2>Occasion access</h2>
      <p>
        {guest.name} can only see and respond to the occasions selected here.
      </p>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.setGuestAccess(eventId, guest.id, selected);
            notify("Guest occasion access saved");
            onClose();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save");
            setBusy(false);
          }
        }}
      >
        {schedule.map((o) => (
          <label key={o.id}>
            <input
              type="checkbox"
              disabled={busy}
              checked={selected.includes(String(o.id))}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, String(o.id)]
                    : selected.filter((id) => id !== String(o.id)),
                )
              }
            />
            {o.title} {o.isPrivate ? "(private)" : ""}
          </label>
        ))}
        <div className="editor-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            Save access
          </button>
        </div>
      </form>
    </dialog>
  );
}
