# Architecture

## Runtime

React/Vite renders public acquisition, the organizer workspace (`/app`) and personalized invitations (`/invite/:slug`). Vercel serves the frontend and proxies `/api` to a Hono Cloudflare Worker. First-party cookies are required: production configuration generates the proxy rather than relying on cross-site cookie behavior.

Cloudflare D1 holds users/sessions, events/members, occasions, guests/access/RSVP, sections, seating, budgets/vendors, media metadata, announcements/outbox/frozen recipients/delivery leases, payments/webhook receipts, analytics/audit and atomic rate counters. R2 holds authenticated media. Queues run delivery jobs. KV remains an optional cache/config binding. Cron recovers outbox dispatch, reconciles bounded recent unsettled payments, drains durable media-deletion tasks and purges expired sessions/tokens/rate counters plus 90-day analytics.

## Boundaries

- Opaque session tokens are hashed with a server pepper. Passwords use salted PBKDF2-SHA256. SQL expiry comparisons normalize timestamp formats. User/session authentication versions prevent stale sessions surviving password changes, revoke-others and deactivation; transactional password-hash/reset-token guards protect sensitive account writes.
- Event membership is checked on every organizer resource; exact role/resource rules and redacted snapshots protect restricted collaborators.
- Guest tokens are high-entropy bearer capabilities stored only as hashes. Private events require them; assigned occasion access controls guest disclosure and RSVP. Organizer preview uses session authorization, never public bypass tokens.
- Origin checks supplement CORS. Mutations accept JSON except authorized media uploads; request sizes are bounded. Atomic D1 counters bound public/auth/provider requests. Production misconfiguration fails closed.
- Database triggers enforce tenant consistency and seating capacity. Queries remain parameterized.

## Write model

Guest, schedule and section replacements require the collection version from a snapshot in `If-Match`. A transactional guard rejects stale versions before writes; row triggers advance versions. The final version is returned in the same batch. Local import IDs are namespaced by event. Replacements/deletions are atomic, including empty collections.

The browser serializes collection writes. Hydration never initiates a write. Save failures are visible; stale data is not automatically replayed. Organizer guest PII is not cached persistently. This is an online-first application, not an offline conflict-resolution implementation.

Guest bulk edits preserve existing RSVP/check-in/table state. Dedicated endpoints handle RSVP, seat assignment, token rotation, occasion access and check-in. RSVP idempotency binds a key to a payload and recomputes status from all occasion responses.

## Delivery and payments

Guest channel opt-ins default off and are rechecked at send time. Signed unsubscribe capabilities can only turn off a channel, never reveal the invitation token. Contact changes reset corresponding opt-ins. Announcements, frozen eligible recipient IDs and an outbox entry commit together. Dispatch is recoverable by cron. Queue pagination is keyset-based; leases reduce concurrent duplicate sends, and the attempt ledger bounds transient retries. Resend requests carry stable idempotency keys. External SMS/WhatsApp exactly-once delivery is not guaranteed after an ambiguous timeout or crash. Provider acceptance is distinct from delivery/read confirmation.

Paystack checkout is NGN gifting/contributions only. Verification checks reference, amount, currency and status. Signed success-webhook receipts and payment updates commit atomically. A unique event/idempotency key and payload hash reserve one reference, with an atomic provider-initialization claim. Ambiguous results remain pending for reconciliation instead of creating another charge. The organizer has a ledger and manual reconciliation; cron checks a bounded recent set. Refunds, settlement routing and full accounting remain separate product work.

## Lifecycle

Draft/preview can publish after an occasion exists. Published events may activate/go live/complete; live events can only complete. Completed events can archive. Structural editing is locked while live; normal operational mutations are read-only after completion/archive; access revocation, reconciliation and scoped privacy maintenance remain available. Database deletion triggers require archival and preserve events with any payment records. Referenced R2 cleanup is durable across metadata deletion. See `worker/src/domain.ts` for the actual transition graph and roles.

## Limitations

The workspace still uses a bulk snapshot and a sizeable application component. Large-event pagination, per-operation quotas, durable offline workflows, more granular organization administration and the wider product modules are not implied by the current architecture. See [READINESS.md](READINESS.md).

## Authenticator and guest-media boundaries

Authenticator credentials are isolated from profile exports. AES-GCM secrets bind ciphertext to account identity, and a separate stable encryption key avoids coupling TOTP availability to session-pepper rotation. Database proof/claim triggers atomically consume TOTP counters, recovery codes and login challenges with session creation. MFA password reset does not remove the second factor.

Guest photo routes authenticate invitation capabilities independently of organizer cookies. Both host settings and per-photo moderation/sharing flags govern disclosure. Metadata is reserved before object upload; a separate upload reservation survives event/guest erasure so the cleanup worker does not race active storage writes. Expired reservations are recovered by cron. Gallery fetches are paginated and use authorization headers/blob URLs rather than embedding invitation tokens in image URLs.

Consent-state changes generate database-triggered, source-labelled history. Owner/admin audit UI shows bounded recent records; owner exports include full retained consent history, and privacy erasure cascades through it. Browser invitation editors register an unsaved-change guard used by internal navigation and account/event switching.
