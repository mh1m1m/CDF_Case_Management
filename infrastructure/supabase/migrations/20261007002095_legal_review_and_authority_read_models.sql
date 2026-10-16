-- =============================================================================
-- 2095 Legal review and the authority's decision: read models (UX redesign Phase 12, slice P12-3a; ADR-057)
-- Requirements: Phase 12 plan §4 (P12-3) and §4.1; ADR-022 and ADR-023 (legal review and the authority); ADR-031
-- (packets: N14, the reviewer reaches nothing else); DEC-19 (the authority sees the package as submitted); DEC-62 and
-- DEC-F20 (the Restricted Case Authority approves each legal review on a restricted case); DEC-F12 (when a review is
-- required); DEC-F13 (authority rules shown as configured or SOURCE_REQUIRED, fail closed); DEC-F19 (no list says who
-- is cleared); DEC-AMB-003 and DEC-AMB-013 (a taint waits; the re-decision of a re-voted package supersedes the
-- earlier round's decisions); UX-116 (a screen offers an action from server capabilities). Linear CDF-229. Number
-- and ADR allocated by the coordinator (2026-10-15 06:50), with the rulings of that answer:
--   1. reviewer candidates are on the seat basis, not filtered by the case gate, as 2085's amendment_candidates
--      (DEC-F19): every active holder of LEGAL_OPINION_GIVE but the caller; the command answers INVALID at submit
--      and no list here says who is cleared;
--   2. on a restricted case the secretary reads the approval's reviewer and scope as the choices only, never its
--      reason;
--   3. what recording a decision would supersede is given to the secretary as counts only;
--   4. a packet is api.open_packet's audited read of stored content and shows subject names as snapshotted in every
--      mode: DEC-02 governs labels in lists and rosters, not packet content;
--   5. the Restricted Case Authority's My Work row stays as it is for a review the secretary elects (a known
--      limitation, ADR-057);
--   6. read models only, under the capability-flag pattern; the choices audited with counts only; SOURCE_REQUIRED
--      stays marked; nothing widened before 2160.
--
-- Before: no read model was keyed by a legal-review request, so the reviewer's page could not know whether a
-- superseding opinion was still possible (the package's status is hidden from the reviewer by design) or why an
-- opinion was refused. Nobody could list the eligible reviewers (role assignments are unreadable), and on a restricted
-- case the secretary could not read the approval their request must match. None of the secretary's acts after the
-- adoption (ask for legal review, cancel it, submit to the authority, record the authority's decision) had a
-- capability; decision.legal_review_required was internal and api.authority_rule_coverage refused anyone without
-- COMMITTEE_ADMIN; nothing said before recording that a decision would supersede the earlier round. The case's
-- history dropped every legal-review and authority event.
--
-- After:
--   * api.legal_review_view(request) (L1): the assigned reviewer's request while they may read its packet (the
--     request, its opinion and revisions, the packet's id, and whether api.give_legal_opinion and
--     api.give_superseding_legal_opinion would accept them now, with the code they would refuse with). NOT_FOUND to
--     anyone else. Not audited: the packet is read with api.open_packet, which is.
--   * api.legal_review_choices(package, act) (L2): for asking for a legal review (REQUEST, the committee's secretary)
--     or approving one on a restricted case (APPROVE, the case owner who is its Restricted Case Authority), checked in
--     the command's order without its lock, the reviewers, findings and minutes the command accepts (reviewers on the
--     seat basis, ruling 1; on a restricted case, the approval's reviewer and scope, ruling 2). Audited
--     LEGAL_REVIEW_CHOICES_VIEWED with counts only; a refusal writes nothing.
--   * api.committee_items_view (R2) is replaced with the same signature, grant, owner and audit. Every key 2086
--     returned is returned to the same callers with the same values. Each package gains its adoption and decision
--     dates, its legal review (required or not, and each request with its opinion, revisions and cancellation) and
--     its authority half (the rules in force for its adopted item types, each submission with its packet and
--     requirements, each decision with its sources, scope, conditions and supersession, and the authorities still to
--     decide), and, for whoever runs the package commands, may_request_legal_review, may_cancel on each open request,
--     may_submit_to_authority and may_record_authority_decision, the code each would refuse with, the outcomes the
--     record command accepts now, and what recording would supersede (counts only, ruling 3).
--   * api.case_history: the package's legal-review and authority events reach the case team as codes and times only;
--     the restricted legal review's approval reaches its authority as the restricted referral does.
--
-- How each capability is computed (coordinator, 2026-10-14 11:53, as for 2065, 2085 and 2086): with the helpers its
-- command calls, in the command's order, including the triggers that refuse the command's writes
-- (decision.block_tainted_progress, decision.enforce_restricted_packet_scope, decision.protect_records), without
-- taking a lock and without writing. Input checks (the reviewer, findings, minutes, opinion, authority, outcome,
-- dates, sources and reason chosen) are the command's to answer.
--
-- What a capability tells (AGENT-09, to clear): nothing its command would not answer, and only to whoever may act.
-- The reviewer learns whether their opinion waits for a conflict to be settled and whether the package has moved on
-- from the adoption their opinion is about, which api.give_legal_opinion and api.give_superseding_legal_opinion
-- answer (TAINTED_BY_CONFLICT, PACKAGE_NOT_ADOPTED). The secretary reads nothing their package reads (RLS) do not
-- already show them, but the restricted approval's reviewer and scope (ruling 2) and the counts of decisions and
-- corrective actions a re-decision would supersede (ruling 3).
--
-- Controls:
--   * Two read models added, one replaced, the case history extended, eleven internal helpers added. No table,
--     policy, table grant or command changes; the new read models are granted to authenticated only and join the
--     policy snapshot's function list.
--   * SECURITY DEFINER with search_path ''. L1 is stable and writes nothing; L2 and R2 are volatile because they
--     audit; the helpers are stable and no application role may execute them. A capability never widens a command:
--     the command checks again.
--   * Every capabilities object holds booleans only, never null; every list is a list, empty for whoever may not act;
--     a refusal code is null where the caller may act or may not act at all.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Internal helpers (owner context; not granted)
-- -----------------------------------------------------------------------------
-- decision.lock_managed_package (1900) without its lock, as the code it would refuse with: NOT_FOUND unless the
-- caller may see the package, FORBIDDEN unless they manage it, CASE_NOT_ACTIVE unless its case is active; null when it
-- would pass.
create function decision.managed_package_refusal(p_package_id uuid)
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
         end;
$$;

-- api.request_legal_review (2030) before the reviewer, findings, minutes and reason are chosen, as the code it would
-- refuse with now, or null: decision.lock_managed_package; the package ADOPTED (PACKAGE_NOT_ADOPTED); no review of its
-- round open (LEGAL_REVIEW_OPEN); no taint (TAINTED_BY_CONFLICT, and decision.block_tainted_progress on the new
-- request); on a restricted case, an unused approval of the round (without one the command answers
-- AUTHORITY_APPROVAL_REQUIRED whoever is chosen: the approval names the one reviewer it accepts, and
-- decision.enforce_restricted_packet_scope holds the packet to what it names).
create function decision.legal_review_request_refusal(p_package_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_code text := decision.managed_package_refusal(p_package_id);
  v_p decision.recommendation_package;
begin
  if v_code is not null then return v_code; end if;
  select * into v_p from decision.recommendation_package p where p.id = p_package_id;
  if v_p.status <> 'ADOPTED' then return 'PACKAGE_NOT_ADOPTED'; end if;
  if exists (select 1 from decision.legal_review_request r
             where r.package_id = v_p.id and r.package_round = v_p.round_no and r.status = 'ASSIGNED') then
    return 'LEGAL_REVIEW_OPEN';
  end if;
  if decision.package_tainted(v_p.id) then return 'TAINTED_BY_CONFLICT'; end if;
  if exists (select 1 from case_mgmt.case_record c where c.id = v_p.case_id and c.is_restricted)
     and not exists (select 1 from decision.restricted_legal_review_approval a
                     where a.package_id = v_p.id and a.legal_review_request_id is null
                       and a.package_round = v_p.round_no) then
    return 'AUTHORITY_APPROVAL_REQUIRED';
  end if;
  return null;
end;
$$;

-- api.cancel_legal_review_request (2030) before the reason, as a code or null: the request visible to the caller
-- (NOT_FOUND), the caller managing its package (FORBIDDEN), decision.lock_managed_package, the request still assigned
-- (LEGAL_REVIEW_NOT_OPEN). Nothing it writes is refused by a trigger: a cancellation neither gives an opinion nor moves
-- the package forward.
create function decision.legal_review_cancel_refusal(p_request_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_actor uuid := authz.current_user_id();
  v_r decision.legal_review_request;
  v_code text;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_case_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    return 'NOT_FOUND';
  end if;
  if not authz.can_manage_recommendation_package(v_r.package_id) then return 'FORBIDDEN'; end if;
  v_code := decision.managed_package_refusal(v_r.package_id);
  if v_code is not null then return v_code; end if;
  if v_r.status <> 'ASSIGNED' then return 'LEGAL_REVIEW_NOT_OPEN'; end if;
  return null;
end;
$$;

-- api.give_legal_opinion (2030) before the opinion and its text, as a code or null: the request visible to the caller
-- (NOT_FOUND), the caller its assignee holding LEGAL_OPINION_GIVE and cleared for the case (FORBIDDEN), not cancelled
-- (REQUEST_CANCELLED), still assigned (OPINION_ALREADY_GIVEN), no taint on its package (TAINTED_BY_CONFLICT, and
-- decision.block_tainted_progress on the answered request).
create function decision.legal_opinion_refusal(p_request_id uuid)
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
                            and authz.user_case_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    return 'NOT_FOUND';
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_case_gate(v_actor, v_r.case_id) then
    return 'FORBIDDEN';
  end if;
  if v_r.status = 'CANCELLED' then return 'REQUEST_CANCELLED'; end if;
  if v_r.status <> 'ASSIGNED' then return 'OPINION_ALREADY_GIVEN'; end if;
  if decision.package_tainted(v_r.package_id) then return 'TAINTED_BY_CONFLICT'; end if;
  return null;
end;
$$;

-- api.give_superseding_legal_opinion (2030) before the opinion and its text, as a code or null: NOT_FOUND and
-- FORBIDDEN as for the first opinion; the request's packet still readable by the caller (NOT_FOUND: the reviewer's
-- purpose has ended); the first opinion given (OPINION_NOT_GIVEN); the package ADOPTED in the request's round
-- (PACKAGE_NOT_ADOPTED: submission to the authority closes this path); no taint (TAINTED_BY_CONFLICT, and
-- decision.block_tainted_progress on the revision).
create function decision.superseding_opinion_refusal(p_request_id uuid)
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
                            and authz.user_case_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    return 'NOT_FOUND';
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_case_gate(v_actor, v_r.case_id) then
    return 'FORBIDDEN';
  end if;
  if not exists (select 1 from decision.packet k where k.legal_review_request_id = v_r.id and authz.can_view_packet(k.id)) then
    return 'NOT_FOUND';
  end if;
  select * into v_p from decision.recommendation_package p where p.id = v_r.package_id;
  if v_r.status <> 'OPINION_GIVEN' then return 'OPINION_NOT_GIVEN'; end if;
  if v_p.status <> 'ADOPTED' or v_p.round_no <> v_r.package_round then return 'PACKAGE_NOT_ADOPTED'; end if;
  if decision.package_tainted(v_p.id) then return 'TAINTED_BY_CONFLICT'; end if;
  return null;
end;
$$;

-- api.submit_to_authority (2030), as a code or null: decision.lock_managed_package; ADOPTED (PACKAGE_NOT_ADOPTED); a
-- required review answered in the current round (LEGAL_REVIEW_REQUIRED); no taint (TAINTED_BY_CONFLICT, and
-- decision.block_tainted_progress on the package); a rule in force for every adopted item type
-- (AUTHORITY_RULE_MISSING, which decision.write_authority_requirements checks again).
create function decision.submit_refusal(p_package_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_code text := decision.managed_package_refusal(p_package_id);
  v_p decision.recommendation_package;
begin
  if v_code is not null then return v_code; end if;
  select * into v_p from decision.recommendation_package p where p.id = p_package_id;
  if v_p.status <> 'ADOPTED' then return 'PACKAGE_NOT_ADOPTED'; end if;
  if decision.legal_review_required(v_p.id) and not exists (
    select 1 from decision.legal_review_request r
    where r.package_id = v_p.id and r.package_round = v_p.round_no and r.status = 'OPINION_GIVEN'
  ) then
    return 'LEGAL_REVIEW_REQUIRED';
  end if;
  if decision.package_tainted(v_p.id) then return 'TAINTED_BY_CONFLICT'; end if;
  if exists (select 1 from decision.recommendation_item i
             where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
               and decision.authority_rule_in_force(i.item_type) is null) then
    return 'AUTHORITY_RULE_MISSING';
  end if;
  return null;
end;
$$;

-- api.record_authority_decision (2030) before the authority and the decision are chosen, as a code or null:
-- decision.lock_managed_package; the package with the authority (PACKAGE_NOT_AWAITING_AUTHORITY); for a round
-- submitted before 2030, the requirements its backfill would write (decision.write_authority_requirements:
-- AUTHORITY_RULE_MISSING whatever authority is chosen).
create function decision.record_refusal(p_package_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_code text := decision.managed_package_refusal(p_package_id);
  v_p decision.recommendation_package;
begin
  if v_code is not null then return v_code; end if;
  select * into v_p from decision.recommendation_package p where p.id = p_package_id;
  if v_p.status <> 'AWAITING_AUTHORITY' then return 'PACKAGE_NOT_AWAITING_AUTHORITY'; end if;
  if not exists (select 1 from decision.authority_submission x
                 where x.package_id = v_p.id and x.package_round = v_p.round_no)
     and exists (select 1 from decision.recommendation_item i
                 where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
                   and decision.authority_rule_in_force(i.item_type) is null) then
    return 'AUTHORITY_RULE_MISSING';
  end if;
  return null;
end;
$$;

-- The authority requirements of the package's current round, as api.record_authority_decision reads them: its
-- submission's; for a round submitted before 2030 (no submission), what the backfill would write now
-- (decision.write_authority_requirements), and none while an adopted item type has no rule in force.
create function decision.round_requirements(p_package_id uuid)
returns table (item_id uuid, authority_type text)
language sql stable
set search_path = ''
as $$
  with p as (select k.id, k.round_no from decision.recommendation_package k where k.id = p_package_id),
       s as (select x.id from decision.authority_submission x join p on x.package_id = p.id and x.package_round = p.round_no)
  select q.item_id, q.authority_type
  from decision.authority_requirement q
  where q.submission_id in (select s.id from s)
  union
  select i.id, t.authority_type
  from p
  join decision.recommendation_item i on i.package_id = p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
  join decision.action_authority_rule r on r.id = decision.authority_rule_in_force(i.item_type)
  cross join lateral (select r.authority_type
                      union
                      select j.authority_type from decision.action_authority_rule_joint j where j.rule_id = r.id) t
  where not exists (select 1 from s)
    and not exists (select 1 from decision.recommendation_item i2
                    where i2.package_id = p.id and i2.status = 'ACTIVE' and i2.committee_result = 'APPROVED'
                      and decision.authority_rule_in_force(i2.item_type) is null);
$$;

-- The authorities still to decide in the round of a package with the authority, as api.record_authority_decision
-- accepts them: an active authority type (INVALID otherwise) that the round requires (AUTHORITY_TYPE_MISMATCH) for
-- items it has not decided yet (AUTHORITY_ALREADY_DECIDED), with those items; and whether its decision would be the
-- round's last (any other requirement left open keeps the package with the authority). Empty otherwise.
create function decision.authority_to_decide(p_package_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  with p as (select k.id, k.round_no from decision.recommendation_package k
             where k.id = p_package_id and k.status = 'AWAITING_AUTHORITY'),
       open_requirement as (
         select q.item_id, q.authority_type
         from p
         cross join lateral decision.round_requirements(p.id) q
         where not exists (select 1 from decision.authority_decision d
                           join decision.authority_decision_scope sc on sc.decision_id = d.id
                           where d.package_id = p.id and d.package_round = p.round_no
                             and d.authority_type = q.authority_type and sc.item_id = q.item_id))
  select coalesce(jsonb_agg(jsonb_build_object(
           'authority_type', o.authority_type, 'item_ids', o.item_ids,
           'completes_round', not exists (select 1 from open_requirement x where x.authority_type <> o.authority_type))
         order by o.authority_type collate "C"), '[]'::jsonb)
  from (select q.authority_type, jsonb_agg(q.item_id order by q.item_id) as item_ids
        from open_requirement q
        join decision.authority_type a on a.code = q.authority_type and a.is_active
        group by q.authority_type) o;
$$;

-- DEC-F13, CON-018: the rule in force for each item type the package has adopted, as decision.write_authority_requirements
-- would snapshot it on submission, in api.authority_rule_coverage's shape: its authorities, its source status, NO_RULE
-- where none is in force (the submission is refused), and whether the FINAL_DISCIPLINARY_AUTHORITY setting disagrees.
create function decision.package_authority_rules(p_package_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_type', t.item_type, 'rule_id', r.id,
           'authority_types', case when r.id is null then '[]'::jsonb
                                   else to_jsonb(array[r.authority_type]
                                                 || array(select j.authority_type from decision.action_authority_rule_joint j
                                                          where j.rule_id = r.id order by j.authority_type collate "C")) end,
           'source_status', r.source_status,
           'coverage', case when r.id is null then 'NO_RULE' else r.source_status end,
           'setting_disagreement', t.item_type = 'DISCIPLINARY_SANCTION' and r.id is not null
             and exists (select 1 from config.setting s
                         where s.key = 'FINAL_DISCIPLINARY_AUTHORITY'
                           and (s.status = 'SOURCE_REQUIRED' or s.value is distinct from r.authority_type)))
         order by t.item_type collate "C"), '[]'::jsonb)
  from (select distinct i.item_type from decision.recommendation_item i
        where i.package_id = p_package_id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED') t
  left join decision.action_authority_rule r on r.id = decision.authority_rule_in_force(t.item_type);
$$;

-- What recording the decision that makes the package DECIDED would supersede (decision.close_conflict_remediation):
-- with a conflict remediation open, every decision of its decided round, and every corrective action executing one of
-- them, which freezes. Counts only (ruling 3); null when no remediation is open.
create function decision.record_supersedes(p_package_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
           'decisions', (select count(*) from decision.authority_decision d
                         where d.package_id = r.package_id and d.package_round = r.decided_round),
           'corrective_actions', (select count(*) from decision.corrective_action a
                                  join decision.authority_decision d on d.id = decision.action_governing_decision(a.id)
                                  where a.case_id = r.case_id and d.package_id = r.package_id
                                    and d.package_round = r.decided_round))
  from decision.conflict_remediation r
  where r.package_id = p_package_id and r.status = 'OPEN';
$$;

-- -----------------------------------------------------------------------------
-- 2. The reviewer's request (L1)
-- -----------------------------------------------------------------------------
-- The assigned reviewer, while the request's packet is theirs to read (authz.can_view_packet, as the request's own
-- policy reads it for its assignee); NOT_FOUND to anyone else, and to a reviewer who reads the packet only as its
-- reviewer once the request is cancelled or the authority has decided (AMB-115, AMB-119). A reviewer who also sits on
-- the committee reads it as the committee does, and is told why each opinion command refuses them. Nothing about the
-- package, the case or other requests: the request, its opinion and revisions, who asked and why, the packet's id for
-- api.open_packet, and what the two opinion commands would answer now.
create function api.legal_review_view(p_request_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r decision.legal_review_request;
  v_packet uuid;
  v_opinion text;
  v_superseding text;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  select k.id into v_packet from decision.packet k where k.legal_review_request_id = v_r.id;
  if v_r.id is null or v_r.assigned_to <> v_actor or v_packet is null or not authz.can_view_packet(v_packet) then
    perform api._fail('NOT_FOUND');
  end if;
  v_opinion := decision.legal_opinion_refusal(v_r.id);
  v_superseding := decision.superseding_opinion_refusal(v_r.id);
  return jsonb_build_object(
    'request_id', v_r.id, 'package_round', v_r.package_round, 'status', v_r.status, 'basis', v_r.basis,
    'reason', v_r.reason, 'requested_at', v_r.requested_at,
    'requested_by', (select jsonb_build_object('user_id', u.id, 'display_name', u.display_name,
                                               'display_name_ar', u.display_name_ar)
                     from iam.user_profile u where u.id = v_r.requested_by),
    'opinion', v_r.opinion, 'opinion_text', v_r.opinion_text, 'opinion_at', v_r.opinion_at,
    'revisions', coalesce((
      select jsonb_agg(jsonb_build_object('revision_id', x.id, 'revision_no', x.revision_no, 'opinion', x.opinion,
                                          'opinion_text', x.opinion_text, 'given_at', x.given_at)
                       order by x.revision_no)
      from decision.legal_opinion_revision x where x.request_id = v_r.id), '[]'::jsonb),
    'packet_id', v_packet,
    'capabilities', jsonb_build_object(
      'may_give_opinion', v_opinion is null,
      'may_give_superseding_opinion', v_superseding is null),
    -- What each command would refuse with now, or null where it would accept the opinion chosen.
    'opinion_block', v_opinion,
    'superseding_opinion_block', v_superseding);
end;
$$;
comment on function api.legal_review_view(uuid) is
  'The assigned legal reviewer''s request (migration 2095, ADR-057): its status, round, basis, the secretary''s reason, '
  'the opinion and its revisions, the packet''s id for api.open_packet (the audited read), and whether '
  'api.give_legal_opinion and api.give_superseding_legal_opinion would accept the reviewer now, with the code they '
  'would refuse with. NOT_FOUND to anyone but the assignee, and to them once the packet is no longer theirs. '
  'Read-only, not audited.';

-- -----------------------------------------------------------------------------
-- 3. The choices for asking for, or approving, a legal review (L2)
-- -----------------------------------------------------------------------------
-- REQUEST: api.request_legal_review's checks before the choices, in its order (decision.legal_review_request_refusal),
-- then what it accepts: reviewers on the seat basis (every active holder of LEGAL_OPINION_GIVE but the caller; the
-- command answers INVALID for one not cleared for the case, ruling 1), the findings of the committee's scope (as
-- api.committee_scope_choices lists them; the command accepts any finding of the case) and the proceeding's approved
-- minutes; on a restricted case, exactly the unused approval's reviewer and the findings and minutes it names (ruling
-- 2), never its reason.
-- APPROVE: api.approve_restricted_legal_review's checks before the choices, in its order (NOT_FOUND,
-- CASE_NOT_RESTRICTED, FORBIDDEN unless the case owner is its Restricted Case Authority, CASE_NOT_ACTIVE,
-- PACKAGE_NOT_ADOPTED, then APPROVAL_ALREADY_PENDING, which refuses every choice), then the same choices as an
-- unrestricted request.
-- Findings by allegation number, category, result and version, their person by position (a label only in
-- DISPLAY_NAME mode); minutes by meeting and version. A refusal raises the command's code and writes nothing.
create function api.legal_review_choices(p_package_id uuid, p_act text)
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
  -- restricted request the approval's findings of the case.
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
    and case when v_scoped then f.id = any (coalesce(v_approval.finding_ids, '{}'::uuid[]))
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
  'reviewer and scope, never its reason. Checked in the command''s order; a refusal raises its code. Audited '
  'LEGAL_REVIEW_CHOICES_VIEWED with counts only.';

-- -----------------------------------------------------------------------------
-- 4. Read model R2 (2060, 2086) replaced: legal review and the authority (P12-3a)
-- -----------------------------------------------------------------------------
-- As in 2086, with each package's legal review and authority half, which the package's own policies already show
-- R2's callers, and, for whoever runs the package commands, the capabilities of the acts after adoption. The case
-- team, a member, a legal reviewer and anyone else who does not run those commands get false everywhere, empty lists
-- and null codes.
create or replace function api.committee_items_view(p_committee_proceeding_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_cp committee.committee_proceeding;
  v_mode text := decision.committee_label_mode();
  v_team boolean;
  v_secretary boolean;
  v_doc jsonb;
begin
  select * into v_cp from committee.committee_proceeding cp where cp.id = p_committee_proceeding_id;
  if v_cp.id is null or not authz.sees_proceeding_deliberation(v_cp.id, v_cp.case_id) then
    perform api._fail('NOT_FOUND');
  end if;
  v_team := authz.can_view_case(v_cp.case_id);
  if not v_team and v_cp.status <> 'OPEN' then perform api._fail('NOT_FOUND'); end if;
  v_secretary := authz.is_committee_secretary(v_cp.committee_id) and authz.user_case_gate(v_actor, v_cp.case_id);
  v_doc := jsonb_build_object(
    'committee_proceeding_id', v_cp.id,
    'label_mode', v_mode,
    -- 2086. api.create_recommendation_package up to the granularity chosen: the proceeding visible (NOT_FOUND), the
    -- committee's secretary cleared for the case and not conflicted in the proceeding (FORBIDDEN), an Investigation
    -- Committee (NOT_AN_INVESTIGATION_COMMITTEE), the proceeding OPEN (PROCEEDING_CLOSED), the case active.
    'capabilities', jsonb_build_object(
      'may_create_package', coalesce(
        authz.can_view_committee_proceeding(v_cp.id)
        and authz.is_committee_secretary(v_cp.committee_id) and authz.user_case_gate(v_actor, v_cp.case_id)
        and not authz.has_meeting_conflict(v_actor, v_cp.id)
        and exists (select 1 from committee.committee c where c.id = v_cp.committee_id and c.kind = 'INVESTIGATION')
        and v_cp.status = 'OPEN'
        and exists (select 1 from case_mgmt.case_record c where c.id = v_cp.case_id and c.records_state = 'ACTIVE'),
        false)),
    'packages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'package_id', p.id, 'sequence_no', p.sequence_no, 'status', p.status, 'round_no', p.round_no,
               'vote_granularity', p.vote_granularity,
               'items', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'item_id', i.id, 'item_type', i.item_type, 'sanction_code', i.sanction_code,
                          'proposed_sanction_text', i.proposed_sanction_text,
                          'verification_status', i.verification_status, 'description', i.description,
                          'case_wide', i.case_wide, 'committee_result', i.committee_result,
                          'requires_legal_justification', i.requires_legal_justification,
                          'exclusivity_group', i.exclusivity_group,
                          'depends_on', coalesce((select jsonb_agg(d.depends_on order by d.depends_on)
                                                  from decision.recommendation_item_dependency d
                                                  where d.item_id = i.id), '[]'::jsonb),
                          'subjects', coalesce((
                            select jsonb_agg(decision.subject_choice(s.id, v_mode,
                                                                     v_team or v_secretary or p.status <> 'DRAFT')
                                             order by s.added_at, s.id)
                            from decision.recommendation_item_subject rs
                            join case_mgmt.case_subject s on s.id = rs.subject_id
                            where rs.item_id = i.id), '[]'::jsonb),
                          'allegations', coalesce((
                            select jsonb_agg(jsonb_build_object('allegation_id', a.id, 'category', a.category)
                                             order by a.created_at, a.id)
                            from decision.recommendation_item_allegation ra
                            join case_mgmt.allegation a on a.id = ra.allegation_id
                            where ra.item_id = i.id), '[]'::jsonb),
                          -- 2086. api.withdraw_recommendation_item up to the reason typed: an active item
                          -- (ITEM_WITHDRAWN) of a package the caller manages, editable (PACKAGE_NOT_EDITABLE): the same
                          -- answer as adding an item.
                          'capabilities', jsonb_build_object(
                            'may_withdraw', coalesce((pc.caps ->> 'may_add_item')::boolean and i.status = 'ACTIVE',
                                                     false)),
                          -- 2086. api.resolve_conflict_taint.
                          'taint_resolutions', decision.taint_resolutions(i.id))
                        order by i.added_at, i.id)
                 from decision.recommendation_item i
                 where i.package_id = p.id and i.status = 'ACTIVE'), '[]'::jsonb),
               -- 2086, with 2095's acts after the adoption: api.request_legal_review up to the reviewer, findings,
               -- minutes and reason chosen; api.submit_to_authority; api.record_authority_decision up to the authority
               -- and the decision chosen (an authority still to decide, below).
               'capabilities', pc.caps || jsonb_build_object(
                 'may_request_legal_review', x.request_code is null,
                 'may_submit_to_authority', x.submit_code is null,
                 'may_record_authority_decision', x.record_code is null and jsonb_array_length(x.to_decide) > 0),
               'open_vote_in', decision.package_vote_meetings(p.id),
               -- 2095. Why each act after the adoption is refused now, for whoever runs the package commands, once the
               -- package is where the act is done (ADOPTED to ask for a review or submit, AWAITING_AUTHORITY to record):
               -- null where it would be accepted, elsewhere, and for anyone else.
               'request_legal_review_block', case when p.status = 'ADOPTED' and x.request_code not in ('NOT_FOUND', 'FORBIDDEN')
                                                  then x.request_code end,
               'submit_block', case when p.status = 'ADOPTED' and x.submit_code not in ('NOT_FOUND', 'FORBIDDEN')
                                    then x.submit_code end,
               'record_block', case when p.status = 'AWAITING_AUTHORITY' and x.record_code not in ('NOT_FOUND', 'FORBIDDEN')
                                    then x.record_code end,
               -- The outcomes api.record_authority_decision accepts now: while a taint waits for the committee, only
               -- RETURN_TO_COMMITTEE (DEC-AMB-003).
               'record_outcomes', case when x.record_code is null and jsonb_array_length(x.to_decide) > 0 then
                                    case when decision.package_tainted(p.id) then '["RETURN_TO_COMMITTEE"]'::jsonb
                                         else '["APPROVE_AS_RECOMMENDED", "MODIFY", "REJECT", "RETURN_TO_COMMITTEE", "APPROVE_PARTIALLY", "OTHER"]'::jsonb end
                                  else '[]'::jsonb end,
               -- What recording the round's last decision would supersede, counts only (ruling 3).
               'record_supersedes', case when x.record_code is null and jsonb_array_length(x.to_decide) > 0
                                         then decision.record_supersedes(p.id) end,
               'adopted_at', p.adopted_at,
               'decided_at', p.decided_at,
               -- The package's legal review (legal_review_request_read, legal_review_cancellation_read and
               -- legal_opinion_revision_read show it to package viewers): whether the rules require one now (DEC-F12),
               -- and each request in every round with its packet, opinion, revisions and cancellation.
               'legal_review', jsonb_build_object(
                 'required', decision.legal_review_required(p.id),
                 'requests', coalesce((
                   select jsonb_agg(jsonb_build_object(
                            'request_id', r.id, 'package_round', r.package_round, 'status', r.status,
                            'basis', r.basis, 'reason', r.reason, 'requested_at', r.requested_at,
                            'reviewer', jsonb_build_object('user_id', u.id, 'display_name', u.display_name,
                                                           'display_name_ar', u.display_name_ar),
                            'opinion', r.opinion, 'opinion_text', r.opinion_text, 'opinion_at', r.opinion_at,
                            'packet_id', (select k.id from decision.packet k where k.legal_review_request_id = r.id),
                            'revisions', coalesce((
                              select jsonb_agg(jsonb_build_object('revision_id', v.id, 'revision_no', v.revision_no,
                                                                  'opinion', v.opinion, 'opinion_text', v.opinion_text,
                                                                  'given_at', v.given_at)
                                               order by v.revision_no)
                              from decision.legal_opinion_revision v where v.request_id = r.id), '[]'::jsonb),
                            'cancellation', (select jsonb_build_object('reason', lc.reason, 'cancelled_at', lc.cancelled_at)
                                             from decision.legal_review_cancellation lc where lc.request_id = r.id),
                            -- api.cancel_legal_review_request up to the reason typed.
                            'capabilities', jsonb_build_object(
                              'may_cancel', decision.legal_review_cancel_refusal(r.id) is null))
                          order by r.requested_at, r.id)
                   from decision.legal_review_request r
                   join iam.user_profile u on u.id = r.assigned_to
                   where r.package_id = p.id), '[]'::jsonb)),
               -- The authority half (authority_submission_read, authority_requirement_read, authority_decision_read and
               -- their scope, source, condition and supersession policies show it to package viewers).
               'authority', jsonb_build_object(
                 -- DEC-F13: the rule in force for each adopted item type, as a submission would snapshot it now.
                 'rules', decision.package_authority_rules(p.id),
                 -- DEC-19: each submission with its packet (the package as submitted) and requirements.
                 'submissions', coalesce((
                   select jsonb_agg(jsonb_build_object(
                            'submission_id', sb.id, 'package_round', sb.package_round, 'packet_id', sb.packet_id,
                            'basis', sb.basis, 'submitted_at', sb.submitted_at,
                            'requirements', coalesce((
                              select jsonb_agg(jsonb_build_object('item_id', q.item_id,
                                                                  'authority_type', q.authority_type,
                                                                  'rule_source_status', q.rule_source_status)
                                               order by q.item_id, q.authority_type collate "C")
                              from decision.authority_requirement q where q.submission_id = sb.id), '[]'::jsonb))
                          order by sb.package_round)
                   from decision.authority_submission sb where sb.package_id = p.id), '[]'::jsonb),
                 -- Each decision in every round, with its sources, scope, conditions and, once a re-decision replaced
                 -- it, its supersession (DEC-AMB-013).
                 'decisions', coalesce((
                   select jsonb_agg(jsonb_build_object(
                            'decision_id', d.id, 'package_round', d.package_round, 'authority_type', d.authority_type,
                            'outcome', d.outcome, 'decided_at', d.decided_at, 'decided_by_label', d.decided_by_label,
                            'recorded_at', d.recorded_at, 'reason', d.reason,
                            'delegation_reference', d.delegation_reference, 'source_signature', d.source_signature,
                            'unsigned_attestation', d.unsigned_attestation,
                            'sources', coalesce((
                              select jsonb_agg(jsonb_build_object('position', so.position, 'reference', so.reference,
                                                                  'is_primary', so.is_primary)
                                               order by so.position)
                              from decision.authority_decision_source so where so.decision_id = d.id),
                              jsonb_build_array(jsonb_build_object('position', 1,
                                                                   'reference', d.source_document_reference,
                                                                   'is_primary', true))),
                            'scope', coalesce((
                              select jsonb_agg(jsonb_build_object(
                                       'item_id', sc.item_id, 'item_outcome', sc.item_outcome,
                                       'modification', (select x2.modification from decision.authority_item_decision x2
                                                        where x2.decision_id = d.id and x2.item_id = sc.item_id))
                                               order by sc.item_id)
                              from decision.authority_decision_scope sc where sc.decision_id = d.id), '[]'::jsonb),
                            'conditions', coalesce((
                              select jsonb_agg(jsonb_build_object('position', co.position, 'kind', co.kind,
                                                                  'item_id', co.item_id, 'text', co.condition_text,
                                                                  'due_date', co.due_date)
                                               order by co.position)
                              from decision.authority_decision_condition co where co.decision_id = d.id), '[]'::jsonb),
                            'superseded', (select jsonb_build_object('superseded_by', ss.superseded_by,
                                                                     'superseded_at', ss.superseded_at)
                                           from decision.authority_decision_supersession ss
                                           where ss.decision_id = d.id))
                          order by d.package_round, d.recorded_at, d.id)
                   from decision.authority_decision d where d.package_id = p.id), '[]'::jsonb),
                 -- The authorities still to decide in the current round, with their items, while the package is with
                 -- the authority.
                 'to_decide', x.to_decide))
             order by p.sequence_no)
      from decision.recommendation_package p
      -- offset 0 keeps each helper to one call per package: flattened, the subquery would repeat the call at every
      -- reference to its column.
      cross join lateral (select decision.package_capabilities(p.id) as caps offset 0) pc
      cross join lateral (select decision.legal_review_request_refusal(p.id) as request_code,
                                 decision.submit_refusal(p.id) as submit_code,
                                 decision.record_refusal(p.id) as record_code,
                                 decision.authority_to_decide(p.id) as to_decide
                          offset 0) x
      where p.committee_proceeding_id = v_cp.id), '[]'::jsonb),
    'finding_votes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'vote_item_id', vi.id, 'meeting_id', m.id, 'sequence_no', vi.sequence_no, 'status', vi.status,
               'finding', jsonb_build_object(
                 'finding_id', f.id, 'version_no', f.version_no,
                 'is_current_version', decision.finding_in_committee_scope(f.id, v_cp.id),
                 'result', f.result,
                 'proceeding_role', case when f.proceeding_id = pr.id then 'COMMITTEE'
                                         when f.proceeding_id = pr.parent_proceeding_id then 'REFERRED'
                                         else 'OTHER' end,
                 'allegation', jsonb_build_object('allegation_id', a.id, 'category', a.category),
                 'subject', case when f.subject_id is not null
                                 then decision.subject_choice(f.subject_id, v_mode, true) end))
             order by m.sequence_no, vi.sequence_no)
      from committee.meeting m
      join committee.vote_item vi on vi.meeting_id = m.id and vi.target_type = 'FINDING'
      join case_mgmt.finding f on f.id = vi.finding_id
      join case_mgmt.allegation a on a.id = f.allegation_id
      join case_mgmt.proceeding pr on pr.id = v_cp.proceeding_id
      where m.committee_proceeding_id = v_cp.id and authz.can_view_meeting_deliberation(m.id)), '[]'::jsonb));
  perform audit.record_event('COMMITTEE_ITEMS_VIEWED', 'BUSINESS', 'SUCCESS', v_cp.case_id, 'committee_proceeding',
    v_cp.id::text, null, jsonb_build_object('packages', jsonb_array_length(v_doc -> 'packages'),
                                            'finding_votes', jsonb_array_length(v_doc -> 'finding_votes')));
  return v_doc;
