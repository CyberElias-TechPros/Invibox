# Packages, billing and organizer payouts

Implemented 27 September 2026 in migration `0013_packages_and_payouts.sql`. This is a one-time **per-event** model, not a recurring subscription. It implements the requested free tier, paid packages/packs and organizer-specific contribution routing. Provider acceptance and legal/commercial approval remain release gates.

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

The operator edits display names, prices, limits and availability at `/app/commerce`; only the free entry starts active. Do not activate paid entries until prices, channel-specific delivery costs, taxes, refund policy and Paystack acceptance have been reviewed. A single recipient credit is not a cost guarantee for every SMS/WhatsApp destination. The defaults are **not approved commercial terms**.

- Guest limits count `SUM(party_size)`, not just guest rows. Collaborator limits exclude the owner.
- Photo/storage allowances include pending uploads and all event media, not only approved guest gallery entries. Independent per-guest and file-size security limits still apply.
- Message credits count **lifetime queued recipients**. Later failures, suppression, erasure and retries do not restore or consume another credit for the same retained recipient record. A new campaign consumes new credits. Credits are not proof of delivery/read status.
- Existing event usage is grandfathered at migration; new events snapshot the then-current free configuration. Catalog edits do not retrospectively shrink or change purchased entitlements.
- Plans grant the maximum of existing capacity and the new plan plus previously purchased packs. Packs add capacity. Upgrades are charged **in full, without proration**; there are no automatic renewals or downgrades.
- Safety ceilings: 5,000 guest places, 100 occasions, 100 collaborators, 2,000 photos, 2 GiB storage and 100,000 queued recipients. Upgrades carry pack capacity forward only up to those ceilings; a new pack exceeding a ceiling is rejected. Historical grandfathered usage may already be higher and is not deleted.
- Quotas are transaction-enforced. Bulk guest/schedule replacement is checked at commit, so temporary overlapping rows do not incorrectly reject valid replacements. Failed writes roll back entirely. Existing state is not silently truncated.

## Organizer purchase flow

1. Verify email (required outside development). Open an owned event → Settings → **Packages & usage**.
2. Inspect usage, price, limits and full-price upgrade terms. Disabled draft entries cannot be purchased.
3. Checkout sends a stable idempotency key and expected price. The server snapshots the catalog and rejects stale prices, lower/equal plan tiers, closed events and conflicting unresolved orders.
4. The separate package ledger reserves one order. Only one caller claims provider initialization. Paystack package checkout has **no organizer subaccount**: package revenue belongs to the platform.
5. Returning from checkout does not grant anything. Signed webhook verification, owner/operator reconciliation or the bounded cron verifier checks reference, exact amount, NGN, successful status, and absence of split/subaccount routing.
6. A paid transition atomically grants entitlements once. Duplicate webhooks/reconciliation cannot re-grant a pack. Paid status and commercial snapshots are immutable. Completed/archived event records are still fulfilled if an earlier valid payment arrives late.
7. The UI shows the latest 50 orders with verified payment records and CSV export. Full owner event export includes the package ledger and entitlements. These records are **not tax invoices**.

Uncertain initialization keeps the original reference and blocks another purchase. The browser recovers from the server ledger even if local retry storage is lost. Cron verifies at most five recent unresolved package orders per run, with a 30-minute verification interval and a seven-day window. Older/unresolved orders remain visible to the operator; they are not silently deleted or assumed unpaid.

### Closing an unresolved order

Reconcile first. A timeout, 404, `failed` or `abandoned` response alone is **not** automatic authorization to create a replacement charge. Contact Paystack support/dashboard operations; confirm no payment was received and ensure the old checkout cannot charge. Then use the password/MFA-protected **Close after provider cancellation** action with a recorded reason and explicit confirmation. The action records the external review; it does not call a provider cancellation API. Late verified payments still grant their purchase exactly once and need duplicate-payment/refund review. No refund API or automatic entitlement clawback is implemented.

## Organizer-specific contribution settlement

