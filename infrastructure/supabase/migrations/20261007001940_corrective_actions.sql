-- =============================================================================
-- 1940 Corrective-action tracking (Business Architecture Rebase; CDF-203 under EPIC 12 CDF-17)
-- Requirements: §19, §29, §39, §65, §87; owner Q&A Q69, Q72, Q78–Q85; ADR-021, ADR-023, ADR-033
--
-- Additive only. In schema `decision`:
--   corrective_action_policy  effective-dated, per action type: default due period, reminder and escalation timing
--                             and the completion evidence asked for. SOURCE_REQUIRED: the seeded rows are empty
--                             placeholders (no default due period, no reminder, no escalation).
--   corrective_action         one action opened from a CORRECTIVE_ACTION or GOVERNANCE_REMEDIATION recommendation
--                             item the competent authority approved or modified: owner, due date and status
--                             OPEN → IN_PROGRESS → PENDING_VERIFICATION → COMPLETED (a return goes back to
--                             IN_PROGRESS; a completed action may be reopened), or WAIVED with the authority's
--                             source document. Never deleted.
--   corrective_action_event   append-only history: opening, owner and due-date changes, progress, completion,
--                             verification, return, reopening and waiver.
--
-- Controls:
--   * Traceable to the decision: an action is opened only from an item the effective authority decision approved or
--     modified (ADR-023); the item and the decision are fixed on the action.
--   * Purpose-bound owner (CDF-73 option D): the owner sees their own actions only, never the case, while they hold
--     CORRECTIVE_ACTION_OWN and pass the case gate (clearance, no conflict). Losing either removes the action.
--   * Restricted case (DEC-61/62 precedent): only the case's Restricted Case Authority names or changes the owner.
--   * Separation of duties: the owner reports and submits; someone else with CORRECTIVE_ACTION_MANAGE verifies.
--   * A waiver needs CORRECTIVE_ACTION_WAIVE (SOURCE_REQUIRED: granted to no role until the Delegation of Authority
--     names the holder) and the authority's source document (N15 pattern).
--   * A case does not close while an approved corrective item has an outstanding or missing action (EPIC 12).
--   * Overdue is derived from the due date. Reminders and escalation are queued only when a policy sets them.
-- Audit metadata carries ids, codes, dates and counts; notes and descriptions stay in the domain tables.
-- =============================================================================

-- OWNER_DEFAULT, SOURCE_REQUIRED (Delegation of Authority): who manages, owns, waives and sets the policy.
insert into iam.permission (code, description) values
  ('CORRECTIVE_ACTION_MANAGE', 'Open corrective actions from approved decisions, name owners, set due dates and verify completion'),
  ('CORRECTIVE_ACTION_OWN', 'Be named owner of a corrective action and report on it; never the case itself'),
  ('CORRECTIVE_ACTION_WAIVE', 'Record the competent authority''s waiver of a corrective action'),
  ('CORRECTIVE_ACTION_POLICY_ADMIN', 'Maintain corrective-action due periods, reminders, escalation and evidence policy');
