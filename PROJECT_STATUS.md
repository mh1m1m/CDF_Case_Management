# Project Status

Protocol §92. Updated at the end of every phase PR.

**As of:** Phases 0–7 plus the Phase 8 forms engine (CDF-50, draft PR stacked on PR #7) · 2026-10-07

Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Nothing here is a production control; see
`architecture/PRODUCTION_MAPPING.md` for every `PRODUCTION_SUBSTITUTION_REQUIRED` item.

| Metric                              | Value | Basis                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMPLEMENTATION_COMPLETION_PERCENT   | 36%   | Slices: anonymous report → triage → case → assignment → investigation; evidence upload → scan → vault → versioned, audited download. Interviews, findings, committee, reporting, notifications, search not started                                                                                            |
| ARCHITECTURE_ALIGNMENT_PERCENT      | 60%   | Two apps, ports/adapters (identity, storage, scanner, security events, rate limiter), DB command layer, RLS, audit ledger in place; hosted Supabase/Vercel deployment not yet done                                                                                                                            |
| SECURITY_CONTROL_COMPLETION_PERCENT | 50%   | RLS, ABAC clearance, identity vault, append-only hash-chained audit, portal HMAC + rate limiting, CSP, idle timeout, private evidence storage with DB-owned keys, quarantine → scan → vault, immutable versions and custody, audited downloads. Real scanning, WORM storage, KMS, SIEM, MFA are substitutions |
| TEST_AUTOMATION_PERCENT             | 58%   | Unit (92), DB security (116), integration (18), e2e (7), accessibility (4) green locally on the forms branch; CI evidence for PR #3 at `c1a29cb` and PR #7 at `54786e4`                                                                                                                                       |
| BASELINE_MIGRATION_PERCENT          | 42%   | Baseline intake/triage/case/workflow/evidence features and the 19-form WB-FRM catalogue migrated; interviews and later modules pending                                                                                                                                                                        |

## Engineering status (CDF-CEOM)

Linear issue IDs below refer to the CDF workspace, team **CDF** (https://linear.app/cdfcasemanagement/team/CDF). EPIC NN maps to CDF-(NN+5).

| Field                      | Value                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current phase              | 7 evidence and chain of custody (code complete locally; draft PR stacked on PR #3)                                                                                                                                             |
| Current epic               | EPIC 08 Evidence (CDF-13); next EPIC 09 (CDF-14) for Phase 8 forms, activities and interviews                                                                                                                                  |
| Current issues             | Phase 7 evidence story under CDF-13 (IN_PROGRESS); CDF-30 first vertical slice (IN_REVIEW, PR #3); CDF-32 apply migrations to the hosted Supabase project; CDF-34 Supabase CLI CI job; CDF-28/CDF-29 PRs #1 and #2 (IN_REVIEW) |
| Latest stable commit       | `c1a29cb` on `phase-2-6/first-vertical-slice` (PR #3): CI run 37605838274 and CodeQL run 37605838514 green                                                                                                                     |
| Latest stable deployment   | None                                                                                                                                                                                                                           |
| Database migration version | `20261007001110_form_definitions_seed` (forms branch); `20261007000900_evidence` on PR #7                                                                                                                                      |
| Known blockers             | Connector tools are not loaded in the build thread; connector work runs in the connected-systems thread (PR #5, CDF-31). Hosted Supabase project is empty (CDF-32); no Vercel project linked (CDF-33)                          |
| Critical security issues   | None known                                                                                                                                                                                                                     |
| Next work                  | Review and merge PRs #1 → #2 → #3 and the Phase 7 PR (human decision); Phase 8 forms, activities and interviews under EPIC 09 (CDF-14, title per Linear)                                                                       |

## Phases

| Phase                     | Status                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 Baseline analysis       | COMPLETE (pending review)                                                                                                                                           |
| 1 Repository + governance | COMPLETE (pending review)                                                                                                                                           |
| 2 DB/domain foundation    | COMPLETE for slice scope                                                                                                                                            |
| 3 Identity, roles, RLS    | IN_PROGRESS (local-dev identity is PRODUCTION_SUBSTITUTION_REQUIRED; Supabase Auth adapter untested against a hosted project)                                       |
| 4 Case master + ACL       | COMPLETE for slice scope                                                                                                                                            |
| 5 Portal + identity vault | COMPLETE for slice scope (prototype key provider is PRODUCTION_SUBSTITUTION_REQUIRED)                                                                               |
| 6 Workflow engine         | IN_PROGRESS (states/transitions to INVESTIGATION verified; later states defined, not exercised)                                                                     |
| 7 Evidence + custody      | COMPLETE for slice scope (local filesystem store and mock scanner are PRODUCTION_SUBSTITUTION_REQUIRED; Supabase Storage adapter untested against a hosted project) |
| 8 Forms engine (CDF-50)   | COMPLETE for slice scope (19 WB-FRM definitions as versioned data, instances with versions and hashes, prepare/review/approve lifecycle; approvers SOURCE_REQUIRED) |
| 8 Interviews (CDF-60)     | IN_PROGRESS on a parallel swarm branch (ADR-012)                                                                                                                    |
| 9–15                      | NOT_STARTED (records and legal hold design in CDF-61/CDF-69)                                                                                                        |

## Open issues

- Repository: https://github.com/mh1m1m/CDF_Case_Management. PRs #1 (Phase 0, CDF-28), #2 (Phase 1, CDF-29), #3 (Phases 2–6, CDF-30) are stacked drafts with CI green, awaiting review. PR #5 (CDF-31) carries the connected-systems baseline.
- The hosted Supabase project exists but has no migrations applied (CDF-32); no Vercel project is linked to the repository (CDF-33). Neither is needed until a DEMO deployment.
- The Supabase CLI compatibility job passed on PR #3; it is tracked in Linear as CDF-34.
- Production substitutions are tracked in Linear as CDF-35 to CDF-43 (see `architecture/PRODUCTION_MAPPING.md`). Phase 7 adds `LocalFilesystemEvidenceStorage` and the EICAR-only `MockMalwareScanner`; `SupabaseEvidenceStorage` has not been exercised against a hosted project (needs CDF-32).
- `evidence.custody_event` and `evidence.evidence_version` are append-only by trigger; the vault has no retention/WORM lock until Alibaba OSS (production).
