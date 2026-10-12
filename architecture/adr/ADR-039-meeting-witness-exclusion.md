# ADR-039: Excluding a witness from a committee meeting

- **Status:** Proposed (2026-10-12). Linear CDF-198 (Phase 11, gap P11-G4, witness half), CDF-190. Implemented in migration 2010 (local, pending security review). Amends ADR-020; closes the witness half of gap P11-G4 of ADR-035 (its evidence half stays open).
- **Protocol:** §19, §21, §29, §87, §88; owner Q&A Q38, Q41, Q47, Q49; ADR-019, ADR-020, ADR-035, ADR-038.

## Context

Migration 1890 invites witnesses, experts, legal advisers, information providers and the subject to a committee meeting. Nothing takes an invitee out again; only cancelling the whole meeting exists.

The owner's catalogues name a witness exclusion with a recorded reason: form T3-B2.4-241 «نموذج استبعاد شاهد» (CRM-F118) and status S112 «استبعاد شاهد», with the planned event WITNESS_EXCLUDED. ADR-035 recorded the gap as P11-G4, together with excluding an evidence item. The evidence half needs the UX S2 evidence commands (PR #55), so this record covers witnesses only.

## Decision

1. **The command.**
   - `api.exclude_meeting_witness(participant, reason)` is run by the secretary running the meeting (`committee.lock_managed_meeting`), while the meeting is SCHEDULED or OPEN.
   - It excludes WITNESS invitees only. A member seat, the subject, a legal adviser, an expert or an information provider gives `INVALID participant` (SOURCE_REQUIRED, open question 1).
   - Each witness is excluded once (`ALREADY_EXCLUDED`).
   - A concern about the witness (ADR-038) is decided first (`CONCERN_OPEN`), so no open concern is left on someone no longer in the meeting.
   - Others get FORBIDDEN when they can see the meeting, and NOT_FOUND otherwise.
2. **The record.**
   - The reason (10–2000) goes into the append-only `committee.witness_exclusion`, one row per witness.
   - The secretary running the meeting and the members cleared for its deliberation (`authz.can_view_meeting_deliberation`) can read it. The witness cannot.
   - The ledger records `WITNESS_EXCLUDED` on the exclusion, with the meeting and participant ids only, never the reason.
3. **The witness loses the meeting.**
   - This is a coordinator ruling, SOURCE_REQUIRED, pending the owner (open question 2).
   - `authz.can_view_meeting` is replaced with one change: its participant branch skips a participant who has been excluded. Every other branch, the signature, SECURITY DEFINER and `search_path` are as in 1890.
   - The excluded witness no longer reads the meeting, their participant row (attendance and conflict status) or the exclusion, and no meeting command reaches them (NOT_FOUND).
   - A witness who also sees the meeting another way keeps that view. Other ways are the committee proceeding or the case team; neither is changed here.
   - Narrowing an access predicate is a fail-closed tightening, like the grant narrowing of migration 1950, so the "additive only" rule for Phase 11 commands does not bar it.
4. **The row is final.**
   - The exclusion never changes the participant row, so attendance and conflict history stay as recorded.
   - Afterwards nothing changes it either. A trigger refuses any update of an excluded participant (`WITNESS_EXCLUDED`): attendance, an excuse, a declaration, or the decision on a concern.
   - A second trigger refuses a new concern about an excluded participant.
5. **The catalogue follows (ADR-035).**
   - S112 (both status lists) records `WITNESS_EXCLUDED`, now IMPLEMENTED, on `committee.witness_exclusion`.
   - T3-B2.4-241 names the command.
   - MEETING_WITNESSES lists it and records 2010.
   - P11-G4 stays OPEN for its evidence half (S083, T3-B2.3-112, T3-B2.3-144).

## Consequences

- A meeting can lose a witness without being cancelled, with the reason kept for the committee and the fact in the ledger.
- The witness learns nothing about the meeting after the exclusion. Other witnesses, the members and the case team see it as before.
- Known limitations:
  - The witness is not notified of the exclusion.
  - They still receive the meeting's cancellation notice if it is cancelled later (ADR-025; ids only, and the meeting itself then answers NOT_FOUND).
  - The generated minutes do not list the exclusion; the secretary's narrative carries it.
  - An exclusion cannot be reversed. A witness who should give evidence after all is invited to another meeting.

## Production mapping

One table, two triggers, one function replaced and one command in PostgreSQL. They move to RDS PostgreSQL unchanged. No new service.

## Open questions (SOURCE_REQUIRED)

1. May the subject, or the subject's legal counsel, ever be excluded from a hearing? Built: no (`INVALID`).
2. Should an excluded witness keep seeing the meeting's logistics? Built: no (coordinator ruling). The alternative is to leave `authz.can_view_meeting` unchanged, so the witness keeps the date, mode and place.

## Requirements

Owner Q&A Q38, Q41, Q47, Q49; FORM_CATALOGUE_RATIONALIZATION.md §6 (P11-G4); catalogue items T3-B2.4-241 and CRM-F118, status S112; CDF-198, CDF-190.
