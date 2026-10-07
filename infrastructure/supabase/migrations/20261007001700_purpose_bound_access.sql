-- =============================================================================
-- 1700 Purpose-bound, task-scoped and lifecycle-aware access (CDF-73, ADR-014)
-- Requirements: Fady's option D (2026-10-07 16:24) §1–§20; §19, §21, §40, §87; ADR-003, ADR-013 D9
--
-- Authority to perform a records-management or legal function does not, by itself, confer authority
-- to discover or access unrelated investigation cases. Case access is derived only from:
--   explicit case access (assignment / grant / CASE_VIEW_ALL as before)
--   OR an authorised, unexpired, purpose-bound case task (metadata only, never content)
--   OR the records-catalogue scope (post-closure, non-restricted, lifecycle fields only)
--   OR approved, time-bound break-glass access.
-- Lifecycle state decides which records operations are permitted; it never overrides classification,
-- the restricted flag, conflicts or case-level restrictions.
--
-- This migration: capabilities and role defaults, case tasks, legal-hold requests, break-glass,
-- predicates, the records catalogue projection and RLS. Commands are in 1710.
-- TypeScript mirror: packages/authorization (tests/integration/mirrors.spec.ts).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Capabilities (§2). CASE_VIEW_METADATA and CASE_VIEW_CONTENT are derived from case relationships and
-- are never mapped to a role. Role defaults below are the prototype default; the authority for each
-- is SOURCE_REQUIRED (CDF Delegation of Authority, already requested).
-- -----------------------------------------------------------------------------
insert into iam.permission (code, description) values
  ('CASE_DISCOVER',             'Use the controlled exact-match case lookup for a stated purpose (never browsing)'),
  ('CASE_VIEW_METADATA',        'Derived capability: minimum case metadata through a relationship, task or catalogue scope; never role-mapped'),
  ('CASE_VIEW_CONTENT',         'Derived capability: case content through assignment, grant, CASE_VIEW_ALL or break-glass; never role-mapped'),
  ('CASE_TASK_ASSIGN',          'Create and cancel purpose-bound case tasks on cases the actor can view'),
  ('LEGAL_HOLD_REQUEST',        'Request a legal hold on a case the actor is authorised for'),
  ('LEGAL_HOLD_REVIEW',         'Assess a legal hold request under an assigned legal task'),
  ('RETENTION_TASK_VIEW',       'See records metadata needed for an assigned retention task'),
  ('RETENTION_TASK_EXECUTE',    'Perform the retention operation of an assigned retention task'),
  ('DISPOSITION_TASK_VIEW',     'See records metadata needed for an assigned disposition task'),
  ('DISPOSITION_TASK_EXECUTE',  'Perform the disposition step of an assigned disposition task'),
  ('ARCHIVE_RECORD_VIEW',       'Read the records catalogue (post-closure, non-restricted, lifecycle fields only)'),
  ('ARCHIVE_RECORD_ADMINISTER', 'Administer the lifecycle of records within the catalogue scope'),
  ('RECORDS_LIFECYCLE_ADMIN',   'Create records-lifecycle tasks within the catalogue scope and run lifecycle housekeeping'),
  ('BREAK_GLASS_REQUEST',       'Request exceptional, time-bound case access with a reason'),
  ('BREAK_GLASS_APPROVE',       'Approve, reject and post-review break-glass access requested by someone else');

update iam.permission
   set description = 'RETIRED by ADR-014: grants nothing. Superseded by ARCHIVE_RECORD_VIEW (catalogue scope) and task-scoped access'
 where code = 'RECORDS_VIEW';

-- No role keeps the role-wide records view (CDF-73).
delete from iam.role_permission where permission_code = 'RECORDS_VIEW';

