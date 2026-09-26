# Invibox

An event-management application with a React/Vite organizer workspace and invitation experience, backed by a Cloudflare Worker, D1, R2 and Queues.

## Start locally

Requires Node 22.13+.

```bash
npm ci
npm run db:migrate:local
npm run worker:dev
# In another terminal:
npm run dev
```

Open `/app` and register. Development demo bootstrap is explicit (`POST /api/v1/demo/bootstrap` when enabled), never an automatic sign-in fallback. The frontend uses a relative `/api/v1` path through Vite's proxy.

## Validate

```bash
npm run format:check
npm run typecheck
npm test
npm run test:database
npm run smoke             # local Worker + Vite running
npm run test:regression   # local Worker + Vite; development fixtures only
npx playwright install --with-deps chromium
npm run test:e2e
npm run build
npx wrangler deploy --dry-run
npm audit --audit-level=high
```

## Readiness

Core organizer/guest workflows have been hardened and tested, including tenant isolation, private invitations, versioned writes, RSVP, seating, role-scoped check-in, text-content editing, media moderation and provider adapters. **The whole original product vision is not production-complete merely by entering keys.**

Start with the [readiness review and remaining work](docs/READINESS.md). [Deployment](docs/DEPLOYMENT.md) covers ordered setup, production configuration generation, first-party API proxy, providers, migrations and acceptance gates. No secrets belong in Git.

## Documentation

- [Readiness, user flows and unresolved scope](docs/READINESS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Operations](docs/OPERATIONS.md)
- [Audit](docs/AUDIT.md)
- [Implementation status](IMPLEMENTATION.md)
