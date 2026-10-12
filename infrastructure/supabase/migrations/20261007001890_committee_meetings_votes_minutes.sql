-- =============================================================================
-- 1890 Committee meetings, conflict of interest, quorum, voting and minutes (Business Architecture Rebase phase 5;
-- CDF-190)
-- Requirements: §18–§21, §29, §39, §68, §87; owner Q&A Q35–Q36, Q41–Q70, Q97–Q98; ADR-020;
-- AUTHORIZATION_IMPACT.md N4–N8
--
-- Additive only. Builds on the committee registry and proceeding snapshots of migration 1870.
--
--   meeting              a sitting of a committee proceeding: purpose DELIBERATION or HEARING, mode IN_PERSON / TEAMS /
--                        HYBRID, status SCHEDULED → OPEN → CLOSED (or SCHEDULED → CANCELLED). An online link is pasted
--                        by the secretary (manual meeting provider; PRODUCTION_SUBSTITUTION_REQUIRED: M365 Teams).
--   meeting_participant  the proceeding snapshot's members (copied at scheduling, firewall-restricted members left out)
--                        and invitees (WITNESS, EXPERT, LEGAL, INFORMATION_PROVIDER, SUBJECT). Holds the current
--                        conflict-of-interest status and attendance for that meeting (Q41–Q50).
--   meeting_conflict     append-only history of conflict declarations (Q49).
--   vote_item            a decision put to the vote (FINDING, RECOMMENDATION_ITEM, SANCTION, CORRECTIVE_ACTION,
--                        PACKAGE, FINAL_PACKAGE, OTHER; Q58, Q64–Q69) with its result and tallies once closed.
--   vote, casting_vote   individual votes. No SELECT grant at all: choices stay secret until the item closes and are
--                        then read only through api.vote_item_status (Q61–Q63).
--   minutes              versioned generated snapshot + secretary narrative; reviewed by the attending,
--   minutes_review       non-conflicted, non-secretary members; deemed approved after the review window and a recorded
--                        reminder (Q97–Q98).
--
-- Rules enforced here, not in the UI (Q47):
--   * A member who is PENDING or CONFLICT_DECLARED cannot be recorded PRESENT, cannot vote and is not eligible for
--     quorum (N4, N5). A conflict declaration cannot be withdrawn.
--   * The secretary may record only ABSENT, UNABLE_TO_VOTE or RECUSED for another member (N6; check constraint too).
--   * Quorum and result come from the proceeding's rule snapshot, never the live rule set. Eligible = voting members
--     with NO_CONFLICT; present = eligible and PRESENT at close. Votes of anyone not present-and-eligible at close are
--     excluded and counted as such.
--   * The decision rule is a simple majority of APPROVE over REJECT among counted votes (SOURCE_REQUIRED). A tie goes
--     to the chair's casting vote when the snapshot enables it and the chair is present and eligible; otherwise TIED
--     (N8).
--   * Minutes snapshots carry tallies and results, never individual choices, because approved minutes become visible
--     to the case team.
--   * Every participation check also passes authz.user_case_gate (clearance, no declared case conflict), so a case
--     conflict declared after the snapshot removes visibility, voting and eligibility at once (DEC-61, AGENT-09 P1).
--   * Business days are Sunday to Thursday in Asia/Riyadh; public holidays are SOURCE_REQUIRED (not modelled).
-- Every command writes its audit event in the same transaction. Vote audit events carry no choice.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table committee.meeting (
  id                      uuid primary key default gen_random_uuid(),
  committee_proceeding_id uuid not null references committee.committee_proceeding (id),
  case_id                 uuid not null references case_mgmt.case_record (id),
  -- Display number within the proceeding (MTG-01). UUIDs are the keys (§87).
  sequence_no             int not null check (sequence_no >= 1),
  purpose                 text not null check (purpose in ('DELIBERATION', 'HEARING')),
  mode                    text not null check (mode in ('IN_PERSON', 'TEAMS', 'HYBRID')),
  provider                text not null default 'MANUAL' check (provider in ('MANUAL')),
  location                text check (length(location) between 2 and 200),
  online_url              text check (online_url ~ '^https://[^\s]+$' and length(online_url) between 12 and 500),
  scheduled_start         timestamptz not null,
  scheduled_end           timestamptz not null,
  status                  text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'OPEN', 'CLOSED', 'CANCELLED')),
  scheduled_by            uuid not null references iam.user_profile (id),
  scheduled_at            timestamptz not null default now(),
  opened_by               uuid references iam.user_profile (id),
  opened_at               timestamptz,
  closed_by               uuid references iam.user_profile (id),
  closed_at               timestamptz,
  updated_at              timestamptz not null default now(),
  unique (committee_proceeding_id, sequence_no),
  check (scheduled_end > scheduled_start),
  check ((mode in ('IN_PERSON', 'HYBRID')) = (location is not null)),
  check ((mode in ('TEAMS', 'HYBRID')) = (online_url is not null)),
  check ((opened_at is null) = (opened_by is null)),
  check ((closed_at is null) = (closed_by is null)),
  check ((status in ('OPEN', 'CLOSED')) <= (opened_at is not null)),
  check ((status in ('CLOSED', 'CANCELLED')) = (closed_at is not null))
);
create index meeting_case on committee.meeting (case_id);
create index meeting_scheduled_by on committee.meeting (scheduled_by);
create index meeting_opened_by on committee.meeting (opened_by);
create index meeting_closed_by on committee.meeting (closed_by);
comment on table committee.meeting is
  'A sitting of a committee proceeding (ADR-020). Online links come from the manual provider (PRODUCTION_SUBSTITUTION_REQUIRED).';

create table committee.meeting_participant (
  id                     uuid primary key default gen_random_uuid(),
  meeting_id             uuid not null references committee.meeting (id),
  participant_kind       text not null check (participant_kind in ('MEMBER', 'INVITEE')),
  proceeding_member_id   uuid references committee.proceeding_member (id),
  user_id                uuid references iam.user_profile (id),
  person_id              uuid references case_mgmt.person (id),
  seat                   text check (seat in ('CHAIR', 'DEPUTY_CHAIR', 'SECRETARY', 'ALTERNATE_SECRETARY', 'MEMBER', 'ALTERNATE_MEMBER')),
  invitee_role           text check (invitee_role in ('WITNESS', 'EXPERT', 'LEGAL', 'INFORMATION_PROVIDER', 'SUBJECT')),
  is_voting              boolean not null default false,
  requires_coi           boolean not null,
  coi_status             text not null check (coi_status in ('PENDING', 'NO_CONFLICT', 'CONFLICT_DECLARED', 'NOT_REQUIRED')),
  coi_declared_at        timestamptz,
  attendance             text not null default 'NOT_RECORDED' check (attendance in ('NOT_RECORDED', 'PRESENT', 'ABSENT', 'EXCUSED_CONFLICT')),
  attendance_recorded_by uuid references iam.user_profile (id),
  attendance_recorded_at timestamptz,
  added_by               uuid not null references iam.user_profile (id),
  added_at               timestamptz not null default now(),
  check (case participant_kind
           when 'MEMBER' then proceeding_member_id is not null and user_id is not null and person_id is null
                              and seat is not null and invitee_role is null and requires_coi
           else proceeding_member_id is null and seat is null and invitee_role is not null and not is_voting
                and (user_id is null) <> (person_id is null)
                and (invitee_role <> 'SUBJECT' or person_id is not null)
                and (invitee_role <> 'LEGAL' or user_id is not null) end),
  check (requires_coi = (coi_status <> 'NOT_REQUIRED')),
  check ((coi_status in ('NO_CONFLICT', 'CONFLICT_DECLARED')) = (coi_declared_at is not null)),
  -- N4: only a cleared participant can be present; a declared conflict means excused, never present (Q44).
  check (attendance <> 'PRESENT' or coi_status in ('NO_CONFLICT', 'NOT_REQUIRED')),
  check ((attendance = 'EXCUSED_CONFLICT') = (coi_status = 'CONFLICT_DECLARED' and attendance <> 'NOT_RECORDED')),
  check ((attendance_recorded_at is null) = (attendance_recorded_by is null))
);
create unique index meeting_participant_user on committee.meeting_participant (meeting_id, user_id) where user_id is not null;
create unique index meeting_participant_person on committee.meeting_participant (meeting_id, person_id) where person_id is not null;
create index meeting_participant_user_id on committee.meeting_participant (user_id);
create index meeting_participant_person_id on committee.meeting_participant (person_id);
create index meeting_participant_member on committee.meeting_participant (proceeding_member_id);
create index meeting_participant_recorded_by on committee.meeting_participant (attendance_recorded_by);
create index meeting_participant_added_by on committee.meeting_participant (added_by);
comment on table committee.meeting_participant is
  'Members and invitees of one meeting with their conflict-of-interest status and attendance (ADR-020, Q41–Q50).';