insert into iam.role_permission (role_code, permission_code) values
  ('RECORDS_OFFICER', 'ARCHIVE_RECORD_VIEW'), ('RECORDS_OFFICER', 'ARCHIVE_RECORD_ADMINISTER'),
  ('RECORDS_OFFICER', 'RECORDS_LIFECYCLE_ADMIN'),
  ('RECORDS_OFFICER', 'RETENTION_TASK_VIEW'), ('RECORDS_OFFICER', 'RETENTION_TASK_EXECUTE'),
  ('RECORDS_OFFICER', 'DISPOSITION_TASK_VIEW'), ('RECORDS_OFFICER', 'DISPOSITION_TASK_EXECUTE'),
  ('RECORDS_OFFICER', 'LEGAL_HOLD_REQUEST'), ('RECORDS_OFFICER', 'CASE_DISCOVER'),
  ('LEGAL_REVIEWER', 'LEGAL_HOLD_REQUEST'), ('LEGAL_REVIEWER', 'LEGAL_HOLD_REVIEW'),
  ('LEGAL_REVIEWER', 'CASE_DISCOVER'), ('LEGAL_REVIEWER', 'BREAK_GLASS_REQUEST'),
  ('GRC_DIRECTOR', 'ARCHIVE_RECORD_VIEW'), ('GRC_DIRECTOR', 'CASE_TASK_ASSIGN'),
  ('GRC_DIRECTOR', 'LEGAL_HOLD_REQUEST'), ('GRC_DIRECTOR', 'LEGAL_HOLD_REVIEW'),
  ('GRC_DIRECTOR', 'DISPOSITION_TASK_VIEW'), ('GRC_DIRECTOR', 'BREAK_GLASS_APPROVE'),
  ('CASE_MANAGER', 'CASE_TASK_ASSIGN'), ('CASE_MANAGER', 'LEGAL_HOLD_REQUEST'),
  ('LEAD_INVESTIGATOR', 'LEGAL_HOLD_REQUEST'),
  ('INTERNAL_AUDIT', 'ARCHIVE_RECORD_VIEW');

-- Rate limit of the controlled lookup (§6). Engineering default, not a CDF policy value.
insert into config.setting (key, value, status, source_reference, description) values
  ('CASE_DISCOVERY_RATE_LIMIT', '5', 'CONFIGURED', 'ADR-014 engineering default (CDF security policy may override)',
   'Maximum controlled case lookups per user per rolling hour.');

-- -----------------------------------------------------------------------------
-- Task types (§4, §11): what each purpose may see and do, and who may hold it.
-- -----------------------------------------------------------------------------
create table case_mgmt.case_task_type (
  code                 text primary key check (code ~ '^[A-Z_]{3,40}$'),
  category             text not null check (category in ('LEGAL', 'RECORDS')),
  name_en              text not null,
  name_ar              text not null,
  allowed_capabilities text[] not null check (cardinality(allowed_capabilities) > 0
                                              and 'CASE_VIEW_METADATA' = any (allowed_capabilities)
                                              and not ('CASE_VIEW_CONTENT' = any (allowed_capabilities))),
  eligible_roles       text[] not null check (cardinality(eligible_roles) > 0),
  -- RECORDS tasks exist only once the case has left ACTIVE (the retention lifecycle starts at closure).
  requires_closed      boolean not null,
  default_duration     interval not null check (default_duration > interval '0'),
  max_duration         interval not null check (max_duration >= default_duration)
);
comment on table case_mgmt.case_task_type is
  'Purpose-bound task types (ADR-014). A task never grants case content, evidence download, interview read, reporter identity or export.';

