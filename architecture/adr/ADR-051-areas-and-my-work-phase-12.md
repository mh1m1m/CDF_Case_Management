# ADR-051: Areas and My Work for Phase 12

- **Status:** Proposed (2026-10-14). Linear CDF-211. Migration `20261007002045_phase12_areas_and_my_work.sql`, number
  allocated by the project coordinator. UX redesign Phase 12, step P12-0b.
- **Protocol:** §19 (authorization twice), §21 (administration never implies content), §39, §40 (authorise before
  results and counts), §42 (Arabic and English); ADR-016 D0; ADR-030.

## Context

The rebase migrations 1870 to 2040 added the commands of the committee and decision process: referrals, the
preliminary review, meetings, conflict declarations, votes, minutes, legal review, employee notices, grievances,
exports, corrective actions and continuity imports. The work they create reached people only as notifications. The
shell had no Committee area, Administration showed only to user and role administrators, the case team could not see
what a committee referral would copy before making it, and the case history did not list the 1870 events.

What My Work may show was decided by the owner on 2026-10-13 (DEC-22, as proposed in the Phase 12 plan §5). The
kinds and areas come from the plan (§2, §5), with AMB-047 (work follows the current effective seat), AMB-250
(returned work carries its structured reasons) and AMB-010 and AMB-246 (a due date only where one is configured). The
coordinator placed the case history's 1870 events and a seat-count read for the referral here (notes of 13:24 and
13:25 on 2026-10-13), and ruled on the read's shape on 2026-10-14: per-seat holder counts plus totals (voting,
cleared, not cleared, firewall restricted), never a cleared or voting flag per seat type, because a flag on a seat
one person holds would disclose that person's clearance or conflict.

## Decision

The database decides and the screen explains (ADR-016 D0). All four changes are read models: `SECURITY DEFINER`
functions with `search_path = ''`, granted to `authenticated` only, that evaluate the predicates the commands and
policies use. No table, policy, table grant or command changes, and none of them writes.

### 1. My Work: the Phase 12 kinds

`api.my_work_items()` lists each kind below only where the command it leads to would accept the caller now, in the
caller's own context.

