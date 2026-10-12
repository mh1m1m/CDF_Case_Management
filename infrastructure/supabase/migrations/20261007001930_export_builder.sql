-- =============================================================================
-- 1930 Export builder and external email (Business Architecture Rebase phase 9; CDF-196)
-- Requirements: §19, §29, §39, §40, §46, §82–§83, §87; owner Q&A Q99; ADR-026; AUTHORIZATION_IMPACT.md N16, N19
--
-- Additive only. Schema `exchange`:
--   approval_rule     effective-dated rules on audience, case classification, restricted cases and content type: a
--                     matching rule requires a second approval or refuses the export (Q99). Seeded SOURCE_REQUIRED.
--   export_request    one export of one case: format PDF / XLSX / EMAIL, audience INTERNAL / EXTERNAL, purpose,
--                     external party and justification (always required for EXTERNAL), status
--                     DRAFT → SUBMITTED → APPROVED → GENERATED (→ SENT for EMAIL) | REJECTED | CANCELLED.
--   export_item       object type and id only; content is rendered per viewer at preview, approval and generation.
--   export_recipient  INTERNAL users cleared for the case, or EXTERNAL addresses (synthetic @example.test only;
--                     PRODUCTION_SUBSTITUTION_REQUIRED: the CDF approved-domain list). EMAIL format only.
--   export_approval   one row per approval stage, bound to the preview hash the approver saw.
--
-- Controls:
--   * Every item is rendered with the same authz predicates as its table's RLS policy; an item the caller cannot see
--     is listed as withheld (N16), never silently dropped, and blocks submission, approval and generation.
--   * The preview hash covers the rendered items, recipients, format, audience, purpose, justification and the
--     case's current classification. Submission needs the requester's own preview; every approval and the
--     generation recompute it, so a changed item, recipient or classification answers PREVIEW_CHANGED.
--   * EXTERNAL always needs a justification, an external party, the requester's confirmation of the case's
--     classification and at least one approval; a matching rule adds a second approval or refuses (Q99).
--   * Separation of duties: the requester never approves, and the second approval is by a different person holding
--     EXPORT_SECOND_APPROVE. Approvers must see every item.
--   * Protected identity is never rendered: no item reads protected_identity, the report or the reporter WB id (N19).
--     Evidence is not exportable until UX S2 merges (ADR-031).
--   * Rendering and delivery are ports (ExportRenderer, ExportStore, ExportMailer); the prototype adapters are stubs.
--     PRODUCTION_SUBSTITUTION_REQUIRED: CDF document rendering, private OSS export bucket and the CDF mail relay.
-- Audit metadata carries ids, codes and counts; recipient addresses never enter the audit ledger.
-- =============================================================================

create schema if not exists exchange;
revoke all on schema exchange from public;
alter default privileges in schema exchange revoke all on tables from public, anon, authenticated;
alter default privileges in schema exchange revoke all on sequences from public, anon, authenticated;
alter default privileges in schema exchange revoke execute on functions from public, anon, authenticated;
grant usage on schema exchange to authenticated;

-- OWNER_DEFAULT, SOURCE_REQUIRED: who may request, approve and second-approve exports is a Delegation of Authority
-- question. The committee secretary is not given EXPORT_REQUEST until grant scope is enforced (DEC-02, UX S3).
insert into iam.permission (code, description) values
  ('EXPORT_REQUEST', 'Prepare and submit an export of case items the user can see'),
  ('EXPORT_APPROVE', 'Approve or reject an export prepared by someone else (first approval)'),
  ('EXPORT_SECOND_APPROVE', 'Give the second approval an export rule requires; never the first approver'),
  ('EXPORT_POLICY_ADMIN', 'Maintain export approval rules; never exports or their content');
