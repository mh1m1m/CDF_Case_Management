-- =============================================================================
-- 2060 Case closure, case outcome and reopening (P11-G2), the package-building read model, and five follow-ups
-- (Rebase PR-B; CDF-196, CDF-213, CDF-214, CDF-217(1), CDF-218(1))
-- Requirements: §18–§22, §29, §40, §68, §82, §83, §87; owner decisions DEC-F39 and DEC-F40 (2026-10-13), DEC-AMB-002
-- option B and DEC-AMB-015 option A (owner, 2026-10-13), DEC-02 (UX register); ambiguity rows AMB-146, AMB-212 to
-- AMB-218, AMB-220; contradiction CON-022; gap P11-G2; coordinator rulings of 2026-10-14 (12:08, 12:12, 12:44, 21:42,
-- 22:19); ADR-042
--
-- DEC-F39 (owner, 2026-10-13): "The case carries a structured final outcome, separate from lifecycle status, drawn from
-- configuration or reference data rather than free text only. It coexists with subject-level outcomes, allegation-level
-- findings, sanctions, corrective actions and grievances."
-- DEC-F40 (owner, 2026-10-13): "No single named closer. The operational case owner or an authorized role initiates
-- closure; where the configured Delegation of Authority requires it, closure is routed for approval. Until the CDF DoA
-- mapping is confirmed, CASE_CLOSURE_APPROVAL_RULE = SOURCE_REQUIRED. Supported paths: direct authorized closure,
-- maker/approver closure, returned closure request. Closure never proceeds while mandatory actions remain open, unless
-- through an explicitly authorized conditional or staged closure path."
-- DEC-AMB-002 (owner, 2026-10-13), option B: "A closed case may be reopened by the applicable closure authority based
-- on new evidence, with documented reason, approval, full audit trail, and retention recalculation."
-- DEC-AMB-015 (owner, 2026-10-13), option A: "Use the controlled reopening machinery of DEC-AMB-002, but treat the
-- validated post-decision conflict event as an authorized reopening trigger alongside new evidence. ... the reopening
-- reason type is: DECISIVE_POST_DECISION_CONFLICT. ... The closure authority must not re-decide the conflict merits; it
-- authorizes reopening once the conflict event has already been validated through the applicable conflict process.
-- Fail closed if the required closure authority is not configured."
--
-- This migration adds:
--   1. The case outcome and closure (DEC-F39, DEC-F40; AMB-212 to AMB-217; CON-022). A case outcome catalogue drawn
--      from the CRM closure statuses; api.close_case(outcome_code) records each closure's outcome
--      (case_mgmt.case_closure). Closure readiness guards every path into CLOSURE: besides the existing guards, no
--      proceeding open, no decision notice's grievance window open, no decision that is not final (an open grievance
--      or reconsideration, a package between the vote and the authority's decision). A legal hold never blocks
--      closure. CASE_CLOSURE_APPROVAL_RULE stays SOURCE_REQUIRED: until it is configured, closure is today's direct
--      CDF_CASE_V1 closure (now with an outcome and the new guards) and nothing is routed or reopened. Once it names
--      the closure authority, the authority closes directly, anyone else's closure is a request the authority approves
--      or returns (never its maker), and no other path closes the case.
--   2. Reopening (DEC-AMB-002 option B, DEC-AMB-015 option A; AMB-218, AMB-220). A request on new evidence, or for a
--      decisive conflict found after the decision (DECISIVE_POST_DECISION_CONFLICT, distinct from new evidence), approved
--      or rejected by the closure authority, never its maker. It fails closed while CASE_CLOSURE_APPROVAL_RULE is
--      SOURCE_REQUIRED (no new setting). Approval runs REOPEN_CASE, now a system step: the case is ACTIVE again, its
--      retention schedule is superseded and recalculated at the next closure (ADR-013 D3). Nothing edits an authority
--      decision; a closed case still never enters the conflict remediation directly (2030).
--   3. The package-building read model (DEC-02; coordinator 12:08): what the committee's secretary may choose from, and
--      what the items in front of the committee are about. Labels by position and category (ORDINAL) unless the
--      owner's recorded decision on the DEC-02 label card sets DISPLAY_NAME (decision.committee_label_policy).
--   4. CDF-213 and CDF-214 (AGENT-09, LOW; coordinator 12:12): an item never names a withdrawn allegation; a FINDING
--      vote is on the current version of a finding in the committee's scope.
--   5. The Defence Packet (AGENT-09, LOW; coordinator 12:44): CDF-217(1), whoever made a redacted rendition never
--      clears it; CDF-218(1), the Restricted Case Authority reads what it approves (api.defence_packet_approval_view,
--      bound to the approval request, never evidence); the 2050 comment on api.defence_packet_view corrected.
--   6. Grants and the catalogue: P11-G2 closes.
--
-- Configuration (config.setting and decision.committee_label_policy; migration-managed, narrow defaults):
--   * CASE_CLOSURE_APPROVAL_RULE = SOURCE_REQUIRED (AMB-212). A configured value is a role code; an unknown, technical
--     or inactive role, PLATFORM_ADMIN and DB_ADMIN read as unset (fail closed; AGENT-09 R3).
--   * CONDITIONAL_CLOSURE_AUTHORITY = SOURCE_REQUIRED (AMB-214): no conditional or staged closure path exists.
--   * CASE_OUTCOME_CATALOGUE = SOURCE_REQUIRED (AMB-216): CDF confirmation of the outcome values.
--   * committee label mode ORDINAL (DEC-02 label card open; DISPLAY_NAME needs the owner's recorded decision).
--
-- Replaced functions (create or replace: same signature, owner and grants; no check weakened), and why:
--   * api.available_transitions: steps into CLOSURE carry the readiness blockers, for callers who may take the step
--     (AGENT-09 R2).
--   * api.add_recommendation_item: CDF-213 (CONFLICT:ALLEGATION_WITHDRAWN).
--   * api.open_vote_item: CDF-214 (INVALID:finding_id outside the committee's scope).
--   * api.review_defence_packet_item, grievance.guard_packet_review: CDF-217(1) (CONFLICT:REVIEWER_IS_REDACTOR).
-- Workflow: REOPEN_CASE becomes a system step (is_system, enabled); api.transition_case refuses it.
--
-- Not in this migration (ADR-042 "Not built here"): the phase 9/10 steps into CLOSURE (a case past JURISDICTION,
-- including a reopened case, has no step into CLOSURE yet: CLOSURE_STEP_NOT_AVAILABLE), reconvening a concluded
-- committee proceeding after a conflict reopening, notifications and My Work kinds for closure and reopening approvals,
-- post-closure monitoring tasks (AMB-219), emergency closure (S059) and EXTERNAL_ORDER reopening. All wait for
-- CASE_CLOSURE_APPROVAL_RULE or later work; none is reachable while it is SOURCE_REQUIRED.
--
-- Controls:
--   * Additive: nothing is dropped, renamed or deleted; no catalogue code, status or option code changes (DEC-35 open).
--     Every new table has RLS, SELECT policies only where a reader exists, and no write grants. Records are
--     append-only; requests change only along their guarded transitions.
--   * Writes go through api.* SECURITY DEFINER commands (search_path '', schema-qualified) that audit in the same
--     transaction with ids, codes and counts only; rationales, justifications and reasons stay in their rows. Table
--     triggers back every rule whatever the path. No permission or role grant changes: closure keeps WORKFLOW_ADVANCE,
--     reopening keeps INVESTIGATION_APPROVE (with CONFLICT_MANAGE for the conflict reason), and the approver is the
--     configured closure authority. PLATFORM_ADMIN and DB_ADMIN gain nothing.
--   * Protected identity is untouched.
-- =============================================================================

-- =============================================================================
-- 1. Case outcome and closure (DEC-F39, DEC-F40; AMB-146, AMB-212 to AMB-217; CON-022)
-- =============================================================================
-- 1.1 Settings. Migration-managed (config.setting has no write grant); none is invented. CASE_CLOSURE_APPROVAL_RULE,
-- once CONFIGURED, holds the role code of the closure authority: it approves routed closures and every reopening
-- (DEC-AMB-002 names "the applicable closure authority").
insert into config.setting (key, value, status, source_reference, description) values
  ('CASE_CLOSURE_APPROVAL_RULE', null, 'SOURCE_REQUIRED', null,
   'DEC-F40 / AMB-212: the closure authority under the CDF Delegation of Authority, as a role code. Until it is '
   'configured, closure is the CDF_CASE_V1 direct closure only and nothing is routed for approval or reopened.'),
  ('CONDITIONAL_CLOSURE_AUTHORITY', null, 'SOURCE_REQUIRED', null,
   'DEC-F40 / AMB-214: who may authorise a conditional or staged closure. Until it is configured no such path '
   'exists: every closure checks every blocker.'),
  ('CASE_OUTCOME_CATALOGUE', null, 'SOURCE_REQUIRED', null,
   'DEC-F39 / AMB-216: CDF confirmation of the case outcome values. Until then case_mgmt.case_outcome_code holds the '
   'outcomes of the CRM closure statuses (config.legacy_status_map), CDF''s own catalogue.');

-- The closure authority in force: a configured role that exists, is not technical, is never PLATFORM_ADMIN or DB_ADMIN
-- (§21) and is held by at least one active user today. Anything else (an unknown, technical or inactive role) reads
-- as not configured: fail closed (AGENT-09 R3, coordinator 2026-10-14 22:19).
create function case_mgmt.closure_authority_role()
returns text
language sql stable
set search_path = ''
as $$
  select r.code from config.setting s
  join iam.role r on r.code = s.value
  where s.key = 'CASE_CLOSURE_APPROVAL_RULE' and s.status = 'CONFIGURED'
    and not r.is_technical and r.code not in ('PLATFORM_ADMIN', 'DB_ADMIN')
    and exists (select 1 from iam.user_role_assignment a
                join iam.user_profile u on u.id = a.user_id and u.status = 'ACTIVE'
                where a.role_code = r.code and a.status = 'ACTIVE' and a.effective_from <= current_date
                  and (a.effective_to is null or a.effective_to >= current_date));
$$;

-- 1.2 The case outcome catalogue (DEC-F39): reference data, separate from lifecycle status. One row per OUTCOME_CODE
-- value that closes a case in the CRM status catalogue (modules CASE_CLOSE, PRELIM_CLOSE_OUTCOME, CASE_TRANSFER), with
-- the legacy statuses it comes from. EMERGENCY_CLOSURE is inactive: who may order one is SOURCE_REQUIRED (S059).
create table case_mgmt.case_outcome_code (
  code         text primary key,
  dimension    text not null default 'OUTCOME_CODE' check (dimension = 'OUTCOME_CODE'),
  legacy_codes text[] not null check (cardinality(legacy_codes) >= 1),
  is_active    boolean not null,
  note         text,
  foreign key (dimension, code) references config.status_code (dimension, code)
);
comment on table case_mgmt.case_outcome_code is
  'The outcomes a case may close with (DEC-F39, migration 2060): OUTCOME_CODE values of the CRM closure statuses. '
  'CDF confirmation is SOURCE_REQUIRED (CASE_OUTCOME_CATALOGUE). Migration-managed reference data.';
insert into case_mgmt.case_outcome_code (code, legacy_codes, is_active, note) values
  ('REGULATORY_ACTION', array['S038'], true, null),
  ('CORRECTIVE_ACTION', array['S061'], true, null),
  ('INCIDENT_LOGGED', array['S137'], true, null),
  ('NOT_FEASIBLE', array['S045', 'S134'], true, null),
  ('NO_PERSONAL_JURISDICTION', array['S114'], true, null),
  ('NO_ACTION', array['S053'], true, null),
  ('OUT_OF_SCOPE', array['S008', 'S042', 'S056', 'S133'], true, null),
  ('NON_PROCESSABLE', array['S041', 'S132'], true, null),
  ('DUPLICATE', array['S052'], true, null),
  ('NOT_SERIOUS', array['S055'], true, null),
  ('NOT_SUBSTANTIATED', array['S007'], true, null),
  ('CHANNEL_ABUSE', array['S103'], true, null),
  ('TRANSFERRED', array['S009', 'S043', 'S057', 'S065', 'S108'], true, null),
  ('ADMINISTRATIVE_TRACK', array['S091'], true, null),
  ('EMERGENCY_CLOSURE', array['S059'], false, 'SOURCE_REQUIRED: who may order an emergency closure (S059).');
create trigger no_update before update on case_mgmt.case_outcome_code
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on case_mgmt.case_outcome_code
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on case_mgmt.case_outcome_code
  for each statement execute function committee.reject_mutation();
alter table case_mgmt.case_outcome_code enable row level security;
create policy case_outcome_code_read on case_mgmt.case_outcome_code for select to authenticated
  using (authz.current_user_id() is not null);
grant select on case_mgmt.case_outcome_code to authenticated;

-- 1.3 Closure requests (DEC-F40 maker/approver and returned closure) and closures.
create table case_mgmt.case_closure_request (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references case_mgmt.case_record (id),
  outcome_code    text not null references case_mgmt.case_outcome_code (code),
  rationale       text not null check (length(rationale) between 10 and 2000),
  status          text not null default 'AWAITING_APPROVAL' check (status in ('AWAITING_APPROVAL', 'APPROVED', 'RETURNED')),
  requested_by    uuid not null references iam.user_profile (id),
  requested_at    timestamptz not null default now(),
  decided_by      uuid references iam.user_profile (id),
  decided_at      timestamptz,
  decision_reason text check (length(decision_reason) between 10 and 2000),
  check ((status = 'AWAITING_APPROVAL') = (decided_by is null)),
  check ((decided_by is null) = (decided_at is null) and (decided_by is null) = (decision_reason is null)),
  check (decided_by is distinct from requested_by)
);
create unique index case_closure_request_pending on case_mgmt.case_closure_request (case_id)
  where status = 'AWAITING_APPROVAL';
create index case_closure_request_requested_by on case_mgmt.case_closure_request (requested_by);
create index case_closure_request_decided_by on case_mgmt.case_closure_request (decided_by);
create index case_closure_request_outcome on case_mgmt.case_closure_request (outcome_code);
comment on table case_mgmt.case_closure_request is
  'A closure routed to the closure authority (DEC-F40, migration 2060): approved (the case closes) or returned with a '
  'reason. Never decided by its maker.';

create table case_mgmt.case_closure (
  id             uuid primary key default gen_random_uuid(),
  case_id        uuid not null references case_mgmt.case_record (id),
  closure_no     int not null check (closure_no >= 1),
  outcome_code   text not null references case_mgmt.case_outcome_code (code),
  rationale      text not null check (length(rationale) between 10 and 2000),
  path           text not null check (path in ('DIRECT', 'APPROVED')),
  transition_code text not null,
  closed_by      uuid not null references iam.user_profile (id),
  closed_at      timestamptz not null default now(),
  request_id     uuid unique references case_mgmt.case_closure_request (id),
  -- The transaction that recorded it: the readiness guard accepts a closure only from the closure commands of the
  -- current transaction (AGENT-09 R1); an earlier closure's row survives a reopening and never counts again.
  transaction_id xid8 not null default pg_current_xact_id(),
  check ((path = 'APPROVED') = (request_id is not null)),
  unique (case_id, closure_no)
);
create index case_closure_closed_by on case_mgmt.case_closure (closed_by);
create index case_closure_outcome on case_mgmt.case_closure (outcome_code);
comment on table case_mgmt.case_closure is
  'The structured final outcome of each closure made through api.close_case or api.decide_case_closure (DEC-F39, '
  'migration 2060), separate from lifecycle status and beside proceeding outcomes, findings, sanctions, corrective '
  'actions and grievances. Append-only. A case''s outcome is its latest closure while it is closed.';
create trigger no_update before update on case_mgmt.case_closure
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on case_mgmt.case_closure
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on case_mgmt.case_closure
  for each statement execute function committee.reject_mutation();

-- A request moves once, from AWAITING_APPROVAL; nothing else in it changes.
create function case_mgmt.protect_closure_request()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'AWAITING_APPROVAL'
     or (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'decision_reason'])
        <> (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'decision_reason']) then
    raise exception 'case closure request % is decided once', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger case_closure_request_protect before update on case_mgmt.case_closure_request
  for each row execute function case_mgmt.protect_closure_request();
