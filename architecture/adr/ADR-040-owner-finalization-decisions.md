# ADR-040: Applying the owner's Finalization Set and the ambiguity decisions (migrations 2030 and 2040)

- **Status:** Proposed (2026-10-13). Linear CDF-196 (rebase decision application; stays In Progress until hosted validation). Implemented in migrations 2030 and 2040 (local, pending security review). Amends ADR-019, ADR-020, ADR-024, ADR-038 and ADR-039.
- **Owner decisions:**
  - the Finalization Set DEC-F01 to DEC-F41 (2026-10-13 02:54 UTC), recorded in `docs/business-architecture/OWNER_DECISIONS_FINALIZATION.md`;
  - the ambiguity decisions DEC-AMB-001 to DEC-AMB-012 (2026-10-13 10:01 UTC), recorded in the same file, section 16;
  - DEC-AMB-013, option A (2026-10-13 14:40 UTC, confirmed final 14:43), recorded in section 16 and applied in section 3 item 10 below;
  - DEC-AMB-014 and DEC-AMB-015, option A each (2026-10-13 15:48 UTC, one message, final; confirmed closed on the owner side at 17:27), recorded in section 16 and applied in section 3 items 11 and 12 below; the reopening half of DEC-AMB-015 is migration 2060's (ADR-042);
  - the Phase 12 owner pack (DEC-04, 05, 11, 12, 13, 18, 19, 22, 36, 48, 49, 51; 2026-10-13 14:43 UTC), recorded in section 17. PR-A builds none of it: the screens and migrations 2150 (ADR-052) and 2160 (ADR-053) belong to the UX thread. PR-A was checked against DEC-05, DEC-12, DEC-13, DEC-19 and DEC-49 (Consequences).
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
      - the meeting in which the conflict was upheld keeps the member conflicted;
      - a vote taken while the conflict stood stays TAINTED_BY_CONFLICT until the committee resolves it (§3 item 9): a reversal never clears a taint.
    - DEC-F38 for committees is as built: a conflict declared or upheld in one meeting bars a "no conflict" declaration in the proceeding's later meetings.
11. **No meeting recording (DEC-AMB-007, AMB-068, T-AMB-040).** No recording command, field or provider integration exists. Approved minutes and the structured meeting records are the official record.

### 3. Recommendation packages, legal review and authority decisions (2030, section 3)

1. **Sanction catalogue versions (DEC-F11; AMB-036, AMB-101, AMB-102).**
   - `decision.sanction_catalogue_version` stores each sanction code's governed fields, effective-dated: legal basis, internal policy basis, authority, legal-review requirement, subject categories and exclusivity group.
   - Every seeded row is SOURCE_REQUIRED. Nothing is invented.
   - `decision.sanction_catalogue_entry` shows a basis only once the row is APPROVED. An APPROVED row needs both a legal basis and a source reference.
   - CONTRACTOR is in no seeded version. A contractor subject therefore gets `SANCTION_NOT_APPLICABLE_TO_SUBJECT` until a sourced version adds the category.
   - Adoption writes `decision.item_adoption`, recording the version in force at that moment. Packets carry the version id, so a later catalogue change never alters an adopted item.
   - `api.set_sanction_catalogue_entry` needs COMMITTEE_ADMIN. It is append-only and forward-dated only (`LATER_VERSION_EXISTS`).
2. **Legal-review rules (DEC-F12, CON-017; AMB-113, AMB-123).**
   - `decision.legal_review_rule` replaces the fixed type list. A rule applies per committee kind, effective-dated, and triggers either by item type or by the item's new `requires_legal_justification` flag.
   - A catalogue version may also require review.
   - The owner minimums, LEGAL_ACTION and the legal-justification flag, cannot be set to NOT_REQUIRED (`OWNER_MINIMUM_RULE`).
   - A secretary's deliberate request keeps the SECRETARY_ELECTED basis.
   - A GRIEVANCE rule row is seeded but not enforced, because the grievance path has no package. See open questions.
3. **Authority rules (DEC-F13, CON-018; AMB-127, AMB-132, AMB-135).**
   - A rule may name joint authorities (`decision.action_authority_rule_joint`, through the `text[]` overload of `api.set_action_authority_rule`).
   - Submission fails closed (`AUTHORITY_RULE_MISSING`) while an adopted item type has no rule.
   - Submission snapshots the rule, its authorities and its source status per item (`authority_submission`, `authority_requirement`).
   - `api.authority_rule_coverage` lists types with no rule. It also shows that FINAL_DISCIPLINARY_AUTHORITY is still SOURCE_REQUIRED while the CEO rule is an owner default.
