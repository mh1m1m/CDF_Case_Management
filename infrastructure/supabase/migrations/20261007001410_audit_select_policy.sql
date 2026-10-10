-- CDF-67: one permissive SELECT policy on audit.audit_event instead of three (Supabase advisor
-- "multiple permissive policies"). Postgres ORs permissive policies for the same command and role, so a
-- single policy whose USING is the OR of the three former conditions admits exactly the same rows. The
-- conditions below are copied unchanged from 0300 (audit_business_read, audit_security_read) and 0500
-- (audit_case_team_read); no later migration altered them.
--
-- Unchanged: RLS stays enabled; authenticated keeps only its SELECT grant; no INSERT, UPDATE or DELETE
-- policy exists for any application role (§29, §74), and the append-only triggers still reject writes.

drop policy audit_business_read on audit.audit_event;
drop policy audit_security_read on audit.audit_event;
drop policy audit_case_team_read on audit.audit_event;

create policy audit_event_read on audit.audit_event for select to authenticated
  using (
    -- was audit_business_read: internal audit reads business and administrative history.
    (category in ('BUSINESS', 'ADMIN') and authz.has_permission('AUDIT_VIEW'))
    -- was audit_security_read: security monitoring reads security events.
    or (category = 'SECURITY' and authz.has_permission('SECURITY_EVENT_VIEW'))
    -- was audit_case_team_read: case teams see the business history of cases they can view.
    or (category = 'BUSINESS' and case_id is not null and authz.can_view_case(case_id))
  );
