-- =============================================================================
-- 2120 Paper ballots: a committee meeting held offline votes through its members' own confirmations
-- (Rebase; CDF-262; ADR-048)
-- Requirements: §12, §19, §20, §29, §39, §45, §82, §83, §87; ADR-034, ADR-047, ADR-061; Q59–Q63 and N6 (Q60);
-- DEC-AMB-008 (owner decision of 2026-10-13 on AMB-200, option B); the owner decision on AMB-201 of 2026-10-17 (§5,
-- §6); the coordinator's rulings of 2026-10-18 15:44 UTC on the four forks of 2120_DESIGN.md (F1 B′, F2 narrow,
-- F3 importer only, F4 no notice); T-AMB-118.
--
-- DEC-AMB-008, in the owner's words: "During an outage, substantive committee voting may use signed individual paper
-- ballots. They are imported as provisional votes and must be confirmed by each relevant member through the platform
-- after restoration before the vote becomes final. The Secretary may not cast APPROVE or REJECT on another member's
-- behalf." AMB-201 §6: "The minutes attachment alone must not create a substantive vote in the system."
--
-- Model B′ (F1, ruled): a ballot is imported provisional and becomes a vote only by the member's own act, in the
-- member's own transaction, in the online completion of the meeting (2110 F3).
--   1. A committee workbook of template BCP-C2 carries one 12_VOTES row per signed paper ballot: the member, the
--      target (a finding, a package or a recommendation item of the proceeding) and the choice. BCP-C1 is unchanged
--      and its 12_VOTES stays recorded only (DEC-35: no catalogue row is renamed or removed).
--   2. The official record (2115) gates it: every ballot comes from an eligible member line the signed minutes show
--      attending (BALLOT_WITHOUT_ATTENDANCE), whose holder attests the record and so their ballot (§5); E1 holds every
--      ballot to the record's one meeting.
--   3. The commit turns each ballot into a committee.offline_ballot row, PROVISIONAL. No vote row exists, nothing is
--      counted, and the secretary has no path that writes one.
--   4. Online completion (2110 F3): the secretary opens the meeting, records attendance, opens vote items; a vote item
--      on a ballot's target in that meeting (in the same round, for a package) binds the ballot.
--   5. api.confirm_offline_ballot: the member's own act, with every check api.cast_vote makes, on the choice they read.
--      It writes the member's own SELF vote with the ballot's choice and the paper time, and the ballot is CONFIRMED.
--   6. The vote is final only when every counting member's ballot is settled: api.close_vote_item refuses
--      BALLOTS_UNCONFIRMED until each is confirmed, or superseded by the member's recusal or by the secretary's N6
--      record with its reason (never APPROVE or REJECT). A ballot whose member no longer counts, or whose target never
--      opens in the meeting, lapses when its item or its meeting closes and never counts.
-- F2 (narrow, ruled): in a meeting held offline api.cast_vote and api.revise_vote refuse OFFLINE_BALLOT_ONLY, and a
-- member is recorded present only as their attested roster line attended (OFFLINE_ROSTER_MISMATCH); api.meeting_view
-- is replaced with them (flag == command) and gains may_confirm_ballot.
-- F3 (ruled): before the commit, a committee workbook's 12_VOTES rows are its importer's only; the chair approving the
-- record sees them only as counts. Each member's own view of their ballot before attestation is Section 13's.
-- F4 (ruled): no notice in 2120. The PROPOSED text waits for the owner in the notification registers.
--
-- Narrowings beyond the ruled items, fail closed, for review: BALLOTS_UNCONFIRMED (above; otherwise a ballot whose
-- member is not recorded present lapses with no act of theirs and no reasoned record); TARGET_CHANGED (a target that
-- changed after the meeting began, or a package whose round may have, refuses at commit); the confirmation carries the
-- choice the member read (BALLOT_CHOICE_MISMATCH otherwise, and the ballot stays provisional).
-- Secrecy (Q61–Q63, AMB-201 test 18): no ledger row carries a choice; the choice is shown to its member only, and to
-- others only as the vote's own after close (api.vote_item_status, unchanged rules).
--
-- Sections:
--   1. Template BCP-C2.
--   2. The ballot: the staged row's voter, committee.offline_ballot, integrity.
--   3. Staging and commit: the target rule, api.stage_bcp_import, the ballot's import, exchange.bcp_execute_row,
--      provenance.
--   4. The official record: E1 and BALLOT_WITHOUT_ATTENDANCE.
--   5. Who sees a workbook's ballots before commit (F3).
--   6. Binding, settling and lapsing.
--   7. The member's confirmation.
--   8. The meeting held offline (F2) and the final vote.
--   9. Read models: api.meeting_view, api.vote_item_status.
--  10. Grants and the catalogue.
-- Synthetic data only. Nothing here is a production control; the BCP path is a reference emulation (ADR-034).
-- =============================================================================

-- =============================================================================
-- 1. Template BCP-C2 (reference data, mirrored in @cdf/contracts as BCP_COMMITTEE_BALLOT_TEMPLATE)
-- =============================================================================
alter table exchange.bcp_template_sheet drop constraint bcp_template_sheet_command_check;
alter table exchange.bcp_template_sheet add constraint bcp_template_sheet_command_check
  check (command in ('add_case_subject', 'add_allegation', 'record_defence_response', 'open_corrective_action',
                     'record_offline_meeting', 'raise_meeting_conflict', 'record_offline_ballot'));
alter table exchange.bcp_template_sheet drop constraint bcp_template_sheet_object_type_check;
alter table exchange.bcp_template_sheet add constraint bcp_template_sheet_object_type_check
  check (object_type in ('case_subject', 'allegation', 'defence_response', 'corrective_action', 'meeting',
                         'meeting_conflict_concern', 'offline_ballot'));
alter table exchange.bcp_provenance drop constraint bcp_provenance_object_type_check;
alter table exchange.bcp_provenance add constraint bcp_provenance_object_type_check
  check (object_type in ('case_subject', 'allegation', 'defence_response', 'corrective_action', 'meeting',
                         'meeting_conflict_concern', 'offline_ballot'));

-- BCP-C1's sheets and columns, except that 12_VOTES imports a signed paper ballot.
insert into exchange.bcp_template_sheet (template_version, sheet_code, position, sheet_kind, command, object_type)
select 'BCP-C2', s.sheet_code, s.position, s.sheet_kind,
       case when s.sheet_code = '12_VOTES' then 'record_offline_ballot' else s.command end,
       case when s.sheet_code = '12_VOTES' then 'offline_ballot' else s.object_type end
from exchange.bcp_template_sheet s where s.template_version = 'BCP-C1';

insert into exchange.bcp_template_column
  (template_version, sheet_code, position, column_code, kind, required, min_length, max_length, allowed)
select 'BCP-C2', c.sheet_code, c.position, c.column_code, c.kind, c.required, c.min_length, c.max_length, c.allowed
from exchange.bcp_template_column c
where c.template_version = 'BCP-C1' and (c.sheet_code <> '12_VOTES' or c.position <= 4);

-- One row per signed ballot: the meeting row of this workbook, the member, what they voted on, how, and the paper
-- ballot's own reference. A package's round is the one it stood in when the meeting began (section 3).
insert into exchange.bcp_template_column
  (template_version, sheet_code, position, column_code, kind, required, min_length, max_length, allowed) values
  ('BCP-C2', '12_VOTES', 5, 'MEETING_REF', 'REF', true, null, 64, null),
  ('BCP-C2', '12_VOTES', 6, 'PARTICIPANT', 'EMAIL', true, null, 254, null),
  ('BCP-C2', '12_VOTES', 7, 'TARGET_KIND', 'ENUM', true, null, 40, array['FINDING', 'PACKAGE', 'RECOMMENDATION_ITEM']),
  ('BCP-C2', '12_VOTES', 8, 'TARGET_ID', 'UUID', true, null, 36, null),
  ('BCP-C2', '12_VOTES', 9, 'CHOICE', 'ENUM', true, null, 40, array['APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED']),
  ('BCP-C2', '12_VOTES', 10, 'BALLOT_REFERENCE', 'TEXT', true, 3, 300, null);

-- =============================================================================
-- 2. The ballot
-- =============================================================================
alter table exchange.bcp_import_row
  add column ballot_user_id uuid references iam.user_profile (id),
  add constraint bcp_import_row_ballot check (ballot_user_id is null or sheet_code = '12_VOTES');
create index bcp_import_row_ballot on exchange.bcp_import_row (ballot_user_id);
comment on column exchange.bcp_import_row.ballot_user_id is
  'Migration 2120 (ADR-048): the member a 12_VOTES row of a BCP-C2 workbook is the signed paper ballot of. Never a '
  'conflict subject (subject_user_id): the row is read by its importer only before commit (F3).';