1. Configure `PAYSTACK_SECRET_KEY` and a separate stable random `PAYOUT_VERIFICATION_KEY` of at least 32 characters. The fingerprint secret has **no development or production fallback** and is independent of session rotation. Keep it in encrypted backup/recovery material; changing it without a reviewed migration prevents verification of existing requests.
2. The organizer opens Account & security → **Organizer payout account**, loads Nigerian banks, enters a ten-digit account number and organizer/business name, gives processing consent, and proves their password plus MFA when enrolled. Email must be verified outside development.
3. Resolve the bank account, reserve one onboarding request, and create a Paystack subaccount with zero platform percentage. Store only masked account details and a keyed bank/account fingerprint, not the full account number. Provider metadata binds both the owner and the unique onboarding request.
4. Creation/name resolution only yields **review**, never approval. An uncertain response remains uncertain; do not repeat provider creation. The operator locates it using provider metadata and the onboarding reference shown in the review UI.
5. The operator independently reviews identity and authority under an approved KYC process. Approval requires fresh provider `active === true`, `is_verified === true`, exact subaccount, matching bank, owner/request metadata and account fingerprint, plus an explicit identity-review attestation and reason. A transaction guard prevents a stale approval from undoing a concurrent block/replacement. Operators should enroll MFA before handling money.
6. New guest contributions require the event owner's locally verified payout account. The immutable payment snapshot includes its subaccount code. Initialize using `subaccount`, `transaction_charge: 0`, and `bearer: "subaccount"`. **Platform contribution commission is currently zero; the organizer bears Paystack processing fees.** No platform-merchant fallback exists for new contributions.
7. Verification additionally matches the provider's subaccount code. A paid record proves payment success, **not bank settlement, refund completion or net payout**. Paystack settlement eligibility, reserves and timing still apply.

Legacy merchant-only records remain reconcilable for historical accounting; they are never relabelled as organizer settlements. The application will not initialize/reopen a legacy merchant checkout or an earlier payout route after a bank replacement. Existing external checkout links cannot be revoked by changing local state; review them with the provider before enabling live collection.

### Block or replace a bank

- Use **Block new contributions**, with password/MFA and reason. This is an immediate local gate, not provider cancellation or a settlement freeze.
- Review outstanding checkouts, payments, disputes and unsettled balances with Paystack. Never change the bank details of a verified provider subaccount in place: old transaction routing must remain attributable.
- Deactivate the old provider subaccount. **Allow bank replacement after review** requires a blocked local account, provider inactivity when its code is known, an explicit absent/inactive-and-settlements-reviewed confirmation, and a reason. For an unresolved creation with no stored provider code, the operator must establish absence or recover/deactivate it externally; absence is not inferred from a timeout.
- The reset is audited with the prior masked bank/subaccount identity. It releases onboarding for a fresh request; it does not rewrite old payment routes. The new account must pass the complete review again. External in-flight creation/checkout/settlement must be handled by the operator, not assumed cancelled by the reset.

## Access, privacy and operations

- Only an event owner can buy/view package billing. Collaborators do not gain billing authority from event-admin access.
- Platform administration requires `users.platform_role='admin'`; registration cannot assign that role. Bootstrap a reviewed operator with a controlled database change, e.g. `UPDATE users SET platform_role='admin' WHERE email='your-reviewed-operator-address';`. Verify the actual address and audit the change; there is no public role-promotion endpoint.
- Financial configuration, approval, block/reset and order closure require password reauthentication plus a one-time MFA/recovery proof if enrolled. Proof consumption and database changes commit atomically. Admin views expose masked bank data only; do not put account numbers, identity documents or secrets in reasons/logs.
- Events with package orders join the financial-retention guard, including unresolved/closed orders. Automatic account/event deletion cannot erase retained finance. Account and event exports use allowlisted projections; provider-held financial records and backup deletion remain separate processes.
- Monitor `BILLING_RECONCILIATION_UNAVAILABLE`, unresolved package orders, uncertain payout requests, unexpected late payments, and contribution destination mismatches. Review more than the first 100 operator rows through controlled database/reporting access if volume exceeds the current console limit.
- Enroll/verify organizers against Paystack test accounts first; validate actual subaccount response fields, fee allocation, webhook payloads, bank ownership evidence, old-route handling and real settlement before launch. Automated tests use provider fixtures, not live financial acceptance.

## Still outside this implementation

Recurring subscriptions; automated KYC/document verification; provider settlement/dispute/refund ingestion and refund execution; net-payout accounting; automated tax invoices; accounting exports beyond the ledgers; legally approved pricing/consent/retention policies; operator case management at scale. See [READINESS.md](READINESS.md). These gaps are not fixed merely by adding API keys.
