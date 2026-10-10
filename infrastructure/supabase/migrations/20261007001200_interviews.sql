-- =============================================================================
-- 1200 Interviews (EPIC 09, CDF-60)
-- Requirements: §16, §18, §19, §22, §29, §30, §83; ADR-003, ADR-004, ADR-005, ADR-006, ADR-012
--
-- An interview belongs to one case and lives in case_mgmt so the existing RLS coverage, policy
-- snapshot and case authorization apply without new schemas. Lifecycle:
--
--   PLANNED ─schedule─► SCHEDULED ─(invitation + rights acknowledged)─► CONDUCTED
--   CONDUCTED ─(statement version acknowledged)─PREPARE─► PREPARED ─REVIEW─► REVIEWED ─APPROVE─► APPROVED
--   PREPARED / REVIEWED ─RETURN (reason)─► CONDUCTED          PLANNED / SCHEDULED ─CANCEL (reason)─► CANCELLED
--
-- Rules that a formal CDF source must confirm are marked SOURCE_REQUIRED (ADR-012 §Open points).
--
-- Whistleblower identity never enters these tables (§22, ADR-004): an interview with the reporter is
-- interviewee_kind = 'REPORTER' with no label and no person link; the case's opaque wb_id is the only
-- reference, resolved solely through api.resolve_reporter_identity().
--
-- Statements are versioned and immutable: each version's SHA-256 is computed by the database from the
-- stored text, acknowledgements attest that exact hash, and every row here is append-only except the
-- interview header, which freezes once APPROVED or CANCELLED. Every command writes its audit event in
-- the same transaction; audit metadata carries ids, codes and hashes, never statement text or names (§83).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table case_mgmt.interview (
  id                     uuid primary key default gen_random_uuid(),
  case_id                uuid not null references case_mgmt.case_record (id),
  -- Display number within the case (INT-001). UUIDs are the keys (§87).
  sequence_no            int not null check (sequence_no >= 1),
  title                  text not null check (length(title) between 3 and 200),
  purpose                text check (length(purpose) <= 2000),
  interviewee_kind       text not null check (interviewee_kind in ('WITNESS', 'SUBJECT', 'REPORTER', 'OTHER')),
  -- Pseudonymous working label (synthetic, e.g. "Witness Gamma"). Never present for the reporter.
  interviewee_label      text check (length(interviewee_label) between 2 and 200),
  case_person_id         uuid references case_mgmt.case_person (id),
  -- Never below the case classification; may be higher, which hides the interview from lower-cleared viewers.
  classification         core.classification_level not null,
  mode                   text check (mode in ('IN_PERSON', 'REMOTE_VIDEO', 'PHONE')),
  location               text check (length(location) <= 200),
  scheduled_start        timestamptz,
  duration_minutes       int check (duration_minutes between 15 and 480),
  status                 text not null default 'PLANNED' check (status in (
                           'PLANNED', 'SCHEDULED', 'CONDUCTED', 'PREPARED', 'REVIEWED', 'APPROVED', 'CANCELLED')),
  rights_ack_method      text check (rights_ack_method in ('SIGNED_FORM', 'VERBAL_ON_RECORD')),
  rights_notice_version  text check (rights_notice_version ~ '^[A-Z0-9][A-Z0-9.-]{2,39}$'),
  rights_recorded_by     uuid references iam.user_profile (id),
  rights_acknowledged_at timestamptz,
  conducted_started_at   timestamptz,
  conducted_ended_at     timestamptz,
  current_statement_version_id uuid,  -- FK added below
  -- Soft link to a CDF-50 form instance once its contract is published. No FK on purpose (no forms dependency).
  form_instance_id       uuid,
  prepared_by            uuid references iam.user_profile (id),
  prepared_at            timestamptz,
  reviewed_by            uuid references iam.user_profile (id),
  reviewed_at            timestamptz,
  approved_by            uuid references iam.user_profile (id),
  approved_at            timestamptz,
  cancelled_at           timestamptz,
  created_by             uuid not null references iam.user_profile (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  row_version            int not null default 1,
  unique (case_id, sequence_no),
  -- The reporter is referenced only through the case's wb_id: no label, no person record (§22).
  check ((interviewee_kind = 'REPORTER') = (interviewee_label is null)),
  check (interviewee_kind <> 'REPORTER' or case_person_id is null),
  check ((rights_acknowledged_at is null) = (rights_ack_method is null)
         and (rights_acknowledged_at is null) = (rights_notice_version is null)
         and (rights_acknowledged_at is null) = (rights_recorded_by is null)),
  check ((conducted_started_at is null) = (conducted_ended_at is null)),
  check (conducted_ended_at is null or conducted_ended_at > conducted_started_at),
  check (status in ('PLANNED', 'CANCELLED') or scheduled_start is not null),
  check (status not in ('CONDUCTED', 'PREPARED', 'REVIEWED', 'APPROVED')
         or (conducted_started_at is not null and rights_acknowledged_at is not null)),
  check ((prepared_by is null) = (prepared_at is null)),
  check ((reviewed_by is null) = (reviewed_at is null)),
  check ((approved_by is null) = (approved_at is null)),
  check (status not in ('PREPARED', 'REVIEWED', 'APPROVED') or prepared_by is not null),
  check (status not in ('REVIEWED', 'APPROVED') or reviewed_by is not null),
  check ((status = 'APPROVED') = (approved_by is not null)),
  check ((status = 'CANCELLED') = (cancelled_at is not null)),
  -- Separation of duties (SOURCE_REQUIRED: confirm against the CDF investigation procedure).
  check (reviewed_by is null or reviewed_by <> prepared_by),
  check (approved_by is null or (approved_by <> prepared_by and approved_by <> reviewed_by))
);
create index interview_case on case_mgmt.interview (case_id, sequence_no);
comment on table case_mgmt.interview is 'Interview header (EPIC 09). Holds no whistleblower identity; see ADR-012.';
comment on column case_mgmt.interview.form_instance_id is 'Reserved soft link to a CDF-50 form instance; populated in a follow-up once that contract exists.';

create table case_mgmt.interview_participant (
  id               uuid primary key default gen_random_uuid(),
  interview_id     uuid not null references case_mgmt.interview (id),
  user_id          uuid not null references iam.user_profile (id),
  participant_role text not null check (participant_role in ('LEAD_INTERVIEWER', 'INTERVIEWER', 'NOTE_TAKER')),
  added_by         uuid not null references iam.user_profile (id),
  added_at         timestamptz not null default now(),
  unique (interview_id, user_id)
);
create unique index interview_one_lead on case_mgmt.interview_participant (interview_id) where participant_role = 'LEAD_INTERVIEWER';
comment on table case_mgmt.interview_participant is 'CDF staff on an interview panel. Append-only in this slice.';

create table case_mgmt.interview_notice (
  id              uuid primary key default gen_random_uuid(),
  seq             bigint generated always as identity,
  interview_id    uuid not null references case_mgmt.interview (id),
  notice_type     text not null check (notice_type in ('INVITATION', 'RESCHEDULE')),
  -- The reporter is invited only through the anonymous portal channel (no identity needed).
  channel         text not null check (channel in ('IN_PERSON', 'INTERNAL_EMAIL', 'LETTER', 'PORTAL_MESSAGE')),
  scheduled_start timestamptz not null,
  issued_by       uuid not null references iam.user_profile (id),
  issued_at       timestamptz not null default now()
);
create index interview_notice_interview on case_mgmt.interview_notice (interview_id, seq);
comment on table case_mgmt.interview_notice is 'Record that an invitation was issued (type, channel, time). No content: notifications carry no investigation detail (§39).';

create table case_mgmt.interview_statement_version (
  id             uuid primary key default gen_random_uuid(),
  interview_id   uuid not null references case_mgmt.interview (id),
  version_no     int not null check (version_no >= 1),
  content        text not null check (length(content) between 1 and 50000),
  language       text not null check (language in ('ar', 'en')),
  -- Always computed by the database from content (trigger below); a supplied value is ignored.
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by    uuid not null references iam.user_profile (id),
  recorded_at    timestamptz not null default now(),
  unique (interview_id, version_no)
);
comment on table case_mgmt.interview_statement_version is 'Immutable statement versions with database-computed SHA-256 (tamper evidence).';

alter table case_mgmt.interview
  add constraint interview_current_statement_fk foreign key (current_statement_version_id)
  references case_mgmt.interview_statement_version (id);

create table case_mgmt.interview_statement_ack (
  id                   uuid primary key default gen_random_uuid(),
  statement_version_id uuid not null unique references case_mgmt.interview_statement_version (id),
  interview_id         uuid not null references case_mgmt.interview (id),
  method               text not null check (method in ('SIGNED_PAPER', 'ELECTRONIC_ACK', 'REFUSED_TO_SIGN')),
  attested_sha256      text not null check (attested_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by          uuid not null references iam.user_profile (id),
  recorded_at          timestamptz not null default now()
);
comment on table case_mgmt.interview_statement_ack is 'Interviewee acknowledgement or recorded refusal of one exact statement version (hash attested).';

create table case_mgmt.interview_recording (
  id           uuid primary key default gen_random_uuid(),
  interview_id uuid not null references case_mgmt.interview (id),
  -- The recording itself is Phase 7 evidence: private storage, custody trail, audited downloads (ADR-006).
  evidence_id  uuid not null references evidence.evidence (id),
  linked_by    uuid not null references iam.user_profile (id),
  linked_at    timestamptz not null default now(),
  unique (interview_id, evidence_id)
);
comment on table case_mgmt.interview_recording is 'Links an interview to evidence items (recordings, signed statements). Content stays in evidence storage.';

-- -----------------------------------------------------------------------------
-- Integrity: database-computed hashes, append-only history, frozen headers
-- -----------------------------------------------------------------------------
create function case_mgmt.reject_interview_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'case_mgmt.% is append-only (% rejected)', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create function case_mgmt.hash_statement_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.content_sha256 := encode(sha256(convert_to(new.content, 'UTF8')), 'hex');
  return new;
end;
$$;
create trigger interview_statement_hash before insert on case_mgmt.interview_statement_version
  for each row execute function case_mgmt.hash_statement_version();

do $$
declare t text;
begin
  foreach t in array array['interview_statement_version', 'interview_statement_ack', 'interview_notice',
                           'interview_recording', 'interview_participant'] loop
    execute format('create trigger %I before update on case_mgmt.%I for each row execute function case_mgmt.reject_interview_mutation()',
                   t || '_no_update', t);
    execute format('create trigger %I before delete on case_mgmt.%I for each row execute function case_mgmt.reject_interview_mutation()',
                   t || '_no_delete', t);
    execute format('create trigger %I before truncate on case_mgmt.%I for each statement execute function case_mgmt.reject_interview_mutation()',
                   t || '_no_truncate', t);
  end loop;
end;
$$;
create trigger interview_no_delete before delete on case_mgmt.interview
  for each row execute function case_mgmt.reject_interview_mutation();
create trigger interview_no_truncate before truncate on case_mgmt.interview
  for each statement execute function case_mgmt.reject_interview_mutation();

-- The header is frozen once APPROVED or CANCELLED, and its identity columns never change.
create function case_mgmt.protect_interview()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('APPROVED', 'CANCELLED') then
    raise exception 'interview % is immutable once %', old.id, old.status using errcode = 'insufficient_privilege';
  end if;
  if new.id <> old.id or new.case_id <> old.case_id or new.sequence_no <> old.sequence_no
     or new.interviewee_kind <> old.interviewee_kind
     or new.interviewee_label is distinct from old.interviewee_label
     or new.case_person_id is distinct from old.case_person_id
     or new.classification <> old.classification
     or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'interview % identity fields are immutable', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger interview_protect before update on case_mgmt.interview
  for each row execute function case_mgmt.protect_interview();

-- -----------------------------------------------------------------------------
-- Authorization (§19). Built only from existing authz helpers; nothing in the core is changed.
-- -----------------------------------------------------------------------------
-- Need-to-know: case access, clearance against the interview classification, and a working
-- relationship with the case. A TRIAGE-scope grant alone does not reach interview content.
create function authz.can_view_interview(p_interview_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from case_mgmt.interview i
    join case_mgmt.case_record c on c.id = i.case_id
    where i.id = p_interview_id
      and authz.can_view_case(i.case_id)
      and i.classification <= authz.current_clearance()
      and (
        authz.has_active_assignment(i.case_id, authz.current_user_id())
        or (authz.has_permission('CASE_VIEW_ALL') and not c.is_restricted)
        or exists (
          select 1 from case_mgmt.case_access_grant g
          where g.case_id = i.case_id and g.user_id = authz.current_user_id() and g.status = 'ACTIVE'
            and g.scope <> 'TRIAGE' and g.effective_from <= now() and (g.effective_to is null or g.effective_to > now())
        )
      )
  );
$$;

-- Planning and conducting: an active case and a working assignment (owner, lead, investigator) or
-- general edit rights; the same relationship evidence upload requires.
create function authz.can_conduct_interviews(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id)
     and exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state = 'ACTIVE')
     and (authz.has_permission('CASE_EDIT_ALL')
          or authz.has_active_assignment(p_case_id, authz.current_user_id(), array['CASE_OWNER', 'LEAD_INVESTIGATOR', 'INVESTIGATOR']));
$$;

create function authz.can_review_interviews(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id)
     and exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state = 'ACTIVE')
     and (authz.has_permission('CASE_EDIT_ALL')
          or authz.has_active_assignment(p_case_id, authz.current_user_id(), array['CASE_OWNER', 'LEAD_INVESTIGATOR', 'REVIEWER']));
