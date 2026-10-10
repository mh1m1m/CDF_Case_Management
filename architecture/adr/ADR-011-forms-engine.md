# ADR-011: Data-driven forms engine for the WB-FRM catalogue

- **Status:** Accepted (2026-10-07); implemented in Phase 8 (CDF-50, EPIC 09)
- **Protocol:** §13 (reference data in migrations), §18–§21, §29, §45, §83, §87; CDF-SWARM activation brief for AGENT-06

## Context

The baseline package ships 19 investigation forms (`WB-FRM-01` … `WB-FRM-19`) as hard-coded HTML with per-role edit flags and no server. The target platform needs the same catalogue as **data**: definitions versioned in Git, instances tied to a case, a prepared → reviewed → approved lifecycle with separation of duties, a classification per instance, a verifiable content hash, and the same two-layer authorization as every other case object. Interviews (CDF-60, ADR-012) and records retention (CDF-69, ADR-013) are built by other agents at the same time, so the forms engine must stay inside its own schema and migration range and gate case visibility only through the shared `authz.can_view_case`.

## Decision

### Registry as data

- One generator, `scripts/forms/generate-registry.mjs`, reads the baseline catalogue (`baseline/extracted/baseline-domain.json`) plus an English label file (`scripts/forms/labels.en.json`, marked `TRANSLATION_REVIEW_PENDING`) and emits two artefacts that must stay identical: `packages/domain/src/forms/registry.generated.ts` (`FORM_DEFINITIONS`, `FORM_ENTITLEMENTS`) and migration `20261007001110_form_definitions_seed.sql`. `tests/integration/mirrors.spec.ts` fails if they drift.
- Each definition carries `code`, bilingual name and purpose, `owner_role_hint`, `source_reference`, `review_required`, `approval_required`, `repeatable` and a **definition version** whose `schema` (sections → fields) is stored as JSONB with a `schema_hash` = SHA-256 of the canonical JSON. 184 fields in total; field types `text`, `textarea`, `date`, `number`, `boolean`, `select` (with bilingual options). A shipped migration is immutable: changing a form later means a new `form_definition_version` migration and switching `current_version_id`; existing instances keep the version they were started on.
- Per-form **entitlements** (`form_code`, `role_code`, `VIEW | PREPARE | REVIEW | APPROVE`, `source`) are derived from the baseline role map (`BASELINE`: view → VIEW, edit → PREPARE), from the owner family for reviewers and from implied-view rules (`DERIVED`), and from an assumption for approvers (`SOURCE_REQUIRED`: GRC director for intake decisions, committee chair + GRC director for committee forms, decision authority + GRC director for decision forms). 255 rows. Baseline role names map to platform roles (`COMPLIANCE_OFFICER` → `INTAKE_OFFICER` + `TRIAGE_OFFICER`, `SENIOR_INVESTIGATOR` → `LEAD_INVESTIGATOR`, …); subject-employee and grievance roles are not platform roles and are skipped.

### Instances, versions, events

- `forms.form_instance` belongs to one case (`case_id`), one definition version, carries `instance_no` (display `WB-FRM-11 #2`, never a lookup key), `status`, `classification` (≥ case classification, ≤ preparer clearance), and who prepared / reviewed / approved / withdrew it and when.
- Every save creates an immutable `forms.form_instance_version` (`version_no`, normalised `data`, `content_hash`), unless the content hash is unchanged (idempotent save). Values are strings in lexical form (`YYYY-MM-DD`, `true`/`false`, decimal text); empty values are dropped; unknown keys are rejected. `content_hash = sha256(form_code ‖ ':' ‖ schema_hash ‖ ':' ‖ canonical_json(data))`, computed identically by `forms.content_hash()` and `@cdf/domain` `formContentHash()`, so a client can verify a stored hash.
- `forms.form_event` is the append-only state history (`CREATED`, `SAVED`, `PREPARED`, `REVIEWED`, `RETURNED`, `APPROVED`, `WITHDRAWN`) with an identity `seq` for strict ordering. Versions, events and instances cannot be deleted or truncated by any role, the owner included; a final instance (terminal status or `WITHDRAWN`) cannot be updated at all; identity columns are immutable.

### Lifecycle and separation of duties