insert into case_mgmt.case_task_type (code, category, name_en, name_ar, allowed_capabilities, eligible_roles,
                                      requires_closed, default_duration, max_duration) values
  ('LEGAL_REVIEW',           'LEGAL',   'Legal review',            'مراجعة قانونية',
   '{CASE_VIEW_METADATA,LEGAL_HOLD_REQUEST}',                          '{LEGAL_REVIEWER}',  false, '30 days', '90 days'),
  ('LEGAL_HOLD_ASSESSMENT',  'LEGAL',   'Legal hold assessment',   'تقييم الحجز القانوني',
   '{CASE_VIEW_METADATA,LEGAL_HOLD_REVIEW,LEGAL_HOLD_APPLY}',          '{LEGAL_REVIEWER,GRC_DIRECTOR}', false, '7 days', '30 days'),
  ('LEGAL_HOLD_APPLICATION', 'LEGAL',   'Legal hold application',  'تطبيق الحجز القانوني',
   '{CASE_VIEW_METADATA,LEGAL_HOLD_APPLY}',                            '{LEGAL_REVIEWER,RECORDS_OFFICER,GRC_DIRECTOR}', false, '7 days', '30 days'),
  ('LEGAL_HOLD_RELEASE',     'LEGAL',   'Legal hold release',      'رفع الحجز القانوني',
   '{CASE_VIEW_METADATA,LEGAL_HOLD_RELEASE}',                          '{LEGAL_REVIEWER,GRC_DIRECTOR}', false, '7 days', '30 days'),
  ('RETENTION_REVIEW',       'RECORDS', 'Retention review',        'مراجعة الاحتفاظ',
   '{CASE_VIEW_METADATA,RETENTION_TASK_VIEW,RETENTION_TASK_EXECUTE}',  '{RECORDS_OFFICER}', true,  '30 days', '90 days'),
  ('ARCHIVE_TRANSFER',       'RECORDS', 'Archive transfer',        'النقل إلى الأرشيف',
   '{CASE_VIEW_METADATA,RETENTION_TASK_VIEW,ARCHIVE_RECORD_ADMINISTER}', '{RECORDS_OFFICER}', true,  '30 days', '90 days'),
  ('DISPOSITION_REVIEW',     'RECORDS', 'Disposition review',      'مراجعة الإتلاف',
   '{CASE_VIEW_METADATA,DISPOSITION_TASK_VIEW,DISPOSITION_TASK_EXECUTE}', '{RECORDS_OFFICER}', true, '30 days', '90 days'),
  ('DISPOSITION_APPROVAL',   'RECORDS', 'Disposition approval',    'اعتماد الإتلاف',
   '{CASE_VIEW_METADATA,DISPOSITION_TASK_VIEW}',                       '{GRC_DIRECTOR}',    true,  '14 days', '30 days'),
  ('DISPOSITION_EXECUTION',  'RECORDS', 'Disposition execution',   'تنفيذ الإتلاف',
   '{CASE_VIEW_METADATA,DISPOSITION_TASK_VIEW,DISPOSITION_TASK_EXECUTE}', '{RECORDS_OFFICER}', true, '14 days', '30 days');

-- -----------------------------------------------------------------------------
-- Case tasks (§4, §11, §12)
-- -----------------------------------------------------------------------------
create table case_mgmt.case_task (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid not null references case_mgmt.case_record (id),
  task_type         text not null references case_mgmt.case_task_type (code),
  assigned_user_id  uuid not null references iam.user_profile (id),
  assigned_role     text not null references iam.role (code),
  purpose           text not null check (length(purpose) between 10 and 1000),
  scope             text[] not null check (cardinality(scope) > 0),
  status            text not null default 'OPEN' check (status in ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
  created_by        uuid not null references iam.user_profile (id),
  created_at        timestamptz not null default now(),
  due_date          date,
  access_granted_at timestamptz not null default now(),
  expires_at        timestamptz not null,
  opened_at         timestamptz,
  completed_at      timestamptz,
  closed_by         uuid references iam.user_profile (id),
  closed_at         timestamptz,
  closure_reason    text check (length(closure_reason) <= 2000),
  check (expires_at > access_granted_at),
  check ((status = 'COMPLETED') = (completed_at is not null)),
  check ((status in ('OPEN', 'IN_PROGRESS')) = (closed_at is null))
);
create index case_task_assignee on case_mgmt.case_task (assigned_user_id, case_id) where status in ('OPEN', 'IN_PROGRESS');
create index case_task_case on case_mgmt.case_task (case_id);
create unique index case_task_one_active on case_mgmt.case_task (case_id, task_type, assigned_user_id)
  where status in ('OPEN', 'IN_PROGRESS');

-- Scope ⊆ the type's allowed capabilities, enforced for every writer.
create function case_mgmt.check_task_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from case_mgmt.case_task_type t
                 where t.code = new.task_type and new.scope <@ t.allowed_capabilities
                   and 'CASE_VIEW_METADATA' = any (new.scope)) then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:scope';
  end if;
  return new;
