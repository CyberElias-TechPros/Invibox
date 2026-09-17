# Invibox implementation status

Invibox is implemented as a responsive Event Experience Platform with a React/Vite frontend and a Cloudflare Worker backend.

## Implemented and verified

- Secure registration, login, logout and session lookup APIs
- First-event onboarding and event-type configuration
- Event ownership/team-role authorization boundary
- Dynamic multi-event dashboard, event switching and invitation composer with persisted sections
- Guest CRM, groups, CSV import/export, D1 synchronization and personalized-link generation
- Guest-specific access-token model (only token hashes are stored)
- Multi-occasion scheduling and access model
- Idempotent, access-checked multi-occasion RSVP
- Optimistic check-in with backend rollback behavior
- Capacity-safe seating assignment with table creation and floor-plan interaction
- Persistent budget categories and vendor CRUD flows with honest empty states
- Queued announcement workflow
- Validated R2 media upload, authenticated retrieval and moderation workflow
- Live first-party analytics ingestion, aggregation, dashboard and CSV export
- Browser offline cache with online synchronization status
- Immersive public marketing site plus Features, Solutions, Templates, Pricing and Our Story pages
- Responsive public invitation and organizer workspace at intentionally separate routes
- Public SEO metadata, canonical URLs, Open Graph, Organization schema, robots policy and sitemap
- Reduced-motion support, focus treatment and semantic form flows
- Development/preview/production configuration, CI and deployment documentation

## Explicit environment-dependent work

Real outbound WhatsApp, email and SMS delivery requires approved provider accounts and secrets. Queue jobs are accepted but explicitly fail with `PROVIDER_NOT_CONFIGURED`; Invibox never reports fake delivery. Paystack NGN checkout initialization and signed, replay-safe webhook confirmation are implemented; live collection remains disabled until merchant credentials and legal/business configuration are supplied. Remote Cloudflare resource IDs and deployment credentials cannot be generated from source code and must be configured as documented.

## Local run

```bash
npm ci
npm run db:migrate:local
npm run worker:dev
npm run dev
```

- Organizer workspace: `/`
- Guest invitation: `/invite/amaka-chidi`
- API health: `/api/v1/health`

## Validation

```bash
npm run typecheck
npm test
npm run build
npm run smoke       # with local Worker and Vite running
npx wrangler deploy --dry-run
```

See `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DEPLOYMENT.md`, and `docs/OPERATIONS.md`.
