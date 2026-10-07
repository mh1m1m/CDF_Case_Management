# ADR-012: Interviews domain

- **Status:** Accepted (2026-10-07), implemented for EPIC 09 (Linear CDF-60)
- **Protocol:** §19, §22, §29, §37, §43, §45, §83
- **Migration:** `20261007001200_interviews.sql` (range 1200–1299 reserved for interviews)

## Context

Investigators need to plan, schedule and record interviews with witnesses, subjects and (where the reporter chose to be contactable) the reporter, and to produce a statement that the interviewee acknowledges and that a reviewer and an approver sign off. The record must be trustworthy later: who was present, which rights notice was given, exactly which text was acknowledged, and who approved it.

No CDF interview policy, rights notice wording, approval matrix or retention rule was found in Drive (searched 2026-10-07). Every business rule below that is not derived from CLAUDE.md or an earlier ADR is marked `SOURCE_REQUIRED` and is configurable or easy to change.

## Decision

### Data model (`case_mgmt` schema)

| Table                         | Purpose                                                                                                                                                        | Mutability                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `interview`                   | Header: case, `INT-NNN` sequence, title, purpose, interviewee kind and label, classification, schedule, rights, conduct times, lifecycle actors, `row_version` | Updated only by `api.*` commands; frozen once `APPROVED` or `CANCELLED`; identity columns never change; no delete or truncate |
| `interview_participant`       | Panel: one `LEAD_INTERVIEWER`, any `INTERVIEWER` / `NOTE_TAKER`                                                                                                | Append-only                                                                                                                   |
| `interview_notice`            | `INVITATION` / `RESCHEDULE` with channel and a snapshot of the scheduled start                                                                                 | Append-only                                                                                                                   |
| `interview_statement_version` | Statement text, language, `content_sha256` computed by a trigger                                                                                               | Append-only; a correction is a new version                                                                                    |
| `interview_statement_ack`     | Acknowledgement of one version: method and the attested SHA-256                                                                                                | Append-only; one per version                                                                                                  |
| `interview_recording`         | Link to a Phase 7 evidence item (audio, video or signed document)                                                                                              | Append-only                                                                                                                   |

Tables live in `case_mgmt` so the existing RLS-coverage test and the policy snapshot cover them without changes to shared tooling. `interview.form_instance_id` is a soft link reserved for the forms engine (CDF-50, ADR-011); there is no foreign key so the two domains can merge in either order.

### Interviewee identity (§22)

- `WITNESS`, `SUBJECT`, `OTHER`: a pseudonymous working label is required (2–200 characters); an optional `case_person_id` must belong to the same case.
- `REPORTER`: allowed only when the case has a `reporter_wb_id`; the label and person link must be empty (database check constraints and command validation). The reporter is referenced only through the case's `wb_id`; nothing in the interviews domain reads `protected_identity`. Notices to the reporter must use `PORTAL_MESSAGE`, and only the reporter may be sent one.

### Lifecycle

`PLANNED → SCHEDULED → CONDUCTED → PREPARED → REVIEWED → APPROVED`, with `RETURN` (from `PREPARED` or `REVIEWED` back to `CONDUCTED`, reason required) and `CANCEL` (from `PLANNED` or `SCHEDULED`, reason required). `packages/domain` mirrors the table (`INTERVIEW_TRANSITIONS`); `tests/integration/interviews.spec.ts` asserts the mirror against `api.transition_interview`.

Preconditions enforced by the database:

- Conducting needs an `INVITATION` notice and a recorded rights acknowledgement (`RIGHTS_NOT_ACKNOWLEDGED`, `NOTICE_NOT_ISSUED`).
- Rights are recorded once, while `SCHEDULED`, by a panel interviewer (`NOT_INTERVIEWER`).
- Preparing needs a current statement version with an acknowledgement of that exact version (`STATEMENT_MISSING`, `STATEMENT_NOT_ACKNOWLEDGED`). A new version after an acknowledgement makes the interview un-preparable until the new version is acknowledged.
- An acknowledgement must quote the version's SHA-256 (`STATEMENT_HASH_MISMATCH`).

### Statement integrity

The database computes `content_sha256 = sha256(convert_to(content, 'UTF8'))` in a `BEFORE INSERT` trigger and ignores any supplied value. The validation layer canonicalises text to Unicode NFC with LF line endings before it reaches the database, so the same words always hash the same; `statementSha256()` in `packages/domain` reproduces the hash for display and tests. Audit metadata carries the hash and length, never the text (§83).

### Authorization (§19)

New functions are built only from existing `authz` helpers; nothing in the authorization core changes, and no new permission codes are added.

