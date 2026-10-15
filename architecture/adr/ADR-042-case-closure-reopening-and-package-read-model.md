# ADR-042: Case closure, case outcome and reopening (P11-G2), the package-building read model, and five follow-ups (migration 2060)

- **Status:** Proposed (2026-10-14). Linear CDF-196 (rebase decision application), CDF-213, CDF-214, CDF-217 (part 1) and CDF-218 (part 1). Implemented in migration 2060 (Rebase PR-B, pending security review). Builds on ADR-013 (records and retention), ADR-016 D2 (DEC-02), ADR-033 (corrective actions), ADR-036 (preliminary closure outcomes), ADR-040 (owner decisions, 2030/2040) and ADR-041 (2050).
- **Owner decisions** (recorded in `docs/business-architecture/OWNER_DECISIONS_FINALIZATION.md` §14 and §16):
  - DEC-F39 (2026-10-13): "The case carries a structured final outcome, separate from lifecycle status, drawn from configuration or reference data rather than free text only. It coexists with subject-level outcomes, allegation-level findings, sanctions, corrective actions and grievances."
  - DEC-F40 (2026-10-13): "No single named closer. The operational case owner or an authorized role initiates closure; where the configured Delegation of Authority requires it, closure is routed for approval. Until the CDF DoA mapping is confirmed, `CASE_CLOSURE_APPROVAL_RULE = SOURCE_REQUIRED`. Supported paths: direct authorized closure, maker/approver closure, returned closure request. Closure never proceeds while mandatory actions remain open, unless through an explicitly authorized conditional or staged closure path."
  - DEC-AMB-002, option B (2026-10-13): "A closed case may be reopened by the applicable closure authority based on new evidence, with documented reason, approval, full audit trail, and retention recalculation."
  - DEC-AMB-015, option A (2026-10-13): "Use the controlled reopening machinery of DEC-AMB-002, but treat the validated post-decision conflict event as an authorized reopening trigger alongside new evidence." The reopening reason is `DECISIVE_POST_DECISION_CONFLICT`; "The closure authority must not re-decide the conflict merits; it authorizes reopening once the conflict event has already been validated through the applicable conflict process. Fail closed if the required closure authority is not configured."
  - DEC-02 (UX register, approved 2026-10-11; ADR-016 D2): committee, review and triage access is never full-case; the target is a purpose route and packet.
