# CLAUDE.md — Governing Rules for this Repository

This file persists the **CDF Case Management & Investigation Platform — Claude Code Full-Stack Reference Implementation Engine, v1.0** protocol. It is the highest authority for any work in this repository (protocol §4). Where this file summarises, the full protocol text governs; section numbers (§) refer to it.

## 0. What this repository is

- **Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION.** A production-architecture emulator for the CDF Case Management & Investigation Platform (منصة إدارة القضايا والتحقيقات بصندوق التنمية الثقافي).
- It is **not** CDF production, not Saudi-resident hosting, not an authorised whistleblowing channel, and not a replacement for Alibaba Cloud production architecture (§1). Never describe it as any of these.
- Target production path: Next.js → ASP.NET Core → Alibaba Cloud Riyadh → RDS PostgreSQL → OSS → KMS/HSM → SLS/SIEM → CDF corporate IdP. Prototype: Next.js + Supabase (Postgres, Auth, Storage) + Vercel.

## 1. Data safety (§2) — absolute

- **Real CDF data is prohibited**: no real reports, allegations, cases, identities, personal data, confidential documents, evidence, credentials or regulatory data.
- Synthetic only. Use names like _Employee Alpha_, _Investigator Beta_, _Witness Gamma_; case numbers like `CDF-DEMO-2026-0001`; emails `@example.test`.

## 2. Authority order (§4)

1. This file / the governing protocol
2. CDF Technical Architecture & Engineering Standards
3. CDF Compliance Master Workbook / architecture requirements
4. Approved ADRs (`architecture/adr/`)
5. Repository engineering rules (this file §6–§9, CONTRIBUTING.md)
6. Baseline ZIP implementation (reference only — see BASELINE_ANALYSIS.md)
7. Developer preference

Baseline code never overrides approved architecture.

## 3. Architecture rules

- Two separate Next.js apps (§11): `apps/whistleblowing-web` (public, untrusted) and `apps/investigation-web` (authenticated). They share packages, **never security context**: different DB login roles, different secrets, different deployments.
- Next.js is presentation + BFF + UI orchestration (§10). Business rules live in `packages/domain`, `packages/workflow`, `packages/authorization`, `packages/application` and in database command functions.
- Every infrastructure dependency sits behind a port (§6, §7): `IdentityProvider`, `EvidenceStorage`, `SecurityEventSink`, `KeyManagementProvider`, `MalwareScanner`, `RateLimiter`. Implementations live only in `packages/infrastructure`.
- **No `@supabase/*` import outside `packages/infrastructure`.** (Lint-enforced.)
- Data access is server-side SQL inside a per-transaction security context (`SET LOCAL ROLE authenticated` + `request.jwt.claims`). The browser never talks to PostgREST or Storage directly.
- Writes go through `api.*` (authenticated) or `public_api.*` (anon) command functions only. Application roles have **no INSERT/UPDATE/DELETE grants on tables**. Every command writes its audit event in the same transaction.

## 4. Security rules (non-negotiable)

- RLS is mandatory on every table in application schemas, **enabled**, default deny, with no table privileges beyond what a policy needs (§18). Tables are owned by the migration role, which no application login can assume; that owner is what `SECURITY DEFINER` commands run as. Never disable RLS for convenience (§86, §87).
- Authorization is enforced twice: application pre-check (`@cdf/authorization`) **and** database (RLS + `authz.*` functions) (§19).
- `PLATFORM_ADMIN` / `DB_ADMIN` never imply case-content access (§21).
- Whistleblower identity lives only in `protected_identity`; no application role can SELECT it; resolution only via `api.resolve_reporter_identity()` with permission + case access + justification + audit (§22).
- Anonymous portal: Report ID + high-entropy secret, HMAC-stored; never reveal whether a Report ID exists; rate-limit at the boundary (§23).
- Evidence: private storage only, random immutable object keys, never overwrite, no user hard delete (§24–§27).
- Audit ledger is append-only; no application path can UPDATE/DELETE it (§29, §74).
- Notifications carry no investigation content (§39). Search applies authorization before results, counts, facets or snippets (§40).
- Service-role key: never in the browser, never `NEXT_PUBLIC_*`, server-side storage adapter only (§46, §47).
- No secrets in Git. `.env.example` holds names only (§48).
- Errors shown to users are generic with a correlation ID; never stack traces, SQL errors or internal relationships (§82). Never log passwords, tokens, reporter identities or evidence content (§83).
- Sequential business numbers are display identifiers only; UUIDs are the keys, and every lookup is authorised (§87).

