-- =============================================================================
-- 1300 Records, retention and legal hold: schema, guards, authorization, RLS (Phase 11)
-- Requirements: CDF-REC-001..008; ADR-013; architecture/data-model/RECORDS_RETENTION.md
-- Threats: T25–T30 (architecture/threat-model/RECORDS_TEST_DEFINITIONS.md)
--
-- No retention value is invented: every class ships SOURCE_REQUIRED, so no case can become eligible
-- for disposition until CDF supplies its retention schedule (risk R10). Disposition is LOGICAL ONLY
-- (ADR-013 D7): nothing in this migration or in 1310 deletes a row or a storage object.
-- Commands are in 20261007001310_records_commands.sql.
-- =============================================================================

create schema if not exists records;
revoke all on schema records from public;
alter default privileges in schema records revoke all on tables from public, anon, authenticated;
alter default privileges in schema records revoke all on sequences from public, anon, authenticated;
alter default privileges in schema records revoke execute on functions from public, anon, authenticated;
grant usage on schema records to authenticated;

-- -----------------------------------------------------------------------------
-- Permissions and prototype role mapping (mirrored in packages/authorization).
-- Authority is SOURCE_REQUIRED (CDF Legal Policy / Delegation of Authority): this mapping is a
-- configurable default, not a CDF decision. PLATFORM_ADMIN, DB_ADMIN and SOC_ANALYST get none.
-- -----------------------------------------------------------------------------
insert into iam.permission (code, description) values
  ('RECORDS_VIEW',           'View records metadata (state, class, hold flag, dates) of cases; never case content'),
  ('RETENTION_CLASS_ASSIGN', 'Confirm or change the retention class of an archived case'),
  ('LEGAL_HOLD_APPLY',       'Place a legal hold on a case or an evidence item'),
  ('LEGAL_HOLD_RELEASE',     'Request or decide the release of a legal hold (two distinct holders)'),
  ('DISPOSITION_REQUEST',    'Request disposition of an eligible case and refresh eligibility'),
  ('DISPOSITION_APPROVE',    'Approve or reject a disposition request made by someone else');

insert into iam.role_permission (role_code, permission_code) values
  ('RECORDS_OFFICER', 'RECORDS_VIEW'), ('RECORDS_OFFICER', 'RETENTION_CLASS_ASSIGN'),
  ('RECORDS_OFFICER', 'LEGAL_HOLD_APPLY'), ('RECORDS_OFFICER', 'DISPOSITION_REQUEST'),
  ('LEGAL_REVIEWER', 'RECORDS_VIEW'), ('LEGAL_REVIEWER', 'LEGAL_HOLD_APPLY'), ('LEGAL_REVIEWER', 'LEGAL_HOLD_RELEASE'),
  ('GRC_DIRECTOR', 'RECORDS_VIEW'), ('GRC_DIRECTOR', 'LEGAL_HOLD_APPLY'), ('GRC_DIRECTOR', 'LEGAL_HOLD_RELEASE'),
  ('GRC_DIRECTOR', 'DISPOSITION_APPROVE'),
  ('INTERNAL_AUDIT', 'RECORDS_VIEW');

-- -----------------------------------------------------------------------------
-- Retention classes (reference data). CONFIGURED only with every value and its source.
-- -----------------------------------------------------------------------------
create table records.retention_class (
  code               text primary key check (code ~ '^[A-Z_]{3,40}$'),
  name_en            text not null,
  name_ar            text not null,
  record_type        text not null check (record_type in ('CASE', 'REPORT')),
  category           text check (category in ('PERMANENT', 'TEMPORARY')),
  retention_period   interval check (retention_period > interval '0'),
  trigger_event      text check (trigger_event in ('CASE_CLOSED', 'CASE_ARCHIVED', 'DECISION_ISSUED', 'ACTIONS_COMPLETED', 'REPORT_CLOSED')),
  disposition_action text check (disposition_action in ('DESTROY', 'TRANSFER_TO_ARCHIVE', 'ANONYMISE')),
  source_reference   text check (length(source_reference) between 3 and 500),
  status             text not null check (status in ('SOURCE_REQUIRED', 'CONFIGURED')),
  description        text not null,
  check ((status = 'CONFIGURED') = (category is not null and trigger_event is not null and disposition_action is not null
                                    and source_reference is not null
                                    and (category = 'PERMANENT' or retention_period is not null)))
);
comment on table records.retention_class is 'Retention schedule classes. Values come only from an approved CDF source (ADR-013 D2).';

