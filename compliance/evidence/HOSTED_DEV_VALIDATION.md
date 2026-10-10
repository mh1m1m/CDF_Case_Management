# Hosted DEV validation — Supabase `cdf-case-dev`

CDF-32 · CEOM §11 (Supabase holds the prototype database state as executed; the Git migrations remain the intended-state authority) · recorded 2026-10-07 from the Claude Code cloud session, branch `feature/CDF-32-hosted-dev` (base: PR #7 head `54786e4`); merged with PR #16 on 2026-10-10 and re-checked against DEV the same day (§4.2, §4.3, §5).

Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION. This document carries identifiers and technical metadata only. No key, password, token or connection string appears here or in the linked issues, ever.

## 1. Decisions in force (Fady, 2026-10-07 12:03)

- The existing Supabase project `blycdqjphsxvyiuoommv` is DEV (`cdf-case-dev`). Every Git migration is applied there first.
- `cdf-case-demo` is **not** created until DEV passes migration, RLS, authorization-isolation, storage-security, auth, evidence-workflow and regression validation (§8).
- Git is authoritative: `infrastructure/supabase/migrations/` is the intended state; no console-only changes; the evidence buckets are declared in Git, not created by the runtime `ensureBuckets()` fallback.
- Vercel (CDF-33): two separate projects, `cdf-whistleblowing` and `cdf-investigations`, both on DEV; server-scoped environment variables only; nothing secret in a client bundle; investigation pages never publicly cached; production deployments only after the PR stack merges.

## 2. DEV identity (read with `get_project`, 2026-10-07)

| Item           | Value                                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project ref    | `blycdqjphsxvyiuoommv`                                                                                                                                                                  |
| Dashboard name | still "CDF Case Management's Project". The rename to `cdf-case-dev` is a dashboard-only action (Project Settings → General) that neither the connector nor the CLI exposes: **pending** |
| Organisation   | `rcnfafzoqddsdcrgpdmq`                                                                                                                                                                  |
| Region         | ap-northeast-1 (Tokyo). Saudi residency applies to production only (Alibaba Cloud Riyadh, `architecture/PRODUCTION_MAPPING.md`)                                                         |
| PostgreSQL     | 17.11, release channel `ga`                                                                                                                                                             |
| Collation      | `en_US.UTF-8` (the local reference database collates `C.UTF-8`; see §5)                                                                                                                 |
| Status         | ACTIVE_HEALTHY, created 2026-10-07 07:09 UTC, empty at creation                                                                                                                         |
| Session pooler | `aws-0-ap-northeast-1.pooler.supabase.com`, port 5432, user `postgres.blycdqjphsxvyiuoommv` (established by the probe in run 37649873035; `aws-1-…` answers "tenant not found")         |
| Reachability   | The cloud session reaches the Supabase management API through the connector only; the database host and the pooler are not reachable from it, so suites run from GitHub Actions (§4.2)  |

## 3. Migration status (`list_migrations`, 2026-10-07)

| Git migration                             | DEV     | Applied how                                | Note                                                                                    |
| ----------------------------------------- | ------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `20261007000100_foundation`               | APPLIED | connector `apply_migration`, file verbatim | —                                                                                       |
| `20261007000200_iam`                      | APPLIED | same                                       | —                                                                                       |
| `20261007000300_authz_core_and_audit`     | APPLIED | same                                       | the append-only audit triggers (`before delete or truncate`) are DDL and were not gated |
| `20261007000400_domain_tables`            | APPLIED | same                                       | —                                                                                       |
| `20261007000500_authz_case_and_policies`  | APPLIED | same                                       | —                                                                                       |
| `20261007000600_workflow_definition`      | APPLIED | same                                       | —                                                                                       |
| `20261007000700_api_commands`             | APPLIED | same                                       | —                                                                                       |
| `20261007000800_public_api`               | PENDING | CI, `hosted-dev.yml`                       | blocked through the connector, drift record 2                                           |
| `20261007000900_evidence`                 | PENDING | CI                                         | waits behind 0800 so the order stays as in Git                                          |
| `20261007001000_evidence_storage_buckets` | PENDING | CI                                         | on `main` since PR #16 (§7)                                                             |

The hosted history (`supabase_migrations.schema_migrations`) lists exactly `20261007000100` … `20261007000700` with their Git names, so `supabase db push` applies 0800–1000 and nothing else. Re-read on 2026-10-10 (about 08:45 UTC), after PR #16 put all ten files on `main` (`cd0776a`): unchanged, still exactly 0100–0700.

## 4. Drift records (EXPECTED / ACTUAL / DRIFT / CAUSE / REMEDIATION)

### 4.1 Migration history versions — RESOLVED

- EXPECTED: history versions equal the Git file versions (`20261007000100`, …).
- ACTUAL: after `apply_migration`, the seven rows carried the connector's own run timestamps as `version`; the names were kept.
- DRIFT: seven `version` values; the schema itself was unaffected.
- CAUSE: `apply_migration` takes a name and generates the version at apply time.
- REMEDIATION (done 2026-10-07, 12:31 on the project thread's clock): `update supabase_migrations.schema_migrations m set version = left(m.name, 14) where m.name ~ '^20261007000[1-9]00_' and m.version <> left(m.name, 14)` affected 7 rows; verified with `list_migrations`. Every further apply goes through the Supabase CLI from CI, which records Git versions natively.

### 4.2 Migrations 0800–1000 not applied — OPEN

- EXPECTED: 10 migrations.
- ACTUAL: 7.
- DRIFT: missing on DEV: the `public_api` schema (anonymous portal commands, `core.rate_limit` and `core.consume_rate_limit`, `usage` on `public_api` for `authenticated`), the `evidence` schema (items, versions, custody, content-type allow-list, the evidence `api.*` and `authz.*` functions), the `EVIDENCE_UPLOAD` and `EVIDENCE_DOWNLOAD` permissions with their twelve role grants, and the two storage buckets.
- CAUSE: `0800_public_api` contains a `delete from core.rate_limit …` inside `core.consume_rate_limit()`. The connector classifies the statement as destructive and raises a confirmation prompt that expires after about a minute and never reached the requester (four attempts, 2026-10-07 12:20–12:27). The migration was not rewritten to avoid the check. DEV was verified unchanged after every attempt (last migration 0700, no `core.rate_limit` objects).
- REMEDIATION: `.github/workflows/hosted-dev.yml` (on `main` since PR #16, 2026-10-10: GitHub → Actions → "Hosted DEV (Supabase)" → Run workflow; before that it ran on pushes to `feature/CDF-32-hosted-dev`, because GitHub resolves manual dispatch against the default branch) connects the Supabase CLI to the IPv4 session pooler on port 5432 with `--db-url` (the direct database host is IPv6-only, which GitHub-hosted runners cannot reach; no Supabase access token is involved), runs `supabase db push` (exactly the pending Git files, in order), seeds the synthetic data while DEV is still empty, and runs `pnpm test:db` against DEV. It reads `SUPABASE_DB_PASSWORD` from the GitHub environment `Supabase`, falling back to the repository secret of that name (§9). The run ID and commit are recorded here and in CDF-32 once it has run.
- STATUS (2026-10-10): the secret exists, but every run so far ends in `password authentication failed for user "postgres"` at the session pooler. The project's Supavisor log shows a fresh `auth_query` lookup before each failure, so the stored value was compared with the live database password and differs. The owner resets the database password and pastes it into the secret; until then 0800–1000 stay unapplied and nothing on DEV changes. Runs: 37646362409 (secret absent), 37649397943, 37649683119, 37649873035, 37650225769, 37683914418, 38034939932, 38052811836. At 12:39 UTC the owner added a GitHub environment `Supabase` with two secrets. Run 38052811836 (dispatched on `main` at `3326bff`, 12:40 UTC) failed the same way because its job did not reference the environment: environment secrets reach only a job that names it, so the run read the repository secret, and that value does not match the database password. The job now runs in the environment (`environment: Supabase`).
- RE-CHECK (2026-10-10, about 08:45 UTC, `main` at `cd0776a`, read-only through the connector):
  - EXPECTED: `main` carries all ten migrations since PR #16 merged (08:26 UTC); DEV holds them once the workflow has run.
  - ACTUAL: `list_migrations` lists 0100–0700. DEV has no `evidence` schema, no function in `public_api`, no `core.consume_rate_limit`, no storage bucket and no row in `iam.user_profile`; its 25 tables all have RLS enabled. Both fingerprint scripts give the same output on DEV as on a database built from Git 0100–0700 alone (§5).
  - DRIFT: unchanged: 0800–1000 are missing and nothing else differs.
  - CAUSE: the workflow has not connected yet (the STATUS above), and the Supabase GitHub integration does not apply them either (§4.3).
  - REMEDIATION: unchanged: run `hosted-dev.yml` from `main` once the secret holds the current database password.

### 4.3 Supabase GitHub integration finds no migrations — OPEN (no effect on DEV)

- EXPECTED: one documented path changes DEV: Git `main` through `hosted-dev.yml`, which also seeds and runs the suites. Any second path is either deliberate and documented, or inert.
- ACTUAL: the integration (Branching on, production branch `main`) ran once per merge to `main`: 14 runs on 2026-10-10 between 07:45 and 08:41 UTC, one for each of the 14 pull requests merged that morning (#1 first, #12 last), including #3, #7 and #16, which brought 0800, 0900 and 1000. Every run cloned `main`, connected to DEV and logged "All migrations are up to date", "No buckets found", "Skipping configuration for protected branch", "Skipping seed data for protected branch" and "No functions to deploy" (connector `query_logs`, source `workflow_run_logs`). DEV did not change (§4.2 re-check).
- DRIFT: none on DEV. The integration's view is wrong: it reports nothing pending while three migrations are.
- CAUSE (inferred from the log; the integration's settings cannot be read through the connector): the integration applies the `supabase/migrations` folder under its configured working directory (the directory that contains `supabase/`, per the Supabase GitHub-integration guide). This repository keeps it at `infrastructure/supabase`, so with any other working directory the integration finds no migration files.
- REMEDIATION: none needed for DEV, which keeps changing only through `hosted-dev.yml`. Owner decision, not taken here: leave the integration as it is (inert for migrations), or set its working directory to `infrastructure` (Project Settings → Integrations → GitHub). With "Deploy to production" on (the runs indicate it is), the second option makes every merge to `main` apply pending migrations to DEV without seed or suites, and can start billable preview branches for pull requests that touch the directory.

## 5. Verification: no transcription drift in 0100–0700

The hosted schema was compared with a reference database built from Git alone (`node scripts/db/reset.mjs`: compatibility shim, migrations, seeds; PostgreSQL 16, `127.0.0.1:5432`) with two committed scripts, run on DEV through the connector's `execute_sql` and locally through `psql`:

- `scripts/db/fingerprint-schema.sql`: per (object kind, schema), a count and an md5 over sorted `name=signature` lines. Signatures cover functions (body hash, `SECURITY DEFINER`, `proconfig`, volatility, result type, `anon`/`authenticated` EXECUTE), relations (kind, RLS, FORCE RLS, column list), constraints, indexes, triggers, policies, and table, column and schema grants for `anon`, `authenticated`, `service_role`, `cdf_bff`, `cdf_portal` and `PUBLIC`.
- `scripts/db/fingerprint-data.sql`: per reference-data table, the row count and an md5 over the rows without timestamps (`iam.role`, `iam.permission`, `iam.role_permission`, `workflow.workflow_definition`, `workflow.workflow_state`, `workflow.workflow_transition_definition`, `config.setting`).

Result (2026-10-07): every (kind, schema) bucket present on DEV has the same count and fingerprint locally. The buckets that exist only locally are exactly the objects 0800–1000 create. Excluding those objects: `api` functions 28 = 28 (`8c02c07b…`), `authz` functions 16 = 16 (`835ff286…`). Reference data: `config.setting` 4 = 4, `iam.role` 21 = 21, `iam.permission` 19 = 19 (local 21 once 0900 adds the two evidence permissions), `iam.role_permission` 41 = 41 (local 53), `workflow_definition` 1 = 1, `workflow_state` 15 = 15, `workflow_transition_definition` 20 = 20; every fingerprint equal.

Re-check (2026-10-10, about 08:45 UTC): a database built locally from the compatibility shim and Git 0100–0700 alone (no seed) and DEV return identical output from both scripts: all 55 (kind, schema) buckets of `fingerprint-schema.sql` (for example `api` functions 28 `8c02c07b…`, `authz` functions 16 `835ff286…`) and all 7 reference tables of `fingerprint-data.sql` (`iam.role` 21, `iam.permission` 19, `iam.role_permission` 41, `config.setting` 4, `workflow_definition` 1, `workflow_state` 15, `workflow_transition_definition` 20). Nothing on DEV changed since 2026-10-07.

Observation: DEV collates `en_US.UTF-8`, the local database `C.UTF-8`. Text ordering inside `string_agg` therefore differs unless the sort uses `collate "C"`, which both scripts now do. Anything that orders text for a comparison or a stable hash must do the same.

## 6. Advisors (`get_advisors`, 2026-10-07 12:46 on the project thread's clock, 0100–0700 applied, tables empty)

| Advisor     | Level    | Finding                                                                                                                                 | Disposition                                                                                                                                      |
| ----------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| security    | INFO ×3  | `rls_enabled_no_policy` on `case_mgmt.case_number_counter`, `protected_identity.reporter_identity`, `protected_identity.reveal_request` | By design (§22, §87): RLS on with no policy means no application role reads these tables; access only through `SECURITY DEFINER` commands. Kept. |
| performance | INFO ×33 | `unindexed_foreign_keys`                                                                                                                | CDF-66 (severity LOW, priority Medium): indexes in a later migration; irrelevant at demo data volumes.                                           |
| performance | INFO ×12 | `unused_index`                                                                                                                          | Expected on an empty database. No action.                                                                                                        |
| performance | WARN ×1  | `multiple_permissive_policies` on `audit.audit_event`, SELECT, role `authenticated`                                                     | CDF-67 (severity LOW): consolidate the two SELECT policies in a later migration; semantics unchanged (OR of both).                               |

No security finding at WARN or ERROR. Re-read after 0800–1000 are applied.

## 7. Evidence buckets from Git

`20261007001000_evidence_storage_buckets.sql` declares `evidence-quarantine` and `evidence-vault` in `storage.buckets`: `public = false`, `file_size_limit = 26214400` (`EVIDENCE_MAX_BYTES`, §25) and `allowed_mime_types` = `evidence.allowed_content_type`. It is idempotent (`on conflict … do update` forces the bucket private again) and raises if either bucket ends up missing, public or unlimited. `tests/security/storage-policy.spec.ts` asserts the same on every run: no public bucket anywhere, both evidence buckets present and configured, no storage policy for an application role, RLS on `storage.buckets` and `storage.objects`. The adapter's `ensureBuckets()` stays as a fallback and is a no-op once the migration has run. Verified on the local shim: both buckets private, 25 MiB, 16 allowed types; the suite passes (6 tests).

PRODUCTION_SUBSTITUTION_REQUIRED: in production the buckets are Alibaba Cloud OSS buckets created by infrastructure-as-code with WORM retention and KMS encryption (`architecture/PRODUCTION_MAPPING.md`; the substitution issues are CDF-35 to CDF-43).

## 8. DEV validation gates (DEMO is created only when every gate is PASSED)

| Gate                                               | Status               | Evidence or blocker                                                                                                                                                   |
| -------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations 0100–1000 applied, history equals Git   | IN_PROGRESS          | 7 of 10 (§3, re-read 2026-10-10); `hosted-dev.yml` on `main` waits for the database password (§4.2)                                                                   |
| Schema equals Git (fingerprints)                   | PASSED for 0100–0700 | §5 (re-checked 2026-10-10); rerun after 0800–1000                                                                                                                     |
| RLS and security suites against DEV                | NOT_STARTED          | `hosted-dev.yml`, `pnpm test:db` (projects `integration` and `security`)                                                                                              |
| Authorization-isolation suites                     | NOT_STARTED          | same run                                                                                                                                                              |
| Storage security (`storage-policy.spec.ts`)        | NOT_STARTED          | same run; needs 1000                                                                                                                                                  |
| Synthetic seed                                     | NOT_STARTED          | `hosted-dev.yml` seed step; runs only while `iam.user_profile` is empty                                                                                               |
| Supabase Auth adapter against DEV                  | BLOCKED              | DEV has no auth users: `infrastructure/supabase/seed/01_synthetic_users.sql` refers to `scripts/db/seed-auth-users.mjs`, which does not exist (CDF-65, blocks CDF-32) |
| Storage adapter (`SupabaseEvidenceStorage`) on DEV | NOT_STARTED          | needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as CI secrets and an adapter test, which does not exist yet                                                      |
| Evidence workflow end to end on DEV                | NOT_STARTED          | after the storage adapter                                                                                                                                             |
| Regression (lint, typecheck, unit, build)          | PASSED               | PR #16: all 7 required checks green on its merged head (2026-10-10)                                                                                                   |
| Advisors clean (no security WARN or ERROR)         | PASSED at 0700       | §6; reread after 1000                                                                                                                                                 |

## 9. Credentials map (names only)

| Where                                                                                        | Name                                                                                                                                                               | Purpose                                                                                                                                                             | Set by                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| GitHub → Settings → Environments → `Supabase` → Environment secrets; else Repository secrets | `SUPABASE_DB_PASSWORD`                                                                                                                                             | DEV database password (Project Settings → Database); the CLI (`--db-url`) and `psql` connect with it through the session pooler                                     | Fady                                              |
| not needed                                                                                   | `SUPABASE_ACCESS_TOKEN`                                                                                                                                            | the CLI runs unlinked with `--db-url`, so no personal access token is stored anywhere                                                                               | —                                                 |
| same, optional                                                                               | `CDF_BFF_DB_PASSWORD`, `CDF_PORTAL_DB_PASSWORD`                                                                                                                    | stable passwords for the two login roles, same values as the Vercel server-scoped variables; otherwise the workflow sets throwaway ones for the run                 | Fady                                              |
| same, later (storage adapter test)                                                           | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`                                                                                                                        | server-side storage adapter against DEV                                                                                                                             | Fady                                              |
| GitHub → `Supabase` environment or repository variables, optional                            | `SUPABASE_POOLER_HOST`                                                                                                                                             | fallback only, if neither regional pooler host (`aws-1-` / `aws-0-ap-northeast-1.pooler.supabase.com`) accepts the connection; Dashboard → Connect → Session pooler | Fady                                              |
| Vercel, both projects, Sensitive, server scope                                               | `CDF_BFF_DATABASE_URL` or `CDF_PORTAL_DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CDF_DEV_IDENTITY_SECRET`, `CDF_RATE_LIMIT_SALT`, `CDF_REPORT_SECRET_PEPPER`     | per `.env.example`                                                                                                                                                  | Fady (the connector must never hold these values) |
| Vercel, both projects, plain                                                                 | `CDF_ENVIRONMENT`, `CDF_IDENTITY_PROVIDER`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `CDF_EVIDENCE_STORAGE`, `CDF_SESSION_MAX_AGE_SECONDS`, `CDF_SESSION_IDLE_SECONDS` | non-secret configuration                                                                                                                                            | connector, once it has the team scope (§10)       |

None of these is ever `NEXT_PUBLIC_*` (§46, §47). Values are entered where they are used, never in chat, issues or documents.

## 10. Vercel (CDF-33)

Historical record of 2026-10-07. The Vercel projects are tracked in CDF-33 from 2026-10-10 on.

- Attempt, 2026-10-07: `create_project` under team `malsalehs-projects` (`team_tJxfhTJObyoeBcCmY0SQnFHL`) returned HTTP 403: the connector token has no scope for that team. The team is listed, but nothing in it can be created or changed.
- Remediation, Fady: claude.ai → Settings → Connectors → Vercel → Disconnect, then Connect again and, on Vercel's authorisation screen, choose the `malsalehs-projects` scope with access to all projects. Connectors are read when a session starts, so the projects are created from a new thread afterwards.
- Plan once scoped: `cdf-whistleblowing` (root `apps/whistleblowing-web`) and `cdf-investigations` (root `apps/investigation-web`), framework Next.js, Git repository `mh1m1m/CDF_Case_Management`, both on DEV; server-scoped variables as in §9 (Sensitive ones entered by Fady); preview deployments from `feature/CDF-44-evidence-custody` (PR #7); production deployments only after the stack merges; verify that no service-role key reaches a client bundle and that investigation pages and the evidence download route answer with a `Cache-Control` that forbids shared caching (`no-store`); attach the preview URLs to CDF-33.

## 11. Not done, by decision

- `cdf-case-demo` is not created (§1).
- No destructive operation ran on DEV: no reset, drop, truncate or delete. The only UPDATE was the history repair in §4.1.

## 12. How to re-run

1. GitHub → Actions → "Hosted DEV (Supabase)" → Run workflow on `main` (inputs `seed` and `test`, both default true), or `POST /repos/mh1m1m/CDF_Case_Management/actions/workflows/hosted-dev.yml/dispatches` with `ref` `main`. Until PR #16 merged (2026-10-10) the workflow ran on pushes to `feature/CDF-32-hosted-dev`.
2. Read the run summary: migration history before and after, seed result, suite results.
3. Run `scripts/db/fingerprint-schema.sql` and `scripts/db/fingerprint-data.sql` on DEV (connector `execute_sql`) and locally (`psql -f`); every bucket must match, `evidence` and `public_api` included.
4. Reread the advisors; update §3, §6 and §8 here and the evidence comment on CDF-32 with the run ID and commit.
