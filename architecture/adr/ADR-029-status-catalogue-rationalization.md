# ADR-029: Status catalogue rationalization

- **Status:** Proposed (2026-10-12). Linear CDF-199.
- **Protocol:** ADR-007; rebase prompt §status.

## Decision

1. Status is multi-dimensional: case stage (derived), proceeding status, waiting reason, suspension reason, flags, outcomes, legal state, records state; events are audit events, not statuses.
2. All 150 CRM statuses are classified (`CRM_STATUS_RATIONALIZATION.md`): KEEP 68, MERGE 44, REPLACE 17, DUPLICATE 16, RETIRE 5.
3. `config.legacy_status_map` (150 rows) maps each legacy code to target dimension values for BCP import and reporting continuity.
4. CDF_CASE_V1's 15 states map to dimensions; they are not removed.

## Requirements

Rebase prompt §status (the prompt says 140; the Drive catalogue holds 150).
