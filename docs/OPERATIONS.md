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
SELECT reference,status,amount_minor,currency,created_at FROM payments WHERE status IN ('pending','initialized') ORDER BY created_at;
```

The five-minute cron dispatches pending outbox rows and removes expired auth/rate-limit records and analytics older than 90 days. Missing cron or a broken queue binding must trigger an alert. Monitor the provider dashboards for actual delivery and payment outcomes.

## Notification recovery

1. Check configuration and approved sender/template, not just the presence of keys.
2. Inspect announcement state, attempt count and sanitized error messages.
3. Transient network/429/5xx errors retry up to the configured attempt cap. Permanent contact/configuration errors stop.
4. Use Messages → Refresh status → Retry failed recipients only after resolving the cause. Accepted recipients are not deliberately resent. Retry preserves the original recipient set; new guests need a new announcement.
5. A timeout after a provider accepted a message can still duplicate SMS/WhatsApp on retry. Resend uses a stable idempotency key subject to provider retention limits. Do not claim exactly-once delivery.
6. Investigate and redrive DLQ jobs deliberately; never blindly purge the ledger. If a job is stuck processing, investigate the queue/outbox before changing records.

## Payment recovery

Signed webhooks and public status verification check payment identity and update paid state. Unmatched merchant transactions are ignored. Amount/currency mismatches are rejected without consuming the webhook receipt. Inspect initialized/pending records against Paystack. Refunds, disputes, settlement routing and full reconciliation are not implemented; maintain a restricted manual procedure until those flows exist. Do not manually mark payments paid based on a guest screenshot.

## Backups and incident response

- Use D1 backup/time-travel capabilities and encrypted exports before migrations/event days. Keep backups outside Git and restricted to operators.
- Back up referenced R2 objects alongside metadata. Prove restoration into a separate environment; an export alone is not a recovery plan.
- Record RPO/RTO, retention, ownership and restore drill results before launch.
- Diagnose using request ID, deploy history, D1/R2/queue metrics and provider status.
- Roll back only schema-compatible releases; repair schema forward.
- Have an independent organizer contact channel for event-critical incidents. Check-in currently requires a working network.

## Privacy and support

Private API responses are no-store/noindex with no-referrer; invitations are bearer links and must not be forwarded. Tokens can be rotated from the guest list. Remove collaborators immediately when no longer authorized. Establish an approved manual erasure/export process across D1, R2, backups and providers until self-service data rights are implemented. Financial/audit retention needs a jurisdiction-specific policy; don't indiscriminately delete records needed for settlement or legal obligations.
