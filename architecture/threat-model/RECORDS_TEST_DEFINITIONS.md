# Records, Retention and Legal Hold — Test Definitions

Status: **definitions only, not implemented** (CDF-61, [ADR-013](../adr/ADR-013-records-retention-legal-hold.md), [`RECORDS_RETENTION.md`](../data-model/RECORDS_RETENTION.md)). No test file below exists yet, and none may be added as a passing placeholder: the implementation story writes each test against the real migration and the requirement stays `NOT_STARTED` until it passes.

Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Fixtures use synthetic users (`@example.test`) and `CDF-DEMO-*` cases only.

## Threats addressed

These extend [`THREAT_MODEL.md`](THREAT_MODEL.md); the implementation story adds them as rows there.

| ID  | Threat                                                             | Control (ADR-013)                                                            |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| T25 | Premature destruction of a case or its evidence                    | D5, D6: configured schedule, two-person approval, hold check under lock      |
| T26 | Unauthorised or single-person legal hold release                   | D4: `LEGAL_HOLD_RELEASE`, requester ≠ approver, hold effective while pending |
| T27 | Audit bypass: records operations without trace, or ledger disposal | D8: same-transaction audit events; ledger outside every retention class      |
| T28 | Hold and disposition racing each other                             | D5: `FOR UPDATE` on `case_record` in both paths                              |
| T29 | Records staff reading case content through records views           | D9, RLS §7: column-limited view, `can_view_case` unchanged                   |
| T30 | Evidence under hold superseded, withdrawn or reclassified away     | D5, RECORDS_RETENTION §5.4                                                   |

## Fixtures

New synthetic users (seed, implementation story): `records@example.test` (RECORDS_OFFICER), `records.b@example.test` (RECORDS_OFFICER), `legal@example.test` (LEGAL_REVIEWER), `legal.b@example.test` (LEGAL_REVIEWER). Existing: `grc.director`, `grc.deputy`, `investigator.a`, `investigator.b`, `admin`, `audit`, `revoked`.

Cases: `CDF-DEMO-2026-0101` archived, class `WB_CASE_INVESTIGATED`; `CDF-DEMO-2026-0102` active, with two evidence items; `CDF-DEMO-2026-0103` restricted, archived. Test-only class `TEST_SHORT_RETENTION` with `CONFIGURED` status, `TEMPORARY`, `retention_period = '1 day'`, `source_reference = 'TEST FIXTURE — NOT A CDF VALUE'`, inserted by the test setup inside a rolled-back transaction, never by a migration or the seed. Time is controlled by setting `trigger_at` in the past, not by sleeping.

Target files: `tests/security/records-legal-hold.spec.ts`, `tests/security/records-disposition.spec.ts`, `tests/integration/records.spec.ts`, `tests/integration/mirrors.spec.ts` (extended), `packages/domain` unit tests, `tests/e2e/records.spec.ts`.

## A. Legal hold placement

| ID      | Type     | Given                                                         | When                                                                                          | Then                                                                                                                             |
| ------- | -------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| REC-T01 | positive | `legal` (LEGAL_HOLD_APPLY), case 0101 visible in records view | `api.place_legal_hold(0101, 'CASE', null, 'LITIGATION', <20+ chars>)`                         | Hold `ACTIVE`; `legal_hold_status = 'ACTIVE'`; `LEGAL_HOLD_PLACED` in the same transaction with ids only; `legal_hold_event` row |
| REC-T02 | negative | `investigator.a` (assigned to 0102, no LEGAL_HOLD_APPLY)      | place a hold on 0102                                                                          | `CDF_FORBIDDEN`; no hold row; application records `COMMAND_DENIED` (SECURITY)                                                    |
| REC-T03 | negative | `admin` (PLATFORM_ADMIN)                                      | place a hold on 0101                                                                          | Refused; PLATFORM_ADMIN holds no records permission                                                                              |
| REC-T04 | negative | `legal` with a declared conflict on 0101                      | place a hold                                                                                  | Refused (conflict overrides); no hold                                                                                            |
| REC-T05 | negative | `legal`, case 0103 restricted, no assignment or grant         | place a hold                                                                                  | `CDF_NOT_FOUND`, indistinguishable from a non-existent case (SECURITY_RULES A-7)                                                 |
| REC-T06 | negative | `revoked` user who held LEGAL_HOLD_APPLY                      | place a hold                                                                                  | Refused: `current_user_id()` requires an ACTIVE profile                                                                          |
| REC-T07 | negative | any role                                                      | `INSERT`/`UPDATE`/`DELETE` directly on `records.legal_hold`                                   | Permission denied: no table write grants                                                                                         |
| REC-T08 | positive | `legal`, evidence item EV-001 on 0102                         | place an `EVIDENCE_ITEM` hold                                                                 | Hold scoped to the item; `has_active_hold(0102, EV-001)` true; case flag `ACTIVE`                                                |
| REC-T09 | negative | `legal`                                                       | justification of 5 characters; or `EVIDENCE_ITEM` scope with an evidence id from another case | Validation error; no row                                                                                                         |

