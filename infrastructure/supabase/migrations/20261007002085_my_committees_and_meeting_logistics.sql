-- =============================================================================
-- 2085 My Committees and the meeting's logistics (UX redesign Phase 12, slice P12-2b; ADR-055)
-- Requirements: Phase 12 plan §2 (rules 1, 5 and 6) and §4 (P12-2); DEC-02 and ADR-016 D2 (purpose routes, never the
-- full case); DEC-F19 (a committee as counts, never names); DEC-22 (a row may show an object or reference id); UX-116
-- (a screen offers an action from server capabilities); AMB-038 (a member added to a proceeding after referral);
-- DEC-F03 and AMB-041, AMB-042, AMB-050, AMB-066, AMB-088 (acting roles and alternates); AMB-156, AMB-157, AMB-158
-- (invitees, accommodations, confidentiality); ADR-054 §5 (the secretary's path for an invitee without an account,
-- deferred here). Linear CDF-220. Number and ADR allocated by the coordinator (2026-10-14 15:05), with the conditions
-- of that answer: the capability-flag pattern of 2065, no table, policy, grant or command change, the seat basis only
-- for My Committees (never the can_view_case branch), the snapshot as DEC-F19 counts, the case number only with
-- case-metadata visibility.
--
-- Before: no read model listed a caller's committees or their proceedings. api.my_areas (2045) only said that the
-- Committee area exists, and RLS on committee_proceeding is wider than the area: authz.can_view_committee_proceeding
-- also admits the case team through authz.can_view_case. Nothing answered whether the caller may schedule a meeting or
-- add a member to a proceeding, and api.meeting_view (2065) said nothing about invitations, excluding a witness, the
-- three activations or accommodations, nor about the secretary's path for an invitee without an account.
--
-- After:
--   * committee.seat_basis_proceeding(committee_proceeding): the caller's seat basis for a proceeding, which is the
--     first branch of authz.can_view_committee_proceeding, word for word: the case gate, and the caller's own snapshot
--     row (not case_gate_excluded) with a current seat, or the committee's secretary or alternate secretary. Never the
--     can_view_case branch. An internal helper: no application role may execute it.
--   * api.my_committees(): each committee where the caller holds a current seat (authz.user_committee_seat), with the
--     seat and two counts on the seat basis: open proceedings, and meetings scheduled or open. Nothing for an ended
--     seat, a committee administrator without a seat (Administration is P12-8) or the case team.
--   * api.committee_view(committee): NOT_FOUND unless the caller holds a current seat on it, the same as a committee
--     that does not exist. The committee, the caller's seat, its current members by name and seat (the registry,
--     which RLS shows any current seat holder), the rules in force as a referral would copy them, and the proceedings
--     on the seat basis only. Each proceeding: its status and times, its rule snapshot, the case number only with
--     authz.can_view_case_metadata, the committee as copied (counts per seat and totals, never a name or a per-person
--     flag: DEC-F19), its meetings, and the scheduling and amendment capabilities.
--   * api.meeting_view is replaced with the same signature, grant and owner. Every key 2065 returned is returned to the
--     same callers with the same values. It gains:
--       - meeting level: may_invite (api.invite_to_meeting) with the invitee roles the rule enables, for the runner;
--         may_activate_acting_chair and may_activate_acting_secretary; and, like 2065's own-row flags,
--         may_record_accommodation with the caller's own accommodations under `me`, for an invitee who sees no roster.
--       - on each roster row, for the meeting's runner on any row and on the caller's own row (false elsewhere, as in
--         2065): may_exclude_witness, may_record_accommodation, may_declare_conflict, may_declare_no_conflict,
--         may_acknowledge_confidentiality (each the command for that participant: the secretary's path where the row
--         has no account, ADR-054 §5) and may_activate_alternate, with alternate_for, the members that alternate may
--         replace now (empty for anyone but the runner); and arrangements (the acknowledgement and the accommodations
--         recorded), for whoever RLS lets read them: the runner and the participant themself.
--
-- How each capability is computed (coordinator, 2026-10-14 11:53, as for 2065): with the helpers its command calls, in
-- the command's order, including the constraints and triggers that refuse the command's writes
-- (committee.refuse_excluded_participant, 2010 and 2030; meeting_acting_role's check that nobody activates themself),
-- without taking a lock and without writing, so a page view adds nothing to the audit ledger. Input checks (a reason's
-- length, the time chosen against the minimum notice, the member, user or role chosen) are the command's to answer.
-- The security tests run the real command for each case and assert that the capability equals its answer.
--
-- What a capability tells (AGENT-09, to clear): nothing its command would not answer. Three answers concern another
-- person and are shown only to the meeting's runner, who sees the roster and the acting roles already:
-- may_activate_acting_chair and alternate_for follow their commands' basis, which counts a chair or member who no
-- longer passes the case gate as INELIGIBLE, as the activation records and the deliberation then shows; and
-- may_activate_acting_secretary needs an alternate secretary who passes it. The amendment's candidates are the current
-- members not in the snapshot, deliberately not filtered by clearance: api.amend_proceeding_snapshot answers
-- NOT_CLEARED_FOR_CASE at submit, and a list of cleared candidates would be a per-person clearance flag (DEC-F19).
--
-- Controls:
--   * Two read models and one internal helper added, one read model replaced. No table, policy, table grant or command
--     changes; the new read models are granted to authenticated only and join the policy snapshot's function list.
--   * SECURITY DEFINER with search_path '', stable. A capability never widens a command: the command checks again.
--   * Every capabilities object holds booleans only, never null; every list is a list, empty for whoever may not act.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The seat basis
-- -----------------------------------------------------------------------------
create function committee.seat_basis_proceeding(p_committee_proceeding_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  -- authz.can_view_committee_proceeding (2030) without its second branch, authz.can_view_case.
  select authz.current_user_id() is not null and exists (
    select 1 from committee.committee_proceeding cp
    where cp.id = p_committee_proceeding_id
      and authz.user_case_gate(authz.current_user_id(), cp.case_id)
      and (exists (select 1 from committee.proceeding_member pm
                   where pm.committee_proceeding_id = cp.id and pm.user_id = authz.current_user_id()
                     and not pm.case_gate_excluded
                     and authz.user_committee_seat(pm.user_id, cp.committee_id, now()) is not null)
           or authz.is_committee_secretary(cp.committee_id))
  );
$$;
comment on function committee.seat_basis_proceeding(uuid) is
  'The caller''s seat basis for a committee proceeding (migration 2085, ADR-055): the first branch of '
  'authz.can_view_committee_proceeding, never its can_view_case branch. For My Committees; not granted.';

-- -----------------------------------------------------------------------------
-- 2. My Committees
-- -----------------------------------------------------------------------------
create function api.my_committees()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'committee_id', c.id, 'code', c.code, 'kind', c.kind, 'is_active', c.is_active,
           'seat', s.seat, 'effective_from', s.effective_from, 'effective_to', s.effective_to,
           'open_proceedings', (select count(*)::int from committee.committee_proceeding cp
                                where cp.committee_id = c.id and cp.status = 'OPEN'
                                  and committee.seat_basis_proceeding(cp.id)),
           'active_meetings', (select count(*)::int from committee.meeting m
                               join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
                               where cp.committee_id = c.id and m.status in ('SCHEDULED', 'OPEN')
                                 and committee.seat_basis_proceeding(cp.id) and authz.can_view_meeting(m.id)))
         order by c.code), '[]'::jsonb)
  from committee.committee c
  -- authz.user_committee_seat: an ACTIVE user's seat in force now, the latest appointment first.
  cross join lateral (
    select m.seat, m.effective_from, m.effective_to
    from committee.membership m
    join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
    where m.user_id = authz.current_user_id() and m.committee_id = c.id
      and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now())
    order by m.effective_from desc
    limit 1) s;
