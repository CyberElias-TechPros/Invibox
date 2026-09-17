# Invibox

Invibox is a universal event experience platform: cinematic public acquisition, private invitation sites, organizer operations, guest RSVP, seating, communications, check-in, memories, budgets, vendors, analytics, gifting and AI-assisted copy.

## Run locally

```bash
npm ci
npm run db:migrate:local
npm run worker:dev   # Cloudflare Worker on :8787
npm run dev          # Vite on :5173, with /api proxied to the Worker
```

Open `http://localhost:5173`. Development demo bootstrap is controlled by `DEMO_MODE=true`.

## Quality gates

```bash
npm run typecheck
npm test
npm run smoke
npm run build
npx wrangler deploy --dry-run
npm audit --audit-level=high
```

## Production

The application code includes concrete Resend email, Meta WhatsApp Cloud API, Twilio SMS, Paystack payments, OpenAI-compatible AI, Cloudflare D1/R2/KV/Queues, account recovery, team invitations, delivery attempts, camera QR scanning and provider-status workflows. Production activation requires provider accounts plus credentials, approved senders/templates, resource IDs, domains and webhook configuration—see [deployment](docs/DEPLOYMENT.md).

No secrets belong in Git. Use Vercel environment variables and `wrangler secret put`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Deployment and integration values](docs/DEPLOYMENT.md)
- [Operations](docs/OPERATIONS.md)
- [Adversarial audit](docs/AUDIT.md)
- [Implementation status](IMPLEMENTATION.md)
