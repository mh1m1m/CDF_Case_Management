# ADR-049: A case's restricted status is lifted only by two-person control (migration 2130)

- **Status:** Proposed (2026-10-19). CDF-270 (under CDF-197), a follow-up to CDF-206 (migration 2015). Implemented in migration 2130 (Rebase), pending AGENT-09's security review. Synthetic reference implementation only.
- **Owner decision DEC-AMB-012 → C (2026-10-13, AMB-234):** "Restricted status may be lifted only through two-person control: the case's Restricted Case Authority plus an independent second authorized approver. Require reason, audit, and a preview of the access population/permissions that would become available after declassification. No user may approve their own second approval."
- **AGENT-09's conditions 012-C (a) to (f)** (its security review of the DEC-AMB placement): `api.change_case_classification` is not touched and keeps refusing; exactly one new writer of `is_restricted`; the lift re-checks everything in one transaction and consumes the approval; the preview is counts and role codes only; audit events and notices carry ids and codes only; the negative tests listed there.
- **Coordinator ruling (2026-10-19 01:42 UTC)** on the nine design points of the 2130 design note: "all nine defaults stand as built; none changes." Negative tests for points (1) to (5) ship in the same migration.
- **Protocol:** §19, §20, §21, §29, §39, §40, §82, §83, §87; DEC-01 (ADR-016 D1); DEC-AMB-012; T-AMB-145.

## Context

DEC-01 (ADR-016 D1) opens a restricted case with an eligible Restricted Case Authority (RCA), who becomes its owner. While a case is restricted, `CASE_VIEW_ALL` holders cannot see it (A-3), and several purpose gates stay closed: break-glass, the records catalogue, preliminary approval, legal-hold requests and the Grievance Committee's secretaries. Some approvals belong to the RCA alone (export consent, Defence Packet release, legal review, committee referral, grievance handling and recording, sanction extracts).

Before CDF-206, `api.change_case_classification` set `is_restricted` from its argument, so one person could lift a restriction. CDF-206 (migration 2015) made it refuse true → false (`CONFLICT:RESTRICTION_LIFT_NOT_DECIDED`) until the decided two-person path exists. That refusal stays: 2130 adds the path beside it.

## Decision

### 1. Settings (migration-managed; `config.setting` has no write grant)

- `RESTRICTION_LIFT_SECOND_APPROVER`: **SOURCE_REQUIRED**, null. Once configured from the Delegation of Authority it holds one role code. It is in force only when that role exists, is not technical, is not `PLATFORM_ADMIN` or `DB_ADMIN` (§21), and an active user holds it today (the `case_mgmt.closure_authority_role` rule). Anything else reads as unset, and every request is refused (`LIFT_APPROVER_NOT_CONFIGURED`): nothing pends.
- `RESTRICTION_LIFT_WINDOW_HOURS`: an engineering default of **24** (CONFIGURED, "ADR-049 engineering default (CDF security policy may override)"). A request lapses 24 hours after it is made if nobody decides it, and an approval lapses 24 hours after it is given if it is not used. A value that is not a whole number from 1 to 720 refuses every request and approval (`LIFT_WINDOW_MISCONFIGURED`).

### 2. The request record: `case_mgmt.restriction_lift_request`

- One row per request holds the case, its classification, the requester, the reason (5 to 2,000 characters), and the preview with its SHA-256 hash.
- Its status is `PENDING`, `APPROVED`, `REJECTED`, `LIFTED`, `EXPIRED` or `WITHDRAWN`. The row also holds the decider, the decision's reason, the approval's own preview snapshot, hash and expiry, the lifter and the end.
- At most one request per case is open (`PENDING` or `APPROVED`; a partial unique index).
- `case_mgmt.protect_restriction_lift_request` allows only the forward transitions, each changing only its own columns once. Check constraints tie a decision to someone other than the requester and a lift to the requester. Rows are never deleted or truncated.
- RLS is enabled with no policy and no grant: the row is read only through the read models below. Reasons stay on the row and never reach the ledger.

### 3. Who acts

- **The requester and lifter is the case's RCA**: the case's owner, a Restricted Case Authority for its classification (`authz.is_restricted_case_authority`), who can view the case. **The lift is made by the requester while still owner and RCA.** After a handover (`api.reassign_case`) nobody can lift the request: the former RCA withdraws it or it lapses, and the new RCA requests again.
- **The second approver** is active and holds the configured role. They hold clearance at or above the case's classification and are not an external account. They are not the requester and not the case's owner, have no declared conflict on the case (`authz.user_case_gate`), and have **no active assignment on the case** (they are independent of the team the RCA directs). Approving gives them no case access.

### 4. The preview (counts and role codes only; condition d)

