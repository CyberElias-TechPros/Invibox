# API contract

Base path: `/api/v1`. JSON responses use `{ error: { code, message, issues? }, requestId }` on failure.

## Authentication

- `POST /auth/register` — `{ name, email, password }`
- `POST /auth/login` — `{ email, password }`
- `POST /auth/logout`
- `GET /auth/me`

Authentication uses an HttpOnly `invibox_session` cookie.

## Organizer event API

- `GET /events/:eventId/snapshot`
- `GET /events` and `POST /events` — list/create organizer events
- `PATCH /events/:eventId` — identity, lifecycle, privacy, theme and capability settings
- `POST /events/:eventId/guests` — create guest and return a one-time personalized token
- `PUT /events/:eventId/guests/sync` — validated guest collection
- `PUT /events/:eventId/schedule/sync` — validated occasion collection
- `PUT /events/:eventId/sections/sync` — persist ordered experience composition
- `POST|DELETE /events/:eventId/seating` — table management
- `PATCH /events/:eventId/guests/:guestId/seat` — capacity-safe assignment
- `PATCH /events/:eventId/guests/:guestId/checkin` — `{ checkedIn }`
- `POST /events/:eventId/checkin/scan` — idempotent guest-token entry
- `POST|DELETE /events/:eventId/budgets` — budget categories
- `POST|DELETE /events/:eventId/vendors` — vendor records
- `POST /events/:eventId/announcements` — queue email/SMS/WhatsApp announcement
- `POST /events/:eventId/media` — multipart image/video/audio upload, 25 MB maximum
- `GET /events/:eventId/media/:mediaId/file` — authenticated media stream
- `PATCH /events/:eventId/media/:mediaId` — moderation

All routes enforce event ownership or membership.

## Guest API

- `GET /public/events/:slug?token=...` — only public occasions unless a valid guest token is supplied
- `POST /public/rsvp` — requires `Idempotency-Key`; validates occasion access
- `POST /public/analytics` — allowlisted event types and bounded metadata
- `POST /public/payments/paystack/initialize` — token-aware NGN gift/ticket/contribution checkout
- `POST /webhooks/paystack` — signed, replay-safe payment confirmation

## Operations

- `GET /health`
- `POST /demo/bootstrap` — development only and disabled unless `DEMO_MODE=true`

The notification queue consumer explicitly marks jobs failed with `PROVIDER_NOT_CONFIGURED` until WhatsApp, email or SMS provider adapters and credentials are configured; it never reports fake delivery.
