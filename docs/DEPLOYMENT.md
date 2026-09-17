# Deployment

After provider-side account setup, deployment is configuration-only: enter the values below, apply migrations and deploy. Do not commit secrets.

## 1. Local verification

```bash
npm ci
npm run db:migrate:local
npm run worker:dev       # :8787
npm run dev              # :5173, proxies /api to Worker
npm run typecheck && npm test && npm run smoke && npm run build
```

## 2. Cloudflare resources

Create only the services represented by bindings:

```bash
npx wrangler d1 create invibox-db
npx wrangler r2 bucket create invibox-media
npx wrangler kv namespace create CACHE
npx wrangler queues create invibox-notifications
```

Enter the returned D1 `database_id`, KV `id`, R2 bucket name and Queue name in `wrangler.toml`. D1 is transactional product data, R2 is user media, KV is rate-limiting/cache state, and Queues provide durable notification delivery.

Set Worker variables in `wrangler.toml` or the Cloudflare dashboard:

| Variable | Production value |
|---|---|
| `APP_ENV` | `production` |
| `APP_ORIGIN` | Exact Vercel/custom frontend origin, no trailing slash |
| `DEMO_MODE` | `false` |
| `EMAIL_FROM` | Resend-verified sender, e.g. `Invibox <events@example.com>` |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta-issued phone number ID |
| `WHATSAPP_TEMPLATE_NAME` | Approved template expecting guest first name and message body |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Approved language code, e.g. `en` |
| `TWILIO_FROM_NUMBER` | Twilio sender in E.164 form |
| `AI_BASE_URL` | OpenAI-compatible API root; default `https://api.openai.com/v1` |
| `AI_MODEL` | Provider model ID |

Set secrets:

```bash
npx wrangler secret put SESSION_PEPPER
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put AI_API_KEY
npx wrangler secret put PAYSTACK_SECRET_KEY
```

Use a cryptographically random `SESSION_PEPPER` of at least 32 bytes. Apply every migration, dry-run, then deploy:

```bash
npm run db:migrate:remote
npx wrangler deploy --dry-run
npx wrangler deploy
```

Attach a Worker custom domain such as `api.example.com` and retain HTTPS.

## 3. Provider dashboards

- **Resend:** verify the `EMAIL_FROM` domain and complete DNS records.
- **Meta WhatsApp:** approve the configured template. Its body parameters are, in order, guest first name and announcement text. Give the token permission to send via the configured phone ID.
- **Twilio:** provision/verify the `TWILIO_FROM_NUMBER`; enable destination geographies as required.
- **Paystack:** register `https://API_DOMAIN/api/v1/webhooks/paystack` as the webhook URL. Paystack return URLs are generated from `APP_ORIGIN`. Webhooks are HMAC-verified and replay-safe; the public status route also verifies initialized transactions with Paystack.
- **AI provider:** issue an API key and choose an OpenAI chat-completions-compatible model/base URL.

## 4. Vercel

Import as a Vite project. Build with `npm run build`, output `dist`, and enter:

```text
VITE_API_BASE=https://API_DOMAIN/api/v1
```

Vercel serves marketing, `/app`, and `/invite/*`; API requests go directly to the Cloudflare Worker. `APP_ORIGIN` provides the exact CORS allow-origin. Camera check-in requires HTTPS and a browser supporting `BarcodeDetector`; a secure manual pass-code fallback is always available.

## 5. Production acceptance

1. Register/sign in, request and consume a password reset.
2. Create/publish an event and invite a second team account.
3. Add a test guest with email and phone; send one message per configured channel and inspect `notification_deliveries`.
4. Use AI Draft and review generated content before sending.
5. RSVP through the private token, upload/moderate a memory and scan the pass camera QR.
6. Make a Paystack test contribution; confirm webhook and status both resolve it to `paid`.
7. Confirm `/events/:id/integrations/status` reports configured services without exposing values.
8. Change provider test keys to live keys only after provider acceptance.

## Ordering and rollback

Deploy additive D1 migrations before code that consumes them, then Worker, then frontend. Roll Worker/Vercel versions back through platform history. Repair schema/data forward with a new migration; do not destructively reverse production migrations.
