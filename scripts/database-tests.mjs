// SQLite-backed Worker tests for transactions, expiration and queue orchestration.
// Real Cloudflare binding behavior is additionally covered by test:regression.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { test } from "node:test";
const bundle = await build({
  entryPoints: ["worker/src/index.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  target: "es2022",
});
const { default: worker } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync("worker/migrations").sort())
    sqlite.exec(readFileSync("worker/migrations/" + name, "utf8"));
  const prepare = (sql, values = []) => ({
    bind: (...args) => prepare(sql, args),
    first: async () => sqlite.prepare(sql).get(...values) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => {
      const result = sqlite.prepare(sql).run(...values);
      return { meta: { changes: Number(result.changes) }, results: [] };
    },
    execute: () => {
      const query = sqlite.prepare(sql);
      if (query.columns().length)
        return { results: query.all(...values), meta: { changes: 0 } };
      const r = query.run(...values);
      return { results: [], meta: { changes: Number(r.changes) } };
    },
  });
  return {
    sqlite,
    prepare,
    batch: async (stmts) => {
      sqlite.exec("BEGIN");
      try {
        const result = stmts.map((stmt) => stmt.execute());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
const sha = async (value) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("hex");
const makeEnv = (DB) => ({
  DB,
  APP_ENV: "development",
  APP_ORIGIN: "http://localhost:5173",
  DEMO_MODE: "true",
  NOTIFICATIONS: { send: async () => {} },
  RESEND_API_KEY: "test-only",
  EMAIL_FROM: "events@example.com",
});
const call = (env, path, body, cookie) =>
  worker.fetch(
    new Request("http://localhost/api/v1" + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    { waitUntil() {} },
  );

test("ISO-format expired sessions are rejected on the same calendar day", async () => {
  const DB = database();
  DB.sqlite.exec(
    "INSERT INTO users(id,email,password_hash,full_name) VALUES('u','u@example.com','unused','Test')",
  );
  await DB.prepare(
    "INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)",
  )
    .bind(
      "s",
      "u",
      await sha("session"),
      new Date(Date.now() - 60000).toISOString(),
    )
    .run();
  assert.equal(
    (await call(makeEnv(DB), "/auth/me", undefined, "invibox_session=session"))
      .status,
    401,
  );
  DB.sqlite.close();
});
test("expired reset and team tokens reject ISO times without a midnight grace period", async () => {
  const DB = database();
  DB.sqlite.exec(
    "INSERT INTO users(id,email,password_hash,full_name) VALUES('u','u@example.com','unused','Test');INSERT INTO events(id,owner_id,slug,title,event_type,starts_at,location) VALUES('e','u','test','Test','custom','2027-01-01','Lagos')",
  );
  const old = new Date(Date.now() - 60000).toISOString(),
    token = "x".repeat(32);
  await DB.prepare(
    "INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)",
  )
    .bind("r", "u", await sha(token), old)
    .run();
  assert.equal(
    (
      await call(makeEnv(DB), "/auth/password/reset", {
        token,
        password: "Strong-2026-password",
      })
    ).status,
    400,
  );
  await DB.prepare(
    "INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)",
  )
    .bind(
      "s",
      "u",
      await sha("session"),
      new Date(Date.now() + 60000).toISOString(),
    )
    .run();
  await DB.prepare(
    "INSERT INTO team_invitations(id,event_id,email,role,token_hash,invited_by,expires_at) VALUES(?,?,?,?,?,?,?)",
  )
    .bind("i", "e", "u@example.com", "viewer", await sha(token), "u", old)
    .run();
  assert.equal(
    (
      await call(
        makeEnv(DB),
        "/team-invitations/accept",
        { token },
        "invibox_session=session",
      )
    ).status,
    403,
  );
  DB.sqlite.close();
});
test("queue retries transient failures, preserves its audience and deduplicates replay", async () => {
  const DB = database(),
    env = makeEnv(DB);
  DB.sqlite.exec(
    "INSERT INTO users(id,email,password_hash,full_name) VALUES('u','u@example.com','unused','Test');INSERT INTO events(id,owner_id,slug,title,event_type,starts_at,location) VALUES('e','u','test','Test','custom','2027-01-01','Lagos');INSERT INTO guests(id,event_id,name,email,status,email_opt_in) VALUES('g','e','Guest','guest@example.com','attending',1);INSERT INTO guests(id,event_id,name,email,status) VALUES('not-selected','e','Other','other@example.com','pending');INSERT INTO announcements(id,event_id,created_by,channel,audience,message) VALUES('a','e','u','email','pending','Hello');UPDATE event_entitlements SET message_limit=100;INSERT INTO announcement_recipients(announcement_id,guest_id) VALUES('a','g')",
  );
  let deliveries = 0,
    acks = 0,
    retries = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    deliveries++;
    return new Response(
      JSON.stringify(deliveries === 1 ? {} : { id: "accepted" }),
      { status: deliveries === 1 ? 429 : 200 },
    );
  };
  const message = {
    body: {
      id: "a",
      eventId: "e",
      channel: "email",
      audience: "pending",
      message: "Hello",
      createdAt: new Date().toISOString(),
    },
    ack() {
      acks++;
    },
    retry() {
      retries++;
    },
  };
  try {
    await worker.queue({ messages: [message] }, env);
    assert.equal(retries, 1);
    assert.equal(acks, 0);
    await worker.queue({ messages: [message] }, env);
    assert.equal(acks, 1);
    assert.equal(deliveries, 2);
    await worker.queue({ messages: [message] }, env);
    assert.equal(acks, 2);
    assert.equal(deliveries, 2);
    const row = DB.sqlite
      .prepare("SELECT * FROM notification_deliveries")
      .get();
    assert.equal(row.status, "sent");
    assert.equal(row.attempts, 2);
    assert.equal(row.guest_id, "g");
    assert.equal(
      DB.sqlite.prepare("SELECT count(*) AS n FROM notification_leases").get()
        .n,
      0,
    );
  } finally {
    globalThis.fetch = original;
    DB.sqlite.close();
  }
});
test("signed payment webhooks validate currency and process retries atomically", async () => {
  const DB = database(),
    env = { ...makeEnv(DB), PAYSTACK_SECRET_KEY: "test-webhook-key" };
  DB.sqlite.exec(
    "INSERT INTO users(id,email,password_hash,full_name) VALUES('u','u@example.com','unused','Test');INSERT INTO events(id,owner_id,slug,title,event_type,starts_at,location) VALUES('e','u','test','Test','custom','2027-01-01','Lagos');INSERT INTO payments(id,event_id,provider,reference,purpose,amount_minor,status) VALUES('p','e','paystack','ref','gift',10000,'initialized')",
  );
  const { createHmac } = await import("node:crypto");
  const send = async (currency) => {
    const raw = JSON.stringify({
      event: "charge.success",
      data: {
        id: 123,
        reference: "ref",
        amount: 10000,
        currency,
        status: "success",
        subaccount: { subaccount_code: "ACCT_fixture" },
      },
    });
    return worker.fetch(
      new Request("http://localhost/api/v1/webhooks/paystack", {
        method: "POST",
        body: raw,
        headers: {
          "Content-Type": "application/json",
          "x-paystack-signature": createHmac("sha512", env.PAYSTACK_SECRET_KEY)
            .update(raw)
            .digest("hex"),
        },
      }),
      env,
      { waitUntil() {} },
    );
  };
  assert.equal((await send("USD")).status, 422);
  assert.equal(
    DB.sqlite.prepare("SELECT count(*) AS n FROM webhook_events").get().n,
    0,
  );
  assert.equal((await send("NGN")).status, 200);
  assert.equal(
    DB.sqlite.prepare("SELECT status FROM payments").get().status,
    "paid",
  );
  assert.equal((await (await send("NGN")).json()).replayed, true);
  assert.equal(
    DB.sqlite.prepare("SELECT count(*) AS n FROM webhook_events").get().n,
    1,
  );
  DB.sqlite.close();
});

async function ownerFixture() {
  const DB = database(),
    env = makeEnv(DB);
  const registered = await call(env, "/auth/register", {
    name: "Account Owner",
    email: "owner@example.com",
    password: "Strong-Owner-2026!",
  });
  assert.equal(registered.status, 201);
  const user = (await registered.json()).user,
    cookie = registered.headers.get("set-cookie").split(";")[0];
  DB.sqlite
    .prepare(
      "INSERT INTO events(id,owner_id,slug,title,event_type,lifecycle,starts_at,location,visibility,settings_json) VALUES('e',?,'test-event','Test event','custom','published','2027-06-16','Lagos','public','{\"capabilities\":[\"gifts\"]}')",
    )
    .run(user.id);
  DB.sqlite
    .prepare(
      "INSERT INTO payout_accounts(user_id,request_hash,bank_code,bank_name,account_name,last_four,subaccount_code,state) VALUES(?,'fixture','058','Test Bank','Account Owner','6789','ACCT_fixture','verified')",
    )
    .run(user.id);
  return { DB, env, user, cookie };
}
async function http(
  env,
  path,
  { method = "GET", body, cookie, headers = {} } = {},
) {
  return worker.fetch(
    new Request("http://localhost/api/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    { waitUntil() {} },
  );
}

test("email verification is expiring, single use, rate limited and never creates a session", async () => {
  const { DB, env, user, cookie } = await ownerFixture();
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{"id":"email"}', { status: 200 });
  try {
    const issued = await call(env, "/auth/email/request", {}, cookie);
    assert.equal(issued.status, 200);
    const { demoToken } = await issued.json();
    assert.ok(demoToken);
    assert.equal(
      (await call(env, "/auth/email/request", {}, cookie)).status,
      429,
    );
    const verified = await call(env, "/auth/email/verify", {
      token: demoToken,
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.headers.get("set-cookie"), null);
    assert.ok(
      DB.sqlite
        .prepare("SELECT email_verified_at FROM users WHERE id=?")
        .get(user.id).email_verified_at,
    );
    assert.equal(
      (await call(env, "/auth/email/verify", { token: demoToken })).status,
      400,
    );
    DB.sqlite
      .prepare("UPDATE users SET email_verified_at=NULL WHERE id=?")
      .run(user.id);
    DB.sqlite
      .prepare(
        "INSERT INTO email_verifications(user_id,token_hash,expires_at) VALUES(?,?,?)",
      )
      .run(
        user.id,
        await sha("expired".repeat(5)),
        new Date(Date.now() - 60000).toISOString(),
      );
    assert.equal(
      (await call(env, "/auth/email/verify", { token: "expired".repeat(5) }))
        .status,
      400,
    );
  } finally {
    globalThis.fetch = original;
    DB.sqlite.close();
  }
});
test("verification status blocks production publishing without blocking local development", async () => {
  const { DB, env, cookie } = await ownerFixture();
  const production = {
    ...env,
    APP_ENV: "production",
    APP_ORIGIN: "https://events.acme.test",
    DEMO_MODE: "false",
    SESSION_PEPPER: "s".repeat(32),
  };
  const raw = cookie.split("=")[1];
  DB.sqlite
    .prepare("UPDATE sessions SET token_hash=?")
    .run(await sha(raw + production.SESSION_PEPPER));
  DB.sqlite.exec(
    "INSERT INTO occasions(id,event_id,title,starts_at,venue_name,address) VALUES('o','e','Moment','2027-06-16','Hall','Hall')",
  );
  assert.equal(
    (
      await http(production, "/events/e", {
        method: "PATCH",
        cookie,
        body: { lifecycle: "published" },
      })
    ).status,
    403,
  );
  DB.sqlite.exec("UPDATE users SET email_verified_at=CURRENT_TIMESTAMP");
  assert.equal(
    (
      await http(production, "/events/e", {
        method: "PATCH",
        cookie,
        body: { lifecycle: "published" },
      })
    ).status,
    200,
  );
  DB.sqlite.close();
});
test("session list excludes secret hashes and revocation is scoped to the current account", async () => {
  const { DB, env, user, cookie } = await ownerFixture();
  const second = await call(env, "/auth/login", {
    email: "owner@example.com",
    password: "Strong-Owner-2026!",
  });
  const secondCookie = second.headers.get("set-cookie").split(";")[0];
  const res = await call(env, "/account/sessions", undefined, cookie),
    list = await res.json();
  assert.equal(list.sessions.length, 2);
  assert.equal(list.sessions.filter((x) => x.current).length, 1);
  assert.ok(!JSON.stringify(list).includes("token_hash"));
  const other = await call(env, "/auth/register", {
      name: "Other Person",
      email: "other@example.com",
      password: "Strong-Other-2026!",
    }),
    otherCookie = other.headers.get("set-cookie").split(";")[0];
  const otherId = DB.sqlite
    .prepare("SELECT id FROM sessions WHERE user_id<>?")
    .get(user.id).id;
  assert.equal(
    (
      await http(env, `/account/sessions/${otherId}`, {
        method: "DELETE",
        cookie,
      })
    ).status,
    204,
  );
  assert.equal(
    (await call(env, "/auth/me", undefined, otherCookie)).status,
    200,
  );
  assert.equal(
    (
      await call(
        env,
        "/account/sessions/revoke-others",
        { password: "incorrect" },
        cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        env,
        "/account/sessions/revoke-others",
        { password: "Strong-Owner-2026!" },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal((await call(env, "/auth/me", undefined, cookie)).status, 200);
  assert.equal(
    (await call(env, "/auth/me", undefined, secondCookie)).status,
    401,
  );
  DB.sqlite.close();
});
test("password change invalidates sessions, recovery tokens and old-password logins", async () => {
  const { DB, env, user, cookie } = await ownerFixture();
  DB.sqlite
    .prepare(
      "INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at) VALUES('reset',?,'unused','2099-01-01')",
    )
    .run(user.id);
  assert.equal(
    (
      await call(
        env,
        "/account/password",
        { currentPassword: "wrong", newPassword: "Replacement-2026!" },
        cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        env,
        "/account/password",
        {
          currentPassword: "Strong-Owner-2026!",
          newPassword: "Replacement-2026!",
        },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM password_reset_tokens").get()
      .n,
    0,
  );
  assert.equal((await call(env, "/auth/me", undefined, cookie)).status, 401);
  assert.equal(
    (
      await call(env, "/auth/login", {
        email: "owner@example.com",
        password: "Strong-Owner-2026!",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call(env, "/auth/login", {
        email: "owner@example.com",
        password: "Replacement-2026!",
      })
    ).status,
    200,
  );
  DB.sqlite.close();
});
test("privacy export requires password/ownership and never contains credential hashes", async () => {
  const { DB, env, cookie } = await ownerFixture();
  DB.sqlite.exec(
    "INSERT INTO guests(id,event_id,name,email,access_token_hash) VALUES('g','e','Guest','guest@example.com','very-secret-token-hash')",
  );
  assert.equal(
    (await call(env, "/events/e/export", { password: "incorrect" }, cookie))
      .status,
    403,
  );
  const result = await call(
    env,
    "/events/e/export",
    { password: "Strong-Owner-2026!" },
    cookie,
  );
  assert.equal(result.status, 200);
  const body = await result.text();
  assert.ok(body.includes("guest@example.com"));
  assert.ok(!body.includes("very-secret-token-hash"));
  assert.ok(!body.includes("password_hash"));
  const account = await call(
    env,
    "/account/export",
    { password: "Strong-Owner-2026!" },
    cookie,
  );
  assert.equal(account.status, 200);
  assert.ok(!(await account.text()).includes("password_hash"));
  const other = await call(env, "/auth/register", {
    name: "Other",
    email: "other@example.com",
    password: "Other-2026-password",
  });
  assert.equal(
    (
      await call(
        env,
        "/events/e/export",
        { password: "Other-2026-password" },
        other.headers.get("set-cookie").split(";")[0],
      )
    ).status,
    404,
  );
  DB.sqlite.close();
});
test("privacy deletion revokes guest data, preserves finance and durably purges files after R2 recovery", async () => {
  const { DB, env, cookie } = await ownerFixture();
  DB.sqlite.exec(
    "INSERT INTO guests(id,event_id,name,email,access_token_hash) VALUES('g','e','Guest','guest@example.com','secret');INSERT INTO payments(id,event_id,guest_id,provider,reference,purpose,amount_minor,status) VALUES('p','e','g','paystack','ref','gift',10000,'paid');INSERT INTO media(id,event_id,guest_id,object_key,mime_type,size_bytes) VALUES('m','e','g','events/e/photo.jpg','image/jpeg',20)",
  );
  assert.equal(
    (
      await call(
        env,
        "/events/e/erase-guest/g",
        { password: "Strong-Owner-2026!" },
        cookie,
      )
    ).status,
    202,
  );
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM guests").get().n,
    0,
  );
  assert.equal(
    DB.sqlite.prepare("SELECT guest_id FROM payments").get().guest_id,
    null,
  );
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM media_deletions").get().n,
    1,
  );
  env.MEDIA = {
    delete: async () => {
      throw new Error("R2 unavailable");
    },
  };
  await worker.scheduled({}, env);
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM media_deletions").get().n,
    1,
  );
  const removed = [];
  env.MEDIA = { delete: async (keys) => removed.push(...keys) };
  await worker.scheduled({}, env);
  assert.deepEqual(removed, ["events/e/photo.jpg"]);
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM media_deletions").get().n,
    0,
  );
  DB.sqlite.exec("UPDATE events SET lifecycle='archived'");
  assert.equal(
    (
      await call(
        env,
        "/events/e/delete",
        { password: "Strong-Owner-2026!", confirmation: "Test event" },
        cookie,
      )
    ).status,
    409,
  );
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get().n,
    1,
  );
  DB.sqlite.close();
});
test("archived nonfinancial event deletion cascades metadata and leaves a durable file deletion task", async () => {
  const { DB, env, cookie } = await ownerFixture();
  DB.sqlite.exec(
    "INSERT INTO media(id,event_id,object_key,mime_type,size_bytes) VALUES('m','e','events/e/photo.jpg','image/jpeg',20)",
  );
  assert.equal(
    (
      await call(
        env,
        "/events/e/delete",
        { password: "Strong-Owner-2026!", confirmation: "Test event" },
        cookie,
      )
    ).status,
    409,
  );
  DB.sqlite.exec("UPDATE events SET lifecycle='archived'");
  assert.equal(
    (
      await call(
        env,
        "/events/e/delete",
        { password: "Strong-Owner-2026!", confirmation: "wrong" },
        cookie,
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await call(
        env,
        "/events/e/delete",
        { password: "Strong-Owner-2026!", confirmation: "Test event" },
        cookie,
      )
    ).status,
    202,
  );
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM events").get().n,
    0,
  );
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM media").get().n, 0);
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM media_deletions").get().n,
    1,
  );
  DB.sqlite.close();
});
test("payment initialization reuses a checkout and rejects changed payloads for the same key", async () => {
  const { DB, env } = await ownerFixture();
  env.PAYSTACK_SECRET_KEY = "test";
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    requests++;
    return new Response(
      JSON.stringify({
        status: true,
        data: { authorization_url: "https://checkout.paystack.com/test-code" },
      }),
      { status: 200 },
    );
  };
  const body = {
      slug: "test-event",
      email: "payer@example.com",
      amount: 100,
      purpose: "contribution",
    },
    headers = { "Idempotency-Key": "idempotent-payment-key-2026" };
  try {
    assert.equal(
      (
        await http(env, "/public/payments/paystack/initialize", {
          method: "POST",
          body,
        })
      ).status,
      428,
    );
    const first = await http(env, "/public/payments/paystack/initialize", {
      method: "POST",
      body,
      headers,
    });
    assert.equal(first.status, 201);
    const initial = await first.json();
    const second = await http(env, "/public/payments/paystack/initialize", {
      method: "POST",
      body,
      headers,
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).reference, initial.reference);
    assert.equal(requests, 1);
    assert.equal(
      (
        await http(env, "/public/payments/paystack/initialize", {
          method: "POST",
          body: { ...body, amount: 200 },
          headers,
        })
      ).status,
      409,
    );
    assert.equal(
      DB.sqlite.prepare("SELECT COUNT(*) AS n FROM payments").get().n,
      1,
    );
  } finally {
    globalThis.fetch = original;
    DB.sqlite.close();
  }
});
test("ambiguous payment timeouts retain one reference and do not initialize a second charge", async () => {
  const { DB, env } = await ownerFixture();
  env.PAYSTACK_SECRET_KEY = "test";
  let initializations = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("/initialize")) initializations++;
    throw new Error("Network interrupted");
  };
  const body = { slug: "test-event", email: "payer@example.com", amount: 100 },
    headers = { "Idempotency-Key": "interrupted-payment-key-2026" };
  try {
    const first = await http(env, "/public/payments/paystack/initialize", {
      method: "POST",
      body,
      headers,
    });
    assert.equal(first.status, 202);
    const stored = await first.json();
    const second = await http(env, "/public/payments/paystack/initialize", {
      method: "POST",
      body,
      headers,
    });
    assert.equal(second.status, 202);
    assert.equal((await second.json()).reference, stored.reference);
    assert.equal(initializations, 1);
    assert.equal(
      DB.sqlite.prepare("SELECT initialization_state FROM payments").get()
        .initialization_state,
      "uncertain",
    );
  } finally {
    globalThis.fetch = original;
    DB.sqlite.close();
  }
});

test("account deletion anonymizes profile and removes access without deleting another owner’s event", async () => {
  const { DB, env, user, cookie } = await ownerFixture();
  const another = await call(env, "/auth/register", {
    name: "Other Owner",
    email: "other@example.com",
    password: "Other-Owner-2026!",
  });
  const other = (await another.json()).user;
  DB.sqlite
    .prepare(
      "INSERT INTO events(id,owner_id,slug,title,event_type,starts_at,location) VALUES('other-event',?,'other','Other','custom','2027-01-01','Lagos')",
    )
    .run(other.id);
  DB.sqlite
    .prepare(
      "INSERT INTO event_members(event_id,user_id,role) VALUES('other-event',?,'guest_manager')",
    )
    .run(user.id);
  DB.sqlite
    .prepare(
      "INSERT INTO announcements(id,event_id,created_by,channel,audience,message) VALUES('a','other-event',?,'email','all','Hello')",
    )
    .run(user.id);
  assert.equal(
    (
      await call(
        env,
        "/account/delete",
        { password: "Strong-Owner-2026!", confirmation: "owner@example.com" },
        cookie,
      )
    ).status,
    409,
  );
  DB.sqlite.exec("UPDATE events SET lifecycle='archived' WHERE id='e'");
  assert.equal(
    (
      await call(
        env,
        "/account/delete",
        { password: "Strong-Owner-2026!", confirmation: "owner@example.com" },
        cookie,
      )
    ).status,
    202,
  );
  const removed = DB.sqlite
    .prepare("SELECT * FROM users WHERE id=?")
    .get(user.id);
  assert.equal(removed.full_name, "Deleted account");
  assert.ok(removed.disabled_at);
  assert.notEqual(removed.email, "owner@example.com");
  assert.equal(
    DB.sqlite
      .prepare("SELECT COUNT(*) AS n FROM event_members WHERE user_id=?")
      .get(user.id).n,
    0,
  );
  assert.ok(
    DB.sqlite.prepare("SELECT id FROM events WHERE id='other-event'").get(),
  );
  assert.ok(
    DB.sqlite.prepare("SELECT id FROM announcements WHERE id='a'").get(),
  );
  assert.equal((await call(env, "/auth/me", undefined, cookie)).status, 401);
  assert.equal(
    (
      await call(env, "/auth/login", {
        email: "owner@example.com",
        password: "Strong-Owner-2026!",
      })
    ).status,
    401,
  );
  DB.sqlite.close();
});
test("concurrent password-reset submissions consume the capability only once", async () => {
  const { DB, env, user } = await ownerFixture(),
    token = "reset-token".repeat(4);
  DB.sqlite
    .prepare(
      "INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)",
    )
    .run(
      "reset",
      user.id,
      await sha(token),
      new Date(Date.now() + 60000).toISOString(),
    );
  const results = await Promise.all([
    call(env, "/auth/password/reset", {
      token,
      password: "Replacement-One-2026!",
    }),
    call(env, "/auth/password/reset", {
      token,
      password: "Replacement-Two-2026!",
    }),
  ]);
  assert.equal(results.filter((x) => x.status === 200).length, 1);
  assert.ok(results.some((x) => [400, 409].includes(x.status)));
  DB.sqlite.close();
});
test("guest consent defaults off, supports signed channel-only opt-out and resets when contacts change", async () => {
  const { DB, env } = await ownerFixture();
  const token = "guest-preferences-token-2026";
  DB.sqlite
    .prepare(
      "INSERT INTO guests(id,event_id,name,email,phone,access_token_hash) VALUES('g','e','Guest','guest@example.com','+12025550123',?)",
    )
    .run(await sha(token));
  assert.equal(
    DB.sqlite.prepare("SELECT email_opt_in FROM guests WHERE id='g'").get()
      .email_opt_in,
    0,
  );
  assert.equal(
    (
      await call(env, "/public/preferences", {
        token,
        email: true,
        sms: true,
        whatsapp: false,
      })
    ).status,
    200,
  );
  assert.equal(
    DB.sqlite.prepare("SELECT sms_opt_in FROM guests WHERE id='g'").get()
      .sms_opt_in,
    1,
  );
  const { createHmac } = await import("node:crypto");
  const signature = createHmac("sha512", "development-unsubscribe-key")
    .update("invibox:unsubscribe:g:email")
    .digest("hex");
  assert.equal(
    (
      await call(env, "/public/unsubscribe", {
        guest: "g",
        channel: "sms",
        signature,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(env, "/public/unsubscribe", {
        guest: "g",
        channel: "email",
        signature,
      })
    ).status,
    200,
  );
  let guest = DB.sqlite.prepare("SELECT * FROM guests WHERE id='g'").get();
  assert.equal(guest.email_opt_in, 0);
  assert.equal(guest.sms_opt_in, 1);
  DB.sqlite.exec("UPDATE guests SET phone='+12025550999' WHERE id='g'");
  guest = DB.sqlite.prepare("SELECT * FROM guests WHERE id='g'").get();
  assert.equal(guest.sms_opt_in, 0);
  DB.sqlite.close();
});
test("queue checks opt-out again at send time and does not call a provider for suppressed recipients", async () => {
  const { DB, env, user } = await ownerFixture();
  DB.sqlite.exec(
    "INSERT INTO guests(id,event_id,name,email) VALUES('g','e','Guest','guest@example.com')",
  );
  DB.sqlite
    .prepare(
      "INSERT INTO announcements(id,event_id,created_by,channel,audience,message) VALUES('a','e',?,'email','all','Hello')",
    )
    .run(user.id);
  DB.sqlite.exec(
    "UPDATE event_entitlements SET message_limit=100;INSERT INTO announcement_recipients(announcement_id,guest_id) VALUES('a','g')",
  );
  let sends = 0,
    acks = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    sends++;
    return new Response("{}");
  };
  try {
    await worker.queue(
      {
        messages: [
          {
            body: {
              id: "a",
              eventId: "e",
              channel: "email",
              audience: "all",
              message: "Hello",
              createdAt: new Date().toISOString(),
            },
            ack() {
              acks++;
            },
            retry() {
              throw new Error("Unexpected retry");
            },
          },
        ],
      },
      env,
    );
    assert.equal(sends, 0);
    assert.equal(acks, 1);
    assert.equal(
      DB.sqlite.prepare("SELECT status FROM notification_deliveries").get()
        .status,
      "skipped",
    );
  } finally {
    globalThis.fetch = original;
    DB.sqlite.close();
  }
});

test("financial-retention failure rolls the entire account deletion back", async () => {
  const { DB, env, user, cookie } = await ownerFixture();
  DB.sqlite.exec(
    "UPDATE events SET lifecycle='archived' WHERE id='e';INSERT INTO payments(id,event_id,provider,reference,amount_minor,currency,purpose,status) VALUES('money','e','paystack','retained',10000,'NGN','gift','paid');INSERT INTO media(id,event_id,object_key,mime_type,size_bytes) VALUES('m','e','keep-file','image/png',10)",
  );
  const result = await call(
    env,
    "/account/delete",
    { password: "Strong-Owner-2026!", confirmation: "owner@example.com" },
    cookie,
  );
  assert.equal(result.status, 409);
  assert.equal(
    DB.sqlite.prepare("SELECT disabled_at FROM users WHERE id=?").get(user.id)
      .disabled_at,
    null,
  );
  assert.ok(DB.sqlite.prepare("SELECT id FROM events WHERE id='e'").get());
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM media_deletions").get().n,
    0,
  );
  assert.equal((await call(env, "/auth/me", undefined, cookie)).status, 200);
  DB.sqlite.close();
});
test("simultaneous payment requests share a reservation and webhook confirmation prevents reopening checkout", async () => {
  const { DB, env } = await ownerFixture();
  env.PAYSTACK_SECRET_KEY = "test";
  let initializations = 0,
    release,
    started;
  const barrier = new Promise((resolve) => {
      release = resolve;
    }),
    providerStarted = new Promise((resolve) => {
      started = resolve;
    });
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("/initialize")) {
      initializations++;
      started();
      await barrier;
      DB.sqlite.exec("UPDATE payments SET status='paid'");
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            authorization_url: "https://checkout.paystack.com/test-code",
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({ status: true, data: { status: "pending" } }),
    );
  };
  const body = { slug: "test-event", email: "payer@example.com", amount: 100 },
    headers = { "Idempotency-Key": "concurrent-payment-key-2026" };
  try {
    const first = http(env, "/public/payments/paystack/initialize", {
      method: "POST",
      body,
      headers,
    });
    await providerStarted;
    const second = await http(env, "/public/payments/paystack/initialize", {
      method: "POST",
      body,
      headers,
    });
    assert.equal(second.status, 202);
    release();
    const initial = await (await first).json();
    assert.equal(initial.status, "paid");
    assert.equal(initial.checkoutUrl, undefined);
    assert.equal(initializations, 1);
    assert.equal(
      DB.sqlite.prepare("SELECT COUNT(*) AS n FROM payments").get().n,
      1,
    );
  } finally {
    release();
    globalThis.fetch = original;
    DB.sqlite.close();
  }
});

async function authenticatorCode(secret) {
  const { createHmac } = await import("node:crypto");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    value = 0;
  const bytes = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", Buffer.from(bytes))
    .update(counter)
    .digest();
  const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
async function enrolledOwner() {
  const fixture = await ownerFixture();
  const setup = await call(
    fixture.env,
    "/account/mfa/setup",
    { password: "Strong-Owner-2026!" },
    fixture.cookie,
  );
  assert.equal(setup.status, 200);
  const { secret } = await setup.json();
  const enable = await call(
    fixture.env,
    "/account/mfa/enable",
    { password: "Strong-Owner-2026!", code: await authenticatorCode(secret) },
    fixture.cookie,
  );
  assert.equal(enable.status, 200);
  return { ...fixture, secret, codes: (await enable.json()).recoveryCodes };
}
async function challenge(env) {
  const login = await call(env, "/auth/login", {
    email: "owner@example.com",
    password: "Strong-Owner-2026!",
  });
  assert.equal(login.status, 200);
  const result = await login.json();
  assert.equal(result.mfaRequired, true);
  assert.ok(!result.user);
  return result.challengeToken;
}
test("MFA enrollment revokes sessions; recovery codes and login challenges are single use", async () => {
  const { env, DB, user, cookie, codes, secret } = await enrolledOwner();
  assert.equal(codes.length, 10);
  assert.equal((await call(env, "/auth/me", undefined, cookie)).status, 401);
  assert.ok(
    !DB.sqlite
      .prepare("SELECT secret_ciphertext FROM mfa_credentials")
      .get()
      .secret_ciphertext.includes(secret),
  );
  assert.ok(
    !JSON.stringify(
      DB.sqlite.prepare("SELECT * FROM mfa_recovery_codes").all(),
    ).includes(codes[0]),
  );
  const token = await challenge(env);
  const [first, second] = await Promise.all([
    call(env, "/auth/mfa", { challengeToken: token, code: codes[0] }),
    call(env, "/auth/mfa", { challengeToken: token, code: codes[0] }),
  ]);
  assert.equal([first, second].filter((r) => r.status === 200).length, 1);
  const accepted = first.status === 200 ? first : second;
  const newCookie = accepted.headers.get("set-cookie").split(";")[0];
  assert.equal((await call(env, "/auth/me", undefined, newCookie)).status, 200);
  assert.equal(
    (
      await call(env, "/auth/mfa", {
        challengeToken: await challenge(env),
        code: codes[0],
      })
    ).status,
    409,
  );
  const disabled = await call(
    env,
    "/account/mfa/disable",
    { password: "Strong-Owner-2026!", code: codes[1] },
    newCookie,
  );
  assert.equal(disabled.status, 200);
  assert.equal((await call(env, "/auth/me", undefined, newCookie)).status, 401);
  assert.equal(
    DB.sqlite
      .prepare("SELECT COUNT(*) AS n FROM mfa_credentials WHERE user_id=?")
      .get(user.id).n,
    0,
  );
  const login = await call(env, "/auth/login", {
    email: "owner@example.com",
    password: "Strong-Owner-2026!",
  });
  assert.ok((await login.json()).user);
  DB.sqlite.close();
});
test("MFA challenges are bounded and stale authentication versions cannot complete sign-in", async () => {
  const { env, DB, codes, user } = await enrolledOwner();
  const token = await challenge(env);
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await call(env, "/auth/mfa", {
          challengeToken: token,
          code: "bad-code",
        })
      ).status,
      401,
    );
  assert.equal(
    (await call(env, "/auth/mfa", { challengeToken: token, code: codes[0] }))
      .status,
    401,
  );
  const stale = await challenge(env);
  DB.sqlite
    .prepare("UPDATE users SET auth_version=auth_version+1 WHERE id=?")
    .run(user.id);
  assert.equal(
    (await call(env, "/auth/mfa", { challengeToken: stale, code: codes[0] }))
      .status,
    401,
  );
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM mfa_recovery_codes").get().n,
    10,
  );
  DB.sqlite.close();
});
test("MFA recovery-code replacement invalidates the old set without disclosing stored secrets", async () => {
  const { env, DB, codes } = await enrolledOwner();
  const response = await call(env, "/auth/mfa", {
    challengeToken: await challenge(env),
    code: codes[0],
  });
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const replaced = await call(
    env,
    "/account/mfa/recovery",
    { password: "Strong-Owner-2026!", code: codes[1] },
    cookie,
  );
  assert.equal(replaced.status, 200);
  const fresh = (await replaced.json()).recoveryCodes;
  assert.equal(fresh.length, 10);
  assert.notDeepEqual(codes, fresh);
  assert.equal(
    (
      await call(env, "/auth/mfa", {
        challengeToken: await challenge(env),
        code: codes[2],
      })
    ).status,
    409,
  );
  const profile = await (
    await call(env, "/account/mfa", undefined, cookie)
  ).json();
  assert.equal(profile.recoveryCodesRemaining, 10);
  assert.equal(profile.secret, undefined);
  DB.sqlite.close();
});
function photoStorage() {
  const objects = new Map();
  return {
    objects,
    put: async (key, stream) => {
      objects.set(
        key,
        new Uint8Array(await new Response(stream).arrayBuffer()),
      );
    },
    get: async (key) => (objects.has(key) ? { body: objects.get(key) } : null),
    delete: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys])
        objects.delete(key);
    },
  };
}
function guestMediaCall(env, token, path = "", method = "GET", body) {
  return worker.fetch(
    new Request(
      "http://localhost/api/v1/public/events/test-event/media" + path,
      {
        method,
        headers: { Authorization: `Guest ${token}` },
        ...(body ? { body } : {}),
      },
    ),
    env,
    { waitUntil() {} },
  );
}
function photoForm(consent = true) {
  const form = new FormData();
  form.set(
    "file",
    new File(
      [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])],
      "photo.png",
      { type: "image/png" },
    ),
  );
  if (consent) form.set("consent", "true");
  form.set("caption", "Guest photo");
  return form;
}
test("guest photos require consent, approval and gallery opt-in; withdrawal revokes access", async () => {
  const { env, DB, cookie } = await ownerFixture();
  env.MEDIA = photoStorage();
  const token = "guest-photo-token-2026-aaaa",
    other = "guest-photo-token-2026-bbbb";
  DB.sqlite.exec(
    "UPDATE events SET settings_json=json_set(settings_json,'$.guestUploads',json('true'),'$.guestGallery',json('true')) WHERE id='e'",
  );
  for (const [id, t] of [
    ["g", token],
    ["other", other],
  ])
    DB.sqlite
      .prepare(
        "INSERT INTO guests(id,event_id,name,access_token_hash) VALUES(?,'e','Guest',?)",
      )
      .run(id, await sha(t));
  assert.equal(
    (await guestMediaCall(env, token, "", "POST", photoForm(false))).status,
    422,
  );
  const upload = await guestMediaCall(env, token, "", "POST", photoForm());
  assert.equal(upload.status, 201);
  const { id } = await upload.json();
  assert.equal((await guestMediaCall(env, other, `/${id}/file`)).status, 404);
  assert.equal((await guestMediaCall(env, token, `/${id}/file`)).status, 200);
  assert.equal(
    (
      await http(env, `/events/e/media/${id}`, {
        method: "PATCH",
        body: { status: "approved" },
        cookie,
      })
    ).status,
    200,
  );
  assert.equal((await guestMediaCall(env, other, `/${id}/file`)).status, 200);
  assert.equal(
    (await (await guestMediaCall(env, other)).json()).items.length,
    1,
  );
  await guestMediaCall(env, other, `/${id}`, "DELETE");
  assert.equal((await guestMediaCall(env, token, `/${id}/file`)).status, 200);
  await guestMediaCall(env, token, `/${id}`, "DELETE");
  assert.equal((await guestMediaCall(env, other, `/${id}/file`)).status, 404);
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM media_deletions").get().n,
    1,
  );
  DB.sqlite.close();
});
test("upload quota and R2 failure cleanup are durable; active reservations defer erasure", async () => {
  const { env, DB } = await ownerFixture();
  env.MEDIA = photoStorage();
  const token = "guest-photo-token-2026-cccc";
  DB.sqlite.exec(
    "UPDATE events SET settings_json=json_set(settings_json,'$.guestUploads',json('true')) WHERE id='e'",
  );
  DB.sqlite
    .prepare(
      "INSERT INTO guests(id,event_id,name,access_token_hash) VALUES('g','e','Guest',?)",
    )
    .run(await sha(token));
  env.MEDIA.put = async () => {
    throw new Error("Storage unavailable");
  };
  assert.equal(
    (await guestMediaCall(env, token, "", "POST", photoForm())).status,
    500,
  );
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM media").get().n, 0);
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM media_deletions").get().n,
    1,
  );
  DB.sqlite.exec(
    "DELETE FROM media_deletions;INSERT INTO media_uploads(object_key,expires_at) VALUES('inflight',datetime('now','+1 hour'));INSERT INTO media_deletions(object_key) VALUES('inflight')",
  );
  let removed = [];
  env.MEDIA.delete = async (keys) => removed.push(...keys);
  await worker.scheduled({}, env, { waitUntil() {} });
  assert.deepEqual(removed, []);
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM media_deletions").get().n,
    1,
  );
  DB.sqlite.exec(
    "UPDATE media_uploads SET expires_at=datetime('now','-1 minute')",
  );
  await worker.scheduled({}, env, { waitUntil() {} });
  assert.deepEqual(removed, ["inflight"]);
  for (let i = 0; i < 20; i++)
    DB.sqlite
      .prepare(
        "INSERT INTO media(id,event_id,guest_id,object_key,mime_type,size_bytes) VALUES(?,'e','g',?,'image/png',12)",
      )
      .run(`m${i}`, `file${i}`);
  assert.equal(
    (await guestMediaCall(env, token, "", "POST", photoForm())).status,
    409,
  );
  DB.sqlite.close();
});
test("communication consent changes append source-labelled history and privacy erasure removes it", async () => {
  const { env, DB, cookie } = await ownerFixture();
  const token = "consent-history-token-2026";
  DB.sqlite
    .prepare(
      "INSERT INTO guests(id,event_id,name,email,access_token_hash) VALUES('g','e','Guest','old@example.com',?)",
    )
    .run(await sha(token));
  await call(env, "/public/preferences", {
    token,
    email: true,
    sms: false,
    whatsapp: false,
  });
  DB.sqlite.exec("UPDATE guests SET email='new@example.com' WHERE id='g'");
  const history = DB.sqlite
    .prepare("SELECT * FROM communication_consents ORDER BY id")
    .all();
  assert.equal(history.length, 2);
  assert.equal(history[0].source, "guest_link");
  assert.equal(history[0].email_opt_in, 1);
  assert.equal(history[1].source, "contact_change");
  assert.equal(history[1].email_opt_in, 0);
  assert.equal(
    (await call(env, "/events/e/consents", undefined, cookie)).status,
    200,
  );
  await call(
    env,
    "/events/e/erase-guest/g",
    { password: "Strong-Owner-2026!" },
    cookie,
  );
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM communication_consents").get()
      .n,
    0,
  );
  DB.sqlite.close();
});

