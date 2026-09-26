# API contract

Base: `/api/v1`, normally reached through the frontend's same-origin proxy. Session authentication uses an opaque HttpOnly/Secure/SameSite=Lax cookie. Private responses are no-store/noindex. JSON errors generally return `{error:{code,message,issues?},requestId}`; request IDs are also in response headers. Body-limit errors have a message and request-ID header. Browser mutations must originate from the configured frontend and use JSON except multipart media.

## Account

- `POST /auth/register` — `{name,email,password}`; minimum password length 10.
- `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- `POST /auth/password/forgot` — generic response; one-hour hashed reset token delivered via email. Development demo mode alone may return a test token.
- `POST /auth/password/reset` — `{token,password}`; single-use transactional claim; expires outstanding reset links and sessions. Concurrent replay is rejected.
- `POST /auth/email/request` — authenticated verification email request; 60-second cooldown, 24-hour hashed capability. Never returns a verification token outside development demo mode.
- `POST /auth/email/verify` — `{token}`; explicit confirmation, consumes token, does not log in.
- `GET /account/sessions`, `DELETE /account/sessions/:sessionId` — own active sessions only; no token hashes returned.
- `POST /account/sessions/revoke-others` — `{password}`; preserves current session and invalidates others.
- `POST /account/password` — `{currentPassword,newPassword}`; revokes all sessions/reset tokens and clears the cookie.
- `POST /account/export` — `{password}`; safe profile and membership metadata, no credentials.
- `POST /account/delete` — `{password,confirmation}` with current email; all owned events must be archived and free of payment records. Atomic account anonymization/deactivation, owned-event deletion, referenced-media deletion jobs, membership removal and session revocation. Financial retention conflicts return 409 and roll back everything.

Outside development, verified email is required for publishing, collaborator invitations, announcements, AI and the event owner enabling payment use. Verification is requested from Account & security, not automatically sent on registration.

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

Completed/archived events reject normal operational mutations; security, export/erasure, access revocation and financial reconciliation maintenance remain available. Live events reject structural section/schedule replacement.

## Owner privacy and financial maintenance

- `POST /events/:id/export` — `{password}`; owner-only allowlisted JSON data, no access hashes, checkout URLs or media bytes.
- `POST /events/:id/erase-guest/:guestId` — `{password}`; removes guest-linked records, queues media erasure, nulls financial guest links without destroying payment records.
- `POST /events/:id/delete` — `{password,confirmation}` with exact title; archived/nonfinancial events only.
- `GET /events/:id/payments` — owner/admin, latest 100 ledger entries plus total count and paid sum.
- `POST /events/:id/payments/:reference/reconcile` — owner/admin, verifies existing payment against provider; never creates a new checkout.

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
- `POST /events/:id/announcements` — `{channel,audience,message}`; unavailable providers return 503 before enqueue; no opted-in audience returns 422. Contacts alone never imply opt-in. Commits announcement, frozen recipients and outbox; returns 202.
- `POST /events/:id/announcements/:announcementId/retry` — requeues failed recipients of a failed announcement; accepted recipients are preserved.
- `POST /events/:id/ai/assist` — `{task,prompt}`, rate-limited; humans must review generated content.

Delivery-row `sent` means **accepted by the provider**, not delivery/read receipt. Announcement `sent` is a completed processing state which can include skipped opt-outs; use accepted/failed/skipped counts. Consent is checked again at send time. Automatic retries are bounded. External exactly-once messaging is not guaranteed; see operations.

## Guest/public

- `GET /public/events/:slug?token=...` — published/active/live/completed events. Non-public visibility requires a valid guest token. Any supplied invalid token returns 404 even for public events. Valid guests see assigned occasions only; anonymous public visitors see nonprivate occasions only.
- `POST /public/rsvp` — `{token,responses:[{occasionId,status,meal?}],dietaryNotes?,plusOneName?}`. Supply a stable `Idempotency-Key`; absent key falls back to payload hash. Reusing a key with another body returns 409. Enforces assigned occasions, lifecycle, deadline and reserved plus-one allocation.
- `POST /public/preferences` — `{token,email:boolean,sms:boolean,whatsapp:boolean}`; guest capability controls its own subscriptions independently of RSVP. Defaults are off; email/phone changes reset the corresponding consent flags.
- `POST /public/unsubscribe` — `{guest,channel,signature}`; HMAC-bound guest/channel capability can only opt out. `/unsubscribe` is the browser confirmation page; link scanners doing GET cannot mutate consent. Messages already accepted by providers cannot be recalled.
- `POST /public/analytics` — `{eventId,token?,type,session?,metadata?}`. Only accessible published event contexts and allowlisted event types; rate/request bounded. Analytics expires after 90 days.
- `POST /public/payments/paystack/initialize` — `{slug,token?,email,amount,purpose}`; purpose `gift` or `contribution`, NGN only, gifts must be enabled. Non-public events require a valid guest token. Amount is NGN major units (100–100,000,000, at most two decimal places). Requires `Idempotency-Key` of 20–100 alphanumeric/underscore/hyphen characters. Same key/body reuses one reference; changed body is 409. Response may be 202 pending with **no** checkout URL after an ambiguous failure: reconcile the existing reference rather than allocate a new key. Browser retry state is per tab/session; it cannot deduplicate intentional new keys or another device automatically.
- `GET /public/payments/:reference` — opaque reference acts as the receipt capability; returns limited payment status and verifies pending transactions server-side.
- `POST /webhooks/paystack` — provider HMAC signature; success matches reference/amount/currency/status. Receipt/payment update is transactional; retries do not double-process.

## Operations

- `GET /health` — liveness/configuration safety, not comprehensive readiness.
- `POST /demo/bootstrap` — explicit development-only fixture/session bootstrap. Never enable outside development.

Endpoint availability does not imply every larger product flow exists. See [READINESS.md](READINESS.md) for unresolved implementation scope.

## Authenticator MFA

- `GET /account/mfa`: enabled/available flags and remaining recovery-code count; never returns a stored secret.
- `POST /account/mfa/setup`: `{password}`, authenticated. Returns a newly generated `secret` and `otpauth` URI once; pending setup expires in ten minutes. An enabled authenticator cannot be overwritten.
- `POST /account/mfa/enable`: `{password,code}`. Confirms a fresh TOTP, returns ten recovery codes once and revokes every session.
- `POST /auth/login` returns `{mfaRequired:true,challengeToken}` **without a session** when MFA is enabled. Clients must not treat this as completed authentication.
- `POST /auth/mfa`: `{challengeToken,code}` where code is TOTP or a recovery code. Five-minute expiry, five attempts per challenge, and twenty proof attempts per account per five-minute window across challenges. Challenge consumption, counter/recovery-code use and session creation commit atomically. Password/security-version changes invalidate pending challenges.
- `POST /account/mfa/recovery`: `{password,code}` replaces the recovery-code set; old unused codes stop working. `POST /account/mfa/disable` requires the same proof, removes MFA and signs out all sessions.

Each TOTP counter and recovery code is single-use. Wait for the next 30-second code after enrollment/use if needed. Password reset never disables MFA. Recovery codes remain usable when the encryption key is unavailable; TOTP/setup fail closed.

## Guest photos and consent history

- Event settings add independent `guestUploads` and `guestGallery` booleans, off by default. Partial settings updates merge with existing fields.
- Guest photo routes require `Authorization: Guest <invitation token>`. Anonymous public-event visitors cannot access this gallery. No invitation token is put in photo URLs.
- `POST /public/events/:slug/media`: multipart `file`, `caption?`, `consent=true`. Published/active/live events with guest uploads enabled only. JPEG/PNG/WebP, 10 MB maximum; signature checked, not malware-scanned/transcoded. A guest has a 20-file/100 MB allowance; event guest submissions stop at 2,000 total media records or 2 GB total media size. Returns pending moderation.
- `GET /public/events/:slug/media?cursor=...`: up to 24 photos and `nextCursor`, upload/gallery flags. Shows the caller's own ready submissions plus approved, shareable photos when the gallery is enabled. Visibility is event-wide, not occasion-scoped.
- `GET /public/events/:slug/media/:mediaId/file`: rechecks the same access policy on each request, private/no-store.
- `DELETE /public/events/:slug/media/:mediaId`: withdraw own submissions only, even after archival; queues referenced R2 deletion. Does not erase copies already downloaded.
- Existing organizer moderation accepts `{status,shareWithGuests?}`. Legacy organizer approvals are not automatically guest-visible; photos must also be explicitly marked shareable and the gallery enabled. Completion/archival does not block moderation maintenance.
- `GET /events/:id/consents`: owner/admin only, latest 100 preference changes. Each change records guest/event, three channel flags, source, policy version and timestamp. Full retained history is part of password-confirmed owner exports; guest erasure cascades history deletion.
