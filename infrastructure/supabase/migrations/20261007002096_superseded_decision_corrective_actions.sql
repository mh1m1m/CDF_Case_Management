-- =============================================================================
-- 2096 Corrective actions under a superseded decision: read models (UX redesign Phase 12, slice P12-3b; ADR-058)
-- Requirements: Phase 12 plan §4 (P12-3) and §4.1; DEC-AMB-014 (owner, 2026-10-13, option A: the replacement decision
-- disposes of each corrective action the superseded decision governed, RE_ADOPT, MODIFY, WAIVE or
-- REPLACE_WITH_NEW_ACTION; the action is FROZEN_BY_SUPERSEDED_DECISION until then, and the case cannot close while any
-- is); DEC-AMB-013 (the re-decision of a re-voted package supersedes the earlier round's decisions); DEC-F19 (no list
-- says who is cleared); ADR-033 (corrective actions; their owner reads the card only); UX-116 (a screen offers an
-- action from server capabilities). Linear CDF-230. Number and ADR allocated by the coordinator (2026-10-15 06:50),
-- with the rulings of that answer:
--   1. owner candidates are on the seat basis, not filtered by the case gate, as 2085's amendment_candidates
--      (DEC-F19); the command answers INVALID at submit and no list here says who is cleared;
--   2. CDF-227 is fixed in 2090 (Rebase): this migration replaces api.corrective_action_view as 2090 left it and keeps
--      its exclusion (an event a disposition wrote before 2090 reaches a viewer outside the case team without its note
--      and reference), which its tests pin;
--   3. read models only, under the capability-flag pattern; SOURCE_REQUIRED stays marked; nothing widened before 2160.
--
-- Before: no read listed a case's corrective actions with the reason each may not move, so the case team could not
-- see which actions a superseded decision froze, nor which of them blocked the case's closure, short of opening every
-- action. On a frozen action the case team's view gave the superseded decision but not the replacement decision whose
-- source documents a disposition must cite; it offered REPLACE_WITH_NEW_ACTION to a manager who may not name an owner
-- on a restricted case (the command then refused with RESTRICTED_CASE_AUTHORITY_REQUIRED); nobody could list the
-- owners a replacement may name (role assignments are unreadable), nor tell whether a replacement without a due date
-- would take the policy's default or be refused. The case's history dropped the freezing and the disposition.
--
-- After:
--   * api.case_corrective_actions(case) (A1): for whoever may see the case (NOT_FOUND otherwise), each corrective
--     action of the case with its number, type, title, status, due date, progress, wording version and owner, where it
--     comes from, the decision it executes now, why it may not move (decision.action_block: TAINTED_BY_CONFLICT,
--     CONFLICT_REMEDIATION_OPEN, FROZEN_BY_SUPERSEDED_DECISION, WAIVED_BY_SUPERSEDING_DECISION or
--     REPLACED_BY_NEW_ACTION), when the decision it executes was superseded, the action that replaced it or that it
--     replaces, and may_dispose (api.dispose_superseded_corrective_action, as the view answers it). Not audited, as
--     api.sanction_executability (2040) and the view.
--   * api.corrective_action_view (A2) is replaced with the same signature, grant and owner, on 2090's body. Every key
--     2090 returned is returned to the same callers with the same values, CDF-227's exclusion included. The case
--     team's origin gains replacement: null unless the action is frozen; while it is, the replacement decision, its
--     source documents, may_name_owner (decision.require_owner_naming, for a manager who may dispose), the owners a
--     replacement may name (to whoever may dispose and name one; ruling 1) and the due date a replacement takes when
--     none is given.
--   * api.case_history: CORRECTIVE_ACTION_FROZEN and CORRECTIVE_ACTION_DISPOSED reach the case team as codes and
--     times only (never who disposed, or why).
--
-- How each capability is computed (coordinator, 2026-10-14 11:53, as for 2065, 2085, 2086 and 2095): with the helpers
-- its command calls, in the command's order, without taking a lock and without writing. Input checks (the
-- disposition, document, reason, wording, owner and due date chosen) are the command's to answer.
--
-- What a capability tells (AGENT-09, to clear): nothing its command would not answer, and only to whoever may act.
-- The list gives the case team what the actions' own reads (corrective_action_read: the case; the disposition and the
-- supersession: the case's package readers) and the view already give them, in one read. The owners a replacement
-- may name are active holders of a permission, never who is cleared for the case, and only to a manager who may
-- dispose of the action and name its owner.
--
-- Controls:
--   * One read model added, one replaced, the case history extended. No table, policy, table grant or command
--     changes; the new read model is granted to authenticated only and joins the policy snapshot's function list.
--   * SECURITY DEFINER with search_path ''; both read models are stable and write nothing. A capability never widens
--     a command: the command checks again.
--   * Every flag is a boolean, never null; every list is a list, empty for whoever may not act.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A1: the case's corrective actions
-- -----------------------------------------------------------------------------
-- The case team's list (precedent api.sanction_executability, 2040: codes and ids, not audited). may_dispose is the
-- view's: decision.lock_action's visibility (the case, so every action of it), decision.require_manager
-- (CORRECTIVE_ACTION_MANAGE and the case), the case ACTIVE, then the replacement decision exists (NOT_SUPERSEDED) and
-- has not disposed of the action yet (ALREADY_DISPOSED), which together are decision.action_block's
-- FROZEN_BY_SUPERSEDED_DECISION.
create function api.case_corrective_actions(p_case_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_case case_mgmt.case_record;
  v_manager boolean;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id;
  -- decision.require_manager: CORRECTIVE_ACTION_MANAGE and the case itself (seen above).
  v_manager := authz.has_permission('CORRECTIVE_ACTION_MANAGE');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'action_id', a.id, 'action_type', a.action_type, 'sequence_no', a.sequence_no, 'title', a.title,
             'status', a.status, 'due_date', a.due_date, 'percent_complete', a.percent_complete,
             'version_no', a.version_no,
             'owner', jsonb_build_object(
               'kind', a.owner_kind, 'accountable_user_id', a.owner_id,
               'display_name', u.display_name, 'display_name_ar', u.display_name_ar,
               'sector', (select jsonb_build_object('sector_id', s.id, 'code', s.code, 'name_en', s.name_en,
                                                    'name_ar', s.name_ar)
                          from iam.sector s where s.id = a.owner_sector_id),
               -- R3: a pool by code and name only.
               'pool', (select jsonb_build_object('code', p.code, 'name', p.name)
                        from decision.corrective_action_pool p where p.id = a.owner_pool_id),
               'external_party_label', a.external_party_label),
             -- DEC-F41 (2070): a package item and its decision, or a preliminary proposal.
             'source', case when a.preliminary_proposal_id is null then 'AUTHORITY_DECISION' else 'PRELIMINARY_REVIEW' end,
             'recommendation_item_id', a.recommendation_item_id, 'preliminary_proposal_id', a.preliminary_proposal_id,
             'authority_decision_id', a.authority_decision_id,
             'governing_decision_id', g.decision_id,
             'decision_block', b.block,
             'superseded_at', (select x.superseded_at from decision.authority_decision_supersession x
                               where x.decision_id = g.decision_id),
             'replaced_by_action_id', (select y.replacement_action_id from decision.corrective_action_disposition y
                                       where y.action_id = a.id and y.replacement_action_id is not null
                                       order by y.recorded_at desc, y.id desc limit 1),
             'replaces_action_id', (select y.action_id from decision.corrective_action_disposition y
                                    where y.replacement_action_id = a.id
                                    order by y.recorded_at desc, y.id desc limit 1),
             'may_dispose', coalesce(v_manager and v_case.records_state = 'ACTIVE'
                                     and b.block = 'FROZEN_BY_SUPERSEDED_DECISION', false))
           order by a.created_at, a.id)
    from decision.corrective_action a
    left join iam.user_profile u on u.id = a.owner_id
    cross join lateral (select decision.action_governing_decision(a.id) as decision_id) g
    cross join lateral (select decision.action_block(a.id) as block) b
    where a.case_id = p_case_id), '[]'::jsonb);
