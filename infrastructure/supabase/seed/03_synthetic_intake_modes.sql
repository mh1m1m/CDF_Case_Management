-- =============================================================================
-- SYNTHETIC INTAKE REPORTS FOR THE CDF-63 FIELD SET (§2): one email-only report and one
-- report with an "Other" relationship and violation type, left in the intake queue.
-- Built through public_api.submit_report like the portal. Secrets are unusable on purpose.
-- =============================================================================
do $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform public_api.submit_report('WB-SEED00000007',
    encode(sha256(convert_to('unusable-seed-secret:WB-SEED00000007', 'UTF8')), 'hex'),
    'EMAIL_ONLY', 'SUPPLIER', null, 'IRREGULAR_TRANSACTIONS', null, 'Procurement Officer Delta (synthetic)',
    'SYNTHETIC: Purchase orders for Project Sigma were allegedly split to stay under the approval threshold.',
    current_date - 12, time '14:15', 'Procurement department (synthetic)', true, 'ar',
    jsonb_build_object('email', 'reporter.delta@example.test'));
  perform public_api.submit_report('WB-SEED00000008',
    encode(sha256(convert_to('unusable-seed-secret:WB-SEED00000008', 'UTF8')), 'hex'),
    'ANONYMOUS', 'OTHER', 'Volunteer at a Fund-sponsored event (synthetic)', 'OTHER',
    'Misuse of event sponsorship materials (synthetic)', 'Event Coordinator Epsilon (synthetic)',
    'SYNTHETIC: Sponsored event materials were allegedly resold after the festival closed.',
    current_date - 5, time '20:00', 'Festival venue (synthetic)', false, 'en', null);
end;
$$;
