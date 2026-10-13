-- =============================================================================
-- Section 3. Recommendation packages, legal review and authority decisions
-- =============================================================================
-- DEC-F11, DEC-F12, DEC-F13, DEC-F19, DEC-F20 and the ambiguity register rows routed here (AMB-018, AMB-026, AMB-030,
-- AMB-036, AMB-051, AMB-100–AMB-102, AMB-108, AMB-113, AMB-115, AMB-117, AMB-119, AMB-120, AMB-123, AMB-125–AMB-127,
-- AMB-129–AMB-133, AMB-135, AMB-229); contradictions CON-017 and CON-018.
--
--   3.1 Sanction catalogue versions (DEC-F11; AMB-036, AMB-101, AMB-102). decision.sanction_catalogue_version holds
--       the legal basis, internal policy basis, authority, legal-review requirement, subject categories and
--       exclusivity group of each code, effective-dated. Every seeded value is SOURCE_REQUIRED (nothing invented);
--       CONTRACTOR is not a category any seeded sanction applies to until sourced (AMB-036). Adoption snapshots the
--       item with its catalogue version (decision.item_adoption), so a later catalogue change never alters it.
--       decision.sanction_catalogue_entry shows a basis only once APPROVED. api.set_sanction_catalogue_entry
--       (COMMITTEE_ADMIN) writes a version and never fills a basis itself.
--   3.2 Legal-review rules (DEC-F12, CON-017; AMB-113, AMB-123). decision.legal_review_rule replaces the hard-coded
--       item types: by item type and by the item's "requires legal justification" flag, per committee kind,
--       effective-dated. The owner minimums (legal action, legal justification) cannot be switched off.
--       A catalogue version may also require review. Deliberate referral stays the SECRETARY_ELECTED basis.
--   3.3 Authority rules (DEC-F13, CON-018; AMB-127, AMB-132, AMB-135). A rule may name joint authorities. Submission
--       is refused while an adopted item type has no rule (fail closed) and snapshots the rule, its authorities and
--       its source status per item (decision.authority_submission / authority_requirement), so a later rule change
--       never changes the round. api.authority_rule_coverage shows which types have no rule, and that the
--       FINAL_DISCIPLINARY_AUTHORITY setting (0400) is still SOURCE_REQUIRED while the CEO rule is an owner default.
--   3.4 Authority decisions (AMB-125, AMB-126, AMB-129–AMB-131, AMB-133). One decision per authority type covers
--       that authority's items (decision.authority_decision_scope stores the rule of each); the package is DECIDED
--       only when every required authority has decided every item it must; joint authorities that disagree return
--       the package. A decision records the delegation reference, whether its source is signed (an unsigned source
--       needs the secretary's attestation and is flagged UNSIGNED_SOURCE), a primary and further source
--       documents, and structured conditions (free text only is flagged). decided_at may not fall on a day before
--       adoption (Asia/Riyadh).
--   3.5 Returns, cancellation and superseding opinions (AMB-108, AMB-115, AMB-117): the secretary returns an adopted,
--       unsubmitted package to the committee; cancels an open legal-review request (the reviewer's packet access ends
--       at once); the reviewer may give a superseding opinion in the same round before submission, both kept.
--   3.6 Purpose access ends (AMB-119, AMB-229): a legal reviewer's packet access ends when an authority decision on
--       the package is recorded; a task linked to a legal-hold request ends when the request is decided; both plus
--       the configurable grace PURPOSE_ACCESS_GRACE_DAYS (default 0).
--   3.7 Restricted legal review scope (DEC-F20, AMB-120): an approval names its round, findings and minutes; a
--       packet item outside it is refused on every path. DEC-F19 is as built (no change).
--   3.8 Defence notice before a sanction is adopted (AMB-026), conflict taint (AMB-051, DEC-AMB-003 default),
--       dependencies and exclusivity groups (AMB-100), and the preliminary-review referral guard (AMB-018). AMB-030
--       is as built: findings are append-only versions and a vote item binds one version.
--
-- Existing functions replaced (create or replace: same signature, owner, SECURITY DEFINER and search_path; no check
-- weakened):
--   decision.legal_review_required(uuid)        rule table instead of a fixed list (CON-017); still never false
--                                               where the fixed list said true while the seeded rules are in force.
--   decision.approving_decision(uuid)           respects each decision's scope when several authorities decide.
--   authz.can_view_packet(uuid)                 the reviewer branch ends on cancellation and on the authority
--                                               decision (narrower).
--   authz.user_task_grants(uuid, uuid, text)    a task linked to a decided legal-hold request grants nothing after
--                                               the grace period (narrower).
--   api.add_recommendation_item(7 args)         delegates to the new overload (justification flag, dependencies,
--                                               exclusivity group).
--   api.record_package_adoption(uuid)           sanction in force, defence notice guard, adoption snapshot.
--   api.request_legal_review(5 args)            taint guard, approval round and scope (DEC-F20).
--   api.approve_restricted_legal_review(3 args) delegates to the new overload with an empty scope.
--   api.give_legal_opinion(uuid, text, text)    a cancelled request is no longer the reviewer's.
--   api.submit_to_authority(uuid)               taint guard, fail closed on a missing rule, requirement snapshot.
--   api.record_authority_decision(8 args)       delegates to the new overload (per-authority scope).
-- One index is recreated under its name with a wider key: restricted_legal_review_approval_open is unique per package
-- round instead of per package (an unused approval of an earlier round no longer blocks the next one).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.1 Sanction catalogue versions
-- -----------------------------------------------------------------------------
create table decision.sanction_catalogue_version (
  id                       uuid primary key default gen_random_uuid(),
  code                     text not null references decision.sanction_catalogue (code),
  version_no               int not null check (version_no >= 1),
  legal_basis              text check (length(legal_basis) between 3 and 500),
  internal_policy_basis    text check (length(internal_policy_basis) between 3 and 500),
  -- Null: SOURCE_REQUIRED; decision.action_authority_rule decides.
  authority_type           text references decision.authority_type (code),
  legal_review_requirement text not null default 'SOURCE_REQUIRED'
                             check (legal_review_requirement in ('REQUIRED', 'NOT_REQUIRED', 'SOURCE_REQUIRED')),
  subject_categories       text[] not null
                             check (cardinality(subject_categories) >= 1
                                    and subject_categories <@ array['EMPLOYEE', 'CONTRACTOR', 'OTHER_AUTHORIZED']::text[]),
  -- Null: SOURCE_REQUIRED (AMB-100).
  exclusivity_group        text check (exclusivity_group ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  effective_from           timestamptz not null,
  effective_to             timestamptz,
  source_status            text not null check (source_status in ('SOURCE_REQUIRED', 'APPROVED')),
  source_reference         text check (length(source_reference) between 3 and 300),
  reason                   text check (length(reason) between 5 and 2000),
  created_by               uuid references iam.user_profile (id),
  created_at               timestamptz not null default now(),
  unique (code, version_no),
  check (effective_to is null or effective_to > effective_from),
  -- DEC-F11: nothing is APPROVED without its legal basis and the source that approved it.
  check (source_status <> 'APPROVED' or (legal_basis is not null and source_reference is not null)),
  check ((created_by is null) = (reason is null))
);
create unique index sanction_catalogue_version_open on decision.sanction_catalogue_version (code) where effective_to is null;
create index sanction_catalogue_version_authority on decision.sanction_catalogue_version (authority_type);
create index sanction_catalogue_version_created_by on decision.sanction_catalogue_version (created_by);
comment on table decision.sanction_catalogue_version is
  'DEC-F11 (migration 2030): the governed fields of each sanction code, effective-dated. Seeded SOURCE_REQUIRED; a '
  'basis is shown only once APPROVED (decision.sanction_catalogue_entry). Not selectable directly.';
insert into decision.sanction_catalogue_version (code, version_no, subject_categories, effective_from, source_status)
select c.code, 1, array['EMPLOYEE', 'OTHER_AUTHORIZED'], timestamptz '2026-01-01 00:00:00+00', 'SOURCE_REQUIRED'
from decision.sanction_catalogue c;

-- The adopted form of each approved item, with the catalogue version in force at adoption (AMB-101).
create table decision.item_adoption (
  item_id              uuid not null references decision.recommendation_item (id),
  package_id           uuid not null references decision.recommendation_package (id),
  package_round        int not null check (package_round >= 1),
  catalogue_version_id uuid references decision.sanction_catalogue_version (id),
  snapshot             jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  adopted_at           timestamptz not null default now(),
  primary key (item_id, package_round)
);
create index item_adoption_package on decision.item_adoption (package_id, package_round);
create index item_adoption_catalogue_version on decision.item_adoption (catalogue_version_id);
comment on table decision.item_adoption is
  'AMB-101 (migration 2030): what the committee adopted in a round, with the sanction catalogue version then in force.';

-- AMB-100: an item may depend on another item of its package, or share an exclusivity group with others.
alter table decision.recommendation_item
  add column requires_legal_justification boolean not null default false,
  add column exclusivity_group text check (exclusivity_group ~ '^[A-Z][A-Z0-9_]{2,59}$');
comment on column decision.recommendation_item.requires_legal_justification is
  'DEC-F12 (migration 2030): the matter needs a legal justification, so legal review is required (owner minimum).';
comment on column decision.recommendation_item.exclusivity_group is
  'AMB-100 (migration 2030): items of one group are alternatives; the authority may approve at most one.';

create table decision.recommendation_item_dependency (
  item_id    uuid not null references decision.recommendation_item (id),
  depends_on uuid not null references decision.recommendation_item (id),
  primary key (item_id, depends_on),
  check (item_id <> depends_on)
);
create index recommendation_item_dependency_on on decision.recommendation_item_dependency (depends_on);
comment on table decision.recommendation_item_dependency is
  'AMB-100 (migration 2030): an item that only makes sense if another is approved. Flagged, never auto-changed.';

-- -----------------------------------------------------------------------------
-- 3.2 Legal-review rules
-- -----------------------------------------------------------------------------
create table decision.legal_review_rule (
  id               uuid primary key default gen_random_uuid(),
  committee_kind   text not null check (committee_kind in ('INVESTIGATION', 'GRIEVANCE')),
  trigger_kind     text not null check (trigger_kind in ('ITEM_TYPE', 'LEGAL_JUSTIFICATION_FLAG')),
  item_type        text check (item_type in (
                     'FINDING', 'DISCIPLINARY_SANCTION', 'CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION', 'EXTERNAL_REFERRAL',
                     'NO_VIOLATION', 'CLOSE_WITHOUT_SANCTION', 'LEGAL_ACTION', 'OTHER')),
  requirement      text not null check (requirement in ('REQUIRED', 'NOT_REQUIRED')),
  effective_from   timestamptz not null,
  effective_to     timestamptz,
  -- OWNER_DECISION: an owner minimum (DEC-F12) that no rule may switch off.
  source_status    text not null check (source_status in ('OWNER_DECISION', 'OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  source_reference text check (length(source_reference) between 2 and 300),
  reason           text check (length(reason) between 5 and 2000),
  created_by       uuid references iam.user_profile (id),
  created_at       timestamptz not null default now(),
  check ((trigger_kind = 'ITEM_TYPE') = (item_type is not null)),
  check (effective_to is null or effective_to > effective_from),
  check ((created_by is null) = (source_status in ('OWNER_DECISION', 'OWNER_DEFAULT') and reason is null))
);
create unique index legal_review_rule_open on decision.legal_review_rule (committee_kind, trigger_kind, coalesce(item_type, ''))
  where effective_to is null;
create index legal_review_rule_created_by on decision.legal_review_rule (created_by);
comment on table decision.legal_review_rule is
  'DEC-F12 (migration 2030, CON-017): when legal review is required, by committee kind and item type or legal '
  'justification flag, effective-dated. Not exhaustive: the secretary may always elect a review.';
insert into decision.legal_review_rule (committee_kind, trigger_kind, item_type, requirement, effective_from, source_status,
                                        source_reference) values
  ('INVESTIGATION', 'ITEM_TYPE', 'DISCIPLINARY_SANCTION', 'REQUIRED', timestamptz '2026-01-01 00:00:00+00', 'OWNER_DEFAULT', 'Q74'),
  ('INVESTIGATION', 'ITEM_TYPE', 'LEGAL_ACTION', 'REQUIRED', timestamptz '2026-01-01 00:00:00+00', 'OWNER_DECISION', 'DEC-F12'),
  ('INVESTIGATION', 'ITEM_TYPE', 'EXTERNAL_REFERRAL', 'REQUIRED', timestamptz '2026-01-01 00:00:00+00', 'OWNER_DEFAULT', 'Q74'),
  ('INVESTIGATION', 'LEGAL_JUSTIFICATION_FLAG', null, 'REQUIRED', timestamptz '2026-01-01 00:00:00+00', 'OWNER_DECISION', 'DEC-F12'),
  -- AMB-123: recorded for the Grievance Committee; its outcomes have no legal-review path yet, so it is not enforced.
  ('GRIEVANCE', 'ITEM_TYPE', 'DISCIPLINARY_SANCTION', 'REQUIRED', timestamptz '2026-01-01 00:00:00+00', 'OWNER_DEFAULT', 'AMB-123');

-- -----------------------------------------------------------------------------
-- 3.3 Authority rules: joint authorities and the submission snapshot
-- -----------------------------------------------------------------------------
create table decision.action_authority_rule_joint (
  rule_id        uuid not null references decision.action_authority_rule (id),
  authority_type text not null references decision.authority_type (code),
  primary key (rule_id, authority_type)
);
create index action_authority_rule_joint_authority on decision.action_authority_rule_joint (authority_type);
comment on table decision.action_authority_rule_joint is
  'AMB-127 (migration 2030): further authorities that must also decide items of the rule''s type (joint approval).';

create table decision.authority_submission (
  id            uuid primary key default gen_random_uuid(),
  package_id    uuid not null references decision.recommendation_package (id),
  case_id       uuid not null references case_mgmt.case_record (id),
  package_round int not null check (package_round >= 1),
  packet_id     uuid references decision.packet (id),
  -- BACKFILL: a package already with the authority before migration 2030, snapshotted at its first later decision.
  basis         text not null check (basis in ('SUBMISSION', 'BACKFILL')),
  submitted_by  uuid not null references iam.user_profile (id),
  submitted_at  timestamptz not null default now(),
  unique (package_id, package_round)
);
create index authority_submission_case on decision.authority_submission (case_id);
create index authority_submission_packet on decision.authority_submission (packet_id);
create index authority_submission_submitted_by on decision.authority_submission (submitted_by);
comment on table decision.authority_submission is
  'AMB-132 (migration 2030): one submission per package round; its requirements are the rules in force when submitted.';

create table decision.authority_requirement (
  submission_id      uuid not null references decision.authority_submission (id),
  item_id            uuid not null references decision.recommendation_item (id),
  authority_type     text not null references decision.authority_type (code),
  rule_id            uuid not null references decision.action_authority_rule (id),
  rule_source_status text not null check (rule_source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  primary key (submission_id, item_id, authority_type)
);
create index authority_requirement_item on decision.authority_requirement (item_id);
create index authority_requirement_rule on decision.authority_requirement (rule_id);
create index authority_requirement_authority on decision.authority_requirement (authority_type);

-- -----------------------------------------------------------------------------
-- 3.4 Authority decisions: scope, sources, conditions
-- -----------------------------------------------------------------------------
alter table decision.authority_decision
  add column submission_id        uuid references decision.authority_submission (id),
  add column delegation_reference text check (length(delegation_reference) between 3 and 300),
  -- AMB-129: null when not recorded (decisions before 2030 and the 8-argument command).
  add column source_signature     text check (source_signature in ('SIGNED', 'UNSIGNED')),
  add column unsigned_attestation text check (length(unsigned_attestation) between 10 and 2000),
  add constraint authority_decision_unsigned_attested
    check ((coalesce(source_signature, '') = 'UNSIGNED') = (unsigned_attestation is not null));
create index authority_decision_submission on decision.authority_decision (submission_id);
comment on column decision.authority_decision.delegation_reference is
  'AMB-125 (migration 2030): the delegation under which the deciding person acted. The Delegation of Authority is '
  'SOURCE_REQUIRED; the authority type must still match the rule.';
comment on column decision.authority_decision.source_signature is
  'AMB-129 (migration 2030): SIGNED, UNSIGNED (accepted only with the secretary''s attestation and flagged '
  'UNSIGNED_SOURCE in every view) or null (not recorded, flagged SIGNATURE_NOT_RECORDED).';

create table decision.authority_decision_scope (
  decision_id    uuid not null references decision.authority_decision (id),
  item_id        uuid not null references decision.recommendation_item (id),
  authority_type text not null references decision.authority_type (code),
  rule_id        uuid not null references decision.action_authority_rule (id),
  item_outcome   text not null check (item_outcome in ('APPROVED', 'REJECTED', 'MODIFIED', 'RETURNED', 'OTHER')),
  primary key (decision_id, item_id)
);
create index authority_decision_scope_item on decision.authority_decision_scope (item_id);
create index authority_decision_scope_rule on decision.authority_decision_scope (rule_id);
create index authority_decision_scope_authority on decision.authority_decision_scope (authority_type);
comment on table decision.authority_decision_scope is
  'AMB-126 (migration 2030): the items one authority decision covers, with the rule that required that authority.';

create table decision.authority_decision_source (
  decision_id uuid not null references decision.authority_decision (id),
  position    int not null check (position >= 1),
  reference   text not null check (length(reference) between 3 and 300),
  is_primary  boolean not null,
  primary key (decision_id, position),
  unique (decision_id, reference),
  check (is_primary = (position = 1))
);
comment on table decision.authority_decision_source is
  'AMB-130 (migration 2030): the source documents of a decision; position 1 is the primary one (N15).';

create table decision.authority_decision_condition (
  id             uuid primary key default gen_random_uuid(),
  decision_id    uuid not null references decision.authority_decision (id),
  position       int not null check (position >= 1),
  kind           text not null check (kind in ('CORRECTIVE_ACTION', 'FOLLOW_UP_TASK', 'FREE_TEXT')),
  item_id        uuid references decision.recommendation_item (id),
  condition_text text not null check (length(condition_text) between 5 and 2000),
  due_date       date,
  unique (decision_id, position)
);
create index authority_decision_condition_item on decision.authority_decision_condition (item_id);
comment on table decision.authority_decision_condition is
  'AMB-133 (migration 2030): conditions the authority attached. FREE_TEXT only is flagged; turning a condition into '
  'a corrective action or task is not built yet.';

-- -----------------------------------------------------------------------------
-- 3.5 Returns, cancellations and superseding opinions
-- -----------------------------------------------------------------------------
create table decision.package_return (
  id            uuid primary key default gen_random_uuid(),
  package_id    uuid not null references decision.recommendation_package (id),
  case_id       uuid not null references case_mgmt.case_record (id),
  package_round int not null check (package_round >= 1),
  reason        text not null check (length(reason) between 5 and 2000),
  returned_by   uuid not null references iam.user_profile (id),
  returned_at   timestamptz not null default now()
);
create index package_return_package on decision.package_return (package_id);
create index package_return_case on decision.package_return (case_id);
create index package_return_returned_by on decision.package_return (returned_by);
comment on table decision.package_return is
  'AMB-108 (migration 2030): the secretary returned an adopted package to the committee before submission.';

-- AMB-115: a request can be cancelled while open. The check keeps its 1900 name.
alter table decision.legal_review_request drop constraint legal_review_request_status_check;
alter table decision.legal_review_request add constraint legal_review_request_status_check
  check (status in ('ASSIGNED', 'OPINION_GIVEN', 'CANCELLED'));

create table decision.legal_review_cancellation (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null unique references decision.legal_review_request (id),
  package_id   uuid not null references decision.recommendation_package (id),
  case_id      uuid not null references case_mgmt.case_record (id),
  reason       text not null check (length(reason) between 5 and 2000),
  cancelled_by uuid not null references iam.user_profile (id),
  cancelled_at timestamptz not null default now()
);
create index legal_review_cancellation_package on decision.legal_review_cancellation (package_id);
create index legal_review_cancellation_case on decision.legal_review_cancellation (case_id);
create index legal_review_cancellation_cancelled_by on decision.legal_review_cancellation (cancelled_by);

create table decision.legal_opinion_revision (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references decision.legal_review_request (id),
  package_id    uuid not null references decision.recommendation_package (id),
  case_id       uuid not null references case_mgmt.case_record (id),
  package_round int not null check (package_round >= 1),
  revision_no   int not null check (revision_no >= 2),
  opinion       text not null check (opinion in ('CONCURS', 'CONCURS_WITH_COMMENTS', 'CONFLICTS')),
  opinion_text  text check (length(opinion_text) between 10 and 8000),
  given_by      uuid not null references iam.user_profile (id),
  given_at      timestamptz not null default now(),
  unique (request_id, revision_no),
  check (opinion = 'CONCURS' or opinion_text is not null)
);
create index legal_opinion_revision_package on decision.legal_opinion_revision (package_id);
create index legal_opinion_revision_case on decision.legal_opinion_revision (case_id);
create index legal_opinion_revision_given_by on decision.legal_opinion_revision (given_by);
comment on table decision.legal_opinion_revision is
  'AMB-117 (migration 2030): a superseding opinion in the same round, before submission. The first opinion stays on '
  'the request (revision 1); both travel to the authority.';

-- -----------------------------------------------------------------------------
-- 3.6 Purpose access grace (AMB-229)
-- -----------------------------------------------------------------------------
insert into config.setting (key, value, status, source_reference, description) values
  ('PURPOSE_ACCESS_GRACE_DAYS', '0', 'CONFIGURED', 'AMB-229 owner appendix default (no grace)',
   'Days a purpose-bound reader keeps access after the purpose concludes (legal review packet, legal-hold task).');
update config.setting
   set description = 'Authority that issues final disciplinary decisions. Still SOURCE_REQUIRED (Delegation of Authority); '
                     'the rule in force is decision.action_authority_rule, where DISCIPLINARY_SANCTION → CEO is an owner '
                     'default (DEC-F13). api.authority_rule_coverage reports the difference.'
 where key = 'FINAL_DISCIPLINARY_AUTHORITY';

-- -----------------------------------------------------------------------------
-- 3.7 Restricted legal review scope (DEC-F20)
-- -----------------------------------------------------------------------------
alter table decision.restricted_legal_review_approval
  add column package_round int check (package_round >= 1),
  add column finding_ids   uuid[] not null default '{}',
  add column minutes_ids   uuid[] not null default '{}';
comment on column decision.restricted_legal_review_approval.package_round is
  'DEC-F20 (migration 2030): the round the approval is for. Null on approvals before 2030: never usable again.';
comment on column decision.restricted_legal_review_approval.finding_ids is
  'DEC-F20 (migration 2030): the findings the packet may carry. Anything more needs a new approval.';
drop index decision.restricted_legal_review_approval_open;
create unique index restricted_legal_review_approval_open
  on decision.restricted_legal_review_approval (package_id, coalesce(package_round, 0)) where legal_review_request_id is null;

-- -----------------------------------------------------------------------------
-- Integrity
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['decision.item_adoption', 'decision.recommendation_item_dependency',
                           'decision.action_authority_rule_joint', 'decision.authority_submission',
                           'decision.authority_requirement', 'decision.authority_decision_scope',
                           'decision.authority_decision_source', 'decision.authority_decision_condition',
                           'decision.package_return', 'decision.legal_review_cancellation',
                           'decision.legal_opinion_revision'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
  foreach t in array array['decision.sanction_catalogue_version', 'decision.legal_review_rule'] loop
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;

-- Effective-dated rows: only an end may be given, once.
create function decision.protect_effective_dated()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') or old.effective_to is not null then
    raise exception '% % can only be given an end, once', tg_table_name, old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger sanction_catalogue_version_protect before update on decision.sanction_catalogue_version
  for each row execute function decision.protect_effective_dated();
create trigger legal_review_rule_protect before update on decision.legal_review_rule
  for each row execute function decision.protect_effective_dated();

-- -----------------------------------------------------------------------------
-- Internal helpers
-- -----------------------------------------------------------------------------
-- The catalogue version of a code in force now, or null.
create function decision.catalogue_version_in_force(p_code text)
returns uuid
language sql stable
set search_path = ''
as $$
  select v.id from decision.sanction_catalogue_version v
  where v.code = p_code and v.effective_from <= now() and (v.effective_to is null or v.effective_to > now())
  order by v.effective_from desc limit 1;
$$;

-- The catalogue version an item carries: the one snapshotted at its adoption in the package's round, else the one in
-- force.
create function decision.item_catalogue_version(p_item_id uuid)
returns uuid
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select a.catalogue_version_id from decision.item_adoption a
     join decision.recommendation_package p on p.id = a.package_id and p.round_no = a.package_round
     where a.item_id = i.id),
    decision.catalogue_version_in_force(i.sanction_code))
  from decision.recommendation_item i where i.id = p_item_id and i.sanction_code is not null;
$$;

-- The authority rule in force now for an item type, or null.
create function decision.authority_rule_in_force(p_item_type text)
returns uuid
language sql stable
set search_path = ''
as $$
  select r.id from decision.action_authority_rule r
  where r.item_type = p_item_type and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())
  order by r.effective_from desc limit 1;
$$;

-- What 2030 adds to an item snapshot (the 1900 snapshot is unchanged): the legal-justification flag, the
-- exclusivity group, the items it depends on and the sanction catalogue version it carries (AMB-101).
create function decision.item_snapshot_extra(p_item_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'requires_legal_justification', i.requires_legal_justification, 'exclusivity_group', i.exclusivity_group,
    'depends_on', coalesce((select jsonb_agg(d.depends_on order by d.depends_on) from decision.recommendation_item_dependency d
                            where d.item_id = i.id), '[]'::jsonb),
    'catalogue_version_id', decision.item_catalogue_version(i.id))
  from decision.recommendation_item i where i.id = p_item_id;
$$;

-- AMB-051 (DEC-AMB-003 default): an active item is tainted when someone whose vote counted on it in the package's
-- current round (a substantive vote or the casting vote on a closed vote item for the item or the whole package) is
-- now conflicted in the proceeding (a declared or upheld meeting conflict) or in the case (a declared or confirmed
-- case conflict). A conflicted member cannot vote, so any such conflict came to light after the vote. The committee
-- acts by voting again in a new round without them.
create function decision.item_tainted(p_item_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1
    from decision.recommendation_item i
    join decision.recommendation_package p on p.id = i.package_id
    join committee.vote_item vi on vi.package_id = p.id and vi.package_round = p.round_no and vi.status = 'CLOSED'
                               and (vi.recommendation_item_id = i.id or vi.recommendation_item_id is null)
    join lateral (select v.recorded_for as user_id from committee.vote v
                  where v.vote_item_id = vi.id and v.choice in ('APPROVE', 'REJECT', 'ABSTAIN')
                  union
                  select c.cast_by from committee.casting_vote c where c.vote_item_id = vi.id) u on true
    where i.id = p_item_id and i.status = 'ACTIVE'
      and (authz.has_meeting_conflict(u.user_id, p.committee_proceeding_id)
           or exists (select 1 from case_mgmt.conflict_check cc
                      where cc.case_id = p.case_id and cc.user_id = u.user_id and cc.is_current
                        and cc.status in ('CONFLICT_DECLARED', 'CONFLICT_CONFIRMED')))
  );
$$;

-- The grace after a purpose concludes (AMB-229): PURPOSE_ACCESS_GRACE_DAYS, 0 when unset or malformed.
create function authz.purpose_access_grace()
returns interval
language sql stable
set search_path = ''
as $$
  select make_interval(days => coalesce((select case when s.value ~ '^[0-9]{1,3}$' then s.value::int end
                                         from config.setting s where s.key = 'PURPOSE_ACCESS_GRACE_DAYS'), 0));
$$;
revoke all on function authz.purpose_access_grace() from public, anon, authenticated;

-- Checks a new item's catalogue code is in force (AMB-101).
create function decision.check_item_sanction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.sanction_code is not null and decision.catalogue_version_in_force(new.sanction_code) is null then
    perform api._fail('CONFLICT', 'SANCTION_NOT_IN_FORCE');
  end if;
  return new;
end;
$$;
create trigger recommendation_item_sanction_in_force before insert on decision.recommendation_item
  for each row execute function decision.check_item_sanction();

-- AMB-036: a sanction applies only to the subject categories of its catalogue version. A free-text sanction follows
-- the seeded default (no CONTRACTOR until sourced). Every path that names a subject is covered.
create function decision.check_sanction_subject()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_i decision.recommendation_item;
  v_category text;
  v_categories text[];
begin
  select * into v_i from decision.recommendation_item i where i.id = new.item_id;
  if v_i.item_type <> 'DISCIPLINARY_SANCTION' then return new; end if;
  select s.subject_category into v_category from case_mgmt.case_subject s where s.id = new.subject_id;
  if v_i.sanction_code is not null then
    select v.subject_categories into v_categories
    from decision.sanction_catalogue_version v where v.id = decision.catalogue_version_in_force(v_i.sanction_code);
  end if;
  if not (v_category = any (coalesce(v_categories, array['EMPLOYEE', 'OTHER_AUTHORIZED']))) then
    perform api._fail('CONFLICT', 'SANCTION_NOT_APPLICABLE_TO_SUBJECT');
  end if;
  return new;
end;
$$;
create trigger recommendation_item_subject_applicable before insert on decision.recommendation_item_subject
  for each row execute function decision.check_sanction_subject();

-- DEC-F20, AMB-120: on a restricted case, a legal-review packet carries only what its approval names: the package's
-- items, and the findings and minutes listed on the approval. Anything else, on any path, is refused.
create function decision.enforce_restricted_packet_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_k decision.packet;
  v_a decision.restricted_legal_review_approval;
begin
  select * into v_k from decision.packet k where k.id = new.packet_id;
  if v_k.purpose <> 'LEGAL_REVIEW'
     or not exists (select 1 from case_mgmt.case_record c where c.id = v_k.case_id and c.is_restricted) then
    return new;
  end if;
  select * into v_a from decision.restricted_legal_review_approval a where a.legal_review_request_id = v_k.legal_review_request_id;
  if v_a.id is null then perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_REQUIRED'); end if;
  if not (case new.item_kind
            when 'RECOMMENDATION_ITEM' then exists (select 1 from decision.recommendation_item i
                                                    where i.id = new.source_id and i.package_id = v_k.package_id)
            when 'FINDING' then new.source_id = any (v_a.finding_ids)
            when 'MINUTES' then new.source_id = any (v_a.minutes_ids)
            else false end) then
    perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_SCOPE_EXCEEDED');
  end if;
  return new;
end;
$$;
create trigger packet_item_restricted_scope before insert on decision.packet_item
  for each row execute function decision.enforce_restricted_packet_scope();

-- AMB-018: a case that did not arrive as a direct referral (or a grievance) reaches the Investigation Committee only
-- after its preliminary review concluded REFERRED_TO_COMMITTEE with the approver's approval (Q11, Q15; ADR-017 §5).
-- A trigger, so every path that opens a committee proceeding is covered. It runs after the restricted-case approval
-- check of committee.open_committee_proceeding (DEC-61, DEC-F19).
create function committee.require_preliminary_referral()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from committee.committee c where c.id = new.committee_id and c.kind = 'INVESTIGATION')
     and exists (select 1 from case_mgmt.case_record r
                 where r.id = new.case_id and r.source_type not in ('DIRECT_REFERRAL', 'DIRECT_GRIEVANCE'))
     and coalesce((select pr.recommended_outcome
                   from case_mgmt.preliminary_recommendation pr
                   join case_mgmt.proceeding p on p.id = pr.proceeding_id
                   where pr.case_id = new.case_id and pr.status = 'APPROVED'
                   order by pr.approved_at desc, p.sequence_no desc, pr.version_no desc
                   limit 1), '') <> 'REFERRED_TO_COMMITTEE' then
    perform api._fail('CONFLICT', 'PRELIMINARY_REFERRAL_REQUIRED');
  end if;
  return new;
end;
$$;
create trigger committee_proceeding_preliminary_referral before insert on committee.committee_proceeding
  for each row execute function committee.require_preliminary_referral();

-- -----------------------------------------------------------------------------
-- Replaced predicates and helpers
-- -----------------------------------------------------------------------------
-- DEC-F12 (CON-017): required by a rule in force for the committee's kind (by item type, or by the item's
-- legal-justification flag), or by the item's catalogue version. A NOT_REQUIRED rule never cancels another source.
create or replace function decision.legal_review_required(p_package_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1
    from decision.recommendation_item i
    join decision.recommendation_package p on p.id = i.package_id
    join committee.committee_proceeding cp on cp.id = p.committee_proceeding_id
    join committee.committee c on c.id = cp.committee_id
    where i.package_id = p_package_id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
      and (exists (select 1 from decision.legal_review_rule r
                   where r.committee_kind = c.kind and r.requirement = 'REQUIRED'
                     and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())
                     and ((r.trigger_kind = 'ITEM_TYPE' and r.item_type = i.item_type)
                          or (r.trigger_kind = 'LEGAL_JUSTIFICATION_FLAG' and i.requires_legal_justification)))
           or exists (select 1 from decision.sanction_catalogue_version v
                      where v.id = decision.item_catalogue_version(i.id) and v.legal_review_requirement = 'REQUIRED'))
  );