## B. Legal hold release (two-person)

| ID      | Type     | Given                                               | When                                                                          | Then                                                                                         |
| ------- | -------- | --------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| REC-T10 | positive | Active hold on 0101; `legal` requests release       | `legal.b` approves                                                            | Hold `RELEASED`; flag `NONE`; `LEGAL_HOLD_RELEASE_REQUESTED` then `LEGAL_HOLD_RELEASED`      |
| REC-T11 | negative | `legal` requested release                           | `legal` approves own request                                                  | Refused (`decided_by <> requested_by` check and command guard); hold stays `RELEASE_PENDING` |
| REC-T12 | negative | Hold `RELEASE_PENDING`                              | disposition request on the case                                               | Refused `CDF_CONFLICT:LEGAL_HOLD_ACTIVE`: pending release is still a hold                    |
| REC-T13 | negative | `records` (LEGAL_HOLD_APPLY, no LEGAL_HOLD_RELEASE) | request release                                                               | Refused                                                                                      |
| REC-T14 | positive | Two active holds on 0101                            | one released (two people)                                                     | Flag stays `ACTIVE` until the second is released                                             |
| REC-T15 | positive | Release rejected by `legal.b`                       | —                                                                             | Hold back to `ACTIVE`; `LEGAL_HOLD_RELEASE_REJECTED`; a new release request is allowed       |
| REC-T16 | negative | Hold `RELEASED`                                     | update any column of the hold or release row through any path, owner included | Trigger raises; row unchanged                                                                |

## C. Hold blocks disposition and deletion

| ID      | Type     | Given                                                | When                                                                                                                          | Then                                                                                                          |
| ------- | -------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| REC-T17 | negative | 0101 on `TEST_SHORT_RETENTION`, elapsed, active hold | `api.refresh_disposition_eligibility`                                                                                         | Case stays `RETENTION`; no `DISPOSITION_ELIGIBLE_MARKED`                                                      |
| REC-T18 | negative | 0101 `DISPOSITION_ELIGIBLE`                          | hold placed                                                                                                                   | Case → `RETENTION` in the same transaction                                                                    |
| REC-T19 | negative | 0101 `DISPOSITION_PENDING` with an open request      | hold placed                                                                                                                   | Request `BLOCKED_BY_HOLD`; case `RETENTION`; `DISPOSITION_BLOCKED_BY_HOLD` audited                            |
| REC-T20 | negative | Request `APPROVED`, hold placed before execution     | `api.execute_disposition`                                                                                                     | Refused `LEGAL_HOLD_ACTIVE`; no certificate; case not `DISPOSED`                                              |
| REC-T21 | race     | Eligible case                                        | two concurrent transactions: place hold / execute disposition                                                                 | Exactly one wins; never both a certificate and an active hold that predates it (lock on `case_record`)        |
| REC-T22 | negative | Any case, any role including the table owner         | `DELETE` or `TRUNCATE` on `case_mgmt.case_record` or any `records.*` table                                                    | Trigger raises for every role                                                                                 |
| REC-T23 | negative | Evidence item under case or item hold                | any status change on the item or its versions, classification lowering, `current_version_id` moved off an `AVAILABLE` version | Refused; versions and custody unchanged (extends `evidence-access.spec.ts`)                                   |
| REC-T24 | positive | Evidence item under hold, case still `ACTIVE`        | investigator uploads a new version                                                                                            | Allowed; earlier versions stay `AVAILABLE` and immutable (a hold preserves, it does not freeze investigation) |

## D. Retention schedule

| ID      | Type     | Given                                            | When                                                | Then                                                                              |
| ------- | -------- | ------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| REC-T25 | negative | Class `SOURCE_REQUIRED` (every shipped class)    | archive, assign class, refresh eligibility          | `retain_until` null; never `DISPOSITION_ELIGIBLE`                                 |
| REC-T26 | positive | Class `TEST_SHORT_RETENTION`, trigger 2 days ago | refresh eligibility                                 | `DISPOSITION_ELIGIBLE`; `DISPOSITION_ELIGIBLE_MARKED`                             |
| REC-T27 | positive | Case `CLOSED` with schedule                      | `REOPEN_CASE`                                       | Schedule superseded (`REOPENED`), not updated in place; a new one at next closure |
| REC-T28 | negative | `investigator.a`                                 | `api.assign_retention_class`                        | Refused (no RETENTION_CLASS_ASSIGN)                                               |
| REC-T29 | negative | Migration lint                                   | a class row `CONFIGURED` without `source_reference` | Check constraint rejects it                                                       |

