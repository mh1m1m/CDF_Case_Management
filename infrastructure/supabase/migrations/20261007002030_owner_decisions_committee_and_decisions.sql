-- =============================================================================
-- 2030 Owner Finalization Set, part 1: committees, meetings, votes, minutes, recommendations, legal review and
-- authority decisions (Business Architecture Rebase; CDF-196 programme; DEC-F01–F07, F11–F13, F19, F20 and the
-- ambiguity register rows routed to this migration)
-- Requirements: owner decisions DEC-F01 to DEC-F41 (docs/business-architecture/OWNER_DECISIONS_FINALIZATION.md,
-- 2026-10-13); owner Q&A; ADR-019 to ADR-023, ADR-038, ADR-039; ADR-040 (this migration and 2040)
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
-- Running the meeting: the committee's current secretary, or its alternate secretary only while recorded as acting for
-- this meeting (AMB-042/050/066, CON-007); cleared for the case and not conflicted in the meeting, as in 1890.
create or replace function authz.can_manage_meeting(p_meeting_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from committee.meeting m
    join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
    where m.id = p_meeting_id
      and authz.is_committee_secretary(cp.committee_id)
      and (authz.user_committee_seat(authz.current_user_id(), cp.committee_id, now()) = 'SECRETARY'
           or exists (select 1 from committee.meeting_acting_role a
                      where a.meeting_id = m.id and a.acting_role = 'ACTING_SECRETARY'
                        and a.user_id = authz.current_user_id()))
      and authz.user_case_gate(authz.current_user_id(), m.case_id)
      and not exists (select 1 from committee.meeting_participant mp
                      where mp.meeting_id = m.id and mp.user_id = authz.current_user_id()
                        and mp.coi_status = 'CONFLICT_DECLARED')
  );
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

-- DEC-F04 (CON-006): the seat the current user decides a raised conflict as, or null. Under the CHAIR rule: the chair;
-- when no chair of the meeting is eligible (the raiser or the subject, conflicted, recorded absent or excused, no longer
-- seated, not cleared for the case, or none), the deputy chair if eligible; when neither is, the committee's
-- independent conflict authority in force (holding no seat on the committee and not in the meeting). Never the raiser,
-- never the subject, always cleared for the case. The SECRETARY rule (2000) is unchanged. Null when nobody qualifies.
create or replace function authz.meeting_concern_decider_seat(p_concern_id uuid)
returns text
language sql stable security definer
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
             case when authz.can_manage_meeting(k.meeting_id) then 'SECRETARY' end
           when exists (select 1 from eligible e where e.seat = 'CHAIR') then
             case when exists (select 1 from eligible e where e.seat = 'CHAIR' and e.user_id = authz.current_user_id())
                  then 'CHAIR' end
           when exists (select 1 from eligible e where e.seat = 'DEPUTY_CHAIR') then
             case when exists (select 1 from eligible e where e.seat = 'DEPUTY_CHAIR' and e.user_id = authz.current_user_id())
                  then 'DEPUTY_CHAIR' end
           when exists (select 1 from committee.conflict_authority a
                        where a.committee_id = k.committee_id and a.user_id = authz.current_user_id()
                          and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now())
                          and authz.user_committee_seat(a.user_id, k.committee_id, now()) is null
                          and not exists (select 1 from committee.meeting_participant mp
                                          where mp.meeting_id = k.meeting_id and mp.user_id = a.user_id)) then
             'CONFLICT_AUTHORITY'
         end
  from k
  where authz.current_user_id() is not null
    and authz.current_user_id() <> k.raised_by
    and authz.current_user_id() is distinct from k.subject_user
    and authz.user_case_gate(authz.current_user_id(), k.case_id);
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
