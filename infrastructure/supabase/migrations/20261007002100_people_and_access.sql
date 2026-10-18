-- =============================================================================
-- 2100 People and access (Rebase PR-C; CDF-251)
-- Requirements: §18–§23, §29, §39, §65, §82, §83, §87; ambiguity rows AMB-017 (R4), AMB-022 (R2), AMB-023 (R3),
-- AMB-044 (R4), AMB-121 (R3) and AMB-205 (R2); placement confirmed by the coordinator on 2026-10-15 (PR-C split: 2100
-- people and access, ADR-046; "AMB-022 EXTERNAL_EXPERT task type goes in as a task type only, with no new permission";
-- "AMB-017 and AMB-023 delegation: build them only if they grant no access that the person did not already hold; a
-- delegation that confers the delegator's access on the delegate is a widening and its grant half moves to 2160");
-- coordinator rulings (nothing widened before 2160; restricted-case access never grows without its authority; reasons
-- never in audit metadata)
--
-- Every row here narrows, records or flags. No one gains a permission, a role grant or a way into a case.
--
-- This migration adds:
--   1. AMB-044. A committee is deactivated, or reactivated, by COMMITTEE_ADMIN citing the governance decision, kept as
--      an append-only status change. A deactivated committee opens no proceeding and receives no referral or
--      grievance, on every path (T-AMB-022). Nothing is transferred: COMMITTEE_TRANSFER_RULE is SOURCE_REQUIRED, so a
--      committee with open work is not deactivated.
--   2. AMB-205. A lost continuity workbook is revoked on its case by a member who imports or approves workbooks,
--      citing the incident: no copy of it is staged, and a batch already staged goes no further than STAGED (it can
--      only be rejected or cancelled; T-AMB-122). The revocation is permanent; importing a found copy after review
--      needs a lifting rule that is not decided.
--   3. AMB-121. A LEGAL_REVIEWER account holding nothing else is flagged as external counsel by a role administrator,
--      one way. A flagged account holds no permission but LEGAL_OPINION_GIVE, passes no case gate, reads only its own
--      directory row, and is refused any other role, assignment, grant, seat, sector position or portal link at the
--      table. It reaches the legal-review packets assigned to it only while EXTERNAL_COUNSEL_ENABLED is true (false
--      by default, CONFIGURED: the fail-safe owner default; T-AMB-071).
--   4. AMB-022. An EXTERNAL_EXPERT role with no permission, and an EXTERNAL_EXPERT task type that confers the case's
--      metadata only, for at most 30 days.
--   5. AMB-017. An URGENT flag on an ACTIVE case with a mandatory reason, raised or cleared by someone who sees the
--      case and edits it or prepares preliminary reviews. Each active GRC Director who can already open the case, other
--      than the person who flagged it, is told by template code and case id (T-AMB-007); the flag records how many
--      were told. It never transfers the case or changes access. URGENT_ESCALATION_CRITERIA is SOURCE_REQUIRED.
--   6. AMB-023. A GRC Sector Head delegates preliminary approval on record: time-bound, forward-dated, evidenced,
--      audited and revocable, with MAX_PRELIMINARY_APPROVAL_DELEGATION_DAYS SOURCE_REQUIRED (enforced once
--      configured). The record grants nothing: api.approve_preliminary_recommendation is unchanged, so a delegate
--      approves nothing (T-AMB-010). The grant half waits for 2160.
--
-- Additive: five tables, one notification template, three settings, one role and one task type, eight api functions,
-- authz.current_user_is_external and their helper and trigger functions. Replaced with narrowing-only changes, keeping
-- their signatures: authz.has_permission and authz.user_has_permission (0300), authz.user_can_view_case and
-- authz.user_case_gate (1700), authz.can_view_packet, api.give_legal_opinion and api.give_superseding_legal_opinion
-- (2030), api.request_legal_review and api.approve_restricted_legal_review (2099), and their mirrors
-- decision.legal_opinion_refusal and decision.superseding_opinion_refusal (2095) (the reviewer's case gate becomes the
-- packet gate, the same for every account that is not external), and api.bcp_import_batch_view (2040; it says whether
-- the workbook is revoked and its capabilities follow); the user_profile_directory policy (0300) is narrowed. The case
-- task category check gains EXPERT (no value removed). No permission or role grant changes for an existing role; no
-- catalogue code, status or option code is renamed or removed (DEC-35). Not built: transferring a committee's open
-- work, lifting a workbook revocation, the delegate's authority (2160), and the screens and read models for these
-- commands (Phase 12).
-- =============================================================================

-- =============================================================================
-- 1. Committee deactivation (AMB-044)
-- =============================================================================
-- A deactivated committee opens no new proceeding and receives no referral or grievance. Moving open work to another
-- committee needs the governance decision that dissolves it (COMMITTEE_TRANSFER_RULE, SOURCE_REQUIRED), so nothing is
-- moved: a committee with open work is not deactivated. Every change of status names the decision and is kept.
create table committee.committee_status_change (
  id                 uuid primary key default gen_random_uuid(),
  committee_id       uuid not null references committee.committee (id),
  -- The committee's status after the change.
  is_active          boolean not null,
  decision_reference text not null check (length(decision_reference) between 3 and 200),
  reason             text not null check (length(reason) between 10 and 2000),
  changed_by         uuid not null references iam.user_profile (id),
  changed_at         timestamptz not null default clock_timestamp()
);
create index committee_status_change_committee on committee.committee_status_change (committee_id, changed_at);
create index committee_status_change_changed_by on committee.committee_status_change (changed_by);
comment on table committee.committee_status_change is
  'Each deactivation and reactivation of a committee with its decision reference (AMB-044; migration 2100). Append-only.';
create trigger no_update before update on committee.committee_status_change
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on committee.committee_status_change
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on committee.committee_status_change
  for each statement execute function committee.reject_mutation();
alter table committee.committee_status_change enable row level security;
create policy committee_status_change_read on committee.committee_status_change for select to authenticated
  using (authz.can_view_committee_registry(committee_id));
grant select on committee.committee_status_change to authenticated;

-- 1.1 What a committee still has open: a proceeding, a referral on its way to it (until accepted or withdrawn), or a
-- grievance under one of its rule sets that is not yet decided, inadmissible or withdrawn.
create function committee.open_work(p_committee_id uuid)
returns int
language sql stable
set search_path = ''
as $$
  select ((select count(*) from committee.committee_proceeding p
           where p.committee_id = p_committee_id and p.status = 'OPEN')
        + (select count(*) from intake.referral r
           where r.committee_id = p_committee_id and r.status not in ('ACCEPTED', 'WITHDRAWN'))
        + (select count(*) from grievance.grievance g join committee.rule_set rs on rs.id = g.rule_set_id
           where rs.committee_id = p_committee_id
             and g.status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED')))::int;
$$;

-- 1.2 The backstop: the commands that open a proceeding or file a referral or grievance already look for an active
-- committee; this holds on every path, the table owner's included. The committee row is share-locked, so a
-- deactivation running at the same time either sees the new row as open work or is seen as done.
create function committee.require_active_committee()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_committee uuid;
  v_active boolean;
begin
  if tg_table_name = 'grievance' then
    select rs.committee_id into v_committee from committee.rule_set rs where rs.id = new.rule_set_id;
  else
    v_committee := new.committee_id;
  end if;
  select c.is_active into v_active from committee.committee c where c.id = v_committee for share;
  if not coalesce(v_active, false) then perform api._fail('CONFLICT', 'COMMITTEE_INACTIVE'); end if;
  return new;
end;
$$;
create trigger committee_proceeding_active_committee before insert on committee.committee_proceeding
  for each row execute function committee.require_active_committee();
create trigger referral_active_committee before insert on intake.referral
  for each row execute function committee.require_active_committee();
create trigger grievance_active_committee before insert on grievance.grievance
  for each row execute function committee.require_active_committee();

-- 1.3 Deactivation, by COMMITTEE_ADMIN, citing the governance decision. Refused while anything is open (nothing is
-- transferred; COMMITTEE_TRANSFER_RULE is SOURCE_REQUIRED).
create function api.deactivate_committee(p_committee_id uuid, p_decision_reference text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v committee.committee;
  v_ref text;
  v_reason text;
  v_id uuid;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_committee_id is null then perform api._fail('NOT_FOUND'); end if;
  v := committee.lock_committee(p_committee_id);
  if not v.is_active then perform api._fail('CONFLICT', 'COMMITTEE_INACTIVE'); end if;
  v_ref := api._require_text(p_decision_reference, 'decision_reference', 3, 200);
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  if committee.open_work(v.id) > 0 then perform api._fail('CONFLICT', 'COMMITTEE_HAS_OPEN_WORK'); end if;
  update committee.committee set is_active = false where id = v.id;
  insert into committee.committee_status_change (committee_id, is_active, decision_reference, reason, changed_by)
  values (v.id, false, v_ref, v_reason, v_actor)
  returning id into v_id;
  perform audit.record_event('COMMITTEE_DEACTIVATED', 'ADMIN', 'SUCCESS', null, 'committee', v.id::text, null,
    jsonb_build_object('status_change_id', v_id, 'committee_code', v.code));
  return v_id;
end;
$$;

-- 1.4 Reactivation, the same way, after the governance decision that reconstitutes it: it restores what the committee
-- could do before and gives no one access. It reappoints nobody (neither command touches a seat; every member comes
-- back only through api.appoint_committee_member) and leaves snapshotted visibility as it was (coordinator, 08:16).
create function api.reactivate_committee(p_committee_id uuid, p_decision_reference text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v committee.committee;
  v_ref text;
  v_reason text;
  v_id uuid;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_committee_id is null then perform api._fail('NOT_FOUND'); end if;
  v := committee.lock_committee(p_committee_id);
  if v.is_active then perform api._fail('CONFLICT', 'COMMITTEE_ACTIVE'); end if;
  v_ref := api._require_text(p_decision_reference, 'decision_reference', 3, 200);
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  update committee.committee set is_active = true where id = v.id;
  insert into committee.committee_status_change (committee_id, is_active, decision_reference, reason, changed_by)
  values (v.id, true, v_ref, v_reason, v_actor)
  returning id into v_id;
  perform audit.record_event('COMMITTEE_REACTIVATED', 'ADMIN', 'SUCCESS', null, 'committee', v.id::text, null,
    jsonb_build_object('status_change_id', v_id, 'committee_code', v.code));
  return v_id;
end;
$$;

-- =============================================================================
-- 2. Revoking a lost continuity workbook (AMB-205)
-- =============================================================================
-- A lost workbook is reported as an incident and its id is revoked on the case, so no copy of it is staged again and a
-- batch already staged from it goes no further than STAGED: it can only be rejected or cancelled. Importing a found
-- copy after review needs a lifting rule (who reviews, on what evidence) that is not decided; the revocation stays.
create table exchange.bcp_workbook_revocation (
  id                 uuid primary key default gen_random_uuid(),
  case_id            uuid not null references case_mgmt.case_record (id),
  workbook_id        text not null
                       check (workbook_id ~ '^(BCP-[A-Z0-9][A-Z0-9-]{0,59}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  incident_reference text not null check (length(incident_reference) between 3 and 200),
  reason             text not null check (length(reason) between 10 and 2000),
  revoked_by         uuid not null references iam.user_profile (id),
  revoked_at         timestamptz not null default clock_timestamp()
);
create unique index bcp_workbook_revocation_once on exchange.bcp_workbook_revocation (case_id, lower(workbook_id));
create index bcp_workbook_revocation_revoked_by on exchange.bcp_workbook_revocation (revoked_by);
comment on table exchange.bcp_workbook_revocation is
  'A continuity workbook reported lost and revoked on its case (AMB-205; migration 2100); no batch of it goes past '
  'STAGED. Append-only.';
create trigger no_update before update on exchange.bcp_workbook_revocation
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on exchange.bcp_workbook_revocation
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on exchange.bcp_workbook_revocation
  for each statement execute function committee.reject_mutation();
alter table exchange.bcp_workbook_revocation enable row level security;
-- The case team members who import or approve workbooks on the case.
create policy bcp_workbook_revocation_read on exchange.bcp_workbook_revocation for select to authenticated
  using (authz.can_view_case(case_id)
         and (authz.has_permission('BCP_IMPORT') or authz.has_permission('BCP_IMPORT_APPROVE')));
grant select on exchange.bcp_workbook_revocation to authenticated;

create function exchange.workbook_revoked(p_case_id uuid, p_workbook_id text)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from exchange.bcp_workbook_revocation r
                 where r.case_id = p_case_id and lower(r.workbook_id) = lower(p_workbook_id));
$$;

-- 2.1 On every path, the table owner's included: a revoked workbook is not staged, and a batch of it is not
-- submitted, approved or imported.
create function exchange.refuse_revoked_workbook()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exchange.workbook_revoked(new.case_id, new.workbook_id) then perform api._fail('CONFLICT', 'WORKBOOK_REVOKED'); end if;
  return new;
end;
$$;
create trigger bcp_import_batch_revoked before insert on exchange.bcp_import_batch
  for each row execute function exchange.refuse_revoked_workbook();
create trigger bcp_import_batch_revoked_progress before update of status on exchange.bcp_import_batch
  for each row when (new.status in ('SUBMITTED', 'APPROVED', 'IMPORTED') and new.status is distinct from old.status)
  execute function exchange.refuse_revoked_workbook();

-- 2.2 The revocation: by a case team member who imports or approves workbooks, citing the incident. The workbook need
-- not have been staged. It takes the staging lock of the same workbook, so a staging running at the same time either
-- sees it or is seen as open (and then goes no further).
create function api.revoke_bcp_workbook(p_case_id uuid, p_workbook_id text, p_incident_reference text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_ref text;
  v_reason text;
  v_open int;
  v_id uuid;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not (authz.has_permission('BCP_IMPORT') or authz.has_permission('BCP_IMPORT_APPROVE')) then
    perform api._fail('FORBIDDEN');
  end if;
  if p_workbook_id is null
     or p_workbook_id !~ '^(BCP-[A-Z0-9][A-Z0-9-]{0,59}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
    perform api._fail('INVALID', 'workbook_id');
  end if;
  v_ref := api._require_text(p_incident_reference, 'incident_reference', 3, 200);
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  perform pg_advisory_xact_lock(hashtext('exchange.bcp_import:' || p_case_id || ':' || p_workbook_id));
  if exchange.workbook_revoked(p_case_id, p_workbook_id) then perform api._fail('CONFLICT', 'WORKBOOK_REVOKED'); end if;
  select count(*)::int into v_open from exchange.bcp_import_batch b
  where b.case_id = p_case_id and lower(b.workbook_id) = lower(p_workbook_id)
    and b.status in ('STAGED', 'SUBMITTED', 'APPROVED');
  insert into exchange.bcp_workbook_revocation (case_id, workbook_id, incident_reference, reason, revoked_by)
  values (p_case_id, p_workbook_id, v_ref, v_reason, v_actor)
  returning id into v_id;
  -- Ids and counts only: the case trail records the revocation, and the lost workbook is reported as a security
  -- incident for security monitoring (as an integrity failure is, 2050).
  perform audit.record_event('BCP_WORKBOOK_REVOCATION_RECORDED', 'BUSINESS', 'SUCCESS', p_case_id,
    'bcp_workbook_revocation', v_id::text, null, jsonb_build_object('open_batches', v_open));
  perform audit.record_event('BCP_WORKBOOK_REVOKED', 'SECURITY', 'SUCCESS', p_case_id, 'bcp_workbook_revocation',
    v_id::text, null, jsonb_build_object('open_batches', v_open));
  return v_id;
end;
$$;

-- 2.3 The batch view (2040) says whether the workbook is revoked, and its capabilities follow the refusals.
create or replace function api.bcp_import_batch_view(p_batch_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_me uuid := authz.current_user_id();
  b exchange.bcp_import_batch;
  v_hash text;
  v_own boolean;
  v_resolvable boolean;
  v_approver boolean;
  v_metadata boolean;
  v_revoked boolean;
begin
  if p_batch_id is null or not authz.can_view_bcp_import(p_batch_id) then perform api._fail('NOT_FOUND'); end if;
  select * into b from exchange.bcp_import_batch x where x.id = p_batch_id;
  v_hash := exchange.bcp_batch_hash(b.id);
  -- exchange.lock_bcp_batch(own) as replaced in item 10: the importer, holding BCP_IMPORT, an authorized operator.
  v_own := b.imported_by = v_me and authz.has_permission('BCP_IMPORT') and exchange.is_continuity_operator(v_me);
  v_resolvable := v_own and b.status = 'STAGED';
  -- api.decide_bcp_import: BCP_IMPORT_APPROVE, never the importer, the workbook's preparer or an offline recorder.
  v_approver := authz.has_permission('BCP_IMPORT_APPROVE') and b.imported_by <> v_me
                and b.prepared_by is distinct from v_me
                and not exists (select 1 from exchange.bcp_import_row r
                                where r.batch_id = b.id and r.recorded_offline_by = v_me);
  v_metadata := authz.can_view_case_metadata(b.case_id);
  -- exchange.refuse_revoked_workbook (2100, AMB-205): a revoked workbook goes no further than STAGED, REJECTED or
  -- CANCELLED.
  v_revoked := exchange.workbook_revoked(b.case_id, b.workbook_id);
  return jsonb_build_object(
    'batch_id', b.id, 'template_version', b.template_version, 'workbook_id', b.workbook_id,
    'file_sha256', b.file_sha256, 'offline_from', b.offline_from, 'offline_to', b.offline_to,
    'prepared_by', b.prepared_by, 'status', b.status, 'preview_hash', b.preview_hash, 'previewed_at', b.previewed_at,
    'preview_clean', b.preview_clean, 'submitted_hash', b.submitted_hash, 'imported_by', b.imported_by,
    'decided_by', b.decided_by, 'decision_reason', b.decision_reason, 'created_at', b.created_at,
    'submitted_at', b.submitted_at, 'decided_at', b.decided_at, 'applied_at', b.applied_at,
    'cancelled_at', b.cancelled_at, 'updated_at', b.updated_at, 'row_version', b.row_version,
    'current_hash', v_hash,
    'workbook_revoked', v_revoked,
    'counts', (select jsonb_build_object(
                        'rows', count(*),
                        'unresolved', count(*) filter (where r.resolution is null and r.state <> 'ALREADY_IMPORTED'),
                        'by_state', coalesce((select jsonb_object_agg(s.state, s.n)
                                              from (select r2.state, count(*) as n from exchange.bcp_import_row r2
                                                    where r2.batch_id = b.id group by r2.state) s), '{}'::jsonb))
               from exchange.bcp_import_row r where r.batch_id = b.id),
    -- bcp_import_row_read: row metadata, never the cells.
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'row_id', r.id, 'sheet_code', r.sheet_code, 'row_number', r.row_number, 'row_key', r.row_key,
               'state', r.state, 'detail', r.detail, 'resolution', r.resolution,
               'resolution_reason', r.resolution_reason, 'resolved_by', r.resolved_by, 'resolved_at', r.resolved_at,
               'outcome', r.outcome, 'original_event_at', r.original_event_at,
               'recorded_offline_by', r.recorded_offline_by, 'purged_at', r.purged_at,
               -- api.resolve_bcp_row: SKIP is open to every row that is not already imported.
               'may_resolve', v_resolvable and r.state <> 'ALREADY_IMPORTED')
             order by s.position, r.row_number)
      from exchange.bcp_import_row r
      join exchange.bcp_template_sheet s on s.template_version = r.template_version and s.sheet_code = r.sheet_code
      where r.batch_id = b.id), '[]'::jsonb),
    'case', jsonb_build_object(
      'case_id', case when v_metadata then b.case_id end,
      'case_number', case when v_metadata then (select c.case_number from case_mgmt.case_record c where c.id = b.case_id) end),
    'capabilities', jsonb_build_object(
      'may_resolve_rows', coalesce(v_resolvable and exists (select 1 from exchange.bcp_import_row r
                                                            where r.batch_id = b.id and r.state <> 'ALREADY_IMPORTED'),
                                   false),
      -- api.preview_bcp_import.
      'may_preview', coalesce(v_own, false),
      -- api.submit_bcp_import: every row resolved and the batch unchanged since a clean preview. The dry run it
      -- repeats writes, so it cannot run in a read: the stored preview result stands in for it.
      'may_submit', coalesce(v_resolvable
                             and not exists (select 1 from exchange.bcp_import_row r
                                             where r.batch_id = b.id and r.resolution is null
                                               and r.state <> 'ALREADY_IMPORTED')
                             and b.preview_hash = v_hash and b.preview_clean and not v_revoked, false),
      -- api.decide_bcp_import (APPROVE or REJECT), on the batch as submitted.
      'may_decide', coalesce(v_approver and b.status = 'SUBMITTED' and v_hash = b.submitted_hash, false),
      -- ... and APPROVE only while the workbook is not revoked (REJECT stays open).
      'may_approve', coalesce(v_approver and b.status = 'SUBMITTED' and v_hash = b.submitted_hash and not v_revoked,
                              false),
      -- api.apply_bcp_import.
      'may_apply', coalesce(v_own and b.status = 'APPROVED' and v_hash = b.submitted_hash and not v_revoked, false),
      -- api.cancel_bcp_import.
      'may_cancel', coalesce(v_own and b.status in ('STAGED', 'SUBMITTED', 'APPROVED'), false)));
end;
$$;
comment on function api.bcp_import_batch_view(uuid) is
  'Purpose read model of one continuity import batch (migration 2040 item 13): NOT_FOUND unless '
  'authz.can_view_bcp_import; row metadata, never the cells or the control; capabilities from the commands. Since '
  '2100 (AMB-205): whether the workbook is revoked; may_approve is may_decide without a revocation.';

-- =============================================================================
-- 3. External counsel accounts (AMB-121)
-- =============================================================================
-- External counsel act through a LEGAL_REVIEWER account flagged external, which reaches only the legal-review packets
-- assigned to it, and only while EXTERNAL_COUNSEL_ENABLED is true (fail-safe default false; engaging a firm is a
-- procurement decision, and anything sent by email goes through the governed export). The flag is one-way. A flagged
-- account:
--   * holds no permission but LEGAL_OPINION_GIVE, and that one only while enabled (authz.has_permission,
--     authz.user_has_permission);
--   * passes no case gate (authz.user_case_gate, authz.user_can_view_case), so no assignment, grant, task, seat,
--     break-glass or role reaches a case for it; the legal-review packet has its own gate (authz.user_packet_gate);
--   * holds no role but LEGAL_REVIEWER and is given no case assignment, case grant, committee seat, sector position or
--     portal link (refused at the table, on every path);
--   * reads only its own row of the user directory.
insert into config.setting (key, value, status, source_reference, description) values
  ('EXTERNAL_COUNSEL_ENABLED', 'false', 'CONFIGURED', 'AMB-121 fail-safe default (owner default, R3)',
   'AMB-121: whether an account flagged as external counsel may act on the legal-review packets assigned to it. '
   'Fail-safe default false: anything but ''true'' keeps every flagged account out. Set to true only with the '
   'engagement decision, cited in source_reference.');

create table iam.external_account (
  user_id              uuid primary key references iam.user_profile (id),
  engagement_reference text not null check (length(engagement_reference) between 3 and 200),
  reason               text not null check (length(reason) between 10 and 2000),
  flagged_by           uuid not null references iam.user_profile (id),
  flagged_at           timestamptz not null default clock_timestamp(),
  check (flagged_by <> user_id)
);
create index external_account_flagged_by on iam.external_account (flagged_by);
comment on table iam.external_account is
  'Accounts of external counsel (AMB-121; migration 2100): packet-only access while EXTERNAL_COUNSEL_ENABLED is '
  'true, nothing otherwise. One-way. Append-only.';
create trigger no_update before update on iam.external_account
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on iam.external_account
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on iam.external_account
  for each statement execute function committee.reject_mutation();
alter table iam.external_account enable row level security;
create policy external_account_read on iam.external_account for select to authenticated
  using (user_id = authz.current_user_id() or authz.has_permission('ROLE_ADMIN'));
grant select on iam.external_account to authenticated;

-- True only when configured exactly 'true' (a missing or other value keeps external accounts out, fail safe).
create function authz.external_counsel_enabled()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from config.setting s
                 where s.key = 'EXTERNAL_COUNSEL_ENABLED' and s.status = 'CONFIGURED' and s.value = 'true');
$$;

create function authz.is_external_account(p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from iam.external_account x where x.user_id = p_user_id);
$$;

-- For the directory policy: about the caller only.
create function authz.current_user_is_external()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_external_account(authz.current_user_id());
$$;

-- 3.1 Permissions (as in 0300): an external account holds LEGAL_OPINION_GIVE only, and only while enabled.
create or replace function authz.has_permission(p_permission text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from iam.user_role_assignment a
    join iam.role_permission rp on rp.role_code = a.role_code
    where a.user_id = authz.current_user_id()
      and a.status = 'ACTIVE'
      and a.effective_from <= current_date
      and (a.effective_to is null or a.effective_to >= current_date)
      and rp.permission_code = p_permission
      and not exists (select 1 from iam.external_account x
                      where x.user_id = a.user_id
                        and (rp.permission_code <> 'LEGAL_OPINION_GIVE' or not authz.external_counsel_enabled()))
  );
$$;

create or replace function authz.user_has_permission(p_user_id uuid, p_permission text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from iam.user_profile p
    join iam.user_role_assignment a on a.user_id = p.id
    join iam.role_permission rp on rp.role_code = a.role_code
    where p.id = p_user_id
      and p.status = 'ACTIVE'
      and a.status = 'ACTIVE'
      and a.effective_from <= current_date
      and (a.effective_to is null or a.effective_to >= current_date)
      and rp.permission_code = p_permission
      and not exists (select 1 from iam.external_account x
                      where x.user_id = p.id
                        and (rp.permission_code <> 'LEGAL_OPINION_GIVE' or not authz.external_counsel_enabled()))
  );
$$;

-- 3.2 The case gate and content access (as in 1700) pass no external account. The packet gate is the case gate
-- with an external account let through while enabled; for every other account the two are the same.
create or replace function authz.user_can_view_case(p_user_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from case_mgmt.case_record c
    join iam.user_profile u on u.id = p_user_id and u.status = 'ACTIVE'
    where c.id = p_case_id
      and c.records_state <> 'DISPOSED'
      and c.classification <= u.clearance
      and not authz.has_conflict(c.id, u.id)
      and not exists (select 1 from iam.external_account x where x.user_id = u.id)
      and (
        (not c.is_restricted and authz.user_has_permission(u.id, 'CASE_VIEW_ALL'))
        or authz.has_active_assignment(c.id, u.id)
        or authz.has_active_grant(c.id, u.id)
        or authz.has_active_break_glass(c.id, u.id)
      )
  );
$$;

create or replace function authz.user_case_gate(p_user_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from case_mgmt.case_record c
    join iam.user_profile u on u.id = p_user_id and u.status = 'ACTIVE'
    where c.id = p_case_id and c.classification <= u.clearance and not authz.has_conflict(c.id, u.id)
      and not exists (select 1 from iam.external_account x where x.user_id = u.id)
  );
$$;

create function authz.user_packet_gate(p_user_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from case_mgmt.case_record c
    join iam.user_profile u on u.id = p_user_id and u.status = 'ACTIVE'
    where c.id = p_case_id and c.classification <= u.clearance and not authz.has_conflict(c.id, u.id)
      and (not exists (select 1 from iam.external_account x where x.user_id = u.id)
           or authz.external_counsel_enabled())
  );
$$;

-- 3.3 The directory (0300): an external account reads its own row only.
alter policy user_profile_directory on iam.user_profile
  using (authz.current_user_id() is not null and (id = authz.current_user_id() or not authz.current_user_is_external()));

-- 3.4 The legal review path as main last defined it (2030; the request and the restricted approval as in 2099), with
-- the reviewer's gate replaced by the packet gate: for every account that is not external the two are the same; an
-- external account passes only while EXTERNAL_COUNSEL_ENABLED is true.
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
               and authz.user_packet_gate(authz.current_user_id(), k.case_id)
               and exists (select 1 from decision.legal_review_request r
                           where r.id = k.legal_review_request_id and r.assigned_to = authz.current_user_id()
                             and r.status <> 'CANCELLED'
                             and not exists (select 1 from decision.authority_decision d
                                             where d.package_id = r.package_id and d.package_round >= r.package_round
                                               and d.recorded_at + authz.purpose_access_grace() <= now()))))
  );
