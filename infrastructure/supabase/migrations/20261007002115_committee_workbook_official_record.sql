-- =============================================================================
-- 2115 Committee workbook official record and member attestation (Rebase; CDF-254; ADR-061)
-- Requirements: §12, §19, §22, §24–§27, §29, §39, §45, §82, §83, §87; ADR-034, ADR-047; DEC-F03 (as built in 2030);
-- owner decision on AMB-201 of 2026-10-17 ("Committee-Proceeding Workbook Import Approval + Dual Institutional
-- Record and Platform Attestation Model"); coordinator rulings of 2026-10-17 19:13 UTC; AGENT-09 R1 to R8 and its
-- conditions on E5, E6 and E7 (adopted as requirements 19:23 UTC).
--
-- A committee workbook (2110, BCP-C1) becomes authoritative only on two linked records, neither standing in for the
-- other (owner decision §1, §16):
--   Layer 1. The final signed CDF minutes of the one meeting the workbook reconstructs, uploaded by the secretary as
--            an immutable, versioned document (registered with its declared SHA-256, stored through the evidence
--            storage port, scanned, then marked as the signed official record).
--   Layer 2. In the platform, the chair's own approval (or a deputy chair's, only while formally activated as acting
--            chair for this record) and each attending eligible member's own attestation, on the current revision.
-- Reconciliation (signatories, attendance, conflict scope, document version) must be clean; then READY_TO_COMMIT,
-- then the importer commits through 2110's apply path. Nothing here writes meeting attendance (F3), creates a vote
-- (owner decision §6; votes are 2120) or widens anyone's access: every check uses the proceeding's existing seats and
-- case gate, and uploading the signed minutes grants nothing (§10).
--
-- Sections:
--   1. Tables: record, roster, document versions, decisions, attestations, acting-chair activations.
--   2. Helpers: eligibility, conflict subjects, approver capacity, line states, discrepancies, readiness, locking.
--   3. Who sees what (§10, R4, R5, R8).
--   4. Layer 1 commands: open, declare the roster, register, complete and mark the signed minutes, read the file.
--   5. Layer 2 commands: submit to the chair, acting chair, chair decision, return for correction, attestation.
--   6. Commit (api.apply_bcp_import's committee branch) and cancellation.
--   7. Notices, grants and the catalogue.
-- SOURCE_REQUIRED (ruled defaults, fail closed): expected signatories = the line that signed as chair and every member
-- line declared attending (a secretary seat is the administrative capacity of §7: it neither signs as a member nor
-- attests); accepted signature method = wet-ink signed and scanned (PDF or image); the CDF minutes template
-- is recorded as a reference; "signature visible" is the secretary's declaration, confirmed by the chair's approval
-- and each member's attestation (the platform cannot read ink); no maximum period for an acting chair is invented.
-- PRODUCTION_SUBSTITUTION_REQUIRED (R7): the SHA-256 and the malware scan are computed by the BFF before completion, as
-- for evidence (0900, 2050); production replaces them with the CDF storage pipeline (OSS with WORM retention, KMS,
-- approved scanning).
-- =============================================================================

-- =============================================================================
-- 1. Tables
-- =============================================================================

-- One record per committee workbook. revision counts returns for correction: a decision or attestation counts only
-- on the revision it was given for.
create table exchange.bcp_committee_record (
  id                      uuid primary key default gen_random_uuid(),
  batch_id                uuid not null unique references exchange.bcp_import_batch (id),
  committee_proceeding_id uuid not null references committee.committee_proceeding (id),
  case_id                 uuid not null references case_mgmt.case_record (id),
  status                  text not null default 'DRAFT' check (status in (
                            'DRAFT', 'PENDING_CHAIR_APPROVAL', 'PLATFORM_ATTESTATION_IN_PROGRESS', 'FULLY_ATTESTED',
                            'READY_TO_COMMIT', 'COMMITTED', 'RETURNED', 'REJECTED', 'CANCELLED')),
  revision                int not null default 1 check (revision >= 1),
  signed_document_id      uuid,
  meeting_row_id          uuid references exchange.bcp_import_row (id),
  meeting_id              uuid references committee.meeting (id),
  opened_by               uuid not null references iam.user_profile (id),
  opened_at               timestamptz not null default now(),
  submitted_at            timestamptz,
  ready_at                timestamptz,
  committed_at            timestamptz,
  closed_at               timestamptz,
  updated_at              timestamptz not null default now(),
  check ((status = 'COMMITTED') = (committed_at is not null)),
  check (status <> 'COMMITTED' or meeting_id is not null),
  check ((status in ('REJECTED', 'CANCELLED')) = (closed_at is not null)),
  check (status in ('DRAFT', 'CANCELLED') or (submitted_at is not null and meeting_row_id is not null
                                              and signed_document_id is not null))
);
create index bcp_committee_record_proceeding on exchange.bcp_committee_record (committee_proceeding_id);
create index bcp_committee_record_case on exchange.bcp_committee_record (case_id);
create index bcp_committee_record_opened_by on exchange.bcp_committee_record (opened_by);
create index bcp_committee_record_meeting_row on exchange.bcp_committee_record (meeting_row_id);
create index bcp_committee_record_meeting on exchange.bcp_committee_record (meeting_id);
comment on table exchange.bcp_committee_record is
  'The official record of a committee continuity workbook (owner decision on AMB-201; migration 2115, ADR-061): the '
  'signed minutes (Layer 1) and the platform approval and attestations (Layer 2) that must both exist before the '
  'workbook commits. One per committee batch, opened by its importer. Read by the importer and the eligible roster.';

-- The roster: who would sit in the meeting (committee.insert_meeting's filter, taken when the record opens), with the
-- secretary's declaration from the signed minutes. One line per proceeding member.
create table exchange.bcp_record_roster (
  id                   uuid primary key default gen_random_uuid(),
  record_id            uuid not null references exchange.bcp_committee_record (id),
  proceeding_member_id uuid not null references committee.proceeding_member (id),
  user_id              uuid not null references iam.user_profile (id),
  seat                 text not null check (seat in (
                         'CHAIR', 'DEPUTY_CHAIR', 'SECRETARY', 'ALTERNATE_SECRETARY', 'MEMBER', 'ALTERNATE_MEMBER')),
  attendance           text not null default 'NOT_DECLARED' check (attendance in (
                         'NOT_DECLARED', 'ATTENDED', 'ATTENDED_PART', 'ABSENT', 'RECUSED')),
  joined_late          boolean not null default false,
  left_early           boolean not null default false,
  signature_visible    boolean not null default false,
  signed_as_chair      boolean not null default false,
  declared_by          uuid references iam.user_profile (id),
  declared_at          timestamptz,
  unique (record_id, proceeding_member_id),
  unique (record_id, user_id),
  check ((attendance = 'ATTENDED_PART') = (joined_late or left_early)),
  check (not signed_as_chair or signature_visible),
  check ((attendance = 'NOT_DECLARED') = (declared_at is null)),
  check ((declared_at is null) = (declared_by is null))
);
create unique index bcp_record_roster_chair_signatory on exchange.bcp_record_roster (record_id) where signed_as_chair;
create index bcp_record_roster_member on exchange.bcp_record_roster (proceeding_member_id);
create index bcp_record_roster_user on exchange.bcp_record_roster (user_id);
create index bcp_record_roster_declared_by on exchange.bcp_record_roster (declared_by);
comment on table exchange.bcp_record_roster is
  'Who would sit in the reconstructed meeting and what the signed minutes show about them: attendance, whether their '
  'signature is visible, who signed as chair (migration 2115). The secretary''s declaration, confirmed by the chair''s '
  'approval and each member''s attestation. Changeable only while the record is DRAFT or RETURNED.';

-- Layer 1: the signed minutes, one row per uploaded version. Never overwritten, never deleted.
create table exchange.bcp_record_document (
  id                 uuid primary key default gen_random_uuid(),
  record_id          uuid not null references exchange.bcp_committee_record (id),
  version_no         int not null check (version_no >= 1),
  supersedes_id      uuid references exchange.bcp_record_document (id),
  document_type      text not null default 'COMMITTEE_MINUTES' check (document_type = 'COMMITTEE_MINUTES'),
  source             text not null default 'OFFICIAL_SIGNED_MINUTES' check (source = 'OFFICIAL_SIGNED_MINUTES'),
  meeting_date       date not null,
  template_reference text not null check (length(template_reference) between 2 and 100),
  classification     core.classification_level not null,
  original_file_name text not null check (length(original_file_name) between 1 and 255),
  content_type       text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/tiff')),
  size_bytes         bigint not null check (size_bytes between 1 and 26214400),
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- Random and immutable (§24-§27): committee-records/{proceeding}/{record}/{document}; it leaves the database only
  -- through the register and open commands (no column grant), as evidence keys do.
  object_key         text not null unique
                     check (object_key ~ '^committee-records(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}){3}$'),
  status             text not null default 'QUARANTINED' check (status in ('QUARANTINED', 'STORED', 'SIGNED_OFFICIAL_RECORD')),
  scanner            text check (length(scanner) between 1 and 80),
  uploaded_by        uuid not null references iam.user_profile (id),
  uploaded_at        timestamptz not null default now(),
  stored_at          timestamptz,
  signed_marked_by   uuid references iam.user_profile (id),
  signed_marked_at   timestamptz,
  unique (record_id, version_no),
  check ((status = 'QUARANTINED') = (stored_at is null)),
  check ((stored_at is null) = (scanner is null)),
  check ((status = 'SIGNED_OFFICIAL_RECORD') = (signed_marked_at is not null)),
  check ((signed_marked_at is null) = (signed_marked_by is null)),
  check ((version_no = 1) = (supersedes_id is null))
);
create index bcp_record_document_supersedes on exchange.bcp_record_document (supersedes_id);
create index bcp_record_document_uploaded_by on exchange.bcp_record_document (uploaded_by);
create index bcp_record_document_signed_marked_by on exchange.bcp_record_document (signed_marked_by);
alter table exchange.bcp_committee_record
  add constraint bcp_committee_record_signed_document_fkey
  foreign key (signed_document_id) references exchange.bcp_record_document (id);
create index bcp_committee_record_signed_document on exchange.bcp_committee_record (signed_document_id);
comment on table exchange.bcp_record_document is
  'Layer 1 (owner decision on AMB-201 §2, §3, §15; migration 2115): each uploaded version of the signed minutes, with '
  'its declared SHA-256, size, type, meeting date, template reference and classification. QUARANTINED until the BFF '
  'stores and scans the binary (R7); STORED; SIGNED_OFFICIAL_RECORD once the secretary marks it as the final signed '
  'record. Immutable apart from those steps; a correction is a new version linked to the one it supersedes.';

-- Layer 2: the chair's (or acting chair's) decision, and the secretary's return for correction.
create table exchange.bcp_record_decision (
  id                   uuid primary key default gen_random_uuid(),
  record_id            uuid not null references exchange.bcp_committee_record (id),
  revision             int not null check (revision >= 1),
  decision             text not null check (decision in ('APPROVE', 'RETURN', 'REJECT')),
  capacity             text not null check (capacity in ('CHAIR', 'ACTING_CHAIR', 'SECRETARY')),
  decided_by           uuid not null references iam.user_profile (id),
  roster_id            uuid references exchange.bcp_record_roster (id),
  acting_chair_id      uuid,
  reason               text check (length(reason) between 5 and 2000),
  decided_at           timestamptz not null default clock_timestamp(),
  check (capacity <> 'SECRETARY' or (decision = 'RETURN' and roster_id is null)),
  check (capacity = 'SECRETARY' or roster_id is not null),
  check ((capacity = 'ACTING_CHAIR') = (acting_chair_id is not null)),
  check (decision = 'APPROVE' or reason is not null)
);
create unique index bcp_record_decision_approve_once on exchange.bcp_record_decision (record_id, revision)
  where decision = 'APPROVE';
create unique index bcp_record_decision_close_once on exchange.bcp_record_decision (record_id, revision)
  where decision in ('RETURN', 'REJECT');
create index bcp_record_decision_decided_by on exchange.bcp_record_decision (decided_by);
create index bcp_record_decision_roster on exchange.bcp_record_decision (roster_id);
create index bcp_record_decision_acting on exchange.bcp_record_decision (acting_chair_id);
comment on table exchange.bcp_record_decision is
  'Layer 2 (owner decision §3, §4, §7; migration 2115): APPROVE_COMMITTEE_RECORD, return or rejection by the chair or '
  'a formally activated acting chair, on one revision; and the secretary''s return for correction. Append-only. '
  'Reasons stay here, never in the ledger.';

-- Layer 2: each member's own attestation or decline, on one revision.
create table exchange.bcp_record_attestation (
  id               uuid primary key default gen_random_uuid(),
  record_id        uuid not null references exchange.bcp_committee_record (id),
  revision         int not null check (revision >= 1),
  roster_id        uuid not null references exchange.bcp_record_roster (id),
  user_id          uuid not null references iam.user_profile (id),
  action           text not null check (action in ('ATTEST', 'DECLINE')),
  scope            text not null check (scope in ('FULL', 'PARTIAL', 'OWN_PARTICIPATION')),
  discrepancy_code text check (discrepancy_code in ('ATTENDANCE_MISMATCH', 'SIGNATURE_MISMATCH',
                                                   'MISSING_OFFICIAL_SIGNATURE', 'CONFLICT_SCOPE_MISMATCH',
                                                   'DOCUMENT_VERSION_MISMATCH')),
  reason           text check (length(reason) between 5 and 2000),
  attested_at      timestamptz not null default clock_timestamp(),
  unique (record_id, revision, roster_id),
  check ((action = 'DECLINE') = (discrepancy_code is not null)),
  check ((action = 'DECLINE') = (reason is not null))
);
create index bcp_record_attestation_roster on exchange.bcp_record_attestation (roster_id);
create index bcp_record_attestation_user on exchange.bcp_record_attestation (user_id);
comment on table exchange.bcp_record_attestation is
  'Layer 2 (owner decision §5, §7, §9; migration 2115): ATTEST_COMMITTEE_RECORD or a decline with a discrepancy, by the '
  'member themself, on one revision, with the scope they were eligible for. Never by anyone for anyone else; never '
  'deemed. Append-only.';

-- An acting chair for one record (owner decision §4; DEC-F03 rule as built in 2030: the secretary activates).
create table exchange.bcp_record_acting_chair (
  id               uuid primary key default gen_random_uuid(),
  record_id        uuid not null references exchange.bcp_committee_record (id),
  deputy_roster_id uuid not null references exchange.bcp_record_roster (id),
  deputy_user_id   uuid not null references iam.user_profile (id),
  chair_roster_id  uuid references exchange.bcp_record_roster (id),
  basis            text not null check (basis in ('ABSENT', 'UNAVAILABLE', 'CONFLICTED', 'INELIGIBLE', 'VACANT')),
  reason           text not null check (length(reason) between 10 and 2000),
  effective_from   timestamptz not null default now(),
  effective_to     timestamptz not null,
  activated_by     uuid not null references iam.user_profile (id),
  activated_at     timestamptz not null default clock_timestamp(),
  ended_by         uuid references iam.user_profile (id),
  ended_at         timestamptz,
  end_reason       text check (length(end_reason) between 5 and 2000),
  check (effective_to > effective_from),
  check (activated_by <> deputy_user_id),
  check ((basis = 'VACANT') = (chair_roster_id is null)),
  check ((ended_at is null) = (ended_by is null)),
  check ((ended_at is null) = (end_reason is null))
);
create index bcp_record_acting_chair_record on exchange.bcp_record_acting_chair (record_id);
create index bcp_record_acting_chair_deputy on exchange.bcp_record_acting_chair (deputy_roster_id);
create index bcp_record_acting_chair_deputy_user on exchange.bcp_record_acting_chair (deputy_user_id);
create index bcp_record_acting_chair_chair on exchange.bcp_record_acting_chair (chair_roster_id);
create index bcp_record_acting_chair_activated_by on exchange.bcp_record_acting_chair (activated_by);
create index bcp_record_acting_chair_ended_by on exchange.bcp_record_acting_chair (ended_by);
alter table exchange.bcp_record_decision
  add constraint bcp_record_decision_acting_chair_fkey
  foreign key (acting_chair_id) references exchange.bcp_record_acting_chair (id);
comment on table exchange.bcp_record_acting_chair is
  'The deputy chair activated as acting chair for one committee record, with basis, reason and effective period '
  '(owner decision §4; migration 2115). Never a standing right: one record, one period, ended early by the chair or '
  'the secretary. The reason stays here, never in the ledger.';

-- Integrity. The record and roster change only through their commands (row-level checks below); the document changes
-- only by its two forward steps; decisions and attestations never change.
create function exchange.protect_bcp_record()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'committee record rows are never deleted' using errcode = 'insufficient_privilege';
  end if;
  if tg_table_name = 'bcp_committee_record' then
    if old.status in ('COMMITTED', 'REJECTED', 'CANCELLED')
       or (new.id, new.batch_id, new.committee_proceeding_id, new.case_id, new.opened_by, new.opened_at)
          is distinct from (old.id, old.batch_id, old.committee_proceeding_id, old.case_id, old.opened_by, old.opened_at)
       or new.revision < old.revision then
      raise exception 'committee record % is final or its identity is immutable', old.id
        using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'bcp_record_roster' then
    select r.status into v_status from exchange.bcp_committee_record r where r.id = old.record_id;
    if v_status not in ('DRAFT', 'RETURNED')
       or (new.id, new.record_id, new.proceeding_member_id, new.user_id, new.seat)
          is distinct from (old.id, old.record_id, old.proceeding_member_id, old.user_id, old.seat) then
      raise exception 'roster line % is fixed', old.id using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'bcp_record_document' then
    if (to_jsonb(new) - array['status', 'scanner', 'stored_at', 'signed_marked_by', 'signed_marked_at'])
         <> (to_jsonb(old) - array['status', 'scanner', 'stored_at', 'signed_marked_by', 'signed_marked_at'])
       or not ((old.status = 'QUARANTINED' and new.status = 'STORED'
                and old.signed_marked_at is null and new.signed_marked_at is null)
               or (old.status = 'STORED' and new.status = 'SIGNED_OFFICIAL_RECORD'
                   and (new.scanner, new.stored_at) is not distinct from (old.scanner, old.stored_at))) then
      raise exception 'signed minutes version % is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
  else
    raise exception 'committee record evidence is append-only' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['exchange.bcp_committee_record', 'exchange.bcp_record_roster', 'exchange.bcp_record_document',
                           'exchange.bcp_record_decision', 'exchange.bcp_record_attestation'] loop
    execute format('create trigger protect before update or delete on %s for each row execute function exchange.protect_bcp_record()', t);
    execute format('create trigger protect_truncate before truncate on %s for each statement execute function exchange.protect_bcp_record()', t);
  end loop;
end;
$$;

-- An activation changes once: when it is ended early.
create function exchange.protect_bcp_record_acting_chair()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') or old.ended_at is not null
     or (to_jsonb(new) - array['ended_by', 'ended_at', 'end_reason'])
        <> (to_jsonb(old) - array['ended_by', 'ended_at', 'end_reason']) then
    raise exception 'acting chair activation is fixed' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger protect before update or delete on exchange.bcp_record_acting_chair
  for each row execute function exchange.protect_bcp_record_acting_chair();
create trigger protect_truncate before truncate on exchange.bcp_record_acting_chair
  for each statement execute function exchange.protect_bcp_record_acting_chair();

alter table exchange.bcp_committee_record enable row level security;
alter table exchange.bcp_record_roster enable row level security;
alter table exchange.bcp_record_document enable row level security;
alter table exchange.bcp_record_decision enable row level security;
alter table exchange.bcp_record_attestation enable row level security;
alter table exchange.bcp_record_acting_chair enable row level security;

-- =============================================================================
-- 2. Helpers
-- =============================================================================

-- A roster line counts now: an active internal account, still seated on the committee, cleared for the case, and not
-- set aside at referral. Rechecked at every step and again at commit.
create function exchange.bcp_record_line_eligible(p_roster_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((
    select u.status = 'ACTIVE' and not authz.is_external_account(l.user_id)
           and not pm.firewall_restricted and not pm.case_gate_excluded
           and authz.user_committee_seat(l.user_id, cp.committee_id, now()) is not null
           and authz.user_case_gate(l.user_id, cp.case_id)
    from exchange.bcp_record_roster l
    join exchange.bcp_committee_record r on r.id = l.record_id
    join committee.committee_proceeding cp on cp.id = r.committee_proceeding_id
    join committee.proceeding_member pm on pm.id = l.proceeding_member_id
    join iam.user_profile u on u.id = l.user_id
    where l.id = p_roster_id), false);
$$;

-- The subject of a paper-noted conflict in the workbook (any resolution): R4 keeps the row from them, and here the
-- signed file too, since the minutes may record it (E6).
create function exchange.bcp_record_conflict_subject(p_record_id uuid, p_user_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from exchange.bcp_committee_record r
                 join exchange.bcp_import_row x on x.batch_id = r.batch_id
                 where r.id = p_record_id and x.sheet_code = '11_CONFLICTS' and x.subject_user_id = p_user_id);
$$;

-- The chair's line (the CHAIR seat), if any.
create function exchange.bcp_record_chair_line(p_record_id uuid)
returns exchange.bcp_record_roster
language sql stable
set search_path = ''
as $$
  select l.* from exchange.bcp_record_roster l where l.record_id = p_record_id and l.seat = 'CHAIR'
  order by l.id limit 1;
$$;

-- Why the chair cannot act, derived from the record (DEC-F03 as built: derived, never typed); null when the chair can.
-- UNAVAILABLE is never derived: it is stated, and only for a chair who attended (E5).
create function exchange.bcp_record_chair_basis(p_record_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_chair exchange.bcp_record_roster;
begin
  v_chair := exchange.bcp_record_chair_line(p_record_id);
  if v_chair.id is null then return 'VACANT'; end if;
  if not exchange.bcp_record_line_eligible(v_chair.id) then return 'INELIGIBLE'; end if;
  if v_chair.attendance = 'RECUSED' or exchange.bcp_record_conflict_subject(p_record_id, v_chair.user_id) then
    return 'CONFLICTED';
  end if;
  if v_chair.attendance = 'ABSENT' then return 'ABSENT'; end if;
  -- The chair who imported, prepared or recorded a row of this workbook (or holds an external account) never approves
  -- it (owner decision §7, 2110 exclusion): otherwise ineligible for the approval, though their line still attests.
  if exists (select 1 from exchange.bcp_committee_record r
             where r.id = p_record_id and exchange.bcp_approver_excluded(r.batch_id, v_chair.user_id)) then
    return 'INELIGIBLE';
  end if;
  return null;
end;
$$;

-- The activation in force for the record now, if any.
create function exchange.bcp_record_active_acting_chair(p_record_id uuid)
returns exchange.bcp_record_acting_chair
language sql stable
set search_path = ''
as $$
  select a.* from exchange.bcp_record_acting_chair a
  where a.record_id = p_record_id and a.ended_at is null and now() >= a.effective_from and now() < a.effective_to
  order by a.activated_at desc limit 1;
$$;

-- In what capacity a user may approve the record now: CHAIR (the chair's line, attended, eligible, not conflicted, not
-- excluded), ACTING_CHAIR (the deputy's line under an activation in force, attended, eligible, not excluded), or null.
-- Never the importer, the preparer, an offline recorder, a conflict subject or an external account
-- (exchange.bcp_approver_excluded, 2110).
create function exchange.bcp_record_approver_capacity(p_record_id uuid, p_user_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_rec exchange.bcp_committee_record;
  v_line exchange.bcp_record_roster;
  v_acting exchange.bcp_record_acting_chair;
begin
  select * into v_rec from exchange.bcp_committee_record r where r.id = p_record_id;
  if v_rec.id is null or p_user_id is null or exchange.bcp_approver_excluded(v_rec.batch_id, p_user_id) then
    return null;
  end if;
  select * into v_line from exchange.bcp_record_roster l where l.record_id = p_record_id and l.user_id = p_user_id;
  if v_line.id is null or not exchange.bcp_record_line_eligible(v_line.id)
     or v_line.attendance not in ('ATTENDED', 'ATTENDED_PART') then
    return null;
  end if;
  if v_line.seat = 'CHAIR' and exchange.bcp_record_chair_basis(p_record_id) is null
     and (exchange.bcp_record_active_acting_chair(p_record_id)).id is null then
    return 'CHAIR';
  end if;
  v_acting := exchange.bcp_record_active_acting_chair(p_record_id);
  if v_line.seat = 'DEPUTY_CHAIR' and v_acting.deputy_roster_id = v_line.id then return 'ACTING_CHAIR'; end if;
  return null;
end;
$$;

-- The approval on the current revision, if any.
create function exchange.bcp_record_approval(p_record_id uuid)
returns exchange.bcp_record_decision
language sql stable
set search_path = ''
as $$
  select d.* from exchange.bcp_record_decision d
  join exchange.bcp_committee_record r on r.id = d.record_id and r.revision = d.revision
  where d.record_id = p_record_id and d.decision = 'APPROVE';
$$;

-- A line's state (owner decision §5), derived now.
create function exchange.bcp_record_line_state(p_roster_id uuid)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_line exchange.bcp_record_roster;
  v_rec exchange.bcp_committee_record;
  v_approval exchange.bcp_record_decision;
  v_action text;
begin
  select * into v_line from exchange.bcp_record_roster l where l.id = p_roster_id;
  select * into v_rec from exchange.bcp_committee_record r where r.id = v_line.record_id;
  if not exchange.bcp_record_line_eligible(v_line.id) then return 'INELIGIBLE'; end if;
  if v_line.attendance = 'ABSENT' then return 'ABSENT'; end if;
  if v_line.attendance = 'RECUSED' then return 'RECUSED'; end if;
  -- §7: the secretary's seat is administrative, never a member capacity (no secretary seat votes, 2030), so a
  -- secretary line neither signs as a member nor attests; the system keeps the two capacities apart. The capacity is
  -- the line's seat, not its person: one person holds one seat in a proceeding (1870) and one roster line.
  if v_line.seat in ('SECRETARY', 'ALTERNATE_SECRETARY') then return 'NOT_REQUIRED'; end if;
  v_approval := exchange.bcp_record_approval(v_rec.id);
  if v_approval.roster_id = v_line.id then return 'NOT_REQUIRED'; end if;
  select a.action into v_action from exchange.bcp_record_attestation a
  where a.record_id = v_rec.id and a.revision = v_rec.revision and a.roster_id = v_line.id;
  return case v_action when 'ATTEST' then 'ATTESTED' when 'DECLINE' then 'DECLINED_WITH_REASON' else 'PENDING' end;
end;
$$;

-- The one meeting the record reconstructs: the workbook's single 09_MEETINGS row resolved IMPORT, every IMPORT
-- 11_CONFLICTS row referencing it. Null when that is not so (E1: two meetings are two workbooks).
create function exchange.bcp_record_meeting_row(p_record_id uuid)
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
                    where r.id = p_record_id and x.sheet_code = '11_CONFLICTS' and x.resolution = 'IMPORT'
                      and x.cells ->> 'MEETING_REF' is distinct from m.row_key);
$$;

-- Reconciliation (owner decision §8), derived now. p_attestations adds MISSING_PLATFORM_ATTESTATION for lines still
-- PENDING (meaningful once the chair has approved).
create function exchange.bcp_record_discrepancies(p_record_id uuid, p_attestations boolean)
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

-- Everything §12 asks before commit, checked now: the signed record stored, an approval on this revision by someone
-- who may still give it, every required line attested on this revision, no discrepancy, the workbook not revoked.
create function exchange.bcp_record_ready(p_record_id uuid)
returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  v_rec exchange.bcp_committee_record;
  v_approval exchange.bcp_record_decision;
begin
  select * into v_rec from exchange.bcp_committee_record r where r.id = p_record_id;
  if v_rec.id is null or v_rec.status not in ('PLATFORM_ATTESTATION_IN_PROGRESS', 'FULLY_ATTESTED', 'READY_TO_COMMIT')
     or v_rec.meeting_row_id is distinct from exchange.bcp_record_meeting_row(p_record_id) then
    return false;
  end if;
  v_approval := exchange.bcp_record_approval(p_record_id);
  if v_approval.id is null or not exchange.bcp_record_line_eligible(v_approval.roster_id)
     or exchange.bcp_approver_excluded(v_rec.batch_id, v_approval.decided_by) then
    return false;
  end if;
  if exists (select 1 from exchange.bcp_record_discrepancies(p_record_id, true)) then return false; end if;
  return not exists (select 1 from exchange.bcp_import_batch b
                     where b.id = v_rec.batch_id
                       and exchange.committee_workbook_revoked(b.committee_proceeding_id, b.workbook_id));
end;
$$;

-- Every record command locks the batch, then the record, before reading its revision or state (E7). p_own: the
-- importer's own step (exchange.lock_bcp_batch's checks); otherwise the caller must see the record.
create function exchange.lock_bcp_record(p_record_id uuid, p_own boolean)
returns exchange.bcp_committee_record
language plpgsql
set search_path = ''
as $$
declare
  v_rec exchange.bcp_committee_record;
  v_batch uuid;
begin
  if p_record_id is null or not authz.can_view_committee_record(p_record_id) then perform api._fail('NOT_FOUND'); end if;
  select r.batch_id into v_batch from exchange.bcp_committee_record r where r.id = p_record_id;
  if p_own then
    perform exchange.lock_bcp_batch(v_batch, true);
  else
    perform 1 from exchange.bcp_import_batch b where b.id = v_batch for update;
  end if;
  select * into v_rec from exchange.bcp_committee_record r where r.id = p_record_id for update;
  return v_rec;
end;
$$;

-- The record's audit envelope: never under the case (2110 D4), with the proceeding and the batch.
create function exchange.bcp_record_audit(p_rec exchange.bcp_committee_record)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('scope', 'COMMITTEE_PROCEEDING', 'committee_proceeding_id', p_rec.committee_proceeding_id,
                            'batch_id', p_rec.batch_id, 'record_id', p_rec.id, 'revision', p_rec.revision);
$$;

-- =============================================================================
-- 3. Who sees what (§10, R4, R5, R8)
-- =============================================================================
-- The importer while still the proceeding's committee importer, and roster members who count now. Nobody else: not
-- the case team, not BCP_IMPORT_APPROVE holders, not platform or database administrators by their role.
create function authz.can_view_committee_record(p_record_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.current_user_id() is not null and exists (
    select 1 from exchange.bcp_committee_record r
    join exchange.bcp_import_batch b on b.id = r.batch_id
    where r.id = p_record_id
      and ((b.imported_by = authz.current_user_id()
            and exchange.bcp_committee_importer(authz.current_user_id(), r.committee_proceeding_id))
           or exists (select 1 from exchange.bcp_record_roster l
                      where l.record_id = r.id and l.user_id = authz.current_user_id()
                        and exchange.bcp_record_line_eligible(l.id))));
$$;

-- The importer and the lines that may chair (the chair and the deputy chair) see the whole roster, the decisions,
-- every line's attestation state and the activations; a member sees their own line and their own attestations.
create function authz.committee_record_overseer(p_record_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_committee_record(p_record_id) and exists (
    select 1 from exchange.bcp_committee_record r
    join exchange.bcp_import_batch b on b.id = r.batch_id
    where r.id = p_record_id
      and (b.imported_by = authz.current_user_id()
           or exists (select 1 from exchange.bcp_record_roster l
                      where l.record_id = r.id and l.user_id = authz.current_user_id()
                        and l.seat in ('CHAIR', 'DEPUTY_CHAIR'))));
$$;

-- The signed file and its metadata: everyone who sees the record, except the subject of a paper-noted conflict (E6;
-- they are not told why).
create function authz.can_view_committee_record_document(p_record_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_committee_record(p_record_id)
         and not exchange.bcp_record_conflict_subject(p_record_id, authz.current_user_id());
$$;

create policy bcp_committee_record_read on exchange.bcp_committee_record for select to authenticated
  using (authz.can_view_committee_record(id));
create policy bcp_record_roster_read on exchange.bcp_record_roster for select to authenticated
  using (authz.committee_record_overseer(record_id)
         or (user_id = authz.current_user_id() and authz.can_view_committee_record(record_id)));
create policy bcp_record_document_read on exchange.bcp_record_document for select to authenticated
  using (authz.can_view_committee_record_document(record_id));
create policy bcp_record_decision_read on exchange.bcp_record_decision for select to authenticated
  using (authz.committee_record_overseer(record_id));
create policy bcp_record_attestation_read on exchange.bcp_record_attestation for select to authenticated
  using (authz.committee_record_overseer(record_id)
         or (user_id = authz.current_user_id() and authz.can_view_committee_record(record_id)));
create policy bcp_record_acting_chair_read on exchange.bcp_record_acting_chair for select to authenticated
  using (authz.committee_record_overseer(record_id));
grant select on exchange.bcp_committee_record, exchange.bcp_record_roster, exchange.bcp_record_decision,
  exchange.bcp_record_attestation, exchange.bcp_record_acting_chair to authenticated;
-- Every column but the object key (as evidence.evidence_version).
grant select (id, record_id, version_no, supersedes_id, document_type, source, meeting_date, template_reference,
              classification, original_file_name, content_type, size_bytes, sha256, status, scanner, uploaded_by,
              uploaded_at, stored_at, signed_marked_by, signed_marked_at)
  on exchange.bcp_record_document to authenticated;

-- Replaces 2110: a submitted committee batch is also seen (rows other than about themselves, R4) by whoever may approve
-- its record now, so the chair compares the workbook with the signed minutes (§13). Nobody else changes.
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
                     and exists (select 1 from exchange.bcp_committee_record r
                                 where r.batch_id = b.id
                                   and exchange.bcp_record_approver_capacity(r.id, authz.current_user_id()) is not null))
          end
  );
$$;

-- =============================================================================
-- 4. Layer 1: the record, the roster and the signed minutes
-- =============================================================================

-- The importer opens the record of a staged committee workbook; the roster is the proceeding's members who would sit
-- in a meeting scheduled now (committee.insert_meeting's filter). One meeting per record (E1), checked here and again
-- at submission (a row's resolution can still change while the workbook is STAGED).
create function api.open_committee_record(p_batch_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_b exchange.bcp_import_batch;
  v_rec exchange.bcp_committee_record;
  v_cp committee.committee_proceeding;
  v_lines int;
begin
  v_b := exchange.lock_bcp_batch(p_batch_id, true);
  if v_b.scope <> 'COMMITTEE_PROCEEDING' then perform api._fail('CONFLICT', 'NOT_COMMITTEE_WORKBOOK'); end if;
  if v_b.status <> 'STAGED' then perform api._fail('CONFLICT', 'NOT_STAGED'); end if;
  if exists (select 1 from exchange.bcp_committee_record r where r.batch_id = v_b.id) then
    perform api._fail('CONFLICT', 'ALREADY_OPEN');
  end if;
  select * into v_cp from committee.committee_proceeding cp where cp.id = v_b.committee_proceeding_id;
  insert into exchange.bcp_committee_record (batch_id, committee_proceeding_id, case_id, opened_by)
  values (v_b.id, v_cp.id, v_cp.case_id, v_actor)
  returning * into v_rec;
  if exchange.bcp_record_meeting_row(v_rec.id) is null then perform api._fail('CONFLICT', 'ONE_MEETING_PER_RECORD'); end if;
  insert into exchange.bcp_record_roster (record_id, proceeding_member_id, user_id, seat)
  select v_rec.id, pm.id, pm.user_id, pm.seat
  from committee.proceeding_member pm
  join iam.user_profile u on u.id = pm.user_id and u.status = 'ACTIVE'
  where pm.committee_proceeding_id = v_cp.id and not pm.firewall_restricted and not pm.case_gate_excluded
    and authz.user_committee_seat(pm.user_id, v_cp.committee_id, now()) is not null
    and authz.user_case_gate(pm.user_id, v_cp.case_id);
  get diagnostics v_lines = row_count;
  perform audit.record_event('COMMITTEE_RECORD_OPENED', 'BUSINESS', 'SUCCESS', null, 'bcp_committee_record',
    v_rec.id::text, null, exchange.bcp_record_audit(v_rec) || jsonb_build_object('roster_lines', v_lines));
  return v_rec.id;
end;
$$;

-- The secretary's declaration from the signed minutes, every line at once: attendance, joined late / left early, a
-- visible signature, and who signed as chair. DRAFT or RETURNED only.
create function api.declare_committee_record_roster(p_record_id uuid, p_lines jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_rec exchange.bcp_committee_record;
  v_line jsonb;
  v_id uuid;
  v_attendance text;
  v_n int := 0;
begin
  v_rec := exchange.lock_bcp_record(p_record_id, true);
  if v_rec.status not in ('DRAFT', 'RETURNED') then perform api._fail('CONFLICT', 'RECORD_NOT_EDITABLE'); end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then perform api._fail('INVALID', 'lines'); end if;
  if jsonb_array_length(p_lines) <> (select count(*) from exchange.bcp_record_roster l where l.record_id = v_rec.id)
     or (select count(distinct x ->> 'roster_id') from jsonb_array_elements(p_lines) x) <> jsonb_array_length(p_lines) then
    perform api._fail('INVALID', 'lines');
  end if;
  if (select count(*) from jsonb_array_elements(p_lines) x where (x ->> 'signed_as_chair')::boolean) > 1 then
    perform api._fail('INVALID', 'signed_as_chair');
  end if;
  -- Cleared first, so the one-signatory index never sees two at once.
  update exchange.bcp_record_roster set signed_as_chair = false where record_id = v_rec.id and signed_as_chair;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    if not exchange.bcp_is_uuid(v_line ->> 'roster_id') then perform api._fail('INVALID', 'roster_id'); end if;
    v_id := (v_line ->> 'roster_id')::uuid;
    -- Only the chair's or the deputy chair's seat line signs as chair: never a secretary or a member seat.
    if jsonb_typeof(v_line -> 'signed_as_chair') = 'boolean' and (v_line ->> 'signed_as_chair')::boolean
       and not exists (select 1 from exchange.bcp_record_roster l
                       where l.id = v_id and l.record_id = v_rec.id and l.seat in ('CHAIR', 'DEPUTY_CHAIR')) then
      perform api._fail('INVALID', 'signed_as_chair');
    end if;
    v_attendance := v_line ->> 'attendance';
    if v_attendance is null or v_attendance not in ('ATTENDED', 'ATTENDED_PART', 'ABSENT', 'RECUSED') then
      perform api._fail('INVALID', 'attendance');
    end if;
    if jsonb_typeof(v_line -> 'joined_late') is distinct from 'boolean'
       or jsonb_typeof(v_line -> 'left_early') is distinct from 'boolean'
       or jsonb_typeof(v_line -> 'signature_visible') is distinct from 'boolean'
       or jsonb_typeof(v_line -> 'signed_as_chair') is distinct from 'boolean' then
      perform api._fail('INVALID', 'line');
    end if;
    if (v_attendance = 'ATTENDED_PART') <> ((v_line ->> 'joined_late')::boolean or (v_line ->> 'left_early')::boolean)
       or ((v_line ->> 'signed_as_chair')::boolean and not (v_line ->> 'signature_visible')::boolean) then
      perform api._fail('INVALID', 'line');
    end if;
    update exchange.bcp_record_roster
       set attendance = v_attendance, joined_late = (v_line ->> 'joined_late')::boolean,
           left_early = (v_line ->> 'left_early')::boolean,
           signature_visible = (v_line ->> 'signature_visible')::boolean,
           signed_as_chair = (v_line ->> 'signed_as_chair')::boolean,
           declared_by = v_actor, declared_at = now()
     where id = v_id and record_id = v_rec.id;
    if not found then perform api._fail('INVALID', 'roster_id'); end if;
    v_n := v_n + 1;
  end loop;
  update exchange.bcp_committee_record set updated_at = now() where id = v_rec.id;
  perform audit.record_event('COMMITTEE_RECORD_ROSTER_DECLARED', 'BUSINESS', 'SUCCESS', null, 'bcp_committee_record',
    v_rec.id::text, null,
    exchange.bcp_record_audit(v_rec)
    || jsonb_build_object('lines', v_n,
                          'attended', (select count(*) from exchange.bcp_record_roster l
                                       where l.record_id = v_rec.id and l.attendance in ('ATTENDED', 'ATTENDED_PART')),
                          'signatures_visible', (select count(*) from exchange.bcp_record_roster l
                                                 where l.record_id = v_rec.id and l.signature_visible)));
end;
$$;

-- Layer 1, step 1: the importer registers a version of the signed minutes with its declared facts. The object key is
-- produced here, never by input; the binary follows through the BFF (R7).
create function api.register_committee_record_document(
  p_record_id uuid, p_original_file_name text, p_content_type text, p_size_bytes bigint, p_sha256 text,
  p_meeting_date date, p_template_reference text, p_classification core.classification_level
)
returns table (o_document_id uuid, o_version_no int, o_object_key text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_rec exchange.bcp_committee_record;
  v_file text;
  v_id uuid := gen_random_uuid();
  v_version int;
  v_prior uuid;
  v_key text;
begin
  v_rec := exchange.lock_bcp_record(p_record_id, true);
  if v_rec.status not in ('DRAFT', 'RETURNED') then perform api._fail('CONFLICT', 'RECORD_NOT_EDITABLE'); end if;
  v_file := api._require_text(p_original_file_name, 'file_name', 1, 255);
  if v_file ~ '[/\\]' or v_file ~ '[[:cntrl:]]' or v_file ~ '^\.+$' then perform api._fail('INVALID', 'file_name'); end if;
  -- Wet-ink signed and scanned (ruled default, SOURCE_REQUIRED): PDF or image; never an editable document.
  if p_content_type is null or p_content_type not in ('application/pdf', 'image/png', 'image/jpeg', 'image/tiff') then
    perform api._fail('INVALID', 'content_type');
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 26214400 then perform api._fail('INVALID', 'size_bytes'); end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then perform api._fail('INVALID', 'sha256'); end if;
  if p_meeting_date is null or p_meeting_date > (now() at time zone 'Asia/Riyadh')::date then
    perform api._fail('INVALID', 'meeting_date');
  end if;
  if p_classification is null then perform api._fail('INVALID', 'classification'); end if;
  select coalesce(max(d.version_no), 0) + 1, (array_agg(d.id order by d.version_no desc))[1]
    into v_version, v_prior
  from exchange.bcp_record_document d where d.record_id = v_rec.id;
  v_key := 'committee-records/' || v_rec.committee_proceeding_id || '/' || v_rec.id || '/' || v_id;
  insert into exchange.bcp_record_document (id, record_id, version_no, supersedes_id, meeting_date, template_reference,
                                            classification, original_file_name, content_type, size_bytes, sha256,
                                            object_key, uploaded_by)
  values (v_id, v_rec.id, v_version, v_prior, p_meeting_date,
          api._require_text(p_template_reference, 'template_reference', 2, 100), p_classification, v_file,
          p_content_type, p_size_bytes, p_sha256, v_key, v_actor);
  perform audit.record_event('OFFICIAL_MINUTES_REGISTERED', 'BUSINESS', 'SUCCESS', null, 'bcp_record_document',
    v_id::text, null,
    exchange.bcp_record_audit(v_rec) || jsonb_build_object('version_no', v_version, 'sha256', p_sha256,
                                                          'size_bytes', p_size_bytes, 'content_type', p_content_type));
  o_document_id := v_id; o_version_no := v_version; o_object_key := v_key;
  return next;
end;
$$;

-- Layer 1, step 2: the uploader, once the BFF stored the binary and the scan came back clean (R7,
-- PRODUCTION_SUBSTITUTION_REQUIRED). Only while the record is DRAFT or RETURNED, and only that version's storage
-- changes: no revision moves (R6). A version registered before submission stays QUARANTINED until a return.
create function api.complete_committee_record_document(p_document_id uuid, p_scan_status text, p_scanner text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_doc exchange.bcp_record_document;
  v_rec exchange.bcp_committee_record;
begin
  select d.* into v_doc from exchange.bcp_record_document d where d.id = p_document_id;
  if v_doc.id is null then perform api._fail('NOT_FOUND'); end if;
  v_rec := exchange.lock_bcp_record(v_doc.record_id, true);
  select d.* into v_doc from exchange.bcp_record_document d where d.id = p_document_id for update;
  if v_doc.uploaded_by <> v_actor then perform api._fail('FORBIDDEN'); end if;
  if v_rec.status not in ('DRAFT', 'RETURNED') then perform api._fail('CONFLICT', 'RECORD_NOT_EDITABLE'); end if;
  if v_doc.status <> 'QUARANTINED' then perform api._fail('CONFLICT', 'VERSION_NOT_QUARANTINED'); end if;
  if p_scan_status is distinct from 'CLEAN' then perform api._fail('INVALID', 'scan_status'); end if;
  update exchange.bcp_record_document
     set status = 'STORED', scanner = api._require_text(p_scanner, 'scanner', 1, 80), stored_at = now()
   where id = v_doc.id;
  perform audit.record_event(case when v_doc.version_no = 1 then 'OFFICIAL_MINUTES_UPLOADED'
                                  else 'OFFICIAL_MINUTES_VERSIONED' end,
    'BUSINESS', 'SUCCESS', null, 'bcp_record_document', v_doc.id::text, null,
    exchange.bcp_record_audit(v_rec)
    || jsonb_build_object('version_no', v_doc.version_no, 'supersedes_id', v_doc.supersedes_id, 'sha256', v_doc.sha256,
                          'meeting_date', v_doc.meeting_date, 'classification', v_doc.classification,
                          'source', v_doc.source, 'scanner', left(p_scanner, 80)));
end;
$$;

-- Layer 1, step 3: the importer marks the newest stored version as the final signed official record. Refused unless it
-- is stored, the roster is declared, one line signed as chair and every expected signatory is shown (test 12). Not a
-- check of ink: the declaration is confirmed by the chair and each member (ADR-061 limitation).
create function api.mark_committee_minutes_signed(p_document_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_doc exchange.bcp_record_document;
  v_rec exchange.bcp_committee_record;
begin
  select d.* into v_doc from exchange.bcp_record_document d where d.id = p_document_id;
  if v_doc.id is null then perform api._fail('NOT_FOUND'); end if;
  v_rec := exchange.lock_bcp_record(v_doc.record_id, true);
  if v_rec.status not in ('DRAFT', 'RETURNED') then perform api._fail('CONFLICT', 'RECORD_NOT_EDITABLE'); end if;
  select d.* into v_doc from exchange.bcp_record_document d where d.id = p_document_id for update;
  if v_doc.status = 'QUARANTINED' then perform api._fail('CONFLICT', 'DOCUMENT_NOT_STORED'); end if;
  if v_doc.status = 'SIGNED_OFFICIAL_RECORD' then perform api._fail('CONFLICT', 'ALREADY_SIGNED'); end if;
  if exists (select 1 from exchange.bcp_record_document d
             where d.record_id = v_rec.id and d.version_no > v_doc.version_no) then
    perform api._fail('CONFLICT', 'NOT_LATEST_VERSION');
  end if;
  if exists (select 1 from exchange.bcp_record_roster l where l.record_id = v_rec.id and l.attendance = 'NOT_DECLARED') then
    perform api._fail('CONFLICT', 'ROSTER_NOT_DECLARED');
  end if;
  if not exists (select 1 from exchange.bcp_record_roster l where l.record_id = v_rec.id and l.signed_as_chair)
     or exists (select 1 from exchange.bcp_record_roster l
                where l.record_id = v_rec.id and l.attendance in ('ATTENDED', 'ATTENDED_PART')
                  and l.seat not in ('SECRETARY', 'ALTERNATE_SECRETARY') and not l.signature_visible) then
    perform api._fail('CONFLICT', 'MISSING_OFFICIAL_SIGNATURE');
  end if;
  update exchange.bcp_record_document set status = 'SIGNED_OFFICIAL_RECORD', signed_marked_by = v_actor,
                                          signed_marked_at = now()
   where id = v_doc.id;
  update exchange.bcp_committee_record set signed_document_id = v_doc.id, updated_at = now() where id = v_rec.id;
  perform audit.record_event('OFFICIAL_MINUTES_MARKED_SIGNED', 'BUSINESS', 'SUCCESS', null, 'bcp_record_document',
    v_doc.id::text, null, exchange.bcp_record_audit(v_rec) || jsonb_build_object('version_no', v_doc.version_no,
                                                                                'sha256', v_doc.sha256));
end;
$$;

-- The BFF streams a stored version only after this check, which is audited (§10, §15; R8). Never the conflict-row
-- subject (E6), never a quarantined object.
create function api.open_committee_record_document(p_document_id uuid)
returns table (o_object_key text, o_content_type text, o_original_file_name text, o_size_bytes bigint, o_sha256 text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_doc exchange.bcp_record_document;
  v_rec exchange.bcp_committee_record;
begin
  select d.* into v_doc from exchange.bcp_record_document d where d.id = p_document_id;
  if v_doc.id is null or not authz.can_view_committee_record_document(v_doc.record_id) then
    perform api._fail('NOT_FOUND');
  end if;
  if v_doc.status = 'QUARANTINED' then perform api._fail('CONFLICT', 'DOCUMENT_NOT_STORED'); end if;
  select * into v_rec from exchange.bcp_committee_record r where r.id = v_doc.record_id;
  perform audit.record_event('OFFICIAL_MINUTES_OPENED', 'BUSINESS', 'SUCCESS', null, 'bcp_record_document',
    v_doc.id::text, null, exchange.bcp_record_audit(v_rec) || jsonb_build_object('version_no', v_doc.version_no));
  o_object_key := v_doc.object_key; o_content_type := v_doc.content_type;
  o_original_file_name := v_doc.original_file_name; o_size_bytes := v_doc.size_bytes; o_sha256 := v_doc.sha256;
  return next;
end;
$$;

-- =============================================================================
-- 5. Layer 2: submission, acting chair, the chair's decision, return, attestation
-- =============================================================================

-- Whoever may approve now, for notices: the chair when the chair can act, else the deputy under an activation in force.
create function exchange.bcp_record_approver_user(p_record_id uuid)
returns uuid
language sql stable
set search_path = ''
as $$
  select l.user_id from exchange.bcp_record_roster l
  where l.record_id = p_record_id
    and exchange.bcp_record_approver_capacity(p_record_id, l.user_id) is not null
  order by case l.seat when 'CHAIR' then 0 else 1 end
  limit 1;
$$;

-- Replaces 2110. A case workbook as built. A committee workbook goes to its chair only with its official record: the
-- record open, one meeting reconstructed, the roster declared and the signed minutes marked, with no discrepancy
-- (§11). A discrepancy is audited (SIGNATURE_RECONCILIATION_FAILED, codes only) and returned, nothing else changes.
create or replace function api.submit_bcp_import(p_batch_id uuid, p_preview_hash text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  b exchange.bcp_import_batch;
  v_rec exchange.bcp_committee_record;
  v_hash text;
  v_meeting uuid;
  v_codes jsonb;
begin
  b := exchange.lock_bcp_batch(p_batch_id, true);
  if b.scope <> 'CASE' then
    select * into v_rec from exchange.bcp_committee_record r where r.batch_id = b.id for update;
    if v_rec.id is null then perform api._fail('CONFLICT', 'OFFICIAL_RECORD_REQUIRED'); end if;
    if v_rec.status not in ('DRAFT', 'RETURNED') then perform api._fail('CONFLICT', 'RECORD_NOT_EDITABLE'); end if;
    if b.status not in ('STAGED', 'SUBMITTED') then perform api._fail('CONFLICT', 'NOT_STAGED'); end if;
  elsif b.status <> 'STAGED' then
    perform api._fail('CONFLICT', 'NOT_STAGED');
  end if;
  if b.status = 'STAGED' then
    if exists (select 1 from exchange.bcp_import_row r
               where r.batch_id = b.id and r.resolution is null and r.state <> 'ALREADY_IMPORTED') then
      perform api._fail('CONFLICT', 'ROWS_UNRESOLVED');
    end if;
    v_hash := exchange.bcp_batch_hash(b.id);
    if b.preview_hash is null or b.preview_hash <> v_hash or p_preview_hash is distinct from v_hash then
      perform api._fail('CONFLICT', 'PREVIEW_CHANGED');
    end if;
    if not exchange.bcp_dry_run(b.id) then perform api._fail('CONFLICT', 'DRY_RUN_FAILED'); end if;
  else
    -- A returned record goes back on the workbook as submitted.
    if p_preview_hash is distinct from b.submitted_hash or exchange.bcp_batch_hash(b.id) <> b.submitted_hash then
      perform api._fail('CONFLICT', 'PREVIEW_CHANGED');
    end if;
  end if;

  if b.scope <> 'CASE' then
    v_meeting := exchange.bcp_record_meeting_row(v_rec.id);
    if v_meeting is null then perform api._fail('CONFLICT', 'ONE_MEETING_PER_RECORD'); end if;
    if v_rec.signed_document_id is null then perform api._fail('CONFLICT', 'OFFICIAL_RECORD_REQUIRED'); end if;
    update exchange.bcp_committee_record set meeting_row_id = v_meeting where id = v_rec.id;
    select coalesce(jsonb_agg(distinct d.code order by d.code), '[]'::jsonb) into v_codes
    from exchange.bcp_record_discrepancies(v_rec.id, false) d;
    if jsonb_array_length(v_codes) > 0 then
      update exchange.bcp_committee_record set meeting_row_id = v_rec.meeting_row_id where id = v_rec.id;
      perform audit.record_event('SIGNATURE_RECONCILIATION_FAILED', 'BUSINESS', 'FAILURE', null, 'bcp_committee_record',
        v_rec.id::text, null, exchange.bcp_record_audit(v_rec) || jsonb_build_object('at', 'SUBMISSION', 'codes', v_codes));
      return 'RECONCILIATION_FAILED';
    end if;
  end if;

  if b.status = 'STAGED' then
    update exchange.bcp_import_batch
       set status = 'SUBMITTED', submitted_hash = v_hash, submitted_at = now(), preview_clean = true, updated_at = now(),
           row_version = row_version + 1
     where id = b.id;
    perform audit.record_event('BCP_IMPORT_SUBMITTED', 'BUSINESS', 'SUCCESS', exchange.bcp_audit_case(b),
      'bcp_import_batch', b.id::text, null,
      jsonb_build_object('preview_hash', v_hash,
                         'to_import', (select count(*) from exchange.bcp_import_row r
                                       where r.batch_id = b.id and r.resolution = 'IMPORT'),
                         'skipped', (select count(*) from exchange.bcp_import_row r
                                     where r.batch_id = b.id and r.resolution = 'SKIP'),
                         'kept', (select count(*) from exchange.bcp_import_row r
                                  where r.batch_id = b.id and r.resolution = 'KEEP_PLATFORM'))
      || exchange.bcp_audit_scope(b));
  end if;
  if b.scope <> 'CASE' then
    update exchange.bcp_committee_record
       set status = 'PENDING_CHAIR_APPROVAL', submitted_at = coalesce(submitted_at, now()), updated_at = now()
     where id = v_rec.id
    returning * into v_rec;
    perform audit.record_event('COMMITTEE_RECORD_SUBMITTED', 'BUSINESS', 'SUCCESS', null, 'bcp_committee_record',
      v_rec.id::text, null, exchange.bcp_record_audit(v_rec)
                            || jsonb_build_object('signed_document_id', v_rec.signed_document_id));
    perform notify.enqueue('COMMITTEE_RECORD_APPROVAL_REQUESTED', exchange.bcp_record_approver_user(v_rec.id), b.id,
                           null, 'bcp-record-approval:' || v_rec.id || ':' || v_rec.revision);
  end if;
  return 'SUBMITTED';
end;
$$;

-- An acting chair for this record (owner decision §4), activated by the importer under the DEC-F03 rule as built
-- (Fady's card on who activates is open; this is the ruled default). The basis is derived when the record shows one;
-- UNAVAILABLE is stated, and only for a chair who attended (E5). The deputy chair's line, attended, eligible, never
-- excluded; never the activator. One in force at a time; before any approval on this revision.
create function api.activate_record_acting_chair(p_record_id uuid, p_basis text, p_reason text,
                                                 p_effective_to timestamptz)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_rec exchange.bcp_committee_record;
  v_chair exchange.bcp_record_roster;
  v_deputy exchange.bcp_record_roster;
  v_derived text;
  v_reason text;
  v_id uuid;
begin
  v_rec := exchange.lock_bcp_record(p_record_id, true);
  if v_rec.status not in ('DRAFT', 'RETURNED', 'PENDING_CHAIR_APPROVAL') then
    perform api._fail('CONFLICT', 'RECORD_NOT_EDITABLE');
  end if;
  if (exchange.bcp_record_approval(v_rec.id)).id is not null then perform api._fail('CONFLICT', 'ALREADY_APPROVED'); end if;
  if (exchange.bcp_record_active_acting_chair(v_rec.id)).id is not null then
    perform api._fail('CONFLICT', 'ALREADY_ACTIVATED');
  end if;
  if p_basis is null or p_basis not in ('ABSENT', 'UNAVAILABLE', 'CONFLICTED', 'INELIGIBLE', 'VACANT') then
    perform api._fail('INVALID', 'basis');
  end if;
  v_chair := exchange.bcp_record_chair_line(v_rec.id);
  v_derived := exchange.bcp_record_chair_basis(v_rec.id);
  if v_derived is not null and p_basis <> v_derived then perform api._fail('CONFLICT', 'BASIS_NOT_SHOWN'); end if;
  if v_derived is null and (p_basis <> 'UNAVAILABLE' or v_chair.attendance not in ('ATTENDED', 'ATTENDED_PART')) then
    perform api._fail('CONFLICT', 'CHAIR_AVAILABLE');
  end if;
  select * into v_deputy from exchange.bcp_record_roster l
  where l.record_id = v_rec.id and l.seat = 'DEPUTY_CHAIR' and l.attendance in ('ATTENDED', 'ATTENDED_PART')
    and exchange.bcp_record_line_eligible(l.id) and not exchange.bcp_approver_excluded(v_rec.batch_id, l.user_id)
  order by l.id limit 1;
  if v_deputy.id is null then perform api._fail('CONFLICT', 'NO_ELIGIBLE_DEPUTY'); end if;
  if v_deputy.user_id = v_actor then perform api._fail('FORBIDDEN'); end if;
  if p_effective_to is null or p_effective_to <= now() then perform api._fail('INVALID', 'effective_to'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  insert into exchange.bcp_record_acting_chair (record_id, deputy_roster_id, deputy_user_id, chair_roster_id, basis,
                                                reason, effective_to, activated_by)
  values (v_rec.id, v_deputy.id, v_deputy.user_id, v_chair.id, p_basis, v_reason, p_effective_to, v_actor)
  returning id into v_id;
  -- The reason stays in the activation row; the ledger gets ids, the basis code and the period.
  perform audit.record_event('RECORD_ACTING_CHAIR_ACTIVATED', 'BUSINESS', 'SUCCESS', null, 'bcp_record_acting_chair',
    v_id::text, null,
    exchange.bcp_record_audit(v_rec) || jsonb_build_object('basis', p_basis, 'deputy_roster_id', v_deputy.id,
                                                          'chair_roster_id', v_chair.id, 'effective_to', p_effective_to));
  perform notify.enqueue('COMMITTEE_RECORD_ACTING_CHAIR_ACTIVATED', v_chair.user_id, v_rec.batch_id, null,
                         'bcp-record-acting:' || v_id);
  if v_rec.status = 'PENDING_CHAIR_APPROVAL' then
    perform notify.enqueue('COMMITTEE_RECORD_APPROVAL_REQUESTED', v_deputy.user_id, v_rec.batch_id, null,
                           'bcp-record-approval:' || v_rec.id || ':' || v_rec.revision || ':' || v_id);
  end if;
  return v_id;
end;
$$;

-- Ended early by the chair it replaces or by the importer, while no approval exists on this revision.
create function api.end_record_acting_chair(p_activation_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_a exchange.bcp_record_acting_chair;
  v_rec exchange.bcp_committee_record;
  v_importer boolean;
begin
  select a.* into v_a from exchange.bcp_record_acting_chair a where a.id = p_activation_id;
  if v_a.id is null or not authz.committee_record_overseer(v_a.record_id) then perform api._fail('NOT_FOUND'); end if;
  v_rec := exchange.lock_bcp_record(v_a.record_id, false);
  select a.* into v_a from exchange.bcp_record_acting_chair a where a.id = p_activation_id for update;
  select b.imported_by = v_actor and exchange.bcp_committee_importer(v_actor, v_rec.committee_proceeding_id)
    into v_importer from exchange.bcp_import_batch b where b.id = v_rec.batch_id;
  if not v_importer and not exists (select 1 from exchange.bcp_record_roster l
                                    where l.id = v_a.chair_roster_id and l.user_id = v_actor
                                      and exchange.bcp_record_line_eligible(l.id)) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_a.ended_at is not null or now() >= v_a.effective_to then perform api._fail('CONFLICT', 'NOT_ACTIVE'); end if;
  if (exchange.bcp_record_approval(v_rec.id)).id is not null then perform api._fail('CONFLICT', 'ALREADY_APPROVED'); end if;
  update exchange.bcp_record_acting_chair
     set ended_by = v_actor, ended_at = now(), end_reason = api._require_text(p_reason, 'reason', 5, 2000)
   where id = v_a.id;
  perform audit.record_event('RECORD_ACTING_CHAIR_ENDED', 'BUSINESS', 'SUCCESS', null, 'bcp_record_acting_chair',
    v_a.id::text, null,
    exchange.bcp_record_audit(v_rec) || jsonb_build_object('ended_as', case when v_importer then 'SECRETARY'
                                                                            else 'CHAIR' end));
end;
$$;

-- The chair's (or acting chair's) decision on the current revision (owner decision §3, §4): APPROVE opens the
-- members' attestation; RETURN sends it back for correction (a new revision); REJECT ends the record and the workbook.
create function api.decide_committee_record(p_record_id uuid, p_revision int, p_decision text, p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_rec exchange.bcp_committee_record;
  v_capacity text;
  v_line exchange.bcp_record_roster;
  v_acting exchange.bcp_record_acting_chair;
  v_reason text;
  v_status text;
  v_event text;
begin
  v_rec := exchange.lock_bcp_record(p_record_id, false);
  v_capacity := exchange.bcp_record_approver_capacity(v_rec.id, v_actor);
  if v_capacity is null then perform api._fail('FORBIDDEN'); end if;
  if v_rec.status <> 'PENDING_CHAIR_APPROVAL' then perform api._fail('CONFLICT', 'NOT_PENDING_APPROVAL'); end if;
  if p_revision is distinct from v_rec.revision then perform api._fail('CONFLICT', 'REVISION_CHANGED'); end if;
  if p_decision is null or p_decision not in ('APPROVE', 'RETURN', 'REJECT') then
    perform api._fail('INVALID', 'decision');
  end if;
  if p_decision <> 'APPROVE' or p_reason is not null then
    v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  end if;
  select * into v_line from exchange.bcp_record_roster l where l.record_id = v_rec.id and l.user_id = v_actor;
  if v_capacity = 'ACTING_CHAIR' then v_acting := exchange.bcp_record_active_acting_chair(v_rec.id); end if;
  if p_decision = 'APPROVE' then
    -- Nothing may stand between the chair's approval and the members' attestation but the attestations themselves.
    if exists (select 1 from exchange.bcp_record_discrepancies(v_rec.id, false)) then
      perform api._fail('CONFLICT', 'RECONCILIATION_FAILED');
    end if;
  end if;
  insert into exchange.bcp_record_decision (record_id, revision, decision, capacity, decided_by, roster_id,
                                            acting_chair_id, reason)
  values (v_rec.id, v_rec.revision, p_decision, v_capacity, v_actor, v_line.id, v_acting.id, v_reason);
  v_status := case p_decision when 'APPROVE' then 'PLATFORM_ATTESTATION_IN_PROGRESS'
                              when 'RETURN' then 'RETURNED' else 'REJECTED' end;
  v_event := case p_decision when 'APPROVE' then 'CHAIR_APPROVED_IMPORTED_RECORD'
                             when 'RETURN' then 'CHAIR_RETURNED_IMPORTED_RECORD' else 'CHAIR_REJECTED_IMPORTED_RECORD' end;
  update exchange.bcp_committee_record
     set status = v_status,
         revision = revision + case when p_decision = 'RETURN' then 1 else 0 end,
         closed_at = case when p_decision = 'REJECT' then now() end,
         updated_at = now()
   where id = v_rec.id;
  if p_decision = 'REJECT' then
    update exchange.bcp_import_batch
       set status = 'REJECTED', decided_by = v_actor, decided_at = now(), decision_reason = v_reason, updated_at = now(),
           row_version = row_version + 1
     where id = v_rec.batch_id;
  end if;
  perform audit.record_event(v_event, 'BUSINESS', 'SUCCESS', null, 'bcp_committee_record', v_rec.id::text, null,
    exchange.bcp_record_audit(v_rec) || jsonb_build_object('capacity', v_capacity, 'acting_chair_id', v_acting.id));
  if p_decision = 'APPROVE' then
    perform notify.enqueue('COMMITTEE_RECORD_ATTESTATION_REQUESTED', l.user_id, v_rec.batch_id, null,
                           'bcp-record-attest:' || v_rec.id || ':' || v_rec.revision)
    from exchange.bcp_record_roster l
    where l.record_id = v_rec.id and exchange.bcp_record_line_state(l.id) = 'PENDING';
    perform exchange.bcp_record_settle(v_rec.id);
  else
    perform notify.enqueue('COMMITTEE_RECORD_RETURNED', b.imported_by, v_rec.batch_id, null,
                           'bcp-record-returned:' || v_rec.id || ':' || v_rec.revision)
    from exchange.bcp_import_batch b where b.id = v_rec.batch_id;
  end if;
  return v_status;
end;
$$;

-- After an approval, an attestation or a decline, once no required line is pending: a decline means the record is not
-- fully attested, so reconciliation has failed (audited, codes only) and it waits for a return; otherwise the record
-- is fully attested, and clean reconciliation makes it READY_TO_COMMIT (the batch APPROVED by the chair or acting chair
-- who approved), else the failure is audited and it waits for a return.
create function exchange.bcp_record_settle(p_record_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_rec exchange.bcp_committee_record;
  v_approval exchange.bcp_record_decision;
  v_codes jsonb;
begin
  select * into v_rec from exchange.bcp_committee_record r where r.id = p_record_id;
  if v_rec.status <> 'PLATFORM_ATTESTATION_IN_PROGRESS' then return; end if;
  if exists (select 1 from exchange.bcp_record_roster l
             where l.record_id = v_rec.id and exchange.bcp_record_line_state(l.id) = 'PENDING') then
    return;
  end if;
  if exists (select 1 from exchange.bcp_record_roster l
             where l.record_id = v_rec.id and exchange.bcp_record_line_state(l.id) = 'DECLINED_WITH_REASON') then
    select coalesce(jsonb_agg(distinct d.code order by d.code), '[]'::jsonb) into v_codes
    from exchange.bcp_record_discrepancies(v_rec.id, true) d;
    perform audit.record_event('SIGNATURE_RECONCILIATION_FAILED', 'BUSINESS', 'FAILURE', null, 'bcp_committee_record',
      v_rec.id::text, null, exchange.bcp_record_audit(v_rec) || jsonb_build_object('at', 'ATTESTATION', 'codes', v_codes));
    return;
  end if;
  update exchange.bcp_committee_record set status = 'FULLY_ATTESTED', updated_at = now() where id = v_rec.id
  returning * into v_rec;
  if exchange.bcp_record_ready(v_rec.id) then
    v_approval := exchange.bcp_record_approval(v_rec.id);
    update exchange.bcp_committee_record set status = 'READY_TO_COMMIT', ready_at = now(), updated_at = now()
     where id = v_rec.id;
    update exchange.bcp_import_batch
       set status = 'APPROVED', decided_by = v_approval.decided_by, decided_at = now(), updated_at = now(),
           row_version = row_version + 1
     where id = v_rec.batch_id;
    perform audit.record_event('WORKBOOK_READY_TO_COMMIT', 'BUSINESS', 'SUCCESS', null, 'bcp_committee_record',
      v_rec.id::text, null,
      exchange.bcp_record_audit(v_rec) || jsonb_build_object('approved_by', v_approval.decided_by,
                                                            'capacity', v_approval.capacity,
                                                            'attested', (select count(*) from exchange.bcp_record_attestation a
                                                                         where a.record_id = v_rec.id
                                                                           and a.revision = v_rec.revision)));
  else
    select coalesce(jsonb_agg(distinct d.code order by d.code), '[]'::jsonb) into v_codes
    from exchange.bcp_record_discrepancies(v_rec.id, true) d;
    perform audit.record_event('SIGNATURE_RECONCILIATION_FAILED', 'BUSINESS', 'FAILURE', null, 'bcp_committee_record',
      v_rec.id::text, null, exchange.bcp_record_audit(v_rec) || jsonb_build_object('at', 'ATTESTATION', 'codes', v_codes));
  end if;
end;
$$;

-- The importer returns the record for correction (owner decision §7) at any point before commit: a new revision; the
-- chair's approval and every attestation then count no more. A ready batch goes back to SUBMITTED.
create function api.return_committee_record(p_record_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_rec exchange.bcp_committee_record;
  v_reason text;
begin
  v_rec := exchange.lock_bcp_record(p_record_id, true);
  if v_rec.status not in ('PENDING_CHAIR_APPROVAL', 'PLATFORM_ATTESTATION_IN_PROGRESS', 'FULLY_ATTESTED',
                          'READY_TO_COMMIT') then
    perform api._fail('CONFLICT', 'NOT_RETURNABLE');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  insert into exchange.bcp_record_decision (record_id, revision, decision, capacity, decided_by, reason)
  values (v_rec.id, v_rec.revision, 'RETURN', 'SECRETARY', v_actor, v_reason);
  update exchange.bcp_committee_record
     set status = 'RETURNED', revision = revision + 1, ready_at = null, updated_at = now()
   where id = v_rec.id;
  update exchange.bcp_import_batch
     set status = 'SUBMITTED', decided_by = null, decided_at = null, decision_reason = null, updated_at = now(),
         row_version = row_version + 1
   where id = v_rec.batch_id and status = 'APPROVED';
  perform audit.record_event('COMMITTEE_RECORD_RETURNED', 'BUSINESS', 'SUCCESS', null, 'bcp_committee_record',
    v_rec.id::text, null, exchange.bcp_record_audit(v_rec) || jsonb_build_object('previous_status', v_rec.status));
end;
$$;

-- A member's own attestation or decline on the current revision (owner decision §5, §7, §9). There is no user
-- parameter: nobody attests for anyone else. A conflict-row subject attests their own participation only and may
-- decline for ATTENDANCE_MISMATCH only (E6). The chair's own attestation or decline shows the chair is available: an
-- acting-chair activation that replaced them ends with it (E5), so a later revision goes back to the chair.
create function api.attest_committee_record(p_record_id uuid, p_revision int, p_action text, p_discrepancy_code text,
                                            p_reason text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_rec exchange.bcp_committee_record;
  v_line exchange.bcp_record_roster;
  v_subject boolean;
  v_scope text;
  v_reason text;
  v_a exchange.bcp_record_acting_chair;
begin
  v_rec := exchange.lock_bcp_record(p_record_id, false);
  select * into v_line from exchange.bcp_record_roster l where l.record_id = v_rec.id and l.user_id = v_actor;
  if v_line.id is null then perform api._fail('FORBIDDEN'); end if;
  if v_rec.status <> 'PLATFORM_ATTESTATION_IN_PROGRESS' then perform api._fail('CONFLICT', 'ATTESTATION_NOT_OPEN'); end if;
  if p_revision is distinct from v_rec.revision then perform api._fail('CONFLICT', 'REVISION_CHANGED'); end if;
  if exchange.bcp_record_line_state(v_line.id) <> 'PENDING' then perform api._fail('CONFLICT', 'NOT_REQUIRED'); end if;
  if p_action is null or p_action not in ('ATTEST', 'DECLINE') then perform api._fail('INVALID', 'action'); end if;
  v_subject := exchange.bcp_record_conflict_subject(v_rec.id, v_actor);
  if p_action = 'ATTEST' then
    if p_discrepancy_code is not null or p_reason is not null then perform api._fail('INVALID', 'discrepancy_code'); end if;
  else
    if p_discrepancy_code is null
       or p_discrepancy_code not in ('ATTENDANCE_MISMATCH', 'SIGNATURE_MISMATCH', 'MISSING_OFFICIAL_SIGNATURE',
                                     'CONFLICT_SCOPE_MISMATCH', 'DOCUMENT_VERSION_MISMATCH')
       or (v_subject and p_discrepancy_code <> 'ATTENDANCE_MISMATCH') then
      perform api._fail('INVALID', 'discrepancy_code');
    end if;
    v_reason := api._require_text(p_reason, 'reason', 5, 2000);
  end if;
  v_scope := case when v_subject then 'OWN_PARTICIPATION' when v_line.attendance = 'ATTENDED_PART' then 'PARTIAL'
                  else 'FULL' end;
  insert into exchange.bcp_record_attestation (record_id, revision, roster_id, user_id, action, scope, discrepancy_code,
                                               reason)
  values (v_rec.id, v_rec.revision, v_line.id, v_actor, p_action, v_scope, p_discrepancy_code, v_reason);
  perform audit.record_event(case p_action when 'ATTEST' then 'MEMBER_ATTESTED_IMPORTED_RECORD'
                                          else 'MEMBER_DECLINED_IMPORTED_RECORD' end,
    'BUSINESS', 'SUCCESS', null, 'bcp_committee_record', v_rec.id::text, null,
    exchange.bcp_record_audit(v_rec) || jsonb_build_object('roster_id', v_line.id, 'scope', v_scope,
                                                          'discrepancy_code', p_discrepancy_code));
  if p_action = 'DECLINE' then
    perform notify.enqueue('COMMITTEE_RECORD_RETURNED', b.imported_by, v_rec.batch_id, null,
                           'bcp-record-declined:' || v_rec.id || ':' || v_rec.revision || ':' || v_line.id)
    from exchange.bcp_import_batch b where b.id = v_rec.batch_id;
  end if;
  if v_line.seat = 'CHAIR' then
    for v_a in select a.* from exchange.bcp_record_acting_chair a
               where a.record_id = v_rec.id and a.chair_roster_id = v_line.id and a.ended_at is null
                 and now() < a.effective_to
               order by a.id for update loop
      update exchange.bcp_record_acting_chair
         set ended_by = v_actor, ended_at = now(), end_reason = 'Ended by the chair''s own act on the record (E5).'
       where id = v_a.id;
      perform audit.record_event('RECORD_ACTING_CHAIR_ENDED', 'BUSINESS', 'SUCCESS', null, 'bcp_record_acting_chair',
        v_a.id::text, null, exchange.bcp_record_audit(v_rec) || jsonb_build_object('ended_as', 'CHAIR', 'by_act', p_action));
    end loop;
  end if;
  perform exchange.bcp_record_settle(v_rec.id);
  return case p_action when 'ATTEST' then 'ATTESTED' else 'DECLINED_WITH_REASON' end;
end;
$$;

-- =============================================================================
-- 6. Commit and cancellation
-- =============================================================================

-- Replaces 2110. A case workbook as built. A committee workbook commits only READY_TO_COMMIT, with every condition
-- checked again inside this transaction (§11, §12); it runs 2110's apply path (R2, R3 unchanged) and links the record
-- to the meeting it created.
create or replace function api.apply_bcp_import(p_batch_id uuid, p_hash text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  b exchange.bcp_import_batch;
  v_rec exchange.bcp_committee_record;
  v_out jsonb;
  v_counts jsonb;
  v_meeting uuid;
begin
  b := exchange.lock_bcp_batch(p_batch_id, true);
  if b.scope <> 'CASE' then
    select * into v_rec from exchange.bcp_committee_record r where r.batch_id = b.id for update;
    if v_rec.id is null or v_rec.status <> 'READY_TO_COMMIT' or not exchange.bcp_record_ready(v_rec.id) then
      perform api._fail('CONFLICT', 'RECORD_NOT_READY');
    end if;
  end if;
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
  if b.scope <> 'CASE' then
    select p.object_id into v_meeting from exchange.bcp_provenance p where p.row_id = v_rec.meeting_row_id;
    update exchange.bcp_committee_record
       set status = 'COMMITTED', meeting_id = v_meeting, committed_at = now(), updated_at = now()
     where id = v_rec.id;
    perform audit.record_event('COMMITTEE_WORKBOOK_COMMITTED', 'BUSINESS', 'SUCCESS', null, 'bcp_committee_record',
      v_rec.id::text, null,
      exchange.bcp_record_audit(v_rec)
      || jsonb_build_object('meeting_id', v_meeting, 'signed_document_id', v_rec.signed_document_id,
                            'approval_id', (exchange.bcp_record_approval(v_rec.id)).id,
                            'attestations', (select count(*) from exchange.bcp_record_attestation a
                                             where a.record_id = v_rec.id and a.revision = v_rec.revision)));
  end if;
  return v_counts;
end;
$$;

-- Replaces 2110: as built; a committee workbook's record is cancelled with it.
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
  update exchange.bcp_committee_record
     set status = 'CANCELLED', closed_at = now(), updated_at = now()
   where batch_id = b.id and status not in ('COMMITTED', 'REJECTED', 'CANCELLED');
  perform audit.record_event('BCP_IMPORT_CANCELLED', 'BUSINESS', 'SUCCESS', exchange.bcp_audit_case(b), 'bcp_import_batch',
    b.id::text, v_reason, jsonb_build_object('previous_status', b.status) || exchange.bcp_audit_scope(b));
end;
$$;

-- =============================================================================
-- 7. Notices, grants and the catalogue
-- =============================================================================
-- Ids only (§39): the deep link is the workbook's page, which re-authorizes.
insert into notify.template (code, object_type, is_mandatory, description) values
  ('COMMITTEE_RECORD_APPROVAL_REQUESTED',     'BCP_IMPORT', true,
   'A committee continuity record awaits the user''s approval as chair or acting chair (AMB-201)'),
  ('COMMITTEE_RECORD_ATTESTATION_REQUESTED',  'BCP_IMPORT', true,
   'A committee continuity record awaits the user''s own attestation (AMB-201)'),
  ('COMMITTEE_RECORD_RETURNED',               'BCP_IMPORT', true,
   'A committee continuity record the user imported was returned or declined and needs correction (AMB-201)'),
  ('COMMITTEE_RECORD_ACTING_CHAIR_ACTIVATED', 'BCP_IMPORT', true,
   'A deputy chair was activated as acting chair for a committee continuity record (AMB-201)');
insert into notify.rule (layer, template_code, channel, enabled, effective_from, reason)
select 'SYSTEM_MANDATORY', t.code, c.channel, true, '2026-01-01T00:00:00Z', 'Synthetic default: mandatory notice (ADR-025)'
from notify.template t cross join (values ('IN_APP'), ('EMAIL')) c (channel)
where t.code in ('COMMITTEE_RECORD_APPROVAL_REQUESTED', 'COMMITTEE_RECORD_ATTESTATION_REQUESTED',
                 'COMMITTEE_RECORD_RETURNED', 'COMMITTEE_RECORD_ACTING_CHAIR_ACTIVATED');

revoke all on function
  exchange.protect_bcp_record(), exchange.protect_bcp_record_acting_chair(),
  exchange.bcp_record_line_eligible(uuid), exchange.bcp_record_conflict_subject(uuid, uuid),
  exchange.bcp_record_chair_line(uuid), exchange.bcp_record_chair_basis(uuid),
  exchange.bcp_record_active_acting_chair(uuid), exchange.bcp_record_approver_capacity(uuid, uuid),
  exchange.bcp_record_approval(uuid), exchange.bcp_record_line_state(uuid), exchange.bcp_record_meeting_row(uuid),
  exchange.bcp_record_discrepancies(uuid, boolean), exchange.bcp_record_ready(uuid),
  exchange.lock_bcp_record(uuid, boolean), exchange.bcp_record_audit(exchange.bcp_committee_record),
  exchange.bcp_record_approver_user(uuid), exchange.bcp_record_settle(uuid)
from public, anon, authenticated;

revoke all on function
  authz.can_view_committee_record(uuid), authz.committee_record_overseer(uuid),
  authz.can_view_committee_record_document(uuid),
  api.open_committee_record(uuid), api.declare_committee_record_roster(uuid, jsonb),
  api.register_committee_record_document(uuid, text, text, bigint, text, date, text, core.classification_level),
  api.complete_committee_record_document(uuid, text, text), api.mark_committee_minutes_signed(uuid),
  api.open_committee_record_document(uuid), api.activate_record_acting_chair(uuid, text, text, timestamptz),
  api.end_record_acting_chair(uuid, text), api.decide_committee_record(uuid, int, text, text),
  api.return_committee_record(uuid, text), api.attest_committee_record(uuid, int, text, text, text)
from public;
grant execute on function
  authz.can_view_committee_record(uuid), authz.committee_record_overseer(uuid),
  authz.can_view_committee_record_document(uuid),
  api.open_committee_record(uuid), api.declare_committee_record_roster(uuid, jsonb),
  api.register_committee_record_document(uuid, text, text, bigint, text, date, text, core.classification_level),
  api.complete_committee_record_document(uuid, text, text), api.mark_committee_minutes_signed(uuid),
  api.open_committee_record_document(uuid), api.activate_record_acting_chair(uuid, text, text, timestamptz),
  api.end_record_acting_chair(uuid, text), api.decide_committee_record(uuid, int, text, text),
  api.return_committee_record(uuid, text), api.attest_committee_record(uuid, int, text, text, text)
to authenticated;

update config.target_module
   set commands = commands || array['api.open_committee_record', 'api.declare_committee_record_roster',
                                    'api.register_committee_record_document', 'api.complete_committee_record_document',
                                    'api.mark_committee_minutes_signed', 'api.open_committee_record_document',
                                    'api.activate_record_acting_chair', 'api.end_record_acting_chair',
                                    'api.decide_committee_record', 'api.return_committee_record',
                                    'api.attest_committee_record'],
       delivered_in = delivered_in || '2115'::text,
       notes = notes || ' Since 2115: a committee workbook commits only on its official record: the final signed minutes '
                        '(versioned, immutable, stored through the storage port) and, in the platform, the chair''s or '
                        'a formally activated acting chair''s approval and each attending eligible member''s own '
                        'attestation, reconciled before commit (owner decision on AMB-201, ADR-061).'
 where code = 'BCP_CONTINUITY';
