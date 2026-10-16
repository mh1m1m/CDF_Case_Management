# ADR-056: The recommendation package builder and the meeting's invite list

- **Status:** Proposed (2026-10-15). Linear CDF-222. Migration `20261007002086_package_builder_and_invite_choices.sql`,
  number and ADR allocated by the project coordinator (2026-10-15, 00:23) with the rulings below. UX redesign Phase 12,
  step P12-2 (slice P12-2c). It merges after 2085 (ADR-055) and before PR-C (2090).
- **Protocol:** §19 (authorization twice), §20 (security tests for an authorization change), §21 (administration
  never implies case content), §40 (authorise before results); ADR-016 D0 and D2; ADR-042; ADR-054; ADR-055 §7;
  DEC-02; DEC-22; DEC-AMB-003; DEC-AMB-013; UX-116.

## Context

P12-2c is the rest of the committee's screens: inviting to a meeting, the recommendation package builder, and the
committee's votes on findings and packages. Migration 2060 (ADR-042) gave the package screens their reads: R1
(`api.committee_scope_choices`) lists the secretary's choices for a package, R2 (`api.committee_items_view`) shows the
proceeding's packages with their active items and the FINDING votes of its meetings, and the label mode keeps subjects
ORDINAL until the owner answers the DEC-02 label card (open since 14 October, 12:08). Before this migration:

1. R2 said what a package holds but not what its commands would accept now. A page offering to create a package, add
   or withdraw an item, put the package to the committee, open its vote, record the adoption, return it to the
   committee or resolve a conflict taint would have had to restate the commands' rules, which UX-116 forbids.
2. `api.meeting_view` (2085) answers whether the caller may invite (`may_invite`, `invitee_roles`) but not whom.
   `api.invite_to_meeting` accepts any account that passes the case gate, so a candidate list had to be narrower than
   the command. ADR-055 §7 deferred the list here on two conditions: only the accounts eligible for that one
   proceeding (never a directory, never searchable across the tenant, never visible outside the secretary's gate),
   and counts only in the audit.

The coordinator's rulings of 2026-10-15 (00:23), all within existing decisions:

1. **The invite list:** the case team's active assignments on the case and the legal reviewers already assigned to
   this proceeding's packages, computed in `api.invite_to_meeting`'s check order (the capability-flag pattern, no
   locks), never a role-wide or directory list. Whoever the meeting's narrowings exclude (an excluded witness, a
   declared conflict) is absent from the list, not shown disabled. The audit records counts only, no names.
2. **A case person with an account:** in ORDINAL mode the invitation is to the person, so no name reaches the roster or
   a My Work row (DEC-22). The DISPLAY_NAME branch may exist but stays unreachable until the owner answers the DEC-02
   card and a migration row citing his message flips the switch; the tests pin ORDINAL as the default.
3. **The package capabilities** ride R2, the already-audited read, and consume no audit sequence of their own; tests
   pin each flag to its command's outcome, false and never null.
4. **The route** is a purpose route, `/committee-proceedings/{id}` (CDF-73 option D), its visibility gated through the
   shared helper.
5. **Numbers:** migration 2086 (both read models), ADR-056, Linear CDF-222; merge after 2085 and before PR-C's 2090.
   The PR opens only after the P12-2b pages PR merges, one UX PR at a time.

## Decision

The database decides and the screen explains (ADR-016 D0). One read model is replaced, one is added, and four internal
helpers are added. No table, policy, table grant or command changes. Both read models are `SECURITY DEFINER` with
`search_path = ''`, volatile because they audit, and granted to `authenticated` only; the helpers are `stable` and no
application role may execute them.

### 1. R2 replaced: the package capabilities

Same signature, grant, owner and audit (`COMMITTEE_ITEMS_VIEWED`, counts only). Every key 2060 returned is returned to
the same callers with the same values; the tests run 2060's definition beside the new one. It gains:

