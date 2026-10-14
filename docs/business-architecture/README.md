# Business Architecture Rebase

> SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Not CDF production, not regulatory certification, not final HR or legal conformance. Linear project: CDF Business Architecture Rebase (CDF-186 … CDF-202; ambiguity register CDF-204).

| Document                                                                   | Purpose                                                                                                                                                           |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [BUSINESS_ARCHITECTURE_GAP_MAP.md](BUSINESS_ARCHITECTURE_GAP_MAP.md)       | Current → target, classified KEEP … SOURCE_REQUIRED (playbook name: `CURRENT_TO_TARGET_GAP_MAP.md`).                                                              |
| [TARGET_DOMAIN_MODEL.md](TARGET_DOMAIN_MODEL.md)                           | Aggregates, entities, invariants, vocabularies, roles.                                                                                                            |
| [TARGET_WORKFLOW_STATE_MODEL.md](TARGET_WORKFLOW_STATE_MODEL.md)           | Multi-dimensional status, lifecycle paths, proceeding state machines.                                                                                             |
| [AUTHORIZATION_IMPACT.md](AUTHORIZATION_IMPACT.md)                         | Seat-based access, new predicates, RLS, negative tests N1–N20.                                                                                                    |
| [MIGRATION_PLAN.md](MIGRATION_PLAN.md)                                     | Additive migration sequence, dependencies, compatibility, rollback.                                                                                               |
| [REQUIREMENTS_TRACE_100QA.md](REQUIREMENTS_TRACE_100QA.md)                 | Q1–Q100 → design, enforcement, test, phase, ADR.                                                                                                                  |
| [CRM_STATUS_RATIONALIZATION.md](CRM_STATUS_RATIONALIZATION.md)             | Both CRM status lists (150 and 140) and the CDF_CASE_V1 states mapped to grounded target dimensions (migration 1970).                                             |
| [FORM_CATALOGUE_RATIONALIZATION.md](FORM_CATALOGUE_RATIONALIZATION.md)     | All 462 legacy forms and controls (sources A, C, D) classified into target modules; gap register P11-G1–G6 (migration 1970).                                      |
| [LINEAR_RECONCILIATION.md](LINEAR_RECONCILIATION.md)                       | Epics, reconciled existing issues, surfaced conflicts.                                                                                                            |
| [AMBIGUITY_REGISTER_200.md](AMBIGUITY_REGISTER_200.md)                     | 251 material ambiguities across domains A–T, each resolved R1–R5 with evidence, risk, owner and test (CDF-204).                                                   |
| [OWNER_DECISIONS_FROM_AMBIGUITIES.md](OWNER_DECISIONS_FROM_AMBIGUITIES.md) | The 15 genuine owner decisions (DEC-AMB-001…015), all decided by Fady on 2026-10-13: his text verbatim, placement, and the fail-safe that stays until each lands. |
| [SOURCE_REQUIRED_REGISTER.md](SOURCE_REQUIRED_REGISTER.md)                 | Values that need a governing CDF document, grouped by document, with the interim behaviour.                                                                       |
| [CONFIGURATION_REQUIREMENTS.md](CONFIGURATION_REQUIREMENTS.md)             | Configurable rules with safe defaults; effective-dated, never retroactive.                                                                                        |
| [AMBIGUITY_TEST_MATRIX.md](AMBIGUITY_TEST_MATRIX.md)                       | Every CRITICAL and HIGH ambiguity mapped to an existing or required test (T-AMB-nnn).                                                                             |
| [CONTRADICTION_REGISTER.md](CONTRADICTION_REGISTER.md)                     | Conflicts between sources, the authoritative resolution and the action each needs.                                                                                |

Decisions: [ADR-017 … ADR-039](../../architecture/adr/README.md).
