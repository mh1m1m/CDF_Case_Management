# ADR-054: The meeting screen's capabilities

- **Status:** Proposed (2026-10-14). Linear CDF-158. Migration `20261007002065_meeting_screen_capabilities.sql`,
  number allocated by the project coordinator with the conditions below. UX redesign Phase 12, step P12-2 (slice
  P12-2a).
- **Protocol:** §19 (authorization twice), §20 (security tests for an authorization change), §40 (authorise before
  results); ADR-016 D0 and D2; ADR-020; ADR-038; ADR-041; UX-116.

## Context

P12-2 builds the committee's meeting and minutes screens on the 2030 domain. A screen offers an action only when the
database says the caller may take it now (UX-116, ADR-016 D0); it never mirrors a command's rules in the page.
`api.meeting_view` (2030 section 4) answered for opening, closing and cancelling the meeting, opening and closing a
vote, casting a vote or the deciding vote, raising and deciding a concern, declaring a conflict, acknowledging
confidentiality and generating the minutes. It did not answer for:

- recording attendance, so the screen could never bring a member to PRESENT, and with nobody present no vote opens;
- excusing a participant, or raising a concern about one particular participant;
- recording a vote for a member who is not present (ABSENT, UNABLE_TO_VOTE or RECUSED);
- revising one's vote (AMB-081), recusing for a conflict (AMB-077) or noting one's vote (AMB-082).

The coordinator allocated a migration for these answers on 2026-10-14 (11:50): `api.meeting_view` is replaced with
the same signature and grant; no table, policy, grant or command changes; tests prove that each capability equals its
command's answer, and T-AMB-037. The coordinator set how each is computed (11:53) and who sees the roster-row answers
(11:55). The security reviewer (AGENT-09) added two clearance checks: every flag for a caller who may not use the
command is false, never null or absent; and the view's existing rows and columns are unchanged apart from the new
keys.

The number was 2047 at first. When migration 2050 (ADR-041) merged ahead of it, the coordinator renumbered it 2055
(12:44), and 2065 when migration 2060 (ADR-042) merged ahead of it (23:27). Migration 2050 also narrows
`api.declare_meeting_conflict`: a member whose seat has ended declares nothing (`CONFLICT:SEAT_ENDED`, CDF-212). The
coordinator asked that the view's declaration flag reuse that check, with a test that the flag equals the command's
answer. Migration 2060 does not change `api.meeting_view`.

## Decision

The database decides and the screen explains (ADR-016 D0). One function is replaced; it stays `SECURITY DEFINER`,
`stable`, with `search_path = ''`, granted to `authenticated` only. Every key it returned before is returned to the
same callers, with the same values apart from three flags that only narrow (§4).

### 1. On each roster row: what the caller may record about that participant

| Capability                    | Command it answers for                                     |
| ----------------------------- | ---------------------------------------------------------- |
| `may_record_present`          | `api.record_attendance` with PRESENT                       |
| `may_record_absent`           | `api.record_attendance` with ABSENT                        |
| `may_record_excused_conflict` | `api.record_attendance` with EXCUSED_CONFLICT              |
| `may_record_excused_absence`  | `api.record_excused_absence` (ADR-038)                     |
| `may_raise_concern`           | `api.raise_meeting_conflict` about that participant (2010) |

They are computed for the meeting's runner (`authz.can_manage_meeting`) on any row, and on the caller's own row,
where they answer for the commands a participant runs on themself. Today that is none of these: attendance and
excuses are the runner's to record, and nobody raises a concern about themself. On anyone else's row a caller who
does not run the meeting gets `false` for each, so no flag tells one participant about another's conflict, clearance,
exclusion or excusal (coordinator, 11:55). A member still raises a concern from the meeting-level
`may_raise_concern`, as before, and the command answers for the participant they name.

### 2. On each vote item

- `i_have_noted`: whether the caller's own note on the item exists, never its text.
- `record_vote_for`: the participants for whom `api.record_vote_for_member` would record ABSENT, UNABLE_TO_VOTE or
  RECUSED now. It lists members on a counting seat who are not replaced, not the runner, not present and have no
  vote on the item, and never a member a re-vote excludes (DEC-AMB-013). It is a list of participant ids, empty for
  anyone but the runner, and outside `capabilities`. It tells the runner nothing the command would not.
- In `capabilities`: `may_revise` (`api.revise_vote`, where the rule snapshot allows a revision),
  `may_recuse_for_conflict` (`api.recuse_for_conflict`) and `may_record_note` (`api.record_vote_note`, where the
  rule snapshot allows a note).

