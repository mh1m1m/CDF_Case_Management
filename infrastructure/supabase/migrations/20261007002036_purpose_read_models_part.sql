-- =============================================================================
-- 2036 Owner Finalization Set, part 1, section 4: purpose read models for a meeting and its minutes, and two
-- content-free meeting notifications (Business Architecture Rebase; CDF-196 programme; Phase 12 asks §6 (b) and (c))
-- Requirements: §19, §21, §39, §40, §82, §87; owner decisions DEC-02, DEC-F01, DEC-F04, DEC-F07; AMB-083; ADR-020,
-- ADR-025, ADR-039, ADR-040
--
-- Section 4 of migration 2030 (sections 1 and 2 are in 20261007002030; section 3, packages, legal review and
-- authority decisions, is written beside it). It changes no command and no predicate.
--
-- Section 4, purpose read models. The meeting and minutes screens are reached by participants, deciders and reviewers
-- who are not on the case team (DEC-02: COMMITTEE, REVIEW and TRIAGE access is never full-case). The BFF must not read
-- the committee tables part by part, nor call the full-case read, to draw them. Two reads answer one object each:
--   * api.meeting_view(meeting): the full view under authz.can_view_meeting. A caller who fails it but may see at
--     least one concern of the meeting (authz.can_view_meeting_concern: the committee's conflict authority, or a
--     seated deputy who may reverse, neither of whom is in the meeting) gets the concern-only view: the meeting's id
--     and status, the case under authz.can_view_case_metadata, and exactly those concerns with may_decide and
--     may_reverse. That widens nothing: each concern row already carries its meeting_id and is readable by exactly
--     those users. Everyone else gets NOT_FOUND (an excluded witness included, DEC-F07), the same error as a meeting
--     that does not exist. In the full view each part follows the predicate of the table it comes from, evaluated for
--     the caller:
--       logistics          authz.can_view_meeting (meeting_read): status, purpose, mode, provider, times, location,
--                          online link. Never the emergency reason.
--       me                 the caller's own participant row (meeting_participant_read, own branch) and their own
--                          confidentiality acknowledgement (confidentiality_ack_read, own branch).
--       roster             authz.can_view_meeting_roster (meeting_participant_read), with directory names for users;
--                          a case person invitee appears by id only.
--       deliberation       authz.can_view_meeting_deliberation (vote_item_read, witness_exclusion_read): ballot
--                          secrecy, quorum now (also needs the roster), vote items with status, result and the tally
--                          after close; never an individual choice or vote note (api.vote_item_status stays the one
--                          read of who has voted, and of choices where the rule allows them).
--       concerns           only rows passing authz.can_view_meeting_concern (never the subject), with their reversal.
--       acting_roles       meeting_acting_role_read: deliberation, or the caller's own row. Never the reason.
--       minutes            pointers to the versions passing minutes_read.
--       case               case_id and case_number only under authz.can_view_case_metadata (as in 1820); nothing
--                          else from the case record.
--   * api.minutes_view(minutes): NOT_FOUND unless the minutes_read predicate holds (deliberation of the meeting, or
--     approved minutes and the case team). Reviews and objection rulings follow minutes_review_read and
--     minutes_objection_ruling_read (deliberation); the meeting's logistics only under authz.can_view_meeting.
--   * Each carries a capabilities object of booleans, each computed from the checks of the command it stands for, in
--     the command's order, so the screen offers what the command will accept. A capability never widens a command:
--     the command still decides. Reads, as api.vote_item_status: no audit event.
-- Notifications (ADR-025, 1920 conventions). Ids only, deep link /meetings/<id>:
--   * MEETING_CONFLICT_DECISION_REQUESTED, when a conflict is raised: to whoever authz.meeting_concern_decider_seat
--     names for the concern (DEC-F04: the chair, the deputy chair, the committee's independent conflict authority, or
--     the secretary under the SECRETARY rule). The predicate is evaluated for each candidate as that candidate, so the
--     notice follows the decision rule itself. Never the raiser or the subject.
--   * MEETING_VOTE_OPENED, when a vote item opens: to the members who may cast on it now (api.cast_vote's checks: a
--     counting seat, present, no conflict, no vote yet).
--   Every recipient passes authz.user_case_gate and has no meeting conflict in the proceeding. The deep link reaches
--   a conflict authority through the concern-only view. Both are mandatory, as
--   MEETING_INVITATION and the minutes review notices are (they ask the recipient to act).
--
-- Controls:
--   * Additive and non-destructive: two read functions, two templates with their mandatory rules, two triggers and
--     an internal helper. No table, command or predicate changes; nothing is dropped, renamed or deleted.
--   * The reads are SECURITY DEFINER with search_path '' and evaluate the same authz predicates the RLS policies use;
--     the helper and the triggers are granted to no application role.
-- =============================================================================

