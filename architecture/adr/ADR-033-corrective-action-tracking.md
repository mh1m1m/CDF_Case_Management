# ADR-033: Corrective-action tracking

- **Status:** Proposed (2026-10-12). Linear CDF-203 (EPIC 12 corrective actions, CDF-17). Implemented in migration 1940 (local, pending security review). Security-sensitive.
- **Protocol:** §19, §29, §39, §65, §68, §83, §87; ADR-021, ADR-023, ADR-025, ADR-016 DEC-61, DEC-62; CDF-73 option D; owner Q&A Q69, Q72, Q79.

## Context

The committee may recommend non-disciplinary corrective actions and governance remediation (Q72), alongside sanctions in one package (Q69), and the competent authority approves, modifies, partially approves or rejects them (Q79, ADR-023). ADR-023 says approved items create corrective actions; nothing yet tracked them. The CRM status list has a dozen execution statuses for this (S013–S020, S036, S037, S049, S068, S099), rationalized to a per-action status and a derived case-level execution state (CRM_STATUS_RATIONALIZATION.md). Who may own an action, default due periods, the completion evidence and who may waive one are not sourced (SOURCE_REQUIRED).

## Decision

1. **Actions come only from an approved decision.** `decision.corrective_action` is opened from a CORRECTIVE_ACTION or GOVERNANCE_REMEDIATION item that the committee adopted and the effective authority decision approved, approved as recommended or modified (`ITEM_NOT_APPROVED` otherwise). The item and the decision are fixed on the action; one item may need several actions, numbered per item.
2. **One status per action; the case-level state is derived.** OPEN → IN_PROGRESS (progress reported) → PENDING_VERIFICATION (completion submitted) → COMPLETED (verified); a return goes back to IN_PROGRESS; a completed action whose effect was not achieved is reopened; WAIVED is final. Overdue is derived from the due date (a calendar date in Riyadh) while the action is with its owner. The case's execution state (NOT_STARTED, IN_PROGRESS, FOLLOW_UP, PARTIALLY_EXECUTED, EXECUTED, OVERDUE) is computed from the approved items and their actions (`executionState` in `@cdf/domain`), never stored. Every change is an append-only `corrective_action_event`.
3. **The owner is purpose-bound (CDF-73 option D).** The owner holds `CORRECTIVE_ACTION_OWN` (role IMPLEMENTATION_OWNER, OWNER_DEFAULT) and must pass the case gate (active, cleared for the case, not conflicted) when named and for as long as they keep the action. They see their own action and its history, never the case, item, package or decision. Losing the role, the clearance or the gate removes the action from them (`NOT_FOUND`).
4. **Managers run the action; the owner reports.** `CORRECTIVE_ACTION_MANAGE` (Case Manager, GRC Director; OWNER_DEFAULT) on a case the manager can see opens actions, names or changes the owner, moves the due date, verifies, returns and reopens. Only the current owner records progress and submits completion.
5. **Whoever did the work does not sign it off.** Verification is refused to the owner and to anyone who ever submitted the action's completion, whatever their permissions; the table refuses an owner as verifier.
6. **A restricted case keeps its authority (DEC-61/62 precedent).** On a restricted case only its Restricted Case Authority (the case owner holding RESTRICTED_CASE_AUTHORITY) names or changes the owner (`RESTRICTED_CASE_AUTHORITY_REQUIRED`), and the owner must be cleared for the case's classification. The coordinator raises this with the owner with the other restricted-case rules; it is configurable only by migration for now.
7. **A waiver is the authority's, with its source document (N15 pattern).** `CORRECTIVE_ACTION_WAIVE` is held by no role until the Delegation of Authority names one (SOURCE_REQUIRED); a waiver records the source document reference and is final.
8. **Policy is effective-dated and seeded empty.** `corrective_action_policy` per action type holds the default due period, a reminder before the due date, the escalation delay after it and the completion evidence asked for (`REFERENCE_REQUIRED` or `NOTE_ONLY`). `api.set_corrective_action_policy` (`CORRECTIVE_ACTION_POLICY_ADMIN`, GRC Director) adds versions; none is edited. The seeded rows are SOURCE_REQUIRED placeholders: no default period (a due date is always given), no reminder, no escalation, and an evidence reference required (the strictest setting). Evidence files wait for UX S2; the reference names a document or system record.
9. **A case does not close with work outstanding (EPIC 12).** Closing a case is refused while an approved actionable item has no action or an action that is not completed or waived (`CORRECTIVE_ACTIONS_OUTSTANDING`). Actions on a closed case are not reopened or waived.
10. **Notifications carry ids only (ADR-025, N18).** Mandatory: CORRECTIVE_ACTION_ASSIGNED and CORRECTIVE_ACTION_RETURNED (also on reopening) to the owner. Event rules (in-app on, email off, SOURCE_REQUIRED): CORRECTIVE_ACTION_CHANGED (due date moved or waived) to the owner, CORRECTIVE_ACTION_SUBMITTED to the managers who can see the case, CORRECTIVE_ACTION_DUE to the owner and CORRECTIVE_ACTION_OVERDUE to the owner and those managers. The last two are queued by the scheduler's reminder run only when a policy sets them, once per due date. A notice goes to the owner only while they can still open the action (role, clearance and case gate, AGENT-09 L1); the change is recorded and audited either way.

## Consequences

- Every executed or waived action traces to the authority decision and its source document.
- The owner's title and description are written for them; like the defence notice, the UI must warn that this text reaches someone outside the case team.
- With the placeholders, nothing is chased automatically; the overdue flag and the case's execution state are the only signals until the policy is sourced.
- Nobody can waive an action until the Delegation of Authority names the holder; until then an action that should not be done must be completed with a note, or the case stays open.
- Impact assessment after execution (S099) and post-sanction follow-up (S101) are not modelled; they need a sourced process.
- Permissions are OWNER_DEFAULT pending the Delegation of Authority (SOURCE_REQUIRED).

## Open questions (SOURCE_REQUIRED; raised with the owner by the coordinator)

Recorded from AGENT-09's early look on 1940 (2026-10-12). Both fail closed or follow the seeded roles; nothing changes until the owner answers.

1. **Approved items that need no action.** With `CORRECTIVE_ACTION_WAIVE` held by no role, an approved item that turns out to need no action blocks the case's closure until the Delegation of Authority names a holder.
2. **A case subject as owner.** A case subject who holds the Implementation Owner role is not excluded as an action's owner unless a declared conflict or a portal link to the case excludes them. Whether subjects must always be excluded is the owner's call.

## Production mapping

| Prototype                                          | Production (PRODUCTION_SUBSTITUTION_REQUIRED)                         |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| IMPLEMENTATION_OWNER granted by the platform admin | Owners from the CDF IdP and HR source, by the Delegation of Authority |
| Reminder run from the prototype scheduler          | CDF job runner on the Alibaba runtime                                 |
| Evidence reference as text                         | Evidence files in the private OSS vault once UX S2 lands              |

## Requirements

Q69, Q72, Q79; EPIC 12 (CDF-17); CRM statuses S013–S020, S036, S037, S049, S068. Tests: `tests/security/corrective-actions.spec.ts`, corrective-action IDOR probes, the audit walk, `packages/domain/src/corrective-actions.test.ts`, `packages/application/src/corrective-actions.test.ts`.
