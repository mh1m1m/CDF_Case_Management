# ADR-043: Corrective action from preliminary review (P11-G3, DEC-F41), and closure fails closed when the configured closure authority is not in force (CDF-221) (migration 2070)

- **Status:** Proposed (2026-10-14). Linear CDF-196 (rebase decision application) and CDF-221. Implemented in migration 2070 (Rebase PR-B, pending security review). Builds on ADR-033 (corrective actions), ADR-036 (preliminary closure outcomes), ADR-040 §3 item 3 (DEC-F13 authority rules) and ADR-042 (2060 closure).
- **Owner decision** (recorded in `docs/business-architecture/OWNER_DECISIONS_FINALIZATION.md`):
  - DEC-F41 (2026-10-13): "The architecture may let a corrective action originate from preliminary Compliance review, but not automatically for every preliminary case: only where the configured business rule permits. The preliminary team may recommend a corrective action without escalating to the Investigation Committee where the matter needs no committee investigation or disciplinary action. Any authority or approval requirement for the action follows its corrective-action type. Configurable and auditable."
  - DEC-F13 (2026-10-13), which the authority half follows: "Build `ACTION / RECOMMENDATION TYPE → AUTHORITY RULE` with effective dates. Known disciplinary authority may be configured; every other mapping without an approved source stays `SOURCE_REQUIRED`."
- **Coordinator rulings** (2026-10-14): 23:17 (CDF-221 placed in 2070: closure fails closed when `CASE_CLOSURE_APPROVAL_RULE` is CONFIGURED with no valid authority, mirroring reopening, with a negative test, recorded here and in the closure specification §10), 23:27 (2070 scope: DEC-F41 plus CDF-221).
- **AGENT-09 item:** CDF-221 (2026-10-14, LOW): with the rule CONFIGURED but naming no valid authority, `case_mgmt.closure_authority_role()` is null and 2060's closure fell back to direct closure, while reopening already failed closed. Unreachable while the rule is SOURCE_REQUIRED.
- **Ambiguity row:** AMB-021 (R1): "Yes where the configured rule permits it, by corrective-action type; authority and approval come from the action type." Setting `PRELIMINARY_CORRECTIVE_ACTION_TYPES`, empty by default.
- **Protocol:** §18–§22, §29, §65, §68, §82, §83, §87.

## Context

Gap P11-G3: ADR-033 opens corrective actions only from a CORRECTIVE_ACTION or GOVERNANCE_REMEDIATION item that the Investigation Committee adopted and the authority approved. A matter that stays with Compliance after its preliminary review (no escalation) had no way to carry a corrective action, although three catalogue forms describe one: the no-escalation decision (T4-B1.2-011), the simplified corrective-action approval (T9-B2.2-176) and the internal settlement (T9-B3.1-141).

DEC-F41 allows it only where a configured rule permits, and puts the authority and approval with the action's type. The rule here is fail closed: until CDF configures which types a preliminary review may recommend, none may, and nothing in the preliminary review, the package path or corrective-action tracking changes.

CDF-221 is a gap in 2060. "Configured" and "an authority in force" were the same test (`closure_authority_role()` not null). A CONFIGURED rule naming a technical, unknown or unheld role read as unset (2060 R3), and unset meant the direct closure that existed before 2060. Reopening already refused in that state.

## Decision

### 1. CDF-221: a configured closure rule with no authority in force closes nothing

- `case_mgmt.closure_rule_configured()` says whether `CASE_CLOSURE_APPROVAL_RULE` is CONFIGURED, whatever it names. `case_mgmt.closure_authority_role()` (2060) stays the authority in force or null.
- CONFIGURED with no authority in force: `api.close_case` refuses with `CONFLICT:CASE_CLOSURE_APPROVAL_RULE_REQUIRED` straight after NOT_FOUND, as `api.request_case_reopening` does. The readiness guard refuses every ACTIVE→CLOSED change with the same code (so `api.transition_case` SCREEN_OUT and OUT_OF_JURISDICTION are refused too). `api.available_transitions` gives the code on a step into CLOSURE, still only to a caller with the step's permission who passes `user_case_gate` (2060 R2). Nothing is written.
- SOURCE_REQUIRED is unchanged: the direct closure of 2060. A real authority is unchanged: routed closure. `api.decide_case_closure` and the reopening commands already refused in this state.

### 2. The rule: which types a preliminary review may recommend (AMB-021)