-- A signed paper ballot, imported. PROVISIONAL until settled: CONFIRMED by its member's own vote, SUPERSEDED by
-- another vote of theirs on its item (their recusal, or the secretary's N6 record), or LAPSED when its item or its
-- meeting closes first. Never counted: only committee.vote rows are.
create table committee.offline_ballot (
  id                      uuid primary key default gen_random_uuid(),
  meeting_id              uuid not null references committee.meeting (id),
  participant_id          uuid not null references committee.meeting_participant (id),
  user_id                 uuid not null references iam.user_profile (id),
  case_id                 uuid not null references case_mgmt.case_record (id),
  committee_proceeding_id uuid not null references committee.committee_proceeding (id),
  target_kind             text not null check (target_kind in ('FINDING', 'PACKAGE', 'RECOMMENDATION_ITEM')),
  finding_id              uuid references case_mgmt.finding (id),
  package_id              uuid references decision.recommendation_package (id),
  recommendation_item_id  uuid references decision.recommendation_item (id),
  package_round           int check (package_round >= 1),
  choice                  text not null check (choice in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED')),
  ballot_reference        text not null check (length(ballot_reference) between 3 and 300),
  original_event_at       timestamptz not null,
  batch_id                uuid not null references exchange.bcp_import_batch (id),
  row_id                  uuid not null unique references exchange.bcp_import_row (id),
  imported_by             uuid not null references iam.user_profile (id),
  imported_at             timestamptz not null default now(),
  status                  text not null default 'PROVISIONAL' check (status in (
                            'PROVISIONAL', 'CONFIRMED', 'SUPERSEDED', 'LAPSED')),
  vote_item_id            uuid references committee.vote_item (id),
  vote_id                 uuid unique references committee.vote (id),
  settled_at              timestamptz,
  check (case target_kind
           when 'FINDING' then finding_id is not null and package_id is null and recommendation_item_id is null
                               and package_round is null
           when 'PACKAGE' then finding_id is null and package_id is not null and recommendation_item_id is null
                               and package_round is not null
           else finding_id is null and package_id is not null and recommendation_item_id is not null
                and package_round is not null end),
  check ((status = 'PROVISIONAL') = (settled_at is null)),
  check ((status in ('CONFIRMED', 'SUPERSEDED')) = (vote_id is not null)),
  check (status not in ('CONFIRMED', 'SUPERSEDED') or vote_item_id is not null)
);
-- One ballot per member per target in a meeting.
create unique index offline_ballot_one_per_target on committee.offline_ballot
  (meeting_id, user_id, target_kind, coalesce(recommendation_item_id, package_id, finding_id));
create index offline_ballot_meeting on committee.offline_ballot (meeting_id, status);
create index offline_ballot_participant on committee.offline_ballot (participant_id);
create index offline_ballot_user on committee.offline_ballot (user_id);
create index offline_ballot_case on committee.offline_ballot (case_id);
create index offline_ballot_proceeding on committee.offline_ballot (committee_proceeding_id);
create index offline_ballot_finding on committee.offline_ballot (finding_id);
create index offline_ballot_package on committee.offline_ballot (package_id, package_round);
create index offline_ballot_recommendation_item on committee.offline_ballot (recommendation_item_id);
create index offline_ballot_batch on committee.offline_ballot (batch_id);
create index offline_ballot_imported_by on committee.offline_ballot (imported_by);
create index offline_ballot_vote_item on committee.offline_ballot (vote_item_id, participant_id);
comment on table committee.offline_ballot is
  'A signed paper ballot imported from a committee continuity workbook (BCP-C2; DEC-AMB-008; migration 2120, ADR-048). '
  'Provisional until its member confirms it in the platform (api.confirm_offline_ballot); never counted itself. No '
  'application role reads it: its counts and the member''s own ballot reach the meeting''s read models only.';

-- Integrity: never deleted; a provisional ballot changes once to bind to its vote item, and once to settle.
create function committee.protect_offline_ballot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'offline ballots are never deleted' using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'PROVISIONAL' and new.status = 'PROVISIONAL' and old.vote_item_id is null
     and new.vote_item_id is not null and (to_jsonb(new) - 'vote_item_id') = (to_jsonb(old) - 'vote_item_id') then
    return new;
  end if;
  if old.status = 'PROVISIONAL' and new.status in ('CONFIRMED', 'SUPERSEDED', 'LAPSED')
     and (to_jsonb(new) - array['status', 'vote_id', 'settled_at']) = (to_jsonb(old) - array['status', 'vote_id', 'settled_at'])
     and (new.vote_id is null or exists (select 1 from committee.vote v
                                         where v.id = new.vote_id and v.vote_item_id = old.vote_item_id
                                           and v.participant_id = old.participant_id)) then
    return new;
  end if;
  raise exception 'offline ballot % is settled or immutable', old.id using errcode = 'insufficient_privilege';
end;
$$;
create trigger protect before update or delete on committee.offline_ballot
  for each row execute function committee.protect_offline_ballot();
create trigger protect_truncate before truncate on committee.offline_ballot
  for each statement execute function committee.protect_offline_ballot();

-- No application role reads or writes the table (as committee.vote).
alter table committee.offline_ballot enable row level security;

-- A provisional ballot bound to a vote item that still holds the vote open: its member still counts there (seat,
-- case gate, not replaced) and no re-vote excludes them (DEC-AMB-013).
create function committee.offline_ballot_blocks(p_ballot_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from committee.offline_ballot b
    join committee.vote_item vi on vi.id = b.vote_item_id
    where b.id = p_ballot_id and b.status = 'PROVISIONAL'
      and committee.counts_as_voter(b.participant_id)
      and not decision.revote_excluded(vi.package_id, vi.package_round, b.user_id));
$$;

-- Its member, and whoever runs its meeting (the secretary who imported it, or an acting secretary).
create function authz.can_view_offline_ballot(p_ballot_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from committee.offline_ballot b
    where b.id = p_ballot_id and (b.user_id = authz.current_user_id() or authz.can_manage_meeting(b.meeting_id)));
$$;

-- =============================================================================
-- 3. Staging and commit
-- =============================================================================
-- A ballot's target belongs to the proceeding, in the form its vote takes: a finding in the committee's scope (its
-- current version, CDF-214); a package voted as a whole; an item of a package voted item by item.
create function exchange.bcp_ballot_target_ok(p_committee_proceeding_id uuid, p_kind text, p_target uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(case p_kind
    when 'FINDING' then decision.finding_in_committee_scope(p_target, p_committee_proceeding_id)
    when 'PACKAGE' then exists (select 1 from decision.recommendation_package p
                                where p.id = p_target and p.committee_proceeding_id = p_committee_proceeding_id
                                  and p.vote_granularity = 'PACKAGE')
    when 'RECOMMENDATION_ITEM' then exists (select 1 from decision.recommendation_item i
                                            join decision.recommendation_package p on p.id = i.package_id
                                            where i.id = p_target
                                              and p.committee_proceeding_id = p_committee_proceeding_id
                                              and p.vote_granularity = 'ITEM')
  end, false);
$$;

-- Replaces 2110: as built, plus the ballot rule (above the hash).
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
  v_ballot uuid;
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
    v_ballot := null;
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
    -- 2120 (ADR-048): a paper ballot (BCP-C2) names a member of the proceeding who may vote, never a secretary seat
    -- (so never the importer, whose seat is one), and a target of this proceeding; one ballot per member per target.
    -- The voter is kept in ballot_user_id, never in subject_user_id: R4 and R9 are about conflicts, not votes.
    if v_scope <> 'CASE' and v_sheet.command = 'record_offline_ballot' then
      if v_cells ? 'PARTICIPANT' then
        select pm.user_id into v_ballot from committee.proceeding_member pm
          join iam.user_profile u on u.id = pm.user_id
         where pm.committee_proceeding_id = v_cp.id and lower(u.email) = lower(v_cells ->> 'PARTICIPANT')
           and pm.seat not in ('SECRETARY', 'ALTERNATE_SECRETARY') and (pm.is_voting or pm.seat = 'ALTERNATE_MEMBER')
           and not pm.firewall_restricted and not pm.case_gate_excluded
         limit 1;
      end if;
      if v_detail is null and v_ballot is null then v_detail := 'PARTICIPANT'; end if;
      -- (The column rules have checked TARGET_ID is a UUID when v_detail is still null.)
      if v_detail is null then
        if not exchange.bcp_ballot_target_ok(v_cp.id, v_cells ->> 'TARGET_KIND', (v_cells ->> 'TARGET_ID')::uuid) then
          v_detail := 'TARGET_ID';
        end if;
      end if;
      if v_detail is null and exists (
           select 1 from exchange.bcp_import_row r
           where r.batch_id = v_batch and r.sheet_code = v_sheet.sheet_code and r.state <> 'INVALID'
             and r.ballot_user_id = v_ballot and r.cells ->> 'TARGET_KIND' = v_cells ->> 'TARGET_KIND'
             and r.cells ->> 'TARGET_ID' = v_cells ->> 'TARGET_ID') then
        v_detail := 'DUPLICATE_BALLOT';
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
                                         subject_user_id, ballot_user_id)
    values (v_batch, v_case.id, v_version, v_sheet.sheet_code, (v_el ->> 'row_number')::int,
            case when v_key ~ '^BCP-[A-Z0-9][A-Z0-9-]{0,59}$' or exchange.bcp_is_uuid(v_key) then v_key end,
            v_cells, v_hash, v_event, v_recorder, v_state, v_detail, case when v_state = 'NEW' then 'IMPORT' end,
            v_subject, v_ballot);
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

-- A signed paper ballot of the meeting this workbook reconstructs, imported PROVISIONAL (DEC-AMB-008). Reachable only
-- from a continuity import's row, as the importer running the meeting: no grant. Every check is made again here, at
-- commit, on the platform as it stands:
--   - the meeting is this workbook's, held offline and not yet reopened; the ballot was signed while it was held;
--   - the member sits in it in a voting seat (never a secretary's);
--   - the target is still what the meeting voted on: a finding still current, never of a withdrawn allegation, and
--     recorded before the meeting began; a package still VOTING, unchanged since the meeting began (its round, its
--     items, its state: TARGET_CHANGED otherwise), whose vote for that round has not been opened online, and whose
--     re-vote does not exclude the member (EXCLUDED_BY_CONFLICT); an item still ACTIVE.
-- The package's round is frozen here; a vote item binds the ballot only in that round.
create function exchange.bcp_record_offline_ballot(
  p_batch exchange.bcp_import_batch, p_row exchange.bcp_import_row, p_meeting_id uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  c jsonb := p_row.cells;
  v_kind text := c ->> 'TARGET_KIND';
  v_target uuid;
  v_m committee.meeting;
  v_p committee.meeting_participant;
  v_finding case_mgmt.finding;
  v_item decision.recommendation_item;
  v_pkg decision.recommendation_package;
  v_id uuid;
begin
  if p_batch.scope is distinct from 'COMMITTEE_PROCEEDING' then perform api._fail('CONFLICT', 'SHEET_NOT_IMPORTABLE'); end if;
  select * into v_m from committee.meeting m
   where m.id = p_meeting_id and m.committee_proceeding_id = p_batch.committee_proceeding_id;
  if v_m.id is null or not authz.can_view_meeting(v_m.id) then perform api._fail('NOT_FOUND'); end if;
  -- F3: imported by the secretary running the meeting, never by a member.
  if not committee.manages_meeting(v_m.id, api._actor()) then perform api._fail('FORBIDDEN'); end if;
  if not v_m.held_offline or v_m.status <> 'SCHEDULED' then perform api._fail('INVALID', 'MEETING_REF'); end if;
  if p_row.original_event_at is null or p_row.original_event_at < v_m.scheduled_start
     or p_row.original_event_at > v_m.scheduled_end then
    perform api._fail('INVALID', 'ORIGINAL_EVENT_AT');
  end if;
  select * into v_p from committee.meeting_participant mp
   where mp.meeting_id = v_m.id and mp.user_id = p_row.ballot_user_id and mp.participant_kind = 'MEMBER'
     and mp.seat not in ('SECRETARY', 'ALTERNATE_SECRETARY') and (mp.is_voting or mp.seat = 'ALTERNATE_MEMBER');
  if p_row.ballot_user_id is null or v_p.id is null then perform api._fail('INVALID', 'PARTICIPANT'); end if;
  if not exchange.bcp_is_uuid(c ->> 'TARGET_ID') then perform api._fail('INVALID', 'TARGET_ID'); end if;
  v_target := (c ->> 'TARGET_ID')::uuid;

  if v_kind = 'FINDING' then
    select * into v_finding from case_mgmt.finding f where f.id = v_target;
    if v_finding.id is null or not decision.finding_in_committee_scope(v_finding.id, v_m.committee_proceeding_id) then
      perform api._fail('INVALID', 'TARGET_ID');
    end if;
    if exists (select 1 from case_mgmt.allegation a where a.id = v_finding.allegation_id and a.status = 'WITHDRAWN') then
      perform api._fail('CONFLICT', 'ALLEGATION_WITHDRAWN');
    end if;
    if v_finding.recorded_at > v_m.scheduled_start then perform api._fail('CONFLICT', 'TARGET_CHANGED'); end if;
  elsif v_kind in ('PACKAGE', 'RECOMMENDATION_ITEM') then
    if v_kind = 'RECOMMENDATION_ITEM' then
      select * into v_item from decision.recommendation_item i where i.id = v_target;
      select * into v_pkg from decision.recommendation_package p where p.id = v_item.package_id for share;
    else
      select * into v_pkg from decision.recommendation_package p where p.id = v_target for share;
    end if;
    if v_pkg.id is null or v_pkg.committee_proceeding_id <> v_m.committee_proceeding_id
       or v_pkg.vote_granularity <> (case v_kind when 'PACKAGE' then 'PACKAGE' else 'ITEM' end)
       or (v_kind = 'RECOMMENDATION_ITEM' and v_item.status <> 'ACTIVE') then
      perform api._fail('INVALID', 'TARGET_ID');
    end if;
    if v_pkg.status <> 'VOTING' then perform api._fail('CONFLICT', 'PACKAGE_NOT_VOTING'); end if;
    if v_pkg.updated_at > v_m.scheduled_start then perform api._fail('CONFLICT', 'TARGET_CHANGED'); end if;
    if exists (select 1 from committee.vote_item vi where vi.package_id = v_pkg.id and vi.package_round = v_pkg.round_no) then
      perform api._fail('CONFLICT', 'VOTE_ALREADY_OPENED');
    end if;
    if decision.revote_excluded(v_pkg.id, v_pkg.round_no, p_row.ballot_user_id) then
      perform api._fail('CONFLICT', 'EXCLUDED_BY_CONFLICT');
    end if;
  else
    perform api._fail('INVALID', 'TARGET_KIND');
  end if;

  insert into committee.offline_ballot (meeting_id, participant_id, user_id, case_id, committee_proceeding_id,
                                        target_kind, finding_id, package_id, recommendation_item_id, package_round,
                                        choice, ballot_reference, original_event_at, batch_id, row_id, imported_by)
  values (v_m.id, v_p.id, v_p.user_id, v_m.case_id, v_m.committee_proceeding_id, v_kind, v_finding.id, v_pkg.id,
          v_item.id, v_pkg.round_no, c ->> 'CHOICE', c ->> 'BALLOT_REFERENCE', p_row.original_event_at, p_batch.id,
          p_row.id, api._actor())
  returning id into v_id;
  return v_id;
end;
$$;

-- Replaces 2110: as built, plus 12_VOTES of a BCP-C2 workbook.
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
    when '12_VOTES' then
      -- 2120 (ADR-048): only where the row's template imports ballots (BCP-C2; BCP-C1's stays recorded only), and only
      -- for the meeting this workbook reconstructs, never another (E1).
      if not exists (select 1 from exchange.bcp_template_sheet s
                     where s.template_version = p_row.template_version and s.sheet_code = p_row.sheet_code
                       and s.command = 'record_offline_ballot') then
        perform api._fail('CONFLICT', 'SHEET_NOT_IMPORTABLE');
      end if;
      v_ref := p_refs -> (c ->> 'MEETING_REF');
      if v_ref is null or v_ref ->> 'sheet' <> '09_MEETINGS' then perform api._fail('INVALID', 'MEETING_REF'); end if;
      return exchange.bcp_record_offline_ballot(p_batch, p_row, (v_ref ->> 'id')::uuid);
    else
      perform api._fail('CONFLICT', 'SHEET_NOT_IMPORTABLE');
  end case;
  return null;
end;
$$;

-- Replaces 2110: as built, plus a ballot's provenance.
create or replace function authz.can_view_bcp_provenance(p_object_type text, p_object_id uuid, p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and case p_object_type
    when 'corrective_action' then authz.can_view_corrective_action(p_object_id)
    when 'meeting' then authz.can_view_meeting(p_object_id)
    when 'meeting_conflict_concern' then authz.can_view_meeting_concern(p_object_id)
    -- 2120: a paper ballot's with the ballot: its member and whoever runs its meeting.
    when 'offline_ballot' then authz.can_view_offline_ballot(p_object_id)
    else authz.can_view_case(p_case_id)
  end;
$$;

-- =============================================================================
-- 4. The official record (2115)
-- =============================================================================
-- Replaces 2115 (E1): every ballot to import, like every conflict, names the record's one meeting row.
create or replace function exchange.bcp_record_meeting_row(p_record_id uuid)
returns uuid
language sql stable
set search_path = ''
as $$
  with m as (
    select x.id, x.row_key from exchange.bcp_committee_record r
    join exchange.bcp_import_row x on x.batch_id = r.batch_id
    where r.id = p_record_id and x.sheet_code = '09_MEETINGS' and x.resolution = 'IMPORT')
  select m.id from m
  where (select count(*) from m) = 1
    and not exists (select 1 from exchange.bcp_committee_record r
                    join exchange.bcp_import_row x on x.batch_id = r.batch_id
                    where r.id = p_record_id and x.sheet_code in ('11_CONFLICTS', '12_VOTES')
                      and x.resolution = 'IMPORT'
                      and x.cells ->> 'MEETING_REF' is distinct from m.row_key);
$$;

-- Replaces 2115: as built, plus BALLOT_WITHOUT_ATTENDANCE.
create or replace function exchange.bcp_record_discrepancies(p_record_id uuid, p_attestations boolean)
returns table (code text, roster_id uuid)
language plpgsql stable
set search_path = ''
as $$
declare
  v_rec exchange.bcp_committee_record;
  v_doc exchange.bcp_record_document;
  v_chair exchange.bcp_record_roster;
  v_signatory exchange.bcp_record_roster;
  v_held date;
  v_meeting uuid;
  v_basis text;
begin
  select * into v_rec from exchange.bcp_committee_record r where r.id = p_record_id;
  select * into v_doc from exchange.bcp_record_document d where d.id = v_rec.signed_document_id;
  v_chair := exchange.bcp_record_chair_line(p_record_id);
  v_basis := exchange.bcp_record_chair_basis(p_record_id);
  select * into v_signatory from exchange.bcp_record_roster l where l.record_id = p_record_id and l.signed_as_chair;
  v_meeting := coalesce(v_rec.meeting_row_id, exchange.bcp_record_meeting_row(p_record_id));

  -- Layer 1 missing, or an expected signatory without a visible signature.
  if v_doc.id is null or v_doc.status <> 'SIGNED_OFFICIAL_RECORD' then
    code := 'MISSING_OFFICIAL_SIGNATURE'; roster_id := null; return next;
  end if;
  for roster_id in select l.id from exchange.bcp_record_roster l
                   where l.record_id = p_record_id and l.attendance in ('ATTENDED', 'ATTENDED_PART')
                     and l.seat not in ('SECRETARY', 'ALTERNATE_SECRETARY') and not l.signature_visible
                   order by l.id loop
    code := 'MISSING_OFFICIAL_SIGNATURE'; return next;
  end loop;

  -- The version: the signed one must be the newest stored, and dated the meeting's held day (Riyadh).
  if v_doc.id is not null and exists (select 1 from exchange.bcp_record_document d
                                      where d.record_id = p_record_id and d.version_no > v_doc.version_no
                                        and d.status <> 'QUARANTINED') then
    code := 'DOCUMENT_VERSION_MISMATCH'; roster_id := null; return next;
  end if;
  select (x.original_event_at at time zone 'Asia/Riyadh')::date into v_held
  from exchange.bcp_import_row x where x.id = v_meeting;
  if v_doc.id is not null and v_held is distinct from v_doc.meeting_date then
    code := 'DOCUMENT_VERSION_MISMATCH'; roster_id := null; return next;
  end if;
  if v_rec.submitted_at is not null and exists (
       select 1 from exchange.bcp_import_batch b
       where b.id = v_rec.batch_id and b.submitted_hash is distinct from exchange.bcp_batch_hash(b.id)) then
    code := 'DOCUMENT_VERSION_MISMATCH'; roster_id := null; return next;
  end if;

  -- Who signed as chair: someone must, the chair when the chair can act, else the deputy chair; a signatory attended.
  if v_signatory.id is null or v_signatory.seat not in ('CHAIR', 'DEPUTY_CHAIR')
     or (v_signatory.seat = 'DEPUTY_CHAIR' and v_basis is null)
     or (v_signatory.seat = 'CHAIR' and v_basis is not null and v_basis <> 'INELIGIBLE') then
    code := 'SIGNATURE_MISMATCH'; roster_id := v_signatory.id; return next;
  end if;
  for roster_id in select l.id from exchange.bcp_record_roster l
                   where l.record_id = p_record_id and l.signature_visible and l.attendance in ('ABSENT', 'NOT_DECLARED')
                   order by l.id loop
    code := 'SIGNATURE_MISMATCH'; return next;
  end loop;

  -- Conflict scope: a recused member shown as a signatory.
  for roster_id in select l.id from exchange.bcp_record_roster l
                   where l.record_id = p_record_id and l.signature_visible and l.attendance = 'RECUSED' order by l.id loop
    code := 'CONFLICT_SCOPE_MISMATCH'; return next;
  end loop;

  -- Attendance not declared.
  for roster_id in select l.id from exchange.bcp_record_roster l
                   where l.record_id = p_record_id and l.attendance = 'NOT_DECLARED' order by l.id loop
    code := 'ATTENDANCE_MISMATCH'; return next;
  end loop;

  -- 2120 (ADR-048): a ballot to import comes from an eligible member line the signed minutes show attending, whose
  -- holder attests the record and their ballot with it (§5); any other ballot is a discrepancy.
  for roster_id in select l.id from exchange.bcp_import_row x
                   left join exchange.bcp_record_roster l on l.record_id = p_record_id and l.user_id = x.ballot_user_id
                   where x.batch_id = v_rec.batch_id and x.sheet_code = '12_VOTES' and x.resolution = 'IMPORT'
                     and (l.id is null or l.attendance not in ('ATTENDED', 'ATTENDED_PART')
                          or l.seat in ('SECRETARY', 'ALTERNATE_SECRETARY')
                          or not exchange.bcp_record_line_eligible(l.id))
                   order by x.row_number loop
    code := 'BALLOT_WITHOUT_ATTENDANCE'; return next;
  end loop;

  -- Members' declines on this revision carry their own code.
  for code, roster_id in select a.discrepancy_code, a.roster_id from exchange.bcp_record_attestation a
                         where a.record_id = p_record_id and a.revision = v_rec.revision and a.action = 'DECLINE'
                         order by a.roster_id loop
    return next;
  end loop;

  if p_attestations then
    for roster_id in select l.id from exchange.bcp_record_roster l
                     where l.record_id = p_record_id and exchange.bcp_record_line_state(l.id) = 'PENDING'
                     order by l.id loop
      code := 'MISSING_PLATFORM_ATTESTATION'; return next;
    end loop;
  end if;
end;
$$;

-- =============================================================================
-- 5. Who sees a workbook's ballots before commit (F3)
-- =============================================================================
-- A committee workbook's 12_VOTES rows: its importer only (who transcribed them). The chair who may approve the record
-- reads every other row (2115) and the ballots only as counts. A case workbook's rows as built.
create function authz.can_view_bcp_ballot_rows(p_batch_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from exchange.bcp_import_batch b
    where b.id = p_batch_id and (b.scope = 'CASE' or b.imported_by = authz.current_user_id()));
$$;

drop policy bcp_import_row_read on exchange.bcp_import_row;
create policy bcp_import_row_read on exchange.bcp_import_row for select to authenticated
  using (authz.can_view_bcp_import(batch_id) and subject_user_id is distinct from authz.current_user_id()
         and (sheet_code <> '12_VOTES' or authz.can_view_bcp_ballot_rows(batch_id)));

-- Replaces 2110: as built, with the row list under the same rule.
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
                        -- 2120 (F3): the paper ballots to import, the only form the approver reads them in.
                        'ballots', count(*) filter (where r.ballot_user_id is not null and r.resolution = 'IMPORT'),
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
      where r.batch_id = b.id and r.subject_user_id is distinct from v_me
        -- 2120 (F3): a committee workbook's paper ballots, to its importer only; an approver counts them above.
        and (r.sheet_code <> '12_VOTES' or b.scope = 'CASE' or b.imported_by = v_me)), '[]'::jsonb),
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

-- =============================================================================
-- 6. Binding, settling and lapsing
-- =============================================================================
-- A vote item opened in a meeting held offline binds the provisional ballots signed there on its target (in the same
-- round, for a package). A member a re-vote excludes (DEC-AMB-013) is never bound: their ballot lapses with the
-- meeting.
create function committee.bind_offline_ballots()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  update committee.offline_ballot b
     set vote_item_id = new.id
   where b.meeting_id = new.meeting_id and b.status = 'PROVISIONAL' and b.vote_item_id is null
     and case b.target_kind
           when 'FINDING' then new.target_type = 'FINDING' and b.finding_id = new.finding_id
           when 'PACKAGE' then new.target_type = 'PACKAGE' and b.package_id = new.package_id
                               and b.package_round = new.package_round
           else b.recommendation_item_id = new.recommendation_item_id and b.package_round = new.package_round
         end
     and not decision.revote_excluded(new.package_id, new.package_round, b.user_id);
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform audit.record_event('OFFLINE_BALLOTS_BOUND', 'BUSINESS', 'SUCCESS', new.case_id, 'vote_item', new.id::text,
      null, jsonb_build_object('meeting_id', new.meeting_id, 'ballots', v_n));
  end if;
  return null;
end;
$$;
create trigger vote_item_binds_offline_ballots after insert on committee.vote_item
  for each row execute function committee.bind_offline_ballots();

-- A vote on an item settles its member's provisional ballot there: CONFIRMED when it is the member's own confirmation
-- of that ballot (api.confirm_offline_ballot marks it, and the vote must be theirs, SELF, with the ballot's choice),
-- SUPERSEDED otherwise (their recusal, or the secretary's N6 record).
create function committee.settle_offline_ballot()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_b committee.offline_ballot;
  v_status text;
begin
  select * into v_b from committee.offline_ballot b
   where b.vote_item_id = new.vote_item_id and b.participant_id = new.participant_id and b.status = 'PROVISIONAL'
   for update;
  if v_b.id is null then return null; end if;
  v_status := case when v_b.id::text = current_setting('cdf.offline_ballot_confirming', true)
                        and new.source = 'SELF' and new.recorded_by = v_b.user_id and new.choice = v_b.choice
                   then 'CONFIRMED' else 'SUPERSEDED' end;
  update committee.offline_ballot set status = v_status, vote_id = new.id, settled_at = clock_timestamp()
   where id = v_b.id;
  if v_status = 'SUPERSEDED' then
    perform audit.record_event('OFFLINE_BALLOT_SUPERSEDED', 'BUSINESS', 'SUCCESS', v_b.case_id, 'vote_item',
      new.vote_item_id::text, null,
      jsonb_build_object('meeting_id', v_b.meeting_id, 'ballot_id', v_b.id, 'source', new.source));
  end if;
  return null;
end;
$$;
create trigger vote_settles_offline_ballot after insert on committee.vote
  for each row execute function committee.settle_offline_ballot();

-- A provisional ballot lapses when its vote item leaves OPEN (only a ballot whose member no longer counts can still be
-- provisional then: BALLOTS_UNCONFIRMED), or when its meeting closes or is cancelled (a target never opened there, or
-- an api.close_proceeding, 2117). A lapsed ballot never counts.
create function committee.lapse_offline_ballots()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
  v_meeting uuid;
begin
  if tg_table_name = 'vote_item' then
    if old.status <> 'OPEN' or new.status = 'OPEN' then return null; end if;
    v_meeting := (to_jsonb(new) ->> 'meeting_id')::uuid;
    update committee.offline_ballot b set status = 'LAPSED', settled_at = clock_timestamp()
     where b.vote_item_id = new.id and b.status = 'PROVISIONAL';
  else
    if old.status not in ('SCHEDULED', 'OPEN') or new.status not in ('CLOSED', 'CANCELLED') then return null; end if;
    v_meeting := new.id;
    update committee.offline_ballot b set status = 'LAPSED', settled_at = clock_timestamp()
     where b.meeting_id = new.id and b.status = 'PROVISIONAL';
  end if;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform audit.record_event('OFFLINE_BALLOTS_LAPSED', 'BUSINESS', 'SUCCESS', new.case_id,
      case tg_table_name when 'vote_item' then 'vote_item' else 'meeting' end, new.id::text, null,
      jsonb_build_object('meeting_id', v_meeting, 'ballots', v_n));
  end if;
  return null;
end;
$$;
create trigger vote_item_lapses_offline_ballots after update of status on committee.vote_item
  for each row execute function committee.lapse_offline_ballots();
create trigger meeting_lapses_offline_ballots after update of status on committee.meeting
  for each row execute function committee.lapse_offline_ballots();

-- =============================================================================
-- 7. The member's confirmation
-- =============================================================================
-- The member's own act, in their own transaction (DEC-AMB-008): every check api.cast_vote makes, then their own
-- provisional ballot bound to this item, on the choice they read (BALLOT_CHOICE_MISMATCH otherwise: the ballot stays
-- provisional and the record's transcription is for the secretary and the chair to correct). It writes the member's
-- SELF vote with the ballot's choice and the time the paper was signed; the ballot is CONFIRMED. The ledger gets ids
-- only, never the choice (Q61). The secretary has no path to it: the caller is the member, by construction.
create function api.confirm_offline_ballot(p_vote_item_id uuid, p_choice text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_p committee.meeting_participant;
  v_b committee.offline_ballot;
  v_vote uuid;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  select * into v_p from committee.meeting_participant mp
  where mp.meeting_id = v_item.meeting_id and mp.user_id = v_actor and mp.participant_kind = 'MEMBER';
  if v_p.id is null or not (v_p.is_voting or committee.is_activated_alternate(v_p.id)) then perform api._fail('FORBIDDEN'); end if;
  if committee.is_replaced_member(v_p.id) then perform api._fail('CONFLICT', 'REPLACED_BY_ALTERNATE'); end if;
  if not committee.member_seat_current(v_p.id) then perform api._fail('CONFLICT', 'SEAT_ENDED'); end if;
  if v_p.coi_status <> 'NO_CONFLICT' then perform api._fail('CONFLICT', 'COI_NOT_CLEARED'); end if;
  if v_p.attendance <> 'PRESENT' then perform api._fail('CONFLICT', 'NOT_PRESENT'); end if;
  if v_item.status <> 'OPEN' then perform api._fail('CONFLICT', 'VOTE_NOT_OPEN'); end if;
  if exists (select 1 from committee.vote v where v.vote_item_id = v_item.id and v.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'ALREADY_VOTED');
  end if;
  select * into v_b from committee.offline_ballot b
   where b.vote_item_id = v_item.id and b.participant_id = v_p.id and b.user_id = v_actor and b.status = 'PROVISIONAL'
   for update;
  if v_b.id is null then perform api._fail('CONFLICT', 'NO_PROVISIONAL_BALLOT'); end if;
  if p_choice is null or p_choice not in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED') then perform api._fail('INVALID', 'choice'); end if;
  if p_choice <> v_b.choice then perform api._fail('CONFLICT', 'BALLOT_CHOICE_MISMATCH'); end if;

  perform set_config('cdf.offline_ballot_confirming', v_b.id::text, true);
  insert into committee.vote (vote_item_id, participant_id, recorded_for, recorded_by, source, choice, reason, original_event_at)
  values (v_item.id, v_p.id, v_actor, v_actor, 'SELF', v_b.choice, null, v_b.original_event_at)
  returning id into v_vote;
  perform set_config('cdf.offline_ballot_confirming', '', true);
  if not exists (select 1 from committee.offline_ballot b where b.id = v_b.id and b.status = 'CONFIRMED' and b.vote_id = v_vote) then
    raise exception 'offline ballot % was not confirmed', v_b.id;
  end if;
  perform audit.record_event('OFFLINE_BALLOT_CONFIRMED', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item',
    v_item.id::text, null, jsonb_build_object('meeting_id', v_item.meeting_id, 'ballot_id', v_b.id));
end;
$$;

-- =============================================================================
-- 8. The meeting held offline (F2) and the final vote
-- =============================================================================
-- Whether the committed record of a meeting held offline shows this user's roster line attending (2115).
create function committee.offline_roster_attended(p_meeting_id uuid, p_user_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1 from exchange.bcp_committee_record r
    join exchange.bcp_record_roster l on l.record_id = r.id
    where r.meeting_id = p_meeting_id and r.status = 'COMMITTED' and l.user_id = p_user_id
      and l.attendance in ('ATTENDED', 'ATTENDED_PART'));
$$;

-- Replace 2030: as built, plus OFFLINE_BALLOT_ONLY.
create or replace function api.cast_vote(p_vote_item_id uuid, p_choice text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_p committee.meeting_participant;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  select * into v_p from committee.meeting_participant mp
  where mp.meeting_id = v_item.meeting_id and mp.user_id = v_actor and mp.participant_kind = 'MEMBER';
  if v_p.id is null or not (v_p.is_voting or committee.is_activated_alternate(v_p.id)) then perform api._fail('FORBIDDEN'); end if;
  -- 2120 (F2): a meeting held offline takes its votes only from its members' own paper ballots
  -- (api.confirm_offline_ballot); recusal (api.recuse_for_conflict) and the secretary's N6 records stay.
  if exists (select 1 from committee.meeting m where m.id = v_item.meeting_id and m.held_offline) then
    perform api._fail('CONFLICT', 'OFFLINE_BALLOT_ONLY');
  end if;
  if committee.is_replaced_member(v_p.id) then perform api._fail('CONFLICT', 'REPLACED_BY_ALTERNATE'); end if;
  if not committee.member_seat_current(v_p.id) then perform api._fail('CONFLICT', 'SEAT_ENDED'); end if;
  if v_p.coi_status <> 'NO_CONFLICT' then perform api._fail('CONFLICT', 'COI_NOT_CLEARED'); end if;
  if v_p.attendance <> 'PRESENT' then perform api._fail('CONFLICT', 'NOT_PRESENT'); end if;
  if v_item.status <> 'OPEN' then perform api._fail('CONFLICT', 'VOTE_NOT_OPEN'); end if;
  if p_choice is null or p_choice not in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED') then perform api._fail('INVALID', 'choice'); end if;
  if exists (select 1 from committee.vote v where v.vote_item_id = v_item.id and v.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'ALREADY_VOTED');
  end if;
  insert into committee.vote (vote_item_id, participant_id, recorded_for, recorded_by, source, choice, reason, original_event_at)
  values (v_item.id, v_p.id, v_actor, v_actor, 'SELF', p_choice,
          case when p_reason is not null then api._require_text(p_reason, 'reason', 5, 2000) end, now());
  perform audit.record_event('VOTE_CAST', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id));
end;
$$;

create or replace function api.revise_vote(p_vote_item_id uuid, p_choice text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_p committee.meeting_participant;
  v_vote committee.vote;
  v_rule jsonb;
  v_no int;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  select * into v_p from committee.meeting_participant mp
  where mp.meeting_id = v_item.meeting_id and mp.user_id = v_actor and mp.participant_kind = 'MEMBER';
  if v_p.id is null or not (v_p.is_voting or committee.is_activated_alternate(v_p.id)) then perform api._fail('FORBIDDEN'); end if;
  -- 2120 (F2): a meeting held offline takes its votes only from its members' own paper ballots
  -- (api.confirm_offline_ballot); recusal (api.recuse_for_conflict) and the secretary's N6 records stay.
  if exists (select 1 from committee.meeting m where m.id = v_item.meeting_id and m.held_offline) then
    perform api._fail('CONFLICT', 'OFFLINE_BALLOT_ONLY');
  end if;
  if committee.is_replaced_member(v_p.id) then perform api._fail('CONFLICT', 'REPLACED_BY_ALTERNATE'); end if;
  if not committee.member_seat_current(v_p.id) then perform api._fail('CONFLICT', 'SEAT_ENDED'); end if;
  if v_p.coi_status <> 'NO_CONFLICT' then perform api._fail('CONFLICT', 'COI_NOT_CLEARED'); end if;
  if v_p.attendance <> 'PRESENT' then perform api._fail('CONFLICT', 'NOT_PRESENT'); end if;
  if v_item.status <> 'OPEN' then perform api._fail('CONFLICT', 'VOTE_NOT_OPEN'); end if;
  select cp.rule_snapshot into v_rule
  from committee.meeting m join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
  where m.id = v_item.meeting_id;
  if not coalesce((v_rule ->> 'vote_revision_allowed')::boolean, false) then
    perform api._fail('CONFLICT', 'VOTE_REVISION_NOT_ALLOWED');
  end if;
  if p_choice is null or p_choice not in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED') then perform api._fail('INVALID', 'choice'); end if;
  select * into v_vote from committee.vote v where v.vote_item_id = v_item.id and v.participant_id = v_p.id and v.source = 'SELF';
  if v_vote.id is null then perform api._fail('CONFLICT', 'NOT_VOTED'); end if;
  if committee.vote_choice(v_vote.id) = p_choice then perform api._fail('CONFLICT', 'VOTE_UNCHANGED'); end if;
  select coalesce(max(r.revision_no), 0) + 1 into v_no from committee.vote_revision r where r.vote_id = v_vote.id;
  insert into committee.vote_revision (vote_id, vote_item_id, revision_no, choice, reason)
  values (v_vote.id, v_item.id, v_no, p_choice,
          case when p_reason is not null then api._require_text(p_reason, 'reason', 5, 2000) end);
  -- Secrecy (Q61–Q63): the ledger records that a vote was revised, never the choice.
  perform audit.record_event('VOTE_REVISED', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id, 'revision_no', v_no));
end;
$$;

-- Replaces 2030: as built, plus OFFLINE_ROSTER_MISMATCH.
create or replace function api.record_attendance(p_participant_id uuid, p_attendance text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_p committee.meeting_participant;
  v_m committee.meeting;
begin
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id;
  if v_p.id is null or not authz.can_view_meeting(v_p.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_m := committee.lock_managed_meeting(v_p.meeting_id);
  select * into v_p from committee.meeting_participant mp where mp.id = p_participant_id for update;
  if v_m.status <> 'OPEN' then perform api._fail('CONFLICT', 'MEETING_NOT_OPEN'); end if;
  if exists (select 1 from committee.vote_item vi where vi.meeting_id = v_m.id and vi.status <> 'CLOSED') then
    perform api._fail('CONFLICT', 'VOTE_IN_PROGRESS');
  end if;
  if p_attendance is null or p_attendance not in ('PRESENT', 'ABSENT', 'EXCUSED_CONFLICT') then
    perform api._fail('INVALID', 'attendance');
  end if;
  if p_attendance = 'PRESENT' and v_p.coi_status not in ('NO_CONFLICT', 'NOT_REQUIRED') then
    perform api._fail('CONFLICT', 'COI_NOT_CLEARED');
  end if;
  if (p_attendance = 'EXCUSED_CONFLICT') <> (v_p.coi_status = 'CONFLICT_DECLARED') then
    perform api._fail('CONFLICT', case when p_attendance = 'EXCUSED_CONFLICT' then 'NO_CONFLICT_DECLARED' else 'CONFLICT_DECLARED' end);
  end if;
  -- 2010's trigger refuses this too; checked first so an excluded witness is told so, not asked to acknowledge.
  if exists (select 1 from committee.witness_exclusion x where x.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'WITNESS_EXCLUDED');
  end if;
  if p_attendance = 'PRESENT' and committee.is_replaced_member(v_p.id) then
    perform api._fail('CONFLICT', 'REPLACED_BY_ALTERNATE');
  end if;
  if p_attendance = 'PRESENT' and v_p.participant_kind = 'MEMBER' and not committee.member_seat_current(v_p.id) then
    perform api._fail('CONFLICT', 'SEAT_ENDED');
  end if;
  if p_attendance = 'PRESENT' and v_p.confidentiality_ack_required
     and not exists (select 1 from committee.confidentiality_ack a where a.participant_id = v_p.id) then
    perform api._fail('CONFLICT', 'CONFIDENTIALITY_ACK_REQUIRED');
  end if;
  -- 2120 (F2): in a meeting held offline a member is present only as the committed record's attested roster shows
  -- them: their line ATTENDED or ATTENDED_PART.
  if p_attendance = 'PRESENT' and v_m.held_offline and v_p.participant_kind = 'MEMBER'
     and not committee.offline_roster_attended(v_m.id, v_p.user_id) then
    perform api._fail('CONFLICT', 'OFFLINE_ROSTER_MISMATCH');
  end if;

  update committee.meeting_participant
     set attendance = p_attendance, attendance_recorded_by = v_actor, attendance_recorded_at = now()
   where id = v_p.id;
  perform audit.record_event('ATTENDANCE_RECORDED', 'BUSINESS', 'SUCCESS', v_m.case_id, 'meeting_participant', v_p.id::text, null,
    jsonb_build_object('meeting_id', v_m.id, 'from', v_p.attendance, 'to', p_attendance));
end;
$$;

-- Replaces 2030: as built, plus BALLOTS_UNCONFIRMED.
create or replace function api.close_vote_item(p_vote_item_id uuid, p_custom_quorum_attested boolean)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_item committee.vote_item;
  v_rule jsonb;
  v_q record;
  v_required int;
  v_counts record;
  v_chair_ready boolean;
  v_status text;
  v_result text;
begin
  v_item := committee.lock_vote_item(p_vote_item_id);
  if not authz.can_manage_meeting(v_item.meeting_id) then perform api._fail('FORBIDDEN'); end if;
  if v_item.status <> 'OPEN' then perform api._fail('CONFLICT', 'VOTE_NOT_OPEN'); end if;
  select cp.rule_snapshot into v_rule
  from committee.meeting m join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
  where m.id = v_item.meeting_id;
  select * into v_q from committee.quorum_state(v_item.meeting_id, v_item.package_id, v_item.package_round);

  if v_q.quorum_type = 'CUSTOM' then
    if p_custom_quorum_attested is not true then perform api._fail('INVALID', 'custom_quorum_attested'); end if;
    v_required := null;
  else
    if p_custom_quorum_attested is true then perform api._fail('INVALID', 'custom_quorum_attested'); end if;
    v_required := v_q.required;
  end if;

  if exists (select 1 from committee.meeting_participant mp
             where mp.meeting_id = v_item.meeting_id and mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT'
               and committee.counts_as_voter(mp.id)
               and not decision.revote_excluded(v_item.package_id, v_item.package_round, mp.user_id)
               and not exists (select 1 from committee.vote v where v.vote_item_id = v_item.id and v.participant_id = mp.id)) then
    perform api._fail('CONFLICT', 'VOTES_OUTSTANDING');
  end if;
  -- 2120 (ADR-048, DEC-AMB-008): no vote is final while a counting member's paper ballot bound to it waits. It is
  -- confirmed by them, or superseded by their recusal or by the secretary's N6 record with its reason.
  if exists (select 1 from committee.offline_ballot b
             where b.vote_item_id = v_item.id and committee.offline_ballot_blocks(b.id)) then
    perform api._fail('CONFLICT', 'BALLOTS_UNCONFIRMED');
  end if;

  select count(*) filter (where counted and v.choice = 'APPROVE') as approve,
         count(*) filter (where counted and v.choice = 'REJECT') as reject,
         count(*) filter (where counted and v.choice = 'ABSTAIN') as abstain,
         count(*) filter (where counted and v.choice = 'RECUSED') as recused,
         count(*) filter (where v.choice = 'ABSENT') as absent,
         count(*) filter (where v.choice = 'UNABLE_TO_VOTE') as unable,
         count(*) filter (where not counted and v.choice in ('APPROVE', 'REJECT', 'ABSTAIN', 'RECUSED')) as excluded
    into v_counts
  from (select committee.vote_choice(v.id) as choice,
               (mp.coi_status = 'NO_CONFLICT' and mp.attendance = 'PRESENT' and committee.counts_as_voter(mp.id)) as counted
        from committee.vote v join committee.meeting_participant mp on mp.id = v.participant_id
        where v.vote_item_id = v_item.id) v;

  v_chair_ready := committee.casting_voter(v_item.id) is not null;
  v_status := 'CLOSED';
  if v_q.eligible = 0 or (v_required is not null and v_q.present < v_required) or (v_required is null and v_q.present = 0) then
    v_result := 'NO_QUORUM';
  elsif v_counts.approve > v_counts.reject then
    v_result := 'APPROVED';
  elsif v_counts.reject > v_counts.approve then
    v_result := 'REJECTED';
  elsif v_counts.approve = 0 then
    v_result := coalesce(v_rule ->> 'no_substantive_vote_outcome', 'NO_DECISION');
  elsif coalesce((v_rule ->> 'casting_vote_enabled')::boolean, false) and v_chair_ready then
    v_status := 'AWAITING_CASTING_VOTE';
    v_result := null;
  else
    v_result := 'TIED';
  end if;

  update committee.vote_item
     set status = v_status, result = v_result, eligible_count = v_q.eligible, present_count = v_q.present,
         quorum_required = v_required, custom_quorum_attested = coalesce(p_custom_quorum_attested, false),
         approve_count = v_counts.approve, reject_count = v_counts.reject, abstain_count = v_counts.abstain,
         recused_count = v_counts.recused, absent_count = v_counts.absent, unable_count = v_counts.unable,
         excluded_count = v_counts.excluded, tallied_by = v_actor, tallied_at = now(),
         closed_at = case when v_status = 'CLOSED' then now() end
   where id = v_item.id;
  perform audit.record_event('VOTE_CLOSED', 'BUSINESS', 'SUCCESS', v_item.case_id, 'vote_item', v_item.id::text, null,
    jsonb_build_object('meeting_id', v_item.meeting_id, 'status', v_status, 'result', v_result, 'eligible', v_q.eligible,
                       'present', v_q.present, 'quorum_required', v_required, 'quorum_type', v_q.quorum_type,
                       'custom_quorum_attested', coalesce(p_custom_quorum_attested, false),
                       'decision_rule', coalesce(v_rule ->> 'decision_rule', 'SIMPLE_MAJORITY_SUBSTANTIVE'),
                       'approve', v_counts.approve, 'reject', v_counts.reject, 'abstain', v_counts.abstain,
                       'recused', v_counts.recused, 'absent', v_counts.absent, 'unable', v_counts.unable,
                       'excluded', v_counts.excluded));
  return coalesce(v_result, v_status);
end;
$$;

-- =============================================================================
-- 9. Read models
-- =============================================================================
-- Replaces 2085: as built, plus held_offline, the ballots of each vote item, may_confirm_ballot, and the F2 narrowing
-- of may_vote, may_revise, may_record_present and the item's may_close (flag == command).
create or replace function api.meeting_view(p_meeting_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_me uuid := authz.current_user_id();
  v_m committee.meeting;
  v_cp committee.committee_proceeding;
  v_committee committee.committee;
  v_own committee.meeting_participant;
  v_proceeding_status text;
  v_roster boolean;
  v_delib boolean;
  v_runs boolean;
  v_manage boolean;
  v_attendance_open boolean;
  v_case_active boolean;
  v_metadata boolean;
  v_secret boolean;
  v_items_undecided boolean;
  v_active boolean;
  v_acknowledged boolean;
  v_current_minutes text;
  v_q record;
  v_full boolean;
  v_case jsonb;
  v_concerns jsonb;
  -- 2085.
  v_may_invite boolean;
  v_chair committee.meeting_participant;
  v_chair_basis text;
  v_deputy committee.meeting_participant;
  v_secretary uuid;
  v_may_acting_secretary boolean;
  v_alternates_open boolean;
  v_grievance boolean;
begin
  select * into v_m from committee.meeting m where m.id = p_meeting_id;
  if v_m.id is null then perform api._fail('NOT_FOUND'); end if;
  v_full := authz.can_view_meeting(v_m.id);
  -- Concern-only reader: someone who may not see the meeting but may see one of its concerns (the committee's
  -- conflict authority, or a seated deputy who reverses), reached by MEETING_CONFLICT_DECISION_REQUESTED. Everyone
  -- else gets the same NOT_FOUND as a meeting that does not exist.
  if not v_full and not exists (select 1 from committee.meeting_conflict_concern c
                                where c.meeting_id = v_m.id and authz.can_view_meeting_concern(c.id)) then
    perform api._fail('NOT_FOUND');
  end if;

  v_case_active := exists (select 1 from case_mgmt.case_record c where c.id = v_m.case_id and c.records_state = 'ACTIVE');
  v_metadata := authz.can_view_case_metadata(v_m.case_id);
  v_items_undecided := exists (select 1 from committee.vote_item vi where vi.meeting_id = v_m.id and vi.status <> 'CLOSED');
  v_active := v_m.status in ('SCHEDULED', 'OPEN');
  -- As in 1820: the case is named only to whoever may see its metadata.
  v_case := jsonb_build_object(
    'case_id', case when v_metadata then v_m.case_id end,
    'case_number', case when v_metadata then (select c.case_number from case_mgmt.case_record c where c.id = v_m.case_id) end);
  -- meeting_conflict_concern_read and meeting_conflict_reversal_read: the rows passing authz.can_view_meeting_concern.
  v_concerns := coalesce((
    select jsonb_agg(jsonb_build_object(
             'concern_id', c.id, 'participant_id', c.participant_id, 'raised_by', c.raised_by,
             'raised_as', c.raised_as, 'reason', c.reason, 'raised_at', c.raised_at, 'status', c.status,
             'decided_by', c.decided_by, 'decided_as', c.decided_as, 'decision_reason', c.decision_reason,
             'decided_at', c.decided_at,
             'reversal', (select jsonb_build_object('reversal_id', r.id, 'reversed_by', r.reversed_by,
                                                    'reversed_as', r.reversed_as, 'reason', r.reason,
                                                    'reversed_at', r.reversed_at)
                          from committee.meeting_conflict_reversal r where r.concern_id = c.id),
             'capabilities', jsonb_build_object(
               -- api.decide_meeting_conflict.
               'may_decide', authz.meeting_concern_decider_seat(c.id) is not null and v_case_active
                             and c.status = 'OPEN' and v_active and not v_items_undecided,
               -- api.reverse_meeting_conflict_determination.
               'may_reverse', c.status = 'UPHELD'
                              and not exists (select 1 from committee.meeting_conflict_reversal r where r.concern_id = c.id)
                              and committee.concern_reverser_seat(c.id, v_me) is not null and v_case_active))
           order by c.raised_at, c.id)
    from committee.meeting_conflict_concern c
    where c.meeting_id = v_m.id and authz.can_view_meeting_concern(c.id)), '[]'::jsonb);

  if not v_full then
    -- The concern-only view: the meeting's id and status, the case under its metadata predicate, and the concerns
    -- the caller may see with their two capabilities. No logistics, roster, vote, acting role, exclusion or minutes.
    return jsonb_build_object('meeting_id', v_m.id, 'status', v_m.status, 'case', v_case, 'concerns', v_concerns);
  end if;

  select * into v_cp from committee.committee_proceeding cp where cp.id = v_m.committee_proceeding_id;
  select * into v_committee from committee.committee c where c.id = v_cp.committee_id;
  select p.status into v_proceeding_status from case_mgmt.proceeding p where p.id = v_cp.proceeding_id;
  select * into v_own from committee.meeting_participant mp where mp.meeting_id = v_m.id and mp.user_id = v_me;

  v_roster := authz.can_view_meeting_roster(v_m.id);
  v_delib := authz.can_view_meeting_deliberation(v_m.id);
  v_runs := authz.can_manage_meeting(v_m.id);
  -- committee.lock_managed_meeting: running the meeting, on an active case.
  v_manage := v_runs and v_case_active;
  -- 2065. api.record_attendance and api.record_excused_absence: committee.lock_managed_meeting, then the meeting OPEN
  -- and no vote item undecided.
  v_attendance_open := coalesce(v_manage and v_m.status = 'OPEN' and not v_items_undecided, false);
  v_secret := coalesce(v_cp.rule_snapshot ->> 'ballot_secrecy', 'COMMITTEE_AFTER_CLOSE') = 'SECRET_BALLOT';
  v_acknowledged := v_own.id is not null
                    and exists (select 1 from committee.confidentiality_ack a where a.participant_id = v_own.id);
  select mi.status into v_current_minutes from committee.minutes mi where mi.meeting_id = v_m.id and mi.status <> 'SUPERSEDED';
  select * into v_q from committee.quorum_state(v_m.id);

  -- 2085. api.invite_to_meeting: committee.lock_managed_meeting, the meeting active, and a role the rule enables
  -- (INVITEE_TYPE_DISABLED otherwise). The person or user chosen, and the role a firewall-restricted member may take,
  -- are the command's to answer.
  v_may_invite := coalesce(v_manage and v_active
                           and exists (select 1 from committee.invitee_type_rule r where r.enabled), false);
  -- 2085. api.activate_acting_chair: committee.lock_managed_meeting, the meeting active, no vote item undecided, no
  -- acting chair yet (ALREADY_ACTIVATED); the chair's row as the command reads it and the basis it derives
  -- (CHAIR_AVAILABLE when none); the first eligible deputy chair (NO_ELIGIBLE_DEPUTY), who is not the caller
  -- (meeting_acting_role: activated_by <> user_id).
  if v_manage and v_active and not v_items_undecided
     and not exists (select 1 from committee.meeting_acting_role a
                     where a.meeting_id = v_m.id and a.acting_role = 'ACTING_CHAIR') then
    select * into v_chair from committee.meeting_participant mp
    where mp.meeting_id = v_m.id and mp.participant_kind = 'MEMBER' and mp.seat = 'CHAIR'
    order by mp.added_at, mp.id limit 1;
    v_chair_basis := case
                       when v_chair.id is null then 'VACANT'
                       when v_chair.coi_status = 'CONFLICT_DECLARED' then 'CONFLICTED'
                       when not committee.member_seat_current(v_chair.id)
                            or not authz.user_case_gate(v_chair.user_id, v_m.case_id) then 'INELIGIBLE'
                       when v_chair.attendance in ('ABSENT', 'EXCUSED') then 'ABSENT'
                     end;
    if v_chair_basis is not null then
      select * into v_deputy from committee.meeting_participant mp
      where mp.meeting_id = v_m.id and mp.participant_kind = 'MEMBER' and mp.seat = 'DEPUTY_CHAIR'
        and mp.coi_status = 'NO_CONFLICT' and mp.attendance not in ('ABSENT', 'EXCUSED', 'EXCUSED_CONFLICT')
        and committee.counts_as_voter(mp.id)
      order by mp.added_at, mp.id limit 1;
    end if;
  end if;
  -- 2085. api.activate_acting_secretary: committee.lock_visible_meeting (this view), then the committee's current
  -- secretary in the registry, as the command reads it, passing the case gate, or the meeting's chair
  -- (committee.meeting_chair_as); the case ACTIVE, the meeting active, no vote item undecided, no acting secretary yet,
  -- and an eligible alternate secretary other than the caller (NO_ELIGIBLE_ALTERNATE).
  select ms.user_id into v_secretary from committee.membership ms
  join iam.user_profile u on u.id = ms.user_id and u.status = 'ACTIVE'
  where ms.committee_id = v_cp.committee_id and ms.seat = 'SECRETARY'
    and ms.effective_from <= now() and (ms.effective_to is null or ms.effective_to > now())
  order by ms.effective_from desc limit 1;
  v_may_acting_secretary := coalesce(
    ((v_secretary = v_me and authz.user_case_gate(v_me, v_m.case_id))
     or committee.meeting_chair_as(v_m.id, v_me) is not null)
    and v_case_active and v_active and not v_items_undecided
    and not exists (select 1 from committee.meeting_acting_role a
                    where a.meeting_id = v_m.id and a.acting_role = 'ACTING_SECRETARY')
    and exists (select 1 from committee.membership ms
                join iam.user_profile u on u.id = ms.user_id and u.status = 'ACTIVE'
                where ms.committee_id = v_cp.committee_id and ms.seat = 'ALTERNATE_SECRETARY'
                  and ms.effective_from <= now() and (ms.effective_to is null or ms.effective_to > now())
                  and ms.user_id <> v_me and authz.user_case_gate(ms.user_id, v_m.case_id)
                  and not exists (select 1 from committee.meeting_participant mp
                                  where mp.meeting_id = v_m.id and mp.user_id = ms.user_id
                                    and mp.coi_status = 'CONFLICT_DECLARED')), false);
  -- 2085. api.activate_alternate_member, as far as the meeting goes: committee.lock_managed_meeting, the meeting OPEN
  -- (MEETING_NOT_OPEN), no vote item undecided (VOTE_IN_PROGRESS).
  v_alternates_open := coalesce(v_manage and v_m.status = 'OPEN' and not v_items_undecided, false);
  v_grievance := v_committee.kind = 'GRIEVANCE';

  return jsonb_build_object(
    'meeting_id', v_m.id,
    'committee_proceeding_id', v_m.committee_proceeding_id,
    'committee', jsonb_build_object('committee_id', v_committee.id, 'code', v_committee.code, 'kind', v_committee.kind),
    'case', v_case,
    'logistics', jsonb_build_object(
      'sequence_no', v_m.sequence_no, 'purpose', v_m.purpose, 'mode', v_m.mode, 'provider', v_m.provider,
      'status', v_m.status, 'location', v_m.location, 'online_url', v_m.online_url,
      'scheduled_start', v_m.scheduled_start, 'scheduled_end', v_m.scheduled_end, 'is_emergency', v_m.is_emergency,
      'opened_at', v_m.opened_at, 'closed_at', v_m.closed_at,
      -- 2120 (ADR-048): a meeting held offline takes its votes only from its members' paper ballots.
      'held_offline', v_m.held_offline),
    'me', case when v_own.id is not null then jsonb_build_object(
      'participant_id', v_own.id, 'participant_kind', v_own.participant_kind, 'seat', v_own.seat,
      'invitee_role', v_own.invitee_role, 'is_voting', v_own.is_voting, 'requires_coi', v_own.requires_coi,
      'coi_status', v_own.coi_status, 'attendance', v_own.attendance,
      'confidentiality_ack_required', v_own.confidentiality_ack_required,
      'confidentiality_acknowledged', v_acknowledged,
      -- 2085: the caller's own accommodations (meeting_accommodation_read), for an invitee who sees no roster.
      'accommodations', coalesce((
        select jsonb_agg(jsonb_build_object('accommodation_id', ma.id, 'details', ma.details, 'source', ma.source,
                                            'recorded_at', ma.recorded_at) order by ma.recorded_at, ma.id)
        from committee.meeting_accommodation ma where ma.participant_id = v_own.id), '[]'::jsonb)) end,
    'roster', case when v_roster then coalesce((
      select jsonb_agg(jsonb_build_object(
               'participant_id', mp.id, 'participant_kind', mp.participant_kind, 'user_id', mp.user_id,
               'person_id', mp.person_id, 'display_name', u.display_name, 'display_name_ar', u.display_name_ar,
               'seat', mp.seat, 'invitee_role', mp.invitee_role, 'is_voting', mp.is_voting,
               'requires_coi', mp.requires_coi, 'coi_status', mp.coi_status, 'attendance', mp.attendance,
               -- 2085: the members the alternate on this row may replace now (api.activate_alternate_member), for the
               -- meeting's runner only; empty on any other row and for anyone else.
               'alternate_for', af.ids,
               -- 2085: what confidentiality_ack_read and meeting_accommodation_read let the caller read about this
               -- participant: the meeting's runner (authz.can_manage_meeting) on any row, a participant on their own
               -- (this view is authz.can_view_meeting). Null for anyone else. The details may concern health (AMB-157).
               'arrangements', case when v_runs or mp.user_id = v_me then jsonb_build_object(
                 'confidentiality_acknowledged',
                   exists (select 1 from committee.confidentiality_ack a where a.participant_id = mp.id),
                 'accommodations', coalesce((
                   select jsonb_agg(jsonb_build_object('accommodation_id', ma.id, 'details', ma.details,
                                                       'source', ma.source, 'recorded_at', ma.recorded_at)
                                    order by ma.recorded_at, ma.id)
                   from committee.meeting_accommodation ma where ma.participant_id = mp.id), '[]'::jsonb)) end,
               -- 2065: what the caller may record about this participant now. Computed only for the meeting's runner
               -- (any row) or on the caller's own row (the commands a participant runs on themself); on anyone else's
               -- row every flag is false, so no flag tells one participant about another.
               'capabilities', case when v_runs or mp.user_id = v_me then jsonb_build_object(
                 -- api.record_attendance with each value: v_attendance_open, then the participant's checks for that
                 -- value in the command's order, and committee.refuse_excluded_participant on the update (2010).
                 'may_record_present', coalesce(v_attendance_open and mp.coi_status in ('NO_CONFLICT', 'NOT_REQUIRED')
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id)
                     and not committee.is_replaced_member(mp.id)
                     and (mp.participant_kind <> 'MEMBER' or committee.member_seat_current(mp.id))
                     and (not mp.confidentiality_ack_required
                          or exists (select 1 from committee.confidentiality_ack a where a.participant_id = mp.id))
                     -- 2120 (F2): in a meeting held offline, a member only as their attested roster line attended.
                     and (not v_m.held_offline or mp.participant_kind <> 'MEMBER'
                          or committee.offline_roster_attended(v_m.id, mp.user_id)),
                     false),
                 'may_record_absent', coalesce(v_attendance_open and mp.coi_status <> 'CONFLICT_DECLARED'
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 'may_record_excused_conflict', coalesce(v_attendance_open and mp.coi_status = 'CONFLICT_DECLARED'
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 -- api.record_excused_absence: v_attendance_open, no declared conflict, not already excused, and
                 -- committee.refuse_excluded_participant on the update.
                 'may_record_excused_absence', coalesce(v_attendance_open and mp.coi_status <> 'CONFLICT_DECLARED'
                     and mp.attendance <> 'EXCUSED'
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 -- api.raise_meeting_conflict about this participant: the runner, or a member with no conflict cleared
                 -- for the case; never one's own row; an active case and meeting, no vote item undecided, a
                 -- declaration required and not a conflict already, no concern open; and
                 -- committee.refuse_excluded_participant on the insert.
                 'may_raise_concern', coalesce(
                     (v_runs or (v_own.id is not null and v_own.participant_kind = 'MEMBER'
                                 and v_own.coi_status = 'NO_CONFLICT' and authz.user_case_gate(v_me, v_m.case_id)))
                     and mp.user_id is distinct from v_me
                     and v_case_active and v_active and not v_items_undecided
                     and mp.requires_coi and mp.coi_status <> 'CONFLICT_DECLARED'
                     and not exists (select 1 from committee.meeting_conflict_concern c
                                     where c.participant_id = mp.id and c.status = 'OPEN')
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 -- 2085. api.exclude_meeting_witness: committee.lock_managed_meeting, the meeting active, a WITNESS
                 -- invitee, not already excluded (ALREADY_EXCLUDED), no concern about them open (CONCERN_OPEN).
                 'may_exclude_witness', coalesce(v_manage and v_active
                     and mp.participant_kind = 'INVITEE' and mp.invitee_role = 'WITNESS'
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id)
                     and not exists (select 1 from committee.meeting_conflict_concern c
                                     where c.participant_id = mp.id and c.status = 'OPEN'),
                     false),
                 -- 2085. api.record_meeting_accommodation: the participant themself (SELF), or the meeting's runner
                 -- (SECRETARY; the command takes authz.can_manage_meeting without the case check); the meeting
                 -- active; committee.refuse_excluded_participant on the insert.
                 'may_record_accommodation', coalesce((mp.user_id = v_me or v_runs) and v_active
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 -- 2085. api.declare_meeting_conflict for this participant: themself (SELF), or the meeting's runner
                 -- for an invitee without an account (SECRETARY, ADR-054 §5); then the checks of 2065's meeting-level
                 -- flags, which answer the caller's own row: the meeting active, a member's seat current
                 -- (SEAT_ENDED), a declaration required, none final yet (COI_ALREADY_DECLARED), no conflict a member
                 -- declared at an earlier meeting of the proceeding (PRIOR_CONFLICT_DECLARED), and
                 -- committee.refuse_excluded_participant on the update.
                 'may_declare_conflict', coalesce((mp.user_id = v_me or (mp.user_id is null and v_runs)) and v_active
                     and (mp.participant_kind <> 'MEMBER' or committee.member_seat_current(mp.id))
                     and mp.requires_coi and mp.coi_status <> 'CONFLICT_DECLARED'
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 'may_declare_no_conflict', coalesce((mp.user_id = v_me or (mp.user_id is null and v_runs)) and v_active
                     and (mp.participant_kind <> 'MEMBER' or committee.member_seat_current(mp.id))
                     and mp.requires_coi and mp.coi_status not in ('NO_CONFLICT', 'CONFLICT_DECLARED')
                     and not (mp.participant_kind = 'MEMBER' and exists (
                       select 1 from committee.meeting_participant prior
                       join committee.meeting pm on pm.id = prior.meeting_id
                       where pm.committee_proceeding_id = v_m.committee_proceeding_id and pm.id <> v_m.id
                         and prior.proceeding_member_id = mp.proceeding_member_id
                         and prior.coi_status = 'CONFLICT_DECLARED'
                         and committee.conflict_counts(prior.id)))
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 -- 2085. api.acknowledge_meeting_confidentiality for this participant: themself, or the meeting's
                 -- runner for an invitee without an account; the meeting active, an acknowledgement required
                 -- (ACK_NOT_REQUIRED) and not made (ALREADY_ACKNOWLEDGED), and committee.refuse_excluded_participant
                 -- on the insert.
                 'may_acknowledge_confidentiality', coalesce((mp.user_id = v_me or (mp.user_id is null and v_runs))
                     and v_active and mp.confidentiality_ack_required
                     and not exists (select 1 from committee.confidentiality_ack a where a.participant_id = mp.id)
                     and not exists (select 1 from committee.witness_exclusion x where x.participant_id = mp.id),
                     false),
                 -- 2085. api.activate_alternate_member with this alternate: at least one member in alternate_for.
                 'may_activate_alternate', jsonb_array_length(af.ids) > 0)
               else jsonb_build_object('may_record_present', false, 'may_record_absent', false,
                                       'may_record_excused_conflict', false, 'may_record_excused_absence', false,
                                       'may_raise_concern', false, 'may_exclude_witness', false,
                                       'may_record_accommodation', false, 'may_declare_conflict', false,
                                       'may_declare_no_conflict', false, 'may_acknowledge_confidentiality', false,
                                       'may_activate_alternate', false) end)
             order by mp.added_at, mp.id)
      from committee.meeting_participant mp
      left join iam.user_profile u on u.id = mp.user_id
      -- 2085. api.activate_alternate_member, for the runner: this row an alternate member (INVALID otherwise), not
      -- activated yet (ALTERNATE_ALREADY_ACTIVE), with no conflict (COI_NOT_CLEARED), a current seat and the case gate
      -- (ALTERNATE_INELIGIBLE), on a grievance never one who sat on the case's Investigation Committee
      -- (FIREWALL_RESTRICTED), and not the caller (meeting_acting_role: activated_by <> user_id). Each member it may
      -- replace: a voting MEMBER of the meeting (INVALID otherwise), not replaced yet (ALREADY_REPLACED), with the
      -- basis the command derives (MEMBER_AVAILABLE when none).
      cross join lateral (
        select case when v_alternates_open and mp.participant_kind = 'MEMBER' and mp.seat = 'ALTERNATE_MEMBER'
                         and not committee.is_activated_alternate(mp.id)
                         and mp.coi_status = 'NO_CONFLICT'
                         and committee.member_seat_current(mp.id) and authz.user_case_gate(mp.user_id, v_m.case_id)
                         and not (v_grievance
                                  and authz.participated_in_investigation_committee(mp.user_id, v_m.case_id))
                         and mp.user_id <> v_me
                    then coalesce((
                      select jsonb_agg(r.id order by r.added_at, r.id)
                      from committee.meeting_participant r
                      where r.meeting_id = v_m.id and r.participant_kind = 'MEMBER' and r.seat = 'MEMBER'
                        and r.is_voting and not committee.is_replaced_member(r.id)
                        and (r.coi_status = 'CONFLICT_DECLARED'
                             or not committee.member_seat_current(r.id)
                             or not authz.user_case_gate(r.user_id, v_m.case_id)
                             or r.attendance in ('ABSENT', 'EXCUSED'))), '[]'::jsonb)
                    else '[]'::jsonb end as ids) af
      where mp.meeting_id = v_m.id), '[]'::jsonb) end,
    'deliberation', case when v_delib then jsonb_build_object(
      'ballot_secrecy', case when v_secret then 'SECRET_BALLOT' else 'COMMITTEE_AFTER_CLOSE' end,
      'quorum', case when v_roster then jsonb_build_object(
        'quorum_type', v_q.quorum_type, 'eligible', v_q.eligible, 'present', v_q.present, 'required', v_q.required) end,
      'vote_items', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'vote_item_id', vi.id, 'sequence_no', vi.sequence_no, 'target_type', vi.target_type,
                 'finding_id', vi.finding_id, 'package_id', vi.package_id,
                 'recommendation_item_id', vi.recommendation_item_id, 'package_round', vi.package_round,
                 'title', vi.title, 'status', vi.status, 'result', vi.result,
                 'decided_by_casting_vote', vi.decided_by_casting_vote, 'opened_at', vi.opened_at,
                 'closed_at', vi.closed_at,
                 'tally', case when vi.tallied_at is not null then jsonb_build_object(
                   'eligible', vi.eligible_count, 'present', vi.present_count, 'quorum_required', vi.quorum_required,
                   'approve', vi.approve_count, 'reject', vi.reject_count, 'abstain', vi.abstain_count,
                   'recused', vi.recused_count, 'absent', vi.absent_count, 'unable', vi.unable_count,
                   'excluded', vi.excluded_count) end,
                 'i_have_voted', v_own.id is not null and exists (
                   select 1 from committee.vote v where v.vote_item_id = vi.id and v.participant_id = v_own.id),
                 -- 2065: the caller's own note on this item exists (never its text).
                 'i_have_noted', v_own.id is not null and exists (
                   select 1 from committee.vote_note n where n.vote_item_id = vi.id and n.participant_id = v_own.id),
                 -- 2065. api.record_vote_for_member, for the meeting's runner only (empty for anyone else): the members
                 -- for whom it would record ABSENT, UNABLE_TO_VOTE or RECUSED now. A counting seat that is not
                 -- replaced, never the runner themself, not present, no vote yet, the item OPEN, and
                 -- decision.refuse_excluded_vote on the vote's insert.
                 'record_vote_for', case when v_runs and v_m.status = 'OPEN' and vi.status = 'OPEN' then coalesce((
                     select jsonb_agg(mp.id order by mp.added_at, mp.id)
                     from committee.meeting_participant mp
                     where mp.meeting_id = v_m.id and mp.participant_kind = 'MEMBER'
                       and (mp.is_voting or committee.is_activated_alternate(mp.id))
                       and not committee.is_replaced_member(mp.id)
                       and mp.user_id is distinct from v_me
                       and mp.attendance <> 'PRESENT'
                       and not exists (select 1 from committee.vote v
                                       where v.vote_item_id = vi.id and v.participant_id = mp.id)
                       and not decision.revote_excluded(vi.package_id, vi.package_round, mp.user_id)), '[]'::jsonb)
                   else '[]'::jsonb end,
                 -- 2120 (ADR-048): the paper ballots bound to this item, counted by state (never a choice); the
                 -- caller's own ballot with its choice, for the caller only; and, for the meeting's runner only, the
                 -- counting members whose ballot still waits (api.close_vote_item: BALLOTS_UNCONFIRMED).
                 'offline_ballots', (select jsonb_build_object(
                     'provisional', count(*) filter (where b.status = 'PROVISIONAL'),
                     'confirmed', count(*) filter (where b.status = 'CONFIRMED'),
                     'superseded', count(*) filter (where b.status = 'SUPERSEDED'),
                     'lapsed', count(*) filter (where b.status = 'LAPSED'))
                   from committee.offline_ballot b where b.vote_item_id = vi.id),
                 'my_ballot', (select jsonb_build_object('ballot_id', b.id, 'status', b.status, 'choice', b.choice,
                                                         'ballot_reference', b.ballot_reference,
                                                         'original_event_at', b.original_event_at)
                               from committee.offline_ballot b where b.vote_item_id = vi.id and b.user_id = v_me),
                 'ballots_unconfirmed_for', case when v_runs and v_m.status = 'OPEN' and vi.status = 'OPEN' then coalesce((
                     select jsonb_agg(b.participant_id order by mp.added_at, mp.id)
                     from committee.offline_ballot b join committee.meeting_participant mp on mp.id = b.participant_id
                     where b.vote_item_id = vi.id and committee.offline_ballot_blocks(b.id)), '[]'::jsonb)
                   else '[]'::jsonb end,
                 'capabilities', jsonb_build_object(
                   -- api.cast_vote (committee.lock_vote_item: the meeting is OPEN); 2120 (F2): never in a meeting held
                   -- offline (OFFLINE_BALLOT_ONLY).
                   'may_vote', v_m.status = 'OPEN' and not v_m.held_offline
                               and v_own.id is not null and v_own.participant_kind = 'MEMBER'
                               and (v_own.is_voting or committee.is_activated_alternate(v_own.id))
                               and not committee.is_replaced_member(v_own.id)
                               and committee.member_seat_current(v_own.id)
                               and v_own.coi_status = 'NO_CONFLICT' and v_own.attendance = 'PRESENT'
                               and vi.status = 'OPEN'
                               -- DEC-AMB-013: never on a re-vote that excludes the caller (decision.refuse_excluded_vote).
                               and not decision.revote_excluded(vi.package_id, vi.package_round, v_me)
                               and not exists (select 1 from committee.vote v
                                               where v.vote_item_id = vi.id and v.participant_id = v_own.id),
                   -- api.close_vote_item: running the meeting, the item OPEN, no counting member present without a vote.
                   'may_close', v_m.status = 'OPEN' and v_runs and vi.status = 'OPEN'
                                and not exists (select 1 from committee.meeting_participant mp
                                                where mp.meeting_id = v_m.id and mp.coi_status = 'NO_CONFLICT'
                                                  and mp.attendance = 'PRESENT' and committee.counts_as_voter(mp.id)
                                                  and not decision.revote_excluded(vi.package_id, vi.package_round,
                                                                                   mp.user_id)
                                                  and not exists (select 1 from committee.vote v
                                                                  where v.vote_item_id = vi.id and v.participant_id = mp.id))
                                -- 2120: and no counting member's paper ballot still waiting (BALLOTS_UNCONFIRMED).
                                and not exists (select 1 from committee.offline_ballot b
                                                where b.vote_item_id = vi.id and committee.offline_ballot_blocks(b.id)),
                   -- api.cast_casting_vote: only the item's casting voter, on a tie the rule lets them break.
                   'may_cast_casting_vote', v_m.status = 'OPEN' and vi.status = 'AWAITING_CASTING_VOTE'
                                            and exists (select 1 from committee.meeting_participant c
                                                        where c.id = committee.casting_voter(vi.id) and c.user_id = v_me),
                   -- 2065. api.revise_vote: api.cast_vote's checks up to the item being OPEN, then the rule snapshot
                   -- allows a revision (AMB-081) and the caller has their own vote on the item.
                   -- 2120 (F2): never in a meeting held offline (OFFLINE_BALLOT_ONLY).
                   'may_revise', coalesce(v_m.status = 'OPEN' and not v_m.held_offline
                                          and v_own.id is not null and v_own.participant_kind = 'MEMBER'
                                          and (v_own.is_voting or committee.is_activated_alternate(v_own.id))
                                          and not committee.is_replaced_member(v_own.id)
                                          and committee.member_seat_current(v_own.id)
                                          and v_own.coi_status = 'NO_CONFLICT' and v_own.attendance = 'PRESENT'
                                          and vi.status = 'OPEN'
                                          and coalesce((v_cp.rule_snapshot ->> 'vote_revision_allowed')::boolean, false)
                                          and exists (select 1 from committee.vote v
                                                      where v.vote_item_id = vi.id and v.participant_id = v_own.id
                                                        and v.source = 'SELF'), false),
                   -- api.recuse_for_conflict (AMB-077): a counting seat, no conflict, present, the item OPEN, no vote
                   -- yet, and decision.refuse_excluded_vote on the vote's insert (DEC-AMB-013).
                   'may_recuse_for_conflict', coalesce(v_m.status = 'OPEN' and v_own.id is not null
                                          and v_own.participant_kind = 'MEMBER'
                                          and (v_own.is_voting or committee.is_activated_alternate(v_own.id))
                                          and v_own.coi_status = 'NO_CONFLICT' and v_own.attendance = 'PRESENT'
                                          and vi.status = 'OPEN'
                                          and not exists (select 1 from committee.vote v
                                                          where v.vote_item_id = vi.id and v.participant_id = v_own.id)
                                          and not decision.revote_excluded(vi.package_id, vi.package_round, v_me), false),
                   -- api.record_vote_note (AMB-082): the meeting OPEN (committee.lock_vote_item), the caller's own
                   -- vote on the item, the rule snapshot allows a note, and none recorded yet.
                   'may_record_note', coalesce(v_m.status = 'OPEN' and v_own.id is not null
                                          and v_own.participant_kind = 'MEMBER'
                                          and exists (select 1 from committee.vote v
                                                      where v.vote_item_id = vi.id and v.participant_id = v_own.id
                                                        and v.source = 'SELF')
                                          and coalesce((v_cp.rule_snapshot ->> 'dissent_note_allowed')::boolean, false)
                                          and not exists (select 1 from committee.vote_note n
                                                          where n.vote_item_id = vi.id and n.participant_id = v_own.id),
                                          false),
                   -- 2120. api.confirm_offline_ballot: api.cast_vote's checks up to the item being OPEN, no vote yet,
                   -- the caller's own provisional ballot bound to this item, and decision.refuse_excluded_vote on the
                   -- vote's insert (a ballot is never bound for a member a re-vote excludes).
                   'may_confirm_ballot', coalesce(v_m.status = 'OPEN' and v_own.id is not null
                                          and v_own.participant_kind = 'MEMBER'
                                          and (v_own.is_voting or committee.is_activated_alternate(v_own.id))
                                          and not committee.is_replaced_member(v_own.id)
                                          and committee.member_seat_current(v_own.id)
                                          and v_own.coi_status = 'NO_CONFLICT' and v_own.attendance = 'PRESENT'
                                          and vi.status = 'OPEN'
                                          and not exists (select 1 from committee.vote v
                                                          where v.vote_item_id = vi.id and v.participant_id = v_own.id)
                                          and exists (select 1 from committee.offline_ballot b
                                                      where b.vote_item_id = vi.id and b.participant_id = v_own.id
                                                        and b.user_id = v_me and b.status = 'PROVISIONAL')
                                          and not decision.revote_excluded(vi.package_id, vi.package_round, v_me),
                                          false)))
               order by vi.sequence_no)
        from committee.vote_item vi where vi.meeting_id = v_m.id), '[]'::jsonb),
      'witness_exclusions', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'exclusion_id', x.id, 'participant_id', x.participant_id, 'reason', x.reason,
                 'excluded_by', x.excluded_by, 'excluded_at', x.excluded_at) order by x.excluded_at, x.id)
        from committee.witness_exclusion x where x.meeting_id = v_m.id), '[]'::jsonb)) end,
    'concerns', v_concerns,
    'acting_roles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'acting_role_id', a.id, 'acting_role', a.acting_role, 'user_id', a.user_id,
               'participant_id', a.participant_id, 'replaces_participant_id', a.replaces_participant_id,
               'basis', a.basis, 'activated_as', a.activated_as, 'activated_at', a.activated_at)
             order by a.activated_at, a.id)
      from committee.meeting_acting_role a
      where a.meeting_id = v_m.id and (v_delib or a.user_id = v_me)), '[]'::jsonb),
    'minutes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'minutes_id', mi.id, 'version_no', mi.version_no, 'status', mi.status,
               'generated_at', mi.generated_at, 'finalised_at', mi.finalised_at) order by mi.version_no)
      from committee.minutes mi
      where mi.meeting_id = v_m.id
        and (v_delib or (mi.status in ('APPROVED', 'DEEMED_APPROVED') and authz.can_view_case(mi.case_id)))), '[]'::jsonb),
    -- 2085: the roles api.invite_to_meeting accepts now, for whoever may invite; empty for anyone else.
    'invitee_roles', case when v_may_invite then coalesce((
      select jsonb_agg(jsonb_build_object('invitee_role', r.invitee_role,
                                          'confidentiality_ack_required', r.confidentiality_ack_required,
                                          'source_status', r.source_status)
             order by array_position(array['WITNESS', 'EXPERT', 'LEGAL', 'INFORMATION_PROVIDER', 'SUBJECT',
                                           'INTERPRETER'], r.invitee_role))
      from committee.invitee_type_rule r where r.enabled), '[]'::jsonb) else '[]'::jsonb end,
    'capabilities', jsonb_build_object(
      'can_manage', v_manage,
      -- api.open_meeting, api.close_meeting, api.cancel_meeting.
      'may_open', v_manage and v_m.status = 'SCHEDULED'
                  and coalesce(v_proceeding_status not in ('CONCLUDED', 'CANCELLED', 'SUSPENDED'), false),
      'may_close', v_manage and v_m.status = 'OPEN' and not v_items_undecided,
      'may_cancel', v_manage and v_m.status = 'SCHEDULED',
      -- api.open_vote_item with its triggers: no open concern about an undeclared participant, quorum now.
      'may_open_vote', v_manage and v_m.status = 'OPEN'
                       and not exists (select 1 from committee.meeting_conflict_concern c
                                       join committee.meeting_participant mp on mp.id = c.participant_id
                                       where c.meeting_id = v_m.id and c.status = 'OPEN'
                                         and mp.coi_status <> 'CONFLICT_DECLARED')
                       and v_q.eligible > 0 and v_q.present > 0 and (v_q.required is null or v_q.present >= v_q.required),
      -- api.generate_minutes: closed, and no current version unless changes were requested.
      'may_generate_minutes', v_manage and v_m.status = 'CLOSED'
                              and coalesce(v_current_minutes = 'CHANGES_REQUESTED', true),
      -- api.raise_meeting_conflict, as far as the actor and the meeting go; the participant's own checks (not oneself,
      -- a declaration required and not yet made, no concern already open) are the command's to answer.
      'may_raise_concern', coalesce((v_runs
                                     or (v_own.id is not null and v_own.participant_kind = 'MEMBER'
                                         and v_own.coi_status = 'NO_CONFLICT'
                                         and authz.user_case_gate(v_me, v_m.case_id)))
                                    and v_case_active and v_active and not v_items_undecided, false),
      -- api.declare_meeting_conflict on the caller's own row. 2065 adds two of the command's checks that 2030's flags
      -- left out: a member's seat must be current (CONFLICT:SEAT_ENDED, added to the command by 2050 for CDF-212),
      -- and the participant's update is refused for an excluded witness (committee.refuse_excluded_participant,
      -- 2010), who may still see the meeting through the case.
      'may_declare_conflict', coalesce(v_own.id is not null and v_active
                              and (v_own.participant_kind <> 'MEMBER' or committee.member_seat_current(v_own.id))
                              and v_own.requires_coi
                              and v_own.coi_status <> 'CONFLICT_DECLARED'
                              and not exists (select 1 from committee.witness_exclusion x
                                              where x.participant_id = v_own.id), false),
      'may_declare_no_conflict', coalesce(v_own.id is not null and v_active
                                 and (v_own.participant_kind <> 'MEMBER' or committee.member_seat_current(v_own.id))
                                 and v_own.requires_coi
                                 and v_own.coi_status not in ('NO_CONFLICT', 'CONFLICT_DECLARED')
                                 and not (v_own.participant_kind = 'MEMBER' and exists (
                                   select 1 from committee.meeting_participant prior
                                   join committee.meeting pm on pm.id = prior.meeting_id
                                   where pm.committee_proceeding_id = v_m.committee_proceeding_id and pm.id <> v_m.id
                                     and prior.proceeding_member_id = v_own.proceeding_member_id
                                     and prior.coi_status = 'CONFLICT_DECLARED'
                                     and committee.conflict_counts(prior.id)))
                                 and not exists (select 1 from committee.witness_exclusion x
                                                 where x.participant_id = v_own.id), false),
      -- api.acknowledge_meeting_confidentiality on the caller's own row. 2065 adds the trigger that refuses the
      -- acknowledgement of an excluded witness (committee.refuse_excluded_participant, 2030).
      'may_acknowledge_confidentiality', coalesce(v_own.id is not null and v_active
                                         and v_own.confidentiality_ack_required and not v_acknowledged
                                         and not exists (select 1 from committee.witness_exclusion x
                                                         where x.participant_id = v_own.id), false),
      -- 2085 (computed above): api.invite_to_meeting, api.activate_acting_chair, api.activate_acting_secretary.
      'may_invite', v_may_invite,
      -- 2085. api.record_meeting_accommodation on the caller's own row (SELF), as 2065's flags above answer the
      -- declaration and the acknowledgement: for an invitee, who sees no roster row to carry it.
      'may_record_accommodation', coalesce(v_own.id is not null and v_active
                                           and not exists (select 1 from committee.witness_exclusion x
                                                           where x.participant_id = v_own.id), false),
      'may_activate_acting_chair', coalesce(v_deputy.id is not null and v_deputy.user_id <> v_me, false),
      'may_activate_acting_secretary', v_may_acting_secretary));
