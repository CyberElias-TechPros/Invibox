# Packages, billing and organizer payouts

Implemented 27 September 2026 in migrations `0013_packages_and_payouts.sql` and `0014_remaining_modules.sql`. This covers **per-event packages/packs** plus **organizer-level recurring subscriptions**, refunds/disputes, settlement ingestion, tax invoices, ticket inventory, and extras. Provider acceptance and legal/commercial approval remain release gates.

## Default catalog — paid prices are proposals, disabled by default

| Product | Draft NGN price | Guest places | Occasions | Collaborators | Photos / storage | Queued recipients |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Free | 0 | 50 | 3 | 2 | 20 / 100 MiB | 0 |
| Essential | 7,500 | 200 | 5 | 5 | 200 / 500 MiB | 200 |
| Celebration | 15,000 | 500 | 10 | 10 | 1,000 / 1 GiB | 500 |
| Professional | 30,000 | 1,500 | 25 | 20 | 2,000 / 2 GiB | 1,500 |
| Guest pack | 2,500 | +100 | — | — | — | — |
| Photo pack | 1,500 | — | — | — | +100 / +100 MiB | — |
| Message pack | 3,000 | — | — | — | — | +100 |
| Organizer Starter (subscription) | 15,000/mo | +500 | +10 | +10 | +1k / +1 GiB | +1k |
| Organizer Pro (subscription) | 40,000/mo | +2k | +30 | +25 | +5k / +5 GiB | +5k |

Subscription entries are draft inactive. The operator edits display names, prices, limits and availability at `/app/commerce`; only free starts active. Do not activate paid entries until prices, channel-specific delivery costs, taxes, refund policy and Paystack acceptance have been reviewed. A single recipient credit is not a cost guarantee for every SMS/WhatsApp destination. The defaults are **not approved commercial terms**.

- Guest limits count `SUM(party_size)`, not just guest rows. Collaborator limits exclude owner. Plus-one editing (`plus_one_email/phone`) is now part of guest sync.
- Photo/storage allowances include pending uploads and all event media, not only approved gallery entries. Independent per-guest and file-size security limits still apply.
- Message credits count **lifetime queued recipients**. Later failures, suppression, erasure and retries do not restore or consume another credit for same retained recipient. A new campaign consumes new credits. Credits are not proof of delivery/read. Suppression list (bounced/complained) is populated via Resend/Twilio webhooks (`message_events`, `suppression_list`) with optional HMAC verification (`RESEND_WEBHOOK_SECRET`). List-Unsubscribe headers are added to outbound email.
- Existing event usage is grandfathered at migration; new events snapshot then-current free config. Catalog edits do not retrospectively shrink purchased entitlements.
- Plans grant max of existing capacity and new plan plus previously purchased packs. Packs add capacity. Upgrades charged **in full, without proration**; no automatic downgrades. Subscriptions grant additional bonus via `subscription_entitlements` and `event_entitlements.subscription_bonus_json`.
- Safety ceilings: 5k guest places, 100 occasions, 100 collaborators, 2k photos, 2 GiB storage, 100k queued recipients. Upgrades carry pack capacity forward only up to ceilings; pack exceeding ceiling rejected. Historical grandfathered usage may already be higher and not deleted.
- Quotas transaction-enforced. Bulk guest/schedule replacement checked at commit, so temporary overlapping rows do not incorrectly reject valid replacements. Failed writes roll back entirely. Existing state not silently truncated.
- Ticket inventory: `ticket_types` with capacity and `ticket_holds` (held/confirmed/released/expired) enforced by trigger `ticket_capacity_guard`. Hold expires after 15 minutes unless confirmed.
- Extras: transport bookings, accommodations + assignments, registry items + fulfillments, waitlist entries with invite flow.

## Organizer purchase flow (per-event)

1. Verify email (required outside development). Open owned event → Settings → **Packages & usage**.
2. Inspect usage, price, limits and full-price upgrade terms. Disabled draft entries cannot be purchased.
3. Checkout sends stable idempotency key and expected price. Server snapshots catalog and rejects stale prices, lower/equal plan tiers, closed events and conflicting unresolved orders.
4. Separate package ledger reserves one order. Only one caller claims provider initialization. Paystack package checkout has **no organizer subaccount**: package revenue belongs to platform.
5. Returning from checkout does not grant anything. Signed webhook verification, owner/operator reconciliation or bounded cron verifier checks reference, exact amount, NGN, successful status, absence of split/subaccount routing.
6. Paid transition atomically grants entitlements once. Duplicate webhooks/reconciliation cannot re-grant pack. Paid status and commercial snapshots immutable. Completed/archived event records still fulfilled if earlier valid payment arrives late.
7. UI shows latest 50 orders with verified payment records and CSV export. Full owner event export includes package ledger and entitlements. Invoices generated via `generateInvoice` with configurable `TAX_RATE_BPS` (default 0) and stored in `invoices` table (issued status). Records are **not legal tax filings by themselves**.

