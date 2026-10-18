-- =============================================================================
-- 2125 A bound paper ballot is superseded only after a second actor releases it
-- (Rebase; CDF-264; ADR-062; follow-up to CDF-262)
-- Requirements: §19, §20, §29, §82, §83; ADR-048 (2120), ADR-061; N6 (Q60); DEC-AMB-008; the coordinator's ruling of
-- 2026-10-18 19:08 UTC on AGENT-09's observation O1 of PR #112, design confirmed 19:09 UTC (release first).
--
-- 2120 left one path by which a member's paper ballot could stop counting on the secretary's act alone: record the
-- member ABSENT, then record them under N6 (ABSENT, UNABLE_TO_VOTE or RECUSED), and the settle trigger marks their
-- provisional ballot SUPERSEDED. The secretary transcribed every ballot and so knows its choice. The ruling (F1 B′:
-- the vote belongs to the member alone): the secretary still records the fact of absence, but superseding a bound
-- ballot takes a second actor, the chair or the member, ahead of the secretary, fail-closed.
--   1. api.record_vote_for_member (N6) refuses BALLOT_HELD while the member holds a provisional ballot bound to the
--      item that nobody has released. A trigger on the vote's insert refuses the same thing as a backstop.
--   2. The member's own act: api.decline_offline_ballot releases their own bound ballot (a ballot they dispute, or
--      one they cannot confirm). Who they are is checked as for api.confirm_offline_ballot; they need not attend.
--   3. The chair's act: api.release_offline_ballot releases a bound ballot of a member who is not present, with a
--      reason. Only the meeting's chair for rulings (committee.meeting_chair_as: the chair, cleared and attending, or
--      an activated acting chair), never whoever runs the meeting, never the ballot's own member, and never anyone
--      the workbook excludes from approving (its importer, its preparer, an offline recorder, a conflict subject or
--      an external account: exchange.bcp_approver_excluded, A-36).
--   4. A released ballot stays PROVISIONAL and its member may still confirm it until a vote settles it; then the
--      secretary's N6 record supersedes it as in 2120, and api.close_vote_item still refuses BALLOTS_UNCONFIRMED
--      until it does. A release happens once and is never undone.
-- The ledger gets ids only (OFFLINE_BALLOT_DECLINED, OFFLINE_BALLOT_RELEASED); the chair's reason stays on the ballot
-- row, which no application role reads. The read models are replaced with the flags (flag == command):
-- record_vote_for leaves out a held ballot's member, and each vote item gains ballots_releasable_for (the chair's),
-- may_decline_ballot (the member's) and my_ballot.release.
-- Out of scope (ruled): correcting a mis-transcribed ballot after commit stays with Section 13's pre-attestation view.
--
-- Sections:
--   1. The release on the ballot, and its integrity.
--   2. The member's decline and the chair's release.
--   3. N6 and the settle backstop.
--   4. Read models: api.meeting_view, api.vote_item_status.
--   5. Grants and the catalogue.
-- Synthetic data only. Nothing here is a production control; the BCP path is a reference emulation (ADR-034).
-- =============================================================================

-- =============================================================================
-- 1. The release
-- =============================================================================
alter table committee.offline_ballot
  add column released_at    timestamptz,
  add column released_by    uuid references iam.user_profile (id),
  add column release_kind   text check (release_kind in ('MEMBER', 'CHAIR')),
  add column release_reason text check (release_reason is null or length(release_reason) between 5 and 2000),
  add constraint offline_ballot_release check (
    (released_at is null) = (released_by is null)
    and (released_at is null) = (release_kind is null)
    and coalesce(release_kind = 'CHAIR', false) = (release_reason is not null)
    and (release_kind is distinct from 'MEMBER' or released_by = user_id)
    and (release_kind is distinct from 'CHAIR' or released_by <> user_id)
    and (released_at is null or vote_item_id is not null));
create index offline_ballot_released_by on committee.offline_ballot (released_by);
comment on column committee.offline_ballot.released_at is
  'Migration 2125 (ADR-062): when the ballot was released for the secretary''s N6 record, by its member '
  '(api.decline_offline_ballot) or by the meeting''s chair with a reason (api.release_offline_ballot). Null: the '
  'ballot holds N6 (BALLOT_HELD). Once, never undone; the ballot stays provisional until a vote settles it.';

-- Replaces 2120: as built, plus the release, once, with nothing else changing.
create or replace function committee.protect_offline_ballot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'offline ballots are never deleted' using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'PROVISIONAL' and new.status = 'PROVISIONAL' and old.vote_item_id is null
     and new.vote_item_id is not null and (to_jsonb(new) - 'vote_item_id') = (to_jsonb(old) - 'vote_item_id') then
    return new;
  end if;
  if old.status = 'PROVISIONAL' and new.status in ('CONFIRMED', 'SUPERSEDED', 'LAPSED')
     and (to_jsonb(new) - array['status', 'vote_id', 'settled_at']) = (to_jsonb(old) - array['status', 'vote_id', 'settled_at'])
     and (new.vote_id is null or exists (select 1 from committee.vote v
                                         where v.id = new.vote_id and v.vote_item_id = old.vote_item_id
                                           and v.participant_id = old.participant_id)) then
    return new;
  end if;
  -- 2125 (ADR-062): a provisional ballot bound to its vote item is released once (by its member, or by the meeting's
  -- chair with a reason), with nothing else changing.
  if old.status = 'PROVISIONAL' and new.status = 'PROVISIONAL' and old.vote_item_id is not null
     and old.released_at is null and new.released_at is not null
     and (to_jsonb(new) - array['released_at', 'released_by', 'release_kind', 'release_reason'])
         = (to_jsonb(old) - array['released_at', 'released_by', 'release_kind', 'release_reason']) then
    return new;
  end if;
  raise exception 'offline ballot % is settled or immutable', old.id using errcode = 'insufficient_privilege';
end;
$$;

-- =============================================================================
-- 2. The member's decline and the chair's release
-- =============================================================================
-- The member's own act (ADR-062): they release their own provisional ballot bound to this item, so that it no longer
-- holds the secretary's N6 record: a ballot they dispute (they do not confirm it) or one they cannot confirm.
-- api.confirm_offline_ballot's checks on who they are (a counting seat of their own, not replaced, still seated);
-- not presence or a cleared conflict: letting their ballot go casts nothing, and a member who is not present is the
-- one N6 is for. The caller is the member, by construction. The ledger gets ids only.
create function api.decline_offline_ballot(p_vote_item_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_p committee.meeting_participant;
  v_b committee.offline_ballot;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  select * into v_p from committee.meeting_participant mp
  where mp.meeting_id = v_item.meeting_id and mp.user_id = v_actor and mp.participant_kind = 'MEMBER';
  if v_p.id is null or not (v_p.is_voting or committee.is_activated_alternate(v_p.id)) then perform api._fail('FORBIDDEN'); end if;
  if committee.is_replaced_member(v_p.id) then perform api._fail('CONFLICT', 'REPLACED_BY_ALTERNATE'); end if;
  if not committee.member_seat_current(v_p.id) then perform api._fail('CONFLICT', 'SEAT_ENDED'); end if;
  if v_item.status <> 'OPEN' then perform api._fail('CONFLICT', 'VOTE_NOT_OPEN'); end if;
  select * into v_b from committee.offline_ballot b
   where b.vote_item_id = v_item.id and b.participant_id = v_p.id and b.user_id = v_actor and b.status = 'PROVISIONAL'
   for update;
  if v_b.id is null then perform api._fail('CONFLICT', 'NO_PROVISIONAL_BALLOT'); end if;
  if v_b.released_at is not null then perform api._fail('CONFLICT', 'BALLOT_RELEASED'); end if;

  update committee.offline_ballot
     set released_at = clock_timestamp(), released_by = v_actor, release_kind = 'MEMBER'
   where id = v_b.id;
  perform audit.record_event('OFFLINE_BALLOT_DECLINED', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item',
    v_item.id::text, null, jsonb_build_object('meeting_id', v_item.meeting_id, 'ballot_id', v_b.id));
end;
$$;

-- The chair's act (ADR-062): the meeting's chair for rulings (committee.meeting_chair_as) releases the provisional
-- ballot bound to this item of a member who is not present, with a reason. Never whoever runs the meeting, never the
-- ballot's own member (theirs is api.decline_offline_ballot), and never anyone the workbook that carried the ballot
-- excludes from approving (exchange.bcp_approver_excluded: its importer, its preparer, an offline recorder, a
-- conflict subject or an external account; A-36). A present member acts for themself (MEMBER_PRESENT). The reason
-- stays on the ballot row; the ledger gets ids only.
create function api.release_offline_ballot(p_vote_item_id uuid, p_participant_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_p committee.meeting_participant;
  v_b committee.offline_ballot;
  v_reason text;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  if committee.meeting_chair_as(v_item.meeting_id, v_actor) is null
     or committee.manages_meeting(v_item.meeting_id, v_actor) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_item.status <> 'OPEN' then perform api._fail('CONFLICT', 'VOTE_NOT_OPEN'); end if;
  select * into v_p from committee.meeting_participant mp
  where mp.id = p_participant_id and mp.meeting_id = v_item.meeting_id and mp.participant_kind = 'MEMBER';
  if v_p.id is null then perform api._fail('INVALID', 'participant_id'); end if;
  if v_p.user_id = v_actor then perform api._fail('FORBIDDEN'); end if;
  select * into v_b from committee.offline_ballot b
   where b.vote_item_id = v_item.id and b.participant_id = v_p.id and b.status = 'PROVISIONAL'
   for update;
  if v_b.id is null then perform api._fail('CONFLICT', 'NO_PROVISIONAL_BALLOT'); end if;
  if exchange.bcp_approver_excluded(v_b.batch_id, v_actor) then perform api._fail('FORBIDDEN'); end if;
  if v_p.attendance = 'PRESENT' then perform api._fail('CONFLICT', 'MEMBER_PRESENT'); end if;
  if v_b.released_at is not null then perform api._fail('CONFLICT', 'BALLOT_RELEASED'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);

  update committee.offline_ballot
     set released_at = clock_timestamp(), released_by = v_actor, release_kind = 'CHAIR', release_reason = v_reason
   where id = v_b.id;
  perform audit.record_event('OFFLINE_BALLOT_RELEASED', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item',
    v_item.id::text, null, jsonb_build_object('meeting_id', v_item.meeting_id, 'ballot_id', v_b.id));
end;
$$;

-- =============================================================================
-- 3. N6 and the settle backstop
-- =============================================================================
-- Replaces 2030: as built, plus BALLOT_HELD (ADR-062): never over a provisional ballot bound to the item that its
-- member or the meeting's chair has not released.
create or replace function api.record_vote_for_member(
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
  where mp.id = p_participant_id and mp.meeting_id = v_item.meeting_id and mp.participant_kind = 'MEMBER'
    and (mp.is_voting or committee.is_activated_alternate(mp.id)) and not committee.is_replaced_member(mp.id);
  if v_p.id is null then perform api._fail('INVALID', 'participant_id'); end if;
  if v_p.user_id = v_actor then perform api._fail('FORBIDDEN'); end if;
  if v_p.attendance = 'PRESENT' then perform api._fail('CONFLICT', 'MEMBER_PRESENT'); end if;
  if v_item.status <> 'OPEN' then perform api._fail('CONFLICT', 'VOTE_NOT_OPEN'); end if;
  if p_original_event_at is not null and p_original_event_at > now() then perform api._fail('INVALID', 'original_event_at'); end if;
  if exists (select 1 from committee.vote v where v.vote_item_id = v_item.id and v.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'ALREADY_VOTED');
  end if;
  -- 2125 (ADR-062): never over a provisional paper ballot bound here that its member or the meeting's chair has not
  -- released.
  if exists (select 1 from committee.offline_ballot b
             where b.vote_item_id = v_item.id and b.participant_id = v_p.id and b.status = 'PROVISIONAL'
               and b.released_at is null) then
    perform api._fail('CONFLICT', 'BALLOT_HELD');
  end if;
  insert into committee.vote (vote_item_id, participant_id, recorded_for, recorded_by, source, choice, reason, original_event_at)
  values (v_item.id, v_p.id, v_p.user_id, v_actor, 'SECRETARY', p_choice, api._require_text(p_reason, 'reason', 5, 2000),
          coalesce(p_original_event_at, now()));
  perform audit.record_event('VOTE_RECORDED_FOR_MEMBER', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id, 'participant_id', v_p.id));
end;
$$;

-- Replaces 2120: as built, plus the backstop for api.record_vote_for_member's BALLOT_HELD: a vote that is not the
-- member's own (the secretary's N6 record) never settles a ballot nobody has released.
create or replace function committee.settle_offline_ballot()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_b committee.offline_ballot;
  v_status text;
begin
  select * into v_b from committee.offline_ballot b
   where b.vote_item_id = new.vote_item_id and b.participant_id = new.participant_id and b.status = 'PROVISIONAL'
   for update;
  if v_b.id is null then return null; end if;
  v_status := case when v_b.id::text = current_setting('cdf.offline_ballot_confirming', true)
                        and new.source = 'SELF' and new.recorded_by = v_b.user_id and new.choice = v_b.choice
                   then 'CONFIRMED' else 'SUPERSEDED' end;
  -- 2125 (ADR-062): a vote that is not the member's own never supersedes a ballot nobody has released
  -- (api.record_vote_for_member refuses BALLOT_HELD first).
  if v_status = 'SUPERSEDED' and new.source <> 'SELF' and v_b.released_at is null then
    raise exception 'offline ballot % is held', v_b.id using errcode = 'insufficient_privilege';
  end if;
  update committee.offline_ballot set status = v_status, vote_id = new.id, settled_at = clock_timestamp()
   where id = v_b.id;
  if v_status = 'SUPERSEDED' then
    perform audit.record_event('OFFLINE_BALLOT_SUPERSEDED', 'BUSINESS', 'SUCCESS', v_b.case_id, 'vote_item',
      new.vote_item_id::text, null,
      jsonb_build_object('meeting_id', v_b.meeting_id, 'ballot_id', v_b.id, 'source', new.source));
  end if;
  return null;
end;
$$;

-- =============================================================================
-- 4. Read models
-- =============================================================================
-- Replaces 2120: as built, plus (flag == command) record_vote_for without a held ballot's member
-- (api.record_vote_for_member: BALLOT_HELD), ballots_releasable_for (api.release_offline_ballot), may_decline_ballot
-- (api.decline_offline_ballot) and my_ballot.release.
create or replace function api.meeting_view(p_meeting_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_me uuid := authz.current_user_id();
  v_m committee.meeting;
  v_cp committee.committee_proceeding;
  v_committee committee.committee;
  v_own committee.meeting_participant;
  v_proceeding_status text;
  v_roster boolean;
  v_delib boolean;
  v_runs boolean;
  v_manage boolean;
  v_attendance_open boolean;
  v_case_active boolean;
  v_metadata boolean;
  v_secret boolean;
  v_items_undecided boolean;
  v_active boolean;
  v_acknowledged boolean;
  v_current_minutes text;
  v_q record;
  v_full boolean;
  v_case jsonb;
  v_concerns jsonb;
  -- 2085.
  v_may_invite boolean;
  v_chair committee.meeting_participant;
  v_chair_basis text;
  v_deputy committee.meeting_participant;
  v_secretary uuid;
  v_may_acting_secretary boolean;
  v_alternates_open boolean;
  v_grievance boolean;
  -- 2125.
  v_ballot_chair boolean;
begin
  select * into v_m from committee.meeting m where m.id = p_meeting_id;
  if v_m.id is null then perform api._fail('NOT_FOUND'); end if;
  v_full := authz.can_view_meeting(v_m.id);
  -- Concern-only reader: someone who may not see the meeting but may see one of its concerns (the committee's
  -- conflict authority, or a seated deputy who reverses), reached by MEETING_CONFLICT_DECISION_REQUESTED. Everyone
  -- else gets the same NOT_FOUND as a meeting that does not exist.
  if not v_full and not exists (select 1 from committee.meeting_conflict_concern c
                                where c.meeting_id = v_m.id and authz.can_view_meeting_concern(c.id)) then
    perform api._fail('NOT_FOUND');
  end if;

  v_case_active := exists (select 1 from case_mgmt.case_record c where c.id = v_m.case_id and c.records_state = 'ACTIVE');
  v_metadata := authz.can_view_case_metadata(v_m.case_id);
  v_items_undecided := exists (select 1 from committee.vote_item vi where vi.meeting_id = v_m.id and vi.status <> 'CLOSED');
  v_active := v_m.status in ('SCHEDULED', 'OPEN');
  -- As in 1820: the case is named only to whoever may see its metadata.
  v_case := jsonb_build_object(
    'case_id', case when v_metadata then v_m.case_id end,
    'case_number', case when v_metadata then (select c.case_number from case_mgmt.case_record c where c.id = v_m.case_id) end);
  -- meeting_conflict_concern_read and meeting_conflict_reversal_read: the rows passing authz.can_view_meeting_concern.
  v_concerns := coalesce((
    select jsonb_agg(jsonb_build_object(
             'concern_id', c.id, 'participant_id', c.participant_id, 'raised_by', c.raised_by,
             'raised_as', c.raised_as, 'reason', c.reason, 'raised_at', c.raised_at, 'status', c.status,
             'decided_by', c.decided_by, 'decided_as', c.decided_as, 'decision_reason', c.decision_reason,
             'decided_at', c.decided_at,
             'reversal', (select jsonb_build_object('reversal_id', r.id, 'reversed_by', r.reversed_by,
                                                    'reversed_as', r.reversed_as, 'reason', r.reason,
                                                    'reversed_at', r.reversed_at)
                          from committee.meeting_conflict_reversal r where r.concern_id = c.id),
             'capabilities', jsonb_build_object(
               -- api.decide_meeting_conflict.
               'may_decide', authz.meeting_concern_decider_seat(c.id) is not null and v_case_active
                             and c.status = 'OPEN' and v_active and not v_items_undecided,
               -- api.reverse_meeting_conflict_determination.
               'may_reverse', c.status = 'UPHELD'
                              and not exists (select 1 from committee.meeting_conflict_reversal r where r.concern_id = c.id)
                              and committee.concern_reverser_seat(c.id, v_me) is not null and v_case_active))
           order by c.raised_at, c.id)
    from committee.meeting_conflict_concern c
    where c.meeting_id = v_m.id and authz.can_view_meeting_concern(c.id)), '[]'::jsonb);

  if not v_full then
    -- The concern-only view: the meeting's id and status, the case under its metadata predicate, and the concerns
    -- the caller may see with their two capabilities. No logistics, roster, vote, acting role, exclusion or minutes.
    return jsonb_build_object('meeting_id', v_m.id, 'status', v_m.status, 'case', v_case, 'concerns', v_concerns);
  end if;

  select * into v_cp from committee.committee_proceeding cp where cp.id = v_m.committee_proceeding_id;
  select * into v_committee from committee.committee c where c.id = v_cp.committee_id;
  select p.status into v_proceeding_status from case_mgmt.proceeding p where p.id = v_cp.proceeding_id;
  select * into v_own from committee.meeting_participant mp where mp.meeting_id = v_m.id and mp.user_id = v_me;

  v_roster := authz.can_view_meeting_roster(v_m.id);
  v_delib := authz.can_view_meeting_deliberation(v_m.id);
  v_runs := authz.can_manage_meeting(v_m.id);
  -- 2125. api.release_offline_ballot: the meeting's chair for rulings, never whoever runs the meeting.
  v_ballot_chair := committee.meeting_chair_as(v_m.id, v_me) is not null and not v_runs;
  -- committee.lock_managed_meeting: running the meeting, on an active case.
  v_manage := v_runs and v_case_active;
  -- 2065. api.record_attendance and api.record_excused_absence: committee.lock_managed_meeting, then the meeting OPEN
  -- and no vote item undecided.
  v_attendance_open := coalesce(v_manage and v_m.status = 'OPEN' and not v_items_undecided, false);
  v_secret := coalesce(v_cp.rule_snapshot ->> 'ballot_secrecy', 'COMMITTEE_AFTER_CLOSE') = 'SECRET_BALLOT';
  v_acknowledged := v_own.id is not null
                    and exists (select 1 from committee.confidentiality_ack a where a.participant_id = v_own.id);
  select mi.status into v_current_minutes from committee.minutes mi where mi.meeting_id = v_m.id and mi.status <> 'SUPERSEDED';
  select * into v_q from committee.quorum_state(v_m.id);

  -- 2085. api.invite_to_meeting: committee.lock_managed_meeting, the meeting active, and a role the rule enables
  -- (INVITEE_TYPE_DISABLED otherwise). The person or user chosen, and the role a firewall-restricted member may take,
  -- are the command's to answer.
  v_may_invite := coalesce(v_manage and v_active
                           and exists (select 1 from committee.invitee_type_rule r where r.enabled), false);
  -- 2085. api.activate_acting_chair: committee.lock_managed_meeting, the meeting active, no vote item undecided, no
  -- acting chair yet (ALREADY_ACTIVATED); the chair's row as the command reads it and the basis it derives
  -- (CHAIR_AVAILABLE when none); the first eligible deputy chair (NO_ELIGIBLE_DEPUTY), who is not the caller
  -- (meeting_acting_role: activated_by <> user_id).
  if v_manage and v_active and not v_items_undecided
     and not exists (select 1 from committee.meeting_acting_role a
                     where a.meeting_id = v_m.id and a.acting_role = 'ACTING_CHAIR') then
    select * into v_chair from committee.meeting_participant mp
    where mp.meeting_id = v_m.id and mp.participant_kind = 'MEMBER' and mp.seat = 'CHAIR'
    order by mp.added_at, mp.id limit 1;
    v_chair_basis := case
                       when v_chair.id is null then 'VACANT'
                       when v_chair.coi_status = 'CONFLICT_DECLARED' then 'CONFLICTED'
                       when not committee.member_seat_current(v_chair.id)
                            or not authz.user_case_gate(v_chair.user_id, v_m.case_id) then 'INELIGIBLE'
                       when v_chair.attendance in ('ABSENT', 'EXCUSED') then 'ABSENT'
                     end;
    if v_chair_basis is not null then
      select * into v_deputy from committee.meeting_participant mp
      where mp.meeting_id = v_m.id and mp.participant_kind = 'MEMBER' and mp.seat = 'DEPUTY_CHAIR'
        and mp.coi_status = 'NO_CONFLICT' and mp.attendance not in ('ABSENT', 'EXCUSED', 'EXCUSED_CONFLICT')
        and committee.counts_as_voter(mp.id)
      order by mp.added_at, mp.id limit 1;
    end if;
  end if;
  -- 2085. api.activate_acting_secretary: committee.lock_visible_meeting (this view), then the committee's current
  -- secretary in the registry, as the command reads it, passing the case gate, or the meeting's chair
  -- (committee.meeting_chair_as); the case ACTIVE, the meeting active, no vote item undecided, no acting secretary yet,
  -- and an eligible alternate secretary other than the caller (NO_ELIGIBLE_ALTERNATE).
  select ms.user_id into v_secretary from committee.membership ms
  join iam.user_profile u on u.id = ms.user_id and u.status = 'ACTIVE'
  where ms.committee_id = v_cp.committee_id and ms.seat = 'SECRETARY'
    and ms.effective_from <= now() and (ms.effective_to is null or ms.effective_to > now())
  order by ms.effective_from desc limit 1;
  v_may_acting_secretary := coalesce(
    ((v_secretary = v_me and authz.user_case_gate(v_me, v_m.case_id))
     or committee.meeting_chair_as(v_m.id, v_me) is not null)
    and v_case_active and v_active and not v_items_undecided
    and not exists (select 1 from committee.meeting_acting_role a
                    where a.meeting_id = v_m.id and a.acting_role = 'ACTING_SECRETARY')
    and exists (select 1 from committee.membership ms
                join iam.user_profile u on u.id = ms.user_id and u.status = 'ACTIVE'
                where ms.committee_id = v_cp.committee_id and ms.seat = 'ALTERNATE_SECRETARY'
                  and ms.effective_from <= now() and (ms.effective_to is null or ms.effective_to > now())
                  and ms.user_id <> v_me and authz.user_case_gate(ms.user_id, v_m.case_id)
                  and not exists (select 1 from committee.meeting_participant mp
                                  where mp.meeting_id = v_m.id and mp.user_id = ms.user_id
                                    and mp.coi_status = 'CONFLICT_DECLARED')), false);
  -- 2085. api.activate_alternate_member, as far as the meeting goes: committee.lock_managed_meeting, the meeting OPEN
  -- (MEETING_NOT_OPEN), no vote item undecided (VOTE_IN_PROGRESS).
  v_alternates_open := coalesce(v_manage and v_m.status = 'OPEN' and not v_items_undecided, false);
  v_grievance := v_committee.kind = 'GRIEVANCE';

  return jsonb_build_object(
    'meeting_id', v_m.id,
    'committee_proceeding_id', v_m.committee_proceeding_id,
    'committee', jsonb_build_object('committee_id', v_committee.id, 'code', v_committee.code, 'kind', v_committee.kind),
    'case', v_case,
    'logistics', jsonb_build_object(
      'sequence_no', v_m.sequence_no, 'purpose', v_m.purpose, 'mode', v_m.mode, 'provider', v_m.provider,
      'status', v_m.status, 'location', v_m.location, 'online_url', v_m.online_url,
      'scheduled_start', v_m.scheduled_start, 'scheduled_end', v_m.scheduled_end, 'is_emergency', v_m.is_emergency,
      'opened_at', v_m.opened_at, 'closed_at', v_m.closed_at,
      -- 2120 (ADR-048): a meeting held offline takes its votes only from its members' paper ballots.
      'held_offline', v_m.held_offline),
    'me', case when v_own.id is not null then jsonb_build_object(
      'participant_id', v_own.id, 'participant_kind', v_own.participant_kind, 'seat', v_own.seat,
      'invitee_role', v_own.invitee_role, 'is_voting', v_own.is_voting, 'requires_coi', v_own.requires_coi,
      'coi_status', v_own.coi_status, 'attendance', v_own.attendance,
      'confidentiality_ack_required', v_own.confidentiality_ack_required,
      'confidentiality_acknowledged', v_acknowledged,
      -- 2085: the caller's own accommodations (meeting_accommodation_read), for an invitee who sees no roster.
      'accommodations', coalesce((
        select jsonb_agg(jsonb_build_object('accommodation_id', ma.id, 'details', ma.details, 'source', ma.source,
                                            'recorded_at', ma.recorded_at) order by ma.recorded_at, ma.id)
        from committee.meeting_accommodation ma where ma.participant_id = v_own.id), '[]'::jsonb)) end,
    'roster', case when v_roster then coalesce((
      select jsonb_agg(jsonb_build_object(
               'participant_id', mp.id, 'participant_kind', mp.participant_kind, 'user_id', mp.user_id,
               'person_id', mp.person_id, 'display_name', u.display_name, 'display_name_ar', u.display_name_ar,
               'seat', mp.seat, 'invitee_role', mp.invitee_role, 'is_voting', mp.is_voting,
               'requires_coi', mp.requires_coi, 'coi_status', mp.coi_status, 'attendance', mp.attendance,
               -- 2085: the members the alternate on this row may replace now (api.activate_alternate_member), for the
               -- meeting's runner only; empty on any other row and for anyone else.
               'alternate_for', af.ids,
               -- 2085: what confidentiality_ack_read and meeting_accommodation_read let the caller read about this
               -- participant: the meeting's runner (authz.can_manage_meeting) on any row, a participant on their own
               -- (this view is authz.can_view_meeting). Null for anyone else. The details may concern health (AMB-157).
               'arrangements', case when v_runs or mp.user_id = v_me then jsonb_build_object(
                 'confidentiality_acknowledged',
                   exists (select 1 from committee.confidentiality_ack a where a.participant_id = mp.id),
                 'accommodations', coalesce((
                   select jsonb_agg(jsonb_build_object('accommodation_id', ma.id, 'details', ma.details,
                                                       'source', ma.source, 'recorded_at', ma.recorded_at)
                                    order by ma.recorded_at, ma.id)
                   from committee.meeting_accommodation ma where ma.participant_id = mp.id), '[]'::jsonb)) end,
               -- 2065: what the caller may record about this participant now. Computed only for the meeting's runner
               -- (any row) or on the caller's own row (the commands a participant runs on themself); on anyone else's
               -- row every flag is false, so no flag tells one participant about another.
               'capabilities', case when v_runs or mp.user_id = v_me then jsonb_build_object(
                 -- api.record_attendance with each value: v_attendance_open, then the participant's checks for that
                 -- value in the command's order, and committee.refuse_excluded_participant on the update (2010).
                 'may_record_present', coalesce(v_attendance_open and mp.coi_status in ('NO_CONFLICT', 'NOT_REQUIRED')
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id)
                     and not committee.is_replaced_member(mp.id)
                     and (mp.participant_kind <> 'MEMBER' or committee.member_seat_current(mp.id))
                     and (not mp.confidentiality_ack_required
                          or exists (select 1 from committee.confidentiality_ack a where a.participant_id = mp.id))
                     -- 2120 (F2): in a meeting held offline, a member only as their attested roster line attended.
                     and (not v_m.held_offline or mp.participant_kind <> 'MEMBER'
                          or committee.offline_roster_attended(v_m.id, mp.user_id)),
                     false),
                 'may_record_absent', coalesce(v_attendance_open and mp.coi_status <> 'CONFLICT_DECLARED'
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 'may_record_excused_conflict', coalesce(v_attendance_open and mp.coi_status = 'CONFLICT_DECLARED'
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 -- api.record_excused_absence: v_attendance_open, no declared conflict, not already excused, and
                 -- committee.refuse_excluded_participant on the update.
                 'may_record_excused_absence', coalesce(v_attendance_open and mp.coi_status <> 'CONFLICT_DECLARED'
                     and mp.attendance <> 'EXCUSED'
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 -- api.raise_meeting_conflict about this participant: the runner, or a member with no conflict cleared
                 -- for the case; never one's own row; an active case and meeting, no vote item undecided, a
                 -- declaration required and not a conflict already, no concern open; and
                 -- committee.refuse_excluded_participant on the insert.
                 'may_raise_concern', coalesce(
                     (v_runs or (v_own.id is not null and v_own.participant_kind = 'MEMBER'
                                 and v_own.coi_status = 'NO_CONFLICT' and authz.user_case_gate(v_me, v_m.case_id)))
                     and mp.user_id is distinct from v_me
                     and v_case_active and v_active and not v_items_undecided
                     and mp.requires_coi and mp.coi_status <> 'CONFLICT_DECLARED'
                     and not exists (select 1 from committee.meeting_conflict_concern c
                                     where c.participant_id = mp.id and c.status = 'OPEN')
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 -- 2085. api.exclude_meeting_witness: committee.lock_managed_meeting, the meeting active, a WITNESS
                 -- invitee, not already excluded (ALREADY_EXCLUDED), no concern about them open (CONCERN_OPEN).
                 'may_exclude_witness', coalesce(v_manage and v_active
                     and mp.participant_kind = 'INVITEE' and mp.invitee_role = 'WITNESS'
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id)
                     and not exists (select 1 from committee.meeting_conflict_concern c
                                     where c.participant_id = mp.id and c.status = 'OPEN'),
                     false),
                 -- 2085. api.record_meeting_accommodation: the participant themself (SELF), or the meeting's runner
                 -- (SECRETARY; the command takes authz.can_manage_meeting without the case check); the meeting
                 -- active; committee.refuse_excluded_participant on the insert.
                 'may_record_accommodation', coalesce((mp.user_id = v_me or v_runs) and v_active
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 -- 2085. api.declare_meeting_conflict for this participant: themself (SELF), or the meeting's runner
                 -- for an invitee without an account (SECRETARY, ADR-054 §5); then the checks of 2065's meeting-level
                 -- flags, which answer the caller's own row: the meeting active, a member's seat current
                 -- (SEAT_ENDED), a declaration required, none final yet (COI_ALREADY_DECLARED), no conflict a member
                 -- declared at an earlier meeting of the proceeding (PRIOR_CONFLICT_DECLARED), and
                 -- committee.refuse_excluded_participant on the update.
                 'may_declare_conflict', coalesce((mp.user_id = v_me or (mp.user_id is null and v_runs)) and v_active
                     and (mp.participant_kind <> 'MEMBER' or committee.member_seat_current(mp.id))
                     and mp.requires_coi and mp.coi_status <> 'CONFLICT_DECLARED'
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 'may_declare_no_conflict', coalesce((mp.user_id = v_me or (mp.user_id is null and v_runs)) and v_active
                     and (mp.participant_kind <> 'MEMBER' or committee.member_seat_current(mp.id))
                     and mp.requires_coi and mp.coi_status not in ('NO_CONFLICT', 'CONFLICT_DECLARED')
                     and not (mp.participant_kind = 'MEMBER' and exists (
                       select 1 from committee.meeting_participant prior
                       join committee.meeting pm on pm.id = prior.meeting_id
                       where pm.committee_proceeding_id = v_m.committee_proceeding_id and pm.id <> v_m.id
                         and prior.proceeding_member_id = mp.proceeding_member_id
                         and prior.coi_status = 'CONFLICT_DECLARED'
                         and committee.conflict_counts(prior.id)))
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 -- 2085. api.acknowledge_meeting_confidentiality for this participant: themself, or the meeting's
                 -- runner for an invitee without an account; the meeting active, an acknowledgement required
                 -- (ACK_NOT_REQUIRED) and not made (ALREADY_ACKNOWLEDGED), and committee.refuse_excluded_participant
                 -- on the insert.
                 'may_acknowledge_confidentiality', coalesce((mp.user_id = v_me or (mp.user_id is null and v_runs))
                     and v_active and mp.confidentiality_ack_required
                     and not exists (select 1 from committee.confidentiality_ack a where a.participant_id = mp.id)
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 -- 2085. api.activate_alternate_member with this alternate: at least one member in alternate_for.
                 'may_activate_alternate', jsonb_array_length(af.ids) > 0)
               else jsonb_build_object('may_record_present', false, 'may_record_absent', false,
                                       'may_record_excused_conflict', false, 'may_record_excused_absence', false,
                                       'may_raise_concern', false, 'may_exclude_witness', false,
                                       'may_record_accommodation', false, 'may_declare_conflict', false,
                                       'may_declare_no_conflict', false, 'may_acknowledge_confidentiality', false,
                                       'may_activate_alternate', false) end)
             order by mp.added_at, mp.id)
      from committee.meeting_participant mp
      left join iam.user_profile u on u.id = mp.user_id
      -- 2085. api.activate_alternate_member, for the runner: this row an alternate member (INVALID otherwise), not
      -- activated yet (ALTERNATE_ALREADY_ACTIVE), with no conflict (COI_NOT_CLEARED), a current seat and the case gate
      -- (ALTERNATE_INELIGIBLE), on a grievance never one who sat on the case's Investigation Committee
      -- (FIREWALL_RESTRICTED), and not the caller (meeting_acting_role: activated_by <> user_id). Each member it may
      -- replace: a voting MEMBER of the meeting (INVALID otherwise), not replaced yet (ALREADY_REPLACED), with the
      -- basis the command derives (MEMBER_AVAILABLE when none).
      cross join lateral (
        select case when v_alternates_open and mp.participant_kind = 'MEMBER' and mp.seat = 'ALTERNATE_MEMBER'
                         and not committee.is_activated_alternate(mp.id)
                         and mp.coi_status = 'NO_CONFLICT'
                         and committee.member_seat_current(mp.id) and authz.user_case_gate(mp.user_id, v_m.case_id)
                         and not (v_grievance
                                  and authz.participated_in_investigation_committee(mp.user_id, v_m.case_id))
                         and mp.user_id <> v_me
                    then coalesce((
                      select jsonb_agg(r.id order by r.added_at, r.id)
                      from committee.meeting_participant r
                      where r.meeting_id = v_m.id and r.participant_kind = 'MEMBER' and r.seat = 'MEMBER'
                        and r.is_voting and not committee.is_replaced_member(r.id)
                        and (r.coi_status = 'CONFLICT_DECLARED'
                             or not committee.member_seat_current(r.id)
                             or not authz.user_case_gate(r.user_id, v_m.case_id)
                             or r.attendance in ('ABSENT', 'EXCUSED'))), '[]'::jsonb)
                    else '[]'::jsonb end as ids) af
      where mp.meeting_id = v_m.id), '[]'::jsonb) end,
    'deliberation', case when v_delib then jsonb_build_object(
      'ballot_secrecy', case when v_secret then 'SECRET_BALLOT' else 'COMMITTEE_AFTER_CLOSE' end,
      'quorum', case when v_roster then jsonb_build_object(
        'quorum_type', v_q.quorum_type, 'eligible', v_q.eligible, 'present', v_q.present, 'required', v_q.required) end,
      'vote_items', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'vote_item_id', vi.id, 'sequence_no', vi.sequence_no, 'target_type', vi.target_type,
                 'finding_id', vi.finding_id, 'package_id', vi.package_id,
                 'recommendation_item_id', vi.recommendation_item_id, 'package_round', vi.package_round,
                 'title', vi.title, 'status', vi.status, 'result', vi.result,
                 'decided_by_casting_vote', vi.decided_by_casting_vote, 'opened_at', vi.opened_at,
                 'closed_at', vi.closed_at,
                 'tally', case when vi.tallied_at is not null then jsonb_build_object(
                   'eligible', vi.eligible_count, 'present', vi.present_count, 'quorum_required', vi.quorum_required,
                   'approve', vi.approve_count, 'reject', vi.reject_count, 'abstain', vi.abstain_count,
                   'recused', vi.recused_count, 'absent', vi.absent_count, 'unable', vi.unable_count,
                   'excluded', vi.excluded_count) end,
                 'i_have_voted', v_own.id is not null and exists (
                   select 1 from committee.vote v where v.vote_item_id = vi.id and v.participant_id = v_own.id),
                 -- 2065: the caller's own note on this item exists (never its text).
                 'i_have_noted', v_own.id is not null and exists (
                   select 1 from committee.vote_note n where n.vote_item_id = vi.id and n.participant_id = v_own.id),
                 -- 2065. api.record_vote_for_member, for the meeting's runner only (empty for anyone else): the members
                 -- for whom it would record ABSENT, UNABLE_TO_VOTE or RECUSED now. A counting seat that is not
                 -- replaced, never the runner themself, not present, no vote yet, the item OPEN, and
                 -- decision.refuse_excluded_vote on the vote's insert.
                 'record_vote_for', case when v_runs and v_m.status = 'OPEN' and vi.status = 'OPEN' then coalesce((
                     select jsonb_agg(mp.id order by mp.added_at, mp.id)
                     from committee.meeting_participant mp
                     where mp.meeting_id = v_m.id and mp.participant_kind = 'MEMBER'
                       and (mp.is_voting or committee.is_activated_alternate(mp.id))
                       and not committee.is_replaced_member(mp.id)
                       and mp.user_id is distinct from v_me
                       and mp.attendance <> 'PRESENT'
                       and not exists (select 1 from committee.vote v
                                       where v.vote_item_id = vi.id and v.participant_id = mp.id)
                       and not decision.revote_excluded(vi.package_id, vi.package_round, mp.user_id)
                       -- 2125 (ADR-062): never over a ballot nobody has released (BALLOT_HELD).
                       and not exists (select 1 from committee.offline_ballot b
                                       where b.vote_item_id = vi.id and b.participant_id = mp.id
                                         and b.status = 'PROVISIONAL' and b.released_at is null)), '[]'::jsonb)
                   else '[]'::jsonb end,
                 -- 2120 (ADR-048): the paper ballots bound to this item, counted by state (never a choice); the
                 -- caller's own ballot with its choice, for the caller only; and, for the meeting's runner only, the
                 -- counting members whose ballot still waits (api.close_vote_item: BALLOTS_UNCONFIRMED).
                 'offline_ballots', (select jsonb_build_object(
                     'provisional', count(*) filter (where b.status = 'PROVISIONAL'),
                     'confirmed', count(*) filter (where b.status = 'CONFIRMED'),
                     'superseded', count(*) filter (where b.status = 'SUPERSEDED'),
                     'lapsed', count(*) filter (where b.status = 'LAPSED'))
                   from committee.offline_ballot b where b.vote_item_id = vi.id),
                 'my_ballot', (select jsonb_build_object('ballot_id', b.id, 'status', b.status, 'choice', b.choice,
                                                         'ballot_reference', b.ballot_reference,
                                                         'original_event_at', b.original_event_at,
                                                         -- 2125: who released it, if anyone (MEMBER or CHAIR).
                                                         'release', b.release_kind)
                               from committee.offline_ballot b where b.vote_item_id = vi.id and b.user_id = v_me),
                 'ballots_unconfirmed_for', case when v_runs and v_m.status = 'OPEN' and vi.status = 'OPEN' then coalesce((
                     select jsonb_agg(b.participant_id order by mp.added_at, mp.id)
                     from committee.offline_ballot b join committee.meeting_participant mp on mp.id = b.participant_id
                     where b.vote_item_id = vi.id and committee.offline_ballot_blocks(b.id)), '[]'::jsonb)
                   else '[]'::jsonb end,
                 -- 2125. api.release_offline_ballot, for the meeting's chair only: the members not present (never the
                 -- chair) whose provisional ballot bound here nobody has released, where the ballot's workbook does
                 -- not exclude the chair (exchange.bcp_approver_excluded).
                 'ballots_releasable_for', case when v_ballot_chair and v_m.status = 'OPEN' and vi.status = 'OPEN' then coalesce((
                     select jsonb_agg(b.participant_id order by mp.added_at, mp.id)
                     from committee.offline_ballot b join committee.meeting_participant mp on mp.id = b.participant_id
                     where b.vote_item_id = vi.id and b.status = 'PROVISIONAL' and b.released_at is null
                       and mp.participant_kind = 'MEMBER' and mp.user_id is distinct from v_me
                       and mp.attendance <> 'PRESENT'
                       and not exchange.bcp_approver_excluded(b.batch_id, v_me)), '[]'::jsonb)
                   else '[]'::jsonb end,
                 'capabilities', jsonb_build_object(
                   -- api.cast_vote (committee.lock_vote_item: the meeting is OPEN); 2120 (F2): never in a meeting held
                   -- offline (OFFLINE_BALLOT_ONLY).
                   'may_vote', v_m.status = 'OPEN' and not v_m.held_offline
                               and v_own.id is not null and v_own.participant_kind = 'MEMBER'
                               and (v_own.is_voting or committee.is_activated_alternate(v_own.id))
                               and not committee.is_replaced_member(v_own.id)
                               and committee.member_seat_current(v_own.id)
                               and v_own.coi_status = 'NO_CONFLICT' and v_own.attendance = 'PRESENT'
                               and vi.status = 'OPEN'
                               -- DEC-AMB-013: never on a re-vote that excludes the caller (decision.refuse_excluded_vote).
                               and not decision.revote_excluded(vi.package_id, vi.package_round, v_me)
                               and not exists (select 1 from committee.vote v
                                               where v.vote_item_id = vi.id and v.participant_id = v_own.id),
                   -- api.close_vote_item: running the meeting, the item OPEN, no counting member present without a vote.
                   'may_close', v_m.status = 'OPEN' and v_runs and vi.status = 'OPEN'
                                and not exists (select 1 from committee.meeting_participant mp
                                                where mp.meeting_id = v_m.id and mp.coi_status = 'NO_CONFLICT'
                                                  and mp.attendance = 'PRESENT' and committee.counts_as_voter(mp.id)
                                                  and not decision.revote_excluded(vi.package_id, vi.package_round,
                                                                                   mp.user_id)
                                                  and not exists (select 1 from committee.vote v
                                                                  where v.vote_item_id = vi.id and v.participant_id = mp.id))
                                -- 2120: and no counting member's paper ballot still waiting (BALLOTS_UNCONFIRMED).
                                and not exists (select 1 from committee.offline_ballot b
                                                where b.vote_item_id = vi.id and committee.offline_ballot_blocks(b.id)),
                   -- api.cast_casting_vote: only the item's casting voter, on a tie the rule lets them break.
                   'may_cast_casting_vote', v_m.status = 'OPEN' and vi.status = 'AWAITING_CASTING_VOTE'
                                            and exists (select 1 from committee.meeting_participant c
                                                        where c.id = committee.casting_voter(vi.id) and c.user_id = v_me),
                   -- 2065. api.revise_vote: api.cast_vote's checks up to the item being OPEN, then the rule snapshot
                   -- allows a revision (AMB-081) and the caller has their own vote on the item.
                   -- 2120 (F2): never in a meeting held offline (OFFLINE_BALLOT_ONLY).
                   'may_revise', coalesce(v_m.status = 'OPEN' and not v_m.held_offline
                                          and v_own.id is not null and v_own.participant_kind = 'MEMBER'
                                          and (v_own.is_voting or committee.is_activated_alternate(v_own.id))
                                          and not committee.is_replaced_member(v_own.id)
                                          and committee.member_seat_current(v_own.id)
                                          and v_own.coi_status = 'NO_CONFLICT' and v_own.attendance = 'PRESENT'
                                          and vi.status = 'OPEN'
                                          and coalesce((v_cp.rule_snapshot ->> 'vote_revision_allowed')::boolean, false)
                                          and exists (select 1 from committee.vote v
                                                      where v.vote_item_id = vi.id and v.participant_id = v_own.id
                                                        and v.source = 'SELF'), false),
                   -- api.recuse_for_conflict (AMB-077): a counting seat, no conflict, present, the item OPEN, no vote
                   -- yet, and decision.refuse_excluded_vote on the vote's insert (DEC-AMB-013).
                   'may_recuse_for_conflict', coalesce(v_m.status = 'OPEN' and v_own.id is not null
                                          and v_own.participant_kind = 'MEMBER'
                                          and (v_own.is_voting or committee.is_activated_alternate(v_own.id))
                                          and v_own.coi_status = 'NO_CONFLICT' and v_own.attendance = 'PRESENT'
                                          and vi.status = 'OPEN'
                                          and not exists (select 1 from committee.vote v
                                                          where v.vote_item_id = vi.id and v.participant_id = v_own.id)
                                          and not decision.revote_excluded(vi.package_id, vi.package_round, v_me), false),
                   -- api.record_vote_note (AMB-082): the meeting OPEN (committee.lock_vote_item), the caller's own
                   -- vote on the item, the rule snapshot allows a note, and none recorded yet.
                   'may_record_note', coalesce(v_m.status = 'OPEN' and v_own.id is not null
                                          and v_own.participant_kind = 'MEMBER'
                                          and exists (select 1 from committee.vote v
                                                      where v.vote_item_id = vi.id and v.participant_id = v_own.id
                                                        and v.source = 'SELF')
                                          and coalesce((v_cp.rule_snapshot ->> 'dissent_note_allowed')::boolean, false)
                                          and not exists (select 1 from committee.vote_note n
                                                          where n.vote_item_id = vi.id and n.participant_id = v_own.id),
                                          false),
                   -- 2120. api.confirm_offline_ballot: api.cast_vote's checks up to the item being OPEN, no vote yet,
                   -- the caller's own provisional ballot bound to this item, and decision.refuse_excluded_vote on the
                   -- vote's insert (a ballot is never bound for a member a re-vote excludes).
                   'may_confirm_ballot', coalesce(v_m.status = 'OPEN' and v_own.id is not null
                                          and v_own.participant_kind = 'MEMBER'
                                          and (v_own.is_voting or committee.is_activated_alternate(v_own.id))
                                          and not committee.is_replaced_member(v_own.id)
                                          and committee.member_seat_current(v_own.id)
                                          and v_own.coi_status = 'NO_CONFLICT' and v_own.attendance = 'PRESENT'
                                          and vi.status = 'OPEN'
                                          and not exists (select 1 from committee.vote v
                                                          where v.vote_item_id = vi.id and v.participant_id = v_own.id)
                                          and exists (select 1 from committee.offline_ballot b
                                                      where b.vote_item_id = vi.id and b.participant_id = v_own.id
                                                        and b.user_id = v_me and b.status = 'PROVISIONAL')
                                          and not decision.revote_excluded(vi.package_id, vi.package_round, v_me),
                                          false),
                   -- 2125. api.decline_offline_ballot: the caller's own counting seat (not replaced, still seated),
                   -- the item OPEN, and their own provisional ballot bound to it that nobody has released.
                   'may_decline_ballot', coalesce(v_m.status = 'OPEN' and v_own.id is not null
                                          and v_own.participant_kind = 'MEMBER'
                                          and (v_own.is_voting or committee.is_activated_alternate(v_own.id))
                                          and not committee.is_replaced_member(v_own.id)
                                          and committee.member_seat_current(v_own.id)
                                          and vi.status = 'OPEN'
                                          and exists (select 1 from committee.offline_ballot b
                                                      where b.vote_item_id = vi.id and b.participant_id = v_own.id
                                                        and b.user_id = v_me and b.status = 'PROVISIONAL'
                                                        and b.released_at is null),
                                          false)))
               order by vi.sequence_no)
        from committee.vote_item vi where vi.meeting_id = v_m.id), '[]'::jsonb),
      'witness_exclusions', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'exclusion_id', x.id, 'participant_id', x.participant_id, 'reason', x.reason,
                 'excluded_by', x.excluded_by, 'excluded_at', x.excluded_at) order by x.excluded_at, x.id)
        from committee.witness_exclusion x where x.meeting_id = v_m.id), '[]'::jsonb)) end,
    'concerns', v_concerns,
    'acting_roles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'acting_role_id', a.id, 'acting_role', a.acting_role, 'user_id', a.user_id,
               'participant_id', a.participant_id, 'replaces_participant_id', a.replaces_participant_id,
               'basis', a.basis, 'activated_as', a.activated_as, 'activated_at', a.activated_at)
             order by a.activated_at, a.id)
      from committee.meeting_acting_role a
      where a.meeting_id = v_m.id and (v_delib or a.user_id = v_me)), '[]'::jsonb),
    'minutes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'minutes_id', mi.id, 'version_no', mi.version_no, 'status', mi.status,
               'generated_at', mi.generated_at, 'finalised_at', mi.finalised_at) order by mi.version_no)
      from committee.minutes mi
      where mi.meeting_id = v_m.id
        and (v_delib or (mi.status in ('APPROVED', 'DEEMED_APPROVED') and authz.can_view_case(mi.case_id)))), '[]'::jsonb),
    -- 2085: the roles api.invite_to_meeting accepts now, for whoever may invite; empty for anyone else.
    'invitee_roles', case when v_may_invite then coalesce((
      select jsonb_agg(jsonb_build_object('invitee_role', r.invitee_role,
                                          'confidentiality_ack_required', r.confidentiality_ack_required,
                                          'source_status', r.source_status)
             order by array_position(array['WITNESS', 'EXPERT', 'LEGAL', 'INFORMATION_PROVIDER', 'SUBJECT',
                                           'INTERPRETER'], r.invitee_role))
      from committee.invitee_type_rule r where r.enabled), '[]'::jsonb) else '[]'::jsonb end,
    'capabilities', jsonb_build_object(
      'can_manage', v_manage,
      -- api.open_meeting, api.close_meeting, api.cancel_meeting.
      'may_open', v_manage and v_m.status = 'SCHEDULED'
                  and coalesce(v_proceeding_status not in ('CONCLUDED', 'CANCELLED', 'SUSPENDED'), false),
      'may_close', v_manage and v_m.status = 'OPEN' and not v_items_undecided,
      'may_cancel', v_manage and v_m.status = 'SCHEDULED',
      -- api.open_vote_item with its triggers: no open concern about an undeclared participant, quorum now.
      'may_open_vote', v_manage and v_m.status = 'OPEN'
                       and not exists (select 1 from committee.meeting_conflict_concern c
                                       join committee.meeting_participant mp on mp.id = c.participant_id
                                       where c.meeting_id = v_m.id and c.status = 'OPEN'
                                         and mp.coi_status <> 'CONFLICT_DECLARED')
                       and v_q.eligible > 0 and v_q.present > 0 and (v_q.required is null or v_q.present >= v_q.required),
      -- api.generate_minutes: closed, and no current version unless changes were requested.
      'may_generate_minutes', v_manage and v_m.status = 'CLOSED'
                              and coalesce(v_current_minutes = 'CHANGES_REQUESTED', true),
      -- api.raise_meeting_conflict, as far as the actor and the meeting go; the participant's own checks (not oneself,
      -- a declaration required and not yet made, no concern already open) are the command's to answer.
      'may_raise_concern', coalesce((v_runs
                                     or (v_own.id is not null and v_own.participant_kind = 'MEMBER'
                                         and v_own.coi_status = 'NO_CONFLICT'
                                         and authz.user_case_gate(v_me, v_m.case_id)))
                                    and v_case_active and v_active and not v_items_undecided, false),
      -- api.declare_meeting_conflict on the caller's own row. 2065 adds two of the command's checks that 2030's flags
      -- left out: a member's seat must be current (CONFLICT:SEAT_ENDED, added to the command by 2050 for CDF-212),
      -- and the participant's update is refused for an excluded witness (committee.refuse_excluded_participant,
      -- 2010), who may still see the meeting through the case.
      'may_declare_conflict', coalesce(v_own.id is not null and v_active
                              and (v_own.participant_kind <> 'MEMBER' or committee.member_seat_current(v_own.id))
                              and v_own.requires_coi
                              and v_own.coi_status <> 'CONFLICT_DECLARED'
                              and not exists (select 1 from committee.witness_exclusion x
                                              where x.participant_id = v_own.id), false),
      'may_declare_no_conflict', coalesce(v_own.id is not null and v_active
                                 and (v_own.participant_kind <> 'MEMBER' or committee.member_seat_current(v_own.id))
                                 and v_own.requires_coi
                                 and v_own.coi_status not in ('NO_CONFLICT', 'CONFLICT_DECLARED')
                                 and not (v_own.participant_kind = 'MEMBER' and exists (
                                   select 1 from committee.meeting_participant prior
                                   join committee.meeting pm on pm.id = prior.meeting_id
                                   where pm.committee_proceeding_id = v_m.committee_proceeding_id and pm.id <> v_m.id
                                     and prior.proceeding_member_id = v_own.proceeding_member_id
                                     and prior.coi_status = 'CONFLICT_DECLARED'
                                     and committee.conflict_counts(prior.id)))
                                 and not exists (select 1 from committee.witness_exclusion x
                                                 where x.participant_id = v_own.id), false),
      -- api.acknowledge_meeting_confidentiality on the caller's own row. 2065 adds the trigger that refuses the
      -- acknowledgement of an excluded witness (committee.refuse_excluded_participant, 2030).
      'may_acknowledge_confidentiality', coalesce(v_own.id is not null and v_active
                                         and v_own.confidentiality_ack_required and not v_acknowledged
                                         and not exists (select 1 from committee.witness_exclusion x
                                                         where x.participant_id = v_own.id), false),
      -- 2085 (computed above): api.invite_to_meeting, api.activate_acting_chair, api.activate_acting_secretary.
      'may_invite', v_may_invite,
      -- 2085. api.record_meeting_accommodation on the caller's own row (SELF), as 2065's flags above answer the
      -- declaration and the acknowledgement: for an invitee, who sees no roster row to carry it.
      'may_record_accommodation', coalesce(v_own.id is not null and v_active
                                           and not exists (select 1 from committee.witness_exclusion x
                                                           where x.participant_id = v_own.id), false),
      'may_activate_acting_chair', coalesce(v_deputy.id is not null and v_deputy.user_id <> v_me, false),
      'may_activate_acting_secretary', v_may_acting_secretary));