create trigger no_delete before delete on case_mgmt.case_closure_request
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on case_mgmt.case_closure_request
  for each statement execute function committee.reject_mutation();
alter table case_mgmt.case_closure_request enable row level security;
alter table case_mgmt.case_closure enable row level security;
create policy case_closure_request_read on case_mgmt.case_closure_request for select to authenticated
  using (authz.can_view_case(case_id));
create policy case_closure_read on case_mgmt.case_closure for select to authenticated
  using (authz.can_view_case(case_id));
grant select on case_mgmt.case_closure_request, case_mgmt.case_closure to authenticated;

-- 1.4 Closure readiness: what keeps a case from closing, in the order the guards raise it. The first four codes are
-- the 2030 and 1940 guards' own conditions through the same helpers (those guards stay as they are); the last three
-- are new (CON-022: every path into CLOSURE). A legal hold never blocks closure (AMB-215).
create function case_mgmt.closure_blocks(p_case_id uuid)
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
    -- AMB-146: nor a decision that is not final: a grievance or reconsideration still open, or a package between the
    -- committee's vote and the authority's decision.
    case when exists (select 1 from grievance.grievance g
                      where g.case_id = p_case_id and g.status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED'))
           or exists (select 1 from decision.recommendation_package k
                      where k.case_id = p_case_id and k.status in ('VOTING', 'ADOPTED', 'IN_LEGAL_REVIEW', 'AWAITING_AUTHORITY'))
         then 'DECISION_NOT_FINAL' end
  ], null);
