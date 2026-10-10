-- =============================================================================
-- SYNTHETIC DEMO INTERVIEWS (§2, CDF-60). Built only through the api.* interview commands, acting as
-- the synthetic users, so the seed exercises the same authorization, lifecycle and audit paths as the
-- application and leaves a valid audit hash chain. Every name and statement here is fictitious.
-- =============================================================================

-- "or replace": the Supabase CLI runs all seed files in one session, where 02 already defined it.
create or replace function pg_temp.act_as(p_email text)
returns void
language sql
as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from iam.user_profile where email = p_email), 'role', 'authenticated')::text, true);
$$;

do $$
declare
  c_a uuid := (select id from case_mgmt.case_record where case_number like 'CDF-DEMO-%-0001');
  c_b uuid := (select id from case_mgmt.case_record where case_number like 'CDF-DEMO-%-0002');
  i1 uuid; i2 uuid; i3 uuid;
  v_ver uuid; v_sha text;
begin
  -- Case A, INT-001: a witness interview carried through to APPROVED --------------------------------
  -- Investigator A prepares, the lead investigator reviews, the case manager approves (three people).
  perform pg_temp.act_as('investigator.a@example.test');
  i1 := api.plan_interview(c_a, 'Witness interview: invoice approvals (synthetic)',
    'Synthetic: establish how duplicate invoices from Vendor Omega were approved.',
    'WITNESS', 'Witness Gamma (synthetic)', null, 'CONFIDENTIAL');
  perform api.schedule_interview(i1, now() - interval '3 hours', 60, 'IN_PERSON', 'Meeting room 2 (synthetic)');
  perform api.issue_interview_notice(i1, 'INVITATION', 'INTERNAL_EMAIL');
  perform api.record_interview_rights(i1, 'SIGNED_FORM', 'SYNTHETIC-RIGHTS-V1');
  perform api.record_interview_conducted(i1, now() - interval '3 hours', now() - interval '2 hours');
  select o_version_id, o_sha256 into v_ver, v_sha from api.record_interview_statement(i1,
    'SYNTHETIC STATEMENT. Witness Gamma states that invoices from Vendor Omega were approved in two batches '
    || 'in the same week and that the approval queue showed no duplicate warning. Witness Gamma has no further '
    || 'documents. All content is fictional.', 'en');
  perform api.acknowledge_interview_statement(v_ver, 'SIGNED_PAPER', v_sha);
  perform api.transition_interview(i1, 'PREPARE');
  perform pg_temp.act_as('lead@example.test');
  perform api.transition_interview(i1, 'REVIEW');
  perform pg_temp.act_as('casemanager@example.test');
  perform api.transition_interview(i1, 'APPROVE');

  -- Case A, INT-002: subject interview, planned only -----------------------------------------------
  perform pg_temp.act_as('investigator.a@example.test');
  i2 := api.plan_interview(c_a, 'Subject interview (synthetic)',
    'Synthetic: give Employee Alpha the opportunity to respond.', 'SUBJECT', 'Employee Alpha (synthetic)', null, 'CONFIDENTIAL');
  perform api.add_interview_participant(i2, 'a0000000-0000-4000-8000-000000000006', 'INTERVIEWER');

  -- Case B, INT-001: the (identified) reporter, by reference only, scheduled through the portal -----
  perform pg_temp.act_as('investigator.b@example.test');
  i3 := api.plan_interview(c_b, 'Reporter follow-up interview (synthetic)',
    'Synthetic: clarify the tender scoring timeline.', 'REPORTER', null, null, 'RESTRICTED');
  perform api.schedule_interview(i3, now() + interval '7 days', 45, 'REMOTE_VIDEO', null);
  perform api.issue_interview_notice(i3, 'INVITATION', 'PORTAL_MESSAGE');

  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- The seed must leave a valid audit chain.
do $$
begin
  if exists (select 1 from audit.verify_chain()) then
    raise exception 'interview seed produced a broken audit chain';
  end if;
end;
$$;
