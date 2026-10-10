-- =============================================================================
-- SYNTHETIC DEMO USERS (§2). Every identity here is fictitious; emails use the reserved
-- .test domain. The fixed UUIDs are the identity-provider subjects used by tests and by the
-- local-dev identity provider. In hosted Supabase the same ids are created in auth.users by
-- scripts/db/seed-auth-users.mjs (never by hand).
-- =============================================================================

insert into iam.user_profile (id, email, display_name, display_name_ar, department, status, clearance) values
  ('a0000000-0000-4000-8000-000000000001', 'intake@example.test',         'Intake Officer Alpha',     'موظف الاستقبال ألفا',     'Intake (synthetic)',        'ACTIVE',  'RESTRICTED'),
  ('a0000000-0000-4000-8000-000000000002', 'triage@example.test',         'Triage Officer Beta',      'موظف الفرز بيتا',         'Intake (synthetic)',        'ACTIVE',  'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000003', 'casemanager@example.test',    'Case Manager Gamma',       'مدير القضايا جاما',        'Investigations (synthetic)', 'ACTIVE',  'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000004', 'investigator.a@example.test', 'Investigator Alpha',       'المحقق ألفا',             'Investigations (synthetic)', 'ACTIVE',  'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000005', 'investigator.b@example.test', 'Investigator Beta',        'المحقق بيتا',             'Investigations (synthetic)', 'ACTIVE',  'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000006', 'lead@example.test',           'Lead Investigator Delta',  'المحقق الأول دلتا',        'Investigations (synthetic)', 'ACTIVE',  'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000007', 'committee@example.test',      'Committee Member Epsilon', 'عضو اللجنة إبسيلون',       'Committee (synthetic)',     'ACTIVE',  'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000008', 'grc.director@example.test',   'GRC Director Zeta',        'مدير الحوكمة زيتا',        'GRC (synthetic)',           'ACTIVE',  'SECRET'),
  ('a0000000-0000-4000-8000-000000000009', 'admin@example.test',          'Platform Admin Eta',       'مدير المنصة إيتا',         'IT (synthetic)',            'ACTIVE',  'INTERNAL'),
  ('a0000000-0000-4000-8000-000000000010', 'audit@example.test',          'Internal Auditor Theta',   'المراجع الداخلي ثيتا',     'Internal Audit (synthetic)', 'ACTIVE',  'INTERNAL'),
  ('a0000000-0000-4000-8000-000000000011', 'soc@example.test',            'SOC Analyst Iota',         'محلل الأمن يوتا',          'Cybersecurity (synthetic)', 'ACTIVE',  'INTERNAL'),
  ('a0000000-0000-4000-8000-000000000012', 'dpo@example.test',            'Privacy Officer Kappa',    'مسؤول الخصوصية كابا',      'Privacy (synthetic)',       'ACTIVE',  'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000013', 'revoked@example.test',        'Former Investigator Lambda','المحقق السابق لامدا',     'Investigations (synthetic)', 'REVOKED', 'CONFIDENTIAL'),
  -- Second identity-reveal holder so dual control (requester ≠ approver) can be demonstrated.
  ('a0000000-0000-4000-8000-000000000014', 'grc.deputy@example.test',     'GRC Deputy Mu',            'نائب مدير الحوكمة مو',     'GRC (synthetic)',           'ACTIVE',  'SECRET'),
  -- Committee secretary and chair so the form lifecycle (prepare → review → approve) can be demonstrated (Phase 8).
  ('a0000000-0000-4000-8000-000000000015', 'committee.secretary@example.test', 'Committee Secretary Nu', 'أمين سر اللجنة نو',     'Committee (synthetic)',     'ACTIVE',  'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000016', 'committee.chair@example.test', 'Committee Chair Xi',       'رئيس اللجنة كسي',          'Committee (synthetic)',     'ACTIVE',  'CONFIDENTIAL');

insert into iam.user_role_assignment (user_id, role_code, justification, source_reference, status, revoked_at, revocation_reason) values
  ('a0000000-0000-4000-8000-000000000001', 'INTAKE_OFFICER',     'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000002', 'TRIAGE_OFFICER',     'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000003', 'CASE_MANAGER',       'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000004', 'INVESTIGATOR',       'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000005', 'INVESTIGATOR',       'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000006', 'LEAD_INVESTIGATOR',  'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000007', 'COMMITTEE_MEMBER',   'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000008', 'GRC_DIRECTOR',       'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000009', 'PLATFORM_ADMIN',     'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000010', 'INTERNAL_AUDIT',     'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000011', 'SOC_ANALYST',        'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000012', 'PRIVACY_DPO',        'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000013', 'INVESTIGATOR',       'Synthetic demo seed', 'SEED', 'REVOKED', now(), 'Synthetic: left the department'),
  ('a0000000-0000-4000-8000-000000000014', 'GRC_DIRECTOR',       'Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000015', 'COMMITTEE_SECRETARY','Synthetic demo seed', 'SEED', 'ACTIVE', null, null),
  ('a0000000-0000-4000-8000-000000000016', 'COMMITTEE_CHAIR',    'Synthetic demo seed', 'SEED', 'ACTIVE', null, null);
