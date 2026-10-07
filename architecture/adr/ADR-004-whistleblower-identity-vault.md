# ADR-004: Whistleblower identity vault

- **Status:** Accepted (2026-10-07)
- **Protocol:** §22, §23, §30

## Context
Reporter identity is the most sensitive datum in the system. The baseline kept it in a separate store but displayed it on page load to any role holding a permission, and leaked it into audit payloads.

## Decision
- Schema `protected_identity`; table `reporter_identity(wb_id, ...)`. No grants of any kind to `anon` or `authenticated`; RLS enabled and forced with **no** policies.
- Reports and cases reference only the opaque **WB-ID** (`intake.report.wb_id`, `case_mgmt.case_record.reporter_wb_id`).
- Identity is written only by `public_api.submit_report` (when the reporter chooses to identify) and read only by `api.resolve_reporter_identity(case_id, justification)`, which requires: active user, `REPORTER_IDENTITY_REVEAL` permission, `authz.can_view_case`, no conflict, justification of at least 20 characters, and — if the case has `identity_reveal_requires_approval` — an approved reveal request. It writes `REPORTER_IDENTITY_REVEALED` (category SECURITY) before returning.
- Audit payloads never include identity fields; the audit command takes explicit metadata, never a whole row.

## Consequences
- + Investigators can work cases without ever being able to query identity.
- + Every reveal is attributable and justified.
- − Reveal approval workflow is minimal in the first slice (flag + approval record); a fuller dual-control flow is backlog.

## Production mapping
Same schema on RDS; additionally column-level encryption of identity fields with keys from Alibaba KMS through `KeyManagementProvider` (PRODUCTION_SUBSTITUTION_REQUIRED for envelope encryption).