- **Coordinator rulings** (2026-10-14): 12:08 (package read model, label mode, CDF-213/214 placement), 12:12 (CDF-213 and CDF-214 numbers), 12:44 (CDF-217(1) and CDF-218(1) in 2060; CDF-216, CDF-217(2), CDF-218(2) and CDF-219 stay Backlog), 21:42 (2060 scope), 22:19 (AGENT-09's three items on the closure specification adopted as rulings, below).
- **AGENT-09 items:** on the packet approval read model (12:46): R1, the read is VOLATILE. On the closure specification (22:19, adopted by the coordinator): R1, the commands' closure marker is bound to the current transaction (old `case_closure` rows survive a reopening); R2, closure-block codes go only to callers holding the step's permission and passing `user_case_gate`, never to every viewer (a pending grievance or an open window must not leak); R3, `REQUESTER_CANNOT_APPROVE` applies to every decision, and a `CASE_CLOSURE_APPROVAL_RULE` value of PLATFORM_ADMIN, DB_ADMIN, an unknown role or an inactive role reads as unset. Each has its negative test in this migration's PR.
- **Protocol:** §18–§22, §29, §40, §65, §68, §82, §83, §87.

## Context

Gap P11-G2: before 2060 a case closed only through the CDF_CASE_V1 steps `SCREEN_OUT` and `OUT_OF_JURISDICTION`, with a free-text reason and no outcome. The steps that would close a case after a decision (`CLOSE_AFTER_DECISION`, `COMPLETE_CORRECTIVE_ACTIONS`) and `REOPEN_CASE` were disabled. The guards covered outstanding corrective actions (1940) and the conflict remediation (2030), but not open proceedings, grievance windows or open grievances, so an early closure could strand a proceeding and cut off a grievance (CON-022, AMB-213, AMB-146).

DEC-F40 keeps the closure authority SOURCE_REQUIRED. The rule here is fail closed: nothing new that depends on that authority (routing, approval, reopening) is reachable until it is configured, and nothing the CDF_CASE_V1 steps already allowed is taken away. Fady's standing instruction applies: "Do not weaken existing fail-safe behaviour before the replacement rule and its negative tests are in place." The reopening replaces the 0600 fail-safe (REOPEN_CASE disabled); the T-AMB-131 test that pinned that fail-safe is replaced by the reopening test in the same PR.

The ambiguity rows answered here are AMB-146, AMB-212 to AMB-218 and AMB-220. Their tests are T-AMB-086, T-AMB-127, T-AMB-128, T-AMB-129 and T-AMB-131.

## Decision

### 1. Settings (config.setting; migration-managed, no role can change them)

| Key                                       | 2060            | Meaning                                                                                                                                                                                                                         |
| ----------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CASE_CLOSURE_APPROVAL_RULE` (AMB-212)    | SOURCE_REQUIRED | When configured, a role code: the closure authority. It approves routed closures and every reopening. An unknown, technical or inactive role (no active holder today), PLATFORM_ADMIN and DB_ADMIN read as unset (AGENT-09 R3). |
| `CONDITIONAL_CLOSURE_AUTHORITY` (AMB-214) | SOURCE_REQUIRED | No conditional or staged path exists; every closure checks every blocker.                                                                                                                                                       |
| `CASE_OUTCOME_CATALOGUE` (AMB-216)        | SOURCE_REQUIRED | CDF confirmation of the outcome values (§2).                                                                                                                                                                                    |

No new setting is added for the reopening: it fails closed on `CASE_CLOSURE_APPROVAL_RULE` (FIN:171).

### 2. Case outcome (DEC-F39)

- `case_mgmt.case_outcome_code`: reference data, one row per OUTCOME_CODE value that closes a case in CDF's own CRM status catalogue (`config.legacy_status_map`, modules CASE_CLOSE, PRELIM_CLOSE_OUTCOME and CASE_TRANSFER), with the legacy statuses it comes from. EMERGENCY_CLOSURE is inactive: who may order one is SOURCE_REQUIRED (S059). No value is invented.
- `case_mgmt.case_closure`: one append-only row per closure made through the closure commands, with the outcome, rationale, path (DIRECT or APPROVED), the step applied, who closed it, the request when approved, and the recording transaction. A case's outcome is its latest closure while it is closed. Proceeding outcomes, findings, sanctions, corrective actions and grievances are untouched.

### 3. Closure readiness (DEC-F40; CON-022; AMB-213; AMB-146)

`case_mgmt.closure_blocks(case)` lists what keeps a case from closing, in the order the guards raise it: the four existing codes (`CONFLICT_REMEDIATION_OPEN`, `TAINTED_BY_CONFLICT`, `FROZEN_BY_SUPERSEDED_DECISION`, `CORRECTIVE_ACTIONS_OUTSTANDING`, through the same helpers; those guards stay as they are) and three new ones:

- `OPEN_PROCEEDINGS`: a proceeding not concluded or cancelled (a committee proceeding closes with its proceeding);
- `GRIEVANCE_WINDOW_OPEN`: a decision notice, not withdrawn, whose grievance window has not started or not ended;
- `DECISION_NOT_FINAL`: a grievance or reconsideration received, awaiting admissibility or admitted, or a package between the committee's vote and the authority's decision.

A new BEFORE trigger on every ACTIVE→CLOSED change raises the first code. A legal hold never blocks closure (AMB-215, DEC-F33). `api.available_transitions` adds the codes to steps into CLOSURE, so it keeps agreeing with `api.transition_case`, but only for a caller who holds the step's permission and passes `user_case_gate` (AGENT-09 R2).

### 4. Closing (DEC-F40: direct, maker/approver, returned)

- `api.close_case(case, outcome_code, rationale)`. Checks in order: NOT_FOUND unless the caller can view the case; FORBIDDEN unless `WORKFLOW_ADVANCE` (today's closure entitlement; no widening) within their clearance and without a case conflict; `CASE_NOT_ACTIVE`; INVALID outcome or rationale; `CLOSURE_REQUEST_PENDING`; the first readiness block.
- While `CASE_CLOSURE_APPROVAL_RULE` is SOURCE_REQUIRED it closes only where an enabled CDF_CASE_V1 step reaches CLOSURE from the current state (SCREEN_OUT, OUT_OF_JURISDICTION), running `api.transition_case` itself so the step's checks run in their order, and records the closure (DIRECT). Anywhere else: `CASE_CLOSURE_APPROVAL_RULE_REQUIRED`. This is the direct closure that already existed, now with an outcome and every blocker.
- Once configured, the closure authority closes directly; anyone else's call files a closure request. `api.decide_case_closure(request, APPROVE | RETURN, reason)` is the authority's: NOT_FOUND; `CASE_CLOSURE_APPROVAL_RULE_REQUIRED`; FORBIDDEN unless the authority role within clearance; `REQUESTER_CANNOT_APPROVE` for either decision (R3); `REQUEST_NOT_PENDING`. APPROVE re-checks the case, the blocks, the step and its conditions, then closes (APPROVED). RETURN leaves the case open; the maker may file again.
- Once configured, no other path closes the case: the readiness trigger refuses any ACTIVE→CLOSED change without a `case_closure` row recorded in the current transaction (`CLOSURE_APPROVAL_REQUIRED`). The marker is the row's `transaction_id` (`pg_current_xact_id()`), not a session flag; an earlier closure's row survives a reopening and never counts again (R1).
- While unset, `api.transition_case` SCREEN_OUT and OUT_OF_JURISDICTION still close without an outcome (P11-G2 keeps CDF_CASE_V1 closure for compatibility). Refusing them once the case workspace uses `api.close_case` is a later narrowing.

### 5. Reopening (DEC-AMB-002 option B; DEC-AMB-015 option A)

- `REOPEN_CASE` becomes a system step (enabled, `is_system`): `api.transition_case` refuses it; only `api.decide_case_reopening` runs it. Route and permission are unchanged.
- `api.request_case_reopening(case, reason_type, justification, new_evidence_description, new_evidence_reference, package)`: NOT_FOUND; `CASE_CLOSURE_APPROVAL_RULE_REQUIRED` while unset, before anything else is examined (fail closed); FORBIDDEN unless `INVESTIGATION_APPROVE` (the REOPEN_CASE permission) within clearance, plus `CONFLICT_MANAGE` for the conflict reason; `CASE_NOT_CLOSED` unless the case is closed in CLOSURE; INVALID reason and fields; `REOPENING_REQUEST_PENDING`. NEW_EVIDENCE needs a description and a reference, as DEC-AMB-001's reconsideration does.
- `DECISIVE_POST_DECISION_CONFLICT` is a distinct reason; the conflict is never recorded as new evidence. Its entry is the 2030 rule for "could have changed the result" (ADR-040 §3 item 10): a decided package of the case with an active item whose closed vote counts a validated conflict (`decision.vote_item_conflicted`: a meeting conflict, an upheld concern, or a declared or confirmed case conflict) and whose recount without those votes differs or cannot be made (`decision.recount_without`). Otherwise `NO_VALIDATED_DECISIVE_CONFLICT`. On a closed case the conflict is validated through the case conflict process (`api.declare_conflict`, `api.decide_conflict`, which do not need an active case); the meeting and concern commands still need an active case. Only conflict managers file this reason, because the answer tells whether a recount differs.
- `api.decide_case_reopening(request, APPROVE | REJECT, reason)`: NOT_FOUND; `CASE_CLOSURE_APPROVAL_RULE_REQUIRED`; FORBIDDEN unless the authority role within clearance; `REQUESTER_CANNOT_APPROVE` (R3); `REQUEST_NOT_PENDING`. APPROVE re-checks that the case is closed and the conflict entry still holds, and runs REOPEN_CASE: the case is ACTIVE in INVESTIGATION, `CASE_REOPENED` is audited, and the retention schedule is superseded as REOPENED and recalculated at the next closure (ADR-013 D3). The authority checks the recorded entry, not the conflict's merits. REJECT leaves the case closed.
- Nothing edits an authority decision. Once the case is ACTIVE, ADR-040 §3 items 10 and 11 apply; `TAINTED_BY_CONFLICT` keeps it from closing until then. A closed case still never enters the remediation directly (2030 guard, unchanged).
- `api.case_closure_view(case)`: closures, closure requests and whether the authority is configured, for case viewers; the readiness blocks only for a caller with the closure entitlement (R2); the reopening requests only for their makers and the authority. The reopening table has no reader policy.

### 6. The package-building read model (DEC-02; coordinator 12:08)

- `api.committee_scope_choices(committee_proceeding)`: what the committee's secretary may choose from when building a package or opening a finding vote, under `api.create_recommendation_package`'s checks in its order: the case's subjects, its allegations that are not withdrawn, and the current findings of the committee proceeding and the proceeding it was referred from. Ids, codes and positions; never narrative, references, people ids, the case id or number.
- `api.committee_items_view(committee_proceeding)`: what the items in front of the committee are about, for the deliberation audience (`authz.sees_proceeding_deliberation`) and, after the proceeding closes, the case team only: packages with their active items, and the FINDING votes the caller may deliberate.
- Both are VOLATILE and audited with counts only (`COMMITTEE_SCOPE_VIEWED`, `COMMITTEE_ITEMS_VIEWED`). No table, policy, grant or command is widened.
- **Label mode (2060 default).** A subject is shown by position and category. `decision.committee_label_policy` (effective-dated, migration-managed) holds ORDINAL, the narrowing reading of DEC-02's text. DISPLAY_NAME requires an `owner_decision_reference` (a check constraint), and no role can write the table. The DEC-02 label card to Fady is unanswered, so ORDINAL stays; if he answers A (display names), a later migration adds a DISPLAY_NAME row quoting his message here. Display names in My Work stay governed by DEC-22 (owner text: `/mnt/project-files/uiux/impl/phase12/PHASE12_PLAN.md` Appendix A, lines 396–418; repo record: `docs/business-architecture/OWNER_DECISIONS_FINALIZATION.md:197`), which does not cover this view.

### 7. CDF-213 and CDF-214 (AGENT-09, LOW)

- CDF-213: `api.add_recommendation_item` refuses a withdrawn allegation (`CONFLICT:ALLEGATION_WITHDRAWN`, as `record_finding` and `link_allegation_subject` do).
- CDF-214: `api.open_vote_item` accepts a FINDING vote only on the current version of a finding of the committee proceeding or the proceeding it was referred from (`decision.finding_in_committee_scope`, the rule `committee_scope_choices` uses); anything else is `INVALID:finding_id`.

### 8. The Defence Packet (AGENT-09, LOW; coordinator 12:44)

- CDF-217(1): whoever uploaded a redacted rendition never clears it (`CONFLICT:REVIEWER_IS_REDACTOR`), under the same `reviewer_must_differ` switch as the chooser rule, in `api.review_defence_packet_item` and in the guard on `grievance.defence_packet_review` (every path).
- CDF-218(1): `api.defence_packet_approval_view(packet)` lets the Restricted Case Authority read what it approves. It is bound to the approval request: `api.decide_restricted_defence_packet`'s checks through the same helpers in the same order, without its locks, and every refusal is NOT_FOUND. It returns the review record and what release would show the subject (reviewed titles, type and size of cleared items, redaction state, counts, what blocks release), never evidence: no evidence or version id, title, file, key, hash, bytes or note. VOLATILE and audited with counts (`DEFENCE_PACKET_APPROVAL_VIEWED`).
- The 2050 comment on `api.defence_packet_view` said it served the Restricted Case Authority; it serves the case's evidence leads only (the safe direction). Corrected.

### 9. Catalogue

P11-G2 closes: its seventeen form rows map to `api.close_case` (their SOURCE_REQUIRED notes stay), CASE_CLOSE and CASE_REOPEN name the new commands and stay PARTIAL, and S070/S086 now say the closure authority is what is SOURCE_REQUIRED.

## Not built here

- The phase 9/10 steps into CLOSURE stay disabled. A case past JURISDICTION, including a reopened case (REOPEN_CASE returns it to INVESTIGATION), has no step into CLOSURE yet: `CLOSURE_STEP_NOT_AVAILABLE`. This must be built before CDF configures `CASE_CLOSURE_APPROVAL_RULE`.
- Reconvening after a conflict reopening: closure now requires every proceeding concluded, so the committee proceeding that decided the package is concluded when the case reopens, and the DEC-AMB-013 re-vote needs a meeting in it. How it reconvenes (a governed reopening of that proceeding, or a new referral carrying the package) is not designed; until it is, a reopened case stays ACTIVE and cannot close (`TAINTED_BY_CONFLICT`). Reachable only once the authority is configured.
- Notifications and My Work kinds for closure and reopening approvals (UX, after 2085), post-closure monitoring tasks (AMB-219, `POST_CLOSURE_MONITORING = TASK`), emergency closure (S059), EXTERNAL_ORDER reopening, the closure checklist content and a reopen count.
- CDF-216, CDF-217(2), CDF-218(2) and CDF-219 stay in the Backlog.

## Consequences

- A case no longer closes over an open proceeding, an open grievance window, an open grievance or a pending authority decision, on any path. Four existing tests that closed such cases now conclude the proceedings first.
- Closure through `api.close_case` carries a structured outcome. The investigation app still offers the CDF_CASE_V1 steps; moving the workspace to `api.close_case` is UX work.
- Nothing new is reachable while `CASE_CLOSURE_APPROVAL_RULE` is SOURCE_REQUIRED: routed closure and reopening refuse with `CASE_CLOSURE_APPROVAL_RULE_REQUIRED`. The tests configure it on the owner connection with a synthetic source reference to prove the configured paths.
- PRODUCTION_SUBSTITUTION_REQUIRED: none beyond the existing notes; the closure and reopening commands are plain SQL. The closure authority is CDF's DoA, recorded by migration once confirmed.

## Tests

- `tests/security/case-closure-2060.spec.ts`: the outcome catalogue, readiness on every path, the three closure paths, R1–R3, `case_closure_view`, and T-AMB-127, T-AMB-128, T-AMB-129 and T-AMB-086 (kept with the closure tests; the ambiguity matrix's suggested files for these rows were placeholders).
- T-AMB-131 in `tests/security/workflow-bypass.spec.ts` (the system step, fail closed while unset, the new-evidence reopening; it replaces the fail-safe test that kept REOPEN_CASE disabled) and in `tests/security/recommendations-authority.spec.ts` (the DECISIVE_POST_DECISION_CONFLICT reopening); REC-T27 in `tests/security/records-disposition.spec.ts` (the retention recalculation).
- `tests/security/committee-scope-read-models.spec.ts`: the package read model (the spec's negatives N1–N15, the DEC-02 regression), the label mode, and CDF-213; `tests/security/committee-meetings.spec.ts`: CDF-214; `tests/security/evidence-half-2050.spec.ts`: CDF-217(1) and CDF-218(1).
- IDOR probes, the audit walk and the #20 coverage lists name every new function; the policy snapshot is regenerated.
