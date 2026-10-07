-- =============================================================================
-- 0400 Domain tables: intake, identity vault, case master, people, assignments,
--      access grants, conflicts, workflow engine, configuration
-- Requirements: §14–§16, §22, §23, §31–§36; ADR-004, ADR-007
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Intake (public reports)
-- -----------------------------------------------------------------------------
create table intake.report (
  id                  uuid primary key default gen_random_uuid(),
  -- Public reference: non-sequential, Crockford base32 (no I, L, O, U). Not a secret (§23).
  report_ref          text not null unique check (report_ref ~ '^WB-[0-9A-HJKMNP-TV-Z]{12}$'),
  -- HMAC-SHA256(pepper, secret) computed by the portal via KeyManagementProvider. The secret itself is never stored.
  secret_hmac         text not null check (secret_hmac ~ '^[0-9a-f]{64}$'),
  -- Opaque whistleblower reference (§22). Cases reference this, never identity fields.
  wb_id               text not null unique default ('WBID-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)))
                      check (wb_id ~ '^WBID-[0-9A-F]{16}$'),
  channel             text not null default 'PUBLIC_PORTAL' check (channel in ('PUBLIC_PORTAL')),
  reporter_mode       text not null check (reporter_mode in ('ANONYMOUS', 'IDENTIFIED')),
  category            text not null check (category in (
                        'FINANCIAL_MISCONDUCT', 'FRAUD', 'CONFLICT_OF_INTEREST', 'PROCUREMENT', 'BEHAVIOURAL_MISCONDUCT',
                        'ADMINISTRATIVE_VIOLATION', 'PRIVACY_DATA', 'CYBERSECURITY', 'OTHER')),
  subject_description text check (length(subject_description) <= 500),
  description         text not null check (length(description) between 20 and 8000),
  incident_date       date check (incident_date <= current_date),
  location            text check (length(location) <= 200),
  language            text not null default 'ar' check (language in ('ar', 'en')),
  classification      core.classification_level not null default 'RESTRICTED',
  status              text not null default 'RECEIVED' check (status in (
                        'RECEIVED', 'INFO_REQUESTED', 'ACCEPTED', 'CASE_OPENED', 'REFERRED_OUT', 'CLOSED_NO_ACTION', 'DUPLICATE')),
  case_id             uuid,  -- FK added after case_record exists
  received_at         timestamptz not null default now(),
  status_changed_at   timestamptz not null default now()
);
create index report_status on intake.report (status, received_at desc);
comment on table intake.report is 'Reports from the public portal. No reporter identity or network metadata is stored here (§22, threat T21).';

create table intake.report_message (
  id             uuid primary key default gen_random_uuid(),
  report_id      uuid not null references intake.report (id),
  direction      text not null check (direction in ('FROM_REPORTER', 'TO_REPORTER')),
  body           text not null check (length(body) between 1 and 4000),
  author_user_id uuid references iam.user_profile (id),
  created_at     timestamptz not null default now(),
  check ((direction = 'FROM_REPORTER') = (author_user_id is null))
);
create index report_message_report on intake.report_message (report_id, created_at);

create table intake.report_triage (
  id                     uuid primary key default gen_random_uuid(),
  report_id              uuid not null references intake.report (id),
  outcome                text not null check (outcome in ('OPEN_CASE', 'REQUEST_INFORMATION', 'REFER_OUT', 'CLOSE_NO_ACTION', 'DUPLICATE')),
  reason                 text not null check (length(reason) between 10 and 4000),
  referred_to            text check (length(referred_to) <= 200),
  duplicate_of_report_id uuid references intake.report (id),
  decided_by             uuid not null references iam.user_profile (id),
  decided_at             timestamptz not null default now(),
  check (outcome <> 'REFER_OUT' or referred_to is not null),
  check (outcome <> 'DUPLICATE' or duplicate_of_report_id is not null)
);
create index report_triage_report on intake.report_triage (report_id, decided_at desc);

-- -----------------------------------------------------------------------------
-- Whistleblower identity vault (ADR-004). No grants, no policies.
-- -----------------------------------------------------------------------------
create table protected_identity.reporter_identity (
  wb_id             text primary key references intake.report (wb_id),
  full_name         text check (length(full_name) <= 200),
  email             text check (length(email) <= 254),
  phone             text check (length(phone) <= 40),
  preferred_contact text check (preferred_contact in ('EMAIL', 'PHONE', 'PORTAL_ONLY')),
  created_at        timestamptz not null default now(),
  check (coalesce(full_name, email, phone) is not null)
);

-- Dual-control reveal requests (ADR-004). Metadata only; never identity values.
create table protected_identity.reveal_request (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null,  -- FK added after case_record exists
  requested_by    uuid not null references iam.user_profile (id),
  justification   text not null check (length(justification) between 20 and 2000),
  status          text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'USED')),
  requested_at    timestamptz not null default now(),
  decided_by      uuid references iam.user_profile (id),
  decided_at      timestamptz,
  decision_reason text,
  expires_at      timestamptz,
  used_at         timestamptz,
  check (decided_by is null or decided_by <> requested_by)
);

