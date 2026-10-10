# Security Policy

## Classification

This repository is a **synthetic-data reference implementation**. It is not CDF production, not an approved CDF cloud environment, and not an authorised whistleblowing channel. Do not submit real reports, real personal data, or real CDF documents to any deployment of it.

## Reporting a vulnerability

The repository is private. Report vulnerabilities to the repository owner (@mh1m1m) directly, or as a GitHub security advisory draft if you have access to the repository's "Security" tab. Do not put security problems in ordinary issues or pull request comments. Include reproduction steps against synthetic data only.

## Security model (summary)

- Two separate applications: a public portal with no sessions and an authenticated investigation app (ADR-002).
- PostgreSQL Row Level Security on every application table, default deny; writes only through audited command functions (ADR-003).
- Whistleblower identity in a separate schema with no grants; reveal requires permission, case access, justification and is audited (ADR-004).
- Append-only, hash-chained audit ledger (ADR-005).
- Private evidence storage behind an adapter; no overwrite or delete paths (ADR-006).
- Secrets only in local environment files (git-ignored), GitHub secrets and Vercel environment variables; never `NEXT_PUBLIC_*`.

Full rules: [`architecture/SECURITY_RULES.md`](architecture/SECURITY_RULES.md). Threat model: [`architecture/threat-model/THREAT_MODEL.md`](architecture/threat-model/THREAT_MODEL.md).

## Prototype substitutions

Capabilities simulated in the prototype are marked `PRODUCTION_SUBSTITUTION_REQUIRED` and listed in [`architecture/PRODUCTION_MAPPING.md`](architecture/PRODUCTION_MAPPING.md). They are not production controls.
