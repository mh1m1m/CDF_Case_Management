-- =============================================================================
-- 1960 Business continuity workbook and governed import (Business Architecture Rebase phase 10; CDF-197)
-- Requirements: §12, §19, §29, §45, §82–§83, §87; owner Q&A Q100; ADR-027, ADR-034; AUTHORIZATION_IMPACT.md N17
--
-- Additive only. Schema `exchange`:
--   bcp_template_sheet / bcp_template_column
--                     the versioned workbook template (BCP-1) as reference data: 27 sheets, their columns and the
--                     rules each cell must meet. Mirrors BCP_TEMPLATE in @cdf/contracts (a test keeps them equal).
--   bcp_import_batch  one upload of one workbook for one case: STAGED → SUBMITTED → APPROVED → IMPORTED
--                     | REJECTED | CANCELLED, bound to the importer's previewed hash.
--   bcp_import_row    one staged workbook row: its cells as strings, its state (NEW, CONFLICT, ALREADY_IMPORTED,
--                     UNSUPPORTED, INVALID), the importer's resolution and the last dry-run outcome.
--   bcp_provenance    one row per imported object: original event time, offline recorder, import time, importer,
--                     source workbook and row, markers RECORDED_OFFLINE and IMPORTED_LATER. Append-only.
--
-- Controls:
--   * Cells are validated by the application and again here, column by column, against the template (§45).
--   * The importer (BCP_IMPORT) must see the case that the control sheet names by id and number (NOT_FOUND
--     otherwise); one case and workbook id have at most one open batch.
--   * Nothing is overwritten silently: a row naming an existing object, or changed since it was imported, is a
--     CONFLICT kept or skipped; unsupported and invalid rows are skipped explicitly; every resolution is audited.
--   * The preview runs every row through its api.* command as the importer and rolls everything back; submission
--     needs that preview's hash and a clean dry run. Referenced platform objects must belong to the workbook's case.
--   * The workbook's preparer and each row's offline recorder must be ACTIVE users who see the case.
--   * A different person approves (BCP_IMPORT_APPROVE): never the importer, the preparer or anyone who recorded a row
--     offline, and only someone who sees the case. The importer applies, in one transaction, through the same
--     commands; any failing row aborts the whole import.
--   * Provenance is written per imported object and never changed; offline times are never rewritten as import
--     times. Re-importing a workbook is idempotent.
-- Audit metadata carries ids, codes and counts, never cell text.
-- =============================================================================

-- OWNER_DEFAULT, SOURCE_REQUIRED: "authorized continuity users" are not named in any source yet. Each importer can
-- import only what their own permissions allow; the dry run shows which rows those are.
insert into iam.permission (code, description) values
  ('BCP_IMPORT', 'Stage, preview and apply a continuity workbook for a case the user can see'),
  ('BCP_IMPORT_APPROVE', 'Approve or reject a continuity workbook import staged by someone else');
insert into iam.role_permission (role_code, permission_code) values
  ('CASE_MANAGER', 'BCP_IMPORT'), ('CASE_MANAGER', 'BCP_IMPORT_APPROVE'),
  ('LEAD_INVESTIGATOR', 'BCP_IMPORT'),
  ('GRC_DIRECTOR', 'BCP_IMPORT'), ('GRC_DIRECTOR', 'BCP_IMPORT_APPROVE');

-- -----------------------------------------------------------------------------
-- Template (reference data)
-- -----------------------------------------------------------------------------
create table exchange.bcp_template_sheet (
  template_version text not null check (template_version ~ '^BCP-[0-9]{1,3}$'),
  sheet_code       text not null check (sheet_code ~ '^[0-9]{2}_[A-Z_]{3,40}$'),
  position         int not null check (position between 0 and 99),
  sheet_kind       text not null check (sheet_kind in ('README', 'CONTROL', 'DATA', 'PLATFORM_LOG')),
  command          text check (command in ('add_case_subject', 'add_allegation', 'record_defence_response',
                                           'open_corrective_action')),
  object_type      text check (object_type in ('case_subject', 'allegation', 'defence_response', 'corrective_action')),
  primary key (template_version, sheet_code),
  unique (template_version, position),
  check ((command is null) = (object_type is null)),
  check (command is null or sheet_kind = 'DATA')
);
comment on table exchange.bcp_template_sheet is
  'Continuity workbook template sheets (ADR-034). A DATA sheet with a command is imported; any other DATA sheet is recorded only.';

