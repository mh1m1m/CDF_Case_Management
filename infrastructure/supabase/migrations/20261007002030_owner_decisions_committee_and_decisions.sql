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
--     enforced while null), minutes_objection_blocks_deemed (AMB-092), sanction_requires_defence_notice (AMB-026);
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
                                  grievance_completion_days)
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
          case when v_c.kind = 'GRIEVANCE' then v_current.grievance_completion_days end)
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
    'non_admission_decider', 'grievance_completion_days'];
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
     or v_new.sanction_requires_defence_notice is null then
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
                                  grievance_completion_days)
  values (v_current.committee_id, v_at, v_current.quorum_type, v_current.quorum_value, v_current.casting_vote_enabled,
          v_current.minutes_review_business_days, v_current.deemed_approval_enabled, 30,
          v_current.admissibility_decider, v_current.no_substantive_vote_outcome, 'OWNER_DEFAULT',
          'Owner Finalization Set 2026-10-13: DEC-F14 (30 days), DEC-F15 (from delivery), DEC-F17 (committee decides non-admission).',
          v_current.conflict_decider, v_current.decision_rule, v_current.acting_chair_casting_vote,
          v_current.vote_revision_allowed, v_current.ballot_secrecy, v_current.minimum_notice_days,
          v_current.minutes_objection_blocks_deemed, v_current.sanction_requires_defence_notice, 'DELIVERY', 'COMMITTEE',
          null);
end;
$$;
