# ADR-025: Notification engine

- **Status:** Proposed (2026-10-12). Linear CDF-195.
- **Protocol:** §39, §48, §68, §83; owner Q&A Q29, Q98.

## Decision

1. Schema `notify`: `rule` rows in four layers — SYSTEM_MANDATORY (cannot be muted), COMMITTEE_DEFAULTS, EVENT_RULES, USER_PREFERENCES — resolved in that order of authority.
2. Channels IN_APP and EMAIL. Messages carry a template code, a business identifier and a deep link only; **no case content, names, allegations or evidence** (§39).
3. Commands write to `notify.outbox` in the same transaction as the domain event. A `NotificationSender` port delivers: in-app now; email adapter is a stub (PRODUCTION_SUBSTITUTION_REQUIRED: CDF mail relay; choosing a provider is a human decision).
4. Deadlines (minutes window, grievance window, defence deadline) emit reminder notifications through the scheduler port.

## Implementation notes (migration 1920)

- Schema `notify`: `template` (12 codes, reference data; wording in `packages/i18n` under `notificationTemplate`), `rule` (effective-dated; SYSTEM_MANDATORY rows come from the migration only and always deliver; COMMITTEE_DEFAULT and EVENT_RULE set by `api.set_notification_rule` with the new `NOTIFICATION_ADMIN` permission, held by PLATFORM_ADMIN), `preference` (a user's own mutes; `api.set_notification_preference` refuses mandatory templates with `MANDATORY_NOTIFICATION`), `outbox`.
- Resolution per template and channel: a mandatory rule delivers; otherwise the committee default for the notification's committee, else the event rule, decides; a user's mute then suppresses. Seeded defaults (SOURCE_REQUIRED): mandatory templates in app and by email; the others in app only.
- **No content (N18).** An outbox row holds recipient, template code, channel, object type and id, a deep link matching `^(/[a-z0-9-]+)+$`, a dedupe key and delivery state. Facts are immutable (trigger); rows are never deleted. The page behind the link re-authorizes.
- **Same transaction.** Triggers on `committee.membership`, `meeting_participant`, `meeting`, `minutes`, `decision.legal_review_request`, `grievance.defence_notice`, `grievance.grievance` and `grievance_outcome` queue notifications, so they commit or roll back with the domain event and no existing command changed. Only ACTIVE users are notified; a defence notice reaches only the subject's active portal link.
- **Delivery.** IN_APP rows are delivered by being visible to their recipient (RLS: own rows, IN_APP only); `api.mark_notification_read` marks one read (others' ids answer NOT_FOUND). EMAIL rows wait for the `NotificationSender` port: `notify.claim_email_batch`, `notify.record_email_delivery` (FAILED after five attempts) and `notify.emit_due_reminders` are granted to the BFF login role `cdf_bff` only, never to `authenticated` or `anon`, and return recipient, template and link only. `composeNotificationEmail` builds the text from fixed wording and the link.
- `PRODUCTION_SUBSTITUTION_REQUIRED`: the email adapter (`StubEmailSender`) sends nothing; the CDF mail relay and the directory lookup of addresses are a human decision. Reminders and delivery run from the prototype scheduler, not a CDF job service.
- **AGENT-09 review of 1920:** a grievance is announced only to secretaries who may handle it (N1, same predicate as access, so conflicted, uncleared and unapproved secretaries on a restricted case are not told it exists); a cancellation reaches only participants who still pass the case gate and declared no meeting conflict in the proceeding (N2); an invitation needs the case gate at the moment it is queued. Earlier notifications stay with their recipient; they carry no content and their object answers NOT_FOUND once access ends. AGENT-09's recipient probe is committed as the "every recipient can open its object" test.
- Tests: `tests/security/notifications.spec.ts`, notification IDOR probes, the audit walk, `packages/application/src/notifications.test.ts`.

## Requirements

Q29, Q98; negative test N18.