end;
$$;
comment on function api.case_corrective_actions(uuid) is
  'Read model A1 (migration 2096, ADR-058): the corrective actions of a case for whoever may see the case (NOT_FOUND '
  'otherwise), each with its owner, where it comes from, the decision it executes now and why it may not move '
  '(decision.action_block), the action that replaced it or that it replaces, and may_dispose, as '
  'api.corrective_action_view answers it. Codes and ids; not audited.';

-- -----------------------------------------------------------------------------
-- 2. A2: the corrective action's view, as 2090 left it, with the replacement while frozen
-- -----------------------------------------------------------------------------
create or replace function api.corrective_action_view(p_action_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_me uuid := authz.current_user_id();
  v decision.corrective_action;
  v_case case_mgmt.case_record;
  v_policy decision.corrective_action_policy;
  v_team boolean;
  v_manager boolean;
  v_acts boolean;
  v_naming boolean;
  v_open boolean;
  v_metadata boolean;
  v_block text;
  v_moves boolean;
  v_waivable boolean;
  v_frozen boolean;
  v_replacement uuid;
  v_approved boolean;
begin
  if p_action_id is null or not authz.can_view_corrective_action(p_action_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v from decision.corrective_action a where a.id = p_action_id;
  select * into v_case from case_mgmt.case_record c where c.id = v.case_id;
  v_policy := decision.current_corrective_policy(v.action_type);
  v_team := authz.can_view_case(v.case_id);
  -- decision.require_manager: CORRECTIVE_ACTION_MANAGE and the case itself.
  v_manager := authz.has_permission('CORRECTIVE_ACTION_MANAGE') and v_team;
  -- decision.require_owner (2040): whoever acts for the action (decision.acts_for_action, R2 included), with
  -- CORRECTIVE_ACTION_OWN and their own case gate.
  v_acts := coalesce(decision.acts_for_action(v, v_me), false) and authz.has_permission('CORRECTIVE_ACTION_OWN')
            and authz.user_case_gate(v_me, v.case_id);
  -- decision.require_owner_naming: an active case and, on a restricted one, its owner as its authority.
  v_naming := v_case.records_state = 'ACTIVE'
              and (not v_case.is_restricted
                   or (v_case.owner_id = v_me and authz.is_restricted_case_authority(v_me, v_case.classification)));
  v_open := v.status in ('OPEN', 'IN_PROGRESS');
  v_metadata := authz.can_view_case_metadata(v.case_id);
  -- decision.freeze_blocked_action (2030, DEC-AMB-003, DEC-AMB-013, DEC-AMB-014): no progress while the action may not
  -- move; only an open action whose decision is tainted or under remediation may still be waived.
  v_block := decision.action_block(v.id);
  v_moves := v_block is null;
  v_waivable := v_block is null or v_block in ('TAINTED_BY_CONFLICT', 'CONFLICT_REMEDIATION_OPEN');
  -- api.dispose_superseded_corrective_action: a manager, on an ACTIVE case, while the action is frozen; the replacement
  -- decision (NOT_SUPERSEDED otherwise) and whether it approves the item (ITEM_NOT_APPROVED).
  v_frozen := v_block = 'FROZEN_BY_SUPERSEDED_DECISION';
  if v_frozen then
    v_replacement := decision.superseding_decision(decision.action_governing_decision(v.id));
    v_approved := decision.approving_decision(v.recommendation_item_id) is not distinct from v_replacement;
  end if;
  return jsonb_build_object(
    'action_id', v.id, 'action_type', v.action_type, 'sequence_no', v.sequence_no, 'title', v.title,
    'description', v.description, 'status', v.status, 'due_date', v.due_date, 'percent_complete', v.percent_complete,
    'created_by', v.created_by, 'created_at', v.created_at, 'completion_submitted_at', v.completion_submitted_at,
    'completed_at', v.completed_at, 'verified_by', v.verified_by, 'waived_at', v.waived_at,
    'updated_at', v.updated_at, 'row_version', v.row_version,
    -- DEC-AMB-014: the wording it carries and every earlier one (corrective_action_version_read: as the action).
    'version_no', v.version_no,
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object('version_no', x.version_no, 'title', x.title, 'description', x.description,
                                          'recorded_by', x.recorded_by, 'recorded_at', x.recorded_at)
             order by x.version_no)
      from decision.corrective_action_version x where x.action_id = v.id), '[]'::jsonb),
    'owner', jsonb_build_object(
      'kind', v.owner_kind, 'accountable_user_id', v.owner_id,
      'sector', (select jsonb_build_object('sector_id', s.id, 'code', s.code, 'name_en', s.name_en, 'name_ar', s.name_ar)
                 from iam.sector s where s.id = v.owner_sector_id),
      -- R3: a pool by code and name only, under the action's own visibility.
      'pool', (select jsonb_build_object('code', p.code, 'name', p.name)
               from decision.corrective_action_pool p where p.id = v.owner_pool_id),
      'external_party_label', v.external_party_label),
    -- The decision the action executes, to whoever sees the case only: an owner sees the card, never the case.
    -- Why it cannot progress (DEC-AMB-013, DEC-AMB-014): to the case team only, with the origin. The decision it
    -- executes now (governing: the replacement once re-adopted or modified) and the replacement decision's
    -- dispositions of it (corrective_action_disposition_read: the case team), without their reasons (the card carries
    -- no reason, R3).
    'origin', case when v_team then jsonb_build_object(
      'recommendation_item_id', v.recommendation_item_id, 'authority_decision_id', v.authority_decision_id,
      -- DEC-F41 (2070): where it comes from, a package item and its decision or a preliminary proposal.
      'source', case when v.preliminary_proposal_id is null then 'AUTHORITY_DECISION' else 'PRELIMINARY_REVIEW' end,
      'preliminary_proposal_id', v.preliminary_proposal_id,
      'governing_decision_id', decision.action_governing_decision(v.id), 'decision_block', v_block,
      'dispositions', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'disposition_id', x.id, 'disposition', x.disposition, 'superseded_decision_id', x.superseded_decision_id,
                 'replacement_decision_id', x.replacement_decision_id, 'prior_status', x.prior_status,
                 'source_document_reference', x.source_document_reference,
                 'revised_version_no', x.revised_version_no, 'replacement_action_id', x.replacement_action_id,
                 'recorded_by', x.recorded_by, 'recorded_at', x.recorded_at)
               order by x.recorded_at, x.id)
        from decision.corrective_action_disposition x where x.action_id = v.id), '[]'::jsonb),
      -- What a disposition may be now, as api.dispose_superseded_corrective_action checks it.
      'disposition_options', case when v_frozen then to_jsonb(array_remove(array[
        case when v_approved and v.status <> 'WAIVED' then 'RE_ADOPT' end,
        case when v_approved and v.status not in ('COMPLETED', 'WAIVED') then 'MODIFY' end,
        'WAIVE',
        case when v_approved then 'REPLACE_WITH_NEW_ACTION' end], null)) else '[]'::jsonb end,
      -- 2096 (P12-3b, ADR-058): while frozen, what api.dispose_superseded_corrective_action checks a disposition
      -- against. The replacement decision and its source documents, one of which the disposition cites; whether the
      -- caller, a manager who may dispose, may also name an owner (decision.require_owner_naming, which
      -- REPLACE_WITH_NEW_ACTION passes after the item's approval); the owners a replacement may name, for whoever may
      -- dispose and name one: every active holder of CORRECTIVE_ACTION_OWN, on the seat basis and not filtered by the
      -- case gate (ruling 1; decision.owner_eligible answers INVALID at submit); and the due date a replacement takes
      -- when none is given (the policy's default; none without it).
      'replacement', case when v_frozen then jsonb_build_object(
        'decision_id', v_replacement,
        'sources', coalesce((
          select jsonb_agg(jsonb_build_object('position', s.position, 'reference', s.reference,
                                              'is_primary', s.is_primary) order by s.position)
          from decision.authority_decision_source s where s.decision_id = v_replacement), '[]'::jsonb),
        'may_name_owner', coalesce(v_manager and v_naming, false),
        'owner_candidates', case when v_manager and v_case.records_state = 'ACTIVE' and v_approved and v_naming
          then coalesce((
            select jsonb_agg(jsonb_build_object('user_id', u.id, 'display_name', u.display_name,
                                                'display_name_ar', u.display_name_ar)
                             order by u.display_name collate "C", u.id)
            from iam.user_profile u where authz.user_has_permission(u.id, 'CORRECTIVE_ACTION_OWN')), '[]'::jsonb)
          else '[]'::jsonb end,
        'default_due_date', decision.local_today() + v_policy.default_due_days) end) end,
    -- corrective_action_policy_read: the evidence the policy in force asks for.
    'policy', jsonb_build_object('completion_evidence', v_policy.completion_evidence,
                                 'allowed_evidence_types', to_jsonb(v_policy.allowed_evidence_types)),
    -- corrective_action_event_read: the action's history, as the action. CDF-227 (2090): an event a disposition wrote
    -- before 2090 carries the disposition's reason or document; a viewer outside the case team gets it without them.
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event_id', e.id, 'event_type', e.event_type, 'actor_id', e.actor_id,
               'note', case when not w.withheld then e.note end,
               'evidence_reference', e.evidence_reference, 'evidence_type', e.evidence_type,
               'percent_complete', e.percent_complete, 'owner_id', e.owner_id, 'due_date', e.due_date,
               'source_document_reference', case when not w.withheld then e.source_document_reference end,
               'created_at', e.created_at)
             order by e.created_at, e.id)
      from decision.corrective_action_event e
      cross join lateral (select authz.corrective_event_withheld(e.id) as withheld) w
      where e.action_id = v.id), '[]'::jsonb),
    'case', jsonb_build_object(
      'case_id', case when v_metadata then v.case_id end,
      'case_number', case when v_metadata then v_case.case_number end),
    'capabilities', jsonb_build_object(
      -- api.record_corrective_action_progress and api.submit_corrective_action_completion.
      'may_record_progress', coalesce(v_acts and v_open and v_moves, false),
      'may_submit_completion', coalesce(v_acts and v_open and v_moves, false),
      -- api.verify_corrective_action: never its owner or whoever submitted the completion.
      'may_verify', coalesce(v_manager and v.status = 'PENDING_VERIFICATION' and v.owner_id is distinct from v_me
                             and v_moves
                             and not exists (select 1 from decision.corrective_action_event e
                                             where e.action_id = v.id and e.event_type = 'COMPLETION_SUBMITTED'
                                               and e.actor_id = v_me), false),
      -- api.reopen_corrective_action.
      'may_reopen', coalesce(v_manager and v.status = 'COMPLETED' and v_case.records_state = 'ACTIVE' and v_moves,
                             false),
      -- api.waive_corrective_action.
      'may_waive', coalesce(authz.has_permission('CORRECTIVE_ACTION_WAIVE') and v_team
                            and v.status not in ('COMPLETED', 'WAIVED') and v_case.records_state = 'ACTIVE'
                            and v_waivable, false),
      -- api.dispose_superseded_corrective_action (DEC-AMB-014).
      'may_dispose', coalesce(v_manager and v_case.records_state = 'ACTIVE' and v_frozen, false),
      -- api.change_corrective_action_due_date.
      'may_change_due_date', coalesce(v_manager and v.status in ('OPEN', 'IN_PROGRESS', 'PENDING_VERIFICATION'), false),
      -- api.assign_corrective_action_owner.
      'may_assign_owner', coalesce(v_manager and v_open and v_naming, false),
      -- api.set_corrective_action_owner_kind: USER or EXTERNAL_PARTY ...
      'may_set_owner_kind', coalesce(v_manager and v_open and v_naming, false),
      -- ... and ORG_UNIT or SHARED_POOL, never on a restricted case (R2: RESTRICTED_CASE_OWNER_KIND).
      'may_set_shared_owner_kind', coalesce(v_manager and v_open and v_naming and not v_case.is_restricted, false)));
