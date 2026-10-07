# ADR-014: Purpose-Bound Records and Legal Authorization Model

- **Status:** Proposed (2026-10-07). Implemented in CDF-73 (`20261007001700_purpose_bound_access.sql`, `20261007001710_purpose_bound_commands.sql`), stacked on ADR-013's implementation (PR #14).
- **Decision owner:** Fady, 2026-10-07 16:24 (option D, "Task-Scoped, Purpose-Bound and Lifecycle-Aware Access").
- **Linear:** CDF-73, classified **SECURITY HARDENING** (not accepted risk). Found in the security review of PR #14.
- **Supersedes in part:** ADR-013 D9 (the role-wide `RECORDS_VIEW` permission). Everything else in ADR-013 stands.
- **Protocol:** §19 (authorization), §21 (roles), §40 (search authorises before results, counts and facets), §87 (no UI-only authorization, UUIDs authorised on every lookup).

## Context

ADR-013 gave `RECORDS_OFFICER`, `LEGAL_REVIEWER`, `GRC_DIRECTOR` and `INTERNAL_AUDIT` the permission `RECORDS_VIEW`, and `authz.can_view_records(case_id)` granted it on every non-restricted case within the user's clearance. It did not look at the lifecycle state. As a result `api.list_records()` returned the case number, type, classification and state of every **active** investigation to records and legal staff who could see nothing of those cases under RLS (CDF-73, MEDIUM).

The finding showed an architectural problem rather than a missing filter: the model conflated **functional authority** (a records officer administers retention and disposition; a legal reviewer manages legal holds) with **case visibility**. Neither function needs a permanent catalogue of every investigation. In a whistleblowing platform, the existence and classification of an ongoing investigation are themselves need-to-know.

## Decision

Apply need-to-know, purpose limitation, least privilege and case-level authorization. Six kinds of access are separated and evaluated by separate predicates:

| Access                              | Mechanism                                                                                                    | Predicate                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1. Case discovery                   | Controlled exact-match lookup `api.request_case_for_legal_hold(case_number, justification)`; never browsing  | `authz.can_discover_case()`                                                                               |
| 2. Case content                     | Assignment, access grant, `CASE_VIEW_ALL` (non-restricted), or approved break-glass; unchanged otherwise     | `authz.can_view_case` = `authz.can_view_case_content`                                                     |
| 3. Records lifecycle authority      | Records catalogue scope (post-closure, non-restricted) with `ARCHIVE_RECORD_ADMINISTER`, or a records task   | `authz.can_manage_retention`, `authz.can_manage_disposition`, `authz.can_approve_disposition`             |
| 4. Legal hold authority             | Hold request → routed assessment task → apply or reject; release by two holders, each authorised on the case | `authz.can_request_legal_hold`, `can_review_legal_hold`, `can_apply_legal_hold`, `can_release_legal_hold` |
| 5. Task-specific access             | `case_mgmt.case_task`: case, user, role, purpose, scope, status, due date, access window and expiry          | `authz.task_grants(case_id, capability)`                                                                  |
| 6. Exceptional access (break-glass) | `case_mgmt.break_glass_access`: reason, duration, approval by someone else, post-event review                | `authz.has_active_break_glass` inside `authz.user_can_view_case`                                          |

The combined minimum-metadata rule is:

```
can_view_case_metadata(user, case) =
      explicit case access (assignment / grant / CASE_VIEW_ALL / break-glass)
   OR authorised case task (active, unexpired, scope ∋ CASE_VIEW_METADATA, role still held)
   OR records-catalogue scope (ARCHIVE_RECORD_VIEW ∧ records_state ≠ ACTIVE ∧ not restricted)
   AND always: classification ≤ clearance ∧ no declared conflict ∧ active user
```

There is no rule of the form `role = RECORDS_OFFICER → all cases` or `role = LEGAL_REVIEWER → all cases`.

### D1. Capabilities

