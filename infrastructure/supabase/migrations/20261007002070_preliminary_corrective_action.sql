-- =============================================================================
-- 2070 Corrective action from preliminary review (P11-G3), and closure fails closed on a configured closure rule that
-- names no authority in force (Rebase PR-B; CDF-196, CDF-221)
-- Requirements: §18–§22, §29, §65, §68, §82, §83, §87; owner decision DEC-F41 (2026-10-13); ambiguity row AMB-021;
-- gap P11-G3; ADR-033 (corrective actions), ADR-036 (preliminary outcomes), ADR-040 §3 item 3 (DEC-F13 authority
-- rules), ADR-042 (2060 closure); coordinator rulings of 2026-10-14 (23:17, 23:19, 23:27); ADR-043
--
-- DEC-F41 (owner, 2026-10-13): "The architecture may let a corrective action originate from preliminary Compliance
-- review, but not automatically for every preliminary case: only where the configured business rule permits. The
-- preliminary team may recommend a corrective action without escalating to the Investigation Committee where the
-- matter needs no committee investigation or disciplinary action. Any authority or approval requirement for the action
-- follows its corrective-action type. Configurable and auditable."
-- CDF-221 (AGENT-09, 2026-10-14 23:20, LOW; placed here by the coordinator at 23:17): with CASE_CLOSURE_APPROVAL_RULE
-- CONFIGURED but naming no valid authority, case_mgmt.closure_authority_role() is null and the closure paths fell back
-- to direct closure; reopening already failed closed. Unreachable while the rule is SOURCE_REQUIRED.
--
-- This migration adds:
--   1. CDF-221. "Configured" is told apart from "an authority in force": while CASE_CLOSURE_APPROVAL_RULE is CONFIGURED
--      and names no authority in force (unknown, technical, PLATFORM_ADMIN, DB_ADMIN or unheld; 2060 R3), no path
--      closes a case: api.close_case and the readiness guard refuse with CASE_CLOSURE_APPROVAL_RULE_REQUIRED, and
--      api.available_transitions shows that code to those who may close (2060 R2). As reopening does.
--   2. DEC-F41 (AMB-021). The preparer of a preliminary recommendation whose outcome keeps the matter with Compliance
--      (NO_ACTION, NOT_SERIOUS or NOT_SUBSTANTIATED) may propose corrective actions of the types
--      PRELIMINARY_CORRECTIVE_ACTION_TYPES permits (SOURCE_REQUIRED: none until configured), before the review. The
--      recommendation's review and approval cover them. On approval each proposal needs the authority its type's rule
--      names (decision.action_authority_rule, DEC-F13; AUTHORITY_RULE_MISSING otherwise, fail closed); a
--      corrective-action manager records that authority's decision from its source document (N15), never the
--      proposer. An approved proposal opens corrective actions exactly as an approved package item does (ADR-033),
--      with the proposal as their origin. A case does not close while an approved proposal has no action
--      (CORRECTIVE_ACTIONS_OUTSTANDING) or a proposal waits for its authority (DECISION_NOT_FINAL).
--   3. A read model for the preliminary recommendation's proposals, with capability flags from the commands.
--
-- Additive: one setting, three tables, one column, four commands and a read model. decision.corrective_action keeps
-- every existing row and rule; its item and decision become optional only for a row whose origin is a proposal (a
-- check constraint). Replaced functions keep their signatures: case_mgmt.guard_case_readiness, api.close_case,
-- api.available_transitions and case_mgmt.closure_blocks (2060), decision.protect_corrective_records (2030) and
-- api.corrective_action_view (2040). No permission or role grant changes; no catalogue code, status or option code is
-- renamed or removed (DEC-35).
-- =============================================================================

-- =============================================================================
-- 1. CDF-221: a configured closure rule with no authority in force closes nothing
-- =============================================================================
-- Whether CASE_CLOSURE_APPROVAL_RULE has been configured at all, whatever it names. With it CONFIGURED,
-- case_mgmt.closure_authority_role() (2060) is the authority in force, or null: then nobody closes (fail closed).
create function case_mgmt.closure_rule_configured()
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from config.setting s where s.key = 'CASE_CLOSURE_APPROVAL_RULE' and s.status = 'CONFIGURED');
$$;

-- Every path from ACTIVE to CLOSED (2060), now also refused while the configured rule names no authority in force.
create or replace function case_mgmt.guard_case_readiness()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_blocks text[] := case_mgmt.closure_blocks(new.id);
begin
  if cardinality(v_blocks) > 0 then perform api._fail('CONFLICT', v_blocks[1]); end if;
  if case_mgmt.closure_rule_configured() then
    -- CDF-221: configured, but no authority in force.
    if case_mgmt.closure_authority_role() is null then
      perform api._fail('CONFLICT', 'CASE_CLOSURE_APPROVAL_RULE_REQUIRED');
    end if;
    if not exists (select 1 from case_mgmt.case_closure c
                   where c.case_id = new.id and c.transaction_id = pg_current_xact_id()) then
      perform api._fail('CONFLICT', 'CLOSURE_APPROVAL_REQUIRED');
    end if;
  end if;
  return new;
end;
$$;

