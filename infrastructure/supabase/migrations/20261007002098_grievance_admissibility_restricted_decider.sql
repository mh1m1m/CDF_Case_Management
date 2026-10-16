-- =============================================================================
-- 2098 The admissibility decider on a restricted case: the command and its capability (CDF-237; ADR-040)
-- Requirements: AMB-251 and DEC-F17 (ADR-040 §5 item 17): on a restricted case an admissibility decider must already
-- be able to view the case; where no seated decider can, nobody is asked and the handling secretary keeps the
-- grievance (fail closed). §19 (authorization enforced in the database as well as the application), §87. Linear
-- CDF-237 (Security LOW), found by the CDF-224 register re-check. Number and content from the coordinator
-- (2026-10-16 07:41): it enforces a condition already decided, fails closed and grants nothing.
--
-- Before: 2040 put the restricted-case condition into grievance.is_pending_decider, which the decider's reads and
-- GRIEVANCE_ADMISSIBILITY_DECISION_REQUESTED use, but not into api.decide_grievance_admissibility. Its chair path
-- checked the seat (CHAIR or DEPUTY_CHAIR), authz.user_case_gate (an active account, clearance, no conflict) and no
-- part in the Investigation Committee (G3). A chair cleared for the case but outside a restricted case, holding the
-- grievance's id, could record the decision. grievance.caller_capabilities (may_decide) had the same chair path;
-- api.grievance_view and api.grievance_queue never offered it to such a chair, because their gate
-- (authz.is_grievance_decider) already applies the condition.
--
-- After: the chair path also requires, on a restricted case, that the chair can already view it
-- (authz.user_can_view_case), the condition grievance.is_pending_decider applies. A chair who cannot view the
-- grievance gets NOT_FOUND, as for a random id; one who can view the grievance but not the restricted case gets
-- FORBIDDEN. may_decide answers the same, asked for any caller. Every other check, its order and its refusal are
-- unchanged; an EXTERNAL decision recorded by the handling secretary is unchanged.
--
-- Both functions are replaced with the same signature, owner and grants; each body is 2040's with the one condition
-- and a comment line added. The 4-argument overload of the command (2040) delegates to this one and is unchanged.
-- No table, policy, grant or audit change; nothing is dropped or renamed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The command (2040)
-- -----------------------------------------------------------------------------
create or replace function api.decide_grievance_admissibility(p_grievance_id uuid, p_decision text, p_decision_reference text,
                                                   p_reason text, p_new_evidence_confirmed boolean)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_g grievance.grievance;
  v_pending text;
  v_chair boolean;
