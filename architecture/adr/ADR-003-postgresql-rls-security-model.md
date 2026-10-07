# ADR-003: PostgreSQL / RLS security model and command-only writes

- **Status:** Accepted (2026-10-07)
- **Protocol:** §18, §19, §46, §73, §86, §87

## Context
Authorization must not depend on the UI, must be defense-in-depth, and must survive the move from Supabase to RDS PostgreSQL and from Next.js BFF to ASP.NET Core.

## Decision
1. **Security context per transaction.** The BFF opens a transaction, runs `SET LOCAL ROLE authenticated`, `set_config('request.jwt.claims', <verified claims>, true)` and `set_config('cdf.request_id', <uuid>, true)`. The connecting login role is `NOINHERIT` and has no privileges of its own, so a missing context fails closed.
2. **Identity in SQL** comes from `authz.current_user_id()`, which returns the `sub` claim only when it maps to an `ACTIVE` `iam.user_profile`. It does not depend on Supabase's `auth` schema.
3. **Reads** are `SELECT` on tables protected by RLS policies that call central `authz.can_*()` functions (RBAC + ABAC + case ACL + conflict). RLS is `ENABLE`d and `FORCE`d on every application table; default is deny.
4. **Writes** happen only through `api.*` (authenticated) and `public_api.*` (anon) `SECURITY DEFINER` command functions with `search_path = ''`. Each command re-checks authorization, validates state (workflow guards), performs the change, and writes the audit event **in the same transaction**. Application roles hold no INSERT/UPDATE/DELETE privileges on any table.
5. The application layer mirrors the same predicates (`@cdf/authorization`) for early, user-friendly denial and to decide what UI to render. Both layers are tested against one fixture matrix.

## Consequences
- + Every state change is named, authorised and audited; there is no "raw update" path to forget.
- + Policies and commands are plain PostgreSQL, portable to RDS.
- + Testable directly in SQL by switching roles and claims (§73).
- − More SQL to write and review than ORM-style CRUD. Accepted: this is the security model.
- − `SECURITY DEFINER` functions are powerful; mitigated by fixed `search_path`, owner = migration role, and the `rls-coverage` / function-security test suite.

## Production mapping
Unchanged on RDS PostgreSQL. ASP.NET Core would set the same session settings per transaction (Npgsql) from CDF IdP claims.
