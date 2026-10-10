# E2E Automation Candidates

For a QA agent who will automate UAT scenarios in Playwright later. This document lists what already exists and what to build; it adds no test code (CDF-51 is a plan). New specs belong in `tests/e2e/` and follow the existing conventions: `data-testid` selectors, the `signIn` / `submitAnonymousReport` / `transition` helpers in `tests/e2e/support.ts`, synthetic data only, and the `github` reporter in CI so failures surface as check-run annotations.

## 1. Already automated

| Scenario                                                                            | Automated by                                                                                                              | Gap to close for full parity                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| UAT-WF-01                                                                           | `tests/e2e/first-slice.spec.ts` "anonymous report becomes an open investigation"; `tests/integration/first-slice.spec.ts` | Lead assignment (the e2e assigns investigator.b only); Arabic run |
| UAT-PORTAL-04 (steps 1–2)                                                           | `tests/e2e/first-slice.spec.ts` "the portal gives one answer…"; `tests/security/public-portal.spec.ts`                    | Lockout in the UI (covered in the DB suite only)                  |
| UAT-ADMIN-01 (step 1), UAT-ADMIN-03 (step 1)                                        | `tests/e2e/first-slice.spec.ts` "revoked users cannot sign in and administrators see no cases"                            | committee and dpo accounts                                        |
| UAT-ENV-02 (step 1)                                                                 | `tests/e2e/first-slice.spec.ts` "security headers are present on both apps"                                               | Signed-in case page; Vercel cache header                          |
| UAT-EVID-01..04                                                                     | `tests/e2e/evidence.spec.ts`; `tests/security/evidence-access.spec.ts`; `tests/security/storage-policy.spec.ts`           | Oversize file; classification bounds in the UI                    |
| UAT-VAULT-02, UAT-COI-01 (API), UAT-COI-02 (API), UAT-AUTHZ-01 step 5, UAT-ADMIN-02 | `tests/security/*.spec.ts` (database level)                                                                               | No UI exists yet; keep at DB level                                |
| UAT-UX-01..02 (automatable part)                                                    | `tests/accessibility/a11y.spec.ts` (axe, both languages)                                                                  | Phone viewport; keyboard-only journey                             |

## 2. To automate

Priority follows the plan's security weighting: isolation and disclosure first.

| #   | Scenario      | Proposed spec / test name                                                                          | Priority | Notes                                                                                                            |
| --- | ------------- | -------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | UAT-AUTHZ-01  | `tests/e2e/isolation.spec.ts` "an investigator cannot open another team's case or evidence by URL" | High     | Copy case and download URLs as lead; expect 404 as investigator.b                                                |
| 2   | UAT-AUTHZ-02  | same file, "restricted SECRET case is hidden from case managers"                                   | High     | casemanager list excludes 0003; lead URL 404                                                                     |
| 3   | UAT-VAULT-01  | `tests/e2e/vault.spec.ts` "identified reporter's identity never reaches the case page"             | High     | Assert persona name and email absent from page HTML and responses                                                |
| 4   | UAT-PORTAL-04 | `tests/e2e/portal.spec.ts` "ten wrong secrets lock the report in the UI"                           | High     | Needs a fresh report per run; lockout is 15 min, so isolate with a new report                                    |
| 5   | UAT-WF-02     | `tests/e2e/workflow.spec.ts` "blocked transitions show translated reasons"                         | High     | priority, conflict declaration, separation of duties, not-yet-available                                          |
| 6   | UAT-ENV-01    | `tests/e2e/bundle.spec.ts` "no service-role marker in any served script"                           | High     | Fetch every `/_next/static/**.js` referenced by both apps and scan for key markers; run against preview URLs too |
| 7   | UAT-PORTAL-03 | `tests/e2e/portal.spec.ts` "reporter and intake exchange messages"                                 | Medium   | Also assert credentials absent from URL, cookies, localStorage after sign-out                                    |
| 8   | UAT-INTAKE-01 | `tests/e2e/intake.spec.ts` "request for information reaches the reporter"                          | Medium   |                                                                                                                  |
| 9   | UAT-INTAKE-02 | `tests/e2e/intake.spec.ts` "refer out, close and duplicate show Closed publicly"                   | Medium   | Validation errors for missing target and original                                                                |
| 10  | UAT-WF-03     | `tests/e2e/workflow.spec.ts` "screen out, out of jurisdiction and rejection"                       | Medium   |                                                                                                                  |
| 11  | UAT-COI-02    | `tests/e2e/conflict.spec.ts` "conflicted and under-cleared users cannot be assigned"               | Medium   | UI refusal messages                                                                                              |
| 12  | UAT-COI-01    | `tests/e2e/conflict.spec.ts` "declaring a conflict removes the case at once"                       | Medium   | Mutates seed; run in a fresh database                                                                            |
| 13  | UAT-PORTAL-02 | `tests/e2e/portal.spec.ts` "report form validation in both languages"                              | Medium   |                                                                                                                  |
| 14  | UAT-PORTAL-05 | `tests/e2e/portal.spec.ts` "sixth submission in an hour is throttled"                              | Low      | Depends on `PORTAL_LIMITS`; keep the limit in one place                                                          |
| 15  | UAT-UX-02     | `tests/accessibility/keyboard.spec.ts` "report and follow-up by keyboard; case page at 390 px"     | Low      | Overlaps CDF-53/CDF-54 fixes; add when those land                                                                |
| 16  | UAT-ENV-04    | `tests/e2e/session.spec.ts` "idle session expires"                                                 | Low      | Use a short `CDF_SESSION_IDLE_SECONDS` in the test environment                                                   |

Hosted-only checks (UAT-ENV-01 against Vercel env settings, UAT-ENV-03, UAT-EVID-01 step 7 bucket privacy) are better as a post-deploy smoke job run against the preview and DEMO URLs once CDF-33 lands, not as part of the local CI e2e run.

## 3. Regression set by area

After a fix, rerun the failed scenario plus the set for the area the fix touched.

| Area touched by the fix                                | Rerun                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| Portal (`apps/whistleblowing-web`, `public_api.*`)     | UAT-PORTAL-01..05, UAT-VAULT-01, UAT-ENV-02                 |
| Identity vault (`protected_identity`, reveal commands) | UAT-VAULT-01..02, UAT-ADMIN-02                              |
| Intake and triage                                      | UAT-INTAKE-01..02, UAT-PORTAL-03, UAT-WF-01 step 1          |
| Workflow engine or definitions                         | UAT-WF-01..03, UAT-COI-01                                   |
| Authorization, RLS, roles, grants                      | UAT-AUTHZ-01..02, UAT-COI-01..02, UAT-ADMIN-01, UAT-EVID-04 |
| Evidence, storage, scanner                             | UAT-EVID-01..04, UAT-ENV-01                                 |
| Audit ledger                                           | UAT-ADMIN-02 plus any scenario whose timeline was wrong     |
| Shared UI, i18n                                        | UAT-UX-01..02 and one scenario per app in both languages    |
| Deployment, env vars, headers                          | UAT-ENV-01..04                                              |
