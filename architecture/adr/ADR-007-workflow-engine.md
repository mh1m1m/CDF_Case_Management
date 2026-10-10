# ADR-007: Data-driven workflow engine

- **Status:** Accepted (2026-10-07)
- **Protocol:** §31, §32, §33

## Decision
- Tables: `workflow_definition`, `workflow_state`, `workflow_transition_definition` (from/to state, code, required permission, allowed roles, reason required, approval required, required conditions as typed codes, SLA hours, audit action), `workflow_instance` (one per case), `workflow_transition_event` (append-only history).
- Definitions are reference data shipped in migrations; the protocol's 15 baseline states are seeded as `CDF_CASE_V1`.
- Transitions run only through `api.transition_case(case_id, transition_code, reason)`, which checks case access, permission, role, conflict status, reason, and each required condition via `workflow.evaluate_condition(code, case_id)`, then updates the instance, appends a transition event and an audit event atomically.
- `@cdf/workflow` mirrors the definition in TypeScript for UI rendering of available actions and their blocking reasons; a test asserts the TS mirror equals the seeded definition.
- Case status is derived from workflow state (not an independently editable string).

## Consequences
- + Rules are central, data-driven and testable; adding a guard is a migration plus a condition implementation.
- − Required forms/documents conditions arrive with Phases 8 and 12; until then those condition codes are not attached to transitions.

## Production mapping
Unchanged (database-resident definitions). ASP.NET Core would call the same command or reimplement it against the same tables.
