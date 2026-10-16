-- =============================================================================
-- 2086 The recommendation package builder and the meeting's invite list (UX redesign Phase 12, slice P12-2c; ADR-056)
-- Requirements: Phase 12 plan §2 (rules 1, 5 and 6) and §4 (P12-2); DEC-02 and ADR-016 D2 (purpose routes, never the
-- full case); DEC-22 (no subject name, allegation text or reporter identity on a row); UX-116 (a screen offers an
-- action from server capabilities); DEC-AMB-003 and DEC-AMB-013 (a conflict taint and its resolution); AMB-100
-- (dependencies, exclusivity); AMB-156 and AMB-158 (invitee types); ADR-042 (2060's read models R1 and R2); ADR-054;
-- ADR-055 §7 (the invite form and its one purpose-bound candidate list, deferred here). Linear CDF-222. Number and ADR
-- allocated by the coordinator (2026-10-15 00:23), with the rulings of that answer:
--   1. the invite list holds the case team's active assignments on the case and the legal reviewers already assigned
--      to this proceeding's packages, computed in api.invite_to_meeting's order (the capability-flag pattern, no
--      lock), never a role-wide or directory list; whoever the meeting's narrowings exclude (an excluded witness, a
--      declared conflict) is absent, not shown disabled; the audit records counts only, no names;
--   2. in ORDINAL mode a case person is invited as the person, so no name reaches the roster or a My Work row
--      (DEC-22); the DISPLAY_NAME branch stays unreachable until the owner answers the DEC-02 label card and a
--      migration row citing his message flips decision.committee_label_policy;
--   3. the package capabilities ride api.committee_items_view, the already-audited read, and consume no audit sequence
--      of their own;
--   4. the page is a purpose route, /committee-proceedings/{id};
--   5. merge after 2085 and before PR-C's 2090.
--
-- Before: the committee's package screens could not be built without copying the commands' rules into a page.
-- api.committee_items_view (2060) said what a package holds but not whether the caller may create one, add or withdraw
-- an item, put it to the committee, open its vote in a meeting, record the adoption, return it to the committee or
-- resolve a conflict taint on one of its items. api.meeting_view (2085) says whether the caller may invite, but no read
-- model listed whom: invite_to_meeting accepts any account that passes the case gate, so the list had to be narrower
-- than the command.
--
-- After:
--   * api.committee_items_view is replaced with the same signature, grant, owner and audit. Every key 2060 returned is
--     returned to the same callers with the same values. It gains capabilities, each its command's answer for the
--     caller now:
--       - on the proceeding: may_create_package (api.create_recommendation_package, up to the granularity chosen);
--       - on each package: may_add_item, may_submit_for_vote, may_record_adoption and may_return_to_committee, and
--         open_vote_in, the meetings where api.open_package_vote would accept it now (empty for anyone else);
--       - on each active item: may_withdraw, and taint_resolutions, the resolutions api.resolve_conflict_taint would
--         accept now (RE_VOTE, CONFIRM, or none).
--   * api.meeting_invite_choices(meeting): the runner's candidates for one meeting, checked in api.invite_to_meeting's
--     order: NOT_FOUND unless the caller may see the meeting, FORBIDDEN unless they run it, CASE_NOT_ACTIVE, then
--     MEETING_NOT_ACTIVE. It lists:
--       - persons: the case's persons not in the meeting, each by its position among the case's persons and its case
--         roles (a label only in DISPLAY_NAME mode), with the roles the command would accept for it now;
--       - accounts: the case team's active assignments (case owner, lead investigator, investigator) and the legal
--         reviewers assigned to a review of one of the proceeding's packages, not in the meeting, passing the case
--         gate, each with its bases and the roles the command would accept now (the firewall rule applied).
--     Anyone who declared a conflict in a meeting of the proceeding, or was excluded from one as a witness, is absent.
--     Audited MEETING_INVITE_CHOICES_VIEWED with counts only.
--
-- How each capability is computed (coordinator, 2026-10-14 11:53, as for 2065 and 2085): with the helpers its command
-- calls, in the command's order, including the triggers that refuse the command's writes (the taint block, the
-- quorum and open-concern checks on a new vote item, the conflict-remediation guard), without taking a lock and
-- without writing. Input checks (a reason's length, the item type, sanction, subjects and allegations chosen, the
-- vote granularity, the invitee and role chosen) are the command's to answer.
--
-- What a capability tells (AGENT-09, to clear): nothing its command would not answer, and only to whoever runs the
-- package commands: the committee's current secretary, cleared for the case and not conflicted in the proceeding.
-- taint_resolutions says whether a recount without the conflicted votes gives the same result, which is what
-- api.resolve_conflict_taint answers (RESULT_MAY_CHANGE, RESULT_UNCHANGED); the secretary already reads the
-- resolution row with the recount. The invite list shows the runner names they could already invite by id: the case
-- team on the case they run a meeting of, and the legal reviewers of the proceeding's own packages.
--
-- Controls:
--   * One read model replaced, one added, four internal helpers added. No table, policy, table grant or command
--     changes; the new read model is granted to authenticated only and joins the policy snapshot's function list.
--   * SECURITY DEFINER with search_path ''. Both read models are volatile because they audit; the helpers are stable
--     and no application role may execute them. A capability never widens a command: the command checks again.
--   * Every capabilities object holds booleans only, never null; every list is a list, empty for whoever may not act.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Internal helpers (owner context; not granted)
-- -----------------------------------------------------------------------------
-- decision.lock_managed_package (1900) without its lock: NOT_FOUND unless the caller may see the package, FORBIDDEN
-- unless they manage it, CASE_NOT_ACTIVE unless its case is active.
create function decision.manages_package(p_package_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(p_package_id is not null
                  and authz.can_view_recommendation_package(p_package_id)
                  and authz.can_manage_recommendation_package(p_package_id)
                  and exists (select 1 from decision.recommendation_package p
                              join case_mgmt.case_record c on c.id = p.case_id
                              where p.id = p_package_id and c.records_state = 'ACTIVE'), false);
$$;

-- What the package commands would accept now, for the caller.
create function decision.package_capabilities(p_package_id uuid)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_p decision.recommendation_package;
  v_manage boolean := decision.manages_package(p_package_id);
  v_editable boolean;
  v_approved uuid[];
  v_notice_rule boolean;
  v_adoption boolean := false;
begin
  select * into v_p from decision.recommendation_package p where p.id = p_package_id;
  -- api.add_recommendation_item, api.withdraw_recommendation_item and api.submit_package_for_vote:
  -- decision.lock_managed_package, then the package editable (PACKAGE_NOT_EDITABLE).
  v_editable := v_manage and v_p.status in ('DRAFT', 'RETURNED_BY_LEGAL', 'RETURNED_BY_AUTHORITY');
  -- api.record_package_adoption (2030): decision.lock_managed_package; VOTING (PACKAGE_NOT_VOTING); the round's votes
  -- opened and all closed (VOTES_NOT_CLOSED). The items it would approve are those whose vote it reads as APPROVED.
  -- Approving none returns the package to DRAFT, which nothing refuses. Approving any: no taint (TAINTED_BY_CONFLICT,
  -- and decision.block_tainted_progress on the update), every approved catalogue code in force
  -- (SANCTION_NOT_IN_FORCE), and the defence notices the rule snapshot asks for (DEFENCE_NOTICE_REQUIRED).
  if v_manage and v_p.status = 'VOTING'
     and exists (select 1 from committee.vote_item vi where vi.package_id = v_p.id and vi.package_round = v_p.round_no)
     and not exists (select 1 from committee.vote_item vi
                     where vi.package_id = v_p.id and vi.package_round = v_p.round_no and vi.status <> 'CLOSED') then
    select coalesce(array_agg(i.id), '{}'::uuid[]) into v_approved
    from decision.recommendation_item i
    where i.package_id = v_p.id and i.status = 'ACTIVE'
      and case when v_p.vote_granularity = 'PACKAGE'
               then coalesce((select vi.result = 'APPROVED' from committee.vote_item vi
                              where vi.package_id = v_p.id and vi.package_round = v_p.round_no
                                and vi.target_type = 'PACKAGE'), false)
               else coalesce((select vi.result = 'APPROVED' from committee.vote_item vi
                              where vi.recommendation_item_id = i.id and vi.package_round = v_p.round_no),
                             i.committee_result = 'APPROVED', false) end;
    select coalesce((cp.rule_snapshot ->> 'sanction_requires_defence_notice')::boolean, false) into v_notice_rule
    from committee.committee_proceeding cp where cp.id = v_p.committee_proceeding_id;
    v_adoption := cardinality(v_approved) = 0
      or (not decision.package_tainted(v_p.id)
          and not exists (select 1 from decision.recommendation_item i
                          where i.id = any (v_approved) and i.sanction_code is not null
                            and decision.catalogue_version_in_force(i.sanction_code) is null)
          and not (v_notice_rule and exists (
            select 1
            from decision.recommendation_item i
            join decision.recommendation_item_subject rs on rs.item_id = i.id
            where i.id = any (v_approved) and i.item_type = 'DISCIPLINARY_SANCTION'
              and (exists (select 1 from case_mgmt.allegation a
                           where a.subject_id = rs.subject_id and a.status <> 'WITHDRAWN'
                             and (a.id in (select ra.allegation_id from decision.recommendation_item_allegation ra
                                           where ra.item_id = i.id)
                                  or not exists (select 1 from decision.recommendation_item_allegation ra
                                                 where ra.item_id = i.id))
                             and not exists (select 1 from grievance.defence_notice n
                                             join grievance.defence_notice_item ni on ni.notice_id = n.id
                                             where n.subject_id = rs.subject_id and n.kind = 'DEFENCE'
                                               and n.status <> 'WITHDRAWN' and ni.allegation_id = a.id))
                   or not exists (select 1 from grievance.defence_notice n
                                  where n.subject_id = rs.subject_id and n.kind = 'DEFENCE'
                                    and n.status <> 'WITHDRAWN')))));
  end if;
  return jsonb_build_object(
    'may_add_item', coalesce(v_editable, false),
    -- api.submit_package_for_vote: at least one active item (PACKAGE_EMPTY).
    'may_submit_for_vote', coalesce(v_editable and exists (select 1 from decision.recommendation_item i
                                                         where i.package_id = v_p.id and i.status = 'ACTIVE'), false),
    'may_record_adoption', coalesce(v_adoption, false),
    -- api.return_package_to_committee (2030): decision.lock_managed_package, then ADOPTED (PACKAGE_NOT_ADOPTED).
    'may_return_to_committee', coalesce(v_manage and v_p.status = 'ADOPTED', false));
end;
$$;

-- The meetings where api.open_package_vote (1900) would accept the package now: committee.lock_managed_meeting (the
-- caller sees and runs the meeting, on an active case) and decision.lock_managed_package, the meeting of the package's
-- proceeding (INVALID otherwise), OPEN (MEETING_NOT_OPEN), the package VOTING (PACKAGE_NOT_VOTING) with no vote
-- opened in its round (VOTE_ALREADY_OPENED), then the triggers on a new vote item: no open concern about a participant
-- who has not declared a conflict (committee.require_no_open_concern, 2000) and quorum for this package round, the
-- members its re-vote excludes left out (committee.require_quorum_at_opening, 2030). Ids only, in meeting order.
create function decision.package_vote_meetings(p_package_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(m.id order by m.sequence_no, m.id), '[]'::jsonb)
  from decision.recommendation_package p
  join committee.meeting m on m.committee_proceeding_id = p.committee_proceeding_id
  where p.id = p_package_id
    and decision.manages_package(p.id)
    and authz.can_view_meeting(m.id) and authz.can_manage_meeting(m.id)
    and m.status = 'OPEN' and p.status = 'VOTING'
    and not exists (select 1 from committee.vote_item vi where vi.package_id = p.id and vi.package_round = p.round_no)
    and not exists (select 1 from committee.meeting_conflict_concern c
                    join committee.meeting_participant mp on mp.id = c.participant_id
                    where c.meeting_id = m.id and c.status = 'OPEN' and mp.coi_status <> 'CONFLICT_DECLARED')
    and exists (select 1 from committee.quorum_state(m.id, p.id, p.round_no) q
                where q.eligible > 0 and q.present > 0 and (q.required is null or q.present >= q.required));
$$;

-- The resolutions api.resolve_conflict_taint (2030) would accept on an item now, up to the reason typed: the item the
-- caller may see and decision.lock_managed_package; an active item whose vote in the package's round has a
-- conflicted voter not yet covered by a resolution (NOT_TAINTED); the caller neither one of those voters nor whoever
-- raised a concern about one of them in the proceeding (FORBIDDEN); an open meeting of the proceeding that the caller
-- runs (MEETING_NOT_OPEN). Then CONFIRM only where the recount without the conflicted votes gives the result
-- (RESULT_MAY_CHANGE). RE_VOTE on a DECIDED package only where the recount does not give it (RESULT_UNCHANGED), the
-- caller is not among everyone whose vote taints the decided round (FORBIDDEN), and each of them has a recorded
-- conflict (decision.guard_conflict_remediation, NO_VALIDATED_CONFLICT); otherwise not while the package is with
-- Legal (LEGAL_REVIEW_OPEN) or the authority (PACKAGE_WITH_AUTHORITY) or a vote of its round is open
-- (VOTE_IN_PROGRESS).
create function decision.taint_resolutions(p_item_id uuid)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_actor uuid := authz.current_user_id();
  v_i decision.recommendation_item;
  v_p decision.recommendation_package;
  v_vi committee.vote_item;
  v_conflicted uuid[];
  v_excluded uuid[];
  v_events jsonb;
  v_recount text;
  v_out text[] := '{}';
begin
  select * into v_i from decision.recommendation_item i where i.id = p_item_id;
  if v_i.id is null or not decision.manages_package(v_i.package_id) then return '[]'::jsonb; end if;
  select * into v_p from decision.recommendation_package p where p.id = v_i.package_id;
  select * into v_vi from committee.vote_item vi where vi.id = decision.item_vote_item(v_i.id);
  v_conflicted := decision.vote_item_conflicted(v_vi.id);
  if v_i.status <> 'ACTIVE' or v_vi.id is null or cardinality(v_conflicted) = 0 then return '[]'::jsonb; end if;
  if v_actor = any (v_conflicted) or exists (
       select 1 from committee.meeting_conflict_concern c
       join committee.meeting_participant mp on mp.id = c.participant_id
       join committee.meeting m on m.id = c.meeting_id
       where m.committee_proceeding_id = v_p.committee_proceeding_id and c.raised_by = v_actor
         and mp.user_id = any (v_conflicted)) then
    return '[]'::jsonb;
  end if;
  if not exists (select 1 from committee.meeting m
                 where m.committee_proceeding_id = v_p.committee_proceeding_id and m.status = 'OPEN'
                   and authz.can_manage_meeting(m.id)) then
    return '[]'::jsonb;
  end if;
  v_recount := decision.recount_without(v_vi.id, v_conflicted);
  if v_p.status = 'DECIDED' then
    v_excluded := decision.round_conflicted(v_p.id, v_p.round_no);
    v_events := decision.conflict_events(v_p.id, v_excluded);
    if not (v_recount is not null and v_recount = v_vi.result)
       and not (v_actor = any (v_excluded))
       and not exists (select 1 from unnest(v_excluded) u(user_id)
                       where not exists (select 1 from jsonb_array_elements(v_events) e
                                         where (e ->> 'user_id')::uuid = u.user_id)) then
      v_out := v_out || 'RE_VOTE'::text;
    end if;
  elsif v_p.status not in ('IN_LEGAL_REVIEW', 'AWAITING_AUTHORITY')
        and not exists (select 1 from committee.vote_item vi
                        where vi.package_id = v_p.id and vi.package_round = v_p.round_no and vi.status <> 'CLOSED') then
    v_out := v_out || 'RE_VOTE'::text;
  end if;
  if v_recount is not null and v_recount = v_vi.result then
    v_out := v_out || 'CONFIRM'::text;
  end if;
  return to_jsonb(v_out);
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Read model R2 (2060) replaced: the package capabilities (M1)
-- -----------------------------------------------------------------------------
-- As in 2060, with the capabilities above for the caller. The case team, a member, a legal reviewer and anyone else
-- who does not run the package commands get false everywhere and empty lists.
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
               -- 2086.
               'capabilities', pc.caps,
               'open_vote_in', decision.package_vote_meetings(p.id))
             order by p.sequence_no)
      from decision.recommendation_package p
      cross join lateral (select decision.package_capabilities(p.id) as caps) pc
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
  'Read model R2 (migration 2060, ADR-042; capabilities added in 2086, ADR-056): the packages of a committee '
  'proceeding with their active items, and the FINDING votes of its meetings the caller may deliberate in, for the '
  'committee side of the work and the case team. Capabilities from the checks of the package commands, for the caller '
  'now: true only for whoever runs those commands, false everywhere else; open_vote_in and taint_resolutions are empty '
  'for anyone else. Audited COMMITTEE_ITEMS_VIEWED with counts only.';

