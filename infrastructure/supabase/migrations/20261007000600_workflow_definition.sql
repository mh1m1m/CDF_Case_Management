-- =============================================================================
-- 0600 Workflow definition CDF_CASE_V1 (§31, §32; ADR-007)
-- The 15 baseline states are fixed by the protocol. Transitions whose guards belong to later
-- phases ship disabled (is_enabled = false) so they cannot be used before their controls exist.
-- TypeScript mirror: packages/workflow/src/definition.ts (equality asserted by tests).
-- =============================================================================

insert into workflow.workflow_definition (code, name_en, name_ar, version)
values ('CDF_CASE_V1', 'CDF case lifecycle', 'دورة حياة القضية', 1);

insert into workflow.workflow_state (workflow_code, code, name_en, name_ar, sequence, is_initial, is_terminal, records_state) values
  ('CDF_CASE_V1', 'REFERRAL',               'Referral',               'الإحالة',                 10,  true,  false, 'ACTIVE'),
  ('CDF_CASE_V1', 'REGISTERED',             'Registered',             'مسجلة',                   20,  false, false, 'ACTIVE'),
  ('CDF_CASE_V1', 'SCREENING',              'Screening',              'الفحص الأولي',            30,  false, false, 'ACTIVE'),
  ('CDF_CASE_V1', 'CONFLICT_CHECK',         'Conflict check',         'فحص تعارض المصالح',       40,  false, false, 'ACTIVE'),
  ('CDF_CASE_V1', 'TRIAGE',                 'Triage',                 'الفرز',                   50,  false, false, 'ACTIVE'),
  ('CDF_CASE_V1', 'JURISDICTION',           'Jurisdiction',           'تحديد الاختصاص',          60,  false, false, 'ACTIVE'),
  ('CDF_CASE_V1', 'INVESTIGATION_APPROVAL', 'Investigation approval', 'اعتماد التحقيق',          70,  false, false, 'ACTIVE'),
  ('CDF_CASE_V1', 'INVESTIGATION',          'Investigation',          'التحقيق',                 80,  false, false, 'ACTIVE'),
  ('CDF_CASE_V1', 'FINDINGS',               'Findings',               'النتائج',                 90,  false, false, 'ACTIVE'),
  ('CDF_CASE_V1', 'GRC_LEGAL_REVIEW',       'GRC / legal review',     'مراجعة الحوكمة والقانونية', 100, false, false, 'ACTIVE'),
  ('CDF_CASE_V1', 'COMMITTEE',              'Committee',              'اللجنة',                  110, false, false, 'ACTIVE'),
  ('CDF_CASE_V1', 'DECISION',               'Decision',               'القرار',                  120, false, false, 'ACTIVE'),
  ('CDF_CASE_V1', 'CORRECTIVE_ACTION',      'Corrective action',      'الإجراءات التصحيحية',      130, false, false, 'ACTIVE'),
  ('CDF_CASE_V1', 'CLOSURE',                'Closure',                'الإغلاق',                 140, false, false, 'CLOSED'),
  ('CDF_CASE_V1', 'ARCHIVE',                'Archive',                'الأرشيف',                 150, false, true,  'ARCHIVED');

