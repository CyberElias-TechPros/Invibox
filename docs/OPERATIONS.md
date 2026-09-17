# Operations

## Health and tracing

`GET /api/v1/health` reports Worker liveness. Every response has `x-request-id`; errors return the same ID. Structured Worker errors omit secrets and private payloads.

## Backups and recovery

- Schedule D1 exports before high-risk migrations and major event days.
- R2 object keys are immutable-style event paths; database media rows hold the canonical reference.
- Guest CSV export is available to organizers.
- Use forward repair migrations rather than destructive rollback.
- Queue jobs are idempotently identified and retry up to three times.

## Incident checklist

1. Confirm health endpoint and Cloudflare status.
2. Locate request ID in Worker logs.
3. Check D1/Queue/R2 binding availability.
4. Disable only the affected provider adapter; preserve queued jobs.
5. Roll Worker back if the failure followed deployment.
6. Communicate event-critical outages using an independent organizer channel.

## Privacy

Private workspaces and invitations are `noindex`. Store only necessary guest data, never log invitation tokens, and establish retention/deletion policies before production onboarding. Payment data must remain with PCI-compliant providers; Invibox should store references and status, not card data.
