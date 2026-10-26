# ADR-064: A seat or position ended in the past carries its reference, and the seat and position flags

- **Status:** Proposed (2026-10-19). Linear CDF-269, under CDF-266. Migration
  `20261007002128_seat_and_position_end_references.sql`, number and ADR allocated by the project coordinator
  (2026-10-19 01:30). UX redesign Phase 12, step P12-8 (slice P12-8b). It merges on the main that carries 2127
  (ADR-063), after it and before 2130.
- **Protocol:** §18 (RLS), §19 (authorization twice), §20 (security tests for an authorization change), §29 (audit),
  §87; ADR-016 D0; ADR-063; UX-116.

## Context

ADR-063 (2127) gave each Administration page a capability read, and held the seat, head and position forms back for
two reasons:

- **F7:** whether a seat or a position may be appointed or ended with a date in the past was a question for the owner.
- **F5:** the seat and head appointment forms wait, whatever DEC-12's scope is (coordinator ruling, 2026-10-18 12:27).

The owner answered F7 on 2026-10-19 at 01:22 UTC, choosing option B, "Backdated with record":

> A past effective date is allowed only with a decree or source reference recorded on the row and an audit event (ids
> only), fail-closed otherwise.

The commands as built stood like this against that decision:

1. **Appointments already met it.** `api.appoint_committee_member` (1870) and `api.appoint_sector_member` (1880, 2127)
   record the appointment's reference on the row (`appointment_reference`, required, 3 to 200 characters), whatever
   the start date. Their audit events name the row with ids and codes, never the reference or a reason.
2. **Ends did not.** `api.end_committee_membership` (1870) and `api.end_sector_membership` (1880) accepted an end
   dated in the past (after the start, and not after the end already set) with a reason only. Nothing recorded the
   decree or source behind it.
3. **No flag.** No read said whether a committee or a sector would accept an appointment from the caller, or whether
   a seat or a position could be ended, so no page could offer either.

The coordinator allocated migration 2128 and this ADR (2026-10-19 01:30) for an `end_reference` on both tables,
protected once set; the two end commands taking it as a new last argument, with the old signatures dropped, and
refusing a past end without it, fail-closed; `may_appoint` per committee and per sector and `may_end` per seat and per
position, each flag its command's answer; audit events with ids only. The same note kept F5: the owner's F7 tap
answered the date question only, so the appointment forms stay held while the owner's F5 card ("Ship the seat and
head appointment forms before migration 2160, under dual control?", 2026-10-19 01:31) is open. Ending a seat or a
position is a revocation, which DEC-12 never delays.

## Decision

### 1. The end's reference, on the row

`committee.membership` and `iam.sector_membership` each gain `end_reference text`: null, or 3 to 200 characters. It is
the decree or source reference of the end.

- **Only with an end.** A check keeps it off a row that is not ended:
  `end_reference is null or ended_at is not null`.
- **A past end carries it.** A check refuses a row ended with an end before the moment it was ended, unless it has
  its reference (`ended_at is null or effective_to >= ended_at or end_reference is not null`). It is added
  `NOT VALID`, as 2030 did for `meeting_conflict`: a row ended before this migration is history and is never
  rewritten, and every end written from now on is checked, by the command and by the table.
- **Never changed.** The tables' triggers (`committee.protect_registry`, `iam.protect_sector_registry`) already
  refuse any change to an ended row. They now let `end_reference` through only on the update that ends the row,
  beside the end, its reason, its author and its time. Every other branch of both triggers is as built, which a test
  pins against the 1870 and 1880 sources.

### 2. The end commands: a past end only with its reference

`api.end_committee_membership(p_membership_id, p_effective_to, p_reason, p_end_reference)` and
`api.end_sector_membership(p_membership_id, p_effective_to, p_reason, p_end_reference)`:

- The reference is the new last argument, default null, so an end now or later needs none. The old signatures are
  dropped, so no overload without the check remains.
- An end before `now()` is refused without a reference of 3 to 200 characters, after trimming
  (`CDF_INVALID:end_reference`). Nothing is written.
- The reference is asked last. The caller check, the row, an end already recorded, the date and the reason are
  answered first, in the order built, so the refusal tells nothing those checks would not.
- A reference given with an end now or later is checked the same way and recorded.
- Everything else is as built: the owner, the grant, the lock, the notification and the audit event. The event names
  the row and carries ids, the seat or position and the new end in its metadata, never the reference. The reason
  stays in the event's own reason field, as before.
- A sector position's end with no date still means now.

### 3. The seat and position flags

Each flag runs its command's checks, in the command's order, without taking a lock and without writing (coordinator,
2026-10-14 11:53, as for 2127). Every flag is a boolean, never null, and every list is a list.

| Read                               | Added                                                                                         | Commands it answers for                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `api.admin_committee_capabilities` | per committee: `may_appoint`, and `seats`, each with `membership_id` and `may_end`            | `appoint_committee_member`, `end_committee_membership` |
| `api.admin_sector_capabilities`    | `sectors`, each with `sector_id`, `may_appoint`, and `positions` (`membership_id`, `may_end`) | `appoint_sector_member`, `end_sector_membership`       |

