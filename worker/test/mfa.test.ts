import { describe, it, expect } from "vitest";
import {
  base32,
  totp,
  matchTotp,
  encryptSecret,
  decryptSecret,
  mfaAvailable,
} from "../src/totp";
import type { Bindings } from "../src/types";
describe("authenticator primitives", () => {
  const secret = base32(new TextEncoder().encode("12345678901234567890"));
  it("matches independent RFC 6238 SHA-1 test vectors", async () => {
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    for (const [time, code] of [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1234567890, "89005924"],
      [20000000000, "65353130"],
    ] as const)
      expect(await totp(secret, Math.floor(time / 30), 8)).toBe(code);
  });
  it("accepts only six digits in a bounded clock window", async () => {
    const code = await totp(secret, 100);
    expect(await matchTotp(secret, code, 100 * 30000)).toBe(100);
    expect(await matchTotp(secret, code, 101 * 30000)).toBe(100);
    expect(await matchTotp(secret, code, 103 * 30000)).toBe(-1);
    expect(await matchTotp(secret, "not-a-code")).toBe(-1);
  });
  it("encrypts secrets with unique IVs and binds ciphertext to the account and key", async () => {
    const env = {
      APP_ENV: "production",
      MFA_ENCRYPTION_KEY: "a".repeat(48),
    } as Bindings;
    const a = await encryptSecret(env, "user-a", secret),
      b = await encryptSecret(env, "user-a", secret);
    expect(a).not.toBe(b);
    expect(a).not.toContain(secret);
    expect(await decryptSecret(env, "user-a", a)).toBe(secret);
    await expect(decryptSecret(env, "user-b", a)).rejects.toThrow();
    await expect(
      decryptSecret(
        { ...env, MFA_ENCRYPTION_KEY: "b".repeat(48) },
        "user-a",
        a,
      ),
    ).rejects.toThrow();
  });
  it("does not silently use development encryption in production", async () => {
    expect(mfaAvailable({ APP_ENV: "production" } as Bindings)).toBe(false);
    await expect(
      encryptSecret({ APP_ENV: "production" } as Bindings, "u", secret),
    ).rejects.toThrow("not configured");
  });
});