- One function, `case_mgmt.restriction_lift_preview`, computes what lifting would open. For each gate the restriction closes, it counts the active users who would pass the gate (cleared, unconflicted, not external) but cannot view the case now, by the role code that gives the access.
- The gates are `CASE_VIEW_ALL`, `BREAK_GLASS_REQUEST`, `ARCHIVE_RECORD_VIEW`, `PRELIMINARY_APPROVE` and `LEGAL_HOLD_REQUEST`, plus `GRIEVANCE_COMMITTEE_SECRETARY` through `authz.user_committee_seat`; a secretary with no role shows as `NONE`.
- The preview also gives the distinct total and the list of RCA-only approvals that stop applying. It holds no names, user ids, case number or title.
- The preview is bound three times; any difference is `PREVIEW_CHANGED`:
  - **At the request:** it is snapshotted, and the requester passes the hash they previewed.
  - **At the approval:** it is recomputed and snapshotted again; the approver passes the hash they saw, which must equal both.
  - **At the lift:** it is recomputed and must equal the approval's hash.

### 5. Commands (SECURITY DEFINER, `search_path = ''`, the actor from `api._actor()`, no user-id argument)

1. **`api.preview_restriction_lift(case)`**: the RCA only. It returns the preview and its hash, and audits `RESTRICTION_LIFT_PREVIEWED`.
2. **`api.request_restriction_lift(case, reason, preview_hash)`**: the RCA, on a restricted case whose records are ACTIVE or CLOSED.
   - The approver's role must be in force and the window valid.
   - **No restricted-only approval may be pending**: an export waiting for the RCA's consent, or a Defence Packet waiting for the authority (`RESTRICTED_APPROVALS_PENDING`). Their commands refuse an unrestricted case, so a lift would strand them.
   - At least one eligible approver must exist other than the requester (`NO_ELIGIBLE_APPROVER`).
   - A lapsed open request on the case is first expired, with its audit event. An unlapsed one blocks (`LIFT_ALREADY_REQUESTED`).
   - It audits `RESTRICTION_LIFT_REQUESTED` and notifies each eligible approver.
3. **`api.decide_restriction_lift(request, APPROVE|REJECT, reason, preview_hash)`**: the second approver, on a `PENDING` request that has not lapsed.
   - Refusals: `REQUESTER_CANNOT_APPROVE`, `RCA_CANNOT_APPROVE`, `ALREADY_DECIDED`, `REQUEST_CLOSED`, `REQUEST_LAPSED`.
   - An approval is also refused for `CASE_NOT_RESTRICTED`, `RESTRICTED_APPROVALS_PENDING` and `PREVIEW_CHANGED`. A rejection is never blocked by those.
   - It audits `RESTRICTION_LIFT_APPROVED` or `RESTRICTION_LIFT_REJECTED` and notifies the requester.
4. **`api.lift_case_restriction(request)`**: the requester, still the RCA. It locks the case, then the request, and re-checks everything in one transaction (condition c):
   - the case is still restricted and writable;
   - the request is `APPROVED`, not consumed (`APPROVAL_CONSUMED`) and not lapsed (`APPROVAL_LAPSED`);
   - the approver is still eligible and still not the lifter, the requester or the owner (`APPROVER_NOT_ELIGIBLE`);
   - nothing is pending, and the preview is unchanged.

   Then the single new writer of `is_restricted` sets it false, and the request becomes `LIFTED` in the same transaction. It audits `RESTRICTION_LIFTED` with the ids, the hash, the classification and `restricted_from: true`, `restricted_to: false`.

5. **`api.expire_restriction_lift(request)`**: any party, once the request or approval has lapsed (`NOT_LAPSED` before then). It audits `RESTRICTION_LIFT_EXPIRED`.
6. **`api.withdraw_restriction_lift(request)`**: the requester, on a `PENDING` or `APPROVED` request. It audits `RESTRICTION_LIFT_WITHDRAWN`. A withdrawal is needed when a changed preview leaves an approval unusable.

A request id answers `NOT_FOUND` to anyone who is not its requester (while they can view the case), the case's current RCA, or an eligible approver, exactly as for an id that names nothing. Audit events carry ids, codes, the hash and the classification, never a reason (condition e).

### 6. Read models (flag == command)

- **`api.restriction_lift_status(case)`**, for the RCA only (otherwise `NOT_FOUND` or `FORBIDDEN`), shows:
  - whether the case is restricted, the approver role in force, `may_preview`, and `may_request` with its refusal code;
  - the case's open request, else its latest one, with its state and preview;
  - `may_lift` with its refusal code, `may_withdraw` and `may_expire`.

  Reasons appear only on the reader's own request.

- **`api.my_restriction_lift_approvals()`**, for eligible approvers, lists the open requests they could decide or expire. Each row has the request id, the classification, the times, the requester's reason, the preview and its hash, `may_decide` with the approval's refusal code, and `may_expire`. It shows **no case id and no case number** (DEC-22).

