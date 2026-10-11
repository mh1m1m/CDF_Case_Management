-- =============================================================================
-- 1820 S1 read models: my areas, my work, my access (UX redesign S1; ADR-016 D0; audit RC-06, RC-08, RC-12)
--
-- Three read-only functions for the authenticated shell. They add no access:
--   * api.my_work_items(): the caller's work, derived from rows the caller can already act on. Every row
--     re-applies the authz.* predicate of the command it leads to, so a row never exists for a case, report,
--     form or interview the caller cannot reach. A row carries an item type, a target id, the case number only
--     when the caller may see the case's metadata, a due date with its source, and when it started. Never a
--     title, category, name or narrative (DEC-22 decides any further fields).
--   * api.my_areas(): the sidebar. An area appears when the caller holds its permission AND a live
--     relationship (assignment, grant within scope, task, or an item there), never from a role name. Counts are
--     the caller's own "needs my action" rows in that area; Oversight and Administration never carry a count.
--   * api.my_access(): the caller's own access basis and expiry (roles, clearance, assignments, grants, tasks,
--     break-glass). Nobody else's, and nothing from the identity vault.
--
-- Not yet included, by decision: break-glass and identity-reveal items wait for their screens and the security
-- review in DEC-16; the Committee area waits for S5 (until then a committee grant shows the Cases area);
-- Reporting waits for S6; "Done recently" and pools for S4.
-- Due dates from the workflow are labelled WORKFLOW_SLA_PROVISIONAL until an approved SLA source (DEC-43).
-- Hand-over for the TRIAGE grant's Cases item is computed from the workflow state for display only (before
-- JURISDICTION); the grant itself is unchanged until grant scope lands at S3 (ADR-016 D3). Not enforcement.
-- No table, policy or grant changes beyond EXECUTE to authenticated.
-- =============================================================================

