-- =============================================================================
-- 0700 Command functions for the authenticated investigation app (ADR-003)
--
-- Every state change in the platform happens here. Each command:
--   1. resolves the actor (authz.current_user_id) — inactive users get nothing,
--   2. re-checks authorization (defense in depth; the BFF checked first),
--   3. validates state and input,
--   4. performs the change,
--   5. writes audit events in the same transaction.
--
-- Error contract (mapped to safe user messages by packages/application):
--   CDF_UNAUTHENTICATED     no active user in context
--   CDF_NOT_FOUND           object missing OR not visible (indistinguishable on purpose, §40)
--   CDF_FORBIDDEN           visible but action not permitted
--   CDF_INVALID:<field>     input validation failure
--   CDF_CONFLICT:<code>     state does not allow the action
-- =============================================================================

create function api._actor()
returns uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare v uuid := authz.current_user_id();
begin
  if v is null then
    raise exception using errcode = 'insufficient_privilege', message = 'CDF_UNAUTHENTICATED';
  end if;
  return v;
end;
$$;

create function api._fail(p_kind text, p_detail text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_kind = 'NOT_FOUND' then
    raise exception using errcode = 'no_data_found', message = 'CDF_NOT_FOUND';
  elsif p_kind = 'FORBIDDEN' then
    raise exception using errcode = 'insufficient_privilege', message = 'CDF_FORBIDDEN';
  elsif p_kind = 'INVALID' then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:' || coalesce(p_detail, '');
  else
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CDF_CONFLICT:' || coalesce(p_detail, p_kind);
  end if;
end;
$$;

create function api._require_text(p_value text, p_field text, p_min int, p_max int)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare v text := btrim(coalesce(p_value, ''));
begin
  if length(v) < p_min or length(v) > p_max then
    perform api._fail('INVALID', p_field);
  end if;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Read-side access recording (§30 CASE_VIEWED; denial is a SECURITY event)
-- -----------------------------------------------------------------------------
create function api.open_case(p_case_id uuid)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare v_actor uuid := api._actor();
begin
  if authz.can_view_case(p_case_id) then
    perform audit.record_event('CASE_VIEWED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_record', p_case_id::text, null, '{}'::jsonb);
    return true;
  end if;
  perform audit.record_event('CASE_ACCESS_DENIED', 'SECURITY', 'DENIED', null, 'case_record', p_case_id::text, null,
    jsonb_build_object('target_exists', exists (select 1 from case_mgmt.case_record c where c.id = p_case_id)));
  return false;
end;
$$;

create function api.open_report(p_report_id uuid)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare v_actor uuid := api._actor();
begin
  if authz.can_view_report(p_report_id) then
    perform audit.record_event('REPORT_VIEWED', 'BUSINESS', 'SUCCESS',
      (select r.case_id from intake.report r where r.id = p_report_id), 'report', p_report_id::text, null, '{}'::jsonb);
    return true;
  end if;
  perform audit.record_event('REPORT_ACCESS_DENIED', 'SECURITY', 'DENIED', null, 'report', p_report_id::text, null,
    jsonb_build_object('target_exists', exists (select 1 from intake.report r where r.id = p_report_id)));
  return false;
end;
$$;

-- Security events detected by the application layer (SecurityEventSink → PostgresAuditSink).
create function api.record_security_event(p_action text, p_object_type text, p_object_id text, p_metadata jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  if authz.current_subject() is null then
    perform api._fail('FORBIDDEN');
  end if;
  if p_action not in ('ACCESS_DENIED', 'COMMAND_DENIED', 'SESSION_REJECTED', 'VALIDATION_REJECTED') then
    perform api._fail('INVALID', 'action');
  end if;
  if p_metadata is not null and length(p_metadata::text) > 2048 then
    perform api._fail('INVALID', 'metadata');
  end if;
  return audit.record_event(p_action, 'SECURITY', 'DENIED', null, p_object_type, left(p_object_id, 200), null,
                            coalesce(p_metadata, '{}'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- Intake
-- -----------------------------------------------------------------------------
create function api.triage_report(
  p_report_id uuid, p_outcome text, p_reason text, p_referred_to text default null, p_duplicate_of uuid default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_report intake.report;
  v_id uuid;
  v_reason text;
  v_status text;
begin
  if not authz.can_view_report(p_report_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('REPORT_TRIAGE') then perform api._fail('FORBIDDEN'); end if;
  select * into v_report from intake.report r where r.id = p_report_id for update;
  if v_report.status not in ('RECEIVED', 'INFO_REQUESTED') or v_report.case_id is not null then
    perform api._fail('CONFLICT', 'REPORT_ALREADY_TRIAGED');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 4000);
  v_status := case p_outcome
    when 'OPEN_CASE' then 'ACCEPTED'
    when 'REQUEST_INFORMATION' then 'INFO_REQUESTED'
    when 'REFER_OUT' then 'REFERRED_OUT'
    when 'CLOSE_NO_ACTION' then 'CLOSED_NO_ACTION'
    when 'DUPLICATE' then 'DUPLICATE'
  end;
  if v_status is null then perform api._fail('INVALID', 'outcome'); end if;
  if p_outcome = 'REFER_OUT' and coalesce(btrim(p_referred_to), '') = '' then perform api._fail('INVALID', 'referred_to'); end if;
  if p_outcome = 'DUPLICATE' and (p_duplicate_of is null or p_duplicate_of = p_report_id
       or not authz.can_view_report(p_duplicate_of)) then
    perform api._fail('INVALID', 'duplicate_of');
  end if;

  insert into intake.report_triage (report_id, outcome, reason, referred_to, duplicate_of_report_id, decided_by)
  values (p_report_id, p_outcome, v_reason, nullif(btrim(p_referred_to), ''),
          case when p_outcome = 'DUPLICATE' then p_duplicate_of end, v_actor)
  returning id into v_id;

  update intake.report set status = v_status, status_changed_at = now() where id = p_report_id;

  perform audit.record_event('REPORT_TRIAGED', 'BUSINESS', 'SUCCESS', null, 'report', p_report_id::text, v_reason,
    jsonb_build_object('outcome', p_outcome, 'triage_id', v_id));
  return v_id;
end;
$$;

create function api.reply_to_reporter(p_report_id uuid, p_body text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_body text;
begin
  if not authz.can_view_report(p_report_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('REPORT_MESSAGE_REPLY') then perform api._fail('FORBIDDEN'); end if;
  v_body := api._require_text(p_body, 'body', 1, 4000);
  insert into intake.report_message (report_id, direction, body, author_user_id)
  values (p_report_id, 'TO_REPORTER', v_body, v_actor) returning id into v_id;
  -- The message body is case content; the audit event records the fact, not the text.
  perform audit.record_event('REPORT_MESSAGE_SENT', 'BUSINESS', 'SUCCESS',
    (select r.case_id from intake.report r where r.id = p_report_id), 'report', p_report_id::text, null,
    jsonb_build_object('message_id', v_id, 'length', length(v_body)));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Case creation
-- -----------------------------------------------------------------------------
create function case_mgmt.next_case_number(p_prefix text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_year int := extract(year from now() at time zone 'Asia/Riyadh')::int;
  v_next int;
begin
  insert into case_mgmt.case_number_counter (prefix, year, last_value) values (p_prefix, v_year, 1)
  on conflict (prefix, year) do update set last_value = case_mgmt.case_number_counter.last_value + 1
  returning last_value into v_next;
  -- lpad truncates, so only pad below 10000 (format allows 4–5 digits).
  return p_prefix || '-' || v_year || '-' || case when v_next < 10000 then lpad(v_next::text, 4, '0') else v_next::text end;
end;
$$;

create function workflow.apply_transition(
  p_case_id uuid, p_transition_code text, p_actor uuid, p_reason text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_inst workflow.workflow_instance;
  v_def workflow.workflow_transition_definition;
  v_state workflow.workflow_state;
  v_sla int;
begin
  select * into v_inst from workflow.workflow_instance i where i.case_id = p_case_id for update;
  select * into v_def from workflow.workflow_transition_definition d
   where d.workflow_code = v_inst.workflow_code and d.code = p_transition_code and d.from_state = v_inst.current_state;
  if v_def.code is null then
    perform api._fail('CONFLICT', 'TRANSITION_NOT_AVAILABLE_FROM_STATE');
  end if;
  select * into v_state from workflow.workflow_state s where s.workflow_code = v_inst.workflow_code and s.code = v_def.to_state;
  select min(d.sla_hours) into v_sla from workflow.workflow_transition_definition d
   where d.workflow_code = v_inst.workflow_code and d.from_state = v_def.to_state and d.is_enabled and not d.is_system;

  update workflow.workflow_instance
     set current_state = v_def.to_state, entered_state_at = now(),
         state_due_at = case when v_sla is null then null else now() + make_interval(hours => v_sla) end
   where id = v_inst.id;

  insert into workflow.workflow_transition_event (instance_id, case_id, transition_code, from_state, to_state, actor_id, reason, request_id)
  values (v_inst.id, p_case_id, v_def.code, v_def.from_state, v_def.to_state, p_actor, p_reason,
          nullif(current_setting('cdf.request_id', true), '')::uuid);

  update case_mgmt.case_record c
     set records_state = v_state.records_state,
         opened_at = case when v_def.to_state = 'INVESTIGATION' and c.opened_at is null then now() else c.opened_at end,
         closed_at = case when v_state.records_state = 'CLOSED' then now()
                          when v_state.records_state = 'ACTIVE' then null else c.closed_at end,
         updated_at = now(), updated_by = p_actor, row_version = c.row_version + 1
   where c.id = p_case_id;

  perform audit.record_event(v_def.audit_action, 'BUSINESS', 'SUCCESS', p_case_id, 'workflow_instance', v_inst.id::text, p_reason,
    jsonb_build_object('transition', v_def.code, 'from', v_def.from_state, 'to', v_def.to_state));
  if v_state.records_state = 'CLOSED' then
    perform audit.record_event('CASE_CLOSED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_record', p_case_id::text, p_reason, '{}'::jsonb);
  elsif v_def.code = 'REOPEN_CASE' then
    perform audit.record_event('CASE_REOPENED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_record', p_case_id::text, p_reason, '{}'::jsonb);
  end if;
end;
$$;

create function api.create_case_from_report(
  p_report_id uuid, p_title text, p_summary text,
  p_classification core.classification_level default 'RESTRICTED', p_is_restricted boolean default false
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_report intake.report;
  v_case_id uuid;
  v_grant_id uuid;
  v_number text;
begin
  if not authz.can_view_report(p_report_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('CASE_CREATE') then perform api._fail('FORBIDDEN'); end if;
  select * into v_report from intake.report r where r.id = p_report_id for update;
  if v_report.status <> 'ACCEPTED' or v_report.case_id is not null then
    perform api._fail('CONFLICT', 'REPORT_NOT_ACCEPTED_FOR_CASE');
  end if;
  if p_classification is null or p_classification < v_report.classification then
    perform api._fail('INVALID', 'classification');  -- never downgrade below the report's classification
  end if;
  if p_classification > authz.current_clearance() then
    perform api._fail('INVALID', 'classification');  -- cannot create above own clearance
  end if;

  -- Every case in this reference implementation is synthetic, so numbers carry the DEMO marker (§2).
  -- PRODUCTION_SUBSTITUTION_REQUIRED: production numbering uses the CDF-CASE prefix.
  v_number := case_mgmt.next_case_number('CDF-DEMO');
  insert into case_mgmt.case_record (
    case_number, case_type, title, summary, classification, is_restricted, source, source_report_id,
    reporter_wb_id, created_by, updated_by
  ) values (
    v_number, 'WHISTLEBLOWING', api._require_text(p_title, 'title', 3, 200), api._require_text(p_summary, 'summary', 10, 4000),
    p_classification, coalesce(p_is_restricted, false), 'PUBLIC_PORTAL', p_report_id, v_report.wb_id, v_actor, v_actor
  ) returning id into v_case_id;

  insert into case_mgmt.allegation (case_id, category, description, created_by)
  values (v_case_id, v_report.category, left(v_report.description, 8000), v_actor);

  insert into case_mgmt.case_access_grant (case_id, user_id, scope, reason, effective_to, granted_by)
  values (v_case_id, v_actor, 'TRIAGE', 'Case opened from triaged report', now() + interval '30 days', v_actor)
  returning id into v_grant_id;

  insert into workflow.workflow_instance (case_id, workflow_code, current_state)
  values (v_case_id, 'CDF_CASE_V1', 'REFERRAL');

  update intake.report set case_id = v_case_id, status = 'CASE_OPENED', status_changed_at = now() where id = p_report_id;

  perform audit.record_event('CASE_CREATED', 'BUSINESS', 'SUCCESS', v_case_id, 'case_record', v_case_id::text, null,
    jsonb_build_object('case_number', v_number, 'source_report_id', p_report_id, 'classification', p_classification,
                       'is_restricted', coalesce(p_is_restricted, false)));
  perform audit.record_event('CASE_ACCESS_GRANTED', 'BUSINESS', 'SUCCESS', v_case_id, 'case_access_grant', v_grant_id::text,
    'Case opened from triaged report', jsonb_build_object('user_id', v_actor, 'scope', 'TRIAGE'));
  perform workflow.apply_transition(v_case_id, 'REGISTER', v_actor, null);
  return v_case_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Case master maintenance
-- -----------------------------------------------------------------------------
create function api.update_case_details(
  p_case_id uuid, p_title text, p_summary text, p_priority text, p_expected_version int
)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_edit_case(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  if v_case.row_version <> p_expected_version then perform api._fail('CONFLICT', 'STALE_VERSION'); end if;
  if p_priority is not null and p_priority not in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') then
    perform api._fail('INVALID', 'priority');
  end if;
  update case_mgmt.case_record
     set title = api._require_text(p_title, 'title', 3, 200),
         summary = api._require_text(p_summary, 'summary', 10, 4000),
         priority = p_priority, updated_at = now(), updated_by = v_actor, row_version = row_version + 1
   where id = p_case_id;
  perform audit.record_event('CASE_UPDATED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_record', p_case_id::text, null,
    jsonb_build_object('fields', jsonb_build_array('title', 'summary', 'priority'),
                       'priority_from', v_case.priority, 'priority_to', p_priority));
  return v_case.row_version + 1;
end;
$$;

create function api.change_case_classification(
  p_case_id uuid, p_classification core.classification_level, p_is_restricted boolean, p_reason text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_reason text;
  v_grant uuid;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('CLASSIFICATION_CHANGE') then perform api._fail('FORBIDDEN'); end if;
  if p_classification is null or p_classification > authz.current_clearance() then perform api._fail('INVALID', 'classification'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  -- Restricting a case removes CASE_VIEW_ALL visibility, so only holders of RESTRICTED_CASE_GRANT may do it.
  if coalesce(p_is_restricted, false) and not v_case.is_restricted and not authz.has_permission('RESTRICTED_CASE_GRANT') then
    perform api._fail('FORBIDDEN');
  end if;
  update case_mgmt.case_record
     set classification = p_classification, is_restricted = coalesce(p_is_restricted, false),
         updated_at = now(), updated_by = v_actor, row_version = row_version + 1
   where id = p_case_id;
  perform audit.record_event('CLASSIFICATION_CHANGED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_record', p_case_id::text, v_reason,
    jsonb_build_object('from', v_case.classification, 'to', p_classification,
                       'restricted_from', v_case.is_restricted, 'restricted_to', coalesce(p_is_restricted, false)));
  -- The restricting officer keeps access through an explicit, audited grant rather than by role.
  if coalesce(p_is_restricted, false) and not v_case.is_restricted
     and not authz.has_active_assignment(p_case_id, v_actor) and not authz.has_active_grant(p_case_id, v_actor) then
    insert into case_mgmt.case_access_grant (case_id, user_id, scope, reason, granted_by)
    values (p_case_id, v_actor, 'CASE', 'Restricted case: restricting officer', v_actor)
    returning id into v_grant;
    perform audit.record_event('CASE_ACCESS_GRANTED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_access_grant', v_grant::text,
      'Restricted case: restricting officer', jsonb_build_object('user_id', v_actor, 'scope', 'CASE'));
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Assignments and access grants (case ACL)
-- -----------------------------------------------------------------------------
create function case_mgmt.assert_assignee_eligible(p_case_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_case case_mgmt.case_record;
  v_user iam.user_profile;
  v_ok boolean;
begin
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id;
  select * into v_user from iam.user_profile u where u.id = p_user_id;
  if v_user.id is null or v_user.status <> 'ACTIVE' then perform api._fail('INVALID', 'user_id'); end if;
  if v_case.classification > v_user.clearance then perform api._fail('CONFLICT', 'ASSIGNEE_CLEARANCE_INSUFFICIENT'); end if;
  if authz.has_conflict(p_case_id, p_user_id) then perform api._fail('CONFLICT', 'ASSIGNEE_HAS_CONFLICT'); end if;
  v_ok := case p_role
    when 'INVESTIGATOR' then authz.user_has_role(p_user_id, 'INVESTIGATOR') or authz.user_has_role(p_user_id, 'LEAD_INVESTIGATOR')
    when 'LEAD_INVESTIGATOR' then authz.user_has_role(p_user_id, 'LEAD_INVESTIGATOR')
    when 'CASE_OWNER' then authz.user_has_role(p_user_id, 'CASE_MANAGER') or authz.user_has_role(p_user_id, 'GRC_DIRECTOR')
    when 'REVIEWER' then authz.user_has_role(p_user_id, 'LEGAL_REVIEWER') or authz.user_has_role(p_user_id, 'HR_REVIEWER')
                         or authz.user_has_role(p_user_id, 'GRC_DIRECTOR') or authz.user_has_role(p_user_id, 'COMPLIANCE')
    else null
  end;
  if v_ok is null then perform api._fail('INVALID', 'assignment_role'); end if;
  if not v_ok then perform api._fail('CONFLICT', 'ASSIGNEE_ROLE_INELIGIBLE'); end if;
end;
$$;

create function api.assign_case(p_case_id uuid, p_user_id uuid, p_assignment_role text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_reason text;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_assign_case(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform case_mgmt.assert_assignee_eligible(p_case_id, p_user_id, p_assignment_role);
  if authz.has_active_assignment(p_case_id, p_user_id, array[p_assignment_role]) then
    perform api._fail('CONFLICT', 'ALREADY_ASSIGNED');
  end if;
  insert into case_mgmt.case_assignment (case_id, user_id, assignment_role, reason, assigned_by)
  values (p_case_id, p_user_id, p_assignment_role, v_reason, v_actor) returning id into v_id;
  if p_assignment_role = 'CASE_OWNER' then
    update case_mgmt.case_record set owner_id = p_user_id, updated_at = now(), updated_by = v_actor, row_version = row_version + 1
     where id = p_case_id;
  end if;
  perform audit.record_event('CASE_ASSIGNED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_assignment', v_id::text, v_reason,
    jsonb_build_object('user_id', p_user_id, 'assignment_role', p_assignment_role));
  return v_id;
end;
$$;

create function case_mgmt.end_assignment_internal(p_assignment_id uuid, p_actor uuid, p_reason text, p_action text)
returns case_mgmt.case_assignment
language plpgsql security definer
set search_path = ''
as $$
declare v case_mgmt.case_assignment;
begin
  update case_mgmt.case_assignment
     set status = 'ENDED', ended_at = now(), ended_by = p_actor, end_reason = p_reason
   where id = p_assignment_id and status = 'ACTIVE'
  returning * into v;
  if v.id is null then perform api._fail('CONFLICT', 'ASSIGNMENT_NOT_ACTIVE'); end if;
  if v.assignment_role = 'CASE_OWNER' then
    update case_mgmt.case_record set owner_id = null, updated_at = now(), updated_by = p_actor, row_version = row_version + 1
     where id = v.case_id and owner_id = v.user_id;
  end if;
  perform audit.record_event(p_action, 'BUSINESS', 'SUCCESS', v.case_id, 'case_assignment', v.id::text, p_reason,
    jsonb_build_object('user_id', v.user_id, 'assignment_role', v.assignment_role));
  return v;
end;
$$;

create function api.end_assignment(p_assignment_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case uuid;
begin
  select a.case_id into v_case from case_mgmt.case_assignment a where a.id = p_assignment_id;
  if v_case is null or not authz.can_view_case(v_case) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_assign_case(v_case) then perform api._fail('FORBIDDEN'); end if;
  perform case_mgmt.end_assignment_internal(p_assignment_id, v_actor, api._require_text(p_reason, 'reason', 5, 2000), 'CASE_UNASSIGNED');
end;
$$;

create function api.reassign_case(p_assignment_id uuid, p_new_user_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_old case_mgmt.case_assignment;
  v_id uuid;
  v_reason text;
begin
  select * into v_old from case_mgmt.case_assignment a where a.id = p_assignment_id;
  if v_old.id is null or not authz.can_view_case(v_old.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_assign_case(v_old.case_id) then perform api._fail('FORBIDDEN'); end if;
  if v_old.status <> 'ACTIVE' then perform api._fail('CONFLICT', 'ASSIGNMENT_NOT_ACTIVE'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform case_mgmt.assert_assignee_eligible(v_old.case_id, p_new_user_id, v_old.assignment_role);
  update case_mgmt.case_assignment
     set status = 'ENDED', ended_at = now(), ended_by = v_actor, end_reason = v_reason
   where id = v_old.id;
  insert into case_mgmt.case_assignment (case_id, user_id, assignment_role, reason, assigned_by)
  values (v_old.case_id, p_new_user_id, v_old.assignment_role, v_reason, v_actor) returning id into v_id;
  if v_old.assignment_role = 'CASE_OWNER' then
    update case_mgmt.case_record set owner_id = p_new_user_id, updated_at = now(), updated_by = v_actor, row_version = row_version + 1
     where id = v_old.case_id;
  end if;
  perform audit.record_event('CASE_REASSIGNED', 'BUSINESS', 'SUCCESS', v_old.case_id, 'case_assignment', v_id::text, v_reason,
    jsonb_build_object('from_user_id', v_old.user_id, 'to_user_id', p_new_user_id, 'assignment_role', v_old.assignment_role,
                       'previous_assignment_id', v_old.id));
  return v_id;
end;
$$;

create function api.grant_case_access(
  p_case_id uuid, p_user_id uuid, p_scope text, p_reason text, p_effective_to timestamptz default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_user iam.user_profile;
  v_id uuid;
  v_reason text;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id;
  if v_case.is_restricted then
    if not authz.has_permission('RESTRICTED_CASE_GRANT') then perform api._fail('FORBIDDEN'); end if;
  elsif not authz.can_assign_case(p_case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  if p_scope not in ('CASE', 'COMMITTEE', 'REVIEW', 'AUDIT') then perform api._fail('INVALID', 'scope'); end if;
  if p_effective_to is not null and p_effective_to <= now() then perform api._fail('INVALID', 'effective_to'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  select * into v_user from iam.user_profile u where u.id = p_user_id;
  if v_user.id is null or v_user.status <> 'ACTIVE' then perform api._fail('INVALID', 'user_id'); end if;
  if v_case.classification > v_user.clearance then perform api._fail('CONFLICT', 'GRANTEE_CLEARANCE_INSUFFICIENT'); end if;
  if authz.has_conflict(p_case_id, p_user_id) then perform api._fail('CONFLICT', 'GRANTEE_HAS_CONFLICT'); end if;
  insert into case_mgmt.case_access_grant (case_id, user_id, scope, reason, effective_to, granted_by)
  values (p_case_id, p_user_id, p_scope, v_reason, p_effective_to, v_actor) returning id into v_id;
  perform audit.record_event('CASE_ACCESS_GRANTED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_access_grant', v_id::text, v_reason,
    jsonb_build_object('user_id', p_user_id, 'scope', p_scope, 'effective_to', p_effective_to));
  return v_id;
end;
$$;

create function api.revoke_case_access(p_grant_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_grant case_mgmt.case_access_grant;
  v_reason text;
begin
  select * into v_grant from case_mgmt.case_access_grant g where g.id = p_grant_id;
  if v_grant.id is null or not authz.can_view_case(v_grant.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not (authz.can_assign_case(v_grant.case_id) or authz.has_permission('RESTRICTED_CASE_GRANT')) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_grant.status <> 'ACTIVE' then perform api._fail('CONFLICT', 'GRANT_NOT_ACTIVE'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update case_mgmt.case_access_grant
     set status = 'REVOKED', revoked_at = now(), revoked_by = v_actor, revocation_reason = v_reason
   where id = p_grant_id;
  perform audit.record_event('CASE_ACCESS_REVOKED', 'BUSINESS', 'SUCCESS', v_grant.case_id, 'case_access_grant', p_grant_id::text,
    v_reason, jsonb_build_object('user_id', v_grant.user_id, 'scope', v_grant.scope));
end;
$$;

-- -----------------------------------------------------------------------------
-- Conflict of interest (§33): a declared conflict removes access immediately.
-- -----------------------------------------------------------------------------
create function api.declare_conflict(p_case_id uuid, p_has_conflict boolean, p_declaration text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_decl text;
  a record;
  g record;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('CONFLICT_DECLARE') then perform api._fail('FORBIDDEN'); end if;
  if p_has_conflict is null then perform api._fail('INVALID', 'has_conflict'); end if;
  v_decl := api._require_text(p_declaration, 'declaration', 5, 2000);

  update case_mgmt.conflict_check set is_current = false where case_id = p_case_id and user_id = v_actor and is_current;
  insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
  values (p_case_id, v_actor, case when p_has_conflict then 'CONFLICT_DECLARED' else 'NO_CONFLICT' end, v_decl)
  returning id into v_id;

  perform audit.record_event('CONFLICT_DECLARED', 'BUSINESS', 'SUCCESS', p_case_id, 'conflict_check', v_id::text, null,
    jsonb_build_object('user_id', v_actor, 'has_conflict', p_has_conflict));

  if p_has_conflict then
    for a in select x.id from case_mgmt.case_assignment x where x.case_id = p_case_id and x.user_id = v_actor and x.status = 'ACTIVE' loop
      perform case_mgmt.end_assignment_internal(a.id, v_actor, 'Conflict of interest declared', 'CASE_UNASSIGNED');
    end loop;
    for g in select x.id from case_mgmt.case_access_grant x where x.case_id = p_case_id and x.user_id = v_actor and x.status = 'ACTIVE' loop
      update case_mgmt.case_access_grant
         set status = 'REVOKED', revoked_at = now(), revoked_by = v_actor, revocation_reason = 'Conflict of interest declared'
       where id = g.id;
      perform audit.record_event('CASE_ACCESS_REVOKED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_access_grant', g.id::text,
        'Conflict of interest declared', jsonb_build_object('user_id', v_actor));
    end loop;
  end if;
  return v_id;
end;
$$;

create function api.decide_conflict(p_conflict_id uuid, p_decision text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_old case_mgmt.conflict_check;
  v_id uuid;
  v_reason text;
begin
  select * into v_old from case_mgmt.conflict_check k where k.id = p_conflict_id;
  if v_old.id is null or not authz.can_view_case(v_old.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('CONFLICT_MANAGE') then perform api._fail('FORBIDDEN'); end if;
  if v_old.user_id = v_actor then perform api._fail('FORBIDDEN'); end if;  -- no self-decision
  if not v_old.is_current or v_old.status <> 'CONFLICT_DECLARED' then perform api._fail('CONFLICT', 'NOTHING_TO_DECIDE'); end if;
  if p_decision not in ('CONFLICT_CONFIRMED', 'CONFLICT_CLEARED') then perform api._fail('INVALID', 'decision'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  update case_mgmt.conflict_check set is_current = false where id = v_old.id;
  insert into case_mgmt.conflict_check (case_id, user_id, status, declaration, decided_by, decided_at, decision_reason)
  values (v_old.case_id, v_old.user_id, p_decision, v_old.declaration, v_actor, now(), v_reason)
  returning id into v_id;
  perform audit.record_event('CONFLICT_DECIDED', 'BUSINESS', 'SUCCESS', v_old.case_id, 'conflict_check', v_id::text, v_reason,
    jsonb_build_object('user_id', v_old.user_id, 'decision', p_decision));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Workflow transitions (§32)
-- -----------------------------------------------------------------------------
create function api.transition_case(p_case_id uuid, p_transition_code text, p_reason text default null)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_inst workflow.workflow_instance;
  v_def workflow.workflow_transition_definition;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  c text;
  v_block text;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_inst from workflow.workflow_instance i where i.case_id = p_case_id for update;
  select * into v_def from workflow.workflow_transition_definition d
   where d.workflow_code = v_inst.workflow_code and d.code = p_transition_code and d.from_state = v_inst.current_state;
  if v_def.code is null or v_def.is_system then perform api._fail('CONFLICT', 'TRANSITION_NOT_AVAILABLE_FROM_STATE'); end if;
  if not v_def.is_enabled then perform api._fail('CONFLICT', 'TRANSITION_NOT_YET_AVAILABLE'); end if;
  if not authz.has_permission(v_def.required_permission) then perform api._fail('FORBIDDEN'); end if;
  if v_def.reason_required and (v_reason is null or length(v_reason) < 10) then perform api._fail('INVALID', 'reason'); end if;
  if v_reason is not null and length(v_reason) > 2000 then perform api._fail('INVALID', 'reason'); end if;
  -- Separation of duties: an assigned investigator cannot approve their own investigation.
  if v_def.approval_required and authz.has_active_assignment(p_case_id, v_actor, array['LEAD_INVESTIGATOR', 'INVESTIGATOR']) then
    perform api._fail('FORBIDDEN');
  end if;
  foreach c in array v_def.required_conditions loop
    v_block := workflow.evaluate_condition(c, p_case_id, v_actor);
    if v_block is not null then perform api._fail('CONFLICT', v_block); end if;
  end loop;
  perform workflow.apply_transition(p_case_id, p_transition_code, v_actor, v_reason);
  return v_def.to_state;
end;
$$;

-- -----------------------------------------------------------------------------
-- Controlled whistleblower identity resolution (§22; ADR-004)
-- -----------------------------------------------------------------------------
create function api.request_identity_reveal(p_case_id uuid, p_justification text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_just text;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_reveal_whistleblower_identity(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  v_just := api._require_text(p_justification, 'justification', 20, 2000);
  if exists (select 1 from protected_identity.reveal_request r
             where r.case_id = p_case_id and r.requested_by = v_actor and r.status in ('PENDING', 'APPROVED')
               and (r.expires_at is null or r.expires_at > now())) then
    perform api._fail('CONFLICT', 'REVEAL_REQUEST_OPEN');
  end if;
  insert into protected_identity.reveal_request (case_id, requested_by, justification)
  values (p_case_id, v_actor, v_just) returning id into v_id;
  perform audit.record_event('IDENTITY_REVEAL_REQUESTED', 'SECURITY', 'SUCCESS', p_case_id, 'reveal_request', v_id::text, v_just, '{}'::jsonb);
  return v_id;
end;
$$;

create function api.decide_identity_reveal(p_request_id uuid, p_approve boolean, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_req protected_identity.reveal_request;
  v_reason text;
begin
  select * into v_req from protected_identity.reveal_request r where r.id = p_request_id for update;
  if v_req.id is null or not authz.can_view_case(v_req.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_reveal_whistleblower_identity(v_req.case_id) then perform api._fail('FORBIDDEN'); end if;
  if v_req.requested_by = v_actor then perform api._fail('FORBIDDEN'); end if;  -- dual control
  if v_req.status <> 'PENDING' then perform api._fail('CONFLICT', 'REVEAL_REQUEST_NOT_PENDING'); end if;
  if p_approve is null then perform api._fail('INVALID', 'approve'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  update protected_identity.reveal_request
     set status = case when p_approve then 'APPROVED' else 'REJECTED' end,
         decided_by = v_actor, decided_at = now(), decision_reason = v_reason,
         expires_at = case when p_approve then now() + interval '24 hours' end
   where id = p_request_id;
  perform audit.record_event(case when p_approve then 'IDENTITY_REVEAL_APPROVED' else 'IDENTITY_REVEAL_REJECTED' end,
    'SECURITY', 'SUCCESS', v_req.case_id, 'reveal_request', p_request_id::text, v_reason,
    jsonb_build_object('requested_by', v_req.requested_by));
end;
$$;

create function api.list_identity_reveal_requests(p_case_id uuid)
returns table (id uuid, requested_by uuid, justification text, status text, requested_at timestamptz,
               decided_by uuid, decided_at timestamptz, expires_at timestamptz, used_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select r.id, r.requested_by, r.justification, r.status, r.requested_at, r.decided_by, r.decided_at, r.expires_at, r.used_at
  from protected_identity.reveal_request r
  where r.case_id = p_case_id and authz.can_reveal_whistleblower_identity(p_case_id)
  order by r.requested_at desc;
$$;

create function api.resolve_reporter_identity(p_case_id uuid, p_justification text)
returns table (wb_id text, full_name text, email text, phone text, preferred_contact text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_req protected_identity.reveal_request;
  v_just text;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_reveal_whistleblower_identity(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  v_just := api._require_text(p_justification, 'justification', 20, 2000);
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id;
  if v_case.reporter_wb_id is null
     or not exists (select 1 from protected_identity.reporter_identity i where i.wb_id = v_case.reporter_wb_id) then
    perform api._fail('CONFLICT', 'NO_IDENTITY_ON_FILE');
  end if;
  if v_case.identity_reveal_requires_approval then
    select * into v_req from protected_identity.reveal_request r
     where r.case_id = p_case_id and r.requested_by = v_actor and r.status = 'APPROVED' and r.expires_at > now()
     order by r.decided_at desc limit 1 for update;
    if v_req.id is null then perform api._fail('CONFLICT', 'APPROVED_REVEAL_REQUEST_REQUIRED'); end if;
    update protected_identity.reveal_request set status = 'USED', used_at = now() where id = v_req.id;
  end if;
  -- Audit first; identity values are never written to the ledger.
  perform audit.record_event('REPORTER_IDENTITY_REVEALED', 'SECURITY', 'SUCCESS', p_case_id, 'reporter_identity',
    v_case.reporter_wb_id, v_just, jsonb_build_object('reveal_request_id', v_req.id));
  return query
    select i.wb_id, i.full_name, i.email, i.phone, i.preferred_contact
    from protected_identity.reporter_identity i where i.wb_id = v_case.reporter_wb_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Administration (§21: administration never implies case content)
-- -----------------------------------------------------------------------------
create function api.grant_role(p_user_id uuid, p_role_code text, p_justification text, p_effective_to date default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_just text;
begin
  if not authz.has_permission('ROLE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_user_id = v_actor then perform api._fail('FORBIDDEN'); end if;  -- no self-elevation (threat T06)
  if not exists (select 1 from iam.user_profile u where u.id = p_user_id and u.status = 'ACTIVE') then perform api._fail('INVALID', 'user_id'); end if;
  if not exists (select 1 from iam.role r where r.code = p_role_code) then perform api._fail('INVALID', 'role_code'); end if;
  v_just := api._require_text(p_justification, 'justification', 10, 2000);
  insert into iam.user_role_assignment (user_id, role_code, justification, effective_to, granted_by)
  values (p_user_id, p_role_code, v_just, p_effective_to, v_actor) returning id into v_id;
  perform audit.record_event('ROLE_GRANTED', 'ADMIN', 'SUCCESS', null, 'user_role_assignment', v_id::text, v_just,
    jsonb_build_object('user_id', p_user_id, 'role', p_role_code, 'effective_to', p_effective_to));
  return v_id;
exception when unique_violation then
  perform api._fail('CONFLICT', 'ROLE_ALREADY_ACTIVE');
  return null;
end;
$$;

create function api.revoke_role(p_assignment_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_row iam.user_role_assignment;
  v_reason text;
begin
  if not authz.has_permission('ROLE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  select * into v_row from iam.user_role_assignment a where a.id = p_assignment_id;
  if v_row.id is null then perform api._fail('NOT_FOUND'); end if;
  if v_row.user_id = v_actor then perform api._fail('FORBIDDEN'); end if;
  if v_row.status <> 'ACTIVE' then perform api._fail('CONFLICT', 'ROLE_NOT_ACTIVE'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  update iam.user_role_assignment
     set status = 'REVOKED', revoked_at = now(), revoked_by = v_actor, revocation_reason = v_reason
   where id = p_assignment_id;
  perform audit.record_event('ROLE_REVOKED', 'ADMIN', 'SUCCESS', null, 'user_role_assignment', p_assignment_id::text, v_reason,
    jsonb_build_object('user_id', v_row.user_id, 'role', v_row.role_code));
end;
$$;

create function api.set_user_status(p_user_id uuid, p_status core.record_status, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_old core.record_status;
  v_reason text;
begin
  if not authz.has_permission('USER_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_user_id = v_actor then perform api._fail('FORBIDDEN'); end if;
  select u.status into v_old from iam.user_profile u where u.id = p_user_id for update;
  if v_old is null then perform api._fail('NOT_FOUND'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  update iam.user_profile set status = p_status, updated_at = now() where id = p_user_id;
  perform audit.record_event('ADMIN_ACTION', 'ADMIN', 'SUCCESS', null, 'user_profile', p_user_id::text, v_reason,
    jsonb_build_object('operation', 'SET_USER_STATUS', 'from', v_old, 'to', p_status));
end;
$$;

create function api.verify_audit_chain()
returns table (broken_seq bigint, expected_hash text, stored_hash text)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not (authz.has_permission('AUDIT_VIEW') or authz.has_permission('SECURITY_EVENT_VIEW')) then
    perform api._fail('FORBIDDEN');
  end if;
  return query select * from audit.verify_chain();
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants: only these entry points are callable by the investigation app.
-- -----------------------------------------------------------------------------
grant execute on function
  api.open_case(uuid),
  api.open_report(uuid),
  api.record_security_event(text, text, text, jsonb),
  api.triage_report(uuid, text, text, text, uuid),
  api.reply_to_reporter(uuid, text),
  api.create_case_from_report(uuid, text, text, core.classification_level, boolean),
  api.update_case_details(uuid, text, text, text, int),
  api.change_case_classification(uuid, core.classification_level, boolean, text),
  api.assign_case(uuid, uuid, text, text),
  api.end_assignment(uuid, text),
  api.reassign_case(uuid, uuid, text),
  api.grant_case_access(uuid, uuid, text, text, timestamptz),
  api.revoke_case_access(uuid, text),
  api.declare_conflict(uuid, boolean, text),
  api.decide_conflict(uuid, text, text),
  api.transition_case(uuid, text, text),
  api.request_identity_reveal(uuid, text),
  api.decide_identity_reveal(uuid, boolean, text),
  api.list_identity_reveal_requests(uuid),
  api.resolve_reporter_identity(uuid, text),
  api.grant_role(uuid, text, text, date),
  api.revoke_role(uuid, text),
  api.set_user_status(uuid, core.record_status, text),
  api.verify_audit_chain()
to authenticated;
