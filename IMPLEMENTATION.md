# Implementation status

Updated 27 September 2026. The authoritative current assessment is [docs/READINESS.md](docs/READINESS.md). Earlier blanket claims that all features were complete or that only credentials remained were too broad.

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

## Authenticator/media completion pass

- Authenticator TOTP enrollment/sign-in with encrypted secrets, bounded challenges, replay guards, hashed recovery codes and authenticated disable/rotation flows.
- Consent-based guest photo uploads, host moderation, private gallery and withdrawal, database quotas and durable upload-reservation cleanup.
- Trigger-recorded communication preference history, owner/admin audit UI and privacy-export integration.
- Unsaved invitation navigation protection and partial event-settings merge fixes.

## Validation

47 unit/HTTP/provider tests, 27 SQLite-backed Worker tests, 65 local Cloudflare API checks, full-stack smoke and nine Chromium browser tests (including mocked-provider payment recovery) passed. Frontend/Worker type checks, frontend build, Worker dry-run, migrations and dependency audit passed. This is not a production load, penetration or accessibility certification.

## Not complete

See the explicit code/product backlog in [READINESS.md](docs/READINESS.md#remaining-codeproduct-work--not-solved-by-adding-keys): recurring subscriptions and broader operator case management, phishing-resistant authentication/abuse defenses, refunds/settlement, delivery/bounce callbacks and consent evidence policy, external-provider/backups erasure, guest video/audio and media scanning, true offline operations, transport/accommodation/ticket inventory, advanced visual editing, localization and large-scale operational validation.

No production resources, provider accounts, secrets, legal policies, public deployment or live financial transactions were created by this change.


## Commercial requirements follow-up

Implemented free limits, configurable proposed one-time event packages and add-on packs, database quota enforcement, immutable package billing and exactly-once fulfillment, usage/purchase/recovery/receipt screens, public catalog, organizer bank onboarding, administrator KYC review/block/replacement and verified subaccount contribution routing. Paid entries remain inactive until approved; no live provider/KYC/settlement acceptance is claimed. [Commerce workflows and limitations](docs/COMMERCE.md).
