-- =============================================================================
-- 2020 Purpose-bound grant scope (UX redesign S3; DEC-02 and DEC-03 approved 2026-10-11; ADR-016 D2, D3)
-- Requirements: audit RC-24, UX-036, UX-066, UX-112; Linear CDF-179. Number allocated by the coordinator.
--
-- Before: authz.has_active_grant ignored the grant's scope, so a TRIAGE, COMMITTEE or REVIEW grant opened the
-- whole case file, and the creator's 30-day TRIAGE grant outlived hand-over.
--
-- After, in one transaction:
--   1. Scope decides. Only CASE and AUDIT grants open the case file, and a TRIAGE grant only while the case is
--      before hand-over (a state before JURISDICTION, the S1 display rule now enforced). COMMITTEE and REVIEW
--      grants open no case (D2). Every predicate built on authz.has_active_grant narrows with it.
--   2. Hand-over (D3): the transition that takes a case out of the triage stages (COMPLETE_TRIAGE, SCREEN_OUT)
--      ends every TRIAGE grant on it in the same transaction, one CASE_ACCESS_REVOKED event per grant. A
--      restricted case is handed over only to a receiving owner (an owner or investigator assignment, or a CASE
--      grant, held by someone the case gate admits); otherwise the transition is refused with
--      CONFLICT:HANDOVER_NO_RECEIVING_OWNER. Reassignment already ends the outgoing assignee's assignment in its
--      own transaction (api.reassign_case); with the TRIAGE residue closed here, nothing else keeps the former
--      assignee in the case unless an independent relationship exists (AMB-013; test T-AMB-005).
--   3. New COMMITTEE and REVIEW grants are refused (api.grant_case_access, and a table trigger as defence in
--      depth). Committee and legal-review work runs through the committee, packet and legal-review commands
--      (1870-1920; gap map accepted 2026-10-12).
--   4. Interim path (a) for legacy instances only: case_mgmt.form_instance_access keeps, for the holder of a
--      reconciled COMMITTEE or REVIEW grant, each in-flight form instance of that case their roles may view.
--      It opens that instance (and through the form predicates, review, approval or completion where their
--      roles are entitled), never the case. It ends by itself when the instance is final or withdrawn, or the
--      case leaves ACTIVE; the case gate (clearance, conflict, linked subject) applies throughout.
--   5. Findings (case_mgmt.finding) need a case-file basis: a TRIAGE grant before hand-over shows none.
--   6. Reconciliation (D2 evidence rule): every over-purpose grant still in effect (TRIAGE past hand-over, every
--      COMMITTEE and REVIEW grant) is ended, never deleted: status REVOKED with its time and reason, one audit
--      event per grant, and one row per grant in case_mgmt.grant_scope_reconciliation (before and after values,
--      outcome, forms kept, the audit event id). Locally the migration runs before the seed, so it changes
--      nothing there; on a hosted database it reconciles the live rows.
--   7. Read models (UX-owned): My Work lists form-scoped drafts (FORM_TO_COMPLETE) and returned forms through the
--      instance predicate; the sidebar counts only grants that open a case; "My access" and the case roster
--      show form-scoped access.
--
-- Not decided here (they stay with the owner): DEC-04, DEC-05, DEC-19, DEC-49. Form definitions are untouched
-- (form retirement is the rebase's Phase 11).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Scope decides
-- -----------------------------------------------------------------------------
-- The triage stages: every state before JURISDICTION. A workflow without JURISDICTION has no triage stage, so a
-- TRIAGE grant opens nothing on it (fail closed). Internal: not granted to application roles.
create function workflow.is_triage_state(p_workflow_code text, p_state text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select s.sequence < j.sequence
      from workflow.workflow_state s
      join workflow.workflow_state j on j.workflow_code = s.workflow_code and j.code = 'JURISDICTION'
     where s.workflow_code = p_workflow_code and s.code = p_state), false);
$$;

-- Whether a case is still before hand-over. Internal: it answers for any case id, so it is not granted.
create function authz.case_before_handover(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from workflow.workflow_instance w
                  where w.case_id = p_case_id and workflow.is_triage_state(w.workflow_code, w.current_state));
$$;

-- A grant opens the case file only within its purpose (DEC-02, DEC-03). Same signature, so every caller
-- (authz.user_can_view_case, authz.can_view_records, api.change_case_classification) narrows with it.
create or replace function authz.has_active_grant(p_case_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from case_mgmt.case_access_grant g
    where g.case_id = p_case_id and g.user_id = p_user_id and g.status = 'ACTIVE'
      and g.effective_from <= now() and (g.effective_to is null or g.effective_to > now())
      and (g.scope in ('CASE', 'AUDIT')
           or (g.scope = 'TRIAGE' and authz.case_before_handover(g.case_id)))
  );