`PRELIMINARY_CORRECTIVE_ACTION_TYPES` (config.setting, migration-managed, no role writes it) holds a comma-separated list of corrective-action types. It ships SOURCE_REQUIRED, which permits none. Only CORRECTIVE_ACTION and GOVERNANCE_REMEDIATION count; anything else in the value permits nothing more. The register calls it "configured, empty by default"; SOURCE_REQUIRED with no value is that.

### 3. Which outcomes may carry one (narrowing default)

DEC-F41 limits it to "where the matter needs no committee investigation or disciplinary action". Of the preliminary outcomes, NO_ACTION, NOT_SERIOUS and NOT_SUBSTANTIATED keep the matter with Compliance (`case_mgmt.preliminary_corrective_outcome`). Escalations (INVESTIGATION_WARRANTED, REFERRED_TO_COMMITTEE) and the outcomes that send the matter elsewhere or end it unprocessed (OUT_OF_SCOPE, DUPLICATE, TRANSFERRED, NON_PROCESSABLE, CHANNEL_ABUSE, NOT_FEASIBLE, NO_PERSONAL_JURISDICTION) are excluded. This is fixed in code as the narrowing reading; widening it is a later migration.

### 4. Proposals: part of the recommendation

- `api.propose_preliminary_corrective_action(recommendation, action_type, summary)`: only the recommendation's preparer, holding PRELIMINARY_PREPARE, while it awaits review or approval and before anyone reviewed it. Checks in order: NOT_FOUND; FORBIDDEN; `CASE_NOT_ACTIVE`; `RECOMMENDATION_NOT_OPEN_FOR_PROPOSALS`; `OUTCOME_NOT_ELIGIBLE_FOR_CORRECTIVE_ACTION`; INVALID action_type; `PRELIMINARY_CORRECTIVE_ACTION_NOT_PERMITTED`; INVALID summary.
- `case_mgmt.preliminary_corrective_proposal` is append-only and numbered per recommendation. A guard repeats the checks on every path. The review and approval of the recommendation cover its proposals; a returned version's proposals lapse, and the next version proposes again or not at all.
- Audit `PRELIMINARY_CORRECTIVE_ACTION_PROPOSED`: ids, version, sequence and type; never the summary.

### 5. The approval fixes the authority each proposal needs (DEC-F13)

Approving the recommendation, on every path (a trigger on the status change), checks each proposal's type is still permitted and has an authority rule in force, else refuses the approval (`PRELIMINARY_CORRECTIVE_ACTION_NOT_PERMITTED`, `AUTHORITY_RULE_MISSING`, as a package submission does). It then snapshots the rule, its source status and its joint authorities into `decision.preliminary_authority_requirement` (append-only; a guard accepts only the rule in force for an approved recommendation). A proposal with no requirement reads as awaiting its authority (fail closed).

### 6. Recording the authority's decision (N15 pattern)

- `api.record_preliminary_authority_decision(proposal, authority_type, outcome, decided_at, decided_by_label, source_document_reference, reason)`: a corrective-action manager (CORRECTIVE_ACTION_MANAGE within clearance and without a case conflict) records each required authority's APPROVED or REJECTED decision from its source document. Checks in order: NOT_FOUND; FORBIDDEN; `PROPOSER_CANNOT_RECORD`; `CASE_NOT_ACTIVE`; `RECOMMENDATION_NOT_APPROVED`; `AUTHORITY_TYPE_MISMATCH`; `AUTHORITY_ALREADY_DECIDED`; INVALID outcome, decided_at (in the future, or a Riyadh date before the approval), label, source or reason.
- `decision.preliminary_authority_decision` is append-only, one row per required authority (a foreign key to the requirement). Its guard refuses the proposer on every path.
- Audit `PRELIMINARY_AUTHORITY_DECISION_RECORDED`: ids, authority type, outcome, rule and its source status, the resulting state, and `has_reason`; the reason stays in the row.
- A proposal is PROPOSED, LAPSED, AWAITING_AUTHORITY, REJECTED (any authority rejected it) or APPROVED (every required authority approved it) (`decision.preliminary_proposal_state`).

### 7. Opening actions (ADR-033 unchanged)

- `api.open_preliminary_corrective_action(proposal, title, description, owner, due_date)` runs `api.open_corrective_action`'s checks in its order, with the proposal in place of the item: NOT_FOUND; the manager; `PROPOSAL_NOT_APPROVED`; the restricted-case owner naming; owner eligibility; the policy due date. Actions are numbered per proposal; the event, notification and audit are the same, with `origin: PRELIMINARY_REVIEW` in the metadata.
- `decision.corrective_action.preliminary_proposal_id` is the action's origin. A check constraint allows exactly one origin: an item and its decision (every existing row), or a proposal. A guard refuses an action whose proposal is not APPROVED, on another case or of another type; the origin is immutable (`decision.protect_corrective_records`).
- Everything after opening (owner, progress, completion, verification, reopening, waiver) is ADR-033 as it stands. An action from a proposal has no authority decision that a later decision could supersede, so DEC-AMB-014 dispositions do not apply to it.