New permission codes: `CASE_DISCOVER`, `CASE_VIEW_METADATA`, `CASE_VIEW_CONTENT`, `CASE_TASK_ASSIGN`, `LEGAL_HOLD_REQUEST`, `LEGAL_HOLD_REVIEW`, `RETENTION_TASK_VIEW`, `RETENTION_TASK_EXECUTE`, `DISPOSITION_TASK_VIEW`, `DISPOSITION_TASK_EXECUTE`, `ARCHIVE_RECORD_VIEW`, `ARCHIVE_RECORD_ADMINISTER`, `RECORDS_LIFECYCLE_ADMIN`, `BREAK_GLASS_REQUEST`, `BREAK_GLASS_APPROVE`. `LEGAL_HOLD_APPLY` and `LEGAL_HOLD_RELEASE` (ADR-013) are kept. `CASE_VIEW_METADATA` and `CASE_VIEW_CONTENT` are derived from case relationships and are never mapped to a role. `RECORDS_VIEW` is retired: the code stays for history and no role holds it. Role defaults are in `SECURITY_RULES.md`; the authority behind each remains `SOURCE_REQUIRED` (CDF Delegation of Authority).

### D2. Task types

`case_mgmt.case_task_type` ships nine types. Each names the capabilities it may confer (always including `CASE_VIEW_METADATA`, never content) and the roles that may hold it. Records types exist only once a case has left `ACTIVE`.

| Type                     | Confers (besides minimum metadata)                  | Eligible roles                       |
| ------------------------ | --------------------------------------------------- | ------------------------------------ |
| `LEGAL_REVIEW`           | `LEGAL_HOLD_REQUEST`                                | Legal reviewer                       |
| `LEGAL_HOLD_ASSESSMENT`  | `LEGAL_HOLD_REVIEW`, `LEGAL_HOLD_APPLY`             | Legal reviewer, GRC director         |
| `LEGAL_HOLD_APPLICATION` | `LEGAL_HOLD_APPLY`                                  | Legal reviewer, records officer, GRC |
| `LEGAL_HOLD_RELEASE`     | `LEGAL_HOLD_RELEASE`                                | Legal reviewer, GRC director         |
| `RETENTION_REVIEW`       | `RETENTION_TASK_VIEW`, `RETENTION_TASK_EXECUTE`     | Records officer                      |
| `ARCHIVE_TRANSFER`       | `RETENTION_TASK_VIEW`, `ARCHIVE_RECORD_ADMINISTER`  | Records officer                      |
| `DISPOSITION_REVIEW`     | `DISPOSITION_TASK_VIEW`, `DISPOSITION_TASK_EXECUTE` | Records officer                      |
| `DISPOSITION_APPROVAL`   | `DISPOSITION_TASK_VIEW`                             | GRC director                         |
| `DISPOSITION_EXECUTION`  | `DISPOSITION_TASK_VIEW`, `DISPOSITION_TASK_EXECUTE` | Records officer                      |

A task grants a capability only if it is in the task's scope **and** the user holds it through a role (RBAC ∧ task). Tasks are created by a case authority (`CASE_TASK_ASSIGN` and content access) or, for records types within the catalogue scope, by a `RECORDS_LIFECYCLE_ADMIN` holder. Restricted cases can be tasked only by someone who can see them. Every task expires (type default and maximum); access stops at `expires_at`, at completion, cancellation or when the role is revoked, with no housekeeping needed. Completed, cancelled and expired tasks are immutable and undeletable.

### D3. Records catalogue

`records.case_record_catalogue` is the only records-wide read model. It exposes case id and number, case type, classification, closure date, retention class and dates, legal hold status, archive status, disposition status and the owning department. It never exposes title, summary, people, allegations, interviews, findings, evidence descriptions or reporter identity. It is a `security_invoker` view over the definer function `records.catalogue_rows()`, which returns only rows the caller may see under D0's rule. `api.list_records` (ADR-013), every `records.*` policy and every records command follow automatically, because `authz.can_view_records` now means the same thing. `api.search_records_catalogue` adds filters and a `total_count` computed over authorised rows only.

### D4. Legal hold without global browsing

