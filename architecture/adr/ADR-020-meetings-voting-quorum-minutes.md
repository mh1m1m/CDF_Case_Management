# ADR-020: Meetings, conflict of interest, quorum, voting and minutes

- **Status:** Proposed (2026-10-12). Linear CDF-190. Implemented in migration 1890 (draft, not merged). Security-sensitive: AGENT-09 review before the implementing PR leaves draft. Amended by [ADR-038](ADR-038-meeting-excuses-raised-conflicts.md) (migration 2000): attendance may be EXCUSED with a reason, and a conflict raised by another participant holds the meeting's votes until it is decided.
- **Protocol:** §18–§21, §29, §39, §68, §87; owner Q&A Q35–Q36, Q41–Q70, Q97–Q98.

## Decision

### Meetings

- `committee.meeting`: mode IN_PERSON / TEAMS / HYBRID, purpose DELIBERATION / HEARING, status SCHEDULED → OPEN → CLOSED → MINUTES_*. Every referred case has ≥1 meeting before a recommendation is adopted; several are allowed.
- Online meetings go through a `MeetingProvider` port: `ManualMeetingProvider` (secretary pastes a URL) now; `M365TeamsMeetingProvider` is PRODUCTION_SUBSTITUTION_REQUIRED.
- Invitees (WITNESS, EXPERT, LEGAL, INFORMATION_PROVIDER, SUBJECT) carry `requires_coi` (Q48).

### Conflict of interest

- Per meeting, per member: PENDING / NO_CONFLICT / CONFLICT_DECLARED (`committee.meeting_conflict`). A meeting opens with every eligible member at PENDING.
- A member who is PENDING or CONFLICT_DECLARED cannot be recorded PRESENT, cannot vote and is excluded from quorum. Enforced in commands and `authz.can_participate_meeting`, never only in the UI (Q47). Membership and conflict are separate facts (Q50). All changes audited (Q49).

### Quorum

- Eligible = proceeding-snapshot voting members with NO_CONFLICT for the meeting. Present = eligible and PRESENT. Threshold from the rule snapshot: MAJORITY_ELIGIBLE ⇒ present > eligible / 2; FIXED_NUMBER; PERCENTAGE; CUSTOM ⇒ requires secretary attestation and is flagged.

### Voting

- `vote_item` targets FINDING / RECOMMENDATION_ITEM / SANCTION / CORRECTIVE_ACTION / PACKAGE / FINAL_PACKAGE (Q64–Q70).
- Choices APPROVE / REJECT / ABSTAIN / RECUSED / ABSENT / UNABLE_TO_VOTE. Each vote stores recorded_for, recorded_by, reason, source, original_event_at, recorded_at.
- The secretary may record only ABSENT, UNABLE_TO_VOTE or RECUSED for another member (check constraint + command). Members cast their own substantive votes.
- The chair votes normally; on a tie, if the rule enables it, the chair's **casting vote** is a separate row (`committee.casting_vote`).
- Secrecy: no SELECT grant or policy on `vote`. `api.vote_item_status` returns who voted and when while OPEN; choices and totals only after CLOSED.
- Close requires quorum; result APPROVED / REJECTED / TIED / NO_DECISION / NO_QUORUM.

### Minutes

- Generated snapshot (attendance, conflicts, votes, decisions) + secretary narrative. Reviewed by attending non-conflicted members. Default window 3 business days; after expiry and notification, `api.apply_minutes_deemed_approval` marks DEEMED_APPROVED (idempotent; invoked by scheduler port, PRODUCTION_SUBSTITUTION_REQUIRED).

## Implementation notes (migration 1890)

- Conflict status lives on `committee.meeting_participant` (current) with append-only history in `committee.meeting_conflict`; reasons are visible only to the declarer and the secretary. A declared conflict cannot be withdrawn.
- Members are copied in at scheduling from the proceeding snapshot, leaving out grievance-firewalled and case-gate-excluded seats (ADR-018 points 6–7). Every participation check also passes `authz.user_case_gate`.
- Predicates: `authz.can_view_meeting` (logistics), `authz.can_view_meeting_deliberation` (vote items, minutes in review), `authz.can_manage_meeting` (the secretary). Approved minutes are visible to the case team.
- Close needs every present eligible member's vote row; votes of anyone not present-and-eligible at close are excluded and counted. Decision rule: simple majority of APPROVE over REJECT among counted votes (SOURCE_REQUIRED). A tie awaits the casting vote only when the rule enables it and the chair is present and eligible.
- AGENT-09 review of 1890 (V1–V5): attendance is frozen while any vote item of the meeting is undecided (`VOTE_IN_PROGRESS`); the secretary records ABSENT / UNABLE_TO_VOTE / RECUSED only for a member who is not present (`MEMBER_PRESENT`); the chair breaks a tie only with a counted, non-recused vote of their own on the item; a member sees the deliberation only after declaring NO_CONFLICT (PENDING is fail safe); an invitee outside the proceeding sees only their own participant row (`authz.can_view_meeting_roster`).
- When nobody votes APPROVE or REJECT the item closes as `NO_DECISION` (or `TIED`, per the rule set's `no_substantive_vote_outcome`, SOURCE_REQUIRED); the chair never decides it alone.
- Conflict declarations are per meeting (Q41). A member who declared a conflict in an earlier meeting of the same proceeding cannot declare NO_CONFLICT in a later one (`PRIOR_CONFLICT_DECLARED`). A meeting declaration is not written to the case's `conflict_check`: removing all case access stays the case team's decision.
- Recorded from AGENT-09's clearance (procedural, no change): a member arriving while an item is open is marked PRESENT only after that item closes; a chair who abstained may still give the casting vote (usual rule, SOURCE_REQUIRED).
- Minutes snapshots hold attendance, conflict statuses and results, never individual choices. With no eligible reviewer the minutes are final at once. Deemed approval needs the window to have passed and a recorded reminder (`api.record_minutes_reminder`).

## Consequences

Audit events: MEETING_SCHEDULED, MEETING_OPENED, COI_DECLARED, ATTENDANCE_RECORDED, VOTE_CAST, VOTE_RECORDED_FOR_MEMBER, CASTING_VOTE_CAST, VOTE_CLOSED, MINUTES_GENERATED, MINUTES_REVIEWED, MINUTES_DEEMED_APPROVED. Business-day calendar SOURCE_REQUIRED.

## Requirements

Q35–Q36, Q41–Q70, Q97–Q98; negative tests N4–N8.
