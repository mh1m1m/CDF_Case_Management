-- =============================================================================
-- 1910 Employee defence and grievances, linked or standalone (Business Architecture Rebase phase 7; CDF-193, CDF-194)
-- Requirements: §19–§22, §29, §39, §87; owner Q&A Q37, Q45–Q46, Q90–Q96; ADR-024; AUTHORIZATION_IMPACT.md N9
--
-- Additive only. Schema `grievance`:
--   subject_portal_link     a case subject linked to the employee account that may use the employee portal for that
--                           subject (Q90: each subject has their own path). Linked by the case team; never a member of
--                           the case team; revocable.
--   defence_notice          a notice to one subject with the material the issuer permits them to see (allegations of
--   defence_notice_item     that subject, snapshotted), a due date and its acknowledgement.
--   defence_response        the subject's response: through the portal, or recorded by the issuer from email, letter or
--                           another channel with its original date and document reference. Append-only.
--   grievance               a grievance LINKED to a case decision or STANDALONE (a new DIRECT_GRIEVANCE case, Q91). Received
--                           by the Grievance Committee Secretary (Q92), with channel and original submission date. Late
--                           filings are flagged, never rejected for lateness alone (Q94).
--   admissibility_assessment  the Secretary's assessment and proposed action (Q93); the decider comes from the GC rule set
--                           (SECRETARY / CHAIR / COMMITTEE). Not visible to the grievant.
--   grievance_outcome       the Grievance Committee's combinable outcomes (Q95), bound to an APPROVED vote of its proceeding;
--                           RETURN_FOR_REINVESTIGATION names a path and opens a REINVESTIGATION proceeding (Q96).
--
-- Admitting a grievance opens the case's GRIEVANCE committee proceeding through committee.open_committee_proceeding, so
-- the firewall (N9: an Investigation Committee voter of the case is never a voting Grievance Committee member) and the
-- case gate apply exactly as for any referral.
-- Attachments are document references until evidence registration (UX S2) merges. Notices to employees are delivered
-- by the notification engine (phase 8) and carry no case content. PRODUCTION_SUBSTITUTION_REQUIRED: the employee portal
-- uses the prototype identity provider; production uses the CDF corporate IdP.
-- Every command writes its audit event in the same transaction. Audit metadata carries ids, codes and counts only.
-- =============================================================================

create schema if not exists grievance;
revoke all on schema grievance from public;
alter default privileges in schema grievance revoke all on tables from public, anon, authenticated;
alter default privileges in schema grievance revoke all on sequences from public, anon, authenticated;
alter default privileges in schema grievance revoke execute on functions from public, anon, authenticated;
grant usage on schema grievance to authenticated;

-- -----------------------------------------------------------------------------
-- Employee defence
-- -----------------------------------------------------------------------------
create table grievance.subject_portal_link (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references case_mgmt.case_record (id),
  subject_id uuid not null references case_mgmt.case_subject (id),
  user_id    uuid not null references iam.user_profile (id),
  reason     text not null check (length(reason) between 5 and 2000),
  linked_by  uuid not null references iam.user_profile (id),
  linked_at  timestamptz not null default now(),
  revoked_by uuid references iam.user_profile (id),
  revoked_at timestamptz,
  check ((revoked_at is null) = (revoked_by is null))
);
create unique index subject_portal_link_active on grievance.subject_portal_link (subject_id) where revoked_at is null;
create index subject_portal_link_case on grievance.subject_portal_link (case_id);
create index subject_portal_link_user on grievance.subject_portal_link (user_id) where revoked_at is null;
create index subject_portal_link_linked_by on grievance.subject_portal_link (linked_by);
create index subject_portal_link_revoked_by on grievance.subject_portal_link (revoked_by);
comment on table grievance.subject_portal_link is
  'Which employee account may use the portal for one case subject (ADR-024, Q90). Revoked, never deleted.';

create table grievance.defence_notice (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid not null references case_mgmt.case_record (id),
  subject_id       uuid not null references case_mgmt.case_subject (id),
  sequence_no      int not null check (sequence_no >= 1),
  notice_text      text not null check (length(notice_text) between 10 and 4000),
  due_at           timestamptz not null,
  status           text not null default 'ISSUED' check (status in ('ISSUED', 'ACKNOWLEDGED', 'RESPONDED', 'WITHDRAWN')),
  issued_by        uuid not null references iam.user_profile (id),
  issued_at        timestamptz not null default now(),
  acknowledged_at  timestamptz,
  closed_at        timestamptz,
  unique (subject_id, sequence_no),
  check (due_at > issued_at),
  check ((status = 'ISSUED') = (acknowledged_at is null and closed_at is null) or status <> 'ISSUED'),
  check ((status in ('RESPONDED', 'WITHDRAWN')) = (closed_at is not null))
);
create index defence_notice_case on grievance.defence_notice (case_id);
create index defence_notice_issued_by on grievance.defence_notice (issued_by);
comment on table grievance.defence_notice is
  'A defence notice to one subject (Q90; employee rights): receive notice, see permitted material, respond, acknowledge.';

create table grievance.defence_notice_item (
  id            uuid primary key default gen_random_uuid(),
  notice_id     uuid not null references grievance.defence_notice (id),
  position      int not null check (position >= 1),
  allegation_id uuid not null references case_mgmt.allegation (id),
  snapshot      jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  unique (notice_id, position),
  unique (notice_id, allegation_id)
);
create index defence_notice_item_allegation on grievance.defence_notice_item (allegation_id);
comment on table grievance.defence_notice_item is
  'The material the issuer permits the subject to see: allegations against that subject, snapshotted. Nothing else.';

create table grievance.defence_response (
  id                         uuid primary key default gen_random_uuid(),
  notice_id                  uuid not null references grievance.defence_notice (id),
  case_id                    uuid not null references case_mgmt.case_record (id),
  channel                    text not null check (channel in (
                               'EMPLOYEE_PORTAL', 'EMAIL', 'PHYSICAL_SUBMISSION', 'SECRETARY_ENTRY', 'BCP_IMPORT',
                               'OTHER_AUTHORIZED_CHANNEL')),
  original_submission_date   timestamptz not null,
  response_text              text not null check (length(response_text) between 10 and 20000),
  original_document_reference text check (length(original_document_reference) between 3 and 300),
  is_late                    boolean not null,
  recorded_by                uuid not null references iam.user_profile (id),
  recorded_at                timestamptz not null default clock_timestamp(),
  -- Off-platform responses keep a reference to the original (email, letter, PDF).
  check (channel = 'EMPLOYEE_PORTAL' or original_document_reference is not null),
  check (original_submission_date <= recorded_at)
);
create index defence_response_notice on grievance.defence_response (notice_id);
create index defence_response_case on grievance.defence_response (case_id);
create index defence_response_recorded_by on grievance.defence_response (recorded_by);
comment on table grievance.defence_response is 'A subject''s defence, through the portal or recorded from another channel. Append-only.';

