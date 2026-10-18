-- =============================================================================
-- 2127 Administration: capability reads, the caller's pages and three narrowings (UX redesign Phase 12, slice
-- P12-8b; ADR-063)
-- Requirements: Phase 12 plan §4 (P12-8); the P12-8 domain map (§5.2 to §5.5) and the coordinator's rulings on its
-- forks (2026-10-18 12:27): F1 (a control shows only on a database capability; the calendar's two P12-8a forms on
-- their command's exact caller check were the one exception), F2 (the registers stay row-level-security reads in the
-- caller's context), F3 (the caller's Administration pages come from the database), F6 (a sector administrator does
-- not appoint themselves; Linear CDF-259, Security LOW), F8 (a notification rule cannot be scheduled before a later one
-- of the same key; CDF-260) and F13 (an in-place administration update fails closed on a stale version); UX-116 (a
-- screen offers an action from server capabilities); ADR-051's P12-8a amendment. Linear CDF-266. Number and ADR
-- allocated by the coordinator (2026-10-18 19:50): it merges after 2125 and before 2130, narrowing only (nothing is
-- widened before 2160), with the negative tests of F6, F8 and F13 in the same change.
--
-- Before: the Administration pages (P12-8a) read their registers, but no read said which of their commands would
-- accept the caller, so no page could offer a control beyond the calendar's two forms, whose command checks nothing
-- but the caller's permission. The list of the caller's pages came from the application's permission check, not from
-- the database. A sector administrator could appoint themselves to a sector, its head included (CDF-259). Scheduling a
-- notification rule before a rule of the same key that starts later broke a table constraint, which the user saw as
-- "service unavailable" (CDF-260). The export purposes, the invitee types and the sanction rules were updated in place
-- with no version check, so an administrator could overwrite a change they never saw.
--
-- After:
--   * api.my_admin_views(): the caller's Administration pages, in the order api.my_areas (2045) picks the area's
--     default view, on the same checks: users (USER_ADMIN or ROLE_ADMIN), committees, sectors, notification rules,
--     export policy (authz.is_export_policy_admin, DEC-F24), corrective-action policy and the business calendar.
--   * Six capability reads, one per page, each refused (FORBIDDEN) to whoever does not hold its page's permission:
--     api.admin_calendar_capabilities, api.admin_committee_capabilities, api.admin_sector_capabilities,
--     api.admin_notification_rule_capabilities, api.admin_export_policy_capabilities and
--     api.admin_corrective_action_policy_capabilities. Each returns the page's flags and, where a control acts on a
--     row, the row's id with its flags: a calendar day's withdrawal, a committee's rule-set version and revision, a
--     sector's creation and a referral-approval delegation's revocation, a notification rule, an export rule and an
--     export purpose, a corrective-action policy. The registers themselves are not read here: the pages keep reading
--     them in the caller's context, under row-level security (F2), and match the flags to the rows by id.
--   * api.appoint_sector_member refuses the caller appointing themselves (CONFLICT:SELF_APPOINTMENT, the code
--     api.appoint_committee_member uses, 1870). Same signature, owner and grant.
--   * api.set_notification_rule refuses a rule that would start at or before a rule of the same key, in force or
--     scheduled (CONFLICT:LATER_RULE_EXISTS, the code api.set_export_rule uses, 2040), under a lock on the key, as that
--     command does. Same signature, owner and grant.
--   * exchange.export_purpose, committee.invitee_type_rule and decision.sanction_catalogue gain row_version (1 for
--     every existing row). api.set_export_purpose, api.set_invitee_type_rule and api.set_sanction_rule take the
--     version the caller read (p_expected_version, last) and refuse any other (CONFLICT:STALE_VERSION, the code of
--     api.update_case_details, 0700), a null included; a new export purpose is created only with none, under a lock on
--     its code. Each success raises the version by one. The old signatures are dropped: no overload without the check
--     remains.
--
-- How each capability is computed (coordinator, 2026-10-14 11:53, as for 2065, 2085, 2086, 2095 and 2096): with the
-- checks its command makes, in the command's order, without taking a lock and without writing. Input checks (dates,
-- codes, names, values, the person appointed, the version read) are the command's to answer at submit.
--
-- What a capability tells (AGENT-09, to clear): nothing its command would not answer, and only to whoever holds the
-- page's permission, whose registers already show every row these reads name (row-level security: the calendar, the
-- committees and the export purposes to every signed-in user; the rule sets to COMMITTEE_ADMIN, 1870; the
-- delegations to SECTOR_ADMIN, 1880). Ids and booleans only: no case, no case-derived count, no name, no reason.
--
-- Controls:
--   * Seven read functions added, five commands replaced (two with the same signature, three with a new one), three
--     columns added. No table, policy or table grant is added or changed; nothing is deleted.
--   * Every read is SECURITY DEFINER with search_path '', stable, takes no lock, writes nothing and records nothing; it
--     is granted to authenticated only and joins the policy snapshot's function list. A capability never widens a
--     command: the command checks again.
--   * Every flag is a boolean, never null; every list is a list.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. F3: the caller's Administration pages
-- -----------------------------------------------------------------------------
-- The pages api.my_areas (2045) counts for the ADMINISTRATION area, in the order it picks the area's default view, so
-- the area shows exactly when this list is not empty and opens its first page. An inactive or unknown user has none.
-- Each page asks the database again before it shows anything.
create function api.my_admin_views()
returns table (view_code text)
language sql stable security definer
set search_path = ''
as $$
  select v.view_code
    from (values
            (1, 'users', authz.has_permission('USER_ADMIN') or authz.has_permission('ROLE_ADMIN')),
            (2, 'committees', authz.has_permission('COMMITTEE_ADMIN')),
            (3, 'sectors', authz.has_permission('SECTOR_ADMIN')),
            (4, 'notification-rules', authz.has_permission('NOTIFICATION_ADMIN')),
            (5, 'export-policy', authz.is_export_policy_admin()),
            (6, 'corrective-action-policy', authz.has_permission('CORRECTIVE_ACTION_POLICY_ADMIN')),
            (7, 'calendar', authz.has_permission('BUSINESS_CALENDAR_ADMIN'))
         ) v (ord, view_code, opens)
   where v.opens
     and exists (select 1 from iam.user_profile u where u.id = authz.current_user_id() and u.status = 'ACTIVE')
   order by v.ord;
