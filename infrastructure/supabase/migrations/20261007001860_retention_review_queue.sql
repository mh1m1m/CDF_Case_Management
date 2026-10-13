-- =============================================================================
-- 1860 Retention review queue at archive (UX redesign S2h; ADR-016 D8; DEC-37 as decided 2026-10-12; CDF-130, UX-097)
--
-- Archiving a case creates an obligation for Records review, not a named assignee. Until the shared work-item
-- infrastructure arrives (S4), the obligation is derived from the case's state:
--   records_state = 'ARCHIVED'  (archived and its retention class not yet confirmed; confirming it moves the
--                                case to RETENTION, which ends the obligation)
-- A legal hold does not stop classification (it stops disposition, as before), so a held case stays in the queue.
-- The pool is everyone who may classify the case from the records catalogue: the catalogue scope (closed, not
-- restricted, within clearance, no conflict) with ARCHIVE_RECORD_ADMINISTER and RETENTION_CLASS_ASSIGN, which is
-- the shared branch of `authz.can_manage_retention`. A RETENTION_REVIEW task is an individual assignment and
-- stays the task: its holder gets the task item instead of the queue item. Restricted cases never enter the
-- shared queue (ADR-014 §9): only a RETENTION_REVIEW task given by someone who can see the case brings one to an
-- officer.
-- So that no archived case waits unseen, a case the shared pool cannot take (restricted, or no records officer is
-- cleared for it and free of conflict) and on which nobody holds a usable RETENTION_REVIEW task goes to the case
-- authority who may create records tasks on it (case_mgmt.may_manage_tasks: for a restricted case, its DEC-01
-- Restricted Case Authority), who routes it to one eligible officer with api.create_case_task. Routing is a person
-- choosing an officer, never a rule picking one (DEC-37).
--
--   * api.retention_review_queue(): the queue rows, lifecycle metadata only: case number, classification,
--     archived date, current class and the legal-hold flag. No title, summary, people, evidence or findings,
--     and the queue grants nothing: the case page, evidence and interviews stay refused to the officer.
--   * records.retention_pool_can_take(case): whether any active user may classify the case from the catalogue.
--   * authz.can_route_retention_review(case): the caller should route the case (the rule above).
--   * api.list_retention_reviewers(case): the officers api.create_case_task would accept for a RETENTION_REVIEW
--     task on the case (eligible role, active, cleared, no conflict); NOT_FOUND for a case the caller cannot see,
--     FORBIDDEN for one they may not create records tasks on. Names only.
--   * api.assign_retention_class(): as in 1710, and classifying also completes the caller's own open
--     RETENTION_REVIEW task on the case (audited CASE_TASK_COMPLETED): the class is the review's outcome, so the
--     task leaves their work and its access ends with it.
--   * api.my_work_items(): one RETENTION_CLASSIFICATION item per queued case, except for the holder of a
--     RETENTION_REVIEW task on it; one RETENTION_TO_ROUTE item per case the caller should route (body otherwise
--     as in 1840).
--
-- Retention classes and periods stay SOURCE_REQUIRED (ADR-013 D2). Who may archive is unchanged (WORKFLOW_ADVANCE
-- on the case: Case Manager or Lead today) and stays an open part of DEC-37.
-- No table, policy or grant change beyond EXECUTE to authenticated (records.retention_pool_can_take: none).
-- assign_retention_class keeps its signature and grant.
-- =============================================================================

create function api.retention_review_queue()
returns table (
  case_id uuid,
  case_number text,
  classification core.classification_level,
  archived_at timestamptz,
  retention_class text,
  legal_hold_status text
)
language sql stable security definer
set search_path = ''
as $$
  select c.id, c.case_number, c.classification, arc.archived_at, c.retention_class, c.legal_hold_status
    from case_mgmt.case_record c
    cross join lateral (select max(e.occurred_at) as archived_at
                          from workflow.workflow_transition_event e
                         where e.case_id = c.id and e.to_state = 'ARCHIVE') arc
   where authz.current_user_id() is not null
     and c.records_state = 'ARCHIVED'
     and authz.has_permission('RETENTION_CLASS_ASSIGN')
     and authz.has_permission('ARCHIVE_RECORD_ADMINISTER')
     and authz.in_records_catalogue_scope(c.id)
   order by arc.archived_at, c.case_number;
$$;

-- The shared pool's membership for any user, not only the caller: the predicate above, evaluated per user.
create function records.retention_pool_can_take(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from iam.user_profile u
     where u.status = 'ACTIVE'
       and authz.user_has_permission(u.id, 'RETENTION_CLASS_ASSIGN')
       and authz.user_has_permission(u.id, 'ARCHIVE_RECORD_ADMINISTER')
       and authz.user_records_catalogue_scope(u.id, p_case_id));
$$;

create function authz.can_route_retention_review(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null
     and exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state = 'ARCHIVED')
     and case_mgmt.may_manage_tasks(p_case_id, 'RECORDS')
     and not records.retention_pool_can_take(p_case_id)
     -- A task its holder can still use already stands for the obligation; an expired or unusable one does not.
     and not exists (select 1 from case_mgmt.case_task t
                      where t.case_id = p_case_id and t.task_type = 'RETENTION_REVIEW'
                        and t.status in ('OPEN', 'IN_PROGRESS') and t.expires_at > now()
                        and authz.user_task_grants(t.assigned_user_id, p_case_id, 'RETENTION_TASK_EXECUTE'));
$$;

