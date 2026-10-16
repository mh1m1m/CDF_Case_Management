# ADR-046: People and access without widening anyone's reach (migration 2100)

- **Status:** Proposed (2026-10-15). Linear CDF-251 (earlier PR-C migrations ran under CDF-196, the rebase decision application). Implemented in migration 2100 (Rebase PR-C, second of 2090 to 2140, pending security review). Placement confirmed by the coordinator on 2026-10-15: "2100 People and access (ADR-046) → AMB-017, 022 (task type only), 023 delegation (only if it grants no access the person lacked; grant half → 2160), 044, 121, 205."
- **Ambiguity rows** (owner-default answers from `docs/business-architecture/AMBIGUITY_REGISTER_200.md`):
  - AMB-017 (R4): "Criteria are SOURCE_REQUIRED. The platform supports an URGENT flag with a mandatory reason that notifies the GRC Director by template code only; it never transfers the case automatically." Test T-AMB-007.
  - AMB-022 (R2): "Yes, through a task-scoped, purpose-scoped, time-bound authorisation that exposes only the material in the task. No case discovery, no identity."
  - AMB-023 (R3): "A time-bound, evidenced, audited delegation of preliminary approval, modelled like sector referral delegation (from, to, scope, evidence, audit). No automatic fallback to another role." Test T-AMB-010.
  - AMB-044 (R4): "Transfer of open proceedings needs the governance decision that dissolves the committee (charter, SOURCE_REQUIRED). Platform: a deactivated committee opens no new proceeding; transfer is an audited snapshot amendment naming the decision reference." Test T-AMB-022.
  - AMB-121 (R3): "External counsel acts through a LEGAL_REVIEWER account flagged EXTERNAL with packet-only access; anything sent by email goes through the governed export. Engaging an external firm remains a procurement decision." `EXTERNAL_COUNSEL_ENABLED = false`. Test T-AMB-071.
  - AMB-205 (R2): "Report as an incident; the workbook id is revoked so any later import is refused; a found copy imports only after review." Test T-AMB-122.
- **Coordinator rulings:** nothing is widened before 2160; "AMB-022 EXTERNAL_EXPERT task type goes in as a task type only, with no new permission"; "AMB-017 and AMB-023 delegation: build them only if they grant no access that the person did not already hold; a delegation that confers the delegator's access on the delegate is a widening and its grant half moves to 2160 (keep the delegation record and its revocation in 2100 if you can split them cleanly)"; restricted-case access never grows without its authority; reasons never go in audit metadata.
- **Protocol:** §18–§23, §29, §39, §65, §82, §83, §87.

## Context

Six questions about people and their access had no platform answer. A committee could not be stood down, so a committee being dissolved would keep receiving work. A lost continuity workbook could be imported later, possibly tampered with. External counsel had no way in short of an internal account. An external or technical expert had no task type. An urgent matter had no way to reach the GRC Director ahead of normal pacing. The GRC Sector Head's approval had no record of who stands in during an absence.

Each answer must narrow, record or flag. Under the ruling, none may give anyone a permission, a role grant or a way into a case they did not already have.

## Decision

### 1. Committee deactivation (AMB-044)

- `committee.committee_status_change`: every deactivation and reactivation, with the governance decision's reference and a reason. Append-only and readable by those who can see the committee registry.
- `api.deactivate_committee(committee, decision_reference, reason)`. Checks in order: FORBIDDEN without `COMMITTEE_ADMIN`; NOT_FOUND; `COMMITTEE_INACTIVE`; INVALID decision_reference or reason; `COMMITTEE_HAS_OPEN_WORK`. Open work is an open proceeding, a referral on its way to the committee (not accepted or withdrawn), or a grievance under one of its rule sets that is not yet decided, inadmissible or withdrawn.
- **Nothing is transferred.** `COMMITTEE_TRANSFER_RULE` is SOURCE_REQUIRED, so a committee with open work is not deactivated. The transfer described in the register (an audited snapshot amendment naming the decision) waits for that rule.
- **On every path (T-AMB-022).** The commands that open a proceeding or file a referral already look for an active committee. A trigger on `committee_proceeding`, `referral` and `grievance` refuses a new row for an inactive committee (`COMMITTEE_INACTIVE`), the table owner's included. It share-locks the committee row, so a deactivation running at the same time either sees the new row as open work or is seen as done.
- `api.reactivate_committee`: the same checks and shape (`COMMITTEE_ACTIVE` when already active). **It is a restore, not a widening** (accepted on this condition, coordinator 2026-10-15 08:16): it gives back what the committee could do before the governance decision and gives no one access. It reappoints nobody: neither command touches a seat, and every member comes back only through `api.appoint_committee_member`. Snapshotted visibility on the committee's proceedings is left as it was.
- Audit: `COMMITTEE_DEACTIVATED` and `COMMITTEE_REACTIVATED` (`ADMIN`), with the status-change id and committee code; the reason stays in the row.