Uncertain initialization keeps original reference and blocks another purchase. Browser recovers from server ledger even if local retry storage lost. Cron verifies at most five recent unresolved package orders per run, with 30-min verification interval and 7-day window. Older/unresolved orders remain visible to operator; not silently deleted or assumed unpaid.

### Closing an unresolved order

Reconcile first. Timeout, 404, `failed` or `abandoned` alone is **not** automatic authorization to create replacement charge. Contact Paystack support/dashboard; confirm no payment received and ensure old checkout cannot charge. Then use password/MFA-protected **Close after provider cancellation** action with recorded reason and explicit confirmation. Action records external review; does not call provider cancellation API. Late verified payments still grant purchase exactly once and need duplicate-payment/refund review.

## Organizer-level subscriptions (monthly/yearly)

- Catalog `plan_catalog` kind `subscription` with `organizer_starter/pro` draft entries (inactive).
- Checkout `POST /account/subscriptions/checkout` requires Idempotency-Key (20-100 chars alnum/_/-) and expectedPriceMinor match. Reserves `organizer_subscriptions` status `incomplete`, creates Paystack transaction with metadata `kind: invibox_subscription`.
- Reconcile via `POST /account/subscriptions/:reference/reconcile` calls Paystack `/transaction/verify/:reference` and settles via `settleSubscription`: validates amount matches catalog, unsplit platform payment, updates period (month/year) and `subscription_entitlements`.
- Cancel `POST /account/subscriptions/:reference/cancel` requires password+MFA, sets `canceled_at` and `cancel_at=current_period_end`.
- Settlement: `ingestSettlements` cron fetches `/settlement` and `/settlement/:id/transactions`, creates `settlement_batches/items`, marks payments `settlement_status`.
- Invoices: `GET /account/invoices` lists; generated on billing and subscription settlement.

## Organizer-specific contribution settlement

1. Configure `PAYSTACK_SECRET_KEY` and separate stable random `PAYOUT_VERIFICATION_KEY` >=32 chars. Fingerprint secret has **no dev/prod fallback** and independent of session rotation. Keep in encrypted backup; changing without reviewed migration prevents verification of existing requests.
2. Organizer opens Account & security → **Organizer payout account**, loads cursor-paginated Nigerian bank catalog (excluding inactive/deleted), enters 10-digit account number and business name, gives consent, proves password plus MFA when enrolled. Email must be verified outside development.
3. Resolve bank account, reserve one onboarding request, create Paystack subaccount with zero platform percentage. Store only masked details and keyed bank/account fingerprint, not full account number. Provider metadata binds owner and unique onboarding request.
4. Creation/name resolution only yields **review**, never approval. Uncertain response remains uncertain; do not repeat provider creation. Operator locates via provider metadata and onboarding reference shown in review UI.
5. Operator independently reviews identity and authority under approved KYC process. Approval requires fresh provider `active===true`, `is_verified===true`, exact subaccount, matching bank, owner/request metadata and account fingerprint, plus explicit identity-review attestation and reason. Transaction guard prevents stale approval undoing concurrent block/replacement. Operators should enroll MFA before handling money.
6. New guest contributions require event owner's locally verified payout account. Immutable payment snapshot includes its subaccount code. Initialize using `subaccount`, `transaction_charge:0`, `bearer:"subaccount"`. **Platform contribution commission currently zero; organizer bears Paystack fees.** No platform-merchant fallback for new contributions.
7. Verification additionally matches provider's subaccount code. Paid record proves payment success, **not bank settlement, refund completion or net payout**. Paystack settlement eligibility, reserves and timing still apply. Settlement ingestion marks `settlement_status`.

Legacy merchant-only records remain reconcilable for historical accounting; never relabelled as organizer settlements. Application will not initialize/reopen legacy merchant checkout or earlier payout route after bank replacement. Existing external checkout links cannot be revoked by changing local state; review them with provider before enabling live collection.

### Block or replace a bank

- Use **Block new contributions**, with password/MFA and reason. Immediate local gate, not provider cancellation or settlement freeze.
- Review outstanding checkouts, payments, disputes and unsettled balances with Paystack. Never change bank details of verified provider subaccount in place: old transaction routing must remain attributable.
- Deactivate old provider subaccount. **Allow bank replacement after review** requires blocked local account, provider inactivity when code known, explicit absent/inactive-and-settlements-reviewed confirmation, and reason. For unresolved creation with no stored provider code, operator must establish absence or recover/deactivate externally; absence not inferred from timeout.
- Reset audited with prior masked bank/subaccount identity. Releases onboarding for fresh request; does not rewrite old payment routes. New account must pass complete review again. External in-flight creation/checkout/settlement must be handled by operator, not assumed cancelled by reset.

## Refunds, disputes, settlements

