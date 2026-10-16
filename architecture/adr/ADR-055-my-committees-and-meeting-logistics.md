# ADR-055: My Committees and the meeting's logistics

- **Status:** Proposed (2026-10-14). Linear CDF-220. Migration `20261007002085_my_committees_and_meeting_logistics.sql`,
  number and ADR allocated by the project coordinator with the conditions below. UX redesign Phase 12, step P12-2
  (slice P12-2b). It merges after 2080 (G7) and before PR-C (2090).
- **Protocol:** §19 (authorization twice), §20 (security tests for an authorization change), §21 (administration
  never implies case content), §40 (authorise before results); ADR-016 D0 and D2; ADR-054; DEC-F19; DEC-22; UX-116.

## Context

P12-2b is the rest of the committee's own screens that do not wait for migration 2060: the Committee area (My
Committees, `/committees` and `/committees/{id}`), scheduling a meeting, adding a member to a proceeding after the
referral, inviting to a meeting and the meeting's logistics. Before this migration:

1. No read model listed a caller's committees or their proceedings. `api.my_areas` (2045) only says that the
   Committee area exists, My Work rows carry no committee id, and DEC-02 bars the BFF from assembling a committee
   screen from tables.
2. RLS on `committee.committee_proceeding` is wider than a My Committees list:
   `authz.can_view_committee_proceeding` also admits the case team through `authz.can_view_case`.
3. `api.meeting_view` (2065) said nothing about inviting, excluding a witness, accommodations or the three
   activations (acting chair, acting secretary, alternate member), nor about the secretary's path for an invitee
   without an account, which ADR-054 §5 deferred here.
4. Nothing answered whether the caller may schedule a meeting or add a member to a proceeding's snapshot.

The coordinator allocated 2085 and this ADR on 2026-10-14 (15:05), with the conditions of 2065: the capability-flag
pattern (each flag reuses its command's helpers in the command's order, takes no lock, consumes no audit sequence
number, is `false` and never null for whoever may not act, and a test pins it to its command's answer); no table,
policy, grant or command change; the seat basis only for My Committees, never the `can_view_case` branch; the
committee's snapshot as DEC-F19 counts; and the case number only with case-metadata visibility. In the same answer:
inviting a case person waits for 2060's label mode, the runner's work in My Work is a later item, and the short
reference for a proceeding is confirmed as display only.

## Decision

The database decides and the screen explains (ADR-016 D0). Two read models and one internal helper are added and
one read model is replaced. Each read model is `SECURITY DEFINER`, `stable`, with `search_path = ''`, and granted to
`authenticated` only.

### 1. The seat basis

`committee.seat_basis_proceeding(proceeding)` is the first branch of `authz.can_view_committee_proceeding`, word for
word: the caller passes the case gate, and either holds their own snapshot row (not `case_gate_excluded`) with a
current seat, or is the committee's secretary or alternate secretary (`authz.is_committee_secretary`). It never takes
the `can_view_case` branch. No application role may execute it.

### 2. `api.my_committees()`

For each committee where the caller holds a current seat (`authz.user_committee_seat`: an active account, effective
now): the committee's id, code, kind and whether it is active; the seat and its dates; and two counts on the seat
basis: open proceedings, and meetings scheduled or open. It lists nothing for an ended seat, a suspended account, a
committee administrator without a seat (Administration is P12-8), a platform administrator (§21) or the case team.

### 3. `api.committee_view(committee)`

NOT_FOUND unless the caller holds a current seat on the committee: the same answer as an id that names no
committee, or none. Otherwise:

- **The committee:** its id, code, kind and state, the caller's seat, the current members by name and seat (what
  `membership_read` already shows a seat holder) and the rule set in force, in the shape a referral copies it.
- **Its proceedings, on the seat basis only.** Each has its status, its referral and closing times, its rule
  snapshot, the case (id and number) only under `authz.can_view_case_metadata` (otherwise both are null), the
  committee as the proceeding holds it, and its meetings. The committee is shown as DEC-F19 counts: holders per seat,
  voting members, members cleared and not cleared for the case, firewall-restricted members and members added after
  the referral (AMB-038). It carries no name, id or per-person flag.