$$;
grant execute on function api.my_committees() to authenticated;
comment on function api.my_committees() is
  'My Committees (migration 2085, ADR-055): each committee where the caller holds a current seat, with the seat and '
  'counts of open proceedings and of scheduled or open meetings on the seat basis (committee.seat_basis_proceeding). '
  'Read-only.';

create function api.committee_view(p_committee_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_me uuid := authz.current_user_id();
  v_c committee.committee;
  v_seat record;
  v_rules committee.rule_set;
begin
  select * into v_c from committee.committee c where c.id = p_committee_id;
  -- A committee that does not exist, an ended seat and no seat at all answer the same NOT_FOUND. Maintaining the
  -- registry without a seat is Administration's (P12-8), never this page.
  if v_c.id is null or v_me is null or authz.user_committee_seat(v_me, v_c.id, now()) is null then
    perform api._fail('NOT_FOUND');
  end if;
  -- The membership authz.user_committee_seat reads.
  select m.seat, m.effective_from, m.effective_to into v_seat
  from committee.membership m
  join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
  where m.user_id = v_me and m.committee_id = v_c.id
    and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now())
  order by m.effective_from desc
  limit 1;
  -- The rule set a referral would copy now (committee.open_committee_proceeding).
  select * into v_rules from committee.rule_set r
  where r.committee_id = v_c.id and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())
  order by r.effective_from desc
  limit 1;

  return jsonb_build_object(
    'committee', jsonb_build_object('committee_id', v_c.id, 'code', v_c.code, 'kind', v_c.kind,
                                    'is_active', v_c.is_active),
    'my_seat', jsonb_build_object('seat', v_seat.seat, 'effective_from', v_seat.effective_from,
                                  'effective_to', v_seat.effective_to),
    -- membership_read (authz.can_view_committee_registry): the current members, by name and seat.
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', m.user_id, 'display_name', u.display_name, 'display_name_ar', u.display_name_ar,
               'seat', m.seat, 'effective_from', m.effective_from, 'effective_to', m.effective_to)
             order by array_position(array['CHAIR', 'DEPUTY_CHAIR', 'SECRETARY', 'ALTERNATE_SECRETARY', 'MEMBER',
                                           'ALTERNATE_MEMBER'], m.seat), m.effective_from, m.id)
      from committee.membership m
      join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
      where m.committee_id = v_c.id
        and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now())), '[]'::jsonb),
    -- rule_set_read: the rules in force, in the shape a referral copies them into its snapshot.
    'rules', case when v_rules.id is not null
                  then to_jsonb(v_rules) - array['id', 'committee_id', 'created_by', 'created_at', 'reason'] end,
    'proceedings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'committee_proceeding_id', cp.id, 'status', cp.status, 'referred_at', cp.referred_at,
               'closed_at', cp.closed_at,
               -- As in api.meeting_view: the case is named only to whoever may see its metadata.
               'case', jsonb_build_object(
                 'case_id', case when f.metadata then cp.case_id end,
                 'case_number', case when f.metadata then (select c.case_number from case_mgmt.case_record c
                                                           where c.id = cp.case_id) end),
               'rules', cp.rule_snapshot,
               -- DEC-F19: the committee as the proceeding holds it (copied at referral, and any member added since,
               -- AMB-038), as holders per seat and four totals. No id, name or per-person flag.
               'snapshot', (
                 select jsonb_build_object(
                          'seats', coalesce((
                            select jsonb_agg(jsonb_build_object('seat', x.seat, 'count', x.n)
                                             order by array_position(array['CHAIR', 'DEPUTY_CHAIR', 'SECRETARY',
                                               'ALTERNATE_SECRETARY', 'MEMBER', 'ALTERNATE_MEMBER'], x.seat))
                            from (select pm2.seat, count(*)::int as n from committee.proceeding_member pm2
                                  where pm2.committee_proceeding_id = cp.id group by pm2.seat) x), '[]'::jsonb),
                          'voting', count(*) filter (where pm.is_voting),
                          'cleared', count(*) filter (where not pm.case_gate_excluded),
                          'not_cleared', count(*) filter (where pm.case_gate_excluded),
                          'firewall_restricted', count(*) filter (where pm.firewall_restricted),
                          'added_after_referral', (select count(*)::int from committee.proceeding_snapshot_amendment a
                                                   where a.committee_proceeding_id = cp.id))
                 from committee.proceeding_member pm where pm.committee_proceeding_id = cp.id),
               'meetings', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'meeting_id', m.id, 'sequence_no', m.sequence_no, 'purpose', m.purpose, 'mode', m.mode,
                          'status', m.status, 'scheduled_start', m.scheduled_start, 'scheduled_end', m.scheduled_end,
                          'is_emergency', m.is_emergency)
                        order by m.scheduled_start, m.sequence_no)
                 from committee.meeting m
                 where m.committee_proceeding_id = cp.id and authz.can_view_meeting(m.id)), '[]'::jsonb),
               -- api.amend_proceeding_snapshot's choice of member, for whoever may amend: the committee's current
               -- members (an ACTIVE user, effective now) not in the snapshot (ALREADY_IN_SNAPSHOT). Not filtered by
               -- clearance: the command answers NOT_CLEARED_FOR_CASE at submit, and no list here says who is cleared.
               'amendment_candidates', case when f.amend then coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'membership_id', m.id, 'user_id', m.user_id, 'display_name', u.display_name,
                          'display_name_ar', u.display_name_ar, 'seat', m.seat, 'effective_from', m.effective_from)
                        order by array_position(array['CHAIR', 'DEPUTY_CHAIR', 'SECRETARY', 'ALTERNATE_SECRETARY',
                                                      'MEMBER', 'ALTERNATE_MEMBER'], m.seat), m.effective_from, m.id)
                 from committee.membership m
                 join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
                 where m.committee_id = cp.committee_id
                   and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now())
                   and not exists (select 1 from committee.proceeding_member pm
                                   where pm.committee_proceeding_id = cp.id and pm.user_id = m.user_id)), '[]'::jsonb)
                 else '[]'::jsonb end,
               'capabilities', jsonb_build_object(
                 -- api.schedule_meeting and api.schedule_emergency_meeting (committee.insert_meeting), up to the
                 -- notice check, which needs the time chosen: the committee's secretary or alternate secretary
                 -- passing the case gate, the proceeding OPEN, the case ACTIVE.
                 'may_schedule_meeting', f.schedule,
                 'may_schedule_emergency_meeting', f.schedule,
                 -- api.amend_proceeding_snapshot, up to the member chosen: the same checks, and the case not
                 -- restricted (AUTHORITY_APPROVAL_REQUIRED, fail closed until that approval is built).
                 'may_amend_snapshot', f.amend))
             order by cp.status = 'OPEN' desc, cp.referred_at desc, cp.id)
      from committee.committee_proceeding cp
      cross join lateral (
        select authz.can_view_case_metadata(cp.case_id) as metadata,
               coalesce(authz.is_committee_secretary(cp.committee_id) and authz.user_case_gate(v_me, cp.case_id)
                        and cp.status = 'OPEN'
                        and exists (select 1 from case_mgmt.case_record c
                                    where c.id = cp.case_id and c.records_state = 'ACTIVE'), false) as schedule) f0
      cross join lateral (
        select f0.metadata, f0.schedule,
               f0.schedule and not exists (select 1 from case_mgmt.case_record c
                                           where c.id = cp.case_id and c.is_restricted) as amend) f
      where cp.committee_id = v_c.id and committee.seat_basis_proceeding(cp.id)), '[]'::jsonb));
