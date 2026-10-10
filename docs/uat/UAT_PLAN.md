# UAT Plan

Linear: CDF-51 (parent EPIC 22, CDF-27). Governing decision: Fady, 2026-10-07 12:03, item 10 ("UAT CDF-51 blocked until DEV and Vercel work; then DEMO → deploy → UAT → defects in Linear → retest → acceptance evidence").

## 1. Purpose

Accept, by a person and against written scripts, the functionality already built in the reference implementation, on a deployed build with synthetic data. Record the result against a commit SHA so it can be audited later and repeated after every material change.

UAT does not replace the automated suites. A scenario passes only if the person sees the expected behaviour **and** the automated suites for the same commit are green (entry criterion E5).

## 2. Scope

### In scope (Wave 1, executable once the gates below are met)

| Flow                                 | Scenario group | Built in               |
| ------------------------------------ | -------------- | ---------------------- |
| Anonymous report and follow-up       | UAT-PORTAL     | PR #3 (Phases 2–6)     |
| Identified report and identity vault | UAT-VAULT      | PR #3 (UI + API)       |
| Intake and triage                    | UAT-INTAKE     | PR #3                  |
| Case creation, workflow to approval  | UAT-WF         | PR #3                  |
| Assignment, conflict of interest     | UAT-COI        | PR #3                  |
| Authorization isolation              | UAT-AUTHZ      | PR #3                  |
| Evidence and chain of custody        | UAT-EVID       | PR #7 (Phase 7)        |
| Administration and audit separation  | UAT-ADMIN      | PR #3 (partly API)     |
| Arabic/English and accessibility     | UAT-UX         | PR #3, PR #7           |
| Hosted-environment controls          | UAT-ENV        | CDF-32, CDF-33 outputs |

### Designed now, executed later (Wave 2 and 3)

