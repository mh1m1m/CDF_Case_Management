-- =============================================================================
-- 1100 Forms engine: WB-FRM definitions as data, case form instances with versions, hash and
-- a prepared → reviewed → approved lifecycle (Phase 8, CDF-50; ADR-011)
-- Requirements: §12–§14, §18–§19, §29–§30, §45, §83, §87
--
-- Definitions (reference data, migration 1110) describe the 19 baseline forms: sections, typed fields,
-- which roles may VIEW / PREPARE / REVIEW / APPROVE each form, and whether review and approval are required.
-- An instance binds one definition version to one case. Every save appends an immutable version whose
-- content_hash = sha256(form_code ':' schema_hash ':' canonical_json(data)); the TypeScript mirror
-- (@cdf/domain formContentHash) computes the same value and tests prove it. Events are append-only.
--
-- Lifecycle   DRAFT ──prepare──▶ PREPARED ──review──▶ REVIEWED ──approve──▶ APPROVED
--               ▲                   │ return            │ return
--               └───────────────────┴───────────────────┘        any non-final state ──withdraw──▶ WITHDRAWN
-- The final state is APPROVED when approval is required, otherwise REVIEWED when review is required,
-- otherwise PREPARED. Separation of duties: the reviewer is not the preparer; the approver is neither.
--
-- Field values are stored as strings in their lexical form (dates YYYY-MM-DD, booleans true/false, numbers
-- as decimal text) and validated by forms.validate_data on every save (lenient) and on prepare (strict).
-- Form content never enters the audit ledger: events carry codes, numbers and hashes only (§83).
-- =============================================================================

create schema if not exists forms;
revoke all on schema forms from public;
alter default privileges in schema forms revoke all on tables from public, anon, authenticated;
alter default privileges in schema forms revoke all on sequences from public, anon, authenticated;
alter default privileges in schema forms revoke execute on functions from public, anon, authenticated;
grant usage on schema forms to authenticated;

-- -----------------------------------------------------------------------------
-- Permissions (mirrored in packages/authorization; tests/integration/mirrors.spec.ts). The role rows
-- follow from the entitlements in migration 1110: a role holds FORM_<action> iff it is entitled to
-- <action> on at least one form.
-- -----------------------------------------------------------------------------
insert into iam.permission (code, description) values
  ('FORM_VIEW',    'Read form instances on viewable cases for forms the role is entitled to'),
  ('FORM_PREPARE', 'Start, fill and prepare form instances on active cases the user works on'),
  ('FORM_REVIEW',  'Review or return prepared form instances'),
  ('FORM_APPROVE', 'Approve or return reviewed form instances');

insert into iam.role_permission (role_code, permission_code) values
  ('INTAKE_OFFICER',       'FORM_VIEW'), ('INTAKE_OFFICER',       'FORM_PREPARE'),
  ('TRIAGE_OFFICER',       'FORM_VIEW'), ('TRIAGE_OFFICER',       'FORM_PREPARE'),
  ('CASE_MANAGER',         'FORM_VIEW'), ('CASE_MANAGER',         'FORM_PREPARE'), ('CASE_MANAGER',      'FORM_REVIEW'),
  ('COMPLIANCE',           'FORM_VIEW'), ('COMPLIANCE',           'FORM_PREPARE'), ('COMPLIANCE',        'FORM_REVIEW'),
  ('INVESTIGATOR',         'FORM_VIEW'), ('INVESTIGATOR',         'FORM_PREPARE'),
  ('LEAD_INVESTIGATOR',    'FORM_VIEW'), ('LEAD_INVESTIGATOR',    'FORM_PREPARE'), ('LEAD_INVESTIGATOR', 'FORM_REVIEW'),
  ('COMMITTEE_SECRETARY',  'FORM_VIEW'), ('COMMITTEE_SECRETARY',  'FORM_PREPARE'),
  ('COMMITTEE_CHAIR',      'FORM_VIEW'), ('COMMITTEE_CHAIR',      'FORM_REVIEW'),  ('COMMITTEE_CHAIR',   'FORM_APPROVE'),
  ('COMMITTEE_MEMBER',     'FORM_VIEW'),
  ('GRC_DIRECTOR',         'FORM_VIEW'), ('GRC_DIRECTOR',         'FORM_REVIEW'),  ('GRC_DIRECTOR',      'FORM_APPROVE'),
  ('LEGAL_REVIEWER',       'FORM_VIEW'),
  ('HR_REVIEWER',          'FORM_VIEW'),
  ('DECISION_AUTHORITY',   'FORM_VIEW'), ('DECISION_AUTHORITY',   'FORM_APPROVE'),
  ('IMPLEMENTATION_OWNER', 'FORM_VIEW'), ('IMPLEMENTATION_OWNER', 'FORM_PREPARE');
-- PRIVACY_DPO, RECORDS_OFFICER, INTERNAL_AUDIT, SOC_ANALYST, PLATFORM_ADMIN, DB_ADMIN, REFERRER: no form access (§21).

