-- =============================================================================
-- 2000 Excused attendance and conflicts raised by another participant (Business Architecture Rebase phase 11, gap
-- P11-G6; CDF-198, CDF-190)
-- Requirements: §19, §29, §87; owner Q&A Q41–Q44, Q47, Q49, Q50; ADR-020, ADR-035, ADR-038; DEC-30 (coordinator
-- ruling: who decides a recusal is rule-set configuration, SOURCE_REQUIRED)
--
-- Migration 1890 records attendance as PRESENT, ABSENT or EXCUSED_CONFLICT, and only the participant (or the secretary
-- for an invitee without an account) declares a conflict. The owner's catalogues also name a justified absence
-- (T7-B1.2-048; CRM-F049 and CRM-F050 tell an absence without an accepted excuse from one with it) and a conflict
-- flagged by someone else so that it is assessed before work continues (T3-B1.2-050). Gap P11-G6
-- (FORM_CATALOGUE_RATIONALIZATION §6). This migration adds, for committee meetings:
--   * EXCUSED attendance with a reason. The secretary records it with api.record_excused_absence under the rules of
--     api.record_attendance (meeting open, no vote in progress). The reason is kept in committee.attendance_excuse
--     (append-only), visible to the secretary and the participant only. An excused participant is not present, so
--     quorum and votes treat them as absent (Q51 unchanged). A declared conflict is never an excuse: it stays
--     EXCUSED_CONFLICT.
--   * A conflict raised by another participant (committee.meeting_conflict_concern). The secretary running the
--     meeting, or a member of it who has declared no conflict, raises it about another participant who must declare,
--     with a reason (api.raise_meeting_conflict). While it is open and its subject has not declared a conflict, no vote
--     item opens in the meeting (a trigger, so every path that opens one is covered): the concern is assessed before
--     work continues. It cannot be raised or decided while a vote is in progress, so it never changes whose votes
--     count mid-vote (as attendance, AGENT-09 V1a).
--   * Its decision (api.decide_meeting_conflict). UPHELD makes the subject CONFLICT_DECLARED for the meeting, written
--     as a declaration with source DECISION, so every 1890 rule follows: not present, no vote, no quorum, and no later
--     NO_CONFLICT in the same proceeding. DISMISSED changes nothing. The decider is rule-set configuration
--     (committee.rule_set.conflict_decider, copied into each new proceeding's rule snapshot): CHAIR by default, the
--     deputy chair only when the chair raised the concern or is its subject; or SECRETARY. SOURCE_REQUIRED. Neither the
--     raiser nor the subject ever decides, a decider must be cleared for the meeting and the case, and nobody decides
--     when nobody in the meeting holds the configured role (fail closed).
--
-- Controls:
--   * Additive and non-destructive: two checks widened under their own names (attendance, declaration source), one
--     column with a default, two append-only tables with RLS (SELECT only, no write grants), three commands, one
--     predicate, one trigger. No 1890 command body changes; nothing is dropped, renamed or deleted.
--   * Reasons stay in their rows; audit events carry ids and codes only, never a reason.
--   * The case-level part of T3-B1.2-050 (anyone on a case raising someone else's case conflict) is not built: whether
--     an upheld case-level conflict suspends the subject's case access is an access-model decision (gap P11-G7, open).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Excused attendance
-- -----------------------------------------------------------------------------
alter table committee.meeting_participant drop constraint meeting_participant_attendance_check;
alter table committee.meeting_participant add constraint meeting_participant_attendance_check
  check (attendance in ('NOT_RECORDED', 'PRESENT', 'ABSENT', 'EXCUSED_CONFLICT', 'EXCUSED'));
comment on column committee.meeting_participant.attendance is
  'NOT_RECORDED, PRESENT, ABSENT (no accepted excuse), EXCUSED_CONFLICT (a declared conflict, Q42–Q44) or EXCUSED (a '
  'justified absence, its reason in committee.attendance_excuse; migration 2000). Only PRESENT counts for quorum and votes.';

create table committee.attendance_excuse (
  id             uuid primary key default gen_random_uuid(),
  meeting_id     uuid not null references committee.meeting (id),
  participant_id uuid not null references committee.meeting_participant (id),
  reason         text not null check (length(reason) between 5 and 2000),
  recorded_by    uuid not null references iam.user_profile (id),
  recorded_at    timestamptz not null default clock_timestamp()
);
create index attendance_excuse_meeting on committee.attendance_excuse (meeting_id);
create index attendance_excuse_participant on committee.attendance_excuse (participant_id);
create index attendance_excuse_recorded_by on committee.attendance_excuse (recorded_by);
comment on table committee.attendance_excuse is
  'Justified absences from a meeting (T7-B1.2-048; migration 2000). Append-only. Reasons are visible to the secretary '
  'running the meeting and to the participant only.';

-- -----------------------------------------------------------------------------
-- Conflicts raised by another participant
-- -----------------------------------------------------------------------------
alter table committee.rule_set add column conflict_decider text not null default 'CHAIR'
  check (conflict_decider in ('CHAIR', 'SECRETARY'));
comment on column committee.rule_set.conflict_decider is
  'Who decides a conflict raised by another participant of a meeting (migration 2000, ADR-038): CHAIR (the deputy chair '
  'when the chair raised it or is its subject) or SECRETARY. SOURCE_REQUIRED (DEC-30: rule-set configuration); every '
  'rule set takes CHAIR until the owner names the decider.';

alter table committee.meeting_conflict drop constraint meeting_conflict_source_check;
alter table committee.meeting_conflict add constraint meeting_conflict_source_check
  check (source in ('SELF', 'SECRETARY', 'DECISION'));
comment on column committee.meeting_conflict.source is
  'SELF (the participant), SECRETARY (for an invitee without an account) or DECISION (a raised conflict that was '
  'upheld, migration 2000; declared_by is the decider).';

create table committee.meeting_conflict_concern (
  id              uuid primary key default gen_random_uuid(),
  meeting_id      uuid not null references committee.meeting (id),
  participant_id  uuid not null references committee.meeting_participant (id),
  raised_by       uuid not null references iam.user_profile (id),
  raised_as       text not null check (raised_as in ('MEMBER', 'SECRETARY')),
  reason          text not null check (length(reason) between 10 and 2000),
  raised_at       timestamptz not null default clock_timestamp(),
  status          text not null default 'OPEN' check (status in ('OPEN', 'UPHELD', 'DISMISSED')),
  decided_by      uuid references iam.user_profile (id),
  decided_as      text check (decided_as in ('CHAIR', 'DEPUTY_CHAIR', 'SECRETARY')),
  decision_reason text check (length(decision_reason) between 10 and 2000),
  decided_at      timestamptz,
  check ((status = 'OPEN') = (decided_by is null)),
  check ((decided_by is null) = (decided_as is null) and (decided_by is null) = (decision_reason is null)
         and (decided_by is null) = (decided_at is null)),
  -- The raiser never decides (nor the subject: the decider predicate below).
  check (decided_by is distinct from raised_by)
);
create unique index meeting_conflict_concern_open on committee.meeting_conflict_concern (participant_id) where status = 'OPEN';
create index meeting_conflict_concern_meeting on committee.meeting_conflict_concern (meeting_id, status);
create index meeting_conflict_concern_raised_by on committee.meeting_conflict_concern (raised_by);
create index meeting_conflict_concern_decided_by on committee.meeting_conflict_concern (decided_by);
comment on table committee.meeting_conflict_concern is
  'A conflict of interest raised about a meeting participant by another member or the secretary, and its decision '
  '(T3-B1.2-050 in a committee meeting, Q49; migration 2000, ADR-038). While one is open and its subject has not '
  'declared a conflict, no vote item opens in the meeting. Reasons are visible to the raiser, the secretary running the '
  'meeting and the decider only.';

-- -----------------------------------------------------------------------------
-- Integrity
-- -----------------------------------------------------------------------------
create trigger no_update before update on committee.attendance_excuse
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on committee.attendance_excuse
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on committee.attendance_excuse
  for each statement execute function committee.reject_mutation();
create trigger no_delete before delete on committee.meeting_conflict_concern
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on committee.meeting_conflict_concern
  for each statement execute function committee.reject_mutation();

-- A concern is decided once; what was raised never changes.
create function committee.protect_conflict_concern()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'OPEN'
     or (to_jsonb(new) - array['status', 'decided_by', 'decided_as', 'decision_reason', 'decided_at'])
        <> (to_jsonb(old) - array['status', 'decided_by', 'decided_as', 'decision_reason', 'decided_at']) then
    raise exception 'conflict concern % is decided or its content is immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger meeting_conflict_concern_protect before update on committee.meeting_conflict_concern
  for each row execute function committee.protect_conflict_concern();

-- No vote item opens while a concern about a participant who has not declared a conflict is open (every path:
-- api.open_vote_item, package and grievance votes).
create function committee.require_no_open_concern()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from committee.meeting_conflict_concern c
             join committee.meeting_participant mp on mp.id = c.participant_id
             where c.meeting_id = new.meeting_id and c.status = 'OPEN' and mp.coi_status <> 'CONFLICT_DECLARED') then
    perform api._fail('CONFLICT', 'CONFLICT_CONCERN_OPEN');
  end if;
  return new;
end;
$$;
create trigger vote_item_needs_no_open_concern before insert on committee.vote_item
  for each row execute function committee.require_no_open_concern();

-- -----------------------------------------------------------------------------
-- Who decides a raised conflict (for the current user): the seat they decide as, or null
-- -----------------------------------------------------------------------------
-- From the rule snapshot of the meeting's proceeding (CHAIR for a snapshot taken before this migration). Never the
-- raiser or the subject; the decider has declared no conflict for this meeting (CHAIR, DEPUTY_CHAIR) or runs it
-- (SECRETARY), and is cleared for the case. The deputy chair decides only when the chair raised the concern or is its
-- subject. Fails closed: null when nobody in the meeting holds the role.
create function authz.meeting_concern_decider_seat(p_concern_id uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select case
           when k.decider = 'SECRETARY' then
             case when authz.can_manage_meeting(k.meeting_id) then 'SECRETARY' end
           when k.decider = 'CHAIR' then (
             select mp.seat from committee.meeting_participant mp
             where mp.meeting_id = k.meeting_id and mp.participant_kind = 'MEMBER'
               and mp.user_id = authz.current_user_id() and mp.coi_status = 'NO_CONFLICT'
               and (mp.seat = 'CHAIR'
                    or (mp.seat = 'DEPUTY_CHAIR' and k.chair_user is not null
                        and (k.chair_user = k.raised_by or k.chair_user = k.subject_user)))
             order by mp.seat limit 1)
         end
  from (
    select c.meeting_id, c.raised_by, m.case_id, t.user_id as subject_user,
           coalesce(cp.rule_snapshot ->> 'conflict_decider', 'CHAIR') as decider,
           (select ch.user_id from committee.meeting_participant ch
            where ch.meeting_id = c.meeting_id and ch.participant_kind = 'MEMBER' and ch.seat = 'CHAIR'
            order by ch.added_at limit 1) as chair_user
    from committee.meeting_conflict_concern c
    join committee.meeting m on m.id = c.meeting_id
    join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
    join committee.meeting_participant t on t.id = c.participant_id
    where c.id = p_concern_id
  ) k
  where authz.current_user_id() is not null
    and authz.current_user_id() <> k.raised_by
    and authz.current_user_id() is distinct from k.subject_user
    and authz.user_case_gate(authz.current_user_id(), k.case_id);
$$;
grant execute on function authz.meeting_concern_decider_seat(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- RLS (SELECT only; no write grants)
-- -----------------------------------------------------------------------------
alter table committee.attendance_excuse enable row level security;
alter table committee.meeting_conflict_concern enable row level security;

create policy attendance_excuse_read on committee.attendance_excuse for select to authenticated
  using (authz.can_manage_meeting(meeting_id)
         or exists (select 1 from committee.meeting_participant mp
                    where mp.id = participant_id and mp.user_id = authz.current_user_id()
                      and authz.can_view_meeting(mp.meeting_id)));
grant select on committee.attendance_excuse to authenticated;

-- The raiser, the secretary running the meeting and the decider, each still cleared for the case; not the subject.
create policy meeting_conflict_concern_read on committee.meeting_conflict_concern for select to authenticated
  using ((raised_by = authz.current_user_id() and authz.can_view_meeting(meeting_id))
         or authz.can_manage_meeting(meeting_id)
         or authz.meeting_concern_decider_seat(id) is not null);
grant select on committee.meeting_conflict_concern to authenticated;

-- -----------------------------------------------------------------------------
-- Commands
-- -----------------------------------------------------------------------------
-- T7-B1.2-048: a justified absence, recorded by the secretary under api.record_attendance's rules.
create function api.record_excused_absence(p_participant_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p committee.meeting_participant;
  v_m committee.meeting;
  v_reason text;
  v_id uuid;
begin
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id;
  if v_p.id is null or not authz.can_view_meeting(v_p.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_m := committee.lock_managed_meeting(v_p.meeting_id);
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id for update;
  if v_m.status <> 'OPEN' then perform api._fail('CONFLICT', 'MEETING_NOT_OPEN'); end if;
  if exists (select 1 from committee.vote_item vi where vi.meeting_id = v_m.id and vi.status <> 'CLOSED') then
    perform api._fail('CONFLICT', 'VOTE_IN_PROGRESS');
  end if;
  -- A declared conflict is recorded as EXCUSED_CONFLICT, never as an excuse (Q42–Q44).
  if v_p.coi_status = 'CONFLICT_DECLARED' then perform api._fail('CONFLICT', 'CONFLICT_DECLARED'); end if;
  if v_p.attendance = 'EXCUSED' then perform api._fail('CONFLICT', 'ALREADY_EXCUSED'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);

  insert into committee.attendance_excuse (meeting_id, participant_id, reason, recorded_by)
  values (v_m.id, v_p.id, v_reason, v_actor)
  returning id into v_id;
  update committee.meeting_participant
     set attendance = 'EXCUSED', attendance_recorded_by = v_actor, attendance_recorded_at = now()
   where id = v_p.id;
  -- The reason stays in the excuse row; the ledger gets the fact, as for any attendance.
  perform audit.record_event('ATTENDANCE_RECORDED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_participant', v_p.id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'from', v_p.attendance, 'to', 'EXCUSED', 'excuse_id', v_id));
  return v_id;
end;
$$;

-- T3-B1.2-050 in a committee meeting: another participant's conflict, raised for a decision (Q49).
create function api.raise_meeting_conflict(p_participant_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p committee.meeting_participant;
  v_m committee.meeting;
  v_as text;
  v_reason text;
  v_id uuid;
begin
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id;
  if v_p.id is null or not authz.can_view_meeting(v_p.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_m := committee.lock_visible_meeting(v_p.meeting_id);
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id for update;
  -- The secretary running the meeting, or a member of it who has declared no conflict and is cleared for the case.
  if authz.can_manage_meeting(v_m.id) then
    v_as := 'SECRETARY';
  elsif exists (select 1 from committee.meeting_participant mp
                where mp.meeting_id = v_m.id and mp.participant_kind = 'MEMBER' and mp.user_id = v_actor
                  and mp.coi_status = 'NO_CONFLICT')
        and authz.user_case_gate(v_actor, v_m.case_id) then
    v_as := 'MEMBER';
  else
    perform api._fail('FORBIDDEN');
  end if;
  -- One's own conflict is declared (api.declare_meeting_conflict), never raised.
  if v_p.user_id = v_actor then perform api._fail('CONFLICT', 'OWN_CONFLICT'); end if;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_m.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if v_m.status not in ('SCHEDULED', 'OPEN') then perform api._fail('CONFLICT', 'MEETING_NOT_ACTIVE'); end if;
  if exists (select 1 from committee.vote_item vi where vi.meeting_id = v_m.id and vi.status <> 'CLOSED') then
    perform api._fail('CONFLICT', 'VOTE_IN_PROGRESS');
  end if;
  if not v_p.requires_coi then perform api._fail('CONFLICT', 'COI_NOT_REQUIRED'); end if;
  if v_p.coi_status = 'CONFLICT_DECLARED' then perform api._fail('CONFLICT', 'COI_ALREADY_DECLARED'); end if;
  if exists (select 1 from committee.meeting_conflict_concern c where c.participant_id = v_p.id and c.status = 'OPEN') then
    perform api._fail('CONFLICT', 'CONCERN_OPEN');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);

  insert into committee.meeting_conflict_concern (meeting_id, participant_id, raised_by, raised_as, reason)
  values (v_m.id, v_p.id, v_actor, v_as, v_reason)
  returning id into v_id;
  -- The reason stays in the concern row (raiser, secretary, decider); the ledger gets the fact.
  perform audit.record_event('MEETING_CONFLICT_RAISED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_conflict_concern',
    v_id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'participant_id', v_p.id, 'participant_kind', v_p.participant_kind,
                       'raised_as', v_as));
  return v_id;
end;
$$;

-- The decision on a raised conflict (Q49), by the decider the rule snapshot names.
create function api.decide_meeting_conflict(p_concern_id uuid, p_decision text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_c committee.meeting_conflict_concern;
  v_m committee.meeting;
  v_p committee.meeting_participant;
  v_seat text;
  v_reason text;
begin
  select * into v_c from committee.meeting_conflict_concern c where c.id = p_concern_id;
  -- Only those who may read the concern learn that it exists.
  if v_c.id is null or not authz.can_view_meeting(v_c.meeting_id)
     or not (v_c.raised_by = v_actor or authz.can_manage_meeting(v_c.meeting_id)
             or authz.meeting_concern_decider_seat(v_c.id) is not null) then
    perform api._fail('NOT_FOUND');
  end if;
  v_m := committee.lock_visible_meeting(v_c.meeting_id);
  select * into v_c from committee.meeting_conflict_concern c where c.id = p_concern_id for update;
  v_seat := authz.meeting_concern_decider_seat(v_c.id);
  if v_seat is null then perform api._fail('FORBIDDEN'); end if;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_m.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if v_c.status <> 'OPEN' then perform api._fail('CONFLICT', 'NOTHING_TO_DECIDE'); end if;
  if v_m.status not in ('SCHEDULED', 'OPEN') then perform api._fail('CONFLICT', 'MEETING_NOT_ACTIVE'); end if;
  if exists (select 1 from committee.vote_item vi where vi.meeting_id = v_m.id and vi.status <> 'CLOSED') then
    perform api._fail('CONFLICT', 'VOTE_IN_PROGRESS');
  end if;
  if p_decision is null or p_decision not in ('UPHELD', 'DISMISSED') then perform api._fail('INVALID', 'decision'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);

  update committee.meeting_conflict_concern
     set status = p_decision, decided_by = v_actor, decided_as = v_seat, decision_reason = v_reason, decided_at = now()
   where id = v_c.id;
  perform audit.record_event('MEETING_CONFLICT_DECIDED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_conflict_concern',
    v_c.id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'participant_id', v_c.participant_id, 'decision', p_decision,
                       'decided_as', v_seat));

  -- Upheld: the subject is conflicted for the meeting exactly as if they had declared it (Q42–Q44); a conflict already
  -- declared is final and stays as it is.
  if p_decision = 'UPHELD' then
    select * into v_p from committee.meeting_participant mp where mp.id = v_c.participant_id for update;
    if v_p.coi_status <> 'CONFLICT_DECLARED' then
      insert into committee.meeting_conflict (meeting_id, participant_id, status, declared_by, source, reason)
      values (v_m.id, v_p.id, 'CONFLICT_DECLARED', v_actor, 'DECISION', v_reason);
      update committee.meeting_participant
         set coi_status = 'CONFLICT_DECLARED', coi_declared_at = now(),
             attendance = case when attendance <> 'NOT_RECORDED' then 'EXCUSED_CONFLICT' else attendance end
       where id = v_p.id;
      perform audit.record_event('COI_DECLARED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_participant', v_p.id::text, null,
        jsonb_build_object('meeting_id', v_m.id, 'status', 'CONFLICT_DECLARED', 'source', 'DECISION',
                           'participant_kind', v_p.participant_kind));
    end if;
  end if;
end;
$$;

grant execute on function
  api.record_excused_absence(uuid, text),
  api.raise_meeting_conflict(uuid, text),
  api.decide_meeting_conflict(uuid, text, text)
to authenticated;

-- -----------------------------------------------------------------------------
-- The form and status catalogue (migration 1970) follows the schema
-- -----------------------------------------------------------------------------
update config.legacy_form_map
   set merge_target = 'api.record_excused_absence (attendance EXCUSED with the reason); a rescheduled hearing is a new meeting',
       gap_ref = null
 where gap_ref = 'P11-G6' and legacy_id = 'T7-B1.2-048';
update config.legacy_form_map
   set merge_target = 'in a meeting: api.raise_meeting_conflict + api.decide_meeting_conflict (votes wait for the '
                      'decision); on the case: waiting_reason COI_REVIEW',
       gap_ref = 'P11-G7'
 where gap_ref = 'P11-G6' and legacy_id = 'T3-B1.2-050';
update config.target_module
   set commands = commands || 'api.record_excused_absence'::text,
       delivered_in = delivered_in || '2000'::text
 where code in ('MEETING', 'MEETING_HEARING');
update config.target_module
   set notes = 'Hearing of the subject; rescheduling is a new meeting; an absence is ABSENT, or EXCUSED with its reason.'
 where code = 'MEETING_HEARING';
update config.target_module
   set commands = commands || array['api.raise_meeting_conflict', 'api.decide_meeting_conflict'],
       delivered_in = delivered_in || '2000'::text,
       notes = 'Per-meeting conflict declaration (Q41); a conflict raised by another participant is decided by the '
               'rule set''s decider before any vote (Q49).'
 where code = 'MEETING_COI';
