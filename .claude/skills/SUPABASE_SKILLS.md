# Supabase MCP server and agent skills (CDF-70)

## What is here

| Path                                               | What                                                                                                            | Source                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `.mcp.json` → `supabase`                           | Hosted Supabase MCP server, scoped to the DEV project `blycdqjphsxvyiuoommv` (`cdf-case-dev`) via `project_ref` | `claude mcp add --scope project --transport http supabase "<url>"`                                                      |
| `.claude/skills/supabase/`                         | `supabase` skill v0.1.2                                                                                         | [supabase/agent-skills@c9be0e9](https://github.com/supabase/agent-skills/tree/c9be0e931b7930f7d02126d04774d904c381e7d7) |
| `.claude/skills/supabase-postgres-best-practices/` | `supabase-postgres-best-practices` skill v1.1.1                                                                 | same commit                                                                                                             |
| `SUPABASE_SKILLS_LICENSE`                          | MIT licence of the upstream repo                                                                                | same commit                                                                                                             |

The skill folders are copied byte-for-byte from the pinned commit (this is what `npx skills add supabase/agent-skills` installs) and are excluded from Prettier so they stay diffable against upstream. Update them only by re-copying a newer pinned commit and reviewing the diff.

`.mcp.json` holds **no token, key or connection string**. Each developer authenticates with OAuth on their own machine; the token stays in the local Claude Code credential store, never in Git.

## Setting it up (developer machine, in the repo folder)

1. `claude` → approve the project MCP server `supabase` when asked (or `claude mcp list` to check it is listed).
2. In a regular terminal (not an IDE extension): `claude /mcp` → select `supabase` → **Authenticate** → finish the browser sign-in with the Supabase account that owns `cdf-case-dev`.
3. Restart the session; the `mcp__supabase__*` tools appear.

Cloud sessions (claude.ai project threads) cannot run the browser OAuth step. They keep using the claude.ai Supabase connector, which is already connected; this file changes nothing for them.

## Project rules take precedence over the skills

`CLAUDE.md` and the approved ADRs outrank these skills (CLAUDE.md §2). Where they differ:

- **Git migrations are authoritative.** Every schema change is a numbered file in `infrastructure/supabase/migrations/`. Do **not** follow the skill's advice to iterate with MCP `execute_sql` / `apply_migration` against the hosted DEV project, and do not use `supabase db pull` to generate migrations from it. Use the local reference database (`pnpm db:reset`) for iteration.
- **Hosted DEV is changed only by the GitHub Actions hosted-dev workflow** (CDF-32). Through MCP, hosted DEV is read-mostly: `list_tables`, `list_migrations`, `get_advisors`, `get_logs`, `search_docs`, read-only `execute_sql`. Any live change is drift and must be recorded as EXPECTED / ACTUAL / DRIFT / CAUSE / REMEDIATION.
- **`SECURITY DEFINER`.** The skill says to prefer `SECURITY INVOKER`. This platform deliberately routes every write through `SECURITY DEFINER` command functions in `api.*` / `public_api.*`, owned by the migration role, with explicit authorization checks and audit in the same transaction (CLAUDE.md §3–§4). Keep that design; the skill's warnings (pinned `search_path`, explicit authz check, no exposure through `public`) still apply.
- **No real data** through the MCP server, ever (CLAUDE.md §1). DEV holds synthetic data only.
- **Skill feedback.** `supabase/references/skill-feedback.md` tells the agent to open issues on the public `supabase/agent-skills` repo. That posts outside the project: only with Fady's explicit approval, and never with project content.
- **Tokens.** If a non-interactive client ever needs a bearer token, use a Supabase _scoped_ personal access token limited to `cdf-case-dev`, stored as a local environment variable or repository secret, never committed.

## Feature groups enabled

`docs, account, database, debugging, development, functions, branching` (as given in the Supabase dashboard setup snippet). With `project_ref` set, Supabase removes account-level tools (listing or creating projects), so the server can only see `cdf-case-dev`. To make the server read-only, append `&read_only=true` to the URL; that is the safer default for anyone who does not need to run SQL.