### 2. Revoking a lost continuity workbook (AMB-205)

- `exchange.bcp_workbook_revocation`: one per workbook id on a case (unique, case-insensitive), citing the incident, with a reason. Append-only, and readable by those who can see the case and hold `BCP_IMPORT` or `BCP_IMPORT_APPROVE`.
- `api.revoke_bcp_workbook(case, workbook_id, incident_reference, reason)`: NOT_FOUND unless the caller sees the case; FORBIDDEN without a BCP permission; INVALID workbook_id; `WORKBOOK_REVOKED` if already revoked. The workbook need not have been staged. It takes the same advisory lock as staging, so a staging running at the same time either sees the revocation or is seen as open.
- **On every path (T-AMB-122).** A trigger refuses a new batch of a revoked workbook and any move of one to SUBMITTED, APPROVED or IMPORTED (`WORKBOOK_REVOKED`). A batch already staged can only be rejected or cancelled.
- `api.bcp_import_batch_view` (2040) gains `workbook_revoked`. `may_submit`, `may_apply` and the new `may_approve` follow the refusals.
- Audit: `BCP_WORKBOOK_REVOCATION_RECORDED` (`BUSINESS`, for the case trail) and `BCP_WORKBOOK_REVOKED` (`SECURITY`, the incident), with the count of open batches only.
- **The revocation is permanent.** Importing a found copy after review needs a lifting rule (who reviews, on what evidence) that is not decided.

### 3. External counsel accounts (AMB-121)

- `EXTERNAL_COUNSEL_ENABLED` is CONFIGURED `false`, the register's fail-safe default. `authz.external_counsel_enabled()` is true only when the value is exactly `true`.
- `iam.external_account`: the one-way flag, with the engagement reference and a reason. Append-only, read by the account itself and by role administrators.
- A flagged account:
  - holds no permission but `LEGAL_OPINION_GIVE`, and that only while enabled (`authz.has_permission`, `authz.user_has_permission`);
  - passes no case gate (`authz.user_case_gate`, `authz.user_can_view_case`), so no assignment, grant, task, seat, break-glass or role reaches a case for it;
  - reaches a legal-review packet through `authz.user_packet_gate`, which is the case gate with an external account let through while enabled. For every other account the two gates are the same, so the four legal-review commands (2030; the request and the restricted approval as 2099 last defined them), their mirrors in the reviewer's read model (`decision.legal_opinion_refusal` and `decision.superseding_opinion_refusal`, 2095) and `authz.can_view_packet` behave as before for internal reviewers, and each flag of `api.legal_review_view` still equals its command for an external account;
  - reads only its own directory row (`user_profile_directory` is narrowed);
  - is refused, at the table and on every path, any role but `LEGAL_REVIEWER`, any case assignment, case grant, committee seat, sector position or portal link (`EXTERNAL_ACCOUNT`).
- `api.flag_external_counsel_account(user, engagement_reference, reason)`. Checks in order: FORBIDDEN without `ROLE_ADMIN`, or for the caller's own account; INVALID user_id unless active; `ALREADY_EXTERNAL`; INVALID texts; `ROLES_NOT_ELIGIBLE` (no `LEGAL_REVIEWER`, or any other active role); `ACCOUNT_HOLDS_ACCESS` (an active assignment, an unexpired grant, a current seat or sector position, an unrevoked portal link or a current delegation of preliminary approval). Whatever the account holds is ended first through its own command.
- Audit: `EXTERNAL_COUNSEL_FLAGGED` (`ADMIN`), no reason and no metadata.
- Anything sent to external counsel by email still goes through the governed export (ADR-026).

### 4. An external or technical expert (AMB-022)

- The role `EXTERNAL_EXPERT` holds no permission.
- The task type `EXTERNAL_EXPERT` (category `EXPERT`, added to the category check) confers `CASE_VIEW_METADATA` only, to holders of that role, for 7 days by default and 30 at most. The task model of ADR-014 is the authorisation: time-bound, purpose-bound, scoped and audited, with no discovery, identity or content.
- Exposing the specific material a task is about, item by item, is a Phase 12 task flow.

### 5. An urgent matter (AMB-017)

