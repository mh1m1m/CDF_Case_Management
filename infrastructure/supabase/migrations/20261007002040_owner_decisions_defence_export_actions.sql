-- =============================================================================
-- 2040 Owner Finalization Set, part 2: employee notices, defence, grievances, sanction execution guards, corrective
-- actions, export, continuity workbook, catalogue governance and referral escalation (CDF-196)
-- HEADER_PLACEHOLDER
-- =============================================================================

-- =============================================================================
-- Item 1. Decision-notice delivery and the grievance window (DEC-F15, AMB-137, CON-002; T-AMB-081)
-- =============================================================================
alter table grievance.defence_notice
  add column window_start_basis text check (window_start_basis in ('ISSUE', 'DELIVERY', 'ACKNOWLEDGEMENT')),
  add column grievance_window_starts_at timestamptz,
  add column delivered_at timestamptz,
  add column delivery_method text check (delivery_method in ('HAND_DELIVERY', 'EMAIL', 'REGISTERED_MAIL', 'EMPLOYEE_PORTAL',
                                                             'OTHER_AUTHORIZED_CHANNEL')),
  add column delivery_reference text check (length(delivery_reference) between 3 and 300),
  add column delivery_recorded_by uuid references iam.user_profile (id),
  add column delivery_recorded_at timestamptz,
  add column suspended_at timestamptz;
create index defence_notice_delivery_recorded_by on grievance.defence_notice (delivery_recorded_by);

alter table grievance.defence_notice
  add constraint defence_notice_delivery_complete check (
    (delivered_at is null) = (delivery_method is null) and (delivered_at is null) = (delivery_reference is null)
    and (delivered_at is null) = (delivery_recorded_by is null) and (delivered_at is null) = (delivery_recorded_at is null)),
  add constraint defence_notice_delivered_after_issue check (delivered_at >= issued_at),
  add constraint defence_notice_window_starts_after_issue check (grievance_window_starts_at >= issued_at),
  add constraint defence_notice_suspended_by_kind check (suspended_at is null or kind = 'DEFENCE');

-- Widened under the same name: a DECISION notice issued from 2040 records how its window starts; on the DELIVERY or
-- ACKNOWLEDGEMENT basis the window has no start or end until that event. A notice issued before 2040 (no basis) keeps
-- the 1990 shape, its window ending at issue + days. Every other kind has no window.
alter table grievance.defence_notice drop constraint defence_notice_decision_window;
alter table grievance.defence_notice add constraint defence_notice_decision_window check (
  (kind = 'DECISION') = (authority_decision_id is not null)
  and (kind = 'DECISION') = (grievance_rule_set_id is not null)
  and (kind = 'DECISION') = (grievance_window_days is not null)
  and (kind = 'DECISION'
       or (window_start_basis is null and grievance_window_starts_at is null and grievance_window_ends_at is null))
  and (window_start_basis is not null or (kind = 'DECISION') = (grievance_window_ends_at is not null))
  and (window_start_basis is null or (grievance_window_starts_at is null) = (grievance_window_ends_at is null))
  and (window_start_basis is distinct from 'ISSUE' or grievance_window_starts_at = issued_at));

comment on column grievance.defence_notice.window_start_basis is
  'DECISION notices from 2040: the start of the grievance window, snapshotted from the Grievance Committee rule set at '
  'issue (DEC-F15, DEC-F16). ISSUE when that version names none (pre-2030). Null on notices issued before 2040, whose '
  'window started at issue.';
comment on column grievance.defence_notice.delivered_at is
  'When the notice was formally delivered to the subject, recorded once by the issuer side with the method and a '
  'reference (DEC-F15). On the DELIVERY basis the grievance window starts here.';

-- Issue: the window is snapshotted with its basis; on ISSUE it starts now, otherwise it waits for the event.
-- Replaced from 1990: the window start follows the basis instead of always starting at issue.
create or replace function grievance.insert_notice(p_kind text, p_s case_mgmt.case_subject, p_notice_text text,
                                                   p_allegation_ids uuid[], p_decision_id uuid, p_rule committee.rule_set,
                                                   p_actor uuid)
returns grievance.defence_notice
language plpgsql
set search_path = ''
as $$
declare
  v_allegations uuid[] := coalesce(p_allegation_ids, '{}');
  v_basis text := case when p_rule.id is not null then coalesce(p_rule.grievance_window_start_basis, 'ISSUE') end;
  v grievance.defence_notice;
begin
  if (select count(distinct x) from unnest(v_allegations) x) <> cardinality(v_allegations)
     or exists (select 1 from unnest(v_allegations) x
                where not exists (select 1 from case_mgmt.allegation a
                                  where a.id = x and a.case_id = p_s.case_id and a.subject_id = p_s.id)) then
    perform api._fail('INVALID', 'allegation_ids');
  end if;
  insert into grievance.defence_notice (case_id, subject_id, sequence_no, notice_text, due_at, issued_by, kind,
                                        authority_decision_id, grievance_rule_set_id, grievance_window_days,
                                        window_start_basis, grievance_window_starts_at, grievance_window_ends_at)
  values (p_s.case_id, p_s.id,
          (select coalesce(max(n.sequence_no), 0) + 1 from grievance.defence_notice n where n.subject_id = p_s.id),
          api._require_text(p_notice_text, 'notice_text', 10, 4000), null, p_actor, p_kind, p_decision_id,
          p_rule.id, p_rule.grievance_window_days, v_basis,
          case when v_basis = 'ISSUE' then now() end,
          case when v_basis = 'ISSUE' then now() + make_interval(days => p_rule.grievance_window_days) end)
  returning * into v;
  insert into grievance.defence_notice_item (notice_id, position, allegation_id, snapshot)
  select v.id, row_number() over (order by a.created_at, a.id), a.id,
         jsonb_build_object('category', a.category, 'description', a.description,
                            'policy_reference', a.policy_reference, 'law_reference', a.law_reference)
  from case_mgmt.allegation a where a.id = any (v_allegations);
  return v;
end;
$$;

-- The window starts from the event its basis names, once: delivery or acknowledgement. Fires before
-- defence_notice_protect (triggers fire in name order).
create function grievance.start_decision_window()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'DECISION' and old.grievance_window_starts_at is null and new.grievance_window_starts_at is null then
    if new.window_start_basis = 'DELIVERY' and new.delivered_at is not null then
      new.grievance_window_starts_at := new.delivered_at;
    elsif new.window_start_basis = 'ACKNOWLEDGEMENT' and new.acknowledged_at is not null then
      new.grievance_window_starts_at := new.acknowledged_at;
    end if;
    if new.grievance_window_starts_at is not null then
      new.grievance_window_ends_at := new.grievance_window_starts_at + make_interval(days => new.grievance_window_days);
    end if;
  end if;
  return new;
end;
$$;
create trigger defence_notice_a_window before update on grievance.defence_notice
  for each row execute function grievance.start_decision_window();

-- Item 4 (DEC-F18, AMB-152): due-date changes of a defence notice are append-only events; the original date stays in
-- the first event's previous_due_at (T-AMB-091). Created here because the notice's protection reads it.
create table grievance.defence_deadline_change (
  id              uuid primary key default gen_random_uuid(),
  notice_id       uuid not null references grievance.defence_notice (id),
  case_id         uuid not null references case_mgmt.case_record (id),
  sequence_no     int not null check (sequence_no >= 1),
  change_kind     text not null check (change_kind in ('EXTENSION', 'SUSPENSION', 'RESUMPTION', 'RESCHEDULE')),
  previous_due_at timestamptz not null,
  new_due_at      timestamptz,
  reason          text not null check (length(reason) between 10 and 2000),
  decided_by      uuid not null references iam.user_profile (id),
  decided_at      timestamptz not null default now(),
  unique (notice_id, sequence_no),
  check ((change_kind = 'SUSPENSION') = (new_due_at is null)),
  check (change_kind <> 'EXTENSION' or new_due_at > previous_due_at)
);
create index defence_deadline_change_case on grievance.defence_deadline_change (case_id);
create index defence_deadline_change_decided_by on grievance.defence_deadline_change (decided_by);
comment on table grievance.defence_deadline_change is
  'Extensions, suspensions, resumptions and reschedulings of a defence notice''s due date, with the reason (DEC-F18, '
  'AMB-152, migration 2040). Append-only; the first previous_due_at is the original date.';
create trigger no_update before update on grievance.defence_deadline_change
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on grievance.defence_deadline_change
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on grievance.defence_deadline_change
  for each statement execute function committee.reject_mutation();
alter table grievance.defence_deadline_change enable row level security;
create policy defence_deadline_change_read on grievance.defence_deadline_change for select to authenticated
  using (authz.can_view_case(case_id));
grant select on grievance.defence_deadline_change to authenticated;

-- Replaced from 1910/1990: a notice may now also take its delivery (once, all fields together), its window start
-- (only the derived values, once), and a due date or suspension change that matches the latest append-only deadline
-- change. Everything else is unchanged; closed notices stay frozen; the other tables' branches are as before.
create or replace function grievance.protect_records()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_free constant text[] := array['status', 'acknowledged_at', 'closed_at', 'delivered_at', 'delivery_method',
                                  'delivery_reference', 'delivery_recorded_by', 'delivery_recorded_at',
                                  'grievance_window_starts_at', 'grievance_window_ends_at', 'due_at', 'suspended_at'];
  v_change grievance.defence_deadline_change;
begin
  if tg_table_name = 'subject_portal_link' then
    if old.revoked_at is not null
       or (to_jsonb(new) - array['revoked_by', 'revoked_at']) <> (to_jsonb(old) - array['revoked_by', 'revoked_at']) then
      raise exception 'portal link % can only be revoked, once', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'defence_notice' then
    if old.status in ('RESPONDED', 'WITHDRAWN')
       or (to_jsonb(new) - v_free) <> (to_jsonb(old) - v_free)
       or (old.delivered_at is not null
           and (new.delivered_at, new.delivery_method, new.delivery_reference, new.delivery_recorded_by,
                new.delivery_recorded_at)
               is distinct from (old.delivered_at, old.delivery_method, old.delivery_reference, old.delivery_recorded_by,
                                 old.delivery_recorded_at))
       or ((new.grievance_window_starts_at, new.grievance_window_ends_at)
             is distinct from (old.grievance_window_starts_at, old.grievance_window_ends_at)
           and not (old.window_start_basis in ('DELIVERY', 'ACKNOWLEDGEMENT') and old.grievance_window_starts_at is null
                    and new.grievance_window_starts_at is not null
                    and new.grievance_window_starts_at = case old.window_start_basis when 'DELIVERY' then new.delivered_at
                                                                                     else new.acknowledged_at end
                    and new.grievance_window_ends_at
                        = new.grievance_window_starts_at + make_interval(days => old.grievance_window_days))) then
      raise exception 'defence notice % is closed or its content is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
    if (new.due_at, new.suspended_at) is distinct from (old.due_at, old.suspended_at) then
      select c.* into v_change from grievance.defence_deadline_change c where c.notice_id = old.id
      order by c.sequence_no desc limit 1;
      if v_change.id is null or v_change.previous_due_at is distinct from old.due_at
         or new.due_at is distinct from coalesce(v_change.new_due_at, v_change.previous_due_at)
         or (new.suspended_at is not null) <> (v_change.change_kind = 'SUSPENSION')
         or (v_change.change_kind = 'SUSPENSION') = (old.suspended_at is not null)
            and v_change.change_kind in ('SUSPENSION', 'RESUMPTION') then
        raise exception 'defence notice % due date changes only through a recorded deadline change', old.id
          using errcode = 'insufficient_privilege';
      end if;
    end if;
  elsif tg_table_name = 'restricted_grievance_approval' then
    if old.grievance_id is not null
       or (to_jsonb(new) - array['grievance_id', 'used_at']) <> (to_jsonb(old) - array['grievance_id', 'used_at']) then
      raise exception 'approval % can only be used, once', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'grievance' then
    if old.status in ('INADMISSIBLE', 'DECIDED', 'WITHDRAWN')
       or (to_jsonb(new) - array['status', 'committee_proceeding_id', 'updated_at', 'row_version'])
          <> (to_jsonb(old) - array['status', 'committee_proceeding_id', 'updated_at', 'row_version'])
       or (old.committee_proceeding_id is not null and new.committee_proceeding_id is distinct from old.committee_proceeding_id) then
      raise exception 'grievance % is closed or its record is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Item 7. A failed mandatory employee notice creates a delivery task for the issuer (AMB-175; T-AMB-103). The table
-- is created here because recording a delivery closes the open tasks.
-- -----------------------------------------------------------------------------
create table grievance.notice_delivery_task (
  id          uuid primary key default gen_random_uuid(),
  notice_id   uuid not null references grievance.defence_notice (id),
  case_id     uuid not null references case_mgmt.case_record (id),
  outbox_id   uuid not null unique references notify.outbox (id),
  assigned_to uuid not null references iam.user_profile (id),
  status      text not null default 'OPEN' check (status in ('OPEN', 'DONE')),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz,
  closed_by   uuid references iam.user_profile (id),
  check ((status = 'DONE') = (closed_at is not null)),
  check ((closed_at is null) = (closed_by is null))
);
create index notice_delivery_task_notice on grievance.notice_delivery_task (notice_id);
create index notice_delivery_task_case on grievance.notice_delivery_task (case_id);
create index notice_delivery_task_assigned_to on grievance.notice_delivery_task (assigned_to);
create index notice_delivery_task_closed_by on grievance.notice_delivery_task (closed_by);
comment on table grievance.notice_delivery_task is
  'A mandatory employee notice whose email failed: the issuer delivers it another way and records the delivery '
  '(AMB-175, migration 2040). Ids only; closed by api.record_notice_delivery.';

create function grievance.protect_delivery_task()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'OPEN' or new.status <> 'DONE'
     or (to_jsonb(new) - array['status', 'closed_at', 'closed_by']) <> (to_jsonb(old) - array['status', 'closed_at', 'closed_by']) then
    raise exception 'delivery task % is closed once and never rewritten', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger notice_delivery_task_protect before update on grievance.notice_delivery_task
  for each row execute function grievance.protect_delivery_task();
create trigger no_delete before delete on grievance.notice_delivery_task
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on grievance.notice_delivery_task
  for each statement execute function committee.reject_mutation();

alter table grievance.notice_delivery_task enable row level security;
create policy notice_delivery_task_read on grievance.notice_delivery_task for select to authenticated
  using (authz.can_view_case(case_id));
grant select on grievance.notice_delivery_task to authenticated;

-- The outbox marks an email FAILED after its last attempt (1920). For a mandatory employee notice the issuer gets a
-- task, once per failed message. The event names the notice and the task only.
create function notify.on_notice_email_failed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n grievance.defence_notice;
  v_task uuid;
begin
  if new.channel = 'EMAIL' and new.status = 'FAILED' and old.status is distinct from 'FAILED'
     and new.template_code in ('DEFENCE_NOTICE_ISSUED', 'RIGHTS_NOTICE_ISSUED', 'DECISION_NOTICE_ISSUED') then
    select * into v_n from grievance.defence_notice n where n.id = new.object_id;
    if v_n.id is not null and v_n.delivered_at is null and v_n.status not in ('RESPONDED', 'WITHDRAWN') then
      insert into grievance.notice_delivery_task (notice_id, case_id, outbox_id, assigned_to)
      values (v_n.id, v_n.case_id, new.id, v_n.issued_by)
      on conflict (outbox_id) do nothing
      returning id into v_task;
      if v_task is not null then
        perform audit.record_event('NOTICE_DELIVERY_TASK_CREATED', 'BUSINESS', 'SUCCESS', v_n.case_id, 'defence_notice',
          v_n.id::text, null, jsonb_build_object('task_id', v_task, 'outbox_id', new.id, 'kind', v_n.kind,
                                                 'assigned_to', v_n.issued_by), 'SYSTEM');
      end if;
    end if;
  end if;
  return null;
end;
$$;
create trigger outbox_notice_email_failed after update on notify.outbox
  for each row execute function notify.on_notice_email_failed();

-- The issuer side records the delivery of any employee notice, once; on a DECISION notice on the DELIVERY basis the
-- grievance window starts at the delivery. Returns the window end (null when no window runs).
create function api.record_notice_delivery(p_notice_id uuid, p_method text, p_delivered_at timestamptz,
                                           p_reference text)
returns timestamptz
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_n grievance.defence_notice;
  v_reference text;
  v_tasks int;
begin
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id;
  if v_n.id is null or not authz.can_view_case(v_n.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform grievance.lock_notice_subject(v_n.subject_id);
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id for update;
  if v_n.status in ('RESPONDED', 'WITHDRAWN') then perform api._fail('CONFLICT', 'NOTICE_NOT_OPEN'); end if;
  if v_n.delivered_at is not null then perform api._fail('CONFLICT', 'ALREADY_DELIVERED'); end if;
  if p_method is null or p_method not in ('HAND_DELIVERY', 'EMAIL', 'REGISTERED_MAIL', 'EMPLOYEE_PORTAL',
                                          'OTHER_AUTHORIZED_CHANNEL') then
    perform api._fail('INVALID', 'delivery_method');
  end if;
  if p_delivered_at is null or p_delivered_at < v_n.issued_at or p_delivered_at > now() then
    perform api._fail('INVALID', 'delivered_at');
  end if;
  v_reference := api._require_text(p_reference, 'delivery_reference', 3, 300);
  update grievance.defence_notice
     set delivered_at = p_delivered_at, delivery_method = p_method, delivery_reference = v_reference,
         delivery_recorded_by = v_actor, delivery_recorded_at = now()
   where id = v_n.id
  returning * into v_n;
  update grievance.notice_delivery_task set status = 'DONE', closed_at = now(), closed_by = v_actor
   where notice_id = v_n.id and status = 'OPEN';
  get diagnostics v_tasks = row_count;
  perform audit.record_event('NOTICE_DELIVERY_RECORDED', 'BUSINESS', 'SUCCESS', v_n.case_id, 'defence_notice',
    v_n.id::text, null, jsonb_build_object('subject_id', v_n.subject_id, 'kind', v_n.kind, 'delivery_method', p_method,
                                           'delivered_at', p_delivered_at, 'window_start_basis', v_n.window_start_basis,
                                           'window_starts_at', v_n.grievance_window_starts_at,
                                           'window_ends_at', v_n.grievance_window_ends_at, 'tasks_closed', v_tasks));
  return v_n.grievance_window_ends_at;
end;
$$;
grant execute on function api.record_notice_delivery(uuid, text, timestamptz, text) to authenticated;

-- Replaced from 1990: the subject also sees when the notice was delivered, how its window starts, and whether a
-- defence period is suspended. Same signature, SECURITY DEFINER and filter.
create or replace function api.my_defence_notices()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'notice_id', n.id, 'sequence_no', n.sequence_no, 'kind', n.kind, 'notice_text', n.notice_text,
           'due_at', n.due_at, 'suspended', n.suspended_at is not null,
           'delivered_at', n.delivered_at, 'window_start_basis', n.window_start_basis,
           'grievance_window_starts_at', n.grievance_window_starts_at,
           'grievance_window_ends_at', n.grievance_window_ends_at,
           'status', n.status, 'issued_at', n.issued_at, 'acknowledged_at', n.acknowledged_at,
           'items', (select coalesce(jsonb_agg(jsonb_build_object('position', i.position, 'snapshot', i.snapshot)
                                               order by i.position), '[]'::jsonb)
                     from grievance.defence_notice_item i where i.notice_id = n.id))
         order by n.issued_at), '[]'::jsonb)
  from grievance.defence_notice n
  where authz.current_user_id() is not null and authz.is_portal_subject(n.subject_id) and n.status <> 'WITHDRAWN';
$$;

