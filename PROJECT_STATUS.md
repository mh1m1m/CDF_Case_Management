# Project Status

Protocol §92. Updated at the end of every phase PR.

**As of:** Phases 0–6, first secure vertical slice · 2026-10-07

Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Nothing here is a production control; see
`architecture/PRODUCTION_MAPPING.md` for every `PRODUCTION_SUBSTITUTION_REQUIRED` item.

| Metric                              | Value | Basis                                                                                                                                                                          |
| ----------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IMPLEMENTATION_COMPLETION_PERCENT   | 25%   | Slice: anonymous report → triage → case → assignment → investigation. Evidence, interviews, findings, committee, reporting, notifications, search not started                  |
| ARCHITECTURE_ALIGNMENT_PERCENT      | 55%   | Two apps, ports/adapters, DB command layer, RLS, audit ledger in place; hosted Supabase/Vercel deployment not yet done                                                         |
| SECURITY_CONTROL_COMPLETION_PERCENT | 40%   | RLS, ABAC clearance, identity vault, append-only hash-chained audit, portal HMAC + rate limiting, CSP, idle timeout. Evidence, KMS, SIEM, MFA are substitutions or not started |
| TEST_AUTOMATION_PERCENT             | 45%   | Unit, DB security (81), integration, e2e (4), accessibility (4) and the Supabase CLI compatibility job all green in CI on PR #3                                                |
| BASELINE_MIGRATION_PERCENT          | 30%   | Baseline intake/triage/case/workflow features migrated; evidence and later modules pending                                                                                     |

## Engineering status (CDF-CEOM)

Linear issue IDs below refer to the CDF workspace, team **CDF** (https://linear.app/cdfcasemanagement/team/CDF). EPIC NN maps to CDF-(NN+5).

| Field                      | Value                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current phase              | 2–6 first secure vertical slice (code complete, CI green, awaiting review)                                                                                                                            |
| Current epic               | EPIC 04 Case Master & ACL (CDF-9) and EPIC 07 Workflow (CDF-12); next EPIC 08 Evidence (CDF-13)                                                                                                       |
| Current issues             | CDF-30 first vertical slice (IN_REVIEW, PR #3); CDF-32 apply migrations to the hosted Supabase project; CDF-34 Supabase CLI CI job; CDF-28/CDF-29 PRs #1 and #2 (IN_REVIEW)                           |
| Latest stable commit       | `a427404` on `phase-2-6/first-vertical-slice` (PR #3): CI run 37604156361 and CodeQL run 37604156288 green                                                                                            |
| Latest stable deployment   | None                                                                                                                                                                                                  |
| Database migration version | `20261007000800_public_api`                                                                                                                                                                           |
| Known blockers             | Connector tools are not loaded in the build thread; connector work runs in the connected-systems thread (PR #5, CDF-31). Hosted Supabase project is empty (CDF-32); no Vercel project linked (CDF-33) |
| Critical security issues   | None known                                                                                                                                                                                            |
| Next work                  | Review and merge PRs #1 → #2 → #3 (human decision); Phase 7 evidence under EPIC 08 (CDF-13)                                                                                                           |

## Phases

| Phase                     | Status                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0 Baseline analysis       | COMPLETE (pending review)                                                                                                     |
| 1 Repository + governance | COMPLETE (pending review)                                                                                                     |
| 2 DB/domain foundation    | COMPLETE for slice scope                                                                                                      |
| 3 Identity, roles, RLS    | IN_PROGRESS (local-dev identity is PRODUCTION_SUBSTITUTION_REQUIRED; Supabase Auth adapter untested against a hosted project) |
| 4 Case master + ACL       | COMPLETE for slice scope                                                                                                      |
| 5 Portal + identity vault | COMPLETE for slice scope (prototype key provider is PRODUCTION_SUBSTITUTION_REQUIRED)                                         |
| 6 Workflow engine         | IN_PROGRESS (states/transitions to INVESTIGATION verified; later states defined, not exercised)                               |
| 7–15                      | NOT_STARTED (Phase 7 evidence is next, EPIC 08 CDF-13)                                                                        |

## Open issues

- Repository: https://github.com/mh1m1m/CDF_Case_Management. PRs #1 (Phase 0, CDF-28), #2 (Phase 1, CDF-29), #3 (Phases 2–6, CDF-30) are stacked drafts with CI green, awaiting review. PR #5 (CDF-31) carries the connected-systems baseline.
- The hosted Supabase project exists but has no migrations applied (CDF-32); no Vercel project is linked to the repository (CDF-33). Neither is needed until a DEMO deployment.
- The Supabase CLI compatibility job passed on PR #3; it is tracked in Linear as CDF-34.
- Production substitutions are tracked in Linear as CDF-35 to CDF-43 (see `architecture/PRODUCTION_MAPPING.md`).
