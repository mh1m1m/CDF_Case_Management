-- =============================================================================
-- 1850 S2 evidence need-to-know (UX redesign S2; ADR-016 D6; DEC-09; audit UX-072, RI-11)
--
-- Seeing a case no longer means seeing its evidence. Evidence follows the investigation team's working
-- relationship with the case, classification and clearance, and the item's own restriction (DEC-09):
--   TEAM items   the case manager (CASE_EDIT_ALL) on cases it can view; the case's active owner, lead investigator
--                and investigators; an active CASE-scope access grant; an approved, active break-glass (ADR-014 D5).
--   LEADS items  the case manager, the case's owner and its lead investigator only.
-- Everyone else gets nothing, as for an item that does not exist, whatever else they can see of the case:
-- TRIAGE, COMMITTEE, REVIEW and AUDIT grant holders, REVIEWER assignments, the GRC Director's CASE_VIEW_ALL
-- oversight, legal, records, administrators, internal audit, SOC and DPO. Legal, GRC, committee and decision
-- users get evidence only through a purpose packet (S5); until then they get none. Records gets lifecycle
-- metadata only (the catalogue and the disposition manifest), never an item, its content or its download.
--
-- The reporter's files (intake.report_attachment, ADR-015) follow the same rule once a case exists, plus the
-- triage officer's TRIAGE grant, which DEC-03 ends at hand-over (S3). Before a case nothing changes.
--
-- Changes:
--   * evidence.evidence.restriction ('TEAM' by default, or 'LEADS');
--   * authz.is_evidence_team, authz.is_evidence_lead, authz.can_view_report_files;
--   * authz.can_view_evidence adds the relationship and the restriction (the evidence, version and custody
--     policies, the interview recording links, downloads and history all use it);
--   * authz.can_download_report_attachment and the report_attachment_read policy use the reporter-files rule;
--   * api.register_evidence_version: a new version only of an item the caller may see;
--   * api.set_evidence_restriction (audited); opening an item to the team is refused once the case is archived;
--   * api.case_history: the restriction event joins the evidence audience; reporter-file events follow the
--     reporter-files rule.
-- Downloads stay can_view_evidence AND EVIDENCE_DOWNLOAD. Nothing here reads the identity vault.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The evidence restriction (ADR-016 D6, "evidence-specific restrictions")
-- -----------------------------------------------------------------------------
alter table evidence.evidence
  add column restriction text not null default 'TEAM' check (restriction in ('TEAM', 'LEADS'));
comment on column evidence.evidence.restriction is
  'Who on the case team sees the item (DEC-09): TEAM, or LEADS (case manager, owner, lead investigator). Changed only by api.set_evidence_restriction.';

-- -----------------------------------------------------------------------------
-- The rules
-- -----------------------------------------------------------------------------
-- The investigation team's working relationship with the case. Seeing the case is not enough.
create function authz.is_evidence_team(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id)
     and (authz.has_permission('CASE_EDIT_ALL')
          or authz.has_active_assignment(p_case_id, authz.current_user_id(),
                                         array['CASE_OWNER', 'LEAD_INVESTIGATOR', 'INVESTIGATOR'])
          or exists (select 1 from case_mgmt.case_access_grant g
                      where g.case_id = p_case_id and g.user_id = authz.current_user_id() and g.status = 'ACTIVE'
                        and g.scope = 'CASE' and g.effective_from <= now()
                        and (g.effective_to is null or g.effective_to > now()))
          or authz.has_active_break_glass(p_case_id, authz.current_user_id()));
$$;

-- Those who direct the investigation: they see LEADS items and set the restriction.
create function authz.is_evidence_lead(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id)
     and (authz.has_permission('CASE_EDIT_ALL')
          or authz.has_active_assignment(p_case_id, authz.current_user_id(), array['CASE_OWNER', 'LEAD_INVESTIGATOR']));
$$;

create or replace function authz.can_view_evidence(p_evidence_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from evidence.evidence e
     where e.id = p_evidence_id
       and e.classification <= authz.current_clearance()
       and case e.restriction when 'LEADS' then authz.is_evidence_lead(e.case_id)
                              else authz.is_evidence_team(e.case_id) end
  );
$$;

-- The reporter's files: intake before a case; the investigation team, and triage while its TRIAGE grant lasts,
-- after it.
create function authz.can_view_report_files(p_report_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from intake.report r
     where r.id = p_report_id
       and authz.current_user_id() is not null
       and case when r.case_id is null then authz.can_view_report(r.id)
                else authz.is_evidence_team(r.case_id)
                     or (authz.can_view_case(r.case_id)
                         and exists (select 1 from case_mgmt.case_access_grant g
                                      where g.case_id = r.case_id and g.user_id = authz.current_user_id()
                                        and g.status = 'ACTIVE' and g.scope = 'TRIAGE' and g.effective_from <= now()
                                        and (g.effective_to is null or g.effective_to > now()))) end
  );