| Where          | Key                                    | Command it answers for                                                                       |
| -------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| The proceeding | `capabilities.may_create_package`      | `api.create_recommendation_package`, up to the granularity chosen                            |
| Each package   | `capabilities.may_add_item`            | `api.add_recommendation_item`, up to the item typed                                          |
| Each package   | `capabilities.may_submit_for_vote`     | `api.submit_package_for_vote`                                                                |
| Each package   | `capabilities.may_record_adoption`     | `api.record_package_adoption`                                                                |
| Each package   | `capabilities.may_return_to_committee` | `api.return_package_to_committee`, up to the reason typed                                    |
| Each package   | `open_vote_in`                         | The meetings where `api.open_package_vote` would accept the package now (ids, meeting order) |
| Each item      | `capabilities.may_withdraw`            | `api.withdraw_recommendation_item`, up to the reason typed                                   |
| Each item      | `taint_resolutions`                    | The resolutions (`RE_VOTE`, `CONFIRM`) `api.resolve_conflict_taint` would accept now         |

Every package command is the secretary's. Only the committee's secretary or alternate secretary, passing the case gate
and with no conflict in the proceeding (`authz.can_manage_recommendation_package`), on an active case, ever gets a true
flag or a non-empty list. The case team, the members, a legal reviewer, an invitee and an administrator read R2 with
every flag false and every list empty.

- **Creating a package:** the proceeding visible, the committee's secretary cleared for the case and not conflicted in
  the proceeding, an Investigation Committee (`NOT_AN_INVESTIGATION_COMMITTEE`), the proceeding OPEN
  (`PROCEEDING_CLOSED`), the case active.
- **Adding, withdrawing and submitting:** `decision.lock_managed_package` without its lock
  (`decision.manages_package`), then a package that is DRAFT, RETURNED_BY_LEGAL or RETURNED_BY_AUTHORITY
  (`PACKAGE_NOT_EDITABLE`); submitting also needs an active item (`PACKAGE_EMPTY`), and withdrawing an active item.
- **Recording the adoption:** a VOTING package whose round's votes were opened and are all closed. The items approved
  are those the command reads as approved (the package vote's result in PACKAGE granularity, each item's own vote in
  ITEM granularity). Approving none returns the package to DRAFT, which nothing refuses. Approving any needs no
  conflict taint (`TAINTED_BY_CONFLICT`), each approved sanction's catalogue version in force
  (`SANCTION_NOT_IN_FORCE`), and the defence notices the rule snapshot asks for (`DEFENCE_NOTICE_REQUIRED`, AMB-026).
- **Returning to the committee:** an ADOPTED package (`PACKAGE_NOT_ADOPTED`).
- **Opening the vote** (`open_vote_in`): a meeting of the package's proceeding that the caller sees and runs on an
  active case (`committee.lock_managed_meeting`), OPEN, with the package VOTING and no vote opened in its round. Then
  the triggers on a new vote item: no open concern about a participant who has not declared a conflict
  (`committee.require_no_open_concern`), and quorum for this package round with the members its re-vote excludes left
  out (`committee.require_quorum_at_opening`). A quorum the rules leave unset still needs a member present.
- **Resolving a taint** (`taint_resolutions`, DEC-AMB-003): an active item whose vote in the package's round has a
  conflicted voter not yet covered by a resolution (`NOT_TAINTED`), the caller neither one of those voters nor whoever
  raised a concern about one of them in the proceeding (FORBIDDEN), and an open meeting of the proceeding that the
  caller runs (`MEETING_NOT_OPEN`). `CONFIRM` only where the recount without the conflicted votes gives the result
  (`RESULT_MAY_CHANGE`). On a DECIDED package (DEC-AMB-013), `RE_VOTE` only where the recount does not give it
  (`RESULT_UNCHANGED`), the caller is not among everyone whose vote taints the decided round (FORBIDDEN), and each of
  them has a recorded conflict (`decision.guard_conflict_remediation`, `NO_VALIDATED_CONFLICT`). Otherwise `RE_VOTE`
  not while the package is with Legal (`LEGAL_REVIEW_OPEN`) or the authority (`PACKAGE_WITH_AUTHORITY`), or a vote of
  its round is open (`VOTE_IN_PROGRESS`).

