-- =============================================================================
-- 2030 Owner Finalization Set, part 1: committees, meetings, votes, minutes, recommendations, legal review and
-- authority decisions (Business Architecture Rebase; CDF-196 programme; DEC-F01–F07, F11–F13, F19, F20 and the
-- ambiguity register rows routed to this migration)
-- Requirements: owner decisions DEC-F01 to DEC-F41 and DEC-AMB-003, 007 and 010
-- (docs/business-architecture/OWNER_DECISIONS_FINALIZATION.md, 2026-10-13); owner Q&A; ADR-019 to ADR-023, ADR-038,
-- ADR-039; ADR-040 (this migration and 2040)
--
-- The owner answered the open decision list of the rebase final report on 2026-10-13 (DEC-F01–F41). This migration
-- applies the decisions that concern committees, meetings, votes, minutes, recommendation packages, legal review and
-- authority decisions. Migration 2040 applies the rest (defence, grievance, export, corrective actions, the continuity
-- workbook, referral and the catalogue).
--
-- Section 1, the committee rule set. Every committee option the decisions and the ambiguity register name becomes a
-- column of the effective-dated rule set, so it is snapshotted into each proceeding and each grievance like the
-- existing rules:
--   * decision_rule (DEC-F01, simple majority of substantive votes), acting_chair_casting_vote (DEC-F03, off),
--     vote_revision_allowed (AMB-081), ballot_secrecy (AMB-083), minimum_notice_days (AMB-061, SOURCE_REQUIRED, not
--     enforced while null), minutes_objection_blocks_deemed (AMB-092), sanction_requires_defence_notice (AMB-026),
--     dissent_note_allowed (AMB-082);
--   * for the Grievance Committee: grievance_window_start_basis (DEC-F15), non_admission_decider (DEC-F17, EXTERNAL
--     added to the admissibility deciders) and grievance_completion_days (AMB-141, SOURCE_REQUIRED).
--   A null in a Grievance Committee column means "as built before 2030" (window from issue; the admissibility decider
--   also decides non-admission), so the version in force before this migration keeps its meaning for the grievances
--   already filed under it (DEC-F16). A new Grievance Committee version, effective now, carries DEC-F14/F15/F17
--   (CON-004). api.revise_committee_rule_set starts a new version from the one in force with only the named options
--   changed; the 1870 setter is kept and now carries the new options forward unchanged.
--
-- Section 2, meetings, votes and minutes (DEC-F02–F07, DEC-AMB-007, DEC-AMB-010); section 3, recommendation
-- packages, legal review and authority decisions (DEC-F11–F13, F19, F20, DEC-AMB-003); and section 4, the purpose
-- read models for a meeting and its minutes and two content-free meeting notifications (UX Phase 12 asks), each
-- describe themselves in their banner below.
--
-- Controls:
--   * Additive and non-destructive: columns, tables and commands are added; replaced functions keep their signature,
--     SECURITY DEFINER and search_path, and no check is weakened. Nothing is dropped, renamed or deleted.
--   * Every new table has RLS enabled, is default deny and is select-only for authenticated where readable at all.
--   * Every command writes its audit event in the same transaction; reasons stay in their rows, the ledger gets ids
--     and codes only.
-- =============================================================================

-- =============================================================================
-- Section 1. Committee rule set options
-- =============================================================================
alter table committee.rule_set
  add column decision_rule text not null default 'SIMPLE_MAJORITY_SUBSTANTIVE'
    check (decision_rule in ('SIMPLE_MAJORITY_SUBSTANTIVE')),
  add column acting_chair_casting_vote boolean not null default false,
  add column vote_revision_allowed boolean not null default true,
  add column ballot_secrecy text not null default 'COMMITTEE_AFTER_CLOSE'
    check (ballot_secrecy in ('COMMITTEE_AFTER_CLOSE', 'SECRET_BALLOT')),
  add column minimum_notice_days int check (minimum_notice_days between 0 and 60),
  add column minutes_objection_blocks_deemed boolean not null default true,
  add column sanction_requires_defence_notice boolean not null default true,
  add column dissent_note_allowed boolean not null default true,
  add column grievance_window_start_basis text
    check (grievance_window_start_basis in ('ISSUE', 'DELIVERY', 'ACKNOWLEDGEMENT')),
  add column non_admission_decider text
    check (non_admission_decider in ('SECRETARY', 'CHAIR', 'COMMITTEE', 'EXTERNAL')),
  add column grievance_completion_days int check (grievance_completion_days between 1 and 90);

-- DEC-F17: an external authority may be the admissibility decider. The check keeps its 1870 name.
alter table committee.rule_set drop constraint rule_set_admissibility_decider_check;
alter table committee.rule_set add constraint rule_set_admissibility_decider_check
  check (admissibility_decider in ('SECRETARY', 'CHAIR', 'COMMITTEE', 'EXTERNAL'));

comment on column committee.rule_set.decision_rule is
  'DEC-F01 (owner, 2026-10-13): simple majority of substantive votes cast, APPROVE > REJECT; ABSTAIN, ABSENT, RECUSED '
  'and UNABLE_TO_VOTE count neither way; quorum is evaluated independently first. The only value today.';
comment on column committee.rule_set.acting_chair_casting_vote is
  'DEC-F03: whether a deputy chair formally activated as acting chair for a meeting holds the casting vote. Off unless '
  'the committee rule grants it (SOURCE_REQUIRED). The secretary never holds it.';
comment on column committee.rule_set.vote_revision_allowed is
  'AMB-081: a member may change their own vote while the item is OPEN, as an append-only revision; only the last counts.';
comment on column committee.rule_set.dissent_note_allowed is
  'AMB-082: a member may add a note to their own vote, read by the committee after close and annexed to the minutes only '
  'at the member''s request; never shown to the subject.';
comment on column committee.rule_set.ballot_secrecy is
  'AMB-083: COMMITTEE_AFTER_CLOSE lets the members of the proceeding see individual choices after close; SECRET_BALLOT '
  'keeps them hidden for good. Never the subject, the grievant or the case team.';
comment on column committee.rule_set.minimum_notice_days is
  'AMB-061: minimum notice before a meeting, in days (SOURCE_REQUIRED, committee charter). Null: not enforced. A '
  'shorter notice needs the EMERGENCY flag with a reason.';
comment on column committee.rule_set.minutes_objection_blocks_deemed is
  'AMB-092: an open objection to draft minutes blocks deemed approval until the secretary revises or the chair decides.';
comment on column committee.rule_set.sanction_requires_defence_notice is
  'AMB-026: a DISCIPLINARY_SANCTION item cannot be adopted for a subject on an allegation no defence notice issued to '
  'that subject covers.';
comment on column committee.rule_set.grievance_window_start_basis is
  'DEC-F15 (Grievance Committee): what starts the grievance window of a decision notice. DELIVERY by owner decision; '
  'null on versions before migration 2030 means ISSUE, as built.';
comment on column committee.rule_set.non_admission_decider is
  'DEC-F17 (Grievance Committee): who decides a substantive rejection or non-admission. The secretary records the initial '
  'assessment. COMMITTEE by owner decision; null on versions before migration 2030 means the admissibility decider.';
comment on column committee.rule_set.grievance_completion_days is
  'AMB-141 (Grievance Committee): days a grievant has to complete an incomplete grievance (SOURCE_REQUIRED). Null: no '
  'completion request can be made.';

-- The 1870 setter, unchanged except that a new version carries the 2030 options of the version in force.
create or replace function api.set_committee_rule_set(
  p_committee_id uuid, p_effective_from timestamptz, p_quorum_type text, p_quorum_value numeric,
  p_casting_vote_enabled boolean, p_minutes_review_business_days int, p_deemed_approval_enabled boolean,
  p_grievance_window_days int, p_admissibility_decider text, p_no_substantive_vote_outcome text, p_source_status text,
  p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_c committee.committee;
  v_current committee.rule_set;
  v_id uuid;
  v_reason text;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  v_c := committee.lock_committee(p_committee_id);
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_quorum_type is null or p_quorum_type not in ('MAJORITY_ELIGIBLE', 'FIXED_NUMBER', 'PERCENTAGE', 'CUSTOM') then
    perform api._fail('INVALID', 'quorum_type');
  end if;
  if (p_quorum_type = 'FIXED_NUMBER' and (p_quorum_value is null or p_quorum_value < 1 or p_quorum_value <> trunc(p_quorum_value)))
     or (p_quorum_type = 'PERCENTAGE' and (p_quorum_value is null or p_quorum_value <= 0 or p_quorum_value > 100))
     or (p_quorum_type in ('MAJORITY_ELIGIBLE', 'CUSTOM') and p_quorum_value is not null) then
    perform api._fail('INVALID', 'quorum_value');
  end if;
  if p_casting_vote_enabled is null then perform api._fail('INVALID', 'casting_vote_enabled'); end if;
  if p_deemed_approval_enabled is null then perform api._fail('INVALID', 'deemed_approval_enabled'); end if;
  if p_minutes_review_business_days is null or p_minutes_review_business_days not between 1 and 30 then
    perform api._fail('INVALID', 'minutes_review_business_days');
  end if;
  if v_c.kind = 'GRIEVANCE' then
    if p_grievance_window_days is null or p_grievance_window_days not between 1 and 365 then
      perform api._fail('INVALID', 'grievance_window_days');
    end if;
    if p_admissibility_decider is null or p_admissibility_decider not in ('SECRETARY', 'CHAIR', 'COMMITTEE', 'EXTERNAL') then
      perform api._fail('INVALID', 'admissibility_decider');
    end if;
  elsif p_grievance_window_days is not null or p_admissibility_decider is not null then
    perform api._fail('INVALID', 'grievance_rules');
  end if;
  if p_no_substantive_vote_outcome is null or p_no_substantive_vote_outcome not in ('NO_DECISION', 'TIED') then
    perform api._fail('INVALID', 'no_substantive_vote_outcome');
  end if;
  if p_source_status is null or p_source_status not in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);

  if exists (select 1 from committee.rule_set r where r.committee_id = p_committee_id and r.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'RULE_SET_SCHEDULED');
  end if;
  select * into v_current from committee.rule_set r
  where r.committee_id = p_committee_id and r.effective_to is null;
  if v_current.id is not null then
    update committee.rule_set set effective_to = p_effective_from where id = v_current.id;
  end if;

  insert into committee.rule_set (committee_id, effective_from, quorum_type, quorum_value, casting_vote_enabled,
                                  minutes_review_business_days, deemed_approval_enabled, grievance_window_days,
                                  admissibility_decider, no_substantive_vote_outcome, source_status, reason, created_by,
                                  conflict_decider, decision_rule, acting_chair_casting_vote, vote_revision_allowed,
                                  ballot_secrecy, minimum_notice_days, minutes_objection_blocks_deemed,
                                  sanction_requires_defence_notice, grievance_window_start_basis, non_admission_decider,
                                  grievance_completion_days, dissent_note_allowed)
  values (p_committee_id, p_effective_from, p_quorum_type, p_quorum_value, p_casting_vote_enabled,
          p_minutes_review_business_days, p_deemed_approval_enabled, p_grievance_window_days,
          p_admissibility_decider, p_no_substantive_vote_outcome, p_source_status, v_reason, v_actor,
          coalesce(v_current.conflict_decider, 'CHAIR'), coalesce(v_current.decision_rule, 'SIMPLE_MAJORITY_SUBSTANTIVE'),
          coalesce(v_current.acting_chair_casting_vote, false), coalesce(v_current.vote_revision_allowed, true),
          coalesce(v_current.ballot_secrecy, 'COMMITTEE_AFTER_CLOSE'), v_current.minimum_notice_days,
          coalesce(v_current.minutes_objection_blocks_deemed, true),
          coalesce(v_current.sanction_requires_defence_notice, true),
          case when v_c.kind = 'GRIEVANCE' then v_current.grievance_window_start_basis end,
          case when v_c.kind = 'GRIEVANCE' then v_current.non_admission_decider end,
          case when v_c.kind = 'GRIEVANCE' then v_current.grievance_completion_days end,
          coalesce(v_current.dissent_note_allowed, true))
  returning id into v_id;
  perform audit.record_event('COMMITTEE_RULE_SET_CHANGED', 'ADMIN', 'SUCCESS', null, 'committee_rule_set', v_id::text, v_reason,
    jsonb_build_object('committee_id', p_committee_id, 'previous_rule_set_id', v_current.id, 'effective_from', p_effective_from,
                       'quorum_type', p_quorum_type, 'quorum_value', p_quorum_value,
                       'no_substantive_vote_outcome', p_no_substantive_vote_outcome, 'source_status', p_source_status));
  return v_id;
end;
$$;

-- A new version from the one in force, with only the named options changed. Unknown options are refused; Grievance
-- Committee options are refused for other committees. The ledger records the options changed (codes and numbers only).
create function api.revise_committee_rule_set(
  p_committee_id uuid, p_effective_from timestamptz, p_changes jsonb, p_source_status text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_c committee.committee;
  v_current committee.rule_set;
  v_new committee.rule_set;
  v_reason text;
  v_key text;
  v_allowed constant text[] := array[
    'quorum_type', 'quorum_value', 'casting_vote_enabled', 'minutes_review_business_days', 'deemed_approval_enabled',
    'no_substantive_vote_outcome', 'conflict_decider', 'decision_rule', 'acting_chair_casting_vote',
    'vote_revision_allowed', 'ballot_secrecy', 'minimum_notice_days', 'minutes_objection_blocks_deemed',
    'sanction_requires_defence_notice', 'grievance_window_days', 'admissibility_decider', 'grievance_window_start_basis',
    'non_admission_decider', 'grievance_completion_days', 'dissent_note_allowed'];
  v_grievance_only constant text[] := array[
    'grievance_window_days', 'admissibility_decider', 'grievance_window_start_basis', 'non_admission_decider',
    'grievance_completion_days'];
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  v_c := committee.lock_committee(p_committee_id);
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    perform api._fail('INVALID', 'changes');
  end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if not (v_key = any (v_allowed)) then perform api._fail('INVALID', 'changes'); end if;
    if v_c.kind <> 'GRIEVANCE' and v_key = any (v_grievance_only) then perform api._fail('INVALID', 'grievance_rules'); end if;
  end loop;
  if p_source_status is null or p_source_status not in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  if exists (select 1 from committee.rule_set r where r.committee_id = p_committee_id and r.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'RULE_SET_SCHEDULED');
  end if;
  select * into v_current from committee.rule_set r where r.committee_id = p_committee_id and r.effective_to is null;
  if v_current.id is null then perform api._fail('CONFLICT', 'NO_RULE_SET'); end if;

  begin
    v_new := jsonb_populate_record(v_current, p_changes);
  exception when others then
    perform api._fail('INVALID', 'changes');
  end;
  -- Every value of the new version is checked, not only the changed ones.
  if v_new.quorum_type is null or v_new.quorum_type not in ('MAJORITY_ELIGIBLE', 'FIXED_NUMBER', 'PERCENTAGE', 'CUSTOM')
     or (v_new.quorum_type = 'FIXED_NUMBER'
         and (v_new.quorum_value is null or v_new.quorum_value < 1 or v_new.quorum_value <> trunc(v_new.quorum_value)))
     or (v_new.quorum_type = 'PERCENTAGE' and (v_new.quorum_value is null or v_new.quorum_value <= 0 or v_new.quorum_value > 100))
     or (v_new.quorum_type in ('MAJORITY_ELIGIBLE', 'CUSTOM') and v_new.quorum_value is not null) then
    perform api._fail('INVALID', 'quorum');
  end if;
  if v_new.casting_vote_enabled is null or v_new.deemed_approval_enabled is null or v_new.acting_chair_casting_vote is null
     or v_new.vote_revision_allowed is null or v_new.minutes_objection_blocks_deemed is null
     or v_new.sanction_requires_defence_notice is null or v_new.dissent_note_allowed is null then
    perform api._fail('INVALID', 'changes');
  end if;
  if v_new.minutes_review_business_days is null or v_new.minutes_review_business_days not between 1 and 30 then
    perform api._fail('INVALID', 'minutes_review_business_days');
  end if;
  if v_new.no_substantive_vote_outcome is null or v_new.no_substantive_vote_outcome not in ('NO_DECISION', 'TIED') then
    perform api._fail('INVALID', 'no_substantive_vote_outcome');
  end if;
  if v_new.conflict_decider is null or v_new.conflict_decider not in ('CHAIR', 'SECRETARY') then
    perform api._fail('INVALID', 'conflict_decider');
  end if;
  if v_new.decision_rule is distinct from 'SIMPLE_MAJORITY_SUBSTANTIVE' then perform api._fail('INVALID', 'decision_rule'); end if;
  if v_new.ballot_secrecy is null or v_new.ballot_secrecy not in ('COMMITTEE_AFTER_CLOSE', 'SECRET_BALLOT') then
    perform api._fail('INVALID', 'ballot_secrecy');
  end if;
  if v_new.minimum_notice_days is not null and v_new.minimum_notice_days not between 0 and 60 then
    perform api._fail('INVALID', 'minimum_notice_days');
  end if;
  if v_c.kind = 'GRIEVANCE' then
    if v_new.grievance_window_days is null or v_new.grievance_window_days not between 1 and 365 then
      perform api._fail('INVALID', 'grievance_window_days');
    end if;
    if v_new.admissibility_decider is null or v_new.admissibility_decider not in ('SECRETARY', 'CHAIR', 'COMMITTEE', 'EXTERNAL') then
      perform api._fail('INVALID', 'admissibility_decider');
    end if;
    -- A version written after 2030 always names its window start and non-admission decider.
    if v_new.grievance_window_start_basis is null
       or v_new.grievance_window_start_basis not in ('ISSUE', 'DELIVERY', 'ACKNOWLEDGEMENT') then
      perform api._fail('INVALID', 'grievance_window_start_basis');
    end if;
    if v_new.non_admission_decider is null
       or v_new.non_admission_decider not in ('SECRETARY', 'CHAIR', 'COMMITTEE', 'EXTERNAL') then
      perform api._fail('INVALID', 'non_admission_decider');
    end if;
    if v_new.grievance_completion_days is not null and v_new.grievance_completion_days not between 1 and 90 then
      perform api._fail('INVALID', 'grievance_completion_days');
    end if;
  end if;

  update committee.rule_set set effective_to = p_effective_from where id = v_current.id;
  v_new.id := gen_random_uuid();
  v_new.effective_from := p_effective_from;
  v_new.effective_to := null;
  v_new.source_status := p_source_status;
  v_new.reason := v_reason;
  v_new.created_by := v_actor;
  v_new.created_at := now();
  insert into committee.rule_set select (v_new).*;
  perform audit.record_event('COMMITTEE_RULE_SET_CHANGED', 'ADMIN', 'SUCCESS', null, 'committee_rule_set', v_new.id::text,
    v_reason, jsonb_build_object('committee_id', p_committee_id, 'previous_rule_set_id', v_current.id,
                                 'effective_from', p_effective_from, 'changes', p_changes, 'source_status', p_source_status));
  return v_new.id;
end;
$$;
grant execute on function api.revise_committee_rule_set(uuid, timestamptz, jsonb, text, text) to authenticated;

-- CON-004, DEC-F14/F15/F17: a new Grievance Committee version, effective now. The window stays 30 days and now starts
-- at delivery; a substantive non-admission is decided by the committee. The version before it keeps its meaning (null:
-- as built) for the grievances already filed under it (DEC-F16).
do $$
declare
  v_current committee.rule_set;
  v_at timestamptz := now();
begin
  select r.* into v_current from committee.rule_set r
  join committee.committee c on c.id = r.committee_id
  where c.kind = 'GRIEVANCE' and r.effective_to is null;
  if v_current.id is null then return; end if;
  update committee.rule_set set effective_to = v_at where id = v_current.id;
  insert into committee.rule_set (committee_id, effective_from, quorum_type, quorum_value, casting_vote_enabled,
                                  minutes_review_business_days, deemed_approval_enabled, grievance_window_days,
                                  admissibility_decider, no_substantive_vote_outcome, source_status, reason,
                                  conflict_decider, decision_rule, acting_chair_casting_vote, vote_revision_allowed,
                                  ballot_secrecy, minimum_notice_days, minutes_objection_blocks_deemed,
                                  sanction_requires_defence_notice, grievance_window_start_basis, non_admission_decider,
                                  grievance_completion_days, dissent_note_allowed)
  values (v_current.committee_id, v_at, v_current.quorum_type, v_current.quorum_value, v_current.casting_vote_enabled,
          v_current.minutes_review_business_days, v_current.deemed_approval_enabled, 30,
          v_current.admissibility_decider, v_current.no_substantive_vote_outcome, 'OWNER_DEFAULT',
          'Owner Finalization Set 2026-10-13: DEC-F14 (30 days), DEC-F15 (from delivery), DEC-F17 (committee decides non-admission).',
          v_current.conflict_decider, v_current.decision_rule, v_current.acting_chair_casting_vote,
          v_current.vote_revision_allowed, v_current.ballot_secrecy, v_current.minimum_notice_days,
          v_current.minutes_objection_blocks_deemed, v_current.sanction_requires_defence_notice, 'DELIVERY', 'COMMITTEE',
          null, v_current.dissent_note_allowed);
end;
$$;

-- =============================================================================
-- Section 2. Meetings, votes and minutes
-- =============================================================================
-- DEC-F02 (CON-005, AMB-094): business days come from a calendar administered without code changes.
--   config.business_week_pattern (effective-dated working week, seeded Sunday–Thursday as built in 1890) and
--   config.business_calendar_day (holidays, other non-working days and working-day exceptions, by date). The calendar
--   source is SOURCE_REQUIRED (config.setting BUSINESS_CALENDAR_SOURCE) until a CDF calendar is connected; no holiday is
--   seeded. committee.add_business_days reads both. Due dates already computed are stored and never move; a day in the
--   past cannot be added or withdrawn (no retroactive change). BUSINESS_CALENDAR_ADMIN (platform administrator) keeps it.
-- DEC-F03 (AMB-040, AMB-075, CON-007), AMB-042, AMB-050, AMB-066: one acting record per meeting
--   (committee.meeting_acting_role). The secretary running the meeting activates the deputy chair as ACTING_CHAIR when
--   the chair is absent, conflicted, ineligible or the seat is vacant. The meeting's chair (or the secretary handing
--   over) activates the alternate secretary as ACTING_SECRETARY. The casting vote follows committee.casting_voter: the
--   chair if participating and eligible; else the activated acting chair only when the rule snapshot grants it
--   (acting_chair_casting_vote, off by default); else none, and the item stays TIED. Never the secretary.
--   authz.can_manage_meeting is narrowed: an alternate secretary runs a meeting only while recorded as acting for it.
-- AMB-041, AMB-088: an alternate member votes only when activated in place of a named absent or conflicted member;
--   quorum counts seats, so the replaced member stops counting and cannot be recorded present again.
-- AMB-038, AMB-039: a member appointed after referral joins a proceeding only by api.amend_proceeding_snapshot (audited,
--   reason, case gate). A member whose seat has ended stops counting from the end date: no new meetings, no votes, no
--   view of the proceeding (authz.can_view_committee_proceeding narrowed); past votes stand.
-- DEC-F04 (AMB-049, CON-006): a raised conflict is decided by the chair; when the chair is the subject or the raiser,
--   conflicted, absent or otherwise ineligible, by the deputy chair if eligible; otherwise by the committee's
--   configured independent conflict authority (committee.conflict_authority, effective-dated, COMMITTEE_ADMIN). Never
--   the raiser, never the subject; nobody decides when nobody is eligible (fail closed).
-- DEC-F07: the cancellation notice of a meeting no longer reaches an excluded witness.
-- AMB-061: a committee may set a minimum notice (rule snapshot, SOURCE_REQUIRED, not enforced while null); a shorter
--   notice needs api.schedule_emergency_meeting with a reason.
-- AMB-067: quorum is checked when a vote opens (a trigger, every path) and again at close.
-- AMB-077: api.recuse_for_conflict records the recusal and the member's conflict declaration together.
-- AMB-081, AMB-082, AMB-083: vote revision while OPEN (append-only, the last counts, as secret as the vote); a member's
--   note on their own vote, annexed to the minutes only at their request; SECRET_BALLOT keeps choices hidden for good.
-- AMB-092: an objection (changes requested) blocks deemed approval unless the rule says otherwise; the chair may
--   overrule it with a reason, which returns the minutes to review.
-- AMB-156, AMB-157, AMB-158: an INTERPRETER invitee type (disabled by default), confidentiality acknowledgement per
--   invitee type (WITNESS and EXPERT by default, wording SOURCE_REQUIRED) before being recorded present, and
--   accommodation requests readable only by the secretary running the meeting and the participant.
--
-- Replaced functions (signature, SECURITY DEFINER and search_path kept; every check kept or tightened):
--   committee.add_business_days (calendar), authz.can_manage_meeting (alternate secretary only while acting),
--   authz.can_view_committee_proceeding (member branch needs a current seat), authz.meeting_concern_decider_seat
--   (DEC-F04 cascade), api.decide_meeting_conflict (the conflict authority is not on the meeting), api.schedule_meeting
--   (current seats, minimum notice), api.invite_to_meeting (interpreter, acknowledgement requirement),
--   api.record_attendance (replaced members, acknowledgement), api.cast_vote, api.record_vote_for_member,
--   api.close_vote_item, api.cast_casting_vote, api.vote_item_status, api.generate_minutes,
--   api.apply_minutes_deemed_approval, notify.on_meeting.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2.1 Permission: the business calendar (mirrored in packages/contracts and packages/authorization)
-- -----------------------------------------------------------------------------
insert into iam.permission (code, description) values
  ('BUSINESS_CALENDAR_ADMIN', 'Maintain the business calendar (working week, holidays); gives no case access');
insert into iam.role_permission (role_code, permission_code) values ('PLATFORM_ADMIN', 'BUSINESS_CALENDAR_ADMIN');

insert into config.setting (key, value, status, source_reference, description) values
  ('BUSINESS_CALENDAR_SOURCE', null, 'SOURCE_REQUIRED', null,
   'DEC-F02: the authoritative CDF calendar of public holidays and non-working days. Until it is connected, holidays '
   'are entered by the calendar administrator (config.business_calendar_day) and none is assumed.');

-- -----------------------------------------------------------------------------
-- 2.2 The business calendar (DEC-F02)
-- -----------------------------------------------------------------------------
create table config.business_week_pattern (
  id                 uuid primary key default gen_random_uuid(),
  -- ISO days of the week that are not working days (1 Monday … 7 Sunday). At least one working day a week.
  non_working_isodow int[] not null check (non_working_isodow <@ array[1, 2, 3, 4, 5, 6, 7]
                                           and cardinality(non_working_isodow) <= 6),
  effective_from     timestamptz not null,
  effective_to       timestamptz,
  source_status      text not null check (source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  reason             text check (length(reason) between 5 and 2000),
  created_by         uuid references iam.user_profile (id),
  created_at         timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  check (created_by is not null or source_status = 'OWNER_DEFAULT')
);
create index business_week_pattern_from on config.business_week_pattern (effective_from);
create index business_week_pattern_created_by on config.business_week_pattern (created_by);
comment on table config.business_week_pattern is
  'DEC-F02: the working week in Asia/Riyadh, effective-dated (migration 2030). Rows only ever gain an effective_to.';

insert into config.business_week_pattern (non_working_isodow, effective_from, source_status, reason)
values (array[5, 6], timestamptz '2026-01-01 00:00:00+00', 'OWNER_DEFAULT',
        'As built in migration 1890: Sunday to Thursday are working days.');

create table config.business_calendar_day (
  id               uuid primary key default gen_random_uuid(),
  calendar_date    date not null,
  -- HOLIDAY (a public holiday), NON_WORKING_DAY (a CDF-specific closure) or WORKING_DAY (a working day on a weekend).
  day_type         text not null check (day_type in ('HOLIDAY', 'NON_WORKING_DAY', 'WORKING_DAY')),
  source_reference text check (length(source_reference) between 3 and 200),
  reason           text not null check (length(reason) between 5 and 2000),
  recorded_by      uuid not null references iam.user_profile (id),
  recorded_at      timestamptz not null default now(),
  withdrawn_by     uuid references iam.user_profile (id),
  withdrawn_at     timestamptz,
  withdraw_reason  text check (length(withdraw_reason) between 5 and 2000),
  check ((withdrawn_by is null) = (withdrawn_at is null) and (withdrawn_at is null) = (withdraw_reason is null))
);
create unique index business_calendar_day_active on config.business_calendar_day (calendar_date) where withdrawn_at is null;
create index business_calendar_day_recorded_by on config.business_calendar_day (recorded_by);
create index business_calendar_day_withdrawn_by on config.business_calendar_day (withdrawn_by);
comment on table config.business_calendar_day is
  'DEC-F02: dated exceptions to the working week (migration 2030). Nothing is seeded: the calendar source is '
  'SOURCE_REQUIRED. A row is withdrawn, never deleted or changed.';

create function config.protect_business_calendar()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'business_week_pattern' then
    if (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') or old.effective_to is not null then
      raise exception 'week pattern % can only be given an end, once', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif (to_jsonb(new) - array['withdrawn_by', 'withdrawn_at', 'withdraw_reason'])
        <> (to_jsonb(old) - array['withdrawn_by', 'withdrawn_at', 'withdraw_reason'])
        or old.withdrawn_at is not null then
    raise exception 'calendar day % can only be withdrawn, once', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger business_week_pattern_protect before update on config.business_week_pattern
  for each row execute function config.protect_business_calendar();
create trigger business_calendar_day_protect before update on config.business_calendar_day
  for each row execute function config.protect_business_calendar();
create trigger no_delete before delete on config.business_week_pattern
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on config.business_week_pattern
  for each statement execute function committee.reject_mutation();
create trigger no_delete before delete on config.business_calendar_day
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on config.business_calendar_day
  for each statement execute function committee.reject_mutation();

alter table config.business_week_pattern enable row level security;
alter table config.business_calendar_day enable row level security;
-- The calendar is not sensitive: every signed-in user reads it (due dates on screens).
create policy business_week_pattern_read on config.business_week_pattern for select to authenticated
  using (authz.current_user_id() is not null);
create policy business_calendar_day_read on config.business_calendar_day for select to authenticated
  using (authz.current_user_id() is not null);
grant select on config.business_week_pattern, config.business_calendar_day to authenticated;

-- Whether a local date in Asia/Riyadh is a working day: a dated exception first, else the week pattern in force.
create function config.is_business_day(p_day date)
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select d.day_type = 'WORKING_DAY' from config.business_calendar_day d
     where d.calendar_date = p_day and d.withdrawn_at is null),
    not (extract(isodow from p_day)::int = any (coalesce(
      (select w.non_working_isodow from config.business_week_pattern w
       where w.effective_from <= (p_day::timestamp at time zone 'Asia/Riyadh')
         and (w.effective_to is null or w.effective_to > (p_day::timestamp at time zone 'Asia/Riyadh'))
       order by w.effective_from desc limit 1),
      array[5, 6]))));
$$;

-- p_days business days after p_from, same local time of day (1890 contract), now from the calendar (DEC-F02).
create or replace function committee.add_business_days(p_from timestamptz, p_days int)
returns timestamptz
language plpgsql stable
set search_path = ''
as $$
declare
  v_local timestamp := p_from at time zone 'Asia/Riyadh';
  v_left int := p_days;
  v_steps int := 0;
begin
  while v_left > 0 loop
    v_local := v_local + interval '1 day';
    v_steps := v_steps + 1;
    if v_steps > 3700 then raise exception 'business calendar has no working day ahead'; end if;
    if config.is_business_day(v_local::date) then v_left := v_left - 1; end if;
  end loop;
  return v_local at time zone 'Asia/Riyadh';
