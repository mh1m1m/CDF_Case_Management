-- =============================================================================
-- 1880 Direct referral and preliminary review (Business Architecture Rebase phase 4; CDF-189, CDF-190)
-- Requirements: §18–§21, §29, §87; owner Q&A Q1–Q20, Q28; ADR-017, ADR-018, ADR-030
--
-- Additive only. Nothing existing is dropped, renamed or re-pathed.
--
-- Sectors (iam):
--   sector               organisational sectors that prepare direct referrals. Reference data.
--   sector_membership    effective-dated HEAD / MEMBER positions; one head at a time per sector.
--   sector_delegation    a head's time-bound, documented delegation of referral approval to a sector member (Q3).
--                        It needs an end date and an evidence reference, and lapses when the delegator stops being head.
--
-- Direct referral (intake, Q1–Q10), a CRM-like record with structured reasons, comments and full history:
--   referral             DRAFT → SUBMITTED_TO_HEAD → SUBMITTED_TO_SECRETARY → ACCEPTED (a DIRECT_REFERRAL case with an
--                        Investigation Committee proceeding is created in the same transaction), or
--                        RETURNED_FOR_COMPLETION / REJECTED. A rejection is not final: the sector may resubmit or object
--                        once; the secretary then decides again. The preparer may withdraw before acceptance.
--   referral_event       append-only history: who, from → to, structured reason codes, comment.
--
-- Preliminary review (case_mgmt, Q11–Q20), for whistleblowing cases:
--   preliminary_recommendation  versioned. Prepared by an investigator, the Compliance Section Manager or the GRC
--                        Director; reviewed by the GRC Director unless the preparer holds that review authority (no
--                        self-review step, Q15); approved by the GRC Sector Head. Review and approval may return it with
--                        structured reasons; the next version answers the return. Approval concludes the
--                        PRELIMINARY_REVIEW proceeding with the recommended outcome.
--
-- Access (AUTHORIZATION_IMPACT.md):
--   * A referral is visible to its preparer, to the sector's head and active delegate once submitted, to the
--     Investigation Committee's secretaries once it has reached them, and to whoever can see the case it became.
--     Every viewer also needs clearance for its classification. Other sector members, SECTOR_ADMIN and
--     PLATFORM_ADMIN see nothing (§21).
--   * Approver ≠ preparer at every step (sector approval, preliminary review, preliminary approval).
--   * The GRC Sector Head has no case access. Purpose-bound visibility (ADR-031): a recommendation awaiting their
--     approval, or one they decided, on a non-restricted case within clearance and without conflict. A restricted
--     case needs an explicit grant first (fail safe).
-- Every command writes its audit event in the same transaction. Audit metadata holds ids and codes, never text.
-- SOURCE_REQUIRED: maximum delegation length, escalation after a second rejection, and routing rules that pick
-- the preparer automatically. The prototype leaves these open and records who acted.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Roles and permissions (mirrored in packages/contracts and packages/authorization)
-- -----------------------------------------------------------------------------
insert into iam.role (code, name_en, name_ar, description, is_technical) values
  ('SECTOR_HEAD',                'Sector Head',                'رئيس القطاع',                          'Approves direct referrals prepared in their sector (Q2).', false),
  ('COMPLIANCE_SECTION_MANAGER', 'Compliance Section Manager', 'مدير قسم الامتثال',                    'Prepares preliminary reviews; maintains committee composition (Q12, Q28).', false),
  ('GRC_SECTOR_HEAD',            'GRC Sector Head',            'رئيس قطاع الحوكمة والمخاطر والامتثال', 'Final approval of preliminary reviews (Q16).', false);

insert into iam.permission (code, description) values
  ('SECTOR_ADMIN',            'Maintain sectors and sector positions; gives no access to referrals or cases'),
  ('REFERRAL_PREPARE',        'Prepare a direct referral in a sector the user belongs to'),
  ('REFERRAL_SECTOR_APPROVE', 'Approve or return direct referrals as head of the sector'),
  ('PRELIMINARY_PREPARE',     'Prepare a preliminary review recommendation on a viewable case'),
  ('PRELIMINARY_REVIEW',      'Review a preliminary review recommendation'),
  ('PRELIMINARY_APPROVE',     'Approve or return a preliminary review recommendation');

insert into iam.role_permission (role_code, permission_code) values
  ('PLATFORM_ADMIN',             'SECTOR_ADMIN'),
  ('REFERRER',                   'REFERRAL_PREPARE'),
  ('SECTOR_HEAD',                'REFERRAL_PREPARE'),
  ('SECTOR_HEAD',                'REFERRAL_SECTOR_APPROVE'),
  ('INVESTIGATOR',               'PRELIMINARY_PREPARE'),
  ('LEAD_INVESTIGATOR',          'PRELIMINARY_PREPARE'),
  ('COMPLIANCE_SECTION_MANAGER', 'PRELIMINARY_PREPARE'),
  ('COMPLIANCE_SECTION_MANAGER', 'COMMITTEE_ADMIN'),
  ('GRC_DIRECTOR',               'PRELIMINARY_PREPARE'),
  ('GRC_DIRECTOR',               'PRELIMINARY_REVIEW'),
  ('GRC_SECTOR_HEAD',            'PRELIMINARY_APPROVE');

-- The outcome a preliminary review recommends when an investigation should open.
insert into config.status_code (dimension, code, source_status) values
  ('OUTCOME_CODE', 'INVESTIGATION_WARRANTED', 'OWNER_DEFAULT');

-- -----------------------------------------------------------------------------
-- Sectors
-- -----------------------------------------------------------------------------
create table iam.sector (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  name_en    text not null check (length(name_en) between 2 and 120),
  name_ar    text not null check (length(name_ar) between 2 and 120),
  is_active  boolean not null default true,
  created_by uuid references iam.user_profile (id),
  created_at timestamptz not null default now()
);
create index sector_created_by on iam.sector (created_by);
comment on table iam.sector is 'Organisational sectors that prepare direct referrals (Q1–Q3). Reference data.';

create table iam.sector_membership (
  id                    uuid primary key default gen_random_uuid(),
  sector_id             uuid not null references iam.sector (id),
  user_id               uuid not null references iam.user_profile (id),
  position              text not null check (position in ('HEAD', 'MEMBER')),
  effective_from        timestamptz not null,
  effective_to          timestamptz,
  appointment_reference text not null check (length(appointment_reference) between 3 and 200),
  appointed_by          uuid references iam.user_profile (id),
  appointed_at          timestamptz not null default now(),
  ended_by              uuid references iam.user_profile (id),
  ended_at              timestamptz,
  end_reason            text check (length(end_reason) between 5 and 2000),
  check (effective_to is null or effective_to > effective_from),
  check ((ended_by is null) = (ended_at is null) and (ended_at is null) = (end_reason is null))
);
create index sector_membership_sector on iam.sector_membership (sector_id, position, effective_from);
create index sector_membership_user on iam.sector_membership (user_id);
create index sector_membership_appointed_by on iam.sector_membership (appointed_by);
create index sector_membership_ended_by on iam.sector_membership (ended_by);
comment on table iam.sector_membership is 'Effective-dated sector positions. Ended by shortening effective_to, never deleted.';