$$;

-- The caller's basis for the case file beyond triage: what investigation content (findings) needs.
create function authz.has_case_file_basis(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from case_mgmt.case_record c
     where c.id = p_case_id and authz.current_user_id() is not null
       and ((not c.is_restricted and authz.has_permission('CASE_VIEW_ALL'))
            or authz.has_active_assignment(c.id, authz.current_user_id())
            or exists (select 1 from case_mgmt.case_access_grant g
                        where g.case_id = c.id and g.user_id = authz.current_user_id() and g.status = 'ACTIVE'
                          and g.scope in ('CASE', 'AUDIT') and g.effective_from <= now()
                          and (g.effective_to is null or g.effective_to > now()))
            or authz.has_active_break_glass(c.id, authz.current_user_id()))
  );
$$;

-- -----------------------------------------------------------------------------
-- 2. Form-scoped legacy access (ADR-016 D2, interim path (a))
-- -----------------------------------------------------------------------------
create table case_mgmt.form_instance_access (
  id              uuid primary key default gen_random_uuid(),
  instance_id     uuid not null references forms.form_instance (id),
  case_id         uuid not null references case_mgmt.case_record (id),
  user_id         uuid not null references iam.user_profile (id),
  source_grant_id uuid not null references case_mgmt.case_access_grant (id),
  source_scope    text not null check (source_scope in ('COMMITTEE', 'REVIEW')),
  created_at      timestamptz not null default now(),
  unique (instance_id, user_id)
);
create index form_instance_access_user on case_mgmt.form_instance_access (user_id);
create index form_instance_access_case on case_mgmt.form_instance_access (case_id);
create index form_instance_access_source on case_mgmt.form_instance_access (source_grant_id);
comment on table case_mgmt.form_instance_access is
  'Form-scoped access kept from a reconciled COMMITTEE or REVIEW grant (ADR-016 D2, path (a)). Written only by the S3 reconciliation; immutable; effective while the instance is in flight on an active case.';

-- Immutable and never deleted; no application role reads it directly (RLS on, no grant).
alter table case_mgmt.form_instance_access enable row level security;
create trigger protect_no_update before update on case_mgmt.form_instance_access
  for each row execute function records.reject_mutation();
create trigger protect_no_delete before delete on case_mgmt.form_instance_access
  for each row execute function records.reject_mutation();
create trigger protect_no_truncate before truncate on case_mgmt.form_instance_access
  for each statement execute function records.reject_mutation();

-- The caller holds form-scoped access to this instance, and it is still effective. Internal.
create function authz.has_form_instance_access(p_instance_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from case_mgmt.form_instance_access a
      join forms.form_instance i on i.id = a.instance_id
      join forms.form_definition d on d.code = i.form_code
      join case_mgmt.case_record c on c.id = i.case_id
     where a.instance_id = p_instance_id and a.user_id = authz.current_user_id()
       and i.status <> 'WITHDRAWN' and i.status <> forms.terminal_status(d.review_required, d.approval_required)
       and c.records_state = 'ACTIVE'
       and authz.user_case_gate(a.user_id, i.case_id)
  );
$$;

-- Viewing a form: the case, or form-scoped access to this instance. Clearance, permission and entitlement as
-- before; review and approval build on this, so a kept instance stays reviewable and approvable by its
-- entitled holder.
create or replace function authz.can_view_form_instance(p_instance_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from forms.form_instance i
    where i.id = p_instance_id
      and (authz.can_view_case(i.case_id) or authz.has_form_instance_access(i.id))
      and i.classification <= authz.current_clearance()
      and authz.has_permission('FORM_VIEW')
      and authz.form_entitled(i.form_code, 'VIEW')
  );
$$;

-- Saving and preparing an existing instance: the case-level rule, or form-scoped access with the permission and
-- the entitlement to prepare this form. Starting and withdrawing stay case-level.
create function authz.can_prepare_form_instance(p_instance_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from forms.form_instance i
     where i.id = p_instance_id
       and (authz.can_prepare_form(i.case_id, i.form_code)
            or (authz.has_form_instance_access(i.id)
                and authz.has_permission('FORM_PREPARE')
                and authz.form_entitled(i.form_code, 'PREPARE')
                and exists (select 1 from forms.form_definition d where d.code = i.form_code and d.is_enabled)))
  );
$$;

revoke all on function workflow.is_triage_state(text, text), authz.case_before_handover(uuid),
  authz.has_form_instance_access(uuid), authz.has_case_file_basis(uuid),
  authz.can_prepare_form_instance(uuid) from public;
grant execute on function authz.has_case_file_basis(uuid), authz.can_prepare_form_instance(uuid) to authenticated;