$$;

-- The enabled step that takes the case from its current state into a closed state, if there is one. Only SCREEN_OUT
-- and OUT_OF_JURISDICTION today; the phase 9/10 steps stay disabled.
create function case_mgmt.closure_step(p_case_id uuid)
returns text
language sql stable
set search_path = ''
as $$
  select d.code from workflow.workflow_instance i
  join workflow.workflow_transition_definition d on d.workflow_code = i.workflow_code and d.from_state = i.current_state
  join workflow.workflow_state s on s.workflow_code = d.workflow_code and s.code = d.to_state
  where i.case_id = p_case_id and s.records_state = 'CLOSED' and d.is_enabled and not d.is_system
  order by d.code
  limit 1;
$$;

-- Every path from ACTIVE to CLOSED: the new blockers, and, once the closure authority is configured, only a closure
-- recorded by the closure commands in this transaction (they write the case_closure row first; no session flag). While it is
-- SOURCE_REQUIRED, the CDF_CASE_V1 steps keep closing directly, as before 2060.
create function case_mgmt.guard_case_readiness()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_blocks text[] := case_mgmt.closure_blocks(new.id);
begin
  if cardinality(v_blocks) > 0 then perform api._fail('CONFLICT', v_blocks[1]); end if;
  if case_mgmt.closure_authority_role() is not null
     and not exists (select 1 from case_mgmt.case_closure c
                     where c.case_id = new.id and c.transaction_id = pg_current_xact_id()) then
    perform api._fail('CONFLICT', 'CLOSURE_APPROVAL_REQUIRED');
  end if;
  return new;
end;
$$;
create trigger case_record_readiness before update of records_state on case_mgmt.case_record
  for each row when (old.records_state = 'ACTIVE' and new.records_state = 'CLOSED')
  execute function case_mgmt.guard_case_readiness();

-- 1.5 Recording a closure (shared by both commands).
create function case_mgmt.record_closure(p_case_id uuid, p_outcome_code text, p_rationale text, p_step text,
                                         p_actor uuid, p_request_id uuid)
returns case_mgmt.case_closure
language plpgsql
set search_path = ''
as $$
declare
  v case_mgmt.case_closure;
begin
  insert into case_mgmt.case_closure (case_id, closure_no, outcome_code, rationale, path, transition_code, closed_by,
                                      request_id)
  values (p_case_id,
          coalesce((select max(c.closure_no) from case_mgmt.case_closure c where c.case_id = p_case_id), 0) + 1,
          p_outcome_code, p_rationale, case when p_request_id is null then 'DIRECT' else 'APPROVED' end, p_step,
          p_actor, p_request_id)
  returning * into v;
  perform audit.record_event('CASE_CLOSURE_RECORDED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_closure', v.id::text, null,
    jsonb_build_object('closure_no', v.closure_no, 'outcome_code', v.outcome_code, 'path', v.path,
                       'transition', p_step, 'request_id', p_request_id));
  return v;
end;
$$;

-- 1.6 Closing (DEC-F40). The initiator holds today's closure entitlement (WORKFLOW_ADVANCE, within their clearance and
-- without a case conflict). With the closure authority SOURCE_REQUIRED: the direct closure CDF_CASE_V1 already allows,
-- now with an outcome and every blocker checked, and nothing else (fail closed). With it configured: the authority
-- closes directly; anyone else files a closure request for the authority.
create function api.close_case(p_case_id uuid, p_outcome_code text, p_rationale text)
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

-- The closure authority approves (the case closes, every blocker re-checked) or returns the request with a reason.
-- Never its maker.
create function api.decide_case_closure(p_request_id uuid, p_decision text, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r case_mgmt.case_closure_request;
  v_case case_mgmt.case_record;
  v_authority text := case_mgmt.closure_authority_role();
  v_reason text;
  v_blocks text[];
  v_step text;
  v_def workflow.workflow_transition_definition;
  v_block text;
  c text;
begin
  select * into v_r from case_mgmt.case_closure_request r where r.id = p_request_id;
  if v_r.id is null or not authz.can_view_case(v_r.case_id) then perform api._fail('NOT_FOUND'); end if;
  if v_authority is null then perform api._fail('CONFLICT', 'CASE_CLOSURE_APPROVAL_RULE_REQUIRED'); end if;
  if not authz.user_has_role(v_actor, v_authority) or not authz.user_case_gate(v_actor, v_r.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  select * into v_case from case_mgmt.case_record c where c.id = v_r.case_id for update;
  select * into v_r from case_mgmt.case_closure_request r where r.id = p_request_id for update;
  if v_r.requested_by = v_actor then perform api._fail('CONFLICT', 'REQUESTER_CANNOT_APPROVE'); end if;
  if v_r.status <> 'AWAITING_APPROVAL' then perform api._fail('CONFLICT', 'REQUEST_NOT_PENDING'); end if;
  if p_decision is null or p_decision not in ('APPROVE', 'RETURN') then perform api._fail('INVALID', 'decision'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  if p_decision = 'APPROVE' then
    if v_case.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
    v_blocks := case_mgmt.closure_blocks(v_case.id);
    if cardinality(v_blocks) > 0 then perform api._fail('CONFLICT', v_blocks[1]); end if;
    v_step := case_mgmt.closure_step(v_case.id);
    if v_step is null then perform api._fail('CONFLICT', 'CLOSURE_STEP_NOT_AVAILABLE'); end if;
    -- The step's own conditions, for the maker who asked for it (none on SCREEN_OUT or OUT_OF_JURISDICTION today).
    select d.* into v_def from workflow.workflow_instance i
    join workflow.workflow_transition_definition d on d.workflow_code = i.workflow_code and d.code = v_step
                                                  and d.from_state = i.current_state
    where i.case_id = v_case.id;
    foreach c in array v_def.required_conditions loop
      v_block := workflow.evaluate_condition(c, v_case.id, v_r.requested_by);
      if v_block is not null then perform api._fail('CONFLICT', v_block); end if;
    end loop;
  end if;
  update case_mgmt.case_closure_request
     set status = case p_decision when 'APPROVE' then 'APPROVED' else 'RETURNED' end,
         decided_by = v_actor, decided_at = now(), decision_reason = v_reason
   where id = v_r.id;
  perform audit.record_event('CASE_CLOSURE_DECIDED', 'BUSINESS', 'SUCCESS', v_r.case_id, 'case_closure_request',
    v_r.id::text, null, jsonb_build_object('decision', p_decision, 'outcome_code', v_r.outcome_code));
  if p_decision = 'APPROVE' then
    perform case_mgmt.record_closure(v_r.case_id, v_r.outcome_code, v_r.rationale, v_step, v_actor, v_r.id);
    perform workflow.apply_transition(v_r.case_id, v_step, v_actor, v_r.rationale);
    return 'CLOSED';
  end if;
  return 'RETURNED';
end;
$$;

-- 1.7 Steps into CLOSURE carry the readiness blockers (and, once the authority is configured, the need for the closure
-- commands), so the list agrees with what transition_case would do. They are computed only for a caller who holds the
-- step's permission within their clearance and without a case conflict: a pending grievance or an open window is never
-- shown to every viewer (AGENT-09 R2). Otherwise 0600's function unchanged.
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
      if case_mgmt.closure_authority_role() is not null then
        v_reasons := v_reasons || 'CLOSURE_APPROVAL_REQUIRED'::text;
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
-- 2. Reopening a closed case (DEC-AMB-002 option B; DEC-AMB-015 option A; AMB-218, AMB-220)
-- =============================================================================
-- REOPEN_CASE becomes a system step: api.transition_case refuses it; only api.decide_case_reopening runs it, after the
-- closure authority's approval. Its route (CLOSURE to INVESTIGATION) and permission are unchanged.
update workflow.workflow_transition_definition
   set is_system = true, is_enabled = true
 where workflow_code = 'CDF_CASE_V1' and code = 'REOPEN_CASE';

create table case_mgmt.case_reopening_request (
  id                       uuid primary key default gen_random_uuid(),
  case_id                  uuid not null references case_mgmt.case_record (id),
  reason_type              text not null check (reason_type in ('NEW_EVIDENCE', 'DECISIVE_POST_DECISION_CONFLICT')),
  justification            text not null check (length(justification) between 10 and 2000),
  -- NEW_EVIDENCE (DEC-AMB-002): what the evidence is and where it is recorded.
  new_evidence_description text check (length(new_evidence_description) between 10 and 4000),
  new_evidence_reference   text check (length(new_evidence_reference) between 3 and 300),
  -- DECISIVE_POST_DECISION_CONFLICT (DEC-AMB-015): the decided package whose vote a validated conflict could have
  -- changed. The conflict is never recorded as new evidence.
  package_id               uuid references decision.recommendation_package (id),
  status                   text not null default 'AWAITING_APPROVAL' check (status in ('AWAITING_APPROVAL', 'APPROVED', 'REJECTED')),
  requested_by             uuid not null references iam.user_profile (id),
  requested_at             timestamptz not null default now(),
  decided_by               uuid references iam.user_profile (id),
  decided_at               timestamptz,
  decision_reason          text check (length(decision_reason) between 10 and 2000),
  check ((reason_type = 'NEW_EVIDENCE') = (new_evidence_description is not null)
         and (reason_type = 'NEW_EVIDENCE') = (new_evidence_reference is not null)
         and (reason_type = 'DECISIVE_POST_DECISION_CONFLICT') = (package_id is not null)),
  check ((status = 'AWAITING_APPROVAL') = (decided_by is null)),
  check ((decided_by is null) = (decided_at is null) and (decided_by is null) = (decision_reason is null)),
  check (decided_by is distinct from requested_by)
);
create unique index case_reopening_request_pending on case_mgmt.case_reopening_request (case_id)
  where status = 'AWAITING_APPROVAL';
create index case_reopening_request_package on case_mgmt.case_reopening_request (package_id);
create index case_reopening_request_requested_by on case_mgmt.case_reopening_request (requested_by);
create index case_reopening_request_decided_by on case_mgmt.case_reopening_request (decided_by);
comment on table case_mgmt.case_reopening_request is
  'A request to reopen a closed case (DEC-AMB-002 option B, DEC-AMB-015 option A; migration 2060): on new evidence or '
  'for a decisive conflict found after the decision, approved or rejected by the closure authority, never its maker.';

create function case_mgmt.protect_reopening_request()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'AWAITING_APPROVAL'
     or (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'decision_reason'])
        <> (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'decision_reason']) then
    raise exception 'case reopening request % is decided once', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger case_reopening_request_protect before update on case_mgmt.case_reopening_request
  for each row execute function case_mgmt.protect_reopening_request();
create trigger no_delete before delete on case_mgmt.case_reopening_request
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on case_mgmt.case_reopening_request
  for each statement execute function committee.reject_mutation();
-- No reader policy: read through api.case_closure_view, by the reopening's makers and the closure authority only (a
-- request for the conflict reason tells that a recount differs).
alter table case_mgmt.case_reopening_request enable row level security;

