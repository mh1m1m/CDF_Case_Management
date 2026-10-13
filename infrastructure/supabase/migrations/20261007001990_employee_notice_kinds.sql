-- =============================================================================
-- 1990 Kinds of employee notice; the decision notice starts the grievance window (Business Architecture Rebase
-- phase 11, gap P11-G5; CDF-198, CDF-193, CDF-194)
-- Requirements: §19–§22, §29, §39, §87; owner Q&A Q90, Q94; rebase prompt §53 (the employee receives a rights notice
-- and acknowledges receipt) and §58 (the grievance window is configurable and effective-dated); ADR-024, ADR-025,
-- ADR-035, ADR-037
--
-- The employee notice had one kind, the defence notice. The owner's catalogues also name a rights notice at the start
-- of an investigation (S092; T6-B1.1-036, T6-B1.1-121) and a decision notice that starts the grievance window
-- (T11-B4.1-229, T4-B1.3-125; baseline form WB-FRM-17 "Decision Notice" with its grievance deadline). Gap P11-G5,
-- FORM_CATALOGUE_RATIONALIZATION §6. This migration adds both:
--   grievance.defence_notice.kind   RIGHTS, DEFENCE or DECISION. Every existing notice is a DEFENCE notice and
--                                   api.issue_defence_notice is unchanged. Only a defence notice has a due date and
--                                   takes a response; a rights or a decision notice is acknowledged.
--   api.issue_rights_notice         the subject's procedural rights, with any allegations against them the issuer
--                                   permits them to see (none is allowed: the scope may be withheld at the start).
--   api.issue_decision_notice       the competent authority's decision (decision.authority_decision) that concerns
--                                   the subject: an item the committee approved names them or applies to the whole
--                                   case (Q89). The notice stores the Grievance Committee rule set in force when it is
--                                   issued, its window and the moment the window ends (Q94). A decision that returns
--                                   the package to the committee is not notified; one notice per subject and decision.
--   api.file_grievance_on_decision_notice
--                                   the subject's portal grievance against that notice. The window and the
--                                   admissibility decider come from the rule set the notice recorded; lateness is
--                                   measured from the notice and is a flag, never a rejection. A grievance filed
--                                   without a notice keeps 1910's rule: the rule set in force on the submission date.
--
-- Controls:
--   * Additive. New columns only; due_at's not-null becomes a check by kind, so every existing row stays valid and
--     means what it meant. No existing command changes. api.my_defence_notices (read-only) gains the kind and the
--     end of the grievance window; notify.on_defence_notice picks the template by kind (DEFENCE keeps its own).
--   * Who issues: the same predicate as a defence notice (authz.can_manage_defence: the people who edit the case, or
--     the cleared secretary of an open committee proceeding of the case), on an ACTIVE case. Who files: the subject
--     behind the notice's active portal link only; anybody else gets NOT_FOUND, as for every portal command.
--   * Only a defence notice takes a response: a trigger on grievance.defence_response refuses the others, so the
--     portal, the recorded and the continuity-import paths refuse alike, and a rights or decision notice is never
--     RESPONDED. The due-date reminder already skips notices without a due date.
--   * Notifications: two mandatory templates (RIGHTS_NOTICE_ISSUED, DECISION_NOTICE_ISSUED), delivered only through
--     the subject's active portal link, with ids only (§39).
--   * Every command writes its audit event in the same transaction; metadata carries ids, codes, counts and dates,
--     never notice text or grounds.
--   * The 1970 catalogue follows: S092 maps to RIGHTS_NOTICE_ISSUED, the P11-G5 references are cleared, and the
--     notice and grievance modules record this migration and its commands.
-- Open (SOURCE_REQUIRED, ADR-037): whether the window runs from issue (the default here), from delivery or from
-- acknowledgement; and whether a rule change inside an open window applies to it (here it does not).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Schema
-- -----------------------------------------------------------------------------
alter table grievance.defence_notice
  add column kind                     text not null default 'DEFENCE' check (kind in ('RIGHTS', 'DEFENCE', 'DECISION')),
  add column authority_decision_id    uuid references decision.authority_decision (id),
  add column grievance_rule_set_id    uuid references committee.rule_set (id),
  add column grievance_window_days    int check (grievance_window_days between 1 and 365),
  add column grievance_window_ends_at timestamptz;