insert into records.retention_class (code, name_en, name_ar, record_type, status, description) values
  ('UNASSIGNED',               'Unassigned',                      'غير مصنف',                       'CASE',   'SOURCE_REQUIRED',
   'Default before the records officer confirms a class. Never eligible for disposition.'),
  ('WB_CASE_INVESTIGATED',     'Whistleblowing case, investigated','قضية بلاغ تم التحقيق فيها',       'CASE',   'SOURCE_REQUIRED',
   'Proposed class: cases that reached INVESTIGATION. Period, trigger and action: SOURCE_REQUIRED (CDF Records & Archives Policy).'),
  ('WB_CASE_NOT_INVESTIGATED', 'Whistleblowing case, not investigated','قضية بلاغ لم يتم التحقيق فيها', 'CASE',   'SOURCE_REQUIRED',
   'Proposed class: cases closed at screening or jurisdiction. Period may be shorter under PDPL minimisation: DPO input required.'),
  ('INTERNAL_REFERRAL_CASE',   'Internal referral case',          'قضية إحالة داخلية',              'CASE',   'SOURCE_REQUIRED',
   'Proposed class: cases with source INTERNAL_REFERRAL. Values SOURCE_REQUIRED.'),
  ('REPORT_NOT_ACCEPTED',      'Report not accepted as a case',   'بلاغ لم يقبل كقضية',             'REPORT', 'SOURCE_REQUIRED',
   'Proposed class: portal reports that never became a case. Second implementation increment.');

update config.setting
   set description = 'Superseded by per-class rows in records.retention_class (ADR-013 D2); kept SOURCE_REQUIRED.'
 where key = 'RETENTION_PERIOD';

alter table case_mgmt.case_record
  add constraint case_record_retention_class_fk foreign key (retention_class) references records.retention_class (code);

-- -----------------------------------------------------------------------------
-- Display numbers (CDF-HOLD-YYYY-NNNN, CDF-DISP-YYYY-NNNN); UUIDs stay the keys (§87).
-- -----------------------------------------------------------------------------
create table records.number_counter (
  prefix     text not null check (prefix in ('CDF-HOLD', 'CDF-DISP')),
  year       int not null check (year between 2020 and 2100),
  last_value int not null default 0,
  primary key (prefix, year)
);

