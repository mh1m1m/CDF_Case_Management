-- =============================================================================
-- 2090 Case structure and corrections (Rebase PR-C; CDF-196)
-- Requirements: §18–§22, §24, §29, §39, §65, §82, §83, §87; ambiguity rows AMB-003, AMB-004, AMB-008, AMB-027,
-- AMB-032, AMB-033, AMB-045, AMB-091, AMB-093 and AMB-223 (all R2); placement confirmed by the coordinator on
-- 2026-10-15 (PR-C split: 2090 case structure and corrections, ADR-045); coordinator rulings (restricted-case access
-- never grows without its authority; reasons never in audit metadata; no permission widened before 2160; the portal
-- belongs to AGENT-02 and the BFF never reads case tables, so the subject correction stays on the database side)
--
-- Every row here corrects or restructures a record without rewriting it (ADR-005): a status, a link, a successor row
-- or an annotation is added, and the original stays readable to those who could read it.
--
-- This migration adds:
--   1. AMB-003. A typed link between two cases (DUPLICATE_OF or RELATED), never a physical merge. A link grants no
--      access: it is readable only by someone who can see both cases, and a case closes as DUPLICATE only while it
--      has an active DUPLICATE_OF link (T-AMB-002).
--   2. AMB-027. An allegation is withdrawn (a status, with a reason) or split into successors that reference it, the
--      original becoming SUPERSEDED with its evidence links copied by reference on the same case. Neither happens to
--      an allegation already in a recommendation, and a split also refuses one with findings. A withdrawn or
--      superseded allegation takes no new finding, notice item, recommendation item or evidence link.
--   3. AMB-032. A subject status: IDENTIFIED (the default), UNIDENTIFIED (a placeholder), UNTRACEABLE or DECEASED,
--      each change audited. Only an IDENTIFIED subject receives a notice or a portal link, and only an IDENTIFIED
--      subject is named on a disciplinary sanction item. Findings may still be recorded (governance). An untraceable
--      subject's proceeding is suspended with the new reason SUBJECT_UNTRACEABLE.
--   4. AMB-033. A wrongly identified subject is corrected by a new subject link: in one transaction the wrong
--      person's portal links are revoked, their open notices withdrawn (open delivery tasks closed), their open
--      allegations superseded by allegations about the correct subject, and they become MISIDENTIFIED, a final
--      status. Any notice that had been issued to them is recorded as a privacy incident: ids and counts only, read
--      by security monitoring and the case team, sent nowhere outside the database. The former link holder stays
--      conflicted on the case (authz.has_conflict), so revoking the link never opens the case to them.
--   5. AMB-004. A case is split by an authorised command that creates a new case referencing the source (a
--      SPLIT_FROM link that never ends): the chosen open allegations and their subjects are re-created with
--      provenance, the source's active team is carried over (each assignment passing the assignee rule), and nothing
--      else is copied: no evidence, history, grants, notices, portal links or reporter channel. Conflicts follow the
--      split family both ways, so no one conflicted on one case of the family works another (authz.has_conflict).
--   6. AMB-008 (confirmed against 1880). 1880 kept the referral's history as events only and overwrote its content
--      in place, so each submission and resubmission is now snapshotted as a numbered version.
--   7. AMB-045. A committee membership correction is an annotation with a reason and the count of proceeding
--      snapshots that named the membership; snapshots are never edited. Overlaps stay refused by the appointment
--      command (built in 1870).
--   8. AMB-093. Approved minutes are corrected by an append-only correction reviewed by the same attending,
--      non-conflicted members; the approved version stays. AMB-091 is built (1890/2030: a revised version restarts
--      review for all reviewers and earlier versions are kept) and is pinned by a test here.
--   9. AMB-223. A record past ACTIVE (not disposed) is corrected by an appended annotation with a reason, by records
--      staff in catalogue scope; the original stays.
--
-- Additive: ten tables, one column on the allegation, one SUSPENSION_REASON code, eleven api functions and their
-- helper and trigger functions. The allegation status check gains SUPERSEDED (no value removed). One function is
-- replaced with a narrowing-only change, keeping its signature: authz.has_conflict (2080). No permission or role grant
-- changes; no catalogue code, status or option code is renamed or removed (DEC-35). Not built: copying evidence into
-- a split case (it would need a need-to-know grant per item, a widening; evidence stays on the source case), and
-- the screens and read models for these commands (Phase 12).
-- =============================================================================

-- =============================================================================
-- 1. Case links (AMB-003)
-- =============================================================================
create table case_mgmt.case_link (
  id             uuid primary key default gen_random_uuid(),
  case_id        uuid not null references case_mgmt.case_record (id),
  linked_case_id uuid not null references case_mgmt.case_record (id),
  link_type      text not null check (link_type in ('DUPLICATE_OF', 'RELATED', 'SPLIT_FROM')),
  reason         text not null check (length(reason) between 10 and 2000),
  linked_by      uuid not null references iam.user_profile (id),
  linked_at      timestamptz not null default clock_timestamp(),
  ended_by       uuid references iam.user_profile (id),
  ended_at       timestamptz,
  end_reason     text check (length(end_reason) between 10 and 2000),
  check (case_id <> linked_case_id),
  check ((ended_at is null) = (ended_by is null) and (ended_at is null) = (end_reason is null)),
  -- A split case always references its source.
  check (link_type <> 'SPLIT_FROM' or ended_at is null)
);
create unique index case_link_active on case_mgmt.case_link (case_id, linked_case_id, link_type) where ended_at is null;
-- One original per duplicate, one source per split case.
create unique index case_link_one_original on case_mgmt.case_link (case_id) where link_type = 'DUPLICATE_OF' and ended_at is null;
create unique index case_link_one_source on case_mgmt.case_link (case_id) where link_type = 'SPLIT_FROM';
create index case_link_linked_case on case_mgmt.case_link (linked_case_id);
create index case_link_linked_by on case_mgmt.case_link (linked_by);
create index case_link_ended_by on case_mgmt.case_link (ended_by);
comment on table case_mgmt.case_link is
  'A typed link between two cases (AMB-003, AMB-004; migration 2090). Never a merge: evidence, history and access stay '
  'on each case, and a link is readable only by someone who can see both. Ended, never deleted; SPLIT_FROM never ends.';

create function case_mgmt.protect_case_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.ended_at is not null or new.ended_at is null
     or (to_jsonb(new) - array['ended_by', 'ended_at', 'end_reason'])
        <> (to_jsonb(old) - array['ended_by', 'ended_at', 'end_reason']) then
    raise exception 'case link % can only be ended, once', old.id using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger case_link_protect before update on case_mgmt.case_link
  for each row execute function case_mgmt.protect_case_link();
create trigger no_delete before delete on case_mgmt.case_link
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on case_mgmt.case_link
  for each statement execute function committee.reject_mutation();

alter table case_mgmt.case_link enable row level security;
create policy case_link_read on case_mgmt.case_link for select to authenticated
  using (authz.can_view_case(case_id) and authz.can_view_case(linked_case_id));
grant select on case_mgmt.case_link to authenticated;