-- =============================================================================
-- Items 2, 3 and 5. Grievances: the rule at the contested decision (DEC-F16), the non-admission decider (DEC-F17,
-- AMB-148, CON-004), scope per decision (AMB-139, CON-010), withdrawal (AMB-140), completion (AMB-141), contested
-- items (AMB-143) and the further-grievance rule (AMB-145, CDF-207; DEC-AMB-001 (owner, 2026-10-13))
-- =============================================================================
alter table grievance.grievance
  add column non_admission_decider text check (non_admission_decider in ('SECRETARY', 'CHAIR', 'COMMITTEE', 'EXTERNAL')),
  add column contested_authority_decision_id uuid references decision.authority_decision (id);
create index grievance_contested_decision on grievance.grievance (contested_authority_decision_id);
alter table grievance.grievance
  add constraint grievance_contested_decision_linked check (contested_authority_decision_id is null or kind = 'LINKED');
comment on column grievance.grievance.non_admission_decider is
  'Who decides a non-admission, snapshotted from the rule set at filing (DEC-F17). Null on grievances filed before '
  '2040 or under a version naming none: the admissibility decider decides.';
comment on column grievance.grievance.contested_authority_decision_id is
  'The competent-authority decision contested, when the grievance was filed on a decision notice (AMB-139). Null when '
  'unknown: the scope guards then treat it as matching any decision of the subject (fail-safe).';

-- Widened under the same names: an external authority may decide admissibility (2030 rule-set option).
alter table grievance.grievance drop constraint grievance_admissibility_decider_check;
alter table grievance.grievance add constraint grievance_admissibility_decider_check
  check (admissibility_decider in ('SECRETARY', 'CHAIR', 'COMMITTEE', 'EXTERNAL'));
alter table grievance.admissibility_assessment drop constraint admissibility_assessment_decided_by_role_check;
alter table grievance.admissibility_assessment add constraint admissibility_assessment_decided_by_role_check
  check (decided_by_role in ('SECRETARY', 'CHAIR', 'COMMITTEE', 'EXTERNAL'));
alter table grievance.admissibility_assessment add constraint admissibility_assessment_external_reference
  check (decided_by_role is distinct from 'EXTERNAL' or decision_reference is not null);
-- DEC-AMB-001 (owner, 2026-10-13): after a contested decision's grievance is decided, the grievant may file ONE
-- reconsideration, and only on genuinely new evidence, stated with a description and a reference. No unlimited chain:
-- a further grievance on the same decision is always refused (RECONSIDERATION_USED). New facts found otherwise go
-- through reinvestigation, which needs no grievance.
alter table grievance.grievance
  add column reconsideration_of       uuid references grievance.grievance (id),
  add column new_evidence_description text check (length(new_evidence_description) between 10 and 4000),
  add column new_evidence_reference   text check (length(new_evidence_reference) between 3 and 300);
create unique index grievance_reconsideration_of on grievance.grievance (reconsideration_of);
alter table grievance.grievance add constraint grievance_reconsideration_evidence check (
  (reconsideration_of is null) = (new_evidence_description is null)
  and (reconsideration_of is null) = (new_evidence_reference is null));
comment on column grievance.grievance.reconsideration_of is
  'The decided grievance this one reconsiders on new evidence (DEC-AMB-001 (owner, 2026-10-13)). One per contested '
  'decision; the new evidence is stated in new_evidence_description and new_evidence_reference.';
-- The admissibility of a reconsideration confirms that its evidence is new; without that confirmation it is not
-- admitted (fail closed). Null on every other grievance.
alter table grievance.admissibility_assessment add column new_evidence_confirmed boolean;
comment on column grievance.admissibility_assessment.new_evidence_confirmed is
  'On a reconsideration (DEC-AMB-001 (owner, 2026-10-13)): whether the assessor confirms the evidence is genuinely new. '
  'An ADMISSIBLE assessment or decision of a reconsideration needs true; null on other grievances.';

-- Widened under the same name: a grievance withdrawn after admission keeps its committee proceeding.
alter table grievance.grievance drop constraint grievance_check4;
alter table grievance.grievance add constraint grievance_check4 check (
  (status in ('ADMITTED', 'DECIDED')) <= (committee_proceeding_id is not null)
  and (committee_proceeding_id is not null) <= (status in ('ADMITTED', 'DECIDED', 'WITHDRAWN')));

-- Replaced from 1910: the rule in force at the contested decision date applies (DEC-F16), falling back to the one at
-- submission when none was in force then; the non-admission decider is snapshotted (DEC-F17).
create or replace function grievance.insert_grievance(p_case_id uuid, p_kind text, p_subject_id uuid, p_user_id uuid,
                                                      p_label text, p_channel text,
                                                      p_original_submission_date timestamptz,
                                                      p_contested_decision_date timestamptz, p_grounds text,
                                                      p_document_reference text, p_actor uuid)
returns grievance.grievance
language plpgsql
set search_path = ''
as $$
declare
  v_rule committee.rule_set;
  v grievance.grievance;
begin
  if p_channel is null or p_channel not in ('EMPLOYEE_PORTAL', 'EMAIL', 'PHYSICAL_SUBMISSION', 'SECRETARY_ENTRY',
                                            'BCP_IMPORT', 'OTHER_AUTHORIZED_CHANNEL') then
    perform api._fail('INVALID', 'channel');
  end if;
  if p_original_submission_date is null or p_original_submission_date > now() then
    perform api._fail('INVALID', 'original_submission_date');
  end if;
  if p_contested_decision_date is null or p_contested_decision_date > p_original_submission_date then
    perform api._fail('INVALID', 'contested_decision_date');
  end if;
  if p_channel <> 'EMPLOYEE_PORTAL' and p_document_reference is null then
    perform api._fail('INVALID', 'original_document_reference');
  end if;
  v_rule := grievance.rule_at(p_contested_decision_date);
  if v_rule.id is null then v_rule := grievance.rule_at(p_original_submission_date); end if;
  if v_rule.id is null or v_rule.grievance_window_days is null then perform api._fail('CONFLICT', 'NO_RULE_SET'); end if;
  insert into grievance.grievance (case_id, kind, grievant_subject_id, grievant_user_id, grievant_label, channel,
                                   original_submission_date, contested_decision_date, grounds,
                                   original_document_reference, rule_set_id, window_days, is_late,
                                   admissibility_decider, non_admission_decider, recorded_by)
  values (p_case_id, p_kind, p_subject_id, p_user_id,
          case when p_label is not null then api._require_text(p_label, 'grievant_label', 2, 200) end,
          p_channel, p_original_submission_date, p_contested_decision_date,
          api._require_text(p_grounds, 'grounds', 10, 20000),
          case when p_document_reference is not null
               then api._require_text(p_document_reference, 'original_document_reference', 3, 300) end,
          v_rule.id, v_rule.grievance_window_days,
          p_original_submission_date > p_contested_decision_date + make_interval(days => v_rule.grievance_window_days),
          coalesce(v_rule.admissibility_decider, 'SECRETARY'),
          coalesce(v_rule.non_admission_decider, v_rule.admissibility_decider, 'SECRETARY'), p_actor)
  returning * into v;
  perform audit.record_event('GRIEVANCE_FILED', 'BUSINESS', 'SUCCESS', p_case_id, 'grievance', v.id::text, null,
    jsonb_build_object('kind', p_kind, 'channel', p_channel, 'is_late', v.is_late, 'window_days', v.window_days,
                       'rule_set_id', v_rule.id, 'admissibility_decider', v.admissibility_decider,
                       'non_admission_decider', v.non_admission_decider));
  return v;
end;
$$;

-- Scope guards on every grievance, whatever path files it (AMB-139, AMB-145, CDF-207; DEC-AMB-001 (owner,
-- 2026-10-13)). A reconsideration names a decided grievance that is not itself a reconsideration, on the same case,
-- grievant and contested decision, and is the only one of it. For a known subject: any grievance after a
-- reconsideration on the same decision is refused with its own code, whatever the reconsideration's status; one open
-- grievance per contested decision; on a decision whose grievance is decided, only the reconsideration. An unknown
-- decision on either side matches (fail-safe); a decided one or a reconsideration then matches on the contested
-- decision date. A grievance recorded with a label only cannot be matched beyond its own reconsideration.
create function grievance.guard_grievance_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_prior grievance.grievance;
begin
  if new.reconsideration_of is not null then
    select * into v_prior from grievance.grievance g where g.id = new.reconsideration_of;
    if v_prior.reconsideration_of is not null
       or exists (select 1 from grievance.grievance g where g.reconsideration_of = new.reconsideration_of) then
      perform api._fail('CONFLICT', 'RECONSIDERATION_USED');
    end if;
    if v_prior.id is null or v_prior.status <> 'DECIDED' or v_prior.case_id <> new.case_id
       or v_prior.grievant_subject_id is distinct from new.grievant_subject_id
       or v_prior.grievant_label is distinct from new.grievant_label
       or v_prior.contested_authority_decision_id is distinct from new.contested_authority_decision_id
       or v_prior.contested_decision_date <> new.contested_decision_date then
      perform api._fail('INVALID', 'reconsideration_of');
    end if;
    -- The reconsideration is asked after the grievance it reconsiders was decided.
    if new.original_submission_date < (select o.recorded_at from grievance.grievance_outcome o
                                       where o.grievance_id = v_prior.id) then
      perform api._fail('INVALID', 'original_submission_date');
    end if;
  end if;
  if new.grievant_subject_id is null then return new; end if;
  if exists (select 1 from grievance.grievance g
             where g.grievant_subject_id = new.grievant_subject_id and g.reconsideration_of is not null
               and (g.contested_authority_decision_id = new.contested_authority_decision_id
                    or ((g.contested_authority_decision_id is null or new.contested_authority_decision_id is null)
                        and g.contested_decision_date = new.contested_decision_date))) then
    perform api._fail('CONFLICT', 'RECONSIDERATION_USED');
  end if;
  if exists (select 1 from grievance.grievance g
             where g.grievant_subject_id = new.grievant_subject_id
               and g.status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED')
               and (g.contested_authority_decision_id is null or new.contested_authority_decision_id is null
                    or g.contested_authority_decision_id = new.contested_authority_decision_id)) then
    perform api._fail('CONFLICT', 'GRIEVANCE_OPEN');
  end if;
  if new.reconsideration_of is null
     and exists (select 1 from grievance.grievance g
                 where g.grievant_subject_id = new.grievant_subject_id and g.status = 'DECIDED'
                   and (g.contested_authority_decision_id = new.contested_authority_decision_id
                        or ((g.contested_authority_decision_id is null or new.contested_authority_decision_id is null)
                            and g.contested_decision_date = new.contested_decision_date))) then
    perform api._fail('CONFLICT', 'GRIEVANCE_ALREADY_DECIDED');
  end if;
  return new;
end;
$$;
create trigger grievance_scope before insert on grievance.grievance
  for each row execute function grievance.guard_grievance_scope();

-- Contested items (AMB-143): the items of the decision the grievance names; none named = the whole decision.
create table grievance.contested_item (
  grievance_id uuid not null references grievance.grievance (id),
  item_id      uuid not null references decision.recommendation_item (id),
  primary key (grievance_id, item_id)
);
create index contested_item_item on grievance.contested_item (item_id);
comment on table grievance.contested_item is
  'The decision items a grievance contests (AMB-143, migration 2040). None = the whole decision. Append-only.';
create trigger no_update before update on grievance.contested_item
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on grievance.contested_item
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on grievance.contested_item
  for each statement execute function committee.reject_mutation();
alter table grievance.contested_item enable row level security;
create policy contested_item_read on grievance.contested_item for select to authenticated
  using (authz.can_view_grievance(grievance_id));
grant select on grievance.contested_item to authenticated;

-- Filing on a decision notice, naming contested items. Before delivery the window has not started, so the filing is
-- accepted and not late (DEC-F15).
create function api.file_grievance_on_decision_notice(p_notice_id uuid, p_grounds text, p_item_ids uuid[])
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_n grievance.defence_notice;
  v_rule committee.rule_set;
  v_d decision.authority_decision;
  v_items uuid[] := coalesce(p_item_ids, '{}');
  v grievance.grievance;
