# Data Model

Protocol §12–§17. The migrations in `infrastructure/supabase/migrations/` are authoritative; this document explains them. Table definitions here match migrations `20261007000100` through `20261007000800`. The live access model (RLS, grants, executable functions) is snapshotted in [`../../infrastructure/supabase/policies/policy-snapshot.md`](../../infrastructure/supabase/policies/policy-snapshot.md), and CI fails if that snapshot drifts from the migrations.

Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Every user row is constrained to `is_synthetic = true` and an `@example.test` email.

## 1. Conventions

- UUID primary keys (`gen_random_uuid()`); readable business identifiers alongside (`case_number`, `report_ref`, `wb_id`) which are never used as lookup keys by the application.
- Every table has RLS enabled. Application roles (`anon`, `authenticated`) hold `SELECT` only, and only where a policy exists; no write privilege anywhere. All writes go through `SECURITY DEFINER` command functions in `api` (authenticated) and `public_api` (anonymous), each pinned to `search_path = ''`.
- Enumerations that carry business meaning are `CHECK` constraints on `text` columns so they can evolve by migration; two cross-cutting enums are PostgreSQL types: `core.classification_level` (`INTERNAL < RESTRICTED < CONFIDENTIAL < SECRET`) and `core.record_status` (`ACTIVE`, `SUSPENDED`, `REVOKED`).
- Timestamps are `timestamptz`. Soft state uses explicit `status` columns with paired `*_at` / `*_by` columns and check constraints that keep them consistent (for example `(status = 'REVOKED') = (revoked_at is not null)`).
- `JSONB` appears only in `audit.audit_event.metadata`, and `assertSafeMetadata()` plus the writing functions keep it to identifiers and codes.

## 2. Schemas

| Schema               | Purpose                                                                                                          | Application access                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `core`               | Cross-cutting types and the rate-limit bucket                                                                    | `consume_rate_limit` via `public_api` wrapper only         |
| `iam`                | Users, roles, permissions, role assignments                                                                      | `SELECT` by policy                                         |
| `authz`              | Authorization predicates used by RLS and commands                                                                | `EXECUTE` for `authenticated`                              |
| `audit`              | Append-only, hash-chained ledger                                                                                 | `SELECT` by category policy                                |
| `intake`             | Reports from the public portal, reporter messages, triage decisions                                              | `SELECT` by policy (column-limited on `report`)            |
| `protected_identity` | Reporter identity vault and reveal requests                                                                      | **none** (functions only)                                  |
| `case_mgmt`          | Case master, persons, allegations, assignments, access grants, conflict checks, numbering, `case_overview` view  | `SELECT` by policy                                         |
| `workflow`           | Workflow definition, states, transitions, per-case instance, transition events                                   | `SELECT` by policy                                         |
| `evidence`           | Evidence items, immutable file versions, content-type allow-list, chain of custody                               | `SELECT` by policy (column-limited on `evidence_version`)  |
| `forms`              | WB-FRM form registry (definitions, versions, fields, entitlements) and per-case form instances, versions, events | `SELECT` by policy (column-limited on versions and events) |
| `records`            | Retention classes and schedules, legal holds, disposition requests and certificates (ADR-013)                    | `SELECT` by policy                                         |
| `config`             | Settings whose authoritative source is still `SOURCE_REQUIRED`                                                   | `SELECT` for signed-in users                               |
| `api`                | Authenticated command and query functions                                                                        | `EXECUTE` for `authenticated`                              |
| `public_api`         | Anonymous portal functions                                                                                       | `EXECUTE` for `anon`                                       |

## 3. Entity overview

