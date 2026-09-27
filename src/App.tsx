import CommerceAdmin, { BillingPanel, BillingReturn } from "./Commerce";
import AuditPanel, { GuestMediaSettings } from "./AuditPanel";
import { confirmNavigation } from "./unsaved";

import EventPrivacy from "./EventPrivacy";
import PaymentsPanel from "./PaymentsPanel";
import { AnnouncementHistory } from "./AnnouncementHistory";
import { GuestAccess } from "./GuestAccess";
import ExperienceEditor from "./ExperienceEditor";

import { calendar, download, csvCell, parseCsv, dateInTimezone } from "./files";
import { TeamPanel } from "./TeamPanel";
import {
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  LayoutDashboard,
  Sparkles,
  Users,
  CalendarDays,
  Armchair,
  MessageCircle,
  ScanLine,
  Images,
  WalletCards,
  Handshake,
  ChartNoAxesCombined,
  Settings,
  Search,
  Bell,
  Plus,
  ChevronDown,
  ArrowUpRight,
  MoreHorizontal,
  Eye,
  Send,
  UserPlus,
  Clock3,
  MapPin,
  Check,
  X,
  Copy,
  QrCode,
  Utensils,
  Download,
  Filter,
  GripVertical,
  Globe2,
  Smartphone,
  Monitor,
  WandSparkles,
  Lock,
  Music2,
  Gift,
  CircleHelp,
  Camera,
  Upload,
  CheckCircle2,
  Circle,
  Megaphone,
  Mail,
  Phone,
  TrendingUp,
  CalendarPlus,
  ExternalLink,
  Menu,
  Heart,
  Navigation,
  Share2,
  Pencil,
  Trash2,
  ChevronRight,
  Languages,
  ShieldCheck,
  Zap,
  CloudSun,
  TicketCheck,
  Bus,
  Hotel,
  BookHeart,
  Store,
  Bot,
  Save,
  CircleAlert,
} from "lucide-react";
import type { PageKey, Guest, GuestStatus } from "./types";
import { budget } from "./data";
import { EventStoreProvider, useEventStore } from "./useStore";
import { api } from "./api";

const PublicInvite = lazy(() => import("./PublicInvite"));
const Marketing = lazy(() => import("./Marketing"));
const MfaLogin = lazy(() =>
  import("./MfaPanel").then((module) => ({ default: module.MfaLogin })),
);
const AccountPage = lazy(() => import("./AccountPage"));
const VerifyEmail = lazy(() =>
  import("./AccountPage").then((module) => ({ default: module.VerifyEmail })),
);
const Unsubscribe = lazy(() =>
  import("./CommunicationPreferences").then((module) => ({
    default: module.Unsubscribe,
  })),
);

const nav: [PageKey, string, any][] = [
  ["overview", "Overview", LayoutDashboard],
  ["experience", "Experience", Sparkles],
  ["guests", "Guests", Users],
  ["schedule", "Schedule", CalendarDays],
  ["seating", "Seating", Armchair],
  ["messages", "Messages", MessageCircle],
  ["checkin", "Check-in", ScanLine],
  ["memories", "Memories", Images],
  ["budget", "Budget", WalletCards],
  ["vendors", "Vendors", Handshake],
  ["analytics", "Analytics", ChartNoAxesCombined],
  ["settings", "Settings", Settings],
];
const fmt = (n: number) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(n);