create function api.list_retention_reviewers(p_case_id uuid)
returns table (user_id uuid, display_name text, display_name_ar text)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not authz.can_view_case_metadata(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not case_mgmt.may_manage_tasks(p_case_id, 'RECORDS') then perform api._fail('FORBIDDEN'); end if;
  -- The assignee rule of case_mgmt.create_task_internal: an eligible role for the task type, the case gate, and no
  -- open task of this type on the case already.
  return query
    select u.id, u.display_name, u.display_name_ar
      from iam.user_profile u
      join case_mgmt.case_task_type tt on tt.code = 'RETENTION_REVIEW'
     where exists (select 1 from unnest(tt.eligible_roles) r where authz.user_has_role(u.id, r))
       and authz.user_case_gate(u.id, p_case_id)
       and not exists (select 1 from case_mgmt.case_task t
                        where t.case_id = p_case_id and t.task_type = 'RETENTION_REVIEW' and t.assigned_user_id = u.id
                          and t.status in ('OPEN', 'IN_PROGRESS'))
     order by u.display_name, u.id;
end;
$$;

create or replace function api.assign_retention_class(p_case_id uuid, p_retention_class text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_task uuid;
  v_schedule uuid;
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
  v_schedule := records._compute_schedule(p_case_id, 'CLASS_CHANGED');

  -- ADR-016 D8: the class is the outcome of the caller's retention review, so their own open task completes with it.
  for v_task in select t.id from case_mgmt.case_task t
                 where t.case_id = p_case_id and t.assigned_user_id = v_actor and t.task_type = 'RETENTION_REVIEW'
                   and t.status in ('OPEN', 'IN_PROGRESS') and t.expires_at > now()
                 order by t.id for update loop
    perform case_mgmt.close_task_internal(v_task, 'COMPLETED', v_actor, 'RETENTION_CLASS_ASSIGNED');
  end loop;
  return v_schedule;
end;
$$;

create or replace function api.my_work_items()
returns table (
  area text,             -- MY_WORK, INTAKE, CASES or RECORDS: where the item's target lives
  view text,             -- NEEDS_ACTION, MY_CASES, DUE_SOON or WAITING
  category text,         -- the item type; the page renders a fixed template for it
  target_type text,      -- REPORT, CASE, CONFLICT, FORM_INSTANCE, INTERVIEW, CASE_TASK, HOLD_REQUEST, HOLD_RELEASE,
                         -- RECORD (a case's records page)
  target_id uuid,
  case_id uuid,          -- only when the caller may see the case's metadata (CDF-84: a controlled lookup's
                         -- requester never learns which case the request reached)
  case_number text,      -- the same rule
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
    -- The reporter wrote last, and the caller may answer (DEC-06: intake and triage before the case, the case's
    -- correspondents after it).
    select case when r.case_id is null then 'INTAKE' else 'CASES' end, 'NEEDS_ACTION', 'REPORTER_REPLIED',
           'REPORT', r.id, r.case_id, null, null, m.created_at
      from intake.report r
      join lateral (select x.direction, x.created_at from intake.report_message x
                     where x.report_id = r.id order by x.created_at desc, x.id desc limit 1) m on true
     where m.direction = 'FROM_REPORTER'
       and r.status not in ('REFERRED_OUT', 'CLOSED_NO_ACTION', 'DUPLICATE')
       and authz.can_message_reporter(r.id)

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

    union all
    -- An archived case waiting for its retention class (ADR-016 D8, DEC-37): one item per case for every records
    -- officer who may classify it, derived from the case's state. A shared queue, never a named assignee. The
    -- caller's own RETENTION_REVIEW task on the case already stands for it, so they get that item instead.
    select 'RECORDS', 'NEEDS_ACTION', 'RETENTION_CLASSIFICATION', 'RECORD', q.case_id, q.case_id, null, null,
           q.archived_at
      from api.retention_review_queue() q, me
     where not exists (select 1 from case_mgmt.case_task t
                        where t.case_id = q.case_id and t.assigned_user_id = me.id and t.task_type = 'RETENTION_REVIEW'
                          and t.status in ('OPEN', 'IN_PROGRESS')
                          and t.access_granted_at <= now() and t.expires_at > now()
                          and authz.user_has_role(me.id, t.assigned_role))

    union all
    -- An archived case the shared pool cannot take and nobody holds a usable retention task on: the case authority
    -- who may create records tasks on it routes it to one officer, so the obligation is never silent.
    select 'CASES', 'NEEDS_ACTION', 'RETENTION_TO_ROUTE', 'RECORD', c.id, c.id, null, null, arc.archived_at
      from case_mgmt.case_record c
      cross join lateral (select max(e.occurred_at) as archived_at
                            from workflow.workflow_transition_event e
                           where e.case_id = c.id and e.to_state = 'ARCHIVE') arc
     where c.records_state = 'ARCHIVED' and authz.can_route_retention_review(c.id)
  )
  select i.area, i.view, i.category, i.target_type, i.target_id,
         case when i.case_id is not null and authz.can_view_case_metadata(i.case_id) then i.case_id end,
         case when i.case_id is not null and authz.can_view_case_metadata(i.case_id) then c.case_number end,
         i.due_at, i.due_source, i.since_at
    from items i
    left join case_mgmt.case_record c on c.id = i.case_id
   where authz.current_user_id() is not null
   order by (i.due_at is null), i.due_at, i.since_at, i.target_id;
$$;

revoke all on function api.retention_review_queue(), records.retention_pool_can_take(uuid),
  authz.can_route_retention_review(uuid), api.list_retention_reviewers(uuid) from public;
grant execute on function api.retention_review_queue(), authz.can_route_retention_review(uuid),
  api.list_retention_reviewers(uuid) to authenticated;