end;
$$;
grant execute on function api.committee_view(uuid) to authenticated;
comment on function api.committee_view(uuid) is
  'One committee for a current seat holder (migration 2085, ADR-055): the committee, the caller''s seat, the current '
  'members, the rules in force, and the proceedings on the seat basis only, each with its rule snapshot, the case '
  'number under case-metadata visibility, the committee as counts (DEC-F19), its meetings, and the scheduling and '
  'amendment capabilities. NOT_FOUND without a current seat. Read-only.';

-- -----------------------------------------------------------------------------
-- 3. The meeting's logistics
-- -----------------------------------------------------------------------------
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
      'opened_at', v_m.opened_at, 'closed_at', v_m.closed_at),
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
comment on function api.meeting_view(uuid) is
  'Purpose read model of one meeting (migration 2030 section 4, DEC-02; capabilities added in 2065, ADR-054, and 2085, '
  'ADR-055): each part under the predicate of its table, capabilities from the checks of the matching commands. No '
  'individual choice, no case content. Under authz.can_view_meeting the full view; otherwise, to a caller who may see '
  'one of its concerns, the concern-only view (meeting id and status, case under its metadata predicate, those '
  'concerns); otherwise NOT_FOUND. A roster row''s capabilities are computed for the meeting''s runner, or on the '
  'caller''s own row; elsewhere they are false. record_vote_for, alternate_for and invitee_roles are empty for anyone '
  'but the runner; a row''s arrangements are null for anyone but the runner and the participant.';
