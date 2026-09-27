import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/types";
const environment = (overrides: Partial<Bindings> = {}) =>
  ({
    APP_ENV: "production",
    APP_ORIGIN: "https://events.acme.test",
    DEMO_MODE: "false",
    SESSION_PEPPER: "a".repeat(32),
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ count: 1 }) }) }),
    },
    ...overrides,
  }) as Bindings;
const call = (path: string, env = environment(), init: RequestInit = {}) =>
  worker.fetch(
    new Request(`https://api.acme.test/api/v1${path}`, init),
    env,
    {} as ExecutionContext,
  );
describe("HTTP security boundaries", () => {
  it("fails closed when demo is enabled outside development", async () => {
    expect(
      (await call("/health", environment({ DEMO_MODE: "true" }))).status,
    ).toBe(503);
  });
  it("fails closed when production session secrets are missing", async () => {
    expect(
      (await call("/health", environment({ SESSION_PEPPER: "" }))).status,
    ).toBe(503);
  });
  it("disables public demo bootstrap in production", async () => {
    expect(
      (await call("/demo/bootstrap", environment(), { method: "POST" })).status,
    ).toBe(404);
  });
  it("rejects cross-origin writes, not just cross-origin reads", async () => {
    expect(
      (
        await call("/auth/login", environment(), {
          method: "POST",
          headers: {
            origin: "https://attacker.test",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });
  it("marks private API data uncacheable and suppresses referrers", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });
  it("uses a server-generated request ID instead of trusting an attacker header", async () => {
    const res = await call("/health", environment(), {
      headers: { "x-request-id": "forged" },
    });
    expect(res.headers.get("x-request-id")).not.toBe("forged");
  });
  it("does not authenticate without a session", async () => {
    expect((await call("/auth/me")).status).toBe(401);
  });
  it("rejects form-encoded login requests", async () => {
    expect(
      (
        await call("/auth/login", environment(), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "email=x",
        })
      ).status,
    ).toBe(415);
  });
});
