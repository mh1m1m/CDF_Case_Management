-- =============================================================================
-- 1830 S2 case history and access roster (UX redesign S2; ADR-016 D5; DEC-08, DEC-10; audit UX-011, UX-092)
--
-- Two read-only functions for the case workspace. They add no access and change no table, policy or grant
-- beyond EXECUTE to authenticated. The ledger is unchanged and append-only: this is a read model with an
-- audience, not a deletion.
--
-- Both gate first on the caller's own case access (authz.can_view_case: assignment, grant within clearance and
-- without conflict, CASE_VIEW_ALL on an unrestricted case, or approved break-glass). Without it both return no
-- rows, the same answer whether or not the case exists. Metadata-only access (records catalogue, a task) does
-- not open the case's history; those users keep their own Records screens. Administrators, oversight roles and
-- a GRC Director without access to the case get nothing here; Oversight reads the full ledger under its own
-- permission (AUDIT_VIEW, SECURITY_EVENT_VIEW), unchanged.
--
-- api.case_history(case, limit): the case's business story, newest first, filtered by four rules (ADR-016 D5):
--   ACTOR ACCESS      the gate above;
--   ACTION AUDIENCE   an allowlist catalogue (below): an action not in it is never shown. Page views, downloads,
--                     discovery and every SECURITY event (identity reveal, break-glass, denials) are not in it;
--   OBJECT ENTITLEMENT evidence, form, interview and reporter events show only where the caller may open the
--                     object (authz.can_view_evidence, can_view_form_instance, can_view_interview,
--                     can_view_report), so history follows those rules when DEC-06 and DEC-09 narrow them;
--   CLASSIFICATION    objects above the caller's clearance are excluded by those predicates, and a classification
--                     change names a level only when it is within the caller's clearance.
-- Legal hold (DEC-10): "hold placed" and "hold released" show to the case team as status only, with no actor,
-- reason or detail. Requests, reviews, release requests and records events show only to the hold and records
-- audience (LEGAL_HOLD_APPLY or ARCHIVE_RECORD_ADMINISTER: Legal Reviewer, Records Officer, GRC Director) or
-- to the person who acted.
-- Conflict declarations and decisions show only to conflict managers (CONFLICT_MANAGE), the person concerned and
-- the person who acted. Access grants show only to the full-roster audience and the grantee, never AUDIT scope.
-- Team changes show to the case team; their reasons only to the full-roster audience, the person concerned and
-- the person who acted.
--
-- api.case_access_roster(case): who has access and on what basis (DEC-08).
--   Full roster: callers who may manage the team (authz.can_assign_case: Case Manager and GRC Director with
--   access, or the case's assigned lead or owner) see every assignment and every TRIAGE, CASE, COMMITTEE or
--   REVIEW grant, with purpose, start, expiry and status.
--   Everyone else with access sees the operational team (active assignments) and their own access basis.
--   Never returned, to anyone: AUDIT-scope (oversight) grants, break-glass, identity-reveal approvals, purpose
--   tasks, grant reasons and who granted. Oversight reads those through its own area.
-- =============================================================================

create function api.case_history(p_case_id uuid, p_limit int default 200)
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
             when e.action in ('CASE_ACCESS_GRANTED', 'CASE_ACCESS_REVOKED') then 'ACCESS'
             when e.action in ('CONFLICT_DECLARED', 'CONFLICT_DECIDED') then 'CONFLICT'
             when e.action in ('EVIDENCE_RECEIVED', 'EVIDENCE_STORED', 'EVIDENCE_REJECTED') then 'EVIDENCE'
             when e.action in ('FORM_STARTED', 'FORM_SAVED', 'FORM_PREPARED', 'FORM_REVIEWED', 'FORM_RETURNED',
                               'FORM_APPROVED', 'FORM_WITHDRAWN') then 'FORM'
             when e.action in ('INTERVIEW_PLANNED', 'INTERVIEW_PARTICIPANT_ADDED', 'INTERVIEW_SCHEDULED',
                               'INTERVIEW_RESCHEDULED', 'INTERVIEW_NOTICE_ISSUED', 'INTERVIEW_RIGHTS_ACKNOWLEDGED',
                               'INTERVIEW_CONDUCTED', 'INTERVIEW_STATEMENT_RECORDED', 'INTERVIEW_STATEMENT_ACKNOWLEDGED',
                               'INTERVIEW_RECORDING_LINKED', 'INTERVIEW_PREPARED', 'INTERVIEW_REVIEWED',
                               'INTERVIEW_APPROVED', 'INTERVIEW_RETURNED', 'INTERVIEW_CANCELLED') then 'INTERVIEW'
             when e.action in ('REPORT_MESSAGE_SENT', 'REPORTER_MESSAGE_RECEIVED', 'REPORT_ATTACHMENT_RECEIVED',
                               'REPORT_ATTACHMENT_STORED', 'REPORT_ATTACHMENT_REJECTED') then 'REPORTER'
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
                                  'CONFLICT_DECLARED', 'CONFLICT_DECIDED')
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
             when 'REPORTER' then authz.can_view_report(
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

create function api.case_access_roster(p_case_id uuid)
returns table (
  user_id uuid,
  display_name text,
  display_name_ar text,
  relationship text,       -- ASSIGNMENT or GRANT
  code text,               -- the assignment role, or the grant's purpose (TRIAGE, CASE, COMMITTEE, REVIEW)
  since_at timestamptz,
  until_at timestamptz,    -- a grant's expiry; null when open-ended or for an assignment
  ended_at timestamptz,    -- when an assignment ended or a grant was revoked
  status text,             -- ACTIVE, ENDED, REVOKED, EXPIRED or SCHEDULED
  is_self boolean
)
language sql stable security definer
set search_path = ''
as $$
  with me as (
    select authz.current_user_id() as id, authz.can_assign_case(p_case_id) as roster_full
     where authz.current_user_id() is not null and authz.can_view_case(p_case_id)
  ),
  basis as (
    select a.user_id, 'ASSIGNMENT'::text as relationship, a.assignment_role as code, a.assigned_at as since_at,
           null::timestamptz as until_at, a.ended_at, a.status
      from case_mgmt.case_assignment a, me
     where a.case_id = p_case_id
       and (me.roster_full or a.status = 'ACTIVE' or a.user_id = me.id)
    union all
    select g.user_id, 'GRANT', g.scope, g.effective_from, g.effective_to, g.revoked_at,
           case when g.status = 'REVOKED' then 'REVOKED'
                when g.effective_to is not null and g.effective_to <= now() then 'EXPIRED'
                when g.effective_from > now() then 'SCHEDULED'
                else 'ACTIVE' end
      from case_mgmt.case_access_grant g, me
     where g.case_id = p_case_id
       and g.scope in ('TRIAGE', 'CASE', 'COMMITTEE', 'REVIEW')
       and (me.roster_full or g.user_id = me.id)
  )
  select r.user_id, u.display_name, u.display_name_ar, r.relationship, r.code, r.since_at, r.until_at, r.ended_at,
         r.status, r.user_id = me.id
    from basis r
    join iam.user_profile u on u.id = r.user_id
   cross join me
   order by (r.status <> 'ACTIVE'), r.relationship,
            array_position(array['CASE_OWNER', 'LEAD_INVESTIGATOR', 'INVESTIGATOR', 'REVIEWER',
                                 'CASE', 'TRIAGE', 'COMMITTEE', 'REVIEW'], r.code),
            r.since_at, r.user_id;
$$;

revoke all on function api.case_history(uuid, int), api.case_access_roster(uuid) from public;
grant execute on function api.case_history(uuid, int), api.case_access_roster(uuid) to authenticated;

comment on function api.case_history(uuid, int) is
  'The case''s business history for its team (ADR-016 D5, DEC-08/DEC-10): actor access, action audience, object entitlement, classification. No page views; hold status without its details.';
comment on function api.case_access_roster(uuid) is
  'Who has access to the case and on what basis (ADR-016 D5, DEC-08): the full roster for those who manage the team, the operational team plus one''s own basis for others. Never oversight grants or break-glass.';
