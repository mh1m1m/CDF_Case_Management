# Records, Retention and Legal Hold — Data Model (design)

Status: **design, not implemented** (CDF-61, [ADR-013](../adr/ADR-013-records-retention-legal-hold.md)). Nothing here exists in a migration yet. The implementation story uses migration prefixes `20261007001300`–`20261007001399`. Where this document and a future migration disagree, the migration is authoritative and this document is corrected.

Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Retention values are `SOURCE_REQUIRED` throughout; none is invented.

This file is separate from [`DATA_MODEL.md`](DATA_MODEL.md) so that the forms (CDF-50) and interviews (CDF-60) work can append there without conflicts. When the implementation story lands, `DATA_MODEL.md` gains a short `## Records` section that links here.

## 1. What already exists (migrations 0200, 0400, 0600, 0700, 0900)

| Object                                              | Column / rule                                                                                          | Used by this design as                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `case_mgmt.case_record.retention_class`             | `text`, default `UNASSIGNED`, `^[A-Z_]{3,40}$`                                                         | FK target `records.retention_class.code` (with `UNASSIGNED` kept as a row) |
| `case_mgmt.case_record.legal_hold_status`           | `NONE` \| `ACTIVE`                                                                                     | Derived flag maintained only by hold commands (§5)                         |
| `case_mgmt.case_record.records_state`               | `ACTIVE`, `CLOSED`, `RETENTION`, `ARCHIVED`, `DISPOSITION_ELIGIBLE`, `DISPOSITION_PENDING`, `DISPOSED` | Records lifecycle (§4); values unchanged                                   |
| `case_mgmt.case_record.closed_at`                   | Set on entering `CLOSED`, cleared on reopen (`api.transition_case`)                                    | Default retention trigger timestamp                                        |
| `workflow.workflow_state.records_state`             | `CLOSURE` → `CLOSED`, `ARCHIVE` → `ARCHIVED`                                                           | Workflow hands the case to records at `ARCHIVE`                            |
| `config.setting` `RETENTION_PERIOD`                 | `SOURCE_REQUIRED`                                                                                      | Superseded by per-class rows; kept, with a description pointing to them    |
| `iam.role` `RECORDS_OFFICER`                        | No permissions                                                                                         | Receives records permissions (§6)                                          |
| Evidence immutability (0900)                        | No delete/truncate on `evidence.*`; `AVAILABLE`/`REJECTED` versions and custody events immutable       | Unchanged; hold adds a status freeze for future evidence commands (§5.4)   |
| Audit ledger (0300, ADR-005)                        | Append-only, hash-chained, owner-proof triggers                                                        | Records events (§8); never disposed of by the application                  |
| Evidence upload requires `records_state = 'ACTIVE'` | `authz.can_upload_evidence`                                                                            | Unchanged: closed, archived and held cases accept no new evidence          |

## 2. Entities (schema `records`)

All tables: UUID primary key, RLS enabled, `SELECT` only by policy, no write grants to `anon` or `authenticated`, owned by the migration role, `BEFORE DELETE` and `BEFORE TRUNCATE` triggers that raise for every role.