-- -----------------------------------------------------------------------------
-- Grievances
-- -----------------------------------------------------------------------------
create table grievance.grievance (
  id                        uuid primary key default gen_random_uuid(),
  case_id                   uuid not null references case_mgmt.case_record (id),
  kind                      text not null check (kind in ('LINKED', 'STANDALONE')),
  grievant_subject_id       uuid references case_mgmt.case_subject (id),
  grievant_user_id          uuid references iam.user_profile (id),
  grievant_label            text check (length(grievant_label) between 2 and 200),
  channel                   text not null check (channel in (
                              'EMPLOYEE_PORTAL', 'EMAIL', 'PHYSICAL_SUBMISSION', 'SECRETARY_ENTRY', 'BCP_IMPORT',
                              'OTHER_AUTHORIZED_CHANNEL')),
  original_submission_date  timestamptz not null,
  contested_decision_date   timestamptz not null,
  grounds                   text not null check (length(grounds) between 10 and 20000),
  original_document_reference text check (length(original_document_reference) between 3 and 300),
  -- Q94: the window of the GC rule set in force on the submission date; late is a flag, never a silent rejection.
  rule_set_id               uuid not null references committee.rule_set (id),
  window_days               int not null check (window_days between 1 and 365),
  is_late                   boolean not null,
  admissibility_decider     text not null check (admissibility_decider in ('SECRETARY', 'CHAIR', 'COMMITTEE')),
  status                    text not null default 'RECEIVED' check (status in (
                              'RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED', 'INADMISSIBLE', 'DECIDED',
                              'WITHDRAWN')),
  committee_proceeding_id   uuid unique references committee.committee_proceeding (id),
  recorded_by               uuid not null references iam.user_profile (id),
  recorded_at               timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  row_version               int not null default 1,
  check (grievant_subject_id is not null or grievant_label is not null),
  check (channel = 'EMPLOYEE_PORTAL' or original_document_reference is not null),
  check ((channel = 'EMPLOYEE_PORTAL') <= (grievant_user_id is not null)),
  check (original_submission_date >= contested_decision_date),
  check ((status in ('ADMITTED', 'DECIDED')) = (committee_proceeding_id is not null))
);
create index grievance_case on grievance.grievance (case_id);
create index grievance_subject on grievance.grievance (grievant_subject_id);
create index grievance_user on grievance.grievance (grievant_user_id);
create index grievance_rule_set on grievance.grievance (rule_set_id);
create index grievance_recorded_by on grievance.grievance (recorded_by);
comment on table grievance.grievance is
  'A grievance, LINKED to a decision on its case or STANDALONE (DIRECT_GRIEVANCE case) (ADR-024, Q91–Q94).';

create table grievance.admissibility_assessment (
  id               uuid primary key default gen_random_uuid(),
  grievance_id     uuid not null references grievance.grievance (id),
  stage            text not null check (stage in ('SECRETARY_ASSESSMENT', 'DECISION')),
  assessment       text not null check (assessment in ('ADMISSIBLE', 'INADMISSIBLE')),
  proposed_action  text check (length(proposed_action) between 5 and 4000),
  decision_reference text check (length(decision_reference) between 3 and 300),
  decided_by_role  text check (decided_by_role in ('SECRETARY', 'CHAIR', 'COMMITTEE')),
  reason           text not null check (length(reason) between 5 and 2000),
  recorded_by      uuid not null references iam.user_profile (id),
  recorded_at      timestamptz not null default clock_timestamp(),
  check ((stage = 'DECISION') = (decided_by_role is not null)),
  check (decided_by_role is distinct from 'COMMITTEE' or decision_reference is not null)
);
create index admissibility_assessment_grievance on grievance.admissibility_assessment (grievance_id);
create index admissibility_assessment_recorded_by on grievance.admissibility_assessment (recorded_by);
comment on table grievance.admissibility_assessment is
  'The Secretary''s admissibility assessment and the deciding party''s decision (Q93). Append-only; not shown to the grievant.';

create table grievance.grievance_outcome (
  id                  uuid primary key default gen_random_uuid(),
  grievance_id        uuid not null unique references grievance.grievance (id),
  outcomes            text[] not null check (cardinality(outcomes) between 1 and 11 and outcomes <@ array[
                        'UPHOLD', 'MODIFY', 'CANCEL', 'RETURN_FOR_REINVESTIGATION', 'REQUEST_COMPLETION', 'INADMISSIBLE',
                        'REJECT_ON_MERITS', 'PARTIALLY_ACCEPT', 'CORRECTIVE_ACTION', 'DISCIPLINARY_ACTION',
                        'OTHER_AUTHORIZED_OUTCOME']::text[]),
  reinvestigation_path text check (reinvestigation_path in (
                        'SAME_INVESTIGATION_COMMITTEE', 'NEW_INTERNAL_TEAM', 'NEW_INVESTIGATOR', 'EXTERNAL_INVESTIGATOR',
                        'TECHNICAL_INVESTIGATION', 'GRIEVANCE_COMMITTEE_FACT_FINDING', 'OTHER')),
  reinvestigation_proceeding_id uuid references case_mgmt.proceeding (id),
  vote_item_id        uuid not null unique references committee.vote_item (id),
  summary             text not null check (length(summary) between 10 and 4000),
  recorded_by         uuid not null references iam.user_profile (id),
  recorded_at         timestamptz not null default now(),
  check (('RETURN_FOR_REINVESTIGATION' = any (outcomes)) = (reinvestigation_path is not null)),
  check ((reinvestigation_path is null) = (reinvestigation_proceeding_id is null))
);
create index grievance_outcome_proceeding on grievance.grievance_outcome (reinvestigation_proceeding_id);
create index grievance_outcome_recorded_by on grievance.grievance_outcome (recorded_by);
comment on table grievance.grievance_outcome is
  'The Grievance Committee''s outcome (Q95–Q96), combinable, bound to an approved vote. Append-only.';

-- AGENT-09 G2 / G2b (coordinator ruling extending DEC-61/DEC-62, SOURCE_REQUIRED): on a restricted case the case's
-- Restricted Case Authority names each Grievance Committee Secretary who may record a linked grievance (an open row,
-- used once) or handle a grievance already received (a row bound to that grievance). Without one, a grievance on a
-- restricted case stays with the case team.
create table grievance.restricted_grievance_approval (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid not null references case_mgmt.case_record (id),
  recorder_id  uuid not null references iam.user_profile (id),
  approved_by  uuid not null references iam.user_profile (id),
  reason       text not null check (length(reason) between 5 and 2000),
  approved_at  timestamptz not null default now(),
  grievance_id uuid references grievance.grievance (id),
  used_at      timestamptz,
  check ((grievance_id is null) = (used_at is null)),
  check (recorder_id <> approved_by)
);
create unique index restricted_grievance_approval_bound on grievance.restricted_grievance_approval (grievance_id, recorder_id)
  where grievance_id is not null;
create unique index restricted_grievance_approval_open on grievance.restricted_grievance_approval (case_id, recorder_id)
  where grievance_id is null;
create index restricted_grievance_approval_recorder on grievance.restricted_grievance_approval (recorder_id);
create index restricted_grievance_approval_approved_by on grievance.restricted_grievance_approval (approved_by);
comment on table grievance.restricted_grievance_approval is
  'The Restricted Case Authority''s approval naming the secretary who records or handles a grievance on a restricted case (G2, G2b).';