- `refund_requests` kind contribution/package/subscription, amount_minor, reason, status requested/approved/processing/refunded/rejected/failed, provider_refund_id. Owner requests via `POST /events/:id/refunds`; admin lists via `GET /admin/refunds` and approves/processes/rejects with password+MFA audit. Processing calls Paystack `/refund` with reference and amount. Webhook `ingestRefundWebhook` handles `refund.processed/failed` and `dispute.*` events, inserting `dispute_events`.
- `settlement_batches` and `settlement_items` ingested via cron `ingestSettlements`. Payments updated with `settlement_batch_id` and `settlement_status`.
- `invoices` with `invoice_number` unique, tax calculated via `TAX_RATE_BPS` env (basis points), total = amount+tax.

## Ownership transfer

- `POST /events/:id/transfer` with toEmail, password, code (MFA if enabled). Creates `ownership_transfers` with token_hash, expires 48h, status pending. Target receives token (in production via email). Accept via `POST /transfers/:id/accept` with token+password, verifies hash, atomically swaps `events.owner_id` and updates `event_members` roles. Reject via `POST /transfers/:id/reject`. Expired transfers ignored.

## Messaging compliance

- Resend webhook `POST /webhooks/resend` optional HMAC via `RESEND_WEBHOOK_SECRET`, Twilio `POST /webhooks/twilio` form parsing. Events logged in `message_events` with provider_event_id unique. Bounced/complained insert into `suppression_list` (channel, address unique). `GET /admin/suppressions` lists.
- Outbound email includes `List-Unsubscribe` and `List-Unsubscribe-Post` headers pointing to signed unsubscribe URL. `withUnsubscribe` appends link to body; `unsubscribeUrl` generates signed URL.
- Scheduled sends: `scheduled_announcements` with send_at future, status scheduled/sent/canceled. `POST /events/:id/announcements/:announcementId/schedule` creates; `GET /events/:id/scheduled` lists; `DELETE` cancels. Cron `dispatchScheduled` marks sent and re-queues announcement.

## Retention, offline, drafts, themes, localization, passkeys, abuse control

- `retention_policies` 7 categories seeded (analytics 90, media/announcements/audit/consents 365, payments/billing 2555 days). Admin `GET/PATCH /admin/retention` with password+MFA audit, `applyRetention` cron purges per policy.
- Offline check-in: `POST /events/:id/checkin/offline/sync` with deviceId + up to 500 items, last-write-wins (earliest checked_in preserved, newer uncheck wins if timestamp newer), queue insert + guest checked_in_at update, `GET /events/:id/checkin/offline/pending` lists pending.
- Draft snapshots: `draft_snapshots` CRUD, keep 20 latest per event/user, for invitation editor offline store.
- Themes: `theme_presets` CRUD + apply to `events.theme_json`, `event_translations` upsert for en/yo/ig/ha.
- Passkeys: `webauthn_credentials` + `webauthn_challenges` with counter replay guard, registration options/verify, list/delete, authentication options/verify creating session with device_json/ip_hash.
- Turnstile: optional Cloudflare Turnstile verification via `TURNSTILE_SECRET_KEY` env, logs `turnstile_verifications` with ip_hash, enforced on register (always) and login (if key configured).
- Session attribution: `sessions.device_json` (ua) and `ip_hash` (sha256 of cf-connecting-ip) stored on login/register.

## Access, privacy and operations

- Only event owner can buy/view package billing. Collaborators do not gain billing authority from event-admin access.
- Platform admin requires `users.platform_role='admin'`; registration cannot assign that role. Bootstrap reviewed operator with controlled DB change, e.g. `UPDATE users SET platform_role='admin' WHERE email='your-reviewed-operator-address';`. Verify actual address and audit change; no public role-promotion endpoint.
- Financial config, approval, block/reset and order closure require password reauth plus one-time MFA/recovery proof if enrolled. Proof consumption and DB changes commit atomically. Admin views expose masked bank data only; do not put account numbers, identity docs or secrets in reasons/logs.
- Events with package orders join financial-retention guard, including unresolved/closed orders. Automatic account/event deletion cannot erase retained finance. Account and event exports use allowlisted projections; provider-held financial records and backup deletion remain separate processes.
- Monitor `BILLING_RECONCILIATION_UNAVAILABLE`, unresolved package orders, uncertain payout requests, unexpected late payments, contribution destination mismatches, refund/dispute webhooks, settlement ingestion failures, suppression list growth. Review more than first 100 operator rows via controlled DB/reporting access if volume exceeds console limit.
- Enroll/verify organizers against Paystack test accounts first; validate actual subaccount response fields, fee allocation, webhook payloads, bank ownership evidence, old-route handling, real settlement, refund and invoice flows before launch. Automated tests use provider fixtures, not live financial acceptance.

## Still outside this implementation (requires legal/ops review)

Automated KYC/document verification; legally approved pricing/consent/retention policies; operator case management at scale; real email delivery of ownership transfer tokens; production Turnstile site key configuration; tax authority filings beyond invoice generation. See [READINESS.md](READINESS.md). These gaps are not fixed merely by adding API keys.
