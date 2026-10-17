-- =============================================================================
-- 2110 Continuity workbook increment (Rebase PR-C; CDF-252)
-- Requirements: §12, §19, §29, §39, §45, §82, §83, §87; owner Q&A Q100; ADR-027, ADR-034; DEC-F30; ambiguity rows
-- AMB-201 (R2) and AMB-210 (R3); scope ruled by the coordinator on 2026-10-17 (2110 = the committee-proceeding scope,
-- AMB-201 without votes and AMB-210 for every import; AMB-211 moves to 2140, CDF-245 to 2180)
--
-- Rulings recorded in ADR-047: F1 (the secretary's import right is seat-based, no role permission added; the
-- ADR-034 §10 BCP_IMPORT grant waits for 2160), the DEC-F30 registry entry as a further condition, F2 (who approves a
-- committee workbook: answered by the owner's decision on AMB-201 of 2026-10-17, below), F3 (what BCP-C1 imports), and
-- AGENT-09's items R1 to R5, adopted as requirements.
--
-- Owner decision on AMB-201 (2026-10-17): a committee workbook becomes authoritative only with two linked records, the
-- final signed CDF minutes uploaded by the secretary and, in the platform, the chair's (or a formally activated acting
-- chair's) approval and each attending eligible member's own attestation, reconciled before commit. A later migration
-- builds that model (ADR-047 names it); until then no committee workbook is submitted, approved or applied.
--
-- This migration adds:
--   1. AMB-210. While an approved import applies a row, the notices that row's command sends are restore notices:
--      an optional one is skipped, a mandatory one goes out dated now and names the workbook row and the original
--      event time. BCP_RESTORE_NOTIFY = MANDATORY_ONLY, the only value defined. The row is named in a
--      transaction-local setting and trusted only when the row carries this transaction's stamp (R3).
--   2. Continuity operators by scope (R1, R5). A registry entry is CASE (as 2040 built, unchanged) or
--      COMMITTEE_PROCEEDING (one proceeding, for an internal account seated as its committee's secretary, through its
--      own command). Neither satisfies the other's workbook.
--   3. Committee-proceeding workbooks (AMB-201 without votes): template BCP-C1 in its own namespace (staging,
--      provenance, re-import, revocation), seen only by its importer and its approvers, its batch events under no
--      case. 09_MEETINGS records a meeting already held, inside the offline window (R2); 11_CONFLICTS raises a
--      paper-noted conflict as the secretary, never about the importer, and its subject never reads the row nor
--      approves the batch (R4). 10_ATTENDANCE, 12_VOTES and 22_DOCUMENT_INDEX stay recorded only. A committee
--      workbook stages, resolves, previews and cancels; it is not submitted until its official record exists
--      (CONFLICT:OFFICIAL_RECORD_REQUIRED), so nobody approves or applies one here.
--   4. Grants and the catalogue.
-- No role gains a permission and no existing check is relaxed: the case workbook, api.authorize_continuity_operator,
-- committee.insert_meeting, api.schedule_meeting and api.raise_meeting_conflict keep their checks.
-- =============================================================================

-- =============================================================================
-- 1. Restore notices (AMB-210)
-- =============================================================================
-- An offline event that reaches the platform days later must not produce a notice that reads as if it had just
-- happened, nor a pile of optional ones. A mandatory notice still goes out (a member must still learn of a meeting
-- or a conflict to decide), dated when it is sent, with the import row it came from and the original event time.
insert into config.setting (key, value, status, source_reference, description) values
  ('BCP_RESTORE_NOTIFY', 'MANDATORY_ONLY', 'CONFIGURED', 'AMB-210 proposed resolution (R3)',
   'AMB-210: notices for offline events recorded by a continuity import. MANDATORY_ONLY: a mandatory notice goes out '
   'dated now with a reference to the original event; an optional one is skipped. No other value is defined; a '
   'migration adds one if a source decides it.');
alter table config.setting add constraint setting_bcp_restore_notify
  check (key <> 'BCP_RESTORE_NOTIFY' or (status = 'CONFIGURED' and value = 'MANDATORY_ONLY'));

alter table notify.outbox
  add column restored_row_id uuid references exchange.bcp_import_row (id),
  add column original_event_at timestamptz,
  add constraint outbox_restored check ((restored_row_id is null) = (original_event_at is null));
create index outbox_restored_row on notify.outbox (restored_row_id) where restored_row_id is not null;
comment on column notify.outbox.restored_row_id is
  'AMB-210 (migration 2110): the continuity-workbook row whose import sent this notice; null for a live event.';
comment on column notify.outbox.original_event_at is
  'AMB-210 (migration 2110): when the event happened offline, as the workbook row records it.';

-- Replaces 1920: the two restore columns are facts too.
create or replace function notify.protect_outbox()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'notify.outbox rows cannot be deleted' using errcode = '42501';
  end if;
  if (new.id, new.recipient_id, new.template_code, new.channel, new.object_type, new.object_id, new.deep_link,
      new.dedupe_key, new.created_at, new.restored_row_id, new.original_event_at)
     is distinct from
     (old.id, old.recipient_id, old.template_code, old.channel, old.object_type, old.object_id, old.deep_link,
      old.dedupe_key, old.created_at, old.restored_row_id, old.original_event_at) then
    raise exception 'notify.outbox facts are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- R3 (AGENT-09, early look): a transaction-local setting can be set by any caller, so it only names the row; trust
-- comes from the row itself. exchange.bcp_run stamps each row it applies with the applying transaction's id
-- (applying_xact), once, and the stamp can be written only while its batch is APPROVED (exchange.protect_bcp below).
-- The stamp is kept: it records the transaction that applied the row.
alter table exchange.bcp_import_row add column applying_xact xid8;
comment on column exchange.bcp_import_row.applying_xact is
  'AMB-210 (migration 2110): the transaction that applied this row of an approved import; set once, by '
  'exchange.bcp_run. A restore notice is sent only from inside that transaction.';

-- Replaces 2040: as built, plus the one write an applied row takes, its applying_xact stamp, from the applying
-- transaction, once, while its batch is APPROVED.
create or replace function exchange.protect_bcp()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_fixed text[];
  v_status text;
begin
  if tg_table_name = 'bcp_import_batch' then
    -- 2110: a batch's scope and proceeding are part of its identity (section 3.2).
    v_fixed := array['id', 'case_id', 'template_version', 'workbook_id', 'file_sha256', 'control', 'offline_from',
                     'offline_to', 'prepared_by', 'imported_by', 'created_at', 'scope', 'committee_proceeding_id'];
    if old.status in ('IMPORTED', 'REJECTED', 'CANCELLED')
       or (select jsonb_object_agg(k, to_jsonb(new) -> k) from unnest(v_fixed) k)
          <> (select jsonb_object_agg(k, to_jsonb(old) -> k) from unnest(v_fixed) k)
       or (old.submitted_hash is not null and new.submitted_hash is distinct from old.submitted_hash) then
      raise exception 'continuity import % is final or its identity is immutable', old.id
        using errcode = 'insufficient_privilege';
    end if;
  else
    select b.status into v_status from exchange.bcp_import_batch b where b.id = old.batch_id;
    if v_status = 'APPROVED' and old.applying_xact is null and new.applying_xact = pg_current_xact_id()
       and (to_jsonb(new) - 'applying_xact') = (to_jsonb(old) - 'applying_xact') then
      return new;
    end if;
    if v_status in ('IMPORTED', 'REJECTED', 'CANCELLED') and old.purged_at is null and new.purged_at is not null
       and new.cells = '{}'::jsonb
       and (to_jsonb(new) - array['cells', 'purged_at']) = (to_jsonb(old) - array['cells', 'purged_at']) then
      return new;
    end if;
    if v_status <> 'STAGED' or old.purged_at is not null
       or (to_jsonb(new) - array['resolution', 'resolution_reason', 'resolved_by', 'resolved_at', 'outcome'])
          <> (to_jsonb(old) - array['resolution', 'resolution_reason', 'resolved_by', 'resolved_at', 'outcome']) then
      raise exception 'staged continuity row % is fixed', old.id using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

-- The row an approved import is applying in this transaction, if any. exchange.bcp_run names it in a
-- transaction-local setting; the name is believed only for a row resolved IMPORT of an APPROVED batch that the caller
-- imports and that this very transaction has stamped as applying it (R3). A setting nobody may use, or one naming a
-- row from another transaction, is ignored and the notice goes out as a live one.
create function exchange.bcp_restoring_row()
returns table (row_id uuid, original_event_at timestamptz)
language plpgsql stable
set search_path = ''
as $$
declare v_name text := current_setting('cdf.bcp_restore_row', true);
begin
  if v_name is null or not exchange.bcp_is_uuid(v_name) then return; end if;
  return query
    select r.id, r.original_event_at
    from exchange.bcp_import_row r join exchange.bcp_import_batch b on b.id = r.batch_id
    where r.id = v_name::uuid and r.resolution = 'IMPORT' and b.status = 'APPROVED'
      and b.imported_by = authz.current_user_id() and r.applying_xact = pg_current_xact_id();
end;
$$;
revoke all on function exchange.bcp_restoring_row() from public, anon, authenticated;

-- Replaces 1920 (AMB-210): inside an import, an optional notice is skipped and a mandatory one names the row.
create or replace function notify.enqueue(
  p_template text, p_recipient uuid, p_object_id uuid, p_committee_id uuid, p_dedupe text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_type text;
  v_mandatory boolean;
  v_channel text;
  v_row uuid;
  v_event_at timestamptz;
begin
  if p_recipient is null then return; end if;
  if not exists (select 1 from iam.user_profile u where u.id = p_recipient and u.status = 'ACTIVE') then return; end if;
  select t.object_type, t.is_mandatory into strict v_type, v_mandatory from notify.template t where t.code = p_template;
  select x.row_id, x.original_event_at into v_row, v_event_at from exchange.bcp_restoring_row() x;
  if v_row is not null and not v_mandatory then return; end if;
  foreach v_channel in array array['IN_APP', 'EMAIL'] loop
    if notify.delivers(p_template, v_channel, p_recipient, p_committee_id) then
      insert into notify.outbox (recipient_id, template_code, channel, object_type, object_id, deep_link, dedupe_key,
                                 status, delivered_at, restored_row_id, original_event_at)
      values (p_recipient, p_template, v_channel, v_type, p_object_id, notify.deep_link(v_type, p_object_id),
              p_dedupe || ':' || p_recipient || ':' || v_channel,
              case v_channel when 'IN_APP' then 'SENT' else 'PENDING' end,
              case v_channel when 'IN_APP' then clock_timestamp() end, v_row, v_event_at)
      on conflict (dedupe_key) do nothing;
    end if;
  end loop;
end;
$$;


-- =============================================================================
-- 2. Continuity operators by scope (F1, ruled 2026-10-17; AGENT-09 R1 and R5)
-- =============================================================================
-- DEC-F30 (owner decision, built in 2040): "authorized continuity users. Never inferred from broad system roles. An
-- explicit BCP_CONTINUITY_OPERATOR entitlement or approved continuity-user registry; membership needs explicit
-- authorization and audit. The named population is administrative configuration."
-- A registry entry now has a scope. CASE is the entry 2040 built, unchanged: api.authorize_continuity_operator still
-- requires BCP_IMPORT and writes CASE entries only, and the case workbook's checks read CASE entries only.
-- COMMITTEE_PROCEEDING is new: one proceeding, authorized by the continuity administrator only for an internal
-- account holding a secretary seat on that proceeding's committee, through its own command. The committee importer
-- needs that entry, the seat and the proceeding gate at every step (exchange.bcp_committee_importer); no role gains a
-- permission (the ADR-034 §10 BCP_IMPORT grant to COMMITTEE_SECRETARY waits for 2160). Neither kind of entry
-- satisfies the other's workbook.
alter table exchange.bcp_continuity_operator
  add column scope text not null default 'CASE' check (scope in ('CASE', 'COMMITTEE_PROCEEDING')),
  add column committee_proceeding_id uuid references committee.committee_proceeding (id),
  add constraint bcp_continuity_operator_scope
    check ((scope = 'COMMITTEE_PROCEEDING') = (committee_proceeding_id is not null));
comment on column exchange.bcp_continuity_operator.scope is
  'Migration 2110 (ADR-047): CASE (the case workbook, BCP_IMPORT required, as 2040 built) or COMMITTEE_PROCEEDING '
  '(one proceeding''s committee workbook, secretary seat required). An entry satisfies only its own scope.';
drop index exchange.bcp_continuity_operator_active;
create unique index bcp_continuity_operator_active on exchange.bcp_continuity_operator (user_id)
  where revoked_at is null and scope = 'CASE';
create unique index bcp_continuity_operator_active_proceeding
  on exchange.bcp_continuity_operator (user_id, committee_proceeding_id)
  where revoked_at is null and scope = 'COMMITTEE_PROCEEDING';
create index bcp_continuity_operator_proceeding on exchange.bcp_continuity_operator (committee_proceeding_id);

-- Replaces 2040: a CASE entry, as every entry was before 2110.
create or replace function exchange.is_continuity_operator(p_user_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from exchange.bcp_continuity_operator o
                 where o.user_id = p_user_id and o.revoked_at is null and o.scope = 'CASE');
$$;

create function exchange.is_committee_continuity_operator(p_user_id uuid, p_committee_proceeding_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from exchange.bcp_continuity_operator o
                 where o.user_id = p_user_id and o.revoked_at is null and o.scope = 'COMMITTEE_PROCEEDING'
                   and o.committee_proceeding_id = p_committee_proceeding_id);
$$;

-- The committee workbook's importer (F1, DEC-F30 addition 18:11, R1, R5): an internal account, holding a secretary
-- seat on the proceeding's committee now, passing the proceeding's case gate, with a current COMMITTEE_PROCEEDING
-- registry entry for this proceeding. Checked at staging, by the batch insert trigger, at every step of the importer
-- (exchange.lock_bcp_batch) and for seeing the batch at all (authz.can_view_bcp_import).
create function exchange.bcp_committee_importer(p_user_id uuid, p_committee_proceeding_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1 from committee.committee_proceeding cp
    where cp.id = p_committee_proceeding_id
      and not authz.is_external_account(p_user_id)
      and coalesce(authz.user_committee_seat(p_user_id, cp.committee_id, now()) in ('SECRETARY', 'ALTERNATE_SECRETARY'),
                   false)
      and authz.user_case_gate(p_user_id, cp.case_id)
      and exchange.is_committee_continuity_operator(p_user_id, cp.id)
  );
$$;

-- For policies: whether the caller is the committee importer of a proceeding.
create function authz.is_bcp_committee_importer(p_committee_proceeding_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exchange.bcp_committee_importer(authz.current_user_id(), p_committee_proceeding_id);
$$;

-- Replaces 2040: whatever path stages a workbook, its importer holds a current registry entry of the workbook's scope
-- (T-AMB-116), and a committee workbook's importer meets every condition above.
create or replace function exchange.require_continuity_operator()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.scope = 'CASE' then
    if not exchange.is_continuity_operator(new.imported_by) then perform api._fail('FORBIDDEN'); end if;
  elsif not exchange.bcp_committee_importer(new.imported_by, new.committee_proceeding_id) then
    perform api._fail('FORBIDDEN');
  end if;
  return new;
end;
$$;

-- R1: a COMMITTEE_PROCEEDING entry. The continuity administrator (BCP_CONTINUITY_ADMIN), never for themselves, for an
-- ACTIVE internal account (R5) that holds a secretary seat on the proceeding's committee now; the proceeding must be
-- OPEN. One refusal code whether the proceeding is unknown or closed or the user holds no such seat, so the
-- administrator learns nothing more about proceedings. Once per user and proceeding; audited with ids.
create function api.authorize_committee_continuity_operator(
  p_user_id uuid, p_committee_proceeding_id uuid, p_authorization_reference text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_cp committee.committee_proceeding;
  v_id uuid;
  v_reference text;
  v_reason text;
begin
  if not authz.has_permission('BCP_CONTINUITY_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_user_id is null or not exists (select 1 from iam.user_profile u where u.id = p_user_id and u.status = 'ACTIVE') then
    perform api._fail('INVALID', 'user_id');
  end if;
  if p_user_id = v_actor then perform api._fail('FORBIDDEN'); end if;
  if authz.is_external_account(p_user_id) then perform api._fail('CONFLICT', 'OPERATOR_EXTERNAL'); end if;
  select * into v_cp from committee.committee_proceeding cp where cp.id = p_committee_proceeding_id;
  if v_cp.id is null or v_cp.status <> 'OPEN'
     or not coalesce(authz.user_committee_seat(p_user_id, v_cp.committee_id, now()) in ('SECRETARY', 'ALTERNATE_SECRETARY'),
                     false) then
    perform api._fail('CONFLICT', 'OPERATOR_NOT_SECRETARY');
  end if;
  v_reference := api._require_text(p_authorization_reference, 'authorization_reference', 3, 300);
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  perform pg_advisory_xact_lock(hashtext('exchange.bcp_continuity_operator:' || p_user_id || ':' || v_cp.id));
  if exchange.is_committee_continuity_operator(p_user_id, v_cp.id) then
    perform api._fail('CONFLICT', 'ALREADY_AUTHORIZED');
  end if;
  insert into exchange.bcp_continuity_operator (user_id, authorization_reference, reason, authorized_by, scope,
                                                committee_proceeding_id)
  values (p_user_id, v_reference, v_reason, v_actor, 'COMMITTEE_PROCEEDING', v_cp.id)
  returning id into v_id;
  perform audit.record_event('BCP_OPERATOR_AUTHORIZED', 'ADMIN', 'SUCCESS', null, 'bcp_continuity_operator',
    v_id::text, v_reason,
    jsonb_build_object('user_id', p_user_id, 'scope', 'COMMITTEE_PROCEEDING', 'committee_proceeding_id', v_cp.id));
  return v_id;
end;
$$;


-- =============================================================================
-- 3. Committee-proceeding workbooks (AMB-201 without votes; ADR-034 §2; F1–F3 ruled 2026-10-17)
-- =============================================================================
-- The committee's offline work is recorded in a workbook scoped to one committee proceeding, template BCP-C1, and
-- imported by that proceeding's committee secretary (section 2). The secretary does not see the case (DEC-02,
-- ADR-031) and the case team does not see the committee's workbook: a committee workbook has its own namespace
-- (proceeding and workbook id) for staging, provenance, re-import and revocation, its batch events carry no case in
-- the ledger, and only its importer and its approvers see it. BCP-1 and the case workbook are unchanged.

-- -----------------------------------------------------------------------------
-- 3.1 Template BCP-C1 (reference data, mirrored in @cdf/contracts as BCP_COMMITTEE_TEMPLATE)
-- -----------------------------------------------------------------------------
-- A committee template's version is BCP-C<n>.
alter table exchange.bcp_template_sheet drop constraint bcp_template_sheet_template_version_check;
alter table exchange.bcp_template_sheet add constraint bcp_template_sheet_template_version_check
  check (template_version ~ '^BCP-C?[0-9]{1,3}$');
alter table exchange.bcp_template_sheet drop constraint bcp_template_sheet_command_check;
alter table exchange.bcp_template_sheet add constraint bcp_template_sheet_command_check
  check (command in ('add_case_subject', 'add_allegation', 'record_defence_response', 'open_corrective_action',
                     'record_offline_meeting', 'raise_meeting_conflict'));
alter table exchange.bcp_template_sheet drop constraint bcp_template_sheet_object_type_check;
alter table exchange.bcp_template_sheet add constraint bcp_template_sheet_object_type_check
  check (object_type in ('case_subject', 'allegation', 'defence_response', 'corrective_action', 'meeting',
                         'meeting_conflict_concern'));

-- 09_MEETINGS imports a meeting already held (R2); 11_CONFLICTS raises a conflict noted on paper, as the secretary
-- (F3). 10_ATTENDANCE stays recorded only: attendance is entered online after each member declares in-platform
-- (N4, AMB-158; F3). 12_VOTES waits for 2120 (DEC-AMB-008) and 22_DOCUMENT_INDEX for 2180 (CDF-245).
insert into exchange.bcp_template_sheet (template_version, sheet_code, position, sheet_kind, command, object_type) values
  ('BCP-C1', '00_README', 0, 'README', null, null),
  ('BCP-C1', '01_CONTROL', 1, 'CONTROL', null, null),
  ('BCP-C1', '09_MEETINGS', 9, 'DATA', 'record_offline_meeting', 'meeting'),
  ('BCP-C1', '10_ATTENDANCE', 10, 'DATA', null, null),
  ('BCP-C1', '11_CONFLICTS', 11, 'DATA', 'raise_meeting_conflict', 'meeting_conflict_concern'),
  ('BCP-C1', '12_VOTES', 12, 'DATA', null, null),
  ('BCP-C1', '22_DOCUMENT_INDEX', 22, 'DATA', null, null),
  ('BCP-C1', '26_IMPORT_AUDIT', 26, 'PLATFORM_LOG', null, null);

-- The control names the proceeding by id and by its committee's code; the offline window is closed (OFFLINE_TO is
-- required), so every meeting it imports lies inside it.
insert into exchange.bcp_template_column
  (template_version, sheet_code, position, column_code, kind, required, min_length, max_length, allowed) values
  ('BCP-C1', '01_CONTROL', 1, 'TEMPLATE_VERSION', 'VERSION', true, null, 10, null),
  ('BCP-C1', '01_CONTROL', 2, 'WORKBOOK_ID', 'ROW_KEY', true, null, 64, null),
  ('BCP-C1', '01_CONTROL', 3, 'COMMITTEE_PROCEEDING_ID', 'UUID', true, null, 36, null),
  ('BCP-C1', '01_CONTROL', 4, 'COMMITTEE_CODE', 'TEXT', true, 2, 20, null),
  ('BCP-C1', '01_CONTROL', 5, 'OFFLINE_FROM', 'DATETIME', true, null, 40, null),
  ('BCP-C1', '01_CONTROL', 6, 'OFFLINE_TO', 'DATETIME', true, null, 40, null),
  ('BCP-C1', '01_CONTROL', 7, 'PREPARED_BY', 'EMAIL', true, null, 254, null),
  ('BCP-C1', '26_IMPORT_AUDIT', 1, 'BATCH_ID', 'UUID', false, null, 36, null),
  ('BCP-C1', '26_IMPORT_AUDIT', 2, 'IMPORTED_AT', 'DATETIME', false, null, 40, null),
  ('BCP-C1', '26_IMPORT_AUDIT', 3, 'IMPORTED_BY', 'EMAIL', false, null, 254, null),
  ('BCP-C1', '26_IMPORT_AUDIT', 4, 'RESULT', 'TEXT', false, 0, 200, null);

-- Every data sheet starts with the row's identity and its offline provenance, as in BCP-1.
insert into exchange.bcp_template_column
  (template_version, sheet_code, position, column_code, kind, required, min_length, max_length, allowed)
select s.template_version, s.sheet_code, c.position, c.column_code, c.kind, c.required, null, c.max_length, null
from exchange.bcp_template_sheet s
cross join (values (1, 'ROW_ID', 'ROW_KEY', true, 64), (2, 'OBJECT_ID', 'UUID', false, 36),
                   (3, 'ORIGINAL_EVENT_AT', 'DATETIME', true, 40), (4, 'RECORDED_OFFLINE_BY', 'EMAIL', true, 254))
  c (position, column_code, kind, required, max_length)
where s.template_version = 'BCP-C1' and s.sheet_kind = 'DATA';

-- Sheets recorded only: what happened, and the platform object it concerns.
insert into exchange.bcp_template_column
  (template_version, sheet_code, position, column_code, kind, required, min_length, max_length, allowed)
select s.template_version, s.sheet_code, c.position, c.column_code, c.kind, c.required, c.min_length, c.max_length, null
from exchange.bcp_template_sheet s
cross join (values (5, 'REFERENCE_ID', 'UUID', false, null::int, 36), (6, 'DETAILS', 'TEXT', true, 3, 8000))
  c (position, column_code, kind, required, min_length, max_length)
where s.template_version = 'BCP-C1' and s.sheet_kind = 'DATA' and s.command is null;

insert into exchange.bcp_template_column
  (template_version, sheet_code, position, column_code, kind, required, min_length, max_length, allowed) values
  ('BCP-C1', '09_MEETINGS', 5, 'PURPOSE', 'ENUM', true, null, 40, array['DELIBERATION', 'HEARING']),
  ('BCP-C1', '09_MEETINGS', 6, 'MODE', 'ENUM', true, null, 40, array['IN_PERSON', 'TEAMS', 'HYBRID']),
  ('BCP-C1', '09_MEETINGS', 7, 'LOCATION', 'TEXT', false, 2, 200, null),
  ('BCP-C1', '09_MEETINGS', 8, 'ONLINE_URL', 'TEXT', false, 12, 500, null),
  ('BCP-C1', '09_MEETINGS', 9, 'HELD_START', 'DATETIME', true, null, 40, null),
  ('BCP-C1', '09_MEETINGS', 10, 'HELD_END', 'DATETIME', true, null, 40, null),
  ('BCP-C1', '09_MEETINGS', 11, 'PAPER_MINUTES_REFERENCE', 'TEXT', true, 3, 300, null),
  ('BCP-C1', '09_MEETINGS', 12, 'REASON', 'TEXT', true, 5, 2000, null),
  ('BCP-C1', '11_CONFLICTS', 5, 'MEETING_REF', 'REF', true, null, 64, null),
  ('BCP-C1', '11_CONFLICTS', 6, 'PARTICIPANT', 'EMAIL', true, null, 254, null),
  ('BCP-C1', '11_CONFLICTS', 7, 'REASON', 'TEXT', true, 10, 2000, null);

-- Replaces 1960: a VERSION cell may name a committee template.
create or replace function exchange.bcp_cell_ok(p_column exchange.bcp_template_column, p_value text)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_value is null then return not p_column.required; end if;
  if length(p_value) > p_column.max_length then return false; end if;
  case p_column.kind
    when 'VERSION' then return p_value ~ '^BCP-C?[0-9]{1,3}$';
    when 'ROW_KEY', 'REF' then
      return p_value ~ '^BCP-[A-Z0-9][A-Z0-9-]{0,59}$' or exchange.bcp_is_uuid(p_value);
    when 'UUID' then return exchange.bcp_is_uuid(p_value);
    when 'DATETIME' then
      if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
        return false;
      end if;
      begin
        perform p_value::timestamptz;
      exception when others then
        return false;
      end;
      return true;
    when 'DATE' then
      if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
      begin
        perform p_value::date;
      exception when others then
        return false;
      end;
      return true;
    when 'EMAIL' then return p_value ~ '^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,189}$';
    when 'ENUM' then return p_value = any (p_column.allowed);
    when 'CODE' then return p_value ~ '^[A-Z_]{3,40}$';
    when 'TEXT' then return length(p_value) >= p_column.min_length;
    else return false;
  end case;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3.2 A batch's scope and the committee namespace
-- -----------------------------------------------------------------------------
alter table exchange.bcp_import_batch drop constraint bcp_import_batch_template_version_check;
alter table exchange.bcp_import_batch add constraint bcp_import_batch_template_version_check
  check (template_version ~ '^BCP-C?[0-9]{1,3}$');
alter table exchange.bcp_import_batch
  add column scope text not null default 'CASE' check (scope in ('CASE', 'COMMITTEE_PROCEEDING')),
  add column committee_proceeding_id uuid references committee.committee_proceeding (id),
  add constraint bcp_import_batch_scope check ((scope = 'COMMITTEE_PROCEEDING') = (committee_proceeding_id is not null)),
  add constraint bcp_import_batch_scope_template check ((scope = 'COMMITTEE_PROCEEDING') = (template_version ~ '^BCP-C')),
  add constraint bcp_import_batch_committee_window check (scope = 'CASE' or offline_to is not null);
create index bcp_import_batch_proceeding on exchange.bcp_import_batch (committee_proceeding_id);
comment on column exchange.bcp_import_batch.scope is
  'Migration 2110 (ADR-047): CASE (BCP-1, one case) or COMMITTEE_PROCEEDING (BCP-C1, one committee proceeding; '
  'case_id is the proceeding''s case). A committee batch is seen only by its importer and its approvers.';
-- One open batch per workbook in each namespace: the case's, or the proceeding's. A workbook id staged for a
-- proceeding never collides with one staged for its case, so neither team learns of the other's workbook.
drop index exchange.bcp_import_batch_open;
create unique index bcp_import_batch_open on exchange.bcp_import_batch (case_id, workbook_id)
  where status in ('STAGED', 'SUBMITTED', 'APPROVED') and scope = 'CASE';
create unique index bcp_import_batch_open_proceeding on exchange.bcp_import_batch (committee_proceeding_id, workbook_id)
  where status in ('STAGED', 'SUBMITTED', 'APPROVED') and scope = 'COMMITTEE_PROCEEDING';

-- R4: the person an 11_CONFLICTS row is about, resolved at staging among the proceeding's members. They never read
-- the row (bcp_import_row_read) and never approve the batch (exchange.bcp_approver_excluded).
alter table exchange.bcp_import_row
  add column subject_user_id uuid references iam.user_profile (id),
  add constraint bcp_import_row_subject check (subject_user_id is null or sheet_code = '11_CONFLICTS');
create index bcp_import_row_subject on exchange.bcp_import_row (subject_user_id);
comment on column exchange.bcp_import_row.subject_user_id is
  'Migration 2110 (AGENT-09 R4): the member an 11_CONFLICTS row is about. They never read the row nor approve the batch.';

alter table exchange.bcp_provenance
  add column committee_proceeding_id uuid references committee.committee_proceeding (id);
create index bcp_provenance_proceeding on exchange.bcp_provenance (committee_proceeding_id);
alter table exchange.bcp_provenance drop constraint bcp_provenance_object_type_check;
alter table exchange.bcp_provenance add constraint bcp_provenance_object_type_check
  check (object_type in ('case_subject', 'allegation', 'defence_response', 'corrective_action', 'meeting',
                         'meeting_conflict_concern'));
-- Re-import is idempotent within a namespace: the case's rows by case, the proceeding's by proceeding.
alter table exchange.bcp_provenance drop constraint bcp_provenance_case_id_workbook_id_row_key_key;
create unique index bcp_provenance_case_row on exchange.bcp_provenance (case_id, workbook_id, row_key)
  where committee_proceeding_id is null;
create unique index bcp_provenance_proceeding_row on exchange.bcp_provenance (committee_proceeding_id, workbook_id, row_key)
  where committee_proceeding_id is not null;

-- -----------------------------------------------------------------------------
-- 3.3 Who approves a committee workbook (F2): the owner's decision on AMB-201, built by a later migration
-- -----------------------------------------------------------------------------
-- Not a single approver: the signed official minutes, the chair's (or a formally activated acting chair's) approval
-- and each attending eligible member's own attestation, reconciled (ADR-047). Until that model exists a committee
-- workbook is refused at submission and at decision (api.submit_bcp_import, api.decide_bcp_import:
-- CONFLICT:OFFICIAL_RECORD_REQUIRED) and exchange.bcp_eligible_approvers names nobody for it, so it is never approved or
-- applied. Nothing is configured here.


-- -----------------------------------------------------------------------------
-- 3.4 Who sees and who approves (D4, R4, R5)
-- -----------------------------------------------------------------------------
-- Who may never approve a batch (ADR-034 §7, R4, R5): its importer, its preparer, anyone who recorded a row offline,
-- the subject of any conflict row and any external account. Every scope, and every approval path a later migration
-- adds.
create function exchange.bcp_approver_excluded(p_batch_id uuid, p_user_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_user_id is null or authz.is_external_account(p_user_id) or exists (
    select 1 from exchange.bcp_import_batch b
    where b.id = p_batch_id
      and (p_user_id in (b.imported_by, b.prepared_by)
           or exists (select 1 from exchange.bcp_import_row r
                      where r.batch_id = b.id
                        and (r.recorded_offline_by = p_user_id or r.subject_user_id = p_user_id)))
  );
$$;

-- Replaces 1960. A case workbook: holds BCP_IMPORT_APPROVE and can see the case, as built (an external account holds
-- no such permission since 2100 and a case row has no subject, so the shared exclusion changes nobody). A committee
-- workbook: nobody (3.3); its approval is the owner's two-record model, not this list.
create or replace function exchange.bcp_eligible_approvers(p_batch_id uuid)
returns table (user_id uuid)
language sql stable
set search_path = ''
as $$
  select u.id
  from exchange.bcp_import_batch b
  join iam.user_profile u on u.status = 'ACTIVE'
  where b.id = p_batch_id
    and not exchange.bcp_approver_excluded(b.id, u.id)
    and case b.scope
          when 'CASE' then authz.user_has_permission(u.id, 'BCP_IMPORT_APPROVE') and authz.user_can_view_case(u.id, b.case_id)
          else false
        end;
$$;

-- Replaces 1960 (D4). A case workbook as built. A committee workbook: its importer while they are its committee's
-- continuity importer, and its eligible approvers once it is submitted (none: 3.3); never the
-- case team, never the BCP_IMPORT_APPROVE holders.
create or replace function authz.can_view_bcp_import(p_batch_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from exchange.bcp_import_batch b
    where b.id = p_batch_id
      and case b.scope
            when 'CASE' then authz.can_view_case(b.case_id)
                             and (b.imported_by = authz.current_user_id()
                                  or (b.submitted_at is not null and authz.has_permission('BCP_IMPORT_APPROVE')))
            else (b.imported_by = authz.current_user_id()
                  and exchange.bcp_committee_importer(authz.current_user_id(), b.committee_proceeding_id))
                 or (b.submitted_at is not null
                     and exists (select 1 from exchange.bcp_eligible_approvers(b.id) e
                                 where e.user_id = authz.current_user_id()))
          end
  );
$$;

-- Replaces 1960: provenance follows the object it describes; a meeting's with the meeting, a raised conflict's with
-- the conflict (never its subject, R4).
create or replace function authz.can_view_bcp_provenance(p_object_type text, p_object_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and case p_object_type
    when 'corrective_action' then authz.can_view_corrective_action(p_object_id)
    when 'meeting' then authz.can_view_meeting(p_object_id)
    when 'meeting_conflict_concern' then authz.can_view_meeting_concern(p_object_id)
    else authz.can_view_case(p_case_id)
  end;
$$;

-- R4: the subject of a conflict row never reads it, whoever else may.
drop policy bcp_import_row_read on exchange.bcp_import_row;
create policy bcp_import_row_read on exchange.bcp_import_row for select to authenticated
  using (authz.can_view_bcp_import(batch_id) and subject_user_id is distinct from authz.current_user_id());

-- The person a committee workbook names as its preparer or as a row's offline recorder: an ACTIVE internal account
-- seated on the proceeding's committee now and passing its case gate, so provenance never names someone outside the
-- committee. The secretary already sees the committee's seats.
create function exchange.bcp_committee_user(p_email text, p_committee_proceeding_id uuid)
returns uuid
language sql stable
set search_path = ''
as $$
  select u.id from iam.user_profile u
  join committee.committee_proceeding cp on cp.id = p_committee_proceeding_id
  where lower(u.email) = lower(p_email) and u.status = 'ACTIVE' and not authz.is_external_account(u.id)
    and authz.user_committee_seat(u.id, cp.committee_id, now()) is not null
    and authz.user_case_gate(u.id, cp.case_id);
$$;

-- A batch's events in the ledger: a case workbook's under its case, as built; a committee workbook's under no case,
-- with its proceeding in the metadata, so the case team's ledger reads (audit_event_read) do not show them.
create function exchange.bcp_audit_case(p_batch exchange.bcp_import_batch)
returns uuid
language sql stable
set search_path = ''
as $$
  select case when p_batch.scope = 'CASE' then p_batch.case_id end;
$$;

create function exchange.bcp_audit_scope(p_batch exchange.bcp_import_batch)
returns jsonb
language sql stable
set search_path = ''
as $$
  select case when p_batch.scope = 'CASE' then '{}'::jsonb
              else jsonb_build_object('scope', p_batch.scope, 'committee_proceeding_id', p_batch.committee_proceeding_id)
         end;
$$;

-- Replaces 2040: the importer's own steps need, for a case workbook, BCP_IMPORT and a CASE registry entry as built;
-- for a committee workbook, everything exchange.bcp_committee_importer checks. Losing any of them stops the steps.
create or replace function exchange.lock_bcp_batch(p_batch_id uuid, p_own boolean)
returns exchange.bcp_import_batch
language plpgsql
set search_path = ''
as $$
declare v exchange.bcp_import_batch;
begin
  if p_batch_id is null or not authz.can_view_bcp_import(p_batch_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v from exchange.bcp_import_batch b where b.id = p_batch_id for update;
  if p_own and v.scope = 'CASE'
     and (v.imported_by <> authz.current_user_id() or not authz.has_permission('BCP_IMPORT')
          or not exchange.is_continuity_operator(authz.current_user_id())) then
    perform api._fail('FORBIDDEN');
  end if;
  if p_own and v.scope <> 'CASE'
     and (v.imported_by <> authz.current_user_id()
          or not exchange.bcp_committee_importer(authz.current_user_id(), v.committee_proceeding_id)) then
    perform api._fail('FORBIDDEN');
  end if;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3.5 A meeting held offline (09_MEETINGS; AMB-201; F3 and AGENT-09 R2)
-- -----------------------------------------------------------------------------
alter table committee.meeting
  add column held_offline boolean not null default false,
  add column paper_minutes_reference text check (length(paper_minutes_reference) between 3 and 300),
  add constraint meeting_held_offline check (held_offline = (paper_minutes_reference is not null)),
  -- Recorded only once it had ended, and never as an emergency.
  add constraint meeting_held_offline_past check (not held_offline or (scheduled_end <= scheduled_at and not is_emergency));
comment on column committee.meeting.held_offline is
  'AMB-201 (migration 2110): a meeting held during an outage and recorded by a continuity import; scheduled_start and '
  'scheduled_end are the times it was held. Its paper minutes are a document reference until CDF-245 (2180).';

-- The checks of committee.insert_meeting (2030), except the minimum-notice check, which governs scheduling ahead and
-- cannot apply to a meeting already held. In its place (R2): the meeting has ended and lies inside the workbook's
-- offline window. Reachable only from a continuity import's row (exchange.bcp_execute_row, as the importer): no grant,
-- and no parameter or flag on committee.insert_meeting or api.schedule_meeting, which are unchanged. The meeting is
-- created SCHEDULED with the participant snapshot of committee.insert_meeting, taken now (at import), not at the
-- original time; the secretary then opens it, records attendance once each member has declared in-platform, closes
-- it and generates the minutes (F3).
create function exchange.bcp_record_offline_meeting(
  p_batch exchange.bcp_import_batch, p_purpose text, p_mode text, p_location text, p_online_url text,
  p_held_start timestamptz, p_held_end timestamptz, p_paper_minutes_reference text, p_reason text
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_cp committee.committee_proceeding;
  v_m committee.meeting;
  v_reason text;
  v_reference text;
  v_notice int;
  v_members int;
begin
  if p_batch.scope is distinct from 'COMMITTEE_PROCEEDING' then perform api._fail('CONFLICT', 'SHEET_NOT_IMPORTABLE'); end if;
  if not authz.can_view_committee_proceeding(p_batch.committee_proceeding_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_cp from committee.committee_proceeding cp where cp.id = p_batch.committee_proceeding_id for update;
  if not authz.is_committee_secretary(v_cp.committee_id) or not authz.user_case_gate(v_actor, v_cp.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_cp.status <> 'OPEN' then perform api._fail('CONFLICT', 'PROCEEDING_CLOSED'); end if;
  if not exists (select 1 from case_mgmt.case_record c where c.id = v_cp.case_id and c.records_state = 'ACTIVE') then
    perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE');
  end if;
  if p_purpose is null or p_purpose not in ('DELIBERATION', 'HEARING') then perform api._fail('INVALID', 'purpose'); end if;
  if p_mode is null or p_mode not in ('IN_PERSON', 'TEAMS', 'HYBRID') then perform api._fail('INVALID', 'mode'); end if;
  if (p_mode in ('IN_PERSON', 'HYBRID')) <> (p_location is not null) then perform api._fail('INVALID', 'location'); end if;
  if (p_mode in ('TEAMS', 'HYBRID')) <> (p_online_url is not null)
     or (p_online_url is not null and (p_online_url !~ '^https://[^\s]+$' or length(p_online_url) not between 12 and 500)) then
    perform api._fail('INVALID', 'online_url');
  end if;
  if p_held_start is null or p_held_end is null or p_held_end <= p_held_start then
    perform api._fail('INVALID', 'scheduled_end');
  end if;
  -- R2: held already, inside the offline window the workbook declares, and after the case reached the committee.
  if p_held_end > now() then perform api._fail('CONFLICT', 'MEETING_NOT_HELD'); end if;
  if p_batch.offline_to is null or p_held_start < p_batch.offline_from or p_held_start < v_cp.referred_at
     or p_held_end > p_batch.offline_to then
    perform api._fail('CONFLICT', 'OUTSIDE_OFFLINE_WINDOW');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  v_reference := api._require_text(p_paper_minutes_reference, 'paper_minutes_reference', 3, 300);
  -- The notice rule in force is recorded, as for any meeting; it is not applied to a meeting already held.
  v_notice := (v_cp.rule_snapshot ->> 'minimum_notice_days')::int;

  insert into committee.meeting (committee_proceeding_id, case_id, sequence_no, purpose, mode, location, online_url,
                                 scheduled_start, scheduled_end, scheduled_by, is_emergency, emergency_reason,
                                 minimum_notice_days, held_offline, paper_minutes_reference)
  values (v_cp.id, v_cp.case_id,
          (select coalesce(max(m.sequence_no), 0) + 1 from committee.meeting m where m.committee_proceeding_id = v_cp.id),
          p_purpose, p_mode, case when p_location is not null then api._require_text(p_location, 'location', 2, 200) end,
          p_online_url, p_held_start, p_held_end, v_actor, false, null, v_notice, true, v_reference)
  returning * into v_m;

  -- As committee.insert_meeting: members still seated on the committee and cleared for the case, now.
  insert into committee.meeting_participant (meeting_id, participant_kind, proceeding_member_id, user_id, seat, is_voting,
                                             requires_coi, coi_status, added_by)
  select v_m.id, 'MEMBER', pm.id, pm.user_id, pm.seat, pm.is_voting, true, 'PENDING', v_actor
  from committee.proceeding_member pm
  join iam.user_profile u on u.id = pm.user_id and u.status = 'ACTIVE'
  where pm.committee_proceeding_id = v_cp.id and not pm.firewall_restricted and not pm.case_gate_excluded
    and authz.user_committee_seat(pm.user_id, v_cp.committee_id, now()) is not null
    and authz.user_case_gate(pm.user_id, v_cp.case_id);
  get diagnostics v_members = row_count;

  perform audit.record_event('MEETING_RECORDED_OFFLINE', 'BUSINESS', 'SUCCESS', v_cp.case_id, 'meeting', v_m.id::text,
    v_reason,
    jsonb_build_object('committee_proceeding_id', v_cp.id, 'sequence_no', v_m.sequence_no, 'purpose', p_purpose,
                       'mode', p_mode, 'provider', 'MANUAL', 'members', v_members, 'held_offline', true,
                       'minimum_notice_days', v_notice));
  return v_m.id;
end;
$$;


-- -----------------------------------------------------------------------------
-- 3.6 Running a row, and the import
-- -----------------------------------------------------------------------------
-- Replaces 1960. A case workbook's rows exactly as built. A committee workbook's: 09_MEETINGS through
-- exchange.bcp_record_offline_meeting; 11_CONFLICTS through api.raise_meeting_conflict as the importer (the secretary
-- raises; the subject was resolved at staging among the proceeding's members; the meeting is a 09_MEETINGS row of the
-- same workbook or a meeting of the same proceeding). The concern then follows the online decision (DEC-F04); an
-- import never decides it and never records attendance.
create or replace function exchange.bcp_execute_row(p_batch exchange.bcp_import_batch, p_row exchange.bcp_import_row, p_refs jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  c jsonb := p_row.cells;
  v_ref jsonb;
  v_subject uuid;
  v_owner uuid;
  v_object_case uuid;
  v_meeting uuid;
  v_participant uuid;
begin
  if p_batch.scope = 'CASE' then
    case p_row.sheet_code
      when '05_SUBJECTS' then
        return api.add_case_subject(p_batch.case_id, c ->> 'DISPLAY_LABEL', c ->> 'SUBJECT_CATEGORY', null);
      when '06_ALLEGATIONS' then
        if c ? 'SUBJECT_REF' then
          v_ref := p_refs -> (c ->> 'SUBJECT_REF');
          if v_ref is not null then
            if v_ref ->> 'sheet' <> '05_SUBJECTS' then perform api._fail('INVALID', 'SUBJECT_REF'); end if;
            v_subject := (v_ref ->> 'id')::uuid;
          elsif exchange.bcp_is_uuid(c ->> 'SUBJECT_REF') then
            v_subject := (c ->> 'SUBJECT_REF')::uuid;
          else
            perform api._fail('INVALID', 'SUBJECT_REF');
          end if;
        end if;
        return api.add_allegation(p_batch.case_id, c ->> 'CATEGORY', c ->> 'DESCRIPTION', v_subject,
                                  c ->> 'POLICY_REFERENCE', c ->> 'LAW_REFERENCE');
      when '18_EMPLOYEE_NOTICE' then
        select n.case_id into v_object_case from grievance.defence_notice n
         where n.id = (c ->> 'NOTICE_ID')::uuid and authz.can_view_case(n.case_id);
        if v_object_case is distinct from p_batch.case_id then perform api._fail('NOT_FOUND'); end if;
        return api.record_defence_response((c ->> 'NOTICE_ID')::uuid, c ->> 'CHANNEL',
                                           (c ->> 'ORIGINAL_SUBMISSION_DATE')::timestamptz, c ->> 'RESPONSE_TEXT',
                                           c ->> 'ORIGINAL_DOCUMENT_REFERENCE');
      when '21_CORRECTIVE_ACTIONS' then
        select i.case_id into v_object_case from decision.recommendation_item i
         where i.id = (c ->> 'RECOMMENDATION_ITEM_ID')::uuid and authz.can_view_case(i.case_id);
        if v_object_case is distinct from p_batch.case_id then perform api._fail('NOT_FOUND'); end if;
        v_owner := exchange.bcp_user_by_email(c ->> 'OWNER');
        if v_owner is null then perform api._fail('INVALID', 'OWNER'); end if;
        return api.open_corrective_action((c ->> 'RECOMMENDATION_ITEM_ID')::uuid, c ->> 'TITLE', c ->> 'DESCRIPTION',
                                          v_owner, (c ->> 'DUE_DATE')::date);
      else
        perform api._fail('CONFLICT', 'SHEET_NOT_IMPORTABLE');
    end case;
  end if;

  case p_row.sheet_code
    when '09_MEETINGS' then
      return exchange.bcp_record_offline_meeting(p_batch, c ->> 'PURPOSE', c ->> 'MODE', c ->> 'LOCATION',
                                                 c ->> 'ONLINE_URL', (c ->> 'HELD_START')::timestamptz,
                                                 (c ->> 'HELD_END')::timestamptz, c ->> 'PAPER_MINUTES_REFERENCE',
                                                 c ->> 'REASON');
    when '11_CONFLICTS' then
      v_ref := p_refs -> (c ->> 'MEETING_REF');
      if v_ref is not null then
        if v_ref ->> 'sheet' <> '09_MEETINGS' then perform api._fail('INVALID', 'MEETING_REF'); end if;
        v_meeting := (v_ref ->> 'id')::uuid;
      elsif exchange.bcp_is_uuid(c ->> 'MEETING_REF') then
        v_meeting := (c ->> 'MEETING_REF')::uuid;
      else
        perform api._fail('INVALID', 'MEETING_REF');
      end if;
      if not exists (select 1 from committee.meeting m
                     where m.id = v_meeting and m.committee_proceeding_id = p_batch.committee_proceeding_id
                       and authz.can_view_meeting(m.id)) then
        perform api._fail('NOT_FOUND');
      end if;
      -- F3: raised as the secretary running the meeting, never as a member.
      if not committee.manages_meeting(v_meeting, api._actor()) then perform api._fail('FORBIDDEN'); end if;
      select mp.id into v_participant from committee.meeting_participant mp
       where mp.meeting_id = v_meeting and mp.user_id = p_row.subject_user_id;
      if p_row.subject_user_id is null or v_participant is null then perform api._fail('NOT_FOUND'); end if;
      return api.raise_meeting_conflict(v_participant, c ->> 'REASON');
    else
      perform api._fail('CONFLICT', 'SHEET_NOT_IMPORTABLE');
  end case;
  return null;
end;
$$;

-- Replaces 1960 (and AMB-210 above): references and provenance in the workbook's namespace; while a row is applied its
-- notices are restore notices bound to this transaction (R3); BCP_ROW_IMPORTED counts them; a committee workbook's
-- events carry no case in the ledger.
create or replace function exchange.bcp_run(p_batch_id uuid, p_apply boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  b exchange.bcp_import_batch;
  r exchange.bcp_import_row;
  v_object_type text;
  v_refs jsonb;
  v_out jsonb := '{}'::jsonb;
  v_id uuid;
  v_code text;
begin
  select * into b from exchange.bcp_import_batch where id = p_batch_id;
  select coalesce(jsonb_object_agg(p.row_key, jsonb_build_object('sheet', p.sheet_code, 'id', p.object_id)), '{}'::jsonb)
    into v_refs
    from exchange.bcp_provenance p
   where p.case_id = b.case_id and p.workbook_id = b.workbook_id
     and p.committee_proceeding_id is not distinct from b.committee_proceeding_id;

  if p_apply then
    for r in select x.* from exchange.bcp_import_row x
             join exchange.bcp_template_sheet s on s.template_version = x.template_version and s.sheet_code = x.sheet_code
             where x.batch_id = b.id and x.resolution = 'IMPORT' order by s.position, x.row_number loop
      -- AMB-210: the notices this row's command sends are restore notices (notify.enqueue), bound to this
      -- transaction by the row's stamp (R3).
      update exchange.bcp_import_row set applying_xact = pg_current_xact_id() where id = r.id;
      perform set_config('cdf.bcp_restore_row', r.id::text, true);
      begin
        v_id := exchange.bcp_execute_row(b, r, v_refs);
      exception when others then
        v_code := exchange.bcp_error_code(sqlerrm);
        perform api._fail('CONFLICT', 'BCP_ROW_FAILED:' || r.row_key || ':' || v_code);
      end;
      perform set_config('cdf.bcp_restore_row', '', true);
      select s.object_type into v_object_type from exchange.bcp_template_sheet s
       where s.template_version = r.template_version and s.sheet_code = r.sheet_code;
      insert into exchange.bcp_provenance (case_id, batch_id, row_id, workbook_id, sheet_code, row_key, object_type,
                                           object_id, original_event_at, recorded_offline_by, imported_by, payload_hash,
                                           committee_proceeding_id)
      values (b.case_id, b.id, r.id, b.workbook_id, r.sheet_code, r.row_key, v_object_type, v_id, r.original_event_at,
              r.recorded_offline_by, authz.current_user_id(), r.payload_hash, b.committee_proceeding_id);
      perform audit.record_event('BCP_ROW_IMPORTED', 'BUSINESS', 'SUCCESS', exchange.bcp_audit_case(b), v_object_type,
        v_id::text, null,
        jsonb_build_object('batch_id', b.id, 'row_id', r.id, 'sheet', r.sheet_code,
                           'original_event_at', r.original_event_at, 'recorded_offline_by', r.recorded_offline_by,
                           'markers', jsonb_build_array('RECORDED_OFFLINE', 'IMPORTED_LATER'),
                           'restore_notices', (select count(*) from notify.outbox o where o.restored_row_id = r.id))
        || exchange.bcp_audit_scope(b));
      v_refs := v_refs || jsonb_build_object(r.row_key, jsonb_build_object('sheet', r.sheet_code, 'id', v_id));
      v_out := v_out || jsonb_build_object(r.id::text, 'OK');
    end loop;
    return v_out;
  end if;

  begin
    for r in select x.* from exchange.bcp_import_row x
             join exchange.bcp_template_sheet s on s.template_version = x.template_version and s.sheet_code = x.sheet_code
             where x.batch_id = b.id and x.resolution = 'IMPORT' order by s.position, x.row_number loop
      begin
        v_id := exchange.bcp_execute_row(b, r, v_refs);
        v_refs := v_refs || jsonb_build_object(r.row_key, jsonb_build_object('sheet', r.sheet_code, 'id', v_id));
        v_out := v_out || jsonb_build_object(r.id::text, 'OK');
      exception when others then
        v_out := v_out || jsonb_build_object(r.id::text, exchange.bcp_error_code(sqlerrm));
      end;
    end loop;
    raise exception using errcode = 'P0001', message = 'CDF_BCP_DRY_RUN';
  exception when raise_exception then
    if sqlerrm <> 'CDF_BCP_DRY_RUN' then raise; end if;
  end;
  return v_out;
end;
$$;


-- -----------------------------------------------------------------------------
-- 3.7 Staging, and the importer's and approver's commands
-- -----------------------------------------------------------------------------
-- Replaces 1960. The template's version decides the scope. A case workbook stages exactly as built, in the case's
-- namespace. A committee workbook (BCP-C1): IDENTIFY_PROCEEDING (id and committee code name the same proceeding,
-- which the importer can see), the importer is the proceeding's continuity importer (section 2), the proceeding is
-- OPEN; the preparer and each recorder are seated on its committee; the workbook's namespace is the proceeding's; and
-- the committee sheets are checked up front: a 09_MEETINGS row whose meeting is not over or lies outside the offline
-- window is INVALID (R2), and an 11_CONFLICTS row names a member of the proceeding other than the importer (R4;
-- OWN_CONFLICT: one's own conflict is declared, never raised).
create or replace function api.stage_bcp_import(p_control jsonb, p_file_sha256 text, p_rows jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_version text;
  v_scope text;
  v_ctl jsonb := '{}'::jsonb;
  v_col exchange.bcp_template_column;
  v_value text;
  v_case case_mgmt.case_record;
  v_cp committee.committee_proceeding;
  v_floor timestamptz;
  v_from timestamptz;
  v_to timestamptz;
  v_prepared uuid;
  v_batch uuid;
  v_el jsonb;
  v_sheet exchange.bcp_template_sheet;
  v_cells jsonb;
  v_detail text;
  v_state text;
  v_key text;
  v_event timestamptz;
  v_recorder uuid;
  v_subject uuid;
  v_hash text;
  v_prior text;
  v_staged exchange.bcp_import_batch;
begin
  if p_control is null or jsonb_typeof(p_control) <> 'object' then perform api._fail('INVALID', 'control'); end if;
  v_version := p_control ->> 'TEMPLATE_VERSION';
  if v_version is null or not exists (select 1 from exchange.bcp_template_sheet s where s.template_version = v_version) then
    perform api._fail('CONFLICT', 'TEMPLATE_VERSION');
  end if;
  if exists (select 1 from jsonb_each(p_control) e
             where jsonb_typeof(e.value) <> 'string'
                or not exists (select 1 from exchange.bcp_template_column c
                               where c.template_version = v_version and c.sheet_code = '01_CONTROL'
                                 and c.column_code = e.key)) then
    perform api._fail('INVALID', 'control');
  end if;
  for v_col in select * from exchange.bcp_template_column c
               where c.template_version = v_version and c.sheet_code = '01_CONTROL' order by c.position loop
    v_value := exchange.bcp_normalize(v_col.kind, p_control ->> v_col.column_code);
    if not exchange.bcp_cell_ok(v_col, v_value) then perform api._fail('INVALID', v_col.column_code); end if;
    if v_value is not null then v_ctl := v_ctl || jsonb_build_object(v_col.column_code, v_value); end if;
  end loop;
  v_scope := case when v_version ~ '^BCP-C' then 'COMMITTEE_PROCEEDING' else 'CASE' end;

  if v_scope = 'CASE' then
    -- IDENTIFY_CASE: id and number name the same case, and the importer can see it.
    select * into v_case from case_mgmt.case_record c
     where c.id = (v_ctl ->> 'CASE_ID')::uuid and c.case_number = v_ctl ->> 'CASE_NUMBER';
    if v_case.id is null or not authz.can_view_case(v_case.id) then perform api._fail('NOT_FOUND'); end if;
    if not authz.has_permission('BCP_IMPORT') then perform api._fail('FORBIDDEN'); end if;
    v_floor := v_case.created_at;
  else
    -- IDENTIFY_PROCEEDING: id and committee code name the same proceeding, and the importer can see it.
    select cp.* into v_cp from committee.committee_proceeding cp
      join committee.committee k on k.id = cp.committee_id
     where cp.id = (v_ctl ->> 'COMMITTEE_PROCEEDING_ID')::uuid and k.code = v_ctl ->> 'COMMITTEE_CODE';
    if v_cp.id is null or not authz.can_view_committee_proceeding(v_cp.id) then perform api._fail('NOT_FOUND'); end if;
    if not exchange.bcp_committee_importer(v_actor, v_cp.id) then perform api._fail('FORBIDDEN'); end if;
    if v_cp.status <> 'OPEN' then perform api._fail('CONFLICT', 'PROCEEDING_CLOSED'); end if;
    select * into v_case from case_mgmt.case_record c where c.id = v_cp.case_id;
    v_floor := v_cp.referred_at;
  end if;
  if v_case.records_state <> 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_NOT_ACTIVE'); end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then perform api._fail('INVALID', 'file_sha256'); end if;
  v_from := (v_ctl ->> 'OFFLINE_FROM')::timestamptz;
  v_to := (v_ctl ->> 'OFFLINE_TO')::timestamptz;
  if v_from > now() then perform api._fail('INVALID', 'OFFLINE_FROM'); end if;
  if v_to is not null and (v_to < v_from or v_to > now()) then perform api._fail('INVALID', 'OFFLINE_TO'); end if;
  v_prepared := case v_scope when 'CASE' then exchange.bcp_case_user(v_ctl ->> 'PREPARED_BY', v_case.id)
                                         else exchange.bcp_committee_user(v_ctl ->> 'PREPARED_BY', v_cp.id) end;
  if v_prepared is null then perform api._fail('INVALID', 'PREPARED_BY'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 2000 then
    perform api._fail('INVALID', 'rows');
  end if;

  -- One open batch per workbook in its namespace (the case's, or the proceeding's).
  if v_scope = 'CASE' then
    perform pg_advisory_xact_lock(hashtext('exchange.bcp_import:' || v_case.id || ':' || (v_ctl ->> 'WORKBOOK_ID')));
    if exists (select 1 from exchange.bcp_import_batch b
               where b.scope = 'CASE' and b.case_id = v_case.id and b.workbook_id = v_ctl ->> 'WORKBOOK_ID'
                 and b.status in ('STAGED', 'SUBMITTED', 'APPROVED')) then
      perform api._fail('CONFLICT', 'BATCH_OPEN');
    end if;
  else
    perform pg_advisory_xact_lock(hashtext('exchange.bcp_import:proceeding:' || v_cp.id || ':' || (v_ctl ->> 'WORKBOOK_ID')));
    if exists (select 1 from exchange.bcp_import_batch b
               where b.committee_proceeding_id = v_cp.id and b.workbook_id = v_ctl ->> 'WORKBOOK_ID'
                 and b.status in ('STAGED', 'SUBMITTED', 'APPROVED')) then
      perform api._fail('CONFLICT', 'BATCH_OPEN');
    end if;
  end if;

  insert into exchange.bcp_import_batch (case_id, template_version, workbook_id, file_sha256, control, offline_from,
                                         offline_to, prepared_by, imported_by, scope, committee_proceeding_id)
  values (v_case.id, v_version, v_ctl ->> 'WORKBOOK_ID', p_file_sha256, v_ctl, v_from, v_to, v_prepared, v_actor,
          v_scope, v_cp.id)
  returning * into v_staged;
  v_batch := v_staged.id;

  for v_el in select e from jsonb_array_elements(p_rows) e loop
    if jsonb_typeof(v_el) <> 'object' or jsonb_typeof(v_el -> 'cells') is distinct from 'object'
       or jsonb_typeof(v_el -> 'row_number') is distinct from 'number'
       or (v_el ? 'has_formula' and jsonb_typeof(v_el -> 'has_formula') <> 'boolean')
       or exists (select 1 from jsonb_object_keys(v_el) k where k not in ('sheet', 'row_number', 'cells', 'has_formula')) then
      perform api._fail('INVALID', 'rows');
    end if;
    select * into v_sheet from exchange.bcp_template_sheet s
     where s.template_version = v_version and s.sheet_code = v_el ->> 'sheet' and s.sheet_kind = 'DATA';
    if v_sheet.sheet_code is null or (v_el ->> 'row_number') !~ '^[0-9]{1,7}$'
       or (v_el ->> 'row_number')::int not between 3 and 1048576
       or exists (select 1 from jsonb_each(v_el -> 'cells') e
                  where jsonb_typeof(e.value) <> 'string' or length(e.value #>> '{}') > 20000
                     or not exists (select 1 from exchange.bcp_template_column c
                                    where c.template_version = v_version and c.sheet_code = v_sheet.sheet_code
                                      and c.column_code = e.key))
       or exists (select 1 from exchange.bcp_import_row r
                  where r.batch_id = v_batch and r.sheet_code = v_sheet.sheet_code
                    and r.row_number = (v_el ->> 'row_number')::int) then
      perform api._fail('INVALID', 'rows');
    end if;

    -- Column rules, in template order; the first broken column names the row's problem.
    v_cells := '{}'::jsonb;
    v_detail := case when coalesce((v_el ->> 'has_formula')::boolean, false) then 'FORMULA' end;
    for v_col in select * from exchange.bcp_template_column c
                 where c.template_version = v_version and c.sheet_code = v_sheet.sheet_code order by c.position loop
      v_value := exchange.bcp_normalize(v_col.kind, v_el -> 'cells' ->> v_col.column_code);
      if v_detail is null and not exchange.bcp_cell_ok(v_col, v_value) then v_detail := v_col.column_code; end if;
      if v_value is not null then v_cells := v_cells || jsonb_build_object(v_col.column_code, v_value); end if;
    end loop;
    v_key := v_cells ->> 'ROW_ID';
    v_event := null;
    v_recorder := null;
    v_subject := null;
    if v_detail is null and exists (select 1 from exchange.bcp_import_row r where r.batch_id = v_batch and r.row_key = v_key) then
      v_detail := 'DUPLICATE_ROW_ID';
    end if;
    if v_detail is null then
      v_event := (v_cells ->> 'ORIGINAL_EVENT_AT')::timestamptz;
      if v_event < v_from or v_event > coalesce(v_to, now()) or v_event > now() or v_event < v_floor then
        v_detail := 'ORIGINAL_EVENT_AT';
        v_event := null;
      end if;
    end if;
    if v_detail is null then
      v_recorder := case v_scope when 'CASE' then exchange.bcp_case_user(v_cells ->> 'RECORDED_OFFLINE_BY', v_case.id)
                                             else exchange.bcp_committee_user(v_cells ->> 'RECORDED_OFFLINE_BY', v_cp.id) end;
      if v_recorder is null then v_detail := 'RECORDED_OFFLINE_BY'; v_event := null; end if;
    end if;
    -- R2: a meeting is imported only once it has been held, inside the offline window, after the referral.
    if v_detail is null and v_scope <> 'CASE' and v_sheet.sheet_code = '09_MEETINGS' then
      if (v_cells ->> 'HELD_START')::timestamptz < greatest(v_from, v_floor) then
        v_detail := 'HELD_START';
      elsif (v_cells ->> 'HELD_END')::timestamptz <= (v_cells ->> 'HELD_START')::timestamptz
            or (v_cells ->> 'HELD_END')::timestamptz > v_to or (v_cells ->> 'HELD_END')::timestamptz > now() then
        v_detail := 'HELD_END';
      end if;
    end if;
    -- R4: the member a paper-noted conflict is about, among the proceeding's members; never the importer.
    if v_scope <> 'CASE' and v_sheet.sheet_code = '11_CONFLICTS' and v_cells ? 'PARTICIPANT' then
      select pm.user_id into v_subject from committee.proceeding_member pm
        join iam.user_profile u on u.id = pm.user_id
       where pm.committee_proceeding_id = v_cp.id and lower(u.email) = lower(v_cells ->> 'PARTICIPANT')
       limit 1;
      if v_detail is null and v_subject is null then v_detail := 'PARTICIPANT'; end if;
      -- One's own conflict is declared, never raised; the importer wrote this row, so it stays theirs to skip.
      if v_subject = v_actor then
        v_subject := null;
        if v_detail is null then v_detail := 'OWN_CONFLICT'; end if;
      end if;
    end if;
    v_hash := encode(sha256(convert_to(jsonb_build_object('sheet', v_sheet.sheet_code, 'cells', v_cells)::text, 'UTF8')), 'hex');

    -- CHECK_IDS, CHECK_DUPLICATES, CHECK_CONFLICTS, in the workbook's namespace.
    v_state := 'NEW';
    if v_detail is not null then
      v_state := 'INVALID';
    elsif v_sheet.command is null then
      v_state := 'UNSUPPORTED';
    else
      select p.payload_hash into v_prior from exchange.bcp_provenance p
       where p.case_id = v_case.id and p.workbook_id = v_ctl ->> 'WORKBOOK_ID' and p.row_key = v_key
         and p.committee_proceeding_id is not distinct from v_cp.id;
      if v_prior is not null then
        if v_prior = v_hash then v_state := 'ALREADY_IMPORTED'; else v_state := 'CONFLICT'; v_detail := 'CHANGED_SINCE_IMPORT'; end if;
      elsif v_cells ? 'OBJECT_ID' then
        v_state := 'CONFLICT';
        v_detail := 'EXISTING_OBJECT';
      end if;
    end if;

    insert into exchange.bcp_import_row (batch_id, case_id, template_version, sheet_code, row_number, row_key, cells,
                                         payload_hash, original_event_at, recorded_offline_by, state, detail, resolution,
                                         subject_user_id)
    values (v_batch, v_case.id, v_version, v_sheet.sheet_code, (v_el ->> 'row_number')::int,
            case when v_key ~ '^BCP-[A-Z0-9][A-Z0-9-]{0,59}$' or exchange.bcp_is_uuid(v_key) then v_key end,
            v_cells, v_hash, v_event, v_recorder, v_state, v_detail, case when v_state = 'NEW' then 'IMPORT' end,
            v_subject);
  end loop;

  perform audit.record_event('BCP_IMPORT_STAGED', 'BUSINESS', 'SUCCESS', exchange.bcp_audit_case(v_staged), 'bcp_import_batch',
    v_batch::text, null,
    jsonb_build_object('template_version', v_version, 'workbook_id', v_ctl ->> 'WORKBOOK_ID',
                       'file_sha256', p_file_sha256, 'offline_from', v_from, 'offline_to', v_to,
                       'prepared_by', v_prepared,
                       'rows', (select jsonb_object_agg(x.state, x.n) from (
                                  select r.state, count(*) n from exchange.bcp_import_row r
                                  where r.batch_id = v_batch group by r.state) x))
    || exchange.bcp_audit_scope(v_staged));
  return v_batch;
end;
$$;

-- Replaces 1960: as built, the ledger event under the workbook's namespace.
create or replace function api.resolve_bcp_row(p_row_id uuid, p_resolution text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_batch_id uuid;
  b exchange.bcp_import_batch;
  r exchange.bcp_import_row;
  v_reason text;
  v_allowed boolean;
begin
  select x.batch_id into v_batch_id from exchange.bcp_import_row x where x.id = p_row_id;
  if v_batch_id is null or not authz.can_view_bcp_import(v_batch_id) then perform api._fail('NOT_FOUND'); end if;
  b := exchange.lock_bcp_batch(v_batch_id, true);
  if b.status <> 'STAGED' then perform api._fail('CONFLICT', 'NOT_STAGED'); end if;
  select * into r from exchange.bcp_import_row x where x.id = p_row_id for update;
  if p_resolution is null or p_resolution not in ('IMPORT', 'SKIP', 'KEEP_PLATFORM', 'USE_OFFLINE', 'MERGE', 'NEW_VERSION') then
    perform api._fail('INVALID', 'resolution');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 1000);
  if r.state = 'ALREADY_IMPORTED' then perform api._fail('CONFLICT', 'NOTHING_TO_RESOLVE'); end if;
  if r.state = 'CONFLICT' and p_resolution in ('USE_OFFLINE', 'MERGE', 'NEW_VERSION') then
    perform api._fail('CONFLICT', 'RESOLUTION_NOT_SUPPORTED');
  end if;
  v_allowed := case r.state when 'NEW' then p_resolution in ('IMPORT', 'SKIP')
                            when 'CONFLICT' then p_resolution in ('KEEP_PLATFORM', 'SKIP')
                            else p_resolution = 'SKIP' end;
  if not v_allowed then perform api._fail('CONFLICT', 'RESOLUTION_NOT_ALLOWED'); end if;
  update exchange.bcp_import_row
     set resolution = p_resolution, resolution_reason = v_reason, resolved_by = v_actor, resolved_at = now(), outcome = null
   where id = r.id;
  update exchange.bcp_import_batch
     set preview_hash = null, previewed_at = null, preview_clean = false, updated_at = now(), row_version = row_version + 1
   where id = b.id;
  perform audit.record_event('BCP_IMPORT_ROW_RESOLVED', 'BUSINESS', 'SUCCESS', exchange.bcp_audit_case(b), 'bcp_import_row',
    r.id::text, v_reason,
    jsonb_build_object('batch_id', b.id, 'sheet', r.sheet_code, 'state', r.state, 'resolution', p_resolution,
                       'previous_resolution', r.resolution) || exchange.bcp_audit_scope(b));
end;
$$;

-- Replaces 1960: as built, the ledger event under the workbook's namespace.
create or replace function api.preview_bcp_import(p_batch_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  b exchange.bcp_import_batch;
  v_clean boolean;
  v_hash text;
begin
  b := exchange.lock_bcp_batch(p_batch_id, true);
  if b.status = 'STAGED' then
    v_clean := exchange.bcp_dry_run(b.id)
               and not exists (select 1 from exchange.bcp_import_row r
                               where r.batch_id = b.id and r.resolution is null and r.state <> 'ALREADY_IMPORTED');
    v_hash := exchange.bcp_batch_hash(b.id);
    update exchange.bcp_import_batch
       set preview_hash = v_hash, previewed_at = now(), preview_clean = v_clean, updated_at = now(),
           row_version = row_version + 1
     where id = b.id;
  else
    v_clean := b.preview_clean;
    v_hash := exchange.bcp_batch_hash(b.id);
  end if;
  perform audit.record_event('BCP_IMPORT_PREVIEWED', 'BUSINESS', 'SUCCESS', exchange.bcp_audit_case(b), 'bcp_import_batch',
    b.id::text, null,
    jsonb_build_object('status', b.status, 'preview_hash', v_hash, 'clean', v_clean) || exchange.bcp_audit_scope(b));
  return jsonb_build_object(
    'hash', v_hash, 'clean', v_clean, 'status', b.status,
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
                        'id', r.id, 'sheet', r.sheet_code, 'row_number', r.row_number, 'row_key', r.row_key,
                        'state', r.state, 'detail', r.detail, 'resolution', r.resolution, 'outcome', r.outcome)
                        order by s.position, r.row_number)
                      from exchange.bcp_import_row r
                      join exchange.bcp_template_sheet s on s.template_version = r.template_version and s.sheet_code = r.sheet_code
                      where r.batch_id = b.id), '[]'::jsonb));
end;
$$;

-- Replaces 1960. A committee workbook is not submitted until its official record exists (3.3, fail closed). A case
-- workbook as built.
create or replace function api.submit_bcp_import(p_batch_id uuid, p_preview_hash text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  b exchange.bcp_import_batch;
  v_hash text;
begin
  b := exchange.lock_bcp_batch(p_batch_id, true);
  if b.status <> 'STAGED' then perform api._fail('CONFLICT', 'NOT_STAGED'); end if;
  if b.scope <> 'CASE' then perform api._fail('CONFLICT', 'OFFICIAL_RECORD_REQUIRED'); end if;
  if exists (select 1 from exchange.bcp_import_row r
             where r.batch_id = b.id and r.resolution is null and r.state <> 'ALREADY_IMPORTED') then
    perform api._fail('CONFLICT', 'ROWS_UNRESOLVED');
  end if;
  v_hash := exchange.bcp_batch_hash(b.id);
  if b.preview_hash is null or b.preview_hash <> v_hash or p_preview_hash is distinct from v_hash then
    perform api._fail('CONFLICT', 'PREVIEW_CHANGED');
  end if;
  if not exchange.bcp_dry_run(b.id) then perform api._fail('CONFLICT', 'DRY_RUN_FAILED'); end if;
  update exchange.bcp_import_batch
     set status = 'SUBMITTED', submitted_hash = v_hash, submitted_at = now(), preview_clean = true, updated_at = now(),
         row_version = row_version + 1
   where id = b.id;
  perform audit.record_event('BCP_IMPORT_SUBMITTED', 'BUSINESS', 'SUCCESS', exchange.bcp_audit_case(b), 'bcp_import_batch',
    b.id::text, null,
    jsonb_build_object('preview_hash', v_hash,
                       'to_import', (select count(*) from exchange.bcp_import_row r
                                     where r.batch_id = b.id and r.resolution = 'IMPORT'),
                       'skipped', (select count(*) from exchange.bcp_import_row r
                                   where r.batch_id = b.id and r.resolution = 'SKIP'),
                       'kept', (select count(*) from exchange.bcp_import_row r
                                where r.batch_id = b.id and r.resolution = 'KEEP_PLATFORM'))
    || exchange.bcp_audit_scope(b));
  return 'SUBMITTED';
end;
$$;

-- Replaces 1960. Never anyone exchange.bcp_approver_excluded names (R4, R5; for a case workbook this changes nobody:
-- an external account holds no BCP_IMPORT_APPROVE and a case row has no subject). A case workbook: as built. A
-- committee workbook is never decided here: its approval is the official record (3.3).
create or replace function api.decide_bcp_import(p_batch_id uuid, p_decision text, p_reason text, p_hash text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  b exchange.bcp_import_batch;
  v_reason text;
  v_status text;
  v_forbidden boolean;
begin
  b := exchange.lock_bcp_batch(p_batch_id, false);
  if b.scope <> 'CASE' then perform api._fail('CONFLICT', 'OFFICIAL_RECORD_REQUIRED'); end if;
  v_forbidden := not authz.has_permission('BCP_IMPORT_APPROVE') or b.imported_by = v_actor
                 or b.prepared_by = v_actor
                 or exists (select 1 from exchange.bcp_import_row r
                            where r.batch_id = b.id and r.recorded_offline_by = v_actor);
  if v_forbidden or exchange.bcp_approver_excluded(b.id, v_actor) then perform api._fail('FORBIDDEN'); end if;
  if b.status <> 'SUBMITTED' then perform api._fail('CONFLICT', 'NOT_SUBMITTED'); end if;
  if p_decision is null or p_decision not in ('APPROVE', 'REJECT') then perform api._fail('INVALID', 'decision'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  if p_hash is distinct from b.submitted_hash or exchange.bcp_batch_hash(b.id) <> b.submitted_hash then
    perform api._fail('CONFLICT', 'PREVIEW_CHANGED');
  end if;
  v_status := case p_decision when 'APPROVE' then 'APPROVED' else 'REJECTED' end;
  update exchange.bcp_import_batch
     set status = v_status, decided_by = v_actor, decided_at = now(), decision_reason = v_reason, updated_at = now(),
         row_version = row_version + 1
   where id = b.id;
  perform audit.record_event(case v_status when 'APPROVED' then 'BCP_IMPORT_APPROVED' else 'BCP_IMPORT_REJECTED' end,
    'BUSINESS', 'SUCCESS', exchange.bcp_audit_case(b), 'bcp_import_batch', b.id::text, v_reason,
    jsonb_build_object('submitted_hash', b.submitted_hash) || exchange.bcp_audit_scope(b));
  return v_status;
end;
$$;

-- Replaces 1960: as built, the ledger event under the workbook's namespace.
create or replace function api.apply_bcp_import(p_batch_id uuid, p_hash text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  b exchange.bcp_import_batch;
  v_out jsonb;
  v_counts jsonb;
begin
  b := exchange.lock_bcp_batch(p_batch_id, true);
  if b.status <> 'APPROVED' then perform api._fail('CONFLICT', 'NOT_APPROVED'); end if;
  if p_hash is distinct from b.submitted_hash or exchange.bcp_batch_hash(b.id) <> b.submitted_hash then
    perform api._fail('CONFLICT', 'PREVIEW_CHANGED');
  end if;
  v_out := exchange.bcp_run(b.id, true);
  update exchange.bcp_import_batch
     set status = 'IMPORTED', applied_at = now(), updated_at = now(), row_version = row_version + 1
   where id = b.id;
  select jsonb_build_object(
           'imported', (select count(*) from jsonb_object_keys(v_out)),
           'skipped', count(*) filter (where r.resolution = 'SKIP'),
           'kept', count(*) filter (where r.resolution = 'KEEP_PLATFORM'),
           'already_imported', count(*) filter (where r.state = 'ALREADY_IMPORTED'))
    into v_counts
    from exchange.bcp_import_row r where r.batch_id = b.id;
  perform audit.record_event('BCP_IMPORT_COMPLETED', 'BUSINESS', 'SUCCESS', exchange.bcp_audit_case(b), 'bcp_import_batch',
    b.id::text, null,
    v_counts || jsonb_build_object('workbook_id', b.workbook_id, 'submitted_hash', b.submitted_hash,
                                   'approved_by', b.decided_by) || exchange.bcp_audit_scope(b));
  return v_counts;
end;
$$;

-- Replaces 1960: as built, the ledger event under the workbook's namespace.
create or replace function api.cancel_bcp_import(p_batch_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  b exchange.bcp_import_batch;
  v_reason text;
begin
  b := exchange.lock_bcp_batch(p_batch_id, true);
  if b.status not in ('STAGED', 'SUBMITTED', 'APPROVED') then perform api._fail('CONFLICT', 'NOT_OPEN'); end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  update exchange.bcp_import_batch
     set status = 'CANCELLED', cancelled_at = now(), updated_at = now(), row_version = row_version + 1
   where id = b.id;
  perform audit.record_event('BCP_IMPORT_CANCELLED', 'BUSINESS', 'SUCCESS', exchange.bcp_audit_case(b), 'bcp_import_batch',
    b.id::text, v_reason, jsonb_build_object('previous_status', b.status) || exchange.bcp_audit_scope(b));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3.8 Revoking a lost committee workbook (AMB-205, in the proceeding's namespace)
-- -----------------------------------------------------------------------------
-- As 2100 for a case workbook, revoked in the proceeding's namespace by the proceeding's committee importer (the only
-- person who imports it; its approval is the official record, built next). A case revocation never touches a committee workbook of the same
-- id, nor the reverse, so neither team learns of the other's workbook.
alter table exchange.bcp_workbook_revocation
  add column committee_proceeding_id uuid references committee.committee_proceeding (id);
create index bcp_workbook_revocation_proceeding on exchange.bcp_workbook_revocation (committee_proceeding_id);
comment on column exchange.bcp_workbook_revocation.committee_proceeding_id is
  'Migration 2110 (ADR-047): set for a committee workbook, revoked in its proceeding''s namespace; null for a case '
  'workbook, as 2100 built.';
drop index exchange.bcp_workbook_revocation_once;
create unique index bcp_workbook_revocation_once on exchange.bcp_workbook_revocation (case_id, lower(workbook_id))
  where committee_proceeding_id is null;
create unique index bcp_workbook_revocation_once_proceeding
  on exchange.bcp_workbook_revocation (committee_proceeding_id, lower(workbook_id))
  where committee_proceeding_id is not null;
drop policy bcp_workbook_revocation_read on exchange.bcp_workbook_revocation;
create policy bcp_workbook_revocation_read on exchange.bcp_workbook_revocation for select to authenticated
  using (case when committee_proceeding_id is null
              then authz.can_view_case(case_id)
                   and (authz.has_permission('BCP_IMPORT') or authz.has_permission('BCP_IMPORT_APPROVE'))
              else authz.is_bcp_committee_importer(committee_proceeding_id)
         end);

-- Replaces 2100: a case workbook's revocation, in the case's namespace.
create or replace function exchange.workbook_revoked(p_case_id uuid, p_workbook_id text)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from exchange.bcp_workbook_revocation r
                 where r.case_id = p_case_id and lower(r.workbook_id) = lower(p_workbook_id)
                   and r.committee_proceeding_id is null);
$$;

create function exchange.committee_workbook_revoked(p_committee_proceeding_id uuid, p_workbook_id text)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from exchange.bcp_workbook_revocation r
                 where r.committee_proceeding_id = p_committee_proceeding_id
                   and lower(r.workbook_id) = lower(p_workbook_id));
$$;

-- Replaces 2100: each workbook against the revocations of its own namespace.
create or replace function exchange.refuse_revoked_workbook()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.scope = 'CASE' and exchange.workbook_revoked(new.case_id, new.workbook_id))
     or (new.scope <> 'CASE' and exchange.committee_workbook_revoked(new.committee_proceeding_id, new.workbook_id)) then
    perform api._fail('CONFLICT', 'WORKBOOK_REVOKED');
  end if;
  return new;
end;
$$;

-- Replaces 2100: as built; the open batches it counts are the case's own.
create or replace function api.revoke_bcp_workbook(p_case_id uuid, p_workbook_id text, p_incident_reference text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_ref text;
  v_reason text;
  v_open int;
  v_id uuid;
begin
  if p_case_id is null or not authz.can_view_case(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not (authz.has_permission('BCP_IMPORT') or authz.has_permission('BCP_IMPORT_APPROVE')) then
    perform api._fail('FORBIDDEN');
  end if;
  if p_workbook_id is null
     or p_workbook_id !~ '^(BCP-[A-Z0-9][A-Z0-9-]{0,59}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
    perform api._fail('INVALID', 'workbook_id');
  end if;
  v_ref := api._require_text(p_incident_reference, 'incident_reference', 3, 200);
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  perform pg_advisory_xact_lock(hashtext('exchange.bcp_import:' || p_case_id || ':' || p_workbook_id));
  if exchange.workbook_revoked(p_case_id, p_workbook_id) then perform api._fail('CONFLICT', 'WORKBOOK_REVOKED'); end if;
  select count(*)::int into v_open from exchange.bcp_import_batch b
  where b.scope = 'CASE' and b.case_id = p_case_id and lower(b.workbook_id) = lower(p_workbook_id)
    and b.status in ('STAGED', 'SUBMITTED', 'APPROVED');
  insert into exchange.bcp_workbook_revocation (case_id, workbook_id, incident_reference, reason, revoked_by)
  values (p_case_id, p_workbook_id, v_ref, v_reason, v_actor)
  returning id into v_id;
  -- Ids and counts only: the case trail records the revocation, and the lost workbook is reported as a security
  -- incident for security monitoring (as an integrity failure is, 2050).
  perform audit.record_event('BCP_WORKBOOK_REVOCATION_RECORDED', 'BUSINESS', 'SUCCESS', p_case_id,
    'bcp_workbook_revocation', v_id::text, null, jsonb_build_object('open_batches', v_open));
  perform audit.record_event('BCP_WORKBOOK_REVOKED', 'SECURITY', 'SUCCESS', p_case_id, 'bcp_workbook_revocation',
    v_id::text, null, jsonb_build_object('open_batches', v_open));
  return v_id;
end;
$$;

-- A lost committee workbook: revoked by the proceeding's committee importer, citing the incident. It takes the
-- staging lock of the same workbook in the proceeding's namespace. The events carry no case in the ledger (the case
-- team does not learn of the committee's workbook) and name the proceeding; security monitoring gets its event.
create function api.revoke_committee_bcp_workbook(
  p_committee_proceeding_id uuid, p_workbook_id text, p_incident_reference text, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_cp committee.committee_proceeding;
  v_ref text;
  v_reason text;
  v_open int;
  v_id uuid;
  v_meta jsonb;
begin
  if p_committee_proceeding_id is null or not authz.can_view_committee_proceeding(p_committee_proceeding_id) then
    perform api._fail('NOT_FOUND');
  end if;
  select * into v_cp from committee.committee_proceeding cp where cp.id = p_committee_proceeding_id;
  if not exchange.bcp_committee_importer(v_actor, v_cp.id) then perform api._fail('FORBIDDEN'); end if;
  if p_workbook_id is null
     or p_workbook_id !~ '^(BCP-[A-Z0-9][A-Z0-9-]{0,59}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
    perform api._fail('INVALID', 'workbook_id');
  end if;
  v_ref := api._require_text(p_incident_reference, 'incident_reference', 3, 200);
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  perform pg_advisory_xact_lock(hashtext('exchange.bcp_import:proceeding:' || v_cp.id || ':' || p_workbook_id));
  if exchange.committee_workbook_revoked(v_cp.id, p_workbook_id) then
    perform api._fail('CONFLICT', 'WORKBOOK_REVOKED');
  end if;
  select count(*)::int into v_open from exchange.bcp_import_batch b
  where b.committee_proceeding_id = v_cp.id and lower(b.workbook_id) = lower(p_workbook_id)
    and b.status in ('STAGED', 'SUBMITTED', 'APPROVED');
  insert into exchange.bcp_workbook_revocation (case_id, workbook_id, incident_reference, reason, revoked_by,
                                                committee_proceeding_id)
  values (v_cp.case_id, p_workbook_id, v_ref, v_reason, v_actor, v_cp.id)
  returning id into v_id;
  v_meta := jsonb_build_object('open_batches', v_open, 'scope', 'COMMITTEE_PROCEEDING', 'committee_proceeding_id', v_cp.id);
  perform audit.record_event('BCP_WORKBOOK_REVOCATION_RECORDED', 'BUSINESS', 'SUCCESS', null,
    'bcp_workbook_revocation', v_id::text, null, v_meta);
  perform audit.record_event('BCP_WORKBOOK_REVOKED', 'SECURITY', 'SUCCESS', null, 'bcp_workbook_revocation',
    v_id::text, null, v_meta);
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3.9 The batch view (2040, 2100), by scope
-- -----------------------------------------------------------------------------
create or replace function api.bcp_import_batch_view(p_batch_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_me uuid := authz.current_user_id();
  b exchange.bcp_import_batch;
  v_hash text;
  v_own boolean;
  v_resolvable boolean;
  v_approver boolean;
  v_metadata boolean;
  v_revoked boolean;
  v_record_required boolean;
begin
  if p_batch_id is null or not authz.can_view_bcp_import(p_batch_id) then perform api._fail('NOT_FOUND'); end if;
  select * into b from exchange.bcp_import_batch x where x.id = p_batch_id;
  v_hash := exchange.bcp_batch_hash(b.id);
  if b.scope = 'CASE' then
    -- exchange.lock_bcp_batch(own): the importer, holding BCP_IMPORT, a CASE continuity operator.
    v_own := b.imported_by = v_me and authz.has_permission('BCP_IMPORT') and exchange.is_continuity_operator(v_me);
    -- api.decide_bcp_import: BCP_IMPORT_APPROVE, never the importer, the workbook's preparer or an offline recorder.
    v_approver := authz.has_permission('BCP_IMPORT_APPROVE') and b.imported_by <> v_me
                  and b.prepared_by is distinct from v_me
                  and not exists (select 1 from exchange.bcp_import_row r
                                  where r.batch_id = b.id and r.recorded_offline_by = v_me)
                  and not exchange.bcp_approver_excluded(b.id, v_me);
    v_revoked := exchange.workbook_revoked(b.case_id, b.workbook_id);
    v_record_required := false;
  else
    -- exchange.lock_bcp_batch(own): the importer, still the proceeding's committee importer.
    v_own := b.imported_by = v_me and exchange.bcp_committee_importer(v_me, b.committee_proceeding_id);
    -- api.decide_bcp_import: one of the batch's eligible approvers (none: 3.3).
    v_approver := exists (select 1 from exchange.bcp_eligible_approvers(b.id) e where e.user_id = v_me);
    v_revoked := exchange.committee_workbook_revoked(b.committee_proceeding_id, b.workbook_id);
    -- api.submit_bcp_import: OFFICIAL_RECORD_REQUIRED (3.3).
    v_record_required := true;
  end if;
  v_resolvable := v_own and b.status = 'STAGED';
  v_metadata := authz.can_view_case_metadata(b.case_id);
  return jsonb_build_object(
    'batch_id', b.id, 'template_version', b.template_version, 'workbook_id', b.workbook_id,
    'scope', b.scope, 'committee_proceeding_id', b.committee_proceeding_id,
    'file_sha256', b.file_sha256, 'offline_from', b.offline_from, 'offline_to', b.offline_to,
    'prepared_by', b.prepared_by, 'status', b.status, 'preview_hash', b.preview_hash, 'previewed_at', b.previewed_at,
    'preview_clean', b.preview_clean, 'submitted_hash', b.submitted_hash, 'imported_by', b.imported_by,
    'decided_by', b.decided_by, 'decision_reason', b.decision_reason, 'created_at', b.created_at,
    'submitted_at', b.submitted_at, 'decided_at', b.decided_at, 'applied_at', b.applied_at,
    'cancelled_at', b.cancelled_at, 'updated_at', b.updated_at, 'row_version', b.row_version,
    'current_hash', v_hash,
    'workbook_revoked', v_revoked,
    'official_record_required', v_record_required,
    'counts', (select jsonb_build_object(
                        'rows', count(*),
                        'unresolved', count(*) filter (where r.resolution is null and r.state <> 'ALREADY_IMPORTED'),
                        'by_state', coalesce((select jsonb_object_agg(s.state, s.n)
                                              from (select r2.state, count(*) as n from exchange.bcp_import_row r2
                                                    where r2.batch_id = b.id group by r2.state) s), '{}'::jsonb))
               from exchange.bcp_import_row r where r.batch_id = b.id),
    -- bcp_import_row_read: row metadata, never the cells.
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'row_id', r.id, 'sheet_code', r.sheet_code, 'row_number', r.row_number, 'row_key', r.row_key,
               'state', r.state, 'detail', r.detail, 'resolution', r.resolution,
               'resolution_reason', r.resolution_reason, 'resolved_by', r.resolved_by, 'resolved_at', r.resolved_at,
               'outcome', r.outcome, 'original_event_at', r.original_event_at,
               'recorded_offline_by', r.recorded_offline_by, 'purged_at', r.purged_at,
               -- api.resolve_bcp_row: SKIP is open to every row that is not already imported.
               'may_resolve', v_resolvable and r.state <> 'ALREADY_IMPORTED')
             order by s.position, r.row_number)
      from exchange.bcp_import_row r
      join exchange.bcp_template_sheet s on s.template_version = r.template_version and s.sheet_code = r.sheet_code
      -- R4: never the rows about the viewer.
      where r.batch_id = b.id and r.subject_user_id is distinct from v_me), '[]'::jsonb),
    'case', jsonb_build_object(
      'case_id', case when v_metadata then b.case_id end,
      'case_number', case when v_metadata then (select c.case_number from case_mgmt.case_record c where c.id = b.case_id) end),
    'capabilities', jsonb_build_object(
      'may_resolve_rows', coalesce(v_resolvable and exists (select 1 from exchange.bcp_import_row r
                                                            where r.batch_id = b.id and r.state <> 'ALREADY_IMPORTED'),
                                   false),
      -- api.preview_bcp_import.
      'may_preview', coalesce(v_own, false),
      -- api.submit_bcp_import: every row resolved and the batch unchanged since a clean preview; never a committee
      -- workbook before its official record exists (3.3). The dry run it repeats writes, so it cannot run in a read:
      -- the stored preview result stands in for it.
      'may_submit', coalesce(v_resolvable and not v_record_required
                             and not exists (select 1 from exchange.bcp_import_row r
                                             where r.batch_id = b.id and r.resolution is null
                                               and r.state <> 'ALREADY_IMPORTED')
                             and b.preview_hash = v_hash and b.preview_clean and not v_revoked, false),
      -- api.decide_bcp_import (APPROVE or REJECT), on the batch as submitted.
      'may_decide', coalesce(v_approver and b.status = 'SUBMITTED' and v_hash = b.submitted_hash, false),
      -- ... and APPROVE only while the workbook is not revoked (REJECT stays open).
      'may_approve', coalesce(v_approver and b.status = 'SUBMITTED' and v_hash = b.submitted_hash and not v_revoked,
                              false),
      -- api.apply_bcp_import.
      'may_apply', coalesce(v_own and b.status = 'APPROVED' and v_hash = b.submitted_hash and not v_revoked, false),
      -- api.cancel_bcp_import.
      'may_cancel', coalesce(v_own and b.status in ('STAGED', 'SUBMITTED', 'APPROVED'), false)));
end;
$$;
comment on function api.bcp_import_batch_view(uuid) is
  'Purpose read model of one continuity import batch (migration 2040 item 13): NOT_FOUND unless '
  'authz.can_view_bcp_import; row metadata, never the cells or the control; capabilities from the commands. Since '
  '2100 (AMB-205): whether the workbook is revoked; may_approve is may_decide without a revocation. Since 2110 '
  '(ADR-047): the scope and proceeding, whether a committee workbook still needs its official record, never the rows about '
  'the viewer.';

-- =============================================================================
-- 4. Grants and the catalogue
-- =============================================================================
revoke all on function
  exchange.bcp_restoring_row(), exchange.is_committee_continuity_operator(uuid, uuid),
  exchange.bcp_committee_importer(uuid, uuid), exchange.bcp_approver_excluded(uuid, uuid),
  exchange.bcp_committee_user(text, uuid), exchange.bcp_audit_case(exchange.bcp_import_batch),
  exchange.bcp_audit_scope(exchange.bcp_import_batch),
  exchange.bcp_record_offline_meeting(exchange.bcp_import_batch, text, text, text, text, timestamptz, timestamptz,
                                      text, text),
  exchange.committee_workbook_revoked(uuid, text)
from public, anon, authenticated;

revoke all on function
  api.authorize_committee_continuity_operator(uuid, uuid, text, text),
  api.revoke_committee_bcp_workbook(uuid, text, text, text), authz.is_bcp_committee_importer(uuid)
from public;
grant execute on function
  api.authorize_committee_continuity_operator(uuid, uuid, text, text),
  api.revoke_committee_bcp_workbook(uuid, text, text, text), authz.is_bcp_committee_importer(uuid)
to authenticated;

update config.target_module
   set commands = commands || array['api.authorize_committee_continuity_operator', 'api.revoke_committee_bcp_workbook'],
       delivered_in = delivered_in || '2110'::text,
       notes = notes || ' Since 2110: a committee-proceeding workbook (BCP-C1) imported by the proceeding''s secretary '
                        'with a registry entry for that proceeding; it imports meetings held offline and paper-noted '
                        'conflicts; it is not submitted until its official signed record and member attestations '
                        'exist (owner decision on AMB-201, built by a later migration); '
                        'notices for offline events go out as restore notices, mandatory only (AMB-201, AMB-210).'
 where code = 'BCP_CONTINUITY';
update config.target_module
   set delivered_in = delivered_in || '2110'::text,
       notes = notes || ' Since 2110: a meeting held during an outage is recorded by a committee continuity import, '
                        'marked held offline with its original times and a paper-minutes reference (AMB-201).'
 where code = 'MEETING';
update config.target_module
   set delivered_in = delivered_in || '2110'::text,
       notes = notes || ' Since 2110: a notice sent by a continuity import names the workbook row and the original '
                        'event time; optional notices are skipped (AMB-210, BCP_RESTORE_NOTIFY = MANDATORY_ONLY).'
 where code = 'NOTIFICATIONS';