- **What the caller may do on each proceeding:** `may_schedule_meeting` and `may_schedule_emergency_meeting`
  (`api.schedule_meeting` and `api.schedule_emergency_meeting` up to the notice check, which needs the time chosen;
  the form states the minimum notice from the rule snapshot), and `may_amend_snapshot`
  (`api.amend_proceeding_snapshot` up to the member chosen; false on a restricted case, where the command answers
  `AUTHORITY_APPROVAL_REQUIRED` until the authority's approval is built).
- **`amendment_candidates`**, for whoever may amend: the committee's current members not yet in the snapshot, empty
  for anyone else. The list is deliberately not filtered by clearance. The command answers `NOT_CLEARED_FOR_CASE`
  when it runs, and a list of cleared candidates would be a per-person clearance flag (DEC-F19).

**Reference without the case number.** A proceeding has no display number, and a sequential one would reveal how many
proceedings the committee has, restricted ones included. Where the case number is not shown, the page names a
proceeding by the committee code and the first eight characters of its id (`IC-3F9A2C1B`). That reference is
display only. It is never a lookup key and never assumed unique, because eight hex characters can collide, so the
full id stays the key. It only appears on rows the seat basis already shows (coordinator, 15:05; DEC-22). It needs
no column and no sequence.

### 4. `api.meeting_view` is replaced

Same signature, grant and owner. Every key 2065 returned is returned to the same callers with the same values; the
tests run 2065's definition beside the new one. It gains the following keys.

At the meeting level:

| Key                             | Command it answers for                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `may_invite`                    | `api.invite_to_meeting`: the runner, the case and the meeting active, a role the rule enables |
| `invitee_roles`                 | The roles the rule enables, for whoever may invite (empty otherwise)                          |
| `may_activate_acting_chair`     | `api.activate_acting_chair`                                                                   |
| `may_activate_acting_secretary` | `api.activate_acting_secretary`                                                               |
| `may_record_accommodation`      | `api.record_meeting_accommodation` on the caller's own row                                    |

Each role in `invitee_roles` carries whether an acknowledgement is required and the rule's source status. The list is
not narrowed for a firewall-restricted user: the command answers FORBIDDEN for the role they may not take, and a
narrowed list would be a per-person flag. The meeting-level `may_record_accommodation`, with the caller's own
accommodations under `me`, serves an invitee, who sees no roster, as 2065's flags answer the declaration and the
acknowledgement.

On each roster row, for the meeting's runner on any row and for the caller on their own row; on anyone else's row
each is `false`, as in 2065:

| Key                                               | Command it answers for                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `may_exclude_witness`                             | `api.exclude_meeting_witness`                                                                                      |
| `may_record_accommodation`                        | `api.record_meeting_accommodation`, by the participant themself or by the runner                                   |
| `may_declare_conflict`, `may_declare_no_conflict` | `api.declare_meeting_conflict`, by the participant themself, or by the runner for an invitee without an account    |
| `may_acknowledge_confidentiality`                 | `api.acknowledge_meeting_confidentiality`, likewise                                                                |
| `may_activate_alternate`, with `alternate_for`    | `api.activate_alternate_member`: the members this alternate may replace now, for the runner only (empty otherwise) |
| `arrangements`                                    | The acknowledgement and the accommodations recorded, for the runner and the participant themself; null otherwise   |

The last three flags on another participant's row are the secretary's path of ADR-054 §5. `arrangements` is what
`confidentiality_ack_read` and `meeting_accommodation_read` already let those two callers read; accommodation
details may concern health (AMB-157), so nobody else gets them.

### 5. How each answer is computed

As ADR-054 §3: each capability calls its command's helpers in the command's order, including the constraints and
triggers that refuse the command's writes (`committee.refuse_excluded_participant`, 2010 and 2030; the check on
`committee.meeting_acting_role` that nobody activates themself). It takes no lock, writes nothing and consumes no
audit sequence number, so opening a page adds nothing to the ledger. Input checks stay the command's to answer.
Where a command needs a choice the form makes, the capability answers up to that choice: the time chosen against
the minimum notice (scheduling), the member chosen (amending), and the user or person chosen and the role a
firewall-restricted member may take (inviting).

