-- =============================================================================
-- 1900 Recommendation packages, legal review packets and competent-authority decisions (Business Architecture
-- Rebase phase 6; CDF-191, CDF-192, CDF-201)
-- Requirements: §19–§22, §29, §40, §87; owner Q&A Q58, Q64–Q90; ADR-021, ADR-022, ADR-023, ADR-031;
-- AUTHORIZATION_IMPACT.md N14, N15, N19
--
-- Additive only. Schema `decision`:
--   sanction_catalogue        governed sanction codes (Q86); seeded synthetic, legal basis SOURCE_REQUIRED.
--   authority_type            CEO, BOARD, DELEGATED_EXECUTIVE, OTHER (Q84).
--   action_authority_rule     recommendation item type → authority type, effective-dated (Q78, Q85). Only
--                             DISCIPLINARY_SANCTION → CEO is seeded (OWNER_DEFAULT); nothing hard-codes CEO.
--   recommendation_package    what the Investigation Committee recommends in a proceeding (Q71: it recommends, it does
--                             not impose). DRAFT → VOTING → ADOPTED → (IN_LEGAL_REVIEW → ADOPTED | RETURNED_BY_LEGAL)
--                             → AWAITING_AUTHORITY → DECIDED | RETURNED_BY_AUTHORITY. Returned packages are revised and
--                             voted again (a new round).
--   recommendation_item       FINDING, DISCIPLINARY_SANCTION, CORRECTIVE_ACTION, GOVERNANCE_REMEDIATION,
--                             EXTERNAL_REFERRAL, NO_VIOLATION, CLOSE_WITHOUT_SANCTION, LEGAL_ACTION, OTHER; scoped to
--   recommendation_item_subject / _allegation   subjects, allegations or the whole case (Q88–Q90). A free-text
--                             sanction is PROPOSED_UNVERIFIED and never becomes a catalogue code (Q87).
--   legal_review_request      the secretary's request to one legal reviewer, with the opinion (Q73–Q77).
--   packet, packet_item       immutable purpose-bound snapshots (ADR-031): LEGAL_REVIEW for the assigned reviewer
--                             only (N14), AUTHORITY_DECISION for the record. Never evidence (until UX S2 merges),
--                             never protected identity (N19).
--   authority_decision        recorded by the committee secretary from an external decision (Q80–Q83); needs a source
--   authority_item_decision   document reference (N15); per-item outcomes for partial approval or modification.
--
-- Committee votes on packages and items bind to these rows (committee.vote_item gains package and item columns);
-- api.open_vote_item now opens FINDING and OTHER items only.
-- Every command writes its audit event in the same transaction. Audit metadata carries ids, codes and counts.
-- =============================================================================

create schema if not exists decision;
revoke all on schema decision from public;
alter default privileges in schema decision revoke all on tables from public, anon, authenticated;
alter default privileges in schema decision revoke all on sequences from public, anon, authenticated;
alter default privileges in schema decision revoke execute on functions from public, anon, authenticated;
grant usage on schema decision to authenticated;

insert into iam.permission (code, description) values
  ('LEGAL_OPINION_GIVE', 'Give a formal legal opinion on a legal review packet assigned to the user');
insert into iam.role_permission (role_code, permission_code) values
  ('LEGAL_REVIEWER', 'LEGAL_OPINION_GIVE');