```
iam.user_profile 1──* iam.user_role_assignment *──1 iam.role 1──* iam.role_permission *──1 iam.permission

intake.report 1──0..1 protected_identity.reporter_identity   (by wb_id; vault, no grants)
intake.report 1──* intake.report_message
intake.report 1──* intake.report_triage
intake.report 1──0..1 case_mgmt.case_record                   (source_report_id, unique)

case_mgmt.case_record 1──* case_mgmt.allegation
case_mgmt.case_record 1──* case_mgmt.case_person *──1 case_mgmt.person
case_mgmt.case_record 1──* case_mgmt.case_assignment          (ACTIVE / ENDED)
case_mgmt.case_record 1──* case_mgmt.case_access_grant        (ACTIVE / REVOKED, scoped)
case_mgmt.case_record 1──* case_mgmt.conflict_check           (is_current flag)
case_mgmt.case_record 1──* protected_identity.reveal_request
case_mgmt.case_record 1──1 workflow.workflow_instance 1──* workflow.workflow_transition_event
case_mgmt.case_record 1──* evidence.evidence 1──* evidence.evidence_version *──1 evidence.allowed_content_type
evidence.evidence 0..1──1 evidence.evidence_version                 (current_version_id = latest AVAILABLE)
evidence.evidence 1──* evidence.custody_event                      (seq; version_id nullable)

forms.form_definition 1──* forms.form_definition_version 1──* forms.form_field_definition
forms.form_definition 1──* forms.form_entitlement *──1 iam.role
case_mgmt.case_record 1──* forms.form_instance *──1 forms.form_definition_version
forms.form_instance 1──* forms.form_instance_version        (current_version_id, prepared_version_id)
forms.form_instance 1──* forms.form_event                   (seq; append-only state history)

workflow.workflow_definition 1──* workflow.workflow_state
workflow.workflow_definition 1──* workflow.workflow_transition_definition (from_state, to_state, required_permission)

audit.audit_event   (seq, previous_hash → event_hash; case_id nullable; no FKs so rows survive everything)
```

## 4. Tables

### 4.1 `iam`

| Table                      | Key columns and constraints                                                                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iam.role`                 | `code` PK (`^[A-Z][A-Z_]{2,63}$`), bilingual names, `is_technical`. 21 roles seeded as reference data.                                                                                                                                         |
| `iam.permission`           | `code` PK, description. 19 permissions seeded.                                                                                                                                                                                                 |
| `iam.role_permission`      | `(role_code, permission_code)` PK. Mirrored in `@cdf/authorization`; `tests/integration/mirrors.spec.ts` keeps them identical.                                                                                                                 |
| `iam.user_profile`         | `id` = identity-provider subject; `email` unique, lower-case, `@example.test` only; `display_name`, `display_name_ar`; `status core.record_status`; `clearance core.classification_level` (default `RESTRICTED`); `is_synthetic` must be true. |
| `iam.user_role_assignment` | Role grant with `status`, `effective_from`/`effective_to`, `justification` (≥ 5 chars), `granted_by`/`granted_at`, `revoked_by`/`revoked_at`/`revocation_reason`. Consistency checks on dates and revocation.                                  |

Application roles may select `user_profile` columns `id, email, display_name, display_name_ar, department, status` only. `clearance` is readable through `authz.current_clearance()` for the current user only.

### 4.2 `audit`

| Table               | Key columns and constraints                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit.audit_event` | `seq` identity PK; `event_id` unique; `occurred_at`; `actor_type` (`USER`, `ANONYMOUS_REPORTER`, `SYSTEM`); `actor_id`; `actor_roles text[]`; `case_id`; `action` (`^[A-Z][A-Z_]{2,63}$`); `category` (`BUSINESS`, `SECURITY`, `ADMIN`); `object_type`/`object_id`; `request_id`; `reason` (≤ 2000); `outcome` (`SUCCESS`, `DENIED`, `FAILURE`); `metadata jsonb` object; `previous_hash`, `event_hash` (hex SHA-256). |

Triggers reject `UPDATE`, `DELETE` and `TRUNCATE`. `audit.record_event()` computes the hash chain; `api.verify_audit_chain()` walks it.

### 4.3 `intake`