create table iam.sector_delegation (
  id                 uuid primary key default gen_random_uuid(),
  sector_id          uuid not null references iam.sector (id),
  delegator_id       uuid not null references iam.user_profile (id),
  delegate_id        uuid not null references iam.user_profile (id),
  scope              text not null check (scope in ('REFERRAL_APPROVAL')),
  effective_from     timestamptz not null,
  effective_to       timestamptz not null,
  evidence_reference text not null check (length(evidence_reference) between 3 and 200),
  reason             text not null check (length(reason) between 5 and 2000),
  created_at         timestamptz not null default now(),
  revoked_by         uuid references iam.user_profile (id),
  revoked_at         timestamptz,
  revoke_reason      text check (length(revoke_reason) between 5 and 2000),
  check (effective_to > effective_from),
  check (delegate_id <> delegator_id),
  check ((revoked_by is null) = (revoked_at is null) and (revoked_at is null) = (revoke_reason is null))
);
create index sector_delegation_sector on iam.sector_delegation (sector_id, delegate_id, effective_from);
create index sector_delegation_delegator on iam.sector_delegation (delegator_id);
create index sector_delegation_delegate on iam.sector_delegation (delegate_id);
create index sector_delegation_revoked_by on iam.sector_delegation (revoked_by);
comment on table iam.sector_delegation is
  'Time-bound, documented delegation of a sector head''s referral approval (Q3). Valid only while the delegator is head.';

-- -----------------------------------------------------------------------------
-- Direct referral
-- -----------------------------------------------------------------------------
create table intake.referral_number_counter (
  year       int primary key check (year between 2020 and 2100),
  last_value int not null default 0
);

create table intake.referral (
  id                    uuid primary key default gen_random_uuid(),
  -- Display number only; UUIDs are the keys and every lookup is authorised (§87).
  referral_number       text not null unique check (referral_number ~ '^REF-DEMO-[0-9]{4}-[0-9]{4,5}$'),
  sector_id             uuid not null references iam.sector (id),
  committee_id          uuid not null references committee.committee (id),
  title                 text not null check (length(title) between 3 and 200),
  summary               text not null check (length(summary) between 10 and 4000),
  allegation_category   text not null check (allegation_category ~ '^[A-Z_]{3,40}$'),
  classification        core.classification_level not null default 'RESTRICTED',
  status                text not null default 'DRAFT' check (status in (
                          'DRAFT', 'SUBMITTED_TO_HEAD', 'SUBMITTED_TO_SECRETARY', 'RETURNED_FOR_COMPLETION', 'REJECTED',
                          'OBJECTED', 'ACCEPTED', 'WITHDRAWN')),
  prepared_by           uuid not null references iam.user_profile (id),
  created_at            timestamptz not null default now(),
  submitted_at          timestamptz,
  sector_approved_by    uuid references iam.user_profile (id),
  sector_approved_at    timestamptz,
  sector_approval_basis text check (sector_approval_basis in ('HEAD', 'DELEGATE')),
  delegation_id         uuid references iam.sector_delegation (id),
  -- Set when the referral first reaches the committee secretary; the secretary keeps sight of it afterwards.
  reached_secretary_at  timestamptz,
  decided_by            uuid references iam.user_profile (id),
  decided_at            timestamptz,
  case_id               uuid unique references case_mgmt.case_record (id),
  updated_at            timestamptz not null default now(),
  row_version           int not null default 1,
  check ((status = 'ACCEPTED') = (case_id is not null)),
  check (status not in ('SUBMITTED_TO_SECRETARY', 'ACCEPTED', 'REJECTED', 'OBJECTED', 'RETURNED_FOR_COMPLETION')
         or reached_secretary_at is not null),
  check ((sector_approval_basis = 'DELEGATE') = (delegation_id is not null)),
  check (sector_approved_by is null or sector_approved_by <> prepared_by)
);
create index referral_sector on intake.referral (sector_id, status);
create index referral_committee on intake.referral (committee_id, status);
create index referral_prepared_by on intake.referral (prepared_by);
create index referral_sector_approved_by on intake.referral (sector_approved_by);
create index referral_delegation on intake.referral (delegation_id);
create index referral_decided_by on intake.referral (decided_by);
comment on table intake.referral is 'Direct referral from a sector to the Investigation Committee (ADR-017, Q1–Q10).';

create table intake.referral_event (
  id           uuid primary key default gen_random_uuid(),
  referral_id  uuid not null references intake.referral (id),
  event_type   text not null check (event_type in (
                 'CREATED', 'UPDATED', 'SUBMITTED', 'SECTOR_APPROVED', 'SECTOR_RETURNED', 'ACCEPTED',
                 'RETURNED_FOR_COMPLETION', 'REJECTED', 'RESUBMITTED', 'OBJECTED', 'WITHDRAWN', 'COMMENTED')),
  from_status  text,
  to_status    text not null,
  actor_id     uuid not null references iam.user_profile (id),
  reason_codes text[] not null default '{}',
  comment      text check (length(comment) between 1 and 4000),
  -- Wall-clock time, so several events in one transaction keep their order.
  occurred_at  timestamptz not null default clock_timestamp()
);
create index referral_event_referral on intake.referral_event (referral_id, occurred_at);
create index referral_event_actor on intake.referral_event (actor_id);
comment on table intake.referral_event is 'Append-only referral history: transitions, structured reasons and comments.';

-- -----------------------------------------------------------------------------
-- Preliminary review
-- -----------------------------------------------------------------------------
create table case_mgmt.preliminary_recommendation (
  id                  uuid primary key default gen_random_uuid(),
  case_id             uuid not null references case_mgmt.case_record (id),
  proceeding_id       uuid not null references case_mgmt.proceeding (id),
  version_no          int not null check (version_no >= 1),
  recommended_outcome text not null check (recommended_outcome in (
                        'NO_ACTION', 'OUT_OF_SCOPE', 'DUPLICATE', 'TRANSFERRED', 'NON_PROCESSABLE',
                        'INVESTIGATION_WARRANTED', 'REFERRED_TO_COMMITTEE')),
  rationale           text not null check (length(rationale) between 10 and 8000),
  status              text not null check (status in ('AWAITING_REVIEW', 'AWAITING_APPROVAL', 'RETURNED', 'APPROVED')),
  prepared_by         uuid not null references iam.user_profile (id),
  prepared_role       text not null check (prepared_role in (
                        'INVESTIGATOR', 'LEAD_INVESTIGATOR', 'COMPLIANCE_SECTION_MANAGER', 'GRC_DIRECTOR')),
  prepared_at         timestamptz not null default now(),
  review_required     boolean not null,
  reviewed_by         uuid references iam.user_profile (id),
  reviewed_at         timestamptz,
  review_decision     text check (review_decision in ('ENDORSED', 'RETURNED')),
  review_comment      text check (length(review_comment) between 1 and 4000),
  approved_by         uuid references iam.user_profile (id),
  approved_at         timestamptz,
  approval_decision   text check (approval_decision in ('APPROVED', 'RETURNED')),
  approval_comment    text check (length(approval_comment) between 1 and 4000),
  return_reason_codes text[] not null default '{}',
  unique (proceeding_id, version_no),
  check (review_required or reviewed_by is null),
  check ((reviewed_by is null) = (reviewed_at is null) and (reviewed_at is null) = (review_decision is null)),
  check ((approved_by is null) = (approved_at is null) and (approved_at is null) = (approval_decision is null)),
  -- Separation of duties (Q15–Q17).
  check (reviewed_by is null or reviewed_by <> prepared_by),
  check (approved_by is null or (approved_by <> prepared_by and approved_by is distinct from reviewed_by)),
  check ((status = 'RETURNED') = (cardinality(return_reason_codes) > 0)),
  check (status <> 'APPROVED' or approval_decision = 'APPROVED'),
  check (status <> 'AWAITING_APPROVAL' or not review_required or review_decision = 'ENDORSED')
);
create index preliminary_recommendation_case on case_mgmt.preliminary_recommendation (case_id);
create index preliminary_recommendation_status on case_mgmt.preliminary_recommendation (status);
create index preliminary_recommendation_prepared_by on case_mgmt.preliminary_recommendation (prepared_by);
create index preliminary_recommendation_reviewed_by on case_mgmt.preliminary_recommendation (reviewed_by);
create index preliminary_recommendation_approved_by on case_mgmt.preliminary_recommendation (approved_by);
comment on table case_mgmt.preliminary_recommendation is
  'Versioned preliminary review recommendation (Q11–Q20). Each decision is set once; a returned version is answered by the next.';

