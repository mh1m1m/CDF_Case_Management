# Contributing

Read [`CLAUDE.md`](CLAUDE.md) first. It is the governing rule set for humans and for Claude Code.

## Workflow

1. Branch from `main`: `phase-N/short-description` or `feat/…`, `fix/…`.
2. Keep each PR a working vertical step: migration + RLS + server authorization + audit + tests + docs.
3. Open a PR using the template. CI must be green. `main` is protected; merges need review and are never performed by Claude without explicit instruction.

## Database changes

- New migration file in `infrastructure/supabase/migrations/` named `YYYYMMDDHHMMSS_description.sql`. Never edit an applied migration; add a new one.
- Every new table: RLS enabled, explicit policies, no INSERT/UPDATE/DELETE grants to `anon`/`authenticated`. Writes go through `api.*` / `public_api.*` command functions that write audit events.
- Run `pnpm db:reset && pnpm test:db` locally.
- Destructive changes (drops, type narrowing, data rewrites) need a human decision recorded in the PR.

## Dependencies

Every new dependency needs a one-line justification in the PR: why platform capability is insufficient, maintenance status, licence, and known vulnerabilities (protocol §69).

The Supabase CLI in CI is pinned to an exact version (input `version` of `supabase/setup-cli` in `.github/workflows/ci.yml` and `hosted-dev.yml`), because `latest` makes an unauthenticated GitHub API lookup that hits the rate limit (CDF-86). Dependabot updates the action, not this input. To move to a newer CLI, change both lines in one PR; the Supabase compatibility job proves the new version.

## Data

Synthetic data only (`@example.test`, "Employee Alpha", `CDF-DEMO-2026-0001`). The database rejects non-`@example.test` user emails by design.

## Tests

- `pnpm test` unit · `pnpm test:db` integration + security (needs a database) · `pnpm test:e2e` Playwright · `pnpm test:a11y`.
- Authorization changes require positive **and** negative security tests (§20, §73).
