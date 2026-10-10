# ADR-005: Append-only, hash-chained audit ledger

- **Status:** Accepted (2026-10-07)
- **Protocol:** §29, §30, §74, §83

## Decision
- Table `audit.audit_event` with: `seq` (identity), `event_id`, `occurred_at`, `actor_id`, `actor_roles`, `case_id`, `action`, `category` (BUSINESS | SECURITY | ADMIN), `object_type`, `object_id`, `request_id`, `reason`, `outcome` (SUCCESS | DENIED | FAILURE), `metadata` (jsonb, no personal data by convention and review), `previous_hash`, `event_hash`.
- Inserted only by `audit.record_event(...)` (`SECURITY DEFINER`), which takes a transaction-scoped advisory lock, reads the last hash and computes `event_hash = sha256(previous_hash || canonical_payload)` using PostgreSQL's built-in `sha256()`.
- No application role has INSERT/UPDATE/DELETE/TRUNCATE privileges; BEFORE UPDATE/DELETE and TRUNCATE triggers raise exceptions even for the owner; `audit.verify_chain()` recomputes and reports the first broken link.
- Reading is permission-scoped: `AUDIT_VIEW` (INTERNAL_AUDIT) sees BUSINESS/ADMIN metadata; `SECURITY_EVENT_VIEW` (SOC_ANALYST) sees SECURITY events.
- `SecurityEventSink` port: `PostgresAuditSink` (prototype) records application-detected security events (e.g. denied access in the BFF) via `api.record_security_event`.

## Consequences
- + Tamper-evident; ordinary roles cannot modify history.
- − The advisory lock serialises audit writes. Acceptable at prototype scale (risk R6).
- − A database superuser can still disable triggers. This is why production ships events to SLS/SIEM as well (PRODUCTION_SUBSTITUTION_REQUIRED for external immutability).

## Production mapping
Application audit table on RDS + streaming to Alibaba SLS → CDF SIEM; periodic anchoring of chain heads in WORM storage.
