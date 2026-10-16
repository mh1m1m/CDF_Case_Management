-- =============================================================================
-- 2099 Findings of an allegation that has left the case: a subject correction and a withdrawal (CDF-247; ADR-045,
--      ADR-057)
-- Requirements: AMB-027 and AMB-033 (ADR-045 §2 and §4), CDF-213 (ADR-042: nothing new names a withdrawn allegation),
-- ADR-059 (2092: a superseded allegation is left out as a withdrawn one is), DEC-F20 (a restricted case's legal review
-- approval). §19, §87. Linear CDF-247 (integrity LOW), found by UX while building 2095's read model. Number and
-- content from the coordinator (2026-10-16 08:53 and 08:57): each point enforces a condition already decided, fails
-- closed and grants nothing.
--
-- Before:
--   1. api.correct_case_subject (2090) was refused only while a finding named the wrong subject
--      (SUBJECT_HAS_FINDINGS). An open allegation about them could still carry a finding naming nobody (recorded while
--      the allegation had no subject, linked afterwards) or naming another subject of the case. The correction then
--      superseded that allegation with its finding, and the finding stayed in the committee's scope
--      (decision.finding_in_committee_scope; R1, api.committee_scope_choices). A split already refuses such an
--      allegation (ALLEGATION_HAS_FINDINGS).
--   2. api.open_vote_item (2060) and api.request_legal_review (2030) accepted a finding of a withdrawn allegation, and
--      api.approve_restricted_legal_review (2030) could name one, although R1 (2060) leaves it out and CDF-213 refuses
--      an item naming the allegation itself. On a restricted case, 2095's choices (L2,
--      api.legal_review_choices) listed exactly the approval's findings, such a finding too.
--
-- After:
--   1. The correction is also refused with CONFLICT:ALLEGATION_HAS_FINDINGS while any open allegation about the wrong
--      subject carries a finding, whoever it names; SUBJECT_HAS_FINDINGS is kept and answered first. So no superseded
--      allegation carries a finding, and the committee's scope, R1, the vote, the legal review and 2095's choices need
--      no change for SUPERSEDED.
--   2. The three commands refuse a finding of a withdrawn allegation with CONFLICT:ALLEGATION_WITHDRAWN, the code
--      CDF-213, api.record_finding and api.link_allegation_subject already use, right after their INVALID finding
--      check. decision.finding_in_committee_scope is unchanged (the check is in the commands). L2 leaves such a finding
--      out of a restricted approval's scope (§4), so every finding it lists is accepted; no other read mirrors these
--      commands' findings.
--
-- Each function is replaced with the same signature, owner and grants; each body is its predecessor's with the one
-- check and a comment line added. Every other check, its order and its refusal are unchanged. No table, policy, grant
-- or audit change; nothing is dropped or renamed. Rows written before 2099 are not rewritten.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The subject correction (2090, ADR-045 §4)
-- -----------------------------------------------------------------------------
-- 2090's command; also refused with CONFLICT:ALLEGATION_HAS_FINDINGS while an open allegation about the wrong subject
-- carries any finding (the check a split makes), after SUBJECT_HAS_FINDINGS.
create or replace function api.correct_case_subject(p_subject_id uuid, p_correct_subject_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_wrong case_mgmt.case_subject;
  v_reason text;
  v_link grievance.subject_portal_link;
  v_notice grievance.defence_notice;
  v_a case_mgmt.allegation;
  v_links int := 0;
  v_withdrawn int := 0;
  v_superseded int := 0;
  v_sent int;
  v_id uuid;
  v_incident uuid;
begin
  select * into v_wrong from case_mgmt.case_subject s where s.id = p_subject_id;
  if v_wrong.id is null or not authz.can_view_case(v_wrong.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform case_mgmt.lock_editable_case(v_wrong.case_id);
  if p_correct_subject_id is null or p_correct_subject_id = v_wrong.id
     or not exists (select 1 from case_mgmt.case_subject s where s.id = p_correct_subject_id and s.case_id = v_wrong.case_id)
     or case_mgmt.subject_status(p_correct_subject_id) = 'MISIDENTIFIED' then
    perform api._fail('INVALID', 'correct_subject_id');
  end if;
  if case_mgmt.subject_status(v_wrong.id) = 'MISIDENTIFIED' then perform api._fail('CONFLICT', 'SUBJECT_MISIDENTIFIED'); end if;
  if exists (select 1 from case_mgmt.finding f where f.subject_id = v_wrong.id) then
    perform api._fail('CONFLICT', 'SUBJECT_HAS_FINDINGS');
  end if;
  -- 2099 (CDF-247): as a split, an allegation re-stated about the correct subject carries no finding, whoever it names.
  if exists (select 1 from case_mgmt.allegation a
             join case_mgmt.finding f on f.allegation_id = a.id
             where a.subject_id = v_wrong.id and a.status = 'OPEN') then
    perform api._fail('CONFLICT', 'ALLEGATION_HAS_FINDINGS');
  end if;
  if exists (select 1 from decision.recommendation_item_subject r where r.subject_id = v_wrong.id)
     or exists (select 1 from decision.recommendation_item_allegation r
                join case_mgmt.allegation a on a.id = r.allegation_id
                where a.subject_id = v_wrong.id and a.status = 'OPEN') then
    perform api._fail('CONFLICT', 'SUBJECT_IN_RECOMMENDATION');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);

  -- The wrong person's portal access ends now.
  for v_link in select * from grievance.subject_portal_link l
                where l.subject_id = v_wrong.id and l.revoked_at is null for update loop
    update grievance.subject_portal_link set revoked_by = v_actor, revoked_at = now() where id = v_link.id;
    perform audit.record_event('SUBJECT_PORTAL_UNLINKED', 'BUSINESS', 'SUCCESS', v_wrong.case_id, 'subject_portal_link',
      v_link.id::text, null, jsonb_build_object('subject_id', v_wrong.id, 'basis', 'SUBJECT_CORRECTION'));
    v_links := v_links + 1;
  end loop;

  -- Every notice ever issued to them counts as sent; the open ones are withdrawn and their delivery tasks closed.
  select count(*)::int into v_sent from grievance.defence_notice n where n.subject_id = v_wrong.id;
  for v_notice in select * from grievance.defence_notice n
                  where n.subject_id = v_wrong.id and n.status in ('ISSUED', 'ACKNOWLEDGED')
                  order by n.sequence_no for update loop
    update grievance.defence_notice set status = 'WITHDRAWN', closed_at = now() where id = v_notice.id;
    update grievance.notice_delivery_task set status = 'DONE', closed_at = now(), closed_by = v_actor
     where notice_id = v_notice.id and status = 'OPEN';
    perform audit.record_event('EMPLOYEE_NOTICE_WITHDRAWN', 'BUSINESS', 'SUCCESS', v_wrong.case_id, 'defence_notice',
      v_notice.id::text, null, jsonb_build_object('subject_id', v_wrong.id, 'kind', v_notice.kind,
                                                  'basis', 'SUBJECT_CORRECTION'));
    v_withdrawn := v_withdrawn + 1;
  end loop;

  -- Open allegations about the wrong person are re-stated about the correct one; the originals stay, SUPERSEDED.
  for v_a in select * from case_mgmt.allegation a
             where a.subject_id = v_wrong.id and a.status = 'OPEN' order by a.created_at, a.id for update loop
    perform case_mgmt.successor_allegation(v_a, v_a.case_id, v_a.category, v_a.description, p_correct_subject_id,
                                           v_a.policy_reference, v_a.law_reference, v_actor);
    perform case_mgmt.close_allegation(v_a, 'SUPERSEDED', 'SUBJECT_CORRECTION', v_reason, v_actor);
    v_superseded := v_superseded + 1;
  end loop;

  perform case_mgmt.append_subject_status(v_wrong.case_id, v_wrong.id, 'MISIDENTIFIED', v_reason, v_actor);
  insert into case_mgmt.subject_correction (case_id, wrong_subject_id, correct_subject_id, reason, links_revoked,
                                            notices_withdrawn, allegations_superseded, corrected_by)
  values (v_wrong.case_id, v_wrong.id, p_correct_subject_id, v_reason, v_links, v_withdrawn, v_superseded, v_actor)
  returning id into v_id;
  perform audit.record_event('SUBJECT_CORRECTED', 'BUSINESS', 'SUCCESS', v_wrong.case_id, 'subject_correction', v_id::text,
    null, jsonb_build_object('wrong_subject_id', v_wrong.id, 'correct_subject_id', p_correct_subject_id,
                             'links_revoked', v_links, 'notices_withdrawn', v_withdrawn,
                             'allegations_superseded', v_superseded, 'privacy_incident', v_sent > 0));
  if v_sent > 0 then
    insert into case_mgmt.privacy_incident (case_id, correction_id, kind, notices_sent, recorded_by)
    values (v_wrong.case_id, v_id, 'NOTICE_TO_MISIDENTIFIED_SUBJECT', v_sent, v_actor)
    returning id into v_incident;
    perform audit.record_event('PRIVACY_INCIDENT_RECORDED', 'SECURITY', 'SUCCESS', v_wrong.case_id, 'privacy_incident',
      v_incident::text, null, jsonb_build_object('kind', 'NOTICE_TO_MISIDENTIFIED_SUBJECT', 'correction_id', v_id,
                                                 'notices_sent', v_sent));
  end if;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. A FINDING vote (2060, CDF-214)
-- -----------------------------------------------------------------------------
-- 2060's command; a finding of a withdrawn allegation is refused with CONFLICT:ALLEGATION_WITHDRAWN after the INVALID
-- check. decision.finding_in_committee_scope is unchanged.
create or replace function api.open_vote_item(p_meeting_id uuid, p_target_type text, p_finding_id uuid, p_title text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.meeting;
  v_id uuid;
  v_seq int;
begin
  v_m := committee.lock_managed_meeting(p_meeting_id);
  if v_m.status <> 'OPEN' then perform api._fail('CONFLICT', 'MEETING_NOT_OPEN'); end if;
  if p_target_type is null or p_target_type not in ('FINDING', 'OTHER') then
    perform api._fail('INVALID', 'target_type');
  end if;
  -- CDF-214: a finding in the committee's scope only (its current version, in the committee proceeding or the one it
  -- was referred from).
  if (p_target_type = 'FINDING') <> (p_finding_id is not null)
     or (p_finding_id is not null and not exists (
           select 1 from case_mgmt.finding f where f.id = p_finding_id and f.case_id = v_m.case_id))
     or (p_finding_id is not null
         and not decision.finding_in_committee_scope(p_finding_id, v_m.committee_proceeding_id)) then
    perform api._fail('INVALID', 'finding_id');
  end if;
  -- 2099 (CDF-247): never a finding of a withdrawn allegation (as R1 and CDF-213).
  if p_finding_id is not null and exists (select 1 from case_mgmt.finding f
                                          join case_mgmt.allegation a on a.id = f.allegation_id
                                          where f.id = p_finding_id and a.status = 'WITHDRAWN') then
    perform api._fail('CONFLICT', 'ALLEGATION_WITHDRAWN');
  end if;
  select coalesce(max(vi.sequence_no), 0) + 1 into v_seq from committee.vote_item vi where vi.meeting_id = v_m.id;
  insert into committee.vote_item (meeting_id, case_id, sequence_no, target_type, finding_id, title, opened_by)
  values (v_m.id, v_m.case_id, v_seq, p_target_type, p_finding_id, api._require_text(p_title, 'title', 3, 300), v_actor)
  returning id into v_id;
  perform audit.record_event('VOTE_OPENED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'vote_item', v_id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'sequence_no', v_seq, 'target_type', p_target_type, 'finding_id', p_finding_id));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. The legal review and a restricted case's approval of it (2030, DEC-F20)
-- -----------------------------------------------------------------------------
-- 2030's commands; a finding of a withdrawn allegation is refused with CONFLICT:ALLEGATION_WITHDRAWN after the INVALID
-- finding_ids check, by the request and by the approval alike, so an approval never names a finding the request then
-- refuses. A finding an approval named before its allegation was withdrawn is left out of the request; the approval
-- still covers the rest (the request may send less than the approval names). The 3-argument approval (2030) delegates
-- here with an empty scope and is unchanged.
create or replace function api.request_legal_review(
  p_package_id uuid, p_assigned_to uuid, p_reason text, p_finding_ids uuid[], p_minutes_ids uuid[]
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_req uuid;
  v_packet uuid;
  v_findings uuid[] := coalesce(p_finding_ids, '{}');
  v_minutes uuid[] := coalesce(p_minutes_ids, '{}');
  v_classification core.classification_level;
  v_items int;
  v_approval decision.restricted_legal_review_approval;
begin
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status <> 'ADOPTED' then perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED'); end if;
  if exists (select 1 from decision.legal_review_request r
             where r.package_id = v_p.id and r.package_round = v_p.round_no and r.status = 'ASSIGNED') then
    perform api._fail('CONFLICT', 'LEGAL_REVIEW_OPEN');
  end if;
  if decision.package_tainted(v_p.id) then perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT'); end if;
  -- The reviewer holds the opinion permission and is cleared for the case; never the requester.
  if p_assigned_to is null or p_assigned_to = v_actor
     or not authz.user_has_permission(p_assigned_to, 'LEGAL_OPINION_GIVE')
     or not authz.user_case_gate(p_assigned_to, v_p.case_id) then
    perform api._fail('INVALID', 'assigned_to');
  end if;
  if exists (select 1 from unnest(v_findings) x
             where not exists (select 1 from case_mgmt.finding f where f.id = x and f.case_id = v_p.case_id))
     or (select count(distinct x) from unnest(v_findings) x) <> cardinality(v_findings) then
    perform api._fail('INVALID', 'finding_ids');
  end if;
  -- 2099 (CDF-247): never a finding of a withdrawn allegation (as R1 and CDF-213).
  if exists (select 1 from unnest(v_findings) x
             join case_mgmt.finding f on f.id = x
             join case_mgmt.allegation a on a.id = f.allegation_id
             where a.status = 'WITHDRAWN') then
    perform api._fail('CONFLICT', 'ALLEGATION_WITHDRAWN');
  end if;
  if exists (select 1 from unnest(v_minutes) x
             where not exists (select 1 from committee.minutes mi
                               join committee.meeting m on m.id = mi.meeting_id
                               where mi.id = x and m.committee_proceeding_id = v_p.committee_proceeding_id
                                 and mi.status in ('APPROVED', 'DEEMED_APPROVED')))
     or (select count(distinct x) from unnest(v_minutes) x) <> cardinality(v_minutes) then
    perform api._fail('INVALID', 'minutes_ids');
  end if;
  select c.classification into v_classification from case_mgmt.case_record c where c.id = v_p.case_id;
  -- AGENT-09 W2, DEC-F20: a restricted case needs its authority's unused approval for this round naming this reviewer,
  -- and the approval must name every finding and minutes sent.
  if exists (select 1 from case_mgmt.case_record c where c.id = v_p.case_id and c.is_restricted) then
    select a.* into v_approval from decision.restricted_legal_review_approval a
    where a.package_id = v_p.id and a.legal_review_request_id is null and a.reviewer_id = p_assigned_to
      and a.package_round = v_p.round_no
    for update;
    if v_approval.id is null then perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_REQUIRED'); end if;
    if not (v_findings <@ v_approval.finding_ids) or not (v_minutes <@ v_approval.minutes_ids) then
      perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_SCOPE_EXCEEDED');
    end if;
  end if;

  insert into decision.legal_review_request (package_id, case_id, package_round, basis, assigned_to, reason, requested_by)
  values (v_p.id, v_p.case_id, v_p.round_no,
          case when decision.legal_review_required(v_p.id) then 'RULE' else 'SECRETARY_ELECTED' end,
          p_assigned_to, api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_req;
  if v_approval.id is not null then
    update decision.restricted_legal_review_approval set legal_review_request_id = v_req, used_at = now()
     where id = v_approval.id;
  end if;
  insert into decision.packet (case_id, committee_proceeding_id, package_id, purpose, legal_review_request_id,
                               classification, created_by)
  values (v_p.case_id, v_p.committee_proceeding_id, v_p.id, 'LEGAL_REVIEW', v_req, v_classification, v_actor)
  returning id into v_packet;
  insert into decision.packet_item (packet_id, position, item_kind, source_id, snapshot)
  select v_packet, row_number() over (order by k, at, id), kind, id, snap
  from (
    select 1 as k, i.added_at as at, i.id, 'RECOMMENDATION_ITEM' as kind,
           decision.item_snapshot(i.id) || decision.item_snapshot_extra(i.id) as snap
    from decision.recommendation_item i
    where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
    union all
    select 2, f.recorded_at, f.id, 'FINDING',
           jsonb_build_object('result', f.result, 'rationale', f.rationale, 'version_no', f.version_no,
                              'allegation_id', f.allegation_id, 'allegation_category', a.category, 'subject_id', f.subject_id)
    from case_mgmt.finding f join case_mgmt.allegation a on a.id = f.allegation_id
    where f.id = any (v_findings)
    union all
    select 3, mi.generated_at, mi.id, 'MINUTES',
           jsonb_build_object('version_no', mi.version_no, 'status', mi.status, 'narrative', mi.narrative,
                              'vote_items', mi.snapshot -> 'vote_items')
    from committee.minutes mi where mi.id = any (v_minutes)
  ) s;
  get diagnostics v_items = row_count;
  update decision.recommendation_package set status = 'IN_LEGAL_REVIEW', updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event('LEGAL_REVIEW_REQUESTED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'legal_review_request', v_req::text,
    null, jsonb_build_object('package_id', v_p.id, 'round_no', v_p.round_no, 'assigned_to', p_assigned_to,
                             'packet_id', v_packet, 'restricted_approval_id', v_approval.id));
  perform audit.record_event('PACKET_CREATED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'packet', v_packet::text, null,
    jsonb_build_object('purpose', 'LEGAL_REVIEW', 'items', v_items, 'findings', cardinality(v_findings),
                       'minutes', cardinality(v_minutes)));
  return v_req;
end;
$$;

create or replace function api.approve_restricted_legal_review(
  p_package_id uuid, p_reviewer_id uuid, p_finding_ids uuid[], p_minutes_ids uuid[], p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_case case_mgmt.case_record;
  v_findings uuid[] := coalesce(p_finding_ids, '{}');
  v_minutes uuid[] := coalesce(p_minutes_ids, '{}');
  v_id uuid;
  v_reason text;
begin
  if p_package_id is null or not authz.can_view_recommendation_package(p_package_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_p from decision.recommendation_package p where p.id = p_package_id for update;
  select * into v_case from case_mgmt.case_record c where c.id = v_p.case_id;
  if not v_case.is_restricted then perform api._fail('CONFLICT', 'CASE_NOT_RESTRICTED'); end if;
  if v_case.owner_id is distinct from v_actor
     or not authz.is_restricted_case_authority(v_actor, v_case.classification) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_case.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
  if v_p.status <> 'ADOPTED' then perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED'); end if;
  if p_reviewer_id is null or p_reviewer_id = v_actor
     or not authz.user_has_permission(p_reviewer_id, 'LEGAL_OPINION_GIVE')
     or not authz.user_case_gate(p_reviewer_id, v_p.case_id) then
    perform api._fail('INVALID', 'reviewer_id');
  end if;
  if exists (select 1 from unnest(v_findings) x
             where not exists (select 1 from case_mgmt.finding f where f.id = x and f.case_id = v_p.case_id))
     or (select count(distinct x) from unnest(v_findings) x) <> cardinality(v_findings) then
    perform api._fail('INVALID', 'finding_ids');
  end if;
  -- 2099 (CDF-247): never a finding of a withdrawn allegation (as R1 and CDF-213).
  if exists (select 1 from unnest(v_findings) x
             join case_mgmt.finding f on f.id = x
             join case_mgmt.allegation a on a.id = f.allegation_id
             where a.status = 'WITHDRAWN') then
    perform api._fail('CONFLICT', 'ALLEGATION_WITHDRAWN');
  end if;
  if exists (select 1 from unnest(v_minutes) x
             where not exists (select 1 from committee.minutes mi
                               join committee.meeting m on m.id = mi.meeting_id
                               where mi.id = x and m.committee_proceeding_id = v_p.committee_proceeding_id
                                 and mi.status in ('APPROVED', 'DEEMED_APPROVED')))
     or (select count(distinct x) from unnest(v_minutes) x) <> cardinality(v_minutes) then
    perform api._fail('INVALID', 'minutes_ids');
  end if;
  if exists (select 1 from decision.restricted_legal_review_approval a
             where a.package_id = v_p.id and a.legal_review_request_id is null and a.package_round = v_p.round_no) then
    perform api._fail('CONFLICT', 'APPROVAL_ALREADY_PENDING');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  insert into decision.restricted_legal_review_approval (case_id, package_id, reviewer_id, approved_by, reason,
                                                         package_round, finding_ids, minutes_ids)
  values (v_p.case_id, v_p.id, p_reviewer_id, v_actor, v_reason, v_p.round_no, v_findings, v_minutes)
  returning id into v_id;
  perform audit.record_event('RESTRICTED_LEGAL_REVIEW_APPROVED', 'BUSINESS', 'SUCCESS', v_p.case_id,
    'restricted_legal_review_approval', v_id::text, v_reason,
    jsonb_build_object('package_id', v_p.id, 'reviewer_id', p_reviewer_id, 'classification', v_case.classification,
                       'round_no', v_p.round_no, 'findings', cardinality(v_findings), 'minutes', cardinality(v_minutes)));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. The legal review choices on a restricted case (2095, L2; ADR-057)
-- -----------------------------------------------------------------------------
-- 2095's read; on a restricted request it lists the approval's findings less those of an allegation withdrawn since the
-- approval, which api.request_legal_review now refuses (§3), so every finding it lists is still accepted. The rest of
-- the approval still goes: the request may send less than the approval names. Unchanged otherwise, with the same
-- signature, owner, grant and audit.
create or replace function api.legal_review_choices(p_package_id uuid, p_act text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_case case_mgmt.case_record;
  v_code text;
  v_approval decision.restricted_legal_review_approval;
  v_restricted boolean;
  v_scoped boolean := false;
  v_mode text := decision.committee_label_mode();
  v_reviewers jsonb;
  v_findings jsonb;
  v_minutes jsonb;
begin
  if p_act is null or p_act not in ('REQUEST', 'APPROVE') then perform api._fail('INVALID', 'act'); end if;
  if p_act = 'REQUEST' then
    v_code := decision.legal_review_request_refusal(p_package_id);
    if v_code in ('NOT_FOUND', 'FORBIDDEN') then perform api._fail(v_code); end if;
    if v_code is not null then perform api._fail('CONFLICT', v_code); end if;
    select * into v_p from decision.recommendation_package p where p.id = p_package_id;
    select * into v_case from case_mgmt.case_record c where c.id = v_p.case_id;
    -- On a restricted case the request takes exactly the unused approval of the round: its reviewer and scope.
    if v_case.is_restricted then
      v_scoped := true;
      select a.* into v_approval from decision.restricted_legal_review_approval a
      where a.package_id = v_p.id and a.legal_review_request_id is null and a.package_round = v_p.round_no;
    end if;
  else
    if p_package_id is null or not authz.can_view_recommendation_package(p_package_id) then
      perform api._fail('NOT_FOUND');
    end if;
    select * into v_p from decision.recommendation_package p where p.id = p_package_id;
    select * into v_case from case_mgmt.case_record c where c.id = v_p.case_id;
    if not v_case.is_restricted then perform api._fail('CONFLICT', 'CASE_NOT_RESTRICTED'); end if;
    if v_case.owner_id is distinct from v_actor
       or not authz.is_restricted_case_authority(v_actor, v_case.classification) then
      perform api._fail('FORBIDDEN');
    end if;
    if v_case.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
    if v_p.status <> 'ADOPTED' then perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED'); end if;
    if exists (select 1 from decision.restricted_legal_review_approval a
               where a.package_id = v_p.id and a.legal_review_request_id is null and a.package_round = v_p.round_no) then
      perform api._fail('CONFLICT', 'APPROVAL_ALREADY_PENDING');
    end if;
  end if;
  v_restricted := v_case.is_restricted;

  -- The reviewer: holds LEGAL_OPINION_GIVE (an active account and assignment), never the caller. Not filtered by the
  -- case gate (DEC-F19, ruling 1). On a restricted request, the approval's reviewer only.
  select coalesce(jsonb_agg(jsonb_build_object('user_id', u.id, 'display_name', u.display_name,
                                               'display_name_ar', u.display_name_ar)
                            order by u.display_name collate "C", u.id), '[]'::jsonb)
    into v_reviewers
  from iam.user_profile u
  where u.id <> v_actor
    and authz.user_has_permission(u.id, 'LEGAL_OPINION_GIVE')
    and (not v_scoped or u.id = v_approval.reviewer_id);

  -- The findings: the committee's scope (decision.finding_in_committee_scope, an allegation not withdrawn), or on a
  -- restricted request the approval's findings of the case, less a withdrawn allegation's (2099, CDF-247).
  select coalesce(jsonb_agg(jsonb_build_object(
           'finding_id', f.id, 'version_no', f.version_no, 'result', f.result,
           'proceeding_role', case when f.proceeding_id = cp.proceeding_id then 'COMMITTEE'
                                   when f.proceeding_id = pr.parent_proceeding_id then 'REFERRED'
                                   else 'OTHER' end,
           'allegation', jsonb_build_object('allegation_id', a.id, 'position', a.position, 'category', a.category),
           'subject', case when f.subject_id is not null then decision.subject_choice(f.subject_id, v_mode, true) end)
         order by a.position, f.recorded_at, f.id), '[]'::jsonb)
    into v_findings
  from case_mgmt.finding f
  join (select x.*, row_number() over (order by x.created_at, x.id) as position
        from case_mgmt.allegation x where x.case_id = v_p.case_id) a on a.id = f.allegation_id
  join committee.committee_proceeding cp on cp.id = v_p.committee_proceeding_id
  join case_mgmt.proceeding pr on pr.id = cp.proceeding_id
  where f.case_id = v_p.case_id
    and case when v_scoped then f.id = any (coalesce(v_approval.finding_ids, '{}'::uuid[])) and a.status <> 'WITHDRAWN'
             else a.status <> 'WITHDRAWN' and decision.finding_in_committee_scope(f.id, cp.id) end;

  -- The minutes: approved or deemed approved, of a meeting of the package's proceeding; on a restricted request, those
  -- the approval names.
  select coalesce(jsonb_agg(jsonb_build_object(
           'minutes_id', mi.id, 'meeting_id', m.id, 'meeting_sequence_no', m.sequence_no, 'version_no', mi.version_no,
           'status', mi.status, 'finalised_at', mi.finalised_at)
         order by m.sequence_no, mi.version_no, mi.id), '[]'::jsonb)
    into v_minutes
  from committee.minutes mi
  join committee.meeting m on m.id = mi.meeting_id
  where m.committee_proceeding_id = v_p.committee_proceeding_id and mi.status in ('APPROVED', 'DEEMED_APPROVED')
    and (not v_scoped or mi.id = any (coalesce(v_approval.minutes_ids, '{}'::uuid[])));

  perform audit.record_event('LEGAL_REVIEW_CHOICES_VIEWED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'recommendation_package',
    v_p.id::text, null,
    jsonb_build_object('act', p_act, 'restricted', v_restricted, 'reviewers', jsonb_array_length(v_reviewers),
                       'findings', jsonb_array_length(v_findings), 'minutes', jsonb_array_length(v_minutes)));
  return jsonb_build_object(
    'act', p_act,
    'package', jsonb_build_object('package_id', v_p.id, 'committee_proceeding_id', v_p.committee_proceeding_id,
                                  'sequence_no', v_p.sequence_no, 'round_no', v_p.round_no, 'status', v_p.status),
    'label_mode', v_mode,
    'restricted', v_restricted,
    -- What the packet will carry besides: the package's adopted items.
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('item_id', i.id, 'item_type', i.item_type, 'sanction_code', i.sanction_code)
                       order by i.added_at, i.id)
      from decision.recommendation_item i
      where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'), '[]'::jsonb),
    'reviewers', v_reviewers,
    'findings', v_findings,
    'minutes', v_minutes);
end;
$$;
comment on function api.legal_review_choices(uuid, text) is
  'What a legal review may be asked for (REQUEST, the committee''s secretary) or approved with (APPROVE, the case '
  'owner as the restricted case''s authority) on one adopted package (migration 2095, ADR-057): the reviewers on the '
  'seat basis (every active holder of LEGAL_OPINION_GIVE but the caller, not filtered by the case gate), the findings '
  'of the committee''s scope and the proceeding''s approved minutes; on a restricted request, the approval''s '
  'reviewer and scope (less a withdrawn allegation''s findings, migration 2099), never its reason. Checked in the '
  'command''s order; a refusal raises its code. Audited LEGAL_REVIEW_CHOICES_VIEWED with counts only.';
