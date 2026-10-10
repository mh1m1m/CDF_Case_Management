# User Acceptance Testing (UAT)

Linear: [CDF-51](https://linear.app/cdfcasemanagement/issue/CDF-51). Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Every name, case, file and message used in UAT is synthetic; nothing here is a CDF production control.

UAT answers one question the automated suites cannot: does a person in each platform role, working on a deployed build, get the outcome the CDF procedure expects? Automated tests (`tests/`) prove the controls; UAT proves the journeys.

| Document                                       | What it holds                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [UAT_PLAN.md](UAT_PLAN.md)                     | Scope, environment, gates, entry and exit criteria, roles, defect process, sign-off         |
| [SCENARIOS.md](SCENARIOS.md)                   | Step-by-step scripts with expected results, per role and flow, and the scenarios still owed |
| [SYNTHETIC_DATA.md](SYNTHETIC_DATA.md)         | Test accounts, seed cases, report texts and evidence files UAT uses, all synthetic          |
| [EVIDENCE_TEMPLATES.md](EVIDENCE_TEMPLATES.md) | Execution record, defect record, retest record, cycle summary and acceptance sign-off       |
| [E2E_CANDIDATES.md](E2E_CANDIDATES.md)         | Which scenarios are already automated, and the list a QA agent can automate in Playwright   |

## Status

| Item                       | State                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| Plan                       | DESIGNED (this directory)                                                                              |
| Execution                  | BLOCKED: needs hosted DEV validated (CDF-32), both Vercel apps deployed (CDF-33), then DEMO (see plan) |
| Scenarios ready to execute | 30 (Wave 1, features that exist today)                                                                 |
| Scenarios designed, parked | 13 (Wave 2–3, features not built yet: forms, interviews, committee, decision, closure, records)        |

## Sources

Every expected result traces to one of these; nothing is guessed. Where a source is silent the scenario says `SOURCE_REQUIRED`.

- Repository at PR #7 head `54786e4`, with the portal scenarios refreshed at main `96786eb` after PR #22 (CDF-63): `CLAUDE.md`, `architecture/WORKFLOW.md`, `architecture/DEMONSTRATION_SCENARIOS.md`, `architecture/SECURITY_RULES.md`, ADR-002 to ADR-007, `compliance/requirements/requirements.yaml`, `infrastructure/supabase/seed/`, `tests/`.
- Baseline business knowledge: `BASELINE_ANALYSIS.md` and `baseline/extracted/baseline-domain.json` (19 WB-FRM forms, 22 baseline roles, 19-step workflow, three `SOURCE_REQUIRED` values).
- Google Drive, CDF folder: the whistleblowing service requirements report (21 intake fields, three reporting modes, ticket lifecycle). The portal was aligned with it in [CDF-63](https://linear.app/cdfcasemanagement/issue/CDF-63); the one field still missing, attachments, is [CDF-72](https://linear.app/cdfcasemanagement/issue/CDF-72).
