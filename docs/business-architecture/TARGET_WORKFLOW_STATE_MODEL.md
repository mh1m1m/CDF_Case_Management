# Target Workflow and State Model

> SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Durations and deciders are configurable; values marked `OWNER_DEFAULT` come from the owner Q&A, `SOURCE_REQUIRED` values await CDF documents.

## 1. Principle: status is multi-dimensional

The CRM catalogues' statuses (150 in the Drive list, 140 in the owner's control catalogue) mix stages, waits, suspensions, outcomes, flags and events in one list. The target keeps **one current value per dimension**. Migration 1970 holds the vocabulary in `config.status_dimension` and `config.status_dimension_value`, and tests keep it equal to the schema (ADR-035). Every legacy status is mapped in `CRM_STATUS_RATIONALIZATION.md`.

| Dimension                                                          | Held on                                                                                    | Values (implemented)                                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Case stage                                                         | derived from the CDF_CASE_V1 state and the open proceedings                                | INTAKE, PRELIMINARY_REVIEW, INVESTIGATION, COMMITTEE, LEGAL_REVIEW, DECISION, EXECUTION, GRIEVANCE, CLOSURE, RECORDS |
| Proceeding status                                                  | `proceeding.status`                                                                        | OPEN, IN_PROGRESS, AWAITING_REVIEW, AWAITING_APPROVAL, RETURNED, SUSPENDED, CONCLUDED, CANCELLED                     |
| Waiting reason                                                     | `proceeding.waiting_reason` (`config.status_code`)                                         | 28 codes, e.g. EMPLOYEE_DEFENCE, LEGAL_OPINION, AUTHORITY_DECISION, QUORUM, HEARING                                  |
| Suspension reason                                                  | `proceeding.suspension_reason` (`config.status_code`)                                      | 10 codes, e.g. CONFLICT_OF_INTEREST, LEAVE_OR_ILLNESS, INVESTIGATOR_CHANGE, SOVEREIGN_AUTHORITY                      |
| Outcome                                                            | `proceeding.outcome_code` (`config.status_code`)                                           | 23 codes, e.g. SUBSTANTIATED, NOT_SUBSTANTIATED, OUT_OF_SCOPE, REFERRED_TO_COMMITTEE                                 |
| Decision outcomes                                                  | preliminary recommendation, vote item, legal opinion, authority decision                   | e.g. INVESTIGATION_WARRANTED; APPROVED, NO_DECISION; CONCURS; APPROVE_AS_RECOMMENDED, RETURN_TO_COMMITTEE            |
| Object status                                                      | package, legal review request, grievance, corrective action, conflict check                | e.g. VOTING, AWAITING_AUTHORITY; ASSIGNED; AWAITING_ADMISSIBILITY_DECISION; PENDING_VERIFICATION; CONFLICT_DECLARED  |
| Flags                                                              | `case_record.legal_hold_status`, `case_record.priority`; restricted via the classification | LEGAL_HOLD ACTIVE or NONE; LOW … CRITICAL                                                                            |
| Execution state, grievance finality                                | derived                                                                                    | NOT_STARTED … EXECUTED, OVERDUE; FINAL_NOT_GRIEVABLE                                                                 |
| Records state                                                      | `case_record.records_state`                                                                | ACTIVE, CLOSED, RETENTION, ARCHIVED, DISPOSITION_ELIGIBLE, DISPOSITION_PENDING, DISPOSED                             |
| Escalation, quality review, reporter protection, external referral | not modelled (PLANNED)                                                                     | named in `config.status_dimension_value` with state PLANNED                                                          |
| Events                                                             | audit ledger only                                                                          | MEETING_SCHEDULED, VOTE_CLOSED … never a status                                                                      |

## 2. Case lifecycle (paths)

