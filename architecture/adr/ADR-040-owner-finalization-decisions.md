# ADR-040: Applying the owner's Finalization Set and the ambiguity decisions (migrations 2030 and 2040)

- **Status:** Proposed (2026-10-13). Linear CDF-196 (rebase decision application; stays In Progress until hosted validation). Implemented in migrations 2030 and 2040 (local, pending security review). Amends ADR-019, ADR-020, ADR-024, ADR-038 and ADR-039.
- **Owner decisions:**
  - the Finalization Set DEC-F01 to DEC-F41 (2026-10-13 02:54 UTC), recorded in `docs/business-architecture/OWNER_DECISIONS_FINALIZATION.md`;
  - the ambiguity decisions DEC-AMB-001 to DEC-AMB-012 (2026-10-13 10:01 UTC), recorded in the same file, section 16.
- **Protocol:** §12–§14, §18–§22, §29, §65, §68, §87, §88.

## Context

The rebase final report (section 4) listed the decisions only the owner could make. The owner answered all of them in the Finalization Set, then answered the twelve R5 rows of the ambiguity register (PR #60, `OWNER_PACK.md`). Every answer takes the recommended option. Where an answer leaves a value to an authoritative CDF source, the value stays configurable and marked `SOURCE_REQUIRED`.

This record says how each decision reaches the code. The rule throughout is "additive and fail closed":

- columns, tables and commands are added;
- replaced functions keep their signature, `SECURITY DEFINER` and `search_path`;
- an access predicate is only narrowed, except where a decision itself grants access (named below for review);
- a fail-safe stays until its replacement rule and that rule's negative tests are in the same migration.

The work is split by number. ADR-040 covers 2030 and 2040 (PR-A). The other numbers have their own ADRs:

| Migration | Scope                                                  | ADR     |
| --------- | ------------------------------------------------------ | ------- |
| 2050      | P11-G4 evidence half, with DEC-AMB-005 and DEC-AMB-006 | ADR-041 |
| 2060      | P11-G2 closure, with DEC-AMB-002                       | ADR-042 |
| 2070      | P11-G3                                                 | ADR-043 |
| 2080      | P11-G7, with DEC-F38                                   | ADR-044 |
| 2120      | DEC-AMB-008 paper ballots                              | ADR-048 |
| 2130      | DEC-AMB-012 two-person restricted-status lift          | ADR-049 |

## Decision

### 1. Committee rule-set options (2030, section 1)

`committee.rule_set` gains the options the decisions name:

| Option                                                  | Source                                 | Default                                       |
| ------------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| `decision_rule`                                         | DEC-F01                                | `SIMPLE_MAJORITY_SUBSTANTIVE`, the only value |
| `acting_chair_casting_vote`                             | DEC-F03                                | false, SOURCE_REQUIRED                        |
| `vote_revision_allowed`                                 | AMB-081                                | —                                             |
| `dissent_note_allowed`                                  | AMB-082                                | —                                             |
| `ballot_secrecy`                                        | AMB-083                                | `COMMITTEE_AFTER_CLOSE`                       |
| `minimum_notice_days`                                   | AMB-061                                | null, SOURCE_REQUIRED                         |
| `minutes_objection_blocks_deemed`                       | AMB-092                                | true                                          |
| `sanction_requires_defence_notice`                      | AMB-026                                | —                                             |
| `grievance_window_start_basis`, `non_admission_decider` | DEC-F15, DEC-F17 (Grievance Committee) | —                                             |
| `grievance_completion_days`                             | AMB-141                                | SOURCE_REQUIRED                               |

- `api.revise_committee_rule_set` starts a new effective-dated version from the one in force, changing only the named options.
- A referral snapshots the version in force. Readers coalesce a pre-2030 snapshot to the as-built behaviour.
- A new Grievance Committee version carries DEC-F14, DEC-F15 and DEC-F17 (CON-004). Grievances already filed keep their window (DEC-F16).

### 2. Meetings, votes and minutes (2030, section 2)

1. **Business calendar (DEC-F02, AMB-055/094, CON-005).**
   - `config.business_week_pattern` is effective-dated. Its seeded default, Friday and Saturday off, is an OWNER_DEFAULT.
   - `config.business_calendar_day` holds dated holidays, closures and weekend working days. A row is withdrawn, never changed or deleted.
   - Nothing is seeded. The `BUSINESS_CALENDAR_SOURCE` setting is SOURCE_REQUIRED.
   - `committee.add_business_days` reads the calendar, so every due date follows it.
   - The commands are `set_business_calendar_day`, `withdraw_business_calendar_day` and `set_business_week_pattern`. They need the new permission `BUSINESS_CALENDAR_ADMIN` (PLATFORM_ADMIN). Past days and past effective dates are refused, so no change is retroactive.
2. **Acting roles (DEC-F03, CON-007, AMB-040/042/050/066).** `committee.meeting_acting_role` records who acts in another's place for one meeting, and why. The basis (ABSENT, CONFLICTED, INELIGIBLE, VACANT, HANDOVER) is derived from the records, not typed in.
   - **Acting chair.** The secretary running the meeting activates the deputy chair when the chair is absent, conflicted, ineligible or vacant.
   - **Casting vote.** It goes to the chair if participating and eligible. Otherwise it goes to the activated acting chair, only when the snapshot grants `acting_chair_casting_vote`. Otherwise nobody casts and a tie stays TIED. The secretary never casts.
   - **Acting secretary.** The alternate secretary is activated by the seated secretary (handover) or by the meeting's chair or acting chair. `authz.can_manage_meeting` is narrowed: an alternate secretary runs a meeting only while recorded as acting for it. Committee-level alternate-secretary work (scheduling, grievances, packages) stays as built.
   - **Handover.** On a HANDOVER basis the seated secretary keeps managing the meeting alongside the acting alternate; both can run it. This is accepted (AGENT-09 early look, note b): the handover adds a manager and removes none.
3. **Alternate members (AMB-041/088).**
   - An ALTERNATE_MEMBER seat holder votes in place of a named voting member who is conflicted, ineligible, absent or excused.
   - Quorum counts seats: the replaced member stops counting and cannot be recorded present (`REPLACED_BY_ALTERNATE`).
   - On a Grievance Committee the firewall applies: never an alternate who voted in the case's Investigation Committee.
4. **Conflict decider cascade (DEC-F04, CON-006).**
   - `authz.meeting_concern_decider_seat` follows the order: chair, then deputy chair, then the committee's independent conflict authority.
   - Each must be eligible: no conflict, not recorded absent, seat current, cleared for the case, and neither the raiser nor the subject.
   - The authority sits in `committee.conflict_authority`. It is effective-dated, SOURCE_REQUIRED until APPROVED, and holds no seat on the committee.
   - `api.appoint_conflict_authority` and `api.end_conflict_authority` need COMMITTEE_ADMIN. No self-appointment and no overlap.
   - The authority decides without seeing the meeting itself.
   - The SECRETARY rule option of ADR-038 is unchanged.
5. **Seats and the snapshot (AMB-038, AMB-039).**
   - A member whose seat has ended no longer sees the proceeding, its meetings or its deliberation. They are not copied into later meetings and cannot vote (`SEAT_ENDED`). This closes the backlog note "snapshotted members keep visibility after seat end".
   - A member appointed after the referral joins later meetings only through `api.amend_proceeding_snapshot` (the secretary, with a reason).
   - On a restricted case the amendment is refused (`AUTHORITY_APPROVAL_REQUIRED`) until a Restricted Case Authority approval path exists (DEC-F19, fail closed; AGENT-09 early look, note c, keeps it).
6. **Quorum and voting (DEC-F01, AMB-043/067/077/081/082/083).**
   - No vote item opens without quorum, on any path (a trigger on `committee.vote_item`).
   - Abstentions count neither way.
   - `api.recuse_for_conflict` is a recusal and a declaration in one step. The member leaves the deliberation for the rest of the meeting.
   - `api.revise_vote` makes an append-only revision while the item is open; the last choice counts. The ledger never records a choice.
   - `api.record_vote_note` adds one note per member and item. The committee reads it after close. It is annexed to the minutes only on request.
   - Under SECRET_BALLOT nobody reads individual choices, and notes and annexes do not name their member.
7. **Minutes (AMB-092).**
   - An objection (CHANGES_REQUESTED) blocks deemed approval unless the snapshot says otherwise.
   - The chair or acting chair overrules it with a reason (`api.overrule_minutes_objection`), never their own objection.
   - Minutes record the emergency flag, the acting roles and the annexed notes.
8. **Notice and invitees (AMB-061, AMB-156/157/158).**
   - A meeting at shorter notice than `minimum_notice_days` needs `api.schedule_emergency_meeting` with a reason.
   - `committee.invitee_type_rule` (COMMITTEE_ADMIN) holds two settings per invitee type:
     - whether the type is enabled: INTERPRETER is off and SOURCE_REQUIRED;
     - whether a confidentiality acknowledgement is required: WITNESS, EXPERT and INTERPRETER need one; LEGAL, INFORMATION_PROVIDER and SUBJECT do not.
   - An interpreter always declares conflicts.
   - An invitee who must acknowledge does so before being recorded present.
   - Accommodation requests are read only by the participant and the secretary running the meeting.
9. **Excluded witness (DEC-F07, ADR-039).** An excluded witness receives no cancellation notice. No acknowledgement or accommodation is recorded for them, and they are told `WITNESS_EXCLUDED` before anything else.
10. **Reversal of an upheld conflict (DEC-AMB-010, AMB-055, T-AMB-032).**
    - The next eligible decider in the DEC-F04 order after the original one reverses an upheld determination, with a reason (`api.reverse_meeting_conflict_determination`, `committee.meeting_conflict_reversal`). That order is secretary, chair, deputy chair, authority.
    - The reverser is never the raiser, the subject or the original decider. When no later level has anyone eligible, nobody reverses (fail closed).
    - The reversal is prospective:
      - the member may declare again in later meetings (`PRIOR_CONFLICT_DECLARED` skips a conflict that came only from a reversed determination);
      - `authz.has_meeting_conflict` stops counting that conflict for the proceeding's later work;
      - the conflict row an upheld concern writes names that concern (`committee.meeting_conflict.concern_id`), so reversing one concern clears only the conflict resting on it; a conflict the member declared, the secretary recorded, or another concern upheld still counts, and so does a decision row written before 2030 (AGENT-09 early look, note a);
      - the meeting in which the conflict was upheld keeps the member conflicted.
    - DEC-F38 for committees is as built: a conflict declared or upheld in one meeting bars a "no conflict" declaration in the proceeding's later meetings.
11. **No meeting recording (DEC-AMB-007, AMB-068, T-AMB-040).** No recording command, field or provider integration exists. Approved minutes and the structured meeting records are the official record.

### 3. Recommendation packages, legal review and authority decisions (2030, section 3)

To be completed with section 3 of the migration: DEC-F11, F12, F13, F19, F20; CON-017, CON-018; and DEC-AMB-003 (conflict taint, re-vote or reasoned confirmation).

### 4. Notices, grievances, sanctions, corrective actions, export, continuity and catalogue (2040)

To be completed with migration 2040: DEC-F09, F14–F18, F21–F36; and DEC-AMB-001, 004, 009 and 011; the CDF-207 guard; CON-009.

## Consequences

- Every new table has RLS enabled, is default deny, and is select-only where readable at all. Vote revisions and notes have no grant; they are read only through `api.vote_item_status` and the minutes.
- Every new command writes its audit event in the same transaction. Reasons stay in their rows; the ledger gets ids and codes.
- New commands are in the IDOR catalog (probes or admin list) and in the audit walk; `owner-decisions-meetings.spec.ts` holds the behaviour and negative tests.
- **For security review**, the predicates this record changes:
  - **Narrowed:**
    - `authz.can_manage_meeting` (alternate secretary only while acting);
    - `authz.can_view_committee_proceeding` and `authz.can_view_meeting_deliberation` (current seat);
    - `authz.meeting_concern_decider_seat` (cascade; adds the authority).
  - **Widened by owner decision:**
    - `authz.can_view_meeting_concern`: an eligible reverser and the reverser can read the concern (DEC-AMB-010);
    - `authz.has_meeting_conflict`: a conflict that came only from a reversed determination no longer counts (DEC-AMB-010).
- Screen impacts for Phase 12 (UX) are listed in `rebase/review/` with the early-look pack:
  - the acting chair, acting secretary and alternate activations;
  - emergency scheduling;
  - the conflict authority's queue and the reversal;
  - the interpreter invitee, the acknowledgement and the accommodation;
  - vote revision and notes, and the objection overrule;
  - the calendar administration.

## Still SOURCE_REQUIRED

- The holiday calendar and its source.
- `acting_chair_casting_vote` and `minimum_notice_days` per committee charter.
- The independent conflict authority's appointment.
- Enabling INTERPRETER, and the acknowledgement wording reference.
- An approval path for amending a restricted case's snapshot.
