# ADR-038: Excused attendance and conflicts raised by another participant of a committee meeting

- **Status:** Proposed (2026-10-12). Linear CDF-198 (Phase 11, gap P11-G6), CDF-190. Implemented in migration 2000 (local, pending security review). Amends ADR-020 and closes gap P11-G6 of ADR-035; opens gap P11-G7.
- **Protocol:** §19–§21, §29, §87, §88; owner Q&A Q41–Q44, Q47, Q49, Q50, Q51; DEC-30 (coordinator ruling: who decides a recusal is rule-set configuration, SOURCE_REQUIRED); ADR-019, ADR-020, ADR-035.

## Context

Migration 1890 records a meeting participant's attendance as PRESENT, ABSENT or EXCUSED_CONFLICT. Only the participant declares a conflict, or the secretary does it for an invitee without an account. The owner's catalogues name two more things:

- A party's justified excuse for not attending (T7-B1.2-048). CRM-F049 records an absence "without an acceptable excuse" and CRM-F050 an accepted, documented excuse, so the two must be told apart.
- A suspected conflict that any party flags, "so it is assessed before work continues" (T3-B1.2-050).

Q49 asks that the declaration, the decision, the recusal and the resulting restrictions be auditable. Q47 asks that conflict rules be enforced in the database. Nobody could record an excused absence or raise another participant's conflict (ADR-035, gap P11-G6).

## Decision

1. **Excused attendance.**
   - Attendance gains EXCUSED, recorded only by `api.record_excused_absence(participant, reason)`.
   - It follows `api.record_attendance`'s rules: the secretary running the meeting, the meeting OPEN, no vote in progress.
   - The reason goes into the append-only `committee.attendance_excuse`. Only the secretary running the meeting and the participant can read it.
   - An excused participant is not present, so quorum and votes count them as absent (Q51 unchanged).
   - A declared conflict is never an excuse: it stays EXCUSED_CONFLICT (`CONFLICT_DECLARED`). If an excused participant later declares a conflict, they become EXCUSED_CONFLICT, as in 1890.
2. **A conflict raised by another participant.**
   - `api.raise_meeting_conflict(participant, reason)` records a concern in `committee.meeting_conflict_concern`.
   - Who may raise: the secretary running the meeting, or a member of it who has declared no conflict and is cleared for the case.
   - What it may concern: another participant who must declare. One's own conflict is declared, never raised (`OWN_CONFLICT`).
   - There is one open concern per participant at a time, and none about a conflict already declared.
   - The meeting must be SCHEDULED or OPEN, and the case ACTIVE.
3. **Work waits.**
   - While a concern is open and its subject has not declared a conflict, no vote item opens in the meeting (`CONFLICT_CONCERN_OPEN`). The rule is a trigger on `committee.vote_item`, so it covers the plain vote, the package vote and the grievance vote alike.
   - A concern is never raised or decided while a vote is in progress (`VOTE_IN_PROGRESS`). It therefore never changes whose votes count mid-vote, the rule 1890 applies to attendance (AGENT-09 V1a).
   - The meeting may still close. A concern left open simply means nothing was voted after it was raised.
4. **The decision.** `api.decide_meeting_conflict(concern, UPHELD | DISMISSED, reason)`, once.
   - UPHELD makes the subject CONFLICT_DECLARED for the meeting, written to `committee.meeting_conflict` as a declaration with source DECISION. Every 1890 rule then follows: not present, no vote, no quorum. As in 1890, the subject cannot declare NO_CONFLICT in a later meeting of the same proceeding.
   - If the subject has already declared the conflict, UPHELD adds nothing.
   - DISMISSED changes nothing.
5. **Who decides (DEC-30).**
   - The decider is rule-set configuration: `committee.rule_set.conflict_decider`, copied into each new proceeding's rule snapshot. A snapshot taken earlier reads as CHAIR.
   - CHAIR, the default: the chair of the meeting, once they have declared no conflict. The deputy chair decides only when the chair raised the concern or is its subject.
   - SECRETARY: a secretary running the meeting.
   - The raiser and the subject never decide, and every decider must be cleared for the case.
   - When nobody in the meeting holds the role, nobody decides (fail closed). The votes then wait until the subject declares the conflict, or the meeting closes and another is scheduled.
   - Every rule set takes CHAIR. No command sets the decider yet; one comes with the owner's answer.
6. **Who reads what.**
   - Concerns, with their reasons: the raiser, the secretary running the meeting and the decider, each only while cleared for the case. The subject and the other members do not. The subject learns the outcome through their conflict status.
   - The ledger records `ATTENDANCE_RECORDED` (with `to` EXCUSED and the excuse id), `MEETING_CONFLICT_RAISED`, `MEETING_CONFLICT_DECIDED` and, when upheld, `COI_DECLARED` with source DECISION. Each carries ids and codes only, never a reason.
7. **The catalogue follows (ADR-035).**
   - T7-B1.2-048 names `api.record_excused_absence`.
   - T3-B1.2-050 names the meeting path. Its case-level half is gap P11-G7.
   - The MEETING, MEETING_HEARING and MEETING_COI modules list the new commands and record 2000.
   - The gap register marks P11-G6 closed.

## Consequences

- An absence with an accepted excuse and one without are told apart. The excuse is kept without exposing a personal reason to the committee or the ledger.
- Raising a conflict cannot change a vote in progress. Whoever raises a concern can still stop the meeting's votes until it is decided. That is the intended effect, "assessed before work continues", and it is audited with the raiser's identity.
- Known limitations:
  - A member records an excuse through the secretary; there is no self-service excuse.
  - The proof of an excuse is registered as evidence, not attached to the excuse.
  - An invitee cannot raise a concern.
  - A concern left open when the meeting closes stays open on record.

## Production mapping

Two tables, a column, constraints, a trigger and functions in PostgreSQL; they move to RDS PostgreSQL unchanged. No new service.

## Open questions (SOURCE_REQUIRED)

1. Who decides a conflict raised by another participant: the chair (the default here), the secretary, or the committee? This is configured per rule set, and no command sets it until the owner answers.
2. Is the subject of a raised conflict told of it, and heard, before the decision? Here the subject does not read the concern.
3. On the case itself (gap P11-G7), may someone raise another person's conflict, and does an upheld one suspend that person's case access? This is an access-model decision, so it is not built.

## Requirements

Owner Q&A Q41–Q44, Q47, Q49, Q50, Q51; DEC-30; FORM_CATALOGUE_RATIONALIZATION.md §6 (P11-G6, P11-G7); catalogue items T7-B1.2-048 and T3-B1.2-050, CRM-F049 and CRM-F050; CDF-198, CDF-190.
