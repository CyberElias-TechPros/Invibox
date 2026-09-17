# Deployment

## Local development

```bash
npm ci
npm run db:migrate:local
npm run worker:dev       # port 8787
npm run dev              # port 5173, proxies /api to Worker
```

Then open `/`. The development-only bootstrap creates the demo tenant idempotently.

## Cloudflare

1. Authenticate Wrangler: `npx wrangler login`.
2. Create resources:
   - `wrangler d1 create invibox-db`
   - `wrangler r2 bucket create invibox-media`
   - `wrangler kv namespace create CACHE`
   - `wrangler queues create invibox-notifications`
3. Replace the placeholder D1/KV IDs in `wrangler.toml` with returned IDs.
4. Configure `APP_ORIGIN` to the exact Vercel origin and set `DEMO_MODE=false`.
5. Set secrets: `wrangler secret put SESSION_PEPPER` and any provider credentials.
6. Apply migrations: `npm run db:migrate:remote`.
7. Validate: `npx wrangler deploy --dry-run`.
8. Deploy: `npx wrangler deploy`.
9. Prefer a same-site custom API domain such as `api.invibox.app`.

## Vercel

1. Import the repository as a Vite project.
2. Set `VITE_API_BASE=https://api.invibox.app/api/v1`.
3. Build command: `npm run build`; output: `dist`.
4. Deploy preview, validate authentication/CORS, public RSVP, check-in, uploads and queue consumption, then promote.

## Ordering and rollback

Deploy additive D1 migrations before Worker code that consumes them, then deploy the frontend. Roll back Worker/frontend deployments through platform history; never roll a schema back destructively. Follow-up migrations should repair data/schema forward.

## Environment-dependent integrations

Real email, WhatsApp, SMS and payment delivery requires provider accounts, approved sender identities/webhooks and secrets. Their absence does not weaken validation or authorization; jobs remain explicit rather than reporting fake delivery.
