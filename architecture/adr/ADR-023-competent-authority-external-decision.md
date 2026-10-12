# ADR-023: Competent authority and externally made decisions

- **Status:** Proposed (2026-10-12). Linear CDF-191. Answers CDF-155.
- **Protocol:** §19, §29, §87; owner Q&A Q78–Q85.

## Decision

1. `decision.authority_type` (CEO, BOARD, DELEGATED_EXECUTIVE, OTHER) and `decision.action_authority_rule` (recommendation item type → authority type, effective-dated). DISCIPLINARY_SANCTION → CEO is seeded as OWNER_DEFAULT; nothing hard-codes CEO (Q78, Q84–Q85).
2. The authority may decide outside the platform and need not log in (Q80). The Committee Secretary records the decision (Q81): outcome APPROVE_AS_RECOMMENDED / MODIFY / REJECT / RETURN_TO_COMMITTEE / APPROVE_PARTIALLY / OTHER, per item when partial, decided_at, decided_by_label, and a **source document reference** (Q83).
3. No maker-checker before the decision is effective (Q82). A decision cannot become EFFECTIVE without a source document (check constraint).
4. RETURN_TO_COMMITTEE reopens the committee proceeding; approved items create notices and corrective actions; supersedes the disabled `DECISION` / `CORRECTIVE_ACTION` V1 transitions for new proceedings.
5. Where an authority does use the platform, the same command is available to a user holding the authority role (CDF-159 path).

## Requirements

Q78–Q85; negative test N15.