The commands do not all require an active case, and the capabilities follow them. The runner's commands take
`committee.lock_managed_meeting`, which refuses once the case has left ACTIVE. The secretary's path and
accommodations check `authz.can_manage_meeting` alone, as their commands do, so they stay available while the
meeting is.

### 6. What a capability tells

Nothing its command would not answer (for AGENT-09 to clear). Three answers concern another person, and only the
meeting's runner gets them; the runner already sees the roster and the acting roles. `may_activate_acting_chair` and
`alternate_for` follow their commands' basis, which counts a chair or member who no longer passes the case gate as
INELIGIBLE; the activation records that basis, and the deliberation then shows it. `may_activate_acting_secretary`
needs an alternate secretary who passes the gate and has not declared a conflict in the meeting. The amendment's
candidates are not filtered by clearance (§3).

### 7. Not in this change

- **The invite form** (coordinator, 2026-10-14 17:30). Choosing a case person (someone without an account) needs case
  persons' labels, which is the same question as the package screens' subject labels (the owner's DEC-02 card of 14
  October, 12:08), so it uses 2060's label mode, ORDINAL until the owner answers that card. Choosing an account needs
  a list, and no read model lists users. Both come in P12-2c (migration 2086, ADR-056), with one purpose-bound
  candidate list in its migration, on two conditions: the list holds only the accounts eligible for that one
  proceeding (never a directory, never searchable across the tenant, never visible outside the secretary's gate), and
  the audit records counts only. `may_invite` and `invitee_roles` already answer for that form. The secretary's path
  flags already answer for any invitee without an account.
- **The runner's work in My Work** (meetings to open or close, votes to close, minutes to generate or remind). This
  is a separate item once 2085 and 2060 are both on `main` (coordinator, 15:05). The committee page shows that work
  from §3 and the meeting's capabilities.
- **The pages.** They come in the next change, with no migration, as P12-2a did after 2065 (the P12-2b amendment
  below).

## P12-2b amendment: the committee pages and the meeting's logistics (2026-10-14)

The Committee area gains its pages on these read models, with no migration, and the meeting page gains its logistics.
They are purpose routes (ADR-016 D2): `/committees` reads `api.my_committees`, `/committees/{id}` reads
`api.committee_view`, and `/meetings/{id}` reads `api.meeting_view` as before. None reads a case table. Each action
is a server action that runs the `api.*` command in the caller's security context, so the database checks again on
submit.

- **The area follows the seat.** The sidebar shows My Committees «لجاني» wherever `api.my_areas` lists the Committee
  area, which it does for a current seat (2045). The application's floor for the area is lifted, because a seat alone
  opens it and no role does (AMB-047); the database still decides. Without a current seat, `/committees` is the same
  404 as a page that does not exist, and so is `/committees/{id}` for a committee where the caller holds none or an id
  that names none; that refusal is recorded as `ACCESS_DENIED` with the read's name only. A platform administrator,
  the case team and a holder of a committee role without a seat get the same 404 (§21).
- **My Committees.** One row per committee: the seat and its dates, whether the committee is active, and the two
  counts on the seat basis (open proceedings, and meetings scheduled or open). Never a case count.
- **The committee page.** The caller's seat, the members by name and seat, the rules in force with their source
  shown as a configured value (owner default, source required or approved; never presented as CDF policy), and the
  proceedings on the seat basis, open ones first and closed ones folded away. Each proceeding shows its status and
  dates, its meetings (each opens the meeting's page), the committee as counts (DEC-F19) and its rule snapshot. It is
  named by its case number only where the view carries one; otherwise by the display-only reference of §3, with a
  line saying that the case is not named to the viewer and that the reference is for that page only.
- **Forms only where the command would accept them.** Scheduling shows where `may_schedule_meeting` or
  `may_schedule_emergency_meeting` is true. The form states the proceeding's minimum notice and takes times in Riyadh
  time; the emergency box sends `api.schedule_emergency_meeting` with its reason instead. The schema checks the
  command's own pairings first (a place for a meeting in a room, an https link for one online, both when hybrid,
  never the other, and the end after the start), so a mistake shows field by field before the database is asked;
  the command still answers `NOTICE_TOO_SHORT` for a time too soon, and the form then points to the emergency path.
  Adding a member shows where `may_amend_snapshot` is true and the view lists candidates, unfiltered by clearance;
  the command answers `NOT_CLEARED_FOR_CASE`.
- **The meeting's logistics.** The acting chair and the acting secretary activate from the meeting-level flags. On a
  roster row, for the meeting's runner: excluding a witness, recording an accommodation, an alternate sitting for
  one of the members its row lists (`alternate_for`), and, on a row without an account, the declaration and the
  undertaking the secretary records for that person (ADR-054 §5) through the same commands. A participant records
  their own accommodation in their part of the meeting. A row's acknowledgement and accommodations show only where
  the view carries them: to the runner, never on another participant's page. An accommodation may concern health:
  its text is never logged and never put in an event.
- **Where a meeting leads back to.** A caller with a current seat on the meeting's committee goes back from the
  meeting to the committee; anyone else to My Work. The seat comes from `api.my_committees`, never from a role.
  Notices that link to `/committees/{id}` now open it (`LIVE_PURPOSE_ROOTS`).
- **Confirmation and refusals.** Seven new server actions run eight commands; the secretary's path reuses the
  declaration and acknowledgement actions. Nine acts ask for confirmation first; recording that a person without an
  account declared no conflict does not, as for a member's own declaration. One act tells someone: scheduling tells
  each member added that they are invited, with no reason and no case content. A refused command is recorded as
  `COMMAND_DENIED` with the command and the outcome only, never the reason, details or emergency reason typed.
- **Not in this change.** The invite form, its candidate list and the invitation of case persons (§7, P12-2c); the
  runner's work in My Work (a later item).
- **Tests.** Unit: 24 new (schemas, services, gateways, confirmations, routes and the area's floor).
  `tests/integration/committees.spec.ts` (3): scheduling within the notice the proceeding copied and on the emergency
  path, refused to a member; adding a member appointed after the referral from the candidates listed; and, without a
  seat, the uniform not-found with its `ACCESS_DENIED` event. `tests/integration/meetings.spec.ts` gains one: the
  secretary's path for a witness without an account, an accommodation a member may not record or read (its refusal
  carries no details), an exclusion and a handover to the alternate secretary. `tests/e2e/committees.spec.ts` (6,
  Arabic and English, a member on a 390 px phone): scheduling from My Committees, a field refused before the database
  is asked, the emergency path and the way back to the committee; a member's own accommodation, the acting chair,
  and the secretary's path, an accommodation and the exclusion for a witness, which a member never reads; adding a
  member; and the 404s for a platform administrator, the case team and a committee role without a seat.
  `tests/e2e/shell.spec.ts` adds `/committees` to the investigator's and the administrator's 404s, and
  `tests/e2e/notifications.spec.ts` now expects a seat's notice to lead to the committee's page.
  `tests/accessibility/committees.spec.ts` (4): axe at 1280 and 390 px and no sideways scroll at 1280, 390 and
  320 px, with every disclosure open and the exclusion's confirmation, in both languages.

## Consequences

- The Committee area can list exactly the caller's committees and, on each, exactly the proceedings their seat gives
  them. The case team, who see a proceeding through the case, get no committee page for it.
- The committee page can offer scheduling and adding a member, and the meeting page can offer excluding a witness,
  accommodations, the secretary's path and the three activations, each to exactly whoever its command would accept
  now. Inviting is answered the same way, for the form P12-2c adds (§7).
- A capability and its command can drift apart only if one of them changes without the other. The tests run the
  real command for every caller and every state they build, and fail when an answer differs.
- 2085 merges after 2060, 2070 and 2080. If one of them replaces `api.meeting_view`, 2085 is rebased onto it and
  carries its change, and the side-by-side test compares with that migration's definition instead of 2065's.

## Where access is enforced, audit and tests

- **Enforced:** in the database. `api.my_committees` and `api.committee_view` show the seat basis only, and each
  command checks again when it runs.
- **Audit:** none. The read models write nothing; a test counts the ledger rows written while every caller views.
- **Tests:** `tests/security/my-committees-and-meeting-logistics.spec.ts` (11 tests) runs two sweeps in every state it
  builds, for each caller:
  - `committees()`: the seat basis or the case equals `authz.can_view_committee_proceeding`; My Committees lists
    exactly the caller's current seats, and the committee page is NOT_FOUND without one; the proceedings are exactly
    those on the seat basis; the counts equal what the page shows; the case is named only under case-metadata
    visibility; the snapshot equals the counts of the proceeding's members; no proceeding carries a person; each
    scheduling and amendment flag, and the candidates, equal what the commands answer, run and rolled back; and no
    command accepts on a proceeding the page does not show.
  - `logistics()`: each new flag equals its command's answer for the runner on any row and for the caller on their
    own row, and is false elsewhere, where the command refuses too; `alternate_for` and `invitee_roles` list exactly
    what the commands accept; `arrangements` and `me.accommodations` are what RLS lets the caller read; and the view
    without 2085's keys equals 2065's `api.meeting_view`, run side by side.

  The states include a referral, members added after it (cleared and not), a member excluded at referral and cleared
  later, the case manager and an alternate secretary seated after the referral, a member's clearance falling below the
  case's, suspended accounts, ended seats, a restricted case, a cancelled proceeding and a cancelled meeting, the case
  leaving ACTIVE, a grievance with a firewall-restricted member, witnesses with and without an account, an open
  concern, excluded witnesses (one who still sees the meeting through the case), accommodations, invitee rules
  switched on and off, a closed meeting, an absent, excused, uncleared and unseated chair, a deputy absent or
  unseated, a runner who sits in the meeting as deputy or alternate, an alternate secretary's seat ended and given
  again, conflicted secretaries and alternates, a conflict declared at an earlier meeting of the proceeding, a vote in
  progress, and alternates activated or ineligible.

  Mutation check: 87 mutants of the new SQL, each with one check removed, widened or narrowed, ran against this spec
  on a copy of the database, and each of the 83 that change an answer fails a test. The other 4 cannot change one, and
  stay as defence in depth: the ACTIVE join in `my_committees` (`authz.current_user_id()` is already null for an
  inactive account), the `can_view_meeting` filter on a proceeding's meetings (the seat basis implies it), the case
  gate on the registry secretary for the acting secretary (whoever sees the meeting passes it, on either branch of
  `authz.can_view_meeting`), and `is_voting` on the member an alternate replaces (a meeting member with a MEMBER seat
  always votes: firewall-restricted and gate-excluded members are not in the meeting).

  Guards: `api-idor.spec.ts` (the committee page is NOT_FOUND for another committee and for a random id;
  `my_committees` is a global read), `audit-bypass.spec.ts` (both reads write nothing), and the policy snapshot.
  `meeting-screen-capabilities.spec.ts` (2065) and `purpose-read-models.spec.ts` (2030) compare their own keys only
  (`tests/support/capabilities.ts`).

## Production mapping

Platform-independent SQL; it moves unchanged to RDS PostgreSQL. The committee's people come from the CDF corporate
IdP and the committee registry in production (PRODUCTION_SUBSTITUTION_REQUIRED, CDF-35).

## Requirements

Phase 12 plan §2 (rules 1, 5 and 6) and §4 (P12-2); DEC-02; DEC-F19; DEC-22; ADR-016 D0 and D2; UX-116; AMB-038;
DEC-F03, AMB-041, AMB-042, AMB-050, AMB-066 and AMB-088 (acting roles and alternates); AMB-156, AMB-157 and AMB-158
(invitees, accommodations, confidentiality); ADR-054 §5; the coordinator's conditions of 2026-10-14 (15:05).