| Table                   | Key columns and constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intake.report`         | `report_ref` unique (`WB-` + 12 Crockford chars); `secret_hmac` (hex SHA-256, never selectable); `wb_id` unique opaque (`WBID-` + 16 hex), the only link to the identity vault; `channel` (`PUBLIC_PORTAL`); `reporter_mode` (`ANONYMOUS`, `IDENTIFIED`); `category` (9 values); `subject_description` (≤ 500); `description` (20–8000); `incident_date` (≤ today); `location`; `language` (`ar`, `en`); `classification`; `status` (see §6); `case_id`; `received_at`, `status_changed_at`. |
| `intake.report_message` | `direction` (`FROM_REPORTER`, `TO_REPORTER`); `body` (1–4000); `author_user_id` null exactly when the message is from the reporter.                                                                                                                                                                                                                                                                                                                                                          |
| `intake.report_triage`  | `outcome` (`OPEN_CASE`, `REQUEST_INFORMATION`, `REFER_OUT`, `CLOSE_NO_ACTION`, `DUPLICATE`); `reason` (10–4000); `referred_to` required for `REFER_OUT`; `duplicate_of_report_id` required for `DUPLICATE`; `decided_by`, `decided_at`.                                                                                                                                                                                                                                                      |

### 4.4 `protected_identity` (no grants to any application role)

| Table                                  | Key columns and constraints                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protected_identity.reporter_identity` | `wb_id` PK → `intake.report.wb_id`; `full_name`, `email`, `phone`, `preferred_contact` (`EMAIL`, `PHONE`, `PORTAL_ONLY`); at least one identity field present.                                                       |
| `protected_identity.reveal_request`    | `case_id`; `requested_by`; `justification` (20–2000); `status` (`PENDING`, `APPROVED`, `REJECTED`, `USED`); `decided_by` must differ from `requested_by` (dual control); `decision_reason`; `expires_at`; `used_at`. |

Only `public_api.submit_report()` writes the vault; only `api.resolve_reporter_identity()` reads it, after `api.request_identity_reveal()` and `api.decide_identity_reveal()` by a second officer.

### 4.5 `case_mgmt`

| Table                            | Key columns and constraints                                                                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `case_mgmt.case_number_counter`  | `(prefix, year)` PK, `prefix` in (`CDF-CASE`, `CDF-DEMO`); the prototype uses `CDF-DEMO`.                                                                                                                         |
| `case_mgmt.case_record`          | `case_number` unique (`CDF-(CASE                                                                                                                                                                                  | DEMO)-YYYY-NNNN`); `case_type` (`WHISTLEBLOWING`, `INTERNAL_REFERRAL`, `OTHER`); `title`(3–200);`summary`(10–4000);`classification`; `is_restricted`; `source`(+`source_report_id`required for`PUBLIC_PORTAL`, unique); `reporter_wb_id`; `priority` (`LOW`…`CRITICAL`); `identity_reveal_requires_approval`(default true);`owner_id`; `retention_class`, `legal_hold_status`, `records_state`(reserved for Phase 11);`created__`, `opened_at`, `closed_at`, `updated__`, `row_version` (optimistic concurrency). |
| `case_mgmt.person`               | `display_name`, `person_type` (`EMPLOYEE`, `CONTRACTOR`, `EXTERNAL`, `UNKNOWN`), `department`, optional `user_id`. Visible only through a visible `case_person`.                                                  |
| `case_mgmt.case_person`          | `role` (`SUBJECT`, `WITNESS`, `AFFECTED_PARTY`, `OTHER`); unique `(case_id, person_id, role)`.                                                                                                                    |
| `case_mgmt.allegation`           | `category`, `description` (10–8000), `status` (`OPEN`, `SUBSTANTIATED`, `UNSUBSTANTIATED`, `WITHDRAWN`).                                                                                                          |
| `case_mgmt.case_assignment`      | `assignment_role` (`CASE_OWNER`, `LEAD_INVESTIGATOR`, `INVESTIGATOR`, `REVIEWER`); `status` (`ACTIVE`, `ENDED`); `reason` (≥ 5); `assigned_by/at`, `ended_by/at`, `end_reason`.                                   |
| `case_mgmt.case_access_grant`    | `scope` (`TRIAGE`, `CASE`, `COMMITTEE`, `REVIEW`, `AUDIT`); `status` (`ACTIVE`, `REVOKED`); `reason`; `effective_from/to`; `granted_by/at`, `revoked_by/at`, `revocation_reason`.                                 |
| `case_mgmt.conflict_check`       | `status` (`NO_CONFLICT`, `CONFLICT_DECLARED`, `CONFLICT_CONFIRMED`, `CONFLICT_CLEARED`); `declaration` (5–2000); `decided_by/at`, `decision_reason`; `is_current` marks the latest check per user and case.       |
| `case_mgmt.case_overview` (view) | Case row joined with the current workflow state (code, bilingual name, sequence, entered/due timestamps) and the primary assigned investigator (lead first); `security_invoker`, so it inherits the caller's RLS. |