| Table                             | Purpose                                                                        | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Mutability                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `records.retention_class`         | Reference data: one row per class                                              | `code` (PK, `^[A-Z_]{3,40}$`), `name_en`, `name_ar`, `category` (`PERMANENT` \| `TEMPORARY` \| null), `retention_period` (`interval`, null), `trigger_event` (§3.2, null), `disposition_action` (`DESTROY` \| `TRANSFER_TO_ARCHIVE` \| `ANONYMISE` \| null), `source_reference`, `status` (`SOURCE_REQUIRED` \| `CONFIGURED`); check: `CONFIGURED` ⇔ all four values and `source_reference` are set                                                                             | Migrations only                                                                                |
| `records.retention_schedule`      | One row per retention computation for a case                                   | `case_id`, `retention_class`, `trigger_event`, `trigger_at`, `retain_until` (null when the class is `SOURCE_REQUIRED` or `PERMANENT`), `computed_at`, `computed_by`, `superseded_at`, `superseded_reason` (`REOPENED` \| `CLASS_CHANGED`); unique partial index: one non-superseded row per case                                                                                                                                                                                | Insert; one-way `superseded_at` stamp by definer function; nothing else                        |
| `records.legal_hold`              | A hold                                                                         | `hold_number` (`CDF-HOLD-YYYY-NNNN`, display only), `scope_type` (`CASE` \| `EVIDENCE_ITEM`), `case_id` (always set), `evidence_id` (set iff `EVIDENCE_ITEM`), `reason_code` (`LITIGATION` \| `REGULATORY_INQUIRY` \| `INTERNAL_INVESTIGATION` \| `AUDIT` \| `OTHER`), `justification` (20–2000 chars), `authority_reference` (nullable; `SOURCE_REQUIRED` until a DoA exists), `status` (`ACTIVE` \| `RELEASE_PENDING` \| `RELEASED`), `placed_by`, `placed_at`, `released_at` | Status moves `ACTIVE` ⇄ `RELEASE_PENDING` → `RELEASED` only via commands; other columns frozen |
| `records.legal_hold_release`      | Release request and decision (two-person)                                      | `hold_id`, `requested_by`, `requested_at`, `justification` (20–2000), `status` (`PENDING` \| `APPROVED` \| `REJECTED`), `decided_by`, `decided_at`, `decision_reason`; checks: `decided_by <> requested_by`, decision columns set ⇔ status ≠ `PENDING`; unique partial index: one `PENDING` per hold                                                                                                                                                                            | Decision columns written once                                                                  |
| `records.legal_hold_event`        | Append-only history of each hold (placed, release requested/approved/rejected) | `seq` (identity), `hold_id`, `event_type`, `actor_id`, `occurred_at`, `audit_event_id`                                                                                                                                                                                                                                                                                                                                                                                          | Fully immutable                                                                                |
| `records.disposition_request`     | A request to dispose of one case                                               | `case_id`, `retention_schedule_id`, `requested_by`, `requested_at`, `status` (`PENDING` \| `APPROVED` \| `REJECTED` \| `BLOCKED_BY_HOLD` \| `EXECUTED`), `decided_by`, `decided_at`, `decision_reason`, `executed_at`; checks: `decided_by <> requested_by`; unique partial index: one open (`PENDING` or `APPROVED`) request per case                                                                                                                                          | Status moves forward only via commands                                                         |
| `records.disposition_certificate` | Proof of a disposition (ADR-013 D6)                                            | `certificate_number` (`CDF-DISP-YYYY-NNNN`), `disposition_request_id` (unique), `case_id`, `case_number`, `retention_class`, `trigger_event`, `trigger_at`, `retain_until`, `requested_by/at`, `approved_by/at`, `holds_checked_at`, `active_holds_found` (must be 0), `disposition_action`, `execution_mode` (`LOGICAL_ONLY`), `evidence_manifest` (array of `{version_id, sha256}`), `audit_event_id`, `audit_event_hash`, `certificate_hash`                                 | Fully immutable                                                                                |

No table stores case content. `justification` and `decision_reason` are records-governance text written by records, legal and GRC staff, visible only to holders of the matching permissions (§7).

### Relationships

```
case_mgmt.case_record 1──* records.retention_schedule *──1 records.retention_class
case_mgmt.case_record 1──* records.legal_hold 1──* records.legal_hold_release
                                              1──* records.legal_hold_event
evidence.evidence     1──* records.legal_hold            (scope EVIDENCE_ITEM only)
case_mgmt.case_record 1──* records.disposition_request 1──0..1 records.disposition_certificate
```

## 3. Retention classes and triggers

### 3.1 Proposed class codes (all values `SOURCE_REQUIRED`)

The codes give the schedule a place to land; they are a proposal for the CDF records function to confirm, rename or replace. Every period, trigger, category and action column ships `null` with status `SOURCE_REQUIRED`.

| Code                       | Covers                                                                                    | Notes                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `UNASSIGNED`               | Any case before the records officer confirms a class                                      | Exists today as the column default; never eligible                        |
| `WB_CASE_INVESTIGATED`     | Cases that reached `INVESTIGATION`                                                        | Includes findings, committee and decision records once those phases exist |
| `WB_CASE_NOT_INVESTIGATED` | Cases closed by `SCREEN_OUT` or `OUT_OF_JURISDICTION`                                     | May warrant a shorter period under PDPL minimisation: DPO input           |
| `INTERNAL_REFERRAL_CASE`   | Cases with `source = 'INTERNAL_REFERRAL'`                                                 |                                                                           |
| `REPORT_NOT_ACCEPTED`      | Portal reports that never became a case (`CLOSED_NO_ACTION`, `DUPLICATE`, `REFERRED_OUT`) | Record type `REPORT`; second implementation increment (§10)               |

