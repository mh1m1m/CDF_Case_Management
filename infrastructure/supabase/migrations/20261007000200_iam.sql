-- =============================================================================
-- 0200 Identity & access management: roles, permissions, user profiles, role assignments
-- Requirements: §21, §19, §2 (synthetic data); ADR-003, ADR-010
-- =============================================================================

create table iam.role (
  code         text primary key check (code ~ '^[A-Z][A-Z_]{2,63}$'),
  name_en      text not null,
  name_ar      text not null,
  description  text not null,
  -- Technical roles administer the platform and never imply case-content access (§21).
  is_technical boolean not null default false
);

create table iam.permission (
  code        text primary key check (code ~ '^[A-Z][A-Z_]{2,63}$'),
  description text not null
);

create table iam.role_permission (
  role_code       text not null references iam.role (code),
  permission_code text not null references iam.permission (code),
  primary key (role_code, permission_code)
);

create table iam.user_profile (
  id               uuid primary key,  -- identity provider subject (Supabase auth.users.id / future CDF IdP sub)
  email            text not null unique
                   -- Data-safety control (§2): the prototype only accepts synthetic identities.
                   check (email = lower(email) and email ~ '^[a-z0-9._+-]+@example\.test$'),
  display_name     text not null check (length(display_name) between 2 and 120),
  display_name_ar  text not null check (length(display_name_ar) between 2 and 120),
  department       text,
  status           core.record_status not null default 'ACTIVE',
  clearance        core.classification_level not null default 'RESTRICTED',
  is_synthetic     boolean not null default true check (is_synthetic),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on column iam.user_profile.clearance is 'ABAC attribute: highest classification this user may view.';

create table iam.user_role_assignment (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references iam.user_profile (id),
  role_code        text not null references iam.role (code),
  status           core.record_status not null default 'ACTIVE',
  effective_from   date not null default current_date,
  effective_to     date,
  justification    text not null check (length(justification) >= 5),
  source_reference text,
  granted_by       uuid references iam.user_profile (id),
  granted_at       timestamptz not null default now(),
  revoked_by       uuid references iam.user_profile (id),
  revoked_at       timestamptz,
  revocation_reason text,
  check (effective_to is null or effective_to >= effective_from),
  check ((status = 'REVOKED') = (revoked_at is not null))
);
create unique index user_role_assignment_one_active
  on iam.user_role_assignment (user_id, role_code) where status = 'ACTIVE';
create index user_role_assignment_user on iam.user_role_assignment (user_id) where status = 'ACTIVE';

-- -----------------------------------------------------------------------------
-- Reference data: roles (§21 + baseline roles that the protocol list lacked; see BASELINE_ANALYSIS §5.3)
-- -----------------------------------------------------------------------------
insert into iam.role (code, name_en, name_ar, description, is_technical) values
  ('INTAKE_OFFICER',      'Intake Officer',        'موظف الاستقبال',            'Receives reports and corresponds with reporters.', false),
  ('TRIAGE_OFFICER',      'Triage Officer',        'موظف الفرز',                'Triages reports and opens cases.', false),
  ('CASE_MANAGER',        'Case Manager',          'مدير القضايا',              'Oversees non-restricted cases, assigns and advances them.', false),
  ('INVESTIGATOR',        'Investigator',          'محقق',                      'Investigates assigned cases only.', false),
  ('LEAD_INVESTIGATOR',   'Lead Investigator',     'محقق أول',                  'Leads and assigns within assigned cases.', false),
  ('COMMITTEE_SECRETARY', 'Committee Secretary',   'أمين سر اللجنة',            'Administers committee work; no vote.', false),
  ('COMMITTEE_CHAIR',     'Committee Chair',       'رئيس اللجنة',               'Chairs the investigation committee.', false),
  ('COMMITTEE_MEMBER',    'Committee Member',      'عضو اللجنة',                'Voting committee member when eligible and not conflicted.', false),
  ('GRC_DIRECTOR',        'GRC Director',          'مدير الحوكمة والمخاطر والامتثال', 'Approves investigations; may grant restricted access and reveal identity.', false),
  ('COMPLIANCE',          'Compliance',            'الامتثال',                   'Compliance oversight.', false),
  ('LEGAL_REVIEWER',      'Legal Reviewer',        'مراجع قانوني',              'Legal review of findings by grant.', false),
  ('HR_REVIEWER',         'HR Reviewer',           'مراجع الموارد البشرية',      'HR review by grant.', false),
  ('PRIVACY_DPO',         'Privacy / DPO',         'مسؤول حماية البيانات',       'Privacy oversight of identity reveals and exports.', false),
  ('RECORDS_OFFICER',     'Records Officer',       'مسؤول السجلات',             'Retention, legal hold and disposition.', false),
  ('INTERNAL_AUDIT',      'Internal Audit',        'المراجعة الداخلية',          'Reads audit metadata; no case content without a grant.', false),
  ('SOC_ANALYST',         'SOC Analyst',           'محلل مركز العمليات الأمنية', 'Reads security events only.', true),
  ('PLATFORM_ADMIN',      'Platform Administrator','مدير المنصة',               'Manages users and roles; no case content.', true),
  ('DB_ADMIN',            'Database Administrator','مدير قاعدة البيانات',        'Operates migrations; no application permissions.', true),
  ('DECISION_AUTHORITY',  'Decision Authority',    'صاحب صلاحية القرار',         'Approves decisions within an assigned scope (authority source: SOURCE_REQUIRED).', false),
  ('IMPLEMENTATION_OWNER','Implementation Owner',  'مسؤول تنفيذ القرار',         'Tracks assigned corrective actions.', false),
  ('REFERRER',            'Internal Referrer',     'محيل داخلي',                'Submits internal referrals on behalf of a department or sector.', false);

insert into iam.permission (code, description) values
  ('INTAKE_VIEW',              'View reports that have not yet become cases'),
  ('REPORT_TRIAGE',            'Record a triage decision on a report'),
  ('REPORT_MESSAGE_REPLY',     'Send a message to a reporter through the secure channel'),
  ('CASE_CREATE',              'Open a case from a triaged report'),
  ('CASE_VIEW_ALL',            'View all non-restricted cases within clearance'),
  ('CASE_EDIT_ALL',            'Edit case master details on viewable cases'),
  ('CASE_ASSIGN',              'Assign or reassign people on viewable cases'),
  ('WORKFLOW_SCREEN',          'Perform screening transitions'),
  ('WORKFLOW_ADVANCE',         'Perform general workflow transitions'),
  ('INVESTIGATION_APPROVE',    'Approve or reject opening an investigation'),
  ('CONFLICT_DECLARE',         'Declare own conflict-of-interest status on a case'),
  ('CONFLICT_MANAGE',          'Confirm or clear declared conflicts'),
  ('CLASSIFICATION_CHANGE',    'Change case classification or restricted flag'),
  ('RESTRICTED_CASE_GRANT',    'Grant access to restricted cases'),
  ('REPORTER_IDENTITY_REVEAL', 'Request, approve or perform controlled reporter identity resolution'),
  ('AUDIT_VIEW',               'Read business and administrative audit events'),
  ('SECURITY_EVENT_VIEW',      'Read security audit events'),
  ('USER_ADMIN',               'Manage user status'),
  ('ROLE_ADMIN',               'Grant and revoke roles');

insert into iam.role_permission (role_code, permission_code) values
  ('INTAKE_OFFICER', 'INTAKE_VIEW'), ('INTAKE_OFFICER', 'REPORT_MESSAGE_REPLY'),
  ('TRIAGE_OFFICER', 'INTAKE_VIEW'), ('TRIAGE_OFFICER', 'REPORT_MESSAGE_REPLY'), ('TRIAGE_OFFICER', 'REPORT_TRIAGE'),
  ('TRIAGE_OFFICER', 'CASE_CREATE'), ('TRIAGE_OFFICER', 'WORKFLOW_SCREEN'), ('TRIAGE_OFFICER', 'CONFLICT_DECLARE'),
  ('CASE_MANAGER', 'CASE_VIEW_ALL'), ('CASE_MANAGER', 'CASE_EDIT_ALL'), ('CASE_MANAGER', 'CASE_CREATE'),
  ('CASE_MANAGER', 'CASE_ASSIGN'), ('CASE_MANAGER', 'WORKFLOW_SCREEN'), ('CASE_MANAGER', 'WORKFLOW_ADVANCE'),
  ('CASE_MANAGER', 'INVESTIGATION_APPROVE'), ('CASE_MANAGER', 'CONFLICT_MANAGE'), ('CASE_MANAGER', 'CONFLICT_DECLARE'),
  ('CASE_MANAGER', 'CLASSIFICATION_CHANGE'),
  ('LEAD_INVESTIGATOR', 'CASE_ASSIGN'), ('LEAD_INVESTIGATOR', 'WORKFLOW_ADVANCE'), ('LEAD_INVESTIGATOR', 'CONFLICT_DECLARE'),
  ('INVESTIGATOR', 'CONFLICT_DECLARE'),
  ('COMMITTEE_SECRETARY', 'CONFLICT_DECLARE'), ('COMMITTEE_CHAIR', 'CONFLICT_DECLARE'), ('COMMITTEE_MEMBER', 'CONFLICT_DECLARE'),
  ('LEGAL_REVIEWER', 'CONFLICT_DECLARE'), ('HR_REVIEWER', 'CONFLICT_DECLARE'),
  ('GRC_DIRECTOR', 'CASE_VIEW_ALL'), ('GRC_DIRECTOR', 'CASE_ASSIGN'), ('GRC_DIRECTOR', 'INVESTIGATION_APPROVE'),
  ('GRC_DIRECTOR', 'CLASSIFICATION_CHANGE'), ('GRC_DIRECTOR', 'RESTRICTED_CASE_GRANT'),
  ('GRC_DIRECTOR', 'REPORTER_IDENTITY_REVEAL'), ('GRC_DIRECTOR', 'CONFLICT_MANAGE'), ('GRC_DIRECTOR', 'CONFLICT_DECLARE'),
  ('PRIVACY_DPO', 'AUDIT_VIEW'), ('PRIVACY_DPO', 'SECURITY_EVENT_VIEW'),
  ('INTERNAL_AUDIT', 'AUDIT_VIEW'),
  ('SOC_ANALYST', 'SECURITY_EVENT_VIEW'),
  ('PLATFORM_ADMIN', 'USER_ADMIN'), ('PLATFORM_ADMIN', 'ROLE_ADMIN');
-- COMPLIANCE, RECORDS_OFFICER, DECISION_AUTHORITY, IMPLEMENTATION_OWNER, REFERRER, DB_ADMIN:
-- no permissions until their phases (9–12) define them. DB_ADMIN intentionally never gets any.

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table iam.role enable row level security;
alter table iam.permission enable row level security;
alter table iam.role_permission enable row level security;
alter table iam.user_profile enable row level security;
alter table iam.user_role_assignment enable row level security;
-- Policies are created in 0300 once authz.current_user_id() exists.
