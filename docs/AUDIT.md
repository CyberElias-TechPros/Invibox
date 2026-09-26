# Current audit

The 26 September 2026 audit found that the existing implementation and documentation overstated readiness. In particular, private visibility was unenforced; bulk upserts could mutate other events; schedule dates and invitation content were hard-coded; mutable client caches could overwrite RSVP data; staff check-in permissions did not match routes; authentication expiry compared incompatible date formats; and several operational UI controls reported success without a corresponding process.

These defects were addressed in the current branch. The detailed before/after matrix, verified tests, ordered stories and unresolved scope are maintained in [READINESS.md](READINESS.md).

This audit is a code review plus local test execution, not an independent penetration test or blanket production sign-off. Existing historical production data, if any, requires inspection before new integrity triggers are applied. External providers and deployed infrastructure were not exercised with live credentials.

On 27 September 2026, the follow-up added encrypted authenticator MFA and recovery, guest-photo submission/moderation/withdrawal, durable upload reservation cleanup, consent history and audit review, and unsaved-editor navigation guards. Local tests include RFC TOTP vectors, concurrent proof consumption, account-wide attempt bounds, password-reset/MFA interaction, photo access and storage failure cases, and browser-level workflows. This remains an implementation review rather than an independent security certification.