insert into iam.role_permission (role_code, permission_code) values
  ('CASE_MANAGER', 'EXPORT_REQUEST'), ('CASE_MANAGER', 'EXPORT_APPROVE'),
  ('LEAD_INVESTIGATOR', 'EXPORT_REQUEST'),
  ('GRC_DIRECTOR', 'EXPORT_REQUEST'), ('GRC_DIRECTOR', 'EXPORT_APPROVE'), ('GRC_DIRECTOR', 'EXPORT_SECOND_APPROVE'),
  ('GRC_DIRECTOR', 'EXPORT_POLICY_ADMIN');

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table exchange.approval_rule (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null check (code ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  audience           text not null check (audience in ('INTERNAL', 'EXTERNAL', 'ANY')),
  min_classification core.classification_level,
  object_type        text check (object_type in (
                       'CASE_SUMMARY', 'FINDING', 'RECOMMENDATION_PACKAGE', 'AUTHORITY_DECISION', 'MINUTES')),
  restricted_only    boolean not null default false,
  action             text not null check (action in ('REQUIRE_SECOND_APPROVAL', 'REFUSE', 'NONE')),
  source_status      text not null check (source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED', 'APPROVED')),
  reason             text check (length(reason) between 5 and 2000),
  effective_from     timestamptz not null,
  effective_to       timestamptz,
  created_by         uuid references iam.user_profile (id),
  created_at         timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  check (created_by is not null or source_status in ('OWNER_DEFAULT', 'SOURCE_REQUIRED'))
);
create unique index approval_rule_open on exchange.approval_rule (code) where effective_to is null;
create index approval_rule_code on exchange.approval_rule (code, effective_from);
create index approval_rule_created_by on exchange.approval_rule (created_by);
comment on table exchange.approval_rule is
  'Export approval rules (Q99, ADR-026). Effective-dated; NONE switches a code off. Synthetic seed, SOURCE_REQUIRED.';
insert into exchange.approval_rule (code, audience, min_classification, object_type, restricted_only, action,
                                    source_status, effective_from)
values
  ('EXTERNAL_SECRET', 'EXTERNAL', 'SECRET', null, false, 'REFUSE', 'SOURCE_REQUIRED', '2026-01-01T00:00:00Z'),
  ('EXTERNAL_CONFIDENTIAL', 'EXTERNAL', 'CONFIDENTIAL', null, false, 'REQUIRE_SECOND_APPROVAL', 'SOURCE_REQUIRED',
   '2026-01-01T00:00:00Z'),
  ('EXTERNAL_MINUTES', 'EXTERNAL', null, 'MINUTES', false, 'REQUIRE_SECOND_APPROVAL', 'SOURCE_REQUIRED',
   '2026-01-01T00:00:00Z'),
  ('RESTRICTED_CASE', 'ANY', null, null, true, 'REQUIRE_SECOND_APPROVAL', 'SOURCE_REQUIRED', '2026-01-01T00:00:00Z');

create table exchange.export_request (
  id                       uuid primary key default gen_random_uuid(),
  case_id                  uuid not null references case_mgmt.case_record (id),
  format                   text not null check (format in ('PDF', 'XLSX', 'EMAIL')),
  audience                 text not null check (audience in ('INTERNAL', 'EXTERNAL')),
  purpose                  text not null check (purpose in (
                             'AUTHORITY_SUBMISSION', 'REGULATOR_REQUEST', 'LEGAL_COUNSEL', 'INTERNAL_REPORTING',
                             'AUDIT', 'OTHER')),
  external_party           text check (length(external_party) between 3 and 200),
  justification            text check (length(justification) between 20 and 2000),
  status                   text not null default 'DRAFT' check (status in (
                             'DRAFT', 'SUBMITTED', 'APPROVED', 'GENERATED', 'SENT', 'REJECTED', 'CANCELLED')),
  classification_at_submit core.classification_level,
  approvals_required       int check (approvals_required between 0 and 2),
  matched_rules            text[] not null default '{}',
  preview_hash             text check (preview_hash ~ '^[0-9a-f]{64}$'),
  previewed_at             timestamptz,
  submitted_hash           text check (submitted_hash ~ '^[0-9a-f]{64}$'),
  storage_key              text unique check (storage_key ~ '^exports/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
  requested_by             uuid not null references iam.user_profile (id),
  created_at               timestamptz not null default now(),
  submitted_at             timestamptz,
  decided_at               timestamptz,
  generated_at             timestamptz,
  sent_at                  timestamptz,
  cancelled_at             timestamptz,
  updated_at               timestamptz not null default now(),
  row_version              int not null default 1,
  check ((audience = 'EXTERNAL') = (external_party is not null)),
  check (audience = 'INTERNAL' or justification is not null),
  -- Bound to a hash from submission on; a draft has none, and a cancelled draft never had one.
  check (case status when 'DRAFT' then submitted_hash is null when 'CANCELLED' then true else submitted_hash is not null end),
  check ((status in ('GENERATED', 'SENT')) = (storage_key is not null)),
  check (status <> 'SENT' or format = 'EMAIL')
);
create index export_request_case on exchange.export_request (case_id);
create index export_request_requested_by on exchange.export_request (requested_by, status);
comment on table exchange.export_request is
  'One export of one case (Q99, ADR-026). Items, recipients and approvals hang off it; content is never stored.';

create table exchange.export_item (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references exchange.export_request (id),
  position    int not null check (position between 1 and 50),
  object_type text not null check (object_type in (
                'CASE_SUMMARY', 'FINDING', 'RECOMMENDATION_PACKAGE', 'AUTHORITY_DECISION', 'MINUTES')),
  object_id   uuid not null,
  added_by    uuid not null references iam.user_profile (id),
  added_at    timestamptz not null default now(),
  unique (request_id, position),
  unique (request_id, object_type, object_id)
);
create index export_item_added_by on exchange.export_item (added_by);
comment on table exchange.export_item is 'Object type and id of an exported item. Rendered per viewer; no content.';

create table exchange.export_recipient (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references exchange.export_request (id),
  kind       text not null check (kind in ('INTERNAL', 'EXTERNAL')),
  user_id    uuid references iam.user_profile (id),
  -- PRODUCTION_SUBSTITUTION_REQUIRED: synthetic addresses only; production checks a CDF approved-domain list.
  email      text check (email ~ '^[a-z0-9._%+-]{1,64}@example\.test$'),
  added_by   uuid not null references iam.user_profile (id),
  added_at   timestamptz not null default now(),
  check ((kind = 'INTERNAL') = (user_id is not null)),
  check ((kind = 'EXTERNAL') = (email is not null)),
  unique (request_id, user_id),
  unique (request_id, email)
);
create index export_recipient_user on exchange.export_recipient (user_id);
create index export_recipient_added_by on exchange.export_recipient (added_by);
comment on table exchange.export_recipient is
  'Who an EMAIL export goes to: internal users cleared for the case, or external synthetic addresses.';

create table exchange.export_approval (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references exchange.export_request (id),
  stage        int not null check (stage in (1, 2)),
  approver_id  uuid not null references iam.user_profile (id),
  decision     text not null check (decision in ('APPROVED', 'REJECTED')),
  reason       text not null check (length(reason) between 5 and 2000),
  preview_hash text not null check (preview_hash ~ '^[0-9a-f]{64}$'),
  decided_at   timestamptz not null default now(),
  unique (request_id, stage),
  unique (request_id, approver_id)
);
create index export_approval_approver on exchange.export_approval (approver_id);
comment on table exchange.export_approval is 'Export approvals, one per stage, bound to the preview hash approved.';

-- Records keep their facts: items, recipients and approvals never change; requests change state only through the
-- commands, keep their identity, and are final once sent, rejected or cancelled (or generated, for files).
do $$
declare t text;
begin
  foreach t in array array['exchange.export_item', 'exchange.export_recipient', 'exchange.export_approval'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
  foreach t in array array['exchange.approval_rule', 'exchange.export_request'] loop
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;

create function exchange.protect_records()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_fixed text[] := array['id', 'case_id', 'format', 'audience', 'purpose', 'external_party', 'justification',
                          'requested_by', 'created_at'];
begin
  if tg_table_name = 'export_request' then
    if old.status in ('SENT', 'REJECTED', 'CANCELLED') or (old.status = 'GENERATED' and old.format <> 'EMAIL')
       or (select jsonb_object_agg(k, to_jsonb(new) -> k) from unnest(v_fixed) k)
          <> (select jsonb_object_agg(k, to_jsonb(old) -> k) from unnest(v_fixed) k)
       or (old.submitted_hash is not null and new.submitted_hash is distinct from old.submitted_hash)
       or (old.storage_key is not null and new.storage_key is distinct from old.storage_key) then
      raise exception 'export request % is final or its identity is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'approval_rule' then
    if (to_jsonb(new) - 'effective_to') <> (to_jsonb(old) - 'effective_to') or old.effective_to is not null then
      raise exception 'export rule % can only be given an end, once', old.id using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;
create trigger export_request_protect before update on exchange.export_request
  for each row execute function exchange.protect_records();
create trigger approval_rule_protect before update on exchange.approval_rule
  for each row execute function exchange.protect_records();

-- -----------------------------------------------------------------------------
-- Authorization predicate
-- -----------------------------------------------------------------------------
-- A draft is its requester's alone; once submitted, approvers who can see the case see it too. Everyone loses it with
-- the case (§19). Answers for the caller only.
create function authz.can_view_export(p_request_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from exchange.export_request r
    where r.id = p_request_id and authz.can_view_case(r.case_id)
      and (r.requested_by = authz.current_user_id()
           or (r.status <> 'DRAFT'
               and (authz.has_permission('EXPORT_APPROVE') or authz.has_permission('EXPORT_SECOND_APPROVE'))))
  );
$$;
revoke all on function authz.can_view_export(uuid) from public, anon;
grant execute on function authz.can_view_export(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table exchange.approval_rule enable row level security;
alter table exchange.export_request enable row level security;
alter table exchange.export_item enable row level security;
alter table exchange.export_recipient enable row level security;
alter table exchange.export_approval enable row level security;

create policy approval_rule_read on exchange.approval_rule for select to authenticated
  using (authz.current_user_id() is not null);
grant select on exchange.approval_rule to authenticated;
create policy export_request_read on exchange.export_request for select to authenticated
  using (authz.can_view_export(id));
grant select on exchange.export_request to authenticated;
create policy export_item_read on exchange.export_item for select to authenticated
  using (authz.can_view_export(request_id));
grant select on exchange.export_item to authenticated;
create policy export_recipient_read on exchange.export_recipient for select to authenticated
  using (authz.can_view_export(request_id));
grant select on exchange.export_recipient to authenticated;
create policy export_approval_read on exchange.export_approval for select to authenticated
  using (authz.can_view_export(request_id));
grant select on exchange.export_approval to authenticated;

-- -----------------------------------------------------------------------------
-- Rendering (internal; runs inside the definer commands, for the calling user)
-- -----------------------------------------------------------------------------
-- One item as the caller may see it, or null (withheld): the item must belong to the export's case and pass the same
-- predicate as its table's RLS policy. Nothing here reads the report, the reporter's WB id or protected identity
-- (N19); free-text fields are the case team's own records.
create function exchange.render_item(p_object_type text, p_object_id uuid, p_case_id uuid)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare v jsonb;
begin
  if p_object_type = 'CASE_SUMMARY' then
    select jsonb_build_object('case_number', c.case_number, 'case_type', c.case_type, 'title', c.title,
                              'summary', c.summary, 'classification', c.classification, 'priority', c.priority,
                              'opened_at', c.opened_at, 'closed_at', c.closed_at)
      into v
      from case_mgmt.case_record c
     where c.id = p_object_id and c.id = p_case_id and authz.can_view_case(c.id);
  elsif p_object_type = 'FINDING' then
    select jsonb_build_object('version_no', f.version_no, 'result', f.result, 'rationale', f.rationale,
                              'recorded_at', f.recorded_at, 'allegation_category', a.category,
                              'subject', (select jsonb_build_object('label', p.display_name, 'category', s.subject_category)
                                            from case_mgmt.case_subject s join case_mgmt.person p on p.id = s.person_id
                                           where s.id = coalesce(f.subject_id, a.subject_id)))
      into v
      from case_mgmt.finding f left join case_mgmt.allegation a on a.id = f.allegation_id
     where f.id = p_object_id and f.case_id = p_case_id and authz.can_view_case(f.case_id);
  elsif p_object_type = 'RECOMMENDATION_PACKAGE' then
    select jsonb_build_object('sequence_no', k.sequence_no, 'status', k.status, 'round_no', k.round_no,
                              'adopted_at', k.adopted_at, 'decided_at', k.decided_at,
                              'items', coalesce((select jsonb_agg(decision.item_snapshot(i.id) order by i.added_at, i.id)
                                                   from decision.recommendation_item i
                                                  where i.package_id = k.id and i.status = 'ACTIVE'), '[]'::jsonb))
      into v
      from decision.recommendation_package k
     where k.id = p_object_id and k.case_id = p_case_id and authz.can_view_recommendation_package(k.id);
  elsif p_object_type = 'AUTHORITY_DECISION' then
    select jsonb_build_object('authority_type', d.authority_type, 'outcome', d.outcome, 'status', d.status,
                              'decided_at', d.decided_at, 'decided_by_label', d.decided_by_label,
                              'source_document_reference', d.source_document_reference,
                              'package_round', d.package_round,
                              'items', coalesce((select jsonb_agg(jsonb_build_object('item_id', x.item_id,
                                                                                     'outcome', x.outcome,
                                                                                     'modification', x.modification)
                                                                  order by x.item_id)
                                                   from decision.authority_item_decision x
                                                  where x.decision_id = d.id), '[]'::jsonb))
      into v
      from decision.authority_decision d
     where d.id = p_object_id and d.case_id = p_case_id and authz.can_view_recommendation_package(d.package_id);
  elsif p_object_type = 'MINUTES' then
    -- Approved minutes only, and their narrative only: never the review trail or the attendance snapshot.
    select jsonb_build_object('version_no', m.version_no, 'status', m.status, 'finalised_at', m.finalised_at,
                              'narrative', m.narrative)
      into v
      from committee.minutes m
     where m.id = p_object_id and m.case_id = p_case_id and m.status in ('APPROVED', 'DEEMED_APPROVED')
       and (authz.can_view_meeting_deliberation(m.meeting_id) or authz.can_view_case(m.case_id));
  end if;
  return v;
end;
$$;

-- The export as the caller may see it, and its hash. Withheld items keep their place with no content.
create function exchange.build_document(p_request_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'request_id', q.id, 'case_id', q.case_id, 'case_number', c.case_number, 'classification', c.classification,
    'is_restricted', c.is_restricted, 'format', q.format, 'audience', q.audience, 'purpose', q.purpose,
    'external_party', q.external_party, 'justification', q.justification,
    'recipients', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'user_id', r.user_id, 'email', r.email)
                                             order by r.kind, coalesce(r.user_id::text, r.email))
                              from exchange.export_recipient r where r.request_id = q.id), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('position', i.position, 'object_type', i.object_type,
                                                           'object_id', i.object_id, 'included', x.content is not null,
                                                           'content', x.content) order by i.position)
                         from exchange.export_item i
                         cross join lateral (select exchange.render_item(i.object_type, i.object_id, q.case_id) as content) x
                        where i.request_id = q.id), '[]'::jsonb))
  from exchange.export_request q join case_mgmt.case_record c on c.id = q.case_id
  where q.id = p_request_id;
