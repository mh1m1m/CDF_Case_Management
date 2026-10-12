-- =============================================================================
-- 1920 Notification engine (Business Architecture Rebase phase 8; CDF-195)
-- Requirements: §39, §48, §68, §83; owner Q&A Q29, Q41, Q90, Q92, Q98; ADR-025; AUTHORIZATION_IMPACT.md N18
--
-- Additive only. Schema `notify`:
--   template    the catalogue of notification kinds: a code, the object it points at, whether it is mandatory.
--               Wording lives in packages/i18n under the template code; nothing here is user-facing text.
--   rule        effective-dated rules in layers: SYSTEM_MANDATORY (migration only, cannot be muted),
--               COMMITTEE_DEFAULT (one committee) and EVENT_RULE (everyone), per template and channel.
--   preference  a user's mute per template and channel; refused for mandatory templates.
--   outbox      one row per recipient and channel: template code, object type and id, and a deep link. Nothing else:
--               no case number, name, allegation, narrative or evidence (§39, N18). The target page re-authorizes.
--
-- Notifications are written by triggers on the domain tables, so they commit or roll back with the domain event
-- and no existing command changes. IN_APP rows are delivered by being visible to their recipient (RLS); EMAIL rows
-- wait for the NotificationSender port, which claims and settles them through server-only functions granted to the
-- BFF login role, never to `authenticated` or `anon`. PRODUCTION_SUBSTITUTION_REQUIRED: the email adapter is a stub
-- (the CDF mail relay is a human decision) and reminders run from the prototype scheduler, not a CDF job service.
-- =============================================================================

create schema if not exists notify;
revoke all on schema notify from public;
alter default privileges in schema notify revoke all on tables from public, anon, authenticated;
alter default privileges in schema notify revoke all on sequences from public, anon, authenticated;
alter default privileges in schema notify revoke execute on functions from public, anon, authenticated;
grant usage on schema notify to authenticated;

insert into iam.permission (code, description) values
  ('NOTIFICATION_ADMIN', 'Maintain notification event rules and committee defaults; never recipients or content');
