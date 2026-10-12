# ADR-027: Business continuity workbook and governed import

- **Status:** Proposed (2026-10-12). Linear CDF-197.
- **Protocol:** §12, §29, §45, §87; owner Q&A Q100.

## Decision

1. A portable Excel workbook with sheets 00_README … 26_IMPORT_AUDIT (cases, subjects, allegations, proceedings, committees, meetings, attendance, conflicts, votes, minutes, recommendations, legal review, decisions, notices, defences, grievances, corrective actions, evidence register (metadata only), legacy status map, import audit). Each row carries a stable ID (UUID or `BCP-` key) so re-import is idempotent.
2. Import pipeline: upload → **validate** (schema per sheet, Zod in `packages/validation`) → **diff** against current state → **approve** (separate user) → **transactional import** through the same `api.*` commands, never direct table writes.
3. Provenance on every imported row: ORIGINAL_EVENT_AT, RECORDED_OFFLINE_BY, IMPORTED_AT, IMPORTED_BY, SOURCE_WORKBOOK_ID, markers RECORDED_OFFLINE / IMPORTED_LATER. Provenance is never overwritten.
4. Legacy CRM statuses map through `config.legacy_status_map` (ADR-029).
5. Prototype uses synthetic workbooks only; a generated empty template ships in the repo.

## Requirements

Q100; negative test N17.