### 2. `api.meeting_invite_choices(meeting)`

The runner's candidates for one meeting.

- **Checks,** in `api.invite_to_meeting`'s order without its lock: NOT_FOUND unless the caller may see the meeting,
  FORBIDDEN unless they run it, `CONFLICT:CASE_NOT_ACTIVE` unless the case is active, and
  `CONFLICT:MEETING_NOT_ACTIVE` unless the meeting is SCHEDULED or OPEN. A refusal writes nothing.
- **`persons`:** each person of the case not in the meeting, with its `position` among the case's persons (the order
  they joined the case; stable, because a case person is never removed), its `case_roles`, a `label` only in
  DISPLAY_NAME mode (null in ORDINAL), and `invitee_roles`, the roles the rule enables except LEGAL, which needs an
  account. Never a person's department, person type or account link.
- **`accounts`:** only on the two ruled bases, each account listed once with its `bases`:
  - `CASE_TEAM`: an active assignment on the case as case owner, lead investigator or investigator;
  - `LEGAL_REVIEW`: the reviewer assigned to a legal review request, not cancelled, of one of this proceeding's
    packages.

  An account is listed when it passes the case gate and is not in the meeting, with `user_id`, `display_name`,
  `display_name_ar` and `invitee_roles`: the roles the rule enables except SUBJECT, which needs a person, and only
  WITNESS, EXPERT or INFORMATION_PROVIDER for a firewall-restricted member of the proceeding, as the command answers.

- **Absent, not disabled** (ruling 1): a person or account with a conflict that still counts in a meeting of the
  proceeding (`committee.conflict_counts` for a person, `authz.has_meeting_conflict` for an account), or excluded from
  one of its meetings as a witness. A person or account with no role left to take is absent too.
- **Never** a list of the tenant's users, a search, the case id or number, or anything about the reporter.
- **Audit:** `MEETING_INVITE_CHOICES_VIEWED` (BUSINESS, on the case, the meeting as object), with counts only:
  persons, accounts, and accounts per basis. Like 2060's `COMMITTEE_SCOPE_VIEWED` and `COMMITTEE_ITEMS_VIEWED`, a read
  model's event is not shown in the case's history, so it needs no label in `packages/i18n`.

The planning spec (`P12-2C_READ_MODEL_SPEC.md`) proposed an `invitee_types` list and one `basis` per account. Neither
is built: 2085's `invitee_roles` on `api.meeting_view` already carry, per role, whether an acknowledgement is required
and the rule's source, and one account may hold both bases. The spec did not list `CASE_NOT_ACTIVE`; the command
checks it first, so the read does too.

### 3. The label mode

As in 2060: `decision.committee_label_policy`, ORDINAL by default. The tests pin ORDINAL and exercise DISPLAY_NAME only
under a fixture standing for the owner's recorded decision; no migration changes the policy.

### 4. How each answer is computed

As ADR-054 §3 and ADR-055 §5: each capability calls its command's helpers in the command's order, including the
triggers that refuse the command's writes (`decision.block_tainted_progress`, `committee.require_no_open_concern`,
`committee.require_quorum_at_opening`, `decision.guard_conflict_remediation`). It takes no lock, writes nothing and
consumes no audit sequence number; the one event a read writes is R2's own `COMMITTEE_ITEMS_VIEWED`, unchanged, and
M2's `MEETING_INVITE_CHOICES_VIEWED`. Input checks stay the command's to answer: a reason's length, the item type,
sanction, subjects and allegations chosen, the vote granularity, and the invitee and role chosen. Where a command needs
a choice the form makes, the capability answers up to that choice.