### 3. How each answer is computed

Each capability calls the authz and committee helpers its command calls, in the command's order, and includes the
triggers that refuse the command's writes (`committee.refuse_excluded_participant`, 2010;
`decision.refuse_excluded_vote`, DEC-AMB-013). It takes no lock, writes nothing and consumes no audit sequence
number, so opening the screen adds nothing to the ledger. Input checks, such as a reason's length or a choice's
value, stay the command's to answer. The checks are not extracted into shared functions now (coordinator, 11:53).

Every `capabilities` object holds booleans only, never null. A capability never widens a command: the command checks
again on submit.

### 4. Three meeting-level flags follow their commands more closely

`may_declare_conflict`, `may_declare_no_conflict` and `may_acknowledge_confidentiality` answer for the caller's own
row. They gain the checks of their commands that 2030's flags left out:

- a member whose seat has ended declares nothing (`CONFLICT:SEAT_ENDED`, which 2050 added to
  `api.declare_meeting_conflict` for CDF-212; coordinator, 12:44);
- an excluded witness who still sees the meeting through the case neither declares nor acknowledges
  (`committee.refuse_excluded_participant` on the participant's update, 2010, and on the acknowledgement, 2030).

They only ever turn `true` into `false`, and now equal their commands' answers.

### 5. The screens follow in their own change

The meeting and minutes pages, their actions and their Arabic and English text come in the next change, with no
migration, once this one has merged. Recording a declaration, an acknowledgement or an accommodation for an invitee
without an account (the secretary's path in those commands) comes with the invitations of P12-2b.

## Consequences

- The meeting screen can offer attendance, excuses, a concern about a participant, recording a vote for an absent
  member, revision, recusal and a note to exactly whoever the command would accept now, and to nobody else.
- A member whose seat has ended, or an excluded witness, is no longer offered a declaration or an acknowledgement
  that the command would refuse.
- A capability and its command can drift apart only if one of them changes without the other. The tests run the real
  command for every caller and every state they build, and fail when an answer differs.
- `api.minutes_view` (2030) already answers for its four minutes actions, so it is not changed.

## Where access is enforced, audit and tests

- **Enforced:** in the database, by `api.meeting_view` for what it shows and by each command when it runs.
- **Audit:** none. The view is a read and writes no audit event; a test counts the ledger rows written during views.
- **Tests:** `tests/security/meeting-screen-capabilities.spec.ts` has seven tests. They build these states:
  scheduled; open with declarations; attendance recorded; a vote in progress; a closed item and a closed meeting; a
  case that has left the active state; a replaced member and an ended seat; a witness before and after the
  acknowledgement; an excluded witness, also one who still sees the meeting through the case; open and declared
  concerns; a vote, a revision, a note and a recusal; and a rule set with revision and notes switched off. In each
  state and for eight callers or more, the tests run each real command in a rolled-back subtransaction and assert:
  - each flag the runner sees, and each flag on the caller's own row, equals the command's answer;
  - the three meeting-level flags of §4 equal their commands' answers on the caller's own row;
  - every other flag is `false`, and the runner-only commands refuse that caller;
  - every flag is a boolean and every list a list, never null or absent;
  - `record_vote_for` equals the set the command accepts;
  - the view equals migration 2030's `api.meeting_view`, run side by side, apart from the keys 2065 adds and the
    three flags of §4, which may only turn from `true` to `false`.

  Mutants that drop the ended-seat check or the excluded-witness check from a flag fail these tests.
  `committee-meetings.spec.ts` covers T-AMB-037 (a participant of one case's meeting gets NOT_FOUND on another
  case's meeting, as for an id that names none). `recommendations-authority.spec.ts` shows the secretary is offered
  no vote to record for a conflicted member on a re-vote (DEC-AMB-013). `purpose-read-models.spec.ts` now expects the
  new keys.

## Production mapping

Platform-independent SQL; it moves unchanged to RDS PostgreSQL. The committee's people come from the CDF corporate
IdP and the committee registry in production (PRODUCTION_SUBSTITUTION_REQUIRED, CDF-35).

## Requirements

Phase 12 plan §2 (rules 1, 5 and 6) and §4 (P12-2); DEC-02; ADR-016 D0 and D2; UX-116; AMB-077, AMB-081, AMB-082;
DEC-AMB-013; T-AMB-037; CDF-212; the coordinator's conditions of 2026-10-14 (11:50, 11:53, 11:55 and 12:44).
