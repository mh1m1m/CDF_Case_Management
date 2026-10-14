-- =============================================================================
-- 2045 Areas and My Work for Phase 12 (UX redesign P12-0b; ADR-051)
-- Requirements: Phase 12 plan §2 (areas) and §5 (My Work kinds); DEC-22 (My Work row fields, owner 2026-10-13);
-- AMB-047 (work follows the current effective seat); AMB-250 (returned work carries its structured reasons);
-- AMB-010 and AMB-246 (a due date only where one is configured); DEC-F19 (a committee as counts, never names);
-- the coordinator's notes of 13:24 and 13:25 (the 1870 events in the case history) and the coordinator's ruling of
-- 2026-10-14 (the referral preview: per-seat holder counts and totals, never a flag per seat). Linear CDF-211.
-- Number allocated by the coordinator.
--
-- Before: My Work listed intake, case, form, interview and records work only. The rebase commands of 1870-2040
-- (referrals, preliminary review, meetings, minutes, legal review, notices, grievances, exports, corrective actions,
-- continuity imports) produced work nobody saw unless a notification reached them. There was no Committee area,
-- Administration showed only to user and role administrators, the case team could not see what a committee
-- referral would copy before making it, and the case history did not list the 1870 events.
--
-- After, in one transaction:
--   1. api.my_work_items() gains the Phase 12 kinds (plan §5). Each row repeats the checks of the command it leads
--      to, in the caller's own context, so a row exists only where that command would accept the caller now. Two
--      columns are added at the end: code (a non-sensitive code or type: a form's code, a referral's status, a
--      notice's kind) and reason_codes (the structured reasons of returned work). A row still never carries a
--      title, name or narrative, and the case number still shows only with case-metadata visibility (DEC-22). A
--      row's area is where its work lives: a committee the caller sits on now (COMMITTEE), a case they can open
--      (CASES), otherwise My Work.
--   2. api.my_areas() gains the Committee area «لجاني», for a current seat on any committee (AMB-047). It widens
--      Administration to the business administration permissions (plan §2). Neither opens a case or case content,
--      and Administration still never counts.
--   3. api.committee_referral_preview(case, committee): what a referral would copy now, as counts per seat and four
--      totals (voting, cleared, not cleared, firewall restricted), with the referral command's own checks first.
--      No id, no name, and no flag per seat (coordinator ruling, 2026-10-14).
--   4. api.case_history() lists the 1870 events as codes and times only, each to whoever may read what it is about.
--      The restricted committee referral approval shows only to the case owner as Restricted Case Authority.
--
-- Nothing else changes: no table, policy, table grant or command. The functions are read models (SECURITY DEFINER,
-- search_path '') that evaluate the predicates the commands and policies use; each is granted to authenticated
-- only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. My Work: the Phase 12 kinds
-- -----------------------------------------------------------------------------
-- From 2020, with the purpose kinds and two output columns at the end (code, reason_codes). A new output column
-- means dropping and creating the function again, with its grant; it reads only, so nothing is lost. api.my_areas
-- reads it and is replaced below.
drop function api.my_work_items();
create function api.my_work_items()
returns table (
  area text,             -- MY_WORK, INTAKE, CASES, COMMITTEE or RECORDS: where the item's work lives
  view text,             -- NEEDS_ACTION, MY_CASES, DUE_SOON or WAITING
  category text,         -- the item type; the page renders a fixed template for it
  target_type text,      -- REPORT, CASE, CONFLICT, FORM_INSTANCE, INTERVIEW, CASE_TASK, HOLD_REQUEST, HOLD_RELEASE,
                         -- RECORD (a case's records page); since 2045 also REFERRAL, PRELIMINARY_REVIEW, EXPORT,
                         -- RECOMMENDATION_PACKAGE, GRIEVANCE, MEETING, MINUTES, LEGAL_REVIEW, DEFENCE_NOTICE,
                         -- CORRECTIVE_ACTION and BCP_IMPORT
  target_id uuid,
  case_id uuid,          -- only when the caller may see the case's metadata (CDF-84: a controlled lookup's
                         -- requester never learns which case the request reached)
  case_number text,      -- the same rule
  due_at timestamptz,
  due_source text,       -- TASK, SCHEDULE, WORKFLOW_SLA_PROVISIONAL, NOTICE, MINUTES_REVIEW or ACTION; null when
                         -- there is no due date (AMB-010, AMB-246: only where one is configured)
  since_at timestamptz,
  code text,             -- 2045: a non-sensitive code or type (DEC-22), or null
  reason_codes text[]    -- 2045: the structured reasons of returned work (AMB-250), or null
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
       and authz.can_prepare_form_instance(i.id)

    union all
    -- S3 (ADR-016 D2, path (a)): a draft kept for the caller by form-scoped access, which they may complete
    -- without the case file. A draft they prepared and got back is the FORM_RETURNED item above instead.
    select 'MY_WORK', 'NEEDS_ACTION', 'FORM_TO_COMPLETE', 'FORM_INSTANCE', i.id, i.case_id, null, null, i.updated_at
      from forms.form_instance i
      join case_mgmt.form_instance_access a on a.instance_id = i.id, me
     where a.user_id = me.id and i.status = 'DRAFT'
       and not authz.can_view_case(i.case_id)
       and authz.can_prepare_form_instance(i.id)
       and (select e.actor_id from forms.form_event e
             where e.instance_id = i.id and e.to_status = 'PREPARED' order by e.seq desc limit 1) is distinct from me.id

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
  ),
  -- Phase 12 (2045): the purpose kinds (plan §5). Each row repeats the checks of the command it leads to, in the
  -- caller's own context; the area is set below from where the work lives. committee_id names the committee whose
  -- current seat makes the work committee work (AMB-047).
  more as (
    -- Referrals that await the caller (api.referral_queue: the matching capability of api.referral_view, 2040).
    -- Since: when the referral reached its present status.
    select null::text as area, 'NEEDS_ACTION'::text as view,
           case q.awaiting when 'SECTOR_DECISION' then 'REFERRAL_TO_APPROVE'
                           when 'SECRETARY_DECISION' then 'REFERRAL_TO_ACCEPT'
                           when 'ESCALATION_DECISION' then 'REFERRAL_ESCALATION_TO_DECIDE'
                           else 'REFERRAL_RETURNED' end as category,
           'REFERRAL'::text as target_type, r.id as target_id, r.case_id,
           null::timestamptz as due_at, null::text as due_source, coalesce(ev.occurred_at, r.updated_at) as since_at,
           case q.awaiting when 'SECRETARY_DECISION' then r.status when 'COMPLETION' then ev.event_type end as code,
           case when q.awaiting = 'COMPLETION' then ev.reason_codes end as reason_codes,
           case q.awaiting when 'SECRETARY_DECISION' then r.committee_id
                           when 'ESCALATION_DECISION' then q.escalation_committee_id end as committee_id
      from api.referral_queue() q
      join intake.referral r on r.id = q.referral_id
      left join lateral (select e.event_type, e.reason_codes, e.occurred_at from intake.referral_event e
                          where e.referral_id = r.id and e.to_status = r.status
                            and e.event_type not in ('COMMENTED', 'UPDATED')
                          order by e.occurred_at desc, e.id desc limit 1) ev on true

    union all
    -- A referral the sector returned to draft, for its preparer while they may submit it again (api.submit_referral),
    -- with the sector's structured reasons (AMB-250).
    select null, 'NEEDS_ACTION', 'REFERRAL_RETURNED', 'REFERRAL', r.id, r.case_id, null, null, ev.occurred_at,
           ev.event_type, ev.reason_codes, null
      from intake.referral r
      join lateral (select e.event_type, e.reason_codes, e.occurred_at from intake.referral_event e
                     where e.referral_id = r.id and e.event_type not in ('COMMENTED', 'UPDATED')
                     order by e.occurred_at desc, e.id desc limit 1) ev on true
     where r.status = 'DRAFT' and ev.event_type = 'SECTOR_RETURNED' and authz.can_view_referral(r.id)
       and coalesce((intake.caller_referral_capabilities(r) ->> 'may_submit')::boolean, false)

    union all
    -- A preliminary recommendation to review, never one the caller prepared (api.review_preliminary_recommendation).
    select null, 'NEEDS_ACTION', 'PRELIMINARY_TO_REVIEW', 'PRELIMINARY_REVIEW', pr.id, pr.case_id, null, null,
           pr.prepared_at, null, null, null
      from case_mgmt.preliminary_recommendation pr
      join case_mgmt.case_record c on c.id = pr.case_id, me
     where pr.status = 'AWAITING_REVIEW' and pr.prepared_by is distinct from me.id and c.records_state = 'ACTIVE'
       and authz.can_view_case(pr.case_id) and authz.has_permission('PRELIMINARY_REVIEW')

    union all
    -- One to approve, never by its preparer or reviewer (api.approve_preliminary_recommendation).
    select null, 'NEEDS_ACTION', 'PRELIMINARY_TO_APPROVE', 'PRELIMINARY_REVIEW', pr.id, pr.case_id, null, null,
           coalesce(pr.reviewed_at, pr.prepared_at), null, null, null
      from case_mgmt.preliminary_recommendation pr
      join case_mgmt.case_record c on c.id = pr.case_id, me
     where pr.status = 'AWAITING_APPROVAL' and pr.prepared_by is distinct from me.id
       and pr.reviewed_by is distinct from me.id and c.records_state = 'ACTIVE'
       and authz.can_view_preliminary_recommendation(pr.id) and authz.has_permission('PRELIMINARY_APPROVE')

    union all
    -- One the caller prepared came back, and they may prepare its next version (api.prepare_preliminary_recommendation),
    -- with the structured reasons (AMB-250). A later version, by anyone, ends it.
    select null, 'NEEDS_ACTION', 'PRELIMINARY_RETURNED', 'PRELIMINARY_REVIEW', pr.id, pr.case_id, null, null,
           coalesce(pr.approved_at, pr.reviewed_at), null, pr.return_reason_codes, null
      from case_mgmt.preliminary_recommendation pr
      join case_mgmt.proceeding p on p.id = pr.proceeding_id
      join case_mgmt.case_record c on c.id = pr.case_id, me
     where pr.status = 'RETURNED' and pr.prepared_by = me.id
       and p.status not in ('CONCLUDED', 'CANCELLED', 'SUSPENDED')
       and not exists (select 1 from case_mgmt.preliminary_recommendation x
                        where x.proceeding_id = pr.proceeding_id and x.version_no > pr.version_no)
       and c.records_state = 'ACTIVE' and coalesce(c.source_type, '') not in ('DIRECT_REFERRAL', 'DIRECT_GRIEVANCE')
       and authz.can_view_case(pr.case_id) and authz.has_permission('PRELIMINARY_PREPARE')

    union all
    -- Restricted Case Authority approvals (code: which one). Only the case's owner as its authority sees these, and
    -- they already know the case is restricted. An export waits for their consent, never on their own request
    -- (CDF-208; api.decide_restricted_export).
    select null, 'NEEDS_ACTION', 'RESTRICTED_APPROVAL', 'EXPORT', q.id, q.case_id, null, null, q.submitted_at,
           'EXPORT', null, null
      from exchange.export_request q
      join case_mgmt.case_record c on c.id = q.case_id, me
     where q.status = 'SUBMITTED' and c.is_restricted and c.owner_id = me.id and q.requested_by <> me.id
       and authz.is_restricted_case_authority(me.id, c.classification)
       and exchange.authority_approval_required(q.id)
       and not exists (select 1 from exchange.restricted_export_approval a where a.request_id = q.id)
       and authz.can_view_export(q.id)

    union all
    -- An adopted package whose rules require a legal review, not yet approved or requested in its current round, with
    -- someone else able to give the opinion (DEC-F20; api.approve_restricted_legal_review).
    select null, 'NEEDS_ACTION', 'RESTRICTED_APPROVAL', 'RECOMMENDATION_PACKAGE', p.id, p.case_id, null, null,
           p.adopted_at, 'LEGAL_REVIEW', null, null
      from decision.recommendation_package p
      join case_mgmt.case_record c on c.id = p.case_id, me
     where p.status = 'ADOPTED' and c.is_restricted and c.owner_id = me.id and c.records_state = 'ACTIVE'
       and authz.is_restricted_case_authority(me.id, c.classification)
       and authz.can_view_recommendation_package(p.id)
       and decision.legal_review_required(p.id) and not decision.package_tainted(p.id)
       and not exists (select 1 from decision.legal_review_request r
                        where r.package_id = p.id and r.package_round = p.round_no
                          and r.status in ('ASSIGNED', 'OPINION_GIVEN'))
       and not exists (select 1 from decision.restricted_legal_review_approval a
                        where a.package_id = p.id and a.legal_review_request_id is null and a.package_round = p.round_no)
       and exists (select 1 from iam.user_profile u
                    where u.status = 'ACTIVE' and u.id <> me.id
                      and authz.user_has_permission(u.id, 'LEGAL_OPINION_GIVE') and authz.user_case_gate(u.id, p.case_id))

    union all
    -- A grievance no current Grievance Committee secretary may handle yet, while one could be named (G2b;
    -- api.approve_restricted_grievance_handling).
    select null, 'NEEDS_ACTION', 'RESTRICTED_APPROVAL', 'GRIEVANCE', g.id, g.case_id, null, null, g.recorded_at,
           'GRIEVANCE_HANDLING', null, null
      from grievance.grievance g
      join case_mgmt.case_record c on c.id = g.case_id, me
     where g.status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED')
       and c.is_restricted and c.owner_id = me.id
       and authz.is_restricted_case_authority(me.id, c.classification) and authz.can_view_case(g.case_id)
       and not exists (select 1 from committee.membership s
                        where s.committee_id = grievance.committee_id()
                          and s.seat in ('SECRETARY', 'ALTERNATE_SECRETARY')
                          and s.effective_from <= now() and (s.effective_to is null or s.effective_to > now())
                          and authz.user_can_handle_grievance(s.user_id, g.id))
       and exists (select 1 from committee.membership s
                    where s.committee_id = grievance.committee_id() and s.user_id <> me.id
                      and coalesce(authz.user_committee_seat(s.user_id, grievance.committee_id(), now())
                                   in ('SECRETARY', 'ALTERNATE_SECRETARY'), false)
                      and authz.user_case_gate(s.user_id, g.case_id))

    union all
    -- A meeting the caller sits in during the next seven days, as long as they still take part in it (informational,
    -- like INTERVIEW_SOON): not excluded as a witness, no declared conflict, not replaced, not excused, and a member
    -- only while they hold a seat (AMB-047).
    select null, 'DUE_SOON', 'MEETING_TO_ATTEND', 'MEETING', m.id, m.case_id, m.scheduled_start, 'SCHEDULE',
           mp.added_at, null, null, cp.committee_id
      from committee.meeting_participant mp
      join committee.meeting m on m.id = mp.meeting_id
      join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id, me
     where mp.user_id = me.id and m.status = 'SCHEDULED'
       and m.scheduled_start between now() and now() + interval '7 days'
       and authz.can_view_meeting(m.id)
       and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id)
       and mp.coi_status <> 'CONFLICT_DECLARED' and not committee.is_replaced_member(mp.id)
       and mp.attendance not in ('ABSENT', 'EXCUSED', 'EXCUSED_CONFLICT')
       and (mp.participant_kind <> 'MEMBER' or committee.member_seat_current(mp.id))

    union all
    -- A conflict-of-interest declaration the caller still owes for an active meeting (api.declare_meeting_conflict
    -- and api.declare_no_conflict on their own row).
    select null, 'NEEDS_ACTION', 'COI_TO_DECLARE', 'MEETING', m.id, m.case_id, null, null, mp.added_at, null, null,
           cp.committee_id
      from committee.meeting_participant mp
      join committee.meeting m on m.id = mp.meeting_id
      join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id, me
     where mp.user_id = me.id and m.status in ('SCHEDULED', 'OPEN') and mp.requires_coi and mp.coi_status = 'PENDING'
       and authz.can_view_meeting(m.id)
       and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id)
       and (mp.participant_kind <> 'MEMBER' or committee.member_seat_current(mp.id))

    union all
    -- Raised conflicts the caller decides (DEC-F04 decider; api.decide_meeting_conflict), one row per meeting
    -- (code: the seat they decide as). Not while a vote item of the meeting is undecided.
    select null, 'NEEDS_ACTION', 'CONFLICT_CONCERN_TO_DECIDE', 'MEETING', m.id, m.case_id, null, null,
           min(c.raised_at), min(authz.meeting_concern_decider_seat(c.id)), null, cp.committee_id
      from committee.meeting_conflict_concern c
      join committee.meeting m on m.id = c.meeting_id
      join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
      join case_mgmt.case_record k on k.id = m.case_id
     where c.status = 'OPEN' and m.status in ('SCHEDULED', 'OPEN') and k.records_state = 'ACTIVE'
       and authz.can_view_meeting_concern(c.id) and authz.meeting_concern_decider_seat(c.id) is not null
       and not exists (select 1 from committee.vote_item vi where vi.meeting_id = m.id and vi.status <> 'CLOSED')
     group by m.id, m.case_id, cp.committee_id

    union all
    -- Open vote items the caller may vote on and has not (api.cast_vote), one row per meeting. Never on a re-vote
    -- that excludes them (DEC-AMB-013).
    select null, 'NEEDS_ACTION', 'VOTE_OPEN', 'MEETING', m.id, m.case_id, null, null, min(vi.opened_at), null, null,
           cp.committee_id
      from committee.vote_item vi
      join committee.meeting m on m.id = vi.meeting_id
      join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
      join committee.meeting_participant mp on mp.meeting_id = m.id, me
     where mp.user_id = me.id and mp.participant_kind = 'MEMBER' and m.status = 'OPEN' and vi.status = 'OPEN'
       and (mp.is_voting or committee.is_activated_alternate(mp.id))
       and not committee.is_replaced_member(mp.id) and committee.member_seat_current(mp.id)
       and mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT'
       and authz.can_view_meeting_deliberation(m.id)
       and not decision.revote_excluded(vi.package_id, vi.package_round, me.id)
       and not exists (select 1 from committee.vote v where v.vote_item_id = vi.id and v.participant_id = mp.id)
     group by m.id, m.case_id, cp.committee_id

    union all
    -- Minutes in review that the caller reviews and has not (api.review_minutes). Due: the configured review period.
    select null, 'NEEDS_ACTION', 'MINUTES_TO_REVIEW', 'MINUTES', mi.id, mi.case_id, mi.review_due_at,
           case when mi.review_due_at is null then null else 'MINUTES_REVIEW' end, mi.generated_at, null, null,
           cp.committee_id
      from committee.minutes mi
      join committee.meeting m on m.id = mi.meeting_id
      join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id, me
     where mi.status = 'IN_REVIEW' and authz.can_view_meeting_deliberation(mi.meeting_id)
       and committee.minutes_reviewer(mi.meeting_id, me.id) and authz.user_case_gate(me.id, mi.case_id)
       and not exists (select 1 from committee.minutes_review r where r.minutes_id = mi.id and r.reviewer_id = me.id)

    union all
    -- A legal review assigned to the caller, while they may give the opinion (api.give_legal_opinion). A tainted
    -- package waits for its committee (DEC-AMB-003), so it is not work yet.
    select null, 'NEEDS_ACTION', 'LEGAL_REVIEW_ASSIGNED', 'LEGAL_REVIEW', lr.id, lr.case_id, null, null,
           lr.requested_at, null, null, null
      from decision.legal_review_request lr, me
     where lr.assigned_to = me.id and lr.status = 'ASSIGNED' and authz.has_permission('LEGAL_OPINION_GIVE')
       and authz.user_case_gate(me.id, lr.case_id) and not decision.package_tainted(lr.package_id)

    union all
    -- The caller's own notices as a linked employee (api.acknowledge_defence_notice; code: the notice's kind).
    select null, 'NEEDS_ACTION', 'NOTICE_TO_ACKNOWLEDGE', 'DEFENCE_NOTICE', n.id, n.case_id, null, null,
           coalesce(n.delivered_at, n.issued_at), n.kind, null, null
      from grievance.defence_notice n
     where n.status = 'ISSUED' and n.kind in ('RIGHTS', 'DECISION') and authz.is_portal_subject(n.subject_id)

    union all
    -- A defence notice still open for the caller's response (api.submit_defence_response). While its period is
    -- suspended there is no due date (code SUSPENDED).
    select null, 'NEEDS_ACTION', 'DEFENCE_DUE', 'DEFENCE_NOTICE', n.id, n.case_id,
           case when n.suspended_at is null then n.due_at end,
           case when n.suspended_at is null and n.due_at is not null then 'NOTICE' end,
           coalesce(n.delivered_at, n.issued_at), case when n.suspended_at is not null then 'SUSPENDED' end, null, null
      from grievance.defence_notice n
     where n.kind = 'DEFENCE' and n.status in ('ISSUED', 'ACKNOWLEDGED') and authz.is_portal_subject(n.subject_id)

    union all
    -- Grievances that await the caller (api.grievance_queue: the matching capability of api.grievance_view, 2040;
    -- code: the grievance's kind).
    select null, 'NEEDS_ACTION',
           case q.awaiting when 'ASSESSMENT' then 'GRIEVANCE_RECEIVED'
                           when 'ADMISSIBILITY_DECISION' then 'ADMISSIBILITY_TO_DECIDE'
                           else 'GRIEVANCE_OUTCOME_TO_RECORD' end,
           'GRIEVANCE', g.id, g.case_id, null, null,
           case when q.awaiting = 'ASSESSMENT' then g.recorded_at else g.updated_at end, g.kind, null,
           grievance.committee_id()
      from api.grievance_queue() q
      join grievance.grievance g on g.id = q.grievance_id

    union all
    -- An export stage the caller may approve (api.decide_export, by exchange.eligible_approvers: never the requester,
    -- an earlier approver or a rule author).
    select null, 'NEEDS_ACTION', 'EXPORT_TO_APPROVE', 'EXPORT', q.id, q.case_id, null, null, st.since_at, null, null,
           null
      from exchange.export_request q
      cross join lateral (select 1 + count(*)::int as stage, coalesce(max(a.decided_at), q.submitted_at) as since_at
                            from exchange.export_approval a where a.request_id = q.id) st, me
     where q.status = 'SUBMITTED' and authz.can_view_export(q.id)
       and st.stage <= greatest(q.approvals_required, exchange.approvals_required(q.id))
       and exists (select 1 from exchange.eligible_approvers(q.id, st.stage) e where e.user_id = me.id)

    union all
    -- A corrective action the caller acts for (owner, or a member of its unit or pool) while it may move
    -- (api.record_corrective_action_progress, api.submit_corrective_action_completion). Returned or reopened since
    -- the last completion: ACTION_RETURNED. A frozen action is not work until it is disposed of (DEC-AMB-014).
    select null, 'NEEDS_ACTION',
           case when lst.event_type in ('RETURNED', 'REOPENED') then 'ACTION_RETURNED' else 'ACTION_ASSIGNED' end,
           'CORRECTIVE_ACTION', a.id, a.case_id, a.due_date::timestamptz,
           case when a.due_date is null then null else 'ACTION' end,
           case when lst.event_type in ('RETURNED', 'REOPENED') then lst.created_at else coalesce(asg.created_at, a.created_at) end,
           a.action_type, null, null
      from decision.corrective_action a
      left join lateral (select e.event_type, e.created_at from decision.corrective_action_event e
                          where e.action_id = a.id
                            and e.event_type in ('PROGRESS', 'COMPLETION_SUBMITTED', 'RETURNED', 'REOPENED')
                          order by e.created_at desc, e.id desc limit 1) lst on true
      left join lateral (select max(e.created_at) as created_at from decision.corrective_action_event e
                          where e.action_id = a.id
                            and e.event_type in ('OPENED', 'OWNER_CHANGED', 'OWNER_KIND_CHANGED')) asg on true, me
     where a.status in ('OPEN', 'IN_PROGRESS') and authz.can_view_corrective_action(a.id)
       and coalesce(decision.acts_for_action(a, me.id), false) and authz.has_permission('CORRECTIVE_ACTION_OWN')
       and authz.user_case_gate(me.id, a.case_id) and decision.action_block(a.id) is null

    union all
    -- A completion to verify, never by the action's owner or whoever submitted it (api.verify_corrective_action).
    select null, 'NEEDS_ACTION', 'ACTION_TO_VERIFY', 'CORRECTIVE_ACTION', a.id, a.case_id, null, null,
           a.completion_submitted_at, a.action_type, null, null
      from decision.corrective_action a, me
     where a.status = 'PENDING_VERIFICATION' and a.owner_id is distinct from me.id
       and authz.can_view_corrective_action(a.id)
       and authz.has_permission('CORRECTIVE_ACTION_MANAGE') and authz.can_view_case(a.case_id)
       and decision.action_block(a.id) is null
       and not exists (select 1 from decision.corrective_action_event e
                        where e.action_id = a.id and e.event_type = 'COMPLETION_SUBMITTED' and e.actor_id = me.id)

    union all
    -- An action frozen by a superseded decision, for a corrective-action manager of the case to dispose of under the
    -- replacement decision (DEC-AMB-014; api.dispose_superseded_corrective_action).
    select null, 'NEEDS_ACTION', 'ACTION_TO_DISPOSE', 'CORRECTIVE_ACTION', a.id, a.case_id, null, null,
           coalesce((select max(s.superseded_at) from decision.authority_decision_supersession s
                      where s.decision_id = decision.action_governing_decision(a.id)), a.updated_at),
           a.action_type, null, null
      from decision.corrective_action a
      join case_mgmt.case_record c on c.id = a.case_id
     where c.records_state = 'ACTIVE' and authz.can_view_corrective_action(a.id)
       and authz.has_permission('CORRECTIVE_ACTION_MANAGE') and authz.can_view_case(a.case_id)
       and decision.action_block(a.id) = 'FROZEN_BY_SUPERSEDED_DECISION'

    union all
    -- A continuity import to decide, never by its importer, the workbook's preparer or an offline recorder, on the
    -- batch as submitted (api.decide_bcp_import).
    select null, 'NEEDS_ACTION', 'IMPORT_TO_APPROVE', 'BCP_IMPORT', b.id, b.case_id, null, null, b.submitted_at,
           null, null, null
      from exchange.bcp_import_batch b, me
     where b.status = 'SUBMITTED' and authz.can_view_bcp_import(b.id) and authz.has_permission('BCP_IMPORT_APPROVE')
       and b.imported_by <> me.id and b.prepared_by is distinct from me.id
       and not exists (select 1 from exchange.bcp_import_row x where x.batch_id = b.id and x.recorded_offline_by = me.id)
       and exchange.bcp_batch_hash(b.id) = b.submitted_hash
  )
  select coalesce(i.area,
                  case when i.committee_id is not null
                            and authz.user_committee_seat(authz.current_user_id(), i.committee_id, now()) is not null
                         then 'COMMITTEE'
                       when i.case_id is not null and authz.can_view_case(i.case_id) then 'CASES'
                       else 'MY_WORK' end),
         i.view, i.category, i.target_type, i.target_id,
         case when i.case_id is not null and authz.can_view_case_metadata(i.case_id) then i.case_id end,
         case when i.case_id is not null and authz.can_view_case_metadata(i.case_id) then c.case_number end,
         i.due_at, i.due_source, i.since_at,
         -- DEC-22: a form row also carries its form's code, a non-sensitive type.
         coalesce(i.code, f.form_code), i.reason_codes
    from (select x.area, x.view, x.category, x.target_type, x.target_id, x.case_id, x.due_at, x.due_source,
                 x.since_at, null::text as code, null::text[] as reason_codes, null::uuid as committee_id
            from items x
          union all
          select * from more) i
    left join case_mgmt.case_record c on c.id = i.case_id
    left join forms.form_instance f on i.target_type = 'FORM_INSTANCE' and f.id = i.target_id
   where authz.current_user_id() is not null
   order by (i.due_at is null), i.due_at, i.since_at, i.target_id;
