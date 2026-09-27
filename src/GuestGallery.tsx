import { useEffect, useRef, useState } from "react";
import { api } from "./api";
type Photo = { id: string; caption: string; status: string; own: number };
function ProtectedPhoto({
  slug,
  token,
  photo,
}: {
  slug: string;
  token: string;
  photo: Photo;
}) {
  const ref = useRef<HTMLDivElement>(null),
    [url, setUrl] = useState(""),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true,
      objectUrl = "";
    const controller = new AbortController();
    const load = () => {
      api
        .guestPhoto(slug, photo.id, token, controller.signal)
        .then((blob) => {
          if (active) {
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
          }
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: "200px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => {
      active = false;
      observer.disconnect();
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [slug, token, photo.id]);
  return (
    <div className="guest-photo" ref={ref}>
      {url ? (
        <img
          src={url}
          alt={photo.caption || "Event photo shared with invited guests"}
        />
      ) : (
        <p>{failed ? "Photo unavailable" : "Loading photo…"}</p>
      )}
    </div>
  );
}
export default function GuestGallery({
  slug,
  token,
}: {
  slug: string;
  token: string;
}) {
  const [items, setItems] = useState<Photo[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [uploads, setUploads] = useState(false),
    [gallery, setGallery] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const load = async (after?: string) => {
    const data = await api.guestGallery(slug, token, after);
    setItems((previous) =>
      after
        ? [
            ...previous,
            ...data.items.filter(
              (x: Photo) => !previous.some((p) => p.id === x.id),
            ),
          ]
        : data.items,
    );
    setCursor(data.nextCursor);
    setUploads(data.uploadsEnabled);
    setGallery(data.galleryEnabled);
  };
  useEffect(() => {
    load().catch((e) => setMessage(e.message));
  }, [slug, token]);
  if (!uploads && !gallery && !items.length && !message) return null;
  return (
    <section id="gallery" className="invite-gallery guest-gallery">
      <h2>Photos from our guests</h2>
      <p>
        Only invited guests can view shared, approved photos. Your pending and
        rejected uploads are visible only to you and authorized event staff.
        Photos may contain camera/location metadata; remove sensitive metadata
        before uploading.
      </p>
      {message && <p role="status">{message}</p>}
      {uploads && (
        <form
          className="invite-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget,
              data = new FormData(form);
            setBusy(true);
            try {
              await api.uploadGuestPhoto(slug, token, data);
              form.reset();
              await load();
              setMessage(
                "Photo submitted for organizer review. It is not shared with other guests until approved.",
              );
            } catch (e) {
              setMessage(e instanceof Error ? e.message : "Upload failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Photo (JPEG, PNG or WebP, up to 10 MB)
            <input
              required
              type="file"
              name="file"
              accept="image/jpeg,image/png,image/webp"
            />
          </label>
          <label>
            Photo caption
            <input name="caption" maxLength={500} />
          </label>
          <label className="consent-option">
            <input required type="checkbox" name="consent" value="true" />I have
            permission to upload this photo and share it with invited guests
            after organizer approval.
          </label>
          <p>
            Maximum 20 photos and 100 MB per guest. You can withdraw your own
            uploads below; downloaded copies cannot be recalled.
          </p>
          <button disabled={busy}>
            {busy ? "Uploading…" : "Submit photo for review"}
          </button>
        </form>
      )}
      <button
        className="btn ghost"
        disabled={busy}
        onClick={() => load().catch((e) => setMessage(e.message))}
      >
        Refresh photos
      </button>
      <div className="guest-photo-grid">
        {items.map((photo) => (
          <article key={photo.id}>
            <ProtectedPhoto slug={slug} token={token} photo={photo} />
            <p>{photo.caption}</p>
            {!!photo.own && (
              <>
                <small>Your upload · {photo.status}</small>
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !confirm(
                        "Withdraw this photo? It will no longer be available to guests. Downloaded copies cannot be recalled.",
                      )
                    )
                      return;
                    setBusy(true);
                    try {
                      await api.withdrawGuestPhoto(slug, photo.id, token);
                      await load();
                      setMessage(
                        "Photo withdrawn. Stored-file deletion is queued.",
                      );
                    } catch (e) {
                      setMessage(
                        e instanceof Error ? e.message : "Withdrawal failed",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Withdraw photo
                </button>
              </>
            )}
          </article>
        ))}
      </div>
      {cursor && (
        <button
          className="btn ghost"
          onClick={() => load(cursor).catch((e) => setMessage(e.message))}
        >
          Load more photos
        </button>
      )}
    </section>
  );
}
