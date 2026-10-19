-- Migration 2130 (CDF-270, Rebase; ADR-049; follow-up to CDF-206): the two-person lift of a case's restricted status.
--
-- DEC-AMB-012 → C (Fady, 2026-10-13, AMB-234): "Restricted status may be lifted only through two-person control: the
-- case's Restricted Case Authority plus an independent second authorized approver. Require reason, audit, and a
-- preview of the access population/permissions that would become available after declassification. No user may
-- approve their own second approval." Built to AGENT-09's conditions 012-C (a)–(f) and the coordinator's ruling of
-- 2026-10-19 01:42 UTC on the nine design points (all as proposed).
--
--   1. Settings. RESTRICTION_LIFT_SECOND_APPROVER is SOURCE_REQUIRED (the Delegation of Authority's role code): until
--      it names a role that is in force, nothing can be requested, so nothing is lifted. RESTRICTION_LIFT_WINDOW_HOURS
--      (engineering default 24) is how long a request waits for the second approval, and then how long that approval
--      stays usable.
--   2. case_mgmt.restriction_lift_request: one row per request, moving forward only (PENDING → APPROVED or REJECTED;
--      APPROVED → LIFTED; PENDING or APPROVED → EXPIRED or WITHDRAWN), at most one open request per case. RLS on, no
--      policy, no grant. Reasons stay on the row.
--   3. Who. The case's Restricted Case Authority (its owner, an authority for its classification, able to view it)
--      previews, requests and lifts; the lift is made by the requester while still that authority. The second
--      approver holds the configured role, is cleared for the classification, is not an external account, is not the
--      requester, the case's owner or on the case team, and has no declared conflict on the case. Approving gives no
--      access to the case.
--   4. The preview: for each gate the restriction closes, the number of people who would pass it and cannot open the
--      case now, by role code; the distinct total; the authority approvals that stop applying. No names, user ids,
--      case number or title. Snapshotted at the request, recomputed at the approval and at the lift (PREVIEW_CHANGED).
--   5. Nothing is stranded: while an export waits for the authority's consent or a Defence Packet waits for the
--      authority, the request, the approval and the lift are refused (RESTRICTED_APPROVALS_PENDING); both of those
--      commands refuse a case that is no longer restricted.
--   6. Commands: api.preview_restriction_lift, api.request_restriction_lift, api.decide_restriction_lift,
--      api.lift_case_restriction, api.expire_restriction_lift, api.withdraw_restriction_lift. None takes a user id.
--      Audit events carry ids, decision codes, the preview hash and the classification; never a reason.
--   7. Read models (flag == command): api.restriction_lift_status for the authority, and
--      api.my_restriction_lift_approvals for second approvers (no case number and no case id, DEC-22).
--   8. Notifications, ids only: RESTRICTION_LIFT_APPROVAL_REQUESTED (each eligible approver) and
--      RESTRICTION_LIFT_DECIDED (the requester).
--
-- Not changed: api.change_case_classification (2015) still refuses true → false with
-- CONFLICT:RESTRICTION_LIFT_NOT_DECIDED (condition a). api.lift_case_restriction is the only other function that
-- writes the flag, and no application role may update it (condition b).
--
-- Sections:
--   1. Settings
--   2. The request table
--   3. Rules: the approver role, the window, the authority, the approver, the preview, pending approvals
--   4. Refusals shared by the commands and the flags
--   5. Commands
--   6. Read models
--   7. Notifications
--   8. Grants

-- =============================================================================
-- 1. Settings (migration-managed; config.setting has no write grant)
-- =============================================================================
insert into config.setting (key, value, status, source_reference, description) values
  ('RESTRICTION_LIFT_SECOND_APPROVER', null, 'SOURCE_REQUIRED', null,
   'DEC-AMB-012 / AMB-234: the role whose holders give the independent second approval to lift a case''s restricted '
   'status, under the CDF Delegation of Authority, as a role code. Until it is configured nothing can be requested, '
   'so no restriction is lifted.'),
  ('RESTRICTION_LIFT_WINDOW_HOURS', '24', 'CONFIGURED', 'ADR-049 engineering default (CDF security policy may override)',
   'DEC-AMB-012: hours a request to lift a case''s restricted status waits for the second approval, and then hours '
   'that approval stays usable. Anything but a whole number from 1 to 720 refuses every request and lift.');

-- =============================================================================
-- 2. The request table
-- =============================================================================
create table case_mgmt.restriction_lift_request (
  id                    uuid primary key default gen_random_uuid(),
  case_id               uuid not null references case_mgmt.case_record (id),
  classification        core.classification_level not null,
  requested_by          uuid not null references iam.user_profile (id),
  reason                text not null check (length(reason) between 5 and 2000),
  preview               jsonb not null,
  preview_hash          text not null check (preview_hash ~ '^[0-9a-f]{64}$'),
  requested_at          timestamptz not null default now(),
  expires_at            timestamptz not null,
  status                text not null default 'PENDING'
                          check (status in ('PENDING', 'APPROVED', 'REJECTED', 'LIFTED', 'EXPIRED', 'WITHDRAWN')),
  decided_by            uuid references iam.user_profile (id),
  decided_at            timestamptz,
  decision_reason       text check (length(decision_reason) between 5 and 2000),
  approval_preview      jsonb,
  approval_preview_hash text check (approval_preview_hash ~ '^[0-9a-f]{64}$'),
  approval_expires_at   timestamptz,
  lifted_by             uuid references iam.user_profile (id),
  lifted_at             timestamptz,
  ended_by              uuid references iam.user_profile (id),
  ended_at              timestamptz,
  check (expires_at > requested_at),
  -- No user may approve their own request (DEC-AMB-012).
  check (decided_by <> requested_by),
  check ((decided_by is null) = (decided_at is null) and (decided_by is null) = (decision_reason is null)),
  check ((approval_preview is null) = (approval_preview_hash is null)
         and (approval_preview is null) = (approval_expires_at is null)
         and (approval_expires_at is null or approval_expires_at > decided_at)),
  check ((lifted_by is null) = (lifted_at is null) and (ended_by is null) = (ended_at is null)),
  constraint restriction_lift_request_state check (case status
    when 'PENDING' then decided_by is null and approval_preview is null and lifted_by is null and ended_by is null
    when 'APPROVED' then decided_by is not null and approval_preview is not null and lifted_by is null
                         and ended_by is null
    when 'REJECTED' then decided_by is not null and approval_preview is null and lifted_by is null and ended_by is null
    when 'LIFTED' then decided_by is not null and approval_preview is not null and lifted_by = requested_by
                       and ended_by is null
    when 'EXPIRED' then lifted_by is null and ended_by is not null and (decided_by is null) = (approval_preview is null)
    when 'WITHDRAWN' then lifted_by is null and ended_by = requested_by
                          and (decided_by is null) = (approval_preview is null)
  end)
);
create unique index restriction_lift_request_open on case_mgmt.restriction_lift_request (case_id)
  where status in ('PENDING', 'APPROVED');
create index restriction_lift_request_case on case_mgmt.restriction_lift_request (case_id);
create index restriction_lift_request_requested_by on case_mgmt.restriction_lift_request (requested_by);
create index restriction_lift_request_decided_by on case_mgmt.restriction_lift_request (decided_by);
create index restriction_lift_request_lifted_by on case_mgmt.restriction_lift_request (lifted_by);
create index restriction_lift_request_ended_by on case_mgmt.restriction_lift_request (ended_by);
comment on table case_mgmt.restriction_lift_request is
  'DEC-AMB-012 (migration 2130, ADR-049): a request by a restricted case''s authority to lift its restricted status, '
  'the independent second approval and the lift. Moves forward only; reasons stay here and never reach the ledger.';

-- A request moves forward only, each step setting its own columns once and changing nothing else.
create function case_mgmt.protect_restriction_lift_request()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_cols text[];
begin
  v_cols := case
    when old.status = 'PENDING' and new.status = 'APPROVED' then
      array['status', 'decided_by', 'decided_at', 'decision_reason', 'approval_preview', 'approval_preview_hash',
            'approval_expires_at']
    when old.status = 'PENDING' and new.status = 'REJECTED' then
      array['status', 'decided_by', 'decided_at', 'decision_reason']
    when old.status = 'APPROVED' and new.status = 'LIFTED' then
      array['status', 'lifted_by', 'lifted_at']
    when old.status in ('PENDING', 'APPROVED') and new.status in ('EXPIRED', 'WITHDRAWN') then
      array['status', 'ended_by', 'ended_at']
  end;
  if v_cols is not null and (to_jsonb(new) - v_cols) = (to_jsonb(old) - v_cols) then
    return new;
  end if;
  raise exception 'restriction lift request % is final or immutable', old.id using errcode = 'insufficient_privilege';
end;
$$;
create trigger restriction_lift_request_protect before update on case_mgmt.restriction_lift_request
  for each row execute function case_mgmt.protect_restriction_lift_request();
create trigger no_delete before delete on case_mgmt.restriction_lift_request
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on case_mgmt.restriction_lift_request
  for each statement execute function committee.reject_mutation();
alter table case_mgmt.restriction_lift_request enable row level security;

-- =============================================================================
-- 3. Rules
-- =============================================================================
-- The second approver's role in force: configured, a role that exists, not technical, never PLATFORM_ADMIN or
-- DB_ADMIN (§21), and held by an active user today (the case_mgmt.closure_authority_role rule). Anything else: null.
create function case_mgmt.restriction_lift_approver_role()
returns text
language sql stable
set search_path = ''
as $$
  select r.code from config.setting s
  join iam.role r on r.code = s.value
  where s.key = 'RESTRICTION_LIFT_SECOND_APPROVER' and s.status = 'CONFIGURED'
    and not r.is_technical and r.code not in ('PLATFORM_ADMIN', 'DB_ADMIN')
    and exists (select 1 from iam.user_role_assignment a
                join iam.user_profile u on u.id = a.user_id and u.status = 'ACTIVE'
                where a.role_code = r.code and a.status = 'ACTIVE' and a.effective_from <= current_date
                  and (a.effective_to is null or a.effective_to >= current_date));
$$;

-- The window in force, or null when the setting is not a whole number of hours from 1 to 720.
create function case_mgmt.restriction_lift_window()
returns interval
language sql stable
set search_path = ''
as $$
  select make_interval(hours => s.value::int) from config.setting s
  where s.key = 'RESTRICTION_LIFT_WINDOW_HOURS' and s.status = 'CONFIGURED'
    and coalesce(case when s.value ~ '^[0-9]{1,3}$' then s.value::int end between 1 and 720, false);
$$;

-- The case's Restricted Case Authority: its owner, an authority for its classification, able to view it.
create function case_mgmt.restriction_lift_rca(p_case_id uuid, p_user_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1 from case_mgmt.case_record c
    where c.id = p_case_id and c.owner_id = p_user_id
      and authz.is_restricted_case_authority(p_user_id, c.classification)
      and authz.user_can_view_case(p_user_id, c.id));
$$;

-- An independent second approver for the case: holds the configured role, active, cleared for the classification, not
-- an external account, no declared conflict on the case (authz.user_case_gate), not its owner and not on its team.
-- The request's own requester is refused by the commands as well.
create function case_mgmt.restriction_lift_approver_ok(p_case_id uuid, p_user_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1 from case_mgmt.case_record c
    where c.id = p_case_id
      and authz.user_has_role(p_user_id, case_mgmt.restriction_lift_approver_role())
      and authz.user_case_gate(p_user_id, c.id)
      and c.owner_id is distinct from p_user_id
      and not authz.has_active_assignment(c.id, p_user_id));
$$;

-- What lifting would open, counts and role codes only (DEC-AMB-012, condition d). For each gate the restriction
-- closes: the people who would pass it (active, cleared, unconflicted, not external) and cannot open the case now,
-- by the role code that gives it (any role for the Grievance Committee's secretaries, NONE without one). Every gate is
-- listed, in a fixed order; roles sort by code.
create function case_mgmt.restriction_lift_preview(p_case_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  with c as (
    select r.id, r.classification from case_mgmt.case_record r where r.id = p_case_id
  ),
  outsiders as (
    select u.id from iam.user_profile u, c
    where u.status = 'ACTIVE' and authz.user_case_gate(u.id, c.id) and not authz.user_can_view_case(u.id, c.id)
  ),
  gates (gate, ord) as (
    values ('CASE_VIEW_ALL', 1), ('BREAK_GLASS_REQUEST', 2), ('ARCHIVE_RECORD_VIEW', 3), ('PRELIMINARY_APPROVE', 4),
           ('LEGAL_HOLD_REQUEST', 5), ('GRIEVANCE_COMMITTEE_SECRETARY', 6)
  ),
  roles_now as (
    select a.user_id, a.role_code from iam.user_role_assignment a
    where a.status = 'ACTIVE' and a.effective_from <= current_date
      and (a.effective_to is null or a.effective_to >= current_date)
  ),
  gained as (
    select g.gate, r.role_code, o.id as user_id
    from gates g
    join iam.role_permission rp on rp.permission_code = g.gate
    join roles_now r on r.role_code = rp.role_code
    join outsiders o on o.id = r.user_id
    union
    select 'GRIEVANCE_COMMITTEE_SECRETARY', coalesce(r.role_code, 'NONE'), o.id
    from outsiders o
    left join roles_now r on r.user_id = o.id
    where authz.user_committee_seat(o.id, grievance.committee_id(), now()) in ('SECRETARY', 'ALTERNATE_SECRETARY')
  )
  select jsonb_build_object(
    'classification', (select c.classification from c),
    'gates', (select jsonb_agg(jsonb_build_object(
                       'gate', g.gate,
                       'users', (select count(distinct x.user_id) from gained x where x.gate = g.gate),
                       'roles', coalesce((select jsonb_agg(jsonb_build_object('role', y.role_code, 'users', y.n)
                                                           order by y.role_code collate "C")
                                          from (select x.role_code, count(distinct x.user_id) as n from gained x
                                                where x.gate = g.gate group by x.role_code) y), '[]'::jsonb))
                     order by g.ord)
              from gates g),
    'users_gaining', (select count(distinct x.user_id) from gained x),
    -- The authority's approvals that no longer apply once the case is not restricted.
    'authority_approvals_ending', jsonb_build_array('EXPORT_CONSENT', 'DEFENCE_PACKET_RELEASE', 'LEGAL_REVIEW',
                                                    'COMMITTEE_REFERRAL', 'GRIEVANCE_HANDLING',
                                                    'GRIEVANCE_RECORDING', 'SANCTION_EXTRACT'));
$$;

create function case_mgmt.restriction_lift_hash(p_preview jsonb)
returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_preview::text, 'UTF8')), 'hex');
$$;

