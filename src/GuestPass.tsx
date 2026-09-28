import { useEffect, useState } from "react";
import QRCode from "qrcode";
export default function GuestPass({
  token,
  name,
  slug,
}: {
  token: string;
  name: string;
  slug: string;
}) {
  const [image, setImage] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(token, {
      width: 288,
      margin: 4,
      errorCorrectionLevel: "M",
    })
      .then((url) => {
        if (active) setImage(url);
      })
      .catch(() => {
        if (active)
          setMessage(
            "QR generation is unavailable. Copy your pass code for manual check-in.",
          );
      });
    return () => {
      active = false;
    };
  }, [token]);
  return (
    <section className="invite-rsvp">
      <h2>Your check-in pass</h2>
      <p>
        {name}, show this private pass to event staff. A screenshot or saved
        copy works as a pass; staff still need an internet connection to confirm
        check-in.
      </p>
      {image && (
        <>
          <img
            className="guest-pass-image"
            src={image}
            width={288}
            height={288}
            alt={`Private check-in QR pass for ${name}`}
          />
          <p>
            <a
              className="btn ghost"
              download={`${slug}-private-pass.png`}
              href={image}
            >
              Download pass
            </a>
          </p>
        </>
      )}
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(token);
            setMessage(
              "Private pass code copied. Only share it with event staff.",
            );
          } catch {
            setMessage(
              "Clipboard unavailable. Staff can enter the token from your invitation link.",
            );
          }
        }}
      >
        Copy pass code
      </button>
      {message && <p role="status">{message}</p>}
      <small>Rotating your invitation link invalidates this pass.</small>
    </section>
  );
}
