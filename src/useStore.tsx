import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { Guest, ScheduleItem } from "./types";
import { api, ApiError } from "./api";

type Phase = "loading" | "ready" | "auth" | "onboarding";
export type EventRecord = {
  id: string;
  slug: string;
  title: string;
  event_type: string;
  lifecycle: string;
  starts_at: string;
  timezone: string;
  location: string;
  member_role: string;
  guests_version: number;
  schedule_version: number;
  sections_version: number;
  visibility?: string;
  settings_json?: string;
  theme_json?: string;
};
export type MediaRecord = {
  id: string;
  mime_type: string;
  size_bytes: number;
  caption?: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
};
export type SeatingRecord = {
  id: string;
  name: string;
  shape: string;
  capacity: number;
  x: number;
  y: number;
  assigned: number;
};
export type BudgetRecord = {
  id: string;
  category: string;
  budget_minor: number;
  spent_minor: number;
  currency: string;
};
export type VendorRecord = {
  id: string;
  name: string;
  category: string;
  email?: string;
  phone?: string;
  contract_amount_minor: number;
  payment_status: "due" | "part_paid" | "paid";
};
type Store = {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerifiedAt?: string | null;
  } | null;
  analytics: Record<string, number>;
  media: MediaRecord[];
  seating: SeatingRecord[];
  budgets: BudgetRecord[];
  vendors: VendorRecord[];
  sections: string[];
  setSections: Dispatch<SetStateAction<string[]>>;
  guests: Guest[];
  setGuests: Dispatch<SetStateAction<Guest[]>>;
  schedule: ScheduleItem[];
  setSchedule: Dispatch<SetStateAction<ScheduleItem[]>>;
  eventId: string;
  event: EventRecord | null;
  events: EventRecord[];
  saving: boolean;
  online: boolean;
  loading: boolean;
  error: string | null;
  phase: Phase;
  authenticate: (
    mode: "login" | "register",
    data: { name?: string; email: string; password: string },
  ) => Promise<void>;
  createFirst: (data: {
    title: string;
    eventType: string;
    date: string;
    location: string;
  }) => Promise<void>;
  switchEvent: (id: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};