-- The authority decisions a lift would strand (their commands refuse a case that is no longer restricted): an export
-- waiting for the authority's consent, a Defence Packet waiting for the authority.
create function case_mgmt.restriction_lift_pending(p_case_id uuid)
returns int
language sql stable
set search_path = ''
as $$
  select (select count(*) from exchange.export_request q
          where q.case_id = p_case_id and q.status = 'SUBMITTED' and exchange.authority_approval_required(q.id)
            and not exists (select 1 from exchange.restricted_export_approval a where a.request_id = q.id))::int
       + (select count(*) from grievance.defence_packet k
          where k.case_id = p_case_id and k.status = 'AWAITING_AUTHORITY')::int;
$$;

create function case_mgmt.restriction_lift_lapsed(p_q case_mgmt.restriction_lift_request)
returns boolean
language sql stable
set search_path = ''
as $$
  select (p_q.status = 'PENDING' and p_q.expires_at <= now())
      or (p_q.status = 'APPROVED' and p_q.approval_expires_at <= now());
$$;

-- Who may see a request: the case's authority, its requester while they can still view the case, and anyone who
-- could give the second approval. Everyone else gets NOT_FOUND, as for an id that does not exist.
create function case_mgmt.restriction_lift_party(p_request_id uuid, p_user_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1 from case_mgmt.restriction_lift_request q
    where q.id = p_request_id
      and (case_mgmt.restriction_lift_rca(q.case_id, p_user_id)
           or (q.requested_by = p_user_id and authz.user_can_view_case(p_user_id, q.case_id))
           or case_mgmt.restriction_lift_approver_ok(q.case_id, p_user_id)));