$$;

-- -----------------------------------------------------------------------------
-- 2. The pages' capability reads
-- -----------------------------------------------------------------------------
-- The business calendar (DEC-F02, 2030). The two forms P12-8a ships keep their flags here, now from the database's
-- read like every other control.
create function api.admin_calendar_capabilities()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_admin boolean;
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
begin
  perform api._actor();
  v_admin := coalesce(authz.has_permission('BUSINESS_CALENDAR_ADMIN'), false);
  if not v_admin then perform api._fail('FORBIDDEN'); end if;
  return jsonb_build_object(
    -- api.set_business_calendar_day and api.set_business_week_pattern: the caller check. The date, the type, the week,
    -- its start and a date already taken (CALENDAR_DAY_EXISTS, PATTERN_SCHEDULED) are inputs.
    'may_set_day', v_admin,
    'may_set_week_pattern', v_admin,
    -- api.withdraw_business_calendar_day: the caller check, then the day not withdrawn (CALENDAR_DAY_WITHDRAWN) and not
    -- past in Riyadh (CALENDAR_DAY_PAST).
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
               'day_id', d.id,
               'may_withdraw', coalesce(v_admin and d.withdrawn_at is null and d.calendar_date >= v_today, false))
             order by d.calendar_date, d.recorded_at, d.id)
        from config.business_calendar_day d), '[]'::jsonb));
end;
$$;

-- The committees (1870, 2030). Seat appointments and ends wait for the owner's decision on backdated appointments
-- (F7) and for DEC-12's scope (F5); deactivation, reactivation and seat corrections wait for P12-8c (F9).
create function api.admin_committee_capabilities()
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
                 select 1 from committee.rule_set r where r.committee_id = c.id and r.effective_to is null), false))
             order by c.code collate "C", c.id)
        from committee.committee c), '[]'::jsonb));
end;
$$;

-- The sectors (1880). Position appointments and ends wait for F7 and, for a head, F5.
create function api.admin_sector_capabilities()
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

-- The notification rules (1920, with section 4 below).
create function api.admin_notification_rule_capabilities()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_admin boolean;
begin
  perform api._actor();
  v_admin := coalesce(authz.has_permission('NOTIFICATION_ADMIN'), false);
  if not v_admin then perform api._fail('FORBIDDEN'); end if;
  -- api.set_notification_rule: the caller check. The layer, the template, the committee, the channel and the start
  -- (LATER_RULE_EXISTS) are inputs.
  return jsonb_build_object('may_set_rule', v_admin);
