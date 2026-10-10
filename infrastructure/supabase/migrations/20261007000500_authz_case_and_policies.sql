-- =============================================================================
-- 0500 Central case authorization functions (§19) and RLS policies (§18)
-- RBAC + ABAC (clearance, restricted flag) + case ACL (assignment/grant) + conflict override.
-- TypeScript mirror: packages/authorization (kept in lockstep by tests).
-- =============================================================================

create function authz.has_conflict(p_case_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from case_mgmt.conflict_check k
    where k.case_id = p_case_id and k.user_id = p_user_id and k.is_current
      and k.status in ('CONFLICT_DECLARED', 'CONFLICT_CONFIRMED')
  );
$$;

create function authz.has_active_assignment(p_case_id uuid, p_user_id uuid, p_roles text[] default null)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from case_mgmt.case_assignment a
    where a.case_id = p_case_id and a.user_id = p_user_id and a.status = 'ACTIVE'
      and (p_roles is null or a.assignment_role = any (p_roles))
  );
$$;

create function authz.has_active_grant(p_case_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from case_mgmt.case_access_grant g
    where g.case_id = p_case_id and g.user_id = p_user_id and g.status = 'ACTIVE'
      and g.effective_from <= now() and (g.effective_to is null or g.effective_to > now())
  );
$$;

-- Evaluates access for any active user (used by command functions for eligibility checks).
create function authz.user_can_view_case(p_user_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from case_mgmt.case_record c
    join iam.user_profile u on u.id = p_user_id and u.status = 'ACTIVE'
    where c.id = p_case_id
      and c.classification <= u.clearance
      and not authz.has_conflict(c.id, u.id)
      and (
        (not c.is_restricted and authz.user_has_permission(u.id, 'CASE_VIEW_ALL'))
        or authz.has_active_assignment(c.id, u.id)
        or authz.has_active_grant(c.id, u.id)
      )
  );
$$;