-- Saving a draft. Only change from 1100: the instance-level preparer rule.
create or replace function api.save_form_draft(p_instance_id uuid, p_data jsonb)
returns table (o_version_id uuid, o_version_no int, o_content_hash text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_inst forms.form_instance;
  v_schema_hash text;
  v_norm jsonb;
  v_hash text;
  v_current forms.form_instance_version;
  v_version_id uuid;
  v_version_no int;
begin
  select * into v_inst from forms.form_instance i where i.id = p_instance_id for update;
  if v_inst.id is null or not authz.can_view_form_instance(p_instance_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_prepare_form_instance(p_instance_id) then perform api._fail('FORBIDDEN'); end if;
  if v_inst.status <> 'DRAFT' then perform api._fail('CONFLICT', 'FORM_NOT_DRAFT'); end if;

  select v.schema_hash into v_schema_hash from forms.form_definition_version v where v.id = v_inst.definition_version_id;
  v_norm := forms.validate_data(v_inst.definition_version_id, p_data, false);
  v_hash := forms.content_hash(v_inst.form_code, v_schema_hash, v_norm);

  if v_inst.current_version_id is not null then
    select * into v_current from forms.form_instance_version v where v.id = v_inst.current_version_id;
    if v_current.content_hash = v_hash then
      return query select v_current.id, v_current.version_no, v_current.content_hash;
      return;
    end if;
  end if;

  select coalesce(max(v.version_no), 0) + 1 into v_version_no from forms.form_instance_version v where v.instance_id = p_instance_id;
  insert into forms.form_instance_version (instance_id, version_no, data, content_hash, saved_by, request_id)
  values (p_instance_id, v_version_no, v_norm, v_hash, v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid)
  returning id into v_version_id;

  update forms.form_instance set current_version_id = v_version_id, updated_at = now() where id = p_instance_id;

  insert into forms.form_event (instance_id, event_type, from_status, to_status, version_id, actor_id, request_id)
  values (p_instance_id, 'SAVED', 'DRAFT', 'DRAFT', v_version_id, v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid);

  perform audit.record_event('FORM_SAVED', 'BUSINESS', 'SUCCESS', v_inst.case_id, 'form_instance', p_instance_id::text, null,
    jsonb_build_object('form_code', v_inst.form_code, 'instance_no', v_inst.instance_no, 'version_no', v_version_no,
                       'content_hash', v_hash));
  return query select v_version_id, v_version_no, v_hash;
end;
$$;

-- Locks the current version as the prepared content. Only change from 1100: the instance-level preparer rule.
create or replace function api.prepare_form(p_instance_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_inst forms.form_instance;
  v_def forms.form_definition;
  v_current forms.form_instance_version;
begin
  select * into v_inst from forms.form_instance i where i.id = p_instance_id for update;
  if v_inst.id is null or not authz.can_view_form_instance(p_instance_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_prepare_form_instance(p_instance_id) then perform api._fail('FORBIDDEN'); end if;
  if v_inst.status <> 'DRAFT' then perform api._fail('CONFLICT', 'FORM_NOT_DRAFT'); end if;
  if v_inst.current_version_id is null then perform api._fail('CONFLICT', 'FORM_EMPTY'); end if;
  select * into v_def from forms.form_definition d where d.code = v_inst.form_code;
  select * into v_current from forms.form_instance_version v where v.id = v_inst.current_version_id;
  perform forms.validate_data(v_inst.definition_version_id, v_current.data, true);

  update forms.form_instance
     set status = 'PREPARED', prepared_version_id = v_inst.current_version_id, prepared_by = v_actor, prepared_at = now(),
         updated_at = now()
   where id = p_instance_id;

  insert into forms.form_event (instance_id, event_type, from_status, to_status, version_id, actor_id, request_id)
  values (p_instance_id, 'PREPARED', 'DRAFT', 'PREPARED', v_inst.current_version_id, v_actor,
          nullif(current_setting('cdf.request_id', true), '')::uuid);

  perform audit.record_event('FORM_PREPARED', 'BUSINESS', 'SUCCESS', v_inst.case_id, 'form_instance', p_instance_id::text, null,
    jsonb_build_object('form_code', v_inst.form_code, 'instance_no', v_inst.instance_no, 'version_no', v_current.version_no,
                       'content_hash', v_current.content_hash,
                       'final', forms.terminal_status(v_def.review_required, v_def.approval_required) = 'PREPARED'));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Hand-over ends triage access (ADR-016 D3)
-- -----------------------------------------------------------------------------
-- Ends one grant: status REVOKED with its time, actor and reason. Never deleted; the original period stays on the
-- row. One CASE_ACCESS_REVOKED event; metadata carries codes and ids only. Internal: callers are below.
create function case_mgmt.end_grant_internal(
  p_grant_id uuid, p_actor uuid, p_reason text, p_metadata jsonb, p_actor_type text default 'USER'
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare v case_mgmt.case_access_grant;
begin
  update case_mgmt.case_access_grant
     set status = 'REVOKED', revoked_at = now(), revoked_by = p_actor, revocation_reason = p_reason
   where id = p_grant_id and status = 'ACTIVE'
  returning * into v;
  if v.id is null then perform api._fail('CONFLICT', 'GRANT_NOT_ACTIVE'); end if;
  return audit.record_event('CASE_ACCESS_REVOKED', 'BUSINESS', 'SUCCESS', v.case_id, 'case_access_grant', v.id::text, p_reason,
    jsonb_build_object('user_id', v.user_id, 'scope', v.scope) || coalesce(p_metadata, '{}'::jsonb), p_actor_type);
end;
$$;

-- Formal hand-over: a legitimate receiving owner or team exists and responsibility moves to it. For an ordinary
-- case the receiving team is case management (CASE_VIEW_ALL); a restricted case needs a named owner or
-- investigator, or a CASE grant, held by an active user the case gate admits (clearance, no conflict), so the
-- case is never handed to someone who cannot open it. Every TRIAGE grant still in effect ends in the caller's
-- transaction.
create function case_mgmt.hand_over_from_triage(p_case_id uuid, p_actor uuid, p_transition text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare g record;
begin
  if exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.is_restricted)
     and not exists (select 1 from case_mgmt.case_assignment a
                      where a.case_id = p_case_id and a.status = 'ACTIVE'
                        and a.assignment_role in ('CASE_OWNER', 'LEAD_INVESTIGATOR', 'INVESTIGATOR')
                        and authz.user_case_gate(a.user_id, p_case_id))
     and not exists (select 1 from case_mgmt.case_access_grant x
                      where x.case_id = p_case_id and x.scope = 'CASE' and x.status = 'ACTIVE'
                        and x.effective_from <= now() and (x.effective_to is null or x.effective_to > now())
                        and authz.user_case_gate(x.user_id, p_case_id)) then
    perform api._fail('CONFLICT', 'HANDOVER_NO_RECEIVING_OWNER');
  end if;
  for g in select x.id from case_mgmt.case_access_grant x
            where x.case_id = p_case_id and x.scope = 'TRIAGE' and x.status = 'ACTIVE'
              and (x.effective_to is null or x.effective_to > now())
            order by x.id
            for update loop
    perform case_mgmt.end_grant_internal(g.id, p_actor, 'Hand-over: triage access ends with the triage stage',
      jsonb_build_object('basis', 'HANDOVER', 'transition', p_transition));
  end loop;
end;
$$;

revoke all on function case_mgmt.end_grant_internal(uuid, uuid, text, jsonb, text),
  case_mgmt.hand_over_from_triage(uuid, uuid, text) from public;

-- The workflow engine. Only change from 0700: the hand-over at the end.
create or replace function workflow.apply_transition(
  p_case_id uuid, p_transition_code text, p_actor uuid, p_reason text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_inst workflow.workflow_instance;
  v_def workflow.workflow_transition_definition;
  v_state workflow.workflow_state;
  v_sla int;
begin
  select * into v_inst from workflow.workflow_instance i where i.case_id = p_case_id for update;
  select * into v_def from workflow.workflow_transition_definition d
   where d.workflow_code = v_inst.workflow_code and d.code = p_transition_code and d.from_state = v_inst.current_state;
  if v_def.code is null then
    perform api._fail('CONFLICT', 'TRANSITION_NOT_AVAILABLE_FROM_STATE');
  end if;
  select * into v_state from workflow.workflow_state s where s.workflow_code = v_inst.workflow_code and s.code = v_def.to_state;
  select min(d.sla_hours) into v_sla from workflow.workflow_transition_definition d
   where d.workflow_code = v_inst.workflow_code and d.from_state = v_def.to_state and d.is_enabled and not d.is_system;

  update workflow.workflow_instance
     set current_state = v_def.to_state, entered_state_at = now(),
         state_due_at = case when v_sla is null then null else now() + make_interval(hours => v_sla) end
   where id = v_inst.id;

  insert into workflow.workflow_transition_event (instance_id, case_id, transition_code, from_state, to_state, actor_id, reason, request_id)
  values (v_inst.id, p_case_id, v_def.code, v_def.from_state, v_def.to_state, p_actor, p_reason,
          nullif(current_setting('cdf.request_id', true), '')::uuid);

  update case_mgmt.case_record c
     set records_state = v_state.records_state,
         opened_at = case when v_def.to_state = 'INVESTIGATION' and c.opened_at is null then now() else c.opened_at end,
         closed_at = case when v_state.records_state = 'CLOSED' then now()
                          when v_state.records_state = 'ACTIVE' then null else c.closed_at end,
         updated_at = now(), updated_by = p_actor, row_version = c.row_version + 1
   where c.id = p_case_id;

  perform audit.record_event(v_def.audit_action, 'BUSINESS', 'SUCCESS', p_case_id, 'workflow_instance', v_inst.id::text, p_reason,
    jsonb_build_object('transition', v_def.code, 'from', v_def.from_state, 'to', v_def.to_state));
  if v_state.records_state = 'CLOSED' then
    perform audit.record_event('CASE_CLOSED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_record', p_case_id::text, p_reason, '{}'::jsonb);
  elsif v_def.code = 'REOPEN_CASE' then
    perform audit.record_event('CASE_REOPENED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_record', p_case_id::text, p_reason, '{}'::jsonb);
  end if;
  -- S3 (ADR-016 D3): leaving the triage stages is the formal hand-over; triage access ends in this transaction.
  if workflow.is_triage_state(v_inst.workflow_code, v_def.from_state)
     and not workflow.is_triage_state(v_inst.workflow_code, v_def.to_state) then
    perform case_mgmt.hand_over_from_triage(p_case_id, p_actor, v_def.code);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. No new COMMITTEE or REVIEW grants (ADR-016 D2)
-- -----------------------------------------------------------------------------
-- Only change from 0700: the scope list.
create or replace function api.grant_case_access(
  p_case_id uuid, p_user_id uuid, p_scope text, p_reason text, p_effective_to timestamptz default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_user iam.user_profile;
  v_id uuid;
  v_reason text;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id;
  if v_case.is_restricted then
    if not authz.has_permission('RESTRICTED_CASE_GRANT') then perform api._fail('FORBIDDEN'); end if;
  elsif not authz.can_assign_case(p_case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  -- S3 (DEC-02): COMMITTEE and REVIEW are not case-file grants; that work has its own commands.
  if p_scope is null or p_scope not in ('CASE', 'AUDIT') then perform api._fail('INVALID', 'scope'); end if;
  if p_effective_to is not null and p_effective_to <= now() then perform api._fail('INVALID', 'effective_to'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  select * into v_user from iam.user_profile u where u.id = p_user_id;
  if v_user.id is null or v_user.status <> 'ACTIVE' then perform api._fail('INVALID', 'user_id'); end if;
  if v_case.classification > v_user.clearance then perform api._fail('CONFLICT', 'GRANTEE_CLEARANCE_INSUFFICIENT'); end if;
  if authz.has_conflict(p_case_id, p_user_id) then perform api._fail('CONFLICT', 'GRANTEE_HAS_CONFLICT'); end if;
  insert into case_mgmt.case_access_grant (case_id, user_id, scope, reason, effective_to, granted_by)
  values (p_case_id, p_user_id, p_scope, v_reason, p_effective_to, v_actor) returning id into v_id;
  perform audit.record_event('CASE_ACCESS_GRANTED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_access_grant', v_id::text, v_reason,
    jsonb_build_object('user_id', p_user_id, 'scope', p_scope, 'effective_to', p_effective_to));
  return v_id;
end;
$$;

-- Defence in depth: no path may create a COMMITTEE or REVIEW grant any more (the column check keeps the codes,
-- so reconciled rows keep their original scope).
create function case_mgmt.reject_non_case_file_grant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.scope in ('COMMITTEE', 'REVIEW') then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:scope';
  end if;
  return new;
end;
$$;
create trigger case_access_grant_scope_guard before insert on case_mgmt.case_access_grant
  for each row execute function case_mgmt.reject_non_case_file_grant();

-- -----------------------------------------------------------------------------
-- 5. Findings need a case-file basis (ADR-017 rebase note; DEC-02, DEC-03)
-- -----------------------------------------------------------------------------
alter policy finding_read on case_mgmt.finding
  using (authz.can_view_case(case_id) and authz.has_case_file_basis(case_id));

-- -----------------------------------------------------------------------------
-- 7. Read models (UX-owned): My Work, the sidebar, My access, the case roster
-- -----------------------------------------------------------------------------
-- My Work: from 1860, plus FORM_TO_COMPLETE and the instance-level rule for returned forms.
create or replace function api.my_work_items()
returns table (
  area text,             -- MY_WORK, INTAKE, CASES or RECORDS: where the item's target lives
  view text,             -- NEEDS_ACTION, MY_CASES, DUE_SOON or WAITING
  category text,         -- the item type; the page renders a fixed template for it
  target_type text,      -- REPORT, CASE, CONFLICT, FORM_INSTANCE, INTERVIEW, CASE_TASK, HOLD_REQUEST, HOLD_RELEASE,
                         -- RECORD (a case's records page)
  target_id uuid,
  case_id uuid,          -- only when the caller may see the case's metadata (CDF-84: a controlled lookup's
                         -- requester never learns which case the request reached)
  case_number text,      -- the same rule
  due_at timestamptz,
  due_source text,       -- TASK, SCHEDULE or WORKFLOW_SLA_PROVISIONAL; null when there is no due date
  since_at timestamptz
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
  )
  select i.area, i.view, i.category, i.target_type, i.target_id,
         case when i.case_id is not null and authz.can_view_case_metadata(i.case_id) then i.case_id end,
         case when i.case_id is not null and authz.can_view_case_metadata(i.case_id) then c.case_number end,
         i.due_at, i.due_source, i.since_at
    from items i
    left join case_mgmt.case_record c on c.id = i.case_id
   where authz.current_user_id() is not null
   order by (i.due_at is null), i.due_at, i.since_at, i.target_id;
$$;

-- The sidebar: from 1870, with scope-aware grant checks and form-scoped access for My Work.
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
      exists (select 1 from records.case_record_catalogue k where authz.can_view_records_catalogue(k.case_id)) as catalogue_row
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
    select 'ADMINISTRATION', authz.has_permission('USER_ADMIN') or authz.has_permission('ROLE_ADMIN'), 'users', 7
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

-- My access: from 1820, with scope-aware grants and form-scoped access. One output column is added at the end,
-- target_id: the kept form's id on a FORM_ACCESS row (null elsewhere), so the row can lead to that form. Without
-- it, forms with the same number on different cases read alike, because the case is not named. A new output
-- column means dropping and creating the function again, with its grant; it reads only, so nothing is lost.
drop function api.my_access();
create function api.my_access()
returns table (basis text, code text, case_id uuid, case_number text, since_at timestamptz, until_at timestamptz,
               target_id uuid)
language sql stable security definer
set search_path = ''
as $$
  with me as (
    select u.id, u.clearance from iam.user_profile u where u.id = authz.current_user_id() and u.status = 'ACTIVE'
  )
  select x.basis, x.code, x.case_id,
         case when x.case_id is not null and authz.can_view_case_metadata(x.case_id) then c.case_number end,
         x.since_at, x.until_at, x.target_id
    from (
      select 'CLEARANCE'::text as basis, me.clearance::text as code, null::uuid as case_id,
             null::timestamptz as since_at, null::timestamptz as until_at, 0 as ord, null::uuid as target_id
        from me
      union all
      select 'ROLE', a.role_code, null, a.effective_from::timestamptz, a.effective_to::timestamptz, 1, null
        from iam.user_role_assignment a, me
       where a.user_id = me.id and a.status = 'ACTIVE'
         and (a.effective_to is null or a.effective_to >= current_date)
      union all
      select 'ASSIGNMENT', a.assignment_role, a.case_id, a.assigned_at, null, 2, null
        from case_mgmt.case_assignment a, me
       where a.user_id = me.id and a.status = 'ACTIVE' and authz.can_view_case_metadata(a.case_id)
      union all
      select 'GRANT', g.scope, g.case_id, g.effective_from, g.effective_to, 3, null
        from case_mgmt.case_access_grant g, me
       where g.user_id = me.id and g.status = 'ACTIVE' and (g.effective_to is null or g.effective_to > now())
         and (g.scope in ('CASE', 'AUDIT') or (g.scope = 'TRIAGE' and authz.case_before_handover(g.case_id)))
         and authz.can_view_case_metadata(g.case_id)
      union all
      -- S3 (ADR-016 D2, path (a)): one row per kept form, coded '<form code>:<instance no>' so each form is told
      -- apart. The case is named only where the caller may see its metadata, as for every other row.
      select 'FORM_ACCESS', i.form_code || ':' || i.instance_no,
             case when authz.can_view_case_metadata(i.case_id) then i.case_id end, fa.created_at, null, 4, i.id
        from case_mgmt.form_instance_access fa
        join forms.form_instance i on i.id = fa.instance_id, me
       where fa.user_id = me.id and authz.can_view_form_instance(i.id)
      union all
      select 'TASK', t.task_type, t.case_id, t.access_granted_at, t.expires_at, 5, null
        from case_mgmt.case_task t, me
       where t.assigned_user_id = me.id and t.status in ('OPEN', 'IN_PROGRESS') and t.expires_at > now()
         and authz.can_view_case_metadata(t.case_id)
      union all
      select 'BREAK_GLASS', b.status, b.case_id, coalesce(b.decided_at, b.requested_at), b.access_expires_at, 6, null
        from case_mgmt.break_glass_access b, me
       where b.requested_by = me.id and b.status in ('REQUESTED', 'ACTIVE')
         and (b.access_expires_at is null or b.access_expires_at > now())
    ) x
    left join case_mgmt.case_record c on c.id = x.case_id
   order by x.ord, x.since_at nulls first, x.code;
$$;
grant execute on function api.my_access() to authenticated;

-- The case roster: from 1830, plus form-scoped access for those who manage the team.
create or replace function api.case_access_roster(p_case_id uuid)
returns table (
  user_id uuid,
  display_name text,
  display_name_ar text,
  relationship text,       -- ASSIGNMENT, GRANT or FORM_ACCESS (S3: a form kept from a COMMITTEE or REVIEW grant)
  code text,               -- the assignment role, the grant's purpose (TRIAGE, CASE, COMMITTEE, REVIEW), or for
                           -- FORM_ACCESS '<form code>:<instance no>'
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
    union all
    -- Form-scoped access (ADR-016 D2, path (a)) for those who manage the team: active while the form is in flight
    -- on an active case, ended when it is final or withdrawn. Its holder cannot open the case, so has no own row.
    select fa.user_id, 'FORM_ACCESS', i.form_code || ':' || i.instance_no, fa.created_at, null,
           case when fa_live.live then null else i.updated_at end,
           case when fa_live.live then 'ACTIVE' else 'ENDED' end
      from case_mgmt.form_instance_access fa
      join forms.form_instance i on i.id = fa.instance_id
      join forms.form_definition d on d.code = i.form_code
      join case_mgmt.case_record c on c.id = i.case_id
     cross join lateral (select i.status <> 'WITHDRAWN'
                                and i.status <> forms.terminal_status(d.review_required, d.approval_required)
                                and c.records_state = 'ACTIVE' as live) fa_live, me
     where fa.case_id = p_case_id and me.roster_full
  )
  select r.user_id, u.display_name, u.display_name_ar, r.relationship, r.code, r.since_at, r.until_at, r.ended_at,
         r.status, r.user_id = me.id
    from basis r
    join iam.user_profile u on u.id = r.user_id
   cross join me
   order by (r.status <> 'ACTIVE'), array_position(array['ASSIGNMENT', 'GRANT', 'FORM_ACCESS'], r.relationship),
            array_position(array['CASE_OWNER', 'LEAD_INVESTIGATOR', 'INVESTIGATOR', 'REVIEWER',
                                 'CASE', 'TRIAGE', 'COMMITTEE', 'REVIEW'], r.code),
            r.since_at, r.user_id;
$$;

-- -----------------------------------------------------------------------------
-- 6. Reconciliation (ADR-016 D2 evidence rule; D3 for residual TRIAGE grants)
-- -----------------------------------------------------------------------------
-- The report: one row per grant changed, with its before and after values and its audit event. Append-only.
create table case_mgmt.grant_scope_reconciliation (
  id                   uuid primary key default gen_random_uuid(),
  grant_id             uuid not null unique references case_mgmt.case_access_grant (id),
  case_id              uuid not null references case_mgmt.case_record (id),
  user_id              uuid not null references iam.user_profile (id),
  scope                text not null check (scope in ('TRIAGE', 'COMMITTEE', 'REVIEW')),
  before_status        text not null,
  before_effective_to  timestamptz,
  after_status         text not null,
  revoked_at           timestamptz not null,
  outcome              text not null check (outcome in ('ENDED', 'NARROWED_TO_FORM_INSTANCES')),
  form_instances_kept  int not null check (form_instances_kept >= 0),
  audit_event_id       uuid not null,  -- audit.audit_event.event_id; no FK, so the ledger keeps its own TRUNCATE guard
  reconciled_at        timestamptz not null default now(),
  check ((outcome = 'NARROWED_TO_FORM_INSTANCES') = (form_instances_kept > 0))
);
create index grant_scope_reconciliation_case on case_mgmt.grant_scope_reconciliation (case_id);
create index grant_scope_reconciliation_user on case_mgmt.grant_scope_reconciliation (user_id);
comment on table case_mgmt.grant_scope_reconciliation is
  'S3 reconciliation evidence (ADR-016 D2/D3): one row per over-purpose grant ended, with before/after values and its audit event. Append-only; no application role reads it.';

alter table case_mgmt.grant_scope_reconciliation enable row level security;
create trigger protect_no_update before update on case_mgmt.grant_scope_reconciliation
  for each row execute function records.reject_mutation();
create trigger protect_no_delete before delete on case_mgmt.grant_scope_reconciliation
  for each row execute function records.reject_mutation();
create trigger protect_no_truncate before truncate on case_mgmt.grant_scope_reconciliation
  for each statement execute function records.reject_mutation();

-- Ends every over-purpose grant still in effect or scheduled: TRIAGE on a case past hand-over, and every COMMITTEE
-- and REVIEW grant. A COMMITTEE or REVIEW holder first keeps each in-flight form instance of that case on an
-- active case that their roles may view and their clearance covers (path (a)). Idempotent: a second run finds
-- nothing. Owner-only (the migration below and the owner-level tests); no application role may execute it.
create function case_mgmt.reconcile_grant_scope()
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  g case_mgmt.case_access_grant;
  v_kept uuid[];
  v_outcome text;
  v_reason text;
  v_event uuid;
  v_n int := 0;
begin
  for g in
    select x.* from case_mgmt.case_access_grant x
     where x.status = 'ACTIVE' and (x.effective_to is null or x.effective_to > now())
       and (x.scope in ('COMMITTEE', 'REVIEW')
            or (x.scope = 'TRIAGE' and not authz.case_before_handover(x.case_id)))
     order by x.case_id, x.id
     for update
  loop
    v_kept := '{}';
    if g.scope in ('COMMITTEE', 'REVIEW') then
      with kept as (
        insert into case_mgmt.form_instance_access (instance_id, case_id, user_id, source_grant_id, source_scope)
        select i.id, i.case_id, g.user_id, g.id, g.scope
          from forms.form_instance i
          join forms.form_definition d on d.code = i.form_code
          join case_mgmt.case_record c on c.id = i.case_id
          join iam.user_profile u on u.id = g.user_id
         where i.case_id = g.case_id
           and i.status <> 'WITHDRAWN' and i.status <> forms.terminal_status(d.review_required, d.approval_required)
           and c.records_state = 'ACTIVE'
           and i.classification <= u.clearance
           and exists (select 1 from forms.form_entitlement e
                        where e.form_code = i.form_code and e.action = 'VIEW'
                          and authz.user_has_role(g.user_id, e.role_code))
         order by i.id
        on conflict (instance_id, user_id) do nothing
        returning instance_id
      )
      select coalesce(array_agg(k.instance_id order by k.instance_id), '{}') into v_kept from kept k;
    end if;
    v_outcome := case when cardinality(v_kept) > 0 then 'NARROWED_TO_FORM_INSTANCES' else 'ENDED' end;
    v_reason := case when g.scope = 'TRIAGE' then 'Grant scope: triage access ends at hand-over (DEC-03)'
                     else 'Grant scope: ' || g.scope || ' access is not a case-file grant (DEC-02)' end;
    v_event := case_mgmt.end_grant_internal(g.id, null, v_reason,
      jsonb_build_object('basis', 'GRANT_SCOPE_RECONCILIATION', 'outcome', v_outcome,
                         'form_instance_ids', to_jsonb(v_kept)), 'SYSTEM');
    insert into case_mgmt.grant_scope_reconciliation (
      grant_id, case_id, user_id, scope, before_status, before_effective_to, after_status, revoked_at, outcome,
      form_instances_kept, audit_event_id)
    select g.id, g.case_id, g.user_id, g.scope, g.status, g.effective_to, x.status, x.revoked_at, v_outcome,
           cardinality(v_kept), v_event
      from case_mgmt.case_access_grant x where x.id = g.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke all on function case_mgmt.reconcile_grant_scope(), case_mgmt.reject_non_case_file_grant() from public;

-- Run once, in this transaction, and prove the result: no over-purpose grant is left in effect, and the report
-- holds exactly one row per grant this run ended, each with its audit event.
do $$
declare
  v_n int;
  v_rows int;
begin
  v_n := case_mgmt.reconcile_grant_scope();
  if exists (select 1 from case_mgmt.case_access_grant g
              where g.status = 'ACTIVE' and (g.effective_to is null or g.effective_to > now())
                and (g.scope in ('COMMITTEE', 'REVIEW')
                     or (g.scope = 'TRIAGE' and not authz.case_before_handover(g.case_id)))) then
    raise exception 'grant scope reconciliation left an over-purpose grant in effect';
  end if;
  select count(*) into v_rows
    from case_mgmt.grant_scope_reconciliation r
    join audit.audit_event e on e.event_id = r.audit_event_id
   where e.action = 'CASE_ACCESS_REVOKED' and e.object_id = r.grant_id::text;
  if v_rows <> v_n then
    raise exception 'grant scope reconciliation report has % rows for % changed grants', v_rows, v_n;
  end if;
  raise notice 'grant scope reconciliation: % grant(s) ended, % form-scoped access row(s) kept',
    v_n, (select count(*) from case_mgmt.form_instance_access);
end;
$$;
