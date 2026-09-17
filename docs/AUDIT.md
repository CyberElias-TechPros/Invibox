# Production audit and product reconstruction

## Product reconstruction

Invibox is a multi-tenant event SaaS combining an invitation studio, guest CRM, event operations, live experience and memory archive. Hosts/planners configure events; collaborators manage scoped work; guests open personalized invitations without accounts; staff check guests in. Its differentiator is a universal event/occasion model suitable for Nigerian multi-ceremony celebrations and other cultural/event packs.

## Initial state

The repository originally contained only a 91 KB aspirational README. It had no application, dependency manifest, domain model, persistence, backend, tests, deployment configuration, security boundary or executable workflow.

## High-impact problems and resolutions

| Severity | Problem | Root cause | Resolution | Result |
|---|---|---|---|---|
| Critical | No application or backend | Idea-only repository | Built frontend, Worker API and D1 schema | Runnable full-stack product foundation |
| Critical | No auth/authorization | No system existed | Opaque sessions, PBKDF2, server-side ownership/roles | Protected organizer data |
| Critical | Guest privacy/IDOR risk | Personalized model undefined | Hashed guest tokens and occasion-level access checks | Guests see/respond only to assigned data |
| High | UI-only data | First prototype used local storage | D1 snapshot/sync APIs plus offline cache | Durable online system with graceful offline state |
| High | Duplicate RSVP/check-in risks | No idempotency model | RSVP submission keys, D1 uniqueness, rollback-aware UI | Safe retries and clear state |
| High | Media security | Upload behavior undefined | MIME allowlist, 25 MB bound, authorized R2 path | Bounded media ingestion |
| High | Fake messaging risk | Integrations need credentials | Queue contract; explicit provider-not-configured failure | No false delivery claims |
| Medium | Deployment ambiguity | Competing architecture suggestions | Vercel frontend + Cloudflare Worker/D1/R2/KV/Queues/Cron | Documented deployment order |
| Medium | Accessibility/motion | Visual-first scope | Keyboard focus, labels, reduced motion, responsive touch layouts | More inclusive experience |
| Medium | Private SEO leakage | Invitations contain personal data | Private default, noindex/robots restrictions | Safer indexation posture |

## Feature trace status

| Workflow | UI | API | D1 | Validation | Authorization | Failure state | Tests |
|---|---:|---:|---:|---:|---:|---:|---:|
| Register/login/session | Yes | Yes | Yes | Yes | Yes | Yes | API exercised manually |
| Create event | Yes | Yes | Yes | Yes | Yes | Yes | API exercised manually |
| Guest CRM sync/export | Yes | Yes | Yes | Yes | Yes | Offline cache | Sync/retry exercised manually |
| Occasion schedule | Yes | Yes | Yes | Yes | Yes | Offline cache | Type/build validation |
| Personalized invite | Yes | Yes | Yes | Token/access | Public boundary | Invalid-token response | API exercised manually |
| Multi-event RSVP | Yes | Yes | Yes | Yes | Guest occasion | Idempotent replay | API exercised twice |
| Check-in | Camera + fallback | Yes | Yes | Yes | Role-scoped | Optimistic rollback | Full-stack smoke |
| Announcements | Yes + AI draft | Yes/Queue/providers | Attempts | Yes | Role-scoped | Per-recipient failed state | Provider unit tests |
| Media upload | Yes entry | Yes/R2 | Metadata | MIME/size | Event role | Structured errors | Environment dependent |

## Design and UX

The product uses a restrained editorial identity rather than a generic dashboard theme: warm paper surfaces, deep botanical neutrals, bespoke Nigerian wedding imagery, high-contrast serif display typography and compact operational UI. The invitation is cinematic and image-led while the organizer workspace prioritizes information density. Motion uses route fades, modal choreography and invitation reveals, with a complete reduced-motion escape hatch.

## Security and reliability

- PBKDF2-SHA256 password hashing with 210,000 iterations and per-password salts
- Opaque 256-bit sessions stored only as hashes; HttpOnly, Secure, SameSite cookies
- Server-side event ownership/membership checks
- Guest access tokens stored only as hashes
- Zod runtime validation and parameterized SQL
- RSVP eligibility and idempotency checks
- Restricted CORS, security headers and bounded KV rate limiting
- Request IDs, generic production errors and audit log schema
- Foreign keys, checks, unique constraints and indexes
- Queue retries and scheduled expired-session cleanup

## Performance

The UI uses one production bundle with optimized generated JPEG assets, transform/opacity motion, no permanent animation loops and immutable asset cache headers. The invitation avoids WebGL because it would not add enough product value for the mobile/network cost. Future scale work should split organizer modules by route and use responsive AVIF/WebP variants through an image CDN.

## SEO

The public acquisition surface now includes focused landing, features, solutions, templates, pricing and story pages with unique runtime titles/descriptions, canonical URLs, Open Graph metadata, Organization structured data, an allowlisted XML sitemap and crawler policy. Organizer and guest-specific routes are explicitly excluded through robots rules and deployment headers. A future public event-discovery catalog should use server-rendered Event structured data and remain separate from private invitations.

## Verified commands

- Dependency installation
- TypeScript checks for frontend and Worker
- 13 domain, security-primitive and provider-adapter tests
- Vite production build
- Wrangler Worker dry-run bundle
- Local D1 migrations (31 schema commands)
- Live Worker health, demo bootstrap and authenticated snapshot
- Personalized public event lookup
- RSVP write and duplicate replay
- Queue acceptance
- Automated full-stack smoke path: register → create → schedule → publish → personalized guest → RSVP → safe replay → seat → check-in → R2 upload → moderation → authenticated retrieval
- Guest synchronization repeated twice without duplication

## Remaining external dependencies

Cloudflare account resource IDs, Vercel project, production domains, sender identities, messaging credentials, payment merchant credentials and legal privacy/retention decisions are environment or business inputs. They are not fabricated in source. Exact setup is in `DEPLOYMENT.md`.