-- 2060's command; the CDF-221 refusal comes straight after NOT_FOUND, as in api.request_case_reopening. While the rule
-- is SOURCE_REQUIRED, nothing changes.
create or replace function api.close_case(p_case_id uuid, p_outcome_code text, p_rationale text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_authority text := case_mgmt.closure_authority_role();
  v_rationale text;
  v_blocks text[];
  v_step text;
  v_id uuid;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  -- CDF-221: a configured rule that names no authority in force closes nothing (fail closed).
  if v_authority is null and case_mgmt.closure_rule_configured() then
    perform api._fail('CONFLICT', 'CASE_CLOSURE_APPROVAL_RULE_REQUIRED');
  end if;
  if not authz.has_permission('WORKFLOW_ADVANCE') or not authz.user_case_gate(v_actor, p_case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  if v_case.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
  if p_outcome_code is null
     or not exists (select 1 from case_mgmt.case_outcome_code o where o.code = p_outcome_code and o.is_active) then
    perform api._fail('INVALID', 'outcome_code');
  end if;
  v_rationale := api._require_text(p_rationale, 'rationale', 10, 2000);
  if exists (select 1 from case_mgmt.case_closure_request r where r.case_id = p_case_id and r.status = 'AWAITING_APPROVAL') then
    perform api._fail('CONFLICT', 'CLOSURE_REQUEST_PENDING');
  end if;
  v_blocks := case_mgmt.closure_blocks(p_case_id);
  if cardinality(v_blocks) > 0 then perform api._fail('CONFLICT', v_blocks[1]); end if;
  v_step := case_mgmt.closure_step(p_case_id);
  if v_step is null then
    perform api._fail('CONFLICT', case when v_authority is null then 'CASE_CLOSURE_APPROVAL_RULE_REQUIRED'
                                       else 'CLOSURE_STEP_NOT_AVAILABLE' end);
  end if;
  if v_authority is not null and not authz.user_has_role(v_actor, v_authority) then
    insert into case_mgmt.case_closure_request (case_id, outcome_code, rationale, requested_by)
    values (p_case_id, p_outcome_code, v_rationale, v_actor)
    returning id into v_id;
    perform audit.record_event('CASE_CLOSURE_REQUESTED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_closure_request',
      v_id::text, null, jsonb_build_object('outcome_code', p_outcome_code, 'transition', v_step));
    return 'AWAITING_APPROVAL';
  end if;
  -- Direct: the step itself runs through api.transition_case, with its checks in its order.
  perform case_mgmt.record_closure(p_case_id, p_outcome_code, v_rationale, v_step, v_actor, null);
  perform api.transition_case(p_case_id, v_step, v_rationale);
  return 'CLOSED';
end;
$$;

-- 2060's list; a step into CLOSURE now carries CASE_CLOSURE_APPROVAL_RULE_REQUIRED while the configured rule names no
-- authority in force, else CLOSURE_APPROVAL_REQUIRED once it is configured. Still only for a caller holding the step's
-- permission within their clearance and without a case conflict (2060 R2).
create or replace function api.available_transitions(p_case_id uuid)
returns table (
  code text, to_state text, name_en text, name_ar text, reason_required boolean,
  is_enabled boolean, enabled_in_phase int, allowed boolean, blocking_reasons text[]
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_actor uuid := authz.current_user_id();
  v_inst workflow.workflow_instance;
  t workflow.workflow_transition_definition;
  v_reasons text[];
  v_r text;
  c text;
begin
  if v_actor is null or not authz.can_view_case(p_case_id) then
    return;
  end if;
  select * into v_inst from workflow.workflow_instance i where i.case_id = p_case_id;
  for t in
    select * from workflow.workflow_transition_definition d
    where d.workflow_code = v_inst.workflow_code and d.from_state = v_inst.current_state and not d.is_system
    order by d.code
  loop
    v_reasons := '{}';
    if not t.is_enabled then v_reasons := v_reasons || 'NOT_YET_AVAILABLE'::text; end if;
    if not authz.has_permission(t.required_permission) then v_reasons := v_reasons || 'MISSING_PERMISSION'::text; end if;
    if t.approval_required and authz.has_active_assignment(p_case_id, v_actor, array['LEAD_INVESTIGATOR', 'INVESTIGATOR']) then
      v_reasons := v_reasons || 'SEPARATION_OF_DUTIES'::text;
    end if;
    foreach c in array t.required_conditions loop
      v_r := workflow.evaluate_condition(c, p_case_id, v_actor);
      if v_r is not null then v_reasons := v_reasons || v_r; end if;
    end loop;
    if authz.has_permission(t.required_permission) and authz.user_case_gate(v_actor, p_case_id)
       and exists (select 1 from workflow.workflow_state s
                   where s.workflow_code = t.workflow_code and s.code = t.to_state and s.records_state = 'CLOSED') then
      v_reasons := v_reasons || case_mgmt.closure_blocks(p_case_id);
      if case_mgmt.closure_rule_configured() then
        v_reasons := v_reasons || case when case_mgmt.closure_authority_role() is null
                                       then 'CASE_CLOSURE_APPROVAL_RULE_REQUIRED' else 'CLOSURE_APPROVAL_REQUIRED' end;
      end if;
    end if;
    code := t.code; to_state := t.to_state; name_en := t.name_en; name_ar := t.name_ar;
    reason_required := t.reason_required; is_enabled := t.is_enabled; enabled_in_phase := t.enabled_in_phase;
    allowed := cardinality(v_reasons) = 0; blocking_reasons := v_reasons;
    return next;
  end loop;
end;
$$;

-- =============================================================================
-- 2. Corrective action from preliminary review (DEC-F41, AMB-021, P11-G3)
-- =============================================================================
-- 2.1 The rule: which corrective-action types a preliminary review may recommend. Migration-managed like the other
-- SOURCE_REQUIRED values; until CDF configures it, no preliminary review recommends any (fail closed). A value naming
-- anything but the two corrective types permits nothing more.
insert into config.setting (key, value, status, source_reference, description) values
  ('PRELIMINARY_CORRECTIVE_ACTION_TYPES', null, 'SOURCE_REQUIRED', null,
   'DEC-F41 / AMB-021: the corrective-action types a preliminary review may recommend without the Investigation '
   'Committee, comma-separated (CORRECTIVE_ACTION, GOVERNANCE_REMEDIATION). Until configured none may (fail closed). '
   'The authority and approval of each action follow its type (decision.action_authority_rule, DEC-F13).');

create function case_mgmt.preliminary_corrective_types()
returns text[]
language sql stable
set search_path = ''
as $$
  select coalesce((
    select array_agg(distinct btrim(x.v) order by btrim(x.v))
    from config.setting s
    cross join lateral unnest(string_to_array(s.value, ',')) x(v)
    where s.key = 'PRELIMINARY_CORRECTIVE_ACTION_TYPES' and s.status = 'CONFIGURED'
      and btrim(x.v) in ('CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION')), '{}'::text[]);
$$;

-- The preliminary outcomes that keep the matter with Compliance, needing no committee investigation or disciplinary
-- action (DEC-F41): no further action, not serious, not substantiated. Escalations (INVESTIGATION_WARRANTED,
-- REFERRED_TO_COMMITTEE) and the outcomes that send the matter elsewhere or end it unprocessed are excluded: the
-- narrowing default, changed only by a later migration (ADR-043).
create function case_mgmt.preliminary_corrective_outcome(p_outcome text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(p_outcome in ('NO_ACTION', 'NOT_SERIOUS', 'NOT_SUBSTANTIATED'), false);
$$;

-- 2.2 Proposals: part of the recommendation version they are made on, covered by its review and approval.
create table case_mgmt.preliminary_corrective_proposal (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid not null references case_mgmt.case_record (id),
  recommendation_id uuid not null references case_mgmt.preliminary_recommendation (id),
  sequence_no       int not null check (sequence_no >= 1),
  action_type       text not null check (action_type in ('CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION')),
  summary           text not null check (length(summary) between 10 and 4000),
  proposed_by       uuid not null references iam.user_profile (id),
  proposed_at       timestamptz not null default now(),
  unique (recommendation_id, sequence_no)
);
create index preliminary_corrective_proposal_case on case_mgmt.preliminary_corrective_proposal (case_id);
create index preliminary_corrective_proposal_proposed_by on case_mgmt.preliminary_corrective_proposal (proposed_by);
comment on table case_mgmt.preliminary_corrective_proposal is
  'A corrective action a preliminary recommendation proposes without the Investigation Committee (DEC-F41, migration '
  '2070): made by the recommendation''s preparer before its review, where the rule permits the type and the outcome '
  'keeps the matter with Compliance. Append-only.';

-- Every path: only the preparer, on their own undecided and unreviewed version, for an eligible outcome and a
-- permitted type.
create function case_mgmt.guard_preliminary_corrective_proposal()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_r case_mgmt.preliminary_recommendation;
begin
  select * into v_r from case_mgmt.preliminary_recommendation r where r.id = new.recommendation_id;
  if v_r.case_id is distinct from new.case_id or v_r.prepared_by is distinct from new.proposed_by then
    perform api._fail('INVALID', 'recommendation_id');
  end if;
  if v_r.status not in ('AWAITING_REVIEW', 'AWAITING_APPROVAL') or v_r.reviewed_by is not null then
    perform api._fail('CONFLICT', 'RECOMMENDATION_NOT_OPEN_FOR_PROPOSALS');
  end if;
  if not case_mgmt.preliminary_corrective_outcome(v_r.recommended_outcome) then
    perform api._fail('CONFLICT', 'OUTCOME_NOT_ELIGIBLE_FOR_CORRECTIVE_ACTION');
  end if;
  if not (new.action_type = any (case_mgmt.preliminary_corrective_types())) then
    perform api._fail('CONFLICT', 'PRELIMINARY_CORRECTIVE_ACTION_NOT_PERMITTED');
  end if;
  return new;
end;
$$;
create trigger preliminary_corrective_proposal_guard before insert on case_mgmt.preliminary_corrective_proposal
  for each row execute function case_mgmt.guard_preliminary_corrective_proposal();
create trigger no_update before update on case_mgmt.preliminary_corrective_proposal
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on case_mgmt.preliminary_corrective_proposal
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on case_mgmt.preliminary_corrective_proposal
  for each statement execute function committee.reject_mutation();

-- 2.3 The authority each approved proposal needs: its type's rule in force when the recommendation is approved, with
-- its joint authorities (DEC-F13, as authority_requirement snapshots a package's submission).
create table decision.preliminary_authority_requirement (
  proposal_id        uuid not null references case_mgmt.preliminary_corrective_proposal (id),
  authority_type     text not null references decision.authority_type (code),
  case_id            uuid not null references case_mgmt.case_record (id),
  rule_id            uuid not null references decision.action_authority_rule (id),
  rule_source_status text not null check (rule_source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  created_at         timestamptz not null default now(),
  primary key (proposal_id, authority_type)
);
create index preliminary_authority_requirement_case on decision.preliminary_authority_requirement (case_id);
create index preliminary_authority_requirement_rule on decision.preliminary_authority_requirement (rule_id);
create index preliminary_authority_requirement_type on decision.preliminary_authority_requirement (authority_type);
comment on table decision.preliminary_authority_requirement is
  'The authorities a preliminary corrective proposal needs, snapshotted from its type''s rule when the recommendation '
  'is approved (DEC-F41, DEC-F13; migration 2070). Append-only.';

-- Every path: only for a proposal whose recommendation is approved, from its type's rule in force.
create function decision.guard_preliminary_requirement()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_p case_mgmt.preliminary_corrective_proposal;
  v_rule decision.action_authority_rule;
begin
  select * into v_p from case_mgmt.preliminary_corrective_proposal x where x.id = new.proposal_id;
  select * into v_rule from decision.action_authority_rule r where r.id = decision.authority_rule_in_force(v_p.action_type);
  if v_p.case_id is distinct from new.case_id
     or not exists (select 1 from case_mgmt.preliminary_recommendation r
                    where r.id = v_p.recommendation_id and r.status = 'APPROVED')
     or new.rule_id is distinct from v_rule.id or new.rule_source_status is distinct from v_rule.source_status
     or not (new.authority_type = v_rule.authority_type
             or exists (select 1 from decision.action_authority_rule_joint j
                        where j.rule_id = v_rule.id and j.authority_type = new.authority_type)) then
    perform api._fail('INVALID', 'preliminary_authority_requirement');
  end if;
  return new;
end;
$$;
create trigger preliminary_authority_requirement_guard before insert on decision.preliminary_authority_requirement
  for each row execute function decision.guard_preliminary_requirement();
create trigger no_update before update on decision.preliminary_authority_requirement
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on decision.preliminary_authority_requirement
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on decision.preliminary_authority_requirement
  for each statement execute function committee.reject_mutation();

-- Approving the recommendation, on every path: each proposal's type must still be permitted and have a rule in force
-- (AUTHORITY_RULE_MISSING otherwise, as a package's submission); its requirements are written. Either refusal refuses
-- the approval: the approver returns the recommendation, and the next version proposes again or not at all.
create function case_mgmt.require_preliminary_corrective_authority()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  p case_mgmt.preliminary_corrective_proposal;
  v_rule uuid;
begin
  for p in select * from case_mgmt.preliminary_corrective_proposal x where x.recommendation_id = new.id
           order by x.sequence_no loop
    if not (p.action_type = any (case_mgmt.preliminary_corrective_types())) then
      perform api._fail('CONFLICT', 'PRELIMINARY_CORRECTIVE_ACTION_NOT_PERMITTED');
    end if;
    v_rule := decision.authority_rule_in_force(p.action_type);
    if v_rule is null then perform api._fail('CONFLICT', 'AUTHORITY_RULE_MISSING'); end if;
    insert into decision.preliminary_authority_requirement (proposal_id, authority_type, case_id, rule_id,
                                                            rule_source_status)
    select p.id, t.authority_type, p.case_id, r.id, r.source_status
    from decision.action_authority_rule r
    cross join lateral (select r.authority_type
                        union
                        select j.authority_type from decision.action_authority_rule_joint j where j.rule_id = r.id) t
    where r.id = v_rule;
  end loop;
  return null;
end;
$$;
create trigger preliminary_recommendation_corrective_authority after update of status
  on case_mgmt.preliminary_recommendation
  for each row when (new.status = 'APPROVED' and old.status is distinct from 'APPROVED')
  execute function case_mgmt.require_preliminary_corrective_authority();

-- 2.4 The authority's decision on a proposal, recorded from its source document (N15).
create table decision.preliminary_authority_decision (
  id                        uuid primary key default gen_random_uuid(),
  proposal_id               uuid not null,
  authority_type            text not null,
  case_id                   uuid not null references case_mgmt.case_record (id),
  outcome                   text not null check (outcome in ('APPROVED', 'REJECTED')),
  decided_at                timestamptz not null,
  decided_by_label          text not null check (length(decided_by_label) between 3 and 200),
  source_document_reference text not null check (length(source_document_reference) between 3 and 300),
  reason                    text check (length(reason) between 5 and 4000),
  recorded_by               uuid not null references iam.user_profile (id),
  recorded_at               timestamptz not null default now(),
  unique (proposal_id, authority_type),
  foreign key (proposal_id, authority_type)
    references decision.preliminary_authority_requirement (proposal_id, authority_type),
  check (decided_at <= recorded_at)
);
create index preliminary_authority_decision_case on decision.preliminary_authority_decision (case_id);
create index preliminary_authority_decision_recorded_by on decision.preliminary_authority_decision (recorded_by);
comment on table decision.preliminary_authority_decision is
  'A required authority''s decision on a preliminary corrective proposal, recorded from its source document by a '
  'corrective-action manager who did not propose it (DEC-F41, migration 2070). Append-only; the reason stays here.';

-- Every path: on the proposal's case, never recorded by its proposer.
create function decision.guard_preliminary_authority_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_p case_mgmt.preliminary_corrective_proposal;
begin
  select * into v_p from case_mgmt.preliminary_corrective_proposal x where x.id = new.proposal_id;
  if v_p.case_id is distinct from new.case_id then perform api._fail('INVALID', 'proposal_id'); end if;
  if v_p.proposed_by = new.recorded_by then perform api._fail('CONFLICT', 'PROPOSER_CANNOT_RECORD'); end if;
  return new;
end;
$$;
create trigger preliminary_authority_decision_guard before insert on decision.preliminary_authority_decision
  for each row execute function decision.guard_preliminary_authority_decision();
create trigger no_update before update on decision.preliminary_authority_decision
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on decision.preliminary_authority_decision
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on decision.preliminary_authority_decision
  for each statement execute function committee.reject_mutation();

-- Where a proposal stands: PROPOSED (its recommendation is undecided), LAPSED (returned; the next version proposes
-- again), REJECTED (an authority rejected it), AWAITING_AUTHORITY (approved, a required authority has not decided, or
-- no requirement was written: fail closed) or APPROVED (every required authority approved it).
create function decision.preliminary_proposal_state(p_proposal_id uuid)
returns text
language sql stable
set search_path = ''
as $$
  select case
           when r.status in ('AWAITING_REVIEW', 'AWAITING_APPROVAL') then 'PROPOSED'
           when r.status = 'RETURNED' then 'LAPSED'
           when exists (select 1 from decision.preliminary_authority_decision d
                        where d.proposal_id = x.id and d.outcome = 'REJECTED') then 'REJECTED'
           when not exists (select 1 from decision.preliminary_authority_requirement q where q.proposal_id = x.id)
                or exists (select 1 from decision.preliminary_authority_requirement q
                           where q.proposal_id = x.id
                             and not exists (select 1 from decision.preliminary_authority_decision d
                                             where d.proposal_id = q.proposal_id and d.authority_type = q.authority_type))
             then 'AWAITING_AUTHORITY'
           else 'APPROVED'
         end
  from case_mgmt.preliminary_corrective_proposal x
  join case_mgmt.preliminary_recommendation r on r.id = x.recommendation_id
  where x.id = p_proposal_id;
$$;

-- 2.5 A corrective action's origin: an approved package item and its decision (ADR-033), or an approved preliminary
-- proposal (DEC-F41), never both and never neither. Existing rows are package-origin and keep their columns.
alter table decision.corrective_action
  add column preliminary_proposal_id uuid references case_mgmt.preliminary_corrective_proposal (id),
  alter column recommendation_item_id drop not null,
  alter column authority_decision_id drop not null,
  add constraint corrective_action_origin check (
    (preliminary_proposal_id is null and recommendation_item_id is not null and authority_decision_id is not null)
    or (preliminary_proposal_id is not null and recommendation_item_id is null and authority_decision_id is null)),
  add constraint corrective_action_proposal_sequence unique (preliminary_proposal_id, sequence_no);
comment on column decision.corrective_action.preliminary_proposal_id is
  'DEC-F41 (migration 2070): the approved preliminary proposal the action executes, instead of a package item and its '
  'authority decision.';

-- Every path: an action from a proposal only once every authority it needs approved it, on its case and of its type.
create function decision.guard_preliminary_action()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_p case_mgmt.preliminary_corrective_proposal;
begin
  select * into v_p from case_mgmt.preliminary_corrective_proposal x where x.id = new.preliminary_proposal_id;
  if v_p.case_id is distinct from new.case_id or v_p.action_type is distinct from new.action_type then
    perform api._fail('INVALID', 'preliminary_proposal_id');
  end if;
  if decision.preliminary_proposal_state(v_p.id) <> 'APPROVED' then
    perform api._fail('CONFLICT', 'PROPOSAL_NOT_APPROVED');
  end if;
  return new;
end;
$$;
create trigger corrective_action_preliminary before insert on decision.corrective_action
  for each row when (new.preliminary_proposal_id is not null)
  execute function decision.guard_preliminary_action();

-- 2030's guard, with the proposal added to the origin that never changes.
create or replace function decision.protect_corrective_records()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_fixed text[] := array['id', 'case_id', 'recommendation_item_id', 'authority_decision_id', 'preliminary_proposal_id',
                          'action_type', 'sequence_no', 'created_by', 'created_at'];
begin
  if tg_table_name = 'corrective_action' then
    if old.status = 'WAIVED'
       or (select jsonb_object_agg(k, to_jsonb(new) -> k) from unnest(v_fixed) k)
          <> (select jsonb_object_agg(k, to_jsonb(old) -> k) from unnest(v_fixed) k)
       or ((new.title, new.description, new.version_no) is distinct from (old.title, old.description, old.version_no)
           and (new.version_no <> old.version_no + 1
                or not exists (select 1 from decision.corrective_action_version v
                               where v.action_id = old.id and v.version_no = new.version_no
                                 and v.title = new.title and v.description = new.description))) then
      raise exception 'corrective action % is final or its origin is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'corrective_action_policy' then
    if (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') or old.effective_to is not null then
      raise exception 'corrective-action policy % can only be given an end, once', old.id using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

-- 2.6 Reads. The proposals are read as the recommendation is (its team, and its approver while it awaits them or
-- after they approved it); the requirements and decisions by the case team.
alter table case_mgmt.preliminary_corrective_proposal enable row level security;
alter table decision.preliminary_authority_requirement enable row level security;
alter table decision.preliminary_authority_decision enable row level security;
create policy preliminary_corrective_proposal_read on case_mgmt.preliminary_corrective_proposal for select
  to authenticated using (authz.can_view_preliminary_recommendation(recommendation_id));
create policy preliminary_authority_requirement_read on decision.preliminary_authority_requirement for select
  to authenticated using (authz.can_view_case(case_id));
create policy preliminary_authority_decision_read on decision.preliminary_authority_decision for select
  to authenticated using (authz.can_view_case(case_id));
grant select on case_mgmt.preliminary_corrective_proposal, decision.preliminary_authority_requirement,
  decision.preliminary_authority_decision to authenticated;

-- 2.7 Proposing (the preparer, before the review). Checks in this order: NOT_FOUND, FORBIDDEN, CASE_NOT_ACTIVE,
-- RECOMMENDATION_NOT_OPEN_FOR_PROPOSALS, OUTCOME_NOT_ELIGIBLE_FOR_CORRECTIVE_ACTION, the type.
create function api.propose_preliminary_corrective_action(p_recommendation_id uuid, p_action_type text,
                                                          p_summary text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r case_mgmt.preliminary_recommendation;
  v_summary text;
  v_seq int;
  v_id uuid;
begin
  select * into v_r from case_mgmt.preliminary_recommendation r where r.id = p_recommendation_id;
  if v_r.id is null or not authz.can_view_case(v_r.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('PRELIMINARY_PREPARE') or v_r.prepared_by <> v_actor then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_r.case_id for update;
  if (select c.records_state from case_mgmt.case_record c where c.id = v_r.case_id) <> 'ACTIVE' then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  select * into v_r from case_mgmt.preliminary_recommendation r where r.id = p_recommendation_id for update;
  if v_r.status not in ('AWAITING_REVIEW', 'AWAITING_APPROVAL') or v_r.reviewed_by is not null then
    perform api._fail('CONFLICT', 'RECOMMENDATION_NOT_OPEN_FOR_PROPOSALS');
  end if;
  if not case_mgmt.preliminary_corrective_outcome(v_r.recommended_outcome) then
    perform api._fail('CONFLICT', 'OUTCOME_NOT_ELIGIBLE_FOR_CORRECTIVE_ACTION');
  end if;
  if p_action_type is null or p_action_type not in ('CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION') then
    perform api._fail('INVALID', 'action_type');
  end if;
  if not (p_action_type = any (case_mgmt.preliminary_corrective_types())) then
    perform api._fail('CONFLICT', 'PRELIMINARY_CORRECTIVE_ACTION_NOT_PERMITTED');
  end if;
  v_summary := api._require_text(p_summary, 'summary', 10, 4000);
  select coalesce(max(x.sequence_no), 0) + 1 into v_seq from case_mgmt.preliminary_corrective_proposal x
  where x.recommendation_id = v_r.id;
  insert into case_mgmt.preliminary_corrective_proposal (case_id, recommendation_id, sequence_no, action_type, summary,
                                                         proposed_by)
  values (v_r.case_id, v_r.id, v_seq, p_action_type, v_summary, v_actor)
  returning id into v_id;
  perform audit.record_event('PRELIMINARY_CORRECTIVE_ACTION_PROPOSED', 'BUSINESS', 'SUCCESS', v_r.case_id,
    'preliminary_corrective_proposal', v_id::text, null,
    jsonb_build_object('recommendation_id', v_r.id, 'version_no', v_r.version_no, 'sequence_no', v_seq,
                       'action_type', p_action_type));
  return v_id;
end;
$$;

-- 2.8 Recording a required authority's decision (a corrective-action manager within their clearance and without a case
-- conflict, never the proposer). Checks in this order: NOT_FOUND, FORBIDDEN, PROPOSER_CANNOT_RECORD, CASE_NOT_ACTIVE,
-- RECOMMENDATION_NOT_APPROVED, AUTHORITY_TYPE_MISMATCH, AUTHORITY_ALREADY_DECIDED, then the fields.
create function api.record_preliminary_authority_decision(p_proposal_id uuid, p_authority_type text, p_outcome text,
                                                          p_decided_at timestamptz, p_decided_by_label text,
                                                          p_source_document_reference text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p case_mgmt.preliminary_corrective_proposal;
  v_r case_mgmt.preliminary_recommendation;
  v_q decision.preliminary_authority_requirement;
  v_id uuid;
  v_state text;
begin
  select * into v_p from case_mgmt.preliminary_corrective_proposal x where x.id = p_proposal_id;
  if v_p.id is null or not authz.can_view_case(v_p.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('CORRECTIVE_ACTION_MANAGE') or not authz.user_case_gate(v_actor, v_p.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_p.proposed_by = v_actor then perform api._fail('CONFLICT', 'PROPOSER_CANNOT_RECORD'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_p.case_id for update;
  if (select c.records_state from case_mgmt.case_record c where c.id = v_p.case_id) <> 'ACTIVE' then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  select * into v_r from case_mgmt.preliminary_recommendation r where r.id = v_p.recommendation_id;
  if v_r.status <> 'APPROVED' then perform api._fail('CONFLICT', 'RECOMMENDATION_NOT_APPROVED'); end if;
  select * into v_q from decision.preliminary_authority_requirement q
  where q.proposal_id = v_p.id and q.authority_type = p_authority_type;
  if v_q.proposal_id is null then perform api._fail('CONFLICT', 'AUTHORITY_TYPE_MISMATCH'); end if;
  if exists (select 1 from decision.preliminary_authority_decision d
             where d.proposal_id = v_p.id and d.authority_type = p_authority_type) then
    perform api._fail('CONFLICT', 'AUTHORITY_ALREADY_DECIDED');
  end if;
  if p_outcome is null or p_outcome not in ('APPROVED', 'REJECTED') then perform api._fail('INVALID', 'outcome'); end if;
  if p_decided_at is null or p_decided_at > now()
     or (p_decided_at at time zone 'Asia/Riyadh')::date < (v_r.approved_at at time zone 'Asia/Riyadh')::date then
    perform api._fail('INVALID', 'decided_at');
  end if;
  insert into decision.preliminary_authority_decision (proposal_id, authority_type, case_id, outcome, decided_at,
                                                       decided_by_label, source_document_reference, reason,
                                                       recorded_by)
  values (v_p.id, p_authority_type, v_p.case_id, p_outcome, p_decided_at,
          api._require_text(p_decided_by_label, 'decided_by_label', 3, 200),
          api._require_text(p_source_document_reference, 'source_document_reference', 3, 300),
          case when p_reason is not null then api._require_text(p_reason, 'reason', 5, 4000) end, v_actor)
  returning id into v_id;
  v_state := decision.preliminary_proposal_state(v_p.id);
  perform audit.record_event('PRELIMINARY_AUTHORITY_DECISION_RECORDED', 'BUSINESS', 'SUCCESS', v_p.case_id,
    'preliminary_authority_decision', v_id::text, null,
    jsonb_build_object('proposal_id', v_p.id, 'recommendation_id', v_r.id, 'authority_type', p_authority_type,
                       'outcome', p_outcome, 'rule_id', v_q.rule_id, 'rule_source_status', v_q.rule_source_status,
                       'proposal_state', v_state, 'has_reason', p_reason is not null));
  return v_id;
end;
$$;

-- 2.9 Opening an action from an approved proposal: api.open_corrective_action's checks in its order, with the proposal
-- in place of the item (ADR-033: a manager names an eligible owner; a restricted case's own authority names them).
create function api.open_preliminary_corrective_action(p_proposal_id uuid, p_title text, p_description text,
                                                       p_owner_id uuid, p_due_date date)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p case_mgmt.preliminary_corrective_proposal;
  v_policy decision.corrective_action_policy;
  v_due date;
  v_seq int;
  v decision.corrective_action;
begin
  select * into v_p from case_mgmt.preliminary_corrective_proposal x where x.id = p_proposal_id;
  if v_p.id is null or not authz.can_view_case(v_p.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform decision.require_manager(v_p.case_id);
  if decision.preliminary_proposal_state(v_p.id) <> 'APPROVED' then perform api._fail('CONFLICT', 'PROPOSAL_NOT_APPROVED'); end if;
  perform decision.require_owner_naming(v_p.case_id);
  if not decision.owner_eligible(p_owner_id, v_p.case_id) then perform api._fail('INVALID', 'owner_id'); end if;
  v_policy := decision.current_corrective_policy(v_p.action_type);
  v_due := coalesce(p_due_date, decision.local_today() + v_policy.default_due_days);
  if v_due is null or v_due < decision.local_today() then perform api._fail('INVALID', 'due_date'); end if;
  perform pg_advisory_xact_lock(hashtext('decision.corrective_action:proposal:' || v_p.id));
  select coalesce(max(a.sequence_no), 0) + 1 into v_seq from decision.corrective_action a
   where a.preliminary_proposal_id = v_p.id;
  insert into decision.corrective_action (case_id, preliminary_proposal_id, action_type, sequence_no, title, description,
                                          owner_id, due_date, created_by)
  values (v_p.case_id, v_p.id, v_p.action_type, v_seq,
          api._require_text(p_title, 'title', 5, 200), api._require_text(p_description, 'description', 10, 4000),
          p_owner_id, v_due, v_actor)
  returning * into v;
  perform decision.record_action_event(v, 'OPENED', null, null, null, p_owner_id, v_due, null);
  perform notify.enqueue('CORRECTIVE_ACTION_ASSIGNED', p_owner_id, v.id, null, 'action-assigned:' || v.id || ':' || v_seq || ':0');
  perform audit.record_event('CORRECTIVE_ACTION_OPENED', 'BUSINESS', 'SUCCESS', v.case_id, 'corrective_action',
    v.id::text, null,
    jsonb_build_object('origin', 'PRELIMINARY_REVIEW', 'preliminary_proposal_id', v_p.id,
                       'preliminary_recommendation_id', v_p.recommendation_id, 'action_type', v_p.action_type,
                       'sequence_no', v_seq, 'owner_id', p_owner_id, 'due_date', v_due,
                       'due_date_from_policy', p_due_date is null));
  return v.id;
end;
$$;

-- 2.10 What the recommendation's readers see of its proposals. The proposals (with their summaries) to everyone who
-- reads the recommendation; the authorities, their decisions and the actions to the case team only. Capabilities are
-- the commands' checks in the commands' order, without locks; false, never null. A read: the commands are the
-- audited events.
create function api.preliminary_corrective_view(p_recommendation_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_me uuid := authz.current_user_id();
  v_r case_mgmt.preliminary_recommendation;
  v_case case_mgmt.case_record;
  v_team boolean;
  v_manager boolean;
  v_recorder boolean;
  v_naming boolean;
  v_types text[] := case_mgmt.preliminary_corrective_types();
begin
  if p_recommendation_id is null or not authz.can_view_preliminary_recommendation(p_recommendation_id) then
    perform api._fail('NOT_FOUND');
  end if;
  select * into v_r from case_mgmt.preliminary_recommendation r where r.id = p_recommendation_id;
  select * into v_case from case_mgmt.case_record c where c.id = v_r.case_id;
  v_team := authz.can_view_case(v_r.case_id);
  -- decision.require_manager.
  v_manager := authz.has_permission('CORRECTIVE_ACTION_MANAGE') and v_team;
  -- api.record_preliminary_authority_decision: a manager within their clearance, without a case conflict.
  v_recorder := v_manager and authz.user_case_gate(v_me, v_r.case_id) and v_case.records_state = 'ACTIVE'
                and v_r.status = 'APPROVED';
  -- decision.require_owner_naming.
  v_naming := v_case.records_state = 'ACTIVE'
              and (not v_case.is_restricted
                   or (v_case.owner_id = v_me and authz.is_restricted_case_authority(v_me, v_case.classification)));
  return jsonb_build_object(
    'recommendation_id', v_r.id, 'version_no', v_r.version_no, 'status', v_r.status,
    'recommended_outcome', v_r.recommended_outcome,
    'outcome_eligible', case_mgmt.preliminary_corrective_outcome(v_r.recommended_outcome),
    'permitted_action_types', to_jsonb(v_types),
    -- api.propose_preliminary_corrective_action.
    'may_propose', coalesce(v_team and authz.has_permission('PRELIMINARY_PREPARE') and v_r.prepared_by = v_me
                            and v_case.records_state = 'ACTIVE'
                            and v_r.status in ('AWAITING_REVIEW', 'AWAITING_APPROVAL') and v_r.reviewed_by is null
                            and case_mgmt.preliminary_corrective_outcome(v_r.recommended_outcome)
                            and cardinality(v_types) > 0, false),
    'proposals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'proposal_id', x.id, 'sequence_no', x.sequence_no, 'action_type', x.action_type, 'summary', x.summary,
               'proposed_by', x.proposed_by, 'proposed_at', x.proposed_at,
               'state', decision.preliminary_proposal_state(x.id),
               'authorities', case when v_team then coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'authority_type', q.authority_type, 'rule_id', q.rule_id,
                          'rule_source_status', q.rule_source_status,
                          'decision', (select jsonb_build_object(
                                                'decision_id', d.id, 'outcome', d.outcome, 'decided_at', d.decided_at,
                                                'decided_by_label', d.decided_by_label,
                                                'source_document_reference', d.source_document_reference,
                                                'reason', d.reason, 'recorded_by', d.recorded_by,
                                                'recorded_at', d.recorded_at)
                                       from decision.preliminary_authority_decision d
                                       where d.proposal_id = q.proposal_id and d.authority_type = q.authority_type),
                          -- api.record_preliminary_authority_decision.
                          'may_record', coalesce(v_recorder and x.proposed_by <> v_me
                                                 and not exists (select 1 from decision.preliminary_authority_decision d
                                                                 where d.proposal_id = q.proposal_id
                                                                   and d.authority_type = q.authority_type), false))
                        order by q.authority_type collate "C")
                 from decision.preliminary_authority_requirement q where q.proposal_id = x.id), '[]'::jsonb) end,
               'actions', case when v_team then coalesce((
                 select jsonb_agg(jsonb_build_object('action_id', a.id, 'sequence_no', a.sequence_no, 'status', a.status)
                                  order by a.sequence_no)
                 from decision.corrective_action a where a.preliminary_proposal_id = x.id), '[]'::jsonb) end,
               -- api.open_preliminary_corrective_action (the owner is checked when named).
               'may_open_action', coalesce(v_manager and decision.preliminary_proposal_state(x.id) = 'APPROVED'
                                           and v_naming, false))
             order by x.sequence_no)
      from case_mgmt.preliminary_corrective_proposal x where x.recommendation_id = v_r.id), '[]'::jsonb));
end;
$$;

-- 2.11 Closure readiness (2060), with the preliminary path: an approved proposal with no action is outstanding work
-- (CORRECTIVE_ACTIONS_OUTSTANDING; its actions are corrective actions of the case, already counted), and a proposal
-- waiting for its authority is a decision that is not final (DECISION_NOT_FINAL). Otherwise 2060's function unchanged.
create or replace function case_mgmt.closure_blocks(p_case_id uuid)
returns text[]
language sql stable
set search_path = ''
as $$
  select array_remove(array[
    case when exists (select 1 from decision.conflict_remediation r where r.case_id = p_case_id and r.status = 'OPEN')
         then 'CONFLICT_REMEDIATION_OPEN' end,
    case when exists (select 1 from decision.recommendation_package p
                      where p.case_id = p_case_id and p.status = 'DECIDED' and decision.package_tainted(p.id))
         then 'TAINTED_BY_CONFLICT' end,
    case when exists (select 1 from decision.corrective_action a
                      where a.case_id = p_case_id and decision.action_block(a.id) = 'FROZEN_BY_SUPERSEDED_DECISION')
         then 'FROZEN_BY_SUPERSEDED_DECISION' end,
    case when exists (select 1 from decision.corrective_action a
                      where a.case_id = p_case_id and a.status not in ('COMPLETED', 'WAIVED'))
           or exists (select 1 from decision.recommendation_item i
                      where i.case_id = p_case_id and decision.approving_decision(i.id) is not null
                        and not exists (select 1 from decision.corrective_action a where a.recommendation_item_id = i.id))
           or exists (select 1 from case_mgmt.preliminary_corrective_proposal x
                      where x.case_id = p_case_id and decision.preliminary_proposal_state(x.id) = 'APPROVED'
                        and not exists (select 1 from decision.corrective_action a where a.preliminary_proposal_id = x.id))
         then 'CORRECTIVE_ACTIONS_OUTSTANDING' end,
    -- CON-022, AMB-213: no proceeding is left open (a committee proceeding closes with its proceeding).
    case when exists (select 1 from case_mgmt.proceeding p
                      where p.case_id = p_case_id and p.status not in ('CONCLUDED', 'CANCELLED'))
           or exists (select 1 from committee.committee_proceeding cp where cp.case_id = p_case_id and cp.status = 'OPEN')
         then 'OPEN_PROCEEDINGS' end,
    -- AMB-213: a decision notice's grievance window, not yet started or not yet ended, keeps the case open.
    case when exists (select 1 from grievance.defence_notice n
                      where n.case_id = p_case_id and n.kind = 'DECISION' and n.status <> 'WITHDRAWN'
                        and (n.grievance_window_ends_at is null or n.grievance_window_ends_at > now()))
         then 'GRIEVANCE_WINDOW_OPEN' end,
    -- AMB-146: nor a decision that is not final: a grievance or reconsideration still open, a package between the
    -- committee's vote and the authority's decision, or a preliminary proposal waiting for its authority (2070).
    case when exists (select 1 from grievance.grievance g
                      where g.case_id = p_case_id and g.status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED'))
           or exists (select 1 from decision.recommendation_package k
                      where k.case_id = p_case_id and k.status in ('VOTING', 'ADOPTED', 'IN_LEGAL_REVIEW', 'AWAITING_AUTHORITY'))
           or exists (select 1 from case_mgmt.preliminary_corrective_proposal x
                      where x.case_id = p_case_id and decision.preliminary_proposal_state(x.id) = 'AWAITING_AUTHORITY')
         then 'DECISION_NOT_FINAL' end
  ], null);
$$;

-- 2.12 The corrective action view (2040): its origin, for the case team only, also says where the action comes from
-- and names the proposal. Otherwise 2040's function unchanged; for an action from a proposal, the item, decision,
-- governing decision and block are null and it has no dispositions (no decision of it can be superseded).
create or replace function api.corrective_action_view(p_action_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_me uuid := authz.current_user_id();
  v decision.corrective_action;
  v_case case_mgmt.case_record;
  v_policy decision.corrective_action_policy;
  v_team boolean;
  v_manager boolean;
  v_acts boolean;
  v_naming boolean;
  v_open boolean;
  v_metadata boolean;
  v_block text;
  v_moves boolean;
  v_waivable boolean;
  v_frozen boolean;
  v_replacement uuid;
  v_approved boolean;
begin
  if p_action_id is null or not authz.can_view_corrective_action(p_action_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v from decision.corrective_action a where a.id = p_action_id;
  select * into v_case from case_mgmt.case_record c where c.id = v.case_id;
  v_policy := decision.current_corrective_policy(v.action_type);
  v_team := authz.can_view_case(v.case_id);
  -- decision.require_manager: CORRECTIVE_ACTION_MANAGE and the case itself.
  v_manager := authz.has_permission('CORRECTIVE_ACTION_MANAGE') and v_team;
  -- decision.require_owner (2040): whoever acts for the action (decision.acts_for_action, R2 included), with
  -- CORRECTIVE_ACTION_OWN and their own case gate.
  v_acts := coalesce(decision.acts_for_action(v, v_me), false) and authz.has_permission('CORRECTIVE_ACTION_OWN')
            and authz.user_case_gate(v_me, v.case_id);
  -- decision.require_owner_naming: an active case and, on a restricted one, its owner as its authority.
  v_naming := v_case.records_state = 'ACTIVE'
              and (not v_case.is_restricted
                   or (v_case.owner_id = v_me and authz.is_restricted_case_authority(v_me, v_case.classification)));
  v_open := v.status in ('OPEN', 'IN_PROGRESS');
  v_metadata := authz.can_view_case_metadata(v.case_id);
  -- decision.freeze_blocked_action (2030, DEC-AMB-003, DEC-AMB-013, DEC-AMB-014): no progress while the action may not
  -- move; only an open action whose decision is tainted or under remediation may still be waived.
  v_block := decision.action_block(v.id);
  v_moves := v_block is null;
  v_waivable := v_block is null or v_block in ('TAINTED_BY_CONFLICT', 'CONFLICT_REMEDIATION_OPEN');
  -- api.dispose_superseded_corrective_action: a manager, on an ACTIVE case, while the action is frozen.
  v_frozen := v_block = 'FROZEN_BY_SUPERSEDED_DECISION';
  if v_frozen then
    v_replacement := decision.superseding_decision(decision.action_governing_decision(v.id));
    v_approved := decision.approving_decision(v.recommendation_item_id) is not distinct from v_replacement;
  end if;
  return jsonb_build_object(
    'action_id', v.id, 'action_type', v.action_type, 'sequence_no', v.sequence_no, 'title', v.title,
    'description', v.description, 'status', v.status, 'due_date', v.due_date, 'percent_complete', v.percent_complete,
    'created_by', v.created_by, 'created_at', v.created_at, 'completion_submitted_at', v.completion_submitted_at,
    'completed_at', v.completed_at, 'verified_by', v.verified_by, 'waived_at', v.waived_at,
    'updated_at', v.updated_at, 'row_version', v.row_version,
    -- DEC-AMB-014: the wording it carries and every earlier one (corrective_action_version_read: as the action).
    'version_no', v.version_no,
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object('version_no', x.version_no, 'title', x.title, 'description', x.description,
                                          'recorded_by', x.recorded_by, 'recorded_at', x.recorded_at)
             order by x.version_no)
      from decision.corrective_action_version x where x.action_id = v.id), '[]'::jsonb),
    'owner', jsonb_build_object(
      'kind', v.owner_kind, 'accountable_user_id', v.owner_id,
      'sector', (select jsonb_build_object('sector_id', s.id, 'code', s.code, 'name_en', s.name_en, 'name_ar', s.name_ar)
                 from iam.sector s where s.id = v.owner_sector_id),
      -- R3: a pool by code and name only, under the action's own visibility.
      'pool', (select jsonb_build_object('code', p.code, 'name', p.name)
               from decision.corrective_action_pool p where p.id = v.owner_pool_id),
      'external_party_label', v.external_party_label),
    -- The decision the action executes, to whoever sees the case only: an owner sees the card, never the case.
    -- Why it cannot progress (DEC-AMB-013, DEC-AMB-014): to the case team only, with the origin. The decision it
    -- executes now (governing: the replacement once re-adopted or modified) and the replacement decision's
    -- dispositions of it (corrective_action_disposition_read: the case team), without their reasons (the card carries
    -- no reason, R3).
    'origin', case when v_team then jsonb_build_object(
      'recommendation_item_id', v.recommendation_item_id, 'authority_decision_id', v.authority_decision_id,
      -- DEC-F41 (2070): where it comes from, a package item and its decision or a preliminary proposal.
      'source', case when v.preliminary_proposal_id is null then 'AUTHORITY_DECISION' else 'PRELIMINARY_REVIEW' end,
      'preliminary_proposal_id', v.preliminary_proposal_id,
      'governing_decision_id', decision.action_governing_decision(v.id), 'decision_block', v_block,
      'dispositions', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'disposition_id', x.id, 'disposition', x.disposition, 'superseded_decision_id', x.superseded_decision_id,
                 'replacement_decision_id', x.replacement_decision_id, 'prior_status', x.prior_status,
                 'source_document_reference', x.source_document_reference,
                 'revised_version_no', x.revised_version_no, 'replacement_action_id', x.replacement_action_id,
                 'recorded_by', x.recorded_by, 'recorded_at', x.recorded_at)
               order by x.recorded_at, x.id)
        from decision.corrective_action_disposition x where x.action_id = v.id), '[]'::jsonb),
      -- What a disposition may be now, as api.dispose_superseded_corrective_action checks it.
      'disposition_options', case when v_frozen then to_jsonb(array_remove(array[
        case when v_approved and v.status <> 'WAIVED' then 'RE_ADOPT' end,
        case when v_approved and v.status not in ('COMPLETED', 'WAIVED') then 'MODIFY' end,
        'WAIVE',
        case when v_approved then 'REPLACE_WITH_NEW_ACTION' end], null)) else '[]'::jsonb end) end,
    -- corrective_action_policy_read: the evidence the policy in force asks for.
    'policy', jsonb_build_object('completion_evidence', v_policy.completion_evidence,
                                 'allowed_evidence_types', to_jsonb(v_policy.allowed_evidence_types)),
    -- corrective_action_event_read: the action's history, as the action.
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id', e.id, 'event_type', e.event_type, 'actor_id', e.actor_id, 'note', e.note,
               'evidence_reference', e.evidence_reference, 'evidence_type', e.evidence_type,
               'percent_complete', e.percent_complete, 'owner_id', e.owner_id, 'due_date', e.due_date,
               'source_document_reference', e.source_document_reference, 'created_at', e.created_at)
             order by e.created_at, e.id)
      from decision.corrective_action_event e where e.action_id = v.id), '[]'::jsonb),
    'case', jsonb_build_object(
      'case_id', case when v_metadata then v.case_id end,
      'case_number', case when v_metadata then v_case.case_number end),
    'capabilities', jsonb_build_object(
      -- api.record_corrective_action_progress and api.submit_corrective_action_completion.
      'may_record_progress', coalesce(v_acts and v_open and v_moves, false),
      'may_submit_completion', coalesce(v_acts and v_open and v_moves, false),
      -- api.verify_corrective_action: never its owner or whoever submitted the completion.
      'may_verify', coalesce(v_manager and v.status = 'PENDING_VERIFICATION' and v.owner_id is distinct from v_me
                             and v_moves
                             and not exists (select 1 from decision.corrective_action_event e
                                             where e.action_id = v.id and e.event_type = 'COMPLETION_SUBMITTED'
                                               and e.actor_id = v_me), false),
      -- api.reopen_corrective_action.
      'may_reopen', coalesce(v_manager and v.status = 'COMPLETED' and v_case.records_state = 'ACTIVE' and v_moves,
                             false),
      -- api.waive_corrective_action.
      'may_waive', coalesce(authz.has_permission('CORRECTIVE_ACTION_WAIVE') and v_team
                            and v.status not in ('COMPLETED', 'WAIVED') and v_case.records_state = 'ACTIVE'
                            and v_waivable, false),
      -- api.dispose_superseded_corrective_action (DEC-AMB-014).
      'may_dispose', coalesce(v_manager and v_case.records_state = 'ACTIVE' and v_frozen, false),
      -- api.change_corrective_action_due_date.
      'may_change_due_date', coalesce(v_manager and v.status in ('OPEN', 'IN_PROGRESS', 'PENDING_VERIFICATION'), false),
      -- api.assign_corrective_action_owner.
      'may_assign_owner', coalesce(v_manager and v_open and v_naming, false),
      -- api.set_corrective_action_owner_kind: USER or EXTERNAL_PARTY ...
      'may_set_owner_kind', coalesce(v_manager and v_open and v_naming, false),
      -- ... and ORG_UNIT or SHARED_POOL, never on a restricted case (R2: RESTRICTED_CASE_OWNER_KIND).
      'may_set_shared_owner_kind', coalesce(v_manager and v_open and v_naming and not v_case.is_restricted, false)));
