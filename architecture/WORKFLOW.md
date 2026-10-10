# Workflow: CDF_CASE_V1

Protocol §30–§33; ADR-007. The database tables `workflow.workflow_state` and `workflow.workflow_transition_definition` (migration `20261007000600_workflow_definition.sql`) are authoritative. `packages/workflow/src/definition.ts` mirrors them for labelling only, and `tests/integration/mirrors.spec.ts` fails if the two diverge.

The engine is data-driven: a transition is allowed only if its definition exists, is enabled, starts from the case's current state, the actor holds `required_permission`, every `required_conditions` entry holds, separation of duties is respected, and a reason is supplied where `reason_required`. All of that is evaluated inside `api.transition_case()`; the UI only displays what `api.available_transitions()` returns.

## 1. States

| Seq | Code                     | English                | Arabic                    | Records state | Notes      |
| --- | ------------------------ | ---------------------- | ------------------------- | ------------- | ---------- |
| 10  | `REFERRAL`               | Referral               | الإحالة                   | ACTIVE        | Initial    |
| 20  | `REGISTERED`             | Registered             | مسجلة                     | ACTIVE        |            |
| 30  | `SCREENING`              | Screening              | الفحص الأولي              | ACTIVE        |            |
| 40  | `CONFLICT_CHECK`         | Conflict check         | فحص تعارض المصالح         | ACTIVE        |            |
| 50  | `TRIAGE`                 | Triage                 | الفرز                     | ACTIVE        |            |
| 60  | `JURISDICTION`           | Jurisdiction           | تحديد الاختصاص            | ACTIVE        |            |
| 70  | `INVESTIGATION_APPROVAL` | Investigation approval | اعتماد التحقيق            | ACTIVE        |            |
| 80  | `INVESTIGATION`          | Investigation          | التحقيق                   | ACTIVE        | Slice end  |
| 90  | `FINDINGS`               | Findings               | النتائج                   | ACTIVE        | Phase 9    |
| 100 | `GRC_LEGAL_REVIEW`       | GRC / legal review     | مراجعة الحوكمة والقانونية | ACTIVE        | Phase 9    |
| 110 | `COMMITTEE`              | Committee              | اللجنة                    | ACTIVE        | Phase 9–10 |
| 120 | `DECISION`               | Decision               | القرار                    | ACTIVE        | Phase 10   |
| 130 | `CORRECTIVE_ACTION`      | Corrective action      | الإجراءات التصحيحية       | ACTIVE        | Phase 10   |
| 140 | `CLOSURE`                | Closure                | الإغلاق                   | CLOSED        |            |
| 150 | `ARCHIVE`                | Archive                | الأرشيف                   | ARCHIVED      | Terminal   |

## 2. Transitions

"Enabled" means the guards for that transition are implemented and tested. Disabled transitions exist in the definition so the full lifecycle is visible, but `api.transition_case()` refuses them until their phase lands.

