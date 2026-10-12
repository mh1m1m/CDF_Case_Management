-- =============================================================================
-- 2010 Excluding a witness from a committee meeting (Business Architecture Rebase phase 11, gap P11-G4, witness half;
-- CDF-198, CDF-190)
-- Requirements: §19, §21, §29, §87; owner Q&A Q41, Q47, Q49; ADR-020, ADR-035, ADR-039; coordinator ruling on the
-- access effect (SOURCE_REQUIRED, pending the owner)
--
-- Migration 1890 invites witnesses, experts, legal advisers, information providers and the subject to a meeting, but
-- nothing takes an invitee out again: only cancelling the whole meeting exists. The owner's catalogues name a witness
-- exclusion with a recorded reason (T3-B2.4-241, CRM-F118; status S112 «استبعاد شاهد»). Gap P11-G4
-- (FORM_CATALOGUE_RATIONALIZATION §6), witness half; its evidence half waits for the UX S2 evidence commands (#55).
-- This migration adds:
--   * api.exclude_meeting_witness(participant, reason). The secretary running the meeting excludes a WITNESS invitee,
--     once, while the meeting is SCHEDULED or OPEN and no concern about that witness is open. Other invitee roles are
--     not covered (SOURCE_REQUIRED): excluding the subject from their own hearing, or a legal adviser, is a rights
--     question for the owner.
--   * committee.witness_exclusion (append-only, RLS): the reason, read by the secretary running the meeting and the
--     members cleared for its deliberation, never by the witness. The ledger gets WITNESS_EXCLUDED with ids only.
--   * The excluded witness loses the meeting (coordinator ruling, SOURCE_REQUIRED): authz.can_view_meeting is replaced
--     with one change, "and not excluded" in its participant branch. Every other branch, the signature, SECURITY
--     DEFINER and search_path are as in 1890. A witness who also sees the meeting another way (on the committee
--     proceeding or the case team) keeps that view.
--   * An excluded witness's participant row is final: the exclusion never changes it (attendance and conflict history
--     stay as recorded), and nothing changes it afterwards; no concern is raised about them.
--
-- Controls:
--   * Additive and non-destructive: one append-only table with RLS (SELECT only, no write grants), one command, two
--     triggers, and one predicate narrowed. No command body changes; nothing is dropped, renamed or deleted.
--   * The reason stays in its row; the audit event carries ids only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The exclusion record
-- -----------------------------------------------------------------------------
create table committee.witness_exclusion (
  id             uuid primary key default gen_random_uuid(),
  meeting_id     uuid not null references committee.meeting (id),
  participant_id uuid not null unique references committee.meeting_participant (id),
  reason         text not null check (length(reason) between 10 and 2000),
  excluded_by    uuid not null references iam.user_profile (id),
  excluded_at    timestamptz not null default clock_timestamp()
);
create index witness_exclusion_meeting on committee.witness_exclusion (meeting_id);
create index witness_exclusion_excluded_by on committee.witness_exclusion (excluded_by);
comment on table committee.witness_exclusion is
  'A witness excluded from a committee meeting, with the reason (T3-B2.4-241, CRM-F118, S112; migration 2010, ADR-039). '
  'Final for the meeting. The reason is read by the secretary running the meeting and the members cleared for its '
  'deliberation, never by the witness.';

-- -----------------------------------------------------------------------------
-- Integrity
-- -----------------------------------------------------------------------------
create trigger no_update before update on committee.witness_exclusion
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on committee.witness_exclusion
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on committee.witness_exclusion
  for each statement execute function committee.reject_mutation();

-- An excluded witness's participant row is final, and no conflict concern is raised about them (every path: attendance,
-- an excuse, a declaration, the decision on a concern, raising one).
create function committee.refuse_excluded_participant()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_participant uuid;
begin
  if tg_table_name = 'meeting_participant' then
    v_participant := old.id;
  else
    v_participant := new.participant_id;
  end if;
  if exists (select 1 from committee.witness_exclusion x where x.participant_id = v_participant) then
    perform api._fail('CONFLICT', 'WITNESS_EXCLUDED');
  end if;
  return new;