end;
$$;
comment on function api.corrective_action_view(uuid) is
  'Purpose read model of one corrective action (migration 2040 item 13; its source, a package item or a preliminary '
  'proposal, since 2070): NOT_FOUND unless authz.can_view_corrective_action; the card and its history, its origin '
  'only to the case team; a pool by code and name (R3); capabilities from the commands (R2 included). Since 2090 '
  '(CDF-227): an event carrying a disposition''s reason or document reaches a viewer outside the case team without '
  'them. Since 2096 (ADR-058): while the action is frozen, the case team''s origin carries the replacement decision, '
  'its source documents, whether the caller may name an owner, the owners a replacement may name (seat basis) and the '
  'default due date.';

-- -----------------------------------------------------------------------------
-- 3. Case history: a corrective action's freezing and disposition
-- -----------------------------------------------------------------------------
-- From 2095. One audience joins the allowlist: CORRECTIVE_ACTION (an action frozen when the decision it executed was
-- superseded; the replacement decision's disposition of it), as the action's own policy reads it
-- (authz.can_view_corrective_action), which is the whole case team. Codes and times only: no actor, reason or detail;
-- the disposition's reason stays in the disposition and the ledger's reason field (CDF-227).
create or replace function api.case_history(p_case_id uuid, p_limit int default 200)
returns table (
  seq bigint,
  occurred_at timestamptz,
  action text,
  actor_id uuid,           -- null when the audience may not see who acted, or when no user acted
  actor_name text,
  actor_name_ar text,
  subject_name text,       -- the person a team, access or conflict event is about, where the audience may know
  subject_name_ar text,
  reason text,             -- null when the audience may not see it
  detail jsonb             -- a fixed set of keys per action; never the event's raw metadata
)
language sql stable security definer
set search_path = ''
as $$
  with me as (
    select authz.current_user_id() as id, authz.current_clearance() as clearance,
           authz.can_assign_case(p_case_id) as roster_full,
           authz.has_permission('CONFLICT_MANAGE') as conflict_manager,
           authz.has_permission('LEGAL_HOLD_APPLY') or authz.has_permission('ARCHIVE_RECORD_ADMINISTER') as records_audience,
           -- 2045
           authz.has_case_file_basis(p_case_id) as file_basis,
           exists (select 1 from case_mgmt.case_record c
                    where c.id = p_case_id and c.owner_id = authz.current_user_id()
                      and authz.is_restricted_case_authority(authz.current_user_id(), c.classification)) as case_authority
     where authz.current_user_id() is not null and authz.can_view_case(p_case_id)
  ),
  -- The action-audience catalogue. An action missing here never reaches history.
  ev as (
    select e.*,
           case
             when e.action in ('CASE_CREATED', 'CASE_UPDATED', 'CASE_CLOSED', 'CASE_REOPENED', 'CLASSIFICATION_CHANGED',
                               'WORKFLOW_TRANSITION') then 'CASE_TEAM'
             when e.action in ('CASE_ASSIGNED', 'CASE_UNASSIGNED', 'CASE_REASSIGNED', 'CASE_HANDED_OVER') then 'TEAM_CHANGE'
             when e.action in ('CASE_ACCESS_GRANTED', 'CASE_ACCESS_REVOKED', 'REPORTER_COMMUNICATION_DELEGATED',
                               'REPORTER_COMMUNICATION_ENDED') then 'ACCESS'
             when e.action in ('CONFLICT_DECLARED', 'CONFLICT_DECIDED') then 'CONFLICT'
             when e.action in ('EVIDENCE_RECEIVED', 'EVIDENCE_STORED', 'EVIDENCE_REJECTED',
                               'EVIDENCE_RESTRICTION_CHANGED') then 'EVIDENCE'
             when e.action in ('FORM_STARTED', 'FORM_SAVED', 'FORM_PREPARED', 'FORM_REVIEWED', 'FORM_RETURNED',
                               'FORM_APPROVED', 'FORM_WITHDRAWN') then 'FORM'
             when e.action in ('INTERVIEW_PLANNED', 'INTERVIEW_PARTICIPANT_ADDED', 'INTERVIEW_SCHEDULED',
                               'INTERVIEW_RESCHEDULED', 'INTERVIEW_NOTICE_ISSUED', 'INTERVIEW_RIGHTS_ACKNOWLEDGED',
                               'INTERVIEW_CONDUCTED', 'INTERVIEW_STATEMENT_RECORDED', 'INTERVIEW_STATEMENT_ACKNOWLEDGED',
                               'INTERVIEW_RECORDING_LINKED', 'INTERVIEW_PREPARED', 'INTERVIEW_REVIEWED',
                               'INTERVIEW_APPROVED', 'INTERVIEW_RETURNED', 'INTERVIEW_CANCELLED') then 'INTERVIEW'
             when e.action in ('REPORT_MESSAGE_SENT', 'REPORTER_MESSAGE_RECEIVED') then 'REPORTER_MESSAGE'
             when e.action in ('REPORT_ATTACHMENT_RECEIVED', 'REPORT_ATTACHMENT_STORED',
                               'REPORT_ATTACHMENT_REJECTED') then 'REPORTER_FILE'
             when e.action in ('LEGAL_HOLD_PLACED', 'LEGAL_HOLD_RELEASED') then 'HOLD_STATUS'
             when e.action in ('LEGAL_HOLD_REQUESTED', 'LEGAL_HOLD_REVIEWED', 'LEGAL_HOLD_RELEASE_REQUESTED',
                               'LEGAL_HOLD_RELEASE_REJECTED', 'CASE_TASK_ASSIGNED', 'RETENTION_CLASS_ASSIGNED',
                               'RETENTION_SCHEDULE_COMPUTED', 'RETENTION_SCHEDULE_SUPERSEDED', 'RETENTION_REVIEW_STARTED',
                               'DISPOSITION_ELIGIBLE_MARKED', 'DISPOSITION_REVIEW_STARTED', 'DISPOSITION_REQUESTED',
                               'DISPOSITION_APPROVED', 'DISPOSITION_REJECTED', 'DISPOSITION_BLOCKED_BY_HOLD',
                               'DISPOSITION_EXECUTED', 'DISPOSITION_CERTIFICATE_ISSUED') then 'RECORDS'
             -- 2045: the 1870 events.
             when e.action in ('PROCEEDING_OPENED', 'PROCEEDING_STATE_CHANGED', 'PROCEEDING_CLOSED') then 'PROCEEDING'
             when e.action = 'COMMITTEE_PROCEEDING_OPENED' then 'COMMITTEE_PROCEEDING'
             when e.action in ('CASE_SUBJECT_ADDED', 'ALLEGATION_ADDED', 'ALLEGATION_SUBJECT_LINKED') then 'CASE_STRUCTURE'
             when e.action = 'FINDING_RECORDED' then 'FINDING'
             when e.action = 'EVIDENCE_LINKED' then 'EVIDENCE_LINK'
             -- 2095: the restricted legal review's approval joins the restricted referral's audience.
             when e.action in ('RESTRICTED_COMMITTEE_REFERRAL_APPROVED', 'RESTRICTED_LEGAL_REVIEW_APPROVED')
               then 'RESTRICTED_REFERRAL'
             -- 2095: the package's legal review and authority events.
             when e.action in ('LEGAL_REVIEW_REQUESTED', 'LEGAL_REVIEW_CANCELLED', 'LEGAL_OPINION_GIVEN',
                               'LEGAL_OPINION_SUPERSEDED', 'RECOMMENDATION_PACKAGE_SUBMITTED_TO_AUTHORITY',
                               'AUTHORITY_DECISION_RECORDED', 'AUTHORITY_DECISION_SUPERSEDED') then 'PACKAGE'
             -- 2096: a corrective action frozen by a superseded decision, and the replacement decision's disposition.
             when e.action in ('CORRECTIVE_ACTION_FROZEN', 'CORRECTIVE_ACTION_DISPOSED') then 'CORRECTIVE_ACTION'
           end as audience,
           -- The person a team, access or conflict event is about; for a hand-over or reassignment, the new person.
           case when e.action in ('CASE_HANDED_OVER', 'CASE_REASSIGNED') then e.metadata ->> 'to_user_id'
                when e.action in ('CASE_ASSIGNED', 'CASE_UNASSIGNED', 'CASE_ACCESS_GRANTED', 'CASE_ACCESS_REVOKED',
                                  'CONFLICT_DECLARED', 'CONFLICT_DECIDED', 'REPORTER_COMMUNICATION_DELEGATED',
                                  'REPORTER_COMMUNICATION_ENDED')
                  then e.metadata ->> 'user_id'
           end as subject_text,
           -- The person a hand-over or reassignment moved the work away from.
           case when e.action in ('CASE_HANDED_OVER', 'CASE_REASSIGNED') then e.metadata ->> 'from_user_id'
           end as previous_text
      from audit.audit_event e
     where e.case_id = p_case_id and e.category = 'BUSINESS' and e.outcome in ('SUCCESS', 'FAILURE')
  ),
  shown as (
    select ev.*, me.id as me_id, me.clearance, me.roster_full, me.conflict_manager, me.records_audience,
           (ev.actor_type = 'USER' and ev.actor_id = me.id) as by_me,
           (me.id::text in (ev.subject_text, ev.previous_text)) is true as about_me,
           g.scope as grant_scope
      from ev
     cross join me
      left join case_mgmt.case_access_grant g on ev.object_type = 'case_access_grant' and g.id::text = ev.object_id
     where ev.audience is not null
       and case ev.audience
             when 'CASE_TEAM' then true
             when 'TEAM_CHANGE' then true
             when 'ACCESS' then coalesce(g.scope, ev.metadata ->> 'scope') is distinct from 'AUDIT'
                                and (me.roster_full or ev.subject_text = me.id::text)
             when 'CONFLICT' then me.conflict_manager or ev.subject_text = me.id::text
                                  or (ev.actor_type = 'USER' and ev.actor_id = me.id)
             when 'EVIDENCE' then authz.can_view_evidence((ev.metadata ->> 'evidence_id')::uuid)
             when 'FORM' then case when ev.object_type = 'form_instance'
                                   then authz.can_view_form_instance(ev.object_id::uuid) else false end
             when 'INTERVIEW' then authz.can_view_interview(
                                     case when ev.object_type = 'interview' then ev.object_id
                                          else ev.metadata ->> 'interview_id' end::uuid)
             -- DEC-06: the conversation's own readers. DEC-09: the reporter's files, their own rule.
             when 'REPORTER_MESSAGE' then authz.can_read_reporter_conversation(
                                            case when ev.object_type = 'report' then ev.object_id
                                                 else ev.metadata ->> 'report_id' end::uuid)
             when 'REPORTER_FILE' then authz.can_view_report_files(
                                         case when ev.object_type = 'report' then ev.object_id
                                              else ev.metadata ->> 'report_id' end::uuid)
             when 'HOLD_STATUS' then true
             when 'RECORDS' then me.records_audience or (ev.actor_type = 'USER' and ev.actor_id = me.id)
             -- 2045: as each object's own policy reads it.
             when 'PROCEEDING' then case when ev.object_type = 'proceeding'
                                         then authz.can_view_proceeding(ev.object_id::uuid) else false end
             when 'COMMITTEE_PROCEEDING' then case when ev.object_type = 'committee_proceeding'
                                                   then authz.can_view_committee_proceeding(ev.object_id::uuid)
                                                   else false end
             when 'CASE_STRUCTURE' then true
             when 'FINDING' then me.file_basis
             when 'EVIDENCE_LINK' then authz.can_view_evidence((ev.metadata ->> 'evidence_id')::uuid)
             when 'RESTRICTED_REFERRAL' then me.case_authority or (ev.actor_type = 'USER' and ev.actor_id = me.id)
             -- 2095: the package, as its own policy reads it.
             when 'PACKAGE' then authz.can_view_recommendation_package(
                                   case when ev.object_type = 'recommendation_package' then ev.object_id
                                        else ev.metadata ->> 'package_id' end::uuid)
             -- 2096: the action, as its own policy reads it.
             when 'CORRECTIVE_ACTION' then case when ev.object_type = 'corrective_action'
                                                then authz.can_view_corrective_action(ev.object_id::uuid)
                                                else false end
             else false
           end
  ),
  masked as (
    select s.seq, s.occurred_at, s.action,
           -- Hold status reaches the case team without who placed or released it, or why (DEC-10).
           -- 2045: the 1870 events show as codes and times only. 2095: so do the package's. 2096: so do a corrective
           -- action's freezing and disposition (never the disposition's reason).
           case when s.actor_type <> 'USER' then false
                when s.audience = 'HOLD_STATUS' then s.records_audience or s.by_me
                when s.audience in ('PROCEEDING', 'COMMITTEE_PROCEEDING', 'CASE_STRUCTURE', 'FINDING', 'EVIDENCE_LINK',
                                    'RESTRICTED_REFERRAL', 'PACKAGE', 'CORRECTIVE_ACTION') then false
                else true end as show_actor,
           case when s.audience = 'HOLD_STATUS' then s.records_audience or s.by_me
                when s.audience = 'TEAM_CHANGE' then s.roster_full or s.about_me or s.by_me
                when s.audience in ('PROCEEDING', 'COMMITTEE_PROCEEDING', 'CASE_STRUCTURE', 'FINDING', 'EVIDENCE_LINK',
                                    'RESTRICTED_REFERRAL', 'PACKAGE', 'CORRECTIVE_ACTION') then false
                else true end as show_reason,
           s.audience in ('TEAM_CHANGE', 'ACCESS', 'CONFLICT') as show_subject,
           s.actor_id, s.reason, s.metadata, s.subject_text, s.clearance, s.grant_scope
      from shown s
  )
  select m.seq, m.occurred_at, m.action,
         case when m.show_actor then m.actor_id end,
         case when m.show_actor then a.display_name end,
         case when m.show_actor then a.display_name_ar end,
         case when m.show_subject then p.display_name end,
         case when m.show_subject then p.display_name_ar end,
         case when m.show_reason then m.reason end,
         case m.action
           when 'WORKFLOW_TRANSITION' then jsonb_build_object(
             'transition', m.metadata ->> 'transition', 'from', m.metadata ->> 'from', 'to', m.metadata ->> 'to')
           when 'CLASSIFICATION_CHANGED' then jsonb_build_object(
             'from', case when (m.metadata ->> 'from')::core.classification_level <= m.clearance
                          then m.metadata ->> 'from' end,
             'to', case when (m.metadata ->> 'to')::core.classification_level <= m.clearance
                        then m.metadata ->> 'to' end,
             'restricted', (m.metadata ->> 'restricted_to')::boolean)
           when 'CASE_UPDATED' then jsonb_build_object('fields', m.metadata -> 'fields')
           when 'CASE_ASSIGNED' then jsonb_build_object('role', m.metadata ->> 'assignment_role')
           when 'CASE_UNASSIGNED' then jsonb_build_object('role', m.metadata ->> 'assignment_role')
           when 'CASE_REASSIGNED' then jsonb_build_object('role', m.metadata ->> 'assignment_role')
           when 'CASE_ACCESS_GRANTED' then jsonb_build_object('scope', coalesce(m.grant_scope, m.metadata ->> 'scope'))
           when 'CASE_ACCESS_REVOKED' then jsonb_build_object('scope', coalesce(m.grant_scope, m.metadata ->> 'scope'))
           when 'EVIDENCE_RESTRICTION_CHANGED' then jsonb_build_object(
             'item', (m.metadata ->> 'sequence_no')::int, 'restriction', m.metadata ->> 'to')
         end
    from masked m
    left join iam.user_profile a on a.id = m.actor_id
    left join iam.user_profile p on m.show_subject and p.id::text = m.subject_text
   order by m.seq desc
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;

-- -----------------------------------------------------------------------------
-- 4. Grants
-- -----------------------------------------------------------------------------
revoke all on function api.case_corrective_actions(uuid) from public;
grant execute on function api.case_corrective_actions(uuid) to authenticated;