$$;

create function exchange.document_hash(p_document jsonb)
returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_document::text, 'UTF8')), 'hex');
$$;

create function exchange.withheld_count(p_document jsonb)
returns int
language sql immutable
set search_path = ''
as $$
  select count(*)::int from jsonb_array_elements(p_document -> 'items') e where not (e ->> 'included')::boolean;
$$;

-- Rules in force that match the request now (Q99): audience, the case's classification and restriction, and the
-- content types it holds.
create function exchange.matched_rules(p_request_id uuid)
returns table (code text, action text)
language sql stable
set search_path = ''
as $$
  select r.code, r.action
  from exchange.export_request q
  join case_mgmt.case_record c on c.id = q.case_id
  join exchange.approval_rule r
    on r.effective_from <= now() and (r.effective_to is null or r.effective_to > now()) and r.action <> 'NONE'
   and r.audience in ('ANY', q.audience)
   and (r.min_classification is null or c.classification >= r.min_classification)
   and (not r.restricted_only or c.is_restricted)
   and (r.object_type is null
        or exists (select 1 from exchange.export_item i where i.request_id = q.id and i.object_type = r.object_type))
  where q.id = p_request_id
  order by r.code;
$$;

-- External exports need one approval; a matching REQUIRE_SECOND_APPROVAL rule adds one.
create function exchange.approvals_required(p_request_id uuid)
returns int
language sql stable
set search_path = ''
as $$
  select (case q.audience when 'EXTERNAL' then 1 else 0 end)
         + (case when exists (select 1 from exchange.matched_rules(q.id) m where m.action = 'REQUIRE_SECOND_APPROVAL')
                 then 1 else 0 end)
  from exchange.export_request q where q.id = p_request_id;