$$;

create function authz.can_approve_interviews(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_case(p_case_id)
     and exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.records_state = 'ACTIVE')
     and (authz.has_permission('CASE_EDIT_ALL')
          or authz.has_active_assignment(p_case_id, authz.current_user_id(), array['CASE_OWNER', 'LEAD_INVESTIGATOR']));
$$;

grant execute on function
  authz.can_view_interview(uuid), authz.can_conduct_interviews(uuid),
  authz.can_review_interviews(uuid), authz.can_approve_interviews(uuid)
to authenticated;

-- -----------------------------------------------------------------------------
-- RLS (SELECT only; no write grants exist for application roles)
-- -----------------------------------------------------------------------------
alter table case_mgmt.interview enable row level security;
alter table case_mgmt.interview_participant enable row level security;
alter table case_mgmt.interview_notice enable row level security;
alter table case_mgmt.interview_statement_version enable row level security;
alter table case_mgmt.interview_statement_ack enable row level security;
alter table case_mgmt.interview_recording enable row level security;

create policy interview_read on case_mgmt.interview for select to authenticated
  using (authz.can_view_interview(id));
grant select on case_mgmt.interview to authenticated;

create policy interview_participant_read on case_mgmt.interview_participant for select to authenticated
  using (authz.can_view_interview(interview_id));