test("password reset preserves MFA and recovery codes still work during an encryption-key incident", async () => {
  const { env, DB, codes, user } = await enrolledOwner(),
    token = "reset-mfa-account-token-2026";
  DB.sqlite
    .prepare(
      "INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)",
    )
    .run(
      "mfa-reset",
      user.id,
      await sha(token),
      new Date(Date.now() + 60000).toISOString(),
    );
  assert.equal(
    (
      await call(env, "/auth/password/reset", {
        token,
        password: "Reset-MFA-Password-2026!",
      })
    ).status,
    200,
  );
  env.APP_ENV = "production";
  env.DEMO_MODE = "false";
  env.APP_ORIGIN = "https://example.com";
  env.SESSION_PEPPER = "p".repeat(40);
  delete env.MFA_ENCRYPTION_KEY;
  const login = await (
    await call(env, "/auth/login", {
      email: "owner@example.com",
      password: "Reset-MFA-Password-2026!",
    })
  ).json();
  assert.equal(login.mfaRequired, true);
  assert.ok(!login.user);
  assert.equal(
    (
      await call(env, "/auth/mfa", {
        challengeToken: login.challengeToken,
        code: codes[0],
      })
    ).status,
    200,
  );
  assert.ok(
    DB.sqlite
      .prepare("SELECT enabled_at FROM mfa_credentials WHERE user_id=?")
      .get(user.id).enabled_at,
  );
  DB.sqlite.close();
});

