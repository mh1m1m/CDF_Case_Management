-- =============================================================================
-- 2065 The meeting screen's capabilities (UX redesign Phase 12, slice P12-2a; ADR-054)
-- Requirements: Phase 12 plan §2 (rules 1, 5 and 6) and §4 (P12-2); DEC-02 and ADR-016 D2 (purpose routes, never the
-- full case); UX-116 (a screen offers an action from server capabilities, never from a page mirror); AMB-077 (recusal
-- for a conflict), AMB-081 (revising a vote), AMB-082 (a note on one's own vote); DEC-AMB-013 (a re-vote excludes the
-- conflicted member); T-AMB-037; CDF-212. Linear CDF-158. Number allocated by the coordinator (2047 at first, 2055
-- after migration 2050, 2065 after 2060), with the conditions of 2026-10-14 11:50, 11:53, 11:55 and 12:44 (below).
--
-- Before: api.meeting_view (2030 section 4) answered whether the caller may open, close or cancel the meeting, open
-- or close a vote, cast a vote or the deciding vote, raise or decide a concern, declare a conflict, acknowledge
-- confidentiality and generate the minutes. It said nothing about recording attendance, so the screen could never
-- bring a member to PRESENT, and with nobody present no vote can open. Nor did it say whether a member may change
-- their vote, recuse for a conflict or note their vote, or whether the secretary may excuse a participant, raise a
-- concern about one, or record a vote for an absent member.
--
-- After: api.meeting_view is replaced with the same signature, grant and owner. Every key it returned before is
-- returned to the same callers, with the same values apart from three flags that only narrow (the last point below).
-- It gains:
--   * on each roster row, capabilities: may_record_present, may_record_absent and may_record_excused_conflict
--     (api.record_attendance with that value), may_record_excused_absence (api.record_excused_absence) and
--     may_raise_concern (api.raise_meeting_conflict about that participant). They are computed only for the meeting's
--     runner (authz.can_manage_meeting), on any row, and on the caller's own row, where they answer for the commands
--     a participant runs on themself (none of these: the attendance and excuse commands are the runner's, and nobody
--     raises a concern about themself). On anyone else's row a non-runner gets false for each, so no flag tells one
--     participant about another's conflict, clearance or excusal (coordinator, 11:55). A member still raises a
--     concern from the meeting-level may_raise_concern, as before, and the command answers for the participant.
--   * on each vote item, i_have_noted (the caller's own note exists, never its text); record_vote_for, the members
--     for whom the runner may record ABSENT, UNABLE_TO_VOTE or RECUSED now (api.record_vote_for_member), empty for
--     anyone else; and three capabilities: may_revise (api.revise_vote), may_recuse_for_conflict
--     (api.recuse_for_conflict) and may_record_note (api.record_vote_note).
--   * The meeting-level may_declare_conflict, may_declare_no_conflict and may_acknowledge_confidentiality gain the
--     checks of their commands that 2030 left out. A member whose seat has ended declares nothing
--     (CONFLICT:SEAT_ENDED, which 2050 added to api.declare_meeting_conflict for CDF-212; coordinator, 12:44). An
--     excluded witness who still sees the meeting through the case neither declares nor acknowledges
--     (committee.refuse_excluded_participant, 2010 and 2030). These only ever turn true into false.
--
-- How each capability is computed (coordinator, 11:53): with the authz and committee helpers its command calls, in
-- the command's order, including the triggers that refuse the command's writes (committee.refuse_excluded_participant,
-- 2010; decision.refuse_excluded_vote, DEC-AMB-013), without taking a lock and without writing, so a page view adds
-- nothing to the audit ledger. Input checks (a reason's length, a choice's value) are the command's to answer. The
-- security tests run the real command for each case and assert that the capability equals its answer.
--
-- Controls:
--   * One function replaced. No table, policy, grant or command changes, so the policy snapshot is unchanged.
--   * Still SECURITY DEFINER with search_path '', stable, granted to authenticated only (the 2030 grant stands).
--   * A capability never widens a command: the command checks again on submit.
--   * Apart from the new keys and the three narrowed flags, the view is 2030's: the tests run both side by side.
--   * Every capabilities object holds booleans only, never null: false for whoever may not use the command (AGENT-09).
--     record_vote_for is a list, empty for anyone but the runner.
-- =============================================================================

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

  return jsonb_build_object(
    'meeting_id', v_m.id,
    'committee_proceeding_id', v_m.committee_proceeding_id,
    'committee', jsonb_build_object('committee_id', v_committee.id, 'code', v_committee.code, 'kind', v_committee.kind),
    'case', v_case,
    'logistics', jsonb_build_object(
      'sequence_no', v_m.sequence_no, 'purpose', v_m.purpose, 'mode', v_m.mode, 'provider', v_m.provider,
      'status', v_m.status, 'location', v_m.location, 'online_url', v_m.online_url,
      'scheduled_start', v_m.scheduled_start, 'scheduled_end', v_m.scheduled_end, 'is_emergency', v_m.is_emergency,
      'opened_at', v_m.opened_at, 'closed_at', v_m.closed_at),
    'me', case when v_own.id is not null then jsonb_build_object(
      'participant_id', v_own.id, 'participant_kind', v_own.participant_kind, 'seat', v_own.seat,
      'invitee_role', v_own.invitee_role, 'is_voting', v_own.is_voting, 'requires_coi', v_own.requires_coi,
      'coi_status', v_own.coi_status, 'attendance', v_own.attendance,
      'confidentiality_ack_required', v_own.confidentiality_ack_required,
      'confidentiality_acknowledged', v_acknowledged) end,
    'roster', case when v_roster then coalesce((
      select jsonb_agg(jsonb_build_object(
               'participant_id', mp.id, 'participant_kind', mp.participant_kind, 'user_id', mp.user_id,
               'person_id', mp.person_id, 'display_name', u.display_name, 'display_name_ar', u.display_name_ar,
               'seat', mp.seat, 'invitee_role', mp.invitee_role, 'is_voting', mp.is_voting,
               'requires_coi', mp.requires_coi, 'coi_status', mp.coi_status, 'attendance', mp.attendance,
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
                          or exists (select 1 from committee.confidentiality_ack a where a.participant_id = mp.id)),
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
                     false))
               else jsonb_build_object('may_record_present', false, 'may_record_absent', false,
                                       'may_record_excused_conflict', false, 'may_record_excused_absence', false,
                                       'may_raise_concern', false) end)
             order by mp.added_at, mp.id)
      from committee.meeting_participant mp
      left join iam.user_profile u on u.id = mp.user_id
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
                       and not decision.revote_excluded(vi.package_id, vi.package_round, mp.user_id)), '[]'::jsonb)
                   else '[]'::jsonb end,
                 'capabilities', jsonb_build_object(
                   -- api.cast_vote (committee.lock_vote_item: the meeting is OPEN).
                   'may_vote', v_m.status = 'OPEN' and v_own.id is not null and v_own.participant_kind = 'MEMBER'
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
                                                                  where v.vote_item_id = vi.id and v.participant_id = mp.id)),
                   -- api.cast_casting_vote: only the item's casting voter, on a tie the rule lets them break.
                   'may_cast_casting_vote', v_m.status = 'OPEN' and vi.status = 'AWAITING_CASTING_VOTE'
                                            and exists (select 1 from committee.meeting_participant c
                                                        where c.id = committee.casting_voter(vi.id) and c.user_id = v_me),
                   -- 2065. api.revise_vote: api.cast_vote's checks up to the item being OPEN, then the rule snapshot
                   -- allows a revision (AMB-081) and the caller has their own vote on the item.
                   'may_revise', coalesce(v_m.status = 'OPEN' and v_own.id is not null and v_own.participant_kind = 'MEMBER'
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
                                                         where x.participant_id = v_own.id), false)));
end;
$$;
comment on function api.meeting_view(uuid) is
  'Purpose read model of one meeting (migration 2030 section 4, DEC-02; capabilities added in 2065, ADR-054): each '
  'part under the predicate of its table, capabilities from the checks of the matching commands. No individual choice, '
  'no case content. Under authz.can_view_meeting the full view; otherwise, to a caller who may see one of its concerns, '
  'the concern-only view (meeting id and status, case under its metadata predicate, those concerns); otherwise '
  'NOT_FOUND. A roster row''s capabilities are computed for the meeting''s runner, or on the caller''s own row; '
  'elsewhere they are false. record_vote_for is empty for anyone but the runner.';