## E. Disposition approval and certificate

| ID      | Type     | Given                                                 | When                                                                        | Then                                                                                                                                                                                                           |
| ------- | -------- | ----------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REC-T30 | positive | 0101 eligible; `records` requests                     | `grc.director` approves; execution runs                                     | Case `DISPOSED`; certificate issued with `active_holds_found = 0`, `execution_mode = 'LOGICAL_ONLY'`, evidence manifest of version ids + SHA-256, audit `event_id`/`event_hash`; `certificate_hash` recomputes |
| REC-T31 | negative | `records` requested                                   | `records` approves own request                                              | Refused                                                                                                                                                                                                        |
| REC-T32 | negative | `records.b` (RECORDS_OFFICER, no DISPOSITION_APPROVE) | approve                                                                     | Refused                                                                                                                                                                                                        |
| REC-T33 | negative | Case `RETENTION`, not eligible                        | request disposition                                                         | Refused `CDF_CONFLICT`                                                                                                                                                                                         |
| REC-T34 | negative | Request `PENDING`                                     | execute without approval                                                    | Refused                                                                                                                                                                                                        |
| REC-T35 | positive | Request rejected with reason                          | —                                                                           | Case back to `RETENTION`; `DISPOSITION_REJECTED`; reason in the request row, code only in audit                                                                                                                |
| REC-T36 | negative | Certificate issued                                    | any `UPDATE`/`DELETE`, owner included                                       | Trigger raises                                                                                                                                                                                                 |
| REC-T37 | negative | Case `DISPOSED`                                       | `investigator.a` (was assigned) opens case, lists cases, downloads evidence | `CDF_NOT_FOUND`; not listed; download denied with `EVIDENCE_ACCESS_DENIED`                                                                                                                                     |
| REC-T38 | positive | Case `DISPOSED`                                       | `records` reads records view and certificate                                | Metadata and certificate visible; no title, summary, people, allegations                                                                                                                                       |
| REC-T39 | negative | Case `DISPOSED`                                       | any records or case command                                                 | Refused: `DISPOSED` is terminal                                                                                                                                                                                |

## F. Audit and data minimisation

| ID      | Type     | Given                                 | When                                                                    | Then                                                                                    |
| ------- | -------- | ------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| REC-T40 | positive | Full flow REC-T01 → REC-T10 → REC-T30 | `audit.verify_chain()`                                                  | Chain intact; one event per command, in order                                           |
| REC-T41 | negative | Any records event                     | inspect `metadata` and `reason`                                         | No justification text, names or case content; ids and codes only (`assertSafeMetadata`) |
| REC-T42 | negative | Any role, owner included              | `UPDATE`/`DELETE`/`TRUNCATE` on `audit.audit_event` after a disposition | Raises (existing `audit-immutability.spec.ts` extended with records events)             |
| REC-T43 | negative | Every retention class                 | search for a class or command touching `audit.*`                        | None exists: the ledger is outside retention                                            |
| REC-T44 | negative | Refused records command               | application layer                                                       | `COMMAND_DENIED` SECURITY event recorded in a separate transaction                      |

## G. Records view isolation

| ID      | Type     | Given                                              | When                                           | Then                                                                    |
| ------- | -------- | -------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| REC-T45 | negative | `records` (RECORDS_VIEW only)                      | `api.get_case(0101)`, case list, evidence list | Not visible: RECORDS_VIEW does not imply case content                   |
| REC-T46 | negative | `records`, restricted case 0103 without grant      | records view                                   | Not listed                                                              |
| REC-T47 | negative | `investigator.a` (case viewer, no hold permission) | select `records.legal_hold`                    | No rows; only `legal_hold_status` on the case                           |
| REC-T48 | positive | `rls-coverage.spec.ts`                             | run                                            | Every `records.*` table has RLS enabled and no write grants             |
| REC-T49 | positive | `mirrors.spec.ts`                                  | run                                            | `@cdf/authorization` records predicates and role map equal the database |

## H. End to end (Arabic and English)

| ID      | Type     | Steps                                                                                                                            | Then                                                                    |
| ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| REC-T50 | positive | `legal` places a hold on 0101 from the records page (Arabic UI); `records` sees "Disposition blocked by legal hold" on the queue | Hold badge has text, not colour only; axe clean                         |
| REC-T51 | positive | `records` opens a disposition certificate (English UI)                                                                           | Certificate shows number, dates, approvers, manifest hashes; no content |