create table committee.meeting_conflict (
  id             uuid primary key default gen_random_uuid(),
  meeting_id     uuid not null references committee.meeting (id),
  participant_id uuid not null references committee.meeting_participant (id),
  status         text not null check (status in ('NO_CONFLICT', 'CONFLICT_DECLARED')),
  -- Who entered it: the participant themself, or the secretary for an invitee without an account.
  declared_by    uuid not null references iam.user_profile (id),
  source         text not null check (source in ('SELF', 'SECRETARY')),
  reason         text check (length(reason) between 5 and 2000),
  declared_at    timestamptz not null default clock_timestamp(),
  check (status <> 'CONFLICT_DECLARED' or reason is not null)
);
create index meeting_conflict_meeting on committee.meeting_conflict (meeting_id);
create index meeting_conflict_participant on committee.meeting_conflict (participant_id);
create index meeting_conflict_declared_by on committee.meeting_conflict (declared_by);
comment on table committee.meeting_conflict is
  'Append-only conflict-of-interest declarations per meeting (Q49). Reasons are visible to the declarer and the secretary only.';

create table committee.vote_item (
  id                      uuid primary key default gen_random_uuid(),
  meeting_id              uuid not null references committee.meeting (id),
  case_id                 uuid not null references case_mgmt.case_record (id),
  sequence_no             int not null check (sequence_no >= 1),
  target_type             text not null check (target_type in (
                            'FINDING', 'RECOMMENDATION_ITEM', 'SANCTION', 'CORRECTIVE_ACTION', 'PACKAGE', 'FINAL_PACKAGE', 'OTHER')),
  finding_id              uuid references case_mgmt.finding (id),
  title                   text not null check (length(title) between 3 and 300),
  status                  text not null default 'OPEN' check (status in ('OPEN', 'AWAITING_CASTING_VOTE', 'CLOSED')),
  result                  text check (result in ('APPROVED', 'REJECTED', 'TIED', 'NO_DECISION', 'NO_QUORUM')),
  eligible_count          int,
  present_count           int,
  quorum_required         int,
  custom_quorum_attested  boolean not null default false,
  approve_count           int,
  reject_count            int,
  abstain_count           int,
  recused_count           int,
  absent_count            int,
  unable_count            int,
  excluded_count          int,
  decided_by_casting_vote boolean not null default false,
  opened_by               uuid not null references iam.user_profile (id),
  opened_at               timestamptz not null default now(),
  tallied_by              uuid references iam.user_profile (id),
  tallied_at              timestamptz,
  closed_at               timestamptz,
  unique (meeting_id, sequence_no),
  check ((target_type = 'FINDING') = (finding_id is not null)),
  check ((status = 'CLOSED') = (result is not null and closed_at is not null)),
  check ((status = 'OPEN') = (tallied_at is null)),
  check ((tallied_at is null) = (tallied_by is null)),
  check ((tallied_at is null) = (eligible_count is null)),
  check (status <> 'AWAITING_CASTING_VOTE' or approve_count = reject_count),
  check (not decided_by_casting_vote or result in ('APPROVED', 'REJECTED'))
);
create index vote_item_case on committee.vote_item (case_id);
create index vote_item_finding on committee.vote_item (finding_id);
create index vote_item_opened_by on committee.vote_item (opened_by);
create index vote_item_tallied_by on committee.vote_item (tallied_by);
comment on table committee.vote_item is 'A decision put to the vote in a meeting, with its result once closed (ADR-020, Q58, Q64–Q69).';