| Code                          | From → To                                  | Permission              | Reason | Approval | Conditions                                                                       | Enabled                                             | Phase |
| ----------------------------- | ------------------------------------------ | ----------------------- | ------ | -------- | -------------------------------------------------------------------------------- | --------------------------------------------------- | ----- |
| `REGISTER`                    | `REFERRAL` → `REGISTERED`                  | `CASE_CREATE`           |        |          |                                                                                  | yes (system: runs inside `create_case_from_report`) | 4     |
| `START_SCREENING`             | `REGISTERED` → `SCREENING`                 | `WORKFLOW_SCREEN`       |        |          |                                                                                  | yes                                                 | 6     |
| `COMPLETE_SCREENING`          | `SCREENING` → `CONFLICT_CHECK`             | `WORKFLOW_SCREEN`       |        |          | `ALLEGATION_RECORDED`                                                            | yes                                                 | 6     |
| `SCREEN_OUT`                  | `SCREENING` → `CLOSURE`                    | `WORKFLOW_ADVANCE`      | yes    |          |                                                                                  | yes                                                 | 6     |
| `CLEAR_CONFLICT_CHECK`        | `CONFLICT_CHECK` → `TRIAGE`                | `WORKFLOW_ADVANCE`      |        |          | `ACTOR_NO_CONFLICT_DECLARED`, `NO_UNRESOLVED_CONFLICTS`                          | yes                                                 | 6     |
| `COMPLETE_TRIAGE`             | `TRIAGE` → `JURISDICTION`                  | `WORKFLOW_ADVANCE`      |        |          | `PRIORITY_SET`                                                                   | yes                                                 | 6     |
| `CONFIRM_JURISDICTION`        | `JURISDICTION` → `INVESTIGATION_APPROVAL`  | `WORKFLOW_ADVANCE`      | yes    |          |                                                                                  | yes                                                 | 6     |
| `OUT_OF_JURISDICTION`         | `JURISDICTION` → `CLOSURE`                 | `WORKFLOW_ADVANCE`      | yes    |          |                                                                                  | yes                                                 | 6     |
| `APPROVE_INVESTIGATION`       | `INVESTIGATION_APPROVAL` → `INVESTIGATION` | `INVESTIGATION_APPROVE` | yes    | yes      | `INVESTIGATOR_ASSIGNED`, `ASSIGNEES_CONFLICT_CLEARED`, `NO_UNRESOLVED_CONFLICTS` | yes                                                 | 6     |
| `REJECT_INVESTIGATION`        | `INVESTIGATION_APPROVAL` → `JURISDICTION`  | `INVESTIGATION_APPROVE` | yes    |          |                                                                                  | yes                                                 | 6     |
| `SUBMIT_FINDINGS`             | `INVESTIGATION` → `FINDINGS`               | `WORKFLOW_ADVANCE`      |        |          |                                                                                  | no                                                  | 9     |
| `SUBMIT_FOR_REVIEW`           | `FINDINGS` → `GRC_LEGAL_REVIEW`            | `WORKFLOW_ADVANCE`      |        | yes      |                                                                                  | no                                                  | 9     |
| `RETURN_TO_INVESTIGATION`     | `GRC_LEGAL_REVIEW` → `INVESTIGATION`       | `WORKFLOW_ADVANCE`      | yes    |          |                                                                                  | no                                                  | 9     |
| `REFER_TO_COMMITTEE`          | `GRC_LEGAL_REVIEW` → `COMMITTEE`           | `WORKFLOW_ADVANCE`      |        | yes      |                                                                                  | no                                                  | 9     |
| `CONCLUDE_COMMITTEE`          | `COMMITTEE` → `DECISION`                   | `WORKFLOW_ADVANCE`      |        | yes      |                                                                                  | no                                                  | 9     |
| `REQUIRE_CORRECTIVE_ACTION`   | `DECISION` → `CORRECTIVE_ACTION`           | `WORKFLOW_ADVANCE`      |        | yes      |                                                                                  | no                                                  | 10    |
| `CLOSE_AFTER_DECISION`        | `DECISION` → `CLOSURE`                     | `WORKFLOW_ADVANCE`      | yes    | yes      |                                                                                  | no                                                  | 10    |
| `COMPLETE_CORRECTIVE_ACTIONS` | `CORRECTIVE_ACTION` → `CLOSURE`            | `WORKFLOW_ADVANCE`      |        | yes      |                                                                                  | no                                                  | 10    |
| `ARCHIVE_CASE`                | `CLOSURE` → `ARCHIVE`                      | `WORKFLOW_ADVANCE`      |        |          |                                                                                  | yes                                                 | 11    |
| `REOPEN_CASE`                 | `CLOSURE` → `INVESTIGATION`                | `INVESTIGATION_APPROVE` | yes    | yes      |                                                                                  | no                                                  | 10    |

## 3. Conditions

Conditions are evaluated by `workflow.evaluate_condition(condition, case_id, actor)`, which returns `null` when the condition holds and a blocking-reason code otherwise. An unknown condition code blocks (`UNKNOWN_CONDITION:<code>`), so a typo can never open a transition.

| Condition                    | Holds when                                                                                    | Blocking reason when it fails           |
| ---------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------- |
| `ALLEGATION_RECORDED`        | The case has at least one allegation that is not `WITHDRAWN`.                                 | `NO_ALLEGATION_RECORDED`                |
| `PRIORITY_SET`               | `case_record.priority` is not null.                                                           | `PRIORITY_NOT_SET`                      |
| `ACTOR_NO_CONFLICT_DECLARED` | The acting user's current conflict check on this case is `NO_CONFLICT` or `CONFLICT_CLEARED`. | `ACTOR_CONFLICT_DECLARATION_MISSING`    |
| `NO_UNRESOLVED_CONFLICTS`    | No current check on the case is in `CONFLICT_DECLARED`.                                       | `UNRESOLVED_CONFLICT_DECLARATION`       |
| `INVESTIGATOR_ASSIGNED`      | At least one active `LEAD_INVESTIGATOR` or `INVESTIGATOR` assignment exists.                  | `NO_INVESTIGATOR_ASSIGNED`              |
| `ASSIGNEES_CONFLICT_CLEARED` | Every active lead or investigator has a current `NO_CONFLICT` or `CONFLICT_CLEARED` check.    | `ASSIGNEE_CONFLICT_DECLARATION_MISSING` |