const Context = createContext<Store | null>(null);
export function EventStoreProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{
    id: string;
    name: string;
    email: string;
    emailVerifiedAt?: string | null;
  } | null>(null);
  const [sections, rawSections] = useState<string[]>([]);
  const [guests, rawGuests] = useState<Guest[]>([]);
  const [schedule, rawSchedule] = useState<ScheduleItem[]>([]);
  const [saving, setSaving] = useState(false);
  const values = useRef({
    guests: [] as Guest[],
    schedule: [] as ScheduleItem[],
    sections: [] as string[],
  });
  const versions = useRef({ guests: 1, schedule: 1, sections: 1 });
  const sectionRecords = useRef<any[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const failed = useRef(false);
  const selectedId = useRef("");
  const loadSequence = useRef(0);
  const [analytics, setAnalytics] = useState<Record<string, number>>({});
  const [media, setMedia] = useState<MediaRecord[]>([]);
  const [seating, setSeating] = useState<SeatingRecord[]>([]);
  const [budgets, setBudgets] = useState<BudgetRecord[]>([]);
  const [vendors, setVendors] = useState<VendorRecord[]>([]);
  const [eventId, setEventId] = useState(
    () => localStorage.getItem("invibox.eventId") || "",
  );
  const [event, setEvent] = useState<EventRecord | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [online, setOnline] = useState(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const load = async (id: string) => {
    const sequence = ++loadSequence.current;
    const snap = await api.snapshot(id);
    if (sequence !== loadSequence.current) return;
    selectedId.current = id;
    failed.current = false;
    versions.current = {
      guests: snap.event.guests_version,
      schedule: snap.event.schedule_version,
      sections: snap.event.sections_version,
    };
    sectionRecords.current = snap.sections || [];
    setEventId(id);
    setEvent(snap.event as EventRecord);
    localStorage.setItem("invibox.eventId", id);
    values.current.guests = snap.guests;
    rawGuests(snap.guests);
    values.current.schedule = snap.schedule;
    rawSchedule(snap.schedule);
    setAnalytics(snap.analytics || {});
    setMedia(snap.media || []);
    setSeating(snap.seating || []);
    setBudgets(snap.budgets || []);
    setVendors(snap.vendors || []);
    const titles = snap.sections.map(
      (x: { title?: string; type: string }) => x.title || x.type,
    );
    values.current.sections = titles;
    rawSections(titles);
    setOnline(true);
    setError(null);
    setPhase("ready");
  };
  const loadAccount = async () => {
    const identity = await api.me();
    setUser(identity.user);
    const teamToken = new URLSearchParams(location.search).get("team_invite");
    if (teamToken) {
      await api.acceptTeamInvite(teamToken);
      history.replaceState(null, "", "/app");
    }
    const result = await api.events();
    setEvents(result.events);
    if (!result.events.length) {
      setOnline(true);
      setPhase("onboarding");
      return;
    }
    const preferred = localStorage.getItem("invibox.eventId");
    const selected =
      result.events.find((x: EventRecord) => x.id === preferred) ||
      result.events[0];
    await load(selected.id);
  };
  useEffect(() => {
    localStorage.removeItem("invibox.guests");
    localStorage.removeItem("invibox.schedule");
    localStorage.removeItem("invibox.guestToken");
    let active = true;
    (async () => {
      try {
        await api.me();
        if (active) await loadAccount();
      } catch (e) {
        if (active) {
          setError(
            e instanceof ApiError && e.status === 401
              ? null
              : "Cannot connect to Invibox. Please try again.",
          );
          setOnline(false);
          setPhase("auth");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  const authenticate = async (
    mode: "login" | "register",
    data: { name?: string; email: string; password: string },
  ) => {
    setError(null);
    try {
      if (mode === "login") await api.login(data.email, data.password);
      else await api.register(data.name || "", data.email, data.password);
      await loadAccount();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authentication failed");
      throw e;
    }
  };
  const createFirst = async (data: {
    title: string;
    eventType: string;
    date: string;
    location: string;
  }) => {
    const result = await api.createEvent({
      ...data,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    await loadAccount();
    await load(result.event.id);
  };
  const logout = async () => {
    await queue.current;
    await api.logout();
    setUser(null);
    selectedId.current = "";
    ++loadSequence.current;
    values.current = { guests: [], schedule: [], sections: [] };
    rawGuests([]);
    rawSchedule([]);
    rawSections([]);
    setAnalytics({});
    setMedia([]);
    setSeating([]);
    setBudgets([]);
    setVendors([]);
    failed.current = false;
    setError(null);
    localStorage.removeItem("invibox.eventId");
    localStorage.removeItem("invibox.guestToken");
    setEvent(null);
    setEvents([]);
    setEventId("");
    setPhase("auth");
    setOnline(false);
  };
  const switchEvent = async (id: string) => {
    if (id === eventId) return;
    await queue.current;
    if (
      failed.current &&
      !window.confirm("Discard unsaved edits and switch events?")
    )
      return;
    setPhase("loading");
    try {
      await load(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open event");
      setPhase("ready");
    }
  };
  // Serialize writes. Hydration never writes; failures never silently replay over newer data.
  const update = <K extends keyof typeof values.current>(
    kind: K,
    action: SetStateAction<(typeof values.current)[K]>,
  ) => {
    if (!selectedId.current || failed.current) {
      setError("Reload the latest data before making more edits.");
      return;
    }
    const next =
      typeof action === "function"
        ? (
            action as (
              old: (typeof values.current)[K],
            ) => (typeof values.current)[K]
          )(values.current[kind])
        : action;
    values.current[kind] = next;
    if (kind === "guests") rawGuests(next as Guest[]);
    if (kind === "schedule") rawSchedule(next as ScheduleItem[]);
    if (kind === "sections") rawSections(next as string[]);
    const id = selectedId.current;
    pending.current++;
    setSaving(true);
    queue.current = queue.current
      .then(async () => {
        if (failed.current || selectedId.current !== id) return;
        let result: { version: number };
        if (kind === "guests")
          result = await api.syncGuests(id, next, versions.current.guests);
        else if (kind === "schedule")
          result = await api.syncSchedule(id, next, versions.current.schedule);
        else
          result = await api.syncSections(
            id,
            (next as string[]).map((title) => {
              const prior = sectionRecords.current.find(
                (s) => s.title === title,
              );
              return {
                title,
                type: prior?.type || title.toLowerCase().replaceAll(" ", "_"),
                content: prior ? JSON.parse(prior.content_json) : {},
                visible: prior ? Boolean(prior.is_visible) : true,
              };
            }),
            versions.current.sections,
          );
        versions.current[kind] = result.version;
        setOnline(true);
        setError(null);
      })
      .catch((e) => {
        failed.current = true;
        setError(
          `${e instanceof Error ? e.message : "Save failed"} Your edits have NOT been saved. Reload to resolve.`,
        );
        if (!(e instanceof ApiError)) setOnline(false);
      })
      .finally(() => {
        pending.current--;
        setSaving(pending.current > 0);
      });
  };
  const setGuests: Dispatch<SetStateAction<Guest[]>> = (action) =>
    update("guests", action);
  const setSchedule: Dispatch<SetStateAction<ScheduleItem[]>> = (action) =>
    update("schedule", action);
  const setSections: Dispatch<SetStateAction<string[]>> = (action) =>
    update("sections", action);
  const refresh = async () => {
    await queue.current;
    if (
      failed.current &&
      !window.confirm("Discard unsaved edits and load the latest server data?")
    )
      return;
    await loadAccount();
  };
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pending.current || failed.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  return (
    <Context.Provider
      value={{
        user,
        analytics,
        media,
        seating,
        budgets,
        vendors,
        sections,
        setSections,
        guests,
        setGuests,
        schedule,
        setSchedule,
        eventId,
        event,
        events,
        saving,
        online,
        loading: phase === "loading",
        error,
        phase,
        authenticate,
        createFirst,
        switchEvent,
        logout,
        refresh,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useEventStore() {
  const c = useContext(Context);
  if (!c) throw new Error("Event store provider missing");
  return c;
}