-- -----------------------------------------------------------------------------
-- Integrity
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['intake.referral_event'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
  end loop;
  foreach t in array array['iam.sector', 'iam.sector_membership', 'iam.sector_delegation', 'intake.referral',
                           'intake.referral_event', 'case_mgmt.preliminary_recommendation'] loop
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;

create function iam.protect_sector_registry()
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
    if (to_jsonb(new) - array['effective_to', 'ended_by', 'ended_at', 'end_reason'])
       <> (to_jsonb(old) - array['effective_to', 'ended_by', 'ended_at', 'end_reason'])
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
create trigger sector_protect before update on iam.sector
  for each row execute function iam.protect_sector_registry();
create trigger sector_membership_protect before update on iam.sector_membership
  for each row execute function iam.protect_sector_registry();
create trigger sector_delegation_protect before update on iam.sector_delegation
  for each row execute function iam.protect_sector_registry();

create function intake.protect_referral()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('ACCEPTED', 'WITHDRAWN') then
    raise exception 'referral % is closed and immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  if new.id <> old.id or new.referral_number <> old.referral_number or new.sector_id <> old.sector_id
     or new.committee_id <> old.committee_id or new.prepared_by <> old.prepared_by or new.created_at <> old.created_at
     or (old.reached_secretary_at is not null and new.reached_secretary_at is distinct from old.reached_secretary_at) then
    raise exception 'referral % identity fields are immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger referral_protect before update on intake.referral
  for each row execute function intake.protect_referral();

create function case_mgmt.protect_preliminary_recommendation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('RETURNED', 'APPROVED') then
    raise exception 'recommendation % is decided and immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  if (to_jsonb(new) - array['status', 'reviewed_by', 'reviewed_at', 'review_decision', 'review_comment', 'approved_by',
                            'approved_at', 'approval_decision', 'approval_comment', 'return_reason_codes'])
     <> (to_jsonb(old) - array['status', 'reviewed_by', 'reviewed_at', 'review_decision', 'review_comment', 'approved_by',
                               'approved_at', 'approval_decision', 'approval_comment', 'return_reason_codes'])
     or (old.reviewed_at is not null and (to_jsonb(new) -> 'reviewed_at') is distinct from (to_jsonb(old) -> 'reviewed_at')) then
    raise exception 'recommendation % content is immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger preliminary_recommendation_protect before update on case_mgmt.preliminary_recommendation
  for each row execute function case_mgmt.protect_preliminary_recommendation();

-- -----------------------------------------------------------------------------
-- Authorization predicates (§19)
-- -----------------------------------------------------------------------------
-- The position a user holds in a sector at an instant, or null. Internal.
create function authz.user_sector_position(p_user_id uuid, p_sector_id uuid, p_at timestamptz)
returns text
language sql stable security definer
set search_path = ''
as $$
  select m.position
  from iam.sector_membership m
  join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
  join iam.sector s on s.id = m.sector_id and s.is_active
  where m.user_id = p_user_id and m.sector_id = p_sector_id
    and m.effective_from <= p_at and (m.effective_to is null or m.effective_to > p_at)
  order by m.effective_from desc
  limit 1;
$$;

-- The delegation that lets a user approve the sector's referrals now: unrevoked, in its window, the delegate still a
-- member and the delegator still the head with approval authority. Internal.
create function authz.referral_approval_delegation(p_user_id uuid, p_sector_id uuid, p_at timestamptz)
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select d.id
  from iam.sector_delegation d
  where d.delegate_id = p_user_id and d.sector_id = p_sector_id and d.scope = 'REFERRAL_APPROVAL'
    and d.revoked_at is null and d.effective_from <= p_at and d.effective_to > p_at
    and authz.user_sector_position(p_user_id, p_sector_id, p_at) is not null
    and authz.user_sector_position(d.delegator_id, p_sector_id, p_at) = 'HEAD'
    and authz.user_has_permission(d.delegator_id, 'REFERRAL_SECTOR_APPROVE')
  order by d.effective_from desc
  limit 1;
$$;

-- HEAD, DELEGATE or null: on what basis the user may approve the sector's referrals. Internal.
create function authz.user_referral_approval_basis(p_user_id uuid, p_sector_id uuid, p_at timestamptz)
returns text
language sql stable security definer
set search_path = ''
as $$
  select case
    when authz.user_sector_position(p_user_id, p_sector_id, p_at) = 'HEAD'
         and authz.user_has_permission(p_user_id, 'REFERRAL_SECTOR_APPROVE') then 'HEAD'
    when authz.referral_approval_delegation(p_user_id, p_sector_id, p_at) is not null then 'DELEGATE'
  end;
$$;

