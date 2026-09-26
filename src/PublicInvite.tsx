import { useEffect, useRef, useState } from "react";
import { CalendarPlus, Check, Gift, MapPin, ArrowUpRight } from "lucide-react";
import { api } from "./api";
import { calendar, download } from "./files";

type Occasion = {
  id: string;
  title: string;
  starts_at: string;
  venue_name: string;
  address: string;
  rsvp_status?: string;
};
type Invitation = {
  event: {
    id: string;
    title: string;
    slug: string;
    starts_at: string;
    timezone: string;
    location: string;
    event_type: string;
    settings: { capabilities?: string[]; rsvpDeadline?: string };
  };
  guest: null | {
    name: string;
    party_size: number;
    status: string;
    table_name?: string;
  };
  occasions: Occasion[];
  sections: { title: string; type: string; content_json: string }[];
};
export default function PublicInvite() {
  const [data, setData] = useState<Invitation | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [plusOne, setPlusOne] = useState("");
  const lastSubmission = useRef({ payload: "", key: "" });
  const params = new URLSearchParams(location.search);
  const suppliedToken = params.get("token");
  const preview = params.get("preview");
  const slug = location.pathname.split("/").filter(Boolean).pop() || "";
  const token =
    suppliedToken || sessionStorage.getItem(`invibox.invitation.${slug}`) || "";
  useEffect(() => {
    if (suppliedToken)
      sessionStorage.setItem(`invibox.invitation.${slug}`, suppliedToken);
  }, [slug, suppliedToken]);
  useEffect(() => {
    let active = true;
    document.title = "Your invitation · Invibox";
    (preview ? api.previewEvent(preview) : api.publicEvent(slug, token))
      .then((result) => {
        if (!active) return;
        setData(result);
        document.title = `${result.event.title} · Invibox`;
        setChoices(
          Object.fromEntries(
            result.occasions.map((o: Occasion) => [
              o.id,
              ["attending", "declined"].includes(o.rsvp_status || "")
                ? o.rsvp_status
                : "",
            ]),
          ),
        );
        if (!preview)
          api
            .analytics({ eventId: result.event.id, token, type: "view" })
            .catch(() => {});
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    const reference = params.get("payment");
    if (reference)
      api
        .paymentStatus(reference)
        .then((result) => {
          if (active)
            setMessage(
              result.status === "paid"
                ? "Thank you — your contribution was received."
                : `Payment status: ${result.status}. Refresh to check again.`,
            );
        })
        .catch(() => {
          if (active)
            setMessage(
              "Payment confirmation is not available yet. Please keep your provider receipt.",
            );
        });
    return () => {
      active = false;
    };
  }, [slug, token, preview]);
  if (error)
    return (
      <main className="invite-error">
        <a href="/" className="invite-brand">
          invibox
        </a>
        <h1>Invitation unavailable</h1>
        <p>{error}</p>
        <p>
          Ask your host for your latest personalized link. Do not share another
          guest’s link.
        </p>
      </main>
    );
  if (!data)
    return (
      <main className="invite-error" role="status">
        Loading your invitation…
      </main>
    );
  const { event, guest, occasions } = data;
  const format = (date: string) =>
    new Intl.DateTimeFormat(undefined, {
      timeZone: event.timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(date));
  return (
    <main className="public-invite">
      <nav>
        {preview && <strong>PRIVATE ORGANIZER PREVIEW</strong>}
        <a className="invite-brand" href="/">
          invibox
        </a>
        <a href="#rsvp">Your response</a>
      </nav>
      <section className="public-hero">
        <div className="public-shade" />
        <div className="invitation-heading">
          <span>YOU ARE INVITED</span>
          <h1>{event.title}</h1>
          <p>
            {guest
              ? `Dear ${guest.name}, we look forward to welcoming you.`
              : "Join us for a special occasion."}
          </p>
          <strong>{format(event.starts_at)}</strong>
          <p>
            <MapPin size={16} /> {event.location}
          </p>
          <a href="#details" className="btn primary">
            Explore the event <ArrowUpRight size={16} />
          </a>
        </div>
      </section>
      <section className="invite-quote" id="details">
        <h2>Every moment, together.</h2>
        <p>Times are shown in {event.timezone}.</p>
        {guest && (
          <p>
            Your invitation reserves {guest.party_size}{" "}
            {guest.party_size === 1 ? "seat" : "seats"}.
            {guest.table_name && ` Your table: ${guest.table_name}.`}
          </p>
        )}
      </section>
      <section className="invite-details">
        {occasions.map((o, i) => (
          <div key={o.id}>
            <span>{String(i + 1).padStart(2, "0")}</span>
            <h3>{o.title}</h3>
            <p>{format(o.starts_at)}</p>
            <b>{o.venue_name}</b>
            <p>{o.address}</p>
            <a
              target="_blank"
              rel="noopener noreferrer"
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address || o.venue_name)}`}
            >
              Directions
            </a>
            <button
              onClick={() =>
                download(`${event.slug}.ics`, calendar([o]), "text/calendar")
              }
            >
              <CalendarPlus size={14} /> Add to calendar
            </button>
          </div>
        ))}
        {!occasions.length && (
          <p>Your host has not assigned any occasions yet.</p>
        )}
      </section>
      {data.sections.map((section, i) => {
        let content: { text?: string };
        try {
          content = JSON.parse(section.content_json);
        } catch {
          return null;
        }
        return typeof content.text === "string" && content.text.trim() ? (
          <section key={i} className="invite-quote">
            <h2>{section.title}</h2>
            <p style={{ whiteSpace: "pre-wrap" }}>{content.text}</p>
          </section>
        ) : null;
      })}
      <section id="rsvp" className="invite-rsvp">
        <span>THE PLEASURE OF YOUR COMPANY</span>
        <h2>Will you join us?</h2>
        {event.settings.rsvpDeadline && (
          <p>Please reply by {format(event.settings.rsvpDeadline)}.</p>
        )}
        {!guest ? (
          <p>Please use your personalized invitation link to reply.</p>
        ) : (
          <form
            className="invite-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setMessage("");
              const body = {
                token,
                responses: occasions.map((o) => ({
                  occasionId: o.id,
                  status: choices[o.id],
                })),
                dietaryNotes: notes,
                plusOneName: plusOne,
              };
              const payload = JSON.stringify(body);
              if (lastSubmission.current.payload !== payload)
                lastSubmission.current = { payload, key: crypto.randomUUID() };
              try {
                await api.rsvp(body, lastSubmission.current.key);
                setMessage("Your response has been saved. Thank you!");
              } catch (e) {
                setMessage(
                  e instanceof Error
                    ? e.message
                    : "Could not save your response. Retry safely.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {occasions.map((o) => (
              <fieldset key={o.id}>
                <legend>{o.title}</legend>
                {[
                  ["attending", "Accepts with pleasure"],
                  ["declined", "Unable to attend"],
                ].map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name={o.id}
                      value={value}
                      checked={choices[o.id] === value}
                      onChange={() => setChoices({ ...choices, [o.id]: value })}
                      required
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            ))}
            <label>
              Dietary or accessibility notes
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={1000}
              />
            </label>
            {guest.party_size > 1 && (
              <label>
                Companion name (optional)
                <input
                  value={plusOne}
                  onChange={(e) => setPlusOne(e.target.value)}
                  maxLength={120}
                />
              </label>
            )}
            <button disabled={busy || !occasions.length}>
              {busy ? "Saving…" : "Save my response"} <Check size={16} />
            </button>
          </form>
        )}
        {message && (
          <p role="status" className="payment-message">
            {message}
          </p>
        )}
      </section>
      {!preview && event.settings.capabilities?.includes("gifts") && (
        <section className="invite-rsvp gift-contribution">
          <Gift />
          <h2>A gift from the heart</h2>
          <p>
            Your presence is enough. Contributions are optional and processed
            securely by Paystack.
          </p>
          <form
            className="invite-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              setPaymentBusy(true);
              try {
                const result = await api.initializePayment({
                  slug,
                  token: token || undefined,
                  email: String(form.get("email")),
                  amount: Number(form.get("amount")),
                  purpose: "contribution",
                });
                window.location.assign(result.checkoutUrl);
              } catch (e) {
                setMessage(
                  e instanceof Error ? e.message : "Checkout unavailable",
                );
                setPaymentBusy(false);
                document.getElementById("rsvp")?.scrollIntoView();
              }
            }}
          >
            <label>
              Receipt email
              <input name="email" type="email" required />
            </label>
            <label>
              Amount (NGN)
              <input
                name="amount"
                type="number"
                min="100"
                max="100000000"
                step="0.01"
                required
              />
            </label>
            <button disabled={paymentBusy}>
              {paymentBusy ? "Opening checkout…" : "Continue to Paystack"}{" "}
              <ArrowUpRight size={16} />
            </button>
          </form>
        </section>
      )}
      <footer>
        <b>{event.title}</b>
        <small>
          Made with Invibox · Your personalized link is private. Please do not
          forward it.
        </small>
      </footer>
    </main>
  );
}
