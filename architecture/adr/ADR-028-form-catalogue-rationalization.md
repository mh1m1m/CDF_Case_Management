# ADR-028: Form catalogue rationalization

- **Status:** Proposed (2026-10-12). Linear CDF-198. Amended by [ADR-035](ADR-035-form-status-catalogue-reference-data.md): all three sources, 462 rows including the 274-item catalogue, are rationalized and held in `config.legacy_form_map` (migration 1970).
- **Protocol:** §42, §45; ADR-011.

## Decision

1. CRM forms are not rebuilt one-to-one. Each is classified as WORKFLOW_DECISION, GUIDED_TASK, APPROVAL_ACTION, MEETING_MODULE, EVIDENCE_ACTION, NOTIFICATION, GENERATED_DOCUMENT, GENERATED_RECORD, USER_FORM, CHECKLIST, SYSTEM_EVENT or RETIRED and assigned to a target module (`FORM_CATALOGUE_RATIONALIZATION.md`).
2. Only USER_FORM items become forms-engine definitions (ADR-011). Decisions and approvals become commands with a decision panel; meetings become the meeting module; documents are generated from data.
3. 188 items are rationalized (169 CRM + 19 WB-FRM). The 274-item catalogue (12 tracks) was supplied by the owner on 2026-10-12. Its allowed statuses are mapped per form, and its dispositions are rationalized with the same rules in Phase 11. Of the 188 rows, 4 are USER_FORM, covering 2 distinct user-entered forms: the portal report and the grievance submission.

## Requirements

Rebase prompt §forms; playbook form catalogue.
