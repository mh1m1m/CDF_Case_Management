-- =============================================================================
-- 1500 Portal intake alignment with the Drive whistleblowing requirements report (CDF-63)
-- Source: Drive «تقرير متطلبات خدمة الإبلاغ عن المخالفات» (19 Jan 2025), 21-field table.
-- Requirements: §22, §23; ADR-003, ADR-004; threats T01–T05, T21
--
--   * three reporting modes: ANONYMOUS, EMAIL_ONLY, IDENTIFIED (field 3)
--   * relationship to the Fund + conditional text (fields 1, 2)
--   * the Drive violation-type list replaces the earlier category list (fields 13, 14)
--   * incident date AND time, location and persons reported become mandatory (fields 16–18)
--   * willingness to cooperate (field 20)
--   * identified-mode identity fields (fields 4–12) go ONLY to protected_identity.reporter_identity
--
-- Field 19 (reporter attachments) is not in this migration: evidence is case-bound (0900), so
-- portal uploads need their own intake attachment design (CDF-72).
-- The vault keeps no grants and no policies; this migration adds columns and widens the output of
-- api.resolve_reporter_identity() only. Security review: AGENT-09 (CDF-62 thread).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- intake.report: report content columns (never identity)
-- -----------------------------------------------------------------------------
alter table intake.report drop constraint report_reporter_mode_check;
alter table intake.report add constraint report_reporter_mode_check
  check (reporter_mode in ('ANONYMOUS', 'EMAIL_ONLY', 'IDENTIFIED'));

-- Earlier synthetic rows are mapped onto the Drive list; the mapping is lossy by design and
-- only ever touches synthetic data (§2).
alter table intake.report drop constraint report_category_check;
update intake.report set category = case category
    when 'FINANCIAL_MISCONDUCT'     then 'FINANCIAL_CORRUPTION'
    when 'FRAUD'                    then 'FINANCIAL_CORRUPTION'
    when 'CONFLICT_OF_INTEREST'     then 'ABUSE_OF_AUTHORITY'
    when 'PROCUREMENT'              then 'IRREGULAR_TRANSACTIONS'
    when 'BEHAVIOURAL_MISCONDUCT'   then 'POLICY_BREACH'
    when 'ADMINISTRATIVE_VIOLATION' then 'ADMINISTRATIVE_CORRUPTION'
    when 'PRIVACY_DATA'             then 'POLICY_BREACH'
    when 'CYBERSECURITY'            then 'POLICY_BREACH'
    else category
  end;
alter table intake.report add constraint report_category_check check (category in (
  'FINANCIAL_CORRUPTION', 'ADMINISTRATIVE_CORRUPTION', 'POLICY_BREACH', 'EHS_BREACH', 'ABUSE_OF_AUTHORITY',
  'IRREGULAR_TRANSACTIONS', 'PUBLIC_ORDER_VIOLATION', 'CONCEALMENT', 'OTHER'));

-- Nullable at table level for rows received before this migration; public_api.submit_report
-- requires them for every new report.
alter table intake.report
  add column relationship_to_fund text check (relationship_to_fund in (
    'BENEFICIARY', 'APPLICANT', 'SUPPLIER', 'CONTRACTOR', 'THIRD_PARTY', 'EMPLOYEE', 'OTHER')),
  add column relationship_other   text check (length(relationship_other) <= 500),
  add column category_other       text check (length(category_other) <= 1000),
  add column incident_time        time,
  add column willing_to_cooperate boolean,
  add constraint report_relationship_other_only_for_other
    check (relationship_other is null or relationship_to_fund = 'OTHER'),
  add constraint report_category_other_only_for_other
    check (category_other is null or category = 'OTHER');

comment on column intake.report.relationship_to_fund is 'Drive field 1. Report content, not identity.';
comment on column intake.report.willing_to_cooperate is 'Drive field 20. Does not change confidentiality.';

-- Same column-level read grant as 0500 for the new non-identity columns (secret_hmac stays unreadable).
grant select (relationship_to_fund, relationship_other, category_other, incident_time, willing_to_cooperate)
  on intake.report to authenticated;