-- -----------------------------------------------------------------------------
-- 3. The meeting's invite list (M2)
-- -----------------------------------------------------------------------------
create function api.meeting_invite_choices(p_meeting_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.meeting;
  v_mode text := decision.committee_label_mode();
  v_roles text[];
  v_persons jsonb;
  v_accounts jsonb;
begin
  -- committee.lock_managed_meeting without its lock, then the meeting active, as api.invite_to_meeting checks them.
  if p_meeting_id is null or not authz.can_view_meeting(p_meeting_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_m from committee.meeting m where m.id = p_meeting_id;
  if not authz.can_manage_meeting(v_m.id) then perform api._fail('FORBIDDEN'); end if;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_m.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if v_m.status not in ('SCHEDULED', 'OPEN') then perform api._fail('CONFLICT', 'MEETING_NOT_ACTIVE'); end if;
  -- The roles the rule enables (INVITEE_TYPE_DISABLED otherwise), in the command's order.
  select coalesce(array_agg(r.invitee_role order by array_position(
           array['WITNESS', 'EXPERT', 'LEGAL', 'INFORMATION_PROVIDER', 'SUBJECT', 'INTERPRETER'], r.invitee_role)),
         '{}'::text[])
    into v_roles
  from committee.invitee_type_rule r where r.enabled;

  -- A case person (INVALID otherwise) not in the meeting (ALREADY_INVITED), by its position among the case's persons
  -- (stable: case persons are never removed) and its case roles. Any role but LEGAL, which needs an account. Absent
  -- (coordinator, 00:23): a person with a conflict that still counts in a meeting of the proceeding
  -- (committee.conflict_counts, as authz.has_meeting_conflict reads an account's) or excluded from one as a witness.
  -- Its name only in DISPLAY_NAME mode; never its department, type or account.
  select coalesce(jsonb_agg(jsonb_build_object(
           'person_id', x.person_id, 'position', x.position, 'case_roles', to_jsonb(x.case_roles),
           'label', case when v_mode = 'DISPLAY_NAME' then pe.display_name end,
           'invitee_roles', to_jsonb(array(select r from unnest(v_roles) r where r <> 'LEGAL')))
         order by x.position), '[]'::jsonb)
    into v_persons
  from (select cp.person_id, array_agg(distinct cp.role order by cp.role) as case_roles,
               row_number() over (order by min(cp.added_at), cp.person_id) as position
        from case_mgmt.case_person cp where cp.case_id = v_m.case_id
        group by cp.person_id) x
  join case_mgmt.person pe on pe.id = x.person_id
  where cardinality(array(select r from unnest(v_roles) r where r <> 'LEGAL')) > 0
    and not exists (select 1 from committee.meeting_participant mp
                    where mp.meeting_id = v_m.id and mp.person_id = x.person_id)
    and not exists (select 1 from committee.meeting_participant mp
                    join committee.meeting om on om.id = mp.meeting_id
                    where om.committee_proceeding_id = v_m.committee_proceeding_id and mp.person_id = x.person_id
                      and ((mp.coi_status = 'CONFLICT_DECLARED' and committee.conflict_counts(mp.id))
                           or exists (select 1 from committee.witness_exclusion w where w.participant_id = mp.id)));

  -- An account on the ruled bases only, never a directory: the case team's active assignments on this case and the
  -- legal reviewers assigned to a review of one of this proceeding's packages. Passing the case gate (INVALID
  -- otherwise), not in the meeting (ALREADY_INVITED); any role but SUBJECT, which needs a person, and only WITNESS,
  -- EXPERT or INFORMATION_PROVIDER for a firewall-restricted member of the proceeding (FORBIDDEN otherwise). Absent: an
  -- account that declared a conflict in a meeting of the proceeding (authz.has_meeting_conflict) or was excluded from
  -- one as a witness.
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', u.id, 'display_name', u.display_name, 'display_name_ar', u.display_name_ar,
           'bases', to_jsonb(b.bases), 'invitee_roles', to_jsonb(rr.roles))
         order by u.display_name collate "C", u.id), '[]'::jsonb)
    into v_accounts
  from (select y.user_id, array_agg(distinct y.basis order by y.basis) as bases
        from (select a.user_id, 'CASE_TEAM'::text as basis
              from case_mgmt.case_assignment a
              where a.case_id = v_m.case_id and a.status = 'ACTIVE'
                and a.assignment_role in ('CASE_OWNER', 'LEAD_INVESTIGATOR', 'INVESTIGATOR')
              union all
              select r.assigned_to, 'LEGAL_REVIEW'
              from decision.legal_review_request r
              join decision.recommendation_package p on p.id = r.package_id
              where p.committee_proceeding_id = v_m.committee_proceeding_id and r.status <> 'CANCELLED') y
        group by y.user_id) b
  join iam.user_profile u on u.id = b.user_id
  cross join lateral (
    select array(select r from unnest(v_roles) r
                 where r <> 'SUBJECT'
                   and (r in ('WITNESS', 'EXPERT', 'INFORMATION_PROVIDER')
                        or not exists (select 1 from committee.proceeding_member pm
                                       where pm.committee_proceeding_id = v_m.committee_proceeding_id
                                         and pm.user_id = u.id and pm.firewall_restricted))) as roles) rr
  where cardinality(rr.roles) > 0
    and authz.user_case_gate(u.id, v_m.case_id)
    and not exists (select 1 from committee.meeting_participant mp where mp.meeting_id = v_m.id and mp.user_id = u.id)
    and not authz.has_meeting_conflict(u.id, v_m.committee_proceeding_id)
    and not exists (select 1 from committee.meeting_participant mp
                    join committee.meeting om on om.id = mp.meeting_id
                    join committee.witness_exclusion w on w.participant_id = mp.id
                    where om.committee_proceeding_id = v_m.committee_proceeding_id and mp.user_id = u.id);

  perform audit.record_event('MEETING_INVITE_CHOICES_VIEWED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting',
    v_m.id::text, null,
    jsonb_build_object('persons', jsonb_array_length(v_persons), 'accounts', jsonb_array_length(v_accounts),
                       'case_team', (select count(*) from jsonb_array_elements(v_accounts) e
                                     where e -> 'bases' ? 'CASE_TEAM'),
                       'legal_review', (select count(*) from jsonb_array_elements(v_accounts) e
                                        where e -> 'bases' ? 'LEGAL_REVIEW')));
  return jsonb_build_object('meeting_id', v_m.id, 'label_mode', v_mode, 'persons', v_persons, 'accounts', v_accounts);
end;
$$;
comment on function api.meeting_invite_choices(uuid) is
  'The runner''s candidates for one meeting (migration 2086, ADR-056): the case''s persons not in the meeting, by '
  'position and case roles (a name only in DISPLAY_NAME mode), and the accounts of the case team''s active '
  'assignments and of the legal reviewers of the proceeding''s packages, not in the meeting and passing the case '
  'gate, each with the roles api.invite_to_meeting would accept now. Whoever declared a conflict in, or was excluded '
  'from, a meeting of the proceeding is absent. Never a directory. Checked in api.invite_to_meeting''s order; audited '
  'MEETING_INVITE_CHOICES_VIEWED with counts only.';

-- -----------------------------------------------------------------------------
-- 4. Grants
-- -----------------------------------------------------------------------------
revoke all on function
  decision.manages_package(uuid), decision.package_capabilities(uuid), decision.package_vote_meetings(uuid),
  decision.taint_resolutions(uuid)
from public, anon, authenticated;

revoke all on function api.meeting_invite_choices(uuid) from public;
grant execute on function api.meeting_invite_choices(uuid) to authenticated;