grant select on case_mgmt.interview_participant to authenticated;

create policy interview_notice_read on case_mgmt.interview_notice for select to authenticated
  using (authz.can_view_interview(interview_id));
grant select on case_mgmt.interview_notice to authenticated;

create policy interview_statement_version_read on case_mgmt.interview_statement_version for select to authenticated
  using (authz.can_view_interview(interview_id));
grant select on case_mgmt.interview_statement_version to authenticated;

create policy interview_statement_ack_read on case_mgmt.interview_statement_ack for select to authenticated
  using (authz.can_view_interview(interview_id));
grant select on case_mgmt.interview_statement_ack to authenticated;

-- A linked recording is listed only when the viewer may also see the evidence item (its clearance may be higher).
create policy interview_recording_read on case_mgmt.interview_recording for select to authenticated
  using (authz.can_view_interview(interview_id) and authz.can_view_evidence(evidence_id));
grant select on case_mgmt.interview_recording to authenticated;

-- -----------------------------------------------------------------------------
-- Internal helpers (owner context; not granted to application roles)
-- -----------------------------------------------------------------------------
-- Locks and returns an interview the caller may see; missing and invisible are alike (NOT_FOUND).
create function case_mgmt.lock_visible_interview(p_interview_id uuid)
returns case_mgmt.interview
language plpgsql
set search_path = ''
as $$
declare v case_mgmt.interview;
begin
  select * into v from case_mgmt.interview i where i.id = p_interview_id for update;
  if v.id is null or not authz.can_view_interview(v.id) then perform api._fail('NOT_FOUND'); end if;
  return v;