end;
$$;

-- Replaces 2030: as built, plus the ballots of the item.
create or replace function api.vote_item_status(p_vote_item_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_item committee.vote_item;
  v_closed boolean;
  v_secret boolean;
begin
  select * into v_item from committee.vote_item vi where vi.id = p_vote_item_id;
  if v_item.id is null or not authz.can_view_meeting_deliberation(v_item.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_closed := v_item.status = 'CLOSED';
  select coalesce(cp.rule_snapshot ->> 'ballot_secrecy', 'COMMITTEE_AFTER_CLOSE') = 'SECRET_BALLOT' into v_secret
  from committee.meeting m join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id
  where m.id = v_item.meeting_id;
  return jsonb_build_object(
    'vote_item_id', v_item.id, 'status', v_item.status, 'result', v_item.result,
    'decided_by_casting_vote', v_item.decided_by_casting_vote,
    -- 2120 (ADR-048): the paper ballots bound to this item, counted by state (never a choice), and the caller's own
    -- ballot with its choice, for the caller only.
    'offline_ballots', (select jsonb_build_object(
        'provisional', count(*) filter (where b.status = 'PROVISIONAL'),
        'confirmed', count(*) filter (where b.status = 'CONFIRMED'),
        'superseded', count(*) filter (where b.status = 'SUPERSEDED'),
        'lapsed', count(*) filter (where b.status = 'LAPSED'))
      from committee.offline_ballot b where b.vote_item_id = v_item.id),
    'my_ballot', (select jsonb_build_object('ballot_id', b.id, 'status', b.status, 'choice', b.choice,
                                            'ballot_reference', b.ballot_reference,
                                            'original_event_at', b.original_event_at)
                  from committee.offline_ballot b
                  where b.vote_item_id = v_item.id and b.user_id = authz.current_user_id()),
    'ballot_secrecy', case when v_secret then 'SECRET_BALLOT' else 'COMMITTEE_AFTER_CLOSE' end,
    'casting_vote', case when v_closed then (select cv.choice from committee.casting_vote cv where cv.vote_item_id = v_item.id) end,
    'tally', case when v_item.tallied_at is not null then jsonb_build_object(
      'eligible', v_item.eligible_count, 'present', v_item.present_count, 'quorum_required', v_item.quorum_required,
      'approve', v_item.approve_count, 'reject', v_item.reject_count, 'abstain', v_item.abstain_count,
      'recused', v_item.recused_count, 'absent', v_item.absent_count, 'unable', v_item.unable_count,
      'excluded', v_item.excluded_count) end,
    'voters', coalesce((
      select jsonb_agg(jsonb_build_object(
               'participant_id', mp.id, 'user_id', mp.user_id, 'seat', mp.seat,
               'activated_alternate', committee.is_activated_alternate(mp.id),
               'replaced', committee.is_replaced_member(mp.id),
               'has_voted', v.id is not null, 'voted_at', v.recorded_at, 'source', v.source,
               'choice', case when v_closed and not v_secret then committee.vote_choice(v.id) end) order by mp.added_at, mp.id)
      from committee.meeting_participant mp
      left join committee.vote v on v.participant_id = mp.id and v.vote_item_id = v_item.id
      where mp.meeting_id = v_item.meeting_id and mp.participant_kind = 'MEMBER'
        and (mp.is_voting or committee.is_activated_alternate(mp.id))), '[]'::jsonb),
    'notes', case when v_closed then coalesce((
      select jsonb_agg(jsonb_build_object('participant_id', case when not v_secret then n.participant_id end,
                                          'note', n.note) order by n.recorded_at, n.id)
      from committee.vote_note n where n.vote_item_id = v_item.id), '[]'::jsonb) end);
end;
$$;

-- =============================================================================
-- 10. Grants and the catalogue
-- =============================================================================
-- The replaced functions keep their owners, grants and comments.
revoke all on function
  committee.protect_offline_ballot(), committee.offline_ballot_blocks(uuid), exchange.bcp_ballot_target_ok(uuid, text, uuid),
  exchange.bcp_record_offline_ballot(exchange.bcp_import_batch, exchange.bcp_import_row, uuid),
  committee.bind_offline_ballots(), committee.settle_offline_ballot(), committee.lapse_offline_ballots(),
  committee.offline_roster_attended(uuid, uuid)
from public, anon, authenticated;

revoke all on function
  authz.can_view_offline_ballot(uuid), authz.can_view_bcp_ballot_rows(uuid), api.confirm_offline_ballot(uuid, text)
from public;
grant execute on function
  authz.can_view_offline_ballot(uuid), authz.can_view_bcp_ballot_rows(uuid), api.confirm_offline_ballot(uuid, text)
to authenticated;

update config.target_module
   set commands = commands || array['api.confirm_offline_ballot'],
       delivered_in = delivered_in || '2120'::text,
       notes = notes || ' Since 2120: a committee workbook of template BCP-C2 imports signed paper ballots, provisional '
                        'until each member confirms their own in the platform after restoration; the secretary never '
                        'writes a vote for a member (DEC-AMB-008, ADR-048).'
 where code = 'BCP_CONTINUITY';
update config.target_module
   set delivered_in = delivered_in || '2120'::text,
       notes = notes || ' Since 2120: a meeting held offline takes its votes only from its members'' own confirmations '
                        'of their paper ballots, its members are present only as the attested roster shows, and no vote '
                        'item closes while a counting member''s ballot waits (ADR-048).'
 where code = 'MEETING';
