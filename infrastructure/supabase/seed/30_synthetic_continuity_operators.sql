-- =============================================================================
-- SYNTHETIC CONTINUITY-WORKBOOK OPERATORS (§2; migration 2040, owner decision DEC-F30).
-- The registry is empty in the migration (fail closed). For the demo, the platform administrator has authorized the
-- synthetic case manager, the demo importer of the continuity workbook. Fictitious reference; no real authorization.
-- =============================================================================

insert into exchange.bcp_continuity_operator (user_id, authorization_reference, reason, authorized_by) values
  ('a0000000-0000-4000-8000-000000000003', 'BCP-AUTH-DEMO-0001',
   'Synthetic demo seed: authorized continuity-workbook operator.', 'a0000000-0000-4000-8000-000000000009');