```
WHISTLEBLOWING report ─▶ Case(WB) ─▶ PRELIMINARY_REVIEW ─┬─▶ close (no basis)      [approved by GRC Sector Head]
                                                          ├─▶ INVESTIGATION (existing CDF_CASE_V1 path)
                                                          └─▶ COMMITTEE_INVESTIGATION
DIRECT_REFERRAL ─▶ Referral ─▶ sector head ─▶ IC Secretary ─ACCEPT─▶ Case(DR) ─▶ COMMITTEE_INVESTIGATION
                                               ├─RETURN_FOR_COMPLETION─▶ preparer (resubmit)
                                               └─REJECT─▶ sector may RESUBMIT or OBJECT
COMMITTEE_INVESTIGATION ─▶ meetings ≥1 ─▶ RecommendationPackage ─▶ (LEGAL_REVIEW)? ─▶ AUTHORITY_DECISION
AUTHORITY_DECISION ─┬─ APPROVE* / MODIFY ─▶ notices + CORRECTIVE_ACTION ─▶ (GRIEVANCE window) ─▶ CLOSED
                    ├─ RETURN_TO_COMMITTEE ─▶ COMMITTEE_INVESTIGATION (same proceeding, new round)
                    └─ REJECT / OTHER ─▶ CLOSED or committee per decision
GRIEVANCE (LINKED to a decision, or STANDALONE / DIRECT_GRIEVANCE) ─▶ admissibility ─▶ GC proceeding ─▶ outcomes (combinable) ─▶ REINVESTIGATION route?
```

## 3. Proceeding state machines

### 3.1 Referral (`intake.referral.status`)

| From                            | Command                                                      | To                                            | Actor                          | Guard                                                                       |
| ------------------------------- | ------------------------------------------------------------ | --------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| —                               | `api.create_referral`                                        | DRAFT                                         | sector member                  | active sector membership                                                    |
| DRAFT / RETURNED_FOR_COMPLETION | `api.submit_referral_to_head`                                | SUBMITTED_TO_HEAD                             | preparer                       | required fields                                                             |
| SUBMITTED_TO_HEAD               | `api.sector_approve_referral`                                | SUBMITTED_TO_SECRETARY                        | sector head or active delegate | delegate window covers now; approver ≠ preparer                             |
| SUBMITTED_TO_HEAD               | `api.sector_return_referral`                                 | DRAFT                                         | head / delegate                | reason                                                                      |
| SUBMITTED_TO_SECRETARY          | `api.secretary_decide_referral`                              | ACCEPTED / RETURNED_FOR_COMPLETION / REJECTED | IC secretary (effective seat)  | structured reasons for return / reject                                      |
| REJECTED                        | `api.resubmit_referral` / `api.object_to_referral_rejection` | SUBMITTED_TO_HEAD / OBJECTED                  | preparer / head                | rejection is not final                                                      |
| OBJECTED                        | `api.secretary_decide_referral`                              | ACCEPTED / REJECTED                           | IC secretary                   | objection recorded                                                          |
| REJECTED (second or later)      | `api.escalate_referral_rejection`                            | ESCALATED                                     | head / delegate (not preparer) | DEC-F09 (2040): text unchanged; once per rejection                          |
| ESCALATED                       | `api.decide_referral_escalation`                             | ACCEPTED / REJECTED                           | escalation target seat holder  | DEC-F09: default IC Chair; excludes preparer, approver, rejecting secretary |
| ACCEPTED                        | (same transaction)                                           | case created                                  | system                         | `source_type = DIRECT_REFERRAL`, committee proceeding open                  |

### 3.2 Preliminary review (`proceeding` type PRELIMINARY_REVIEW)

| From              | Command                                  | To                           | Actor                                                    | Guard                                             |
| ----------------- | ---------------------------------------- | ---------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| OPEN              | `api.prepare_preliminary_recommendation` | AWAITING_REVIEW              | INVESTIGATOR / COMPLIANCE_SECTION_MANAGER / GRC_DIRECTOR | assigned or role per routing config               |
| AWAITING_REVIEW   | `api.review_preliminary_recommendation`  | AWAITING_APPROVAL / RETURNED | GRC_DIRECTOR                                             | reviewer ≠ preparer; skipped if Director prepared |
| AWAITING_APPROVAL | `api.approve_preliminary_recommendation` | CONCLUDED / RETURNED         | GRC_SECTOR_HEAD                                          | approver ≠ preparer                               |
| RETURNED          | `api.prepare_preliminary_recommendation` | AWAITING_REVIEW              | preparer                                                 | return reasons from a structured list             |