begin
  select * into v_g from grievance.grievance g where g.id = p_grievance_id;
  if v_g.id is not null and v_g.status = 'AWAITING_ADMISSIBILITY_DECISION' then
    v_pending := grievance.pending_decider(v_g);
  end if;
  -- On a restricted case, only a chair who already works it (as grievance.is_pending_decider; 2098, CDF-237).
  v_chair := coalesce(v_g.id is not null
                      and authz.user_committee_seat(v_actor, grievance.committee_id(), now()) in ('CHAIR', 'DEPUTY_CHAIR')
                      and authz.user_case_gate(v_actor, v_g.case_id)
                      and (not (select c.is_restricted from case_mgmt.case_record c where c.id = v_g.case_id)
                           or authz.user_can_view_case(v_actor, v_g.case_id)), false);
  if v_g.id is null or not authz.can_view_grievance(v_g.id) then
    -- The Chair reaches only grievances awaiting their (or the committee's) decision, cleared for the case.
    if not coalesce(v_chair and v_pending in ('CHAIR', 'COMMITTEE'), false) then perform api._fail('NOT_FOUND'); end if;
  end if;
  if v_pending = 'EXTERNAL' then
    if not authz.can_handle_grievance(v_g.id) or authz.participated_in_investigation_committee(v_actor, v_g.case_id) then
      perform api._fail('FORBIDDEN');
    end if;
  -- G3 (N9): a chair who took part in the case's Investigation Committee does not decide its grievance.
  elsif not v_chair or authz.participated_in_investigation_committee(v_actor, v_g.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  select * into v_g from grievance.grievance g where g.id = p_grievance_id for update;
  if v_g.status <> 'AWAITING_ADMISSIBILITY_DECISION' then perform api._fail('CONFLICT', 'NOT_AWAITING_DECISION'); end if;
  v_pending := grievance.pending_decider(v_g);
  if p_decision is null or p_decision not in ('ADMISSIBLE', 'INADMISSIBLE') then perform api._fail('INVALID', 'decision'); end if;
  if v_pending in ('COMMITTEE', 'EXTERNAL') and p_decision_reference is null then
    perform api._fail('INVALID', 'decision_reference');
  end if;
  insert into grievance.admissibility_assessment (grievance_id, stage, assessment, decision_reference, decided_by_role,
                                                  reason, recorded_by, new_evidence_confirmed)
  values (v_g.id, 'DECISION', p_decision,
          case when p_decision_reference is not null then api._require_text(p_decision_reference, 'decision_reference', 3, 300) end,
          v_pending, api._require_text(p_reason, 'reason', 5, 2000), v_actor, p_new_evidence_confirmed);
  perform audit.record_event('GRIEVANCE_ADMISSIBILITY_DECIDED', 'BUSINESS', 'SUCCESS', v_g.case_id, 'grievance',
    v_g.id::text, null, jsonb_build_object('decision', p_decision, 'decider', v_pending,
                                           'reconsideration', v_g.reconsideration_of is not null,
                                           'new_evidence_confirmed', p_new_evidence_confirmed));
  return grievance.apply_admissibility(v_g, p_decision, v_actor);
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Its capability (2040, item 13.6): may_decide
-- -----------------------------------------------------------------------------
create or replace function grievance.caller_capabilities(p_g grievance.grievance)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_me uuid := authz.current_user_id();
  v_view boolean := authz.can_view_grievance(p_g.id);
  v_handle boolean := authz.can_handle_grievance(p_g.id);
  v_part boolean := coalesce(authz.participated_in_investigation_committee(v_me, p_g.case_id), false);
  v_grievant boolean := v_view and coalesce(p_g.grievant_user_id = v_me, false);
  v_open_request boolean := exists (
    select 1 from grievance.completion_request r
    where r.grievance_id = p_g.id
      and not exists (select 1 from grievance.grievance_supplement x where x.completion_request_id = r.id));
  v_pending text;
  v_chair boolean;
  v_reconsider boolean;
begin
  if p_g.status = 'AWAITING_ADMISSIBILITY_DECISION' then v_pending := grievance.pending_decider(p_g); end if;
  -- As api.decide_grievance_admissibility: on a restricted case, only a chair who already works it (2098).
  v_chair := coalesce(authz.user_committee_seat(v_me, grievance.committee_id(), now()) in ('CHAIR', 'DEPUTY_CHAIR')
                      and authz.user_case_gate(v_me, p_g.case_id)
                      and (not (select c.is_restricted from case_mgmt.case_record c where c.id = p_g.case_id)
                           or authz.user_can_view_case(v_me, p_g.case_id)), false);
  -- One reconsideration of a decided grievance that is not itself one (api.file_grievance_reconsideration,
  -- api.record_grievance_reconsideration), within grievance.guard_grievance_scope: no reconsideration on the same
  -- decision yet and, for a known subject, no open grievance on it.
  v_reconsider := p_g.reconsideration_of is null and p_g.status = 'DECIDED'
    and not exists (select 1 from grievance.grievance x where x.reconsideration_of = p_g.id)
    and (p_g.grievant_subject_id is null or (
      not exists (select 1 from grievance.grievance x
                  where x.grievant_subject_id = p_g.grievant_subject_id and x.reconsideration_of is not null
                    and (x.contested_authority_decision_id = p_g.contested_authority_decision_id
                         or ((x.contested_authority_decision_id is null or p_g.contested_authority_decision_id is null)
                             and x.contested_decision_date = p_g.contested_decision_date)))
      and not exists (select 1 from grievance.grievance x
                      where x.grievant_subject_id = p_g.grievant_subject_id
                        and x.status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED')
                        and (x.contested_authority_decision_id is null or p_g.contested_authority_decision_id is null
                             or x.contested_authority_decision_id = p_g.contested_authority_decision_id))));
  return jsonb_build_object(
    -- api.assess_grievance_admissibility: the handling secretary (G3b), received, no completion pending.
    'may_assess', v_handle and not v_part and p_g.status = 'RECEIVED' and not v_open_request,
    -- api.request_grievance_completion: as above, with a configured completion period.
    'may_request_completion', v_handle and not v_part and p_g.status = 'RECEIVED' and not v_open_request
                              and exists (select 1 from committee.rule_set r
                                          where r.id = p_g.rule_set_id and r.grievance_completion_days is not null),
    -- api.complete_grievance: the grievant, answering the open request.
    'may_complete', v_grievant and p_g.status = 'RECEIVED' and v_open_request,
    -- api.decide_grievance_admissibility: reached (a viewer, or the chair for a CHAIR or COMMITTEE decision); EXTERNAL
    -- recorded by the handling secretary, otherwise the chair or deputy; neither took part (G3, G3b).
    'may_decide', coalesce(p_g.status = 'AWAITING_ADMISSIBILITY_DECISION'
                           and (v_view or (v_chair and v_pending in ('CHAIR', 'COMMITTEE')))
                           and case when v_pending = 'EXTERNAL' then v_handle and not v_part
                                    else v_chair and not v_part end, false),
    -- api.withdraw_grievance: the grievant, before the outcome.
    'may_withdraw', v_grievant and p_g.status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED'),
    -- api.record_grievance_outcome: the handling secretary, on an admitted grievance with an unused approved vote.
    'may_record_outcome', v_handle and p_g.status = 'ADMITTED'
                          and exists (select 1 from committee.vote_item vi
                                      join committee.meeting m on m.id = vi.meeting_id
                                      where m.committee_proceeding_id = p_g.committee_proceeding_id
                                        and vi.status = 'CLOSED' and vi.result = 'APPROVED'
                                        and not exists (select 1 from grievance.grievance_outcome o
                                                        where o.vote_item_id = vi.id)),
    -- api.file_grievance_reconsideration: the grievant through their own portal link.
    'may_file_reconsideration', v_grievant and p_g.grievant_subject_id is not null
                                and authz.is_portal_subject(p_g.grievant_subject_id) and v_reconsider,
    -- api.record_grievance_reconsideration: the handling secretary.
    'may_record_reconsideration', v_handle and v_reconsider);
end;
$$;