end;
$$;
comment on function api.committee_items_view(uuid) is
  'Read model R2 (migration 2060, ADR-042; capabilities added in 2086, ADR-056; legal review and the authority in '
  '2095, ADR-057): the packages of a committee proceeding with their active items, legal review and authority half, '
  'and the FINDING votes of its meetings the caller may deliberate in, for the committee side of the work and the '
  'case team. Capabilities from the checks of the package commands, for the caller now: true only for whoever runs '
  'those commands, false everywhere else; lists are empty and refusal codes null for anyone else. Audited '
  'COMMITTEE_ITEMS_VIEWED with counts only.';

-- -----------------------------------------------------------------------------
-- 5. Case history: the package's legal review and authority events
-- -----------------------------------------------------------------------------
-- From 2045. Two audiences join the allowlist, each as its object's policy reads it:
--   * PACKAGE (a legal review requested, cancelled or answered, a superseding opinion, the submission to the
--     authority, a decision recorded or superseded): whoever may see the package (authz.can_view_recommendation_package,
--     as the request, submission and decision policies read it), which is the whole case team;
--   * RESTRICTED_REFERRAL gains the restricted legal review's approval: the case's owner as its Restricted Case
--     Authority, and whoever recorded it, as for the restricted referral.
-- They show as codes and times only: no actor, reason, reviewer, authority, outcome or detail.
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
             -- 2095: the restricted legal review's approval joins the restricted referral's audience.
             when e.action in ('RESTRICTED_COMMITTEE_REFERRAL_APPROVED', 'RESTRICTED_LEGAL_REVIEW_APPROVED')
               then 'RESTRICTED_REFERRAL'
             -- 2095: the package's legal review and authority events.
             when e.action in ('LEGAL_REVIEW_REQUESTED', 'LEGAL_REVIEW_CANCELLED', 'LEGAL_OPINION_GIVEN',
                               'LEGAL_OPINION_SUPERSEDED', 'RECOMMENDATION_PACKAGE_SUBMITTED_TO_AUTHORITY',
                               'AUTHORITY_DECISION_RECORDED', 'AUTHORITY_DECISION_SUPERSEDED') then 'PACKAGE'
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
             -- 2095: the package, as its own policy reads it.
             when 'PACKAGE' then authz.can_view_recommendation_package(
                                   case when ev.object_type = 'recommendation_package' then ev.object_id
                                        else ev.metadata ->> 'package_id' end::uuid)
             else false
           end
  ),
  masked as (
    select s.seq, s.occurred_at, s.action,
           -- Hold status reaches the case team without who placed or released it, or why (DEC-10).
           -- 2045: the 1870 events show as codes and times only. 2095: so do the package's.
           case when s.actor_type <> 'USER' then false
                when s.audience = 'HOLD_STATUS' then s.records_audience or s.by_me
                when s.audience in ('PROCEEDING', 'COMMITTEE_PROCEEDING', 'CASE_STRUCTURE', 'FINDING', 'EVIDENCE_LINK',
                                    'RESTRICTED_REFERRAL', 'PACKAGE') then false
                else true end as show_actor,
           case when s.audience = 'HOLD_STATUS' then s.records_audience or s.by_me
                when s.audience = 'TEAM_CHANGE' then s.roster_full or s.about_me or s.by_me
                when s.audience in ('PROCEEDING', 'COMMITTEE_PROCEEDING', 'CASE_STRUCTURE', 'FINDING', 'EVIDENCE_LINK',
                                    'RESTRICTED_REFERRAL', 'PACKAGE') then false
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

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------
revoke all on function
  decision.managed_package_refusal(uuid), decision.legal_review_request_refusal(uuid),
  decision.legal_review_cancel_refusal(uuid), decision.legal_opinion_refusal(uuid),
  decision.superseding_opinion_refusal(uuid), decision.submit_refusal(uuid), decision.record_refusal(uuid),
  decision.round_requirements(uuid), decision.authority_to_decide(uuid), decision.package_authority_rules(uuid),
  decision.record_supersedes(uuid)
from public, anon, authenticated;

revoke all on function api.legal_review_view(uuid), api.legal_review_choices(uuid, text) from public;
grant execute on function api.legal_review_view(uuid), api.legal_review_choices(uuid, text) to authenticated;
