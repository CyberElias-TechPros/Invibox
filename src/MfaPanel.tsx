import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "./api";
import { download } from "./files";
export default function MfaPanel() {
  const [status, setStatus] = useState<{
      enabled: boolean;
      available: boolean;
      recoveryCodesRemaining: number;
    } | null>(null),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null),
    [image, setImage] = useState(""),
    [codes, setCodes] = useState<string[]>([]),
    [signIn, setSignIn] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const load = () =>
    api
      .mfaStatus()
      .then(setStatus)
      .catch((e) => setMessage(e.message));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!setup) return;
    let active = true;
    QRCode.toDataURL(setup.uri, { width: 256 })
      .then((value) => {
        if (active) setImage(value);
      })
      .catch(() =>
        setMessage(
          "QR unavailable. Enter the setup key manually in your authenticator.",
        ),
      );
    return () => {
      active = false;
    };
  }, [setup]);
  const act = async (action: "setup" | "enable" | "disable" | "recovery") => {
    setBusy(true);
    setMessage("");
    try {
      if (action === "setup") {
        setSetup(await api.setupMfa(password));
        setCode("");
      } else {
        const result = await api.manageMfa(action, password, code);
        setPassword("");
        setCode("");
        setSetup(null);
        setImage("");
        if (result.recoveryCodes) {
          setCodes(result.recoveryCodes);
          setSignIn(result.signInRequired);
        } else location.assign("/app");
      }
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Authenticator update failed",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card content-editor">
      <h2>Authenticator security</h2>
      <p>
        Protect sign-in with a six-digit authenticator code. Password resets do
        not remove this protection. Keep recovery codes somewhere safe outside
        this browser.
      </p>
      {message && <p role="alert">{message}</p>}
      {codes.length ? (
        <>
          <h3>Save your recovery codes now</h3>
          <p>
            Each code works once. These codes will not be shown again. Enabling
            or disabling MFA signs out all sessions.
          </p>
          <pre className="recovery-codes">{codes.join("\n")}</pre>
          <button
            className="btn ghost"
            onClick={() =>
              download(
                "invibox-recovery-codes.txt",
                codes.join("\n"),
                "text/plain",
              )
            }
          >
            Download recovery codes
          </button>
          <button
            className="btn primary"
            onClick={() => {
              if (signIn) location.assign("/app");
              else {
                setCodes([]);
                load();
              }
            }}
          >
            {signIn ? "I saved my codes — sign in" : "I saved my codes"}
          </button>
        </>
      ) : status ? (
        <>
          <p>
            {status.enabled
              ? `Enabled · ${status.recoveryCodesRemaining} recovery codes remaining`
              : "Not enabled"}
          </p>
          {!status.available && !status.enabled ? (
            <p>
              The operator must configure MFA encryption before you can use this
              feature.
            </p>
          ) : (
            <>
              <label>
                Password for authenticator changes
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              {setup && (
                <>
                  <p>
                    Scan this QR in your authenticator, or enter this key
                    manually. Setup expires in ten minutes. Never share this
                    key.
                  </p>
                  {image && (
                    <img
                      width="256"
                      height="256"
                      src={image}
                      alt="Authenticator setup QR"
                    />
                  )}
                  <code className="recovery-codes">{setup.secret}</code>
                </>
              )}
              {(setup || status.enabled) && (
                <label>
                  Authenticator or recovery code
                  <input
                    value={code}
                    autoComplete="one-time-code"
                    maxLength={64}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
              )}
              <div className="editor-actions">
                {!status.enabled ? (
                  <button
                    className="btn primary"
                    disabled={busy || !password || (!!setup && !code)}
                    onClick={() => act(setup ? "enable" : "setup")}
                  >
                    {setup ? "Confirm and enable MFA" : "Set up authenticator"}
                  </button>
                ) : (
                  <>
                    <button
                      className="btn ghost"
                      disabled={busy || !password || !code}
                      onClick={() => {
                        if (
                          confirm(
                            "Replace every unused recovery code? Save the new codes immediately.",
                          )
                        )
                          act("recovery");
                      }}
                    >
                      Replace recovery codes
                    </button>
                    <button
                      className="btn ghost"
                      disabled={busy || !password || !code}
                      onClick={() => {
                        if (
                          confirm(
                            "Disable authenticator protection and sign out every session?",
                          )
                        )
                          act("disable");
                      }}
                    >
                      Disable MFA
                    </button>
                  </>
                )}
              </div>
              <small>
                Codes are single-use, including setup confirmation. If a code
                was just used, wait for the next 30-second code or use a
                recovery code.
              </small>
            </>
          )}
        </>
      ) : (
        <p>Loading authenticator status…</p>
      )}
    </section>
  );
}
export function MfaLogin({
  challenge,
  onBack,
}: {
  challenge: string;
  onBack: () => void;
}) {
  const [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <main className="account-page">
      <h1>Confirm your sign-in</h1>
      <p>
        Enter your authenticator code or one unused recovery code. This
        challenge expires in five minutes and allows five attempts.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.completeMfa(challenge, code);
            location.reload();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Verification failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Authenticator or recovery code
          <input
            required
            autoComplete="one-time-code"
            value={code}
            maxLength={64}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button disabled={busy} className="btn primary">
          Verify sign-in
        </button>
        <button type="button" onClick={onBack} className="btn ghost">
          Back to password sign-in
        </button>
      </form>
    </main>
  );
}