- `URGENT_ESCALATION_CRITERIA` is SOURCE_REQUIRED and not invented. The flag records the preparer's or the case team's judgement.
- `case_mgmt.case_urgent_flag`: one active flag per case, with a mandatory reason and the number of directors told. Cleared once with a reason, never deleted. Read under case visibility.
- `api.flag_case_urgent(case, reason)` and `api.clear_case_urgent(case, reason)`: NOT_FOUND unless the caller sees the case; FORBIDDEN unless they edit it or hold `PRELIMINARY_PREPARE`; `CASE_NOT_ACTIVE`; `ALREADY_URGENT` or `NOT_URGENT`; INVALID reason.
- **Who is told (T-AMB-007).** Each active GRC Director who can already open the case, other than the person who flagged it, is told by `CASE_URGENT_FLAGGED` (mandatory, in-app and email) with the case id and a deep link only. On a restricted case that is only a director the Restricted Case Authority let in. The flag records how many were told, so a screen can say when nobody was. It never transfers the case, changes who can see it, or skips the preliminary review (Q11).
- Clearing recalls nothing and tells nobody.
- Audit: `CASE_URGENT_FLAGGED` (with the count told) and `CASE_URGENT_CLEARED` (`BUSINESS`); the reasons stay in the row.

### 6. Delegation of preliminary approval: the record only (AMB-023)

- **Decided at research time: split.** A delegation that let the delegate approve would confer the GRC Sector Head's authority on someone who lacked it, which is a widening. Under the ruling, 2100 keeps the record and its revocation and grants nothing. The grant half moves to 2160.
- `iam.preliminary_approval_delegation`, modelled on the sector delegation (1880, DEC-F08): delegator, delegate, from, to, evidence reference, reason; revoked once with a reason, never deleted. Read by the delegator, the delegate and role administrators.
- `api.delegate_preliminary_approval(delegate, from, to, evidence_reference, reason)`: FORBIDDEN without `PRELIMINARY_APPROVE`; no backdating (INVALID effective_from); an end after the start (INVALID effective_to); the delegate is another active account that is not external (INVALID delegate_id); evidence and reason required; never two overlapping, unrevoked delegations to the same delegate (`DELEGATION_OVERLAP`).
- `MAX_PRELIMINARY_APPROVAL_DELEGATION_DAYS` is SOURCE_REQUIRED. As with DEC-F08, no maximum applies until it is configured. Once configured, a longer delegation is refused (`DELEGATION_TOO_LONG`), and a value that is not a whole number of days refuses every new delegation (`DELEGATION_LIMIT_MISCONFIGURED`), on every path.
- `api.revoke_preliminary_approval_delegation(delegation, reason)`: NOT_FOUND unless the caller is a party or a role administrator; FORBIDDEN for the delegate; `DELEGATION_NOT_ACTIVE` once revoked or ended.
- **It grants nothing (T-AMB-010).** `api.approve_preliminary_recommendation` and `api.preliminary_approval_queue` are unchanged and still require `PRELIMINARY_APPROVE`. A delegate inside the window, a delegate of a window not yet begun and anyone else are all refused. 2160 adds the grant half and must also check, at use, that the delegator still holds the authority.
- Audit: `PRELIMINARY_APPROVAL_DELEGATED` (delegate id and window) and `PRELIMINARY_APPROVAL_DELEGATION_REVOKED` (`ADMIN`); the reasons stay in the row.

### 7. Reads, audit and grants

- Audit events carry ids, codes, dates and counts; every reason stays in its row.
- No permission or role grant changes for an existing role. Replaced with narrowing-only changes, keeping their signatures: `authz.has_permission`, `authz.user_has_permission`, `authz.user_can_view_case`, `authz.user_case_gate`, `authz.can_view_packet`, the four legal-review commands (2030 and 2099) with their two mirrors (2095) and `api.bcp_import_batch_view`; the `user_profile_directory` policy is narrowed. Helpers and triggers are not executable by application roles; `authz.current_user_is_external` is executable by `authenticated` because the directory policy calls it, and answers only about the caller.
- The catalogue: COMMITTEE_REGISTRY, BCP_CONTINUITY, LEGAL_REVIEW, PRELIM_ASSESSMENT and PRELIM_RECOMMENDATION name their new commands, and CASE_TASKS the expert task type, delivered in 2100. CASE_ESCALATION (the escalation states) stays PLANNED.

## Open questions and SOURCE_REQUIRED values

- `COMMITTEE_TRANSFER_RULE`: how open work moves when a committee is dissolved (AMB-044).
- Lifting a workbook revocation after a found copy is reviewed: who reviews, on what evidence (AMB-205).
- `URGENT_ESCALATION_CRITERIA`: which matters are urgent (AMB-017).
- `MAX_PRELIMINARY_APPROVAL_DELEGATION_DAYS` (AMB-023), and the grant half in 2160.
- Turning `EXTERNAL_COUNSEL_ENABLED` on is the owner's decision once an engagement exists (AMB-121).
- Screens and read models for these commands: UX, Phase 12.

## Known limitations

