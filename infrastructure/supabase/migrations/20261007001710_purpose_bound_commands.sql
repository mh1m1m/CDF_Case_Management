-- =============================================================================
-- 1710 Purpose-bound access: commands (CDF-73, ADR-014)
-- Requirements: Fady's option D §4–§6, §11, §12, §17–§20
--
-- Same contract as 0700: resolve the actor, re-check authorization, validate, change, audit in the same
-- transaction. NOT_FOUND is returned for anything the caller may not see, so a hidden case and a missing
-- case are indistinguishable. Read-side access recording returns booleans instead of raising, so the
-- denial event survives (as api.open_case does). Audit `reason` carries a code, never free text.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tasks
-- -----------------------------------------------------------------------------
create function case_mgmt.create_task_internal(
  p_case_id uuid, p_task_type text, p_user_id uuid, p_purpose text, p_scope text[], p_due_date date,
  p_expires_at timestamptz, p_actor uuid
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_type case_mgmt.case_task_type;
  v_case case_mgmt.case_record;
  v_role text;
  v_expires timestamptz;
  v_scope text[];
  v_id uuid;
begin
  select * into v_type from case_mgmt.case_task_type t where t.code = p_task_type;
  if v_type.code is null then perform api._fail('INVALID', 'task_type'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id;
  if v_case.records_state = 'DISPOSED' then perform api._fail('CONFLICT', 'RECORDS_DISPOSED'); end if;
  if v_type.requires_closed and v_case.records_state = 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_CLOSED'); end if;

  -- Assignee: active, holds an eligible role, cleared for the classification, not conflicted.
  select r into v_role from unnest(v_type.eligible_roles) r
   where authz.user_has_role(p_user_id, r) order by array_position(v_type.eligible_roles, r) limit 1;
  if v_role is null or not authz.user_case_gate(p_user_id, p_case_id) then
    perform api._fail('INVALID', 'assigned_user_id');
  end if;

  v_scope := coalesce(p_scope, v_type.allowed_capabilities);
  if not (v_scope <@ v_type.allowed_capabilities) or not ('CASE_VIEW_METADATA' = any (v_scope)) then
    perform api._fail('INVALID', 'scope');
  end if;
  v_expires := coalesce(p_expires_at, now() + v_type.default_duration);
  if v_expires <= now() or v_expires > now() + v_type.max_duration then perform api._fail('INVALID', 'expires_at'); end if;
  if exists (select 1 from case_mgmt.case_task t where t.case_id = p_case_id and t.task_type = p_task_type
               and t.assigned_user_id = p_user_id and t.status in ('OPEN', 'IN_PROGRESS')) then
    perform api._fail('CONFLICT', 'TASK_ALREADY_ACTIVE');
  end if;

  insert into case_mgmt.case_task (case_id, task_type, assigned_user_id, assigned_role, purpose, scope, created_by,
                                   due_date, expires_at)
  values (p_case_id, p_task_type, p_user_id, v_role, api._require_text(p_purpose, 'purpose', 10, 1000), v_scope, p_actor,
          p_due_date, v_expires)
  returning id into v_id;
  perform audit.record_event('CASE_TASK_ASSIGNED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_task', v_id::text, p_task_type,
    jsonb_build_object('task_type', p_task_type, 'assigned_user_id', p_user_id, 'assigned_role', v_role,
                       'scope', to_jsonb(v_scope), 'expires_at', v_expires));
  return v_id;
end;
$$;

-- Who may create a task: a case authority (CASE_TASK_ASSIGN + content access), or, for records tasks
-- within the catalogue scope (post-closure, non-restricted), a records-lifecycle administrator.
create function case_mgmt.may_manage_tasks(p_case_id uuid, p_category text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (authz.has_permission('CASE_TASK_ASSIGN') and authz.can_view_case(p_case_id))
      or (p_category = 'RECORDS' and authz.has_permission('RECORDS_LIFECYCLE_ADMIN')
          and authz.in_records_catalogue_scope(p_case_id));
$$;

create function api.create_case_task(
  p_case_id uuid, p_task_type text, p_assigned_user_id uuid, p_purpose text,
  p_scope text[] default null, p_due_date date default null, p_expires_at timestamptz default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_category text;
begin
  if not authz.can_view_case_metadata(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  select t.category into v_category from case_mgmt.case_task_type t where t.code = p_task_type;
  if v_category is null then perform api._fail('INVALID', 'task_type'); end if;
  if not case_mgmt.may_manage_tasks(p_case_id, v_category) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = p_case_id for update;
  return case_mgmt.create_task_internal(p_case_id, p_task_type, p_assigned_user_id, p_purpose, p_scope, p_due_date,
                                        p_expires_at, v_actor);
end;
$$;

-- Opening a task is the audited start of the purpose (§19). Returns false (and records the denial) for
-- anything but the assignee's own active task.
create function api.open_case_task(p_task_id uuid)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_task case_mgmt.case_task;
begin
  select * into v_task from case_mgmt.case_task t where t.id = p_task_id;
  if v_task.id is null or v_task.assigned_user_id <> v_actor or v_task.status not in ('OPEN', 'IN_PROGRESS')
     or v_task.expires_at <= now() or not authz.task_grants(v_task.case_id, 'CASE_VIEW_METADATA') then
    perform audit.record_event('CASE_ACCESS_DENIED', 'SECURITY', 'DENIED', null, 'case_task', p_task_id::text, 'TASK_NOT_ACTIVE',
      '{}'::jsonb);
    return false;
  end if;
  perform audit.record_event('RECORDS_TASK_OPENED', 'BUSINESS', 'SUCCESS', v_task.case_id, 'case_task', v_task.id::text,
    v_task.task_type, jsonb_build_object('task_type', v_task.task_type));
  if v_task.status = 'OPEN' then
    update case_mgmt.case_task set status = 'IN_PROGRESS', opened_at = now() where id = v_task.id;
    if v_task.task_type = 'RETENTION_REVIEW' then
      perform audit.record_event('RETENTION_REVIEW_STARTED', 'BUSINESS', 'SUCCESS', v_task.case_id, 'case_task',
        v_task.id::text, null, '{}'::jsonb);
    elsif v_task.task_type in ('DISPOSITION_REVIEW', 'DISPOSITION_APPROVAL', 'DISPOSITION_EXECUTION') then
      perform audit.record_event('DISPOSITION_REVIEW_STARTED', 'BUSINESS', 'SUCCESS', v_task.case_id, 'case_task',
        v_task.id::text, v_task.task_type, '{}'::jsonb);
    end if;
  end if;
  return true;
end;
$$;

create function case_mgmt.close_task_internal(p_task_id uuid, p_status text, p_actor uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v case_mgmt.case_task;
begin
  update case_mgmt.case_task
     set status = p_status, closed_by = p_actor, closed_at = now(), closure_reason = p_reason,
         completed_at = case when p_status = 'COMPLETED' then now() end
   where id = p_task_id and status in ('OPEN', 'IN_PROGRESS')
  returning * into v;
  if v.id is null then perform api._fail('CONFLICT', 'TASK_NOT_ACTIVE'); end if;
  perform audit.record_event('CASE_TASK_' || p_status, 'BUSINESS', 'SUCCESS', v.case_id, 'case_task', v.id::text,
    v.task_type, jsonb_build_object('task_type', v.task_type, 'assigned_user_id', v.assigned_user_id));
end;
$$;

create function api.complete_case_task(p_task_id uuid, p_note text default null)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_task case_mgmt.case_task;
begin
  select * into v_task from case_mgmt.case_task t where t.id = p_task_id;
  if v_task.id is null or v_task.assigned_user_id <> v_actor then perform api._fail('NOT_FOUND'); end if;
  perform case_mgmt.close_task_internal(p_task_id, 'COMPLETED', v_actor, nullif(btrim(coalesce(p_note, '')), ''));
end;
$$;

create function api.cancel_case_task(p_task_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_task case_mgmt.case_task;
  v_category text;
begin
  select * into v_task from case_mgmt.case_task t where t.id = p_task_id;
  if v_task.id is null then perform api._fail('NOT_FOUND'); end if;
  select t.category into v_category from case_mgmt.case_task_type t where t.code = v_task.task_type;
  if not (v_task.created_by = v_actor or case_mgmt.may_manage_tasks(v_task.case_id, v_category)) then
    perform api._fail('NOT_FOUND');
  end if;
  perform case_mgmt.close_task_internal(p_task_id, 'CANCELLED', v_actor, api._require_text(p_reason, 'reason', 5, 2000));
end;
$$;

-- Housekeeping: marks lapsed tasks EXPIRED. Access already ceased at expires_at (the predicates check it);
-- this only makes the state explicit. Production runs it as a scheduled job.
create function api.expire_case_tasks()
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_count int := 0;
begin
  if not (authz.has_permission('RECORDS_LIFECYCLE_ADMIN') or authz.has_permission('CASE_TASK_ASSIGN')) then
    perform api._fail('FORBIDDEN');
  end if;
  for v_id in select t.id from case_mgmt.case_task t
               where t.status in ('OPEN', 'IN_PROGRESS') and t.expires_at <= now() order by t.id for update loop
    perform case_mgmt.close_task_internal(v_id, 'EXPIRED', v_actor, 'EXPIRED');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Metadata view recording (§19 RECORDS_CASE_METADATA_VIEWED / CASE_ACCESS_DENIED)
-- -----------------------------------------------------------------------------
create function api.open_case_metadata(p_case_id uuid)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare v_actor uuid := api._actor();
begin
  if authz.can_view_case_metadata(p_case_id) then
    perform audit.record_event('RECORDS_CASE_METADATA_VIEWED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_record',
      p_case_id::text, null, '{}'::jsonb);
    return true;
  end if;
  perform audit.record_event('CASE_ACCESS_DENIED', 'SECURITY', 'DENIED', null, 'case_record', p_case_id::text, 'METADATA',
    jsonb_build_object('target_exists', exists (select 1 from case_mgmt.case_record c where c.id = p_case_id)));
  return false;
end;
$$;

-- -----------------------------------------------------------------------------
-- Legal hold request flow (§5)
-- -----------------------------------------------------------------------------
create function records.create_hold_request_internal(
  p_case_id uuid, p_origin text, p_reason_code text, p_justification text, p_actor uuid
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if p_reason_code is null
     or p_reason_code not in ('LITIGATION', 'REGULATORY_INQUIRY', 'INTERNAL_INVESTIGATION', 'AUDIT', 'OTHER') then
    perform api._fail('INVALID', 'reason_code');
  end if;
  insert into records.legal_hold_request (case_id, origin, reason_code, justification, requested_by)
  values (p_case_id, p_origin, p_reason_code, api._require_text(p_justification, 'justification', 20, 2000), p_actor)
  returning id into v_id;
  perform audit.record_event('LEGAL_HOLD_REQUESTED', 'BUSINESS', 'SUCCESS', p_case_id, 'legal_hold_request', v_id::text,
    p_reason_code, jsonb_build_object('origin', p_origin, 'reason_code', p_reason_code));
  return v_id;
end;
$$;

-- An authorised business user (case team, or a task holder whose task includes LEGAL_HOLD_REQUEST).
create function api.request_legal_hold(p_case_id uuid, p_reason_code text, p_justification text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare v_actor uuid := api._actor();
begin
  if not authz.can_view_case_metadata(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_request_legal_hold(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  return records.create_hold_request_internal(p_case_id, 'CASE_TEAM', p_reason_code, p_justification, v_actor);
end;
$$;

-- A case authority routes the request to a legal reviewer as a purpose-bound assessment task.
create function api.assign_legal_hold_request(p_request_id uuid, p_reviewer_id uuid, p_expires_at timestamptz default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_req records.legal_hold_request;
  v_task uuid;
begin
  select * into v_req from records.legal_hold_request r where r.id = p_request_id;
  if v_req.id is null or not authz.can_view_case(v_req.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('CASE_TASK_ASSIGN') then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_req.case_id for update;
  select * into v_req from records.legal_hold_request r where r.id = p_request_id for update;
  if v_req.status <> 'SUBMITTED' then perform api._fail('CONFLICT', 'REQUEST_NOT_SUBMITTED'); end if;
  v_task := case_mgmt.create_task_internal(v_req.case_id, 'LEGAL_HOLD_ASSESSMENT', p_reviewer_id,
    'Assess legal hold request ' || v_req.id::text, null, null, p_expires_at, v_actor);
  update records.legal_hold_request
     set status = 'ASSIGNED', assigned_reviewer = p_reviewer_id, assigned_task_id = v_task, assigned_by = v_actor
   where id = p_request_id;
  return v_task;
end;
$$;

-- The assigned reviewer applies or rejects under the task. Applying goes through api.place_legal_hold, so
-- every ADR-013 rule (lock order, disposition blocking, LEGAL_HOLD_PLACED audit) applies unchanged.
-- Either outcome completes the task, which ends the task-derived access.
create function api.review_legal_hold_request(
  p_request_id uuid, p_apply boolean, p_reason text, p_scope_type text default 'CASE', p_evidence_id uuid default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_req records.legal_hold_request;
  v_reason text;
  v_hold uuid;
begin
  select * into v_req from records.legal_hold_request r where r.id = p_request_id;
  if v_req.id is null or v_req.assigned_reviewer is distinct from v_actor
     or not authz.can_view_case_metadata(v_req.case_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if not authz.can_review_legal_hold(v_req.case_id) then perform api._fail('FORBIDDEN'); end if;
  if v_req.status <> 'ASSIGNED' then perform api._fail('CONFLICT', 'REQUEST_NOT_ASSIGNED'); end if;
  if p_apply is null then perform api._fail('INVALID', 'apply'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);

  if p_apply then
    v_hold := api.place_legal_hold(v_req.case_id, p_scope_type, p_evidence_id, v_req.reason_code, v_req.justification,
                                   'LHR-' || left(v_req.id::text, 8));
  end if;
  perform 1 from records.legal_hold_request r where r.id = p_request_id for update;
  update records.legal_hold_request
     set status = case when p_apply then 'APPLIED' else 'REJECTED' end,
         reviewed_by = v_actor, reviewed_at = now(), review_reason = v_reason, legal_hold_id = v_hold
   where id = p_request_id;
  perform audit.record_event('LEGAL_HOLD_REVIEWED', 'BUSINESS', 'SUCCESS', v_req.case_id, 'legal_hold_request',
    p_request_id::text, case when p_apply then 'APPLY' else 'REJECT' end,
    jsonb_build_object('legal_hold_id', v_hold, 'origin', v_req.origin));
  perform case_mgmt.close_task_internal(v_req.assigned_task_id, 'COMPLETED', v_actor, 'LEGAL_HOLD_REVIEWED');
  return v_hold;
end;
$$;

-- -----------------------------------------------------------------------------
-- Controlled case lookup (§6): exact case number + justification; rate limited; audited; no wildcard;
-- returns only what identifies the target and creates a hold request. No content, no task, no grant.
-- A restricted, out-of-clearance, conflicted, disposed or missing case all return NO_MATCH.
-- -----------------------------------------------------------------------------
create function api.request_case_for_legal_hold(
  p_case_reference text, p_justification text, p_reason_code text default 'LITIGATION'
)
returns table (outcome text, request_id uuid, case_id uuid, case_number text, legal_hold_status text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_ref text := upper(btrim(coalesce(p_case_reference, '')));
  v_just text;
  v_limit int;
  v_recent int;
  v_case case_mgmt.case_record;
  v_req uuid;
begin
  if not (authz.can_discover_case() and authz.has_permission('LEGAL_HOLD_REQUEST')) then perform api._fail('FORBIDDEN'); end if;
  -- Exact reference only: no pattern, prefix or partial value is accepted.
  if v_ref !~ '^CDF-(CASE|DEMO)-[0-9]{4}-[0-9]{4,5}$' then perform api._fail('INVALID', 'case_reference'); end if;
  v_just := api._require_text(p_justification, 'justification', 20, 2000);
  if p_reason_code is null
     or p_reason_code not in ('LITIGATION', 'REGULATORY_INQUIRY', 'INTERNAL_INVESTIGATION', 'AUDIT', 'OTHER') then
    perform api._fail('INVALID', 'reason_code');
  end if;

  select coalesce(s.value::int, 5) into v_limit from config.setting s where s.key = 'CASE_DISCOVERY_RATE_LIMIT';
  select count(*) into v_recent from audit.audit_event e
   where e.action = 'CASE_DISCOVERY_REQUESTED' and e.actor_id = v_actor and e.occurred_at > now() - interval '1 hour';
  if v_recent >= coalesce(v_limit, 5) then
    perform audit.record_event('CASE_DISCOVERY_REQUESTED', 'SECURITY', 'DENIED', null, 'case_record', null, 'LEGAL_HOLD',
      jsonb_build_object('purpose', 'LEGAL_HOLD', 'search_type', 'EXACT_CASE_NUMBER', 'outcome', 'RATE_LIMITED'));
    return query select 'RATE_LIMITED'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;

  select c.* into v_case from case_mgmt.case_record c
   where c.case_number = v_ref
     and c.records_state <> 'DISPOSED'
     and authz.user_case_gate(v_actor, c.id)
     and (not c.is_restricted or authz.user_can_view_case(v_actor, c.id));

  if v_case.id is null then
    perform audit.record_event('CASE_DISCOVERY_REQUESTED', 'SECURITY', 'SUCCESS', null, 'case_record', null, 'LEGAL_HOLD',
      jsonb_build_object('purpose', 'LEGAL_HOLD', 'search_type', 'EXACT_CASE_NUMBER', 'outcome', 'NO_MATCH'));
    return query select 'NO_MATCH'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;

  perform audit.record_event('CASE_DISCOVERY_REQUESTED', 'SECURITY', 'SUCCESS', v_case.id, 'case_record', v_case.id::text,
    'LEGAL_HOLD', jsonb_build_object('purpose', 'LEGAL_HOLD', 'search_type', 'EXACT_CASE_NUMBER', 'outcome', 'MATCHED'));
  perform audit.record_event('LEGAL_HOLD_CASE_DISCOVERED', 'BUSINESS', 'SUCCESS', v_case.id, 'case_record', v_case.id::text,
    'LEGAL_HOLD', jsonb_build_object('search_type', 'EXACT_CASE_NUMBER'));
  v_req := records.create_hold_request_internal(v_case.id, 'CONTROLLED_LOOKUP', p_reason_code, v_just, v_actor);
  return query select 'MATCHED'::text, v_req, v_case.id, v_case.case_number, v_case.legal_hold_status;
end;
$$;

-- -----------------------------------------------------------------------------
-- Retention class: now gated by the purpose (catalogue administration or a retention task), replacing
-- the 1310 body. Behaviour is otherwise identical.
-- -----------------------------------------------------------------------------
create or replace function api.assign_retention_class(p_case_id uuid, p_retention_class text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
begin
  if not authz.can_view_records(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_manage_retention(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  if v_case.records_state not in ('ARCHIVED', 'RETENTION') then perform api._fail('CONFLICT', 'RECORDS_STATE'); end if;
  if p_retention_class is null or p_retention_class = 'UNASSIGNED'
     or not exists (select 1 from records.retention_class k where k.code = p_retention_class and k.record_type = 'CASE') then
    perform api._fail('INVALID', 'retention_class');
  end if;
  if p_retention_class = v_case.retention_class and v_case.records_state = 'RETENTION' then
    perform api._fail('CONFLICT', 'CLASS_UNCHANGED');
  end if;

  update case_mgmt.case_record c
     set retention_class = p_retention_class, records_state = 'RETENTION',
         updated_at = now(), updated_by = v_actor, row_version = c.row_version + 1
   where c.id = p_case_id;
  perform audit.record_event('RETENTION_CLASS_ASSIGNED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_record', p_case_id::text, null,
    jsonb_build_object('from', v_case.retention_class, 'to', p_retention_class));
  return records._compute_schedule(p_case_id, 'CLASS_CHANGED');
end;
$$;

-- -----------------------------------------------------------------------------
-- Break-glass (§20)
-- -----------------------------------------------------------------------------
create function api.request_break_glass(p_case_id uuid, p_reason text, p_duration_minutes int)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_reason text;
  v_id uuid;
begin
  -- Break-glass escalates a case the requester already legitimately knows (a task, the catalogue or the
  -- controlled lookup followed by a task) to content; it is never a way to discover a case. Restricted
  -- cases are never reachable by break-glass: they need an explicit grant (§9).
  if not authz.can_view_case_metadata(p_case_id)
     or not exists (select 1 from case_mgmt.case_record c
                    where c.id = p_case_id and not c.is_restricted and c.records_state <> 'DISPOSED') then
    perform api._fail('NOT_FOUND');
  end if;
  if not authz.has_permission('BREAK_GLASS_REQUEST') then perform api._fail('FORBIDDEN'); end if;
  v_reason := api._require_text(p_reason, 'reason', 20, 2000);
  if p_duration_minutes is null or p_duration_minutes < 15 or p_duration_minutes > 72 * 60 then
    perform api._fail('INVALID', 'duration');
  end if;
  if exists (select 1 from case_mgmt.break_glass_access b where b.case_id = p_case_id and b.requested_by = v_actor
               and (b.status = 'REQUESTED' or (b.status = 'ACTIVE' and b.access_expires_at > now()))) then
    perform api._fail('CONFLICT', 'BREAK_GLASS_OPEN');
  end if;
  insert into case_mgmt.break_glass_access (case_id, requested_by, reason, duration)
  values (p_case_id, v_actor, v_reason, make_interval(mins => p_duration_minutes)) returning id into v_id;
  perform audit.record_event('BREAK_GLASS_REQUESTED', 'SECURITY', 'SUCCESS', p_case_id, 'break_glass_access', v_id::text,
    null, jsonb_build_object('duration_minutes', p_duration_minutes));
  return v_id;
end;
$$;

create function api.decide_break_glass(p_request_id uuid, p_approve boolean, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_bg case_mgmt.break_glass_access;
  v_reason text;
begin
  select * into v_bg from case_mgmt.break_glass_access b where b.id = p_request_id;
  if v_bg.id is null or not authz.can_view_case(v_bg.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('BREAK_GLASS_APPROVE') or v_bg.requested_by = v_actor then perform api._fail('FORBIDDEN'); end if;
  select * into v_bg from case_mgmt.break_glass_access b where b.id = p_request_id for update;
  if v_bg.status <> 'REQUESTED' then perform api._fail('CONFLICT', 'BREAK_GLASS_NOT_REQUESTED'); end if;
  if p_approve is null then perform api._fail('INVALID', 'approve'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  update case_mgmt.break_glass_access
     set status = case when p_approve then 'ACTIVE' else 'REJECTED' end,
         decided_by = v_actor, decided_at = now(), decision_reason = v_reason,
         access_expires_at = case when p_approve then now() + v_bg.duration end,
         review_status = case when p_approve then 'PENDING' else 'NOT_DUE' end
   where id = p_request_id;
  perform audit.record_event(case when p_approve then 'BREAK_GLASS_APPROVED' else 'BREAK_GLASS_REJECTED' end,
    'SECURITY', 'SUCCESS', v_bg.case_id, 'break_glass_access', p_request_id::text, null,
    jsonb_build_object('requested_by', v_bg.requested_by, 'duration_minutes', extract(epoch from v_bg.duration)::int / 60));
end;
$$;

-- The requester or an approver may end access early.
create function api.end_break_glass(p_request_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_bg case_mgmt.break_glass_access;
begin
  select * into v_bg from case_mgmt.break_glass_access b where b.id = p_request_id for update;
  if v_bg.id is null or not (v_bg.requested_by = v_actor
                             or (authz.has_permission('BREAK_GLASS_APPROVE') and authz.can_view_case(v_bg.case_id))) then
    perform api._fail('NOT_FOUND');
  end if;
  if v_bg.status <> 'ACTIVE' then perform api._fail('CONFLICT', 'BREAK_GLASS_NOT_ACTIVE'); end if;
  update case_mgmt.break_glass_access set status = 'ENDED', ended_at = now(),
         access_expires_at = least(access_expires_at, now())
   where id = p_request_id;
  perform audit.record_event('BREAK_GLASS_ENDED', 'SECURITY', 'SUCCESS', v_bg.case_id, 'break_glass_access',
    p_request_id::text, null, '{}'::jsonb);
end;
$$;

-- Post-event review by an approver other than the requester; every approved access must be reviewed.
create function api.review_break_glass(p_request_id uuid, p_outcome text, p_notes text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_bg case_mgmt.break_glass_access;
begin
  select * into v_bg from case_mgmt.break_glass_access b where b.id = p_request_id for update;
  if v_bg.id is null or not authz.can_view_case(v_bg.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('BREAK_GLASS_APPROVE') or v_bg.requested_by = v_actor then perform api._fail('FORBIDDEN'); end if;
  if v_bg.review_status <> 'PENDING' then perform api._fail('CONFLICT', 'REVIEW_NOT_PENDING'); end if;
  if p_outcome is null or p_outcome not in ('APPROPRIATE', 'INAPPROPRIATE') then perform api._fail('INVALID', 'outcome'); end if;
  update case_mgmt.break_glass_access
     set review_status = 'REVIEWED', reviewed_by = v_actor, reviewed_at = now(), review_outcome = p_outcome,
         review_notes = api._require_text(p_notes, 'notes', 10, 2000)
   where id = p_request_id;
  perform audit.record_event('BREAK_GLASS_REVIEWED', 'SECURITY', 'SUCCESS', v_bg.case_id, 'break_glass_access',
    p_request_id::text, p_outcome, jsonb_build_object('requested_by', v_bg.requested_by));
end;
$$;

-- -----------------------------------------------------------------------------
-- Search, counts and dashboards (§17, §18): everything is computed over authorised rows only.
-- -----------------------------------------------------------------------------
create function api.search_records_catalogue(
  p_case_number text default null, p_archive_status text default null, p_legal_hold_status text default null,
  p_limit int default 50, p_offset int default 0
)
returns table (
  case_id uuid, case_number text, case_type text, classification core.classification_level, closed_date timestamptz,
  retention_class text, retention_start_date timestamptz, retention_end_date timestamptz, legal_hold_status text,
  archive_status text, disposition_status text, record_owner text, total_count bigint
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_prefix text := upper(btrim(coalesce(p_case_number, '')));
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then perform api._fail('INVALID', 'limit'); end if;
  if p_offset is null or p_offset < 0 then perform api._fail('INVALID', 'offset'); end if;
  if v_prefix !~ '^[A-Z0-9-]{0,20}$' then perform api._fail('INVALID', 'case_number'); end if;
  return query
    select k.case_id, k.case_number, k.case_type, k.classification, k.closed_date, k.retention_class,
           k.retention_start_date, k.retention_end_date, k.legal_hold_status, k.archive_status, k.disposition_status,
           k.record_owner, count(*) over ()
      from records.case_record_catalogue k
     where (v_prefix = '' or left(k.case_number, length(v_prefix)) = v_prefix)
       and (p_archive_status is null or k.archive_status = p_archive_status)
       and (p_legal_hold_status is null or k.legal_hold_status = p_legal_hold_status)
     order by k.closed_date nulls last, k.case_number
     limit p_limit offset p_offset;
end;
$$;

-- "My work" for the records and legal dashboards: the caller's own tasks and requests, never all cases.
create function api.my_case_tasks()
returns table (
  task_id uuid, case_id uuid, case_number text, task_type text, category text, purpose text, scope text[],
  status text, due_date date, expires_at timestamptz, legal_hold_status text, archive_status text
)
language sql stable security definer
set search_path = ''
as $$
  select t.id, t.case_id, k.case_number, t.task_type, tt.category, t.purpose, t.scope, t.status, t.due_date, t.expires_at,
         k.legal_hold_status, k.archive_status
    from case_mgmt.case_task t
    join case_mgmt.case_task_type tt on tt.code = t.task_type
    left join records.case_record_catalogue k on k.case_id = t.case_id
   where t.assigned_user_id = authz.current_user_id()
     and t.status in ('OPEN', 'IN_PROGRESS') and t.expires_at > now()
   order by t.due_date nulls last, t.expires_at;
$$;

create function api.my_work_summary()
returns table (
  my_retention_tasks int, my_disposition_tasks int, pending_archive_transfers int, assigned_legal_holds int,
  my_legal_reviews int, my_legal_hold_requests int
)
language sql stable security definer
set search_path = ''
as $$
  with mine as (select * from api.my_case_tasks())
  select (select count(*) from mine where task_type = 'RETENTION_REVIEW')::int,
         (select count(*) from mine where task_type in ('DISPOSITION_REVIEW', 'DISPOSITION_APPROVAL', 'DISPOSITION_EXECUTION'))::int,
         (select count(*) from mine where task_type = 'ARCHIVE_TRANSFER')::int,
         (select count(*) from mine where task_type in ('LEGAL_HOLD_ASSESSMENT', 'LEGAL_HOLD_APPLICATION', 'LEGAL_HOLD_RELEASE'))::int,
         (select count(*) from mine where task_type = 'LEGAL_REVIEW')::int,
         (select count(*) from records.legal_hold_request r
           where r.requested_by = authz.current_user_id() and r.status in ('SUBMITTED', 'ASSIGNED'))::int;
$$;

grant execute on function
  api.create_case_task(uuid, text, uuid, text, text[], date, timestamptz),
  api.open_case_task(uuid),
  api.complete_case_task(uuid, text),
  api.cancel_case_task(uuid, text),
  api.expire_case_tasks(),
  api.open_case_metadata(uuid),
  api.request_legal_hold(uuid, text, text),
  api.assign_legal_hold_request(uuid, uuid, timestamptz),
  api.review_legal_hold_request(uuid, boolean, text, text, uuid),
  api.request_case_for_legal_hold(text, text, text),
  api.request_break_glass(uuid, text, int),
  api.decide_break_glass(uuid, boolean, text),
  api.end_break_glass(uuid),
  api.review_break_glass(uuid, text, text),
  api.search_records_catalogue(text, text, text, int, int),
  api.my_case_tasks(),
  api.my_work_summary()
to authenticated;
