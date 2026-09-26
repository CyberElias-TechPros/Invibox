import { registerUnsavedEditor } from "./unsaved";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Eye, Plus, Save, Trash2 } from "lucide-react";
import { api } from "./api";
import { useEventStore } from "./useStore";
type Section = {
  title: string;
  type: string;
  content: { text: string };
  visible: boolean;
};
export default function ExperienceEditor({
  notify,
}: {
  notify: (message: string) => void;
}) {
  const { event, eventId, refresh } = useEventStore();
  const [sections, setSections] = useState<Section[]>([]);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const canEdit =
    ["owner", "admin", "designer"].includes(event?.member_role || "") &&
    !["live", "completed", "archived"].includes(event?.lifecycle || "");
  const load = async () => {
    try {
      const snap = await api.snapshot(eventId);
      setSections(
        snap.sections.map((s: any) => ({
          title: s.title,
          type: s.type,
          content: { text: JSON.parse(s.content_json).text || "" },
          visible: Boolean(s.is_visible),
        })),
      );
      setVersion(snap.event.sections_version);
      setDirty(false);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load invitation");
    }
  };
  useEffect(() => {
    load();
  }, [eventId]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (dirty) return registerUnsavedEditor();
  }, [dirty]);
  const change = (next: Section[]) => {
    setSections(next);
    setDirty(true);
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.syncSections(eventId, sections, version);
      setVersion(result.version);
      setDirty(false);
      await refresh();
      notify("Invitation content saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <div className="page-intro">
        <div>
          <h1>Invitation experience</h1>
          <p>
            Event details and eligible occasions come from your event and
            schedule. Add your own welcome, story, instructions or FAQ below.
          </p>
        </div>
      </div>
      <div className="editor-actions">
        <a
          className="btn ghost"
          href={`/invite/${event?.slug}?preview=${eventId}`}
          target="_blank"
          rel="noopener"
        >
          <Eye size={16} /> Private preview
        </a>
        <button
          className="btn primary"
          disabled={!canEdit || busy || !dirty}
          onClick={save}
        >
          <Save size={16} />
          {busy ? "Saving…" : "Save content"}
        </button>
        {["owner", "admin"].includes(event?.member_role || "") &&
          ["draft", "preview"].includes(event?.lifecycle || "") && (
            <button
              className="btn ghost"
              disabled={dirty || busy}
              onClick={async () => {
                try {
                  await api.updateEvent(eventId, { lifecycle: "published" });
                  await refresh();
                  notify(
                    "Invitation published. Share individual links from the guest list.",
                  );
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Could not publish",
                  );
                }
              }}
            >
              Publish invitation
            </button>
          )}
      </div>
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            onClick={() => {
              if (!dirty || confirm("Discard edits and reload?")) load();
            }}
          >
            Reload latest content
          </button>
        </p>
      )}
      <p role="status">
        {dirty
          ? "Unsaved content — save before leaving this page."
          : "Content is up to date."}{" "}
        {!canEdit &&
          "Your role or the event lifecycle makes this page read-only."}
      </p>
      {sections.map((section, index) => (
        <section className="card content-editor" key={index}>
          <label>
            Section heading
            <input
              maxLength={100}
              value={section.title}
              disabled={!canEdit}
              onChange={(e) =>
                change(
                  sections.map((s, i) =>
                    i === index ? { ...s, title: e.target.value } : s,
                  ),
                )
              }
            />
          </label>
          <label>
            Content
            <textarea
              rows={5}
              maxLength={10000}
              value={section.content.text}
              disabled={!canEdit}
              onChange={(e) =>
                change(
                  sections.map((s, i) =>
                    i === index
                      ? { ...s, content: { text: e.target.value } }
                      : s,
                  ),
                )
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={section.visible}
              disabled={!canEdit}
              onChange={(e) =>
                change(
                  sections.map((s, i) =>
                    i === index ? { ...s, visible: e.target.checked } : s,
                  ),
                )
              }
            />{" "}
            Visible to invited guests
          </label>
          <div className="editor-actions">
            <button
              className="btn ghost"
              aria-label="Move section up"
              disabled={!canEdit || index === 0}
              onClick={() => {
                const next = [...sections];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                change(next);
              }}
            >
              <ArrowUp size={16} />
            </button>
            <button
              className="btn ghost"
              aria-label="Move section down"
              disabled={!canEdit || index === sections.length - 1}
              onClick={() => {
                const next = [...sections];
                [next[index + 1], next[index]] = [next[index], next[index + 1]];
                change(next);
              }}
            >
              <ArrowDown size={16} />
            </button>
            <button
              className="btn ghost"
              disabled={!canEdit}
              onClick={() => change(sections.filter((_, i) => i !== index))}
            >
              <Trash2 size={16} />
              Remove
            </button>
          </div>
        </section>
      ))}
      <button
        className="btn ghost"
        disabled={!canEdit || sections.length >= 50}
        onClick={() =>
          change([
            ...sections,
            {
              title: "New section",
              type: "custom",
              content: { text: "" },
              visible: true,
            },
          ])
        }
      >
        <Plus size={16} />
        Add section
      </button>
    </div>
  );
}