The audit ledger has no class: the application never disposes of it (ADR-013 D8). The identity vault entry follows its case's class unless the DPO sets a shorter rule (open decision 3).

### 3.2 Trigger events

| Trigger             | Timestamp used                          | Status                                               |
| ------------------- | --------------------------------------- | ---------------------------------------------------- |
| `CASE_CLOSED`       | `case_record.closed_at`                 | Proposed default; SOURCE_REQUIRED confirmation       |
| `CASE_ARCHIVED`     | Time of the `ARCHIVE_CASE` transition   | Alternative                                          |
| `DECISION_ISSUED`   | Final decision date (Phase 10)          | Alternative; available once decisions exist          |
| `ACTIONS_COMPLETED` | Corrective actions completed (Phase 10) | Alternative; available once corrective actions exist |
| `REPORT_CLOSED`     | Report status change to a closed status | For `REPORT_NOT_ACCEPTED`                            |

`retain_until = trigger_at + retention_period` is computed only when the class is `CONFIGURED` and `TEMPORARY`. Otherwise it is null and the case never becomes eligible.

## 4. Records lifecycle (`case_record.records_state`)

```
ACTIVE ──(workflow CLOSURE)──> CLOSED                                     [schedule computed from trigger]
CLOSED ──(workflow REOPEN_CASE)──> ACTIVE                                  [schedule superseded: REOPENED]
CLOSED ──(workflow ARCHIVE_CASE)──> ARCHIVED                              [recomputed only for CASE_ARCHIVED classes]
ARCHIVED ──(api.assign_retention_class, class ≠ UNASSIGNED)──> RETENTION
RETENTION ──(api.refresh_disposition_eligibility: retain_until ≤ now, CONFIGURED, no hold)──> DISPOSITION_ELIGIBLE
DISPOSITION_ELIGIBLE ──(api.request_disposition)──> DISPOSITION_PENDING
DISPOSITION_PENDING ──(api.decide_disposition reject)──> RETENTION
DISPOSITION_PENDING ──(api.decide_disposition approve → api.execute_disposition)──> DISPOSED   [certificate]
DISPOSITION_ELIGIBLE | DISPOSITION_PENDING ──(api.place_legal_hold)──> RETENTION   [open request → BLOCKED_BY_HOLD]
```

- `DISPOSED` is terminal. No transition leaves it.
- Legal hold is not a state (ADR-013 D4); `legal_hold_status` is shown alongside the state.
- `ARCHIVED` and later states are read-only for case content. Implemented as one guard trigger on `case_record` (`records.protect_case_record`, `CDF_CONFLICT:RECORDS_READ_ONLY`) rather than a check in every command, so no current or future command can bypass it; `DISPOSED` rejects every update (`CDF_CONFLICT:RECORDS_DISPOSED`). Case-linked modules (CDF-50, CDF-60) call the shared predicate in §9 for their own tables.
- Implementation note (CDF-69): the schedule is computed when the case enters `CLOSED`, not at `ARCHIVED`, so that a reopen can supersede it (REC-T27) and the default trigger (`CASE_CLOSED`) has its timestamp. `ARCHIVE_CASE` is enabled without a class guard: the records officer confirms the class after archiving (§9 first option).

## 5. Legal hold rules

1. **Place** (`api.place_legal_hold(case_id, scope_type, evidence_id, reason_code, justification, authority_reference)`): requires `authz.can_apply_legal_hold(case_id)`; locks the case row `FOR UPDATE`; inserts the hold `ACTIVE`; sets `legal_hold_status = 'ACTIVE'`; if the case is `DISPOSITION_ELIGIBLE` or `DISPOSITION_PENDING`, moves it to `RETENTION` and any open disposition request to `BLOCKED_BY_HOLD`; writes `LEGAL_HOLD_PLACED` (and `DISPOSITION_BLOCKED_BY_HOLD` when applicable). Allowed in every records state except `DISPOSED`.
2. **Request release** (`api.request_legal_hold_release(hold_id, justification)`): requires `authz.can_release_legal_hold(case_id)`; hold must be `ACTIVE` with no pending release; hold becomes `RELEASE_PENDING` (still effective).
3. **Decide release** (`api.decide_legal_hold_release(release_id, approve, reason)`): requires `authz.can_release_legal_hold(case_id)` and `actor <> requested_by`; approve → hold `RELEASED`, and `legal_hold_status` becomes `NONE` only if no other non-released hold covers the case; reject → hold back to `ACTIVE`. Neither path changes `records_state`: an eligible case must be re-evaluated by the next eligibility refresh.
4. **Evidence under hold:** while a hold covers an evidence item (case scope or item scope), no command may change the status of the item or any of its versions, lower its classification, or detach `current_version_id` from an `AVAILABLE` version. ADR-006 already makes `AVAILABLE` versions immutable; this extends the guarantee to future supersede or withdraw commands.
5. **Hold check function:** `records.has_active_hold(case_id, evidence_id default null) returns boolean` (`SECURITY DEFINER`, `search_path = ''`, stable) and `records.assert_no_active_hold(case_id)` which raises `CDF_CONFLICT:LEGAL_HOLD_ACTIVE`.