end;
$$;
comment on function api.corrective_action_view(uuid) is
  'Purpose read model of one corrective action (migration 2040 item 13; its source, a package item or a preliminary '
  'proposal, since 2070): NOT_FOUND unless authz.can_view_corrective_action; the card and its history, its origin '
  'only to the case team; a pool by code and name (R3); capabilities from the commands (R2 included).';

-- =============================================================================
-- 3. Grants and the catalogue
-- =============================================================================
revoke all on function
  case_mgmt.closure_rule_configured(), case_mgmt.preliminary_corrective_types(),
  case_mgmt.preliminary_corrective_outcome(text), case_mgmt.guard_preliminary_corrective_proposal(),
  case_mgmt.require_preliminary_corrective_authority(), decision.guard_preliminary_requirement(),
  decision.guard_preliminary_authority_decision(), decision.preliminary_proposal_state(uuid),
  decision.guard_preliminary_action()
from public, anon, authenticated;

revoke all on function
  api.propose_preliminary_corrective_action(uuid, text, text),
  api.record_preliminary_authority_decision(uuid, text, text, timestamptz, text, text, text),
  api.open_preliminary_corrective_action(uuid, text, text, uuid, date),
  api.preliminary_corrective_view(uuid)
from public;
grant execute on function
  api.propose_preliminary_corrective_action(uuid, text, text),
  api.record_preliminary_authority_decision(uuid, text, text, timestamptz, text, text, text),
  api.open_preliminary_corrective_action(uuid, text, text, uuid, date),
  api.preliminary_corrective_view(uuid)
