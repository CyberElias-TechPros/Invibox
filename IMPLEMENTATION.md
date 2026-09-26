# Implementation status

Updated 26 September 2026. The authoritative current assessment is [docs/READINESS.md](docs/READINESS.md). Earlier blanket claims that all features were complete or that only credentials remained were too broad.

## Completed in the hardening pass

- Tenant-safe transactional bulk editing, collection versions and visible conflict handling.
- Private event enforcement, occasion access controls, token rotation and authorized organizer preview.
- Correct expiry handling, CSRF/origin checks, atomic rate limits and production configuration safety guards.
- Role-specific authorization/redaction, collaborator list/revocation, invitation acceptance before onboarding.
- Real event timezone/date scheduling, private occasions, safe calendar and CSV import/export.
- Contact-bearing guest creation, persisted text-content composer and data-driven guest invitations.
- Payload-bound RSVP idempotency, partial-response aggregation, plus-one/deadline/lifecycle checks.
- Database-enforced seating capacity and repeat-safe check-in, without false offline claims.
- Transactional messaging outbox, fixed recipient sets, delivery leases, bounded retry classification, provider timeouts, history/retry UI and acceptance-vs-delivery distinction.
- Payment currency/reference/amount/status checks, atomic webhook processing and invitation-token-free provider callback URLs.
- Media signature checks and R2 cleanup on metadata failure.
- Removal of global organizer PII caching, automatic demo login, fabricated operational chart/timeline values and non-persisting invitation design controls.
- Pinned dependencies, readable source formatting, expanded CI, production config generator, setup and operational runbooks.

## Completed in the follow-up

- Email verification, production capability gates, active-session management, password changes, authentication versioning and single-use concurrent password resets.
- Account/event exports, owner guest erasure, archived event deletion and account anonymization with transactional financial-retention protection and durable R2 deletion jobs.
- Idempotent payment intents, ambiguous initialization recovery, organizer ledger/CSV and manual/periodic reconciliation.
- Locally generated guest QR passes and token-revocation behavior.
- Guest-controlled per-channel communication opt-ins, signed unsubscribe links, queued-message suppression and contact-change consent reset.
- Route-level lazy loading and full browser/API integration for the new controls.

## Validation

41 unit/HTTP/provider tests, 19 SQLite-backed Worker tests, 65 local Cloudflare API checks, full-stack smoke and six Chromium browser tests (including mocked-provider payment recovery) passed. Frontend/Worker type checks, frontend build, Worker dry-run, migrations and dependency audit passed. This is not a production load, penetration or accessibility certification.

## Not complete

See the explicit code/product backlog in [READINESS.md](docs/READINESS.md#remaining-codeproduct-work--not-solved-by-adding-keys): public SaaS billing/entitlements, MFA/abuse defenses, refunds/settlement, delivery/bounce callbacks and consent evidence policy, external-provider/backups erasure, guest media, true offline operations, transport/accommodation/ticket inventory, advanced visual editing, localization and large-scale operational validation.

No production resources, provider accounts, secrets, legal policies, public deployment or live financial transactions were created by this change.
