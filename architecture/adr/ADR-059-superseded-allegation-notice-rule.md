# ADR-059: A superseded allegation needs no defence notice at adoption (migration 2092)

- **Status:** Proposed (2026-10-16). Linear CDF-236 (integrity LOW, fail-closed). Implemented in migration 2092, pending security review.
- **Placement and ruling (coordinator, 2026-10-16 05:29):** migration 2092, one PR on the main after 2086, before 2095. "SUPERSEDED allegations are exempt from the requirement exactly as WITHDRAWN ones are, because their successors carry it; successor allegations on the same case still count. Change the command and 2086's package_capabilities mirror in that single migration, tests pin flag == command and cover split-then-adopt, negative test that a live allegation without a notice still refuses."
- **Found by:** governance's pre-check of the 2086 PR (#88) against the 2090 PR (#87), inferred from the code; reproduced by this ADR's tests before the change.
- **Ambiguity rows:** AMB-026 (a sanction waits for its subject's defence notice, 2030); AMB-027 and AMB-004 (2090: a split supersedes an allegation, its successors carry it, nothing new hangs off it).
- **Protocol:** §19, §65, §87.

## Context

`api.record_package_adoption` (2030) applies a check when the proceeding's rule snapshot sets `sanction_requires_defence_notice`. Each subject of an approved disciplinary sanction must have a `DEFENCE` notice item on every allegation that is not `WITHDRAWN`. If the item names allegations, only those count; if it names none, all of the subject's allegations count. The subject must also have at least one `DEFENCE` notice. `decision.package_capabilities` (2086) answers `may_record_adoption` with the same predicate.

Migration 2090 added `SUPERSEDED`. An allegation is superseded when:

- it is split into successors (`api.split_allegation`, on the same case);
- it is moved to a new case (`api.split_case`);
- its subject is corrected (`api.correct_case_subject`).

2090 refuses a notice item on a superseded allegation (`ALLEGATION_SUPERSEDED`). So take a sanction that names no allegation, on a subject whose allegation was superseded before a notice covered it. That sanction could never be adopted: it failed `DEFENCE_NOTICE_REQUIRED` with nothing anyone could do about it, short of withdrawing the item and naming the successors.

## Decision

- **The change.** Both functions leave out a `SUPERSEDED` allegation exactly as they leave out a `WITHDRAWN` one: `a.status not in ('WITHDRAWN', 'SUPERSEDED')`.
- **What still counts.** The successors are live allegations, so they are asked for as any other:
  - on the same subject;
  - on another subject of the case, when they were split onto it;
  - on the new case's subject, after a case split.
- **What still refuses.**
  - An allegation that is neither withdrawn nor superseded still needs its notice.
  - Every subject of the sanction still needs at least one `DEFENCE` notice.
- **The replacements.**
  - `api.record_package_adoption` and `decision.package_capabilities` are replaced in one migration. Both keep the same signature, owner and grants.
  - Each body is its predecessor's (2030, 2086) with the one predicate changed and one comment line added.
  - No table, policy, grant or audit change. Nothing is dropped or renamed (DEC-35).

### Paths the change cannot reach

- **Items that name allegations answer as before.**
  - A named allegation is never superseded: `case_mgmt.allegation_change_block` refuses `ALLEGATION_IN_RECOMMENDATION`.
  - A superseded allegation is never named afterwards: the `recommendation_item_allegation_active` trigger refuses it.
- **A misidentified subject is never sanctioned.** It is never on an item: `decision.guard_item_subject_status` refuses `SUBJECT_MISIDENTIFIED`, and `api.correct_case_subject` refuses `SUBJECT_IN_RECOMMENDATION`. So the exemption never helps a sanction against the wrong person.

### Why not a shared helper

A SQL helper called from both PL/pgSQL bodies would be planned again on every call, the cost CDF-233 records. It would also turn a one-token change into a restructure of a 2030 command. Instead, the tests pin the flag to the command in every state.

## Consequences

- **What is lifted.** A refusal that could never be satisfied is lifted. No read, access or permission changes. The adoption's audit event is unchanged.
- **Why it is not a weakened fail-safe.** The rule it replaces ships in the same migration and is tested there: the successors carry the requirement, and a live allegation without a notice still refuses.
- **Workaround no longer needed.** Before 2092, the only way through was to withdraw the item and name the successors.
- **Rule off.** With the committee's notice rule off, nothing changes.

## Production mapping

Two PL/pgSQL functions in PostgreSQL; they move to RDS PostgreSQL unchanged. No new service.

## Tests

`tests/security/adoption-superseded-2092.spec.ts`. In every state, the secretary's `may_record_adoption` (via `api.committee_items_view`) equals what `api.record_package_adoption` answers, run and rolled back.

- **An allegation split after the vote.**
  - It is refused until both successors have notices; the original takes none (`ALLEGATION_SUPERSEDED`).
  - Then it is adopted.
- **A live allegation without a notice still refuses.** Then it is adopted once that allegation is noticed.
- **A successor split onto another subject** is asked for on that subject's sanction, not on the original's.
- **A case split.** The moved allegation is not asked for on the source's sanction.
- **A subject whose allegations are all superseded or withdrawn** still needs a defence notice.
- **Items that name allegations.** Only the named successor counts, and a named allegation is never split.
- **The rule off.** Unchanged.

Mutation check: restoring the 2030 body of the command, or the 2086 body of the capability, fails four tests each. Existing tests pass unchanged: T-AMB-011 in `recommendations-authority.spec.ts` and 2086's adoption test.

## Requirements

AMB-026, AMB-027, AMB-004; UX-116; ADR-045, ADR-056; CDF-236.
