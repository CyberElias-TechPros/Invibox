# Production readiness review — 26 September 2026

## Verdict

**Substantial security and workflow hardening is implemented; this is not a certification that the entire original SaaS vision is production-complete.** Credentials alone do not complete every advertised use case. Launch a defined, limited event-management pilot only after staging acceptance and the release gates below. Do not sell unfinished modules as working products.

## What this pass corrected

| Area | Previous problem | Implemented behavior |
|---|---|---|
| Invitation privacy | Visibility was not enforced | Non-public event data requires the event's guest token; invalid tokens do not fall back to anonymous access; private organizer preview requires an authorized session |
| Tenant isolation | Bulk upserts could overwrite another event's IDs | Event-scoped local IDs, conditional upserts and database tenant triggers; invalid batches roll back |
| Concurrency | Autosave could replace RSVP/check-in data | Per-collection versions, mandatory `If-Match`, transactional guards and version reads; explicit conflict handling; CRM updates cannot overwrite existing RSVP/check-in/seating |
| Data lifecycle | Empty schedule deletion did nothing; large deletion lists were inconsistent | Atomic replace semantics with `json_each`; duplicate IDs rejected; empty collections work |
| Authentication | ISO timestamps were compared lexically against SQL timestamps | Julian-date expiry checks for sessions, password reset and team invitations; reset invalidates outstanding reset links and sessions |
| CSRF/abuse | CORS was treated as sufficient protection; rate counters raced | Origin checks, JSON-only writes except uploads, atomic D1 rate counters, body limits, production configuration fail-closed checks |
| Roles | Staff check-in routes did not match authorization rules | Exact role/resource rules, financial/contact redaction, role-aware navigation, owner-protected team removal |
| Event lifecycle | Arbitrary transitions and structural live edits | Transition graph, publication needs an occasion, live structural locks, completed/archived operational read-only state |
| Dates | Schedule used a fixed demo date and UTC+1 | Per-occasion date, event IANA timezone, UTC storage, local display, DST validation and real calendar exports |
| Guest operations | Contact fields ignored; imported guests had no link workflow | Persisted email/E.164 phone, proper CSV quoting/import parsing, formula-safe export, token rotation/revocation, explicit occasion-access editor |
| RSVP | Duplicate keys accepted different bodies; partial updates calculated wrong totals | Payload-bound replay, transaction-safe duplicate handling, lifecycle/deadline checks, duplicate-occasion rejection, plus-one limits, aggregate status from all responses |
| Seating | Capacity check could race | Database-enforced capacity on seating/party-size changes; concurrent assignment tested |
| Guest experience | Any event displayed a sample wedding | Actual title, date, location, assigned occasions, RSVP, optional gifting, saved text sections and calendar files; loading/error states never display demo guests |
| Invitation composer | Style controls claimed to save without doing so | Persisted text sections, visibility, ordering, read-only lifecycle state, private preview and publication; cosmetic mock controls replaced |
| Communications | Queue enqueue could lose jobs; retries skipped failures; changing audiences skipped recipients | Transactional outbox, five-minute dispatch recovery, frozen recipients, keyset pagination, delivery leases, retry classification, attempt ledger, Resend idempotency keys and explicit retry/history UI |
| Payments | Currency was not verified; webhook receipt could commit before payment state | Reference/amount/currency/status validation; webhook receipt and status update in one transaction; stable paid timestamps; unsupported ticket/asoebi checkout purposes removed |
| Uploads | Trusted browser MIME declarations | Signature checks, bounded upload requests, authorized retrieval, orphan-object cleanup if metadata insertion fails |
| UI integrity | Global localStorage guest cache and fabricated dashboard values | No persistent organizer PII cache, no automatic demo login, server-derived identity/statistics, visible save failures, honest online-only check-in wording |
| Delivery | Cross-site cookies could break Vercel → Worker login | Production config generator installs same-origin `/api` reverse proxy; secure cookies remain first-party |

## Supported stories and their order

