import { registerGuestMediaRoutes, cleanAbandonedUploads } from "./guestMedia";
import { loginChallenge, registerMfaRoutes } from "./mfa";
import { registerCommunicationRoutes, withUnsubscribe } from "./communications";
import { initializePayment, reconcilePayment } from "./payments";
import { registerPrivacyRoutes, purgeMedia } from "./privacy";
import { registerAccountRoutes, requireVerified } from "./account";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  canAccess,
  assertTransition,
  validTimezone,
  zonedDateTime,
  localDateTime,
  constantTimeEqual,
  paymentMatches,
} from "./domain";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { ZodError, z } from "zod";
import type { AppEnv, NotificationJob } from "./types";
import {
  announcementSchema,
  credentials,
  guestSchema,
  json,
  rsvpSchema,
  scheduleSchema,
} from "./validation";
import {
  clearCookie,
  cookie,
  getCookie,
  hashPassword,
  hmacSha512,
  randomToken,
  sha256,
  uid,
  verifyPassword,
} from "./security";
import {
  ProviderConfigurationError,
  ProviderRequestError,
  runAi,
  sendNotification,
} from "./providers";

const app = new Hono<AppEnv>();
const nowIso = () => new Date().toISOString();
const expires = (days = 30) =>
  new Date(Date.now() + days * 86400000).toISOString();
const audit = async (
  db: D1Database,
  eventId: string | null,
  actor: string | null,
  action: string,
  type: string,
  entity: string | null,
  requestId: string,
  meta: unknown = {},
) =>
  db
    .prepare(
      "INSERT INTO audit_logs(id,event_id,actor_id,action,entity_type,entity_id,metadata_json,request_id) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(
      uid("aud"),
      eventId,
      actor,
      action,
      type,
      entity,
      JSON.stringify(meta),
      requestId,
    )
    .run();

app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  await next();
  c.header("x-request-id", c.get("requestId"));
});
app.use("/api/*", secureHeaders());
app.use(
  "/api/*",
  cors({
    origin: (origin, c) =>
      origin === c.env.APP_ORIGIN || c.env.APP_ENV === "development"
        ? origin
        : "",
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Request-Id",
      "If-Match",
    ],
  }),
);

// CORS is not CSRF protection: reject cross-site browser writes before handlers.
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
  if (
    c.env.APP_ENV !== "development" &&
    (c.env.DEMO_MODE === "true" ||
      !c.env.SESSION_PEPPER ||
      c.env.SESSION_PEPPER.length < 32 ||
      !c.env.APP_ORIGIN.startsWith("https://"))
  ) {
    throw new HTTPException(503, {
      message: "Unsafe deployment configuration",
    });
  }
  if (
    !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
    !c.req.path.startsWith("/api/v1/webhooks/")
  ) {
    const origin = c.req.header("origin");
    if (
      origin &&
      origin !== c.env.APP_ORIGIN &&
      !(
        c.env.APP_ENV === "development" &&
        (origin === new URL(c.req.url).origin ||
          /^https:\/\/[a-z0-9-]+\.e2b\.app$/.test(origin))
      )
    )
      throw new HTTPException(403, { message: "Untrusted request origin" });
    const type = c.req.header("content-type") || "";
    if (
      c.req.header("content-length") !== "0" &&
      type &&
      !type.startsWith("application/json") &&
      !(c.req.path.endsWith("/media") && type.startsWith("multipart/form-data"))
    )
      throw new HTTPException(415, { message: "Use application/json" });
  }
  await next();
});
app.use("/api/*", async (c, next) => {
  if (!c.req.path.endsWith("/media"))
    return bodyLimit({
      maxSize: 2 * 1024 * 1024,
      onError: (c) =>
        c.json({ error: { message: "JSON request exceeds 2 MB" } }, 413),
    })(c, next);
  await next();
});
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 26 * 1024 * 1024,
    onError: (c) => c.json({ error: { message: "Request is too large" } }, 413),
  }),
);

async function rateLimit(c: any, next: any) {
  const ip = c.req.header("cf-connecting-ip") || "local";
  const window = Math.floor(Date.now() / 60000);
  const bucket = c.req.path.startsWith("/api/v1/auth/")
    ? "auth"
    : c.req.path
        .replace(/(?:evt|gst|pay)_[a-z0-9]+/g, ":id")
        .replace(/\/public\/events\/[^/]+/, "/public/events/:slug");
  const key = `${await sha256(ip)}:${bucket}:${window}`;
  const row = await c.env.DB.prepare(
    "INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
  )
    .bind(key, (window + 2) * 60)
    .first();
  if (row.count > 60) {
    c.header("Retry-After", "60");
    throw new HTTPException(429, {
      message: "Too many requests. Please try again shortly.",
    });
  }
  await next();
}
async function authenticate(c: any, next: any) {
  const raw = getCookie(c.req.header("cookie"), "invibox_session");
  if (!raw)
    throw new HTTPException(401, { message: "Authentication required" });
  const hash = await sha256(raw + (c.env.SESSION_PEPPER || ""));
  const row = (await c.env.DB.prepare(
    "SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.disabled_at IS NULL AND s.auth_version=u.auth_version AND token_hash=? AND julianday(expires_at) > julianday('now')",
  )
    .bind(hash)
    .first()) as { user_id: string } | null;
  if (!row) throw new HTTPException(401, { message: "Session expired" });
  c.set("userId", row.user_id);
  await next();
}
async function ownEvent(c: any, eventId: string) {
  const row = await c.env.DB.prepare(
    "SELECT e.*,CASE WHEN e.owner_id=? THEN 'owner' ELSE m.role END AS member_role FROM events e LEFT JOIN event_members m ON m.event_id=e.id AND m.user_id=? WHERE e.id=? AND (e.owner_id=? OR m.role IS NOT NULL)",
  )
    .bind(c.get("userId"), c.get("userId"), eventId, c.get("userId"))
    .first();
  if (!row) throw new HTTPException(404, { message: "Event not found" });
  const resource = c.req.path.slice(`/api/v1/events/${eventId}`.length);
  if (!canAccess(row.member_role, c.req.method, resource))
    throw new HTTPException(403, {
      message: "Your event role cannot perform this action",
    });
  if (
    !["GET", "HEAD"].includes(c.req.method) &&
    ["completed", "archived"].includes(row.lifecycle) &&
    resource !== "" &&
    !(c.req.method === "DELETE" && resource.startsWith("/team")) &&
    !(c.req.method === "PATCH" && /^\/media\/[^/]+$/.test(resource)) &&
    !/^\/payments\/[^/]+\/reconcile$/.test(resource)
  )
    throw new HTTPException(409, { message: "This event is read-only" });
  if (
    row.lifecycle === "live" &&
    ["/sections/sync", "/schedule/sync"].includes(resource)
  )
    throw new HTTPException(409, {
      message: "Structural editing is locked while the event is live",
    });
  return row;
}

app.use("/api/v1/auth/*", rateLimit);
app.use("/api/v1/public/rsvp", rateLimit);
app.use("/api/v1/public/analytics", rateLimit);
app.use("/api/v1/public/events/*", rateLimit);
app.get("/api/v1/health", (c) =>
  c.json({
    ok: true,
    service: "invibox-api",
    environment: c.env.APP_ENV,
    time: nowIso(),
  }),
);
app.post("/api/v1/auth/register", async (c) => {
  const body = await json(
    c.req.raw,
    credentials.extend({ name: z.string().trim().min(2).max(100) }),
  );
  const exists = await c.env.DB.prepare("SELECT id FROM users WHERE email=?")
    .bind(body.email)
    .first();
  if (exists)
    throw new HTTPException(409, {
      message: "An account already exists for this email",
    });
  const id = uid("usr"),
    token = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO users(id,email,password_hash,full_name) VALUES(?,?,?,?)",
    ).bind(id, body.email, await hashPassword(body.password), body.name),
    c.env.DB.prepare(
      "INSERT INTO sessions(id,user_id,token_hash,expires_at,user_agent) VALUES(?,?,?,?,?)",
    ).bind(
      uid("ses"),
      id,
      await sha256(token + (c.env.SESSION_PEPPER || "")),
      expires(),
      c.req.header("user-agent") || null,
    ),
  ]);
  c.header("Set-Cookie", cookie(token));
  return c.json({ user: { id, email: body.email, name: body.name } }, 201);
});
app.post("/api/v1/auth/login", async (c) => {
  const body = await json(c.req.raw, credentials);
  const user = await c.env.DB.prepare(
    "SELECT id,email,password_hash,full_name,auth_version FROM users WHERE email=? AND disabled_at IS NULL",
  )
    .bind(body.email)
    .first<any>();
  if (!user || !(await verifyPassword(body.password, user.password_hash)))
    throw new HTTPException(401, { message: "Invalid email or password" });
  const challenge = await loginChallenge(c, user);
  if (challenge) return challenge;
  const token = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO sessions(id,user_id,token_hash,expires_at,user_agent,auth_version) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      uid("ses"),
      user.id,
      await sha256(token + (c.env.SESSION_PEPPER || "")),
      expires(),
      c.req.header("user-agent") || null,
      user.auth_version,
    )
    .run();
  c.header("Set-Cookie", cookie(token));
  return c.json({
    user: { id: user.id, email: user.email, name: user.full_name },
  });
});
app.post("/api/v1/auth/password/forgot", async (c) => {
  const body = await json(
    c.req.raw,
    z.object({
      email: z
        .string()
        .email()
        .transform((x) => x.toLowerCase()),
    }),
  );
  const user = await c.env.DB.prepare(
    "SELECT id,full_name,email FROM users WHERE email=? AND disabled_at IS NULL",
  )
    .bind(body.email)
    .first<any>();
  let demoToken: string | undefined;
  if (user) {
    const token = randomToken();
    demoToken = c.env.DEMO_MODE === "true" ? token : undefined;
    await c.env.DB.prepare(
      "INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)",
    )
      .bind(
        uid("rst"),
        user.id,
        await sha256(token),
        new Date(Date.now() + 3600000).toISOString(),
      )
      .run();
    try {
      await sendNotification(
        c.env,
        "email",
        { name: user.full_name, email: user.email },
        `Reset your Invibox password using this secure one-hour link: ${c.env.APP_ORIGIN}/app?reset=${encodeURIComponent(token)}`,
        "Reset your Invibox password",
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          code: "PASSWORD_RESET_DELIVERY_FAILED",
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }
  return c.json({
    ok: true,
    message: "If that account exists, a reset link has been sent.",
    ...(demoToken ? { demoToken } : {}),
  });
});
app.post("/api/v1/auth/password/reset", async (c) => {
  const body = await json(
    c.req.raw,
    z.object({
      token: z.string().min(20).max(200),
      password: z.string().min(10).max(128),
    }),
  );
  const tokenHash = await sha256(body.token);
  const record = await c.env.DB.prepare(
    "SELECT id,user_id FROM password_reset_tokens WHERE token_hash=? AND consumed_at IS NULL AND julianday(expires_at) > julianday('now')",
  )
    .bind(tokenHash)
    .first<any>();
  if (!record)
    throw new HTTPException(400, {
      message: "Reset link is invalid or expired",
    });
  const claim = uid("claim");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO password_reset_claims(id,token_hash) VALUES(?,?)",
    ).bind(claim, tokenHash),
    c.env.DB.prepare(
      "UPDATE users SET password_hash=?,auth_version=auth_version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND EXISTS(SELECT 1 FROM password_reset_tokens WHERE token_hash=? AND consumed_at IS NULL AND julianday(expires_at)>julianday('now'))",
    ).bind(await hashPassword(body.password), record.user_id, tokenHash),
    c.env.DB.prepare(
      "UPDATE password_reset_tokens SET consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND consumed_at IS NULL",
    ).bind(record.user_id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(
      record.user_id,
    ),
    c.env.DB.prepare("DELETE FROM password_reset_claims WHERE id=?").bind(
      claim,
    ),
  ]);
  return c.json({ ok: true });
});
app.post("/api/v1/auth/logout", authenticate, async (c) => {
  const raw = getCookie(c.req.header("cookie"), "invibox_session")!;
  await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
    .bind(await sha256(raw + (c.env.SESSION_PEPPER || "")))
    .run();
  c.header("Set-Cookie", clearCookie());
  return c.json({ ok: true });
});
app.get("/api/v1/auth/me", authenticate, async (c) => {
  const user = await c.env.DB.prepare(
    "SELECT id,email,full_name AS name,platform_role AS role,email_verified_at AS emailVerifiedAt FROM users WHERE id=?",
  )
    .bind(c.get("userId"))
    .first();
  return c.json({ user });
});