end;
$$;
create trigger meeting_participant_not_excluded before update on committee.meeting_participant
  for each row execute function committee.refuse_excluded_participant();
create trigger meeting_conflict_concern_not_excluded before insert on committee.meeting_conflict_concern
  for each row execute function committee.refuse_excluded_participant();

-- -----------------------------------------------------------------------------
-- Meeting logistics: the 1890 predicate, an excluded witness no longer seeing the meeting through their participation
-- -----------------------------------------------------------------------------
create or replace function authz.can_view_meeting(p_meeting_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from committee.meeting m
    where m.id = p_meeting_id
      and (authz.can_view_committee_proceeding(m.committee_proceeding_id)
           or exists (select 1 from committee.meeting_participant mp
                      where mp.meeting_id = m.id and mp.user_id = authz.current_user_id()
                        and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id))
               and authz.user_case_gate(authz.current_user_id(), m.case_id))
  );
$$;

-- -----------------------------------------------------------------------------
-- RLS (SELECT only; no write grants)
-- -----------------------------------------------------------------------------
alter table committee.witness_exclusion enable row level security;

create policy witness_exclusion_read on committee.witness_exclusion for select to authenticated
  using (authz.can_view_meeting_deliberation(meeting_id));
grant select on committee.witness_exclusion to authenticated;

-- -----------------------------------------------------------------------------
-- Command
-- -----------------------------------------------------------------------------
-- T3-B2.4-241: the secretary running the meeting excludes a witness, with the reason.
create function api.exclude_meeting_witness(p_participant_id uuid, p_reason text)
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
  if v_m.status not in ('SCHEDULED', 'OPEN') then perform api._fail('CONFLICT', 'MEETING_NOT_ACTIVE'); end if;
  -- Only a witness: the subject, a legal adviser, an expert or an information provider is not covered (SOURCE_REQUIRED).
  if v_p.participant_kind <> 'INVITEE' or v_p.invitee_role <> 'WITNESS' then
    perform api._fail('INVALID', 'participant');
  end if;
  if exists (select 1 from committee.witness_exclusion x where x.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'ALREADY_EXCLUDED');
  end if;
  -- A concern about the witness is decided first, so none is left open on someone no longer in the meeting.
  if exists (select 1 from committee.meeting_conflict_concern c where c.participant_id = v_p.id and c.status = 'OPEN') then
    perform api._fail('CONFLICT', 'CONCERN_OPEN');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);

  insert into committee.witness_exclusion (meeting_id, participant_id, reason, excluded_by)
  values (v_m.id, v_p.id, v_reason, v_actor)
  returning id into v_id;
  -- The reason stays in the exclusion row; the ledger gets ids only.
  perform audit.record_event('WITNESS_EXCLUDED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'witness_exclusion', v_id::text,
    null, jsonb_build_object('meeting_id', v_m.id, 'participant_id', v_p.id));
  return v_id;
end;
$$;
grant execute on function api.exclude_meeting_witness(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- The form and status catalogue (migration 1970) follows the schema
-- -----------------------------------------------------------------------------
update config.legacy_status_map
   set target_event_state = 'IMPLEMENTED',
       target_object = 'committee.witness_exclusion',
       notes = 'A witness excluded with its reason since migration 2010 (P11-G4, witness half).',
       gap_ref = null
 where gap_ref = 'P11-G4' and legacy_code = 'S112';
update config.legacy_form_map
   set merge_target = 'api.exclude_meeting_witness (the reason in committee.witness_exclusion; the witness no longer '
                      'sees the meeting)',
       gap_ref = null
 where gap_ref = 'P11-G4' and legacy_id = 'T3-B2.4-241';
update config.target_module
   set commands = commands || 'api.exclude_meeting_witness'::text,
       delivered_in = delivered_in || '2010'::text,
       notes = 'Witnesses, experts and information providers as invitees; a witness may be excluded with a reason.'
 where code = 'MEETING_WITNESSES';
