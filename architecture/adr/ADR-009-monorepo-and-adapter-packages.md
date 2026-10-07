# ADR-009: Monorepo layout and adapter package

- **Status:** Accepted (2026-10-07)
- **Protocol:** §8 (permitted improvements require an ADR)

## Decision
Follow the §8 layout with these additions:
- `packages/infrastructure` holds every adapter (`postgres/`, `supabase/`, `prototype/`). This makes "no Supabase SDK in domain code" mechanically checkable.
- `infrastructure/supabase/tests/bootstrap/` holds the plain-PostgreSQL compatibility shim (ADR-008).
- `scripts/` holds database reset/apply and evidence-generation scripts.
- Supabase CLI is invoked with `--workdir infrastructure`.

Dependency direction: `apps → application → (domain, workflow, authorization, validation, contracts, audit)`; `apps → infrastructure → application ports`. `domain`, `workflow`, `authorization`, `contracts`, `validation` import nothing from `application`, `infrastructure` or any framework.