alter table grievance.defence_notice alter column due_at drop not null;
alter table grievance.defence_notice
  add constraint defence_notice_due_by_kind check ((kind = 'DEFENCE') = (due_at is not null)),
  add constraint defence_notice_responded_by_kind check (status <> 'RESPONDED' or kind = 'DEFENCE'),
  add constraint defence_notice_decision_window check (
    (kind = 'DECISION') = (authority_decision_id is not null)
    and (kind = 'DECISION') = (grievance_rule_set_id is not null)
    and (kind = 'DECISION') = (grievance_window_days is not null)
    and (kind = 'DECISION') = (grievance_window_ends_at is not null)),
  add constraint defence_notice_window_after_issue check (grievance_window_ends_at > issued_at);
create unique index defence_notice_decision_once on grievance.defence_notice (subject_id, authority_decision_id)
  where authority_decision_id is not null;
create index defence_notice_authority_decision on grievance.defence_notice (authority_decision_id);
create index defence_notice_grievance_rule_set on grievance.defence_notice (grievance_rule_set_id);
comment on table grievance.defence_notice is
  'A notice to one subject (Q90; rebase prompt §53): RIGHTS, DEFENCE (due date, response) or DECISION (starts the '
  'grievance window, Q94). Receive, see permitted material, acknowledge; respond to a defence notice.';
comment on column grievance.defence_notice.kind is
  'RIGHTS, DEFENCE or DECISION (migration 1990, ADR-037). Rows before 1990 are DEFENCE.';
comment on column grievance.defence_notice.grievance_window_ends_at is
  'DECISION only: issue time plus the window of the Grievance Committee rule set in force at issue (Q94).';

alter table grievance.grievance
  add column decision_notice_id uuid references grievance.defence_notice (id),
  add constraint grievance_decision_notice_linked check (decision_notice_id is null or kind = 'LINKED');
create index grievance_decision_notice on grievance.grievance (decision_notice_id);
comment on column grievance.grievance.decision_notice_id is
  'The decision notice the grievance was filed on (migration 1990): its rule set and window apply (Q94).';

-- Only a defence notice takes a response, whichever path records it (portal, issuer, continuity import).
create function grievance.require_defence_notice()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from grievance.defence_notice n where n.id = new.notice_id and n.kind = 'DEFENCE') then
    perform api._fail('CONFLICT', 'NOT_A_DEFENCE_NOTICE');
  end if;
  return new;
end;
$$;
create trigger defence_response_needs_defence_notice before insert on grievance.defence_response
  for each row execute function grievance.require_defence_notice();

