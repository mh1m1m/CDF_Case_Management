# ADR-013: Records, retention, legal hold and disposition

- **Status:** Proposed (2026-10-07). Database layer implemented in CDF-69 (`20261007001300_records.sql`, `20261007001310_records_commands.sql`, logical disposition only); records UI and application services are a follow-up. Two implementation choices are recorded in RECORDS_RETENTION §4: the schedule is computed at closure, and `ARCHIVE_CASE` has no class guard.
- **Linear:** CDF-61 (EPIC 13, CDF-18). Production substitutions: CDF-36 (Alibaba OSS WORM), CDF-38 (Alibaba KMS/HSM), CDF-39 (SLS → CDF SIEM).
- **Protocol:** §24–§30, §35–§36 (records lifecycle, legal hold; see BASELINE_ANALYSIS gap table), §68, §87, §88. Implementation plan Phase 11 ("Legal hold blocks disposition").
- **Detail:** [`RECORDS_RETENTION.md`](../data-model/RECORDS_RETENTION.md) (entities, states, RLS, audit events) and [`RECORDS_TEST_DEFINITIONS.md`](../threat-model/RECORDS_TEST_DEFINITIONS.md) (positive and negative test definitions).

## Context

A closed investigation case is a government record. The Drive architecture document ("architecture", sections 16 and 24) requires record classification, a retention category, a retention trigger, legal hold, archival status, disposition approval, a destruction certificate, transfer to the records/archive function and an immutable disposition audit, and states that nobody, the system administrator included, has a generic "delete case" action. It also states that retention periods must come from an approved CDF retention schedule (CDF Records & Archives Policy), not from developers.