-- Sector roster: sector administrators and the sector's current head.
create function authz.can_view_sector_roster(p_sector_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null
     and (authz.has_permission('SECTOR_ADMIN')
          or authz.user_sector_position(authz.current_user_id(), p_sector_id, now()) = 'HEAD');
$$;

create function authz.can_view_referral(p_referral_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1
    from intake.referral r
    join iam.user_profile u on u.id = authz.current_user_id() and u.status = 'ACTIVE'
    where r.id = p_referral_id
      and r.classification <= u.clearance
      and (r.prepared_by = u.id
           or (r.submitted_at is not null and authz.user_referral_approval_basis(u.id, r.sector_id, now()) is not null)
           or (r.reached_secretary_at is not null and authz.is_committee_secretary(r.committee_id))
           or (r.case_id is not null and authz.can_view_case(r.case_id)))
  );
$$;

-- The case team sees every version; the GRC Sector Head sees, purpose-bound, the versions awaiting their approval and
-- the ones they decided, on non-restricted cases within clearance and without conflict (ADR-031).
create function authz.can_view_preliminary_recommendation(p_recommendation_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1
    from case_mgmt.preliminary_recommendation r
    join case_mgmt.case_record c on c.id = r.case_id
    where r.id = p_recommendation_id
      and (authz.can_view_case(r.case_id)
           or (authz.has_permission('PRELIMINARY_APPROVE')
               and not c.is_restricted and c.records_state <> 'DISPOSED'
               and authz.user_case_gate(authz.current_user_id(), r.case_id)
               and (r.status = 'AWAITING_APPROVAL' or r.approved_by = authz.current_user_id())))
  );
$$;

grant execute on function
  authz.can_view_sector_roster(uuid), authz.can_view_referral(uuid), authz.can_view_preliminary_recommendation(uuid)
to authenticated;

-- -----------------------------------------------------------------------------
-- RLS (SELECT only; no write grants for application roles)
-- -----------------------------------------------------------------------------
alter table iam.sector enable row level security;
alter table iam.sector_membership enable row level security;
alter table iam.sector_delegation enable row level security;
alter table intake.referral_number_counter enable row level security;
alter table intake.referral enable row level security;
alter table intake.referral_event enable row level security;
alter table case_mgmt.preliminary_recommendation enable row level security;
-- referral_number_counter: no policies, no grants.

-- Sector codes and names are reference data, not case content.
create policy sector_read on iam.sector for select to authenticated using (authz.current_user_id() is not null);
grant select on iam.sector to authenticated;

create policy sector_membership_read on iam.sector_membership for select to authenticated
  using (user_id = authz.current_user_id() or authz.can_view_sector_roster(sector_id));
grant select on iam.sector_membership to authenticated;

create policy sector_delegation_read on iam.sector_delegation for select to authenticated
  using (delegator_id = authz.current_user_id() or delegate_id = authz.current_user_id()
         or authz.has_permission('SECTOR_ADMIN'));
grant select on iam.sector_delegation to authenticated;

create policy referral_read on intake.referral for select to authenticated using (authz.can_view_referral(id));
grant select on intake.referral to authenticated;

create policy referral_event_read on intake.referral_event for select to authenticated
  using (authz.can_view_referral(referral_id));
grant select on intake.referral_event to authenticated;

create policy preliminary_recommendation_read on case_mgmt.preliminary_recommendation for select to authenticated
  using (authz.can_view_preliminary_recommendation(id));
grant select on case_mgmt.preliminary_recommendation to authenticated;

-- -----------------------------------------------------------------------------
-- Internal helpers (owner context; not granted to application roles)
-- -----------------------------------------------------------------------------
-- Structured return reasons: one to ten distinct RETURN_REASON codes; OTHER needs a comment (Q10, Q18).
create function case_mgmt.require_return_reasons(p_codes text[], p_comment text)
returns text[]
language plpgsql stable
set search_path = ''
as $$
declare
  v text[];
  c text;
begin
  if p_codes is null or cardinality(p_codes) not between 1 and 10 then perform api._fail('INVALID', 'reason_codes'); end if;
  select array_agg(distinct x order by x) into v from unnest(p_codes) x;
  if cardinality(v) <> cardinality(p_codes) then perform api._fail('INVALID', 'reason_codes'); end if;
  foreach c in array v loop
    perform case_mgmt.require_status_code('RETURN_REASON', c, 'reason_codes');
  end loop;
  if 'OTHER' = any (v) and p_comment is null then perform api._fail('INVALID', 'comment'); end if;
  return v;
end;
$$;

create function case_mgmt.optional_comment(p_comment text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare v text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  if length(v) > 4000 then perform api._fail('INVALID', 'comment'); end if;
  return v;
end;
$$;

create function intake.next_referral_number()
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_year int := extract(year from now())::int;
  v int;
begin
  insert into intake.referral_number_counter (year, last_value) values (v_year, 1)
  on conflict (year) do update set last_value = intake.referral_number_counter.last_value + 1
  returning last_value into v;
  -- Synthetic numbering (§2). PRODUCTION_SUBSTITUTION_REQUIRED: production numbering scheme.
  return 'REF-DEMO-' || v_year || '-' || lpad(v::text, 4, '0');
end;
$$;

-- Locks and returns a referral the caller may see. Invisible and missing are alike (NOT_FOUND).
create function intake.lock_visible_referral(p_referral_id uuid)
returns intake.referral
language plpgsql
set search_path = ''
as $$
declare v intake.referral;
begin
  if p_referral_id is null or not authz.can_view_referral(p_referral_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v from intake.referral r where r.id = p_referral_id for update;
  return v;
end;
$$;

-- Moves a referral, writes its history row and its audit event (ids and codes only, never the comment).
create function intake.record_referral_event(
  p_referral intake.referral, p_event_type text, p_to_status text, p_actor uuid, p_reason_codes text[], p_comment text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare v_id uuid;
begin
  -- p_referral is the row as it was before the command; the caller may already have moved it (acceptance).
  update intake.referral set status = p_to_status, updated_at = now(), row_version = row_version + 1
   where id = p_referral.id and status <> p_to_status;
  insert into intake.referral_event (referral_id, event_type, from_status, to_status, actor_id, reason_codes, comment)
  values (p_referral.id, p_event_type, p_referral.status, p_to_status, p_actor, coalesce(p_reason_codes, '{}'), p_comment)
  returning id into v_id;
  perform audit.record_event('REFERRAL_' || p_event_type, 'BUSINESS', 'SUCCESS',
    (select r.case_id from intake.referral r where r.id = p_referral.id), 'referral', p_referral.id::text, null,
    jsonb_build_object('referral_number', p_referral.referral_number, 'from_status', p_referral.status,
                       'to_status', p_to_status, 'reason_codes', to_jsonb(coalesce(p_reason_codes, '{}')),
                       'has_comment', p_comment is not null, 'event_id', v_id) || coalesce(p_metadata, '{}'::jsonb));
  return v_id;
end;
$$;

create function iam.lock_sector(p_sector_id uuid)
returns iam.sector
language plpgsql
set search_path = ''
as $$
declare v iam.sector;
begin
  select * into v from iam.sector s where s.id = p_sector_id for update;
  if v.id is null then perform api._fail('INVALID', 'sector_id'); end if;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Sector registry commands (SECTOR_ADMIN; no referral or case content)
-- -----------------------------------------------------------------------------
create function api.create_sector(p_code text, p_name_en text, p_name_ar text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
begin
  if not authz.has_permission('SECTOR_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{1,19}$' then perform api._fail('INVALID', 'code'); end if;
  if exists (select 1 from iam.sector s where s.code = p_code) then perform api._fail('CONFLICT', 'SECTOR_CODE_TAKEN'); end if;
  insert into iam.sector (code, name_en, name_ar, created_by)
  values (p_code, api._require_text(p_name_en, 'name_en', 2, 120), api._require_text(p_name_ar, 'name_ar', 2, 120), v_actor)
  returning id into v_id;
  perform audit.record_event('SECTOR_CREATED', 'ADMIN', 'SUCCESS', null, 'sector', v_id::text, null,
    jsonb_build_object('code', p_code));
  return v_id;
end;
$$;

create function api.appoint_sector_member(
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

create function api.end_sector_membership(p_membership_id uuid, p_effective_to timestamptz, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m iam.sector_membership;
  v_to timestamptz := coalesce(p_effective_to, now());
  v_reason text;
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
  update iam.sector_membership
     set effective_to = v_to, ended_by = v_actor, ended_at = now(), end_reason = v_reason
   where id = v_m.id;
  perform audit.record_event('SECTOR_MEMBERSHIP_ENDED', 'ADMIN', 'SUCCESS', null, 'sector_membership', v_m.id::text, v_reason,
    jsonb_build_object('sector_id', v_m.sector_id, 'user_id', v_m.user_id, 'position', v_m.position, 'effective_to', v_to));
end;
$$;

-- -----------------------------------------------------------------------------
-- Delegation of referral approval (Q3): by the sector's current head, to a current member
-- -----------------------------------------------------------------------------
create function api.delegate_referral_approval(
  p_sector_id uuid, p_delegate_id uuid, p_effective_from timestamptz, p_effective_to timestamptz,
  p_evidence_reference text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_from timestamptz := coalesce(p_effective_from, now());
  v_reason text;
  v_id uuid;
begin
  if p_sector_id is null or authz.user_referral_approval_basis(v_actor, p_sector_id, now()) is distinct from 'HEAD' then
    perform api._fail('FORBIDDEN');
  end if;
  perform iam.lock_sector(p_sector_id);
  -- No backdating: a delegation never covers approvals already given.
  if v_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_effective_to is null or p_effective_to <= v_from then perform api._fail('INVALID', 'effective_to'); end if;
  if p_delegate_id is null or p_delegate_id = v_actor
     or authz.user_sector_position(p_delegate_id, p_sector_id, now()) is distinct from 'MEMBER' then
    perform api._fail('INVALID', 'delegate_id');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  if exists (select 1 from iam.sector_delegation d
             where d.sector_id = p_sector_id and d.delegate_id = p_delegate_id and d.revoked_at is null
               and d.effective_from < p_effective_to and d.effective_to > v_from) then
    perform api._fail('CONFLICT', 'DELEGATION_OVERLAP');
  end if;
  insert into iam.sector_delegation (sector_id, delegator_id, delegate_id, scope, effective_from, effective_to,
                                     evidence_reference, reason)
  values (p_sector_id, v_actor, p_delegate_id, 'REFERRAL_APPROVAL', v_from, p_effective_to,
          api._require_text(p_evidence_reference, 'evidence_reference', 3, 200), v_reason)
  returning id into v_id;
  perform audit.record_event('REFERRAL_APPROVAL_DELEGATED', 'ADMIN', 'SUCCESS', null, 'sector_delegation', v_id::text, v_reason,
    jsonb_build_object('sector_id', p_sector_id, 'delegate_id', p_delegate_id, 'effective_from', v_from,
                       'effective_to', p_effective_to));
  return v_id;
end;
$$;

create function api.revoke_referral_delegation(p_delegation_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_d iam.sector_delegation;
  v_reason text;
begin
  select * into v_d from iam.sector_delegation d where d.id = p_delegation_id;
  if v_d.id is null
     or not (v_d.delegator_id = v_actor or v_d.delegate_id = v_actor or authz.has_permission('SECTOR_ADMIN')) then
    perform api._fail('NOT_FOUND');
  end if;
  if not (v_d.delegator_id = v_actor or authz.has_permission('SECTOR_ADMIN')) then perform api._fail('FORBIDDEN'); end if;
  select * into v_d from iam.sector_delegation d where d.id = p_delegation_id for update;
  if v_d.revoked_at is not null or v_d.effective_to <= now() then perform api._fail('CONFLICT', 'DELEGATION_NOT_ACTIVE'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update iam.sector_delegation set revoked_by = v_actor, revoked_at = now(), revoke_reason = v_reason where id = v_d.id;
  perform audit.record_event('REFERRAL_DELEGATION_REVOKED', 'ADMIN', 'SUCCESS', null, 'sector_delegation', v_d.id::text, v_reason,
    jsonb_build_object('sector_id', v_d.sector_id, 'delegate_id', v_d.delegate_id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Direct referral commands
-- -----------------------------------------------------------------------------
create function api.create_referral(
  p_sector_id uuid, p_title text, p_summary text, p_allegation_category text, p_classification core.classification_level
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_committee uuid;
  v_r intake.referral;
begin
  if not authz.has_permission('REFERRAL_PREPARE') then perform api._fail('FORBIDDEN'); end if;
  if p_sector_id is null or authz.user_sector_position(v_actor, p_sector_id, now()) is null then
    perform api._fail('FORBIDDEN');
  end if;
  if p_allegation_category is null or p_allegation_category !~ '^[A-Z_]{3,40}$' then
    perform api._fail('INVALID', 'allegation_category');
  end if;
  if p_classification is null or p_classification > authz.current_clearance() then
    perform api._fail('INVALID', 'classification');
  end if;
  select c.id into v_committee from committee.committee c where c.kind = 'INVESTIGATION' and c.is_active;
  if v_committee is null then perform api._fail('CONFLICT', 'NO_INVESTIGATION_COMMITTEE'); end if;

  insert into intake.referral (referral_number, sector_id, committee_id, title, summary, allegation_category,
                               classification, prepared_by)
  values (intake.next_referral_number(), p_sector_id, v_committee, api._require_text(p_title, 'title', 3, 200),
          api._require_text(p_summary, 'summary', 10, 4000), p_allegation_category, p_classification, v_actor)
  returning * into v_r;
  -- History starts from "no status": the creation row reads null → DRAFT.
  v_r.status := null;
  perform intake.record_referral_event(v_r, 'CREATED', 'DRAFT', v_actor, null, null,
    jsonb_build_object('sector_id', p_sector_id, 'classification', p_classification));
  return v_r.id;
end;
$$;

create function api.update_referral(
  p_referral_id uuid, p_title text, p_summary text, p_allegation_category text, p_classification core.classification_level
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r intake.referral;
begin
  v_r := intake.lock_visible_referral(p_referral_id);
  if v_r.prepared_by <> v_actor then perform api._fail('FORBIDDEN'); end if;
  if v_r.status not in ('DRAFT', 'RETURNED_FOR_COMPLETION', 'REJECTED') then
    perform api._fail('CONFLICT', 'REFERRAL_NOT_EDITABLE');
  end if;
  if p_allegation_category is null or p_allegation_category !~ '^[A-Z_]{3,40}$' then
    perform api._fail('INVALID', 'allegation_category');
  end if;
  if p_classification is null or p_classification > authz.current_clearance() then
    perform api._fail('INVALID', 'classification');
  end if;
  update intake.referral
     set title = api._require_text(p_title, 'title', 3, 200), summary = api._require_text(p_summary, 'summary', 10, 4000),
         allegation_category = p_allegation_category, classification = p_classification,
         updated_at = now(), row_version = row_version + 1
   where id = v_r.id;
  perform intake.record_referral_event(v_r, 'UPDATED', v_r.status, v_actor, null, null,
    jsonb_build_object('classification', p_classification));
end;
$$;

create function api.submit_referral(p_referral_id uuid, p_comment text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r intake.referral;
begin
  v_r := intake.lock_visible_referral(p_referral_id);
  if v_r.prepared_by <> v_actor then perform api._fail('FORBIDDEN'); end if;
  if v_r.status not in ('DRAFT', 'RETURNED_FOR_COMPLETION') then perform api._fail('CONFLICT', 'REFERRAL_NOT_SUBMITTABLE'); end if;
  if authz.user_sector_position(v_actor, v_r.sector_id, now()) is null then
    perform api._fail('CONFLICT', 'NOT_SECTOR_MEMBER');
  end if;
  update intake.referral set submitted_at = now() where id = v_r.id;
  perform intake.record_referral_event(v_r, 'SUBMITTED', 'SUBMITTED_TO_HEAD', v_actor, null,
    case_mgmt.optional_comment(p_comment));
end;
$$;

-- Sector approval (Q2–Q4): the head, or a delegate whose delegation is active now; never the preparer.
create function api.sector_decide_referral(p_referral_id uuid, p_decision text, p_reason_codes text[], p_comment text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r intake.referral;
  v_basis text;
  v_delegation uuid;
  v_comment text := case_mgmt.optional_comment(p_comment);
  v_codes text[];
begin
  v_r := intake.lock_visible_referral(p_referral_id);
  v_basis := authz.user_referral_approval_basis(v_actor, v_r.sector_id, now());
  if v_basis is null then perform api._fail('FORBIDDEN'); end if;
  if v_r.status <> 'SUBMITTED_TO_HEAD' then perform api._fail('CONFLICT', 'REFERRAL_NOT_AWAITING_SECTOR'); end if;
  if v_r.prepared_by = v_actor then perform api._fail('CONFLICT', 'SEPARATION_OF_DUTIES'); end if;
  if v_basis = 'DELEGATE' then v_delegation := authz.referral_approval_delegation(v_actor, v_r.sector_id, now()); end if;

  if p_decision = 'APPROVE' then
    if p_reason_codes is not null and cardinality(p_reason_codes) > 0 then perform api._fail('INVALID', 'reason_codes'); end if;
    update intake.referral
       set sector_approved_by = v_actor, sector_approved_at = now(), sector_approval_basis = v_basis,
           delegation_id = v_delegation, reached_secretary_at = coalesce(reached_secretary_at, now())
     where id = v_r.id;
    perform intake.record_referral_event(v_r, 'SECTOR_APPROVED', 'SUBMITTED_TO_SECRETARY', v_actor, null, v_comment,
      jsonb_build_object('basis', v_basis, 'delegation_id', v_delegation));
  elsif p_decision = 'RETURN' then
    v_codes := case_mgmt.require_return_reasons(p_reason_codes, v_comment);
    perform intake.record_referral_event(v_r, 'SECTOR_RETURNED', 'DRAFT', v_actor, v_codes, v_comment,
      jsonb_build_object('basis', v_basis, 'delegation_id', v_delegation));
  else
    perform api._fail('INVALID', 'decision');
  end if;
end;
$$;

-- Internal: builds the DIRECT_REFERRAL case and opens its Investigation Committee proceeding (ADR-017, ADR-018).
create function intake.create_case_from_referral(p_referral intake.referral, p_case_owner_id uuid, p_actor uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_case_id uuid;
  v_number text;
  v_assignment uuid;
  v_cp uuid;
begin
  if p_case_owner_id is null then perform api._fail('INVALID', 'case_owner_id'); end if;
  -- Every case here is synthetic (§2). PRODUCTION_SUBSTITUTION_REQUIRED: production numbering uses CDF-CASE.
  v_number := case_mgmt.next_case_number('CDF-DEMO');
  insert into case_mgmt.case_record (case_number, case_type, title, summary, classification, is_restricted, source,
                                     source_type, owner_id, created_by, updated_by)
  values (v_number, 'INTERNAL_REFERRAL', p_referral.title, p_referral.summary, p_referral.classification, false,
          'INTERNAL_REFERRAL', 'DIRECT_REFERRAL', p_case_owner_id, p_actor, p_actor)
  returning id into v_case_id;
  -- The owner passes the rule every owner assignment passes (active, clearance, no conflict, CASE_OWNER role).
  perform case_mgmt.assert_assignee_eligible(v_case_id, p_case_owner_id, 'CASE_OWNER');
  insert into case_mgmt.case_assignment (case_id, user_id, assignment_role, reason, assigned_by)
  values (v_case_id, p_case_owner_id, 'CASE_OWNER', 'Direct referral accepted: case owner named by the committee secretary',
          p_actor)
  returning id into v_assignment;
  insert into case_mgmt.allegation (case_id, category, description, created_by)
  values (v_case_id, p_referral.allegation_category, p_referral.summary, p_actor);
  insert into workflow.workflow_instance (case_id, workflow_code, current_state) values (v_case_id, 'CDF_CASE_V1', 'REFERRAL');

  perform audit.record_event('CASE_CREATED', 'BUSINESS', 'SUCCESS', v_case_id, 'case_record', v_case_id::text, null,
    jsonb_build_object('case_number', v_number, 'source_type', 'DIRECT_REFERRAL', 'referral_id', p_referral.id,
                       'classification', p_referral.classification, 'is_restricted', false));
  perform audit.record_event('CASE_ASSIGNED', 'BUSINESS', 'SUCCESS', v_case_id, 'case_assignment', v_assignment::text,
    'Direct referral accepted: case owner named by the committee secretary',
    jsonb_build_object('user_id', p_case_owner_id, 'assignment_role', 'CASE_OWNER'));
  perform workflow.apply_transition(v_case_id, 'REGISTER', p_actor, null);
  v_cp := committee.open_committee_proceeding(v_case_id, p_referral.committee_id, null, p_actor,
    'Direct referral accepted by the committee secretary');
  return v_case_id;
end;
$$;

-- The committee secretary's decision (Q5–Q9): accept (case + committee proceeding), return for completion, or reject.
-- After an objection only accept or reject remain.
create function api.secretary_decide_referral(
  p_referral_id uuid, p_decision text, p_reason_codes text[], p_comment text, p_case_owner_id uuid
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r intake.referral;
  v_comment text := case_mgmt.optional_comment(p_comment);
  v_codes text[];
  v_case_id uuid;
begin
  v_r := intake.lock_visible_referral(p_referral_id);
  if not authz.is_committee_secretary(v_r.committee_id) then perform api._fail('FORBIDDEN'); end if;
  if v_r.status not in ('SUBMITTED_TO_SECRETARY', 'OBJECTED') then
    perform api._fail('CONFLICT', 'REFERRAL_NOT_AWAITING_SECRETARY');
  end if;
  if v_r.prepared_by = v_actor or v_r.sector_approved_by = v_actor then
    perform api._fail('CONFLICT', 'SEPARATION_OF_DUTIES');
  end if;
  if p_decision is distinct from 'ACCEPT' and p_case_owner_id is not null then perform api._fail('INVALID', 'case_owner_id'); end if;

  if p_decision = 'ACCEPT' then
    if p_reason_codes is not null and cardinality(p_reason_codes) > 0 then perform api._fail('INVALID', 'reason_codes'); end if;
    v_case_id := intake.create_case_from_referral(v_r, p_case_owner_id, v_actor);
    update intake.referral set case_id = v_case_id, status = 'ACCEPTED', decided_by = v_actor, decided_at = now(),
                               updated_at = now(), row_version = row_version + 1
     where id = v_r.id;
    perform intake.record_referral_event(v_r, 'ACCEPTED', 'ACCEPTED', v_actor, null, v_comment,
      jsonb_build_object('case_id', v_case_id));
    return v_case_id;
  elsif p_decision = 'RETURN_FOR_COMPLETION' and v_r.status = 'SUBMITTED_TO_SECRETARY' then
    v_codes := case_mgmt.require_return_reasons(p_reason_codes, v_comment);
    update intake.referral set decided_by = v_actor, decided_at = now() where id = v_r.id;
    perform intake.record_referral_event(v_r, 'RETURNED_FOR_COMPLETION', 'RETURNED_FOR_COMPLETION', v_actor, v_codes, v_comment);
  elsif p_decision = 'REJECT' then
    v_codes := case_mgmt.require_return_reasons(p_reason_codes, v_comment);
    update intake.referral set decided_by = v_actor, decided_at = now() where id = v_r.id;
    perform intake.record_referral_event(v_r, 'REJECTED', 'REJECTED', v_actor, v_codes, v_comment);
  else
    perform api._fail('INVALID', 'decision');
  end if;
  return null;
end;
$$;

-- A rejection is not final (Q8): the preparer or the sector's approver sends it back through the sector.
create function api.resubmit_referral(p_referral_id uuid, p_comment text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r intake.referral;
begin
  v_r := intake.lock_visible_referral(p_referral_id);
  if v_r.prepared_by <> v_actor and authz.user_referral_approval_basis(v_actor, v_r.sector_id, now()) is null then
    perform api._fail('FORBIDDEN');
  end if;
  if v_r.status <> 'REJECTED' then perform api._fail('CONFLICT', 'REFERRAL_NOT_REJECTED'); end if;
  update intake.referral set submitted_at = now() where id = v_r.id;
  perform intake.record_referral_event(v_r, 'RESUBMITTED', 'SUBMITTED_TO_HEAD', v_actor, null,
    case_mgmt.optional_comment(p_comment));
end;
$$;

-- Objection (Q8): the sector's approver contests a rejection once; the secretary then accepts or rejects.
create function api.object_to_referral_rejection(p_referral_id uuid, p_comment text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r intake.referral;
begin
  v_r := intake.lock_visible_referral(p_referral_id);
  if authz.user_referral_approval_basis(v_actor, v_r.sector_id, now()) is null then perform api._fail('FORBIDDEN'); end if;
  if v_r.status <> 'REJECTED' then perform api._fail('CONFLICT', 'REFERRAL_NOT_REJECTED'); end if;
  -- A rejection that answered an objection cannot be objected to again (escalation beyond: SOURCE_REQUIRED).
  if (select e.from_status from intake.referral_event e
      where e.referral_id = v_r.id and e.event_type = 'REJECTED' order by e.occurred_at desc, e.id desc limit 1) = 'OBJECTED' then
    perform api._fail('CONFLICT', 'OBJECTION_ALREADY_DECIDED');
  end if;
  perform intake.record_referral_event(v_r, 'OBJECTED', 'OBJECTED', v_actor, null,
    api._require_text(p_comment, 'comment', 10, 4000));
end;
$$;

create function api.withdraw_referral(p_referral_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r intake.referral;
begin
  v_r := intake.lock_visible_referral(p_referral_id);
  if v_r.prepared_by <> v_actor then perform api._fail('FORBIDDEN'); end if;
  if v_r.status not in ('DRAFT', 'SUBMITTED_TO_HEAD', 'RETURNED_FOR_COMPLETION', 'REJECTED') then
    perform api._fail('CONFLICT', 'REFERRAL_NOT_WITHDRAWABLE');
  end if;
  perform intake.record_referral_event(v_r, 'WITHDRAWN', 'WITHDRAWN', v_actor, null,
    api._require_text(p_reason, 'reason', 5, 4000));
end;
$$;

-- CRM-style comment from anyone who can see the referral. The status does not change.
create function api.comment_on_referral(p_referral_id uuid, p_comment text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r intake.referral;
begin
  v_r := intake.lock_visible_referral(p_referral_id);
  return intake.record_referral_event(v_r, 'COMMENTED', v_r.status, v_actor, null,
    api._require_text(p_comment, 'comment', 1, 4000));
end;
$$;

-- Next actions for the caller (ADR-030 workflow guide). Read-only; an invisible referral gives no rows.
create function api.referral_available_actions(p_referral_id uuid)
returns table (action text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r intake.referral;
  v_preparer boolean;
  v_approver boolean;
  v_secretary boolean;
begin
  if p_referral_id is null or not authz.can_view_referral(p_referral_id) then return; end if;
  select * into v_r from intake.referral r where r.id = p_referral_id;
  v_preparer := v_r.prepared_by = v_actor;
  v_approver := authz.user_referral_approval_basis(v_actor, v_r.sector_id, now()) is not null and not v_preparer;
  v_secretary := authz.is_committee_secretary(v_r.committee_id) and not v_preparer
                 and v_r.sector_approved_by is distinct from v_actor;
  return query
    select a from unnest(array[
      case when v_preparer and v_r.status in ('DRAFT', 'RETURNED_FOR_COMPLETION', 'REJECTED') then 'UPDATE' end,
      case when v_preparer and v_r.status in ('DRAFT', 'RETURNED_FOR_COMPLETION') then 'SUBMIT' end,
      case when v_approver and v_r.status = 'SUBMITTED_TO_HEAD' then 'SECTOR_APPROVE' end,
      case when v_approver and v_r.status = 'SUBMITTED_TO_HEAD' then 'SECTOR_RETURN' end,
      case when v_secretary and v_r.status in ('SUBMITTED_TO_SECRETARY', 'OBJECTED') then 'ACCEPT' end,
      case when v_secretary and v_r.status = 'SUBMITTED_TO_SECRETARY' then 'RETURN_FOR_COMPLETION' end,
      case when v_secretary and v_r.status in ('SUBMITTED_TO_SECRETARY', 'OBJECTED') then 'REJECT' end,
      case when (v_preparer or authz.user_referral_approval_basis(v_actor, v_r.sector_id, now()) is not null)
                and v_r.status = 'REJECTED' then 'RESUBMIT' end,
      case when authz.user_referral_approval_basis(v_actor, v_r.sector_id, now()) is not null and v_r.status = 'REJECTED'
                and (select e.from_status from intake.referral_event e where e.referral_id = v_r.id and e.event_type = 'REJECTED'
                     order by e.occurred_at desc, e.id desc limit 1) is distinct from 'OBJECTED' then 'OBJECT' end,
      case when v_preparer and v_r.status in ('DRAFT', 'SUBMITTED_TO_HEAD', 'RETURNED_FOR_COMPLETION', 'REJECTED')
           then 'WITHDRAW' end,
      'COMMENT'
    ]) a where a is not null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Preliminary review commands (Q11–Q20)
-- -----------------------------------------------------------------------------
create function api.prepare_preliminary_recommendation(p_case_id uuid, p_recommended_outcome text, p_rationale text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_p case_mgmt.proceeding;
  v_role text;
  v_review boolean;
  v_version int;
  v_id uuid;
  v_rationale text;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('PRELIMINARY_PREPARE') then perform api._fail('FORBIDDEN'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  if v_case.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
  -- Direct referrals and grievances go straight to their committee (Q4, Q41).
  if v_case.source_type in ('DIRECT_REFERRAL', 'DIRECT_GRIEVANCE') then
    perform api._fail('CONFLICT', 'PRELIMINARY_NOT_APPLICABLE');
  end if;
  if p_recommended_outcome is null or p_recommended_outcome not in (
       'NO_ACTION', 'OUT_OF_SCOPE', 'DUPLICATE', 'TRANSFERRED', 'NON_PROCESSABLE', 'INVESTIGATION_WARRANTED',
       'REFERRED_TO_COMMITTEE') then
    perform api._fail('INVALID', 'recommended_outcome');
  end if;
  perform case_mgmt.require_status_code('OUTCOME_CODE', p_recommended_outcome, 'recommended_outcome');
  v_rationale := api._require_text(p_rationale, 'rationale', 10, 8000);

  select * into v_p from case_mgmt.proceeding p
  where p.case_id = p_case_id and p.proceeding_type = 'PRELIMINARY_REVIEW' and p.status not in ('CONCLUDED', 'CANCELLED')
  for update;
  if v_p.id is null then
    v_p := case_mgmt.insert_proceeding(p_case_id, 'PRELIMINARY_REVIEW', null, v_actor);
    perform audit.record_event('PROCEEDING_OPENED', 'BUSINESS', 'SUCCESS', p_case_id, 'proceeding', v_p.id::text, null,
      jsonb_build_object('proceeding_type', 'PRELIMINARY_REVIEW', 'sequence_no', v_p.sequence_no, 'parent_proceeding_id', null));
  end if;
  if v_p.status = 'SUSPENDED' then perform api._fail('CONFLICT', 'PROCEEDING_SUSPENDED'); end if;
  if exists (select 1 from case_mgmt.preliminary_recommendation r
             where r.proceeding_id = v_p.id and r.status in ('AWAITING_REVIEW', 'AWAITING_APPROVAL')) then
    perform api._fail('CONFLICT', 'RECOMMENDATION_PENDING');
  end if;

  v_role := case
    when authz.user_has_role(v_actor, 'GRC_DIRECTOR') then 'GRC_DIRECTOR'
    when authz.user_has_role(v_actor, 'COMPLIANCE_SECTION_MANAGER') then 'COMPLIANCE_SECTION_MANAGER'
    when authz.user_has_role(v_actor, 'LEAD_INVESTIGATOR') then 'LEAD_INVESTIGATOR'
    else 'INVESTIGATOR' end;
  -- Q15: no self-review step when the preparer holds the review authority.
  v_review := not authz.user_has_permission(v_actor, 'PRELIMINARY_REVIEW');
  select coalesce(max(r.version_no), 0) + 1 into v_version
  from case_mgmt.preliminary_recommendation r where r.proceeding_id = v_p.id;

  insert into case_mgmt.preliminary_recommendation (case_id, proceeding_id, version_no, recommended_outcome, rationale,
                                                    status, prepared_by, prepared_role, review_required)
  values (p_case_id, v_p.id, v_version, p_recommended_outcome, v_rationale,
          case when v_review then 'AWAITING_REVIEW' else 'AWAITING_APPROVAL' end, v_actor, v_role, v_review)
  returning id into v_id;
  update case_mgmt.proceeding
     set status = case when v_review then 'AWAITING_REVIEW' else 'AWAITING_APPROVAL' end, waiting_reason = null,
         updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event('PRELIMINARY_RECOMMENDATION_PREPARED', 'BUSINESS', 'SUCCESS', p_case_id,
    'preliminary_recommendation', v_id::text, null,
    jsonb_build_object('proceeding_id', v_p.id, 'version_no', v_version, 'recommended_outcome', p_recommended_outcome,
                       'prepared_role', v_role, 'review_required', v_review));
  return v_id;
end;
$$;

create function api.review_preliminary_recommendation(
  p_recommendation_id uuid, p_decision text, p_reason_codes text[], p_comment text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r case_mgmt.preliminary_recommendation;
  v_comment text := case_mgmt.optional_comment(p_comment);
  v_codes text[] := '{}';
begin
  select * into v_r from case_mgmt.preliminary_recommendation r where r.id = p_recommendation_id;
  if v_r.id is null or not authz.can_view_case(v_r.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('PRELIMINARY_REVIEW') then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_r.case_id for update;
  if (select c.records_state from case_mgmt.case_record c where c.id = v_r.case_id) <> 'ACTIVE' then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  select * into v_r from case_mgmt.preliminary_recommendation r where r.id = p_recommendation_id for update;
  if v_r.status <> 'AWAITING_REVIEW' then perform api._fail('CONFLICT', 'RECOMMENDATION_NOT_AWAITING_REVIEW'); end if;
  if v_r.prepared_by = v_actor then perform api._fail('CONFLICT', 'SEPARATION_OF_DUTIES'); end if;

  if p_decision = 'ENDORSE' then
    if p_reason_codes is not null and cardinality(p_reason_codes) > 0 then perform api._fail('INVALID', 'reason_codes'); end if;
  elsif p_decision = 'RETURN' then
    v_codes := case_mgmt.require_return_reasons(p_reason_codes, v_comment);
  else
    perform api._fail('INVALID', 'decision');
  end if;
  update case_mgmt.preliminary_recommendation
     set status = case when p_decision = 'ENDORSE' then 'AWAITING_APPROVAL' else 'RETURNED' end,
         reviewed_by = v_actor, reviewed_at = now(),
         review_decision = case when p_decision = 'ENDORSE' then 'ENDORSED' else 'RETURNED' end,
         review_comment = v_comment, return_reason_codes = v_codes
   where id = v_r.id;
  update case_mgmt.proceeding
     set status = case when p_decision = 'ENDORSE' then 'AWAITING_APPROVAL' else 'RETURNED' end,
         updated_at = now(), row_version = row_version + 1
   where id = v_r.proceeding_id;
  perform audit.record_event(
    case when p_decision = 'ENDORSE' then 'PRELIMINARY_RECOMMENDATION_ENDORSED' else 'PRELIMINARY_RECOMMENDATION_RETURNED' end,
    'BUSINESS', 'SUCCESS', v_r.case_id, 'preliminary_recommendation', v_r.id::text, null,
    jsonb_build_object('step', 'REVIEW', 'version_no', v_r.version_no, 'reason_codes', to_jsonb(v_codes),
                       'has_comment', v_comment is not null));
end;
$$;

-- Final approval by the GRC Sector Head (Q16–Q17). Approval concludes the proceeding with the recommended outcome.
create function api.approve_preliminary_recommendation(
  p_recommendation_id uuid, p_decision text, p_reason_codes text[], p_comment text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r case_mgmt.preliminary_recommendation;
  v_comment text := case_mgmt.optional_comment(p_comment);
  v_codes text[] := '{}';
begin
  if p_recommendation_id is null or not authz.can_view_preliminary_recommendation(p_recommendation_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if not authz.has_permission('PRELIMINARY_APPROVE') then perform api._fail('FORBIDDEN'); end if;
  select * into v_r from case_mgmt.preliminary_recommendation r where r.id = p_recommendation_id;
  perform 1 from case_mgmt.case_record c where c.id = v_r.case_id for update;
  if (select c.records_state from case_mgmt.case_record c where c.id = v_r.case_id) <> 'ACTIVE' then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  select * into v_r from case_mgmt.preliminary_recommendation r where r.id = p_recommendation_id for update;
  if v_r.status <> 'AWAITING_APPROVAL' then perform api._fail('CONFLICT', 'RECOMMENDATION_NOT_AWAITING_APPROVAL'); end if;
  if v_r.prepared_by = v_actor or v_r.reviewed_by = v_actor then perform api._fail('CONFLICT', 'SEPARATION_OF_DUTIES'); end if;

  if p_decision = 'APPROVE' then
    if p_reason_codes is not null and cardinality(p_reason_codes) > 0 then perform api._fail('INVALID', 'reason_codes'); end if;
    if exists (select 1 from case_mgmt.proceeding c
               where c.parent_proceeding_id = v_r.proceeding_id and c.status not in ('CONCLUDED', 'CANCELLED')) then
      perform api._fail('CONFLICT', 'OPEN_CHILD_PROCEEDINGS');
    end if;
  elsif p_decision = 'RETURN' then
    v_codes := case_mgmt.require_return_reasons(p_reason_codes, v_comment);
  else
    perform api._fail('INVALID', 'decision');
  end if;
  update case_mgmt.preliminary_recommendation
     set status = case when p_decision = 'APPROVE' then 'APPROVED' else 'RETURNED' end,
         approved_by = v_actor, approved_at = now(),
         approval_decision = case when p_decision = 'APPROVE' then 'APPROVED' else 'RETURNED' end,
         approval_comment = v_comment, return_reason_codes = v_codes
   where id = v_r.id;
  if p_decision = 'APPROVE' then
    update case_mgmt.proceeding
       set status = 'CONCLUDED', outcome_code = v_r.recommended_outcome, waiting_reason = null, suspension_reason = null,
           closed_by = v_actor, closed_at = now(), updated_at = now(), row_version = row_version + 1
     where id = v_r.proceeding_id;
    perform audit.record_event('PRELIMINARY_RECOMMENDATION_APPROVED', 'BUSINESS', 'SUCCESS', v_r.case_id,
      'preliminary_recommendation', v_r.id::text, null,
      jsonb_build_object('step', 'APPROVAL', 'version_no', v_r.version_no, 'recommended_outcome', v_r.recommended_outcome,
                         'has_comment', v_comment is not null));
    perform audit.record_event('PROCEEDING_CLOSED', 'BUSINESS', 'SUCCESS', v_r.case_id, 'proceeding', v_r.proceeding_id::text,
      null, jsonb_build_object('proceeding_type', 'PRELIMINARY_REVIEW', 'status', 'CONCLUDED',
                               'outcome_code', v_r.recommended_outcome));
  else
    update case_mgmt.proceeding set status = 'RETURNED', updated_at = now(), row_version = row_version + 1
     where id = v_r.proceeding_id;
    perform audit.record_event('PRELIMINARY_RECOMMENDATION_RETURNED', 'BUSINESS', 'SUCCESS', v_r.case_id,
      'preliminary_recommendation', v_r.id::text, null,
      jsonb_build_object('step', 'APPROVAL', 'version_no', v_r.version_no, 'reason_codes', to_jsonb(v_codes),
                         'has_comment', v_comment is not null));
  end if;
end;
$$;

-- The caller's approval queue: case number and recommendation metadata only, never the case title or summary.
create function api.preliminary_approval_queue()
returns table (recommendation_id uuid, case_id uuid, case_number text, version_no int, recommended_outcome text,
               prepared_role text, prepared_at timestamptz, review_required boolean)
language sql stable security definer
set search_path = ''
as $$
  select r.id, r.case_id, c.case_number, r.version_no, r.recommended_outcome, r.prepared_role, r.prepared_at, r.review_required
  from case_mgmt.preliminary_recommendation r
  join case_mgmt.case_record c on c.id = r.case_id
  where authz.has_permission('PRELIMINARY_APPROVE') and r.status = 'AWAITING_APPROVAL'
    and authz.can_view_preliminary_recommendation(r.id)
  order by r.prepared_at, r.id;
$$;

grant execute on function
  api.create_sector(text, text, text),
  api.appoint_sector_member(uuid, uuid, text, timestamptz, timestamptz, text),
  api.end_sector_membership(uuid, timestamptz, text),
  api.delegate_referral_approval(uuid, uuid, timestamptz, timestamptz, text, text),
  api.revoke_referral_delegation(uuid, text),
  api.create_referral(uuid, text, text, text, core.classification_level),
  api.update_referral(uuid, text, text, text, core.classification_level),
  api.submit_referral(uuid, text),
  api.sector_decide_referral(uuid, text, text[], text),
  api.secretary_decide_referral(uuid, text, text[], text, uuid),
  api.resubmit_referral(uuid, text),
  api.object_to_referral_rejection(uuid, text),
  api.withdraw_referral(uuid, text),
  api.comment_on_referral(uuid, text),
  api.referral_available_actions(uuid),
  api.prepare_preliminary_recommendation(uuid, text, text),
  api.review_preliminary_recommendation(uuid, text, text[], text),
  api.approve_preliminary_recommendation(uuid, text, text[], text),
  api.preliminary_approval_queue()
to authenticated;
