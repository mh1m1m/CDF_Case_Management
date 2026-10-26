-- =============================================================================
-- 2128 Seats and positions: an end dated in the past only with its decree or source reference, and the Administration
-- pages' seat and position flags (UX redesign Phase 12, slice P12-8b; ADR-064)
-- Requirements: the owner's decision on the P12-8 F7 card (2026-10-19 01:22 UTC, option B, "Backdated with record"):
-- "A past effective date is allowed only with a decree or source reference recorded on the row and an audit event (ids
-- only), fail-closed otherwise." The coordinator's allocation (2026-10-19 01:30): migration 2128 and ADR-064, on the
-- main that carries 2127 (ADR-063), after it and before 2130; an end_reference on committee.membership and
-- iam.sector_membership, protected once set; the two end commands take it as a new last argument with the old
-- signature dropped and refuse a past end without it, fail-closed; may_appoint per committee and per sector, may_end
-- per seat and per position, each flag its command's answer; audit events ids only. The coordinator's ruling on the
-- P12-8 forks (2026-10-18 12:27): F5, the seat and head appointment forms wait (the owner's F5 card of 2026-10-19 01:31
-- is open). ADR-063; UX-116 (a screen offers an action from server capabilities). Linear CDF-269, under CDF-266.
--
-- Before:
--   * An appointment already met the owner's decision, whatever its start date: api.appoint_committee_member (1870) and
--     api.appoint_sector_member (1880, 2127) record the decree or source reference on the row (appointment_reference,
--     required, 3 to 200 characters) and an audit event that names the row with ids and codes, never the reference.
--     Nothing here changes them.
--   * An end did not: api.end_committee_membership (1870) and api.end_sector_membership (1880) accepted an end dated
--     in the past (after the start, and not after the end already set) with a reason only. No reference was recorded.
--   * No read said whether a committee or a sector would accept an appointment from the caller, or whether a seat or a
--     position could be ended, so the Administration pages could offer neither (ADR-063 §8).
--
-- After:
--   * committee.membership and iam.sector_membership gain end_reference (null, or 3 to 200 characters): the decree or
--     source reference of the end. A check keeps it off a row that is not ended. The tables' triggers already refuse
--     any change to an ended row; they now let end_reference through only on the update that ends the row, so once
--     set it never changes.
--   * A table check: a row ended from now on with an end before the moment it is ended (ended_at, the end command's
--     now()) carries its reference. It is added NOT VALID, as 2030 did for meeting_conflict: rows ended before this
--     migration are history and are never rewritten, and every end written from now on is checked.
--   * api.end_committee_membership(p_membership_id, p_effective_to, p_reason, p_end_reference) and
--     api.end_sector_membership(p_membership_id, p_effective_to, p_reason, p_end_reference): the reference is the new
--     last argument (default null, for an end now or later). The old signatures are dropped: no overload without the
--     check remains. An end before now() is refused without a reference of 3 to 200 characters
--     (CDF_INVALID:end_reference), after every check the command made before, and nothing is written. A reference given
--     with an end now or later is checked the same way and recorded. Everything else is as built: the owner, the grant,
--     the checks and their order, the lock, the notification and the audit event, which names the row and carries
--     neither the reference nor the reason in its metadata (the reason stays in the event's own reason field).
--   * api.admin_committee_capabilities(): each committee also gives may_appoint and lists its seats, each with may_end.
--   * api.admin_sector_capabilities(): also lists the sectors, each with may_appoint and its positions, each with
--     may_end.
--
-- How each flag is computed (coordinator, 2026-10-14 11:53, as for 2127): with its command's checks, in the command's
-- order, without taking a lock and without writing. Input checks are the command's to answer at submit: for an
-- appointment, the seat or position, the person (active, not external, never the caller), the dates (overlap, a seat or
-- the head's position already held) and the reference; for an end, the date, the reason and the reference.
--
-- F5 holds the appointment forms until the owner answers its card: no page reads may_appoint yet.
--
-- What a flag tells (AGENT-09, to clear): nothing its command would not answer, and only to whoever holds the page's
-- permission, whose registers already show every row these reads name (row-level security: the seats to
-- COMMITTEE_ADMIN and to the committee's members, 1870; the positions to SECTOR_ADMIN, 1880). Ids and booleans only.
--
-- Controls:
--   * Two columns and three checks on each table, two trigger functions and two commands replaced, two reads replaced
--     with the same signature, owner and grant. No table grant, policy or row-level security changes; nothing is
--     deleted.
--   * Each read stays SECURITY DEFINER with search_path '', stable, takes no lock, writes nothing and records nothing.
--     Every flag is a boolean, never null; every list is a list.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The end's reference, on the row
-- -----------------------------------------------------------------------------
alter table committee.membership
  add column end_reference text check (length(end_reference) between 3 and 200),
  add constraint membership_end_reference_on_end check (end_reference is null or ended_at is not null);
alter table committee.membership
  add constraint membership_past_end_has_reference
  check (ended_at is null or effective_to >= ended_at or end_reference is not null) not valid;
comment on column committee.membership.end_reference is
  'The decree or source reference of the end (owner decision F7 = B, 2026-10-19; migration 2128). Required when the end '
  'is dated before the moment it is recorded; written with the end and never changed.';

alter table iam.sector_membership
  add column end_reference text check (length(end_reference) between 3 and 200),
  add constraint sector_membership_end_reference_on_end check (end_reference is null or ended_at is not null);
alter table iam.sector_membership
  add constraint sector_membership_past_end_has_reference
  check (ended_at is null or effective_to >= ended_at or end_reference is not null) not valid;
comment on column iam.sector_membership.end_reference is
  'The decree or source reference of the end (owner decision F7 = B, 2026-10-19; migration 2128). Required when the end '
  'is dated before the moment it is recorded; written with the end and never changed.';

-- -----------------------------------------------------------------------------
-- 2. The registries' triggers: the reference moves only with the end
-- -----------------------------------------------------------------------------
-- As in 1870, with end_reference among the columns the update that ends a seat may set. Every other branch is as built.
create or replace function committee.protect_registry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'committee' then
    if new.id <> old.id or new.code <> old.code or new.kind <> old.kind or new.created_at <> old.created_at then
      raise exception 'committee % identity fields are immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'membership' then
    -- Only the end of the period may move, and only earlier; history is never rewritten (Q30). The end's reason and
    -- reference are written with it, once (2128).
    if (to_jsonb(new) - array['effective_to', 'ended_by', 'ended_at', 'end_reason', 'end_reference'])
       <> (to_jsonb(old) - array['effective_to', 'ended_by', 'ended_at', 'end_reason', 'end_reference'])
       or old.ended_at is not null
       or (old.effective_to is not null and (new.effective_to is null or new.effective_to > old.effective_to)) then
      raise exception 'membership % can only be ended earlier, once', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'rule_set' then
    if (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') or old.effective_to is not null then
      raise exception 'rule set % can only be given an end, once', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'restricted_referral_approval' then
    if (to_jsonb(new) - array['committee_proceeding_id', 'used_at']) <> (to_jsonb(old) - array['committee_proceeding_id', 'used_at'])
       or old.committee_proceeding_id is not null then
      raise exception 'restricted referral approval % is used once and never rewritten', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'committee_proceeding' then
    if (to_jsonb(new) - array['status', 'closed_at']) <> (to_jsonb(old) - array['status', 'closed_at'])
       or old.status <> 'OPEN' then
      raise exception 'committee proceeding % snapshot is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

-- As in 1880, with end_reference among the columns the update that ends a position may set. Every other branch is as
-- built.
create or replace function iam.protect_sector_registry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'sector' then
    if new.id <> old.id or new.code <> old.code or new.created_at <> old.created_at then
      raise exception 'sector % identity fields are immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'sector_membership' then
    -- The end's reason and reference are written with it, once (2128).
    if (to_jsonb(new) - array['effective_to', 'ended_by', 'ended_at', 'end_reason', 'end_reference'])
       <> (to_jsonb(old) - array['effective_to', 'ended_by', 'ended_at', 'end_reason', 'end_reference'])
       or old.ended_at is not null
       or (old.effective_to is not null and (new.effective_to is null or new.effective_to > old.effective_to)) then
      raise exception 'sector membership % can only be ended earlier, once', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'sector_delegation' then
    if (to_jsonb(new) - array['revoked_by', 'revoked_at', 'revoke_reason'])
       <> (to_jsonb(old) - array['revoked_by', 'revoked_at', 'revoke_reason'])
       or old.revoked_at is not null then
      raise exception 'delegation % can only be revoked, once', old.id using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. The end commands: a past end only with its reference (F7 = B)
-- -----------------------------------------------------------------------------
-- The old signatures are dropped, so no overload without the check remains (as 2127 did for its version checks).
drop function api.end_committee_membership(uuid, timestamptz, text);
drop function api.end_sector_membership(uuid, timestamptz, text);

-- As in 1870, with the reference: required for an end before now(), checked when given, recorded on the row.
create function api.end_committee_membership(
  p_membership_id uuid, p_effective_to timestamptz, p_reason text, p_end_reference text default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.membership;
  v_reason text;
  v_reference text;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  select * into v_m from committee.membership m where m.id = p_membership_id;
  if v_m.id is null then perform api._fail('NOT_FOUND'); end if;
  perform committee.lock_committee(v_m.committee_id);
  if v_m.ended_at is not null then perform api._fail('CONFLICT', 'MEMBERSHIP_ENDED'); end if;
  if p_effective_to is null or p_effective_to <= v_m.effective_from
     or (v_m.effective_to is not null and p_effective_to > v_m.effective_to) then
    perform api._fail('INVALID', 'effective_to');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  -- 2128 (F7 = B): an end dated before now is recorded only with its decree or source reference; fail closed.
  if p_effective_to < now() or p_end_reference is not null then
    v_reference := api._require_text(p_end_reference, 'end_reference', 3, 200);
  end if;

  update committee.membership
     set effective_to = p_effective_to, ended_by = v_actor, ended_at = now(), end_reason = v_reason,
         end_reference = v_reference
   where id = v_m.id;
  perform audit.record_event('COMMITTEE_MEMBERSHIP_ENDED', 'ADMIN', 'SUCCESS', null, 'committee_membership', v_m.id::text, v_reason,
    jsonb_build_object('committee_id', v_m.committee_id, 'user_id', v_m.user_id, 'seat', v_m.seat,
                       'effective_to', p_effective_to));
end;
$$;

-- As in 1880, with the reference: required for an end before now(), checked when given, recorded on the row. No end
-- date still means now.
create function api.end_sector_membership(
  p_membership_id uuid, p_effective_to timestamptz, p_reason text, p_end_reference text default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m iam.sector_membership;
  v_to timestamptz := coalesce(p_effective_to, now());
  v_reason text;
  v_reference text;
begin
  if not authz.has_permission('SECTOR_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  select * into v_m from iam.sector_membership m where m.id = p_membership_id;
  if v_m.id is null then perform api._fail('NOT_FOUND'); end if;
  perform iam.lock_sector(v_m.sector_id);
  select * into v_m from iam.sector_membership m where m.id = p_membership_id for update;
  if v_m.ended_at is not null then perform api._fail('CONFLICT', 'MEMBERSHIP_ALREADY_ENDED'); end if;
  if v_to <= v_m.effective_from or (v_m.effective_to is not null and v_to > v_m.effective_to) then
    perform api._fail('INVALID', 'effective_to');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  -- 2128 (F7 = B): an end dated before now is recorded only with its decree or source reference; fail closed.
  if v_to < now() or p_end_reference is not null then
    v_reference := api._require_text(p_end_reference, 'end_reference', 3, 200);
  end if;
  update iam.sector_membership
     set effective_to = v_to, ended_by = v_actor, ended_at = now(), end_reason = v_reason, end_reference = v_reference
   where id = v_m.id;
  perform audit.record_event('SECTOR_MEMBERSHIP_ENDED', 'ADMIN', 'SUCCESS', null, 'sector_membership', v_m.id::text, v_reason,
    jsonb_build_object('sector_id', v_m.sector_id, 'user_id', v_m.user_id, 'position', v_m.position, 'effective_to', v_to));
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. The pages' seat and position flags
-- -----------------------------------------------------------------------------
-- As in 2127, with may_appoint per committee and may_end per seat. Deactivation, reactivation and seat corrections
-- still wait for P12-8c (F9).
create or replace function api.admin_committee_capabilities()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_admin boolean;
begin
  perform api._actor();
  v_admin := coalesce(authz.has_permission('COMMITTEE_ADMIN'), false);
  if not v_admin then perform api._fail('FORBIDDEN'); end if;
  return jsonb_build_object(
    'committees', coalesce((
      select jsonb_agg(jsonb_build_object(
               'committee_id', c.id,
               -- api.set_committee_rule_set: the caller check, then the committee (committee.lock_committee: it
               -- exists). Every option and the start (RULE_SET_SCHEDULED) are inputs.
               'may_set_rule_set', v_admin,
               -- api.revise_committee_rule_set: the same, then a version open to revise (NO_RULE_SET).
               'may_revise_rule_set', coalesce(v_admin and exists (
                 select 1 from committee.rule_set r where r.committee_id = c.id and r.effective_to is null), false),
               -- api.appoint_committee_member: the caller check, then the committee (committee.lock_committee: it
               -- exists). The seat, the person (active, not external, never the caller: SELF_APPOINTMENT), the dates
               -- (MEMBERSHIP_OVERLAP, SEAT_OCCUPIED) and the reference are inputs.
               'may_appoint', v_admin,
               -- api.end_committee_membership: the caller check, then the seat (committee.lock_committee), then not
               -- ended (MEMBERSHIP_ENDED). The date, the reason and the reference (F7 = B) are inputs.
               'seats', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'membership_id', m.id,
                          'may_end', coalesce(v_admin and m.ended_at is null, false))
                        order by m.effective_from, m.id)
                   from committee.membership m
                  where m.committee_id = c.id), '[]'::jsonb))
             order by c.code collate "C", c.id)
        from committee.committee c), '[]'::jsonb));
end;
$$;

-- As in 2127, with each sector's may_appoint and its positions' may_end.
create or replace function api.admin_sector_capabilities()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_admin boolean;
begin
  v_admin := coalesce(authz.has_permission('SECTOR_ADMIN'), false);
  if not v_admin then perform api._fail('FORBIDDEN'); end if;
  return jsonb_build_object(
    -- api.create_sector: the caller check. The code and the names (SECTOR_CODE_TAKEN) are inputs.
    'may_create_sector', v_admin,
    'sectors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sector_id', s.id,
               -- api.appoint_sector_member: the caller check, then the sector (iam.lock_sector: it exists). The
               -- position, the person (active, not external, never the caller: SELF_APPOINTMENT, 2127), the dates
               -- (MEMBERSHIP_OVERLAP, SECTOR_HEAD_OCCUPIED) and the reference are inputs.
               'may_appoint', v_admin,
               -- api.end_sector_membership: the caller check, then the position (iam.lock_sector), then not ended
               -- (MEMBERSHIP_ALREADY_ENDED). The date, the reason and the reference (F7 = B) are inputs.
               'positions', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'membership_id', m.id,
                          'may_end', coalesce(v_admin and m.ended_at is null, false))
                        order by m.effective_from, m.id)
                   from iam.sector_membership m
                  where m.sector_id = s.id), '[]'::jsonb))
             order by s.code collate "C", s.id)
        from iam.sector s), '[]'::jsonb),
    -- api.revoke_referral_delegation: a delegation the caller may see (its delegator, its delegate or SECTOR_ADMIN),
    -- the caller its delegator or SECTOR_ADMIN, then not revoked and not ended (DELEGATION_NOT_ACTIVE).
    'delegations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'delegation_id', d.id,
               'may_revoke', coalesce((d.delegator_id = v_actor or v_admin)
                                      and d.revoked_at is null and d.effective_to > now(), false))
             order by d.sector_id, d.effective_from, d.id)
        from iam.sector_delegation d), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Grants
-- -----------------------------------------------------------------------------
-- The two reads keep theirs (create or replace). The two commands are new functions: granted as 1870 and 1880 granted
-- the ones they replace.
revoke all on function
  api.end_committee_membership(uuid, timestamptz, text, text),
  api.end_sector_membership(uuid, timestamptz, text, text)
from public;
grant execute on function
  api.end_committee_membership(uuid, timestamptz, text, text),
  api.end_sector_membership(uuid, timestamptz, text, text)
to authenticated;