-- DEC-AMB-015: the validated decisive conflict. A decided package with an active item whose closed vote counts a
-- validated conflict (decision.vote_item_conflicted: a meeting conflict, an upheld concern, or a declared or confirmed
-- case conflict) and whose recount without those votes differs or cannot be made (decision.recount_without), the 2030
-- rule for "could have changed the result" (ADR-040 §3 item 10). On a closed case the conflict is validated through
-- the case conflict process (api.declare_conflict, api.decide_conflict); the meeting and concern commands need an
-- active case.
create function decision.package_decisive_conflict(p_package_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1
    from decision.recommendation_package k
    join decision.recommendation_item i on i.package_id = k.id and i.status = 'ACTIVE'
    join committee.vote_item vi on vi.id = decision.item_vote_item(i.id)
    cross join lateral (select decision.vote_item_conflicted(vi.id) as users) c
    cross join lateral (select decision.recount_without(vi.id, c.users) as result) r
    where k.id = p_package_id and k.status = 'DECIDED' and cardinality(c.users) > 0
      and (r.result is null or r.result <> vi.result));
$$;

-- Fails closed while the closure authority is SOURCE_REQUIRED, before anything else is looked at. The maker holds the
-- REOPEN_CASE permission (INVESTIGATION_APPROVE) within their clearance and without a case conflict; for the conflict
-- reason also CONFLICT_MANAGE, since the answer tells whether a recount differs.
create function api.request_case_reopening(p_case_id uuid, p_reason_type text, p_justification text,
                                           p_new_evidence_description text, p_new_evidence_reference text,
                                           p_package_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_justification text;
  v_description text;
  v_reference text;
  v_id uuid;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if case_mgmt.closure_authority_role() is null then
    perform api._fail('CONFLICT', 'CASE_CLOSURE_APPROVAL_RULE_REQUIRED');
  end if;
  if not authz.has_permission('INVESTIGATION_APPROVE') or not authz.user_case_gate(v_actor, p_case_id)
     or (p_reason_type = 'DECISIVE_POST_DECISION_CONFLICT' and not authz.has_permission('CONFLICT_MANAGE')) then
    perform api._fail('FORBIDDEN');
  end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  if v_case.records_state <> 'CLOSED'
     or not exists (select 1 from workflow.workflow_instance i where i.case_id = p_case_id and i.current_state = 'CLOSURE') then
    perform api._fail('CONFLICT', 'CASE_NOT_CLOSED');
  end if;
  if p_reason_type is null or p_reason_type not in ('NEW_EVIDENCE', 'DECISIVE_POST_DECISION_CONFLICT') then
    perform api._fail('INVALID', 'reason_type');
  end if;
  v_justification := api._require_text(p_justification, 'justification', 10, 2000);
  if p_reason_type = 'NEW_EVIDENCE' then
    v_description := api._require_text(p_new_evidence_description, 'new_evidence_description', 10, 4000);
    v_reference := api._require_text(p_new_evidence_reference, 'new_evidence_reference', 3, 300);
    if p_package_id is not null then perform api._fail('INVALID', 'package_id'); end if;
  else
    if p_new_evidence_description is not null then perform api._fail('INVALID', 'new_evidence_description'); end if;
    if p_new_evidence_reference is not null then perform api._fail('INVALID', 'new_evidence_reference'); end if;
    if p_package_id is null
       or not exists (select 1 from decision.recommendation_package k where k.id = p_package_id and k.case_id = p_case_id) then
      perform api._fail('INVALID', 'package_id');
    end if;
    if not decision.package_decisive_conflict(p_package_id) then
      perform api._fail('CONFLICT', 'NO_VALIDATED_DECISIVE_CONFLICT');
    end if;
  end if;
  if exists (select 1 from case_mgmt.case_reopening_request r where r.case_id = p_case_id and r.status = 'AWAITING_APPROVAL') then
    perform api._fail('CONFLICT', 'REOPENING_REQUEST_PENDING');
  end if;
  insert into case_mgmt.case_reopening_request (case_id, reason_type, justification, new_evidence_description,
                                                new_evidence_reference, package_id, requested_by)
  values (p_case_id, p_reason_type, v_justification, v_description, v_reference, p_package_id, v_actor)
  returning id into v_id;
  perform audit.record_event('CASE_REOPENING_REQUESTED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_reopening_request',
    v_id::text, null, jsonb_build_object('reason_type', p_reason_type, 'package_id', p_package_id));
  return v_id;
end;
$$;

-- The closure authority approves (REOPEN_CASE runs: the case is ACTIVE again in INVESTIGATION, its retention schedule
-- is superseded as REOPENED and recalculated at the next closure, ADR-013 D3) or rejects, with a reason. It checks the
-- recorded entry, not the conflict's merits; it never edits an authority decision.
create function api.decide_case_reopening(p_request_id uuid, p_decision text, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r case_mgmt.case_reopening_request;
  v_case case_mgmt.case_record;
  v_authority text := case_mgmt.closure_authority_role();
  v_reason text;
begin
  select * into v_r from case_mgmt.case_reopening_request r where r.id = p_request_id;
  if v_r.id is null or not authz.can_view_case(v_r.case_id) then perform api._fail('NOT_FOUND'); end if;
  if v_authority is null then perform api._fail('CONFLICT', 'CASE_CLOSURE_APPROVAL_RULE_REQUIRED'); end if;
  if not authz.user_has_role(v_actor, v_authority) or not authz.user_case_gate(v_actor, v_r.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  select * into v_case from case_mgmt.case_record c where c.id = v_r.case_id for update;
  select * into v_r from case_mgmt.case_reopening_request r where r.id = p_request_id for update;
  if v_r.requested_by = v_actor then perform api._fail('CONFLICT', 'REQUESTER_CANNOT_APPROVE'); end if;
  if v_r.status <> 'AWAITING_APPROVAL' then perform api._fail('CONFLICT', 'REQUEST_NOT_PENDING'); end if;
  if p_decision is null or p_decision not in ('APPROVE', 'REJECT') then perform api._fail('INVALID', 'decision'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  if p_decision = 'APPROVE' then
    if v_case.records_state <> 'CLOSED'
       or not exists (select 1 from workflow.workflow_instance i where i.case_id = v_case.id and i.current_state = 'CLOSURE') then
      perform api._fail('CONFLICT', 'CASE_NOT_CLOSED');
    end if;
    if v_r.reason_type = 'DECISIVE_POST_DECISION_CONFLICT' and not decision.package_decisive_conflict(v_r.package_id) then
      perform api._fail('CONFLICT', 'NO_VALIDATED_DECISIVE_CONFLICT');
    end if;
  end if;
  update case_mgmt.case_reopening_request
     set status = case p_decision when 'APPROVE' then 'APPROVED' else 'REJECTED' end,
         decided_by = v_actor, decided_at = now(), decision_reason = v_reason
   where id = v_r.id;
  perform audit.record_event('CASE_REOPENING_DECIDED', 'BUSINESS', 'SUCCESS', v_r.case_id, 'case_reopening_request',
    v_r.id::text, null, jsonb_build_object('decision', p_decision, 'reason_type', v_r.reason_type,
                                           'package_id', v_r.package_id));
  if p_decision = 'APPROVE' then
    perform workflow.apply_transition(v_r.case_id, 'REOPEN_CASE', v_actor, v_r.justification);
    return 'REOPENED';
  end if;
  return 'REJECTED';
end;
$$;

-- 2.1 What a case viewer reads of closure: the closures with their outcomes, the closure requests and whether the
-- closure authority is configured. What keeps the case from closing now only for a caller who may close it (closure
-- entitlement within their clearance, AGENT-09 R2), else null. The reopening requests only for their makers
-- (INVESTIGATION_APPROVE with CONFLICT_MANAGE) and the closure authority, else null. A read: the commands are the
-- audited events.
create function api.case_closure_view(p_case_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_actor uuid := authz.current_user_id();
  v_authority text := case_mgmt.closure_authority_role();
  v_gate boolean;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  v_gate := authz.user_case_gate(v_actor, p_case_id);
  return jsonb_build_object(
    'case_id', p_case_id,
    'records_state', (select c.records_state from case_mgmt.case_record c where c.id = p_case_id),
    'closure_authority_configured', case_mgmt.closure_authority_role() is not null,
    'closure_blocks', case when v_gate and authz.has_permission('WORKFLOW_ADVANCE')
                           then to_jsonb(case_mgmt.closure_blocks(p_case_id)) end,
    'closures', coalesce((
      select jsonb_agg(jsonb_build_object(
               'closure_id', c.id, 'closure_no', c.closure_no, 'outcome_code', c.outcome_code, 'rationale', c.rationale,
               'path', c.path, 'transition_code', c.transition_code, 'closed_by', c.closed_by, 'closed_at', c.closed_at,
               'request_id', c.request_id) order by c.closure_no)
      from case_mgmt.case_closure c where c.case_id = p_case_id), '[]'::jsonb),
    'closure_requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'request_id', r.id, 'outcome_code', r.outcome_code, 'rationale', r.rationale, 'status', r.status,
               'requested_by', r.requested_by, 'requested_at', r.requested_at, 'decided_by', r.decided_by,
               'decided_at', r.decided_at, 'decision_reason', r.decision_reason) order by r.requested_at, r.id)
      from case_mgmt.case_closure_request r where r.case_id = p_case_id), '[]'::jsonb),
    'reopening_requests', case when v_gate and ((authz.has_permission('INVESTIGATION_APPROVE')
                                                 and authz.has_permission('CONFLICT_MANAGE'))
                                                or (v_authority is not null and authz.user_has_role(v_actor, v_authority)))
                          then coalesce((
      select jsonb_agg(jsonb_build_object(
               'request_id', r.id, 'reason_type', r.reason_type, 'justification', r.justification,
               'new_evidence_description', r.new_evidence_description,
               'new_evidence_reference', r.new_evidence_reference, 'package_id', r.package_id, 'status', r.status,
               'requested_by', r.requested_by, 'requested_at', r.requested_at, 'decided_by', r.decided_by,
               'decided_at', r.decided_at, 'decision_reason', r.decision_reason) order by r.requested_at, r.id)
      from case_mgmt.case_reopening_request r where r.case_id = p_case_id), '[]'::jsonb) end);
end;
$$;

-- =============================================================================
-- 3. The package-building read model (DEC-02; coordinator rulings 2026-10-14 12:08 and 12:12)
-- =============================================================================
-- 3.1 Label mode: effective-dated and migration-managed, like the other reference values. ORDINAL is the default and
-- the narrowing side of DEC-02's text; DISPLAY_NAME needs the owner's recorded decision (the DEC-02 label card, open).
create table decision.committee_label_policy (
  id                       uuid primary key default gen_random_uuid(),
  effective_from           timestamptz not null,
  effective_to             timestamptz,
  label_mode               text not null check (label_mode in ('ORDINAL', 'DISPLAY_NAME')),
  -- The owner's recorded decision that adopts display names (project message id and date). Required for DISPLAY_NAME.
  owner_decision_reference text check (length(owner_decision_reference) between 3 and 300),
  check (label_mode = 'ORDINAL' or owner_decision_reference is not null),
  check (effective_to is null or effective_to > effective_from)
);
comment on table decision.committee_label_policy is
  'How the package-building read models label a subject (migration 2060, ADR-042): ORDINAL (default; position and '
  'category, never a name) or DISPLAY_NAME (only with the owner''s recorded decision on the DEC-02 label card).';
insert into decision.committee_label_policy (effective_from, label_mode, owner_decision_reference)
values ('2026-01-01T00:00:00Z', 'ORDINAL', null);

create function decision.protect_label_policy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.effective_to is not null or (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') then
    raise exception 'committee label policy % can only be given an end, once', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger committee_label_policy_protect before update on decision.committee_label_policy
  for each row execute function decision.protect_label_policy();
create trigger no_delete before delete on decision.committee_label_policy
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on decision.committee_label_policy
  for each statement execute function committee.reject_mutation();
alter table decision.committee_label_policy enable row level security;
create policy committee_label_policy_read on decision.committee_label_policy for select to authenticated
  using (authz.current_user_id() is not null);
grant select on decision.committee_label_policy to authenticated;

-- The mode in force now; none in force reads as ORDINAL.
create function decision.committee_label_mode()
returns text
language sql stable
set search_path = ''
as $$
  select coalesce((select p.label_mode from decision.committee_label_policy p
                   where p.effective_from <= now() and (p.effective_to is null or p.effective_to > now())
                   order by p.effective_from desc limit 1), 'ORDINAL');
$$;

-- 3.2 Scope. A finding a committee proceeding may act on: the current version (the highest version_no of its line) of
-- a finding recorded in the committee proceeding itself or in the proceeding it was referred from. CDF-214 and
-- api.committee_scope_choices use this one rule.
create function decision.finding_in_committee_scope(p_finding_id uuid, p_committee_proceeding_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from case_mgmt.finding f
    join committee.committee_proceeding cp on cp.id = p_committee_proceeding_id and cp.case_id = f.case_id
    join case_mgmt.proceeding p on p.id = cp.proceeding_id
    where f.id = p_finding_id
      and (f.proceeding_id = p.id or f.proceeding_id = p.parent_proceeding_id)
      and not exists (select 1 from case_mgmt.finding g
                      where g.allegation_id = f.allegation_id
                        and g.subject_id is not distinct from f.subject_id
                        and g.proceeding_id = f.proceeding_id
                        and g.version_no > f.version_no));
$$;

-- A subject as the read models show it: its position among the case's subjects (stable: subjects are append-only),
-- its category, and its display name only in DISPLAY_NAME mode and only when p_named.
create function decision.subject_choice(p_subject_id uuid, p_mode text, p_named boolean)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'subject_id', s.id,
    'position', (select count(*) from case_mgmt.case_subject o
                 where o.case_id = s.case_id and (o.added_at, o.id) <= (s.added_at, s.id)),
    'subject_category', s.subject_category,
    'label', case when p_mode = 'DISPLAY_NAME' and p_named then p.display_name end)
  from case_mgmt.case_subject s
  join case_mgmt.person p on p.id = s.person_id
  where s.id = p_subject_id;
$$;

-- 3.3 Read model R1 (spec §5): what the committee's secretary may choose from when building a package, opening a finding vote, asking for
-- legal review or for the prior-sanctions extract. Checks in api.create_recommendation_package's order. Ids, codes,
-- positions and (by decision only) labels; never narrative, references, people ids, the case id or number. Audited.
create function api.committee_scope_choices(p_committee_proceeding_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_cp committee.committee_proceeding;
  v_kind text;
  v_mode text := decision.committee_label_mode();
  v_doc jsonb;
begin
  if p_committee_proceeding_id is null or not authz.can_view_committee_proceeding(p_committee_proceeding_id) then
    perform api._fail('NOT_FOUND');
  end if;
  select * into v_cp from committee.committee_proceeding cp where cp.id = p_committee_proceeding_id;
  if not authz.is_committee_secretary(v_cp.committee_id) or not authz.user_case_gate(v_actor, v_cp.case_id)
     or authz.has_meeting_conflict(v_actor, v_cp.id) then
    perform api._fail('FORBIDDEN');
  end if;
  select c.kind into v_kind from committee.committee c where c.id = v_cp.committee_id;
  if v_kind <> 'INVESTIGATION' then perform api._fail('CONFLICT', 'NOT_AN_INVESTIGATION_COMMITTEE'); end if;
  if v_cp.status <> 'OPEN' then perform api._fail('CONFLICT', 'PROCEEDING_CLOSED'); end if;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_cp.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  v_doc := jsonb_build_object(
    'committee_proceeding_id', v_cp.id,
    'label_mode', v_mode,
    'subjects', coalesce((
      select jsonb_agg(decision.subject_choice(s.id, v_mode, true) order by s.added_at, s.id)
      from case_mgmt.case_subject s where s.case_id = v_cp.case_id), '[]'::jsonb),
    'allegations', coalesce((
      select jsonb_agg(jsonb_build_object('allegation_id', a.id, 'position', a.position, 'category', a.category,
                                          'status', a.status, 'subject_id', a.subject_id) order by a.position)
      from (select a.*, row_number() over (order by a.created_at, a.id) as position
            from case_mgmt.allegation a where a.case_id = v_cp.case_id) a
      where a.status <> 'WITHDRAWN'), '[]'::jsonb),
    'findings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'finding_id', f.id, 'allegation_id', f.allegation_id, 'subject_id', f.subject_id,
               'proceeding_role', case when f.proceeding_id = v_cp.proceeding_id then 'COMMITTEE' else 'REFERRED' end,
               'version_no', f.version_no, 'result', f.result, 'recorded_at', f.recorded_at)
             order by f.recorded_at, f.id)
      from case_mgmt.finding f
      join case_mgmt.allegation a on a.id = f.allegation_id
      where f.case_id = v_cp.case_id and a.status <> 'WITHDRAWN'
        and decision.finding_in_committee_scope(f.id, v_cp.id)), '[]'::jsonb));
  perform audit.record_event('COMMITTEE_SCOPE_VIEWED', 'BUSINESS', 'SUCCESS', v_cp.case_id, 'committee_proceeding',
    v_cp.id::text, null, jsonb_build_object('subjects', jsonb_array_length(v_doc -> 'subjects'),
                                            'allegations', jsonb_array_length(v_doc -> 'allegations'),
                                            'findings', jsonb_array_length(v_doc -> 'findings')));
  return v_doc;
