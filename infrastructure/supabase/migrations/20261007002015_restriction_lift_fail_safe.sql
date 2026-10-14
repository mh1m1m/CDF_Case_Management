-- =============================================================================
-- 2015 Restricted status cannot be lifted by a reclassification (CDF-206; ambiguity register AMB-234, T-AMB-145)
-- Requirements: §18, §19, §21, §87; owner decision DEC-01 (ADR-016 D1); ambiguity register DEC-AMB-012 (open)
--
-- api.change_case_classification (migration 0700) wrote is_restricted = coalesce(p_is_restricted, false). Only
-- restricting needed RESTRICTED_CASE_GRANT, so:
--   * any CLASSIFICATION_CHANGE holder with access to a restricted case (a Case Manager staffed on it, who holds no
--     RESTRICTED_CASE_GRANT) lifted the restriction by passing false;
--   * any reclassification that passed null lifted it silently.
-- Either way every CASE_VIEW_ALL holder could then see the case, which defeats DEC-01. Who may lift a restriction,
-- and how, is not decided (DEC-AMB-012), so the fail-safe is that nobody can.
--
-- This migration re-creates the function with two changes, everything else as in 0700:
--   * null keeps the case's current restricted status;
--   * true -> false is refused with CONFLICT:RESTRICTION_LIFT_NOT_DECIDED, for every caller, until DEC-AMB-012 is
--     answered and a migration implements its rule.
--
-- Controls:
--   * Additive and a security tightening: one command body narrowed. Signature, SECURITY DEFINER, search_path, owner
--     and grants are unchanged (create or replace keeps them). No table, policy or data change.
--   * Restricting a case and changing the level of a case keep their behaviour and audit events.
-- =============================================================================

create or replace function api.change_case_classification(
  p_case_id uuid, p_classification core.classification_level, p_is_restricted boolean, p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_reason text;
  v_grant uuid;
  v_restricted boolean;
begin
  if not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('CLASSIFICATION_CHANGE') then perform api._fail('FORBIDDEN'); end if;
  if p_classification is null or p_classification > authz.current_clearance() then perform api._fail('INVALID', 'classification'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  -- Null keeps the current status; lifting a restriction is not decided (DEC-AMB-012), so nobody may do it (CDF-206).
  v_restricted := coalesce(p_is_restricted, v_case.is_restricted);
  if v_case.is_restricted and not v_restricted then
    perform api._fail('CONFLICT', 'RESTRICTION_LIFT_NOT_DECIDED');
  end if;
  -- Restricting a case removes CASE_VIEW_ALL visibility, so only holders of RESTRICTED_CASE_GRANT may do it.
  if v_restricted and not v_case.is_restricted and not authz.has_permission('RESTRICTED_CASE_GRANT') then
    perform api._fail('FORBIDDEN');
  end if;
  update case_mgmt.case_record
     set classification = p_classification, is_restricted = v_restricted,
         updated_at = now(), updated_by = v_actor, row_version = row_version + 1
   where id = p_case_id;
  perform audit.record_event('CLASSIFICATION_CHANGED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_record', p_case_id::text, v_reason,
    jsonb_build_object('from', v_case.classification, 'to', p_classification,
                       'restricted_from', v_case.is_restricted, 'restricted_to', v_restricted));
  -- The restricting officer keeps access through an explicit, audited grant rather than by role.
  if v_restricted and not v_case.is_restricted
     and not authz.has_active_assignment(p_case_id, v_actor) and not authz.has_active_grant(p_case_id, v_actor) then
    insert into case_mgmt.case_access_grant (case_id, user_id, scope, reason, granted_by)
    values (p_case_id, v_actor, 'CASE', 'Restricted case: restricting officer', v_actor)
    returning id into v_grant;
    perform audit.record_event('CASE_ACCESS_GRANTED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_access_grant', v_grant::text,
      'Restricted case: restricting officer', jsonb_build_object('user_id', v_actor, 'scope', 'CASE'));
  end if;
end;
$$;