end;
$$;

create function api.set_business_calendar_day(p_calendar_date date, p_day_type text, p_source_reference text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_reason text;
  v_id uuid;
begin
  if not authz.has_permission('BUSINESS_CALENDAR_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  -- No retroactive change: today and later only (Asia/Riyadh).
  if p_calendar_date is null or p_calendar_date < (now() at time zone 'Asia/Riyadh')::date then
    perform api._fail('INVALID', 'calendar_date');
  end if;
  if p_day_type is null or p_day_type not in ('HOLIDAY', 'NON_WORKING_DAY', 'WORKING_DAY') then
    perform api._fail('INVALID', 'day_type');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  -- One entry per date (serialised on the date by the unique index); a change is a withdrawal then a new entry.
  perform pg_advisory_xact_lock(hashtext('business_calendar_day:' || p_calendar_date::text));
  if exists (select 1 from config.business_calendar_day d where d.calendar_date = p_calendar_date and d.withdrawn_at is null) then
    perform api._fail('CONFLICT', 'CALENDAR_DAY_EXISTS');
  end if;
  insert into config.business_calendar_day (calendar_date, day_type, source_reference, reason, recorded_by)
  values (p_calendar_date, p_day_type,
          case when p_source_reference is not null then api._require_text(p_source_reference, 'source_reference', 3, 200) end,
          v_reason, v_actor)
  returning id into v_id;
  perform audit.record_event('BUSINESS_CALENDAR_DAY_SET', 'ADMIN', 'SUCCESS', null, 'business_calendar_day', v_id::text,
    v_reason, jsonb_build_object('calendar_date', p_calendar_date, 'day_type', p_day_type,
                                 'sourced', p_source_reference is not null));
  return v_id;
end;
$$;

create function api.withdraw_business_calendar_day(p_day_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_d config.business_calendar_day;
  v_reason text;
begin
  if not authz.has_permission('BUSINESS_CALENDAR_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  select * into v_d from config.business_calendar_day d where d.id = p_day_id for update;
  if v_d.id is null then perform api._fail('NOT_FOUND'); end if;
  if v_d.withdrawn_at is not null then perform api._fail('CONFLICT', 'CALENDAR_DAY_WITHDRAWN'); end if;
  if v_d.calendar_date < (now() at time zone 'Asia/Riyadh')::date then perform api._fail('CONFLICT', 'CALENDAR_DAY_PAST'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update config.business_calendar_day set withdrawn_by = v_actor, withdrawn_at = now(), withdraw_reason = v_reason
   where id = v_d.id;
  perform audit.record_event('BUSINESS_CALENDAR_DAY_WITHDRAWN', 'ADMIN', 'SUCCESS', null, 'business_calendar_day', v_d.id::text,
    v_reason, jsonb_build_object('calendar_date', v_d.calendar_date, 'day_type', v_d.day_type));
end;
$$;

create function api.set_business_week_pattern(
  p_non_working_isodow int[], p_effective_from timestamptz, p_source_status text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_current config.business_week_pattern;
  v_reason text;
  v_id uuid;
begin
  if not authz.has_permission('BUSINESS_CALENDAR_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_non_working_isodow is null or not (p_non_working_isodow <@ array[1, 2, 3, 4, 5, 6, 7])
     or cardinality(p_non_working_isodow) > 6 or array_position(p_non_working_isodow, null) is not null then
    perform api._fail('INVALID', 'non_working_isodow');
  end if;
  if p_source_status is null or p_source_status not in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform pg_advisory_xact_lock(hashtext('business_week_pattern'));
  if exists (select 1 from config.business_week_pattern w where w.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'PATTERN_SCHEDULED');
  end if;
  select * into v_current from config.business_week_pattern w where w.effective_to is null;
  if v_current.id is not null then
    update config.business_week_pattern set effective_to = p_effective_from where id = v_current.id;
  end if;
  insert into config.business_week_pattern (non_working_isodow, effective_from, source_status, reason, created_by)
  values ((select array_agg(distinct d order by d) from unnest(p_non_working_isodow) d), p_effective_from, p_source_status,
          v_reason, v_actor)
  returning id into v_id;
  perform audit.record_event('BUSINESS_WEEK_PATTERN_CHANGED', 'ADMIN', 'SUCCESS', null, 'business_week_pattern', v_id::text,
    v_reason, jsonb_build_object('previous_pattern_id', v_current.id, 'effective_from', p_effective_from,
                                 'non_working_isodow', to_jsonb(p_non_working_isodow), 'source_status', p_source_status));
  return v_id;
end;
$$;

grant execute on function
  api.set_business_calendar_day(date, text, text, text),
  api.withdraw_business_calendar_day(uuid, text),
  api.set_business_week_pattern(int[], timestamptz, text, text)
to authenticated;

-- -----------------------------------------------------------------------------
-- 2.3 Schema additions to meetings
-- -----------------------------------------------------------------------------
-- AMB-061: the emergency flag and the notice rule in force when the meeting was scheduled.
alter table committee.meeting
  add column is_emergency boolean not null default false,
  add column emergency_reason text check (length(emergency_reason) between 10 and 2000),
  add column minimum_notice_days int check (minimum_notice_days between 0 and 60),
  add constraint meeting_emergency_reason check (is_emergency = (emergency_reason is not null));
comment on column committee.meeting.minimum_notice_days is
  'AMB-061: the minimum notice of the proceeding''s rule snapshot when the meeting was scheduled (null: none sourced).';

-- AMB-156: an interpreter invitee. AMB-158: whether the invitee must acknowledge confidentiality before attending,
-- fixed at invitation from committee.invitee_type_rule.
alter table committee.meeting_participant drop constraint meeting_participant_invitee_role_check;
alter table committee.meeting_participant add constraint meeting_participant_invitee_role_check
  check (invitee_role in ('WITNESS', 'EXPERT', 'LEGAL', 'INFORMATION_PROVIDER', 'SUBJECT', 'INTERPRETER'));
alter table committee.meeting_participant
  add column confidentiality_ack_required boolean not null default false;
comment on column committee.meeting_participant.confidentiality_ack_required is
  'AMB-158: the invitee acknowledges confidentiality (committee.confidentiality_ack) before being recorded present. Set '
  'at invitation from committee.invitee_type_rule (migration 2030).';

-- DEC-F04: the configured independent conflict authority decides when no chair or deputy chair can.
alter table committee.meeting_conflict_concern drop constraint meeting_conflict_concern_decided_as_check;
alter table committee.meeting_conflict_concern add constraint meeting_conflict_concern_decided_as_check
  check (decided_as in ('CHAIR', 'DEPUTY_CHAIR', 'SECRETARY', 'CONFLICT_AUTHORITY'));

-- -----------------------------------------------------------------------------
-- 2.4 New tables
-- -----------------------------------------------------------------------------
-- AMB-156, AMB-158: per invitee type, whether it may be invited and whether it acknowledges confidentiality.
create table committee.invitee_type_rule (
  invitee_role                 text primary key check (invitee_role in (
                                 'WITNESS', 'EXPERT', 'LEGAL', 'INFORMATION_PROVIDER', 'SUBJECT', 'INTERPRETER')),
  enabled                      boolean not null,
  confidentiality_ack_required boolean not null,
  -- The wording to acknowledge: SOURCE_REQUIRED while null.
  wording_reference            text check (length(wording_reference) between 3 and 200),
  source_status                text not null check (source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  updated_by                   uuid references iam.user_profile (id),
  updated_at                   timestamptz not null default now()
);
create index invitee_type_rule_updated_by on committee.invitee_type_rule (updated_by);
comment on table committee.invitee_type_rule is
  'AMB-156/AMB-158 (migration 2030): which invitee types exist and which acknowledge confidentiality. Changes take '
  'effect for later invitations only (the requirement is fixed on the participant row).';
insert into committee.invitee_type_rule (invitee_role, enabled, confidentiality_ack_required, source_status) values
  ('WITNESS', true, true, 'OWNER_DEFAULT'),
  ('EXPERT', true, true, 'OWNER_DEFAULT'),
  ('LEGAL', true, false, 'OWNER_DEFAULT'),
  ('INFORMATION_PROVIDER', true, false, 'OWNER_DEFAULT'),
  ('SUBJECT', true, false, 'OWNER_DEFAULT'),
  ('INTERPRETER', false, true, 'SOURCE_REQUIRED');

-- DEC-F03, AMB-041/042/050/066/088, CON-007: who acts in another's place for one meeting, and why. Append-only.
create table committee.meeting_acting_role (
  id                      uuid primary key default gen_random_uuid(),
  meeting_id              uuid not null references committee.meeting (id),
  acting_role             text not null check (acting_role in ('ACTING_CHAIR', 'ACTING_SECRETARY', 'ALTERNATE_MEMBER')),
  user_id                 uuid not null references iam.user_profile (id),
  -- The acting person's participant row (the alternate secretary may have none: secretaries need not be snapshotted).
  participant_id          uuid references committee.meeting_participant (id),
  -- The member an alternate replaces, or the chair the deputy acts for (null when the seat is vacant).
  replaces_participant_id uuid references committee.meeting_participant (id),
  basis                   text not null check (basis in ('ABSENT', 'CONFLICTED', 'INELIGIBLE', 'VACANT', 'HANDOVER')),
  reason                  text not null check (length(reason) between 10 and 2000),
  activated_by            uuid not null references iam.user_profile (id),
  activated_as            text not null check (activated_as in ('SECRETARY', 'CHAIR', 'ACTING_CHAIR')),
  activated_at            timestamptz not null default clock_timestamp(),
  check (acting_role = 'ACTING_SECRETARY' or participant_id is not null),
  check (acting_role <> 'ALTERNATE_MEMBER' or (replaces_participant_id is not null and basis in ('ABSENT', 'CONFLICTED', 'INELIGIBLE'))),
  check (basis <> 'HANDOVER' or (acting_role = 'ACTING_SECRETARY' and activated_as = 'SECRETARY')),
  check (activated_by <> user_id)
);
create unique index meeting_acting_chair on committee.meeting_acting_role (meeting_id) where acting_role = 'ACTING_CHAIR';
create unique index meeting_acting_secretary on committee.meeting_acting_role (meeting_id) where acting_role = 'ACTING_SECRETARY';
create unique index meeting_alternate_once on committee.meeting_acting_role (participant_id) where acting_role = 'ALTERNATE_MEMBER';
create unique index meeting_replaced_once on committee.meeting_acting_role (replaces_participant_id)
  where acting_role = 'ALTERNATE_MEMBER';
create index meeting_acting_role_user on committee.meeting_acting_role (user_id);
create index meeting_acting_role_activated_by on committee.meeting_acting_role (activated_by);
comment on table committee.meeting_acting_role is
  'Formal activations for one meeting (DEC-F03, ADR-019 §4 as amended by ADR-040; migration 2030): the deputy chair '
  'acting as chair, the alternate secretary acting as secretary, an alternate member voting in place of a named absent '
  'or conflicted member. Final for the meeting. Read by the meeting''s deliberation and by the acting person.';

-- DEC-F04: the committee's independent conflict authority, effective-dated like a seat (named holder, SOURCE_REQUIRED).
create table committee.conflict_authority (
  id                    uuid primary key default gen_random_uuid(),
  committee_id          uuid not null references committee.committee (id),
  user_id               uuid not null references iam.user_profile (id),
  effective_from        timestamptz not null,
  effective_to          timestamptz,
  appointment_reference text not null check (length(appointment_reference) between 3 and 200),
  source_status         text not null check (source_status in ('SOURCE_REQUIRED', 'APPROVED')),
  reason                text not null check (length(reason) between 5 and 2000),
  appointed_by          uuid not null references iam.user_profile (id),
  appointed_at          timestamptz not null default now(),
  ended_by              uuid references iam.user_profile (id),
  ended_at              timestamptz,
  end_reason            text check (length(end_reason) between 5 and 2000),
  check (effective_to is null or effective_to > effective_from),
  check ((ended_by is null) = (ended_at is null) and (ended_at is null) = (end_reason is null)),
  check (appointed_by <> user_id)
);
create index conflict_authority_committee on committee.conflict_authority (committee_id, effective_from);
create index conflict_authority_user on committee.conflict_authority (user_id);
create index conflict_authority_appointed_by on committee.conflict_authority (appointed_by);
create index conflict_authority_ended_by on committee.conflict_authority (ended_by);
comment on table committee.conflict_authority is
  'DEC-F04 (migration 2030): who decides a meeting conflict when no chair or deputy chair of the meeting is eligible. '
  'Holds no seat on the committee. Nobody is appointed by default: until one is, such a conflict stays undecided and '
  'votes wait (fail closed).';

-- AMB-038: a member appointed after the referral joins the proceeding only through an amendment.
create table committee.proceeding_snapshot_amendment (
  id                      uuid primary key default gen_random_uuid(),
  committee_proceeding_id uuid not null references committee.committee_proceeding (id),
  proceeding_member_id    uuid not null unique references committee.proceeding_member (id),
  membership_id           uuid not null references committee.membership (id),
  reason                  text not null check (length(reason) between 10 and 2000),
  amended_by              uuid not null references iam.user_profile (id),
  amended_at              timestamptz not null default clock_timestamp()
);
create index proceeding_snapshot_amendment_cp on committee.proceeding_snapshot_amendment (committee_proceeding_id);
create index proceeding_snapshot_amendment_membership on committee.proceeding_snapshot_amendment (membership_id);
create index proceeding_snapshot_amendment_amended_by on committee.proceeding_snapshot_amendment (amended_by);
comment on table committee.proceeding_snapshot_amendment is
  'AMB-038, ADR-018 §2 (migration 2030): members added to a proceeding''s snapshot after referral, with the reason. '
  'Append-only.';

-- AMB-081: a member's change of their own vote while the item is open. As secret as the vote: no grant at all.
create table committee.vote_revision (
  id           uuid primary key default gen_random_uuid(),
  vote_id      uuid not null references committee.vote (id),
  vote_item_id uuid not null references committee.vote_item (id),
  revision_no  int not null check (revision_no >= 1),
  choice       text not null check (choice in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED')),
  reason       text check (length(reason) between 5 and 2000),
  revised_at   timestamptz not null default clock_timestamp(),
  unique (vote_id, revision_no)
);
create index vote_revision_item on committee.vote_revision (vote_item_id);
comment on table committee.vote_revision is
  'AMB-081 (migration 2030): append-only revisions of a member''s own vote; the last counts. Not selectable.';

-- AMB-082: a member's note on their own vote. Read through api.vote_item_status after close; no grant.
create table committee.vote_note (
  id               uuid primary key default gen_random_uuid(),
  vote_item_id     uuid not null references committee.vote_item (id),
  participant_id   uuid not null references committee.meeting_participant (id),
  note             text not null check (length(note) between 10 and 4000),
  annex_to_minutes boolean not null,
  recorded_at      timestamptz not null default clock_timestamp(),
  unique (vote_item_id, participant_id)
);
create index vote_note_participant on committee.vote_note (participant_id);
comment on table committee.vote_note is
  'AMB-082 (migration 2030): a member''s note (a dissent, for example) on their own vote. Not selectable.';

-- AMB-092: the chair's ruling on an objection to draft minutes.
create table committee.minutes_objection_ruling (
  id         uuid primary key default gen_random_uuid(),
  minutes_id uuid not null references committee.minutes (id),
  ruled_by   uuid not null references iam.user_profile (id),
  ruled_as   text not null check (ruled_as in ('CHAIR', 'ACTING_CHAIR')),
  reason     text not null check (length(reason) between 10 and 2000),
  ruled_at   timestamptz not null default clock_timestamp()
);
create index minutes_objection_ruling_minutes on committee.minutes_objection_ruling (minutes_id);
create index minutes_objection_ruling_ruled_by on committee.minutes_objection_ruling (ruled_by);
comment on table committee.minutes_objection_ruling is
  'AMB-092 (migration 2030): the chair overruled the objection to a minutes version, which returned to review. '
  'Append-only.';

-- AMB-158: confidentiality acknowledgements.
create table committee.confidentiality_ack (
  id                uuid primary key default gen_random_uuid(),
  meeting_id        uuid not null references committee.meeting (id),
  participant_id    uuid not null unique references committee.meeting_participant (id),
  acknowledged_by   uuid not null references iam.user_profile (id),
  source            text not null check (source in ('SELF', 'SECRETARY')),
  wording_reference text,
  acknowledged_at   timestamptz not null default clock_timestamp()
);
create index confidentiality_ack_meeting on committee.confidentiality_ack (meeting_id);
create index confidentiality_ack_by on committee.confidentiality_ack (acknowledged_by);
comment on table committee.confidentiality_ack is
  'AMB-158 (migration 2030): an invitee acknowledged confidentiality (themself, or the secretary for an invitee without '
  'an account). The wording is SOURCE_REQUIRED while the invitee type has no wording reference.';

-- AMB-157: accommodation requests. The details may concern health: readable only by the secretary running the meeting
-- and the participant; the ledger records that one exists, never the details.
create table committee.meeting_accommodation (
  id             uuid primary key default gen_random_uuid(),
  meeting_id     uuid not null references committee.meeting (id),
  participant_id uuid not null references committee.meeting_participant (id),
  details        text not null check (length(details) between 5 and 2000),
  recorded_by    uuid not null references iam.user_profile (id),
  source         text not null check (source in ('SELF', 'SECRETARY')),
  recorded_at    timestamptz not null default clock_timestamp()
);
create index meeting_accommodation_meeting on committee.meeting_accommodation (meeting_id);
create index meeting_accommodation_participant on committee.meeting_accommodation (participant_id);
create index meeting_accommodation_recorded_by on committee.meeting_accommodation (recorded_by);
comment on table committee.meeting_accommodation is
  'AMB-157 (migration 2030): accommodation requested for a meeting participant. Append-only. Read by the secretary '
  'running the meeting and the participant only.';

-- Integrity: everything above but the invitee rule and the conflict authority is append-only.
do $$
declare t text;
begin
  foreach t in array array['committee.meeting_acting_role', 'committee.proceeding_snapshot_amendment',
                           'committee.vote_revision', 'committee.vote_note', 'committee.minutes_objection_ruling',
                           'committee.confidentiality_ack', 'committee.meeting_accommodation'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
  foreach t in array array['committee.invitee_type_rule', 'committee.conflict_authority'] loop
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;

-- An excluded witness's participation is final (2010): no acknowledgement or accommodation is recorded for them.
create trigger confidentiality_ack_not_excluded before insert on committee.confidentiality_ack
  for each row execute function committee.refuse_excluded_participant();
create trigger meeting_accommodation_not_excluded before insert on committee.meeting_accommodation
  for each row execute function committee.refuse_excluded_participant();

-- A conflict authority's period only ever ends earlier, once (as a seat, 1870).
create function committee.protect_conflict_authority()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['effective_to', 'ended_by', 'ended_at', 'end_reason'])
     <> (to_jsonb(old) - array['effective_to', 'ended_by', 'ended_at', 'end_reason'])
     or old.ended_at is not null
     or (old.effective_to is not null and (new.effective_to is null or new.effective_to > old.effective_to)) then
    raise exception 'conflict authority % can only be ended earlier, once', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger conflict_authority_protect before update on committee.conflict_authority
  for each row execute function committee.protect_conflict_authority();

-- -----------------------------------------------------------------------------
-- 2.5 Internal helpers (owner context; not granted)
-- -----------------------------------------------------------------------------
-- AMB-039: the member still holds a seat on the committee now (any seat; a re-appointment keeps them on).
create function committee.member_seat_current(p_participant_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from committee.meeting_participant mp
    join committee.meeting m on m.id = mp.meeting_id
    join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
    where mp.id = p_participant_id and mp.participant_kind = 'MEMBER'
      and authz.user_committee_seat(mp.user_id, cp.committee_id, now()) is not null);
$$;

create function committee.is_activated_alternate(p_participant_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from committee.meeting_acting_role a
                 where a.participant_id = p_participant_id and a.acting_role = 'ALTERNATE_MEMBER');
$$;

create function committee.is_replaced_member(p_participant_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from committee.meeting_acting_role a
                 where a.replaces_participant_id = p_participant_id and a.acting_role = 'ALTERNATE_MEMBER');
$$;

-- A voting seat of the meeting that counts now: a voting member or an activated alternate, not replaced by an
-- alternate, still seated on the committee, cleared for the case (AMB-039, AMB-041, AMB-088).
create function committee.counts_as_voter(p_participant_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from committee.meeting_participant mp
    join committee.meeting m on m.id = mp.meeting_id
    where mp.id = p_participant_id and mp.participant_kind = 'MEMBER'
      and (mp.is_voting or committee.is_activated_alternate(mp.id))
      and not committee.is_replaced_member(mp.id)
      and committee.member_seat_current(mp.id)
      and authz.user_case_gate(mp.user_id, m.case_id));
$$;

-- Quorum of a meeting now, from its proceeding's rule snapshot (Q51, DEC-F01): eligible = counting seats with no
-- conflict, present = those recorded present. CUSTOM quorum has no number (the secretary attests it at close).
create function committee.quorum_state(p_meeting_id uuid, out eligible int, out present int, out required int,
                                       out quorum_type text)
language plpgsql stable
set search_path = ''
as $$
declare
  v_rule jsonb;
begin
  select cp.rule_snapshot into v_rule
  from committee.meeting m join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
  where m.id = p_meeting_id;
  select count(*) filter (where mp.coi_status = 'NO_CONFLICT'),
         count(*) filter (where mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT')
    into eligible, present
  from committee.meeting_participant mp
  where mp.meeting_id = p_meeting_id and committee.counts_as_voter(mp.id);
  quorum_type := v_rule ->> 'quorum_type';
  required := case quorum_type
                when 'MAJORITY_ELIGIBLE' then eligible / 2 + 1
                when 'FIXED_NUMBER' then (v_rule ->> 'quorum_value')::numeric::int
                when 'PERCENTAGE' then ceil(eligible * (v_rule ->> 'quorum_value')::numeric / 100)::int
              end;
end;
$$;

-- AMB-081: the choice that counts, the last revision or the vote itself.
create function committee.vote_choice(p_vote_id uuid)
returns text
language sql stable
set search_path = ''
as $$
  select coalesce((select r.choice from committee.vote_revision r where r.vote_id = p_vote_id
                   order by r.revision_no desc limit 1),
                  (select v.choice from committee.vote v where v.id = p_vote_id));
$$;

-- A participant who may break a tie on an item: counting, present, no conflict, with their own counted vote on the
-- item that is not a recusal (AGENT-09 V2).
create function committee.casting_ready(p_participant_id uuid, p_vote_item_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from committee.meeting_participant mp
    join committee.vote v on v.participant_id = mp.id and v.vote_item_id = p_vote_item_id
    where mp.id = p_participant_id and mp.seat in ('CHAIR', 'DEPUTY_CHAIR')
      and mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT'
      and committee.counts_as_voter(mp.id)
      and committee.vote_choice(v.id) in ('APPROVE', 'REJECT', 'ABSTAIN'));
$$;

-- DEC-F03: who holds the casting vote on an item. The chair if participating and eligible; otherwise the deputy chair
-- activated as acting chair for the meeting, only when the rule snapshot grants it; otherwise nobody. Never the
-- secretary (a secretary seat never casts).
create function committee.casting_voter(p_vote_item_id uuid)
returns uuid
language plpgsql stable
set search_path = ''
as $$
declare
  v_item committee.vote_item;
  v_rule jsonb;
  v_id uuid;
begin
  select * into v_item from committee.vote_item vi where vi.id = p_vote_item_id;
  select mp.id into v_id from committee.meeting_participant mp
  where mp.meeting_id = v_item.meeting_id and mp.participant_kind = 'MEMBER' and mp.seat = 'CHAIR'
    and committee.casting_ready(mp.id, v_item.id)
  order by mp.added_at, mp.id limit 1;
  if v_id is not null then return v_id; end if;
  select cp.rule_snapshot into v_rule
  from committee.meeting m join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
  where m.id = v_item.meeting_id;
  if coalesce((v_rule ->> 'acting_chair_casting_vote')::boolean, false) then
    select a.participant_id into v_id from committee.meeting_acting_role a
    where a.meeting_id = v_item.meeting_id and a.acting_role = 'ACTING_CHAIR'
      and committee.casting_ready(a.participant_id, v_item.id);
    return v_id;
  end if;
  return null;
end;
$$;

-- The chair of a meeting for rulings (AMB-092): the chair participant if cleared and not absent, else the activated
-- acting chair. Returns the seat label it acts as, for the given user.
create function committee.meeting_chair_as(p_meeting_id uuid, p_user_id uuid)
returns text
language sql stable
set search_path = ''
as $$
  select case
    when exists (select 1 from committee.meeting_participant mp join committee.meeting m on m.id = mp.meeting_id
                 where mp.meeting_id = p_meeting_id and mp.user_id = p_user_id and mp.participant_kind = 'MEMBER'
                   and mp.seat = 'CHAIR' and mp.coi_status = 'NO_CONFLICT'
                   and mp.attendance not in ('ABSENT', 'EXCUSED', 'EXCUSED_CONFLICT')
                   and committee.member_seat_current(mp.id) and authz.user_case_gate(mp.user_id, m.case_id))
      then 'CHAIR'
    when exists (select 1 from committee.meeting_acting_role a
                 join committee.meeting_participant mp on mp.id = a.participant_id
                 join committee.meeting m on m.id = mp.meeting_id
                 where a.meeting_id = p_meeting_id and a.acting_role = 'ACTING_CHAIR' and a.user_id = p_user_id
                   and mp.coi_status = 'NO_CONFLICT' and committee.member_seat_current(mp.id)
                   and authz.user_case_gate(mp.user_id, m.case_id))
      then 'ACTING_CHAIR'
  end;
$$;

-- -----------------------------------------------------------------------------
-- 2.6 Predicates (narrowed)
-- -----------------------------------------------------------------------------
-- Running the meeting, for a given user: the committee's current secretary, or its alternate secretary only while
-- recorded as acting for this meeting (AMB-042/050/066, CON-007); cleared for the case and not conflicted in the
-- meeting, as in 1890. Taking the user as an argument lets the notice engine ask about a candidate without changing
-- the request identity (AGENT-09 pack 3, R1). Internal: no application role may execute it.
create function committee.manages_meeting(p_meeting_id uuid, p_user_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1 from committee.meeting m
    join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
    where m.id = p_meeting_id
      and coalesce(authz.user_committee_seat(p_user_id, cp.committee_id, now()) in ('SECRETARY', 'ALTERNATE_SECRETARY'),
                   false)
      and (authz.user_committee_seat(p_user_id, cp.committee_id, now()) = 'SECRETARY'
           or exists (select 1 from committee.meeting_acting_role a
                      where a.meeting_id = m.id and a.acting_role = 'ACTING_SECRETARY' and a.user_id = p_user_id))
      and authz.user_case_gate(p_user_id, m.case_id)
      and not exists (select 1 from committee.meeting_participant mp
                      where mp.meeting_id = m.id and mp.user_id = p_user_id and mp.coi_status = 'CONFLICT_DECLARED')
  );
$$;

-- Running the meeting, for the current user: the rule above. One rule serves the commands, the views and the notices.
create or replace function authz.can_manage_meeting(p_meeting_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select committee.manages_meeting(p_meeting_id, authz.current_user_id());
$$;

-- A committee proceeding, as in 1870, except that a snapshotted member sees it only while still seated on the
-- committee (AMB-039: from the end date, no packets, meetings or votes of the proceeding).
create or replace function authz.can_view_committee_proceeding(p_committee_proceeding_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from committee.committee_proceeding cp
    where cp.id = p_committee_proceeding_id
      and ((authz.user_case_gate(authz.current_user_id(), cp.case_id)
            and (exists (select 1 from committee.proceeding_member pm
                         where pm.committee_proceeding_id = cp.id and pm.user_id = authz.current_user_id()
                           and not pm.case_gate_excluded
                           and authz.user_committee_seat(pm.user_id, cp.committee_id, now()) is not null)
                 or authz.is_committee_secretary(cp.committee_id)))
           or authz.can_view_case(cp.case_id))
  );
$$;

-- Deliberation, as in 1890, except that a member sees it only while still seated on the committee (AMB-039).
create or replace function authz.can_view_meeting_deliberation(p_meeting_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_manage_meeting(p_meeting_id) or exists (
    select 1 from committee.meeting m
    join committee.meeting_participant mp on mp.meeting_id = m.id
    where m.id = p_meeting_id and mp.participant_kind = 'MEMBER' and mp.user_id = authz.current_user_id()
      and mp.coi_status = 'NO_CONFLICT'
      and committee.member_seat_current(mp.id)
      and authz.user_case_gate(authz.current_user_id(), m.case_id)
  );
$$;

-- DEC-F04 (CON-006): the seat a given user decides a raised conflict as, or null. Under the CHAIR rule: the chair;
-- when no chair of the meeting is eligible (the raiser or the subject, conflicted, recorded absent or excused, no longer
-- seated, not cleared for the case, or none), the deputy chair if eligible; when neither is, the committee's
-- independent conflict authority in force (holding no seat on the committee and not in the meeting). Never the raiser,
-- never the subject, always cleared for the case. The SECRETARY rule (2000) is unchanged. Null when nobody qualifies.
-- Taking the user as an argument lets the notice engine ask about a candidate without changing the request identity
-- (AGENT-09 pack 3, R1). Internal: no application role may execute it.
create function committee.concern_decider_seat_for(p_concern_id uuid, p_user_id uuid)
returns text
language sql stable
set search_path = ''
as $$
  with k as (
    select c.meeting_id, c.raised_by, m.case_id, cp.committee_id, t.user_id as subject_user,
           coalesce(cp.rule_snapshot ->> 'conflict_decider', 'CHAIR') as decider
    from committee.meeting_conflict_concern c
    join committee.meeting m on m.id = c.meeting_id
    join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
    join committee.meeting_participant t on t.id = c.participant_id
    where c.id = p_concern_id
  ), eligible as (
    select mp.seat, mp.user_id
    from k join committee.meeting_participant mp on mp.meeting_id = k.meeting_id
    where mp.participant_kind = 'MEMBER' and mp.seat in ('CHAIR', 'DEPUTY_CHAIR')
      and mp.coi_status = 'NO_CONFLICT' and mp.attendance not in ('ABSENT', 'EXCUSED', 'EXCUSED_CONFLICT')
      and mp.user_id <> k.raised_by and mp.user_id is distinct from k.subject_user
      and committee.member_seat_current(mp.id)
      and authz.user_case_gate(mp.user_id, k.case_id)
  )
  select case
           when k.decider = 'SECRETARY' then
             case when committee.manages_meeting(k.meeting_id, p_user_id) then 'SECRETARY' end
           when exists (select 1 from eligible e where e.seat = 'CHAIR') then
             case when exists (select 1 from eligible e where e.seat = 'CHAIR' and e.user_id = p_user_id)
                  then 'CHAIR' end
           when exists (select 1 from eligible e where e.seat = 'DEPUTY_CHAIR') then
             case when exists (select 1 from eligible e where e.seat = 'DEPUTY_CHAIR' and e.user_id = p_user_id)
                  then 'DEPUTY_CHAIR' end
           when exists (select 1 from committee.conflict_authority a
                        where a.committee_id = k.committee_id and a.user_id = p_user_id
                          and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
                          and authz.user_committee_seat(a.user_id, k.committee_id, now()) is null
                          and not exists (select 1 from committee.meeting_participant mp
                                          where mp.meeting_id = k.meeting_id and mp.user_id = a.user_id)) then
             'CONFLICT_AUTHORITY'
         end
  from k
  where p_user_id is not null
    and p_user_id <> k.raised_by
    and p_user_id is distinct from k.subject_user
    and authz.user_case_gate(p_user_id, k.case_id);
$$;

-- The seat the current user decides a raised conflict as: the rule above, for the commands, the views and the notices.
create or replace function authz.meeting_concern_decider_seat(p_concern_id uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select committee.concern_decider_seat_for(p_concern_id, authz.current_user_id());
$$;

-- -----------------------------------------------------------------------------
-- 2.7 RLS (SELECT only; no write grants; vote revisions and notes have no grant at all)
-- -----------------------------------------------------------------------------
alter table committee.invitee_type_rule enable row level security;
alter table committee.meeting_acting_role enable row level security;
alter table committee.conflict_authority enable row level security;
alter table committee.proceeding_snapshot_amendment enable row level security;
alter table committee.vote_revision enable row level security;
alter table committee.vote_note enable row level security;
alter table committee.minutes_objection_ruling enable row level security;
alter table committee.confidentiality_ack enable row level security;
alter table committee.meeting_accommodation enable row level security;

create policy invitee_type_rule_read on committee.invitee_type_rule for select to authenticated
  using (authz.current_user_id() is not null);
grant select on committee.invitee_type_rule to authenticated;

create policy meeting_acting_role_read on committee.meeting_acting_role for select to authenticated
  using (authz.can_view_meeting_deliberation(meeting_id)
         or (user_id = authz.current_user_id() and authz.can_view_meeting(meeting_id)));
grant select on committee.meeting_acting_role to authenticated;

create policy conflict_authority_read on committee.conflict_authority for select to authenticated
  using (authz.can_view_committee_registry(committee_id) or user_id = authz.current_user_id());
grant select on committee.conflict_authority to authenticated;

create policy proceeding_snapshot_amendment_read on committee.proceeding_snapshot_amendment for select to authenticated
  using (authz.can_view_committee_proceeding(committee_proceeding_id));
grant select on committee.proceeding_snapshot_amendment to authenticated;

create policy minutes_objection_ruling_read on committee.minutes_objection_ruling for select to authenticated
  using (exists (select 1 from committee.minutes mi
                 where mi.id = minutes_id and authz.can_view_meeting_deliberation(mi.meeting_id)));
grant select on committee.minutes_objection_ruling to authenticated;

create policy confidentiality_ack_read on committee.confidentiality_ack for select to authenticated
  using (authz.can_manage_meeting(meeting_id)
         or exists (select 1 from committee.meeting_participant mp
                    where mp.id = participant_id and mp.user_id = authz.current_user_id()
                      and authz.can_view_meeting(mp.meeting_id)));
grant select on committee.confidentiality_ack to authenticated;

create policy meeting_accommodation_read on committee.meeting_accommodation for select to authenticated
  using (authz.can_manage_meeting(meeting_id)
         or exists (select 1 from committee.meeting_participant mp
                    where mp.id = participant_id and mp.user_id = authz.current_user_id()
                      and authz.can_view_meeting(mp.meeting_id)));
grant select on committee.meeting_accommodation to authenticated;

-- -----------------------------------------------------------------------------
-- 2.8 Acting roles and alternates (DEC-F03, AMB-040/041/042/050/066/088, CON-007)
-- -----------------------------------------------------------------------------
-- The secretary running the meeting activates the deputy chair when the chair is conflicted, ineligible, recorded
-- absent or excused, or the seat is vacant. The basis is derived from the record, never typed.
create function api.activate_acting_chair(p_meeting_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.meeting;
  v_chair committee.meeting_participant;
  v_deputy committee.meeting_participant;
  v_basis text;
  v_reason text;
  v_id uuid;
begin
  v_m := committee.lock_managed_meeting(p_meeting_id);
  if v_m.status not in ('SCHEDULED', 'OPEN') then perform api._fail('CONFLICT', 'MEETING_NOT_ACTIVE'); end if;
  if exists (select 1 from committee.vote_item vi where vi.meeting_id = v_m.id and vi.status <> 'CLOSED') then
    perform api._fail('CONFLICT', 'VOTE_IN_PROGRESS');
  end if;
  if exists (select 1 from committee.meeting_acting_role a where a.meeting_id = v_m.id and a.acting_role = 'ACTING_CHAIR') then
    perform api._fail('CONFLICT', 'ALREADY_ACTIVATED');
  end if;
  select * into v_chair from committee.meeting_participant mp
  where mp.meeting_id = v_m.id and mp.participant_kind = 'MEMBER' and mp.seat = 'CHAIR'
  order by mp.added_at, mp.id limit 1;
  v_basis := case
               when v_chair.id is null then 'VACANT'
               when v_chair.coi_status = 'CONFLICT_DECLARED' then 'CONFLICTED'
               when not committee.member_seat_current(v_chair.id)
                    or not authz.user_case_gate(v_chair.user_id, v_m.case_id) then 'INELIGIBLE'
               when v_chair.attendance in ('ABSENT', 'EXCUSED') then 'ABSENT'
             end;
  if v_basis is null then perform api._fail('CONFLICT', 'CHAIR_AVAILABLE'); end if;
  select * into v_deputy from committee.meeting_participant mp
  where mp.meeting_id = v_m.id and mp.participant_kind = 'MEMBER' and mp.seat = 'DEPUTY_CHAIR'
    and mp.coi_status = 'NO_CONFLICT' and mp.attendance not in ('ABSENT', 'EXCUSED', 'EXCUSED_CONFLICT')
    and committee.counts_as_voter(mp.id)
  order by mp.added_at, mp.id limit 1;
  if v_deputy.id is null then perform api._fail('CONFLICT', 'NO_ELIGIBLE_DEPUTY'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);

  insert into committee.meeting_acting_role (meeting_id, acting_role, user_id, participant_id, replaces_participant_id,
                                             basis, reason, activated_by, activated_as)
  values (v_m.id, 'ACTING_CHAIR', v_deputy.user_id, v_deputy.id, v_chair.id, v_basis, v_reason, v_actor, 'SECRETARY')
  returning id into v_id;
  -- The reason stays in the activation row; the ledger gets ids and the basis code.
  perform audit.record_event('ACTING_CHAIR_ACTIVATED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_acting_role', v_id::text,
    null, jsonb_build_object('meeting_id', v_m.id, 'participant_id', v_deputy.id, 'replaces_participant_id', v_chair.id,
                             'basis', v_basis));
  return v_id;
end;
$$;

-- The alternate secretary runs the meeting only once recorded as acting for it: by the meeting's chair or acting chair
-- when the secretary is absent, conflicted, ineligible or the seat is vacant, or by the secretary handing over. Without
-- an eligible alternate nobody can (the meeting cannot be opened or run: fail closed).
create function api.activate_acting_secretary(p_meeting_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.meeting;
  v_committee uuid;
  v_secretary uuid;
  v_sec_p committee.meeting_participant;
  v_alt uuid;
  v_alt_p uuid;
  v_as text;
  v_basis text;
  v_reason text;
  v_id uuid;
begin
  v_m := committee.lock_visible_meeting(p_meeting_id);
  select cp.committee_id into v_committee from committee.committee_proceeding cp where cp.id = v_m.committee_proceeding_id;
  select ms.user_id into v_secretary from committee.membership ms
  join iam.user_profile u on u.id = ms.user_id and u.status = 'ACTIVE'
  where ms.committee_id = v_committee and ms.seat = 'SECRETARY'
    and ms.effective_from <= now() and (ms.effective_to is null or ms.effective_to > now())
  order by ms.effective_from desc limit 1;
  if v_secretary = v_actor and authz.user_case_gate(v_actor, v_m.case_id) then
    v_as := 'SECRETARY';
  elsif committee.meeting_chair_as(v_m.id, v_actor) is not null then
    v_as := committee.meeting_chair_as(v_m.id, v_actor);
  else
    perform api._fail('FORBIDDEN');
  end if;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_m.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if v_m.status not in ('SCHEDULED', 'OPEN') then perform api._fail('CONFLICT', 'MEETING_NOT_ACTIVE'); end if;
  if exists (select 1 from committee.vote_item vi where vi.meeting_id = v_m.id and vi.status <> 'CLOSED') then
    perform api._fail('CONFLICT', 'VOTE_IN_PROGRESS');
  end if;
  if exists (select 1 from committee.meeting_acting_role a
             where a.meeting_id = v_m.id and a.acting_role = 'ACTING_SECRETARY') then
    perform api._fail('CONFLICT', 'ALREADY_ACTIVATED');
  end if;
  select * into v_sec_p from committee.meeting_participant mp where mp.meeting_id = v_m.id and mp.user_id = v_secretary;
  v_basis := case
               when v_secretary is null then 'VACANT'
               when v_sec_p.coi_status = 'CONFLICT_DECLARED' then 'CONFLICTED'
               when not authz.user_case_gate(v_secretary, v_m.case_id) then 'INELIGIBLE'
               when v_as = 'SECRETARY' then 'HANDOVER'
               else 'ABSENT'
             end;
  select ms.user_id into v_alt from committee.membership ms
  join iam.user_profile u on u.id = ms.user_id and u.status = 'ACTIVE'
  where ms.committee_id = v_committee and ms.seat = 'ALTERNATE_SECRETARY'
    and ms.effective_from <= now() and (ms.effective_to is null or ms.effective_to > now())
    and ms.user_id <> v_actor and authz.user_case_gate(ms.user_id, v_m.case_id)
    and not exists (select 1 from committee.meeting_participant mp
                    where mp.meeting_id = v_m.id and mp.user_id = ms.user_id and mp.coi_status = 'CONFLICT_DECLARED')
  order by ms.effective_from, ms.id limit 1;
  if v_alt is null then perform api._fail('CONFLICT', 'NO_ELIGIBLE_ALTERNATE'); end if;
  select mp.id into v_alt_p from committee.meeting_participant mp where mp.meeting_id = v_m.id and mp.user_id = v_alt;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);

  insert into committee.meeting_acting_role (meeting_id, acting_role, user_id, participant_id, replaces_participant_id,
                                             basis, reason, activated_by, activated_as)
  values (v_m.id, 'ACTING_SECRETARY', v_alt, v_alt_p, v_sec_p.id, v_basis, v_reason, v_actor, v_as)
  returning id into v_id;
  perform audit.record_event('ACTING_SECRETARY_ACTIVATED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_acting_role',
    v_id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'acting_user_id', v_alt, 'basis', v_basis, 'activated_as', v_as));
  return v_id;
end;
$$;

-- AMB-041, AMB-088: an alternate member votes in place of a named voting member who is conflicted, ineligible or
-- recorded absent or excused. Quorum counts seats: the replaced member stops counting and cannot be recorded present.
create function api.activate_alternate_member(p_alternate_participant_id uuid, p_replaces_participant_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_alt committee.meeting_participant;
  v_rep committee.meeting_participant;
  v_m committee.meeting;
  v_basis text;
  v_reason text;
  v_id uuid;
begin
  select * into v_alt from committee.meeting_participant mp where mp.id = p_alternate_participant_id;
  if v_alt.id is null or not authz.can_view_meeting(v_alt.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_m := committee.lock_managed_meeting(v_alt.meeting_id);
  if v_m.status <> 'OPEN' then perform api._fail('CONFLICT', 'MEETING_NOT_OPEN'); end if;
  if exists (select 1 from committee.vote_item vi where vi.meeting_id = v_m.id and vi.status <> 'CLOSED') then
    perform api._fail('CONFLICT', 'VOTE_IN_PROGRESS');
  end if;
  if v_alt.participant_kind <> 'MEMBER' or v_alt.seat <> 'ALTERNATE_MEMBER' then
    perform api._fail('INVALID', 'alternate_participant_id');
  end if;
  select * into v_rep from committee.meeting_participant mp
  where mp.id = p_replaces_participant_id and mp.meeting_id = v_m.id;
  if v_rep.id is null or v_rep.participant_kind <> 'MEMBER' or v_rep.seat <> 'MEMBER' or not v_rep.is_voting then
    perform api._fail('INVALID', 'replaces_participant_id');
  end if;
  if committee.is_activated_alternate(v_alt.id) then perform api._fail('CONFLICT', 'ALTERNATE_ALREADY_ACTIVE'); end if;
  if committee.is_replaced_member(v_rep.id) then perform api._fail('CONFLICT', 'ALREADY_REPLACED'); end if;
  if v_alt.coi_status <> 'NO_CONFLICT' then perform api._fail('CONFLICT', 'COI_NOT_CLEARED'); end if;
  if not committee.member_seat_current(v_alt.id) or not authz.user_case_gate(v_alt.user_id, v_m.case_id) then
    perform api._fail('CONFLICT', 'ALTERNATE_INELIGIBLE');
  end if;
  -- Grievance independence (Q45–Q46): never an alternate who voted in the case's Investigation Committee.
  if exists (select 1 from committee.committee_proceeding cp join committee.committee c on c.id = cp.committee_id
             where cp.id = v_m.committee_proceeding_id and c.kind = 'GRIEVANCE')
     and authz.participated_in_investigation_committee(v_alt.user_id, v_m.case_id) then
    perform api._fail('CONFLICT', 'FIREWALL_RESTRICTED');
  end if;
  v_basis := case
               when v_rep.coi_status = 'CONFLICT_DECLARED' then 'CONFLICTED'
               when not committee.member_seat_current(v_rep.id)
                    or not authz.user_case_gate(v_rep.user_id, v_m.case_id) then 'INELIGIBLE'
               when v_rep.attendance in ('ABSENT', 'EXCUSED') then 'ABSENT'
             end;
  if v_basis is null then perform api._fail('CONFLICT', 'MEMBER_AVAILABLE'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);

  insert into committee.meeting_acting_role (meeting_id, acting_role, user_id, participant_id, replaces_participant_id,
                                             basis, reason, activated_by, activated_as)
  values (v_m.id, 'ALTERNATE_MEMBER', v_alt.user_id, v_alt.id, v_rep.id, v_basis, v_reason, v_actor, 'SECRETARY')
  returning id into v_id;
  perform audit.record_event('ALTERNATE_MEMBER_ACTIVATED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_acting_role',
    v_id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'participant_id', v_alt.id, 'replaces_participant_id', v_rep.id,
                       'basis', v_basis));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2.9 The independent conflict authority (DEC-F04) and the snapshot amendment (AMB-038)
-- -----------------------------------------------------------------------------
create function api.appoint_conflict_authority(
  p_committee_id uuid, p_user_id uuid, p_effective_from timestamptz, p_effective_to timestamptz,
  p_appointment_reference text, p_source_status text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_range tstzrange;
  v_reason text;
  v_id uuid;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  perform committee.lock_committee(p_committee_id);
  if p_user_id is null or not exists (select 1 from iam.user_profile u where u.id = p_user_id and u.status = 'ACTIVE') then
    perform api._fail('INVALID', 'user_id');
  end if;
  if p_user_id = v_actor then perform api._fail('CONFLICT', 'SELF_APPOINTMENT'); end if;
  if p_effective_from is null then perform api._fail('INVALID', 'effective_from'); end if;
  if p_effective_to is not null and p_effective_to <= p_effective_from then perform api._fail('INVALID', 'effective_to'); end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  v_range := tstzrange(p_effective_from, p_effective_to, '[)');
  -- Independent: holds no seat on the committee during the period.
  if exists (select 1 from committee.membership m
             where m.committee_id = p_committee_id and m.user_id = p_user_id
               and tstzrange(m.effective_from, m.effective_to, '[)') && v_range) then
    perform api._fail('CONFLICT', 'AUTHORITY_NOT_INDEPENDENT');
  end if;
  -- One authority at a time per committee.
  if exists (select 1 from committee.conflict_authority a
             where a.committee_id = p_committee_id and tstzrange(a.effective_from, a.effective_to, '[)') && v_range) then
    perform api._fail('CONFLICT', 'AUTHORITY_OVERLAP');
  end if;

  insert into committee.conflict_authority (committee_id, user_id, effective_from, effective_to, appointment_reference,
                                            source_status, reason, appointed_by)
  values (p_committee_id, p_user_id, p_effective_from, p_effective_to,
          api._require_text(p_appointment_reference, 'appointment_reference', 3, 200), p_source_status, v_reason, v_actor)
  returning id into v_id;
  perform audit.record_event('CONFLICT_AUTHORITY_APPOINTED', 'ADMIN', 'SUCCESS', null, 'conflict_authority', v_id::text,
    v_reason, jsonb_build_object('committee_id', p_committee_id, 'user_id', p_user_id, 'effective_from', p_effective_from,
                                 'effective_to', p_effective_to, 'source_status', p_source_status));
  return v_id;
end;
$$;

create function api.end_conflict_authority(p_authority_id uuid, p_effective_to timestamptz, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_a committee.conflict_authority;
  v_reason text;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  select * into v_a from committee.conflict_authority a where a.id = p_authority_id;
  if v_a.id is null then perform api._fail('NOT_FOUND'); end if;
  perform committee.lock_committee(v_a.committee_id);
  if v_a.ended_at is not null then perform api._fail('CONFLICT', 'AUTHORITY_ENDED'); end if;
  if p_effective_to is null or p_effective_to <= v_a.effective_from
     or (v_a.effective_to is not null and p_effective_to > v_a.effective_to) then
    perform api._fail('INVALID', 'effective_to');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update committee.conflict_authority
     set effective_to = p_effective_to, ended_by = v_actor, ended_at = now(), end_reason = v_reason
   where id = v_a.id;
  perform audit.record_event('CONFLICT_AUTHORITY_ENDED', 'ADMIN', 'SUCCESS', null, 'conflict_authority', v_a.id::text,
    v_reason, jsonb_build_object('committee_id', v_a.committee_id, 'user_id', v_a.user_id, 'effective_to', p_effective_to));
end;
$$;

-- AMB-038: the committee's secretary adds a member appointed after the referral to an open proceeding, with a reason,
-- for later meetings. Only a member cleared for the case; on a grievance, an Investigation Committee voter of the case
-- sits non-voting (Q45–Q46). A restricted case needs its Restricted Case Authority's approval for this, which is not
-- built: refused (fail closed, DEC-F19).
create function api.amend_proceeding_snapshot(p_committee_proceeding_id uuid, p_membership_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_cp committee.committee_proceeding;
  v_kind text;
  v_ms committee.membership;
  v_voting_seat boolean;
  v_firewall boolean;
  v_reason text;
  v_pm uuid;
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
  if exists (select 1 from case_mgmt.case_record c where c.id = v_cp.case_id and c.is_restricted) then
    perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_REQUIRED');
  end if;
  select m.* into v_ms from committee.membership m
  join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
  where m.id = p_membership_id and m.committee_id = v_cp.committee_id
    and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now());
  if v_ms.id is null then perform api._fail('INVALID', 'membership_id'); end if;
  if exists (select 1 from committee.proceeding_member pm
             where pm.committee_proceeding_id = v_cp.id and pm.user_id = v_ms.user_id) then
    perform api._fail('CONFLICT', 'ALREADY_IN_SNAPSHOT');
  end if;
  if not authz.user_case_gate(v_ms.user_id, v_cp.case_id) then perform api._fail('CONFLICT', 'NOT_CLEARED_FOR_CASE'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  select c.kind into v_kind from committee.committee c where c.id = v_cp.committee_id;
  v_voting_seat := v_ms.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER');
  v_firewall := v_voting_seat and v_kind = 'GRIEVANCE'
                and authz.participated_in_investigation_committee(v_ms.user_id, v_cp.case_id);

  insert into committee.proceeding_member (committee_proceeding_id, user_id, membership_id, seat, is_voting,
                                           firewall_restricted, case_gate_excluded)
  values (v_cp.id, v_ms.user_id, v_ms.id, v_ms.seat, v_voting_seat and not v_firewall, v_firewall, false)
  returning id into v_pm;
  insert into committee.proceeding_snapshot_amendment (committee_proceeding_id, proceeding_member_id, membership_id, reason,
                                                       amended_by)
  values (v_cp.id, v_pm, v_ms.id, v_reason, v_actor);
  perform audit.record_event('PROCEEDING_SNAPSHOT_AMENDED', 'BUSINESS', 'SUCCESS', v_cp.case_id, 'committee_proceeding',
    v_cp.id::text, v_reason,
    jsonb_build_object('proceeding_member_id', v_pm, 'membership_id', v_ms.id, 'seat', v_ms.seat,
                       'is_voting', v_voting_seat and not v_firewall, 'firewall_restricted', v_firewall));
  return v_pm;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2.10 Scheduling and invitations (AMB-039, AMB-061, AMB-156, AMB-158)
-- -----------------------------------------------------------------------------
-- The 1890 scheduling body, shared by the ordinary and the emergency command. Members are copied only while still
-- seated (AMB-039); a notice shorter than the rule snapshot's minimum needs the emergency path (AMB-061).
create function committee.insert_meeting(
  p_committee_proceeding_id uuid, p_purpose text, p_mode text, p_location text, p_online_url text,
  p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_reason text, p_emergency_reason text
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_cp committee.committee_proceeding;
  v_m committee.meeting;
  v_reason text;
  v_emergency text;
  v_notice int;
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
  v_notice := (v_cp.rule_snapshot ->> 'minimum_notice_days')::int;
  if p_emergency_reason is not null then
    v_emergency := api._require_text(p_emergency_reason, 'emergency_reason', 10, 2000);
  elsif v_notice is not null and p_scheduled_start < now() + make_interval(days => v_notice) then
    perform api._fail('CONFLICT', 'NOTICE_TOO_SHORT');
  end if;

  insert into committee.meeting (committee_proceeding_id, case_id, sequence_no, purpose, mode, location, online_url,
                                 scheduled_start, scheduled_end, scheduled_by, is_emergency, emergency_reason,
                                 minimum_notice_days)
  values (v_cp.id, v_cp.case_id,
          (select coalesce(max(m.sequence_no), 0) + 1 from committee.meeting m where m.committee_proceeding_id = v_cp.id),
          p_purpose, p_mode, case when p_location is not null then api._require_text(p_location, 'location', 2, 200) end,
          p_online_url, p_scheduled_start, p_scheduled_end, v_actor, v_emergency is not null, v_emergency, v_notice)
  returning * into v_m;

  -- As in 1890 (DEC-61, AGENT-09 P1, Q45–Q46), and only members still seated on the committee (AMB-039).
  insert into committee.meeting_participant (meeting_id, participant_kind, proceeding_member_id, user_id, seat, is_voting,
                                             requires_coi, coi_status, added_by)
  select v_m.id, 'MEMBER', pm.id, pm.user_id, pm.seat, pm.is_voting, true, 'PENDING', v_actor
  from committee.proceeding_member pm
  join iam.user_profile u on u.id = pm.user_id and u.status = 'ACTIVE'
  where pm.committee_proceeding_id = v_cp.id and not pm.firewall_restricted and not pm.case_gate_excluded
    and authz.user_committee_seat(pm.user_id, v_cp.committee_id, now()) is not null
    and authz.user_case_gate(pm.user_id, v_cp.case_id);
  get diagnostics v_members = row_count;

  perform audit.record_event('MEETING_SCHEDULED', 'BUSINESS', 'SUCCESS', v_cp.case_id, 'meeting', v_m.id::text, v_reason,
    jsonb_build_object('committee_proceeding_id', v_cp.id, 'sequence_no', v_m.sequence_no, 'purpose', p_purpose,
                       'mode', p_mode, 'provider', 'MANUAL', 'members', v_members, 'emergency', v_emergency is not null,
                       'minimum_notice_days', v_notice));
  return v_m.id;
end;
$$;

create or replace function api.schedule_meeting(
  p_committee_proceeding_id uuid, p_purpose text, p_mode text, p_location text, p_online_url text,
  p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  return committee.insert_meeting(p_committee_proceeding_id, p_purpose, p_mode, p_location, p_online_url,
                                  p_scheduled_start, p_scheduled_end, p_reason, null);
end;
$$;

-- AMB-061: a meeting at shorter notice than the committee's minimum, with the emergency recorded and its reason.
create function api.schedule_emergency_meeting(
  p_committee_proceeding_id uuid, p_purpose text, p_mode text, p_location text, p_online_url text,
  p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_reason text, p_emergency_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_emergency_reason is null then perform api._fail('INVALID', 'emergency_reason'); end if;
  return committee.insert_meeting(p_committee_proceeding_id, p_purpose, p_mode, p_location, p_online_url,
                                  p_scheduled_start, p_scheduled_end, p_reason, p_emergency_reason);
end;
$$;

-- As in 1890, plus the INTERPRETER type when enabled (AMB-156, with a conflict declaration) and the confidentiality
-- acknowledgement fixed from committee.invitee_type_rule (AMB-158).
create or replace function api.invite_to_meeting(
  p_meeting_id uuid, p_invitee_role text, p_user_id uuid, p_person_id uuid, p_requires_coi boolean, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.meeting;
  v_rule committee.invitee_type_rule;
  v_reason text;
  v_firewalled boolean;
  v_id uuid;
begin
  v_m := committee.lock_managed_meeting(p_meeting_id);
  if v_m.status not in ('SCHEDULED', 'OPEN') then perform api._fail('CONFLICT', 'MEETING_NOT_ACTIVE'); end if;
  if p_invitee_role is null
     or p_invitee_role not in ('WITNESS', 'EXPERT', 'LEGAL', 'INFORMATION_PROVIDER', 'SUBJECT', 'INTERPRETER') then
    perform api._fail('INVALID', 'invitee_role');
  end if;
  select * into v_rule from committee.invitee_type_rule r where r.invitee_role = p_invitee_role;
  if not coalesce(v_rule.enabled, false) then perform api._fail('CONFLICT', 'INVITEE_TYPE_DISABLED'); end if;
  if (p_user_id is null) = (p_person_id is null) then perform api._fail('INVALID', 'invitee'); end if;
  if p_invitee_role = 'SUBJECT' and p_person_id is null then perform api._fail('INVALID', 'person_id'); end if;
  if p_invitee_role = 'LEGAL' and p_user_id is null then perform api._fail('INVALID', 'user_id'); end if;
  if p_requires_coi is null or (p_invitee_role = 'INTERPRETER' and not p_requires_coi) then
    perform api._fail('INVALID', 'requires_coi');
  end if;
  if p_user_id is not null and not authz.user_case_gate(p_user_id, v_m.case_id) then
    perform api._fail('INVALID', 'user_id');
  end if;
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
  select exists (select 1 from committee.proceeding_member pm
                 where pm.committee_proceeding_id = v_m.committee_proceeding_id and pm.user_id = p_user_id
                   and pm.firewall_restricted)
    into v_firewalled;
  if v_firewalled and p_invitee_role not in ('WITNESS', 'EXPERT', 'INFORMATION_PROVIDER') then
    perform api._fail('FORBIDDEN');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);

  insert into committee.meeting_participant (meeting_id, participant_kind, user_id, person_id, invitee_role,
                                             requires_coi, coi_status, added_by, confidentiality_ack_required)
  values (v_m.id, 'INVITEE', p_user_id, p_person_id, p_invitee_role, p_requires_coi,
          case when p_requires_coi then 'PENDING' else 'NOT_REQUIRED' end, v_actor, v_rule.confidentiality_ack_required)
  returning id into v_id;
  perform audit.record_event('MEETING_INVITEE_ADDED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_participant', v_id::text,
    v_reason, jsonb_build_object('meeting_id', v_m.id, 'invitee_role', p_invitee_role, 'requires_coi', p_requires_coi,
                                 'firewall_restricted', v_firewalled,
                                 'confidentiality_ack_required', v_rule.confidentiality_ack_required));
  return v_id;
end;
$$;

-- AMB-156/AMB-158: which invitee types exist and which acknowledge confidentiality (later invitations only).
create function api.set_invitee_type_rule(
  p_invitee_role text, p_enabled boolean, p_confidentiality_ack_required boolean, p_wording_reference text,
  p_source_status text, p_reason text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_old committee.invitee_type_rule;
  v_reason text;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  select * into v_old from committee.invitee_type_rule r where r.invitee_role = p_invitee_role for update;
  if v_old.invitee_role is null then perform api._fail('INVALID', 'invitee_role'); end if;
  if p_enabled is null then perform api._fail('INVALID', 'enabled'); end if;
  if p_confidentiality_ack_required is null then perform api._fail('INVALID', 'confidentiality_ack_required'); end if;
  if p_source_status is null or p_source_status not in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update committee.invitee_type_rule
     set enabled = p_enabled, confidentiality_ack_required = p_confidentiality_ack_required,
         wording_reference = case when p_wording_reference is not null
                                  then api._require_text(p_wording_reference, 'wording_reference', 3, 200) end,
         source_status = p_source_status, updated_by = v_actor, updated_at = now()
   where invitee_role = p_invitee_role;
  perform audit.record_event('INVITEE_TYPE_RULE_CHANGED', 'ADMIN', 'SUCCESS', null, 'invitee_type_rule', p_invitee_role,
    v_reason, jsonb_build_object('enabled', p_enabled, 'confidentiality_ack_required', p_confidentiality_ack_required,
                                 'previous_enabled', v_old.enabled,
                                 'previous_confidentiality_ack_required', v_old.confidentiality_ack_required,
                                 'wording_sourced', p_wording_reference is not null, 'source_status', p_source_status));
end;
$$;

-- AMB-158: the invitee acknowledges confidentiality (or the secretary records it for an invitee without an account).
create function api.acknowledge_meeting_confidentiality(p_participant_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p committee.meeting_participant;
  v_m committee.meeting;
  v_source text;
  v_id uuid;
begin
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id;
  if v_p.id is null or not authz.can_view_meeting(v_p.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_m := committee.lock_visible_meeting(v_p.meeting_id);
  if v_p.user_id = v_actor then
    v_source := 'SELF';
  elsif v_p.user_id is null and authz.can_manage_meeting(v_m.id) then
    v_source := 'SECRETARY';
  else
    perform api._fail('FORBIDDEN');
  end if;
  if v_m.status not in ('SCHEDULED', 'OPEN') then perform api._fail('CONFLICT', 'MEETING_NOT_ACTIVE'); end if;
  if not v_p.confidentiality_ack_required then perform api._fail('CONFLICT', 'ACK_NOT_REQUIRED'); end if;
  if exists (select 1 from committee.confidentiality_ack a where a.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'ALREADY_ACKNOWLEDGED');
  end if;
  insert into committee.confidentiality_ack (meeting_id, participant_id, acknowledged_by, source, wording_reference)
  values (v_m.id, v_p.id, v_actor, v_source,
          (select r.wording_reference from committee.invitee_type_rule r where r.invitee_role = v_p.invitee_role))
  returning id into v_id;
  perform audit.record_event('MEETING_CONFIDENTIALITY_ACKNOWLEDGED', 'BUSINESS', 'SUCCESS', v_m.case_id,
    'meeting_participant', v_p.id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'source', v_source, 'invitee_role', v_p.invitee_role));
  return v_id;
end;
$$;

-- AMB-157: an accommodation request, by the participant or the secretary running the meeting. The ledger records that
-- one exists, never the details.
create function api.record_meeting_accommodation(p_participant_id uuid, p_details text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p committee.meeting_participant;
  v_m committee.meeting;
  v_source text;
  v_id uuid;
begin
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id;
  if v_p.id is null or not authz.can_view_meeting(v_p.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_m := committee.lock_visible_meeting(v_p.meeting_id);
  if v_p.user_id = v_actor then
    v_source := 'SELF';
  elsif authz.can_manage_meeting(v_m.id) then
    v_source := 'SECRETARY';
  else
    perform api._fail('FORBIDDEN');
  end if;
  if v_m.status not in ('SCHEDULED', 'OPEN') then perform api._fail('CONFLICT', 'MEETING_NOT_ACTIVE'); end if;
  insert into committee.meeting_accommodation (meeting_id, participant_id, details, recorded_by, source)
  values (v_m.id, v_p.id, api._require_text(p_details, 'details', 5, 2000), v_actor, v_source)
  returning id into v_id;
  perform audit.record_event('MEETING_ACCOMMODATION_RECORDED', 'BUSINESS', 'SUCCESS', v_m.case_id,
    'meeting_accommodation', v_id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'participant_id', v_p.id, 'source', v_source));
  return v_id;
end;
$$;

-- As in 1890 (N4, Q44, AGENT-09 V1a), plus: a member replaced by an alternate or no longer seated is never recorded
-- present (AMB-039, AMB-041), and an invitee who must acknowledge confidentiality does so first (AMB-158).
create or replace function api.record_attendance(p_participant_id uuid, p_attendance text)
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
  -- 2010's trigger refuses this too; checked first so an excluded witness is told so, not asked to acknowledge.
  if exists (select 1 from committee.witness_exclusion x where x.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'WITNESS_EXCLUDED');
  end if;
  if p_attendance = 'PRESENT' and committee.is_replaced_member(v_p.id) then
    perform api._fail('CONFLICT', 'REPLACED_BY_ALTERNATE');
  end if;
  if p_attendance = 'PRESENT' and v_p.participant_kind = 'MEMBER' and not committee.member_seat_current(v_p.id) then
    perform api._fail('CONFLICT', 'SEAT_ENDED');
  end if;
  if p_attendance = 'PRESENT' and v_p.confidentiality_ack_required
     and not exists (select 1 from committee.confidentiality_ack a where a.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'CONFIDENTIALITY_ACK_REQUIRED');
  end if;

  update committee.meeting_participant
     set attendance = p_attendance, attendance_recorded_by = v_actor, attendance_recorded_at = now()
   where id = v_p.id;
  perform audit.record_event('ATTENDANCE_RECORDED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_participant', v_p.id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'from', v_p.attendance, 'to', p_attendance));
end;
$$;

-- -----------------------------------------------------------------------------
-- 2.11 Votes (DEC-F01, DEC-F03, AMB-039/041/067/077/081/082/083/088)
-- -----------------------------------------------------------------------------
-- AMB-067: no vote opens without quorum (every path: api.open_vote_item, package and grievance votes). Under a CUSTOM
-- quorum at least one counting member must be present; the secretary attests the rest at close.
create function committee.require_quorum_at_opening()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_q record;
begin
  select * into v_q from committee.quorum_state(new.meeting_id);
  if v_q.eligible = 0 or v_q.present = 0 or (v_q.required is not null and v_q.present < v_q.required) then
    perform api._fail('CONFLICT', 'NO_QUORUM');
  end if;
  return new;
end;
$$;
create trigger vote_item_quorum_at_opening before insert on committee.vote_item
  for each row execute function committee.require_quorum_at_opening();

-- N4/N5 as in 1890: a member votes only for themself, present, with a cleared declaration; now also an activated
-- alternate, never a replaced member, and only while still seated on the committee.
create or replace function api.cast_vote(p_vote_item_id uuid, p_choice text, p_reason text)
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
  if v_p.id is null or not (v_p.is_voting or committee.is_activated_alternate(v_p.id)) then perform api._fail('FORBIDDEN'); end if;
  if committee.is_replaced_member(v_p.id) then perform api._fail('CONFLICT', 'REPLACED_BY_ALTERNATE'); end if;
  if not committee.member_seat_current(v_p.id) then perform api._fail('CONFLICT', 'SEAT_ENDED'); end if;
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
  perform audit.record_event('VOTE_CAST', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id));
end;
$$;

-- AMB-081: a member changes their own vote while the item is OPEN, when the rule snapshot allows it (allowed by
-- default; not for proceedings snapshotted before 2030). Append-only; the last counts; as secret as the vote.
create function api.revise_vote(p_vote_item_id uuid, p_choice text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_p committee.meeting_participant;
  v_vote committee.vote;
  v_rule jsonb;
  v_no int;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  select * into v_p from committee.meeting_participant mp
  where mp.meeting_id = v_item.meeting_id and mp.user_id = v_actor and mp.participant_kind = 'MEMBER';
  if v_p.id is null or not (v_p.is_voting or committee.is_activated_alternate(v_p.id)) then perform api._fail('FORBIDDEN'); end if;
  if committee.is_replaced_member(v_p.id) then perform api._fail('CONFLICT', 'REPLACED_BY_ALTERNATE'); end if;
  if not committee.member_seat_current(v_p.id) then perform api._fail('CONFLICT', 'SEAT_ENDED'); end if;
  if v_p.coi_status <> 'NO_CONFLICT' then perform api._fail('CONFLICT', 'COI_NOT_CLEARED'); end if;
  if v_p.attendance <> 'PRESENT' then perform api._fail('CONFLICT', 'NOT_PRESENT'); end if;
  if v_item.status <> 'OPEN' then perform api._fail('CONFLICT', 'VOTE_NOT_OPEN'); end if;
  select cp.rule_snapshot into v_rule
  from committee.meeting m join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
  where m.id = v_item.meeting_id;
  if not coalesce((v_rule ->> 'vote_revision_allowed')::boolean, false) then
    perform api._fail('CONFLICT', 'VOTE_REVISION_NOT_ALLOWED');
  end if;
  if p_choice is null or p_choice not in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED') then perform api._fail('INVALID', 'choice'); end if;
  select * into v_vote from committee.vote v where v.vote_item_id = v_item.id and v.participant_id = v_p.id and v.source = 'SELF';
  if v_vote.id is null then perform api._fail('CONFLICT', 'NOT_VOTED'); end if;
  if committee.vote_choice(v_vote.id) = p_choice then perform api._fail('CONFLICT', 'VOTE_UNCHANGED'); end if;
  select coalesce(max(r.revision_no), 0) + 1 into v_no from committee.vote_revision r where r.vote_id = v_vote.id;
  insert into committee.vote_revision (vote_id, vote_item_id, revision_no, choice, reason)
  values (v_vote.id, v_item.id, v_no, p_choice,
          case when p_reason is not null then api._require_text(p_reason, 'reason', 5, 2000) end);
  -- Secrecy (Q61–Q63): the ledger records that a vote was revised, never the choice.
  perform audit.record_event('VOTE_REVISED', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id, 'revision_no', v_no));
end;
$$;

-- AMB-077: a member recusing because of a conflict declares it in the same step: the recusal is their vote on this
-- item, and the declaration removes them from presence, quorum and deliberation for the rest of the meeting.
create function api.recuse_for_conflict(p_vote_item_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_p committee.meeting_participant;
  v_reason text;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  select * into v_p from committee.meeting_participant mp
  where mp.meeting_id = v_item.meeting_id and mp.user_id = v_actor and mp.participant_kind = 'MEMBER' for update;
  if v_p.id is null or not (v_p.is_voting or committee.is_activated_alternate(v_p.id)) then perform api._fail('FORBIDDEN'); end if;
  if v_p.coi_status <> 'NO_CONFLICT' then perform api._fail('CONFLICT', 'COI_NOT_CLEARED'); end if;
  if v_p.attendance <> 'PRESENT' then perform api._fail('CONFLICT', 'NOT_PRESENT'); end if;
  if v_item.status <> 'OPEN' then perform api._fail('CONFLICT', 'VOTE_NOT_OPEN'); end if;
  -- A member who already voted declares the conflict instead (api.declare_meeting_conflict); the vote then stops counting.
  if exists (select 1 from committee.vote v where v.vote_item_id = v_item.id and v.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'ALREADY_VOTED');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  insert into committee.vote (vote_item_id, participant_id, recorded_for, recorded_by, source, choice, reason, original_event_at)
  values (v_item.id, v_p.id, v_actor, v_actor, 'SELF', 'RECUSED', null, now());
  insert into committee.meeting_conflict (meeting_id, participant_id, status, declared_by, source, reason)
  values (v_item.meeting_id, v_p.id, 'CONFLICT_DECLARED', v_actor, 'SELF', v_reason);
  update committee.meeting_participant
     set coi_status = 'CONFLICT_DECLARED', coi_declared_at = now(), attendance = 'EXCUSED_CONFLICT'
   where id = v_p.id;
  perform audit.record_event('VOTE_CAST', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id));
  perform audit.record_event('COI_DECLARED', 'BUSINESS', 'SUCCESS', v_item.case_id, 'meeting_participant', v_p.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id, 'status', 'CONFLICT_DECLARED', 'source', 'SELF',
                       'participant_kind', v_p.participant_kind));
end;
$$;

-- AMB-082: a member's note on their own vote while the meeting is open, once per item; annexed to the minutes only
-- when the member asks.
create function api.record_vote_note(p_vote_item_id uuid, p_note text, p_annex_to_minutes boolean)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_p committee.meeting_participant;
  v_rule jsonb;
  v_id uuid;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  select * into v_p from committee.meeting_participant mp
  where mp.meeting_id = v_item.meeting_id and mp.user_id = v_actor and mp.participant_kind = 'MEMBER';
  if v_p.id is null or not exists (select 1 from committee.vote v
                                   where v.vote_item_id = v_item.id and v.participant_id = v_p.id and v.source = 'SELF') then
    perform api._fail('FORBIDDEN');
  end if;
  select cp.rule_snapshot into v_rule
  from committee.meeting m join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
  where m.id = v_item.meeting_id;
  if not coalesce((v_rule ->> 'dissent_note_allowed')::boolean, false) then
    perform api._fail('CONFLICT', 'VOTE_NOTE_NOT_ALLOWED');
  end if;
  if p_annex_to_minutes is null then perform api._fail('INVALID', 'annex_to_minutes'); end if;
  if exists (select 1 from committee.vote_note n where n.vote_item_id = v_item.id and n.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'VOTE_NOTE_EXISTS');
  end if;
  insert into committee.vote_note (vote_item_id, participant_id, note, annex_to_minutes)
  values (v_item.id, v_p.id, api._require_text(p_note, 'note', 10, 4000), p_annex_to_minutes)
  returning id into v_id;
  perform audit.record_event('VOTE_NOTE_RECORDED', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id, 'annex_to_minutes', p_annex_to_minutes));
  return v_id;
end;
$$;

-- N6 as in 1890; the member must hold a counting voting seat (an activated alternate, never a replaced member).
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
  insert into committee.vote (vote_item_id, participant_id, recorded_for, recorded_by, source, choice, reason, original_event_at)
  values (v_item.id, v_p.id, v_p.user_id, v_actor, 'SECRETARY', p_choice, api._require_text(p_reason, 'reason', 5, 2000),
          coalesce(p_original_event_at, now()));
  perform audit.record_event('VOTE_RECORDED_FOR_MEMBER', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id, 'participant_id', v_p.id));
end;
$$;

-- As in 1890 (DEC-F01: quorum first, then APPROVE > REJECT; abstentions, absences, recusals and inability count
-- neither way), with counting seats (AMB-039/041/088), the last revision of each vote (AMB-081) and the DEC-F03
-- casting voter.
create or replace function api.close_vote_item(p_vote_item_id uuid, p_custom_quorum_attested boolean)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_rule jsonb;
  v_q record;
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
  select * into v_q from committee.quorum_state(v_item.meeting_id);

  if v_q.quorum_type = 'CUSTOM' then
    if p_custom_quorum_attested is not true then perform api._fail('INVALID', 'custom_quorum_attested'); end if;
    v_required := null;
  else
    if p_custom_quorum_attested is true then perform api._fail('INVALID', 'custom_quorum_attested'); end if;
    v_required := v_q.required;
  end if;

  if exists (select 1 from committee.meeting_participant mp
             where mp.meeting_id = v_item.meeting_id and mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT'
               and committee.counts_as_voter(mp.id)
               and not exists (select 1 from committee.vote v where v.vote_item_id = v_item.id and v.participant_id = mp.id)) then
    perform api._fail('CONFLICT', 'VOTES_OUTSTANDING');
  end if;

  select count(*) filter (where counted and v.choice = 'APPROVE') as approve,
         count(*) filter (where counted and v.choice = 'REJECT') as reject,
         count(*) filter (where counted and v.choice = 'ABSTAIN') as abstain,
         count(*) filter (where counted and v.choice = 'RECUSED') as recused,
         count(*) filter (where v.choice = 'ABSENT') as absent,
         count(*) filter (where v.choice = 'UNABLE_TO_VOTE') as unable,
         count(*) filter (where not counted and v.choice in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED')) as excluded
    into v_counts
  from (select committee.vote_choice(v.id) as choice,
               (mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT' and committee.counts_as_voter(mp.id)) as counted
        from committee.vote v join committee.meeting_participant mp on mp.id = v.participant_id
        where v.vote_item_id = v_item.id) v;

  v_chair_ready := committee.casting_voter(v_item.id) is not null;
  v_status := 'CLOSED';
  if v_q.eligible = 0 or (v_required is not null and v_q.present < v_required) or (v_required is null and v_q.present = 0) then
    v_result := 'NO_QUORUM';
  elsif v_counts.approve > v_counts.reject then
    v_result := 'APPROVED';
  elsif v_counts.reject > v_counts.approve then
    v_result := 'REJECTED';
  elsif v_counts.approve = 0 then
    v_result := coalesce(v_rule ->> 'no_substantive_vote_outcome', 'NO_DECISION');
  elsif coalesce((v_rule ->> 'casting_vote_enabled')::boolean, false) and v_chair_ready then
    v_status := 'AWAITING_CASTING_VOTE';
    v_result := null;
  else
    v_result := 'TIED';
  end if;

  update committee.vote_item
     set status = v_status, result = v_result, eligible_count = v_q.eligible, present_count = v_q.present,
         quorum_required = v_required, custom_quorum_attested = coalesce(p_custom_quorum_attested, false),
         approve_count = v_counts.approve, reject_count = v_counts.reject, abstain_count = v_counts.abstain,
         recused_count = v_counts.recused, absent_count = v_counts.absent, unable_count = v_counts.unable,
         excluded_count = v_counts.excluded, tallied_by = v_actor, tallied_at = now(),
         closed_at = case when v_status = 'CLOSED' then now() end
   where id = v_item.id;
  perform audit.record_event('VOTE_CLOSED', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id, 'status', v_status, 'result', v_result, 'eligible', v_q.eligible,
                       'present', v_q.present, 'quorum_required', v_required, 'quorum_type', v_q.quorum_type,
                       'custom_quorum_attested', coalesce(p_custom_quorum_attested, false),
                       'decision_rule', coalesce(v_rule ->> 'decision_rule', 'SIMPLE_MAJORITY_SUBSTANTIVE'),
                       'approve', v_counts.approve, 'reject', v_counts.reject, 'abstain', v_counts.abstain,
                       'recused', v_counts.recused, 'absent', v_counts.absent, 'unable', v_counts.unable,
                       'excluded', v_counts.excluded));
  return coalesce(v_result, v_status);
end;
$$;

-- DEC-F03: only the casting voter of the item (the chair, or an activated acting chair when the rule grants it), on a
-- tie the rule lets them break. Never the secretary.
create or replace function api.cast_casting_vote(p_vote_item_id uuid, p_choice text, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_caster committee.meeting_participant;
  v_result text;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  select * into v_caster from committee.meeting_participant mp where mp.id = committee.casting_voter(v_item.id);
  if v_caster.id is null or v_caster.user_id <> v_actor then perform api._fail('FORBIDDEN'); end if;
  if v_item.status <> 'AWAITING_CASTING_VOTE' then perform api._fail('CONFLICT', 'NOT_A_TIE'); end if;
  if p_choice is null or p_choice not in ('APPROVE', 'REJECT') then perform api._fail('INVALID', 'choice'); end if;
  v_result := case p_choice when 'APPROVE' then 'APPROVED' else 'REJECTED' end;
  insert into committee.casting_vote (vote_item_id, cast_by, choice, reason)
  values (v_item.id, v_actor, p_choice, case when p_reason is not null then api._require_text(p_reason, 'reason', 5, 2000) end);
  update committee.vote_item
     set status = 'CLOSED', result = v_result, decided_by_casting_vote = true, closed_at = now()
   where id = v_item.id;
  perform audit.record_event('CASTING_VOTE_CAST', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id, 'result', v_result,
                       'cast_as', case v_caster.seat when 'CHAIR' then 'CHAIR' else 'ACTING_CHAIR' end));
  return v_result;
end;
$$;

-- Q61–Q62 as in 1890: while open, who has voted and when; after close, totals, and choices and notes unless the rule
-- snapshot keeps a secret ballot (AMB-083). Choices are the last revision (AMB-081).
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

-- -----------------------------------------------------------------------------
-- 2.12 Minutes (AMB-082, AMB-092, AMB-094)
-- -----------------------------------------------------------------------------
-- As in 1890; the snapshot also records the acting roles (without reasons) and the vote notes their authors asked to
-- annex. The review deadline uses the business calendar (DEC-F02).
create or replace function api.generate_minutes(p_meeting_id uuid, p_narrative text)
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

  v_snapshot := jsonb_build_object(
    'meeting', jsonb_build_object('id', v_m.id, 'sequence_no', v_m.sequence_no, 'purpose', v_m.purpose, 'mode', v_m.mode,
                                  'opened_at', v_m.opened_at, 'closed_at', v_m.closed_at, 'is_emergency', v_m.is_emergency),
    'participants', coalesce((select jsonb_agg(jsonb_build_object(
                       'participant_id', mp.id, 'kind', mp.participant_kind, 'user_id', mp.user_id, 'person_id', mp.person_id,
                       'seat', mp.seat, 'invitee_role', mp.invitee_role, 'is_voting', mp.is_voting,
                       'coi_status', mp.coi_status, 'attendance', mp.attendance) order by mp.added_at, mp.id)
                     from committee.meeting_participant mp where mp.meeting_id = v_m.id), '[]'::jsonb),
    'acting_roles', coalesce((select jsonb_agg(jsonb_build_object(
                       'acting_role', a.acting_role, 'participant_id', a.participant_id, 'user_id', a.user_id,
                       'replaces_participant_id', a.replaces_participant_id, 'basis', a.basis)
                       order by a.activated_at, a.id)
                     from committee.meeting_acting_role a where a.meeting_id = v_m.id), '[]'::jsonb),
    'vote_items', coalesce((select jsonb_agg(jsonb_build_object(
                     'vote_item_id', vi.id, 'sequence_no', vi.sequence_no, 'target_type', vi.target_type,
                     'finding_id', vi.finding_id, 'title', vi.title, 'result', vi.result,
                     'decided_by_casting_vote', vi.decided_by_casting_vote, 'eligible', vi.eligible_count,
                     'present', vi.present_count, 'quorum_required', vi.quorum_required, 'approve', vi.approve_count,
                     'reject', vi.reject_count, 'abstain', vi.abstain_count, 'recused', vi.recused_count,
                     'absent', vi.absent_count, 'unable', vi.unable_count, 'excluded', vi.excluded_count) order by vi.sequence_no)
                   from committee.vote_item vi where vi.meeting_id = v_m.id), '[]'::jsonb),
    -- Under a secret ballot the annexed note does not name its member (AMB-083), as in api.vote_item_status.
    'annexed_notes', coalesce((select jsonb_agg(jsonb_build_object(
                       'vote_item_id', n.vote_item_id,
                       'participant_id', case when coalesce(v_rule ->> 'ballot_secrecy', 'COMMITTEE_AFTER_CLOSE')
                                                   <> 'SECRET_BALLOT' then n.participant_id end,
                       'note', n.note)
                       order by vi.sequence_no, n.recorded_at, n.id)
                     from committee.vote_note n join committee.vote_item vi on vi.id = n.vote_item_id
                     where vi.meeting_id = v_m.id and n.annex_to_minutes), '[]'::jsonb));
  select count(*) into v_reviewers from committee.meeting_participant mp
  where mp.meeting_id = v_m.id and committee.minutes_reviewer(v_m.id, mp.user_id);
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

-- AMB-092: the chair (or the activated acting chair) overrules an objection to draft minutes, with a reason; the
-- version returns to review and may then be approved or deemed approved. Never by someone who objected to it.
create function api.overrule_minutes_objection(p_minutes_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_mi committee.minutes;
  v_as text;
  v_reason text;
  v_id uuid;
begin
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id;
  if v_mi.id is null or not authz.can_view_meeting_deliberation(v_mi.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id for update;
  v_as := committee.meeting_chair_as(v_mi.meeting_id, v_actor);
  if v_as is null then perform api._fail('FORBIDDEN'); end if;
  if v_mi.status <> 'CHANGES_REQUESTED' then perform api._fail('CONFLICT', 'NO_OBJECTION'); end if;
  if exists (select 1 from committee.minutes_review r
             where r.minutes_id = v_mi.id and r.reviewer_id = v_actor and r.decision = 'REQUEST_CHANGES') then
    perform api._fail('CONFLICT', 'OWN_OBJECTION');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  insert into committee.minutes_objection_ruling (minutes_id, ruled_by, ruled_as, reason)
  values (v_mi.id, v_actor, v_as, v_reason)
  returning id into v_id;
  update committee.minutes set status = 'IN_REVIEW' where id = v_mi.id;
  perform audit.record_event('MINUTES_OBJECTION_OVERRULED', 'BUSINESS', 'SUCCESS', v_mi.case_id, 'minutes', v_mi.id::text,
    null, jsonb_build_object('meeting_id', v_mi.meeting_id, 'ruling_id', v_id, 'ruled_as', v_as));
end;
$$;

-- As in 1890; an objection (changes requested) blocks deemed approval unless the rule snapshot says it does not
-- (AMB-092, blocking by default and for proceedings snapshotted before 2030).
create or replace function api.apply_minutes_deemed_approval(p_minutes_id uuid)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_mi committee.minutes;
  v_blocks boolean;
begin
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id;
  if v_mi.id is null or not authz.can_view_meeting_deliberation(v_mi.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_manage_meeting(v_mi.meeting_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id for update;
  if v_mi.status in ('APPROVED', 'DEEMED_APPROVED') then return v_mi.status; end if;
  select coalesce((cp.rule_snapshot ->> 'minutes_objection_blocks_deemed')::boolean, true) into v_blocks
  from committee.meeting m join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
  where m.id = v_mi.meeting_id;
  if v_mi.status = 'CHANGES_REQUESTED' and v_blocks then perform api._fail('CONFLICT', 'OBJECTION_OPEN'); end if;
  if v_mi.status not in ('IN_REVIEW', 'CHANGES_REQUESTED') then perform api._fail('CONFLICT', 'MINUTES_NOT_IN_REVIEW'); end if;
  if not v_mi.deemed_approval_enabled then perform api._fail('CONFLICT', 'DEEMED_APPROVAL_DISABLED'); end if;
  if v_mi.reminder_sent_at is null then perform api._fail('CONFLICT', 'REMINDER_NOT_SENT'); end if;
  if now() < v_mi.review_due_at then perform api._fail('CONFLICT', 'REVIEW_WINDOW_OPEN'); end if;
  update committee.minutes set status = 'DEEMED_APPROVED', finalised_at = now() where id = v_mi.id;
  perform audit.record_event('MINUTES_DEEMED_APPROVED', 'BUSINESS', 'SUCCESS', v_mi.case_id, 'minutes', v_mi.id::text, null,
    jsonb_build_object('meeting_id', v_mi.meeting_id, 'review_due_at', v_mi.review_due_at,
                       'reviews', (select count(*) from committee.minutes_review r where r.minutes_id = v_mi.id),
                       'reviewer_count', v_mi.reviewer_count, 'over_objection', v_mi.status = 'CHANGES_REQUESTED'));
  return 'DEEMED_APPROVED';
end;
$$;

-- -----------------------------------------------------------------------------
-- 2.13 Raised conflicts (DEC-F04) and the cancellation notice (DEC-F07)
-- -----------------------------------------------------------------------------
-- The conflict an upheld concern writes names that concern (DEC-AMB-010, AGENT-09 early-look note a), so that reversing
-- one concern clears only the conflict that rests on it (committee.conflict_counts, 2.14). The pair (concern,
-- participant) must match. Rows written before 2030 carry no concern and keep counting (fail closed).
alter table committee.meeting_conflict_concern
  add constraint meeting_conflict_concern_id_participant unique (id, participant_id);
alter table committee.meeting_conflict add column concern_id uuid;
alter table committee.meeting_conflict add constraint meeting_conflict_concern_fk
  foreign key (concern_id, participant_id) references committee.meeting_conflict_concern (id, participant_id);
alter table committee.meeting_conflict add constraint meeting_conflict_concern_only_decision
  check (concern_id is null or source = 'DECISION');
alter table committee.meeting_conflict add constraint meeting_conflict_decision_names_concern
  check (source <> 'DECISION' or concern_id is not null) not valid;
create index meeting_conflict_concern_ref on committee.meeting_conflict (concern_id);
comment on column committee.meeting_conflict.concern_id is
  'For source DECISION: the upheld concern this conflict rests on (migration 2030, DEC-AMB-010). Null otherwise, and on '
  'DECISION rows written before 2030.';

-- As in 2000, except that the meeting is locked directly (the independent conflict authority decides without seeing
-- the meeting itself) and the conflict an upheld concern writes names that concern. Visibility is the concern's
-- (raiser, secretary running the meeting, decider; never the subject).
create or replace function api.decide_meeting_conflict(p_concern_id uuid, p_decision text, p_reason text)
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
  if v_c.id is null or not authz.can_view_meeting_concern(v_c.id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_m from committee.meeting m where m.id = v_c.meeting_id for update;
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

  if p_decision = 'UPHELD' then
    select * into v_p from committee.meeting_participant mp where mp.id = v_c.participant_id for update;
    if v_p.coi_status <> 'CONFLICT_DECLARED' then
      insert into committee.meeting_conflict (meeting_id, participant_id, status, declared_by, source, reason, concern_id)
      values (v_m.id, v_p.id, 'CONFLICT_DECLARED', v_actor, 'DECISION', v_reason, v_c.id);
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

-- DEC-F07: as in 1920 (AGENT-09 N2), and an excluded witness no longer receives the meeting's cancellation.
create or replace function notify.on_meeting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if new.status = 'CANCELLED' and old.status <> 'CANCELLED' then
    for v_user in select distinct mp.user_id from committee.meeting_participant mp
                  where mp.meeting_id = new.id and mp.user_id is not null
                    and authz.user_case_gate(mp.user_id, new.case_id)
                    and not authz.has_meeting_conflict(mp.user_id, new.committee_proceeding_id)
                    and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id) loop
      perform notify.enqueue('MEETING_CANCELLED', v_user, new.id, notify.meeting_committee(new.id),
                             'meeting-cancelled:' || new.id);
    end loop;
  end if;
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2.14 An upheld conflict holds for the proceeding, and its reversal (DEC-F38, DEC-AMB-010, AMB-055)
-- -----------------------------------------------------------------------------
-- DEC-F38 is as built: a conflict declared or upheld in one meeting of a proceeding bars a "no conflict" declaration
-- in its later meetings (1890, PRIOR_CONFLICT_DECLARED) and hides its recommendation work (1900). DEC-AMB-010 (owner, 2026-10-13, option B): the next eligible decider in the DEC-F04 hierarchy
-- may reverse an upheld determination, with a reason and audit. The reversal is prospective: the member may declare
-- again in later meetings and is no longer treated as conflicted for the proceeding's later work; the meeting in which
-- the conflict was upheld keeps the member conflicted (no retroactive validation of participation).
create table committee.meeting_conflict_reversal (
  id          uuid primary key default gen_random_uuid(),
  concern_id  uuid not null unique references committee.meeting_conflict_concern (id),
  reversed_by uuid not null references iam.user_profile (id),
  reversed_as text not null check (reversed_as in ('CHAIR', 'DEPUTY_CHAIR', 'CONFLICT_AUTHORITY')),
  reason      text not null check (length(reason) between 10 and 2000),
  reversed_at timestamptz not null default clock_timestamp()
);
create index meeting_conflict_reversal_by on committee.meeting_conflict_reversal (reversed_by);
comment on table committee.meeting_conflict_reversal is
  'DEC-AMB-010 (migration 2030): the reversal of an upheld meeting conflict by the next eligible decider in the '
  'DEC-F04 hierarchy. Prospective only. Append-only; read as the concern is read (never by its subject).';
create trigger no_update before update on committee.meeting_conflict_reversal
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on committee.meeting_conflict_reversal
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on committee.meeting_conflict_reversal
  for each statement execute function committee.reject_mutation();

-- Whether a participant's declared conflict still counts for the proceeding (DEC-AMB-010). It counts unless every
-- conflict row behind it is a DECISION row whose own upheld concern has since been reversed. Because each DECISION row
-- names its concern (2.13), reversing one concern never clears a conflict the participant declared, one the secretary
-- recorded for them, or one upheld on another concern. A DECISION row without a concern (written before 2030), and a
-- conflicted status with no row behind it, always count (fail closed).
create function committee.conflict_counts(p_participant_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from committee.meeting_participant mp
    where mp.id = p_participant_id and mp.coi_status = 'CONFLICT_DECLARED'
      and (not exists (select 1 from committee.meeting_conflict mc
                       where mc.participant_id = mp.id and mc.status = 'CONFLICT_DECLARED')
           or exists (select 1 from committee.meeting_conflict mc
                      where mc.participant_id = mp.id and mc.status = 'CONFLICT_DECLARED'
                        and not (mc.source = 'DECISION'
                                 and exists (select 1 from committee.meeting_conflict_reversal r
                                             where r.concern_id = mc.concern_id)))));
$$;

-- The seat the user reverses an upheld concern as, or null: the first level after the original decider's (SECRETARY,
-- CHAIR, DEPUTY_CHAIR, CONFLICT_AUTHORITY) at which someone is eligible now, and only if the user is that someone.
-- Eligible: holds the seat on the committee now (or is its authority in force, holding no seat), active, cleared for
-- the case, not conflicted in the proceeding, and neither the raiser, the subject nor the original decider. When no
-- level after the original decider has anyone, nobody reverses (fail closed).
create function committee.concern_reverser_seat(p_concern_id uuid, p_user_id uuid)
returns text
language sql stable
set search_path = ''
as $$
  with k as (
    select c.id, c.raised_by, c.decided_by, t.user_id as subject_user, m.case_id, m.committee_proceeding_id, cp.committee_id,
           array_position(array['SECRETARY', 'CHAIR', 'DEPUTY_CHAIR', 'CONFLICT_AUTHORITY'], c.decided_as) as decided_ord
    from committee.meeting_conflict_concern c
    join committee.meeting_participant t on t.id = c.participant_id
    join committee.meeting m on m.id = c.meeting_id
    join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
    where c.id = p_concern_id and c.status = 'UPHELD'
  ), candidate as (
    select s.seat as level, array_position(array['SECRETARY', 'CHAIR', 'DEPUTY_CHAIR', 'CONFLICT_AUTHORITY'], s.seat) as ord,
           s.user_id
    from k join committee.membership s on s.committee_id = k.committee_id
    where s.seat in ('CHAIR', 'DEPUTY_CHAIR') and s.effective_from <= now() and (s.effective_to is null or s.effective_to > now())
    union all
    select 'CONFLICT_AUTHORITY', 4, a.user_id
    from k join committee.conflict_authority a on a.committee_id = k.committee_id
    where a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
      and authz.user_committee_seat(a.user_id, k.committee_id, now()) is null
  ), eligible as (
    select c.level, c.ord, c.user_id
    from candidate c cross join k
    where c.ord > k.decided_ord
      and c.user_id <> k.raised_by and c.user_id is distinct from k.subject_user and c.user_id <> k.decided_by
      and exists (select 1 from iam.user_profile u where u.id = c.user_id and u.status = 'ACTIVE')
      and authz.user_case_gate(c.user_id, k.case_id)
      and not authz.has_meeting_conflict(c.user_id, k.committee_proceeding_id)
  )
  select e.level from eligible e
  where e.user_id = p_user_id and e.ord = (select min(e2.ord) from eligible e2)
  limit 1;
$$;

-- As in 1900, except that a conflict that came only from an upheld concern, since reversed, no longer counts for the
-- proceeding's later work (DEC-AMB-010).
create or replace function authz.has_meeting_conflict(p_user_id uuid, p_committee_proceeding_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from committee.meeting_participant mp
    join committee.meeting m on m.id = mp.meeting_id
    where m.committee_proceeding_id = p_committee_proceeding_id and mp.user_id = p_user_id
      and mp.coi_status = 'CONFLICT_DECLARED' and committee.conflict_counts(mp.id)
  );
$$;

-- As in 1890, except that the earlier-meeting check skips a conflict that no longer counts (DEC-AMB-010).
create or replace function api.declare_meeting_conflict(p_participant_id uuid, p_status text, p_reason text)
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
         and prior.proceeding_member_id = v_p.proceeding_member_id and prior.coi_status = 'CONFLICT_DECLARED'
         and committee.conflict_counts(prior.id)) then
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

-- A concern, as in 2000, and also for whoever may reverse it now or has reversed it. Never its subject.
create or replace function authz.can_view_meeting_concern(p_concern_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from committee.meeting_conflict_concern c
    join committee.meeting_participant t on t.id = c.participant_id
    where c.id = p_concern_id
      and t.user_id is distinct from authz.current_user_id()
      and ((c.raised_by = authz.current_user_id() and authz.can_view_meeting(c.meeting_id))
           or authz.can_manage_meeting(c.meeting_id)
           or authz.meeting_concern_decider_seat(c.id) is not null
           or committee.concern_reverser_seat(c.id, authz.current_user_id()) is not null
           or exists (select 1 from committee.meeting_conflict_reversal r
                      where r.concern_id = c.id and r.reversed_by = authz.current_user_id()
                        and authz.user_case_gate(r.reversed_by, (select m.case_id from committee.meeting m
                                                                 where m.id = c.meeting_id))))
  );
$$;

alter table committee.meeting_conflict_reversal enable row level security;
create policy meeting_conflict_reversal_read on committee.meeting_conflict_reversal for select to authenticated
  using (authz.can_view_meeting_concern(concern_id));
grant select on committee.meeting_conflict_reversal to authenticated;

create function api.reverse_meeting_conflict_determination(p_concern_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_c committee.meeting_conflict_concern;
  v_case uuid;
  v_seat text;
  v_reason text;
  v_id uuid;
begin
  select * into v_c from committee.meeting_conflict_concern c where c.id = p_concern_id;
  if v_c.id is null or not authz.can_view_meeting_concern(v_c.id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_c from committee.meeting_conflict_concern c where c.id = p_concern_id for update;
  select m.case_id into v_case from committee.meeting m where m.id = v_c.meeting_id;
  if v_c.status <> 'UPHELD' then perform api._fail('CONFLICT', 'NOT_UPHELD'); end if;
  if exists (select 1 from committee.meeting_conflict_reversal r where r.concern_id = v_c.id) then
    perform api._fail('CONFLICT', 'ALREADY_REVERSED');
  end if;
  v_seat := committee.concern_reverser_seat(v_c.id, v_actor);
  if v_seat is null then perform api._fail('FORBIDDEN'); end if;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_case and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  insert into committee.meeting_conflict_reversal (concern_id, reversed_by, reversed_as, reason)
  values (v_c.id, v_actor, v_seat, v_reason)
  returning id into v_id;
  -- The reason stays in the reversal row; the ledger gets ids and seat codes.
  perform audit.record_event('MEETING_CONFLICT_REVERSED', 'BUSINESS', 'SUCCESS', v_case, 'meeting_conflict_concern',
    v_c.id::text, null,
    jsonb_build_object('meeting_id', v_c.meeting_id, 'participant_id', v_c.participant_id, 'reversal_id', v_id,
                       'reversed_as', v_seat, 'decided_as', v_c.decided_as));
  return v_id;
end;
$$;

grant execute on function
  api.activate_acting_chair(uuid, text),
  api.activate_acting_secretary(uuid, text),
  api.activate_alternate_member(uuid, uuid, text),
  api.appoint_conflict_authority(uuid, uuid, timestamptz, timestamptz, text, text, text),
  api.end_conflict_authority(uuid, timestamptz, text),
  api.amend_proceeding_snapshot(uuid, uuid, text),
  api.schedule_emergency_meeting(uuid, text, text, text, text, timestamptz, timestamptz, text, text),
  api.set_invitee_type_rule(text, boolean, boolean, text, text, text),
  api.acknowledge_meeting_confidentiality(uuid),
  api.record_meeting_accommodation(uuid, text),
  api.revise_vote(uuid, text, text),
  api.recuse_for_conflict(uuid, text),
  api.record_vote_note(uuid, text, boolean),
  api.overrule_minutes_objection(uuid, text),
  api.reverse_meeting_conflict_determination(uuid, text)
to authenticated;

-- =============================================================================
-- Section 3. Recommendation packages, legal review and authority decisions
-- =============================================================================
-- DEC-F11, DEC-F12, DEC-F13, DEC-F19, DEC-F20 and the ambiguity register rows routed here (AMB-018, AMB-026, AMB-030,
-- AMB-036, AMB-051, AMB-100–AMB-102, AMB-108, AMB-113, AMB-115, AMB-117, AMB-119, AMB-120, AMB-123, AMB-125–AMB-127,
-- AMB-129–AMB-133, AMB-135, AMB-229); contradictions CON-017 and CON-018.
--
--   3.1 Sanction catalogue versions (DEC-F11; AMB-036, AMB-101, AMB-102). decision.sanction_catalogue_version holds
--       the legal basis, internal policy basis, authority, legal-review requirement, subject categories and
--       exclusivity group of each code, effective-dated. Every seeded value is SOURCE_REQUIRED (nothing invented);
--       CONTRACTOR is not a category any seeded sanction applies to until sourced (AMB-036). Adoption snapshots the
--       item with its catalogue version (decision.item_adoption), so a later catalogue change never alters it.
--       decision.sanction_catalogue_entry shows a basis only once APPROVED. api.set_sanction_catalogue_entry
--       (COMMITTEE_ADMIN) writes a version and never fills a basis itself.
--   3.2 Legal-review rules (DEC-F12, CON-017; AMB-113, AMB-123). decision.legal_review_rule replaces the hard-coded
--       item types: by item type and by the item's "requires legal justification" flag, per committee kind,
--       effective-dated. The owner minimums (legal action, legal justification) cannot be switched off.
--       A catalogue version may also require review. Deliberate referral stays the SECRETARY_ELECTED basis.
--   3.3 Authority rules (DEC-F13, CON-018; AMB-127, AMB-132, AMB-135). A rule may name joint authorities. Submission
--       is refused while an adopted item type has no rule (fail closed) and snapshots the rule, its authorities and
--       its source status per item (decision.authority_submission / authority_requirement), so a later rule change
--       never changes the round. api.authority_rule_coverage shows which types have no rule, and that the
--       FINAL_DISCIPLINARY_AUTHORITY setting (0400) is still SOURCE_REQUIRED while the CEO rule is an owner default.
--   3.4 Authority decisions (AMB-125, AMB-126, AMB-129–AMB-131, AMB-133). One decision per authority type covers
--       that authority's items (decision.authority_decision_scope stores the rule of each); the package is DECIDED
--       only when every required authority has decided every item it must; joint authorities that disagree return
--       the package. A decision records the delegation reference, whether its source is signed (an unsigned source
--       needs the secretary's attestation and is flagged UNSIGNED_SOURCE), a primary and further source
--       documents, and structured conditions (free text only is flagged). decided_at may not fall on a day before
--       adoption (Asia/Riyadh).
--   3.5 Returns, cancellation and superseding opinions (AMB-108, AMB-115, AMB-117): the secretary returns an adopted,
--       unsubmitted package to the committee; cancels an open legal-review request (the reviewer's packet access ends
--       at once); the reviewer may give a superseding opinion in the same round before submission, both kept.
--   3.6 Purpose access ends (AMB-119, AMB-229): a legal reviewer's packet access ends when an authority decision on
--       the package is recorded; a task linked to a legal-hold request ends when the request is decided; both plus
--       the configurable grace PURPOSE_ACCESS_GRACE_DAYS (default 0).
--   3.7 Restricted legal review scope (DEC-F20, AMB-120): an approval names its round, findings and minutes; a
--       packet item outside it is refused on every path. DEC-F19 is as built (no change).
--   3.8 Defence notice before a sanction is adopted (AMB-026), dependencies and exclusivity groups (AMB-100), and the
--       preliminary-review referral guard (AMB-018). AMB-030 is as built: findings are append-only versions and a
--       vote item binds one version.
--   3.9 Conflict taint (AMB-051; DEC-AMB-003, owner, 2026-10-13). An item whose current result came from a closed vote
--       on which someone now conflicted had a counted vote is TAINTED_BY_CONFLICT. Conflicted: a meeting conflict in
--       the proceeding, an upheld concern about them in it even if since reversed (DEC-AMB-010 is prospective; only
--       the committee's resolution clears a taint), or a case conflict. What counted is frozen when the tally is taken
--       (decision.vote_tally_entry), as api.close_vote_item counted it: last choice, alternates in, replaced members
--       and votes that stopped counting out of the recount (a vote that stopped counting still taints, fail safe).
--       Until the committee resolves it the database refuses adoption, legal review (request and opinion),
--       submission and every authority decision but a return, on every path; once the package is decided, also what
--       reads its result as final (opening a corrective action, a decision notice). The secretary running an open
--       meeting of the proceeding records the committee's resolution (decision.conflict_taint_resolution, once per taint):
--       RE_VOTE (the package goes back to the committee, whose next round opens a new vote on the same target, so the
--       tainted result never counts) or CONFIRM, allowed only when the recount without every vote of the conflicted
--       participants gives the same result under the snapshot's DEC-F01 rule and quorum (else RESULT_MAY_CHANGE).
--       A package with the authority or decided is not sent back by RE_VOTE (the authority returns it first; a decided
--       package stays blocked unless CONFIRM holds).
--
-- Existing functions replaced (create or replace: same signature, owner, SECURITY DEFINER and search_path; no check
-- weakened):
--   decision.legal_review_required(uuid)        rule table instead of a fixed list (CON-017); still never false
--                                               where the fixed list said true while the seeded rules are in force.
--   decision.approving_decision(uuid)           respects each decision's scope when several authorities decide.
--   authz.can_view_packet(uuid)                 the reviewer branch ends on cancellation and on the authority
--                                               decision (narrower).
--   authz.user_task_grants(uuid, uuid, text)    a task linked to a decided legal-hold request grants nothing after
--                                               the grace period (narrower).
--   api.add_recommendation_item(7 args)         delegates to the new overload (justification flag, dependencies,
--                                               exclusivity group).
--   api.record_package_adoption(uuid)           sanction in force, defence notice guard, taint guard, adoption
--                                               snapshot.
--   api.request_legal_review(5 args)            taint guard, approval round and scope (DEC-F20).
--   api.approve_restricted_legal_review(3 args) delegates to the new overload with an empty scope.
--   api.give_legal_opinion(uuid, text, text)    a cancelled request is no longer the reviewer's; taint guard.
--   api.submit_to_authority(uuid)               taint guard, fail closed on a missing rule, requirement snapshot.
--   api.record_authority_decision(8 args)       delegates to the new overload (per-authority scope).
-- One index is recreated under its name with a wider key: restricted_legal_review_approval_open is unique per package
-- round instead of per package (an unused approval of an earlier round no longer blocks the next one).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.1 Sanction catalogue versions
-- -----------------------------------------------------------------------------
create table decision.sanction_catalogue_version (
  id                       uuid primary key default gen_random_uuid(),
  code                     text not null references decision.sanction_catalogue (code),
  version_no               int not null check (version_no >= 1),
  legal_basis              text check (length(legal_basis) between 3 and 500),
  internal_policy_basis    text check (length(internal_policy_basis) between 3 and 500),
  -- Null: SOURCE_REQUIRED; decision.action_authority_rule decides.
  authority_type           text references decision.authority_type (code),
  legal_review_requirement text not null default 'SOURCE_REQUIRED'
                             check (legal_review_requirement in ('REQUIRED', 'NOT_REQUIRED', 'SOURCE_REQUIRED')),
  subject_categories       text[] not null
                             check (cardinality(subject_categories) >= 1
                                    and subject_categories <@ array['EMPLOYEE', 'CONTRACTOR', 'OTHER_AUTHORIZED']::text[]),
  -- Null: SOURCE_REQUIRED (AMB-100).
  exclusivity_group        text check (exclusivity_group ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  effective_from           timestamptz not null,
  effective_to             timestamptz,
  source_status            text not null check (source_status in ('SOURCE_REQUIRED', 'APPROVED')),
  source_reference         text check (length(source_reference) between 3 and 300),
  reason                   text check (length(reason) between 5 and 2000),
  created_by               uuid references iam.user_profile (id),
  created_at               timestamptz not null default now(),
  unique (code, version_no),
  check (effective_to is null or effective_to > effective_from),
  -- DEC-F11: nothing is APPROVED without its legal basis and the source that approved it.
  check (source_status <> 'APPROVED' or (legal_basis is not null and source_reference is not null)),
  check ((created_by is null) = (reason is null))
);
create unique index sanction_catalogue_version_open on decision.sanction_catalogue_version (code) where effective_to is null;
create index sanction_catalogue_version_authority on decision.sanction_catalogue_version (authority_type);
create index sanction_catalogue_version_created_by on decision.sanction_catalogue_version (created_by);
comment on table decision.sanction_catalogue_version is
  'DEC-F11 (migration 2030): the governed fields of each sanction code, effective-dated. Seeded SOURCE_REQUIRED; a '
  'basis is shown only once APPROVED (decision.sanction_catalogue_entry). Not selectable directly.';
insert into decision.sanction_catalogue_version (code, version_no, subject_categories, effective_from, source_status)
select c.code, 1, array['EMPLOYEE', 'OTHER_AUTHORIZED'], timestamptz '2026-01-01 00:00:00+00', 'SOURCE_REQUIRED'
from decision.sanction_catalogue c;

-- The adopted form of each approved item, with the catalogue version in force at adoption (AMB-101).
create table decision.item_adoption (
  item_id              uuid not null references decision.recommendation_item (id),
  package_id           uuid not null references decision.recommendation_package (id),
  package_round        int not null check (package_round >= 1),
  catalogue_version_id uuid references decision.sanction_catalogue_version (id),
  snapshot             jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  adopted_at           timestamptz not null default now(),
  primary key (item_id, package_round)
);
create index item_adoption_package on decision.item_adoption (package_id, package_round);
create index item_adoption_catalogue_version on decision.item_adoption (catalogue_version_id);
comment on table decision.item_adoption is
  'AMB-101 (migration 2030): what the committee adopted in a round, with the sanction catalogue version then in force.';

-- AMB-100: an item may depend on another item of its package, or share an exclusivity group with others.
alter table decision.recommendation_item
  add column requires_legal_justification boolean not null default false,
  add column exclusivity_group text check (exclusivity_group ~ '^[A-Z][A-Z0-9_]{2,59}$');
comment on column decision.recommendation_item.requires_legal_justification is
  'DEC-F12 (migration 2030): the matter needs a legal justification, so legal review is required (owner minimum).';
comment on column decision.recommendation_item.exclusivity_group is
  'AMB-100 (migration 2030): items of one group are alternatives; the authority may approve at most one.';

create table decision.recommendation_item_dependency (
  item_id    uuid not null references decision.recommendation_item (id),
  depends_on uuid not null references decision.recommendation_item (id),
  primary key (item_id, depends_on),
  check (item_id <> depends_on)
);
create index recommendation_item_dependency_on on decision.recommendation_item_dependency (depends_on);
comment on table decision.recommendation_item_dependency is
  'AMB-100 (migration 2030): an item that only makes sense if another is approved. Flagged, never auto-changed.';

-- -----------------------------------------------------------------------------
-- 3.2 Legal-review rules
-- -----------------------------------------------------------------------------
create table decision.legal_review_rule (
  id               uuid primary key default gen_random_uuid(),
  committee_kind   text not null check (committee_kind in ('INVESTIGATION', 'GRIEVANCE')),
  trigger_kind     text not null check (trigger_kind in ('ITEM_TYPE', 'LEGAL_JUSTIFICATION_FLAG')),
  item_type        text check (item_type in (
                     'FINDING', 'DISCIPLINARY_SANCTION', 'CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION', 'EXTERNAL_REFERRAL',
                     'NO_VIOLATION', 'CLOSE_WITHOUT_SANCTION', 'LEGAL_ACTION', 'OTHER')),
  requirement      text not null check (requirement in ('REQUIRED', 'NOT_REQUIRED')),
  effective_from   timestamptz not null,
  effective_to     timestamptz,
  -- OWNER_DECISION: an owner minimum (DEC-F12) that no rule may switch off.
  source_status    text not null check (source_status in ('OWNER_DECISION', 'OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  source_reference text check (length(source_reference) between 2 and 300),
  reason           text check (length(reason) between 5 and 2000),
  created_by       uuid references iam.user_profile (id),
  created_at       timestamptz not null default now(),
  check ((trigger_kind = 'ITEM_TYPE') = (item_type is not null)),
  check (effective_to is null or effective_to > effective_from),
  check ((created_by is null) = (source_status in ('OWNER_DECISION', 'OWNER_DEFAULT') and reason is null))
);
create unique index legal_review_rule_open on decision.legal_review_rule (committee_kind, trigger_kind, coalesce(item_type, ''))
  where effective_to is null;
create index legal_review_rule_created_by on decision.legal_review_rule (created_by);
comment on table decision.legal_review_rule is
  'DEC-F12 (migration 2030, CON-017): when legal review is required, by committee kind and item type or legal '
  'justification flag, effective-dated. Not exhaustive: the secretary may always elect a review.';
insert into decision.legal_review_rule (committee_kind, trigger_kind, item_type, requirement, effective_from, source_status,
                                        source_reference) values
  ('INVESTIGATION', 'ITEM_TYPE', 'DISCIPLINARY_SANCTION', 'REQUIRED', timestamptz '2026-01-01 00:00:00+00', 'OWNER_DEFAULT', 'Q74'),
  ('INVESTIGATION', 'ITEM_TYPE', 'LEGAL_ACTION', 'REQUIRED', timestamptz '2026-01-01 00:00:00+00', 'OWNER_DECISION', 'DEC-F12'),
  ('INVESTIGATION', 'ITEM_TYPE', 'EXTERNAL_REFERRAL', 'REQUIRED', timestamptz '2026-01-01 00:00:00+00', 'OWNER_DEFAULT', 'Q74'),
  ('INVESTIGATION', 'LEGAL_JUSTIFICATION_FLAG', null, 'REQUIRED', timestamptz '2026-01-01 00:00:00+00', 'OWNER_DECISION', 'DEC-F12'),
  -- AMB-123: recorded for the Grievance Committee; its outcomes have no legal-review path yet, so it is not enforced.
  ('GRIEVANCE', 'ITEM_TYPE', 'DISCIPLINARY_SANCTION', 'REQUIRED', timestamptz '2026-01-01 00:00:00+00', 'OWNER_DEFAULT', 'AMB-123');

-- -----------------------------------------------------------------------------
-- 3.3 Authority rules: joint authorities and the submission snapshot
-- -----------------------------------------------------------------------------
create table decision.action_authority_rule_joint (
  rule_id        uuid not null references decision.action_authority_rule (id),
  authority_type text not null references decision.authority_type (code),
  primary key (rule_id, authority_type)
);
create index action_authority_rule_joint_authority on decision.action_authority_rule_joint (authority_type);
comment on table decision.action_authority_rule_joint is
  'AMB-127 (migration 2030): further authorities that must also decide items of the rule''s type (joint approval).';

create table decision.authority_submission (
  id            uuid primary key default gen_random_uuid(),
  package_id    uuid not null references decision.recommendation_package (id),
  case_id       uuid not null references case_mgmt.case_record (id),
  package_round int not null check (package_round >= 1),
  packet_id     uuid references decision.packet (id),
  -- BACKFILL: a package already with the authority before migration 2030, snapshotted at its first later decision.
  basis         text not null check (basis in ('SUBMISSION', 'BACKFILL')),
  submitted_by  uuid not null references iam.user_profile (id),
  submitted_at  timestamptz not null default now(),
  unique (package_id, package_round)
);
create index authority_submission_case on decision.authority_submission (case_id);
create index authority_submission_packet on decision.authority_submission (packet_id);
create index authority_submission_submitted_by on decision.authority_submission (submitted_by);
comment on table decision.authority_submission is
  'AMB-132 (migration 2030): one submission per package round; its requirements are the rules in force when submitted.';

create table decision.authority_requirement (
  submission_id      uuid not null references decision.authority_submission (id),
  item_id            uuid not null references decision.recommendation_item (id),
  authority_type     text not null references decision.authority_type (code),
  rule_id            uuid not null references decision.action_authority_rule (id),
  rule_source_status text not null check (rule_source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  primary key (submission_id, item_id, authority_type)
);
create index authority_requirement_item on decision.authority_requirement (item_id);
create index authority_requirement_rule on decision.authority_requirement (rule_id);
create index authority_requirement_authority on decision.authority_requirement (authority_type);

-- -----------------------------------------------------------------------------
-- 3.4 Authority decisions: scope, sources, conditions
-- -----------------------------------------------------------------------------
alter table decision.authority_decision
  add column submission_id        uuid references decision.authority_submission (id),
  add column delegation_reference text check (length(delegation_reference) between 3 and 300),
  -- AMB-129: null when not recorded (decisions before 2030 and the 8-argument command).
  add column source_signature     text check (source_signature in ('SIGNED', 'UNSIGNED')),
  add column unsigned_attestation text check (length(unsigned_attestation) between 10 and 2000),
  add constraint authority_decision_unsigned_attested
    check ((coalesce(source_signature, '') = 'UNSIGNED') = (unsigned_attestation is not null));
create index authority_decision_submission on decision.authority_decision (submission_id);
comment on column decision.authority_decision.delegation_reference is
  'AMB-125 (migration 2030): the delegation under which the deciding person acted. The Delegation of Authority is '
  'SOURCE_REQUIRED; the authority type must still match the rule.';
comment on column decision.authority_decision.source_signature is
  'AMB-129 (migration 2030): SIGNED, UNSIGNED (accepted only with the secretary''s attestation and flagged '
  'UNSIGNED_SOURCE in every view) or null (not recorded, flagged SIGNATURE_NOT_RECORDED).';

create table decision.authority_decision_scope (
  decision_id    uuid not null references decision.authority_decision (id),
  item_id        uuid not null references decision.recommendation_item (id),
  authority_type text not null references decision.authority_type (code),
  rule_id        uuid not null references decision.action_authority_rule (id),
  item_outcome   text not null check (item_outcome in ('APPROVED', 'REJECTED', 'MODIFIED', 'RETURNED', 'OTHER')),
  primary key (decision_id, item_id)
);
create index authority_decision_scope_item on decision.authority_decision_scope (item_id);
create index authority_decision_scope_rule on decision.authority_decision_scope (rule_id);
create index authority_decision_scope_authority on decision.authority_decision_scope (authority_type);
comment on table decision.authority_decision_scope is
  'AMB-126 (migration 2030): the items one authority decision covers, with the rule that required that authority.';

create table decision.authority_decision_source (
  decision_id uuid not null references decision.authority_decision (id),
  position    int not null check (position >= 1),
  reference   text not null check (length(reference) between 3 and 300),
  is_primary  boolean not null,
  primary key (decision_id, position),
  unique (decision_id, reference),
  check (is_primary = (position = 1))
);
comment on table decision.authority_decision_source is
  'AMB-130 (migration 2030): the source documents of a decision; position 1 is the primary one (N15).';

create table decision.authority_decision_condition (
  id             uuid primary key default gen_random_uuid(),
  decision_id    uuid not null references decision.authority_decision (id),
  position       int not null check (position >= 1),
  kind           text not null check (kind in ('CORRECTIVE_ACTION', 'FOLLOW_UP_TASK', 'FREE_TEXT')),
  item_id        uuid references decision.recommendation_item (id),
  condition_text text not null check (length(condition_text) between 5 and 2000),
  due_date       date,
  unique (decision_id, position)
);
create index authority_decision_condition_item on decision.authority_decision_condition (item_id);
comment on table decision.authority_decision_condition is
  'AMB-133 (migration 2030): conditions the authority attached. FREE_TEXT only is flagged; turning a condition into '
  'a corrective action or task is not built yet.';

-- -----------------------------------------------------------------------------
-- 3.5 Returns, cancellations and superseding opinions
-- -----------------------------------------------------------------------------
create table decision.package_return (
  id            uuid primary key default gen_random_uuid(),
  package_id    uuid not null references decision.recommendation_package (id),
  case_id       uuid not null references case_mgmt.case_record (id),
  package_round int not null check (package_round >= 1),
  reason        text not null check (length(reason) between 5 and 2000),
  returned_by   uuid not null references iam.user_profile (id),
  returned_at   timestamptz not null default now()
);
create index package_return_package on decision.package_return (package_id);
create index package_return_case on decision.package_return (case_id);
create index package_return_returned_by on decision.package_return (returned_by);
comment on table decision.package_return is
  'AMB-108 (migration 2030): the secretary returned an adopted package to the committee before submission.';

-- AMB-115: a request can be cancelled while open. The check keeps its 1900 name.
alter table decision.legal_review_request drop constraint legal_review_request_status_check;
alter table decision.legal_review_request add constraint legal_review_request_status_check
  check (status in ('ASSIGNED', 'OPINION_GIVEN', 'CANCELLED'));

create table decision.legal_review_cancellation (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null unique references decision.legal_review_request (id),
  package_id   uuid not null references decision.recommendation_package (id),
  case_id      uuid not null references case_mgmt.case_record (id),
  reason       text not null check (length(reason) between 5 and 2000),
  cancelled_by uuid not null references iam.user_profile (id),
  cancelled_at timestamptz not null default now()
);
create index legal_review_cancellation_package on decision.legal_review_cancellation (package_id);
create index legal_review_cancellation_case on decision.legal_review_cancellation (case_id);
create index legal_review_cancellation_cancelled_by on decision.legal_review_cancellation (cancelled_by);

create table decision.legal_opinion_revision (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references decision.legal_review_request (id),
  package_id    uuid not null references decision.recommendation_package (id),
  case_id       uuid not null references case_mgmt.case_record (id),
  package_round int not null check (package_round >= 1),
  revision_no   int not null check (revision_no >= 2),
  opinion       text not null check (opinion in ('CONCURS', 'CONCURS_WITH_COMMENTS', 'CONFLICTS')),
  opinion_text  text check (length(opinion_text) between 10 and 8000),
  given_by      uuid not null references iam.user_profile (id),
  given_at      timestamptz not null default now(),
  unique (request_id, revision_no),
  check (opinion = 'CONCURS' or opinion_text is not null)
);
create index legal_opinion_revision_package on decision.legal_opinion_revision (package_id);
create index legal_opinion_revision_case on decision.legal_opinion_revision (case_id);
create index legal_opinion_revision_given_by on decision.legal_opinion_revision (given_by);
comment on table decision.legal_opinion_revision is
  'AMB-117 (migration 2030): a superseding opinion in the same round, before submission. The first opinion stays on '
  'the request (revision 1); both travel to the authority.';

-- DEC-AMB-003 (owner, 2026-10-13): the committee's resolution of a taint on one vote item. The reason stays in the row;
-- the ledger gets codes and counts.
create table decision.conflict_taint_resolution (
  id                  uuid primary key default gen_random_uuid(),
  item_id             uuid not null references decision.recommendation_item (id),
  package_id          uuid not null references decision.recommendation_package (id),
  case_id             uuid not null references case_mgmt.case_record (id),
  package_round       int not null check (package_round >= 1),
  vote_item_id        uuid not null references committee.vote_item (id),
  meeting_id          uuid not null references committee.meeting (id),
  resolution          text not null check (resolution in ('RE_VOTE', 'CONFIRM')),
  -- The conflicted participants whose votes the resolution covers, sorted: once per taint.
  conflicted_user_ids uuid[] not null check (cardinality(conflicted_user_ids) >= 1),
  original_result     text not null,
  -- The result without their votes; NOT_RECOUNTABLE under a CUSTOM quorum or another decision rule.
  recount_result      text not null,
  reason              text not null check (length(reason) between 10 and 2000),
  resolved_by         uuid not null references iam.user_profile (id),
  resolved_at         timestamptz not null default now(),
  unique (vote_item_id, conflicted_user_ids),
  check (resolution <> 'CONFIRM' or recount_result = original_result)
);
create index conflict_taint_resolution_item on decision.conflict_taint_resolution (item_id);
create index conflict_taint_resolution_package on decision.conflict_taint_resolution (package_id);
create index conflict_taint_resolution_case on decision.conflict_taint_resolution (case_id);
create index conflict_taint_resolution_meeting on decision.conflict_taint_resolution (meeting_id);
create index conflict_taint_resolution_resolved_by on decision.conflict_taint_resolution (resolved_by);
comment on table decision.conflict_taint_resolution is
  'DEC-AMB-003 (owner, 2026-10-13; migration 2030): RE_VOTE or CONFIRM of a vote on which a now-conflicted '
  'participant voted. CONFIRM only when the recount without their votes gives the same result. Read only by whoever '
  'runs a meeting of the proceeding and by conflict managers who can view the case (AGENT-09 R1).';

-- DEC-AMB-003: every vote on an item as its tally saw it, frozen when the item leaves OPEN (decision.freeze_vote_tally).
-- A vote counted when api.close_vote_item counted it: its participant had no conflict, was present and was a counting
-- voter (an activated alternate counts; the member it replaces, a seat that ended or a user no longer cleared does not),
-- with its last choice (AMB-081). A member who voted and then declared a conflict before the close has a vote that
-- did not count. Internal: no policy and no grant (it holds choices, which a secret ballot hides).
create table decision.vote_tally_entry (
  vote_item_id   uuid not null references committee.vote_item (id),
  vote_id        uuid not null unique references committee.vote (id),
  participant_id uuid not null references committee.meeting_participant (id),
  user_id        uuid references iam.user_profile (id),
  choice         text not null,
  counted        boolean not null,
  primary key (vote_item_id, participant_id)
);
create index vote_tally_entry_participant on decision.vote_tally_entry (participant_id);
create index vote_tally_entry_user on decision.vote_tally_entry (user_id);
comment on table decision.vote_tally_entry is
  'DEC-AMB-003 (migration 2030): each vote on an item with its last choice and whether the tally counted it, frozen '
  'when the item left OPEN. Read only by the taint functions; not selectable.';

-- -----------------------------------------------------------------------------
-- 3.6 Purpose access grace (AMB-229)
-- -----------------------------------------------------------------------------
insert into config.setting (key, value, status, source_reference, description) values
  ('PURPOSE_ACCESS_GRACE_DAYS', '0', 'CONFIGURED', 'AMB-229 owner appendix default (no grace)',
   'Days a purpose-bound reader keeps access after the purpose concludes (legal review packet, legal-hold task).');
update config.setting
   set description = 'Authority that issues final disciplinary decisions. Still SOURCE_REQUIRED (Delegation of Authority); '
                     'the rule in force is decision.action_authority_rule, where DISCIPLINARY_SANCTION → CEO is an owner '
                     'default (DEC-F13). api.authority_rule_coverage reports the difference.'
 where key = 'FINAL_DISCIPLINARY_AUTHORITY';

-- -----------------------------------------------------------------------------
-- 3.7 Restricted legal review scope (DEC-F20)
-- -----------------------------------------------------------------------------
alter table decision.restricted_legal_review_approval
  add column package_round int check (package_round >= 1),
  add column finding_ids   uuid[] not null default '{}',
  add column minutes_ids   uuid[] not null default '{}';
comment on column decision.restricted_legal_review_approval.package_round is
  'DEC-F20 (migration 2030): the round the approval is for. Null on approvals before 2030: never usable again.';
comment on column decision.restricted_legal_review_approval.finding_ids is
  'DEC-F20 (migration 2030): the findings the packet may carry. Anything more needs a new approval.';
drop index decision.restricted_legal_review_approval_open;
create unique index restricted_legal_review_approval_open
  on decision.restricted_legal_review_approval (package_id, coalesce(package_round, 0)) where legal_review_request_id is null;

-- -----------------------------------------------------------------------------
-- Integrity
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['decision.item_adoption', 'decision.recommendation_item_dependency',
                           'decision.action_authority_rule_joint', 'decision.authority_submission',
                           'decision.authority_requirement', 'decision.authority_decision_scope',
                           'decision.authority_decision_source', 'decision.authority_decision_condition',
                           'decision.package_return', 'decision.legal_review_cancellation',
                           'decision.legal_opinion_revision', 'decision.conflict_taint_resolution',
                           'decision.vote_tally_entry'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
  foreach t in array array['decision.sanction_catalogue_version', 'decision.legal_review_rule'] loop
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;

-- Effective-dated rows: only an end may be given, once.
create function decision.protect_effective_dated()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') or old.effective_to is not null then
    raise exception '% % can only be given an end, once', tg_table_name, old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger sanction_catalogue_version_protect before update on decision.sanction_catalogue_version
  for each row execute function decision.protect_effective_dated();
create trigger legal_review_rule_protect before update on decision.legal_review_rule
  for each row execute function decision.protect_effective_dated();

-- -----------------------------------------------------------------------------
-- Internal helpers
-- -----------------------------------------------------------------------------
-- The catalogue version of a code in force now, or null.
create function decision.catalogue_version_in_force(p_code text)
returns uuid
language sql stable
set search_path = ''
as $$
  select v.id from decision.sanction_catalogue_version v
  where v.code = p_code and v.effective_from <= now() and (v.effective_to is null or v.effective_to > now())
  order by v.effective_from desc limit 1;
$$;

-- The catalogue version an item carries: the one snapshotted at its adoption in the package's round, else the one in
-- force.
create function decision.item_catalogue_version(p_item_id uuid)
returns uuid
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select a.catalogue_version_id from decision.item_adoption a
     join decision.recommendation_package p on p.id = a.package_id and p.round_no = a.package_round
     where a.item_id = i.id),
    decision.catalogue_version_in_force(i.sanction_code))
  from decision.recommendation_item i where i.id = p_item_id and i.sanction_code is not null;
$$;

-- The authority rule in force now for an item type, or null.
create function decision.authority_rule_in_force(p_item_type text)
returns uuid
language sql stable
set search_path = ''
as $$
  select r.id from decision.action_authority_rule r
  where r.item_type = p_item_type and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())
  order by r.effective_from desc limit 1;
$$;

-- What 2030 adds to an item snapshot (the 1900 snapshot is unchanged): the legal-justification flag, the
-- exclusivity group, the items it depends on and the sanction catalogue version it carries (AMB-101).
create function decision.item_snapshot_extra(p_item_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'requires_legal_justification', i.requires_legal_justification, 'exclusivity_group', i.exclusivity_group,
    'depends_on', coalesce((select jsonb_agg(d.depends_on order by d.depends_on) from decision.recommendation_item_dependency d
                            where d.item_id = i.id), '[]'::jsonb),
    'catalogue_version_id', decision.item_catalogue_version(i.id))
  from decision.recommendation_item i where i.id = p_item_id;
$$;

-- DEC-AMB-003 (owner, 2026-10-13): the participants who took part in a closed vote item (a substantive vote or an
-- abstention, a recusal that counted towards quorum, or the casting vote, the chair's or an acting chair's alike) and
-- who are now conflicted, less those a resolution of the vote item already covers. Sorted. Conflicted:
--   * a meeting conflict in the proceeding (authz.has_meeting_conflict);
--   * an upheld concern about one of their participant rows in the proceeding, reversed or not: DEC-AMB-010 is
--     prospective, so a reversal never clears a taint; only the committee's resolution does;
--   * a declared or confirmed case conflict.
-- Fail safe, a member who voted and then stopped counting before the close (a conflict declared after voting) still
-- took part, so their vote taints; decision.recount_without leaves it out, as the tally did. A recusal that did not
-- count (api.recuse_for_conflict) is no participation. A tally frozen before decision.vote_tally_entry existed is read
-- by every vote's last choice.
create function decision.vote_item_conflicted(p_vote_item_id uuid)
returns uuid[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(distinct u.user_id order by u.user_id), '{}'::uuid[])
  from committee.vote_item vi
  join committee.meeting m on m.id = vi.meeting_id
  join lateral (select e.user_id from decision.vote_tally_entry e
                where e.vote_item_id = vi.id
                  and (e.choice in ('APPROVE', 'REJECT', 'ABSTAIN') or (e.counted and e.choice = 'RECUSED'))
                union
                select v.recorded_for from committee.vote v
                where v.vote_item_id = vi.id
                  and committee.vote_choice(v.id) in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED')
                  and not exists (select 1 from decision.vote_tally_entry e where e.vote_item_id = vi.id)
                union
                select c.cast_by from committee.casting_vote c where c.vote_item_id = vi.id) u on u.user_id is not null
  where vi.id = p_vote_item_id and vi.status = 'CLOSED'
    and (authz.has_meeting_conflict(u.user_id, m.committee_proceeding_id)
         or exists (select 1 from committee.meeting_conflict_concern k
                    join committee.meeting_participant t on t.id = k.participant_id
                    join committee.meeting km on km.id = k.meeting_id
                    where km.committee_proceeding_id = m.committee_proceeding_id and t.user_id = u.user_id
                      and k.status = 'UPHELD')
         or exists (select 1 from case_mgmt.conflict_check cc
                    where cc.case_id = vi.case_id and cc.user_id = u.user_id and cc.is_current
                      and cc.status in ('CONFLICT_DECLARED', 'CONFLICT_CONFIRMED')))
    and not exists (select 1 from decision.conflict_taint_resolution r
                    where r.vote_item_id = vi.id and u.user_id = any (r.conflicted_user_ids));
$$;

-- The closed vote item that carries an item's result in its package's current round (its own, or the package's).
create function decision.item_vote_item(p_item_id uuid)
returns uuid
language sql stable
set search_path = ''
as $$
  select vi.id
  from decision.recommendation_item i
  join decision.recommendation_package p on p.id = i.package_id
  join committee.vote_item vi on vi.package_id = p.id and vi.package_round = p.round_no and vi.status = 'CLOSED'
                             and (vi.recommendation_item_id = i.id or vi.recommendation_item_id is null)
  where i.id = p_item_id
  order by vi.sequence_no desc
  limit 1;
$$;

-- AMB-051, DEC-AMB-003: an active item is tainted while its vote has an unresolved conflicted voter.
create function decision.item_tainted(p_item_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from decision.recommendation_item i
                 where i.id = p_item_id and i.status = 'ACTIVE'
                   and cardinality(decision.vote_item_conflicted(decision.item_vote_item(i.id))) > 0);
$$;

-- A package with any tainted active item (approved or rejected: either result may be wrong) goes no further.
create function decision.package_tainted(p_package_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from decision.recommendation_item i
                 where i.package_id = p_package_id and i.status = 'ACTIVE' and decision.item_tainted(i.id));
$$;

-- DEC-AMB-003: the result of a closed vote item recounted without every vote of the given participants, as
-- api.close_vote_item (2030 section 2) counted it, on the counts it froze and the votes it counted
-- (decision.vote_tally_entry): each counted participant leaves the eligible and present members, their last choice
-- leaves the tally (an approval or a rejection; an abstention or a recusal counts neither way, DEC-F01), quorum is
-- recomputed from the rule snapshot, and a tie stays broken only by a casting vote (the chair's or an acting chair's)
-- whose caster is not excluded and whose tie is unchanged (otherwise TIED: nobody may presume how it would have been
-- cast). A vote the tally did not count changes nothing. Null when it cannot be recounted: a CUSTOM quorum, another
-- decision rule, or a tally frozen before decision.vote_tally_entry existed.
create function decision.recount_without(p_vote_item_id uuid, p_user_ids uuid[])
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_vi committee.vote_item;
  v_rule jsonb;
  v_removed int;
  v_approve int;
  v_reject int;
  v_eligible int;
  v_present int;
  v_required int;
begin
  select * into v_vi from committee.vote_item vi where vi.id = p_vote_item_id;
  select cp.rule_snapshot into v_rule
  from committee.meeting m join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
  where m.id = v_vi.meeting_id;
  if v_vi.status is distinct from 'CLOSED' or v_rule ->> 'quorum_type' = 'CUSTOM'
     or coalesce(v_rule ->> 'decision_rule', 'SIMPLE_MAJORITY_SUBSTANTIVE') <> 'SIMPLE_MAJORITY_SUBSTANTIVE' then
    return null;
  end if;
  if exists (select 1 from committee.vote v where v.vote_item_id = v_vi.id)
     and not exists (select 1 from decision.vote_tally_entry e where e.vote_item_id = v_vi.id) then
    return null;
  end if;
  select count(*), count(*) filter (where e.choice = 'APPROVE'), count(*) filter (where e.choice = 'REJECT')
    into v_removed, v_approve, v_reject
  from decision.vote_tally_entry e
  where e.vote_item_id = v_vi.id and e.counted and e.user_id = any (p_user_ids);
  v_eligible := v_vi.eligible_count - v_removed;
  v_present := v_vi.present_count - v_removed;
  v_approve := v_vi.approve_count - v_approve;
  v_reject := v_vi.reject_count - v_reject;
  v_required := case v_rule ->> 'quorum_type'
                  when 'MAJORITY_ELIGIBLE' then v_eligible / 2 + 1
                  when 'FIXED_NUMBER' then (v_rule ->> 'quorum_value')::numeric::int
                  when 'PERCENTAGE' then ceil(v_eligible * (v_rule ->> 'quorum_value')::numeric / 100)::int
                end;
  if v_required is null then return null; end if;
  if v_eligible <= 0 or v_present < v_required then return 'NO_QUORUM'; end if;
  if v_approve > v_reject then return 'APPROVED'; end if;
  if v_reject > v_approve then return 'REJECTED'; end if;
  if v_approve = 0 then return coalesce(v_rule ->> 'no_substantive_vote_outcome', 'NO_DECISION'); end if;
  if v_vi.decided_by_casting_vote and v_approve = v_vi.approve_count and v_reject = v_vi.reject_count
     and not exists (select 1 from committee.casting_vote c where c.vote_item_id = v_vi.id and c.cast_by = any (p_user_ids)) then
    return v_vi.result;
  end if;
  return 'TIED';
end;
$$;

-- DEC-AMB-003: freezes what the tally counted when an item leaves OPEN (closed, or awaiting the casting vote), in the
-- statement api.close_vote_item takes it, with the same test: no conflict, present, a counting voter.
create function decision.freeze_vote_tally()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into decision.vote_tally_entry (vote_item_id, vote_id, participant_id, user_id, choice, counted)
  select new.id, v.id, mp.id, mp.user_id, committee.vote_choice(v.id),
         mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT' and committee.counts_as_voter(mp.id)
  from committee.vote v join committee.meeting_participant mp on mp.id = v.participant_id
  where v.vote_item_id = new.id;
  return null;
end;
$$;

-- DEC-AMB-003: the database refuses progression of a tainted package on every path: adoption, a legal review request
-- or opinion, submission, a decided package and any authority decision but a return to the committee; and what reads a
-- decided package's result as final: opening a corrective action on one of its items or a decision notice on its
-- decision.
create function decision.block_tainted_progress()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_package uuid;
begin
  if tg_table_name = 'recommendation_package' then
    if new.status is distinct from old.status
       and (new.status in ('IN_LEGAL_REVIEW', 'AWAITING_AUTHORITY', 'DECIDED')
            or (new.status = 'ADOPTED' and old.status = 'VOTING')) then
      v_package := new.id;
    end if;
  elsif tg_table_name = 'legal_review_request' then
    if tg_op = 'INSERT' or (new.status = 'OPINION_GIVEN' and old.status is distinct from 'OPINION_GIVEN') then
      v_package := new.package_id;
    end if;
  elsif tg_table_name = 'legal_opinion_revision' then
    v_package := new.package_id;
  elsif tg_table_name = 'authority_decision' then
    if new.outcome <> 'RETURN_TO_COMMITTEE' then v_package := new.package_id; end if;
  elsif tg_table_name = 'corrective_action' then
    select i.package_id into v_package from decision.recommendation_item i where i.id = new.recommendation_item_id;
  elsif tg_table_name = 'defence_notice' then
    select d.package_id into v_package from decision.authority_decision d where d.id = new.authority_decision_id;
  end if;
  if v_package is not null and decision.package_tainted(v_package) then
    perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT');
  end if;
  return new;
end;
$$;

-- The grace after a purpose concludes (AMB-229): PURPOSE_ACCESS_GRACE_DAYS, 0 when unset or malformed.
create function authz.purpose_access_grace()
returns interval
language sql stable
set search_path = ''
as $$
  select make_interval(days => coalesce((select case when s.value ~ '^[0-9]{1,3}$' then s.value::int end
                                         from config.setting s where s.key = 'PURPOSE_ACCESS_GRACE_DAYS'), 0));
$$;
revoke all on function authz.purpose_access_grace() from public, anon, authenticated;

-- Checks a new item's catalogue code is in force (AMB-101).
create function decision.check_item_sanction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.sanction_code is not null and decision.catalogue_version_in_force(new.sanction_code) is null then
    perform api._fail('CONFLICT', 'SANCTION_NOT_IN_FORCE');
  end if;
  return new;
end;
$$;
create trigger recommendation_item_sanction_in_force before insert on decision.recommendation_item
  for each row execute function decision.check_item_sanction();

-- AMB-036: a sanction applies only to the subject categories of its catalogue version. A free-text sanction follows
-- the seeded default (no CONTRACTOR until sourced). Every path that names a subject is covered.
create function decision.check_sanction_subject()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_i decision.recommendation_item;
  v_category text;
  v_categories text[];
begin
  select * into v_i from decision.recommendation_item i where i.id = new.item_id;
  if v_i.item_type <> 'DISCIPLINARY_SANCTION' then return new; end if;
  select s.subject_category into v_category from case_mgmt.case_subject s where s.id = new.subject_id;
  if v_i.sanction_code is not null then
    select v.subject_categories into v_categories
    from decision.sanction_catalogue_version v where v.id = decision.catalogue_version_in_force(v_i.sanction_code);
  end if;
  if not (v_category = any (coalesce(v_categories, array['EMPLOYEE', 'OTHER_AUTHORIZED']))) then
    perform api._fail('CONFLICT', 'SANCTION_NOT_APPLICABLE_TO_SUBJECT');
  end if;
  return new;
end;
$$;
create trigger recommendation_item_subject_applicable before insert on decision.recommendation_item_subject
  for each row execute function decision.check_sanction_subject();

-- DEC-F20, AMB-120: on a restricted case, a legal-review packet carries only what its approval names: the package's
-- items, and the findings and minutes listed on the approval. Anything else, on any path, is refused.
create function decision.enforce_restricted_packet_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_k decision.packet;
  v_a decision.restricted_legal_review_approval;
begin
  select * into v_k from decision.packet k where k.id = new.packet_id;
  if v_k.purpose <> 'LEGAL_REVIEW'
     or not exists (select 1 from case_mgmt.case_record c where c.id = v_k.case_id and c.is_restricted) then
    return new;
  end if;
  select * into v_a from decision.restricted_legal_review_approval a where a.legal_review_request_id = v_k.legal_review_request_id;
  if v_a.id is null then perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_REQUIRED'); end if;
  if not (case new.item_kind
            when 'RECOMMENDATION_ITEM' then exists (select 1 from decision.recommendation_item i
                                                    where i.id = new.source_id and i.package_id = v_k.package_id)
            when 'FINDING' then new.source_id = any (v_a.finding_ids)
            when 'MINUTES' then new.source_id = any (v_a.minutes_ids)
            else false end) then
    perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_SCOPE_EXCEEDED');
  end if;
  return new;
end;
$$;
create trigger packet_item_restricted_scope before insert on decision.packet_item
  for each row execute function decision.enforce_restricted_packet_scope();

create trigger recommendation_package_taint_block before update on decision.recommendation_package
  for each row execute function decision.block_tainted_progress();
create trigger legal_review_request_taint_block before insert or update on decision.legal_review_request
  for each row execute function decision.block_tainted_progress();
create trigger legal_opinion_revision_taint_block before insert on decision.legal_opinion_revision
  for each row execute function decision.block_tainted_progress();
create trigger authority_decision_taint_block before insert on decision.authority_decision
  for each row execute function decision.block_tainted_progress();
create trigger corrective_action_taint_block before insert on decision.corrective_action
  for each row execute function decision.block_tainted_progress();
create trigger vote_item_freeze_tally after update of status on committee.vote_item
  for each row when (old.status = 'OPEN' and new.status <> 'OPEN') execute function decision.freeze_vote_tally();
create trigger defence_notice_taint_block before insert on grievance.defence_notice
  for each row when (new.kind = 'DECISION') execute function decision.block_tainted_progress();

-- AMB-018: a case that did not arrive as a direct referral (or a grievance) reaches the Investigation Committee only
-- after its preliminary review concluded REFERRED_TO_COMMITTEE with the approver's approval (Q11, Q15; ADR-017 §5).
-- A trigger, so every path that opens a committee proceeding is covered. It runs after the restricted-case approval
-- check of committee.open_committee_proceeding (DEC-61, DEC-F19).
create function committee.require_preliminary_referral()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from committee.committee c where c.id = new.committee_id and c.kind = 'INVESTIGATION')
     and exists (select 1 from case_mgmt.case_record r
                 where r.id = new.case_id and r.source_type not in ('DIRECT_REFERRAL', 'DIRECT_GRIEVANCE'))
     and coalesce((select pr.recommended_outcome
                   from case_mgmt.preliminary_recommendation pr
                   join case_mgmt.proceeding p on p.id = pr.proceeding_id
                   where pr.case_id = new.case_id and pr.status = 'APPROVED'
                   order by pr.approved_at desc, p.sequence_no desc, pr.version_no desc
                   limit 1), '') <> 'REFERRED_TO_COMMITTEE' then
    perform api._fail('CONFLICT', 'PRELIMINARY_REFERRAL_REQUIRED');
  end if;
  return new;
end;
$$;
create trigger committee_proceeding_preliminary_referral before insert on committee.committee_proceeding
  for each row execute function committee.require_preliminary_referral();

-- -----------------------------------------------------------------------------
-- Replaced predicates and helpers
-- -----------------------------------------------------------------------------
-- DEC-F12 (CON-017): required by a rule in force for the committee's kind (by item type, or by the item's
-- legal-justification flag), or by the item's catalogue version. A NOT_REQUIRED rule never cancels another source.
create or replace function decision.legal_review_required(p_package_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1
    from decision.recommendation_item i
    join decision.recommendation_package p on p.id = i.package_id
    join committee.committee_proceeding cp on cp.id = p.committee_proceeding_id
    join committee.committee c on c.id = cp.committee_id
    where i.package_id = p_package_id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
      and (exists (select 1 from decision.legal_review_rule r
                   where r.committee_kind = c.kind and r.requirement = 'REQUIRED'
                     and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())
                     and ((r.trigger_kind = 'ITEM_TYPE' and r.item_type = i.item_type)
                          or (r.trigger_kind = 'LEGAL_JUSTIFICATION_FLAG' and i.requires_legal_justification)))
           or exists (select 1 from decision.sanction_catalogue_version v
                      where v.id = decision.item_catalogue_version(i.id) and v.legal_review_requirement = 'REQUIRED'))
  );
$$;

-- 1940, now aware of several authorities: a decision with a recorded scope approves an item only when it covers the
-- item with an approving outcome and no other decision of the round covering the item disagrees. Decisions recorded
-- before 2030 (no scope) keep the 1940 reading.
create or replace function decision.approving_decision(p_item_id uuid)
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
    and case
          when exists (select 1 from decision.authority_decision_scope sc where sc.decision_id = d.id) then
            exists (select 1 from decision.authority_decision_scope sc
                    where sc.decision_id = d.id and sc.item_id = i.id and sc.item_outcome in ('APPROVED', 'MODIFIED'))
            and not exists (select 1 from decision.authority_decision d2
                            join decision.authority_decision_scope sc2 on sc2.decision_id = d2.id
                            where d2.package_id = k.id and d2.package_round = k.round_no and sc2.item_id = i.id
                              and sc2.item_outcome not in ('APPROVED', 'MODIFIED'))
          else d.outcome = 'APPROVE_AS_RECOMMENDED'
               or (d.outcome in ('APPROVE_PARTIALLY', 'MODIFY')
                   and exists (select 1 from decision.authority_item_decision x
                               where x.decision_id = d.id and x.item_id = i.id and x.outcome in ('APPROVED', 'MODIFIED')))
        end
  order by d.recorded_at, d.id
  limit 1;
$$;

-- N14 as in 1900, with the reviewer branch narrowed: a cancelled request (a replaced reviewer, AMB-115) gives nothing,
-- and the purpose ends once an authority decision on the package in the request's round or later is recorded, plus
-- the grace period (AMB-119, AMB-229).
create or replace function authz.can_view_packet(p_packet_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from decision.packet k
    where k.id = p_packet_id
      and (authz.sees_proceeding_deliberation(k.committee_proceeding_id, k.case_id)
           or (k.purpose = 'LEGAL_REVIEW'
               and authz.has_permission('LEGAL_OPINION_GIVE')
               and authz.user_case_gate(authz.current_user_id(), k.case_id)
               and exists (select 1 from decision.legal_review_request r
                           where r.id = k.legal_review_request_id and r.assigned_to = authz.current_user_id()
                             and r.status <> 'CANCELLED'
                             and not exists (select 1 from decision.authority_decision d
                                             where d.package_id = r.package_id and d.package_round >= r.package_round
                                               and d.recorded_at + authz.purpose_access_grace() <= now()))))
  );
$$;

-- ADR-014 as in 1700, narrowed (AMB-229): a task linked to a legal-hold request grants nothing once the request is
-- decided and the grace period has passed, even if the task was left open.
create or replace function authz.user_task_grants(p_user_id uuid, p_case_id uuid, p_capability text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.user_case_gate(p_user_id, p_case_id)
     and (p_capability = 'CASE_VIEW_METADATA' or authz.user_has_permission(p_user_id, p_capability))
     and exists (
       select 1 from case_mgmt.case_task t
       where t.case_id = p_case_id and t.assigned_user_id = p_user_id
         and t.status in ('OPEN', 'IN_PROGRESS')
         and t.access_granted_at <= now() and t.expires_at > now()
         and p_capability = any (t.scope)
         and authz.user_has_role(p_user_id, t.assigned_role)
         and not exists (select 1 from records.legal_hold_request h
                         where h.assigned_task_id = t.id and h.reviewed_at is not null
                           and h.reviewed_at + authz.purpose_access_grace() <= now()));
$$;

-- -----------------------------------------------------------------------------
-- RLS (SELECT only; no write grants)
-- -----------------------------------------------------------------------------
alter table decision.sanction_catalogue_version enable row level security;
alter table decision.item_adoption enable row level security;
alter table decision.recommendation_item_dependency enable row level security;
alter table decision.legal_review_rule enable row level security;
alter table decision.action_authority_rule_joint enable row level security;
alter table decision.authority_submission enable row level security;
alter table decision.authority_requirement enable row level security;
alter table decision.authority_decision_scope enable row level security;
alter table decision.authority_decision_source enable row level security;
alter table decision.authority_decision_condition enable row level security;
alter table decision.package_return enable row level security;
alter table decision.legal_review_cancellation enable row level security;
alter table decision.legal_opinion_revision enable row level security;
alter table decision.conflict_taint_resolution enable row level security;
alter table decision.vote_tally_entry enable row level security;

-- decision.sanction_catalogue_version: no policy and no grant; read through decision.sanction_catalogue_entry.
-- decision.vote_tally_entry: no policy and no grant; read only by the DEC-AMB-003 taint functions.
create policy item_adoption_read on decision.item_adoption for select to authenticated
  using (authz.can_view_recommendation_package(package_id));
grant select on decision.item_adoption to authenticated;
create policy recommendation_item_dependency_read on decision.recommendation_item_dependency for select to authenticated
  using (exists (select 1 from decision.recommendation_item i
                 where i.id = item_id and authz.can_view_recommendation_package(i.package_id)));
grant select on decision.recommendation_item_dependency to authenticated;
create policy legal_review_rule_read on decision.legal_review_rule for select to authenticated
  using (authz.current_user_id() is not null);
grant select on decision.legal_review_rule to authenticated;
create policy action_authority_rule_joint_read on decision.action_authority_rule_joint for select to authenticated
  using (authz.current_user_id() is not null);
grant select on decision.action_authority_rule_joint to authenticated;
create policy authority_submission_read on decision.authority_submission for select to authenticated
  using (authz.can_view_recommendation_package(package_id));
grant select on decision.authority_submission to authenticated;
create policy authority_requirement_read on decision.authority_requirement for select to authenticated
  using (exists (select 1 from decision.authority_submission x
                 where x.id = submission_id and authz.can_view_recommendation_package(x.package_id)));
grant select on decision.authority_requirement to authenticated;
create policy authority_decision_scope_read on decision.authority_decision_scope for select to authenticated
  using (exists (select 1 from decision.authority_decision d
                 where d.id = decision_id and authz.can_view_recommendation_package(d.package_id)));
grant select on decision.authority_decision_scope to authenticated;
create policy authority_decision_source_read on decision.authority_decision_source for select to authenticated
  using (exists (select 1 from decision.authority_decision d
                 where d.id = decision_id and authz.can_view_recommendation_package(d.package_id)));
grant select on decision.authority_decision_source to authenticated;
create policy authority_decision_condition_read on decision.authority_decision_condition for select to authenticated
  using (exists (select 1 from decision.authority_decision d
                 where d.id = decision_id and authz.can_view_recommendation_package(d.package_id)));
grant select on decision.authority_decision_condition to authenticated;
create policy package_return_read on decision.package_return for select to authenticated
  using (authz.can_view_recommendation_package(package_id));
grant select on decision.package_return to authenticated;
create policy legal_review_cancellation_read on decision.legal_review_cancellation for select to authenticated
  using (authz.can_view_recommendation_package(package_id));
grant select on decision.legal_review_cancellation to authenticated;
-- As the request itself: the package's viewers, and the reviewer while they can read the request's packet.
create policy legal_opinion_revision_read on decision.legal_opinion_revision for select to authenticated
  using (authz.can_view_recommendation_package(package_id)
         or (given_by = authz.current_user_id()
             and exists (select 1 from decision.packet k
                         where k.legal_review_request_id = legal_opinion_revision.request_id and authz.can_view_packet(k.id))));
grant select on decision.legal_opinion_revision to authenticated;
-- DEC-AMB-003 (AGENT-09 early look, R1): a resolution names the conflicted members, including case-level conflicts
-- that only conflict managers read, and its recount would reveal a member's vote under a secret ballot. So it is read
-- only by whoever runs a meeting of the proceeding (who records the resolution) and by conflict managers who can view
-- the case. Every other viewer of the package sees only the TAINTED_BY_CONFLICT flag (api.recommendation_item_flags),
-- which names nobody.
create policy conflict_taint_resolution_read on decision.conflict_taint_resolution for select to authenticated
  using (exists (select 1 from committee.meeting rm
                 join committee.meeting m on m.committee_proceeding_id = rm.committee_proceeding_id
                 where rm.id = conflict_taint_resolution.meeting_id and authz.can_manage_meeting(m.id))
         or (authz.has_permission('CONFLICT_MANAGE') and authz.can_view_case(case_id)));
grant select on decision.conflict_taint_resolution to authenticated;

-- -----------------------------------------------------------------------------
-- Read models
-- -----------------------------------------------------------------------------
-- AMB-102 (T-AMB-057): every code with the version in force. A basis is shown only once APPROVED; until then the row
-- says SOURCE_REQUIRED and never shows draft text as policy.
create function decision.sanction_catalogue_rows()
returns table (code text, is_active boolean, version_id uuid, version_no int, effective_from timestamptz,
               effective_to timestamptz, source_status text, basis_status text, legal_basis text,
               internal_policy_basis text, source_reference text, authority_type text, authority_status text,
               legal_review_requirement text, subject_categories text[], exclusivity_group text,
               exclusivity_status text)
language sql stable security definer
set search_path = ''
as $$
  select c.code, c.is_active, v.id, v.version_no, v.effective_from, v.effective_to,
         coalesce(v.source_status, 'SOURCE_REQUIRED'),
         case when v.source_status = 'APPROVED' then 'SOURCED' else 'SOURCE_REQUIRED' end,
         case when v.source_status = 'APPROVED' then v.legal_basis end,
         case when v.source_status = 'APPROVED' then v.internal_policy_basis end,
         case when v.source_status = 'APPROVED' then v.source_reference end,
         v.authority_type,
         case when v.authority_type is null then 'SOURCE_REQUIRED' else v.source_status end,
         coalesce(v.legal_review_requirement, 'SOURCE_REQUIRED'), v.subject_categories, v.exclusivity_group,
         case when v.exclusivity_group is null then 'SOURCE_REQUIRED' else v.source_status end
  from decision.sanction_catalogue c
  left join decision.sanction_catalogue_version v
    on v.id = decision.catalogue_version_in_force(c.code)
  where authz.current_user_id() is not null;
$$;
revoke all on function decision.sanction_catalogue_rows() from public, anon;
grant execute on function decision.sanction_catalogue_rows() to authenticated;

create view decision.sanction_catalogue_entry with (security_invoker = true) as
select * from decision.sanction_catalogue_rows();
comment on view decision.sanction_catalogue_entry is
  'DEC-F11, AMB-102 (migration 2030): each sanction code with the catalogue version in force. A basis is shown only '
  'once APPROVED; SOURCE_REQUIRED rows are never policy.';
grant select on decision.sanction_catalogue_entry to authenticated;

-- AMB-129, AMB-133 (T-AMB-075): each decision the caller may see, with its flags. The export builder reads the same
-- flags (read-model flag; the export itself is unchanged).
create view decision.authority_decision_overview with (security_invoker = true) as
select d.id as decision_id, d.package_id, d.case_id, d.package_round, d.authority_type, d.outcome, d.decided_at,
       d.recorded_at, d.decided_by_label, d.source_document_reference as primary_source, d.delegation_reference,
       d.source_signature,
       (select count(*) from decision.authority_decision_source s where s.decision_id = d.id)::int as source_count,
       (select count(*) from decision.authority_decision_condition c where c.decision_id = d.id)::int as condition_count,
       array_remove(array[
         case when d.source_signature = 'UNSIGNED' then 'UNSIGNED_SOURCE' end,
         case when d.source_signature is null then 'SIGNATURE_NOT_RECORDED' end,
         case when exists (select 1 from decision.authority_decision_condition c
                           where c.decision_id = d.id and c.kind = 'FREE_TEXT') then 'FREE_TEXT_CONDITION' end,
         case when d.delegation_reference is not null then 'DELEGATED' end], null)::text[] as flags
from decision.authority_decision d;
comment on view decision.authority_decision_overview is
  'AMB-125, AMB-129, AMB-133 (migration 2030): authority decisions with UNSIGNED_SOURCE, SIGNATURE_NOT_RECORDED, '
  'FREE_TEXT_CONDITION and DELEGATED flags. Rows follow authority_decision''s policy.';
grant select on decision.authority_decision_overview to authenticated;

-- -----------------------------------------------------------------------------
-- Commands: catalogue and rules (COMMITTEE_ADMIN)
-- -----------------------------------------------------------------------------
-- DEC-F11: a new catalogue version of a code. Never invents a basis: APPROVED needs the basis and its source.
create function api.set_sanction_catalogue_entry(
  p_code text, p_legal_basis text, p_internal_policy_basis text, p_authority_type text, p_legal_review_requirement text,
  p_subject_categories text[], p_exclusivity_group text, p_effective_from timestamptz, p_source_status text,
  p_source_reference text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_reason text;
  v_version int;
  v_id uuid;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_code is null or not exists (select 1 from decision.sanction_catalogue c where c.code = p_code and c.is_active) then
    perform api._fail('INVALID', 'code');
  end if;
  if p_legal_basis is not null then perform api._require_text(p_legal_basis, 'legal_basis', 3, 500); end if;
  if p_internal_policy_basis is not null then
    perform api._require_text(p_internal_policy_basis, 'internal_policy_basis', 3, 500);
  end if;
  if p_authority_type is not null
     and not exists (select 1 from decision.authority_type a where a.code = p_authority_type and a.is_active) then
    perform api._fail('INVALID', 'authority_type');
  end if;
  if p_legal_review_requirement is null or p_legal_review_requirement not in ('REQUIRED', 'NOT_REQUIRED', 'SOURCE_REQUIRED') then
    perform api._fail('INVALID', 'legal_review_requirement');
  end if;
  if p_subject_categories is null or cardinality(p_subject_categories) = 0
     or not (p_subject_categories <@ array['EMPLOYEE', 'CONTRACTOR', 'OTHER_AUTHORIZED']::text[])
     or (select count(distinct x) from unnest(p_subject_categories) x) <> cardinality(p_subject_categories) then
    perform api._fail('INVALID', 'subject_categories');
  end if;
  if p_exclusivity_group is not null and p_exclusivity_group !~ '^[A-Z][A-Z0-9_]{2,59}$' then
    perform api._fail('INVALID', 'exclusivity_group');
  end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  if p_source_reference is not null then perform api._require_text(p_source_reference, 'source_reference', 3, 300); end if;
  if p_source_status = 'APPROVED' then
    if p_legal_basis is null then perform api._fail('INVALID', 'legal_basis'); end if;
    if p_source_reference is null then perform api._fail('INVALID', 'source_reference'); end if;
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform 1 from decision.sanction_catalogue c where c.code = p_code for update;
  if exists (select 1 from decision.sanction_catalogue_version v
             where v.code = p_code and v.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'LATER_VERSION_EXISTS');
  end if;
  select coalesce(max(v.version_no), 0) + 1 into v_version from decision.sanction_catalogue_version v where v.code = p_code;
  update decision.sanction_catalogue_version set effective_to = p_effective_from
   where code = p_code and effective_to is null;
  insert into decision.sanction_catalogue_version (code, version_no, legal_basis, internal_policy_basis, authority_type,
                                                   legal_review_requirement, subject_categories, exclusivity_group,
                                                   effective_from, source_status, source_reference, reason, created_by)
  values (p_code, v_version, btrim(p_legal_basis), btrim(p_internal_policy_basis), p_authority_type,
          p_legal_review_requirement, p_subject_categories, p_exclusivity_group, p_effective_from, p_source_status,
          btrim(p_source_reference), v_reason, v_actor)
  returning id into v_id;
  -- The basis texts stay in the version row; the ledger gets codes, flags and the administrator's reason (as 1900).
  perform audit.record_event('SANCTION_CATALOGUE_VERSION_SET', 'ADMIN', 'SUCCESS', null, 'sanction_catalogue_version',
    v_id::text, v_reason,
    jsonb_build_object('code', p_code, 'version_no', v_version, 'effective_from', p_effective_from,
                       'source_status', p_source_status, 'authority_type', p_authority_type,
                       'legal_review_requirement', p_legal_review_requirement,
                       'subject_categories', to_jsonb(p_subject_categories), 'exclusivity_group', p_exclusivity_group,
                       'has_legal_basis', p_legal_basis is not null,
                       'has_internal_policy_basis', p_internal_policy_basis is not null));
  return v_id;
end;
$$;

-- DEC-F12: a new legal-review rule from a date. The owner minimums (OWNER_DECISION rows) are never switched off.
create function api.set_legal_review_rule(
  p_committee_kind text, p_trigger_kind text, p_item_type text, p_requirement text, p_effective_from timestamptz,
  p_source_status text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_reason text;
  v_id uuid;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_committee_kind is null or p_committee_kind not in ('INVESTIGATION', 'GRIEVANCE') then
    perform api._fail('INVALID', 'committee_kind');
  end if;
  if p_trigger_kind is null or p_trigger_kind not in ('ITEM_TYPE', 'LEGAL_JUSTIFICATION_FLAG') then
    perform api._fail('INVALID', 'trigger_kind');
  end if;
  if (p_trigger_kind = 'ITEM_TYPE') <> (p_item_type is not null)
     or (p_item_type is not null and p_item_type not in (
           'FINDING', 'DISCIPLINARY_SANCTION', 'CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION', 'EXTERNAL_REFERRAL',
           'NO_VIOLATION', 'CLOSE_WITHOUT_SANCTION', 'LEGAL_ACTION', 'OTHER')) then
    perform api._fail('INVALID', 'item_type');
  end if;
  if p_requirement is null or p_requirement not in ('REQUIRED', 'NOT_REQUIRED') then
    perform api._fail('INVALID', 'requirement');
  end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  -- One rule per key at a time, under a lock on the open rule's key.
  perform 1 from decision.legal_review_rule r
  where r.committee_kind = p_committee_kind and r.trigger_kind = p_trigger_kind
    and r.item_type is not distinct from p_item_type and r.effective_to is null
  for update;
  if p_requirement = 'NOT_REQUIRED' and exists (
       select 1 from decision.legal_review_rule r
       where r.committee_kind = p_committee_kind and r.trigger_kind = p_trigger_kind
         and r.item_type is not distinct from p_item_type and r.source_status = 'OWNER_DECISION'
         and r.requirement = 'REQUIRED') then
    perform api._fail('CONFLICT', 'OWNER_MINIMUM_RULE');
  end if;
  if exists (select 1 from decision.legal_review_rule r
             where r.committee_kind = p_committee_kind and r.trigger_kind = p_trigger_kind
               and r.item_type is not distinct from p_item_type and r.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'LATER_RULE_EXISTS');
  end if;
  update decision.legal_review_rule set effective_to = p_effective_from
   where committee_kind = p_committee_kind and trigger_kind = p_trigger_kind
     and item_type is not distinct from p_item_type and effective_to is null;
  insert into decision.legal_review_rule (committee_kind, trigger_kind, item_type, requirement, effective_from,
                                          source_status, reason, created_by)
  values (p_committee_kind, p_trigger_kind, p_item_type, p_requirement, p_effective_from, p_source_status, v_reason, v_actor)
  returning id into v_id;
  perform audit.record_event('LEGAL_REVIEW_RULE_SET', 'ADMIN', 'SUCCESS', null, 'legal_review_rule', v_id::text, v_reason,
    jsonb_build_object('committee_kind', p_committee_kind, 'trigger_kind', p_trigger_kind, 'item_type', p_item_type,
                       'requirement', p_requirement, 'effective_from', p_effective_from, 'source_status', p_source_status));
  return v_id;
end;
$$;

-- AMB-127: a rule naming several authorities that must all decide (the first is the rule's own authority type).
create function api.set_action_authority_rule(
  p_item_type text, p_authority_types text[], p_effective_from timestamptz, p_source_status text, p_reason text
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
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_item_type is null or p_item_type not in (
       'FINDING', 'DISCIPLINARY_SANCTION', 'CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION', 'EXTERNAL_REFERRAL',
       'NO_VIOLATION', 'CLOSE_WITHOUT_SANCTION', 'LEGAL_ACTION', 'OTHER') then
    perform api._fail('INVALID', 'item_type');
  end if;
  if p_authority_types is null or cardinality(p_authority_types) not between 1 and 4
     or (select count(distinct x) from unnest(p_authority_types) x) <> cardinality(p_authority_types)
     or exists (select 1 from unnest(p_authority_types) x
                where not exists (select 1 from decision.authority_type a where a.code = x and a.is_active)) then
    perform api._fail('INVALID', 'authority_types');
  end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform 1 from decision.authority_type a where a.code = p_authority_types[1] for update;
  if exists (select 1 from decision.action_authority_rule r
             where r.item_type = p_item_type and r.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'LATER_RULE_EXISTS');
  end if;
  update decision.action_authority_rule set effective_to = p_effective_from
   where item_type = p_item_type and effective_to is null;
  insert into decision.action_authority_rule (item_type, authority_type, effective_from, source_status, reason, created_by)
  values (p_item_type, p_authority_types[1], p_effective_from, p_source_status, v_reason, v_actor)
  returning id into v_id;
  insert into decision.action_authority_rule_joint (rule_id, authority_type)
  select v_id, x from unnest(p_authority_types[2:]) x;
  perform audit.record_event('AUTHORITY_RULE_SET', 'ADMIN', 'SUCCESS', null, 'action_authority_rule', v_id::text, v_reason,
    jsonb_build_object('item_type', p_item_type, 'authority_type', p_authority_types[1],
                       'authority_types', to_jsonb(p_authority_types), 'effective_from', p_effective_from,
                       'source_status', p_source_status));
  return v_id;
end;
$$;

-- DEC-F13, CON-018: which item types have an authority rule in force, with their authorities and source status.
-- NO_RULE types cannot be submitted (fail closed). The FINAL_DISCIPLINARY_AUTHORITY setting (0400) is reported where
-- it disagrees with the rule in force.
create function api.authority_rule_coverage()
returns table (item_type text, rule_id uuid, authority_types text[], source_status text, coverage text,
               setting_disagreement boolean)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform api._actor();
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  return query
  select t.item_type, r.id,
         case when r.id is null then '{}'::text[]
              else array[r.authority_type] || array(select j.authority_type from decision.action_authority_rule_joint j
                                                   where j.rule_id = r.id order by j.authority_type collate "C") end,
         r.source_status,
         case when r.id is null then 'NO_RULE' else r.source_status end,
         t.item_type = 'DISCIPLINARY_SANCTION' and r.id is not null
           and exists (select 1 from config.setting s
                       where s.key = 'FINAL_DISCIPLINARY_AUTHORITY'
                         and (s.status = 'SOURCE_REQUIRED' or s.value is distinct from r.authority_type))
  from unnest(array['FINDING', 'DISCIPLINARY_SANCTION', 'CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION',
                    'EXTERNAL_REFERRAL', 'NO_VIOLATION', 'CLOSE_WITHOUT_SANCTION', 'LEGAL_ACTION', 'OTHER']) t(item_type)
  left join decision.action_authority_rule r on r.id = decision.authority_rule_in_force(t.item_type)
  order by t.item_type collate "C";
end;
$$;

-- -----------------------------------------------------------------------------
-- Commands: packages
-- -----------------------------------------------------------------------------
-- 1900's command plus the legal-justification flag (DEC-F12), dependencies and an exclusivity group (AMB-100).
create function api.add_recommendation_item(
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

-- The 1900 signature: no justification flag, no dependency, no group.
create or replace function api.add_recommendation_item(
  p_package_id uuid, p_item_type text, p_sanction_code text, p_proposed_sanction_text text, p_description text,
  p_subject_ids uuid[], p_allegation_ids uuid[]
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  return api.add_recommendation_item(p_package_id, p_item_type, p_sanction_code, p_proposed_sanction_text, p_description,
                                     p_subject_ids, p_allegation_ids, false, null::uuid[], null::text);
end;
$$;

-- Q58, Q70 as in 1900. On adoption (2030): no tainted result (DEC-AMB-003), every catalogue code must be in force
-- (AMB-101), a sanction needs a defence
-- notice to each subject covering its allegations when the proceeding's rule snapshot says so (AMB-026; a snapshot
-- from before the option existed keeps the 1900 behaviour), and the adopted items are snapshotted with their
-- catalogue version.
create or replace function api.record_package_adoption(p_package_id uuid)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_p decision.recommendation_package;
  v_status text;
  v_approved int;
  v_notice_rule boolean;
begin
  perform api._actor();
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status <> 'VOTING' then perform api._fail('CONFLICT', 'PACKAGE_NOT_VOTING'); end if;
  if not exists (select 1 from committee.vote_item vi where vi.package_id = v_p.id and vi.package_round = v_p.round_no)
     or exists (select 1 from committee.vote_item vi
                where vi.package_id = v_p.id and vi.package_round = v_p.round_no and vi.status <> 'CLOSED') then
    perform api._fail('CONFLICT', 'VOTES_NOT_CLOSED');
  end if;
  if v_p.vote_granularity = 'PACKAGE' then
    update decision.recommendation_item i
       set committee_result = case when (select vi.result from committee.vote_item vi
                                         where vi.package_id = v_p.id and vi.package_round = v_p.round_no
                                           and vi.target_type = 'PACKAGE') = 'APPROVED' then 'APPROVED' else 'REJECTED' end
     where i.package_id = v_p.id and i.status = 'ACTIVE';
  else
    update decision.recommendation_item i
       set committee_result = case when vi.result = 'APPROVED' then 'APPROVED' else 'REJECTED' end
      from committee.vote_item vi
     where vi.recommendation_item_id = i.id and vi.package_round = v_p.round_no and i.package_id = v_p.id
       and i.status = 'ACTIVE';
  end if;
  select count(*) into v_approved from decision.recommendation_item i
  where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED';
  v_status := case when v_approved > 0 then 'ADOPTED' else 'DRAFT' end;

  if v_status = 'ADOPTED' then
    -- DEC-AMB-003: a result a now-conflicted voter took part in waits for the committee's resolution.
    if decision.package_tainted(v_p.id) then perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT'); end if;
    if exists (select 1 from decision.recommendation_item i
               where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
                 and i.sanction_code is not null and decision.catalogue_version_in_force(i.sanction_code) is null) then
      perform api._fail('CONFLICT', 'SANCTION_NOT_IN_FORCE');
    end if;
    select coalesce((cp.rule_snapshot ->> 'sanction_requires_defence_notice')::boolean, false) into v_notice_rule
    from committee.committee_proceeding cp where cp.id = v_p.committee_proceeding_id;
    -- Each subject of an adopted sanction, on each allegation of the item against that subject (all the subject's
    -- allegations when the item names none), has a defence notice; a subject with no allegation has at least one.
    if v_notice_rule and exists (
      select 1
      from decision.recommendation_item i
      join decision.recommendation_item_subject rs on rs.item_id = i.id
      where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
        and i.item_type = 'DISCIPLINARY_SANCTION'
        and (exists (select 1 from case_mgmt.allegation a
                     where a.subject_id = rs.subject_id and a.status <> 'WITHDRAWN'
                       and (a.id in (select ra.allegation_id from decision.recommendation_item_allegation ra where ra.item_id = i.id)
                            or not exists (select 1 from decision.recommendation_item_allegation ra where ra.item_id = i.id))
                       and not exists (select 1 from grievance.defence_notice n
                                       join grievance.defence_notice_item ni on ni.notice_id = n.id
                                       where n.subject_id = rs.subject_id and n.kind = 'DEFENCE' and n.status <> 'WITHDRAWN'
                                         and ni.allegation_id = a.id))
             or not exists (select 1 from grievance.defence_notice n
                            where n.subject_id = rs.subject_id and n.kind = 'DEFENCE' and n.status <> 'WITHDRAWN'))
    ) then
      perform api._fail('CONFLICT', 'DEFENCE_NOTICE_REQUIRED');
    end if;
    insert into decision.item_adoption (item_id, package_id, package_round, catalogue_version_id, snapshot)
    select i.id, v_p.id, v_p.round_no, v.id,
           decision.item_snapshot(i.id) || decision.item_snapshot_extra(i.id)
           || jsonb_build_object('catalogue_version_id', v.id, 'catalogue_version_no', v.version_no,
                                 'catalogue_source_status', v.source_status,
                                 'catalogue_legal_basis', case when v.source_status = 'APPROVED' then v.legal_basis end,
                                 'catalogue_authority_type', v.authority_type,
                                 'catalogue_legal_review_requirement', v.legal_review_requirement)
    from decision.recommendation_item i
    left join decision.sanction_catalogue_version v on v.id = decision.catalogue_version_in_force(i.sanction_code)
    where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED';
  end if;

  update decision.recommendation_package
     set status = v_status, adopted_at = case when v_status = 'ADOPTED' then now() end,
         updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event(case when v_status = 'ADOPTED' then 'RECOMMENDATION_PACKAGE_ADOPTED' else 'RECOMMENDATION_PACKAGE_NOT_ADOPTED' end,
    'BUSINESS', 'SUCCESS', v_p.case_id, 'recommendation_package', v_p.id::text, null,
    jsonb_build_object('round_no', v_p.round_no, 'approved_items', v_approved,
                       'legal_review_required', decision.legal_review_required(v_p.id)));
  return v_status;
end;
$$;

-- AMB-108: before submission the secretary returns an adopted package to the committee; the next vote is a new
-- round. After submission only the authority can return it.
create function api.return_package_to_committee(p_package_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_id uuid;
begin
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status <> 'ADOPTED' then perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED'); end if;
  insert into decision.package_return (package_id, case_id, package_round, reason, returned_by)
  values (v_p.id, v_p.case_id, v_p.round_no, api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_id;
  update decision.recommendation_package
     set status = 'DRAFT', adopted_at = null, updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  -- The reason stays in its row; the ledger gets ids only.
  perform audit.record_event('RECOMMENDATION_PACKAGE_RETURNED_TO_COMMITTEE', 'BUSINESS', 'SUCCESS', v_p.case_id,
    'recommendation_package', v_p.id::text, null, jsonb_build_object('round_no', v_p.round_no, 'package_return_id', v_id));
  return v_id;
end;
$$;

-- AMB-100, AMB-051, Q87, DEC-F11: what the committee should see on each active item of a package. Read-only.
create function api.recommendation_item_flags(p_package_id uuid)
returns table (item_id uuid, flag text)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform api._actor();
  if p_package_id is null or not authz.can_view_recommendation_package(p_package_id) then perform api._fail('NOT_FOUND'); end if;
  return query
  select f.item_id, f.flag from (
    select i.id as item_id, 'PROPOSED_UNVERIFIED'::text as flag
    from decision.recommendation_item i
    where i.package_id = p_package_id and i.status = 'ACTIVE' and i.verification_status = 'PROPOSED_UNVERIFIED'
    union all
    select i.id, 'SANCTION_SOURCE_REQUIRED'
    from decision.recommendation_item i
    where i.package_id = p_package_id and i.status = 'ACTIVE' and i.sanction_code is not null
      and coalesce((select v.source_status from decision.sanction_catalogue_version v
                    where v.id = decision.item_catalogue_version(i.id)), 'SOURCE_REQUIRED') <> 'APPROVED'
    union all
    select i.id, 'TAINTED_BY_CONFLICT'
    from decision.recommendation_item i
    where i.package_id = p_package_id and i.status = 'ACTIVE' and decision.item_tainted(i.id)
    union all
    -- A dependency withdrawn, rejected by the committee, or not approved by an authority in the current round.
    select i.id, 'DEPENDENCY_NOT_APPROVED'
    from decision.recommendation_item i
    where i.package_id = p_package_id and i.status = 'ACTIVE'
      and exists (select 1 from decision.recommendation_item_dependency dep
                  join decision.recommendation_item o on o.id = dep.depends_on
                  join decision.recommendation_package p on p.id = o.package_id
                  where dep.item_id = i.id
                    and (o.status = 'WITHDRAWN' or o.committee_result = 'REJECTED'
                         or exists (select 1 from decision.authority_decision d
                                    join decision.authority_decision_scope sc on sc.decision_id = d.id
                                    where d.package_id = p.id and d.package_round = p.round_no and sc.item_id = o.id
                                      and sc.item_outcome not in ('APPROVED', 'MODIFIED'))))
    union all
    select i.id, 'EXCLUSIVITY_CONFLICT'
    from decision.recommendation_item i
    where i.package_id = p_package_id and i.status = 'ACTIVE' and i.exclusivity_group is not null
      and coalesce(i.committee_result, 'APPROVED') = 'APPROVED'
      and exists (select 1 from decision.recommendation_item o
                  where o.package_id = i.package_id and o.id <> i.id and o.status = 'ACTIVE'
                    and o.exclusivity_group = i.exclusivity_group and coalesce(o.committee_result, 'APPROVED') = 'APPROVED')
  ) f
  order by f.item_id, f.flag collate "C";
end;
$$;

-- -----------------------------------------------------------------------------
-- Commands: legal review
-- -----------------------------------------------------------------------------
-- Q75 as in 1900. 2030: a tainted package waits (DEC-AMB-003); on a restricted case the approval is for this round and
-- names everything the secretary sends (DEC-F20, AMB-120).
create or replace function api.request_legal_review(
  p_package_id uuid, p_assigned_to uuid, p_reason text, p_finding_ids uuid[], p_minutes_ids uuid[]
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_req uuid;
  v_packet uuid;
  v_findings uuid[] := coalesce(p_finding_ids, '{}');
  v_minutes uuid[] := coalesce(p_minutes_ids, '{}');
  v_classification core.classification_level;
  v_items int;
  v_approval decision.restricted_legal_review_approval;
begin
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status <> 'ADOPTED' then perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED'); end if;
  if exists (select 1 from decision.legal_review_request r
             where r.package_id = v_p.id and r.package_round = v_p.round_no and r.status = 'ASSIGNED') then
    perform api._fail('CONFLICT', 'LEGAL_REVIEW_OPEN');
  end if;
  if decision.package_tainted(v_p.id) then perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT'); end if;
  -- The reviewer holds the opinion permission and is cleared for the case; never the requester.
  if p_assigned_to is null or p_assigned_to = v_actor
     or not authz.user_has_permission(p_assigned_to, 'LEGAL_OPINION_GIVE')
     or not authz.user_case_gate(p_assigned_to, v_p.case_id) then
    perform api._fail('INVALID', 'assigned_to');
  end if;
  if exists (select 1 from unnest(v_findings) x
             where not exists (select 1 from case_mgmt.finding f where f.id = x and f.case_id = v_p.case_id))
     or (select count(distinct x) from unnest(v_findings) x) <> cardinality(v_findings) then
    perform api._fail('INVALID', 'finding_ids');
  end if;
  if exists (select 1 from unnest(v_minutes) x
             where not exists (select 1 from committee.minutes mi
                               join committee.meeting m on m.id = mi.meeting_id
                               where mi.id = x and m.committee_proceeding_id = v_p.committee_proceeding_id
                                 and mi.status in ('APPROVED', 'DEEMED_APPROVED')))
     or (select count(distinct x) from unnest(v_minutes) x) <> cardinality(v_minutes) then
    perform api._fail('INVALID', 'minutes_ids');
  end if;
  select c.classification into v_classification from case_mgmt.case_record c where c.id = v_p.case_id;
  -- AGENT-09 W2, DEC-F20: a restricted case needs its authority's unused approval for this round naming this reviewer,
  -- and the approval must name every finding and minutes sent.
  if exists (select 1 from case_mgmt.case_record c where c.id = v_p.case_id and c.is_restricted) then
    select a.* into v_approval from decision.restricted_legal_review_approval a
    where a.package_id = v_p.id and a.legal_review_request_id is null and a.reviewer_id = p_assigned_to
      and a.package_round = v_p.round_no
    for update;
    if v_approval.id is null then perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_REQUIRED'); end if;
    if not (v_findings <@ v_approval.finding_ids) or not (v_minutes <@ v_approval.minutes_ids) then
      perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_SCOPE_EXCEEDED');
    end if;
  end if;

  insert into decision.legal_review_request (package_id, case_id, package_round, basis, assigned_to, reason, requested_by)
  values (v_p.id, v_p.case_id, v_p.round_no,
          case when decision.legal_review_required(v_p.id) then 'RULE' else 'SECRETARY_ELECTED' end,
          p_assigned_to, api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_req;
  if v_approval.id is not null then
    update decision.restricted_legal_review_approval set legal_review_request_id = v_req, used_at = now()
     where id = v_approval.id;
  end if;
  insert into decision.packet (case_id, committee_proceeding_id, package_id, purpose, legal_review_request_id,
                               classification, created_by)
  values (v_p.case_id, v_p.committee_proceeding_id, v_p.id, 'LEGAL_REVIEW', v_req, v_classification, v_actor)
  returning id into v_packet;
  insert into decision.packet_item (packet_id, position, item_kind, source_id, snapshot)
  select v_packet, row_number() over (order by k, at, id), kind, id, snap
  from (
    select 1 as k, i.added_at as at, i.id, 'RECOMMENDATION_ITEM' as kind,
           decision.item_snapshot(i.id) || decision.item_snapshot_extra(i.id) as snap
    from decision.recommendation_item i
    where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
    union all
    select 2, f.recorded_at, f.id, 'FINDING',
           jsonb_build_object('result', f.result, 'rationale', f.rationale, 'version_no', f.version_no,
                              'allegation_id', f.allegation_id, 'allegation_category', a.category, 'subject_id', f.subject_id)
    from case_mgmt.finding f join case_mgmt.allegation a on a.id = f.allegation_id
    where f.id = any (v_findings)
    union all
    select 3, mi.generated_at, mi.id, 'MINUTES',
           jsonb_build_object('version_no', mi.version_no, 'status', mi.status, 'narrative', mi.narrative,
                              'vote_items', mi.snapshot -> 'vote_items')
    from committee.minutes mi where mi.id = any (v_minutes)
  ) s;
  get diagnostics v_items = row_count;
  update decision.recommendation_package set status = 'IN_LEGAL_REVIEW', updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event('LEGAL_REVIEW_REQUESTED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'legal_review_request', v_req::text,
    null, jsonb_build_object('package_id', v_p.id, 'round_no', v_p.round_no, 'assigned_to', p_assigned_to,
                             'packet_id', v_packet, 'restricted_approval_id', v_approval.id));
  perform audit.record_event('PACKET_CREATED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'packet', v_packet::text, null,
    jsonb_build_object('purpose', 'LEGAL_REVIEW', 'items', v_items, 'findings', cardinality(v_findings),
                       'minutes', cardinality(v_minutes)));
  return v_req;
end;
$$;

-- DEC-F20: the case owner, eligible as a Restricted Case Authority for the case classification, approves one legal
-- review of the adopted package in its current round by a named reviewer, with the findings and minutes the packet
-- may carry. Single use; an unused approval of an earlier round is never usable.
create function api.approve_restricted_legal_review(
  p_package_id uuid, p_reviewer_id uuid, p_finding_ids uuid[], p_minutes_ids uuid[], p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_case case_mgmt.case_record;
  v_findings uuid[] := coalesce(p_finding_ids, '{}');
  v_minutes uuid[] := coalesce(p_minutes_ids, '{}');
  v_id uuid;
  v_reason text;
begin
  if p_package_id is null or not authz.can_view_recommendation_package(p_package_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_p from decision.recommendation_package p where p.id = p_package_id for update;
  select * into v_case from case_mgmt.case_record c where c.id = v_p.case_id;
  if not v_case.is_restricted then perform api._fail('CONFLICT', 'CASE_NOT_RESTRICTED'); end if;
  if v_case.owner_id is distinct from v_actor
     or not authz.is_restricted_case_authority(v_actor, v_case.classification) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_case.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
  if v_p.status <> 'ADOPTED' then perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED'); end if;
  if p_reviewer_id is null or p_reviewer_id = v_actor
     or not authz.user_has_permission(p_reviewer_id, 'LEGAL_OPINION_GIVE')
     or not authz.user_case_gate(p_reviewer_id, v_p.case_id) then
    perform api._fail('INVALID', 'reviewer_id');
  end if;
  if exists (select 1 from unnest(v_findings) x
             where not exists (select 1 from case_mgmt.finding f where f.id = x and f.case_id = v_p.case_id))
     or (select count(distinct x) from unnest(v_findings) x) <> cardinality(v_findings) then
    perform api._fail('INVALID', 'finding_ids');
  end if;
  if exists (select 1 from unnest(v_minutes) x
             where not exists (select 1 from committee.minutes mi
                               join committee.meeting m on m.id = mi.meeting_id
                               where mi.id = x and m.committee_proceeding_id = v_p.committee_proceeding_id
                                 and mi.status in ('APPROVED', 'DEEMED_APPROVED')))
     or (select count(distinct x) from unnest(v_minutes) x) <> cardinality(v_minutes) then
    perform api._fail('INVALID', 'minutes_ids');
  end if;
  if exists (select 1 from decision.restricted_legal_review_approval a
             where a.package_id = v_p.id and a.legal_review_request_id is null and a.package_round = v_p.round_no) then
    perform api._fail('CONFLICT', 'APPROVAL_ALREADY_PENDING');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  insert into decision.restricted_legal_review_approval (case_id, package_id, reviewer_id, approved_by, reason,
                                                         package_round, finding_ids, minutes_ids)
  values (v_p.case_id, v_p.id, p_reviewer_id, v_actor, v_reason, v_p.round_no, v_findings, v_minutes)
  returning id into v_id;
  perform audit.record_event('RESTRICTED_LEGAL_REVIEW_APPROVED', 'BUSINESS', 'SUCCESS', v_p.case_id,
    'restricted_legal_review_approval', v_id::text, v_reason,
    jsonb_build_object('package_id', v_p.id, 'reviewer_id', p_reviewer_id, 'classification', v_case.classification,
                       'round_no', v_p.round_no, 'findings', cardinality(v_findings), 'minutes', cardinality(v_minutes)));
  return v_id;
end;
$$;

-- The 1900 signature: an approval for the adopted items only.
create or replace function api.approve_restricted_legal_review(p_package_id uuid, p_reviewer_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  return api.approve_restricted_legal_review(p_package_id, p_reviewer_id, '{}'::uuid[], '{}'::uuid[], p_reason);
end;
$$;

-- Q77 as in 1900; a cancelled request is no longer the reviewer's (AMB-115); a tainted package waits for the
-- committee (DEC-AMB-003).
create or replace function api.give_legal_opinion(p_request_id uuid, p_opinion text, p_opinion_text text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r decision.legal_review_request;
  v_status text;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_case_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_case_gate(v_actor, v_r.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  perform 1 from decision.recommendation_package p where p.id = v_r.package_id for update;
  select * into v_r from decision.legal_review_request r where r.id = p_request_id for update;
  if v_r.status = 'CANCELLED' then perform api._fail('CONFLICT', 'REQUEST_CANCELLED'); end if;
  if v_r.status <> 'ASSIGNED' then perform api._fail('CONFLICT', 'OPINION_ALREADY_GIVEN'); end if;
  if decision.package_tainted(v_r.package_id) then perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT'); end if;
  if p_opinion is null or p_opinion not in ('CONCURS', 'CONCURS_WITH_COMMENTS', 'CONFLICTS') then
    perform api._fail('INVALID', 'opinion');
  end if;
  update decision.legal_review_request
     set status = 'OPINION_GIVEN', opinion = p_opinion, opinion_at = now(),
         opinion_text = case when p_opinion <> 'CONCURS' or p_opinion_text is not null
                             then api._require_text(p_opinion_text, 'opinion_text', 10, 8000) end
   where id = v_r.id;
  v_status := case when p_opinion = 'CONFLICTS' then 'RETURNED_BY_LEGAL' else 'ADOPTED' end;
  update decision.recommendation_package set status = v_status, updated_at = now(), row_version = row_version + 1
   where id = v_r.package_id;
  perform audit.record_event('LEGAL_OPINION_GIVEN', 'BUSINESS', 'SUCCESS', v_r.case_id, 'legal_review_request', v_r.id::text,
    null, jsonb_build_object('package_id', v_r.package_id, 'opinion', p_opinion, 'package_status', v_status));
end;
$$;

-- AMB-115: the secretary cancels an open request (to replace the reviewer, or to return the package). The reviewer's
-- packet access ends at once; a replacement is a new request (and on a restricted case a new approval).
create function api.cancel_legal_review_request(p_request_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r decision.legal_review_request;
  v_p decision.recommendation_package;
  v_id uuid;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_case_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if not authz.can_manage_recommendation_package(v_r.package_id) then perform api._fail('FORBIDDEN'); end if;
  v_p := decision.lock_managed_package(v_r.package_id);
  select * into v_r from decision.legal_review_request r where r.id = p_request_id for update;
  if v_r.status <> 'ASSIGNED' then perform api._fail('CONFLICT', 'LEGAL_REVIEW_NOT_OPEN'); end if;
  insert into decision.legal_review_cancellation (request_id, package_id, case_id, reason, cancelled_by)
  values (v_r.id, v_r.package_id, v_r.case_id, api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_id;
  update decision.legal_review_request set status = 'CANCELLED' where id = v_r.id;
  if v_p.status = 'IN_LEGAL_REVIEW' then
    update decision.recommendation_package set status = 'ADOPTED', updated_at = now(), row_version = row_version + 1
     where id = v_p.id;
  end if;
  perform audit.record_event('LEGAL_REVIEW_CANCELLED', 'BUSINESS', 'SUCCESS', v_r.case_id, 'legal_review_request',
    v_r.id::text, null, jsonb_build_object('package_id', v_r.package_id, 'round_no', v_r.package_round,
                                           'assigned_to', v_r.assigned_to, 'cancellation_id', v_id));
  return v_id;
end;
$$;

-- AMB-117: no edit or withdrawal of an opinion. Before submission, in the same round, the reviewer may give a
-- superseding opinion; both are kept and both travel to the authority. CONFLICTS returns the package.
create function api.give_superseding_legal_opinion(p_request_id uuid, p_opinion text, p_opinion_text text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r decision.legal_review_request;
  v_p decision.recommendation_package;
  v_revision int;
  v_status text;
  v_id uuid;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_case_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_case_gate(v_actor, v_r.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  -- The reviewer's purpose is still open: they can still read the request's packet (AMB-119).
  if not exists (select 1 from decision.packet k where k.legal_review_request_id = v_r.id and authz.can_view_packet(k.id)) then
    perform api._fail('NOT_FOUND');
  end if;
  select * into v_p from decision.recommendation_package p where p.id = v_r.package_id for update;
  select * into v_r from decision.legal_review_request r where r.id = p_request_id for update;
  if v_r.status <> 'OPINION_GIVEN' then perform api._fail('CONFLICT', 'OPINION_NOT_GIVEN'); end if;
  if v_p.status <> 'ADOPTED' or v_p.round_no <> v_r.package_round then
    perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED');
  end if;
  if decision.package_tainted(v_p.id) then perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT'); end if;
  if p_opinion is null or p_opinion not in ('CONCURS', 'CONCURS_WITH_COMMENTS', 'CONFLICTS') then
    perform api._fail('INVALID', 'opinion');
  end if;
  select coalesce(max(x.revision_no), 1) + 1 into v_revision
  from decision.legal_opinion_revision x where x.request_id = v_r.id;
  insert into decision.legal_opinion_revision (request_id, package_id, case_id, package_round, revision_no, opinion,
                                               opinion_text, given_by)
  values (v_r.id, v_r.package_id, v_r.case_id, v_r.package_round, v_revision, p_opinion,
          case when p_opinion <> 'CONCURS' or p_opinion_text is not null
               then api._require_text(p_opinion_text, 'opinion_text', 10, 8000) end, v_actor)
  returning id into v_id;
  v_status := case when p_opinion = 'CONFLICTS' then 'RETURNED_BY_LEGAL' else 'ADOPTED' end;
  if v_status <> v_p.status then
    update decision.recommendation_package set status = v_status, updated_at = now(), row_version = row_version + 1
     where id = v_p.id;
  end if;
  perform audit.record_event('LEGAL_OPINION_SUPERSEDED', 'BUSINESS', 'SUCCESS', v_r.case_id, 'legal_opinion_revision',
    v_id::text, null, jsonb_build_object('request_id', v_r.id, 'package_id', v_r.package_id, 'revision_no', v_revision,
                                         'opinion', p_opinion, 'package_status', v_status));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Commands: conflict taint (DEC-AMB-003, owner, 2026-10-13)
-- -----------------------------------------------------------------------------
-- The committee decides whether a vote a now-conflicted participant took part in is taken again or may stand; the
-- secretary running an open meeting of the proceeding records that decision on a tainted item. Neither a conflicted
-- participant nor whoever raised the conflict about them records it. CONFIRM only where their participation could not
-- have changed the result: the recount without every vote of theirs gives the same result (RESULT_MAY_CHANGE
-- otherwise). RE_VOTE returns the package to the committee before it leaves it (not with Legal or the authority):
-- the next round opens a new vote item on the same target and the tainted result no longer counts. Once per taint.
create function api.resolve_conflict_taint(p_item_id uuid, p_resolution text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_i decision.recommendation_item;
  v_p decision.recommendation_package;
  v_vi committee.vote_item;
  v_conflicted uuid[];
  v_meeting uuid;
  v_reason text;
  v_recount text;
  v_status text;
  v_id uuid;
begin
  select * into v_i from decision.recommendation_item i where i.id = p_item_id;
  if v_i.id is null or not authz.can_view_recommendation_package(v_i.package_id) then perform api._fail('NOT_FOUND'); end if;
  v_p := decision.lock_managed_package(v_i.package_id);
  select * into v_vi from committee.vote_item vi where vi.id = decision.item_vote_item(v_i.id);
  v_conflicted := decision.vote_item_conflicted(v_vi.id);
  if v_i.status <> 'ACTIVE' or v_vi.id is null or cardinality(v_conflicted) = 0 then
    perform api._fail('CONFLICT', 'NOT_TAINTED');
  end if;
  if v_actor = any (v_conflicted) or exists (
       select 1 from committee.meeting_conflict_concern c
       join committee.meeting_participant mp on mp.id = c.participant_id
       join committee.meeting m on m.id = c.meeting_id
       where m.committee_proceeding_id = v_p.committee_proceeding_id and c.raised_by = v_actor
         and mp.user_id = any (v_conflicted)) then
    perform api._fail('FORBIDDEN');
  end if;
  if p_resolution is null or p_resolution not in ('RE_VOTE', 'CONFIRM') then perform api._fail('INVALID', 'resolution'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  -- A recorded committee decision: in a meeting of the proceeding that is open and that the actor runs.
  select m.id into v_meeting from committee.meeting m
  where m.committee_proceeding_id = v_p.committee_proceeding_id and m.status = 'OPEN' and authz.can_manage_meeting(m.id)
  order by m.opened_at desc nulls last, m.id
  limit 1;
  if v_meeting is null then perform api._fail('CONFLICT', 'MEETING_NOT_OPEN'); end if;
  v_recount := decision.recount_without(v_vi.id, v_conflicted);
  v_status := v_p.status;
  if p_resolution = 'CONFIRM' then
    if v_recount is null or v_recount <> v_vi.result then perform api._fail('CONFLICT', 'RESULT_MAY_CHANGE'); end if;
  else
    if v_p.status = 'IN_LEGAL_REVIEW' then perform api._fail('CONFLICT', 'LEGAL_REVIEW_OPEN'); end if;
    if v_p.status = 'AWAITING_AUTHORITY' then perform api._fail('CONFLICT', 'PACKAGE_WITH_AUTHORITY'); end if;
    if v_p.status = 'DECIDED' then perform api._fail('CONFLICT', 'PACKAGE_DECIDED'); end if;
    if exists (select 1 from committee.vote_item vi
               where vi.package_id = v_p.id and vi.package_round = v_p.round_no and vi.status <> 'CLOSED') then
      perform api._fail('CONFLICT', 'VOTE_IN_PROGRESS');
    end if;
    if v_p.status in ('VOTING', 'ADOPTED') then v_status := 'DRAFT'; end if;
  end if;

  insert into decision.conflict_taint_resolution (item_id, package_id, case_id, package_round, vote_item_id, meeting_id,
                                                  resolution, conflicted_user_ids, original_result, recount_result,
                                                  reason, resolved_by)
  values (v_i.id, v_p.id, v_p.case_id, v_p.round_no, v_vi.id, v_meeting, p_resolution, v_conflicted, v_vi.result,
          coalesce(v_recount, 'NOT_RECOUNTABLE'), v_reason, v_actor)
  returning id into v_id;
  if v_status <> v_p.status then
    update decision.recommendation_package
       set status = v_status, adopted_at = null, updated_at = now(), row_version = row_version + 1
     where id = v_p.id;
  end if;
  -- The reason, who was conflicted and the recount stay in the row; the ledger gets ids, codes and a count, never a
  -- result (AGENT-09 R1: with COI_DECLARED events beside it, a recount would reveal a vote under a secret ballot).
  perform audit.record_event('CONFLICT_TAINT_RESOLVED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'conflict_taint_resolution',
    v_id::text, null,
    jsonb_build_object('item_id', v_i.id, 'package_id', v_p.id, 'round_no', v_p.round_no, 'vote_item_id', v_vi.id,
                       'meeting_id', v_meeting, 'resolution', p_resolution, 'conflicted', cardinality(v_conflicted),
                       'package_status', v_status));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Commands: authority (ADR-023)
-- -----------------------------------------------------------------------------
-- Writes the authority requirements of a submission: for each adopted item, the rule in force now and each authority
-- it names. Refuses while an adopted item type has no rule (CON-018, AMB-135: fail closed).
create function decision.write_authority_requirements(p_submission_id uuid, p_package_id uuid)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  if exists (select 1 from decision.recommendation_item i
             where i.package_id = p_package_id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
               and decision.authority_rule_in_force(i.item_type) is null) then
    perform api._fail('CONFLICT', 'AUTHORITY_RULE_MISSING');
  end if;
  insert into decision.authority_requirement (submission_id, item_id, authority_type, rule_id, rule_source_status)
  select p_submission_id, i.id, t.authority_type, r.id, r.source_status
  from decision.recommendation_item i
  join decision.action_authority_rule r on r.id = decision.authority_rule_in_force(i.item_type)
  cross join lateral (select r.authority_type
                      union
                      select j.authority_type from decision.action_authority_rule_joint j where j.rule_id = r.id) t
  where i.package_id = p_package_id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Q77 as in 1900. 2030: a tainted package waits (DEC-AMB-003); every adopted item type needs an authority rule (AMB-135);
-- the rules, their authorities and source status are snapshotted on the submission and in the packet (AMB-132);
-- superseding opinions travel with the first ones (AMB-117).
create or replace function api.submit_to_authority(p_package_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_packet uuid;
  v_submission uuid;
  v_requirements int;
  v_items int;
begin
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status <> 'ADOPTED' then perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED'); end if;
  -- An opinion on an earlier round does not cover a revised package: the current round needs its own.
  if decision.legal_review_required(v_p.id) and not exists (
    select 1 from decision.legal_review_request r
    where r.package_id = v_p.id and r.package_round = v_p.round_no and r.status = 'OPINION_GIVEN'
  ) then
    perform api._fail('CONFLICT', 'LEGAL_REVIEW_REQUIRED');
  end if;
  if decision.package_tainted(v_p.id) then perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT'); end if;
  if exists (select 1 from decision.recommendation_item i
             where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
               and decision.authority_rule_in_force(i.item_type) is null) then
    perform api._fail('CONFLICT', 'AUTHORITY_RULE_MISSING');
  end if;
  insert into decision.packet (case_id, committee_proceeding_id, package_id, purpose, classification, created_by)
  select v_p.case_id, v_p.committee_proceeding_id, v_p.id, 'AUTHORITY_DECISION', c.classification, v_actor
  from case_mgmt.case_record c where c.id = v_p.case_id
  returning id into v_packet;
  insert into decision.authority_submission (package_id, case_id, package_round, packet_id, basis, submitted_by)
  values (v_p.id, v_p.case_id, v_p.round_no, v_packet, 'SUBMISSION', v_actor)
  returning id into v_submission;
  v_requirements := decision.write_authority_requirements(v_submission, v_p.id);
  insert into decision.packet_item (packet_id, position, item_kind, source_id, snapshot)
  select v_packet, row_number() over (order by k, at, sub, id), kind, id, snap
  from (
    select 1 as k, i.added_at as at, 0 as sub, i.id, 'RECOMMENDATION_ITEM' as kind,
           decision.item_snapshot(i.id) || decision.item_snapshot_extra(i.id)
           || jsonb_build_object(
                'required_authority', r.authority_type,
                'required_authorities', (select jsonb_agg(q.authority_type order by q.authority_type collate "C")
                                         from decision.authority_requirement q
                                         where q.submission_id = v_submission and q.item_id = i.id),
                'authority_rule_id', r.id, 'authority_rule_source_status', r.source_status) as snap
    from decision.recommendation_item i
    join decision.action_authority_rule r on r.id = decision.authority_rule_in_force(i.item_type)
    where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
    union all
    select 2, r.opinion_at, 1, r.id, 'LEGAL_OPINION',
           jsonb_build_object('opinion', r.opinion, 'opinion_text', r.opinion_text, 'package_round', r.package_round,
                              'basis', r.basis, 'revision_no', 1,
                              'superseded', exists (select 1 from decision.legal_opinion_revision x where x.request_id = r.id))
    from decision.legal_review_request r where r.package_id = v_p.id and r.status = 'OPINION_GIVEN'
    union all
    select 2, x.given_at, x.revision_no, x.id, 'LEGAL_OPINION',
           jsonb_build_object('opinion', x.opinion, 'opinion_text', x.opinion_text, 'package_round', x.package_round,
                              'request_id', x.request_id, 'revision_no', x.revision_no,
                              'superseded', exists (select 1 from decision.legal_opinion_revision y
                                                    where y.request_id = x.request_id and y.revision_no > x.revision_no))
    from decision.legal_opinion_revision x where x.package_id = v_p.id
  ) s;
  get diagnostics v_items = row_count;
  update decision.recommendation_package set status = 'AWAITING_AUTHORITY', updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event('RECOMMENDATION_PACKAGE_SUBMITTED_TO_AUTHORITY', 'BUSINESS', 'SUCCESS', v_p.case_id,
    'recommendation_package', v_p.id::text, null,
    jsonb_build_object('round_no', v_p.round_no, 'packet_id', v_packet, 'submission_id', v_submission,
                       'authority_requirements', v_requirements));
  perform audit.record_event('PACKET_CREATED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'packet', v_packet::text, null,
    jsonb_build_object('purpose', 'AUTHORITY_DECISION', 'items', v_items));
  return v_packet;
end;
$$;

-- Q80–Q83 as in 1900, per authority (AMB-126, AMB-127): one decision per authority type covers the items its
-- submission requires of that authority. The package is DECIDED once every requirement of the round is decided;
-- joint authorities that disagree on an item, or RETURN_TO_COMMITTEE, return it. The decision records the delegation
-- reference (AMB-125), whether its source is signed (AMB-129: unsigned only with the secretary's attestation), further
-- source documents beside the primary one (AMB-130) and structured conditions (AMB-133). decided_at is the authority's
-- date and may not fall on a day before adoption (AMB-131, Asia/Riyadh).
create function api.record_authority_decision(
  p_package_id uuid, p_authority_type text, p_outcome text, p_decided_at timestamptz, p_decided_by_label text,
  p_source_document_reference text, p_item_outcomes jsonb, p_reason text, p_delegation_reference text,
  p_source_signature text, p_unsigned_attestation text, p_additional_source_references text[], p_conditions jsonb
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_submission uuid;
  v_backfilled boolean := false;
  v_required uuid[];
  v_scope uuid[];
  v_id uuid;
  v_status text;
  v_complete boolean;
  v_disagreement boolean;
  v_sources text[] := coalesce(p_additional_source_references, '{}');
begin
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status <> 'AWAITING_AUTHORITY' then perform api._fail('CONFLICT', 'PACKAGE_NOT_AWAITING_AUTHORITY'); end if;
  if not exists (select 1 from decision.authority_type a where a.code = p_authority_type and a.is_active) then
    perform api._fail('INVALID', 'authority_type');
  end if;
  -- A package submitted before 2030 is snapshotted now, under the rules in force.
  select x.id into v_submission from decision.authority_submission x
  where x.package_id = v_p.id and x.package_round = v_p.round_no;
  if v_submission is null then
    insert into decision.authority_submission (package_id, case_id, package_round, packet_id, basis, submitted_by)
    values (v_p.id, v_p.case_id, v_p.round_no,
            (select k.id from decision.packet k where k.package_id = v_p.id and k.purpose = 'AUTHORITY_DECISION'
             order by k.created_at desc, k.id limit 1), 'BACKFILL', v_actor)
    returning id into v_submission;
    perform decision.write_authority_requirements(v_submission, v_p.id);
    v_backfilled := true;
  end if;
  -- The authority must be one the submission requires, for items it has not decided yet.
  select array_agg(q.item_id order by q.item_id) into v_required from decision.authority_requirement q
  where q.submission_id = v_submission and q.authority_type = p_authority_type;
  if v_required is null then perform api._fail('CONFLICT', 'AUTHORITY_TYPE_MISMATCH'); end if;
  select array_agg(x order by x) into v_scope from unnest(v_required) x
  where not exists (select 1 from decision.authority_decision d
                    join decision.authority_decision_scope sc on sc.decision_id = d.id
                    where d.package_id = v_p.id and d.package_round = v_p.round_no
                      and d.authority_type = p_authority_type and sc.item_id = x);
  if v_scope is null then perform api._fail('CONFLICT', 'AUTHORITY_ALREADY_DECIDED'); end if;
  if p_outcome is null or p_outcome not in (
       'APPROVE_AS_RECOMMENDED', 'MODIFY', 'REJECT', 'RETURN_TO_COMMITTEE', 'APPROVE_PARTIALLY', 'OTHER') then
    perform api._fail('INVALID', 'outcome');
  end if;
  if p_decided_at is null or p_decided_at > now()
     or (v_p.adopted_at is not null
         and (p_decided_at at time zone 'Asia/Riyadh')::date < (v_p.adopted_at at time zone 'Asia/Riyadh')::date) then
    perform api._fail('INVALID', 'decided_at');
  end if;
  -- N15: no source document, no decision.
  if p_source_document_reference is null or length(trim(p_source_document_reference)) < 3 then
    perform api._fail('INVALID', 'source_document_reference');
  end if;
  if p_source_signature is not null and p_source_signature not in ('SIGNED', 'UNSIGNED') then
    perform api._fail('INVALID', 'source_signature');
  end if;
  if (coalesce(p_source_signature, '') = 'UNSIGNED') <> (p_unsigned_attestation is not null) then
    perform api._fail('INVALID', 'unsigned_attestation');
  end if;
  if p_delegation_reference is not null then
    perform api._require_text(p_delegation_reference, 'delegation_reference', 3, 300);
  end if;
  if cardinality(v_sources) > 10
     or exists (select 1 from unnest(v_sources) x where x is null or length(btrim(x)) not between 3 and 300
                                                    or btrim(x) = btrim(p_source_document_reference))
     or (select count(distinct btrim(x)) from unnest(v_sources) x) <> cardinality(v_sources) then
    perform api._fail('INVALID', 'additional_source_references');
  end if;
  if p_outcome in ('APPROVE_PARTIALLY', 'MODIFY') then
    if p_item_outcomes is null or jsonb_typeof(p_item_outcomes) <> 'array'
       or jsonb_array_length(p_item_outcomes) <> cardinality(v_scope)
       or exists (select 1 from jsonb_array_elements(p_item_outcomes) e
                  where jsonb_typeof(e) <> 'object' or (e ->> 'item_id') is null
                     or not pg_input_is_valid(e ->> 'item_id', 'uuid')
                     or not ((e ->> 'item_id')::uuid = any (v_scope))
                     or coalesce(e ->> 'outcome', '') not in ('APPROVED', 'REJECTED', 'MODIFIED')
                     or ((e ->> 'outcome') = 'MODIFIED') <> (e ->> 'modification' is not null))
       or (select count(distinct e ->> 'item_id') from jsonb_array_elements(p_item_outcomes) e) <> cardinality(v_scope) then
      perform api._fail('INVALID', 'item_outcomes');
    end if;
  elsif p_item_outcomes is not null then
    perform api._fail('INVALID', 'item_outcomes');
  end if;
  if p_conditions is not null then
    if p_outcome not in ('APPROVE_AS_RECOMMENDED', 'APPROVE_PARTIALLY', 'MODIFY')
       or jsonb_typeof(p_conditions) <> 'array' or jsonb_array_length(p_conditions) not between 1 and 20
       or exists (select 1 from jsonb_array_elements(p_conditions) e
                  where jsonb_typeof(e) <> 'object'
                     or coalesce(e ->> 'kind', '') not in ('CORRECTIVE_ACTION', 'FOLLOW_UP_TASK', 'FREE_TEXT')
                     or length(btrim(coalesce(e ->> 'text', ''))) not between 5 and 2000
                     or (e ->> 'item_id' is not null
                         and (not pg_input_is_valid(e ->> 'item_id', 'uuid') or not ((e ->> 'item_id')::uuid = any (v_scope))))
                     or (e ->> 'due_date' is not null and not pg_input_is_valid(e ->> 'due_date', 'date'))) then
      perform api._fail('INVALID', 'conditions');
    end if;
  end if;
  -- DEC-AMB-003: a tainted package is only returned to the committee until the committee resolves the taint.
  if p_outcome <> 'RETURN_TO_COMMITTEE' and decision.package_tainted(v_p.id) then
    perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT');
  end if;

  insert into decision.authority_decision (package_id, case_id, package_round, authority_type, outcome, decided_at,
                                           decided_by_label, source_document_reference, reason, recorded_by,
                                           submission_id, delegation_reference, source_signature, unsigned_attestation)
  values (v_p.id, v_p.case_id, v_p.round_no, p_authority_type, p_outcome, p_decided_at,
          api._require_text(p_decided_by_label, 'decided_by_label', 3, 200),
          api._require_text(p_source_document_reference, 'source_document_reference', 3, 300),
          case when p_reason is not null then api._require_text(p_reason, 'reason', 5, 4000) end, v_actor,
          v_submission, btrim(p_delegation_reference), p_source_signature,
          case when p_unsigned_attestation is not null
               then api._require_text(p_unsigned_attestation, 'unsigned_attestation', 10, 2000) end)
  returning id into v_id;
  if p_item_outcomes is not null then
    insert into decision.authority_item_decision (decision_id, item_id, outcome, modification)
    select v_id, (e ->> 'item_id')::uuid, e ->> 'outcome',
           case when e ->> 'modification' is not null then api._require_text(e ->> 'modification', 'modification', 5, 4000) end
    from jsonb_array_elements(p_item_outcomes) e;
  end if;
  insert into decision.authority_decision_scope (decision_id, item_id, authority_type, rule_id, item_outcome)
  select v_id, q.item_id, q.authority_type, q.rule_id,
         case p_outcome
           when 'APPROVE_AS_RECOMMENDED' then 'APPROVED'
           when 'REJECT' then 'REJECTED'
           when 'RETURN_TO_COMMITTEE' then 'RETURNED'
           when 'OTHER' then 'OTHER'
           else (select e ->> 'outcome' from jsonb_array_elements(p_item_outcomes) e where (e ->> 'item_id')::uuid = q.item_id)
         end
  from decision.authority_requirement q
  where q.submission_id = v_submission and q.authority_type = p_authority_type and q.item_id = any (v_scope);
  insert into decision.authority_decision_source (decision_id, position, reference, is_primary)
  select v_id, 1, btrim(p_source_document_reference), true
  union all
  select v_id, 1 + o, btrim(x), false from unnest(v_sources) with ordinality u(x, o);
  if p_conditions is not null then
    insert into decision.authority_decision_condition (decision_id, position, kind, item_id, condition_text, due_date)
    select v_id, o, e ->> 'kind', (e ->> 'item_id')::uuid, btrim(e ->> 'text'), (e ->> 'due_date')::date
    from jsonb_array_elements(p_conditions) with ordinality u(e, o);
  end if;
  -- AMB-100: an authority approves at most one item of an exclusivity group.
  if exists (select 1 from decision.recommendation_item i
             where i.package_id = v_p.id and i.status = 'ACTIVE' and i.exclusivity_group is not null
               and exists (select 1 from decision.authority_decision d
                           join decision.authority_decision_scope sc on sc.decision_id = d.id
                           where d.package_id = v_p.id and d.package_round = v_p.round_no and sc.item_id = i.id
                             and sc.item_outcome in ('APPROVED', 'MODIFIED'))
             group by i.exclusivity_group having count(*) > 1) then
    perform api._fail('CONFLICT', 'EXCLUSIVITY_GROUP_VIOLATION');
  end if;

  v_complete := not exists (
    select 1 from decision.authority_requirement q
    where q.submission_id = v_submission
      and not exists (select 1 from decision.authority_decision d
                      join decision.authority_decision_scope sc on sc.decision_id = d.id
                      where d.package_id = v_p.id and d.package_round = v_p.round_no
                        and d.authority_type = q.authority_type and sc.item_id = q.item_id));
  v_disagreement := exists (
    select 1 from decision.authority_decision d
    join decision.authority_decision_scope sc on sc.decision_id = d.id
    where d.package_id = v_p.id and d.package_round = v_p.round_no
    group by sc.item_id having count(distinct sc.item_outcome) > 1);
  v_status := case when p_outcome = 'RETURN_TO_COMMITTEE' then 'RETURNED_BY_AUTHORITY'
                   when v_complete and v_disagreement then 'RETURNED_BY_AUTHORITY'
                   when v_complete then 'DECIDED'
                   else 'AWAITING_AUTHORITY' end;
  update decision.recommendation_package
     set status = v_status, decided_at = case when v_status = 'DECIDED' then now() end,
         updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event('AUTHORITY_DECISION_RECORDED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'authority_decision', v_id::text,
    null, jsonb_build_object('package_id', v_p.id, 'round_no', v_p.round_no, 'authority_type', p_authority_type,
                             'outcome', p_outcome, 'package_status', v_status,
                             'item_outcomes', coalesce(jsonb_array_length(p_item_outcomes), 0),
                             'scope_items', cardinality(v_scope), 'submission_id', v_submission,
                             'submission_backfilled', v_backfilled, 'source_signature', p_source_signature,
                             'has_delegation_reference', p_delegation_reference is not null,
                             'sources', 1 + cardinality(v_sources),
                             'conditions', coalesce(jsonb_array_length(p_conditions), 0)));
  return v_id;
end;
$$;

-- The 1900 signature: no delegation reference, signature, further sources or conditions.
create or replace function api.record_authority_decision(
  p_package_id uuid, p_authority_type text, p_outcome text, p_decided_at timestamptz, p_decided_by_label text,
  p_source_document_reference text, p_item_outcomes jsonb, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  return api.record_authority_decision(p_package_id, p_authority_type, p_outcome, p_decided_at, p_decided_by_label,
                                       p_source_document_reference, p_item_outcomes, p_reason, null::text, null::text,
                                       null::text, null::text[], null::jsonb);
end;
$$;

grant execute on function
  api.set_sanction_catalogue_entry(text, text, text, text, text, text[], text, timestamptz, text, text, text),
  api.set_legal_review_rule(text, text, text, text, timestamptz, text, text),
  api.set_action_authority_rule(text, text[], timestamptz, text, text),
  api.authority_rule_coverage(),
  api.add_recommendation_item(uuid, text, text, text, text, uuid[], uuid[], boolean, uuid[], text),
  api.return_package_to_committee(uuid, text),
  api.recommendation_item_flags(uuid),
  api.approve_restricted_legal_review(uuid, uuid, uuid[], uuid[], text),
  api.cancel_legal_review_request(uuid, text),
  api.give_superseding_legal_opinion(uuid, text, text),
  api.resolve_conflict_taint(uuid, text, text),
  api.record_authority_decision(uuid, text, text, timestamptz, text, text, jsonb, text, text, text, text, text[], jsonb)
to authenticated;

-- -----------------------------------------------------------------------------
-- The form and status catalogue (migration 1970) follows the schema
-- -----------------------------------------------------------------------------
insert into config.status_dimension_value (dimension, value, state, derivation, source_status) values
  ('LEGAL_REVIEW_STATUS', 'CANCELLED', 'ACTIVE', null, 'OWNER_DEFAULT');

update config.target_module
   set commands = commands || array['api.return_package_to_committee', 'api.recommendation_item_flags',
                                    'api.set_sanction_catalogue_entry', 'api.resolve_conflict_taint'],
       delivered_in = case when '2030' = any (delivered_in) then delivered_in else delivered_in || '2030'::text end,
       notes = notes || ' Since 2030: sanction catalogue versions (DEC-F11), adoption snapshots, defence-notice guard, '
                        'dependencies and exclusivity groups, conflict taint and its resolution by the committee '
                        '(DEC-AMB-003), return to the committee before submission.'
 where code = 'RECOMMENDATION_PACKAGE';
update config.target_module
   set commands = commands || array['api.cancel_legal_review_request', 'api.give_superseding_legal_opinion',
                                    'api.set_legal_review_rule'],
       delivered_in = case when '2030' = any (delivered_in) then delivered_in else delivered_in || '2030'::text end,
       notes = notes || ' Since 2030: configurable legal-review rules (DEC-F12), cancellation, superseding opinions, '
                        'restricted approval scope (DEC-F20); the reviewer''s packet ends with the authority decision.'
 where code = 'LEGAL_REVIEW';
update config.target_module
   set commands = commands || array['api.authority_rule_coverage'],
       delivered_in = case when '2030' = any (delivered_in) then delivered_in else delivered_in || '2030'::text end,
       notes = notes || ' Since 2030: fail closed without a rule (DEC-F13), rule snapshot per submission, one decision '
                        'per authority, joint authorities, delegation and signature attributes, conditions.'
 where code = 'AUTHORITY_DECISION';
update config.target_module
   set delivered_in = case when '2030' = any (delivered_in) then delivered_in else delivered_in || '2030'::text end,
       notes = notes || ' Since 2030: a case that is not a direct referral needs an approved preliminary recommendation '
                        'REFERRED_TO_COMMITTEE (AMB-018).'
 where code = 'COMMITTEE_REFERRAL';

-- =============================================================================
-- Section 4. Purpose read models for a meeting and its minutes, and two content-free meeting notifications
-- (Phase 12 asks §6 (b) and (c), coordinator 2026-10-13; requirements §19, §21, §39, §40, §82, §87; DEC-02,
-- DEC-F01, DEC-F04, DEC-F07; AMB-083; ADR-020, ADR-025, ADR-039, ADR-040). It changes no command and no predicate.
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

-- DEC-F04: the decider of a raised conflict. Candidates are the meeting's users, the committee's current seat holders
-- and its conflict authorities in force; the decision rule the command uses (committee.concern_decider_seat_for) picks
-- among them, asked about each candidate by user id. The request identity is never changed. Never the raiser or the
-- subject.
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
    if committee.concern_decider_seat_for(new.id, v_user) is not null then
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

revoke all on function notify.on_meeting_conflict_concern(), notify.on_vote_item() from public, anon, authenticated;