$$;
grant execute on function api.my_work_items() to authenticated;
comment on function api.my_work_items() is
  'My Work (migrations 1820 to 2045): the caller''s own work, each row only where the command it leads to would accept '
  'the caller now. Ids, codes and dates only (DEC-22); the case number only with case-metadata visibility.';

-- -----------------------------------------------------------------------------
-- 2. The sidebar: My Committees «لجاني» and the widened Administration
-- -----------------------------------------------------------------------------
-- From 2020, with two gates changed and nothing else:
--   * My Committees (COMMITTEE) shows for a current seat on any committee: an ACTIVE user, effective now
--     (authz.user_committee_seat; ADR-030, My Committees from effective seats; AMB-047, work follows the seat). The
--     plan's second basis, a proceeding membership, opens nothing on its own: since 2030 a snapshotted member reads
--     a proceeding only while still seated (AMB-039), so it would show an empty area.
--   * Administration shows for the business administration permissions whose commands would accept the caller
--     (plan §2): user, role, committee, sector and notification-rule administration, export policy through
--     authz.is_export_policy_admin (never whoever holds an export approval permission, 2040), corrective-action
--     policy and the business-day calendar. CLEARANCE_ADMIN and the finding-vocabulary administrator come with
--     their own migrations (2160, 2150).
-- Neither area opens a case or any case content. Administration still never counts; My Committees counts its own
-- work like any area.
create or replace function api.my_areas()
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
      -- A CASE or AUDIT grant on a case the caller can open. Since S3 (DEC-02) COMMITTEE and REVIEW grants open
      -- no case, so they never show Cases; form-scoped access shows My Work only.
      exists (select 1 from case_mgmt.case_access_grant g, me
               where g.user_id = me.id and g.status = 'ACTIVE' and g.scope in ('CASE', 'AUDIT')
                 and g.effective_from <= now() and (g.effective_to is null or g.effective_to > now())
                 and authz.can_view_case(g.case_id)) as case_grant,
      -- A TRIAGE grant opens its case until hand-over (S3, DEC-03: the grant ends then; the S1 display rule is now
      -- the enforced one).
      exists (select 1 from case_mgmt.case_access_grant g, me
               where g.user_id = me.id and g.status = 'ACTIVE' and g.scope = 'TRIAGE'
                 and g.effective_from <= now() and (g.effective_to is null or g.effective_to > now())
                 and authz.case_before_handover(g.case_id) and authz.can_view_case(g.case_id)) as triage_before_handover,
      exists (select 1 from case_mgmt.case_access_grant g, me
               where g.user_id = me.id and authz.has_active_grant(g.case_id, me.id)) as any_grant,
      exists (select 1 from case_mgmt.form_instance_access fa, me
               where fa.user_id = me.id and authz.can_view_form_instance(fa.instance_id)) as form_access,
      exists (select 1 from case_mgmt.case_task t, me
               where t.assigned_user_id = me.id and t.status in ('OPEN', 'IN_PROGRESS') and t.expires_at > now()) as task,
      exists (select 1 from records.case_record_catalogue k where authz.can_view_records_catalogue(k.case_id)) as catalogue_row,
      -- 2045: a current seat on any committee.
      exists (select 1 from committee.membership m, me
               where m.user_id = me.id and authz.user_committee_seat(me.id, m.committee_id, now()) is not null) as seated
  ),
  gates as (
    select 'MY_WORK'::text as area_code,
           (exists (select 1 from iam.role_permission rp
                      join iam.user_role_assignment ura on ura.role_code = rp.role_code, me
                     where ura.user_id = me.id and ura.status = 'ACTIVE'
                       and ura.effective_from <= current_date
                       and (ura.effective_to is null or ura.effective_to >= current_date)
                       -- Rebase (1870+): administration permissions (*_ADMIN: committee seats, sectors, notification
                       -- rules) produce no personal work, so they do not show My Work on their own.
                       and rp.permission_code not in ('AUDIT_VIEW', 'SECURITY_EVENT_VIEW', 'ARCHIVE_RECORD_VIEW')
                       and rp.permission_code not like '%\_ADMIN')
            or l.assigned or l.any_grant or l.form_access or l.task or exists (select 1 from work)) as shown,
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
    -- 2045: My Committees «لجاني».
    select 'COMMITTEE', l.seated, 'committees', 4 from live l
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
    -- 2045: widened to the business administration permissions (plan §2). The default view is the first page the
    -- caller may use, in the plan's order.
    select 'ADMINISTRATION',
           authz.has_permission('USER_ADMIN') or authz.has_permission('ROLE_ADMIN')
           or authz.has_permission('COMMITTEE_ADMIN') or authz.has_permission('SECTOR_ADMIN')
           or authz.has_permission('NOTIFICATION_ADMIN') or authz.is_export_policy_admin()
           or authz.has_permission('CORRECTIVE_ACTION_POLICY_ADMIN') or authz.has_permission('BUSINESS_CALENDAR_ADMIN'),
           case when authz.has_permission('USER_ADMIN') or authz.has_permission('ROLE_ADMIN') then 'users'
                when authz.has_permission('COMMITTEE_ADMIN') then 'committees'
                when authz.has_permission('SECTOR_ADMIN') then 'sectors'
                when authz.has_permission('NOTIFICATION_ADMIN') then 'notification-rules'
                when authz.is_export_policy_admin() then 'export-policy'
                when authz.has_permission('CORRECTIVE_ACTION_POLICY_ADMIN') then 'corrective-action-policy'
                else 'calendar' end, 7
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

-- -----------------------------------------------------------------------------
-- 3. What a committee referral would copy (DEC-F19; coordinator ruling, 2026-10-14)
-- -----------------------------------------------------------------------------
-- The Proceedings tab's referral confirmation. The same checks as api.refer_case_to_committee come first, in its
-- order and with its refusals (case_mgmt.lock_editable_case, then the active committee), without taking a lock.
-- Then the committee as the referral would copy it now (committee.open_committee_proceeding's snapshot: current
-- seats of ACTIVE users): the number of holders per seat, and four totals: voting, cleared for the case, not
-- cleared (copied as excluded, without access) and firewall restricted (on a grievance, a member who sat on this
-- case's Investigation Committee). No id, no name and no flag per seat: a flag on a single-holder seat would
-- disclose that person's clearance or conflict. The totals are those the referral records in
-- COMMITTEE_PROCEEDING_OPENED. Other refusals of the referral (the restricted-case approval, the preliminary review,
-- an open proceeding, the rule set) are the command's own, at submit.
create function api.committee_referral_preview(p_case_id uuid, p_committee_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_c committee.committee;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_edit_case(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  if exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state <> 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  select * into v_c from committee.committee c where c.id = p_committee_id and c.is_active;
  if v_c.id is null then perform api._fail('INVALID', 'committee_id'); end if;
  return (
    with held as (
      select m.seat, authz.user_case_gate(m.user_id, p_case_id) as cleared,
             v_c.kind = 'GRIEVANCE' and authz.participated_in_investigation_committee(m.user_id, p_case_id) as sat_on_ic
        from committee.membership m
        join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
       where m.committee_id = v_c.id and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now())
    )
    select jsonb_build_object(
             'seats', coalesce((select jsonb_agg(jsonb_build_object('seat', s.seat, 'count', s.n)
                                                 order by array_position(array['CHAIR', 'DEPUTY_CHAIR', 'SECRETARY',
                                                   'ALTERNATE_SECRETARY', 'MEMBER', 'ALTERNATE_MEMBER'], s.seat))
                                  from (select h.seat, count(*)::int as n from held h group by h.seat) s), '[]'::jsonb),
             'voting', count(*) filter (where h.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER') and h.cleared
                                          and not h.sat_on_ic),
             'cleared', count(*) filter (where h.cleared),
             'not_cleared', count(*) filter (where not h.cleared),
             'firewall_restricted', count(*) filter (where h.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER') and h.cleared
                                                       and h.sat_on_ic))
      from held h
  );
end;
$$;
grant execute on function api.committee_referral_preview(uuid, uuid) to authenticated;
comment on function api.committee_referral_preview(uuid, uuid) is
  'What a committee referral would copy now (DEC-F19; coordinator ruling 2026-10-14): holders per seat and the voting, '
  'cleared, not cleared and firewall-restricted totals, behind the referral command''s own checks. No id, name or '
  'per-seat flag. Read-only.';

-- -----------------------------------------------------------------------------
-- 4. Case history: the 1870 events (coordinator, 13:24 and 13:25)
-- -----------------------------------------------------------------------------
-- From 1850. The case structure, proceeding, evidence-link and restricted-referral events of 1870 join the
-- allowlist, each for whoever may read what it is about, as its table's policy reads it:
--   * PROCEEDING (opened, state changed, closed): authz.can_view_proceeding;
--   * COMMITTEE_PROCEEDING (opened): authz.can_view_committee_proceeding;
--   * CASE_STRUCTURE (a person, an allegation, an allegation's person): the case's readers, as case_subject and
--     allegation are read;
--   * FINDING: a case-file basis (2020's finding_read: a TRIAGE grantee before hand-over sees no findings);
--   * EVIDENCE_LINK: whoever may see the linked item (authz.can_view_evidence, as evidence_link is read);
--   * RESTRICTED_REFERRAL: the case's owner as its Restricted Case Authority, and whoever recorded it. The rest of
--     the case team learns of the referral from the proceeding events.
-- They show as codes and times only: no actor, reason, person or detail.
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
           authz.has_permission('LEGAL_HOLD_APPLY') or authz.has_permission('ARCHIVE_RECORD_ADMINISTER') as records_audience,
           -- 2045
           authz.has_case_file_basis(p_case_id) as file_basis,
           exists (select 1 from case_mgmt.case_record c
                    where c.id = p_case_id and c.owner_id = authz.current_user_id()
                      and authz.is_restricted_case_authority(authz.current_user_id(), c.classification)) as case_authority
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
             when e.action in ('EVIDENCE_RECEIVED', 'EVIDENCE_STORED', 'EVIDENCE_REJECTED',
                               'EVIDENCE_RESTRICTION_CHANGED') then 'EVIDENCE'
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
             -- 2045: the 1870 events.
             when e.action in ('PROCEEDING_OPENED', 'PROCEEDING_STATE_CHANGED', 'PROCEEDING_CLOSED') then 'PROCEEDING'
             when e.action = 'COMMITTEE_PROCEEDING_OPENED' then 'COMMITTEE_PROCEEDING'
             when e.action in ('CASE_SUBJECT_ADDED', 'ALLEGATION_ADDED', 'ALLEGATION_SUBJECT_LINKED') then 'CASE_STRUCTURE'
             when e.action = 'FINDING_RECORDED' then 'FINDING'
             when e.action = 'EVIDENCE_LINKED' then 'EVIDENCE_LINK'
             when e.action = 'RESTRICTED_COMMITTEE_REFERRAL_APPROVED' then 'RESTRICTED_REFERRAL'
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
             -- DEC-06: the conversation's own readers. DEC-09: the reporter's files, their own rule.
             when 'REPORTER_MESSAGE' then authz.can_read_reporter_conversation(
                                            case when ev.object_type = 'report' then ev.object_id
                                                 else ev.metadata ->> 'report_id' end::uuid)
             when 'REPORTER_FILE' then authz.can_view_report_files(
                                         case when ev.object_type = 'report' then ev.object_id
                                              else ev.metadata ->> 'report_id' end::uuid)
             when 'HOLD_STATUS' then true
             when 'RECORDS' then me.records_audience or (ev.actor_type = 'USER' and ev.actor_id = me.id)
             -- 2045: as each object's own policy reads it.
             when 'PROCEEDING' then case when ev.object_type = 'proceeding'
                                         then authz.can_view_proceeding(ev.object_id::uuid) else false end
             when 'COMMITTEE_PROCEEDING' then case when ev.object_type = 'committee_proceeding'
                                                   then authz.can_view_committee_proceeding(ev.object_id::uuid)
                                                   else false end
             when 'CASE_STRUCTURE' then true
             when 'FINDING' then me.file_basis
             when 'EVIDENCE_LINK' then authz.can_view_evidence((ev.metadata ->> 'evidence_id')::uuid)
             when 'RESTRICTED_REFERRAL' then me.case_authority or (ev.actor_type = 'USER' and ev.actor_id = me.id)
             else false
           end
  ),
  masked as (
    select s.seq, s.occurred_at, s.action,
           -- Hold status reaches the case team without who placed or released it, or why (DEC-10).
           -- 2045: the 1870 events show as codes and times only.
           case when s.actor_type <> 'USER' then false
                when s.audience = 'HOLD_STATUS' then s.records_audience or s.by_me
                when s.audience in ('PROCEEDING', 'COMMITTEE_PROCEEDING', 'CASE_STRUCTURE', 'FINDING', 'EVIDENCE_LINK',
                                    'RESTRICTED_REFERRAL') then false
                else true end as show_actor,
           case when s.audience = 'HOLD_STATUS' then s.records_audience or s.by_me
                when s.audience = 'TEAM_CHANGE' then s.roster_full or s.about_me or s.by_me
                when s.audience in ('PROCEEDING', 'COMMITTEE_PROCEEDING', 'CASE_STRUCTURE', 'FINDING', 'EVIDENCE_LINK',
                                    'RESTRICTED_REFERRAL') then false
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
           when 'EVIDENCE_RESTRICTION_CHANGED' then jsonb_build_object(
             'item', (m.metadata ->> 'sequence_no')::int, 'restriction', m.metadata ->> 'to')
         end
    from masked m
    left join iam.user_profile a on a.id = m.actor_id
    left join iam.user_profile p on m.show_subject and p.id::text = m.subject_text
   order by m.seq desc
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;
comment on function api.case_history(uuid, int) is
  'The case''s business history for its team (ADR-016 D5, DEC-08/DEC-10): actor access, action audience, object '
  'entitlement, classification. No page views; hold status without its details. Since 2045 also the 1870 case '
  'structure, proceeding, evidence-link and restricted-referral events, as codes and times only, each to whoever may '
  'read its object.';