create table committee.vote (
  id                uuid primary key default gen_random_uuid(),
  vote_item_id      uuid not null references committee.vote_item (id),
  participant_id    uuid not null references committee.meeting_participant (id),
  recorded_for      uuid not null references iam.user_profile (id),
  recorded_by       uuid not null references iam.user_profile (id),
  source            text not null check (source in ('SELF', 'SECRETARY')),
  choice            text not null check (choice in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED', 'ABSENT', 'UNABLE_TO_VOTE')),
  reason            text check (length(reason) between 5 and 2000),
  original_event_at timestamptz not null,
  recorded_at       timestamptz not null default clock_timestamp(),
  unique (vote_item_id, participant_id),
  -- N6 (Q60): the secretary records only absence, recusal or inability; substantive votes are the member's own.
  check (source <> 'SECRETARY' or (choice in ('ABSENT', 'UNABLE_TO_VOTE', 'RECUSED') and reason is not null)),
  check (source <> 'SELF' or (recorded_by = recorded_for and choice in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED')))
);
create index vote_participant on committee.vote (participant_id);
create index vote_recorded_for on committee.vote (recorded_for);
create index vote_recorded_by on committee.vote (recorded_by);
comment on table committee.vote is
  'Individual votes (Q59–Q63). No application role can select them; api.vote_item_status reveals choices after close.';

create table committee.casting_vote (
  id           uuid primary key default gen_random_uuid(),
  vote_item_id uuid not null unique references committee.vote_item (id),
  cast_by      uuid not null references iam.user_profile (id),
  choice       text not null check (choice in ('APPROVE', 'REJECT')),
  reason       text check (length(reason) between 5 and 2000),
  cast_at      timestamptz not null default clock_timestamp()
);
create index casting_vote_cast_by on committee.casting_vote (cast_by);
comment on table committee.casting_vote is 'The chair''s casting vote on a tie, when the rule snapshot enables it (Q57). Not selectable.';

create table committee.minutes (
  id                     uuid primary key default gen_random_uuid(),
  meeting_id             uuid not null references committee.meeting (id),
  case_id                uuid not null references case_mgmt.case_record (id),
  version_no             int not null check (version_no >= 1),
  snapshot               jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  narrative              text not null check (length(narrative) between 10 and 20000),
  status                 text not null check (status in ('IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'DEEMED_APPROVED', 'SUPERSEDED')),
  reviewer_count         int not null check (reviewer_count >= 0),
  review_business_days   int not null check (review_business_days between 1 and 30),
  review_due_at          timestamptz not null,
  deemed_approval_enabled boolean not null,
  -- The reminder before deemed approval (Q98). PRODUCTION_SUBSTITUTION_REQUIRED: sent by the notification engine.
  reminder_sent_by       uuid references iam.user_profile (id),
  reminder_sent_at       timestamptz,
  generated_by           uuid not null references iam.user_profile (id),
  generated_at           timestamptz not null default now(),
  finalised_at           timestamptz,
  unique (meeting_id, version_no),
  check ((reminder_sent_at is null) = (reminder_sent_by is null)),
  check ((status in ('APPROVED', 'DEEMED_APPROVED')) = (finalised_at is not null))
);
create unique index minutes_current on committee.minutes (meeting_id) where status <> 'SUPERSEDED';
create index minutes_case on committee.minutes (case_id);
create index minutes_reminder_sent_by on committee.minutes (reminder_sent_by);
create index minutes_generated_by on committee.minutes (generated_by);
comment on table committee.minutes is
  'Versioned meeting minutes (Q97–Q98): generated snapshot (attendance, conflicts, results; never individual choices) + narrative.';

create table committee.minutes_review (
  id          uuid primary key default gen_random_uuid(),
  minutes_id  uuid not null references committee.minutes (id),
  reviewer_id uuid not null references iam.user_profile (id),
  decision    text not null check (decision in ('APPROVE', 'REQUEST_CHANGES')),
  comment     text check (length(comment) between 5 and 4000),
  reviewed_at timestamptz not null default clock_timestamp(),
  unique (minutes_id, reviewer_id),
  check (decision <> 'REQUEST_CHANGES' or comment is not null)
);
create index minutes_review_reviewer on committee.minutes_review (reviewer_id);
comment on table committee.minutes_review is 'One decision per reviewer per minutes version (Q97). Append-only.';

-- -----------------------------------------------------------------------------
-- Integrity
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['committee.meeting_conflict', 'committee.vote', 'committee.casting_vote',
                           'committee.minutes_review'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
  foreach t in array array['committee.meeting', 'committee.meeting_participant', 'committee.vote_item',
                           'committee.minutes'] loop
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;

create function committee.protect_meeting_records()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'meeting' then
    if old.status in ('CLOSED', 'CANCELLED')
       or (to_jsonb(new) - array['status', 'opened_by', 'opened_at', 'closed_by', 'closed_at', 'updated_at'])
          <> (to_jsonb(old) - array['status', 'opened_by', 'opened_at', 'closed_by', 'closed_at', 'updated_at']) then
      raise exception 'meeting % is closed or its identity is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'meeting_participant' then
    -- Who a participant is never changes; a declared conflict is never withdrawn.
    if (to_jsonb(new) - array['coi_status', 'coi_declared_at', 'attendance', 'attendance_recorded_by', 'attendance_recorded_at'])
       <> (to_jsonb(old) - array['coi_status', 'coi_declared_at', 'attendance', 'attendance_recorded_by', 'attendance_recorded_at'])
       or (old.coi_status = 'CONFLICT_DECLARED' and new.coi_status <> 'CONFLICT_DECLARED')
       or (old.coi_status = 'NO_CONFLICT' and new.coi_status not in ('NO_CONFLICT', 'CONFLICT_DECLARED')) then
      raise exception 'meeting participant % cannot change that way', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'vote_item' then
    if old.status = 'CLOSED'
       or (to_jsonb(old) - array['status', 'result', 'eligible_count', 'present_count', 'quorum_required', 'custom_quorum_attested',
                                 'approve_count', 'reject_count', 'abstain_count', 'recused_count', 'absent_count',
                                 'unable_count', 'excluded_count', 'decided_by_casting_vote', 'tallied_by', 'tallied_at', 'closed_at'])
          <> (to_jsonb(new) - array['status', 'result', 'eligible_count', 'present_count', 'quorum_required', 'custom_quorum_attested',
                                    'approve_count', 'reject_count', 'abstain_count', 'recused_count', 'absent_count',
                                    'unable_count', 'excluded_count', 'decided_by_casting_vote', 'tallied_by', 'tallied_at', 'closed_at'])
       or (old.status = 'AWAITING_CASTING_VOTE'
           and (to_jsonb(old) - array['status', 'result', 'decided_by_casting_vote', 'closed_at'])
               <> (to_jsonb(new) - array['status', 'result', 'decided_by_casting_vote', 'closed_at'])) then
      raise exception 'vote item % is closed or its tally is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'minutes' then
    -- The content of a version never changes. The review window may only be shortened (never by a command; a test
    -- fixture moves it to simulate elapsed time), so a deemed approval can never be pushed later or forged earlier
    -- by an application path.
    if old.status in ('APPROVED', 'DEEMED_APPROVED', 'SUPERSEDED')
       or (to_jsonb(new) - array['status', 'reminder_sent_by', 'reminder_sent_at', 'finalised_at', 'review_due_at'])
          <> (to_jsonb(old) - array['status', 'reminder_sent_by', 'reminder_sent_at', 'finalised_at', 'review_due_at'])
       or new.review_due_at > old.review_due_at
       or (old.reminder_sent_at is not null and new.reminder_sent_at is distinct from old.reminder_sent_at) then
      raise exception 'minutes % are final or their content is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;
create trigger meeting_protect before update on committee.meeting
  for each row execute function committee.protect_meeting_records();
create trigger meeting_participant_protect before update on committee.meeting_participant
  for each row execute function committee.protect_meeting_records();
create trigger vote_item_protect before update on committee.vote_item
  for each row execute function committee.protect_meeting_records();
create trigger minutes_protect before update on committee.minutes
  for each row execute function committee.protect_meeting_records();

-- -----------------------------------------------------------------------------
-- Authorization predicates (§19)
-- -----------------------------------------------------------------------------
-- Meeting logistics (date, mode, link, participants): whoever can see the committee proceeding, and every
-- participant with an account who is cleared for the case. Invitees see logistics only, never deliberation.
create function authz.can_view_meeting(p_meeting_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from committee.meeting m
    where m.id = p_meeting_id
      and (authz.can_view_committee_proceeding(m.committee_proceeding_id)
           or exists (select 1 from committee.meeting_participant mp
                      where mp.meeting_id = m.id and mp.user_id = authz.current_user_id())
               and authz.user_case_gate(authz.current_user_id(), m.case_id))
  );
$$;

-- Running the meeting: the committee's current secretary or alternate, cleared for the case and not conflicted in it.
create function authz.can_manage_meeting(p_meeting_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from committee.meeting m
    join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
    where m.id = p_meeting_id
      and authz.is_committee_secretary(cp.committee_id)
      and authz.user_case_gate(authz.current_user_id(), m.case_id)
      and not exists (select 1 from committee.meeting_participant mp
                      where mp.meeting_id = m.id and mp.user_id = authz.current_user_id()
                        and mp.coi_status = 'CONFLICT_DECLARED')
  );
$$;

-- Deliberation (vote items, minutes in review): the managing secretary, or a member of the meeting who has declared
-- no conflict, cleared for the case. A member who is conflicted, or has not declared yet, sees nothing of the
-- deliberation (Q41–Q44; AGENT-09 V3: fail safe until the declaration).
create function authz.can_view_meeting_deliberation(p_meeting_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_manage_meeting(p_meeting_id) or exists (
    select 1 from committee.meeting m
    join committee.meeting_participant mp on mp.meeting_id = m.id
    where m.id = p_meeting_id and mp.participant_kind = 'MEMBER' and mp.user_id = authz.current_user_id()
      and mp.coi_status = 'NO_CONFLICT'
      and authz.user_case_gate(authz.current_user_id(), m.case_id)
  );
$$;

-- The participant list (seats, conflict statuses, invitees): whoever can see the committee proceeding. An invitee who
-- is not on the proceeding sees only their own row and the meeting logistics (AGENT-09 V4).
create function authz.can_view_meeting_roster(p_meeting_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from committee.meeting m
    where m.id = p_meeting_id and authz.can_view_committee_proceeding(m.committee_proceeding_id)
  );
$$;

grant execute on function
  authz.can_view_meeting(uuid), authz.can_manage_meeting(uuid), authz.can_view_meeting_deliberation(uuid),
  authz.can_view_meeting_roster(uuid)
to authenticated;

-- -----------------------------------------------------------------------------
-- RLS (SELECT only; no write grants; vote and casting_vote have no grant at all)
-- -----------------------------------------------------------------------------
alter table committee.meeting enable row level security;
alter table committee.meeting_participant enable row level security;
alter table committee.meeting_conflict enable row level security;
alter table committee.vote_item enable row level security;
alter table committee.vote enable row level security;
alter table committee.casting_vote enable row level security;
alter table committee.minutes enable row level security;
alter table committee.minutes_review enable row level security;

create policy meeting_read on committee.meeting for select to authenticated using (authz.can_view_meeting(id));
grant select on committee.meeting to authenticated;

create policy meeting_participant_read on committee.meeting_participant for select to authenticated
  using (authz.can_view_meeting_roster(meeting_id)
         or (user_id = authz.current_user_id() and authz.can_view_meeting(meeting_id)));
grant select on committee.meeting_participant to authenticated;

create policy meeting_conflict_read on committee.meeting_conflict for select to authenticated
  using (declared_by = authz.current_user_id() or authz.can_manage_meeting(meeting_id));
grant select on committee.meeting_conflict to authenticated;

create policy vote_item_read on committee.vote_item for select to authenticated
  using (authz.can_view_meeting_deliberation(meeting_id));
grant select on committee.vote_item to authenticated;

-- Approved minutes join the case record and are visible to the case team; minutes in review stay in the meeting.
create policy minutes_read on committee.minutes for select to authenticated
  using (authz.can_view_meeting_deliberation(meeting_id)
         or (status in ('APPROVED', 'DEEMED_APPROVED') and authz.can_view_case(case_id)));
grant select on committee.minutes to authenticated;

create policy minutes_review_read on committee.minutes_review for select to authenticated
  using (exists (select 1 from committee.minutes mi
                 where mi.id = minutes_id and authz.can_view_meeting_deliberation(mi.meeting_id)));
grant select on committee.minutes_review to authenticated;

-- -----------------------------------------------------------------------------
-- Internal helpers (owner context; not granted)
-- -----------------------------------------------------------------------------
-- p_days business days after p_from, Sunday to Thursday in Asia/Riyadh. Public holidays: SOURCE_REQUIRED.
create function committee.add_business_days(p_from timestamptz, p_days int)
returns timestamptz
language plpgsql stable
set search_path = ''
as $$
declare
  v_local timestamp := p_from at time zone 'Asia/Riyadh';
  v_left int := p_days;
begin
  while v_left > 0 loop
    v_local := v_local + interval '1 day';
    if extract(isodow from v_local) not in (5, 6) then v_left := v_left - 1; end if;
  end loop;
  return v_local at time zone 'Asia/Riyadh';
end;
$$;

-- Locks and returns a meeting the caller can see. Invisible and missing are alike (NOT_FOUND).
create function committee.lock_visible_meeting(p_meeting_id uuid)
returns committee.meeting
language plpgsql
set search_path = ''
as $$
declare v committee.meeting;
begin
  if p_meeting_id is null or not authz.can_view_meeting(p_meeting_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v from committee.meeting m where m.id = p_meeting_id for update;
  return v;
end;
$$;

-- As above, and the caller must run the meeting, on an active case.
create function committee.lock_managed_meeting(p_meeting_id uuid)
returns committee.meeting
language plpgsql
set search_path = ''
as $$
declare v committee.meeting;
begin
  v := committee.lock_visible_meeting(p_meeting_id);
  if not authz.can_manage_meeting(v.id) then perform api._fail('FORBIDDEN'); end if;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Meeting commands
-- -----------------------------------------------------------------------------
create function api.schedule_meeting(
  p_committee_proceeding_id uuid, p_purpose text, p_mode text, p_location text, p_online_url text,
  p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_cp committee.committee_proceeding;
  v_m committee.meeting;
  v_reason text;
  v_members int;
begin
  if p_committee_proceeding_id is null or not authz.can_view_committee_proceeding(p_committee_proceeding_id) then
    perform api._fail('NOT_FOUND');
  end if;
  select * into v_cp from committee.committee_proceeding cp where cp.id = p_committee_proceeding_id for update;
  if not authz.is_committee_secretary(v_cp.committee_id) or not authz.user_case_gate(v_actor, v_cp.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_cp.status <> 'OPEN' then perform api._fail('CONFLICT', 'PROCEEDING_CLOSED'); end if;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_cp.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if p_purpose is null or p_purpose not in ('DELIBERATION', 'HEARING') then perform api._fail('INVALID', 'purpose'); end if;
  if p_mode is null or p_mode not in ('IN_PERSON', 'TEAMS', 'HYBRID') then perform api._fail('INVALID', 'mode'); end if;
  if (p_mode in ('IN_PERSON', 'HYBRID')) <> (p_location is not null) then perform api._fail('INVALID', 'location'); end if;
  if (p_mode in ('TEAMS', 'HYBRID')) <> (p_online_url is not null)
     or (p_online_url is not null and (p_online_url !~ '^https://[^\s]+$' or length(p_online_url) not between 12 and 500)) then
    perform api._fail('INVALID', 'online_url');
  end if;
  if p_scheduled_start is null or p_scheduled_end is null or p_scheduled_end <= p_scheduled_start then
    perform api._fail('INVALID', 'scheduled_end');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);

  insert into committee.meeting (committee_proceeding_id, case_id, sequence_no, purpose, mode, location, online_url,
                                 scheduled_start, scheduled_end, scheduled_by)
  values (v_cp.id, v_cp.case_id,
          (select coalesce(max(m.sequence_no), 0) + 1 from committee.meeting m where m.committee_proceeding_id = v_cp.id),
          p_purpose, p_mode, case when p_location is not null then api._require_text(p_location, 'location', 2, 200) end,
          p_online_url, p_scheduled_start, p_scheduled_end, v_actor)
  returning * into v_m;

  -- Every snapshotted member with an active account who is cleared for the case now (DEC-61, AGENT-09 P1), except
  -- those the grievance firewall restricts (Q45–Q46: they may only be invited as a witness, expert or information
  -- provider). Everyone starts PENDING (Q41).
  insert into committee.meeting_participant (meeting_id, participant_kind, proceeding_member_id, user_id, seat, is_voting,
                                             requires_coi, coi_status, added_by)
  select v_m.id, 'MEMBER', pm.id, pm.user_id, pm.seat, pm.is_voting, true, 'PENDING', v_actor
  from committee.proceeding_member pm
  join iam.user_profile u on u.id = pm.user_id and u.status = 'ACTIVE'
  where pm.committee_proceeding_id = v_cp.id and not pm.firewall_restricted and not pm.case_gate_excluded
    and authz.user_case_gate(pm.user_id, v_cp.case_id);
  get diagnostics v_members = row_count;

  perform audit.record_event('MEETING_SCHEDULED', 'BUSINESS', 'SUCCESS', v_cp.case_id, 'meeting', v_m.id::text, v_reason,
    jsonb_build_object('committee_proceeding_id', v_cp.id, 'sequence_no', v_m.sequence_no, 'purpose', p_purpose,
                       'mode', p_mode, 'provider', 'MANUAL', 'members', v_members));
  return v_m.id;
end;
$$;

create function api.invite_to_meeting(
  p_meeting_id uuid, p_invitee_role text, p_user_id uuid, p_person_id uuid, p_requires_coi boolean, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.meeting;
  v_reason text;
  v_firewalled boolean;
  v_id uuid;
begin
  v_m := committee.lock_managed_meeting(p_meeting_id);
  if v_m.status not in ('SCHEDULED', 'OPEN') then perform api._fail('CONFLICT', 'MEETING_NOT_ACTIVE'); end if;
  if p_invitee_role is null or p_invitee_role not in ('WITNESS', 'EXPERT', 'LEGAL', 'INFORMATION_PROVIDER', 'SUBJECT') then
    perform api._fail('INVALID', 'invitee_role');
  end if;
  if (p_user_id is null) = (p_person_id is null) then perform api._fail('INVALID', 'invitee'); end if;
  if p_invitee_role = 'SUBJECT' and p_person_id is null then perform api._fail('INVALID', 'person_id'); end if;
  if p_invitee_role = 'LEGAL' and p_user_id is null then perform api._fail('INVALID', 'user_id'); end if;
  if p_requires_coi is null then perform api._fail('INVALID', 'requires_coi'); end if;
  -- An invitee with an account must be cleared for the case (clearance, no declared case conflict).
  if p_user_id is not null and not authz.user_case_gate(p_user_id, v_m.case_id) then
    perform api._fail('INVALID', 'user_id');
  end if;
  -- Only a person already on this case can be named, so the command reveals nothing beyond the case.
  if p_person_id is not null and not exists (
    select 1 from case_mgmt.case_person cp where cp.case_id = v_m.case_id and cp.person_id = p_person_id
  ) then
    perform api._fail('INVALID', 'person_id');
  end if;
  if p_user_id is not null and exists (
    select 1 from committee.meeting_participant mp where mp.meeting_id = v_m.id and mp.user_id = p_user_id
  ) or p_person_id is not null and exists (
    select 1 from committee.meeting_participant mp where mp.meeting_id = v_m.id and mp.person_id = p_person_id
  ) then
    perform api._fail('CONFLICT', 'ALREADY_INVITED');
  end if;
  -- Q46: a firewall-restricted member may attend only as a witness, expert or information provider.
  select exists (select 1 from committee.proceeding_member pm
                 where pm.committee_proceeding_id = v_m.committee_proceeding_id and pm.user_id = p_user_id
                   and pm.firewall_restricted)
    into v_firewalled;
  if v_firewalled and p_invitee_role not in ('WITNESS', 'EXPERT', 'INFORMATION_PROVIDER') then
    perform api._fail('FORBIDDEN');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);

  insert into committee.meeting_participant (meeting_id, participant_kind, user_id, person_id, invitee_role,
                                             requires_coi, coi_status, added_by)
  values (v_m.id, 'INVITEE', p_user_id, p_person_id, p_invitee_role, p_requires_coi,
          case when p_requires_coi then 'PENDING' else 'NOT_REQUIRED' end, v_actor)
  returning id into v_id;
  perform audit.record_event('MEETING_INVITEE_ADDED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_participant', v_id::text,
    v_reason, jsonb_build_object('meeting_id', v_m.id, 'invitee_role', p_invitee_role, 'requires_coi', p_requires_coi,
                                 'firewall_restricted', v_firewalled));
  return v_id;
end;
$$;

-- A participant declares for themself; the secretary records the declaration of an invitee without an account.
-- NO_CONFLICT may later become CONFLICT_DECLARED; a declared conflict is final for the meeting, and a member who declared
-- a conflict in an earlier meeting of the same proceeding cannot declare NO_CONFLICT in a later one (fail safe).
create function api.declare_meeting_conflict(p_participant_id uuid, p_status text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p committee.meeting_participant;
  v_m committee.meeting;
  v_source text;
  v_reason text;
begin
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id;
  if v_p.id is null or not authz.can_view_meeting(v_p.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_m := committee.lock_visible_meeting(v_p.meeting_id);
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id for update;
  if v_p.user_id = v_actor then
    v_source := 'SELF';
  elsif v_p.user_id is null and authz.can_manage_meeting(v_m.id) then
    v_source := 'SECRETARY';
  else
    perform api._fail('FORBIDDEN');
  end if;
  if v_m.status not in ('SCHEDULED', 'OPEN') then perform api._fail('CONFLICT', 'MEETING_NOT_ACTIVE'); end if;
  if not v_p.requires_coi then perform api._fail('CONFLICT', 'COI_NOT_REQUIRED'); end if;
  if p_status is null or p_status not in ('NO_CONFLICT', 'CONFLICT_DECLARED') then perform api._fail('INVALID', 'status'); end if;
  if v_p.coi_status = 'CONFLICT_DECLARED' or (v_p.coi_status = 'NO_CONFLICT' and p_status = 'NO_CONFLICT') then
    perform api._fail('CONFLICT', 'COI_ALREADY_DECLARED');
  end if;
  if p_status = 'NO_CONFLICT' and v_p.participant_kind = 'MEMBER' and exists (
       select 1 from committee.meeting_participant prior
       join committee.meeting pm on pm.id = prior.meeting_id
       where pm.committee_proceeding_id = v_m.committee_proceeding_id and pm.id <> v_m.id
         and prior.proceeding_member_id = v_p.proceeding_member_id and prior.coi_status = 'CONFLICT_DECLARED') then
    perform api._fail('CONFLICT', 'PRIOR_CONFLICT_DECLARED');
  end if;
  v_reason := case when p_status = 'CONFLICT_DECLARED' or p_reason is not null
                   then api._require_text(p_reason, 'reason', 5, 2000) end;

  insert into committee.meeting_conflict (meeting_id, participant_id, status, declared_by, source, reason)
  values (v_m.id, v_p.id, p_status, v_actor, v_source, v_reason);
  update committee.meeting_participant
     set coi_status = p_status, coi_declared_at = now(),
         attendance = case when p_status = 'CONFLICT_DECLARED' and attendance <> 'NOT_RECORDED' then 'EXCUSED_CONFLICT'
                           else attendance end
   where id = v_p.id;
  -- The reason stays in the declaration row (declarer and secretary only); the ledger gets the fact.
  perform audit.record_event('COI_DECLARED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_participant', v_p.id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'status', p_status, 'source', v_source, 'participant_kind', v_p.participant_kind));
end;
$$;

create function api.open_meeting(p_meeting_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.meeting;
  v_pr case_mgmt.proceeding;
  v_reason text;
begin
  v_m := committee.lock_managed_meeting(p_meeting_id);
  if v_m.status <> 'SCHEDULED' then perform api._fail('CONFLICT', 'MEETING_NOT_SCHEDULED'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  select p.* into v_pr from case_mgmt.proceeding p
  join committee.committee_proceeding cp on cp.proceeding_id = p.id
  where cp.id = v_m.committee_proceeding_id for update of p;
  if v_pr.status in ('CONCLUDED', 'CANCELLED') then perform api._fail('CONFLICT', 'PROCEEDING_CLOSED'); end if;
  if v_pr.status = 'SUSPENDED' then perform api._fail('CONFLICT', 'PROCEEDING_SUSPENDED'); end if;

  update committee.meeting set status = 'OPEN', opened_by = v_actor, opened_at = now(), updated_at = now() where id = v_m.id;
  if v_pr.status = 'OPEN' then
    update case_mgmt.proceeding set status = 'IN_PROGRESS', updated_at = now(), row_version = row_version + 1 where id = v_pr.id;
  end if;
  perform audit.record_event('MEETING_OPENED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting', v_m.id::text, v_reason,
    jsonb_build_object('committee_proceeding_id', v_m.committee_proceeding_id, 'proceeding_status_before', v_pr.status));
end;
$$;

-- N4 / Q44: PRESENT only for a cleared participant; EXCUSED_CONFLICT only for a declared conflict. Attendance is frozen
-- while any vote item of the meeting is undecided, so the secretary cannot change whose votes count (AGENT-09 V1a).
create function api.record_attendance(p_participant_id uuid, p_attendance text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p committee.meeting_participant;
  v_m committee.meeting;
begin
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id;
  if v_p.id is null or not authz.can_view_meeting(v_p.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_m := committee.lock_managed_meeting(v_p.meeting_id);
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id for update;
  if v_m.status <> 'OPEN' then perform api._fail('CONFLICT', 'MEETING_NOT_OPEN'); end if;
  if exists (select 1 from committee.vote_item vi where vi.meeting_id = v_m.id and vi.status <> 'CLOSED') then
    perform api._fail('CONFLICT', 'VOTE_IN_PROGRESS');
  end if;
  if p_attendance is null or p_attendance not in ('PRESENT', 'ABSENT', 'EXCUSED_CONFLICT') then
    perform api._fail('INVALID', 'attendance');
  end if;
  if p_attendance = 'PRESENT' and v_p.coi_status not in ('NO_CONFLICT', 'NOT_REQUIRED') then
    perform api._fail('CONFLICT', 'COI_NOT_CLEARED');
  end if;
  if (p_attendance = 'EXCUSED_CONFLICT') <> (v_p.coi_status = 'CONFLICT_DECLARED') then
    perform api._fail('CONFLICT', case when p_attendance = 'EXCUSED_CONFLICT' then 'NO_CONFLICT_DECLARED' else 'CONFLICT_DECLARED' end);
  end if;

  update committee.meeting_participant
     set attendance = p_attendance, attendance_recorded_by = v_actor, attendance_recorded_at = now()
   where id = v_p.id;
  perform audit.record_event('ATTENDANCE_RECORDED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_participant', v_p.id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'from', v_p.attendance, 'to', p_attendance));
end;
$$;

create function api.close_meeting(p_meeting_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.meeting;
  v_reason text;
begin
  v_m := committee.lock_managed_meeting(p_meeting_id);
  if v_m.status <> 'OPEN' then perform api._fail('CONFLICT', 'MEETING_NOT_OPEN'); end if;
  if exists (select 1 from committee.vote_item vi where vi.meeting_id = v_m.id and vi.status <> 'CLOSED') then
    perform api._fail('CONFLICT', 'VOTES_OPEN');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update committee.meeting set status = 'CLOSED', closed_by = v_actor, closed_at = now(), updated_at = now() where id = v_m.id;
  perform audit.record_event('MEETING_CLOSED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting', v_m.id::text, v_reason,
    jsonb_build_object('vote_items', (select count(*) from committee.vote_item vi where vi.meeting_id = v_m.id)));
end;
$$;

create function api.cancel_meeting(p_meeting_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.meeting;
  v_reason text;
begin
  v_m := committee.lock_managed_meeting(p_meeting_id);
  if v_m.status <> 'SCHEDULED' then perform api._fail('CONFLICT', 'MEETING_NOT_SCHEDULED'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update committee.meeting set status = 'CANCELLED', closed_by = v_actor, closed_at = now(), updated_at = now() where id = v_m.id;
  perform audit.record_event('MEETING_CANCELLED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting', v_m.id::text, v_reason, '{}'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Voting commands
-- -----------------------------------------------------------------------------
-- Recommendation, sanction, corrective-action and package targets are bound to their records when those arrive
-- (ADR-021, phase 6); until then they carry a title only. A FINDING target must be a finding of this case.
create function api.open_vote_item(p_meeting_id uuid, p_target_type text, p_finding_id uuid, p_title text)
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
  if p_target_type is null or p_target_type not in (
       'FINDING', 'RECOMMENDATION_ITEM', 'SANCTION', 'CORRECTIVE_ACTION', 'PACKAGE', 'FINAL_PACKAGE', 'OTHER') then
    perform api._fail('INVALID', 'target_type');
  end if;
  if (p_target_type = 'FINDING') <> (p_finding_id is not null)
     or (p_finding_id is not null and not exists (
           select 1 from case_mgmt.finding f where f.id = p_finding_id and f.case_id = v_m.case_id)) then
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

-- Locks an item and its meeting for a vote; returns the item. Internal.
create function committee.lock_vote_item(p_vote_item_id uuid)
returns committee.vote_item
language plpgsql
set search_path = ''
as $$
declare
  v committee.vote_item;
begin
  select * into v from committee.vote_item vi where vi.id = p_vote_item_id;
  if v.id is null or not authz.can_view_meeting_deliberation(v.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  perform 1 from committee.meeting m where m.id = v.meeting_id for update;
  select * into v from committee.vote_item vi where vi.id = p_vote_item_id for update;
  if not exists (select 1 from committee.meeting m where m.id = v.meeting_id and m.status = 'OPEN') then
    perform api._fail('CONFLICT', 'MEETING_NOT_OPEN');
  end if;
  return v;
end;
$$;

-- N4 / N5: a member votes only for themself, as a present voting member with a cleared conflict declaration.
create function api.cast_vote(p_vote_item_id uuid, p_choice text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_p committee.meeting_participant;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  select * into v_p from committee.meeting_participant mp
  where mp.meeting_id = v_item.meeting_id and mp.user_id = v_actor and mp.participant_kind = 'MEMBER';
  if v_p.id is null or not v_p.is_voting then perform api._fail('FORBIDDEN'); end if;
  if v_p.coi_status <> 'NO_CONFLICT' then perform api._fail('CONFLICT', 'COI_NOT_CLEARED'); end if;
  if v_p.attendance <> 'PRESENT' then perform api._fail('CONFLICT', 'NOT_PRESENT'); end if;
  if v_item.status <> 'OPEN' then perform api._fail('CONFLICT', 'VOTE_NOT_OPEN'); end if;
  if p_choice is null or p_choice not in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED') then perform api._fail('INVALID', 'choice'); end if;
  if exists (select 1 from committee.vote v where v.vote_item_id = v_item.id and v.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'ALREADY_VOTED');
  end if;
  insert into committee.vote (vote_item_id, participant_id, recorded_for, recorded_by, source, choice, reason, original_event_at)
  values (v_item.id, v_p.id, v_actor, v_actor, 'SELF', p_choice,
          case when p_reason is not null then api._require_text(p_reason, 'reason', 5, 2000) end, now());
  -- Secrecy (Q61–Q63): the ledger records that a vote was cast, never the choice.
  perform audit.record_event('VOTE_CAST', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id));
end;
$$;

-- N6 (Q60): the secretary records ABSENT, UNABLE_TO_VOTE or RECUSED for a voting member who is not present, with a
-- reason. A present member votes for themself, recusal included (AGENT-09 V1b).
create function api.record_vote_for_member(
  p_vote_item_id uuid, p_participant_id uuid, p_choice text, p_reason text, p_original_event_at timestamptz
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_p committee.meeting_participant;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  if not authz.can_manage_meeting(v_item.meeting_id) then perform api._fail('FORBIDDEN'); end if;
  if p_choice is null or p_choice not in ('ABSENT', 'UNABLE_TO_VOTE', 'RECUSED') then perform api._fail('FORBIDDEN'); end if;
  select * into v_p from committee.meeting_participant mp
  where mp.id = p_participant_id and mp.meeting_id = v_item.meeting_id and mp.participant_kind = 'MEMBER' and mp.is_voting;
  if v_p.id is null then perform api._fail('INVALID', 'participant_id'); end if;
  if v_p.user_id = v_actor then perform api._fail('FORBIDDEN'); end if;
  if v_p.attendance = 'PRESENT' then perform api._fail('CONFLICT', 'MEMBER_PRESENT'); end if;
  if v_item.status <> 'OPEN' then perform api._fail('CONFLICT', 'VOTE_NOT_OPEN'); end if;
  if p_original_event_at is not null and p_original_event_at > now() then perform api._fail('INVALID', 'original_event_at'); end if;
  if exists (select 1 from committee.vote v where v.vote_item_id = v_item.id and v.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'ALREADY_VOTED');
  end if;
  insert into committee.vote (vote_item_id, participant_id, recorded_for, recorded_by, source, choice, reason, original_event_at)
  values (v_item.id, v_p.id, v_p.user_id, v_actor, 'SECRETARY', p_choice, api._require_text(p_reason, 'reason', 5, 2000),
          coalesce(p_original_event_at, now()));
  perform audit.record_event('VOTE_RECORDED_FOR_MEMBER', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id, 'participant_id', v_p.id));
end;
$$;

-- Tallies and closes an item. Quorum from the rule snapshot; CUSTOM rules need the secretary's attestation.
-- Every present, eligible voting member must have a vote row (cast, or recorded by the secretary) first.
create function api.close_vote_item(p_vote_item_id uuid, p_custom_quorum_attested boolean)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_rule jsonb;
  v_eligible int;
  v_present int;
  v_required int;
  v_counts record;
  v_chair_ready boolean;
  v_status text;
  v_result text;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  if not authz.can_manage_meeting(v_item.meeting_id) then perform api._fail('FORBIDDEN'); end if;
  if v_item.status <> 'OPEN' then perform api._fail('CONFLICT', 'VOTE_NOT_OPEN'); end if;
  select cp.rule_snapshot into v_rule
  from committee.meeting m join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
  where m.id = v_item.meeting_id;

  select count(*) filter (where mp.coi_status = 'NO_CONFLICT'),
         count(*) filter (where mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT')
    into v_eligible, v_present
  from committee.meeting_participant mp
  where mp.meeting_id = v_item.meeting_id and mp.participant_kind = 'MEMBER' and mp.is_voting
    and authz.user_case_gate(mp.user_id, v_item.case_id);

  if v_rule ->> 'quorum_type' = 'CUSTOM' then
    if p_custom_quorum_attested is not true then perform api._fail('INVALID', 'custom_quorum_attested'); end if;
    v_required := null;
  else
    if p_custom_quorum_attested is true then perform api._fail('INVALID', 'custom_quorum_attested'); end if;
    v_required := case v_rule ->> 'quorum_type'
                    when 'MAJORITY_ELIGIBLE' then v_eligible / 2 + 1
                    when 'FIXED_NUMBER' then (v_rule ->> 'quorum_value')::numeric::int
                    when 'PERCENTAGE' then ceil(v_eligible * (v_rule ->> 'quorum_value')::numeric / 100)::int
                  end;
  end if;

  if exists (select 1 from committee.meeting_participant mp
             where mp.meeting_id = v_item.meeting_id and mp.participant_kind = 'MEMBER' and mp.is_voting
               and mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT'
               and authz.user_case_gate(mp.user_id, v_item.case_id)
               and not exists (select 1 from committee.vote v where v.vote_item_id = v_item.id and v.participant_id = mp.id)) then
    perform api._fail('CONFLICT', 'VOTES_OUTSTANDING');
  end if;

  -- Counted = votes of members who are present and eligible now; everything else is excluded.
  select count(*) filter (where counted and v.choice = 'APPROVE') as approve,
         count(*) filter (where counted and v.choice = 'REJECT') as reject,
         count(*) filter (where counted and v.choice = 'ABSTAIN') as abstain,
         count(*) filter (where counted and v.choice = 'RECUSED') as recused,
         count(*) filter (where v.choice = 'ABSENT') as absent,
         count(*) filter (where v.choice = 'UNABLE_TO_VOTE') as unable,
         count(*) filter (where not counted and v.choice in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED')) as excluded
    into v_counts
  from (select v.choice, (mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT'
                          and authz.user_case_gate(mp.user_id, v_item.case_id)) as counted
        from committee.vote v join committee.meeting_participant mp on mp.id = v.participant_id
        where v.vote_item_id = v_item.id) v;

  -- The chair breaks a tie only with a counted vote of their own on this item that is not a recusal (AGENT-09 V2).
  v_chair_ready := exists (select 1 from committee.meeting_participant mp
                           join committee.vote v on v.participant_id = mp.id and v.vote_item_id = v_item.id
                           where mp.meeting_id = v_item.meeting_id and mp.participant_kind = 'MEMBER' and mp.seat = 'CHAIR'
                             and mp.is_voting and mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT'
                             and v.choice in ('APPROVE', 'REJECT', 'ABSTAIN')
                             and authz.user_case_gate(mp.user_id, v_item.case_id));
  v_status := 'CLOSED';
  if v_eligible = 0 or (v_required is not null and v_present < v_required) or (v_required is null and v_present = 0) then
    v_result := 'NO_QUORUM';
  elsif v_counts.approve > v_counts.reject then
    v_result := 'APPROVED';
  elsif v_counts.reject > v_counts.approve then
    v_result := 'REJECTED';
  elsif v_counts.approve = 0 then
    -- Nobody approved or rejected: never decided by the chair alone (AGENT-09 V5; label configurable, SOURCE_REQUIRED).
    v_result := coalesce(v_rule ->> 'no_substantive_vote_outcome', 'NO_DECISION');
  elsif coalesce((v_rule ->> 'casting_vote_enabled')::boolean, false) and v_chair_ready then
    v_status := 'AWAITING_CASTING_VOTE';
    v_result := null;
  else
    v_result := 'TIED';
  end if;

  update committee.vote_item
     set status = v_status, result = v_result, eligible_count = v_eligible, present_count = v_present,
         quorum_required = v_required, custom_quorum_attested = coalesce(p_custom_quorum_attested, false),
         approve_count = v_counts.approve, reject_count = v_counts.reject, abstain_count = v_counts.abstain,
         recused_count = v_counts.recused, absent_count = v_counts.absent, unable_count = v_counts.unable,
         excluded_count = v_counts.excluded, tallied_by = v_actor, tallied_at = now(),
         closed_at = case when v_status = 'CLOSED' then now() end
   where id = v_item.id;
  perform audit.record_event('VOTE_CLOSED', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id, 'status', v_status, 'result', v_result, 'eligible', v_eligible,
                       'present', v_present, 'quorum_required', v_required, 'quorum_type', v_rule ->> 'quorum_type',
                       'custom_quorum_attested', coalesce(p_custom_quorum_attested, false),
                       'approve', v_counts.approve, 'reject', v_counts.reject, 'abstain', v_counts.abstain,
                       'recused', v_counts.recused, 'absent', v_counts.absent, 'unable', v_counts.unable,
                       'excluded', v_counts.excluded));
  return coalesce(v_result, v_status);
end;
$$;

-- N8 (Q57): only on a tie the rule lets the chair break, by the present, cleared chair whose own counted vote on the
-- item is not a recusal (AGENT-09 V2).
create function api.cast_casting_vote(p_vote_item_id uuid, p_choice text, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_result text;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  if not exists (select 1 from committee.meeting_participant mp
                 where mp.meeting_id = v_item.meeting_id and mp.user_id = v_actor and mp.participant_kind = 'MEMBER'
                   and mp.seat = 'CHAIR' and mp.is_voting and mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT'
                   and exists (select 1 from committee.vote v
                               where v.vote_item_id = v_item.id and v.participant_id = mp.id
                                 and v.choice in ('APPROVE', 'REJECT', 'ABSTAIN'))) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_item.status <> 'AWAITING_CASTING_VOTE' then perform api._fail('CONFLICT', 'NOT_A_TIE'); end if;
  if p_choice is null or p_choice not in ('APPROVE', 'REJECT') then perform api._fail('INVALID', 'choice'); end if;
  v_result := case p_choice when 'APPROVE' then 'APPROVED' else 'REJECTED' end;
  insert into committee.casting_vote (vote_item_id, cast_by, choice, reason)
  values (v_item.id, v_actor, p_choice, case when p_reason is not null then api._require_text(p_reason, 'reason', 5, 2000) end);
  update committee.vote_item
     set status = 'CLOSED', result = v_result, decided_by_casting_vote = true, closed_at = now()
   where id = v_item.id;
  perform audit.record_event('CASTING_VOTE_CAST', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id, 'result', v_result));
  return v_result;
end;
$$;

-- Q61–Q62: while open, who has voted and when; after close, choices and totals. Read-only.
create function api.vote_item_status(p_vote_item_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_item committee.vote_item;
  v_closed boolean;
begin
  select * into v_item from committee.vote_item vi where vi.id = p_vote_item_id;
  if v_item.id is null or not authz.can_view_meeting_deliberation(v_item.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_closed := v_item.status = 'CLOSED';
  return jsonb_build_object(
    'vote_item_id', v_item.id, 'status', v_item.status, 'result', v_item.result,
    'decided_by_casting_vote', v_item.decided_by_casting_vote,
    'casting_vote', case when v_closed then (select cv.choice from committee.casting_vote cv where cv.vote_item_id = v_item.id) end,
    'tally', case when v_item.tallied_at is not null then jsonb_build_object(
      'eligible', v_item.eligible_count, 'present', v_item.present_count, 'quorum_required', v_item.quorum_required,
      'approve', v_item.approve_count, 'reject', v_item.reject_count, 'abstain', v_item.abstain_count,
      'recused', v_item.recused_count, 'absent', v_item.absent_count, 'unable', v_item.unable_count,
      'excluded', v_item.excluded_count) end,
    'voters', coalesce((
      select jsonb_agg(jsonb_build_object(
               'participant_id', mp.id, 'user_id', mp.user_id, 'seat', mp.seat,
               'has_voted', v.id is not null, 'voted_at', v.recorded_at, 'source', v.source,
               'choice', case when v_closed then v.choice end) order by mp.added_at, mp.id)
      from committee.meeting_participant mp
      left join committee.vote v on v.participant_id = mp.id and v.vote_item_id = v_item.id
      where mp.meeting_id = v_item.meeting_id and mp.participant_kind = 'MEMBER' and mp.is_voting), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- Minutes
-- -----------------------------------------------------------------------------
-- Reviewers: members present with no conflict, other than the secretaries (Q97).
create function committee.minutes_reviewer(p_meeting_id uuid, p_user_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from committee.meeting_participant mp
                 where mp.meeting_id = p_meeting_id and mp.user_id = p_user_id and mp.participant_kind = 'MEMBER'
                   and mp.seat not in ('SECRETARY', 'ALTERNATE_SECRETARY')
                   and mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT'
                   and authz.user_case_gate(p_user_id, (select m.case_id from committee.meeting m where m.id = p_meeting_id)));
$$;

create function api.generate_minutes(p_meeting_id uuid, p_narrative text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.meeting;
  v_prev committee.minutes;
  v_rule jsonb;
  v_snapshot jsonb;
  v_reviewers int;
  v_days int;
  v_id uuid;
  v_status text;
begin
  v_m := committee.lock_managed_meeting(p_meeting_id);
  if v_m.status <> 'CLOSED' then perform api._fail('CONFLICT', 'MEETING_NOT_CLOSED'); end if;
  select * into v_prev from committee.minutes mi where mi.meeting_id = v_m.id and mi.status <> 'SUPERSEDED' for update;
  if v_prev.id is not null and v_prev.status <> 'CHANGES_REQUESTED' then perform api._fail('CONFLICT', 'MINUTES_EXIST'); end if;
  select cp.rule_snapshot into v_rule from committee.committee_proceeding cp where cp.id = v_m.committee_proceeding_id;
  v_days := (v_rule ->> 'minutes_review_business_days')::int;

  -- Attendance, conflicts and results. Never individual choices or conflict reasons.
  v_snapshot := jsonb_build_object(
    'meeting', jsonb_build_object('id', v_m.id, 'sequence_no', v_m.sequence_no, 'purpose', v_m.purpose, 'mode', v_m.mode,
                                  'opened_at', v_m.opened_at, 'closed_at', v_m.closed_at),
    'participants', coalesce((select jsonb_agg(jsonb_build_object(
                       'participant_id', mp.id, 'kind', mp.participant_kind, 'user_id', mp.user_id, 'person_id', mp.person_id,
                       'seat', mp.seat, 'invitee_role', mp.invitee_role, 'is_voting', mp.is_voting,
                       'coi_status', mp.coi_status, 'attendance', mp.attendance) order by mp.added_at, mp.id)
                     from committee.meeting_participant mp where mp.meeting_id = v_m.id), '[]'::jsonb),
    'vote_items', coalesce((select jsonb_agg(jsonb_build_object(
                     'vote_item_id', vi.id, 'sequence_no', vi.sequence_no, 'target_type', vi.target_type,
                     'finding_id', vi.finding_id, 'title', vi.title, 'result', vi.result,
                     'decided_by_casting_vote', vi.decided_by_casting_vote, 'eligible', vi.eligible_count,
                     'present', vi.present_count, 'quorum_required', vi.quorum_required, 'approve', vi.approve_count,
                     'reject', vi.reject_count, 'abstain', vi.abstain_count, 'recused', vi.recused_count,
                     'absent', vi.absent_count, 'unable', vi.unable_count, 'excluded', vi.excluded_count) order by vi.sequence_no)
                   from committee.vote_item vi where vi.meeting_id = v_m.id), '[]'::jsonb));
  select count(*) into v_reviewers from committee.meeting_participant mp
  where mp.meeting_id = v_m.id and committee.minutes_reviewer(v_m.id, mp.user_id);
  -- With nobody to review (no member attended), the minutes record that fact and are final at once.
  v_status := case when v_reviewers = 0 then 'APPROVED' else 'IN_REVIEW' end;

  if v_prev.id is not null then
    update committee.minutes set status = 'SUPERSEDED' where id = v_prev.id;
  end if;
  insert into committee.minutes (meeting_id, case_id, version_no, snapshot, narrative, status, reviewer_count,
                                 review_business_days, review_due_at, deemed_approval_enabled, generated_by, finalised_at)
  values (v_m.id, v_m.case_id, coalesce(v_prev.version_no, 0) + 1, v_snapshot,
          api._require_text(p_narrative, 'narrative', 10, 20000), v_status, v_reviewers, v_days,
          committee.add_business_days(now(), v_days), coalesce((v_rule ->> 'deemed_approval_enabled')::boolean, false),
          v_actor, case when v_status = 'APPROVED' then now() end)
  returning id into v_id;
  perform audit.record_event('MINUTES_GENERATED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'minutes', v_id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'version_no', coalesce(v_prev.version_no, 0) + 1, 'reviewers', v_reviewers,
                       'status', v_status, 'supersedes', v_prev.id));
  return v_id;
end;
$$;

create function api.review_minutes(p_minutes_id uuid, p_decision text, p_comment text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_mi committee.minutes;
  v_status text;
  v_approvals int;
begin
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id;
  if v_mi.id is null or not authz.can_view_meeting_deliberation(v_mi.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id for update;
  if not committee.minutes_reviewer(v_mi.meeting_id, v_actor) or not authz.user_case_gate(v_actor, v_mi.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_mi.status <> 'IN_REVIEW' then perform api._fail('CONFLICT', 'MINUTES_NOT_IN_REVIEW'); end if;
  if p_decision is null or p_decision not in ('APPROVE', 'REQUEST_CHANGES') then perform api._fail('INVALID', 'decision'); end if;
  if exists (select 1 from committee.minutes_review r where r.minutes_id = v_mi.id and r.reviewer_id = v_actor) then
    perform api._fail('CONFLICT', 'ALREADY_REVIEWED');
  end if;
  insert into committee.minutes_review (minutes_id, reviewer_id, decision, comment)
  values (v_mi.id, v_actor, p_decision,
          case when p_decision = 'REQUEST_CHANGES' or p_comment is not null then api._require_text(p_comment, 'comment', 5, 4000) end);
  select count(*) into v_approvals from committee.minutes_review r where r.minutes_id = v_mi.id and r.decision = 'APPROVE';
  v_status := case when p_decision = 'REQUEST_CHANGES' then 'CHANGES_REQUESTED'
                   when v_approvals >= v_mi.reviewer_count then 'APPROVED'
                   else 'IN_REVIEW' end;
  if v_status <> v_mi.status then
    update committee.minutes set status = v_status, finalised_at = case when v_status = 'APPROVED' then now() end
     where id = v_mi.id;
  end if;
  perform audit.record_event('MINUTES_REVIEWED', 'BUSINESS', 'SUCCESS', v_mi.case_id, 'minutes', v_mi.id::text, null,
    jsonb_build_object('meeting_id', v_mi.meeting_id, 'decision', p_decision, 'status', v_status));
  return v_status;
end;
$$;

-- Records that reviewers were reminded before the window ends (Q98). PRODUCTION_SUBSTITUTION_REQUIRED: the
-- notification engine (ADR-025, phase 8) sends it; the reminder carries no minutes content (§39).
create function api.record_minutes_reminder(p_minutes_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_mi committee.minutes;
begin
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id;
  if v_mi.id is null or not authz.can_view_meeting_deliberation(v_mi.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_manage_meeting(v_mi.meeting_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id for update;
  if v_mi.status <> 'IN_REVIEW' then perform api._fail('CONFLICT', 'MINUTES_NOT_IN_REVIEW'); end if;
  if v_mi.reminder_sent_at is not null then perform api._fail('CONFLICT', 'REMINDER_ALREADY_SENT'); end if;
  update committee.minutes set reminder_sent_by = v_actor, reminder_sent_at = now() where id = v_mi.id;
  perform audit.record_event('MINUTES_REMINDER_SENT', 'BUSINESS', 'SUCCESS', v_mi.case_id, 'minutes', v_mi.id::text, null,
    jsonb_build_object('meeting_id', v_mi.meeting_id, 'review_due_at', v_mi.review_due_at,
                       'pending_reviewers', v_mi.reviewer_count
                         - (select count(*) from committee.minutes_review r where r.minutes_id = v_mi.id)));
end;
$$;

-- Deemed approval after the window and a reminder (Q98). Idempotent: already final minutes return their status
-- with no new event. PRODUCTION_SUBSTITUTION_REQUIRED: invoked by the scheduler port; the secretary may run it.
create function api.apply_minutes_deemed_approval(p_minutes_id uuid)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_mi committee.minutes;
begin
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id;
  if v_mi.id is null or not authz.can_view_meeting_deliberation(v_mi.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_manage_meeting(v_mi.meeting_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id for update;
  if v_mi.status in ('APPROVED', 'DEEMED_APPROVED') then return v_mi.status; end if;
  if v_mi.status <> 'IN_REVIEW' then perform api._fail('CONFLICT', 'MINUTES_NOT_IN_REVIEW'); end if;
  if not v_mi.deemed_approval_enabled then perform api._fail('CONFLICT', 'DEEMED_APPROVAL_DISABLED'); end if;
  if v_mi.reminder_sent_at is null then perform api._fail('CONFLICT', 'REMINDER_NOT_SENT'); end if;
  if now() < v_mi.review_due_at then perform api._fail('CONFLICT', 'REVIEW_WINDOW_OPEN'); end if;
  update committee.minutes set status = 'DEEMED_APPROVED', finalised_at = now() where id = v_mi.id;
  perform audit.record_event('MINUTES_DEEMED_APPROVED', 'BUSINESS', 'SUCCESS', v_mi.case_id, 'minutes', v_mi.id::text, null,
    jsonb_build_object('meeting_id', v_mi.meeting_id, 'review_due_at', v_mi.review_due_at,
                       'reviews', (select count(*) from committee.minutes_review r where r.minutes_id = v_mi.id),
                       'reviewer_count', v_mi.reviewer_count));
  return 'DEEMED_APPROVED';
end;
$$;

grant execute on function
  api.schedule_meeting(uuid, text, text, text, text, timestamptz, timestamptz, text),
  api.invite_to_meeting(uuid, text, uuid, uuid, boolean, text),
  api.declare_meeting_conflict(uuid, text, text),
  api.open_meeting(uuid, text),
  api.record_attendance(uuid, text),
  api.close_meeting(uuid, text),
  api.cancel_meeting(uuid, text),
  api.open_vote_item(uuid, text, uuid, text),
  api.cast_vote(uuid, text, text),
  api.record_vote_for_member(uuid, uuid, text, text, timestamptz),
  api.close_vote_item(uuid, boolean),
  api.cast_casting_vote(uuid, text, text),
  api.vote_item_status(uuid),
  api.generate_minutes(uuid, text),
  api.review_minutes(uuid, text, text),
  api.record_minutes_reminder(uuid),
  api.apply_minutes_deemed_approval(uuid)
to authenticated;