registerAccountRoutes(app, authenticate, rateLimit);
registerMfaRoutes(app, authenticate, rateLimit);
registerGuestMediaRoutes(app, rateLimit);
registerPrivacyRoutes(app, authenticate, rateLimit);
registerCommunicationRoutes(app, rateLimit);

app.post("/api/v1/demo/bootstrap", async (c) => {
  if (c.env.APP_ENV !== "development" || c.env.DEMO_MODE !== "true")
    throw new HTTPException(404);
  const email = "demo@invibox.app";
  let user = await c.env.DB.prepare(
    "SELECT id,email,full_name FROM users WHERE email=?",
  )
    .bind(email)
    .first<any>();
  if (!user) {
    const id = uid("usr");
    await c.env.DB.prepare(
      "INSERT INTO users(id,email,password_hash,full_name,email_verified_at) VALUES(?,?,?,?,?)",
    )
      .bind(
        id,
        email,
        await hashPassword(randomToken()),
        "Amaka Okafor",
        nowIso(),
      )
      .run();
    user = { id, email, full_name: "Amaka Okafor" };
  }
  let event = await c.env.DB.prepare(
    "SELECT id FROM events WHERE owner_id=? AND slug=?",
  )
    .bind(user.id, "amaka-chidi")
    .first<any>();
  let guestToken = "kemi-demo-invitation-token-2026";
  if (!event) {
    const eventId = uid("evt"),
      groupId = uid("grp"),
      occasionIds = [uid("occ"), uid("occ"), uid("occ")];
    event = { id: eventId };
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO events(id,owner_id,slug,title,event_type,lifecycle,starts_at,timezone,location,visibility,published_at,settings_json,theme_json) VALUES(?,?,?,?,?,'published',?,?,?,?,?,?,?)",
      ).bind(
        eventId,
        user.id,
        "amaka-chidi",
        "Amaka & Chidi",
        "wedding",
        "2026-12-19T10:00:00+01:00",
        "Africa/Lagos",
        "Lagos, Nigeria",
        "guest_specific",
        nowIso(),
        JSON.stringify({
          capabilities: [
            "rsvp",
            "seating",
            "transport",
            "accommodation",
            "gifts",
            "memories",
          ],
        }),
        JSON.stringify({ primary: "#343931", accent: "#9b7450" }),
      ),
      c.env.DB.prepare(
        "INSERT INTO event_members(event_id,user_id,role) VALUES(?,?,'owner')",
      ).bind(eventId, user.id),
      c.env.DB.prepare(
        "INSERT INTO guest_groups(id,event_id,name,kind) VALUES(?,?,?,?)",
      ).bind(groupId, eventId, "Friends", "friends"),
      ...[
        [
          "Traditional ceremony",
          "2026-12-19T10:00:00+01:00",
          "The Monarch Hall, Lekki",
          "Family & VIP",
        ],
        [
          "White wedding",
          "2026-12-19T13:30:00+01:00",
          "Grace Pavilion, Victoria Island",
          "All guests",
        ],
        [
          "Reception & dinner",
          "2026-12-19T17:00:00+01:00",
          "The Grand Ballroom",
          "All guests",
        ],
      ].map((x, i) =>
        c.env.DB.prepare(
          "INSERT INTO occasions(id,event_id,title,starts_at,venue_name,address,audience,sort_order) VALUES(?,?,?,?,?,?,?,?)",
        ).bind(occasionIds[i], eventId, x[0], x[1], x[2], x[2], x[3], i),
      ),
    ]);
    await c.env.DB.batch(
      ["T01", "T02", "T04", "T08", "T12"].map((name) =>
        c.env.DB.prepare(
          "INSERT INTO seating_tables(id,event_id,name,capacity,x,y) VALUES(?,?,?,?,?,?)",
        ).bind(uid("tbl"), eventId, name, 10, 50, 50),
      ),
    );
    const guestRows = [
      ["Kemi Adeyemi", "attending", 2, "Jollof & chicken", "T12", 1],
      ["Tunde Okafor", "attending", 1, "Vegetarian", "T04", 0],
      ["Nneka & Emeka Obi", "pending", 2, null, null, 0],
      ["Ibrahim Bello", "declined", 1, null, null, 0],
      ["The Afolabi Family", "attending", 5, "Mixed", "T01", 0],
      ["Damilola George", "pending", 1, null, null, 0],
      ["Chisom Nwosu", "attending", 2, "Jollof & fish", "T08", 1],
      ["Aunty Bola", "attending", 3, "Mixed", "T02", 0],
    ];
    const statements = [];
    for (let i = 0; i < guestRows.length; i++) {
      const x = guestRows[i],
        gid = uid("gst"),
        token = i === 0 ? guestToken : randomToken();
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO guests(id,event_id,group_id,name,status,party_size,meal,table_name,checked_in_at,access_token_hash,access_token_hint) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          gid,
          eventId,
          groupId,
          x[0],
          x[1],
          x[2],
          x[3],
          x[4],
          x[5] ? nowIso() : null,
          await sha256(token),
          token.slice(-6),
        ),
      );
      for (const oid of occasionIds)
        statements.push(
          c.env.DB.prepare(
            "INSERT INTO guest_occasion_access(guest_id,occasion_id,rsvp_status) VALUES(?,?,?)",
          ).bind(
            gid,
            oid,
            x[1] === "attending"
              ? "attending"
              : x[1] === "declined"
                ? "declined"
                : "pending",
          ),
        );
    }
    await c.env.DB.batch(statements);
    await c.env.DB.batch(
      [
        ["Venue & catering", 700000000, 580000000],
        ["Decor & florals", 250000000, 210000000],
        ["Photo & video", 180000000, 145000000],
      ].map((x) =>
        c.env.DB.prepare(
          "INSERT INTO budgets(id,event_id,category,budget_minor,spent_minor) VALUES(?,?,?,?,?)",
        ).bind(uid("bdg"), eventId, x[0], x[1], x[2]),
      ),
    );
  }
  const tableCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM seating_tables WHERE event_id=?",
  )
    .bind(event.id)
    .first<{ count: number }>();
  if (!tableCount?.count) {
    await c.env.DB.batch(
      [
        ["T01", "round", 10, 18, 22],
        ["T02", "round", 10, 48, 18],
        ["T04", "round", 10, 76, 25],
        ["T08", "round", 8, 25, 67],
        ["T12", "round", 10, 67, 65],
      ].map((t) =>
        c.env.DB.prepare(
          "INSERT INTO seating_tables(id,event_id,name,shape,capacity,x,y) VALUES(?,?,?,?,?,?,?)",
        ).bind(uid("tbl"), event.id, ...t),
      ),
    );
  }
  const token = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO sessions(id,user_id,token_hash,expires_at,user_agent) VALUES(?,?,?,?,?)",
  )
    .bind(
      uid("ses"),
      user.id,
      await sha256(token + (c.env.SESSION_PEPPER || "")),
      expires(),
      c.req.header("user-agent") || null,
    )
    .run();
  c.header("Set-Cookie", cookie(token));
  return c.json({
    ok: true,
    eventId: event.id,
    slug: "amaka-chidi",
    guestToken,
  });
});

