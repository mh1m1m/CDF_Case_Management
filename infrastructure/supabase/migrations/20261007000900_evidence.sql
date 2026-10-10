-- =============================================================================
-- 0900 Evidence and chain of custody (Phase 7, second vertical slice)
-- Requirements: §24–§28, §75, §83; ADR-006; threats T05, T10
--
-- Evidence content never enters the database: it lives in private object storage behind the
-- EvidenceStorage port. The database holds metadata, the immutable version record (object key,
-- SHA-256, size, type), the append-only custody trail and the audit events.
--
-- Upload protocol (driven by the application layer, every step audited in its own transaction):
--   1. api.register_evidence_version   → version QUARANTINED, custody RECEIVED, audit EVIDENCE_RECEIVED
--   2. storage.putQuarantine + scan    (outside the database)
--   3. api.complete_evidence_version   → version AVAILABLE, custody STORED,   audit EVIDENCE_STORED
--      or api.reject_evidence_version  → version REJECTED,  custody REJECTED, audit EVIDENCE_REJECTED
--   4. api.open_evidence_version       → custody DOWNLOADED, audit EVIDENCE_DOWNLOADED (or a SECURITY denial)
-- Nothing ever deletes or overwrites a version: triggers reject it for every role, the owner included.
-- =============================================================================

create schema if not exists evidence;
revoke all on schema evidence from public;
alter default privileges in schema evidence revoke all on tables from public, anon, authenticated;
alter default privileges in schema evidence revoke all on sequences from public, anon, authenticated;
alter default privileges in schema evidence revoke execute on functions from public, anon, authenticated;
grant usage on schema evidence to authenticated;

-- -----------------------------------------------------------------------------
-- Permissions (mirrored in packages/authorization; tests/integration/mirrors.spec.ts)
-- -----------------------------------------------------------------------------
insert into iam.permission (code, description) values
  ('EVIDENCE_UPLOAD',   'Add evidence files and new versions on active cases the user works on'),
  ('EVIDENCE_DOWNLOAD', 'Download evidence content on viewable cases');

insert into iam.role_permission (role_code, permission_code) values
  ('INVESTIGATOR',      'EVIDENCE_UPLOAD'), ('INVESTIGATOR',      'EVIDENCE_DOWNLOAD'),
  ('LEAD_INVESTIGATOR', 'EVIDENCE_UPLOAD'), ('LEAD_INVESTIGATOR', 'EVIDENCE_DOWNLOAD'),
  ('CASE_MANAGER',      'EVIDENCE_UPLOAD'), ('CASE_MANAGER',      'EVIDENCE_DOWNLOAD'),
  ('GRC_DIRECTOR',      'EVIDENCE_UPLOAD'), ('GRC_DIRECTOR',      'EVIDENCE_DOWNLOAD'),
  ('LEGAL_REVIEWER',    'EVIDENCE_DOWNLOAD'),
  ('HR_REVIEWER',       'EVIDENCE_DOWNLOAD'),
  ('COMMITTEE_CHAIR',   'EVIDENCE_DOWNLOAD'),
  ('COMMITTEE_MEMBER',  'EVIDENCE_DOWNLOAD');