-- -----------------------------------------------------------------------------
-- Definitions (reference data; rows ship in migration 1110)
-- -----------------------------------------------------------------------------
create table forms.form_definition (
  code               text primary key check (code ~ '^WB-FRM-[0-9]{2}$'),
  sequence_no        int not null unique check (sequence_no between 1 and 99),
  name_ar            text not null check (length(name_ar) between 2 and 200),
  name_en            text not null check (length(name_en) between 2 and 200),
  purpose_ar         text not null check (length(purpose_ar) <= 1000),
  purpose_en         text not null check (length(purpose_en) <= 1000),
  -- Which function owns the form in the baseline; informs reviewer derivation, never authorization.
  owner_role_hint    text not null check (owner_role_hint in ('COMPLIANCE_INTAKE', 'INVESTIGATOR', 'COMMITTEE_SECRETARY')),
  source_reference   text not null check (length(source_reference) <= 200),
  review_required    boolean not null,
  approval_required  boolean not null,
  -- Whether a case may hold more than one live instance (SOURCE_REQUIRED; true until the procedure says otherwise).
  repeatable         boolean not null default true,
  is_enabled         boolean not null default true,
  current_version_id uuid,  -- FK added below
  check (not approval_required or review_required)
);
comment on table forms.form_definition is 'The 19 WB-FRM forms of the baseline as data (ADR-011). Changing a form means publishing a new version, never editing instances.';