### 5. What a capability tells

Nothing its command would not answer, and only to whoever runs the package commands (for AGENT-09 to clear).
`taint_resolutions` says whether a recount without the conflicted votes gives the same result, which is what
`api.resolve_conflict_taint` answers (`RESULT_MAY_CHANGE`, `RESULT_UNCHANGED`); the secretary already reads the
resolution row with the recount. The invite list shows the runner names they could already invite by id: the case
team on the case whose meeting they run (case metadata the secretary did not read before; ruling 1 accepts it, as the
spec's recommended default), and the legal reviewers of the proceeding's own packages.

### 6. Not in this change

- **The pages** come in the next change, with no migration: `/committee-proceedings/{id}` with the packages, the
  builder and the finding votes; on the meeting page, the invite form, the FINDING target, opening a package's vote and
  resolving a taint.
- **Legal review, the authority's decision and the sanction extract** stay in P12-3.
- **The runner's work in My Work** stays a later item.

## Known limitations

- **A proceeding that is no longer open.** R2 is NOT_FOUND to the committee side there (2060), while the package
  commands after creation do not check the proceeding's status, and `api.close_proceeding` leaves its meetings as they
  are. The page offers less than the commands accept there, never more: the tests assert that no command accepts where
  R2 is NOT_FOUND, except on a closed proceeding, where only creating a package is refused. The commands' gap is
  CDF-226 (Security, LOW), fixed in 2120 (ADR-048): `api.close_proceeding` closes the proceeding's meetings and the
  package commands refuse with `PROCEEDING_CLOSED`.
- **Answers are for now.** A flag can turn false between reading and submitting (a vote opened, a concern raised, a
  member leaving); the command checks again and the page shows its refusal.

## Consequences

- The package screens can offer each package action to exactly whoever its command would accept now, and nobody else.
- The invite form can list exactly the candidates the coordinator ruled, each with the roles the command would accept,
  without a directory.
- A capability and its command can drift apart only if one of them changes without the other. The tests run the real
  command for every caller and every state they build, and fail when an answer differs. When 2120 narrows the package
  commands (CDF-226), the closed-proceeding exception in the tests becomes a plain "nothing accepted".

## Where access is enforced, audit and tests

- **Enforced:** in the database. R2 shows its packages to the callers 2060 admits; M2 refuses as the command does; each
  command checks again when it runs.
- **Audit:** R2's `COMMITTEE_ITEMS_VIEWED` as before; M2's `MEETING_INVITE_CHOICES_VIEWED`, one event per call with
  counts only, none on a refusal.
- **Tests:** `tests/security/package-builder-and-invite-choices.spec.ts` (17 tests) runs two sweeps in every state it
  builds:
  - `packages()`, for the secretary, the chair, two members, a legal reviewer without a seat, the case team, the case
    manager, a platform administrator, a committee administrator without a seat and, where the state has one, the
    alternate secretary: each package flag equals what its command answers, run and rolled back; `open_vote_in` is
    exactly the meetings where `api.open_package_vote` accepts, probed in the proceeding's meetings and in another
    proceeding's; `taint_resolutions` is exactly what `api.resolve_conflict_taint` accepts; every package of the
    proceeding is shown with its active items, and no command accepts on a withdrawn item; where R2 is NOT_FOUND no
    package command accepts (on an open proceeding); and R2 without 2086's keys equals 2060's, run side by side.
  - `invites()`, for the runner, the chair, members, a legal reviewer, the case team, the case manager, the
    administrators and a revoked account: a refusal equals the command's for every candidate and writes nothing;
    otherwise the persons and accounts listed are exactly those the command accepts for at least one role and no
    narrowing excludes, each with exactly the roles it accepts; an account outside the bases is never listed, even
    one the command accepts (probed: the case manager, an investigator whose assignment ended, the employee linked
    to a case person and a deputy on no basis; a reviewer of the case is on no basis either); the text carries
    neither the case id nor its number, nor in ORDINAL mode a person's name, department or account; and one ledger
    row with counts only is written.

  The states include PACKAGE and ITEM granularity through every package status, empty and non-empty packages, a
  withdrawn item, a dependency and an exclusivity group, rejected and approved rounds, a second round after a return,
  packages returned by Legal and by the authority, a decided package, a sanction without its defence notice, a
  sanction on a subject with only a rights notice, a catalogue version that ended, taints the recount confirms and
  taints it could change (adopted, with Legal, with the authority, decided), a taint with a vote of the round still
  open, a reversed determination, the raiser of a concern, scheduled, open, closed and cancelled meetings, no quorum
  and a quorum the rules leave unset, an open concern in this meeting and in another, another proceeding before the
  same committee, the alternate secretary (acting or not, on the case team or not, conflicted elsewhere in the
  proceeding), a former voter who becomes the acting alternate secretary (in a package voted as a whole and in a
  decided round voted item by item), a closed proceeding, the case leaving ACTIVE, persons with and without accounts,
  the case team and legal reviewers, assignments ended and reviews cancelled, a suspended account, declared and
  upheld conflicts (one reversed), excluded witnesses, invitee types switched on and off, a firewall-restricted member
  of a grievance proceeding, and both label modes.

  Mutation check: 113 mutants of the new SQL, each with one check removed, widened or narrowed, ran against the spec
  on a copy of the database. 102 fail a test. The other 11 cannot change an answer, and stay as defence in depth:

  - Four checks that another check in the same condition already implies. Managing a package or a meeting implies
    seeing it (`decision.manages_package`, `decision.package_vote_meetings`). Being the committee's secretary on the
    case implies seeing the proceeding, and seeing it implies passing the case gate (`may_create_package`).
  - Seven checks against states no command builds:
    - an active item without a decided vote in a VOTING round whose votes are all closed (the round's votes open
      together, one per active item, and a closed vote always has a result);
    - a rule snapshot without `sanction_requires_defence_notice` (the referral copies the rule set, where the column
      is NOT NULL);
    - a withdrawn allegation, or a withdrawn defence notice (no command withdraws either);
    - the taint of a withdrawn item (R2 lists active items only);
    - a conflicted voter with no conflict on record (each declaration, upheld concern and case conflict writes the
      record the remediation guard reads);
    - an open committee proceeding on a case that has left ACTIVE (every step out of ACTIVE goes to CLOSED, which
      `OPEN_PROCEEDINGS` refuses).

  One survivor of the first run could change an answer: the check that keeps a voter whose vote taints a decided
  round from re-voting another item of that round, where their own vote no longer taints the item. The test "after
  the authority decided, item by item" builds that state, a former voter who has become the acting alternate
  secretary, and now fails that mutant.

  Guards: `api-idor.spec.ts` (M2 is NOT_FOUND to whoever cannot see the meeting, as for a random id),
  `audit-bypass.spec.ts` (M2 writes its event), `committee-scope-read-models.spec.ts` (2060's spec compares its own
  keys only) and the policy snapshot.

## Production mapping

Platform-independent SQL; it moves unchanged to RDS PostgreSQL. The case team and legal reviewers come from the CDF
corporate IdP and the case's assignments in production (PRODUCTION_SUBSTITUTION_REQUIRED, CDF-35).

## Requirements

Phase 12 plan §2 (rules 1, 5 and 6) and §4 (P12-2); DEC-02; DEC-22; ADR-016 D0 and D2; UX-116; DEC-AMB-003;
DEC-AMB-013; AMB-026; AMB-100; AMB-156 and AMB-158 (invitee types); ADR-042; ADR-054; ADR-055 §7; the coordinator's
rulings of 2026-10-15 (00:23).
