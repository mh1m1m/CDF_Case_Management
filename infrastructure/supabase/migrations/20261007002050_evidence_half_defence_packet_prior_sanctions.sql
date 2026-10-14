-- =============================================================================
-- 2050 The evidence half of P11-G4, the Defence Packet and the prior-sanctions extract (Rebase PR-B; CDF-196, CDF-212)
-- Requirements: §18–§22, §24–§29, §39, §40, §68, §82, §83, §87; owner decisions DEC-F37 (2026-10-13), DEC-AMB-005
-- option B and DEC-AMB-006 option C (owner, 2026-10-13); ambiguity rows AMB-034, -106, -118, -159, -161, -164, -165,
-- -169, -171, -191; gap P11-G4, evidence half (T3-B2.3-112, T3-B2.3-144, S083, S118); CDF-212 (AGENT-09); ADR-041
--
-- DEC-F37 (owner, 2026-10-13): "Build the evidence half now that #55's evidence commands are on main ... Preserve
-- evidence authorization, provenance, chain of custody, immutable versions, audit and purpose-bound access."
-- DEC-AMB-005 (owner, 2026-10-13), option B: "Permit access only to prior final disciplinary sanctions, through a
-- purpose-bound extract initiated/managed by the Secretary. No unrelated case allegations, evidence, investigations, or
-- full case history. Restricted-source cases remain subject to Restricted Case Authority controls."
-- DEC-AMB-006 (owner, 2026-10-13), option C: "Permit selected evidence through a purpose-bound Defence Packet, following
-- review/redaction for reporter, witness, confidentiality, privilege, restricted information and other protected
-- identities/content. This does not create general evidence access for the subject."
--
-- This migration adds:
--   1. Evidence exclusion (DEC-F37, AMB-161; T3-B2.3-112, S083, S118). An evidence lead excludes an item from
--      consideration with a reason (api.exclude_evidence). The item, its versions and its custody stay as they are; the
--      exclusion is final, append-only and its own custody event. An excluded item takes no new version or rendition
--      and never enters a Defence Packet (T-AMB-094). The formal exclusion record (T3-B2.3-144) is
--      api.evidence_exclusion_record.
--   2. Custody exceptions and external transfers (AMB-164): append-only, with a reason, each its own custody event. The
--      item is flagged by their presence; nothing is rewritten (T-AMB-097).
--   3. Integrity on read (AMB-165). The server verifies the SHA-256 of what it reads before serving it. A mismatch is
--      reported (api.report_evidence_integrity_failure): the version is blocked for every reader on every path, a
--      SECURITY event is raised and the case owner is told by template code (T-AMB-098).
--   4. Redacted renditions (AMB-169, AMB-168): a REDACTED version derived from an original, through the same quarantine,
--      scan and completion pipeline. It never becomes the item's current version; the original is untouched (T-AMB-100).
--   5. The Defence Packet (DEC-AMB-006, AMB-159, AMB-118, AMB-171). For one open DEFENCE notice, an evidence lead who
--      manages the defence chooses evidence versions; another evidence lead reviews each item for the reporter,
--      witnesses, confidentiality, privilege, restricted information and other protected identities, clearing it as
--      is, clearing a redacted rendition, or withholding it. Nothing is cleared while LEGAL_PRIVILEGE_RULE is
--      SOURCE_REQUIRED. A restricted case's packet needs its Restricted Case Authority. The subject sees only the cleared
--      items of a released packet, view-only while PACKET_EVIDENCE_DOWNLOAD is false (DEC-67 open), every view audited
--      and in the chain of custody; the subject never reaches the evidence tables or storage (T-AMB-092, T-AMB-102).
--   6. The prior-sanctions extract (DEC-AMB-005, AMB-034, AMB-106). The secretary of an open committee proceeding asks
--      for the final sanctions of one of the case's subjects in their other cases. A row carries the sanction code and
--      two dates, never a case, allegation, evidence or history. A row from a restricted case waits for that case's
--      Restricted Case Authority and is invisible until approved. Readers: the proceeding's secretary and seated
--      members without a meeting conflict, within their clearance; every view audited (T-AMB-015).
--   7. CDF-212 (AGENT-09): api.declare_meeting_conflict requires a member's seat to be current, like cast_vote,
--      revise_vote, record_attendance and the deliberation view.
--   8. Notifications by template code (ids only), and the form and status catalogue: P11-G4 closes.
--
-- Configuration (grievance.defence_packet_policy, effective-dated, migration-managed like the other reference values;
-- coordinator defaults of 2026-10-14 11:26, each on the narrow side):
--   * reviewer_must_differ = true: whoever chose an item never reviews it;
--   * packet_evidence_download = false: view only (AMB-171, until DEC-67 is answered);
--   * privilege_rule_reference = null, SOURCE_REQUIRED (AMB-118): no item is cleared until the rule is recorded.
--
-- Replaced functions (create or replace: same signature, owner and grants; no check weakened), and why:
--   * evidence.protect_version: the two new version columns are immutable too.
--   * api.complete_evidence_version: a completed rendition never becomes the item's current version.
--   * api.open_evidence_version: a version with a recorded integrity failure is never served.
--   * api.declare_meeting_conflict: CDF-212, an ended seat is refused (CONFLICT:SEAT_ENDED).
--   * notify.deep_link: the CASE, DEFENCE_PACKET and SANCTION_EXTRACT_APPROVAL paths.
-- Checks widened by drop and re-add under the same name: custody_event_event_type_check (EXCLUDED, CUSTODY_EXCEPTION,
-- EXTERNAL_TRANSFER, INTEGRITY_FAILED, PACKET_VIEWED), template_object_type_check and outbox_object_type_check (CASE,
-- DEFENCE_PACKET, SANCTION_EXTRACT_APPROVAL).
--
-- Not in this migration (ADR-041 "Not built here"): committee evidence packets (AMB-065), physical evidence (AMB-167),
-- screenshot capture metadata (AMB-168, first half), defence attachments (AMB-155) and the offline evidence package
-- (AMB-202, migration 2110). Evidence and packets stay unexportable (AMB-191, DEC-67 open; T-AMB-111).
--
-- Controls:
--   * Additive: nothing is dropped, renamed or deleted; no catalogue code, status or option code changes (DEC-35 open).
--     Every new table has RLS, SELECT policies only where a reader exists, and no write grants. Records are
--     append-only; the packet and extract rows change only along their guarded transitions.
--   * Writes go through api.* SECURITY DEFINER commands (search_path '', schema-qualified) that audit in the same
--     transaction with ids, codes and counts only; reasons stay in their rows. Table triggers back every rule whatever
--     the path. No new permission: the rules use evidence leadership, defence management, committee seats and the
--     Restricted Case Authority as they already are.
--   * Protected identity is untouched. PLATFORM_ADMIN and DB_ADMIN gain nothing.
--   * PRODUCTION_SUBSTITUTION_REQUIRED: the packet viewer is the prototype's inline response (a controlled viewer with
--     watermarking is the production component), and the hash check runs in the prototype BFF.
-- =============================================================================

-- =============================================================================
-- 1. Evidence exclusion (DEC-F37, AMB-161; T3-B2.3-112, T3-B2.3-144, S083, S118)
-- =============================================================================
alter table evidence.custody_event drop constraint custody_event_event_type_check;
alter table evidence.custody_event add constraint custody_event_event_type_check check (event_type in (
  'RECEIVED', 'STORED', 'REJECTED', 'DOWNLOADED', 'EXCLUDED', 'CUSTODY_EXCEPTION', 'EXTERNAL_TRANSFER',
  'INTEGRITY_FAILED', 'PACKET_VIEWED'));

create table evidence.exclusion (
  id          uuid primary key default gen_random_uuid(),
  evidence_id uuid not null unique references evidence.evidence (id),
  case_id     uuid not null references case_mgmt.case_record (id),
  -- The number of the formal exclusion record within the case (T3-B2.3-144). UUIDs are the keys (§87).
  record_no   int not null check (record_no >= 1),
  reason      text not null check (length(reason) between 10 and 2000),
  excluded_by uuid not null references iam.user_profile (id),
  excluded_at timestamptz not null default now(),
  unique (case_id, record_no)
);
create index exclusion_case on evidence.exclusion (case_id);
create index exclusion_excluded_by on evidence.exclusion (excluded_by);
comment on table evidence.exclusion is
  'An item excluded from consideration for a substantive reason (DEC-F37, AMB-161; T3-B2.3-112, S083/S118). Final and '
  'append-only. The item, its versions and custody are kept; it takes no new version and enters no packet.';

create trigger exclusion_no_update before update on evidence.exclusion
  for each row execute function evidence.reject_mutation();
create trigger exclusion_no_delete before delete on evidence.exclusion
  for each row execute function evidence.reject_mutation();
create trigger exclusion_no_truncate before truncate on evidence.exclusion
  for each statement execute function evidence.reject_mutation();

-- Whatever the path, an excluded item takes no new version or rendition.
create function evidence.guard_excluded_item()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from evidence.exclusion x where x.evidence_id = new.evidence_id) then
    perform api._fail('CONFLICT', 'EVIDENCE_EXCLUDED');
  end if;
  return new;
end;
$$;
create trigger evidence_version_excluded_item before insert on evidence.evidence_version
  for each row execute function evidence.guard_excluded_item();

alter table evidence.exclusion enable row level security;
create policy exclusion_read on evidence.exclusion for select to authenticated
  using (authz.can_view_evidence(evidence_id));
grant select on evidence.exclusion to authenticated;

