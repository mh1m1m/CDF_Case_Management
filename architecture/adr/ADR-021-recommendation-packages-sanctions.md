# ADR-021: Recommendation packages and the sanction catalogue

- **Status:** Proposed (2026-10-12). Linear CDF-191. Implemented in migration 1900 (draft, not merged).
- **Protocol:** §19, §29, §87; owner Q&A Q58, Q64–Q72, Q86–Q90.

## Decision

1. New schema `decision`. `recommendation_package` belongs to a committee proceeding; it holds `recommendation_item`s of type FINDING, DISCIPLINARY_SANCTION, CORRECTIVE_ACTION, GOVERNANCE_REMEDIATION, EXTERNAL_REFERRAL, NO_VIOLATION, CLOSE_WITHOUT_SANCTION, LEGAL_ACTION, OTHER.
2. Scope per item: one or more subjects, one or more allegations, or the whole case (junction tables; check that a case-wide item has no junction rows).
3. One subject may receive several items in one case (Q88); a package may mix sanctions and corrective actions (Q69).
4. Sanctions come from `sanction_catalogue` (seeded synthetic codes WARNING, SALARY_DEDUCTION, SUSPENSION, DEMOTION, TERMINATION with `legal_basis` null and SOURCE_REQUIRED). A free-text sanction is stored with `verification_status = PROPOSED_UNVERIFIED` and is flagged in every view and export (Q87).
5. Package status DRAFT → VOTING → ADOPTED → IN_LEGAL_REVIEW → AWAITING_AUTHORITY → DECIDED, with RETURNED loops. Every adopted package is voted (Q58), at package or item granularity (Q70).
6. The Investigation Committee recommends; it does not impose sanctions (Q71).

## Implementation notes (migration 1900)

- Schema `decision`. `recommendation_package` (DRAFT → VOTING → ADOPTED → IN_LEGAL_REVIEW → AWAITING_AUTHORITY → DECIDED; returns to RETURNED_BY_LEGAL or RETURNED_BY_AUTHORITY, then a new round) and `recommendation_item` (types FINDING, DISCIPLINARY_SANCTION, CORRECTIVE_ACTION, GOVERNANCE_REMEDIATION, EXTERNAL_REFERRAL, NO_VIOLATION, CLOSE_WITHOUT_SANCTION, LEGAL_ACTION, OTHER).
- Only the committee's seated secretary, cleared for the case, prepares a package, and only for an Investigation Committee proceeding (grievance outcomes are phase 7). Members and the case team read it.
- Adoption only by committee vote: `api.open_package_vote` opens one PACKAGE item or one item per recommendation (`vote_granularity`), bound by `committee.vote_item.package_id` / `recommendation_item_id` / `package_round`. `api.record_package_adoption` reads the closed votes; nothing approved returns the package to DRAFT. Generic vote items are FINDING or OTHER only.
- A sanction is a catalogue code (`decision.sanction_catalogue`, synthetic seed, legal basis SOURCE_REQUIRED) or a free-text proposal flagged `PROPOSED_UNVERIFIED` (Q87); a check constraint and the immutability trigger keep the flag. A sanction names at least one subject; an item with no subject and no allegation is case-wide (Q88–Q90).

## Requirements

Q58, Q64–Q72, Q86–Q90.