insert into workflow.workflow_transition_definition
  (workflow_code, code, from_state, to_state, name_en, name_ar, required_permission, reason_required,
   approval_required, required_conditions, sla_hours, is_system, is_enabled, enabled_in_phase) values
  ('CDF_CASE_V1', 'REGISTER',               'REFERRAL',               'REGISTERED',             'Register case',               'تسجيل القضية',          'CASE_CREATE',           false, false, '{}', null, true,  true,  4),
  ('CDF_CASE_V1', 'START_SCREENING',        'REGISTERED',             'SCREENING',              'Start screening',             'بدء الفحص الأولي',       'WORKFLOW_SCREEN',       false, false, '{}', 48,   false, true,  6),
  ('CDF_CASE_V1', 'COMPLETE_SCREENING',     'SCREENING',              'CONFLICT_CHECK',         'Complete screening',          'إكمال الفحص الأولي',     'WORKFLOW_SCREEN',       false, false, '{ALLEGATION_RECORDED}', 72, false, true, 6),
  ('CDF_CASE_V1', 'SCREEN_OUT',             'SCREENING',              'CLOSURE',                'Close at screening',          'إغلاق في مرحلة الفحص',   'WORKFLOW_ADVANCE',      true,  false, '{}', null, false, true,  6),
  ('CDF_CASE_V1', 'CLEAR_CONFLICT_CHECK',   'CONFLICT_CHECK',         'TRIAGE',                 'Conflict check cleared',      'اجتياز فحص التعارض',      'WORKFLOW_ADVANCE',      false, false, '{ACTOR_NO_CONFLICT_DECLARED,NO_UNRESOLVED_CONFLICTS}', 48, false, true, 6),
  ('CDF_CASE_V1', 'COMPLETE_TRIAGE',        'TRIAGE',                 'JURISDICTION',           'Complete triage',             'إكمال الفرز',            'WORKFLOW_ADVANCE',      false, false, '{PRIORITY_SET}', 72, false, true, 6),
  ('CDF_CASE_V1', 'CONFIRM_JURISDICTION',   'JURISDICTION',           'INVESTIGATION_APPROVAL', 'Confirm jurisdiction',        'تأكيد الاختصاص',         'WORKFLOW_ADVANCE',      true,  false, '{}', 72,   false, true,  6),
  ('CDF_CASE_V1', 'OUT_OF_JURISDICTION',    'JURISDICTION',           'CLOSURE',                'Out of jurisdiction',         'خارج الاختصاص',          'WORKFLOW_ADVANCE',      true,  false, '{}', null, false, true,  6),
  ('CDF_CASE_V1', 'APPROVE_INVESTIGATION',  'INVESTIGATION_APPROVAL', 'INVESTIGATION',          'Approve investigation',       'اعتماد فتح التحقيق',      'INVESTIGATION_APPROVE', true,  true,  '{INVESTIGATOR_ASSIGNED,ASSIGNEES_CONFLICT_CLEARED,NO_UNRESOLVED_CONFLICTS}', 48, false, true, 6),
  ('CDF_CASE_V1', 'REJECT_INVESTIGATION',   'INVESTIGATION_APPROVAL', 'JURISDICTION',           'Return to jurisdiction',      'إعادة لتحديد الاختصاص',   'INVESTIGATION_APPROVE', true,  false, '{}', null, false, true,  6),
  ('CDF_CASE_V1', 'SUBMIT_FINDINGS',        'INVESTIGATION',          'FINDINGS',               'Submit findings',             'تقديم النتائج',          'WORKFLOW_ADVANCE',      false, false, '{}', null, false, false, 9),
  ('CDF_CASE_V1', 'SUBMIT_FOR_REVIEW',      'FINDINGS',               'GRC_LEGAL_REVIEW',       'Submit for GRC/legal review', 'إحالة للمراجعة',          'WORKFLOW_ADVANCE',      false, true,  '{}', null, false, false, 9),
  ('CDF_CASE_V1', 'RETURN_TO_INVESTIGATION','GRC_LEGAL_REVIEW',       'INVESTIGATION',          'Return to investigation',     'إعادة للتحقيق',          'WORKFLOW_ADVANCE',      true,  false, '{}', null, false, false, 9),
  ('CDF_CASE_V1', 'REFER_TO_COMMITTEE',     'GRC_LEGAL_REVIEW',       'COMMITTEE',              'Refer to committee',          'إحالة للجنة',            'WORKFLOW_ADVANCE',      false, true,  '{}', null, false, false, 9),
  ('CDF_CASE_V1', 'CONCLUDE_COMMITTEE',     'COMMITTEE',              'DECISION',               'Committee concluded',         'انتهاء أعمال اللجنة',     'WORKFLOW_ADVANCE',      false, true,  '{}', null, false, false, 9),
  ('CDF_CASE_V1', 'REQUIRE_CORRECTIVE_ACTION','DECISION',             'CORRECTIVE_ACTION',      'Corrective action required',  'إجراءات تصحيحية مطلوبة',  'WORKFLOW_ADVANCE',      false, true,  '{}', null, false, false, 10),
  ('CDF_CASE_V1', 'CLOSE_AFTER_DECISION',   'DECISION',               'CLOSURE',                'Close after decision',        'إغلاق بعد القرار',        'WORKFLOW_ADVANCE',      true,  true,  '{}', null, false, false, 10),
  ('CDF_CASE_V1', 'COMPLETE_CORRECTIVE_ACTIONS','CORRECTIVE_ACTION',  'CLOSURE',                'Corrective actions complete', 'اكتمال الإجراءات التصحيحية','WORKFLOW_ADVANCE',     false, true,  '{}', null, false, false, 10),
  ('CDF_CASE_V1', 'ARCHIVE_CASE',           'CLOSURE',                'ARCHIVE',                'Archive case',                'أرشفة القضية',           'WORKFLOW_ADVANCE',      false, false, '{}', null, false, false, 11),
  ('CDF_CASE_V1', 'REOPEN_CASE',            'CLOSURE',                'INVESTIGATION',          'Reopen case',                 'إعادة فتح القضية',        'INVESTIGATION_APPROVE', true,  true,  '{}', null, false, false, 10);

