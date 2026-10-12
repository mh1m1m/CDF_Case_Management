# ADR-021: Recommendation packages and the sanction catalogue

- **Status:** Proposed (2026-10-12). Linear CDF-191.
- **Protocol:** §19, §29, §87; owner Q&A Q58, Q64–Q72, Q86–Q90.

## Decision

1. New schema `decision`. `recommendation_package` belongs to a committee proceeding; it holds `recommendation_item`s of type FINDING, DISCIPLINARY_SANCTION, CORRECTIVE_ACTION, GOVERNANCE_REMEDIATION, EXTERNAL_REFERRAL, NO_VIOLATION, CLOSE_WITHOUT_SANCTION, LEGAL_ACTION, OTHER.
2. Scope per item: one or more subjects, one or more allegations, or the whole case (junction tables; check that a case-wide item has no junction rows).
3. One subject may receive several items in one case (Q88); a package may mix sanctions and corrective actions (Q69).
4. Sanctions come from `sanction_catalogue` (seeded synthetic codes WARNING, SALARY_DEDUCTION, SUSPENSION, DEMOTION, TERMINATION with `legal_basis` null and SOURCE_REQUIRED). A free-text sanction is stored with `verification_status = PROPOSED_UNVERIFIED` and is flagged in every view and export (Q87).
5. Package status DRAFT → VOTING → ADOPTED → IN_LEGAL_REVIEW → AWAITING_AUTHORITY → DECIDED, with RETURNED loops. Every adopted package is voted (Q58), at package or item granularity (Q70).
6. The Investigation Committee recommends; it does not impose sanctions (Q71).

## Requirements

Q58, Q64–Q72, Q86–Q90.