Investigation forms (WB-FRM-01..19, CDF-50), interviews and activities (EPIC 09, CDF-14), findings, GRC/legal review, committee, right of defence, decision, grievance, corrective action, closure, archive, retention and legal hold. These are in [SCENARIOS.md §Wave 2–3](SCENARIOS.md#wave-2-and-3-designed-not-yet-executable) with the source each one depends on. They enter UAT only when the feature has merged, its automated tests are green and its workflow transitions are enabled (`architecture/WORKFLOW.md` §2).

### Out of scope

Performance and load testing; penetration testing (security engineering, AGENT-09); production substitutions (CDF-35..43: real malware scanning, KMS/HSM, WORM storage, CDF OIDC, SIEM), which UAT records as `PRODUCTION_SUBSTITUTION_REQUIRED` rather than tests; any real CDF data.

## 3. Environment

| Item           | Value                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target         | **DEMO**: Supabase project `cdf-case-demo` plus the two Vercel projects `cdf-whistleblowing` and `cdf-investigations`, `main` deployment pointed at DEMO                                                            |
| Not the target | DEV (`cdf-case-dev`, `blycdqjphsxvyiuoommv`) is for integration validation; a dry run may happen there (§6, step 3) but its results are not acceptance evidence                                                     |
| Database       | All migrations from Git applied; the migration list on DEMO equals `infrastructure/supabase/migrations/` at the tested commit (no drift, CLAUDE.md §11)                                                             |
| Data           | Synthetic seed from `infrastructure/supabase/seed/` plus the UAT data sets in [SYNTHETIC_DATA.md](SYNTHETIC_DATA.md)                                                                                                |
| Identity       | Supabase Auth test accounts matching the seed users' emails (`@example.test`). Passwords are issued to testers out of band and never written to Git, Linear, Drive, Slack or an execution record                    |
| Evidence store | Private Supabase Storage buckets provisioned from Git-controlled configuration (Fady's decision 5), through `SupabaseEvidenceStorage`. Malware scanning is the EICAR-only mock (`PRODUCTION_SUBSTITUTION_REQUIRED`) |
| Browsers       | Chromium (desktop, current); Safari on iPhone or an emulated 390 px viewport for the phone checks in UAT-UX                                                                                                         |
| Observability  | Sentry, once CDF-23 is configured, is checked after each cycle for new errors; it must hold no reporter identity, narrative or evidence content                                                                     |

## 4. Gates (entry criteria)

UAT execution starts only when every entry criterion holds. The test lead records the evidence for each in the cycle summary ([EVIDENCE_TEMPLATES.md §5](EVIDENCE_TEMPLATES.md#5-cycle-summary)).

| #   | Entry criterion                                                                                                                                                                               | Evidence                                        | Owner / issue |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------- |
| E1  | Hosted DEV validated: 9+ migrations applied from Git, private buckets from Git config, seed loaded, Auth and Storage adapters tested, RLS/security suites green against DEV, drift reconciled | CDF-32 closed with its evidence record          | CDF-32        |
| E2  | Both Vercel projects deployed and separate; no service-role key in client bundles; investigation pages not publicly cached                                                                    | CDF-33 closed; UAT-ENV-01..03 pre-checks        | CDF-33        |
| E3  | DEMO created only after E1 (Fady's decision 6), migrated from Git, seeded, buckets private                                                                                                    | Supabase migration list vs Git; bucket settings | infra thread  |
| E4  | `main` deployments point at DEMO; the deployed commit SHA is known and is the SHA under test                                                                                                  | Vercel deployment id and SHA                    | infra thread  |
| E5  | CI green on that SHA (lint, typecheck, unit, database/security, e2e, accessibility, CodeQL)                                                                                                   | GitHub Actions run ids                          | CI            |
| E6  | Test accounts provisioned for every role in [SYNTHETIC_DATA.md §1](SYNTHETIC_DATA.md#1-test-accounts), credentials handed to testers out of band                                              | Account list (emails and roles only)            | test lead     |
| E7  | No open CRITICAL or HIGH security defect in Linear against the build                                                                                                                          | Linear filter                                   | test lead     |
| E8  | Testers briefed: synthetic data only, the defect process (§8), and that the banner on every page must read synthetic                                                                          | Briefing noted in cycle summary                 | test lead     |

If any entry criterion fails, the cycle does not start; the failure is raised in Linear against the owning issue, not worked around.

## 5. Roles

### UAT roles (people)

| Role              | Responsibility                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Business owner    | Fady (GRC). Accepts or rejects the cycle; decides on deferrals; signs [EVIDENCE_TEMPLATES.md §6](EVIDENCE_TEMPLATES.md#6-acceptance-sign-off) |
| Test lead         | Runs the cycle, checks entry/exit criteria, triages defects, writes the cycle summary (AGENT-10 or a person)                                  |
| Tester            | Executes scripts in the persona of a platform role; records results and evidence                                                              |
| Developer on call | Diagnoses defects; fixes through the normal PR path; never edits DEMO by hand                                                                 |

One person may hold several UAT roles, except that the person who fixes a defect does not alone retest and close it (separation of duties, §8).

### Platform roles exercised (actors)

Actors are the platform roles in `packages/contracts` and the seed (`architecture/DEMONSTRATION_SCENARIOS.md`, Seed users). Baseline roles map to them as in `BASELINE_ANALYSIS.md` §5.3.

| Actor (seed account)         | Platform role     | Exercised in Wave 1                                     | Baseline equivalent             |
| ---------------------------- | ----------------- | ------------------------------------------------------- | ------------------------------- |
| Anonymous reporter (portal)  | none (public)     | Submit, follow up, reply                                | EMPLOYEE / public               |
| Identified reporter (portal) | none (public)     | Submit with identity                                    | EMPLOYEE / public               |
| intake@example.test          | INTAKE_OFFICER    | Intake queue visibility                                 | COMPLIANCE_OFFICER              |
| triage@example.test          | TRIAGE_OFFICER    | Triage, request information, create case, screening     | COMPLIANCE_OFFICER              |
| casemanager@example.test     | CASE_MANAGER      | Assign, decide conflicts, approve investigation         | COMPLIANCE_MANAGER / CASE_OWNER |
| lead@example.test            | LEAD_INVESTIGATOR | Case work, declare conflict                             | SENIOR_INVESTIGATOR             |
| investigator.a@example.test  | INVESTIGATOR      | Evidence; conflicted on case 0004                       | INVESTIGATOR                    |
| investigator.b@example.test  | INVESTIGATOR      | Isolation checks                                        | INVESTIGATOR                    |
| grc.director@example.test    | GRC_DIRECTOR      | Approve investigation, restricted case, identity reveal | (new)                           |
| grc.deputy@example.test      | GRC_DIRECTOR      | Second approver for identity reveal                     | (new)                           |
| committee@example.test       | COMMITTEE_MEMBER  | No case access (negative)                               | INVESTIGATION_COMMITTEE_MEMBER  |
| admin@example.test           | PLATFORM_ADMIN    | No case content (negative)                              | PLATFORM_ADMINISTRATOR          |
| audit@example.test           | INTERNAL_AUDIT    | Audit metadata only (API)                               | READ_ONLY_AUDITOR               |
| soc@example.test             | SOC_ANALYST       | Security events only (API)                              | SECURITY_AUDITOR                |
| dpo@example.test             | PRIVACY_DPO       | Audit and security metadata, no case content (negative) | (new)                           |
| revoked@example.test         | (revoked)         | Cannot sign in                                          | —                               |

Roles defined but not yet exercisable (Wave 2–3): COMMITTEE_SECRETARY, COMMITTEE_CHAIR, DECISION_AUTHORITY, IMPLEMENTATION_OWNER, LEGAL_REVIEWER, HR_REVIEWER, RECORDS_OFFICER, GRIEVANCE_COMMITTEE_*, and the contextual subject-employee view.

### Steps with no screen yet

Some commands exist and are tested at the database API level but have no UI (`architecture/DEMONSTRATION_SCENARIOS.md`, "What the workspace UI covers today"). Scenarios mark those steps **API**. On DEMO the test lead runs them through the SQL editor as the named seed user's security context, following the automated test the step cites, and records the query output as evidence. An API step that fails is a defect like any other; an API step that cannot be run on DEMO is recorded `NOT_RUN` with the reason, not `PASS`.

## 6. Process

1. **Prepare.** Confirm E1–E8; record the SHA, Vercel deployment ids and CI run ids. Load the UAT data sets.
2. **Smoke.** Run UAT-ENV-01..04 and UAT-PORTAL-01. If any fails, stop: the build is not fit for UAT.
3. **Dry run (optional, on DEV).** The test lead walks the scripts once on DEV to catch script errors. Results are not acceptance evidence.
4. **Execute.** Testers run each Wave 1 scenario once, in both languages where the scenario says so, and complete an execution record ([EVIDENCE_TEMPLATES.md §1](EVIDENCE_TEMPLATES.md#1-execution-record)) per scenario.
5. **Record defects.** Every failed expected result becomes a Linear issue (§8) linked from the execution record.
6. **Fix.** Fixes go through branch → PR → CI → merge to `main` → redeploy to DEMO. No hand edits to DEMO data or schema, ever; a DEMO reset is a human decision (CLAUDE.md §11).
7. **Retest.** On the new SHA, rerun the failed scenario **and** the regression set for the touched area ([E2E_CANDIDATES.md §3](E2E_CANDIDATES.md#3-regression-set-by-area)). Record a retest record ([EVIDENCE_TEMPLATES.md §3](EVIDENCE_TEMPLATES.md#3-retest-record)).
8. **Summarise and sign off.** Test lead writes the cycle summary; business owner accepts, accepts with deferrals, or rejects.
9. **Store evidence.** Execution records, summaries and screenshots go to the project shared folder under `uat/<cycle-id>/` and are linked from CDF-51. Screenshots show synthetic data only; anything showing a credential is discarded.

## 7. Exit criteria

A UAT cycle is accepted when all hold:

| #   | Exit criterion                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | Every Wave 1 scenario executed once on DEMO with a record against the SHA under test                                                     |
| X2  | All UAT-AUTHZ, UAT-VAULT, UAT-EVID security checks and UAT-ENV checks pass. No exception: a failure here blocks acceptance               |
| X3  | No open CRITICAL or HIGH defect; every MEDIUM or LOW defect still open has a Linear issue and an explicit deferral by the business owner |
| X4  | Every fixed defect retested on a later SHA, with its regression set green                                                                |
| X5  | CI green on the final SHA; no new Sentry error carrying personal data or case content                                                    |
| X6  | Cycle summary and sign-off recorded and linked from CDF-51                                                                               |

A cycle that meets X1–X6 supports the re-audit gate (Fady's decision 12) but does not by itself set a maturity level; that is the next CDF-DEV-AUDIT's call. Acceptance never reads "production ready".

## 8. Defects

Every defect is a Linear issue in team CDF, project QA, with:

- title `UAT: <short behaviour>`; link to CDF-51 (related) and to the feature's story;
- the scenario id and step, the SHA, the environment (DEMO), the actor;
- expected vs actual, steps to reproduce, synthetic evidence (screenshot, correlation id shown in the error message);
- **security severity** (CRITICAL / HIGH / MEDIUM / LOW / NONE) and **priority** recorded separately (CLAUDE.md §11).

Severity guide for UAT:

| Severity | Example                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | A user sees a case, evidence or reporter identity they are not entitled to; the portal reveals whether a Report ID exists; audit can be altered     |
| HIGH     | A required control is missing (e.g. separation of duties not enforced, evidence downloadable without permission), or a core journey cannot complete |
| MEDIUM   | A journey completes but with wrong status, wrong message, missing audit entry visible in the timeline, or an Arabic/English layout break            |
| LOW      | Cosmetic, wording, minor accessibility issue with a workaround                                                                                      |

Defect statuses follow the workspace: Backlog → In Progress → In Review (fix PR open) → Done only after a retest record shows PASS by someone other than the fixer.

## 9. Record format

Each execution record carries at least: scenario id, tester or automation, environment, SHA, Vercel deployment ids, date (UTC), language, result (`PASS` / `FAIL` / `BLOCKED` / `NOT_RUN`), defect ids, evidence links. Templates are in [EVIDENCE_TEMPLATES.md](EVIDENCE_TEMPLATES.md).

## 10. Risks and open items

| Risk / open item                                                                                            | Handling                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Portal attachments (Drive field 19) are not built yet (CDF-72); city and nationality lists are placeholders | UAT-PORTAL accepts the other Drive fields since CDF-63; attachments get Wave 2 scenarios when CDF-72 lands; the lists are recorded as `PRODUCTION_SUBSTITUTION_REQUIRED` |
| Several Wave 1 steps are API-only                                                                           | Run via SQL editor as described in §5; reduce as screens land                                                                                                            |
| Hosted Auth sign-in differs from local development sign-in                                                  | UAT-ENV-04 and UAT-ADMIN-03 cover sign-in, revoked users and brute-force throttling on DEMO                                                                              |
| Supabase Free may pause an idle DEMO project                                                                | Test lead checks the project is active before each session                                                                                                               |
| `SOURCE_REQUIRED` business values (committee quorum, final disciplinary authority, retention period, SLAs)  | Wave 2–3 scenarios that depend on them stay parked until a source is confirmed                                                                                           |