-- =============================================================================
-- Section 4. Purpose read models and meeting notifications
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 4.1 The meeting, as its caller may see it
-- -----------------------------------------------------------------------------
create function api.meeting_view(p_meeting_id uuid)
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
               'requires_coi', mp.requires_coi, 'coi_status', mp.coi_status, 'attendance', mp.attendance)
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
                 'capabilities', jsonb_build_object(
                   -- api.cast_vote (committee.lock_vote_item: the meeting is OPEN).
                   'may_vote', v_m.status = 'OPEN' and v_own.id is not null and v_own.participant_kind = 'MEMBER'
                               and (v_own.is_voting or committee.is_activated_alternate(v_own.id))
                               and not committee.is_replaced_member(v_own.id)
                               and committee.member_seat_current(v_own.id)
                               and v_own.coi_status = 'NO_CONFLICT' and v_own.attendance = 'PRESENT'
                               and vi.status = 'OPEN'
                               and not exists (select 1 from committee.vote v
                                               where v.vote_item_id = vi.id and v.participant_id = v_own.id),
                   -- api.close_vote_item: running the meeting, the item OPEN, no counting member present without a vote.
                   'may_close', v_m.status = 'OPEN' and v_runs and vi.status = 'OPEN'
                                and not exists (select 1 from committee.meeting_participant mp
                                                where mp.meeting_id = v_m.id and mp.coi_status = 'NO_CONFLICT'
                                                  and mp.attendance = 'PRESENT' and committee.counts_as_voter(mp.id)
                                                  and not exists (select 1 from committee.vote v
                                                                  where v.vote_item_id = vi.id and v.participant_id = mp.id)),
                   -- api.cast_casting_vote: only the item's casting voter, on a tie the rule lets them break.
                   'may_cast_casting_vote', v_m.status = 'OPEN' and vi.status = 'AWAITING_CASTING_VOTE'
                                            and exists (select 1 from committee.meeting_participant c
                                                        where c.id = committee.casting_voter(vi.id) and c.user_id = v_me)))
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
      -- api.declare_meeting_conflict on the caller's own row.
      'may_declare_conflict', v_own.id is not null and v_active and v_own.requires_coi
                              and v_own.coi_status <> 'CONFLICT_DECLARED',
      'may_declare_no_conflict', v_own.id is not null and v_active and v_own.requires_coi
                                 and v_own.coi_status not in ('NO_CONFLICT', 'CONFLICT_DECLARED')
                                 and not (v_own.participant_kind = 'MEMBER' and exists (
                                   select 1 from committee.meeting_participant prior
                                   join committee.meeting pm on pm.id = prior.meeting_id
                                   where pm.committee_proceeding_id = v_m.committee_proceeding_id and pm.id <> v_m.id
                                     and prior.proceeding_member_id = v_own.proceeding_member_id
                                     and prior.coi_status = 'CONFLICT_DECLARED'
                                     and committee.conflict_counts(prior.id))),
      -- api.acknowledge_meeting_confidentiality on the caller's own row.
      'may_acknowledge_confidentiality', v_own.id is not null and v_active and v_own.confidentiality_ack_required
                                         and not v_acknowledged));
end;
$$;
comment on function api.meeting_view(uuid) is
  'Purpose read model of one meeting (migration 2030 section 4, DEC-02): each part under the predicate of its table, '
  'capabilities from the checks of the matching commands. No individual choice, no case content. Under '
  'authz.can_view_meeting the full view; otherwise, to a caller who may see one of its concerns, the concern-only view '
  '(meeting id and status, case under its metadata predicate, those concerns); otherwise NOT_FOUND.';