## 6. Permissions and default role mapping

| Permission               | Grants                                                               | Prototype default roles (authority `SOURCE_REQUIRED`)         |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `RECORDS_VIEW`           | Column-limited records view of cases (§7); never case content        | RECORDS_OFFICER, LEGAL_REVIEWER, GRC_DIRECTOR, INTERNAL_AUDIT |
| `RETENTION_CLASS_ASSIGN` | Confirm or change a case's retention class                           | RECORDS_OFFICER                                               |
| `LEGAL_HOLD_APPLY`       | Place a hold                                                         | LEGAL_REVIEWER, GRC_DIRECTOR, RECORDS_OFFICER                 |
| `LEGAL_HOLD_RELEASE`     | Request or decide a hold release (two distinct holders)              | LEGAL_REVIEWER, GRC_DIRECTOR                                  |
| `DISPOSITION_REQUEST`    | Request disposition of an eligible case; run the eligibility refresh | RECORDS_OFFICER                                               |
| `DISPOSITION_APPROVE`    | Approve or reject a disposition request (not one's own)              | GRC_DIRECTOR                                                  |

`PLATFORM_ADMIN`, `DB_ADMIN` and `SOC_ANALYST` receive none of them. The mapping is reference data in a migration and changes when the CDF Delegation of Authority is available. Every predicate also requires an `ACTIVE` user and denies a user with a declared or confirmed conflict on the case (existing `case_mgmt.conflict_check`).

| Predicate                                | True when                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `authz.can_view_records(case_id)`        | `RECORDS_VIEW`, clearance ≥ case classification, not conflicted                                  |
| `authz.can_apply_legal_hold(case_id)`    | `LEGAL_HOLD_APPLY` ∧ (`can_view_records` ∨ `can_view_case`), not conflicted, case not `DISPOSED` |
| `authz.can_release_legal_hold(case_id)`  | `LEGAL_HOLD_RELEASE` ∧ (`can_view_records` ∨ `can_view_case`), not conflicted                    |
| `authz.can_request_disposition(case_id)` | `DISPOSITION_REQUEST` ∧ `can_view_records`, not conflicted                                       |
| `authz.can_approve_disposition(case_id)` | `DISPOSITION_APPROVE` ∧ `can_view_records`, not conflicted                                       |

Restricted cases (`is_restricted = true`) are visible in the records view only to users who could see them through an assignment or grant, mirroring `can_view_case`: records staff do not gain a back door to restricted case existence.

## 7. RLS approach

- `records.case_records_v` (security-barrier view over `case_record`): `id`, `case_number`, `classification`, `is_restricted`, `records_state`, `legal_hold_status`, `retention_class`, `closed_at`, current schedule `retain_until`. Rows filtered by `authz.can_view_records(id)`. No `title`, `summary`, people, allegations or evidence metadata.
- `records.legal_hold`, `legal_hold_release`, `legal_hold_event`: `SELECT` when the user holds `LEGAL_HOLD_APPLY` or `LEGAL_HOLD_RELEASE` and `can_view_records(case_id)`. Case viewers without those permissions see only `legal_hold_status` on the case.
- `records.retention_schedule`, `disposition_request`, `disposition_certificate`: `SELECT` when `can_view_records(case_id)`.
- `records.retention_class`: `SELECT` for every signed-in user (reference data, like `config.setting`).
- `authz.can_view_case` gains one clause: false when `records_state = 'DISPOSED'`. Every case-linked policy inherits it.
- `rls-coverage.spec.ts` must list every new table; the policy snapshot is regenerated (`pnpm db:policies`).

## 8. Audit events

All written by the command in the same transaction through `audit.record_event`. `object_type` is the `records.*` table name; `reason` is a code, never free text; `metadata` carries ids and codes only (`assertSafeMetadata`).

| Action                           | Category | Outcome | Written by                                                                                  |
| -------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------- |
| `RETENTION_CLASS_ASSIGNED`       | BUSINESS | SUCCESS | `api.assign_retention_class`                                                                |
| `RETENTION_SCHEDULE_COMPUTED`    | BUSINESS | SUCCESS | archive transition, class assignment                                                        |
| `RETENTION_SCHEDULE_SUPERSEDED`  | BUSINESS | SUCCESS | reopen, class change                                                                        |
| `LEGAL_HOLD_PLACED`              | BUSINESS | SUCCESS | `api.place_legal_hold`                                                                      |
| `LEGAL_HOLD_RELEASE_REQUESTED`   | BUSINESS | SUCCESS | `api.request_legal_hold_release`                                                            |
| `LEGAL_HOLD_RELEASED`            | BUSINESS | SUCCESS | `api.decide_legal_hold_release` (approve)                                                   |
| `LEGAL_HOLD_RELEASE_REJECTED`    | BUSINESS | SUCCESS | `api.decide_legal_hold_release` (reject)                                                    |
| `DISPOSITION_ELIGIBLE_MARKED`    | BUSINESS | SUCCESS | `api.refresh_disposition_eligibility`                                                       |
| `DISPOSITION_REQUESTED`          | BUSINESS | SUCCESS | `api.request_disposition`                                                                   |
| `DISPOSITION_APPROVED`           | BUSINESS | SUCCESS | `api.decide_disposition` (approve)                                                          |
| `DISPOSITION_REJECTED`           | BUSINESS | SUCCESS | `api.decide_disposition` (reject)                                                           |
| `DISPOSITION_BLOCKED_BY_HOLD`    | BUSINESS | DENIED  | `api.place_legal_hold`, any disposition step that finds a hold                              |
| `DISPOSITION_EXECUTED`           | BUSINESS | SUCCESS | `api.execute_disposition`                                                                   |
| `DISPOSITION_CERTIFICATE_ISSUED` | BUSINESS | SUCCESS | `api.execute_disposition`                                                                   |
| `COMMAND_DENIED`                 | SECURITY | DENIED  | application layer, separate transaction, for any refused records command (existing pattern) |

## 9. Interaction with other modules

- **Case closure and workflow (ADR-007, WORKFLOW.md):** `ARCHIVE_CASE` is enabled by the implementation story with guard `RECORDS_CLASS_PRESENT` (class ≠ `UNASSIGNED`) or, alternatively, the records officer assigns the class after archiving; the story picks one and records it. `REOPEN_CASE` (from `CLOSURE`) is refused while the case is past `CLOSED`.
- **Evidence (ADR-006):** no change to the port. Disposition adds no delete method. The certificate's manifest reads `evidence_version.id` and `sha256` server-side. Evidence item holds use `records.legal_hold.evidence_id`.
- **Forms engine (CDF-50, ADR-011) and interviews (CDF-60, ADR-012):** their records are case-linked and covered by the case's class and holds. The contract they rely on is one shared predicate, `records.case_content_writable(case_id) returns boolean` (true only when `records_state = 'ACTIVE'`), plus the rule that they expose no delete command. This design does not define their tables; if they need a supersede or withdraw command, it calls `records.has_active_hold` first (§5.4).
- **Identity vault (ADR-004):** a hold on a case also preserves the vault entry of its source report. Logical disposition hides it with the case; physical destruction is part of the D7 follow-up.
- **Audit ledger (ADR-005):** untouched. Records events append to it; nothing disposes of it.

## 10. Implementation increments (for the follow-up story)

1. Migration `20261007001300_records.sql`: schema, tables, triggers, permissions, role mapping, predicates, views, policies, class rows (`SOURCE_REQUIRED`), `case_record` delete guard, `can_view_case` `DISPOSED` clause.
2. Migration `20261007001310_records_commands.sql`: the `api.*` commands in §5 and §4.
3. `@cdf/authorization` mirrors, `@cdf/domain` records rules, application services, records pages in `investigation-web` (records officer queue, hold panel, certificate view; Arabic and English).
4. Tests per [`RECORDS_TEST_DEFINITIONS.md`](../threat-model/RECORDS_TEST_DEFINITIONS.md).
5. Second increment: record type `REPORT` for portal reports that never became cases.