end;
$$;
create trigger case_task_scope before insert on case_mgmt.case_task
  for each row execute function case_mgmt.check_task_scope();

-- Only the lifecycle columns move, forward only; COMPLETED, CANCELLED and EXPIRED are final.
create function case_mgmt.protect_case_task()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('COMPLETED', 'CANCELLED', 'EXPIRED')
     or (new.id, new.case_id, new.task_type, new.assigned_user_id, new.assigned_role, new.purpose, new.scope,
         new.created_by, new.created_at, new.due_date, new.access_granted_at, new.expires_at)
        is distinct from
        (old.id, old.case_id, old.task_type, old.assigned_user_id, old.assigned_role, old.purpose, old.scope,
         old.created_by, old.created_at, old.due_date, old.access_granted_at, old.expires_at) then
    raise exception 'case task % cannot change from %', old.id, old.status using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger case_task_protect before update on case_mgmt.case_task
  for each row execute function case_mgmt.protect_case_task();

-- -----------------------------------------------------------------------------
-- Legal hold requests (§5, §6)
-- -----------------------------------------------------------------------------
create table records.legal_hold_request (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid not null references case_mgmt.case_record (id),
  origin            text not null check (origin in ('CASE_TEAM', 'CONTROLLED_LOOKUP')),
  reason_code       text not null check (reason_code in ('LITIGATION', 'REGULATORY_INQUIRY', 'INTERNAL_INVESTIGATION', 'AUDIT', 'OTHER')),
  justification     text not null check (length(justification) between 20 and 2000),
  status            text not null default 'SUBMITTED' check (status in ('SUBMITTED', 'ASSIGNED', 'APPLIED', 'REJECTED')),
  requested_by      uuid not null references iam.user_profile (id),
  requested_at      timestamptz not null default now(),
  assigned_reviewer uuid references iam.user_profile (id),
  assigned_task_id  uuid references case_mgmt.case_task (id),
  assigned_by       uuid references iam.user_profile (id),
  reviewed_by       uuid references iam.user_profile (id),
  reviewed_at       timestamptz,
  review_reason     text check (length(review_reason) <= 2000),
  legal_hold_id     uuid references records.legal_hold (id),
  check ((status = 'SUBMITTED') = (assigned_task_id is null)),
  check ((status in ('APPLIED', 'REJECTED')) = (reviewed_at is not null)),
  check ((status = 'APPLIED') = (legal_hold_id is not null))
);
create index legal_hold_request_case on records.legal_hold_request (case_id);
create index legal_hold_request_requester on records.legal_hold_request (requested_by);

create function records.protect_hold_request()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('APPLIED', 'REJECTED')
     or (new.id, new.case_id, new.origin, new.reason_code, new.justification, new.requested_by, new.requested_at)
        is distinct from (old.id, old.case_id, old.origin, old.reason_code, old.justification, old.requested_by, old.requested_at) then
    raise exception 'legal hold request % cannot change from %', old.id, old.status using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger legal_hold_request_protect before update on records.legal_hold_request
  for each row execute function records.protect_hold_request();

