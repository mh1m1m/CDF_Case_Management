-- =============================================================================
-- 0300 Authorization core + append-only audit ledger
-- Requirements: §19, §29, §30, §74, §83; ADR-003, ADR-005
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Identity from the per-transaction security context (ADR-003 §1–2)
-- -----------------------------------------------------------------------------
create function authz.current_subject()
returns uuid
language plpgsql stable
set search_path = ''
as $$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
begin
  if v_claims is null then
    return null;
  end if;
  return (v_claims::jsonb ->> 'sub')::uuid;
exception when others then
  return null;  -- malformed context fails closed
end;
$$;
comment on function authz.current_subject() is 'Raw subject claim of the current transaction (may be inactive). Use current_user_id() for authorization.';

create function authz.current_user_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select p.id
  from iam.user_profile p
  where p.id = authz.current_subject()
    and p.status = 'ACTIVE';
$$;
comment on function authz.current_user_id() is 'Subject only if it maps to an ACTIVE user profile; revoked or suspended users get NULL (threat T18).';

create function authz.has_permission(p_permission text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from iam.user_role_assignment a
    join iam.role_permission rp on rp.role_code = a.role_code
    where a.user_id = authz.current_user_id()
      and a.status = 'ACTIVE'
      and a.effective_from <= current_date
      and (a.effective_to is null or a.effective_to >= current_date)
      and rp.permission_code = p_permission
  );
$$;

create function authz.user_has_permission(p_user_id uuid, p_permission text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from iam.user_profile p
    join iam.user_role_assignment a on a.user_id = p.id
    join iam.role_permission rp on rp.role_code = a.role_code
    where p.id = p_user_id
      and p.status = 'ACTIVE'
      and a.status = 'ACTIVE'
      and a.effective_from <= current_date
      and (a.effective_to is null or a.effective_to >= current_date)
      and rp.permission_code = p_permission
  );
$$;

create function authz.user_has_role(p_user_id uuid, p_role text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from iam.user_profile p
    join iam.user_role_assignment a on a.user_id = p.id
    where p.id = p_user_id
      and p.status = 'ACTIVE'
      and a.role_code = p_role
      and a.status = 'ACTIVE'
      and a.effective_from <= current_date
      and (a.effective_to is null or a.effective_to >= current_date)
  );
$$;

create function authz.current_roles()
returns text[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(a.role_code order by a.role_code), '{}')
  from iam.user_role_assignment a
  where a.user_id = authz.current_user_id()
    and a.status = 'ACTIVE'
    and a.effective_from <= current_date
    and (a.effective_to is null or a.effective_to >= current_date);
$$;

create function authz.current_clearance()
returns core.classification_level
language sql stable security definer
set search_path = ''
as $$
  select p.clearance from iam.user_profile p where p.id = authz.current_user_id();
$$;

grant execute on function
  authz.current_subject(), authz.current_user_id(), authz.has_permission(text),
  authz.current_roles(), authz.current_clearance()
to authenticated;
-- user_has_permission / user_has_role are for command functions only (owner context).

-- -----------------------------------------------------------------------------
-- IAM policies
-- -----------------------------------------------------------------------------
create policy role_read on iam.role for select to authenticated using (authz.current_user_id() is not null);
create policy permission_read on iam.permission for select to authenticated using (authz.current_user_id() is not null);
create policy role_permission_read on iam.role_permission for select to authenticated using (authz.current_user_id() is not null);
grant select on iam.role, iam.permission, iam.role_permission to authenticated;

-- Directory: active users may see colleagues' non-sensitive columns (needed for assignment pickers).
create policy user_profile_directory on iam.user_profile for select to authenticated
  using (authz.current_user_id() is not null);
grant select (id, email, display_name, display_name_ar, department, status) on iam.user_profile to authenticated;

-- Role assignments: own rows, or role administrators.
create policy user_role_assignment_read on iam.user_role_assignment for select to authenticated
  using (user_id = authz.current_user_id() or authz.has_permission('ROLE_ADMIN'));
grant select on iam.user_role_assignment to authenticated;

-- =============================================================================
-- Audit ledger (ADR-005)
-- =============================================================================
create table audit.audit_event (
  seq           bigint generated always as identity primary key,
  event_id      uuid not null unique,
  occurred_at   timestamptz not null,
  actor_type    text not null check (actor_type in ('USER', 'ANONYMOUS_REPORTER', 'SYSTEM')),
  actor_id      uuid,
  actor_roles   text[] not null default '{}',
  case_id       uuid,
  action        text not null check (action ~ '^[A-Z][A-Z_]{2,63}$'),
  category      text not null check (category in ('BUSINESS', 'SECURITY', 'ADMIN')),
  object_type   text check (object_type ~ '^[a-z_]{2,63}$'),
  object_id     text,
  request_id    uuid,
  reason        text check (length(reason) <= 2000),
  outcome       text not null check (outcome in ('SUCCESS', 'DENIED', 'FAILURE')),
  metadata      jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  previous_hash text check (previous_hash ~ '^[0-9a-f]{64}$'),
  event_hash    text not null check (event_hash ~ '^[0-9a-f]{64}$')
);
create index audit_event_case on audit.audit_event (case_id, seq) where case_id is not null;
create index audit_event_action on audit.audit_event (action, seq);
create index audit_event_category on audit.audit_event (category, seq);
comment on table audit.audit_event is 'Append-only, hash-chained audit ledger. metadata must never contain reporter identity, credentials or evidence content (§83).';