-- -----------------------------------------------------------------------------
-- Reference data: the content-type allow-list (§25). Mirrored in packages/domain (evidence rules).
-- -----------------------------------------------------------------------------
create table evidence.allowed_content_type (
  content_type  text primary key check (content_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$' and length(content_type) <= 120),
  extensions    text[] not null check (cardinality(extensions) >= 1),
  evidence_type text not null check (evidence_type in ('DOCUMENT', 'IMAGE', 'AUDIO', 'VIDEO', 'EMAIL', 'DATA_EXPORT'))
);
insert into evidence.allowed_content_type (content_type, extensions, evidence_type) values
  ('application/pdf',                                                           array['pdf'],         'DOCUMENT'),
  ('application/vnd.openxmlformats-officedocument.wordprocessingml.document',   array['docx'],        'DOCUMENT'),
  ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         array['xlsx'],        'DATA_EXPORT'),
  ('application/vnd.openxmlformats-officedocument.presentationml.presentation', array['pptx'],        'DOCUMENT'),
  ('text/plain',                                                                array['txt'],         'DOCUMENT'),
  ('text/csv',                                                                  array['csv'],         'DATA_EXPORT'),
  ('application/json',                                                          array['json'],        'DATA_EXPORT'),
  ('message/rfc822',                                                            array['eml'],         'EMAIL'),
  ('image/png',                                                                 array['png'],         'IMAGE'),
  ('image/jpeg',                                                                array['jpg', 'jpeg'], 'IMAGE'),
  ('image/gif',                                                                 array['gif'],         'IMAGE'),
  ('image/webp',                                                                array['webp'],        'IMAGE'),
  ('audio/mpeg',                                                                array['mp3'],         'AUDIO'),
  ('audio/mp4',                                                                 array['m4a'],         'AUDIO'),
  ('audio/wav',                                                                 array['wav'],         'AUDIO'),
  ('video/mp4',                                                                 array['mp4'],         'VIDEO');

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table evidence.evidence (
  id                 uuid primary key default gen_random_uuid(),
  case_id            uuid not null references case_mgmt.case_record (id),
  -- Display number within the case (EV-001). UUIDs are the keys (§87).
  sequence_no        int not null check (sequence_no >= 1),
  title              text not null check (length(title) between 3 and 200),
  description        text check (length(description) <= 2000),
  evidence_type      text not null check (evidence_type in ('DOCUMENT', 'IMAGE', 'AUDIO', 'VIDEO', 'EMAIL', 'DATA_EXPORT', 'OTHER')),
  source_description text check (length(source_description) <= 500),
  collected_at       date check (collected_at <= current_date),
  -- Never below the case classification; may be higher, which hides the item from lower-cleared team members.
  classification     core.classification_level not null,
  status             text not null default 'PENDING' check (status in ('PENDING', 'AVAILABLE', 'REJECTED')),
  current_version_id uuid,  -- FK added below
  created_by         uuid not null references iam.user_profile (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (case_id, sequence_no)
);
create index evidence_case on evidence.evidence (case_id, sequence_no);
comment on table evidence.evidence is 'Evidence item metadata. Content lives in private object storage; see evidence_version (§24).';

create table evidence.evidence_version (
  id                 uuid primary key default gen_random_uuid(),
  evidence_id        uuid not null references evidence.evidence (id),
  version_no         int not null check (version_no >= 1),
  -- Random, immutable, never user-controlled (threat T05). Not readable by application roles.
  object_key         text not null unique
                     check (object_key ~ '^cases/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/evidence/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
  original_file_name text not null check (
                       length(original_file_name) between 1 and 255
                       and original_file_name !~ '[/\\]' and original_file_name !~ '[[:cntrl:]]' and original_file_name !~ '^\.+$'),
  content_type       text not null references evidence.allowed_content_type (content_type),
  size_bytes         bigint not null check (size_bytes between 1 and 26214400),  -- 25 MiB (§25)
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status             text not null default 'QUARANTINED' check (status in ('QUARANTINED', 'AVAILABLE', 'REJECTED')),
  scan_status        text not null default 'PENDING' check (scan_status in ('PENDING', 'CLEAN', 'INFECTED', 'UNSCANNED')),
  scanner            text check (length(scanner) <= 80),
  rejection_code     text check (rejection_code in ('MALWARE_DETECTED', 'SCAN_UNAVAILABLE', 'STORAGE_FAILURE')),
  uploaded_by        uuid not null references iam.user_profile (id),
  uploaded_at        timestamptz not null default now(),
  stored_at          timestamptz,
  request_id         uuid,
  unique (evidence_id, version_no),
  check ((status = 'AVAILABLE') = (stored_at is not null)),
  check ((status = 'REJECTED') = (rejection_code is not null)),
  check (status <> 'AVAILABLE' or scan_status = 'CLEAN')
);
-- The same content is one live version per evidence item; a rejected attempt may be retried.
create unique index evidence_version_live_content on evidence.evidence_version (evidence_id, sha256) where status <> 'REJECTED';
comment on column evidence.evidence_version.object_key is 'Storage key cases/{case}/evidence/{evidence}/{version}. Only api.open_evidence_version reveals it, to server code.';

alter table evidence.evidence
  add constraint evidence_current_version_fk foreign key (current_version_id) references evidence.evidence_version (id);

create table evidence.custody_event (
  id          uuid primary key default gen_random_uuid(),
  -- Strict chain order (now() is constant within a transaction, so timestamps alone cannot order events).
  seq         bigint generated always as identity,
  evidence_id uuid not null references evidence.evidence (id),
  version_id  uuid references evidence.evidence_version (id),
  event_type  text not null check (event_type in ('RECEIVED', 'STORED', 'REJECTED', 'DOWNLOADED')),
  actor_id    uuid not null references iam.user_profile (id),
  occurred_at timestamptz not null default now(),
  request_id  uuid,
  -- Technical facts only (hash, size, scan result); never content or free text (§83).
  details     jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and length(details::text) <= 1024)
);
create index custody_event_evidence on evidence.custody_event (evidence_id, seq);
comment on table evidence.custody_event is 'Append-only chain of custody (§26). UPDATE/DELETE/TRUNCATE are rejected for every role.';

-- -----------------------------------------------------------------------------
-- Immutability (§26, §27): no overwrite, no delete, for the owner too.
-- -----------------------------------------------------------------------------
create function evidence.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'evidence.% is append-only (% rejected)', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger custody_event_no_update before update on evidence.custody_event
  for each row execute function evidence.reject_mutation();
create trigger custody_event_no_delete before delete on evidence.custody_event
  for each row execute function evidence.reject_mutation();
create trigger custody_event_no_truncate before truncate on evidence.custody_event
  for each statement execute function evidence.reject_mutation();
create trigger evidence_version_no_delete before delete on evidence.evidence_version
  for each row execute function evidence.reject_mutation();
create trigger evidence_version_no_truncate before truncate on evidence.evidence_version
  for each statement execute function evidence.reject_mutation();
create trigger evidence_no_delete before delete on evidence.evidence
  for each row execute function evidence.reject_mutation();
create trigger evidence_no_truncate before truncate on evidence.evidence
  for each statement execute function evidence.reject_mutation();

-- A version may change only while QUARANTINED, and only its outcome columns.
create function evidence.protect_version()
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
     or new.request_id is distinct from old.request_id then
    raise exception 'evidence version % content fields are immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger evidence_version_protect before update on evidence.evidence_version
  for each row execute function evidence.protect_version();

-- -----------------------------------------------------------------------------
-- Authorization (§19): case access + clearance against the evidence classification + permission
-- -----------------------------------------------------------------------------
create function authz.can_view_evidence(p_evidence_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from evidence.evidence e
    where e.id = p_evidence_id
      and authz.can_view_case(e.case_id)
      and e.classification <= authz.current_clearance()
  );
$$;

create function authz.can_download_evidence(p_evidence_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_evidence(p_evidence_id) and authz.has_permission('EVIDENCE_DOWNLOAD');
$$;

-- Uploading needs the permission and a working relationship with an active case: an assignment as
-- owner/lead/investigator, or general edit rights. Viewing alone (a grant) is not enough.
create function authz.can_upload_evidence(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id)
     and authz.has_permission('EVIDENCE_UPLOAD')
     and exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state = 'ACTIVE')
     and (authz.has_permission('CASE_EDIT_ALL')
          or authz.has_active_assignment(p_case_id, authz.current_user_id(), array['CASE_OWNER', 'LEAD_INVESTIGATOR', 'INVESTIGATOR']));
$$;

grant execute on function
  authz.can_view_evidence(uuid), authz.can_download_evidence(uuid), authz.can_upload_evidence(uuid)
to authenticated;

-- -----------------------------------------------------------------------------
-- RLS (SELECT only). object_key and request_id are never readable by application roles.
-- -----------------------------------------------------------------------------
alter table evidence.allowed_content_type enable row level security;
alter table evidence.evidence enable row level security;
alter table evidence.evidence_version enable row level security;
alter table evidence.custody_event enable row level security;

create policy allowed_content_type_read on evidence.allowed_content_type for select to authenticated
  using (authz.current_user_id() is not null);
grant select on evidence.allowed_content_type to authenticated;

create policy evidence_read on evidence.evidence for select to authenticated using (authz.can_view_evidence(id));
grant select on evidence.evidence to authenticated;

create policy evidence_version_read on evidence.evidence_version for select to authenticated
  using (authz.can_view_evidence(evidence_id));
grant select (id, evidence_id, version_no, original_file_name, content_type, size_bytes, sha256, status, scan_status,
              scanner, rejection_code, uploaded_by, uploaded_at, stored_at)
  on evidence.evidence_version to authenticated;

create policy custody_event_read on evidence.custody_event for select to authenticated
  using (authz.can_view_evidence(evidence_id));
grant select on evidence.custody_event to authenticated;

-- -----------------------------------------------------------------------------
-- Commands
-- -----------------------------------------------------------------------------
create function api.register_evidence_version(
  p_case_id uuid, p_evidence_id uuid, p_title text, p_description text, p_evidence_type text,
  p_source_description text, p_collected_at date, p_classification core.classification_level,
  p_original_file_name text, p_content_type text, p_size_bytes bigint, p_sha256 text
)
returns table (o_evidence_id uuid, o_version_id uuid, o_version_no int, o_object_key text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_ev evidence.evidence;
  v_file text;
  v_version_id uuid;
  v_version_no int;
  v_key text;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_upload_evidence(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  -- Locking the case serialises sequence and version numbering.
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;

  -- File facts (third validation after the browser and the application layer, §45)
  v_file := api._require_text(p_original_file_name, 'file_name', 1, 255);
  if v_file ~ '[/\\]' or v_file ~ '[[:cntrl:]]' or v_file ~ '^\.+$' then perform api._fail('INVALID', 'file_name'); end if;
  if not exists (select 1 from evidence.allowed_content_type t where t.content_type = p_content_type) then
    perform api._fail('INVALID', 'content_type');
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 26214400 then perform api._fail('INVALID', 'size_bytes'); end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then perform api._fail('INVALID', 'sha256'); end if;

  if p_evidence_id is null then
    -- New evidence item
    if p_evidence_type is null or p_evidence_type not in ('DOCUMENT', 'IMAGE', 'AUDIO', 'VIDEO', 'EMAIL', 'DATA_EXPORT', 'OTHER') then
      perform api._fail('INVALID', 'evidence_type');
    end if;
    if p_description is not null and length(p_description) > 2000 then perform api._fail('INVALID', 'description'); end if;
    if p_source_description is not null and length(p_source_description) > 500 then perform api._fail('INVALID', 'source_description'); end if;
    if p_collected_at is not null and p_collected_at > current_date then perform api._fail('INVALID', 'collected_at'); end if;
    if p_classification is null or p_classification < v_case.classification or p_classification > authz.current_clearance() then
      perform api._fail('INVALID', 'classification');
    end if;
    insert into evidence.evidence (case_id, sequence_no, title, description, evidence_type, source_description, collected_at,
                                   classification, created_by)
    values (p_case_id,
            (select coalesce(max(e.sequence_no), 0) + 1 from evidence.evidence e where e.case_id = p_case_id),
            api._require_text(p_title, 'title', 3, 200), nullif(btrim(coalesce(p_description, '')), ''), p_evidence_type,
            nullif(btrim(coalesce(p_source_description, '')), ''), p_collected_at, p_classification, v_actor)
    returning * into v_ev;
    v_version_no := 1;
  else
    -- New version of an existing item on this case
    select * into v_ev from evidence.evidence e where e.id = p_evidence_id and e.case_id = p_case_id for update;
    if v_ev.id is null then perform api._fail('NOT_FOUND'); end if;
    if exists (select 1 from evidence.evidence_version v
               where v.evidence_id = v_ev.id and v.sha256 = p_sha256 and v.status <> 'REJECTED') then
      perform api._fail('CONFLICT', 'DUPLICATE_VERSION');
    end if;
    select coalesce(max(v.version_no), 0) + 1 into v_version_no from evidence.evidence_version v where v.evidence_id = v_ev.id;
  end if;

  v_version_id := gen_random_uuid();
  v_key := 'cases/' || p_case_id::text || '/evidence/' || v_ev.id::text || '/' || v_version_id::text;
  insert into evidence.evidence_version (id, evidence_id, version_no, object_key, original_file_name, content_type, size_bytes,
                                         sha256, uploaded_by, request_id)
  values (v_version_id, v_ev.id, v_version_no, v_key, v_file, p_content_type, p_size_bytes, p_sha256, v_actor,
          nullif(current_setting('cdf.request_id', true), '')::uuid);

  insert into evidence.custody_event (evidence_id, version_id, event_type, actor_id, request_id, details)
  values (v_ev.id, v_version_id, 'RECEIVED', v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid,
          jsonb_build_object('version_no', v_version_no, 'sha256', p_sha256, 'size_bytes', p_size_bytes, 'content_type', p_content_type));

  perform audit.record_event('EVIDENCE_RECEIVED', 'BUSINESS', 'SUCCESS', p_case_id, 'evidence_version', v_version_id::text, null,
    jsonb_build_object('evidence_id', v_ev.id, 'sequence_no', v_ev.sequence_no, 'version_no', v_version_no, 'sha256', p_sha256,
                       'size_bytes', p_size_bytes, 'content_type', p_content_type, 'new_item', p_evidence_id is null));

  return query select v_ev.id, v_version_id, v_version_no, v_key;
end;
$$;

-- Only the uploader, only while quarantined, only with a clean scan.
create function api.complete_evidence_version(p_version_id uuid, p_scan_status text, p_scanner text)
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
  update evidence.evidence
     set status = 'AVAILABLE', current_version_id = p_version_id, updated_at = now()
   where id = v_ver.evidence_id;

  insert into evidence.custody_event (evidence_id, version_id, event_type, actor_id, request_id, details)
  values (v_ver.evidence_id, p_version_id, 'STORED', v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid,
          jsonb_build_object('version_no', v_ver.version_no, 'scan_status', 'CLEAN', 'scanner', left(p_scanner, 80)));

  perform audit.record_event('EVIDENCE_STORED', 'BUSINESS', 'SUCCESS', v_case_id, 'evidence_version', p_version_id::text, null,
    jsonb_build_object('evidence_id', v_ver.evidence_id, 'version_no', v_ver.version_no, 'sha256', v_ver.sha256,
                       'scanner', left(p_scanner, 80)));
end;
$$;

create function api.reject_evidence_version(
  p_version_id uuid, p_reason_code text, p_scan_status text default null, p_scanner text default null
)
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
  if p_reason_code is null or p_reason_code not in ('MALWARE_DETECTED', 'SCAN_UNAVAILABLE', 'STORAGE_FAILURE') then
    perform api._fail('INVALID', 'reason_code');
  end if;
  if p_scan_status is not null and p_scan_status not in ('INFECTED', 'UNSCANNED') then perform api._fail('INVALID', 'scan_status'); end if;
  select e.case_id into v_case_id from evidence.evidence e where e.id = v_ver.evidence_id;

  update evidence.evidence_version
     set status = 'REJECTED', rejection_code = p_reason_code,
         scan_status = coalesce(p_scan_status, scan_status), scanner = coalesce(left(p_scanner, 80), scanner)
   where id = p_version_id;
  update evidence.evidence e
     set status = case when exists (select 1 from evidence.evidence_version v where v.evidence_id = e.id and v.status = 'AVAILABLE')
                       then 'AVAILABLE' else 'REJECTED' end,
         updated_at = now()
   where e.id = v_ver.evidence_id;

  insert into evidence.custody_event (evidence_id, version_id, event_type, actor_id, request_id, details)
  values (v_ver.evidence_id, p_version_id, 'REJECTED', v_actor, nullif(current_setting('cdf.request_id', true), '')::uuid,
          jsonb_build_object('version_no', v_ver.version_no, 'reason_code', p_reason_code, 'scan_status', p_scan_status));

  perform audit.record_event('EVIDENCE_REJECTED', 'BUSINESS', 'FAILURE', v_case_id, 'evidence_version', p_version_id::text, null,
    jsonb_build_object('evidence_id', v_ver.evidence_id, 'version_no', v_ver.version_no, 'reason_code', p_reason_code,
                       'scan_status', p_scan_status));
  if p_reason_code = 'MALWARE_DETECTED' then
    perform audit.record_event('MALWARE_DETECTED', 'SECURITY', 'FAILURE', v_case_id, 'evidence_version', p_version_id::text, null,
      jsonb_build_object('evidence_id', v_ver.evidence_id, 'sha256', v_ver.sha256, 'content_type', v_ver.content_type,
                         'scanner', coalesce(left(p_scanner, 80), v_ver.scanner)));
  end if;
end;
$$;

-- Download gate: returns the storage facts for an available version the caller may download, records
-- custody and audit; otherwise records a SECURITY denial and returns nothing (missing and invisible are alike).
create function api.open_evidence_version(p_version_id uuid)
returns table (o_object_key text, o_file_name text, o_content_type text, o_size_bytes bigint, o_sha256 text,
               o_evidence_id uuid, o_case_id uuid)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_ver evidence.evidence_version;
  v_case_id uuid;
begin
  select * into v_ver from evidence.evidence_version v where v.id = p_version_id;
  if v_ver.id is not null then
    select e.case_id into v_case_id from evidence.evidence e where e.id = v_ver.evidence_id;
  end if;
  if v_ver.id is not null and v_ver.status = 'AVAILABLE' and authz.can_download_evidence(v_ver.evidence_id) then
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
                       'case_visible', case when v_case_id is null then null else authz.can_view_case(v_case_id) end));
  return;
end;
$$;

grant execute on function
  api.register_evidence_version(uuid, uuid, text, text, text, text, date, core.classification_level, text, text, bigint, text),
  api.complete_evidence_version(uuid, text, text),
  api.reject_evidence_version(uuid, text, text, text),
  api.open_evidence_version(uuid)
to authenticated;