end;
$$;

-- The export policy (1930, 2040; DEC-F21, DEC-F23, DEC-F24). The approver pools wait for 2160 (P12-8c).
create function api.admin_export_policy_capabilities()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_admin boolean;
begin
  perform api._actor();
  v_admin := coalesce(authz.is_export_policy_admin(), false);
  if not v_admin then perform api._fail('FORBIDDEN'); end if;
  return jsonb_build_object(
    -- api.set_export_rule: the caller check (a policy administrator who approves no export). The rule's values and
    -- start (RESTRICTED_CASE_AUTHORITY_PROTECTED, LATER_RULE_EXISTS) are inputs.
    'may_set_rule', v_admin,
    -- api.set_export_purpose for a code not in the catalogue: the caller check. The code, names and order are inputs.
    'may_add_purpose', v_admin,
    -- api.set_export_purpose for a code in the catalogue: the caller check, then not a legacy purpose
    -- (LEGACY_PURPOSE). The version read (STALE_VERSION) and OTHER's justification are inputs.
    'purposes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', p.code,
               'may_set', coalesce(v_admin and not p.is_legacy, false))
             order by p.is_legacy, p.sort_order, p.code collate "C")
        from exchange.export_purpose p), '[]'::jsonb));
end;
$$;

-- The corrective-action policy (1940, 2040; DEC-F25 to F27). The pools wait: creating one for a deactivation command
-- (F12), their members for 2160 (P12-8c).
create function api.admin_corrective_action_policy_capabilities()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_admin boolean;
begin
  perform api._actor();
  v_admin := coalesce(authz.has_permission('CORRECTIVE_ACTION_POLICY_ADMIN'), false);
  if not v_admin then perform api._fail('FORBIDDEN'); end if;
  -- api.set_corrective_action_policy: the caller check. Every value and the start (LATER_POLICY_EXISTS) are inputs.
  return jsonb_build_object('may_set_policy', v_admin);
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. F6 (CDF-259): nobody appoints themselves to a sector
-- -----------------------------------------------------------------------------
-- Replaces 1880 (same signature, owner and grant). One refusal added after the person is found, where
-- api.appoint_committee_member refuses it (1870): an administrator does not appoint themselves, as no other
-- appointment or grant allows (DEC-12's principle). Everything else is as built.
create or replace function api.appoint_sector_member(
  p_sector_id uuid, p_user_id uuid, p_position text, p_effective_from timestamptz, p_effective_to timestamptz,
  p_appointment_reference text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_from timestamptz := coalesce(p_effective_from, now());
  v_id uuid;
begin
  if not authz.has_permission('SECTOR_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  perform iam.lock_sector(p_sector_id);
  if p_position is null or p_position not in ('HEAD', 'MEMBER') then perform api._fail('INVALID', 'position'); end if;
  if p_effective_to is not null and p_effective_to <= v_from then perform api._fail('INVALID', 'effective_to'); end if;
  if not exists (select 1 from iam.user_profile u where u.id = p_user_id and u.status = 'ACTIVE') then
    perform api._fail('INVALID', 'user_id');
  end if;
  -- 2127 (F6, CDF-259): an administrator does not appoint themselves.
  if p_user_id = v_actor then perform api._fail('CONFLICT', 'SELF_APPOINTMENT'); end if;
  -- One position per person per sector at a time; one head per sector at a time.
  if exists (select 1 from iam.sector_membership m
             where m.sector_id = p_sector_id and m.user_id = p_user_id
               and m.effective_from < coalesce(p_effective_to, 'infinity') and coalesce(m.effective_to, 'infinity') > v_from) then
    perform api._fail('CONFLICT', 'MEMBERSHIP_OVERLAP');
  end if;
  if p_position = 'HEAD' and exists (
    select 1 from iam.sector_membership m
    where m.sector_id = p_sector_id and m.position = 'HEAD'
      and m.effective_from < coalesce(p_effective_to, 'infinity') and coalesce(m.effective_to, 'infinity') > v_from) then
    perform api._fail('CONFLICT', 'SECTOR_HEAD_OCCUPIED');
  end if;
  insert into iam.sector_membership (sector_id, user_id, position, effective_from, effective_to, appointment_reference, appointed_by)
  values (p_sector_id, p_user_id, p_position, v_from, p_effective_to,
          api._require_text(p_appointment_reference, 'appointment_reference', 3, 200), v_actor)
  returning id into v_id;
  perform audit.record_event('SECTOR_MEMBER_APPOINTED', 'ADMIN', 'SUCCESS', null, 'sector_membership', v_id::text, null,
    jsonb_build_object('sector_id', p_sector_id, 'user_id', p_user_id, 'position', p_position,
                       'effective_from', v_from, 'effective_to', p_effective_to));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. F8 (CDF-260): one version of a notification rule at a time
-- -----------------------------------------------------------------------------
-- Replaces 1920 (same signature, owner and grant). The open rule of the key (layer, template, committee, channel)
-- ends where the new one starts, so the new one must start after every rule of the key, in force or scheduled:
-- otherwise CONFLICT:LATER_RULE_EXISTS, where 1920 broke the constraint effective_to > effective_from (the user saw
-- "service unavailable"; nothing was written). Serialised on the key, as api.set_export_rule (2040) and
-- api.set_corrective_action_policy (2040) are on theirs. Everything else is as built.
create or replace function api.set_notification_rule(
  p_layer text, p_template_code text, p_committee_id uuid, p_channel text, p_enabled boolean,
  p_effective_from timestamptz, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
begin
  if not authz.has_permission('NOTIFICATION_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_layer is null or p_layer not in ('COMMITTEE_DEFAULT', 'EVENT_RULE') then perform api._fail('INVALID', 'layer'); end if;
  if not exists (select 1 from notify.template t where t.code = p_template_code) then
    perform api._fail('INVALID', 'template_code');
  end if;
  if (p_layer = 'COMMITTEE_DEFAULT') <> (p_committee_id is not null)
     or (p_committee_id is not null and not exists (select 1 from committee.committee c where c.id = p_committee_id)) then
    perform api._fail('INVALID', 'committee_id');
  end if;
  if p_channel is null or p_channel not in ('IN_APP', 'EMAIL') then perform api._fail('INVALID', 'channel'); end if;
  if p_enabled is null then perform api._fail('INVALID', 'enabled'); end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  -- 2127 (F8, CDF-260): serialised on the key; a rule of the key that starts at or after the new one refuses it.
  perform pg_advisory_xact_lock(hashtext('notify.rule:' || p_layer || ':' || p_template_code || ':'
                                         || coalesce(p_committee_id::text, '-') || ':' || p_channel));
  if exists (select 1 from notify.rule r
             where r.layer = p_layer and r.template_code = p_template_code and r.channel = p_channel
               and r.committee_id is not distinct from p_committee_id and r.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'LATER_RULE_EXISTS');
  end if;
  update notify.rule r set effective_to = p_effective_from
  where r.layer = p_layer and r.template_code = p_template_code and r.channel = p_channel
    and r.committee_id is not distinct from p_committee_id and r.effective_to is null;
  insert into notify.rule (layer, template_code, committee_id, channel, enabled, effective_from, reason, created_by)
  values (p_layer, p_template_code, p_committee_id, p_channel, p_enabled, p_effective_from,
          api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_id;
  perform audit.record_event('NOTIFICATION_RULE_SET', 'ADMIN', 'SUCCESS', null, 'notification_rule', v_id::text,
    p_reason, jsonb_build_object('layer', p_layer, 'template_code', p_template_code, 'channel', p_channel,
                                 'enabled', p_enabled, 'committee_id', p_committee_id));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. F13: in-place administration updates fail closed on a stale version
-- -----------------------------------------------------------------------------
-- Three registers are updated in place rather than versioned by date: the export purposes (DEC-F21), the invitee types
-- (AMB-156, AMB-158) and a sanction's grievance and severity rules (DEC-AMB-004, DEC-AMB-011). Each row now carries the
-- number of its version, raised by one with every change; the command takes the version the caller read and refuses
-- any other, a null included (CONFLICT:STALE_VERSION), so a change nobody saw is never overwritten. The old signatures
-- are dropped, as 1810 did for api.create_case_from_report: only the overload with the check remains.
alter table exchange.export_purpose add column row_version int not null default 1;
alter table committee.invitee_type_rule add column row_version int not null default 1;
alter table decision.sanction_catalogue add column row_version int not null default 1;
comment on column exchange.export_purpose.row_version is
  'F13 (migration 2127): the version of the purpose, raised by api.set_export_purpose, which refuses a stale one.';
comment on column committee.invitee_type_rule.row_version is
  'F13 (migration 2127): the version of the rule, raised by api.set_invitee_type_rule, which refuses a stale one.';
comment on column decision.sanction_catalogue.row_version is
  'F13 (migration 2127): the version of the catalogue row, raised by api.set_sanction_rule (the only command that '
  'updates it), which refuses a stale one. A later command that updates the row raises it too.';

drop function api.set_export_purpose(text, text, text, boolean, boolean, int, text);
drop function api.set_invitee_type_rule(text, boolean, boolean, text, text, text);
drop function api.set_sanction_rule(text, int, boolean, text, text, text);

-- From 2040, with the version: a code in the catalogue needs the version read, a new code none. A new code takes the
-- lock on its code first, so two administrators adding it at once cannot both succeed.
create function api.set_export_purpose(p_code text, p_name_en text, p_name_ar text, p_requires_justification boolean,
                                       p_is_active boolean, p_sort_order int, p_reason text, p_expected_version int)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_old exchange.export_purpose;
  v_name_en text;
  v_name_ar text;
  v_reason text;
  v_version int;
begin
  if not authz.is_export_policy_admin() then perform api._fail('FORBIDDEN'); end if;
  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{2,59}$' then perform api._fail('INVALID', 'code'); end if;
  v_name_en := api._require_text(p_name_en, 'name_en', 3, 200);
  v_name_ar := api._require_text(p_name_ar, 'name_ar', 3, 200);
  if p_requires_justification is null then perform api._fail('INVALID', 'requires_justification'); end if;
  if p_is_active is null then perform api._fail('INVALID', 'is_active'); end if;
  if p_sort_order is null or p_sort_order not between 1 and 899 then perform api._fail('INVALID', 'sort_order'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform pg_advisory_xact_lock(hashtext('exchange.export_purpose:' || p_code));
  select * into v_old from exchange.export_purpose p where p.code = p_code for update;
  if v_old.is_legacy then perform api._fail('CONFLICT', 'LEGACY_PURPOSE'); end if;
  -- 2127 (F13): the version read, or none for a new code.
  if p_expected_version is distinct from v_old.row_version then perform api._fail('CONFLICT', 'STALE_VERSION'); end if;
  if p_code = 'OTHER' and not p_requires_justification then
    perform api._fail('CONFLICT', 'OTHER_REQUIRES_JUSTIFICATION');
  end if;
  insert into exchange.export_purpose as p (code, name_en, name_ar, requires_justification, is_active, is_legacy,
                                            source_status, sort_order, updated_by, updated_at)
  values (p_code, v_name_en, v_name_ar, p_requires_justification, p_is_active, false, 'APPROVED', p_sort_order,
          v_actor, now())
  on conflict (code) do update
    set name_en = excluded.name_en, name_ar = excluded.name_ar,
        requires_justification = excluded.requires_justification, is_active = excluded.is_active,
        source_status = 'APPROVED', sort_order = excluded.sort_order, updated_by = excluded.updated_by,
        updated_at = excluded.updated_at, row_version = p.row_version + 1
  returning p.row_version into v_version;
  perform audit.record_event('EXPORT_PURPOSE_SET', 'ADMIN', 'SUCCESS', null, 'export_purpose', p_code, v_reason,
    jsonb_build_object('created', v_old.code is null, 'requires_justification', p_requires_justification,
                       'previous_requires_justification', v_old.requires_justification, 'is_active', p_is_active,
                       'previous_is_active', v_old.is_active, 'sort_order', p_sort_order, 'row_version', v_version));
  return p_code;
end;
$$;

-- From 2030, with the version.
create function api.set_invitee_type_rule(
  p_invitee_role text, p_enabled boolean, p_confidentiality_ack_required boolean, p_wording_reference text,
  p_source_status text, p_reason text, p_expected_version int
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
  -- 2127 (F13): the version read.
  if p_expected_version is distinct from v_old.row_version then perform api._fail('CONFLICT', 'STALE_VERSION'); end if;
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
         source_status = p_source_status, updated_by = v_actor, updated_at = now(), row_version = row_version + 1
   where invitee_role = p_invitee_role;
  perform audit.record_event('INVITEE_TYPE_RULE_CHANGED', 'ADMIN', 'SUCCESS', null, 'invitee_type_rule', p_invitee_role,
    v_reason, jsonb_build_object('enabled', p_enabled, 'confidentiality_ack_required', p_confidentiality_ack_required,
                                 'previous_enabled', v_old.enabled,
                                 'previous_confidentiality_ack_required', v_old.confidentiality_ack_required,
                                 'wording_sourced', p_wording_reference is not null, 'source_status', p_source_status,
                                 'row_version', v_old.row_version + 1));
end;
$$;

-- From 2040, with the version.
create function api.set_sanction_rule(p_code text, p_severity_rank int, p_is_irreversible boolean,
                                      p_grievance_execution_rule text, p_source_status text, p_reason text,
                                      p_expected_version int)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_old decision.sanction_catalogue;
  v_id uuid;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  select * into v_old from decision.sanction_catalogue c where c.code = p_code for update;
  if v_old.code is null then perform api._fail('INVALID', 'code'); end if;
  -- 2127 (F13): the version read.
  if p_expected_version is distinct from v_old.row_version then perform api._fail('CONFLICT', 'STALE_VERSION'); end if;
  if p_severity_rank is not null and p_severity_rank not between 1 and 100 then
    perform api._fail('INVALID', 'severity_rank');
  end if;
  if p_is_irreversible is null then perform api._fail('INVALID', 'is_irreversible'); end if;
  if p_grievance_execution_rule is null or p_grievance_execution_rule not in ('SUSPEND_UNTIL_RESOLVED', 'PROCEED') then
    perform api._fail('INVALID', 'grievance_execution_rule');
  end if;
  if p_is_irreversible and p_grievance_execution_rule = 'PROCEED' then
    perform api._fail('CONFLICT', 'IRREVERSIBLE_SANCTION_SUSPENDED');
  end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  insert into decision.sanction_rule_change (sanction_code, severity_rank, is_irreversible, grievance_execution_rule,
                                             source_status, reason, changed_by)
  values (v_old.code, p_severity_rank, p_is_irreversible, p_grievance_execution_rule, p_source_status,
          api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_id;
  update decision.sanction_catalogue
     set severity_rank = p_severity_rank, is_irreversible = p_is_irreversible,
         grievance_execution_rule = p_grievance_execution_rule, rule_source_status = p_source_status,
         row_version = row_version + 1
   where code = v_old.code;
  perform audit.record_event('SANCTION_RULE_SET', 'ADMIN', 'SUCCESS', null, 'sanction_catalogue', v_old.code, null,
    jsonb_build_object('change_id', v_id, 'severity_rank', p_severity_rank,
                       'previous_severity_rank', v_old.severity_rank, 'is_irreversible', p_is_irreversible,
                       'previous_is_irreversible', v_old.is_irreversible,
                       'grievance_execution_rule', p_grievance_execution_rule,
                       'previous_grievance_execution_rule', v_old.grievance_execution_rule,
                       'source_status', p_source_status, 'row_version', v_old.row_version + 1));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------
revoke all on function
  api.my_admin_views(), api.admin_calendar_capabilities(), api.admin_committee_capabilities(),
  api.admin_sector_capabilities(), api.admin_notification_rule_capabilities(), api.admin_export_policy_capabilities(),
  api.admin_corrective_action_policy_capabilities(),
  api.set_export_purpose(text, text, text, boolean, boolean, int, text, int),
  api.set_invitee_type_rule(text, boolean, boolean, text, text, text, int),
  api.set_sanction_rule(text, int, boolean, text, text, text, int)
from public;
grant execute on function
  api.my_admin_views(), api.admin_calendar_capabilities(), api.admin_committee_capabilities(),
  api.admin_sector_capabilities(), api.admin_notification_rule_capabilities(), api.admin_export_policy_capabilities(),
  api.admin_corrective_action_policy_capabilities(),
  api.set_export_purpose(text, text, text, boolean, boolean, int, text, int),
  api.set_invitee_type_rule(text, boolean, boolean, text, text, text, int),
  api.set_sanction_rule(text, int, boolean, text, text, text, int)
to authenticated;
