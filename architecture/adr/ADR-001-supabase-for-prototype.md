# ADR-001: Supabase as prototype infrastructure

- **Status:** Accepted (2026-10-07)
- **Protocol:** §5, §6, §12, §86

## Context
The reference implementation needs PostgreSQL, authentication and object storage on free tiers, reproducible locally, without becoming coupled to a vendor that production (Alibaba Cloud Riyadh) will not use.

## Decision
- Use Supabase for **PostgreSQL** (database), **Auth** (prototype identity) and **Storage** (evidence objects) in two hosted projects: `cdf-case-dev` and `cdf-case-demo` (§12).
- Treat Supabase strictly as an infrastructure adapter:
  - Database access is plain SQL over the PostgreSQL wire protocol (postgres.js), not PostgREST. The schema uses only core PostgreSQL features (no Supabase-only extensions) so it runs on vanilla PostgreSQL.
  - Auth is behind `IdentityProvider`; Storage behind `EvidenceStorage`.
  - No `@supabase/*` import outside `packages/infrastructure` (lint rule).
- PostgREST exposure is minimised: application schemas are **not** added to the API's exposed schemas, and nothing application-owned lives in `public`.
- The Supabase CLI project lives at `infrastructure/supabase/` and is run with `supabase --workdir infrastructure`.

## Consequences
- + Free, reproducible (`supabase start` / `supabase db reset`), with RLS and Auth available.
- + Portability: the SQL is the same SQL RDS PostgreSQL will run.
- − We do not use Supabase's auto-generated REST/realtime features. Accepted: they would bypass the BFF boundary.
- − Free-tier projects pause; DEMO must be resettable from Git (§12).

## Production mapping
Supabase Postgres → Alibaba RDS PostgreSQL · Supabase Auth → CDF corporate IdP (OIDC) · Supabase Storage → Alibaba OSS (with retention/WORM).
