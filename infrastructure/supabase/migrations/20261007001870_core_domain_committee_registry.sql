-- =============================================================================
-- 1870 Core domain and committee registry (Business Architecture Rebase phases 2–3; CDF-186, CDF-188)
-- Requirements: §12–§14, §18–§21, §29, §87; owner Q&A Q21–Q34, Q51–Q54, Q88–Q90; ADR-017, ADR-018, ADR-019
--
-- Additive only. Nothing existing is dropped, renamed or re-pathed; CDF_CASE_V1 keeps running.
--
-- Case structure (ADR-017):
--   case_record.source_type   intake path (WHISTLEBLOWING / DIRECT_REFERRAL / DIRECT_GRIEVANCE / OTHER_AUTHORIZED_SOURCE);
--                             existing rows are backfilled from case_type.
--   case_mgmt.proceeding      the work inside a case (preliminary review, investigation, committee investigation,
--                             legal review, authority decision, corrective action, grievance, reinvestigation), with a
--                             status plus one waiting reason or one suspension reason, and an outcome when closed.
--   case_mgmt.case_subject    the people a case is about (multi-subject cases, Q90).
--   case_mgmt.allegation      gains subject, policy reference and law reference (multi-allegation, Q88–Q89).
--   case_mgmt.finding         versioned finding per allegation × subject × proceeding.
--   case_mgmt.evidence_link   evidence → allegation or finding. Reads authz.can_view_evidence; changes nothing in it.
--   config.status_code        reason and outcome vocabularies (ADR-029); labels live in packages/i18n.
--
-- Committee registry (ADR-018, ADR-019), schema `committee`:
--   committee                 the two permanent committees, INVESTIGATION (IC) and GRIEVANCE (GC).
--   membership                effective-dated seats: CHAIR, DEPUTY_CHAIR, SECRETARY, ALTERNATE_SECRETARY, MEMBER,
--                             ALTERNATE_MEMBER. One seat per person per committee at a time; the four single-holder
--                             seats have one holder at a time. Enforced by the commands under a committee row lock.
--   rule_set                  effective-dated quorum, casting vote, minutes window, deemed approval, grievance window
--                             and admissibility decider. Seeded OWNER_DEFAULT from the owner Q&A.
--   committee_proceeding      opened when a case is referred; copies the effective rule set and members. Snapshots
--   proceeding_member         are never rewritten, so later membership changes do not alter past proceedings (Q30).
--
-- Access (AUTHORIZATION_IMPACT.md):
--   * A global COMMITTEE_* role gives no access. A seat gives registry visibility for that committee; a place in a
--     proceeding's snapshot gives that proceeding. Neither gives case content (DEC-02).
--   * COMMITTEE_ADMIN (PLATFORM_ADMIN, GRC_DIRECTOR; Q28) maintains the registry and sees no proceedings or cases (§21).
--   * Grievance firewall (Q45–Q46): a person who held a voting seat in an IC proceeding of the case is snapshotted
--     into that case's GC proceeding as non-voting.
-- Every command writes its audit event in the same transaction. Audit metadata holds ids and codes, never names.
-- =============================================================================

create schema if not exists committee;
revoke all on schema committee from public;
alter default privileges in schema committee revoke all on tables from public, anon, authenticated;
alter default privileges in schema committee revoke all on sequences from public, anon, authenticated;
alter default privileges in schema committee revoke execute on functions from public, anon, authenticated;
grant usage on schema committee to authenticated;

-- -----------------------------------------------------------------------------
-- Permissions (mirrored in packages/contracts and packages/authorization)
-- -----------------------------------------------------------------------------
insert into iam.permission (code, description) values
  ('COMMITTEE_ADMIN', 'Maintain committee membership and rule sets; gives no access to proceedings or case content');

-- Q28: maintenance by the GRC Director or the system administrator (the Compliance Section Manager role arrives with
-- the preliminary-review slice). SOURCE_REQUIRED: governance approval rules for composition changes.
insert into iam.role_permission (role_code, permission_code) values
  ('PLATFORM_ADMIN', 'COMMITTEE_ADMIN'),
  ('GRC_DIRECTOR',   'COMMITTEE_ADMIN');

-- -----------------------------------------------------------------------------
-- Case intake path
-- -----------------------------------------------------------------------------
alter table case_mgmt.case_record
  add column source_type text not null default 'WHISTLEBLOWING'
    check (source_type in ('WHISTLEBLOWING', 'DIRECT_REFERRAL', 'DIRECT_GRIEVANCE', 'OTHER_AUTHORIZED_SOURCE'));
comment on column case_mgmt.case_record.source_type is
  'Intake path (ADR-017). case_type is kept for compatibility; source_type is the business classification.';
update case_mgmt.case_record set source_type = case case_type
  when 'INTERNAL_REFERRAL' then 'DIRECT_REFERRAL' when 'OTHER' then 'OTHER_AUTHORIZED_SOURCE' else 'WHISTLEBLOWING' end
where case_type <> 'WHISTLEBLOWING';