create function authz.can_view_case(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null
     and authz.user_can_view_case(authz.current_user_id(), p_case_id);
$$;

create function authz.can_edit_case(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id)
     and (authz.has_permission('CASE_EDIT_ALL')
          or authz.has_active_assignment(p_case_id, authz.current_user_id(), array['CASE_OWNER', 'LEAD_INVESTIGATOR']));
$$;

create function authz.can_assign_case(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id)
     and authz.has_permission('CASE_ASSIGN')
     and (authz.has_permission('CASE_VIEW_ALL')
          or authz.has_permission('RESTRICTED_CASE_GRANT')
          or authz.has_active_assignment(p_case_id, authz.current_user_id(), array['CASE_OWNER', 'LEAD_INVESTIGATOR']));
$$;

create function authz.can_reveal_whistleblower_identity(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id) and authz.has_permission('REPORTER_IDENTITY_REVEAL');
$$;

create function authz.can_view_report(p_report_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from intake.report r
    where r.id = p_report_id
      and authz.current_user_id() is not null
      and (
        (r.case_id is null and authz.has_permission('INTAKE_VIEW') and r.classification <= authz.current_clearance())
        or (r.case_id is not null and authz.can_view_case(r.case_id))
      )
  );
$$;

grant execute on function
  authz.can_view_case(uuid), authz.can_edit_case(uuid), authz.can_assign_case(uuid),
  authz.can_reveal_whistleblower_identity(uuid), authz.can_view_report(uuid)
to authenticated;

-- -----------------------------------------------------------------------------
-- Policies (SELECT only; no write grants exist for application roles)
-- -----------------------------------------------------------------------------
create policy report_read on intake.report for select to authenticated using (authz.can_view_report(id));
-- secret_hmac is never readable by application roles.
grant select (id, report_ref, wb_id, channel, reporter_mode, category, subject_description, description,
              incident_date, location, language, classification, status, case_id, received_at, status_changed_at)
  on intake.report to authenticated;

create policy report_message_read on intake.report_message for select to authenticated using (authz.can_view_report(report_id));
grant select on intake.report_message to authenticated;

create policy report_triage_read on intake.report_triage for select to authenticated using (authz.can_view_report(report_id));
grant select on intake.report_triage to authenticated;

create policy case_record_read on case_mgmt.case_record for select to authenticated using (authz.can_view_case(id));
grant select on case_mgmt.case_record to authenticated;

create policy person_read on case_mgmt.person for select to authenticated using (
  exists (select 1 from case_mgmt.case_person cp where cp.person_id = person.id and authz.can_view_case(cp.case_id)));
grant select on case_mgmt.person to authenticated;

create policy case_person_read on case_mgmt.case_person for select to authenticated using (authz.can_view_case(case_id));
grant select on case_mgmt.case_person to authenticated;

create policy allegation_read on case_mgmt.allegation for select to authenticated using (authz.can_view_case(case_id));
grant select on case_mgmt.allegation to authenticated;

create policy case_assignment_read on case_mgmt.case_assignment for select to authenticated using (authz.can_view_case(case_id));
grant select on case_mgmt.case_assignment to authenticated;

create policy case_access_grant_read on case_mgmt.case_access_grant for select to authenticated using (authz.can_view_case(case_id));
grant select on case_mgmt.case_access_grant to authenticated;

create policy conflict_check_read on case_mgmt.conflict_check for select to authenticated using (
  user_id = authz.current_user_id() or (authz.can_view_case(case_id) and authz.has_permission('CONFLICT_MANAGE')));
grant select on case_mgmt.conflict_check to authenticated;

create policy workflow_definition_read on workflow.workflow_definition for select to authenticated using (authz.current_user_id() is not null);
create policy workflow_state_read on workflow.workflow_state for select to authenticated using (authz.current_user_id() is not null);
create policy workflow_transition_definition_read on workflow.workflow_transition_definition for select to authenticated using (authz.current_user_id() is not null);
grant select on workflow.workflow_definition, workflow.workflow_state, workflow.workflow_transition_definition to authenticated;

create policy workflow_instance_read on workflow.workflow_instance for select to authenticated using (authz.can_view_case(case_id));
create policy workflow_transition_event_read on workflow.workflow_transition_event for select to authenticated using (authz.can_view_case(case_id));
grant select on workflow.workflow_instance, workflow.workflow_transition_event to authenticated;

create policy setting_read on config.setting for select to authenticated using (authz.current_user_id() is not null);
grant select on config.setting to authenticated;

-- Case teams see the business history of cases they can view (CDFAuditTimeline).
create policy audit_case_team_read on audit.audit_event for select to authenticated
  using (category = 'BUSINESS' and case_id is not null and authz.can_view_case(case_id));

-- case_number_counter and protected_identity.reporter_identity: no policies, no grants.

-- -----------------------------------------------------------------------------
-- Read model for case lists and headers (§16). security_invoker => caller's RLS applies.
-- -----------------------------------------------------------------------------
create view case_mgmt.case_overview
with (security_invoker = true) as
select
  c.id, c.case_number, c.case_type, c.title, c.summary, c.classification, c.is_restricted, c.source,
  c.source_report_id, c.reporter_wb_id, c.priority, c.owner_id, c.retention_class, c.legal_hold_status,
  c.records_state, c.created_at, c.opened_at, c.closed_at, c.updated_at, c.row_version,
  wi.current_state, ws.name_en as state_name_en, ws.name_ar as state_name_ar, ws.sequence as state_sequence,
  wi.entered_state_at, wi.state_due_at,
  (select a.user_id from case_mgmt.case_assignment a
     where a.case_id = c.id and a.status = 'ACTIVE' and a.assignment_role in ('LEAD_INVESTIGATOR', 'INVESTIGATOR')
     order by (a.assignment_role = 'LEAD_INVESTIGATOR') desc, a.assigned_at limit 1) as assigned_investigator_id
from case_mgmt.case_record c
left join workflow.workflow_instance wi on wi.case_id = c.id
left join workflow.workflow_state ws on ws.workflow_code = wi.workflow_code and ws.code = wi.current_state;

grant select on case_mgmt.case_overview to authenticated;