-- -----------------------------------------------------------------------------
-- Break-glass (§20): exceptional, time-bound, approved by someone else, post-reviewed.
-- -----------------------------------------------------------------------------
create table case_mgmt.break_glass_access (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid not null references case_mgmt.case_record (id),
  requested_by      uuid not null references iam.user_profile (id),
  requested_at      timestamptz not null default now(),
  reason            text not null check (length(reason) between 20 and 2000),
  duration          interval not null check (duration between interval '15 minutes' and interval '72 hours'),
  status            text not null default 'REQUESTED' check (status in ('REQUESTED', 'ACTIVE', 'REJECTED', 'ENDED')),
  decided_by        uuid references iam.user_profile (id),
  decided_at        timestamptz,
  decision_reason   text check (length(decision_reason) <= 2000),
  access_expires_at timestamptz,
  ended_at          timestamptz,
  review_status     text not null default 'NOT_DUE' check (review_status in ('NOT_DUE', 'PENDING', 'REVIEWED')),
  reviewed_by       uuid references iam.user_profile (id),
  reviewed_at       timestamptz,
  review_outcome    text check (review_outcome in ('APPROPRIATE', 'INAPPROPRIATE')),
  review_notes      text check (length(review_notes) <= 2000),
  check (decided_by is null or decided_by <> requested_by),
  -- Post-event review is independent of both the requester and the approver (CDF-78).
  check (reviewed_by is null or (reviewed_by <> requested_by and reviewed_by is distinct from decided_by)),
  check ((status = 'ACTIVE') <= (access_expires_at is not null)),
  check ((review_status = 'REVIEWED') = (reviewed_at is not null and review_outcome is not null))
);
create index break_glass_case_user on case_mgmt.break_glass_access (case_id, requested_by) where status = 'ACTIVE';

-- Like assignments and grants (CDF-74): no new exceptional access once a case is archived.
create trigger break_glass_records_guard before insert on case_mgmt.break_glass_access
  for each row execute function records.reject_access_after_archive();

do $$
declare t text;
begin
  foreach t in array array['case_mgmt.case_task', 'case_mgmt.case_task_type', 'case_mgmt.break_glass_access',
                           'records.legal_hold_request'] loop
    execute format('create trigger protect_no_delete before delete on %s for each row execute function records.reject_mutation()', t);
    execute format('create trigger protect_no_truncate before truncate on %s for each statement execute function records.reject_mutation()', t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Predicates (§13). Each purpose has its own function; none is a generic "view case".
-- -----------------------------------------------------------------------------
create function authz.has_active_break_glass(p_case_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from case_mgmt.break_glass_access b
    where b.case_id = p_case_id and b.requested_by = p_user_id and b.status = 'ACTIVE'
      and b.access_expires_at > now()
  );
$$;

-- Content access: unchanged rule plus approved, unexpired break-glass. Tasks never confer content.
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
        or authz.has_active_break_glass(c.id, u.id)
      )
  );
$$;

-- Clearance + no conflict + active user: the ABAC gate every derived capability passes first.
create function authz.user_case_gate(p_user_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from case_mgmt.case_record c
    join iam.user_profile u on u.id = p_user_id and u.status = 'ACTIVE'
    where c.id = p_case_id and c.classification <= u.clearance and not authz.has_conflict(c.id, u.id)
  );
$$;