### 8. Closure readiness (2060)

`case_mgmt.closure_blocks` adds the preliminary path: an APPROVED proposal with no action is `CORRECTIVE_ACTIONS_OUTSTANDING` (its actions already count as corrective actions of the case), and a proposal AWAITING_AUTHORITY is `DECISION_NOT_FINAL`. A REJECTED or LAPSED proposal blocks nothing.

### 9. Reads

- RLS on the three tables, select only. Proposals are read as their recommendation is (`authz.can_view_preliminary_recommendation`: the case team, and the approver while it awaits them or after they approved it); requirements and decisions by the case team.
- `api.preliminary_corrective_view(recommendation)`: the proposals with their state, `outcome_eligible`, `permitted_action_types` and `may_propose`; for the case team only, each proposal's authorities with their decision and `may_record`, its actions and `may_open_action`. Capability flags are the commands' checks in the commands' order, without locks; false, never null. Not audited (a read; NOT_FOUND to anyone who cannot read the recommendation).
- `api.corrective_action_view` (2040): the team's `origin` also carries `source` (AUTHORITY_DECISION or PRELIMINARY_REVIEW) and `preliminary_proposal_id`. The owner still sees no origin.

### 10. Catalogue

P11-G3 closes: T4-B1.2-011, T9-B3.1-141 and T9-B2.2-176 name the new commands and lose their gap reference; PRELIM_RECOMMENDATION, AUTHORITY_DECISION and CORRECTIVE_ACTION list them, delivered in 2070.

## Open questions and SOURCE_REQUIRED values

- `PRELIMINARY_CORRECTIVE_ACTION_TYPES`: which types CDF permits (AMB-021). Until then nothing is reachable.
- The authority for CORRECTIVE_ACTION and GOVERNANCE_REMEDIATION (DEC-F13): no rule is seeded, so an approval with a proposal refuses with `AUTHORITY_RULE_MISSING` even once the types are configured.
- Who records the authority's decision: CORRECTIVE_ACTION_MANAGE (Case Manager, GRC Director) is the default, as for opening the action. T9-B2.2-176 names the Committee Secretary as the form's data owner; there is no committee on this path.
- The eligible outcomes (§3) are the narrowing default, not an owner list.
- My Work kinds and notifications for a proposal awaiting its authority (UX, after 2085), and the screens (Phase 12).

## Consequences

- Nothing changes while both settings are SOURCE_REQUIRED and no authority rule exists for the corrective types: proposals are refused, approvals of recommendations without proposals are unchanged, and closure is unchanged.
- A case whose closure authority is configured but not in force can no longer be closed on any path; CDF must correct the setting (CDF-221).
- A proposal waiting for its authority keeps the case open; a rejected one does not.
- PRODUCTION_SUBSTITUTION_REQUIRED: none beyond ADR-033's (owners from the CDF IdP, evidence files in OSS); the commands are plain SQL.

## Production mapping

| Prototype                                                    | Production (PRODUCTION_SUBSTITUTION_REQUIRED)                         |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `PRELIMINARY_CORRECTIVE_ACTION_TYPES` set by migration       | The same setting, set by migration from CDF's approved rule           |
| Authority decision recorded from a source document reference | The same, with the document in the private OSS vault once UX S2 lands |

## Tests

- `tests/security/preliminary-corrective-2070.spec.ts`: AMB-021 (refused while SOURCE_REQUIRED and for a type the rule does not allow; the matrix's suggested `corrective-actions.spec.ts` was a placeholder), the eligible outcomes, the preparer-only window, the approval's fail-closed checks and joint authorities, recording (proposer refused, conflicted manager, duplicates), opening and the action's immutable origin, a rejected proposal, closure readiness on close, SCREEN_OUT and `available_transitions`, and the read model by audience.
- `tests/security/case-closure-2060.spec.ts`: CDF-221 under each invalid value (PLATFORM_ADMIN, DB_ADMIN, SOC_ANALYST, an unknown role, unheld roles), on `api.close_case`, SCREEN_OUT and `available_transitions`, with no leak to those who may not close and nothing written.
- IDOR probes for the four functions, the audit walk, and the policy snapshot.