$$;

-- 1940, now aware of several authorities: a decision with a recorded scope approves an item only when it covers the
-- item with an approving outcome and no other decision of the round covering the item disagrees. Decisions recorded
-- before 2030 (no scope) keep the 1940 reading.
create or replace function decision.approving_decision(p_item_id uuid)
returns uuid
language sql stable
set search_path = ''
as $$
  select d.id
  from decision.recommendation_item i
  join decision.recommendation_package k on k.id = i.package_id and k.status = 'DECIDED'
  join decision.authority_decision d on d.package_id = k.id and d.package_round = k.round_no
  where i.id = p_item_id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
    and i.item_type in ('CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION')
    and case
          when exists (select 1 from decision.authority_decision_scope sc where sc.decision_id = d.id) then
            exists (select 1 from decision.authority_decision_scope sc
                    where sc.decision_id = d.id and sc.item_id = i.id and sc.item_outcome in ('APPROVED', 'MODIFIED'))
            and not exists (select 1 from decision.authority_decision d2
                            join decision.authority_decision_scope sc2 on sc2.decision_id = d2.id
                            where d2.package_id = k.id and d2.package_round = k.round_no and sc2.item_id = i.id
                              and sc2.item_outcome not in ('APPROVED', 'MODIFIED'))
          else d.outcome = 'APPROVE_AS_RECOMMENDED'
               or (d.outcome in ('APPROVE_PARTIALLY', 'MODIFY')
                   and exists (select 1 from decision.authority_item_decision x
                               where x.decision_id = d.id and x.item_id = i.id and x.outcome in ('APPROVED', 'MODIFIED')))
        end
  order by d.recorded_at, d.id
  limit 1;