app.get("/api/v1/events", authenticate, async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT DISTINCT e.id,e.slug,e.title,e.event_type,e.lifecycle,e.starts_at,e.location FROM events e LEFT JOIN event_members m ON m.event_id=e.id WHERE e.owner_id=? OR m.user_id=? ORDER BY e.updated_at DESC",
  )
    .bind(c.get("userId"), c.get("userId"))
    .all();
  return c.json({ events: rows.results });
});
app.post("/api/v1/events", authenticate, async (c) => {
  const body = await json(
    c.req.raw,
    z.object({
      title: z.string().trim().min(2).max(140),
      eventType: z.string().trim().min(2).max(50),
      date: z.string().date(),
      location: z.string().trim().min(2).max(180),
      timezone: z
        .string()
        .max(80)
        .refine(validTimezone, "Invalid IANA timezone")
        .default("Africa/Lagos"),
    }),
  );
  const base =
    body.title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "event";
  let slug = base,
    n = 1;
  while (
    await c.env.DB.prepare("SELECT id FROM events WHERE slug=?")
      .bind(slug)
      .first()
  )
    slug = `${base}-${++n}`;
  const id = uid("evt");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO events(id,owner_id,slug,title,event_type,lifecycle,starts_at,timezone,location,visibility) VALUES(?,?,?,?,?,'draft',?,?,?,'guest_specific')",
    ).bind(
      id,
      c.get("userId"),
      slug,
      body.title,
      body.eventType,
      zonedDateTime(body.date, "12:00", body.timezone),
      body.timezone,
      body.location,
    ),
    c.env.DB.prepare(
      "INSERT INTO event_members(event_id,user_id,role) VALUES(?,?,'owner')",
    ).bind(id, c.get("userId")),
  ]);
  await audit(
    c.env.DB,
    id,
    c.get("userId"),
    "event.create",
    "event",
    id,
    c.get("requestId"),
  );
  return c.json(
    { event: { id, slug, title: body.title, lifecycle: "draft" } },
    201,
  );
});
app.use("/api/v1/events/*", authenticate);
app.patch("/api/v1/events/:eventId", async (c) => {
  const id = c.req.param("eventId");
  const authorized = await ownEvent(c, id);
  const body = await json(
    c.req.raw,
    z.object({
      title: z.string().trim().min(2).max(140).optional(),
      eventType: z.string().max(50).optional(),
      lifecycle: z
        .enum([
          "draft",
          "preview",
          "published",
          "active",
          "live",
          "completed",
          "archived",
        ])
        .optional(),
      startsAt: z.string().datetime({ offset: true }).optional(),
      date: z.string().date().optional(),
      timezone: z
        .string()
        .max(80)
        .refine(validTimezone, "Invalid IANA timezone")
        .optional(),
      location: z.string().trim().min(2).max(180).optional(),
      visibility: z.enum(["public", "private", "guest_specific"]).optional(),
      settings: z
        .object({
          guestUploads: z.boolean().optional(),
          guestGallery: z.boolean().optional(),
          capabilities: z
            .array(
              z.enum([
                "occasions",
                "rsvp",
                "seating",
                "gifts",
                "memories",
                "ai",
              ]),
            )
            .max(6)
            .optional(),
          rsvpDeadline: z
            .string()
            .datetime({ offset: true })
            .nullable()
            .optional(),
        })
        .optional(),
      theme: z.record(z.string(), z.unknown()).optional(),
    }),
  );
  if (
    authorized.member_role === "designer" &&
    Object.keys(body).some((key) => !["title", "theme"].includes(key))
  )
    throw new HTTPException(403, {
      message: "Designers may only edit the title and theme",
    });
  if (body.lifecycle) assertTransition(authorized.lifecycle, body.lifecycle);
  if (body.lifecycle === "published") {
    await requireVerified(c);
    const occasion = await c.env.DB.prepare(
      "SELECT id FROM occasions WHERE event_id=? LIMIT 1",
    )
      .bind(id)
      .first();
    if (!occasion)
      throw new HTTPException(422, {
        message: "Add at least one occasion before publishing",
      });
  }
  const current = await c.env.DB.prepare("SELECT * FROM events WHERE id=?")
    .bind(id)
    .first<any>();
  await c.env.DB.prepare(
    "UPDATE events SET title=?,event_type=?,lifecycle=?,starts_at=?,timezone=?,location=?,visibility=?,settings_json=?,theme_json=?,version=version+1,updated_at=CURRENT_TIMESTAMP,published_at=CASE WHEN ? IN ('published','active','live') AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END WHERE id=?",
  )
    .bind(
      body.title ?? current.title,
      body.eventType ?? current.event_type,
      body.lifecycle ?? current.lifecycle,
      body.date
        ? zonedDateTime(body.date, "12:00", body.timezone || current.timezone)
        : (body.startsAt ?? current.starts_at),
      body.timezone ?? current.timezone,
      body.location ?? current.location,
      body.visibility ?? current.visibility,
      body.settings
        ? JSON.stringify({
            ...JSON.parse(current.settings_json),
            ...body.settings,
          })
        : current.settings_json,
      body.theme ? JSON.stringify(body.theme) : current.theme_json,
      body.lifecycle ?? current.lifecycle,
      id,
    )
    .run();
  await audit(
    c.env.DB,
    id,
    c.get("userId"),
    "event.update",
    "event",
    id,
    c.get("requestId"),
    body,
  );
  return c.json({ ok: true });
});
app.get("/api/v1/events/:eventId/snapshot", async (c) => {
  const id = c.req.param("eventId");
  const event = await ownEvent(c, id);
  const [g, o, b, v, s, t, m, a] = await Promise.all([
    c.env.DB.prepare(
      "SELECT g.id,g.name,g.email,g.phone,g.email_opt_in,g.sms_opt_in,g.whatsapp_opt_in,COALESCE(gg.name,'Guests') AS 'group',g.status,g.party_size AS party,COALESCE(g.meal,'—') AS meal,g.table_name AS 'table',g.checked_in_at IS NOT NULL AS checkedIn FROM guests g LEFT JOIN guest_groups gg ON gg.id=g.group_id WHERE g.event_id=? ORDER BY g.created_at",
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      "SELECT id,starts_at,title,venue_name AS place,audience,is_private AS isPrivate FROM occasions WHERE event_id=? ORDER BY sort_order,starts_at",
    )
      .bind(id)
      .all(),
    c.env.DB.prepare("SELECT * FROM budgets WHERE event_id=?").bind(id).all(),
    c.env.DB.prepare("SELECT * FROM vendors WHERE event_id=?").bind(id).all(),
    c.env.DB.prepare(
      "SELECT * FROM experience_sections WHERE event_id=? ORDER BY sort_order",
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      "SELECT st.*,COALESCE(SUM(g.party_size),0) AS assigned FROM seating_tables st LEFT JOIN guests g ON g.event_id=st.event_id AND g.table_name=st.name WHERE st.event_id=? GROUP BY st.id ORDER BY st.name",
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      "SELECT id,guest_id,mime_type,size_bytes,caption,status,share_with_guests,created_at FROM media WHERE event_id=? AND upload_state='ready' ORDER BY created_at DESC",
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      "SELECT type,COUNT(*) AS count FROM analytics_events WHERE event_id=? GROUP BY type",
    )
      .bind(id)
      .all(),
  ]);
  return c.json({
    event,
    guests: (event.member_role === "designer" ? [] : g.results).map(
      (x: any) => ({
        ...x,
        ...(event.member_role === "checkin_staff"
          ? { email: undefined, phone: undefined, meal: undefined }
          : {}),
        checkedIn: Boolean(x.checkedIn),
        status: x.status[0].toUpperCase() + x.status.slice(1),
        initials: x.name
          .split(" ")
          .slice(0, 2)
          .map((n: string) => n[0])
          .join("")
          .toUpperCase(),
      }),
    ),
    schedule: o.results.map((row: any) => ({
      ...row,
      ...localDateTime(row.starts_at, event.timezone),
      isPrivate: Boolean(row.isPrivate),
    })),
    budgets: ["owner", "admin"].includes(event.member_role) ? b.results : [],
    vendors: ["owner", "admin"].includes(event.member_role) ? v.results : [],
    sections: event.member_role === "checkin_staff" ? [] : s.results,
    seating: t.results,
    media: event.member_role === "checkin_staff" ? [] : m.results,
    analytics: Object.fromEntries(
      a.results.map((row: any) => [row.type, row.count]),
    ),
  });
});
app.post("/api/v1/events/:eventId/guests", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const body = await json(
    c.req.raw,
    guestSchema.omit({ id: true, checkedIn: true, table: true }),
  );
  let group = await c.env.DB.prepare(
    "SELECT id FROM guest_groups WHERE event_id=? AND name=?",
  )
    .bind(id, body.group)
    .first<any>();
  if (!group) {
    group = { id: uid("grp") };
    await c.env.DB.prepare(
      "INSERT INTO guest_groups(id,event_id,name) VALUES(?,?,?)",
    )
      .bind(group.id, id, body.group)
      .run();
  }
  const guestId = uid("gst"),
    token = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO guests(id,event_id,group_id,name,status,party_size,meal,email,phone,access_token_hash,access_token_hint) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      guestId,
      id,
      group.id,
      body.name,
      body.status.toLowerCase(),
      body.party,
      body.meal === "—" ? null : body.meal,
      body.email || null,
      body.phone || null,
      await sha256(token),
      token.slice(-6),
    )
    .run();
  const occasions = await c.env.DB.prepare(
    "SELECT id FROM occasions WHERE event_id=? AND is_private=0",
  )
    .bind(id)
    .all<any>();
  if (occasions.results.length)
    await c.env.DB.batch(
      occasions.results.map((o) =>
        c.env.DB.prepare(
          "INSERT INTO guest_occasion_access(guest_id,occasion_id) VALUES(?,?)",
        ).bind(guestId, o.id),
      ),
    );
  await audit(
    c.env.DB,
    id,
    c.get("userId"),
    "guest.create",
    "guest",
    guestId,
    c.get("requestId"),
  );
  return c.json(
    { guest: { id: guestId, ...body, checkedIn: false }, token },
    201,
  );
});
function syncGuard(c: any, id: string, collection: string) {
  const value = c.req.header("If-Match");
  if (!value || !/^\d+$/.test(value))
    throw new HTTPException(428, {
      message: "A snapshot version (If-Match) is required",
    });
  return c.env.DB.prepare(
    "INSERT INTO sync_guards(id,event_id,collection,expected_version) VALUES(?,?,?,?)",
  ).bind(uid("lock"), id, collection, Number(value));
}
async function commitSync(
  c: any,
  id: string,
  collection: "guests" | "schedule" | "sections",
  statements: D1PreparedStatement[],
) {
  statements.push(
    c.env.DB.prepare(
      `SELECT ${collection}_version AS version FROM events WHERE id=?`,
    ).bind(id),
  );
  const results = await c.env.DB.batch(statements);
  return c.json({
    ok: true,
    version: results[results.length - 1].results[0].version,
  });
}
app.put("/api/v1/events/:eventId/guests/sync", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const body = await json(
    c.req.raw,
    z.object({ guests: z.array(guestSchema).max(5000) }),
  );
  const existingGuests = await c.env.DB.prepare(
    "SELECT id FROM guests WHERE event_id=?",
  )
    .bind(id)
    .all<any>();
  const existingGuestIds = new Set(existingGuests.results.map((x) => x.id));
  const added: string[] = [];
  const groupCache = new Map<string, string>();
  const stmts = [syncGuard(c, id, "guests")];
  const keep = [];
  for (const g of body.guests) {
    const gid = g.id
      ? g.id.startsWith("gst_")
        ? g.id
        : `gst_local_${id}_${g.id}`
      : uid("gst");
    keep.push(gid);
    if (!existingGuestIds.has(gid)) added.push(gid);
    let groupId = groupCache.get(g.group);
    if (!groupId) {
      const existing = await c.env.DB.prepare(
        "SELECT id FROM guest_groups WHERE event_id=? AND name=?",
      )
        .bind(id, g.group)
        .first<any>();
      groupId = existing?.id || uid("grp");
      groupCache.set(g.group, groupId!);
      if (!existing)
        stmts.push(
          c.env.DB.prepare(
            "INSERT INTO guest_groups(id,event_id,name) VALUES(?,?,?)",
          ).bind(groupId!, id, g.group),
        );
    }
    stmts.push(
      c.env.DB.prepare(
        "INSERT INTO guests(id,event_id,group_id,name,status,party_size,meal,email,phone) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET group_id=excluded.group_id,name=excluded.name,party_size=excluded.party_size,email=excluded.email,phone=excluded.phone,updated_at=CURRENT_TIMESTAMP WHERE guests.event_id=excluded.event_id",
      ).bind(
        gid,
        id,
        groupId,
        g.name,
        g.status.toLowerCase(),
        g.party,
        g.meal === "—" ? null : g.meal,
        g.email || null,
        g.phone || null,
      ),
    );
  }
  if (new Set(keep).size !== keep.length)
    throw new HTTPException(422, { message: "Duplicate guest IDs" });
  stmts.push(
    c.env.DB.prepare(
      "DELETE FROM guests WHERE event_id=? AND id NOT IN (SELECT value FROM json_each(?))",
    ).bind(id, JSON.stringify(keep)),
  );
  stmts.push(
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO guest_occasion_access(guest_id,occasion_id) SELECT g.id,o.id FROM guests g JOIN occasions o ON o.event_id=g.event_id WHERE g.event_id=? AND o.is_private=0 AND g.id IN (SELECT value FROM json_each(?))",
    ).bind(id, JSON.stringify(added)),
  );
  stmts.push(
    c.env.DB.prepare("DELETE FROM sync_guards WHERE event_id=?").bind(id),
  );
  const response = await commitSync(c, id, "guests", stmts);
  await audit(
    c.env.DB,
    id,
    c.get("userId"),
    "guests.sync",
    "guest",
    null,
    c.get("requestId"),
    { count: keep.length },
  );
  return response;
});
app.put("/api/v1/events/:eventId/sections/sync", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const body = await json(
    c.req.raw,
    z.object({
      sections: z
        .array(
          z.object({
            title: z.string().trim().min(1).max(100),
            type: z.string().max(50).default("custom"),
            content: z.record(z.string(), z.unknown()).default({}),
            visible: z.boolean().default(true),
          }),
        )
        .max(50),
    }),
  );
  const statements = [
    syncGuard(c, id, "sections"),
    c.env.DB.prepare("DELETE FROM experience_sections WHERE event_id=?").bind(
      id,
    ),
    ...body.sections.map((s, i) =>
      c.env.DB.prepare(
        "INSERT INTO experience_sections(id,event_id,type,title,content_json,sort_order,is_visible) VALUES(?,?,?,?,?,?,?)",
      ).bind(
        uid("sec"),
        id,
        s.type,
        s.title,
        JSON.stringify(s.content),
        i,
        s.visible ? 1 : 0,
      ),
    ),
  ];
  statements.push(
    c.env.DB.prepare("DELETE FROM sync_guards WHERE event_id=?").bind(id),
  );
  return commitSync(c, id, "sections", statements);
});
app.put("/api/v1/events/:eventId/schedule/sync", async (c) => {
  const id = c.req.param("eventId");
  const event = await ownEvent(c, id);
  const body = await json(
    c.req.raw,
    z.object({ schedule: z.array(scheduleSchema).max(100) }),
  );
  const previous = await c.env.DB.prepare(
    "SELECT id,is_private FROM occasions WHERE event_id=?",
  )
    .bind(id)
    .all<any>();
  const grant: string[] = [];
  const keep: string[] = [],
    stmts = [syncGuard(c, id, "schedule")];
  for (let i = 0; i < body.schedule.length; i++) {
    const s = body.schedule[i],
      sid = s.id
        ? s.id.startsWith("occ_")
          ? s.id
          : `occ_local_${id}_${s.id}`
        : uid("occ");
    keep.push(sid);
    const old = previous.results.find((o) => o.id === sid);
    if (!s.isPrivate && (!old || old.is_private)) grant.push(sid);
    if (s.isPrivate && old && !old.is_private)
      stmts.push(
        c.env.DB.prepare(
          "DELETE FROM guest_occasion_access WHERE occasion_id=?",
        ).bind(sid),
      );
    stmts.push(
      c.env.DB.prepare(
        "INSERT INTO occasions(id,event_id,title,starts_at,venue_name,address,audience,sort_order,is_private) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,starts_at=excluded.starts_at,venue_name=excluded.venue_name,address=excluded.address,audience=excluded.audience,sort_order=excluded.sort_order,is_private=excluded.is_private WHERE occasions.event_id=excluded.event_id",
      ).bind(
        sid,
        id,
        s.title,
        zonedDateTime(
          s.date || localDateTime(event.starts_at, event.timezone).date,
          s.time,
          event.timezone,
        ),
        s.place,
        s.place,
        s.audience,
        i,
        s.isPrivate ? 1 : 0,
      ),
    );
  }
  if (new Set(keep).size !== keep.length)
    throw new HTTPException(422, { message: "Duplicate occasion IDs" });
  stmts.push(
    c.env.DB.prepare(
      "DELETE FROM occasions WHERE event_id=? AND id NOT IN (SELECT value FROM json_each(?))",
    ).bind(id, JSON.stringify(keep)),
  );
  stmts.push(
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO guest_occasion_access(guest_id,occasion_id) SELECT g.id,o.id FROM guests g JOIN occasions o ON o.event_id=g.event_id WHERE g.event_id=? AND o.is_private=0 AND o.id IN (SELECT value FROM json_each(?))",
    ).bind(id, JSON.stringify(grant)),
  );
  stmts.push(
    c.env.DB.prepare("DELETE FROM sync_guards WHERE event_id=?").bind(id),
  );
  return commitSync(c, id, "schedule", stmts);
});
app.post("/api/v1/events/:eventId/seating", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const body = await json(
    c.req.raw,
    z.object({
      name: z.string().trim().min(1).max(30),
      shape: z.enum(["round", "rectangle", "head"]).default("round"),
      capacity: z.number().int().min(1).max(100),
      x: z.number().min(0).max(100).default(50),
      y: z.number().min(0).max(100).default(50),
    }),
  );
  const rowId = uid("tbl");
  try {
    await c.env.DB.prepare(
      "INSERT INTO seating_tables(id,event_id,name,shape,capacity,x,y) VALUES(?,?,?,?,?,?,?)",
    )
      .bind(rowId, id, body.name, body.shape, body.capacity, body.x, body.y)
      .run();
  } catch {
    throw new HTTPException(409, {
      message: "A table with this name already exists",
    });
  }
  return c.json({ id: rowId }, 201);
});
app.delete("/api/v1/events/:eventId/seating/:tableId", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const table = await c.env.DB.prepare(
    "SELECT name FROM seating_tables WHERE id=? AND event_id=?",
  )
    .bind(c.req.param("tableId"), id)
    .first<any>();
  if (!table) throw new HTTPException(404, { message: "Table not found" });
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE guests SET table_name=NULL WHERE event_id=? AND table_name=?",
    ).bind(id, table.name),
    c.env.DB.prepare(
      "DELETE FROM seating_tables WHERE id=? AND event_id=?",
    ).bind(c.req.param("tableId"), id),
  ]);
  return c.body(null, 204);
});
app.patch("/api/v1/events/:eventId/guests/:guestId/seat", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const body = await json(
    c.req.raw,
    z.object({ table: z.string().max(30).nullable() }),
  );
  if (body.table) {
    const guest = await c.env.DB.prepare(
      "SELECT party_size FROM guests WHERE id=? AND event_id=?",
    )
      .bind(c.req.param("guestId"), id)
      .first<any>();
    if (!guest) throw new HTTPException(404, { message: "Guest not found" });
    const table = await c.env.DB.prepare(
      "SELECT capacity,(SELECT COALESCE(SUM(party_size),0) FROM guests WHERE event_id=? AND table_name=? AND id<>?) AS assigned FROM seating_tables WHERE event_id=? AND name=?",
    )
      .bind(id, body.table, c.req.param("guestId"), id, body.table)
      .first<any>();
    if (!table) throw new HTTPException(404, { message: "Table not found" });
    if (
      Number(table.assigned) + Number(guest.party_size) >
      Number(table.capacity)
    )
      throw new HTTPException(409, {
        message: "This party would exceed the table capacity",
      });
  }
  const result = await c.env.DB.prepare(
    "UPDATE guests SET table_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND event_id=?",
  )
    .bind(body.table, c.req.param("guestId"), id)
    .run();
  if (!result.meta.changes)
    throw new HTTPException(404, { message: "Guest not found" });
  return c.json({ ok: true });
});
app.post("/api/v1/events/:eventId/budgets", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const body = await json(
    c.req.raw,
    z.object({
      category: z.string().trim().min(2).max(100),
      budget: z.number().nonnegative().max(100000000000),
      spent: z.number().nonnegative().max(100000000000).default(0),
      currency: z.string().length(3).default("NGN"),
    }),
  );
  if (body.spent > body.budget * 2 && body.budget > 0)
    throw new HTTPException(422, {
      message:
        "Spent amount needs confirmation because it greatly exceeds budget",
    });
  const rowId = uid("bdg");
  await c.env.DB.prepare(
    "INSERT INTO budgets(id,event_id,category,budget_minor,spent_minor,currency) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      rowId,
      id,
      body.category,
      Math.round(body.budget * 100),
      Math.round(body.spent * 100),
      body.currency,
    )
    .run();
  return c.json({ id: rowId }, 201);
});
app.delete("/api/v1/events/:eventId/budgets/:budgetId", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  await c.env.DB.prepare("DELETE FROM budgets WHERE id=? AND event_id=?")
    .bind(c.req.param("budgetId"), id)
    .run();
  return c.body(null, 204);
});
app.post("/api/v1/events/:eventId/vendors", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const body = await json(
    c.req.raw,
    z.object({
      name: z.string().trim().min(2).max(140),
      category: z.string().trim().min(2).max(100),
      email: z.string().email().optional().or(z.literal("")),
      phone: z.string().max(40).optional(),
      amount: z.number().nonnegative().max(100000000000).default(0),
      status: z.enum(["due", "part_paid", "paid"]).default("due"),
    }),
  );
  const rowId = uid("vnd");
  await c.env.DB.prepare(
    "INSERT INTO vendors(id,event_id,name,category,email,phone,contract_amount_minor,payment_status) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      rowId,
      id,
      body.name,
      body.category,
      body.email || null,
      body.phone || null,
      Math.round(body.amount * 100),
      body.status,
    )
    .run();
  return c.json({ id: rowId }, 201);
});
app.delete("/api/v1/events/:eventId/vendors/:vendorId", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  await c.env.DB.prepare("DELETE FROM vendors WHERE id=? AND event_id=?")
    .bind(c.req.param("vendorId"), id)
    .run();
  return c.body(null, 204);
});
app.get("/api/v1/events/:eventId/integrations/status", async (c) => {
  await ownEvent(c, c.req.param("eventId"));
  return c.json({
    email: Boolean(c.env.RESEND_API_KEY && c.env.EMAIL_FROM),
    whatsapp: Boolean(
      c.env.WHATSAPP_ACCESS_TOKEN && c.env.WHATSAPP_PHONE_NUMBER_ID,
    ),
    sms: Boolean(
      c.env.TWILIO_ACCOUNT_SID &&
        c.env.TWILIO_AUTH_TOKEN &&
        c.env.TWILIO_FROM_NUMBER,
    ),
    payments: Boolean(c.env.PAYSTACK_SECRET_KEY),
    ai: Boolean(c.env.AI_API_KEY),
    storage: true,
    database: true,
    queue: true,
  });
});
app.post("/api/v1/events/:eventId/team-invitations", async (c) => {
  await requireVerified(c);
  const id = c.req.param("eventId");
  const event = (await ownEvent(c, id)) as any;
  const body = await json(
    c.req.raw,
    z.object({
      email: z
        .string()
        .email()
        .transform((x) => x.toLowerCase()),
      role: z.enum([
        "admin",
        "designer",
        "guest_manager",
        "checkin_staff",
        "viewer",
      ]),
    }),
  );
  const token = randomToken(),
    inviteId = uid("tin"),
    expiry = new Date(Date.now() + 7 * 86400000).toISOString();
  await c.env.DB.prepare(
    "INSERT INTO team_invitations(id,event_id,email,role,token_hash,invited_by,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_id,email) DO UPDATE SET role=excluded.role,token_hash=excluded.token_hash,invited_by=excluded.invited_by,expires_at=excluded.expires_at,accepted_at=NULL",
  )
    .bind(
      inviteId,
      id,
      body.email,
      body.role,
      await sha256(token),
      c.get("userId"),
      expiry,
    )
    .run();
  let delivered = true;
  try {
    await sendNotification(
      c.env,
      "email",
      { name: body.email.split("@")[0], email: body.email },
      `You have been invited to collaborate on ${event.title}. Accept here: ${c.env.APP_ORIGIN}/app?team_invite=${encodeURIComponent(token)}`,
      `Join ${event.title} on Invibox`,
    );
  } catch (error) {
    if (!(error instanceof ProviderConfigurationError)) throw error;
    delivered = false;
  }
  return c.json(
    {
      ok: true,
      delivered,
      ...(c.env.DEMO_MODE === "true" ? { demoToken: token } : {}),
    },
    201,
  );
});
app.post("/api/v1/team-invitations/accept", authenticate, async (c) => {
  const body = await json(
    c.req.raw,
    z.object({ token: z.string().min(20).max(200) }),
  );
  const invitation = await c.env.DB.prepare(
    "SELECT ti.*,u.email AS user_email FROM team_invitations ti JOIN users u ON u.id=? WHERE ti.token_hash=? AND ti.accepted_at IS NULL AND julianday(ti.expires_at) > julianday('now')",
  )
    .bind(c.get("userId"), await sha256(body.token))
    .first<any>();
  if (
    !invitation ||
    invitation.email.toLowerCase() !== invitation.user_email.toLowerCase()
  )
    throw new HTTPException(403, {
      message: "Invitation is invalid, expired, or belongs to another account",
    });
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO event_members(event_id,user_id,role) SELECT event_id,?,role FROM team_invitations WHERE id=? AND token_hash=? AND accepted_at IS NULL AND julianday(expires_at)>julianday('now') ON CONFLICT(event_id,user_id) DO UPDATE SET role=excluded.role WHERE event_members.role<>'owner'",
    ).bind(c.get("userId"), invitation.id, await sha256(body.token)),
    c.env.DB.prepare(
      "UPDATE team_invitations SET accepted_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(invitation.id),
  ]);
  return c.json({ ok: true, eventId: invitation.event_id });
});
app.get("/api/v1/events/:eventId/team", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const members = await c.env.DB.prepare(
    "SELECT u.id,u.full_name AS name,u.email,m.role FROM event_members m JOIN users u ON u.id=m.user_id WHERE m.event_id=?",
  )
    .bind(id)
    .all();
  const invitations = await c.env.DB.prepare(
    "SELECT id,email,role,expires_at FROM team_invitations WHERE event_id=? AND accepted_at IS NULL AND julianday(expires_at)>julianday('now')",
  )
    .bind(id)
    .all();
  return c.json({ members: members.results, invitations: invitations.results });
});
app.delete("/api/v1/events/:eventId/team/:userId", async (c) => {
  const id = c.req.param("eventId"),
    target = c.req.param("userId");
  const event = await ownEvent(c, id);
  if (target === event.owner_id)
    throw new HTTPException(409, {
      message: "The event owner cannot be removed",
    });
  if (event.member_role !== "owner")
    throw new HTTPException(403, {
      message: "Only the owner may remove collaborators",
    });
  await c.env.DB.prepare(
    "DELETE FROM event_members WHERE event_id=? AND user_id=?",
  )
    .bind(id, target)
    .run();
  await audit(
    c.env.DB,
    id,
    c.get("userId"),
    "team.remove",
    "user",
    target,
    c.get("requestId"),
  );
  return c.body(null, 204);
});
app.delete(
  "/api/v1/events/:eventId/team-invitations/:invitationId",
  async (c) => {
    const id = c.req.param("eventId");
    await ownEvent(c, id);
    await c.env.DB.prepare(
      "DELETE FROM team_invitations WHERE id=? AND event_id=? AND accepted_at IS NULL",
    )
      .bind(c.req.param("invitationId"), id)
      .run();
    return c.body(null, 204);
  },
);
app.get("/api/v1/events/:eventId/audit", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const rows = await c.env.DB.prepare(
    "SELECT action,entity_type,entity_id,actor_id,created_at,request_id FROM audit_logs WHERE event_id=? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(id)
    .all();
  return c.json({ entries: rows.results });
});
app.get("/api/v1/events/:eventId/consents", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const rows = await c.env.DB.prepare(
    "SELECT id,guest_id,email_opt_in,sms_opt_in,whatsapp_opt_in,source,policy_version,created_at FROM communication_consents WHERE event_id=? ORDER BY id DESC LIMIT 100",
  )
    .bind(id)
    .all();
  return c.json({ entries: rows.results });
});
app.post("/api/v1/events/:eventId/guests/:guestId/token", async (c) => {
  const id = c.req.param("eventId");
  const event = await ownEvent(c, id);
  const token = randomToken();
  const result = await c.env.DB.prepare(
    "UPDATE guests SET access_token_hash=?,access_token_hint=? WHERE id=? AND event_id=?",
  )
    .bind(await sha256(token), token.slice(-6), c.req.param("guestId"), id)
    .run();
  if (!result.meta.changes)
    throw new HTTPException(404, { message: "Guest not found" });
  await audit(
    c.env.DB,
    id,
    c.get("userId"),
    "guest.token.rotate",
    "guest",
    c.req.param("guestId"),
    c.get("requestId"),
  );
  return c.json({
    token,
    url: `${c.env.APP_ORIGIN}/invite/${event.slug}?token=${encodeURIComponent(token)}`,
  });
});
app.get("/api/v1/events/:eventId/guests/:guestId/access", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const guest = await c.env.DB.prepare(
    "SELECT id FROM guests WHERE id=? AND event_id=?",
  )
    .bind(c.req.param("guestId"), id)
    .first();
  if (!guest) throw new HTTPException(404, { message: "Guest not found" });
  const rows = await c.env.DB.prepare(
    "SELECT occasion_id FROM guest_occasion_access WHERE guest_id=?",
  )
    .bind(guest.id)
    .all<any>();
  return c.json({ occasionIds: rows.results.map((x) => x.occasion_id) });
});
app.put("/api/v1/events/:eventId/guests/:guestId/access", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const body = await json(
    c.req.raw,
    z.object({ occasionIds: z.array(z.string()).max(100) }),
  );
  const guest = await c.env.DB.prepare(
    "SELECT id FROM guests WHERE id=? AND event_id=?",
  )
    .bind(c.req.param("guestId"), id)
    .first();
  if (!guest) throw new HTTPException(404, { message: "Guest not found" });
  const allowed = await c.env.DB.prepare(
    "SELECT id FROM occasions WHERE event_id=?",
  )
    .bind(id)
    .all<any>();
  if (
    body.occasionIds.some((oid) => !allowed.results.some((o) => o.id === oid))
  )
    throw new HTTPException(422, {
      message: "Occasion does not belong to this event",
    });
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM guest_occasion_access WHERE guest_id=? AND occasion_id NOT IN (SELECT value FROM json_each(?))",
    ).bind(guest.id, JSON.stringify(body.occasionIds)),
    ...[...new Set(body.occasionIds)].map((oid) =>
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO guest_occasion_access(guest_id,occasion_id) VALUES(?,?)",
      ).bind(guest.id, oid),
    ),
  ]);
  return c.json({ ok: true });
});
app.post("/api/v1/events/:eventId/ai/assist", rateLimit, async (c) => {
  await requireVerified(c);
  const id = c.req.param("eventId");
  const event = (await ownEvent(c, id)) as any;
  const body = await json(
    c.req.raw,
    z.object({
      task: z.enum([
        "invitation_copy",
        "schedule",
        "guest_message",
        "faq",
        "design_review",
        "assistant",
      ]),
      prompt: z.string().trim().min(3).max(2000),
    }),
  );
  try {
    const answer = await runAi(c.env, {
      system: `You are Invibox's event copilot. Be culturally respectful, practical and concise. Never invent missing venue, guest or payment facts. Event: ${event.title}; type: ${event.event_type}; date: ${event.starts_at}; location: ${event.location}; timezone: ${event.timezone}. Task: ${body.task}.`,
      prompt: body.prompt,
    });
    return c.json({ answer });
  } catch (error) {
    if (error instanceof ProviderConfigurationError)
      throw new HTTPException(503, {
        message: "AI assistant is not configured for this environment",
      });
    throw error;
  }
});
app.get("/api/v1/events/:eventId/announcements", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const rows = await c.env.DB.prepare(
    "SELECT a.*,SUM(CASE WHEN d.status='sent' THEN 1 ELSE 0 END) AS delivered_count,SUM(CASE WHEN d.status='failed' THEN 1 ELSE 0 END) AS failed_count,SUM(CASE WHEN d.status='skipped' THEN 1 ELSE 0 END) AS skipped_count FROM announcements a LEFT JOIN notification_deliveries d ON d.announcement_id=a.id WHERE a.event_id=? GROUP BY a.id ORDER BY a.created_at DESC LIMIT 100",
  )
    .bind(id)
    .all();
  return c.json({ announcements: rows.results });
});
async function dispatchOutbox(env: AppEnv["Bindings"]) {
  const rows = await env.DB.prepare(
    "SELECT id,payload_json FROM notification_outbox WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 25",
  ).all<any>();
  for (const row of rows.results) {
    await env.NOTIFICATIONS.send(JSON.parse(row.payload_json));
    await env.DB.prepare(
      "UPDATE notification_outbox SET dispatched_at=CURRENT_TIMESTAMP WHERE id=?",
    )
      .bind(row.id)
      .run();
  }
}
app.post("/api/v1/events/:eventId/announcements", rateLimit, async (c) => {
  await requireVerified(c);
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const body = await json(c.req.raw, announcementSchema),
    jobId = uid("msg");
  const configured =
    body.channel === "email"
      ? c.env.RESEND_API_KEY && c.env.EMAIL_FROM
      : body.channel === "sms"
        ? c.env.TWILIO_ACCOUNT_SID &&
          c.env.TWILIO_AUTH_TOKEN &&
          c.env.TWILIO_FROM_NUMBER
        : c.env.WHATSAPP_ACCESS_TOKEN && c.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!configured)
    throw new HTTPException(503, {
      message: "Configure this messaging provider before sending",
    });
  const job: NotificationJob = {
    id: jobId,
    eventId: id,
    ...body,
    createdAt: nowIso(),
  };
  const audienceClause =
    body.audience === "pending"
      ? "g.status='pending'"
      : body.audience === "attending"
        ? "g.status='attending'"
        : body.audience === "vip"
          ? "gg.name='VIP'"
          : "1=1";
  const eligible = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM guests g LEFT JOIN guest_groups gg ON gg.id=g.group_id WHERE g.event_id=? AND ${audienceClause} AND g.${body.channel}_opt_in=1`,
  )
    .bind(id)
    .first<{ count: number }>();
  if (!eligible?.count)
    throw new HTTPException(422, {
      message:
        "No guests in this audience have opted in to this channel. Ask guests to update preferences through their invitation.",
    });
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO announcements(id,event_id,created_by,channel,audience,message) VALUES(?,?,?,?,?,?)",
    ).bind(
      jobId,
      id,
      c.get("userId"),
      body.channel,
      body.audience,
      body.message,
    ),
    c.env.DB.prepare(
      "INSERT INTO notification_outbox(id,payload_json) VALUES(?,?)",
    ).bind(jobId, JSON.stringify(job)),
    c.env.DB.prepare(
      `INSERT INTO announcement_recipients(announcement_id,guest_id) SELECT ?,g.id FROM guests g LEFT JOIN guest_groups gg ON gg.id=g.group_id WHERE g.event_id=? AND ${audienceClause} AND g.${body.channel}_opt_in=1`,
    ).bind(jobId, id),
  ]);
  c.executionCtx.waitUntil(
    dispatchOutbox(c.env).catch(() =>
      console.error(JSON.stringify({ code: "OUTBOX_DISPATCH_FAILED", jobId })),
    ),
  );
  return c.json({ ok: true, id: jobId, status: "queued" }, 202);
});
app.post(
  "/api/v1/events/:eventId/announcements/:announcementId/retry",
  rateLimit,
  async (c) => {
    const id = c.req.param("eventId");
    await ownEvent(c, id);
    const row = await c.env.DB.prepare(
      "SELECT * FROM announcements WHERE id=? AND event_id=? AND status='failed'",
    )
      .bind(c.req.param("announcementId"), id)
      .first<any>();
    if (!row)
      throw new HTTPException(409, {
        message: "Only failed announcements can be retried",
      });
    await c.env.DB.batch([
      c.env.DB.prepare(
        "DELETE FROM notification_deliveries WHERE announcement_id=? AND status='failed'",
      ).bind(row.id),
      c.env.DB.prepare(
        "UPDATE announcements SET status='queued' WHERE id=?",
      ).bind(row.id),
      c.env.DB.prepare(
        "UPDATE notification_outbox SET dispatched_at=NULL WHERE id=?",
      ).bind(row.id),
    ]);
    c.executionCtx.waitUntil(
      dispatchOutbox(c.env).catch(() =>
        console.error(
          JSON.stringify({ code: "OUTBOX_DISPATCH_FAILED", jobId: row.id }),
        ),
      ),
    );
    return c.json({ ok: true, status: "queued" }, 202);
  },
);
app.post("/api/v1/events/:eventId/checkin/scan", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const body = await json(
    c.req.raw,
    z.object({ token: z.string().min(20).max(200) }),
  );
  const guest = await c.env.DB.prepare(
    "SELECT id,name,party_size,table_name,checked_in_at FROM guests WHERE event_id=? AND access_token_hash=?",
  )
    .bind(id, await sha256(body.token))
    .first<any>();
  if (!guest)
    throw new HTTPException(404, {
      message: "This pass is not valid for this event",
    });
  const checked = await c.env.DB.prepare(
    "UPDATE guests SET checked_in_at=CURRENT_TIMESTAMP WHERE id=? AND checked_in_at IS NULL",
  )
    .bind(guest.id)
    .run();
  return c.json({
    guest: {
      id: guest.id,
      name: guest.name,
      party: guest.party_size,
      table: guest.table_name,
    },
    alreadyCheckedIn: !checked.meta.changes,
  });
});
app.patch("/api/v1/events/:eventId/guests/:guestId/checkin", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const body = await json(c.req.raw, z.object({ checkedIn: z.boolean() }));
  const result = await c.env.DB.prepare(
    "UPDATE guests SET checked_in_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND event_id=?",
  )
    .bind(body.checkedIn ? nowIso() : null, c.req.param("guestId"), id)
    .run();
  if (!result.meta.changes)
    throw new HTTPException(404, { message: "Guest not found" });
  return c.json({ ok: true, checkedIn: body.checkedIn });
});
app.post("/api/v1/events/:eventId/media", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const form = await c.req.formData(),
    file = form.get("file");
  if (!(file instanceof File))
    throw new HTTPException(400, { message: "File is required" });
  const allowed = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/mp4",
    "audio/mpeg",
  ];
  if (!allowed.includes(file.type) || file.size > 25 * 1024 * 1024)
    throw new HTTPException(415, {
      message: "Unsupported file type or file exceeds 25 MB",
    });
  const signature = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = new TextDecoder().decode(signature);
  const valid =
    file.type === "image/jpeg"
      ? signature[0] === 255 && signature[1] === 216 && signature[2] === 255
      : file.type === "image/png"
        ? signature.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10"
        : file.type === "image/webp"
          ? ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP"
          : file.type === "video/mp4"
            ? ascii.slice(4, 8) === "ftyp"
            : ascii.startsWith("ID3") ||
              (signature[0] === 255 && (signature[1] & 224) === 224);
  if (!valid || !file.size)
    throw new HTTPException(415, {
      message: "File content does not match its media type",
    });
  const key = `events/${id}/${uid("media")}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  await c.env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });
  const mediaId = uid("med");
  try {
    await c.env.DB.prepare(
      "INSERT INTO media(id,event_id,object_key,mime_type,size_bytes,caption) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        mediaId,
        id,
        key,
        file.type,
        file.size,
        String(form.get("caption") || "").slice(0, 500),
      )
      .run();
  } catch (error) {
    await c.env.MEDIA.delete(key);
    throw error;
  }
  return c.json({ id: mediaId, status: "pending" }, 201);
});

