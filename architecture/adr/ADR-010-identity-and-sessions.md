# ADR-010: Identity providers and session handling

- **Status:** Accepted (2026-10-07)
- **Protocol:** §7, §41, §46, §47, §68

## Decision

- Port `IdentityProvider { signIn, signOut, getVerifiedIdentity }` returning `{ subject, email, claims }` after **server-side verification**.
- `SupabaseIdentityProvider` (DEV/DEMO): Supabase Auth email/password via a **server-only** client whose session cookies are `httpOnly`, `Secure`, `SameSite=Lax`. No browser Supabase client exists, so no token is reachable from JavaScript or stored in `localStorage`.
- `LocalDevIdentityProvider` (local and CI only): signs a short-lived HS256 token for seeded synthetic users. It **refuses to construct** when `VERCEL` is set or `CDF_ENVIRONMENT` is not `local`/`test`. PRODUCTION_SUBSTITUTION_REQUIRED; exists because the full Supabase Auth container is not always available (e.g. restricted CI sandboxes).
- Future `CdfOidcIdentityProvider` maps CDF IdP claims to the same `{ subject, email }` shape.
- Authorization never trusts role claims from the token. Roles and permissions come from `iam.*` in the database, so IdP changes cannot grant access.
- Idle timeout and absolute session lifetime are enforced server-side.

## Production mapping

CDF corporate IdP (OIDC) with enterprise lifecycle and conditional access; the `iam` tables remain the authorization source.
