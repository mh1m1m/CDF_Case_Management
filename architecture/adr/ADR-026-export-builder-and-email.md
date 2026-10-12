# ADR-026: Export Builder and external email

- **Status:** Proposed (2026-10-12); implemented in migration 1930 pending review. Linear CDF-196. Security-sensitive.
- **Protocol:** §19, §29, §40, §46, §82–§83, §87; owner Q&A Q99.

## Decision

1. Schema `exchange`: `export_request` (format PDF / XLSX / EMAIL, purpose, justification, classification, status), `export_item` (object type + id), `export_recipient` (INTERNAL / EXTERNAL), `export_approval`.
2. Authorization is checked **per item at build time** with the same `authz.*` predicates as the UI; refused items are listed as withheld, never silently dropped.
3. Every export has a preview (hash recorded) and an audit trail (EXPORT_REQUESTED, EXPORT_APPROVED, EXPORT_GENERATED, EXPORT_SENT).
4. External email always requires a justification and a classification check; a second approval is required when a configurable rule matches (classification, content type, recipient type, scope).
5. Protected identity is never exportable. Rendering runs server-side; files are written to private storage with random keys.

## Requirements

Q99; negative tests N16, N19.

## Implementation notes (migration 1930, Phase 9)

- **Permissions (OWNER_DEFAULT, SOURCE_REQUIRED, Delegation of Authority):** `EXPORT_REQUEST` (Case Manager, Lead Investigator, GRC Director), `EXPORT_APPROVE` (Case Manager, GRC Director), `EXPORT_SECOND_APPROVE` (GRC Director), `EXPORT_POLICY_ADMIN` (GRC Director). The committee secretary gets no export permission until grant scope is enforced (DEC-02, UX S3).
- **Statuses:** DRAFT → SUBMITTED → APPROVED → GENERATED (→ SENT for EMAIL), or REJECTED / CANCELLED. An export that needs no approval is APPROVED at submission. Files are final once generated.
- **Approvals:** EXTERNAL needs one; a matching `REQUIRE_SECOND_APPROVAL` rule adds one (internal exports therefore need one only when a rule matches). Stage 1 needs `EXPORT_APPROVE`, stage 2 `EXPORT_SECOND_APPROVE`, by different people, never the requester. A rule that begins after submission raises the approvals needed; generation refuses with `APPROVALS_CHANGED` until a new export is approved.
- **Seeded rules (SOURCE_REQUIRED):** `EXTERNAL_SECRET` refuses; `EXTERNAL_CONFIDENTIAL` and `EXTERNAL_MINUTES` require a second approval; `RESTRICTED_CASE` requires an approval for any audience. `EXPORT_POLICY_ADMIN` adds versions with `api.set_export_rule`; action `NONE` switches a code off.
- **Classification check:** the requester confirms the case's current classification at submission (`CLASSIFICATION_MISMATCH` otherwise); the classification is inside the hash, so a later change answers `PREVIEW_CHANGED`.
- **Exportable items:** case summary, finding, recommendation package, authority decision and approved minutes (narrative only). Evidence waits for UX S2; grievances, interviews and reports are not exportable.
- **Rendering and delivery** are ports: `ExportRenderer` (stub writes canonical JSON), `ExportStore` (in-memory, write-once, keys `exports/<uuid>` from the database) and `ExportMailer` (stub, `@example.test` only). The file is rendered and stored inside the generation transaction; only an accepted delivery is recorded as SENT. A refused delivery leaves the export GENERATED; resending needs a new export (known limitation).
- **Notifications:** `EXPORT_APPROVAL_REQUESTED` to the eligible approvers of the next stage, `EXPORT_DECIDED` to the requester. Ids only (N18).
- **Not decided here (SOURCE_REQUIRED):** the purpose list, the approved external domains, retention of generated exports, and whether XLSX exports need their own rule.