$$;

create function case_mgmt.lock_restriction_lift(p_request_id uuid)
returns case_mgmt.restriction_lift_request
language plpgsql
set search_path = ''
as $$
declare v case_mgmt.restriction_lift_request;
begin
  if p_request_id is null or not case_mgmt.restriction_lift_party(p_request_id, authz.current_user_id()) then
    perform api._fail('NOT_FOUND');
  end if;
  select * into v from case_mgmt.restriction_lift_request q where q.id = p_request_id for update;
  return v;
end;
$$;

-- Ends an open request (EXPIRED or WITHDRAWN) with its audit event.
create function case_mgmt.end_restriction_lift(p_request_id uuid, p_status text, p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare v case_mgmt.restriction_lift_request;
begin
  update case_mgmt.restriction_lift_request q
     set status = p_status, ended_by = p_actor, ended_at = now()
   where q.id = p_request_id and q.status in ('PENDING', 'APPROVED')
  returning * into v;
  perform audit.record_event('RESTRICTION_LIFT_' || p_status, 'BUSINESS', 'SUCCESS', v.case_id,
    'restriction_lift_request', v.id::text, null,
    jsonb_build_object('classification', v.classification,
                       'approved', v.decided_by is not null, 'preview_hash', v.preview_hash));
end;
$$;

-- =============================================================================
-- 4. Refusals shared by the commands and the flags (null: allowed)
-- =============================================================================
-- Requesting, for a user who can view the case.
create function case_mgmt.restriction_lift_request_refusal(p_case_id uuid, p_user_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare v_case case_mgmt.case_record;
begin
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id;
  if not case_mgmt.restriction_lift_rca(p_case_id, p_user_id) then return 'FORBIDDEN'; end if;
  if not v_case.is_restricted then return 'CASE_NOT_RESTRICTED'; end if;
  if v_case.records_state not in ('ACTIVE', 'CLOSED') then return 'RECORDS_READ_ONLY'; end if;
  if case_mgmt.restriction_lift_approver_role() is null then return 'LIFT_APPROVER_NOT_CONFIGURED'; end if;
  if case_mgmt.restriction_lift_window() is null then return 'LIFT_WINDOW_MISCONFIGURED'; end if;
  if case_mgmt.restriction_lift_pending(p_case_id) > 0 then return 'RESTRICTED_APPROVALS_PENDING'; end if;
  -- An open request blocks a new one until it lapses (the command ends a lapsed one first).
  if exists (select 1 from case_mgmt.restriction_lift_request q
             where q.case_id = p_case_id and q.status in ('PENDING', 'APPROVED')
               and not case_mgmt.restriction_lift_lapsed(q)) then
    return 'LIFT_ALREADY_REQUESTED';
  end if;
  if not exists (select 1 from iam.user_profile u
                 where u.status = 'ACTIVE' and u.id <> p_user_id
                   and case_mgmt.restriction_lift_approver_ok(p_case_id, u.id)) then
    return 'NO_ELIGIBLE_APPROVER';
  end if;
  return null;
end;
$$;

-- Deciding (either way), for a party to the request. Approving adds case_mgmt.restriction_lift_approve_refusal.
create function case_mgmt.restriction_lift_decide_refusal(p_q case_mgmt.restriction_lift_request, p_user_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
begin
  if p_q.requested_by = p_user_id then return 'REQUESTER_CANNOT_APPROVE'; end if;
  if exists (select 1 from case_mgmt.case_record c where c.id = p_q.case_id and c.owner_id = p_user_id) then
    return 'RCA_CANNOT_APPROVE';
  end if;
  if not case_mgmt.restriction_lift_approver_ok(p_q.case_id, p_user_id) then return 'FORBIDDEN'; end if;
  if p_q.status in ('APPROVED', 'REJECTED', 'LIFTED') then return 'ALREADY_DECIDED'; end if;
  if p_q.status <> 'PENDING' then return 'REQUEST_CLOSED'; end if;
  if case_mgmt.restriction_lift_lapsed(p_q) then return 'REQUEST_LAPSED'; end if;
  return null;
end;
$$;

create function case_mgmt.restriction_lift_approve_refusal(p_q case_mgmt.restriction_lift_request)
returns text
language plpgsql stable
set search_path = ''
as $$
declare v_case case_mgmt.case_record;
begin
  select * into v_case from case_mgmt.case_record c where c.id = p_q.case_id;
  if not v_case.is_restricted then return 'CASE_NOT_RESTRICTED'; end if;
  -- Reclassified since the request: what the requester previewed no longer describes the case.
  if v_case.classification is distinct from p_q.classification then return 'PREVIEW_CHANGED'; end if;
  if case_mgmt.restriction_lift_window() is null then return 'LIFT_WINDOW_MISCONFIGURED'; end if;
  if case_mgmt.restriction_lift_pending(p_q.case_id) > 0 then return 'RESTRICTED_APPROVALS_PENDING'; end if;
  if case_mgmt.restriction_lift_hash(case_mgmt.restriction_lift_preview(p_q.case_id)) <> p_q.preview_hash then
    return 'PREVIEW_CHANGED';
  end if;
  return null;
end;
$$;

-- Lifting (condition c): the requester, still the case's authority; the approval approved, unconsumed and unlapsed;
-- the case still restricted and writable; the approver still independent and eligible; nothing stranded; the preview
-- unchanged since the approval.
create function case_mgmt.restriction_lift_lift_refusal(p_q case_mgmt.restriction_lift_request, p_user_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare v_case case_mgmt.case_record;
begin
  select * into v_case from case_mgmt.case_record c where c.id = p_q.case_id;
  if p_q.requested_by <> p_user_id or not case_mgmt.restriction_lift_rca(p_q.case_id, p_user_id) then
    return 'FORBIDDEN';
  end if;
  if p_q.status = 'LIFTED' then return 'APPROVAL_CONSUMED'; end if;
  if p_q.status <> 'APPROVED' then return 'NOT_APPROVED'; end if;
  if case_mgmt.restriction_lift_lapsed(p_q) then return 'APPROVAL_LAPSED'; end if;
  if not v_case.is_restricted then return 'CASE_NOT_RESTRICTED'; end if;
  if v_case.records_state not in ('ACTIVE', 'CLOSED') then return 'RECORDS_READ_ONLY'; end if;
  -- Reclassified since the request: the approval was given on another classification.
  if v_case.classification is distinct from p_q.classification then return 'PREVIEW_CHANGED'; end if;
  -- The approver, re-checked now (condition c): not the lifter, the requester or the case's owner, and still eligible
  -- (case_mgmt.restriction_lift_approver_ok): active, holding the configured role while that role is in force, cleared
  -- for the case's classification now, not an external account, no declared conflict on the case, no active
  -- assignment on it.
  if p_q.decided_by in (p_user_id, p_q.requested_by) or p_q.decided_by is not distinct from v_case.owner_id
     or not case_mgmt.restriction_lift_approver_ok(p_q.case_id, p_q.decided_by) then
    return 'APPROVER_NOT_ELIGIBLE';
  end if;
  if case_mgmt.restriction_lift_pending(p_q.case_id) > 0 then return 'RESTRICTED_APPROVALS_PENDING'; end if;
  if case_mgmt.restriction_lift_hash(case_mgmt.restriction_lift_preview(p_q.case_id))
     is distinct from p_q.approval_preview_hash then
    return 'PREVIEW_CHANGED';
  end if;
  return null;
end;
$$;

-- Raises a refusal code: FORBIDDEN as itself, everything else as a conflict.
create function case_mgmt.restriction_lift_refuse(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_code = 'FORBIDDEN' then perform api._fail('FORBIDDEN'); end if;
  if p_code is not null then perform api._fail('CONFLICT', p_code); end if;
end;
$$;

-- =============================================================================
-- 5. Commands (no user-id arguments; the actor comes from the session)
-- =============================================================================
create function api.preview_restriction_lift(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_preview jsonb;
  v_hash text;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not case_mgmt.restriction_lift_rca(p_case_id, v_actor) then perform api._fail('FORBIDDEN'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id;
  if not v_case.is_restricted then perform api._fail('CONFLICT', 'CASE_NOT_RESTRICTED'); end if;
  v_preview := case_mgmt.restriction_lift_preview(p_case_id);
  v_hash := case_mgmt.restriction_lift_hash(v_preview);
  perform audit.record_event('RESTRICTION_LIFT_PREVIEWED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_record',
    p_case_id::text, null, jsonb_build_object('classification', v_case.classification, 'preview_hash', v_hash));
  return jsonb_build_object('preview', v_preview, 'preview_hash', v_hash);
end;
$$;

create function api.request_restriction_lift(p_case_id uuid, p_reason text, p_preview_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_reason text;
  v_old uuid;
  v_preview jsonb;
  v_hash text;
  v_id uuid;
  v_user uuid;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  -- A lapsed open request ends first, with its own audit event; an unlapsed one still blocks.
  for v_old in select q.id from case_mgmt.restriction_lift_request q
               where q.case_id = p_case_id and q.status in ('PENDING', 'APPROVED')
                 and case_mgmt.restriction_lift_lapsed(q) and case_mgmt.restriction_lift_rca(p_case_id, v_actor)
               for update loop
    perform case_mgmt.end_restriction_lift(v_old, 'EXPIRED', v_actor);
  end loop;
  perform case_mgmt.restriction_lift_refuse(case_mgmt.restriction_lift_request_refusal(p_case_id, v_actor));
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  v_preview := case_mgmt.restriction_lift_preview(p_case_id);
  v_hash := case_mgmt.restriction_lift_hash(v_preview);
  if p_preview_hash is distinct from v_hash then perform api._fail('CONFLICT', 'PREVIEW_CHANGED'); end if;
  insert into case_mgmt.restriction_lift_request (case_id, classification, requested_by, reason, preview, preview_hash,
                                                 expires_at)
  values (p_case_id, v_case.classification, v_actor, v_reason, v_preview, v_hash,
          now() + case_mgmt.restriction_lift_window())
  returning id into v_id;
  perform audit.record_event('RESTRICTION_LIFT_REQUESTED', 'BUSINESS', 'SUCCESS', p_case_id,
    'restriction_lift_request', v_id::text, null,
    jsonb_build_object('classification', v_case.classification, 'preview_hash', v_hash));
  for v_user in select u.id from iam.user_profile u
                where u.status = 'ACTIVE' and u.id <> v_actor
                  and case_mgmt.restriction_lift_approver_ok(p_case_id, u.id) order by u.id loop
    perform notify.enqueue('RESTRICTION_LIFT_APPROVAL_REQUESTED', v_user, v_id, null, 'restriction-lift:' || v_id);
  end loop;
  return v_id;
end;
$$;

create function api.decide_restriction_lift(p_request_id uuid, p_decision text, p_reason text, p_preview_hash text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_q case_mgmt.restriction_lift_request;
  v_reason text;
  v_preview jsonb;
  v_hash text;
begin
  v_q := case_mgmt.lock_restriction_lift(p_request_id);
  perform case_mgmt.restriction_lift_refuse(case_mgmt.restriction_lift_decide_refusal(v_q, v_actor));
  if p_decision is null or p_decision not in ('APPROVE', 'REJECT') then perform api._fail('INVALID', 'decision'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  if p_decision = 'APPROVE' then
    perform case_mgmt.restriction_lift_refuse(case_mgmt.restriction_lift_approve_refusal(v_q));
    -- The approver approves the preview they were shown (recomputed and snapshotted here, condition d).
    v_preview := case_mgmt.restriction_lift_preview(v_q.case_id);
    v_hash := case_mgmt.restriction_lift_hash(v_preview);
    if p_preview_hash is distinct from v_hash then perform api._fail('CONFLICT', 'PREVIEW_CHANGED'); end if;
    update case_mgmt.restriction_lift_request
       set status = 'APPROVED', decided_by = v_actor, decided_at = now(), decision_reason = v_reason,
           approval_preview = v_preview, approval_preview_hash = v_hash,
           approval_expires_at = now() + case_mgmt.restriction_lift_window()
     where id = v_q.id;
  else
    update case_mgmt.restriction_lift_request
       set status = 'REJECTED', decided_by = v_actor, decided_at = now(), decision_reason = v_reason
     where id = v_q.id;
  end if;
  perform audit.record_event(case p_decision when 'APPROVE' then 'RESTRICTION_LIFT_APPROVED'
                                             else 'RESTRICTION_LIFT_REJECTED' end,
    'BUSINESS', 'SUCCESS', v_q.case_id, 'restriction_lift_request', v_q.id::text, null,
    jsonb_build_object('classification', v_q.classification, 'decision', p_decision,
                       'preview_hash', coalesce(v_hash, v_q.preview_hash)));
  perform notify.enqueue('RESTRICTION_LIFT_DECIDED', v_q.requested_by, v_q.id, null,
                         'restriction-lift-decided:' || v_q.id);
  return case p_decision when 'APPROVE' then 'APPROVED' else 'REJECTED' end;
end;
$$;

-- The only writer of case_record.is_restricted besides api.change_case_classification (condition b).
create function api.lift_case_restriction(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_q case_mgmt.restriction_lift_request;
begin
  if p_request_id is null or not case_mgmt.restriction_lift_party(p_request_id, v_actor) then
    perform api._fail('NOT_FOUND');
  end if;
  -- The case first, then the request (the order api.request_restriction_lift takes them in).
  perform 1 from case_mgmt.case_record c
   where c.id = (select q.case_id from case_mgmt.restriction_lift_request q where q.id = p_request_id) for update;
  select * into v_q from case_mgmt.restriction_lift_request q where q.id = p_request_id for update;
  perform case_mgmt.restriction_lift_refuse(case_mgmt.restriction_lift_lift_refusal(v_q, v_actor));
  update case_mgmt.case_record
     set is_restricted = false, updated_at = now(), updated_by = v_actor, row_version = row_version + 1
   where id = v_q.case_id;
  -- Consumed with the lift: a replay finds it LIFTED (APPROVAL_CONSUMED).
  update case_mgmt.restriction_lift_request set status = 'LIFTED', lifted_by = v_actor, lifted_at = now()
   where id = v_q.id;
  perform audit.record_event('RESTRICTION_LIFTED', 'BUSINESS', 'SUCCESS', v_q.case_id, 'restriction_lift_request',
    v_q.id::text, null,
    jsonb_build_object('classification', v_q.classification, 'approved_by', v_q.decided_by,
                       'preview_hash', v_q.approval_preview_hash, 'restricted_from', true, 'restricted_to', false));
end;
$$;

create function api.expire_restriction_lift(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_q case_mgmt.restriction_lift_request;
begin
  v_q := case_mgmt.lock_restriction_lift(p_request_id);
  if v_q.status not in ('PENDING', 'APPROVED') then perform api._fail('CONFLICT', 'REQUEST_CLOSED'); end if;
  if not case_mgmt.restriction_lift_lapsed(v_q) then perform api._fail('CONFLICT', 'NOT_LAPSED'); end if;
  perform case_mgmt.end_restriction_lift(v_q.id, 'EXPIRED', v_actor);
end;
$$;

create function api.withdraw_restriction_lift(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_q case_mgmt.restriction_lift_request;
begin
  v_q := case_mgmt.lock_restriction_lift(p_request_id);
  if v_q.requested_by <> v_actor then perform api._fail('FORBIDDEN'); end if;
  if v_q.status not in ('PENDING', 'APPROVED') then perform api._fail('CONFLICT', 'REQUEST_CLOSED'); end if;
  perform case_mgmt.end_restriction_lift(v_q.id, 'WITHDRAWN', v_actor);
end;
$$;

-- =============================================================================
-- 6. Read models (flag == command)
-- =============================================================================
-- The case's authority: may they preview and request, and where is the case's latest request.
create function api.restriction_lift_status(p_case_id uuid)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := api._actor();
  v_case case_mgmt.case_record;
  v_q case_mgmt.restriction_lift_request;
  v_refusal text;
  v_lift text;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not case_mgmt.restriction_lift_rca(p_case_id, v_me) then perform api._fail('FORBIDDEN'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id;
  v_refusal := case_mgmt.restriction_lift_request_refusal(p_case_id, v_me);
  -- The open request, else the latest one.
  select * into v_q from case_mgmt.restriction_lift_request q where q.case_id = p_case_id
   order by q.status in ('PENDING', 'APPROVED') desc, q.requested_at desc, q.id limit 1;
  if v_q.id is not null then v_lift := case_mgmt.restriction_lift_lift_refusal(v_q, v_me); end if;
  return jsonb_build_object(
    'case_id', p_case_id,
    'is_restricted', v_case.is_restricted,
    'may_preview', v_case.is_restricted,
    'may_request', v_refusal is null,
    'request_refusal', v_refusal,
    'approver_role', case_mgmt.restriction_lift_approver_role(),
    'request', case when v_q.id is null then null else jsonb_build_object(
      'id', v_q.id,
      'status', v_q.status,
      'classification', v_q.classification,
      'mine', v_q.requested_by = v_me,
      'reason', case when v_q.requested_by = v_me then v_q.reason end,
      'requested_at', v_q.requested_at,
      'expires_at', v_q.expires_at,
      'preview', v_q.preview,
      'preview_hash', v_q.preview_hash,
      'decided_at', v_q.decided_at,
      'decision_reason', case when v_q.requested_by = v_me then v_q.decision_reason end,
      'approval_preview_hash', v_q.approval_preview_hash,
      'approval_expires_at', v_q.approval_expires_at,
      'lifted_at', v_q.lifted_at,
      'ended_at', v_q.ended_at,
      'lapsed', case_mgmt.restriction_lift_lapsed(v_q),
      'may_lift', v_lift is null,
      'lift_refusal', v_lift,
      'may_withdraw', v_q.requested_by = v_me and v_q.status in ('PENDING', 'APPROVED'),
      'may_expire', v_q.status in ('PENDING', 'APPROVED') and case_mgmt.restriction_lift_lapsed(v_q)) end);
end;
$$;

-- The second approver's queue: open requests they could decide or expire. No case number and no case id (DEC-22);
-- the classification, the requester's reason and the preview are what the decision rests on.
create function api.my_restriction_lift_approvals()
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare v_me uuid := api._actor();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', q.id,
             'status', q.status,
             'classification', q.classification,
             'reason', q.reason,
             'requested_at', q.requested_at,
             'expires_at', q.expires_at,
             'preview', coalesce(q.approval_preview, q.preview),
             'preview_hash', coalesce(q.approval_preview_hash, q.preview_hash),
             'decided_by_me', q.decided_by is not distinct from v_me,
             'approval_expires_at', q.approval_expires_at,
             'lapsed', case_mgmt.restriction_lift_lapsed(q),
             'may_decide', case_mgmt.restriction_lift_decide_refusal(q, v_me) is null,
             'approve_refusal', case when case_mgmt.restriction_lift_decide_refusal(q, v_me) is null
                                     then case_mgmt.restriction_lift_approve_refusal(q) end,
             'may_expire', case_mgmt.restriction_lift_lapsed(q))
           order by q.requested_at, q.id)
    from case_mgmt.restriction_lift_request q
    where q.status in ('PENDING', 'APPROVED') and q.requested_by <> v_me
      and case_mgmt.restriction_lift_approver_ok(q.case_id, v_me)), '[]'::jsonb);
end;
$$;

-- =============================================================================
-- 7. Notifications (ADR-025): ids only; the target page re-authorizes.
-- =============================================================================
alter table notify.template drop constraint template_object_type_check;
alter table notify.template add constraint template_object_type_check check (object_type in (
  'COMMITTEE', 'MEETING', 'MINUTES', 'LEGAL_REVIEW', 'DEFENCE_NOTICE', 'GRIEVANCE', 'EXPORT', 'CORRECTIVE_ACTION',
  'BCP_IMPORT', 'REFERRAL', 'PRELIMINARY_REVIEW', 'CASE', 'DEFENCE_PACKET', 'SANCTION_EXTRACT_APPROVAL',
  'RESTRICTION_LIFT'));
alter table notify.outbox drop constraint outbox_object_type_check;
alter table notify.outbox add constraint outbox_object_type_check check (object_type in (
  'COMMITTEE', 'MEETING', 'MINUTES', 'LEGAL_REVIEW', 'DEFENCE_NOTICE', 'GRIEVANCE', 'EXPORT', 'CORRECTIVE_ACTION',
  'BCP_IMPORT', 'REFERRAL', 'PRELIMINARY_REVIEW', 'CASE', 'DEFENCE_PACKET', 'SANCTION_EXTRACT_APPROVAL',
  'RESTRICTION_LIFT'));

-- Replaced from 2050: one more path.
create or replace function notify.deep_link(p_object_type text, p_object_id uuid)
returns text
language sql immutable
set search_path = ''
as $$
  select case p_object_type
           when 'COMMITTEE' then '/committees/' || p_object_id
           when 'MEETING' then '/meetings/' || p_object_id
           when 'MINUTES' then '/minutes/' || p_object_id
           when 'LEGAL_REVIEW' then '/legal-reviews/' || p_object_id
           when 'DEFENCE_NOTICE' then '/my-defence/' || p_object_id
           when 'GRIEVANCE' then '/grievances/' || p_object_id
           when 'EXPORT' then '/exports/' || p_object_id
           when 'CORRECTIVE_ACTION' then '/actions/' || p_object_id
           when 'BCP_IMPORT' then '/continuity/imports/' || p_object_id
           when 'REFERRAL' then '/referrals/' || p_object_id
           when 'PRELIMINARY_REVIEW' then '/preliminary-reviews/' || p_object_id
           when 'CASE' then '/cases/' || p_object_id
           when 'DEFENCE_PACKET' then '/defence-packets/' || p_object_id
           when 'SANCTION_EXTRACT_APPROVAL' then '/sanction-extract-approvals/' || p_object_id
           when 'RESTRICTION_LIFT' then '/restriction-lifts/' || p_object_id
         end;
$$;

insert into notify.template (code, object_type, is_mandatory, description) values
  ('RESTRICTION_LIFT_APPROVAL_REQUESTED', 'RESTRICTION_LIFT', true,
   'A request to lift a case''s restricted status awaits the user''s independent second approval (DEC-AMB-012)'),
  ('RESTRICTION_LIFT_DECIDED',            'RESTRICTION_LIFT', true,
   'The second approver decided the user''s request to lift a case''s restricted status (DEC-AMB-012)');
insert into notify.rule (layer, template_code, channel, enabled, effective_from, reason)
select 'SYSTEM_MANDATORY', t.code, c.channel, true, '2026-01-01T00:00:00Z', 'Synthetic default: mandatory notice (ADR-025)'
from notify.template t cross join (values ('IN_APP'), ('EMAIL')) c (channel)
where t.code in ('RESTRICTION_LIFT_APPROVAL_REQUESTED', 'RESTRICTION_LIFT_DECIDED');

-- =============================================================================
-- 8. Grants: the rules are internal; the commands and read models decide everything themselves.
-- =============================================================================
revoke all on function
  case_mgmt.protect_restriction_lift_request(), case_mgmt.restriction_lift_approver_role(),
  case_mgmt.restriction_lift_window(), case_mgmt.restriction_lift_rca(uuid, uuid),
  case_mgmt.restriction_lift_approver_ok(uuid, uuid), case_mgmt.restriction_lift_preview(uuid),
  case_mgmt.restriction_lift_hash(jsonb), case_mgmt.restriction_lift_pending(uuid),
  case_mgmt.restriction_lift_lapsed(case_mgmt.restriction_lift_request),
  case_mgmt.restriction_lift_party(uuid, uuid), case_mgmt.lock_restriction_lift(uuid),
  case_mgmt.end_restriction_lift(uuid, text, uuid), case_mgmt.restriction_lift_request_refusal(uuid, uuid),
  case_mgmt.restriction_lift_decide_refusal(case_mgmt.restriction_lift_request, uuid),
  case_mgmt.restriction_lift_approve_refusal(case_mgmt.restriction_lift_request),
  case_mgmt.restriction_lift_lift_refusal(case_mgmt.restriction_lift_request, uuid),
  case_mgmt.restriction_lift_refuse(text)
from public, anon, authenticated;
revoke all on function
  api.preview_restriction_lift(uuid), api.request_restriction_lift(uuid, text, text),
  api.decide_restriction_lift(uuid, text, text, text), api.lift_case_restriction(uuid),
  api.expire_restriction_lift(uuid), api.withdraw_restriction_lift(uuid), api.restriction_lift_status(uuid),
  api.my_restriction_lift_approvals()
from public;
grant execute on function
  api.preview_restriction_lift(uuid), api.request_restriction_lift(uuid, text, text),
  api.decide_restriction_lift(uuid, text, text, text), api.lift_case_restriction(uuid),
  api.expire_restriction_lift(uuid), api.withdraw_restriction_lift(uuid), api.restriction_lift_status(uuid),
  api.my_restriction_lift_approvals()
to authenticated;
