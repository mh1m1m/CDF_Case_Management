-- =============================================================================
-- 1330 Records freeze for case-linked modules (Phase 11, batch 4 of the CDF-80 merge train)
-- Requirements: CDF-REC-005; ADR-013 D5; ADR-011 F-2; RECORDS_RETENTION §4
--
-- Forms (1100) and interviews (1200) already require an ACTIVE case to start, save, prepare, withdraw,
-- plan, conduct, review and approve interviews. Form review and approval did not: a prepared or reviewed
-- form on an archived case could still be finalised after the record was frozen. Both predicates now use
-- the shared records.case_content_writable() contract. Reads are unchanged (case access still decides).
-- =============================================================================

create or replace function authz.can_review_form(p_instance_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from forms.form_instance i join forms.form_definition d on d.code = i.form_code
    where i.id = p_instance_id
      and d.review_required
      and authz.can_view_form_instance(i.id)
      and authz.has_permission('FORM_REVIEW')
      and authz.form_entitled(i.form_code, 'REVIEW')
      and records.case_content_writable(i.case_id)
  );
$$;

create or replace function authz.can_approve_form(p_instance_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from forms.form_instance i join forms.form_definition d on d.code = i.form_code
    where i.id = p_instance_id
      and d.approval_required
      and authz.can_view_form_instance(i.id)
      and authz.has_permission('FORM_APPROVE')
      and authz.form_entitled(i.form_code, 'APPROVE')
      and records.case_content_writable(i.case_id)
  );
$$;