$$;

-- Internal recipients must still be active and able to see the case (clearance, no conflict, access basis).
create function exchange.recipients_eligible(p_request_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select not exists (
    select 1 from exchange.export_recipient r join exchange.export_request q on q.id = r.request_id
    where r.request_id = p_request_id and r.kind = 'INTERNAL' and not authz.user_can_view_case(r.user_id, q.case_id)
  );
$$;

-- Who may give an approval stage: holds the stage's permission, can see the case, is not the requester and has not
-- approved this request already. Internal (it answers about other users).
create function exchange.eligible_approvers(p_request_id uuid, p_stage int)
returns table (user_id uuid)
language sql stable
set search_path = ''
as $$
  select u.id
  from exchange.export_request q
  join iam.user_profile u on u.status = 'ACTIVE' and u.id <> q.requested_by
  where q.id = p_request_id
    and authz.user_has_permission(u.id, case p_stage when 1 then 'EXPORT_APPROVE' else 'EXPORT_SECOND_APPROVE' end)
    and authz.user_can_view_case(u.id, q.case_id)
    and not exists (select 1 from exchange.export_approval a where a.request_id = q.id and a.approver_id = u.id);
$$;

-- Locks a request the caller can see. With p_own, only its requester, still holding EXPORT_REQUEST, may act on it.
create function exchange.lock_request(p_request_id uuid, p_own boolean)
returns exchange.export_request
language plpgsql
set search_path = ''
as $$
declare v exchange.export_request;
begin
  if p_request_id is null or not authz.can_view_export(p_request_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v from exchange.export_request q where q.id = p_request_id for update;
  if p_own and (v.requested_by <> authz.current_user_id() or not authz.has_permission('EXPORT_REQUEST')) then
    perform api._fail('FORBIDDEN');
  end if;
  return v;
end;
$$;

-- A draft its requester changes: any change clears the preview, so it must be looked at again before submission.
create function exchange.touch_draft(p_request_id uuid)
returns void
language sql
set search_path = ''
as $$
  update exchange.export_request
     set preview_hash = null, previewed_at = null, updated_at = now(), row_version = row_version + 1
   where id = p_request_id;
$$;

revoke all on function
  exchange.protect_records(), exchange.render_item(text, uuid, uuid), exchange.build_document(uuid),
  exchange.document_hash(jsonb), exchange.withheld_count(jsonb), exchange.matched_rules(uuid),
  exchange.approvals_required(uuid), exchange.recipients_eligible(uuid), exchange.eligible_approvers(uuid, int),
  exchange.lock_request(uuid, boolean), exchange.touch_draft(uuid)
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Notifications (ADR-025): ids only; the export page re-authorizes
-- -----------------------------------------------------------------------------
alter table notify.template drop constraint template_object_type_check;
alter table notify.template add constraint template_object_type_check check (object_type in (
  'COMMITTEE', 'MEETING', 'MINUTES', 'LEGAL_REVIEW', 'DEFENCE_NOTICE', 'GRIEVANCE', 'EXPORT'));
alter table notify.outbox drop constraint outbox_object_type_check;
alter table notify.outbox add constraint outbox_object_type_check check (object_type in (
  'COMMITTEE', 'MEETING', 'MINUTES', 'LEGAL_REVIEW', 'DEFENCE_NOTICE', 'GRIEVANCE', 'EXPORT'));

insert into notify.template (code, object_type, is_mandatory, description) values
  ('EXPORT_APPROVAL_REQUESTED', 'EXPORT', true, 'An export awaits the user''s approval (Q99)'),
  ('EXPORT_DECIDED',            'EXPORT', true, 'The user''s export was approved or rejected (Q99)');
insert into notify.rule (layer, template_code, channel, enabled, effective_from, reason)
select 'SYSTEM_MANDATORY', t.code, c.channel, true, '2026-01-01T00:00:00Z', 'Synthetic default: mandatory notice (ADR-025)'
from notify.template t cross join (values ('IN_APP'), ('EMAIL')) c (channel)
where t.code in ('EXPORT_APPROVAL_REQUESTED', 'EXPORT_DECIDED');

create or replace function notify.deep_link(p_object_type text, p_object_id uuid)
returns text
language sql immutable
set search_path = ''
as $$
  select case p_object_type
           when 'COMMITTEE' then '/committees/' || p_object_id
           when 'MEETING' then '/meetings/' || p_object_id
           when 'MINUTES' then '/minutes/' || p_object_id
           when 'LEGAL_REVIEW' then '/legal-reviews/' || p_object_id
           when 'DEFENCE_NOTICE' then '/my-defence/' || p_object_id
           when 'GRIEVANCE' then '/grievances/' || p_object_id
           when 'EXPORT' then '/exports/' || p_object_id
         end;
$$;

-- Submission asks the stage-1 approvers; a first approval of a two-approval export asks the stage-2 approvers; the
-- final decision tells the requester. A request approved at submission (no approval needed) notifies nobody.
create function notify.on_export_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage int;
  v_user uuid;
begin
  if new.status = 'SUBMITTED' then
    v_stage := 1 + (select count(*)::int from exchange.export_approval a where a.request_id = new.id);
    for v_user in select e.user_id from exchange.eligible_approvers(new.id, v_stage) e loop
      perform notify.enqueue('EXPORT_APPROVAL_REQUESTED', v_user, new.id, null,
                             'export-approval:' || new.id || ':' || v_stage);
    end loop;
  elsif old.status = 'SUBMITTED' and new.status in ('APPROVED', 'REJECTED') then
    perform notify.enqueue('EXPORT_DECIDED', new.requested_by, new.id, null, 'export-decided:' || new.id);
  end if;
  return null;
end;
$$;
create trigger export_request_notify after update on exchange.export_request
  for each row when (old.status is distinct from new.status or old.row_version is distinct from new.row_version)
  execute function notify.on_export_request();
revoke all on function notify.on_export_request() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Rule administration
-- -----------------------------------------------------------------------------
create function api.set_export_rule(
  p_code text, p_audience text, p_min_classification core.classification_level, p_object_type text,
  p_restricted_only boolean, p_action text, p_effective_from timestamptz, p_source_status text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_reason text;
begin
  if not authz.has_permission('EXPORT_POLICY_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{2,59}$' then perform api._fail('INVALID', 'code'); end if;
  if p_audience is null or p_audience not in ('INTERNAL', 'EXTERNAL', 'ANY') then
    perform api._fail('INVALID', 'audience');
  end if;
  if p_object_type is not null and p_object_type not in (
       'CASE_SUMMARY', 'FINDING', 'RECOMMENDATION_PACKAGE', 'AUTHORITY_DECISION', 'MINUTES') then
    perform api._fail('INVALID', 'object_type');
  end if;
  if p_restricted_only is null then perform api._fail('INVALID', 'restricted_only'); end if;
  if p_action is null or p_action not in ('REQUIRE_SECOND_APPROVAL', 'REFUSE', 'NONE') then
    perform api._fail('INVALID', 'action');
  end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  if p_source_status is null or p_source_status not in ('SOURCE_REQUIRED', 'APPROVED') then
    perform api._fail('INVALID', 'source_status');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  -- One version per code at a time: the version in force ends where the new one starts.
  perform pg_advisory_xact_lock(hashtext('exchange.approval_rule:' || p_code));
  if exists (select 1 from exchange.approval_rule r where r.code = p_code and r.effective_from >= p_effective_from) then
    perform api._fail('CONFLICT', 'LATER_RULE_EXISTS');
  end if;
  update exchange.approval_rule set effective_to = p_effective_from where code = p_code and effective_to is null;
  insert into exchange.approval_rule (code, audience, min_classification, object_type, restricted_only, action,
                                      source_status, reason, effective_from, created_by)
  values (p_code, p_audience, p_min_classification, p_object_type, p_restricted_only, p_action, p_source_status,
          v_reason, p_effective_from, v_actor)
  returning id into v_id;
  perform audit.record_event('EXPORT_RULE_SET', 'ADMIN', 'SUCCESS', null, 'export_approval_rule', v_id::text, v_reason,
    jsonb_build_object('code', p_code, 'audience', p_audience, 'min_classification', p_min_classification,
                       'object_type', p_object_type, 'restricted_only', p_restricted_only, 'action', p_action,
                       'effective_from', p_effective_from, 'source_status', p_source_status));
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Preparing an export (the requester, on a draft)
-- -----------------------------------------------------------------------------
create function api.create_export_request(
  p_case_id uuid, p_format text, p_audience text, p_purpose text, p_external_party text, p_justification text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
  v_party text;
  v_justification text;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('EXPORT_REQUEST') then perform api._fail('FORBIDDEN'); end if;
  if p_format is null or p_format not in ('PDF', 'XLSX', 'EMAIL') then perform api._fail('INVALID', 'format'); end if;
  if p_audience is null or p_audience not in ('INTERNAL', 'EXTERNAL') then perform api._fail('INVALID', 'audience'); end if;
  if p_purpose is null or p_purpose not in (
       'AUTHORITY_SUBMISSION', 'REGULATOR_REQUEST', 'LEGAL_COUNSEL', 'INTERNAL_REPORTING', 'AUDIT', 'OTHER') then
    perform api._fail('INVALID', 'purpose');
  end if;
  if p_audience = 'EXTERNAL' then
    -- Q99: external sending always needs a justification, and names who receives it.
    v_party := api._require_text(p_external_party, 'external_party', 3, 200);
    v_justification := api._require_text(p_justification, 'justification', 20, 2000);
  else
    if nullif(btrim(coalesce(p_external_party, '')), '') is not null then perform api._fail('INVALID', 'external_party'); end if;
    if nullif(btrim(coalesce(p_justification, '')), '') is not null then
      v_justification := api._require_text(p_justification, 'justification', 20, 2000);
    end if;
  end if;
  insert into exchange.export_request (case_id, format, audience, purpose, external_party, justification, requested_by)
  values (p_case_id, p_format, p_audience, p_purpose, v_party, v_justification, v_actor)
  returning id into v_id;
  perform audit.record_event('EXPORT_REQUESTED', 'BUSINESS', 'SUCCESS', p_case_id, 'export_request', v_id::text, null,
    jsonb_build_object('format', p_format, 'audience', p_audience, 'purpose', p_purpose));
  return v_id;
end;
$$;

-- N16: an item the requester cannot see, on another case or missing answers NOT_FOUND alike.
create function api.add_export_item(p_request_id uuid, p_object_type text, p_object_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v exchange.export_request;
  v_id uuid;
  v_pos int;
begin
  v := exchange.lock_request(p_request_id, true);
  if v.status <> 'DRAFT' then perform api._fail('CONFLICT', 'NOT_DRAFT'); end if;
  if p_object_type is null or p_object_type not in (
       'CASE_SUMMARY', 'FINDING', 'RECOMMENDATION_PACKAGE', 'AUTHORITY_DECISION', 'MINUTES') then
    perform api._fail('INVALID', 'object_type');
  end if;
  if p_object_id is null or exchange.render_item(p_object_type, p_object_id, v.case_id) is null then
    perform api._fail('NOT_FOUND');
  end if;
  if exists (select 1 from exchange.export_item i
             where i.request_id = v.id and i.object_type = p_object_type and i.object_id = p_object_id) then
    perform api._fail('CONFLICT', 'ALREADY_ADDED');
  end if;
  select coalesce(max(i.position), 0) + 1 into v_pos from exchange.export_item i where i.request_id = v.id;
  if v_pos > 50 then perform api._fail('CONFLICT', 'TOO_MANY_ITEMS'); end if;
  insert into exchange.export_item (request_id, position, object_type, object_id, added_by)
  values (v.id, v_pos, p_object_type, p_object_id, v_actor)
  returning id into v_id;
  perform exchange.touch_draft(v.id);
  perform audit.record_event('EXPORT_ITEM_ADDED', 'BUSINESS', 'SUCCESS', v.case_id, 'export_request', v.id::text, null,
    jsonb_build_object('object_type', p_object_type, 'object_id', p_object_id, 'position', v_pos));
  return v_id;
end;
$$;

-- EMAIL only. Internal recipients must be able to see the case; external addresses only on an EXTERNAL export.
create function api.add_export_recipient(p_request_id uuid, p_kind text, p_user_id uuid, p_email text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v exchange.export_request;
  v_id uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  v := exchange.lock_request(p_request_id, true);
  if v.status <> 'DRAFT' then perform api._fail('CONFLICT', 'NOT_DRAFT'); end if;
  if v.format <> 'EMAIL' then perform api._fail('CONFLICT', 'FORMAT_HAS_NO_RECIPIENTS'); end if;
  if p_kind = 'INTERNAL' then
    if v_email <> '' then perform api._fail('INVALID', 'email'); end if;
    if p_user_id is null or not authz.user_can_view_case(p_user_id, v.case_id) then
      perform api._fail('INVALID', 'user_id');
    end if;
    v_email := null;
  elsif p_kind = 'EXTERNAL' then
    if v.audience <> 'EXTERNAL' then perform api._fail('CONFLICT', 'INTERNAL_AUDIENCE'); end if;
    if p_user_id is not null then perform api._fail('INVALID', 'user_id'); end if;
    if v_email !~ '^[a-z0-9._%+-]{1,64}@example\.test$' then perform api._fail('INVALID', 'email'); end if;
  else
    perform api._fail('INVALID', 'kind');
  end if;
  if exists (select 1 from exchange.export_recipient r
             where r.request_id = v.id and (r.user_id = p_user_id or r.email = v_email)) then
    perform api._fail('CONFLICT', 'ALREADY_ADDED');
  end if;
  if (select count(*) from exchange.export_recipient r where r.request_id = v.id) >= 20 then
    perform api._fail('CONFLICT', 'TOO_MANY_RECIPIENTS');
  end if;
  insert into exchange.export_recipient (request_id, kind, user_id, email, added_by)
  values (v.id, p_kind, case p_kind when 'INTERNAL' then p_user_id end, v_email, v_actor)
  returning id into v_id;
  perform exchange.touch_draft(v.id);
  -- The address never enters the audit ledger (§83); internal recipients are named by id.
  perform audit.record_event('EXPORT_RECIPIENT_ADDED', 'BUSINESS', 'SUCCESS', v.case_id, 'export_request', v.id::text,
    null, jsonb_build_object('kind', p_kind, 'user_id', case p_kind when 'INTERNAL' then p_user_id end));
  return v_id;
end;
$$;

-- The rendered export as the caller may see it, with its hash, withheld count and the approvals it needs now. The
-- requester's preview of a draft is what submission is bound to. Every preview is an audited read of case content.
create function api.preview_export(p_request_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v exchange.export_request;
  v_doc jsonb;
  v_hash text;
  v_withheld int;
begin
  v := exchange.lock_request(p_request_id, false);
  v_doc := exchange.build_document(v.id);
  v_hash := exchange.document_hash(v_doc);
  v_withheld := exchange.withheld_count(v_doc);
  if v.status = 'DRAFT' then
    update exchange.export_request set preview_hash = v_hash, previewed_at = now() where id = v.id;
  end if;
  perform audit.record_event('EXPORT_PREVIEWED', 'BUSINESS', 'SUCCESS', v.case_id, 'export_request', v.id::text, null,
    jsonb_build_object('status', v.status, 'items', jsonb_array_length(v_doc -> 'items'), 'withheld', v_withheld,
                       'preview_hash', v_hash));
  return jsonb_build_object(
    'document', v_doc, 'hash', v_hash, 'withheld', v_withheld,
    'approvals_required', exchange.approvals_required(v.id),
    'matched_rules', coalesce((select jsonb_agg(jsonb_build_object('code', m.code, 'action', m.action))
                               from exchange.matched_rules(v.id) m), '[]'::jsonb));
end;
$$;

-- Submission: the requester confirms the case's classification and the hash of the preview they saw; withheld
-- items, ineligible recipients and refusing rules stop it here. With no approval needed it is approved at once.
create function api.submit_export(p_request_id uuid, p_preview_hash text, p_classification core.classification_level)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v exchange.export_request;
  v_class core.classification_level;
  v_doc jsonb;
  v_hash text;
  v_required int;
  v_rules text[];
  v_status text;
begin
  v := exchange.lock_request(p_request_id, true);
  if v.status <> 'DRAFT' then perform api._fail('CONFLICT', 'NOT_DRAFT'); end if;
  if not exists (select 1 from exchange.export_item i where i.request_id = v.id) then
    perform api._fail('CONFLICT', 'NO_ITEMS');
  end if;
  if v.format = 'EMAIL' and not exists (select 1 from exchange.export_recipient r where r.request_id = v.id) then
    perform api._fail('CONFLICT', 'NO_RECIPIENTS');
  end if;
  select c.classification into v_class from case_mgmt.case_record c where c.id = v.case_id;
  if p_classification is null or p_classification <> v_class then
    perform api._fail('CONFLICT', 'CLASSIFICATION_MISMATCH');
  end if;
  v_doc := exchange.build_document(v.id);
  if exchange.withheld_count(v_doc) > 0 then perform api._fail('CONFLICT', 'ITEMS_WITHHELD'); end if;
  v_hash := exchange.document_hash(v_doc);
  if v.preview_hash is null or v.preview_hash <> v_hash or p_preview_hash is distinct from v_hash then
    perform api._fail('CONFLICT', 'PREVIEW_CHANGED');
  end if;
  if not exchange.recipients_eligible(v.id) then perform api._fail('CONFLICT', 'RECIPIENT_NOT_ELIGIBLE'); end if;
  if exists (select 1 from exchange.matched_rules(v.id) m where m.action = 'REFUSE') then
    perform api._fail('CONFLICT', 'REFUSED_BY_RULE');
  end if;
  v_required := exchange.approvals_required(v.id);
  select coalesce(array_agg(m.code order by m.code), '{}') into v_rules from exchange.matched_rules(v.id) m;
  v_status := case when v_required = 0 then 'APPROVED' else 'SUBMITTED' end;
  update exchange.export_request
     set status = v_status, classification_at_submit = v_class, approvals_required = v_required,
         matched_rules = v_rules, submitted_hash = v_hash, submitted_at = now(),
         decided_at = case when v_required = 0 then now() end, updated_at = now(), row_version = row_version + 1
   where id = v.id;
  perform audit.record_event('EXPORT_SUBMITTED', 'BUSINESS', 'SUCCESS', v.case_id, 'export_request', v.id::text,
    v.justification,
    jsonb_build_object('format', v.format, 'audience', v.audience, 'purpose', v.purpose, 'classification', v_class,
                       'items', jsonb_array_length(v_doc -> 'items'),
                       'internal_recipients', (select count(*) from exchange.export_recipient r
                                               where r.request_id = v.id and r.kind = 'INTERNAL'),
                       'external_recipients', (select count(*) from exchange.export_recipient r
                                               where r.request_id = v.id and r.kind = 'EXTERNAL'),
                       'approvals_required', v_required, 'matched_rules', to_jsonb(v_rules), 'preview_hash', v_hash));
  return v_status;
end;
$$;

-- -----------------------------------------------------------------------------
-- Approval (never the requester; the second stage by a different person)
-- -----------------------------------------------------------------------------
create function api.decide_export(p_request_id uuid, p_decision text, p_reason text, p_preview_hash text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v exchange.export_request;
  v_stage int;
  v_doc jsonb;
  v_hash text;
  v_reason text;
  v_required int;
  v_status text;
begin
  v := exchange.lock_request(p_request_id, false);
  if v.status <> 'SUBMITTED' then perform api._fail('CONFLICT', 'NOT_SUBMITTED'); end if;
  v_stage := 1 + (select count(*)::int from exchange.export_approval a where a.request_id = v.id);
  -- Separation of duties: the requester and an earlier approver are refused, as is anyone without the stage's
  -- permission.
  if v.requested_by = v_actor
     or exists (select 1 from exchange.export_approval a where a.request_id = v.id and a.approver_id = v_actor)
     or not authz.has_permission(case v_stage when 1 then 'EXPORT_APPROVE' else 'EXPORT_SECOND_APPROVE' end) then
    perform api._fail('FORBIDDEN');
  end if;
  if p_decision is null or p_decision not in ('APPROVE', 'REJECT') then perform api._fail('INVALID', 'decision'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  v_doc := exchange.build_document(v.id);
  v_hash := exchange.document_hash(v_doc);
  v_required := v.approvals_required;
  -- An approval must see every item, and exactly what was submitted. A rejection releases nothing, so it is always
  -- possible: it records the hash of what the approver saw.
  if p_decision = 'APPROVE' then
    if exchange.withheld_count(v_doc) > 0 then perform api._fail('CONFLICT', 'ITEMS_WITHHELD'); end if;
    if v_hash <> v.submitted_hash or p_preview_hash is distinct from v.submitted_hash then
      perform api._fail('CONFLICT', 'PREVIEW_CHANGED');
    end if;
    if exists (select 1 from exchange.matched_rules(v.id) m where m.action = 'REFUSE') then
      perform api._fail('CONFLICT', 'REFUSED_BY_RULE');
    end if;
    -- A rule that began after submission can raise the approvals needed, never lower them.
    v_required := greatest(v_required, exchange.approvals_required(v.id));
  end if;
  insert into exchange.export_approval (request_id, stage, approver_id, decision, reason, preview_hash)
  values (v.id, v_stage, v_actor, case p_decision when 'APPROVE' then 'APPROVED' else 'REJECTED' end, v_reason, v_hash);
  v_status := case when p_decision = 'REJECT' then 'REJECTED'
                   when v_stage >= v_required then 'APPROVED'
                   else 'SUBMITTED' end;
  update exchange.export_request
     set status = v_status, approvals_required = v_required,
         decided_at = case when v_status <> 'SUBMITTED' then now() end, updated_at = now(),
         row_version = row_version + 1
   where id = v.id;
  perform audit.record_event(case p_decision when 'APPROVE' then 'EXPORT_APPROVED' else 'EXPORT_REJECTED' end,
    'BUSINESS', 'SUCCESS', v.case_id, 'export_request', v.id::text, v_reason,
    jsonb_build_object('stage', v_stage, 'approvals_required', v_required, 'status', v_status, 'preview_hash', v_hash));
  return v_status;
end;
$$;

-- -----------------------------------------------------------------------------
-- Generation and delivery (the requester)
-- -----------------------------------------------------------------------------
-- Re-checks everything as it stands now: items, hash, rules, approvals and recipients. Returns the document to render,
-- the private storage key it is written to and, for EMAIL, the addresses to deliver to. The caller renders and stores
-- the file in the same transaction (ExportService), so a failed write leaves the request APPROVED.
create function api.generate_export(p_request_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v exchange.export_request;
  v_doc jsonb;
  v_hash text;
  v_key text := 'exports/' || gen_random_uuid();
  v_approved int;
begin
  v := exchange.lock_request(p_request_id, true);
  if v.status <> 'APPROVED' then perform api._fail('CONFLICT', 'NOT_APPROVED'); end if;
  v_doc := exchange.build_document(v.id);
  if exchange.withheld_count(v_doc) > 0 then perform api._fail('CONFLICT', 'ITEMS_WITHHELD'); end if;
  v_hash := exchange.document_hash(v_doc);
  if v_hash <> v.submitted_hash then perform api._fail('CONFLICT', 'PREVIEW_CHANGED'); end if;
  if exists (select 1 from exchange.matched_rules(v.id) m where m.action = 'REFUSE') then
    perform api._fail('CONFLICT', 'REFUSED_BY_RULE');
  end if;
  select count(*)::int into v_approved from exchange.export_approval a
   where a.request_id = v.id and a.decision = 'APPROVED';
  if exchange.approvals_required(v.id) > v_approved then perform api._fail('CONFLICT', 'APPROVALS_CHANGED'); end if;
  if not exchange.recipients_eligible(v.id) then perform api._fail('CONFLICT', 'RECIPIENT_NOT_ELIGIBLE'); end if;
  update exchange.export_request
     set status = 'GENERATED', storage_key = v_key, generated_at = now(), updated_at = now(),
         row_version = row_version + 1
   where id = v.id;
  perform audit.record_event('EXPORT_GENERATED', 'BUSINESS', 'SUCCESS', v.case_id, 'export_request', v.id::text, null,
    jsonb_build_object('format', v.format, 'audience', v.audience, 'items', jsonb_array_length(v_doc -> 'items'),
                       'preview_hash', v_hash));
  return jsonb_build_object(
    'storage_key', v_key, 'hash', v_hash, 'document', v_doc,
    'deliver_to', case when v.format = 'EMAIL' then
      coalesce((select jsonb_agg(coalesce(r.email, u.email) order by coalesce(r.email, u.email))
                  from exchange.export_recipient r left join iam.user_profile u on u.id = r.user_id
                 where r.request_id = v.id), '[]'::jsonb)
      else '[]'::jsonb end);
end;
$$;

-- Records that the mail relay accepted an EMAIL export. PRODUCTION_SUBSTITUTION_REQUIRED: the CDF mail relay.
create function api.record_export_sent(p_request_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v exchange.export_request;
begin
  v := exchange.lock_request(p_request_id, true);
  if v.format <> 'EMAIL' then perform api._fail('CONFLICT', 'NOT_EMAIL'); end if;
  if v.status <> 'GENERATED' then perform api._fail('CONFLICT', 'NOT_GENERATED'); end if;
  update exchange.export_request
     set status = 'SENT', sent_at = now(), updated_at = now(), row_version = row_version + 1
   where id = v.id;
  perform audit.record_event('EXPORT_SENT', 'BUSINESS', 'SUCCESS', v.case_id, 'export_request', v.id::text, null,
    jsonb_build_object('internal_recipients', (select count(*) from exchange.export_recipient r
                                               where r.request_id = v.id and r.kind = 'INTERNAL'),
                       'external_recipients', (select count(*) from exchange.export_recipient r
                                               where r.request_id = v.id and r.kind = 'EXTERNAL')));
end;
$$;

create function api.cancel_export(p_request_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v exchange.export_request;
  v_reason text;
begin
  v := exchange.lock_request(p_request_id, true);
  if v.status not in ('DRAFT', 'SUBMITTED', 'APPROVED') then perform api._fail('CONFLICT', 'NOT_CANCELLABLE'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update exchange.export_request
     set status = 'CANCELLED', cancelled_at = now(), updated_at = now(), row_version = row_version + 1
   where id = v.id;
  perform audit.record_event('EXPORT_CANCELLED', 'BUSINESS', 'SUCCESS', v.case_id, 'export_request', v.id::text,
    v_reason, jsonb_build_object('previous_status', v.status));
end;
$$;

grant execute on function
  api.set_export_rule(text, text, core.classification_level, text, boolean, text, timestamptz, text, text),
  api.create_export_request(uuid, text, text, text, text, text),
  api.add_export_item(uuid, text, uuid),
  api.add_export_recipient(uuid, text, uuid, text),
  api.preview_export(uuid),
  api.submit_export(uuid, text, core.classification_level),
  api.decide_export(uuid, text, text, text),
  api.generate_export(uuid),
  api.record_export_sent(uuid),
  api.cancel_export(uuid, text)
to authenticated;
