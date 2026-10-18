-- =============================================================================
-- 2117 A closed committee proceeding freezes its packages and its meetings (Rebase; CDF-226; ADR-057 amendment)
-- Requirements: §12, §19, §29, §82, §87; ADR-021, ADR-022, ADR-056, ADR-057; coordinator ruling of 2026-10-16 09:36 UTC
-- ("the authority half closes with the proceeding"); coordinator ruling of 2026-10-18 15:44 UTC (2117 split from 2120).
--
-- Before 2117 a committee proceeding could be concluded or cancelled while its work was still moving: the package
-- commands after creation and the authority half never read the proceeding's status, and api.close_proceeding left the
-- proceeding's meetings open or scheduled. R2 is already NOT_FOUND to the committee side on such a proceeding (2060),
-- so the pages offered less than the commands accepted (ADR-056 and ADR-057, "Known limitations").
--
-- Now, failing closed:
--   1. decision.lock_managed_package refuses PROCEEDING_CLOSED unless the package's committee proceeding is OPEN, and
--      holds that proceeding row (FOR SHARE) until the command ends, so a closure cannot slip in between the check and
--      the write. Its eleven callers inherit the refusal: add_recommendation_item, withdraw_recommendation_item,
--      submit_package_for_vote, open_package_vote, record_package_adoption, return_package_to_committee,
--      resolve_conflict_taint, request_legal_review, cancel_legal_review_request, submit_to_authority,
--      record_authority_decision.
--   2. The three commands that do not take that lock refuse the same, after their FORBIDDEN check and their locks:
--      api.approve_restricted_legal_review, api.give_legal_opinion, api.give_superseding_legal_opinion.
--   3. Their mirrors answer the same, so every flag still equals its command: decision.manages_package (2086),
--      decision.managed_package_refusal (2095), decision.legal_opinion_refusal and decision.superseding_opinion_refusal
--      (2100), and the APPROVE branch of api.legal_review_choices (2099). Everything built on the first two inherits:
--      decision.package_capabilities, package_vote_meetings, taint_resolutions, legal_review_request_refusal,
--      legal_review_cancel_refusal, submit_refusal, record_refusal.
--   4. api.close_proceeding: a committee proceeding leaves OPEN only when nothing is in flight (VOTES_OPEN,
--      PACKAGE_VOTING, PACKAGE_ADOPTED, LEGAL_REVIEW_OPEN, PACKAGE_WITH_AUTHORITY, TAINTED_BY_CONFLICT,
--      OFFLINE_MEETING_PENDING); then its open meetings close and its scheduled meetings are cancelled in the same
--      transaction, each with its own event (CDF-226).
-- Nothing is widened: no grant, table, policy or read model gains anything; a refusal is only added. No data changes:
-- meetings already left open on a proceeding closed before 2117 stay as they are (their package commands refuse now).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The proceeding check (internal; not granted)
-- -----------------------------------------------------------------------------
-- True when the package's committee proceeding is OPEN. Used by the mirrors (stable, no lock).
create function decision.package_proceeding_open(p_package_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from decision.recommendation_package p
                 join committee.committee_proceeding cp on cp.id = p.committee_proceeding_id
                 where p.id = p_package_id and cp.status = 'OPEN');
$$;

