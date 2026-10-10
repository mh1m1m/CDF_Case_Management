# CDF Case Management & Investigation Platform — Reference Implementation

> **SYNTHETIC-DATA REFERENCE IMPLEMENTATION.** This is not CDF production, not hosted in Saudi Arabia, not
> regulatory-compliant hosting and not an authorised whistleblowing channel. Never enter real reports, names,
> documents or credentials. All data is fictional (`@example.test`, `CDF-DEMO-…`).

A production-architecture emulator of the CDF platform (منصة إدارة القضايا والتحقيقات بصندوق التنمية الثقافي),
built to prove the security, data and workflow model before the production build on ASP.NET Core and Alibaba
Cloud Riyadh. See [`architecture/PRODUCTION_MAPPING.md`](architecture/PRODUCTION_MAPPING.md) for what each
prototype component becomes in production.

## What works today (first secure vertical slice)

Anonymous report → triage → create case → assign investigator → open investigation, with database, RLS,
audit, workflow, UI and tests:

| Area                                                | Delivered                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public portal (`apps/whistleblowing-web`, :3001)    | Anonymous or identified report, one-time Report ID + secret, follow-up with coarse status, two-way messages, rate limiting                                                                                                                |
| Investigation app (`apps/investigation-web`, :3000) | Sign-in, intake queue, triage, case creation, case page (progress, details, team, conflict declaration, workflow steps with reasons, audit timeline), evidence upload with scanning, versions, chain of custody and audited downloads     |
| Database (`infrastructure/supabase`)                | 9 migrations: IAM, append-only hash-chained audit ledger, intake, case master and ACL, identity vault with dual-control reveal, `CDF_CASE_V1` workflow, `api.*` and `public_api.*` commands, evidence with immutable versions and custody |
| Tests                                               | Unit, integration, security (RLS coverage, isolation, vault, audit, admin separation, portal, injection, evidence access, storage policy), Playwright end-to-end and axe WCAG 2.1 AA in Arabic and English                                |

Status by phase and control: [`PROJECT_STATUS.md`](PROJECT_STATUS.md).

## Architecture in one paragraph

Two Next.js apps share packages but never a security context. Business rules live in pure packages
(`domain`, `workflow`, `authorization`, `validation`) and in database command functions. Apps reach the
database only server-side, through NOINHERIT login roles (`cdf_bff`, `cdf_portal`) that hold no privileges
and assume `authenticated` or `anon` per transaction with the verified subject in `request.jwt.claims`.
Reads go through RLS; writes go only through `SECURITY DEFINER` commands that re-check authorization and
write the audit event in the same transaction. Reporter identity sits in a schema no application role can
read. Details: [`architecture/`](architecture/) — ADRs, data model, workflow, security rules, threat model.

```
apps/            whistleblowing-web, investigation-web (Next.js 16, React 19, Tailwind 4)
packages/        contracts, domain, workflow, authorization, validation, audit, application,
                 infrastructure (only place that may import @supabase/* or postgres), ui, i18n, config
infrastructure/  supabase/{migrations, seed, policies, functions, tests}
tests/           security, integration, e2e, accessibility (unit tests sit next to their code)
architecture/    ADRs, plan, data model, workflow, security rules, threat model, production mapping
compliance/      requirements traceability, evidence
```

## Run it locally

Requirements: Node 22, pnpm 10, PostgreSQL 16+ with `psql` (or the Supabase CLI).

```bash
pnpm install
cp .env.example apps/investigation-web/.env.local   # fill in values; see the comments in the file
cp .env.example apps/whistleblowing-web/.env.local
pnpm db:reset          # rebuilds the local DB from migrations + synthetic seed (refuses non-loopback hosts)
pnpm build && pnpm --parallel --filter ./apps/* start
```

`pnpm db:reset` targets `CDF_ADMIN_DATABASE_URL` (default `postgresql://postgres@127.0.0.1:54322/postgres`).
With plain PostgreSQL it first applies `infrastructure/supabase/tests/bootstrap/00_supabase_compat.sql`; with
`CDF_DB_MODE=supabase` it runs `supabase db reset` instead.

Synthetic users (password = your `CDF_DEV_PASSWORD`, local-dev identity only):

| Email                                                         | Role              | Demonstrates                                             |
| ------------------------------------------------------------- | ----------------- | -------------------------------------------------------- |
| `intake@example.test`                                         | Intake officer    | Sees reports, not cases                                  |
| `triage@example.test`                                         | Triage officer    | Triage, create case, screening                           |
| `casemanager@example.test`                                    | Case manager      | All non-restricted cases, assignment, workflow           |
| `investigator.a@example.test` / `investigator.b@example.test` | Investigator      | Only assigned cases; conflict removes access             |
| `lead@example.test`                                           | Lead investigator | Assigns within own cases                                 |
| `grc.director@example.test`, `grc.deputy@example.test`        | GRC director      | Approval, restricted cases, dual-control identity reveal |
| `admin@example.test`                                          | Platform admin    | Users and roles, no case content                         |
| `audit@example.test`, `soc@example.test`, `dpo@example.test`  | Oversight         | Audit or security events only                            |
| `revoked@example.test`                                        | Revoked           | Cannot sign in or act                                    |

## Tests

```bash
pnpm lint && pnpm typecheck && pnpm test   # static checks + unit
pnpm test:db                               # integration + security against the local DB
pnpm test:e2e && pnpm test:a11y            # Playwright (starts both apps from their builds)
pnpm db:policies                           # regenerate the access-model snapshot (CI fails on drift)
```

CI (`.github/workflows/ci.yml`) runs all of the above, plus the same database suites on the Supabase CLI stack,
a dependency audit with SBOM, gitleaks and CodeQL. Merging to `main` requires a human (`CLAUDE.md`).

## Security rules that never bend

Read [`CLAUDE.md`](CLAUDE.md) and [`architecture/SECURITY_RULES.md`](architecture/SECURITY_RULES.md). In short:
no service-role key outside server adapters and never `NEXT_PUBLIC_*`; no secrets in Git; RLS on every table;
no write grants to application roles; no audit modification path; no UI-only authorization; synthetic data only.
Every simulated control is marked `PRODUCTION_SUBSTITUTION_REQUIRED`.