create table exchange.bcp_template_column (
  template_version text not null,
  sheet_code       text not null,
  position         int not null check (position between 1 and 40),
  column_code      text not null check (column_code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  kind             text not null check (kind in ('ROW_KEY', 'UUID', 'REF', 'DATETIME', 'DATE', 'EMAIL', 'ENUM', 'CODE',
                                                 'TEXT', 'VERSION')),
  required         boolean not null,
  min_length       int check (min_length >= 0),
  max_length       int not null check (max_length between 1 and 20000),
  allowed          text[],
  primary key (template_version, sheet_code, column_code),
  unique (template_version, sheet_code, position),
  foreign key (template_version, sheet_code) references exchange.bcp_template_sheet (template_version, sheet_code),
  check ((kind = 'ENUM') = (allowed is not null)),
  check ((kind = 'TEXT') = (min_length is not null))
);
comment on table exchange.bcp_template_column is
  'Columns of a template sheet and the rule each cell meets; for 01_CONTROL these are the control keys.';

insert into exchange.bcp_template_sheet (template_version, sheet_code, position, sheet_kind, command, object_type) values
  ('BCP-1', '00_README', 0, 'README', null, null),
  ('BCP-1', '01_CONTROL', 1, 'CONTROL', null, null),
  ('BCP-1', '02_CASE_MASTER', 2, 'DATA', null, null),
  ('BCP-1', '03_SOURCE_REFERRAL', 3, 'DATA', null, null),
  ('BCP-1', '04_PRELIMINARY_REVIEW', 4, 'DATA', null, null),
  ('BCP-1', '05_SUBJECTS', 5, 'DATA', 'add_case_subject', 'case_subject'),
  ('BCP-1', '06_ALLEGATIONS', 6, 'DATA', 'add_allegation', 'allegation'),
  ('BCP-1', '07_INVESTIGATION', 7, 'DATA', null, null),
  ('BCP-1', '08_INVESTIGATION_COMMITTEE', 8, 'DATA', null, null),
  ('BCP-1', '09_MEETINGS', 9, 'DATA', null, null),
  ('BCP-1', '10_ATTENDANCE', 10, 'DATA', null, null),
  ('BCP-1', '11_CONFLICTS', 11, 'DATA', null, null),
  ('BCP-1', '12_VOTES', 12, 'DATA', null, null),
  ('BCP-1', '13_EVIDENCE_INDEX', 13, 'DATA', null, null),
  ('BCP-1', '14_RECOMMENDATIONS', 14, 'DATA', null, null),
  ('BCP-1', '15_SANCTIONS', 15, 'DATA', null, null),
  ('BCP-1', '16_LEGAL_REVIEW', 16, 'DATA', null, null),
  ('BCP-1', '17_AUTHORITY_DECISION', 17, 'DATA', null, null),
  ('BCP-1', '18_EMPLOYEE_NOTICE', 18, 'DATA', 'record_defence_response', 'defence_response'),
  ('BCP-1', '19_GRIEVANCE', 19, 'DATA', null, null),
  ('BCP-1', '20_GRIEVANCE_COMMITTEE', 20, 'DATA', null, null),
  ('BCP-1', '21_CORRECTIVE_ACTIONS', 21, 'DATA', 'open_corrective_action', 'corrective_action'),
  ('BCP-1', '22_DOCUMENT_INDEX', 22, 'DATA', null, null),
  ('BCP-1', '23_STATUS_HISTORY', 23, 'DATA', null, null),
  ('BCP-1', '24_TIMELINE', 24, 'DATA', null, null),
  ('BCP-1', '25_RECORDS', 25, 'DATA', null, null),
  ('BCP-1', '26_IMPORT_AUDIT', 26, 'PLATFORM_LOG', null, null);

insert into exchange.bcp_template_column
  (template_version, sheet_code, position, column_code, kind, required, min_length, max_length, allowed) values
  ('BCP-1', '01_CONTROL', 1, 'TEMPLATE_VERSION', 'VERSION', true, null, 10, null),
  ('BCP-1', '01_CONTROL', 2, 'WORKBOOK_ID', 'ROW_KEY', true, null, 64, null),
  ('BCP-1', '01_CONTROL', 3, 'CASE_ID', 'UUID', true, null, 36, null),
  ('BCP-1', '01_CONTROL', 4, 'CASE_NUMBER', 'TEXT', true, 3, 60, null),
  ('BCP-1', '01_CONTROL', 5, 'OFFLINE_FROM', 'DATETIME', true, null, 40, null),
  ('BCP-1', '01_CONTROL', 6, 'OFFLINE_TO', 'DATETIME', false, null, 40, null),
  ('BCP-1', '01_CONTROL', 7, 'PREPARED_BY', 'EMAIL', true, null, 254, null),
  ('BCP-1', '26_IMPORT_AUDIT', 1, 'BATCH_ID', 'UUID', false, null, 36, null),
  ('BCP-1', '26_IMPORT_AUDIT', 2, 'IMPORTED_AT', 'DATETIME', false, null, 40, null),
  ('BCP-1', '26_IMPORT_AUDIT', 3, 'IMPORTED_BY', 'EMAIL', false, null, 254, null),
  ('BCP-1', '26_IMPORT_AUDIT', 4, 'RESULT', 'TEXT', false, 0, 200, null);

-- Every data sheet starts with the row's identity and its offline provenance.
insert into exchange.bcp_template_column
  (template_version, sheet_code, position, column_code, kind, required, min_length, max_length, allowed)
select s.template_version, s.sheet_code, c.position, c.column_code, c.kind, c.required, null, c.max_length, null
from exchange.bcp_template_sheet s
cross join (values (1, 'ROW_ID', 'ROW_KEY', true, 64), (2, 'OBJECT_ID', 'UUID', false, 36),
                   (3, 'ORIGINAL_EVENT_AT', 'DATETIME', true, 40), (4, 'RECORDED_OFFLINE_BY', 'EMAIL', true, 254))
  c (position, column_code, kind, required, max_length)
where s.sheet_kind = 'DATA';

-- Sheets recorded only in BCP-1: what happened, and the platform object it concerns.
insert into exchange.bcp_template_column
  (template_version, sheet_code, position, column_code, kind, required, min_length, max_length, allowed)
select s.template_version, s.sheet_code, c.position, c.column_code, c.kind, c.required, c.min_length, c.max_length, null
from exchange.bcp_template_sheet s
cross join (values (5, 'REFERENCE_ID', 'UUID', false, null::int, 36), (6, 'DETAILS', 'TEXT', true, 3, 8000))
  c (position, column_code, kind, required, min_length, max_length)
where s.sheet_kind = 'DATA' and s.command is null;

insert into exchange.bcp_template_column
  (template_version, sheet_code, position, column_code, kind, required, min_length, max_length, allowed) values
  ('BCP-1', '05_SUBJECTS', 5, 'DISPLAY_LABEL', 'TEXT', true, 2, 200, null),
  ('BCP-1', '05_SUBJECTS', 6, 'SUBJECT_CATEGORY', 'ENUM', true, null, 40,
   array['EMPLOYEE', 'CONTRACTOR', 'OTHER_AUTHORIZED']),
  ('BCP-1', '06_ALLEGATIONS', 5, 'CATEGORY', 'CODE', true, null, 40, null),
  ('BCP-1', '06_ALLEGATIONS', 6, 'DESCRIPTION', 'TEXT', true, 10, 8000, null),
  ('BCP-1', '06_ALLEGATIONS', 7, 'SUBJECT_REF', 'REF', false, null, 64, null),
  ('BCP-1', '06_ALLEGATIONS', 8, 'POLICY_REFERENCE', 'TEXT', false, 2, 200, null),
  ('BCP-1', '06_ALLEGATIONS', 9, 'LAW_REFERENCE', 'TEXT', false, 2, 200, null),
  ('BCP-1', '18_EMPLOYEE_NOTICE', 5, 'NOTICE_ID', 'UUID', true, null, 36, null),
  ('BCP-1', '18_EMPLOYEE_NOTICE', 6, 'CHANNEL', 'ENUM', true, null, 40,
   array['EMAIL', 'PHYSICAL_SUBMISSION', 'SECRETARY_ENTRY', 'BCP_IMPORT', 'OTHER_AUTHORIZED_CHANNEL']),
  ('BCP-1', '18_EMPLOYEE_NOTICE', 7, 'ORIGINAL_SUBMISSION_DATE', 'DATETIME', true, null, 40, null),
  ('BCP-1', '18_EMPLOYEE_NOTICE', 8, 'RESPONSE_TEXT', 'TEXT', true, 10, 20000, null),
  ('BCP-1', '18_EMPLOYEE_NOTICE', 9, 'ORIGINAL_DOCUMENT_REFERENCE', 'TEXT', true, 3, 300, null),
  ('BCP-1', '21_CORRECTIVE_ACTIONS', 5, 'RECOMMENDATION_ITEM_ID', 'UUID', true, null, 36, null),
  ('BCP-1', '21_CORRECTIVE_ACTIONS', 6, 'TITLE', 'TEXT', true, 5, 200, null),
  ('BCP-1', '21_CORRECTIVE_ACTIONS', 7, 'DESCRIPTION', 'TEXT', true, 10, 4000, null),
  ('BCP-1', '21_CORRECTIVE_ACTIONS', 8, 'OWNER', 'EMAIL', true, null, 254, null),
  ('BCP-1', '21_CORRECTIVE_ACTIONS', 9, 'DUE_DATE', 'DATE', false, null, 10, null);

-- -----------------------------------------------------------------------------
-- Batches, staged rows, provenance
-- -----------------------------------------------------------------------------
create table exchange.bcp_import_batch (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid not null references case_mgmt.case_record (id),
  template_version  text not null check (template_version ~ '^BCP-[0-9]{1,3}$'),
  workbook_id       text not null check (workbook_id ~ '^(BCP-[A-Z0-9][A-Z0-9-]{0,59}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  file_sha256       text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  control           jsonb not null check (jsonb_typeof(control) = 'object'),
  offline_from      timestamptz not null,
  offline_to        timestamptz,
  prepared_by       uuid not null references iam.user_profile (id),
  status            text not null default 'STAGED' check (status in (
                      'STAGED', 'SUBMITTED', 'APPROVED', 'IMPORTED', 'REJECTED', 'CANCELLED')),
  preview_hash      text check (preview_hash ~ '^[0-9a-f]{64}$'),
  previewed_at      timestamptz,
  preview_clean     boolean not null default false,
  submitted_hash    text check (submitted_hash ~ '^[0-9a-f]{64}$'),
  imported_by       uuid not null references iam.user_profile (id),
  decided_by        uuid references iam.user_profile (id),
  decision_reason   text check (length(decision_reason) between 5 and 2000),
  created_at        timestamptz not null default now(),
  submitted_at      timestamptz,
  decided_at        timestamptz,
  applied_at        timestamptz,
  cancelled_at      timestamptz,
  updated_at        timestamptz not null default now(),
  row_version       int not null default 1,
  check (offline_to is null or offline_to >= offline_from),
  check (case status when 'STAGED' then submitted_hash is null when 'CANCELLED' then true else submitted_hash is not null end),
  check (status not in ('APPROVED', 'IMPORTED', 'REJECTED') or decided_by is not null),
  check (status not in ('STAGED', 'SUBMITTED') or decided_by is null),
  check (decided_by is null or decided_by <> imported_by),
  check ((status = 'IMPORTED') = (applied_at is not null))
);
create index bcp_import_batch_case on exchange.bcp_import_batch (case_id, workbook_id);
create index bcp_import_batch_imported_by on exchange.bcp_import_batch (imported_by, status);
create index bcp_import_batch_prepared_by on exchange.bcp_import_batch (prepared_by);
create index bcp_import_batch_decided_by on exchange.bcp_import_batch (decided_by);
create unique index bcp_import_batch_open on exchange.bcp_import_batch (case_id, workbook_id)
  where status in ('STAGED', 'SUBMITTED', 'APPROVED');
comment on table exchange.bcp_import_batch is
  'One continuity workbook staged for one case; imported only after a different person approves (ADR-034).';

create table exchange.bcp_import_row (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references exchange.bcp_import_batch (id),
  case_id             uuid not null references case_mgmt.case_record (id),
  template_version    text not null,
  sheet_code          text not null,
  row_number          int not null check (row_number between 3 and 1048576),
  row_key             text check (length(row_key) between 1 and 64),
  cells               jsonb not null check (jsonb_typeof(cells) = 'object'),
  payload_hash        text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  original_event_at   timestamptz,
  recorded_offline_by uuid references iam.user_profile (id),
  state               text not null check (state in ('NEW', 'CONFLICT', 'ALREADY_IMPORTED', 'UNSUPPORTED', 'INVALID')),
  detail              text check (detail ~ '^[A-Z][A-Z0-9_]{1,60}$'),
  resolution          text check (resolution in ('IMPORT', 'SKIP', 'KEEP_PLATFORM')),
  resolution_reason   text check (length(resolution_reason) between 5 and 1000),
  resolved_by         uuid references iam.user_profile (id),
  resolved_at         timestamptz,
  outcome             text check (outcome ~ '^(OK|CDF_[A-Z_]+(:[A-Za-z0-9_.:-]{0,100})?)$'),
  unique (batch_id, sheet_code, row_number),
  foreign key (template_version, sheet_code) references exchange.bcp_template_sheet (template_version, sheet_code),
  check (resolution is null or case state
           when 'NEW' then resolution in ('IMPORT', 'SKIP')
           when 'CONFLICT' then resolution in ('KEEP_PLATFORM', 'SKIP')
           when 'ALREADY_IMPORTED' then false
           else resolution = 'SKIP' end),
  check ((resolved_by is null) = (resolution_reason is null)),
  check ((state in ('INVALID', 'CONFLICT')) = (detail is not null)),
  check (state = 'INVALID' or (row_key is not null and original_event_at is not null and recorded_offline_by is not null))
);
create index bcp_import_row_batch on exchange.bcp_import_row (batch_id);
create index bcp_import_row_case on exchange.bcp_import_row (case_id);
create index bcp_import_row_recorder on exchange.bcp_import_row (recorded_offline_by);
create index bcp_import_row_resolved_by on exchange.bcp_import_row (resolved_by);
comment on table exchange.bcp_import_row is
  'A staged workbook row: cells as validated strings, state, resolution and last dry-run outcome (ADR-034).';

create table exchange.bcp_provenance (
  id                  uuid primary key default gen_random_uuid(),
  case_id             uuid not null references case_mgmt.case_record (id),
  batch_id            uuid not null references exchange.bcp_import_batch (id),
  row_id              uuid not null unique references exchange.bcp_import_row (id),
  workbook_id         text not null,
  sheet_code          text not null,
  row_key             text not null,
  object_type         text not null check (object_type in ('case_subject', 'allegation', 'defence_response',
                                                           'corrective_action')),
  object_id           uuid not null,
  original_event_at   timestamptz not null,
  recorded_offline_by uuid not null references iam.user_profile (id),
  imported_at         timestamptz not null default now(),
  imported_by         uuid not null references iam.user_profile (id),
  payload_hash        text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  markers             text[] not null default array['RECORDED_OFFLINE', 'IMPORTED_LATER']
                        check (markers = array['RECORDED_OFFLINE', 'IMPORTED_LATER']),
  unique (case_id, workbook_id, row_key),
  unique (object_type, object_id),
  check (original_event_at <= imported_at)
);
create index bcp_provenance_batch on exchange.bcp_provenance (batch_id);
create index bcp_provenance_recorder on exchange.bcp_provenance (recorded_offline_by);
create index bcp_provenance_imported_by on exchange.bcp_provenance (imported_by);
comment on table exchange.bcp_provenance is
  'Where an imported object came from: original event time, offline recorder, workbook row, importer. Never changed.';

do $$
declare t text;
begin
  foreach t in array array['exchange.bcp_template_sheet', 'exchange.bcp_template_column', 'exchange.bcp_provenance'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
  foreach t in array array['exchange.bcp_import_batch', 'exchange.bcp_import_row'] loop
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;

-- A batch keeps its identity and is final once imported, rejected or cancelled; its hash is fixed at submission.
-- A row keeps its cells and state; only its resolution and dry-run outcome change, and only while the batch is staged.
create function exchange.protect_bcp()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_fixed text[];
  v_status text;
begin
  if tg_table_name = 'bcp_import_batch' then
    v_fixed := array['id', 'case_id', 'template_version', 'workbook_id', 'file_sha256', 'control', 'offline_from',
                     'offline_to', 'prepared_by', 'imported_by', 'created_at'];
    if old.status in ('IMPORTED', 'REJECTED', 'CANCELLED')
       or (select jsonb_object_agg(k, to_jsonb(new) -> k) from unnest(v_fixed) k)
          <> (select jsonb_object_agg(k, to_jsonb(old) -> k) from unnest(v_fixed) k)
       or (old.submitted_hash is not null and new.submitted_hash is distinct from old.submitted_hash) then
      raise exception 'continuity import % is final or its identity is immutable', old.id
        using errcode = 'insufficient_privilege';
    end if;
  else
    select b.status into v_status from exchange.bcp_import_batch b where b.id = old.batch_id;
    if v_status <> 'STAGED'
       or (to_jsonb(new) - array['resolution', 'resolution_reason', 'resolved_by', 'resolved_at', 'outcome'])
          <> (to_jsonb(old) - array['resolution', 'resolution_reason', 'resolved_by', 'resolved_at', 'outcome']) then
      raise exception 'staged continuity row % is fixed', old.id using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;
create trigger bcp_import_batch_protect before update on exchange.bcp_import_batch
  for each row execute function exchange.protect_bcp();
create trigger bcp_import_row_protect before update on exchange.bcp_import_row
  for each row execute function exchange.protect_bcp();

-- -----------------------------------------------------------------------------
-- Authorization predicates
-- -----------------------------------------------------------------------------
-- The importer sees their batch; approvers see it once it has been submitted; everyone loses it with the case (§19).
create function authz.can_view_bcp_import(p_batch_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from exchange.bcp_import_batch b
    where b.id = p_batch_id and authz.can_view_case(b.case_id)
      and (b.imported_by = authz.current_user_id()
           or (b.submitted_at is not null and authz.has_permission('BCP_IMPORT_APPROVE')))
  );
$$;

-- Provenance follows the object it describes: an action's owner sees it with the action, everyone else with the case.
create function authz.can_view_bcp_provenance(p_object_type text, p_object_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and case p_object_type
    when 'corrective_action' then authz.can_view_corrective_action(p_object_id)
    else authz.can_view_case(p_case_id)
  end;
$$;
revoke all on function authz.can_view_bcp_import(uuid), authz.can_view_bcp_provenance(text, uuid, uuid)
  from public, anon;
grant execute on function authz.can_view_bcp_import(uuid), authz.can_view_bcp_provenance(text, uuid, uuid)
  to authenticated;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table exchange.bcp_template_sheet enable row level security;
alter table exchange.bcp_template_column enable row level security;
alter table exchange.bcp_import_batch enable row level security;
alter table exchange.bcp_import_row enable row level security;
alter table exchange.bcp_provenance enable row level security;

create policy bcp_template_sheet_read on exchange.bcp_template_sheet for select to authenticated
  using (authz.current_user_id() is not null);
grant select on exchange.bcp_template_sheet to authenticated;
create policy bcp_template_column_read on exchange.bcp_template_column for select to authenticated
  using (authz.current_user_id() is not null);
grant select on exchange.bcp_template_column to authenticated;
create policy bcp_import_batch_read on exchange.bcp_import_batch for select to authenticated
  using (authz.can_view_bcp_import(id));
grant select on exchange.bcp_import_batch to authenticated;
create policy bcp_import_row_read on exchange.bcp_import_row for select to authenticated
  using (authz.can_view_bcp_import(batch_id));
grant select on exchange.bcp_import_row to authenticated;
create policy bcp_provenance_read on exchange.bcp_provenance for select to authenticated
  using (authz.can_view_bcp_provenance(object_type, object_id, case_id));
grant select on exchange.bcp_provenance to authenticated;

-- -----------------------------------------------------------------------------
-- Internal helpers (no grants)
-- -----------------------------------------------------------------------------
create function exchange.bcp_is_uuid(p_value text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(p_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false);
$$;

-- Trims a cell, lower-cases UUIDs and addresses and upper-cases BCP- keys, so that the same workbook always stages
-- the same way.
create function exchange.bcp_normalize(p_kind text, p_value text)
returns text
language sql immutable
set search_path = ''
as $$
  select case
           when nullif(btrim(p_value), '') is null then null
           when p_kind in ('UUID', 'EMAIL') then lower(btrim(p_value))
           when p_kind in ('ROW_KEY', 'REF') and lower(btrim(p_value)) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then lower(btrim(p_value))
           when p_kind in ('ROW_KEY', 'REF', 'VERSION') and upper(btrim(p_value)) ~ '^BCP-' then upper(btrim(p_value))
           else btrim(p_value)
         end;
$$;

-- Whether one normalized cell meets its column's rule.
create function exchange.bcp_cell_ok(p_column exchange.bcp_template_column, p_value text)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_value is null then return not p_column.required; end if;
  if length(p_value) > p_column.max_length then return false; end if;
  case p_column.kind
    when 'VERSION' then return p_value ~ '^BCP-[0-9]{1,3}$';
    when 'ROW_KEY', 'REF' then
      return p_value ~ '^BCP-[A-Z0-9][A-Z0-9-]{0,59}$' or exchange.bcp_is_uuid(p_value);
    when 'UUID' then return exchange.bcp_is_uuid(p_value);
    when 'DATETIME' then
      if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
        return false;
      end if;
      begin
        perform p_value::timestamptz;
      exception when others then
        return false;
      end;
      return true;
    when 'DATE' then
      if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
      begin
        perform p_value::date;
      exception when others then
        return false;
      end;
      return true;
    when 'EMAIL' then return p_value ~ '^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,189}$';
    when 'ENUM' then return p_value = any (p_column.allowed);
    when 'CODE' then return p_value ~ '^[A-Z_]{3,40}$';
    when 'TEXT' then return length(p_value) >= p_column.min_length;
    else return false;
  end case;
end;
$$;

-- An error a command raised, as a row outcome: the platform's own CDF_* codes only, never SQL text (§82).
create function exchange.bcp_error_code(p_message text)
returns text
language sql immutable
set search_path = ''
as $$
  select case when p_message ~ '^CDF_[A-Z_]+(:[A-Za-z0-9_.:-]{0,100})?$' then p_message else 'CDF_ERROR' end;
$$;

create function exchange.bcp_user_by_email(p_email text)
returns uuid
language sql stable
set search_path = ''
as $$
  select u.id from iam.user_profile u where lower(u.email) = lower(p_email);
$$;

-- The person a workbook names as its preparer or as a row's offline recorder: a registered user who is ACTIVE and can
-- see the case now (AGENT-09 R2), so provenance never names someone outside the case. The importer can tell from the
-- result whether a named person sees the case; BCP_IMPORT holders are the roles that see the full roster (DEC-08/10).
create function exchange.bcp_case_user(p_email text, p_case_id uuid)
returns uuid
language sql stable
set search_path = ''
as $$
  select u.id from iam.user_profile u
  where lower(u.email) = lower(p_email) and authz.user_can_view_case(u.id, p_case_id);
$$;

-- What the approval and the import are bound to: the batch's control and every row with its state and resolution.
create function exchange.bcp_batch_hash(p_batch_id uuid)
returns text
language sql stable
set search_path = ''
as $$
  select encode(sha256(convert_to(jsonb_build_object(
           'batch_id', b.id, 'case_id', b.case_id, 'template_version', b.template_version,
           'workbook_id', b.workbook_id, 'file_sha256', b.file_sha256, 'control', b.control,
           'rows', coalesce((select jsonb_agg(jsonb_build_array(r.sheet_code, r.row_number, r.row_key, r.state,
                                                                r.detail, r.cells, r.resolution)
                                              order by s.position, r.row_number)
                             from exchange.bcp_import_row r
                             join exchange.bcp_template_sheet s
                               on s.template_version = r.template_version and s.sheet_code = r.sheet_code
                             where r.batch_id = b.id), '[]'::jsonb))::text, 'UTF8')), 'hex')
  from exchange.bcp_import_batch b where b.id = p_batch_id;
$$;

-- Locks a batch the caller can see. With p_own, only its importer, still holding BCP_IMPORT, may act on it.
create function exchange.lock_bcp_batch(p_batch_id uuid, p_own boolean)
returns exchange.bcp_import_batch
language plpgsql
set search_path = ''
as $$
declare v exchange.bcp_import_batch;
begin
  if p_batch_id is null or not authz.can_view_bcp_import(p_batch_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v from exchange.bcp_import_batch b where b.id = p_batch_id for update;
  if p_own and (v.imported_by <> authz.current_user_id() or not authz.has_permission('BCP_IMPORT')) then
    perform api._fail('FORBIDDEN');
  end if;
  return v;
end;
$$;

-- Who may approve: holds BCP_IMPORT_APPROVE, can see the case, and is neither the importer, the workbook's preparer
-- nor anyone who recorded a row offline. Internal (it answers about other users).
create function exchange.bcp_eligible_approvers(p_batch_id uuid)
returns table (user_id uuid)
language sql stable
set search_path = ''
as $$
  select u.id
  from exchange.bcp_import_batch b
  join iam.user_profile u on u.status = 'ACTIVE' and u.id <> b.imported_by and u.id <> b.prepared_by
  where b.id = p_batch_id
    and authz.user_has_permission(u.id, 'BCP_IMPORT_APPROVE')
    and authz.user_can_view_case(u.id, b.case_id)
    and not exists (select 1 from exchange.bcp_import_row r
                    where r.batch_id = b.id and r.recorded_offline_by = u.id);
$$;

-- Runs one row through its command, as the caller. References to rows of the same workbook resolve through p_refs
-- (row key → sheet and object id); a referenced platform object must belong to the batch's case.
create function exchange.bcp_execute_row(p_batch exchange.bcp_import_batch, p_row exchange.bcp_import_row, p_refs jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  c jsonb := p_row.cells;
  v_ref jsonb;
  v_subject uuid;
  v_owner uuid;
  v_object_case uuid;
begin
  case p_row.sheet_code
    when '05_SUBJECTS' then
      return api.add_case_subject(p_batch.case_id, c ->> 'DISPLAY_LABEL', c ->> 'SUBJECT_CATEGORY', null);
    when '06_ALLEGATIONS' then
      if c ? 'SUBJECT_REF' then
        v_ref := p_refs -> (c ->> 'SUBJECT_REF');
        if v_ref is not null then
          if v_ref ->> 'sheet' <> '05_SUBJECTS' then perform api._fail('INVALID', 'SUBJECT_REF'); end if;
          v_subject := (v_ref ->> 'id')::uuid;
        elsif exchange.bcp_is_uuid(c ->> 'SUBJECT_REF') then
          v_subject := (c ->> 'SUBJECT_REF')::uuid;
        else
          perform api._fail('INVALID', 'SUBJECT_REF');
        end if;
      end if;
      return api.add_allegation(p_batch.case_id, c ->> 'CATEGORY', c ->> 'DESCRIPTION', v_subject,
                                c ->> 'POLICY_REFERENCE', c ->> 'LAW_REFERENCE');
    when '18_EMPLOYEE_NOTICE' then
      select n.case_id into v_object_case from grievance.defence_notice n
       where n.id = (c ->> 'NOTICE_ID')::uuid and authz.can_view_case(n.case_id);
      if v_object_case is distinct from p_batch.case_id then perform api._fail('NOT_FOUND'); end if;
      return api.record_defence_response((c ->> 'NOTICE_ID')::uuid, c ->> 'CHANNEL',
                                         (c ->> 'ORIGINAL_SUBMISSION_DATE')::timestamptz, c ->> 'RESPONSE_TEXT',
                                         c ->> 'ORIGINAL_DOCUMENT_REFERENCE');
    when '21_CORRECTIVE_ACTIONS' then
      select i.case_id into v_object_case from decision.recommendation_item i
       where i.id = (c ->> 'RECOMMENDATION_ITEM_ID')::uuid and authz.can_view_case(i.case_id);
      if v_object_case is distinct from p_batch.case_id then perform api._fail('NOT_FOUND'); end if;
      v_owner := exchange.bcp_user_by_email(c ->> 'OWNER');
      if v_owner is null then perform api._fail('INVALID', 'OWNER'); end if;
      return api.open_corrective_action((c ->> 'RECOMMENDATION_ITEM_ID')::uuid, c ->> 'TITLE', c ->> 'DESCRIPTION',
                                        v_owner, (c ->> 'DUE_DATE')::date);
    else
      perform api._fail('CONFLICT', 'SHEET_NOT_IMPORTABLE');
  end case;
  return null;
end;
$$;

-- Runs every row resolved IMPORT, in template order. A dry run (p_apply false) reports each row's outcome and rolls
-- everything back; an import (p_apply true) writes provenance and stops at the first failing row, which aborts the
-- caller's transaction. Returns row id → outcome.
create function exchange.bcp_run(p_batch_id uuid, p_apply boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  b exchange.bcp_import_batch;
  r exchange.bcp_import_row;
  v_object_type text;
  v_refs jsonb;
  v_out jsonb := '{}'::jsonb;
  v_id uuid;
  v_code text;
begin
  select * into b from exchange.bcp_import_batch where id = p_batch_id;
  select coalesce(jsonb_object_agg(p.row_key, jsonb_build_object('sheet', p.sheet_code, 'id', p.object_id)), '{}'::jsonb)
    into v_refs
    from exchange.bcp_provenance p where p.case_id = b.case_id and p.workbook_id = b.workbook_id;

  if p_apply then
    for r in select x.* from exchange.bcp_import_row x
             join exchange.bcp_template_sheet s on s.template_version = x.template_version and s.sheet_code = x.sheet_code
             where x.batch_id = b.id and x.resolution = 'IMPORT' order by s.position, x.row_number loop
      begin
        v_id := exchange.bcp_execute_row(b, r, v_refs);
      exception when others then
        v_code := exchange.bcp_error_code(sqlerrm);
        perform api._fail('CONFLICT', 'BCP_ROW_FAILED:' || r.row_key || ':' || v_code);
      end;
      select s.object_type into v_object_type from exchange.bcp_template_sheet s
       where s.template_version = r.template_version and s.sheet_code = r.sheet_code;
      insert into exchange.bcp_provenance (case_id, batch_id, row_id, workbook_id, sheet_code, row_key, object_type,
                                           object_id, original_event_at, recorded_offline_by, imported_by, payload_hash)
      values (b.case_id, b.id, r.id, b.workbook_id, r.sheet_code, r.row_key, v_object_type, v_id, r.original_event_at,
              r.recorded_offline_by, authz.current_user_id(), r.payload_hash);
      perform audit.record_event('BCP_ROW_IMPORTED', 'BUSINESS', 'SUCCESS', b.case_id, v_object_type, v_id::text, null,
        jsonb_build_object('batch_id', b.id, 'row_id', r.id, 'sheet', r.sheet_code,
                           'original_event_at', r.original_event_at, 'recorded_offline_by', r.recorded_offline_by,
                           'markers', jsonb_build_array('RECORDED_OFFLINE', 'IMPORTED_LATER')));
      v_refs := v_refs || jsonb_build_object(r.row_key, jsonb_build_object('sheet', r.sheet_code, 'id', v_id));
      v_out := v_out || jsonb_build_object(r.id::text, 'OK');
    end loop;
    return v_out;
  end if;

  begin
    for r in select x.* from exchange.bcp_import_row x
             join exchange.bcp_template_sheet s on s.template_version = x.template_version and s.sheet_code = x.sheet_code
             where x.batch_id = b.id and x.resolution = 'IMPORT' order by s.position, x.row_number loop
      begin
        v_id := exchange.bcp_execute_row(b, r, v_refs);
        v_refs := v_refs || jsonb_build_object(r.row_key, jsonb_build_object('sheet', r.sheet_code, 'id', v_id));
        v_out := v_out || jsonb_build_object(r.id::text, 'OK');
      exception when others then
        v_out := v_out || jsonb_build_object(r.id::text, exchange.bcp_error_code(sqlerrm));
      end;
    end loop;
    raise exception using errcode = 'P0001', message = 'CDF_BCP_DRY_RUN';
  exception when raise_exception then
    if sqlerrm <> 'CDF_BCP_DRY_RUN' then raise; end if;
  end;
  return v_out;
end;
$$;

-- A dry run whose outcomes are written to the staged rows; true when every row to import passed.
create function exchange.bcp_dry_run(p_batch_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare v_out jsonb := exchange.bcp_run(p_batch_id, false);
begin
  update exchange.bcp_import_row r
     set outcome = case when r.resolution = 'IMPORT' then v_out ->> r.id::text end
   where r.batch_id = p_batch_id and r.outcome is distinct from case when r.resolution = 'IMPORT' then v_out ->> r.id::text end;
  return not exists (select 1 from exchange.bcp_import_row r
                     where r.batch_id = p_batch_id and r.resolution = 'IMPORT'
                       and (v_out ->> r.id::text) is distinct from 'OK');
end;
$$;

revoke all on function
  exchange.protect_bcp(), exchange.bcp_is_uuid(text), exchange.bcp_normalize(text, text),
  exchange.bcp_cell_ok(exchange.bcp_template_column, text),
  exchange.bcp_error_code(text), exchange.bcp_user_by_email(text), exchange.bcp_case_user(text, uuid),
  exchange.bcp_batch_hash(uuid),
  exchange.lock_bcp_batch(uuid, boolean), exchange.bcp_eligible_approvers(uuid),
  exchange.bcp_execute_row(exchange.bcp_import_batch, exchange.bcp_import_row, jsonb),
  exchange.bcp_run(uuid, boolean), exchange.bcp_dry_run(uuid)
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Notifications (ADR-025): ids only; the import page re-authorizes
-- -----------------------------------------------------------------------------
alter table notify.template drop constraint template_object_type_check;
alter table notify.template add constraint template_object_type_check check (object_type in (
  'COMMITTEE', 'MEETING', 'MINUTES', 'LEGAL_REVIEW', 'DEFENCE_NOTICE', 'GRIEVANCE', 'EXPORT', 'CORRECTIVE_ACTION',
  'BCP_IMPORT'));
alter table notify.outbox drop constraint outbox_object_type_check;
alter table notify.outbox add constraint outbox_object_type_check check (object_type in (
  'COMMITTEE', 'MEETING', 'MINUTES', 'LEGAL_REVIEW', 'DEFENCE_NOTICE', 'GRIEVANCE', 'EXPORT', 'CORRECTIVE_ACTION',
  'BCP_IMPORT'));

insert into notify.template (code, object_type, is_mandatory, description) values
  ('BCP_IMPORT_APPROVAL_REQUESTED', 'BCP_IMPORT', true, 'A continuity workbook import awaits the user''s approval (Q100)'),
  ('BCP_IMPORT_DECIDED',            'BCP_IMPORT', true, 'The user''s continuity workbook import was approved or rejected');
insert into notify.rule (layer, template_code, channel, enabled, effective_from, reason)
select 'SYSTEM_MANDATORY', t.code, c.channel, true, '2026-01-01T00:00:00Z', 'Synthetic default: mandatory notice (ADR-025)'
from notify.template t cross join (values ('IN_APP'), ('EMAIL')) c (channel)
where t.code in ('BCP_IMPORT_APPROVAL_REQUESTED', 'BCP_IMPORT_DECIDED');

create or replace function notify.deep_link(p_object_type text, p_object_id uuid)
returns text
language sql immutable
set search_path = ''
as $$
  select case p_object_type
           when 'COMMITTEE' then '/committees/' || p_object_id
           when 'MEETING' then '/meetings/' || p_object_id
           when 'MINUTES' then '/minutes/' || p_object_id
           when 'LEGAL_REVIEW' then '/legal-reviews/' || p_object_id
           when 'DEFENCE_NOTICE' then '/my-defence/' || p_object_id
           when 'GRIEVANCE' then '/grievances/' || p_object_id
           when 'EXPORT' then '/exports/' || p_object_id
           when 'CORRECTIVE_ACTION' then '/actions/' || p_object_id
           when 'BCP_IMPORT' then '/continuity/imports/' || p_object_id
         end;
$$;

-- Submission asks the eligible approvers; the decision tells the importer.
create function notify.on_bcp_import()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_user uuid;
begin
  if new.status = 'SUBMITTED' and old.status = 'STAGED' then
    for v_user in select e.user_id from exchange.bcp_eligible_approvers(new.id) e loop
      perform notify.enqueue('BCP_IMPORT_APPROVAL_REQUESTED', v_user, new.id, null, 'bcp-approval:' || new.id);
    end loop;
  elsif old.status = 'SUBMITTED' and new.status in ('APPROVED', 'REJECTED') then
    perform notify.enqueue('BCP_IMPORT_DECIDED', new.imported_by, new.id, null, 'bcp-decided:' || new.id);
  end if;
  return null;
end;
$$;
create trigger bcp_import_batch_notify after update on exchange.bcp_import_batch
  for each row when (old.status is distinct from new.status)
  execute function notify.on_bcp_import();
revoke all on function notify.on_bcp_import() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Staging (the importer)
-- -----------------------------------------------------------------------------
-- p_control: the 01_CONTROL keys as strings. p_rows: [{sheet, row_number, cells: {COLUMN: string}, has_formula}] for
-- every non-empty row of every data sheet. A malformed call (unknown sheet or column, non-string cell, too many rows)
-- is refused whole; a row whose cells break a column rule is staged INVALID with the column's code.
create function api.stage_bcp_import(p_control jsonb, p_file_sha256 text, p_rows jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_version text;
  v_ctl jsonb := '{}'::jsonb;
  v_col exchange.bcp_template_column;
  v_value text;
  v_case case_mgmt.case_record;
  v_from timestamptz;
  v_to timestamptz;
  v_prepared uuid;
  v_batch uuid;
  v_el jsonb;
  v_sheet exchange.bcp_template_sheet;
  v_cells jsonb;
  v_detail text;
  v_state text;
  v_key text;
  v_event timestamptz;
  v_recorder uuid;
  v_hash text;
  v_prior text;
begin
  if p_control is null or jsonb_typeof(p_control) <> 'object' then perform api._fail('INVALID', 'control'); end if;
  v_version := p_control ->> 'TEMPLATE_VERSION';
  if v_version is null or not exists (select 1 from exchange.bcp_template_sheet s where s.template_version = v_version) then
    perform api._fail('CONFLICT', 'TEMPLATE_VERSION');
  end if;
  if exists (select 1 from jsonb_each(p_control) e
             where jsonb_typeof(e.value) <> 'string'
                or not exists (select 1 from exchange.bcp_template_column c
                               where c.template_version = v_version and c.sheet_code = '01_CONTROL'
                                 and c.column_code = e.key)) then
    perform api._fail('INVALID', 'control');
  end if;
  for v_col in select * from exchange.bcp_template_column c
               where c.template_version = v_version and c.sheet_code = '01_CONTROL' order by c.position loop
    v_value := exchange.bcp_normalize(v_col.kind, p_control ->> v_col.column_code);
    if not exchange.bcp_cell_ok(v_col, v_value) then perform api._fail('INVALID', v_col.column_code); end if;
    if v_value is not null then v_ctl := v_ctl || jsonb_build_object(v_col.column_code, v_value); end if;
  end loop;

  -- IDENTIFY_CASE: id and number name the same case, and the importer can see it.
  select * into v_case from case_mgmt.case_record c
   where c.id = (v_ctl ->> 'CASE_ID')::uuid and c.case_number = v_ctl ->> 'CASE_NUMBER';
  if v_case.id is null or not authz.can_view_case(v_case.id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('BCP_IMPORT') then perform api._fail('FORBIDDEN'); end if;
  if v_case.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then perform api._fail('INVALID', 'file_sha256'); end if;
  v_from := (v_ctl ->> 'OFFLINE_FROM')::timestamptz;
  v_to := (v_ctl ->> 'OFFLINE_TO')::timestamptz;
  if v_from > now() then perform api._fail('INVALID', 'OFFLINE_FROM'); end if;
  if v_to is not null and (v_to < v_from or v_to > now()) then perform api._fail('INVALID', 'OFFLINE_TO'); end if;
  v_prepared := exchange.bcp_case_user(v_ctl ->> 'PREPARED_BY', v_case.id);
  if v_prepared is null then perform api._fail('INVALID', 'PREPARED_BY'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 2000 then
    perform api._fail('INVALID', 'rows');
  end if;

  perform pg_advisory_xact_lock(hashtext('exchange.bcp_import:' || v_case.id || ':' || (v_ctl ->> 'WORKBOOK_ID')));
  if exists (select 1 from exchange.bcp_import_batch b
             where b.case_id = v_case.id and b.workbook_id = v_ctl ->> 'WORKBOOK_ID'
               and b.status in ('STAGED', 'SUBMITTED', 'APPROVED')) then
    perform api._fail('CONFLICT', 'BATCH_OPEN');
  end if;

  insert into exchange.bcp_import_batch (case_id, template_version, workbook_id, file_sha256, control, offline_from,
                                         offline_to, prepared_by, imported_by)
  values (v_case.id, v_version, v_ctl ->> 'WORKBOOK_ID', p_file_sha256, v_ctl, v_from, v_to, v_prepared, v_actor)
  returning id into v_batch;

  for v_el in select e from jsonb_array_elements(p_rows) e loop
    if jsonb_typeof(v_el) <> 'object' or jsonb_typeof(v_el -> 'cells') is distinct from 'object'
       or jsonb_typeof(v_el -> 'row_number') is distinct from 'number'
       or (v_el ? 'has_formula' and jsonb_typeof(v_el -> 'has_formula') <> 'boolean')
       or exists (select 1 from jsonb_object_keys(v_el) k where k not in ('sheet', 'row_number', 'cells', 'has_formula')) then
      perform api._fail('INVALID', 'rows');
    end if;
    select * into v_sheet from exchange.bcp_template_sheet s
     where s.template_version = v_version and s.sheet_code = v_el ->> 'sheet' and s.sheet_kind = 'DATA';
    if v_sheet.sheet_code is null or (v_el ->> 'row_number') !~ '^[0-9]{1,7}$'
       or (v_el ->> 'row_number')::int not between 3 and 1048576
       or exists (select 1 from jsonb_each(v_el -> 'cells') e
                  where jsonb_typeof(e.value) <> 'string' or length(e.value #>> '{}') > 20000
                     or not exists (select 1 from exchange.bcp_template_column c
                                    where c.template_version = v_version and c.sheet_code = v_sheet.sheet_code
                                      and c.column_code = e.key))
       or exists (select 1 from exchange.bcp_import_row r
                  where r.batch_id = v_batch and r.sheet_code = v_sheet.sheet_code
                    and r.row_number = (v_el ->> 'row_number')::int) then
      perform api._fail('INVALID', 'rows');
    end if;

    -- Column rules, in template order; the first broken column names the row's problem.
    v_cells := '{}'::jsonb;
    v_detail := case when coalesce((v_el ->> 'has_formula')::boolean, false) then 'FORMULA' end;
    for v_col in select * from exchange.bcp_template_column c
                 where c.template_version = v_version and c.sheet_code = v_sheet.sheet_code order by c.position loop
      v_value := exchange.bcp_normalize(v_col.kind, v_el -> 'cells' ->> v_col.column_code);
      if v_detail is null and not exchange.bcp_cell_ok(v_col, v_value) then v_detail := v_col.column_code; end if;
      if v_value is not null then v_cells := v_cells || jsonb_build_object(v_col.column_code, v_value); end if;
    end loop;
    v_key := v_cells ->> 'ROW_ID';
    v_event := null;
    v_recorder := null;
    if v_detail is null and exists (select 1 from exchange.bcp_import_row r where r.batch_id = v_batch and r.row_key = v_key) then
      v_detail := 'DUPLICATE_ROW_ID';
    end if;
    if v_detail is null then
      v_event := (v_cells ->> 'ORIGINAL_EVENT_AT')::timestamptz;
      if v_event < v_from or v_event > coalesce(v_to, now()) or v_event > now() or v_event < v_case.created_at then
        v_detail := 'ORIGINAL_EVENT_AT';
        v_event := null;
      end if;
    end if;
    if v_detail is null then
      v_recorder := exchange.bcp_case_user(v_cells ->> 'RECORDED_OFFLINE_BY', v_case.id);
      if v_recorder is null then v_detail := 'RECORDED_OFFLINE_BY'; v_event := null; end if;
    end if;
    v_hash := encode(sha256(convert_to(jsonb_build_object('sheet', v_sheet.sheet_code, 'cells', v_cells)::text, 'UTF8')), 'hex');

    -- CHECK_IDS, CHECK_DUPLICATES, CHECK_CONFLICTS.
    v_state := 'NEW';
    if v_detail is not null then
      v_state := 'INVALID';
    elsif v_sheet.command is null then
      v_state := 'UNSUPPORTED';
    else
      select p.payload_hash into v_prior from exchange.bcp_provenance p
       where p.case_id = v_case.id and p.workbook_id = v_ctl ->> 'WORKBOOK_ID' and p.row_key = v_key;
      if v_prior is not null then
        if v_prior = v_hash then v_state := 'ALREADY_IMPORTED'; else v_state := 'CONFLICT'; v_detail := 'CHANGED_SINCE_IMPORT'; end if;
      elsif v_cells ? 'OBJECT_ID' then
        v_state := 'CONFLICT';
        v_detail := 'EXISTING_OBJECT';
      end if;
    end if;

    insert into exchange.bcp_import_row (batch_id, case_id, template_version, sheet_code, row_number, row_key, cells,
                                         payload_hash, original_event_at, recorded_offline_by, state, detail, resolution)
    values (v_batch, v_case.id, v_version, v_sheet.sheet_code, (v_el ->> 'row_number')::int,
            case when v_key ~ '^BCP-[A-Z0-9][A-Z0-9-]{0,59}$' or exchange.bcp_is_uuid(v_key) then v_key end,
            v_cells, v_hash, v_event, v_recorder, v_state, v_detail, case when v_state = 'NEW' then 'IMPORT' end);
  end loop;

  perform audit.record_event('BCP_IMPORT_STAGED', 'BUSINESS', 'SUCCESS', v_case.id, 'bcp_import_batch', v_batch::text,
    null, jsonb_build_object('template_version', v_version, 'workbook_id', v_ctl ->> 'WORKBOOK_ID',
                             'file_sha256', p_file_sha256, 'offline_from', v_from, 'offline_to', v_to,
                             'prepared_by', v_prepared,
                             'rows', (select jsonb_object_agg(x.state, x.n) from (
                                        select r.state, count(*) n from exchange.bcp_import_row r
                                        where r.batch_id = v_batch group by r.state) x)));
  return v_batch;
end;
$$;

-- RESOLVE: the importer settles a row before submission. A NEW row is imported or skipped; a CONFLICT is kept as the
-- platform has it or skipped (USE_OFFLINE, MERGE and NEW_VERSION have no command in BCP-1); UNSUPPORTED and INVALID
-- rows are skipped. Any change clears the preview.
create function api.resolve_bcp_row(p_row_id uuid, p_resolution text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_batch_id uuid;
  b exchange.bcp_import_batch;
  r exchange.bcp_import_row;
  v_reason text;
  v_allowed boolean;
begin
  select x.batch_id into v_batch_id from exchange.bcp_import_row x where x.id = p_row_id;
  if v_batch_id is null or not authz.can_view_bcp_import(v_batch_id) then perform api._fail('NOT_FOUND'); end if;
  b := exchange.lock_bcp_batch(v_batch_id, true);
  if b.status <> 'STAGED' then perform api._fail('CONFLICT', 'NOT_STAGED'); end if;
  select * into r from exchange.bcp_import_row x where x.id = p_row_id for update;
  if p_resolution is null or p_resolution not in ('IMPORT', 'SKIP', 'KEEP_PLATFORM', 'USE_OFFLINE', 'MERGE', 'NEW_VERSION') then
    perform api._fail('INVALID', 'resolution');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 1000);
  if r.state = 'ALREADY_IMPORTED' then perform api._fail('CONFLICT', 'NOTHING_TO_RESOLVE'); end if;
  if r.state = 'CONFLICT' and p_resolution in ('USE_OFFLINE', 'MERGE', 'NEW_VERSION') then
    perform api._fail('CONFLICT', 'RESOLUTION_NOT_SUPPORTED');
  end if;
  v_allowed := case r.state when 'NEW' then p_resolution in ('IMPORT', 'SKIP')
                            when 'CONFLICT' then p_resolution in ('KEEP_PLATFORM', 'SKIP')
                            else p_resolution = 'SKIP' end;
  if not v_allowed then perform api._fail('CONFLICT', 'RESOLUTION_NOT_ALLOWED'); end if;
  update exchange.bcp_import_row
     set resolution = p_resolution, resolution_reason = v_reason, resolved_by = v_actor, resolved_at = now(), outcome = null
   where id = r.id;
  update exchange.bcp_import_batch
     set preview_hash = null, previewed_at = null, preview_clean = false, updated_at = now(), row_version = row_version + 1
   where id = b.id;
  perform audit.record_event('BCP_IMPORT_ROW_RESOLVED', 'BUSINESS', 'SUCCESS', b.case_id, 'bcp_import_row', r.id::text,
    v_reason, jsonb_build_object('batch_id', b.id, 'sheet', r.sheet_code, 'state', r.state, 'resolution', p_resolution,
                                 'previous_resolution', r.resolution));
end;
$$;

-- PREVIEW: every row with its state, resolution and dry-run outcome, and the hash submission is bound to. Only the
-- importer previews (the dry run runs as them). Rows without a resolution keep the batch from being clean.
create function api.preview_bcp_import(p_batch_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  b exchange.bcp_import_batch;
  v_clean boolean;
  v_hash text;
begin
  b := exchange.lock_bcp_batch(p_batch_id, true);
  if b.status = 'STAGED' then
    v_clean := exchange.bcp_dry_run(b.id)
               and not exists (select 1 from exchange.bcp_import_row r
                               where r.batch_id = b.id and r.resolution is null and r.state <> 'ALREADY_IMPORTED');
    v_hash := exchange.bcp_batch_hash(b.id);
    update exchange.bcp_import_batch
       set preview_hash = v_hash, previewed_at = now(), preview_clean = v_clean, updated_at = now(),
           row_version = row_version + 1
     where id = b.id;
  else
    v_clean := b.preview_clean;
    v_hash := exchange.bcp_batch_hash(b.id);
  end if;
  perform audit.record_event('BCP_IMPORT_PREVIEWED', 'BUSINESS', 'SUCCESS', b.case_id, 'bcp_import_batch', b.id::text,
    null, jsonb_build_object('status', b.status, 'preview_hash', v_hash, 'clean', v_clean));
  return jsonb_build_object(
    'hash', v_hash, 'clean', v_clean, 'status', b.status,
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', r.id, 'sheet', r.sheet_code, 'row_number', r.row_number, 'row_key', r.row_key,
                        'state', r.state, 'detail', r.detail, 'resolution', r.resolution, 'outcome', r.outcome)
                        order by s.position, r.row_number)
                      from exchange.bcp_import_row r
                      join exchange.bcp_template_sheet s on s.template_version = r.template_version and s.sheet_code = r.sheet_code
                      where r.batch_id = b.id), '[]'::jsonb));
end;
$$;

-- SUBMIT: bound to the importer's own preview; every row resolved and the dry run clean, again, now.
create function api.submit_bcp_import(p_batch_id uuid, p_preview_hash text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  b exchange.bcp_import_batch;
  v_hash text;
begin
  b := exchange.lock_bcp_batch(p_batch_id, true);
  if b.status <> 'STAGED' then perform api._fail('CONFLICT', 'NOT_STAGED'); end if;
  if exists (select 1 from exchange.bcp_import_row r
             where r.batch_id = b.id and r.resolution is null and r.state <> 'ALREADY_IMPORTED') then
    perform api._fail('CONFLICT', 'ROWS_UNRESOLVED');
  end if;
  v_hash := exchange.bcp_batch_hash(b.id);
  if b.preview_hash is null or b.preview_hash <> v_hash or p_preview_hash is distinct from v_hash then
    perform api._fail('CONFLICT', 'PREVIEW_CHANGED');
  end if;
  if not exchange.bcp_dry_run(b.id) then perform api._fail('CONFLICT', 'DRY_RUN_FAILED'); end if;
  update exchange.bcp_import_batch
     set status = 'SUBMITTED', submitted_hash = v_hash, submitted_at = now(), preview_clean = true, updated_at = now(),
         row_version = row_version + 1
   where id = b.id;
  perform audit.record_event('BCP_IMPORT_SUBMITTED', 'BUSINESS', 'SUCCESS', b.case_id, 'bcp_import_batch', b.id::text,
    null, jsonb_build_object('preview_hash', v_hash,
                             'to_import', (select count(*) from exchange.bcp_import_row r
                                           where r.batch_id = b.id and r.resolution = 'IMPORT'),
                             'skipped', (select count(*) from exchange.bcp_import_row r
                                         where r.batch_id = b.id and r.resolution = 'SKIP'),
                             'kept', (select count(*) from exchange.bcp_import_row r
                                      where r.batch_id = b.id and r.resolution = 'KEEP_PLATFORM')));
  return 'SUBMITTED';
end;
$$;

-- APPROVE_IMPORT: a different person, who sees the case and recorded no row offline.
create function api.decide_bcp_import(p_batch_id uuid, p_decision text, p_reason text, p_hash text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  b exchange.bcp_import_batch;
  v_reason text;
  v_status text;
begin
  b := exchange.lock_bcp_batch(p_batch_id, false);
  if not authz.has_permission('BCP_IMPORT_APPROVE') or b.imported_by = v_actor or b.prepared_by = v_actor
     or exists (select 1 from exchange.bcp_import_row r where r.batch_id = b.id and r.recorded_offline_by = v_actor) then
    perform api._fail('FORBIDDEN');
  end if;
  if b.status <> 'SUBMITTED' then perform api._fail('CONFLICT', 'NOT_SUBMITTED'); end if;
  if p_decision is null or p_decision not in ('APPROVE', 'REJECT') then perform api._fail('INVALID', 'decision'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  if p_hash is distinct from b.submitted_hash or exchange.bcp_batch_hash(b.id) <> b.submitted_hash then
    perform api._fail('CONFLICT', 'PREVIEW_CHANGED');
  end if;
  v_status := case p_decision when 'APPROVE' then 'APPROVED' else 'REJECTED' end;
  update exchange.bcp_import_batch
     set status = v_status, decided_by = v_actor, decided_at = now(), decision_reason = v_reason, updated_at = now(),
         row_version = row_version + 1
   where id = b.id;
  perform audit.record_event(case v_status when 'APPROVED' then 'BCP_IMPORT_APPROVED' else 'BCP_IMPORT_REJECTED' end,
    'BUSINESS', 'SUCCESS', b.case_id, 'bcp_import_batch', b.id::text, v_reason,
    jsonb_build_object('submitted_hash', b.submitted_hash));
  return v_status;
end;
$$;

-- TRANSACTIONAL_IMPORT: the importer applies the approved batch through the commands, all or nothing.
create function api.apply_bcp_import(p_batch_id uuid, p_hash text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  b exchange.bcp_import_batch;
  v_out jsonb;
  v_counts jsonb;
begin
  b := exchange.lock_bcp_batch(p_batch_id, true);
  if b.status <> 'APPROVED' then perform api._fail('CONFLICT', 'NOT_APPROVED'); end if;
  if p_hash is distinct from b.submitted_hash or exchange.bcp_batch_hash(b.id) <> b.submitted_hash then
    perform api._fail('CONFLICT', 'PREVIEW_CHANGED');
  end if;
  v_out := exchange.bcp_run(b.id, true);
  update exchange.bcp_import_batch
     set status = 'IMPORTED', applied_at = now(), updated_at = now(), row_version = row_version + 1
   where id = b.id;
  select jsonb_build_object(
           'imported', (select count(*) from jsonb_object_keys(v_out)),
           'skipped', count(*) filter (where r.resolution = 'SKIP'),
           'kept', count(*) filter (where r.resolution = 'KEEP_PLATFORM'),
           'already_imported', count(*) filter (where r.state = 'ALREADY_IMPORTED'))
    into v_counts
    from exchange.bcp_import_row r where r.batch_id = b.id;
  perform audit.record_event('BCP_IMPORT_COMPLETED', 'BUSINESS', 'SUCCESS', b.case_id, 'bcp_import_batch', b.id::text,
    null, v_counts || jsonb_build_object('workbook_id', b.workbook_id, 'submitted_hash', b.submitted_hash,
                                         'approved_by', b.decided_by));
  return v_counts;
end;
$$;

create function api.cancel_bcp_import(p_batch_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  b exchange.bcp_import_batch;
  v_reason text;
begin
  b := exchange.lock_bcp_batch(p_batch_id, true);
  if b.status not in ('STAGED', 'SUBMITTED', 'APPROVED') then perform api._fail('CONFLICT', 'NOT_OPEN'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update exchange.bcp_import_batch
     set status = 'CANCELLED', cancelled_at = now(), updated_at = now(), row_version = row_version + 1
   where id = b.id;
  perform audit.record_event('BCP_IMPORT_CANCELLED', 'BUSINESS', 'SUCCESS', b.case_id, 'bcp_import_batch', b.id::text,
    v_reason, jsonb_build_object('previous_status', b.status));
end;
$$;

grant execute on function
  api.stage_bcp_import(jsonb, text, jsonb),
  api.resolve_bcp_row(uuid, text, text),
  api.preview_bcp_import(uuid),
  api.submit_bcp_import(uuid, text),
  api.decide_bcp_import(uuid, text, text, text),
  api.apply_bcp_import(uuid, text),
  api.cancel_bcp_import(uuid, text)
to authenticated;
