import { describe, it, expect } from "vitest";
import {
  canAccess,
  assertTransition,
  zonedDateTime,
  localDateTime,
  validTimezone,
  constantTimeEqual,
  paymentMatches,
} from "../src/domain";

describe("role boundaries", () => {
  it("permits the real staff check-in routes but not guest administration", () => {
    expect(canAccess("checkin_staff", "POST", "/checkin/scan")).toBe(true);
    expect(canAccess("checkin_staff", "PATCH", "/guests/gst_1/checkin")).toBe(
      true,
    );
    expect(canAccess("checkin_staff", "PUT", "/guests/sync")).toBe(false);
    expect(canAccess("checkin_staff", "GET", "/team")).toBe(false);
  });
  it("does not grant a designer team control or a viewer any writes", () => {
    expect(canAccess("designer", "POST", "/team-invitations")).toBe(false);
    expect(canAccess("designer", "PUT", "/sections/sync")).toBe(true);
    expect(canAccess("viewer", "POST", "/announcements")).toBe(false);
    expect(canAccess("guest_manager", "POST", "/guests/g/token")).toBe(true);
  });
  it("does not match arbitrary substring paths", () => {
    expect(canAccess("guest_manager", "POST", "/team/guests")).toBe(false);
  });
});
describe("event lifecycle and timezone", () => {
  it("validates IANA zones", () => {
    expect(validTimezone("Africa/Lagos")).toBe(true);
    expect(validTimezone("Mars/City")).toBe(false);
  });
  it("allows publication but prevents backwards transitions from live", () => {
    expect(() => assertTransition("draft", "published")).not.toThrow();
    expect(() => assertTransition("live", "draft")).toThrow();
    expect(() => assertTransition("archived", "published")).toThrow();
  });
  it("uses the event date and local UTC offset, not a demo date", () => {
    expect(zonedDateTime("2027-02-14", "14:00", "Africa/Lagos")).toBe(
      "2027-02-14T13:00:00.000Z",
    );
  });
  it("handles daylight saving offsets", () => {
    expect(zonedDateTime("2027-06-16", "14:00", "America/New_York")).toBe(
      "2027-06-16T18:00:00.000Z",
    );
    expect(zonedDateTime("2027-01-16", "14:00", "America/New_York")).toBe(
      "2027-01-16T19:00:00.000Z",
    );
  });
  it("rejects nonexistent DST wall-clock times", () => {
    expect(() =>
      zonedDateTime("2027-03-14", "02:30", "America/New_York"),
    ).toThrow();
  });
  it("formats local dates without moving a midnight occasion to another day", () => {
    expect(localDateTime("2027-02-14T23:30:00Z", "Africa/Lagos")).toEqual({
      date: "2027-02-15",
      time: "00:30",
    });
  });
});
describe("payment verification", () => {
  const payment = { reference: "pay_1", amount_minor: 10000, currency: "NGN" };
  const data = {
    reference: "pay_1",
    amount: 10000,
    currency: "NGN",
    status: "success",
  };
  it("checks the whole payment identity", () => {
    expect(paymentMatches(payment, data)).toBe(true);
    for (const mutation of [
      { reference: "pay_2" },
      { amount: 10001 },
      { currency: "USD" },
      { status: "pending" },
      { amount: "10000" },
    ])
      expect(paymentMatches(payment, { ...data, ...mutation })).toBe(false);
  });
  it("compares signatures, including length differences", () => {
    expect(constantTimeEqual("abcd", "abcd")).toBe(true);
    expect(constantTimeEqual("abcd", "abce")).toBe(false);
    expect(constantTimeEqual("abcd", "abcd0")).toBe(false);
  });
});

it("restricts consent history to owners and administrators", () => {
  expect(canAccess("owner", "GET", "/consents")).toBe(true);
  expect(canAccess("admin", "GET", "/consents")).toBe(true);
  for (const role of [
    "viewer",
    "designer",
    "guest_manager",
    "checkin_staff",
  ] as const)
    expect(canAccess(role, "GET", "/consents")).toBe(false);
});