-- -----------------------------------------------------------------------------
-- Integrity
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['grievance.defence_notice_item', 'grievance.defence_response',
                           'grievance.admissibility_assessment', 'grievance.grievance_outcome'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
  foreach t in array array['grievance.subject_portal_link', 'grievance.defence_notice', 'grievance.grievance',
                           'grievance.restricted_grievance_approval'] loop
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;

create function grievance.protect_records()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'subject_portal_link' then
    if old.revoked_at is not null
       or (to_jsonb(new) - array['revoked_by', 'revoked_at']) <> (to_jsonb(old) - array['revoked_by', 'revoked_at']) then
      raise exception 'portal link % can only be revoked, once', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'defence_notice' then
    if old.status in ('RESPONDED', 'WITHDRAWN')
       or (to_jsonb(new) - array['status', 'acknowledged_at', 'closed_at'])
          <> (to_jsonb(old) - array['status', 'acknowledged_at', 'closed_at']) then
      raise exception 'defence notice % is closed or its content is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'restricted_grievance_approval' then
    if old.grievance_id is not null
       or (to_jsonb(new) - array['grievance_id', 'used_at']) <> (to_jsonb(old) - array['grievance_id', 'used_at']) then
      raise exception 'approval % can only be used, once', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'grievance' then
    if old.status in ('INADMISSIBLE', 'DECIDED', 'WITHDRAWN')
       or (to_jsonb(new) - array['status', 'committee_proceeding_id', 'updated_at', 'row_version'])
          <> (to_jsonb(old) - array['status', 'committee_proceeding_id', 'updated_at', 'row_version'])
       or (old.committee_proceeding_id is not null and new.committee_proceeding_id is distinct from old.committee_proceeding_id) then
      raise exception 'grievance % is closed or its record is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;
create trigger subject_portal_link_protect before update on grievance.subject_portal_link
  for each row execute function grievance.protect_records();
create trigger defence_notice_protect before update on grievance.defence_notice
  for each row execute function grievance.protect_records();
create trigger grievance_protect before update on grievance.grievance
  for each row execute function grievance.protect_records();
create trigger restricted_grievance_approval_protect before update on grievance.restricted_grievance_approval
  for each row execute function grievance.protect_records();

-- -----------------------------------------------------------------------------
-- Authorization predicates
-- -----------------------------------------------------------------------------
-- The employee behind an active portal link for the subject, with an active account. Reaches the subject's own
-- notices, their items and responses, and their own grievances; never the case.
create function authz.is_portal_subject(p_subject_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from grievance.subject_portal_link l
    join iam.user_profile u on u.id = l.user_id and u.status = 'ACTIVE'
    where l.subject_id = p_subject_id and l.user_id = authz.current_user_id() and l.revoked_at is null
  );
$$;

-- Issuing notices and recording off-platform responses: the people who edit the case, or the secretary of an open
-- committee proceeding of the case who is cleared for it.
create function authz.can_manage_defence(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null
     and (authz.can_edit_case(p_case_id)
          or (authz.user_case_gate(authz.current_user_id(), p_case_id)
              and exists (select 1 from committee.committee_proceeding cp
                          where cp.case_id = p_case_id and cp.status = 'OPEN'
                            and authz.is_committee_secretary(cp.committee_id))));
$$;

-- The Grievance Committee's current secretary, cleared for the grievance's case. On a restricted case (G2b, DEC-61
-- pattern) the secretary must also work the case or be named for this grievance by its Restricted Case Authority.
-- Internal: answers about any user (the notification engine uses it for recipients).
create function authz.user_can_handle_grievance(p_user_id uuid, p_grievance_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1 from grievance.grievance g
    join committee.committee c on c.kind = 'GRIEVANCE' and c.is_active
    join case_mgmt.case_record cr on cr.id = g.case_id
    where g.id = p_grievance_id
      and coalesce(authz.user_committee_seat(p_user_id, c.id, now()) in ('SECRETARY', 'ALTERNATE_SECRETARY'), false)
      and authz.user_case_gate(p_user_id, g.case_id)
      and (not cr.is_restricted
           or authz.user_can_view_case(p_user_id, g.case_id)
           or exists (select 1 from grievance.restricted_grievance_approval a
                      where a.grievance_id = g.id and a.recorder_id = p_user_id))
  );
$$;

create function authz.can_handle_grievance(p_grievance_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null
     and authz.user_can_handle_grievance(authz.current_user_id(), p_grievance_id);
$$;

-- A grievance: its grievant (portal), the Grievance Committee's secretary cleared for the case (Q92), the case team,
-- and the viewers of its Grievance Committee proceeding once admitted who have not declared a meeting conflict in it.
create function authz.can_view_grievance(p_grievance_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from grievance.grievance g
    where g.id = p_grievance_id
      and ((g.grievant_user_id = authz.current_user_id()
            and exists (select 1 from iam.user_profile u where u.id = g.grievant_user_id and u.status = 'ACTIVE'))
           or authz.can_handle_grievance(g.id)
           or authz.can_view_case(g.case_id)
           or (g.committee_proceeding_id is not null
               and authz.sees_proceeding_deliberation(g.committee_proceeding_id, g.case_id)))
  );
$$;

-- The internal admissibility assessment: everyone who sees the grievance except its grievant.
create function authz.can_view_grievance_assessment(p_grievance_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from grievance.grievance g
    where g.id = p_grievance_id
      and (authz.can_handle_grievance(g.id)
           or authz.can_view_case(g.case_id)
           or (g.committee_proceeding_id is not null
               and authz.sees_proceeding_deliberation(g.committee_proceeding_id, g.case_id)))
  );
$$;

revoke all on function authz.user_can_handle_grievance(uuid, uuid) from public, anon, authenticated;
grant execute on function
  authz.is_portal_subject(uuid), authz.can_manage_defence(uuid), authz.can_view_grievance(uuid),
  authz.can_handle_grievance(uuid), authz.can_view_grievance_assessment(uuid)
to authenticated;

-- AGENT-09 G1: a subject's linked portal account and a grievant are parties to the case. Treating them as conflicted
-- here excludes them, through the gate every path already uses, from case access, assignment, committee snapshots,
-- meetings, deliberation and packets. Their own notices and grievances stay reachable through the portal predicates.
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
           where g.case_id = p_case_id and g.grievant_user_id = p_user_id);
$$;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table grievance.subject_portal_link enable row level security;
alter table grievance.defence_notice enable row level security;
alter table grievance.defence_notice_item enable row level security;
alter table grievance.defence_response enable row level security;
alter table grievance.grievance enable row level security;
alter table grievance.admissibility_assessment enable row level security;
alter table grievance.grievance_outcome enable row level security;
alter table grievance.restricted_grievance_approval enable row level security;

create policy subject_portal_link_read on grievance.subject_portal_link for select to authenticated
  using (authz.can_view_case(case_id) or (user_id = authz.current_user_id() and revoked_at is null));
grant select on grievance.subject_portal_link to authenticated;

create policy defence_notice_read on grievance.defence_notice for select to authenticated
  using (authz.can_view_case(case_id) or authz.is_portal_subject(subject_id));
grant select on grievance.defence_notice to authenticated;
create policy defence_notice_item_read on grievance.defence_notice_item for select to authenticated
  using (exists (select 1 from grievance.defence_notice n
                 where n.id = notice_id and (authz.can_view_case(n.case_id) or authz.is_portal_subject(n.subject_id))));
grant select on grievance.defence_notice_item to authenticated;
create policy defence_response_read on grievance.defence_response for select to authenticated
  using (exists (select 1 from grievance.defence_notice n
                 where n.id = notice_id and (authz.can_view_case(n.case_id) or authz.is_portal_subject(n.subject_id))));
grant select on grievance.defence_response to authenticated;

create policy grievance_read on grievance.grievance for select to authenticated using (authz.can_view_grievance(id));
grant select on grievance.grievance to authenticated;
-- The assessment is internal: the grievant does not see it.
create policy admissibility_assessment_read on grievance.admissibility_assessment for select to authenticated
  using (authz.can_view_grievance_assessment(grievance_id));
grant select on grievance.admissibility_assessment to authenticated;
create policy restricted_grievance_approval_read on grievance.restricted_grievance_approval for select to authenticated
  using (authz.can_view_case(case_id));
grant select on grievance.restricted_grievance_approval to authenticated;
create policy grievance_outcome_read on grievance.grievance_outcome for select to authenticated
  using (authz.can_view_grievance(grievance_id));
grant select on grievance.grievance_outcome to authenticated;

-- -----------------------------------------------------------------------------
-- Internal helpers
-- -----------------------------------------------------------------------------
create function grievance.committee_id()
returns uuid
language sql stable
set search_path = ''
as $$
  select c.id from committee.committee c where c.kind = 'GRIEVANCE' and c.is_active;
$$;

-- The Grievance Committee rule set in force at a moment (Q94: the rule version is stored with the grievance).
create function grievance.rule_at(p_at timestamptz)
returns committee.rule_set
language sql stable
set search_path = ''
as $$
  select r.* from committee.rule_set r
  where r.committee_id = grievance.committee_id() and r.effective_from <= p_at
    and (r.effective_to is null or r.effective_to > p_at)
  order by r.effective_from desc limit 1;
$$;

-- Locks and returns a grievance the caller handles as the Grievance Committee Secretary.
create function grievance.lock_handled_grievance(p_grievance_id uuid)
returns grievance.grievance
language plpgsql
set search_path = ''
as $$
declare v grievance.grievance;
begin
  if p_grievance_id is null or not authz.can_view_grievance(p_grievance_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_handle_grievance(p_grievance_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v from grievance.grievance g where g.id = p_grievance_id for update;
  return v;
end;
$$;

-- Records a received grievance with the window of the rule in force on its submission date.
create function grievance.insert_grievance(
  p_case_id uuid, p_kind text, p_subject_id uuid, p_user_id uuid, p_label text, p_channel text,
  p_original_submission_date timestamptz, p_contested_decision_date timestamptz, p_grounds text,
  p_document_reference text, p_actor uuid
)
returns grievance.grievance
language plpgsql
set search_path = ''
as $$
declare
  v_rule committee.rule_set;
  v grievance.grievance;
begin
  if p_channel is null or p_channel not in ('EMPLOYEE_PORTAL', 'EMAIL', 'PHYSICAL_SUBMISSION', 'SECRETARY_ENTRY',
                                            'BCP_IMPORT', 'OTHER_AUTHORIZED_CHANNEL') then
    perform api._fail('INVALID', 'channel');
  end if;
  if p_original_submission_date is null or p_original_submission_date > now() then
    perform api._fail('INVALID', 'original_submission_date');
  end if;
  if p_contested_decision_date is null or p_contested_decision_date > p_original_submission_date then
    perform api._fail('INVALID', 'contested_decision_date');
  end if;
  if p_channel <> 'EMPLOYEE_PORTAL' and p_document_reference is null then
    perform api._fail('INVALID', 'original_document_reference');
  end if;
  v_rule := grievance.rule_at(p_original_submission_date);
  if v_rule.id is null or v_rule.grievance_window_days is null then perform api._fail('CONFLICT', 'NO_RULE_SET'); end if;
  insert into grievance.grievance (case_id, kind, grievant_subject_id, grievant_user_id, grievant_label, channel,
                                   original_submission_date, contested_decision_date, grounds,
                                   original_document_reference, rule_set_id, window_days, is_late,
                                   admissibility_decider, recorded_by)
  values (p_case_id, p_kind, p_subject_id, p_user_id,
          case when p_label is not null then api._require_text(p_label, 'grievant_label', 2, 200) end,
          p_channel, p_original_submission_date, p_contested_decision_date,
          api._require_text(p_grounds, 'grounds', 10, 20000),
          case when p_document_reference is not null
               then api._require_text(p_document_reference, 'original_document_reference', 3, 300) end,
          v_rule.id, v_rule.grievance_window_days,
          p_original_submission_date > p_contested_decision_date + make_interval(days => v_rule.grievance_window_days),
          coalesce(v_rule.admissibility_decider, 'SECRETARY'), p_actor)
  returning * into v;
  perform audit.record_event('GRIEVANCE_FILED', 'BUSINESS', 'SUCCESS', p_case_id, 'grievance', v.id::text, null,
    jsonb_build_object('kind', p_kind, 'channel', p_channel, 'is_late', v.is_late, 'window_days', v.window_days,
                       'rule_set_id', v_rule.id, 'admissibility_decider', v.admissibility_decider));
  return v;
end;
$$;

-- Applies an admissibility decision: admitted opens the case's Grievance Committee proceeding (N9 firewall and the
-- case gate apply in the snapshot); inadmissible closes the grievance.
create function grievance.apply_admissibility(p_g grievance.grievance, p_assessment text, p_actor uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_cp uuid;
begin
  if p_assessment = 'ADMISSIBLE' then
    v_cp := committee.open_committee_proceeding(p_g.case_id, grievance.committee_id(), null, p_actor,
      'Grievance admitted by the Grievance Committee');
    update grievance.grievance set status = 'ADMITTED', committee_proceeding_id = v_cp, updated_at = now(),
                                   row_version = row_version + 1
     where id = p_g.id;
    perform audit.record_event('GRIEVANCE_ADMITTED', 'BUSINESS', 'SUCCESS', p_g.case_id, 'grievance', p_g.id::text, null,
      jsonb_build_object('committee_proceeding_id', v_cp));
    return 'ADMITTED';
  end if;
  update grievance.grievance set status = 'INADMISSIBLE', updated_at = now(), row_version = row_version + 1
   where id = p_g.id;
  perform audit.record_event('GRIEVANCE_REJECTED_FORMALLY', 'BUSINESS', 'SUCCESS', p_g.case_id, 'grievance', p_g.id::text,
    null, '{}'::jsonb);
  return 'INADMISSIBLE';
end;
$$;

-- -----------------------------------------------------------------------------
-- Defence commands
-- -----------------------------------------------------------------------------
create function api.link_subject_portal_account(p_subject_id uuid, p_user_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_s case_mgmt.case_subject;
  v_id uuid;
begin
  select * into v_s from case_mgmt.case_subject s where s.id = p_subject_id;
  if v_s.id is null or not authz.can_view_case(v_s.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform case_mgmt.lock_editable_case(v_s.case_id);
  if not exists (select 1 from iam.user_profile u where u.id = p_user_id and u.status = 'ACTIVE') then
    perform api._fail('INVALID', 'user_id');
  end if;
  -- A subject is never on their own case team, never a committee member of it, and never the linker.
  if p_user_id = v_actor
     or exists (select 1 from case_mgmt.case_assignment a
                where a.case_id = v_s.case_id and a.user_id = p_user_id and a.status = 'ACTIVE')
     or exists (select 1 from case_mgmt.case_access_grant g
                where g.case_id = v_s.case_id and g.user_id = p_user_id and g.revoked_at is null)
     or exists (select 1 from committee.proceeding_member pm
                join committee.committee_proceeding cp on cp.id = pm.committee_proceeding_id
                where cp.case_id = v_s.case_id and pm.user_id = p_user_id) then
    perform api._fail('CONFLICT', 'SUBJECT_ON_CASE_TEAM');
  end if;
  if exists (select 1 from grievance.subject_portal_link l where l.subject_id = v_s.id and l.revoked_at is null) then
    perform api._fail('CONFLICT', 'ALREADY_LINKED');
  end if;
  insert into grievance.subject_portal_link (case_id, subject_id, user_id, reason, linked_by)
  values (v_s.case_id, v_s.id, p_user_id, api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_id;
  perform audit.record_event('SUBJECT_PORTAL_LINKED', 'BUSINESS', 'SUCCESS', v_s.case_id, 'subject_portal_link', v_id::text,
    null, jsonb_build_object('subject_id', v_s.id));
  return v_id;
end;
$$;

create function api.revoke_subject_portal_link(p_link_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_l grievance.subject_portal_link;
  v_reason text;
begin
  select * into v_l from grievance.subject_portal_link l where l.id = p_link_id;
  if v_l.id is null or not authz.can_view_case(v_l.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform case_mgmt.lock_editable_case(v_l.case_id);
  if v_l.revoked_at is not null then perform api._fail('CONFLICT', 'ALREADY_REVOKED'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update grievance.subject_portal_link set revoked_by = v_actor, revoked_at = now() where id = v_l.id;
  perform audit.record_event('SUBJECT_PORTAL_UNLINKED', 'BUSINESS', 'SUCCESS', v_l.case_id, 'subject_portal_link',
    v_l.id::text, v_reason, jsonb_build_object('subject_id', v_l.subject_id));
end;
$$;

-- The issuer chooses which allegations against the subject the notice shows (Q90; employee rights). Each is
-- snapshotted: category, description and references. Nothing about the reporter or other subjects.
create function api.issue_defence_notice(
  p_subject_id uuid, p_notice_text text, p_allegation_ids uuid[], p_due_at timestamptz
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_s case_mgmt.case_subject;
  v_allegations uuid[] := coalesce(p_allegation_ids, '{}');
  v_id uuid;
  v_seq int;
begin
  select * into v_s from case_mgmt.case_subject s where s.id = p_subject_id;
  if v_s.id is null or not authz.can_view_case(v_s.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_manage_defence(v_s.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_s.case_id for update;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_s.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if cardinality(v_allegations) = 0
     or (select count(distinct x) from unnest(v_allegations) x) <> cardinality(v_allegations)
     or exists (select 1 from unnest(v_allegations) x
                where not exists (select 1 from case_mgmt.allegation a
                                  where a.id = x and a.case_id = v_s.case_id and a.subject_id = v_s.id)) then
    perform api._fail('INVALID', 'allegation_ids');
  end if;
  if p_due_at is null or p_due_at <= now() then perform api._fail('INVALID', 'due_at'); end if;
  select coalesce(max(n.sequence_no), 0) + 1 into v_seq from grievance.defence_notice n where n.subject_id = v_s.id;
  insert into grievance.defence_notice (case_id, subject_id, sequence_no, notice_text, due_at, issued_by)
  values (v_s.case_id, v_s.id, v_seq, api._require_text(p_notice_text, 'notice_text', 10, 4000), p_due_at, v_actor)
  returning id into v_id;
  insert into grievance.defence_notice_item (notice_id, position, allegation_id, snapshot)
  select v_id, row_number() over (order by a.created_at, a.id), a.id,
         jsonb_build_object('category', a.category, 'description', a.description,
                            'policy_reference', a.policy_reference, 'law_reference', a.law_reference)
  from case_mgmt.allegation a where a.id = any (v_allegations);
  perform audit.record_event('DEFENCE_NOTICE_ISSUED', 'BUSINESS', 'SUCCESS', v_s.case_id, 'defence_notice', v_id::text, null,
    jsonb_build_object('subject_id', v_s.id, 'sequence_no', v_seq, 'allegations', cardinality(v_allegations),
                       'due_at', p_due_at));
  return v_id;
end;
$$;

-- The subject's own notices through the portal: the notice, its permitted items and responses. Read-only.
create function api.my_defence_notices()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'notice_id', n.id, 'sequence_no', n.sequence_no, 'notice_text', n.notice_text, 'due_at', n.due_at,
           'status', n.status, 'issued_at', n.issued_at, 'acknowledged_at', n.acknowledged_at,
           'items', (select coalesce(jsonb_agg(jsonb_build_object('position', i.position, 'snapshot', i.snapshot)
                                               order by i.position), '[]'::jsonb)
                     from grievance.defence_notice_item i where i.notice_id = n.id))
         order by n.issued_at), '[]'::jsonb)
  from grievance.defence_notice n
  where authz.current_user_id() is not null and authz.is_portal_subject(n.subject_id) and n.status <> 'WITHDRAWN';
$$;

create function api.acknowledge_defence_notice(p_notice_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_n grievance.defence_notice;
begin
  perform api._actor();
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id;
  if v_n.id is null or not authz.is_portal_subject(v_n.subject_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id for update;
  if v_n.status <> 'ISSUED' then perform api._fail('CONFLICT', 'NOTICE_NOT_OPEN'); end if;
  update grievance.defence_notice set status = 'ACKNOWLEDGED', acknowledged_at = now() where id = v_n.id;
  perform audit.record_event('DEFENCE_NOTICE_ACKNOWLEDGED', 'BUSINESS', 'SUCCESS', v_n.case_id, 'defence_notice',
    v_n.id::text, null, '{}'::jsonb);
end;
$$;

-- The subject responds through the portal. A late response is accepted and flagged.
create function api.submit_defence_response(p_notice_id uuid, p_response_text text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_n grievance.defence_notice;
  v_id uuid;
begin
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id;
  if v_n.id is null or not authz.is_portal_subject(v_n.subject_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id for update;
  if v_n.status not in ('ISSUED', 'ACKNOWLEDGED') then perform api._fail('CONFLICT', 'NOTICE_NOT_OPEN'); end if;
  insert into grievance.defence_response (notice_id, case_id, channel, original_submission_date, response_text, is_late,
                                          recorded_by)
  values (v_n.id, v_n.case_id, 'EMPLOYEE_PORTAL', now(), api._require_text(p_response_text, 'response_text', 10, 20000),
          now() > v_n.due_at, v_actor)
  returning id into v_id;
  update grievance.defence_notice
     set status = 'RESPONDED', acknowledged_at = coalesce(acknowledged_at, now()), closed_at = now()
   where id = v_n.id;
  perform audit.record_event('DEFENCE_RESPONSE_SUBMITTED', 'BUSINESS', 'SUCCESS', v_n.case_id, 'defence_response',
    v_id::text, null, jsonb_build_object('notice_id', v_n.id, 'channel', 'EMPLOYEE_PORTAL', 'is_late', now() > v_n.due_at));
  return v_id;
end;
$$;

-- A response received outside the platform, recorded by the issuer side with its original date and document.
create function api.record_defence_response(
  p_notice_id uuid, p_channel text, p_original_submission_date timestamptz, p_response_text text,
  p_original_document_reference text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_n grievance.defence_notice;
  v_id uuid;
begin
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id;
  if v_n.id is null or not authz.can_view_case(v_n.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_manage_defence(v_n.case_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id for update;
  if v_n.status not in ('ISSUED', 'ACKNOWLEDGED') then perform api._fail('CONFLICT', 'NOTICE_NOT_OPEN'); end if;
  if p_channel is null or p_channel not in ('EMAIL', 'PHYSICAL_SUBMISSION', 'SECRETARY_ENTRY', 'BCP_IMPORT',
                                            'OTHER_AUTHORIZED_CHANNEL') then
    perform api._fail('INVALID', 'channel');
  end if;
  if p_original_submission_date is null or p_original_submission_date > now()
     or p_original_submission_date < v_n.issued_at then
    perform api._fail('INVALID', 'original_submission_date');
  end if;
  insert into grievance.defence_response (notice_id, case_id, channel, original_submission_date, response_text,
                                          original_document_reference, is_late, recorded_by)
  values (v_n.id, v_n.case_id, p_channel, p_original_submission_date,
          api._require_text(p_response_text, 'response_text', 10, 20000),
          api._require_text(p_original_document_reference, 'original_document_reference', 3, 300),
          p_original_submission_date > v_n.due_at, v_actor)
  returning id into v_id;
  update grievance.defence_notice
     set status = 'RESPONDED', closed_at = now()
   where id = v_n.id;
  perform audit.record_event('DEFENCE_RESPONSE_RECORDED', 'BUSINESS', 'SUCCESS', v_n.case_id, 'defence_response',
    v_id::text, null, jsonb_build_object('notice_id', v_n.id, 'channel', p_channel,
                                         'is_late', p_original_submission_date > v_n.due_at));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grievance commands
-- -----------------------------------------------------------------------------
-- Through the portal, about a decision on the employee's own subject's case (LINKED).
create function api.file_grievance(p_portal_link_id uuid, p_contested_decision_date timestamptz, p_grounds text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_l grievance.subject_portal_link;
  v_g grievance.grievance;
begin
  select * into v_l from grievance.subject_portal_link l where l.id = p_portal_link_id;
  if v_l.id is null or v_l.user_id <> v_actor or not authz.is_portal_subject(v_l.subject_id) then
    perform api._fail('NOT_FOUND');
  end if;
  perform 1 from case_mgmt.case_record c where c.id = v_l.case_id for update;
  if exists (select 1 from grievance.grievance g
             where g.grievant_subject_id = v_l.subject_id and g.status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED')) then
    perform api._fail('CONFLICT', 'GRIEVANCE_OPEN');
  end if;
  v_g := grievance.insert_grievance(v_l.case_id, 'LINKED', v_l.subject_id, v_actor, null, 'EMPLOYEE_PORTAL', now(),
                                    p_contested_decision_date, p_grounds, null, v_actor);
  return v_g.id;
end;
$$;

-- The Grievance Committee Secretary records a grievance received through another channel (Q92). LINKED names the
-- case by its number; STANDALONE creates a DIRECT_GRIEVANCE case (Q91) with a named, eligible case owner. An unknown,
-- inactive or uncleared case number answers NOT_FOUND alike.
create function api.record_grievance(
  p_kind text, p_case_number text, p_grievant_label text, p_title text, p_classification core.classification_level,
  p_case_owner_id uuid, p_channel text, p_original_submission_date timestamptz, p_contested_decision_date timestamptz,
  p_grounds text, p_original_document_reference text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_gc uuid := grievance.committee_id();
  v_case_id uuid;
  v_number text;
  v_assignment uuid;
  v_restricted boolean;
  v_approval uuid;
  v_g grievance.grievance;
begin
  if v_gc is null or not authz.is_committee_secretary(v_gc) then perform api._fail('FORBIDDEN'); end if;
  if p_channel = 'EMPLOYEE_PORTAL' then perform api._fail('INVALID', 'channel'); end if;
  if p_kind = 'LINKED' then
    if p_title is not null or p_classification is not null or p_case_owner_id is not null then
      perform api._fail('INVALID', 'standalone_fields');
    end if;
    select c.id, c.is_restricted into v_case_id, v_restricted from case_mgmt.case_record c
    where c.case_number = p_case_number and c.records_state = 'ACTIVE' and authz.user_case_gate(v_actor, c.id)
    for update;
    if v_case_id is null then perform api._fail('NOT_FOUND'); end if;
    -- G2 (DEC-01, fail safe): a restricted case answers like an unknown one unless the caller works it or its
    -- Restricted Case Authority approved this recorder.
    if v_restricted and not authz.can_view_case(v_case_id) then
      select a.id into v_approval from grievance.restricted_grievance_approval a
      where a.case_id = v_case_id and a.recorder_id = v_actor and a.grievance_id is null for update;
      if v_approval is null then perform api._fail('NOT_FOUND'); end if;
    end if;
  elsif p_kind = 'STANDALONE' then
    if p_case_number is not null then perform api._fail('INVALID', 'case_number'); end if;
    if p_classification is null or p_classification > (select u.clearance from iam.user_profile u where u.id = v_actor) then
      perform api._fail('INVALID', 'classification');
    end if;
    if p_case_owner_id is null then perform api._fail('INVALID', 'case_owner_id'); end if;
    -- Every case here is synthetic (§2). PRODUCTION_SUBSTITUTION_REQUIRED: production numbering uses CDF-CASE.
    v_number := case_mgmt.next_case_number('CDF-DEMO');
    insert into case_mgmt.case_record (case_number, case_type, title, summary, classification, is_restricted, source,
                                       source_type, owner_id, created_by, updated_by)
    values (v_number, 'OTHER', api._require_text(p_title, 'title', 3, 200),
            'Direct grievance received by the Grievance Committee Secretary.', p_classification, false, 'OTHER',
            'DIRECT_GRIEVANCE', p_case_owner_id, v_actor, v_actor)
    returning id into v_case_id;
    perform case_mgmt.assert_assignee_eligible(v_case_id, p_case_owner_id, 'CASE_OWNER');
    insert into case_mgmt.case_assignment (case_id, user_id, assignment_role, reason, assigned_by)
    values (v_case_id, p_case_owner_id, 'CASE_OWNER', 'Direct grievance: case owner named by the Grievance Committee Secretary',
            v_actor)
    returning id into v_assignment;
    insert into workflow.workflow_instance (case_id, workflow_code, current_state) values (v_case_id, 'CDF_CASE_V1', 'REFERRAL');
    perform audit.record_event('CASE_CREATED', 'BUSINESS', 'SUCCESS', v_case_id, 'case_record', v_case_id::text, null,
      jsonb_build_object('case_number', v_number, 'source_type', 'DIRECT_GRIEVANCE', 'classification', p_classification,
                         'is_restricted', false));
    perform audit.record_event('CASE_ASSIGNED', 'BUSINESS', 'SUCCESS', v_case_id, 'case_assignment', v_assignment::text,
      'Direct grievance: case owner named by the Grievance Committee Secretary',
      jsonb_build_object('user_id', p_case_owner_id, 'assignment_role', 'CASE_OWNER'));
    perform workflow.apply_transition(v_case_id, 'REGISTER', v_actor, null);
  else
    perform api._fail('INVALID', 'kind');
  end if;
  v_g := grievance.insert_grievance(v_case_id, p_kind, null, null, api._require_text(p_grievant_label, 'grievant_label', 2, 200),
                                    p_channel, p_original_submission_date, p_contested_decision_date, p_grounds,
                                    p_original_document_reference, v_actor);
  if v_approval is not null then
    update grievance.restricted_grievance_approval set grievance_id = v_g.id, used_at = now() where id = v_approval;
  end if;
  return v_g.id;
end;
$$;

-- G2: the restricted case's owner, holding the Restricted Case Authority role for its classification, names the
-- Grievance Committee Secretary who may record one linked grievance on it. Audited; single use.
create function api.approve_restricted_grievance_recording(p_case_id uuid, p_recorder_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_id uuid;
  v_reason text;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  if not v_case.is_restricted then perform api._fail('CONFLICT', 'CASE_NOT_RESTRICTED'); end if;
  if v_case.owner_id is distinct from v_actor
     or not authz.is_restricted_case_authority(v_actor, v_case.classification) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_case.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
  if p_recorder_id is null or p_recorder_id = v_actor
     or not coalesce(authz.user_committee_seat(p_recorder_id, grievance.committee_id(), now())
                     in ('SECRETARY', 'ALTERNATE_SECRETARY'), false)
     or not authz.user_case_gate(p_recorder_id, p_case_id) then
    perform api._fail('INVALID', 'recorder_id');
  end if;
  if exists (select 1 from grievance.restricted_grievance_approval a
             where a.case_id = p_case_id and a.recorder_id = p_recorder_id and a.grievance_id is null) then
    perform api._fail('CONFLICT', 'APPROVAL_ALREADY_PENDING');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  insert into grievance.restricted_grievance_approval (case_id, recorder_id, approved_by, reason)
  values (p_case_id, p_recorder_id, v_actor, v_reason)
  returning id into v_id;
  perform audit.record_event('RESTRICTED_GRIEVANCE_RECORDING_APPROVED', 'BUSINESS', 'SUCCESS', p_case_id,
    'restricted_grievance_approval', v_id::text, v_reason,
    jsonb_build_object('recorder_id', p_recorder_id, 'classification', v_case.classification));
  return v_id;
end;
$$;

-- G2b: on a restricted case the Restricted Case Authority (the case owner) names a Grievance Committee Secretary who
-- may handle one grievance already received (a portal filing, or a recorded one handed to another secretary).
-- Audited; one approval per grievance and secretary.
create function api.approve_restricted_grievance_handling(p_grievance_id uuid, p_secretary_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_g grievance.grievance;
  v_case case_mgmt.case_record;
  v_id uuid;
  v_reason text;
begin
  select * into v_g from grievance.grievance g where g.id = p_grievance_id;
  if v_g.id is null or not authz.can_view_case(v_g.case_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = v_g.case_id for update;
  if not v_case.is_restricted then perform api._fail('CONFLICT', 'CASE_NOT_RESTRICTED'); end if;
  if v_case.owner_id is distinct from v_actor
     or not authz.is_restricted_case_authority(v_actor, v_case.classification) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_g.status not in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED') then
    perform api._fail('CONFLICT', 'GRIEVANCE_CLOSED');
  end if;
  if p_secretary_id is null or p_secretary_id = v_actor
     or not coalesce(authz.user_committee_seat(p_secretary_id, grievance.committee_id(), now())
                     in ('SECRETARY', 'ALTERNATE_SECRETARY'), false)
     or not authz.user_case_gate(p_secretary_id, v_g.case_id) then
    perform api._fail('INVALID', 'secretary_id');
  end if;
  if exists (select 1 from grievance.restricted_grievance_approval a
             where a.grievance_id = v_g.id and a.recorder_id = p_secretary_id) then
    perform api._fail('CONFLICT', 'ALREADY_APPROVED');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  insert into grievance.restricted_grievance_approval (case_id, recorder_id, approved_by, reason, grievance_id, used_at)
  values (v_g.case_id, p_secretary_id, v_actor, v_reason, v_g.id, now())
  returning id into v_id;
  perform audit.record_event('RESTRICTED_GRIEVANCE_HANDLING_APPROVED', 'BUSINESS', 'SUCCESS', v_g.case_id,
    'restricted_grievance_approval', v_id::text, v_reason,
    jsonb_build_object('grievance_id', v_g.id, 'secretary_id', p_secretary_id, 'classification', v_case.classification));
  return v_id;
end;
$$;

-- Q93: the Secretary records the assessment and proposed action. When the rule makes the Secretary the decider, it
-- takes effect at once; otherwise it waits for the Chair (or the Chair recording the Committee's decision).
create function api.assess_grievance_admissibility(
  p_grievance_id uuid, p_assessment text, p_proposed_action text, p_reason text
)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_g grievance.grievance;
begin
  v_g := grievance.lock_handled_grievance(p_grievance_id);
  -- G3b (N9): a secretary who took part in the case's Investigation Committee neither assesses nor decides its
  -- grievance; another secretary of the Grievance Committee does.
  if authz.participated_in_investigation_committee(v_actor, v_g.case_id) then perform api._fail('FORBIDDEN'); end if;
  if v_g.status <> 'RECEIVED' then perform api._fail('CONFLICT', 'GRIEVANCE_NOT_RECEIVED'); end if;
  if p_assessment is null or p_assessment not in ('ADMISSIBLE', 'INADMISSIBLE') then
    perform api._fail('INVALID', 'assessment');
  end if;
  insert into grievance.admissibility_assessment (grievance_id, stage, assessment, proposed_action, decided_by_role,
                                                  reason, recorded_by)
  values (v_g.id, case when v_g.admissibility_decider = 'SECRETARY' then 'DECISION' else 'SECRETARY_ASSESSMENT' end,
          p_assessment, case when p_proposed_action is not null then api._require_text(p_proposed_action, 'proposed_action', 5, 4000) end,
          case when v_g.admissibility_decider = 'SECRETARY' then 'SECRETARY' end,
          api._require_text(p_reason, 'reason', 5, 2000), v_actor);
  perform audit.record_event('GRIEVANCE_ADMISSIBILITY_ASSESSED', 'BUSINESS', 'SUCCESS', v_g.case_id, 'grievance',
    v_g.id::text, null, jsonb_build_object('assessment', p_assessment, 'decider', v_g.admissibility_decider));
  if v_g.admissibility_decider = 'SECRETARY' then
    return grievance.apply_admissibility(v_g, p_assessment, v_actor);
  end if;
  update grievance.grievance set status = 'AWAITING_ADMISSIBILITY_DECISION', updated_at = now(), row_version = row_version + 1
   where id = v_g.id;
  return 'AWAITING_ADMISSIBILITY_DECISION';
end;
$$;

-- The Grievance Committee Chair (or deputy), cleared for the case, decides; under a COMMITTEE rule the Chair records
-- the Committee's decision with its reference.
create function api.decide_grievance_admissibility(
  p_grievance_id uuid, p_decision text, p_decision_reference text, p_reason text
)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_g grievance.grievance;
begin
  select * into v_g from grievance.grievance g where g.id = p_grievance_id;
  if v_g.id is null or not authz.can_view_grievance(v_g.id) then
    -- The Chair reaches only grievances awaiting their decision, cleared for the case.
    if v_g.id is null
       or not (coalesce(authz.user_committee_seat(v_actor, grievance.committee_id(), now()) in ('CHAIR', 'DEPUTY_CHAIR'), false)
               and authz.user_case_gate(v_actor, v_g.case_id)
               and v_g.status = 'AWAITING_ADMISSIBILITY_DECISION') then
      perform api._fail('NOT_FOUND');
    end if;
  end if;
  -- G3 (N9): a chair who took part in the case's Investigation Committee does not decide its grievance.
  if not coalesce(authz.user_committee_seat(v_actor, grievance.committee_id(), now()) in ('CHAIR', 'DEPUTY_CHAIR'), false)
     or not authz.user_case_gate(v_actor, v_g.case_id)
     or authz.participated_in_investigation_committee(v_actor, v_g.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  select * into v_g from grievance.grievance g where g.id = p_grievance_id for update;
  if v_g.status <> 'AWAITING_ADMISSIBILITY_DECISION' then perform api._fail('CONFLICT', 'NOT_AWAITING_DECISION'); end if;
  if p_decision is null or p_decision not in ('ADMISSIBLE', 'INADMISSIBLE') then perform api._fail('INVALID', 'decision'); end if;
  if v_g.admissibility_decider = 'COMMITTEE' and p_decision_reference is null then
    perform api._fail('INVALID', 'decision_reference');
  end if;
  insert into grievance.admissibility_assessment (grievance_id, stage, assessment, decision_reference, decided_by_role,
                                                  reason, recorded_by)
  values (v_g.id, 'DECISION', p_decision,
          case when p_decision_reference is not null then api._require_text(p_decision_reference, 'decision_reference', 3, 300) end,
          v_g.admissibility_decider, api._require_text(p_reason, 'reason', 5, 2000), v_actor);
  perform audit.record_event('GRIEVANCE_ADMISSIBILITY_DECIDED', 'BUSINESS', 'SUCCESS', v_g.case_id, 'grievance',
    v_g.id::text, null, jsonb_build_object('decision', p_decision, 'decider', v_g.admissibility_decider));
  return grievance.apply_admissibility(v_g, p_decision, v_actor);
end;
$$;

-- Q95–Q96: the Grievance Committee's outcome, bound to an APPROVED vote in a meeting of the grievance's proceeding.
-- Outcomes combine unless they contradict; a return for reinvestigation names its path and opens a REINVESTIGATION
-- proceeding under the grievance proceeding.
create function api.record_grievance_outcome(
  p_grievance_id uuid, p_outcomes text[], p_reinvestigation_path text, p_vote_item_id uuid, p_summary text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_g grievance.grievance;
  v_outcomes text[] := coalesce(p_outcomes, '{}');
  v_proceeding uuid;
  v_reinvestigation case_mgmt.proceeding;
  v_id uuid;
begin
  v_g := grievance.lock_handled_grievance(p_grievance_id);
  if v_g.status <> 'ADMITTED' then perform api._fail('CONFLICT', 'GRIEVANCE_NOT_ADMITTED'); end if;
  if cardinality(v_outcomes) = 0
     or not (v_outcomes <@ array['UPHOLD', 'MODIFY', 'CANCEL', 'RETURN_FOR_REINVESTIGATION', 'REQUEST_COMPLETION',
                                 'REJECT_ON_MERITS', 'PARTIALLY_ACCEPT', 'CORRECTIVE_ACTION', 'DISCIPLINARY_ACTION',
                                 'OTHER_AUTHORIZED_OUTCOME']::text[])
     or (select count(distinct x) from unnest(v_outcomes) x) <> cardinality(v_outcomes)
     -- Contradictions: upholding or rejecting on the merits cannot also change the decision.
     or (v_outcomes && array['UPHOLD', 'REJECT_ON_MERITS']::text[]
         and v_outcomes && array['MODIFY', 'CANCEL', 'PARTIALLY_ACCEPT', 'RETURN_FOR_REINVESTIGATION']::text[])
     or ('MODIFY' = any (v_outcomes) and 'CANCEL' = any (v_outcomes)) then
    perform api._fail('INVALID', 'outcomes');
  end if;
  if ('RETURN_FOR_REINVESTIGATION' = any (v_outcomes)) <> (p_reinvestigation_path is not null)
     or (p_reinvestigation_path is not null and p_reinvestigation_path not in (
           'SAME_INVESTIGATION_COMMITTEE', 'NEW_INTERNAL_TEAM', 'NEW_INVESTIGATOR', 'EXTERNAL_INVESTIGATOR',
           'TECHNICAL_INVESTIGATION', 'GRIEVANCE_COMMITTEE_FACT_FINDING', 'OTHER')) then
    perform api._fail('INVALID', 'reinvestigation_path');
  end if;
  if not exists (select 1 from committee.vote_item vi
                 join committee.meeting m on m.id = vi.meeting_id
                 where vi.id = p_vote_item_id and m.committee_proceeding_id = v_g.committee_proceeding_id
                   and vi.status = 'CLOSED' and vi.result = 'APPROVED') then
    perform api._fail('INVALID', 'vote_item_id');
  end if;
  if exists (select 1 from grievance.grievance_outcome o where o.vote_item_id = p_vote_item_id) then
    perform api._fail('CONFLICT', 'VOTE_ALREADY_USED');
  end if;
  perform 1 from case_mgmt.case_record c where c.id = v_g.case_id for update;
  if p_reinvestigation_path is not null then
    select cp.proceeding_id into v_proceeding from committee.committee_proceeding cp where cp.id = v_g.committee_proceeding_id;
    v_reinvestigation := case_mgmt.insert_proceeding(v_g.case_id, 'REINVESTIGATION', v_proceeding, v_actor);
  end if;
  insert into grievance.grievance_outcome (grievance_id, outcomes, reinvestigation_path, reinvestigation_proceeding_id,
                                           vote_item_id, summary, recorded_by)
  values (v_g.id, v_outcomes, p_reinvestigation_path, v_reinvestigation.id, p_vote_item_id,
          api._require_text(p_summary, 'summary', 10, 4000), v_actor)
  returning id into v_id;
  update grievance.grievance set status = 'DECIDED', updated_at = now(), row_version = row_version + 1 where id = v_g.id;
  perform audit.record_event('GRIEVANCE_DECIDED', 'BUSINESS', 'SUCCESS', v_g.case_id, 'grievance', v_g.id::text, null,
    jsonb_build_object('outcomes', to_jsonb(v_outcomes), 'reinvestigation_path', p_reinvestigation_path,
                       'reinvestigation_proceeding_id', v_reinvestigation.id, 'vote_item_id', p_vote_item_id));
  return v_id;
end;
$$;

grant execute on function
  api.link_subject_portal_account(uuid, uuid, text),
  api.revoke_subject_portal_link(uuid, text),
  api.issue_defence_notice(uuid, text, uuid[], timestamptz),
  api.my_defence_notices(),
  api.acknowledge_defence_notice(uuid),
  api.submit_defence_response(uuid, text),
  api.record_defence_response(uuid, text, timestamptz, text, text),
  api.file_grievance(uuid, timestamptz, text),
  api.record_grievance(text, text, text, text, core.classification_level, uuid, text, timestamptz, timestamptz, text, text),
  api.approve_restricted_grievance_recording(uuid, uuid, text),
  api.approve_restricted_grievance_handling(uuid, uuid, text),
  api.assess_grievance_admissibility(uuid, text, text, text),
  api.decide_grievance_admissibility(uuid, text, text, text),
  api.record_grievance_outcome(uuid, text[], text, uuid, text)
to authenticated;