test("MFA attempt limits apply per account across newly issued challenges", async () => {
  const { env, DB, codes } = await enrolledOwner();
  for (let i = 0; i < 19; i++)
    assert.equal(
      (
        await call(env, "/auth/mfa", {
          challengeToken: await challenge(env),
          code: "bad-code",
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await call(env, "/auth/mfa", {
        challengeToken: await challenge(env),
        code: codes[0],
      })
    ).status,
    429,
  );
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM mfa_recovery_codes").get().n,
    10,
  );
  DB.sqlite.close();
});

const ownerPassword = "Strong-Owner-2026!";
const providerResponse = (data) =>
  new Response(JSON.stringify({ status: true, data }), { status: 200 });
async function commerceFixture() {
  const f = await ownerFixture();
  f.env.PAYSTACK_SECRET_KEY = "test-only-commerce";
  f.env.PAYOUT_VERIFICATION_KEY =
    "test-only-payout-key-with-at-least-32-characters";
  return f;
}
async function checkoutPackage(
  f,
  product = "essential",
  key = "stable-package-order-key-123",
  price = 750000,
) {
  return http(f.env, "/events/e/billing/checkout", {
    method: "POST",
    cookie: f.cookie,
    headers: { "Idempotency-Key": key },
    body: { product, expectedPriceMinor: price },
  });
}
async function billingWebhook(f, order, overrides = {}) {
  const { createHmac } = await import("node:crypto");
  const body = JSON.stringify({
    event: "charge.success",
    data: {
      id: 123,
      reference: order.reference,
      status: "success",
      amount: order.amount_minor,
      currency: "NGN",
      ...overrides,
    },
  });
  return worker.fetch(
    new Request("http://localhost/api/v1/webhooks/paystack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-paystack-signature": createHmac("sha512", f.env.PAYSTACK_SECRET_KEY)
          .update(body)
          .digest("hex"),
      },
      body,
    }),
    f.env,
    { waitUntil() {} },
  );
}
test("catalog defaults to a usable free tier; paid drafts cannot be purchased and ownership is enforced", async () => {
  const f = await commerceFixture();
  const catalog = await (await call(f.env, "/plans")).json();
  assert.equal(catalog.plans.filter((p) => p.active).length, 1);
  assert.equal(catalog.plans.find((p) => p.active).code, "free");
  const bill = await (
    await call(f.env, "/events/e/billing", undefined, f.cookie)
  ).json();
  assert.equal(bill.entitlement.guest_limit, 50);
  assert.equal(bill.entitlement.message_limit, 0);
  assert.equal((await checkoutPackage(f)).status, 409);
  assert.equal((await call(f.env, "/events/e/billing")).status, 401);
  assert.equal(
    (await call(f.env, "/admin/commerce", undefined, f.cookie)).status,
    403,
  );
  assert.equal(
    (await call(f.env, "/events/another/billing", undefined, f.cookie)).status,
    404,
  );
  f.DB.sqlite.close();
});
test("free quotas enforce party places, bulk rollback, occasions, media and lifetime message credits", async () => {
  const { DB } = await ownerFixture();
  const sql = DB.sqlite;
  sql.exec(
    "INSERT INTO guests(id,event_id,name,party_size) VALUES('g','e','Large party',20),('g2','e','Second party',30)",
  );
  assert.throws(
    () =>
      sql.exec(
        "INSERT INTO guests(id,event_id,name) VALUES('over','e','One more')",
      ),
    /package_limit/,
  );
  assert.throws(
    () => sql.exec("UPDATE guests SET party_size=21 WHERE id='g'"),
    /package_limit/,
  );
  assert.equal(
    sql.prepare("SELECT party_size FROM guests WHERE id='g'").get().party_size,
    20,
  );
  sql.exec(
    "UPDATE event_entitlements SET occasion_limit=1,photo_limit=1,storage_limit=10;INSERT INTO occasions(id,event_id,title,starts_at,venue_name,address) VALUES('o','e','Day','2027-01-01','Lagos','Lagos')",
  );
  assert.throws(
    () =>
      sql.exec(
        "INSERT INTO occasions(id,event_id,title,starts_at,venue_name,address) VALUES('o2','e','Day two','2027-01-02','Lagos','Lagos')",
      ),
    /package_limit/,
  );
  sql.exec(
    "INSERT INTO media(id,event_id,object_key,mime_type,size_bytes) VALUES('m','e','photo','image/png',10)",
  );
  assert.throws(
    () =>
      sql.exec(
        "INSERT INTO media(id,event_id,object_key,mime_type,size_bytes) VALUES('m2','e','photo2','image/png',1)",
      ),
    /package_limit/,
  );
  const owner = sql
    .prepare("SELECT owner_id FROM events WHERE id='e'")
    .get().owner_id;
  sql
    .prepare(
      "INSERT INTO announcements(id,event_id,created_by,channel,audience,message) VALUES('a','e',?,'email','all','Hi')",
    )
    .run(owner);
  assert.throws(
    () =>
      sql.exec(
        "INSERT INTO announcement_recipients(announcement_id,guest_id) VALUES('a','g')",
      ),
    /package_limit/,
  );
  sql.exec(
    "UPDATE event_entitlements SET message_limit=1;INSERT INTO announcement_recipients(announcement_id,guest_id) VALUES('a','g');DELETE FROM announcement_recipients WHERE announcement_id='a'",
  );
  assert.equal(
    sql
      .prepare(
        "SELECT messages_used FROM event_entitlements WHERE event_id='e'",
      )
      .get().messages_used,
    1,
  );
  assert.throws(
    () =>
      sql.exec(
        "INSERT INTO announcement_recipients(announcement_id,guest_id) VALUES('a','g')",
      ),
    /package_limit/,
  );
  sql.close();
});
test("package checkout binds price and key, reuses one provider initialization, and grants only verified unsplit payments once", async () => {
  const f = await commerceFixture(),
    original = globalThis.fetch;
  let calls = 0;
  f.DB.sqlite.exec("UPDATE plan_catalog SET active=1 WHERE code='essential'");
  globalThis.fetch = async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(body.amount, 750000);
    assert.equal(body.subaccount, undefined);
    return providerResponse({
      authorization_url: "https://checkout.paystack.com/test-package",
    });
  };
  try {
    assert.equal(
      (await checkoutPackage(f, "essential", "stable-package-order-key-123", 1))
        .status,
      409,
    );
    assert.equal((await checkoutPackage(f)).status, 201);
    assert.equal((await checkoutPackage(f)).status, 200);
    assert.equal(calls, 1);
    assert.equal((await checkoutPackage(f, "guest-pack")).status, 409);
    const order = f.DB.sqlite.prepare("SELECT * FROM billing_orders").get();
    assert.equal(
      f.DB.sqlite
        .prepare("SELECT tier FROM event_entitlements WHERE event_id='e'")
        .get().tier,
      0,
    );
    assert.equal((await billingWebhook(f, order, { amount: 1 })).status, 422);
    assert.equal(
      (await billingWebhook(f, order, { currency: "USD" })).status,
      422,
    );
    assert.equal(
      (
        await billingWebhook(f, order, {
          subaccount: { subaccount_code: "ACCT_attacker" },
        })
      ).status,
      422,
    );
    assert.equal((await billingWebhook(f, order)).status, 200);
    assert.equal((await billingWebhook(f, order)).status, 200);
    const q = f.DB.sqlite
      .prepare("SELECT * FROM event_entitlements WHERE event_id='e'")
      .get();
    assert.equal(q.guest_limit, 200);
    assert.equal(q.plan_code, "essential");
    assert.throws(
      () => f.DB.sqlite.exec("UPDATE billing_orders SET status='uncertain'"),
      /paid_order_immutable/,
    );
    assert.equal((await checkoutPackage(f)).status, 200);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    f.DB.sqlite.close();
  }
});
test("add-on credits survive later upgrades and webhook replays cannot grant them twice", async () => {
  const f = await commerceFixture();
  const add = (ref, code) =>
    f.DB.sqlite
      .prepare(
        "INSERT INTO billing_orders(reference,event_id,owner_id,request_key,product_code,kind,tier,amount_minor,limits_json) SELECT ?,'e',?,?,code,kind,tier,price_minor,limits_json FROM plan_catalog WHERE code=?",
      )
      .run(ref, f.user.id, ref, code);
  add("pack", "guest-pack");
  let order = f.DB.sqlite
    .prepare("SELECT * FROM billing_orders WHERE reference='pack'")
    .get();
  assert.equal((await billingWebhook(f, order)).status, 200);
  assert.equal((await billingWebhook(f, order)).status, 200);
  assert.equal(
    f.DB.sqlite
      .prepare("SELECT guest_limit FROM event_entitlements WHERE event_id='e'")
      .get().guest_limit,
    150,
  );
  add("upgrade", "celebration");
  order = f.DB.sqlite
    .prepare("SELECT * FROM billing_orders WHERE reference='upgrade'")
    .get();
  assert.equal((await billingWebhook(f, order)).status, 200);
  assert.equal(
    f.DB.sqlite
      .prepare("SELECT guest_limit FROM event_entitlements WHERE event_id='e'")
      .get().guest_limit,
    600,
  );
  f.DB.sqlite.exec("UPDATE events SET lifecycle='archived' WHERE id='e'");
  assert.equal(
    (
      await call(
        f.env,
        "/events/e/delete",
        { password: ownerPassword, confirmation: "Test event" },
        f.cookie,
      )
    ).status,
    409,
  );
  f.DB.sqlite.close();
});
test("ambiguous package initialization retains its reference; cron verifies without issuing replacement charges", async () => {
  const f = await commerceFixture(),
    original = globalThis.fetch;
  let initialized = 0;
  f.DB.sqlite.exec("UPDATE plan_catalog SET active=1 WHERE code<>'free'");
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/initialize")) {
      initialized++;
      throw Error("timeout");
    }
    const order = f.DB.sqlite.prepare("SELECT * FROM billing_orders").get();
    return providerResponse({
      reference: order.reference,
      status: "success",
      amount: order.amount_minor,
      currency: "NGN",
      subaccount: {},
      split: {},
    });
  };
  try {
    assert.equal((await checkoutPackage(f)).status, 202);
    assert.equal((await checkoutPackage(f)).status, 202);
    assert.equal(
      (
        await checkoutPackage(
          f,
          "guest-pack",
          "another-stable-package-key",
          250000,
        )
      ).status,
      409,
    );
    assert.equal(initialized, 1);
    await worker.scheduled({}, f.env);
    assert.equal(
      f.DB.sqlite.prepare("SELECT status FROM billing_orders").get().status,
      "paid",
    );
    assert.equal(initialized, 1);
  } finally {
    globalThis.fetch = original;
    f.DB.sqlite.close();
  }
});
test("operator closure requires step-up and explicit provider review; late payments are still honored once", async () => {
  const f = await commerceFixture();
  f.DB.sqlite
    .prepare("UPDATE users SET platform_role='admin' WHERE id=?")
    .run(f.user.id);
  f.DB.sqlite
    .prepare(
      "INSERT INTO billing_orders(reference,event_id,owner_id,request_key,product_code,kind,tier,amount_minor,limits_json,status) SELECT 'close-ref','e',?,'close-key',code,kind,tier,price_minor,limits_json,'uncertain' FROM plan_catalog WHERE code='guest-pack'",
    )
    .run(f.user.id);
  const body = {
    password: ownerPassword,
    reason: "Provider support confirmed cancellation",
    confirmation: "Provider checkout cancelled; no payment received",
  };
  assert.equal(
    (
      await call(
        f.env,
        "/admin/billing/close-ref/close",
        { ...body, password: "wrong" },
        f.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        f.env,
        "/admin/billing/close-ref/close",
        { ...body, confirmation: "retry" },
        f.cookie,
      )
    ).status,
    422,
  );
  assert.equal(
    (await call(f.env, "/admin/billing/close-ref/close", body, f.cookie))
      .status,
    200,
  );
  const order = f.DB.sqlite.prepare("SELECT * FROM billing_orders").get();
  assert.equal(order.status, "rejected");
  assert.equal((await billingWebhook(f, order)).status, 200);
  assert.equal((await billingWebhook(f, order)).status, 200);
  assert.equal(
    f.DB.sqlite
      .prepare("SELECT guest_limit FROM event_entitlements WHERE event_id='e'")
      .get().guest_limit,
    150,
  );
  assert.equal(
    (await call(f.env, "/admin/billing/close-ref/close", body, f.cookie))
      .status,
    409,
  );
  f.DB.sqlite.close();
});
test("payout onboarding stores no full account number, cannot duplicate creation, and needs provider and human review", async () => {
  const f = await commerceFixture(),
    original = globalThis.fetch;
  f.DB.sqlite.exec("DELETE FROM payout_accounts");
  let created = 0;
  const provider = {
    subaccount_code: "ACCT_onboarding",
    settlement_bank: "Test Bank",
    bank_code: "058",
    account_number: "0123456789",
    active: true,
    is_verified: true,
    metadata: { invibox_owner_id: f.user.id },
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/bank?"))
      return providerResponse([{ code: "058", name: "Test Bank" }]);
    if (String(url).includes("/bank/resolve"))
      return providerResponse({
        account_number: "0123456789",
        account_name: "Account Owner",
      });
    if (String(url).endsWith("/subaccount")) {
      created++;
      provider.metadata = JSON.parse(JSON.parse(init.body).metadata);
      assert.equal(JSON.parse(init.body).percentage_charge, 0);
      return providerResponse(provider);
    }
    return providerResponse(provider);
  };
  try {
    const body = {
      password: ownerPassword,
      bankCode: "058",
      accountNumber: "0123456789",
      businessName: "My events",
      consent: true,
    };
    assert.equal(
      (await call(f.env, "/account/payout", body, f.cookie)).status,
      202,
    );
    assert.equal(
      (await call(f.env, "/account/payout", body, f.cookie)).status,
      409,
    );
    assert.equal(created, 1);
    const stored = f.DB.sqlite.prepare("SELECT * FROM payout_accounts").get();
    assert.equal(stored.state, "review");
    assert.ok(!JSON.stringify(stored).includes("0123456789"));
    assert.ok(
      !(
        await (await call(f.env, "/account/payout", undefined, f.cookie)).text()
      ).includes(stored.request_hash),
    );
    const approve = {
      password: ownerPassword,
      subaccountCode: "ACCT_onboarding",
      identityReviewed: true,
      reason: "Identity and bank authority reviewed independently",
    };
    assert.equal(
      (
        await call(
          f.env,
          `/admin/payouts/${f.user.id}/verify`,
          approve,
          f.cookie,
        )
      ).status,
      403,
    );
    f.DB.sqlite
      .prepare("UPDATE users SET platform_role='admin' WHERE id=?")
      .run(f.user.id);
    provider.is_verified = false;
    assert.equal(
      (
        await call(
          f.env,
          `/admin/payouts/${f.user.id}/verify`,
          approve,
          f.cookie,
        )
      ).status,
      409,
    );
    provider.is_verified = true;
    provider.settlement_bank = "Wrong bank";
    assert.equal(
      (
        await call(
          f.env,
          `/admin/payouts/${f.user.id}/verify`,
          approve,
          f.cookie,
        )
      ).status,
      409,
    );
    provider.settlement_bank = "Test Bank";
    provider.metadata.invibox_owner_id = "wrong";
    assert.equal(
      (
        await call(
          f.env,
          `/admin/payouts/${f.user.id}/verify`,
          approve,
          f.cookie,
        )
      ).status,
      409,
    );
    provider.metadata.invibox_owner_id = f.user.id;
    assert.equal(
      (
        await call(
          f.env,
          `/admin/payouts/${f.user.id}/verify`,
          approve,
          f.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      f.DB.sqlite.prepare("SELECT state FROM payout_accounts").get().state,
      "verified",
    );
    const block = {
      password: ownerPassword,
      reason: "Bank replacement requested by organizer",
    };
    assert.equal(
      (await call(f.env, `/admin/payouts/${f.user.id}/block`, block, f.cookie))
        .status,
      200,
    );
    const reset = {
      ...block,
      confirmation: "Provider absent or inactive; settlements reviewed",
    };
    assert.equal(
      (await call(f.env, `/admin/payouts/${f.user.id}/reset`, reset, f.cookie))
        .status,
      409,
    );
    provider.active = false;
    assert.equal(
      (await call(f.env, `/admin/payouts/${f.user.id}/reset`, reset, f.cookie))
        .status,
      200,
    );
    assert.equal(
      f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM payout_accounts").get().n,
      0,
    );
    assert.ok(
      f.DB.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_logs WHERE action='payout.reset'",
        )
        .get().n,
    );
  } finally {
    globalThis.fetch = original;
    f.DB.sqlite.close();
  }
});
test("payout creation timeout remains uncertain and missing fingerprint secret fails closed", async () => {
  const f = await commerceFixture(),
    original = globalThis.fetch;
  f.DB.sqlite.exec("DELETE FROM payout_accounts");
  const body = {
    password: ownerPassword,
    bankCode: "058",
    accountNumber: "0123456789",
    businessName: "My events",
    consent: true,
  };
  const key = f.env.PAYOUT_VERIFICATION_KEY;
  delete f.env.PAYOUT_VERIFICATION_KEY;
  assert.equal(
    (await call(f.env, "/account/payout", body, f.cookie)).status,
    503,
  );
  f.env.PAYOUT_VERIFICATION_KEY = key;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/bank?"))
      return providerResponse([{ code: "058", name: "Test Bank" }]);
    if (String(url).includes("/resolve"))
      return providerResponse({
        account_number: "0123456789",
        account_name: "Owner",
      });
    throw Error("timeout");
  };
  try {
    assert.equal(
      (await call(f.env, "/account/payout", body, f.cookie)).status,
      202,
    );
    assert.equal(
      f.DB.sqlite.prepare("SELECT state FROM payout_accounts").get().state,
      "uncertain",
    );
    assert.equal(
      (await call(f.env, "/account/payout", body, f.cookie)).status,
      409,
    );
  } finally {
    globalThis.fetch = original;
    f.DB.sqlite.close();
  }
});
test("contributions fail closed without verified payout and snapshot the zero-commission organizer route", async () => {
  const f = await commerceFixture(),
    original = globalThis.fetch;
  let payload;
  const donate = () =>
    http(f.env, "/public/payments/paystack/initialize", {
      method: "POST",
      headers: { "Idempotency-Key": "stable-routed-contribution-123" },
      body: {
        slug: "test-event",
        email: "guest@example.com",
        amount: 1000,
        purpose: "gift",
      },
    });
  globalThis.fetch = async (url, init) => {
    payload = JSON.parse(init.body);
    return providerResponse({
      authorization_url: "https://checkout.paystack.com/routed",
      access_code: "access",
    });
  };
  try {
    f.DB.sqlite.exec("UPDATE payout_accounts SET state='review'");
    assert.equal((await donate()).status, 409);
    f.DB.sqlite.exec("UPDATE payout_accounts SET state='verified'");
    assert.equal((await donate()).status, 201);
    assert.equal(payload.subaccount, "ACCT_fixture");
    assert.equal(payload.transaction_charge, 0);
    assert.equal(payload.bearer, "subaccount");
    const payment = f.DB.sqlite.prepare("SELECT * FROM payments").get();
    assert.equal(payment.subaccount_code, "ACCT_fixture");
    assert.throws(
      () =>
        f.DB.sqlite.exec("UPDATE payments SET subaccount_code='ACCT_other'"),
      /payment_route_immutable/,
    );
    assert.equal(
      (
        await billingWebhook(f, payment, {
          subaccount: { subaccount_code: "ACCT_wrong" },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await billingWebhook(f, payment, {
          subaccount: { subaccount_code: "ACCT_fixture" },
        })
      ).status,
      200,
    );
  } finally {
    globalThis.fetch = original;
    f.DB.sqlite.close();
  }
});
test("catalog updates validate prices and preserve previously snapshotted limits", async () => {
  const f = await commerceFixture();
  f.DB.sqlite
    .prepare("UPDATE users SET platform_role='admin' WHERE id=?")
    .run(f.user.id);
  const free = f.DB.sqlite
    .prepare("SELECT * FROM plan_catalog WHERE code='free'")
    .get();
  const body = {
    password: ownerPassword,
    name: "Free",
    priceMinor: 0,
    active: true,
    limits: { ...JSON.parse(free.limits_json), guests: 75 },
  };
  const update = (body, code = "free") =>
    http(f.env, `/admin/plans/${code}`, {
      method: "PATCH",
      cookie: f.cookie,
      body,
    });
  assert.equal((await update({ ...body, priceMinor: 10000 })).status, 422);
  assert.equal((await update({ ...body, active: false })).status, 422);
  assert.equal((await update(body, "nonexistent")).status, 404);
  assert.equal((await update(body)).status, 200);
  assert.equal(
    f.DB.sqlite
      .prepare("SELECT guest_limit FROM event_entitlements WHERE event_id='e'")
      .get().guest_limit,
    50,
  );
  f.DB.sqlite
    .prepare(
      "INSERT INTO events(id,owner_id,slug,title,event_type,starts_at,location) VALUES('new',?,'new-package','New','custom','2027-01-01','Lagos')",
    )
    .run(f.user.id);
  assert.equal(
    f.DB.sqlite
      .prepare(
        "SELECT guest_limit FROM event_entitlements WHERE event_id='new'",
      )
      .get().guest_limit,
    75,
  );
  f.DB.sqlite.close();
});
test("financial operations enforce enabled MFA and consume recovery proof atomically", async () => {
  const f = await enrolledOwner();
  f.DB.sqlite
    .prepare("UPDATE users SET platform_role='admin' WHERE id=?")
    .run(f.user.id);
  const login = await call(f.env, "/auth/mfa", {
    challengeToken: await challenge(f.env),
    code: f.codes[0],
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const body = {
    password: ownerPassword,
    reason: "Bank account review found a discrepancy",
  };
  assert.equal(
    (await call(f.env, `/admin/payouts/${f.user.id}/block`, body, cookie))
      .status,
    401,
  );
  assert.equal(
    (
      await call(
        f.env,
        `/admin/payouts/${f.user.id}/block`,
        { ...body, code: f.codes[1] },
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        f.env,
        `/admin/payouts/${f.user.id}/block`,
        { ...body, code: f.codes[1] },
        cookie,
      )
    ).status,
    409,
  );
  f.DB.sqlite.close();
});

test("bulk guest quota validation runs at commit and rolls back the whole snapshot", async () => {
  const { DB } = await ownerFixture();
  DB.sqlite.exec(
    "UPDATE event_entitlements SET guest_limit=1;INSERT INTO guests(id,event_id,name) VALUES('before','e','Before')",
  );
  const version = DB.sqlite
    .prepare("SELECT guests_version FROM events WHERE id='e'")
    .get().guests_version;
  const guard = () =>
    DB.prepare(
      "INSERT INTO sync_guards(id,event_id,collection,expected_version) VALUES('quota-sync','e','guests',?)",
    ).bind(version);
  await assert.rejects(
    DB.batch([
      guard(),
      DB.prepare(
        "INSERT INTO guests(id,event_id,name) VALUES('extra','e','Extra')",
      ),
      DB.prepare("DELETE FROM sync_guards WHERE id='quota-sync'"),
    ]),
    /package_limit/,
  );
  assert.equal(
    DB.sqlite
      .prepare("SELECT COUNT(*) AS n FROM guests WHERE event_id='e'")
      .get().n,
    1,
  );
  assert.equal(
    DB.sqlite.prepare("SELECT COUNT(*) AS n FROM sync_guards").get().n,
    0,
  );
  await DB.batch([
    guard(),
    DB.prepare(
      "INSERT INTO guests(id,event_id,name) VALUES('after','e','After')",
    ),
    DB.prepare("DELETE FROM guests WHERE id='before'"),
    DB.prepare("DELETE FROM sync_guards WHERE id='quota-sync'"),
  ]);
  assert.equal(
    DB.sqlite.prepare("SELECT id FROM guests WHERE event_id='e'").get().id,
    "after",
  );
  DB.sqlite.close();
});
test("simultaneous package retries claim one initialization; webhook wins over a late checkout response", async () => {
  const f = await commerceFixture(),
    original = globalThis.fetch;
  f.DB.sqlite.exec("UPDATE plan_catalog SET active=1 WHERE code='essential'");
  let entered,
    release,
    requests = 0;
  const started = new Promise((resolve) => (entered = resolve)),
    hold = new Promise((resolve) => (release = resolve));
  globalThis.fetch = async () => {
    requests++;
    entered();
    await hold;
    return providerResponse({
      authorization_url: "https://checkout.paystack.com/race",
    });
  };
  try {
    const first = checkoutPackage(f);
    await started;
    assert.equal((await checkoutPackage(f)).status, 202);
    assert.equal(
      (await checkoutPackage(f, "essential", "different-stable-package-key"))
        .status,
      409,
    );
    const order = f.DB.sqlite.prepare("SELECT * FROM billing_orders").get();
    assert.equal((await billingWebhook(f, order)).status, 200);
    release();
    const result = await (await first).json();
    assert.equal(result.status, "paid");
    assert.equal(result.checkoutUrl, undefined);
    assert.equal(requests, 1);
    assert.equal(
      f.DB.sqlite
        .prepare(
          "SELECT guest_limit FROM event_entitlements WHERE event_id='e'",
        )
        .get().guest_limit,
      200,
    );
  } finally {
    release();
    globalThis.fetch = original;
    f.DB.sqlite.close();
  }
});

test("stale payout approval cannot reverse a concurrent block or attach an earlier onboarding request", async () => {
  const f = await commerceFixture(),
    original = globalThis.fetch;
  const { createHmac } = await import("node:crypto");
  f.DB.sqlite
    .prepare("UPDATE users SET platform_role='admin' WHERE id=?")
    .run(f.user.id);
  f.DB.sqlite
    .prepare("UPDATE payout_accounts SET state='review',request_hash=?")
    .run(
      createHmac("sha512", f.env.PAYOUT_VERIFICATION_KEY)
        .update("058:0123456789")
        .digest("hex"),
    );
  const account = f.DB.sqlite.prepare("SELECT * FROM payout_accounts").get();
  const provider = {
    subaccount_code: "ACCT_fixture",
    settlement_bank: "Test Bank",
    account_number: "0123456789",
    active: true,
    is_verified: true,
    metadata: {
      invibox_owner_id: f.user.id,
      invibox_request_id: "previous-request",
    },
  };
  globalThis.fetch = async () => providerResponse(provider);
  const body = {
    password: ownerPassword,
    identityReviewed: true,
    subaccountCode: "ACCT_fixture",
    reason: "Independent identity review completed",
  };
  try {
    assert.equal(
      (await call(f.env, `/admin/payouts/${f.user.id}/verify`, body, f.cookie))
        .status,
      409,
    );
    provider.metadata.invibox_request_id = account.request_id;
    globalThis.fetch = async () => {
      f.DB.sqlite.exec("UPDATE payout_accounts SET state='blocked'");
      return providerResponse(provider);
    };
    assert.equal(
      (await call(f.env, `/admin/payouts/${f.user.id}/verify`, body, f.cookie))
        .status,
      409,
    );
    assert.equal(
      f.DB.sqlite.prepare("SELECT state FROM payout_accounts").get().state,
      "blocked",
    );
    assert.equal(
      f.DB.sqlite
        .prepare("SELECT COUNT(*) AS n FROM payout_review_guards")
        .get().n,
      0,
    );
    assert.equal(
      f.DB.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_logs WHERE action='payout.verify'",
        )
        .get().n,
      0,
    );
  } finally {
    globalThis.fetch = original;
    f.DB.sqlite.close();
  }
});
test("legacy merchant-only payment reservations cannot initialize or reopen checkout after organizer routing is required", async () => {
  const f = await commerceFixture(),
    original = globalThis.fetch;
  let requests = 0;
  const body = {
      slug: "test-event",
      email: "guest@example.com",
      amount: 100,
      purpose: "contribution",
    },
    key = "legacy-payment-stable-key";
  const hash = await sha(
    JSON.stringify({
      eventId: "e",
      guestId: null,
      email: body.email,
      amountMinor: 10000,
      purpose: body.purpose,
    }),
  );
  f.DB.sqlite
    .prepare(
      "INSERT INTO payments(id,event_id,provider,reference,purpose,amount_minor,request_key,request_hash,initialization_state,status) VALUES('legacy','e','paystack','legacy-ref','contribution',10000,?,?,'reserved','pending')",
    )
    .run(key, hash);
  globalThis.fetch = async () => {
    requests++;
    throw Error("must not initialize merchant fallback");
  };
  const initialize = () =>
    http(f.env, "/public/payments/paystack/initialize", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body,
    });
  try {
    assert.equal((await initialize()).status, 409);
    f.DB.sqlite.exec(
      "UPDATE payments SET checkout_url='https://checkout.paystack.com/legacy'",
    );
    assert.equal((await initialize()).status, 409);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
    f.DB.sqlite.close();
  }
});

test("bank onboarding catalog follows provider cursors, filters inactive entries and rejects pagination loops", async () => {
  const f = await commerceFixture(),
    original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    const cursor = new URL(url).searchParams.get("next");
    assert.equal(new URL(url).searchParams.get("use_cursor"), "true");
    return new Response(
      JSON.stringify({
        status: true,
        data: cursor
          ? [
              {
                code: "057",
                name: "Zenith Bank",
                active: true,
                currency: "NGN",
              },
            ]
          : [
              { code: "058", name: "Test Bank", active: true },
              { code: "999", name: "Unavailable Bank", active: false },
              { code: "998", name: "Deleted Bank", is_deleted: true },
            ],
        meta: { next: cursor ? null : "bank:cursor/=" },
      }),
    );
  };
  try {
    const response = await call(
      f.env,
      "/account/payout/banks",
      undefined,
      f.cookie,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json()).banks.map((b) => b.code),
      ["058", "057"],
    );
    assert.equal(requests, 2);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          status: true,
          data: [],
          meta: { next: "repeated-cursor" },
        }),
      );
    assert.equal(
      (await call(f.env, "/account/payout/banks", undefined, f.cookie)).status,
      502,
    );
  } finally {
    globalThis.fetch = original;
    f.DB.sqlite.close();
  }
});