## 4. Separation of duties

`api.transition_case()` refuses with `CDF_FORBIDDEN`, and `api.available_transitions()` reports `SEPARATION_OF_DUTIES`, when the actor performing a transition with `approval_required` holds an active `LEAD_INVESTIGATOR` or `INVESTIGATOR` assignment on that case. Concretely, an assigned investigator or lead cannot `APPROVE_INVESTIGATION` for their own case; a case manager or GRC director who is not assigned as an investigator can. Tested in `tests/security/case-isolation.spec.ts` ("an assigned investigator cannot approve the investigation of their own case").

## 5. What `available_transitions` returns

For every non-system transition leaving the current state (disabled ones included, so the UI can show what comes later), the function returns the code, the target state, bilingual names, whether a reason is required, whether it is enabled and in which phase, `allowed`, and `blocking_reasons`. Reasons are drawn from `NOT_YET_AVAILABLE`, `MISSING_PERMISSION`, `SEPARATION_OF_DUTIES` and the condition failure codes in §3. `allowed` is true only when the list is empty. The function returns nothing at all for a case the actor cannot view. The UI renders allowed actions as buttons and blocked ones as disabled with the translated reason; it never computes eligibility itself.

`api.transition_case()` additionally requires a reason of 10–2000 characters where `reason_required` is set (`CDF_INVALID:reason`) and refuses disabled transitions with `CDF_CONFLICT:TRANSITION_NOT_YET_AVAILABLE`.

## 6. Audit and events

Every successful transition, in one transaction (`workflow.apply_transition`):

- updates `workflow_instance.current_state`, `entered_state_at` and `state_due_at` (the smallest `sla_hours` among enabled transitions out of the new state, or null);
- inserts a `workflow.workflow_transition_event` row with actor, reason and request id;
- syncs `case_record.records_state` with the new state, stamps `opened_at` the first time the case enters `INVESTIGATION`, and sets or clears `closed_at` as the case enters or leaves a `CLOSED` state;
- writes the transition's `audit_action` (default `WORKFLOW_TRANSITION`, category `BUSINESS`) with `transition`, `from` and `to` in the metadata, plus `CASE_CLOSED` when a `CLOSED` state is entered and `CASE_REOPENED` for `REOPEN_CASE`.

A refused transition raises a `CDF_*` error and rolls back; the application layer then records a `COMMAND_DENIED` event (category `SECURITY`) in a separate transaction.

## 7. The first vertical slice, end to end

1. Reporter submits through the portal → `intake.report` (`RECEIVED`), vault row if email-only (email only) or identified (Drive identity fields, CDF-63), `REPORT_SUBMITTED` audit as `ANONYMOUS_REPORTER`.
2. Triage officer records `OPEN_CASE` → report `ACCEPTED`, `REPORT_TRIAGED`.
3. Triage officer or case manager runs `api.create_case_from_report()` → `case_record`, `workflow_instance` at `REGISTERED` (system transition `REGISTER`), a `TRIAGE`-scope access grant for the creator, `CASE_CREATED`; report becomes `CASE_OPENED`.
4. Screening: `START_SCREENING`; record an allegation; `COMPLETE_SCREENING`.
5. Conflict check: each participant declares; `CLEAR_CONFLICT_CHECK`.
6. `COMPLETE_TRIAGE` after setting priority; `CONFIRM_JURISDICTION` with reason.
7. Case manager assigns a lead and investigators (`api.assign_case()`, clearance and conflict checked).
8. GRC director (not assigned) runs `APPROVE_INVESTIGATION` → `INVESTIGATION`, `opened_at` set.

`tests/integration/first-slice.spec.ts` and `tests/e2e/first-slice.spec.ts` execute this sequence.

## 8. SLAs and review steps

`sla_hours` and `review_required` exist in the definition but no transition sets them yet, so `state_due_at` is always null and nothing enforces a due date. SLA values need a confirmed CDF source (`SOURCE_REQUIRED`); due-date tracking and reminders are planned with notifications in Phase 13 (`NOT_STARTED`).
