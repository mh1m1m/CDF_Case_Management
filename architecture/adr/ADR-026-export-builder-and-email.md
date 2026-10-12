# ADR-026: Export Builder and external email

- **Status:** Proposed (2026-10-12); implemented in migration 1930 pending review (ADR-032). Linear CDF-196. Security-sensitive.
- **Protocol:** §19, §29, §40, §46, §82–§83, §87; owner Q&A Q99.

## Decision

1. Schema `exchange`: `export_request` (format PDF / XLSX / EMAIL, purpose, justification, classification, status), `export_item` (object type + id), `export_recipient` (INTERNAL / EXTERNAL), `export_approval`.
2. Authorization is checked **per item at build time** with the same `authz.*` predicates as the UI; refused items are listed as withheld, never silently dropped.
3. Every export has a preview (hash recorded) and an audit trail (EXPORT_REQUESTED, EXPORT_APPROVED, EXPORT_GENERATED, EXPORT_SENT).
4. External email always requires a justification and a classification check; a second approval is required when a configurable rule matches (classification, content type, recipient type, scope).
5. Protected identity is never exportable. Rendering runs server-side; files are written to private storage with random keys.

## Requirements

Q99; negative tests N16, N19.

## Implementation

Migration 1930 (Phase 9). How approvals stay bound to the approved content, how rules are versioned, separation of duties and the generation step are recorded in [ADR-032](ADR-032-export-approval-binding.md).
