-- =============================================================================
-- 2080 A conflict of interest raised on the case itself (P11-G7), and prior investigators on the case's committees
-- (Rebase PR-B; CDF-196)
-- Requirements: §18–§22, §29, §33, §65, §82, §83, §87; owner decision DEC-F38 (2026-10-13); ambiguity rows AMB-057
-- (R1) and AMB-053 (R3); gap P11-G7 (ADR-038 open question 3); ADR-040 placement table; coordinator rulings (the
-- conflict decider is never the raiser or the subject; the subject never reads a concern about them; reasons never
-- in audit metadata; no permission widened before 2160); ADR-044
--
-- DEC-F38 (owner, 2026-10-13): "An upheld conflict affecting a user's participation suspends that user's ordinary
-- case-content access for the conflicted purpose. It does not necessarily remove unrelated lawful access from a
-- separate, independently authorized purpose. Access is purpose-scoped: CONFLICT → REVOKE/SUSPEND AFFECTED PURPOSE
-- GRANTS, never CONFLICT → DELETE USER. For committee participation the restriction is absolute for the affected
-- proceeding or meeting: no packet, no attendance, no deliberation, no vote."
-- AMB-053 (R3, fail-safe default): "a member who was assigned to investigate the case is treated as conflicted for its
-- committee proceedings. Configurable when DEC-05 is answered."
--
-- As built before 2080: authz.has_conflict is the one place a case conflict acts. A current CONFLICT_DECLARED or
-- CONFLICT_CONFIRMED declaration, or being a party to the case (a linked subject, the grievant), fails
-- authz.user_case_gate and authz.user_can_view_case, so every purpose the user holds on that case stops at once,
-- committee participation included (no proceeding, meeting, deliberation, packet or vote), while the account and every
-- other case are untouched. Only the person themself could declare a conflict (api.declare_conflict).
--
-- This migration adds:
--   1. P11-G7. Someone on the case raises another person's conflict of interest, with a reason
--      (api.raise_case_conflict). A conflict manager on the case who is neither the raiser nor the subject upholds or
--      dismisses it (api.decide_case_conflict). The reasons are read by the raiser and the case's conflict managers,
--      never by the subject. An open concern changes no access: DEC-F38 acts on an upheld conflict.
--   2. DEC-F38 / AMB-057. An upheld concern counts in authz.has_conflict, so the subject's purposes on this case are
--      suspended through the gate every path already uses, and their active assignments end and active grants are
--      revoked, as for a declared conflict. On the case the affected purpose is every purpose the user holds on it
--      (the narrowing default; a same-case purpose kept apart from the conflict would widen access and needs a named
--      purpose and the owner's review). Never the account: the user, their roles, their other cases and the portal
--      paths that never rested on the case gate (a subject's own notices, a grievant's own grievance) stay.
--   3. AMB-053. PRIOR_INVESTIGATOR_IS_CONFLICTED (fail-safe default true; configurable when DEC-05 is answered). A
--      committee member in a seat that judges (chair, deputy chair, member, alternate member) who was ever assigned
--      to investigate the case (INVESTIGATOR or LEAD_INVESTIGATOR) is snapshotted excluded and non-voting into its
--      committee proceedings, the snapshot amendment refuses them, and a member sitting in an open proceeding of the
--      case is not assigned to investigate it. Their investigation purpose stays (an unrelated, independent purpose).
--   4. A read model of the case's raised conflicts, with capability flags from the commands.
--   5. AGENT-09 R1 and CDF-225. The events of a raised conflict, on the case or in a meeting, leave the case-team
--      branch of the audit read policy, so the subject never reads one there (rows written before 2080 included).
--
-- Additive: one setting, one table, three api functions and five helper and trigger functions. Replaced functions
-- keep their signatures and only narrow: authz.has_conflict (1910), committee.open_committee_proceeding (1870),
-- api.amend_proceeding_snapshot (2030) and api.committee_referral_preview (2045, so the preview still equals the
-- snapshot); the audit_event_read policy (1410) is altered to narrow its case-team branch. No permission or role grant
-- changes; no catalogue code, status or option code is renamed or removed (DEC-35). Not built: reversing an upheld
-- case conflict (it would restore access; AMB-055 covers a meeting only).
-- =============================================================================

-- =============================================================================
-- 1. The raised case conflict (P11-G7)
-- =============================================================================
create table case_mgmt.case_conflict_concern (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references case_mgmt.case_record (id),
  subject_user_id uuid not null references iam.user_profile (id),
  raised_by       uuid not null references iam.user_profile (id),
  reason          text not null check (length(reason) between 10 and 2000),
  raised_at       timestamptz not null default clock_timestamp(),
  status          text not null default 'OPEN' check (status in ('OPEN', 'UPHELD', 'DISMISSED')),
  decided_by      uuid references iam.user_profile (id),
  decision_reason text check (length(decision_reason) between 10 and 2000),
  decided_at      timestamptz,
  check ((status = 'OPEN') = (decided_by is null)),
  check ((decided_by is null) = (decision_reason is null) and (decided_by is null) = (decided_at is null)),
  -- One's own conflict is declared, never raised; the decider is neither the raiser nor the subject.
  check (subject_user_id <> raised_by),
  check (decided_by is distinct from raised_by and decided_by is distinct from subject_user_id)
);
create unique index case_conflict_concern_open on case_mgmt.case_conflict_concern (case_id, subject_user_id, raised_by)
  where status = 'OPEN';
create index case_conflict_concern_subject on case_mgmt.case_conflict_concern (case_id, subject_user_id, status);
create index case_conflict_concern_subject_user on case_mgmt.case_conflict_concern (subject_user_id);
create index case_conflict_concern_raised_by on case_mgmt.case_conflict_concern (raised_by);
create index case_conflict_concern_decided_by on case_mgmt.case_conflict_concern (decided_by);
comment on table case_mgmt.case_conflict_concern is
  'A conflict of interest raised on the case about another person, and its decision (T3-B1.2-050 on the case, gap '
  'P11-G7; migration 2080, ADR-044). UPHELD counts in authz.has_conflict: the subject''s purposes on the case are '
  'suspended, never their account (DEC-F38). OPEN changes no access. Read by the raiser and the case''s conflict '
  'managers, never by the subject. Decided once; append-only.';

create trigger no_delete before delete on case_mgmt.case_conflict_concern
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on case_mgmt.case_conflict_concern
  for each statement execute function committee.reject_mutation();

-- A concern is decided once; what was raised never changes.
create function case_mgmt.protect_case_conflict_concern()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'OPEN'
     or (to_jsonb(new) - array['status', 'decided_by', 'decision_reason', 'decided_at'])
        <> (to_jsonb(old) - array['status', 'decided_by', 'decision_reason', 'decided_at']) then
    raise exception 'case conflict concern % is decided or its content is immutable', old.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger case_conflict_concern_protect before update on case_mgmt.case_conflict_concern
  for each row execute function case_mgmt.protect_case_conflict_concern();

-- Who reads a raised case conflict: the raiser and the conflict managers who can see the case, never its subject.
create function authz.can_view_case_conflict_concern(p_concern_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from case_mgmt.case_conflict_concern k
    where k.id = p_concern_id and k.subject_user_id <> authz.current_user_id()
      and authz.can_view_case(k.case_id)
      and (k.raised_by = authz.current_user_id() or authz.has_permission('CONFLICT_MANAGE'))
  );
$$;

alter table case_mgmt.case_conflict_concern enable row level security;
create policy case_conflict_concern_read on case_mgmt.case_conflict_concern for select to authenticated
  using (authz.can_view_case_conflict_concern(id));
grant select on case_mgmt.case_conflict_concern to authenticated;

-- =============================================================================
-- 2. DEC-F38: an upheld case conflict suspends the subject's purposes on the case
-- =============================================================================
-- As in 1910, and a raised conflict that was upheld (2080). Every case purpose passes this through
-- authz.user_case_gate or authz.user_can_view_case, so none of them is reachable on this case afterwards: the case
-- file, tasks, grants, break-glass, legal review, committee proceedings, meetings, deliberation, packets and votes.
create or replace function authz.has_conflict(p_case_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
           select 1 from case_mgmt.conflict_check k
           where k.case_id = p_case_id and k.user_id = p_user_id and k.is_current
             and k.status in ('CONFLICT_DECLARED', 'CONFLICT_CONFIRMED'))
      or exists (
           select 1 from grievance.subject_portal_link l
           where l.case_id = p_case_id and l.user_id = p_user_id and l.revoked_at is null)
      or exists (
           select 1 from grievance.grievance g
           where g.case_id = p_case_id and g.grievant_user_id = p_user_id)
      or exists (
           select 1 from case_mgmt.case_conflict_concern c
           where c.case_id = p_case_id and c.subject_user_id = p_user_id and c.status = 'UPHELD');
$$;

-- 2.1 Raising another person's conflict on the case. Anyone who can see the case and may declare a conflict of
-- interest raises it, about an active user other than themself, with a reason. Several people may each raise one
-- about the same person: a raiser learns only of their own open concern, never of anyone else's.
create function api.raise_case_conflict(p_case_id uuid, p_subject_user_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_reason text;
  v_id uuid;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('CONFLICT_DECLARE') then perform api._fail('FORBIDDEN'); end if;
  if p_subject_user_id is null
     or not exists (select 1 from iam.user_profile u where u.id = p_subject_user_id and u.status = 'ACTIVE') then
    perform api._fail('INVALID', 'subject_user_id');
  end if;
  -- One's own conflict is declared (api.declare_conflict), never raised.
  if p_subject_user_id = v_actor then perform api._fail('CONFLICT', 'OWN_CONFLICT'); end if;
  if not exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if exists (select 1 from case_mgmt.case_conflict_concern k
             where k.case_id = p_case_id and k.subject_user_id = p_subject_user_id and k.raised_by = v_actor
               and k.status = 'OPEN') then
    perform api._fail('CONFLICT', 'CONCERN_ALREADY_OPEN');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);

  insert into case_mgmt.case_conflict_concern (case_id, subject_user_id, raised_by, reason)
  values (p_case_id, p_subject_user_id, v_actor, v_reason)
  returning id into v_id;
  -- The reason stays in the concern row (raiser, conflict managers); the ledger gets the fact.
  perform audit.record_event('CASE_CONFLICT_RAISED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_conflict_concern',
    v_id::text, null, jsonb_build_object('subject_user_id', p_subject_user_id));
  return v_id;
end;
$$;

-- 2.2 The decision. A conflict manager who can see the case (so has no conflict on it), never the raiser or the
-- subject. UPHELD: the subject is conflicted on the case (authz.has_conflict) and, as for a declared conflict, their
-- active assignments end and their active grants are revoked. Their committee seats are not touched: the gate
-- excludes them from every proceeding and meeting of the case at once (DEC-F38: absolute for committee
-- participation). DISMISSED changes nothing.
create function api.decide_case_conflict(p_concern_id uuid, p_decision text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_k case_mgmt.case_conflict_concern;
  v_reason text;
  a record;
  g record;
begin
  select * into v_k from case_mgmt.case_conflict_concern k where k.id = p_concern_id;
  if v_k.id is null or not authz.can_view_case_conflict_concern(v_k.id) then perform api._fail('NOT_FOUND'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_k.case_id for update;
  select * into v_k from case_mgmt.case_conflict_concern k where k.id = p_concern_id for update;
  if not authz.has_permission('CONFLICT_MANAGE') or v_k.raised_by = v_actor or v_k.subject_user_id = v_actor then
    perform api._fail('FORBIDDEN');
  end if;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_k.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if v_k.status <> 'OPEN' then perform api._fail('CONFLICT', 'NOTHING_TO_DECIDE'); end if;
  if p_decision is null or p_decision not in ('UPHELD', 'DISMISSED') then perform api._fail('INVALID', 'decision'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);

  update case_mgmt.case_conflict_concern
     set status = p_decision, decided_by = v_actor, decision_reason = v_reason, decided_at = now()
   where id = v_k.id;
  perform audit.record_event('CASE_CONFLICT_DECIDED', 'BUSINESS', 'SUCCESS', v_k.case_id, 'case_conflict_concern',
    v_k.id::text, null, jsonb_build_object('subject_user_id', v_k.subject_user_id, 'decision', p_decision));

  if p_decision = 'UPHELD' then
    for a in select x.id from case_mgmt.case_assignment x
             where x.case_id = v_k.case_id and x.user_id = v_k.subject_user_id and x.status = 'ACTIVE' order by x.id loop
      perform case_mgmt.end_assignment_internal(a.id, v_actor, 'Conflict of interest upheld', 'CASE_UNASSIGNED');
    end loop;
    for g in select x.id, x.scope from case_mgmt.case_access_grant x
             where x.case_id = v_k.case_id and x.user_id = v_k.subject_user_id and x.status = 'ACTIVE' order by x.id loop
      update case_mgmt.case_access_grant
         set status = 'REVOKED', revoked_at = now(), revoked_by = v_actor, revocation_reason = 'Conflict of interest upheld'
       where id = g.id;
      perform audit.record_event('CASE_ACCESS_REVOKED', 'BUSINESS', 'SUCCESS', v_k.case_id, 'case_access_grant',
        g.id::text, 'Conflict of interest upheld', jsonb_build_object('user_id', v_k.subject_user_id, 'scope', g.scope));
    end loop;
  end if;
end;
$$;

-- 2.3 The case's raised conflicts the caller may read (the raiser's own; all of them for a conflict manager; none
-- for their subject), with capability flags: the commands' checks in the commands' order, without locks, false never
-- null. A read: the commands are the audited events.
create function api.case_conflict_concerns(p_case_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_me uuid := authz.current_user_id();
  v_active boolean;
  v_manager boolean;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  select c.records_state = 'ACTIVE' into v_active from case_mgmt.case_record c where c.id = p_case_id;
  v_manager := authz.has_permission('CONFLICT_MANAGE');
  return jsonb_build_object(
    'case_id', p_case_id,
    -- api.raise_case_conflict (its subject is named when raising).
    'may_raise', coalesce(authz.has_permission('CONFLICT_DECLARE') and v_active, false),
    'concerns', coalesce((
      select jsonb_agg(jsonb_build_object(
               'concern_id', k.id, 'subject_user_id', k.subject_user_id, 'raised_by', k.raised_by,
               'raised_at', k.raised_at, 'reason', k.reason, 'status', k.status, 'decided_by', k.decided_by,
               'decided_at', k.decided_at, 'decision_reason', k.decision_reason,
               -- api.decide_case_conflict.
               'may_decide', coalesce(v_manager and k.raised_by <> v_me and k.subject_user_id <> v_me and v_active
                                      and k.status = 'OPEN', false))
             order by k.raised_at, k.id)
      from case_mgmt.case_conflict_concern k
      where k.case_id = p_case_id and authz.can_view_case_conflict_concern(k.id)), '[]'::jsonb));
end;
$$;
comment on function api.case_conflict_concerns(uuid) is
  'The case''s raised conflicts of interest (migration 2080, P11-G7): NOT_FOUND unless the case is visible; the '
  'raiser''s own, or all for a conflict manager, never one about the caller; may_raise and may_decide from the '
  'commands'' checks. Read-only.';

-- =============================================================================
-- 3. AMB-053: a member who investigated the case does not judge it
-- =============================================================================
insert into config.setting (key, value, status, source_reference, description) values
  ('PRIOR_INVESTIGATOR_IS_CONFLICTED', 'true', 'CONFIGURED', 'AMB-053 fail-safe default (DEC-05 open)',
   'AMB-053: a committee member in a seat that judges (chair, deputy chair, member, alternate member) who was ever '
   'assigned to investigate the case is treated as conflicted for its committee proceedings. Fail-safe default true: '
   'anything but ''false'' keeps it. Set to false only with the owner''s answer to DEC-05, cited in source_reference.');

-- Whether the rule is in force: true unless configured 'false' (a missing or unreadable value keeps it, fail safe).
create function case_mgmt.prior_investigator_rule()
returns boolean
language sql stable
set search_path = ''
as $$
  select not exists (select 1 from config.setting s
                     where s.key = 'PRIOR_INVESTIGATOR_IS_CONFLICTED' and s.status = 'CONFIGURED'
                       and lower(btrim(s.value)) = 'false');
$$;

-- The user was ever assigned to investigate the case, and the rule is in force. Internal: answers about any user, so
-- it is not granted to application roles.
create function authz.prior_investigator_conflicted(p_user_id uuid, p_case_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select case_mgmt.prior_investigator_rule()
     and exists (select 1 from case_mgmt.case_assignment a
                 where a.case_id = p_case_id and a.user_id = p_user_id
                   and a.assignment_role in ('INVESTIGATOR', 'LEAD_INVESTIGATOR'));
$$;

-- 3.1 The referral snapshot. As in 1870, and a member in a seat that judges who investigated the case is recorded as
-- excluded, non-voting and without access, as an uncleared member is.
create or replace function committee.open_committee_proceeding(
  p_case_id uuid, p_committee_id uuid, p_parent_proceeding_id uuid, p_actor uuid, p_reason text
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := p_actor;
  v_c committee.committee;
  v_rule committee.rule_set;
  v_type text;
  v_p case_mgmt.proceeding;
  v_cp uuid;
  v_reason text;
  v_voting int;
  v_restricted int;
  v_excluded int;
  v_prior int;
  v_approval uuid;
begin
  select * into v_c from committee.committee c where c.id = p_committee_id and c.is_active;
  if v_c.id is null then perform api._fail('INVALID', 'committee_id'); end if;
  -- DEC-61: a restricted case needs an unused approval by its Restricted Case Authority for this committee.
  if exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.is_restricted) then
    select a.id into v_approval from committee.restricted_referral_approval a
    where a.case_id = p_case_id and a.committee_id = v_c.id and a.committee_proceeding_id is null
    for update;
    if v_approval is null then perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_REQUIRED'); end if;
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform case_mgmt.require_parent_proceeding(p_case_id, p_parent_proceeding_id);
  v_type := case v_c.kind when 'INVESTIGATION' then 'COMMITTEE_INVESTIGATION' else 'GRIEVANCE' end;
  if exists (select 1 from case_mgmt.proceeding p
             where p.case_id = p_case_id and p.proceeding_type = v_type and p.status not in ('CONCLUDED', 'CANCELLED')) then
    perform api._fail('CONFLICT', 'PROCEEDING_ALREADY_OPEN');
  end if;
  -- The registry is read under the committee lock so the snapshot matches one consistent state.
  perform 1 from committee.committee c where c.id = v_c.id for update;
  select * into v_rule from committee.rule_set r
  where r.committee_id = v_c.id and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now());
  if v_rule.id is null then perform api._fail('CONFLICT', 'NO_RULE_SET'); end if;
  -- Constituted: a chair, a secretary (or alternate) and at least one voting member in office now.
  if not exists (select 1 from committee.membership m join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
                 where m.committee_id = v_c.id and m.seat = 'CHAIR'
                   and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now()))
     or not exists (select 1 from committee.membership m join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
                    where m.committee_id = v_c.id and m.seat in ('SECRETARY', 'ALTERNATE_SECRETARY')
                      and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now())) then
    perform api._fail('CONFLICT', 'COMMITTEE_NOT_CONSTITUTED');
  end if;

  v_p := case_mgmt.insert_proceeding(p_case_id, v_type, p_parent_proceeding_id, v_actor);
  insert into committee.committee_proceeding (proceeding_id, committee_id, case_id, rule_set_id, rule_snapshot, referred_by)
  values (v_p.id, v_c.id, p_case_id, v_rule.id,
          to_jsonb(v_rule) - array['id', 'committee_id', 'created_by', 'created_at', 'reason'], v_actor)
  returning id into v_cp;
  if v_approval is not null then
    update committee.restricted_referral_approval set committee_proceeding_id = v_cp, used_at = now() where id = v_approval;
  end if;

  -- Chair, deputy chair and members vote; secretaries and alternates do not. On a grievance, anyone who voted in an
  -- Investigation Committee proceeding of this case sits as non-voting (Q45–Q46). Anyone not cleared for the case
  -- (clearance or a case conflict), and since 2080 anyone in a seat that judges who was assigned to investigate the
  -- case (AMB-053), is recorded as excluded, non-voting and without access (AGENT-09 P1).
  insert into committee.proceeding_member (committee_proceeding_id, user_id, membership_id, seat, is_voting,
                                           firewall_restricted, case_gate_excluded)
  select v_cp, x.user_id, x.id, x.seat,
         x.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER') and x.cleared
           and not (v_c.kind = 'GRIEVANCE' and authz.participated_in_investigation_committee(x.user_id, p_case_id)),
         x.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER') and x.cleared
           and v_c.kind = 'GRIEVANCE' and authz.participated_in_investigation_committee(x.user_id, p_case_id),
         not x.cleared
  from (select m.user_id, m.id, m.seat,
               authz.user_case_gate(m.user_id, p_case_id)
               and not (m.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER', 'ALTERNATE_MEMBER')
                        and authz.prior_investigator_conflicted(m.user_id, p_case_id)) as cleared
        from committee.membership m
        join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
        where m.committee_id = v_c.id and m.effective_from <= now()
          and (m.effective_to is null or m.effective_to > now())) x;

  select count(*) filter (where pm.is_voting), count(*) filter (where pm.firewall_restricted),
         count(*) filter (where pm.case_gate_excluded),
         count(*) filter (where pm.case_gate_excluded and pm.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER', 'ALTERNATE_MEMBER')
                            and authz.prior_investigator_conflicted(pm.user_id, p_case_id))
    into v_voting, v_restricted, v_excluded, v_prior
  from committee.proceeding_member pm where pm.committee_proceeding_id = v_cp;
  if v_voting = 0 then perform api._fail('CONFLICT', 'COMMITTEE_NOT_CONSTITUTED'); end if;

  perform audit.record_event('PROCEEDING_OPENED', 'BUSINESS', 'SUCCESS', p_case_id, 'proceeding', v_p.id::text, v_reason,
    jsonb_build_object('proceeding_type', v_type, 'sequence_no', v_p.sequence_no, 'parent_proceeding_id', p_parent_proceeding_id));
  perform audit.record_event('COMMITTEE_PROCEEDING_OPENED', 'BUSINESS', 'SUCCESS', p_case_id, 'committee_proceeding', v_cp::text, null,
    jsonb_build_object('committee_id', v_c.id, 'committee_kind', v_c.kind, 'rule_set_id', v_rule.id,
                       'voting_members', v_voting, 'firewall_restricted_members', v_restricted,
                       'case_gate_excluded_members', v_excluded, 'prior_investigator_members', v_prior,
                       'restricted_referral_approval_id', v_approval));
  return v_cp;
end;
$$;

-- 3.2 The snapshot amendment (AMB-038). As in 2030, and a member in a seat that judges who was assigned to
-- investigate the case is refused (PRIOR_INVESTIGATOR), as an uncleared member is (NOT_CLEARED_FOR_CASE).
create or replace function api.amend_proceeding_snapshot(p_committee_proceeding_id uuid, p_membership_id uuid, p_reason text)
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
  -- AMB-053 (2080).
  if v_ms.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER', 'ALTERNATE_MEMBER')
     and authz.prior_investigator_conflicted(v_ms.user_id, v_cp.case_id) then
    perform api._fail('CONFLICT', 'PRIOR_INVESTIGATOR');
  end if;
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

comment on column committee.proceeding_member.case_gate_excluded is
  'Recorded as excluded, non-voting and without access to the proceeding: not cleared for the case at referral '
  '(clearance, a case conflict) or, since 2080, in a seat that judges after investigating the case (AMB-053). '
  'Visibility is re-checked against the case gate at every read as well.';

-- 3.3 After the snapshot: a member sitting in a seat that judges, not excluded, in an open committee proceeding of
-- the case is not assigned to investigate it (every path that assigns, through the table).
create function case_mgmt.refuse_investigator_on_committee()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.assignment_role in ('INVESTIGATOR', 'LEAD_INVESTIGATOR') and case_mgmt.prior_investigator_rule()
     and exists (select 1 from committee.proceeding_member pm
                 join committee.committee_proceeding cp on cp.id = pm.committee_proceeding_id
                 where cp.case_id = new.case_id and cp.status = 'OPEN' and pm.user_id = new.user_id
                   and pm.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER', 'ALTERNATE_MEMBER')
                   and not pm.case_gate_excluded) then
    perform api._fail('CONFLICT', 'COMMITTEE_MEMBER_OF_CASE');
  end if;
  return new;
end;
$$;
create trigger case_assignment_committee_member before insert on case_mgmt.case_assignment
  for each row execute function case_mgmt.refuse_investigator_on_committee();

-- 3.4 The referral preview (2045) still equals the snapshot: a prior investigator in a seat that judges counts as not
-- cleared (copied as excluded, without access). Same checks, same shape; no id, name or per-seat flag.
create or replace function api.committee_referral_preview(p_case_id uuid, p_committee_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_c committee.committee;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_edit_case(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  if exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state <> 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  select * into v_c from committee.committee c where c.id = p_committee_id and c.is_active;
  if v_c.id is null then perform api._fail('INVALID', 'committee_id'); end if;
  return (
    with held as (
      select m.seat,
             authz.user_case_gate(m.user_id, p_case_id)
             and not (m.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER', 'ALTERNATE_MEMBER')
                      and authz.prior_investigator_conflicted(m.user_id, p_case_id)) as cleared,
             v_c.kind = 'GRIEVANCE' and authz.participated_in_investigation_committee(m.user_id, p_case_id) as sat_on_ic
        from committee.membership m
        join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
       where m.committee_id = v_c.id and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now())
    )
    select jsonb_build_object(
             'seats', coalesce((select jsonb_agg(jsonb_build_object('seat', s.seat, 'count', s.n)
                                                 order by array_position(array['CHAIR', 'DEPUTY_CHAIR', 'SECRETARY',
                                                   'ALTERNATE_SECRETARY', 'MEMBER', 'ALTERNATE_MEMBER'], s.seat))
                                  from (select h.seat, count(*)::int as n from held h group by h.seat) s), '[]'::jsonb),
             'voting', count(*) filter (where h.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER') and h.cleared
                                          and not h.sat_on_ic),
             'cleared', count(*) filter (where h.cleared),
             'not_cleared', count(*) filter (where not h.cleared),
             'firewall_restricted', count(*) filter (where h.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER') and h.cleared
                                                       and h.sat_on_ic))
      from held h
  );
end;
$$;

-- =============================================================================
-- 4. Raised conflicts stay out of the case team's ledger reads (AGENT-09 R1 on this PR; CDF-225)
-- =============================================================================
-- The case-team branch of audit_event_read (1410) admits every BUSINESS event of a case the reader can view. That
-- showed a raised conflict's events to everyone on the case, the subject included, and with them the raiser
-- (actor_id): CASE_CONFLICT_RAISED and CASE_CONFLICT_DECIDED here, and on main since 2000 and 2030 the meeting's
-- MEETING_CONFLICT_RAISED, MEETING_CONFLICT_DECIDED and MEETING_CONFLICT_REVERSED (CDF-225). The rule is that the
-- subject never reads a concern about them; the concern's readers already read it through its own table and read
-- models. The exclusion is on the reader side, so rows written before 2080 are covered and no ledger row is touched
-- (the ledger is append-only). Narrowing only: the two other branches are unchanged, so oversight (AUDIT_VIEW) and
-- security monitoring read exactly as before, and the case team reads every other BUSINESS event of the case.
alter policy audit_event_read on audit.audit_event
  using (
    -- was audit_business_read: internal audit reads business and administrative history.
    (category in ('BUSINESS', 'ADMIN') and authz.has_permission('AUDIT_VIEW'))
    -- was audit_security_read: security monitoring reads security events.
    or (category = 'SECURITY' and authz.has_permission('SECURITY_EVENT_VIEW'))
    -- was audit_case_team_read: case teams see the business history of cases they can view, except the events of a
    -- raised conflict (2080).
    or (category = 'BUSINESS' and case_id is not null
        and action not in ('CASE_CONFLICT_RAISED', 'CASE_CONFLICT_DECIDED', 'MEETING_CONFLICT_RAISED',
                           'MEETING_CONFLICT_DECIDED', 'MEETING_CONFLICT_REVERSED')
        and authz.can_view_case(case_id))
  );

-- =============================================================================
-- 5. Grants and the catalogue
-- =============================================================================
revoke all on function
  case_mgmt.protect_case_conflict_concern(), case_mgmt.prior_investigator_rule(),
  authz.prior_investigator_conflicted(uuid, uuid), case_mgmt.refuse_investigator_on_committee()
from public, anon, authenticated;

revoke all on function
  api.raise_case_conflict(uuid, uuid, text), api.decide_case_conflict(uuid, text, text),
  api.case_conflict_concerns(uuid), authz.can_view_case_conflict_concern(uuid)
from public;
grant execute on function
  api.raise_case_conflict(uuid, uuid, text), api.decide_case_conflict(uuid, text, text),
  api.case_conflict_concerns(uuid), authz.can_view_case_conflict_concern(uuid)
to authenticated;

-- The form and status catalogue (migration 1970) follows the schema: P11-G7 closes. Another participant's conflict
-- is raised and decided on the case as it is in a meeting.
update config.legacy_form_map
   set merge_target = 'in a meeting: api.raise_meeting_conflict + api.decide_meeting_conflict; '
                      'on the case: api.raise_case_conflict + api.decide_case_conflict',
       gap_ref = null
 where gap_ref = 'P11-G7';
update config.target_module
   set commands = commands || array['api.raise_case_conflict', 'api.decide_case_conflict', 'api.case_conflict_concerns'],
       delivered_in = delivered_in || '2080'::text,
       notes = notes || ' Since 2080: another person''s conflict is raised and decided on the case; an upheld one '
                        'suspends their purposes on the case, never their account (DEC-F38).'
 where code = 'CASE_CONFLICT_OF_INTEREST';