### 4.6 `workflow`

| Table                                     | Key columns and constraints                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow.workflow_definition`            | `code` PK (`CDF_CASE_V1`), bilingual names, `version`, `is_active`.                                                                                                                                                                                                                                  |
| `workflow.workflow_state`                 | `(workflow_code, code)` PK; `sequence` unique per workflow; `is_initial`, `is_terminal`; `records_state` (`ACTIVE`, `CLOSED`, `ARCHIVED`).                                                                                                                                                           |
| `workflow.workflow_transition_definition` | `(workflow_code, code)` PK; `from_state`/`to_state` FKs; `required_permission` → `iam.permission`; `reason_required`, `review_required`, `approval_required`; `required_conditions text[]`; `sla_hours`; `audit_action`; `is_system` (only inside other commands); `is_enabled`; `enabled_in_phase`. |
| `workflow.workflow_instance`              | One per case (`case_id` unique); `current_state` FK; `entered_state_at`; `state_due_at`.                                                                                                                                                                                                             |
| `workflow.workflow_transition_event`      | `transition_code`, `from_state`, `to_state`, `actor_id`, `reason`, `occurred_at`, `request_id`.                                                                                                                                                                                                      |

See [`../WORKFLOW.md`](../WORKFLOW.md) for the state machine.

### 4.7 `config` and `core`

| Table                    | Key columns and constraints                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.setting`         | `key` PK; `value`; `status` (`SOURCE_REQUIRED`, `CONFIGURED`); `source_reference`; `CONFIGURED` requires both value and source. Holds rules whose CDF authority is still unconfirmed (for example quorum). |
| `core.rate_limit_bucket` | `(bucket_key, window_start)` PK; `bucket_key` `^[a-z_]{2,32}:[0-9a-zA-Z_-]{1,128}$`; `hits`. Fixed-window counter used by `core.consume_rate_limit()`.                                                     |

### 4.8 `evidence`

