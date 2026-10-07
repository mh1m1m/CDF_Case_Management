-- =============================================================================
-- 0800 Public whistleblowing portal commands (anon) and the boundary rate limiter
-- Requirements: §22, §23, §30, §82; ADR-003, ADR-004; threats T01–T05, T21
--
-- The portal server (login role cdf_portal → anon) is the only caller. The browser never
-- reaches the database. Every function here:
--   * takes the Report ID plus HMAC(pepper, secret) computed by the portal's
--     KeyManagementProvider; the raw secret never reaches the database,
--   * never reveals whether a Report ID exists (mismatch and unknown look identical),
--   * writes audit events with actor_type ANONYMOUS_REPORTER and no identity values,
--   * stores no IP address, user agent or other network metadata (T21).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Fixed-window rate limiter (RateLimiter port, Postgres adapter).
-- PRODUCTION_SUBSTITUTION_REQUIRED: production uses the edge WAF / API gateway limiter.
-- Bucket keys are opaque: the caller hashes any client identifier before passing it.
-- -----------------------------------------------------------------------------
create table core.rate_limit_bucket (
  bucket_key   text not null check (bucket_key ~ '^[a-z_]{2,32}:[0-9a-zA-Z_-]{1,128}$'),
  window_start timestamptz not null,
  hits         int not null default 0 check (hits >= 0),
  primary key (bucket_key, window_start)
);
alter table core.rate_limit_bucket enable row level security;
comment on table core.rate_limit_bucket is 'Rate-limit counters. Keys are hashed client identifiers, never raw IPs (T21). No grants; access via core.consume_rate_limit only.';

create function core.consume_rate_limit(p_bucket text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_hits   int;
begin
  if p_limit not between 1 and 10000 or p_window_seconds not between 1 and 86400 then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:rate_limit';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into core.rate_limit_bucket as b (bucket_key, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket_key, window_start) do update set hits = b.hits + 1
  returning b.hits into v_hits;

  -- Opportunistic cleanup of stale windows for this key.
  delete from core.rate_limit_bucket b
  where b.bucket_key = p_bucket and b.window_start < now() - interval '1 day';

  return v_hits <= p_limit;
end;
$$;

-- Read-only check used to enforce a per-report lockout without consuming budget.
create function core.rate_limit_exceeded(p_bucket text, p_limit int, p_window_seconds int)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select b.hits > p_limit from core.rate_limit_bucket b
    where b.bucket_key = p_bucket
      and b.window_start = to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds)
  ), false);
$$;

create function public_api.consume_rate_limit(p_bucket text, p_limit int, p_window_seconds int)
returns boolean
language sql security definer
set search_path = ''
as $$
  select core.consume_rate_limit(p_bucket, p_limit, p_window_seconds);
