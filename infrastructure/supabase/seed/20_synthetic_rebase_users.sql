-- =============================================================================
-- SYNTHETIC USERS AND SECTORS FOR DIRECT REFERRAL AND PRELIMINARY REVIEW (§2; migration 1880).
-- Every identity is fictitious and uses the reserved .test domain. Two synthetic sectors: Operations holds a
-- preparer, a head and a second member who can be named as the head's delegate; Finance holds one outsider.
-- =============================================================================

insert into iam.user_profile (id, email, display_name, display_name_ar, department, status, clearance) values
  ('a0000000-0000-4000-8000-000000000023', 'employee.rho@example.test',   'Employee Rho',                   'الموظف رو',                    'Operations (synthetic)', 'ACTIVE', 'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000024', 'sector.head@example.test',    'Sector Head Sigma',              'رئيس القطاع سيجما',            'Operations (synthetic)', 'ACTIVE', 'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000025', 'employee.phi@example.test',   'Employee Phi',                   'الموظف فاي',                   'Operations (synthetic)', 'ACTIVE', 'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000026', 'compliance.mgr@example.test', 'Compliance Section Manager Tau', 'مدير قسم الامتثال تاو',        'GRC (synthetic)',        'ACTIVE', 'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000027', 'grc.sector.head@example.test','GRC Sector Head Upsilon',        'رئيس قطاع الحوكمة أبسيلون',    'GRC (synthetic)',        'ACTIVE', 'SECRET'),
  ('a0000000-0000-4000-8000-000000000028', 'employee.chi@example.test',   'Employee Chi',                   'الموظف كاي',                   'Finance (synthetic)',    'ACTIVE', 'CONFIDENTIAL');

insert into iam.user_role_assignment (user_id, role_code, justification, source_reference) values
  ('a0000000-0000-4000-8000-000000000023', 'REFERRER',                   'Synthetic demo seed', 'SEED'),
  ('a0000000-0000-4000-8000-000000000024', 'SECTOR_HEAD',                'Synthetic demo seed', 'SEED'),
  ('a0000000-0000-4000-8000-000000000025', 'REFERRER',                   'Synthetic demo seed', 'SEED'),
  ('a0000000-0000-4000-8000-000000000026', 'COMPLIANCE_SECTION_MANAGER', 'Synthetic demo seed', 'SEED'),
  ('a0000000-0000-4000-8000-000000000027', 'GRC_SECTOR_HEAD',            'Synthetic demo seed', 'SEED'),
  ('a0000000-0000-4000-8000-000000000028', 'REFERRER',                   'Synthetic demo seed', 'SEED');

insert into iam.sector (id, code, name_en, name_ar) values
  ('b0000000-0000-4000-8000-000000000001', 'OPS', 'Operations Sector (synthetic)', 'قطاع العمليات (تجريبي)'),
  ('b0000000-0000-4000-8000-000000000002', 'FIN', 'Finance Sector (synthetic)',    'قطاع المالية (تجريبي)');

insert into iam.sector_membership (sector_id, user_id, position, effective_from, appointment_reference) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000023', 'MEMBER', '2026-01-01', 'SEED-DEMO'),
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000024', 'HEAD',   '2026-01-01', 'SEED-DEMO'),
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000025', 'MEMBER', '2026-01-01', 'SEED-DEMO'),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000028', 'MEMBER', '2026-01-01', 'SEED-DEMO');
