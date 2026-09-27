import type { Bindings } from "./types";
import { sha256, uid } from "./security";

export async function verifyTurnstile(
  env: Bindings,
  token: string | undefined,
  ip: string,
): Promise<void> {
  if (!env.TURNSTILE_SECRET_KEY) return; // optional, disabled when not configured
  if (!token) throw new Error("Turnstile verification required");
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  form.set("remoteip", ip);
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form, signal: AbortSignal.timeout(10000) },
  );
  const data: any = await res.json().catch(() => ({}));
  const success = Boolean(data.success);
  try {
    await env.DB.prepare(
      "INSERT INTO turnstile_verifications(id,ip_hash,success) VALUES(?,?,?)",
    )
      .bind(uid("ts"), await sha256(ip), success ? 1 : 0)
      .run();
  } catch {}
  if (!success) throw new Error("Human verification failed. Please retry.");
}