-- -----------------------------------------------------------------------------
-- 4.2 Minutes, as their caller may see them
-- -----------------------------------------------------------------------------
create function api.minutes_view(p_minutes_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_me uuid := authz.current_user_id();
  v_mi committee.minutes;
  v_m committee.meeting;
  v_delib boolean;
  v_runs boolean;
  v_blocks boolean;
  v_reviewed boolean;
  v_objected boolean;
begin
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id;
  if v_mi.id is null then perform api._fail('NOT_FOUND'); end if;
  v_delib := authz.can_view_meeting_deliberation(v_mi.meeting_id);
  -- minutes_read: the meeting's deliberation, or approved minutes and the case team.
  if not (v_delib or (v_mi.status in ('APPROVED', 'DEEMED_APPROVED') and authz.can_view_case(v_mi.case_id))) then
    perform api._fail('NOT_FOUND');
  end if;
  select * into v_m from committee.meeting m where m.id = v_mi.meeting_id;
  v_runs := authz.can_manage_meeting(v_m.id);
  select coalesce((cp.rule_snapshot ->> 'minutes_objection_blocks_deemed')::boolean, true) into v_blocks
  from committee.committee_proceeding cp where cp.id = v_m.committee_proceeding_id;
  v_reviewed := exists (select 1 from committee.minutes_review r where r.minutes_id = v_mi.id and r.reviewer_id = v_me);
  v_objected := exists (select 1 from committee.minutes_review r
                        where r.minutes_id = v_mi.id and r.reviewer_id = v_me and r.decision = 'REQUEST_CHANGES');

  return jsonb_build_object(
    'minutes_id', v_mi.id, 'meeting_id', v_mi.meeting_id, 'version_no', v_mi.version_no, 'status', v_mi.status,
    'narrative', v_mi.narrative, 'snapshot', v_mi.snapshot, 'reviewer_count', v_mi.reviewer_count,
    'review_business_days', v_mi.review_business_days, 'review_due_at', v_mi.review_due_at,
    'deemed_approval_enabled', v_mi.deemed_approval_enabled, 'reminder_sent_at', v_mi.reminder_sent_at,
    'generated_at', v_mi.generated_at, 'finalised_at', v_mi.finalised_at,
    'case', jsonb_build_object(
      'case_id', case when authz.can_view_case_metadata(v_mi.case_id) then v_mi.case_id end,
      'case_number', case when authz.can_view_case_metadata(v_mi.case_id)
                          then (select c.case_number from case_mgmt.case_record c where c.id = v_mi.case_id) end),
    'meeting', case when authz.can_view_meeting(v_m.id) then jsonb_build_object(
      'meeting_id', v_m.id, 'sequence_no', v_m.sequence_no, 'purpose', v_m.purpose, 'mode', v_m.mode,
      'status', v_m.status, 'scheduled_start', v_m.scheduled_start, 'scheduled_end', v_m.scheduled_end,
      'opened_at', v_m.opened_at, 'closed_at', v_m.closed_at) end,
    -- minutes_review_read and minutes_objection_ruling_read: the meeting's deliberation.
    'reviews', case when v_delib then coalesce((
      select jsonb_agg(jsonb_build_object('reviewer_id', r.reviewer_id, 'decision', r.decision, 'comment', r.comment,
                                          'reviewed_at', r.reviewed_at) order by r.reviewed_at, r.id)
      from committee.minutes_review r where r.minutes_id = v_mi.id), '[]'::jsonb) end,
    'objection_rulings', case when v_delib then coalesce((
      select jsonb_agg(jsonb_build_object('ruling_id', o.id, 'ruled_by', o.ruled_by, 'ruled_as', o.ruled_as,
                                          'reason', o.reason, 'ruled_at', o.ruled_at) order by o.ruled_at, o.id)
      from committee.minutes_objection_ruling o where o.minutes_id = v_mi.id), '[]'::jsonb) end,
    'i_have_reviewed', case when v_delib then v_reviewed end,
    'capabilities', jsonb_build_object(
      -- api.review_minutes.
      'may_review', coalesce(v_delib and committee.minutes_reviewer(v_mi.meeting_id, v_me)
                             and authz.user_case_gate(v_me, v_mi.case_id) and v_mi.status = 'IN_REVIEW'
                             and not v_reviewed, false),
      -- api.record_minutes_reminder.
      'may_remind', v_delib and v_runs and v_mi.status = 'IN_REVIEW' and v_mi.reminder_sent_at is null,
      -- api.apply_minutes_deemed_approval (false once final: the command then only repeats the status).
      'may_apply_deemed_approval', coalesce(v_delib and v_runs and v_mi.status in ('IN_REVIEW', 'CHANGES_REQUESTED')
                                            and not (v_mi.status = 'CHANGES_REQUESTED' and v_blocks)
                                            and v_mi.deemed_approval_enabled and v_mi.reminder_sent_at is not null
                                            and now() >= v_mi.review_due_at, false),
      -- api.overrule_minutes_objection.
      'may_overrule_objection', v_delib and committee.meeting_chair_as(v_mi.meeting_id, v_me) is not null
                                and v_mi.status = 'CHANGES_REQUESTED' and not v_objected));
end;
$$;
comment on function api.minutes_view(uuid) is
  'Purpose read model of one minutes version (migration 2030 section 4, DEC-02): NOT_FOUND unless the minutes_read '
  'predicate holds; reviews and rulings under deliberation; capabilities from the checks of the matching commands.';

grant execute on function api.meeting_view(uuid), api.minutes_view(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 4.3 Notifications (ADR-025): a raised conflict to its decider, an opened vote to who may cast it
-- -----------------------------------------------------------------------------
insert into notify.template (code, object_type, is_mandatory, description) values
  ('MEETING_CONFLICT_DECISION_REQUESTED', 'MEETING', true, 'A conflict raised in a meeting awaits the user''s decision (DEC-F04)'),
  ('MEETING_VOTE_OPENED',                 'MEETING', true, 'A vote opened in a meeting where the user may cast it (DEC-F01)');
insert into notify.rule (layer, template_code, channel, enabled, effective_from, reason)
select 'SYSTEM_MANDATORY', t.code, c.channel, true, '2026-01-01T00:00:00Z', 'Synthetic default: mandatory notice (ADR-025)'
from notify.template t cross join (values ('IN_APP'), ('EMAIL')) c (channel)
where t.code in ('MEETING_CONFLICT_DECISION_REQUESTED', 'MEETING_VOTE_OPENED');

-- Whether a user decides a raised conflict now: authz.meeting_concern_decider_seat, evaluated as that user. The
-- caller's claims are restored before returning (an error rolls the change back with the statement). Internal.
create function notify.decides_concern(p_concern_id uuid, p_user_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_seat text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  v_seat := authz.meeting_concern_decider_seat(p_concern_id);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v_seat is not null;
end;
$$;

-- DEC-F04: the decider of a raised conflict. Candidates are the meeting's users, the committee's current seat holders
-- and its conflict authorities in force; the decision predicate picks among them. Never the raiser or the subject.
create function notify.on_meeting_conflict_concern()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m committee.meeting;
  v_subject uuid;
  v_user uuid;
begin
  select * into v_m from committee.meeting m where m.id = new.meeting_id;
  select mp.user_id into v_subject from committee.meeting_participant mp where mp.id = new.participant_id;
  for v_user in select distinct k.user_id from (
                  select mp.user_id from committee.meeting_participant mp where mp.meeting_id = v_m.id
                  union
                  select s.user_id from committee.membership s
                  where s.committee_id = notify.meeting_committee(v_m.id)
                    and s.effective_from <= now() and (s.effective_to is null or s.effective_to > now())
                  union
                  select a.user_id from committee.conflict_authority a
                  where a.committee_id = notify.meeting_committee(v_m.id)
                    and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())) k
                where k.user_id is not null and k.user_id <> new.raised_by and k.user_id is distinct from v_subject
                  and authz.user_case_gate(k.user_id, v_m.case_id)
                  and not authz.has_meeting_conflict(k.user_id, v_m.committee_proceeding_id)
                order by k.user_id loop
    if notify.decides_concern(new.id, v_user) then
      perform notify.enqueue('MEETING_CONFLICT_DECISION_REQUESTED', v_user, v_m.id, notify.meeting_committee(v_m.id),
                             'meeting-concern:' || new.id);
    end if;
  end loop;
  return null;
end;
$$;
create trigger meeting_conflict_concern_notify after insert on committee.meeting_conflict_concern
  for each row execute function notify.on_meeting_conflict_concern();

-- DEC-F01: an opened vote, to the members who may cast it now (api.cast_vote's checks).
create function notify.on_vote_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m committee.meeting;
  v_user uuid;
begin
  if new.status <> 'OPEN' then return null; end if;
  select * into v_m from committee.meeting m where m.id = new.meeting_id;
  for v_user in select mp.user_id from committee.meeting_participant mp
                where mp.meeting_id = v_m.id and mp.participant_kind = 'MEMBER' and mp.user_id is not null
                  and committee.counts_as_voter(mp.id)
                  and mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT'
                  and not exists (select 1 from committee.vote v where v.vote_item_id = new.id and v.participant_id = mp.id)
                  and authz.user_case_gate(mp.user_id, v_m.case_id)
                  and not authz.has_meeting_conflict(mp.user_id, v_m.committee_proceeding_id) loop
    perform notify.enqueue('MEETING_VOTE_OPENED', v_user, v_m.id, notify.meeting_committee(v_m.id),
                           'meeting-vote:' || new.id);
  end loop;
  return null;
end;
$$;
create trigger vote_item_notify after insert on committee.vote_item
  for each row execute function notify.on_vote_item();

revoke all on function
  notify.decides_concern(uuid, uuid), notify.on_meeting_conflict_concern(), notify.on_vote_item()
from public, anon, authenticated;
