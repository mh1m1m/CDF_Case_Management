-- =============================================================================
-- 1810 Restricted-case authority at creation (UX-003 CRITICAL; DEC-01 approved 2026-10-11; ADR-016 D1)
--
-- Before: a case opened from a triaged report could be marked restricted, but nobody with authority over
-- restricted cases was named. Restricted cases are invisible to CASE_VIEW_ALL, so only the creator's 30-day
-- TRIAGE grant could see the case: it was orphaned at triage.
--
-- After: restricted handling names an eligible restricted-case authority at creation, and one transaction
--   1. creates the case with is_restricted = true,
--   2. assigns the authority as the initial accountable owner (CASE_OWNER assignment + owner_id), which is the
--      minimum access basis the owner needs; no case_access_grant row is written for anyone,
--   3. hands the case over: the initiator keeps no grant (DEC-03: no residual TRIAGE grant after a formal
--      hand-over to a legitimate receiving owner), unless the initiator is the chosen authority,
--   4. audits CASE_CREATED, CASE_ASSIGNED and CASE_HANDED_OVER in the same transaction.
-- If no eligible authority is named, or the named user is not eligible, nothing is written (no orphan).
-- Classification still stops at the initiator's clearance.
--
-- Eligibility (authz.is_restricted_case_authority): an ACTIVE user who holds the new permission
-- RESTRICTED_CASE_AUTHORITY, may own a case (CASE_MANAGER or GRC_DIRECTOR, as case_mgmt.assert_assignee_eligible
-- requires for CASE_OWNER) and whose clearance covers the case classification. GRC_DIRECTOR holds it.
--
-- Non-restricted creation is unchanged here; DEC-03 for ordinary cases lands with grant scope (S3).
-- No policy changes: RLS is untouched and the new rows are written only by this command.
-- =============================================================================

insert into iam.permission (code, description) values
  ('RESTRICTED_CASE_AUTHORITY', 'Act as the accountable authority for a restricted case');

insert into iam.role_permission (role_code, permission_code) values
  ('GRC_DIRECTOR', 'RESTRICTED_CASE_AUTHORITY');

-- Eligibility of a named authority for a case at the given classification. Internal: not granted to any
-- application role; callers are the two api functions below.
create function authz.is_restricted_case_authority(p_user_id uuid, p_classification core.classification_level)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from iam.user_profile u
    where u.id = p_user_id
      and u.status = 'ACTIVE'
      and p_classification is not null
      and u.clearance >= p_classification
      and authz.user_has_permission(u.id, 'RESTRICTED_CASE_AUTHORITY')
      and (authz.user_has_role(u.id, 'CASE_MANAGER') or authz.user_has_role(u.id, 'GRC_DIRECTOR'))
  );
$$;

