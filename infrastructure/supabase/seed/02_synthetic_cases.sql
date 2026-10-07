-- =============================================================================
-- SYNTHETIC DEMO REPORTS AND CASES (§2). Built only through the public_api and api command
-- functions, acting as the synthetic users, so the seed exercises the same authorization,
-- workflow and audit paths as the applications and leaves a valid audit hash chain.
--
-- Seed report secrets are unusable on purpose (the HMAC pepper lives only in the portal's
-- environment). Tests that need a working Report ID + secret submit their own report.
-- =============================================================================

create function pg_temp.act_as(p_email text)
returns void
language sql
as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from iam.user_profile where email = p_email), 'role', 'authenticated')::text, true);
$$;

create function pg_temp.seed_report(p_ref text, p_category text, p_description text, p_identity jsonb default null)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  -- Drive intake field set (CDF-63, migration 1500): mode follows the identity supplied.
  perform public_api.submit_report(p_ref, encode(sha256(convert_to('unusable-seed-secret:' || p_ref, 'UTF8')), 'hex'),
    case when p_identity is null then 'ANONYMOUS'
         when p_identity ?& array['given_name', 'id_number'] then 'IDENTIFIED'
         else 'EMAIL_ONLY' end,
    'EMPLOYEE', null, p_category, null, 'Synthetic subject (Employee Alpha)', p_description, current_date - 30,
    time '10:30', 'Riyadh office (synthetic)', true, 'en', p_identity);
  select id into v_id from intake.report where report_ref = p_ref;
  return v_id;
end;
$$;

do $$
declare
  r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; r6 uuid;
  c_a uuid; c_b uuid; c_exec uuid; c_conflict uuid;
  k uuid;
  u_inv_a uuid := 'a0000000-0000-4000-8000-000000000004';
  u_inv_b uuid := 'a0000000-0000-4000-8000-000000000005';
  u_lead  uuid := 'a0000000-0000-4000-8000-000000000006';
  u_cm    uuid := 'a0000000-0000-4000-8000-000000000003';
  u_grc   uuid := 'a0000000-0000-4000-8000-000000000008';