begin
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id;
  if v_n.id is null or not authz.is_portal_subject(v_n.subject_id) then perform api._fail('NOT_FOUND'); end if;
  if v_n.kind <> 'DECISION' then perform api._fail('CONFLICT', 'NOT_A_DECISION_NOTICE'); end if;
  if v_n.status = 'WITHDRAWN' then perform api._fail('CONFLICT', 'NOTICE_NOT_OPEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_n.case_id for update;
  select * into v_d from decision.authority_decision d where d.id = v_n.authority_decision_id;
  if (select count(distinct x) from unnest(v_items) x) <> cardinality(v_items)
     or exists (select 1 from unnest(v_items) x
                where not exists (
                  select 1 from decision.recommendation_item i
                  where i.id = x and i.package_id = v_d.package_id and i.status = 'ACTIVE'
                    and i.committee_result = 'APPROVED'
                    and (i.case_wide or exists (select 1 from decision.recommendation_item_subject s
                                                where s.item_id = i.id and s.subject_id = v_n.subject_id))
                    and not exists (select 1 from decision.authority_item_decision aid
                                    where aid.decision_id = v_d.id and aid.item_id = i.id and aid.outcome = 'REJECTED'))) then
    perform api._fail('INVALID', 'item_ids');
  end if;
  -- The scope trigger refuses the same; checked first here so that a used reconsideration keeps its own code.
  if exists (select 1 from grievance.grievance g
             where g.grievant_subject_id = v_n.subject_id and g.reconsideration_of is not null
               and (g.contested_authority_decision_id = v_d.id
                    or (g.contested_authority_decision_id is null and g.contested_decision_date = v_d.decided_at))) then
    perform api._fail('CONFLICT', 'RECONSIDERATION_USED');
  end if;
  if exists (select 1 from grievance.grievance g
             where g.grievant_subject_id = v_n.subject_id
               and g.status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED')
               and (g.contested_authority_decision_id is null or g.contested_authority_decision_id = v_d.id)) then
    perform api._fail('CONFLICT', 'GRIEVANCE_OPEN');
  end if;
  select * into v_rule from committee.rule_set r where r.id = v_n.grievance_rule_set_id;
  insert into grievance.grievance (case_id, kind, grievant_subject_id, grievant_user_id, channel, original_submission_date,
                                   contested_decision_date, grounds, rule_set_id, window_days, is_late,
                                   admissibility_decider, non_admission_decider, recorded_by, decision_notice_id,
                                   contested_authority_decision_id)
  values (v_n.case_id, 'LINKED', v_n.subject_id, v_actor, 'EMPLOYEE_PORTAL', now(), v_d.decided_at,
          api._require_text(p_grounds, 'grounds', 10, 20000), v_rule.id, v_n.grievance_window_days,
          coalesce(now() > v_n.grievance_window_ends_at, false), coalesce(v_rule.admissibility_decider, 'SECRETARY'),
          coalesce(v_rule.non_admission_decider, v_rule.admissibility_decider, 'SECRETARY'), v_actor, v_n.id, v_d.id)
  returning * into v;
  insert into grievance.contested_item (grievance_id, item_id) select v.id, x from unnest(v_items) x;
  perform audit.record_event('GRIEVANCE_FILED', 'BUSINESS', 'SUCCESS', v.case_id, 'grievance', v.id::text, null,
    jsonb_build_object('kind', 'LINKED', 'channel', 'EMPLOYEE_PORTAL', 'is_late', v.is_late, 'window_days', v.window_days,
                       'rule_set_id', v.rule_set_id, 'admissibility_decider', v.admissibility_decider,
                       'non_admission_decider', v.non_admission_decider, 'decision_notice_id', v_n.id,
                       'authority_decision_id', v_d.id, 'contested_items', cardinality(v_items),
                       'window_started', v_n.grievance_window_ends_at is not null));
  return v.id;
end;
$$;
grant execute on function api.file_grievance_on_decision_notice(uuid, text, uuid[]) to authenticated;

-- Replaced from 1990: delegates to the overload above with no contested items (the whole decision). The open-grievance
-- refusal narrows from "any open grievance of the subject" to "an open grievance on the same decision" (AMB-139).
create or replace function api.file_grievance_on_decision_notice(p_notice_id uuid, p_grounds text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  return api.file_grievance_on_decision_notice(p_notice_id, p_grounds, null::uuid[]);
end;
$$;

-- The decider a grievance awaits: the non-admission decider for a proposed non-admission, else the admissibility
-- decider (DEC-F17).
create function grievance.pending_decider(p_g grievance.grievance)
returns text
language sql stable
set search_path = ''
as $$
  select case a.assessment when 'INADMISSIBLE' then coalesce(p_g.non_admission_decider, p_g.admissibility_decider)
                           else p_g.admissibility_decider end
  from grievance.admissibility_assessment a
  where a.grievance_id = p_g.id and a.stage = 'SECRETARY_ASSESSMENT'
  order by a.recorded_at desc, a.id desc limit 1;
$$;

-- Completion requests (AMB-141): the period comes from the grievance's rule set; none configured, no request.
create table grievance.completion_request (
  id              uuid primary key default gen_random_uuid(),
  grievance_id    uuid not null references grievance.grievance (id),
  sequence_no     int not null check (sequence_no >= 1),
  reason          text not null check (length(reason) between 10 and 2000),
  completion_days int not null check (completion_days between 1 and 90),
  due_at          timestamptz not null,
  requested_by    uuid not null references iam.user_profile (id),
  requested_at    timestamptz not null default now(),
  unique (grievance_id, sequence_no),
  check (due_at > requested_at)
);
create index completion_request_requested_by on grievance.completion_request (requested_by);
create table grievance.grievance_supplement (
  id                    uuid primary key default gen_random_uuid(),
  completion_request_id uuid not null unique references grievance.completion_request (id),
  grievance_id          uuid not null references grievance.grievance (id),
  supplement_text       text not null check (length(supplement_text) between 10 and 20000),
  is_late               boolean not null,
  submitted_by          uuid not null references iam.user_profile (id),
  submitted_at          timestamptz not null default now()
);
create index grievance_supplement_grievance on grievance.grievance_supplement (grievance_id);
create index grievance_supplement_submitted_by on grievance.grievance_supplement (submitted_by);
comment on table grievance.completion_request is
  'A request to complete a grievance before admissibility (AMB-141, migration 2040). The period is the grievance rule '
  'set''s grievance_completion_days (SOURCE_REQUIRED; none = no request). The original filing date stands.';
comment on table grievance.grievance_supplement is
  'The grievant''s completion of a grievance, answering one request; flagged late after its due date, never refused.';

-- Withdrawal (AMB-140): by the grievant before the outcome; the window is not reopened.
create table grievance.grievance_withdrawal (
  id              uuid primary key default gen_random_uuid(),
  grievance_id    uuid not null unique references grievance.grievance (id),
  previous_status text not null check (previous_status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED')),
  reason          text not null check (length(reason) between 10 and 2000),
  withdrawn_by    uuid not null references iam.user_profile (id),
  withdrawn_at    timestamptz not null default now()
);
create index grievance_withdrawal_withdrawn_by on grievance.grievance_withdrawal (withdrawn_by);
comment on table grievance.grievance_withdrawal is
  'A grievance withdrawn by its grievant before the outcome (AMB-140, migration 2040). The window is not reopened.';

do $$
declare t text;
begin
  foreach t in array array['completion_request', 'grievance_supplement', 'grievance_withdrawal'] loop
    execute format('create trigger no_update before update on grievance.%I for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on grievance.%I for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on grievance.%I for each statement execute function committee.reject_mutation()', t);
    execute format('alter table grievance.%I enable row level security', t);
    execute format('create policy %I on grievance.%I for select to authenticated using (authz.can_view_grievance(grievance_id))',
                   t || '_read', t);
    execute format('grant select on grievance.%I to authenticated', t);
  end loop;
end;
$$;

-- DEC-AMB-001 (owner, 2026-10-13): the admissibility of a reconsideration confirms that its evidence is new. Guarded on
-- the row, whatever path writes it: an ADMISSIBLE assessment or decision of a reconsideration without that
-- confirmation is refused; the confirmation means nothing on another grievance.
create function grievance.guard_new_evidence_confirmation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_reconsideration boolean;
begin
  select g.reconsideration_of is not null into v_reconsideration from grievance.grievance g where g.id = new.grievance_id;
  if not coalesce(v_reconsideration, false) then
    if new.new_evidence_confirmed is not null then perform api._fail('INVALID', 'new_evidence_confirmed'); end if;
  elsif new.assessment = 'ADMISSIBLE' and new.new_evidence_confirmed is distinct from true then
    perform api._fail('CONFLICT', 'NEW_EVIDENCE_NOT_CONFIRMED');
  end if;
  return new;
end;
$$;
create trigger admissibility_new_evidence before insert on grievance.admissibility_assessment
  for each row execute function grievance.guard_new_evidence_confirmation();

-- The admissibility assessment with the reconsideration's new-evidence confirmation (DEC-AMB-001 (owner, 2026-10-13)).
-- A proposed non-admission waits for the non-admission decider unless that decider is the secretary (DEC-F17,
-- T-AMB-087); an admission still follows the admissibility decider. Nothing is assessed while a completion request is
-- open. The G3b refusal and every other check are as in 1910.
create function api.assess_grievance_admissibility(p_grievance_id uuid, p_assessment text, p_proposed_action text,
                                                   p_reason text, p_new_evidence_confirmed boolean)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_g grievance.grievance;
  v_decider text;
begin
  v_g := grievance.lock_handled_grievance(p_grievance_id);
  -- G3b (N9): a secretary who took part in the case's Investigation Committee neither assesses nor decides its
  -- grievance; another secretary of the Grievance Committee does.
  if authz.participated_in_investigation_committee(v_actor, v_g.case_id) then perform api._fail('FORBIDDEN'); end if;
  if v_g.status <> 'RECEIVED' then perform api._fail('CONFLICT', 'GRIEVANCE_NOT_RECEIVED'); end if;
  if exists (select 1 from grievance.completion_request r
             where r.grievance_id = v_g.id
               and not exists (select 1 from grievance.grievance_supplement x where x.completion_request_id = r.id)) then
    perform api._fail('CONFLICT', 'COMPLETION_PENDING');
  end if;
  if p_assessment is null or p_assessment not in ('ADMISSIBLE', 'INADMISSIBLE') then
    perform api._fail('INVALID', 'assessment');
  end if;
  v_decider := case when p_assessment = 'INADMISSIBLE' then coalesce(v_g.non_admission_decider, v_g.admissibility_decider)
                    else v_g.admissibility_decider end;
  insert into grievance.admissibility_assessment (grievance_id, stage, assessment, proposed_action, decided_by_role,
                                                  reason, recorded_by, new_evidence_confirmed)
  values (v_g.id, case when v_decider = 'SECRETARY' then 'DECISION' else 'SECRETARY_ASSESSMENT' end,
          p_assessment, case when p_proposed_action is not null then api._require_text(p_proposed_action, 'proposed_action', 5, 4000) end,
          case when v_decider = 'SECRETARY' then 'SECRETARY' end,
          api._require_text(p_reason, 'reason', 5, 2000), v_actor, p_new_evidence_confirmed);
  perform audit.record_event('GRIEVANCE_ADMISSIBILITY_ASSESSED', 'BUSINESS', 'SUCCESS', v_g.case_id, 'grievance',
    v_g.id::text, null, jsonb_build_object('assessment', p_assessment, 'decider', v_decider,
                                           'reconsideration', v_g.reconsideration_of is not null,
                                           'new_evidence_confirmed', p_new_evidence_confirmed));
  if v_decider = 'SECRETARY' then
    return grievance.apply_admissibility(v_g, p_assessment, v_actor);
  end if;
  update grievance.grievance set status = 'AWAITING_ADMISSIBILITY_DECISION', updated_at = now(), row_version = row_version + 1
   where id = v_g.id;
  return 'AWAITING_ADMISSIBILITY_DECISION';
end;
$$;
grant execute on function api.assess_grievance_admissibility(uuid, text, text, text, boolean) to authenticated;

-- Replaced from 1910: delegates to the overload above without a new-evidence confirmation, so a reconsideration is
-- never admitted through it (DEC-AMB-001 (owner, 2026-10-13)); on every other grievance the behaviour is the overload's
-- (DEC-F17, completion requests).
create or replace function api.assess_grievance_admissibility(p_grievance_id uuid, p_assessment text,
                                                              p_proposed_action text, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
begin
  return api.assess_grievance_admissibility(p_grievance_id, p_assessment, p_proposed_action, p_reason, null::boolean);
end;
$$;

-- The admissibility decision with the reconsideration's new-evidence confirmation (DEC-AMB-001 (owner, 2026-10-13)).
-- The decider is the one the secretary's assessment awaits (DEC-F17). The chair (or deputy) decides for CHAIR and
-- COMMITTEE, as in 1910, with every seat, gate and G3 check; an EXTERNAL decision is recorded by a secretary who may
-- handle the grievance (G3b applies) with the external decision's reference; COMMITTEE and EXTERNAL need a reference.
create function api.decide_grievance_admissibility(p_grievance_id uuid, p_decision text, p_decision_reference text,
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
  v_chair := coalesce(v_g.id is not null
                      and authz.user_committee_seat(v_actor, grievance.committee_id(), now()) in ('CHAIR', 'DEPUTY_CHAIR')
                      and authz.user_case_gate(v_actor, v_g.case_id), false);
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
grant execute on function api.decide_grievance_admissibility(uuid, text, text, text, boolean) to authenticated;

-- Replaced from 1910: delegates to the overload above without a new-evidence confirmation, so a reconsideration is
-- never admitted through it (DEC-AMB-001 (owner, 2026-10-13)); on every other grievance the behaviour is the overload's
-- (DEC-F17 deciders).
create or replace function api.decide_grievance_admissibility(p_grievance_id uuid, p_decision text,
                                                              p_decision_reference text, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
begin
  return api.decide_grievance_admissibility(p_grievance_id, p_decision, p_decision_reference, p_reason, null::boolean);
end;
$$;

create function api.withdraw_grievance(p_grievance_id uuid, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_g grievance.grievance;
begin
  select * into v_g from grievance.grievance g where g.id = p_grievance_id;
  if v_g.id is null or not authz.can_view_grievance(v_g.id) then perform api._fail('NOT_FOUND'); end if;
  if v_g.grievant_user_id is distinct from v_actor then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_g.case_id for update;
  select * into v_g from grievance.grievance g where g.id = p_grievance_id for update;
  if v_g.status not in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED') then
    perform api._fail('CONFLICT', 'GRIEVANCE_NOT_OPEN');
  end if;
  insert into grievance.grievance_withdrawal (grievance_id, previous_status, reason, withdrawn_by)
  values (v_g.id, v_g.status, api._require_text(p_reason, 'reason', 10, 2000), v_actor);
  update grievance.grievance set status = 'WITHDRAWN', updated_at = now(), row_version = row_version + 1
   where id = v_g.id;
  perform audit.record_event('GRIEVANCE_WITHDRAWN', 'BUSINESS', 'SUCCESS', v_g.case_id, 'grievance', v_g.id::text, null,
    jsonb_build_object('previous_status', v_g.status));
  return 'WITHDRAWN';
end;
$$;
grant execute on function api.withdraw_grievance(uuid, text) to authenticated;

create function api.request_grievance_completion(p_grievance_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_g grievance.grievance;
  v_days int;
  v_seq int;
  v_id uuid;
  v_due timestamptz;
begin
  v_g := grievance.lock_handled_grievance(p_grievance_id);
  if authz.participated_in_investigation_committee(v_actor, v_g.case_id) then perform api._fail('FORBIDDEN'); end if;
  if v_g.status <> 'RECEIVED' then perform api._fail('CONFLICT', 'GRIEVANCE_NOT_RECEIVED'); end if;
  if exists (select 1 from grievance.completion_request r
             where r.grievance_id = v_g.id
               and not exists (select 1 from grievance.grievance_supplement x where x.completion_request_id = r.id)) then
    perform api._fail('CONFLICT', 'COMPLETION_PENDING');
  end if;
  select r.grievance_completion_days into v_days from committee.rule_set r where r.id = v_g.rule_set_id;
  if v_days is null then perform api._fail('CONFLICT', 'COMPLETION_PERIOD_SOURCE_REQUIRED'); end if;
  select coalesce(max(r.sequence_no), 0) + 1 into v_seq from grievance.completion_request r where r.grievance_id = v_g.id;
  v_due := now() + make_interval(days => v_days);
  insert into grievance.completion_request (grievance_id, sequence_no, reason, completion_days, due_at, requested_by)
  values (v_g.id, v_seq, api._require_text(p_reason, 'reason', 10, 2000), v_days, v_due, v_actor)
  returning id into v_id;
  perform audit.record_event('GRIEVANCE_COMPLETION_REQUESTED', 'BUSINESS', 'SUCCESS', v_g.case_id, 'grievance',
    v_g.id::text, null, jsonb_build_object('completion_request_id', v_id, 'sequence_no', v_seq,
                                           'completion_days', v_days, 'due_at', v_due));
  return v_id;
end;
$$;
grant execute on function api.request_grievance_completion(uuid, text) to authenticated;

create function api.complete_grievance(p_grievance_id uuid, p_supplement_text text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_g grievance.grievance;
  v_r grievance.completion_request;
  v_id uuid;
begin
  select * into v_g from grievance.grievance g where g.id = p_grievance_id;
  if v_g.id is null or not authz.can_view_grievance(v_g.id) then perform api._fail('NOT_FOUND'); end if;
  if v_g.grievant_user_id is distinct from v_actor then perform api._fail('FORBIDDEN'); end if;
  select * into v_g from grievance.grievance g where g.id = p_grievance_id for update;
  if v_g.status <> 'RECEIVED' then perform api._fail('CONFLICT', 'GRIEVANCE_NOT_RECEIVED'); end if;
  select r.* into v_r from grievance.completion_request r
  where r.grievance_id = v_g.id
    and not exists (select 1 from grievance.grievance_supplement x where x.completion_request_id = r.id)
  order by r.sequence_no desc limit 1;
  if v_r.id is null then perform api._fail('CONFLICT', 'NO_COMPLETION_REQUEST'); end if;
  insert into grievance.grievance_supplement (completion_request_id, grievance_id, supplement_text, is_late, submitted_by)
  values (v_r.id, v_g.id, api._require_text(p_supplement_text, 'supplement_text', 10, 20000), now() > v_r.due_at, v_actor)
  returning id into v_id;
  perform audit.record_event('GRIEVANCE_COMPLETED', 'BUSINESS', 'SUCCESS', v_g.case_id, 'grievance', v_g.id::text, null,
    jsonb_build_object('completion_request_id', v_r.id, 'supplement_id', v_id, 'is_late', now() > v_r.due_at));
  return v_id;
end;
$$;
grant execute on function api.complete_grievance(uuid, text) to authenticated;

-- DEC-AMB-001 (owner, 2026-10-13): the grievant asks, through the portal, for ONE reconsideration of a decided grievance,
-- stating the new evidence (a description and a reference). It contests the same decision and items, under the same
-- rule set and deciders; the scope trigger refuses a second (RECONSIDERATION_USED) and an open one (GRIEVANCE_OPEN).
-- No reconsideration period exists (none is invented, SOURCE_REQUIRED), so it is not measured against the grievance
-- window: is_late is false and admissibility judges whether the evidence is genuinely new.
create function api.file_grievance_reconsideration(p_grievance_id uuid, p_grounds text,
                                                   p_new_evidence_description text, p_new_evidence_reference text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_g grievance.grievance;
  v grievance.grievance;
  v_items int;
begin
  select * into v_g from grievance.grievance g where g.id = p_grievance_id;
  if v_g.id is null or not authz.can_view_grievance(v_g.id) then perform api._fail('NOT_FOUND'); end if;
  if v_g.grievant_user_id is distinct from v_actor or v_g.grievant_subject_id is null
     or not authz.is_portal_subject(v_g.grievant_subject_id) then
    perform api._fail('FORBIDDEN');
  end if;
  perform 1 from case_mgmt.case_record c where c.id = v_g.case_id for update;
  if v_g.reconsideration_of is not null then perform api._fail('CONFLICT', 'RECONSIDERATION_USED'); end if;
  if v_g.status <> 'DECIDED' then perform api._fail('CONFLICT', 'GRIEVANCE_NOT_DECIDED'); end if;
  insert into grievance.grievance (case_id, kind, grievant_subject_id, grievant_user_id, channel, original_submission_date,
                                   contested_decision_date, grounds, rule_set_id, window_days, is_late,
                                   admissibility_decider, non_admission_decider, recorded_by, decision_notice_id,
                                   contested_authority_decision_id, reconsideration_of, new_evidence_description,
                                   new_evidence_reference)
  values (v_g.case_id, v_g.kind, v_g.grievant_subject_id, v_actor, 'EMPLOYEE_PORTAL', now(), v_g.contested_decision_date,
          api._require_text(p_grounds, 'grounds', 10, 20000), v_g.rule_set_id, v_g.window_days, false,
          v_g.admissibility_decider, v_g.non_admission_decider, v_actor, v_g.decision_notice_id,
          v_g.contested_authority_decision_id, v_g.id,
          api._require_text(p_new_evidence_description, 'new_evidence_description', 10, 4000),
          api._require_text(p_new_evidence_reference, 'new_evidence_reference', 3, 300))
  returning * into v;
  insert into grievance.contested_item (grievance_id, item_id)
  select v.id, c.item_id from grievance.contested_item c where c.grievance_id = v_g.id;
  get diagnostics v_items = row_count;
  perform audit.record_event('GRIEVANCE_FILED', 'BUSINESS', 'SUCCESS', v.case_id, 'grievance', v.id::text, null,
    jsonb_build_object('kind', v.kind, 'channel', 'EMPLOYEE_PORTAL', 'is_late', false, 'window_days', v.window_days,
                       'rule_set_id', v.rule_set_id, 'admissibility_decider', v.admissibility_decider,
                       'non_admission_decider', v.non_admission_decider, 'reconsideration_of', v_g.id,
                       'authority_decision_id', v.contested_authority_decision_id, 'contested_items', v_items));
  return v.id;
end;
$$;
grant execute on function api.file_grievance_reconsideration(uuid, text, text, text) to authenticated;

-- DEC-AMB-001 (owner, 2026-10-13), the Secretary path: the Grievance Committee Secretary who may handle a decided
-- grievance records its ONE reconsideration received outside the portal, with the channel, the received document and
-- the new evidence; also for a grievance recorded with a label only. Same rule set, deciders and contested items.
create function api.record_grievance_reconsideration(p_grievance_id uuid, p_channel text,
                                                     p_original_submission_date timestamptz, p_grounds text,
                                                     p_original_document_reference text,
                                                     p_new_evidence_description text, p_new_evidence_reference text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_g grievance.grievance;
  v grievance.grievance;
  v_items int;
begin
  v_g := grievance.lock_handled_grievance(p_grievance_id);
  perform 1 from case_mgmt.case_record c where c.id = v_g.case_id for update;
  if v_g.reconsideration_of is not null then perform api._fail('CONFLICT', 'RECONSIDERATION_USED'); end if;
  if v_g.status <> 'DECIDED' then perform api._fail('CONFLICT', 'GRIEVANCE_NOT_DECIDED'); end if;
  if p_channel is null or p_channel not in ('EMAIL', 'PHYSICAL_SUBMISSION', 'SECRETARY_ENTRY', 'BCP_IMPORT',
                                            'OTHER_AUTHORIZED_CHANNEL') then
    perform api._fail('INVALID', 'channel');
  end if;
  if p_original_submission_date is null or p_original_submission_date > now() then
    perform api._fail('INVALID', 'original_submission_date');
  end if;
  insert into grievance.grievance (case_id, kind, grievant_subject_id, grievant_user_id, grievant_label, channel,
                                   original_submission_date, contested_decision_date, grounds,
                                   original_document_reference, rule_set_id, window_days, is_late,
                                   admissibility_decider, non_admission_decider, recorded_by, decision_notice_id,
                                   contested_authority_decision_id, reconsideration_of, new_evidence_description,
                                   new_evidence_reference)
  values (v_g.case_id, v_g.kind, v_g.grievant_subject_id, v_g.grievant_user_id, v_g.grievant_label, p_channel,
          p_original_submission_date, v_g.contested_decision_date, api._require_text(p_grounds, 'grounds', 10, 20000),
          api._require_text(p_original_document_reference, 'original_document_reference', 3, 300), v_g.rule_set_id,
          v_g.window_days, false, v_g.admissibility_decider, v_g.non_admission_decider, v_actor, v_g.decision_notice_id,
          v_g.contested_authority_decision_id, v_g.id,
          api._require_text(p_new_evidence_description, 'new_evidence_description', 10, 4000),
          api._require_text(p_new_evidence_reference, 'new_evidence_reference', 3, 300))
  returning * into v;
  insert into grievance.contested_item (grievance_id, item_id)
  select v.id, c.item_id from grievance.contested_item c where c.grievance_id = v_g.id;
  get diagnostics v_items = row_count;
  perform audit.record_event('GRIEVANCE_FILED', 'BUSINESS', 'SUCCESS', v.case_id, 'grievance', v.id::text, null,
    jsonb_build_object('kind', v.kind, 'channel', p_channel, 'is_late', false, 'window_days', v.window_days,
                       'rule_set_id', v.rule_set_id, 'admissibility_decider', v.admissibility_decider,
                       'non_admission_decider', v.non_admission_decider, 'reconsideration_of', v_g.id,
                       'authority_decision_id', v.contested_authority_decision_id, 'contested_items', v_items));
  return v.id;
end;
$$;
grant execute on function api.record_grievance_reconsideration(uuid, text, timestamptz, text, text, text, text)
  to authenticated;

-- =============================================================================
-- Item 4. Defence response period (DEC-F18; AMB-151, AMB-152, AMB-154, CON-019; T-AMB-090, T-AMB-091)
-- =============================================================================
-- The default period is configuration, effective-dated and SOURCE_REQUIRED: none is invented. Migration-managed, like
-- the other SOURCE_REQUIRED reference values; a version only ever gets an end.
create table grievance.defence_response_period (
  id               uuid primary key default gen_random_uuid(),
  effective_from   timestamptz not null,
  effective_to     timestamptz,
  default_days     int check (default_days between 1 and 365),
  source_status    text not null check (source_status in ('SOURCE_REQUIRED', 'OWNER_DEFAULT', 'APPROVED')),
  source_reference text check (length(source_reference) between 3 and 300),
  check ((default_days is null) = (source_status = 'SOURCE_REQUIRED')),
  check (effective_to is null or effective_to > effective_from)
);
comment on table grievance.defence_response_period is
  'The default defence response period, effective-dated (DEC-F18, AMB-151, migration 2040). SOURCE_REQUIRED: no CDF '
  'period is invented. With none configured a defence notice needs an entered due date (T-AMB-090).';
insert into grievance.defence_response_period (effective_from, default_days, source_status)
values ('2026-01-01T00:00:00Z', null, 'SOURCE_REQUIRED');

create function grievance.protect_response_period()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.effective_to is not null or (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') then
    raise exception 'response period % can only be given an end, once', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger defence_response_period_protect before update on grievance.defence_response_period
  for each row execute function grievance.protect_response_period();
create trigger no_delete before delete on grievance.defence_response_period
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on grievance.defence_response_period
  for each statement execute function committee.reject_mutation();
alter table grievance.defence_response_period enable row level security;
create policy defence_response_period_read on grievance.defence_response_period for select to authenticated
  using (authz.current_user_id() is not null);
grant select on grievance.defence_response_period to authenticated;

-- A refusal to respond is recorded as such (AMB-154); a late response may say why. No inference rule is applied.
alter table grievance.defence_response
  add column response_kind text not null default 'RESPONSE' check (response_kind in ('RESPONSE', 'DECLINED')),
  add column late_reason text check (length(late_reason) between 10 and 2000);
alter table grievance.defence_response
  add constraint defence_response_late_reason_when_late check (late_reason is null or is_late);

-- Replaced from 1910: without an entered due date the configured default period applies; with neither the notice is
-- refused (T-AMB-090). An entered date must still be in the future. Everything else is as before.
create or replace function api.issue_defence_notice(p_subject_id uuid, p_notice_text text, p_allegation_ids uuid[],
                                                    p_due_at timestamptz)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_s case_mgmt.case_subject;
  v_allegations uuid[] := coalesce(p_allegation_ids, '{}');
  v_id uuid;
  v_seq int;
  v_days int;
  v_due timestamptz := p_due_at;
begin
  select * into v_s from case_mgmt.case_subject s where s.id = p_subject_id;
  if v_s.id is null or not authz.can_view_case(v_s.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_manage_defence(v_s.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_s.case_id for update;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_s.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if cardinality(v_allegations) = 0
     or (select count(distinct x) from unnest(v_allegations) x) <> cardinality(v_allegations)
     or exists (select 1 from unnest(v_allegations) x
                where not exists (select 1 from case_mgmt.allegation a
                                  where a.id = x and a.case_id = v_s.case_id and a.subject_id = v_s.id)) then
    perform api._fail('INVALID', 'allegation_ids');
  end if;
  if v_due is null then
    select p.default_days into v_days from grievance.defence_response_period p
    where p.effective_from <= now() and (p.effective_to is null or p.effective_to > now())
    order by p.effective_from desc limit 1;
    if v_days is null then perform api._fail('CONFLICT', 'RESPONSE_PERIOD_SOURCE_REQUIRED'); end if;
    v_due := now() + make_interval(days => v_days);
  elsif v_due <= now() then
    perform api._fail('INVALID', 'due_at');
  end if;
  select coalesce(max(n.sequence_no), 0) + 1 into v_seq from grievance.defence_notice n where n.subject_id = v_s.id;
  insert into grievance.defence_notice (case_id, subject_id, sequence_no, notice_text, due_at, issued_by)
  values (v_s.case_id, v_s.id, v_seq, api._require_text(p_notice_text, 'notice_text', 10, 4000), v_due, v_actor)
  returning id into v_id;
  insert into grievance.defence_notice_item (notice_id, position, allegation_id, snapshot)
  select v_id, row_number() over (order by a.created_at, a.id), a.id,
         jsonb_build_object('category', a.category, 'description', a.description,
                            'policy_reference', a.policy_reference, 'law_reference', a.law_reference)
  from case_mgmt.allegation a where a.id = any (v_allegations);
  perform audit.record_event('DEFENCE_NOTICE_ISSUED', 'BUSINESS', 'SUCCESS', v_s.case_id, 'defence_notice', v_id::text, null,
    jsonb_build_object('subject_id', v_s.id, 'sequence_no', v_seq, 'allegations', cardinality(v_allegations),
                       'due_at', v_due, 'default_period_days', v_days));
  return v_id;
end;
$$;

-- Extension, suspension, resumption and rescheduling, each with a reason, by whoever manages the defence (T-AMB-091).
create function api.change_defence_deadline(p_notice_id uuid, p_change_kind text, p_new_due_at timestamptz,
                                            p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_n grievance.defence_notice;
  v_seq int;
  v_id uuid;
begin
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id;
  if v_n.id is null or not authz.can_view_case(v_n.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform grievance.lock_notice_subject(v_n.subject_id);
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id for update;
  if v_n.kind <> 'DEFENCE' then perform api._fail('CONFLICT', 'NOT_A_DEFENCE_NOTICE'); end if;
  if v_n.status not in ('ISSUED', 'ACKNOWLEDGED') then perform api._fail('CONFLICT', 'NOTICE_NOT_OPEN'); end if;
  if p_change_kind is null or p_change_kind not in ('EXTENSION', 'SUSPENSION', 'RESUMPTION', 'RESCHEDULE') then
    perform api._fail('INVALID', 'change_kind');
  end if;
  if (p_change_kind = 'RESUMPTION') <> (v_n.suspended_at is not null) then
    perform api._fail('CONFLICT', case when v_n.suspended_at is null then 'NOT_SUSPENDED' else 'DEADLINE_SUSPENDED' end);
  end if;
  if p_change_kind = 'SUSPENSION' then
    if p_new_due_at is not null then perform api._fail('INVALID', 'new_due_at'); end if;
  elsif p_new_due_at is null or p_new_due_at <= now()
        or (p_change_kind = 'EXTENSION' and p_new_due_at <= v_n.due_at) then
    perform api._fail('INVALID', 'new_due_at');
  end if;
  select coalesce(max(c.sequence_no), 0) + 1 into v_seq from grievance.defence_deadline_change c where c.notice_id = v_n.id;
  insert into grievance.defence_deadline_change (notice_id, case_id, sequence_no, change_kind, previous_due_at, new_due_at,
                                                 reason, decided_by)
  values (v_n.id, v_n.case_id, v_seq, p_change_kind, v_n.due_at, p_new_due_at,
          api._require_text(p_reason, 'reason', 10, 2000), v_actor)
  returning id into v_id;
  update grievance.defence_notice
     set due_at = coalesce(p_new_due_at, v_n.due_at),
         suspended_at = case when p_change_kind = 'SUSPENSION' then now() end
   where id = v_n.id;
  perform audit.record_event('DEFENCE_DEADLINE_CHANGED', 'BUSINESS', 'SUCCESS', v_n.case_id, 'defence_notice',
    v_n.id::text, null, jsonb_build_object('change_id', v_id, 'change_kind', p_change_kind, 'sequence_no', v_seq,
                                           'previous_due_at', v_n.due_at, 'new_due_at', p_new_due_at));
  return v_id;
end;
$$;
grant execute on function api.change_defence_deadline(uuid, text, timestamptz, text) to authenticated;

-- The subject responds or declines through the portal; a late response may give a reason. While the period is
-- suspended a response is not late.
create function api.submit_defence_response(p_notice_id uuid, p_response_text text, p_response_kind text,
                                            p_late_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_n grievance.defence_notice;
  v_late boolean;
  v_id uuid;
begin
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id;
  if v_n.id is null or not authz.is_portal_subject(v_n.subject_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id for update;
  if v_n.status not in ('ISSUED', 'ACKNOWLEDGED') then perform api._fail('CONFLICT', 'NOTICE_NOT_OPEN'); end if;
  if p_response_kind is null or p_response_kind not in ('RESPONSE', 'DECLINED') then
    perform api._fail('INVALID', 'response_kind');
  end if;
  v_late := v_n.suspended_at is null and now() > v_n.due_at;
  if p_late_reason is not null and not coalesce(v_late, false) then perform api._fail('INVALID', 'late_reason'); end if;
  insert into grievance.defence_response (notice_id, case_id, channel, original_submission_date, response_text, is_late,
                                          recorded_by, response_kind, late_reason)
  values (v_n.id, v_n.case_id, 'EMPLOYEE_PORTAL', now(), api._require_text(p_response_text, 'response_text', 10, 20000),
          coalesce(v_late, false), v_actor, p_response_kind,
          case when p_late_reason is not null then api._require_text(p_late_reason, 'late_reason', 10, 2000) end)
  returning id into v_id;
  update grievance.defence_notice
     set status = 'RESPONDED', acknowledged_at = coalesce(acknowledged_at, now()), closed_at = now()
   where id = v_n.id;
  perform audit.record_event('DEFENCE_RESPONSE_SUBMITTED', 'BUSINESS', 'SUCCESS', v_n.case_id, 'defence_response',
    v_id::text, null, jsonb_build_object('notice_id', v_n.id, 'channel', 'EMPLOYEE_PORTAL', 'is_late', coalesce(v_late, false),
                                         'response_kind', p_response_kind, 'late_reason_given', p_late_reason is not null));
  return v_id;
end;
$$;
grant execute on function api.submit_defence_response(uuid, text, text, text) to authenticated;

-- Replaced from 1910: delegates to the overload above as a RESPONSE without a late reason.
create or replace function api.submit_defence_response(p_notice_id uuid, p_response_text text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  return api.submit_defence_response(p_notice_id, p_response_text, 'RESPONSE', null);
end;
$$;

create function api.record_defence_response(p_notice_id uuid, p_channel text, p_original_submission_date timestamptz,
                                            p_response_text text, p_original_document_reference text,
                                            p_response_kind text, p_late_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_n grievance.defence_notice;
  v_late boolean;
  v_id uuid;
begin
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id;
  if v_n.id is null or not authz.can_view_case(v_n.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_manage_defence(v_n.case_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id for update;
  if v_n.status not in ('ISSUED', 'ACKNOWLEDGED') then perform api._fail('CONFLICT', 'NOTICE_NOT_OPEN'); end if;
  if p_channel is null or p_channel not in ('EMAIL', 'PHYSICAL_SUBMISSION', 'SECRETARY_ENTRY', 'BCP_IMPORT',
                                            'OTHER_AUTHORIZED_CHANNEL') then
    perform api._fail('INVALID', 'channel');
  end if;
  if p_original_submission_date is null or p_original_submission_date > now()
     or p_original_submission_date < v_n.issued_at then
    perform api._fail('INVALID', 'original_submission_date');
  end if;
  if p_response_kind is null or p_response_kind not in ('RESPONSE', 'DECLINED') then
    perform api._fail('INVALID', 'response_kind');
  end if;
  v_late := v_n.suspended_at is null and p_original_submission_date > v_n.due_at;
  if p_late_reason is not null and not coalesce(v_late, false) then perform api._fail('INVALID', 'late_reason'); end if;
  insert into grievance.defence_response (notice_id, case_id, channel, original_submission_date, response_text,
                                          original_document_reference, is_late, recorded_by, response_kind, late_reason)
  values (v_n.id, v_n.case_id, p_channel, p_original_submission_date,
          api._require_text(p_response_text, 'response_text', 10, 20000),
          api._require_text(p_original_document_reference, 'original_document_reference', 3, 300),
          coalesce(v_late, false), v_actor, p_response_kind,
          case when p_late_reason is not null then api._require_text(p_late_reason, 'late_reason', 10, 2000) end)
  returning id into v_id;
  update grievance.defence_notice
     set status = 'RESPONDED', closed_at = now()
   where id = v_n.id;
  perform audit.record_event('DEFENCE_RESPONSE_RECORDED', 'BUSINESS', 'SUCCESS', v_n.case_id, 'defence_response',
    v_id::text, null, jsonb_build_object('notice_id', v_n.id, 'channel', p_channel, 'is_late', coalesce(v_late, false),
                                         'response_kind', p_response_kind, 'late_reason_given', p_late_reason is not null));
  return v_id;
end;
$$;
grant execute on function api.record_defence_response(uuid, text, timestamptz, text, text, text, text) to authenticated;

-- Replaced from 1910: delegates to the overload above as a RESPONSE without a late reason.
create or replace function api.record_defence_response(p_notice_id uuid, p_channel text,
                                                       p_original_submission_date timestamptz, p_response_text text,
                                                       p_original_document_reference text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  return api.record_defence_response(p_notice_id, p_channel, p_original_submission_date, p_response_text,
                                     p_original_document_reference, 'RESPONSE', null);
end;
$$;

-- =============================================================================
-- Item 6. Sanctions and their execution: DEC-AMB-004, DEC-AMB-009 and DEC-AMB-011 (owner, 2026-10-13), and the
-- delivery guard (AMB-031, AMB-109, AMB-110, AMB-149; T-AMB-013, T-AMB-062, T-AMB-063, T-AMB-088). DEC-AMB-001 (the
-- reconsideration, AMB-145, T-AMB-085) is in the grievance section above.
-- =============================================================================
-- DEC-AMB-004 (owner, 2026-10-13), configuration SANCTION_GRIEVANCE_SUSPENSION: the effect of a grievance on executing a
-- sanction is configured per sanction type. An irreversible (or materially difficult to reverse) sanction stays
-- suspended during the grievance window and, once a grievance is filed, until it is resolved; a reversible one follows
-- its configured rule (SUSPEND_UNTIL_RESOLVED or PROCEED). Seeded SOURCE_REQUIRED: no rule is invented; a type with no
-- rule, or a sanction outside the catalogue, is held as irreversible (fail closed); TERMINATION is marked irreversible
-- as the fail-safe default. DEC-AMB-011 (owner, 2026-10-13), configuration SANCTION_SEVERITY_RANK: a rank per type,
-- seeded unranked; null means "not comparable", never "equal".
alter table decision.sanction_catalogue
  add column severity_rank            int check (severity_rank between 1 and 100),
  add column is_irreversible          boolean not null default false,
  add column grievance_execution_rule text check (grievance_execution_rule in ('SUSPEND_UNTIL_RESOLVED', 'PROCEED')),
  add column rule_source_status       text not null default 'SOURCE_REQUIRED'
    check (rule_source_status in ('SOURCE_REQUIRED', 'APPROVED')),
  add constraint sanction_catalogue_irreversible_suspended
    check (not is_irreversible or grievance_execution_rule is distinct from 'PROCEED');
comment on column decision.sanction_catalogue.severity_rank is
  'SANCTION_SEVERITY_RANK: relative severity, higher = more severe (DEC-AMB-011 (owner, 2026-10-13), AMB-149, migration '
  '2040). Null = not comparable (SOURCE_REQUIRED): a grievance outcome cannot change the sanction to or from this type.';
comment on column decision.sanction_catalogue.is_irreversible is
  'Irreversible or materially difficult to reverse (DEC-AMB-004 (owner, 2026-10-13), AMB-110, migration 2040): never '
  'executed while a grievance window or grievance on it is open. TERMINATION is marked as the fail-safe default.';
comment on column decision.sanction_catalogue.grievance_execution_rule is
  'SANCTION_GRIEVANCE_SUSPENSION: whether a reversible sanction waits for the grievance window and any grievance '
  '(SUSPEND_UNTIL_RESOLVED) or is executed regardless (PROCEED) (DEC-AMB-004 (owner, 2026-10-13)). Null = '
  'SOURCE_REQUIRED: held as irreversible, suspended (fail closed).';
comment on column decision.sanction_catalogue.rule_source_status is
  'Source status of severity_rank, is_irreversible and grievance_execution_rule (migration 2040).';
update decision.sanction_catalogue set is_irreversible = true where code = 'TERMINATION';

-- Every change of those attributes, by a COMMITTEE_ADMIN holder, with its reason (append-only).
create table decision.sanction_rule_change (
  id                       uuid primary key default gen_random_uuid(),
  sanction_code            text not null references decision.sanction_catalogue (code),
  severity_rank            int check (severity_rank between 1 and 100),
  is_irreversible          boolean not null,
  grievance_execution_rule text not null check (grievance_execution_rule in ('SUSPEND_UNTIL_RESOLVED', 'PROCEED')),
  source_status            text not null check (source_status in ('SOURCE_REQUIRED', 'APPROVED')),
  reason                   text not null check (length(reason) between 5 and 2000),
  changed_by               uuid not null references iam.user_profile (id),
  changed_at               timestamptz not null default now(),
  check (not is_irreversible or grievance_execution_rule = 'SUSPEND_UNTIL_RESOLVED')
);
create index sanction_rule_change_code on decision.sanction_rule_change (sanction_code);
create index sanction_rule_change_changed_by on decision.sanction_rule_change (changed_by);
comment on table decision.sanction_rule_change is
  'Changes of a sanction''s severity rank, irreversibility and grievance execution rule (DEC-AMB-004, DEC-AMB-011 '
  '(owner, 2026-10-13), migration 2040). Append-only; the reason stays here.';

-- DEC-AMB-009 (owner, 2026-10-13): a subject who leaves employment keeps the investigation going through findings and
-- recommendations; a sanction may be recorded and decided, but it is not executable (nor shown as executable) where
-- the employment relationship no longer permits it. Fail closed: not executable, unless a recorded statement says the
-- relationship still permits executing that sanction type for that subject. There is no authority override.
-- Governance and corrective actions are not affected.
create table case_mgmt.subject_employment_event (
  id               uuid primary key default gen_random_uuid(),
  subject_id       uuid not null unique references case_mgmt.case_subject (id),
  case_id          uuid not null references case_mgmt.case_record (id),
  event_type       text not null default 'LEFT_EMPLOYMENT' check (event_type in ('LEFT_EMPLOYMENT')),
  left_on          date not null,
  source_reference text not null check (length(source_reference) between 3 and 300),
  recorded_by      uuid not null references iam.user_profile (id),
  recorded_at      timestamptz not null default now()
);
create index subject_employment_event_case on case_mgmt.subject_employment_event (case_id);
create index subject_employment_event_recorded_by on case_mgmt.subject_employment_event (recorded_by);
comment on table case_mgmt.subject_employment_event is
  'A subject flagged LEFT_EMPLOYMENT (AMB-031; DEC-AMB-009 (owner, 2026-10-13), migration 2040). The investigation, '
  'findings, recommendations and corrective actions continue; no sanction on the subject is executable without an '
  'employment execution statement for its type. Append-only.';

create table decision.employment_execution_statement (
  id                        uuid primary key default gen_random_uuid(),
  subject_id                uuid not null references case_mgmt.case_subject (id),
  case_id                   uuid not null references case_mgmt.case_record (id),
  sanction_code             text not null references decision.sanction_catalogue (code),
  source_document_reference text not null check (length(source_document_reference) between 3 and 300),
  reason                    text not null check (length(reason) between 10 and 2000),
  recorded_by               uuid not null references iam.user_profile (id),
  recorded_at               timestamptz not null default now(),
  unique (subject_id, sanction_code)
);
create index employment_execution_statement_case on decision.employment_execution_statement (case_id);
create index employment_execution_statement_code on decision.employment_execution_statement (sanction_code);
create index employment_execution_statement_recorded_by on decision.employment_execution_statement (recorded_by);
comment on table decision.employment_execution_statement is
  'A recorded statement that the employment relationship of a subject who left employment still permits executing a '
  'sanction type (DEC-AMB-009 (owner, 2026-10-13), migration 2040). Strictly a statement with its source document; '
  'not an authority override. Append-only; the reason stays here.';

-- A minimal execution record: one per sanction item and subject, append-only.
create table decision.sanction_execution (
  id                     uuid primary key default gen_random_uuid(),
  item_id                uuid not null references decision.recommendation_item (id),
  subject_id             uuid not null references case_mgmt.case_subject (id),
  case_id                uuid not null references case_mgmt.case_record (id),
  authority_decision_id  uuid not null references decision.authority_decision (id),
  decision_notice_id     uuid references grievance.defence_notice (id),
  executed_sanction_code text references decision.sanction_catalogue (code),
  effective_from         timestamptz not null,
  execution_reference    text not null check (length(execution_reference) between 3 and 300),
  recorded_by            uuid not null references iam.user_profile (id),
  recorded_at            timestamptz not null default now(),
  unique (item_id, subject_id)
);
create index sanction_execution_subject on decision.sanction_execution (subject_id);
create index sanction_execution_case on decision.sanction_execution (case_id);
create index sanction_execution_decision on decision.sanction_execution (authority_decision_id);
create index sanction_execution_notice on decision.sanction_execution (decision_notice_id);
create index sanction_execution_code on decision.sanction_execution (executed_sanction_code);
create index sanction_execution_recorded_by on decision.sanction_execution (recorded_by);
comment on table decision.sanction_execution is
  'That a decided sanction was executed on a subject, from when, and which sanction after any grievance substitution '
  '(migration 2040). Guarded by decision.execution_block: never effective before the DECISION notice is delivered '
  '(AMB-109); never on a subject who left employment without a statement for the type (DEC-AMB-009); never once a '
  'grievance cancelled it or returned it for reinvestigation (DEC-AMB-011); a suspended type never while a grievance '
  'window or grievance on it is open (DEC-AMB-004).';

-- DEC-AMB-011 (owner, 2026-10-13): a grievance outcome never makes a sanction more severe. It upholds, reduces, modifies
-- to a sanction no more severe, or cancels. A modification substitutes a sanction here, guarded in the database: a
-- change between types needs both ranks and a substitute no more severe (an unranked type is not comparable and is
-- refused); within the same type the outcome declares the change REDUCE or NONE, and an INCREASE is refused. The item
-- carries no structured measure (days, amount), so a within-type reduction is declared, not computed. New facts
-- against the subject go through reinvestigation (RETURN_FOR_REINVESTIGATION opens a REINVESTIGATION proceeding with
-- its own findings and recommendations), never through a grievance outcome.
create table grievance.outcome_substitution (
  id                       uuid primary key default gen_random_uuid(),
  grievance_id             uuid not null references grievance.grievance (id),
  item_id                  uuid not null references decision.recommendation_item (id),
  original_sanction_code   text references decision.sanction_catalogue (code),
  substitute_sanction_code text not null references decision.sanction_catalogue (code),
  original_severity_rank   int,
  substitute_severity_rank int,
  within_type_change       text check (within_type_change in ('REDUCE', 'NONE')),
  recorded_by              uuid not null references iam.user_profile (id),
  recorded_at              timestamptz not null default now(),
  unique (grievance_id, item_id),
  check (substitute_severity_rank <= original_severity_rank),
  check ((within_type_change is not null) = (substitute_sanction_code is not distinct from original_sanction_code))
);
create index outcome_substitution_item on grievance.outcome_substitution (item_id);
create index outcome_substitution_original on grievance.outcome_substitution (original_sanction_code);
create index outcome_substitution_substitute on grievance.outcome_substitution (substitute_sanction_code);
create index outcome_substitution_recorded_by on grievance.outcome_substitution (recorded_by);
comment on table grievance.outcome_substitution is
  'A sanction substituted by a MODIFY grievance outcome on a contested item (DEC-AMB-011 (owner, 2026-10-13), AMB-149, '
  'migration 2040). Never more severe than the sanction in effect: between types both ranks are recorded and compared '
  '(unranked = not comparable, refused); within a type the change is REDUCE or NONE. Append-only.';

-- The sanction in effect on an item for a subject: the latest grievance substitution, else the decided sanction. A
-- reconsideration's substitution follows its grievance's.
create function decision.effective_sanction_code(p_item_id uuid, p_subject_id uuid)
returns text
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select s.substitute_sanction_code from grievance.outcome_substitution s
     join grievance.grievance g on g.id = s.grievance_id
     where s.item_id = p_item_id and g.grievant_subject_id = p_subject_id
     order by (g.reconsideration_of is not null) desc, s.recorded_at desc, s.id desc limit 1),
    (select i.sanction_code from decision.recommendation_item i where i.id = p_item_id));
$$;

create function grievance.guard_outcome_substitution()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select c.severity_rank into new.original_severity_rank
  from decision.sanction_catalogue c where c.code = new.original_sanction_code;
  select c.severity_rank into new.substitute_severity_rank
  from decision.sanction_catalogue c where c.code = new.substitute_sanction_code;
  if new.substitute_sanction_code = new.original_sanction_code then
    -- Within the same type no rank is needed: reduced or unchanged; an increase is refused.
    if new.within_type_change = 'INCREASE' then perform api._fail('CONFLICT', 'SANCTION_MORE_SEVERE'); end if;
    if new.within_type_change is null or new.within_type_change not in ('REDUCE', 'NONE') then
      perform api._fail('INVALID', 'within_type_change');
    end if;
  else
    if new.within_type_change is not null then perform api._fail('INVALID', 'within_type_change'); end if;
    if new.original_severity_rank is null or new.substitute_severity_rank is null then
      perform api._fail('CONFLICT', 'SANCTION_NOT_COMPARABLE');
    end if;
    if new.substitute_severity_rank > new.original_severity_rank then
      perform api._fail('CONFLICT', 'SANCTION_MORE_SEVERE');
    end if;
  end if;
  return new;
end;
$$;
create trigger outcome_substitution_guard before insert on grievance.outcome_substitution
  for each row execute function grievance.guard_outcome_substitution();

-- >>>>> TEMPORARY STUB: DROP THIS BLOCK AT MERGE (coordinator, 2026-10-13) >>>>>
-- decision.package_tainted(p_package_id uuid) returns boolean is defined by migration 2035
-- (20261007002035_owner_decisions_authority_part.sql, DEC-AMB-003, branch local/pra-2030-decisions), which is not in
-- this tree. Until both are in one tree this stub stands in for it with the same name, signature and meaning, less the
-- committee's resolution of a taint (decision.conflict_taint_resolution exists only in 2035): a package is tainted
-- while an active item's result was carried by a closed vote item of its current round on which someone now
-- conflicted (a declared or upheld meeting conflict, or a declared or confirmed case conflict) cast a counted vote.
-- It is created only when the function does not exist, so in the merged tree (2035 runs first) it does nothing.
do $stub$
begin
  if to_regprocedure('decision.package_tainted(uuid)') is null then
    execute $f$
      create function decision.package_tainted(p_package_id uuid)
      returns boolean
      language sql stable
      set search_path = ''
      as $b$
        select exists (
          select 1
          from decision.recommendation_item i
          join decision.recommendation_package p on p.id = i.package_id
          cross join lateral (select vi.id, vi.case_id, vi.meeting_id from committee.vote_item vi
                              where vi.package_id = p.id and vi.package_round = p.round_no and vi.status = 'CLOSED'
                                and (vi.recommendation_item_id = i.id or vi.recommendation_item_id is null)
                              order by vi.sequence_no desc limit 1) vi
          join committee.meeting m on m.id = vi.meeting_id
          where i.package_id = p_package_id and i.status = 'ACTIVE'
            and exists (select 1
                        from (select v.recorded_for as user_id from committee.vote v
                              where v.vote_item_id = vi.id and v.choice in ('APPROVE', 'REJECT', 'ABSTAIN')
                              union
                              select c.cast_by from committee.casting_vote c where c.vote_item_id = vi.id) u
                        where authz.has_meeting_conflict(u.user_id, m.committee_proceeding_id)
                           or exists (select 1 from case_mgmt.conflict_check cc
                                      where cc.case_id = vi.case_id and cc.user_id = u.user_id and cc.is_current
                                        and cc.status in ('CONFLICT_DECLARED', 'CONFLICT_CONFIRMED'))));
      $b$
    $f$;
    revoke all on function decision.package_tainted(uuid) from public, anon, authenticated;
  end if;
end;
$stub$;
-- <<<<< END OF TEMPORARY STUB <<<<<

-- Why a decided sanction may not be executed on a subject now, as a code; null when it may. The one source for the
-- execution guard and the executability read, in order: delivery (AMB-109, T-AMB-062); a package tainted by a
-- conflict (DEC-AMB-003, owner 2026-10-13: an unresolved TAINTED_BY_CONFLICT item blocks every downstream step, so the
-- execution of any sanction of that package waits until the committee resolves it; fail closed); employment
-- (DEC-AMB-009, T-AMB-013); a grievance that cancelled the item or returned it for reinvestigation (DEC-AMB-011); the
-- suspension of the sanction in effect (DEC-AMB-004, T-AMB-063). A grievance whose decision is unknown matches
-- (fail-safe).
create function decision.execution_block(p_item_id uuid, p_subject_id uuid, p_authority_decision_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_n grievance.defence_notice;
  v_c decision.sanction_catalogue;
  v_code text := decision.effective_sanction_code(p_item_id, p_subject_id);
begin
  select n.* into v_n from grievance.defence_notice n
  where n.kind = 'DECISION' and n.subject_id = p_subject_id and n.authority_decision_id = p_authority_decision_id
    and n.status <> 'WITHDRAWN'
  order by n.issued_at desc, n.id desc limit 1;
  if v_n.id is null or v_n.delivered_at is null then return 'DECISION_NOT_DELIVERED'; end if;
  if decision.package_tainted((select i.package_id from decision.recommendation_item i where i.id = p_item_id)) then
    return 'TAINTED_BY_CONFLICT';
  end if;
  if exists (select 1 from case_mgmt.subject_employment_event e
             where e.subject_id = p_subject_id and e.event_type = 'LEFT_EMPLOYMENT')
     and not exists (select 1 from decision.employment_execution_statement x
                     where x.subject_id = p_subject_id and x.sanction_code = v_code) then
    return 'SUBJECT_LEFT_EMPLOYMENT';
  end if;
  if exists (select 1 from grievance.grievance g
             join grievance.grievance_outcome o on o.grievance_id = g.id
             where g.grievant_subject_id = p_subject_id and g.status = 'DECIDED'
               and (g.contested_authority_decision_id is null or g.contested_authority_decision_id = p_authority_decision_id)
               and o.outcomes && array['CANCEL', 'RETURN_FOR_REINVESTIGATION']::text[]
               and (not exists (select 1 from grievance.contested_item c where c.grievance_id = g.id)
                    or exists (select 1 from grievance.contested_item c where c.grievance_id = g.id and c.item_id = p_item_id))) then
    return 'SANCTION_SET_ASIDE_BY_GRIEVANCE';
  end if;
  select c.* into v_c from decision.sanction_catalogue c where c.code = v_code;
  if v_c.code is null or v_c.is_irreversible or v_c.grievance_execution_rule is distinct from 'PROCEED' then
    if v_n.grievance_window_ends_at is null or now() < v_n.grievance_window_ends_at then
      return 'GRIEVANCE_WINDOW_OPEN';
    end if;
    if exists (select 1 from grievance.grievance g
               where g.grievant_subject_id = p_subject_id
                 and g.status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED')
                 and (g.contested_authority_decision_id is null
                      or g.contested_authority_decision_id = p_authority_decision_id)) then
      return 'GRIEVANCE_OPEN';
    end if;
  end if;
  return null;
end;
$$;

-- The guard on every execution row, whatever path writes it.
create function decision.guard_sanction_execution()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_n grievance.defence_notice;
  v_block text;
begin
  select n.* into v_n from grievance.defence_notice n
  where n.kind = 'DECISION' and n.subject_id = new.subject_id and n.authority_decision_id = new.authority_decision_id
    and n.status <> 'WITHDRAWN'
  order by n.issued_at desc, n.id desc limit 1;
  if v_n.id is null or v_n.delivered_at is null then perform api._fail('CONFLICT', 'DECISION_NOT_DELIVERED'); end if;
  if new.effective_from < v_n.delivered_at then perform api._fail('CONFLICT', 'EFFECTIVE_BEFORE_DELIVERY'); end if;
  v_block := decision.execution_block(new.item_id, new.subject_id, new.authority_decision_id);
  if v_block is not null then perform api._fail('CONFLICT', v_block); end if;
  new.decision_notice_id := v_n.id;
  new.executed_sanction_code := decision.effective_sanction_code(new.item_id, new.subject_id);
  return new;
end;
$$;
create trigger sanction_execution_guard before insert on decision.sanction_execution
  for each row execute function decision.guard_sanction_execution();

do $$
declare t text;
begin
  foreach t in array array['decision.sanction_rule_change', 'case_mgmt.subject_employment_event',
                           'decision.employment_execution_statement', 'decision.sanction_execution',
                           'grievance.outcome_substitution'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
    execute format('alter table %s enable row level security', t);
    execute format('grant select on %s to authenticated', t);
  end loop;
end;
$$;
create policy sanction_rule_change_read on decision.sanction_rule_change for select to authenticated
  using (authz.has_permission('COMMITTEE_ADMIN'));
create policy subject_employment_event_read on case_mgmt.subject_employment_event for select to authenticated
  using (authz.can_view_case(case_id));
create policy employment_execution_statement_read on decision.employment_execution_statement for select
  to authenticated using (authz.can_view_case(case_id));
create policy sanction_execution_read on decision.sanction_execution for select to authenticated
  using (authz.can_view_case(case_id));
create policy outcome_substitution_read on grievance.outcome_substitution for select to authenticated
  using (authz.can_view_grievance(grievance_id));

-- DEC-AMB-004 / DEC-AMB-011 (owner, 2026-10-13): a COMMITTEE_ADMIN holder configures a sanction's severity rank,
-- irreversibility and grievance execution rule, with a reason and a source status. An irreversible sanction is always
-- suspended. Configuration only: no case content is reached.
create function api.set_sanction_rule(p_code text, p_severity_rank int, p_is_irreversible boolean,
                                      p_grievance_execution_rule text, p_source_status text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_old decision.sanction_catalogue;
  v_id uuid;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  select * into v_old from decision.sanction_catalogue c where c.code = p_code for update;
  if v_old.code is null then perform api._fail('INVALID', 'code'); end if;
  if p_severity_rank is not null and p_severity_rank not between 1 and 100 then
    perform api._fail('INVALID', 'severity_rank');
  end if;
  if p_is_irreversible is null then perform api._fail('INVALID', 'is_irreversible'); end if;
  if p_grievance_execution_rule is null or p_grievance_execution_rule not in ('SUSPEND_UNTIL_RESOLVED', 'PROCEED') then
    perform api._fail('INVALID', 'grievance_execution_rule');
  end if;
  if p_is_irreversible and p_grievance_execution_rule = 'PROCEED' then
    perform api._fail('CONFLICT', 'IRREVERSIBLE_SANCTION_SUSPENDED');
  end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  insert into decision.sanction_rule_change (sanction_code, severity_rank, is_irreversible, grievance_execution_rule,
                                             source_status, reason, changed_by)
  values (v_old.code, p_severity_rank, p_is_irreversible, p_grievance_execution_rule, p_source_status,
          api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_id;
  update decision.sanction_catalogue
     set severity_rank = p_severity_rank, is_irreversible = p_is_irreversible,
         grievance_execution_rule = p_grievance_execution_rule, rule_source_status = p_source_status
   where code = v_old.code;
  perform audit.record_event('SANCTION_RULE_SET', 'ADMIN', 'SUCCESS', null, 'sanction_catalogue', v_old.code, null,
    jsonb_build_object('change_id', v_id, 'severity_rank', p_severity_rank,
                       'previous_severity_rank', v_old.severity_rank, 'is_irreversible', p_is_irreversible,
                       'previous_is_irreversible', v_old.is_irreversible,
                       'grievance_execution_rule', p_grievance_execution_rule,
                       'previous_grievance_execution_rule', v_old.grievance_execution_rule,
                       'source_status', p_source_status));
  return v_id;
end;
$$;
grant execute on function api.set_sanction_rule(text, int, boolean, text, text, text) to authenticated;

create function api.flag_subject_left_employment(p_subject_id uuid, p_left_on date, p_source_reference text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_s case_mgmt.case_subject;
  v_id uuid;
begin
  select * into v_s from case_mgmt.case_subject s where s.id = p_subject_id;
  if v_s.id is null or not authz.can_view_case(v_s.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_edit_case(v_s.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_s.case_id for update;
  if exists (select 1 from case_mgmt.subject_employment_event e where e.subject_id = v_s.id) then
    perform api._fail('CONFLICT', 'ALREADY_FLAGGED');
  end if;
  if p_left_on is null or p_left_on > (now() at time zone 'Asia/Riyadh')::date then perform api._fail('INVALID', 'left_on'); end if;
  insert into case_mgmt.subject_employment_event (subject_id, case_id, left_on, source_reference, recorded_by)
  values (v_s.id, v_s.case_id, p_left_on, api._require_text(p_source_reference, 'source_reference', 3, 300), v_actor)
  returning id into v_id;
  perform audit.record_event('SUBJECT_LEFT_EMPLOYMENT_FLAGGED', 'BUSINESS', 'SUCCESS', v_s.case_id, 'case_subject',
    v_s.id::text, null, jsonb_build_object('event_id', v_id, 'left_on', p_left_on));
  return v_id;
end;
$$;
grant execute on function api.flag_subject_left_employment(uuid, date, text) to authenticated;

-- DEC-AMB-009 (owner, 2026-10-13): whoever flagged the subject records, per sanction type, that the employment
-- relationship still permits executing it, with the source document. Nothing else makes such a sanction executable.
create function api.record_employment_execution_statement(p_subject_id uuid, p_sanction_code text,
                                                          p_source_document_reference text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_s case_mgmt.case_subject;
  v_id uuid;
begin
  select * into v_s from case_mgmt.case_subject s where s.id = p_subject_id;
  if v_s.id is null or not authz.can_view_case(v_s.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_edit_case(v_s.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_s.case_id for update;
  if not exists (select 1 from case_mgmt.subject_employment_event e
                 where e.subject_id = v_s.id and e.event_type = 'LEFT_EMPLOYMENT') then
    perform api._fail('CONFLICT', 'SUBJECT_NOT_FLAGGED');
  end if;
  if not exists (select 1 from decision.sanction_catalogue c where c.code = p_sanction_code and c.is_active) then
    perform api._fail('INVALID', 'sanction_code');
  end if;
  if exists (select 1 from decision.employment_execution_statement x
             where x.subject_id = v_s.id and x.sanction_code = p_sanction_code) then
    perform api._fail('CONFLICT', 'ALREADY_RECORDED');
  end if;
  insert into decision.employment_execution_statement (subject_id, case_id, sanction_code, source_document_reference,
                                                       reason, recorded_by)
  values (v_s.id, v_s.case_id, p_sanction_code,
          api._require_text(p_source_document_reference, 'source_document_reference', 3, 300),
          api._require_text(p_reason, 'reason', 10, 2000), v_actor)
  returning id into v_id;
  perform audit.record_event('EMPLOYMENT_EXECUTION_STATEMENT_RECORDED', 'BUSINESS', 'SUCCESS', v_s.case_id,
    'case_subject', v_s.id::text, null, jsonb_build_object('statement_id', v_id, 'sanction_code', p_sanction_code));
  return v_id;
end;
$$;
grant execute on function api.record_employment_execution_statement(uuid, text, text, text) to authenticated;

-- The sanction item a subject may be executed under, with its latest effective authority decision.
create function decision.executable_sanction(p_item_id uuid, p_subject_id uuid)
returns decision.authority_decision
language plpgsql stable
set search_path = ''
as $$
declare
  v_i decision.recommendation_item;
  v_d decision.authority_decision;
begin
  select * into v_i from decision.recommendation_item i where i.id = p_item_id;
  if v_i.item_type <> 'DISCIPLINARY_SANCTION' or v_i.status <> 'ACTIVE' or v_i.committee_result is distinct from 'APPROVED'
     or not exists (select 1 from decision.recommendation_item_subject x where x.item_id = v_i.id and x.subject_id = p_subject_id) then
    perform api._fail('INVALID', 'item_id');
  end if;
  select d.* into v_d from decision.authority_decision d
  where d.package_id = v_i.package_id
  order by d.package_round desc, d.recorded_at desc, d.id desc limit 1;
  if v_d.id is null or v_d.outcome in ('RETURN_TO_COMMITTEE', 'REJECT') then
    perform api._fail('CONFLICT', 'NO_AUTHORITY_DECISION');
  end if;
  if exists (select 1 from decision.authority_item_decision a
             where a.decision_id = v_d.id and a.item_id = v_i.id and a.outcome = 'REJECTED') then
    perform api._fail('CONFLICT', 'ITEM_REJECTED_BY_AUTHORITY');
  end if;
  return v_d;
end;
$$;

-- Whoever notifies the decision records its execution; the guard refuses what the owner rules forbid.
create function api.record_sanction_execution(p_item_id uuid, p_subject_id uuid, p_effective_from timestamptz,
                                              p_execution_reference text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_i decision.recommendation_item;
  v_d decision.authority_decision;
  v decision.sanction_execution;
begin
  select * into v_i from decision.recommendation_item i where i.id = p_item_id;
  if v_i.id is null or not authz.can_view_case(v_i.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_manage_defence(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_i.case_id for update;
  v_d := decision.executable_sanction(v_i.id, p_subject_id);
  if exists (select 1 from decision.sanction_execution e where e.item_id = v_i.id and e.subject_id = p_subject_id) then
    perform api._fail('CONFLICT', 'ALREADY_EXECUTED');
  end if;
  if p_effective_from is null then perform api._fail('INVALID', 'effective_from'); end if;
  insert into decision.sanction_execution (item_id, subject_id, case_id, authority_decision_id, effective_from,
                                           execution_reference, recorded_by)
  values (v_i.id, p_subject_id, v_i.case_id, v_d.id, p_effective_from,
          api._require_text(p_execution_reference, 'execution_reference', 3, 300), v_actor)
  returning * into v;
  perform audit.record_event('SANCTION_EXECUTION_RECORDED', 'BUSINESS', 'SUCCESS', v_i.case_id, 'recommendation_item',
    v_i.id::text, null, jsonb_build_object('execution_id', v.id, 'subject_id', p_subject_id,
                                           'authority_decision_id', v_d.id, 'decision_notice_id', v.decision_notice_id,
                                           'executed_sanction_code', v.executed_sanction_code,
                                           'effective_from', p_effective_from));
  return v.id;
end;
$$;
grant execute on function api.record_sanction_execution(uuid, uuid, timestamptz, text) to authenticated;

-- What a case viewer is shown about executing each decided sanction (DEC-AMB-009: never shown as executable where the
-- guard would refuse it). Read-only; codes and ids only.
create function api.sanction_executability(p_case_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'item_id', x.item_id, 'subject_id', x.subject_id, 'authority_decision_id', x.decision_id,
             'decided_sanction_code', x.sanction_code,
             'sanction_code', decision.effective_sanction_code(x.item_id, x.subject_id),
             'executed', x.executed, 'blocked_by', case when not x.executed then x.block end,
             'executable', not x.executed and x.block is null)
           order by x.item_id, x.subject_id)
    from (select i.id as item_id, s.subject_id, i.sanction_code, d.id as decision_id,
                 exists (select 1 from decision.sanction_execution e
                         where e.item_id = i.id and e.subject_id = s.subject_id) as executed,
                 decision.execution_block(i.id, s.subject_id, d.id) as block
          from decision.recommendation_item i
          join decision.recommendation_item_subject s on s.item_id = i.id
          cross join lateral (select ad.* from decision.authority_decision ad where ad.package_id = i.package_id
                              order by ad.package_round desc, ad.recorded_at desc, ad.id desc limit 1) d
          where i.case_id = p_case_id and i.item_type = 'DISCIPLINARY_SANCTION' and i.status = 'ACTIVE'
            and i.committee_result = 'APPROVED' and d.outcome not in ('RETURN_TO_COMMITTEE', 'REJECT')
            and not exists (select 1 from decision.authority_item_decision a
                            where a.decision_id = d.id and a.item_id = i.id and a.outcome = 'REJECTED')) x),
    '[]'::jsonb);
end;
$$;
grant execute on function api.sanction_executability(uuid) to authenticated;

-- A MODIFY outcome may name substitute sanctions for contested items (AMB-143; DEC-AMB-011 (owner, 2026-10-13)): each
-- {item_id, sanction_code[, within_type_change]} is compared with the sanction in effect (after an earlier grievance's
-- substitution) by the guard above, never more severe. The outcome itself is recorded by the 1910 command, unchanged.
create function api.record_grievance_outcome(p_grievance_id uuid, p_outcomes text[], p_reinvestigation_path text,
                                             p_vote_item_id uuid, p_summary text, p_substitutions jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_g grievance.grievance;
  v_pkg uuid;
  v_id uuid;
  e jsonb;
  v_code text;
  v_sub grievance.outcome_substitution;
begin
  v_g := grievance.lock_handled_grievance(p_grievance_id);
  if p_substitutions is not null then
    select d.package_id into v_pkg from decision.authority_decision d where d.id = v_g.contested_authority_decision_id;
    if jsonb_typeof(p_substitutions) <> 'array' or jsonb_array_length(p_substitutions) = 0
       or not ('MODIFY' = any (coalesce(p_outcomes, '{}'))) or v_pkg is null
       or (select count(distinct x ->> 'item_id') from jsonb_array_elements(p_substitutions) x)
          <> jsonb_array_length(p_substitutions) then
      perform api._fail('INVALID', 'substitutions');
    end if;
    for e in select x from jsonb_array_elements(p_substitutions) x loop
      if jsonb_typeof(e) <> 'object' or coalesce(e ->> 'item_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or not exists (select 1 from decision.sanction_catalogue c where c.code = e ->> 'sanction_code' and c.is_active)
         or (e ? 'within_type_change' and coalesce(e ->> 'within_type_change', '') not in ('REDUCE', 'NONE', 'INCREASE')) then
        perform api._fail('INVALID', 'substitutions');
      end if;
      if not exists (
           select 1 from decision.recommendation_item i
           where i.id = (e ->> 'item_id')::uuid and i.package_id = v_pkg
             and i.item_type = 'DISCIPLINARY_SANCTION' and i.status = 'ACTIVE'
             and exists (select 1 from decision.recommendation_item_subject s
                         where s.item_id = i.id and s.subject_id = v_g.grievant_subject_id)
             and (not exists (select 1 from grievance.contested_item c where c.grievance_id = v_g.id)
                  or exists (select 1 from grievance.contested_item c where c.grievance_id = v_g.id and c.item_id = i.id))) then
        perform api._fail('INVALID', 'substitutions');
      end if;
    end loop;
  end if;
  v_id := api.record_grievance_outcome(p_grievance_id, p_outcomes, p_reinvestigation_path, p_vote_item_id, p_summary);
  for e in select x from jsonb_array_elements(coalesce(p_substitutions, '[]'::jsonb)) x loop
    v_code := decision.effective_sanction_code((e ->> 'item_id')::uuid, v_g.grievant_subject_id);
    insert into grievance.outcome_substitution (grievance_id, item_id, original_sanction_code, substitute_sanction_code,
                                                within_type_change, recorded_by)
    values (v_g.id, (e ->> 'item_id')::uuid, v_code, e ->> 'sanction_code', e ->> 'within_type_change', v_actor)
    returning * into v_sub;
    perform audit.record_event('GRIEVANCE_OUTCOME_SUBSTITUTION', 'BUSINESS', 'SUCCESS', v_g.case_id, 'grievance',
      v_g.id::text, null, jsonb_build_object('substitution_id', v_sub.id, 'item_id', v_sub.item_id,
                                             'original_sanction_code', v_sub.original_sanction_code,
                                             'substitute_sanction_code', v_sub.substitute_sanction_code,
                                             'original_severity_rank', v_sub.original_severity_rank,
                                             'substitute_severity_rank', v_sub.substitute_severity_rank,
                                             'within_type_change', v_sub.within_type_change));
  end loop;
  return v_id;
end;
$$;
grant execute on function api.record_grievance_outcome(uuid, text[], text, uuid, text, jsonb) to authenticated;

-- =============================================================================
-- Item 8. Corrective actions: reminder cadence and escalation (DEC-F26, AMB-180), evidence types (DEC-F27), owner kinds
-- (DEC-F28, CON-009). DEC-F29 is unchanged. Everything is seeded off: no CDF cadence or recipient is invented.
-- =============================================================================
alter table decision.corrective_action_policy
  add column reminder_repeat_days int check (reminder_repeat_days between 1 and 90),
  add column overdue_after_days int check (overdue_after_days between 0 and 365),
  add column allowed_evidence_types text[];
comment on column decision.corrective_action_policy.reminder_repeat_days is
  'After the first due-soon reminder, repeat it every N days until the due date (DEC-F26). Null = no repeat.';
comment on column decision.corrective_action_policy.overdue_after_days is
  'Days after the due date at which the owner is told the action is overdue (DEC-F26). Null = off.';
comment on column decision.corrective_action_policy.allowed_evidence_types is
  'Evidence types accepted for completion (DEC-F27). Null = any catalogue type, and none required.';

-- The evidence-type catalogue (DEC-F27); reference data.
create table decision.corrective_evidence_type (
  code       text primary key check (code ~ '^[A-Z][A-Z_]{2,59}$'),
  name_en    text not null check (length(name_en) between 2 and 120),
  name_ar    text not null check (length(name_ar) between 2 and 120),
  is_active  boolean not null default true
);
insert into decision.corrective_evidence_type (code, name_en, name_ar) values
  ('DOCUMENT', 'Document', 'مستند'),
  ('REVISED_PROCEDURE', 'Revised procedure', 'إجراء معدل'),
  ('SCREENSHOT_OR_SYSTEM_EVIDENCE', 'Screenshot or system evidence', 'لقطة شاشة أو دليل من النظام'),
  ('TRAINING_EVIDENCE', 'Training evidence', 'دليل تدريب'),
  ('CONTROL_EVIDENCE', 'Control evidence', 'دليل رقابي'),
  ('OTHER_AUTHORIZED_ARTIFACT', 'Other authorized artifact', 'مستند آخر معتمد');
create trigger no_delete before delete on decision.corrective_evidence_type
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on decision.corrective_evidence_type
  for each statement execute function committee.reject_mutation();
alter table decision.corrective_evidence_type enable row level security;
create policy corrective_evidence_type_read on decision.corrective_evidence_type for select to authenticated
  using (authz.current_user_id() is not null);
grant select on decision.corrective_evidence_type to authenticated;

alter table decision.corrective_action_event
  add column evidence_type text references decision.corrective_evidence_type (code);
create index corrective_action_event_evidence_type on decision.corrective_action_event (evidence_type);
alter table decision.corrective_action_event
  add constraint corrective_action_event_evidence_type_needs_reference
  check (evidence_type is null or evidence_reference is not null);
-- Widened under the same name: the owner kind of an action can change (DEC-F28).
alter table decision.corrective_action_event drop constraint corrective_action_event_event_type_check;
alter table decision.corrective_action_event add constraint corrective_action_event_event_type_check
  check (event_type in ('OPENED', 'OWNER_CHANGED', 'DUE_DATE_CHANGED', 'PROGRESS', 'COMPLETION_SUBMITTED', 'VERIFIED',
                        'RETURNED', 'REOPENED', 'WAIVED', 'OWNER_KIND_CHANGED'));

-- Escalation steps of a policy version (DEC-F26): after N days overdue, notify the owner, the case's action managers or
-- the holders of a role who can see the case. None are seeded.
create table decision.corrective_action_escalation_step (
  id                 uuid primary key default gen_random_uuid(),
  policy_id          uuid not null references decision.corrective_action_policy (id),
  step_no            int not null check (step_no between 1 and 10),
  after_days_overdue int not null check (after_days_overdue between 0 and 365),
  recipient_kind     text not null check (recipient_kind in ('OWNER', 'CASE_MANAGERS', 'ROLE')),
  role_code          text references iam.role (code),
  unique (policy_id, step_no),
  check ((recipient_kind = 'ROLE') = (role_code is not null))
);
create index corrective_action_escalation_step_role on decision.corrective_action_escalation_step (role_code);
comment on table decision.corrective_action_escalation_step is
  'Escalation path of a corrective-action policy version (DEC-F26, AMB-180, migration 2040). Seeded empty (off). '
  'Recipients are notified only when they pass the case gate; the notice carries ids only.';

-- Owner kinds (DEC-F28, CON-009): a shared pool of named, eligible users.
create table decision.corrective_action_pool (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  name       text not null check (length(name) between 3 and 200),
  is_active  boolean not null default true,
  reason     text not null check (length(reason) between 5 and 2000),
  created_by uuid not null references iam.user_profile (id),
  created_at timestamptz not null default now()
);
create index corrective_action_pool_created_by on decision.corrective_action_pool (created_by);
create table decision.corrective_action_pool_member (
  id             uuid primary key default gen_random_uuid(),
  pool_id        uuid not null references decision.corrective_action_pool (id),
  user_id        uuid not null references iam.user_profile (id),
  reason         text not null check (length(reason) between 5 and 2000),
  added_by       uuid not null references iam.user_profile (id),
  added_at       timestamptz not null default now(),
  removed_by     uuid references iam.user_profile (id),
  removed_at     timestamptz,
  removal_reason text check (length(removal_reason) between 5 and 2000),
  check ((removed_at is null) = (removed_by is null) and (removed_at is null) = (removal_reason is null))
);
create unique index corrective_action_pool_member_active on decision.corrective_action_pool_member (pool_id, user_id)
  where removed_at is null;
create index corrective_action_pool_member_user on decision.corrective_action_pool_member (user_id);
create index corrective_action_pool_member_added_by on decision.corrective_action_pool_member (added_by);
create index corrective_action_pool_member_removed_by on decision.corrective_action_pool_member (removed_by);
comment on table decision.corrective_action_pool is
  'An authorized shared pool that may own corrective actions (DEC-F28, migration 2040). Members act only while they '
  'hold CORRECTIVE_ACTION_OWN and pass the case gate; the action keeps an accountable user.';

alter table decision.corrective_action
  add column owner_kind text not null default 'USER'
    check (owner_kind in ('USER', 'ORG_UNIT', 'SHARED_POOL', 'EXTERNAL_PARTY')),
  add column owner_sector_id uuid references iam.sector (id),
  add column owner_pool_id uuid references decision.corrective_action_pool (id),
  add column external_party_label text check (length(external_party_label) between 2 and 200);
create index corrective_action_owner_sector on decision.corrective_action (owner_sector_id);
create index corrective_action_owner_pool on decision.corrective_action (owner_pool_id);
alter table decision.corrective_action add constraint corrective_action_owner_kind_shape check (
  (owner_kind = 'ORG_UNIT') = (owner_sector_id is not null)
  and (owner_kind = 'SHARED_POOL') = (owner_pool_id is not null)
  and (owner_kind = 'EXTERNAL_PARTY') = (external_party_label is not null));
comment on column decision.corrective_action.owner_kind is
  'USER, ORG_UNIT (a sector), SHARED_POOL or EXTERNAL_PARTY (DEC-F28). owner_id stays the accountable user in every '
  'kind; members of the unit or pool may act when eligible for the case.';

create trigger no_update before update on decision.corrective_action_escalation_step
  for each row execute function committee.reject_mutation();
do $$
declare t text;
begin
  foreach t in array array['corrective_action_escalation_step', 'corrective_action_pool', 'corrective_action_pool_member'] loop
    execute format('create trigger no_delete before delete on decision.%I for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on decision.%I for each statement execute function committee.reject_mutation()', t);
    execute format('alter table decision.%I enable row level security', t);
    execute format('grant select on decision.%I to authenticated', t);
  end loop;
end;
$$;
create function decision.protect_pool_records()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'corrective_action_pool' then
    raise exception 'pool % is fixed', old.id using errcode = 'insufficient_privilege';
  elsif old.removed_at is not null
     or (to_jsonb(new) - array['removed_by', 'removed_at', 'removal_reason'])
        <> (to_jsonb(old) - array['removed_by', 'removed_at', 'removal_reason']) then
    raise exception 'pool membership % can only be ended, once', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger corrective_action_pool_protect before update on decision.corrective_action_pool
  for each row execute function decision.protect_pool_records();
create trigger corrective_action_pool_member_protect before update on decision.corrective_action_pool_member
  for each row execute function decision.protect_pool_records();
create policy corrective_action_escalation_step_read on decision.corrective_action_escalation_step for select
  to authenticated using (authz.current_user_id() is not null);
create policy corrective_action_pool_read on decision.corrective_action_pool for select to authenticated
  using (authz.current_user_id() is not null);
create policy corrective_action_pool_member_read on decision.corrective_action_pool_member for select to authenticated
  using (user_id = authz.current_user_id() or authz.has_permission('CORRECTIVE_ACTION_POLICY_ADMIN')
         or authz.has_permission('CORRECTIVE_ACTION_MANAGE'));

-- Whether a user acts for an action: its accountable owner, or a current member of its unit or pool.
create function decision.acts_for_action(p_action decision.corrective_action, p_user_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_user_id is not null
     and (p_action.owner_id = p_user_id
          or (p_action.owner_kind = 'SHARED_POOL'
              and exists (select 1 from decision.corrective_action_pool_member m
                          join decision.corrective_action_pool p on p.id = m.pool_id and p.is_active
                          where m.pool_id = p_action.owner_pool_id and m.user_id = p_user_id and m.removed_at is null))
          or (p_action.owner_kind = 'ORG_UNIT'
              and exists (select 1 from iam.sector_membership sm
                          where sm.sector_id = p_action.owner_sector_id and sm.user_id = p_user_id
                            and sm.effective_from <= now() and (sm.effective_to is null or sm.effective_to > now()))));
$$;

-- Replaced from 1940: members of the owning unit or pool see the action on the same terms as its owner
-- (CORRECTIVE_ACTION_OWN and their own case gate). The case-view branch is unchanged.
create or replace function authz.can_view_corrective_action(p_action_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from decision.corrective_action a
    where a.id = p_action_id
      and (authz.can_view_case(a.case_id)
           or (decision.acts_for_action(a, authz.current_user_id()) and authz.has_permission('CORRECTIVE_ACTION_OWN')
               and authz.user_case_gate(authz.current_user_id(), a.case_id)))
  );
$$;

-- Replaced from 1940: whoever acts for the action (owner, or unit or pool member) passes, each under their own case
-- gate and CORRECTIVE_ACTION_OWN.
create or replace function decision.require_owner(p_action decision.corrective_action)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not decision.acts_for_action(p_action, authz.current_user_id()) or not authz.has_permission('CORRECTIVE_ACTION_OWN')
     or not authz.user_case_gate(authz.current_user_id(), p_action.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
end;
$$;

-- The policy command with the 2040 options. A version is immutable: its steps are written with it.
create function api.set_corrective_action_policy(p_action_type text, p_default_due_days int, p_reminder_days_before int,
                                                 p_escalate_after_days int, p_completion_evidence text,
                                                 p_effective_from timestamptz, p_source_status text, p_reason text,
                                                 p_reminder_repeat_days int, p_overdue_after_days int,
                                                 p_allowed_evidence_types text[], p_escalation_steps jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_reason text;
  v_steps jsonb := coalesce(p_escalation_steps, '[]'::jsonb);
  e jsonb;
  v_no int := 0;
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
  if p_reminder_repeat_days is not null and (p_reminder_repeat_days not between 1 and 90 or p_reminder_days_before is null) then
    perform api._fail('INVALID', 'reminder_repeat_days');
  end if;
  if p_overdue_after_days is not null and p_overdue_after_days not between 0 and 365 then
    perform api._fail('INVALID', 'overdue_after_days');
  end if;
  if p_allowed_evidence_types is not null
     and (cardinality(p_allowed_evidence_types) = 0
          or (select count(distinct x) from unnest(p_allowed_evidence_types) x) <> cardinality(p_allowed_evidence_types)
          or exists (select 1 from unnest(p_allowed_evidence_types) x
                     where not exists (select 1 from decision.corrective_evidence_type t where t.code = x and t.is_active))) then
    perform api._fail('INVALID', 'allowed_evidence_types');
  end if;
  if jsonb_typeof(v_steps) <> 'array' or jsonb_array_length(v_steps) > 10 then
    perform api._fail('INVALID', 'escalation_steps');
  end if;
  for e in select x from jsonb_array_elements(v_steps) x loop
    if jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'after_days_overdue') <> 'number'
       or (e ->> 'after_days_overdue') !~ '^[0-9]{1,3}$' or (e ->> 'after_days_overdue')::int > 365
       or coalesce(e ->> 'recipient_kind', '') not in ('OWNER', 'CASE_MANAGERS', 'ROLE')
       or ((e ->> 'recipient_kind') = 'ROLE') <> (e ->> 'role_code' is not null)
       or (e ->> 'role_code' is not null and not exists (select 1 from iam.role r where r.code = e ->> 'role_code')) then
      perform api._fail('INVALID', 'escalation_steps');
    end if;
  end loop;
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
                                                 effective_from, created_by, reminder_repeat_days, overdue_after_days,
                                                 allowed_evidence_types)
  values (p_action_type, p_default_due_days, p_reminder_days_before, p_escalate_after_days, p_completion_evidence,
          p_source_status, v_reason, p_effective_from, v_actor, p_reminder_repeat_days, p_overdue_after_days,
          p_allowed_evidence_types)
  returning id into v_id;
  for e in select x from jsonb_array_elements(v_steps) x loop
    v_no := v_no + 1;
    insert into decision.corrective_action_escalation_step (policy_id, step_no, after_days_overdue, recipient_kind, role_code)
    values (v_id, v_no, (e ->> 'after_days_overdue')::int, e ->> 'recipient_kind', e ->> 'role_code');
  end loop;
  perform audit.record_event('CORRECTIVE_ACTION_POLICY_SET', 'ADMIN', 'SUCCESS', null, 'corrective_action_policy',
    v_id::text, v_reason,
    jsonb_build_object('action_type', p_action_type, 'default_due_days', p_default_due_days,
                       'reminder_days_before', p_reminder_days_before, 'escalate_after_days', p_escalate_after_days,
                       'completion_evidence', p_completion_evidence, 'effective_from', p_effective_from,
                       'source_status', p_source_status, 'reminder_repeat_days', p_reminder_repeat_days,
                       'overdue_after_days', p_overdue_after_days,
                       'allowed_evidence_types', to_jsonb(p_allowed_evidence_types), 'escalation_steps', v_no));
  return v_id;
end;
$$;
grant execute on function api.set_corrective_action_policy(text, int, int, int, text, timestamptz, text, text, int, int,
                                                            text[], jsonb) to authenticated;

-- Replaced from 1940: delegates to the overload above with the 2040 options off.
create or replace function api.set_corrective_action_policy(p_action_type text, p_default_due_days int,
                                                            p_reminder_days_before int, p_escalate_after_days int,
                                                            p_completion_evidence text, p_effective_from timestamptz,
                                                            p_source_status text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  return api.set_corrective_action_policy(p_action_type, p_default_due_days, p_reminder_days_before, p_escalate_after_days,
                                          p_completion_evidence, p_effective_from, p_source_status, p_reason,
                                          null::int, null::int, null::text[], null::jsonb);
end;
$$;

-- Completion with an evidence type (DEC-F27). Where the policy lists evidence types, a reference needs one of them.
create function api.submit_corrective_action_completion(p_action_id uuid, p_note text, p_evidence_reference text,
                                                        p_evidence_type text)
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
  if p_evidence_type is not null
     and (v_reference is null
          or not exists (select 1 from decision.corrective_evidence_type t where t.code = p_evidence_type and t.is_active)
          or (v_policy.allowed_evidence_types is not null and not (p_evidence_type = any (v_policy.allowed_evidence_types)))) then
    perform api._fail('INVALID', 'evidence_type');
  end if;
  if p_evidence_type is null and v_reference is not null and v_policy.allowed_evidence_types is not null then
    perform api._fail('INVALID', 'evidence_type');
  end if;
  update decision.corrective_action
     set status = 'PENDING_VERIFICATION', percent_complete = 100, completion_submitted_at = now(), updated_at = now(),
         row_version = row_version + 1
   where id = v.id
  returning * into v;
  insert into decision.corrective_action_event (action_id, case_id, event_type, actor_id, note, evidence_reference,
                                                evidence_type)
  values (v.id, v.case_id, 'COMPLETION_SUBMITTED', v_actor, v_note, v_reference, p_evidence_type);
  for v_user in select m.user_id from decision.action_managers(v.id) m loop
    perform notify.enqueue('CORRECTIVE_ACTION_SUBMITTED', v_user, v.id, null, 'action-submitted:' || v.id || ':' || v.row_version);
  end loop;
  perform audit.record_event('CORRECTIVE_ACTION_COMPLETION_SUBMITTED', 'BUSINESS', 'SUCCESS', v.case_id,
    'corrective_action', v.id::text, null,
    jsonb_build_object('has_evidence_reference', v_reference is not null,
                       'completion_evidence', v_policy.completion_evidence, 'evidence_type', p_evidence_type));
end;
$$;
grant execute on function api.submit_corrective_action_completion(uuid, text, text, text) to authenticated;

-- Replaced from 1940: delegates to the overload above with no evidence type.
create or replace function api.submit_corrective_action_completion(p_action_id uuid, p_note text,
                                                                   p_evidence_reference text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  perform api.submit_corrective_action_completion(p_action_id, p_note, p_evidence_reference, null::text);
end;
$$;

create function api.create_corrective_action_pool(p_code text, p_name text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
begin
  if not authz.has_permission('CORRECTIVE_ACTION_POLICY_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{2,39}$' then perform api._fail('INVALID', 'code'); end if;
  if exists (select 1 from decision.corrective_action_pool p where p.code = p_code) then
    perform api._fail('CONFLICT', 'POOL_EXISTS');
  end if;
  insert into decision.corrective_action_pool (code, name, reason, created_by)
  values (p_code, api._require_text(p_name, 'name', 3, 200), api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_id;
  perform audit.record_event('CORRECTIVE_ACTION_POOL_CREATED', 'ADMIN', 'SUCCESS', null, 'corrective_action_pool',
    v_id::text, null, jsonb_build_object('code', p_code));
  return v_id;
end;
$$;
grant execute on function api.create_corrective_action_pool(text, text, text) to authenticated;

create function api.set_corrective_action_pool_member(p_pool_id uuid, p_user_id uuid, p_active boolean, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m decision.corrective_action_pool_member;
  v_reason text;
begin
  if not authz.has_permission('CORRECTIVE_ACTION_POLICY_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_active is null then perform api._fail('INVALID', 'active'); end if;
  perform 1 from decision.corrective_action_pool p where p.id = p_pool_id and p.is_active for update;
  if not found then perform api._fail('INVALID', 'pool_id'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  select * into v_m from decision.corrective_action_pool_member m
  where m.pool_id = p_pool_id and m.user_id = p_user_id and m.removed_at is null;
  if p_active then
    if v_m.id is not null then perform api._fail('CONFLICT', 'ALREADY_MEMBER'); end if;
    if not exists (select 1 from iam.user_profile u where u.id = p_user_id and u.status = 'ACTIVE')
       or not authz.user_has_permission(p_user_id, 'CORRECTIVE_ACTION_OWN') then
      perform api._fail('INVALID', 'user_id');
    end if;
    insert into decision.corrective_action_pool_member (pool_id, user_id, reason, added_by)
    values (p_pool_id, p_user_id, v_reason, v_actor)
    returning * into v_m;
  else
    if v_m.id is null then perform api._fail('CONFLICT', 'NOT_A_MEMBER'); end if;
    update decision.corrective_action_pool_member
       set removed_by = v_actor, removed_at = now(), removal_reason = v_reason
     where id = v_m.id;
  end if;
  perform audit.record_event(case when p_active then 'CORRECTIVE_ACTION_POOL_MEMBER_ADDED'
                                  else 'CORRECTIVE_ACTION_POOL_MEMBER_REMOVED' end,
    'ADMIN', 'SUCCESS', null, 'corrective_action_pool', p_pool_id::text, null,
    jsonb_build_object('membership_id', v_m.id, 'user_id', p_user_id));
  return v_m.id;
end;
$$;
grant execute on function api.set_corrective_action_pool_member(uuid, uuid, boolean, text) to authenticated;

-- A manager makes an action owned by a unit, a pool or an external party; the accountable owner stays.
create function api.set_corrective_action_owner_kind(p_action_id uuid, p_owner_kind text, p_sector_id uuid,
                                                     p_pool_id uuid, p_external_party_label text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v decision.corrective_action;
  v_reason text;
begin
  v := decision.lock_action(p_action_id);
  perform decision.require_manager(v.case_id);
  if v.status not in ('OPEN', 'IN_PROGRESS') then perform api._fail('CONFLICT', 'ACTION_NOT_ACTIVE'); end if;
  perform decision.require_owner_naming(v.case_id);
  if p_owner_kind is null or p_owner_kind not in ('USER', 'ORG_UNIT', 'SHARED_POOL', 'EXTERNAL_PARTY') then
    perform api._fail('INVALID', 'owner_kind');
  end if;
  if (p_owner_kind = 'ORG_UNIT') <> (p_sector_id is not null)
     or (p_sector_id is not null and not exists (select 1 from iam.sector x where x.id = p_sector_id and x.is_active)) then
    perform api._fail('INVALID', 'sector_id');
  end if;
  if (p_owner_kind = 'SHARED_POOL') <> (p_pool_id is not null)
     or (p_pool_id is not null
         and not exists (select 1 from decision.corrective_action_pool x where x.id = p_pool_id and x.is_active)) then
    perform api._fail('INVALID', 'pool_id');
  end if;
  if (p_owner_kind = 'EXTERNAL_PARTY') <> (p_external_party_label is not null) then
    perform api._fail('INVALID', 'external_party_label');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update decision.corrective_action
     set owner_kind = p_owner_kind, owner_sector_id = p_sector_id, owner_pool_id = p_pool_id,
         external_party_label = case when p_external_party_label is not null
                                     then api._require_text(p_external_party_label, 'external_party_label', 2, 200) end,
         updated_at = now(), row_version = row_version + 1
   where id = v.id
  returning * into v;
  perform decision.record_action_event(v, 'OWNER_KIND_CHANGED', v_reason, null, null, null, null, null);
  perform audit.record_event('CORRECTIVE_ACTION_OWNER_KIND_CHANGED', 'BUSINESS', 'SUCCESS', v.case_id,
    'corrective_action', v.id::text, null,
    jsonb_build_object('owner_kind', p_owner_kind, 'owner_sector_id', p_sector_id, 'owner_pool_id', p_pool_id,
                       'accountable_owner_id', v.owner_id));
end;
$$;
grant execute on function api.set_corrective_action_owner_kind(uuid, text, uuid, uuid, text, text) to authenticated;

-- Replaced from 1940: the three 1940 loops are kept as they were, except that a suspended defence period is not
-- reminded (DEC-F18); the 2040 cadence, overdue and escalation-step loops follow, each off until configured.
create or replace function notify.emit_due_reminders()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_n int := 0;
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
  r record;
  st record;
  v_user uuid;
begin
  for r in select n.id, l.user_id from grievance.defence_notice n
           join grievance.subject_portal_link l on l.subject_id = n.subject_id and l.revoked_at is null
           where n.status in ('ISSUED', 'ACKNOWLEDGED') and n.suspended_at is null
             and n.due_at > now() and n.due_at <= now() + interval '2 days'
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
  -- 2040 cadence (DEC-F26): the due-soon reminder repeats every N days until the due date.
  for r in select a.id, a.owner_id, a.due_date from decision.corrective_action a
           cross join lateral decision.current_corrective_policy(a.action_type) p
           where a.status in ('OPEN', 'IN_PROGRESS') and p.reminder_days_before is not null
             and p.reminder_repeat_days is not null
             and a.due_date >= v_today and a.due_date - p.reminder_days_before <= v_today
             and decision.owner_eligible(a.owner_id, a.case_id)
             and exists (select 1 from notify.outbox o
                         where o.dedupe_key like 'action-due:' || a.id || ':' || a.due_date || ':%')
             and not exists (select 1 from notify.outbox o
                             where o.dedupe_key like 'action-due%:' || a.id || ':' || a.due_date || ':%'
                               and o.created_at > now() - make_interval(days => p.reminder_repeat_days)) loop
    perform notify.enqueue('CORRECTIVE_ACTION_DUE', r.owner_id, r.id, null,
                           'action-due-repeat:' || r.id || ':' || r.due_date || ':' || v_today);
    v_n := v_n + 1;
  end loop;
  -- 2040 overdue threshold (DEC-F26): the owner, once per due date.
  for r in select a.id, a.owner_id, a.due_date from decision.corrective_action a
           cross join lateral decision.current_corrective_policy(a.action_type) p
           where a.status in ('OPEN', 'IN_PROGRESS') and p.overdue_after_days is not null
             and v_today > a.due_date + p.overdue_after_days
             and decision.owner_eligible(a.owner_id, a.case_id)
             and not exists (select 1 from notify.outbox o
                             where o.dedupe_key like 'action-overdue-owner:' || a.id || ':' || a.due_date || ':%') loop
    perform notify.enqueue('CORRECTIVE_ACTION_OVERDUE', r.owner_id, r.id, null,
                           'action-overdue-owner:' || r.id || ':' || r.due_date);
    v_n := v_n + 1;
  end loop;
  -- 2040 escalation steps (DEC-F26): each step once per due date, to recipients who pass the case gate.
  for r in select a.id, a.owner_id, a.case_id, a.due_date, s.step_no, s.recipient_kind, s.role_code
           from decision.corrective_action a
           cross join lateral decision.current_corrective_policy(a.action_type) p
           join decision.corrective_action_escalation_step s on s.policy_id = p.id
           where a.status in ('OPEN', 'IN_PROGRESS') and v_today > a.due_date + s.after_days_overdue
             and not exists (select 1 from notify.outbox o
                             where o.dedupe_key like 'action-step:' || a.id || ':' || a.due_date || ':' || s.step_no || ':%') loop
    if r.recipient_kind = 'OWNER' then
      if decision.owner_eligible(r.owner_id, r.case_id) then
        perform notify.enqueue('CORRECTIVE_ACTION_OVERDUE', r.owner_id, r.id, null,
                               'action-step:' || r.id || ':' || r.due_date || ':' || r.step_no);
      end if;
    elsif r.recipient_kind = 'CASE_MANAGERS' then
      for v_user in select m.user_id from decision.action_managers(r.id) m loop
        perform notify.enqueue('CORRECTIVE_ACTION_OVERDUE', v_user, r.id, null,
                               'action-step:' || r.id || ':' || r.due_date || ':' || r.step_no);
      end loop;
    else
      for v_user in select u.id from iam.user_profile u
                    where u.status = 'ACTIVE'
                      and authz.user_has_role(u.id, r.role_code)
                      and authz.user_can_view_case(u.id, r.case_id) loop
        perform notify.enqueue('CORRECTIVE_ACTION_OVERDUE', v_user, r.id, null,
                               'action-step:' || r.id || ':' || r.due_date || ':' || r.step_no);
      end loop;
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- =============================================================================
-- Item 9. Export: the purpose catalogue (DEC-F21, AMB-195), approved external domains (DEC-F22, AMB-186), the
-- Restricted Case Authority's approval (DEC-F23) and the approval deadlock (DEC-F24, AMB-193, CON-003; T-AMB-112)
-- =============================================================================
-- DEC-F24: export policy administration is separate from transaction approval. EXPORT_POLICY_ADMIN goes to the
-- platform administrator (OWNER_DEFAULT; who holds it is a Delegation of Authority question, SOURCE_REQUIRED), and
-- whoever holds an approval permission (EXPORT_APPROVE, EXPORT_SECOND_APPROVE) cannot administer export policy, so the
-- 1930 grant of EXPORT_POLICY_ADMIN to GRC_DIRECTOR stays (additive only) but no longer lets its holders act.
insert into iam.role_permission (role_code, permission_code) values ('PLATFORM_ADMIN', 'EXPORT_POLICY_ADMIN');

create function authz.is_export_policy_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and authz.has_permission('EXPORT_POLICY_ADMIN')
         and not authz.has_permission('EXPORT_APPROVE') and not authz.has_permission('EXPORT_SECOND_APPROVE');
$$;
revoke all on function authz.is_export_policy_admin() from public, anon;
grant execute on function authz.is_export_policy_admin() to authenticated;

-- DEC-F21: a governed, administrable purpose catalogue. The owner's eight initial categories are active (OTHER needs
-- a justification); the 1930 codes are kept, inactive, for the history of the requests that carry them.
create table exchange.export_purpose (
  code                   text primary key check (code ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  name_en                text not null check (length(name_en) between 3 and 200),
  name_ar                text not null check (length(name_ar) between 3 and 200),
  requires_justification boolean not null default false,
  is_active              boolean not null default true,
  is_legacy              boolean not null default false,
  source_status          text not null check (source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  sort_order             int not null check (sort_order between 1 and 999),
  updated_by             uuid references iam.user_profile (id),
  updated_at             timestamptz not null default now(),
  check (not (is_legacy and is_active)),
  check (code <> 'OTHER' or requires_justification)
);
create index export_purpose_updated_by on exchange.export_purpose (updated_by);
comment on table exchange.export_purpose is
  'Export purposes (DEC-F21, migration 2040): administrable reference data. Legacy 1930 codes are kept inactive.';
insert into exchange.export_purpose (code, name_en, name_ar, requires_justification, is_active, is_legacy,
                                     source_status, sort_order)
values
  ('COMMITTEE_PROCEEDING', 'Committee proceeding', 'إجراءات لجنة', false, true, false, 'OWNER_DEFAULT', 10),
  ('LEGAL_REVIEW', 'Legal review', 'مراجعة قانونية', false, true, false, 'OWNER_DEFAULT', 20),
  ('COMPETENT_AUTHORITY_DECISION', 'Competent-authority decision', 'قرار صاحب الصلاحية', false, true, false,
   'OWNER_DEFAULT', 30),
  ('INTERNAL_MANAGEMENT_REVIEW', 'Internal management review', 'مراجعة إدارية داخلية', false, true, false,
   'OWNER_DEFAULT', 40),
  ('RECORDS_REQUIREMENT', 'Records requirement', 'متطلب سجلات', false, true, false, 'OWNER_DEFAULT', 50),
  ('REGULATORY_OR_EXTERNAL_AUTHORITY', 'Regulatory or external authority', 'جهة تنظيمية أو خارجية', false, true,
   false, 'OWNER_DEFAULT', 60),
  ('AUTHORIZED_BUSINESS_NEED', 'Authorized business need', 'حاجة عمل معتمدة', false, true, false, 'OWNER_DEFAULT', 70),
  ('OTHER', 'Other (justification required)', 'أخرى (يلزم التبرير)', true, true, false, 'OWNER_DEFAULT', 80),
  ('AUTHORITY_SUBMISSION', 'Authority submission (legacy)', 'رفع إلى صاحب الصلاحية (سابق)', false, false, true,
   'SOURCE_REQUIRED', 910),
  ('REGULATOR_REQUEST', 'Regulator request (legacy)', 'طلب جهة تنظيمية (سابق)', false, false, true, 'SOURCE_REQUIRED', 920),
  ('LEGAL_COUNSEL', 'Legal counsel (legacy)', 'مستشار قانوني (سابق)', false, false, true, 'SOURCE_REQUIRED', 930),
  ('INTERNAL_REPORTING', 'Internal reporting (legacy)', 'تقارير داخلية (سابق)', false, false, true, 'SOURCE_REQUIRED',
   940),
  ('AUDIT', 'Audit (legacy)', 'تدقيق (سابق)', false, false, true, 'SOURCE_REQUIRED', 950);

-- The purpose names a catalogue code. The 1930 list check is widened (same name) to the code format, and the catalogue
-- is the list.
alter table exchange.export_request drop constraint export_request_purpose_check;
alter table exchange.export_request add constraint export_request_purpose_check
  check (purpose ~ '^[A-Z][A-Z0-9_]{2,59}$');
alter table exchange.export_request add constraint export_request_purpose_fkey
  foreign key (purpose) references exchange.export_purpose (code);
create index export_request_purpose on exchange.export_request (purpose);

-- Whatever path creates a request: an active purpose, and a justification where the purpose requires one.
create function exchange.check_export_purpose()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_p exchange.export_purpose;
begin
  select * into v_p from exchange.export_purpose p where p.code = new.purpose;
  if v_p.code is null or not v_p.is_active then perform api._fail('INVALID', 'purpose'); end if;
  if v_p.requires_justification and new.justification is null then perform api._fail('INVALID', 'justification'); end if;
  return new;
end;
$$;
create trigger export_request_purpose before insert on exchange.export_request
  for each row execute function exchange.check_export_purpose();

-- DEC-F22: no external domain is invented. APPROVED_EXTERNAL_DOMAINS is SOURCE_REQUIRED and the list is empty; manual
-- external addresses stay possible only through the governed external-email workflow (justification, party,
-- approvals; synthetic @example.test addresses only in this prototype). PRODUCTION_SUBSTITUTION_REQUIRED: once the
-- list is approved, a command maintains it and add_export_recipient checks external addresses against it.
insert into config.setting (key, value, status, source_reference, description) values
  ('APPROVED_EXTERNAL_DOMAINS', null, 'SOURCE_REQUIRED', null,
   'DEC-F22: the external domains exports may be emailed to (exchange.approved_external_domain). None is invented; '
   'external addresses go only through the governed external-email workflow.');
create table exchange.approved_external_domain (
  id               uuid primary key default gen_random_uuid(),
  domain           text not null unique
                     check (domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  source_status    text not null check (source_status in ('SOURCE_REQUIRED', 'APPROVED')),
  source_reference text check (length(source_reference) between 3 and 300),
  added_by         uuid not null references iam.user_profile (id),
  added_at         timestamptz not null default now()
);
create index approved_external_domain_added_by on exchange.approved_external_domain (added_by);
comment on table exchange.approved_external_domain is
  'DEC-F22 (migration 2040): approved external email domains. Empty: APPROVED_EXTERNAL_DOMAINS is SOURCE_REQUIRED.';

-- DEC-F23: the Restricted Case Authority's approval of an export of a restricted case stays mandatory. No version of
-- RESTRICTED_CASE_AUTHORITY may weaken it (NONE, a narrower audience, classification or content type), on any path;
-- and the requirement no longer depends on that rule being in force (fail closed, below).
create function exchange.protect_restricted_authority_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.code = 'RESTRICTED_CASE_AUTHORITY'
     and not (new.audience = 'ANY' and new.min_classification is null and new.object_type is null
              and new.restricted_only and new.action = 'REQUIRE_AUTHORITY_APPROVAL') then
    perform api._fail('CONFLICT', 'RESTRICTED_CASE_AUTHORITY_PROTECTED');
  end if;
  return new;
end;
$$;
create trigger approval_rule_restricted_authority before insert on exchange.approval_rule
  for each row execute function exchange.protect_restricted_authority_rule();

-- Replaces 1930 (DEC-F23, fail closed): an export of a restricted case always needs its Restricted Case Authority's
-- approval, whatever rule is in force; once required, always required (as built); a rule can still add the
-- requirement elsewhere.
create or replace function exchange.authority_approval_required(p_request_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((select q.authority_approval_required from exchange.export_request q where q.id = p_request_id), false)
         or exists (select 1 from exchange.export_request q join case_mgmt.case_record c on c.id = q.case_id
                    where q.id = p_request_id and c.is_restricted)
         or exists (select 1 from exchange.matched_rules(p_request_id) m where m.action = 'REQUIRE_AUTHORITY_APPROVAL');
$$;

-- DEC-F24: a configurable approver pool per approval stage. A stage's pool is in use once anyone was ever added to
-- it; from then on only its current members may give that stage, and revoking the last member leaves the stage with
-- nobody eligible (fail closed, with a configuration warning), never open to every permission holder again. Members
-- still need the stage's permission, the case and every other check. Nobody adds themselves.
create table exchange.export_approver_pool (
  id            uuid primary key default gen_random_uuid(),
  stage         int not null check (stage in (1, 2)),
  user_id       uuid not null references iam.user_profile (id),
  reason        text not null check (length(reason) between 5 and 2000),
  added_by      uuid not null references iam.user_profile (id),
  added_at      timestamptz not null default now(),
  revoked_by    uuid references iam.user_profile (id),
  revoked_at    timestamptz,
  revoke_reason text check (length(revoke_reason) between 5 and 2000),
  check (added_by <> user_id),
  check ((revoked_at is null) = (revoked_by is null) and (revoked_at is null) = (revoke_reason is null))
);
create unique index export_approver_pool_active on exchange.export_approver_pool (stage, user_id)
  where revoked_at is null;
create index export_approver_pool_user on exchange.export_approver_pool (user_id);
create index export_approver_pool_added_by on exchange.export_approver_pool (added_by);
create index export_approver_pool_revoked_by on exchange.export_approver_pool (revoked_by);
comment on table exchange.export_approver_pool is
  'DEC-F24 (migration 2040): who may give an export approval stage once the stage''s pool is in use. Append-only; a '
  'membership can only be revoked, once.';

-- DEC-F24: a submitted export whose next stage has no independent eligible approver. Ids and counts only; raised once
-- per request and stage. The export itself waits (fail closed): self-approval is never the way out.
create table exchange.export_approval_warning (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references exchange.export_request (id),
  stage      int not null check (stage in (1, 2)),
  raised_at  timestamptz not null default now(),
  unique (request_id, stage)
);
comment on table exchange.export_approval_warning is
  'DEC-F24 (migration 2040): an export stage with no independent eligible approver (administrative warning).';

do $$
declare t text;
begin
  foreach t in array array['export_purpose', 'approved_external_domain', 'export_approver_pool',
                           'export_approval_warning'] loop
    execute format('create trigger no_delete before delete on exchange.%I for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on exchange.%I for each statement execute function committee.reject_mutation()', t);
    execute format('alter table exchange.%I enable row level security', t);
    execute format('grant select on exchange.%I to authenticated', t);
  end loop;
  execute 'create trigger no_update before update on exchange.export_approval_warning for each row execute function committee.reject_mutation()';
end;
$$;
create function exchange.protect_pool_records()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null
     or (to_jsonb(new) - array['revoked_by', 'revoked_at', 'revoke_reason'])
        <> (to_jsonb(old) - array['revoked_by', 'revoked_at', 'revoke_reason']) then
    raise exception 'approver pool membership % can only be revoked, once', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger export_approver_pool_protect before update on exchange.export_approver_pool
  for each row execute function exchange.protect_pool_records();

create policy export_purpose_read on exchange.export_purpose for select to authenticated
  using (authz.current_user_id() is not null);
create policy approved_external_domain_read on exchange.approved_external_domain for select to authenticated
  using (authz.is_export_policy_admin());
create policy export_approver_pool_read on exchange.export_approver_pool for select to authenticated
  using (authz.is_export_policy_admin() or user_id = authz.current_user_id());
create policy export_approval_warning_read on exchange.export_approval_warning for select to authenticated
  using (authz.is_export_policy_admin());

-- Whether a stage's pool is in use, and whether a user is a current member of it.
create function exchange.pool_in_use(p_stage int)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from exchange.export_approver_pool p where p.stage = p_stage);
$$;
create function exchange.in_pool(p_user_id uuid, p_stage int)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from exchange.export_approver_pool p
                 where p.stage = p_stage and p.user_id = p_user_id and p.revoked_at is null);
$$;

-- Replaces 1930 (DEC-F24): who may give an approval stage also has to be in the stage's pool once it is in use. The
-- requester, earlier approvers and authors of a rule in force for the export (X1) stay excluded.
create or replace function exchange.eligible_approvers(p_request_id uuid, p_stage int)
returns table (user_id uuid)
language sql stable
set search_path = ''
as $$
  select u.id
  from exchange.export_request q
  join iam.user_profile u on u.status = 'ACTIVE' and u.id <> q.requested_by
  where q.id = p_request_id
    and authz.user_has_permission(u.id, case p_stage when 1 then 'EXPORT_APPROVE' else 'EXPORT_SECOND_APPROVE' end)
    and authz.user_can_view_case(u.id, q.case_id)
    and not exists (select 1 from exchange.export_approval a where a.request_id = q.id and a.approver_id = u.id)
    and not exchange.authored_rule_in_force(q.id, u.id)
    and (not exchange.pool_in_use(p_stage) or exchange.in_pool(u.id, p_stage));
$$;

-- Table-level backup of the separation of duties (DEC-F24), whatever path writes an approval: never the requester,
-- and only a current pool member once the stage's pool is in use.
create function exchange.guard_export_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from exchange.export_request q where q.id = new.request_id and q.requested_by = new.approver_id)
     or (exchange.pool_in_use(new.stage) and not exchange.in_pool(new.approver_id, new.stage)) then
    perform api._fail('FORBIDDEN');
  end if;
  return new;
end;
$$;
create trigger export_approval_guard before insert on exchange.export_approval
  for each row execute function exchange.guard_export_approval();

-- A submitted export whose next stage nobody independent may give raises the administrative warning, once.
create function exchange.warn_unapprovable_export()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage int;
  v_id uuid;
begin
  if new.status <> 'SUBMITTED' then return null; end if;
  v_stage := 1 + (select count(*)::int from exchange.export_approval a where a.request_id = new.id);
  if v_stage > coalesce(new.approvals_required, 0)
     or exists (select 1 from exchange.eligible_approvers(new.id, v_stage))
     or exists (select 1 from exchange.export_approval_warning w where w.request_id = new.id and w.stage = v_stage) then
    return null;
  end if;
  insert into exchange.export_approval_warning (request_id, stage) values (new.id, v_stage) returning id into v_id;
  perform audit.record_event('EXPORT_APPROVAL_CONFIGURATION_WARNING', 'ADMIN', 'SUCCESS', new.case_id,
    'export_request', new.id::text, null,
    jsonb_build_object('warning_id', v_id, 'stage', v_stage, 'approvals_required', new.approvals_required,
                       'eligible_approvers', 0, 'pool_in_use', exchange.pool_in_use(v_stage)),
    'SYSTEM');
  return null;
end;
$$;
create trigger export_request_approval_warning after update on exchange.export_request
  for each row when (old.status is distinct from new.status or old.row_version is distinct from new.row_version)
  execute function exchange.warn_unapprovable_export();

revoke all on function
  exchange.check_export_purpose(), exchange.protect_restricted_authority_rule(), exchange.protect_pool_records(),
  exchange.pool_in_use(int), exchange.in_pool(uuid, int), exchange.guard_export_approval(),
  exchange.warn_unapprovable_export()
from public, anon, authenticated;

-- Replaces 1930 (DEC-F24): only a policy administrator who holds no approval permission sets export rules. The rest
-- is as built; RESTRICTED_CASE_AUTHORITY is protected by its trigger (DEC-F23).
create or replace function api.set_export_rule(
  p_code text, p_audience text, p_min_classification core.classification_level, p_object_type text,
  p_restricted_only boolean, p_action text, p_effective_from timestamptz, p_source_status text, p_reason text
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
  if not authz.is_export_policy_admin() then perform api._fail('FORBIDDEN'); end if;
  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{2,59}$' then perform api._fail('INVALID', 'code'); end if;
  if p_audience is null or p_audience not in ('INTERNAL', 'EXTERNAL', 'ANY') then
    perform api._fail('INVALID', 'audience');
  end if;
  if p_object_type is not null and p_object_type not in (
       'CASE_SUMMARY', 'FINDING', 'RECOMMENDATION_PACKAGE', 'AUTHORITY_DECISION', 'MINUTES') then
    perform api._fail('INVALID', 'object_type');
  end if;
  if p_restricted_only is null then perform api._fail('INVALID', 'restricted_only'); end if;
  if p_action is null or p_action not in ('REQUIRE_SECOND_APPROVAL', 'REQUIRE_AUTHORITY_APPROVAL', 'REFUSE', 'NONE') then
    perform api._fail('INVALID', 'action');
  end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  -- One version per code at a time: the version in force ends where the new one starts.
  perform pg_advisory_xact_lock(hashtext('exchange.approval_rule:' || p_code));
  if exists (select 1 from exchange.approval_rule r where r.code = p_code and r.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'LATER_RULE_EXISTS');
  end if;
  update exchange.approval_rule set effective_to = p_effective_from where code = p_code and effective_to is null;
  insert into exchange.approval_rule (code, audience, min_classification, object_type, restricted_only, action,
                                      source_status, reason, effective_from, created_by)
  values (p_code, p_audience, p_min_classification, p_object_type, p_restricted_only, p_action, p_source_status,
          v_reason, p_effective_from, v_actor)
  returning id into v_id;
  perform audit.record_event('EXPORT_RULE_SET', 'ADMIN', 'SUCCESS', null, 'export_approval_rule', v_id::text, v_reason,
    jsonb_build_object('code', p_code, 'audience', p_audience, 'min_classification', p_min_classification,
                       'object_type', p_object_type, 'restricted_only', p_restricted_only, 'action', p_action,
                       'effective_from', p_effective_from, 'source_status', p_source_status));
  return v_id;
end;
$$;

-- Replaces 1930 (DEC-F21): the purpose comes from the active catalogue, and a purpose that requires one (OTHER) needs
-- a justification, internal or external. The rest is as built.
create or replace function api.create_export_request(
  p_case_id uuid, p_format text, p_audience text, p_purpose text, p_external_party text, p_justification text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_party text;
  v_justification text;
  v_purpose exchange.export_purpose;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('EXPORT_REQUEST') then perform api._fail('FORBIDDEN'); end if;
  if p_format is null or p_format not in ('PDF', 'XLSX', 'EMAIL') then perform api._fail('INVALID', 'format'); end if;
  if p_audience is null or p_audience not in ('INTERNAL', 'EXTERNAL') then perform api._fail('INVALID', 'audience'); end if;
  select * into v_purpose from exchange.export_purpose p where p.code = p_purpose and p.is_active;
  if v_purpose.code is null then perform api._fail('INVALID', 'purpose'); end if;
  if p_audience = 'EXTERNAL' then
    -- Q99: external sending always needs a justification, and names who receives it.
    v_party := api._require_text(p_external_party, 'external_party', 3, 200);
    v_justification := api._require_text(p_justification, 'justification', 20, 2000);
  else
    if nullif(btrim(coalesce(p_external_party, '')), '') is not null then perform api._fail('INVALID', 'external_party'); end if;
    if v_purpose.requires_justification or nullif(btrim(coalesce(p_justification, '')), '') is not null then
      v_justification := api._require_text(p_justification, 'justification', 20, 2000);
    end if;
  end if;
  insert into exchange.export_request (case_id, format, audience, purpose, external_party, justification, requested_by)
  values (p_case_id, p_format, p_audience, v_purpose.code, v_party, v_justification, v_actor)
  returning id into v_id;
  perform audit.record_event('EXPORT_REQUESTED', 'BUSINESS', 'SUCCESS', p_case_id, 'export_request', v_id::text, null,
    jsonb_build_object('format', p_format, 'audience', p_audience, 'purpose', v_purpose.code));
  return v_id;
end;
$$;

-- DEC-F21: the policy administrator maintains the purpose catalogue. Codes are never deleted; a purpose is
-- deactivated instead. Legacy codes stay as they are; OTHER always requires a justification.
create function api.set_export_purpose(p_code text, p_name_en text, p_name_ar text, p_requires_justification boolean,
                                       p_is_active boolean, p_sort_order int, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_old exchange.export_purpose;
  v_name_en text;
  v_name_ar text;
  v_reason text;
begin
  if not authz.is_export_policy_admin() then perform api._fail('FORBIDDEN'); end if;
  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{2,59}$' then perform api._fail('INVALID', 'code'); end if;
  v_name_en := api._require_text(p_name_en, 'name_en', 3, 200);
  v_name_ar := api._require_text(p_name_ar, 'name_ar', 3, 200);
  if p_requires_justification is null then perform api._fail('INVALID', 'requires_justification'); end if;
  if p_is_active is null then perform api._fail('INVALID', 'is_active'); end if;
  if p_sort_order is null or p_sort_order not between 1 and 899 then perform api._fail('INVALID', 'sort_order'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  select * into v_old from exchange.export_purpose p where p.code = p_code for update;
  if v_old.is_legacy then perform api._fail('CONFLICT', 'LEGACY_PURPOSE'); end if;
  if p_code = 'OTHER' and not p_requires_justification then
    perform api._fail('CONFLICT', 'OTHER_REQUIRES_JUSTIFICATION');
  end if;
  insert into exchange.export_purpose (code, name_en, name_ar, requires_justification, is_active, is_legacy,
                                       source_status, sort_order, updated_by, updated_at)
  values (p_code, v_name_en, v_name_ar, p_requires_justification, p_is_active, false, 'APPROVED', p_sort_order,
          v_actor, now())
  on conflict (code) do update
    set name_en = excluded.name_en, name_ar = excluded.name_ar,
        requires_justification = excluded.requires_justification, is_active = excluded.is_active,
        source_status = 'APPROVED', sort_order = excluded.sort_order, updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;
  perform audit.record_event('EXPORT_PURPOSE_SET', 'ADMIN', 'SUCCESS', null, 'export_purpose', p_code, v_reason,
    jsonb_build_object('created', v_old.code is null, 'requires_justification', p_requires_justification,
                       'previous_requires_justification', v_old.requires_justification, 'is_active', p_is_active,
                       'previous_is_active', v_old.is_active, 'sort_order', p_sort_order));
  return p_code;
end;
$$;

-- DEC-F24: the policy administrator adds a user holding the stage's permission to a stage's approver pool.
create function api.add_export_approver(p_user_id uuid, p_stage int, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_reason text;
begin
  if not authz.is_export_policy_admin() then perform api._fail('FORBIDDEN'); end if;
  if p_stage is null or p_stage not in (1, 2) then perform api._fail('INVALID', 'stage'); end if;
  if p_user_id is null or not exists (select 1 from iam.user_profile u where u.id = p_user_id and u.status = 'ACTIVE') then
    perform api._fail('INVALID', 'user_id');
  end if;
  if p_user_id = v_actor then perform api._fail('FORBIDDEN'); end if;
  if not authz.user_has_permission(p_user_id, case p_stage when 1 then 'EXPORT_APPROVE' else 'EXPORT_SECOND_APPROVE' end) then
    perform api._fail('CONFLICT', 'APPROVER_LACKS_PERMISSION');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform pg_advisory_xact_lock(hashtext('exchange.export_approver_pool:' || p_stage));
  if exchange.in_pool(p_user_id, p_stage) then perform api._fail('CONFLICT', 'ALREADY_MEMBER'); end if;
  insert into exchange.export_approver_pool (stage, user_id, reason, added_by)
  values (p_stage, p_user_id, v_reason, v_actor)
  returning id into v_id;
  perform audit.record_event('EXPORT_APPROVER_ADDED', 'ADMIN', 'SUCCESS', null, 'export_approver_pool', v_id::text,
    v_reason, jsonb_build_object('user_id', p_user_id, 'stage', p_stage));
  return v_id;
end;
$$;

create function api.revoke_export_approver(p_membership_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v exchange.export_approver_pool;
  v_reason text;
begin
  if not authz.is_export_policy_admin() then perform api._fail('FORBIDDEN'); end if;
  select * into v from exchange.export_approver_pool p where p.id = p_membership_id for update;
  if v.id is null then perform api._fail('NOT_FOUND'); end if;
  if v.revoked_at is not null then perform api._fail('CONFLICT', 'ALREADY_REVOKED'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update exchange.export_approver_pool set revoked_by = v_actor, revoked_at = now(), revoke_reason = v_reason
   where id = v.id;
  perform audit.record_event('EXPORT_APPROVER_REVOKED', 'ADMIN', 'SUCCESS', null, 'export_approver_pool', v.id::text,
    v_reason, jsonb_build_object('user_id', v.user_id, 'stage', v.stage));
end;
$$;

-- DEC-F24, T-AMB-112: the administrative configuration warnings, for the policy administrator. Ids, stages, counts
-- and times only: never a case, an item or a person beyond the pool's own member ids.
create function api.export_approval_config_warnings()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not authz.is_export_policy_admin() then perform api._fail('FORBIDDEN'); end if;
  return jsonb_build_object(
    'pools', (select jsonb_agg(jsonb_build_object(
                       'stage', st.stage, 'in_use', exchange.pool_in_use(st.stage),
                       'active_members', (select count(*) from exchange.export_approver_pool p
                                          where p.stage = st.stage and p.revoked_at is null))
                     order by st.stage)
              from (values (1), (2)) st (stage)),
    'warnings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'warning_id', w.id, 'request_id', w.request_id, 'stage', w.stage, 'raised_at', w.raised_at,
               'still_blocked', q.status = 'SUBMITTED'
                                and 1 + (select count(*) from exchange.export_approval a where a.request_id = q.id) = w.stage
                                and not exists (select 1 from exchange.eligible_approvers(q.id, w.stage)))
             order by w.raised_at, w.id)
      from exchange.export_approval_warning w join exchange.export_request q on q.id = w.request_id), '[]'::jsonb));
end;
$$;

grant execute on function
  api.set_export_purpose(text, text, text, boolean, boolean, int, text), api.add_export_approver(uuid, int, text),
  api.revoke_export_approver(uuid, text), api.export_approval_config_warnings()
to authenticated;
