# ADR-022: Legal review packets

- **Status:** Proposed (2026-10-12). Linear CDF-192. Implemented in migration 1900 (draft, not merged). Security-sensitive (purpose-bound access).
- **Protocol:** §19–§22, §40, §87; owner Q&A Q40, Q73–Q77; ADR-014; ADR-016 DEC-02, DEC-09; ADR-031.

## Decision

1. Legal review is not automatic for every recommendation (Q73); it is required by rule (sanction type, external referral, legal action) or requested by the committee (Q74).
2. The Secretary decides what goes to Legal (Q75): `legal_review_request` + `legal_review_item` rows naming recommendation items, findings, minutes extracts and (after S2 merges) evidence versions. Items are snapshots.
3. The legal reviewer sees only the items of requests assigned to them (`authz.can_view_legal_packet`); no case discovery, no protected identity.
4. Legal may attend a meeting as an invitee, but the formal opinion is a separate packet step (Q76).
5. Opinion CONCURS / CONCURS_WITH_COMMENTS / CONFLICTS. CONFLICTS returns the package to the committee (RETURNED_BY_LEGAL); both recommendation and opinion are preserved and both go to the authority if the committee re-adopts (Q77).

## Implementation notes (migration 1900)

- `decision.legal_review_request` assigns one reviewer holding `LEGAL_OPINION_GIVE` (granted to LEGAL_REVIEWER), cleared for the case and not the requester. Basis RULE when an approved item is a sanction, legal action or external referral (`decision.legal_review_required`; the full rule is SOURCE_REQUIRED), else SECRETARY_ELECTED.
- The request creates an immutable LEGAL_REVIEW packet of the adopted items plus the findings and approved minutes of this proceeding the secretary selects (Q75). The reviewer reads the packet (`api.open_packet`, audited PACKET_VIEWED) and their own request, nothing else of the case.
- CONCURS or CONCURS_WITH_COMMENTS leaves the package ADOPTED; CONFLICTS (with a text) returns it to the committee (Q77). An opinion covers only its round: a revised package needs a new review before it can go to the authority.

- AGENT-09 W2 (DEC-01, DEC-61 pattern): on a restricted case each legal review needs the case's Restricted Case Authority (the case owner) to approve it and name the reviewer (`decision.restricted_legal_review_approval`, single use, audited RESTRICTED_LEGAL_REVIEW_APPROVED); without it `AUTHORITY_APPROVAL_REQUIRED`. **DEC-62 (Approved):** project owner's answer on decision card cmsg_01CvgBgRZnhwQfVHsucbRcQyQk8mcvhFstLH9SgymLXuGY ("Allow legal review on restricted (SECRET) cases?"), option "Authority approval", 2026-10-12 10:52 UTC, as recorded on the card and relayed by the coordinator; the refusal alternative was not chosen. AGENT-09 notes (non-blocking): the approval binds to the package, not the round, so an unused approval survives a return and re-vote; a PENDING meeting member sees packages, accepted because packages can exist before any meeting declaration.
- Reviewer eligibility is re-checked on every read: removing the LEGAL_REVIEWER role, a case conflict or a clearance below the case removes the packet; the opinion is then refused.
- Recorded from AGENT-09's review (no change now): the reviewer keeps the packet after giving the opinion (could become time-bound); packet snapshots carry subject display names and the minutes narrative the secretary selects.

## Requirements

Q40, Q73–Q77; negative test N14.