end;
$$;

-- 3.4 Read model R2 (spec §5): what the items in front of the committee are about, for the committee side of the work (proceeding viewers
-- without a meeting conflict, while the proceeding is open) and the case team. Packages with their active items, and
-- the FINDING votes of the proceeding's meetings the caller may deliberate in. A seated member who is not the secretary
-- gets no label on a package still in DRAFT (never put to the committee). Audited.
create function api.committee_items_view(p_committee_proceeding_id uuid)
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
                            where ra.item_id = i.id), '[]'::jsonb))
                        order by i.added_at, i.id)
                 from decision.recommendation_item i
                 where i.package_id = p.id and i.status = 'ACTIVE'), '[]'::jsonb))
             order by p.sequence_no)
      from decision.recommendation_package p
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

-- =============================================================================
-- 4. CDF-213 and CDF-214 (AGENT-09, LOW; coordinator 2026-10-14 12:12): two narrowings of the package and vote commands
-- =============================================================================
-- 4.1 CDF-213: an item never names a withdrawn allegation (CONFLICT:ALLEGATION_WITHDRAWN, as record_finding and
-- link_allegation_subject do since 1870). Otherwise 2030's command unchanged; the 1900 signature still wraps it.
create or replace function api.add_recommendation_item(
  p_package_id uuid, p_item_type text, p_sanction_code text, p_proposed_sanction_text text, p_description text,
  p_subject_ids uuid[], p_allegation_ids uuid[], p_requires_legal_justification boolean, p_depends_on_item_ids uuid[],
  p_exclusivity_group text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_subjects uuid[] := coalesce(p_subject_ids, '{}');
  v_allegations uuid[] := coalesce(p_allegation_ids, '{}');
  v_depends uuid[] := coalesce(p_depends_on_item_ids, '{}');
  v_case_wide boolean;
  v_id uuid;
begin
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status not in ('DRAFT', 'RETURNED_BY_LEGAL', 'RETURNED_BY_AUTHORITY') then
    perform api._fail('CONFLICT', 'PACKAGE_NOT_EDITABLE');
  end if;
  if p_item_type is null or p_item_type not in (
       'FINDING', 'DISCIPLINARY_SANCTION', 'CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION', 'EXTERNAL_REFERRAL',
       'NO_VIOLATION', 'CLOSE_WITHOUT_SANCTION', 'LEGAL_ACTION', 'OTHER') then
    perform api._fail('INVALID', 'item_type');
  end if;
  if p_item_type = 'DISCIPLINARY_SANCTION' then
    if (p_sanction_code is null) = (p_proposed_sanction_text is null) then perform api._fail('INVALID', 'sanction'); end if;
    if p_sanction_code is not null and not exists (
      select 1 from decision.sanction_catalogue s where s.code = p_sanction_code and s.is_active
    ) then
      perform api._fail('INVALID', 'sanction_code');
    end if;
    -- A sanction is for people (Q88): it names at least one subject.
    if cardinality(v_subjects) = 0 then perform api._fail('INVALID', 'subject_ids'); end if;
  elsif p_sanction_code is not null or p_proposed_sanction_text is not null then
    perform api._fail('INVALID', 'sanction');
  end if;
  if (select count(distinct x) from unnest(v_subjects) x) <> cardinality(v_subjects)
     or exists (select 1 from unnest(v_subjects) x
                where not exists (select 1 from case_mgmt.case_subject s where s.id = x and s.case_id = v_p.case_id)) then
    perform api._fail('INVALID', 'subject_ids');
  end if;
  if (select count(distinct x) from unnest(v_allegations) x) <> cardinality(v_allegations)
     or exists (select 1 from unnest(v_allegations) x
                where not exists (select 1 from case_mgmt.allegation a where a.id = x and a.case_id = v_p.case_id)) then
    perform api._fail('INVALID', 'allegation_ids');
  end if;
  -- CDF-213: never a withdrawn allegation.
  if exists (select 1 from unnest(v_allegations) x join case_mgmt.allegation a on a.id = x where a.status = 'WITHDRAWN') then
    perform api._fail('CONFLICT', 'ALLEGATION_WITHDRAWN');
  end if;
  -- AMB-100: dependencies are active items of the same package; a group is a code.
  if (select count(distinct x) from unnest(v_depends) x) <> cardinality(v_depends)
     or exists (select 1 from unnest(v_depends) x
                where not exists (select 1 from decision.recommendation_item i
                                  where i.id = x and i.package_id = v_p.id and i.status = 'ACTIVE')) then
    perform api._fail('INVALID', 'depends_on_item_ids');
  end if;
  if p_exclusivity_group is not null and p_exclusivity_group !~ '^[A-Z][A-Z0-9_]{2,59}$' then
    perform api._fail('INVALID', 'exclusivity_group');
  end if;
  -- Q89: no subject and no allegation means the whole case.
  v_case_wide := cardinality(v_subjects) = 0 and cardinality(v_allegations) = 0;

  insert into decision.recommendation_item (package_id, case_id, item_type, sanction_code, proposed_sanction_text,
                                            verification_status, description, case_wide, added_by,
                                            requires_legal_justification, exclusivity_group)
  values (v_p.id, v_p.case_id, p_item_type, p_sanction_code,
          case when p_proposed_sanction_text is not null then api._require_text(p_proposed_sanction_text, 'proposed_sanction_text', 3, 500) end,
          case when p_item_type <> 'DISCIPLINARY_SANCTION' then 'NOT_APPLICABLE'
               when p_sanction_code is not null then 'CATALOGUE' else 'PROPOSED_UNVERIFIED' end,
          api._require_text(p_description, 'description', 10, 4000), v_case_wide, v_actor,
          coalesce(p_requires_legal_justification, false), p_exclusivity_group)
  returning id into v_id;
  insert into decision.recommendation_item_subject (item_id, subject_id) select v_id, x from unnest(v_subjects) x;
  insert into decision.recommendation_item_allegation (item_id, allegation_id) select v_id, x from unnest(v_allegations) x;
  insert into decision.recommendation_item_dependency (item_id, depends_on) select v_id, x from unnest(v_depends) x;
  update decision.recommendation_package set updated_at = now(), row_version = row_version + 1 where id = v_p.id;
  perform audit.record_event('RECOMMENDATION_ITEM_ADDED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'recommendation_item', v_id::text,
    null, jsonb_build_object('package_id', v_p.id, 'item_type', p_item_type, 'sanction_code', p_sanction_code,
                             'proposed_unverified', p_proposed_sanction_text is not null, 'case_wide', v_case_wide,
                             'subjects', cardinality(v_subjects), 'allegations', cardinality(v_allegations),
                             'requires_legal_justification', coalesce(p_requires_legal_justification, false),
                             'depends_on', cardinality(v_depends), 'exclusivity_group', p_exclusivity_group));
  return v_id;
end;
$$;

-- 4.2 CDF-214: a FINDING vote is on a finding in the committee's scope (decision.finding_in_committee_scope: the current
-- version, recorded in the committee proceeding or the one it was referred from); anything else is INVALID:finding_id,
-- as an unknown finding already is. Otherwise 1900's command unchanged.
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
  select coalesce(max(vi.sequence_no), 0) + 1 into v_seq from committee.vote_item vi where vi.meeting_id = v_m.id;
  insert into committee.vote_item (meeting_id, case_id, sequence_no, target_type, finding_id, title, opened_by)
  values (v_m.id, v_m.case_id, v_seq, p_target_type, p_finding_id, api._require_text(p_title, 'title', 3, 300), v_actor)
  returning id into v_id;
  perform audit.record_event('VOTE_OPENED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'vote_item', v_id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'sequence_no', v_seq, 'target_type', p_target_type, 'finding_id', p_finding_id));
  return v_id;
end;
$$;

-- =============================================================================
-- 5. The Defence Packet: CDF-217(1) and CDF-218(1) (AGENT-09, LOW; coordinator 2026-10-14 12:44)
-- =============================================================================
-- 5.1 CDF-217(1): whoever made a redacted rendition never clears it (CONFLICT:REVIEWER_IS_REDACTOR), under the same
-- reviewer_must_differ switch as the chooser rule, in the command and in the guard on every path. Otherwise 2050's
-- functions unchanged.
create or replace function grievance.guard_packet_review()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_i grievance.defence_packet_item;
  v_k grievance.defence_packet;
  v_policy grievance.defence_packet_policy := grievance.packet_policy();
  v_ver evidence.evidence_version;
begin
  select * into v_i from grievance.defence_packet_item i where i.id = new.item_id;
  select * into v_k from grievance.defence_packet k where k.id = v_i.packet_id;
  if new.packet_id is distinct from v_i.packet_id then perform api._fail('INVALID', 'item_id'); end if;
  if v_k.status <> 'DRAFT' then perform api._fail('CONFLICT', 'PACKET_NOT_DRAFT'); end if;
  if coalesce(v_policy.reviewer_must_differ, true) and new.reviewed_by = v_i.added_by then
    perform api._fail('CONFLICT', 'REVIEWER_IS_CHOOSER');
  end if;
  if new.outcome <> 'WITHHELD' then
    -- AMB-118: nothing is cleared until LEGAL_PRIVILEGE_RULE is recorded (fail closed); the rule in force is snapshotted.
    if v_policy.privilege_rule_reference is null then perform api._fail('CONFLICT', 'LEGAL_PRIVILEGE_RULE_REQUIRED'); end if;
    new.privilege_rule_reference := v_policy.privilege_rule_reference;
    select * into v_ver from evidence.evidence_version v where v.id = new.disclosed_version_id;
    if (new.outcome = 'CLEARED_AS_IS' and v_ver.id is distinct from v_i.source_version_id)
       or (new.outcome = 'CLEARED_REDACTED'
           and (v_ver.rendition is distinct from 'REDACTED' or v_ver.derived_from_version_id is distinct from v_i.source_version_id)) then
      perform api._fail('INVALID', 'disclosed_version_id');
    end if;
    if new.outcome = 'CLEARED_REDACTED' and coalesce(v_policy.reviewer_must_differ, true)
       and v_ver.uploaded_by = new.reviewed_by then
      perform api._fail('CONFLICT', 'REVIEWER_IS_REDACTOR');
    end if;
    if not evidence.version_disclosable(v_ver.id) then perform api._fail('CONFLICT', 'ITEM_NOT_DISCLOSABLE'); end if;
  end if;
  return new;
end;
$$;

create or replace function api.review_defence_packet_item(p_item_id uuid, p_outcome text, p_disclosed_version_id uuid,
                                               p_disclosed_title text, p_checks text[], p_note text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_i grievance.defence_packet_item;
  v_k grievance.defence_packet;
  v_all text[] := array['REPORTER', 'WITNESS', 'CONFIDENTIALITY', 'PRIVILEGE', 'RESTRICTED_INFORMATION', 'OTHER_PROTECTED'];
  v_checks text[] := coalesce(p_checks, '{}');
  v_version uuid;
  v_id uuid;
begin
  select * into v_i from grievance.defence_packet_item i where i.id = p_item_id;
  select * into v_k from grievance.defence_packet k where k.id = v_i.packet_id;
  if v_i.id is null or not authz.can_view_case(v_k.case_id) or not authz.can_view_evidence(v_i.evidence_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if not authz.is_evidence_lead(v_k.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_k.case_id for update;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_k.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  select * into v_k from grievance.defence_packet k where k.id = v_i.packet_id for update;
  if v_k.status <> 'DRAFT' then perform api._fail('CONFLICT', 'PACKET_NOT_DRAFT'); end if;
  if exists (select 1 from grievance.defence_packet_review r where r.item_id = v_i.id) then
    perform api._fail('CONFLICT', 'ALREADY_REVIEWED');
  end if;
  if coalesce((grievance.packet_policy()).reviewer_must_differ, true) and v_i.added_by = v_actor then
    perform api._fail('CONFLICT', 'REVIEWER_IS_CHOOSER');
  end if;
  if p_outcome is null or p_outcome not in ('CLEARED_AS_IS', 'CLEARED_REDACTED', 'WITHHELD') then
    perform api._fail('INVALID', 'outcome');
  end if;
  if (select count(distinct x) from unnest(v_checks) x) <> cardinality(v_checks) or not (v_checks <@ v_all)
     or (p_outcome <> 'WITHHELD' and not (v_checks @> v_all)) then
    perform api._fail('INVALID', 'checks');
  end if;
  if p_outcome = 'WITHHELD' then
    if p_disclosed_version_id is not null then perform api._fail('INVALID', 'disclosed_version_id'); end if;
    if p_disclosed_title is not null then perform api._fail('INVALID', 'disclosed_title'); end if;
    perform api._require_text(p_note, 'note', 10, 2000);
  else
    perform api._require_text(p_disclosed_title, 'disclosed_title', 3, 200);
    if p_note is not null then perform api._require_text(p_note, 'note', 10, 2000); end if;
    if (grievance.packet_policy()).privilege_rule_reference is null then
      perform api._fail('CONFLICT', 'LEGAL_PRIVILEGE_RULE_REQUIRED');
    end if;
    v_version := case when p_outcome = 'CLEARED_AS_IS' then coalesce(p_disclosed_version_id, v_i.source_version_id)
                      else p_disclosed_version_id end;
    if not exists (select 1 from evidence.evidence_version v
                   where v.id = v_version and v.evidence_id = v_i.evidence_id
                     and case p_outcome when 'CLEARED_AS_IS' then v.id = v_i.source_version_id
                                        else v.rendition = 'REDACTED' and v.derived_from_version_id = v_i.source_version_id end) then
      perform api._fail('INVALID', 'disclosed_version_id');
    end if;
    -- CDF-217(1): whoever made the redacted rendition never clears it, under the same switch as the chooser rule.
    if p_outcome = 'CLEARED_REDACTED' and coalesce((grievance.packet_policy()).reviewer_must_differ, true)
       and exists (select 1 from evidence.evidence_version v where v.id = v_version and v.uploaded_by = v_actor) then
      perform api._fail('CONFLICT', 'REVIEWER_IS_REDACTOR');
    end if;
    if not evidence.version_disclosable(v_version) then perform api._fail('CONFLICT', 'ITEM_NOT_DISCLOSABLE'); end if;
  end if;
  insert into grievance.defence_packet_review (item_id, packet_id, outcome, disclosed_version_id, disclosed_title, checks,
                                               note, reviewed_by)
  values (v_i.id, v_k.id, p_outcome, v_version, nullif(btrim(p_disclosed_title), ''), v_checks,
          nullif(btrim(p_note), ''), v_actor)
  returning id into v_id;
  perform audit.record_event('DEFENCE_PACKET_ITEM_REVIEWED', 'BUSINESS', 'SUCCESS', v_k.case_id, 'defence_packet',
    v_k.id::text, null, jsonb_build_object('item_id', v_i.id, 'review_id', v_id, 'outcome', p_outcome));
  return v_id;
end;
$$;

-- 5.2 CDF-218(1): what the Restricted Case Authority approves. Bound to the approval request: the gate of
-- api.decide_restricted_defence_packet, the same helpers in the same order, without its locks; every refusal is
-- NOT_FOUND. The review record and what release would show the subject (reviewed titles, type and size of cleared
-- items), never evidence: no evidence or version id, title, file, key, hash, bytes or note. Audited, counts only.
create function api.defence_packet_approval_view(p_packet_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_k grievance.defence_packet;
  v_case case_mgmt.case_record;
  v_items jsonb;
begin
  select * into v_k from grievance.defence_packet k where k.id = p_packet_id;
  if v_k.id is null or not authz.can_view_case(v_k.case_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = v_k.case_id;
  if not v_case.is_restricted then perform api._fail('NOT_FOUND'); end if;
  if v_case.owner_id is distinct from v_actor
     or not authz.is_restricted_case_authority(v_actor, v_case.classification) then
    perform api._fail('NOT_FOUND');
  end if;
  if v_actor in (v_k.created_by, v_k.submitted_by) then perform api._fail('NOT_FOUND'); end if;
  if v_k.status <> 'AWAITING_AUTHORITY' then perform api._fail('NOT_FOUND'); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', i.id, 'position', i.position, 'added_by', i.added_by,
           'outcome', r.outcome, 'checks', to_jsonb(r.checks), 'reviewed_by', r.reviewed_by, 'reviewed_at', r.reviewed_at,
           'redaction', case r.outcome when 'CLEARED_AS_IS' then 'NONE' when 'CLEARED_REDACTED' then 'REDACTED_RENDITION'
                                       else 'WITHHELD' end,
           'disclosed_title', case when r.outcome <> 'WITHHELD' then r.disclosed_title end,
           'content_type', case when r.outcome <> 'WITHHELD' then v.content_type end,
           'size_bytes', case when r.outcome <> 'WITHHELD' then v.size_bytes end,
           'disclosable', r.outcome <> 'WITHHELD' and evidence.version_disclosable(r.disclosed_version_id))
         order by i.position), '[]'::jsonb)
  into v_items
  from grievance.defence_packet_item i
  join grievance.defence_packet_review r on r.item_id = i.id
  left join evidence.evidence_version v on v.id = r.disclosed_version_id
  where i.packet_id = v_k.id;
  perform audit.record_event('DEFENCE_PACKET_APPROVAL_VIEWED', 'BUSINESS', 'SUCCESS', v_k.case_id, 'defence_packet',
    v_k.id::text, null, jsonb_build_object(
      'items', jsonb_array_length(v_items),
      'cleared', (select count(*) from jsonb_array_elements(v_items) e where e ->> 'outcome' <> 'WITHHELD'),
      'withheld', (select count(*) from jsonb_array_elements(v_items) e where e ->> 'outcome' = 'WITHHELD')));
  return jsonb_build_object(
    'packet_id', v_k.id, 'notice_id', v_k.notice_id, 'subject_id', v_k.subject_id, 'sequence_no', v_k.sequence_no,
    'status', v_k.status, 'created_by', v_k.created_by, 'submitted_by', v_k.submitted_by,
    'submitted_at', v_k.submitted_at,
    'release_block', grievance.packet_release_block(v_k.id),
    'items', v_items,
    'counts', jsonb_build_object(
      'items', jsonb_array_length(v_items),
      'cleared', (select count(*) from jsonb_array_elements(v_items) e where e ->> 'outcome' <> 'WITHHELD'),
      'redacted', (select count(*) from jsonb_array_elements(v_items) e where e ->> 'redaction' = 'REDACTED_RENDITION'),
      'withheld', (select count(*) from jsonb_array_elements(v_items) e where e ->> 'outcome' = 'WITHHELD'),
      'not_disclosable', (select count(*) from jsonb_array_elements(v_items) e
                          where e ->> 'outcome' <> 'WITHHELD' and not (e ->> 'disclosable')::boolean)));
end;
$$;

-- 5.3 The 2050 comment on api.defence_packet_view named the Restricted Case Authority as a reader; the function serves
-- the case's evidence leads only (the safe direction). Corrected here; the authority reads 5.2.
comment on function api.defence_packet_view(uuid) is
  'A Defence Packet for its case''s evidence leads: items, reviews (without notes) and what blocks release (migration '
  '2050). The Restricted Case Authority approving a restricted packet reads api.defence_packet_approval_view (2060).';

-- =============================================================================
-- 6. Grants and the catalogue
-- =============================================================================
revoke all on function
  case_mgmt.closure_authority_role(), case_mgmt.closure_blocks(uuid), case_mgmt.closure_step(uuid),
  case_mgmt.guard_case_readiness(), case_mgmt.record_closure(uuid, text, text, text, uuid, uuid),
  case_mgmt.protect_closure_request(), case_mgmt.protect_reopening_request(),
  decision.package_decisive_conflict(uuid), decision.protect_label_policy(), decision.committee_label_mode(),
  decision.finding_in_committee_scope(uuid, uuid), decision.subject_choice(uuid, text, boolean)
from public, anon, authenticated;

revoke all on function
  api.close_case(uuid, text, text), api.decide_case_closure(uuid, text, text),
  api.request_case_reopening(uuid, text, text, text, text, uuid), api.decide_case_reopening(uuid, text, text),
  api.case_closure_view(uuid), api.committee_scope_choices(uuid), api.committee_items_view(uuid),
  api.defence_packet_approval_view(uuid)
from public;
grant execute on function
  api.close_case(uuid, text, text), api.decide_case_closure(uuid, text, text),
  api.request_case_reopening(uuid, text, text, text, text, uuid), api.decide_case_reopening(uuid, text, text),
  api.case_closure_view(uuid), api.committee_scope_choices(uuid), api.committee_items_view(uuid),
  api.defence_packet_approval_view(uuid)
to authenticated;

-- The form and status catalogue (migration 1970) follows the schema: P11-G2 closes. The closure forms map to
-- api.close_case; their SOURCE_REQUIRED notes stay.
update config.legacy_form_map
   set merge_target = case legacy_id
         when 'T10-B2.2-089' then 'api.close_case(outcome=EMERGENCY_CLOSURE, inactive until who may order it is recorded)'
         else replace(merge_target, 'close_case(', 'api.close_case(')
       end,
       gap_ref = null
 where gap_ref = 'P11-G2';
update config.target_module
   set commands = commands || array['api.close_case', 'api.decide_case_closure', 'api.case_closure_view'],
       delivered_in = delivered_in || '2060'::text,
       notes = 'api.close_case records the case outcome (DEC-F39) over the CDF_CASE_V1 closure steps, with every '
               'blocker checked on every path; routing to the closure authority waits for CASE_CLOSURE_APPROVAL_RULE '
               '(SOURCE_REQUIRED, 2060). The phase 9/10 steps into CLOSURE are not enabled.'
 where code = 'CASE_CLOSE';
update config.target_module
   set commands = commands || array['api.request_case_reopening', 'api.decide_case_reopening'],
       delivered_in = delivered_in || '2060'::text,
       notes = 'Reinvestigation after a grievance opens a proceeding. Reopening a closed case (DEC-AMB-002, '
               'DEC-AMB-015: new evidence or DECISIVE_POST_DECISION_CONFLICT) is approved by the closure authority and '
               'fails closed while CASE_CLOSURE_APPROVAL_RULE is SOURCE_REQUIRED (2060).'
 where code = 'CASE_REOPEN';
update config.legacy_status_map
   set source_required = 'who the closure authority is (CASE_CLOSURE_APPROVAL_RULE, AMB-212); it approves every '
                         'reopening (DEC-AMB-002)'
 where legacy_code in ('S070', 'S086') and source_required = 'who may reopen a closed case';