## 5. Prohibited (§53, §87)

Exposing the service-role key client-side · public sensitive storage · disabling RLS · `select *` grants to all authenticated users · real or production data · audit modification APIs · UI-only authorization · overwriting evidence · unrestricted admin dashboards · committing secrets · bypassing migrations · merging failing CI · removing or skipping tests to pass builds · sequential guessable IDs as sole identifiers · exposing protected identity to investigators · Vercel/Supabase-specific behaviour inside domain rules · presenting prototype substitutions as production controls · **merging to `main` without explicit instruction from an authorised human**.

## 6. Database rules (§12–§14)

- Git is authoritative; the live database is not. Every schema change is a numbered migration in `infrastructure/supabase/migrations/` (`YYYYMMDDHHMMSS_description.sql`). Never edit the hosted schema by hand.
- Reference data (roles, permissions, workflow definitions, form definitions) ships in migrations. Synthetic demo data ships in `infrastructure/supabase/seed/`.
- UUID primary keys (`gen_random_uuid()`), readable business identifiers alongside. FKs, unique, check and not-null constraints. JSONB only where flexibility is genuinely needed.
- Every new table: `ENABLE ROW LEVEL SECURITY`, explicit policies, no write grants to `anon`/`authenticated`. `rls-coverage.spec.ts` fails otherwise.
- `SECURITY DEFINER` functions must `SET search_path = ''` and schema-qualify everything.
- Path: code → migration → review → local test → CI → DEV → DEMO.
- Destructive migrations need a human decision first (§88).

## 7. Definition of done for security-sensitive work (§65, §96)

A feature is done only when all hold: requirement/ADR identified · migration committed · RLS policy · server authorization · audit events · automated tests · **negative tests** · docs updated · no failing security test · no secrets · typecheck passes · build passes.

For every feature answer: _What requirement does this satisfy? Where is access control enforced? What audit event does it create? How is it tested? What production component replaces its prototype infrastructure?_

Mark simulated capabilities `PRODUCTION_SUBSTITUTION_REQUIRED` in code and docs (§68).

## 8. Working method (§54, §88–§90)

- Phase → epic → vertical slice → task → test → review. Every commit leaves the repo working.
- Feature branches + PRs. Never merge to `main` autonomously.
- Stop for a human decision on: material architecture change, security trade-off, destructive migration, loss of a baseline feature, new external service, sensitive dependency, database redesign, significant access-model change.
- After each major task report: what changed · files · migrations · security controls affected · tests added · test results · open issues · technical debt · next task.
- Never hide failure. Failing tests are reported. Unimplemented requirements are marked incomplete. Status in `PROJECT_STATUS.md` uses COMPLETE / IN_PROGRESS / BLOCKED / NOT_STARTED / PRODUCTION_SUBSTITUTION_REQUIRED.

## 9. Engineering conventions

- pnpm workspaces; Node 22; TypeScript `strict` everywhere; ESM.
- Dependencies need justification (§69): prefer platform capabilities; record why in the PR.
- Arabic RTL and English LTR from the start (§42). All user-facing text comes from `packages/i18n`; no hard-coded strings in components. Use logical CSS properties.
- Forms: React Hook Form + Zod; the same Zod schema is re-validated on the server (§45).
- Tests: Vitest (unit, integration, security), Playwright (e2e, accessibility). Security tests are mandatory for any authorization change (§20).
- `data-testid` on interactive elements used by e2e tests.

## 10. Useful commands

```bash
pnpm install
pnpm db:reset          # rebuild local DB from migrations + seed (Supabase CLI if running, else plain PostgreSQL + shim)
pnpm dev               # both apps (investigation-web :3000, whistleblowing-web :3001)
pnpm lint && pnpm typecheck
pnpm test              # unit
pnpm test:db           # integration + security against the database
pnpm test:e2e          # Playwright
```