-- -----------------------------------------------------------------------------
-- Reference data
-- -----------------------------------------------------------------------------
create table decision.sanction_catalogue (
  code          text primary key check (code ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  legal_basis   text check (length(legal_basis) between 3 and 500),
  source_status text not null check (source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  is_active     boolean not null default true
);
comment on table decision.sanction_catalogue is
  'Governed sanction codes (Q86). Synthetic seed; legal basis SOURCE_REQUIRED. Labels live in packages/i18n.';
insert into decision.sanction_catalogue (code, source_status) values
  ('WARNING', 'SOURCE_REQUIRED'), ('SALARY_DEDUCTION', 'SOURCE_REQUIRED'), ('SUSPENSION', 'SOURCE_REQUIRED'),
  ('DEMOTION', 'SOURCE_REQUIRED'), ('TERMINATION', 'SOURCE_REQUIRED');

create table decision.authority_type (
  code      text primary key check (code ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  is_active boolean not null default true
);
insert into decision.authority_type (code) values ('CEO'), ('BOARD'), ('DELEGATED_EXECUTIVE'), ('OTHER');

create table decision.action_authority_rule (
  id             uuid primary key default gen_random_uuid(),
  item_type      text not null check (item_type in (
                   'FINDING', 'DISCIPLINARY_SANCTION', 'CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION', 'EXTERNAL_REFERRAL',
                   'NO_VIOLATION', 'CLOSE_WITHOUT_SANCTION', 'LEGAL_ACTION', 'OTHER')),
  authority_type text not null references decision.authority_type (code),
  effective_from timestamptz not null,
  effective_to   timestamptz,
  source_status  text not null check (source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  reason         text check (length(reason) between 5 and 2000),
  created_by     uuid references iam.user_profile (id),
  created_at     timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  check (created_by is not null or source_status = 'OWNER_DEFAULT')
);
create index action_authority_rule_type on decision.action_authority_rule (item_type, effective_from);
create index action_authority_rule_authority on decision.action_authority_rule (authority_type);
create index action_authority_rule_created_by on decision.action_authority_rule (created_by);
comment on table decision.action_authority_rule is 'Which authority decides which recommendation type (Q78, Q84–Q85). Effective-dated.';
insert into decision.action_authority_rule (item_type, authority_type, effective_from, source_status)
values ('DISCIPLINARY_SANCTION', 'CEO', timestamptz '2026-01-01 00:00:00+00', 'OWNER_DEFAULT');

-- -----------------------------------------------------------------------------
-- Packages and items
-- -----------------------------------------------------------------------------
create table decision.recommendation_package (
  id                      uuid primary key default gen_random_uuid(),
  committee_proceeding_id uuid not null references committee.committee_proceeding (id),
  case_id                 uuid not null references case_mgmt.case_record (id),
  sequence_no             int not null check (sequence_no >= 1),
  vote_granularity        text not null check (vote_granularity in ('PACKAGE', 'ITEM')),
  status                  text not null default 'DRAFT' check (status in (
                            'DRAFT', 'VOTING', 'ADOPTED', 'IN_LEGAL_REVIEW', 'RETURNED_BY_LEGAL', 'AWAITING_AUTHORITY',
                            'RETURNED_BY_AUTHORITY', 'DECIDED')),
  round_no                int not null default 1 check (round_no >= 1),
  created_by              uuid not null references iam.user_profile (id),
  created_at              timestamptz not null default now(),
  adopted_at              timestamptz,
  decided_at              timestamptz,
  updated_at              timestamptz not null default now(),
  row_version             int not null default 1,
  unique (committee_proceeding_id, sequence_no),
  check ((status = 'DECIDED') = (decided_at is not null))
);
create index recommendation_package_case on decision.recommendation_package (case_id);
create index recommendation_package_created_by on decision.recommendation_package (created_by);
comment on table decision.recommendation_package is
  'A committee''s recommendations in a proceeding (ADR-021, Q58, Q64–Q72). The committee recommends; the authority decides.';

create table decision.recommendation_item (
  id                     uuid primary key default gen_random_uuid(),
  package_id             uuid not null references decision.recommendation_package (id),
  case_id                uuid not null references case_mgmt.case_record (id),
  item_type              text not null check (item_type in (
                           'FINDING', 'DISCIPLINARY_SANCTION', 'CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION',
                           'EXTERNAL_REFERRAL', 'NO_VIOLATION', 'CLOSE_WITHOUT_SANCTION', 'LEGAL_ACTION', 'OTHER')),
  sanction_code          text references decision.sanction_catalogue (code),
  proposed_sanction_text text check (length(proposed_sanction_text) between 3 and 500),
  verification_status    text not null check (verification_status in ('CATALOGUE', 'PROPOSED_UNVERIFIED', 'NOT_APPLICABLE')),
  description            text not null check (length(description) between 10 and 4000),
  case_wide              boolean not null,
  status                 text not null default 'ACTIVE' check (status in ('ACTIVE', 'WITHDRAWN')),
  committee_result       text check (committee_result in ('APPROVED', 'REJECTED')),
  added_by               uuid not null references iam.user_profile (id),
  added_at               timestamptz not null default clock_timestamp(), -- orders items added in one transaction
  withdrawn_by           uuid references iam.user_profile (id),
  withdrawn_at           timestamptz,
  -- Q86–Q87: a sanction is either a catalogue code or a flagged proposal, never both; other types carry neither.
  check (case item_type
           when 'DISCIPLINARY_SANCTION' then (sanction_code is null) <> (proposed_sanction_text is null)
                and verification_status = case when sanction_code is not null then 'CATALOGUE' else 'PROPOSED_UNVERIFIED' end
           else sanction_code is null and proposed_sanction_text is null and verification_status = 'NOT_APPLICABLE' end),
  check (not (item_type = 'DISCIPLINARY_SANCTION' and case_wide)),
  check ((status = 'WITHDRAWN') = (withdrawn_at is not null)),
  check ((withdrawn_at is null) = (withdrawn_by is null))
);
create index recommendation_item_package on decision.recommendation_item (package_id);
create index recommendation_item_case on decision.recommendation_item (case_id);
create index recommendation_item_sanction on decision.recommendation_item (sanction_code);
create index recommendation_item_added_by on decision.recommendation_item (added_by);
create index recommendation_item_withdrawn_by on decision.recommendation_item (withdrawn_by);
comment on table decision.recommendation_item is
  'One recommendation (ADR-021). PROPOSED_UNVERIFIED sanctions are flagged in every view and export (Q87).';

create table decision.recommendation_item_subject (
  item_id    uuid not null references decision.recommendation_item (id),
  subject_id uuid not null references case_mgmt.case_subject (id),
  primary key (item_id, subject_id)
);
create index recommendation_item_subject_subject on decision.recommendation_item_subject (subject_id);

create table decision.recommendation_item_allegation (
  item_id       uuid not null references decision.recommendation_item (id),
  allegation_id uuid not null references case_mgmt.allegation (id),
  primary key (item_id, allegation_id)
);
create index recommendation_item_allegation_allegation on decision.recommendation_item_allegation (allegation_id);

-- Committee votes bind to packages and items (ADR-020 targets PACKAGE / RECOMMENDATION_ITEM / SANCTION /
-- CORRECTIVE_ACTION). FINDING and OTHER items carry no package.
alter table committee.vote_item
  add column package_id             uuid references decision.recommendation_package (id),
  add column recommendation_item_id uuid references decision.recommendation_item (id),
  add column package_round          int check (package_round >= 1),
  add constraint vote_item_package_round check ((package_id is null) = (package_round is null)),
  add constraint vote_item_package_target check (
    case
      when target_type in ('PACKAGE', 'FINAL_PACKAGE') then package_id is not null and recommendation_item_id is null
      when target_type in ('RECOMMENDATION_ITEM', 'SANCTION', 'CORRECTIVE_ACTION') then package_id is not null and recommendation_item_id is not null
      else package_id is null and recommendation_item_id is null
    end);
create index vote_item_package on committee.vote_item (package_id, package_round);
create index vote_item_recommendation_item on committee.vote_item (recommendation_item_id);

-- -----------------------------------------------------------------------------
-- Legal review and packets
-- -----------------------------------------------------------------------------
create table decision.legal_review_request (
  id               uuid primary key default gen_random_uuid(),
  package_id       uuid not null references decision.recommendation_package (id),
  case_id          uuid not null references case_mgmt.case_record (id),
  package_round    int not null check (package_round >= 1),
  basis            text not null check (basis in ('RULE', 'SECRETARY_ELECTED')),
  assigned_to      uuid not null references iam.user_profile (id),
  status           text not null default 'ASSIGNED' check (status in ('ASSIGNED', 'OPINION_GIVEN')),
  reason           text not null check (length(reason) between 5 and 2000),
  requested_by     uuid not null references iam.user_profile (id),
  requested_at     timestamptz not null default now(),
  opinion          text check (opinion in ('CONCURS', 'CONCURS_WITH_COMMENTS', 'CONFLICTS')),
  opinion_text     text check (length(opinion_text) between 10 and 8000),
  opinion_at       timestamptz,
  check ((status = 'OPINION_GIVEN') = (opinion is not null and opinion_at is not null)),
  check (opinion is null or opinion = 'CONCURS' or opinion_text is not null)
);
create index legal_review_request_package on decision.legal_review_request (package_id);
create index legal_review_request_case on decision.legal_review_request (case_id);
create index legal_review_request_assigned on decision.legal_review_request (assigned_to, status);
create index legal_review_request_requested_by on decision.legal_review_request (requested_by);
comment on table decision.legal_review_request is 'A legal review chosen by the secretary or required by rule (ADR-022, Q73–Q77).';

create table decision.packet (
  id                      uuid primary key default gen_random_uuid(),
  case_id                 uuid not null references case_mgmt.case_record (id),
  committee_proceeding_id uuid not null references committee.committee_proceeding (id),
  package_id              uuid not null references decision.recommendation_package (id),
  purpose                 text not null check (purpose in ('LEGAL_REVIEW', 'AUTHORITY_DECISION')),
  legal_review_request_id uuid unique references decision.legal_review_request (id),
  classification          core.classification_level not null,
  created_by              uuid not null references iam.user_profile (id),
  created_at              timestamptz not null default now(),
  check ((purpose = 'LEGAL_REVIEW') = (legal_review_request_id is not null))
);
create index packet_case on decision.packet (case_id);
create index packet_proceeding on decision.packet (committee_proceeding_id);
create index packet_package on decision.packet (package_id);
create index packet_created_by on decision.packet (created_by);
comment on table decision.packet is 'Immutable purpose-bound snapshot for one audience (ADR-031). Never evidence, never protected identity.';

create table decision.packet_item (
  id         uuid primary key default gen_random_uuid(),
  packet_id  uuid not null references decision.packet (id),
  position   int not null check (position >= 1),
  item_kind  text not null check (item_kind in ('RECOMMENDATION_ITEM', 'FINDING', 'MINUTES', 'LEGAL_OPINION')),
  source_id  uuid not null,
  snapshot   jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  unique (packet_id, position),
  unique (packet_id, item_kind, source_id)
);
comment on table decision.packet_item is 'One snapshotted item of a packet (ADR-031). Readers reach only these rows.';

-- DEC-01 / DEC-61 pattern (AGENT-09 W2): on a restricted case, a legal review gives a new person packet access, so the
-- case's Restricted Case Authority approves each request and names the reviewer. Single use.
create table decision.restricted_legal_review_approval (
  id                      uuid primary key default gen_random_uuid(),
  case_id                 uuid not null references case_mgmt.case_record (id),
  package_id              uuid not null references decision.recommendation_package (id),
  reviewer_id             uuid not null references iam.user_profile (id),
  approved_by             uuid not null references iam.user_profile (id),
  reason                  text not null check (length(reason) between 5 and 2000),
  approved_at             timestamptz not null default now(),
  legal_review_request_id uuid unique references decision.legal_review_request (id),
  used_at                 timestamptz,
  check ((legal_review_request_id is null) = (used_at is null))
);
create unique index restricted_legal_review_approval_open on decision.restricted_legal_review_approval (package_id)
  where legal_review_request_id is null;
create index restricted_legal_review_approval_case on decision.restricted_legal_review_approval (case_id);
create index restricted_legal_review_approval_reviewer on decision.restricted_legal_review_approval (reviewer_id);
create index restricted_legal_review_approval_approved_by on decision.restricted_legal_review_approval (approved_by);
comment on table decision.restricted_legal_review_approval is
  'The Restricted Case Authority''s approval of one legal review on a restricted case, naming the reviewer (AGENT-09 W2).';

-- -----------------------------------------------------------------------------
-- Authority decisions
-- -----------------------------------------------------------------------------
create table decision.authority_decision (
  id                        uuid primary key default gen_random_uuid(),
  package_id                uuid not null references decision.recommendation_package (id),
  case_id                   uuid not null references case_mgmt.case_record (id),
  package_round             int not null check (package_round >= 1),
  authority_type            text not null references decision.authority_type (code),
  outcome                   text not null check (outcome in (
                              'APPROVE_AS_RECOMMENDED', 'MODIFY', 'REJECT', 'RETURN_TO_COMMITTEE', 'APPROVE_PARTIALLY', 'OTHER')),
  decided_at                timestamptz not null,
  decided_by_label          text not null check (length(decided_by_label) between 3 and 200),
  -- N15 (Q83): the decision is effective only with its source document (memo, letter, email or system reference).
  source_document_reference text not null check (length(source_document_reference) between 3 and 300),
  status                    text not null default 'EFFECTIVE' check (status in ('EFFECTIVE')),
  reason                    text check (length(reason) between 5 and 4000),
  recorded_by               uuid not null references iam.user_profile (id),
  recorded_at               timestamptz not null default now(),
  check (status <> 'EFFECTIVE' or source_document_reference is not null),
  check (decided_at <= recorded_at)
);
create index authority_decision_package on decision.authority_decision (package_id);
create index authority_decision_case on decision.authority_decision (case_id);
create index authority_decision_authority on decision.authority_decision (authority_type);
create index authority_decision_recorded_by on decision.authority_decision (recorded_by);
comment on table decision.authority_decision is
  'An authority decision recorded by the committee secretary (ADR-023, Q78–Q85). No maker-checker (Q82).';

create table decision.authority_item_decision (
  decision_id  uuid not null references decision.authority_decision (id),
  item_id      uuid not null references decision.recommendation_item (id),
  outcome      text not null check (outcome in ('APPROVED', 'REJECTED', 'MODIFIED')),
  modification text check (length(modification) between 5 and 4000),
  primary key (decision_id, item_id),
  check ((outcome = 'MODIFIED') = (modification is not null))
);
create index authority_item_decision_item on decision.authority_item_decision (item_id);

-- -----------------------------------------------------------------------------
-- Integrity
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['decision.recommendation_item_subject', 'decision.recommendation_item_allegation',
                           'decision.packet', 'decision.packet_item', 'decision.authority_decision',
                           'decision.authority_item_decision'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
  foreach t in array array['decision.sanction_catalogue', 'decision.authority_type', 'decision.action_authority_rule',
                           'decision.recommendation_package', 'decision.recommendation_item',
                           'decision.legal_review_request', 'decision.restricted_legal_review_approval'] loop
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;

create function decision.protect_records()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'recommendation_package' then
    if old.status = 'DECIDED'
       or (to_jsonb(new) - array['status', 'round_no', 'adopted_at', 'decided_at', 'updated_at', 'row_version'])
          <> (to_jsonb(old) - array['status', 'round_no', 'adopted_at', 'decided_at', 'updated_at', 'row_version'])
       or new.round_no < old.round_no then
      raise exception 'recommendation package % is decided or its identity is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'recommendation_item' then
    if old.status = 'WITHDRAWN'
       or (to_jsonb(new) - array['status', 'committee_result', 'withdrawn_by', 'withdrawn_at'])
          <> (to_jsonb(old) - array['status', 'committee_result', 'withdrawn_by', 'withdrawn_at']) then
      raise exception 'recommendation item % content is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'legal_review_request' then
    if old.status <> 'ASSIGNED'
       or (to_jsonb(new) - array['status', 'opinion', 'opinion_text', 'opinion_at'])
          <> (to_jsonb(old) - array['status', 'opinion', 'opinion_text', 'opinion_at']) then
      raise exception 'legal review request % is answered or its identity is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'restricted_legal_review_approval' then
    if old.legal_review_request_id is not null
       or (to_jsonb(new) - array['legal_review_request_id', 'used_at'])
          <> (to_jsonb(old) - array['legal_review_request_id', 'used_at']) then
      raise exception 'approval % is used or immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'action_authority_rule' then
    if (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') or old.effective_to is not null then
      raise exception 'authority rule % can only be given an end, once', old.id using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;
create trigger recommendation_package_protect before update on decision.recommendation_package
  for each row execute function decision.protect_records();
create trigger recommendation_item_protect before update on decision.recommendation_item
  for each row execute function decision.protect_records();
create trigger legal_review_request_protect before update on decision.legal_review_request
  for each row execute function decision.protect_records();
create trigger action_authority_rule_protect before update on decision.action_authority_rule
  for each row execute function decision.protect_records();
create trigger restricted_legal_review_approval_protect before update on decision.restricted_legal_review_approval
  for each row execute function decision.protect_records();

-- -----------------------------------------------------------------------------
-- Authorization predicates
-- -----------------------------------------------------------------------------
-- A proceeding participant who declared a conflict in any meeting of the proceeding (ADR-020, Q42/Q44; consistent with
-- PRIOR_CONFLICT_DECLARED). Internal: answers about any user, so it is not granted.
create function authz.has_meeting_conflict(p_user_id uuid, p_committee_proceeding_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from committee.meeting_participant mp
    join committee.meeting m on m.id = mp.meeting_id
    where m.committee_proceeding_id = p_committee_proceeding_id and mp.user_id = p_user_id
      and mp.coi_status = 'CONFLICT_DECLARED'
  );
$$;

-- The committee side of the recommendation work: proceeding viewers who have not declared a meeting conflict in it
-- (AGENT-09 W1), or the case team. Internal.
create function authz.sees_proceeding_deliberation(p_committee_proceeding_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (authz.can_view_committee_proceeding(p_committee_proceeding_id)
          and not authz.has_meeting_conflict(authz.current_user_id(), p_committee_proceeding_id))
      or authz.can_view_case(p_case_id);
$$;

-- Packages, items and decisions: proceeding viewers without a meeting conflict, and the case team. Legal reviewers are
-- not in this set unless they also sit on the proceeding.
create function authz.can_view_recommendation_package(p_package_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from decision.recommendation_package p
    where p.id = p_package_id and authz.sees_proceeding_deliberation(p.committee_proceeding_id, p.case_id)
  );
$$;

-- The committee's current secretary, cleared for the case: prepares packages, routes them and records decisions.
create function authz.can_manage_recommendation_package(p_package_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from decision.recommendation_package p
    join committee.committee_proceeding cp on cp.id = p.committee_proceeding_id
    where p.id = p_package_id and authz.is_committee_secretary(cp.committee_id)
      and authz.user_case_gate(authz.current_user_id(), p.case_id)
      and not authz.has_meeting_conflict(authz.current_user_id(), cp.id)
  );
$$;

-- N14 (ADR-031): a packet is read by the proceeding's viewers without a meeting conflict and the case team, and a
-- legal-review packet also by its assigned
-- reviewer, who holds LEGAL_OPINION_GIVE and is cleared for the case. The reviewer reaches nothing else.
create function authz.can_view_packet(p_packet_id uuid)
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
                           where r.id = k.legal_review_request_id and r.assigned_to = authz.current_user_id())))
  );
$$;

revoke all on function authz.has_meeting_conflict(uuid, uuid), authz.sees_proceeding_deliberation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function
  authz.can_view_recommendation_package(uuid), authz.can_manage_recommendation_package(uuid), authz.can_view_packet(uuid)
to authenticated;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table decision.sanction_catalogue enable row level security;
alter table decision.authority_type enable row level security;
alter table decision.action_authority_rule enable row level security;
alter table decision.recommendation_package enable row level security;
alter table decision.recommendation_item enable row level security;
alter table decision.recommendation_item_subject enable row level security;
alter table decision.recommendation_item_allegation enable row level security;
alter table decision.legal_review_request enable row level security;
alter table decision.packet enable row level security;
alter table decision.packet_item enable row level security;
alter table decision.authority_decision enable row level security;
alter table decision.authority_item_decision enable row level security;
alter table decision.restricted_legal_review_approval enable row level security;

create policy sanction_catalogue_read on decision.sanction_catalogue for select to authenticated
  using (authz.current_user_id() is not null);
grant select on decision.sanction_catalogue to authenticated;
create policy authority_type_read on decision.authority_type for select to authenticated
  using (authz.current_user_id() is not null);
grant select on decision.authority_type to authenticated;
create policy action_authority_rule_read on decision.action_authority_rule for select to authenticated
  using (authz.current_user_id() is not null);
grant select on decision.action_authority_rule to authenticated;

create policy recommendation_package_read on decision.recommendation_package for select to authenticated
  using (authz.can_view_recommendation_package(id));
grant select on decision.recommendation_package to authenticated;
create policy recommendation_item_read on decision.recommendation_item for select to authenticated
  using (authz.can_view_recommendation_package(package_id));
grant select on decision.recommendation_item to authenticated;
create policy recommendation_item_subject_read on decision.recommendation_item_subject for select to authenticated
  using (exists (select 1 from decision.recommendation_item i
                 where i.id = item_id and authz.can_view_recommendation_package(i.package_id)));
grant select on decision.recommendation_item_subject to authenticated;
create policy recommendation_item_allegation_read on decision.recommendation_item_allegation for select to authenticated
  using (exists (select 1 from decision.recommendation_item i
                 where i.id = item_id and authz.can_view_recommendation_package(i.package_id)));
grant select on decision.recommendation_item_allegation to authenticated;

-- The assigned reviewer sees their own request (ids and the opinion) while they can read its packet.
create policy legal_review_request_read on decision.legal_review_request for select to authenticated
  using (authz.can_view_recommendation_package(package_id)
         or (assigned_to = authz.current_user_id()
             and exists (select 1 from decision.packet k
                         where k.legal_review_request_id = legal_review_request.id and authz.can_view_packet(k.id))));
grant select on decision.legal_review_request to authenticated;

create policy packet_read on decision.packet for select to authenticated using (authz.can_view_packet(id));
grant select on decision.packet to authenticated;
create policy packet_item_read on decision.packet_item for select to authenticated using (authz.can_view_packet(packet_id));
grant select on decision.packet_item to authenticated;

create policy authority_decision_read on decision.authority_decision for select to authenticated
  using (authz.can_view_recommendation_package(package_id));
grant select on decision.authority_decision to authenticated;
create policy authority_item_decision_read on decision.authority_item_decision for select to authenticated
  using (exists (select 1 from decision.authority_decision d
                 where d.id = decision_id and authz.can_view_recommendation_package(d.package_id)));
grant select on decision.authority_item_decision to authenticated;
create policy restricted_legal_review_approval_read on decision.restricted_legal_review_approval for select to authenticated
  using (authz.can_view_case(case_id));
grant select on decision.restricted_legal_review_approval to authenticated;

-- -----------------------------------------------------------------------------
-- Internal helpers
-- -----------------------------------------------------------------------------
-- Locks and returns a package the caller can see and manage, on an active case. NOT_FOUND / FORBIDDEN as usual.
create function decision.lock_managed_package(p_package_id uuid)
returns decision.recommendation_package
language plpgsql
set search_path = ''
as $$
declare v decision.recommendation_package;
begin
  if p_package_id is null or not authz.can_view_recommendation_package(p_package_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_manage_recommendation_package(p_package_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v from decision.recommendation_package p where p.id = p_package_id for update;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  return v;
end;
$$;

-- The authority type a rule assigns to an item type now, or null when no rule exists.
create function decision.required_authority(p_item_type text)
returns text
language sql stable
set search_path = ''
as $$
  select r.authority_type from decision.action_authority_rule r
  where r.item_type = p_item_type and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())
  order by r.effective_from desc limit 1;
$$;

-- Q74: legal review is required for sanctions, legal action and external referral (SOURCE_REQUIRED: the full rule).
create function decision.legal_review_required(p_package_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from decision.recommendation_item i
                 where i.package_id = p_package_id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
                   and i.item_type in ('DISCIPLINARY_SANCTION', 'LEGAL_ACTION', 'EXTERNAL_REFERRAL'));
$$;

-- Snapshot of an item: type, sanction (flagged when unverified), description, scope by subject label and allegation
-- category. No reporter data exists in any of these sources (N19).
create function decision.item_snapshot(p_item_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'item_type', i.item_type, 'sanction_code', i.sanction_code, 'proposed_sanction_text', i.proposed_sanction_text,
    'verification_status', i.verification_status, 'description', i.description, 'case_wide', i.case_wide,
    'committee_result', i.committee_result,
    'subjects', coalesce((select jsonb_agg(jsonb_build_object('subject_id', s.id, 'label', p.display_name,
                                                              'category', s.subject_category) order by s.added_at)
                          from decision.recommendation_item_subject rs
                          join case_mgmt.case_subject s on s.id = rs.subject_id
                          join case_mgmt.person p on p.id = s.person_id
                          where rs.item_id = i.id), '[]'::jsonb),
    'allegations', coalesce((select jsonb_agg(jsonb_build_object('allegation_id', a.id, 'category', a.category)
                                              order by a.created_at)
                             from decision.recommendation_item_allegation ra
                             join case_mgmt.allegation a on a.id = ra.allegation_id
                             where ra.item_id = i.id), '[]'::jsonb))
  from decision.recommendation_item i where i.id = p_item_id;
$$;

-- -----------------------------------------------------------------------------
-- Rule administration
-- -----------------------------------------------------------------------------
create function api.set_action_authority_rule(
  p_item_type text, p_authority_type text, p_effective_from timestamptz, p_source_status text, p_reason text
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
  if not exists (select 1 from decision.authority_type a where a.code = p_authority_type and a.is_active) then
    perform api._fail('INVALID', 'authority_type');
  end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  -- One rule per type at a time: the rule in force (or a later one) ends where the new one starts.
  perform 1 from decision.authority_type a where a.code = p_authority_type for update;
  if exists (select 1 from decision.action_authority_rule r
             where r.item_type = p_item_type and r.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'LATER_RULE_EXISTS');
  end if;
  update decision.action_authority_rule set effective_to = p_effective_from
   where item_type = p_item_type and effective_to is null;
  insert into decision.action_authority_rule (item_type, authority_type, effective_from, source_status, reason, created_by)
  values (p_item_type, p_authority_type, p_effective_from, p_source_status, v_reason, v_actor)
  returning id into v_id;
  perform audit.record_event('AUTHORITY_RULE_SET', 'ADMIN', 'SUCCESS', null, 'action_authority_rule', v_id::text, v_reason,
    jsonb_build_object('item_type', p_item_type, 'authority_type', p_authority_type, 'effective_from', p_effective_from,
                       'source_status', p_source_status));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Package commands
-- -----------------------------------------------------------------------------
create function api.create_recommendation_package(p_committee_proceeding_id uuid, p_vote_granularity text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_cp committee.committee_proceeding;
  v_kind text;
  v_id uuid;
  v_seq int;
begin
  if p_committee_proceeding_id is null or not authz.can_view_committee_proceeding(p_committee_proceeding_id) then
    perform api._fail('NOT_FOUND');
  end if;
  select * into v_cp from committee.committee_proceeding cp where cp.id = p_committee_proceeding_id for update;
  if not authz.is_committee_secretary(v_cp.committee_id) or not authz.user_case_gate(v_actor, v_cp.case_id)
     or authz.has_meeting_conflict(v_actor, v_cp.id) then
    perform api._fail('FORBIDDEN');
  end if;
  select c.kind into v_kind from committee.committee c where c.id = v_cp.committee_id;
  -- Grievance outcomes arrive with phase 7.
  if v_kind <> 'INVESTIGATION' then perform api._fail('CONFLICT', 'NOT_AN_INVESTIGATION_COMMITTEE'); end if;
  if v_cp.status <> 'OPEN' then perform api._fail('CONFLICT', 'PROCEEDING_CLOSED'); end if;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_cp.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if p_vote_granularity is null or p_vote_granularity not in ('PACKAGE', 'ITEM') then
    perform api._fail('INVALID', 'vote_granularity');
  end if;
  select coalesce(max(p.sequence_no), 0) + 1 into v_seq
  from decision.recommendation_package p where p.committee_proceeding_id = v_cp.id;
  insert into decision.recommendation_package (committee_proceeding_id, case_id, sequence_no, vote_granularity, created_by)
  values (v_cp.id, v_cp.case_id, v_seq, p_vote_granularity, v_actor)
  returning id into v_id;
  perform audit.record_event('RECOMMENDATION_PACKAGE_CREATED', 'BUSINESS', 'SUCCESS', v_cp.case_id, 'recommendation_package',
    v_id::text, null, jsonb_build_object('committee_proceeding_id', v_cp.id, 'sequence_no', v_seq,
                                         'vote_granularity', p_vote_granularity));
  return v_id;
end;
$$;

create function api.add_recommendation_item(
  p_package_id uuid, p_item_type text, p_sanction_code text, p_proposed_sanction_text text, p_description text,
  p_subject_ids uuid[], p_allegation_ids uuid[]
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
  -- Q89: no subject and no allegation means the whole case.
  v_case_wide := cardinality(v_subjects) = 0 and cardinality(v_allegations) = 0;

  insert into decision.recommendation_item (package_id, case_id, item_type, sanction_code, proposed_sanction_text,
                                            verification_status, description, case_wide, added_by)
  values (v_p.id, v_p.case_id, p_item_type, p_sanction_code,
          case when p_proposed_sanction_text is not null then api._require_text(p_proposed_sanction_text, 'proposed_sanction_text', 3, 500) end,
          case when p_item_type <> 'DISCIPLINARY_SANCTION' then 'NOT_APPLICABLE'
               when p_sanction_code is not null then 'CATALOGUE' else 'PROPOSED_UNVERIFIED' end,
          api._require_text(p_description, 'description', 10, 4000), v_case_wide, v_actor)
  returning id into v_id;
  insert into decision.recommendation_item_subject (item_id, subject_id) select v_id, x from unnest(v_subjects) x;
  insert into decision.recommendation_item_allegation (item_id, allegation_id) select v_id, x from unnest(v_allegations) x;
  update decision.recommendation_package set updated_at = now(), row_version = row_version + 1 where id = v_p.id;
  perform audit.record_event('RECOMMENDATION_ITEM_ADDED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'recommendation_item', v_id::text,
    null, jsonb_build_object('package_id', v_p.id, 'item_type', p_item_type, 'sanction_code', p_sanction_code,
                             'proposed_unverified', p_proposed_sanction_text is not null, 'case_wide', v_case_wide,
                             'subjects', cardinality(v_subjects), 'allegations', cardinality(v_allegations)));
  return v_id;
end;
$$;

create function api.withdraw_recommendation_item(p_item_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_i decision.recommendation_item;
  v_p decision.recommendation_package;
  v_reason text;
begin
  select * into v_i from decision.recommendation_item i where i.id = p_item_id;
  if v_i.id is null or not authz.can_view_recommendation_package(v_i.package_id) then perform api._fail('NOT_FOUND'); end if;
  v_p := decision.lock_managed_package(v_i.package_id);
  if v_p.status not in ('DRAFT', 'RETURNED_BY_LEGAL', 'RETURNED_BY_AUTHORITY') then
    perform api._fail('CONFLICT', 'PACKAGE_NOT_EDITABLE');
  end if;
  if v_i.status <> 'ACTIVE' then perform api._fail('CONFLICT', 'ITEM_WITHDRAWN'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update decision.recommendation_item set status = 'WITHDRAWN', withdrawn_by = v_actor, withdrawn_at = now() where id = v_i.id;
  update decision.recommendation_package set updated_at = now(), row_version = row_version + 1 where id = v_p.id;
  perform audit.record_event('RECOMMENDATION_ITEM_WITHDRAWN', 'BUSINESS', 'SUCCESS', v_p.case_id, 'recommendation_item',
    v_i.id::text, v_reason, jsonb_build_object('package_id', v_p.id));
end;
$$;

-- Puts the package to the committee. A package that was voted on before (not adopted, or returned) starts a new round.
create function api.submit_package_for_vote(p_package_id uuid)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_p decision.recommendation_package;
  v_round int;
begin
  perform api._actor();
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status not in ('DRAFT', 'RETURNED_BY_LEGAL', 'RETURNED_BY_AUTHORITY') then
    perform api._fail('CONFLICT', 'PACKAGE_NOT_EDITABLE');
  end if;
  if not exists (select 1 from decision.recommendation_item i where i.package_id = v_p.id and i.status = 'ACTIVE') then
    perform api._fail('CONFLICT', 'PACKAGE_EMPTY');
  end if;
  v_round := v_p.round_no + case when exists (select 1 from committee.vote_item vi
                                              where vi.package_id = v_p.id and vi.package_round = v_p.round_no)
                                 then 1 else 0 end;
  update decision.recommendation_package
     set status = 'VOTING', round_no = v_round, updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  update decision.recommendation_item set committee_result = null where package_id = v_p.id and status = 'ACTIVE';
  perform audit.record_event('RECOMMENDATION_PACKAGE_SUBMITTED_FOR_VOTE', 'BUSINESS', 'SUCCESS', v_p.case_id,
    'recommendation_package', v_p.id::text, null,
    jsonb_build_object('round_no', v_round, 'from_status', v_p.status, 'vote_granularity', v_p.vote_granularity));
  return v_round;
end;
$$;

-- Opens the package's vote items in a meeting of the same proceeding: one PACKAGE item, or one per active item.
create function api.open_package_vote(p_meeting_id uuid, p_package_id uuid)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.meeting;
  v_p decision.recommendation_package;
  v_seq int;
  v_count int;
begin
  v_m := committee.lock_managed_meeting(p_meeting_id);
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.committee_proceeding_id <> v_m.committee_proceeding_id then perform api._fail('INVALID', 'package_id'); end if;
  if v_m.status <> 'OPEN' then perform api._fail('CONFLICT', 'MEETING_NOT_OPEN'); end if;
  if v_p.status <> 'VOTING' then perform api._fail('CONFLICT', 'PACKAGE_NOT_VOTING'); end if;
  if exists (select 1 from committee.vote_item vi where vi.package_id = v_p.id and vi.package_round = v_p.round_no) then
    perform api._fail('CONFLICT', 'VOTE_ALREADY_OPENED');
  end if;
  select coalesce(max(vi.sequence_no), 0) into v_seq from committee.vote_item vi where vi.meeting_id = v_m.id;
  if v_p.vote_granularity = 'PACKAGE' then
    insert into committee.vote_item (meeting_id, case_id, sequence_no, target_type, title, opened_by, package_id, package_round)
    values (v_m.id, v_m.case_id, v_seq + 1, 'PACKAGE', 'PKG-' || lpad(v_p.sequence_no::text, 2, '0'), v_actor, v_p.id, v_p.round_no);
    v_count := 1;
  else
    insert into committee.vote_item (meeting_id, case_id, sequence_no, target_type, title, opened_by, package_id,
                                     recommendation_item_id, package_round)
    select v_m.id, v_m.case_id, v_seq + row_number() over (order by i.added_at, i.id),
           case i.item_type when 'DISCIPLINARY_SANCTION' then 'SANCTION' when 'CORRECTIVE_ACTION' then 'CORRECTIVE_ACTION'
                            else 'RECOMMENDATION_ITEM' end,
           left(i.item_type || ': ' || i.description, 300), v_actor, v_p.id, i.id, v_p.round_no
    from decision.recommendation_item i where i.package_id = v_p.id and i.status = 'ACTIVE';
    get diagnostics v_count = row_count;
  end if;
  perform audit.record_event('RECOMMENDATION_PACKAGE_VOTE_OPENED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'recommendation_package',
    v_p.id::text, null, jsonb_build_object('meeting_id', v_m.id, 'round_no', v_p.round_no, 'vote_items', v_count));
  return v_count;
end;
$$;

-- Reads the closed votes of the current round (Q58, Q70). Adopted when the package vote, or at least one item vote,
-- is APPROVED; otherwise the package goes back to DRAFT for revision.
create function api.record_package_adoption(p_package_id uuid)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_p decision.recommendation_package;
  v_status text;
  v_approved int;
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

-- -----------------------------------------------------------------------------
-- Legal review (ADR-022)
-- -----------------------------------------------------------------------------
-- Q75: the secretary chooses what Legal sees: the adopted items, plus findings and approved minutes of this case and
-- proceeding the secretary selects. The packet is a snapshot; the reviewer reaches nothing else.
create function api.request_legal_review(
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
  v_approval uuid;
begin
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status <> 'ADOPTED' then perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED'); end if;
  if exists (select 1 from decision.legal_review_request r
             where r.package_id = v_p.id and r.package_round = v_p.round_no and r.status = 'ASSIGNED') then
    perform api._fail('CONFLICT', 'LEGAL_REVIEW_OPEN');
  end if;
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
  -- AGENT-09 W2: a restricted case needs its authority's unused approval naming this reviewer.
  if exists (select 1 from case_mgmt.case_record c where c.id = v_p.case_id and c.is_restricted) then
    select a.id into v_approval from decision.restricted_legal_review_approval a
    where a.package_id = v_p.id and a.legal_review_request_id is null and a.reviewer_id = p_assigned_to
    for update;
    if v_approval is null then perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_REQUIRED'); end if;
  end if;

  insert into decision.legal_review_request (package_id, case_id, package_round, basis, assigned_to, reason, requested_by)
  values (v_p.id, v_p.case_id, v_p.round_no,
          case when decision.legal_review_required(v_p.id) then 'RULE' else 'SECRETARY_ELECTED' end,
          p_assigned_to, api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_req;
  if v_approval is not null then
    update decision.restricted_legal_review_approval set legal_review_request_id = v_req, used_at = now() where id = v_approval;
  end if;
  insert into decision.packet (case_id, committee_proceeding_id, package_id, purpose, legal_review_request_id,
                               classification, created_by)
  values (v_p.case_id, v_p.committee_proceeding_id, v_p.id, 'LEGAL_REVIEW', v_req, v_classification, v_actor)
  returning id into v_packet;
  insert into decision.packet_item (packet_id, position, item_kind, source_id, snapshot)
  select v_packet, row_number() over (order by k, at, id), kind, id, snap
  from (
    select 1 as k, i.added_at as at, i.id, 'RECOMMENDATION_ITEM' as kind, decision.item_snapshot(i.id) as snap
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
                             'packet_id', v_packet, 'restricted_approval_id', v_approval));
  perform audit.record_event('PACKET_CREATED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'packet', v_packet::text, null,
    jsonb_build_object('purpose', 'LEGAL_REVIEW', 'items', v_items, 'findings', cardinality(v_findings),
                       'minutes', cardinality(v_minutes)));
  return v_req;
end;
$$;

-- AGENT-09 W2 (DEC-01, DEC-61 pattern): the case owner, eligible as a Restricted Case Authority for the case
-- classification, approves one legal review of the adopted package by a named reviewer.
create function api.approve_restricted_legal_review(p_package_id uuid, p_reviewer_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_case case_mgmt.case_record;
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
  if exists (select 1 from decision.restricted_legal_review_approval a
             where a.package_id = v_p.id and a.legal_review_request_id is null) then
    perform api._fail('CONFLICT', 'APPROVAL_ALREADY_PENDING');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  insert into decision.restricted_legal_review_approval (case_id, package_id, reviewer_id, approved_by, reason)
  values (v_p.case_id, v_p.id, p_reviewer_id, v_actor, v_reason)
  returning id into v_id;
  perform audit.record_event('RESTRICTED_LEGAL_REVIEW_APPROVED', 'BUSINESS', 'SUCCESS', v_p.case_id,
    'restricted_legal_review_approval', v_id::text, v_reason,
    jsonb_build_object('package_id', v_p.id, 'reviewer_id', p_reviewer_id, 'classification', v_case.classification));
  return v_id;
end;
$$;

-- Reads a packet the caller may see and records the view (ADR-031: every packet read is audited).
create function api.open_packet(p_packet_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_k decision.packet;
begin
  perform api._actor();
  if p_packet_id is null or not authz.can_view_packet(p_packet_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_k from decision.packet k where k.id = p_packet_id;
  perform audit.record_event('PACKET_VIEWED', 'BUSINESS', 'SUCCESS', v_k.case_id, 'packet', v_k.id::text, null,
    jsonb_build_object('purpose', v_k.purpose));
  return jsonb_build_object('packet_id', v_k.id, 'purpose', v_k.purpose, 'classification', v_k.classification,
    'created_at', v_k.created_at,
    'items', coalesce((select jsonb_agg(jsonb_build_object('position', pi.position, 'kind', pi.item_kind,
                                                           'source_id', pi.source_id, 'snapshot', pi.snapshot)
                                        order by pi.position)
                       from decision.packet_item pi where pi.packet_id = v_k.id), '[]'::jsonb));
end;
$$;

-- Q77: CONFLICTS returns the package to the committee; the opinion is kept and travels to the authority.
create function api.give_legal_opinion(p_request_id uuid, p_opinion text, p_opinion_text text)
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
  if v_r.id is null or not (v_r.assigned_to = v_actor and authz.user_case_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_case_gate(v_actor, v_r.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  perform 1 from decision.recommendation_package p where p.id = v_r.package_id for update;
  select * into v_r from decision.legal_review_request r where r.id = p_request_id for update;
  if v_r.status <> 'ASSIGNED' then perform api._fail('CONFLICT', 'OPINION_ALREADY_GIVEN'); end if;
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

-- -----------------------------------------------------------------------------
-- Authority (ADR-023)
-- -----------------------------------------------------------------------------
-- Sends an adopted package to the competent authority with a snapshot of the adopted items and every legal opinion
-- given on it (Q77). Legal review must have happened when the rule requires it.
create function api.submit_to_authority(p_package_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_packet uuid;
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
  insert into decision.packet (case_id, committee_proceeding_id, package_id, purpose, classification, created_by)
  select v_p.case_id, v_p.committee_proceeding_id, v_p.id, 'AUTHORITY_DECISION', c.classification, v_actor
  from case_mgmt.case_record c where c.id = v_p.case_id
  returning id into v_packet;
  insert into decision.packet_item (packet_id, position, item_kind, source_id, snapshot)
  select v_packet, row_number() over (order by k, at, id), kind, id, snap
  from (
    select 1 as k, i.added_at as at, i.id, 'RECOMMENDATION_ITEM' as kind,
           decision.item_snapshot(i.id) || jsonb_build_object('required_authority', decision.required_authority(i.item_type)) as snap
    from decision.recommendation_item i
    where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
    union all
    select 2, r.opinion_at, r.id, 'LEGAL_OPINION',
           jsonb_build_object('opinion', r.opinion, 'opinion_text', r.opinion_text, 'package_round', r.package_round,
                              'basis', r.basis)
    from decision.legal_review_request r where r.package_id = v_p.id and r.status = 'OPINION_GIVEN'
  ) s;
  get diagnostics v_items = row_count;
  update decision.recommendation_package set status = 'AWAITING_AUTHORITY', updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event('RECOMMENDATION_PACKAGE_SUBMITTED_TO_AUTHORITY', 'BUSINESS', 'SUCCESS', v_p.case_id,
    'recommendation_package', v_p.id::text, null, jsonb_build_object('round_no', v_p.round_no, 'packet_id', v_packet));
  perform audit.record_event('PACKET_CREATED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'packet', v_packet::text, null,
    jsonb_build_object('purpose', 'AUTHORITY_DECISION', 'items', v_items));
  return v_packet;
end;
$$;

-- Q80–Q83: the secretary records a decision made outside the platform, with its source document. Partial approval
-- and modification name an outcome for every adopted item. RETURN_TO_COMMITTEE sends the package back for revision.
create function api.record_authority_decision(
  p_package_id uuid, p_authority_type text, p_outcome text, p_decided_at timestamptz, p_decided_by_label text,
  p_source_document_reference text, p_item_outcomes jsonb, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_id uuid;
  v_status text;
  v_items uuid[];
begin
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status <> 'AWAITING_AUTHORITY' then perform api._fail('CONFLICT', 'PACKAGE_NOT_AWAITING_AUTHORITY'); end if;
  if not exists (select 1 from decision.authority_type a where a.code = p_authority_type and a.is_active) then
    perform api._fail('INVALID', 'authority_type');
  end if;
  -- The authority must be the one the rules name for every adopted item type that has a rule.
  if exists (select 1 from decision.recommendation_item i
             where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
               and decision.required_authority(i.item_type) is not null
               and decision.required_authority(i.item_type) <> p_authority_type) then
    perform api._fail('CONFLICT', 'AUTHORITY_TYPE_MISMATCH');
  end if;
  if p_outcome is null or p_outcome not in (
       'APPROVE_AS_RECOMMENDED', 'MODIFY', 'REJECT', 'RETURN_TO_COMMITTEE', 'APPROVE_PARTIALLY', 'OTHER') then
    perform api._fail('INVALID', 'outcome');
  end if;
  if p_decided_at is null or p_decided_at > now() then perform api._fail('INVALID', 'decided_at'); end if;
  -- N15: no source document, no decision.
  if p_source_document_reference is null or length(trim(p_source_document_reference)) < 3 then
    perform api._fail('INVALID', 'source_document_reference');
  end if;
  select array_agg(i.id) into v_items from decision.recommendation_item i
  where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED';
  if p_outcome in ('APPROVE_PARTIALLY', 'MODIFY') then
    if p_item_outcomes is null or jsonb_typeof(p_item_outcomes) <> 'array'
       or jsonb_array_length(p_item_outcomes) <> cardinality(v_items)
       or exists (select 1 from jsonb_array_elements(p_item_outcomes) e
                  where (e ->> 'item_id') is null or not ((e ->> 'item_id')::uuid = any (v_items))
                     or coalesce(e ->> 'outcome', '') not in ('APPROVED', 'REJECTED', 'MODIFIED')
                     or ((e ->> 'outcome') = 'MODIFIED') <> (e ->> 'modification' is not null))
       or (select count(distinct e ->> 'item_id') from jsonb_array_elements(p_item_outcomes) e) <> cardinality(v_items) then
      perform api._fail('INVALID', 'item_outcomes');
    end if;
  elsif p_item_outcomes is not null then
    perform api._fail('INVALID', 'item_outcomes');
  end if;

  insert into decision.authority_decision (package_id, case_id, package_round, authority_type, outcome, decided_at,
                                           decided_by_label, source_document_reference, reason, recorded_by)
  values (v_p.id, v_p.case_id, v_p.round_no, p_authority_type, p_outcome, p_decided_at,
          api._require_text(p_decided_by_label, 'decided_by_label', 3, 200),
          api._require_text(p_source_document_reference, 'source_document_reference', 3, 300),
          case when p_reason is not null then api._require_text(p_reason, 'reason', 5, 4000) end, v_actor)
  returning id into v_id;
  if p_item_outcomes is not null then
    insert into decision.authority_item_decision (decision_id, item_id, outcome, modification)
    select v_id, (e ->> 'item_id')::uuid, e ->> 'outcome',
           case when e ->> 'modification' is not null then api._require_text(e ->> 'modification', 'modification', 5, 4000) end
    from jsonb_array_elements(p_item_outcomes) e;
  end if;
  v_status := case when p_outcome = 'RETURN_TO_COMMITTEE' then 'RETURNED_BY_AUTHORITY' else 'DECIDED' end;
  update decision.recommendation_package
     set status = v_status, decided_at = case when v_status = 'DECIDED' then now() end,
         updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event('AUTHORITY_DECISION_RECORDED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'authority_decision', v_id::text,
    null, jsonb_build_object('package_id', v_p.id, 'round_no', v_p.round_no, 'authority_type', p_authority_type,
                             'outcome', p_outcome, 'package_status', v_status,
                             'item_outcomes', coalesce(jsonb_array_length(p_item_outcomes), 0)));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Generic vote items carry no package (ADR-021): package and item votes come from api.open_package_vote.
-- -----------------------------------------------------------------------------
create or replace function api.open_vote_item(p_meeting_id uuid, p_target_type text, p_finding_id uuid, p_title text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.meeting;
  v_id uuid;
  v_seq int;
begin
  v_m := committee.lock_managed_meeting(p_meeting_id);
  if v_m.status <> 'OPEN' then perform api._fail('CONFLICT', 'MEETING_NOT_OPEN'); end if;
  if p_target_type is null or p_target_type not in ('FINDING', 'OTHER') then
    perform api._fail('INVALID', 'target_type');
  end if;
  if (p_target_type = 'FINDING') <> (p_finding_id is not null)
     or (p_finding_id is not null and not exists (
           select 1 from case_mgmt.finding f where f.id = p_finding_id and f.case_id = v_m.case_id)) then
    perform api._fail('INVALID', 'finding_id');
  end if;
  select coalesce(max(vi.sequence_no), 0) + 1 into v_seq from committee.vote_item vi where vi.meeting_id = v_m.id;
  insert into committee.vote_item (meeting_id, case_id, sequence_no, target_type, finding_id, title, opened_by)
  values (v_m.id, v_m.case_id, v_seq, p_target_type, p_finding_id, api._require_text(p_title, 'title', 3, 300), v_actor)
  returning id into v_id;
  perform audit.record_event('VOTE_OPENED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'vote_item', v_id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'sequence_no', v_seq, 'target_type', p_target_type, 'finding_id', p_finding_id));
  return v_id;
end;
$$;

grant execute on function
  api.set_action_authority_rule(text, text, timestamptz, text, text),
  api.create_recommendation_package(uuid, text),
  api.add_recommendation_item(uuid, text, text, text, text, uuid[], uuid[]),
  api.withdraw_recommendation_item(uuid, text),
  api.submit_package_for_vote(uuid),
  api.open_package_vote(uuid, uuid),
  api.record_package_adoption(uuid),
  api.request_legal_review(uuid, uuid, text, uuid[], uuid[]),
  api.approve_restricted_legal_review(uuid, uuid, text),
  api.open_packet(uuid),
  api.give_legal_opinion(uuid, text, text),
  api.submit_to_authority(uuid),
  api.record_authority_decision(uuid, text, text, timestamptz, text, text, jsonb, text)
to authenticated;
