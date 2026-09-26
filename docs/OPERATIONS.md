# Operations

## Liveness and tracing

`GET /api/v1/health` reports Worker liveness and environment; it is **not** a full dependency readiness probe. Production configuration is checked before handlers. Request IDs are generated server-side and returned in headers/error bodies. The integration screen reports configuration presence, not actual provider health.

Enable Cloudflare observability (included in generated production config). Route alerts for elevated 5xx/429, auth failures, D1 latency/quotas, R2 failures, queue age, outbox backlog, DLQ entries and payment confirmation delays. Do not include raw request bodies, cookies, reset tokens, invitation URLs or provider credentials in logs/monitoring.

## Useful operator queries

Run through a restricted Cloudflare administrative account, not the browser:

```sql
SELECT COUNT(*) FROM notification_outbox WHERE dispatched_at IS NULL;
SELECT id,event_id,status,created_at FROM announcements WHERE status IN ('queued','processing') ORDER BY created_at;
SELECT announcement_id,status,COUNT(*) FROM notification_deliveries GROUP BY announcement_id,status;
SELECT COUNT(*) FROM media_deletions;
SELECT reference,status,initialization_state,last_verified_at,amount_minor,currency,created_at FROM payments WHERE status IN ('pending','initialized') ORDER BY created_at;
```

The five-minute cron dispatches pending outbox rows, checks up to five unsettled payments from the last seven days (at least 30 minutes between attempts per reference), drains up to 50 durable referenced-media deletion jobs, and removes expired auth/rate-limit records and analytics older than 90 days. Missing cron or a broken queue binding must trigger an alert. Monitor the provider dashboards for actual delivery and payment outcomes.

## Notification recovery

1. Check configuration and approved sender/template, not just the presence of keys. Guests must explicitly opt in through their invitation. Migration 0010 deliberately starts existing contacts opted out; do not bulk opt them in based only on possession of their contact details. SMS messages include a signed opt-out URL and may span multiple billable segments.
2. Inspect announcement state, attempt count and sanitized error messages.
3. Transient network/429/5xx errors retry up to the configured attempt cap. Permanent contact/configuration errors stop.
4. Use Messages → Refresh status → Retry failed recipients only after resolving the cause. Accepted recipients are not deliberately resent. Retry preserves the original recipient set; new guests need a new announcement.
5. A timeout after a provider accepted a message can still duplicate SMS/WhatsApp on retry. Resend uses a stable idempotency key subject to provider retention limits. Do not claim exactly-once delivery.
6. Investigate and redrive DLQ jobs deliberately; never blindly purge the ledger. If a job is stuck processing, investigate the queue/outbox before changing records.

## Payment recovery

1. Inspect Settings → Payments, and keep the original reference. The ledger shows the latest 100 rows; CSV exports only displayed rows, while totals cover the event.
2. Use Reconcile or the guest's Check status control. Signed webhooks and status verification validate reference, amount, currency and success; mismatches do not consume the webhook receipt.
3. An ambiguous initialization timeout returns 202 and keeps its intent/reference. **Do not tell a guest to create a new payment merely because checkout did not open.** Automatic repeated provider initialization is intentionally disabled; compare the original reference with Paystack. Older-than-seven-day unsettled records need manual review.
4. Browser retry state survives reload in the same tab/session, not deletion of browser storage or another device. A changed contribution payload cannot reuse the previous intent. Explicitly starting another contribution is a new payment, not a retry.
5. No refund/dispute execution, settlement routing or full accounting exists. Keep a restricted manual process and approved merchant policy. Do not mark payments paid based on screenshots or indiscriminately delete financial rows.

## Backups and incident response

- Use D1 backup/time-travel capabilities and encrypted exports before migrations/event days. Keep backups outside Git and restricted to operators.
- Back up referenced R2 objects alongside metadata. Prove restoration into a separate environment; an export alone is not a recovery plan.
- Record RPO/RTO, retention, ownership and restore drill results before launch.
- Diagnose using request ID, deploy history, D1/R2/queue metrics and provider status.
- Roll back only schema-compatible releases; repair schema forward.
- Have an independent organizer contact channel for event-critical incidents. Check-in currently requires a working network.