end;
$$;

-- Replaces 2120: as built, plus my_ballot.release.
create or replace function api.vote_item_status(p_vote_item_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_item committee.vote_item;
  v_closed boolean;
  v_secret boolean;
begin
  select * into v_item from committee.vote_item vi where vi.id = p_vote_item_id;
  if v_item.id is null or not authz.can_view_meeting_deliberation(v_item.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_closed := v_item.status = 'CLOSED';
  select coalesce(cp.rule_snapshot ->> 'ballot_secrecy', 'COMMITTEE_AFTER_CLOSE') = 'SECRET_BALLOT' into v_secret
  from committee.meeting m join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
  where m.id = v_item.meeting_id;
  return jsonb_build_object(
    'vote_item_id', v_item.id, 'status', v_item.status, 'result', v_item.result,
    'decided_by_casting_vote', v_item.decided_by_casting_vote,
    -- 2120 (ADR-048): the paper ballots bound to this item, counted by state (never a choice), and the caller's own
    -- ballot with its choice, for the caller only.
    'offline_ballots', (select jsonb_build_object(
        'provisional', count(*) filter (where b.status = 'PROVISIONAL'),
        'confirmed', count(*) filter (where b.status = 'CONFIRMED'),
        'superseded', count(*) filter (where b.status = 'SUPERSEDED'),
        'lapsed', count(*) filter (where b.status = 'LAPSED'))
      from committee.offline_ballot b where b.vote_item_id = v_item.id),
    'my_ballot', (select jsonb_build_object('ballot_id', b.id, 'status', b.status, 'choice', b.choice,
                                            'ballot_reference', b.ballot_reference,
                                            'original_event_at', b.original_event_at,
                                            -- 2125: who released it, if anyone (MEMBER or CHAIR).
                                            'release', b.release_kind)
                  from committee.offline_ballot b
                  where b.vote_item_id = v_item.id and b.user_id = authz.current_user_id()),
    'ballot_secrecy', case when v_secret then 'SECRET_BALLOT' else 'COMMITTEE_AFTER_CLOSE' end,
    'casting_vote', case when v_closed then (select cv.choice from committee.casting_vote cv where cv.vote_item_id = v_item.id) end,
    'tally', case when v_item.tallied_at is not null then jsonb_build_object(
      'eligible', v_item.eligible_count, 'present', v_item.present_count, 'quorum_required', v_item.quorum_required,
      'approve', v_item.approve_count, 'reject', v_item.reject_count, 'abstain', v_item.abstain_count,
      'recused', v_item.recused_count, 'absent', v_item.absent_count, 'unable', v_item.unable_count,
      'excluded', v_item.excluded_count) end,
    'voters', coalesce((
      select jsonb_agg(jsonb_build_object(
               'participant_id', mp.id, 'user_id', mp.user_id, 'seat', mp.seat,
               'activated_alternate', committee.is_activated_alternate(mp.id),
               'replaced', committee.is_replaced_member(mp.id),
               'has_voted', v.id is not null, 'voted_at', v.recorded_at, 'source', v.source,
               'choice', case when v_closed and not v_secret then committee.vote_choice(v.id) end) order by mp.added_at, mp.id)
      from committee.meeting_participant mp
      left join committee.vote v on v.participant_id = mp.id and v.vote_item_id = v_item.id
      where mp.meeting_id = v_item.meeting_id and mp.participant_kind = 'MEMBER'
        and (mp.is_voting or committee.is_activated_alternate(mp.id))), '[]'::jsonb),
    'notes', case when v_closed then coalesce((
      select jsonb_agg(jsonb_build_object('participant_id', case when not v_secret then n.participant_id end,
                                          'note', n.note) order by n.recorded_at, n.id)
      from committee.vote_note n where n.vote_item_id = v_item.id), '[]'::jsonb) end);
end;
$$;

-- =============================================================================
-- 5. Grants and the catalogue
-- =============================================================================
-- The replaced functions keep their owners, grants and comments.
revoke all on function api.decline_offline_ballot(uuid), api.release_offline_ballot(uuid, uuid, text) from public;
grant execute on function api.decline_offline_ballot(uuid), api.release_offline_ballot(uuid, uuid, text)
to authenticated;

update config.target_module
   set commands = commands || array['api.decline_offline_ballot', 'api.release_offline_ballot'],
       delivered_in = delivered_in || '2125'::text,
       notes = notes || ' Since 2125: the secretary''s N6 record never supersedes a paper ballot until its member '
                        'declines it or the meeting''s chair releases it with a reason (ADR-062).'
 where code = 'MEETING';