-- -----------------------------------------------------------------------------
-- Case master (§16)
-- -----------------------------------------------------------------------------
create table case_mgmt.case_number_counter (
  prefix     text not null check (prefix in ('CDF-CASE', 'CDF-DEMO')),
  year       int not null check (year between 2020 and 2100),
  last_value int not null default 0,
  primary key (prefix, year)
);

create table case_mgmt.case_record (
  id                     uuid primary key default gen_random_uuid(),
  case_number            text not null unique check (case_number ~ '^CDF-(CASE|DEMO)-[0-9]{4}-[0-9]{4,5}$'),
  case_type              text not null check (case_type in ('WHISTLEBLOWING', 'INTERNAL_REFERRAL', 'OTHER')),
  title                  text not null check (length(title) between 3 and 200),
  summary                text not null check (length(summary) between 10 and 4000),
  classification         core.classification_level not null default 'RESTRICTED',
  is_restricted          boolean not null default false,
  source                 text not null check (source in ('PUBLIC_PORTAL', 'INTERNAL_REFERRAL', 'OTHER')),
  source_report_id       uuid unique references intake.report (id),
  reporter_wb_id         text references intake.report (wb_id),
  priority               text check (priority in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  identity_reveal_requires_approval boolean not null default true,
  owner_id               uuid references iam.user_profile (id),
  retention_class        text not null default 'UNASSIGNED' check (retention_class ~ '^[A-Z_]{3,40}$'),
  legal_hold_status      text not null default 'NONE' check (legal_hold_status in ('NONE', 'ACTIVE')),
  records_state          text not null default 'ACTIVE' check (records_state in (
                           'ACTIVE', 'CLOSED', 'RETENTION', 'ARCHIVED', 'DISPOSITION_ELIGIBLE', 'DISPOSITION_PENDING', 'DISPOSED')),
  created_at             timestamptz not null default now(),
  created_by             uuid not null references iam.user_profile (id),
  opened_at              timestamptz,  -- investigation opened
  closed_at              timestamptz,
  updated_at             timestamptz not null default now(),
  updated_by             uuid not null references iam.user_profile (id),
  row_version            int not null default 1,
  check (source <> 'PUBLIC_PORTAL' or source_report_id is not null)
);
create index case_record_created on case_mgmt.case_record (created_at desc);

alter table intake.report
  add constraint report_case_fk foreign key (case_id) references case_mgmt.case_record (id);
alter table protected_identity.reveal_request
  add constraint reveal_request_case_fk foreign key (case_id) references case_mgmt.case_record (id);

create table case_mgmt.person (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null check (length(display_name) between 2 and 200),
  person_type   text not null check (person_type in ('EMPLOYEE', 'CONTRACTOR', 'EXTERNAL', 'UNKNOWN')),
  department    text check (length(department) <= 200),
  user_id       uuid references iam.user_profile (id),
  created_at    timestamptz not null default now()
);

create table case_mgmt.case_person (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references case_mgmt.case_record (id),
  person_id   uuid not null references case_mgmt.person (id),
  role        text not null check (role in ('SUBJECT', 'WITNESS', 'AFFECTED_PARTY', 'OTHER')),
  added_by    uuid not null references iam.user_profile (id),
  added_at    timestamptz not null default now(),
  unique (case_id, person_id, role)
);

create table case_mgmt.allegation (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references case_mgmt.case_record (id),
  category    text not null check (category ~ '^[A-Z_]{3,40}$'),
  description text not null check (length(description) between 10 and 8000),
  status      text not null default 'OPEN' check (status in ('OPEN', 'SUBSTANTIATED', 'UNSUBSTANTIATED', 'WITHDRAWN')),
  created_by  uuid not null references iam.user_profile (id),
  created_at  timestamptz not null default now()
);
create index allegation_case on case_mgmt.allegation (case_id);

create table case_mgmt.case_assignment (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references case_mgmt.case_record (id),
  user_id         uuid not null references iam.user_profile (id),
  assignment_role text not null check (assignment_role in ('CASE_OWNER', 'LEAD_INVESTIGATOR', 'INVESTIGATOR', 'REVIEWER')),
  status          text not null default 'ACTIVE' check (status in ('ACTIVE', 'ENDED')),
  reason          text not null check (length(reason) >= 5),
  assigned_by     uuid not null references iam.user_profile (id),
  assigned_at     timestamptz not null default now(),
  ended_by        uuid references iam.user_profile (id),
  ended_at        timestamptz,
  end_reason      text,
  check ((status = 'ENDED') = (ended_at is not null))
);
create unique index case_assignment_one_active on case_mgmt.case_assignment (case_id, user_id, assignment_role) where status = 'ACTIVE';
create index case_assignment_user on case_mgmt.case_assignment (user_id, case_id) where status = 'ACTIVE';

create table case_mgmt.case_access_grant (
  id             uuid primary key default gen_random_uuid(),
  case_id        uuid not null references case_mgmt.case_record (id),
  user_id        uuid not null references iam.user_profile (id),
  scope          text not null check (scope in ('TRIAGE', 'CASE', 'COMMITTEE', 'REVIEW', 'AUDIT')),
  status         text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  reason         text not null check (length(reason) >= 5),
  effective_from timestamptz not null default now(),
  effective_to   timestamptz,
  granted_by     uuid not null references iam.user_profile (id),
  granted_at     timestamptz not null default now(),
  revoked_by     uuid references iam.user_profile (id),
  revoked_at     timestamptz,
  revocation_reason text,
  check (effective_to is null or effective_to > effective_from),
  check ((status = 'REVOKED') = (revoked_at is not null))
);
create index case_access_grant_user on case_mgmt.case_access_grant (user_id, case_id) where status = 'ACTIVE';

create table case_mgmt.conflict_check (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references case_mgmt.case_record (id),
  user_id         uuid not null references iam.user_profile (id),
  status          text not null check (status in ('NO_CONFLICT', 'CONFLICT_DECLARED', 'CONFLICT_CONFIRMED', 'CONFLICT_CLEARED')),
  declaration     text not null check (length(declaration) between 5 and 2000),
  declared_at     timestamptz not null default now(),
  decided_by      uuid references iam.user_profile (id),
  decided_at      timestamptz,
  decision_reason text,
  is_current      boolean not null default true
);
create unique index conflict_check_current on case_mgmt.conflict_check (case_id, user_id) where is_current;

-- -----------------------------------------------------------------------------
-- Workflow engine (§31, §32; ADR-007)
-- -----------------------------------------------------------------------------
create table workflow.workflow_definition (
  code        text primary key check (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  name_en     text not null,
  name_ar     text not null,
  version     int not null check (version >= 1),
  is_active   boolean not null default true
);

create table workflow.workflow_state (
  workflow_code    text not null references workflow.workflow_definition (code),
  code             text not null check (code ~ '^[A-Z][A-Z_]{2,63}$'),
  name_en          text not null,
  name_ar          text not null,
  sequence         int not null,
  is_initial       boolean not null default false,
  is_terminal      boolean not null default false,
  records_state    text not null check (records_state in ('ACTIVE', 'CLOSED', 'ARCHIVED')),
  primary key (workflow_code, code),
  unique (workflow_code, sequence)
);

create table workflow.workflow_transition_definition (
  workflow_code       text not null references workflow.workflow_definition (code),
  code                text not null check (code ~ '^[A-Z][A-Z_]{2,63}$'),
  from_state          text not null,
  to_state            text not null,
  name_en             text not null,
  name_ar             text not null,
  required_permission text not null references iam.permission (code),
  reason_required     boolean not null default false,
  review_required     boolean not null default false,
  approval_required   boolean not null default false,
  required_conditions text[] not null default '{}',
  sla_hours           int check (sla_hours > 0),
  audit_action        text not null default 'WORKFLOW_TRANSITION',
  is_system           boolean not null default false, -- executed only inside other commands
  is_enabled          boolean not null default true,  -- false until the owning phase implements its guards
  enabled_in_phase    int,
  primary key (workflow_code, code),
  foreign key (workflow_code, from_state) references workflow.workflow_state (workflow_code, code),
  foreign key (workflow_code, to_state) references workflow.workflow_state (workflow_code, code)
);

create table workflow.workflow_instance (
  id               uuid primary key default gen_random_uuid(),
  case_id          uuid not null unique references case_mgmt.case_record (id),
  workflow_code    text not null references workflow.workflow_definition (code),
  current_state    text not null,
  entered_state_at timestamptz not null default now(),
  state_due_at     timestamptz,
  created_at       timestamptz not null default now(),
  foreign key (workflow_code, current_state) references workflow.workflow_state (workflow_code, code)
);

create table workflow.workflow_transition_event (
  id              uuid primary key default gen_random_uuid(),
  instance_id     uuid not null references workflow.workflow_instance (id),
  case_id         uuid not null references case_mgmt.case_record (id),
  transition_code text not null,
  from_state      text not null,
  to_state        text not null,
  actor_id        uuid not null references iam.user_profile (id),
  reason          text,
  occurred_at     timestamptz not null default now(),
  request_id      uuid
);
create index workflow_transition_event_case on workflow.workflow_transition_event (case_id, occurred_at);

-- -----------------------------------------------------------------------------
-- Governed configuration (baseline SOURCE_REQUIRED pattern; risk R10)
-- -----------------------------------------------------------------------------
create table config.setting (
  key              text primary key check (key ~ '^[A-Z][A-Z_]{2,63}$'),
  value            text,
  status           text not null check (status in ('SOURCE_REQUIRED', 'CONFIGURED')),
  source_reference text,
  description      text not null,
  updated_at       timestamptz not null default now(),
  check ((status = 'CONFIGURED') = (value is not null and source_reference is not null))
);
insert into config.setting (key, value, status, source_reference, description) values
  ('COMMITTEE_QUORUM', null, 'SOURCE_REQUIRED', null, 'Investigation committee quorum rule. Must come from an approved CDF source.'),
  ('FINAL_DISCIPLINARY_AUTHORITY', null, 'SOURCE_REQUIRED', null, 'Authority that issues final disciplinary decisions.'),
  ('RETENTION_PERIOD', null, 'SOURCE_REQUIRED', null, 'Retention period per retention class.'),
  ('REPORTER_SECRET_ROTATION', null, 'SOURCE_REQUIRED', null, 'Policy for reporter secret reissue.');

-- -----------------------------------------------------------------------------
-- RLS on, everywhere. Policies follow in 0500.
-- -----------------------------------------------------------------------------
alter table intake.report enable row level security;
alter table intake.report_message enable row level security;
alter table intake.report_triage enable row level security;
alter table protected_identity.reporter_identity enable row level security;
alter table protected_identity.reveal_request enable row level security;
alter table case_mgmt.case_number_counter enable row level security;
alter table case_mgmt.case_record enable row level security;
alter table case_mgmt.person enable row level security;
alter table case_mgmt.case_person enable row level security;
alter table case_mgmt.allegation enable row level security;
alter table case_mgmt.case_assignment enable row level security;
alter table case_mgmt.case_access_grant enable row level security;
alter table case_mgmt.conflict_check enable row level security;
alter table workflow.workflow_definition enable row level security;
alter table workflow.workflow_state enable row level security;
alter table workflow.workflow_transition_definition enable row level security;
alter table workflow.workflow_instance enable row level security;
alter table workflow.workflow_transition_event enable row level security;
alter table config.setting enable row level security;
