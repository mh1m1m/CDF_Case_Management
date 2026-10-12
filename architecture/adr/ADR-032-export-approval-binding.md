# ADR-032: Export approval rules, preview binding and generation

- **Status:** Proposed (2026-10-12). Linear CDF-196. Implemented in migration 1930 (local, pending security review). Security-sensitive.
- **Protocol:** §19, §29, §40, §46, §68, §82–§83, §87; ADR-026; owner Q&A Q99.

## Context

ADR-026 decides what the Export Builder is: requests, items, recipients and approvals in schema `exchange`, per-item authorization at build time, a recorded preview, a justification and classification check for external email, and a second approval when a configurable rule matches. It leaves open how an approval stays tied to what was approved, how rules are versioned, who may approve, and what happens between approval and delivery. Owner Q&A Q99 says a second approval "can be required dynamically based on system-configured rules"; the rules themselves are not yet sourced.

## Decision

1. **Items are ids, rendered per viewer.** An export item stores an object type and id only. It is rendered for the person looking at it (requester at preview, approver at approval, requester at generation) with the predicate of its table's RLS policy. An item that person cannot see, from another case or missing is refused when added (`NOT_FOUND`) and listed as withheld afterwards. Withheld items block submission, every approval and generation; they are never dropped silently (N16).
2. **One hash binds the whole export.** The preview hash (SHA-256 of the canonical document) covers the rendered items, recipients, format, audience, purpose, external party, justification and the case's current classification. Submission is bound to the requester's own preview; every approval and the generation recompute it, so any change in between answers `PREVIEW_CHANGED`. A rejection is always possible, even on a changed export.
3. **Rules are effective-dated rows, not code.** `exchange.approval_rule` matches audience, minimum case classification, restricted cases and content type, with action `REQUIRE_SECOND_APPROVAL`, `REFUSE` or `NONE`. A rule is never edited: `api.set_export_rule` (permission `EXPORT_POLICY_ADMIN`) closes the open version and adds the next, and `NONE` switches a code off. Every rule carries its source status; the seeded rules are SOURCE_REQUIRED. A rule that begins after submission binds pending exports: approvals needed can only rise, and generation answers `APPROVALS_CHANGED` until a new export is approved.
4. **Approvals are staged and separated.** External exports need one approval; each matching `REQUIRE_SECOND_APPROVAL` rule adds one, up to two. Stage 1 needs `EXPORT_APPROVE`, stage 2 `EXPORT_SECOND_APPROVE`; the two approvers are different people and never the requester. Only the requester generates, records sending or cancels. A draft is visible to its requester only; approvers see an export once it is submitted, and only while they can see the case.
5. **Classification is confirmed, not inferred.** The requester confirms the case's current classification at submission (`CLASSIFICATION_MISMATCH` otherwise). A later classification change alters the hash.
6. **Recipients are re-checked.** Internal recipients must pass the case gate when added, at submission and at generation (`RECIPIENT_NOT_ELIGIBLE`). External addresses are accepted for EXTERNAL exports only and never enter the audit ledger.
7. **The file is final and written in the same transaction.** `api.generate_export` returns the document and a storage key `exports/<uuid>` minted by the database; the application renders it and writes it to the store inside the transaction that marks the export GENERATED, so a failed render or write leaves it APPROVED. An EMAIL export is then handed to the mailer; only an accepted delivery is recorded as SENT. A refused delivery leaves it GENERATED; resending needs a new export.
8. **Content limits.** Exportable items are the case summary, a finding, a recommendation package, an authority decision and approved minutes (narrative only). No item reads the report, the reporter's WB id or protected identity (N19). Evidence waits for UX S2; grievances, interviews and reports are not exportable.

## Consequences

- An approver always approves exactly what will be generated; any edit after submission restarts approval rather than slipping through.
- Policy can be changed by an authorised administrator without a migration, and the history of every rule version stays queryable.
- Recipients and items can lose eligibility between submission and generation; the export then fails closed and must be redone.
- Delivery failure is visible (GENERATED, not SENT) but not retried automatically.
- Permissions are OWNER_DEFAULT pending the Delegation of Authority (SOURCE_REQUIRED): `EXPORT_REQUEST` (Case Manager, Lead Investigator, GRC Director), `EXPORT_APPROVE` (Case Manager, GRC Director), `EXPORT_SECOND_APPROVE` and `EXPORT_POLICY_ADMIN` (GRC Director). The committee secretary gets none until grant scope is enforced (DEC-02, UX S3).
- Seeded rules (SOURCE_REQUIRED): `EXTERNAL_SECRET` refuses; `EXTERNAL_CONFIDENTIAL` and `EXTERNAL_MINUTES` need a second approval; `RESTRICTED_CASE` needs an approval for any audience.
- Not decided here (SOURCE_REQUIRED): the purpose list, approved external domains, retention of generated exports, and whether XLSX needs its own rule.
- Notifications: `EXPORT_APPROVAL_REQUESTED` to the eligible approvers of the next stage, `EXPORT_DECIDED` to the requester; ids only (N18).

## Production mapping

| Prototype                                           | Production (PRODUCTION_SUBSTITUTION_REQUIRED)                      |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `StubJsonExportRenderer` writes canonical JSON      | Server-side PDF / XLSX renderer in the CDF runtime                 |
| `InMemoryExportStore`, write-once, `exports/<uuid>` | Private Alibaba OSS bucket, KMS-encrypted, object lock             |
| `StubExportMailer`, `@example.test` only            | CDF mail relay with approved external domains (human decision)     |
| Synthetic external addresses                        | Directory or authority contact register, as the policy will source |

## Requirements

Q99; negative tests N16, N19. Tests: `tests/security/export.spec.ts`, export IDOR probes, the audit walk, `packages/application/src/exports.test.ts`, `packages/infrastructure/src/exports/stubs.test.ts`.