-- Eligible authorities for a report the caller may turn into a case, at a classification the caller may set.
-- Returns names only (no email, department or clearance) so the choice can be made without exposing more of
-- the directory than the decision needs. Read-only; opening the report is audited by api.open_report.
create function api.list_restricted_case_authorities(p_report_id uuid, p_classification core.classification_level)
returns table (user_id uuid, display_name text, display_name_ar text)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform api._actor();
  if not authz.can_view_report(p_report_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('CASE_CREATE') then perform api._fail('FORBIDDEN'); end if;
  if p_classification is null or p_classification > authz.current_clearance() then
    perform api._fail('INVALID', 'classification');
  end if;
  return query
    select u.id, u.display_name, u.display_name_ar
    from iam.user_profile u
    where authz.is_restricted_case_authority(u.id, p_classification)
    order by u.display_name, u.id;
end;
$$;

-- Only one overload may remain: the old five-argument signature goes, and every caller passes the new one.
drop function api.create_case_from_report(uuid, text, text, core.classification_level, boolean);

create function api.create_case_from_report(
  p_report_id uuid, p_title text, p_summary text,
  p_classification core.classification_level default 'RESTRICTED', p_is_restricted boolean default false,
  p_restricted_authority_id uuid default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_restricted boolean := coalesce(p_is_restricted, false);
  v_report intake.report;
  v_case_id uuid;
  v_grant_id uuid;
  v_assignment_id uuid;
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
  -- A restricted case needs a named, eligible authority; an unknown, inactive or ineligible user gets the
  -- same answer, so the field cannot be used to probe the directory. An authority only applies to restricted.
  if v_restricted then
    if p_restricted_authority_id is null
       or not authz.is_restricted_case_authority(p_restricted_authority_id, p_classification) then
      perform api._fail('INVALID', 'restricted_authority_id');
    end if;
  elsif p_restricted_authority_id is not null then
    perform api._fail('INVALID', 'restricted_authority_id');
  end if;

  -- Every case in this reference implementation is synthetic, so numbers carry the DEMO marker (§2).
  -- PRODUCTION_SUBSTITUTION_REQUIRED: production numbering uses the CDF-CASE prefix.
  v_number := case_mgmt.next_case_number('CDF-DEMO');
  insert into case_mgmt.case_record (
    case_number, case_type, title, summary, classification, is_restricted, source, source_report_id,
    reporter_wb_id, owner_id, created_by, updated_by
  ) values (
    v_number, 'WHISTLEBLOWING', api._require_text(p_title, 'title', 3, 200), api._require_text(p_summary, 'summary', 10, 4000),
    p_classification, v_restricted, 'PUBLIC_PORTAL', p_report_id, v_report.wb_id,
    case when v_restricted then p_restricted_authority_id end, v_actor, v_actor
  ) returning id into v_case_id;

  insert into case_mgmt.allegation (case_id, category, description, created_by)
  values (v_case_id, v_report.category, left(v_report.description, 8000), v_actor);

  if v_restricted then
    -- Defence in depth: the same owner rule every assignment passes (clearance, conflict, role).
    perform case_mgmt.assert_assignee_eligible(v_case_id, p_restricted_authority_id, 'CASE_OWNER');
    insert into case_mgmt.case_assignment (case_id, user_id, assignment_role, reason, assigned_by)
    values (v_case_id, p_restricted_authority_id, 'CASE_OWNER',
            'Restricted case: accountable authority named at creation', v_actor)
    returning id into v_assignment_id;
  else
    insert into case_mgmt.case_access_grant (case_id, user_id, scope, reason, effective_to, granted_by)
    values (v_case_id, v_actor, 'TRIAGE', 'Case opened from triaged report', now() + interval '30 days', v_actor)
    returning id into v_grant_id;
  end if;

  insert into workflow.workflow_instance (case_id, workflow_code, current_state)
  values (v_case_id, 'CDF_CASE_V1', 'REFERRAL');

  update intake.report set case_id = v_case_id, status = 'CASE_OPENED', status_changed_at = now() where id = p_report_id;

  perform audit.record_event('CASE_CREATED', 'BUSINESS', 'SUCCESS', v_case_id, 'case_record', v_case_id::text, null,
    jsonb_build_object('case_number', v_number, 'source_report_id', p_report_id, 'classification', p_classification,
                       'is_restricted', v_restricted));
  if v_restricted then
    perform audit.record_event('CASE_ASSIGNED', 'BUSINESS', 'SUCCESS', v_case_id, 'case_assignment', v_assignment_id::text,
      'Restricted case: accountable authority named at creation',
      jsonb_build_object('user_id', p_restricted_authority_id, 'assignment_role', 'CASE_OWNER'));
    perform audit.record_event('CASE_HANDED_OVER', 'BUSINESS', 'SUCCESS', v_case_id, 'case_assignment', v_assignment_id::text,
      'Restricted case handed to its accountable authority at creation',
      jsonb_build_object('from_user_id', v_actor, 'to_user_id', p_restricted_authority_id, 'basis', 'RESTRICTED_AT_CREATION',
                         'initiator_access', case when p_restricted_authority_id = v_actor then 'OWNER' else 'NONE' end));
  else
    perform audit.record_event('CASE_ACCESS_GRANTED', 'BUSINESS', 'SUCCESS', v_case_id, 'case_access_grant', v_grant_id::text,
      'Case opened from triaged report', jsonb_build_object('user_id', v_actor, 'scope', 'TRIAGE'));
  end if;
  perform workflow.apply_transition(v_case_id, 'REGISTER', v_actor, null);
  return v_case_id;
end;
$$;

grant execute on function
  api.create_case_from_report(uuid, text, text, core.classification_level, boolean, uuid),
  api.list_restricted_case_authorities(uuid, core.classification_level)
to authenticated;
