-- =============================================================================
-- 1600 Reporter attachments on the public portal (CDF-72; ADR-015)
-- Requirements: Drive whistleblowing requirements report field 19; §22–§27, §29, §40, §83, §87;
--               ADR-004, ADR-006; threats T02, T05, T10, T21
--
-- A reporter adds supporting files to a report with the Report ID + secret. Files are report-scoped
-- (most reports have no case), use the evidence allow-list and private buckets, and are never served
-- before a clean malware scan. The original file name is never stored (it may carry identity);
-- investigators see a generated name (ATT-001.pdf).
--
-- Upload protocol (portal server, one file per request, every step audited in its own transaction):
--   1. public_api.register_report_attachment  → QUARANTINED, audit REPORT_ATTACHMENT_RECEIVED
--   2. storage putQuarantine + scan            (outside the database)
--   3. public_api.complete_report_attachment  → AVAILABLE, audit REPORT_ATTACHMENT_STORED
--      or public_api.reject_report_attachment → REJECTED,  audit REPORT_ATTACHMENT_REJECTED (+ MALWARE_DETECTED)
--   4. api.open_report_attachment             → audit REPORT_ATTACHMENT_DOWNLOADED, or a SECURITY denial
-- Nothing deletes or overwrites an attachment: triggers reject it for every role, the owner included.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
create table intake.report_attachment (
  id             uuid primary key default gen_random_uuid(),
  report_id      uuid not null references intake.report (id),
  -- Display number within the report (ATT-001). UUIDs are the keys (§87).
  sequence_no    int not null check (sequence_no between 1 and 1000),
  source         text not null check (source in ('REPORT', 'FOLLOW_UP')),
  -- Random, immutable, never user-controlled (T05). Not readable by application roles.
  object_key     text not null unique
                 check (object_key ~ '^reports/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/attachments/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
  file_extension text not null check (file_extension ~ '^[a-z0-9]{1,10}$'),
  content_type   text not null references evidence.allowed_content_type (content_type),
  size_bytes     bigint not null check (size_bytes between 1 and 4194304),  -- 4 MiB per file (ADR-015)
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status         text not null default 'QUARANTINED' check (status in ('QUARANTINED', 'AVAILABLE', 'REJECTED')),
  scan_status    text not null default 'PENDING' check (scan_status in ('PENDING', 'CLEAN', 'INFECTED', 'UNSCANNED')),
  scanner        text check (length(scanner) <= 80),
  rejection_code text check (rejection_code in ('MALWARE_DETECTED', 'SCAN_UNAVAILABLE', 'STORAGE_FAILURE')),
  received_at    timestamptz not null default now(),
  stored_at      timestamptz,
  request_id     uuid,
  unique (report_id, sequence_no),
  check ((status = 'AVAILABLE') = (stored_at is not null)),
  check ((status = 'REJECTED') = (rejection_code is not null)),
  check (status <> 'AVAILABLE' or scan_status = 'CLEAN')
);
-- The same content is attached at most once per report; a rejected attempt may be retried.
create unique index report_attachment_live_content on intake.report_attachment (report_id, sha256) where status <> 'REJECTED';
create index report_attachment_content_type on intake.report_attachment (content_type);
comment on table intake.report_attachment is
  'Reporter attachments (ADR-015). No original file name, no identity, no network metadata. Content lives in private storage.';
comment on column intake.report_attachment.object_key is
  'Storage key reports/{report}/attachments/{attachment}. Only api.open_report_attachment reveals it, to server code.';

-- -----------------------------------------------------------------------------
-- Immutability (§26, §27): no overwrite, no delete, for the owner too.
-- -----------------------------------------------------------------------------
create function intake.reject_attachment_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'intake.report_attachment cannot be deleted (% rejected)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger report_attachment_no_delete before delete on intake.report_attachment
  for each row execute function intake.reject_attachment_mutation();
create trigger report_attachment_no_truncate before truncate on intake.report_attachment
  for each statement execute function intake.reject_attachment_mutation();

-- A row may change only while QUARANTINED, and only its outcome columns.
create function intake.protect_attachment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'QUARANTINED' then
    raise exception 'report attachment % is immutable once %', old.id, old.status using errcode = 'insufficient_privilege';
  end if;
  if new.id <> old.id or new.report_id <> old.report_id or new.sequence_no <> old.sequence_no
     or new.source <> old.source or new.object_key <> old.object_key or new.file_extension <> old.file_extension
     or new.content_type <> old.content_type or new.size_bytes <> old.size_bytes or new.sha256 <> old.sha256
     or new.received_at <> old.received_at or new.request_id is distinct from old.request_id then
    raise exception 'report attachment % content fields are immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger report_attachment_protect before update on intake.report_attachment
  for each row execute function intake.protect_attachment();

-- -----------------------------------------------------------------------------
-- RLS (SELECT only). Visibility is the report's: intake rules before a case, authz.can_view_case after.
-- object_key and request_id are never readable by application roles.
-- -----------------------------------------------------------------------------
alter table intake.report_attachment enable row level security;
create policy report_attachment_read on intake.report_attachment for select to authenticated
  using (authz.can_view_report(report_id));
grant select (id, report_id, sequence_no, source, file_extension, content_type, size_bytes, sha256, status,
              scan_status, rejection_code, received_at, stored_at)
  on intake.report_attachment to authenticated;

-- Download needs the scan gate (AVAILABLE) plus report visibility plus a download right: evidence download
-- once a case exists, intake viewing while the report is still in intake. Internal: not granted to any role.
create function authz.can_download_report_attachment(p_attachment_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from intake.report_attachment a
    join intake.report r on r.id = a.report_id
    where a.id = p_attachment_id
      and a.status = 'AVAILABLE'
      and authz.can_view_report(r.id)
      and case when r.case_id is null then authz.has_permission('INTAKE_VIEW')
               else authz.has_permission('EVIDENCE_DOWNLOAD') end
  );
$$;
revoke execute on function authz.can_download_report_attachment(uuid) from public;

-- -----------------------------------------------------------------------------
-- Weighted rate limiting (bytes per client). Same buckets table and window logic as consume_rate_limit.
-- PRODUCTION_SUBSTITUTION_REQUIRED: the edge WAF / API gateway limits request bytes in production.
-- -----------------------------------------------------------------------------
create function core.consume_rate_limit_amount(p_bucket text, p_amount int, p_limit int, p_window_seconds int)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_hits   int;
begin
  if p_amount not between 1 and 1048576 or p_limit not between 1 and 104857600 or p_window_seconds not between 1 and 86400 then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:rate_limit';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into core.rate_limit_bucket as b (bucket_key, window_start, hits)
  values (p_bucket, v_window, p_amount)
  on conflict (bucket_key, window_start) do update set hits = b.hits + p_amount
  returning b.hits into v_hits;

  delete from core.rate_limit_bucket b
  where b.bucket_key = p_bucket and b.window_start < now() - interval '1 day';

  return v_hits <= p_limit;
end;
$$;

-- Only the portal's byte bucket: a byte budget on any other bucket (for example a report's failed-access
-- counter) would let one call lock a known Report ID (CDF-62 review, LOW 1).
create function public_api.consume_rate_limit_amount(p_bucket text, p_amount int, p_limit int, p_window_seconds int)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_bucket is null or p_bucket !~ '^portal_attachment_kib:[A-Za-z0-9_-]{1,128}$' then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:rate_limit_bucket';
  end if;
  return core.consume_rate_limit_amount(p_bucket, p_amount, p_limit, p_window_seconds);
