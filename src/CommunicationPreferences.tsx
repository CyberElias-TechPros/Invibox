import { useState } from "react";
import { api } from "./api";
export default function CommunicationPreferences({
  token,
  guest,
}: {
  token: string;
  guest: {
    email_opt_in?: number;
    sms_opt_in?: number;
    whatsapp_opt_in?: number;
  };
}) {
  const [preferences, setPreferences] = useState({
    email: Boolean(guest.email_opt_in),
    sms: Boolean(guest.sms_opt_in),
    whatsapp: Boolean(guest.whatsapp_opt_in),
  });
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  return (
    <section className="invite-rsvp">
      <h2>Event message preferences</h2>
      <p>
        Choose which event updates you want. Providing a contact address is not
        consent. Your host must have your correct email or phone number for
        delivery. You can turn these off at any time without changing your RSVP.
      </p>
      <form
        className="invite-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.savePreferences(token, preferences);
            setMessage(
              "Your message preferences have been saved. Messages already accepted by a provider cannot be recalled.",
            );
          } catch (e) {
            setMessage(
              e instanceof Error ? e.message : "Could not save preferences",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {(["email", "sms", "whatsapp"] as const).map((channel) => (
          <label className="consent-option" key={channel}>
            <input
              type="checkbox"
              checked={preferences[channel]}
              onChange={(e) =>
                setPreferences({ ...preferences, [channel]: e.target.checked })
              }
            />
            {channel === "email"
              ? "Email updates"
              : channel === "sms"
                ? "SMS updates"
                : "WhatsApp updates"}
          </label>
        ))}
        <button disabled={busy}>
          {busy ? "Saving…" : "Save message preferences"}
        </button>
        {message && <p role="status">{message}</p>}
      </form>
    </section>
  );
}
export function Unsubscribe() {
  const query = new URLSearchParams(location.search);
  const [message, setMessage] = useState(
    "Confirm to stop this channel’s event updates. This does not cancel your RSVP.",
  );
  const [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  return (
    <main className="account-page">
      <a href="/">Invibox</a>
      <h1>Unsubscribe from event updates</h1>
      <p role="status">{message}</p>
      {!done && (
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await api.unsubscribe({
                guest: query.get("guest") || "",
                channel: query.get("channel") || "",
                signature: query.get("signature") || "",
              });
              setDone(true);
              history.replaceState(null, "", "/unsubscribe");
              setMessage(result.message);
            } catch (e) {
              setMessage(
                e instanceof Error ? e.message : "Could not unsubscribe",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Updating…" : "Stop these event updates"}
        </button>
      )}
    </main>
  );
}