-- The commands' check: PROCEEDING_CLOSED unless the package's committee proceeding is OPEN, holding the proceeding row
-- FOR SHARE until the transaction ends. api.close_proceeding takes that row FOR UPDATE before it checks what is in
-- flight, so either the command's write is seen by the closure's checks, or the command waits and then sees the
-- proceeding closed. Lock order as api.open_package_vote: meeting, package, proceeding.
create function decision.require_package_proceeding_open(p_package_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from committee.committee_proceeding cp
   where cp.id = (select p.committee_proceeding_id from decision.recommendation_package p where p.id = p_package_id)
     and cp.status = 'OPEN'
   for share;
  if not found then perform api._fail('CONFLICT', 'PROCEEDING_CLOSED'); end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. The package lock (1900): PROCEEDING_CLOSED after CASE_NOT_ACTIVE
-- -----------------------------------------------------------------------------
create or replace function decision.lock_managed_package(p_package_id uuid)
returns decision.recommendation_package
language plpgsql
set search_path = ''
as $$
declare v decision.recommendation_package;
begin
  if p_package_id is null or not authz.can_view_recommendation_package(p_package_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_manage_recommendation_package(p_package_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v from decision.recommendation_package p where p.id = p_package_id for update;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  perform decision.require_package_proceeding_open(v.id);
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. The three commands that do not take the package lock (as 2100, the proceeding checked after FORBIDDEN)
-- -----------------------------------------------------------------------------
-- The case's Restricted Case Authority approves a restricted legal review: after CASE_NOT_ACTIVE.
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
  perform decision.require_package_proceeding_open(v_p.id);
  if v_p.status <> 'ADOPTED' then perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED'); end if;
  if p_reviewer_id is null or p_reviewer_id = v_actor
     or not authz.user_has_permission(p_reviewer_id, 'LEGAL_OPINION_GIVE')
     or not authz.user_packet_gate(p_reviewer_id, v_p.case_id) then
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

-- The assigned reviewer's opinion: after the package and the request are locked, before the request's own states.
create or replace function api.give_legal_opinion(p_request_id uuid, p_opinion text, p_opinion_text text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r decision.legal_review_request;
  v_status text;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_packet_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_packet_gate(v_actor, v_r.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  perform 1 from decision.recommendation_package p where p.id = v_r.package_id for update;
  select * into v_r from decision.legal_review_request r where r.id = p_request_id for update;
  perform decision.require_package_proceeding_open(v_r.package_id);
  if v_r.status = 'CANCELLED' then perform api._fail('CONFLICT', 'REQUEST_CANCELLED'); end if;
  if v_r.status <> 'ASSIGNED' then perform api._fail('CONFLICT', 'OPINION_ALREADY_GIVEN'); end if;
  if decision.package_tainted(v_r.package_id) then perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT'); end if;
  if p_opinion is null or p_opinion not in ('CONCURS', 'CONCURS_WITH_COMMENTS', 'CONFLICTS') then
    perform api._fail('INVALID', 'opinion');
  end if;
  update decision.legal_review_request
     set status = 'OPINION_GIVEN', opinion = p_opinion, opinion_at = now(),
         opinion_text = case when p_opinion <> 'CONCURS' or p_opinion_text is not null
                             then api._require_text(p_opinion_text, 'opinion_text', 10, 8000) end
   where id = v_r.id;
  v_status := case when p_opinion = 'CONFLICTS' then 'RETURNED_BY_LEGAL' else 'ADOPTED' end;
  update decision.recommendation_package set status = v_status, updated_at = now(), row_version = row_version + 1
   where id = v_r.package_id;
  perform audit.record_event('LEGAL_OPINION_GIVEN', 'BUSINESS', 'SUCCESS', v_r.case_id, 'legal_review_request', v_r.id::text,
    null, jsonb_build_object('package_id', v_r.package_id, 'opinion', p_opinion, 'package_status', v_status));
end;
$$;

-- The reviewer's superseding opinion: as the opinion.
create or replace function api.give_superseding_legal_opinion(p_request_id uuid, p_opinion text, p_opinion_text text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r decision.legal_review_request;
  v_p decision.recommendation_package;
  v_revision int;
  v_status text;
  v_id uuid;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_packet_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_packet_gate(v_actor, v_r.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  -- The reviewer's purpose is still open: they can still read the request's packet (AMB-119).
  if not exists (select 1 from decision.packet k where k.legal_review_request_id = v_r.id and authz.can_view_packet(k.id)) then
    perform api._fail('NOT_FOUND');
  end if;
  select * into v_p from decision.recommendation_package p where p.id = v_r.package_id for update;
  select * into v_r from decision.legal_review_request r where r.id = p_request_id for update;
  perform decision.require_package_proceeding_open(v_r.package_id);
  if v_r.status <> 'OPINION_GIVEN' then perform api._fail('CONFLICT', 'OPINION_NOT_GIVEN'); end if;
  if v_p.status <> 'ADOPTED' or v_p.round_no <> v_r.package_round then
    perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED');
  end if;
  if decision.package_tainted(v_p.id) then perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT'); end if;
  if p_opinion is null or p_opinion not in ('CONCURS', 'CONCURS_WITH_COMMENTS', 'CONFLICTS') then
    perform api._fail('INVALID', 'opinion');
  end if;
  select coalesce(max(x.revision_no), 1) + 1 into v_revision
  from decision.legal_opinion_revision x where x.request_id = v_r.id;
  insert into decision.legal_opinion_revision (request_id, package_id, case_id, package_round, revision_no, opinion,
                                               opinion_text, given_by)
  values (v_r.id, v_r.package_id, v_r.case_id, v_r.package_round, v_revision, p_opinion,
          case when p_opinion <> 'CONCURS' or p_opinion_text is not null
               then api._require_text(p_opinion_text, 'opinion_text', 10, 8000) end, v_actor)
  returning id into v_id;
  v_status := case when p_opinion = 'CONFLICTS' then 'RETURNED_BY_LEGAL' else 'ADOPTED' end;
  if v_status <> v_p.status then
    update decision.recommendation_package set status = v_status, updated_at = now(), row_version = row_version + 1
     where id = v_p.id;
  end if;
  perform audit.record_event('LEGAL_OPINION_SUPERSEDED', 'BUSINESS', 'SUCCESS', v_r.case_id, 'legal_opinion_revision',
    v_id::text, null, jsonb_build_object('request_id', v_r.id, 'package_id', v_r.package_id, 'revision_no', v_revision,
                                         'opinion', p_opinion, 'package_status', v_status));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. The mirrors: each flag still equals its command
-- -----------------------------------------------------------------------------
-- decision.lock_managed_package without its lock (2095), as the code it refuses with.
create or replace function decision.managed_package_refusal(p_package_id uuid)
returns text
language sql stable
set search_path = ''
as $$
  select case
           when p_package_id is null or not authz.can_view_recommendation_package(p_package_id) then 'NOT_FOUND'
           when not authz.can_manage_recommendation_package(p_package_id) then 'FORBIDDEN'
           when not exists (select 1 from decision.recommendation_package p
                            join case_mgmt.case_record c on c.id = p.case_id
                            where p.id = p_package_id and c.records_state = 'ACTIVE') then 'CASE_NOT_ACTIVE'
           when not decision.package_proceeding_open(p_package_id) then 'PROCEEDING_CLOSED'
         end;
$$;

-- decision.lock_managed_package without its lock (2086), as a boolean.
create or replace function decision.manages_package(p_package_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(p_package_id is not null
                  and authz.can_view_recommendation_package(p_package_id)
                  and authz.can_manage_recommendation_package(p_package_id)
                  and exists (select 1 from decision.recommendation_package p
                              join case_mgmt.case_record c on c.id = p.case_id
                              where p.id = p_package_id and c.records_state = 'ACTIVE')
                  and decision.package_proceeding_open(p_package_id), false);
$$;

-- api.give_legal_opinion's mirror (2100), the proceeding in the command's place.
create or replace function decision.legal_opinion_refusal(p_request_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_actor uuid := authz.current_user_id();
  v_r decision.legal_review_request;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_packet_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    return 'NOT_FOUND';
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_packet_gate(v_actor, v_r.case_id) then
    return 'FORBIDDEN';
  end if;
  if not decision.package_proceeding_open(v_r.package_id) then return 'PROCEEDING_CLOSED'; end if;
  if v_r.status = 'CANCELLED' then return 'REQUEST_CANCELLED'; end if;
  if v_r.status <> 'ASSIGNED' then return 'OPINION_ALREADY_GIVEN'; end if;
  if decision.package_tainted(v_r.package_id) then return 'TAINTED_BY_CONFLICT'; end if;
  return null;
end;
$$;

-- api.give_superseding_legal_opinion's mirror (2100), the proceeding in the command's place.
create or replace function decision.superseding_opinion_refusal(p_request_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_actor uuid := authz.current_user_id();
  v_r decision.legal_review_request;
  v_p decision.recommendation_package;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_packet_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    return 'NOT_FOUND';
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_packet_gate(v_actor, v_r.case_id) then
    return 'FORBIDDEN';
  end if;
  if not exists (select 1 from decision.packet k where k.legal_review_request_id = v_r.id and authz.can_view_packet(k.id)) then
    return 'NOT_FOUND';
  end if;
  select * into v_p from decision.recommendation_package p where p.id = v_r.package_id;
  if not decision.package_proceeding_open(v_r.package_id) then return 'PROCEEDING_CLOSED'; end if;
  if v_r.status <> 'OPINION_GIVEN' then return 'OPINION_NOT_GIVEN'; end if;
  if v_p.status <> 'ADOPTED' or v_p.round_no <> v_r.package_round then return 'PACKAGE_NOT_ADOPTED'; end if;
  if decision.package_tainted(v_p.id) then return 'TAINTED_BY_CONFLICT'; end if;
  return null;
end;
$$;

-- The legal review choices (2099): the APPROVE branch mirrors api.approve_restricted_legal_review, so it refuses on a
-- closed proceeding after CASE_NOT_ACTIVE, as the command does. The REQUEST branch inherits through
-- decision.legal_review_request_refusal. Same signature, owner, grant, comment and audit.
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
    if not decision.package_proceeding_open(v_p.id) then perform api._fail('CONFLICT', 'PROCEEDING_CLOSED'); end if;
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

-- -----------------------------------------------------------------------------
-- 5. Closing a proceeding (1870): the conclusion guard, then its meetings (CDF-226)
-- -----------------------------------------------------------------------------
-- As 1870 up to OPEN_CHILD_PROCEEDINGS. Then, for a committee proceeding: its meetings and its row are locked (meetings
-- first, then the proceeding, as every package command takes them), and it may leave OPEN only when nothing of its
-- work is in flight, failing closed with the first that is:
--   VOTES_OPEN              a vote item of one of its meetings is not closed;
--   PACKAGE_VOTING          a package is in its committee vote (its adoption could no longer be recorded);
--   PACKAGE_ADOPTED         a package is adopted but neither sent on nor returned to the committee;
--   LEGAL_REVIEW_OPEN       a package is in legal review, or a legal review request is still assigned;
--   PACKAGE_WITH_AUTHORITY  a package waits for the authority's decision;
--   TAINTED_BY_CONFLICT     a package has a conflict after its vote that the committee has not resolved (it needs an
--                           open meeting of the proceeding, which a closed proceeding never has again);
--   OFFLINE_MEETING_PENDING a meeting held offline (2110) still waits for its online completion; the secretary
--                           cancels it with a reason first if it is not to be completed, so no held meeting is
--                           cancelled by implication.
-- Then every OPEN meeting is CLOSED and every SCHEDULED meeting CANCELLED, by the closing actor, each with its own
-- MEETING_CLOSED or MEETING_CANCELLED event (ids and counts only; the reason stays on PROCEEDING_CLOSED), before the
-- proceeding itself. A cancellation notifies its participants as api.cancel_meeting does (notify.on_meeting). The
-- minutes of a closed meeting can still be generated and reviewed.
create or replace function api.close_proceeding(p_proceeding_id uuid, p_status text, p_outcome_code text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p case_mgmt.proceeding;
  v_cp committee.committee_proceeding;
  v_m record;
  v_reason text;
begin
  select * into v_p from case_mgmt.proceeding p where p.id = p_proceeding_id;
  if v_p.id is null or not authz.can_view_case(v_p.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform case_mgmt.lock_editable_case(v_p.case_id);
  select * into v_p from case_mgmt.proceeding p where p.id = p_proceeding_id for update;
  if v_p.status in ('CONCLUDED', 'CANCELLED') then perform api._fail('CONFLICT', 'PROCEEDING_CLOSED'); end if;
  if p_status is null or p_status not in ('CONCLUDED', 'CANCELLED') then perform api._fail('INVALID', 'status'); end if;
  if p_status = 'CONCLUDED' then
    perform case_mgmt.require_status_code('OUTCOME_CODE', p_outcome_code, 'outcome_code');
  elsif p_outcome_code is not null then
    perform api._fail('INVALID', 'outcome_code');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  if exists (select 1 from case_mgmt.proceeding c
             where c.parent_proceeding_id = v_p.id and c.status not in ('CONCLUDED', 'CANCELLED')) then
    perform api._fail('CONFLICT', 'OPEN_CHILD_PROCEEDINGS');
  end if;

  -- 2117: a committee proceeding closes only when nothing of its work is in flight.
  perform 1 from committee.meeting m
    join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
   where cp.proceeding_id = v_p.id
   order by m.id
     for update of m;
  select * into v_cp from committee.committee_proceeding cp where cp.proceeding_id = v_p.id for update;
  if v_cp.id is not null then
    if exists (select 1 from committee.vote_item vi
               join committee.meeting m on m.id = vi.meeting_id
               where m.committee_proceeding_id = v_cp.id and vi.status <> 'CLOSED') then
      perform api._fail('CONFLICT', 'VOTES_OPEN');
    end if;
    if exists (select 1 from decision.recommendation_package k
               where k.committee_proceeding_id = v_cp.id and k.status = 'VOTING') then
      perform api._fail('CONFLICT', 'PACKAGE_VOTING');
    end if;
    if exists (select 1 from decision.recommendation_package k
               where k.committee_proceeding_id = v_cp.id and k.status = 'ADOPTED') then
      perform api._fail('CONFLICT', 'PACKAGE_ADOPTED');
    end if;
    if exists (select 1 from decision.recommendation_package k
               where k.committee_proceeding_id = v_cp.id
                 and (k.status = 'IN_LEGAL_REVIEW'
                      or exists (select 1 from decision.legal_review_request r
                                 where r.package_id = k.id and r.status = 'ASSIGNED'))) then
      perform api._fail('CONFLICT', 'LEGAL_REVIEW_OPEN');
    end if;
    if exists (select 1 from decision.recommendation_package k
               where k.committee_proceeding_id = v_cp.id and k.status = 'AWAITING_AUTHORITY') then
      perform api._fail('CONFLICT', 'PACKAGE_WITH_AUTHORITY');
    end if;
    if exists (select 1 from decision.recommendation_package k
               where k.committee_proceeding_id = v_cp.id and decision.package_tainted(k.id)) then
      perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT');
    end if;
    if exists (select 1 from committee.meeting m
               where m.committee_proceeding_id = v_cp.id and m.held_offline and m.status = 'SCHEDULED') then
      perform api._fail('CONFLICT', 'OFFLINE_MEETING_PENDING');
    end if;

    -- CDF-226: its meetings close with it.
    for v_m in select m.id, m.case_id, m.status from committee.meeting m
                where m.committee_proceeding_id = v_cp.id and m.status in ('SCHEDULED', 'OPEN')
                order by m.sequence_no, m.id loop
      update committee.meeting
         set status = case when v_m.status = 'OPEN' then 'CLOSED' else 'CANCELLED' end,
             closed_by = v_actor, closed_at = now(), updated_at = now()
       where id = v_m.id;
      if v_m.status = 'OPEN' then
        perform audit.record_event('MEETING_CLOSED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting', v_m.id::text, null,
          jsonb_build_object('proceeding_id', v_p.id,
                             'vote_items', (select count(*) from committee.vote_item vi where vi.meeting_id = v_m.id)));
      else
        perform audit.record_event('MEETING_CANCELLED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting', v_m.id::text, null,
          jsonb_build_object('proceeding_id', v_p.id));
      end if;
    end loop;
  end if;

  update case_mgmt.proceeding
     set status = p_status, outcome_code = p_outcome_code, waiting_reason = null, suspension_reason = null,
         closed_by = v_actor, closed_at = now(), updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  update committee.committee_proceeding set status = p_status, closed_at = now() where proceeding_id = v_p.id;
  perform audit.record_event('PROCEEDING_CLOSED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'proceeding', v_p.id::text, v_reason,
    jsonb_build_object('proceeding_type', v_p.proceeding_type, 'status', p_status, 'outcome_code', p_outcome_code));
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants and the catalogue
-- -----------------------------------------------------------------------------
-- The replaced functions keep their owners, grants and comments. The two new helpers are internal.
revoke all on function
  decision.package_proceeding_open(uuid), decision.require_package_proceeding_open(uuid)
from public, anon, authenticated;

update config.target_module
   set delivered_in = delivered_in || '2117'::text,
       notes = notes || ' Since 2117: on a committee proceeding that is no longer open every package command refuses '
                        '(PROCEEDING_CLOSED), and the proceeding closes only when no vote, package, legal review, '
                        'authority decision, unresolved conflict or offline meeting is still in flight (CDF-226).'
 where code = 'RECOMMENDATION_PACKAGE';
update config.target_module
   set delivered_in = delivered_in || '2117'::text,
       notes = notes || ' Since 2117: a legal review is requested, approved, given or superseded only while the '
                        'committee''s proceeding is open (PROCEEDING_CLOSED).'
 where code = 'LEGAL_REVIEW';
update config.target_module
   set delivered_in = delivered_in || '2117'::text,
       notes = notes || ' Since 2117: a package is submitted to or decided by the authority only while the committee''s '
                        'proceeding is open; the proceeding cannot close while a package waits for the authority.'
 where code = 'AUTHORITY_DECISION';
update config.target_module
   set delivered_in = delivered_in || '2117'::text,
       notes = notes || ' Since 2117: closing a committee proceeding closes its open meetings and cancels its scheduled '
                        'ones; a meeting held offline must be completed or cancelled first.'
 where code = 'MEETING';
update config.target_module
   set delivered_in = delivered_in || '2117'::text,
       notes = notes || ' Since 2117: api.close_proceeding refuses a committee proceeding while its work is in flight and '
                        'closes its meetings with it.'
 where code = 'CASE_CLOSE';