-- 1.1 Linking. The caller edits the case and can see the other one; anything else is NOT_FOUND, so the command cannot
-- probe for cases. SPLIT_FROM is set only by api.split_case.
create function api.link_cases(p_case_id uuid, p_linked_case_id uuid, p_link_type text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_reason text;
  v_id uuid;
begin
  perform case_mgmt.lock_editable_case(p_case_id);
  if p_linked_case_id is null or not authz.can_view_case(p_linked_case_id) then perform api._fail('NOT_FOUND'); end if;
  if p_linked_case_id = p_case_id then perform api._fail('INVALID', 'linked_case_id'); end if;
  if p_link_type is null or p_link_type not in ('DUPLICATE_OF', 'RELATED') then perform api._fail('INVALID', 'link_type'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  perform 1 from case_mgmt.case_record c where c.id = p_linked_case_id for update;
  -- One link of a type between two cases, in either direction (a duplicate never points back at its own duplicate).
  if exists (select 1 from case_mgmt.case_link l
             where l.link_type = p_link_type and l.ended_at is null
               and ((l.case_id = p_case_id and l.linked_case_id = p_linked_case_id)
                    or (l.case_id = p_linked_case_id and l.linked_case_id = p_case_id))) then
    perform api._fail('CONFLICT', 'LINK_EXISTS');
  end if;
  if p_link_type = 'DUPLICATE_OF' and exists (
    select 1 from case_mgmt.case_link l where l.case_id = p_case_id and l.link_type = 'DUPLICATE_OF' and l.ended_at is null
  ) then
    perform api._fail('CONFLICT', 'ALREADY_DUPLICATE');
  end if;
  insert into case_mgmt.case_link (case_id, linked_case_id, link_type, reason, linked_by)
  values (p_case_id, p_linked_case_id, p_link_type, v_reason, v_actor)
  returning id into v_id;
  -- The other case is named only in the link row, which needs both cases to read.
  perform audit.record_event('CASE_LINKED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_link', v_id::text, null,
    jsonb_build_object('link_type', p_link_type));
  return v_id;
end;
$$;

create function api.end_case_link(p_link_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_l case_mgmt.case_link;
  v_reason text;
begin
  select * into v_l from case_mgmt.case_link l where l.id = p_link_id;
  if v_l.id is null or not authz.can_view_case(v_l.case_id) or not authz.can_view_case(v_l.linked_case_id) then
    perform api._fail('NOT_FOUND');
  end if;
  perform case_mgmt.lock_editable_case(v_l.case_id);
  select * into v_l from case_mgmt.case_link l where l.id = p_link_id for update;
  if v_l.link_type = 'SPLIT_FROM' then perform api._fail('CONFLICT', 'LINK_NOT_ENDABLE'); end if;
  if v_l.ended_at is not null then perform api._fail('CONFLICT', 'LINK_ENDED'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  update case_mgmt.case_link set ended_by = v_actor, ended_at = now(), end_reason = v_reason where id = v_l.id;
  perform audit.record_event('CASE_LINK_ENDED', 'BUSINESS', 'SUCCESS', v_l.case_id, 'case_link', v_l.id::text, null,
    jsonb_build_object('link_type', v_l.link_type));
end;
$$;

-- 1.2 A case closes as DUPLICATE only while it is linked to its original (catalogue S052/T1-B1.5-165: "link it to
-- the original before closure"). Checked on the request and again on the closure, so ending the link in between
-- stops the approval too.
create function case_mgmt.guard_duplicate_closure()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.outcome_code = 'DUPLICATE' and not exists (
    select 1 from case_mgmt.case_link l
    where l.case_id = new.case_id and l.link_type = 'DUPLICATE_OF' and l.ended_at is null
  ) then
    perform api._fail('CONFLICT', 'DUPLICATE_LINK_REQUIRED');
  end if;
  return new;
end;
$$;
create trigger case_closure_request_duplicate_link before insert on case_mgmt.case_closure_request
  for each row execute function case_mgmt.guard_duplicate_closure();
create trigger case_closure_duplicate_link before insert on case_mgmt.case_closure
  for each row execute function case_mgmt.guard_duplicate_closure();

-- =============================================================================
-- 2. Subject status (AMB-032)
-- =============================================================================
create table case_mgmt.subject_status_event (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references case_mgmt.case_record (id),
  subject_id  uuid not null references case_mgmt.case_subject (id),
  sequence_no int not null check (sequence_no >= 1),
  status      text not null check (status in ('IDENTIFIED', 'UNIDENTIFIED', 'UNTRACEABLE', 'DECEASED', 'MISIDENTIFIED')),
  reason      text not null check (length(reason) between 10 and 2000),
  recorded_by uuid not null references iam.user_profile (id),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (subject_id, sequence_no)
);
create index subject_status_event_case on case_mgmt.subject_status_event (case_id);
create index subject_status_event_recorded_by on case_mgmt.subject_status_event (recorded_by);
comment on table case_mgmt.subject_status_event is
  'A subject''s status over time (AMB-032, AMB-033; migration 2090). The latest row is current; none means IDENTIFIED. '
  'MISIDENTIFIED is set only by api.correct_case_subject and is final. Append-only.';
create trigger no_update before update on case_mgmt.subject_status_event
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on case_mgmt.subject_status_event
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on case_mgmt.subject_status_event
  for each statement execute function committee.reject_mutation();
alter table case_mgmt.subject_status_event enable row level security;
create policy subject_status_event_read on case_mgmt.subject_status_event for select to authenticated
  using (authz.can_view_case(case_id));
grant select on case_mgmt.subject_status_event to authenticated;

-- Internal: the subject's current status.
create function case_mgmt.subject_status(p_subject_id uuid)
returns text
language sql stable
set search_path = ''
as $$
  select coalesce((select e.status from case_mgmt.subject_status_event e
                   where e.subject_id = p_subject_id order by e.sequence_no desc limit 1), 'IDENTIFIED');
$$;

create function case_mgmt.append_subject_status(
  p_case_id uuid, p_subject_id uuid, p_status text, p_reason text, p_actor uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare v_id uuid;
begin
  insert into case_mgmt.subject_status_event (case_id, subject_id, sequence_no, status, reason, recorded_by)
  values (p_case_id, p_subject_id,
          (select coalesce(max(e.sequence_no), 0) + 1 from case_mgmt.subject_status_event e where e.subject_id = p_subject_id),
          p_status, p_reason, p_actor)
  returning id into v_id;
  return v_id;
end;
$$;

-- 2.1 Recording a status. Re-identifying is the same audited change back to IDENTIFIED. A subject with an active
-- portal link is a known person, so it cannot be marked UNIDENTIFIED; a wrong person is corrected (section 4).
create function api.record_subject_status(p_subject_id uuid, p_status text, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_s case_mgmt.case_subject;
  v_current text;
  v_reason text;
  v_id uuid;
begin
  select * into v_s from case_mgmt.case_subject s where s.id = p_subject_id;
  if v_s.id is null or not authz.can_view_case(v_s.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform case_mgmt.lock_editable_case(v_s.case_id);
  if p_status is null or p_status not in ('IDENTIFIED', 'UNIDENTIFIED', 'UNTRACEABLE', 'DECEASED') then
    perform api._fail('INVALID', 'status');
  end if;
  v_current := case_mgmt.subject_status(v_s.id);
  if v_current = 'MISIDENTIFIED' then perform api._fail('CONFLICT', 'SUBJECT_MISIDENTIFIED'); end if;
  if v_current = p_status then perform api._fail('CONFLICT', 'SUBJECT_STATUS_UNCHANGED'); end if;
  if p_status = 'UNIDENTIFIED' and exists (
    select 1 from grievance.subject_portal_link l where l.subject_id = v_s.id and l.revoked_at is null
  ) then
    perform api._fail('CONFLICT', 'SUBJECT_LINKED');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  v_id := case_mgmt.append_subject_status(v_s.case_id, v_s.id, p_status, v_reason, v_actor);
  perform audit.record_event('SUBJECT_STATUS_RECORDED', 'BUSINESS', 'SUCCESS', v_s.case_id, 'case_subject', v_s.id::text,
    null, jsonb_build_object('status', p_status, 'previous_status', v_current, 'event_id', v_id));
end;
$$;

-- 2.2 What a status refuses. Notices and portal links: only an IDENTIFIED subject. Recommendation items: never a
-- MISIDENTIFIED subject, and a disciplinary sanction only for an IDENTIFIED one (DECEASED and the others refused).
create function case_mgmt.guard_subject_notifiable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if case_mgmt.subject_status(new.subject_id) <> 'IDENTIFIED' then
    perform api._fail('CONFLICT', 'SUBJECT_NOT_NOTIFIABLE');
  end if;
  return new;
end;
$$;
create trigger defence_notice_subject_status before insert on grievance.defence_notice
  for each row execute function case_mgmt.guard_subject_notifiable();
create trigger subject_portal_link_subject_status before insert on grievance.subject_portal_link
  for each row execute function case_mgmt.guard_subject_notifiable();

create function decision.guard_item_subject_status()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text := case_mgmt.subject_status(new.subject_id);
begin
  if v_status = 'MISIDENTIFIED' then perform api._fail('CONFLICT', 'SUBJECT_MISIDENTIFIED'); end if;
  if v_status <> 'IDENTIFIED' and exists (
    select 1 from decision.recommendation_item i where i.id = new.item_id and i.item_type = 'DISCIPLINARY_SANCTION'
  ) then
    perform api._fail('CONFLICT', 'SUBJECT_NOT_SANCTIONABLE');
  end if;
  return new;
end;
$$;
create trigger recommendation_item_subject_status before insert on decision.recommendation_item_subject
  for each row execute function decision.guard_item_subject_status();

-- 2.3 The suspension reason for an untraceable subject's proceeding (codes only; labels in packages/i18n).
insert into config.status_code (dimension, code, source_status) values
  ('SUSPENSION_REASON', 'SUBJECT_UNTRACEABLE', 'OWNER_DEFAULT');
insert into config.status_dimension_value (dimension, value, state, derivation, source_status) values
  ('SUSPENSION_REASON', 'SUBJECT_UNTRACEABLE', 'ACTIVE', null, 'OWNER_DEFAULT');

-- =============================================================================
-- 3. Allegation status, withdrawal and split (AMB-027)
-- =============================================================================
alter table case_mgmt.allegation drop constraint allegation_status_check;
alter table case_mgmt.allegation add constraint allegation_status_check
  check (status in ('OPEN', 'SUBSTANTIATED', 'UNSUBSTANTIATED', 'WITHDRAWN', 'SUPERSEDED'));
alter table case_mgmt.allegation
  add column supersedes_allegation_id uuid references case_mgmt.allegation (id),
  add constraint allegation_supersedes_other check (supersedes_allegation_id <> id);
create index allegation_supersedes on case_mgmt.allegation (supersedes_allegation_id);
comment on column case_mgmt.allegation.supersedes_allegation_id is
  'The allegation this one replaces (a split, a case split or a subject correction; migration 2090). The original is '
  'SUPERSEDED and stays readable.';

create table case_mgmt.allegation_status_change (
  id            uuid primary key default gen_random_uuid(),
  allegation_id uuid not null references case_mgmt.allegation (id),
  case_id       uuid not null references case_mgmt.case_record (id),
  from_status   text not null,
  to_status     text not null check (to_status in ('WITHDRAWN', 'SUPERSEDED')),
  basis         text not null check (basis in ('WITHDRAWAL', 'ALLEGATION_SPLIT', 'CASE_SPLIT', 'SUBJECT_CORRECTION')),
  reason        text not null check (length(reason) between 10 and 2000),
  changed_by    uuid not null references iam.user_profile (id),
  changed_at    timestamptz not null default clock_timestamp(),
  check ((to_status = 'WITHDRAWN') = (basis = 'WITHDRAWAL'))
);
create index allegation_status_change_allegation on case_mgmt.allegation_status_change (allegation_id);
create index allegation_status_change_case on case_mgmt.allegation_status_change (case_id);
create index allegation_status_change_changed_by on case_mgmt.allegation_status_change (changed_by);
comment on table case_mgmt.allegation_status_change is
  'Why and by whom an allegation was withdrawn or superseded (AMB-027; migration 2090). Append-only.';
create trigger no_update before update on case_mgmt.allegation_status_change
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on case_mgmt.allegation_status_change
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on case_mgmt.allegation_status_change
  for each statement execute function committee.reject_mutation();
alter table case_mgmt.allegation_status_change enable row level security;
create policy allegation_status_change_read on case_mgmt.allegation_status_change for select to authenticated
  using (authz.can_view_case(case_id));
grant select on case_mgmt.allegation_status_change to authenticated;

-- 3.1 The allegation itself: a withdrawn or superseded allegation is frozen; the content never changes; a subject is
-- set once (api.link_allegation_subject) and references may still be added while it is open. Never about a
-- MISIDENTIFIED subject.
create function case_mgmt.protect_allegation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_free constant text[] := array['status', 'subject_id', 'policy_reference', 'law_reference'];
begin
  if tg_op = 'UPDATE' then
    if old.status in ('WITHDRAWN', 'SUPERSEDED')
       or (to_jsonb(new) - v_free) <> (to_jsonb(old) - v_free)
       or (old.subject_id is not null and new.subject_id is distinct from old.subject_id) then
      raise exception 'allegation % is closed or its content is immutable', old.id using errcode = 'insufficient_privilege';
    end if;
    if new.subject_id is distinct from old.subject_id and case_mgmt.subject_status(new.subject_id) = 'MISIDENTIFIED' then
      perform api._fail('CONFLICT', 'SUBJECT_MISIDENTIFIED');
    end if;
  elsif new.subject_id is not null and case_mgmt.subject_status(new.subject_id) = 'MISIDENTIFIED' then
    perform api._fail('CONFLICT', 'SUBJECT_MISIDENTIFIED');
  end if;
  return new;
end;
$$;
create trigger allegation_protect before insert or update on case_mgmt.allegation
  for each row execute function case_mgmt.protect_allegation();

-- 3.2 Nothing new hangs off a withdrawn or superseded allegation, and no finding names a MISIDENTIFIED subject.
create function case_mgmt.guard_allegation_active()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_status text;
begin
  if v_row ->> 'allegation_id' is not null then
    select a.status into v_status from case_mgmt.allegation a where a.id = (v_row ->> 'allegation_id')::uuid;
    if v_status = 'WITHDRAWN' then perform api._fail('CONFLICT', 'ALLEGATION_WITHDRAWN'); end if;
    if v_status = 'SUPERSEDED' then perform api._fail('CONFLICT', 'ALLEGATION_SUPERSEDED'); end if;
  end if;
  if tg_table_name = 'finding' and v_row ->> 'subject_id' is not null
     and case_mgmt.subject_status((v_row ->> 'subject_id')::uuid) = 'MISIDENTIFIED' then
    perform api._fail('CONFLICT', 'SUBJECT_MISIDENTIFIED');
  end if;
  return new;
end;
$$;
create trigger finding_allegation_active before insert on case_mgmt.finding
  for each row execute function case_mgmt.guard_allegation_active();
create trigger evidence_link_allegation_active before insert on case_mgmt.evidence_link
  for each row execute function case_mgmt.guard_allegation_active();
create trigger defence_notice_item_allegation_active before insert on grievance.defence_notice_item
  for each row execute function case_mgmt.guard_allegation_active();
create trigger recommendation_item_allegation_active before insert on decision.recommendation_item_allegation
  for each row execute function case_mgmt.guard_allegation_active();

-- Internal: a successor of an allegation, on the same case or (case split) a new one. On the same case its evidence
-- links are copied by reference; across cases nothing is copied.
create function case_mgmt.successor_allegation(
  p_old case_mgmt.allegation, p_case_id uuid, p_category text, p_description text, p_subject_id uuid,
  p_policy_reference text, p_law_reference text, p_actor uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_links int := 0;
begin
  insert into case_mgmt.allegation (case_id, category, description, created_by, subject_id, policy_reference,
                                    law_reference, supersedes_allegation_id)
  values (p_case_id, p_category, p_description, p_actor, p_subject_id, p_policy_reference, p_law_reference, p_old.id)
  returning id into v_id;
  if p_case_id = p_old.case_id then
    insert into case_mgmt.evidence_link (case_id, evidence_id, allegation_id, linked_by)
    select l.case_id, l.evidence_id, v_id, p_actor from case_mgmt.evidence_link l where l.allegation_id = p_old.id;
    get diagnostics v_links = row_count;
  end if;
  perform audit.record_event('ALLEGATION_ADDED', 'BUSINESS', 'SUCCESS', p_case_id, 'allegation', v_id::text, null,
    jsonb_build_object('category', p_category, 'subject_id', p_subject_id, 'supersedes_allegation_id', p_old.id,
                       'evidence_links_copied', v_links, 'policy_reference_set', p_policy_reference is not null,
                       'law_reference_set', p_law_reference is not null));
  return v_id;
end;
$$;

create function case_mgmt.close_allegation(p_old case_mgmt.allegation, p_to text, p_basis text, p_reason text, p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update case_mgmt.allegation set status = p_to where id = p_old.id;
  insert into case_mgmt.allegation_status_change (allegation_id, case_id, from_status, to_status, basis, reason, changed_by)
  values (p_old.id, p_old.case_id, p_old.status, p_to, p_basis, p_reason, p_actor);
end;
$$;

-- Internal: why an open allegation may not be withdrawn or replaced (null when it may).
create function case_mgmt.allegation_change_block(p_allegation_id uuid, p_refuse_findings boolean)
returns text
language sql stable
set search_path = ''
as $$
  select case
    when exists (select 1 from case_mgmt.allegation a where a.id = p_allegation_id and a.status <> 'OPEN')
      then 'ALLEGATION_NOT_OPEN'
    when exists (select 1 from decision.recommendation_item_allegation r where r.allegation_id = p_allegation_id)
      then 'ALLEGATION_IN_RECOMMENDATION'
    when p_refuse_findings and exists (select 1 from case_mgmt.finding f where f.allegation_id = p_allegation_id)
      then 'ALLEGATION_HAS_FINDINGS'
  end;
$$;

-- 3.3 Withdrawal: a status with a reason, never a delete. Findings, notices and evidence stay with it.
create function api.withdraw_allegation(p_allegation_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_a case_mgmt.allegation;
  v_block text;
  v_reason text;
begin
  select * into v_a from case_mgmt.allegation a where a.id = p_allegation_id;
  if v_a.id is null or not authz.can_view_case(v_a.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform case_mgmt.lock_editable_case(v_a.case_id);
  select * into v_a from case_mgmt.allegation a where a.id = p_allegation_id for update;
  v_block := case_mgmt.allegation_change_block(v_a.id, false);
  if v_block is not null then perform api._fail('CONFLICT', v_block); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  perform case_mgmt.close_allegation(v_a, 'WITHDRAWN', 'WITHDRAWAL', v_reason, v_actor);
  perform audit.record_event('ALLEGATION_WITHDRAWN', 'BUSINESS', 'SUCCESS', v_a.case_id, 'allegation', v_a.id::text, null,
    jsonb_build_object('subject_id', v_a.subject_id));
end;
$$;

-- 3.4 Split: two to ten successors, each with its own category and description, and a subject on the case
-- (the original's when omitted); the original becomes SUPERSEDED. An allegation with findings is not split: its
-- findings would no longer match what was alleged.
create function api.split_allegation(p_allegation_id uuid, p_parts jsonb, p_reason text)
returns uuid[]
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_a case_mgmt.allegation;
  v_block text;
  v_reason text;
  v_part jsonb;
  v_category text;
  v_subject uuid;
  v_policy text;
  v_law text;
  v_ids uuid[] := '{}';
begin
  select * into v_a from case_mgmt.allegation a where a.id = p_allegation_id;
  if v_a.id is null or not authz.can_view_case(v_a.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform case_mgmt.lock_editable_case(v_a.case_id);
  select * into v_a from case_mgmt.allegation a where a.id = p_allegation_id for update;
  v_block := case_mgmt.allegation_change_block(v_a.id, true);
  if v_block is not null then perform api._fail('CONFLICT', v_block); end if;
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) not between 2 and 10 then
    perform api._fail('INVALID', 'parts');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  for v_part in select value from jsonb_array_elements(p_parts) loop
    if jsonb_typeof(v_part) <> 'object' then perform api._fail('INVALID', 'parts'); end if;
    v_category := v_part ->> 'category';
    if v_category is null or v_category !~ '^[A-Z_]{3,40}$' then perform api._fail('INVALID', 'category'); end if;
    v_subject := coalesce((v_part ->> 'subject_id')::uuid, v_a.subject_id);
    if v_subject is not null and not exists (
      select 1 from case_mgmt.case_subject s where s.id = v_subject and s.case_id = v_a.case_id
    ) then
      perform api._fail('INVALID', 'subject_id');
    end if;
    v_policy := coalesce(nullif(btrim(coalesce(v_part ->> 'policy_reference', '')), ''), v_a.policy_reference);
    v_law := coalesce(nullif(btrim(coalesce(v_part ->> 'law_reference', '')), ''), v_a.law_reference);
    if v_policy is not null and length(v_policy) not between 2 and 200 then perform api._fail('INVALID', 'policy_reference'); end if;
    if v_law is not null and length(v_law) not between 2 and 200 then perform api._fail('INVALID', 'law_reference'); end if;
    v_ids := v_ids || case_mgmt.successor_allegation(
      v_a, v_a.case_id, v_category, api._require_text(v_part ->> 'description', 'description', 10, 8000), v_subject,
      v_policy, v_law, v_actor);
  end loop;
  perform case_mgmt.close_allegation(v_a, 'SUPERSEDED', 'ALLEGATION_SPLIT', v_reason, v_actor);
  perform audit.record_event('ALLEGATION_SPLIT', 'BUSINESS', 'SUCCESS', v_a.case_id, 'allegation', v_a.id::text, null,
    jsonb_build_object('successor_ids', to_jsonb(v_ids)));
  return v_ids;
end;
$$;

-- =============================================================================
-- 4. Correcting a wrongly identified subject (AMB-033)
-- =============================================================================
create table case_mgmt.subject_correction (
  id                     uuid primary key default gen_random_uuid(),
  case_id                uuid not null references case_mgmt.case_record (id),
  wrong_subject_id       uuid not null unique references case_mgmt.case_subject (id),
  correct_subject_id     uuid not null references case_mgmt.case_subject (id),
  reason                 text not null check (length(reason) between 10 and 2000),
  links_revoked          int not null check (links_revoked >= 0),
  notices_withdrawn      int not null check (notices_withdrawn >= 0),
  allegations_superseded int not null check (allegations_superseded >= 0),
  corrected_by           uuid not null references iam.user_profile (id),
  corrected_at           timestamptz not null default clock_timestamp(),
  check (wrong_subject_id <> correct_subject_id)
);
create index subject_correction_case on case_mgmt.subject_correction (case_id);
create index subject_correction_correct_subject on case_mgmt.subject_correction (correct_subject_id);
create index subject_correction_corrected_by on case_mgmt.subject_correction (corrected_by);
comment on table case_mgmt.subject_correction is
  'A wrongly identified subject replaced by the correct one (AMB-033; migration 2090). Records are not rewritten: the '
  'wrong subject becomes MISIDENTIFIED and its open allegations are superseded. Append-only.';

-- Ids and counts only: no case content, no names, no reporter identity. It leaves the database through no channel.
create table case_mgmt.privacy_incident (
  id            uuid primary key default gen_random_uuid(),
  case_id       uuid not null references case_mgmt.case_record (id),
  correction_id uuid not null unique references case_mgmt.subject_correction (id),
  kind          text not null check (kind in ('NOTICE_TO_MISIDENTIFIED_SUBJECT')),
  notices_sent  int not null check (notices_sent >= 1),
  recorded_by   uuid not null references iam.user_profile (id),
  recorded_at   timestamptz not null default clock_timestamp()
);
create index privacy_incident_case on case_mgmt.privacy_incident (case_id);
create index privacy_incident_recorded_by on case_mgmt.privacy_incident (recorded_by);
comment on table case_mgmt.privacy_incident is
  'A notice issued to a person later found not to be the subject (AMB-033; migration 2090). Ids and counts only. '
  'PRODUCTION_SUBSTITUTION_REQUIRED: the CDF privacy incident process takes it from here. Append-only.';

do $$
declare t text;
begin
  foreach t in array array['case_mgmt.subject_correction', 'case_mgmt.privacy_incident'] loop
    execute format('create trigger no_update before update on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_delete before delete on %s for each row execute function committee.reject_mutation()', t);
    execute format('create trigger no_truncate before truncate on %s for each statement execute function committee.reject_mutation()', t);
  end loop;
end;
$$;
alter table case_mgmt.subject_correction enable row level security;
create policy subject_correction_read on case_mgmt.subject_correction for select to authenticated
  using (authz.can_view_case(case_id));
grant select on case_mgmt.subject_correction to authenticated;
alter table case_mgmt.privacy_incident enable row level security;
create policy privacy_incident_read on case_mgmt.privacy_incident for select to authenticated
  using (authz.has_permission('SECURITY_EVENT_VIEW') or authz.can_view_case(case_id));
grant select on case_mgmt.privacy_incident to authenticated;

-- 4.1 The correction. The correct subject is added first (api.add_case_subject). Refused while findings or a
-- recommendation name the wrong subject: those records stand and are corrected through reopening, never rewritten.
create function api.correct_case_subject(p_subject_id uuid, p_correct_subject_id uuid, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_wrong case_mgmt.case_subject;
  v_reason text;
  v_link grievance.subject_portal_link;
  v_notice grievance.defence_notice;
  v_a case_mgmt.allegation;
  v_links int := 0;
  v_withdrawn int := 0;
  v_superseded int := 0;
  v_sent int;
  v_id uuid;
  v_incident uuid;
begin
  select * into v_wrong from case_mgmt.case_subject s where s.id = p_subject_id;
  if v_wrong.id is null or not authz.can_view_case(v_wrong.case_id) then perform api._fail('NOT_FOUND'); end if;
  perform case_mgmt.lock_editable_case(v_wrong.case_id);
  if p_correct_subject_id is null or p_correct_subject_id = v_wrong.id
     or not exists (select 1 from case_mgmt.case_subject s where s.id = p_correct_subject_id and s.case_id = v_wrong.case_id)
     or case_mgmt.subject_status(p_correct_subject_id) = 'MISIDENTIFIED' then
    perform api._fail('INVALID', 'correct_subject_id');
  end if;
  if case_mgmt.subject_status(v_wrong.id) = 'MISIDENTIFIED' then perform api._fail('CONFLICT', 'SUBJECT_MISIDENTIFIED'); end if;
  if exists (select 1 from case_mgmt.finding f where f.subject_id = v_wrong.id) then
    perform api._fail('CONFLICT', 'SUBJECT_HAS_FINDINGS');
  end if;
  if exists (select 1 from decision.recommendation_item_subject r where r.subject_id = v_wrong.id)
     or exists (select 1 from decision.recommendation_item_allegation r
                join case_mgmt.allegation a on a.id = r.allegation_id
                where a.subject_id = v_wrong.id and a.status = 'OPEN') then
    perform api._fail('CONFLICT', 'SUBJECT_IN_RECOMMENDATION');
  end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);

  -- The wrong person's portal access ends now.
  for v_link in select * from grievance.subject_portal_link l
                where l.subject_id = v_wrong.id and l.revoked_at is null for update loop
    update grievance.subject_portal_link set revoked_by = v_actor, revoked_at = now() where id = v_link.id;
    perform audit.record_event('SUBJECT_PORTAL_UNLINKED', 'BUSINESS', 'SUCCESS', v_wrong.case_id, 'subject_portal_link',
      v_link.id::text, null, jsonb_build_object('subject_id', v_wrong.id, 'basis', 'SUBJECT_CORRECTION'));
    v_links := v_links + 1;
  end loop;

  -- Every notice ever issued to them counts as sent; the open ones are withdrawn and their delivery tasks closed.
  select count(*)::int into v_sent from grievance.defence_notice n where n.subject_id = v_wrong.id;
  for v_notice in select * from grievance.defence_notice n
                  where n.subject_id = v_wrong.id and n.status in ('ISSUED', 'ACKNOWLEDGED')
                  order by n.sequence_no for update loop
    update grievance.defence_notice set status = 'WITHDRAWN', closed_at = now() where id = v_notice.id;
    update grievance.notice_delivery_task set status = 'DONE', closed_at = now(), closed_by = v_actor
     where notice_id = v_notice.id and status = 'OPEN';
    perform audit.record_event('EMPLOYEE_NOTICE_WITHDRAWN', 'BUSINESS', 'SUCCESS', v_wrong.case_id, 'defence_notice',
      v_notice.id::text, null, jsonb_build_object('subject_id', v_wrong.id, 'kind', v_notice.kind,
                                                  'basis', 'SUBJECT_CORRECTION'));
    v_withdrawn := v_withdrawn + 1;
  end loop;

  -- Open allegations about the wrong person are re-stated about the correct one; the originals stay, SUPERSEDED.
  for v_a in select * from case_mgmt.allegation a
             where a.subject_id = v_wrong.id and a.status = 'OPEN' order by a.created_at, a.id for update loop
    perform case_mgmt.successor_allegation(v_a, v_a.case_id, v_a.category, v_a.description, p_correct_subject_id,
                                           v_a.policy_reference, v_a.law_reference, v_actor);
    perform case_mgmt.close_allegation(v_a, 'SUPERSEDED', 'SUBJECT_CORRECTION', v_reason, v_actor);
    v_superseded := v_superseded + 1;
  end loop;

  perform case_mgmt.append_subject_status(v_wrong.case_id, v_wrong.id, 'MISIDENTIFIED', v_reason, v_actor);
  insert into case_mgmt.subject_correction (case_id, wrong_subject_id, correct_subject_id, reason, links_revoked,
                                            notices_withdrawn, allegations_superseded, corrected_by)
  values (v_wrong.case_id, v_wrong.id, p_correct_subject_id, v_reason, v_links, v_withdrawn, v_superseded, v_actor)
  returning id into v_id;
  perform audit.record_event('SUBJECT_CORRECTED', 'BUSINESS', 'SUCCESS', v_wrong.case_id, 'subject_correction', v_id::text,
    null, jsonb_build_object('wrong_subject_id', v_wrong.id, 'correct_subject_id', p_correct_subject_id,
                             'links_revoked', v_links, 'notices_withdrawn', v_withdrawn,
                             'allegations_superseded', v_superseded, 'privacy_incident', v_sent > 0));
  if v_sent > 0 then
    insert into case_mgmt.privacy_incident (case_id, correction_id, kind, notices_sent, recorded_by)
    values (v_wrong.case_id, v_id, 'NOTICE_TO_MISIDENTIFIED_SUBJECT', v_sent, v_actor)
    returning id into v_incident;
    perform audit.record_event('PRIVACY_INCIDENT_RECORDED', 'SECURITY', 'SUCCESS', v_wrong.case_id, 'privacy_incident',
      v_incident::text, null, jsonb_build_object('kind', 'NOTICE_TO_MISIDENTIFIED_SUBJECT', 'correction_id', v_id,
                                                 'notices_sent', v_sent));
  end if;
  return v_id;
end;
$$;

-- =============================================================================
-- 5. Splitting a case (AMB-004) and conflicts across the split family
-- =============================================================================
-- Internal: the case and every case connected to it by SPLIT_FROM links, both ways.
create function case_mgmt.split_family(p_case_id uuid)
returns uuid[]
language sql stable
set search_path = ''
as $$
  with recursive family (case_id) as (
    select p_case_id
    union
    select case when l.case_id = f.case_id then l.linked_case_id else l.case_id end
    from family f
    join case_mgmt.case_link l on l.link_type = 'SPLIT_FROM' and (l.case_id = f.case_id or l.linked_case_id = f.case_id)
  )
  select array_agg(case_id) from family;
$$;

-- Replaced from 2080, same signature, narrowing only: (a) every branch looks at the whole split family, so a conflict
-- on one case of the family is a conflict on all of them; (b) a portal link revoked because its subject was
-- MISIDENTIFIED still counts, so the correction never opens the case to the person it was wrongly about. Unchanged
-- otherwise: a current declared or confirmed conflict, an active portal link (a party), the grievant, an upheld
-- raised conflict.
create or replace function authz.has_conflict(p_case_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  with family as (select unnest(case_mgmt.split_family(p_case_id)) as case_id)
  select exists (
           select 1 from case_mgmt.conflict_check k join family f on f.case_id = k.case_id
           where k.user_id = p_user_id and k.is_current and k.status in ('CONFLICT_DECLARED', 'CONFLICT_CONFIRMED'))
      or exists (
           select 1 from grievance.subject_portal_link l join family f on f.case_id = l.case_id
           where l.user_id = p_user_id
             and (l.revoked_at is null or case_mgmt.subject_status(l.subject_id) = 'MISIDENTIFIED'))
      or exists (
           select 1 from grievance.grievance g join family f on f.case_id = g.case_id
           where g.grievant_user_id = p_user_id)
      or exists (
           select 1 from case_mgmt.case_conflict_concern c join family f on f.case_id = c.case_id
           where c.subject_user_id = p_user_id and c.status = 'UPHELD');
$$;

-- 5.1 The split. The caller edits the source case and may create cases. The new case keeps the source's
-- classification, restriction and accountable authority; its team is the source's active assignments of active
-- accounts, each passing the assignee rule on the new case (clearance, conflict across the family, role), so no one
-- gains a case they could not already work. The chosen allegations must be open, outside any recommendation and without findings, and at
-- least one open allegation stays on the source. SOURCE_REQUIRED: when a case may be split (S090/S107); this is the
-- narrowing default until the owner answers.
create function api.split_case(p_case_id uuid, p_allegation_ids uuid[], p_title text, p_summary text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_src case_mgmt.case_record;
  v_ids uuid[];
  v_title text;
  v_summary text;
  v_reason text;
  v_block text;
  v_number text;
  v_case uuid;
  v_link uuid;
  v_asg case_mgmt.case_assignment;
  v_asg_id uuid;
  v_subject case_mgmt.case_subject;
  v_new_subject uuid;
  v_map jsonb := '{}'::jsonb;
  v_status text;
  v_a case_mgmt.allegation;
  v_assigned int := 0;
  v_not_carried int;
begin
  v_src := case_mgmt.lock_editable_case(p_case_id);
  if not authz.has_permission('CASE_CREATE') then perform api._fail('FORBIDDEN'); end if;
  v_ids := array(select distinct x from unnest(p_allegation_ids) x where x is not null);
  if p_allegation_ids is null or cardinality(v_ids) not between 1 and 50
     or cardinality(v_ids) <> cardinality(p_allegation_ids)
     or (select count(*) from case_mgmt.allegation a where a.id = any (v_ids) and a.case_id = v_src.id) <> cardinality(v_ids) then
    perform api._fail('INVALID', 'allegation_ids');
  end if;
  v_title := api._require_text(p_title, 'title', 3, 200);
  v_summary := api._require_text(p_summary, 'summary', 10, 4000);
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  perform 1 from case_mgmt.allegation a where a.id = any (v_ids) for update;
  select b into v_block from unnest(v_ids) x, case_mgmt.allegation_change_block(x, true) b where b is not null limit 1;
  if v_block is not null then perform api._fail('CONFLICT', v_block); end if;
  if not exists (select 1 from case_mgmt.allegation a
                 where a.case_id = v_src.id and a.status = 'OPEN' and a.id <> all (v_ids)) then
    perform api._fail('CONFLICT', 'SPLIT_LEAVES_NOTHING');
  end if;

  -- Every case here is synthetic (§2). PRODUCTION_SUBSTITUTION_REQUIRED: production numbering uses CDF-CASE.
  v_number := case_mgmt.next_case_number('CDF-DEMO');
  insert into case_mgmt.case_record (case_number, case_type, title, summary, classification, is_restricted, source,
                                     source_type, owner_id, created_by, updated_by)
  values (v_number, v_src.case_type, v_title, v_summary, v_src.classification, v_src.is_restricted, 'OTHER',
          v_src.source_type, v_src.owner_id, v_actor, v_actor)
  returning id into v_case;
  insert into case_mgmt.case_link (case_id, linked_case_id, link_type, reason, linked_by)
  values (v_case, v_src.id, 'SPLIT_FROM', v_reason, v_actor)
  returning id into v_link;
  insert into workflow.workflow_instance (case_id, workflow_code, current_state) values (v_case, 'CDF_CASE_V1', 'REFERRAL');
  perform audit.record_event('CASE_CREATED', 'BUSINESS', 'SUCCESS', v_case, 'case_record', v_case::text, null,
    jsonb_build_object('case_number', v_number, 'source_type', v_src.source_type, 'basis', 'CASE_SPLIT',
                       'classification', v_src.classification, 'is_restricted', v_src.is_restricted));

  -- The team: the source's active assignments, re-checked on the new case (the family's conflicts included). A member
  -- whose account is not active (suspended, deactivated) is not carried; the count is recorded.
  select count(*)::int into v_not_carried from case_mgmt.case_assignment a join iam.user_profile u on u.id = a.user_id
  where a.case_id = v_src.id and a.status = 'ACTIVE' and u.status <> 'ACTIVE';
  for v_asg in select a.* from case_mgmt.case_assignment a join iam.user_profile u on u.id = a.user_id
               where a.case_id = v_src.id and a.status = 'ACTIVE' and u.status = 'ACTIVE'
               order by a.assigned_at, a.id loop
    perform case_mgmt.assert_assignee_eligible(v_case, v_asg.user_id, v_asg.assignment_role);
    insert into case_mgmt.case_assignment (case_id, user_id, assignment_role, reason, assigned_by)
    values (v_case, v_asg.user_id, v_asg.assignment_role, 'Case split: carried from the source case', v_actor)
    returning id into v_asg_id;
    perform audit.record_event('CASE_ASSIGNED', 'BUSINESS', 'SUCCESS', v_case, 'case_assignment', v_asg_id::text, null,
      jsonb_build_object('user_id', v_asg.user_id, 'assignment_role', v_asg.assignment_role, 'basis', 'CASE_SPLIT'));
    v_assigned := v_assigned + 1;
  end loop;

  -- The subjects of the moved allegations, re-created with their current status (never a portal link or a notice).
  for v_subject in select s.* from case_mgmt.case_subject s
                   where s.id in (select a.subject_id from case_mgmt.allegation a where a.id = any (v_ids))
                   order by s.added_at, s.id loop
    insert into case_mgmt.case_person (case_id, person_id, role, added_by)
    values (v_case, v_subject.person_id, 'SUBJECT', v_actor)
    on conflict (case_id, person_id, role) do nothing;
    insert into case_mgmt.case_subject (case_id, person_id, subject_category, added_by)
    values (v_case, v_subject.person_id, v_subject.subject_category, v_actor)
    returning id into v_new_subject;
    v_map := v_map || jsonb_build_object(v_subject.id::text, v_new_subject);
    v_status := case_mgmt.subject_status(v_subject.id);
    if v_status <> 'IDENTIFIED' then
      perform case_mgmt.append_subject_status(v_case, v_new_subject, v_status, v_reason, v_actor);
    end if;
    perform audit.record_event('CASE_SUBJECT_ADDED', 'BUSINESS', 'SUCCESS', v_case, 'case_subject', v_new_subject::text,
      null, jsonb_build_object('subject_category', v_subject.subject_category, 'existing_person', true,
                               'basis', 'CASE_SPLIT'));
  end loop;

  -- The allegations, re-created with provenance; the originals stay on the source, SUPERSEDED. No evidence moves.
  for v_a in select * from case_mgmt.allegation a where a.id = any (v_ids) order by a.created_at, a.id loop
    perform case_mgmt.successor_allegation(v_a, v_case, v_a.category, v_a.description,
                                           (v_map ->> v_a.subject_id::text)::uuid, v_a.policy_reference,
                                           v_a.law_reference, v_actor);
    perform case_mgmt.close_allegation(v_a, 'SUPERSEDED', 'CASE_SPLIT', v_reason, v_actor);
  end loop;

  perform audit.record_event('CASE_SPLIT', 'BUSINESS', 'SUCCESS', v_src.id, 'case_link', v_link::text, null,
    jsonb_build_object('allegations_moved', cardinality(v_ids), 'assignments_carried', v_assigned,
                       'assignments_not_carried', v_not_carried));
  perform workflow.apply_transition(v_case, 'REGISTER', v_actor, null);
  return v_case;
end;
$$;

-- =============================================================================
-- 6. Referral submission versions (AMB-008)
-- =============================================================================
-- 1880 recorded SUBMITTED and RESUBMITTED as events and let api.update_referral overwrite the content, so an earlier
-- submission could not be read back. Each submission now keeps what was submitted, numbered per referral.
create table intake.referral_submission (
  id                  uuid primary key default gen_random_uuid(),
  referral_id         uuid not null references intake.referral (id),
  version_no          int not null check (version_no >= 1),
  event_id            uuid not null unique references intake.referral_event (id),
  title               text not null,
  summary             text not null,
  allegation_category text not null,
  classification      core.classification_level not null,
  sector_id           uuid not null references iam.sector (id),
  committee_id        uuid not null references committee.committee (id),
  submitted_by        uuid not null references iam.user_profile (id),
  submitted_at        timestamptz not null,
  unique (referral_id, version_no)
);
create index referral_submission_sector on intake.referral_submission (sector_id);
create index referral_submission_committee on intake.referral_submission (committee_id);
create index referral_submission_submitted_by on intake.referral_submission (submitted_by);
comment on table intake.referral_submission is
  'The content of each referral submission and resubmission (AMB-008; migration 2090). Same referral and number; '
  'nothing is overwritten. Written with the SUBMITTED or RESUBMITTED event. Append-only.';
create trigger no_update before update on intake.referral_submission
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on intake.referral_submission
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on intake.referral_submission
  for each statement execute function committee.reject_mutation();
alter table intake.referral_submission enable row level security;
create policy referral_submission_read on intake.referral_submission for select to authenticated
  using (authz.can_view_referral(referral_id));
grant select on intake.referral_submission to authenticated;

create function intake.snapshot_referral_submission()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into intake.referral_submission (referral_id, version_no, event_id, title, summary, allegation_category,
                                          classification, sector_id, committee_id, submitted_by, submitted_at)
  select r.id,
         (select coalesce(max(x.version_no), 0) + 1 from intake.referral_submission x where x.referral_id = r.id),
         new.id, r.title, r.summary, r.allegation_category, r.classification, r.sector_id, r.committee_id,
         new.actor_id, new.occurred_at
  from intake.referral r where r.id = new.referral_id;
  return null;
end;
$$;
create trigger referral_event_submission after insert on intake.referral_event
  for each row when (new.event_type in ('SUBMITTED', 'RESUBMITTED'))
  execute function intake.snapshot_referral_submission();

-- =============================================================================
-- 7. Committee membership corrections (AMB-045)
-- =============================================================================
create table committee.membership_correction (
  id                   uuid primary key default gen_random_uuid(),
  membership_id        uuid not null references committee.membership (id),
  committee_id         uuid not null references committee.committee (id),
  kind                 text not null check (kind in ('WRONG_HOLDER', 'WRONG_SEAT', 'WRONG_DATES', 'WRONG_REFERENCE', 'OTHER')),
  reason               text not null check (length(reason) between 10 and 2000),
  -- Proceeding snapshots that named this membership when the correction was recorded. They stand as taken.
  affected_proceedings int not null check (affected_proceedings >= 0),
  corrected_by         uuid not null references iam.user_profile (id),
  corrected_at         timestamptz not null default clock_timestamp()
);
create index membership_correction_membership on committee.membership_correction (membership_id);
create index membership_correction_committee on committee.membership_correction (committee_id);
create index membership_correction_corrected_by on committee.membership_correction (corrected_by);
comment on table committee.membership_correction is
  'A correction to a committee seat recorded as an annotation (AMB-045; migration 2090). The seat is changed only by '
  'ending it and appointing anew; past proceeding snapshots are never edited. Append-only.';
create trigger no_update before update on committee.membership_correction
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on committee.membership_correction
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on committee.membership_correction
  for each statement execute function committee.reject_mutation();
alter table committee.membership_correction enable row level security;
create policy membership_correction_read on committee.membership_correction for select to authenticated
  using (authz.can_view_committee_registry(committee_id));
grant select on committee.membership_correction to authenticated;

create function api.annotate_committee_membership(p_membership_id uuid, p_kind text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_m committee.membership;
  v_affected int;
  v_id uuid;
begin
  if not authz.has_permission('COMMITTEE_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  select * into v_m from committee.membership m where m.id = p_membership_id;
  if v_m.id is null then perform api._fail('NOT_FOUND'); end if;
  perform committee.lock_committee(v_m.committee_id);
  -- No one corrects the record of their own seat.
  if v_m.user_id = v_actor then perform api._fail('CONFLICT', 'SELF_CORRECTION'); end if;
  if p_kind is null or p_kind not in ('WRONG_HOLDER', 'WRONG_SEAT', 'WRONG_DATES', 'WRONG_REFERENCE', 'OTHER') then
    perform api._fail('INVALID', 'kind');
  end if;
  select count(*)::int into v_affected from committee.proceeding_member pm where pm.membership_id = v_m.id;
  insert into committee.membership_correction (membership_id, committee_id, kind, reason, affected_proceedings, corrected_by)
  values (v_m.id, v_m.committee_id, p_kind, api._require_text(p_reason, 'reason', 10, 2000), v_affected, v_actor)
  returning id into v_id;
  perform audit.record_event('COMMITTEE_MEMBERSHIP_ANNOTATED', 'ADMIN', 'SUCCESS', null, 'committee_membership',
    v_m.id::text, null, jsonb_build_object('committee_id', v_m.committee_id, 'kind', p_kind,
                                           'affected_proceedings', v_affected, 'correction_id', v_id));
  return v_id;
end;
$$;

-- =============================================================================
-- 8. Corrections to approved minutes (AMB-093)
-- =============================================================================
create table committee.minutes_correction (
  id              uuid primary key default gen_random_uuid(),
  minutes_id      uuid not null references committee.minutes (id),
  meeting_id      uuid not null references committee.meeting (id),
  case_id         uuid not null references case_mgmt.case_record (id),
  sequence_no     int not null check (sequence_no >= 1),
  correction_text text not null check (length(correction_text) between 10 and 8000),
  reason          text not null check (length(reason) between 10 and 2000),
  reviewer_count  int not null check (reviewer_count >= 1),
  status          text not null default 'IN_REVIEW' check (status in ('IN_REVIEW', 'APPROVED', 'REJECTED')),
  proposed_by     uuid not null references iam.user_profile (id),
  proposed_at     timestamptz not null default clock_timestamp(),
  decided_at      timestamptz,
  unique (minutes_id, sequence_no),
  check ((status = 'IN_REVIEW') = (decided_at is null))
);
create unique index minutes_correction_open on committee.minutes_correction (minutes_id) where status = 'IN_REVIEW';
create index minutes_correction_meeting on committee.minutes_correction (meeting_id);
create index minutes_correction_case on committee.minutes_correction (case_id);
create index minutes_correction_proposed_by on committee.minutes_correction (proposed_by);
comment on table committee.minutes_correction is
  'A correction appended to approved minutes (AMB-093; migration 2090), reviewed by the same attending, non-conflicted '
  'members. The approved version never changes. Only the decision is recorded on the row, once.';

create table committee.minutes_correction_review (
  id            uuid primary key default gen_random_uuid(),
  correction_id uuid not null references committee.minutes_correction (id),
  reviewer_id   uuid not null references iam.user_profile (id),
  decision      text not null check (decision in ('APPROVE', 'REJECT')),
  comment       text check (length(comment) between 5 and 4000),
  reviewed_at   timestamptz not null default clock_timestamp(),
  unique (correction_id, reviewer_id),
  check (decision <> 'REJECT' or comment is not null)
);
create index minutes_correction_review_reviewer on committee.minutes_correction_review (reviewer_id);
comment on table committee.minutes_correction_review is 'One decision per reviewer per correction (AMB-093). Append-only.';

create function committee.protect_minutes_correction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'IN_REVIEW' or new.status = 'IN_REVIEW'
     or (to_jsonb(new) - array['status', 'decided_at']) <> (to_jsonb(old) - array['status', 'decided_at']) then
    raise exception 'minutes correction % is decided once and its content is immutable', old.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger minutes_correction_protect before update on committee.minutes_correction
  for each row execute function committee.protect_minutes_correction();
create trigger no_delete before delete on committee.minutes_correction
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on committee.minutes_correction
  for each statement execute function committee.reject_mutation();
create trigger no_update before update on committee.minutes_correction_review
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on committee.minutes_correction_review
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on committee.minutes_correction_review
  for each statement execute function committee.reject_mutation();

-- As committee.minutes: the meeting's deliberation readers; the case team once the correction is approved.
alter table committee.minutes_correction enable row level security;
create policy minutes_correction_read on committee.minutes_correction for select to authenticated
  using (authz.can_view_meeting_deliberation(meeting_id) or (status = 'APPROVED' and authz.can_view_case(case_id)));
grant select on committee.minutes_correction to authenticated;
alter table committee.minutes_correction_review enable row level security;
create policy minutes_correction_review_read on committee.minutes_correction_review for select to authenticated
  using (exists (select 1 from committee.minutes_correction c
                 where c.id = minutes_correction_review.correction_id and authz.can_view_meeting_deliberation(c.meeting_id)));
grant select on committee.minutes_correction_review to authenticated;

-- 8.1 The meeting's secretary proposes a correction to the current approved version. The reviewers are the minutes'
-- reviewers (members present with no conflict, never the secretaries), re-checked at each review. With none, nothing
-- is approved on the secretary's word alone.
create function api.propose_minutes_correction(p_minutes_id uuid, p_correction_text text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_mi committee.minutes;
  v_m committee.meeting;
  v_reviewers int;
  v_id uuid;
begin
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id;
  if v_mi.id is null or not authz.can_view_meeting_deliberation(v_mi.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  v_m := committee.lock_managed_meeting(v_mi.meeting_id);
  select * into v_mi from committee.minutes mi where mi.id = p_minutes_id for update;
  if v_mi.status not in ('APPROVED', 'DEEMED_APPROVED') then perform api._fail('CONFLICT', 'MINUTES_NOT_APPROVED'); end if;
  if exists (select 1 from committee.minutes_correction c where c.minutes_id = v_mi.id and c.status = 'IN_REVIEW') then
    perform api._fail('CONFLICT', 'CORRECTION_IN_REVIEW');
  end if;
  select count(*)::int into v_reviewers from committee.meeting_participant mp
  where mp.meeting_id = v_m.id and committee.minutes_reviewer(v_m.id, mp.user_id);
  if v_reviewers = 0 then perform api._fail('CONFLICT', 'NO_CORRECTION_REVIEWERS'); end if;
  insert into committee.minutes_correction (minutes_id, meeting_id, case_id, sequence_no, correction_text, reason,
                                            reviewer_count, proposed_by)
  values (v_mi.id, v_m.id, v_mi.case_id,
          (select coalesce(max(c.sequence_no), 0) + 1 from committee.minutes_correction c where c.minutes_id = v_mi.id),
          api._require_text(p_correction_text, 'correction_text', 10, 8000), api._require_text(p_reason, 'reason', 10, 2000),
          v_reviewers, v_actor)
  returning id into v_id;
  perform audit.record_event('MINUTES_CORRECTION_PROPOSED', 'BUSINESS', 'SUCCESS', v_mi.case_id, 'minutes_correction',
    v_id::text, null, jsonb_build_object('minutes_id', v_mi.id, 'meeting_id', v_m.id, 'reviewers', v_reviewers));
  return v_id;
end;
$$;

-- 8.2 Review: every reviewer approves, or any one rejects (with a comment). The approved version never changes.
create function api.review_minutes_correction(p_correction_id uuid, p_decision text, p_comment text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_c committee.minutes_correction;
  v_approvals int;
  v_status text;
begin
  select * into v_c from committee.minutes_correction c where c.id = p_correction_id;
  if v_c.id is null or not authz.can_view_meeting_deliberation(v_c.meeting_id) then perform api._fail('NOT_FOUND'); end if;
  select * into v_c from committee.minutes_correction c where c.id = p_correction_id for update;
  if not committee.minutes_reviewer(v_c.meeting_id, v_actor) or not authz.user_case_gate(v_actor, v_c.case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  if v_c.status <> 'IN_REVIEW' then perform api._fail('CONFLICT', 'CORRECTION_NOT_IN_REVIEW'); end if;
  if p_decision is null or p_decision not in ('APPROVE', 'REJECT') then perform api._fail('INVALID', 'decision'); end if;
  if exists (select 1 from committee.minutes_correction_review r where r.correction_id = v_c.id and r.reviewer_id = v_actor) then
    perform api._fail('CONFLICT', 'ALREADY_REVIEWED');
  end if;
  insert into committee.minutes_correction_review (correction_id, reviewer_id, decision, comment)
  values (v_c.id, v_actor, p_decision,
          case when p_decision = 'REJECT' or p_comment is not null then api._require_text(p_comment, 'comment', 5, 4000) end);
  select count(*)::int into v_approvals from committee.minutes_correction_review r
  where r.correction_id = v_c.id and r.decision = 'APPROVE';
  v_status := case when p_decision = 'REJECT' then 'REJECTED'
                   when v_approvals >= v_c.reviewer_count then 'APPROVED'
                   else 'IN_REVIEW' end;
  if v_status <> 'IN_REVIEW' then
    update committee.minutes_correction set status = v_status, decided_at = now() where id = v_c.id;
  end if;
  perform audit.record_event('MINUTES_CORRECTION_REVIEWED', 'BUSINESS', 'SUCCESS', v_c.case_id, 'minutes_correction',
    v_c.id::text, null, jsonb_build_object('minutes_id', v_c.minutes_id, 'decision', p_decision, 'status', v_status));
  return v_status;
end;
$$;

-- =============================================================================
-- 9. Annotations on records past ACTIVE (AMB-223)
-- =============================================================================
create table records.record_annotation (
  id            uuid primary key default gen_random_uuid(),
  case_id       uuid not null references case_mgmt.case_record (id),
  sequence_no   int not null check (sequence_no >= 1),
  target_kind   text not null check (target_kind in (
                  'CASE_RECORD', 'CASE_CLOSURE', 'FINDING', 'MINUTES', 'DECISION', 'EVIDENCE_METADATA', 'OTHER')),
  annotation    text not null check (length(annotation) between 10 and 4000),
  reason        text not null check (length(reason) between 10 and 2000),
  -- The records state the annotation was made in.
  records_state text not null,
  annotated_by  uuid not null references iam.user_profile (id),
  annotated_at  timestamptz not null default clock_timestamp(),
  unique (case_id, sequence_no)
);
create index record_annotation_annotated_by on records.record_annotation (annotated_by);
comment on table records.record_annotation is
  'A correction to a closed or archived record, appended with its reason (AMB-223; migration 2090). The original '
  'record never changes. Append-only.';
create trigger no_update before update on records.record_annotation
  for each row execute function committee.reject_mutation();
create trigger no_delete before delete on records.record_annotation
  for each row execute function committee.reject_mutation();
create trigger no_truncate before truncate on records.record_annotation
  for each statement execute function committee.reject_mutation();
alter table records.record_annotation enable row level security;
create policy record_annotation_read on records.record_annotation for select to authenticated
  using (authz.can_view_records(case_id));
grant select on records.record_annotation to authenticated;

-- Records staff in catalogue scope (ARCHIVE_RECORD_VIEW, cleared, unrestricted, past ACTIVE) who administer the
-- archive. A disposed record takes no annotation.
create function api.annotate_archived_record(p_case_id uuid, p_target_kind text, p_annotation text, p_reason text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_id uuid;
begin
  if p_case_id is null or not authz.can_view_records(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('ARCHIVE_RECORD_ADMINISTER') or not authz.in_records_catalogue_scope(p_case_id) then
    perform api._fail('FORBIDDEN');
  end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  if v_case.records_state = 'ACTIVE' then perform api._fail('CONFLICT', 'CASE_ACTIVE'); end if;
  if v_case.records_state = 'DISPOSED' then perform api._fail('CONFLICT', 'RECORD_DISPOSED'); end if;
  if p_target_kind is null or p_target_kind not in (
       'CASE_RECORD', 'CASE_CLOSURE', 'FINDING', 'MINUTES', 'DECISION', 'EVIDENCE_METADATA', 'OTHER') then
    perform api._fail('INVALID', 'target_kind');
  end if;
  insert into records.record_annotation (case_id, sequence_no, target_kind, annotation, reason, records_state, annotated_by)
  values (v_case.id,
          (select coalesce(max(r.sequence_no), 0) + 1 from records.record_annotation r where r.case_id = v_case.id),
          p_target_kind, api._require_text(p_annotation, 'annotation', 10, 4000),
          api._require_text(p_reason, 'reason', 10, 2000), v_case.records_state, v_actor)
  returning id into v_id;
  perform audit.record_event('RECORD_ANNOTATED', 'BUSINESS', 'SUCCESS', v_case.id, 'record_annotation', v_id::text, null,
    jsonb_build_object('target_kind', p_target_kind, 'records_state', v_case.records_state));
  return v_id;
end;
$$;

-- =============================================================================
-- 10. Grants and the catalogue
-- =============================================================================
revoke all on function
  case_mgmt.protect_case_link(), case_mgmt.guard_duplicate_closure(), case_mgmt.subject_status(uuid),
  case_mgmt.append_subject_status(uuid, uuid, text, text, uuid), case_mgmt.guard_subject_notifiable(),
  decision.guard_item_subject_status(), case_mgmt.protect_allegation(), case_mgmt.guard_allegation_active(),
  case_mgmt.successor_allegation(case_mgmt.allegation, uuid, text, text, uuid, text, text, uuid),
  case_mgmt.close_allegation(case_mgmt.allegation, text, text, text, uuid),
  case_mgmt.allegation_change_block(uuid, boolean), case_mgmt.split_family(uuid),
  intake.snapshot_referral_submission(), committee.protect_minutes_correction()
from public, anon, authenticated;

revoke all on function
  api.link_cases(uuid, uuid, text, text), api.end_case_link(uuid, text),
  api.record_subject_status(uuid, text, text), api.withdraw_allegation(uuid, text),
  api.split_allegation(uuid, jsonb, text), api.correct_case_subject(uuid, uuid, text),
  api.split_case(uuid, uuid[], text, text, text), api.annotate_committee_membership(uuid, text, text),
  api.propose_minutes_correction(uuid, text, text), api.review_minutes_correction(uuid, text, text),
  api.annotate_archived_record(uuid, text, text, text)
from public;
grant execute on function
  api.link_cases(uuid, uuid, text, text), api.end_case_link(uuid, text),
  api.record_subject_status(uuid, text, text), api.withdraw_allegation(uuid, text),
  api.split_allegation(uuid, jsonb, text), api.correct_case_subject(uuid, uuid, text),
  api.split_case(uuid, uuid[], text, text, text), api.annotate_committee_membership(uuid, text, text),
  api.propose_minutes_correction(uuid, text, text), api.review_minutes_correction(uuid, text, text),
  api.annotate_archived_record(uuid, text, text, text)
to authenticated;

-- The form and status catalogue (migration 1970) follows the schema: CASE_SPLIT is emitted (S090, S107; when a case may
-- be split stays SOURCE_REQUIRED), and the modules name their new commands.
update config.legacy_status_map set target_event_state = 'IMPLEMENTED' where target_event = 'CASE_SPLIT';
update config.target_module
   set commands = commands || array['api.link_cases', 'api.end_case_link', 'api.split_case', 'api.withdraw_allegation',
                                    'api.split_allegation', 'api.record_subject_status', 'api.correct_case_subject'],
       delivered_in = delivered_in || '2090'::text,
       notes = notes || ' Since 2090: typed case links (never a merge), case and allegation splits with provenance, '
                        'allegation withdrawal, subject status and the correction of a wrongly identified subject.'
 where code = 'CASE_DETAILS';
update config.target_module
   set commands = commands || array['api.annotate_committee_membership'],
       delivered_in = delivered_in || '2090'::text,
       notes = notes || ' Since 2090: a correction to a seat is an annotation; past snapshots are never edited.'
 where code = 'COMMITTEE_REGISTRY';
update config.target_module
   set commands = commands || array['api.propose_minutes_correction', 'api.review_minutes_correction'],
       delivered_in = delivered_in || '2090'::text,
       notes = notes || ' Since 2090: approved minutes are corrected by a reviewed correction; the approved version stays.'
 where code = 'MEETING_MINUTES';
update config.target_module
   set commands = commands || array['api.annotate_archived_record'],
       delivered_in = delivered_in || '2090'::text,
       notes = notes || ' Since 2090: a record past ACTIVE is corrected by an appended annotation.'
 where code = 'RECORDS_RETRIEVAL';
update config.target_module
   set delivered_in = delivered_in || '2090'::text,
       notes = notes || ' Since 2090: each submission and resubmission keeps the content submitted, as a numbered version.'
 where code = 'DIRECT_REFERRAL';