begin
  -- Reports -------------------------------------------------------------------
  r1 := pg_temp.seed_report('WB-SEED00000001', 'FINANCIAL_CORRUPTION',
    'SYNTHETIC: Employee Alpha is alleged to have approved duplicate invoices from Vendor Omega during Q2.');
  r2 := pg_temp.seed_report('WB-SEED00000002', 'IRREGULAR_TRANSACTIONS',
    'SYNTHETIC: Tender evaluation for Project Sigma allegedly favoured Vendor Tau without documented scoring.',
    jsonb_build_object('given_name', 'Reporter', 'father_name', 'Gamma', 'grandfather_name', 'Synthetic',
      'family_name', 'Example', 'gender', 'FEMALE', 'birth_date', '1990-04-15', 'birth_date_calendar', 'GREGORIAN',
      'id_type', 'NATIONAL_ID', 'id_number', '1000000001', 'city', 'RIYADH', 'nationality', 'SA',
      'phone', '+966 500000001', 'email', 'reporter.gamma@example.test', 'preferred_contact', 'EMAIL'));
  r3 := pg_temp.seed_report('WB-SEED00000003', 'ABUSE_OF_AUTHORITY',
    'SYNTHETIC: Executive Kappa allegedly holds an undisclosed interest in a grant recipient.');
  r4 := pg_temp.seed_report('WB-SEED00000004', 'POLICY_BREACH',
    'SYNTHETIC: Manager Rho allegedly retaliated against Witness Gamma after a prior complaint.');
  r5 := pg_temp.seed_report('WB-SEED00000005', 'ADMINISTRATIVE_CORRUPTION',
    'SYNTHETIC: Attendance records in Department Upsilon allegedly altered for overtime claims.');
  r6 := pg_temp.seed_report('WB-SEED00000006', 'OTHER',
    'SYNTHETIC: Unclear allegation about misuse of a pool vehicle; more detail needed.');

  -- r5 stays RECEIVED (intake queue). r6 awaits information from the reporter.
  perform pg_temp.act_as('triage@example.test');
  perform api.triage_report(r6, 'REQUEST_INFORMATION', 'Synthetic: need dates and the vehicle reference.');
  perform pg_temp.act_as('intake@example.test');
  perform api.reply_to_reporter(r6, 'Thank you. Please share the approximate dates and the vehicle reference (synthetic).');

  -- Case A (CDF-DEMO-YYYY-0001): full first slice, now in INVESTIGATION -----------------
  perform pg_temp.act_as('triage@example.test');
  perform api.triage_report(r1, 'OPEN_CASE', 'Synthetic: credible, specific and within mandate.');
  c_a := api.create_case_from_report(r1, 'Duplicate invoice approvals (synthetic)',
    'Synthetic case: possible duplicate payments to Vendor Omega.', 'CONFIDENTIAL', false);
  perform api.transition_case(c_a, 'START_SCREENING');
  perform api.transition_case(c_a, 'COMPLETE_SCREENING');

  perform pg_temp.act_as('casemanager@example.test');
  perform api.update_case_details(c_a, c.title, c.summary, 'HIGH', c.row_version) from case_mgmt.case_record c where c.id = c_a;
  perform api.declare_conflict(c_a, false, 'Synthetic: no relationship with the parties.');
  perform api.transition_case(c_a, 'CLEAR_CONFLICT_CHECK');
  perform api.transition_case(c_a, 'COMPLETE_TRIAGE');
  perform api.transition_case(c_a, 'CONFIRM_JURISDICTION', 'Synthetic: financial misconduct is within CDF mandate.');
  perform api.assign_case(c_a, u_lead, 'LEAD_INVESTIGATOR', 'Synthetic: lead for financial cases');
  perform api.assign_case(c_a, u_inv_a, 'INVESTIGATOR', 'Synthetic: available investigator');
  perform pg_temp.act_as('lead@example.test');
  perform api.declare_conflict(c_a, false, 'Synthetic: no relationship with the parties.');
  perform pg_temp.act_as('investigator.a@example.test');
  perform api.declare_conflict(c_a, false, 'Synthetic: no relationship with the parties.');
  perform pg_temp.act_as('grc.director@example.test');
  perform api.transition_case(c_a, 'APPROVE_INVESTIGATION', 'Synthetic: approved for full investigation.');

  -- Case B (0002): identified reporter, investigator B assigned, in SCREENING --------------
  perform pg_temp.act_as('triage@example.test');
  perform api.triage_report(r2, 'OPEN_CASE', 'Synthetic: specific procurement concern with named tender.');
  c_b := api.create_case_from_report(r2, 'Tender scoring irregularity (synthetic)',
    'Synthetic case: tender evaluation without documented scoring.', 'RESTRICTED', false);
  perform api.transition_case(c_b, 'START_SCREENING');
  perform pg_temp.act_as('casemanager@example.test');
  perform api.assign_case(c_b, u_inv_b, 'INVESTIGATOR', 'Synthetic: procurement experience');

  -- Restricted executive case (0003): SECRET + restricted; only GRC and explicit grants ------
  perform pg_temp.act_as('triage@example.test');
  perform api.triage_report(r3, 'OPEN_CASE', 'Synthetic: executive-level allegation, handle restricted.');
  c_exec := api.create_case_from_report(r3, 'Executive interest disclosure (synthetic)',
    'Synthetic restricted case concerning Executive Kappa.', 'CONFIDENTIAL', false);
  perform pg_temp.act_as('grc.director@example.test');
  perform api.change_case_classification(c_exec, 'SECRET', true, 'Synthetic: executive subject requires restricted handling.');
  perform api.assign_case(c_exec, u_grc, 'CASE_OWNER', 'Synthetic: GRC owns executive cases');

  -- Conflict case (0004): investigator A declares a conflict and loses access --------------
  perform pg_temp.act_as('triage@example.test');
  perform api.triage_report(r4, 'OPEN_CASE', 'Synthetic: retaliation allegation needs investigation.');
  c_conflict := api.create_case_from_report(r4, 'Retaliation allegation (synthetic)',
    'Synthetic case: alleged retaliation against Witness Gamma.', 'CONFIDENTIAL', false);
  perform pg_temp.act_as('casemanager@example.test');
  perform api.assign_case(c_conflict, u_inv_a, 'INVESTIGATOR', 'Synthetic: initial assignment');
  perform pg_temp.act_as('investigator.a@example.test');
  k := api.declare_conflict(c_conflict, true, 'Synthetic: Manager Rho is a relative.');
  perform pg_temp.act_as('casemanager@example.test');
  perform api.decide_conflict(k, 'CONFLICT_CONFIRMED', 'Synthetic: confirmed family relationship.');
  perform api.assign_case(c_conflict, u_inv_b, 'INVESTIGATOR', 'Synthetic: replacement after conflict');

  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- The seed must leave a valid audit chain.
do $$
begin
  if exists (select 1 from audit.verify_chain()) then
    raise exception 'seed produced a broken audit chain';
  end if;
end;
$$;