-- Those who direct the investigation exclude (T3-B2.3-112: the lead investigator; DEC-09 leads), on an active case.
create function api.exclude_evidence(p_evidence_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_ev evidence.evidence;
  v_reason text;
  v_no int;
  v_id uuid;
begin
  select * into v_ev from evidence.evidence e where e.id = p_evidence_id;
  if v_ev.id is null or not authz.can_view_evidence(v_ev.id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.is_evidence_lead(v_ev.case_id) then perform api._fail('FORBIDDEN'); end if;
  -- Locking the case serialises the record numbers.
  perform 1 from case_mgmt.case_record c where c.id = v_ev.case_id for update;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_ev.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if exists (select 1 from evidence.exclusion x where x.evidence_id = v_ev.id) then
    perform api._fail('CONFLICT', 'EVIDENCE_EXCLUDED');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  select coalesce(max(x.record_no), 0) + 1 into v_no from evidence.exclusion x where x.case_id = v_ev.case_id;
  insert into evidence.exclusion (evidence_id, case_id, record_no, reason, excluded_by)
  values (v_ev.id, v_ev.case_id, v_no, v_reason, v_actor)
  returning id into v_id;
  insert into evidence.custody_event (evidence_id, version_id, event_type, actor_id, request_id, details)
  values (v_ev.id, v_ev.current_version_id, 'EXCLUDED', v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid,
          jsonb_build_object('record_no', v_no));
  -- The reason stays in the exclusion row; the ledger gets ids and numbers.
  perform audit.record_event('EVIDENCE_EXCLUDED', 'BUSINESS', 'SUCCESS', v_ev.case_id, 'evidence_exclusion', v_id::text,
    null, jsonb_build_object('evidence_id', v_ev.id, 'sequence_no', v_ev.sequence_no, 'record_no', v_no));
  return v_id;
end;
$$;

-- The formal exclusion record (T3-B2.3-144, «محضر استبعاد دليل»), generated from the exclusion, for whoever may see
-- the item. A read: the exclusion itself is the audited event.
create function api.evidence_exclusion_record(p_exclusion_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_x evidence.exclusion;
begin
  perform api._actor();
  select * into v_x from evidence.exclusion x where x.id = p_exclusion_id;
  if v_x.id is null or not authz.can_view_evidence(v_x.evidence_id) then perform api._fail('NOT_FOUND'); end if;
  return (
    select jsonb_build_object(
             'exclusion_id', v_x.id, 'record_no', v_x.record_no, 'case_id', c.id, 'case_number', c.case_number,
             'evidence_id', e.id, 'evidence_sequence_no', e.sequence_no, 'evidence_title', e.title,
             'excluded_by', v_x.excluded_by, 'excluded_by_name', u.display_name,
             'excluded_by_name_ar', u.display_name_ar, 'excluded_at', v_x.excluded_at, 'reason', v_x.reason)
    from evidence.evidence e
    join case_mgmt.case_record c on c.id = e.case_id
    left join iam.user_profile u on u.id = v_x.excluded_by
    where e.id = v_x.evidence_id);
end;
$$;

-- =============================================================================
-- 2. Custody exceptions and external transfers (AMB-164; T-AMB-097)
-- =============================================================================
create table evidence.custody_exception (
  id                 uuid primary key default gen_random_uuid(),
  evidence_id        uuid not null references evidence.evidence (id),
  version_id         uuid references evidence.evidence_version (id),
  case_id            uuid not null references case_mgmt.case_record (id),
  kind               text not null check (kind in ('CUSTODY_EXCEPTION', 'EXTERNAL_TRANSFER')),
  reason             text not null check (length(reason) between 10 and 2000),
  -- An external transfer names the receiving party's reference (a forensic laboratory's case number, for example).
  external_reference text check (length(external_reference) between 3 and 300),
  -- The custody event recording it. Checked by evidence.guard_custody_exception rather than a foreign key, so that the
  -- append-only custody ledger keeps its own refusal of TRUNCATE.
  custody_event_id   uuid not null unique,
  recorded_by        uuid not null references iam.user_profile (id),
  recorded_at        timestamptz not null default now(),
  check (kind <> 'EXTERNAL_TRANSFER' or external_reference is not null)
);
create index custody_exception_evidence on evidence.custody_exception (evidence_id);
create index custody_exception_version on evidence.custody_exception (version_id);
create index custody_exception_case on evidence.custody_exception (case_id);
create index custody_exception_recorded_by on evidence.custody_exception (recorded_by);
comment on table evidence.custody_exception is
  'A break in the chain of custody, or an external forensic copy, with its reason (AMB-164). Append-only: once recorded '
  'it is never removed (T-AMB-097). The item is flagged by its presence; nothing is rewritten.';

-- Whatever the path, an exception names its own custody event: same item, same version, same kind.
create function evidence.guard_custody_exception()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from evidence.custody_event ce
                 join evidence.evidence e on e.id = ce.evidence_id
                 where ce.id = new.custody_event_id and ce.evidence_id = new.evidence_id
                   and ce.version_id is not distinct from new.version_id and ce.event_type = new.kind
                   and e.case_id = new.case_id) then
    perform api._fail('INVALID', 'custody_event_id');
  end if;
  return new;
end;
$$;
create trigger custody_exception_event before insert on evidence.custody_exception
  for each row execute function evidence.guard_custody_exception();

create trigger custody_exception_no_update before update on evidence.custody_exception
  for each row execute function evidence.reject_mutation();
create trigger custody_exception_no_delete before delete on evidence.custody_exception
  for each row execute function evidence.reject_mutation();
create trigger custody_exception_no_truncate before truncate on evidence.custody_exception
  for each statement execute function evidence.reject_mutation();

alter table evidence.custody_exception enable row level security;
create policy custody_exception_read on evidence.custody_exception for select to authenticated
  using (authz.can_view_evidence(evidence_id));
grant select on evidence.custody_exception to authenticated;

-- The investigation team that handles the evidence records what happened to it. Recording a fact adds no access, so a
-- closed case takes it too; an archived one does not.
create function api.record_custody_exception(p_evidence_id uuid, p_version_id uuid, p_kind text, p_reason text,
                                             p_external_reference text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_ev evidence.evidence;
  v_ver evidence.evidence_version;
  v_reason text;
  v_event uuid;
  v_id uuid;
begin
  select * into v_ev from evidence.evidence e where e.id = p_evidence_id;
  if v_ev.id is null or not authz.can_view_evidence(v_ev.id) then perform api._fail('NOT_FOUND'); end if;
  if not (authz.is_evidence_team(v_ev.case_id) and authz.has_permission('EVIDENCE_UPLOAD')) then
    perform api._fail('FORBIDDEN');
  end if;
  perform 1 from case_mgmt.case_record c where c.id = v_ev.case_id for update;
  if not exists (select 1 from case_mgmt.case_record c
                 where c.id = v_ev.case_id and c.records_state in ('ACTIVE', 'CLOSED')) then
    perform api._fail('CONFLICT', 'RECORDS_READ_ONLY');
  end if;
  if p_version_id is not null then
    select * into v_ver from evidence.evidence_version v where v.id = p_version_id and v.evidence_id = v_ev.id;
    if v_ver.id is null then perform api._fail('INVALID', 'version_id'); end if;
  end if;
  if p_kind is null or p_kind not in ('CUSTODY_EXCEPTION', 'EXTERNAL_TRANSFER') then perform api._fail('INVALID', 'kind'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  if p_kind = 'EXTERNAL_TRANSFER' or p_external_reference is not null then
    perform api._require_text(p_external_reference, 'external_reference', 3, 300);
  end if;
  insert into evidence.custody_event (evidence_id, version_id, event_type, actor_id, request_id, details)
  values (v_ev.id, v_ver.id, p_kind, v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid,
          jsonb_strip_nulls(jsonb_build_object('version_no', v_ver.version_no)))
  returning id into v_event;
  insert into evidence.custody_exception (evidence_id, version_id, case_id, kind, reason, external_reference,
                                          custody_event_id, recorded_by)
  values (v_ev.id, v_ver.id, v_ev.case_id, p_kind, v_reason, nullif(btrim(p_external_reference), ''), v_event, v_actor)
  returning id into v_id;
  perform audit.record_event('EVIDENCE_CUSTODY_EXCEPTION_RECORDED', 'BUSINESS', 'SUCCESS', v_ev.case_id,
    'custody_exception', v_id::text, null,
    jsonb_build_object('evidence_id', v_ev.id, 'version_id', v_ver.id, 'kind', p_kind));
  return v_id;
end;
$$;

-- =============================================================================
-- 3. Redacted renditions (AMB-169, AMB-168; T-AMB-100)
-- =============================================================================
alter table evidence.evidence_version
  add column rendition text not null default 'ORIGINAL' check (rendition in ('ORIGINAL', 'REDACTED')),
  add column derived_from_version_id uuid references evidence.evidence_version (id),
  add constraint evidence_version_rendition_source check ((rendition = 'REDACTED') = (derived_from_version_id is not null));
create index evidence_version_derived_from on evidence.evidence_version (derived_from_version_id);
comment on column evidence.evidence_version.rendition is
  'ORIGINAL, or REDACTED: a redacted rendition derived from an original version of the same item (AMB-169). A rendition '
  'never becomes the item''s current version; the original is never changed.';
grant select (rendition, derived_from_version_id) on evidence.evidence_version to authenticated;

-- As in 0900, and the rendition columns are immutable too.
create or replace function evidence.protect_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'QUARANTINED' then
    raise exception 'evidence version % is immutable once %', old.id, old.status using errcode = 'insufficient_privilege';
  end if;
  if new.id <> old.id or new.evidence_id <> old.evidence_id or new.version_no <> old.version_no
     or new.object_key <> old.object_key or new.original_file_name <> old.original_file_name
     or new.content_type <> old.content_type or new.size_bytes <> old.size_bytes or new.sha256 <> old.sha256
     or new.uploaded_by <> old.uploaded_by or new.uploaded_at <> old.uploaded_at
     or new.request_id is distinct from old.request_id
     or new.rendition <> old.rendition or new.derived_from_version_id is distinct from old.derived_from_version_id then
    raise exception 'evidence version % content fields are immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

-- Whatever the path, a rendition derives from an available, intact original of the same item.
create function evidence.guard_rendition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.rendition = 'REDACTED' and not exists (
       select 1 from evidence.evidence_version o
       where o.id = new.derived_from_version_id and o.evidence_id = new.evidence_id and o.rendition = 'ORIGINAL'
         and o.status = 'AVAILABLE'
         and not exists (select 1 from evidence.integrity_failure f where f.version_id = o.id)) then
    perform api._fail('CONFLICT', 'RENDITION_SOURCE_INVALID');
  end if;
  return new;
end;
$$;

-- =============================================================================
-- 4. Integrity on read (AMB-165; T-AMB-098)
-- =============================================================================
create table evidence.integrity_failure (
  id              uuid primary key default gen_random_uuid(),
  version_id      uuid not null unique references evidence.evidence_version (id),
  evidence_id     uuid not null references evidence.evidence (id),
  case_id         uuid not null references case_mgmt.case_record (id),
  expected_sha256 text not null check (expected_sha256 ~ '^[0-9a-f]{64}$'),
  observed_sha256 text not null check (observed_sha256 ~ '^[0-9a-f]{64}$'),
  detected_by     uuid not null references iam.user_profile (id),
  detected_at     timestamptz not null default now(),
  request_id      uuid,
  check (observed_sha256 <> expected_sha256)
);
create index integrity_failure_evidence on evidence.integrity_failure (evidence_id);
create index integrity_failure_case on evidence.integrity_failure (case_id);
create index integrity_failure_detected_by on evidence.integrity_failure (detected_by);
comment on table evidence.integrity_failure is
  'A stored version whose content no longer matched its SHA-256 when read (AMB-165). The version is blocked for every '
  'reader and every path from then on. Append-only.';

create trigger integrity_failure_no_update before update on evidence.integrity_failure
  for each row execute function evidence.reject_mutation();
create trigger integrity_failure_no_delete before delete on evidence.integrity_failure
  for each row execute function evidence.reject_mutation();
create trigger integrity_failure_no_truncate before truncate on evidence.integrity_failure
  for each statement execute function evidence.reject_mutation();

alter table evidence.integrity_failure enable row level security;
create policy integrity_failure_read on evidence.integrity_failure for select to authenticated
  using (authz.can_view_evidence(evidence_id));
grant select (id, version_id, evidence_id, case_id, expected_sha256, observed_sha256, detected_by, detected_at)
  on evidence.integrity_failure to authenticated;

create trigger evidence_version_rendition_source before insert on evidence.evidence_version
  for each row execute function evidence.guard_rendition();

-- As in 0900, except that a version with a recorded integrity failure is never served (AMB-165): the reader gets the
-- same SECURITY denial as for a missing version.
create or replace function api.open_evidence_version(p_version_id uuid)
returns table (o_object_key text, o_file_name text, o_content_type text, o_size_bytes bigint, o_sha256 text,
               o_evidence_id uuid, o_case_id uuid)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_ver evidence.evidence_version;
  v_case_id uuid;
  v_failed boolean := false;
begin
  select * into v_ver from evidence.evidence_version v where v.id = p_version_id;
  if v_ver.id is not null then
    select e.case_id into v_case_id from evidence.evidence e where e.id = v_ver.evidence_id;
    v_failed := exists (select 1 from evidence.integrity_failure f where f.version_id = v_ver.id);
  end if;
  if v_ver.id is not null and v_ver.status = 'AVAILABLE' and not v_failed
     and authz.can_download_evidence(v_ver.evidence_id) then
    insert into evidence.custody_event (evidence_id, version_id, event_type, actor_id, request_id, details)
    values (v_ver.evidence_id, p_version_id, 'DOWNLOADED', v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid,
            jsonb_build_object('version_no', v_ver.version_no, 'sha256', v_ver.sha256));
    perform audit.record_event('EVIDENCE_DOWNLOADED', 'BUSINESS', 'SUCCESS', v_case_id, 'evidence_version', p_version_id::text, null,
      jsonb_build_object('evidence_id', v_ver.evidence_id, 'version_no', v_ver.version_no, 'sha256', v_ver.sha256));
    return query select v_ver.object_key, v_ver.original_file_name, v_ver.content_type, v_ver.size_bytes, v_ver.sha256,
                        v_ver.evidence_id, v_case_id;
    return;
  end if;
  perform audit.record_event('EVIDENCE_ACCESS_DENIED', 'SECURITY', 'DENIED', null, 'evidence_version', p_version_id::text, null,
    jsonb_build_object('target_exists', v_ver.id is not null,
                       'version_status', v_ver.status,
                       'integrity_failed', v_failed,
                       'case_visible', case when v_case_id is null then null else authz.can_view_case(v_case_id) end));
  return;
end;
$$;

-- =============================================================================
-- 5. The Defence Packet (DEC-AMB-006, AMB-159, AMB-118, AMB-171; T-AMB-092, T-AMB-094, T-AMB-102)
-- =============================================================================
-- 5.1 Configuration: effective-dated and migration-managed; a version only ever gets an end (as 2040's response period).
create table grievance.defence_packet_policy (
  id                       uuid primary key default gen_random_uuid(),
  effective_from           timestamptz not null,
  effective_to             timestamptz,
  -- Whoever chose an item never reviews it (coordinator default, 2026-10-14).
  reviewer_must_differ     boolean not null,
  -- AMB-171: view only in the packet viewer until DEC-67 is answered.
  packet_evidence_download boolean not null,
  -- AMB-118: LEGAL_PRIVILEGE_RULE, the CDF definition of privileged material the review applies. SOURCE_REQUIRED.
  privilege_rule_reference text check (length(privilege_rule_reference) between 3 and 300),
  privilege_source_status  text not null check (privilege_source_status in ('SOURCE_REQUIRED', 'APPROVED')),
  check ((privilege_rule_reference is null) = (privilege_source_status = 'SOURCE_REQUIRED')),
  check (effective_to is null or effective_to > effective_from)
);
comment on table grievance.defence_packet_policy is
  'Defence Packet settings, effective-dated (migration 2050, ADR-041): reviewer_must_differ (true), '
  'packet_evidence_download (false, AMB-171, DEC-67 open) and LEGAL_PRIVILEGE_RULE (AMB-118, SOURCE_REQUIRED: while it '
  'is unrecorded no item is cleared, so nothing reaches the subject).';
insert into grievance.defence_packet_policy (effective_from, reviewer_must_differ, packet_evidence_download,
                                              privilege_rule_reference, privilege_source_status)
values ('2026-01-01T00:00:00Z', true, false, null, 'SOURCE_REQUIRED');

create function grievance.protect_packet_policy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.effective_to is not null or (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') then
    raise exception 'defence packet policy % can only be given an end, once', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger defence_packet_policy_protect before update on grievance.defence_packet_policy
  for each row execute function grievance.protect_packet_policy();
create trigger no_delete before delete on grievance.defence_packet_policy
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on grievance.defence_packet_policy
  for each statement execute function committee.reject_mutation();
alter table grievance.defence_packet_policy enable row level security;
create policy defence_packet_policy_read on grievance.defence_packet_policy for select to authenticated
  using (authz.current_user_id() is not null);
grant select on grievance.defence_packet_policy to authenticated;

-- The version in force now; none in force reads as the narrow defaults (no row: reviewer differs, no download, no rule).
create function grievance.packet_policy()
returns grievance.defence_packet_policy
language sql stable
set search_path = ''
as $$
  select p.* from grievance.defence_packet_policy p
  where p.effective_from <= now() and (p.effective_to is null or p.effective_to > now())
  order by p.effective_from desc limit 1;
$$;

-- 5.2 Tables
create table grievance.defence_packet (
  id                uuid primary key default gen_random_uuid(),
  notice_id         uuid not null references grievance.defence_notice (id),
  case_id           uuid not null references case_mgmt.case_record (id),
  subject_id        uuid not null references case_mgmt.case_subject (id),
  sequence_no       int not null check (sequence_no >= 1),
  status            text not null default 'DRAFT' check (status in (
                      'DRAFT', 'AWAITING_AUTHORITY', 'RELEASED', 'REJECTED_BY_AUTHORITY', 'WITHDRAWN')),
  created_by        uuid not null references iam.user_profile (id),
  created_at        timestamptz not null default now(),
  submitted_by      uuid references iam.user_profile (id),
  submitted_at      timestamptz,
  released_at       timestamptz,
  withdrawn_by      uuid references iam.user_profile (id),
  withdrawn_at      timestamptz,
  withdrawal_reason text check (length(withdrawal_reason) between 10 and 2000),
  unique (notice_id, sequence_no),
  check ((submitted_at is null) = (submitted_by is null)),
  check (status not in ('AWAITING_AUTHORITY', 'RELEASED', 'REJECTED_BY_AUTHORITY') or submitted_at is not null),
  check (status <> 'RELEASED' or released_at is not null),
  check (released_at is null or submitted_at is not null),
  check ((status = 'WITHDRAWN') = (withdrawn_at is not null)),
  check ((withdrawn_at is null) = (withdrawn_by is null) and (withdrawn_at is null) = (withdrawal_reason is null))
);
create unique index defence_packet_open on grievance.defence_packet (notice_id)
  where status in ('DRAFT', 'AWAITING_AUTHORITY');
create index defence_packet_case on grievance.defence_packet (case_id);
create index defence_packet_subject on grievance.defence_packet (subject_id);
create index defence_packet_created_by on grievance.defence_packet (created_by);
create index defence_packet_submitted_by on grievance.defence_packet (submitted_by);
create index defence_packet_withdrawn_by on grievance.defence_packet (withdrawn_by);
comment on table grievance.defence_packet is
  'Selected evidence for one subject''s defence notice, after review and redaction (DEC-AMB-006, ADR-041). The subject '
  'reads only the cleared items of a released packet; it gives no general evidence access.';

create table grievance.defence_packet_item (
  id                uuid primary key default gen_random_uuid(),
  packet_id         uuid not null references grievance.defence_packet (id),
  position          int not null check (position between 1 and 50),
  evidence_id       uuid not null references evidence.evidence (id),
  source_version_id uuid not null references evidence.evidence_version (id),
  added_by          uuid not null references iam.user_profile (id),
  added_at          timestamptz not null default now(),
  unique (packet_id, position),
  unique (packet_id, evidence_id)
);
create index defence_packet_item_evidence on grievance.defence_packet_item (evidence_id);
create index defence_packet_item_version on grievance.defence_packet_item (source_version_id);
create index defence_packet_item_added_by on grievance.defence_packet_item (added_by);
comment on table grievance.defence_packet_item is
  'An evidence version chosen for a Defence Packet. Nothing reaches the subject until another evidence lead reviews it.';

create table grievance.defence_packet_review (
  id                       uuid primary key default gen_random_uuid(),
  item_id                  uuid not null unique references grievance.defence_packet_item (id),
  packet_id                uuid not null references grievance.defence_packet (id),
  outcome                  text not null check (outcome in ('CLEARED_AS_IS', 'CLEARED_REDACTED', 'WITHHELD')),
  -- What the subject sees: the chosen original, or a redacted rendition of it.
  disclosed_version_id     uuid references evidence.evidence_version (id),
  -- The title the subject sees, written by the reviewer: the evidence title may itself identify someone.
  disclosed_title          text check (length(disclosed_title) between 3 and 200),
  -- Every category the review covered (DEC-AMB-006); a cleared item covered all six.
  checks                   text[] not null check (checks <@ array['REPORTER', 'WITNESS', 'CONFIDENTIALITY', 'PRIVILEGE',
                                                                   'RESTRICTED_INFORMATION', 'OTHER_PROTECTED']::text[]),
  -- LEGAL_PRIVILEGE_RULE in force at the review (AMB-118), snapshotted.
  privilege_rule_reference text check (length(privilege_rule_reference) between 3 and 300),
  note                     text check (length(note) between 10 and 2000),
  reviewed_by              uuid not null references iam.user_profile (id),
  reviewed_at              timestamptz not null default now(),
  check ((outcome = 'WITHHELD') = (disclosed_version_id is null)),
  check ((outcome = 'WITHHELD') = (disclosed_title is null)),
  check ((outcome = 'WITHHELD') = (privilege_rule_reference is null)),
  check (outcome <> 'WITHHELD' or note is not null),
  check (outcome = 'WITHHELD' or checks @> array['REPORTER', 'WITNESS', 'CONFIDENTIALITY', 'PRIVILEGE',
                                                 'RESTRICTED_INFORMATION', 'OTHER_PROTECTED']::text[])
);
create index defence_packet_review_packet on grievance.defence_packet_review (packet_id);
create index defence_packet_review_version on grievance.defence_packet_review (disclosed_version_id);
create index defence_packet_review_reviewed_by on grievance.defence_packet_review (reviewed_by);
comment on table grievance.defence_packet_review is
  'The review of one packet item for the reporter, witnesses, confidentiality, privilege, restricted information and '
  'other protected identities (DEC-AMB-006). One per item, append-only; the note stays here.';

-- DEC-01 / CDF-208 pattern: on a restricted case the Restricted Case Authority consents to this packet; never the person
-- who made or submitted it. One decision per packet.
create table grievance.defence_packet_authority_decision (
  id         uuid primary key default gen_random_uuid(),
  packet_id  uuid not null unique references grievance.defence_packet (id),
  case_id    uuid not null references case_mgmt.case_record (id),
  decision   text not null check (decision in ('APPROVED', 'REJECTED')),
  reason     text not null check (length(reason) between 5 and 2000),
  decided_by uuid not null references iam.user_profile (id),
  decided_at timestamptz not null default now()
);
create index defence_packet_authority_decision_case on grievance.defence_packet_authority_decision (case_id);
create index defence_packet_authority_decision_decided_by on grievance.defence_packet_authority_decision (decided_by);

do $$
declare t text;
begin
  foreach t in array array['grievance.defence_packet_item', 'grievance.defence_packet_review',
                           'grievance.defence_packet_authority_decision'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;
create trigger no_delete before delete on grievance.defence_packet
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on grievance.defence_packet
  for each statement execute function committee.reject_mutation();

-- 5.3 Rules shared by the commands and the guards
-- An evidence version that may be shown: available, intact, and its item not excluded.
create function evidence.version_disclosable(p_version_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from evidence.evidence_version v
    where v.id = p_version_id and v.status = 'AVAILABLE'
      and not exists (select 1 from evidence.integrity_failure f where f.version_id = v.id)
      and not exists (select 1 from evidence.exclusion x where x.evidence_id = v.evidence_id));
$$;

-- Who assembles, submits and withdraws a case's Defence Packets: someone who manages the defence and directs the
-- investigation's evidence (DEC-09 leads). The committee secretary manages the defence but sees no evidence, so cannot.
create function grievance.manages_defence_packets(p_case_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select authz.can_manage_defence(p_case_id) and authz.is_evidence_lead(p_case_id);
$$;

-- Why a packet may not be released now, as a code; null when it may. Every item reviewed, at least one cleared, and
-- every cleared item still disclosable.
create function grievance.packet_release_block(p_packet_id uuid)
returns text
language sql stable
set search_path = ''
as $$
  select case
           when not exists (select 1 from grievance.defence_packet_item i where i.packet_id = p_packet_id)
             then 'PACKET_EMPTY'
           when exists (select 1 from grievance.defence_packet_item i
                        where i.packet_id = p_packet_id
                          and not exists (select 1 from grievance.defence_packet_review r where r.item_id = i.id))
             then 'ITEM_NOT_REVIEWED'
           when not exists (select 1 from grievance.defence_packet_review r
                            where r.packet_id = p_packet_id and r.outcome <> 'WITHHELD')
             then 'NOTHING_CLEARED'
           when exists (select 1 from grievance.defence_packet_review r
                        where r.packet_id = p_packet_id and r.outcome <> 'WITHHELD'
                          and not evidence.version_disclosable(r.disclosed_version_id))
             then 'ITEM_NOT_DISCLOSABLE'
         end;
$$;

-- What the subject may see of one item now: the cleared review of an item of a released packet of their own,
-- disclosable, and within their clearance. Null otherwise.
create function grievance.subject_item(p_item_id uuid)
returns grievance.defence_packet_review
language sql stable
set search_path = ''
as $$
  select r.* from grievance.defence_packet_item i
  join grievance.defence_packet k on k.id = i.packet_id
  join grievance.defence_notice n on n.id = k.notice_id
  join grievance.defence_packet_review r on r.item_id = i.id
  join evidence.evidence e on e.id = i.evidence_id
  where i.id = p_item_id and k.status = 'RELEASED' and n.status <> 'WITHDRAWN'
    and authz.current_user_id() is not null and authz.is_portal_subject(k.subject_id)
    and r.outcome <> 'WITHHELD' and evidence.version_disclosable(r.disclosed_version_id)
    and e.classification <= authz.current_clearance();
$$;

-- 5.4 Guards: every rule holds whatever the path.
create function grievance.guard_packet_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_k grievance.defence_packet;
  v_ver evidence.evidence_version;
begin
  select * into v_k from grievance.defence_packet k where k.id = new.packet_id;
  if v_k.status <> 'DRAFT' then perform api._fail('CONFLICT', 'PACKET_NOT_DRAFT'); end if;
  select * into v_ver from evidence.evidence_version v where v.id = new.source_version_id;
  if v_ver.evidence_id is distinct from new.evidence_id
     or not exists (select 1 from evidence.evidence e where e.id = new.evidence_id and e.case_id = v_k.case_id) then
    perform api._fail('INVALID', 'version_id');
  end if;
  if exists (select 1 from evidence.exclusion x where x.evidence_id = new.evidence_id) then
    perform api._fail('CONFLICT', 'EVIDENCE_EXCLUDED');
  end if;
  if v_ver.rendition <> 'ORIGINAL' then perform api._fail('CONFLICT', 'NOT_AN_ORIGINAL'); end if;
  if v_ver.status <> 'AVAILABLE' then perform api._fail('CONFLICT', 'VERSION_NOT_AVAILABLE'); end if;
  if exists (select 1 from evidence.integrity_failure f where f.version_id = v_ver.id) then
    perform api._fail('CONFLICT', 'INTEGRITY_FAILED');
  end if;
  return new;
end;
$$;
create trigger defence_packet_item_guard before insert on grievance.defence_packet_item
  for each row execute function grievance.guard_packet_item();

create function grievance.guard_packet_review()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_i grievance.defence_packet_item;
  v_k grievance.defence_packet;
  v_policy grievance.defence_packet_policy := grievance.packet_policy();
  v_ver evidence.evidence_version;
begin
  select * into v_i from grievance.defence_packet_item i where i.id = new.item_id;
  select * into v_k from grievance.defence_packet k where k.id = v_i.packet_id;
  if new.packet_id is distinct from v_i.packet_id then perform api._fail('INVALID', 'item_id'); end if;
  if v_k.status <> 'DRAFT' then perform api._fail('CONFLICT', 'PACKET_NOT_DRAFT'); end if;
  if coalesce(v_policy.reviewer_must_differ, true) and new.reviewed_by = v_i.added_by then
    perform api._fail('CONFLICT', 'REVIEWER_IS_CHOOSER');
  end if;
  if new.outcome <> 'WITHHELD' then
    -- AMB-118: nothing is cleared until LEGAL_PRIVILEGE_RULE is recorded (fail closed); the rule in force is snapshotted.
    if v_policy.privilege_rule_reference is null then perform api._fail('CONFLICT', 'LEGAL_PRIVILEGE_RULE_REQUIRED'); end if;
    new.privilege_rule_reference := v_policy.privilege_rule_reference;
    select * into v_ver from evidence.evidence_version v where v.id = new.disclosed_version_id;
    if (new.outcome = 'CLEARED_AS_IS' and v_ver.id is distinct from v_i.source_version_id)
       or (new.outcome = 'CLEARED_REDACTED'
           and (v_ver.rendition is distinct from 'REDACTED' or v_ver.derived_from_version_id is distinct from v_i.source_version_id)) then
      perform api._fail('INVALID', 'disclosed_version_id');
    end if;
    if not evidence.version_disclosable(v_ver.id) then perform api._fail('CONFLICT', 'ITEM_NOT_DISCLOSABLE'); end if;
  end if;
  return new;
end;
$$;
create trigger defence_packet_review_guard before insert on grievance.defence_packet_review
  for each row execute function grievance.guard_packet_review();

create function grievance.guard_packet_authority_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_k grievance.defence_packet;
  v_case case_mgmt.case_record;
begin
  select * into v_k from grievance.defence_packet k where k.id = new.packet_id;
  select * into v_case from case_mgmt.case_record c where c.id = v_k.case_id;
  if new.case_id is distinct from v_k.case_id then perform api._fail('INVALID', 'packet_id'); end if;
  if not v_case.is_restricted then perform api._fail('CONFLICT', 'CASE_NOT_RESTRICTED'); end if;
  if v_case.owner_id is distinct from new.decided_by
     or not authz.is_restricted_case_authority(new.decided_by, v_case.classification) then
    perform api._fail('FORBIDDEN');
  end if;
  if new.decided_by in (v_k.created_by, v_k.submitted_by) then perform api._fail('CONFLICT', 'REQUESTER_CANNOT_CONSENT'); end if;
  if v_k.status <> 'AWAITING_AUTHORITY' then perform api._fail('CONFLICT', 'NOT_AWAITING_AUTHORITY'); end if;
  return new;
end;
$$;
create trigger defence_packet_authority_decision_guard before insert on grievance.defence_packet_authority_decision
  for each row execute function grievance.guard_packet_authority_decision();

-- A packet's identity never changes; its status moves only forward, and a release needs a complete review and, on a
-- restricted case, the authority's approval.
create function grievance.protect_defence_packet()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_restricted boolean;
begin
  if (to_jsonb(new) - array['status', 'submitted_by', 'submitted_at', 'released_at', 'withdrawn_by', 'withdrawn_at',
                            'withdrawal_reason'])
     <> (to_jsonb(old) - array['status', 'submitted_by', 'submitted_at', 'released_at', 'withdrawn_by', 'withdrawn_at',
                               'withdrawal_reason'])
     or (old.submitted_at is not null and (new.submitted_at, new.submitted_by) is distinct from (old.submitted_at, old.submitted_by))
     or (old.released_at is not null and new.released_at is distinct from old.released_at)
     or not (old.status = new.status and old.status not in ('REJECTED_BY_AUTHORITY', 'WITHDRAWN')
                                     and (new.withdrawn_at, new.released_at) is not distinct from (old.withdrawn_at, old.released_at)
             or (old.status, new.status) in (('DRAFT', 'AWAITING_AUTHORITY'), ('DRAFT', 'RELEASED'), ('DRAFT', 'WITHDRAWN'),
                                             ('AWAITING_AUTHORITY', 'RELEASED'), ('AWAITING_AUTHORITY', 'REJECTED_BY_AUTHORITY'),
                                             ('AWAITING_AUTHORITY', 'WITHDRAWN'), ('RELEASED', 'WITHDRAWN'))) then
    raise exception 'defence packet % may not change that way', old.id using errcode = 'insufficient_privilege';
  end if;
  if new.status in ('AWAITING_AUTHORITY', 'RELEASED') and old.status = 'DRAFT' then
    if grievance.packet_release_block(new.id) is not null then
      perform api._fail('CONFLICT', grievance.packet_release_block(new.id));
    end if;
  end if;
  if new.status = 'RELEASED' and old.status <> 'RELEASED' then
    select c.is_restricted into v_restricted from case_mgmt.case_record c where c.id = new.case_id;
    if v_restricted and not exists (select 1 from grievance.defence_packet_authority_decision a
                                    where a.packet_id = new.id and a.decision = 'APPROVED') then
      perform api._fail('CONFLICT', 'AUTHORITY_APPROVAL_REQUIRED');
    end if;
    if grievance.packet_release_block(new.id) is not null then
      perform api._fail('CONFLICT', grievance.packet_release_block(new.id));
    end if;
  end if;
  return new;
end;
$$;
create trigger defence_packet_protect before update on grievance.defence_packet
  for each row execute function grievance.protect_defence_packet();

-- 5.5 RLS: the case's evidence leads read the packet records (the subject reads only through the commands below).
alter table grievance.defence_packet enable row level security;
alter table grievance.defence_packet_item enable row level security;
alter table grievance.defence_packet_review enable row level security;
alter table grievance.defence_packet_authority_decision enable row level security;
create policy defence_packet_read on grievance.defence_packet for select to authenticated
  using (authz.is_evidence_lead(case_id));
create policy defence_packet_item_read on grievance.defence_packet_item for select to authenticated
  using (authz.can_view_evidence(evidence_id)
         and exists (select 1 from grievance.defence_packet k where k.id = packet_id and authz.is_evidence_lead(k.case_id)));
create policy defence_packet_review_read on grievance.defence_packet_review for select to authenticated
  using (exists (select 1 from grievance.defence_packet_item i
                 join grievance.defence_packet k on k.id = i.packet_id
                 where i.id = item_id and authz.can_view_evidence(i.evidence_id) and authz.is_evidence_lead(k.case_id)));
create policy defence_packet_authority_decision_read on grievance.defence_packet_authority_decision for select
  to authenticated using (authz.is_evidence_lead(case_id));
grant select on grievance.defence_packet, grievance.defence_packet_item, grievance.defence_packet_review,
  grievance.defence_packet_authority_decision to authenticated;

-- 5.6 Commands
-- The packet, for the commands of whoever assembles packets on its case: NOT_FOUND, FORBIDDEN, then locked.
create function grievance.lock_packet(p_packet_id uuid, p_need_active boolean)
returns grievance.defence_packet
language plpgsql
set search_path = ''
as $$
declare v_k grievance.defence_packet;
begin
  select * into v_k from grievance.defence_packet k where k.id = p_packet_id;
  if v_k.id is null or not authz.can_view_case(v_k.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not grievance.manages_defence_packets(v_k.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_k.case_id for update;
  if p_need_active and not exists (select 1 from case_mgmt.case_record c
                                   where c.id = v_k.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  select * into v_k from grievance.defence_packet k where k.id = p_packet_id for update;
  return v_k;
end;
$$;

-- The subject is told that a packet was released for their notice (template code and notice id only, §39).
create function grievance.notify_packet_released(p_k grievance.defence_packet)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform notify.enqueue('DEFENCE_PACKET_RELEASED',
    (select l.user_id from grievance.subject_portal_link l where l.subject_id = p_k.subject_id and l.revoked_at is null),
    p_k.notice_id, null, 'defence-packet-released:' || p_k.id);
end;
$$;

create function api.create_defence_packet(p_notice_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_n grievance.defence_notice;
  v_seq int;
  v_id uuid;
begin
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id;
  if v_n.id is null or not authz.can_view_case(v_n.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not grievance.manages_defence_packets(v_n.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_n.case_id for update;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_n.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id for update;
  if v_n.kind <> 'DEFENCE' then perform api._fail('CONFLICT', 'NOT_A_DEFENCE_NOTICE'); end if;
  if v_n.status not in ('ISSUED', 'ACKNOWLEDGED') then perform api._fail('CONFLICT', 'NOTICE_NOT_OPEN'); end if;
  if exists (select 1 from grievance.defence_packet k
             where k.notice_id = v_n.id and k.status in ('DRAFT', 'AWAITING_AUTHORITY')) then
    perform api._fail('CONFLICT', 'PACKET_ALREADY_OPEN');
  end if;
  select coalesce(max(k.sequence_no), 0) + 1 into v_seq from grievance.defence_packet k where k.notice_id = v_n.id;
  insert into grievance.defence_packet (notice_id, case_id, subject_id, sequence_no, created_by)
  values (v_n.id, v_n.case_id, v_n.subject_id, v_seq, v_actor)
  returning id into v_id;
  perform audit.record_event('DEFENCE_PACKET_CREATED', 'BUSINESS', 'SUCCESS', v_n.case_id, 'defence_packet', v_id::text,
    null, jsonb_build_object('notice_id', v_n.id, 'subject_id', v_n.subject_id, 'sequence_no', v_seq));
  return v_id;
end;
$$;

-- An original version of an item the chooser can see, on the packet's case. Excluded, unavailable, rendition and
-- integrity-failed versions are refused (T-AMB-094).
create function api.add_defence_packet_item(p_packet_id uuid, p_version_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_k grievance.defence_packet;
  v_ver evidence.evidence_version;
  v_ev evidence.evidence;
  v_pos int;
  v_id uuid;
begin
  v_k := grievance.lock_packet(p_packet_id, true);
  select * into v_ver from evidence.evidence_version v where v.id = p_version_id;
  if v_ver.id is null or not authz.can_view_evidence(v_ver.evidence_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_ev from evidence.evidence e where e.id = v_ver.evidence_id;
  if v_ev.case_id <> v_k.case_id then perform api._fail('INVALID', 'version_id'); end if;
  if v_k.status <> 'DRAFT' then perform api._fail('CONFLICT', 'PACKET_NOT_DRAFT'); end if;
  if exists (select 1 from grievance.defence_packet_item i where i.packet_id = v_k.id and i.evidence_id = v_ev.id) then
    perform api._fail('CONFLICT', 'ALREADY_ADDED');
  end if;
  select coalesce(max(i.position), 0) + 1 into v_pos from grievance.defence_packet_item i where i.packet_id = v_k.id;
  if v_pos > 50 then perform api._fail('CONFLICT', 'TOO_MANY_ITEMS'); end if;
  -- The guard refuses an excluded item, a rendition, an unavailable or an integrity-failed version.
  insert into grievance.defence_packet_item (packet_id, position, evidence_id, source_version_id, added_by)
  values (v_k.id, v_pos, v_ev.id, v_ver.id, v_actor)
  returning id into v_id;
  perform audit.record_event('DEFENCE_PACKET_ITEM_ADDED', 'BUSINESS', 'SUCCESS', v_k.case_id, 'defence_packet', v_k.id::text,
    null, jsonb_build_object('item_id', v_id, 'evidence_id', v_ev.id, 'version_id', v_ver.id, 'position', v_pos));
  return v_id;
end;
$$;

-- Another evidence lead reviews the item for the six protected categories and clears it as is, clears a redacted
-- rendition of it, or withholds it with a note. Clearing needs LEGAL_PRIVILEGE_RULE (AMB-118).
create function api.review_defence_packet_item(p_item_id uuid, p_outcome text, p_disclosed_version_id uuid,
                                               p_disclosed_title text, p_checks text[], p_note text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_i grievance.defence_packet_item;
  v_k grievance.defence_packet;
  v_all text[] := array['REPORTER', 'WITNESS', 'CONFIDENTIALITY', 'PRIVILEGE', 'RESTRICTED_INFORMATION', 'OTHER_PROTECTED'];
  v_checks text[] := coalesce(p_checks, '{}');
  v_version uuid;
  v_id uuid;
begin
  select * into v_i from grievance.defence_packet_item i where i.id = p_item_id;
  select * into v_k from grievance.defence_packet k where k.id = v_i.packet_id;
  if v_i.id is null or not authz.can_view_case(v_k.case_id) or not authz.can_view_evidence(v_i.evidence_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if not authz.is_evidence_lead(v_k.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_k.case_id for update;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_k.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  select * into v_k from grievance.defence_packet k where k.id = v_i.packet_id for update;
  if v_k.status <> 'DRAFT' then perform api._fail('CONFLICT', 'PACKET_NOT_DRAFT'); end if;
  if exists (select 1 from grievance.defence_packet_review r where r.item_id = v_i.id) then
    perform api._fail('CONFLICT', 'ALREADY_REVIEWED');
  end if;
  if coalesce((grievance.packet_policy()).reviewer_must_differ, true) and v_i.added_by = v_actor then
    perform api._fail('CONFLICT', 'REVIEWER_IS_CHOOSER');
  end if;
  if p_outcome is null or p_outcome not in ('CLEARED_AS_IS', 'CLEARED_REDACTED', 'WITHHELD') then
    perform api._fail('INVALID', 'outcome');
  end if;
  if (select count(distinct x) from unnest(v_checks) x) <> cardinality(v_checks) or not (v_checks <@ v_all)
     or (p_outcome <> 'WITHHELD' and not (v_checks @> v_all)) then
    perform api._fail('INVALID', 'checks');
  end if;
  if p_outcome = 'WITHHELD' then
    if p_disclosed_version_id is not null then perform api._fail('INVALID', 'disclosed_version_id'); end if;
    if p_disclosed_title is not null then perform api._fail('INVALID', 'disclosed_title'); end if;
    perform api._require_text(p_note, 'note', 10, 2000);
  else
    perform api._require_text(p_disclosed_title, 'disclosed_title', 3, 200);
    if p_note is not null then perform api._require_text(p_note, 'note', 10, 2000); end if;
    if (grievance.packet_policy()).privilege_rule_reference is null then
      perform api._fail('CONFLICT', 'LEGAL_PRIVILEGE_RULE_REQUIRED');
    end if;
    v_version := case when p_outcome = 'CLEARED_AS_IS' then coalesce(p_disclosed_version_id, v_i.source_version_id)
                      else p_disclosed_version_id end;
    if not exists (select 1 from evidence.evidence_version v
                   where v.id = v_version and v.evidence_id = v_i.evidence_id
                     and case p_outcome when 'CLEARED_AS_IS' then v.id = v_i.source_version_id
                                        else v.rendition = 'REDACTED' and v.derived_from_version_id = v_i.source_version_id end) then
      perform api._fail('INVALID', 'disclosed_version_id');
    end if;
    if not evidence.version_disclosable(v_version) then perform api._fail('CONFLICT', 'ITEM_NOT_DISCLOSABLE'); end if;
  end if;
  insert into grievance.defence_packet_review (item_id, packet_id, outcome, disclosed_version_id, disclosed_title, checks,
                                               note, reviewed_by)
  values (v_i.id, v_k.id, p_outcome, v_version, nullif(btrim(p_disclosed_title), ''), v_checks,
          nullif(btrim(p_note), ''), v_actor)
  returning id into v_id;
  perform audit.record_event('DEFENCE_PACKET_ITEM_REVIEWED', 'BUSINESS', 'SUCCESS', v_k.case_id, 'defence_packet',
    v_k.id::text, null, jsonb_build_object('item_id', v_i.id, 'review_id', v_id, 'outcome', p_outcome));
  return v_id;
end;
$$;

-- Submits a complete packet: released at once on an ordinary case; on a restricted case it waits for the Restricted
-- Case Authority, who is told.
create function api.submit_defence_packet(p_packet_id uuid)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_k grievance.defence_packet;
  v_case case_mgmt.case_record;
  v_block text;
  v_status text;
begin
  v_k := grievance.lock_packet(p_packet_id, true);
  if v_k.status <> 'DRAFT' then perform api._fail('CONFLICT', 'PACKET_NOT_DRAFT'); end if;
  if not exists (select 1 from grievance.defence_notice n
                 where n.id = v_k.notice_id and n.status in ('ISSUED', 'ACKNOWLEDGED')) then
    perform api._fail('CONFLICT', 'NOTICE_NOT_OPEN');
  end if;
  v_block := grievance.packet_release_block(v_k.id);
  if v_block is not null then perform api._fail('CONFLICT', v_block); end if;
  select * into v_case from case_mgmt.case_record c where c.id = v_k.case_id;
  v_status := case when v_case.is_restricted then 'AWAITING_AUTHORITY' else 'RELEASED' end;
  update grievance.defence_packet
     set status = v_status, submitted_by = v_actor, submitted_at = now(),
         released_at = case when v_status = 'RELEASED' then now() end
   where id = v_k.id
  returning * into v_k;
  if v_status = 'RELEASED' then
    perform grievance.notify_packet_released(v_k);
  elsif authz.is_restricted_case_authority(v_case.owner_id, v_case.classification) then
    perform notify.enqueue('DEFENCE_PACKET_APPROVAL_REQUESTED', v_case.owner_id, v_k.id, null,
                           'defence-packet-approval:' || v_k.id);
  end if;
  perform audit.record_event('DEFENCE_PACKET_SUBMITTED', 'BUSINESS', 'SUCCESS', v_k.case_id, 'defence_packet', v_k.id::text,
    null, jsonb_build_object('status', v_status,
                             'cleared', (select count(*) from grievance.defence_packet_review r
                                         where r.packet_id = v_k.id and r.outcome <> 'WITHHELD'),
                             'withheld', (select count(*) from grievance.defence_packet_review r
                                          where r.packet_id = v_k.id and r.outcome = 'WITHHELD')));
  return v_status;
end;
$$;

-- The Restricted Case Authority (the case's owner, eligible for its classification) approves or rejects a packet on a
-- restricted case; never the person who made or submitted it (CDF-208 pattern).
create function api.decide_restricted_defence_packet(p_packet_id uuid, p_decision text, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_k grievance.defence_packet;
  v_case case_mgmt.case_record;
  v_reason text;
  v_block text;
  v_status text;
begin
  select * into v_k from grievance.defence_packet k where k.id = p_packet_id;
  if v_k.id is null or not authz.can_view_case(v_k.case_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = v_k.case_id for update;
  if not v_case.is_restricted then perform api._fail('CONFLICT', 'CASE_NOT_RESTRICTED'); end if;
  if v_case.owner_id is distinct from v_actor
     or not authz.is_restricted_case_authority(v_actor, v_case.classification) then
    perform api._fail('FORBIDDEN');
  end if;
  select * into v_k from grievance.defence_packet k where k.id = p_packet_id for update;
  if v_actor in (v_k.created_by, v_k.submitted_by) then perform api._fail('CONFLICT', 'REQUESTER_CANNOT_CONSENT'); end if;
  if v_k.status <> 'AWAITING_AUTHORITY' then perform api._fail('CONFLICT', 'NOT_AWAITING_AUTHORITY'); end if;
  if p_decision is null or p_decision not in ('APPROVE', 'REJECT') then perform api._fail('INVALID', 'decision'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  if p_decision = 'APPROVE' then
    if v_case.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
    if not exists (select 1 from grievance.defence_notice n
                   where n.id = v_k.notice_id and n.status in ('ISSUED', 'ACKNOWLEDGED')) then
      perform api._fail('CONFLICT', 'NOTICE_NOT_OPEN');
    end if;
    v_block := grievance.packet_release_block(v_k.id);
    if v_block is not null then perform api._fail('CONFLICT', v_block); end if;
  end if;
  insert into grievance.defence_packet_authority_decision (packet_id, case_id, decision, reason, decided_by)
  values (v_k.id, v_k.case_id, case p_decision when 'APPROVE' then 'APPROVED' else 'REJECTED' end, v_reason, v_actor);
  v_status := case p_decision when 'APPROVE' then 'RELEASED' else 'REJECTED_BY_AUTHORITY' end;
  update grievance.defence_packet
     set status = v_status, released_at = case when v_status = 'RELEASED' then now() end
   where id = v_k.id
  returning * into v_k;
  if v_status = 'RELEASED' then perform grievance.notify_packet_released(v_k); end if;
  perform audit.record_event('DEFENCE_PACKET_AUTHORITY_DECIDED', 'BUSINESS', 'SUCCESS', v_k.case_id, 'defence_packet',
    v_k.id::text, null, jsonb_build_object('decision', p_decision, 'status', v_status,
                                           'classification', v_case.classification));
  return v_status;
end;
$$;

-- Withdrawal ends the subject's view at once, released or not. Removing access needs no active case.
create function api.withdraw_defence_packet(p_packet_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_k grievance.defence_packet;
  v_reason text;
begin
  v_k := grievance.lock_packet(p_packet_id, false);
  if v_k.status not in ('DRAFT', 'AWAITING_AUTHORITY', 'RELEASED') then perform api._fail('CONFLICT', 'PACKET_CLOSED'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  update grievance.defence_packet
     set status = 'WITHDRAWN', withdrawn_by = v_actor, withdrawn_at = now(), withdrawal_reason = v_reason
   where id = v_k.id;
  perform audit.record_event('DEFENCE_PACKET_WITHDRAWN', 'BUSINESS', 'SUCCESS', v_k.case_id, 'defence_packet', v_k.id::text,
    null, jsonb_build_object('previous_status', v_k.status));
end;
$$;

-- 5.7 Reads
-- The packet for its case's evidence leads and its Restricted Case Authority: items, reviews (without notes) and what
-- blocks release. A read; packet commands are the audited events.
create function api.defence_packet_view(p_packet_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_k grievance.defence_packet;
begin
  perform api._actor();
  select * into v_k from grievance.defence_packet k where k.id = p_packet_id;
  if v_k.id is null or not authz.can_view_case(v_k.case_id) or not authz.is_evidence_lead(v_k.case_id) then
    perform api._fail('NOT_FOUND');
  end if;
  return jsonb_build_object(
    'packet_id', v_k.id, 'notice_id', v_k.notice_id, 'subject_id', v_k.subject_id, 'sequence_no', v_k.sequence_no,
    'status', v_k.status, 'created_by', v_k.created_by, 'created_at', v_k.created_at, 'submitted_by', v_k.submitted_by,
    'submitted_at', v_k.submitted_at, 'released_at', v_k.released_at, 'withdrawn_at', v_k.withdrawn_at,
    'release_block', case when v_k.status = 'DRAFT' then grievance.packet_release_block(v_k.id) end,
    'authority_decision', (select a.decision from grievance.defence_packet_authority_decision a where a.packet_id = v_k.id),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'item_id', i.id, 'position', i.position, 'evidence_id', i.evidence_id, 'source_version_id', i.source_version_id,
               'added_by', i.added_by, 'added_at', i.added_at,
               'excluded', exists (select 1 from evidence.exclusion x where x.evidence_id = i.evidence_id),
               'custody_flagged', exists (select 1 from evidence.custody_exception c where c.evidence_id = i.evidence_id),
               'review', (select jsonb_build_object('outcome', r.outcome, 'disclosed_version_id', r.disclosed_version_id,
                                                    'disclosed_title', r.disclosed_title, 'checks', to_jsonb(r.checks),
                                                    'privilege_rule_reference', r.privilege_rule_reference,
                                                    'reviewed_by', r.reviewed_by, 'reviewed_at', r.reviewed_at,
                                                    'disclosable', r.outcome <> 'WITHHELD'
                                                                   and evidence.version_disclosable(r.disclosed_version_id))
                          from grievance.defence_packet_review r where r.item_id = i.id))
             order by i.position)
      from grievance.defence_packet_item i
      where i.packet_id = v_k.id and authz.can_view_evidence(i.evidence_id)), '[]'::jsonb));
end;
$$;

-- The subject's released packets for one of their notices: the cleared items, by their reviewed titles, with type and
-- size. Never the evidence title, description, source, file name, classification or anything withheld. Audited.
create function api.my_defence_packet(p_notice_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_n grievance.defence_notice;
  v_doc jsonb;
begin
  perform api._actor();
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id;
  if v_n.id is null or not authz.is_portal_subject(v_n.subject_id) or v_n.status = 'WITHDRAWN' then
    perform api._fail('NOT_FOUND');
  end if;
  v_doc := jsonb_build_object('notice_id', v_n.id, 'packets', coalesce((
    select jsonb_agg(jsonb_build_object(
             'packet_id', k.id, 'sequence_no', k.sequence_no, 'released_at', k.released_at,
             'items', coalesce((
               select jsonb_agg(jsonb_build_object('item_id', i.id, 'position', i.position, 'title', r.disclosed_title,
                                                   'content_type', v.content_type, 'size_bytes', v.size_bytes)
                                order by i.position)
               from grievance.defence_packet_item i
               join grievance.defence_packet_review r on r.item_id = i.id
               join evidence.evidence_version v on v.id = r.disclosed_version_id
               where i.packet_id = k.id and (grievance.subject_item(i.id)).id is not null), '[]'::jsonb))
           order by k.sequence_no)
    from grievance.defence_packet k
    where k.notice_id = v_n.id and k.status = 'RELEASED'), '[]'::jsonb));
  perform audit.record_event('DEFENCE_PACKET_VIEWED', 'BUSINESS', 'SUCCESS', v_n.case_id, 'defence_notice', v_n.id::text,
    null, jsonb_build_object('packets', jsonb_array_length(v_doc -> 'packets')));
  return v_doc;
end;
$$;

-- Opening one cleared item for the subject: the storage facts for server code only, under a neutral file name, with how
-- the viewer may serve it (INLINE while PACKET_EVIDENCE_DOWNLOAD is false). Records custody and audit; otherwise a
-- SECURITY denial and nothing (missing and not permitted are alike).
create function api.open_defence_packet_item(p_item_id uuid)
returns table (o_object_key text, o_file_name text, o_content_type text, o_size_bytes bigint, o_sha256 text,
               o_version_id uuid, o_disposition text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r grievance.defence_packet_review;
  v_i grievance.defence_packet_item;
  v_ver evidence.evidence_version;
  v_case uuid;
begin
  v_r := grievance.subject_item(p_item_id);
  if v_r.id is not null then
    select * into v_i from grievance.defence_packet_item i where i.id = p_item_id;
    select * into v_ver from evidence.evidence_version v where v.id = v_r.disclosed_version_id;
    select k.case_id into v_case from grievance.defence_packet k where k.id = v_i.packet_id;
    insert into evidence.custody_event (evidence_id, version_id, event_type, actor_id, request_id, details)
    values (v_ver.evidence_id, v_ver.id, 'PACKET_VIEWED', v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid,
            jsonb_build_object('version_no', v_ver.version_no, 'packet_id', v_i.packet_id));
    perform audit.record_event('DEFENCE_PACKET_ITEM_VIEWED', 'BUSINESS', 'SUCCESS', v_case, 'defence_packet',
      v_i.packet_id::text, null, jsonb_build_object('item_id', v_i.id, 'version_id', v_ver.id));
    return query
      select v_ver.object_key,
             'defence-item-' || v_i.position || '.' || (select t.extensions[1] from evidence.allowed_content_type t
                                                        where t.content_type = v_ver.content_type),
             v_ver.content_type, v_ver.size_bytes, v_ver.sha256, v_ver.id,
             case when coalesce((grievance.packet_policy()).packet_evidence_download, false) then 'ATTACHMENT'
                  else 'INLINE' end;
    return;
  end if;
  perform audit.record_event('DEFENCE_PACKET_ACCESS_DENIED', 'SECURITY', 'DENIED', null, 'defence_packet_item',
    p_item_id::text, null,
    jsonb_build_object('target_exists', exists (select 1 from grievance.defence_packet_item i where i.id = p_item_id)));
  return;
end;
$$;

-- Server code reports a content hash that did not match on read (AMB-165): for a version the reader may download, or
-- may view through their released Defence Packet. The version is blocked from then on.
create function api.report_evidence_integrity_failure(p_version_id uuid, p_observed_sha256 text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_ver evidence.evidence_version;
  v_ev evidence.evidence;
  v_owner uuid;
  v_id uuid;
begin
  select * into v_ver from evidence.evidence_version v where v.id = p_version_id;
  if v_ver.id is null or v_ver.status <> 'AVAILABLE'
     or not (authz.can_download_evidence(v_ver.evidence_id)
             or exists (select 1 from grievance.defence_packet_review r
                        where r.disclosed_version_id = v_ver.id and (grievance.subject_item(r.item_id)).id is not null)) then
    perform api._fail('NOT_FOUND');
  end if;
  if p_observed_sha256 is null or p_observed_sha256 !~ '^[0-9a-f]{64}$' then
    perform api._fail('INVALID', 'observed_sha256');
  end if;
  if p_observed_sha256 = v_ver.sha256 then perform api._fail('CONFLICT', 'HASH_MATCHES'); end if;
  select * into v_ev from evidence.evidence e where e.id = v_ver.evidence_id;
  perform 1 from evidence.evidence_version v where v.id = v_ver.id for update;
  if exists (select 1 from evidence.integrity_failure f where f.version_id = v_ver.id) then
    perform api._fail('CONFLICT', 'ALREADY_REPORTED');
  end if;
  insert into evidence.integrity_failure (version_id, evidence_id, case_id, expected_sha256, observed_sha256, detected_by,
                                          request_id)
  values (v_ver.id, v_ev.id, v_ev.case_id, v_ver.sha256, p_observed_sha256, v_actor,
          nullif(current_setting('cdf.request_id', true), '')::uuid)
  returning id into v_id;
  insert into evidence.custody_event (evidence_id, version_id, event_type, actor_id, request_id, details)
  values (v_ev.id, v_ver.id, 'INTEGRITY_FAILED', v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid,
          jsonb_build_object('version_no', v_ver.version_no, 'expected_sha256', v_ver.sha256,
                             'observed_sha256', p_observed_sha256));
  perform audit.record_event('EVIDENCE_INTEGRITY_FAILURE_RECORDED', 'BUSINESS', 'SUCCESS', v_ev.case_id,
    'evidence_version', v_ver.id::text, null,
    jsonb_build_object('evidence_id', v_ev.id, 'version_no', v_ver.version_no, 'integrity_failure_id', v_id));
  perform audit.record_event('EVIDENCE_INTEGRITY_FAILED', 'SECURITY', 'FAILURE', v_ev.case_id, 'evidence_version',
    v_ver.id::text, null,
    jsonb_build_object('evidence_id', v_ev.id, 'version_no', v_ver.version_no, 'expected_sha256', v_ver.sha256,
                       'observed_sha256', p_observed_sha256));
  -- The case owner is told by template code (AMB-165); the target page re-authorizes.
  select c.owner_id into v_owner from case_mgmt.case_record c where c.id = v_ev.case_id;
  if v_owner is not null and authz.user_can_view_case(v_owner, v_ev.case_id) then
    perform notify.enqueue('EVIDENCE_INTEGRITY_FAILED', v_owner, v_ev.case_id, null, 'evidence-integrity:' || v_ver.id);
  end if;
end;
$$;

-- An evidence lead registers a redacted rendition of an available, intact original (AMB-169). The file then goes through
-- quarantine, scan and api.complete_evidence_version like any version; the original is untouched.
create function api.register_evidence_rendition(p_source_version_id uuid, p_original_file_name text, p_content_type text,
                                                p_size_bytes bigint, p_sha256 text)
returns table (o_evidence_id uuid, o_version_id uuid, o_version_no int, o_object_key text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_src evidence.evidence_version;
  v_ev evidence.evidence;
  v_file text;
  v_version_id uuid;
  v_version_no int;
  v_key text;
begin
  select * into v_src from evidence.evidence_version v where v.id = p_source_version_id;
  if v_src.id is null or not authz.can_view_evidence(v_src.evidence_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_ev from evidence.evidence e where e.id = v_src.evidence_id;
  if not (authz.is_evidence_lead(v_ev.case_id) and authz.has_permission('EVIDENCE_UPLOAD')) then
    perform api._fail('FORBIDDEN');
  end if;
  -- Locking the case serialises version numbering, as in api.register_evidence_version.
  perform 1 from case_mgmt.case_record c where c.id = v_ev.case_id for update;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_ev.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if exists (select 1 from evidence.exclusion x where x.evidence_id = v_ev.id) then
    perform api._fail('CONFLICT', 'EVIDENCE_EXCLUDED');
  end if;
  if v_src.rendition <> 'ORIGINAL' then perform api._fail('CONFLICT', 'NOT_AN_ORIGINAL'); end if;
  if v_src.status <> 'AVAILABLE' then perform api._fail('CONFLICT', 'VERSION_NOT_AVAILABLE'); end if;
  if exists (select 1 from evidence.integrity_failure f where f.version_id = v_src.id) then
    perform api._fail('CONFLICT', 'INTEGRITY_FAILED');
  end if;
  v_file := api._require_text(p_original_file_name, 'file_name', 1, 255);
  if v_file ~ '[/\\]' or v_file ~ '[[:cntrl:]]' or v_file ~ '^\.+$' then perform api._fail('INVALID', 'file_name'); end if;
  if not exists (select 1 from evidence.allowed_content_type t where t.content_type = p_content_type) then
    perform api._fail('INVALID', 'content_type');
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 26214400 then perform api._fail('INVALID', 'size_bytes'); end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then perform api._fail('INVALID', 'sha256'); end if;
  if exists (select 1 from evidence.evidence_version v
             where v.evidence_id = v_ev.id and v.sha256 = p_sha256 and v.status <> 'REJECTED') then
    perform api._fail('CONFLICT', 'DUPLICATE_VERSION');
  end if;
  select coalesce(max(v.version_no), 0) + 1 into v_version_no from evidence.evidence_version v where v.evidence_id = v_ev.id;
  v_version_id := gen_random_uuid();
  v_key := 'cases/' || v_ev.case_id::text || '/evidence/' || v_ev.id::text || '/' || v_version_id::text;
  insert into evidence.evidence_version (id, evidence_id, version_no, object_key, original_file_name, content_type, size_bytes,
                                         sha256, uploaded_by, request_id, rendition, derived_from_version_id)
  values (v_version_id, v_ev.id, v_version_no, v_key, v_file, p_content_type, p_size_bytes, p_sha256, v_actor,
          nullif(current_setting('cdf.request_id', true), '')::uuid, 'REDACTED', v_src.id);
  insert into evidence.custody_event (evidence_id, version_id, event_type, actor_id, request_id, details)
  values (v_ev.id, v_version_id, 'RECEIVED', v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid,
          jsonb_build_object('version_no', v_version_no, 'sha256', p_sha256, 'size_bytes', p_size_bytes,
                             'content_type', p_content_type, 'rendition', 'REDACTED',
                             'derived_from_version_no', v_src.version_no));
  perform audit.record_event('EVIDENCE_RENDITION_RECEIVED', 'BUSINESS', 'SUCCESS', v_ev.case_id, 'evidence_version',
    v_version_id::text, null,
    jsonb_build_object('evidence_id', v_ev.id, 'version_no', v_version_no, 'source_version_id', v_src.id,
                       'sha256', p_sha256, 'size_bytes', p_size_bytes, 'content_type', p_content_type));
  return query select v_ev.id, v_version_id, v_version_no, v_key;
end;
$$;

-- As in 0900, except that a completed rendition stays a rendition: the item's current version and status follow its
-- originals only (AMB-169).
create or replace function api.complete_evidence_version(p_version_id uuid, p_scan_status text, p_scanner text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_ver evidence.evidence_version;
  v_case_id uuid;
begin
  select * into v_ver from evidence.evidence_version v where v.id = p_version_id for update;
  if v_ver.id is null or not authz.can_view_evidence(v_ver.evidence_id) then perform api._fail('NOT_FOUND'); end if;
  if v_ver.uploaded_by <> v_actor then perform api._fail('FORBIDDEN'); end if;
  if v_ver.status <> 'QUARANTINED' then perform api._fail('CONFLICT', 'VERSION_NOT_QUARANTINED'); end if;
  if p_scan_status is distinct from 'CLEAN' then perform api._fail('INVALID', 'scan_status'); end if;
  select e.case_id into v_case_id from evidence.evidence e where e.id = v_ver.evidence_id;

  update evidence.evidence_version
     set status = 'AVAILABLE', scan_status = 'CLEAN', scanner = left(p_scanner, 80), stored_at = now()
   where id = p_version_id;
  if v_ver.rendition = 'ORIGINAL' then
    update evidence.evidence
       set status = 'AVAILABLE', current_version_id = p_version_id, updated_at = now()
     where id = v_ver.evidence_id;
  end if;

  insert into evidence.custody_event (evidence_id, version_id, event_type, actor_id, request_id, details)
  values (v_ver.evidence_id, p_version_id, 'STORED', v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid,
          jsonb_build_object('version_no', v_ver.version_no, 'scan_status', 'CLEAN', 'scanner', left(p_scanner, 80)));

  perform audit.record_event('EVIDENCE_STORED', 'BUSINESS', 'SUCCESS', v_case_id, 'evidence_version', p_version_id::text, null,
    jsonb_build_object('evidence_id', v_ver.evidence_id, 'version_no', v_ver.version_no, 'sha256', v_ver.sha256,
                       'scanner', left(p_scanner, 80), 'rendition', v_ver.rendition));
end;
$$;

-- =============================================================================
-- 6. The prior-sanctions extract (DEC-AMB-005, AMB-034, AMB-106; T-AMB-015)
-- =============================================================================
create table decision.sanction_extract (
  id                      uuid primary key default gen_random_uuid(),
  case_id                 uuid not null references case_mgmt.case_record (id),
  committee_proceeding_id uuid not null references committee.committee_proceeding (id),
  subject_id              uuid not null references case_mgmt.case_subject (id),
  reason                  text not null check (length(reason) between 10 and 2000),
  requested_by            uuid not null references iam.user_profile (id),
  requested_at            timestamptz not null default now()
);
create index sanction_extract_case on decision.sanction_extract (case_id);
create index sanction_extract_proceeding on decision.sanction_extract (committee_proceeding_id);
create index sanction_extract_subject on decision.sanction_extract (subject_id);
create index sanction_extract_requested_by on decision.sanction_extract (requested_by);
comment on table decision.sanction_extract is
  'The secretary''s purpose-bound extract of a subject''s prior final disciplinary sanctions for one committee proceeding '
  '(DEC-AMB-005, ADR-041). Read only through api.sanction_extract_view.';

create table decision.sanction_extract_row (
  id                    uuid primary key default gen_random_uuid(),
  extract_id            uuid not null references decision.sanction_extract (id),
  position              int not null check (position >= 1),
  -- Where the row came from: kept for the authority's decision and the audit, never returned to a reader of the extract.
  source_execution_id   uuid not null references decision.sanction_execution (id),
  source_case_id        uuid not null references case_mgmt.case_record (id),
  source_classification core.classification_level not null,
  source_restricted     boolean not null,
  -- What a reader sees: the sanction and two dates.
  sanction_code         text references decision.sanction_catalogue (code),
  decided_on            date not null,
  effective_from        date not null,
  status                text not null check (status in ('INCLUDED', 'AWAITING_AUTHORITY', 'WITHHELD')),
  decided_by            uuid references iam.user_profile (id),
  decided_at            timestamptz,
  decision_reason       text check (length(decision_reason) between 5 and 2000),
  unique (extract_id, position),
  unique (extract_id, source_execution_id),
  check (source_restricted or (status = 'INCLUDED' and decided_at is null)),
  check (not source_restricted or (status = 'AWAITING_AUTHORITY') = (decided_at is null)),
  check ((decided_at is null) = (decided_by is null) and (decided_at is null) = (decision_reason is null))
);
create index sanction_extract_row_execution on decision.sanction_extract_row (source_execution_id);
create index sanction_extract_row_source_case on decision.sanction_extract_row (source_case_id);
create index sanction_extract_row_code on decision.sanction_extract_row (sanction_code);
create index sanction_extract_row_decided_by on decision.sanction_extract_row (decided_by);
create index sanction_extract_row_awaiting on decision.sanction_extract_row (source_case_id) where status = 'AWAITING_AUTHORITY';
comment on table decision.sanction_extract_row is
  'One prior final sanction in an extract. A row from a restricted case waits for that case''s Restricted Case Authority '
  'and is invisible to the extract''s readers until approved (DEC-AMB-005).';

create trigger no_update before update on decision.sanction_extract
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on decision.sanction_extract
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on decision.sanction_extract
  for each statement execute function committee.reject_mutation();
create trigger no_delete before delete on decision.sanction_extract_row
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on decision.sanction_extract_row
  for each statement execute function committee.reject_mutation();

-- A row changes once: an awaiting row is approved (INCLUDED) or withheld, with who, when and why.
create function decision.protect_sanction_extract_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'AWAITING_AUTHORITY' or new.status not in ('INCLUDED', 'WITHHELD')
     or (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'decision_reason'])
        <> (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'decision_reason']) then
    raise exception 'sanction extract row % may not change that way', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger sanction_extract_row_protect before update on decision.sanction_extract_row
  for each row execute function decision.protect_sanction_extract_row();

-- No reader policy: the extract is read through api.sanction_extract_view and the authority's queue only.
alter table decision.sanction_extract enable row level security;
alter table decision.sanction_extract_row enable row level security;

-- A person's final disciplinary sanctions in cases other than the given one. Final: executed, from a decision that is
-- not superseded, under conflict remediation or tainted (DEC-AMB-013/003), whose grievance window has ended, with no
-- grievance open on it and none that set it aside (a grievance whose decision is unknown counts, as in 2040). The
-- sanction is the one in effect after any grievance substitution (DEC-AMB-011).
create function decision.final_sanctions_of_person(p_person_id uuid, p_other_than_case uuid)
returns table (execution_id uuid, case_id uuid, classification core.classification_level, is_restricted boolean,
               sanction_code text, decided_on date, effective_from date)
language sql stable
set search_path = ''
as $$
  select x.id, x.case_id, c.classification, c.is_restricted,
         decision.effective_sanction_code(x.item_id, x.subject_id), (d.decided_at at time zone 'UTC')::date,
         (x.effective_from at time zone 'UTC')::date
  from decision.sanction_execution x
  join case_mgmt.case_subject s on s.id = x.subject_id
  join case_mgmt.case_record c on c.id = x.case_id
  join decision.authority_decision d on d.id = x.authority_decision_id
  join grievance.defence_notice n on n.id = x.decision_notice_id
  where s.person_id = p_person_id and x.case_id <> p_other_than_case
    and x.effective_from <= now()
    and decision.decision_block(d.id) is null
    and n.grievance_window_ends_at is not null and n.grievance_window_ends_at <= now()
    and not exists (
      select 1 from grievance.grievance g
      where g.grievant_subject_id = x.subject_id
        and (g.contested_authority_decision_id is null or g.contested_authority_decision_id = d.id)
        and (g.status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED')
             or (g.status = 'DECIDED'
                 and exists (select 1 from grievance.grievance_outcome o
                             where o.grievance_id = g.id
                               and o.outcomes && array['CANCEL', 'RETURN_FOR_REINVESTIGATION']::text[])
                 and (not exists (select 1 from grievance.contested_item ci where ci.grievance_id = g.id)
                      or exists (select 1 from grievance.contested_item ci
                                 where ci.grievance_id = g.id and ci.item_id = x.item_id)))))
  order by d.decided_at, x.id;
$$;

-- The extract's readers: the proceeding's secretary and its seated members, cleared for the case and without a meeting
-- conflict in the proceeding. Never the case team as such, never the subject.
create function decision.reads_sanction_extract(p_extract_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from decision.sanction_extract x
    join committee.committee_proceeding cp on cp.id = x.committee_proceeding_id
    where x.id = p_extract_id
      and authz.user_case_gate(authz.current_user_id(), cp.case_id)
      and not authz.has_meeting_conflict(authz.current_user_id(), cp.id)
      and (authz.is_committee_secretary(cp.committee_id)
           or exists (select 1 from committee.proceeding_member pm
                      where pm.committee_proceeding_id = cp.id and pm.user_id = authz.current_user_id()
                        and not pm.case_gate_excluded
                        and authz.user_committee_seat(pm.user_id, cp.committee_id, now()) is not null)));
$$;

-- The secretary of an open proceeding asks for the prior final sanctions of one of the case's subjects. Rows from
-- ordinary cases are included at once; a row from a restricted case waits for that case's Restricted Case Authority,
-- who is told, and nothing about it is visible until then.
create function api.request_sanction_extract(p_committee_proceeding_id uuid, p_subject_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_cp committee.committee_proceeding;
  v_s case_mgmt.case_subject;
  v_reason text;
  v_id uuid;
  v_pos int := 0;
  v_included int := 0;
  v_row uuid;
  v_owner uuid;
  r record;
begin
  select * into v_cp from committee.committee_proceeding cp where cp.id = p_committee_proceeding_id;
  if v_cp.id is null or not authz.can_view_committee_proceeding(v_cp.id) then perform api._fail('NOT_FOUND'); end if;
  if not (authz.is_committee_secretary(v_cp.committee_id) and authz.user_case_gate(v_actor, v_cp.case_id)
          and not authz.has_meeting_conflict(v_actor, v_cp.id)) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_cp.status <> 'OPEN' then perform api._fail('CONFLICT', 'PROCEEDING_NOT_OPEN'); end if;
  select * into v_s from case_mgmt.case_subject s where s.id = p_subject_id and s.case_id = v_cp.case_id;
  if v_s.id is null then perform api._fail('INVALID', 'subject_id'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  insert into decision.sanction_extract (case_id, committee_proceeding_id, subject_id, reason, requested_by)
  values (v_cp.case_id, v_cp.id, v_s.id, v_reason, v_actor)
  returning id into v_id;
  for r in select * from decision.final_sanctions_of_person(v_s.person_id, v_cp.case_id) loop
    v_pos := v_pos + 1;
    insert into decision.sanction_extract_row (extract_id, position, source_execution_id, source_case_id,
                                               source_classification, source_restricted, sanction_code, decided_on,
                                               effective_from, status)
    values (v_id, v_pos, r.execution_id, r.case_id, r.classification, r.is_restricted, r.sanction_code, r.decided_on,
            r.effective_from, case when r.is_restricted then 'AWAITING_AUTHORITY' else 'INCLUDED' end)
    returning id into v_row;
    if r.is_restricted then
      select c.owner_id into v_owner from case_mgmt.case_record c where c.id = r.case_id;
      if authz.is_restricted_case_authority(v_owner, r.classification) then
        perform notify.enqueue('SANCTION_EXTRACT_APPROVAL_REQUESTED', v_owner, v_row, null, 'sanction-extract:' || v_row);
      end if;
    else
      v_included := v_included + 1;
    end if;
  end loop;
  -- The ledger of the requesting case says nothing about restricted cases: the count is of included rows only.
  perform audit.record_event('SANCTION_EXTRACT_REQUESTED', 'BUSINESS', 'SUCCESS', v_cp.case_id, 'sanction_extract',
    v_id::text, null, jsonb_build_object('committee_proceeding_id', v_cp.id, 'subject_id', v_s.id,
                                         'included', v_included));
  return v_id;
end;
$$;

-- The extract for its readers: included rows within the reader's clearance, as sanction code and dates. Audited.
create function api.sanction_extract_view(p_extract_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_x decision.sanction_extract;
  v_doc jsonb;
begin
  perform api._actor();
  select * into v_x from decision.sanction_extract x where x.id = p_extract_id;
  if v_x.id is null or not decision.reads_sanction_extract(v_x.id) then perform api._fail('NOT_FOUND'); end if;
  v_doc := jsonb_build_object(
    'extract_id', v_x.id, 'committee_proceeding_id', v_x.committee_proceeding_id, 'subject_id', v_x.subject_id,
    'requested_by', v_x.requested_by, 'requested_at', v_x.requested_at,
    'sanctions', coalesce((
      select jsonb_agg(jsonb_build_object('position', r.rn, 'sanction_code', r.sanction_code,
                                          'catalogue_sanction', r.sanction_code is not null,
                                          'decided_on', r.decided_on, 'effective_from', r.effective_from)
                       order by r.rn)
      from (select q.*, row_number() over (order by q.decided_on, q.position) as rn
            from decision.sanction_extract_row q
            where q.extract_id = v_x.id and q.status = 'INCLUDED'
              and q.source_classification <= authz.current_clearance()) r), '[]'::jsonb));
  perform audit.record_event('SANCTION_EXTRACT_VIEWED', 'BUSINESS', 'SUCCESS', v_x.case_id, 'sanction_extract',
    v_x.id::text, null, jsonb_build_object('sanctions', jsonb_array_length(v_doc -> 'sanctions')));
  return v_doc;
end;
$$;

-- The source case's Restricted Case Authority approves or withholds one awaiting row; never the extract's requester.
-- Anyone else gets NOT_FOUND, so the request reveals nothing.
create function api.decide_sanction_extract_row(p_row_id uuid, p_decision text, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_r decision.sanction_extract_row;
  v_case case_mgmt.case_record;
  v_reason text;
  v_status text;
begin
  select * into v_r from decision.sanction_extract_row q where q.id = p_row_id;
  select * into v_case from case_mgmt.case_record c where c.id = v_r.source_case_id;
  if v_r.id is null or not v_r.source_restricted or v_case.owner_id is distinct from v_actor
     or not authz.is_restricted_case_authority(v_actor, v_case.classification) or not authz.can_view_case(v_case.id) then
    perform api._fail('NOT_FOUND');
  end if;
  select * into v_r from decision.sanction_extract_row q where q.id = p_row_id for update;
  if exists (select 1 from decision.sanction_extract x where x.id = v_r.extract_id and x.requested_by = v_actor) then
    perform api._fail('CONFLICT', 'REQUESTER_CANNOT_CONSENT');
  end if;
  if v_r.status <> 'AWAITING_AUTHORITY' then perform api._fail('CONFLICT', 'ALREADY_DECIDED'); end if;
  if p_decision is null or p_decision not in ('APPROVE', 'REJECT') then perform api._fail('INVALID', 'decision'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  v_status := case p_decision when 'APPROVE' then 'INCLUDED' else 'WITHHELD' end;
  update decision.sanction_extract_row
     set status = v_status, decided_by = v_actor, decided_at = now(), decision_reason = v_reason
   where id = v_r.id;
  -- Recorded on the source case: the row and the decision only, nothing about the requesting case.
  perform audit.record_event('SANCTION_EXTRACT_ROW_DECIDED', 'BUSINESS', 'SUCCESS', v_case.id, 'sanction_extract_row',
    v_r.id::text, null, jsonb_build_object('decision', p_decision, 'classification', v_case.classification));
  return v_status;
end;
$$;

-- The rows awaiting the caller as Restricted Case Authority: their own case and subject, the sanction, when it was asked
-- and by which committee. Nothing about the requesting case.
create function api.my_sanction_extract_approvals()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'row_id', q.id, 'source_case_id', c.id, 'source_case_number', c.case_number, 'subject_id', x2.subject_id,
           'sanction_code', q.sanction_code, 'decided_on', q.decided_on, 'effective_from', q.effective_from,
           'requested_at', x.requested_at, 'committee_code', cm.code)
         order by x.requested_at, q.id), '[]'::jsonb)
  from decision.sanction_extract_row q
  join decision.sanction_extract x on x.id = q.extract_id
  join committee.committee_proceeding cp on cp.id = x.committee_proceeding_id
  join committee.committee cm on cm.id = cp.committee_id
  join case_mgmt.case_record c on c.id = q.source_case_id
  join decision.sanction_execution x2 on x2.id = q.source_execution_id
  where authz.current_user_id() is not null and q.status = 'AWAITING_AUTHORITY'
    and c.owner_id = authz.current_user_id()
    and authz.is_restricted_case_authority(authz.current_user_id(), c.classification)
    and authz.can_view_case(c.id);
$$;

-- =============================================================================
-- 7. CDF-212 (AGENT-09): a member whose seat has ended declares nothing
-- =============================================================================
-- As in 2030, except that a MEMBER participant's seat must be current (committee.member_seat_current), as for
-- cast_vote, revise_vote, record_attendance and the deliberation view: CONFLICT:SEAT_ENDED.
create or replace function api.declare_meeting_conflict(p_participant_id uuid, p_status text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p committee.meeting_participant;
  v_m committee.meeting;
  v_source text;
  v_reason text;
begin
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id;
  if v_p.id is null or not authz.can_view_meeting(v_p.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_m := committee.lock_visible_meeting(v_p.meeting_id);
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id for update;
  if v_p.user_id = v_actor then
    v_source := 'SELF';
  elsif v_p.user_id is null and authz.can_manage_meeting(v_m.id) then
    v_source := 'SECRETARY';
  else
    perform api._fail('FORBIDDEN');
  end if;
  if v_m.status not in ('SCHEDULED', 'OPEN') then perform api._fail('CONFLICT', 'MEETING_NOT_ACTIVE'); end if;
  if v_p.participant_kind = 'MEMBER' and not committee.member_seat_current(v_p.id) then
    perform api._fail('CONFLICT', 'SEAT_ENDED');
  end if;
  if not v_p.requires_coi then perform api._fail('CONFLICT', 'COI_NOT_REQUIRED'); end if;
  if p_status is null or p_status not in ('NO_CONFLICT', 'CONFLICT_DECLARED') then perform api._fail('INVALID', 'status'); end if;
  if v_p.coi_status = 'CONFLICT_DECLARED' or (v_p.coi_status = 'NO_CONFLICT' and p_status = 'NO_CONFLICT') then
    perform api._fail('CONFLICT', 'COI_ALREADY_DECLARED');
  end if;
  if p_status = 'NO_CONFLICT' and v_p.participant_kind = 'MEMBER' and exists (
       select 1 from committee.meeting_participant prior
       join committee.meeting pm on pm.id = prior.meeting_id
       where pm.committee_proceeding_id = v_m.committee_proceeding_id and pm.id <> v_m.id
         and prior.proceeding_member_id = v_p.proceeding_member_id and prior.coi_status = 'CONFLICT_DECLARED'
         and committee.conflict_counts(prior.id)) then
    perform api._fail('CONFLICT', 'PRIOR_CONFLICT_DECLARED');
  end if;
  v_reason := case when p_status = 'CONFLICT_DECLARED' or p_reason is not null
                   then api._require_text(p_reason, 'reason', 5, 2000) end;

  insert into committee.meeting_conflict (meeting_id, participant_id, status, declared_by, source, reason)
  values (v_m.id, v_p.id, p_status, v_actor, v_source, v_reason);
  update committee.meeting_participant
     set coi_status = p_status, coi_declared_at = now(),
         attendance = case when p_status = 'CONFLICT_DECLARED' and attendance <> 'NOT_RECORDED' then 'EXCUSED_CONFLICT'
                           else attendance end
   where id = v_p.id;
  -- The reason stays in the declaration row (declarer and secretary only); the ledger gets the fact.
  perform audit.record_event('COI_DECLARED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_participant', v_p.id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'status', p_status, 'source', v_source, 'participant_kind', v_p.participant_kind));
end;
$$;

-- =============================================================================
-- 8. Grants, notifications and the catalogue
-- =============================================================================
revoke all on function
  evidence.guard_excluded_item(), evidence.guard_custody_exception(), evidence.guard_rendition(),
  evidence.version_disclosable(uuid),
  grievance.protect_packet_policy(), grievance.packet_policy(), grievance.manages_defence_packets(uuid),
  grievance.packet_release_block(uuid), grievance.subject_item(uuid), grievance.guard_packet_item(),
  grievance.guard_packet_review(), grievance.guard_packet_authority_decision(), grievance.protect_defence_packet(),
  grievance.lock_packet(uuid, boolean), grievance.notify_packet_released(grievance.defence_packet),
  decision.protect_sanction_extract_row(), decision.final_sanctions_of_person(uuid, uuid),
  decision.reads_sanction_extract(uuid)
from public, anon, authenticated;

revoke all on function
  api.exclude_evidence(uuid, text), api.evidence_exclusion_record(uuid),
  api.record_custody_exception(uuid, uuid, text, text, text),
  api.report_evidence_integrity_failure(uuid, text),
  api.register_evidence_rendition(uuid, text, text, bigint, text),
  api.create_defence_packet(uuid), api.add_defence_packet_item(uuid, uuid),
  api.review_defence_packet_item(uuid, text, uuid, text, text[], text), api.submit_defence_packet(uuid),
  api.decide_restricted_defence_packet(uuid, text, text), api.withdraw_defence_packet(uuid, text),
  api.defence_packet_view(uuid), api.my_defence_packet(uuid), api.open_defence_packet_item(uuid),
  api.request_sanction_extract(uuid, uuid, text), api.sanction_extract_view(uuid),
  api.decide_sanction_extract_row(uuid, text, text), api.my_sanction_extract_approvals()
from public;
grant execute on function
  api.exclude_evidence(uuid, text), api.evidence_exclusion_record(uuid),
  api.record_custody_exception(uuid, uuid, text, text, text),
  api.report_evidence_integrity_failure(uuid, text),
  api.register_evidence_rendition(uuid, text, text, bigint, text),
  api.create_defence_packet(uuid), api.add_defence_packet_item(uuid, uuid),
  api.review_defence_packet_item(uuid, text, uuid, text, text[], text), api.submit_defence_packet(uuid),
  api.decide_restricted_defence_packet(uuid, text, text), api.withdraw_defence_packet(uuid, text),
  api.defence_packet_view(uuid), api.my_defence_packet(uuid), api.open_defence_packet_item(uuid),
  api.request_sanction_extract(uuid, uuid, text), api.sanction_extract_view(uuid),
  api.decide_sanction_extract_row(uuid, text, text), api.my_sanction_extract_approvals()
to authenticated;

-- Notification object types, deep links and templates (ADR-025): ids only; the target page re-authorizes.
alter table notify.template drop constraint template_object_type_check;
alter table notify.template add constraint template_object_type_check check (object_type in (
  'COMMITTEE', 'MEETING', 'MINUTES', 'LEGAL_REVIEW', 'DEFENCE_NOTICE', 'GRIEVANCE', 'EXPORT', 'CORRECTIVE_ACTION',
  'BCP_IMPORT', 'REFERRAL', 'PRELIMINARY_REVIEW', 'CASE', 'DEFENCE_PACKET', 'SANCTION_EXTRACT_APPROVAL'));
alter table notify.outbox drop constraint outbox_object_type_check;
alter table notify.outbox add constraint outbox_object_type_check check (object_type in (
  'COMMITTEE', 'MEETING', 'MINUTES', 'LEGAL_REVIEW', 'DEFENCE_NOTICE', 'GRIEVANCE', 'EXPORT', 'CORRECTIVE_ACTION',
  'BCP_IMPORT', 'REFERRAL', 'PRELIMINARY_REVIEW', 'CASE', 'DEFENCE_PACKET', 'SANCTION_EXTRACT_APPROVAL'));

-- Replaced from 2040: three more paths, ids only.
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
         end;
$$;

insert into notify.template (code, object_type, is_mandatory, description) values
  ('EVIDENCE_INTEGRITY_FAILED',           'CASE',                      true,
   'A stored evidence version failed its integrity check on the user''s case (AMB-165)'),
  ('DEFENCE_PACKET_APPROVAL_REQUESTED',   'DEFENCE_PACKET',            true,
   'A Defence Packet on the user''s restricted case awaits their approval (DEC-AMB-006)'),
  ('DEFENCE_PACKET_RELEASED',             'DEFENCE_NOTICE',            true,
   'Selected evidence was released to the subject for their defence (DEC-AMB-006)'),
  ('SANCTION_EXTRACT_APPROVAL_REQUESTED', 'SANCTION_EXTRACT_APPROVAL', true,
   'A prior-sanctions extract asks to include a sanction from the user''s restricted case (DEC-AMB-005)');
insert into notify.rule (layer, template_code, channel, enabled, effective_from, reason)
select 'SYSTEM_MANDATORY', t.code, c.channel, true, '2026-01-01T00:00:00Z', 'Synthetic default: mandatory notice (ADR-025)'
from notify.template t cross join (values ('IN_APP'), ('EMAIL')) c (channel)
where t.code in ('EVIDENCE_INTEGRITY_FAILED', 'DEFENCE_PACKET_APPROVAL_REQUESTED', 'DEFENCE_PACKET_RELEASED',
                 'SANCTION_EXTRACT_APPROVAL_REQUESTED');

-- The form and status catalogue (migration 1970) follows the schema: P11-G4 closes.
update config.legacy_status_map
   set target_event = 'EVIDENCE_EXCLUDED',
       target_event_state = 'IMPLEMENTED',
       target_object = 'evidence.exclusion',
       notes = 'An item excluded for a substantive reason, kept on record, since migration 2050 (P11-G4, evidence half).',
       gap_ref = null
 where gap_ref = 'P11-G4' and legacy_code = 'S083';
update config.legacy_status_map
   set target_event = 'EVIDENCE_EXCLUDED',
       target_object = 'evidence.exclusion',
       notes = 'Duplicate of S083: one action, api.exclude_evidence (migration 2050).'
 where legacy_code = 'S118' and disposition = 'DUPLICATE';
update config.legacy_form_map
   set merge_target = case legacy_id
         when 'T3-B2.3-112' then 'api.exclude_evidence (the reason in evidence.exclusion; the item is kept, never deleted)'
         when 'T3-B2.3-144' then 'api.evidence_exclusion_record (generated from the exclusion)'
       end,
       gap_ref = null
 where gap_ref = 'P11-G4' and legacy_id in ('T3-B2.3-112', 'T3-B2.3-144');
update config.target_module
   set commands = commands || array['api.exclude_evidence', 'api.evidence_exclusion_record', 'api.record_custody_exception',
                                    'api.register_evidence_rendition', 'api.report_evidence_integrity_failure'],
       delivered_in = delivered_in || '2050'::text,
       notes = 'Private storage, immutable versions; exclusion with a reason, custody exceptions, redacted renditions and '
               'the integrity check on read (2050).'
 where code = 'EVIDENCE';
