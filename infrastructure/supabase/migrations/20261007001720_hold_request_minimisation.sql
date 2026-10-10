-- CDF-84 (ADR-014 D5, follows CDF-79): a legal-hold request filed through the controlled lookup must not
-- tell its requester which case it reached. The table grant let a requester read case_id (and the task and
-- hold it led to) of their own row with direct SQL. Reads now go through a definer projection that returns
-- the same rows as before but masks every case-linking identifier unless the caller may see the case's
-- minimum metadata (relationship, task, catalogue scope or break-glass). No application role keeps a direct
-- SELECT on the table; commands are unchanged.

revoke select on records.legal_hold_request from authenticated;

create function records.hold_request_rows()
returns table (
  id uuid, case_id uuid, origin text, reason_code text, justification text, status text,
  requested_by uuid, requested_at timestamptz, assigned_reviewer uuid, assigned_task_id uuid,
  assigned_by uuid, reviewed_by uuid, reviewed_at timestamptz, review_reason text, legal_hold_id uuid
)
language sql stable security definer
set search_path = ''
as $$
  select r.id,
         case when v.linked then r.case_id end,
         r.origin, r.reason_code, r.justification, r.status, r.requested_by, r.requested_at,
         r.assigned_reviewer,
         case when v.linked then r.assigned_task_id end,
         r.assigned_by, r.reviewed_by, r.reviewed_at, r.review_reason,
         case when v.linked then r.legal_hold_id end
    from records.legal_hold_request r
    cross join lateral (select authz.can_view_case_metadata(r.case_id) as linked) v
   where authz.current_user_id() is not null
     -- Row visibility is the former legal_hold_request_read policy, unchanged.
     and (r.requested_by = authz.current_user_id()
          or r.assigned_reviewer = authz.current_user_id()
          or ((authz.has_permission('CASE_TASK_ASSIGN') or authz.has_permission('LEGAL_HOLD_REVIEW'))
              and authz.can_view_case(r.case_id)));
$$;
revoke all on function records.hold_request_rows() from public;
grant execute on function records.hold_request_rows() to authenticated;

create view records.legal_hold_request_view with (security_invoker = true) as
select * from records.hold_request_rows();

comment on view records.legal_hold_request_view is
  'Legal-hold requests the caller may see (ADR-014, CDF-84): case, task and hold ids only when the caller may see the case.';
grant select on records.legal_hold_request_view to authenticated;