| Table                           | Key columns and constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence.allowed_content_type` | `content_type` PK, `extensions text[]`, `evidence_type`. 16 rows of reference data, mirrored by `ALLOWED_CONTENT_TYPES` in `@cdf/domain` (`tests/integration/mirrors.spec.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `evidence.evidence`             | `id`; `case_id` FK; `sequence_no` ≥ 1, unique per case (display `EV-001`); `title` 3–200; `description` ≤ 2000; `evidence_type` (`DOCUMENT`, `IMAGE`, `AUDIO`, `VIDEO`, `EMAIL`, `DATA_EXPORT`, `OTHER`); `source_description` ≤ 500; `collected_at` ≤ today; `classification core.classification_level` (≥ case classification, ≤ uploader clearance); `status` (`PENDING`, `AVAILABLE`, `REJECTED`); `current_version_id` FK; `created_by`, `created_at`, `updated_at`. No `DELETE`/`TRUNCATE` for any role.                                                                                                                                                                                                                                                              |
| `evidence.evidence_version`     | `id`; `evidence_id` FK; `version_no` ≥ 1 unique per item; `object_key` unique, check `cases/{uuid}/evidence/{uuid}/{uuid}`, **not selectable by application roles**; `original_file_name` 1–255 without separators or control characters; `content_type` FK; `size_bytes` 1–26 214 400; `sha256` 64 hex; `status` (`QUARANTINED`, `AVAILABLE`, `REJECTED`); `scan_status` (`PENDING`, `CLEAN`, `INFECTED`, `UNSCANNED`); `scanner`; `rejection_code`; `uploaded_by`, `uploaded_at`, `stored_at`; `request_id` (not selectable). Checks: `AVAILABLE` ⇔ `stored_at` set ⇒ `CLEAN`; `REJECTED` ⇔ `rejection_code`. Partial unique `(evidence_id, sha256)` where not `REJECTED`. Updates allowed only while `QUARANTINED` and never to content columns; no `DELETE`/`TRUNCATE`. |
| `evidence.custody_event`        | `id`; `seq` identity (strict order within a transaction); `evidence_id` FK; `version_id` FK nullable; `event_type` (`RECEIVED`, `STORED`, `REJECTED`, `DOWNLOADED`); `actor_id` FK; `occurred_at`; `request_id`; `details jsonb` ≤ 1024 bytes of technical facts. Append-only: `UPDATE`/`DELETE`/`TRUNCATE` rejected for every role.                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Writes happen only through `api.register_evidence_version`, `api.complete_evidence_version`, `api.reject_evidence_version` and `api.open_evidence_version`, each recording its custody event and audit event in the same transaction. The immutability triggers bind to the table owner too, so `SECURITY DEFINER` commands cannot overwrite history either.

### 4.9 `forms` (ADR-011)

| Table                           | Columns and rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forms.form_definition`         | `code` PK (`WB-FRM-NN`); `sequence_no`; `name_ar/en`; `purpose_ar/en`; `owner_role_hint`; `source_reference`; `review_required`; `approval_required` (⇒ review); `repeatable`; `is_enabled`; `current_version_id` FK. 19 rows of reference data, generated from the baseline catalogue and mirrored by `FORM_DEFINITIONS` in `@cdf/domain` (`tests/integration/mirrors.spec.ts`).                                                                                                                                                                                                                                                                                                         |
| `forms.form_definition_version` | `id` (deterministic per code); `form_code` FK; `version_no` unique per form; `schema jsonb` (sections → fields); `schema_hash` 64 hex = SHA-256 of the canonical schema JSON. Immutable once shipped: a changed form is a new version migration.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `forms.form_field_definition`   | `version_id` FK; `section_no`, section titles; `field_no` (global, 1-based), `name` (`^[a-z][a-z0-9_]{1,63}$`), `label_ar/en`, `field_type` (`text`, `textarea`, `date`, `number`, `boolean`, `select`), `required`, `options jsonb` (select ⇔ options), help text, `sensitive`. Unique `(version_id, name)` and `(version_id, field_no)`. 184 rows.                                                                                                                                                                                                                                                                                                                                      |
| `forms.form_entitlement`        | `form_code` FK; `role_code` FK `iam.role`; `action` (`VIEW`, `PREPARE`, `REVIEW`, `APPROVE`); `source` (`BASELINE`, `DERIVED`, `SOURCE_REQUIRED`). 255 rows mirrored by `FORM_ENTITLEMENTS`; every row implies the matching `FORM_*` permission on the role.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `forms.form_instance`           | `id`; `case_id` FK; `form_code` FK; `definition_version_id` FK; `instance_no` ≥ 1 unique per case and form (display `WB-FRM-11 #2`); `status` (`DRAFT`, `PREPARED`, `REVIEWED`, `APPROVED`, `WITHDRAWN`); `classification core.classification_level` (≥ case classification, ≤ preparer clearance); `current_version_id`, `prepared_version_id` FK; `prepared_by/at`, `reviewed_by/at`, `approved_by/at`, `withdrawn_by/at` (consistency checks per status); `created_by/at`, `updated_at`. Trigger `forms.protect_instance()` rejects any update once the status is terminal for its definition or `WITHDRAWN`, and any change to identity columns; no `DELETE`/`TRUNCATE` for any role. |
| `forms.form_instance_version`   | `id`; `instance_id` FK; `version_no` ≥ 1 unique per instance; `data jsonb` (flat object of string values ≤ 256 KiB, validated against the definition version); `content_hash` 64 hex = `forms.content_hash(form_code, schema_hash, data)`; `saved_by`, `saved_at`; `request_id` (not selectable). Append-only: `UPDATE`/`DELETE`/`TRUNCATE` rejected for every role.                                                                                                                                                                                                                                                                                                                      |
| `forms.form_event`              | `id`; `seq` identity (strict order within a transaction); `instance_id` FK; `event_type` (`CREATED`, `SAVED`, `PREPARED`, `REVIEWED`, `RETURNED`, `APPROVED`, `WITHDRAWN`); `from_status`, `to_status`; `version_id` FK nullable; `actor_id` FK; `occurred_at`; `reason`; `request_id` (not selectable). Append-only.                                                                                                                                                                                                                                                                                                                                                                     |