$$;

-- N14 as in 1900, with the reviewer branch narrowed: a cancelled request (a replaced reviewer, AMB-115) gives nothing,
-- and the purpose ends once an authority decision on the package in the request's round or later is recorded, plus
-- the grace period (AMB-119, AMB-229).
create or replace function authz.can_view_packet(p_packet_id uuid)
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
                           where r.id = k.legal_review_request_id and r.assigned_to = authz.current_user_id()
                             and r.status <> 'CANCELLED'
                             and not exists (select 1 from decision.authority_decision d
                                             where d.package_id = r.package_id and d.package_round >= r.package_round
                                               and d.recorded_at + authz.purpose_access_grace() <= now()))))
  );
$$;

-- ADR-014 as in 1700, narrowed (AMB-229): a task linked to a legal-hold request grants nothing once the request is
-- decided and the grace period has passed, even if the task was left open.
create or replace function authz.user_task_grants(p_user_id uuid, p_case_id uuid, p_capability text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.user_case_gate(p_user_id, p_case_id)
     and (p_capability = 'CASE_VIEW_METADATA' or authz.user_has_permission(p_user_id, p_capability))
     and exists (
       select 1 from case_mgmt.case_task t
       where t.case_id = p_case_id and t.assigned_user_id = p_user_id
         and t.status in ('OPEN', 'IN_PROGRESS')
         and t.access_granted_at <= now() and t.expires_at > now()
         and p_capability = any (t.scope)
         and authz.user_has_role(p_user_id, t.assigned_role)
         and not exists (select 1 from records.legal_hold_request h
                         where h.assigned_task_id = t.id and h.reviewed_at is not null
                           and h.reviewed_at + authz.purpose_access_grace() <= now()));
$$;

-- -----------------------------------------------------------------------------
-- RLS (SELECT only; no write grants)
-- -----------------------------------------------------------------------------
alter table decision.sanction_catalogue_version enable row level security;
alter table decision.item_adoption enable row level security;
alter table decision.recommendation_item_dependency enable row level security;
alter table decision.legal_review_rule enable row level security;
alter table decision.action_authority_rule_joint enable row level security;
alter table decision.authority_submission enable row level security;
alter table decision.authority_requirement enable row level security;
alter table decision.authority_decision_scope enable row level security;
alter table decision.authority_decision_source enable row level security;
alter table decision.authority_decision_condition enable row level security;
alter table decision.package_return enable row level security;
alter table decision.legal_review_cancellation enable row level security;
alter table decision.legal_opinion_revision enable row level security;

-- decision.sanction_catalogue_version: no policy and no grant; read through decision.sanction_catalogue_entry.
create policy item_adoption_read on decision.item_adoption for select to authenticated
  using (authz.can_view_recommendation_package(package_id));
grant select on decision.item_adoption to authenticated;
create policy recommendation_item_dependency_read on decision.recommendation_item_dependency for select to authenticated
  using (exists (select 1 from decision.recommendation_item i
                 where i.id = item_id and authz.can_view_recommendation_package(i.package_id)));
grant select on decision.recommendation_item_dependency to authenticated;
create policy legal_review_rule_read on decision.legal_review_rule for select to authenticated
  using (authz.current_user_id() is not null);
grant select on decision.legal_review_rule to authenticated;
create policy action_authority_rule_joint_read on decision.action_authority_rule_joint for select to authenticated
  using (authz.current_user_id() is not null);
grant select on decision.action_authority_rule_joint to authenticated;
create policy authority_submission_read on decision.authority_submission for select to authenticated
  using (authz.can_view_recommendation_package(package_id));
grant select on decision.authority_submission to authenticated;
create policy authority_requirement_read on decision.authority_requirement for select to authenticated
  using (exists (select 1 from decision.authority_submission x
                 where x.id = submission_id and authz.can_view_recommendation_package(x.package_id)));
grant select on decision.authority_requirement to authenticated;
create policy authority_decision_scope_read on decision.authority_decision_scope for select to authenticated
  using (exists (select 1 from decision.authority_decision d
                 where d.id = decision_id and authz.can_view_recommendation_package(d.package_id)));
grant select on decision.authority_decision_scope to authenticated;
create policy authority_decision_source_read on decision.authority_decision_source for select to authenticated
  using (exists (select 1 from decision.authority_decision d
                 where d.id = decision_id and authz.can_view_recommendation_package(d.package_id)));
grant select on decision.authority_decision_source to authenticated;
create policy authority_decision_condition_read on decision.authority_decision_condition for select to authenticated
  using (exists (select 1 from decision.authority_decision d
                 where d.id = decision_id and authz.can_view_recommendation_package(d.package_id)));
grant select on decision.authority_decision_condition to authenticated;
create policy package_return_read on decision.package_return for select to authenticated
  using (authz.can_view_recommendation_package(package_id));
grant select on decision.package_return to authenticated;
create policy legal_review_cancellation_read on decision.legal_review_cancellation for select to authenticated
  using (authz.can_view_recommendation_package(package_id));
grant select on decision.legal_review_cancellation to authenticated;
-- As the request itself: the package's viewers, and the reviewer while they can read the request's packet.
create policy legal_opinion_revision_read on decision.legal_opinion_revision for select to authenticated
  using (authz.can_view_recommendation_package(package_id)
         or (given_by = authz.current_user_id()
             and exists (select 1 from decision.packet k
                         where k.legal_review_request_id = legal_opinion_revision.request_id and authz.can_view_packet(k.id))));
grant select on decision.legal_opinion_revision to authenticated;

-- -----------------------------------------------------------------------------
-- Read models
-- -----------------------------------------------------------------------------
-- AMB-102 (T-AMB-057): every code with the version in force. A basis is shown only once APPROVED; until then the row
-- says SOURCE_REQUIRED and never shows draft text as policy.
create function decision.sanction_catalogue_rows()
returns table (code text, is_active boolean, version_id uuid, version_no int, effective_from timestamptz,
               effective_to timestamptz, source_status text, basis_status text, legal_basis text,
               internal_policy_basis text, source_reference text, authority_type text, authority_status text,
               legal_review_requirement text, subject_categories text[], exclusivity_group text,
               exclusivity_status text)
language sql stable security definer
set search_path = ''
as $$
  select c.code, c.is_active, v.id, v.version_no, v.effective_from, v.effective_to,
         coalesce(v.source_status, 'SOURCE_REQUIRED'),
         case when v.source_status = 'APPROVED' then 'SOURCED' else 'SOURCE_REQUIRED' end,
         case when v.source_status = 'APPROVED' then v.legal_basis end,
         case when v.source_status = 'APPROVED' then v.internal_policy_basis end,
         case when v.source_status = 'APPROVED' then v.source_reference end,
         v.authority_type,
         case when v.authority_type is null then 'SOURCE_REQUIRED' else v.source_status end,
         coalesce(v.legal_review_requirement, 'SOURCE_REQUIRED'), v.subject_categories, v.exclusivity_group,
         case when v.exclusivity_group is null then 'SOURCE_REQUIRED' else v.source_status end
  from decision.sanction_catalogue c
  left join decision.sanction_catalogue_version v
    on v.id = decision.catalogue_version_in_force(c.code)
  where authz.current_user_id() is not null;
$$;
revoke all on function decision.sanction_catalogue_rows() from public, anon;
grant execute on function decision.sanction_catalogue_rows() to authenticated;

create view decision.sanction_catalogue_entry with (security_invoker = true) as
select * from decision.sanction_catalogue_rows();
comment on view decision.sanction_catalogue_entry is
  'DEC-F11, AMB-102 (migration 2030): each sanction code with the catalogue version in force. A basis is shown only '
  'once APPROVED; SOURCE_REQUIRED rows are never policy.';
grant select on decision.sanction_catalogue_entry to authenticated;

-- AMB-129, AMB-133 (T-AMB-075): each decision the caller may see, with its flags. The export builder reads the same
-- flags (read-model flag; the export itself is unchanged).
create view decision.authority_decision_overview with (security_invoker = true) as
select d.id as decision_id, d.package_id, d.case_id, d.package_round, d.authority_type, d.outcome, d.decided_at,
       d.recorded_at, d.decided_by_label, d.source_document_reference as primary_source, d.delegation_reference,
       d.source_signature,
       (select count(*) from decision.authority_decision_source s where s.decision_id = d.id)::int as source_count,
       (select count(*) from decision.authority_decision_condition c where c.decision_id = d.id)::int as condition_count,
       array_remove(array[
         case when d.source_signature = 'UNSIGNED' then 'UNSIGNED_SOURCE' end,
         case when d.source_signature is null then 'SIGNATURE_NOT_RECORDED' end,
         case when exists (select 1 from decision.authority_decision_condition c
                           where c.decision_id = d.id and c.kind = 'FREE_TEXT') then 'FREE_TEXT_CONDITION' end,
         case when d.delegation_reference is not null then 'DELEGATED' end], null)::text[] as flags
from decision.authority_decision d;
comment on view decision.authority_decision_overview is
  'AMB-125, AMB-129, AMB-133 (migration 2030): authority decisions with UNSIGNED_SOURCE, SIGNATURE_NOT_RECORDED, '
  'FREE_TEXT_CONDITION and DELEGATED flags. Rows follow authority_decision''s policy.';
grant select on decision.authority_decision_overview to authenticated;

-- -----------------------------------------------------------------------------
-- Commands: catalogue and rules (COMMITTEE_ADMIN)
-- -----------------------------------------------------------------------------
-- DEC-F11: a new catalogue version of a code. Never invents a basis: APPROVED needs the basis and its source.
create function api.set_sanction_catalogue_entry(
  p_code text, p_legal_basis text, p_internal_policy_basis text, p_authority_type text, p_legal_review_requirement text,
  p_subject_categories text[], p_exclusivity_group text, p_effective_from timestamptz, p_source_status text,
  p_source_reference text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_reason text;
  v_version int;
  v_id uuid;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_code is null or not exists (select 1 from decision.sanction_catalogue c where c.code = p_code and c.is_active) then
    perform api._fail('INVALID', 'code');
  end if;
  if p_legal_basis is not null then perform api._require_text(p_legal_basis, 'legal_basis', 3, 500); end if;
  if p_internal_policy_basis is not null then
    perform api._require_text(p_internal_policy_basis, 'internal_policy_basis', 3, 500);
  end if;
  if p_authority_type is not null
     and not exists (select 1 from decision.authority_type a where a.code = p_authority_type and a.is_active) then
    perform api._fail('INVALID', 'authority_type');
  end if;
  if p_legal_review_requirement is null or p_legal_review_requirement not in ('REQUIRED', 'NOT_REQUIRED', 'SOURCE_REQUIRED') then
    perform api._fail('INVALID', 'legal_review_requirement');
  end if;
  if p_subject_categories is null or cardinality(p_subject_categories) = 0
     or not (p_subject_categories <@ array['EMPLOYEE', 'CONTRACTOR', 'OTHER_AUTHORIZED']::text[])
     or (select count(distinct x) from unnest(p_subject_categories) x) <> cardinality(p_subject_categories) then
    perform api._fail('INVALID', 'subject_categories');
  end if;
  if p_exclusivity_group is not null and p_exclusivity_group !~ '^[A-Z][A-Z0-9_]{2,59}$' then
    perform api._fail('INVALID', 'exclusivity_group');
  end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  if p_source_reference is not null then perform api._require_text(p_source_reference, 'source_reference', 3, 300); end if;
  if p_source_status = 'APPROVED' then
    if p_legal_basis is null then perform api._fail('INVALID', 'legal_basis'); end if;
    if p_source_reference is null then perform api._fail('INVALID', 'source_reference'); end if;
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform 1 from decision.sanction_catalogue c where c.code = p_code for update;
  if exists (select 1 from decision.sanction_catalogue_version v
             where v.code = p_code and v.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'LATER_VERSION_EXISTS');
  end if;
  select coalesce(max(v.version_no), 0) + 1 into v_version from decision.sanction_catalogue_version v where v.code = p_code;
  update decision.sanction_catalogue_version set effective_to = p_effective_from
   where code = p_code and effective_to is null;
  insert into decision.sanction_catalogue_version (code, version_no, legal_basis, internal_policy_basis, authority_type,
                                                   legal_review_requirement, subject_categories, exclusivity_group,
                                                   effective_from, source_status, source_reference, reason, created_by)
  values (p_code, v_version, btrim(p_legal_basis), btrim(p_internal_policy_basis), p_authority_type,
          p_legal_review_requirement, p_subject_categories, p_exclusivity_group, p_effective_from, p_source_status,
          btrim(p_source_reference), v_reason, v_actor)
  returning id into v_id;
  -- The basis texts stay in the version row; the ledger gets codes, flags and the administrator's reason (as 1900).
  perform audit.record_event('SANCTION_CATALOGUE_VERSION_SET', 'ADMIN', 'SUCCESS', null, 'sanction_catalogue_version',
    v_id::text, v_reason,
    jsonb_build_object('code', p_code, 'version_no', v_version, 'effective_from', p_effective_from,
                       'source_status', p_source_status, 'authority_type', p_authority_type,
                       'legal_review_requirement', p_legal_review_requirement,
                       'subject_categories', to_jsonb(p_subject_categories), 'exclusivity_group', p_exclusivity_group,
                       'has_legal_basis', p_legal_basis is not null,
                       'has_internal_policy_basis', p_internal_policy_basis is not null));
  return v_id;
end;
$$;

-- DEC-F12: a new legal-review rule from a date. The owner minimums (OWNER_DECISION rows) are never switched off.
create function api.set_legal_review_rule(
  p_committee_kind text, p_trigger_kind text, p_item_type text, p_requirement text, p_effective_from timestamptz,
  p_source_status text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_reason text;
  v_id uuid;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_committee_kind is null or p_committee_kind not in ('INVESTIGATION', 'GRIEVANCE') then
    perform api._fail('INVALID', 'committee_kind');
  end if;
  if p_trigger_kind is null or p_trigger_kind not in ('ITEM_TYPE', 'LEGAL_JUSTIFICATION_FLAG') then
    perform api._fail('INVALID', 'trigger_kind');
  end if;
  if (p_trigger_kind = 'ITEM_TYPE') <> (p_item_type is not null)
     or (p_item_type is not null and p_item_type not in (
           'FINDING', 'DISCIPLINARY_SANCTION', 'CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION', 'EXTERNAL_REFERRAL',
           'NO_VIOLATION', 'CLOSE_WITHOUT_SANCTION', 'LEGAL_ACTION', 'OTHER')) then
    perform api._fail('INVALID', 'item_type');
  end if;
  if p_requirement is null or p_requirement not in ('REQUIRED', 'NOT_REQUIRED') then
    perform api._fail('INVALID', 'requirement');
  end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  -- One rule per key at a time, under a lock on the open rule's key.
  perform 1 from decision.legal_review_rule r
  where r.committee_kind = p_committee_kind and r.trigger_kind = p_trigger_kind
    and r.item_type is not distinct from p_item_type and r.effective_to is null
  for update;
  if p_requirement = 'NOT_REQUIRED' and exists (
       select 1 from decision.legal_review_rule r
       where r.committee_kind = p_committee_kind and r.trigger_kind = p_trigger_kind
         and r.item_type is not distinct from p_item_type and r.source_status = 'OWNER_DECISION'
         and r.requirement = 'REQUIRED') then
    perform api._fail('CONFLICT', 'OWNER_MINIMUM_RULE');
  end if;
  if exists (select 1 from decision.legal_review_rule r
             where r.committee_kind = p_committee_kind and r.trigger_kind = p_trigger_kind
               and r.item_type is not distinct from p_item_type and r.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'LATER_RULE_EXISTS');
  end if;
  update decision.legal_review_rule set effective_to = p_effective_from
   where committee_kind = p_committee_kind and trigger_kind = p_trigger_kind
     and item_type is not distinct from p_item_type and effective_to is null;
  insert into decision.legal_review_rule (committee_kind, trigger_kind, item_type, requirement, effective_from,
                                          source_status, reason, created_by)
  values (p_committee_kind, p_trigger_kind, p_item_type, p_requirement, p_effective_from, p_source_status, v_reason, v_actor)
  returning id into v_id;
  perform audit.record_event('LEGAL_REVIEW_RULE_SET', 'ADMIN', 'SUCCESS', null, 'legal_review_rule', v_id::text, v_reason,
    jsonb_build_object('committee_kind', p_committee_kind, 'trigger_kind', p_trigger_kind, 'item_type', p_item_type,
                       'requirement', p_requirement, 'effective_from', p_effective_from, 'source_status', p_source_status));
  return v_id;
end;
$$;

-- AMB-127: a rule naming several authorities that must all decide (the first is the rule's own authority type).
create function api.set_action_authority_rule(
  p_item_type text, p_authority_types text[], p_effective_from timestamptz, p_source_status text, p_reason text
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
  if p_authority_types is null or cardinality(p_authority_types) not between 1 and 4
     or (select count(distinct x) from unnest(p_authority_types) x) <> cardinality(p_authority_types)
     or exists (select 1 from unnest(p_authority_types) x
                where not exists (select 1 from decision.authority_type a where a.code = x and a.is_active)) then
    perform api._fail('INVALID', 'authority_types');
  end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform 1 from decision.authority_type a where a.code = p_authority_types[1] for update;
  if exists (select 1 from decision.action_authority_rule r
             where r.item_type = p_item_type and r.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'LATER_RULE_EXISTS');
  end if;
  update decision.action_authority_rule set effective_to = p_effective_from
   where item_type = p_item_type and effective_to is null;
  insert into decision.action_authority_rule (item_type, authority_type, effective_from, source_status, reason, created_by)
  values (p_item_type, p_authority_types[1], p_effective_from, p_source_status, v_reason, v_actor)
  returning id into v_id;
  insert into decision.action_authority_rule_joint (rule_id, authority_type)
  select v_id, x from unnest(p_authority_types[2:]) x;
  perform audit.record_event('AUTHORITY_RULE_SET', 'ADMIN', 'SUCCESS', null, 'action_authority_rule', v_id::text, v_reason,
    jsonb_build_object('item_type', p_item_type, 'authority_type', p_authority_types[1],
                       'authority_types', to_jsonb(p_authority_types), 'effective_from', p_effective_from,
                       'source_status', p_source_status));
  return v_id;
end;
$$;

-- DEC-F13, CON-018: which item types have an authority rule in force, with their authorities and source status.
-- NO_RULE types cannot be submitted (fail closed). The FINAL_DISCIPLINARY_AUTHORITY setting (0400) is reported where
-- it disagrees with the rule in force.
create function api.authority_rule_coverage()
returns table (item_type text, rule_id uuid, authority_types text[], source_status text, coverage text,
               setting_disagreement boolean)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform api._actor();
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  return query
  select t.item_type, r.id,
         case when r.id is null then '{}'::text[]
              else array[r.authority_type] || array(select j.authority_type from decision.action_authority_rule_joint j
                                                   where j.rule_id = r.id order by j.authority_type collate "C") end,
         r.source_status,
         case when r.id is null then 'NO_RULE' else r.source_status end,
         t.item_type = 'DISCIPLINARY_SANCTION' and r.id is not null
           and exists (select 1 from config.setting s
                       where s.key = 'FINAL_DISCIPLINARY_AUTHORITY'
                         and (s.status = 'SOURCE_REQUIRED' or s.value is distinct from r.authority_type))
  from unnest(array['FINDING', 'DISCIPLINARY_SANCTION', 'CORRECTIVE_ACTION', 'GOVERNANCE_REMEDIATION',
                    'EXTERNAL_REFERRAL', 'NO_VIOLATION', 'CLOSE_WITHOUT_SANCTION', 'LEGAL_ACTION', 'OTHER']) t(item_type)
  left join decision.action_authority_rule r on r.id = decision.authority_rule_in_force(t.item_type)
  order by t.item_type collate "C";
end;
$$;

-- -----------------------------------------------------------------------------
-- Commands: packages
-- -----------------------------------------------------------------------------
-- 1900's command plus the legal-justification flag (DEC-F12), dependencies and an exclusivity group (AMB-100).
create function api.add_recommendation_item(
  p_package_id uuid, p_item_type text, p_sanction_code text, p_proposed_sanction_text text, p_description text,
  p_subject_ids uuid[], p_allegation_ids uuid[], p_requires_legal_justification boolean, p_depends_on_item_ids uuid[],
  p_exclusivity_group text
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
  v_depends uuid[] := coalesce(p_depends_on_item_ids, '{}');
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
  -- AMB-100: dependencies are active items of the same package; a group is a code.
  if (select count(distinct x) from unnest(v_depends) x) <> cardinality(v_depends)
     or exists (select 1 from unnest(v_depends) x
                where not exists (select 1 from decision.recommendation_item i
                                  where i.id = x and i.package_id = v_p.id and i.status = 'ACTIVE')) then
    perform api._fail('INVALID', 'depends_on_item_ids');
  end if;
  if p_exclusivity_group is not null and p_exclusivity_group !~ '^[A-Z][A-Z0-9_]{2,59}$' then
    perform api._fail('INVALID', 'exclusivity_group');
  end if;
  -- Q89: no subject and no allegation means the whole case.
  v_case_wide := cardinality(v_subjects) = 0 and cardinality(v_allegations) = 0;

  insert into decision.recommendation_item (package_id, case_id, item_type, sanction_code, proposed_sanction_text,
                                            verification_status, description, case_wide, added_by,
                                            requires_legal_justification, exclusivity_group)
  values (v_p.id, v_p.case_id, p_item_type, p_sanction_code,
          case when p_proposed_sanction_text is not null then api._require_text(p_proposed_sanction_text, 'proposed_sanction_text', 3, 500) end,
          case when p_item_type <> 'DISCIPLINARY_SANCTION' then 'NOT_APPLICABLE'
               when p_sanction_code is not null then 'CATALOGUE' else 'PROPOSED_UNVERIFIED' end,
          api._require_text(p_description, 'description', 10, 4000), v_case_wide, v_actor,
          coalesce(p_requires_legal_justification, false), p_exclusivity_group)
  returning id into v_id;
  insert into decision.recommendation_item_subject (item_id, subject_id) select v_id, x from unnest(v_subjects) x;
  insert into decision.recommendation_item_allegation (item_id, allegation_id) select v_id, x from unnest(v_allegations) x;
  insert into decision.recommendation_item_dependency (item_id, depends_on) select v_id, x from unnest(v_depends) x;
  update decision.recommendation_package set updated_at = now(), row_version = row_version + 1 where id = v_p.id;
  perform audit.record_event('RECOMMENDATION_ITEM_ADDED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'recommendation_item', v_id::text,
    null, jsonb_build_object('package_id', v_p.id, 'item_type', p_item_type, 'sanction_code', p_sanction_code,
                             'proposed_unverified', p_proposed_sanction_text is not null, 'case_wide', v_case_wide,
                             'subjects', cardinality(v_subjects), 'allegations', cardinality(v_allegations),
                             'requires_legal_justification', coalesce(p_requires_legal_justification, false),
                             'depends_on', cardinality(v_depends), 'exclusivity_group', p_exclusivity_group));
  return v_id;
end;
$$;

-- The 1900 signature: no justification flag, no dependency, no group.
create or replace function api.add_recommendation_item(
  p_package_id uuid, p_item_type text, p_sanction_code text, p_proposed_sanction_text text, p_description text,
  p_subject_ids uuid[], p_allegation_ids uuid[]
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  return api.add_recommendation_item(p_package_id, p_item_type, p_sanction_code, p_proposed_sanction_text, p_description,
                                     p_subject_ids, p_allegation_ids, false, null::uuid[], null::text);
end;
$$;

-- Q58, Q70 as in 1900. On adoption (2030): every catalogue code must be in force (AMB-101), a sanction needs a defence
-- notice to each subject covering its allegations when the proceeding's rule snapshot says so (AMB-026; a snapshot
-- from before the option existed keeps the 1900 behaviour), and the adopted items are snapshotted with their
-- catalogue version.
create or replace function api.record_package_adoption(p_package_id uuid)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_p decision.recommendation_package;
  v_status text;
  v_approved int;
  v_notice_rule boolean;
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

  if v_status = 'ADOPTED' then
    if exists (select 1 from decision.recommendation_item i
               where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
                 and i.sanction_code is not null and decision.catalogue_version_in_force(i.sanction_code) is null) then
      perform api._fail('CONFLICT', 'SANCTION_NOT_IN_FORCE');
    end if;
    select coalesce((cp.rule_snapshot ->> 'sanction_requires_defence_notice')::boolean, false) into v_notice_rule
    from committee.committee_proceeding cp where cp.id = v_p.committee_proceeding_id;
    -- Each subject of an adopted sanction, on each allegation of the item against that subject (all the subject's
    -- allegations when the item names none), has a defence notice; a subject with no allegation has at least one.
    if v_notice_rule and exists (
      select 1
      from decision.recommendation_item i
      join decision.recommendation_item_subject rs on rs.item_id = i.id
      where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
        and i.item_type = 'DISCIPLINARY_SANCTION'
        and (exists (select 1 from case_mgmt.allegation a
                     where a.subject_id = rs.subject_id and a.status <> 'WITHDRAWN'
                       and (a.id in (select ra.allegation_id from decision.recommendation_item_allegation ra where ra.item_id = i.id)
                            or not exists (select 1 from decision.recommendation_item_allegation ra where ra.item_id = i.id))
                       and not exists (select 1 from grievance.defence_notice n
                                       join grievance.defence_notice_item ni on ni.notice_id = n.id
                                       where n.subject_id = rs.subject_id and n.kind = 'DEFENCE' and n.status <> 'WITHDRAWN'
                                         and ni.allegation_id = a.id))
             or not exists (select 1 from grievance.defence_notice n
                            where n.subject_id = rs.subject_id and n.kind = 'DEFENCE' and n.status <> 'WITHDRAWN'))
    ) then
      perform api._fail('CONFLICT', 'DEFENCE_NOTICE_REQUIRED');
    end if;
    insert into decision.item_adoption (item_id, package_id, package_round, catalogue_version_id, snapshot)
    select i.id, v_p.id, v_p.round_no, v.id,
           decision.item_snapshot(i.id) || decision.item_snapshot_extra(i.id)
           || jsonb_build_object('catalogue_version_id', v.id, 'catalogue_version_no', v.version_no,
                                 'catalogue_source_status', v.source_status,
                                 'catalogue_legal_basis', case when v.source_status = 'APPROVED' then v.legal_basis end,
                                 'catalogue_authority_type', v.authority_type,
                                 'catalogue_legal_review_requirement', v.legal_review_requirement)
    from decision.recommendation_item i
    left join decision.sanction_catalogue_version v on v.id = decision.catalogue_version_in_force(i.sanction_code)
    where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED';
  end if;

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

-- AMB-108: before submission the secretary returns an adopted package to the committee; the next vote is a new
-- round. After submission only the authority can return it.
create function api.return_package_to_committee(p_package_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_id uuid;
begin
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status <> 'ADOPTED' then perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED'); end if;
  insert into decision.package_return (package_id, case_id, package_round, reason, returned_by)
  values (v_p.id, v_p.case_id, v_p.round_no, api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_id;
  update decision.recommendation_package
     set status = 'DRAFT', adopted_at = null, updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  -- The reason stays in its row; the ledger gets ids only.
  perform audit.record_event('RECOMMENDATION_PACKAGE_RETURNED_TO_COMMITTEE', 'BUSINESS', 'SUCCESS', v_p.case_id,
    'recommendation_package', v_p.id::text, null, jsonb_build_object('round_no', v_p.round_no, 'package_return_id', v_id));
  return v_id;
end;
$$;

-- AMB-100, AMB-051, Q87, DEC-F11: what the committee should see on each active item of a package. Read-only.
create function api.recommendation_item_flags(p_package_id uuid)
returns table (item_id uuid, flag text)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform api._actor();
  if p_package_id is null or not authz.can_view_recommendation_package(p_package_id) then perform api._fail('NOT_FOUND'); end if;
  return query
  select f.item_id, f.flag from (
    select i.id as item_id, 'PROPOSED_UNVERIFIED'::text as flag
    from decision.recommendation_item i
    where i.package_id = p_package_id and i.status = 'ACTIVE' and i.verification_status = 'PROPOSED_UNVERIFIED'
    union all
    select i.id, 'SANCTION_SOURCE_REQUIRED'
    from decision.recommendation_item i
    where i.package_id = p_package_id and i.status = 'ACTIVE' and i.sanction_code is not null
      and coalesce((select v.source_status from decision.sanction_catalogue_version v
                    where v.id = decision.item_catalogue_version(i.id)), 'SOURCE_REQUIRED') <> 'APPROVED'
    union all
    select i.id, 'TAINTED_BY_CONFLICT'
    from decision.recommendation_item i
    where i.package_id = p_package_id and i.status = 'ACTIVE' and decision.item_tainted(i.id)
    union all
    -- A dependency withdrawn, rejected by the committee, or not approved by an authority in the current round.
    select i.id, 'DEPENDENCY_NOT_APPROVED'
    from decision.recommendation_item i
    where i.package_id = p_package_id and i.status = 'ACTIVE'
      and exists (select 1 from decision.recommendation_item_dependency dep
                  join decision.recommendation_item o on o.id = dep.depends_on
                  join decision.recommendation_package p on p.id = o.package_id
                  where dep.item_id = i.id
                    and (o.status = 'WITHDRAWN' or o.committee_result = 'REJECTED'
                         or exists (select 1 from decision.authority_decision d
                                    join decision.authority_decision_scope sc on sc.decision_id = d.id
                                    where d.package_id = p.id and d.package_round = p.round_no and sc.item_id = o.id
                                      and sc.item_outcome not in ('APPROVED', 'MODIFIED'))))
    union all
    select i.id, 'EXCLUSIVITY_CONFLICT'
    from decision.recommendation_item i
    where i.package_id = p_package_id and i.status = 'ACTIVE' and i.exclusivity_group is not null
      and coalesce(i.committee_result, 'APPROVED') = 'APPROVED'
      and exists (select 1 from decision.recommendation_item o
                  where o.package_id = i.package_id and o.id <> i.id and o.status = 'ACTIVE'
                    and o.exclusivity_group = i.exclusivity_group and coalesce(o.committee_result, 'APPROVED') = 'APPROVED')
  ) f
  order by f.item_id, f.flag collate "C";
end;
$$;

-- -----------------------------------------------------------------------------
-- Commands: legal review
-- -----------------------------------------------------------------------------
-- Q75 as in 1900. 2030: a tainted package waits (AMB-051); on a restricted case the approval is for this round and
-- names everything the secretary sends (DEC-F20, AMB-120).
create or replace function api.request_legal_review(
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
  v_approval decision.restricted_legal_review_approval;
begin
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status <> 'ADOPTED' then perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED'); end if;
  if exists (select 1 from decision.legal_review_request r
             where r.package_id = v_p.id and r.package_round = v_p.round_no and r.status = 'ASSIGNED') then
    perform api._fail('CONFLICT', 'LEGAL_REVIEW_OPEN');
  end if;
  if exists (select 1 from decision.recommendation_item i
             where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
               and decision.item_tainted(i.id)) then
    perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT');
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
  -- AGENT-09 W2, DEC-F20: a restricted case needs its authority's unused approval for this round naming this reviewer,
  -- and the approval must name every finding and minutes sent.
  if exists (select 1 from case_mgmt.case_record c where c.id = v_p.case_id and c.is_restricted) then
    select a.* into v_approval from decision.restricted_legal_review_approval a
    where a.package_id = v_p.id and a.legal_review_request_id is null and a.reviewer_id = p_assigned_to
      and a.package_round = v_p.round_no
    for update;
    if v_approval.id is null then perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_REQUIRED'); end if;
    if not (v_findings <@ v_approval.finding_ids) or not (v_minutes <@ v_approval.minutes_ids) then
      perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_SCOPE_EXCEEDED');
    end if;
  end if;

  insert into decision.legal_review_request (package_id, case_id, package_round, basis, assigned_to, reason, requested_by)
  values (v_p.id, v_p.case_id, v_p.round_no,
          case when decision.legal_review_required(v_p.id) then 'RULE' else 'SECRETARY_ELECTED' end,
          p_assigned_to, api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_req;
  if v_approval.id is not null then
    update decision.restricted_legal_review_approval set legal_review_request_id = v_req, used_at = now()
     where id = v_approval.id;
  end if;
  insert into decision.packet (case_id, committee_proceeding_id, package_id, purpose, legal_review_request_id,
                               classification, created_by)
  values (v_p.case_id, v_p.committee_proceeding_id, v_p.id, 'LEGAL_REVIEW', v_req, v_classification, v_actor)
  returning id into v_packet;
  insert into decision.packet_item (packet_id, position, item_kind, source_id, snapshot)
  select v_packet, row_number() over (order by k, at, id), kind, id, snap
  from (
    select 1 as k, i.added_at as at, i.id, 'RECOMMENDATION_ITEM' as kind,
           decision.item_snapshot(i.id) || decision.item_snapshot_extra(i.id) as snap
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
                             'packet_id', v_packet, 'restricted_approval_id', v_approval.id));
  perform audit.record_event('PACKET_CREATED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'packet', v_packet::text, null,
    jsonb_build_object('purpose', 'LEGAL_REVIEW', 'items', v_items, 'findings', cardinality(v_findings),
                       'minutes', cardinality(v_minutes)));
  return v_req;
end;
$$;

-- DEC-F20: the case owner, eligible as a Restricted Case Authority for the case classification, approves one legal
-- review of the adopted package in its current round by a named reviewer, with the findings and minutes the packet
-- may carry. Single use; an unused approval of an earlier round is never usable.
create function api.approve_restricted_legal_review(
  p_package_id uuid, p_reviewer_id uuid, p_finding_ids uuid[], p_minutes_ids uuid[], p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_case case_mgmt.case_record;
  v_findings uuid[] := coalesce(p_finding_ids, '{}');
  v_minutes uuid[] := coalesce(p_minutes_ids, '{}');
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
  if exists (select 1 from decision.restricted_legal_review_approval a
             where a.package_id = v_p.id and a.legal_review_request_id is null and a.package_round = v_p.round_no) then
    perform api._fail('CONFLICT', 'APPROVAL_ALREADY_PENDING');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  insert into decision.restricted_legal_review_approval (case_id, package_id, reviewer_id, approved_by, reason,
                                                         package_round, finding_ids, minutes_ids)
  values (v_p.case_id, v_p.id, p_reviewer_id, v_actor, v_reason, v_p.round_no, v_findings, v_minutes)
  returning id into v_id;
  perform audit.record_event('RESTRICTED_LEGAL_REVIEW_APPROVED', 'BUSINESS', 'SUCCESS', v_p.case_id,
    'restricted_legal_review_approval', v_id::text, v_reason,
    jsonb_build_object('package_id', v_p.id, 'reviewer_id', p_reviewer_id, 'classification', v_case.classification,
                       'round_no', v_p.round_no, 'findings', cardinality(v_findings), 'minutes', cardinality(v_minutes)));
  return v_id;
end;
$$;

-- The 1900 signature: an approval for the adopted items only.
create or replace function api.approve_restricted_legal_review(p_package_id uuid, p_reviewer_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  return api.approve_restricted_legal_review(p_package_id, p_reviewer_id, '{}'::uuid[], '{}'::uuid[], p_reason);
end;
$$;

-- Q77 as in 1900; a cancelled request is no longer the reviewer's (AMB-115).
create or replace function api.give_legal_opinion(p_request_id uuid, p_opinion text, p_opinion_text text)
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
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_case_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_case_gate(v_actor, v_r.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  perform 1 from decision.recommendation_package p where p.id = v_r.package_id for update;
  select * into v_r from decision.legal_review_request r where r.id = p_request_id for update;
  if v_r.status = 'CANCELLED' then perform api._fail('CONFLICT', 'REQUEST_CANCELLED'); end if;
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

-- AMB-115: the secretary cancels an open request (to replace the reviewer, or to return the package). The reviewer's
-- packet access ends at once; a replacement is a new request (and on a restricted case a new approval).
create function api.cancel_legal_review_request(p_request_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r decision.legal_review_request;
  v_p decision.recommendation_package;
  v_id uuid;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_case_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if not authz.can_manage_recommendation_package(v_r.package_id) then perform api._fail('FORBIDDEN'); end if;
  v_p := decision.lock_managed_package(v_r.package_id);
  select * into v_r from decision.legal_review_request r where r.id = p_request_id for update;
  if v_r.status <> 'ASSIGNED' then perform api._fail('CONFLICT', 'LEGAL_REVIEW_NOT_OPEN'); end if;
  insert into decision.legal_review_cancellation (request_id, package_id, case_id, reason, cancelled_by)
  values (v_r.id, v_r.package_id, v_r.case_id, api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_id;
  update decision.legal_review_request set status = 'CANCELLED' where id = v_r.id;
  if v_p.status = 'IN_LEGAL_REVIEW' then
    update decision.recommendation_package set status = 'ADOPTED', updated_at = now(), row_version = row_version + 1
     where id = v_p.id;
  end if;
  perform audit.record_event('LEGAL_REVIEW_CANCELLED', 'BUSINESS', 'SUCCESS', v_r.case_id, 'legal_review_request',
    v_r.id::text, null, jsonb_build_object('package_id', v_r.package_id, 'round_no', v_r.package_round,
                                           'assigned_to', v_r.assigned_to, 'cancellation_id', v_id));
  return v_id;
end;
$$;

-- AMB-117: no edit or withdrawal of an opinion. Before submission, in the same round, the reviewer may give a
-- superseding opinion; both are kept and both travel to the authority. CONFLICTS returns the package.
create function api.give_superseding_legal_opinion(p_request_id uuid, p_opinion text, p_opinion_text text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r decision.legal_review_request;
  v_p decision.recommendation_package;
  v_revision int;
  v_status text;
  v_id uuid;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_case_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_case_gate(v_actor, v_r.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  -- The reviewer's purpose is still open: they can still read the request's packet (AMB-119).
  if not exists (select 1 from decision.packet k where k.legal_review_request_id = v_r.id and authz.can_view_packet(k.id)) then
    perform api._fail('NOT_FOUND');
  end if;
  select * into v_p from decision.recommendation_package p where p.id = v_r.package_id for update;
  select * into v_r from decision.legal_review_request r where r.id = p_request_id for update;
  if v_r.status <> 'OPINION_GIVEN' then perform api._fail('CONFLICT', 'OPINION_NOT_GIVEN'); end if;
  if v_p.status <> 'ADOPTED' or v_p.round_no <> v_r.package_round then
    perform api._fail('CONFLICT', 'PACKAGE_NOT_ADOPTED');
  end if;
  if p_opinion is null or p_opinion not in ('CONCURS', 'CONCURS_WITH_COMMENTS', 'CONFLICTS') then
    perform api._fail('INVALID', 'opinion');
  end if;
  select coalesce(max(x.revision_no), 1) + 1 into v_revision
  from decision.legal_opinion_revision x where x.request_id = v_r.id;
  insert into decision.legal_opinion_revision (request_id, package_id, case_id, package_round, revision_no, opinion,
                                               opinion_text, given_by)
  values (v_r.id, v_r.package_id, v_r.case_id, v_r.package_round, v_revision, p_opinion,
          case when p_opinion <> 'CONCURS' or p_opinion_text is not null
               then api._require_text(p_opinion_text, 'opinion_text', 10, 8000) end, v_actor)
  returning id into v_id;
  v_status := case when p_opinion = 'CONFLICTS' then 'RETURNED_BY_LEGAL' else 'ADOPTED' end;
  if v_status <> v_p.status then
    update decision.recommendation_package set status = v_status, updated_at = now(), row_version = row_version + 1
     where id = v_p.id;
  end if;
  perform audit.record_event('LEGAL_OPINION_SUPERSEDED', 'BUSINESS', 'SUCCESS', v_r.case_id, 'legal_opinion_revision',
    v_id::text, null, jsonb_build_object('request_id', v_r.id, 'package_id', v_r.package_id, 'revision_no', v_revision,
                                         'opinion', p_opinion, 'package_status', v_status));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Commands: authority (ADR-023)
-- -----------------------------------------------------------------------------
-- Writes the authority requirements of a submission: for each adopted item, the rule in force now and each authority
-- it names. Refuses while an adopted item type has no rule (CON-018, AMB-135: fail closed).
create function decision.write_authority_requirements(p_submission_id uuid, p_package_id uuid)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  if exists (select 1 from decision.recommendation_item i
             where i.package_id = p_package_id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
               and decision.authority_rule_in_force(i.item_type) is null) then
    perform api._fail('CONFLICT', 'AUTHORITY_RULE_MISSING');
  end if;
  insert into decision.authority_requirement (submission_id, item_id, authority_type, rule_id, rule_source_status)
  select p_submission_id, i.id, t.authority_type, r.id, r.source_status
  from decision.recommendation_item i
  join decision.action_authority_rule r on r.id = decision.authority_rule_in_force(i.item_type)
  cross join lateral (select r.authority_type
                      union
                      select j.authority_type from decision.action_authority_rule_joint j where j.rule_id = r.id) t
  where i.package_id = p_package_id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Q77 as in 1900. 2030: a tainted package waits (AMB-051); every adopted item type needs an authority rule (AMB-135);
-- the rules, their authorities and source status are snapshotted on the submission and in the packet (AMB-132);
-- superseding opinions travel with the first ones (AMB-117).
create or replace function api.submit_to_authority(p_package_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_packet uuid;
  v_submission uuid;
  v_requirements int;
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
  if exists (select 1 from decision.recommendation_item i
             where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
               and decision.item_tainted(i.id)) then
    perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT');
  end if;
  if exists (select 1 from decision.recommendation_item i
             where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
               and decision.authority_rule_in_force(i.item_type) is null) then
    perform api._fail('CONFLICT', 'AUTHORITY_RULE_MISSING');
  end if;
  insert into decision.packet (case_id, committee_proceeding_id, package_id, purpose, classification, created_by)
  select v_p.case_id, v_p.committee_proceeding_id, v_p.id, 'AUTHORITY_DECISION', c.classification, v_actor
  from case_mgmt.case_record c where c.id = v_p.case_id
  returning id into v_packet;
  insert into decision.authority_submission (package_id, case_id, package_round, packet_id, basis, submitted_by)
  values (v_p.id, v_p.case_id, v_p.round_no, v_packet, 'SUBMISSION', v_actor)
  returning id into v_submission;
  v_requirements := decision.write_authority_requirements(v_submission, v_p.id);
  insert into decision.packet_item (packet_id, position, item_kind, source_id, snapshot)
  select v_packet, row_number() over (order by k, at, sub, id), kind, id, snap
  from (
    select 1 as k, i.added_at as at, 0 as sub, i.id, 'RECOMMENDATION_ITEM' as kind,
           decision.item_snapshot(i.id) || decision.item_snapshot_extra(i.id)
           || jsonb_build_object(
                'required_authority', r.authority_type,
                'required_authorities', (select jsonb_agg(q.authority_type order by q.authority_type collate "C")
                                         from decision.authority_requirement q
                                         where q.submission_id = v_submission and q.item_id = i.id),
                'authority_rule_id', r.id, 'authority_rule_source_status', r.source_status) as snap
    from decision.recommendation_item i
    join decision.action_authority_rule r on r.id = decision.authority_rule_in_force(i.item_type)
    where i.package_id = v_p.id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
    union all
    select 2, r.opinion_at, 1, r.id, 'LEGAL_OPINION',
           jsonb_build_object('opinion', r.opinion, 'opinion_text', r.opinion_text, 'package_round', r.package_round,
                              'basis', r.basis, 'revision_no', 1,
                              'superseded', exists (select 1 from decision.legal_opinion_revision x where x.request_id = r.id))
    from decision.legal_review_request r where r.package_id = v_p.id and r.status = 'OPINION_GIVEN'
    union all
    select 2, x.given_at, x.revision_no, x.id, 'LEGAL_OPINION',
           jsonb_build_object('opinion', x.opinion, 'opinion_text', x.opinion_text, 'package_round', x.package_round,
                              'request_id', x.request_id, 'revision_no', x.revision_no,
                              'superseded', exists (select 1 from decision.legal_opinion_revision y
                                                    where y.request_id = x.request_id and y.revision_no > x.revision_no))
    from decision.legal_opinion_revision x where x.package_id = v_p.id
  ) s;
  get diagnostics v_items = row_count;
  update decision.recommendation_package set status = 'AWAITING_AUTHORITY', updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event('RECOMMENDATION_PACKAGE_SUBMITTED_TO_AUTHORITY', 'BUSINESS', 'SUCCESS', v_p.case_id,
    'recommendation_package', v_p.id::text, null,
    jsonb_build_object('round_no', v_p.round_no, 'packet_id', v_packet, 'submission_id', v_submission,
                       'authority_requirements', v_requirements));
  perform audit.record_event('PACKET_CREATED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'packet', v_packet::text, null,
    jsonb_build_object('purpose', 'AUTHORITY_DECISION', 'items', v_items));
  return v_packet;
end;
$$;

-- Q80–Q83 as in 1900, per authority (AMB-126, AMB-127): one decision per authority type covers the items its
-- submission requires of that authority. The package is DECIDED once every requirement of the round is decided;
-- joint authorities that disagree on an item, or RETURN_TO_COMMITTEE, return it. The decision records the delegation
-- reference (AMB-125), whether its source is signed (AMB-129: unsigned only with the secretary's attestation), further
-- source documents beside the primary one (AMB-130) and structured conditions (AMB-133). decided_at is the authority's
-- date and may not fall on a day before adoption (AMB-131, Asia/Riyadh).
create function api.record_authority_decision(
  p_package_id uuid, p_authority_type text, p_outcome text, p_decided_at timestamptz, p_decided_by_label text,
  p_source_document_reference text, p_item_outcomes jsonb, p_reason text, p_delegation_reference text,
  p_source_signature text, p_unsigned_attestation text, p_additional_source_references text[], p_conditions jsonb
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p decision.recommendation_package;
  v_submission uuid;
  v_backfilled boolean := false;
  v_required uuid[];
  v_scope uuid[];
  v_id uuid;
  v_status text;
  v_complete boolean;
  v_disagreement boolean;
  v_sources text[] := coalesce(p_additional_source_references, '{}');
begin
  v_p := decision.lock_managed_package(p_package_id);
  if v_p.status <> 'AWAITING_AUTHORITY' then perform api._fail('CONFLICT', 'PACKAGE_NOT_AWAITING_AUTHORITY'); end if;
  if not exists (select 1 from decision.authority_type a where a.code = p_authority_type and a.is_active) then
    perform api._fail('INVALID', 'authority_type');
  end if;
  -- A package submitted before 2030 is snapshotted now, under the rules in force.
  select x.id into v_submission from decision.authority_submission x
  where x.package_id = v_p.id and x.package_round = v_p.round_no;
  if v_submission is null then
    insert into decision.authority_submission (package_id, case_id, package_round, packet_id, basis, submitted_by)
    values (v_p.id, v_p.case_id, v_p.round_no,
            (select k.id from decision.packet k where k.package_id = v_p.id and k.purpose = 'AUTHORITY_DECISION'
             order by k.created_at desc, k.id limit 1), 'BACKFILL', v_actor)
    returning id into v_submission;
    perform decision.write_authority_requirements(v_submission, v_p.id);
    v_backfilled := true;
  end if;
  -- The authority must be one the submission requires, for items it has not decided yet.
  select array_agg(q.item_id order by q.item_id) into v_required from decision.authority_requirement q
  where q.submission_id = v_submission and q.authority_type = p_authority_type;
  if v_required is null then perform api._fail('CONFLICT', 'AUTHORITY_TYPE_MISMATCH'); end if;
  select array_agg(x order by x) into v_scope from unnest(v_required) x
  where not exists (select 1 from decision.authority_decision d
                    join decision.authority_decision_scope sc on sc.decision_id = d.id
                    where d.package_id = v_p.id and d.package_round = v_p.round_no
                      and d.authority_type = p_authority_type and sc.item_id = x);
  if v_scope is null then perform api._fail('CONFLICT', 'AUTHORITY_ALREADY_DECIDED'); end if;
  if p_outcome is null or p_outcome not in (
       'APPROVE_AS_RECOMMENDED', 'MODIFY', 'REJECT', 'RETURN_TO_COMMITTEE', 'APPROVE_PARTIALLY', 'OTHER') then
    perform api._fail('INVALID', 'outcome');
  end if;
  if p_decided_at is null or p_decided_at > now()
     or (v_p.adopted_at is not null
         and (p_decided_at at time zone 'Asia/Riyadh')::date < (v_p.adopted_at at time zone 'Asia/Riyadh')::date) then
    perform api._fail('INVALID', 'decided_at');
  end if;
  -- N15: no source document, no decision.
  if p_source_document_reference is null or length(trim(p_source_document_reference)) < 3 then
    perform api._fail('INVALID', 'source_document_reference');
  end if;
  if p_source_signature is not null and p_source_signature not in ('SIGNED', 'UNSIGNED') then
    perform api._fail('INVALID', 'source_signature');
  end if;
  if (coalesce(p_source_signature, '') = 'UNSIGNED') <> (p_unsigned_attestation is not null) then
    perform api._fail('INVALID', 'unsigned_attestation');
  end if;
  if p_delegation_reference is not null then
    perform api._require_text(p_delegation_reference, 'delegation_reference', 3, 300);
  end if;
  if cardinality(v_sources) > 10
     or exists (select 1 from unnest(v_sources) x where x is null or length(btrim(x)) not between 3 and 300
                                                    or btrim(x) = btrim(p_source_document_reference))
     or (select count(distinct btrim(x)) from unnest(v_sources) x) <> cardinality(v_sources) then
    perform api._fail('INVALID', 'additional_source_references');
  end if;
  if p_outcome in ('APPROVE_PARTIALLY', 'MODIFY') then
    if p_item_outcomes is null or jsonb_typeof(p_item_outcomes) <> 'array'
       or jsonb_array_length(p_item_outcomes) <> cardinality(v_scope)
       or exists (select 1 from jsonb_array_elements(p_item_outcomes) e
                  where jsonb_typeof(e) <> 'object' or (e ->> 'item_id') is null
                     or not pg_input_is_valid(e ->> 'item_id', 'uuid')
                     or not ((e ->> 'item_id')::uuid = any (v_scope))
                     or coalesce(e ->> 'outcome', '') not in ('APPROVED', 'REJECTED', 'MODIFIED')
                     or ((e ->> 'outcome') = 'MODIFIED') <> (e ->> 'modification' is not null))
       or (select count(distinct e ->> 'item_id') from jsonb_array_elements(p_item_outcomes) e) <> cardinality(v_scope) then
      perform api._fail('INVALID', 'item_outcomes');
    end if;
  elsif p_item_outcomes is not null then
    perform api._fail('INVALID', 'item_outcomes');
  end if;
  if p_conditions is not null then
    if p_outcome not in ('APPROVE_AS_RECOMMENDED', 'APPROVE_PARTIALLY', 'MODIFY')
       or jsonb_typeof(p_conditions) <> 'array' or jsonb_array_length(p_conditions) not between 1 and 20
       or exists (select 1 from jsonb_array_elements(p_conditions) e
                  where jsonb_typeof(e) <> 'object'
                     or coalesce(e ->> 'kind', '') not in ('CORRECTIVE_ACTION', 'FOLLOW_UP_TASK', 'FREE_TEXT')
                     or length(btrim(coalesce(e ->> 'text', ''))) not between 5 and 2000
                     or (e ->> 'item_id' is not null
                         and (not pg_input_is_valid(e ->> 'item_id', 'uuid') or not ((e ->> 'item_id')::uuid = any (v_scope))))
                     or (e ->> 'due_date' is not null and not pg_input_is_valid(e ->> 'due_date', 'date'))) then
      perform api._fail('INVALID', 'conditions');
    end if;
  end if;
  -- AMB-051: a tainted item is only returned to the committee.
  if p_outcome <> 'RETURN_TO_COMMITTEE' and exists (select 1 from unnest(v_scope) x where decision.item_tainted(x)) then
    perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT');
  end if;

  insert into decision.authority_decision (package_id, case_id, package_round, authority_type, outcome, decided_at,
                                           decided_by_label, source_document_reference, reason, recorded_by,
                                           submission_id, delegation_reference, source_signature, unsigned_attestation)
  values (v_p.id, v_p.case_id, v_p.round_no, p_authority_type, p_outcome, p_decided_at,
          api._require_text(p_decided_by_label, 'decided_by_label', 3, 200),
          api._require_text(p_source_document_reference, 'source_document_reference', 3, 300),
          case when p_reason is not null then api._require_text(p_reason, 'reason', 5, 4000) end, v_actor,
          v_submission, btrim(p_delegation_reference), p_source_signature,
          case when p_unsigned_attestation is not null
               then api._require_text(p_unsigned_attestation, 'unsigned_attestation', 10, 2000) end)
  returning id into v_id;
  if p_item_outcomes is not null then
    insert into decision.authority_item_decision (decision_id, item_id, outcome, modification)
    select v_id, (e ->> 'item_id')::uuid, e ->> 'outcome',
           case when e ->> 'modification' is not null then api._require_text(e ->> 'modification', 'modification', 5, 4000) end
    from jsonb_array_elements(p_item_outcomes) e;
  end if;
  insert into decision.authority_decision_scope (decision_id, item_id, authority_type, rule_id, item_outcome)
  select v_id, q.item_id, q.authority_type, q.rule_id,
         case p_outcome
           when 'APPROVE_AS_RECOMMENDED' then 'APPROVED'
           when 'REJECT' then 'REJECTED'
           when 'RETURN_TO_COMMITTEE' then 'RETURNED'
           when 'OTHER' then 'OTHER'
           else (select e ->> 'outcome' from jsonb_array_elements(p_item_outcomes) e where (e ->> 'item_id')::uuid = q.item_id)
         end
  from decision.authority_requirement q
  where q.submission_id = v_submission and q.authority_type = p_authority_type and q.item_id = any (v_scope);
  insert into decision.authority_decision_source (decision_id, position, reference, is_primary)
  select v_id, 1, btrim(p_source_document_reference), true
  union all
  select v_id, 1 + o, btrim(x), false from unnest(v_sources) with ordinality u(x, o);
  if p_conditions is not null then
    insert into decision.authority_decision_condition (decision_id, position, kind, item_id, condition_text, due_date)
    select v_id, o, e ->> 'kind', (e ->> 'item_id')::uuid, btrim(e ->> 'text'), (e ->> 'due_date')::date
    from jsonb_array_elements(p_conditions) with ordinality u(e, o);
  end if;
  -- AMB-100: an authority approves at most one item of an exclusivity group.
  if exists (select 1 from decision.recommendation_item i
             where i.package_id = v_p.id and i.status = 'ACTIVE' and i.exclusivity_group is not null
               and exists (select 1 from decision.authority_decision d
                           join decision.authority_decision_scope sc on sc.decision_id = d.id
                           where d.package_id = v_p.id and d.package_round = v_p.round_no and sc.item_id = i.id
                             and sc.item_outcome in ('APPROVED', 'MODIFIED'))
             group by i.exclusivity_group having count(*) > 1) then
    perform api._fail('CONFLICT', 'EXCLUSIVITY_GROUP_VIOLATION');
  end if;

  v_complete := not exists (
    select 1 from decision.authority_requirement q
    where q.submission_id = v_submission
      and not exists (select 1 from decision.authority_decision d
                      join decision.authority_decision_scope sc on sc.decision_id = d.id
                      where d.package_id = v_p.id and d.package_round = v_p.round_no
                        and d.authority_type = q.authority_type and sc.item_id = q.item_id));
  v_disagreement := exists (
    select 1 from decision.authority_decision d
    join decision.authority_decision_scope sc on sc.decision_id = d.id
    where d.package_id = v_p.id and d.package_round = v_p.round_no
    group by sc.item_id having count(distinct sc.item_outcome) > 1);
  v_status := case when p_outcome = 'RETURN_TO_COMMITTEE' then 'RETURNED_BY_AUTHORITY'
                   when v_complete and v_disagreement then 'RETURNED_BY_AUTHORITY'
                   when v_complete then 'DECIDED'
                   else 'AWAITING_AUTHORITY' end;
  update decision.recommendation_package
     set status = v_status, decided_at = case when v_status = 'DECIDED' then now() end,
         updated_at = now(), row_version = row_version + 1
   where id = v_p.id;
  perform audit.record_event('AUTHORITY_DECISION_RECORDED', 'BUSINESS', 'SUCCESS', v_p.case_id, 'authority_decision', v_id::text,
    null, jsonb_build_object('package_id', v_p.id, 'round_no', v_p.round_no, 'authority_type', p_authority_type,
                             'outcome', p_outcome, 'package_status', v_status,
                             'item_outcomes', coalesce(jsonb_array_length(p_item_outcomes), 0),
                             'scope_items', cardinality(v_scope), 'submission_id', v_submission,
                             'submission_backfilled', v_backfilled, 'source_signature', p_source_signature,
                             'has_delegation_reference', p_delegation_reference is not null,
                             'sources', 1 + cardinality(v_sources),
                             'conditions', coalesce(jsonb_array_length(p_conditions), 0)));
  return v_id;
end;
$$;

-- The 1900 signature: no delegation reference, signature, further sources or conditions.
create or replace function api.record_authority_decision(
  p_package_id uuid, p_authority_type text, p_outcome text, p_decided_at timestamptz, p_decided_by_label text,
  p_source_document_reference text, p_item_outcomes jsonb, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  return api.record_authority_decision(p_package_id, p_authority_type, p_outcome, p_decided_at, p_decided_by_label,
                                       p_source_document_reference, p_item_outcomes, p_reason, null::text, null::text,
                                       null::text, null::text[], null::jsonb);
end;
$$;

grant execute on function
  api.set_sanction_catalogue_entry(text, text, text, text, text, text[], text, timestamptz, text, text, text),
  api.set_legal_review_rule(text, text, text, text, timestamptz, text, text),
  api.set_action_authority_rule(text, text[], timestamptz, text, text),
  api.authority_rule_coverage(),
  api.add_recommendation_item(uuid, text, text, text, text, uuid[], uuid[], boolean, uuid[], text),
  api.return_package_to_committee(uuid, text),
  api.recommendation_item_flags(uuid),
  api.approve_restricted_legal_review(uuid, uuid, uuid[], uuid[], text),
  api.cancel_legal_review_request(uuid, text),
  api.give_superseding_legal_opinion(uuid, text, text),
  api.record_authority_decision(uuid, text, text, timestamptz, text, text, jsonb, text, text, text, text, text[], jsonb)
to authenticated;

-- -----------------------------------------------------------------------------
-- The form and status catalogue (migration 1970) follows the schema
-- -----------------------------------------------------------------------------
insert into config.status_dimension_value (dimension, value, state, derivation, source_status) values
  ('LEGAL_REVIEW_STATUS', 'CANCELLED', 'ACTIVE', null, 'OWNER_DEFAULT');

update config.target_module
   set commands = commands || array['api.return_package_to_committee', 'api.recommendation_item_flags',
                                    'api.set_sanction_catalogue_entry'],
       delivered_in = case when '2030' = any (delivered_in) then delivered_in else delivered_in || '2030'::text end,
       notes = notes || ' Since 2030: sanction catalogue versions (DEC-F11), adoption snapshots, defence-notice guard, '
                        'dependencies and exclusivity groups, conflict taint, return to the committee before submission.'
 where code = 'RECOMMENDATION_PACKAGE';
update config.target_module
   set commands = commands || array['api.cancel_legal_review_request', 'api.give_superseding_legal_opinion',
                                    'api.set_legal_review_rule'],
       delivered_in = case when '2030' = any (delivered_in) then delivered_in else delivered_in || '2030'::text end,
       notes = notes || ' Since 2030: configurable legal-review rules (DEC-F12), cancellation, superseding opinions, '
                        'restricted approval scope (DEC-F20); the reviewer''s packet ends with the authority decision.'
 where code = 'LEGAL_REVIEW';
update config.target_module
   set commands = commands || array['api.authority_rule_coverage'],
       delivered_in = case when '2030' = any (delivered_in) then delivered_in else delivered_in || '2030'::text end,
       notes = notes || ' Since 2030: fail closed without a rule (DEC-F13), rule snapshot per submission, one decision '
                        'per authority, joint authorities, delegation and signature attributes, conditions.'
 where code = 'AUTHORITY_DECISION';
update config.target_module
   set delivered_in = case when '2030' = any (delivered_in) then delivered_in else delivered_in || '2030'::text end,
       notes = notes || ' Since 2030: a case that is not a direct referral needs an approved preliminary recommendation '
                        'REFERRED_TO_COMMITTEE (AMB-018).'
 where code = 'COMMITTEE_REFERRAL';