insert into iam.role_permission (role_code, permission_code) values
  ('PLATFORM_ADMIN', 'NOTIFICATION_ADMIN');

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table notify.template (
  code         text primary key check (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  object_type  text not null check (object_type in (
                 'COMMITTEE', 'MEETING', 'MINUTES', 'LEGAL_REVIEW', 'DEFENCE_NOTICE', 'GRIEVANCE')),
  is_mandatory boolean not null,
  description  text not null check (length(description) between 5 and 300)
);
comment on table notify.template is
  'Notification kinds (ADR-025). Reference data; the wording is in packages/i18n under the code. No content.';

insert into notify.template (code, object_type, is_mandatory, description) values
  ('COMMITTEE_SEAT_ASSIGNED',          'COMMITTEE',      false, 'The user was appointed to a committee seat (Q29)'),
  ('COMMITTEE_SEAT_ENDED',             'COMMITTEE',      false, 'The user''s committee seat ends (Q29)'),
  ('MEETING_INVITATION',               'MEETING',        true,  'The user takes part in a meeting and may need to declare conflicts (Q41)'),
  ('MEETING_CANCELLED',                'MEETING',        false, 'A meeting the user takes part in was cancelled'),
  ('MINUTES_REVIEW_REQUESTED',         'MINUTES',        true,  'Minutes await the user''s review (Q97)'),
  ('MINUTES_REVIEW_REMINDER',          'MINUTES',        true,  'Minutes may be deemed approved unless reviewed (Q98)'),
  ('LEGAL_REVIEW_ASSIGNED',            'LEGAL_REVIEW',   true,  'A legal review was assigned to the user (ADR-022)'),
  ('DEFENCE_NOTICE_ISSUED',            'DEFENCE_NOTICE', true,  'A defence notice awaits the subject (Q90)'),
  ('DEFENCE_DUE_REMINDER',             'DEFENCE_NOTICE', true,  'A defence response is due soon (Q90)'),
  ('GRIEVANCE_RECEIVED',               'GRIEVANCE',      false, 'A grievance awaits the Grievance Committee Secretary (Q92)'),
  ('GRIEVANCE_ADMISSIBILITY_DECIDED',  'GRIEVANCE',      true,  'The grievant''s grievance was admitted or found inadmissible (Q93)'),
  ('GRIEVANCE_OUTCOME_RECORDED',       'GRIEVANCE',      true,  'The Grievance Committee recorded its outcome (Q95)');

create table notify.rule (
  id             uuid primary key default gen_random_uuid(),
  layer          text not null check (layer in ('SYSTEM_MANDATORY', 'COMMITTEE_DEFAULT', 'EVENT_RULE')),
  template_code  text not null references notify.template (code),
  committee_id   uuid references committee.committee (id),
  channel        text not null check (channel in ('IN_APP', 'EMAIL')),
  enabled        boolean not null,
  effective_from timestamptz not null,
  effective_to   timestamptz,
  reason         text not null check (length(reason) between 5 and 2000),
  created_by     uuid references iam.user_profile (id),
  created_at     timestamptz not null default now(),
  check ((layer = 'COMMITTEE_DEFAULT') = (committee_id is not null)),
  check (effective_to is null or effective_to > effective_from),
  -- Mandatory rules come from migrations only and always deliver.
  check (layer <> 'SYSTEM_MANDATORY' or (enabled and created_by is null))
);
create unique index rule_open on notify.rule (layer, template_code, coalesce(committee_id, '00000000-0000-0000-0000-000000000000'::uuid), channel)
  where effective_to is null;
create index rule_template on notify.rule (template_code, channel);
create index rule_committee on notify.rule (committee_id);
create index rule_created_by on notify.rule (created_by);
comment on table notify.rule is
  'Effective-dated notification rules in layers (ADR-025): SYSTEM_MANDATORY, then COMMITTEE_DEFAULT, then EVENT_RULE.';

-- Mandatory templates deliver in app and by email; the others are on in app by default and off by email.
insert into notify.rule (layer, template_code, channel, enabled, effective_from, reason)
select 'SYSTEM_MANDATORY', t.code, c.channel, true, '2026-01-01T00:00:00Z', 'Synthetic default: mandatory notice (ADR-025)'
from notify.template t cross join (values ('IN_APP'), ('EMAIL')) c (channel) where t.is_mandatory;
insert into notify.rule (layer, template_code, channel, enabled, effective_from, reason)
select 'EVENT_RULE', t.code, c.channel, c.channel = 'IN_APP', '2026-01-01T00:00:00Z',
       'Synthetic default: SOURCE_REQUIRED (ADR-025)'
from notify.template t cross join (values ('IN_APP'), ('EMAIL')) c (channel) where not t.is_mandatory;

create table notify.preference (
  user_id       uuid not null references iam.user_profile (id),
  template_code text not null references notify.template (code),
  channel       text not null check (channel in ('IN_APP', 'EMAIL')),
  muted         boolean not null,
  updated_at    timestamptz not null default now(),
  primary key (user_id, template_code, channel)
);
create index preference_template on notify.preference (template_code);
comment on table notify.preference is 'A user''s own mutes (ADR-025 layer 4). Mandatory templates cannot be muted.';

create table notify.outbox (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references iam.user_profile (id),
  template_code text not null references notify.template (code),
  channel       text not null check (channel in ('IN_APP', 'EMAIL')),
  object_type   text not null check (object_type in (
                  'COMMITTEE', 'MEETING', 'MINUTES', 'LEGAL_REVIEW', 'DEFENCE_NOTICE', 'GRIEVANCE')),
  object_id     uuid not null,
  -- A path with ids only (N18): no query string, no free text.
  deep_link     text not null check (deep_link ~ '^(/[a-z0-9-]+)+$' and length(deep_link) <= 200),
  dedupe_key    text not null unique check (length(dedupe_key) <= 300),
  status        text not null check (status in ('PENDING', 'SENT', 'FAILED')),
  attempts      int not null default 0 check (attempts between 0 and 5),
  created_at    timestamptz not null default clock_timestamp(),
  delivered_at  timestamptz,
  read_at       timestamptz,
  check ((status = 'SENT') = (delivered_at is not null)),
  check (read_at is null or channel = 'IN_APP'),
  check (channel = 'EMAIL' or status = 'SENT')
);
create index outbox_recipient on notify.outbox (recipient_id, created_at desc) where channel = 'IN_APP';
create index outbox_pending on notify.outbox (created_at) where status = 'PENDING';
create index outbox_template on notify.outbox (template_code);
comment on table notify.outbox is
  'Notifications to deliver (ADR-025). Template code, object type and id, deep link. Never case content (§39, N18).';

-- The outbox keeps its facts: only delivery state and the read mark change, through the functions below.
create function notify.protect_outbox()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'notify.outbox rows cannot be deleted' using errcode = '42501';
  end if;
  if (new.id, new.recipient_id, new.template_code, new.channel, new.object_type, new.object_id, new.deep_link,
      new.dedupe_key, new.created_at)
     is distinct from
     (old.id, old.recipient_id, old.template_code, old.channel, old.object_type, old.object_id, old.deep_link,
      old.dedupe_key, old.created_at) then
    raise exception 'notify.outbox facts are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger outbox_protect before update or delete on notify.outbox
  for each row execute function notify.protect_outbox();

create function notify.protect_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' or old.layer = 'SYSTEM_MANDATORY' then
    raise exception 'notification rules are closed, never changed or deleted' using errcode = '42501';
  end if;
  if (new.id, new.layer, new.template_code, new.committee_id, new.channel, new.enabled, new.effective_from, new.reason,
      new.created_by, new.created_at)
     is distinct from
     (old.id, old.layer, old.template_code, old.committee_id, old.channel, old.enabled, old.effective_from, old.reason,
      old.created_by, old.created_at)
     or old.effective_to is not null then
    raise exception 'notification rules are closed, never changed or deleted' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger rule_protect before update or delete on notify.rule
  for each row execute function notify.protect_rule();

-- -----------------------------------------------------------------------------
-- RLS: recipients read their own in-app notifications; everyone reads the template catalogue and the rules;
-- users read their own preferences.
-- -----------------------------------------------------------------------------
alter table notify.template enable row level security;
alter table notify.rule enable row level security;
alter table notify.preference enable row level security;
alter table notify.outbox enable row level security;

create policy template_read on notify.template for select to authenticated using (authz.current_user_id() is not null);
grant select on notify.template to authenticated;
create policy rule_read on notify.rule for select to authenticated using (authz.current_user_id() is not null);
grant select on notify.rule to authenticated;
create policy preference_read on notify.preference for select to authenticated
  using (user_id = authz.current_user_id());
grant select on notify.preference to authenticated;
create policy outbox_read on notify.outbox for select to authenticated
  using (recipient_id = authz.current_user_id() and channel = 'IN_APP');
grant select on notify.outbox to authenticated;

-- -----------------------------------------------------------------------------
-- Internal helpers (not executable by any application role)
-- -----------------------------------------------------------------------------
create function notify.deep_link(p_object_type text, p_object_id uuid)
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
         end;
$$;

-- Whether a template is delivered on a channel to a user now: a mandatory rule always delivers; otherwise the
-- committee default (when one applies) or the event rule decides, and the user's mute suppresses.
create function notify.delivers(p_template text, p_channel text, p_user_id uuid, p_committee_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  with active as (
    select r.layer, r.enabled from notify.rule r
    where r.template_code = p_template and r.channel = p_channel
      and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())
      and (r.layer <> 'COMMITTEE_DEFAULT' or r.committee_id = p_committee_id)
  )
  select case
    when exists (select 1 from active where layer = 'SYSTEM_MANDATORY') then true
    when not coalesce((select enabled from active where layer = 'COMMITTEE_DEFAULT'),
                      (select enabled from active where layer = 'EVENT_RULE'), false) then false
    else not exists (select 1 from notify.preference p
                     where p.user_id = p_user_id and p.template_code = p_template and p.channel = p_channel
                       and p.muted)
  end;
$$;

-- Queues one notification per channel the rules deliver. Only ACTIVE users are notified; a repeated event with the
-- same dedupe key is ignored.
create function notify.enqueue(
  p_template text, p_recipient uuid, p_object_id uuid, p_committee_id uuid, p_dedupe text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_type text;
  v_channel text;
begin
  if p_recipient is null then return; end if;
  if not exists (select 1 from iam.user_profile u where u.id = p_recipient and u.status = 'ACTIVE') then return; end if;
  select t.object_type into strict v_type from notify.template t where t.code = p_template;
  foreach v_channel in array array['IN_APP', 'EMAIL'] loop
    if notify.delivers(p_template, v_channel, p_recipient, p_committee_id) then
      insert into notify.outbox (recipient_id, template_code, channel, object_type, object_id, deep_link, dedupe_key,
                                 status, delivered_at)
      values (p_recipient, p_template, v_channel, v_type, p_object_id, notify.deep_link(v_type, p_object_id),
              p_dedupe || ':' || p_recipient || ':' || v_channel,
              case v_channel when 'IN_APP' then 'SENT' else 'PENDING' end,
              case v_channel when 'IN_APP' then clock_timestamp() end)
      on conflict (dedupe_key) do nothing;
    end if;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Domain triggers: each notification commits with its domain event
-- -----------------------------------------------------------------------------
create function notify.on_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform notify.enqueue('COMMITTEE_SEAT_ASSIGNED', new.user_id, new.committee_id, new.committee_id,
                           'seat-assigned:' || new.id);
  elsif new.ended_at is not null and old.ended_at is null then
    perform notify.enqueue('COMMITTEE_SEAT_ENDED', new.user_id, new.committee_id, new.committee_id,
                           'seat-ended:' || new.id);
  end if;
  return null;
end;
$$;
create trigger membership_notify after insert or update on committee.membership
  for each row execute function notify.on_membership();

create function notify.meeting_committee(p_meeting_id uuid)
returns uuid
language sql stable
set search_path = ''
as $$
  select cp.committee_id from committee.meeting m
  join committee.committee_proceeding cp on cp.id = m.committee_proceeding_id where m.id = p_meeting_id;
$$;

create function notify.on_meeting_participant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform notify.enqueue('MEETING_INVITATION', new.user_id, new.meeting_id, notify.meeting_committee(new.meeting_id),
                         'meeting-invitation:' || new.id);
  return null;
end;
$$;
create trigger meeting_participant_notify after insert on committee.meeting_participant
  for each row when (new.user_id is not null) execute function notify.on_meeting_participant();

create function notify.on_meeting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if new.status = 'CANCELLED' and old.status <> 'CANCELLED' then
    for v_user in select distinct mp.user_id from committee.meeting_participant mp
                  where mp.meeting_id = new.id and mp.user_id is not null loop
      perform notify.enqueue('MEETING_CANCELLED', v_user, new.id, notify.meeting_committee(new.id),
                             'meeting-cancelled:' || new.id);
    end loop;
  end if;
  return null;
end;
$$;
create trigger meeting_notify after update on committee.meeting
  for each row execute function notify.on_meeting();

-- Minutes go to the members who may review them (committee.minutes_reviewer); the reminder only to those who have
-- not reviewed yet.
create function notify.on_minutes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if tg_op = 'INSERT' and new.status = 'IN_REVIEW' then
    for v_user in select mp.user_id from committee.meeting_participant mp
                  where mp.meeting_id = new.meeting_id and committee.minutes_reviewer(new.meeting_id, mp.user_id) loop
      perform notify.enqueue('MINUTES_REVIEW_REQUESTED', v_user, new.id, notify.meeting_committee(new.meeting_id),
                             'minutes-review:' || new.id);
    end loop;
  elsif tg_op = 'UPDATE' and new.reminder_sent_at is not null and old.reminder_sent_at is null then
    for v_user in select mp.user_id from committee.meeting_participant mp
                  where mp.meeting_id = new.meeting_id and committee.minutes_reviewer(new.meeting_id, mp.user_id)
                    and not exists (select 1 from committee.minutes_review r
                                    where r.minutes_id = new.id and r.reviewer_id = mp.user_id) loop
      perform notify.enqueue('MINUTES_REVIEW_REMINDER', v_user, new.id, notify.meeting_committee(new.meeting_id),
                             'minutes-reminder:' || new.id);
    end loop;
  end if;
  return null;
end;
$$;
create trigger minutes_notify after insert or update on committee.minutes
  for each row execute function notify.on_minutes();

create function notify.on_legal_review_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform notify.enqueue('LEGAL_REVIEW_ASSIGNED', new.assigned_to, new.id, null, 'legal-review:' || new.id);
  return null;
end;
$$;
create trigger legal_review_request_notify after insert on decision.legal_review_request
  for each row execute function notify.on_legal_review_request();

-- The subject is reached only through the active portal link the case team created (Q90).
create function notify.on_defence_notice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform notify.enqueue('DEFENCE_NOTICE_ISSUED',
    (select l.user_id from grievance.subject_portal_link l where l.subject_id = new.subject_id and l.revoked_at is null),
    new.id, null, 'defence-notice:' || new.id);
  return null;
end;
$$;
create trigger defence_notice_notify after insert on grievance.defence_notice
  for each row execute function notify.on_defence_notice();

-- A new grievance goes to the Grievance Committee's current secretaries (Q92); decisions go to a grievant who has a
-- portal account.
create function notify.on_grievance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_gc uuid := grievance.committee_id();
begin
  if tg_op = 'INSERT' then
    for v_user in select m.user_id from committee.membership m
                  where m.committee_id = v_gc and m.seat in ('SECRETARY', 'ALTERNATE_SECRETARY')
                    and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now()) loop
      perform notify.enqueue('GRIEVANCE_RECEIVED', v_user, new.id, v_gc, 'grievance-received:' || new.id);
    end loop;
  elsif new.status in ('ADMITTED', 'INADMISSIBLE') and old.status not in ('ADMITTED', 'INADMISSIBLE') then
    perform notify.enqueue('GRIEVANCE_ADMISSIBILITY_DECIDED', new.grievant_user_id, new.id, v_gc,
                           'grievance-admissibility:' || new.id);
  end if;
  return null;
end;
$$;
create trigger grievance_notify after insert or update on grievance.grievance
  for each row execute function notify.on_grievance();

create function notify.on_grievance_outcome()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform notify.enqueue('GRIEVANCE_OUTCOME_RECORDED',
    (select g.grievant_user_id from grievance.grievance g where g.id = new.grievance_id),
    new.grievance_id, grievance.committee_id(), 'grievance-outcome:' || new.id);
  return null;
end;
$$;
create trigger grievance_outcome_notify after insert on grievance.grievance_outcome
  for each row execute function notify.on_grievance_outcome();

revoke all on function
  notify.protect_outbox(), notify.protect_rule(), notify.deep_link(text, uuid),
  notify.delivers(text, text, uuid, uuid), notify.enqueue(text, uuid, uuid, uuid, text),
  notify.on_membership(), notify.meeting_committee(uuid), notify.on_meeting_participant(), notify.on_meeting(),
  notify.on_minutes(), notify.on_legal_review_request(), notify.on_defence_notice(), notify.on_grievance(),
  notify.on_grievance_outcome()
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Commands (authenticated)
-- -----------------------------------------------------------------------------
-- The caller marks one of their own in-app notifications read; anyone else's answers NOT_FOUND.
create function api.mark_notification_read(p_notification_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v notify.outbox;
begin
  select * into v from notify.outbox o
  where o.id = p_notification_id and o.recipient_id = v_actor and o.channel = 'IN_APP' for update;
  if not found then perform api._fail('NOT_FOUND'); end if;
  if v.read_at is not null then return; end if;
  update notify.outbox set read_at = now() where id = v.id;
  perform audit.record_event('NOTIFICATION_READ', 'BUSINESS', 'SUCCESS', null, 'notification', v.id::text, null,
    jsonb_build_object('template_code', v.template_code));
end;
$$;

-- The caller mutes or unmutes a template on a channel for themselves; mandatory templates cannot be muted.
create function api.set_notification_preference(p_template_code text, p_channel text, p_muted boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_t notify.template;
begin
  select * into v_t from notify.template t where t.code = p_template_code;
  if not found then perform api._fail('INVALID', 'template_code'); end if;
  if p_channel is null or p_channel not in ('IN_APP', 'EMAIL') then perform api._fail('INVALID', 'channel'); end if;
  if p_muted is null then perform api._fail('INVALID', 'muted'); end if;
  if v_t.is_mandatory and p_muted then perform api._fail('CONFLICT', 'MANDATORY_NOTIFICATION'); end if;
  insert into notify.preference (user_id, template_code, channel, muted)
  values (v_actor, p_template_code, p_channel, p_muted)
  on conflict (user_id, template_code, channel) do update set muted = excluded.muted, updated_at = now();
  perform audit.record_event('NOTIFICATION_PREFERENCE_SET', 'BUSINESS', 'SUCCESS', null, 'notification_preference',
    v_actor::text, null, jsonb_build_object('template_code', p_template_code, 'channel', p_channel, 'muted', p_muted));
end;
$$;

-- NOTIFICATION_ADMIN sets an event rule or a committee default from a moment on; the open rule it replaces is closed.
-- Mandatory rules are not reachable here.
create function api.set_notification_rule(
  p_layer text, p_template_code text, p_committee_id uuid, p_channel text, p_enabled boolean,
  p_effective_from timestamptz, p_reason text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := api._actor();
  v_id uuid;
begin
  if not authz.has_permission('NOTIFICATION_ADMIN') then perform api._fail('FORBIDDEN'); end if;
  if p_layer is null or p_layer not in ('COMMITTEE_DEFAULT', 'EVENT_RULE') then perform api._fail('INVALID', 'layer'); end if;
  if not exists (select 1 from notify.template t where t.code = p_template_code) then
    perform api._fail('INVALID', 'template_code');
  end if;
  if (p_layer = 'COMMITTEE_DEFAULT') <> (p_committee_id is not null)
     or (p_committee_id is not null and not exists (select 1 from committee.committee c where c.id = p_committee_id)) then
    perform api._fail('INVALID', 'committee_id');
  end if;
  if p_channel is null or p_channel not in ('IN_APP', 'EMAIL') then perform api._fail('INVALID', 'channel'); end if;
  if p_enabled is null then perform api._fail('INVALID', 'enabled'); end if;
  if p_effective_from is null or p_effective_from < now() then perform api._fail('INVALID', 'effective_from'); end if;
  update notify.rule r set effective_to = p_effective_from
  where r.layer = p_layer and r.template_code = p_template_code and r.channel = p_channel
    and r.committee_id is not distinct from p_committee_id and r.effective_to is null;
  insert into notify.rule (layer, template_code, committee_id, channel, enabled, effective_from, reason, created_by)
  values (p_layer, p_template_code, p_committee_id, p_channel, p_enabled, p_effective_from,
          api._require_text(p_reason, 'reason', 5, 2000), v_actor)
  returning id into v_id;
  perform audit.record_event('NOTIFICATION_RULE_SET', 'ADMIN', 'SUCCESS', null, 'notification_rule', v_id::text,
    p_reason, jsonb_build_object('layer', p_layer, 'template_code', p_template_code, 'channel', p_channel,
                                 'enabled', p_enabled, 'committee_id', p_committee_id));
  return v_id;
end;
$$;

grant execute on function
  api.mark_notification_read(uuid), api.set_notification_preference(text, text, boolean),
  api.set_notification_rule(text, text, uuid, text, boolean, timestamptz, text)
to authenticated;

-- -----------------------------------------------------------------------------
-- Server-only delivery and scheduling (the BFF login role, never authenticated or anon)
-- -----------------------------------------------------------------------------
-- The NotificationSender claims pending email notifications: recipient id, template code and deep link only.
create function notify.claim_email_batch(p_limit int)
returns table (id uuid, recipient_id uuid, template_code text, deep_link text, attempts int)
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid limit' using errcode = '22023'; end if;
  return query
  update notify.outbox o set attempts = o.attempts + 1
  where o.id in (select x.id from notify.outbox x
                 where x.status = 'PENDING' and x.channel = 'EMAIL' and x.attempts < 5
                 order by x.created_at limit p_limit for update skip locked)
  returning o.id, o.recipient_id, o.template_code, o.deep_link, o.attempts;
end;
$$;

-- Settles a claimed email: SENT, or FAILED after the fifth attempt, otherwise left PENDING for a retry.
create function notify.record_email_delivery(p_notification_id uuid, p_delivered boolean)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v notify.outbox;
begin
  select * into v from notify.outbox o
  where o.id = p_notification_id and o.channel = 'EMAIL' and o.status = 'PENDING' and o.attempts > 0 for update;
  if not found then raise exception 'unknown or settled notification' using errcode = 'P0002'; end if;
  update notify.outbox set status = case when p_delivered then 'SENT' when v.attempts >= 5 then 'FAILED' else 'PENDING' end,
                           delivered_at = case when p_delivered then now() end
  where id = v.id returning * into v;
  perform audit.record_event('NOTIFICATION_DELIVERY', 'ADMIN', case when p_delivered then 'SUCCESS' else 'FAILURE' end,
    null, 'notification', v.id::text, null, jsonb_build_object('template_code', v.template_code, 'status', v.status,
                                                               'attempts', v.attempts));
  return v.status;
end;
$$;

-- Deadline reminders (ADR-025 D4): a defence response due within two days. Idempotent per notice.
create function notify.emit_due_reminders()
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_n int := 0;
  r record;
begin
  for r in select n.id, l.user_id from grievance.defence_notice n
           join grievance.subject_portal_link l on l.subject_id = n.subject_id and l.revoked_at is null
           where n.status in ('ISSUED', 'ACKNOWLEDGED') and n.due_at > now() and n.due_at <= now() + interval '2 days'
             and not exists (select 1 from notify.outbox o where o.dedupe_key like 'defence-due:' || n.id || ':%') loop
    perform notify.enqueue('DEFENCE_DUE_REMINDER', r.user_id, r.id, null, 'defence-due:' || r.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke all on function
  notify.claim_email_batch(int), notify.record_email_delivery(uuid, boolean), notify.emit_due_reminders()
from public, anon, authenticated;
grant usage on schema notify to cdf_bff;
grant execute on function
  notify.claim_email_batch(int), notify.record_email_delivery(uuid, boolean), notify.emit_due_reminders()
to cdf_bff;