-- A capability conferred by an active, unexpired task assigned to the user. The user must also hold the
-- capability through a role (RBAC ∧ task), except the derived CASE_VIEW_METADATA.
create function authz.user_task_grants(p_user_id uuid, p_case_id uuid, p_capability text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.user_case_gate(p_user_id, p_case_id)
     and (p_capability = 'CASE_VIEW_METADATA' or authz.user_has_permission(p_user_id, p_capability))
     and exists (
       select 1 from case_mgmt.case_task t
       where t.case_id = p_case_id and t.assigned_user_id = p_user_id
         and t.status in ('OPEN', 'IN_PROGRESS')
         and t.access_granted_at <= now() and t.expires_at > now()
         and p_capability = any (t.scope)
         and authz.user_has_role(p_user_id, t.assigned_role));
$$;

-- Records-catalogue scope (§7, §8, §9, §14): post-closure, non-restricted, within clearance, no conflict.
create function authz.user_records_catalogue_scope(p_user_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.user_has_permission(p_user_id, 'ARCHIVE_RECORD_VIEW')
     and authz.user_case_gate(p_user_id, p_case_id)
     and exists (select 1 from case_mgmt.case_record c
                 where c.id = p_case_id and c.records_state <> 'ACTIVE' and not c.is_restricted);
$$;

-- Minimum metadata (§13): explicit case access OR task OR catalogue scope OR break-glass (inside user_can_view_case).
create function authz.user_can_view_case_metadata(p_user_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.user_can_view_case(p_user_id, p_case_id)
      or authz.user_records_catalogue_scope(p_user_id, p_case_id)
      or authz.user_task_grants(p_user_id, p_case_id, 'CASE_VIEW_METADATA');
$$;

create function authz.task_grants(p_case_id uuid, p_capability text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null
     and authz.user_task_grants(authz.current_user_id(), p_case_id, p_capability);
$$;

create function authz.in_records_catalogue_scope(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null
     and authz.user_records_catalogue_scope(authz.current_user_id(), p_case_id);
$$;

create function authz.can_discover_case()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.has_permission('CASE_DISCOVER');
$$;

create function authz.can_view_case_metadata(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null
     and authz.user_can_view_case_metadata(authz.current_user_id(), p_case_id);
$$;

create function authz.can_view_case_content(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id);
$$;

create function authz.can_view_records_catalogue(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case_metadata(p_case_id);
$$;

-- ADR-013's records predicate now means "minimum records metadata" (catalogue, task or case access).
-- Every 1300/1310 policy and command that called it follows the new rule without being rewritten.
create or replace function authz.can_view_records(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case_metadata(p_case_id);
$$;

create function authz.can_manage_retention(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.has_permission('RETENTION_CLASS_ASSIGN')
     and ((authz.in_records_catalogue_scope(p_case_id) and authz.has_permission('ARCHIVE_RECORD_ADMINISTER'))
          or authz.task_grants(p_case_id, 'RETENTION_TASK_EXECUTE'));
$$;

create function authz.can_manage_disposition(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.has_permission('DISPOSITION_REQUEST')
     and ((authz.in_records_catalogue_scope(p_case_id) and authz.has_permission('ARCHIVE_RECORD_ADMINISTER'))
          or authz.task_grants(p_case_id, 'DISPOSITION_TASK_EXECUTE'));
$$;

create or replace function authz.can_request_disposition(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_manage_disposition(p_case_id);
$$;

create or replace function authz.can_approve_disposition(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.has_permission('DISPOSITION_APPROVE')
     and (authz.can_view_case(p_case_id)
          or authz.in_records_catalogue_scope(p_case_id)
          or authz.task_grants(p_case_id, 'DISPOSITION_TASK_VIEW'));
$$;

create function authz.can_request_legal_hold(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.has_permission('LEGAL_HOLD_REQUEST')
     and (authz.can_view_case(p_case_id)
          or authz.in_records_catalogue_scope(p_case_id)
          or authz.task_grants(p_case_id, 'LEGAL_HOLD_REQUEST'))
     and exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state <> 'DISPOSED');
$$;

create function authz.can_review_legal_hold(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.has_permission('LEGAL_HOLD_REVIEW')
     and (authz.can_view_case(p_case_id) or authz.task_grants(p_case_id, 'LEGAL_HOLD_REVIEW'));
$$;

create or replace function authz.can_apply_legal_hold(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.has_permission('LEGAL_HOLD_APPLY')
     and not authz.has_conflict(p_case_id, authz.current_user_id())
     and (authz.can_view_case(p_case_id)
          or authz.in_records_catalogue_scope(p_case_id)
          or authz.task_grants(p_case_id, 'LEGAL_HOLD_APPLY'))
     and exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state <> 'DISPOSED');
$$;

create or replace function authz.can_release_legal_hold(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.has_permission('LEGAL_HOLD_RELEASE')
     and not authz.has_conflict(p_case_id, authz.current_user_id())
     and (authz.can_view_case(p_case_id)
          or authz.in_records_catalogue_scope(p_case_id)
          or authz.task_grants(p_case_id, 'LEGAL_HOLD_RELEASE'));
$$;

grant execute on function
  authz.can_discover_case(), authz.can_view_case_metadata(uuid), authz.can_view_case_content(uuid),
  authz.can_view_records_catalogue(uuid), authz.can_manage_retention(uuid), authz.can_manage_disposition(uuid),
  authz.can_request_legal_hold(uuid), authz.can_review_legal_hold(uuid), authz.task_grants(uuid, text),
  authz.in_records_catalogue_scope(uuid)
to authenticated;
-- user_* variants, user_case_gate and has_active_break_glass are for command functions only (owner context).

-- -----------------------------------------------------------------------------
-- Records catalogue projection (§7, §14). Lifecycle fields only: no title, summary, people, allegations,
-- interviews, findings, evidence descriptions or reporter identity. Records staff cannot read case_record
-- under RLS, so the rows come from a definer function that returns exactly what the metadata predicate
-- allows; the view itself runs with the caller's privileges like every other view (rls-coverage).
-- -----------------------------------------------------------------------------
create function records.catalogue_rows()
returns table (
  case_id uuid, case_number text, case_type text, classification core.classification_level, closed_date timestamptz,
  retention_class text, retention_start_date timestamptz, retention_end_date timestamptz, legal_hold_status text,
  archive_status text, disposition_status text, record_owner text
)
language sql stable security definer
set search_path = ''
as $$
  select c.id, c.case_number, c.case_type, c.classification, c.closed_at, c.retention_class,
         s.trigger_at, s.retain_until, c.legal_hold_status, c.records_state,
         case when dc.id is not null then 'DISPOSED' else coalesce(r.status, 'NONE') end,
         o.department
    from case_mgmt.case_record c
    left join records.retention_schedule s on s.case_id = c.id and s.superseded_at is null
    left join records.disposition_request r on r.case_id = c.id and r.status in ('PENDING', 'APPROVED')
    left join records.disposition_certificate dc on dc.case_id = c.id
    left join iam.user_profile o on o.id = c.owner_id
   where authz.current_user_id() is not null
     and authz.can_view_records_catalogue(c.id);
$$;
grant execute on function records.catalogue_rows() to authenticated;

create view records.case_record_catalogue with (security_invoker = true) as
select * from records.catalogue_rows();

comment on view records.case_record_catalogue is
  'Records catalogue (ADR-014): minimum lifecycle metadata for rows the caller may see; not a case browser.';
grant select on records.case_record_catalogue to authenticated;

-- -----------------------------------------------------------------------------
-- RLS (SELECT only; no write grants)
-- -----------------------------------------------------------------------------
alter table case_mgmt.case_task_type enable row level security;
alter table case_mgmt.case_task enable row level security;
alter table case_mgmt.break_glass_access enable row level security;
alter table records.legal_hold_request enable row level security;

create policy case_task_type_read on case_mgmt.case_task_type for select to authenticated
  using (authz.current_user_id() is not null);
grant select on case_mgmt.case_task_type to authenticated;

-- Assignee, creator, or someone who may manage tasks on that case.
create policy case_task_read on case_mgmt.case_task for select to authenticated
  using (assigned_user_id = authz.current_user_id()
         or created_by = authz.current_user_id()
         or (authz.has_permission('CASE_TASK_ASSIGN') and authz.can_view_case(case_id))
         or (authz.has_permission('RECORDS_LIFECYCLE_ADMIN') and authz.in_records_catalogue_scope(case_id)));
grant select on case_mgmt.case_task to authenticated;

create policy legal_hold_request_read on records.legal_hold_request for select to authenticated
  using (requested_by = authz.current_user_id()
         or assigned_reviewer = authz.current_user_id()
         or ((authz.has_permission('CASE_TASK_ASSIGN') or authz.has_permission('LEGAL_HOLD_REVIEW'))
             and authz.can_view_case(case_id)));
grant select on records.legal_hold_request to authenticated;

create policy break_glass_read on case_mgmt.break_glass_access for select to authenticated
  using (requested_by = authz.current_user_id()
         or (authz.has_permission('BREAK_GLASS_APPROVE') and authz.can_view_case(case_id)));
grant select on case_mgmt.break_glass_access to authenticated;
