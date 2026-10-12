# Target Workflow and State Model

> SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Durations and deciders are configurable; values marked `OWNER_DEFAULT` come from the owner Q&A, `SOURCE_REQUIRED` values await CDF documents.

## 1. Principle: status is multi-dimensional

The CRM catalogue's 150 statuses mix stages, waits, suspensions, outcomes, flags and events in one list. The target keeps **one current value per dimension** (see `CRM_STATUS_RATIONALIZATION.md`):

| Dimension         | Held on                                        | Example values                                                                                       |
| ----------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Case stage        | derived from open proceedings                  | INTAKE, PRELIMINARY, INVESTIGATION, COMMITTEE, DECISION, IMPLEMENTATION, GRIEVANCE, CLOSED, ARCHIVED |
| Proceeding status | `proceeding.status`                            | OPEN, IN_PROGRESS, AWAITING_REVIEW, AWAITING_APPROVAL, RETURNED, SUSPENDED, CONCLUDED, CANCELLED     |
| Waiting reason    | `proceeding.waiting_reason`                    | AWAITING_EMPLOYEE_DEFENCE, AWAITING_LEGAL_OPINION, AWAITING_AUTHORITY_DECISION, AWAITING_QUORUM …    |
| Suspension reason | `proceeding.suspension_reason`                 | EXTERNAL_INVESTIGATION, LEGAL_HOLD_REQUEST, SUBJECT_LEAVE …                                          |
| Flags             | derived / dedicated columns                    | RESTRICTED, LEGAL_HOLD_ACTIVE, LATE_GRIEVANCE, RECORDED_OFFLINE                                      |
| Outcome           | `proceeding.outcome_code`, findings, decisions | SUBSTANTIATED, NO_VIOLATION, APPROVE_AS_RECOMMENDED …                                                |
| Records state     | `records.*`                                    | ACTIVE, CLOSED_RETAINED, DISPOSITION_PENDING                                                         |
| Events            | audit ledger only                              | MEETING_HELD, VOTE_CLOSED — never a status                                                           |

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

| From                            | Command                                                      | To                                            | Actor                          | Guard                                                      |
| ------------------------------- | ------------------------------------------------------------ | --------------------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| —                               | `api.create_referral`                                        | DRAFT                                         | sector member                  | active sector membership                                   |
| DRAFT / RETURNED_FOR_COMPLETION | `api.submit_referral_to_head`                                | SUBMITTED_TO_HEAD                             | preparer                       | required fields                                            |
| SUBMITTED_TO_HEAD               | `api.sector_approve_referral`                                | SUBMITTED_TO_SECRETARY                        | sector head or active delegate | delegate window covers now; approver ≠ preparer            |
| SUBMITTED_TO_HEAD               | `api.sector_return_referral`                                 | DRAFT                                         | head / delegate                | reason                                                     |
| SUBMITTED_TO_SECRETARY          | `api.secretary_decide_referral`                              | ACCEPTED / RETURNED_FOR_COMPLETION / REJECTED | IC secretary (effective seat)  | structured reasons for return / reject                     |
| REJECTED                        | `api.resubmit_referral` / `api.object_to_referral_rejection` | SUBMITTED_TO_HEAD / OBJECTED                  | preparer / head                | rejection is not final                                     |
| OBJECTED                        | `api.secretary_decide_referral`                              | ACCEPTED / REJECTED                           | IC secretary                   | objection recorded                                         |
| ACCEPTED                        | (same transaction)                                           | case created                                  | system                         | `source_type = DIRECT_REFERRAL`, committee proceeding open |

### 3.2 Preliminary review (`proceeding` type PRELIMINARY_REVIEW)

| From              | Command                                  | To                           | Actor                                                    | Guard                                             |
| ----------------- | ---------------------------------------- | ---------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| OPEN              | `api.prepare_preliminary_recommendation` | AWAITING_REVIEW              | INVESTIGATOR / COMPLIANCE_SECTION_MANAGER / GRC_DIRECTOR | assigned or role per routing config               |
| AWAITING_REVIEW   | `api.review_preliminary_recommendation`  | AWAITING_APPROVAL / RETURNED | GRC_DIRECTOR                                             | reviewer ≠ preparer; skipped if Director prepared |
| AWAITING_APPROVAL | `api.approve_preliminary_recommendation` | CONCLUDED / RETURNED         | GRC_SECTOR_HEAD                                          | approver ≠ preparer                               |
| RETURNED          | `api.prepare_preliminary_recommendation` | AWAITING_REVIEW              | preparer                                                 | return reasons from a structured list             |

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