create function records.next_number(p_prefix text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_year int := extract(year from now() at time zone 'Asia/Riyadh')::int;
  v_next int;
begin
  insert into records.number_counter (prefix, year, last_value) values (p_prefix, v_year, 1)
  on conflict (prefix, year) do update set last_value = records.number_counter.last_value + 1
  returning last_value into v_next;
  return p_prefix || '-' || v_year || '-' || case when v_next < 10000 then lpad(v_next::text, 4, '0') else v_next::text end;
end;
$$;

-- -----------------------------------------------------------------------------
-- Retention schedule: one current row per case; recomputation supersedes, never edits.
-- -----------------------------------------------------------------------------
create table records.retention_schedule (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid not null references case_mgmt.case_record (id),
  retention_class   text not null references records.retention_class (code),
  trigger_event     text not null check (trigger_event in ('CASE_CLOSED', 'CASE_ARCHIVED', 'DECISION_ISSUED', 'ACTIONS_COMPLETED')),
  trigger_at        timestamptz,
  retain_until      timestamptz,
  computed_at       timestamptz not null default now(),
  computed_by       uuid references iam.user_profile (id),
  superseded_at     timestamptz,
  superseded_reason text check (superseded_reason in ('REOPENED', 'CLASS_CHANGED')),
  check ((superseded_at is null) = (superseded_reason is null)),
  check (retain_until is null or trigger_at is not null)
);
create unique index retention_schedule_current on records.retention_schedule (case_id) where superseded_at is null;

-- -----------------------------------------------------------------------------
-- Legal hold (ADR-013 D4)
-- -----------------------------------------------------------------------------
create table records.legal_hold (
  id                  uuid primary key default gen_random_uuid(),
  hold_number         text not null unique check (hold_number ~ '^CDF-HOLD-[0-9]{4}-[0-9]{4,5}$'),
  scope_type          text not null check (scope_type in ('CASE', 'EVIDENCE_ITEM')),
  case_id             uuid not null references case_mgmt.case_record (id),
  evidence_id         uuid references evidence.evidence (id),
  reason_code         text not null check (reason_code in ('LITIGATION', 'REGULATORY_INQUIRY', 'INTERNAL_INVESTIGATION', 'AUDIT', 'OTHER')),
  justification       text not null check (length(justification) between 20 and 2000),
  authority_reference text check (length(authority_reference) between 3 and 200),
  status              text not null default 'ACTIVE' check (status in ('ACTIVE', 'RELEASE_PENDING', 'RELEASED')),
  placed_by           uuid not null references iam.user_profile (id),
  placed_at           timestamptz not null default now(),
  released_at         timestamptz,
  check ((scope_type = 'EVIDENCE_ITEM') = (evidence_id is not null)),
  check ((status = 'RELEASED') = (released_at is not null))
);
create index legal_hold_case on records.legal_hold (case_id) where status <> 'RELEASED';

create table records.legal_hold_release (
  id              uuid primary key default gen_random_uuid(),
  hold_id         uuid not null references records.legal_hold (id),
  requested_by    uuid not null references iam.user_profile (id),
  requested_at    timestamptz not null default now(),
  justification   text not null check (length(justification) between 20 and 2000),
  status          text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  decided_by      uuid references iam.user_profile (id),
  decided_at      timestamptz,
  decision_reason text check (length(decision_reason) <= 2000),
  check (decided_by is null or decided_by <> requested_by),
  check ((status = 'PENDING') = (decided_by is null and decided_at is null))
);
create unique index legal_hold_release_one_pending on records.legal_hold_release (hold_id) where status = 'PENDING';

create table records.legal_hold_event (
  id             uuid primary key default gen_random_uuid(),
  seq            bigint generated always as identity,
  hold_id        uuid not null references records.legal_hold (id),
  event_type     text not null check (event_type in ('PLACED', 'RELEASE_REQUESTED', 'RELEASE_APPROVED', 'RELEASE_REJECTED')),
  actor_id       uuid not null references iam.user_profile (id),
  occurred_at    timestamptz not null default now(),
  audit_event_id uuid not null
);
create index legal_hold_event_hold on records.legal_hold_event (hold_id, seq);

-- -----------------------------------------------------------------------------
-- Disposition (ADR-013 D6, D7)
-- -----------------------------------------------------------------------------
create table records.disposition_request (
  id                    uuid primary key default gen_random_uuid(),
  case_id               uuid not null references case_mgmt.case_record (id),
  retention_schedule_id uuid not null references records.retention_schedule (id),
  requested_by          uuid not null references iam.user_profile (id),
  requested_at          timestamptz not null default now(),
  status                text not null default 'PENDING'
                        check (status in ('PENDING', 'APPROVED', 'REJECTED', 'BLOCKED_BY_HOLD', 'EXECUTED')),
  decided_by            uuid references iam.user_profile (id),
  decided_at            timestamptz,
  decision_reason       text check (length(decision_reason) <= 2000),
  executed_by           uuid references iam.user_profile (id),
  executed_at           timestamptz,
  check (decided_by is null or decided_by <> requested_by),
  check (status not in ('APPROVED', 'REJECTED', 'EXECUTED') or decided_by is not null),
  check (status <> 'PENDING' or decided_by is null),
  check ((status = 'EXECUTED') = (executed_at is not null))
);
create unique index disposition_request_open on records.disposition_request (case_id) where status in ('PENDING', 'APPROVED');

create table records.disposition_certificate (
  id                     uuid primary key default gen_random_uuid(),
  certificate_number     text not null unique check (certificate_number ~ '^CDF-DISP-[0-9]{4}-[0-9]{4,5}$'),
  disposition_request_id uuid not null unique references records.disposition_request (id),
  case_id                uuid not null unique references case_mgmt.case_record (id),
  case_number            text not null,
  retention_class        text not null references records.retention_class (code),
  trigger_event          text not null,
  trigger_at             timestamptz not null,
  retain_until           timestamptz not null,
  requested_by           uuid not null references iam.user_profile (id),
  requested_at           timestamptz not null,
  approved_by            uuid not null references iam.user_profile (id),
  approved_at            timestamptz not null,
  executed_by            uuid not null references iam.user_profile (id),
  holds_checked_at       timestamptz not null,
  active_holds_found     int not null check (active_holds_found = 0),
  disposition_action     text not null check (disposition_action in ('DESTROY', 'TRANSFER_TO_ARCHIVE', 'ANONYMISE')),
  execution_mode         text not null check (execution_mode = 'LOGICAL_ONLY'),
  -- Version ids and SHA-256 values only; never content (§83).
  evidence_manifest      jsonb not null check (jsonb_typeof(evidence_manifest) = 'array'),
  audit_event_id         uuid not null,
  audit_event_hash       text not null check (audit_event_hash ~ '^[0-9a-f]{64}$'),
  issued_at              timestamptz not null default now(),
  -- PRODUCTION_SUBSTITUTION_REQUIRED: unsigned hash; production signs with an HSM key (CDF-38) and keeps a WORM copy (CDF-36).
  certificate_hash       text not null check (certificate_hash ~ '^[0-9a-f]{64}$'),
  check (approved_by <> requested_by)
);

-- -----------------------------------------------------------------------------
-- Immutability: no hard delete of protected records, for any role, the owner included (ADR-013 D5).
-- -----------------------------------------------------------------------------
create function records.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%.% is a protected record (% rejected)', tg_table_schema, tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['records.retention_class', 'records.retention_schedule', 'records.legal_hold',
                           'records.legal_hold_release', 'records.legal_hold_event', 'records.disposition_request',
                           'records.disposition_certificate', 'case_mgmt.case_record'] loop
    execute format('create trigger protect_no_delete before delete on %s for each row execute function records.reject_mutation()', t);
    execute format('create trigger protect_no_truncate before truncate on %s for each statement execute function records.reject_mutation()', t);
  end loop;
  foreach t in array array['records.legal_hold_event', 'records.disposition_certificate'] loop
    execute format('create trigger protect_no_update before update on %s for each row execute function records.reject_mutation()', t);
  end loop;