| Kind                                                                     | For whom, and the guard it repeats                                                                                                                                                                                                              | Code, reasons, due                                       |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| REFERRAL_TO_APPROVE, REFERRAL_TO_ACCEPT, REFERRAL_ESCALATION_TO_DECIDE   | Whoever `api.referral_queue()` names (2040: the sector head or active delegate; the committee secretary; the escalation decider)                                                                                                                | The referral's status for the secretary                  |
| REFERRAL_RETURNED                                                        | The preparer, while `api.submit_referral` would accept them again                                                                                                                                                                               | The sector's return reasons                              |
| PRELIMINARY_TO_REVIEW, PRELIMINARY_TO_APPROVE                            | `PRELIMINARY_REVIEW` or `PRELIMINARY_APPROVE` holders who may read it, on an active case; never its preparer, nor its reviewer for the approval                                                                                                 | None                                                     |
| PRELIMINARY_RETURNED                                                     | Its preparer only, until a later version exists                                                                                                                                                                                                 | The return reasons                                       |
| RESTRICTED_APPROVAL                                                      | The restricted case's owner as its Restricted Case Authority: export consent (never on their own request, CDF-208), a legal review where the package's rules require one and someone else could give it (DEC-F20), and grievance handling (G2b) | Which approval: EXPORT, LEGAL_REVIEW, GRIEVANCE_HANDLING |
| MEETING_TO_ATTEND                                                        | A participant of a meeting in the next seven days who still takes part: not excluded as a witness, no declared conflict, not replaced or excused, and a member only while seated                                                                | Due: the meeting's start (SCHEDULE)                      |
| COI_TO_DECLARE                                                           | A participant who still owes a declaration on an active meeting, with the same seat rule                                                                                                                                                        | None                                                     |
| CONFLICT_CONCERN_TO_DECIDE                                               | The DEC-F04 decider of a raised concern, never the raiser or its subject, while no vote item of the meeting is undecided                                                                                                                        | The seat they decide as                                  |
| VOTE_OPEN                                                                | A present, seated voting member (or activated alternate) with no conflict who has not voted, never on a re-vote that excludes them (DEC-AMB-013)                                                                                                | None                                                     |
| MINUTES_TO_REVIEW                                                        | A minutes reviewer who has not reviewed                                                                                                                                                                                                         | Due: the configured review period (MINUTES_REVIEW)       |
| LEGAL_REVIEW_ASSIGNED                                                    | The named reviewer with `LEGAL_OPINION_GIVE`, while the package is not tainted (DEC-AMB-003)                                                                                                                                                    | None                                                     |
| NOTICE_TO_ACKNOWLEDGE, DEFENCE_DUE                                       | The linked employee (`authz.is_portal_subject`): rights and decision notices to acknowledge; a defence notice open for a response                                                                                                               | The notice's kind; SUSPENDED with no due date            |
| GRIEVANCE_RECEIVED, ADMISSIBILITY_TO_DECIDE, GRIEVANCE_OUTCOME_TO_RECORD | Whoever `api.grievance_queue()` names (2040)                                                                                                                                                                                                    | The grievance's kind                                     |
| EXPORT_TO_APPROVE                                                        | A stage's eligible approver (`exchange.eligible_approvers`): never the requester, an earlier approver or a rule author (DEC-F24)                                                                                                                | None                                                     |
| ACTION_ASSIGNED, ACTION_RETURNED                                         | Whoever acts for the action (owner, unit or pool) with `CORRECTIVE_ACTION_OWN`, while it may move; never a frozen action                                                                                                                        | The action's type; due: its due date (ACTION)            |
| ACTION_TO_VERIFY                                                         | A `CORRECTIVE_ACTION_MANAGE` holder who can open the case, never the owner or whoever submitted the completion; never a frozen action                                                                                                           | The action's type                                        |
| ACTION_TO_DISPOSE                                                        | A `CORRECTIVE_ACTION_MANAGE` holder who can open the active case, for an action frozen by a superseded decision (DEC-AMB-014): exactly whoever `api.dispose_superseded_corrective_action` accepts                                               | The action's type                                        |
| IMPORT_TO_APPROVE                                                        | A continuity approver, never the importer, the workbook's preparer or an offline recorder, on the batch as submitted                                                                                                                            | None                                                     |

Row fields stay DEC-22's. Two columns are added at the end: `code`, a non-sensitive code or type (also a form row's
form code, which S3 left out while DEC-22 was open), and `reason_codes`, the structured reasons of returned work. A
comment written with a return never shows. The case number shows only with case-metadata visibility, so an approver
who may not see the case, such as the GRC Sector Head on a preliminary recommendation, gets the work without the case.
A row's area is where its work lives: a committee the caller sits on now, a case they can open, otherwise My Work.

Not listed, by decision: the Restricted Case Authority's approval of a committee referral and of a grievance's
recording, which have no request to answer (the owner gives them on the case when that step is reached), and
the grievant's completion of a grievance returned for completion, which waits for the employee's own pages (P12-5).
The plan's later kinds (withdrawals, grant and clearance approvals, reopening) come with 2060, 2150 and 2160.

### 2. Areas

- **My Committees «لجاني» (`COMMITTEE`)** shows for a current seat on any committee (`authz.user_committee_seat`, an
  active user, effective now; AMB-047). The plan's second basis, a place in a proceeding's snapshot, opens nothing on
  its own since migration 2030 (a snapshotted member reads a proceeding only while still seated, AMB-039), so it would
  show an empty area. This narrows ADR-030's implementation note. The area counts its own work like any other.
- **Administration** shows for the business administration permissions whose commands would accept the caller (plan
  §2): user, role, committee, sector and notification-rule administration, export policy through
  `authz.is_export_policy_admin` (never whoever holds an export approval permission, 2040), corrective-action policy
  and the business-day calendar. Its default view is the first page the caller may use, in that order. It still never
  counts. `CLEARANCE_ADMIN` and the finding-vocabulary administrator come with their own migrations (2160, 2150).
- Neither area opens a case or any case content. Every seed account still sees at most five areas.
- The application floor (`shellAreas`, ADR-016 D0) can only remove an area, and it keeps both new areas hidden until
  their pages ship: My Committees with P12-2, the widened Administration with P12-8. A purpose row whose page has not
  shipped shows without a link, and the page says so; the inbox and My Work share one list of live purpose roots
  (`LIVE_PURPOSE_ROOTS`), empty today.

