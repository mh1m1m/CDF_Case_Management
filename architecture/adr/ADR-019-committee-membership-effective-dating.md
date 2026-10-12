# ADR-019: Committee membership, seats and effective dating

- **Status:** Proposed (2026-10-12). Linear CDF-188.
- **Protocol:** §18–§21, §87; owner Q&A Q22–Q30, Q51–Q54, Q94, Q98.

## Decision

1. Seats: CHAIR, DEPUTY_CHAIR, SECRETARY, ALTERNATE_SECRETARY, MEMBER, ALTERNATE_MEMBER. `committee.membership` rows carry `effective_from` / `effective_to` (half-open, `tstzrange`).
2. Constraints: a user has at most one seat per committee at any instant (exclusion constraint); CHAIR, DEPUTY_CHAIR, SECRETARY and ALTERNATE_SECRETARY are single-holder per instant (exclusion constraint per seat). The same person may sit on both committees only through explicit rows (Q23).
3. **Rule sets** are effective-dated per committee (`committee.rule_set`, non-overlapping): quorum type (MAJORITY_ELIGIBLE / FIXED_NUMBER / PERCENTAGE / CUSTOM) and value, casting vote enabled, minutes review business days (3), deemed approval enabled, grievance window days (30), admissibility decider (SECRETARY / CHAIR / COMMITTEE). Each row has `source_status` OWNER_DEFAULT / SOURCE_REQUIRED / APPROVED.
4. **Delegation** (`committee.delegation`): bounded window, reason, appointing reference; an alternate secretary acts automatically only while recorded as acting.
5. Membership changes never rewrite history; they end a row and start another. Notifications go to affected members (ADR-025).

## Consequences

`authz.committee_seat(committee, at)` answers "which seat now"; proceedings use their snapshot instead. Superseded settings `COMMITTEE_QUORUM` is kept read-only and marked deprecated.

## Requirements

Q22–Q30, Q51–Q54.