-- -----------------------------------------------------------------------------
-- Reason and outcome vocabularies (ADR-029). Codes only; user-facing labels come from packages/i18n.
-- -----------------------------------------------------------------------------
create table config.status_code (
  dimension     text not null check (dimension in ('WAITING_REASON', 'SUSPENSION_REASON', 'OUTCOME_CODE')),
  code          text not null check (code ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  source_status text not null check (source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  is_active     boolean not null default true,
  primary key (dimension, code)
);
comment on table config.status_code is
  'Waiting reasons, suspension reasons and outcome codes for proceedings (ADR-029; from the CRM status rationalization).';

insert into config.status_code (dimension, code, source_status) values
  ('WAITING_REASON', 'ALTERNATE_INVESTIGATOR', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'AUTHORITY_DECISION', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'BUDGET_APPROVAL', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'BUSINESS_EXECUTION', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'COI_REVIEW', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'CONFIDENTIALITY_CLASSIFICATION', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'DIGITAL_FORENSICS', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'DOCUMENTS', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'DUPLICATION_CHECK', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'EMPLOYEE_DEFENCE', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'EMPLOYEE_NOTIFICATION', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'EXPERT_OPINION', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'EXTERNAL_INFO', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'GRIEVANCE_COMPLETION', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'INFO_FROM_SOURCE', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'LEGAL_OPINION', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'NON_COOPERATION', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'PARTY_ATTENDANCE', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'PARTY_DOCUMENTS', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'QUORUM', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'REGULATOR_REPORT', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'SCOPE_DEFINITION', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'STAKEHOLDER_NOTIFICATION', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'TIE_BREAK', 'OWNER_DEFAULT'),
  ('WAITING_REASON', 'WITNESS', 'OWNER_DEFAULT'),
  ('SUSPENSION_REASON', 'CONFLICT_OF_INTEREST', 'OWNER_DEFAULT'),
  ('SUSPENSION_REASON', 'FULL', 'OWNER_DEFAULT'),
  ('SUSPENSION_REASON', 'GENERAL', 'OWNER_DEFAULT'),
  ('SUSPENSION_REASON', 'LAWYER_REQUEST', 'OWNER_DEFAULT'),
  ('SUSPENSION_REASON', 'LEAVE_OR_ILLNESS', 'OWNER_DEFAULT'),
  ('SUSPENSION_REASON', 'SOVEREIGN_AUTHORITY', 'OWNER_DEFAULT'),
  ('SUSPENSION_REASON', 'SYSTEM_MANDATED', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'ADMINISTRATIVE_TRACK', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'CHANNEL_ABUSE', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'CORRECTIVE_ACTION', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'DECISION_RECORDED', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'DUPLICATE', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'EMERGENCY_CLOSURE', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'INCONCLUSIVE', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'INCIDENT_LOGGED', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'NON_PROCESSABLE', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'NOT_FEASIBLE', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'NOT_SERIOUS', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'NOT_SUBSTANTIATED', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'NO_ACTION', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'NO_PERSONAL_JURISDICTION', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'OUT_OF_SCOPE', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'PARTIALLY_SUBSTANTIATED', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'RECOMMENDATION_ADOPTED', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'REFERRED_TO_COMMITTEE', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'REGULATORY_ACTION', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'SUBSTANTIATED', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'TRANSFERRED', 'OWNER_DEFAULT'),
  ('OUTCOME_CODE', 'WITHDRAWN', 'OWNER_DEFAULT');

-- -----------------------------------------------------------------------------
-- Case structure tables
-- -----------------------------------------------------------------------------
create table case_mgmt.proceeding (
  id                   uuid primary key default gen_random_uuid(),
  case_id              uuid not null references case_mgmt.case_record (id),
  -- Display number within the case (PRC-001). UUIDs are the keys (§87).
  sequence_no          int not null check (sequence_no >= 1),
  proceeding_type      text not null check (proceeding_type in (
                         'PRELIMINARY_REVIEW', 'INVESTIGATION', 'COMMITTEE_INVESTIGATION', 'LEGAL_REVIEW',
                         'AUTHORITY_DECISION', 'CORRECTIVE_ACTION', 'GRIEVANCE', 'REINVESTIGATION')),
  parent_proceeding_id uuid references case_mgmt.proceeding (id),
  status               text not null default 'OPEN' check (status in (
                         'OPEN', 'IN_PROGRESS', 'AWAITING_REVIEW', 'AWAITING_APPROVAL', 'RETURNED', 'SUSPENDED',
                         'CONCLUDED', 'CANCELLED')),
  waiting_reason       text,
  suspension_reason    text,
  outcome_code         text,
  opened_by            uuid not null references iam.user_profile (id),
  opened_at            timestamptz not null default now(),
  closed_by            uuid references iam.user_profile (id),
  closed_at            timestamptz,
  updated_at           timestamptz not null default now(),
  row_version          int not null default 1,
  unique (case_id, sequence_no),
  check (parent_proceeding_id is null or parent_proceeding_id <> id),
  -- One current value per dimension: suspended means a suspension reason and no waiting reason.
  check ((status = 'SUSPENDED') = (suspension_reason is not null)),
  check (status <> 'SUSPENDED' or waiting_reason is null),
  check ((status in ('CONCLUDED', 'CANCELLED')) = (closed_at is not null)),
  check ((closed_at is null) = (closed_by is null)),
  check (status <> 'CONCLUDED' or outcome_code is not null),
  check (status not in ('CONCLUDED', 'CANCELLED') or (waiting_reason is null and suspension_reason is null))
);
create index proceeding_case on case_mgmt.proceeding (case_id, sequence_no);
create index proceeding_parent on case_mgmt.proceeding (parent_proceeding_id);
create index proceeding_opened_by on case_mgmt.proceeding (opened_by);
create index proceeding_closed_by on case_mgmt.proceeding (closed_by);
comment on table case_mgmt.proceeding is 'A unit of work inside a case (ADR-017). The case stage is derived from its open proceedings.';

create table case_mgmt.case_subject (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid not null references case_mgmt.case_record (id),
  person_id        uuid not null references case_mgmt.person (id),
  subject_category text not null check (subject_category in ('EMPLOYEE', 'CONTRACTOR', 'OTHER_AUTHORIZED')),
  added_by         uuid not null references iam.user_profile (id),
  added_at         timestamptz not null default now(),
  unique (case_id, person_id)
);
create index case_subject_person on case_mgmt.case_subject (person_id);
create index case_subject_added_by on case_mgmt.case_subject (added_by);
comment on table case_mgmt.case_subject is 'People a case is about (ADR-017; multi-subject, Q90). Append-only. Names live on case_mgmt.person.';

alter table case_mgmt.allegation
  add column subject_id       uuid references case_mgmt.case_subject (id),
  add column policy_reference text check (length(policy_reference) between 2 and 200),
  add column law_reference    text check (length(law_reference) between 2 and 200);
create index allegation_subject on case_mgmt.allegation (subject_id);

create table case_mgmt.finding (
  id            uuid primary key default gen_random_uuid(),
  case_id       uuid not null references case_mgmt.case_record (id),
  allegation_id uuid not null references case_mgmt.allegation (id),
  subject_id    uuid references case_mgmt.case_subject (id),
  proceeding_id uuid not null references case_mgmt.proceeding (id),
  version_no    int not null check (version_no >= 1),
  result        text not null check (result in ('SUBSTANTIATED', 'PARTIALLY_SUBSTANTIATED', 'NOT_SUBSTANTIATED', 'INCONCLUSIVE')),
  rationale     text not null check (length(rationale) between 10 and 8000),
  recorded_by   uuid not null references iam.user_profile (id),
  recorded_at   timestamptz not null default now()
);
-- One version line per allegation × subject (or the allegation as a whole) × proceeding.
create unique index finding_version on case_mgmt.finding
  (allegation_id, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid), proceeding_id, version_no);
create index finding_case on case_mgmt.finding (case_id);
create index finding_subject on case_mgmt.finding (subject_id);
create index finding_proceeding on case_mgmt.finding (proceeding_id);
create index finding_recorded_by on case_mgmt.finding (recorded_by);
comment on table case_mgmt.finding is 'Versioned findings (ADR-017). Append-only; the highest version_no is current.';

create table case_mgmt.evidence_link (
  id            uuid primary key default gen_random_uuid(),
  case_id       uuid not null references case_mgmt.case_record (id),
  evidence_id   uuid not null references evidence.evidence (id),
  allegation_id uuid references case_mgmt.allegation (id),
  finding_id    uuid references case_mgmt.finding (id),
  linked_by     uuid not null references iam.user_profile (id),
  linked_at     timestamptz not null default now(),
  check ((allegation_id is null) <> (finding_id is null))
);
create unique index evidence_link_target on case_mgmt.evidence_link
  (evidence_id, coalesce(allegation_id, finding_id));
create index evidence_link_case on case_mgmt.evidence_link (case_id);
create index evidence_link_allegation on case_mgmt.evidence_link (allegation_id);
create index evidence_link_finding on case_mgmt.evidence_link (finding_id);
create index evidence_link_linked_by on case_mgmt.evidence_link (linked_by);
comment on table case_mgmt.evidence_link is 'Evidence supporting an allegation or a finding (ADR-017). Append-only. Content stays in evidence storage.';

-- -----------------------------------------------------------------------------
-- Committee registry tables
-- -----------------------------------------------------------------------------
create table committee.committee (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^[A-Z]{2,10}$'),
  kind       text not null unique check (kind in ('INVESTIGATION', 'GRIEVANCE')),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table committee.committee is 'Permanent committees (ADR-018, Q21). Names come from packages/i18n by code.';

insert into committee.committee (code, kind) values ('IC', 'INVESTIGATION'), ('GC', 'GRIEVANCE');

create table committee.membership (
  id                    uuid primary key default gen_random_uuid(),
  committee_id          uuid not null references committee.committee (id),
  user_id               uuid not null references iam.user_profile (id),
  seat                  text not null check (seat in (
                          'CHAIR', 'DEPUTY_CHAIR', 'SECRETARY', 'ALTERNATE_SECRETARY', 'MEMBER', 'ALTERNATE_MEMBER')),
  effective_from        timestamptz not null,
  effective_to          timestamptz,
  appointment_reference text not null check (length(appointment_reference) between 3 and 200),
  appointed_by          uuid not null references iam.user_profile (id),
  appointed_at          timestamptz not null default now(),
  ended_by              uuid references iam.user_profile (id),
  ended_at              timestamptz,
  end_reason            text check (length(end_reason) between 5 and 2000),
  check (effective_to is null or effective_to > effective_from),
  check ((ended_by is null) = (ended_at is null) and (ended_at is null) = (end_reason is null))
);
create index membership_committee on committee.membership (committee_id, seat, effective_from);
create index membership_user on committee.membership (user_id);
create index membership_appointed_by on committee.membership (appointed_by);
create index membership_ended_by on committee.membership (ended_by);
comment on table committee.membership is 'Effective-dated seats (ADR-019, Q22–Q27). A row is ended by shortening effective_to, never deleted.';

create table committee.rule_set (
  id                           uuid primary key default gen_random_uuid(),
  committee_id                 uuid not null references committee.committee (id),
  effective_from               timestamptz not null,
  effective_to                 timestamptz,
  quorum_type                  text not null check (quorum_type in ('MAJORITY_ELIGIBLE', 'FIXED_NUMBER', 'PERCENTAGE', 'CUSTOM')),
  quorum_value                 numeric,
  casting_vote_enabled         boolean not null,
  minutes_review_business_days int not null check (minutes_review_business_days between 1 and 30),
  deemed_approval_enabled      boolean not null,
  grievance_window_days        int check (grievance_window_days between 1 and 365),
  admissibility_decider        text check (admissibility_decider in ('SECRETARY', 'CHAIR', 'COMMITTEE')),
  source_status                text not null check (source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  reason                       text check (length(reason) between 5 and 2000),
  created_by                   uuid references iam.user_profile (id),
  created_at                   timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  check (case quorum_type
           when 'FIXED_NUMBER' then quorum_value is not null and quorum_value >= 1 and quorum_value = trunc(quorum_value)
           when 'PERCENTAGE' then quorum_value is not null and quorum_value > 0 and quorum_value <= 100
           else quorum_value is null end),
  -- Seeded rows have no creator; every row written by a command has one.
  check (created_by is not null or source_status = 'OWNER_DEFAULT')
);
create index rule_set_committee on committee.rule_set (committee_id, effective_from);
create index rule_set_created_by on committee.rule_set (created_by);
comment on table committee.rule_set is 'Effective-dated committee rules (ADR-019, Q51–Q57, Q94, Q98). Rows only ever gain an effective_to.';

-- Owner defaults from the Q&A: majority of non-conflicted eligible members, chair casting vote on a tie, three business
-- days for minutes then deemed approval, 30-day grievance window, admissibility recorded by the GC Secretary.
insert into committee.rule_set (committee_id, effective_from, quorum_type, casting_vote_enabled, minutes_review_business_days,
                                deemed_approval_enabled, grievance_window_days, admissibility_decider, source_status)
select c.id, timestamptz '2026-01-01 00:00:00+00', 'MAJORITY_ELIGIBLE', true, 3, true,
       case when c.kind = 'GRIEVANCE' then 30 end, case when c.kind = 'GRIEVANCE' then 'SECRETARY' end, 'OWNER_DEFAULT'
from committee.committee c;

create table committee.committee_proceeding (
  id            uuid primary key default gen_random_uuid(),
  proceeding_id uuid not null unique references case_mgmt.proceeding (id),
  committee_id  uuid not null references committee.committee (id),
  case_id       uuid not null references case_mgmt.case_record (id),
  rule_set_id   uuid not null references committee.rule_set (id),
  -- Copy of the rule set in force at referral; later rule changes never reach this proceeding.
  rule_snapshot jsonb not null check (jsonb_typeof(rule_snapshot) = 'object'),
  status        text not null default 'OPEN' check (status in ('OPEN', 'CONCLUDED', 'CANCELLED')),
  referred_by   uuid not null references iam.user_profile (id),
  referred_at   timestamptz not null default now(),
  closed_at     timestamptz,
  check ((status = 'OPEN') = (closed_at is null))
);
create index committee_proceeding_committee on committee.committee_proceeding (committee_id, status);
create index committee_proceeding_case on committee.committee_proceeding (case_id);
create index committee_proceeding_rule_set on committee.committee_proceeding (rule_set_id);
create index committee_proceeding_referred_by on committee.committee_proceeding (referred_by);
comment on table committee.committee_proceeding is 'A case before a committee (ADR-018) with an immutable rule snapshot.';

create table committee.proceeding_member (
  id                      uuid primary key default gen_random_uuid(),
  committee_proceeding_id uuid not null references committee.committee_proceeding (id),
  user_id                 uuid not null references iam.user_profile (id),
  membership_id           uuid not null references committee.membership (id),
  seat                    text not null check (seat in (
                            'CHAIR', 'DEPUTY_CHAIR', 'SECRETARY', 'ALTERNATE_SECRETARY', 'MEMBER', 'ALTERNATE_MEMBER')),
  is_voting               boolean not null,
  -- Grievance independence (Q45–Q46): set when an IC voting member is snapshotted into the same case's GC.
  firewall_restricted     boolean not null default false,
  snapshotted_at          timestamptz not null default now(),
  unique (committee_proceeding_id, user_id),
  check (not (firewall_restricted and is_voting))
);
create index proceeding_member_user on committee.proceeding_member (user_id);
create index proceeding_member_membership on committee.proceeding_member (membership_id);
comment on table committee.proceeding_member is 'Who sat on a committee proceeding and in which seat (Q30). Append-only.';

-- -----------------------------------------------------------------------------
-- Integrity: append-only rows, frozen identity columns, monotonic effective dates
-- -----------------------------------------------------------------------------
create function committee.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%.% is append-only (% rejected)', tg_table_schema, tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['case_mgmt.case_subject', 'case_mgmt.finding', 'case_mgmt.evidence_link',
                           'committee.proceeding_member'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
  foreach t in array array['case_mgmt.proceeding', 'committee.committee', 'committee.membership', 'committee.rule_set',
                           'committee.committee_proceeding'] loop
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;

create function case_mgmt.protect_proceeding()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('CONCLUDED', 'CANCELLED') then
    raise exception 'proceeding % is closed and immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  if new.id <> old.id or new.case_id <> old.case_id or new.sequence_no <> old.sequence_no
     or new.proceeding_type <> old.proceeding_type
     or new.parent_proceeding_id is distinct from old.parent_proceeding_id
     or new.opened_by <> old.opened_by or new.opened_at <> old.opened_at then
    raise exception 'proceeding % identity fields are immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger proceeding_protect before update on case_mgmt.proceeding
  for each row execute function case_mgmt.protect_proceeding();

create function committee.protect_registry()
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
    -- Only the end of the period may move, and only earlier; history is never rewritten (Q30).
    if (to_jsonb(new) - array['effective_to', 'ended_by', 'ended_at', 'end_reason'])
       <> (to_jsonb(old) - array['effective_to', 'ended_by', 'ended_at', 'end_reason'])
       or old.ended_at is not null
       or (old.effective_to is not null and (new.effective_to is null or new.effective_to > old.effective_to)) then
      raise exception 'membership % can only be ended earlier, once', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'rule_set' then
    if (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') or old.effective_to is not null then
      raise exception 'rule set % can only be given an end, once', old.id using errcode = 'insufficient_privilege';
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
create trigger committee_protect before update on committee.committee
  for each row execute function committee.protect_registry();
create trigger membership_protect before update on committee.membership
  for each row execute function committee.protect_registry();
create trigger rule_set_protect before update on committee.rule_set
  for each row execute function committee.protect_registry();
create trigger committee_proceeding_protect before update on committee.committee_proceeding
  for each row execute function committee.protect_registry();

-- -----------------------------------------------------------------------------
-- Authorization predicates (§19). Seats, not roles.
-- -----------------------------------------------------------------------------
-- The seat a user holds in a committee at an instant, or null. Internal (callers: predicates and commands).
create function authz.user_committee_seat(p_user_id uuid, p_committee_id uuid, p_at timestamptz)
returns text
language sql stable security definer
set search_path = ''
as $$
  select m.seat
  from committee.membership m
  join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
  where m.user_id = p_user_id and m.committee_id = p_committee_id
    and m.effective_from <= p_at and (m.effective_to is null or m.effective_to > p_at)
  order by m.effective_from desc
  limit 1;
$$;

-- The caller is the committee's secretary or alternate secretary now.
create function authz.is_committee_secretary(p_committee_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null
     and coalesce(authz.user_committee_seat(authz.current_user_id(), p_committee_id, now())
                  in ('SECRETARY', 'ALTERNATE_SECRETARY'), false);
$$;

-- Registry visibility (membership and rules of one committee): registry administrators, and anyone seated on it now.
create function authz.can_view_committee_registry(p_committee_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null
     and (authz.has_permission('COMMITTEE_ADMIN')
          or authz.user_committee_seat(authz.current_user_id(), p_committee_id, now()) is not null);
$$;

-- A committee proceeding: its snapshotted members, the committee's current secretaries, and the case team that can
-- already see the case. COMMITTEE_ADMIN alone gives nothing here (§21).
create function authz.can_view_committee_proceeding(p_committee_proceeding_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from committee.committee_proceeding cp
    where cp.id = p_committee_proceeding_id
      and (exists (select 1 from committee.proceeding_member pm
                   where pm.committee_proceeding_id = cp.id and pm.user_id = authz.current_user_id())
           or authz.is_committee_secretary(cp.committee_id)
           or authz.can_view_case(cp.case_id))
  );
$$;

create function authz.can_view_proceeding(p_proceeding_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from case_mgmt.proceeding p
    where p.id = p_proceeding_id
      and (authz.can_view_case(p.case_id)
           or exists (select 1 from committee.committee_proceeding cp
                      where cp.proceeding_id = p.id and authz.can_view_committee_proceeding(cp.id)))
  );
$$;

-- Grievance firewall (Q45): the user held a voting seat in an Investigation Committee proceeding of the case.
-- Internal: answers about any user, so it is not granted to application roles.
create function authz.participated_in_investigation_committee(p_user_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from committee.proceeding_member pm
    join committee.committee_proceeding cp on cp.id = pm.committee_proceeding_id
    join committee.committee c on c.id = cp.committee_id
    where cp.case_id = p_case_id and pm.user_id = p_user_id and pm.is_voting and c.kind = 'INVESTIGATION'
  );
$$;

-- Recording findings and linking evidence: the people who edit the case, plus assigned investigators.
create function authz.can_record_findings(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id)
     and exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state = 'ACTIVE')
     and (authz.can_edit_case(p_case_id)
          or authz.has_active_assignment(p_case_id, authz.current_user_id(), array['INVESTIGATOR']));
$$;

grant execute on function
  authz.is_committee_secretary(uuid), authz.can_view_committee_registry(uuid),
  authz.can_view_committee_proceeding(uuid), authz.can_view_proceeding(uuid), authz.can_record_findings(uuid)
to authenticated;

-- -----------------------------------------------------------------------------
-- RLS (SELECT only; no write grants for application roles)
-- -----------------------------------------------------------------------------
alter table config.status_code enable row level security;
alter table case_mgmt.proceeding enable row level security;
alter table case_mgmt.case_subject enable row level security;
alter table case_mgmt.finding enable row level security;
alter table case_mgmt.evidence_link enable row level security;
alter table committee.committee enable row level security;
alter table committee.membership enable row level security;
alter table committee.rule_set enable row level security;
alter table committee.committee_proceeding enable row level security;
alter table committee.proceeding_member enable row level security;

create policy status_code_read on config.status_code for select to authenticated using (authz.current_user_id() is not null);
grant select on config.status_code to authenticated;

create policy proceeding_read on case_mgmt.proceeding for select to authenticated using (authz.can_view_proceeding(id));
grant select on case_mgmt.proceeding to authenticated;

create policy case_subject_read on case_mgmt.case_subject for select to authenticated using (authz.can_view_case(case_id));
grant select on case_mgmt.case_subject to authenticated;

create policy finding_read on case_mgmt.finding for select to authenticated using (authz.can_view_case(case_id));
grant select on case_mgmt.finding to authenticated;

-- A link is listed only when the viewer may also see the evidence item (its clearance may be higher).
create policy evidence_link_read on case_mgmt.evidence_link for select to authenticated
  using (authz.can_view_case(case_id) and authz.can_view_evidence(evidence_id));
grant select on case_mgmt.evidence_link to authenticated;

-- Committee codes and kinds are reference data, not case content.
create policy committee_read on committee.committee for select to authenticated using (authz.current_user_id() is not null);
grant select on committee.committee to authenticated;

create policy membership_read on committee.membership for select to authenticated
  using (authz.can_view_committee_registry(committee_id));
grant select on committee.membership to authenticated;

create policy rule_set_read on committee.rule_set for select to authenticated
  using (authz.can_view_committee_registry(committee_id));
grant select on committee.rule_set to authenticated;

create policy committee_proceeding_read on committee.committee_proceeding for select to authenticated
  using (authz.can_view_committee_proceeding(id));
grant select on committee.committee_proceeding to authenticated;

create policy proceeding_member_read on committee.proceeding_member for select to authenticated
  using (authz.can_view_committee_proceeding(committee_proceeding_id));
grant select on committee.proceeding_member to authenticated;

-- -----------------------------------------------------------------------------
-- Internal helpers (owner context; not granted to application roles)
-- -----------------------------------------------------------------------------
create function case_mgmt.require_status_code(p_dimension text, p_code text, p_field text)
returns void
language plpgsql stable
set search_path = ''
as $$
begin
  if p_code is null or not exists (
    select 1 from config.status_code s where s.dimension = p_dimension and s.code = p_code and s.is_active
  ) then
    perform api._fail('INVALID', p_field);
  end if;
end;
$$;

-- Locks and returns an active case the caller may edit. Invisible and missing are alike (NOT_FOUND).
create function case_mgmt.lock_editable_case(p_case_id uuid)
returns case_mgmt.case_record
language plpgsql
set search_path = ''
as $$
declare v case_mgmt.case_record;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_edit_case(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v from case_mgmt.case_record c where c.id = p_case_id for update;
  if v.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
  return v;
end;
$$;

create function case_mgmt.insert_proceeding(p_case_id uuid, p_type text, p_parent uuid, p_actor uuid)
returns case_mgmt.proceeding
language plpgsql
set search_path = ''
as $$
declare v case_mgmt.proceeding;
begin
  -- The caller holds the case row lock, which serialises numbering.
  insert into case_mgmt.proceeding (case_id, sequence_no, proceeding_type, parent_proceeding_id, opened_by)
  values (p_case_id,
          (select coalesce(max(p.sequence_no), 0) + 1 from case_mgmt.proceeding p where p.case_id = p_case_id),
          p_type, p_parent, p_actor)
  returning * into v;
  return v;
end;
$$;

create function case_mgmt.require_parent_proceeding(p_case_id uuid, p_parent uuid)
returns void
language plpgsql stable
set search_path = ''
as $$
begin
  if p_parent is not null and not exists (
    select 1 from case_mgmt.proceeding p where p.id = p_parent and p.case_id = p_case_id
  ) then
    perform api._fail('INVALID', 'parent_proceeding_id');
  end if;
end;
$$;

-- Committee commands lock the committee row: membership and rule-set overlap checks then see a stable registry.
create function committee.lock_committee(p_committee_id uuid)
returns committee.committee
language plpgsql
set search_path = ''
as $$
declare v committee.committee;
begin
  select * into v from committee.committee c where c.id = p_committee_id for update;
  if v.id is null then perform api._fail('NOT_FOUND'); end if;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Case structure commands
-- -----------------------------------------------------------------------------
-- Committee and grievance proceedings are opened only by api.refer_case_to_committee, which snapshots the committee.
create function api.open_proceeding(p_case_id uuid, p_proceeding_type text, p_parent_proceeding_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_p case_mgmt.proceeding;
  v_reason text;
begin
  v_case := case_mgmt.lock_editable_case(p_case_id);
  if p_proceeding_type is null or p_proceeding_type not in (
       'PRELIMINARY_REVIEW', 'INVESTIGATION', 'LEGAL_REVIEW', 'AUTHORITY_DECISION', 'CORRECTIVE_ACTION', 'REINVESTIGATION') then
    perform api._fail('INVALID', 'proceeding_type');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform case_mgmt.require_parent_proceeding(p_case_id, p_parent_proceeding_id);
  -- Corrective actions and reinvestigations may run in parallel; other types one open at a time.
  if p_proceeding_type not in ('CORRECTIVE_ACTION', 'REINVESTIGATION') and exists (
    select 1 from case_mgmt.proceeding p
    where p.case_id = p_case_id and p.proceeding_type = p_proceeding_type and p.status not in ('CONCLUDED', 'CANCELLED')
  ) then
    perform api._fail('CONFLICT', 'PROCEEDING_ALREADY_OPEN');
  end if;

  v_p := case_mgmt.insert_proceeding(p_case_id, p_proceeding_type, p_parent_proceeding_id, v_actor);
  perform audit.record_event('PROCEEDING_OPENED', 'BUSINESS', 'SUCCESS', p_case_id, 'proceeding', v_p.id::text, v_reason,
    jsonb_build_object('proceeding_type', p_proceeding_type, 'sequence_no', v_p.sequence_no,
                       'parent_proceeding_id', p_parent_proceeding_id));
  return v_p.id;
end;
$$;

create function api.update_proceeding_state(
  p_proceeding_id uuid, p_status text, p_waiting_reason text, p_suspension_reason text, p_reason text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p case_mgmt.proceeding;
  v_reason text;
begin
  select * into v_p from case_mgmt.proceeding p where p.id = p_proceeding_id;
  if v_p.id is null or not authz.can_view_case(v_p.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform case_mgmt.lock_editable_case(v_p.case_id);
  select * into v_p from case_mgmt.proceeding p where p.id = p_proceeding_id for update;
  if v_p.status in ('CONCLUDED', 'CANCELLED') then perform api._fail('CONFLICT', 'PROCEEDING_CLOSED'); end if;
  if p_status is null or p_status not in ('OPEN', 'IN_PROGRESS', 'AWAITING_REVIEW', 'AWAITING_APPROVAL', 'RETURNED', 'SUSPENDED') then
    perform api._fail('INVALID', 'status');
  end if;
  if p_status = 'SUSPENDED' then
    perform case_mgmt.require_status_code('SUSPENSION_REASON', p_suspension_reason, 'suspension_reason');
    if p_waiting_reason is not null then perform api._fail('INVALID', 'waiting_reason'); end if;
  else
    if p_suspension_reason is not null then perform api._fail('INVALID', 'suspension_reason'); end if;
    if p_waiting_reason is not null then
      perform case_mgmt.require_status_code('WAITING_REASON', p_waiting_reason, 'waiting_reason');
    end if;
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);

  update case_mgmt.proceeding
     set status = p_status, waiting_reason = p_waiting_reason, suspension_reason = p_suspension_reason,
         updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event('PROCEEDING_STATE_CHANGED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'proceeding', v_p.id::text, v_reason,
    jsonb_build_object('from_status', v_p.status, 'to_status', p_status, 'waiting_reason', p_waiting_reason,
                       'suspension_reason', p_suspension_reason));
end;
$$;

create function api.close_proceeding(p_proceeding_id uuid, p_status text, p_outcome_code text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p case_mgmt.proceeding;
  v_reason text;
begin
  select * into v_p from case_mgmt.proceeding p where p.id = p_proceeding_id;
  if v_p.id is null or not authz.can_view_case(v_p.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform case_mgmt.lock_editable_case(v_p.case_id);
  select * into v_p from case_mgmt.proceeding p where p.id = p_proceeding_id for update;
  if v_p.status in ('CONCLUDED', 'CANCELLED') then perform api._fail('CONFLICT', 'PROCEEDING_CLOSED'); end if;
  if p_status is null or p_status not in ('CONCLUDED', 'CANCELLED') then perform api._fail('INVALID', 'status'); end if;
  if p_status = 'CONCLUDED' then
    perform case_mgmt.require_status_code('OUTCOME_CODE', p_outcome_code, 'outcome_code');
  elsif p_outcome_code is not null then
    perform api._fail('INVALID', 'outcome_code');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  if exists (select 1 from case_mgmt.proceeding c
             where c.parent_proceeding_id = v_p.id and c.status not in ('CONCLUDED', 'CANCELLED')) then
    perform api._fail('CONFLICT', 'OPEN_CHILD_PROCEEDINGS');
  end if;

  update case_mgmt.proceeding
     set status = p_status, outcome_code = p_outcome_code, waiting_reason = null, suspension_reason = null,
         closed_by = v_actor, closed_at = now(), updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  update committee.committee_proceeding set status = p_status, closed_at = now() where proceeding_id = v_p.id;
  perform audit.record_event('PROCEEDING_CLOSED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'proceeding', v_p.id::text, v_reason,
    jsonb_build_object('proceeding_type', v_p.proceeding_type, 'status', p_status, 'outcome_code', p_outcome_code));
end;
$$;

-- A subject is a person on the case: a new synthetic person (label + category), or a person already linked to this
-- case. A person from another case cannot be named, so the command reveals nothing beyond this case.
create function api.add_case_subject(p_case_id uuid, p_display_label text, p_subject_category text, p_person_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_person uuid := p_person_id;
  v_id uuid;
begin
  perform case_mgmt.lock_editable_case(p_case_id);
  if p_subject_category is null or p_subject_category not in ('EMPLOYEE', 'CONTRACTOR', 'OTHER_AUTHORIZED') then
    perform api._fail('INVALID', 'subject_category');
  end if;
  if v_person is null then
    insert into case_mgmt.person (display_name, person_type)
    values (api._require_text(p_display_label, 'display_label', 2, 200),
            case p_subject_category when 'EMPLOYEE' then 'EMPLOYEE' when 'CONTRACTOR' then 'CONTRACTOR' else 'EXTERNAL' end)
    returning id into v_person;
  else
    if p_display_label is not null then perform api._fail('INVALID', 'display_label'); end if;
    if not exists (select 1 from case_mgmt.case_person cp where cp.case_id = p_case_id and cp.person_id = v_person) then
      perform api._fail('INVALID', 'person_id');
    end if;
  end if;
  if exists (select 1 from case_mgmt.case_subject s where s.case_id = p_case_id and s.person_id = v_person) then
    perform api._fail('CONFLICT', 'ALREADY_SUBJECT');
  end if;

  insert into case_mgmt.case_person (case_id, person_id, role, added_by)
  values (p_case_id, v_person, 'SUBJECT', v_actor)
  on conflict (case_id, person_id, role) do nothing;
  insert into case_mgmt.case_subject (case_id, person_id, subject_category, added_by)
  values (p_case_id, v_person, p_subject_category, v_actor)
  returning id into v_id;
  perform audit.record_event('CASE_SUBJECT_ADDED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_subject', v_id::text, null,
    jsonb_build_object('subject_category', p_subject_category, 'existing_person', p_person_id is not null));
  return v_id;
end;
$$;

create function api.add_allegation(
  p_case_id uuid, p_category text, p_description text, p_subject_id uuid, p_policy_reference text, p_law_reference text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
begin
  perform case_mgmt.lock_editable_case(p_case_id);
  if p_category is null or p_category !~ '^[A-Z_]{3,40}$' then perform api._fail('INVALID', 'category'); end if;
  if p_subject_id is not null and not exists (
    select 1 from case_mgmt.case_subject s where s.id = p_subject_id and s.case_id = p_case_id
  ) then
    perform api._fail('INVALID', 'subject_id');
  end if;
  if p_policy_reference is not null and length(btrim(p_policy_reference)) not between 2 and 200 then
    perform api._fail('INVALID', 'policy_reference');
  end if;
  if p_law_reference is not null and length(btrim(p_law_reference)) not between 2 and 200 then
    perform api._fail('INVALID', 'law_reference');
  end if;

  insert into case_mgmt.allegation (case_id, category, description, created_by, subject_id, policy_reference, law_reference)
  values (p_case_id, p_category, api._require_text(p_description, 'description', 10, 8000), v_actor, p_subject_id,
          nullif(btrim(coalesce(p_policy_reference, '')), ''), nullif(btrim(coalesce(p_law_reference, '')), ''))
  returning id into v_id;
  perform audit.record_event('ALLEGATION_ADDED', 'BUSINESS', 'SUCCESS', p_case_id, 'allegation', v_id::text, null,
    jsonb_build_object('category', p_category, 'subject_id', p_subject_id,
                       'policy_reference_set', p_policy_reference is not null, 'law_reference_set', p_law_reference is not null));
  return v_id;
end;
$$;

-- Links an existing allegation (for example the one created from the report) to a subject and its references.
create function api.link_allegation_subject(
  p_allegation_id uuid, p_subject_id uuid, p_policy_reference text, p_law_reference text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_a case_mgmt.allegation;
begin
  perform api._actor();
  select * into v_a from case_mgmt.allegation a where a.id = p_allegation_id;
  if v_a.id is null or not authz.can_view_case(v_a.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform case_mgmt.lock_editable_case(v_a.case_id);
  if v_a.status = 'WITHDRAWN' then perform api._fail('CONFLICT', 'ALLEGATION_WITHDRAWN'); end if;
  if p_subject_id is null or not exists (
    select 1 from case_mgmt.case_subject s where s.id = p_subject_id and s.case_id = v_a.case_id
  ) then
    perform api._fail('INVALID', 'subject_id');
  end if;
  if v_a.subject_id is not null and v_a.subject_id <> p_subject_id then
    perform api._fail('CONFLICT', 'ALLEGATION_SUBJECT_SET');
  end if;
  if p_policy_reference is not null and length(btrim(p_policy_reference)) not between 2 and 200 then
    perform api._fail('INVALID', 'policy_reference');
  end if;
  if p_law_reference is not null and length(btrim(p_law_reference)) not between 2 and 200 then
    perform api._fail('INVALID', 'law_reference');
  end if;

  update case_mgmt.allegation
     set subject_id = p_subject_id,
         policy_reference = coalesce(nullif(btrim(coalesce(p_policy_reference, '')), ''), policy_reference),
         law_reference = coalesce(nullif(btrim(coalesce(p_law_reference, '')), ''), law_reference)
   where id = v_a.id;
  perform audit.record_event('ALLEGATION_SUBJECT_LINKED', 'BUSINESS', 'SUCCESS', v_a.case_id, 'allegation', v_a.id::text, null,
    jsonb_build_object('subject_id', p_subject_id, 'policy_reference_set', p_policy_reference is not null,
                       'law_reference_set', p_law_reference is not null));
end;
$$;

create function api.record_finding(
  p_allegation_id uuid, p_subject_id uuid, p_proceeding_id uuid, p_result text, p_rationale text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_a case_mgmt.allegation;
  v_subject uuid;
  v_version int;
  v_id uuid;
begin
  select * into v_a from case_mgmt.allegation a where a.id = p_allegation_id;
  if v_a.id is null or not authz.can_view_case(v_a.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_record_findings(v_a.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_a.case_id for update;
  if v_a.status = 'WITHDRAWN' then perform api._fail('CONFLICT', 'ALLEGATION_WITHDRAWN'); end if;
  v_subject := coalesce(p_subject_id, v_a.subject_id);
  if v_subject is not null and not exists (
    select 1 from case_mgmt.case_subject s where s.id = v_subject and s.case_id = v_a.case_id
  ) then
    perform api._fail('INVALID', 'subject_id');
  end if;
  if p_proceeding_id is null or not exists (
    select 1 from case_mgmt.proceeding p
    where p.id = p_proceeding_id and p.case_id = v_a.case_id and p.status not in ('CONCLUDED', 'CANCELLED')
  ) then
    perform api._fail('INVALID', 'proceeding_id');
  end if;
  if p_result is null or p_result not in ('SUBSTANTIATED', 'PARTIALLY_SUBSTANTIATED', 'NOT_SUBSTANTIATED', 'INCONCLUSIVE') then
    perform api._fail('INVALID', 'result');
  end if;

  select coalesce(max(f.version_no), 0) + 1 into v_version from case_mgmt.finding f
  where f.allegation_id = v_a.id and f.subject_id is not distinct from v_subject and f.proceeding_id = p_proceeding_id;
  insert into case_mgmt.finding (case_id, allegation_id, subject_id, proceeding_id, version_no, result, rationale, recorded_by)
  values (v_a.case_id, v_a.id, v_subject, p_proceeding_id, v_version, p_result,
          api._require_text(p_rationale, 'rationale', 10, 8000), v_actor)
  returning id into v_id;
  perform audit.record_event('FINDING_RECORDED', 'BUSINESS', 'SUCCESS', v_a.case_id, 'finding', v_id::text, null,
    jsonb_build_object('allegation_id', v_a.id, 'subject_id', v_subject, 'proceeding_id', p_proceeding_id,
                       'result', p_result, 'version_no', v_version));
  return v_id;
end;
$$;

-- Evidence from another case, or evidence the caller may not see, gets the same answer as an id that does not exist.
create function api.link_supporting_material(p_evidence_id uuid, p_allegation_id uuid, p_finding_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case uuid;
  v_id uuid;
begin
  if (p_allegation_id is null) = (p_finding_id is null) then perform api._fail('INVALID', 'target'); end if;
  if p_allegation_id is not null then
    select a.case_id into v_case from case_mgmt.allegation a where a.id = p_allegation_id;
  else
    select f.case_id into v_case from case_mgmt.finding f where f.id = p_finding_id;
  end if;
  if v_case is null or not authz.can_view_case(v_case) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_record_findings(v_case) then perform api._fail('FORBIDDEN'); end if;
  if p_evidence_id is null or not exists (select 1 from evidence.evidence e where e.id = p_evidence_id and e.case_id = v_case)
     or not authz.can_view_evidence(p_evidence_id) then
    perform api._fail('INVALID', 'evidence_id');
  end if;
  if exists (select 1 from case_mgmt.evidence_link l
             where l.evidence_id = p_evidence_id and coalesce(l.allegation_id, l.finding_id) = coalesce(p_allegation_id, p_finding_id)) then
    perform api._fail('CONFLICT', 'ALREADY_LINKED');
  end if;

  insert into case_mgmt.evidence_link (case_id, evidence_id, allegation_id, finding_id, linked_by)
  values (v_case, p_evidence_id, p_allegation_id, p_finding_id, v_actor)
  returning id into v_id;
  perform audit.record_event('EVIDENCE_LINKED', 'BUSINESS', 'SUCCESS', v_case, 'evidence_link', v_id::text, null,
    jsonb_build_object('evidence_id', p_evidence_id, 'allegation_id', p_allegation_id, 'finding_id', p_finding_id));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Committee registry commands (COMMITTEE_ADMIN)
-- -----------------------------------------------------------------------------
create function api.appoint_committee_member(
  p_committee_id uuid, p_user_id uuid, p_seat text, p_effective_from timestamptz, p_effective_to timestamptz,
  p_appointment_reference text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_range tstzrange;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  perform committee.lock_committee(p_committee_id);
  if p_seat is null or p_seat not in ('CHAIR', 'DEPUTY_CHAIR', 'SECRETARY', 'ALTERNATE_SECRETARY', 'MEMBER', 'ALTERNATE_MEMBER') then
    perform api._fail('INVALID', 'seat');
  end if;
  if p_user_id is null or not exists (select 1 from iam.user_profile u where u.id = p_user_id and u.status = 'ACTIVE') then
    perform api._fail('INVALID', 'user_id');
  end if;
  -- Governance: an administrator does not seat themselves (SOURCE_REQUIRED: composition approval rules, Q28).
  if p_user_id = v_actor then perform api._fail('CONFLICT', 'SELF_APPOINTMENT'); end if;
  if p_effective_from is null then perform api._fail('INVALID', 'effective_from'); end if;
  if p_effective_to is not null and p_effective_to <= p_effective_from then perform api._fail('INVALID', 'effective_to'); end if;
  v_range := tstzrange(p_effective_from, p_effective_to, '[)');
  if exists (select 1 from committee.membership m
             where m.committee_id = p_committee_id and m.user_id = p_user_id
               and tstzrange(m.effective_from, m.effective_to, '[)') && v_range) then
    perform api._fail('CONFLICT', 'MEMBERSHIP_OVERLAP');
  end if;
  if p_seat in ('CHAIR', 'DEPUTY_CHAIR', 'SECRETARY', 'ALTERNATE_SECRETARY') and exists (
    select 1 from committee.membership m
    where m.committee_id = p_committee_id and m.seat = p_seat
      and tstzrange(m.effective_from, m.effective_to, '[)') && v_range
  ) then
    perform api._fail('CONFLICT', 'SEAT_OCCUPIED');
  end if;

  insert into committee.membership (committee_id, user_id, seat, effective_from, effective_to, appointment_reference, appointed_by)
  values (p_committee_id, p_user_id, p_seat, p_effective_from, p_effective_to,
          api._require_text(p_appointment_reference, 'appointment_reference', 3, 200), v_actor)
  returning id into v_id;
  perform audit.record_event('COMMITTEE_MEMBER_APPOINTED', 'ADMIN', 'SUCCESS', null, 'committee_membership', v_id::text, null,
    jsonb_build_object('committee_id', p_committee_id, 'user_id', p_user_id, 'seat', p_seat,
                       'effective_from', p_effective_from, 'effective_to', p_effective_to));
  return v_id;
end;
$$;

create function api.end_committee_membership(p_membership_id uuid, p_effective_to timestamptz, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.membership;
  v_reason text;
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

  update committee.membership
     set effective_to = p_effective_to, ended_by = v_actor, ended_at = now(), end_reason = v_reason
   where id = v_m.id;
  perform audit.record_event('COMMITTEE_MEMBERSHIP_ENDED', 'ADMIN', 'SUCCESS', null, 'committee_membership', v_m.id::text, v_reason,
    jsonb_build_object('committee_id', v_m.committee_id, 'user_id', v_m.user_id, 'seat', v_m.seat,
                       'effective_to', p_effective_to));
end;
$$;

-- A new rule set takes effect now or later and closes the open-ended one. Past periods are never changed (Q53).
create function api.set_committee_rule_set(
  p_committee_id uuid, p_effective_from timestamptz, p_quorum_type text, p_quorum_value numeric,
  p_casting_vote_enabled boolean, p_minutes_review_business_days int, p_deemed_approval_enabled boolean,
  p_grievance_window_days int, p_admissibility_decider text, p_source_status text, p_reason text
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
    if p_admissibility_decider is null or p_admissibility_decider not in ('SECRETARY', 'CHAIR', 'COMMITTEE') then
      perform api._fail('INVALID', 'admissibility_decider');
    end if;
  elsif p_grievance_window_days is not null or p_admissibility_decider is not null then
    perform api._fail('INVALID', 'grievance_rules');
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
                                  admissibility_decider, source_status, reason, created_by)
  values (p_committee_id, p_effective_from, p_quorum_type, p_quorum_value, p_casting_vote_enabled,
          p_minutes_review_business_days, p_deemed_approval_enabled, p_grievance_window_days,
          p_admissibility_decider, p_source_status, v_reason, v_actor)
  returning id into v_id;
  perform audit.record_event('COMMITTEE_RULE_SET_CHANGED', 'ADMIN', 'SUCCESS', null, 'committee_rule_set', v_id::text, v_reason,
    jsonb_build_object('committee_id', p_committee_id, 'previous_rule_set_id', v_current.id, 'effective_from', p_effective_from,
                       'quorum_type', p_quorum_type, 'quorum_value', p_quorum_value, 'source_status', p_source_status));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Referral to a committee (case team). Opens the proceeding and snapshots the committee.
-- -----------------------------------------------------------------------------
create function api.refer_case_to_committee(p_case_id uuid, p_committee_id uuid, p_parent_proceeding_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_c committee.committee;
  v_rule committee.rule_set;
  v_type text;
  v_p case_mgmt.proceeding;
  v_cp uuid;
  v_reason text;
  v_voting int;
  v_restricted int;
begin
  perform case_mgmt.lock_editable_case(p_case_id);
  select * into v_c from committee.committee c where c.id = p_committee_id and c.is_active;
  if v_c.id is null then perform api._fail('INVALID', 'committee_id'); end if;
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

  -- Chair, deputy chair and members vote; secretaries and alternates do not. On a grievance, anyone who voted in an
  -- Investigation Committee proceeding of this case sits as non-voting (Q45–Q46).
  insert into committee.proceeding_member (committee_proceeding_id, user_id, membership_id, seat, is_voting, firewall_restricted)
  select v_cp, m.user_id, m.id, m.seat,
         m.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER')
           and not (v_c.kind = 'GRIEVANCE' and authz.participated_in_investigation_committee(m.user_id, p_case_id)),
         m.seat in ('CHAIR', 'DEPUTY_CHAIR', 'MEMBER')
           and v_c.kind = 'GRIEVANCE' and authz.participated_in_investigation_committee(m.user_id, p_case_id)
  from committee.membership m
  join iam.user_profile u on u.id = m.user_id and u.status = 'ACTIVE'
  where m.committee_id = v_c.id and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now());

  select count(*) filter (where pm.is_voting), count(*) filter (where pm.firewall_restricted)
    into v_voting, v_restricted
  from committee.proceeding_member pm where pm.committee_proceeding_id = v_cp;
  if v_voting = 0 then perform api._fail('CONFLICT', 'COMMITTEE_NOT_CONSTITUTED'); end if;

  perform audit.record_event('PROCEEDING_OPENED', 'BUSINESS', 'SUCCESS', p_case_id, 'proceeding', v_p.id::text, v_reason,
    jsonb_build_object('proceeding_type', v_type, 'sequence_no', v_p.sequence_no, 'parent_proceeding_id', p_parent_proceeding_id));
  perform audit.record_event('COMMITTEE_PROCEEDING_OPENED', 'BUSINESS', 'SUCCESS', p_case_id, 'committee_proceeding', v_cp::text, null,
    jsonb_build_object('committee_id', v_c.id, 'committee_kind', v_c.kind, 'rule_set_id', v_rule.id,
                       'voting_members', v_voting, 'firewall_restricted_members', v_restricted));
  return v_cp;
end;
$$;

grant execute on function
  api.open_proceeding(uuid, text, uuid, text),
  api.update_proceeding_state(uuid, text, text, text, text),
  api.close_proceeding(uuid, text, text, text),
  api.add_case_subject(uuid, text, text, uuid),
  api.add_allegation(uuid, text, text, uuid, text, text),
  api.link_allegation_subject(uuid, uuid, text, text),
  api.record_finding(uuid, uuid, uuid, text, text),
  api.link_supporting_material(uuid, uuid, uuid),
  api.appoint_committee_member(uuid, uuid, text, timestamptz, timestamptz, text),
  api.end_committee_membership(uuid, timestamptz, text),
  api.set_committee_rule_set(uuid, timestamptz, text, numeric, boolean, int, boolean, int, text, text, text),
  api.refer_case_to_committee(uuid, uuid, uuid, text)
to authenticated;
