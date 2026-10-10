-- =============================================================================
-- 1320 Records guards on case-linked tables (Phase 11; security review of PR #14)
-- Requirements: CDF-REC-005; ADR-013 D5; Linear CDF-74, CDF-75
--
-- CDF-75: the no-delete/no-truncate guard of 1300 covered case_record only. Every table holding part of
-- a case record (report, messages, triage, allegations, people, assignments, grants, conflicts, workflow
-- history, identity vault) now rejects DELETE and TRUNCATE for every role, the owner included.
-- Application roles never had DELETE grants; this is defense in depth against owner-level paths.
--
-- CDF-74: from ARCHIVED on, a case gains no new assignment, access grant or identity-reveal request.
-- Ending an assignment or revoking a grant (which only reduces access) stays possible.
-- =============================================================================

do $$
declare t text;
begin
  foreach t in array array['intake.report', 'intake.report_message', 'intake.report_triage',
                           'case_mgmt.allegation', 'case_mgmt.person', 'case_mgmt.case_person',
                           'case_mgmt.case_assignment', 'case_mgmt.case_access_grant', 'case_mgmt.conflict_check',
                           'workflow.workflow_instance', 'workflow.workflow_transition_event',
                           'protected_identity.reporter_identity', 'protected_identity.reveal_request'] loop
    execute format('create trigger protect_no_delete before delete on %s for each row execute function records.reject_mutation()', t);
    execute format('create trigger protect_no_truncate before truncate on %s for each statement execute function records.reject_mutation()', t);
  end loop;
end;
$$;

create function records.reject_access_after_archive()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from case_mgmt.case_record c
             where c.id = new.case_id and c.records_state not in ('ACTIVE', 'CLOSED')) then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CDF_CONFLICT:RECORDS_READ_ONLY';
  end if;
  return new;
end;
$$;

create trigger case_assignment_records_guard before insert on case_mgmt.case_assignment
  for each row execute function records.reject_access_after_archive();
create trigger case_access_grant_records_guard before insert on case_mgmt.case_access_grant
  for each row execute function records.reject_access_after_archive();
create trigger reveal_request_records_guard before insert on protected_identity.reveal_request
  for each row execute function records.reject_access_after_archive();