$$;

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
  if decision.package_tainted(v_p.id) then perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT'); end if;
  -- The reviewer holds the opinion permission and is cleared for the case; never the requester.
  if p_assigned_to is null or p_assigned_to = v_actor
     or not authz.user_has_permission(p_assigned_to, 'LEGAL_OPINION_GIVE')
     or not authz.user_packet_gate(p_assigned_to, v_p.case_id) then
    perform api._fail('INVALID', 'assigned_to');
  end if;
  if exists (select 1 from unnest(v_findings) x
             where not exists (select 1 from case_mgmt.finding f where f.id = x and f.case_id = v_p.case_id))
     or (select count(distinct x) from unnest(v_findings) x) <> cardinality(v_findings) then
    perform api._fail('INVALID', 'finding_ids');
  end if;
  -- 2099 (CDF-247): never a finding of a withdrawn allegation (as R1 and CDF-213).
  if exists (select 1 from unnest(v_findings) x
             join case_mgmt.finding f on f.id = x
             join case_mgmt.allegation a on a.id = f.allegation_id
             where a.status = 'WITHDRAWN') then
    perform api._fail('CONFLICT', 'ALLEGATION_WITHDRAWN');
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

create or replace function api.approve_restricted_legal_review(
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
     or not authz.user_packet_gate(p_reviewer_id, v_p.case_id) then
    perform api._fail('INVALID', 'reviewer_id');
  end if;
  if exists (select 1 from unnest(v_findings) x
             where not exists (select 1 from case_mgmt.finding f where f.id = x and f.case_id = v_p.case_id))
     or (select count(distinct x) from unnest(v_findings) x) <> cardinality(v_findings) then
    perform api._fail('INVALID', 'finding_ids');
  end if;
  -- 2099 (CDF-247): never a finding of a withdrawn allegation (as R1 and CDF-213).
  if exists (select 1 from unnest(v_findings) x
             join case_mgmt.finding f on f.id = x
             join case_mgmt.allegation a on a.id = f.allegation_id
             where a.status = 'WITHDRAWN') then
    perform api._fail('CONFLICT', 'ALLEGATION_WITHDRAWN');
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
                            and authz.user_packet_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_packet_gate(v_actor, v_r.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  perform 1 from decision.recommendation_package p where p.id = v_r.package_id for update;
  select * into v_r from decision.legal_review_request r where r.id = p_request_id for update;
  if v_r.status = 'CANCELLED' then perform api._fail('CONFLICT', 'REQUEST_CANCELLED'); end if;
  if v_r.status <> 'ASSIGNED' then perform api._fail('CONFLICT', 'OPINION_ALREADY_GIVEN'); end if;
  if decision.package_tainted(v_r.package_id) then perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT'); end if;
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

create or replace function api.give_superseding_legal_opinion(p_request_id uuid, p_opinion text, p_opinion_text text)
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
                            and authz.user_packet_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_packet_gate(v_actor, v_r.case_id) then
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
  if decision.package_tainted(v_p.id) then perform api._fail('CONFLICT', 'TAINTED_BY_CONFLICT'); end if;
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

-- 3.4, continued. The two opinion commands' mirrors in the reviewer's read model (2095, api.legal_review_view), as
-- 2095 with the reviewer's case gate replaced by the packet gate, as in the commands above, so each flag still
-- equals its command for an external account (the same for every other account).
create or replace function decision.legal_opinion_refusal(p_request_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_actor uuid := authz.current_user_id();
  v_r decision.legal_review_request;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_packet_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    return 'NOT_FOUND';
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_packet_gate(v_actor, v_r.case_id) then
    return 'FORBIDDEN';
  end if;
  if v_r.status = 'CANCELLED' then return 'REQUEST_CANCELLED'; end if;
  if v_r.status <> 'ASSIGNED' then return 'OPINION_ALREADY_GIVEN'; end if;
  if decision.package_tainted(v_r.package_id) then return 'TAINTED_BY_CONFLICT'; end if;
  return null;
end;
$$;

create or replace function decision.superseding_opinion_refusal(p_request_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_actor uuid := authz.current_user_id();
  v_r decision.legal_review_request;
  v_p decision.recommendation_package;
begin
  select * into v_r from decision.legal_review_request r where r.id = p_request_id;
  if v_r.id is null or not (v_r.assigned_to = v_actor and v_r.status <> 'CANCELLED'
                            and authz.user_packet_gate(v_actor, v_r.case_id))
                          and not authz.can_view_recommendation_package(v_r.package_id) then
    return 'NOT_FOUND';
  end if;
  if v_r.assigned_to <> v_actor or not authz.has_permission('LEGAL_OPINION_GIVE')
     or not authz.user_packet_gate(v_actor, v_r.case_id) then
    return 'FORBIDDEN';
  end if;
  if not exists (select 1 from decision.packet k where k.legal_review_request_id = v_r.id and authz.can_view_packet(k.id)) then
    return 'NOT_FOUND';
  end if;
  select * into v_p from decision.recommendation_package p where p.id = v_r.package_id;
  if v_r.status <> 'OPINION_GIVEN' then return 'OPINION_NOT_GIVEN'; end if;
  if v_p.status <> 'ADOPTED' or v_p.round_no <> v_r.package_round then return 'PACKAGE_NOT_ADOPTED'; end if;
  if decision.package_tainted(v_p.id) then return 'TAINTED_BY_CONFLICT'; end if;
  return null;
end;
$$;

-- 3.5 At the table, on every path: no role but LEGAL_REVIEWER, and no case assignment, case grant, committee seat,
-- sector position or portal link for an external account. The account row is share-locked first, so a flag recorded
-- at the same time either sees the new row as access held or is seen.
create function iam.refuse_external_account()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from iam.user_profile u where u.id = new.user_id for key share;
  if authz.is_external_account(new.user_id) then
    if tg_table_name = 'user_role_assignment' then
      if new.role_code <> 'LEGAL_REVIEWER' then perform api._fail('CONFLICT', 'EXTERNAL_ACCOUNT'); end if;
    else
      perform api._fail('CONFLICT', 'EXTERNAL_ACCOUNT');
    end if;
  end if;
  return new;
end;
$$;
create trigger user_role_assignment_external before insert on iam.user_role_assignment
  for each row execute function iam.refuse_external_account();
create trigger case_assignment_external before insert on case_mgmt.case_assignment
  for each row execute function iam.refuse_external_account();
create trigger case_access_grant_external before insert on case_mgmt.case_access_grant
  for each row execute function iam.refuse_external_account();
create trigger membership_external before insert on committee.membership
  for each row execute function iam.refuse_external_account();
create trigger sector_membership_external before insert on iam.sector_membership
  for each row execute function iam.refuse_external_account();
create trigger subject_portal_link_external before insert on grievance.subject_portal_link
  for each row execute function iam.refuse_external_account();

-- 3.6 Flagging, by a role administrator (never their own account), citing the engagement. Only an active account that
-- holds LEGAL_REVIEWER and no other role, and holds no case assignment, case grant, committee seat, sector position,
-- portal link or current delegation of preliminary approval (section 6), is flagged; what it holds is ended first
-- through its own command.
create function api.flag_external_counsel_account(p_user_id uuid, p_engagement_reference text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_ref text;
  v_reason text;
begin
  if not authz.has_permission('ROLE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_user_id = v_actor then perform api._fail('FORBIDDEN'); end if;
  perform 1 from iam.user_profile u where u.id = p_user_id and u.status = 'ACTIVE' for update;
  if not found then perform api._fail('INVALID', 'user_id'); end if;
  if authz.is_external_account(p_user_id) then perform api._fail('CONFLICT', 'ALREADY_EXTERNAL'); end if;
  v_ref := api._require_text(p_engagement_reference, 'engagement_reference', 3, 200);
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  if not authz.user_has_role(p_user_id, 'LEGAL_REVIEWER')
     or exists (select 1 from iam.user_role_assignment a
                where a.user_id = p_user_id and a.status = 'ACTIVE' and a.role_code <> 'LEGAL_REVIEWER'
                  and (a.effective_to is null or a.effective_to >= current_date)) then
    perform api._fail('CONFLICT', 'ROLES_NOT_ELIGIBLE');
  end if;
  if exists (select 1 from case_mgmt.case_assignment x where x.user_id = p_user_id and x.status = 'ACTIVE')
     or exists (select 1 from case_mgmt.case_access_grant x
                where x.user_id = p_user_id and x.status = 'ACTIVE' and (x.effective_to is null or x.effective_to > now()))
     or exists (select 1 from committee.membership x
                where x.user_id = p_user_id and (x.effective_to is null or x.effective_to > now()))
     or exists (select 1 from iam.sector_membership x
                where x.user_id = p_user_id and (x.effective_to is null or x.effective_to > now()))
     or exists (select 1 from grievance.subject_portal_link x where x.user_id = p_user_id and x.revoked_at is null)
     or exists (select 1 from iam.preliminary_approval_delegation x
                where x.delegate_id = p_user_id and x.revoked_at is null and x.effective_to > now()) then
    perform api._fail('CONFLICT', 'ACCOUNT_HOLDS_ACCESS');
  end if;
  insert into iam.external_account (user_id, engagement_reference, reason, flagged_by)
  values (p_user_id, v_ref, v_reason, v_actor);
  perform audit.record_event('EXTERNAL_COUNSEL_FLAGGED', 'ADMIN', 'SUCCESS', null, 'user_profile', p_user_id::text,
    null, '{}'::jsonb);
end;
$$;

-- =============================================================================
-- 4. An external or technical expert supports a review through a task only (AMB-022)
-- =============================================================================
-- The task model (ADR-014, 1700) is the authorisation: time-bound, purpose-bound, scoped, audited, never case
-- content. An expert gets a new role that holds no permission, and a new task type that confers the case's metadata
-- only, for at most 30 days (7 by default, as the legal-hold tasks). No permission is added or widened; no discovery,
-- no identity, no content. Exposing the material a task is about, item by item, is a Phase 12 task flow.
insert into iam.role (code, name_en, name_ar, description, is_technical) values
  ('EXTERNAL_EXPERT', 'External or Technical Expert', 'خبير خارجي أو فني',
   'Supports a review through a task only; holds no permission of its own (AMB-022).', false);

alter table case_mgmt.case_task_type drop constraint case_task_type_category_check;
alter table case_mgmt.case_task_type add constraint case_task_type_category_check
  check (category in ('LEGAL', 'RECORDS', 'EXPERT'));
insert into case_mgmt.case_task_type (code, category, name_en, name_ar, allowed_capabilities, eligible_roles,
                                      requires_closed, default_duration, max_duration) values
  ('EXTERNAL_EXPERT', 'EXPERT', 'External or technical expert support', 'دعم خبير خارجي أو فني',
   '{CASE_VIEW_METADATA}', '{EXTERNAL_EXPERT}', false, '7 days', '30 days');

-- =============================================================================
-- 5. An urgent matter is flagged, and the GRC Director is told by code only (AMB-017)
-- =============================================================================
-- What makes a matter urgent is SOURCE_REQUIRED and not invented: the flag is the preparer's or the case team's
-- judgement, with a mandatory reason. It never transfers the case, changes who can see it, or skips the preliminary
-- review (Q11). Each active GRC Director who can already open the case is told by template code and case id; on a
-- restricted case that is only a director the authority let in, so the flag records how many were told and the
-- screen can say so when nobody was.
insert into config.setting (key, value, status, source_reference, description) values
  ('URGENT_ESCALATION_CRITERIA', null, 'SOURCE_REQUIRED', null,
   'AMB-017: which matters bypass normal pacing and are escalated at once. Not invented: the platform records an '
   'URGENT flag with a mandatory reason and tells the GRC Director by code; it never transfers the case.');

create table case_mgmt.case_urgent_flag (
  id             uuid primary key default gen_random_uuid(),
  case_id        uuid not null references case_mgmt.case_record (id),
  reason         text not null check (length(reason) between 10 and 2000),
  notified_count int not null check (notified_count >= 0),
  flagged_by     uuid not null references iam.user_profile (id),
  flagged_at     timestamptz not null default clock_timestamp(),
  cleared_by     uuid references iam.user_profile (id),
  cleared_at     timestamptz,
  clear_reason   text check (length(clear_reason) between 10 and 2000),
  check ((cleared_at is null) = (cleared_by is null) and (cleared_at is null) = (clear_reason is null))
);
create unique index case_urgent_flag_active on case_mgmt.case_urgent_flag (case_id) where cleared_at is null;
create index case_urgent_flag_case on case_mgmt.case_urgent_flag (case_id, flagged_at);
create index case_urgent_flag_flagged_by on case_mgmt.case_urgent_flag (flagged_by);
create index case_urgent_flag_cleared_by on case_mgmt.case_urgent_flag (cleared_by);
comment on table case_mgmt.case_urgent_flag is
  'An URGENT flag on a case with its mandatory reason (AMB-017; migration 2100). Never transfers the case or changes '
  'access. Cleared once, never deleted; notified_count is how many GRC Directors were told by code.';

create function case_mgmt.protect_case_urgent_flag()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.cleared_at is not null or new.cleared_at is null
     or (to_jsonb(new) - array['cleared_by', 'cleared_at', 'clear_reason'])
        <> (to_jsonb(old) - array['cleared_by', 'cleared_at', 'clear_reason']) then
    raise exception 'urgent flag % can only be cleared, once', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger case_urgent_flag_protect before update on case_mgmt.case_urgent_flag
  for each row execute function case_mgmt.protect_case_urgent_flag();
create trigger no_delete before delete on case_mgmt.case_urgent_flag
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on case_mgmt.case_urgent_flag
  for each statement execute function committee.reject_mutation();

alter table case_mgmt.case_urgent_flag enable row level security;
create policy case_urgent_flag_read on case_mgmt.case_urgent_flag for select to authenticated
  using (authz.can_view_case(case_id));
grant select on case_mgmt.case_urgent_flag to authenticated;

insert into notify.template (code, object_type, is_mandatory, description) values
  ('CASE_URGENT_FLAGGED', 'CASE', true, 'A case the user can open was flagged as urgent (AMB-017)');
insert into notify.rule (layer, template_code, channel, enabled, effective_from, reason)
select 'SYSTEM_MANDATORY', 'CASE_URGENT_FLAGGED', c.channel, true, '2026-01-01T00:00:00Z',
       'Synthetic default: mandatory notice (ADR-025)'
from (values ('IN_APP'), ('EMAIL')) c (channel);

-- 5.1 Who may flag or clear: someone who can see the case and either edits it or prepares preliminary reviews.
-- Anything else learns nothing (NOT_FOUND before FORBIDDEN). The case must be ACTIVE.
create function case_mgmt.lock_urgent_case(p_case_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not (authz.can_edit_case(p_case_id) or authz.has_permission('PRELIMINARY_PREPARE')) then
    perform api._fail('FORBIDDEN');
  end if;
  if (select c.records_state from case_mgmt.case_record c where c.id = p_case_id for update) <> 'ACTIVE' then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
end;
$$;

create function api.flag_case_urgent(p_case_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_reason text;
  v_id uuid := gen_random_uuid();
  v_directors uuid[];
  v_director uuid;
begin
  perform case_mgmt.lock_urgent_case(p_case_id);
  if exists (select 1 from case_mgmt.case_urgent_flag f where f.case_id = p_case_id and f.cleared_at is null) then
    perform api._fail('CONFLICT', 'ALREADY_URGENT');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  -- Only a GRC Director who can already open the case, never the person who flagged it; ids only.
  select coalesce(array_agg(distinct a.user_id order by a.user_id), '{}') into v_directors
  from iam.user_role_assignment a
  where a.role_code = 'GRC_DIRECTOR' and a.user_id <> v_actor
    and authz.user_has_role(a.user_id, 'GRC_DIRECTOR') and authz.user_can_view_case(a.user_id, p_case_id);
  insert into case_mgmt.case_urgent_flag (id, case_id, reason, notified_count, flagged_by)
  values (v_id, p_case_id, v_reason, cardinality(v_directors), v_actor);
  foreach v_director in array v_directors loop
    perform notify.enqueue('CASE_URGENT_FLAGGED', v_director, p_case_id, null, 'case-urgent:' || v_id);
  end loop;
  perform audit.record_event('CASE_URGENT_FLAGGED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_urgent_flag', v_id::text,
    null, jsonb_build_object('notified_count', cardinality(v_directors)));
  return v_id;
end;
$$;

-- 5.2 Clearing, by the same people, with a reason. What was sent is not recalled; nobody is told.
create function api.clear_case_urgent(p_case_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_f case_mgmt.case_urgent_flag;
  v_reason text;
begin
  perform case_mgmt.lock_urgent_case(p_case_id);
  select * into v_f from case_mgmt.case_urgent_flag f where f.case_id = p_case_id and f.cleared_at is null for update;
  if v_f.id is null then perform api._fail('CONFLICT', 'NOT_URGENT'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  update case_mgmt.case_urgent_flag set cleared_by = v_actor, cleared_at = now(), clear_reason = v_reason
   where id = v_f.id;
  perform audit.record_event('CASE_URGENT_CLEARED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_urgent_flag', v_f.id::text,
    null, '{}'::jsonb);
end;
$$;

-- =============================================================================
-- 6. Preliminary approval is delegated on record; the delegate gains nothing yet (AMB-023)
-- =============================================================================
-- Modelled on the sector delegation (1880, DEC-F08): time-bound, forward-dated, evidenced, audited, revocable, with no
-- automatic fallback to another role. Coordinator ruling (15 Oct): a delegation that confers the delegator's authority
-- on the delegate is a widening and waits for 2160. So this migration keeps the record and its revocation only:
-- api.approve_preliminary_recommendation is unchanged and still requires PRELIMINARY_APPROVE, so a delegate approves
-- nothing until 2160 adds the grant half (which must also check, at use, that the delegator still holds the authority).
insert into config.setting (key, value, status, source_reference, description) values
  ('MAX_PRELIMINARY_APPROVAL_DELEGATION_DAYS', null, 'SOURCE_REQUIRED', null,
   'AMB-023: the longest period, in days, a GRC Sector Head may delegate preliminary approval for. Not invented: no '
   'maximum beyond the required end date applies until it is configured; a configured value that is not a whole '
   'number of days refuses every new delegation (fail closed).');

create table iam.preliminary_approval_delegation (
  id                 uuid primary key default gen_random_uuid(),
  delegator_id       uuid not null references iam.user_profile (id),
  delegate_id        uuid not null references iam.user_profile (id),
  effective_from     timestamptz not null,
  effective_to       timestamptz not null,
  evidence_reference text not null check (length(evidence_reference) between 3 and 200),
  reason             text not null check (length(reason) between 10 and 2000),
  created_at         timestamptz not null default clock_timestamp(),
  revoked_by         uuid references iam.user_profile (id),
  revoked_at         timestamptz,
  revoke_reason      text check (length(revoke_reason) between 10 and 2000),
  check (effective_to > effective_from),
  check (delegate_id <> delegator_id),
  check ((revoked_by is null) = (revoked_at is null) and (revoked_at is null) = (revoke_reason is null))
);
create index preliminary_approval_delegation_delegator on iam.preliminary_approval_delegation (delegator_id, effective_from);
create index preliminary_approval_delegation_delegate on iam.preliminary_approval_delegation (delegate_id, effective_from);
create index preliminary_approval_delegation_revoked_by on iam.preliminary_approval_delegation (revoked_by);
comment on table iam.preliminary_approval_delegation is
  'A documented, time-bound delegation of a GRC Sector Head''s preliminary approval (AMB-023; migration 2100). '
  'A record only: it confers nothing until migration 2160. Revoked once, never deleted.';

create function iam.protect_preliminary_approval_delegation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null or new.revoked_at is null
     or (to_jsonb(new) - array['revoked_by', 'revoked_at', 'revoke_reason'])
        <> (to_jsonb(old) - array['revoked_by', 'revoked_at', 'revoke_reason']) then
    raise exception 'delegation % can only be revoked, once', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger preliminary_approval_delegation_protect before update on iam.preliminary_approval_delegation
  for each row execute function iam.protect_preliminary_approval_delegation();
create trigger no_delete before delete on iam.preliminary_approval_delegation
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on iam.preliminary_approval_delegation
  for each statement execute function committee.reject_mutation();

-- The SOURCE_REQUIRED maximum, enforced once configured (as iam.check_delegation_length, 2040).
create function iam.check_preliminary_delegation_length()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_s config.setting;
begin
  select * into v_s from config.setting s where s.key = 'MAX_PRELIMINARY_APPROVAL_DELEGATION_DAYS';
  if v_s.status = 'CONFIGURED' then
    if v_s.value !~ '^[0-9]{1,4}$' or v_s.value::int < 1 then
      perform api._fail('CONFLICT', 'DELEGATION_LIMIT_MISCONFIGURED');
    end if;
    if new.effective_to > new.effective_from + make_interval(days => v_s.value::int) then
      perform api._fail('CONFLICT', 'DELEGATION_TOO_LONG');
    end if;
  end if;
  return new;
end;
$$;
create trigger preliminary_approval_delegation_max_length before insert on iam.preliminary_approval_delegation
  for each row execute function iam.check_preliminary_delegation_length();

alter table iam.preliminary_approval_delegation enable row level security;
create policy preliminary_approval_delegation_read on iam.preliminary_approval_delegation for select to authenticated
  using (delegator_id = authz.current_user_id() or delegate_id = authz.current_user_id()
         or authz.has_permission('ROLE_ADMIN'));
grant select on iam.preliminary_approval_delegation to authenticated;

-- 6.1 Delegating: by a holder of PRELIMINARY_APPROVE, to another active internal account, forward in time, with an end,
-- evidence and a reason; never two overlapping delegations to the same delegate.
create function api.delegate_preliminary_approval(
  p_delegate_id uuid, p_effective_from timestamptz, p_effective_to timestamptz, p_evidence_reference text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_from timestamptz := coalesce(p_effective_from, now());
  v_reason text;
  v_evidence text;
  v_id uuid;
begin
  if not authz.has_permission('PRELIMINARY_APPROVE') then perform api._fail('FORBIDDEN'); end if;
  perform pg_advisory_xact_lock(hashtext('iam.preliminary_approval_delegation:' || v_actor));
  -- No backdating: a delegation never covers approvals already given.
  if v_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_effective_to is null or p_effective_to <= v_from then perform api._fail('INVALID', 'effective_to'); end if;
  perform 1 from iam.user_profile u where u.id = p_delegate_id and u.status = 'ACTIVE' for key share;
  if p_delegate_id is null or p_delegate_id = v_actor or not found or authz.is_external_account(p_delegate_id) then
    perform api._fail('INVALID', 'delegate_id');
  end if;
  v_evidence := api._require_text(p_evidence_reference, 'evidence_reference', 3, 200);
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  if exists (select 1 from iam.preliminary_approval_delegation d
             where d.delegator_id = v_actor and d.delegate_id = p_delegate_id and d.revoked_at is null
               and d.effective_from < p_effective_to and d.effective_to > v_from) then
    perform api._fail('CONFLICT', 'DELEGATION_OVERLAP');
  end if;
  insert into iam.preliminary_approval_delegation (delegator_id, delegate_id, effective_from, effective_to,
                                                   evidence_reference, reason)
  values (v_actor, p_delegate_id, v_from, p_effective_to, v_evidence, v_reason)
  returning id into v_id;
  perform audit.record_event('PRELIMINARY_APPROVAL_DELEGATED', 'ADMIN', 'SUCCESS', null, 'preliminary_approval_delegation',
    v_id::text, null,
    jsonb_build_object('delegate_id', p_delegate_id, 'effective_from', v_from, 'effective_to', p_effective_to));
  return v_id;
end;
$$;

-- 6.2 Revoking: by the delegator or a role administrator; the delegate sees it but cannot revoke it.
create function api.revoke_preliminary_approval_delegation(p_delegation_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_d iam.preliminary_approval_delegation;
  v_reason text;
begin
  select * into v_d from iam.preliminary_approval_delegation d where d.id = p_delegation_id;
  if v_d.id is null
     or not (v_d.delegator_id = v_actor or v_d.delegate_id = v_actor or authz.has_permission('ROLE_ADMIN')) then
    perform api._fail('NOT_FOUND');
  end if;
  if not (v_d.delegator_id = v_actor or authz.has_permission('ROLE_ADMIN')) then perform api._fail('FORBIDDEN'); end if;
  select * into v_d from iam.preliminary_approval_delegation d where d.id = p_delegation_id for update;
  if v_d.revoked_at is not null or v_d.effective_to <= now() then
    perform api._fail('CONFLICT', 'DELEGATION_NOT_ACTIVE');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  update iam.preliminary_approval_delegation set revoked_by = v_actor, revoked_at = now(), revoke_reason = v_reason
   where id = v_d.id;
  perform audit.record_event('PRELIMINARY_APPROVAL_DELEGATION_REVOKED', 'ADMIN', 'SUCCESS', null,
    'preliminary_approval_delegation', v_d.id::text, null, jsonb_build_object('delegate_id', v_d.delegate_id));
end;
$$;

-- =============================================================================
-- 7. Grants and the catalogue
-- =============================================================================
revoke all on function
  committee.open_work(uuid), committee.require_active_committee(), exchange.workbook_revoked(uuid, text),
  exchange.refuse_revoked_workbook(), authz.external_counsel_enabled(), authz.is_external_account(uuid),
  authz.user_packet_gate(uuid, uuid), iam.refuse_external_account(), case_mgmt.protect_case_urgent_flag(),
  case_mgmt.lock_urgent_case(uuid), iam.protect_preliminary_approval_delegation(),
  iam.check_preliminary_delegation_length()
from public, anon, authenticated;

revoke all on function
  api.deactivate_committee(uuid, text, text), api.reactivate_committee(uuid, text, text),
  api.revoke_bcp_workbook(uuid, text, text, text), api.flag_external_counsel_account(uuid, text, text),
  api.flag_case_urgent(uuid, text), api.clear_case_urgent(uuid, text),
  api.delegate_preliminary_approval(uuid, timestamptz, timestamptz, text, text),
  api.revoke_preliminary_approval_delegation(uuid, text), authz.current_user_is_external()
from public;
grant execute on function
  api.deactivate_committee(uuid, text, text), api.reactivate_committee(uuid, text, text),
  api.revoke_bcp_workbook(uuid, text, text, text), api.flag_external_counsel_account(uuid, text, text),
  api.flag_case_urgent(uuid, text), api.clear_case_urgent(uuid, text),
  api.delegate_preliminary_approval(uuid, timestamptz, timestamptz, text, text),
  api.revoke_preliminary_approval_delegation(uuid, text), authz.current_user_is_external()
to authenticated;

-- The form and status catalogue (migration 1970) follows the schema: the modules name their new commands.
update config.target_module
   set commands = commands || array['api.deactivate_committee', 'api.reactivate_committee'],
       delivered_in = delivered_in || '2100'::text,
       notes = notes || ' Since 2100: a committee is deactivated or reactivated citing the governance decision; a '
                        'deactivated committee opens no proceeding and receives no referral or grievance, and nothing is '
                        'transferred (COMMITTEE_TRANSFER_RULE is SOURCE_REQUIRED).'
 where code = 'COMMITTEE_REGISTRY';
update config.target_module
   set commands = commands || array['api.revoke_bcp_workbook'],
       delivered_in = delivered_in || '2100'::text,
       notes = notes || ' Since 2100: a lost workbook is revoked on the case, so no copy of it is staged or taken further '
                        '(AMB-205).'
 where code = 'BCP_CONTINUITY';
update config.target_module
   set commands = commands || array['api.flag_external_counsel_account'],
       delivered_in = delivered_in || '2100'::text,
       notes = notes || ' Since 2100: external counsel act through a flagged LEGAL_REVIEWER account that reaches only the '
                        'packets assigned to it, and only while EXTERNAL_COUNSEL_ENABLED is true (false by default; AMB-121).'
 where code = 'LEGAL_REVIEW';
update config.target_module
   set delivered_in = delivered_in || '2100'::text,
       notes = notes || ' Since 2100: the EXTERNAL_EXPERT task type gives an expert the case''s metadata only, for at most '
                        '30 days (AMB-022).'
 where code = 'CASE_TASKS';
-- AMB-017 sits in the preliminary compliance review; CASE_ESCALATION (the escalation states) stays PLANNED.
update config.target_module
   set commands = commands || array['api.flag_case_urgent', 'api.clear_case_urgent'],
       delivered_in = delivered_in || '2100'::text,
       notes = notes || ' Since 2100: an URGENT flag with a mandatory reason, which tells the GRC Directors who can open '
                        'the case by code and never transfers it (AMB-017; the criteria are SOURCE_REQUIRED).'
 where code = 'PRELIM_ASSESSMENT';
update config.target_module
   set commands = commands || array['api.delegate_preliminary_approval', 'api.revoke_preliminary_approval_delegation'],
       delivered_in = delivered_in || '2100'::text,
       notes = notes || ' Since 2100: the GRC Sector Head''s approval is delegated on record (time-bound, evidenced, '
                        'revocable); the record grants nothing until 2160 (AMB-023).'
 where code = 'PRELIM_RECOMMENDATION';