1. **Organizer:** register/sign in → create event with date/location/timezone → add public/private occasions → add/import guests → assign private occasion access → edit invitation content → preview → publish → distribute individual private links. Publication before a schedule fails explicitly.
2. **Guest:** open personalized link → view only assigned occasions → choose each response → optionally add dietary/accessibility notes and companion name within allocation → submit → retry the same payload safely. Invalid/revoked tokens expose no event data.
3. **Collaborator:** receive email-bound invitation → register/sign in as the invited email → accept before expiry → see role-scoped workspace. Acceptance runs before first-event onboarding. Owner can remove access; admins/owners can revoke pending invitations.
4. **Event-day staff:** sign in → select assigned event → scan token or search guest → persist check-in → refresh status. Concurrent repeated scans report an existing check-in. **Network access is required.**
5. **Communications:** configure approved provider → enter actual guest contacts → select audience → enqueue transactionally → provider attempts/retries → inspect accepted/failed counts → deliberately retry failures. “Sent” in the database means **provider accepted**, not delivered/read.
6. **Gifting:** organizer enables gifting → guest submits receipt email and amount → hosted Paystack checkout → verified webhook/status lookup → paid confirmation. Invitation tokens are not sent to the payment provider in callback URLs. Test the flow on the same browser; returning in another browser requires the original private link.
7. **Organizer media:** authorized upload → signature validation → R2 storage → moderation → authorized retrieval. This is not yet a full guest-upload gallery product.
8. **Completion:** live structural edits lock → mark completed → review read-only operational records → archive. Final financial/retention actions remain operator-controlled.

## Verified in this workspace

- 38 Vitest unit/HTTP/provider tests.
- 4 SQLite-backed Worker tests: same-day expiry, reset/team expiry, queue retries/deduplication/frozen audience, signed payment webhook validation/replay.
- 65 real local Worker/D1 API regression checks.
- Full-stack smoke: register → create → schedule → publish → token → RSVP/replay → seat → check-in → R2 upload/moderation/retrieval.
- 2 Chromium browser tests: real organizer content publication and private guest RSVP; no silent demo authentication.
- TypeScript checks, production frontend build, Wrangler dry-run, local forward migrations and dependency audit.

Browser tests used an external cached Chromium binary because the default browser CDN was unreachable in this sandbox. No browser binary or test data is committed. CI uses Playwright's standard installation.

## Remaining code/product work — not solved by adding keys

These are explicit scope gaps, not claims of completion:

- **Public paid SaaS:** email verification, stronger account-abuse controls (e.g. Turnstile), MFA/session-device management, organization ownership transfer, subscription billing, enforced entitlements and quotas, platform administration and support workflows.
- **Money:** checkout initialization idempotency/recovery, organizer payment ledger UI, refund/dispute workflows, reconciliation jobs, merchant/subaccount settlement policy, ticket inventory/capacity and receipt/tax requirements. Current implementation is NGN gifts/contributions to the configured merchant, not multi-organizer payout infrastructure.
- **Messaging:** signed delivery/bounce/read callbacks, opt-in/opt-out/suppression policy and UI, attachment/template management, scheduled sends. SMS/WhatsApp may duplicate after an ambiguous provider timeout or crash; exactly-once external delivery is not promised. Large campaigns need load/subrequest-limit testing and quota enforcement.
- **Privacy:** self-service account/event export and erasure across D1/R2, configurable retention by data category, audit review UI and a legally approved consent/privacy/terms policy. Analytics currently purge after 90 days; other business data needs a defined retention policy.
- **Guests/media:** guest upload consent/moderation/gallery flow, reliable generated QR passes, plus-one/household editing beyond reserved party size, transport bookings, accommodation inventory, registry fulfillment, waitlists and ticketed event capacity.
- **Experience:** full visual theme/template/media editing, SEO rendering for public pages, complete localization, richer calendar/timezone editing, accessibility audit and browser/device matrix. The editor saves text content, not arbitrary page design.
- **Reliability/scale:** real offline conflict-resolving check-in, paginated large-event workspace (current snapshot is bounded bulk editing, not infinite scale), load testing, provider sandbox acceptance, monitored backup restores, production alert routing and security review.
- **Editor limitations:** content edits require explicit Save before internal navigation; browser-close warnings do not provide a full route blocker. Other collection changes use serialized server writes, not an offline durable job queue.

## Release gates

1. Choose the exact pilot scope and remove unsupported marketing promises/pricing commitments.
2. Provision isolated staging/production bindings and domains; configure first-party API proxy; disable demo in production; install a random session pepper.
3. Apply all migrations before compatible Worker/frontend releases. Back up and validate preexisting tenant/seating data before applying new triggers.
4. Run the complete quality suite and staging role/guest acceptance on desktop and mobile; exercise provider test accounts and failure/timeout/replay scenarios.
5. Approve privacy, consent, messaging and merchant/settlement policies. Never use customer payments before this review.
6. Configure WAF/rate limits, quotas, alerts, DLQ monitoring, backups and a proven restore drill. Assign an on-call owner for live events.
7. Perform an independent security/accessibility review and fix release-blocking findings before a broad public launch.
