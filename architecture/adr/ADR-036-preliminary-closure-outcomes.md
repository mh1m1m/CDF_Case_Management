# ADR-036: Closure outcomes of the preliminary review

- **Status:** Proposed (2026-10-12). Linear CDF-198 (Phase 11, gap P11-G1), CDF-190. Implemented in migration 1980 (local, pending security review). Amends ADR-017 decision 5 and closes gap P11-G1 of ADR-035.
- **Protocol:** §19, §29, §87, §88; owner Q&A Q11–Q20; ADR-017, ADR-029, ADR-035.

## Context

Migration 1880 lets a preliminary recommendation carry seven outcomes: NO_ACTION, OUT_OF_SCOPE, DUPLICATE, TRANSFERRED, NON_PROCESSABLE, INVESTIGATION_WARRANTED and REFERRED_TO_COMMITTEE. The owner's CRM catalogues route five more closures through the preliminary review: not serious, not substantiated, channel abuse, investigation not feasible and no personal jurisdiction (statuses S007, S045, S055, S103, S114, S134; forms CRM-F004, F017, F109, F120, F146, F147 and nine source D controls). All five are already OUTCOME_CODE values (migration 1870), but the recommendation's check refused them (ADR-035, gap P11-G1). Q12 says the preliminary review exists "to verify the report initially, assess completeness and seriousness, gather preliminary evidence, identify whether the report may be malicious or insufficient, and determine whether escalation is appropriate".

## Decision

1. **The preliminary recommendation accepts the five closures.** Its outcome check is widened to twelve values. The check is dropped and re-added under the same name, as migrations 1930–1960 did for notification object types. `api.prepare_preliminary_recommendation` accepts the same twelve. Nothing else in the command changes: the same permission, case access, case and proceeding state checks, versioning and audit event.
2. **Each closure records where it comes from.** NOT_SERIOUS ("assess ... seriousness"), CHANNEL_ABUSE ("whether the report may be malicious") and NOT_SUBSTANTIATED ("verify the report initially") trace to Q12 and are OWNER_DEFAULT. NOT_FEASIBLE and NO_PERSONAL_JURISDICTION appear only in the owner's catalogues, not in the Q&A. They are accepted and marked SOURCE_REQUIRED on the PRELIMINARY_OUTCOME values in `config.status_dimension_value`. If the owner withdraws one, it is deactivated, never deleted.
3. **The path does not change (Q13–Q19).** A closure is prepared, reviewed by the GRC Director unless the Director prepared it, and approved by the GRC Sector Head. The three people differ. The GRC Sector Head's purpose-bound view is unchanged, including the fail-safe on restricted cases.
4. **Approval concludes the review, not the case.** As in 1880, approval concludes the PRELIMINARY_REVIEW proceeding with the recommended outcome. Closing the case is still the CDF_CASE_V1 path; a single close command is gap P11-G2.
5. **The catalogue follows the schema.** The five values are added to PRELIMINARY_OUTCOME. The P11-G1 references on the legacy status and form rows are cleared and their notes updated. The close-outcome module records 1980 among its delivering migrations. The gap register marks P11-G1 closed.

## Consequences

- Every closure the catalogues name for the preliminary stage can now be recommended, approved and audited. Each one leaves the same record: one recommendation version, its review and approval, and the proceeding's outcome code.
- `PRELIMINARY_OUTCOMES` in `@cdf/contracts` is checked against the database constraint (mirror test).
- Two closures run on an owner default without an owner answer. Reporting shows them as SOURCE_REQUIRED until the owner confirms or withdraws them.

## Production mapping

A check constraint and a function in PostgreSQL. They move to RDS PostgreSQL unchanged.

## Open questions (SOURCE_REQUIRED)

1. Should a preliminary review be able to close a report as not feasible, or for want of personal jurisdiction? Both are accepted today on the strength of the owner's catalogues.

## Requirements

Owner Q&A Q11–Q20 (Q12 above all); rebase prompt §preliminary review; FORM_CATALOGUE_RATIONALIZATION.md §6 (P11-G1); CDF-198, CDF-190.
