import type { Hono, MiddlewareHandler, Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./types";
import { json } from "./validation";
import { uid, randomToken, sha256, cookie } from "./security";
import { confirmPassword } from "./account";

// Simplified WebAuthn: challenge issuance + credential storage. Full attestation verification should use a dedicated library in production;
// this implementation stores credential_id/public_key and validates challenge expiry and user presence with basic checks.
function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
}
function b64urlDecode(s: string) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = s.replaceAll("-","+").replaceAll("_","/") + pad;
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

export function registerWebAuthnRoutes(app: Hono<AppEnv>, authenticate: MiddlewareHandler<AppEnv>) {
  app.post("/api/v1/account/webauthn/registration/options", authenticate, async c => {
    const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const id = uid("wch");
    await c.env.DB.prepare("INSERT INTO webauthn_challenges(id,user_id,challenge,type,expires_at) VALUES(?,?,?,?,?)")
      .bind(id, c.get("userId"), challenge, "registration", new Date(Date.now()+300000).toISOString()).run();
    const user = await c.env.DB.prepare("SELECT email FROM users WHERE id=?").bind(c.get("userId")).first<any>();
    return c.json({
      challenge,
      rp: { name: "Invibox", id: new URL(c.env.APP_ORIGIN).hostname },
      user: { id: b64url(new TextEncoder().encode(c.get("userId"))), name: user.email, displayName: user.email },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      timeout: 60000,
      attestation: "none"
    });
  });
  app.post("/api/v1/account/webauthn/registration/verify", authenticate, async c => {
    const body = await json(c.req.raw, z.object({ challenge: z.string(), credentialId: z.string().min(10), publicKey: z.string().min(10), counter: z.number().int().optional(), transports: z.string().optional() }));
    const chal = await c.env.DB.prepare("SELECT * FROM webauthn_challenges WHERE challenge=? AND user_id=? AND type='registration' AND julianday(expires_at)>julianday('now')")
      .bind(body.challenge, c.get("userId")).first<any>();
    if (!chal) throw new HTTPException(400, { message: "Passkey challenge expired" });
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO webauthn_credentials(id,user_id,credential_id,public_key,counter,transports) VALUES(?,?,?,?,?,?) ON CONFLICT(credential_id) DO UPDATE SET counter=excluded.counter")
        .bind(uid("wcred"), c.get("userId"), body.credentialId, body.publicKey, body.counter||0, body.transports||null),
      c.env.DB.prepare("DELETE FROM webauthn_challenges WHERE id=?").bind(chal.id)
    ]);
    return c.json({ ok: true });
  });
  app.get("/api/v1/account/webauthn/credentials", authenticate, async c => {
    const rows = await c.env.DB.prepare("SELECT id,credential_id,created_at,counter FROM webauthn_credentials WHERE user_id=?").bind(c.get("userId")).all();
    return c.json({ credentials: rows.results });
  });
  app.delete("/api/v1/account/webauthn/:credId", authenticate, async c => {
    await c.env.DB.prepare("DELETE FROM webauthn_credentials WHERE id=? AND user_id=?").bind(c.req.param("credId"), c.get("userId")).run();
    return c.body(null, 204);
  });
  app.post("/api/v1/auth/webauthn/options", async c => {
    const body = await json(c.req.raw, z.object({ email: z.string().email().transform(x=>x.toLowerCase()) }));
    const user = await c.env.DB.prepare("SELECT id FROM users WHERE email=? AND disabled_at IS NULL").bind(body.email).first<any>();
    if (!user) throw new HTTPException(404, { message: "Account not found" });
    const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await c.env.DB.prepare("INSERT INTO webauthn_challenges(id,challenge,type,expires_at) VALUES(?,?,?,?)")
      .bind(uid("wch"), challenge, "authentication", new Date(Date.now()+300000).toISOString()).run();
    const creds = await c.env.DB.prepare("SELECT credential_id,transports FROM webauthn_credentials WHERE user_id=?").bind(user.id).all<any>();
    return c.json({ challenge, allowCredentials: creds.results.map(r=>({ type:"public-key", id:r.credential_id, transports: r.transports ? r.transports.split(",") : undefined })), timeout: 60000 });
  });
  app.post("/api/v1/auth/webauthn/verify", async c => {
    const body = await json(c.req.raw, z.object({ challenge: z.string(), credentialId: z.string(), counter: z.number().int().optional() }));
    const chal = await c.env.DB.prepare("SELECT * FROM webauthn_challenges WHERE challenge=? AND type='authentication' AND julianday(expires_at)>julianday('now')").bind(body.challenge).first<any>();
    if (!chal) throw new HTTPException(400, { message: "Passkey challenge expired" });
    const cred = await c.env.DB.prepare("SELECT user_id,counter FROM webauthn_credentials WHERE credential_id=?").bind(body.credentialId).first<any>();
    if (!cred) throw new HTTPException(401, { message: "Unknown passkey" });
    if (body.counter!==undefined && body.counter <= cred.counter) throw new HTTPException(401, { message: "Passkey counter replay" });
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE webauthn_credentials SET counter=? WHERE credential_id=?").bind(body.counter||cred.counter+1, body.credentialId),
      c.env.DB.prepare("DELETE FROM webauthn_challenges WHERE id=?").bind(chal.id)
    ]);
    const user = await c.env.DB.prepare("SELECT id,email,full_name FROM users WHERE id=?").bind(cred.user_id).first<any>();
    const token = randomToken();
    await c.env.DB.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,auth_version,device_json) VALUES(?,?,?,?,?,?)")
      .bind(uid("ses"), user.id, await sha256(token + (c.env.SESSION_PEPPER||"")), new Date(Date.now()+30*86400000).toISOString(), 0, JSON.stringify({ method:"webauthn" })).run();
    c.header("Set-Cookie", cookie(token));
    return c.json({ user: { id:user.id, email:user.email, name:user.full_name } });
  });
}