-- -----------------------------------------------------------------------------
-- Condition evaluation. Each condition code is a named, testable guard.
-- Returns NULL when satisfied, otherwise a stable blocking-reason code.
-- -----------------------------------------------------------------------------
create function workflow.evaluate_condition(p_condition text, p_case_id uuid, p_actor uuid)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
begin
  case p_condition
    when 'ALLEGATION_RECORDED' then
      if exists (select 1 from case_mgmt.allegation a where a.case_id = p_case_id and a.status <> 'WITHDRAWN') then
        return null; end if;
      return 'NO_ALLEGATION_RECORDED';
    when 'PRIORITY_SET' then
      if exists (select 1 from case_mgmt.case_record c where c.id = p_case_id and c.priority is not null) then
        return null; end if;
      return 'PRIORITY_NOT_SET';
    when 'ACTOR_NO_CONFLICT_DECLARED' then
      if exists (select 1 from case_mgmt.conflict_check k
                 where k.case_id = p_case_id and k.user_id = p_actor and k.is_current
                   and k.status in ('NO_CONFLICT', 'CONFLICT_CLEARED')) then
        return null; end if;
      return 'ACTOR_CONFLICT_DECLARATION_MISSING';
    when 'NO_UNRESOLVED_CONFLICTS' then
      if not exists (select 1 from case_mgmt.conflict_check k
                     where k.case_id = p_case_id and k.is_current and k.status = 'CONFLICT_DECLARED') then
        return null; end if;
      return 'UNRESOLVED_CONFLICT_DECLARATION';
    when 'INVESTIGATOR_ASSIGNED' then
      if exists (select 1 from case_mgmt.case_assignment a
                 where a.case_id = p_case_id and a.status = 'ACTIVE'
                   and a.assignment_role in ('LEAD_INVESTIGATOR', 'INVESTIGATOR')) then
        return null; end if;
      return 'NO_INVESTIGATOR_ASSIGNED';
    when 'ASSIGNEES_CONFLICT_CLEARED' then
      if not exists (
        select 1 from case_mgmt.case_assignment a
        where a.case_id = p_case_id and a.status = 'ACTIVE'
          and a.assignment_role in ('LEAD_INVESTIGATOR', 'INVESTIGATOR')
          and not exists (select 1 from case_mgmt.conflict_check k
                          where k.case_id = a.case_id and k.user_id = a.user_id and k.is_current
                            and k.status in ('NO_CONFLICT', 'CONFLICT_CLEARED'))) then
        return null; end if;
      return 'ASSIGNEE_CONFLICT_DECLARATION_MISSING';
    else
      -- Unknown condition codes block: a typo can never silently open a transition.
      return 'UNKNOWN_CONDITION:' || p_condition;
  end case;
end;
$$;

-- Lists transitions out of the current state with whether the current user may perform them
-- and, if not, why. Returns nothing for cases the caller cannot view.
create function api.available_transitions(p_case_id uuid)
returns table (
  code text, to_state text, name_en text, name_ar text, reason_required boolean,
  is_enabled boolean, enabled_in_phase int, allowed boolean, blocking_reasons text[]
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_actor uuid := authz.current_user_id();
  v_inst workflow.workflow_instance;
  t workflow.workflow_transition_definition;
  v_reasons text[];
  v_r text;
  c text;
begin
  if v_actor is null or not authz.can_view_case(p_case_id) then
    return;
  end if;
  select * into v_inst from workflow.workflow_instance i where i.case_id = p_case_id;
  for t in
    select * from workflow.workflow_transition_definition d
    where d.workflow_code = v_inst.workflow_code and d.from_state = v_inst.current_state and not d.is_system
    order by d.code
  loop
    v_reasons := '{}';
    if not t.is_enabled then v_reasons := v_reasons || 'NOT_YET_AVAILABLE'::text; end if;
    if not authz.has_permission(t.required_permission) then v_reasons := v_reasons || 'MISSING_PERMISSION'::text; end if;
    if t.approval_required and authz.has_active_assignment(p_case_id, v_actor, array['LEAD_INVESTIGATOR', 'INVESTIGATOR']) then
      v_reasons := v_reasons || 'SEPARATION_OF_DUTIES'::text;
    end if;
    foreach c in array t.required_conditions loop
      v_r := workflow.evaluate_condition(c, p_case_id, v_actor);
      if v_r is not null then v_reasons := v_reasons || v_r; end if;
    end loop;
    code := t.code; to_state := t.to_state; name_en := t.name_en; name_ar := t.name_ar;
    reason_required := t.reason_required; is_enabled := t.is_enabled; enabled_in_phase := t.enabled_in_phase;
    allowed := cardinality(v_reasons) = 0; blocking_reasons := v_reasons;
    return next;
  end loop;
end;
$$;
grant execute on function api.available_transitions(uuid) to authenticated;
