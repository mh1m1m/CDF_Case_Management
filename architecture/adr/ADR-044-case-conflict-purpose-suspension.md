# ADR-044: A conflict of interest raised on the case itself (P11-G7, DEC-F38), and members who investigated the case do not judge it (AMB-053) (migration 2080)

- **Status:** Proposed (2026-10-15). Linear CDF-196 (rebase decision application). Implemented in migration 2080 (Rebase PR-B, pending security review). Answers ADR-038 open question 3 and closes gap P11-G7 of ADR-035; placed in 2080 by ADR-040's placement table.
- **Owner decision** (recorded in `docs/business-architecture/OWNER_DECISIONS_FINALIZATION.md` §13):
  - DEC-F38 (2026-10-13): "An upheld conflict affecting a user's participation suspends that user's ordinary case-content access for the conflicted purpose. It does not necessarily remove unrelated lawful access from a separate, independently authorized purpose. Access is purpose-scoped: `CONFLICT → REVOKE/SUSPEND AFFECTED PURPOSE GRANTS`, never `CONFLICT → DELETE USER`. For committee participation the restriction is absolute for the affected proceeding or meeting: no packet, no attendance, no deliberation, no vote."
  - DEC-F05 (2026-10-13), which the subject's position follows: no automatic entitlement to a separate hearing; the decider may ask for clarification or evidence where necessary.
- **Ambiguity rows:**
  - AMB-057 (R1, CRITICAL): "Yes, for the conflicted purpose: affected purpose grants are suspended; committee participation is absolutely excluded; unrelated independent purposes stay." Test T-AMB-034.
  - AMB-053 (R3, HIGH): "Fail-safe default: a member who was assigned to investigate the case is treated as conflicted for its committee proceedings. Configurable when DEC-05 is answered." Setting `PRIOR_INVESTIGATOR_IS_CONFLICTED = true`. Test T-AMB-030.
- **Coordinator rulings:** the conflict decider is never the raiser or the subject; the subject never reads a concern about them; reasons never go in audit metadata; no permission is widened before 2160; an access predicate is only narrowed (ADR-040).
- **Protocol:** §18–§22, §29, §33, §65, §82, §83, §87.

## Context