What exists today (PR #7 head `54786e4`):

- `case_mgmt.case_record` already reserves `retention_class` (default `UNASSIGNED`), `legal_hold_status` (`NONE` | `ACTIVE`) and `records_state` (`ACTIVE`, `CLOSED`, `RETENTION`, `ARCHIVED`, `DISPOSITION_ELIGIBLE`, `DISPOSITION_PENDING`, `DISPOSED`). Only `ACTIVE`, `CLOSED` and `ARCHIVED` are reachable, through workflow states `CLOSURE` and `ARCHIVE` (migration 0600); `ARCHIVE_CASE` is disabled.
- `config.setting` holds `RETENTION_PERIOD` as `SOURCE_REQUIRED` (migration 0400; risk R10).
- Role `RECORDS_OFFICER` exists with no permissions (migration 0200). `IMPLEMENTATION_PLAN.md` §7.4–7.5 names `LEGAL_HOLD_APPLY` and `authz.can_apply_legal_hold(case_id)`.
- Evidence versions, evidence items and custody events cannot be deleted or rewritten by any role, the owner included (migration 0900, ADR-006 Amendment 1). The audit ledger is append-only and hash-chained (ADR-005).
- Application roles have no write grants anywhere; every write is a `SECURITY DEFINER` command that records its audit event in the same transaction (ADR-003).

Drive was searched on 2026-10-07 for the CDF Records & Archives Policy, a retention schedule and the Delegation of Authority. None is in Drive. The CDF whistleblowing requirements report (19 January 2025) defines the ticket lifecycle up to closure but no retention rule. So every retention period, every disposition authority and every hold authority in this ADR is `SOURCE_REQUIRED`.

## Decision

### D1. A `records` schema owns the records lifecycle after closure

A new schema `records` holds retention classes, per-record retention schedules, legal holds, hold events, disposition requests and disposition certificates. The case master keeps its three reserved columns as the denormalised, policy-visible summary; only `records.*` command functions write them once a case has left `ACTIVE`. Interviews (CDF-60), form instances (CDF-50), evidence (ADR-006), reporter messages, triage records and the identity vault entry are covered **through their case**: they carry no retention or hold columns of their own.

### D2. Retention classes are reference data with `SOURCE_REQUIRED` values

`records.retention_class` rows ship in a migration, like roles and workflow definitions. Each row carries a category (`PERMANENT` or `TEMPORARY`), a retention period, a trigger event and a disposition action, each with its own source reference. A class whose period, trigger or action has no approved source has status `SOURCE_REQUIRED`, and the database refuses to compute a disposition date for it. The prototype ships the class **codes** proposed in `RECORDS_RETENTION.md` §3 with every value `SOURCE_REQUIRED`; no number is invented. When CDF supplies the schedule, a migration sets the values and their `source_reference`, and the class becomes `CONFIGURED`. The single `config.setting` key `RETENTION_PERIOD` is superseded by the per-class rows and kept as `SOURCE_REQUIRED` with a pointer to them.

### D3. Retention is triggered by a lifecycle event, and reopening resets it

The retention clock starts at the class's trigger event (proposed default: case closure, `closed_at`; confirmation required). A case that is reopened (`REOPEN_CASE`) loses its schedule and gets a new one at the next closure. Schedule rows are append-only; a reset supersedes the previous row instead of updating it.

### D4. Legal hold is an orthogonal flag, not a lifecycle state

The Drive document lists "LEGAL HOLD" among case states. This design keeps it orthogonal instead: a held case stays in whichever records state it was in, because a hold can arrive at any point (including during an active investigation) and must not erase where the case was in its lifecycle. `case_record.legal_hold_status = 'ACTIVE'` exactly when at least one hold covering the case is not `RELEASED`. This is a deliberate deviation from the Drive state list, surfaced here rather than silently chosen.

- **Scope:** a hold covers a whole case (and so every record linked to it) or one evidence item. A case-level hold is the default; an item-level hold exists for a hold that must outlive the case's own disposition (for example, one exhibit needed in separate litigation).
- **Place:** one person with `LEGAL_HOLD_APPLY` who can see the case's records metadata and is not conflicted on it. Placing a hold only ever prevents destruction, so a single actor may place one immediately; delaying preservation is the larger risk.
- **Release:** two people. A holder of `LEGAL_HOLD_RELEASE` requests release with a justification; a **different** holder of `LEGAL_HOLD_RELEASE` approves or rejects it (the `reveal_request` pattern from migration 0400: `decided_by <> requested_by`). The hold stays fully effective while the release is pending.
- **Authority:** which CDF office may place and release holds is `SOURCE_REQUIRED` (Legal Policy / Delegation of Authority). The prototype maps the permissions to roles as a configurable default (`RECORDS_RETENTION.md` §6) and labels it so.

### D5. Hold blocks disposition and every destructive path, enforced in the database

- Disposition request, approval and execution each call `records.assert_no_active_hold(case_id)` after taking `FOR UPDATE` on the `case_record` row. Placing a hold takes the same lock, so a hold and a disposition cannot interleave.
- Placing a hold on a case in `DISPOSITION_ELIGIBLE` or `DISPOSITION_PENDING` returns it to `RETENTION` and moves any open disposition request to `BLOCKED_BY_HOLD`, in the same transaction.
- No hard delete exists for protected records. The existing triggers on evidence and audit stay; the implementation adds `BEFORE DELETE` / `BEFORE TRUNCATE` triggers on `case_mgmt.case_record` and on every `records.*` table, raising for every role, the owner included.
- Under a hold, the evidence rules of ADR-006 already keep every `AVAILABLE` version immutable; the implementation adds that no future command (supersede, withdraw, reclassify downward) may change the status of a held evidence item or its versions.

### D6. Disposition is a two-person, audited, certified process

`ARCHIVED` → `RETENTION` (records officer confirms the class) → `DISPOSITION_ELIGIBLE` (period elapsed, class `CONFIGURED`, no hold) → `DISPOSITION_PENDING` (request by `DISPOSITION_REQUEST`) → approval by a **different** holder of `DISPOSITION_APPROVE` → execution → `DISPOSED` with a disposition certificate. Rejection returns the case to `RETENTION` with a mandatory reason. Eligibility is recomputed by a command (`api.refresh_disposition_eligibility`), run by a records officer in the prototype and by a scheduled job in production; it never disposes anything by itself.

The disposition certificate (`records.disposition_certificate`) is immutable and records: certificate number, case UUID and number, retention class, trigger and dates, requester and approver with timestamps, the hold check result, the disposition action, a manifest of evidence version UUIDs with their SHA-256 values (hashes, never content), the audit `event_id` and `event_hash` of the execution event, and `certificate_hash = sha256(canonical payload)`.

### D7. What "execution" does in the prototype: logical disposition only

Physically destroying case content and evidence objects needs a narrowly scoped bypass of the immutability triggers (ADR-005, ADR-006) and a delete capability on the storage port, which ADR-006 deliberately does not have. That is a security trade-off and a destructive path, which CLAUDE.md §8 reserves for a human decision. So the implementation story delivers **logical disposition**:

- `records_state = 'DISPOSED'`; case content becomes invisible to every application role (RLS: `authz.can_view_case` returns false for `DISPOSED` cases), while records metadata and the certificate stay visible to `RECORDS_VIEW`.
- The certificate's `disposition_action` records what the schedule requires (`DESTROY`, `TRANSFER_TO_ARCHIVE` or `ANONYMISE`) and `execution_mode = 'LOGICAL_ONLY'`.
- Physical destruction (OSS object deletion after the retention lock expires, content purge or anonymisation in RDS) and transfer to the CDF archive function / NCAR are **PRODUCTION_SUBSTITUTION_REQUIRED** and need a separate ADR and a human decision before any code exists.

### D8. Records operations are audited, and the audit ledger is never disposed of by the application

Every records command writes its audit event in the same transaction (event catalogue in `RECORDS_RETENTION.md` §8). Metadata carries identifiers and codes only: hold justifications, release reasons and rejection reasons stay in their `records.*` rows, and the audit `reason` carries a reason code. Refused attempts are recorded as `SECURITY` events by the application layer (existing `COMMAND_DENIED` pattern). The audit ledger is outside every retention class: the application never disposes of it, and its long-term retention is the SIEM's (CDF-39) under a schedule that is itself `SOURCE_REQUIRED`.

### D9. Access model

New permissions: `RECORDS_VIEW`, `RETENTION_CLASS_ASSIGN`, `LEGAL_HOLD_APPLY`, `LEGAL_HOLD_RELEASE`, `DISPOSITION_REQUEST`, `DISPOSITION_APPROVE`. `RECORDS_VIEW` grants a column-limited records view (case number, classification, states, dates, class, hold flag), **never** case content: `authz.can_view_case` is unchanged and does not consult it. `PLATFORM_ADMIN` and `DB_ADMIN` receive none of these permissions (CLAUDE.md §4). A user conflicted on a case cannot place, request release of, or decide anything on it. New predicates: `authz.can_view_records(case_id)`, `authz.can_apply_legal_hold(case_id)`, `authz.can_release_legal_hold(case_id)`, `authz.can_request_disposition(case_id)`, `authz.can_approve_disposition(case_id)`. The six permissions and their role defaults are mirrored in `@cdf/authorization`; the predicates themselves live only in the database (the application pre-check uses the permissions).

## Consequences

- \+ Premature destruction needs two people, a configured schedule, no active hold under lock, and leaves a certificate and a hash-chained audit trail.
- \+ Unauthorised hold release needs two distinct holders of `LEGAL_HOLD_RELEASE`; the hold keeps working while release is pending.
- \+ No retention number is invented. With every class `SOURCE_REQUIRED`, nothing in the prototype can become eligible for disposition, which is the safe failure mode.
- − Nothing is physically destroyed in the prototype. Storage and database volume grow, and the design cannot demonstrate PDPL storage limitation end to end until D7's follow-up ADR is decided.
- − Legal hold as a flag differs from the Drive state list (D4). If CDF requires hold to appear as a state in reporting, the records view can expose a derived display state without changing the model.
- − A database superuser can still disable triggers (ADR-005 consequence). External immutability for certificates and holds is the WORM and SIEM substitutions below.

## Production mapping

| Prototype control                                     | Production equivalent                                                                                                                                                                                | Status                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Hold and no-delete enforced by triggers and commands  | Same commands on RDS PostgreSQL, plus OSS retention policy (WORM, compliance mode) on the evidence buckets (CDF-36); object-level hold if the OSS service supports it (VENDOR_CONFIRMATION_REQUIRED) | PRODUCTION_SUBSTITUTION_REQUIRED (storage)                |
| Logical disposition (D7)                              | OSS lifecycle deletion after retention lock expiry; RDS content purge or anonymisation; archive transfer to CDF records function / NCAR                                                              | PRODUCTION_SUBSTITUTION_REQUIRED; human decision required |
| Certificate `certificate_hash` (SHA-256, unsigned)    | Certificate signed through `KeyManagementProvider` with an HSM-held key (CDF-38); certificate copy in WORM storage (CDF-36)                                                                          | PRODUCTION_SUBSTITUTION_REQUIRED                          |
| Records audit events in `audit.audit_event`           | Streamed to SLS → CDF SIEM; chain heads anchored in WORM (CDF-39, ADR-005)                                                                                                                           | PRODUCTION_SUBSTITUTION_REQUIRED (SIEM)                   |
| `api.refresh_disposition_eligibility` run by a person | Scheduled job under a service identity, still unable to dispose                                                                                                                                      | Planned                                                   |
| Retention classes with `SOURCE_REQUIRED` values       | CDF retention schedule from the Records & Archives Policy, approved by the competent authority                                                                                                       | SOURCE_REQUIRED                                           |

## Requirements

`CDF-REC-001` (parent) and `CDF-REC-002` to `CDF-REC-008` in [`requirements.yaml`](../../compliance/requirements/requirements.yaml).

## Open decisions (SOURCE_REQUIRED or human decision)

1. Retention period, trigger event, category and disposition action for each class: CDF Records & Archives Policy / retention schedule (not in Drive).
2. Who may place and release a legal hold, and who approves disposition: CDF Legal Policy and Delegation of Authority (not in Drive).
3. Retention of the reporter identity vault entry, which PDPL storage limitation may require to be shorter than the case's: DPO decision.
4. Physical destruction and archive transfer (D7): separate ADR and human decision.
5. Audit ledger retention in the SIEM: CDF SOC / records function.
6. NCAR and PDPL clauses cited by the Drive document are not yet verified against official sources: REGULATORY_CONFIRMATION_REQUIRED.