4. **Authority decisions (AMB-125, AMB-126, AMB-129 to AMB-131, AMB-133).**
   - There is one decision per authority type over its own items (`authority_decision_scope`). The package becomes DECIDED only when every required authority has decided every item it must.
   - Joint authorities that disagree return the package.
   - A decision records:
     - a delegation reference;
     - whether the source is signed (unsigned needs the secretary's attestation and is flagged UNSIGNED_SOURCE; no attribute is flagged SIGNATURE_NOT_RECORDED);
     - a primary source document and further ones;
     - structured conditions (free text only is flagged).
   - `decided_at` may not fall on an Asia/Riyadh day before adoption.
   - `decision.authority_decision_overview` is a read-model with flags only. The export is unchanged and belongs to 2040.
5. **Returns, cancellation, superseding opinions (AMB-108, AMB-115, AMB-117).**
   - The secretary returns an adopted, unsubmitted package. After submission only the authority returns it.
   - An open request can be cancelled; the replaced reviewer's packet ends at once.
   - The reviewer may give a superseding opinion in the same round before submission. Both opinions are kept and both travel to the authority. A superseding CONFLICTS returns the package.
6. **Purpose access ends (AMB-119, AMB-229).** The legal reviewer's packet ends when an authority decision on the package is recorded. A task linked to a legal-hold request ends when the request is decided. Both apply after the grace `PURPOSE_ACCESS_GRACE_DAYS`, default 0.
7. **Restricted legal review scope (DEC-F20, AMB-120).** An approval names its round, findings and minutes. A packet item outside that scope is refused on every path, by a trigger. More material needs a new approval. DEC-F19 is as built and confirmed by test.
8. **Guards (AMB-026, AMB-018, AMB-100, AMB-030).**
   - A sanction on an allegation its subject has no defence notice on is not adopted (`DEFENCE_NOTICE_REQUIRED`). The rule-set option `sanction_requires_defence_notice` can switch this off.
   - A non-direct case reaches the Investigation Committee only after an approved REFERRED_TO_COMMITTEE preliminary review. This is a trigger on `committee_proceeding`, so every path is covered.
   - Dependencies and exclusivity groups are flagged.
   - AMB-030 is as built.
9. **Conflict taint: DEC-AMB-003 (owner, 2026-10-13), option B (AMB-051).**
   - **When an item is tainted.** An item whose current result came from a closed vote is TAINTED_BY_CONFLICT if someone now conflicted took part in that vote: a substantive vote or abstention, a recusal that counted towards quorum, or the casting vote (the chair's or an acting chair's). "Conflicted" means any of:
     - a declared or upheld meeting conflict in the proceeding;
     - an upheld concern about one of their participant rows in the proceeding, **even if since reversed**. DEC-AMB-010 is prospective, so a reversal never clears a taint; only the committee's resolution does (test "T-AMB-028: a reversal of the upheld conflict does not clear the taint; the committee still resolves it");
     - a declared or confirmed case conflict.
   - **What the tally counted.** When an item leaves OPEN, `decision.vote_tally_entry` freezes each vote with its last choice (AMB-081) and whether `api.close_vote_item` counted it. A vote counted when its participant had no conflict, was present and was a counting voter: an activated alternate counts, and the member it replaces does not. Fail safe, a member who voted and then declared a conflict before the close still taints, although the tally left the vote out. A recusal that did not count (`api.recuse_for_conflict`) is not participation.
   - **What the database refuses while it is tainted.** Triggers and command checks refuse, on every path:
     - adoption;
     - a legal-review request or opinion;
     - submission;
     - a DECIDED status;
     - every authority decision except RETURN_TO_COMMITTEE;
     - once decided, opening a corrective action and issuing a decision notice.
   - **Who resolves it.** The secretary running an open meeting of the proceeding records the committee's resolution with `api.resolve_conflict_taint(item, resolution, reason)`:
     - The reason must be 10–2000 characters. It stays in the row; the audit gets codes only.
     - The resolution is stored in `decision.conflict_taint_resolution`, once per taint. The table is append-only.
     - It is read only by whoever runs a meeting of the proceeding and by conflict managers (CONFLICT_MANAGE) who can view the case (AGENT-09 early look, R1). It names the conflicted members, including case-level conflicts that only conflict managers read, and its recount would reveal a member's vote under a secret ballot. Every other viewer of the package sees only the TAINTED_BY_CONFLICT flag (`api.recommendation_item_flags`), which names nobody.
     - The ledger event `CONFLICT_TAINT_RESOLVED` carries ids, the resolution code, the count of conflicted members and the package status. It carries no reason, no member and no result, as `VOTE_REVISED` records no choice.
   - **RE_VOTE.** Before the authority decides, the package goes back to DRAFT. The next round opens a new vote on the same target, so the tainted result never counts. On a decided package, RE_VOTE opens the remediation of item 10.
   - **CONFIRM.** Allowed only when the recount without every vote of the conflicted participants gives the same result under the snapshot's DEC-F01 rule and quorum. Otherwise it is refused with `RESULT_MAY_CHANGE`. That refusal tells the secretary that the conflicted votes were decisive; this disclosure, to the secretary only, is inherent in DEC-AMB-003 option B and is accepted (AGENT-09 early look, note a on pack 2).
     - `decision.recount_without` works from the counts and the votes the tally froze. Each counted conflicted participant leaves the eligible and present members, and their last choice leaves the tally. Approvals and rejections count; abstentions and recusals count neither way (DEC-F01). A vote the tally did not count changes nothing.
     - A tie stays broken only by a casting vote whose caster (the chair or an acting chair) is not excluded and whose tie is unchanged. Otherwise the recount is TIED.
     - The recount is null, so CONFIRM is refused, under a CUSTOM quorum, another decision rule, or a tally frozen before `decision.vote_tally_entry` existed.
   - **Who may not resolve it.** A conflicted participant, or anyone who raised a concern about one, gets FORBIDDEN.
   - **Restrictions on RE_VOTE.** It is refused while a review is open or while the package is with the authority (the authority returns it first). On a decided package it is the DEC-AMB-013 path (item 10).
   - **The governing test** is `T-AMB-028: a conflict found after a vote or decision taints the item; the database refuses every downstream step until the committee resolves it by RE_VOTE or CONFIRM; CONFIRM needs documented reasoning and a result the conflicted participation could not have changed`, in `tests/security/recommendations-authority.spec.ts`.
10. **Conflict found after the authority decided: DEC-AMB-013 (owner, 2026-10-13), option A (AMB-051).** This replaces the earlier fail-closed default ("a decided package stays blocked unless CONFIRM holds"), with its negative tests in the same migration. It is remediation of a tainted decision chain, never the closed-case reopening of DEC-AMB-002 (2060).

- **Entry, only on a validated, decisive conflict.** The taint of item 9 already blocks everything downstream. The secretary records the committee's RE_VOTE with `api.resolve_conflict_taint` as before. On a DECIDED package it is accepted only when the recount without the conflicted votes differs from the result, or cannot be made. Where the recount gives the same result it is refused with `RESULT_UNCHANGED`, and the DEC-AMB-003 CONFIRM path applies.
- **The remediation record.** RE_VOTE opens one `decision.conflict_remediation` per package, holding the lineage Fady listed:
  - the resolution (whose row keeps the reason), the tainted vote item and the decided round;
  - every member whose vote tainted any closed vote of that round, and each one's conflict events (meeting declaration, upheld concern, case conflict), taken by the database, never from the writer;
  - the original result and the recount;
  - once the authority decides again: the new round, the new vote on the same target, its result and the replacement decision.

  A trigger refuses any remediation not backed by such a RE_VOTE on a decided package (`NO_VALIDATED_CONFLICT`), on every path. A remediation closes once, only on the authority's decision of a later round. It is never deleted.

- **Back to the committee.** The package goes straight to VOTING in the next round with the same items. `decision.protect_records` lets a decided package change only this way, once per open remediation.
- **Excluded from the re-vote.** `decision.revote_excluded` keeps every conflicted member of the decided round out of every later vote on the package:
  - no vote row of any kind (their own vote, a recusal, or one the secretary records), refused with `EXCLUDED_BY_CONFLICT` by a trigger on `committee.vote`;
  - not eligible and not present for quorum (`committee.quorum_state` with the package round), at opening and at the close;
  - never awaited at the close;
  - `api.meeting_view` offers them no vote.

  A casting vote needs the caster's own counted vote, so an excluded chair never casts. A DEC-AMB-010 reversal of the conflict does not lift the exclusion: the remediation exists because of that conflict (fail closed).

- **Preserved, then superseded.** The original votes, tally, resolution and authority decisions are not edited. When the authority's decision makes the package DECIDED again, `decision.close_conflict_remediation` closes the remediation and marks each decision of the remediated round SUPERSEDED in `decision.authority_decision_supersession`, naming the replacement. A trigger refuses a supersession before that replacement exists (`REPLACEMENT_DECISION_REQUIRED`). The table is append-only. `decision.authority_decision_overview` flags a superseded decision `SUPERSEDED`.
- **Downstream blocked.** `decision.decision_block(decision)` gives `TAINTED_BY_CONFLICT`, `CONFLICT_REMEDIATION_OPEN` (while the package is being re-voted and re-decided) or `DECISION_SUPERSEDED` (for good; a corrective action of a superseded decision is FROZEN_BY_SUPERSEDED_DECISION until the replacement decision disposes of it, item 11). Every downstream guard reads it:
  - opening a corrective action;
  - progress on one (status or percentage; the due date, the owner and a waiver are not progress);
  - issuing a decision notice, and delivering one (2040), so no grievance window starts on such a decision;
  - executing a sanction (2040, `decision.execution_block`);
  - case closure, and any other move out of ACTIVE (a trigger on `case_record`, so a later path out cannot skip it).

  Reminders skip actions of a blocked decision, and `api.corrective_action_view` shows the code to the case team with the progress capabilities off. The package's items carry the flag `CONFLICT_REMEDIATION` while the remediation is open.

- **Reads and audit.** A remediation names the conflicted members and carries results, so it is read like the resolution: by whoever runs a meeting of the proceeding, and by conflict managers who can view the case. A supersession names decisions only and is read with the package. The ledger gets `CONFLICT_REMEDIATION_OPENED`, `AUTHORITY_DECISION_SUPERSEDED` and `CONFLICT_REMEDIATION_CLOSED` with ids, rounds and counts: no member, no result, no reason.
- **Tests** (`tests/security/recommendations-authority.spec.ts`, "found after the authority decided (DEC-AMB-013 …)"), one per negative Fady named:
  - a decisive tainted vote is never confirmed (command and table);
  - only the committee's RE_VOTE on a validated conflict sends a decided package back (untainted, non-decisive, a CONFIRM resolution, a direct status change and a forged remediation are all refused);
  - the conflicted member takes no part, even after a reversal;
  - the earlier decision stays unchanged and is superseded only after the replacement;
  - downstream execution stays blocked until the new decision.

11. **Corrective actions of a superseded decision: DEC-AMB-014 (owner, 2026-10-13 15:48), option A (AMB-051).** Fady: "The replacement authority decision must explicitly determine the disposition of every corrective action that originated from the superseded decision." This replaces the earlier fail-closed default (the action stays frozen and the case cannot close until it is waived, which no role can do while `CORRECTIVE_ACTION_WAIVE` is SOURCE_REQUIRED), with its negative tests in the same migration.

- **Frozen.** Once a decision is superseded (item 10), every corrective action that executes it is `FROZEN_BY_SUPERSEDED_DECISION` (`decision.action_block`, the one source for the guards, the reminders, the closure guard and the action view). Until the replacement decision disposes of it, the database refuses on every path:
  - progress and status changes (the freeze trigger on `decision.corrective_action`), so it is not submitted or verified complete;
  - an ordinary waiver ("not an ordinary standalone waiver"): `CORRECTIVE_ACTION_WAIVE` plays no part in a supersession and stays SOURCE_REQUIRED;
  - any other action on the same item (`decision.guard_action_insert`), except the replacement action its own disposition names;
  - case closure and any other move out of ACTIVE (the 1940 closure guard and the 2030 conflict trigger on `case_record`).

  Reminders skip it. Nothing is carried forward and nothing is waived automatically. When the remediation closes, the ledger gets `CORRECTIVE_ACTION_FROZEN` per action (ids only) and the supersession event counts them.

- **The disposition.** A corrective-action manager of the case records the replacement decision's disposition with `api.dispose_superseded_corrective_action`, citing one of that decision's own source documents (N15), on an ACTIVE case. One row per action and superseded decision in `decision.corrective_action_disposition` (append-only; a trigger repeats every check on every path):
  - `RE_ADOPT`: the action resumes under the replacement decision as it stands, with its events, progress and any completion. The action row is never re-pointed: `decision.action_governing_decision` derives the decision it now executes, so a later supersession of the replacement freezes it again.
  - `MODIFY`: a revised title and description become the next version. Every earlier wording is kept in `decision.corrective_action_version` (append-only), the first one snapshotted from the row. A new due date may be given. An action awaiting verification goes back to IN_PROGRESS, since its completion answered the earlier wording. `decision.protect_corrective_records` lets the wording change only to the next version number with its version row, which only a MODIFY disposition creates.
  - `WAIVE`: kept for good as `WAIVED_BY_SUPERSEDING_DECISION`. An open action is closed as WAIVED with the replacement decision's source; a completed or already waived one keeps its record. It is final on every path.
  - `REPLACE_WITH_NEW_ACTION`: a new action on the item under the replacement decision, linked from the disposition (a unique, deferred key); the old one is closed as for WAIVE and shows `REPLACED_BY_NEW_ACTION`. The new action names its owner as any new action does (the Restricted Case Authority on a restricted case) and takes the policy due date when none is given.

  RE_ADOPT, MODIFY and REPLACE_WITH_NEW_ACTION need the replacement decision to approve the item; where it does not, only WAIVE is open. RE_ADOPT and MODIFY never reopen a waived action, and MODIFY never a completed one.

- **Audit**, the lineage Fady listed: `CORRECTIVE_ACTION_DISPOSED` on the action (the original corrective action), with the decision it was opened under, the superseded and the replacement decision, the disposition, the prior and new status, the source, the revised version and the replacement action. Actor and time are the event's own. The reason goes in the event's reason field, as for a waiver, and stays in the row. A replacement action also gets `CORRECTIVE_ACTION_OPENED`, naming the action it replaces.
- **Reads.** `api.corrective_action_view` gives every viewer of the action its version and earlier wordings. The case team also gets the decision it executes now, its dispositions (without their reasons: the card carries no reason) and the dispositions still open, with `may_dispose`.
- **Tests** (`tests/security/recommendations-authority.spec.ts`, T-AMB-028, "DEC-AMB-014"): a frozen action does not progress, is not verified or waived, takes no sibling and keeps the case open until disposed of, and RE_ADOPT resumes it with its history; MODIFY keeps every version and REPLACE links the new action; WAIVE is final; dispositions are refused for a decision that is not superseded, from a source the replacement decision does not cite, for an item it does not approve, twice, and at the table on every forged path.
- **Neighbouring consequences, kept by Fady as coordinator defaults "for now"** (owner-confirmed defaults, not new decisions; 2040, item 5.10 and 5.5):
  - A sanction already executed under the superseded decision keeps its execution record and is not executed again (one execution per item and subject, append-only). `api.sanction_executability` names the decision it was executed under and marks it `execution_origin: SUPERSEDED_DECISION`. The replacement decision determines any remedial consequence separately.
  - A grievance already filed against the superseded decision is not deleted, cancelled or migrated. `api.grievance_view` marks it `contested_decision_relationship: SUPERSEDED_DECISION`, and its submissions and audit history stay as they are.
  - Tests: the original authority decision is unchanged, a superseded sanction is not re-executed, and an existing grievance is preserved rather than rewritten.

12. **Conflict found after the case closed: DEC-AMB-015 (owner, 2026-10-13 15:48), option A (AMB-051, AMB-218).** Fady: "Use the controlled reopening machinery of DEC-AMB-002, but treat the validated post-decision conflict event as an authorized reopening trigger alongside new evidence." It is split as the coordinator placed it:

- **2030 (this record).** A closed case never enters item 10 directly. A conflict remediation is refused unless the case is ACTIVE (`CASE_NOT_ACTIVE`, in the remediation trigger, on every path); the committee's RE_VOTE was already refused on a closed case, and the meeting commands need an active case. Test (T-AMB-028, "DEC-AMB-015"): on a closed case the RE_VOTE and a forged remediation are refused, and the package, its decision and the case stay as they were.
- **2060 (ADR-042, with DEC-AMB-002).** The governed reopening reason `DECISIVE_POST_DECISION_CONFLICT`, distinct from new evidence. The conflict is validated through the applicable conflict process first; the closure authority approves the reopening with reason and audit and does not re-decide the conflict's merits; it fails closed while `CASE_CLOSURE_APPROVAL_RULE` (AMB-212) is SOURCE_REQUIRED, with no new setting. Once the case is ACTIVE again, item 10 applies, then item 11. Fady's negative test "reopening for post-decision conflict requires closure-authority approval" is T-AMB-131 (AMB-218) and lands with 2060.

### 4. Purpose read models, meeting notices and demo seats (2030, section 4)

The UX thread's Phase 12 asks (coordinator, 2026-10-13): the web BFF does not read case tables, or call the full-case read, for purpose views (DEC-02: COMMITTEE, REVIEW and TRIAGE access is never full-case).

1. **`api.meeting_view(meeting)`.**
   - The full view is gated by `authz.can_view_meeting`. Each part follows the predicate of the table it comes from, evaluated for the caller:
     - logistics, but never the emergency reason;
     - the caller's own participant row;
     - the roster (`authz.can_view_meeting_roster`);
     - deliberation (`authz.can_view_meeting_deliberation`): vote items, status, result and the tally after close, never an individual choice or note;
     - concerns (`authz.can_view_meeting_concern`, never the subject);
     - acting roles, without the reason;
     - pointers to the minutes.
   - The case appears as `case_id` and `case_number` only, under `authz.can_view_case_metadata`. Nothing else from the case record is read.
   - **Concern-only view.** A caller who cannot see the meeting but can see one of its concerns gets the meeting id and status, the case under the same predicate, and those concerns with `may_decide` and `may_reverse`. Two kinds of caller reach it: the independent conflict authority (DEC-F04) and a reverser seated after the referral (DEC-AMB-010). This widens nothing, because the concern rows already carry the meeting id and are readable by exactly those users.
   - Everyone else gets NOT_FOUND, including an excluded witness (DEC-F07).
2. **`api.minutes_view(minutes)`.** Gated by the minutes read rule. Reviews and objection rulings show only under deliberation.
3. **Capabilities.** Each view carries a `capabilities` object of booleans. Each flag uses the checks of the command it stands for, in the same order. The tests compare every flag with the command's real outcome. A flag never widens a command; the command still decides.
4. **Reads.** Both are SECURITY DEFINER with `search_path = ''` and are granted to `authenticated` only. They write no audit event, like `api.vote_item_status`.
5. **Two content-free notifications.** Both carry ids only and deep link to `/meetings/<id>`.
   - `MEETING_CONFLICT_DECISION_REQUESTED` goes to whoever DEC-F04 names as decider, never the raiser or the subject.
     - Each candidate is checked by user id against the same rule the command uses (`committee.concern_decider_seat_for`).
     - `authz.meeting_concern_decider_seat` is that rule for the current user, and `authz.can_manage_meeting` likewise wraps `committee.manages_meeting`.
     - The request identity is never changed (AGENT-09 pack 3, R1). A test pins that no function body sets `request.jwt.claims`.
   - `MEETING_VOTE_OPENED` goes to present, cleared voters with no vote.
   - Every recipient passes `authz.user_case_gate` and has no meeting conflict.
6. **Synthetic committee seats (seed 30).**
   - Seven demo-only users (`@example.test`, named "(demo)") hold IC and GC seats, appointed through the audited command. A separate DEMO committee pair is impossible because `committee.kind` is unique (ADR-018).
   - The security tests start unseated: `unseatDemoSeats`, called from `seat()` and `refer()`, ends the demo seats inside each test's transaction.
   - An insert-only top-up runs the same idempotent seed on hosted DEV.

### 5. Notices, grievances, sanctions, corrective actions, export, continuity and catalogue (2040)

Where a decision leaves a value SOURCE_REQUIRED, 2040 stores null and either refuses (`CONFLICT:<CODE>`) or keeps the behaviour off until it is configured. Everything is additive. Replaced functions keep their signature, owner and grants.

1. **Delivery and the grievance window (DEC-F15, AMB-137, CON-002).**
   - A notice records its delivery (`api.record_notice_delivery`).
   - The window starts from the basis the rule snapshot names: issue, delivery or acknowledgement.
2. **The rule in force at the contested decision (DEC-F16).** A grievance takes the rule set in force when the contested decision was made.
3. **Non-admission (DEC-F17, AMB-148, CON-004).**
   - The admissibility decider and the non-admission decider are snapshotted; the default is COMMITTEE.
   - EXTERNAL is recorded with a reference only.
4. **The defence response period (DEC-F18, AMB-151/152/154, CON-019).**
   - The period is SOURCE_REQUIRED.
   - Deadline changes are recorded with a reason.
   - A subject may decline to respond. A late response carries its reason.
   - Reminders skip a suspended notice.
5. **The grievance lifecycle (AMB-139/140/141/143, CDF-207).**
   - One open grievance per decision.
   - The grievant withdraws before the outcome (`api.withdraw_grievance`); the window is not reopened.
   - Completion is requested and supplied.
   - The contested items are named.
   - A grievance against a decision later superseded stays as filed; `api.grievance_view` marks the relationship `SUPERSEDED_DECISION` (Fady's kept default, section 3 item 11).
6. **One reconsideration (DEC-AMB-001, owner, option B; AMB-145, T-AMB-085).**
   - After a grievance is decided, the grievant may file one reconsideration of the same decision, only on genuinely new evidence stated with a description and a reference. It is filed through the portal (`api.file_grievance_reconsideration`) or recorded by the secretary (`api.record_grievance_reconsideration`).
   - Admissibility confirms that the evidence is new.
   - A further grievance on the same decision is always refused (`RECONSIDERATION_USED`).
   - New facts otherwise go through reinvestigation.
7. **Suspension by sanction type (DEC-AMB-004, option C; AMB-110, T-AMB-063).** Configured as `SANCTION_GRIEVANCE_SUSPENSION` through `api.set_sanction_rule` (COMMITTEE_ADMIN), recorded in `sanction_rule_change`.
   - An irreversible or materially difficult-to-reverse type is not executable during the grievance window, nor, once a grievance is filed, until it is resolved.
   - A reversible type follows its rule: SUSPEND_UNTIL_RESOLVED or PROCEED.
   - Every seeded value is SOURCE_REQUIRED. A type with no rule, or a sanction outside the catalogue, is held as irreversible (fail closed). TERMINATION is marked irreversible as the fail-safe default.
8. **Leaving employment (DEC-AMB-009, option A; AMB-031, T-AMB-013).**
   - The investigation continues through findings and recommendations.
   - A sanction may be recorded and decided, but it is not executable, and not shown as executable, unless a recorded statement with its source document says the employment relationship still permits that type. There is no authority override.
   - Governance and corrective actions stay actionable.
9. **Never more severe (DEC-AMB-011, option A; AMB-149, T-AMB-088).** Configured as `SANCTION_SEVERITY_RANK`, seeded unranked. Null means "not comparable", never "equal".
   - A grievance outcome upholds, reduces, modifies to no more severe a sanction, or cancels.
   - A change between types needs both ranks and a substitute no more severe (`grievance.outcome_substitution`). A change involving an unranked type is refused.
   - Within one type the outcome declares REDUCE or NONE; INCREASE is refused.
   - New facts go through reinvestigation, never through the grievance.
10. **Execution.**
    - `decision.execution_block` is the single source for the execution guard trigger and for `api.sanction_executability`.
    - It refuses on undelivered notices (AMB-109), on the employment rule (DEC-AMB-009), on a grievance that cancelled the item or returned it for reinvestigation (DEC-AMB-011), and on the suspension rule (DEC-AMB-004).
    - It also refuses while the package carries an unresolved TAINTED_BY_CONFLICT item (DEC-AMB-003). That item stays blocked even if the taint arises after the decision notice.
    - It refuses a decision under conflict remediation or superseded (DEC-AMB-013, section 3 item 10). While the package is back with the committee, `api.record_sanction_execution` says `CONFLICT_REMEDIATION_OPEN`, and `api.sanction_executability` keeps listing the sanction under its earlier decision, blocked. After the new decision the sanction is executed under the new decision, once its own notice is delivered.
    - An execution recorded before the decision was superseded stays, and is not repeated. `api.sanction_executability` names the decision each execution was recorded under (`executed_under_decision_id`) and marks one under a superseded decision `execution_origin: SUPERSEDED_DECISION` (Fady's kept default, section 3 item 11).
11. **A failed mandatory email notice (AMB-175).** It opens a delivery task for the issuer.
12. **Corrective actions (DEC-F26, F27, F28; CON-009).**
    - Escalation steps, evidence types and owner kinds, including pools. Pools are acted for through `decision.acts_for_action`.
    - The policy is set by its administrator.
    - On a restricted case only its Restricted Case Authority names who acts, so a unit or a pool never owns an action there (`RESTRICTED_CASE_OWNER_KIND`). As a backstop, `decision.acts_for_action` admits a unit or pool member on a restricted case only if the case's own access rules already do (AGENT-09 pack 3, R2).
    - Reminders and escalation steps go to the accountable owner, the managers and the role holders who can see the case. They never go to unit or pool members.
    - A pool's creator and reason are read only by its members, the policy administrator and the action managers (R3).
    - DEC-F29 is unchanged.
13. **Export (DEC-F21–F24).**
    - A purpose catalogue (`exchange.export_purpose`); OTHER needs a justification.
    - Approved external domains are SOURCE_REQUIRED and not enforced (PRODUCTION_SUBSTITUTION_REQUIRED).
    - Approver pools.
    - The restricted case authority's consent is required for a restricted external export (DEC-F23).
    - The requester is never the second approver, and configuration warnings flag a pool that could deadlock (DEC-F24).
    - The requester never consents to their own export as the Restricted Case Authority (CDF-208, AGENT-09 pack 4, R5): `api.decide_restricted_export` refuses with `REQUESTER_CANNOT_CONSENT`, and a trigger on `restricted_export_approval` backs it up. When the case's owner is its only authority, their own export of the case waits for a teammate's request (an accepted deadlock), and the export view says so (`authority_consent_blocked`). This replaces 1930's allowance.
    - Policy is administered by EXPORT_POLICY_ADMIN only.
14. **The continuity workbook (DEC-F30, F31).**
    - Named continuity operators (`exchange.bcp_continuity_operator`).
    - Staging rows are purged after `BCP_STAGING_RETENTION_DAYS`. The batch control data, counts, hashes and audit are kept.
15. **Statuses and forms (DEC-F32–F34).**
    - The ten status-code conflicts are registered; S099 is LEGAL_HOLD.
    - Retiring a form needs its criteria met.
16. **Referral and preliminary outcomes (DEC-F08, F09, F10).**
    - **DEC-F08.** The delegation maximum is SOURCE_REQUIRED (null enforces none; an end date is always required).
    - **DEC-F09, escalation.** After repeated rejection the sector approver may escalate to a configurable target, by default the IC chair seat. A vacant or involved target refuses (fail closed); no deputy stands in. The target accepts, which creates the case, or upholds. A chair who accepted may still vote, since acceptance is an admission decision.
    - **DEC-F09, the target's record.** Its reason, author and source are read by committee registry administrators only (AGENT-09 pack 3, R4). The escalation rule, the available actions and the commands are SECURITY DEFINER, and a referral screen shows only the target's committee and seat.
    - **DEC-F09, objection.** An objection is refused once an escalation is decided.
    - **DEC-F10.** NOT_FEASIBLE and NO_PERSONAL_JURISDICTION are INACTIVE. They are refused on insert and on endorsement or approval; an existing one can only be returned.
17. **Purpose read models and notices for Phase 12 (the UX thread's asks).** The web BFF reads these instead of the case tables.
    - **Views.** `api.referral_view` and `api.referral_queue`, `api.grievance_view` and `api.grievance_queue`, `api.export_request_view`, `api.corrective_action_view` and `api.bcp_import_batch_view`.
      - Each is SECURITY DEFINER with `search_path = ''`, granted to `authenticated` only, and writes no audit event.
      - Each returns NOT_FOUND exactly where row-level security hides the row.
      - Each carries `capabilities` that mirror its commands, and a test checks every capability against the real command.
    - **What they never show.**
      - The referral view: the escalation target's committee and seat only.
      - The export view: no document or storage key, and the requester is never offered an approval (DEC-F24).
      - The action card: never the case. A pool shows its code and name only. On a restricted case no unit or pool owner is offered.
      - The import batch: row metadata only, never the cells.
    - **The admissibility decider's read path (DEC-F17).**
      - While a grievance awaits the decision, its decider reads the grievance, its assessments, contested items, completion requests and supplements (additive policies through `authz.is_grievance_decider`).
      - Under CHAIR the decider is the chair or deputy chair; under COMMITTEE, the chair, deputy chair or a member. They must pass the case gate and have taken no part in the Investigation Committee. On a restricted case they must already work the case.
      - The read ends at the decision.
    - **Content-free notices.**
      - `GRIEVANCE_ADMISSIBILITY_DECISION_REQUESTED`.
      - Four referral notices: submitted to the head, returned, submitted to the secretary, escalated.
      - Three preliminary-review notices: review requested, approval requested, returned.
      - Deep links go to `/referrals/<id>` and `/preliminary-reviews/<id>`.
    - **Rules asked by user id.** `authz.can_view_referral` and `authz.can_view_preliminary_recommendation` wrap user-id forms (`intake.user_can_view_referral`, `case_mgmt.user_can_view_preliminary_recommendation`), so a notice checks its recipient without changing the request identity. The rule is the same for every caller.
    - **Coordinator rulings (2026-10-13), recorded with item 17.**
      - **Alternates.** The admissibility decider is whoever holds a CHAIR, DEPUTY_CHAIR or MEMBER seat on the Grievance Committee in the registry when the decision is due, as the grievance's decider rule names (CHAIR or COMMITTEE). No proceeding exists yet at this stage, so no snapshot applies. Alternates never decide admissibility or read as deciders.
      - **Restricted case.** The decider must already be able to view the case. If no seated decider can, nobody is asked and the handling secretary keeps the grievance. Whether the Restricted Case Authority names a decider is SOURCE_REQUIRED (below).
        - **Amended by migration 2098 (CDF-237, 2026-10-16).** 2040 applied this condition to the read path and the notice but not to `api.decide_grievance_admissibility`, so a chair or deputy chair who passed the case gate but did not work the restricted case could still record the decision with the grievance's id. 2098 adds it to the command, where both overloads answer `NOT_FOUND` as for an id the caller cannot reach (the four-argument one delegates), and to the command's flag (`may_decide` in `grievance.caller_capabilities`), which the read gate already kept from such a chair. No table, policy, grant or audit change. Tests: T-AMB-151 and flag == command for every seat holder (`tests/security/grievance-decider-restricted-2098.spec.ts`).
      - **Rejection.** A secretary's REJECTED on a referral sends no notice. The referral queue carries the status, and a notice is UX follow-on work.
      - **Import submit.** `may_submit` on an import batch is a hint taken from the stored preview, and `api.submit_bcp_import` decides.

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
  - **DEC-AMB-013 (section 3 item 10):** two new tables, select-only, with RLS. `decision.conflict_remediation` is read like `decision.conflict_taint_resolution`; `decision.authority_decision_supersession` is read with the package. `decision.protect_records` admits one new transition (DECIDED back to VOTING, only under an open remediation). Quorum, the close check and `may_vote` are narrowed by the re-vote exclusion. Nothing is widened.
  - **DEC-AMB-014 and DEC-AMB-015 (section 3 items 11 and 12):**
    - Two new tables, append-only and select-only, with RLS: `decision.corrective_action_disposition` (the case's viewers, `authz.can_view_case`) and `decision.corrective_action_version` (the action's viewers, `authz.can_view_corrective_action`). One new command, in the IDOR catalog and the audit walk.
    - **Narrowed:** the freeze trigger (an ordinary waiver is refused on a frozen action), the closure guard (a frozen action keeps the case ACTIVE), a new insert guard (no second action on a frozen item), the remediation trigger (`CASE_NOT_ACTIVE`), and the reminders.
    - **Widened by owner decision:** `decision.protect_corrective_records` lets an action's title and description change, only to the next version number with its version row, which only a MODIFY disposition writes (DEC-AMB-014: "create an auditable revised action version"). Status, decision, item and every other fixed column stay as they were.
    - **Read models:** `api.corrective_action_view` adds the version and earlier wordings for the action's viewers, and the governing decision, dispositions (no reasons) and `may_dispose` for the case team; `api.sanction_executability` adds two keys; `api.grievance_view` adds one. None shows anything its reader could not already read.
- **Phase 12 owner pack (section 17), checked against PR-A without widening it:**
  - DEC-19 (snapshot for decision-relevant data): satisfied. Rule snapshots, frozen tallies, packets, authority requirements and decisions are snapshots; DEC-AMB-013 keeps the superseded decision unchanged.
  - DEC-49 (workflow follows the object): satisfied. Every 2030/2040 command keys on the case, proceeding, package, action, notice or grievance; catalogue rows own nothing.
  - DEC-05 (S3 rules kept): nothing in PR-A changes them.
  - DEC-13 (clearance): PR-A adds no clearance command; the 2015 refusal (null keeps, true to false refused) stands.
  - DEC-12 (dual control): three PR-A grants that can widen access are single-approver today and are listed for 2160 (ADR-053): `api.appoint_conflict_authority` (2030), `api.add_export_approver` and `api.authorize_continuity_operator` (2040). Each refuses self-grant; none has a second approver yet. Separately, `api.set_corrective_action_pool_member` (2040) lets the corrective-action policy administrator add themselves to a pool. Revocations stay immediate, as DEC-12 allows. Deferred to 2160 as well (AGENT-09, pack 6, non-blocking): `api.dispose_superseded_corrective_action` (2030), like `api.waive_corrective_action` (1940), does not refuse a manager who owns the action.
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
- Whether the Restricted Case Authority names a grievance admissibility decider on a restricted case where no seated decider can view the case. Until a source decides it, nobody is asked (fail closed).
- The two DEC-AMB-013 questions are decided (DEC-AMB-014 and DEC-AMB-015, section 3 items 11 and 12). What they leave open:
  - `CORRECTIVE_ACTION_WAIVE`: still held by no role; a disposition does not need it.
  - `CASE_CLOSURE_APPROVAL_RULE` (AMB-212): until it is configured, a reopening for `DECISIVE_POST_DECISION_CONFLICT` (2060) is refused, so a decisive conflict found after closure stays without a remedy (fail closed, as Fady requires).
- DEC-AMB-013 coordinator defaults, kept as built:
  - a sanction already executed under a superseded decision stays recorded and is not executed again (kept by Fady "for now", 15:48);
  - a grievance already filed on one is left as it is (kept by Fady "for now", 15:48);
  - both show their decision as superseded (`execution_origin` and `contested_decision_relationship`, `SUPERSEDED_DECISION`);
  - a new grievance filed on a decision while its remediation is open is not refused (it protects the subject and executes nothing);
  - a package withdrawn or cancelled while it is being remediated leaves the remediation OPEN, so the case cannot close.
