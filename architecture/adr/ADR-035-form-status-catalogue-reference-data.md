# ADR-035: The form and status catalogue as grounded reference data

- **Status:** Proposed (2026-10-12). Linear CDF-198, CDF-199 (Phase 11, first slice). Implemented in migration 1970 (local, pending security review). Amends ADR-028 and ADR-029.
- **Protocol:** §12–§14, §18, §42, §45, §68, §87, §88; ADR-007, ADR-011, ADR-028, ADR-029, ADR-034; DEC-31 (narrowed), DEC-34 (superseded by the multi-dimensional status), DEC-35 (OPEN); playbook §11–§16 and §115.

## Context

ADR-028 and ADR-029 classified the CRM forms (source A, 169), the baseline WB-FRM forms (source C, 19) and the 150 Drive statuses in two documents, and ADR-029 promised `config.legacy_status_map`. On 2026-10-12 the owner supplied source D: 274 business controls in 12 tracks, each with its allowed, primary and resulting statuses drawn from a second status list of 140 codes. Phase 11 rationalises all of it onto the target model.

Nothing checked the documents against the code. A mapping could name an audit event no command emits, a command or permission that does not exist, or a status value the schema refuses, and nobody would notice. DEC-35 is open, so nothing may be deleted or made unavailable: retire by status, keep every historic reference resolvable, and leave current behaviour unchanged where a change would need the owner's decision record. DEC-31 fixes the catalogue numbers: 4 USER_FORM rows covering 2 distinct forms, and 7 RETIRED, in sources A and C.

## Decision

1. **The catalogue is reference data in the database.** Migration 1970 adds seven tables in schema `config`: `target_class` (15 classes), `target_module` (61 modules), `legacy_catalogue` (the six source catalogues and their sizes), `status_dimension` (24), `status_dimension_value` (167), `legacy_status_map` (305) and `legacy_form_map` (462). They change only by migration. Every ACTIVE user may read them; a revoked user and the anonymous role cannot; no application role can write them. They hold catalogue names and mappings, never case content.
2. **Status is multi-dimensional and grounded in the schema (DEC-34).** A dimension is STORED (a column with a check constraint), STATUS_CODE (`config.status_code`), DERIVED (computed, with its derivation recorded) or PLANNED (named, not modelled). Tests fail if a STORED dimension's values differ from its column's check constraint, or a STATUS_CODE dimension's from the active codes, so the catalogue cannot drift from the schema. RETURN_REASON is a reason given on a return, not a status, and is left out.
3. **Every legacy status lands somewhere real.** Each of the 305 rows (Drive 150, the 140-status list, the 15 CDF_CASE_V1 states) maps to at least one of: a dimension value, an audit event or a domain object, plus the module that owns it. An event marked IMPLEMENTED must be emitted today by a command or a workflow transition; one marked PLANNED must not be. A CDF_CASE_V1 state that sets a records state maps to that records state. The tests check all of this against the database.
4. **The two status lists are kept apart, and their conflict is surfaced.** They share codes S001–S140, but 10 codes (S021–S023, S025–S028, S030, S099, S100) mean different statuses; S024, S029 and S122 differ only in wording. Each list is its own catalogue. A 140-list row points at its 150-list counterpart (`same_as`), and the 10 are flagged `code_conflict`. Which list is authoritative is SOURCE_REQUIRED. The Drive document's own transition table mostly uses the 140-list names for these codes.
5. **Six reason codes from the owner's catalogue are added.** Waiting reasons HEARING, INVESTIGATOR_ASSIGNMENT and SUBJECT_STATEMENT; suspension reasons INVESTIGATOR_CHANGE, NON_COOPERATION and RESOURCE_SHORTAGE (OWNER_DEFAULT). They are new rows in `config.status_code` and `STATUS_CODES` in `@cdf/contracts`, usable by the existing proceeding commands. Nothing existing changes.
6. **Every form maps to one class and one module, and modules trace to the code (playbook §115).** All 462 forms (A, C and D) carry a target class, a target module, a merge target, a disposition (KEEP, MERGE, REPLACE, RETIRE, MIGRATE) and a data owner. Source D rows also carry their statuses, linked to the 140-list rows. Each module names its commands, permissions, UI surface, delivery state (IMPLEMENTED 48, PARTIAL 9, PLANNED 3, SOURCE_REQUIRED 1) and the migrations that delivered it. Tests check that every named command, permission and migration exists, and that a module is delivered exactly when it names a command.
7. **DEC-31 holds across all three sources.** USER_FORM is allowed only in the portal report and grievance submission modules (a table check). There are 8 USER_FORM rows: DEC-31's 4 in A and C, plus 4 in D for the same two forms. There are 13 RETIRED rows: DEC-31's 7, plus 6 in D.
8. **Nothing is deleted or disabled (DEC-35 OPEN, §88).** No form definition, option code, status or catalogue row is removed. RETIRED and RETIRE describe the target ("not rebuilt"), not a deletion. Every WB-FRM form definition stays enabled. Each WB-FRM row whose disposition is not KEEP carries SOURCE_REQUIRED: a decision record is needed before that baseline form leaves new-case use.
9. **The documents and the database are one source.** `FORM_CATALOGUE_RATIONALIZATION.md` and `CRM_STATUS_RATIONALIZATION.md` are generated from the same data as the migration. A test compares every documented row with the database.
10. **Gaps are recorded, not built.** Mapping found six behaviours the catalogue expects and the code lacks (P11-G1 to P11-G6 in `FORM_CATALOGUE_RATIONALIZATION.md` §6, referenced by `gap_ref` on 58 rows). This slice changes no command; each gap needs its own slice. P11-G1, accepting the five closure outcomes in the preliminary recommendation, was closed by migration 1980 ([ADR-036](ADR-036-preliminary-closure-outcomes.md)). P11-G5, a kind for each employee notice with the decision notice starting the grievance window, was closed by migration 1990 ([ADR-037](ADR-037-employee-notice-kinds.md)).

## Consequences

- Reporting and the continuity import (ADR-034) can resolve any legacy status or form code to its target. Neither reads the catalogue yet.
- A schema change that adds or removes a status value fails the grounding tests until the catalogue is updated in the same PR. That is intended.
- Nothing visible changes for users: no screen reads the catalogue, and every form and command behaves as before.
- The 140-list conflict stays visible in both the data and the document until the owner names the authoritative list.

## Production mapping

Plain PostgreSQL tables, policies and grants. They move to RDS PostgreSQL unchanged; nothing is prototype-specific.

## Open questions (SOURCE_REQUIRED)

1. Which status list is authoritative for the 10 conflicting codes: the Drive 150 or the 140 in the owner's catalogue?
2. What does S099 «تجميد قانوني» in the 140-status list mean? It is mapped to an active legal hold until the owner says otherwise.
3. The decision record for each WB-FRM form whose target is not KEEP, before it leaves new-case use.
4. DEC-35: any option-code change waits for the owner's decision record.

## Requirements

Rebase prompt §forms and §status; playbook §11–§16, §115; owner answers G1–G5 (form taxonomy); CDF-198, CDF-199.