### 7. Notifications (ADR-025; ids only)

- There are two mandatory templates: `RESTRICTION_LIFT_APPROVAL_REQUESTED`, sent to each eligible approver, and `RESTRICTION_LIFT_DECIDED`, sent to the requester. Both have object type `RESTRICTION_LIFT` and deep link `/restriction-lifts/<id>`.
- The inbox links the root only once its page ships (`LIVE_PURPOSE_ROOTS`).
- The in-app wording is in `packages/i18n`. The notification registers carry the two as PROPOSED texts.

### 8. TS layer

- **Contracts:** `RESTRICTION_LIFT_*` lists and the view types.
- **Validation:** one schema per command, none with a user id.
- **Application:** `createRestrictionLiftService`. Validation runs before the gateway; only access refusals are recorded as `COMMAND_DENIED`, with no reasons.
- **Infrastructure:** `PostgresRestrictionLiftGateway`. It renames keys, and a missing flag reads as false.
- **i18n:** the refusal codes (including CDF-206's `RESTRICTION_LIFT_NOT_DECIDED`) and the two templates.

## Consequences

- A restricted case can now become unrestricted, but only with two people, a reason, an audit trail and a bound preview. One person never does it alone, and nobody does it while the setting is unset (SOURCE_REQUIRED: today nobody can).
- `api.change_case_classification` is unchanged: true → false is still refused (condition a). The static test allows exactly two writers of `is_restricted`: that command and `api.lift_case_restriction` (condition b). No role gains UPDATE on it.
- No role gains a permission, and nothing is widened before 2160. The eight functions are granted to `authenticated` and decide everything themselves. The table and the internal helpers are not reachable by any application role.
- After a lift, the case follows the unrestricted rules. The users the preview counted can open it through their roles, and the RCA-only approvals stop applying. The request blocks a lift while an export consent or a Defence Packet waits for the authority, so neither is stranded. Sanction-extract rows carry `source_restricted` and stay decidable.

## Known limitations

- **No page yet.** UX owns the RCA's panel and the approver's queue page (the inbox shows the notices without a link until `/restriction-lifts` ships). The commands, flags and gateway are ready, and there is no end-to-end test until the page exists.
- **The events are not in the case history.** `RESTRICTION_LIFT_*` events are on the audit ledger (readable by auditors) but are not in `api.case_history`'s action-audience catalogue, so the case team's history tab does not show them. Adding them is a read-model change for UX's page.
- **Restricting the case again** is still the existing `api.change_case_classification` with `RESTRICTED_CASE_GRANT` (A-3). A consumed request is never reused (`APPROVAL_CONSUMED`).
- **One window for both stages.** The 24-hour window is an engineering default until CDF security policy sets one.

## Production mapping

None new. The rule lives in database command functions and their tests and carries over unchanged to RDS PostgreSQL. The second approver's role must come from the CDF Delegation of Authority (SOURCE_REQUIRED). Notifications go through the existing outbox (ADR-025), whose e-mail transport remains `PRODUCTION_SUBSTITUTION_REQUIRED`.

## Tests

- **`tests/security/restricted-case-authority.spec.ts`** (T-AMB-145), the static test plus 9 tests:
  - the full path, with counts and role codes only, an ids-only ledger and ids-only notices;
  - the setting unset or misconfigured, and no eligible approver;
  - self approval, approval by the requester or the RCA, a second decision, a handover, and lifting or withdrawing by the approver;
  - an approver without clearance, with a conflict or on the team, both when deciding and at the lift;
  - lapsed requests and approvals, expiry, and reuse of a consumed approval;
  - pending restricted approvals;
  - `PREVIEW_CHANGED` at the request, the approval and the lift;
  - outsiders and random ids;
  - the table's integrity.

  Seventeen mutations of the controls were each caught.

- **`tests/security/api-idor.spec.ts`:** `NOT_FOUND` probes for the case-id commands (in the main outsider sweep) and the request-id commands (their own describe, with a check that the probes are not vacuous). The T-AMB-142 pinned list is unchanged: no command takes a user id.
- **`tests/security/audit-bypass.spec.ts`:** a walk step for each of the six audited commands. The two read models are in its read-only list.
- **`tests/integration/restriction-lift.spec.ts`:** the service and gateway against the database, with the negatives for the coordinator's points (1) to (5).
- **Unit tests:** the service, the schemas, the gateway mapping and the i18n catalogues.
- **`tests/integration/mirrors.spec.ts`:** the templates and object types.

## Requirements

DEC-AMB-012 (AMB-234, R5, CRITICAL); CDF-270; T-AMB-145; DEC-01 (ADR-016 D1); CDF-206 (migration 2015); AGENT-09's conditions 012-C; the coordinator's ruling of 2026-10-19 01:42 UTC.
