-- =============================================================================
-- SYNTHETIC DEMO COMMITTEE SEATS (§2; migrations 1870 and 2030 section 4). Every identity is fictitious and uses the
-- reserved .test domain. The Investigation Committee gets a chair, a deputy chair, a secretary and two members; the
-- Grievance Committee a chair and a secretary, so a demo can refer a case, schedule a meeting, vote and file a
-- grievance without first appointing anyone.
--
-- Design. The seats are on the real IC and GC, held by demo-only users who are not in tests/support/db.ts USERS.
-- Separate DEMO committees are not possible: committee.committee holds one row per kind (kind is unique, ADR-018,
-- "permanent committees"), and the domain finds the Grievance Committee by its kind. The security tests expect IC and
-- GC to start unseated; their fixtures (tests/support/committee.ts unseatDemoSeats) end these seats inside each test's
-- own transaction, through api.end_committee_membership, before seating the test users, and the transaction rolls
-- back. Nothing here is visible to a test once that has run.
--
-- Idempotent and insert-only, so the hosted DEV top-up (.github/workflows/hosted-dev.yml) can run it again: users and
-- role assignments are added only when missing, and a seat is appointed only when its appointment reference is new
-- and nobody else holds that seat from 2026-01-01. Seats are appointed through api.appoint_committee_member as the
-- synthetic platform administrator, so they carry their audit event and notification like any appointment.
-- =============================================================================

insert into iam.user_profile (id, email, display_name, display_name_ar, department, status, clearance) values
  ('a0000000-0000-4000-8000-000000000101', 'ic.chair@example.test',     'Investigation Committee Chair Psi (demo)',          'رئيس لجنة التحقيق بساي (تجريبي)',        'Committee (synthetic)', 'ACTIVE', 'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000102', 'ic.deputy@example.test',    'Investigation Committee Deputy Chair Omega (demo)', 'نائب رئيس لجنة التحقيق أوميغا (تجريبي)', 'Committee (synthetic)', 'ACTIVE', 'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000103', 'ic.secretary@example.test', 'Investigation Committee Secretary Alpha (demo)',    'أمين سر لجنة التحقيق ألفا (تجريبي)',     'Committee (synthetic)', 'ACTIVE', 'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000104', 'ic.member.a@example.test',  'Investigation Committee Member Beta (demo)',        'عضو لجنة التحقيق بيتا (تجريبي)',         'Committee (synthetic)', 'ACTIVE', 'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000105', 'ic.member.b@example.test',  'Investigation Committee Member Gamma (demo)',       'عضو لجنة التحقيق جاما (تجريبي)',         'Committee (synthetic)', 'ACTIVE', 'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000106', 'gc.chair@example.test',     'Grievance Committee Chair Delta (demo)',            'رئيس لجنة التظلمات دلتا (تجريبي)',       'Committee (synthetic)', 'ACTIVE', 'CONFIDENTIAL'),
  ('a0000000-0000-4000-8000-000000000107', 'gc.secretary@example.test', 'Grievance Committee Secretary Epsilon (demo)',      'أمين سر لجنة التظلمات إبسيلون (تجريبي)', 'Committee (synthetic)', 'ACTIVE', 'CONFIDENTIAL')
on conflict (id) do nothing;

insert into iam.user_role_assignment (user_id, role_code, justification, source_reference)
select v.user_id::uuid, v.role_code, 'Synthetic demo seed', 'SEED'
from (values
  ('a0000000-0000-4000-8000-000000000101', 'COMMITTEE_CHAIR'),
  ('a0000000-0000-4000-8000-000000000102', 'COMMITTEE_MEMBER'),
  ('a0000000-0000-4000-8000-000000000103', 'COMMITTEE_SECRETARY'),
  ('a0000000-0000-4000-8000-000000000104', 'COMMITTEE_MEMBER'),
  ('a0000000-0000-4000-8000-000000000105', 'COMMITTEE_MEMBER'),
  ('a0000000-0000-4000-8000-000000000106', 'COMMITTEE_CHAIR'),
  ('a0000000-0000-4000-8000-000000000107', 'COMMITTEE_SECRETARY')) v (user_id, role_code)
where not exists (select 1 from iam.user_role_assignment a
                  where a.user_id = v.user_id::uuid and a.role_code = v.role_code);

do $$
declare
  r record;
  v_committee uuid;
  v_from constant timestamptz := '2026-01-01T00:00:00Z';
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', (select u.id from iam.user_profile u where u.email = 'admin@example.test'),
                      'role', 'authenticated')::text, true);
  for r in select * from (values
      ('IC', 'a0000000-0000-4000-8000-000000000101'::uuid, 'CHAIR',        'SEED-DEMO-COMMITTEE-IC-CHAIR'),
      ('IC', 'a0000000-0000-4000-8000-000000000102'::uuid, 'DEPUTY_CHAIR', 'SEED-DEMO-COMMITTEE-IC-DEPUTY-CHAIR'),
      ('IC', 'a0000000-0000-4000-8000-000000000103'::uuid, 'SECRETARY',    'SEED-DEMO-COMMITTEE-IC-SECRETARY'),
      ('IC', 'a0000000-0000-4000-8000-000000000104'::uuid, 'MEMBER',       'SEED-DEMO-COMMITTEE-IC-MEMBER-A'),
      ('IC', 'a0000000-0000-4000-8000-000000000105'::uuid, 'MEMBER',       'SEED-DEMO-COMMITTEE-IC-MEMBER-B'),
      ('GC', 'a0000000-0000-4000-8000-000000000106'::uuid, 'CHAIR',        'SEED-DEMO-COMMITTEE-GC-CHAIR'),
      ('GC', 'a0000000-0000-4000-8000-000000000107'::uuid, 'SECRETARY',    'SEED-DEMO-COMMITTEE-GC-SECRETARY')
    ) s (code, user_id, seat, reference) loop
    select c.id into v_committee from committee.committee c where c.code = r.code;
    continue when exists (select 1 from committee.membership m where m.appointment_reference = r.reference);
    -- Insert only: a seat someone already holds from the demo start date is left as it is.
    if exists (select 1 from committee.membership m
               where m.committee_id = v_committee
                 and (m.user_id = r.user_id
                      or (r.seat in ('CHAIR', 'DEPUTY_CHAIR', 'SECRETARY', 'ALTERNATE_SECRETARY') and m.seat = r.seat))
                 and (m.effective_to is null or m.effective_to > v_from)) then
      raise notice 'demo seat % on % not added: already held', r.seat, r.code;
      continue;
    end if;
    perform api.appoint_committee_member(v_committee, r.user_id, r.seat, v_from, null, r.reference);
  end loop;
  perform set_config('request.jwt.claims', '', true);
end;
$$;