end;
$$;

create function case_mgmt.require_interview_status(p_interview case_mgmt.interview, p_allowed text[])
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not (p_interview.status = any (p_allowed)) then perform api._fail('CONFLICT', 'INTERVIEW_STATE'); end if;
end;
$$;

create function case_mgmt.is_interview_panel(p_interview_id uuid, p_user_id uuid, p_roles text[] default null)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from case_mgmt.interview_participant p
    where p.interview_id = p_interview_id and p.user_id = p_user_id
      and (p_roles is null or p.participant_role = any (p_roles))
  );
$$;

create function case_mgmt.touch_interview(p_interview_id uuid)
returns void
language sql
set search_path = ''
as $$
  update case_mgmt.interview set updated_at = now(), row_version = row_version + 1 where id = p_interview_id;
$$;

-- -----------------------------------------------------------------------------
-- Commands
-- -----------------------------------------------------------------------------
create function api.plan_interview(
  p_case_id uuid, p_title text, p_purpose text, p_interviewee_kind text, p_interviewee_label text,
  p_case_person_id uuid, p_classification core.classification_level
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_id uuid;
  v_seq int;
  v_label text;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_conduct_interviews(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  -- Locking the case serialises sequence numbering.
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;

  if p_interviewee_kind is null or p_interviewee_kind not in ('WITNESS', 'SUBJECT', 'REPORTER', 'OTHER') then
    perform api._fail('INVALID', 'interviewee_kind');
  end if;
  if p_interviewee_kind = 'REPORTER' then
    -- Only the case's own reporter, only by reference: no label, no person record (§22).
    if v_case.reporter_wb_id is null then perform api._fail('INVALID', 'interviewee_kind'); end if;
    if nullif(btrim(coalesce(p_interviewee_label, '')), '') is not null then perform api._fail('INVALID', 'interviewee_label'); end if;
    if p_case_person_id is not null then perform api._fail('INVALID', 'case_person_id'); end if;
    v_label := null;
  else
    v_label := api._require_text(p_interviewee_label, 'interviewee_label', 2, 200);
    if p_case_person_id is not null and not exists (
      select 1 from case_mgmt.case_person cp where cp.id = p_case_person_id and cp.case_id = p_case_id
    ) then
      perform api._fail('INVALID', 'case_person_id');
    end if;
  end if;
  if p_purpose is not null and length(p_purpose) > 2000 then perform api._fail('INVALID', 'purpose'); end if;
  if p_classification is null or p_classification < v_case.classification or p_classification > authz.current_clearance() then
    perform api._fail('INVALID', 'classification');
  end if;

  select coalesce(max(i.sequence_no), 0) + 1 into v_seq from case_mgmt.interview i where i.case_id = p_case_id;
  insert into case_mgmt.interview (case_id, sequence_no, title, purpose, interviewee_kind, interviewee_label,
                                   case_person_id, classification, created_by)
  values (p_case_id, v_seq, api._require_text(p_title, 'title', 3, 200), nullif(btrim(coalesce(p_purpose, '')), ''),
          p_interviewee_kind, v_label, p_case_person_id, p_classification, v_actor)
  returning id into v_id;
  insert into case_mgmt.interview_participant (interview_id, user_id, participant_role, added_by)
  values (v_id, v_actor, 'LEAD_INTERVIEWER', v_actor);

  perform audit.record_event('INTERVIEW_PLANNED', 'BUSINESS', 'SUCCESS', p_case_id, 'interview', v_id::text, null,
    jsonb_build_object('sequence_no', v_seq, 'interviewee_kind', p_interviewee_kind, 'classification', p_classification,
                       'case_person_linked', p_case_person_id is not null));
  return v_id;
end;
$$;

create function api.add_interview_participant(p_interview_id uuid, p_user_id uuid, p_participant_role text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_i case_mgmt.interview;
  v_id uuid;
begin
  v_i := case_mgmt.lock_visible_interview(p_interview_id);
  if not authz.can_conduct_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform case_mgmt.require_interview_status(v_i, array['PLANNED', 'SCHEDULED']);
  if p_participant_role is null or p_participant_role not in ('INTERVIEWER', 'NOTE_TAKER') then
    perform api._fail('INVALID', 'participant_role');
  end if;
  -- The panel member must be able to see the case (assignment or grant, no conflict) and the interview's classification.
  if p_user_id is null or not authz.user_can_view_case(p_user_id, v_i.case_id)
     or (select u.clearance from iam.user_profile u where u.id = p_user_id) < v_i.classification then
    perform api._fail('CONFLICT', 'PARTICIPANT_INELIGIBLE');
  end if;
  if case_mgmt.is_interview_panel(v_i.id, p_user_id) then perform api._fail('CONFLICT', 'ALREADY_PARTICIPANT'); end if;

  insert into case_mgmt.interview_participant (interview_id, user_id, participant_role, added_by)
  values (v_i.id, p_user_id, p_participant_role, v_actor)
  returning id into v_id;
  perform case_mgmt.touch_interview(v_i.id);
  perform audit.record_event('INTERVIEW_PARTICIPANT_ADDED', 'BUSINESS', 'SUCCESS', v_i.case_id, 'interview', v_i.id::text, null,
    jsonb_build_object('participant_user_id', p_user_id, 'participant_role', p_participant_role));
  return v_id;
end;
$$;

create function api.schedule_interview(
  p_interview_id uuid, p_scheduled_start timestamptz, p_duration_minutes int, p_mode text, p_location text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_i case_mgmt.interview;
  v_reschedule boolean;
begin
  v_i := case_mgmt.lock_visible_interview(p_interview_id);
  if not authz.can_conduct_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform case_mgmt.require_interview_status(v_i, array['PLANNED', 'SCHEDULED']);
  -- Same-day back-filling is allowed; anything older or more than a year ahead is a data-entry error.
  if p_scheduled_start is null or p_scheduled_start < now() - interval '1 day' or p_scheduled_start > now() + interval '366 days' then
    perform api._fail('INVALID', 'scheduled_start');
  end if;
  if p_duration_minutes is null or p_duration_minutes not between 15 and 480 then perform api._fail('INVALID', 'duration_minutes'); end if;
  if p_mode is null or p_mode not in ('IN_PERSON', 'REMOTE_VIDEO', 'PHONE') then perform api._fail('INVALID', 'mode'); end if;
  if p_location is not null and length(p_location) > 200 then perform api._fail('INVALID', 'location'); end if;
  v_reschedule := v_i.status = 'SCHEDULED';

  update case_mgmt.interview
     set status = 'SCHEDULED', scheduled_start = p_scheduled_start, duration_minutes = p_duration_minutes, mode = p_mode,
         location = nullif(btrim(coalesce(p_location, '')), ''), updated_at = now(), row_version = row_version + 1
   where id = v_i.id;
  perform audit.record_event(case when v_reschedule then 'INTERVIEW_RESCHEDULED' else 'INTERVIEW_SCHEDULED' end,
    'BUSINESS', 'SUCCESS', v_i.case_id, 'interview', v_i.id::text, null,
    jsonb_build_object('scheduled_start', p_scheduled_start, 'duration_minutes', p_duration_minutes, 'mode', p_mode,
                       'previous_start', v_i.scheduled_start));
end;
$$;

create function api.issue_interview_notice(p_interview_id uuid, p_notice_type text, p_channel text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_i case_mgmt.interview;
  v_id uuid;
begin
  v_i := case_mgmt.lock_visible_interview(p_interview_id);
  if not authz.can_conduct_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform case_mgmt.require_interview_status(v_i, array['SCHEDULED']);
  if p_notice_type is null or p_notice_type not in ('INVITATION', 'RESCHEDULE') then perform api._fail('INVALID', 'notice_type'); end if;
  if p_channel is null or p_channel not in ('IN_PERSON', 'INTERNAL_EMAIL', 'LETTER', 'PORTAL_MESSAGE') then
    perform api._fail('INVALID', 'channel');
  end if;
  -- The reporter is reachable only through the anonymous portal; staff channels need an identity (§22).
  if (v_i.interviewee_kind = 'REPORTER') <> (p_channel = 'PORTAL_MESSAGE') then perform api._fail('INVALID', 'channel'); end if;
  if p_notice_type = 'RESCHEDULE' and not exists (
    select 1 from case_mgmt.interview_notice n where n.interview_id = v_i.id and n.notice_type = 'INVITATION'
  ) then
    perform api._fail('CONFLICT', 'NOTICE_NOT_ISSUED');
  end if;

  insert into case_mgmt.interview_notice (interview_id, notice_type, channel, scheduled_start, issued_by)
  values (v_i.id, p_notice_type, p_channel, v_i.scheduled_start, v_actor)
  returning id into v_id;
  perform case_mgmt.touch_interview(v_i.id);
  perform audit.record_event('INTERVIEW_NOTICE_ISSUED', 'BUSINESS', 'SUCCESS', v_i.case_id, 'interview', v_i.id::text, null,
    jsonb_build_object('notice_type', p_notice_type, 'channel', p_channel, 'scheduled_start', v_i.scheduled_start));
  return v_id;
end;
$$;

-- SOURCE_REQUIRED: the wording and versioning of the interviewee rights notice.
create function api.record_interview_rights(p_interview_id uuid, p_method text, p_notice_version text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_i case_mgmt.interview;
begin
  v_i := case_mgmt.lock_visible_interview(p_interview_id);
  if not authz.can_conduct_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform case_mgmt.require_interview_status(v_i, array['SCHEDULED']);
  if not case_mgmt.is_interview_panel(v_i.id, v_actor, array['LEAD_INTERVIEWER', 'INTERVIEWER']) then
    perform api._fail('CONFLICT', 'NOT_INTERVIEWER');
  end if;
  if v_i.rights_acknowledged_at is not null then perform api._fail('CONFLICT', 'RIGHTS_ALREADY_RECORDED'); end if;
  if p_method is null or p_method not in ('SIGNED_FORM', 'VERBAL_ON_RECORD') then perform api._fail('INVALID', 'method'); end if;
  if p_notice_version is null or p_notice_version !~ '^[A-Z0-9][A-Z0-9.-]{2,39}$' then perform api._fail('INVALID', 'notice_version'); end if;

  update case_mgmt.interview
     set rights_ack_method = p_method, rights_notice_version = p_notice_version, rights_recorded_by = v_actor,
         rights_acknowledged_at = now(), updated_at = now(), row_version = row_version + 1
   where id = v_i.id;
  perform audit.record_event('INTERVIEW_RIGHTS_ACKNOWLEDGED', 'BUSINESS', 'SUCCESS', v_i.case_id, 'interview', v_i.id::text, null,
    jsonb_build_object('method', p_method, 'notice_version', p_notice_version));
end;
$$;

create function api.record_interview_conducted(p_interview_id uuid, p_started_at timestamptz, p_ended_at timestamptz)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_i case_mgmt.interview;
begin
  v_i := case_mgmt.lock_visible_interview(p_interview_id);
  if not authz.can_conduct_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform case_mgmt.require_interview_status(v_i, array['SCHEDULED']);
  if not case_mgmt.is_interview_panel(v_i.id, v_actor, array['LEAD_INTERVIEWER', 'INTERVIEWER']) then
    perform api._fail('CONFLICT', 'NOT_INTERVIEWER');
  end if;
  if not exists (select 1 from case_mgmt.interview_notice n where n.interview_id = v_i.id and n.notice_type = 'INVITATION') then
    perform api._fail('CONFLICT', 'NOTICE_NOT_ISSUED');
  end if;
  if v_i.rights_acknowledged_at is null then perform api._fail('CONFLICT', 'RIGHTS_NOT_ACKNOWLEDGED'); end if;
  if p_started_at is null or p_started_at > now() or p_started_at < now() - interval '30 days' then
    perform api._fail('INVALID', 'started_at');
  end if;
  if p_ended_at is null or p_ended_at <= p_started_at or p_ended_at > now() or p_ended_at - p_started_at > interval '12 hours' then
    perform api._fail('INVALID', 'ended_at');
  end if;

  update case_mgmt.interview
     set status = 'CONDUCTED', conducted_started_at = p_started_at, conducted_ended_at = p_ended_at,
         updated_at = now(), row_version = row_version + 1
   where id = v_i.id;
  perform audit.record_event('INTERVIEW_CONDUCTED', 'BUSINESS', 'SUCCESS', v_i.case_id, 'interview', v_i.id::text, null,
    jsonb_build_object('started_at', p_started_at, 'ended_at', p_ended_at));
end;
$$;

create function api.record_interview_statement(p_interview_id uuid, p_content text, p_language text)
returns table (o_version_id uuid, o_version_no int, o_sha256 text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_i case_mgmt.interview;
  v_ver case_mgmt.interview_statement_version;
begin
  v_i := case_mgmt.lock_visible_interview(p_interview_id);
  if not authz.can_conduct_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform case_mgmt.require_interview_status(v_i, array['CONDUCTED']);
  if not case_mgmt.is_interview_panel(v_i.id, v_actor) then perform api._fail('CONFLICT', 'NOT_INTERVIEWER'); end if;
  if p_content is null or length(btrim(p_content)) < 1 or length(p_content) > 50000 then perform api._fail('INVALID', 'content'); end if;
  if p_language is null or p_language not in ('ar', 'en') then perform api._fail('INVALID', 'language'); end if;

  insert into case_mgmt.interview_statement_version (interview_id, version_no, content, language, content_sha256, recorded_by)
  values (v_i.id,
          (select coalesce(max(s.version_no), 0) + 1 from case_mgmt.interview_statement_version s where s.interview_id = v_i.id),
          p_content, p_language, repeat('0', 64), v_actor)
  returning * into v_ver;
  update case_mgmt.interview
     set current_statement_version_id = v_ver.id, updated_at = now(), row_version = row_version + 1
   where id = v_i.id;
  -- The hash and length go to the ledger; the text never does (§83).
  perform audit.record_event('INTERVIEW_STATEMENT_RECORDED', 'BUSINESS', 'SUCCESS', v_i.case_id, 'interview_statement_version',
    v_ver.id::text, null,
    jsonb_build_object('interview_id', v_i.id, 'version_no', v_ver.version_no, 'sha256', v_ver.content_sha256,
                       'length', length(p_content), 'language', p_language));
  return query select v_ver.id, v_ver.version_no, v_ver.content_sha256;
end;
$$;

create function api.acknowledge_interview_statement(p_version_id uuid, p_method text, p_attested_sha256 text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_ver case_mgmt.interview_statement_version;
  v_i case_mgmt.interview;
  v_id uuid;
begin
  select * into v_ver from case_mgmt.interview_statement_version s where s.id = p_version_id;
  if v_ver.id is null then perform api._fail('NOT_FOUND'); end if;
  v_i := case_mgmt.lock_visible_interview(v_ver.interview_id);
  if not authz.can_conduct_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform case_mgmt.require_interview_status(v_i, array['CONDUCTED']);
  if not case_mgmt.is_interview_panel(v_i.id, v_actor) then perform api._fail('CONFLICT', 'NOT_INTERVIEWER'); end if;
  if v_i.current_statement_version_id is distinct from v_ver.id then perform api._fail('CONFLICT', 'STATEMENT_NOT_CURRENT'); end if;
  if p_method is null or p_method not in ('SIGNED_PAPER', 'ELECTRONIC_ACK', 'REFUSED_TO_SIGN') then perform api._fail('INVALID', 'method'); end if;
  -- The acknowledgement binds to the exact text the interviewee saw.
  if p_attested_sha256 is null or p_attested_sha256 <> v_ver.content_sha256 then perform api._fail('CONFLICT', 'STATEMENT_HASH_MISMATCH'); end if;
  if exists (select 1 from case_mgmt.interview_statement_ack a where a.statement_version_id = v_ver.id) then
    perform api._fail('CONFLICT', 'STATEMENT_ALREADY_ACKNOWLEDGED');
  end if;

  insert into case_mgmt.interview_statement_ack (statement_version_id, interview_id, method, attested_sha256, recorded_by)
  values (v_ver.id, v_i.id, p_method, p_attested_sha256, v_actor)
  returning id into v_id;
  perform case_mgmt.touch_interview(v_i.id);
  perform audit.record_event('INTERVIEW_STATEMENT_ACKNOWLEDGED', 'BUSINESS', 'SUCCESS', v_i.case_id, 'interview_statement_version',
    v_ver.id::text, null,
    jsonb_build_object('interview_id', v_i.id, 'version_no', v_ver.version_no, 'sha256', v_ver.content_sha256, 'method', p_method));
  return v_id;
end;
$$;

create function api.link_interview_recording(p_interview_id uuid, p_evidence_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_i case_mgmt.interview;
  v_ev evidence.evidence;
  v_id uuid;
begin
  v_i := case_mgmt.lock_visible_interview(p_interview_id);
  if not authz.can_conduct_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform case_mgmt.require_interview_status(v_i, array['CONDUCTED']);
  select * into v_ev from evidence.evidence e where e.id = p_evidence_id;
  -- Evidence from another case, or evidence the caller cannot see, is indistinguishable from missing.
  if v_ev.id is null or v_ev.case_id <> v_i.case_id or not authz.can_view_evidence(v_ev.id) then
    perform api._fail('INVALID', 'evidence_id');
  end if;
  if v_ev.status <> 'AVAILABLE' then perform api._fail('CONFLICT', 'EVIDENCE_NOT_AVAILABLE'); end if;
  if v_ev.evidence_type not in ('AUDIO', 'VIDEO', 'DOCUMENT') then perform api._fail('INVALID', 'evidence_id'); end if;
  if exists (select 1 from case_mgmt.interview_recording r where r.interview_id = v_i.id and r.evidence_id = v_ev.id) then
    perform api._fail('CONFLICT', 'RECORDING_ALREADY_LINKED');
  end if;

  insert into case_mgmt.interview_recording (interview_id, evidence_id, linked_by)
  values (v_i.id, v_ev.id, v_actor)
  returning id into v_id;
  perform case_mgmt.touch_interview(v_i.id);
  perform audit.record_event('INTERVIEW_RECORDING_LINKED', 'BUSINESS', 'SUCCESS', v_i.case_id, 'interview', v_i.id::text, null,
    jsonb_build_object('evidence_id', v_ev.id, 'evidence_sequence_no', v_ev.sequence_no, 'evidence_type', v_ev.evidence_type));
  return v_id;
end;
$$;

-- Lifecycle: PREPARE, REVIEW, APPROVE, RETURN (reason), CANCEL (reason). Mirrored in packages/domain (interviews).
create function api.transition_interview(p_interview_id uuid, p_action text, p_reason text default null)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_i case_mgmt.interview;
  v_to text;
  v_reason text;
  v_action text;
begin
  v_i := case_mgmt.lock_visible_interview(p_interview_id);
  if p_action is null or p_action not in ('PREPARE', 'REVIEW', 'APPROVE', 'RETURN', 'CANCEL') then
    perform api._fail('INVALID', 'action');
  end if;

  if p_action = 'PREPARE' then
    if not authz.can_conduct_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
    perform case_mgmt.require_interview_status(v_i, array['CONDUCTED']);
    if not case_mgmt.is_interview_panel(v_i.id, v_actor, array['LEAD_INTERVIEWER', 'INTERVIEWER']) then
      perform api._fail('CONFLICT', 'NOT_INTERVIEWER');
    end if;
    if v_i.current_statement_version_id is null then perform api._fail('CONFLICT', 'STATEMENT_MISSING'); end if;
    if not exists (select 1 from case_mgmt.interview_statement_ack a where a.statement_version_id = v_i.current_statement_version_id) then
      perform api._fail('CONFLICT', 'STATEMENT_NOT_ACKNOWLEDGED');
    end if;
    v_to := 'PREPARED';
    update case_mgmt.interview set status = v_to, prepared_by = v_actor, prepared_at = now(),
           updated_at = now(), row_version = row_version + 1 where id = v_i.id;
    v_action := 'INTERVIEW_PREPARED';

  elsif p_action = 'REVIEW' then
    if not authz.can_review_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
    perform case_mgmt.require_interview_status(v_i, array['PREPARED']);
    if v_actor = v_i.prepared_by then perform api._fail('CONFLICT', 'SEPARATION_OF_DUTIES'); end if;
    v_to := 'REVIEWED';
    update case_mgmt.interview set status = v_to, reviewed_by = v_actor, reviewed_at = now(),
           updated_at = now(), row_version = row_version + 1 where id = v_i.id;
    v_action := 'INTERVIEW_REVIEWED';

  elsif p_action = 'APPROVE' then
    if not authz.can_approve_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
    perform case_mgmt.require_interview_status(v_i, array['REVIEWED']);
    if v_actor = v_i.prepared_by or v_actor = v_i.reviewed_by then perform api._fail('CONFLICT', 'SEPARATION_OF_DUTIES'); end if;
    v_to := 'APPROVED';
    update case_mgmt.interview set status = v_to, approved_by = v_actor, approved_at = now(),
           updated_at = now(), row_version = row_version + 1 where id = v_i.id;
    v_action := 'INTERVIEW_APPROVED';

  elsif p_action = 'RETURN' then
    if not authz.can_review_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
    perform case_mgmt.require_interview_status(v_i, array['PREPARED', 'REVIEWED']);
    if v_actor = v_i.prepared_by then perform api._fail('CONFLICT', 'SEPARATION_OF_DUTIES'); end if;
    v_reason := api._require_text(p_reason, 'reason', 10, 2000);
    v_to := 'CONDUCTED';
    update case_mgmt.interview set status = v_to, prepared_by = null, prepared_at = null, reviewed_by = null, reviewed_at = null,
           updated_at = now(), row_version = row_version + 1 where id = v_i.id;
    v_action := 'INTERVIEW_RETURNED';

  else -- CANCEL
    if not authz.can_conduct_interviews(v_i.case_id) then perform api._fail('FORBIDDEN'); end if;
    perform case_mgmt.require_interview_status(v_i, array['PLANNED', 'SCHEDULED']);
    v_reason := api._require_text(p_reason, 'reason', 10, 2000);
    v_to := 'CANCELLED';
    update case_mgmt.interview set status = v_to, cancelled_at = now(),
           updated_at = now(), row_version = row_version + 1 where id = v_i.id;
    v_action := 'INTERVIEW_CANCELLED';
  end if;

  perform audit.record_event(v_action, 'BUSINESS', 'SUCCESS', v_i.case_id, 'interview', v_i.id::text, v_reason,
    jsonb_build_object('from_status', v_i.status, 'to_status', v_to, 'statement_version_id', v_i.current_statement_version_id));
  return v_to;
end;
$$;

-- Read-side access recording: opening an interview (statement text included) is a BUSINESS event;
-- a denied or missing target is a SECURITY event and returns false (indistinguishable to the caller).
create function api.open_interview(p_interview_id uuid)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case uuid;
begin
  select i.case_id into v_case from case_mgmt.interview i where i.id = p_interview_id;
  if v_case is not null and authz.can_view_interview(p_interview_id) then
    perform audit.record_event('INTERVIEW_VIEWED', 'BUSINESS', 'SUCCESS', v_case, 'interview', p_interview_id::text, null, '{}'::jsonb);
    return true;
  end if;
  perform audit.record_event('INTERVIEW_ACCESS_DENIED', 'SECURITY', 'DENIED', null, 'interview', p_interview_id::text, null,
    jsonb_build_object('target_exists', v_case is not null,
                       'case_visible', case when v_case is null then null else authz.can_view_case(v_case) end));
  return false;
end;
$$;

grant execute on function
  api.plan_interview(uuid, text, text, text, text, uuid, core.classification_level),
  api.add_interview_participant(uuid, uuid, text),
  api.schedule_interview(uuid, timestamptz, int, text, text),
  api.issue_interview_notice(uuid, text, text),
  api.record_interview_rights(uuid, text, text),
  api.record_interview_conducted(uuid, timestamptz, timestamptz),
  api.record_interview_statement(uuid, text, text),
  api.acknowledge_interview_statement(uuid, text, text),
  api.link_interview_recording(uuid, uuid),
  api.transition_interview(uuid, text, text),
  api.open_interview(uuid)
to authenticated;
