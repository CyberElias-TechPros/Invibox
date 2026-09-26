# API contract

Base: `/api/v1`, normally reached through the frontend's same-origin proxy. Session authentication uses an opaque HttpOnly/Secure/SameSite=Lax cookie. Private responses are no-store/noindex. JSON errors generally return `{error:{code,message,issues?},requestId}`; request IDs are also in response headers. Body-limit errors have a message and request-ID header. Browser mutations must originate from the configured frontend and use JSON except multipart media.

## Account

- `POST /auth/register` — `{name,email,password}`; minimum password length 10.
- `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- `POST /auth/password/forgot` — generic response; one-hour hashed reset token delivered via email. Development demo mode alone may return a test token.
- `POST /auth/password/reset` — `{token,password}`; expires outstanding reset links and sessions.

## Events and versioned editing

- `GET /events`, `POST /events` — create `{title,eventType,date,location,timezone}` with a valid IANA timezone.
- `PATCH /events/:id` — title/type/date/timezone/location, supported visibility (`public`, `private`, `guest_specific`), lifecycle, settings/theme. `settings` accepts supported `capabilities` and optional ISO `rsvpDeadline`. Designer writes are limited to title/theme.
- `GET /events/:id/snapshot` — role-redacted collections plus `event.guests_version`, `schedule_version`, `sections_version`.
- `GET /events/:id/preview` — session-authorized invitation projection, including draft/private occasions. Never publicly accessible without membership.
- `PUT /events/:id/guests/sync` — `{guests:[...]}`.
- `PUT /events/:id/schedule/sync` — `{schedule:[{id?,date?,time,title,place,audience,isPrivate?}]}`. Date defaults to the event's local date; time is converted from the event timezone.
- `PUT /events/:id/sections/sync` — `{sections:[{title,type,content,visible}]}`. Public text rendering uses `content.text`.

**All three sync endpoints require `If-Match: <collection version>`**. Missing precondition is 428; stale versions are 409. Success is `{ok:true,version}` with the transaction's new collection version. Collections are replacements, including deletion; sending an empty array clears the collection. Do not retry a stale payload over the newest snapshot automatically. Existing RSVP/seating/check-in state is not writable through guest CRM sync. Imported IDs are event-namespaced. Public occasion access is auto-granted only on creation/becoming-public; making a public occasion private revokes old grants for explicit reassignment.

## Guests and event operations

- `POST /events/:id/guests` — create guest and return `{guest,token}`; contact fields `email` and E.164 `phone` persist. Send the link yourself; creation does not send an invitation.
- `POST /events/:id/guests/:guestId/token` — rotate/revoke previous token; return a new token and URL once.
- `GET|PUT /events/:id/guests/:guestId/access` — read/replace `{occasionIds}`; all IDs must belong to this event.
- `POST /events/:id/seating`, `DELETE /events/:id/seating/:tableId`.
- `PATCH /events/:id/guests/:guestId/seat` — `{table:string|null}`; capacity enforced in the database.
- `PATCH /events/:id/guests/:guestId/checkin` — `{checkedIn}`.
- `POST /events/:id/checkin/scan` — `{token}`, returns guest and `alreadyCheckedIn`.
- `POST /events/:id/budgets`, `DELETE /events/:id/budgets/:budgetId`.
- `POST /events/:id/vendors`, `DELETE /events/:id/vendors/:vendorId`.
- `POST /events/:id/media` — multipart `file`, optional caption; allowed signatures/MIME, 25 MB file maximum.
- `GET /events/:id/media/:mediaId/file`, `PATCH /events/:id/media/:mediaId` — authorized file access/moderation.

Completed/archived events reject operational mutations. Live events reject structural section/schedule replacement.

## Team and administration

- `POST /events/:id/team-invitations` — `{email,role}`; seven-day email-bound token.
- `POST /team-invitations/accept` — `{token}`, authenticated matching email.
- `GET /events/:id/team` — members and unexpired pending invitations.
- `DELETE /events/:id/team/:userId` — owner-only collaborator removal; cannot remove owner.
- `DELETE /events/:id/team-invitations/:invitationId` — revoke pending invitation.
- `GET /events/:id/audit` — latest 100 audit entries; owner/admin.
- `GET /events/:id/integrations/status` — configuration-presence booleans, not connectivity/approval verification.

## Communications and AI

- `GET /events/:id/announcements` — latest 100 statuses/counts.
- `POST /events/:id/announcements` — `{channel,audience,message}`; unavailable providers return 503 before enqueue. Commits announcement, frozen recipients and outbox; returns 202.
- `POST /events/:id/announcements/:announcementId/retry` — requeues failed recipients of a failed announcement; accepted recipients are preserved.
- `POST /events/:id/ai/assist` — `{task,prompt}`, rate-limited; humans must review generated content.

Announcement/ledger `sent` means **accepted by the provider**, not delivery/read receipt. Automatic retries are bounded. External exactly-once messaging is not guaranteed; see operations.

## Guest/public

- `GET /public/events/:slug?token=...` — published/active/live/completed events. Non-public visibility requires a valid guest token. Any supplied invalid token returns 404 even for public events. Valid guests see assigned occasions only; anonymous public visitors see nonprivate occasions only.
- `POST /public/rsvp` — `{token,responses:[{occasionId,status,meal?}],dietaryNotes?,plusOneName?}`. Supply a stable `Idempotency-Key`; absent key falls back to payload hash. Reusing a key with another body returns 409. Enforces assigned occasions, lifecycle, deadline and reserved plus-one allocation.
- `POST /public/analytics` — `{eventId,token?,type,session?,metadata?}`. Only accessible published event contexts and allowlisted event types; rate/request bounded. Analytics expires after 90 days.
- `POST /public/payments/paystack/initialize` — `{slug,token?,email,amount,purpose}`; purpose `gift` or `contribution`, NGN only, gifts must be enabled. Non-public events require a valid guest token. Amount is NGN major units.
- `GET /public/payments/:reference` — opaque reference acts as the receipt capability; returns limited payment status and verifies pending transactions server-side.
- `POST /webhooks/paystack` — provider HMAC signature; success matches reference/amount/currency/status. Receipt/payment update is transactional; retries do not double-process.

## Operations

- `GET /health` — liveness/configuration safety, not comprehensive readiness.
- `POST /demo/bootstrap` — explicit development-only fixture/session bootstrap. Never enable outside development.

Endpoint availability does not imply every larger product flow exists. See [READINESS.md](READINESS.md) for unresolved implementation scope.