1. An authorised business user (case team with `LEGAL_HOLD_REQUEST`, or a task holder whose scope includes it) files `api.request_legal_hold`.
2. If legal or records staff must act on a case they are not related to, `api.request_case_for_legal_hold` accepts an exact case number and a justification, checks `CASE_DISCOVER`, applies a per-user rolling-hour limit (`config.setting CASE_DISCOVERY_RATE_LIMIT`, engineering default 5), audits `CASE_DISCOVERY_REQUESTED` and, on a match, `LEGAL_HOLD_CASE_DISCOVERED`, and files the same request. It returns only the outcome, request id, case id, case number and hold status. Missing, restricted, conflicted, out-of-clearance and disposed cases all return `NO_MATCH`. No content, task or grant is created.
3. A case authority routes the request with `api.assign_legal_hold_request`, creating a `LEGAL_HOLD_ASSESSMENT` task for a reviewer.
4. The assigned reviewer applies (through ADR-013's `api.place_legal_hold`, so lock order, disposition blocking and `LEGAL_HOLD_PLACED` apply unchanged) or rejects with `api.review_legal_hold_request`. Either way the task completes and the access ends.

### D5. Break-glass

`api.request_break_glass(case_id, reason, minutes)` is available only on a case whose metadata the requester can already see, never on restricted, archived or disposed cases. A different `BREAK_GLASS_APPROVE` holder who can see the case approves it; access then lasts for the requested duration (15 minutes to 72 hours) or until ended. Every approved access enters `review_status = PENDING` and must be post-reviewed by an approver other than the requester. All steps are SECURITY audit events. `BREAK_GLASS_REQUEST` is held by legal reviewers only; it is not part of any routine records or legal workflow.

### D6. Audit coverage

| Required event                 | Implementation                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `RECORDS_CASE_METADATA_VIEWED` | `api.open_case_metadata`                                                                                  |
| `RECORDS_TASK_OPENED`          | `api.open_case_task`                                                                                      |
| `RETENTION_REVIEW_STARTED`     | first opening of a `RETENTION_REVIEW` task                                                                |
| `DISPOSITION_REVIEW_STARTED`   | first opening of a disposition task                                                                       |
| `LEGAL_HOLD_REQUESTED`         | `api.request_legal_hold`, `api.request_case_for_legal_hold`                                               |
| `LEGAL_HOLD_CASE_DISCOVERED`   | matched controlled lookup                                                                                 |
| `LEGAL_HOLD_REVIEWED`          | `api.review_legal_hold_request`                                                                           |
| `LEGAL_HOLD_APPLIED`           | recorded as ADR-013's `LEGAL_HOLD_PLACED` (same event; the name is kept so existing evidence stays valid) |
| `LEGAL_HOLD_RELEASED`          | ADR-013, unchanged                                                                                        |
| `CASE_ACCESS_DENIED`           | `api.open_case`, `api.open_case_metadata`, `api.open_case_task` (SECURITY)                                |
| also                           | `CASE_DISCOVERY_REQUESTED`, `CASE_TASK_ASSIGNED/COMPLETED/CANCELLED/EXPIRED`, `BREAK_GLASS_*`             |

Audit `reason` carries codes; justifications stay in their own records (§83).

### Governing principles

> Authority to perform a records-management or legal function SHALL NOT, by itself, confer authority to discover or access unrelated investigation cases. Access SHALL be derived from an explicit case relationship, purpose-bound task, authorized records-lifecycle catalogue scope, or controlled exceptional-access mechanism.

> Case lifecycle state SHALL influence permitted records-management operations, but SHALL NOT automatically override classification, restricted-case controls, confidentiality requirements or case-level access restrictions.

## Rejected alternatives

- **Alternative A: assignment-only for every records action.** Rejected: it would require an assignment on every closed case before routine retention or disposition work, which obstructs enterprise records lifecycle administration without protecting anything the catalogue scope does not already protect.
- **Alternative B: global active-case metadata visibility** (ADR-013 as built). Rejected: it violates least privilege and need-to-know and exposes the existence, classification and state of every ongoing investigation to staff who have no part in it.
- **Alternative C: all archived cases visible to both Records and Legal.** Rejected: it still gives Legal broader visibility than its matter-specific role needs, and wrongly assumes that archiving removes need-to-know, classification and restriction controls.

## Security impact

- \+ Unrelated active, archived and restricted cases are indistinguishable from missing ones for records and legal staff, through rows, UUID probes, search totals, prefix counts, dashboards and error codes.
- \+ Every exceptional path (lookup, break-glass) is purpose-stated, rate limited or approved, time-bound and audited.
- \+ Tasks cannot confer content, evidence download, interview access, identity access or export; the scope check runs in a trigger as well as in the command.
- − The lookup's matched path does more work than the no-match path, so response time could hint at a match. Mitigated by the rate limit and the audit trail; a constant-time response is a production hardening item.
- − `api.request_break_glass` answers `NOT_FOUND` only for cases outside the requester's metadata view; that is by design, since break-glass is never a discovery mechanism.

## Operational impact

- Legal holds on active cases now need a routed task or a request; case managers and GRC route them. Holds on closed non-restricted cases stay immediate for records officers (catalogue scope).
- Expired tasks lose access at once; `api.expire_case_tasks` only makes the state explicit and is run on a schedule in production.
- Break-glass reviews must be worked; the pending queue is visible to approvers.

## Privacy impact

Minimisation improves: records and legal staff no longer see investigation existence by default, the catalogue carries no personal data beyond the owning department, and reporter identity remains reachable only through `api.resolve_reporter_identity` (ADR-004), which neither tasks nor the catalogue can reach.

## Records impact

Retention, archive, disposition and preservation keep working for closed, non-restricted cases through the catalogue scope (Alternative A avoided), and for restricted cases through tasks created by someone who can see them. ADR-013's holds, dual-control release, disposition dual control, certificates and logical disposition are unchanged. Retention periods, delegation of authority and classification tiers remain `SOURCE_REQUIRED`.

## Migration impact

- Two migrations in the 1700 range. They retire the `RECORDS_VIEW` role mappings (reference data only; no case data changes), add four tables, redefine `authz.user_can_view_case`, `authz.can_view_records`, `authz.can_apply_legal_hold`, `authz.can_release_legal_hold`, `authz.can_request_disposition`, `authz.can_approve_disposition` and `api.assign_retention_class`, and add commands. Nothing is dropped; every change is reproducible from Git and tested on a fresh database.
- Callers in other modules (forms CDF-50, interviews CDF-60, portal CDF-63) gate visibility through `authz.can_view_case`, whose only change is the break-glass clause, so they inherit the model without edits.
- Hosted DEV receives the migrations only after merge, through the CI workflow (CDF-32); no manual hosted change.

## Production mapping

| Prototype control                       | Production equivalent                                                       | Status                                           |
| --------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| Role defaults for the new capabilities  | CDF Delegation of Authority mapped in the corporate IdP / entitlement store | `SOURCE_REQUIRED`                                |
| Rolling-hour lookup limit in PostgreSQL | API gateway rate limiting plus SIEM alerting on `CASE_DISCOVERY_REQUESTED`  | `PRODUCTION_SUBSTITUTION_REQUIRED` (CDF-39 SIEM) |
| `api.expire_case_tasks` run by a user   | Scheduled job under a service identity                                      | `PRODUCTION_SUBSTITUTION_REQUIRED`               |
| Break-glass approval in the app         | Privileged-access workflow with SIEM case for every post-event review       | `PRODUCTION_SUBSTITUTION_REQUIRED`               |

## Requirements and tests

Option D §1–§28 are traced in [`compliance/evidence/CDF-73_PURPOSE_BOUND_ACCESS.md`](../../compliance/evidence/CDF-73_PURPOSE_BOUND_ACCESS.md). Tests: `tests/security/authz-purpose-bound.spec.ts` (PBA-T01–T24), `tests/integration/purpose-bound.spec.ts`, `tests/integration/mirrors.spec.ts`, `packages/authorization/src/purpose.test.ts`, and the adapted ADR-013 suites `records-legal-hold.spec.ts` and `records-disposition.spec.ts`.