end;
$$;

-- Case records after closure: content is frozen from ARCHIVED on and DISPOSED is terminal (ADR-013 D6, D7).
-- Lifecycle columns stay writable for the workflow and records commands until DISPOSED.
create function records.protect_case_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.records_state = 'DISPOSED' then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CDF_CONFLICT:RECORDS_DISPOSED';
  end if;
  if old.records_state not in ('ACTIVE', 'CLOSED')
     and (new.case_number, new.case_type, new.title, new.summary, new.classification, new.is_restricted, new.source,
          new.source_report_id, new.reporter_wb_id, new.priority, new.identity_reveal_requires_approval, new.owner_id,
          new.created_at, new.created_by, new.opened_at, new.closed_at)
         is distinct from
         (old.case_number, old.case_type, old.title, old.summary, old.classification, old.is_restricted, old.source,
          old.source_report_id, old.reporter_wb_id, old.priority, old.identity_reveal_requires_approval, old.owner_id,
          old.created_at, old.created_by, old.opened_at, old.closed_at) then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CDF_CONFLICT:RECORDS_READ_ONLY';
  end if;
  return new;
end;
$$;
create trigger case_record_records_guard before update on case_mgmt.case_record
  for each row execute function records.protect_case_record();

-- Holds: only the status may move (ACTIVE ⇄ RELEASE_PENDING → RELEASED); RELEASED is final.
create function records.protect_legal_hold()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'RELEASED' then
    raise exception 'legal hold % is released and immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  if new.id <> old.id or new.hold_number <> old.hold_number or new.scope_type <> old.scope_type or new.case_id <> old.case_id
     or new.evidence_id is distinct from old.evidence_id or new.reason_code <> old.reason_code
     or new.justification <> old.justification or new.authority_reference is distinct from old.authority_reference
     or new.placed_by <> old.placed_by or new.placed_at <> old.placed_at then
    raise exception 'legal hold % fields are immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger legal_hold_protect before update on records.legal_hold
  for each row execute function records.protect_legal_hold();