Writes happen only through `api.start_form`, `api.save_form_draft` (idempotent on an unchanged hash), `api.prepare_form`, `api.review_form`, `api.approve_form` and `api.withdraw_form`; `api.open_form_instance` records every read of an instance. Each command writes its `form_event` and audit event in the same transaction. Migrations: `20261007001100_forms` (schema, RLS, commands) and `20261007001110_form_definitions_seed` (registry data); the `1100–1199` range belongs to the forms engine.

### 4.10 `records`

Tables, constraints, lifecycle and audit events are specified in [`RECORDS_RETENTION.md`](RECORDS_RETENTION.md) and implemented by `…1300_records.sql` and `…1310_records_commands.sql`. Display numbers `CDF-HOLD-YYYY-NNNN` and `CDF-DISP-YYYY-NNNN` come from `records.number_counter`. `case_record.retention_class` references `records.retention_class`; `case_record` itself can no longer be deleted or truncated by any role.

## 5. Identifiers

| Identifier      | Format                                | Purpose                                                   | Shown to               |
| --------------- | ------------------------------------- | --------------------------------------------------------- | ---------------------- |
| `report_ref`    | `WB-` + 12 Crockford base32           | Reporter's follow-up reference (60 bits, not secret)      | Reporter, intake staff |
| reporter secret | 20 Crockford chars in 5 groups        | Reporter's credential (100 bits); only its HMAC is stored | Reporter, once         |
| `wb_id`         | `WBID-` + 16 hex                      | Opaque join key to the identity vault                     | Internal only          |
| `case_number`   | `CDF-DEMO-YYYY-NNNN`                  | Display number for cases                                  | Case team              |
| `sequence_no`   | `EV-NNN` (per case)                   | Display number for evidence items; never a lookup key     | Case team              |
| `object_key`    | `cases/{uuid}/evidence/{uuid}/{uuid}` | Storage location, generated by the database               | Server code only       |
| `instance_no`   | `WB-FRM-NN #N` (per case and form)    | Display number for form instances; never a lookup key     | Case team              |
| `id`            | UUID v4                               | The only lookup key the application uses                  | URLs (unguessable)     |

## 6. Report status lifecycle

`intake.report.status`: `RECEIVED` → `INFO_REQUESTED` (→ `RECEIVED` when the reporter replies) → `ACCEPTED` → `CASE_OPENED`; or `REFERRED_OUT`, `CLOSED_NO_ACTION`, `DUPLICATE` from triage. The portal maps these to the public statuses `RECEIVED`, `INFORMATION_REQUESTED`, `IN_PROGRESS`, `CLOSED` and never exposes the internal value.

## 7. Not yet modelled

Interviews (CDF-60, in progress on a parallel branch), findings, committee and decisions, corrective actions, document generation, notifications, and search are later phases (`NOT_STARTED`). Forms are modelled (§4.9). Retention, legal hold and logical disposition are implemented (§4.10); physical destruction is not (ADR-013 D7).