## Privacy and support

Private API responses are no-store/noindex with no-referrer; invitations are bearer links and must not be forwarded. Tokens can be rotated from the guest list. Remove collaborators immediately when no longer authorized. Account & security supplies password-confirmed account export and account anonymization/deactivation; event Settings supplies owner-only export, guest erasure and archived-event deletion. Owned events with **any** payment record block automatic event/account deletion transactionally; use reviewed retention handling instead. Other owners' event content and provider/backups data are not blindly removed. Guest erasure removes operational links and schedules referenced R2 objects for deletion while retaining disconnected financial records.

Monitor `media_deletions` backlog and R2 failures. Tasks survive metadata deletion and are removed only after object deletion succeeds. This is not an orphan-bucket scan or a guarantee that provider/backups copies have been erased. Continue an approved external-provider/backups data-rights process. Financial/audit retention needs a jurisdiction-specific policy; don't indiscriminately delete records needed for settlement or legal obligations.

## Account-security and rollout notes

- Apply migrations 0008–0010 **before** the new Worker/frontend. Existing sessions have auth version zero; subsequent security actions invalidate prior versions. Existing organizers must verify email before production publishing/integration use.
- Configure Resend and verified sender DNS before enabling those workflows. Verification is requested explicitly from Account & security, expires after 24 hours and is single-use; an email scanner GET does not consume it.
- Password change/recovery revokes all sessions. Revoke other sessions preserves the current one. Account deletion is irreversible through the app and anonymizes a disabled identity row to preserve shared-record foreign keys.
- `SESSION_PEPPER` also signs opt-out-only links. Rotation invalidates old sessions and unsubscribe signatures; affected guests can still manage preferences from a valid personal invitation. Coordinate rotation with support rather than silently breaking old message links.

## MFA recovery and key incidents

- Users enroll in Account & security; setup is not enabled until a fresh authenticator code is confirmed. Store recovery codes outside the browser. Codes are never returned by later reads.
- Login challenges expire after five minutes/five attempts. An atomic account-wide counter also limits proof attempts to twenty per five-minute window, including across new challenges/IP addresses. Both challenge and proof consumption are transactional. Investigate repeated failures, clock skew and encryption-key changes; do not disable MFA automatically after a password reset.
- A valid recovery code can sign in even during an MFA encryption-key incident. A signed-in user can disable MFA using current password plus another unused code, then enroll again once configuration is restored. Lost authenticator **and** lost recovery codes require an operator identity-review procedure; no unauthenticated support bypass is implemented.
- `MFA_ENCRYPTION_KEY` encrypts TOTP secrets with per-record AES-GCM IVs and account-bound authenticated data. Session-pepper rotation does not re-encrypt secrets. Protect and restore the encryption key with your data backups; blind key replacement breaks enrolled authenticators.

## Photo and consent operations

- Guest photos require explicit sharing consent and host opt-ins; all start pending. Reject/hide removes gallery availability, while the submitting guest can still see and withdraw their own ready photo. Ordinary staff authorization applies to moderation; event completion does not lock safety maintenance.
- New gallery endpoints use guest authorization headers and no-store responses. Previously downloaded copies cannot be recalled, and the event-wide gallery is not private-occasion scoped. Be explicit about this consent scope.
- D1 reserves upload metadata and a one-hour `media_uploads` reservation before R2 writes. Purging ignores active reservations. Cron recovers expired reservations, queues abandoned objects and then drains normal deletion tasks. Alert on old `media_uploads`, persistent `uploading` rows and `media_deletions` backlog. This is bounded recovery, not an independent bucket inventory/orphan audit.
- Preference-change triggers retain source-labelled channel states, policy version and time. `migration_snapshot` is only the state observed during migration. These records are not retroactive consent proof or independent identity verification. Guest/event erasure removes the associated history. Approve jurisdiction-specific retention and policy text separately.