$$;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
-- Failed credential attempts per Report ID: 10 per 15 minutes, then the report is locked
-- for the rest of the window even with the right secret (online guessing, T02).
create function public_api._report_locked(p_report_ref text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select core.rate_limit_exceeded('report_fail:' || encode(sha256(convert_to(p_report_ref, 'UTF8')), 'hex'), 10, 900);
$$;

-- Returns the report id when the credentials match and the report is not locked; else null.
-- A failed attempt is counted and recorded as a SECURITY event; the response never differs.
create function public_api._authenticate_report(p_report_ref text, p_secret_hmac text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id   uuid;
  v_ref  text := upper(btrim(coalesce(p_report_ref, '')));
  v_hmac text := lower(btrim(coalesce(p_secret_hmac, '')));
begin
  if v_ref !~ '^WB-[0-9A-HJKMNP-TV-Z]{12}$' or v_hmac !~ '^[0-9a-f]{64}$' then
    perform audit.record_event('REPORT_ACCESS_FAILED', 'SECURITY', 'DENIED', null, 'report', null, null,
      jsonb_build_object('reason', 'MALFORMED'), 'ANONYMOUS_REPORTER');
    return null;
  end if;

  if public_api._report_locked(v_ref) then
    perform audit.record_event('REPORT_ACCESS_LOCKED', 'SECURITY', 'DENIED', null, 'report', v_ref, null,
      '{}'::jsonb, 'ANONYMOUS_REPORTER');
    return null;
  end if;

  select r.id into v_id from intake.report r where r.report_ref = v_ref and r.secret_hmac = v_hmac;

  if v_id is null then
    perform core.consume_rate_limit('report_fail:' || encode(sha256(convert_to(v_ref, 'UTF8')), 'hex'), 10, 900);
    perform audit.record_event('REPORT_ACCESS_FAILED', 'SECURITY', 'DENIED', null, 'report', v_ref, null,
      jsonb_build_object('reason', 'CREDENTIAL_MISMATCH'), 'ANONYMOUS_REPORTER');
  end if;
  return v_id;
end;
$$;

-- Coarse public status (§23): the reporter never sees internal workflow state.
create function public_api._public_status(p_report_id uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select case
    when r.status = 'INFO_REQUESTED' then 'INFORMATION_REQUESTED'
    when r.status in ('REFERRED_OUT', 'CLOSED_NO_ACTION', 'DUPLICATE') then 'CLOSED'
    when r.status = 'RECEIVED' then 'RECEIVED'
    when c.records_state in ('CLOSED', 'ARCHIVED') then 'CLOSED'
    else 'IN_PROGRESS'
  end
  from intake.report r
  left join case_mgmt.case_record c on c.id = r.case_id
  where r.id = p_report_id;
$$;

-- -----------------------------------------------------------------------------
-- Submit a report (WB-FRM-001 core fields)
-- p_identity: null for anonymous; for identified reporters an object with any of
--   full_name, email, phone, preferred_contact. Identity goes only to the vault.
-- -----------------------------------------------------------------------------
create function public_api.submit_report(
  p_report_ref          text,
  p_secret_hmac         text,
  p_category            text,
  p_subject_description text,
  p_description         text,
  p_incident_date       date,
  p_location            text,
  p_language            text,
  p_identity            jsonb default null
)
returns table (report_ref text, received_at timestamptz)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_report intake.report;
  v_mode   text := case when p_identity is null or p_identity = '{}'::jsonb or jsonb_typeof(p_identity) = 'null'
                        then 'ANONYMOUS' else 'IDENTIFIED' end;
  v_name   text;
  v_email  text;
  v_phone  text;
  v_pref   text;
begin
  if upper(coalesce(p_report_ref, '')) !~ '^WB-[0-9A-HJKMNP-TV-Z]{12}$' then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:report_ref';
  end if;
  if lower(coalesce(p_secret_hmac, '')) !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:secret';
  end if;
  if p_category is null or p_category not in ('FINANCIAL_MISCONDUCT', 'FRAUD', 'CONFLICT_OF_INTEREST', 'PROCUREMENT',
      'BEHAVIOURAL_MISCONDUCT', 'ADMINISTRATIVE_VIOLATION', 'PRIVACY_DATA', 'CYBERSECURITY', 'OTHER') then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:category';
  end if;
  if length(btrim(coalesce(p_description, ''))) not between 20 and 8000 then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:description';
  end if;
  if length(coalesce(p_subject_description, '')) > 500 then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:subject_description';
  end if;
  if length(coalesce(p_location, '')) > 200 then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:location';
  end if;
  if p_incident_date is not null and p_incident_date > current_date then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:incident_date';
  end if;
  if coalesce(p_language, 'ar') not in ('ar', 'en') then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:language';
  end if;

  if v_mode = 'IDENTIFIED' then
    if jsonb_typeof(p_identity) <> 'object' then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:identity';
    end if;
    v_name  := nullif(btrim(p_identity ->> 'full_name'), '');
    v_email := nullif(lower(btrim(p_identity ->> 'email')), '');
    v_phone := nullif(btrim(p_identity ->> 'phone'), '');
    v_pref  := coalesce(nullif(p_identity ->> 'preferred_contact', ''), 'PORTAL_ONLY');
    if coalesce(v_name, v_email, v_phone) is null then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:identity';
    end if;
    if length(coalesce(v_name, '')) > 200 then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:full_name';
    end if;
    if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:email';
    end if;
    if v_phone is not null and v_phone !~ '^\+?[0-9 ()-]{6,40}$' then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:phone';
    end if;
    if v_pref not in ('EMAIL', 'PHONE', 'PORTAL_ONLY') then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:preferred_contact';
    end if;
  end if;

  begin
    insert into intake.report (report_ref, secret_hmac, reporter_mode, category, subject_description, description,
                               incident_date, location, language)
    values (upper(p_report_ref), lower(p_secret_hmac), v_mode, p_category, nullif(btrim(p_subject_description), ''),
            btrim(p_description), p_incident_date, nullif(btrim(p_location), ''), coalesce(p_language, 'ar'))
    returning * into v_report;
  exception when unique_violation then
    -- Random 60-bit reference collided; the portal regenerates and retries. Reveals nothing about the other report.
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CDF_CONFLICT:REF_COLLISION';
  end;

  if v_mode = 'IDENTIFIED' then
    insert into protected_identity.reporter_identity (wb_id, full_name, email, phone, preferred_contact)
    values (v_report.wb_id, v_name, v_email, v_phone, v_pref);
  end if;

  -- No identity values, no description in the audit trail (§83).
  perform audit.record_event('REPORT_SUBMITTED', 'BUSINESS', 'SUCCESS', null, 'report', v_report.id::text, null,
    jsonb_build_object('report_ref', v_report.report_ref, 'reporter_mode', v_mode, 'category', v_report.category,
                       'language', v_report.language),
    'ANONYMOUS_REPORTER');

  report_ref := v_report.report_ref;
  received_at := v_report.received_at;
  return next;
end;
$$;

-- -----------------------------------------------------------------------------
-- Status and two-way messages. Returns null on any credential failure.
-- -----------------------------------------------------------------------------
create function public_api.get_report_status(p_report_ref text, p_secret_hmac text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id     uuid := public_api._authenticate_report(p_report_ref, p_secret_hmac);
  v_result jsonb;
begin
  if v_id is null then
    return null;
  end if;

  select jsonb_build_object(
    'report_ref', r.report_ref,
    'status', public_api._public_status(r.id),
    'received_at', r.received_at,
    'status_changed_at', r.status_changed_at,
    'can_reply', public_api._public_status(r.id) <> 'CLOSED',
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('direction', m.direction, 'body', m.body, 'created_at', m.created_at)
                       order by m.created_at)
      from intake.report_message m where m.report_id = r.id
    ), '[]'::jsonb)
  ) into v_result
  from intake.report r where r.id = v_id;

  perform audit.record_event('REPORT_STATUS_VIEWED', 'BUSINESS', 'SUCCESS', null, 'report', v_id::text, null,
    '{}'::jsonb, 'ANONYMOUS_REPORTER');
  return v_result;
end;
$$;

create function public_api.post_reporter_message(p_report_ref text, p_secret_hmac text, p_body text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id   uuid := public_api._authenticate_report(p_report_ref, p_secret_hmac);
  v_body text := btrim(coalesce(p_body, ''));
  v_msg  uuid;
begin
  if v_id is null then
    return false;
  end if;
  if length(v_body) not between 1 and 4000 then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:body';
  end if;
  if public_api._public_status(v_id) = 'CLOSED' then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CDF_CONFLICT:REPORT_CLOSED';
  end if;

  insert into intake.report_message (report_id, direction, body)
  values (v_id, 'FROM_REPORTER', v_body)
  returning id into v_msg;

  -- Answering an information request returns the report to the triage queue.
  update intake.report r
     set status = 'RECEIVED', status_changed_at = now()
   where r.id = v_id and r.status = 'INFO_REQUESTED';

  perform audit.record_event('REPORTER_MESSAGE_RECEIVED', 'BUSINESS', 'SUCCESS',
    (select r.case_id from intake.report r where r.id = v_id), 'report_message', v_msg::text, null,
    jsonb_build_object('report_id', v_id), 'ANONYMOUS_REPORTER');
  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants: the portal may call exactly these four functions and nothing else.
-- -----------------------------------------------------------------------------
grant execute on function
  public_api.consume_rate_limit(text, int, int),
  public_api.submit_report(text, text, text, text, text, date, text, text, jsonb),
  public_api.get_report_status(text, text),
  public_api.post_reporter_message(text, text, text)
to anon;

-- The investigation BFF rate-limits sign-in attempts before it has a user context.
grant usage on schema public_api to authenticated;
grant execute on function public_api.consume_rate_limit(text, int, int) to authenticated;
