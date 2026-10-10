# ADR-002: Separate public and internal applications

- **Status:** Accepted (2026-10-07)
- **Protocol:** §5, §11, §23, §46

## Context
The whistleblowing portal faces the untrusted internet and must allow anonymous submission. The investigation application holds the most sensitive data in the platform. Serving both from one deployment (different routes) would share cookies, middleware, secrets, dependencies and blast radius.

## Decision
Two Next.js applications, deployed as **two Vercel projects**:

| | whistleblowing-web | investigation-web |
|---|---|---|
| Trust | Untrusted | Authenticated |
| User sessions | None (Report ID + secret per request) | IdP session, httpOnly cookie |
| DB login | `cdf_portal` (NOINHERIT → `anon` only) | `cdf_bff` (NOINHERIT → `authenticated`) |
| DB surface | `EXECUTE public_api.*` only | RLS-filtered `SELECT` + `EXECUTE api.*` |
| Secrets | portal DB URL, report-secret pepper | BFF DB URL, IdP settings, storage service key |

Shared code is limited to UI components, validation schemas, contracts, i18n and pure domain logic.

## Consequences
- + A compromise of the portal cannot read case data: its DB login cannot become `authenticated`.
- + Separate security headers, rate limits and caching policies.
- − Two deployments to operate. Accepted.

## Production mapping
Two separately deployed services (e.g. separate ACK workloads / ingress) with separate network policies; the portal in a DMZ-style zone.
