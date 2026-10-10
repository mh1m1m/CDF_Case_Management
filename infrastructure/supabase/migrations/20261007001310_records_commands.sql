-- =============================================================================
-- 1310 Records, retention and legal hold: commands (Phase 11)
-- Requirements: CDF-REC-002..008; ADR-013 D3–D8; architecture/data-model/RECORDS_RETENTION.md §4, §5, §8
--
-- Same contract as 0700: resolve the actor, re-check authorization, validate state, change, audit in
-- the same transaction. Audit `reason` carries a code (never justification text); metadata carries ids
-- and codes only. Lock order is always case row first, then records rows, so a hold and a disposition
-- on the same case serialise (REC-T21).
--
-- Disposition is LOGICAL ONLY (ADR-013 D7): execution marks the case DISPOSED and issues a certificate.
-- No command here deletes a row or a storage object.
-- =============================================================================

create function records.assert_no_active_hold(p_case_id uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if records.has_active_hold(p_case_id) then
    perform api._fail('CONFLICT', 'LEGAL_HOLD_ACTIVE');
  end if;
end;
$$;

-- Records actors see a case through the records view or, for case staff with a hold permission, the case itself.
create function records._visible(p_case_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_view_records(p_case_id) or authz.can_view_case(p_case_id);
$$;

-- -----------------------------------------------------------------------------
-- Legal hold (ADR-013 D4, D5; RECORDS_RETENTION §5)
-- -----------------------------------------------------------------------------
create function api.place_legal_hold(
  p_case_id uuid, p_scope_type text, p_evidence_id uuid, p_reason_code text, p_justification text,
  p_authority_reference text default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_just text;
  v_auth text;
  v_id uuid;
  v_number text;
  v_audit uuid;
  v_req records.disposition_request;
begin
  if not records._visible(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_apply_legal_hold(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  if v_case.records_state = 'DISPOSED' then perform api._fail('CONFLICT', 'RECORDS_DISPOSED'); end if;

  if p_scope_type is null or p_scope_type not in ('CASE', 'EVIDENCE_ITEM') then perform api._fail('INVALID', 'scope_type'); end if;
  if p_scope_type = 'CASE' and p_evidence_id is not null then perform api._fail('INVALID', 'evidence_id'); end if;
  if p_scope_type = 'EVIDENCE_ITEM'
     and (p_evidence_id is null
          or not exists (select 1 from evidence.evidence e where e.id = p_evidence_id and e.case_id = p_case_id)) then
    perform api._fail('INVALID', 'evidence_id');
  end if;
  if p_reason_code is null
     or p_reason_code not in ('LITIGATION', 'REGULATORY_INQUIRY', 'INTERNAL_INVESTIGATION', 'AUDIT', 'OTHER') then
    perform api._fail('INVALID', 'reason_code');
  end if;
  v_just := api._require_text(p_justification, 'justification', 20, 2000);
  if nullif(btrim(coalesce(p_authority_reference, '')), '') is not null then
    v_auth := api._require_text(p_authority_reference, 'authority_reference', 3, 200);
  end if;

  v_number := records.next_number('CDF-HOLD');
  insert into records.legal_hold (hold_number, scope_type, case_id, evidence_id, reason_code, justification,
                                  authority_reference, placed_by)
  values (v_number, p_scope_type, p_case_id, p_evidence_id, p_reason_code, v_just, v_auth, v_actor)
  returning id into v_id;
  v_audit := audit.record_event('LEGAL_HOLD_PLACED', 'BUSINESS', 'SUCCESS', p_case_id, 'legal_hold', v_id::text, p_reason_code,
    jsonb_build_object('hold_number', v_number, 'scope_type', p_scope_type, 'evidence_id', p_evidence_id,
                       'reason_code', p_reason_code, 'records_state', v_case.records_state));
  insert into records.legal_hold_event (hold_id, event_type, actor_id, audit_event_id) values (v_id, 'PLACED', v_actor, v_audit);

  -- A hold stops any disposition in progress (REC-T18, REC-T19).
  for v_req in select * from records.disposition_request r
                where r.case_id = p_case_id and r.status in ('PENDING', 'APPROVED') for update loop
    update records.disposition_request set status = 'BLOCKED_BY_HOLD' where id = v_req.id;
    perform audit.record_event('DISPOSITION_BLOCKED_BY_HOLD', 'BUSINESS', 'DENIED', p_case_id, 'disposition_request',
      v_req.id::text, 'LEGAL_HOLD_ACTIVE', jsonb_build_object('hold_id', v_id, 'request_status', v_req.status));
  end loop;
  update case_mgmt.case_record c
     set legal_hold_status = 'ACTIVE',
         records_state = case when c.records_state in ('DISPOSITION_ELIGIBLE', 'DISPOSITION_PENDING') then 'RETENTION'
                              else c.records_state end,
         updated_at = now(), updated_by = v_actor, row_version = c.row_version + 1
   where c.id = p_case_id;
  return v_id;
end;
$$;

create function api.request_legal_hold_release(p_hold_id uuid, p_justification text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_hold records.legal_hold;
  v_just text;
  v_id uuid;
  v_audit uuid;
begin
  select * into v_hold from records.legal_hold h where h.id = p_hold_id;
  if v_hold.id is null or not records._visible(v_hold.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_release_legal_hold(v_hold.case_id) then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_hold.case_id for update;
  select * into v_hold from records.legal_hold h where h.id = p_hold_id for update;
  if v_hold.status <> 'ACTIVE' then perform api._fail('CONFLICT', 'HOLD_NOT_ACTIVE'); end if;
  v_just := api._require_text(p_justification, 'justification', 20, 2000);

  insert into records.legal_hold_release (hold_id, requested_by, justification) values (p_hold_id, v_actor, v_just)
  returning id into v_id;
  update records.legal_hold set status = 'RELEASE_PENDING' where id = p_hold_id;
  v_audit := audit.record_event('LEGAL_HOLD_RELEASE_REQUESTED', 'BUSINESS', 'SUCCESS', v_hold.case_id, 'legal_hold_release',
    v_id::text, null, jsonb_build_object('hold_id', p_hold_id, 'hold_number', v_hold.hold_number));
  insert into records.legal_hold_event (hold_id, event_type, actor_id, audit_event_id)
  values (p_hold_id, 'RELEASE_REQUESTED', v_actor, v_audit);
  return v_id;
end;
$$;

-- Dual control: the decider must be a different holder of LEGAL_HOLD_RELEASE (REC-T11).
create function api.decide_legal_hold_release(p_release_id uuid, p_approve boolean, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_rel records.legal_hold_release;
  v_hold records.legal_hold;
  v_reason text;
  v_audit uuid;
begin
  select * into v_rel from records.legal_hold_release r where r.id = p_release_id;
  select * into v_hold from records.legal_hold h where h.id = v_rel.hold_id;
  if v_rel.id is null or not records._visible(v_hold.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_release_legal_hold(v_hold.case_id) then perform api._fail('FORBIDDEN'); end if;
  if v_rel.requested_by = v_actor then perform api._fail('FORBIDDEN'); end if;
  perform 1 from case_mgmt.case_record c where c.id = v_hold.case_id for update;
  select * into v_rel from records.legal_hold_release r where r.id = p_release_id for update;
  if v_rel.status <> 'PENDING' then perform api._fail('CONFLICT', 'RELEASE_NOT_PENDING'); end if;
  if p_approve is null then perform api._fail('INVALID', 'approve'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);

  update records.legal_hold_release
     set status = case when p_approve then 'APPROVED' else 'REJECTED' end,
         decided_by = v_actor, decided_at = now(), decision_reason = v_reason
   where id = p_release_id;
  if p_approve then
    update records.legal_hold set status = 'RELEASED', released_at = now() where id = v_hold.id;
    -- The case flag drops only when nothing else holds the case (REC-T14).
    if not records.has_active_hold(v_hold.case_id) then
      update case_mgmt.case_record c
         set legal_hold_status = 'NONE', updated_at = now(), updated_by = v_actor, row_version = c.row_version + 1
       where c.id = v_hold.case_id;
    end if;
  else
    update records.legal_hold set status = 'ACTIVE' where id = v_hold.id;
  end if;
  v_audit := audit.record_event(case when p_approve then 'LEGAL_HOLD_RELEASED' else 'LEGAL_HOLD_RELEASE_REJECTED' end,
    'BUSINESS', 'SUCCESS', v_hold.case_id, 'legal_hold_release', p_release_id::text,
    case when p_approve then 'APPROVED' else 'REJECTED' end,
    jsonb_build_object('hold_id', v_hold.id, 'hold_number', v_hold.hold_number, 'requested_by', v_rel.requested_by));
  insert into records.legal_hold_event (hold_id, event_type, actor_id, audit_event_id)
  values (v_hold.id, case when p_approve then 'RELEASE_APPROVED' else 'RELEASE_REJECTED' end, v_actor, v_audit);
end;
$$;

-- -----------------------------------------------------------------------------
-- Retention class and eligibility (ADR-013 D2, D3)
-- -----------------------------------------------------------------------------
create function api.assign_retention_class(p_case_id uuid, p_retention_class text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
begin
  if not authz.can_view_records(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.has_permission('RETENTION_CLASS_ASSIGN') then perform api._fail('FORBIDDEN'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  if v_case.records_state not in ('ARCHIVED', 'RETENTION') then perform api._fail('CONFLICT', 'RECORDS_STATE'); end if;
  if p_retention_class is null or p_retention_class = 'UNASSIGNED'
     or not exists (select 1 from records.retention_class k where k.code = p_retention_class and k.record_type = 'CASE') then
    perform api._fail('INVALID', 'retention_class');
  end if;
  if p_retention_class = v_case.retention_class and v_case.records_state = 'RETENTION' then
    perform api._fail('CONFLICT', 'CLASS_UNCHANGED');
  end if;

  update case_mgmt.case_record c
     set retention_class = p_retention_class, records_state = 'RETENTION',
         updated_at = now(), updated_by = v_actor, row_version = c.row_version + 1
   where c.id = p_case_id;
  perform audit.record_event('RETENTION_CLASS_ASSIGNED', 'BUSINESS', 'SUCCESS', p_case_id, 'case_record', p_case_id::text, null,
    jsonb_build_object('from', v_case.retention_class, 'to', p_retention_class));
  return records._compute_schedule(p_case_id, 'CLASS_CHANGED');
end;
$$;

-- Marks RETENTION cases whose period has elapsed. Never disposes anything (ADR-013 D6).
-- Production runs it as a scheduled job under a service identity (PRODUCTION_MAPPING).
create function api.refresh_disposition_eligibility()
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_count int := 0;
begin
  if not authz.has_permission('DISPOSITION_REQUEST') then perform api._fail('FORBIDDEN'); end if;
  for v_case in
    select c.* from case_mgmt.case_record c
     where c.records_state = 'RETENTION' and authz.can_view_records(c.id)
     order by c.id
     for update
  loop
    continue when records.has_active_hold(v_case.id);
    continue when not exists (
      select 1 from records.retention_schedule s
      join records.retention_class k on k.code = s.retention_class
      where s.case_id = v_case.id and s.superseded_at is null and s.retention_class = v_case.retention_class
        and k.status = 'CONFIGURED' and k.category = 'TEMPORARY'
        and s.retain_until is not null and s.retain_until <= clock_timestamp());
    update case_mgmt.case_record c
       set records_state = 'DISPOSITION_ELIGIBLE', updated_at = now(), updated_by = v_actor, row_version = c.row_version + 1
     where c.id = v_case.id;
    perform audit.record_event('DISPOSITION_ELIGIBLE_MARKED', 'BUSINESS', 'SUCCESS', v_case.id, 'case_record', v_case.id::text,
      null, jsonb_build_object('retention_class', v_case.retention_class));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Disposition (ADR-013 D6, D7): request → approval by someone else → logical execution + certificate
-- -----------------------------------------------------------------------------
create function api.request_disposition(p_case_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_case case_mgmt.case_record;
  v_schedule uuid;
  v_id uuid;
begin
  if not authz.can_view_records(p_case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_request_disposition(p_case_id) then perform api._fail('FORBIDDEN'); end if;
  select * into v_case from case_mgmt.case_record c where c.id = p_case_id for update;
  if v_case.records_state = 'DISPOSED' then perform api._fail('CONFLICT', 'RECORDS_DISPOSED'); end if;
  perform records.assert_no_active_hold(p_case_id);
  if v_case.records_state <> 'DISPOSITION_ELIGIBLE' then perform api._fail('CONFLICT', 'NOT_ELIGIBLE'); end if;
  select s.id into v_schedule from records.retention_schedule s
    join records.retention_class k on k.code = s.retention_class
   where s.case_id = p_case_id and s.superseded_at is null and k.status = 'CONFIGURED' and k.category = 'TEMPORARY'
     and s.retain_until <= clock_timestamp();
  if v_schedule is null then perform api._fail('CONFLICT', 'NOT_ELIGIBLE'); end if;

  insert into records.disposition_request (case_id, retention_schedule_id, requested_by)
  values (p_case_id, v_schedule, v_actor) returning id into v_id;
  update case_mgmt.case_record c
     set records_state = 'DISPOSITION_PENDING', updated_at = now(), updated_by = v_actor, row_version = c.row_version + 1
   where c.id = p_case_id;
  perform audit.record_event('DISPOSITION_REQUESTED', 'BUSINESS', 'SUCCESS', p_case_id, 'disposition_request', v_id::text, null,
    jsonb_build_object('retention_schedule_id', v_schedule, 'retention_class', v_case.retention_class));
  return v_id;
end;
$$;

create function api.decide_disposition(p_request_id uuid, p_approve boolean, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_req records.disposition_request;
  v_reason text;
begin
  select * into v_req from records.disposition_request r where r.id = p_request_id;
  if v_req.id is null or not authz.can_view_records(v_req.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not authz.can_approve_disposition(v_req.case_id) then perform api._fail('FORBIDDEN'); end if;
  if v_req.requested_by = v_actor then perform api._fail('FORBIDDEN'); end if;  -- dual control (REC-T31)
  perform 1 from case_mgmt.case_record c where c.id = v_req.case_id for update;
  select * into v_req from records.disposition_request r where r.id = p_request_id for update;
  if v_req.status <> 'PENDING' then perform api._fail('CONFLICT', 'REQUEST_NOT_PENDING'); end if;
  if p_approve is null then perform api._fail('INVALID', 'approve'); end if;
  v_reason := api._require_text(p_reason, 'reason', 10, 2000);
  if p_approve then perform records.assert_no_active_hold(v_req.case_id); end if;

  update records.disposition_request
     set status = case when p_approve then 'APPROVED' else 'REJECTED' end,
         decided_by = v_actor, decided_at = now(), decision_reason = v_reason
   where id = p_request_id;
  if not p_approve then
    update case_mgmt.case_record c
       set records_state = 'RETENTION', updated_at = now(), updated_by = v_actor, row_version = c.row_version + 1
     where c.id = v_req.case_id;
  end if;
  perform audit.record_event(case when p_approve then 'DISPOSITION_APPROVED' else 'DISPOSITION_REJECTED' end,
    'BUSINESS', 'SUCCESS', v_req.case_id, 'disposition_request', p_request_id::text,
    case when p_approve then 'APPROVED' else 'REJECTED' end,
    jsonb_build_object('requested_by', v_req.requested_by));
end;
$$;

-- Canonical certificate payload: everything the certificate attests except its own hash.
-- Timestamps are rendered in UTC so the hash does not depend on the session time zone.
create function records.certificate_payload(p records.disposition_certificate)
returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'certificate_number', p.certificate_number, 'disposition_request_id', p.disposition_request_id,
    'case_id', p.case_id, 'case_number', p.case_number, 'retention_class', p.retention_class,
    'trigger_event', p.trigger_event, 'trigger_at', p.trigger_at at time zone 'UTC', 'retain_until', p.retain_until at time zone 'UTC',
    'requested_by', p.requested_by, 'requested_at', p.requested_at at time zone 'UTC', 'approved_by', p.approved_by,
    'approved_at', p.approved_at at time zone 'UTC', 'executed_by', p.executed_by, 'holds_checked_at', p.holds_checked_at at time zone 'UTC',
    'active_holds_found', p.active_holds_found, 'disposition_action', p.disposition_action,
    'execution_mode', p.execution_mode, 'evidence_manifest', p.evidence_manifest,
    'audit_event_id', p.audit_event_id, 'audit_event_hash', p.audit_event_hash, 'issued_at', p.issued_at at time zone 'UTC');
$$;

create function records.certificate_hash_of(p records.disposition_certificate)
returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(records.certificate_payload(p)::text, 'UTF8')), 'hex');
$$;

-- Logical execution only (ADR-013 D7): the case becomes DISPOSED and invisible to case roles; no row,
-- version or storage object is deleted. The hold check runs under the case lock (REC-T20, REC-T21).
create function api.execute_disposition(p_request_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_req records.disposition_request;
  v_case case_mgmt.case_record;
  v_sched records.retention_schedule;
  v_class records.retention_class;
  v_cert records.disposition_certificate;
  v_audit uuid;
begin
  select * into v_req from records.disposition_request r where r.id = p_request_id;
  if v_req.id is null or not authz.can_view_records(v_req.case_id) then perform api._fail('NOT_FOUND'); end if;
  if not (authz.can_request_disposition(v_req.case_id) or authz.can_approve_disposition(v_req.case_id)) then
    perform api._fail('FORBIDDEN');
  end if;
  select * into v_case from case_mgmt.case_record c where c.id = v_req.case_id for update;
  select * into v_req from records.disposition_request r where r.id = p_request_id for update;
  perform records.assert_no_active_hold(v_req.case_id);
  if v_req.status <> 'APPROVED' then perform api._fail('CONFLICT', 'REQUEST_NOT_APPROVED'); end if;
  if v_case.records_state <> 'DISPOSITION_PENDING' then perform api._fail('CONFLICT', 'RECORDS_STATE'); end if;
  select * into v_sched from records.retention_schedule s where s.id = v_req.retention_schedule_id;
  select * into v_class from records.retention_class k where k.code = v_sched.retention_class;
  if v_class.status <> 'CONFIGURED' or v_sched.retain_until is null or v_sched.retain_until > clock_timestamp() then
    perform api._fail('CONFLICT', 'NOT_ELIGIBLE');
  end if;

  update records.disposition_request set status = 'EXECUTED', executed_by = v_actor, executed_at = now()
   where id = p_request_id;
  update case_mgmt.case_record c
     set records_state = 'DISPOSED', updated_at = now(), updated_by = v_actor, row_version = c.row_version + 1
   where c.id = v_case.id;
  v_audit := audit.record_event('DISPOSITION_EXECUTED', 'BUSINESS', 'SUCCESS', v_case.id, 'disposition_request',
    p_request_id::text, 'LOGICAL_ONLY',
    jsonb_build_object('retention_class', v_class.code, 'disposition_action', v_class.disposition_action,
                       'execution_mode', 'LOGICAL_ONLY'));

  v_cert.id := gen_random_uuid();
  v_cert.certificate_number := records.next_number('CDF-DISP');
  v_cert.disposition_request_id := p_request_id;
  v_cert.case_id := v_case.id;
  v_cert.case_number := v_case.case_number;
  v_cert.retention_class := v_class.code;
  v_cert.trigger_event := v_sched.trigger_event;
  v_cert.trigger_at := v_sched.trigger_at;
  v_cert.retain_until := v_sched.retain_until;
  v_cert.requested_by := v_req.requested_by;
  v_cert.requested_at := v_req.requested_at;
  v_cert.approved_by := v_req.decided_by;
  v_cert.approved_at := v_req.decided_at;
  v_cert.executed_by := v_actor;
  v_cert.holds_checked_at := date_trunc('microseconds', clock_timestamp());
  v_cert.active_holds_found := 0;
  v_cert.disposition_action := v_class.disposition_action;
  v_cert.execution_mode := 'LOGICAL_ONLY';
  -- Version ids and SHA-256 values only, never content or object keys (§83).
  v_cert.evidence_manifest := coalesce((
    select jsonb_agg(jsonb_build_object('evidence_id', e.id, 'version_id', v.id, 'sha256', v.sha256, 'status', v.status)
                     order by e.sequence_no, v.version_no)
      from evidence.evidence e join evidence.evidence_version v on v.evidence_id = e.id
     where e.case_id = v_case.id), '[]'::jsonb);
  v_cert.audit_event_id := v_audit;
  select e.event_hash into v_cert.audit_event_hash from audit.audit_event e where e.event_id = v_audit;
  v_cert.issued_at := date_trunc('microseconds', clock_timestamp());
  v_cert.certificate_hash := records.certificate_hash_of(v_cert);
  insert into records.disposition_certificate select v_cert.*;

  perform audit.record_event('DISPOSITION_CERTIFICATE_ISSUED', 'BUSINESS', 'SUCCESS', v_case.id, 'disposition_certificate',
    v_cert.id::text, null,
    jsonb_build_object('certificate_number', v_cert.certificate_number, 'certificate_hash', v_cert.certificate_hash,
                       'evidence_versions', jsonb_array_length(v_cert.evidence_manifest)));
  return v_cert.id;
end;
$$;

-- Recomputes a certificate's hash from its stored fields (tamper evidence for auditors).
create function api.verify_disposition_certificate(p_certificate_id uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare v records.disposition_certificate;
begin
  select * into v from records.disposition_certificate c where c.id = p_certificate_id;
  if v.id is null or not authz.can_view_records(v.case_id) then perform api._fail('NOT_FOUND'); end if;
  return v.certificate_hash = records.certificate_hash_of(v);
end;
$$;

-- -----------------------------------------------------------------------------
-- Records view (definer function, because records staff cannot read case_record under RLS).
-- Metadata only: never title, summary, people or allegations (REC-T38, REC-T45).
-- -----------------------------------------------------------------------------
create function api.list_records(p_records_state text default null, p_case_id uuid default null)
returns table (
  case_id uuid, case_number text, case_type text, classification core.classification_level, records_state text,
  retention_class text, retention_class_status text, legal_hold_status text, closed_at timestamptz,
  retain_until timestamptz, open_request_id uuid, open_request_status text, open_request_requested_by uuid,
  certificate_id uuid
)
language sql stable security definer
set search_path = ''
as $$
  select c.id, c.case_number, c.case_type, c.classification, c.records_state, c.retention_class, k.status,
         c.legal_hold_status, c.closed_at, s.retain_until, r.id, r.status, r.requested_by, dc.id
  from case_mgmt.case_record c
  join records.retention_class k on k.code = c.retention_class
  left join records.retention_schedule s on s.case_id = c.id and s.superseded_at is null
  left join records.disposition_request r on r.case_id = c.id and r.status in ('PENDING', 'APPROVED')
  left join records.disposition_certificate dc on dc.case_id = c.id
  where (p_records_state is null or c.records_state = p_records_state)
    and (p_case_id is null or c.id = p_case_id)
    and authz.can_view_records(c.id)
  order by c.closed_at nulls last, c.case_number;
$$;

-- -----------------------------------------------------------------------------
-- Portal status: every post-closure records state reads CLOSED to the reporter (§23).
-- -----------------------------------------------------------------------------
create or replace function public_api._public_status(p_report_id uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select case
    when r.status = 'INFO_REQUESTED' then 'INFORMATION_REQUESTED'
    when r.status in ('REFERRED_OUT', 'CLOSED_NO_ACTION', 'DUPLICATE') then 'CLOSED'
    when r.status = 'RECEIVED' then 'RECEIVED'
    when c.records_state <> 'ACTIVE' then 'CLOSED'
    else 'IN_PROGRESS'
  end
  from intake.report r
  left join case_mgmt.case_record c on c.id = r.case_id
  where r.id = p_report_id;
$$;

grant execute on function
  api.place_legal_hold(uuid, text, uuid, text, text, text),
  api.request_legal_hold_release(uuid, text),
  api.decide_legal_hold_release(uuid, boolean, text),
  api.assign_retention_class(uuid, text),
  api.refresh_disposition_eligibility(),
  api.request_disposition(uuid),
  api.decide_disposition(uuid, boolean, text),
  api.execute_disposition(uuid),
  api.verify_disposition_certificate(uuid),
  api.list_records(text, uuid)
to authenticated;
