# Security Policy

## Classification

This repository is a **synthetic-data reference implementation**. It is not CDF production, not an approved CDF cloud environment, and not an authorised whistleblowing channel. Do not submit real reports, real personal data, or real CDF documents to any deployment of it.

## Reporting a vulnerability

Report vulnerabilities privately to the repository owner (@prodya-dev) through GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability"). Do not open public issues for security problems. Include reproduction steps against synthetic data only.

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