app.get("/api/v1/events/:eventId/media/:mediaId/file", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const row = await c.env.DB.prepare(
    "SELECT object_key,mime_type FROM media WHERE id=? AND event_id=?",
  )
    .bind(c.req.param("mediaId"), id)
    .first<any>();
  if (!row) throw new HTTPException(404, { message: "Media not found" });
  const object = await c.env.MEDIA.get(row.object_key);
  if (!object)
    throw new HTTPException(404, { message: "Stored media not found" });
  return new Response(object.body, {
    headers: {
      "Content-Type": row.mime_type,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
app.patch("/api/v1/events/:eventId/media/:mediaId", async (c) => {
  const id = c.req.param("eventId");
  await ownEvent(c, id);
  const body = await json(
    c.req.raw,
    z.object({
      status: z.enum(["pending", "approved", "rejected"]),
      shareWithGuests: z.boolean().optional(),
    }),
  );
  const result = await c.env.DB.prepare(
    "UPDATE media SET status=?,share_with_guests=COALESCE(?,share_with_guests),consent_at=CASE WHEN ?=1 THEN COALESCE(consent_at,CURRENT_TIMESTAMP) ELSE consent_at END WHERE id=? AND event_id=? AND upload_state='ready'",
  )
    .bind(
      body.status,
      body.shareWithGuests === undefined ? null : body.shareWithGuests ? 1 : 0,
      body.shareWithGuests ? 1 : 0,
      c.req.param("mediaId"),
      id,
    )
    .run();
  if (!result.meta.changes)
    throw new HTTPException(404, { message: "Media not found" });
  await audit(
    c.env.DB,
    id,
    c.get("userId"),
    "media.moderate",
    "media",
    c.req.param("mediaId"),
    c.get("requestId"),
    { status: body.status, shareWithGuests: body.shareWithGuests },
  );
  return c.json({ ok: true });
});
app.get("/api/v1/events/:eventId/preview", async (c) => {
  const event = await ownEvent(c, c.req.param("eventId"));
  const occasions = await c.env.DB.prepare(
    "SELECT id,title,starts_at,venue_name,address FROM occasions WHERE event_id=? ORDER BY sort_order",
  )
    .bind(event.id)
    .all();
  const sections = await c.env.DB.prepare(
    "SELECT type,title,content_json FROM experience_sections WHERE event_id=? AND is_visible=1 AND access_rule='all' ORDER BY sort_order",
  )
    .bind(event.id)
    .all();
  return c.json({
    event: {
      id: event.id,
      slug: event.slug,
      title: event.title,
      event_type: event.event_type,
      starts_at: event.starts_at,
      timezone: event.timezone,
      location: event.location,
      settings: JSON.parse(event.settings_json),
    },
    guest: null,
    occasions: occasions.results,
    sections: sections.results,
  });
});
app.get("/api/v1/public/events/:slug", async (c) => {
  const event = await c.env.DB.prepare(
    "SELECT id,slug,title,event_type,starts_at,timezone,location,visibility,theme_json,settings_json FROM events WHERE slug=? AND lifecycle IN ('published','active','live','completed')",
  )
    .bind(c.req.param("slug"))
    .first<any>();
  if (!event) throw new HTTPException(404, { message: "Invitation not found" });
  const token = c.req.query("token");
  let guest = null;
  if (token) {
    guest = await c.env.DB.prepare(
      "SELECT id,name,party_size,status,table_name,email_opt_in,sms_opt_in,whatsapp_opt_in,communication_consent_at FROM guests WHERE event_id=? AND access_token_hash=?",
    )
      .bind(event.id, await sha256(token))
      .first();
  }
  if ((token && !guest) || (event.visibility !== "public" && !guest))
    throw new HTTPException(404, {
      message: "Invitation not found. Use your personalized link.",
    });
  const occasions = guest
    ? await c.env.DB.prepare(
        "SELECT o.id,o.title,o.starts_at,o.venue_name,o.address,a.rsvp_status FROM occasions o JOIN guest_occasion_access a ON a.occasion_id=o.id WHERE a.guest_id=? ORDER BY o.sort_order",
      )
        .bind((guest as any).id)
        .all()
    : await c.env.DB.prepare(
        "SELECT id,title,starts_at,venue_name,address FROM occasions WHERE event_id=? AND is_private=0 ORDER BY sort_order",
      )
        .bind(event.id)
        .all();
  const sections = await c.env.DB.prepare(
    "SELECT type,title,content_json FROM experience_sections WHERE event_id=? AND is_visible=1 AND access_rule='all' ORDER BY sort_order",
  )
    .bind(event.id)
    .all();
  return c.json({
    sections: sections.results,
    event: {
      ...event,
      theme: JSON.parse(event.theme_json),
      settings: JSON.parse(event.settings_json),
    },
    guest,
    occasions: occasions.results,
  });
});
app.post("/api/v1/public/rsvp", async (c) => {
  const body = await json(c.req.raw, rsvpSchema);
  const guest = await c.env.DB.prepare(
    "SELECT g.id,g.party_size,e.lifecycle,e.settings_json FROM guests g JOIN events e ON e.id=g.event_id WHERE g.access_token_hash=?",
  )
    .bind(await sha256(body.token))
    .first<any>();
  if (!guest)
    throw new HTTPException(401, {
      message: "Invitation link is invalid or expired",
    });
  const hash = await sha256(JSON.stringify(body));
  const key = c.req.header("Idempotency-Key") || hash;
  if (key.length > 200)
    throw new HTTPException(422, { message: "Idempotency key is too long" });
  const replay = async () => {
    const prior = await c.env.DB.prepare(
      "SELECT payload_hash FROM rsvp_submissions WHERE guest_id=? AND idempotency_key=?",
    )
      .bind(guest.id, key)
      .first<any>();
    if (prior && prior.payload_hash !== hash)
      throw new HTTPException(409, {
        message: "Idempotency key was already used with a different response",
      });
    return prior;
  };
  if (await replay()) return c.json({ ok: true, replayed: true });
  if (!["published", "active", "live"].includes(guest.lifecycle))
    throw new HTTPException(409, {
      message: "This event is not accepting responses",
    });
  const settings = JSON.parse(guest.settings_json);
  if (settings.rsvpDeadline && Date.parse(settings.rsvpDeadline) < Date.now())
    throw new HTTPException(409, {
      message: "The RSVP deadline has passed. Please contact the organizer.",
    });
  if (body.plusOneName && guest.party_size < 2)
    throw new HTTPException(422, {
      message: "This invitation does not include a plus-one",
    });
  const allowed = await c.env.DB.prepare(
    "SELECT occasion_id FROM guest_occasion_access WHERE guest_id=?",
  )
    .bind(guest.id)
    .all<any>();
  const ids = new Set(allowed.results.map((x) => x.occasion_id));
  if (
    new Set(body.responses.map((x) => x.occasionId)).size !==
    body.responses.length
  )
    throw new HTTPException(422, { message: "Duplicate occasion responses" });
  if (body.responses.some((x) => !ids.has(x.occasionId)))
    throw new HTTPException(403, {
      message: "RSVP contains an occasion not assigned to this guest",
    });
  const stmts = [
    c.env.DB.prepare(
      "INSERT INTO rsvp_submissions(id,guest_id,idempotency_key,payload_hash) VALUES(?,?,?,?)",
    ).bind(uid("rsvp"), guest.id, key, hash),
    ...body.responses.map((r) =>
      c.env.DB.prepare(
        "UPDATE guest_occasion_access SET rsvp_status=?,meal=?,updated_at=CURRENT_TIMESTAMP WHERE guest_id=? AND occasion_id=?",
      ).bind(r.status, r.meal || null, guest.id, r.occasionId),
    ),
    c.env.DB.prepare(
      "UPDATE guests SET status=CASE WHEN EXISTS(SELECT 1 FROM guest_occasion_access WHERE guest_id=? AND rsvp_status='attending') THEN 'attending' WHEN EXISTS(SELECT 1 FROM guest_occasion_access WHERE guest_id=? AND rsvp_status='pending') THEN 'pending' ELSE 'declined' END,dietary_notes=?,plus_one_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(
      guest.id,
      guest.id,
      body.dietaryNotes || null,
      body.plusOneName || null,
      guest.id,
    ),
  ];
  try {
    await c.env.DB.batch(stmts);
  } catch (error) {
    if (await replay()) return c.json({ ok: true, replayed: true });
    throw error;
  }
  return c.json({ ok: true });
});
app.post(
  "/api/v1/public/payments/paystack/initialize",
  rateLimit,
  initializePayment,
);
app.get("/api/v1/public/payments/:reference", rateLimit, async (c) => {
  let payment;
  try {
    payment = await reconcilePayment(c.env, c.req.param("reference"));
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    payment = await c.env.DB.prepare(
      "SELECT reference,purpose,amount_minor,status,paid_at FROM payments WHERE reference=?",
    )
      .bind(c.req.param("reference"))
      .first<any>();
    if (!payment)
      throw new HTTPException(404, { message: "Payment not found" });
  }
  return c.json({
    reference: payment.reference,
    purpose: payment.purpose,
    amount: payment.amount_minor / 100,
    status: payment.status,
    paidAt: payment.paid_at,
  });
});
app.get("/api/v1/events/:eventId/payments", async (c) => {
  const event = await ownEvent(c, c.req.param("eventId"));
  const rows = await c.env.DB.prepare(
    "SELECT reference,purpose,amount_minor,currency,status,initialization_state,paid_at,created_at,last_verified_at FROM payments WHERE event_id=? ORDER BY created_at DESC,id DESC LIMIT 100",
  )
    .bind(event.id)
    .all();
  const totals = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count,COALESCE(SUM(CASE WHEN status='paid' THEN amount_minor ELSE 0 END),0) AS paid_minor FROM payments WHERE event_id=?",
  )
    .bind(event.id)
    .first();
  return c.json({ payments: rows.results, totals });
});
app.post(
  "/api/v1/events/:eventId/payments/:reference/reconcile",
  rateLimit,
  async (c) => {
    const event = await ownEvent(c, c.req.param("eventId"));
    const owned = await c.env.DB.prepare(
      "SELECT id FROM payments WHERE event_id=? AND reference=?",
    )
      .bind(event.id, c.req.param("reference"))
      .first();
    if (!owned) throw new HTTPException(404, { message: "Payment not found" });
    if (!c.env.PAYSTACK_SECRET_KEY)
      throw new HTTPException(503, { message: "Paystack is not configured" });
    try {
      const payment = await reconcilePayment(c.env, c.req.param("reference"));
      return c.json({ status: payment.status });
    } catch {
      throw new HTTPException(502, {
        message:
          "Could not verify with Paystack. The stored payment state has not been marked paid.",
      });
    }
  },
);
app.post("/api/v1/webhooks/paystack", async (c) => {
  if (!c.env.PAYSTACK_SECRET_KEY)
    throw new HTTPException(503, {
      message: "Payment webhook is not configured",
    });
  const raw = await c.req.text(),
    provided = c.req.header("x-paystack-signature") || "",
    expected = await hmacSha512(c.env.PAYSTACK_SECRET_KEY, raw);
  if (!constantTimeEqual(provided, expected))
    throw new HTTPException(401, { message: "Invalid webhook signature" });
  const payload = JSON.parse(raw);
  if (payload.event !== "charge.success")
    return c.json({ ok: true, ignored: true });
  const data = payload.data;
  if (!data || typeof data.reference !== "string" || !data.id)
    throw new HTTPException(422, { message: "Invalid payment payload" });
  const payment = await c.env.DB.prepare(
    "SELECT reference,amount_minor,currency FROM payments WHERE reference=?",
  )
    .bind(data.reference)
    .first<any>();
  if (!payment) return c.json({ ok: true, ignored: true }); // Merchant may serve other applications.
  if (!paymentMatches(payment, data))
    throw new HTTPException(422, {
      message: "Payment amount, currency or status does not match",
    });
  const providerId = `${payload.event}:${data.id}`;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO webhook_events(id,provider,provider_event_id,event_type,payload_hash) VALUES(?,'paystack',?,?,?)",
    ).bind(uid("wh"), providerId, payload.event, await sha256(raw)),
    c.env.DB.prepare(
      "UPDATE payments SET status='paid',paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE reference=? AND amount_minor=? AND currency=? AND status IN ('pending','initialized')",
    ).bind(data.reference, data.amount, data.currency),
  ]);
  if (!results[0].meta.changes) return c.json({ ok: true, replayed: true });
  return c.json({ ok: true });
});
app.post("/api/v1/public/analytics", async (c) => {
  const body = await json(
    c.req.raw,
    z.object({
      eventId: z.string().max(100),
      token: z.string().max(200).optional(),
      type: z.enum(["view", "section_view", "share", "calendar", "direction"]),
      session: z.string().max(100).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  );
  const visible = await c.env.DB.prepare(
    "SELECT id FROM events WHERE id=? AND lifecycle IN ('published','active','live','completed') AND (visibility='public' OR EXISTS(SELECT 1 FROM guests WHERE event_id=events.id AND access_token_hash=?))",
  )
    .bind(body.eventId, await sha256(body.token || ""))
    .first();
  if (!visible) throw new HTTPException(404, { message: "Event not found" });
  await c.env.DB.prepare(
    "INSERT INTO analytics_events(id,event_id,type,session_hash,metadata_json) VALUES(?,?,?,?,?)",
  )
    .bind(
      uid("an"),
      body.eventId,
      body.type,
      body.session ? await sha256(body.session) : null,
      JSON.stringify(body.metadata || {}),
    )
    .run();
  return c.body(null, 204);
});

app.notFound((c) =>
  c.json(
    {
      error: { code: "NOT_FOUND", message: "Route not found" },
      requestId: c.get("requestId"),
    },
    404,
  ),
);
app.onError((err, c) => {
  console.error(
    JSON.stringify({
      level: "error",
      requestId: c.get("requestId"),
      message: err.message,
    }),
  );
  if (err instanceof SyntaxError)
    return c.json(
      {
        error: { code: "INVALID_JSON", message: "Malformed JSON request" },
        requestId: c.get("requestId"),
      },
      400,
    );
  const conflicts: Record<string, string> = {
    guest_media_quota:
      "Guest photo allowance reached (20 photos / 100 MB per guest, 2,000 items / 2 GB per event). Withdraw old photos or contact the organizer.",
    guest_uploads_closed: "Guest uploads are closed for this event.",
    mfa_proof_used:
      "Authenticator code is invalid or already used. Wait for the next code or use an unused recovery code.",
    mfa_challenge_expired:
      "Sign-in challenge expired. Sign in with your password again.",
    archive_required:
      "Archive every affected event before requesting deletion.",
    reset_consumed:
      "This password reset link was already used or expired. Request a new link.",
    financial_retention:
      "Events with payment records cannot be deleted automatically. Archive the event and contact support for a reviewed retention request.",
    account_changed:
      "Account credentials changed. Sign in again before retrying.",
    stale_snapshot:
      "This data changed on the server. Reload before editing again.",
    tenant_conflict: "Record does not belong to this event",
    seat_capacity: "Table is missing or this party exceeds its capacity",
  };
  for (const [code, message] of Object.entries(conflicts))
    if (err.message.includes(code))
      return c.json(
        { error: { code, message }, requestId: c.get("requestId") },
        409,
      );
  if (err instanceof ZodError)
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "The request contains invalid data",
          issues: err.issues,
        },
        requestId: c.get("requestId"),
      },
      422,
    );
  if (err instanceof HTTPException)
    return c.json(
      {
        error: { code: `HTTP_${err.status}`, message: err.message },
        requestId: c.get("requestId"),
      },
      err.status,
    );
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
      requestId: c.get("requestId"),
    },
    500,
  );
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<NotificationJob>, env: AppEnv["Bindings"]) {
    for (const msg of batch.messages) {
      const job = msg.body;
      try {
        const announcement = await env.DB.prepare(
          "SELECT a.*,e.title AS event_title FROM announcements a JOIN events e ON e.id=a.event_id WHERE a.id=? AND a.event_id=?",
        )
          .bind(job.id, job.eventId)
          .first<any>();
        if (!announcement) {
          msg.ack();
          continue;
        }
        await env.DB.prepare(
          "UPDATE announcements SET status='processing' WHERE id=?",
        )
          .bind(job.id)
          .run();
        const recipients = await env.DB.prepare(
          "SELECT g.id,g.name,g.email,g.phone FROM announcement_recipients ar JOIN guests g ON g.id=ar.guest_id WHERE ar.announcement_id=? AND g.event_id=? AND g.id>? ORDER BY g.id LIMIT 25",
        )
          .bind(job.id, job.eventId, job.cursor || "")
          .all<any>();
        let retryNeeded = false;
        for (const recipient of recipients.results) {
          const leaseToken = uid("lease");
          const timestamp = Math.floor(Date.now() / 1000);
          const lease = await env.DB.prepare(
            "INSERT INTO notification_leases(announcement_id,guest_id,lease_token,expires_at) VALUES(?,?,?,?) ON CONFLICT(announcement_id,guest_id) DO UPDATE SET lease_token=excluded.lease_token,expires_at=excluded.expires_at WHERE notification_leases.expires_at<? RETURNING lease_token",
          )
            .bind(job.id, recipient.id, leaseToken, timestamp + 60, timestamp)
            .first();
          if (!lease) {
            retryNeeded = true;
            continue;
          }
          try {
            const prior = await env.DB.prepare(
              "SELECT id,status,attempts,retryable FROM notification_deliveries WHERE announcement_id=? AND guest_id=?",
            )
              .bind(job.id, recipient.id)
              .first<any>();
            if (
              prior &&
              (prior.status === "sent" ||
                !prior.retryable ||
                prior.attempts >= 3)
            )
              continue;
            const preference = await env.DB.prepare(
              `SELECT name,email,phone,${announcement.channel}_opt_in AS allowed FROM guests WHERE id=? AND event_id=?`,
            )
              .bind(recipient.id, job.eventId)
              .first<{
                allowed: number;
                name: string;
                email: string | null;
                phone: string | null;
              }>();
            if (!preference) continue;
            if (!preference.allowed) {
              await env.DB.prepare(
                "INSERT INTO notification_deliveries(id,announcement_id,guest_id,channel,status,error_message) VALUES(?,?,?,?,'skipped','Guest opted out') ON CONFLICT(announcement_id,guest_id) DO UPDATE SET status='skipped',retryable=0,error_message='Guest opted out'",
              )
                .bind(uid("dlv"), job.id, recipient.id, announcement.channel)
                .run();
              continue;
            }
            try {
              const result: any = await sendNotification(
                env,
                job.channel,
                preference,
                await withUnsubscribe(
                  env,
                  recipient.id,
                  announcement.channel,
                  job.message,
                ),
                `Update from ${announcement.event_title}`,
                `${job.id}-${recipient.id}`,
              );
              const providerId = String(
                result?.id || result?.sid || result?.messages?.[0]?.id || "",
              );
              await env.DB.prepare(
                "INSERT INTO notification_deliveries(id,announcement_id,guest_id,channel,status,provider_id) VALUES(?,?,?,?, 'sent',?) ON CONFLICT(announcement_id,guest_id) DO UPDATE SET status='sent',provider_id=excluded.provider_id,error_message=NULL,attempts=attempts+1,retryable=0,attempted_at=CURRENT_TIMESTAMP",
              )
                .bind(
                  uid("dlv"),
                  job.id,
                  recipient.id,
                  job.channel,
                  providerId || null,
                )
                .run();
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Delivery failed";
              const retryable =
                error instanceof ProviderRequestError && error.retryable;
              if (retryable && Number(prior?.attempts || 0) + 1 < 3)
                retryNeeded = true;
              await env.DB.prepare(
                "INSERT INTO notification_deliveries(id,announcement_id,guest_id,channel,status,error_message,retryable) VALUES(?,?,?,?, 'failed',?,?) ON CONFLICT(announcement_id,guest_id) DO UPDATE SET status='failed',error_message=excluded.error_message,retryable=excluded.retryable,attempts=attempts+1,attempted_at=CURRENT_TIMESTAMP",
              )
                .bind(
                  uid("dlv"),
                  job.id,
                  recipient.id,
                  job.channel,
                  message.slice(0, 500),
                  retryable ? 1 : 0,
                )
                .run();
              if (error instanceof ProviderConfigurationError)
                console.warn(
                  JSON.stringify({
                    level: "warn",
                    code: "PROVIDER_NOT_CONFIGURED",
                    jobId: job.id,
                    channel: job.channel,
                  }),
                );
            }
          } finally {
            await env.DB.prepare(
              "DELETE FROM notification_leases WHERE announcement_id=? AND guest_id=? AND lease_token=?",
            )
              .bind(job.id, recipient.id, leaseToken)
              .run();
          }
        }
        if (retryNeeded) {
          msg.retry({ delaySeconds: 30 });
          continue;
        }
        if (recipients.results.length === 25) {
          await env.NOTIFICATIONS.send({
            ...job,
            cursor: recipients.results[recipients.results.length - 1].id,
          });
          msg.ack();
          continue;
        }
        const totals = await env.DB.prepare(
          "SELECT SUM(status='sent') AS sent,SUM(status='failed') AS failed,SUM(status='skipped') AS skipped FROM notification_deliveries WHERE announcement_id=?",
        )
          .bind(job.id)
          .first<any>();
        const status =
          Number(totals?.sent || 0) + Number(totals?.skipped || 0) > 0 &&
          Number(totals?.failed || 0) === 0
            ? "sent"
            : "failed";
        await env.DB.prepare(
          "UPDATE announcements SET status=?,sent_count=? WHERE id=?",
        )
          .bind(status, Number(totals?.sent || 0), job.id)
          .run();
        msg.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            code: "NOTIFICATION_JOB_FAILED",
            jobId: job.id,
            message: error instanceof Error ? error.message : "unknown",
          }),
        );
        msg.retry();
      }
    }
  },
  async scheduled(_event: ScheduledEvent, env: AppEnv["Bindings"]) {
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM mfa_challenges WHERE julianday(expires_at)<=julianday('now')",
      ),
      env.DB.prepare(
        "DELETE FROM mfa_credentials WHERE enabled_at IS NULL AND julianday(pending_expires_at)<=julianday('now')",
      ),
    ]);
    await env.DB.prepare("DELETE FROM mfa_attempts WHERE window_start<?")
      .bind(Math.floor(Date.now() / 300000) - 1)
      .run();
    await cleanAbandonedUploads(env);
    const outcomes = await Promise.allSettled([
      dispatchOutbox(env),
      purgeMedia(env),
    ]);
    for (let i = 0; i < outcomes.length; i++)
      if (outcomes[i].status === "rejected")
        console.error(
          JSON.stringify({
            code: i === 0 ? "OUTBOX_RECOVERY_FAILED" : "MEDIA_ERASURE_FAILED",
          }),
        );
    if (env.PAYSTACK_SECRET_KEY) {
      const pending = await env.DB.prepare(
        "SELECT reference FROM payments WHERE status IN ('pending','initialized') AND created_at>datetime('now','-7 days') AND (last_verified_at IS NULL OR julianday(last_verified_at)<julianday('now','-30 minutes')) ORDER BY COALESCE(last_verified_at,created_at) LIMIT 5",
      ).all<{ reference: string }>();
      for (const row of pending.results)
        try {
          await reconcilePayment(env, row.reference);
        } catch {
          console.warn(
            JSON.stringify({ code: "PAYMENT_RECONCILIATION_UNAVAILABLE" }),
          );
        }
    }
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM email_verifications WHERE julianday(expires_at)<=julianday('now')",
      ),
      env.DB.prepare("DELETE FROM rate_limits WHERE expires_at<?").bind(
        Math.floor(Date.now() / 1000),
      ),
      env.DB.prepare(
        "DELETE FROM analytics_events WHERE occurred_at < datetime('now','-90 days')",
      ),
      env.DB.prepare(
        "DELETE FROM sessions WHERE julianday(expires_at) <= julianday('now')",
      ),
      env.DB.prepare(
        "DELETE FROM password_reset_tokens WHERE julianday(expires_at) <= julianday('now') OR consumed_at IS NOT NULL",
      ),
      env.DB.prepare(
        "DELETE FROM team_invitations WHERE julianday(expires_at) <= julianday('now') AND accepted_at IS NULL",
      ),
    ]);
  },
};