- **An appointment:** the caller check, then the committee or sector (it exists). The seat or position, the person
  (active, not external, never the caller), the dates (`MEMBERSHIP_OVERLAP`, `SEAT_OCCUPIED`,
  `SECTOR_HEAD_OCCUPIED`) and the reference are inputs.
- **An end:** the caller check, then the row, then not ended (`MEMBERSHIP_ENDED`, `MEMBERSHIP_ALREADY_ENDED`). The
  date, the reason and the reference are inputs. A seat whose term has run out may still be ended earlier, in the
  past, with its reference, so its flag stays true until it is ended.
- Each list names every row of its register, in the register's order: committees and sectors by code, seats and
  positions by start. The registers themselves stay row-level-security reads in the caller's context (ADR-063, F2).

Both reads keep their signature, owner and grant, and stay `SECURITY DEFINER` with `search_path = ''` and `stable`.

### 4. What a flag tells

A flag tells nothing its command would not answer, and only to the holder of the page's permission. That holder
already sees every row the read names under row-level security: the seats to COMMITTEE_ADMIN (and a committee's own
members, 1870), the positions to SECTOR_ADMIN (1880). The reads carry ids and booleans only.

### 5. Not in this change

- **The pages.** The end forms ("End a seat", "End a position") join the P12-8b pages PR, with no migration: a past
  date asks for the decree or source reference, as the command does.
- **The appointment forms** wait for the owner's F5 card, which covers every one of them: seat, head and member (the
  coordinator's ruling of 2026-10-19 02:10). No page reads `may_appoint` until it is answered.
- Deactivation and annotation (F9), the 2160 panels (P12-8c), the continuity-operator registry (F10) and user and
  role administration (P12-10), as in ADR-063.

## Consequences

- A seat or a position ended with a date in the past always says which decree or source made it so, on the row,
  for whoever may read the register, and that reference never changes. The ledger records that the end happened,
  by whom, for which row and to which date, and never the reference text.
- The application calls neither end command yet. Tests and fixtures that end a seat in the past pass a synthetic
  reference: `tests/support/committee.ts` (the demo seats' end) and `my-committees-and-meeting-logistics.spec.ts`.
  Every other caller ends now or later and is unchanged.
- The committees and sectors pages can offer an end exactly where the command would accept it, and an appointment
  once the owner allows the form.

## Where access is enforced, audit and tests

- **Enforced:** in the database. The commands refuse a past end without its reference; the tables refuse it too,
  with the reference's place and permanence, even to their owner.
- **Audit:** each end records its command's own event, unchanged, with ids and codes only. A refusal writes nothing,
  as before. The reads write nothing.
- **Tests:** `tests/security/seat-and-position-ends-2128.spec.ts` (12 tests).
  - **A past end.** For a seat and for a position: no reference, null, empty, blank, two characters and 201
    characters are each refused, an end one microsecond before now included, and nothing is written. With the
    reference, the row keeps it (trimmed), the end is dated as asked and recorded now, and the one audit event names
    the row with exactly its built metadata and no trace of the reference.
  - **An end now or later** needs no reference; one given is checked and recorded. No date on a position means now.
  - **The order of the checks.** The caller, an unknown row, an end already recorded, a date before the start and a
    short reason are each answered before the reference, for each administrator, a committee administrator who is
    not a sector administrator, someone who is neither, and a user who is not active.
  - **The table.** The owner can neither set the reference on a row that is not ended, change or clear it on an ended
    one, end a row in the past without it, give it two characters, nor insert a row already ended in the past
    without it. Ending with the reference, as the commands do, is allowed.
  - **The triggers** are the 1870 and 1880 functions, comments and spacing aside, with `end_reference` added to the
    two lists of the membership branch and nothing else.
  - **Appointments** dated in the past are refused without their reference and record it on the row; their audit
    events carry neither the reference nor a reason, as built.
  - **Each flag against its command.** For every seed user, `may_appoint` per committee and per sector and `may_end`
    per seat and per position equal the commands' answers (run and rolled back), for seats and positions in force,
    scheduled, lapsed and ended, and a sector with no position. Everyone who is not an administrator is refused the
    read as the commands refuse them. A user holding COMMITTEE_ADMIN or SECTOR_ADMIN alone gets exactly that page's
    flags. Reading and probing write nothing.
  - **The functions.** Each end command has one signature, the reference last; each appointment command keeps its
    own; all four are executable by `authenticated` only. The two reads take no lock, run no command and open no
    subtransaction.

  Guards: `api-idor.spec.ts` and `audit-bypass.spec.ts` list both end commands by name, unchanged; the policy
  snapshot records the two new signatures.

## Production mapping

Platform-independent SQL; it moves unchanged to RDS PostgreSQL. Administrators and their permissions come from the
CDF corporate IdP in production (PRODUCTION_SUBSTITUTION_REQUIRED, CDF-35).

## Requirements

- The owner's decision on the P12-8 F7 card (2026-10-19 01:22 UTC, option B).
- The coordinator's allocation of 2026-10-19 (01:30), and the ruling of 2026-10-18 (12:27) on F5.
- DEC-12 (dual control on grants that widen access; revocation is never delayed).
- ADR-016 D0; ADR-063; UX-116; Phase 12 plan §4 (P12-8).
- Linear CDF-269, under CDF-266. Requirement CDF-UX-029.
