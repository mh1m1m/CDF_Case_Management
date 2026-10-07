# ADR-008: Production portability strategy

- **Status:** Accepted (2026-10-07)
- **Protocol:** §6, §7, §67, §85, §86, §94

## Decision
1. **Security invariants live in PostgreSQL** (RLS, `authz.*`, command functions, audit ledger, identity vault, workflow guards). PostgreSQL is the one component that survives the production migration (Supabase Postgres → RDS PostgreSQL), while the Next.js BFF is expected to be replaced or fronted by ASP.NET Core. Putting invariants in the database preserves them across that change.
2. **Pure TypeScript domain packages** carry the same rules for the UI and early denial, with no infrastructure imports.
3. **Ports and adapters** for everything vendor-specific (identity, storage, keys, security sink, malware scanning, rate limiting).
4. **Vanilla-PostgreSQL proof:** the schema and security suites run on plain PostgreSQL 16 with a small compatibility shim (`infrastructure/supabase/tests/bootstrap/`) that creates the `anon`/`authenticated`/`service_role` roles and minimal `auth`/`storage` stubs. CI also applies migrations to the real Supabase stack.
5. No Vercel-only runtime features in core paths (no Edge-only APIs, no Vercel KV/Blob); standard Node.js runtime.

See [`PRODUCTION_MAPPING.md`](../PRODUCTION_MAPPING.md).