function Toast({ text }: { text: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 15 }}
      className="toast"
    >
      <CheckCircle2 size={17} />
      {text}
    </motion.div>
  );
}
function Modal({
  children,
  onClose,
  wide = false,
}: {
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]',
        ) || [],
      );
    (focusable()[0] || panel.current)?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0],
          last = items[items.length - 1];
        if (!first) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={onClose}
    >
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Event workspace dialog"
        tabIndex={-1}
        className={"modal " + (wide ? "modal-wide" : "")}
        initial={{ opacity: 0, scale: 0.97, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
function Status({ value }: { value: GuestStatus }) {
  return (
    <span className={"status " + value.toLowerCase()}>
      <i />
      {value}
    </span>
  );
}
function Avatar({
  initials,
  muted = false,
}: {
  initials: string;
  muted?: boolean;
}) {
  return <span className={"avatar " + (muted ? "muted" : "")}>{initials}</span>;
}

function Sidebar({
  page,
  setPage,
  mobile,
  setMobile,
}: {
  page: PageKey;
  setPage: (p: PageKey) => void;
  mobile: boolean;
  setMobile: (v: boolean) => void;
}) {
  const { event, events, switchEvent, logout, guests, user } = useEventStore();
  return (
    <aside className={"sidebar " + (mobile ? "open" : "")}>
      <div className="brand">
        <span className="brandmark">i</span>
        <b>invibox</b>
        <button className="mobile-close" onClick={() => setMobile(false)}>
          <X />
        </button>
      </div>
      <label className="event-select">
        <div className="event-thumb">
          {event?.title
            ?.split(/\s+/)
            .filter((x) => x !== "&")
            .slice(0, 2)
            .map((x) => x[0])
            .join("") || "EV"}
        </div>
        <div>
          <small>Current event</small>
          <select
            aria-label="Current event"
            value={event?.id || ""}
            onChange={(e) => switchEvent(e.target.value)}
          >
            {events.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </div>
        <ChevronDown size={16} />
      </label>
      <nav>
        {nav
          .filter(([key]) =>
            event?.member_role === "checkin_staff"
              ? key === "checkin"
              : event?.member_role === "designer"
                ? ["experience", "schedule", "memories"].includes(key)
                : ["owner", "admin"].includes(event?.member_role || "") ||
                  !["settings", "budget", "vendors"].includes(key),
          )
          .map(([key, label, Icon]) => (
            <button
              key={key}
              className={page === key ? "active" : ""}
              onClick={() => {
                setPage(key);
                setMobile(false);
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
              {key === "guests" && <em>{guests.length}</em>}
            </button>
          ))}
      </nav>
      <div className="sidebar-bottom">
        <a className="help-link" href="/app/account">
          Account & security
        </a>
        <a className="help-link" href="mailto:help@invibox.app">
          <CircleHelp size={18} />
          Help centre
        </a>
        <div className="profile">
          <Avatar
            initials={
              user?.name
                .split(/\s+/)
                .slice(0, 2)
                .map((x) => x[0])
                .join("") || "U"
            }
          />
          <div>
            <strong>{user?.name || "Your account"}</strong>
            <small>{event?.member_role?.replaceAll("_", " ")}</small>
          </div>
          <button
            className="plain"
            title="Sign out"
            aria-label="Sign out"
            onClick={logout}
          >
            <ExternalLink size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function Topbar({
  page,
  onMobile,
  onNew,
  onPreview,
}: {
  page: PageKey;
  onMobile: () => void;
  onNew: () => void;
  onPreview: () => void;
}) {
  const title = nav.find((n) => n[0] === page)?.[1];
  const { online, loading, error, event } = useEventStore();
  const date = event?.starts_at
    ? new Intl.DateTimeFormat("en-NG", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date(event.starts_at))
    : "Date to be confirmed";
  return (
    <header className="topbar">
      <button className="menu-btn" onClick={onMobile}>
        <Menu />
      </button>
      <div>
        <h1>{title}</h1>
        <p>
          {date} <span>•</span> {event?.location || "Location to be confirmed"}
        </p>
      </div>
      <div className="top-actions">
        <span
          className={"sync-state " + (online ? "online" : "offline")}
          title={error || "Cloudflare backend connected"}
        >
          <i />
          {loading ? "Connecting" : online ? "Connected" : "Not connected"}
        </span>
        <button className="btn ghost preview-top" onClick={onPreview}>
          <Eye size={17} /> View invite
        </button>
        <button className="btn primary" onClick={onNew}>
          <Plus size={17} /> New event
        </button>
      </div>
    </header>
  );
}

function Overview({
  setPage,
  notify,
}: {
  setPage: (p: PageKey) => void;
  notify: (s: string) => void;
}) {
  const { guests, event, user } = useEventStore();
  const attending = guests
    .filter((g) => g.status === "Attending")
    .reduce((a, g) => a + g.party, 0);
  const pending = guests
    .filter((g) => g.status === "Pending")
    .reduce((a, g) => a + g.party, 0);
  const declined = guests
    .filter((g) => g.status === "Declined")
    .reduce((a, g) => a + g.party, 0);
  const invited = guests.reduce((a, g) => a + g.party, 0);
  const days = Math.max(
    0,
    Math.ceil(
      ((event?.starts_at ? new Date(event.starts_at).getTime() : Date.now()) -
        Date.now()) /
        86400000,
    ),
  );
  return (
    <div className="page overview-page">
      <section className="welcome">
        <div>
          <span className="eyebrow">
            WELCOME, {user?.name.split(" ")[0]?.toUpperCase() || "ORGANIZER"}
          </span>
          <h2>
            Your celebration is coming
            <br />
            <i>beautifully together.</i>
          </h2>
          <p>
            {days} days to go. Here’s what’s happening with{" "}
            {event?.title || "your event"}.
          </p>
        </div>
        <div className="countdown">
          <div>
            <strong>{String(days).padStart(3, "0")}</strong>
            <small>DAYS</small>
          </div>
          <span>:</span>
          <div>
            <strong>
              {Math.floor(
                Math.max(
                  0,
                  new Date(event?.starts_at || Date.now()).getTime() -
                    Date.now(),
                ) / 3600000,
              ) % 24}
            </strong>
            <small>HOURS</small>
          </div>
          <span>:</span>
          <div>
            <strong>
              {Math.floor(
                Math.max(
                  0,
                  new Date(event?.starts_at || Date.now()).getTime() -
                    Date.now(),
                ) / 60000,
              ) % 60}
            </strong>
            <small>MIN</small>
          </div>
        </div>
      </section>
      <section className="metric-grid">
        <Metric
          title="Total invited"
          value={String(invited)}
          detail={`${guests.length} guest records`}
          icon={Users}
          tone="sage"
        />
        <Metric
          title="Attending"
          value={String(attending)}
          detail={`${invited ? Math.round((attending / invited) * 100) : 0}% response rate`}
          icon={CheckCircle2}
          tone="green"
        />
        <Metric
          title="Awaiting reply"
          value={String(pending)}
          detail={
            pending ? "Ready for a gentle reminder" : "Everyone has replied"
          }
          icon={Clock3}
          tone="amber"
          action={pending ? "Send reminder" : undefined}
          onAction={() => {
            setPage("messages");
            notify(`Prepare a reminder for ${pending} awaiting guests`);
          }}
        />
        <Metric
          title="Declined"
          value={String(declined)}
          detail={`${invited ? Math.round((declined / invited) * 100) : 0}% of invitees`}
          icon={X}
          tone="rose"
        />
      </section>
      <div className="overview-grid">
        <section className="card activity-card">
          <CardHead
            title="Guest activity"
            sub="Current responses across your guest list"
            action="View guests"
            onAction={() => setPage("guests")}
          />
          <ActivityChart />
          <div className="chart-legend">
            <span>
              <i className="green-dot" />
              Attending <b>{attending}</b>
            </span>
            <span>
              <i className="amber-dot" />
              Pending <b>{pending}</b>
            </span>
            <span>
              <i className="rose-dot" />
              Declined <b>{declined}</b>
            </span>
          </div>
        </section>
        <section className="card actions-card">
          <CardHead title="Quick actions" sub="Keep things moving" />
          <div className="quick-grid">
            <Quick
              icon={UserPlus}
              label="Add guests"
              onClick={() => setPage("guests")}
            />
            <Quick
              icon={Send}
              label="Send update"
              onClick={() => setPage("messages")}
            />
            <Quick
              icon={Eye}
              label="Preview invite"
              onClick={() =>
                window.open(
                  `/invite/${event?.slug}?preview=${event?.id}`,
                  "_blank",
                )
              }
            />
            <Quick
              icon={QrCode}
              label="Check-in QR"
              onClick={() => setPage("checkin")}
            />
            <Quick
              icon={Armchair}
              label="Plan seating"
              onClick={() => setPage("seating")}
            />
            <Quick
              icon={Download}
              label="Export list"
              onClick={() => setPage("guests")}
            />
          </div>
        </section>
      </div>
      <div className="overview-grid bottom-grid">
        <section className="card timeline-card">
          <CardHead
            title="Coming up"
            sub="Your planning timeline"
            action="Full schedule"
            onAction={() => setPage("schedule")}
          />
          <Timeline setPage={setPage} />
        </section>
        <section className="card invite-card">
          <div className="invite-mini">
            <img src="/wedding-hero.jpg" />
            <div className="invite-mini-copy">
              <span>{event?.event_type?.toUpperCase() || "YOUR EVENT"}</span>
              <strong>{event?.title || "Untitled event"}</strong>
              <small>
                {event?.starts_at
                  ?.slice(0, 10)
                  .split("-")
                  .reverse()
                  .join(" · ") || "DATE TO COME"}
              </small>
            </div>
          </div>
          <div className="invite-info">
            <div>
              <span className="live-dot" />
              {event?.lifecycle || "Draft"}
            </div>
            <strong>/invite/{event?.slug || "event"}</strong>
            <div className="inline-actions">
              <button
                onClick={() => {
                  if (event?.visibility !== "public") {
                    setPage("guests");
                    notify(
                      "Use a guest-specific private link from the guest list.",
                    );
                    return;
                  }
                  navigator.clipboard?.writeText(
                    `${location.origin}/invite/${event?.slug || "event"}`,
                  );
                  notify("Invite link copied");
                }}
              >
                <Copy size={16} />
                Copy link
              </button>
              <button
                onClick={() =>
                  window.open(
                    `/invite/${event?.slug}?preview=${event?.id}`,
                    "_blank",
                  )
                }
              >
                <ExternalLink size={16} />
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
function Metric({
  title,
  value,
  detail,
  icon: Icon,
  tone,
  trend,
  action,
  onAction,
}: {
  title: string;
  value: string;
  detail: string;
  icon: any;
  tone: string;
  trend?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="metric card">
      <div className={"metric-icon " + tone}>
        <Icon size={19} />
      </div>
      <div className="metric-title">
        {title}
        <MoreHorizontal size={17} />
      </div>
      <strong>{value}</strong>
      <div className="metric-foot">
        <span>{detail}</span>
        {trend && (
          <em>
            <TrendingUp size={12} />
            {trend}
          </em>
        )}
        {action && (
          <button onClick={onAction}>
            {action}
            <ArrowUpRight size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
function CardHead({
  title,
  sub,
  action,
  onAction,
}: {
  title: string;
  sub: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="card-head">
      <div>
        <h3>{title}</h3>
        <p>{sub}</p>
      </div>
      {action && (
        <button onClick={onAction}>
          {action}
          <ChevronRight size={14} />
        </button>
      )}
    </div>
  );
}
function Quick({
  icon: Icon,
  label,
  onClick,
}: {
  icon: any;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className="quick" onClick={onClick}>
      <span>
        <Icon size={19} />
      </span>
      {label}
      <ChevronRight size={14} />
    </button>
  );
}
function ActivityChart() {
  const { guests } = useEventStore();
  const total = guests.reduce((sum, g) => sum + g.party, 0);
  return (
    <div className="response-summary">
      {!total ? (
        <p>Add guests to see response statistics.</p>
      ) : (
        ["Attending", "Pending", "Declined"].map((status) => {
          const count = guests
            .filter((g) => g.status === status)
            .reduce((sum, g) => sum + g.party, 0);
          return (
            <label key={status}>
              {status} — {count}
              <progress
                aria-label={`${status} seats`}
                value={count}
                max={total}
              />
            </label>
          );
        })
      )}
    </div>
  );
}
function Timeline({ setPage }: { setPage: (p: PageKey) => void }) {
  const { event, schedule } = useEventStore();
  return (
    <div className="timeline">
      <div>
        <i />
        <span>
          <b>Event status</b>
          <small>{event?.lifecycle}</small>
        </span>
        <button onClick={() => setPage("experience")}>Review</button>
      </div>
      {schedule.slice(0, 3).map((o) => (
        <div key={o.id}>
          <i />
          <span>
            <b>{o.title}</b>
            <small>
              {o.date} · {o.time} · {event?.timezone}
            </small>
          </span>
        </div>
      ))}
      {!schedule.length && (
        <p>Add occasions to build your planning timeline.</p>
      )}
      <button className="btn ghost" onClick={() => setPage("schedule")}>
        Manage schedule
      </button>
    </div>
  );
}
function GuestsPage({ notify }: { notify: (s: string) => void }) {
  const { guests, setGuests, eventId, event, refresh } = useEventStore();
  const [accessGuest, setAccessGuest] = useState<Guest | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [add, setAdd] = useState(false);
  const shown = guests.filter(
    (g) =>
      (filter === "All" || g.status === filter) &&
      g.name.toLowerCase().includes(search.toLowerCase()),
  );
  const exportCsv = () => {
    const text = [
      "Name,Group,Status,Party,Meal,Table,Email,Phone",
      ...guests.map((g) =>
        [g.name, g.group, g.status, g.party, g.meal, g.table, g.email, g.phone]
          .map(csvCell)
          .join(","),
      ),
    ].join("\r\n");
    download(
      `${event?.slug || "event"}-guests.csv`,
      text,
      "text/csv;charset=utf-8",
    );
    notify("Guest list exported");
  };
  return (
    <div className="page">
      <PageIntro
        title="Guest list"
        text="Manage invitations, households and responses in one place."
        actions={
          <>
            <label className="btn ghost import-btn">
              <Upload size={16} />
              Import CSV
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  file
                    .text()
                    .then((text) => {
                      if (file.size > 2 * 1024 * 1024)
                        throw new Error("CSV must be smaller than 2 MB");
                      const lines = parseCsv(text);
                      const headers = (lines.shift() || []).map((x) =>
                        x.toLowerCase(),
                      );
                      if (
                        !headers.includes("name") &&
                        !headers.includes("guest name")
                      )
                        throw new Error("CSV needs a Name column");
                      if (lines.length + guests.length > 5000)
                        throw new Error(
                          "An event supports up to 5,000 guest records",
                        );
                      const imported = lines
                        .map((cells, i) => {
                          const get = (name: string) =>
                            cells[headers.indexOf(name)] || "";
                          const name = get("name") || get("guest name");
                          if (!name) return null;
                          return {
                            id: crypto.randomUUID(),
                            email: get("email"),
                            phone: get("phone").replace(/^'/, ""),
                            name,
                            initials: name
                              .split(" ")
                              .slice(0, 2)
                              .map((x) => x[0])
                              .join("")
                              .toUpperCase(),
                            group: get("group") || "Imported",
                            status: ([
                              "Attending",
                              "Pending",
                              "Declined",
                            ].includes(get("status"))
                              ? get("status")
                              : "Pending") as GuestStatus,
                            party: Math.min(
                              30,
                              Math.max(
                                1,
                                Math.floor(Number(get("party") || 1)),
                              ),
                            ),
                            meal: get("meal") || "—",
                            checkedIn: false,
                          };
                        })
                        .filter(Boolean) as Guest[];
                      setGuests([...guests, ...imported]);
                      notify(`${imported.length} guests queued for saving`);
                    })
                    .catch((error) => notify(error.message));
                }}
              />
            </label>
            <button className="btn ghost" onClick={exportCsv}>
              <Download size={16} />
              Export
            </button>
            <button className="btn primary" onClick={() => setAdd(true)}>
              <UserPlus size={16} />
              Add guest
            </button>
          </>
        }
      />
      <div className="summary-strip">
        <span>
          <b>{guests.length}</b>Total records
        </span>
        <span>
          <b>{guests.filter((g) => g.status === "Attending").length}</b>
          Attending
        </span>
        <span>
          <b>{guests.filter((g) => g.status === "Pending").length}</b>Awaiting
          reply
        </span>
        <span>
          <b>{guests.reduce((a, g) => a + g.party, 0)}</b>Seats allocated
        </span>
      </div>
      <section className="card table-card">
        <div className="table-toolbar">
          <div className="searchbox">
            <Search size={16} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search guests, groups…"
            />
          </div>
          <div className="filter-tabs">
            {["All", "Attending", "Pending", "Declined"].map((x) => (
              <button
                className={filter === x ? "active" : ""}
                onClick={() => setFilter(x)}
                key={x}
              >
                {x}
              </button>
            ))}
          </div>
        </div>
        <div className="data-table">
          <div className="tr th">
            <span>Guest</span>
            <span>Group</span>
            <span>Response</span>
            <span>Party</span>
            <span>Meal preference</span>
            <span>Table</span>
            <span />
          </div>
          {shown.map((g) => (
            <div className="tr" key={g.id}>
              <span className="guest-name">
                <Avatar initials={g.initials} />
                <b>{g.name}</b>
              </span>
              <span>{g.group}</span>
              <span>
                <Status value={g.status} />
              </span>
              <span>{g.party}</span>
              <span>{g.meal}</span>
              <span>{g.table || "—"}</span>
              <span>
                <button
                  className="plain"
                  aria-label={`Occasion access for ${g.name}`}
                  onClick={() => setAccessGuest(g)}
                >
                  <ShieldCheck size={15} />
                </button>
                <button
                  className="plain"
                  aria-label={`New private link for ${g.name}`}
                  onClick={async () => {
                    if (
                      !confirm(
                        "Create a new link? The previous link will stop working.",
                      )
                    )
                      return;
                    try {
                      const result = await api.rotateGuestToken(eventId, g.id);
                      await refresh();
                      await navigator.clipboard.writeText(
                        `${location.origin}/invite/${event?.slug}?token=${encodeURIComponent(result.token)}`,
                      );
                      notify("New private link copied");
                    } catch (e) {
                      notify(
                        e instanceof Error
                          ? e.message
                          : "Could not create link",
                      );
                    }
                  }}
                >
                  <Copy size={15} />
                </button>
                <button
                  className="plain"
                  aria-label={`Delete ${g.name}`}
                  onClick={() => {
                    if (
                      confirm(`Remove ${g.name} and revoke their invitation?`)
                    )
                      setGuests(guests.filter((x) => x.id !== g.id));
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>
      {accessGuest && (
        <GuestAccess
          guest={accessGuest}
          onClose={() => setAccessGuest(null)}
          notify={notify}
        />
      )}
      <AnimatePresence>
        {add && (
          <AddGuest
            onClose={() => setAdd(false)}
            onAdd={async (g) => {
              const result = await api.addGuest(eventId, g);
              await refresh();
              setAdd(false);
              const link = `${location.origin}/invite/${event?.slug || "event"}?token=${encodeURIComponent(result.token)}`;
              await navigator.clipboard.writeText(link);
              notify("Guest added — personalized link copied");
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
function AddGuest({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (g: Guest) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [failure, setFailure] = useState("");
  const [group, setGroup] = useState("Friends");
  const [party, setParty] = useState(1);
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <div>
          <span className="eyebrow">NEW INVITATION</span>
          <h2>Add a guest</h2>
          <p>Create a personalized invite and reserve their seats.</p>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="form-grid">
        <label className="full">
          Guest or household name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. The Balogun Family"
          />
        </label>
        <label>
          Guest group
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option>Friends</option>
            <option>Bride's family</option>
            <option>Groom's family</option>
            <option>VIP</option>
            <option>Colleagues</option>
          </select>
        </label>
        <label>
          Reserved seats
          <input
            type="number"
            min="1"
            max="20"
            value={party}
            onChange={(e) => setParty(+e.target.value)}
          />
        </label>
        <label>
          Email address
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="guest@example.com"
          />
        </label>
        <label>
          Phone / WhatsApp
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+234…"
          />
        </label>
      </div>
      <p>
        Saving creates a private link to copy and send yourself. It does not
        automatically send an invitation.
      </p>
      {failure && <p role="alert">{failure}</p>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!name || saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onAdd({
                id: Date.now(),
                name,
                email,
                phone,
                initials: name
                  .split(" ")
                  .slice(0, 2)
                  .map((s) => s[0])
                  .join("")
                  .toUpperCase(),
                group,
                status: "Pending",
                party,
                meal: "—",
                checkedIn: false,
              });
            } catch (e) {
              setFailure(
                e instanceof Error ? e.message : "Could not add guest",
              );
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Adding…" : "Add guest"} <ArrowUpRight size={15} />
        </button>
      </div>
    </Modal>
  );
}

function SchedulePage({ notify }: { notify: (s: string) => void }) {
  const { schedule, setSchedule, event } = useEventStore();
  const [add, setAdd] = useState(false);
  return (
    <div className="page">
      <PageIntro
        title="Event schedule"
        text="One celebration, every moment beautifully coordinated."
        actions={
          <>
            <button
              className="btn ghost"
              onClick={() => {
                const items = schedule
                  .filter((s) => s.starts_at)
                  .map((s) => ({ ...s, starts_at: s.starts_at! }));
                if (items.length !== schedule.length) {
                  notify(
                    "Wait for changes to save, then reload before exporting.",
                  );
                  return;
                }
                download(
                  "event-schedule.ics",
                  calendar(items),
                  "text/calendar",
                );
              }}
            >
              <CalendarPlus size={16} />
              Calendar feed
            </button>
            <button className="btn primary" onClick={() => setAdd(true)}>
              <Plus size={16} />
              Add moment
            </button>
          </>
        }
      />
      <div className="schedule-date-label">
        <CalendarDays size={15} />
        <span>All event moments</span>
        <b>{schedule.length}</b>
      </div>
      <section className="schedule-list">
        {schedule.map((s, i) => (
          <motion.div layout className="schedule-row card" key={s.id}>
            <div className="schedule-time">
              <b>{s.time}</b>
              <span>{s.date}</span>
            </div>
            <div className="schedule-line">
              <i />
            </div>
            <div className="schedule-detail">
              <span className="eyebrow">{s.audience}</span>
              <h3>{s.title}</h3>
              <p>
                <MapPin size={14} />
                {s.place}
              </p>
            </div>
            <div className="schedule-actions">
              <button
                className="icon-btn"
                aria-label={`Delete ${s.title}`}
                onClick={() =>
                  setSchedule(schedule.filter((x) => x.id !== s.id))
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          </motion.div>
        ))}
      </section>
      <AnimatePresence>
        {add && (
          <Modal onClose={() => setAdd(false)}>
            <div className="modal-head">
              <div>
                <h2>Add a moment</h2>
                <p>It will appear on eligible guests’ schedules.</p>
              </div>
              <button className="icon-btn" onClick={() => setAdd(false)}>
                <X />
              </button>
            </div>
            <div className="form-grid">
              <label className="full">
                Title
                <input id="moment-title" placeholder="e.g. Welcome dinner" />
              </label>
              <label>
                Date
                <input
                  id="moment-date"
                  type="date"
                  defaultValue={event?.starts_at.slice(0, 10)}
                />
              </label>
              <label>
                Time ({event?.timezone})
                <input id="moment-time" type="time" defaultValue="18:00" />
              </label>
              <label>
                Audience
                <select id="moment-audience">
                  <option>All guests</option>
                  <option>Family & VIP</option>
                  <option>Friends</option>
                </select>
              </label>
              <label className="full">
                Venue
                <input id="moment-place" placeholder="Venue name and address" />
              </label>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setAdd(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  const title =
                    (
                      document.getElementById(
                        "moment-title",
                      ) as HTMLInputElement
                    ).value || "New event moment";
                  const time = (
                    document.getElementById("moment-time") as HTMLInputElement
                  ).value;
                  setSchedule([
                    ...schedule,
                    {
                      id: Date.now(),
                      title,
                      time,
                      place:
                        (
                          document.getElementById(
                            "moment-place",
                          ) as HTMLInputElement
                        ).value || "Venue to be confirmed",
                      date: (
                        document.getElementById(
                          "moment-date",
                        ) as HTMLInputElement
                      ).value,
                      audience: (
                        document.getElementById(
                          "moment-audience",
                        ) as HTMLSelectElement
                      ).value,
                      isPrivate:
                        (
                          document.getElementById(
                            "moment-audience",
                          ) as HTMLSelectElement
                        ).value !== "All guests",
                    },
                  ]);
                  setAdd(false);
                  notify(
                    "Schedule queued for saving. Private moments require guest access assignment.",
                  );
                }}
              >
                Add to schedule
              </button>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

function Seating({ notify }: { notify: (s: string) => void }) {
  const { guests, seating, eventId, refresh } = useEventStore();
  const [selected, setSelected] = useState<Guest | null>(null);
  const [add, setAdd] = useState(false);
  const assign = async (table: string) => {
    if (!selected) {
      notify("Select an unseated guest first");
      return;
    }
    try {
      await api.assignSeat(eventId, selected.id, table);
      setSelected(null);
      await refresh();
      notify(`Assigned ${selected.name} to ${table}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not assign guest");
    }
  };
  return (
    <div className="page">
      <PageIntro
        title="Seating planner"
        text="Select a guest, then choose their table."
        actions={
          <>
            <button className="btn ghost" onClick={() => window.print()}>
              <Download size={16} />
              Print floor plan
            </button>
            <button className="btn primary" onClick={() => setAdd(true)}>
              <Plus size={16} />
              Add table
            </button>
          </>
        }
      />
      <div className="seating-layout">
        <aside className="card unseated">
          <h3>
            Unseated guests{" "}
            <span>
              {
                guests.filter((g) => !g.table && g.status === "Attending")
                  .length
              }
            </span>
          </h3>
          <div className="searchbox">
            <Search size={15} />
            <input placeholder="Find guest" />
          </div>
          {guests
            .filter((g) => !g.table && g.status === "Attending")
            .map((g) => (
              <button
                className={
                  "drag-guest " + (selected?.id === g.id ? "selected" : "")
                }
                key={g.id}
                onClick={() => setSelected(g)}
              >
                <GripVertical size={15} />
                <Avatar initials={g.initials} />
                <span>
                  <b>{g.name}</b>
                  <small>Party of {g.party}</small>
                </span>
              </button>
            ))}
          {!guests.some((g) => !g.table && g.status === "Attending") && (
            <div className="empty-note">
              <Users />
              <p>Every attending guest has a table.</p>
            </div>
          )}
        </aside>
        <section className="floor">
          <div className="floor-tools">
            <span>Reception floor plan</span>
            <small>
              {selected
                ? `Now seat ${selected.name}`
                : "Select a guest to begin"}
            </small>
          </div>
          {seating.map((t, i) => (
            <button
              onClick={() => assign(t.name)}
              className={"round-table t" + (i % 5)}
              style={{
                left: `${Math.min(80, Math.max(8, t.x))}%`,
                top: `${Math.min(75, Math.max(12, t.y))}%`,
              }}
              key={t.id}
            >
              <div>
                <b>{t.name}</b>
                <small>{t.shape}</small>
                <span>
                  {t.assigned}/{t.capacity}
                </span>
              </div>
              {Array.from({ length: Math.min(Number(t.assigned), 12) }).map(
                (_, n) => (
                  <i
                    key={n}
                    style={{
                      transform: `rotate(${n * (360 / Math.max(1, Number(t.assigned)))}deg) translateY(-49px)`,
                    }}
                  />
                ),
              )}
            </button>
          ))}
          {!seating.length && (
            <div className="floor-empty">
              <Armchair />
              <b>No tables yet</b>
              <span>Add your first table to begin seating guests.</span>
            </div>
          )}
          <div className="dancefloor">DANCE FLOOR</div>
        </section>
      </div>
      <AnimatePresence>
        {add && (
          <Modal onClose={() => setAdd(false)}>
            <div className="modal-head">
              <div>
                <span className="eyebrow">FLOOR PLAN</span>
                <h2>Add a table</h2>
              </div>
              <button className="icon-btn" onClick={() => setAdd(false)}>
                <X />
              </button>
            </div>
            <form
              id="table-form"
              className="form-grid"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                try {
                  await api.addTable(eventId, {
                    name: f.get("name"),
                    shape: f.get("shape"),
                    capacity: Number(f.get("capacity")),
                    x: 20 + (seating.length % 3) * 28,
                    y: 22 + Math.floor(seating.length / 3) * 34,
                  });
                  setAdd(false);
                  await refresh();
                  notify("Table added to the floor plan");
                } catch (err) {
                  notify(
                    err instanceof Error ? err.message : "Could not add table",
                  );
                }
              }}
            >
              <label>
                Table name
                <input name="name" required placeholder="T01" />
              </label>
              <label>
                Capacity
                <input
                  name="capacity"
                  type="number"
                  min="1"
                  max="100"
                  defaultValue="10"
                  required
                />
              </label>
              <label className="full">
                Shape
                <select name="shape">
                  <option value="round">Round</option>
                  <option value="rectangle">Rectangle</option>
                  <option value="head">Head table</option>
                </select>
              </label>
            </form>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setAdd(false)}>
                Cancel
              </button>
              <button className="btn primary" type="submit" form="table-form">
                Add table
              </button>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

function Messages({ notify }: { notify: (s: string) => void }) {
  const { eventId, event, guests } = useEventStore();
  const pendingCount = guests.filter((g) => g.status === "Pending").length;
  const attendingCount = guests.filter((g) => g.status === "Attending").length;
  const [sending, setSending] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [audience, setAudience] = useState("pending");
  const [channel, setChannel] = useState("WhatsApp");
  const eligibleCount = guests.filter(
    (g) =>
      Boolean(
        g[
          `${channel.toLowerCase()}_opt_in` as
            | "email_opt_in"
            | "sms_opt_in"
            | "whatsapp_opt_in"
        ],
      ) &&
      (audience === "all" ||
        (audience === "pending" && g.status === "Pending") ||
        (audience === "attending" && g.status === "Attending") ||
        (audience === "vip" && g.group === "VIP")),
  ).length;
  const [text, setText] = useState(
    `Hello {{first_name}}, ${event?.title || "our celebration"} is almost here! Please confirm your attendance and view the latest details below.`,
  );
  return (
    <div className="page">
      <PageIntro
        title="Guest communications"
        text="Personal, timely updates across every channel."
        actions={
          <>
            <button
              className="btn ghost"
              disabled={aiBusy}
              onClick={async () => {
                if (!eventId) return;
                setAiBusy(true);
                try {
                  const result = await api.aiAssist(
                    eventId,
                    "guest_message",
                    `Improve this ${channel} guest announcement. Preserve {{first_name}} exactly and return only the final message under 500 characters: ${text}`,
                  );
                  setText(result.answer.slice(0, 500));
                  notify("AI draft is ready for your review");
                } catch (e) {
                  notify(
                    e instanceof Error ? e.message : "AI assistant unavailable",
                  );
                } finally {
                  setAiBusy(false);
                }
              }}
            >
              <Bot size={16} />
              {aiBusy ? "Drafting…" : "Draft with AI"}
            </button>
            <button
              className="btn ghost"
              onClick={() =>
                setText(
                  "Hello {{first_name}}, your event is tomorrow. Here are the latest times, venue details and your personal pass. We look forward to welcoming you.",
                )
              }
            >
              <Clock3 size={16} />
              Day-before note
            </button>
          </>
        }
      />
      <div className="message-layout">
        <section className="card composer">
          <h3>Create announcement</h3>
          <p>
            Only guests who opted in to the selected channel are eligible.
            Guests can manage preferences from their invitation; having a
            contact address alone is not consent.
          </p>
          <label>
            Channel
            <div className="channel-tabs">
              {[
                ["WhatsApp", MessageCircle],
                ["Email", Mail],
                ["SMS", Phone],
              ].map(([x, I]: any) => (
                <button
                  key={x}
                  className={channel === x ? "active" : ""}
                  onClick={() => setChannel(x)}
                >
                  <I size={16} />
                  {x}
                </button>
              ))}
            </div>
          </label>
          <p>
            {eligibleCount} guest records currently opted in for this channel
            and audience. Unsubscribe links are added automatically; SMS may
            span multiple billable segments.
          </p>
          <label>
            Recipients
            <select
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
            >
              <option value="pending">
                Guests awaiting reply · {pendingCount}
              </option>
              <option value="all">
                All invited guests · {guests.reduce((n, g) => n + g.party, 0)}
              </option>
              <option value="attending">
                Confirmed guests · {attendingCount}
              </option>
              <option value="vip">
                VIP guests · {guests.filter((g) => g.group === "VIP").length}
              </option>
            </select>
          </label>
          <label>
            Message
            <textarea
              rows={7}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <small>{text.length}/500 characters</small>
          </label>
          <div className="suggestions">
            <button
              onClick={() =>
                setText(
                  "Hello {{first_name}}, a gentle reminder to RSVP for our celebration. Please check your invitation for the latest details and response deadline. We hope you can join us!",
                )
              }
            >
              RSVP reminder
            </button>
            <button
              onClick={() =>
                setText(
                  `Hello {{first_name}}, an important venue update for ${event?.title || "our event"}. Please view the latest details below.`,
                )
              }
            >
              Venue update
            </button>
            <button
              onClick={() =>
                setText(
                  "Hello {{first_name}}, our celebration is tomorrow. Your schedule, directions and personal pass are ready at the link below.",
                )
              }
            >
              Day-before note
            </button>
          </div>
          <button
            className="btn primary send-full"
            disabled={sending || !eventId}
            onClick={async () => {
              setSending(true);
              try {
                await api.announce(eventId, {
                  channel: channel.toLowerCase(),
                  audience,
                  message: text,
                });
                notify(
                  `${channel} announcement queued. Delivery status is separate from provider acceptance`,
                );
              } catch (e) {
                notify(
                  e instanceof Error
                    ? e.message
                    : "Message could not be queued",
                );
              } finally {
                setSending(false);
              }
            }}
          >
            <Send size={16} />
            {sending ? "Queueing…" : "Queue update"}
          </button>
        </section>
        <aside className="phone-preview">
          <div className="phone">
            <div className="phone-notch" />
            <div className="wa-head">
              <Avatar initials="A&C" />
              <span>
                <b>{event?.title || "Your event"}</b>
                <small>online</small>
              </span>
            </div>
            <div className="wa-body">
              <div className="wa-card">
                <img src="/wedding-hero.jpg" />
                <span>{event?.title}</span>
                <p>{text.replace("{{first_name}}", "Kemi")}</p>
                <small>Message preview — not sent</small>
              </div>
            </div>
          </div>
          <p>
            Personalization preview for <b>Kemi</b>
          </p>
        </aside>
      </div>
      <AnnouncementHistory eventId={eventId} />
    </div>
  );
}

const extractPassToken = (value: string) => {
  const raw = value.trim();
  try {
    return new URL(raw, location.origin).searchParams.get("token") || raw;
  } catch {
    return raw;
  }
};
function PassScanner({
  onClose,
  onToken,
}: {
  onClose: () => void;
  onToken: (token: string) => Promise<void>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("Starting camera…");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true,
      stream: MediaStream | undefined,
      timer: number | undefined;
    const start = async () => {
      const Detector = (window as any).BarcodeDetector;
      if (!navigator.mediaDevices?.getUserMedia || !Detector) {
        setStatus(
          "Automatic QR scanning is unavailable in this browser. Enter the secure pass code below.",
        );
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
        });
        if (!active) return;
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play();
        }
        const detector = new Detector({ formats: ["qr_code"] });
        setStatus("Point the camera at the guest QR pass");
        timer = window.setInterval(async () => {
          if (!active || busy || !video.current || video.current.readyState < 2)
            return;
          try {
            const codes = await detector.detect(video.current);
            const token = String(codes?.[0]?.rawValue || "").trim();
            if (token) {
              active = false;
              setBusy(true);
              await onToken(extractPassToken(token));
            }
          } catch {}
        }, 450);
      } catch {
        setStatus(
          "Camera access was denied. Enter the secure pass code below.",
        );
      }
    };
    start();
    return () => {
      active = false;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  return (
    <>
      <div className="modal-head">
        <div>
          <span className="eyebrow">SECURE EVENT ENTRY</span>
          <h2>Scan a guest pass</h2>
          <p>{status}</p>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="camera-scanner">
        <video ref={video} muted playsInline aria-label="QR scanner camera" />
        <span>
          <ScanLine />
        </span>
      </div>
      <form
        id="scan-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onToken(
              extractPassToken(
                String(new FormData(e.currentTarget).get("token")),
              ),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="scan-field">
          Invitation pass code
          <input
            name="token"
            required
            minLength={20}
            autoFocus
            placeholder="Scan or enter secure pass token"
          />
        </label>
      </form>
      <div className="scan-help">
        <QrCode />
        <span>
          <b>Progressive camera scanning</b>
          <small>
            If your browser cannot decode QR codes directly, the secure manual
            field remains available.
          </small>
        </span>
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy}
          type="submit"
          form="scan-form"
        >
          <ScanLine size={15} />
          {busy ? "Validating…" : "Validate pass"}
        </button>
      </div>
    </>
  );
}
function Checkin({ notify }: { notify: (s: string) => void }) {
  const { guests, eventId, refresh } = useEventStore();
  const [scanner, setScanner] = useState(false);
  const [q, setQ] = useState("");
  const shown = guests.filter(
    (g) =>
      g.status === "Attending" &&
      g.name.toLowerCase().includes(q.toLowerCase()),
  );
  const checked = guests
    .filter((g) => g.checkedIn)
    .reduce((a, g) => a + g.party, 0);
  const expected = guests
    .filter((g) => g.status === "Attending")
    .reduce((a, g) => a + g.party, 0);
  return (
    <div className="page">
      <PageIntro
        title="Event check-in"
        text="Check in guests securely. An internet connection is required to confirm arrivals."
        actions={
          <>
            <span className="offline-ready">
              <CloudSun size={16} />
              Online confirmation
            </span>
            <button className="btn primary" onClick={() => setScanner(true)}>
              <ScanLine size={16} />
              Scan QR pass
            </button>
          </>
        }
      />
      <div className="checkin-metrics">
        <div>
          <span>Checked in</span>
          <b>{checked}</b>
          <small>of {expected} expected</small>
        </div>
        <div>
          <span>Arrival rate</span>
          <b>{expected ? Math.round((checked / expected) * 100) : 0}%</b>
          <small>Peak at 4:42 PM</small>
        </div>
        <div>
          <span>Stations online</span>
          <b>3</b>
          <small>Grand entrance · VIP · Garden</small>
        </div>
      </div>
      <section className="card table-card">
        <div className="table-toolbar">
          <div className="searchbox grow">
            <Search size={16} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search guest by name, phone or table…"
            />
          </div>
        </div>
        <div className="check-list">
          {shown.map((g) => (
            <div key={g.id}>
              <Avatar initials={g.initials} />
              <span>
                <b>{g.name}</b>
                <small>
                  Party of {g.party} · {g.table || "No table"}
                </small>
              </span>
              <button
                className={g.checkedIn ? "checked" : ""}
                onClick={async () => {
                  const next = !g.checkedIn;
                  try {
                    if (eventId) await api.checkin(eventId, g.id, next);
                    await refresh();
                    notify(next ? `${g.name} checked in` : "Check-in reversed");
                  } catch (e) {
                    notify(e instanceof Error ? e.message : "Check-in failed");
                  }
                }}
              >
                {g.checkedIn ? (
                  <>
                    <Check size={15} />
                    Checked in
                  </>
                ) : (
                  <>
                    <TicketCheck size={15} />
                    Check in
                  </>
                )}
              </button>
            </div>
          ))}
        </div>
      </section>
      <AnimatePresence>
        {scanner && (
          <Modal onClose={() => setScanner(false)}>
            <PassScanner
              onClose={() => setScanner(false)}
              onToken={async (token) => {
                try {
                  const result = await api.scanPass(eventId, token);
                  await refresh();
                  setScanner(false);
                  notify(
                    result.alreadyCheckedIn
                      ? `${result.guest.name} was already checked in`
                      : `${result.guest.name} checked in successfully`,
                  );
                } catch (err) {
                  notify(
                    err instanceof Error
                      ? err.message
                      : "Pass could not be scanned",
                  );
                  throw err;
                }
              }}
            />
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

function Memories({ notify }: { notify: (s: string) => void }) {
  const { eventId, event, media, refresh } = useEventStore();
  const [uploading, setUploading] = useState(false);
  const [galleryFilter, setGalleryFilter] = useState<
    "All" | "Pending" | "Approved" | "Rejected"
  >("All");
  const shown = media.filter(
    (item) =>
      galleryFilter === "All" || item.status === galleryFilter.toLowerCase(),
  );
  return (
    <div className="page">
      <PageIntro
        title="Memory vault"
        text="Collect the moments your photographer couldn’t be everywhere for."
        actions={
          <>
            <button
              className="btn ghost"
              onClick={() =>
                notify(
                  "Guests upload from their personal invitation. Copy or rotate individual links under Guests; there is no anonymous upload link.",
                )
              }
            >
              <Copy size={16} />
              Guest upload access
            </button>
            <label className="btn primary upload-btn">
              <Upload size={16} />
              {uploading ? "Uploading…" : "Add media"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4,audio/mpeg"
                disabled={uploading}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploading(true);
                  try {
                    await api.uploadMedia(eventId, file);
                    await refresh();
                    notify("Media uploaded for review");
                  } catch (err) {
                    notify(
                      err instanceof Error ? err.message : "Upload failed",
                    );
                  } finally {
                    setUploading(false);
                    e.target.value = "";
                  }
                }}
              />
            </label>
          </>
        }
      />
      <div className="memory-hero card">
        <div>
          <span className="eyebrow">LIVE PHOTO WALL</span>
          <h2>
            Every perspective.
            <br />
            <i>One beautiful story.</i>
          </h2>
          <p>
            Guests can contribute without an account. Only approved, shareable
            photos appear to invited guests when you enable the guest gallery in
            Settings.
          </p>
          <div>
            <span>
              <b>{media.length}</b> uploads
            </span>
            <span>
              <b>{media.filter((x) => x.status === "approved").length}</b>{" "}
              approved
            </span>
            <span>
              <b>{media.filter((x) => x.status === "pending").length}</b>{" "}
              pending
            </span>
          </div>
        </div>
        <img src="/gallery-dance.jpg" alt="Guests celebrating" />
      </div>
      <div className="gallery-head">
        <h3>Moderation queue</h3>
        <div className="filter-tabs">
          {(["All", "Pending", "Approved", "Rejected"] as const).map((f) => (
            <button
              key={f}
              className={galleryFilter === f ? "active" : ""}
              onClick={() => setGalleryFilter(f)}
            >
              {f === "All" ? "All uploads" : f}
            </button>
          ))}
        </div>
      </div>
      {shown.length ? (
        <div className="gallery-grid">
          {shown.map((item) => (
            <div className="gallery-item" key={item.id}>
              {item.mime_type.startsWith("image/") ? (
                <img
                  src={api.mediaUrl(eventId, item.id)}
                  alt={item.caption || "Guest-contributed event memory"}
                />
              ) : (
                <div className="media-file">
                  <Images />
                  <b>
                    {item.mime_type.startsWith("video/") ? "Video" : "Audio"}{" "}
                    memory
                  </b>
                  <small>{Math.round(item.size_bytes / 1024)} KB</small>
                </div>
              )}
              <div>
                <span>
                  <Avatar initials="GM" />
                  <b>Guest memory</b>
                </span>
                <div>
                  {item.status !== "approved" && (
                    <button
                      onClick={async () => {
                        try {
                          await api.moderateMedia(eventId, item.id, "approved");
                          await refresh();
                          notify("Memory approved");
                        } catch (e) {
                          notify(
                            e instanceof Error
                              ? e.message
                              : "Moderation failed",
                          );
                        }
                      }}
                    >
                      <Check size={15} />
                      Approve
                    </button>
                  )}
                  {item.status !== "rejected" && (
                    <button
                      onClick={async () => {
                        try {
                          await api.moderateMedia(eventId, item.id, "rejected");
                          await refresh();
                          notify("Photo hidden from guests");
                        } catch (e) {
                          notify(
                            e instanceof Error
                              ? e.message
                              : "Moderation failed",
                          );
                        }
                      }}
                    >
                      Reject / hide
                    </button>
                  )}
                  <a
                    className="icon-btn"
                    href={api.mediaUrl(eventId, item.id)}
                    download
                  >
                    <Download size={15} />
                  </a>
                </div>
              </div>
              {item.mime_type.startsWith("image/") && (
                <label className="media-sharing">
                  <input
                    type="checkbox"
                    checked={Boolean(item.share_with_guests)}
                    onChange={async (e) => {
                      try {
                        await api.moderateMedia(
                          eventId,
                          item.id,
                          item.status,
                          e.target.checked,
                        );
                        await refresh();
                        notify("Photo sharing preference saved");
                      } catch (e) {
                        notify(
                          e instanceof Error
                            ? e.message
                            : "Could not update sharing",
                        );
                      }
                    }}
                  />
                  Permission to share with invited guests after approval
                </label>
              )}
              <em className={item.status}>
                {item.status === "pending" ? "Needs review" : item.status}
              </em>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Images}
          title={
            galleryFilter === "All"
              ? "Your memory vault is ready"
              : "Nothing in this queue"
          }
          text={
            galleryFilter === "All"
              ? "Upload the first photograph, then share the guest contribution link."
              : "Choose another filter to view collected memories."
          }
          action="Add media"
          onAction={() =>
            document
              .querySelector<HTMLInputElement>(".upload-btn input")
              ?.click()
          }
        />
      )}
    </div>
  );
}

function Budget({ notify }: { notify: (s: string) => void }) {
  const { budgets, eventId, refresh } = useEventStore();
  const [open, setOpen] = useState(false);
  const rows = budgets.map((b, i) => ({
    id: b.id,
    name: b.category,
    spent: b.spent_minor / 100,
    budget: b.budget_minor / 100,
    color: ["#6f7565", "#a67c52", "#c0a77b", "#919986", "#b98174"][i % 5],
  }));
  const spent = rows.reduce((a, b) => a + b.spent, 0),
    total = rows.reduce((a, b) => a + b.budget, 0);
  return (
    <div className="page">
      <PageIntro
        title="Budget"
        text="A clear view of every naira, commitment and remaining balance."
        actions={
          <button className="btn primary" onClick={() => setOpen(true)}>
            <Plus size={16} />
            Add category
          </button>
        }
      />
      {rows.length ? (
        <>
          <div className="budget-hero">
            <div className="card">
              <span>Total budget</span>
              <b>{fmt(total)}</b>
              <div className="budget-bar">
                <i
                  style={{
                    width: `${total ? Math.min(100, (spent / total) * 100) : 0}%`,
                  }}
                />
              </div>
              <p>
                <strong>{fmt(spent)}</strong> committed{" "}
                <em>{fmt(Math.max(0, total - spent))} remaining</em>
              </p>
            </div>
            <div className="card">
              <span>Budget health</span>
              <b>{total ? Math.round((spent / total) * 100) : 0}%</b>
              <p>Committed across {rows.length} categories</p>
            </div>
          </div>
          <section className="card categories">
            <CardHead
              title="Spending by category"
              sub="Committed against planned budget"
            />
            <div>
              {rows.map((b) => (
                <div className="category-row" key={b.id}>
                  <i style={{ background: b.color }} />
                  <span>
                    <b>{b.name}</b>
                    <small>
                      {fmt(b.spent)} of {fmt(b.budget)}
                    </small>
                  </span>
                  <div>
                    <i
                      style={{
                        width: `${b.budget ? Math.min(100, (b.spent / b.budget) * 100) : 0}%`,
                        background: b.color,
                      }}
                    />
                  </div>
                  <strong>
                    {b.budget ? Math.round((b.spent / b.budget) * 100) : 0}%
                  </strong>
                  <button
                    className="plain"
                    aria-label={`Delete ${b.name}`}
                    onClick={async () => {
                      await api.deleteBudget(eventId, b.id);
                      await refresh();
                      notify("Budget category removed");
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : (
        <EmptyState
          icon={WalletCards}
          title="Build a calm, clear budget"
          text="Add your first category to track planned and committed costs."
          action="Add category"
          onAction={() => setOpen(true)}
        />
      )}
      <AnimatePresence>
        {open && (
          <Modal onClose={() => setOpen(false)}>
            <div className="modal-head">
              <div>
                <span className="eyebrow">NEW BUDGET CATEGORY</span>
                <h2>Plan an expense</h2>
              </div>
              <button className="icon-btn" onClick={() => setOpen(false)}>
                <X />
              </button>
            </div>
            <form
              id="budget-form"
              className="form-grid"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                await api.addBudget(eventId, {
                  category: f.get("category"),
                  budget: Number(f.get("budget")),
                  spent: Number(f.get("spent") || 0),
                });
                setOpen(false);
                await refresh();
                notify("Budget category added");
              }}
            >
              <label className="full">
                Category
                <input
                  name="category"
                  required
                  placeholder="e.g. Venue & catering"
                />
              </label>
              <label>
                Planned amount (₦)
                <input name="budget" type="number" min="0" required />
              </label>
              <label>
                Already committed (₦)
                <input name="spent" type="number" min="0" defaultValue="0" />
              </label>
            </form>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn primary" type="submit" form="budget-form">
                Save category
              </button>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}
function Vendors({ notify }: { notify: (s: string) => void }) {
  const { vendors, eventId, refresh } = useEventStore();
  const [open, setOpen] = useState(false);
  return (
    <div className="page">
      <PageIntro
        title="Vendor workspace"
        text="Contracts, contacts, deliverables and payments — without the spreadsheet chaos."
        actions={
          <button className="btn primary" onClick={() => setOpen(true)}>
            <Plus size={16} />
            Add vendor
          </button>
        }
      />
      {vendors.length ? (
        <div className="vendor-grid">
          {vendors.map((v) => (
            <div className="card vendor" key={v.id}>
              <div>
                <Avatar
                  initials={v.name
                    .split(" ")
                    .slice(0, 2)
                    .map((x) => x[0])
                    .join("")
                    .toUpperCase()}
                />
                <button
                  className="plain"
                  aria-label={`Delete ${v.name}`}
                  onClick={async () => {
                    await api.deleteVendor(eventId, v.id);
                    await refresh();
                    notify("Vendor removed");
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <h3>{v.name}</h3>
              <p>{v.category}</p>
              <div className="vendor-meta">
                <span className={"pay " + v.payment_status.replace("_", "-")}>
                  {v.payment_status.replace("_", " ")}
                </span>
                <b>{fmt(v.contract_amount_minor / 100)}</b>
              </div>
              <div className="vendor-actions">
                {v.email ? (
                  <a href={`mailto:${v.email}`}>
                    <Mail size={15} />
                    Email
                  </a>
                ) : (
                  <span>No email added</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Handshake}
          title="Bring your team together"
          text="Add planners, caterers, photographers and every partner behind the day."
          action="Add vendor"
          onAction={() => setOpen(true)}
        />
      )}
      <AnimatePresence>
        {open && (
          <Modal onClose={() => setOpen(false)}>
            <div className="modal-head">
              <div>
                <span className="eyebrow">NEW PARTNER</span>
                <h2>Add a vendor</h2>
              </div>
              <button className="icon-btn" onClick={() => setOpen(false)}>
                <X />
              </button>
            </div>
            <form
              id="vendor-form"
              className="form-grid"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                await api.addVendor(eventId, {
                  name: f.get("name"),
                  category: f.get("category"),
                  email: f.get("email"),
                  amount: Number(f.get("amount") || 0),
                  status: f.get("status"),
                });
                setOpen(false);
                await refresh();
                notify("Vendor added");
              }}
            >
              <label className="full">
                Business or vendor name
                <input name="name" required />
              </label>
              <label>
                Category
                <input name="category" required placeholder="Photography" />
              </label>
              <label>
                Contract amount (₦)
                <input name="amount" type="number" min="0" />
              </label>
              <label>
                Email
                <input name="email" type="email" />
              </label>
              <label>
                Payment status
                <select name="status">
                  <option value="due">Due</option>
                  <option value="part_paid">Part paid</option>
                  <option value="paid">Paid</option>
                </select>
              </label>
            </form>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn primary" type="submit" form="vendor-form">
                Save vendor
              </button>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}
function Analytics() {
  const { analytics, guests } = useEventStore();
  const views = analytics.view || 0;
  const responded = guests.filter((g) => g.status !== "Pending").length;
  const conversion = guests.length
    ? Math.round((responded / guests.length) * 100)
    : 0;
  const events = [
    ["Invitation views", views, "view"],
    ["Section interactions", analytics.section_view || 0, "section_view"],
    ["Shares", analytics.share || 0, "share"],
    ["Calendar saves", analytics.calendar || 0, "calendar"],
    ["Direction opens", analytics.direction || 0, "direction"],
  ] as const;
  const max = Math.max(1, ...events.map((x) => Number(x[1])));
  return (
    <div className="page">
      <PageIntro
        title="Analytics"
        text="Understand every view, response and guest interaction."
        actions={
          <button
            className="btn ghost"
            onClick={() => {
              const csv =
                "Metric,Count\n" +
                events.map((x) => `${x[0]},${x[1]}`).join("\n");
              const a = document.createElement("a");
              a.href = URL.createObjectURL(new Blob([csv]));
              a.download = "event-analytics.csv";
              a.click();
            }}
          >
            <Download size={16} />
            Export report
          </button>
        }
      />
      <section className="metric-grid analytics">
        <Metric
          title="Invitation views"
          value={String(views)}
          detail="Privacy-safe event views"
          icon={Eye}
          tone="sage"
        />
        <Metric
          title="RSVP completion"
          value={`${conversion}%`}
          detail={`${responded} of ${guests.length} guest records`}
          icon={TrendingUp}
          tone="green"
        />
        <Metric
          title="Shares"
          value={String(analytics.share || 0)}
          detail="Tracked invitation shares"
          icon={Share2}
          tone="amber"
        />
        <Metric
          title="Direction opens"
          value={String(analytics.direction || 0)}
          detail="Guests checking the venue"
          icon={Navigation}
          tone="rose"
        />
      </section>
      <div className="analytics-grid">
        <section className="card engagement-bars">
          <CardHead
            title="Engagement signals"
            sub="First-party, privacy-conscious interactions"
          />
          <div>
            {events.map(([label, count]) => (
              <span key={label}>
                <b>{label}</b>
                <i>
                  <em style={{ width: `${(Number(count) / max) * 100}%` }} />
                </i>
                <strong>{count}</strong>
              </span>
            ))}
          </div>
        </section>
        <section className="card response-ring">
          <span
            style={
              { "--response": `${conversion * 3.6}deg` } as React.CSSProperties
            }
          >
            <b>{conversion}%</b>
            <small>responded</small>
          </span>
          <h3>Guest response health</h3>
          <p>
            {guests.length
              ? `${guests.length - responded} guest records still need a response.`
              : "Add guests to begin measuring response health."}
          </p>
        </section>
      </div>
    </div>
  );
}

function SettingsPage({ notify }: { notify: (s: string) => void }) {
  const { event, eventId, refresh } = useEventStore();
  const initialCapabilities = (() => {
    try {
      return (
        JSON.parse(event?.settings_json || "{}").capabilities || [
          "rsvp",
          "seating",
          "memories",
        ]
      ).filter((capability: string) =>
        ["occasions", "rsvp", "seating", "gifts", "memories", "ai"].includes(
          capability,
        ),
      );
    } catch {
      return ["rsvp", "seating", "memories"];
    }
  })();
  const [capabilities, setCapabilities] =
    useState<string[]>(initialCapabilities);
  const [integrations, setIntegrations] = useState<Record<string, boolean>>({});
  const [inviteBusy, setInviteBusy] = useState(false);
  useEffect(() => {
    if (eventId)
      api
        .integrationStatus(eventId)
        .then(setIntegrations)
        .catch(() => {});
  }, [eventId]);
  const save = async () => {
    const title = (document.getElementById("setting-title") as HTMLInputElement)
      .value;
    const eventType = (
      document.getElementById("setting-type") as HTMLSelectElement
    ).value;
    const lifecycle = (
      document.getElementById("setting-lifecycle") as HTMLSelectElement
    ).value;
    const date = (document.getElementById("setting-date") as HTMLInputElement)
      .value;
    const locationValue = (
      document.getElementById("setting-location") as HTMLInputElement
    ).value;
    try {
      await api.updateEvent(eventId, {
        title,
        eventType,
        lifecycle,
        date,
        timezone: (
          document.getElementById("setting-timezone") as HTMLInputElement
        ).value,
        visibility: (
          document.getElementById("setting-visibility") as HTMLSelectElement
        ).value,
        location: locationValue,
        settings: {
          ...JSON.parse(event?.settings_json || "{}"),
          capabilities,
          rsvpDeadline: (
            document.getElementById("setting-rsvp-deadline") as HTMLInputElement
          ).value
            ? new Date(
                (
                  document.getElementById(
                    "setting-rsvp-deadline",
                  ) as HTMLInputElement
                ).value + "Z",
              ).toISOString()
            : null,
        },
      });
      await refresh();
      notify("Event settings saved");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not save settings");
    }
  };
  return (
    <div className="page settings-page">
      <PageIntro
        title="Event settings"
        text="Identity, access, localization and event capabilities."
        actions={
          <button className="btn primary" onClick={save}>
            <Save size={16} />
            Save changes
          </button>
        }
      />
      <div className="settings-layout single">
        <section className="card settings-form">
          <div>
            <h3>Event identity</h3>
            <p>The core information used throughout your invitation.</p>
          </div>
          <div className="form-grid">
            <label className="full">
              Event title
              <input id="setting-title" defaultValue={event?.title || ""} />
            </label>
            <label>
              Event type
              <select
                id="setting-type"
                defaultValue={event?.event_type || "wedding"}
              >
                <option value="wedding">Wedding</option>
                <option value="birthday">Birthday</option>
                <option value="conference">Conference</option>
                <option value="memorial">Funeral / memorial</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label>
              Lifecycle state
              <select
                id="setting-lifecycle"
                defaultValue={event?.lifecycle || "draft"}
              >
                <option value="published">Published</option>
                <option value="draft">Draft</option>
                <option value="live">Live</option>
                <option value="completed">Completed</option>
                <option value="preview">Preview</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <label>
              Date
              <input
                id="setting-date"
                type="date"
                defaultValue={
                  event?.starts_at
                    ? dateInTimezone(
                        event.starts_at,
                        event.timezone || "Africa/Lagos",
                      )
                    : ""
                }
              />
            </label>

            <label className="full">
              Primary location
              <input
                id="setting-location"
                defaultValue={event?.location || ""}
              />
            </label>
          </div>
          <hr />
          <div>
            <h3>Optional guest features</h3>
            <p>
              Core RSVP, scheduling and organizer tools remain available. Enable
              optional guest contributions only after merchant setup and
              approval.
            </p>
          </div>
          <div className="capabilities">
            {[
              [
                CalendarDays,
                "Multiple occasions",
                "Traditional, white wedding and reception",
                "occasions",
              ],
              [
                Users,
                "Guest RSVP",
                "Personalized responses and plus-ones",
                "rsvp",
              ],
              [
                Armchair,
                "Seating planner",
                "Tables and guest assignments",
                "seating",
              ],

              [
                Gift,
                "Registry & gifting",
                "Gift links and cash contributions",
                "gifts",
              ],
              [
                Images,
                "Memory vault",
                "Guest uploads and moderation",
                "memories",
              ],
              [
                Bot,
                "AI event assistant",
                "Copy, schedules and guest answers",
                "ai",
              ],
            ]
              .filter((entry) => entry[3] === "gifts")
              .map(([I, n, d, id]: any) => (
                <div key={n}>
                  <span>
                    <I size={18} />
                    <b>{n}</b>
                    <small>{d}</small>
                  </span>
                  <button
                    aria-label={`Toggle ${n}`}
                    onClick={() =>
                      setCapabilities(
                        capabilities.includes(id)
                          ? capabilities.filter((x) => x !== id)
                          : [...capabilities, id],
                      )
                    }
                    className={
                      "toggle " + (capabilities.includes(id) ? "on" : "")
                    }
                  >
                    <i />
                  </button>
                </div>
              ))}
          </div>
          <hr />
          <label>
            RSVP deadline (UTC, optional)
            <input
              id="setting-rsvp-deadline"
              type="datetime-local"
              defaultValue={
                JSON.parse(event?.settings_json || "{}").rsvpDeadline?.slice(
                  0,
                  16,
                ) || ""
              }
            />
          </label>
          <label>
            Event timezone (IANA)
            <input
              id="setting-timezone"
              defaultValue={event?.timezone || "Africa/Lagos"}
              placeholder="Africa/Lagos"
            />
          </label>
          <label>
            Invitation visibility
            <select
              id="setting-visibility"
              defaultValue={event?.visibility || "guest_specific"}
            >
              <option value="guest_specific">Personalized links only</option>
              <option value="private">Private links only</option>
              <option value="public">Public — anyone with the URL</option>
            </select>
          </label>
          <div>
            <h3>Visibility & privacy</h3>
            <p>Protect sensitive event and guest information.</p>
          </div>
          <div className="privacy-box">
            <ShieldCheck />
            <span>
              <b>Personalized invitation links</b>
              <p>
                Private occasions and guest details require signed,
                guest-specific access.
              </p>
            </span>
            <span className="secure-label">
              <Lock size={13} />
              Enabled
            </span>
          </div>
          <hr />
          <div>
            <h3>Integration readiness</h3>
            <p>
              Configuration state only—credentials are never returned to the
              browser.
            </p>
          </div>
          <div className="integration-grid">
            {[
              ["email", "Resend email"],
              ["whatsapp", "WhatsApp"],
              ["sms", "Twilio SMS"],
              ["payments", "Paystack"],
              ["ai", "AI assistant"],
              ["storage", "Media storage"],
            ].map(([key, label]) => (
              <span
                key={key}
                className={integrations[key] ? "ready" : "needs-config"}
              >
                {integrations[key] ? (
                  <CheckCircle2 size={15} />
                ) : (
                  <CircleAlert size={15} />
                )}
                <b>{label}</b>
                <small>
                  {integrations[key]
                    ? "Configured (not verified)"
                    : "Needs configuration"}
                </small>
              </span>
            ))}
          </div>
          <hr />
          <div>
            <h3>Invite a collaborator</h3>
            <p>
              Role-scoped team links expire after seven days and are bound to
              the recipient email.
            </p>
          </div>
          <form
            className="team-invite-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setInviteBusy(true);
              const form = new FormData(e.currentTarget);
              try {
                const result = await api.inviteTeam(
                  eventId,
                  String(form.get("email")),
                  String(form.get("role")),
                );
                notify(
                  result.delivered
                    ? "Team invitation sent"
                    : "Invitation created, but email is not configured",
                );
              } catch (error) {
                notify(
                  error instanceof Error ? error.message : "Invitation failed",
                );
              } finally {
                setInviteBusy(false);
              }
            }}
          >
            <input
              name="email"
              type="email"
              required
              placeholder="collaborator@example.com"
            />
            <select name="role" defaultValue="guest_manager">
              <option value="admin">Admin</option>
              <option value="designer">Designer</option>
              <option value="guest_manager">Guest manager</option>
              <option value="checkin_staff">Check-in staff</option>
              <option value="viewer">Viewer</option>
            </select>
            <button className="btn ghost" disabled={inviteBusy}>
              <UserPlus size={15} />
              {inviteBusy ? "Inviting…" : "Send invite"}
            </button>
          </form>
          <TeamPanel eventId={eventId} notify={notify} />
        </section>
      </div>
      {event?.member_role === "owner" && <BillingPanel eventId={eventId} />}
      <PaymentsPanel eventId={eventId} />
      <AuditPanel eventId={eventId} />
      <GuestMediaSettings
        eventId={eventId}
        settings={JSON.parse(event?.settings_json || "{}")}
        onSaved={refresh}
      />
      <EventPrivacy />
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  onAction,
}: {
  icon: any;
  title: string;
  text: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="empty-state card">
      <span>
        <Icon />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      <button className="btn primary" onClick={onAction}>
        <Plus size={15} />
        {action}
      </button>
    </div>
  );
}

function PageIntro({
  title,
  text,
  actions,
}: {
  title: string;
  text: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-intro">
      <div>
        <h2>{title}</h2>
        <p>{text}</p>
      </div>
      <div>{actions}</div>
    </div>
  );
}

function NewEvent({
  onClose,
  notify,
  onCreate,
}: {
  onClose: () => void;
  notify: (s: string) => void;
  onCreate: (data: {
    title: string;
    eventType: string;
    date: string;
    location: string;
  }) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [eventType, setEventType] = useState("Wedding");
  const [creating, setCreating] = useState(false);
  const types = [
    ["Wedding", Heart],
    ["Birthday", Sparkles],
    ["Conference", Users],
    ["Memorial", BookHeart],
    ["Celebration", Gift],
    ["Custom", Plus],
  ];
  return (
    <Modal onClose={onClose} wide>
      <div className="modal-head">
        <div>
          <span className="eyebrow">CREATE AN EXPERIENCE</span>
          <h2>
            {step === 0
              ? "What are you celebrating?"
              : "Give your event a name"}
          </h2>
          <p>
            {step === 0
              ? "We’ll tailor the flow, wording and capabilities."
              : "You can change every detail later."}
          </p>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <X />
        </button>
      </div>
      {step === 0 ? (
        <div className="type-grid">
          {types.map(([n, I]: any) => (
            <button
              key={n}
              onClick={() => {
                setEventType(n);
                setStep(1);
              }}
            >
              <I />
              <b>{n}</b>
              <span>Start with a smart event pack</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="form-grid">
            <label className="full">
              Event name
              <input
                id="new-event-title"
                autoFocus
                placeholder="e.g. Ada & David"
              />
            </label>
            <label>
              Date
              <input
                id="new-event-date"
                type="date"
                defaultValue={new Date(Date.now() + 30 * 86400000)
                  .toISOString()
                  .slice(0, 10)}
              />
            </label>
            <label>
              Location
              <input
                id="new-event-location"
                placeholder="City, country"
                defaultValue="Lagos, Nigeria"
              />
            </label>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setStep(0)}>
              Back
            </button>
            <button
              className="btn primary"
              disabled={creating}
              onClick={async () => {
                const title = (
                  document.getElementById("new-event-title") as HTMLInputElement
                ).value.trim();
                const date = (
                  document.getElementById("new-event-date") as HTMLInputElement
                ).value;
                const locationValue = (
                  document.getElementById(
                    "new-event-location",
                  ) as HTMLInputElement
                ).value.trim();
                if (!title || !date || !locationValue) {
                  notify("Complete the event name, date and location");
                  return;
                }
                setCreating(true);
                try {
                  await onCreate({
                    title,
                    eventType: eventType.toLowerCase(),
                    date,
                    location: locationValue,
                  });
                  onClose();
                  notify("New event workspace created");
                } catch (e) {
                  notify(
                    e instanceof Error
                      ? e.message
                      : "Event could not be created",
                  );
                  setCreating(false);
                }
              }}
            >
              {creating ? "Creating…" : "Create event"}{" "}
              <ArrowUpRight size={15} />
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function AppShell() {
  if (location.pathname.startsWith("/invite/")) return <PublicInvite />;
  const { event, user, createFirst, error, saving, refresh } = useEventStore();
  const [page, setRawPage] = useState<PageKey>("overview");
  const setPage = (next: PageKey) => {
    if (next === page || confirmNavigation()) setRawPage(next);
  };
  const [mobile, setMobile] = useState(false);
  const [newEvent, setNewEvent] = useState(false);
  const [toast, setToast] = useState("");
  const notify = (s: string) => {
    setToast(s);
    window.setTimeout(() => setToast(""), 3000);
  };
  useEffect(() => {
    const token = new URLSearchParams(location.search).get("team_invite");
    if (token)
      api
        .acceptTeamInvite(token)
        .then(() => {
          sessionStorage.setItem("invibox.teamAccepted", "true");
          location.href = "/app";
        })
        .catch((error) =>
          notify(
            error instanceof Error
              ? error.message
              : "Team invitation could not be accepted",
          ),
        );
  }, []);
  useEffect(() => {
    if (sessionStorage.getItem("invibox.teamAccepted")) {
      sessionStorage.removeItem("invibox.teamAccepted");
      notify("Team invitation accepted");
    }
  }, []);
  useEffect(() => {
    setRawPage(
      event?.member_role === "checkin_staff"
        ? "checkin"
        : event?.member_role === "designer"
          ? "experience"
          : "overview",
    );
  }, [event?.id, event?.member_role]);
  const content = useMemo(
    () => ({
      overview: <Overview setPage={setPage} notify={notify} />,
      experience: <ExperienceEditor notify={notify} />,
      guests: <GuestsPage notify={notify} />,
      schedule: <SchedulePage notify={notify} />,
      seating: <Seating notify={notify} />,
      messages: <Messages notify={notify} />,
      checkin: <Checkin notify={notify} />,
      memories: <Memories notify={notify} />,
      budget: <Budget notify={notify} />,
      vendors: <Vendors notify={notify} />,
      analytics: <Analytics />,
      settings: <SettingsPage notify={notify} />,
    }),
    [page],
  );
  return (
    <div className="app">
      <Sidebar
        page={page}
        setPage={setPage}
        mobile={mobile}
        setMobile={setMobile}
      />
      {mobile && (
        <div className="sidebar-scrim" onClick={() => setMobile(false)} />
      )}
      <div className="main">
        <Topbar
          page={page}
          onMobile={() => setMobile(true)}
          onNew={() => setNewEvent(true)}
          onPreview={() =>
            window.open(`/invite/${event?.slug}?preview=${event?.id}`, "_blank")
          }
        />
        {user && !user.emailVerifiedAt && (
          <div className="save-banner">
            Verify your email to unlock publishing and integrations in
            production. <a href="/app/account">Account & verification</a>
          </div>
        )}
        {saving && (
          <div className="save-banner" role="status">
            Saving changes… Please keep this page open.
          </div>
        )}
        {error && (
          <div className="save-banner error" role="alert">
            {error}{" "}
            <button
              className="btn ghost"
              onClick={() => refresh().catch((e) => notify(e.message))}
            >
              Reload latest data
            </button>
          </div>
        )}
        <AnimatePresence mode="wait">
          <motion.div
            key={`${event?.id}-${page}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {content[page]}
          </motion.div>
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {toast && <Toast text={toast} />}{" "}
        {newEvent && (
          <NewEvent
            onClose={() => setNewEvent(false)}
            notify={notify}
            onCreate={createFirst}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
function AuthCard({
  children,
  title,
  text,
}: {
  children: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="auth-single">
      <main className="access-form">
        <div className="brand">
          <span className="brandmark">i</span>
          <b>invibox</b>
        </div>
        <div className="access-copy">
          <span className="eyebrow">SECURE ACCOUNT ACCESS</span>
          <h2>{title}</h2>
          <p>{text}</p>
        </div>
        {children}
      </main>
    </div>
  );
}
function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AuthCard
      title="Reset your password"
      text="We’ll send a secure one-hour recovery link."
    >
      {sent ? (
        <div className="auth-success">
          <CheckCircle2 />
          <h3>Check your inbox</h3>
          <p>If the account exists, its recovery link is on the way.</p>
          <button className="btn ghost" onClick={onBack}>
            Back to sign in
          </button>
        </div>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api.forgotPassword(
                String(new FormData(e.currentTarget).get("email")),
              );
              setSent(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Email address
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <button className="btn primary" disabled={busy}>
            {busy ? "Sending…" : "Send recovery link"}
            <ArrowUpRight size={15} />
          </button>
          <button type="button" className="forgot-link" onClick={onBack}>
            Back to sign in
          </button>
        </form>
      )}
    </AuthCard>
  );
}
function ResetPassword({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  return (
    <AuthCard
      title={done ? "Password updated" : "Choose a new password"}
      text={
        done
          ? "Your other sessions were securely signed out."
          : "Use at least ten characters for your new password."
      }
    >
      {done ? (
        <a className="btn primary" href="/app">
          Continue to sign in
        </a>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            const password = String(
              new FormData(e.currentTarget).get("password"),
            );
            try {
              await api.resetPassword(token, password);
              setDone(true);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Reset failed");
            }
          }}
        >
          <label>
            New password
            <input
              name="password"
              type="password"
              minLength={10}
              required
              autoComplete="new-password"
            />
          </label>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button className="btn primary">
            Update password
            <ArrowUpRight size={15} />
          </button>
        </form>
      )}
    </AuthCard>
  );
}
function AccessPortal() {
  const { phase, error, authenticate, createFirst } = useEventStore();
  const [mode, setMode] = useState<"login" | "register">("register");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [challenge, setChallenge] = useState<string>();
  if (challenge)
    return (
      <MfaLogin challenge={challenge} onBack={() => setChallenge(undefined)} />
    );
  const resetToken = new URLSearchParams(location.search).get("reset");
  if (resetToken) return <ResetPassword token={resetToken} />;
  if (forgot) return <ForgotPassword onBack={() => setForgot(false)} />;
  if (phase === "loading")
    return (
      <div className="boot-screen">
        <span className="brandmark">i</span>
        <b>invibox</b>
        <i />
      </div>
    );
  if (phase === "auth")
    return (
      <div className="access-page">
        <div className="access-art">
          <img src="/wedding-hero.jpg" />
          <div>
            <span>ONE PLATFORM · EVERY CELEBRATION</span>
            <h1>
              Create moments
              <br />
              people <i>remember.</i>
            </h1>
            <p>From the first invitation to the final memory.</p>
          </div>
        </div>
        <main className="access-form">
          <div className="brand">
            <span className="brandmark">i</span>
            <b>invibox</b>
          </div>
          <div className="access-copy">
            <span className="eyebrow">
              {mode === "register" ? "BEGIN YOUR EXPERIENCE" : "WELCOME BACK"}
            </span>
            <h2>
              {mode === "register"
                ? "Create your account"
                : "Sign in to Invibox"}
            </h2>
            <p>
              {mode === "register"
                ? "Your extraordinary event starts here."
                : "Continue orchestrating your celebration."}
            </p>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const form = new FormData(e.currentTarget);
              try {
                const challenge = await authenticate(mode, {
                  name: String(form.get("name") || ""),
                  email: String(form.get("email")),
                  password: String(form.get("password")),
                });
                setChallenge(challenge);
              } catch {
              } finally {
                setBusy(false);
              }
            }}
          >
            {mode === "register" && (
              <label>
                Your name
                <input name="name" required minLength={2} autoComplete="name" />
              </label>
            )}
            <label>
              Email address
              <input name="email" type="email" required autoComplete="email" />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                aria-label="Password"
                aria-describedby="access-password-hint"
                required
                minLength={10}
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
              />
              <small id="access-password-hint">At least 10 characters</small>
            </label>
            {mode === "login" && (
              <button
                type="button"
                className="forgot-link"
                onClick={() => setForgot(true)}
              >
                Forgot password?
              </button>
            )}
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <button className="btn primary" disabled={busy}>
              {busy
                ? "Please wait…"
                : mode === "register"
                  ? "Create account"
                  : "Sign in"}
              <ArrowUpRight size={15} />
            </button>
          </form>
          <p className="mode-switch">
            {mode === "register"
              ? "Already have an account?"
              : "New to Invibox?"}{" "}
            <button
              onClick={() =>
                setMode(mode === "register" ? "login" : "register")
              }
            >
              {mode === "register" ? "Sign in" : "Create account"}
            </button>
          </p>
        </main>
      </div>
    );
  if (location.pathname === "/app/commerce") return <CommerceAdmin />;
  if (new URLSearchParams(location.search).has("billingEvent"))
    return <BillingReturn />;
  if (location.pathname === "/app/account") return <AccountPage />;
  if (phase === "onboarding") return <FirstEvent onCreate={createFirst} />;
  return <AppShell />;
}
function FirstEvent({
  onCreate,
}: {
  onCreate: (data: {
    title: string;
    eventType: string;
    date: string;
    location: string;
  }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  return (
    <div className="first-event">
      <div className="brand">
        <span className="brandmark">i</span>
        <b>invibox</b>
      </div>
      <main>
        <a href="/app/account">Account security & email verification</a>
        <span className="eyebrow">YOUR FIRST EXPERIENCE</span>
        <h1>
          What are we
          <br />
          <i>celebrating?</i>
        </h1>
        <p>
          Start simply. Invibox will reveal the right tools as your event grows.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const f = new FormData(e.currentTarget);
            try {
              await onCreate({
                title: String(f.get("title")),
                eventType: String(f.get("eventType")),
                date: String(f.get("date")),
                location: String(f.get("location")),
              });
            } catch (error) {
              setFailure(
                error instanceof Error
                  ? error.message
                  : "Could not create event",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Event name
            <input
              name="title"
              required
              minLength={2}
              placeholder="e.g. Ada & David"
            />
          </label>
          <div>
            <label>
              Event type
              <select name="eventType">
                <option value="wedding">Wedding</option>
                <option value="birthday">Birthday</option>
                <option value="conference">Conference</option>
                <option value="memorial">Memorial</option>
                <option value="custom">Custom event</option>
              </select>
            </label>
            <label>
              Date
              <input name="date" required type="date" />
            </label>
          </div>
          <label>
            Location
            <input name="location" required placeholder="City, country" />
          </label>
          {failure && <p role="alert">{failure}</p>}
          <button className="btn primary" disabled={busy}>
            {busy ? "Creating your workspace…" : "Create my event"}
            <ArrowUpRight size={15} />
          </button>
        </form>
      </main>
    </div>
  );
}
export default function App() {
  const path = location.pathname;
  if (path === "/unsubscribe") return <Unsubscribe />;
  const verify = new URLSearchParams(location.search).get("verify");
  if (path.startsWith("/app") && verify) return <VerifyEmail token={verify} />;
  if (path.startsWith("/invite/")) return <PublicInvite />;
  if (path === "/app" || path.startsWith("/app/"))
    return (
      <EventStoreProvider>
        <AccessPortal />
      </EventStoreProvider>
    );
  return <Marketing />;
}