-- Canonical payload: a jsonb object rebuilt identically at write and verify time.
create function audit.canonical_payload(e audit.audit_event)
returns text
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'event_id', e.event_id,
    'occurred_at', to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_type', e.actor_type,
    'actor_id', e.actor_id,
    'actor_roles', to_jsonb(e.actor_roles),
    'case_id', e.case_id,
    'action', e.action,
    'category', e.category,
    'object_type', e.object_type,
    'object_id', e.object_id,
    'request_id', e.request_id,
    'reason', e.reason,
    'outcome', e.outcome,
    'metadata', e.metadata
  )::text;
$$;

create function audit.compute_hash(p_previous_hash text, p_payload text)
returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(p_previous_hash, 'GENESIS') || '|' || p_payload, 'UTF8')), 'hex');
$$;

-- The only way to write an audit event. Owner context; not granted to application roles directly:
-- command functions call it.
create function audit.record_event(
  p_action      text,
  p_category    text,
  p_outcome     text,
  p_case_id     uuid,
  p_object_type text,
  p_object_id   text,
  p_reason      text,
  p_metadata    jsonb,
  p_actor_type  text default 'USER'
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row  audit.audit_event;
  v_prev text;
begin
  -- Serialise chain extension (risk R6: acceptable at prototype scale).
  perform pg_advisory_xact_lock(7300410001);

  select e.event_hash into v_prev from audit.audit_event e order by e.seq desc limit 1;

  v_row.event_id    := gen_random_uuid();
  v_row.occurred_at := date_trunc('microseconds', clock_timestamp());
  v_row.actor_type  := p_actor_type;
  v_row.actor_id    := case when p_actor_type = 'USER' then authz.current_subject() else null end;
  v_row.actor_roles := case when p_actor_type = 'USER' then authz.current_roles() else '{}' end;
  v_row.case_id     := p_case_id;
  v_row.action      := p_action;
  v_row.category    := p_category;
  v_row.object_type := p_object_type;
  v_row.object_id   := p_object_id;
  v_row.request_id  := nullif(current_setting('cdf.request_id', true), '')::uuid;
  v_row.reason      := p_reason;
  v_row.outcome     := p_outcome;
  v_row.metadata    := coalesce(p_metadata, '{}'::jsonb);
  v_row.previous_hash := v_prev;
  v_row.event_hash  := audit.compute_hash(v_prev, audit.canonical_payload(v_row));

  insert into audit.audit_event (
    event_id, occurred_at, actor_type, actor_id, actor_roles, case_id, action, category,
    object_type, object_id, request_id, reason, outcome, metadata, previous_hash, event_hash
  ) values (
    v_row.event_id, v_row.occurred_at, v_row.actor_type, v_row.actor_id, v_row.actor_roles, v_row.case_id,
    v_row.action, v_row.category, v_row.object_type, v_row.object_id, v_row.request_id, v_row.reason,
    v_row.outcome, v_row.metadata, v_row.previous_hash, v_row.event_hash
  );
  return v_row.event_id;
end;
$$;

-- Immutability (§29, §74): reject UPDATE / DELETE / TRUNCATE for everyone, including the owner.
create function audit.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit.audit_event is append-only (% rejected)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_event_no_update before update on audit.audit_event
  for each row execute function audit.reject_mutation();
create trigger audit_event_no_delete before delete on audit.audit_event
  for each row execute function audit.reject_mutation();
create trigger audit_event_no_truncate before truncate on audit.audit_event
  for each statement execute function audit.reject_mutation();

-- Verification: returns the first broken link, or no rows when the chain is intact.
create function audit.verify_chain()
returns table (broken_seq bigint, expected_hash text, stored_hash text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  r audit.audit_event;
  v_prev text := null;
  v_expected text;
begin
  for r in select * from audit.audit_event order by seq loop
    v_expected := audit.compute_hash(v_prev, audit.canonical_payload(r));
    if r.previous_hash is distinct from v_prev or r.event_hash <> v_expected then
      broken_seq := r.seq; expected_hash := v_expected; stored_hash := r.event_hash;
      return next;
      return;
    end if;
    v_prev := r.event_hash;
  end loop;
end;
$$;

alter table audit.audit_event enable row level security;

-- Read access is permission-scoped. Case teams see the BUSINESS history of cases they can view
-- (policy added in 0600 once authz.can_view_case exists).
create policy audit_business_read on audit.audit_event for select to authenticated
  using (category in ('BUSINESS', 'ADMIN') and authz.has_permission('AUDIT_VIEW'));
create policy audit_security_read on audit.audit_event for select to authenticated
  using (category = 'SECURITY' and authz.has_permission('SECURITY_EVENT_VIEW'));
grant select on audit.audit_event to authenticated;
-- No INSERT/UPDATE/DELETE/TRUNCATE grants exist for any application role.
