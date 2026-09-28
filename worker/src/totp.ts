import { constantTimeEqual } from "./domain";
import type { Bindings } from "./types";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes: Uint8Array) {
  let bits = 0,
    value = 0,
    result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
function decode(secret: string) {
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    const n = alphabet.indexOf(char);
    if (n < 0) throw new Error("Invalid authenticator secret");
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}
export async function totp(secret: string, counter: number, digits = 6) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey(
    "raw",
    decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  const offset = digest[digest.length - 1] & 15;
  const value =
    ((digest[offset] & 127) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(value % 10 ** digits).padStart(digits, "0");
}
export async function matchTotp(
  secret: string,
  code: string,
  time = Date.now(),
) {
  if (!/^\d{6}$/.test(code)) return -1;
  const counter = Math.floor(time / 30000);
  for (const delta of [0, -1, 1])
    if (constantTimeEqual(await totp(secret, counter + delta), code))
      return counter + delta;
  return -1;
}
export function mfaAvailable(env: Bindings) {
  return (
    Boolean(env.MFA_ENCRYPTION_KEY && env.MFA_ENCRYPTION_KEY.length >= 32) ||
    env.APP_ENV === "development"
  );
}
async function encryptionKey(env: Bindings) {
  if (!mfaAvailable(env)) throw new Error("MFA encryption is not configured");
  const secret =
    env.MFA_ENCRYPTION_KEY ||
    (env.APP_ENV === "development"
      ? "local-development-mfa-encryption-only"
      : "");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`invibox:mfa:v1:${secret}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
const encode64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode64 = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export async function encryptSecret(
  env: Bindings,
  userId: string,
  secret: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) },
    await encryptionKey(env),
    new TextEncoder().encode(secret),
  );
  return `v1:${encode64(iv)}:${encode64(new Uint8Array(ciphertext))}`;
}
export async function decryptSecret(
  env: Bindings,
  userId: string,
  encrypted: string,
) {
  const [version, iv, ciphertext] = encrypted.split(":");
  if (version !== "v1") throw new Error("Unknown MFA encryption version");
  const result = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode64(iv),
      additionalData: new TextEncoder().encode(userId),
    },
    await encryptionKey(env),
    decode64(ciphertext),
  );
  return new TextDecoder().decode(result);
}
