import { PayoutPanel } from "./Commerce";
import MfaPanel from "./MfaPanel";
import { useEffect, useState } from "react";
import { api } from "./api";
import { download } from "./files";
import {
  PasskeyPanel,
  SubscriptionPanel,
  InvoicePanel,
} from "./RemainingModules";

export function VerifyEmail({ token }: { token: string }) {
  const [message, setMessage] = useState(
    "Confirm your email to unlock publishing and integrations.",
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <main className="account-page">
      <a href="/app">← Invibox workspace</a>
      <h1>Verify your email</h1>
      <p role="status">{message}</p>
      {!done && (
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.verifyEmail(token);
              setDone(true);
              history.replaceState(null, "", "/app?verified=1");
              setMessage(
                "Your email is verified. You can return to your workspace.",
              );
            } catch (e) {
              setMessage(
                e instanceof Error ? e.message : "Could not verify email",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Verifying…" : "Confirm my email"}
        </button>
      )}
    </main>
  );
}
export default function AccountPage() {
  const [profile, setProfile] = useState<any>(null),
    [sessions, setSessions] = useState<any[]>([]);
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState(""),
    [nextPassword, setNextPassword] = useState("");
  const load = async () => {
    const [identity, active] = await Promise.all([api.me(), api.sessions()]);
    setProfile(identity.user);
    setSessions(active.sessions);
  };
  useEffect(() => {
    load().catch((e) => setMessage(e.message));
  }, []);
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="account-page">
      <a href="/app">← Back to workspace</a>
      <h1>Account & security</h1>
      {profile?.role === "admin" && (
        <p>
          <a href="/app/commerce">Commerce operations →</a>
        </p>
      )}
      <PayoutPanel />
      <SubscriptionPanel />
      <InvoicePanel />
      <PasskeyPanel />
      {message && (
        <p className="save-banner" role="status">
          {message}
        </p>
      )}
      <section className="card content-editor">
        <h2>Email verification</h2>
        <p>
          {profile?.name} · {profile?.email}
        </p>
        <p>
          {profile?.emailVerifiedAt
            ? "Your email is verified."
            : "Verify your email before publishing events or using outbound integrations in production."}
        </p>
        {profile && !profile.emailVerifiedAt && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              action(async () => {
                const result = await api.requestVerification();
                setMessage(
                  result.alreadyVerified
                    ? "Email already verified."
                    : result.delivered
                      ? "Verification email sent. The link expires in 24 hours."
                      : "Development email is not configured. Use the API test token only for local testing.",
                );
                await load();
              })
            }
          >
            Send verification email
          </button>
        )}
      </section>
      <section className="card content-editor">
        <h2>Active sessions</h2>
        <p>
          Revoke access on a device you no longer use. Device descriptions are
          supplied by the browser and are not verified identities.
        </p>
        {sessions.map((session) => (
          <div className="session-row" key={session.id}>
            <div>
              <b>{session.current ? "This session" : "Other session"}</b>
              <p>{session.user_agent || "Unknown browser"}</p>
              <small>
                Started {new Date(session.created_at + "Z").toLocaleString()} ·
                expires {new Date(session.expires_at).toLocaleDateString()}
              </small>
            </div>
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await api.revokeSession(session.id);
                  if (session.current) {
                    location.assign("/app");
                    return;
                  }
                  await load();
                  setMessage("Session revoked");
                })
              }
            >
              {session.current ? "Sign out here" : "Revoke"}
            </button>
          </div>
        ))}
        <button
          className="btn ghost"
          disabled={busy}
          onClick={() => action(load)}
        >
          Refresh sessions
        </button>
      </section>
      <section className="card content-editor">
        <h2>Sensitive account actions</h2>
        <label>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={128}
          />
        </label>
        <div className="editor-actions">
          <button
            className="btn ghost"
            disabled={busy || !password}
            onClick={() =>
              action(async () => {
                await api.revokeOtherSessions(password);
                setPassword("");
                await load();
                setMessage("Other sessions have been revoked");
              })
            }
          >
            Sign out other sessions
          </button>
          <button
            className="btn ghost"
            disabled={busy || !password}
            onClick={() =>
              action(async () => {
                const data = await api.exportAccount(password);
                download(
                  "invibox-account.json",
                  JSON.stringify(data, null, 2),
                  "application/json",
                );
                setPassword("");
                setMessage(
                  "Account export downloaded. Event owners can export event data from Settings.",
                );
              })
            }
          >
            Export my account
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action(async () => {
              await api.changePassword(password, nextPassword);
              setPassword("");
              setNextPassword("");
              location.assign("/app?password_changed=1");
            });
          }}
        >
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={128}
              required
              value={nextPassword}
              onChange={(e) => setNextPassword(e.target.value)}
            />
          </label>
          <p>
            Changing your password signs you out everywhere, including this
            browser.
          </p>
          <button
            className="btn primary"
            disabled={busy || !password || nextPassword.length < 10}
          >
            Change password
          </button>
        </form>
      </section>
      <MfaPanel />
      <section className="card content-editor">
        <h2>Delete account</h2>
        <p>
          Export your data and archive all events you own first. Financial event
          records require a reviewed retention process and will block automatic
          deletion. Your profile is anonymized, shared-event memberships are
          removed, and all sessions are revoked. Backups and provider-held
          records follow separate retention policies.
        </p>
        <label>
          Type your account email
          <input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="off"
          />
        </label>
        <button
          className="btn ghost"
          disabled={busy || !password || confirmation !== profile?.email}
          onClick={() => {
            if (
              !confirm(
                "Permanently delete your account and all eligible owned events? This cannot be undone in the app.",
              )
            )
              return;
            action(async () => {
              await api.deleteAccount(password, confirmation);
              localStorage.removeItem("invibox.eventId");
              sessionStorage.clear();
              location.assign("/app?account_deleted=1");
            });
          }}
        >
          Delete my account
        </button>
        <small>Uses the current password entered above.</small>
      </section>
    </main>
  );
}