$$;

revoke all on function authz.is_evidence_team(uuid), authz.is_evidence_lead(uuid),
  authz.can_view_report_files(uuid) from public;
grant execute on function authz.is_evidence_team(uuid), authz.is_evidence_lead(uuid),
  authz.can_view_report_files(uuid) to authenticated;

alter policy report_attachment_read on intake.report_attachment
  using (authz.can_view_report_files(report_id));

-- Download: the scan gate, the reporter-files rule, and a download right (evidence download once a case exists).
create or replace function authz.can_download_report_attachment(p_attachment_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from intake.report_attachment a
    join intake.report r on r.id = a.report_id
    where a.id = p_attachment_id
      and a.status = 'AVAILABLE'
      and authz.can_view_report_files(r.id)
      and case when r.case_id is null then authz.has_permission('INTAKE_VIEW')
               else authz.has_permission('EVIDENCE_DOWNLOAD') end
  );
$$;

-- -----------------------------------------------------------------------------
-- Commands
-- -----------------------------------------------------------------------------
create or replace function api.register_evidence_version(
  p_case_id uuid, p_evidence_id uuid, p_title text, p_description text, p_evidence_type text,
  p_source_description text, p_collected_at date, p_classification core.classification_level,
  p_original_file_name text, p_content_type text, p_size_bytes bigint, p_sha256 text
)
returns table (o_evidence_id uuid, o_version_id uuid, o_version_no int, o_object_key text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_ev evidence.evidence;
  v_file text;
  v_version_id uuid;
  v_version_no int;
  v_key text;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_upload_evidence(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  -- Locking the case serialises sequence and version numbering.
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;

  -- File facts (third validation after the browser and the application layer, §45)
  v_file := api._require_text(p_original_file_name, 'file_name', 1, 255);
  if v_file ~ '[/\\]' or v_file ~ '[[:cntrl:]]' or v_file ~ '^\.+$' then perform api._fail('INVALID', 'file_name'); end if;
  if not exists (select 1 from evidence.allowed_content_type t where t.content_type = p_content_type) then
    perform api._fail('INVALID', 'content_type');
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 26214400 then perform api._fail('INVALID', 'size_bytes'); end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then perform api._fail('INVALID', 'sha256'); end if;

  if p_evidence_id is null then
    -- New evidence item
    if p_evidence_type is null or p_evidence_type not in ('DOCUMENT', 'IMAGE', 'AUDIO', 'VIDEO', 'EMAIL', 'DATA_EXPORT', 'OTHER') then
      perform api._fail('INVALID', 'evidence_type');
    end if;
    if p_description is not null and length(p_description) > 2000 then perform api._fail('INVALID', 'description'); end if;
    if p_source_description is not null and length(p_source_description) > 500 then perform api._fail('INVALID', 'source_description'); end if;
    if p_collected_at is not null and p_collected_at > current_date then perform api._fail('INVALID', 'collected_at'); end if;
    if p_classification is null or p_classification < v_case.classification or p_classification > authz.current_clearance() then
      perform api._fail('INVALID', 'classification');
    end if;
    insert into evidence.evidence (case_id, sequence_no, title, description, evidence_type, source_description, collected_at,
                                   classification, created_by)
    values (p_case_id,
            (select coalesce(max(e.sequence_no), 0) + 1 from evidence.evidence e where e.case_id = p_case_id),
            api._require_text(p_title, 'title', 3, 200), nullif(btrim(coalesce(p_description, '')), ''), p_evidence_type,
            nullif(btrim(coalesce(p_source_description, '')), ''), p_collected_at, p_classification, v_actor)
    returning * into v_ev;
    v_version_no := 1;
  else
    -- New version of an existing item on this case
    select * into v_ev from evidence.evidence e where e.id = p_evidence_id and e.case_id = p_case_id for update;
    -- DEC-09: only an item the caller may see (team or leads, within clearance) takes a new version.
    if v_ev.id is null or not authz.can_view_evidence(v_ev.id) then perform api._fail('NOT_FOUND'); end if;
    if exists (select 1 from evidence.evidence_version v
               where v.evidence_id = v_ev.id and v.sha256 = p_sha256 and v.status <> 'REJECTED') then
      perform api._fail('CONFLICT', 'DUPLICATE_VERSION');
    end if;
    select coalesce(max(v.version_no), 0) + 1 into v_version_no from evidence.evidence_version v where v.evidence_id = v_ev.id;
  end if;

  v_version_id := gen_random_uuid();
  v_key := 'cases/' || p_case_id::text || '/evidence/' || v_ev.id::text || '/' || v_version_id::text;
  insert into evidence.evidence_version (id, evidence_id, version_no, object_key, original_file_name, content_type, size_bytes,
                                         sha256, uploaded_by, request_id)
  values (v_version_id, v_ev.id, v_version_no, v_key, v_file, p_content_type, p_size_bytes, p_sha256, v_actor,
          nullif(current_setting('cdf.request_id', true), '')::uuid);

  insert into evidence.custody_event (evidence_id, version_id, event_type, actor_id, request_id, details)
  values (v_ev.id, v_version_id, 'RECEIVED', v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid,
          jsonb_build_object('version_no', v_version_no, 'sha256', p_sha256, 'size_bytes', p_size_bytes, 'content_type', p_content_type));

  perform audit.record_event('EVIDENCE_RECEIVED', 'BUSINESS', 'SUCCESS', p_case_id, 'evidence_version', v_version_id::text, null,
    jsonb_build_object('evidence_id', v_ev.id, 'sequence_no', v_ev.sequence_no, 'version_no', v_version_no, 'sha256', p_sha256,
                       'size_bytes', p_size_bytes, 'content_type', p_content_type, 'new_item', p_evidence_id is null));

  return query select v_ev.id, v_version_id, v_version_no, v_key;
end;
$$;


-- Limit an item to the case leads, or open it to the team again (audited, with a reason).
create function api.set_evidence_restriction(p_evidence_id uuid, p_restriction text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ev evidence.evidence;
  v_reason text;
begin
  perform api._actor();
  select * into v_ev from evidence.evidence e where e.id = p_evidence_id;
  if v_ev.id is null or not authz.can_view_evidence(v_ev.id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.is_evidence_lead(v_ev.case_id) then perform api._fail('FORBIDDEN'); end if;
  if p_restriction is null or p_restriction not in ('TEAM', 'LEADS') then perform api._fail('INVALID', 'restriction'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 500);
  if v_ev.restriction = p_restriction then perform api._fail('CONFLICT', 'RESTRICTION_UNCHANGED'); end if;
  -- Opening an item adds access, which an archived case never gains (as for assignments and grants, 1320).
  if p_restriction = 'TEAM' and exists (select 1 from case_mgmt.case_record c
                                         where c.id = v_ev.case_id and c.records_state not in ('ACTIVE', 'CLOSED')) then
    perform api._fail('CONFLICT', 'RECORDS_READ_ONLY');
  end if;
  update evidence.evidence set restriction = p_restriction, updated_at = now() where id = v_ev.id;
  perform audit.record_event('EVIDENCE_RESTRICTION_CHANGED', 'BUSINESS', 'SUCCESS', v_ev.case_id, 'evidence',
    v_ev.id::text, v_reason,
    jsonb_build_object('evidence_id', v_ev.id, 'sequence_no', v_ev.sequence_no, 'from', v_ev.restriction,
                       'to', p_restriction));
end;
$$;

revoke all on function api.set_evidence_restriction(uuid, text, text) from public;
grant execute on function api.set_evidence_restriction(uuid, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Case history (1840): the restriction event and the reporter's files. Only the marked parts change.
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
           when 'EVIDENCE_RESTRICTION_CHANGED' then jsonb_build_object(
             'item', (m.metadata ->> 'sequence_no')::int, 'restriction', m.metadata ->> 'to')
         end
    from masked m
    left join iam.user_profile a on a.id = m.actor_id
    left join iam.user_profile p on m.show_subject and p.id::text = m.subject_text
   order by m.seq desc
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;


comment on function authz.is_evidence_team(uuid) is
  'DEC-09: the investigation team''s working relationship with the case (case manager, owner, lead, investigators, CASE grant, break-glass).';
comment on function authz.is_evidence_lead(uuid) is
  'DEC-09: the case manager, owner and lead investigator; they see LEADS items and set the restriction.';
comment on function authz.can_view_report_files(uuid) is
  'DEC-09: the reporter''s files. Intake before a case; the investigation team, and triage while its TRIAGE grant lasts, after it.';
comment on function api.set_evidence_restriction(uuid, text, text) is
  'DEC-09: limit an evidence item to the case leads, or open it to the team again. Audited with the reason.';