### 3. What a committee referral would copy now

`api.committee_referral_preview(case, committee)` runs the referral command's own checks first, in its order:
`NOT_FOUND` without case visibility, `FORBIDDEN` without `authz.can_edit_case`, `CONFLICT:CASE_NOT_ACTIVE`, and
`INVALID:committee_id` for an unknown or inactive committee. It then returns the members in office now, active
users only, as holders per seat and four totals: voting (chair, deputy chair and members who are cleared and not
firewall restricted), cleared, not cleared (clearance below the case or a declared conflict, `authz.user_case_gate`)
and firewall restricted (on a Grievance Committee, cleared voting seats held by someone who was a voting member of
the case's Investigation Committee proceeding, Q45 and Q46). No id, no name and no flag per seat. It is read-only and audits nothing, as other read
models; a refusal is the same error the command gives.

The totals are what `COMMITTEE_PROCEEDING_OPENED` records at referral, and what the committee snapshot shows the case
team afterwards (DEC-F19). The residual inference is the same as that snapshot's: on a seat one person holds, a
not-cleared total above zero may narrow down who. The coordinator accepted this shape on 2026-10-14.

The Proceedings tab shows it beside the restricted referral approval and the referral form, only to whoever can act
on that step, and repeats the totals in the confirmation. A refusal shows nothing.

### 4. The 1870 events in the case history

`api.case_history()` (1850) lists the 1870 events as codes and times only, with no actor, reason, person or detail,
each to whoever may read what it is about, as its table's policy reads it: proceedings by `authz.can_view_proceeding`;
the committee proceeding by `authz.can_view_committee_proceeding`; people, allegations and links by the case's
readers; findings with a case-file basis (2020's `finding_read`); an evidence link by whoever may see the linked item;
and the restricted committee referral approval only to the case owner as Restricted Case Authority and to whoever
recorded it. The rest of the team learns of the referral from the proceeding events. Events added after 1870 (2030
and 2040) are not listed yet.

## Consequences

- People see the Phase 12 work they owe in one place, before its pages exist, with the reasons for returned work.
  Nothing new is revealed: each row's guard is its command's.
- A row is only as current as the command's predicate. A command that accepts a caller whom My Work leaves out is
  still governed by the command; the reverse never happens. Observed while testing: `api.declare_meeting_conflict`
  (2030) still accepts a declaration from a participant whose seat has ended, while My Work no longer offers it
  (AMB-047). Reported to the security reviewer; not changed here.
- The application's area floors stay as they are, so these areas appear in the app only with their pages.

## Where access is enforced, audit and tests

- **Enforced:** in the database, by the four functions above; the pages re-check on every load and every command
  checks again.
- **Audit:** none of the four writes or audits; they are reads, listed in the audit walk's non-state-changing list.
- **Tests:** `tests/security/my-work-phase12.spec.ts` (each kind's positive and negative cases, separation of duties,
  the seat rule, the five-area limit, the preview's gate and its counts-only shape, the history audiences);
  `my-work-read-models.spec.ts`, `recommendations-authority.spec.ts` (My Work offers a frozen action's disposition to
  exactly whoever the command accepts), `case-history-roster.spec.ts`, `api-idor.spec.ts` and `audit-bypass.spec.ts`;
  unit tests for the routes and the service; `tests/e2e/my-work-purpose.spec.ts`, `tests/e2e/case-structure.spec.ts`
  and their accessibility specs, in Arabic and English, at desktop and phone widths.

## Production mapping

Platform-independent SQL; it moves unchanged to RDS PostgreSQL. Seat holders and role holders come from the CDF
corporate IdP and the committee registry in production (PRODUCTION_SUBSTITUTION_REQUIRED, CDF-35).

## Requirements

Phase 12 plan §2 and §5; DEC-22; AMB-010, AMB-039, AMB-047, AMB-246, AMB-250; DEC-F04, DEC-F19, DEC-F20, DEC-F24;
DEC-AMB-003, DEC-AMB-013, DEC-AMB-014; CDF-208; the coordinator's notes of 2026-10-13 (13:24, 13:25) and ruling of
2026-10-14.
