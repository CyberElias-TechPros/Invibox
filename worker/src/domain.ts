import { HTTPException } from "hono/http-exception";

export type EventRole =
  | "owner"
  | "admin"
  | "designer"
  | "guest_manager"
  | "checkin_staff"
  | "viewer";
export function canAccess(
  role: EventRole,
  method: string,
  resource: string,
): boolean {
  if (role === "owner" || role === "admin") return true;
  if (method === "GET") {
    if (resource === "/snapshot") return true; // Snapshot is separately redacted by role.
    if (role === "checkin_staff") return false;
    if (/^\/(team|audit|integrations|payments)/.test(resource)) return false;
    return true;
  }
  const checkin = /^\/checkin\/scan$|^\/guests\/[^/]+\/checkin$/;
  if (role === "checkin_staff") return checkin.test(resource);
  if (role === "designer")
    return (
      resource === "" ||
      /^\/(sections\/sync|media(?:\/[^/]+)?|ai\/assist)$/.test(resource)
    );
  if (role === "guest_manager")
    return (
      /^\/(guests(?:\/[^/]+(?:\/(seat|checkin|token|access))?)?|guests\/sync|announcements(?:\/[^/]+\/retry)?|seating(?:\/[^/]+)?|schedule\/sync)$/.test(
        resource,
      ) || checkin.test(resource)
    );
  return false;
}

const transitions: Record<string, string[]> = {
  draft: ["preview", "published", "archived"],
  preview: ["draft", "published", "archived"],
  published: ["draft", "active", "live", "completed", "archived"],
  active: ["live", "completed", "archived"],
  live: ["completed"],
  completed: ["archived"],
  archived: [],
};
export function assertTransition(from: string, to: string) {
  if (from !== to && !transitions[from]?.includes(to))
    throw new HTTPException(409, {
      message: `Cannot move an event from ${from} to ${to}`,
    });
}
export function validTimezone(zone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
/** Convert an event-local wall clock to UTC; reject nonexistent DST times. */
export function zonedDateTime(date: string, time: string, zone: string) {
  if (!validTimezone(zone))
    throw new HTTPException(422, { message: "Invalid IANA timezone" });
  const desired = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(desired))
    throw new HTTPException(422, { message: "Invalid event date" });
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const wall = (instant: number) => {
    const p = Object.fromEntries(
      formatter.formatToParts(instant).map((x) => [x.type, x.value]),
    );
    return Date.parse(
      `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
    );
  };
  let instant = desired;
  for (let i = 0; i < 4; i++) {
    const delta = desired - wall(instant);
    if (!delta) return new Date(instant).toISOString();
    instant += delta;
  }
  throw new HTTPException(422, {
    message:
      "This local time does not exist because of a daylight-saving transition",
  });
}
export function localDateTime(instant: string, zone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
  };
}
export function constantTimeEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
export function paymentMatches(
  payment: { reference: string; amount_minor: number; currency: string },
  data: any,
) {
  return (
    data?.status === "success" &&
    data.reference === payment.reference &&
    data.currency === payment.currency &&
    Number.isSafeInteger(data.amount) &&
    data.amount === payment.amount_minor
  );
}