-- Release requests: decided once.
create function records.protect_hold_release()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'PENDING' or new.hold_id <> old.hold_id or new.requested_by <> old.requested_by
     or new.requested_at <> old.requested_at or new.justification <> old.justification then
    raise exception 'legal hold release % is immutable once decided', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger legal_hold_release_protect before update on records.legal_hold_release
  for each row execute function records.protect_hold_release();

-- Schedules: only the one-way superseded stamp.
create function records.protect_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.superseded_at is not null or new.superseded_at is null
     or (new.id, new.case_id, new.retention_class, new.trigger_event, new.trigger_at, new.retain_until, new.computed_at, new.computed_by)
        is distinct from (old.id, old.case_id, old.retention_class, old.trigger_event, old.trigger_at, old.retain_until, old.computed_at, old.computed_by) then
    raise exception 'retention schedule % is immutable; recomputation supersedes it', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger retention_schedule_protect before update on records.retention_schedule
  for each row execute function records.protect_schedule();

-- Disposition requests: status moves forward only; EXECUTED, REJECTED and BLOCKED_BY_HOLD are final.
create function records.protect_disposition_request()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('EXECUTED', 'REJECTED', 'BLOCKED_BY_HOLD')
     or (old.status = 'APPROVED' and new.status not in ('EXECUTED', 'BLOCKED_BY_HOLD'))
     or new.case_id <> old.case_id or new.retention_schedule_id <> old.retention_schedule_id
     or new.requested_by <> old.requested_by or new.requested_at <> old.requested_at then
    raise exception 'disposition request % cannot change from %', old.id, old.status using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger disposition_request_protect before update on records.disposition_request
  for each row execute function records.protect_disposition_request();

-- -----------------------------------------------------------------------------
-- Hold predicates (used by commands, guards and the evidence trigger)
-- -----------------------------------------------------------------------------
create function records.has_active_hold(p_case_id uuid, p_evidence_id uuid default null)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from records.legal_hold h
    where h.case_id = p_case_id and h.status <> 'RELEASED'
      and (h.scope_type = 'CASE' or p_evidence_id is null or h.evidence_id = p_evidence_id)
  );
$$;

-- True only while case content may still change; shared contract for case-linked modules
-- (forms CDF-50, interviews CDF-60): call it before any content write, expose no delete command.
create function records.case_content_writable(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state = 'ACTIVE');
$$;

-- Evidence under hold (ADR-013 D5, RECORDS_RETENTION §5.4): no status regression of an available item,
-- no classification lowering, no current version moved off an available version.
create function records.protect_held_evidence()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if records.has_active_hold(old.case_id, old.id) then
    if old.status = 'AVAILABLE' and new.status <> 'AVAILABLE' then
      raise exception 'evidence % is under legal hold', old.id using errcode = 'insufficient_privilege';
    end if;
    if new.classification < old.classification then
      raise exception 'evidence % is under legal hold', old.id using errcode = 'insufficient_privilege';
    end if;
    if old.current_version_id is not null and new.current_version_id is distinct from old.current_version_id
       and not exists (select 1 from evidence.evidence_version v
                       where v.id = new.current_version_id and v.evidence_id = old.id and v.status = 'AVAILABLE') then
      raise exception 'evidence % is under legal hold', old.id using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;
create trigger evidence_hold_guard before update on evidence.evidence
  for each row execute function records.protect_held_evidence();

