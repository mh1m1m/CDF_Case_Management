# ADR-017: Case and Proceeding model, intake paths, direct referral and preliminary review

- **Status:** Proposed (2026-10-12). Linear CDF-186, CDF-187. Decision 5 amended by [ADR-036](ADR-036-preliminary-closure-outcomes.md): the preliminary recommendation also accepts five closure outcomes (migration 1980).
- **Protocol:** §10–§14, §18–§22, §29, §65, §87; owner Q&A Q1–Q20, Q31–Q34, Q88–Q91; ADR-007, ADR-014, ADR-016.

## Context

Today a case can only come from a whistleblowing report (`api.create_case_from_report`), and a case has exactly one workflow instance (CDF_CASE_V1, 15 linear states, everything after INVESTIGATION disabled). The approved business model needs three intake paths, several parallel and sequential proceedings inside one case (preliminary review, committee investigation, legal review, authority decision, corrective action, grievance, reinvestigation), and multi-subject, multi-allegation structure with findings per allegation and subject.

## Decision

1. **The case is the container; proceedings carry the work.** New `case_mgmt.proceeding` (type, parent, status, waiting reason, suspension reason, outcome). Each proceeding may own a workflow instance; the case stage is derived from its open proceedings.
2. **Intake path is explicit.** `case_record.source_type` ∈ WHISTLEBLOWING, DIRECT_REFERRAL, DIRECT_GRIEVANCE, OTHER_AUTHORIZED_SOURCE. Existing rows are backfilled WHISTLEBLOWING. `case_type` stays.
3. **Subjects, allegations, findings.** `case_subject` (category EMPLOYEE / CONTRACTOR / OTHER_AUTHORIZED), `allegation.subject_id` + policy/law references, `finding` per (allegation, subject, proceeding), `evidence_link` (evidence → allegation or finding).
4. **Direct referral (Q1–Q10).** `intake.referral` prepared by a sector member, approved by the sector head or a time-bound, documented, audited delegate (`iam.sector_delegation`), then decided by the Investigation Committee Secretary: ACCEPT (case + committee proceeding created in the same transaction), RETURN_FOR_COMPLETION (structured reasons), REJECT (not final: resubmit or object). Human Capital has no bypass.
5. **Preliminary review (Q11–Q20).** Every whistleblowing case gets a PRELIMINARY_REVIEW proceeding. Preparer: investigator, Compliance Section Manager or GRC Director. Review by the GRC Director unless the Director prepared it (no self-review). Final approval by the GRC Sector Head. Returns carry structured reasons. Routing is a configuration row, not code.
6. **CDF_CASE_V1 keeps running** for existing cases; nothing is re-pathed or dropped.

## Consequences

- Committee, legal, decision and grievance features attach to proceedings rather than to the single case workflow.
- New roles: SECTOR_HEAD, COMPLIANCE_SECTION_MANAGER, GRC_SECTOR_HEAD (reference data).
- Every command writes its audit event (REFERRAL_CREATED, REFERRAL_SECTOR_APPROVED, REFERRAL_ACCEPTED, REFERRAL_RETURNED, REFERRAL_REJECTED, REFERRAL_OBJECTED, PROCEEDING_OPENED, PRELIMINARY_RECOMMENDATION_*).

## Production mapping

Same schema on RDS PostgreSQL; sector structure sourced from the CDF HR system of record (PRODUCTION_SUBSTITUTION_REQUIRED: synthetic sectors in the prototype).

## Requirements

Q1–Q20, Q31–Q34, Q88–Q91; gap map §1–§3.
