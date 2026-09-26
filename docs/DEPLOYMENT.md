# Deployment — safe order

Read [READINESS.md](READINESS.md) first. This application has a tested core, not every feature of the original product vision. A production pilot needs infrastructure, provider approval, legal decisions and acceptance tests in addition to secrets.

## 1. Verify locally (Node 22.13+)

```bash
npm ci
npm run db:migrate:local
npm run worker:dev
# Separate terminal:
npm run dev
# With both servers running:
npm run format:check
npm run typecheck
npm test
npm run test:database
npm run smoke
npm run test:regression
npx playwright install --with-deps chromium
npm run test:e2e
npm run build
npx wrangler deploy --dry-run
npm audit --audit-level=high
```

Use `/app` to register a real local account. Demo bootstrap is explicit and development-only; the UI never silently logs into it. The regression suite requires local `DEMO_MODE=true` to obtain test team tokens. Never run fixture tests against production.

## 2. Provision resources

Create separate resources for staging and production. Record their **non-secret** IDs:

```bash
npx wrangler d1 create invibox-db
npx wrangler r2 bucket create invibox-media
npx wrangler kv namespace create CACHE
npx wrangler queues create invibox-notifications
npx wrangler queues create invibox-notifications-dlq
```

D1 holds transactional records, atomic rate counters, outbox and delivery leases. R2 holds media. KV remains a provisioned cache/config binding; it is no longer the authoritative rate limiter. Queues process notifications. Cron runs every five minutes to recover outbox dispatch and clean expired data.

## 3. Generate production configuration

Provide these non-secret environment variables in your deployment shell/CI:

```text
INVIBOX_APP_ORIGIN=https://YOUR_FRONTEND_DOMAIN
INVIBOX_API_ORIGIN=https://YOUR_WORKER_DOMAIN
CLOUDFLARE_D1_ID=PROVIDER_DATABASE_UUID
CLOUDFLARE_KV_ID=PROVIDER_NAMESPACE_ID
R2_BUCKET=invibox-media
QUEUE_NAME=invibox-notifications
```

Then run:

```bash
npm run configure:production -- --check
npm run configure:production
```

This creates ignored `wrangler.production.toml` with `APP_ENV=production`, `DEMO_MODE=false`, resources, observability and a dead-letter queue. It updates `vercel.json` with a same-origin `/api/:path*` proxy to your Worker. It never writes secrets. Inspect the generated files. Set approved sender/template values in the generated Worker configuration before deployment.

**Keep `VITE_API_BASE=/api/v1`.** Do not switch to an unrelated cross-site Worker origin in browser code: `SameSite=Lax` session cookies would not behave as first-party cookies. The Vercel rewrite is required, not optional. The original checked-in Vercel configuration intentionally cannot guess your Worker hostname.

## 4. Install secrets and provider configuration

```bash
npx wrangler secret put SESSION_PEPPER --config wrangler.production.toml
npx wrangler secret put RESEND_API_KEY --config wrangler.production.toml
npx wrangler secret put WHATSAPP_ACCESS_TOKEN --config wrangler.production.toml
npx wrangler secret put TWILIO_ACCOUNT_SID --config wrangler.production.toml
npx wrangler secret put TWILIO_AUTH_TOKEN --config wrangler.production.toml
npx wrangler secret put AI_API_KEY --config wrangler.production.toml
npx wrangler secret put PAYSTACK_SECRET_KEY --config wrangler.production.toml
```

`SESSION_PEPPER` must be cryptographically random, at least 32 characters, stored in a secret manager; rotation invalidates existing sessions and signed unsubscribe links (see the operations runbook). Production requests fail closed if the pepper is missing/short, demo is enabled, or `APP_ORIGIN` is not HTTPS.

| Service | Additional configuration and approval |
|---|---|
| Resend | Verified `EMAIL_FROM`, domain DNS and sender approval |
| WhatsApp | `WHATSAPP_PHONE_NUMBER_ID`; approved `WHATSAPP_TEMPLATE_NAME` accepting first name and message; matching `WHATSAPP_TEMPLATE_LANGUAGE` |
| Twilio | Approved `TWILIO_FROM_NUMBER`, permitted destination geographies, messaging consent |
| AI | `AI_BASE_URL` (HTTPS trusted provider) and `AI_MODEL`; spending limits and human review |
| Paystack | Merchant/settlement approval; test keys first; webhook `https://WORKER_DOMAIN/api/v1/webhooks/paystack`; NGN gifting scope only |

The settings screen reports presence of configuration, not validated provider readiness. Blank providers remain unavailable; no test credentials are invented.

## 5. Back up, migrate, deploy

```bash
npx wrangler d1 export invibox-db --remote --output=/secure/backup-before-release.sql --config wrangler.production.toml
npx wrangler d1 migrations apply invibox-db --remote --config wrangler.production.toml
npx wrangler deploy --dry-run --config wrangler.production.toml
npx wrangler deploy --config wrangler.production.toml
npm run build
```

Deploy the frontend through Vercel using the configured `vercel.json`, build `npm run build`, output `dist`, and `VITE_API_BASE=/api/v1`. API origin allowlisting must exactly match the user-facing frontend origin. Camera scanning requires HTTPS and supported `BarcodeDetector`; manual token entry is available.

Never deploy the development `wrangler.toml` to production. Never run development fixture migrations/data imports on a production dataset. Before migrations 0005–0007, inspect existing seating, occasion access and tenant relationships; triggers prevent new violations but do not automatically repair historical bad data.

## 6. Staging acceptance and go-live

1. Register/login/logout, password recovery, expired-token rejection and session revocation.
2. Create event → timezone/date → public/private occasions → contact-bearing guests → private access → content → preview → publish.
3. Test host, admin, designer, guest manager, check-in staff, viewer and unrelated accounts.
4. Confirm unassigned occasions and non-public events are inaccessible anonymously; rotate a token and prove the old link stops working.
5. Test RSVP conflict/replay, two simultaneous seating assignments, two concurrent check-ins and stale organizer saves.
6. Test each provider in its sandbox; inspect attempt ledger, pending outbox, retries and DLQ. Verify actual delivery in provider dashboards; API acceptance is not proof of delivery.
7. Test payment amount/currency/signature mismatch, callback, duplicate webhook and a provider outage. Do not enable public payments before merchant/legal decisions.
8. Test upload moderation, mobile accessibility, consent language and data deletion support procedures.
9. Configure alerts/backup restore drill and approve [release gates](READINESS.md#release-gates).

Roll back only to a schema-compatible Worker/frontend pair. Repair schema forward; do not reverse production migrations destructively. Old bulk-sync clients must not bypass the new version preconditions.

## Follow-up rollout and acceptance

Apply all migrations through `0010_communication_preferences.sql` before deploying this release. Migration 0010 defaults every guest/channel to opted out; imported contacts are not presumed to have consent. Distribute personal invitation links, then let guests choose preferences. Account verification is now required outside development before publishing or using paid integrations; existing organizers request a link from `/app/account` after email delivery has been configured.

Include verification expiry/replay, session revocation/password changes, privacy financial-retention rollback, R2 deletion recovery, guest QR revocation, opt-out suppression, payment initialization timeouts and ledger reconciliation in staging acceptance. Test `/app/account` and `/unsubscribe` through the deployed frontend rewrites. Never run destructive fixture tests against production. Add provider keys only in the secret manager; no live provider acceptance or public deployment was performed in this workspace.