create table forms.form_definition_version (
  id           uuid primary key default gen_random_uuid(),
  form_code    text not null references forms.form_definition (code),
  version_no   int not null check (version_no >= 1),
  -- Sections and fields exactly as the TypeScript registry holds them (camelCase document), for rendering.
  schema       jsonb not null check (jsonb_typeof(schema) = 'array' and jsonb_array_length(schema) >= 1),
  -- sha256 of the canonical JSON of `schema`; part of every instance content hash.
  schema_hash  text not null check (schema_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz not null default now(),
  unique (form_code, version_no)
);

create table forms.form_field_definition (
  id               uuid primary key default gen_random_uuid(),
  version_id       uuid not null references forms.form_definition_version (id),
  section_no       int not null check (section_no >= 1),
  section_title_ar text not null,
  section_title_en text not null,
  field_no         int not null check (field_no >= 1),
  name             text not null check (name ~ '^[a-z][a-z0-9_]{1,63}$'),
  label_ar         text not null check (length(label_ar) between 1 and 200),
  label_en         text not null check (length(label_en) between 1 and 200),
  field_type       text not null check (field_type in ('text', 'textarea', 'date', 'select', 'boolean', 'number')),
  required         boolean not null default false,
  -- [{ "value": ..., "labelAr": ..., "labelEn": ... }]; the stored data holds `value`.
  options          jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  help_ar          text check (length(help_ar) <= 500),
  help_en          text check (length(help_en) <= 500),
  -- Flagged by the baseline for display emphasis; access is governed by case access and clearance.
  sensitive        boolean not null default false,
  unique (version_id, name),
  unique (version_id, field_no),
  check ((field_type = 'select') = (jsonb_array_length(options) > 0))
);
create index form_field_definition_version on forms.form_field_definition (version_id, field_no);

alter table forms.form_definition
  add constraint form_definition_current_version_fk foreign key (current_version_id) references forms.form_definition_version (id);

create table forms.form_entitlement (
  form_code text not null references forms.form_definition (code),
  role_code text not null references iam.role (code),
  action    text not null check (action in ('VIEW', 'PREPARE', 'REVIEW', 'APPROVE')),
  source    text not null check (source in ('BASELINE', 'DERIVED', 'SOURCE_REQUIRED')),
  primary key (form_code, role_code, action)
);
comment on table forms.form_entitlement is 'Role × form × action matrix from the baseline. Combined with FORM_* permissions and case access by authz.*; never sufficient alone.';

-- -----------------------------------------------------------------------------
-- Instances
-- -----------------------------------------------------------------------------
create table forms.form_instance (
  id                    uuid primary key default gen_random_uuid(),
  case_id               uuid not null references case_mgmt.case_record (id),
  form_code             text not null references forms.form_definition (code),
  definition_version_id uuid not null references forms.form_definition_version (id),
  -- Display number within the case and form (WB-FRM-11 #2). UUIDs are the keys (§87).
  instance_no           int not null check (instance_no >= 1),
  status                text not null default 'DRAFT' check (status in ('DRAFT', 'PREPARED', 'REVIEWED', 'APPROVED', 'WITHDRAWN')),
  -- Never below the case classification; may be higher, which hides the form from lower-cleared team members.
  classification        core.classification_level not null,
  current_version_id    uuid,  -- FK added below; null until the first save
  prepared_version_id   uuid,  -- the version locked by prepare; what reviewers and approvers decide on
  prepared_by           uuid references iam.user_profile (id),
  prepared_at           timestamptz,
  reviewed_by           uuid references iam.user_profile (id),
  reviewed_at           timestamptz,
  approved_by           uuid references iam.user_profile (id),
  approved_at           timestamptz,
  withdrawn_by          uuid references iam.user_profile (id),
  withdrawn_at          timestamptz,
  created_by            uuid not null references iam.user_profile (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (case_id, form_code, instance_no),
  check ((prepared_by is null) = (prepared_at is null)),
  check ((reviewed_by is null) = (reviewed_at is null)),
  check ((approved_by is null) = (approved_at is null)),
  check ((withdrawn_by is null) = (withdrawn_at is null)),
  check ((status = 'WITHDRAWN') = (withdrawn_at is not null)),
  check (status not in ('PREPARED', 'REVIEWED', 'APPROVED') or (prepared_version_id is not null and prepared_by is not null)),
  check (status not in ('REVIEWED', 'APPROVED') or reviewed_by is not null),
  check (status <> 'APPROVED' or approved_by is not null)
);
create index form_instance_case on forms.form_instance (case_id, form_code, instance_no);
comment on table forms.form_instance is 'One filled form on one case, bound to a definition version. Content lives in form_instance_version.';

create table forms.form_instance_version (
  id           uuid primary key default gen_random_uuid(),
  instance_id  uuid not null references forms.form_instance (id),
  version_no   int not null check (version_no >= 1),
  -- Normalised data: field name → string value; empty values are dropped before storage.
  data         jsonb not null check (jsonb_typeof(data) = 'object' and length(data::text) <= 262144),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  saved_by     uuid not null references iam.user_profile (id),
  saved_at     timestamptz not null default now(),
  request_id   uuid,
  unique (instance_id, version_no)
);
comment on table forms.form_instance_version is 'Append-only. content_hash = sha256(form_code || '':'' || schema_hash || '':'' || forms.canonical_json(data)).';

alter table forms.form_instance
  add constraint form_instance_current_version_fk foreign key (current_version_id) references forms.form_instance_version (id),
  add constraint form_instance_prepared_version_fk foreign key (prepared_version_id) references forms.form_instance_version (id);

create table forms.form_event (
  id          uuid primary key default gen_random_uuid(),
  -- Strict order (now() is constant within a transaction).
  seq         bigint generated always as identity,
  instance_id uuid not null references forms.form_instance (id),
  event_type  text not null check (event_type in ('CREATED', 'SAVED', 'PREPARED', 'REVIEWED', 'RETURNED', 'APPROVED', 'WITHDRAWN')),
  from_status text check (from_status in ('DRAFT', 'PREPARED', 'REVIEWED', 'APPROVED', 'WITHDRAWN')),
  to_status   text not null check (to_status in ('DRAFT', 'PREPARED', 'REVIEWED', 'APPROVED', 'WITHDRAWN')),
  version_id  uuid references forms.form_instance_version (id),
  actor_id    uuid not null references iam.user_profile (id),
  occurred_at timestamptz not null default now(),
  reason      text check (length(reason) <= 2000),
  request_id  uuid
);
create index form_event_instance on forms.form_event (instance_id, seq);
comment on table forms.form_event is 'Append-only lifecycle trail of a form instance. UPDATE/DELETE/TRUNCATE are rejected for every role.';

-- The status that completes a form (mirrored by @cdf/domain formFinalStatus).
create function forms.terminal_status(p_review_required boolean, p_approval_required boolean)
returns text
language sql immutable
set search_path = ''
as $$
  select case when p_approval_required then 'APPROVED' when p_review_required then 'REVIEWED' else 'PREPARED' end;
$$;

-- -----------------------------------------------------------------------------
-- Immutability: versions and events are append-only, instances are never deleted and freeze once final.
-- -----------------------------------------------------------------------------
create function forms.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'forms.% is append-only (% rejected)', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger form_instance_version_no_update before update on forms.form_instance_version
  for each row execute function forms.reject_mutation();
create trigger form_instance_version_no_delete before delete on forms.form_instance_version
  for each row execute function forms.reject_mutation();
create trigger form_instance_version_no_truncate before truncate on forms.form_instance_version
  for each statement execute function forms.reject_mutation();
create trigger form_event_no_update before update on forms.form_event
  for each row execute function forms.reject_mutation();
create trigger form_event_no_delete before delete on forms.form_event
  for each row execute function forms.reject_mutation();
create trigger form_event_no_truncate before truncate on forms.form_event
  for each statement execute function forms.reject_mutation();
create trigger form_instance_no_delete before delete on forms.form_instance
  for each row execute function forms.reject_mutation();
create trigger form_instance_no_truncate before truncate on forms.form_instance
  for each statement execute function forms.reject_mutation();

create function forms.protect_instance()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_final text;
begin
  select forms.terminal_status(d.review_required, d.approval_required) into v_final
    from forms.form_definition d where d.code = old.form_code;
  if old.status = 'WITHDRAWN' or old.status = v_final then
    raise exception 'form instance % is final (%)', old.id, old.status using errcode = 'insufficient_privilege';
  end if;
  if new.id <> old.id or new.case_id <> old.case_id or new.form_code <> old.form_code
     or new.definition_version_id <> old.definition_version_id or new.instance_no <> old.instance_no
     or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'form instance % identity fields are immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger form_instance_protect before update on forms.form_instance
  for each row execute function forms.protect_instance();

-- -----------------------------------------------------------------------------
-- Canonical JSON and content hash (mirrored by @cdf/domain canonicalJson / formContentHash)
-- -----------------------------------------------------------------------------
-- Flat object of string values; keys in byte order (field names are ASCII identifiers); no whitespace.
create function forms.canonical_json(p_data jsonb)
returns text
language sql immutable
set search_path = ''
as $$
  select '{' || coalesce(string_agg(to_jsonb(e.key)::text || ':' || to_jsonb(e.value)::text, ',' order by e.key collate "C"), '') || '}'
  from jsonb_each_text(p_data) e;
$$;

create function forms.content_hash(p_form_code text, p_schema_hash text, p_data jsonb)
returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_form_code || ':' || p_schema_hash || ':' || forms.canonical_json(p_data), 'UTF8')), 'hex');
$$;