- `api.my_work_items` does not list a legal review assigned to an external account, even while enabled: its `LEGAL_REVIEW_ASSIGNED` row gates on `authz.user_case_gate`, which an external account never passes. It fails closed: the packet itself is reachable and nothing more is shown. That gap is CDF-231 (LOW, Backlog), a Phase 12 read-model change (gate the row on `authz.user_packet_gate`) that the coordinator passes to the UI/UX thread when this PR opens (coordinator, 2026-10-15 08:16). T-AMB-071 pins today's behaviour.
- An external account still reads reference tables whose policies need only a signed-in user (catalogues, codes, settings). They hold no case content or personal data.
- The urgent flag tells no one when no GRC Director can open the case. The flag records zero, and the case team escalates through the Restricted Case Authority.

## Consequences

- A committee can be stood down without losing any open work, a lost workbook can no longer be imported, external counsel and experts have a narrow way in, an urgent matter reaches the GRC Director by code, and an absence of the GRC Sector Head is recorded, all without widening anyone's access.
- `BCP_WORKBOOK_REVOKED` is a security event; the case trail has its business twin.
- One notification template (`CASE_URGENT_FLAGGED`), one role and one task type are added (contracts and i18n updated). Nothing is renamed or removed (DEC-35).
- PRODUCTION_SUBSTITUTION_REQUIRED: the email channel of `CASE_URGENT_FLAGGED` uses the prototype mail adapter (ADR-025). External counsel accounts are prototype Supabase Auth accounts until the CDF IdP federates them.

## Production mapping

Tables, triggers and functions in PostgreSQL; they move to RDS PostgreSQL unchanged. External counsel accounts are provisioned through the CDF corporate IdP (or its guest federation) in production. No new service.

## Tests

- `tests/security/people-access-2100.spec.ts`:
  - T-AMB-022: refusals (FORBIDDEN, NOT_FOUND, INVALID, `COMMITTEE_ACTIVE`, `COMMITTEE_INACTIVE`); no referral on the case path, the direct-referral path or the table; the status change read and audited without its reason; append-only; reactivation; refused while a draft referral is open. A deactivated Grievance Committee receives no grievance, at the table too.
  - T-AMB-071: flagging refusals; disabled, the account reads nothing (no packet, case, subject, allegation, package, proceeding or colleague, and no permission) and is not assignable to a review; enabled, it reads only its packet and gives its opinion, and `api.legal_review_view`'s two flags equal the opinion commands before and after it (2095's mirrors take the packet gate too); every table refuses it a role, assignment, grant, seat, position or link; disabled again, the packet, both opinion commands and the read model are out of reach at once (NOT_FOUND); the flag kept and audited without its reason; My Work does not list the review (CDF-231, pinned). A current delegate is not flagged, and a flagged account never becomes a delegate.
  - The expert task: the role holds no permission and the task gives the case's metadata for a limited time, never its content.
- `tests/security/notifications.spec.ts` T-AMB-007: who may flag (NOT_FOUND before FORBIDDEN); ids only in every outbox value; both directors told on case 0001, the flagger never; nobody on restricted case 0003 the Deputy cannot open (count zero); clearing recalls and sends nothing; the flag kept.
- `tests/security/referral-preliminary.spec.ts` T-AMB-010: delegation refusals; overlap; nobody approves through it, inside or outside the window; read by the parties and role administrators only; revocation by the delegator or a role administrator, not the delegate; audit without reasons; append-only. The SOURCE_REQUIRED maximum, enforced once configured and failing closed, on every path.
- `tests/security/bcp-import.spec.ts` T-AMB-122: a revoked workbook is never staged, submitted, approved or imported, on every path; the view's capabilities follow; the two audit events.
- `api-idor.spec.ts`: probes for the four case- or delegation-scoped functions with seven outsiders; the committee, flag and delegation commands join the administrative commands.
- `audit-bypass.spec.ts`: walk steps for the eight commands; `authz.current_user_is_external` documented.
- Updated: `purpose-read-models-2040.spec.ts` (the batch view's `workbook_revoked` key and `may_approve` capability, pinned to `api.decide_bcp_import` APPROVE); `bcp-import.spec.ts` (the read-only grant on `bcp_workbook_revocation`). The policy snapshot.
- Mutation checks (nine): telling a director who cannot open the case, telling the flagger, dropping the FORBIDDEN check, letting the delegate revoke, dropping the overlap check, delegating to an external account, not counting a delegation as access held, and either 2095 opinion mirror keeping the case gate. Each fails a test.

## Requirements

AMB-017, AMB-022, AMB-023, AMB-044, AMB-121, AMB-205; T-AMB-007, T-AMB-010, T-AMB-022, T-AMB-071, T-AMB-122; ADR-014, ADR-025, ADR-026, ADR-034; DEC-F08; CDF-251 (CDF-196 before it).
