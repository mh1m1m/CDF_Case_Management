-- =============================================================================
-- SYNTHETIC CONTINUITY-WORKBOOK OPERATORS (§2; migration 2040, owner decision DEC-F30).
-- The registry is empty in the migration (fail closed). For the demo, the platform administrator has authorized the
-- synthetic case manager, the demo importer of the continuity workbook. Fictitious reference; no real authorization.
-- Idempotent and insert-only, like 30_synthetic_committee_seats.sql: the row is added only while no row carries its
-- reference, so a later run (the hosted-dev top-up) neither duplicates it nor undoes a revocation made on DEV.
-- =============================================================================

insert into exchange.bcp_continuity_operator (user_id, authorization_reference, reason, authorized_by)
select 'a0000000-0000-4000-8000-000000000003', 'BCP-AUTH-DEMO-0001',
       'Synthetic demo seed: authorized continuity-workbook operator.', 'a0000000-0000-4000-8000-000000000009'
where not exists (select 1 from exchange.bcp_continuity_operator where authorization_reference = 'BCP-AUTH-DEMO-0001');
