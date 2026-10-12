# Business Architecture Rebase

> SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Not CDF production, not regulatory certification, not final HR or legal conformance. Linear project: CDF Business Architecture Rebase (CDF-186 … CDF-202).

| Document                                                               | Purpose                                                                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [BUSINESS_ARCHITECTURE_GAP_MAP.md](BUSINESS_ARCHITECTURE_GAP_MAP.md)   | Current → target, classified KEEP … SOURCE_REQUIRED (playbook name: `CURRENT_TO_TARGET_GAP_MAP.md`).                         |
| [TARGET_DOMAIN_MODEL.md](TARGET_DOMAIN_MODEL.md)                       | Aggregates, entities, invariants, vocabularies, roles.                                                                       |
| [TARGET_WORKFLOW_STATE_MODEL.md](TARGET_WORKFLOW_STATE_MODEL.md)       | Multi-dimensional status, lifecycle paths, proceeding state machines.                                                        |
| [AUTHORIZATION_IMPACT.md](AUTHORIZATION_IMPACT.md)                     | Seat-based access, new predicates, RLS, negative tests N1–N20.                                                               |
| [MIGRATION_PLAN.md](MIGRATION_PLAN.md)                                 | Additive migration sequence, dependencies, compatibility, rollback.                                                          |
| [REQUIREMENTS_TRACE_100QA.md](REQUIREMENTS_TRACE_100QA.md)             | Q1–Q100 → design, enforcement, test, phase, ADR.                                                                             |
| [CRM_STATUS_RATIONALIZATION.md](CRM_STATUS_RATIONALIZATION.md)         | Both CRM status lists (150 and 140) and the CDF_CASE_V1 states mapped to grounded target dimensions (migration 1970).        |
| [FORM_CATALOGUE_RATIONALIZATION.md](FORM_CATALOGUE_RATIONALIZATION.md) | All 462 legacy forms and controls (sources A, C, D) classified into target modules; gap register P11-G1–G6 (migration 1970). |
| [LINEAR_RECONCILIATION.md](LINEAR_RECONCILIATION.md)                   | Epics, reconciled existing issues, surfaced conflicts.                                                                       |

Decisions: [ADR-017 … ADR-036](../../architecture/adr/README.md).