Before 2080 a case conflict acted in one place, `authz.has_conflict(case, user)`. It is true for a current CONFLICT_DECLARED or CONFLICT_CONFIRMED declaration, and for a party to the case (a subject's linked portal account, the grievant). Every case purpose passes through it, by `authz.user_case_gate` or `authz.user_can_view_case`: the case file, assignments, grants, tasks, break-glass, legal review, committee proceedings, meetings, deliberation, packets and votes. So a conflict already suspends every purpose the user holds on that case, and touches neither the account nor any other case.

Only the person concerned could declare a conflict (`api.declare_conflict`). On the case, nobody could raise someone else's (gap P11-G7, catalogue form T3-B1.2-050); migration 2000 built that only inside a committee meeting (ADR-038). DEC-F38 answers the access question ADR-038 left open.

Separately, nothing stopped a committee member from judging a case they had investigated (AMB-053).

## Decision

### 1. Raising another person's conflict on the case (P11-G7)

- `api.raise_case_conflict(case, subject_user_id, reason)`. Checks in order: NOT_FOUND (cannot see the case); FORBIDDEN (no CONFLICT_DECLARE); INVALID subject_user_id (null, unknown or not ACTIVE); `OWN_CONFLICT` (one's own conflict is declared, never raised); `CASE_NOT_ACTIVE`; `CONCERN_ALREADY_OPEN` (the raiser's own open concern about that person); INVALID reason (10 to 2000 characters).
- The subject is any active user. A concern may be raised before the person takes part, for example about a committee member before a referral. Whether the subject is cleared or already conflicted is not checked, so raising tells the raiser nothing about them.
- Several people may each raise one about the same person. A raiser learns only of their own open concern, never of anyone else's.
- `case_mgmt.case_conflict_concern` holds the case, subject, raiser, reason, status (OPEN, UPHELD, DISMISSED) and the decision. Check constraints: the raiser is not the subject, and the decider is neither. It is decided once, its content is immutable, and it is never deleted.
- Audit `CASE_CONFLICT_RAISED`: the subject's id only. The reason stays in the row.

### 2. The decision

- `api.decide_case_conflict(concern, decision, reason)`. Checks in order: NOT_FOUND (the concern is not readable, which includes its subject); FORBIDDEN (no CONFLICT_MANAGE, or the caller raised it or is its subject); `CASE_NOT_ACTIVE`; `NOTHING_TO_DECIDE`; INVALID decision (UPHELD or DISMISSED); INVALID reason.
- The decider can see the case, so has no conflict on it. The command locks the case row, then the concern.
- Audit `CASE_CONFLICT_DECIDED`: the subject's id and the decision code. The reasons stay in the row.
- An OPEN concern changes no access: DEC-F38 acts on an upheld conflict.
- The subject is not told or heard (DEC-F05, as in a meeting). The decider asks for clarification outside the system where needed.

### 3. Upheld: the subject's purposes on the case are suspended (DEC-F38, AMB-057)

- An UPHELD concern counts in `authz.has_conflict` (replaced; the 1910 terms are unchanged). Through the gate every path already uses, the subject gets NOT_FOUND on the case, its file, its tasks, grants and break-glass, its legal review, and its committee proceedings, meetings, deliberation, packets and votes. They no longer count towards quorum, and later meetings do not invite them. For committee participation the restriction is absolute, as DEC-F38 requires.
- As for a declared conflict (0700), the decision ends the subject's active assignments and revokes their active grants on the case, with the reason "Conflict of interest upheld" (`CASE_UNASSIGNED`, `CASE_ACCESS_REVOKED`). They cannot be assigned or granted again (`ASSIGNEE_HAS_CONFLICT`, `GRANTEE_HAS_CONFLICT`), and cannot clear themselves (`api.declare_conflict` returns NOT_FOUND). Committee seats and snapshot rows are not touched: the gate excludes them.
- **The affected purpose.** On the case, it is every purpose the user holds there. This is the narrowing default. DEC-F38 says an upheld conflict "does not necessarily" remove an independent purpose. Keeping one purpose on the same case apart from the conflict would widen access compared with today. That needs a named purpose and the owner's review, so it is not built.
- **What stays (never DELETE USER).** The account, its roles and every other case stay. So do the portal paths that never rested on the case gate (a subject's own defence notices, a grievant's own grievance). These are the unrelated, independent purposes.
- **Not built: reversal.** An upheld case conflict is final, like a CONFIRMED declaration. Reversing it would restore access, which is a widening. DEC-AMB-010 (AMB-055) allows reversal for a meeting only. A case-level reversal needs an owner decision.

### 4. Members who investigated the case do not judge it (AMB-053)

- `PRIOR_INVESTIGATOR_IS_CONFLICTED`: CONFIGURED `true` as the AMB-053 fail-safe default (DEC-05 open). Only the value `false` turns it off (case and surrounding spaces ignored; any other value keeps the rule) (`case_mgmt.prior_investigator_rule`). Changing it is a migration that cites the owner's answer to DEC-05.
- A **prior investigator** is a user ever assigned to the case as INVESTIGATOR or LEAD_INVESTIGATOR, in any status (`authz.prior_investigator_conflicted`; internal, not granted).
- The **seats that judge** are CHAIR, DEPUTY_CHAIR, MEMBER and ALTERNATE_MEMBER (an alternate votes when activated).
- **Referral snapshot** (`committee.open_committee_proceeding`, replaced): a prior investigator in a seat that judges is recorded as `case_gate_excluded`: non-voting, not invited, no member view of the proceeding (DEC-F38: no packet, attendance, deliberation or vote). This is the same as an uncleared member. `COMMITTEE_PROCEEDING_OPENED` adds the count `prior_investigator_members`; they are also counted in `case_gate_excluded_members`.
- **Snapshot amendment** (`api.amend_proceeding_snapshot`, replaced): such a member is refused with `PRIOR_INVESTIGATOR`, after `NOT_CLEARED_FOR_CASE`.
- **After the snapshot** (trigger on `case_mgmt.case_assignment`, every path): someone sitting in a seat that judges, not excluded, in an OPEN committee proceeding of the case is not assigned to investigate it (`COMMITTEE_MEMBER_OF_CASE`).
- **The referral preview** (`api.committee_referral_preview`, replaced): counts such a member as not cleared, so it still equals the snapshot. The shape is unchanged: no id, name or per-seat flag.
- **The investigation stays.** A current investigator keeps the case-team purpose, and with it the case team's view of the proceeding. Only the member's seat is excluded.
- **Not covered:** secretaries (they do not judge); proceedings snapshotted before 2080 (snapshots are append-only); and the Grievance Committee firewall (Q45–Q46), which is unchanged and applies in addition.

### 5. Reads

- RLS on the table, select only (`authz.can_view_case_conflict_concern`). A concern is read by the raiser and by conflict managers who can see the case, never by its subject, even a conflict manager. There are no write grants.
- `api.case_conflict_concerns(case)`: NOT_FOUND unless the case is visible. It returns `may_raise` and the readable concerns, with their reasons, decision and `may_decide`. The capability flags are the commands' checks in the commands' order, without locks; false, never null. Not audited (a read).
- The new events are not in `api.case_history`'s catalogue, so they never reach history. The resulting `CASE_UNASSIGNED` and `CASE_ACCESS_REVOKED` show as any other team change does.
- **The ledger (AGENT-09 R1 on PR #82; CDF-225).** The case-team branch of `audit_event_read` (migration 1410) admitted every `BUSINESS` event of a case the reader can view, so the subject read `CASE_CONFLICT_RAISED`, and with it who raised the concern. The same held on main since 2000 and 2030 for `MEETING_CONFLICT_RAISED`, `MEETING_CONFLICT_DECIDED` and `MEETING_CONFLICT_REVERSED` (CDF-225, placed in 2080 by the coordinator). The policy is altered so that branch leaves out these five events. The exclusion is on the reader side, so rows written before 2080 are covered and no ledger row is touched. The other two branches are unchanged: oversight (`AUDIT_VIEW`: Internal Audit, the DPO) and security monitoring read as before, and the case team reads every other `BUSINESS` event of the case.
- Known limit: an oversight reader who is also the subject of a concern still reads its events, as they read the whole ledger by design (§29).
- That residual is placed with 2160 (S6, dual control and seat conflicts) by the coordinator on 2026-10-15: a subject holding an oversight seat is a seat-level conflict; backlog, narrowed from true to false only when built.

### 6. Catalogue

P11-G7 closes. T3-B1.2-050 names the case commands and loses its gap reference. CASE_CONFLICT_OF_INTEREST lists the three functions, delivered in 2080.

## Open questions and SOURCE_REQUIRED values

- DEC-05 (independence rules, open): whether a prior investigator may sit, which assignment roles count, and whether secretaries are covered. Defaults: as in §4.
- A same-case purpose kept apart from an upheld conflict (§3): none is named, so every purpose on the case is affected.
- Reversing an upheld case conflict (§3): not built.
- My Work kinds and notifications for an open concern awaiting a decider, and the screens (UX, Phase 12). Until then deciders find concerns through `api.case_conflict_concerns`.

## Consequences

- Anyone on a case who may declare a conflict can now raise someone else's. A conflict manager decides it, and an upheld one removes that person from every purpose on the case at once, committees included.
- No permission or role grant changes. Every replaced function only narrows, and so does the altered audit read policy (§5). No catalogue code, status or option code is renamed or removed (DEC-35).
- A committee member who investigated the case is excluded from its proceedings, and a sitting member is not assigned to investigate it. Fixtures that seated a case's investigator on that case's committee now see the member excluded (two tests updated).
- The form catalogue table reflows in `FORM_CATALOGUE_RATIONALIZATION.md`: with P11-G7 closed, no form row has a gap reference, so the gap column narrows. The change is whitespace only.
- PRODUCTION_SUBSTITUTION_REQUIRED: none. The commands are plain SQL; users come from the CDF IdP as everywhere else.

## Production mapping

One table, a setting, a trigger and functions in PostgreSQL; they move to RDS PostgreSQL unchanged. No new service.

## Tests

- `tests/security/case-conflict-2080.spec.ts`:
  - Raising: who may raise; the subject; one's own conflict; duplicates; an open concern changes nothing; the ledger; append-only.
  - Who reads a concern: never the subject, even a conflict manager; outsiders get NOT_FOUND.
  - Deciding: never the raiser or the subject; DISMISSED changes nothing; decided once.
  - T-AMB-034: after an upheld conflict, NOT_FOUND through every purpose, while the account and other case stay; assignment ended; grant revoked; no re-assignment or new grant.
  - Committee participation: absolute exclusion and quorum.
  - T-AMB-030: a former investigator is snapshotted non-voting and excluded; the preview and audit counts.
  - A current investigator keeps the case.
  - The assignment trigger and the amendment.
  - The setting turned off, and fail safe on any other value.
  - The helpers are not callable by application roles.
  - The ledger (AGENT-09 R1, CDF-225): the subject and everyone else on the case read no `CASE_CONFLICT_*` row, open or dismissed; no subject, raiser, member or case-team reader reads a `MEETING_CONFLICT_*` row (raised, dismissed, upheld, reversed); oversight reads them all.
- `tests/security/audit-read-policy.spec.ts`: the case-team branch leaves out the five events written as fixture rows (as before 2080), and oversight reads them.
- IDOR probes for the three functions; audit walk steps for the two commands; the catalogue tests; the policy snapshot.
- Updated:
  - `my-work-phase12.spec.ts`: case B's investigator, seated as an alternate, is now not cleared in the preview.
  - `api-idor.spec.ts`: the 2050 fixture assigns the lead before the referral.
  - `audit-bypass.spec.ts`: the walk's alternate member is not case A's lead investigator.
  - `meeting-excuses-concerns.spec.ts`: T3-B1.2-050 no longer carries P11-G7.
- The ambiguity matrix suggests `authz-purpose-bound.spec.ts` and `committee-access.spec.ts` (new cases) for T-AMB-034 and T-AMB-030. The tests are in the new spec; the Ambiguities thread owns the matrix.

## Requirements

DEC-F38, DEC-F05; AMB-053, AMB-057; ADR-038 open question 3; FORM_CATALOGUE_RATIONALIZATION.md §6 (P11-G7); catalogue item T3-B1.2-050; CDF-196.
