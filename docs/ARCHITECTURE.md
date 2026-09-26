# Architecture

## Runtime

React/Vite renders public acquisition, the organizer workspace (`/app`) and personalized invitations (`/invite/:slug`). Vercel serves the frontend and proxies `/api` to a Hono Cloudflare Worker. First-party cookies are required: production configuration generates the proxy rather than relying on cross-site cookie behavior.

Cloudflare D1 holds users/sessions, events/members, occasions, guests/access/RSVP, sections, seating, budgets/vendors, media metadata, announcements/outbox/frozen recipients/delivery leases, payments/webhook receipts, analytics/audit and atomic rate counters. R2 holds authenticated media. Queues run delivery jobs. KV remains an optional cache/config binding. Cron recovers outbox dispatch and purges expired sessions/tokens/rate counters plus 90-day analytics.

## Boundaries

- Opaque session tokens are hashed with a server pepper. Passwords use salted PBKDF2-SHA256. SQL expiry comparisons normalize timestamp formats.
- Event membership is checked on every organizer resource; exact role/resource rules and redacted snapshots protect restricted collaborators.
- Guest tokens are high-entropy bearer capabilities stored only as hashes. Private events require them; assigned occasion access controls guest disclosure and RSVP. Organizer preview uses session authorization, never public bypass tokens.
- Origin checks supplement CORS. Mutations accept JSON except authorized media uploads; request sizes are bounded. Atomic D1 counters bound public/auth/provider requests. Production misconfiguration fails closed.
- Database triggers enforce tenant consistency and seating capacity. Queries remain parameterized.

## Write model

Guest, schedule and section replacements require the collection version from a snapshot in `If-Match`. A transactional guard rejects stale versions before writes; row triggers advance versions. The final version is returned in the same batch. Local import IDs are namespaced by event. Replacements/deletions are atomic, including empty collections.

The browser serializes collection writes. Hydration never initiates a write. Save failures are visible; stale data is not automatically replayed. Organizer guest PII is not cached persistently. This is an online-first application, not an offline conflict-resolution implementation.

Guest bulk edits preserve existing RSVP/check-in/table state. Dedicated endpoints handle RSVP, seat assignment, token rotation, occasion access and check-in. RSVP idempotency binds a key to a payload and recomputes status from all occasion responses.

## Delivery and payments

Announcements, frozen recipient IDs and an outbox entry commit together. Dispatch is recoverable by cron. Queue pagination is keyset-based; leases reduce concurrent duplicate sends, and the attempt ledger bounds transient retries. Resend requests carry stable idempotency keys. External SMS/WhatsApp exactly-once delivery is not guaranteed after an ambiguous timeout or crash. Provider acceptance is distinct from delivery/read confirmation.

Paystack checkout is NGN gifting/contributions only. Verification checks reference, amount, currency and status. Signed success-webhook receipts and payment updates commit atomically. Refunds, settlement routing, checkout-initialization idempotency and full reconciliation remain separate product work.

## Lifecycle

Draft/preview can publish after an occasion exists. Published events may activate/go live/complete; live events can only complete. Completed events can archive. Structural editing is locked while live; operational mutations are read-only after completion/archive. See `worker/src/domain.ts` for the actual transition graph and roles.

## Limitations

The workspace still uses a bulk snapshot and a sizeable application component. Large-event pagination, per-operation quotas, durable offline workflows, more granular organization administration and the wider product modules are not implied by the current architecture. See [READINESS.md](READINESS.md).
