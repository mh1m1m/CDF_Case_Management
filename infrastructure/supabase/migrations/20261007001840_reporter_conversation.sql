-- =============================================================================
-- 1840 S2 reporter conversation (UX redesign S2; ADR-016 D4; DEC-06; audit UX-026, RC-20)
--
-- Who holds the conversation with the reporter once a report becomes a case. Communication becomes a named,
-- delegable capability instead of a side effect of seeing the case (DEC-06).
--
-- Before a case exists nothing changes: INTAKE_VIEW holders within clearance read the conversation, and intake and
-- triage officers (REPORT_MESSAGE_REPLY) answer it. From case creation the conversation belongs to the case:
--   SEND  a Case Manager who can view the case (REPORTER_CONVERSATION_HOLD); the case's active owner or lead
--         investigator; an investigator with an active assignment AND an active delegation from someone who
--         manages the case team (authz.can_assign_case). A delegation lapses with the assignment.
--   READ  the senders, and the GRC Director's read oversight (REPORTER_CONVERSATION_OVERSEE) on cases it can view.
-- Nobody else gets the thread, whatever else they can see of the case: TRIAGE, COMMITTEE and REVIEW grant holders,
-- committee roles, records, legal, administrators, internal audit, SOC and DPO. The triage officer stops sending
-- when the case is created (the conversation moves to the case manager then; DEC-03 later ends the grant itself).
-- Reading or sending never touches protected identity: the thread is the reporter's own words through the
-- portal, and no path here reads the vault.
--
-- Changes:
--   * two permissions: REPORTER_CONVERSATION_HOLD (Case Manager), REPORTER_CONVERSATION_OVERSEE (GRC Director);
--   * case_mgmt.reporter_communication_delegation (REPORTER_COMMUNICATE delegations), RLS on, SELECT only for
--     those who manage the case team and the delegate, no write grants; no delete or truncate for anyone, and
--     none added after archiving (as for assignments, 1320);
--   * authz.is_reporter_correspondent, authz.can_message_reporter, authz.can_read_reporter_conversation;
--   * api.delegate_reporter_communication and api.end_reporter_communication (audited); a delegation also ends,
--     audited, when the investigator's assignment ends;
--   * api.reply_to_reporter checks authz.can_message_reporter instead of REPORT_MESSAGE_REPLY;
--   * the report_message_read policy narrows from authz.can_view_report to the reader rule;
--   * api.case_history: message events follow the reader rule (attachment events keep the report's rule), and
--     delegation events join the access audience (the full-roster audience and the delegate);
--   * api.my_work_items: "the reporter replied" goes to those who may answer under the new rule.
-- =============================================================================

insert into iam.permission (code, description) values
  ('REPORTER_CONVERSATION_HOLD',    'Hold the conversation with the reporter on cases the holder can view (DEC-06)'),
  ('REPORTER_CONVERSATION_OVERSEE', 'Read the conversation with the reporter for oversight on cases the holder can view (DEC-06)');

insert into iam.role_permission (role_code, permission_code) values
  ('CASE_MANAGER', 'REPORTER_CONVERSATION_HOLD'),
  ('GRC_DIRECTOR', 'REPORTER_CONVERSATION_OVERSEE');

-- -----------------------------------------------------------------------------
-- REPORTER_COMMUNICATE delegations
-- -----------------------------------------------------------------------------
create table case_mgmt.reporter_communication_delegation (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid not null references case_mgmt.case_record (id),
  user_id      uuid not null references iam.user_profile (id),
  reason       text not null check (length(btrim(reason)) between 10 and 500),
  delegated_by uuid not null references iam.user_profile (id),
  delegated_at timestamptz not null default now(),
  ended_by     uuid references iam.user_profile (id),
  ended_at     timestamptz,
  end_reason   text check (end_reason is null or length(btrim(end_reason)) between 10 and 500),
  check ((ended_at is null) = (ended_by is null)),
  check ((ended_at is null) = (end_reason is null))
);
create unique index reporter_communication_delegation_one_active
  on case_mgmt.reporter_communication_delegation (case_id, user_id) where ended_at is null;
-- authz.is_reporter_correspondent and the policy search by case and user.
create index reporter_communication_delegation_case_user
  on case_mgmt.reporter_communication_delegation (case_id, user_id);
comment on table case_mgmt.reporter_communication_delegation is
  'REPORTER_COMMUNICATE delegations (ADR-016 D4, DEC-06): an assigned investigator may write to the reporter on this case. Ended, never deleted.';

alter table case_mgmt.reporter_communication_delegation enable row level security;

-- A delegation is part of the case record: never deleted, and none added once the case is archived.
create trigger protect_no_delete before delete on case_mgmt.reporter_communication_delegation
  for each row execute function records.reject_mutation();
create trigger protect_no_truncate before truncate on case_mgmt.reporter_communication_delegation
  for each statement execute function records.reject_mutation();
create trigger reporter_communication_delegation_records_guard before insert on case_mgmt.reporter_communication_delegation
  for each row execute function records.reject_access_after_archive();

-- -----------------------------------------------------------------------------
-- The rules
-- -----------------------------------------------------------------------------
-- The caller holds the conversation of this case: never from case visibility alone.
create function authz.is_reporter_correspondent(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id)
     and (authz.has_permission('REPORTER_CONVERSATION_HOLD')
          or authz.has_active_assignment(p_case_id, authz.current_user_id(), array['CASE_OWNER', 'LEAD_INVESTIGATOR'])
          or (authz.has_active_assignment(p_case_id, authz.current_user_id(), array['INVESTIGATOR'])
              and exists (select 1 from case_mgmt.reporter_communication_delegation d
                           where d.case_id = p_case_id and d.user_id = authz.current_user_id()
                             and d.ended_at is null)));
$$;

-- Who may write to the reporter of this report.
create function authz.can_message_reporter(p_report_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from intake.report r
     where r.id = p_report_id
       and authz.current_user_id() is not null
       and case when r.case_id is null
                then authz.can_view_report(r.id) and authz.has_permission('REPORT_MESSAGE_REPLY')
                else authz.is_reporter_correspondent(r.case_id) end
  );
$$;

-- Who may read the conversation of this report.
create function authz.can_read_reporter_conversation(p_report_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from intake.report r
     where r.id = p_report_id
       and authz.current_user_id() is not null
       and case when r.case_id is null
                then authz.can_view_report(r.id)
                else authz.is_reporter_correspondent(r.case_id)
                     or (authz.has_permission('REPORTER_CONVERSATION_OVERSEE') and authz.can_view_case(r.case_id)) end
  );
$$;

revoke all on function authz.is_reporter_correspondent(uuid), authz.can_message_reporter(uuid),
  authz.can_read_reporter_conversation(uuid) from public;
grant execute on function authz.is_reporter_correspondent(uuid), authz.can_message_reporter(uuid),
  authz.can_read_reporter_conversation(uuid) to authenticated;

create policy reporter_communication_delegation_read on case_mgmt.reporter_communication_delegation
  for select to authenticated
  using (authz.can_assign_case(case_id) or (user_id = authz.current_user_id() and authz.can_view_case(case_id)));
grant select on case_mgmt.reporter_communication_delegation to authenticated;

alter policy report_message_read on intake.report_message
  using (authz.can_read_reporter_conversation(report_id));

-- -----------------------------------------------------------------------------
-- Commands
-- -----------------------------------------------------------------------------
create or replace function api.reply_to_reporter(p_report_id uuid, p_body text)
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
  -- DEC-06: intake and triage before the case; the case's correspondents after it.
  if not authz.can_message_reporter(p_report_id) then perform api._fail('FORBIDDEN'); end if;
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

-- An assigned investigator may write to the reporter on this case (REPORTER_COMMUNICATE).
create function api.delegate_reporter_communication(p_case_id uuid, p_user_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_reason text;
  v_id uuid;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_assign_case(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 500);
  -- Only an investigator on this case's team; the owner and the lead hold the conversation already.
  if not authz.has_active_assignment(p_case_id, p_user_id, array['INVESTIGATOR']) then
    perform api._fail('INVALID', 'userId');
  end if;
  if exists (select 1 from case_mgmt.reporter_communication_delegation d
              where d.case_id = p_case_id and d.user_id = p_user_id and d.ended_at is null) then
    perform api._fail('CONFLICT', 'ALREADY_DELEGATED');
  end if;
  insert into case_mgmt.reporter_communication_delegation (case_id, user_id, reason, delegated_by)
  values (p_case_id, p_user_id, v_reason, v_actor) returning id into v_id;
  perform audit.record_event('REPORTER_COMMUNICATION_DELEGATED', 'BUSINESS', 'SUCCESS', p_case_id,
    'reporter_communication_delegation', v_id::text, v_reason, jsonb_build_object('user_id', p_user_id));
  return v_id;
end;
$$;

create function api.end_reporter_communication(p_delegation_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_d case_mgmt.reporter_communication_delegation;
  v_reason text;
begin
  select * into v_d from case_mgmt.reporter_communication_delegation d where d.id = p_delegation_id;
  if v_d.id is null or not authz.can_view_case(v_d.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_assign_case(v_d.case_id) then perform api._fail('FORBIDDEN'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 500);
  if v_d.ended_at is not null then perform api._fail('CONFLICT', 'DELEGATION_ENDED'); end if;
  update case_mgmt.reporter_communication_delegation
     set ended_at = now(), ended_by = v_actor, end_reason = v_reason
   where id = p_delegation_id;
  perform audit.record_event('REPORTER_COMMUNICATION_ENDED', 'BUSINESS', 'SUCCESS', v_d.case_id,
    'reporter_communication_delegation', p_delegation_id::text, v_reason, jsonb_build_object('user_id', v_d.user_id));
end;
$$;

revoke all on function api.delegate_reporter_communication(uuid, uuid, text),
  api.end_reporter_communication(uuid, text) from public;
grant execute on function api.delegate_reporter_communication(uuid, uuid, text),
  api.end_reporter_communication(uuid, text) to authenticated;

-- A delegation lapses with the assignment: when an investigator's assignment ends (unassignment, reassignment),
-- the delegation ends in the same transaction, attributed to whoever ended the assignment and audited, so a later
-- assignment of the same person never revives it.
create function case_mgmt.end_reporter_communication_with_assignment()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare d record;
begin
  for d in
    update case_mgmt.reporter_communication_delegation x
       set ended_at = now(), ended_by = new.ended_by,
           end_reason = 'The investigator''s assignment on this case ended.'
     where x.case_id = new.case_id and x.user_id = new.user_id and x.ended_at is null
    returning x.id, x.case_id, x.user_id
  loop
    perform audit.record_event('REPORTER_COMMUNICATION_ENDED', 'BUSINESS', 'SUCCESS', d.case_id,
      'reporter_communication_delegation', d.id::text, 'The investigator''s assignment on this case ended.',
      jsonb_build_object('user_id', d.user_id, 'assignment_id', new.id));
  end loop;
  return null;
end;
$$;
revoke all on function case_mgmt.end_reporter_communication_with_assignment() from public;

create trigger case_assignment_ends_reporter_communication
  after update of status on case_mgmt.case_assignment
  for each row
  when (old.status = 'ACTIVE' and new.status = 'ENDED' and old.assignment_role = 'INVESTIGATOR')
  execute function case_mgmt.end_reporter_communication_with_assignment();

-- -----------------------------------------------------------------------------
-- Case history (1830) and My Work (1820) follow the new rule. Only the marked parts change.
-- -----------------------------------------------------------------------------
create or replace function api.case_history(p_case_id uuid, p_limit int default 200)
returns table (
  seq bigint,
  occurred_at timestamptz,
  action text,
  actor_id uuid,           -- null when the audience may not see who acted, or when no user acted
  actor_name text,
  actor_name_ar text,
  subject_name text,       -- the person a team, access or conflict event is about, where the audience may know
  subject_name_ar text,
  reason text,             -- null when the audience may not see it
  detail jsonb             -- a fixed set of keys per action; never the event's raw metadata
)
language sql stable security definer
set search_path = ''
as $$
  with me as (
    select authz.current_user_id() as id, authz.current_clearance() as clearance,
           authz.can_assign_case(p_case_id) as roster_full,
           authz.has_permission('CONFLICT_MANAGE') as conflict_manager,
           authz.has_permission('LEGAL_HOLD_APPLY') or authz.has_permission('ARCHIVE_RECORD_ADMINISTER') as records_audience
     where authz.current_user_id() is not null and authz.can_view_case(p_case_id)
  ),
  -- The action-audience catalogue. An action missing here never reaches history.
  ev as (
    select e.*,
           case
             when e.action in ('CASE_CREATED', 'CASE_UPDATED', 'CASE_CLOSED', 'CASE_REOPENED', 'CLASSIFICATION_CHANGED',
                               'WORKFLOW_TRANSITION') then 'CASE_TEAM'
             when e.action in ('CASE_ASSIGNED', 'CASE_UNASSIGNED', 'CASE_REASSIGNED', 'CASE_HANDED_OVER') then 'TEAM_CHANGE'
             when e.action in ('CASE_ACCESS_GRANTED', 'CASE_ACCESS_REVOKED', 'REPORTER_COMMUNICATION_DELEGATED',
                               'REPORTER_COMMUNICATION_ENDED') then 'ACCESS'
             when e.action in ('CONFLICT_DECLARED', 'CONFLICT_DECIDED') then 'CONFLICT'
             when e.action in ('EVIDENCE_RECEIVED', 'EVIDENCE_STORED', 'EVIDENCE_REJECTED') then 'EVIDENCE'
             when e.action in ('FORM_STARTED', 'FORM_SAVED', 'FORM_PREPARED', 'FORM_REVIEWED', 'FORM_RETURNED',
                               'FORM_APPROVED', 'FORM_WITHDRAWN') then 'FORM'
             when e.action in ('INTERVIEW_PLANNED', 'INTERVIEW_PARTICIPANT_ADDED', 'INTERVIEW_SCHEDULED',
                               'INTERVIEW_RESCHEDULED', 'INTERVIEW_NOTICE_ISSUED', 'INTERVIEW_RIGHTS_ACKNOWLEDGED',
                               'INTERVIEW_CONDUCTED', 'INTERVIEW_STATEMENT_RECORDED', 'INTERVIEW_STATEMENT_ACKNOWLEDGED',
                               'INTERVIEW_RECORDING_LINKED', 'INTERVIEW_PREPARED', 'INTERVIEW_REVIEWED',
                               'INTERVIEW_APPROVED', 'INTERVIEW_RETURNED', 'INTERVIEW_CANCELLED') then 'INTERVIEW'
             when e.action in ('REPORT_MESSAGE_SENT', 'REPORTER_MESSAGE_RECEIVED') then 'REPORTER_MESSAGE'
             when e.action in ('REPORT_ATTACHMENT_RECEIVED', 'REPORT_ATTACHMENT_STORED',
                               'REPORT_ATTACHMENT_REJECTED') then 'REPORTER_FILE'
             when e.action in ('LEGAL_HOLD_PLACED', 'LEGAL_HOLD_RELEASED') then 'HOLD_STATUS'
             when e.action in ('LEGAL_HOLD_REQUESTED', 'LEGAL_HOLD_REVIEWED', 'LEGAL_HOLD_RELEASE_REQUESTED',
                               'LEGAL_HOLD_RELEASE_REJECTED', 'CASE_TASK_ASSIGNED', 'RETENTION_CLASS_ASSIGNED',
                               'RETENTION_SCHEDULE_COMPUTED', 'RETENTION_SCHEDULE_SUPERSEDED', 'RETENTION_REVIEW_STARTED',
                               'DISPOSITION_ELIGIBLE_MARKED', 'DISPOSITION_REVIEW_STARTED', 'DISPOSITION_REQUESTED',
                               'DISPOSITION_APPROVED', 'DISPOSITION_REJECTED', 'DISPOSITION_BLOCKED_BY_HOLD',
                               'DISPOSITION_EXECUTED', 'DISPOSITION_CERTIFICATE_ISSUED') then 'RECORDS'
           end as audience,
           -- The person a team, access or conflict event is about; for a hand-over or reassignment, the new person.
           case when e.action in ('CASE_HANDED_OVER', 'CASE_REASSIGNED') then e.metadata ->> 'to_user_id'
                when e.action in ('CASE_ASSIGNED', 'CASE_UNASSIGNED', 'CASE_ACCESS_GRANTED', 'CASE_ACCESS_REVOKED',
                                  'CONFLICT_DECLARED', 'CONFLICT_DECIDED', 'REPORTER_COMMUNICATION_DELEGATED',
                                  'REPORTER_COMMUNICATION_ENDED')
                  then e.metadata ->> 'user_id'
           end as subject_text,
           -- The person a hand-over or reassignment moved the work away from.
           case when e.action in ('CASE_HANDED_OVER', 'CASE_REASSIGNED') then e.metadata ->> 'from_user_id'
           end as previous_text
      from audit.audit_event e
     where e.case_id = p_case_id and e.category = 'BUSINESS' and e.outcome in ('SUCCESS', 'FAILURE')
  ),
  shown as (
    select ev.*, me.id as me_id, me.clearance, me.roster_full, me.conflict_manager, me.records_audience,
           (ev.actor_type = 'USER' and ev.actor_id = me.id) as by_me,
           (me.id::text in (ev.subject_text, ev.previous_text)) is true as about_me,
           g.scope as grant_scope
      from ev
     cross join me
      left join case_mgmt.case_access_grant g on ev.object_type = 'case_access_grant' and g.id::text = ev.object_id
     where ev.audience is not null
       and case ev.audience
             when 'CASE_TEAM' then true
             when 'TEAM_CHANGE' then true
             when 'ACCESS' then coalesce(g.scope, ev.metadata ->> 'scope') is distinct from 'AUDIT'
                                and (me.roster_full or ev.subject_text = me.id::text)
             when 'CONFLICT' then me.conflict_manager or ev.subject_text = me.id::text
                                  or (ev.actor_type = 'USER' and ev.actor_id = me.id)
             when 'EVIDENCE' then authz.can_view_evidence((ev.metadata ->> 'evidence_id')::uuid)
             when 'FORM' then case when ev.object_type = 'form_instance'
                                   then authz.can_view_form_instance(ev.object_id::uuid) else false end
             when 'INTERVIEW' then authz.can_view_interview(
                                     case when ev.object_type = 'interview' then ev.object_id
                                          else ev.metadata ->> 'interview_id' end::uuid)
             -- DEC-06: the conversation's own readers; the report's files keep the report's rule.
             when 'REPORTER_MESSAGE' then authz.can_read_reporter_conversation(
                                            case when ev.object_type = 'report' then ev.object_id
                                                 else ev.metadata ->> 'report_id' end::uuid)
             when 'REPORTER_FILE' then authz.can_view_report(
                                         case when ev.object_type = 'report' then ev.object_id
                                              else ev.metadata ->> 'report_id' end::uuid)
             when 'HOLD_STATUS' then true
             when 'RECORDS' then me.records_audience or (ev.actor_type = 'USER' and ev.actor_id = me.id)
             else false
           end
  ),
  masked as (
    select s.seq, s.occurred_at, s.action,
           -- Hold status reaches the case team without who placed or released it, or why (DEC-10).
           case when s.actor_type <> 'USER' then false
                when s.audience = 'HOLD_STATUS' then s.records_audience or s.by_me
                else true end as show_actor,
           case when s.audience = 'HOLD_STATUS' then s.records_audience or s.by_me
                when s.audience = 'TEAM_CHANGE' then s.roster_full or s.about_me or s.by_me
                else true end as show_reason,
           s.audience in ('TEAM_CHANGE', 'ACCESS', 'CONFLICT') as show_subject,
           s.actor_id, s.reason, s.metadata, s.subject_text, s.clearance, s.grant_scope
      from shown s
  )
  select m.seq, m.occurred_at, m.action,
         case when m.show_actor then m.actor_id end,
         case when m.show_actor then a.display_name end,
         case when m.show_actor then a.display_name_ar end,
         case when m.show_subject then p.display_name end,
         case when m.show_subject then p.display_name_ar end,
         case when m.show_reason then m.reason end,
         case m.action
           when 'WORKFLOW_TRANSITION' then jsonb_build_object(
             'transition', m.metadata ->> 'transition', 'from', m.metadata ->> 'from', 'to', m.metadata ->> 'to')
           when 'CLASSIFICATION_CHANGED' then jsonb_build_object(
             'from', case when (m.metadata ->> 'from')::core.classification_level <= m.clearance
                          then m.metadata ->> 'from' end,
             'to', case when (m.metadata ->> 'to')::core.classification_level <= m.clearance
                        then m.metadata ->> 'to' end,
             'restricted', (m.metadata ->> 'restricted_to')::boolean)
           when 'CASE_UPDATED' then jsonb_build_object('fields', m.metadata -> 'fields')
           when 'CASE_ASSIGNED' then jsonb_build_object('role', m.metadata ->> 'assignment_role')
           when 'CASE_UNASSIGNED' then jsonb_build_object('role', m.metadata ->> 'assignment_role')
           when 'CASE_REASSIGNED' then jsonb_build_object('role', m.metadata ->> 'assignment_role')
           when 'CASE_ACCESS_GRANTED' then jsonb_build_object('scope', coalesce(m.grant_scope, m.metadata ->> 'scope'))
           when 'CASE_ACCESS_REVOKED' then jsonb_build_object('scope', coalesce(m.grant_scope, m.metadata ->> 'scope'))
         end
    from masked m
    left join iam.user_profile a on a.id = m.actor_id
    left join iam.user_profile p on m.show_subject and p.id::text = m.subject_text
   order by m.seq desc
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;

create or replace function api.my_work_items()
returns table (
  area text,             -- MY_WORK, INTAKE, CASES or RECORDS: where the item's target lives
  view text,             -- NEEDS_ACTION, MY_CASES, DUE_SOON or WAITING
  category text,         -- the item type; the page renders a fixed template for it
  target_type text,      -- REPORT, CASE, CONFLICT, FORM_INSTANCE, INTERVIEW, CASE_TASK, HOLD_REQUEST, HOLD_RELEASE
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

comment on function authz.can_read_reporter_conversation(uuid) is
  'Who may read the reporter conversation (ADR-016 D4, DEC-06): intake before the case; the case''s correspondents and GRC read oversight after it. Never from case visibility alone.';
comment on function authz.can_message_reporter(uuid) is
  'Who may write to the reporter (ADR-016 D4, DEC-06): intake and triage before the case; the case manager, the owner, the lead and delegated investigators after it.';
