// Capability-flag test helpers (migrations 2065, 2085 and 2095; the coordinator's conditions of 2026-10-14): what the
// real commands answer, run and rolled back; the keys migration 2085 adds to api.meeting_view, so that 2065's spec keeps
// testing 2065's keys on the live function; and the keys migration 2095 adds to api.committee_items_view, so that
// 2086's spec keeps testing 2086's keys on it.
import type { OwnerScenario, UserKey } from "./db";

/**
 * What the real commands answer for `user` now: true when the command returned, otherwise the CDF_ error it raised.
 * Each probe runs in its own subtransaction inside one DO block, so the whole set costs one round trip, and is rolled
 * back whatever it did. meeting_acting_role's check that nobody activates themself (2030), which the capabilities
 * model, is recorded as CHECK:SELF_ACTIVATION. Any other error (a constraint or trigger a capability does not model)
 * fails the test.
 */
export async function outcomes(
  s: OwnerScenario,
  user: UserKey,
  probes: Record<string, string>,
): Promise<Record<string, true | string>> {
  await s.as(user);
  await s.tx`select set_config('cdf.test_probes', ${JSON.stringify(probes)}, true)`;
  await s.tx.unsafe(`
    do $probe$
    declare
      v_probe record;
      v_out jsonb := '{}'::jsonb;
      v_table text;
      v_constraint text;
    begin
      for v_probe in select key, value from jsonb_each_text(current_setting('cdf.test_probes')::jsonb) loop
        begin
          execute v_probe.value;
          raise exception 'PROBE_ACCEPTED';
        exception when others then
          get stacked diagnostics v_table = table_name, v_constraint = constraint_name;
          if sqlerrm = 'PROBE_ACCEPTED' then
            v_out := v_out || jsonb_build_object(v_probe.key, true);
          elsif left(sqlerrm, 4) = 'CDF_' then
            v_out := v_out || jsonb_build_object(v_probe.key, sqlerrm);
          elsif sqlstate = '23514' and v_table = 'meeting_acting_role' and exists (
            select 1 from pg_constraint k join pg_class r on r.oid = k.conrelid
            where r.relname = 'meeting_acting_role' and k.conname = v_constraint
              and pg_get_constraintdef(k.oid) = 'CHECK ((activated_by <> user_id))') then
            v_out := v_out || jsonb_build_object(v_probe.key, 'CHECK:SELF_ACTIVATION');
          else
            raise;
          end if;
        end;
      end loop;
      perform set_config('cdf.test_answers', v_out::text, true);
    end
    $probe$`);
  const [r] = await s.tx<{ a: string }[]>`select current_setting('cdf.test_answers') as a`;
  return JSON.parse(r!.a) as Record<string, true | string>;
}

/** outcomes() as accepted (true) or refused (false). */
export async function answers(
  s: OwnerScenario,
  user: UserKey,
  probes: Record<string, string>,
): Promise<Record<string, boolean>> {
  const o = await outcomes(s, user, probes);
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === true]));
}

// ---- api.meeting_view: the keys migration 2085 adds ----------------------------------------------------------------

/** On each roster row's capabilities. */
export const ROSTER_FLAGS_2085 = [
  "may_acknowledge_confidentiality",
  "may_activate_alternate",
  "may_declare_conflict",
  "may_declare_no_conflict",
  "may_exclude_witness",
  "may_record_accommodation",
] as const;
/** On each roster row, beside its capabilities. */
export const ROW_KEYS_2085 = ["alternate_for", "arrangements"] as const;
/** In the meeting-level capabilities. */
export const MEETING_FLAGS_2085 = [
  "may_activate_acting_chair",
  "may_activate_acting_secretary",
  "may_invite",
  "may_record_accommodation",
] as const;

interface ViewWith2085Keys {
  me?: Record<string, unknown> | null;
  roster?: (Record<string, unknown> & { capabilities?: Record<string, unknown> })[] | null;
  capabilities?: Record<string, unknown>;
  invitee_roles?: unknown;
}

/** A meeting view without the keys 2085 adds: what 2065's api.meeting_view returned. Null stays null. */
export function without2085<V>(view: V): V {
  if (view === null || view === undefined) return view;
  const v = structuredClone(view) as ViewWith2085Keys;
  if (v.me) delete v.me.accommodations;
  for (const r of v.roster ?? []) {
    for (const k of ROW_KEYS_2085) delete r[k];
    for (const f of ROSTER_FLAGS_2085) delete r.capabilities?.[f];
  }
  for (const f of MEETING_FLAGS_2085) delete v.capabilities?.[f];
  delete v.invitee_roles;
  return v as V;
}

// ---- api.committee_items_view (R2): the keys migration 2095 adds ----------------------------------------------------

/** On each package's capabilities. */
export const PACKAGE_FLAGS_2095 = [
  "may_record_authority_decision",
  "may_request_legal_review",
  "may_submit_to_authority",
] as const;
/** On each package, beside its capabilities. */
export const PACKAGE_KEYS_2095 = [
  "adopted_at",
  "authority",
  "decided_at",
  "legal_review",
  "record_block",
  "record_outcomes",
  "record_supersedes",
  "request_legal_review_block",
  "submit_block",
] as const;

interface ItemsViewWith2095Keys {
  packages?: (Record<string, unknown> & { capabilities?: Record<string, unknown> })[] | null;
}

/** R2 without the keys 2095 adds: what 2086's api.committee_items_view returned. Null stays null. */
export function without2095<V>(view: V): V {
  if (view === null || view === undefined) return view;
  const v = structuredClone(view) as ItemsViewWith2095Keys;
  for (const p of v.packages ?? []) {
    for (const k of PACKAGE_KEYS_2095) delete p[k];
    for (const f of PACKAGE_FLAGS_2095) delete p.capabilities?.[f];
  }
  return v as V;
}

// ---- api.meeting_view: the keys migration 2120 adds (ADR-048) ------------------------------------------------------

/** On each vote item, beside its capabilities. */
export const VOTE_ITEM_KEYS_2120 = ["ballots_unconfirmed_for", "my_ballot", "offline_ballots"] as const;
/** On each vote item's capabilities. */
export const VOTE_ITEM_FLAGS_2120 = ["may_confirm_ballot"] as const;

interface ViewWith2120Keys {
  logistics?: Record<string, unknown> | null;
  deliberation?: {
    vote_items?: (Record<string, unknown> & { capabilities?: Record<string, unknown> })[] | null;
  } | null;
}

/** A meeting view without the keys 2120 adds: what 2085's api.meeting_view returned. On a meeting not held offline,
 *  2120 narrows no flag, so the rest is unchanged there. Null stays null. */
export function without2120<V>(view: V): V {
  if (view === null || view === undefined) return view;
  const v = structuredClone(view) as ViewWith2120Keys;
  if (v.logistics) delete v.logistics.held_offline;
  for (const i of v.deliberation?.vote_items ?? []) {
    for (const k of VOTE_ITEM_KEYS_2120) delete i[k];
    for (const f of VOTE_ITEM_FLAGS_2120) delete i.capabilities?.[f];
  }
  return v as V;
}