- `authz.can_view_interview(id)`: `can_view_case` **and** interview classification ≤ viewer clearance **and** need-to-know: an active assignment, or `CASE_VIEW_ALL` on a non-restricted case, or an active grant whose scope is not `TRIAGE`. A triage-only grant sees that the case exists, not its interviews.
- `authz.can_conduct_interviews(case)`: an `ACTIVE` visible case and `CASE_EDIT_ALL` or an assignment as owner, lead or investigator (the same relationship evidence upload requires).
- `authz.can_review_interviews(case)`: owner, lead or reviewer assignment, or `CASE_EDIT_ALL`.
- `authz.can_approve_interviews(case)`: owner or lead assignment, or `CASE_EDIT_ALL`.
- Panel members added by `api.add_interview_participant` must be able to view the case and hold the clearance.

RLS: `SELECT` policies on all six tables call `can_view_interview`; the recording link additionally requires `can_view_evidence`. Application roles have no write grants; every write is an `api.*` `SECURITY DEFINER` function with `search_path = ''`.

### Separation of duties (`SOURCE_REQUIRED`)

The preparer cannot review or return their own work; the approver can be neither the preparer nor the reviewer. Enforced in `api.transition_interview`, by table check constraints, and pre-checked in `packages/domain` (`transitionBlockers`) so the UI shows the reason instead of a button.

### Audit (§29)

Every command writes one `BUSINESS` event: `INTERVIEW_PLANNED`, `_PARTICIPANT_ADDED`, `_SCHEDULED`, `_RESCHEDULED`, `_NOTICE_ISSUED`, `_RIGHTS_ACKNOWLEDGED`, `_CONDUCTED`, `_STATEMENT_RECORDED`, `_STATEMENT_ACKNOWLEDGED`, `_RECORDING_LINKED`, `_PREPARED`, `_REVIEWED`, `_APPROVED`, `_RETURNED`, `_CANCELLED`. Opening an interview (`api.open_interview`) writes `INTERVIEW_VIEWED`; a denied or missing target writes `INTERVIEW_ACCESS_DENIED` (`SECURITY`) and the caller cannot tell the two apart. Application-level denials are recorded as `COMMAND_DENIED`.

### No deletion

There is no delete command anywhere in the interviews module. Retention and legal hold (CDF-61/ADR-013, implemented as CDF-69) will add a hold check to these commands through `records.case_content_writable(case_id)` as a follow-up; this ADR does not implement hold logic.

### Application

`createInterviewService` (`packages/application`) validates with the shared Zod schemas, pre-checks lifecycle rules, calls `PostgresInterviewGateway`, and maps failures to safe `AppError`s. Pages: `/cases/[id]/interviews` (list and planning form) and `/cases/[id]/interviews/[interviewId]` (detail with one card per step). The case page is not changed in this ADR; its link to the interviews list belongs to the case page owner (CDF-58).

## Consequences

- Interview records are tamper-evident and complete: history is append-only, approved interviews are frozen, and the ledger shows every step.
- Corrections are visible as new statement versions rather than edits.
- Panel members cannot be removed (append-only); a wrong addition stays on record. Removal with a reason can be added later as an append-only "removed" event.
- `case_person` has no creation command yet, so most interviewees are referenced by label only.
- Interview audit labels exist under `interviews.auditAction` in i18n; the case timeline maps only the shared `auditAction` keys until the case page owner wires them in.

## Production mapping

No adapter is introduced. Statement text stays in PostgreSQL with the rest of the case record; recordings are evidence items and inherit ADR-006 (Alibaba OSS with WORM and KMS SSE in production). Electronic acknowledgement (`ELECTRONIC_ACK`) is a recorded attestation only; a production deployment would bind it to the approved e-signature or identity service (`PRODUCTION_SUBSTITUTION_REQUIRED`).

## Requirements

`CDF-INT-001` … `CDF-INT-006` in `compliance/requirements/requirements.yaml`; rules `IV-1` … `IV-9` in `architecture/SECURITY_RULES.md`.

## Open points (`SOURCE_REQUIRED`)

1. Interviewee rights notice wording, versioning and languages (the prototype records a version code such as `SYNTHETIC-RIGHTS-V1`).
2. Who may review and approve interview records, and whether approval needs two people beyond the preparer.
3. Whether a subject may bring a representative, and how that is recorded.
4. Whether audio or video recording needs separate consent and how refusal is recorded.
5. Retention period for interview records and statements (CDF Records & Archives Policy, requested from Fady under CDF-61).
6. Whether the reporter may be interviewed through any channel other than the anonymous portal.
