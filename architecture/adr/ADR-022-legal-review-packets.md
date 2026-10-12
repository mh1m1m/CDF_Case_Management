# ADR-022: Legal review packets

- **Status:** Proposed (2026-10-12). Linear CDF-192. Security-sensitive (purpose-bound access).
- **Protocol:** §19–§22, §40, §87; owner Q&A Q40, Q73–Q77; ADR-014; ADR-016 DEC-02, DEC-09; ADR-031.

## Decision

1. Legal review is not automatic for every recommendation (Q73); it is required by rule (sanction type, external referral, legal action) or requested by the committee (Q74).
2. The Secretary decides what goes to Legal (Q75): `legal_review_request` + `legal_review_item` rows naming recommendation items, findings, minutes extracts and (after S2 merges) evidence versions. Items are snapshots.
3. The legal reviewer sees only the items of requests assigned to them (`authz.can_view_legal_packet`); no case discovery, no protected identity.
4. Legal may attend a meeting as an invitee, but the formal opinion is a separate packet step (Q76).
5. Opinion CONCURS / CONCURS_WITH_COMMENTS / CONFLICTS. CONFLICTS returns the package to the committee (RETURNED_BY_LEGAL); both recommendation and opinion are preserved and both go to the authority if the committee re-adopts (Q77).

## Requirements

Q40, Q73–Q77; negative test N14.
