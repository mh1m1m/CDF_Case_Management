# ADR-025: Notification engine

- **Status:** Proposed (2026-10-12). Linear CDF-195.
- **Protocol:** §39, §48, §68, §83; owner Q&A Q29, Q98.

## Decision

1. Schema `notify`: `rule` rows in four layers — SYSTEM_MANDATORY (cannot be muted), COMMITTEE_DEFAULTS, EVENT_RULES, USER_PREFERENCES — resolved in that order of authority.
2. Channels IN_APP and EMAIL. Messages carry a template code, a business identifier and a deep link only; **no case content, names, allegations or evidence** (§39).
3. Commands write to `notify.outbox` in the same transaction as the domain event. A `NotificationSender` port delivers: in-app now; email adapter is a stub (PRODUCTION_SUBSTITUTION_REQUIRED: CDF mail relay; choosing a provider is a human decision).
4. Deadlines (minutes window, grievance window, defence deadline) emit reminder notifications through the scheduler port.

## Requirements

Q29, Q98; negative test N18.