insert into iam.role_permission (role_code, permission_code) values
  ('CASE_MANAGER', 'CORRECTIVE_ACTION_MANAGE'),
  ('GRC_DIRECTOR', 'CORRECTIVE_ACTION_MANAGE'), ('GRC_DIRECTOR', 'CORRECTIVE_ACTION_POLICY_ADMIN'),
  ('IMPLEMENTATION_OWNER', 'CORRECTIVE_ACTION_OWN');

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table decision.corrective_action_policy (
  id                   uuid primary key default gen_random_uuid(),
  action_type          text not null check (action_type in ('CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION')),
  -- Placeholders: null means not set. No default due period (the due date is always given), no reminder, no
  -- escalation beyond the overdue flag.
  default_due_days     int check (default_due_days between 1 and 730),
  reminder_days_before int check (reminder_days_before between 1 and 90),
  escalate_after_days  int check (escalate_after_days between 1 and 365),
  completion_evidence  text not null check (completion_evidence in ('REFERENCE_REQUIRED', 'NOTE_ONLY')),
  source_status        text not null check (source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  reason               text check (length(reason) between 5 and 2000),
  effective_from       timestamptz not null,
  effective_to         timestamptz,
  created_by           uuid references iam.user_profile (id),
  created_at           timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  check (created_by is not null or source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED'))
);
create unique index corrective_action_policy_open on decision.corrective_action_policy (action_type)
  where effective_to is null;
create index corrective_action_policy_type on decision.corrective_action_policy (action_type, effective_from);
create index corrective_action_policy_created_by on decision.corrective_action_policy (created_by);
comment on table decision.corrective_action_policy is
  'Corrective-action policy (ADR-033). Effective-dated. SOURCE_REQUIRED: seeded as empty placeholders.';
-- The strictest evidence setting stands in until the policy is sourced; nothing else is set.
insert into decision.corrective_action_policy (action_type, completion_evidence, source_status, reason, effective_from)
values
  ('CORRECTIVE_ACTION', 'REFERENCE_REQUIRED', 'SOURCE_REQUIRED', 'Placeholder until the policy is sourced (ADR-033)',
   '2026-01-01T00:00:00Z'),
  ('GOVERNANCE_REMEDIATION', 'REFERENCE_REQUIRED', 'SOURCE_REQUIRED', 'Placeholder until the policy is sourced (ADR-033)',
   '2026-01-01T00:00:00Z');

create table decision.corrective_action (
  id                      uuid primary key default gen_random_uuid(),
  case_id                 uuid not null references case_mgmt.case_record (id),
  recommendation_item_id  uuid not null references decision.recommendation_item (id),
  authority_decision_id   uuid not null references decision.authority_decision (id),
  action_type             text not null check (action_type in ('CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION')),
  sequence_no             int not null check (sequence_no >= 1),
  title                   text not null check (length(title) between 5 and 200),
  description             text not null check (length(description) between 10 and 4000),
  owner_id                uuid not null references iam.user_profile (id),
  due_date                date not null,
  status                  text not null default 'OPEN' check (status in (
                            'OPEN', 'IN_PROGRESS', 'PENDING_VERIFICATION', 'COMPLETED', 'WAIVED')),
  percent_complete        int not null default 0 check (percent_complete between 0 and 100),
  created_by              uuid not null references iam.user_profile (id),
  created_at              timestamptz not null default now(),
  completion_submitted_at timestamptz,
  completed_at            timestamptz,
  verified_by             uuid references iam.user_profile (id),
  waived_at               timestamptz,
  updated_at              timestamptz not null default now(),
  row_version             int not null default 1,
  unique (recommendation_item_id, sequence_no),
  check ((status = 'PENDING_VERIFICATION') = (completion_submitted_at is not null)),
  check ((status = 'COMPLETED') = (completed_at is not null)),
  check ((status = 'COMPLETED') = (verified_by is not null)),
  check ((status = 'WAIVED') = (waived_at is not null)),
  check (verified_by is null or verified_by <> owner_id)
);
create index corrective_action_case on decision.corrective_action (case_id, status);
create index corrective_action_owner on decision.corrective_action (owner_id, status);
create index corrective_action_decision on decision.corrective_action (authority_decision_id);
create index corrective_action_created_by on decision.corrective_action (created_by);
create index corrective_action_verified_by on decision.corrective_action (verified_by);
comment on table decision.corrective_action is
  'A corrective action opened from an approved decision (ADR-033, Q69, Q72). The description is seen by its owner.';

create table decision.corrective_action_event (
  id                        uuid primary key default gen_random_uuid(),
  action_id                 uuid not null references decision.corrective_action (id),
  case_id                   uuid not null references case_mgmt.case_record (id),
  event_type                text not null check (event_type in (
                              'OPENED', 'OWNER_CHANGED', 'DUE_DATE_CHANGED', 'PROGRESS', 'COMPLETION_SUBMITTED',
                              'VERIFIED', 'RETURNED', 'REOPENED', 'WAIVED')),
  actor_id                  uuid not null references iam.user_profile (id),
  note                      text check (length(note) between 5 and 4000),
  evidence_reference        text check (length(evidence_reference) between 3 and 300),
  percent_complete          int check (percent_complete between 0 and 100),
  owner_id                  uuid references iam.user_profile (id),
  due_date                  date,
  source_document_reference text check (length(source_document_reference) between 3 and 300),
  created_at                timestamptz not null default clock_timestamp(),
  check ((event_type in ('OPENED', 'OWNER_CHANGED')) = (owner_id is not null)),
  check ((event_type in ('OPENED', 'DUE_DATE_CHANGED')) = (due_date is not null)),
  check ((event_type = 'WAIVED') = (source_document_reference is not null)),
  check ((event_type = 'PROGRESS') = (percent_complete is not null))
);
create index corrective_action_event_action on decision.corrective_action_event (action_id, created_at);
create index corrective_action_event_case on decision.corrective_action_event (case_id);
create index corrective_action_event_actor on decision.corrective_action_event (actor_id);
create index corrective_action_event_owner on decision.corrective_action_event (owner_id);
comment on table decision.corrective_action_event is 'Corrective-action history (ADR-033). Append-only.';

do $$
declare t text;
begin
  execute 'create trigger no_update before update on decision.corrective_action_event for each row execute function committee.reject_mutation()';
  foreach t in array array['decision.corrective_action_policy', 'decision.corrective_action',
                           'decision.corrective_action_event'] loop
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;

-- An action keeps its origin and wording; a waived action is final. A policy version can only be given an end, once.
create function decision.protect_corrective_records()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_fixed text[] := array['id', 'case_id', 'recommendation_item_id', 'authority_decision_id', 'action_type',
                          'sequence_no', 'title', 'description', 'created_by', 'created_at'];
begin
  if tg_table_name = 'corrective_action' then
    if old.status = 'WAIVED'
       or (select jsonb_object_agg(k, to_jsonb(new) -> k) from unnest(v_fixed) k)
          <> (select jsonb_object_agg(k, to_jsonb(old) -> k) from unnest(v_fixed) k) then
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
create trigger corrective_action_protect before update on decision.corrective_action
  for each row execute function decision.protect_corrective_records();
create trigger corrective_action_policy_protect before update on decision.corrective_action_policy
  for each row execute function decision.protect_corrective_records();

-- -----------------------------------------------------------------------------
-- Authorization predicate
-- -----------------------------------------------------------------------------
-- The case team that can see the case, and the action's current owner while they hold CORRECTIVE_ACTION_OWN and
-- pass the case gate. The owner reaches the action and its history, never the case, item or decision rows.
create function authz.can_view_corrective_action(p_action_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from decision.corrective_action a
    where a.id = p_action_id
      and (authz.can_view_case(a.case_id)
           or (a.owner_id = authz.current_user_id() and authz.has_permission('CORRECTIVE_ACTION_OWN')
               and authz.user_case_gate(a.owner_id, a.case_id)))
  );
$$;
revoke all on function authz.can_view_corrective_action(uuid) from public, anon;
grant execute on function authz.can_view_corrective_action(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table decision.corrective_action_policy enable row level security;
alter table decision.corrective_action enable row level security;
alter table decision.corrective_action_event enable row level security;

create policy corrective_action_policy_read on decision.corrective_action_policy for select to authenticated
  using (authz.current_user_id() is not null);
grant select on decision.corrective_action_policy to authenticated;
create policy corrective_action_read on decision.corrective_action for select to authenticated
  using (authz.can_view_corrective_action(id));
grant select on decision.corrective_action to authenticated;
create policy corrective_action_event_read on decision.corrective_action_event for select to authenticated
  using (authz.can_view_corrective_action(action_id));
grant select on decision.corrective_action_event to authenticated;

-- -----------------------------------------------------------------------------
-- Internal helpers (revoked; run inside the definer commands)
-- -----------------------------------------------------------------------------
-- Today in Riyadh: due dates are calendar dates there.
create function decision.local_today()
returns date
language sql stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Riyadh')::date;
$$;

-- The effective authority decision that approved or modified an actionable item, or null (ADR-023).
create function decision.approving_decision(p_item_id uuid)
returns uuid
language sql stable
set search_path = ''
as $$
  select d.id
  from decision.recommendation_item i
  join decision.recommendation_package k on k.id = i.package_id and k.status = 'DECIDED'
  join decision.authority_decision d on d.package_id = k.id and d.package_round = k.round_no
  where i.id = p_item_id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
    and i.item_type in ('CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION')
    and (d.outcome = 'APPROVE_AS_RECOMMENDED'
         or (d.outcome in ('APPROVE_PARTIALLY', 'MODIFY')
             and exists (select 1 from decision.authority_item_decision x
                         where x.decision_id = d.id and x.item_id = i.id and x.outcome in ('APPROVED', 'MODIFIED'))));
$$;

-- The policy version in force for an action type.
create function decision.current_corrective_policy(p_action_type text)
returns decision.corrective_action_policy
language sql stable
set search_path = ''
as $$
  select p.* from decision.corrective_action_policy p
  where p.action_type = p_action_type and p.effective_from <= now() and (p.effective_to is null or p.effective_to > now())
  order by p.effective_from desc limit 1;
$$;

-- Who may own an action on a case: active, holds CORRECTIVE_ACTION_OWN, cleared for the case and not conflicted.
create function decision.owner_eligible(p_user_id uuid, p_case_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_user_id is not null and authz.user_has_permission(p_user_id, 'CORRECTIVE_ACTION_OWN')
         and authz.user_case_gate(p_user_id, p_case_id);
$$;

-- Who is told an action awaits verification or is overdue: managers who can see the case, never its owner.
create function decision.action_managers(p_action_id uuid)
returns table (user_id uuid)
language sql stable
set search_path = ''
as $$
  select u.id from decision.corrective_action a
  join iam.user_profile u on u.status = 'ACTIVE' and u.id <> a.owner_id
  where a.id = p_action_id and authz.user_has_permission(u.id, 'CORRECTIVE_ACTION_MANAGE')
    and authz.user_can_view_case(u.id, a.case_id);
$$;

-- Locks an action the caller can see.
create function decision.lock_action(p_action_id uuid)
returns decision.corrective_action
language plpgsql
set search_path = ''
as $$
declare v decision.corrective_action;
begin
  if p_action_id is null or not authz.can_view_corrective_action(p_action_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v from decision.corrective_action a where a.id = p_action_id for update;
  return v;
end;
$$;

-- A manager acting on a case: CORRECTIVE_ACTION_MANAGE and the case itself, not just the action.
create function decision.require_manager(p_case_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not authz.has_permission('CORRECTIVE_ACTION_MANAGE') or not authz.can_view_case(p_case_id) then
    perform api._fail('FORBIDDEN');
  end if;
end;
$$;

-- Naming an owner gives a new person the action. On a restricted case only its Restricted Case Authority does that.
create function decision.require_owner_naming(p_case_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare v_case case_mgmt.case_record;
begin
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id;
  if v_case.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
  if v_case.is_restricted
     and (v_case.owner_id is distinct from authz.current_user_id()
          or not authz.is_restricted_case_authority(authz.current_user_id(), v_case.classification)) then
    perform api._fail('CONFLICT', 'RESTRICTED_CASE_AUTHORITY_REQUIRED');
  end if;
end;
$$;

-- The current owner reporting on their own action, while still eligible.
create function decision.require_owner(p_action decision.corrective_action)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_action.owner_id <> authz.current_user_id() or not authz.has_permission('CORRECTIVE_ACTION_OWN')
     or not authz.user_case_gate(p_action.owner_id, p_action.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
end;
$$;

create function decision.record_action_event(
  p_action decision.corrective_action, p_event_type text, p_note text, p_evidence_reference text,
  p_percent_complete int, p_owner_id uuid, p_due_date date, p_source_document_reference text
)
returns void
language sql
set search_path = ''
as $$
  insert into decision.corrective_action_event (action_id, case_id, event_type, actor_id, note, evidence_reference,
                                                percent_complete, owner_id, due_date, source_document_reference)
  values (p_action.id, p_action.case_id, p_event_type, authz.current_user_id(), p_note, p_evidence_reference,
          p_percent_complete, p_owner_id, p_due_date, p_source_document_reference);
$$;

revoke all on function
  decision.protect_corrective_records(), decision.local_today(), decision.approving_decision(uuid),
  decision.current_corrective_policy(text), decision.owner_eligible(uuid, uuid), decision.action_managers(uuid),
  decision.lock_action(uuid), decision.require_manager(uuid), decision.require_owner_naming(uuid),
  decision.require_owner(decision.corrective_action),
  decision.record_action_event(decision.corrective_action, text, text, text, int, uuid, date, text)
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Case closure (EPIC 12): not while an approved corrective item has an outstanding or missing action
-- -----------------------------------------------------------------------------
create function decision.guard_case_closure()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from decision.corrective_action a
             where a.case_id = new.id and a.status not in ('COMPLETED', 'WAIVED'))
     or exists (select 1 from decision.recommendation_item i
                where i.case_id = new.id and decision.approving_decision(i.id) is not null
                  and not exists (select 1 from decision.corrective_action a where a.recommendation_item_id = i.id)) then
    perform api._fail('CONFLICT', 'CORRECTIVE_ACTIONS_OUTSTANDING');
  end if;
  return new;
end;
$$;
create trigger case_record_corrective_actions before update of records_state on case_mgmt.case_record
  for each row when (old.records_state = 'ACTIVE' and new.records_state = 'CLOSED')
  execute function decision.guard_case_closure();
revoke all on function decision.guard_case_closure() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Notifications (ADR-025): ids only; the action page re-authorizes
-- -----------------------------------------------------------------------------
alter table notify.template drop constraint template_object_type_check;
alter table notify.template add constraint template_object_type_check check (object_type in (
  'COMMITTEE', 'MEETING', 'MINUTES', 'LEGAL_REVIEW', 'DEFENCE_NOTICE', 'GRIEVANCE', 'EXPORT', 'CORRECTIVE_ACTION'));
alter table notify.outbox drop constraint outbox_object_type_check;
alter table notify.outbox add constraint outbox_object_type_check check (object_type in (
  'COMMITTEE', 'MEETING', 'MINUTES', 'LEGAL_REVIEW', 'DEFENCE_NOTICE', 'GRIEVANCE', 'EXPORT', 'CORRECTIVE_ACTION'));

insert into notify.template (code, object_type, is_mandatory, description) values
  ('CORRECTIVE_ACTION_ASSIGNED',  'CORRECTIVE_ACTION', true,  'The user was named owner of a corrective action'),
  ('CORRECTIVE_ACTION_RETURNED',  'CORRECTIVE_ACTION', true,  'The user''s corrective action was returned or reopened'),
  ('CORRECTIVE_ACTION_CHANGED',   'CORRECTIVE_ACTION', false, 'The due date of the user''s corrective action changed, or it was waived'),
  ('CORRECTIVE_ACTION_SUBMITTED', 'CORRECTIVE_ACTION', false, 'A corrective action awaits verification'),
  ('CORRECTIVE_ACTION_DUE',       'CORRECTIVE_ACTION', false, 'The user''s corrective action is due soon (policy reminder)'),
  ('CORRECTIVE_ACTION_OVERDUE',   'CORRECTIVE_ACTION', false, 'A corrective action is overdue (policy escalation)');
-- Same defaults as ADR-025 (SOURCE_REQUIRED): mandatory in app and by email; the others in app only.
insert into notify.rule (layer, template_code, channel, enabled, effective_from, reason)
select case when t.is_mandatory then 'SYSTEM_MANDATORY' else 'EVENT_RULE' end, t.code, c.channel,
       t.is_mandatory or c.channel = 'IN_APP', '2026-01-01T00:00:00Z',
       case when t.is_mandatory then 'Synthetic default: mandatory notice (ADR-025)'
            else 'Synthetic default: SOURCE_REQUIRED (ADR-025)' end
from notify.template t cross join (values ('IN_APP'), ('EMAIL')) c (channel)
where t.object_type = 'CORRECTIVE_ACTION';

create or replace function notify.deep_link(p_object_type text, p_object_id uuid)
returns text
language sql immutable
set search_path = ''
as $$
  select case p_object_type
           when 'COMMITTEE' then '/committees/' || p_object_id
           when 'MEETING' then '/meetings/' || p_object_id
           when 'MINUTES' then '/minutes/' || p_object_id
           when 'LEGAL_REVIEW' then '/legal-reviews/' || p_object_id
           when 'DEFENCE_NOTICE' then '/my-defence/' || p_object_id
           when 'GRIEVANCE' then '/grievances/' || p_object_id
           when 'EXPORT' then '/exports/' || p_object_id
           when 'CORRECTIVE_ACTION' then '/actions/' || p_object_id
         end;
$$;

-- Policy reminders and escalation join the scheduler's reminder run (cdf_bff only). Both need a policy value: the
-- seeded placeholders set none, so nothing is sent until the policy is sourced.
create or replace function notify.emit_due_reminders()
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_n int := 0;
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
  r record;
  v_user uuid;
begin
  for r in select n.id, l.user_id from grievance.defence_notice n
           join grievance.subject_portal_link l on l.subject_id = n.subject_id and l.revoked_at is null
           where n.status in ('ISSUED', 'ACKNOWLEDGED') and n.due_at > now() and n.due_at <= now() + interval '2 days'
             and not exists (select 1 from notify.outbox o where o.dedupe_key like 'defence-due:' || n.id || ':%') loop
    perform notify.enqueue('DEFENCE_DUE_REMINDER', r.user_id, r.id, null, 'defence-due:' || r.id);
    v_n := v_n + 1;
  end loop;
  -- Due soon: the owner, once per due date, while the owner may still see the action.
  for r in select a.id, a.owner_id, a.due_date from decision.corrective_action a
           cross join lateral decision.current_corrective_policy(a.action_type) p
           where a.status in ('OPEN', 'IN_PROGRESS') and p.reminder_days_before is not null
             and a.due_date >= v_today and a.due_date - p.reminder_days_before <= v_today
             and decision.owner_eligible(a.owner_id, a.case_id)
             and not exists (select 1 from notify.outbox o
                             where o.dedupe_key like 'action-due:' || a.id || ':' || a.due_date || ':%') loop
    perform notify.enqueue('CORRECTIVE_ACTION_DUE', r.owner_id, r.id, null, 'action-due:' || r.id || ':' || r.due_date);
    v_n := v_n + 1;
  end loop;
  -- Escalation: the owner and the managers who can see the case, once per due date.
  for r in select a.id, a.owner_id, a.case_id, a.due_date from decision.corrective_action a
           cross join lateral decision.current_corrective_policy(a.action_type) p
           where a.status in ('OPEN', 'IN_PROGRESS') and p.escalate_after_days is not null
             and v_today > a.due_date + p.escalate_after_days
             and not exists (select 1 from notify.outbox o
                             where o.dedupe_key like 'action-overdue:' || a.id || ':' || a.due_date || ':%') loop
    if decision.owner_eligible(r.owner_id, r.case_id) then
      perform notify.enqueue('CORRECTIVE_ACTION_OVERDUE', r.owner_id, r.id, null,
                             'action-overdue:' || r.id || ':' || r.due_date);
    end if;
    for v_user in select m.user_id from decision.action_managers(r.id) m loop
      perform notify.enqueue('CORRECTIVE_ACTION_OVERDUE', v_user, r.id, null,
                             'action-overdue:' || r.id || ':' || r.due_date);
    end loop;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function notify.emit_due_reminders() from public, anon, authenticated;
grant execute on function notify.emit_due_reminders() to cdf_bff;

-- -----------------------------------------------------------------------------
-- Policy administration
-- -----------------------------------------------------------------------------
create function api.set_corrective_action_policy(
  p_action_type text, p_default_due_days int, p_reminder_days_before int, p_escalate_after_days int,
  p_completion_evidence text, p_effective_from timestamptz, p_source_status text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_reason text;
begin
  if not authz.has_permission('CORRECTIVE_ACTION_POLICY_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_action_type is null or p_action_type not in ('CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION') then
    perform api._fail('INVALID', 'action_type');
  end if;
  if p_default_due_days is not null and p_default_due_days not between 1 and 730 then
    perform api._fail('INVALID', 'default_due_days');
  end if;
  if p_reminder_days_before is not null and p_reminder_days_before not between 1 and 90 then
    perform api._fail('INVALID', 'reminder_days_before');
  end if;
  if p_escalate_after_days is not null and p_escalate_after_days not between 1 and 365 then
    perform api._fail('INVALID', 'escalate_after_days');
  end if;
  if p_completion_evidence is null or p_completion_evidence not in ('REFERENCE_REQUIRED', 'NOTE_ONLY') then
    perform api._fail('INVALID', 'completion_evidence');
  end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform pg_advisory_xact_lock(hashtext('decision.corrective_action_policy:' || p_action_type));
  if exists (select 1 from decision.corrective_action_policy p
             where p.action_type = p_action_type and p.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'LATER_POLICY_EXISTS');
  end if;
  update decision.corrective_action_policy set effective_to = p_effective_from
   where action_type = p_action_type and effective_to is null;
  insert into decision.corrective_action_policy (action_type, default_due_days, reminder_days_before,
                                                 escalate_after_days, completion_evidence, source_status, reason,
                                                 effective_from, created_by)
  values (p_action_type, p_default_due_days, p_reminder_days_before, p_escalate_after_days, p_completion_evidence,
          p_source_status, v_reason, p_effective_from, v_actor)
  returning id into v_id;
  perform audit.record_event('CORRECTIVE_ACTION_POLICY_SET', 'ADMIN', 'SUCCESS', null, 'corrective_action_policy',
    v_id::text, v_reason,
    jsonb_build_object('action_type', p_action_type, 'default_due_days', p_default_due_days,
                       'reminder_days_before', p_reminder_days_before, 'escalate_after_days', p_escalate_after_days,
                       'completion_evidence', p_completion_evidence, 'effective_from', p_effective_from,
                       'source_status', p_source_status));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Managing actions (CORRECTIVE_ACTION_MANAGE, on the case)
-- -----------------------------------------------------------------------------
-- Opens an action from an item the authority approved or modified. The due date is given, or comes from the policy's
-- default due period when one is set (none is seeded).
create function api.open_corrective_action(
  p_item_id uuid, p_title text, p_description text, p_owner_id uuid, p_due_date date
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item decision.recommendation_item;
  v_decision uuid;
  v_policy decision.corrective_action_policy;
  v_due date;
  v_seq int;
  v decision.corrective_action;
begin
  select * into v_item from decision.recommendation_item i where i.id = p_item_id;
  if v_item.id is null or not authz.can_view_case(v_item.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform decision.require_manager(v_item.case_id);
  v_decision := decision.approving_decision(v_item.id);
  if v_decision is null then perform api._fail('CONFLICT', 'ITEM_NOT_APPROVED'); end if;
  perform decision.require_owner_naming(v_item.case_id);
  if not decision.owner_eligible(p_owner_id, v_item.case_id) then perform api._fail('INVALID', 'owner_id'); end if;
  v_policy := decision.current_corrective_policy(v_item.item_type);
  v_due := coalesce(p_due_date, decision.local_today() + v_policy.default_due_days);
  if v_due is null or v_due < decision.local_today() then perform api._fail('INVALID', 'due_date'); end if;
  perform pg_advisory_xact_lock(hashtext('decision.corrective_action:' || v_item.id));
  select coalesce(max(a.sequence_no), 0) + 1 into v_seq from decision.corrective_action a
   where a.recommendation_item_id = v_item.id;
  insert into decision.corrective_action (case_id, recommendation_item_id, authority_decision_id, action_type,
                                          sequence_no, title, description, owner_id, due_date, created_by)
  values (v_item.case_id, v_item.id, v_decision, v_item.item_type, v_seq,
          api._require_text(p_title, 'title', 5, 200), api._require_text(p_description, 'description', 10, 4000),
          p_owner_id, v_due, v_actor)
  returning * into v;
  perform decision.record_action_event(v, 'OPENED', null, null, null, p_owner_id, v_due, null);
  perform notify.enqueue('CORRECTIVE_ACTION_ASSIGNED', p_owner_id, v.id, null, 'action-assigned:' || v.id || ':' || v_seq || ':0');
  perform audit.record_event('CORRECTIVE_ACTION_OPENED', 'BUSINESS', 'SUCCESS', v.case_id, 'corrective_action',
    v.id::text, null,
    jsonb_build_object('recommendation_item_id', v_item.id, 'authority_decision_id', v_decision,
                       'action_type', v_item.item_type, 'sequence_no', v_seq, 'owner_id', p_owner_id,
                       'due_date', v_due, 'due_date_from_policy', p_due_date is null));
  return v.id;
end;
$$;

create function api.assign_corrective_action_owner(p_action_id uuid, p_owner_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v decision.corrective_action;
  v_reason text;
begin
  v := decision.lock_action(p_action_id);
  perform decision.require_manager(v.case_id);
  if v.status not in ('OPEN', 'IN_PROGRESS') then perform api._fail('CONFLICT', 'ACTION_NOT_ACTIVE'); end if;
  perform decision.require_owner_naming(v.case_id);
  if p_owner_id = v.owner_id then perform api._fail('CONFLICT', 'SAME_OWNER'); end if;
  if not decision.owner_eligible(p_owner_id, v.case_id) then perform api._fail('INVALID', 'owner_id'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update decision.corrective_action
     set owner_id = p_owner_id, updated_at = now(), row_version = row_version + 1
   where id = v.id
  returning * into v;
  perform decision.record_action_event(v, 'OWNER_CHANGED', v_reason, null, null, p_owner_id, null, null);
  perform notify.enqueue('CORRECTIVE_ACTION_ASSIGNED', p_owner_id, v.id, null,
                         'action-assigned:' || v.id || ':' || v.row_version);
  perform audit.record_event('CORRECTIVE_ACTION_OWNER_CHANGED', 'BUSINESS', 'SUCCESS', v.case_id, 'corrective_action',
    v.id::text, v_reason, jsonb_build_object('owner_id', p_owner_id));
end;
$$;

create function api.change_corrective_action_due_date(p_action_id uuid, p_due_date date, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v decision.corrective_action;
  v_old date;
  v_reason text;
begin
  v := decision.lock_action(p_action_id);
  perform decision.require_manager(v.case_id);
  if v.status not in ('OPEN', 'IN_PROGRESS', 'PENDING_VERIFICATION') then
    perform api._fail('CONFLICT', 'ACTION_NOT_ACTIVE');
  end if;
  if p_due_date is null or p_due_date < decision.local_today() or p_due_date = v.due_date then
    perform api._fail('INVALID', 'due_date');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  v_old := v.due_date;
  update decision.corrective_action
     set due_date = p_due_date, updated_at = now(), row_version = row_version + 1
   where id = v.id
  returning * into v;
  perform decision.record_action_event(v, 'DUE_DATE_CHANGED', v_reason, null, null, null, p_due_date, null);
  -- Notices reach the owner only while they can still open the action (AGENT-09 L1).
  if decision.owner_eligible(v.owner_id, v.case_id) then
    perform notify.enqueue('CORRECTIVE_ACTION_CHANGED', v.owner_id, v.id, null, 'action-changed:' || v.id || ':' || v.row_version);
  end if;
  perform audit.record_event('CORRECTIVE_ACTION_DUE_DATE_CHANGED', 'BUSINESS', 'SUCCESS', v.case_id, 'corrective_action',
    v.id::text, v_reason, jsonb_build_object('previous_due_date', v_old, 'due_date', p_due_date));
end;
$$;

-- -----------------------------------------------------------------------------
-- Reporting (the owner)
-- -----------------------------------------------------------------------------
create function api.record_corrective_action_progress(p_action_id uuid, p_percent_complete int, p_note text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v decision.corrective_action;
  v_note text;
begin
  v := decision.lock_action(p_action_id);
  perform decision.require_owner(v);
  if v.status not in ('OPEN', 'IN_PROGRESS') then perform api._fail('CONFLICT', 'ACTION_NOT_ACTIVE'); end if;
  if p_percent_complete is null or p_percent_complete not between 0 and 100 then
    perform api._fail('INVALID', 'percent_complete');
  end if;
  v_note := api._require_text(p_note, 'note', 5, 4000);
  update decision.corrective_action
     set status = 'IN_PROGRESS', percent_complete = p_percent_complete, updated_at = now(), row_version = row_version + 1
   where id = v.id
  returning * into v;
  perform decision.record_action_event(v, 'PROGRESS', v_note, null, p_percent_complete, null, null, null);
  perform audit.record_event('CORRECTIVE_ACTION_PROGRESS_RECORDED', 'BUSINESS', 'SUCCESS', v.case_id,
    'corrective_action', v.id::text, null, jsonb_build_object('percent_complete', p_percent_complete));
end;
$$;

-- Completion with the evidence the policy asks for: a document or system reference (evidence files wait for UX S2).
create function api.submit_corrective_action_completion(p_action_id uuid, p_note text, p_evidence_reference text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v decision.corrective_action;
  v_policy decision.corrective_action_policy;
  v_note text;
  v_reference text;
  v_user uuid;
begin
  v := decision.lock_action(p_action_id);
  perform decision.require_owner(v);
  if v.status not in ('OPEN', 'IN_PROGRESS') then perform api._fail('CONFLICT', 'ACTION_NOT_ACTIVE'); end if;
  v_policy := decision.current_corrective_policy(v.action_type);
  v_note := api._require_text(p_note, 'note', 5, 4000);
  if nullif(btrim(coalesce(p_evidence_reference, '')), '') is not null then
    v_reference := api._require_text(p_evidence_reference, 'evidence_reference', 3, 300);
  elsif v_policy.completion_evidence is distinct from 'NOTE_ONLY' then
    perform api._fail('INVALID', 'evidence_reference');
  end if;
  update decision.corrective_action
     set status = 'PENDING_VERIFICATION', percent_complete = 100, completion_submitted_at = now(), updated_at = now(),
         row_version = row_version + 1
   where id = v.id
  returning * into v;
  perform decision.record_action_event(v, 'COMPLETION_SUBMITTED', v_note, v_reference, null, null, null, null);
  for v_user in select m.user_id from decision.action_managers(v.id) m loop
    perform notify.enqueue('CORRECTIVE_ACTION_SUBMITTED', v_user, v.id, null, 'action-submitted:' || v.id || ':' || v.row_version);
  end loop;
  perform audit.record_event('CORRECTIVE_ACTION_COMPLETION_SUBMITTED', 'BUSINESS', 'SUCCESS', v.case_id,
    'corrective_action', v.id::text, null,
    jsonb_build_object('has_evidence_reference', v_reference is not null,
                       'completion_evidence', v_policy.completion_evidence));
end;
$$;

-- -----------------------------------------------------------------------------
-- Verification, reopening and waiver
-- -----------------------------------------------------------------------------
-- Someone other than the owner who submitted it verifies the completion or returns it with a note.
create function api.verify_corrective_action(p_action_id uuid, p_decision text, p_note text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v decision.corrective_action;
  v_note text;
begin
  v := decision.lock_action(p_action_id);
  perform decision.require_manager(v.case_id);
  if v.status <> 'PENDING_VERIFICATION' then perform api._fail('CONFLICT', 'NOT_PENDING_VERIFICATION'); end if;
  if v.owner_id = v_actor
     or exists (select 1 from decision.corrective_action_event e
                where e.action_id = v.id and e.event_type = 'COMPLETION_SUBMITTED' and e.actor_id = v_actor) then
    perform api._fail('FORBIDDEN');
  end if;
  if p_decision is null or p_decision not in ('VERIFIED', 'RETURNED') then perform api._fail('INVALID', 'decision'); end if;
  if p_decision = 'RETURNED' or nullif(btrim(coalesce(p_note, '')), '') is not null then
    v_note := api._require_text(p_note, 'note', 5, 4000);
  end if;
  if p_decision = 'VERIFIED' then
    update decision.corrective_action
       set status = 'COMPLETED', completion_submitted_at = null, completed_at = now(), verified_by = v_actor,
           updated_at = now(), row_version = row_version + 1
     where id = v.id
    returning * into v;
  else
    update decision.corrective_action
       set status = 'IN_PROGRESS', completion_submitted_at = null, updated_at = now(), row_version = row_version + 1
     where id = v.id
    returning * into v;
    if decision.owner_eligible(v.owner_id, v.case_id) then
      perform notify.enqueue('CORRECTIVE_ACTION_RETURNED', v.owner_id, v.id, null, 'action-returned:' || v.id || ':' || v.row_version);
    end if;
  end if;
  perform decision.record_action_event(v, p_decision, v_note, null, null, null, null, null);
  perform audit.record_event(case p_decision when 'VERIFIED' then 'CORRECTIVE_ACTION_VERIFIED'
                                             else 'CORRECTIVE_ACTION_RETURNED' end,
    'BUSINESS', 'SUCCESS', v.case_id, 'corrective_action', v.id::text, null,
    jsonb_build_object('status', v.status));
  return v.status;
end;
$$;

-- A completed action whose effect was not achieved goes back to its owner (re-execution).
create function api.reopen_corrective_action(p_action_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v decision.corrective_action;
  v_reason text;
begin
  v := decision.lock_action(p_action_id);
  perform decision.require_manager(v.case_id);
  if v.status <> 'COMPLETED' then perform api._fail('CONFLICT', 'NOT_COMPLETED'); end if;
  if (select c.records_state from case_mgmt.case_record c where c.id = v.case_id) <> 'ACTIVE' then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update decision.corrective_action
     set status = 'IN_PROGRESS', completed_at = null, verified_by = null, updated_at = now(),
         row_version = row_version + 1
   where id = v.id
  returning * into v;
  perform decision.record_action_event(v, 'REOPENED', v_reason, null, null, null, null, null);
  if decision.owner_eligible(v.owner_id, v.case_id) then
    perform notify.enqueue('CORRECTIVE_ACTION_RETURNED', v.owner_id, v.id, null, 'action-returned:' || v.id || ':' || v.row_version);
  end if;
  perform audit.record_event('CORRECTIVE_ACTION_REOPENED', 'BUSINESS', 'SUCCESS', v.case_id, 'corrective_action',
    v.id::text, v_reason, '{}'::jsonb);
end;
$$;

-- The competent authority's waiver, recorded with its source document (N15 pattern). Final.
create function api.waive_corrective_action(p_action_id uuid, p_source_document_reference text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v decision.corrective_action;
  v_reference text;
  v_reason text;
begin
  v := decision.lock_action(p_action_id);
  if not authz.has_permission('CORRECTIVE_ACTION_WAIVE') or not authz.can_view_case(v.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  if v.status in ('COMPLETED', 'WAIVED') then perform api._fail('CONFLICT', 'ACTION_CLOSED'); end if;
  if (select c.records_state from case_mgmt.case_record c where c.id = v.case_id) <> 'ACTIVE' then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  v_reference := api._require_text(p_source_document_reference, 'source_document_reference', 3, 300);
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update decision.corrective_action
     set status = 'WAIVED', completion_submitted_at = null, waived_at = now(), updated_at = now(),
         row_version = row_version + 1
   where id = v.id
  returning * into v;
  perform decision.record_action_event(v, 'WAIVED', v_reason, null, null, null, null, v_reference);
  if decision.owner_eligible(v.owner_id, v.case_id) then
    perform notify.enqueue('CORRECTIVE_ACTION_CHANGED', v.owner_id, v.id, null, 'action-changed:' || v.id || ':' || v.row_version);
  end if;
  perform audit.record_event('CORRECTIVE_ACTION_WAIVED', 'BUSINESS', 'SUCCESS', v.case_id, 'corrective_action',
    v.id::text, v_reason, jsonb_build_object('source_document_reference', v_reference));
end;
$$;

grant execute on function
  api.set_corrective_action_policy(text, int, int, int, text, timestamptz, text, text),
  api.open_corrective_action(uuid, text, text, uuid, date),
  api.assign_corrective_action_owner(uuid, uuid, text),
  api.change_corrective_action_due_date(uuid, date, text),
  api.record_corrective_action_progress(uuid, int, text),
  api.submit_corrective_action_completion(uuid, text, text),
  api.verify_corrective_action(uuid, text, text),
  api.reopen_corrective_action(uuid, text),
  api.waive_corrective_action(uuid, text, text)
to authenticated;