end;
$$;

-- -----------------------------------------------------------------------------
-- Portal commands (anon). Credential failures return nothing / false, exactly like a missing Report ID.
-- -----------------------------------------------------------------------------
create function public_api.register_report_attachment(
  p_report_ref     text,
  p_secret_hmac    text,
  p_source         text,
  p_file_extension text,
  p_content_type   text,
  p_size_bytes     bigint,
  p_sha256         text
)
returns table (attachment_id uuid, object_key text, display_name text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_report_id uuid := public_api._authenticate_report(p_report_ref, p_secret_hmac);
  v_report    intake.report;
  v_ext       text := lower(btrim(coalesce(p_file_extension, '')));
  v_sha       text := lower(btrim(coalesce(p_sha256, '')));
  v_count     int;
  v_bytes     bigint;
  v_seq       int;
  v_id        uuid;
  v_key       text;
begin
  if v_report_id is null then
    return;  -- wrong secret, unknown Report ID, malformed or locked: indistinguishable (§23)
  end if;
  if p_source is null or p_source not in ('REPORT', 'FOLLOW_UP') then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:source';
  end if;
  if not exists (select 1 from evidence.allowed_content_type t
                 where t.content_type = p_content_type and v_ext = any (t.extensions)) then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:content_type';
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 4194304 then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:size_bytes';
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:sha256';
  end if;
  if public_api._public_status(v_report_id) = 'CLOSED' then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CDF_CONFLICT:REPORT_CLOSED';
  end if;

  -- Locking the report serialises numbering and the per-report limits.
  select * into v_report from intake.report r where r.id = v_report_id for update;
  select count(*), coalesce(sum(a.size_bytes), 0) into v_count, v_bytes
  from intake.report_attachment a where a.report_id = v_report_id and a.status <> 'REJECTED';
  if v_count >= 10 or v_bytes + p_size_bytes > 20971520 then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CDF_CONFLICT:ATTACHMENT_LIMIT';
  end if;
  if exists (select 1 from intake.report_attachment a
             where a.report_id = v_report_id and a.sha256 = v_sha and a.status <> 'REJECTED') then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CDF_CONFLICT:DUPLICATE_ATTACHMENT';
  end if;
  select coalesce(max(a.sequence_no), 0) + 1 into v_seq from intake.report_attachment a where a.report_id = v_report_id;

  v_id := gen_random_uuid();
  v_key := 'reports/' || v_report_id::text || '/attachments/' || v_id::text;
  insert into intake.report_attachment (id, report_id, sequence_no, source, object_key, file_extension, content_type,
                                        size_bytes, sha256, request_id)
  values (v_id, v_report_id, v_seq, p_source, v_key, v_ext, p_content_type, p_size_bytes, v_sha,
          nullif(current_setting('cdf.request_id', true), '')::uuid);

  -- Technical facts only; never a file name or content (§83).
  perform audit.record_event('REPORT_ATTACHMENT_RECEIVED', 'BUSINESS', 'SUCCESS', v_report.case_id, 'report_attachment',
    v_id::text, null,
    jsonb_build_object('report_id', v_report_id, 'sequence_no', v_seq, 'source', p_source, 'content_type', p_content_type,
                       'size_bytes', p_size_bytes, 'sha256', v_sha),
    'ANONYMOUS_REPORTER');

  attachment_id := v_id;
  object_key := v_key;
  display_name := 'ATT-' || lpad(v_seq::text, 3, '0') || '.' || v_ext;
  return next;
end;
$$;

create function public_api.complete_report_attachment(
  p_report_ref text, p_secret_hmac text, p_attachment_id uuid, p_scan_status text, p_scanner text
)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_report_id uuid := public_api._authenticate_report(p_report_ref, p_secret_hmac);
  v_att       intake.report_attachment;
  v_case_id   uuid;
begin
  if v_report_id is null then
    return false;
  end if;
  select * into v_att from intake.report_attachment a
  where a.id = p_attachment_id and a.report_id = v_report_id for update;
  if v_att.id is null then
    return false;  -- another report's attachment and a missing one look the same
  end if;
  if v_att.status <> 'QUARANTINED' then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CDF_CONFLICT:ATTACHMENT_NOT_QUARANTINED';
  end if;
  if p_scan_status is distinct from 'CLEAN' then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:scan_status';
  end if;
  select r.case_id into v_case_id from intake.report r where r.id = v_report_id;

  update intake.report_attachment
     set status = 'AVAILABLE', scan_status = 'CLEAN', scanner = left(p_scanner, 80), stored_at = now()
   where id = v_att.id;

  perform audit.record_event('REPORT_ATTACHMENT_STORED', 'BUSINESS', 'SUCCESS', v_case_id, 'report_attachment',
    v_att.id::text, null,
    jsonb_build_object('report_id', v_report_id, 'sequence_no', v_att.sequence_no, 'sha256', v_att.sha256,
                       'scanner', left(p_scanner, 80)),
    'ANONYMOUS_REPORTER');
  return true;
end;
$$;

create function public_api.reject_report_attachment(
  p_report_ref text, p_secret_hmac text, p_attachment_id uuid, p_reason_code text,
  p_scan_status text default null, p_scanner text default null
)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_report_id uuid := public_api._authenticate_report(p_report_ref, p_secret_hmac);
  v_att       intake.report_attachment;
  v_case_id   uuid;
begin
  if v_report_id is null then
    return false;
  end if;
  select * into v_att from intake.report_attachment a
  where a.id = p_attachment_id and a.report_id = v_report_id for update;
  if v_att.id is null then
    return false;
  end if;
  if v_att.status <> 'QUARANTINED' then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CDF_CONFLICT:ATTACHMENT_NOT_QUARANTINED';
  end if;
  if p_reason_code is null or p_reason_code not in ('MALWARE_DETECTED', 'SCAN_UNAVAILABLE', 'STORAGE_FAILURE') then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:reason_code';
  end if;
  if p_scan_status is not null and p_scan_status not in ('INFECTED', 'UNSCANNED') then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:scan_status';
  end if;
  select r.case_id into v_case_id from intake.report r where r.id = v_report_id;

  update intake.report_attachment
     set status = 'REJECTED', rejection_code = p_reason_code,
         scan_status = coalesce(p_scan_status, scan_status), scanner = coalesce(left(p_scanner, 80), scanner)
   where id = v_att.id;

  perform audit.record_event('REPORT_ATTACHMENT_REJECTED', 'BUSINESS', 'FAILURE', v_case_id, 'report_attachment',
    v_att.id::text, null,
    jsonb_build_object('report_id', v_report_id, 'sequence_no', v_att.sequence_no, 'reason_code', p_reason_code,
                       'scan_status', p_scan_status),
    'ANONYMOUS_REPORTER');
  if p_reason_code = 'MALWARE_DETECTED' then
    perform audit.record_event('MALWARE_DETECTED', 'SECURITY', 'FAILURE', v_case_id, 'report_attachment', v_att.id::text,
      null,
      jsonb_build_object('report_id', v_report_id, 'sha256', v_att.sha256, 'content_type', v_att.content_type,
                         'scanner', coalesce(left(p_scanner, 80), v_att.scanner)),
      'ANONYMOUS_REPORTER');
  end if;
  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- Download gate (authenticated). Returns storage facts for an attachment the caller may download and
-- records the download; otherwise a SECURITY denial and nothing (missing, hidden, quarantined are alike).
-- -----------------------------------------------------------------------------
create function api.open_report_attachment(p_attachment_id uuid)
returns table (o_object_key text, o_display_name text, o_content_type text, o_size_bytes bigint, o_sha256 text,
               o_report_id uuid)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor   uuid := api._actor();  -- raises for an unauthenticated caller
  v_att     intake.report_attachment;
  v_case_id uuid;
begin
  select * into v_att from intake.report_attachment a where a.id = p_attachment_id;
  if v_att.id is not null and authz.can_download_report_attachment(v_att.id) then
    select r.case_id into v_case_id from intake.report r where r.id = v_att.report_id;
    perform audit.record_event('REPORT_ATTACHMENT_DOWNLOADED', 'BUSINESS', 'SUCCESS', v_case_id, 'report_attachment',
      v_att.id::text, null,
      jsonb_build_object('report_id', v_att.report_id, 'sequence_no', v_att.sequence_no, 'sha256', v_att.sha256));
    return query select v_att.object_key, 'ATT-' || lpad(v_att.sequence_no::text, 3, '0') || '.' || v_att.file_extension,
                        v_att.content_type, v_att.size_bytes, v_att.sha256, v_att.report_id;
    return;
  end if;
  perform audit.record_event('REPORT_ATTACHMENT_ACCESS_DENIED', 'SECURITY', 'DENIED', null, 'report_attachment',
    p_attachment_id::text, null,
    jsonb_build_object('target_exists', v_att.id is not null, 'attachment_status', v_att.status,
                       'report_visible', case when v_att.id is null then null else authz.can_view_report(v_att.report_id) end));
  return;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
grant execute on function
  public_api.consume_rate_limit_amount(text, int, int, int),
  public_api.register_report_attachment(text, text, text, text, text, bigint, text),
  public_api.complete_report_attachment(text, text, uuid, text, text),
  public_api.reject_report_attachment(text, text, uuid, text, text, text)
to anon;
grant execute on function api.open_report_attachment(uuid) to authenticated;