- `DRAFT` → (prepare, strict validation of required fields) → `PREPARED` → (review) → `REVIEWED` → (approve) → `APPROVED`. The terminal status follows the definition: `APPROVED` when approval is required, else `REVIEWED` when review is required, else `PREPARED` (`forms.terminal_status()`).
- `RETURNED` by a reviewer or approver reopens `DRAFT` and clears the prepared/reviewed marks; a reason of at least 10 characters is mandatory. `WITHDRAWN` is allowed from any non-final state by someone who may prepare the form, with a reason; nothing is ever deleted (records retention rule, coordinator note 2026-10-07).
- The reviewer may not be the preparer; the approver may be neither (`CDF_CONFLICT:FORM_SEPARATION_OF_DUTIES`).

### Authorization (twice, as everywhere)

- Application pre-check: `can(actor, FORM_*)` ∧ `isFormEntitled(roles, code, action)` from the registry mirror; refusals are recorded as `COMMAND_DENIED` security events.
- Database (authoritative): `authz.can_view_form_instance` = `authz.can_view_case` ∧ instance classification ≤ clearance ∧ `FORM_VIEW` ∧ entitled `VIEW`; `authz.can_prepare_form` adds `FORM_PREPARE`, entitled `PREPARE`, an `ACTIVE` case, an enabled definition and a working relationship (`CASE_EDIT_ALL`, an active assignment, or an active grant other than `AUDIT`); `authz.can_review_form` / `authz.can_approve_form` require the definition to need that step plus the permission and entitlement. RLS on instances, versions and events uses `can_view_form_instance`; `request_id` is never selectable.
- New permissions `FORM_VIEW`, `FORM_PREPARE`, `FORM_REVIEW`, `FORM_APPROVE`; `PLATFORM_ADMIN`, `DB_ADMIN`, `INTERNAL_AUDIT`, `SOC_ANALYST`, `PRIVACY_DPO`, `RECORDS_OFFICER`, `REFERRER` hold none (§21).

### Commands and audit

`api.open_form_instance`, `api.start_form`, `api.save_form_draft`, `api.prepare_form`, `api.review_form`, `api.approve_form`, `api.withdraw_form`, all `SECURITY DEFINER` with `search_path = ''`, each writing its `forms.form_event` and audit event in the same transaction: `FORM_STARTED`, `FORM_SAVED`, `FORM_PREPARED`, `FORM_REVIEWED`, `FORM_RETURNED`, `FORM_APPROVED`, `FORM_WITHDRAWN`, `FORM_VIEWED` (`BUSINESS`) and `FORM_ACCESS_DENIED` (`SECURITY`). Audit metadata carries codes, numbers and hashes only, never field values (§83).

### Presentation

`/cases/[id]/forms` (registry + instances) and `/cases/[id]/forms/[instanceId]` in the investigation app render the schema dynamically with Server Action forms validated by the shared Zod envelope, `@cdf/domain` field rules and the database (§45). React Hook Form is not used for this slice: the field set is data-driven and the Server Action path keeps one validation source; a client-side layer can be added later without changing contracts. All text comes from `packages/i18n` (`forms.*`, `formStatus.*`, `formEvent.*`, `formOwner.*`), Arabic and English.

## Consequences

- Adding or changing a form is a data change (generator → new version migration), reviewed like code; no UI code changes per form.
- Business numbers (`instance_no`) are display-only; UUIDs are the keys and every lookup is authorised (§87).
- Approver entitlements and form repeatability are assumptions until the CDF Delegation of Authority document is available (`SOURCE_REQUIRED` in the data); English labels need translation review.
- Records-state gating beyond `records_state = 'ACTIVE'` (legal hold, disposition) is wired by the records agent (CDF-69) in a follow-up that this engine's commands accept unchanged.
- No new infrastructure component: nothing in this ADR is a production substitution.

## Production mapping

None required. The schema, functions and RLS run unchanged on Alibaba RDS PostgreSQL; the generator and migrations are plain SQL and TypeScript.

## Requirements

`CDF-FORM-001` in `compliance/requirements/requirements.yaml`; rules F-1 … F-9 in `architecture/SECURITY_RULES.md`; Linear CDF-50 under EPIC 09 (CDF-14).