create function api.my_work_items()
returns table (
  area text,             -- MY_WORK, INTAKE, CASES or RECORDS: where the item's target lives
  view text,             -- NEEDS_ACTION, MY_CASES, DUE_SOON or WAITING
  category text,         -- the item type; the page renders a fixed template for it
  target_type text,      -- REPORT, CASE, CONFLICT, FORM_INSTANCE, INTERVIEW, CASE_TASK, HOLD_REQUEST, HOLD_RELEASE
  target_id uuid,
  case_id uuid,
  case_number text,      -- only when the caller may see the case's metadata
  due_at timestamptz,
  due_source text,       -- TASK, SCHEDULE or WORKFLOW_SLA_PROVISIONAL; null when there is no due date
  since_at timestamptz
)
language sql stable security definer
set search_path = ''
as $$
  with me as (select authz.current_user_id() as id),
  my_cases as (
    -- Active assignments on cases the caller can open (assignment alone is not enough: clearance, conflict).
    select a.case_id, a.assignment_role, a.assigned_at
      from case_mgmt.case_assignment a, me
     where a.user_id = me.id and a.status = 'ACTIVE' and authz.can_view_case(a.case_id)
  ),
  items as (
    -- Intake: new reports to screen.
    select 'INTAKE'::text as area, 'NEEDS_ACTION'::text as view, 'NEW_REPORT'::text as category,
           'REPORT'::text as target_type, r.id as target_id, null::uuid as case_id,
           null::timestamptz as due_at, null::text as due_source, r.received_at as since_at
      from intake.report r
     where r.status = 'RECEIVED' and r.case_id is null and authz.can_view_report(r.id)

    union all
    -- Intake: accepted reports waiting for their case.
    select 'INTAKE', 'NEEDS_ACTION', 'CASE_TO_OPEN', 'REPORT', r.id, null, null, null, r.status_changed_at
      from intake.report r
     where r.status = 'ACCEPTED' and r.case_id is null
       and authz.can_view_report(r.id) and authz.has_permission('CASE_CREATE')

    union all
    -- The reporter wrote last, and the caller may answer (today's rule; DEC-06 moves ownership at S2).
    select case when r.case_id is null then 'INTAKE' else 'CASES' end, 'NEEDS_ACTION', 'REPORTER_REPLIED',
           'REPORT', r.id, r.case_id, null, null, m.created_at
      from intake.report r
      join lateral (select x.direction, x.created_at from intake.report_message x
                     where x.report_id = r.id order by x.created_at desc, x.id desc limit 1) m on true
     where m.direction = 'FROM_REPORTER'
       and r.status not in ('REFERRED_OUT', 'CLOSED_NO_ACTION', 'DUPLICATE')
       and authz.can_view_report(r.id) and authz.has_permission('REPORT_MESSAGE_REPLY')

    union all
    -- My cases (the "My cases" view; not counted as needing action).
    select 'CASES', 'MY_CASES', 'MY_CASE', 'CASE', c.case_id, c.case_id, null, null, c.assigned_at
      from (select distinct on (case_id) case_id, assigned_at from my_cases order by case_id, assigned_at) c

    union all
    -- Declare conflict status on a case I am assigned to.
    select 'CASES', 'NEEDS_ACTION', 'DECLARE_CONFLICT', 'CASE', c.case_id, c.case_id, null, null, min(c.assigned_at)
      from my_cases c, me
     where authz.has_permission('CONFLICT_DECLARE')
       and not exists (select 1 from case_mgmt.conflict_check k
                        where k.case_id = c.case_id and k.user_id = me.id and k.is_current)
     group by c.case_id

    union all
    -- Someone else's declared conflict, for a conflict manager who can see the case.
    select 'CASES', 'NEEDS_ACTION', 'CONFLICT_TO_DECIDE', 'CONFLICT', k.id, k.case_id, null, null, k.declared_at
      from case_mgmt.conflict_check k, me
     where k.is_current and k.status = 'CONFLICT_DECLARED' and k.user_id <> me.id
       and authz.has_permission('CONFLICT_MANAGE') and authz.can_view_case(k.case_id)

    union all
    -- An active case before findings with no investigator, for someone who may assign it.
    select 'CASES', 'NEEDS_ACTION', 'UNASSIGNED_CASE', 'CASE', c.id, c.id, null, null, w.entered_state_at
      from case_mgmt.case_record c
      join workflow.workflow_instance w on w.case_id = c.id
      join workflow.workflow_state s on s.workflow_code = w.workflow_code and s.code = w.current_state
     where c.records_state = 'ACTIVE' and s.sequence < 90
       and not exists (select 1 from case_mgmt.case_assignment a
                        where a.case_id = c.id and a.status = 'ACTIVE'
                          and a.assignment_role in ('LEAD_INVESTIGATOR', 'INVESTIGATOR'))
       and authz.can_assign_case(c.id)

    union all
    -- A case I own or lead is due or overdue at its current stage (provisional SLA, display only).
    select 'CASES', 'DUE_SOON', 'CASE_STAGE_DUE', 'CASE', w.case_id, w.case_id, w.state_due_at,
           'WORKFLOW_SLA_PROVISIONAL', w.entered_state_at
      from workflow.workflow_instance w
     where w.state_due_at is not null and w.state_due_at < now() + interval '3 days'
       and exists (select 1 from my_cases c
                    where c.case_id = w.case_id and c.assignment_role in ('CASE_OWNER', 'LEAD_INVESTIGATOR'))

    union all
    -- Forms waiting for my review or approval, never my own work (separation of duties, as the commands check).
    select case when authz.can_view_case(i.case_id) then 'CASES' else 'MY_WORK' end, 'NEEDS_ACTION',
           'FORM_TO_REVIEW', 'FORM_INSTANCE', i.id, i.case_id, null, null, i.prepared_at
      from forms.form_instance i, me
     where i.status = 'PREPARED' and i.prepared_by is distinct from me.id and authz.can_review_form(i.id)

    union all
    select case when authz.can_view_case(i.case_id) then 'CASES' else 'MY_WORK' end, 'NEEDS_ACTION',
           'FORM_TO_APPROVE', 'FORM_INSTANCE', i.id, i.case_id, null, null, i.reviewed_at
      from forms.form_instance i, me
     where i.status = 'REVIEWED' and me.id is distinct from i.prepared_by and me.id is distinct from i.reviewed_by
       and authz.can_approve_form(i.id)

    union all
    -- A form returned to draft after I prepared it, which I may still prepare.
    select case when authz.can_view_case(i.case_id) then 'CASES' else 'MY_WORK' end, 'NEEDS_ACTION',
           'FORM_RETURNED', 'FORM_INSTANCE', i.id, i.case_id, null, null, ret.occurred_at
      from forms.form_instance i, me,
           lateral (select e.occurred_at, e.from_status from forms.form_event e
                     where e.instance_id = i.id order by e.seq desc limit 1) ret
     where i.status = 'DRAFT' and ret.from_status in ('PREPARED', 'REVIEWED')
       and (select e.actor_id from forms.form_event e
             where e.instance_id = i.id and e.to_status = 'PREPARED' order by e.seq desc limit 1) = me.id
       and authz.can_prepare_form(i.case_id, i.form_code)

    union all
    -- Interviews waiting for my review or approval (same rules as api.transition_interview).
    select 'CASES', 'NEEDS_ACTION', 'INTERVIEW_TO_REVIEW', 'INTERVIEW', v.id, v.case_id, null, null, v.prepared_at
      from case_mgmt.interview v, me
     where v.status = 'PREPARED' and v.prepared_by is distinct from me.id
       and authz.can_view_interview(v.id) and authz.can_review_interviews(v.case_id)

    union all
    select 'CASES', 'NEEDS_ACTION', 'INTERVIEW_TO_APPROVE', 'INTERVIEW', v.id, v.case_id, null, null, v.reviewed_at
      from case_mgmt.interview v, me
     where v.status = 'REVIEWED' and me.id is distinct from v.prepared_by and me.id is distinct from v.reviewed_by
       and authz.can_view_interview(v.id) and authz.can_approve_interviews(v.case_id)

    union all
    -- Interviews I sit on in the next seven days.
    select 'CASES', 'DUE_SOON', 'INTERVIEW_SOON', 'INTERVIEW', v.id, v.case_id, v.scheduled_start, 'SCHEDULE',
           v.updated_at
      from case_mgmt.interview v, me
     where v.status = 'SCHEDULED' and v.scheduled_start between now() and now() + interval '7 days'
       and exists (select 1 from case_mgmt.interview_participant p where p.interview_id = v.id and p.user_id = me.id)
       and authz.can_view_interview(v.id)

    union all
    -- My open purpose-bound tasks (records and legal work).
    select 'RECORDS', 'NEEDS_ACTION', 'TASK_' || t.task_type, 'CASE_TASK', t.id, t.case_id,
           t.due_date::timestamptz, case when t.due_date is null then null else 'TASK' end, t.created_at
      from case_mgmt.case_task t, me
     where t.assigned_user_id = me.id and t.status in ('OPEN', 'IN_PROGRESS')
       and t.access_granted_at <= now() and t.expires_at > now()
       and authz.user_has_role(me.id, t.assigned_role)

    union all
    -- Legal-hold requests waiting to be routed to a reviewer.
    select 'RECORDS', 'NEEDS_ACTION', 'HOLD_REQUEST_TO_ROUTE', 'HOLD_REQUEST', q.id, q.case_id, null, null, q.requested_at
      from records.legal_hold_request q
     where q.status = 'SUBMITTED' and authz.has_permission('CASE_TASK_ASSIGN') and authz.can_view_case(q.case_id)

    union all
    -- Legal-hold releases waiting for a decision by someone other than the requester.
    select 'RECORDS', 'NEEDS_ACTION', 'HOLD_RELEASE_TO_DECIDE', 'HOLD_RELEASE', x.id, h.case_id, null, null, x.requested_at
      from records.legal_hold_release x
      join records.legal_hold h on h.id = x.hold_id, me
     where x.status = 'PENDING' and x.requested_by <> me.id
       and records._visible(h.case_id) and authz.can_release_legal_hold(h.case_id)

    union all
    -- My own requests, waiting on someone else.
    select 'MY_WORK', 'WAITING', 'MY_HOLD_REQUEST', 'HOLD_REQUEST', q.id, q.case_id, null, null, q.requested_at
      from records.legal_hold_request q, me
     where q.requested_by = me.id and q.status in ('SUBMITTED', 'ASSIGNED')

    union all
    select 'MY_WORK', 'WAITING', 'MY_HOLD_RELEASE_REQUEST', 'HOLD_RELEASE', x.id, h.case_id, null, null, x.requested_at
      from records.legal_hold_release x
      join records.legal_hold h on h.id = x.hold_id, me
     where x.requested_by = me.id and x.status = 'PENDING'
  )
  select i.area, i.view, i.category, i.target_type, i.target_id, i.case_id,
         case when i.case_id is not null and authz.can_view_case_metadata(i.case_id) then c.case_number end,
         i.due_at, i.due_source, i.since_at
    from items i
    left join case_mgmt.case_record c on c.id = i.case_id
   where authz.current_user_id() is not null
   order by (i.due_at is null), i.due_at, i.since_at, i.target_id;
$$;

-- The sidebar. The order is fixed by the shell; this returns only the areas the caller has now.
create function api.my_areas()
returns table (area_code text, actionable_count int, default_view text)
language sql stable security definer
set search_path = ''
as $$
  with me as (
    select u.id from iam.user_profile u where u.id = authz.current_user_id() and u.status = 'ACTIVE'
  ),
  work as (select w.area, w.view from api.my_work_items() w),
  live as (
    select
      exists (select 1 from case_mgmt.case_assignment a, me
               where a.user_id = me.id and a.status = 'ACTIVE' and authz.can_view_case(a.case_id)) as assigned,
      -- Any non-TRIAGE grant the caller can use today. COMMITTEE, REVIEW and AUDIT grants count until their own
      -- areas arrive (Committee S5) and grant scope is enforced (S3, DEC-02); the sidebar must not hide a case
      -- the caller can reach now.
      exists (select 1 from case_mgmt.case_access_grant g, me
               where g.user_id = me.id and g.status = 'ACTIVE' and g.scope <> 'TRIAGE'
                 and g.effective_from <= now() and (g.effective_to is null or g.effective_to > now())
                 and authz.can_view_case(g.case_id)) as case_grant,
      exists (select 1 from case_mgmt.case_access_grant g
                join workflow.workflow_instance w on w.case_id = g.case_id
                join workflow.workflow_state s on s.workflow_code = w.workflow_code and s.code = w.current_state, me
               where g.user_id = me.id and g.status = 'ACTIVE' and g.scope = 'TRIAGE'
                 and g.effective_from <= now() and (g.effective_to is null or g.effective_to > now())
                 and s.sequence < 60 and authz.can_view_case(g.case_id)) as triage_before_handover,
      exists (select 1 from case_mgmt.case_access_grant g, me
               where g.user_id = me.id and g.status = 'ACTIVE'
                 and g.effective_from <= now() and (g.effective_to is null or g.effective_to > now())) as any_grant,
      exists (select 1 from case_mgmt.case_task t, me
               where t.assigned_user_id = me.id and t.status in ('OPEN', 'IN_PROGRESS') and t.expires_at > now()) as task,
      exists (select 1 from records.case_record_catalogue k where authz.can_view_records_catalogue(k.case_id)) as catalogue_row
  ),
  gates as (
    select 'MY_WORK'::text as area_code,
           (exists (select 1 from iam.role_permission rp
                      join iam.user_role_assignment ura on ura.role_code = rp.role_code, me
                     where ura.user_id = me.id and ura.status = 'ACTIVE'
                       and ura.effective_from <= current_date
                       and (ura.effective_to is null or ura.effective_to >= current_date)
                       and rp.permission_code not in ('AUDIT_VIEW', 'SECURITY_EVENT_VIEW', 'USER_ADMIN', 'ROLE_ADMIN',
                                                      'ARCHIVE_RECORD_VIEW'))
            or l.assigned or l.any_grant or l.task or exists (select 1 from work)) as shown,
           'needs-action'::text as default_view, 1 as ord
      from live l
    union all
    select 'INTAKE', authz.has_permission('INTAKE_VIEW'), 'new', 2 from live
    union all
    select 'CASES',
           authz.has_permission('CASE_VIEW_ALL') or l.assigned or l.case_grant or l.triage_before_handover,
           case when authz.has_permission('CASE_VIEW_ALL') then 'all' else 'my-cases' end, 3
      from live l
    union all
    select 'RECORDS',
           authz.has_permission('RETENTION_TASK_VIEW') or authz.has_permission('DISPOSITION_TASK_VIEW')
           or authz.has_permission('LEGAL_HOLD_REVIEW') or authz.has_permission('LEGAL_HOLD_RELEASE')
           or authz.has_permission('DISPOSITION_APPROVE') or authz.has_permission('ARCHIVE_RECORD_ADMINISTER')
           or (authz.has_permission('ARCHIVE_RECORD_VIEW') and l.catalogue_row)
           or exists (select 1 from work w where w.area = 'RECORDS'),
           case when l.task or authz.has_permission('RETENTION_TASK_VIEW') or authz.has_permission('DISPOSITION_TASK_VIEW')
                  then 'my-tasks'
                when authz.has_permission('LEGAL_HOLD_REVIEW') or authz.has_permission('LEGAL_HOLD_RELEASE')
                  or exists (select 1 from work w where w.area = 'RECORDS') then 'legal-holds'
                else 'catalogue' end, 5
      from live l
    union all
    select 'OVERSIGHT', authz.has_permission('AUDIT_VIEW') or authz.has_permission('SECURITY_EVENT_VIEW'),
           case when authz.has_permission('AUDIT_VIEW') then 'ledger' else 'security-events' end, 6 from live
    union all
    select 'ADMINISTRATION', authz.has_permission('USER_ADMIN') or authz.has_permission('ROLE_ADMIN'), 'users', 7
      from live
  )
  select g.area_code,
         case
           when g.area_code in ('OVERSIGHT', 'ADMINISTRATION') then 0  -- never a count derived from cases
           when g.area_code = 'MY_WORK' then (select count(*) from work w where w.view = 'NEEDS_ACTION')::int
           else (select count(*) from work w where w.view = 'NEEDS_ACTION' and w.area = g.area_code)::int
         end,
         g.default_view
    from gates g
   where g.shown and exists (select 1 from me)
   order by g.ord;
$$;

-- The caller's own access basis and expiry (DEC-10: everyone sees their own basis). Case numbers only where
-- the caller may see the case's metadata; grants and tasks on cases they no longer reach are not listed.
create function api.my_access()
returns table (basis text, code text, case_id uuid, case_number text, since_at timestamptz, until_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  with me as (
    select u.id, u.clearance from iam.user_profile u where u.id = authz.current_user_id() and u.status = 'ACTIVE'
  )
  select x.basis, x.code, x.case_id,
         case when x.case_id is not null and authz.can_view_case_metadata(x.case_id) then c.case_number end,
         x.since_at, x.until_at
    from (
      select 'CLEARANCE'::text as basis, me.clearance::text as code, null::uuid as case_id,
             null::timestamptz as since_at, null::timestamptz as until_at, 0 as ord
        from me
      union all
      select 'ROLE', a.role_code, null, a.effective_from::timestamptz, a.effective_to::timestamptz, 1
        from iam.user_role_assignment a, me
       where a.user_id = me.id and a.status = 'ACTIVE'
         and (a.effective_to is null or a.effective_to >= current_date)
      union all
      select 'ASSIGNMENT', a.assignment_role, a.case_id, a.assigned_at, null, 2
        from case_mgmt.case_assignment a, me
       where a.user_id = me.id and a.status = 'ACTIVE' and authz.can_view_case_metadata(a.case_id)
      union all
      select 'GRANT', g.scope, g.case_id, g.effective_from, g.effective_to, 3
        from case_mgmt.case_access_grant g, me
       where g.user_id = me.id and g.status = 'ACTIVE' and (g.effective_to is null or g.effective_to > now())
         and authz.can_view_case_metadata(g.case_id)
      union all
      select 'TASK', t.task_type, t.case_id, t.access_granted_at, t.expires_at, 4
        from case_mgmt.case_task t, me
       where t.assigned_user_id = me.id and t.status in ('OPEN', 'IN_PROGRESS') and t.expires_at > now()
         and authz.can_view_case_metadata(t.case_id)
      union all
      select 'BREAK_GLASS', b.status, b.case_id, coalesce(b.decided_at, b.requested_at), b.access_expires_at, 5
        from case_mgmt.break_glass_access b, me
       where b.requested_by = me.id and b.status in ('REQUESTED', 'ACTIVE')
         and (b.access_expires_at is null or b.access_expires_at > now())
    ) x
    left join case_mgmt.case_record c on c.id = x.case_id
   order by x.ord, x.since_at nulls first, x.code;
$$;

grant execute on function api.my_work_items(), api.my_areas(), api.my_access() to authenticated;