-- -----------------------------------------------------------------------------
-- Internal helpers
-- -----------------------------------------------------------------------------
-- The subject a notice is issued to, with the case locked: the same checks, in the same order, as
-- api.issue_defence_notice.
create function grievance.lock_notice_subject(p_subject_id uuid)
returns case_mgmt.case_subject
language plpgsql
set search_path = ''
as $$
declare v_s case_mgmt.case_subject;
begin
  select * into v_s from case_mgmt.case_subject s where s.id = p_subject_id;
  if v_s.id is null or not authz.can_view_case(v_s.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_manage_defence(v_s.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_s.case_id for update;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_s.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  return v_s;
end;
$$;

-- Inserts a notice and snapshots the permitted allegations, which must all be against the subject.
create function grievance.insert_notice(
  p_kind text, p_s case_mgmt.case_subject, p_notice_text text, p_allegation_ids uuid[], p_decision_id uuid,
  p_rule committee.rule_set, p_actor uuid
)
returns grievance.defence_notice
language plpgsql
set search_path = ''
as $$
declare
  v_allegations uuid[] := coalesce(p_allegation_ids, '{}');
  v grievance.defence_notice;
begin
  if (select count(distinct x) from unnest(v_allegations) x) <> cardinality(v_allegations)
     or exists (select 1 from unnest(v_allegations) x
                where not exists (select 1 from case_mgmt.allegation a
                                  where a.id = x and a.case_id = p_s.case_id and a.subject_id = p_s.id)) then
    perform api._fail('INVALID', 'allegation_ids');
  end if;
  insert into grievance.defence_notice (case_id, subject_id, sequence_no, notice_text, due_at, issued_by, kind,
                                        authority_decision_id, grievance_rule_set_id, grievance_window_days,
                                        grievance_window_ends_at)
  values (p_s.case_id, p_s.id,
          (select coalesce(max(n.sequence_no), 0) + 1 from grievance.defence_notice n where n.subject_id = p_s.id),
          api._require_text(p_notice_text, 'notice_text', 10, 4000), null, p_actor, p_kind, p_decision_id,
          p_rule.id, p_rule.grievance_window_days,
          case when p_rule.id is not null then now() + make_interval(days => p_rule.grievance_window_days) end)
  returning * into v;
  insert into grievance.defence_notice_item (notice_id, position, allegation_id, snapshot)
  select v.id, row_number() over (order by a.created_at, a.id), a.id,
         jsonb_build_object('category', a.category, 'description', a.description,
                            'policy_reference', a.policy_reference, 'law_reference', a.law_reference)
  from case_mgmt.allegation a where a.id = any (v_allegations);
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Commands
-- -----------------------------------------------------------------------------
-- Rebase prompt §53, T6-B1.1-036: the subject's procedural rights, scope and confidentiality at the start of the
-- investigation. Acknowledged through the portal; no response, no due date.
create function api.issue_rights_notice(p_subject_id uuid, p_notice_text text, p_allegation_ids uuid[])
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_s case_mgmt.case_subject;
  v_n grievance.defence_notice;
begin
  v_s := grievance.lock_notice_subject(p_subject_id);
  v_n := grievance.insert_notice('RIGHTS', v_s, p_notice_text, p_allegation_ids, null, null, v_actor);
  perform audit.record_event('RIGHTS_NOTICE_ISSUED', 'BUSINESS', 'SUCCESS', v_s.case_id, 'defence_notice', v_n.id::text,
    null, jsonb_build_object('subject_id', v_s.id, 'sequence_no', v_n.sequence_no,
                             'allegations', cardinality(coalesce(p_allegation_ids, '{}'))));
  return v_n.id;
end;
$$;

-- Q94, T11-B4.1-229, WB-FRM-17: the authority's decision that concerns the subject, and the start of the grievance
-- window under the Grievance Committee rule set in force now. The notice text is the issuer's; the decision's own
-- record stays with the case.
create function api.issue_decision_notice(p_subject_id uuid, p_authority_decision_id uuid, p_notice_text text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_s case_mgmt.case_subject;
  v_d decision.authority_decision;
  v_rule committee.rule_set;
  v_n grievance.defence_notice;
begin
  v_s := grievance.lock_notice_subject(p_subject_id);
  select * into v_d from decision.authority_decision d where d.id = p_authority_decision_id and d.case_id = v_s.case_id;
  if v_d.id is null then perform api._fail('INVALID', 'authority_decision_id'); end if;
  -- A return to the committee is not a decision on the subject: the revised package gets its own decision.
  if v_d.outcome = 'RETURN_TO_COMMITTEE' then perform api._fail('CONFLICT', 'DECISION_NOT_FINAL'); end if;
  if not exists (select 1 from decision.recommendation_item i
                 where i.package_id = v_d.package_id and i.status = 'ACTIVE' and i.committee_result = 'APPROVED'
                   and (i.case_wide or exists (select 1 from decision.recommendation_item_subject x
                                               where x.item_id = i.id and x.subject_id = v_s.id))) then
    perform api._fail('CONFLICT', 'SUBJECT_NOT_IN_DECISION');
  end if;
  if exists (select 1 from grievance.defence_notice n
             where n.subject_id = v_s.id and n.authority_decision_id = v_d.id) then
    perform api._fail('CONFLICT', 'ALREADY_NOTIFIED');
  end if;
  v_rule := grievance.rule_at(now());
  if v_rule.id is null or v_rule.grievance_window_days is null then perform api._fail('CONFLICT', 'NO_RULE_SET'); end if;
  v_n := grievance.insert_notice('DECISION', v_s, p_notice_text, null, v_d.id, v_rule, v_actor);
  perform audit.record_event('DECISION_NOTICE_ISSUED', 'BUSINESS', 'SUCCESS', v_s.case_id, 'defence_notice', v_n.id::text,
    null, jsonb_build_object('subject_id', v_s.id, 'sequence_no', v_n.sequence_no, 'authority_decision_id', v_d.id,
                             'rule_set_id', v_rule.id, 'window_days', v_n.grievance_window_days,
                             'window_ends_at', v_n.grievance_window_ends_at));
  return v_n.id;
end;
$$;

-- The subject grieves the decision a notice told them of. Same intake as api.file_grievance (LINKED, through the
-- portal, one open grievance per subject), except that the notice's rule set and window apply.
create function api.file_grievance_on_decision_notice(p_notice_id uuid, p_grounds text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_n grievance.defence_notice;
  v_rule committee.rule_set;
  v_decided_at timestamptz;
  v grievance.grievance;
begin
  select * into v_n from grievance.defence_notice n where n.id = p_notice_id;
  if v_n.id is null or not authz.is_portal_subject(v_n.subject_id) then perform api._fail('NOT_FOUND'); end if;
  if v_n.kind <> 'DECISION' then perform api._fail('CONFLICT', 'NOT_A_DECISION_NOTICE'); end if;
  if v_n.status = 'WITHDRAWN' then perform api._fail('CONFLICT', 'NOTICE_NOT_OPEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_n.case_id for update;
  if exists (select 1 from grievance.grievance g
             where g.grievant_subject_id = v_n.subject_id
               and g.status in ('RECEIVED', 'AWAITING_ADMISSIBILITY_DECISION', 'ADMITTED')) then
    perform api._fail('CONFLICT', 'GRIEVANCE_OPEN');
  end if;
  select * into v_rule from committee.rule_set r where r.id = v_n.grievance_rule_set_id;
  select d.decided_at into v_decided_at from decision.authority_decision d where d.id = v_n.authority_decision_id;
  insert into grievance.grievance (case_id, kind, grievant_subject_id, grievant_user_id, channel, original_submission_date,
                                   contested_decision_date, grounds, rule_set_id, window_days, is_late,
                                   admissibility_decider, recorded_by, decision_notice_id)
  values (v_n.case_id, 'LINKED', v_n.subject_id, v_actor, 'EMPLOYEE_PORTAL', now(), v_decided_at,
          api._require_text(p_grounds, 'grounds', 10, 20000), v_rule.id, v_n.grievance_window_days,
          now() > v_n.grievance_window_ends_at, coalesce(v_rule.admissibility_decider, 'SECRETARY'), v_actor, v_n.id)
  returning * into v;
  perform audit.record_event('GRIEVANCE_FILED', 'BUSINESS', 'SUCCESS', v.case_id, 'grievance', v.id::text, null,
    jsonb_build_object('kind', 'LINKED', 'channel', 'EMPLOYEE_PORTAL', 'is_late', v.is_late, 'window_days', v.window_days,
                       'rule_set_id', v.rule_set_id, 'admissibility_decider', v.admissibility_decider,
                       'decision_notice_id', v_n.id));
  return v.id;
end;
$$;

-- Same body as 1910 plus each notice's kind and, for a decision notice, the end of its grievance window.
create or replace function api.my_defence_notices()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'notice_id', n.id, 'sequence_no', n.sequence_no, 'kind', n.kind, 'notice_text', n.notice_text,
           'due_at', n.due_at, 'grievance_window_ends_at', n.grievance_window_ends_at,
           'status', n.status, 'issued_at', n.issued_at, 'acknowledged_at', n.acknowledged_at,
           'items', (select coalesce(jsonb_agg(jsonb_build_object('position', i.position, 'snapshot', i.snapshot)
                                               order by i.position), '[]'::jsonb)
                     from grievance.defence_notice_item i where i.notice_id = n.id))
         order by n.issued_at), '[]'::jsonb)
  from grievance.defence_notice n
  where authz.current_user_id() is not null and authz.is_portal_subject(n.subject_id) and n.status <> 'WITHDRAWN';
$$;

grant execute on function
  api.issue_rights_notice(uuid, text, uuid[]),
  api.issue_decision_notice(uuid, uuid, text),
  api.file_grievance_on_decision_notice(uuid, text)
to authenticated;

-- -----------------------------------------------------------------------------
-- Notifications (ADR-025): the template follows the kind; the subject is reached only through the active portal link
-- -----------------------------------------------------------------------------
insert into notify.template (code, object_type, is_mandatory, description) values
  ('RIGHTS_NOTICE_ISSUED',   'DEFENCE_NOTICE', true, 'A rights notice awaits the subject (rebase prompt §53)'),
  ('DECISION_NOTICE_ISSUED', 'DEFENCE_NOTICE', true, 'A decision notice awaits the subject; its grievance window runs (Q94)');
insert into notify.rule (layer, template_code, channel, enabled, effective_from, reason)
select 'SYSTEM_MANDATORY', t.code, c.channel, true, '2026-01-01T00:00:00Z', 'Synthetic default: mandatory notice (ADR-025)'
from notify.template t cross join (values ('IN_APP'), ('EMAIL')) c (channel)
where t.code in ('RIGHTS_NOTICE_ISSUED', 'DECISION_NOTICE_ISSUED');

create or replace function notify.on_defence_notice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform notify.enqueue(
    case new.kind when 'RIGHTS' then 'RIGHTS_NOTICE_ISSUED' when 'DECISION' then 'DECISION_NOTICE_ISSUED'
                  else 'DEFENCE_NOTICE_ISSUED' end,
    (select l.user_id from grievance.subject_portal_link l where l.subject_id = new.subject_id and l.revoked_at is null),
    new.id, null, 'defence-notice:' || new.id);
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- The form and status catalogue (migration 1970) follows the schema
-- -----------------------------------------------------------------------------
update config.legacy_status_map
   set target_event = 'RIGHTS_NOTICE_ISSUED',
       notes = 'A rights notice (kind RIGHTS) since migration 1990 (P11-G5 closed).',
       gap_ref = null
 where gap_ref = 'P11-G5' and legacy_code = 'S092';
update config.legacy_form_map
   set merge_target = case legacy_id
         when 'T4-B1.3-125' then 'api.issue_rights_notice, api.issue_defence_notice or api.issue_decision_notice + '
                                 'api.acknowledge_defence_notice'
         when 'T11-B4.1-229' then 'api.issue_decision_notice (starts the grievance window) + '
                                  'api.acknowledge_defence_notice'
         else 'api.issue_rights_notice + api.acknowledge_defence_notice' end,
       gap_ref = null
 where gap_ref = 'P11-G5';
update config.target_module
   set commands = commands || array['api.issue_rights_notice', 'api.issue_decision_notice'],
       delivered_in = delivered_in || '1990'::text,
       notes = 'Rights, defence and decision notices with acknowledgement (Q90; rebase prompt §53); the decision '
               'notice starts the grievance window (Q94).'
 where code = 'EMPLOYEE_NOTICE';
update config.target_module
   set commands = commands || 'api.file_grievance_on_decision_notice'::text,
       delivered_in = delivered_in || '1990'::text
 where code = 'GRIEVANCE_SUBMISSION';