-- -----------------------------------------------------------------------------
-- Authorization (§19; ADR-013 D9). RECORDS_VIEW never implies case content.
-- -----------------------------------------------------------------------------
-- A disposed case is invisible to every case role (ADR-013 D7). Only change: the DISPOSED clause.
create or replace function authz.user_can_view_case(p_user_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from case_mgmt.case_record c
    join iam.user_profile u on u.id = p_user_id and u.status = 'ACTIVE'
    where c.id = p_case_id
      and c.records_state <> 'DISPOSED'
      and c.classification <= u.clearance
      and not authz.has_conflict(c.id, u.id)
      and (
        (not c.is_restricted and authz.user_has_permission(u.id, 'CASE_VIEW_ALL'))
        or authz.has_active_assignment(c.id, u.id)
        or authz.has_active_grant(c.id, u.id)
      )
  );
$$;

-- Records metadata: permission + clearance + no conflict; restricted cases only with an assignment or grant
-- (records staff gain no back door to restricted case existence).
create function authz.can_view_records(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null
     and authz.has_permission('RECORDS_VIEW')
     and exists (
       select 1 from case_mgmt.case_record c
       where c.id = p_case_id
         and c.classification <= authz.current_clearance()
         and not authz.has_conflict(c.id, authz.current_user_id())
         and (not c.is_restricted
              or authz.has_active_assignment(c.id, authz.current_user_id())
              or authz.has_active_grant(c.id, authz.current_user_id())));
$$;

create function authz.can_apply_legal_hold(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.has_permission('LEGAL_HOLD_APPLY')
     and (authz.can_view_records(p_case_id) or authz.can_view_case(p_case_id))
     and not authz.has_conflict(p_case_id, authz.current_user_id())
     and exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state <> 'DISPOSED');
$$;

create function authz.can_release_legal_hold(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.has_permission('LEGAL_HOLD_RELEASE')
     and (authz.can_view_records(p_case_id) or authz.can_view_case(p_case_id))
     and not authz.has_conflict(p_case_id, authz.current_user_id());
$$;

create function authz.can_request_disposition(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.has_permission('DISPOSITION_REQUEST') and authz.can_view_records(p_case_id);
$$;

create function authz.can_approve_disposition(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.has_permission('DISPOSITION_APPROVE') and authz.can_view_records(p_case_id);
$$;

grant execute on function
  authz.can_view_records(uuid), authz.can_apply_legal_hold(uuid), authz.can_release_legal_hold(uuid),
  authz.can_request_disposition(uuid), authz.can_approve_disposition(uuid)
to authenticated;

-- -----------------------------------------------------------------------------
-- Retention schedule maintenance on closure, archive and reopen (same transaction as the workflow
-- transition, so the schedule and its audit event cannot be skipped).
-- -----------------------------------------------------------------------------
create function records._compute_schedule(p_case_id uuid, p_supersede_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_case case_mgmt.case_record;
  v_class records.retention_class;
  v_trigger text;
  v_trigger_at timestamptz;
  v_until timestamptz;
  v_id uuid;
begin
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id;
  select * into v_class from records.retention_class k where k.code = v_case.retention_class;
  update records.retention_schedule s set superseded_at = now(), superseded_reason = p_supersede_reason
   where s.case_id = p_case_id and s.superseded_at is null
  returning s.id into v_id;
  if v_id is not null then
    perform audit.record_event('RETENTION_SCHEDULE_SUPERSEDED', 'BUSINESS', 'SUCCESS', p_case_id, 'retention_schedule',
      v_id::text, null, jsonb_build_object('superseded_reason', p_supersede_reason));
  end if;
  -- Proposed default trigger is closure (SOURCE_REQUIRED confirmation); later-phase triggers have no timestamp yet.
  v_trigger := coalesce(v_class.trigger_event, 'CASE_CLOSED');
  v_trigger_at := case v_trigger
    when 'CASE_CLOSED' then v_case.closed_at
    when 'CASE_ARCHIVED' then (select max(e.occurred_at) from workflow.workflow_transition_event e
                                where e.case_id = p_case_id and e.to_state = 'ARCHIVE')
    else null end;
  if v_class.status = 'CONFIGURED' and v_class.category = 'TEMPORARY' and v_trigger_at is not null then
    v_until := v_trigger_at + v_class.retention_period;
  end if;
  insert into records.retention_schedule (case_id, retention_class, trigger_event, trigger_at, retain_until, computed_by)
  values (p_case_id, v_case.retention_class, v_trigger, v_trigger_at, v_until, authz.current_user_id())
  returning id into v_id;
  perform audit.record_event('RETENTION_SCHEDULE_COMPUTED', 'BUSINESS', 'SUCCESS', p_case_id, 'retention_schedule', v_id::text,
    null, jsonb_build_object('retention_class', v_case.retention_class, 'class_status', v_class.status,
                             'trigger_event', v_trigger, 'has_retain_until', v_until is not null));
  return v_id;
end;
$$;

create function records.on_records_state_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare v_old uuid;
begin
  if new.records_state = 'CLOSED' and old.records_state = 'ACTIVE' then
    perform records._compute_schedule(new.id, 'REOPENED');
  elsif new.records_state = 'ARCHIVED' and old.records_state = 'CLOSED' then
    -- Archiving recomputes only when the class is triggered by archiving.
    if exists (select 1 from records.retention_class k where k.code = new.retention_class and k.trigger_event = 'CASE_ARCHIVED') then
      perform records._compute_schedule(new.id, 'CLASS_CHANGED');
    end if;
  elsif new.records_state = 'ACTIVE' and old.records_state = 'CLOSED' then
    update records.retention_schedule s set superseded_at = now(), superseded_reason = 'REOPENED'
     where s.case_id = new.id and s.superseded_at is null
    returning s.id into v_old;
    if v_old is not null then
      perform audit.record_event('RETENTION_SCHEDULE_SUPERSEDED', 'BUSINESS', 'SUCCESS', new.id, 'retention_schedule',
        v_old::text, null, jsonb_build_object('superseded_reason', 'REOPENED'));
    end if;
  end if;
  return null;
end;
$$;
create trigger case_record_records_state after update of records_state on case_mgmt.case_record
  for each row when (old.records_state is distinct from new.records_state)
  execute function records.on_records_state_change();

-- ARCHIVE_CASE was defined in Phase 6 and waits for this phase (enabled_in_phase = 11).
update workflow.workflow_transition_definition set is_enabled = true
 where workflow_code = 'CDF_CASE_V1' and code = 'ARCHIVE_CASE';

-- -----------------------------------------------------------------------------
-- RLS (SELECT only; no write grants). Hold detail only for hold permission holders.
-- -----------------------------------------------------------------------------
alter table records.retention_class enable row level security;
alter table records.number_counter enable row level security;
alter table records.retention_schedule enable row level security;
alter table records.legal_hold enable row level security;
alter table records.legal_hold_release enable row level security;
alter table records.legal_hold_event enable row level security;
alter table records.disposition_request enable row level security;
alter table records.disposition_certificate enable row level security;

create policy retention_class_read on records.retention_class for select to authenticated
  using (authz.current_user_id() is not null);
grant select on records.retention_class to authenticated;

create policy retention_schedule_read on records.retention_schedule for select to authenticated
  using (authz.can_view_records(case_id));
grant select on records.retention_schedule to authenticated;

create policy legal_hold_read on records.legal_hold for select to authenticated
  using ((authz.has_permission('LEGAL_HOLD_APPLY') or authz.has_permission('LEGAL_HOLD_RELEASE'))
         and (authz.can_view_records(case_id) or authz.can_view_case(case_id)));
grant select on records.legal_hold to authenticated;

create policy legal_hold_release_read on records.legal_hold_release for select to authenticated
  using (exists (select 1 from records.legal_hold h where h.id = hold_id));
grant select on records.legal_hold_release to authenticated;

create policy legal_hold_event_read on records.legal_hold_event for select to authenticated
  using (exists (select 1 from records.legal_hold h where h.id = hold_id));
grant select on records.legal_hold_event to authenticated;

create policy disposition_request_read on records.disposition_request for select to authenticated
  using (authz.can_view_records(case_id));
grant select on records.disposition_request to authenticated;

create policy disposition_certificate_read on records.disposition_certificate for select to authenticated
  using (authz.can_view_records(case_id));
grant select on records.disposition_certificate to authenticated;

-- number_counter: no policies, no grants.