-- -----------------------------------------------------------------------------
-- Validation (third enforcement point after the browser and the application layer, §45).
-- Returns the normalised data (empty values dropped). Raises CDF_INVALID:<field> on the first problem.
-- Strict mode (prepare) additionally requires every required field.
-- -----------------------------------------------------------------------------
create function forms.validate_data(p_version_id uuid, p_data jsonb, p_strict boolean)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  f forms.form_field_definition;
  v_norm jsonb := '{}'::jsonb;
  v_val jsonb;
  v_text text;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then perform api._fail('INVALID', 'data'); end if;
  if length(p_data::text) > 262144 then perform api._fail('INVALID', 'data'); end if;
  -- Unknown keys are rejected (the key name is user input and is not echoed back).
  if exists (
    select 1 from jsonb_object_keys(p_data) k
    where not exists (select 1 from forms.form_field_definition d where d.version_id = p_version_id and d.name = k)
  ) then
    perform api._fail('INVALID', 'data');
  end if;

  for f in select * from forms.form_field_definition d where d.version_id = p_version_id order by d.field_no loop
    v_val := p_data -> f.name;
    if v_val is null or jsonb_typeof(v_val) = 'null' then
      if p_strict and f.required then perform api._fail('INVALID', f.name); end if;
      continue;
    end if;
    if jsonb_typeof(v_val) <> 'string' then perform api._fail('INVALID', f.name); end if;
    v_text := v_val #>> '{}';
    if btrim(v_text) = '' then
      if p_strict and f.required then perform api._fail('INVALID', f.name); end if;
      continue;
    end if;
    case f.field_type
      when 'text' then
        if length(v_text) > 500 or v_text ~ '[[:cntrl:]]' then perform api._fail('INVALID', f.name); end if;
      when 'textarea' then
        if length(v_text) > 4000 or regexp_replace(v_text, E'[\\n\\r\\t]', '', 'g') ~ '[[:cntrl:]]' then
          perform api._fail('INVALID', f.name);
        end if;
      when 'date' then
        if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or to_char(to_date(v_text, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> v_text then
          perform api._fail('INVALID', f.name);
        end if;
      when 'select' then
        if not exists (select 1 from jsonb_array_elements(f.options) o where o ->> 'value' = v_text) then
          perform api._fail('INVALID', f.name);
        end if;
      when 'boolean' then
        if v_text not in ('true', 'false') then perform api._fail('INVALID', f.name); end if;
      when 'number' then
        if v_text !~ '^-?[0-9]{1,15}(\.[0-9]{1,6})?$' then perform api._fail('INVALID', f.name); end if;
      else
        perform api._fail('INVALID', f.name);
    end case;
    v_norm := v_norm || jsonb_build_object(f.name, v_text);
  end loop;
  return v_norm;
exception
  when invalid_datetime_format or datetime_field_overflow then
    perform api._fail('INVALID', coalesce(f.name, 'data'));
    return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Authorization (§19): case access + clearance + FORM_* permission + role entitlement for the form
-- -----------------------------------------------------------------------------
create function authz.form_entitled(p_form_code text, p_action text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from forms.form_entitlement e
    where e.form_code = p_form_code and e.action = p_action and e.role_code = any (authz.current_roles())
  );
$$;

create function authz.can_view_form_instance(p_instance_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from forms.form_instance i
    where i.id = p_instance_id
      and authz.can_view_case(i.case_id)
      and i.classification <= authz.current_clearance()
      and authz.has_permission('FORM_VIEW')
      and authz.form_entitled(i.form_code, 'VIEW')
  );
$$;

-- Preparing needs the permission, the entitlement, an active case and a working relationship with it:
-- general edit rights, an active assignment, or an access grant other than AUDIT.
create function authz.can_prepare_form(p_case_id uuid, p_form_code text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id)
     and authz.has_permission('FORM_PREPARE')
     and authz.form_entitled(p_form_code, 'PREPARE')
     and exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state = 'ACTIVE')
     and exists (select 1 from forms.form_definition d where d.code = p_form_code and d.is_enabled)
     and (authz.has_permission('CASE_EDIT_ALL')
          or authz.has_active_assignment(p_case_id, authz.current_user_id())
          or exists (select 1 from case_mgmt.case_access_grant g
                     where g.case_id = p_case_id and g.user_id = authz.current_user_id() and g.status = 'ACTIVE'
                       and g.scope <> 'AUDIT' and g.effective_from <= now()
                       and (g.effective_to is null or g.effective_to > now())));
$$;

create function authz.can_review_form(p_instance_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from forms.form_instance i join forms.form_definition d on d.code = i.form_code
    where i.id = p_instance_id
      and d.review_required
      and authz.can_view_form_instance(i.id)
      and authz.has_permission('FORM_REVIEW')
      and authz.form_entitled(i.form_code, 'REVIEW')
  );
$$;

create function authz.can_approve_form(p_instance_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from forms.form_instance i join forms.form_definition d on d.code = i.form_code
    where i.id = p_instance_id
      and d.approval_required
      and authz.can_view_form_instance(i.id)
      and authz.has_permission('FORM_APPROVE')
      and authz.form_entitled(i.form_code, 'APPROVE')
  );
$$;

grant execute on function
  authz.form_entitled(text, text), authz.can_view_form_instance(uuid), authz.can_prepare_form(uuid, text),
  authz.can_review_form(uuid), authz.can_approve_form(uuid),
  forms.canonical_json(jsonb), forms.content_hash(text, text, jsonb), forms.terminal_status(boolean, boolean)
to authenticated;

-- -----------------------------------------------------------------------------
-- RLS (SELECT only). request_id is never readable by application roles.
-- -----------------------------------------------------------------------------
alter table forms.form_definition enable row level security;
alter table forms.form_definition_version enable row level security;
alter table forms.form_field_definition enable row level security;
alter table forms.form_entitlement enable row level security;
alter table forms.form_instance enable row level security;
alter table forms.form_instance_version enable row level security;
alter table forms.form_event enable row level security;

create policy form_definition_read on forms.form_definition for select to authenticated
  using (authz.current_user_id() is not null);
create policy form_definition_version_read on forms.form_definition_version for select to authenticated
  using (authz.current_user_id() is not null);
create policy form_field_definition_read on forms.form_field_definition for select to authenticated
  using (authz.current_user_id() is not null);
create policy form_entitlement_read on forms.form_entitlement for select to authenticated
  using (authz.current_user_id() is not null);
grant select on forms.form_definition, forms.form_definition_version, forms.form_field_definition, forms.form_entitlement
  to authenticated;

create policy form_instance_read on forms.form_instance for select to authenticated
  using (authz.can_view_form_instance(id));
grant select on forms.form_instance to authenticated;

create policy form_instance_version_read on forms.form_instance_version for select to authenticated
  using (authz.can_view_form_instance(instance_id));
grant select (id, instance_id, version_no, data, content_hash, saved_by, saved_at) on forms.form_instance_version to authenticated;

create policy form_event_read on forms.form_event for select to authenticated
  using (authz.can_view_form_instance(instance_id));
grant select (id, seq, instance_id, event_type, from_status, to_status, version_id, actor_id, occurred_at, reason)
  on forms.form_event to authenticated;

-- -----------------------------------------------------------------------------
-- Commands
-- -----------------------------------------------------------------------------
create function api.open_form_instance(p_instance_id uuid)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_inst forms.form_instance;
begin
  select * into v_inst from forms.form_instance i where i.id = p_instance_id;
  if v_inst.id is not null and authz.can_view_form_instance(p_instance_id) then
    perform audit.record_event('FORM_VIEWED', 'BUSINESS', 'SUCCESS', v_inst.case_id, 'form_instance', p_instance_id::text, null,
      jsonb_build_object('form_code', v_inst.form_code, 'instance_no', v_inst.instance_no, 'status', v_inst.status));
    return true;
  end if;
  perform audit.record_event('FORM_ACCESS_DENIED', 'SECURITY', 'DENIED', null, 'form_instance', p_instance_id::text, null,
    jsonb_build_object('target_exists', v_inst.id is not null,
                       'case_visible', case when v_inst.id is null then null else authz.can_view_case(v_inst.case_id) end));
  return false;
end;
$$;

create function api.start_form(p_case_id uuid, p_form_code text, p_classification core.classification_level)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_def forms.form_definition;
  v_version forms.form_definition_version;
  v_id uuid;
  v_no int;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_def from forms.form_definition d where d.code = p_form_code;
  if v_def.code is null or not v_def.is_enabled or v_def.current_version_id is null then perform api._fail('INVALID', 'form_code'); end if;
  if not authz.can_prepare_form(p_case_id, p_form_code) then perform api._fail('FORBIDDEN'); end if;
  -- Locking the case serialises instance numbering.
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  if p_classification is null or p_classification < v_case.classification or p_classification > authz.current_clearance() then
    perform api._fail('INVALID', 'classification');
  end if;
  if not v_def.repeatable and exists (
    select 1 from forms.form_instance i where i.case_id = p_case_id and i.form_code = p_form_code and i.status <> 'WITHDRAWN'
  ) then
    perform api._fail('CONFLICT', 'FORM_ALREADY_STARTED');
  end if;
  select * into v_version from forms.form_definition_version v where v.id = v_def.current_version_id;
  select coalesce(max(i.instance_no), 0) + 1 into v_no from forms.form_instance i where i.case_id = p_case_id and i.form_code = p_form_code;

  insert into forms.form_instance (case_id, form_code, definition_version_id, instance_no, classification, created_by)
  values (p_case_id, p_form_code, v_version.id, v_no, p_classification, v_actor)
  returning id into v_id;

  insert into forms.form_event (instance_id, event_type, from_status, to_status, actor_id, request_id)
  values (v_id, 'CREATED', null, 'DRAFT', v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid);

  perform audit.record_event('FORM_STARTED', 'BUSINESS', 'SUCCESS', p_case_id, 'form_instance', v_id::text, null,
    jsonb_build_object('form_code', p_form_code, 'instance_no', v_no, 'definition_version_no', v_version.version_no,
                       'classification', p_classification));
  return v_id;
end;
$$;

-- Saves a draft version. Idempotent: identical content returns the current version without a new row.
create function api.save_form_draft(p_instance_id uuid, p_data jsonb)
returns table (o_version_id uuid, o_version_no int, o_content_hash text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_inst forms.form_instance;
  v_schema_hash text;
  v_norm jsonb;
  v_hash text;
  v_current forms.form_instance_version;
  v_version_id uuid;
  v_version_no int;
begin
  select * into v_inst from forms.form_instance i where i.id = p_instance_id for update;
  if v_inst.id is null or not authz.can_view_form_instance(p_instance_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_prepare_form(v_inst.case_id, v_inst.form_code) then perform api._fail('FORBIDDEN'); end if;
  if v_inst.status <> 'DRAFT' then perform api._fail('CONFLICT', 'FORM_NOT_DRAFT'); end if;

  select v.schema_hash into v_schema_hash from forms.form_definition_version v where v.id = v_inst.definition_version_id;
  v_norm := forms.validate_data(v_inst.definition_version_id, p_data, false);
  v_hash := forms.content_hash(v_inst.form_code, v_schema_hash, v_norm);

  if v_inst.current_version_id is not null then
    select * into v_current from forms.form_instance_version v where v.id = v_inst.current_version_id;
    if v_current.content_hash = v_hash then
      return query select v_current.id, v_current.version_no, v_current.content_hash;
      return;
    end if;
  end if;

  select coalesce(max(v.version_no), 0) + 1 into v_version_no from forms.form_instance_version v where v.instance_id = p_instance_id;
  insert into forms.form_instance_version (instance_id, version_no, data, content_hash, saved_by, request_id)
  values (p_instance_id, v_version_no, v_norm, v_hash, v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid)
  returning id into v_version_id;

  update forms.form_instance set current_version_id = v_version_id, updated_at = now() where id = p_instance_id;

  insert into forms.form_event (instance_id, event_type, from_status, to_status, version_id, actor_id, request_id)
  values (p_instance_id, 'SAVED', 'DRAFT', 'DRAFT', v_version_id, v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid);

  perform audit.record_event('FORM_SAVED', 'BUSINESS', 'SUCCESS', v_inst.case_id, 'form_instance', p_instance_id::text, null,
    jsonb_build_object('form_code', v_inst.form_code, 'instance_no', v_inst.instance_no, 'version_no', v_version_no,
                       'content_hash', v_hash));
  return query select v_version_id, v_version_no, v_hash;
end;
$$;

-- Locks the current version as the prepared content. Strict validation: every required field present.
create function api.prepare_form(p_instance_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_inst forms.form_instance;
  v_def forms.form_definition;
  v_current forms.form_instance_version;
begin
  select * into v_inst from forms.form_instance i where i.id = p_instance_id for update;
  if v_inst.id is null or not authz.can_view_form_instance(p_instance_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_prepare_form(v_inst.case_id, v_inst.form_code) then perform api._fail('FORBIDDEN'); end if;
  if v_inst.status <> 'DRAFT' then perform api._fail('CONFLICT', 'FORM_NOT_DRAFT'); end if;
  if v_inst.current_version_id is null then perform api._fail('CONFLICT', 'FORM_EMPTY'); end if;
  select * into v_def from forms.form_definition d where d.code = v_inst.form_code;
  select * into v_current from forms.form_instance_version v where v.id = v_inst.current_version_id;
  perform forms.validate_data(v_inst.definition_version_id, v_current.data, true);

  update forms.form_instance
     set status = 'PREPARED', prepared_version_id = v_inst.current_version_id, prepared_by = v_actor, prepared_at = now(),
         updated_at = now()
   where id = p_instance_id;

  insert into forms.form_event (instance_id, event_type, from_status, to_status, version_id, actor_id, request_id)
  values (p_instance_id, 'PREPARED', 'DRAFT', 'PREPARED', v_inst.current_version_id, v_actor,
          nullif(current_setting('cdf.request_id', true), '')::uuid);

  perform audit.record_event('FORM_PREPARED', 'BUSINESS', 'SUCCESS', v_inst.case_id, 'form_instance', p_instance_id::text, null,
    jsonb_build_object('form_code', v_inst.form_code, 'instance_no', v_inst.instance_no, 'version_no', v_current.version_no,
                       'content_hash', v_current.content_hash,
                       'final', forms.terminal_status(v_def.review_required, v_def.approval_required) = 'PREPARED'));
end;
$$;

-- Review decision on a PREPARED form: REVIEWED moves on, RETURNED (reason required) reopens the draft.
create function api.review_form(p_instance_id uuid, p_outcome text, p_reason text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_inst forms.form_instance;
  v_def forms.form_definition;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_version forms.form_instance_version;
begin
  select * into v_inst from forms.form_instance i where i.id = p_instance_id for update;
  if v_inst.id is null or not authz.can_view_form_instance(p_instance_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_review_form(p_instance_id) then perform api._fail('FORBIDDEN'); end if;
  if v_inst.status <> 'PREPARED' then perform api._fail('CONFLICT', 'FORM_NOT_PREPARED'); end if;
  if v_inst.prepared_by = v_actor then perform api._fail('CONFLICT', 'FORM_SEPARATION_OF_DUTIES'); end if;
  if p_outcome not in ('REVIEWED', 'RETURNED') then perform api._fail('INVALID', 'outcome'); end if;
  if v_reason is not null and length(v_reason) > 2000 then perform api._fail('INVALID', 'reason'); end if;
  if p_outcome = 'RETURNED' and (v_reason is null or length(v_reason) < 10) then perform api._fail('INVALID', 'reason'); end if;
  select * into v_def from forms.form_definition d where d.code = v_inst.form_code;
  select * into v_version from forms.form_instance_version v where v.id = v_inst.prepared_version_id;

  if p_outcome = 'REVIEWED' then
    update forms.form_instance set status = 'REVIEWED', reviewed_by = v_actor, reviewed_at = now(), updated_at = now()
     where id = p_instance_id;
    insert into forms.form_event (instance_id, event_type, from_status, to_status, version_id, actor_id, reason, request_id)
    values (p_instance_id, 'REVIEWED', 'PREPARED', 'REVIEWED', v_inst.prepared_version_id, v_actor, v_reason,
            nullif(current_setting('cdf.request_id', true), '')::uuid);
    perform audit.record_event('FORM_REVIEWED', 'BUSINESS', 'SUCCESS', v_inst.case_id, 'form_instance', p_instance_id::text, v_reason,
      jsonb_build_object('form_code', v_inst.form_code, 'instance_no', v_inst.instance_no, 'version_no', v_version.version_no,
                         'content_hash', v_version.content_hash, 'final', not v_def.approval_required));
  else
    update forms.form_instance
       set status = 'DRAFT', prepared_version_id = null, prepared_by = null, prepared_at = null, updated_at = now()
     where id = p_instance_id;
    insert into forms.form_event (instance_id, event_type, from_status, to_status, version_id, actor_id, reason, request_id)
    values (p_instance_id, 'RETURNED', 'PREPARED', 'DRAFT', v_inst.prepared_version_id, v_actor, v_reason,
            nullif(current_setting('cdf.request_id', true), '')::uuid);
    perform audit.record_event('FORM_RETURNED', 'BUSINESS', 'SUCCESS', v_inst.case_id, 'form_instance', p_instance_id::text, v_reason,
      jsonb_build_object('form_code', v_inst.form_code, 'instance_no', v_inst.instance_no, 'version_no', v_version.version_no,
                         'content_hash', v_version.content_hash, 'returned_from', 'REVIEW'));
  end if;
end;
$$;

-- Approval decision on a REVIEWED form: APPROVED is final, RETURNED (reason required) reopens the draft.
create function api.approve_form(p_instance_id uuid, p_outcome text, p_reason text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_inst forms.form_instance;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_version forms.form_instance_version;
begin
  select * into v_inst from forms.form_instance i where i.id = p_instance_id for update;
  if v_inst.id is null or not authz.can_view_form_instance(p_instance_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_approve_form(p_instance_id) then perform api._fail('FORBIDDEN'); end if;
  if v_inst.status <> 'REVIEWED' then perform api._fail('CONFLICT', 'FORM_NOT_REVIEWED'); end if;
  if v_actor in (v_inst.prepared_by, v_inst.reviewed_by) then perform api._fail('CONFLICT', 'FORM_SEPARATION_OF_DUTIES'); end if;
  if p_outcome not in ('APPROVED', 'RETURNED') then perform api._fail('INVALID', 'outcome'); end if;
  if v_reason is not null and length(v_reason) > 2000 then perform api._fail('INVALID', 'reason'); end if;
  if p_outcome = 'RETURNED' and (v_reason is null or length(v_reason) < 10) then perform api._fail('INVALID', 'reason'); end if;
  select * into v_version from forms.form_instance_version v where v.id = v_inst.prepared_version_id;

  if p_outcome = 'APPROVED' then
    update forms.form_instance set status = 'APPROVED', approved_by = v_actor, approved_at = now(), updated_at = now()
     where id = p_instance_id;
    insert into forms.form_event (instance_id, event_type, from_status, to_status, version_id, actor_id, reason, request_id)
    values (p_instance_id, 'APPROVED', 'REVIEWED', 'APPROVED', v_inst.prepared_version_id, v_actor, v_reason,
            nullif(current_setting('cdf.request_id', true), '')::uuid);
    perform audit.record_event('FORM_APPROVED', 'BUSINESS', 'SUCCESS', v_inst.case_id, 'form_instance', p_instance_id::text, v_reason,
      jsonb_build_object('form_code', v_inst.form_code, 'instance_no', v_inst.instance_no, 'version_no', v_version.version_no,
                         'content_hash', v_version.content_hash, 'final', true));
  else
    update forms.form_instance
       set status = 'DRAFT', prepared_version_id = null, prepared_by = null, prepared_at = null,
           reviewed_by = null, reviewed_at = null, updated_at = now()
     where id = p_instance_id;
    insert into forms.form_event (instance_id, event_type, from_status, to_status, version_id, actor_id, reason, request_id)
    values (p_instance_id, 'RETURNED', 'REVIEWED', 'DRAFT', v_inst.prepared_version_id, v_actor, v_reason,
            nullif(current_setting('cdf.request_id', true), '')::uuid);
    perform audit.record_event('FORM_RETURNED', 'BUSINESS', 'SUCCESS', v_inst.case_id, 'form_instance', p_instance_id::text, v_reason,
      jsonb_build_object('form_code', v_inst.form_code, 'instance_no', v_inst.instance_no, 'version_no', v_version.version_no,
                         'content_hash', v_version.content_hash, 'returned_from', 'APPROVAL'));
  end if;
end;
$$;

-- Withdraws a non-final instance. Versions and events stay; nothing is deleted.
create function api.withdraw_form(p_instance_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_inst forms.form_instance;
  v_def forms.form_definition;
  v_reason text;
begin
  select * into v_inst from forms.form_instance i where i.id = p_instance_id for update;
  if v_inst.id is null or not authz.can_view_form_instance(p_instance_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_prepare_form(v_inst.case_id, v_inst.form_code) then perform api._fail('FORBIDDEN'); end if;
  select * into v_def from forms.form_definition d where d.code = v_inst.form_code;
  if v_inst.status = 'WITHDRAWN' or v_inst.status = forms.terminal_status(v_def.review_required, v_def.approval_required) then
    perform api._fail('CONFLICT', 'FORM_FINAL');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);

  update forms.form_instance set status = 'WITHDRAWN', withdrawn_by = v_actor, withdrawn_at = now(), updated_at = now()
   where id = p_instance_id;
  insert into forms.form_event (instance_id, event_type, from_status, to_status, version_id, actor_id, reason, request_id)
  values (p_instance_id, 'WITHDRAWN', v_inst.status, 'WITHDRAWN', v_inst.current_version_id, v_actor, v_reason,
          nullif(current_setting('cdf.request_id', true), '')::uuid);
  perform audit.record_event('FORM_WITHDRAWN', 'BUSINESS', 'SUCCESS', v_inst.case_id, 'form_instance', p_instance_id::text, v_reason,
    jsonb_build_object('form_code', v_inst.form_code, 'instance_no', v_inst.instance_no, 'from_status', v_inst.status));
end;
$$;

grant execute on function
  api.open_form_instance(uuid),
  api.start_form(uuid, text, core.classification_level),
  api.save_form_draft(uuid, jsonb),
  api.prepare_form(uuid),
  api.review_form(uuid, text, text),
  api.approve_form(uuid, text, text),
  api.withdraw_form(uuid, text)
to authenticated;