to authenticated;

-- The form and status catalogue (migration 1970) follows the schema: P11-G3 closes. A no-escalation decision may carry
-- corrective proposals; the authority approves a simple corrective action without a committee package; a settlement
-- after no escalation executes as a corrective action from the proposal.
update config.legacy_form_map
   set merge_target = case legacy_id
         when 'T4-B1.2-011' then merge_target || '; proposals: api.propose_preliminary_corrective_action'
         when 'T9-B3.1-141' then merge_target || '; after no escalation, api.open_preliminary_corrective_action (DEC-F41)'
         when 'T9-B2.2-176' then merge_target || '; without a package, api.record_preliminary_authority_decision'
       end,
       gap_ref = null
 where gap_ref = 'P11-G3';
update config.target_module
   set commands = commands || array['api.propose_preliminary_corrective_action', 'api.preliminary_corrective_view'],
       delivered_in = delivered_in || '2070'::text,
       notes = notes || ' Since 2070: the preparer may propose corrective actions on a NO_ACTION, NOT_SERIOUS or '
                        'NOT_SUBSTANTIATED recommendation, for the types PRELIMINARY_CORRECTIVE_ACTION_TYPES permits '
                        '(SOURCE_REQUIRED: none until configured; DEC-F41).'
 where code = 'PRELIM_RECOMMENDATION';
update config.target_module
   set commands = commands || array['api.record_preliminary_authority_decision'],
       delivered_in = delivered_in || '2070'::text,
       notes = notes || ' Since 2070: a preliminary corrective proposal needs the authority its type''s rule names, '
                        'recorded from its source document (DEC-F41).'
 where code = 'AUTHORITY_DECISION';
update config.target_module
   set commands = commands || array['api.open_preliminary_corrective_action'],
       delivered_in = delivered_in || '2070'::text,
       notes = notes || ' Since 2070: an action may also execute an approved preliminary proposal (DEC-F41).'
 where code = 'CORRECTIVE_ACTION';
