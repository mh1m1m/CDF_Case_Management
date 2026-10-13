# ADR-029: Status catalogue rationalization

- **Status:** Proposed (2026-10-12). Linear CDF-199. Amended by [ADR-035](ADR-035-form-status-catalogue-reference-data.md): `config.legacy_status_map` (migration 1970) holds 305 rows, the Drive 150, the owner's 140-status list and the 15 CDF_CASE_V1 states, and every dimension is grounded in the schema.
- **Protocol:** ADR-007; rebase prompt §status.

## Decision

1. Status is multi-dimensional: case stage (derived), proceeding status, waiting reason, suspension reason, flags, outcomes, legal state, records state; events are audit events, not statuses.
2. All 150 CRM statuses are classified (`CRM_STATUS_RATIONALIZATION.md`): KEEP 68, MERGE 44, REPLACE 17, DUPLICATE 16, RETIRE 5.
3. `config.legacy_status_map` (150 rows) maps each legacy code to target dimension values for BCP import and reporting continuity.
4. CDF_CASE_V1's 15 states map to dimensions; they are not removed.

## Requirements

Rebase prompt §status (the prompt says 140; the Drive catalogue holds 150).