-- -----------------------------------------------------------------------------
-- Identity vault: identified-mode fields (Drive fields 4–12). Still no grants, no policies.
-- -----------------------------------------------------------------------------
alter table protected_identity.reporter_identity
  add column given_name          text check (length(given_name) <= 60),
  add column father_name         text check (length(father_name) <= 60),
  add column grandfather_name    text check (length(grandfather_name) <= 60),
  add column family_name         text check (length(family_name) <= 60),
  add column gender              text check (gender in ('MALE', 'FEMALE')),
  -- Stored as entered (YYYY-MM-DD) with its calendar; no Hijri↔Gregorian conversion in the prototype.
  add column birth_date          text check (birth_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  add column birth_date_calendar text check (birth_date_calendar in ('GREGORIAN', 'HIJRI')),
  add column id_type             text check (id_type in ('NATIONAL_ID', 'IQAMA', 'PASSPORT')),
  add column id_number           text check (id_number ~ '^[A-Z0-9]{5,20}$'),
  add column city                text check (city ~ '^[A-Z_]{2,40}$'),
  add column nationality         text check (nationality ~ '^[A-Z]{2}$'),
  add constraint reporter_identity_birth_date_pair check ((birth_date is null) = (birth_date_calendar is null)),
  add constraint reporter_identity_id_pair check ((id_type is null) = (id_number is null));

-- -----------------------------------------------------------------------------
-- public_api.submit_report: new signature. The old one is dropped so no path can submit a
-- report without the mandatory Drive fields.
-- -----------------------------------------------------------------------------
drop function public_api.submit_report(text, text, text, text, text, date, text, text, jsonb);

-- p_identity:
--   ANONYMOUS  → must be null/empty; nothing is stored.
--   EMAIL_ONLY → {email}; only the email (and preferred_contact EMAIL) reaches the vault.
--   IDENTIFIED → {given_name, father_name, grandfather_name, family_name, gender, birth_date,
--                 birth_date_calendar, id_type, id_number, city, nationality, phone, email,
--                 preferred_contact}; all mandatory except preferred_contact.
create function public_api.submit_report(
  p_report_ref           text,
  p_secret_hmac          text,
  p_reporter_mode        text,
  p_relationship         text,
  p_relationship_other   text,
  p_category             text,
  p_category_other       text,
  p_subject_description  text,
  p_description          text,
  p_incident_date        date,
  p_incident_time        time,
  p_location             text,
  p_willing_to_cooperate boolean,
  p_language             text,
  p_identity             jsonb default null
)
returns table (report_ref text, received_at timestamptz)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_report   intake.report;
  v_mode     text := upper(coalesce(p_reporter_mode, ''));
  v_identity jsonb := case when p_identity is null or jsonb_typeof(p_identity) = 'null' then '{}'::jsonb else p_identity end;
  v_rel_other text := nullif(btrim(coalesce(p_relationship_other, '')), '');
  v_cat_other text := nullif(btrim(coalesce(p_category_other, '')), '');
  v_given    text;
  v_father   text;
  v_grand    text;
  v_family   text;
  v_gender   text;
  v_dob      text;
  v_dob_cal  text;
  v_id_type  text;
  v_id_no    text;
  v_city     text;
  v_nat      text;
  v_email    text;
  v_phone    text;
  v_pref     text;
  v_y int; v_m int; v_d int;
begin
  if upper(coalesce(p_report_ref, '')) !~ '^WB-[0-9A-HJKMNP-TV-Z]{12}$' then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:report_ref';
  end if;
  if lower(coalesce(p_secret_hmac, '')) !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:secret';
  end if;
  if v_mode not in ('ANONYMOUS', 'EMAIL_ONLY', 'IDENTIFIED') then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:reporter_mode';
  end if;
  if p_relationship is null or p_relationship not in
      ('BENEFICIARY', 'APPLICANT', 'SUPPLIER', 'CONTRACTOR', 'THIRD_PARTY', 'EMPLOYEE', 'OTHER') then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:relationship';
  end if;
  if p_relationship <> 'OTHER' then v_rel_other := null; end if;
  if length(coalesce(v_rel_other, '')) > 500 then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:relationship_other';
  end if;
  if p_category is null or p_category not in ('FINANCIAL_CORRUPTION', 'ADMINISTRATIVE_CORRUPTION', 'POLICY_BREACH',
      'EHS_BREACH', 'ABUSE_OF_AUTHORITY', 'IRREGULAR_TRANSACTIONS', 'PUBLIC_ORDER_VIOLATION', 'CONCEALMENT', 'OTHER') then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:category';
  end if;
  if p_category <> 'OTHER' then v_cat_other := null; end if;
  if length(coalesce(v_cat_other, '')) > 1000 then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:category_other';
  end if;
  if length(btrim(coalesce(p_description, ''))) not between 20 and 8000 then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:description';
  end if;
  if length(btrim(coalesce(p_subject_description, ''))) not between 2 and 500 then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:subject_description';
  end if;
  if length(btrim(coalesce(p_location, ''))) not between 2 and 200 then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:location';
  end if;
  if p_incident_date is null or p_incident_date > current_date then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:incident_date';
  end if;
  if p_incident_time is null then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:incident_time';
  end if;
  if p_willing_to_cooperate is null then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:willing_to_cooperate';
  end if;
  if coalesce(p_language, 'ar') not in ('ar', 'en') then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:language';
  end if;
  if jsonb_typeof(v_identity) <> 'object' then
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:identity';
  end if;

  if v_mode = 'ANONYMOUS' and v_identity <> '{}'::jsonb then
    -- The portal strips identity for anonymous reports; anything else is a client error, never stored.
    raise exception using errcode = 'check_violation', message = 'CDF_INVALID:identity';
  end if;

  if v_mode in ('EMAIL_ONLY', 'IDENTIFIED') then
    v_email := nullif(lower(btrim(v_identity ->> 'email')), '');
    if v_email is null or length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:email';
    end if;
    v_pref := 'EMAIL';
  end if;

  if v_mode = 'IDENTIFIED' then
    v_given   := nullif(btrim(v_identity ->> 'given_name'), '');
    v_father  := nullif(btrim(v_identity ->> 'father_name'), '');
    v_grand   := nullif(btrim(v_identity ->> 'grandfather_name'), '');
    v_family  := nullif(btrim(v_identity ->> 'family_name'), '');
    v_gender  := v_identity ->> 'gender';
    v_dob     := v_identity ->> 'birth_date';
    v_dob_cal := v_identity ->> 'birth_date_calendar';
    v_id_type := v_identity ->> 'id_type';
    v_id_no   := upper(btrim(coalesce(v_identity ->> 'id_number', '')));
    v_city    := v_identity ->> 'city';
    v_nat     := upper(coalesce(v_identity ->> 'nationality', ''));
    v_phone   := nullif(btrim(v_identity ->> 'phone'), '');
    v_pref    := coalesce(nullif(v_identity ->> 'preferred_contact', ''), 'PORTAL_ONLY');

    if v_given is null or v_father is null or v_grand is null or v_family is null
       or greatest(length(v_given), length(v_father), length(v_grand), length(v_family)) > 60 then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:full_name';
    end if;
    if v_gender is null or v_gender not in ('MALE', 'FEMALE') then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:gender';
    end if;
    if v_dob_cal is null or v_dob_cal not in ('GREGORIAN', 'HIJRI') or coalesce(v_dob, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:birth_date';
    end if;
    v_y := split_part(v_dob, '-', 1)::int; v_m := split_part(v_dob, '-', 2)::int; v_d := split_part(v_dob, '-', 3)::int;
    if v_dob_cal = 'GREGORIAN' then
      if v_y < 1900 or v_m not between 1 and 12 or v_d not between 1 and 31
         or v_d > extract(day from (make_date(v_y, v_m, 1) + interval '1 month - 1 day'))
         or make_date(v_y, v_m, v_d) > current_date then
        raise exception using errcode = 'check_violation', message = 'CDF_INVALID:birth_date';
      end if;
    elsif v_y not between 1318 and 1460 or v_m not between 1 and 12 or v_d not between 1 and 30 then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:birth_date';
    end if;
    if v_id_type is null or v_id_type not in ('NATIONAL_ID', 'IQAMA', 'PASSPORT')
       or (v_id_type = 'NATIONAL_ID' and v_id_no !~ '^1[0-9]{9}$')
       or (v_id_type = 'IQAMA' and v_id_no !~ '^2[0-9]{9}$')
       or (v_id_type = 'PASSPORT' and v_id_no !~ '^[A-Z0-9]{5,20}$') then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:id_number';
    end if;
    if coalesce(v_city, '') !~ '^[A-Z_]{2,40}$' then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:city';
    end if;
    if v_nat !~ '^[A-Z]{2}$' then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:nationality';
    end if;
    if v_phone is null or v_phone !~ '^\+?[0-9 ()-]{6,40}$' then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:phone';
    end if;
    if v_pref not in ('EMAIL', 'PHONE', 'PORTAL_ONLY') then
      raise exception using errcode = 'check_violation', message = 'CDF_INVALID:preferred_contact';
    end if;
  end if;

  begin
    insert into intake.report (report_ref, secret_hmac, reporter_mode, relationship_to_fund, relationship_other,
                               category, category_other, subject_description, description, incident_date,
                               incident_time, location, willing_to_cooperate, language)
    values (upper(p_report_ref), lower(p_secret_hmac), v_mode, p_relationship, v_rel_other,
            p_category, v_cat_other, btrim(p_subject_description), btrim(p_description), p_incident_date,
            p_incident_time, btrim(p_location), p_willing_to_cooperate, coalesce(p_language, 'ar'))
    returning * into v_report;
  exception when unique_violation then
    -- Random 60-bit reference collided; the portal regenerates and retries. Reveals nothing about the other report.
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CDF_CONFLICT:REF_COLLISION';
  end;

  if v_mode = 'EMAIL_ONLY' then
    insert into protected_identity.reporter_identity (wb_id, email, preferred_contact)
    values (v_report.wb_id, v_email, v_pref);
  elsif v_mode = 'IDENTIFIED' then
    insert into protected_identity.reporter_identity (
      wb_id, full_name, given_name, father_name, grandfather_name, family_name, gender, birth_date,
      birth_date_calendar, id_type, id_number, city, nationality, email, phone, preferred_contact)
    values (
      v_report.wb_id, concat_ws(' ', v_given, v_father, v_grand, v_family), v_given, v_father, v_grand, v_family,
      v_gender, v_dob, v_dob_cal, v_id_type, v_id_no, v_city, v_nat, v_email, v_phone, v_pref);
  end if;

  -- No identity values, no description in the audit trail (§83).
  perform audit.record_event('REPORT_SUBMITTED', 'BUSINESS', 'SUCCESS', null, 'report', v_report.id::text, null,
    jsonb_build_object('report_ref', v_report.report_ref, 'reporter_mode', v_mode, 'category', v_report.category,
                       'relationship_to_fund', v_report.relationship_to_fund, 'language', v_report.language),
    'ANONYMOUS_REPORTER');

  report_ref := v_report.report_ref;
  received_at := v_report.received_at;
  return next;
end;
$$;

grant execute on function
  public_api.submit_report(text, text, text, text, text, text, text, text, text, date, time, text, boolean, text, jsonb)
to anon;

-- -----------------------------------------------------------------------------
-- api.resolve_reporter_identity: same checks, dual control and audit as 0700; returns the new
-- vault columns too. The output shape changes, so the function is dropped and recreated.
-- -----------------------------------------------------------------------------
drop function api.resolve_reporter_identity(uuid, text);

create function api.resolve_reporter_identity(p_case_id uuid, p_justification text)
returns table (wb_id text, full_name text, email text, phone text, preferred_contact text,
               given_name text, father_name text, grandfather_name text, family_name text, gender text,
               birth_date text, birth_date_calendar text, id_type text, id_number text, city text, nationality text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_req protected_identity.reveal_request;
  v_just text;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_reveal_whistleblower_identity(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  v_just := api._require_text(p_justification, 'justification', 20, 2000);
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id;
  if v_case.reporter_wb_id is null
     or not exists (select 1 from protected_identity.reporter_identity i where i.wb_id = v_case.reporter_wb_id) then
    perform api._fail('CONFLICT', 'NO_IDENTITY_ON_FILE');
  end if;
  if v_case.identity_reveal_requires_approval then
    select * into v_req from protected_identity.reveal_request r
     where r.case_id = p_case_id and r.requested_by = v_actor and r.status = 'APPROVED' and r.expires_at > now()
     order by r.decided_at desc limit 1 for update;
    if v_req.id is null then perform api._fail('CONFLICT', 'APPROVED_REVEAL_REQUEST_REQUIRED'); end if;
    update protected_identity.reveal_request set status = 'USED', used_at = now() where id = v_req.id;
  end if;
  -- Audit first; identity values are never written to the ledger.
  perform audit.record_event('REPORTER_IDENTITY_REVEALED', 'SECURITY', 'SUCCESS', p_case_id, 'reporter_identity',
    v_case.reporter_wb_id, v_just, jsonb_build_object('reveal_request_id', v_req.id));
  return query
    select i.wb_id, i.full_name, i.email, i.phone, i.preferred_contact,
           i.given_name, i.father_name, i.grandfather_name, i.family_name, i.gender,
           i.birth_date, i.birth_date_calendar, i.id_type, i.id_number, i.city, i.nationality
    from protected_identity.reporter_identity i where i.wb_id = v_case.reporter_wb_id;
end;
$$;

grant execute on function api.resolve_reporter_identity(uuid, text) to authenticated;