Approval concludes the proceeding with the recommended outcome: INVESTIGATION_WARRANTED or REFERRED_TO_COMMITTEE to go on, or a closure (NO_ACTION, OUT_OF_SCOPE, DUPLICATE, TRANSFERRED, NON_PROCESSABLE, and since migration 1980 NOT_SERIOUS, NOT_SUBSTANTIATED, CHANNEL_ABUSE, NOT_FEASIBLE, NO_PERSONAL_JURISDICTION; ADR-036). Since migration 2040 (DEC-F10) NOT_FEASIBLE and NO_PERSONAL_JURISDICTION are INACTIVE in the catalogue: refused for a new recommendation and for endorsement or approval, kept on existing records, until their authority and definitions are confirmed (SOURCE_REQUIRED).

### 3.3 Committee proceeding

OPEN → IN_DELIBERATION (first meeting held) → RECOMMENDATION_DRAFTED → RECOMMENDATION_ADOPTED (vote closed with quorum) → AWAITING_LEGAL_REVIEW? → AWAITING_AUTHORITY_DECISION → CONCLUDED, with RETURNED_BY_LEGAL / RETURNED_BY_AUTHORITY looping back to IN_DELIBERATION.

### 3.4 Meeting

SCHEDULED → OPEN (secretary opens; COI declarations required from all eligible) → CLOSED → MINUTES_IN_REVIEW → MINUTES_APPROVED / MINUTES_DEEMED_APPROVED. CANCELLED from SCHEDULED.

### 3.5 Vote item

OPEN → CLOSED (result APPROVED / REJECTED / TIED / NO_QUORUM). Quorum = count of PRESENT, NO_CONFLICT eligible voting members ≥ rule threshold. Tie with casting vote enabled → chair's casting vote decides, stored separately.

### 3.6 Legal review

REQUESTED (secretary selects packet items) → OPINION_SUBMITTED (CONCURS / CONCURS_WITH_COMMENTS / CONFLICTS) → CONFLICTS ⇒ committee proceeding RETURNED_BY_LEGAL; recommendation and opinion both preserved.

### 3.7 Authority decision

AWAITING → RECORDED (secretary, source document) → EFFECTIVE (requires source document). Outcomes per ADR-023.

### 3.8 Grievance

RECEIVED (channel, original date) → ADMISSIBILITY_PENDING → ADMISSIBLE / INADMISSIBLE (decider per rule set: SECRETARY / CHAIR / COMMITTEE) → IN_DELIBERATION → CONCLUDED (outcomes[]: UPHOLD, AMEND_SANCTION, CANCEL_SANCTION, REINVESTIGATE, REFER_TO_AUTHORITY, OTHER) → REINVESTIGATION proceeding if routed.

## 4. Mapping from CDF_CASE_V1

| CDF_CASE_V1 state                     | Target                                                        |
| ------------------------------------- | ------------------------------------------------------------- |
| REFERRAL, REGISTERED                  | stage INTAKE                                                  |
| SCREENING … JURISDICTION              | PRELIMINARY_REVIEW proceeding (existing cases keep V1 states) |
| INVESTIGATION_APPROVAL, INVESTIGATION | INVESTIGATION proceeding                                      |
| FINDINGS                              | findings rows                                                 |
| GRC_LEGAL_REVIEW                      | LEGAL_REVIEW proceeding                                       |
| COMMITTEE                             | COMMITTEE_INVESTIGATION proceeding                            |
| DECISION                              | AUTHORITY_DECISION proceeding                                 |
| CORRECTIVE_ACTION                     | CORRECTIVE_ACTION proceeding                                  |
| CLOSURE, ARCHIVE                      | stage CLOSED / ARCHIVED (records)                             |

Existing cases are not re-pathed. V1 keeps running for them; new proceedings attach alongside.

## 5. Time rules

| Rule                        | Default              | Status          | Where                     |
| --------------------------- | -------------------- | --------------- | ------------------------- |
| Minutes review window       | 3 business days      | OWNER_DEFAULT   | `committee.rule_set`      |
| Deemed approval             | enabled              | OWNER_DEFAULT   | `committee.rule_set`      |
| Grievance window            | 30 days              | OWNER_DEFAULT   | `committee.rule_set` (GC) |
| Business-day calendar       | Sun–Thu, no holidays | SOURCE_REQUIRED | `config.setting`          |
| Defence submission deadline | configurable         | SOURCE_REQUIRED | `config.setting`          |

Deemed approval is applied by an idempotent command (`api.apply_minutes_deemed_approval`) invoked by a scheduler port; prototype runs it on read and from a cron route (PRODUCTION_SUBSTITUTION_REQUIRED: CDF scheduler).
