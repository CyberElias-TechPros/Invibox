# Architecture

## Product model

Invibox is a multi-tenant universal event experience platform. The stable domain object is the event; invitations, guest experiences and operational tools are projections of structured event data.

```text
User / Organization
  └─ Event (lifecycle + visibility + theme)
      ├─ Team members and roles
      ├─ Occasions
      ├─ Experience sections
      ├─ Groups → Households → Guests
      │                    └─ Occasion access → RSVP
      ├─ Seating
      ├─ Vendors and budgets
      ├─ Communications
      ├─ Media and memories
      ├─ Analytics
      └─ Audit trail
```

## Runtime topology

- **Vercel:** static Vite/React organizer and guest experience.
- **Cloudflare Worker:** Hono API, domain validation, authentication, authorization and orchestration.
- **D1:** normalized relational event and guest data with foreign keys and forward-only migrations.
- **R2:** uploaded event media. The Worker validates MIME type and size before storage.
- **KV:** bounded rate-limit counters and cache/configuration space.
- **Queues:** asynchronous notification jobs with retries.
- **Cron:** expired-session cleanup.
- **Paystack adapter:** optional NGN checkout initialization with signed, replay-safe webhook processing. It returns an explicit unavailable state when no merchant secret is configured.

Durable Objects are intentionally not used yet: current workflows do not require strongly coordinated realtime state. Add them only for multi-station realtime check-in conflict coordination or live-event presence.

## Security boundaries

Organizer routes require an opaque, hashed, HttpOnly session. Event access is ownership or membership-role constrained server-side. Public guest access uses a high-entropy token stored only as SHA-256. RSVP occasion IDs are checked against explicit guest access. RSVP writes are idempotent. Passwords use PBKDF2-SHA256 with 210,000 iterations and unique salts. Responses use security headers, restricted CORS, generic auth errors and request IDs.

## Reliability

The frontend keeps an offline browser cache and synchronizes through debounced API writes. Check-in is optimistic but rolls back on API failure. RSVP requests use idempotency keys. D1 batch operations preserve multi-row RSVP consistency. Queue jobs retry failures. Every API error has a request ID.

## Lifecycle

`draft → preview → published → active → live → completed → archived`

Structural editing should be restricted during `live`; the schema captures lifecycle now and enforcement can be expanded per operation as workflows mature.
