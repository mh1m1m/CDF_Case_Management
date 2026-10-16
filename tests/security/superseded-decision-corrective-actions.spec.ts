// UX redesign Phase 12, slice P12-3b, migration 2096 (ADR-058; Linear CDF-230): corrective actions under a superseded
// decision (DEC-AMB-014). api.case_corrective_actions (A1) gives whoever may see the case each of its corrective
// actions, why it may not move and whether the caller may dispose of it; api.corrective_action_view (A2), replaced on
// 2090's body, gives the case team, while an action is frozen, what a disposition is checked against: the replacement
// decision and its source documents, whether the caller may name an owner, the owners a replacement may name (the seat
// basis, the coordinator's ruling 1 of 2026-10-15 06:50) and the due date a replacement takes when none is given;
// api.case_history gains a corrective action's freezing and disposition, as codes and times.
//
// sweep() runs in each state these tests build, for each caller:
//   * A1 is NOT_FOUND exactly where the caller cannot read the case. Otherwise it lists exactly the case's actions the
//     caller reads, in order, each with the values the caller's view and the tables the caller reads give (owner names
//     from the directory, the supersession's time, the dispositions' links), and may_dispose as the view has it.
//   * The view is NOT_FOUND exactly where 2090's is, and without origin.replacement it equals 2090's, installed from its
//     migration text and run side by side; the case's history without the two events equals 2095's. replacement is
//     there exactly while the action is frozen, and only in the case team's origin.
//   * Each disposition is accepted by api.dispose_superseded_corrective_action, run and rolled back, exactly when the
//     caller may dispose, disposition_options offers it and, for REPLACE_WITH_NEW_ACTION, may_name_owner holds. Where
//     the caller may dispose: every source listed is accepted and the superseded decision's own document is refused;
//     may_name_owner is false exactly where the command answers RESTRICTED_CASE_AUTHORITY_REQUIRED; every owner the
//     command accepts is listed, a listed one is refused only as INVALID:owner_id, and the list is every active holder
//     of CORRECTIVE_ACTION_OWN as the directory names them; a replacement without a due date is accepted exactly when
//     default_due_date is set, which is the policy's default counted from today in Riyadh.
//   * Nothing is written: the ledger holds the same rows for this transaction after the sweep as before it.
// Every step runs through the api.* commands as `authenticated`. The owner connection installs the earlier definitions,
// reads the ground truth, writes the events a disposition recorded before 2090 (CDF-227) and lowers a clearance (no
// command writes one).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  USERS,
  caseId,
  ledgerMark,
  madeSince,
  ownerScenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import { REASON, committeeIds } from "../support/committee";
import { draftPackage, requestLegalReview, voteOnPackage, type PackageFixture } from "../support/decision";
import { outcomes } from "../support/capabilities";

type Tx = Scenario["tx"];

const FIRM = "Synthetic: the committee's documented reasoning.";
/** The first decision's document, and the replacement decision's three (the first is its primary one). */
const FIRST_SOURCE = "MEMO-DEMO-2096-01";
const REPLACEMENT_SOURCES = ["MEMO-DEMO-2096-02", "MEMO-DEMO-2096-03", "MEMO-DEMO-2096-04"];
const DISPOSAL = "Synthetic: the replacement decision's ruling on this action.";
const WORDING = {
  title: "Synthetic: revised approval controls",
  description: "Synthetic: a second approver above the revised threshold.",
};
const DISPOSITIONS = ["RE_ADOPT", "MODIFY", "WAIVE", "REPLACE_WITH_NEW_ACTION"] as const;
const REPLACE = "REPLACE_WITH_NEW_ACTION";
const FROZEN = "FROZEN_BY_SUPERSEDED_DECISION";
/** A corrective action's freezing and disposition in the case's history (migration 2096). */
const EVENTS = ["CORRECTIVE_ACTION_FROZEN", "CORRECTIVE_ACTION_DISPOSED"];
/** The case team (managers, the investigator), the action's owner, people of the committee and others. */
const CALLERS: UserKey[] = [
  "caseManager",
  "grcDirector",
  "grcDeputy",
  "investigatorB",
  "investigatorA",
  "lead",
  "financeEmployee",
  "employeeB",
  "committeeSecretary",
  "committeeChair",
  "legalB",
  "platformAdmin",
  "internalAudit",
  "revoked",
];
const EVERYONE = Object.keys(USERS) as UserKey[];

let caseA: string, caseB: string, ic: string;

beforeAll(async () => {
  caseA = await caseId("0001");
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
});

interface Source {
  position: number;
  reference: string;
  is_primary: boolean;
}
interface Candidate {
  user_id: string;
  display_name: string | null;
  display_name_ar: string | null;
}
interface Replacement {
  decision_id: string;
  sources: Source[];
  may_name_owner: boolean;
  owner_candidates: Candidate[];
  default_due_date: string | null;
}
interface Origin {
  source: string;
  recommendation_item_id: string | null;
  preliminary_proposal_id: string | null;
  authority_decision_id: string | null;
  governing_decision_id: string | null;
  decision_block: string | null;
  disposition_options: string[];
  replacement?: Replacement | null;
}
interface View {
  action_id: string;
  action_type: string;
  sequence_no: number;
  title: string;
  status: string;
  due_date: string;
  percent_complete: number;
  version_no: number;
  owner: Record<string, unknown> & { accountable_user_id: string | null };
  origin: Origin | null;
  capabilities: Record<string, boolean>;
  events: Record<string, unknown>[];
}
interface Listed {
  action_id: string;
  decision_block: string | null;
  may_dispose: boolean;
  replaced_by_action_id: string | null;
  replaces_action_id: string | null;
  [key: string]: unknown;
}
interface HistoryRow {
  seq: string;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_name_ar: string | null;
  subject_name: string | null;
  subject_name_ar: string | null;
  reason: string | null;
  detail: unknown;
}

const claims = (user: UserKey) => JSON.stringify({ sub: USERS[user], role: "authenticated" });
const lit = (v: string | null) => (v === null ? "null" : `'${v.replace(/'/g, "''")}'`);
/** Every scalar in a JSON value, at any depth. */
const leaves = (v: unknown): unknown[] =>
  v !== null && typeof v === "object" ? Object.values(v).flatMap(leaves) : [v];

/** One read's answer: its value, or the error it raised; the transaction stays usable. */
async function attempt<T>(s: Scenario, run: (tx: Tx) => Promise<T>): Promise<{ value?: T; error?: string }> {
  let value: T | undefined;
  try {
    await s.tx.savepoint(async (sp) => {
      value = await run(sp as unknown as Tx);
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  return { value };
}

/** The rows of the audit ledger this scenario wrote so far (the owner reads its own transaction). */
async function ledger(s: OwnerScenario): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`
    select count(*)::int as n from audit.audit_event where request_id = current_setting('cdf.request_id')::uuid`;
  return r!.n;
}

// ---- The earlier definitions, side by side -------------------------------------------------------------------------

const MIGRATIONS = "infrastructure/supabase/migrations";

/** A function's definition from a migration, renamed into pg_temp so that it runs beside the live one. */
function earlier(file: string, head: RegExp, renamed: string): string {
  const text = readFileSync(`${MIGRATIONS}/${file}`, "utf8");
  const start = text.search(head);
  const end = text.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error(`${head.source} not found in ${file}`);
  return text.slice(start, end + "\n$$;".length).replace(head, renamed);
}

/** 2090's api.corrective_action_view and 2095's api.case_history, on the owner connection; the rollback removes them. */
async function install(s: OwnerScenario): Promise<void> {
  await s.asOwner();
  await s.tx.unsafe(
    earlier(
      "20261007002090_case_structure_corrections.sql",
      /create (?:or replace )?function api\.corrective_action_view\(p_action_id uuid\)/,
      "create function pg_temp.corrective_action_view_2090(p_action_id uuid)",
    ),
  );
  await s.tx.unsafe(
    earlier(
      "20261007002095_legal_review_and_authority_read_models.sql",
      /create (?:or replace )?function api\.case_history\(p_case_id uuid, p_limit int default 200\)/,
      "create function pg_temp.case_history_2095(p_case_id uuid, p_limit int default 200)",
    ),
  );
}

/** A view without the key 2096 adds: what 2090's api.corrective_action_view returned. */
function without2096(view: View): View {
  const v = structuredClone(view);
  if (v.origin) delete v.origin.replacement;
  return v;
}

/** AGENT-09: for this caller, the live view without 2096's key is 2090's, for every action, and the case's history
 *  without 2096's events is 2095's. */
async function sideBySide(s: OwnerScenario, user: UserKey, actions: string[], label: string): Promise<void> {
  await s.asOwner();
  await s.tx`select set_config('request.jwt.claims', ${claims(user)}, true)`;
  for (const a of actions) {
    const before = await attempt(
      s,
      (tx) => tx<{ v: View }[]>`select pg_temp.corrective_action_view_2090(${a}) as v`,
    );
    const after = await attempt(s, (tx) => tx<{ v: View }[]>`select api.corrective_action_view(${a}) as v`);
    expect(after.error, `${label}: ${user} is refused as by 2090 on ${a}`).toBe(before.error);
    if (before.error === undefined)
      expect(without2096(after.value![0]!.v), `${label}: ${user} reads 2090's view of ${a}`).toEqual(
        before.value![0]!.v,
      );
  }
  const was = await s.tx<HistoryRow[]>`select * from pg_temp.case_history_2095(${caseB}, 500)`;
  const now = await s.tx<HistoryRow[]>`select * from api.case_history(${caseB}, 500)`;
  expect(now.length, `${label}: the whole history fits`).toBeLessThan(500);
  expect(
    [...now].filter((r) => !EVENTS.includes(r.action)),
    `${label}: ${user} reads 2095's history`,
  ).toEqual([...was]);
  await s.asOwner();
}

// ---- Fixture: a decision, its corrective actions, and the decision that supersedes it --------------------------------

/** Chair and lead approve, legal rejects: the lead's vote decides. */
const decisive = (_target: string, voter: UserKey) => (voter === "legal" ? "REJECT" : "APPROVE");

/** The CEO's decision, recorded now by the secretary from `source` and `more` documents. */
const decide = (
  s: Scenario,
  f: PackageFixture,
  outcome: string,
  source: string,
  more: string[] | null,
  items?: unknown,
) =>
  s.tx<{ id: string }[]>`
    select api.record_authority_decision(${f.pkg}, 'CEO', ${outcome}, now(), 'Authority (synthetic)', ${source},
      ${items ? s.tx.json(items as never) : null}::jsonb, ${REASON}, null::text, null::text, null::text,
      ${more}::text[], null::jsonb) as id`;

/** Legal review by legalB, then the secretary submits the package to the authority. */
async function toAuthority(s: Scenario, f: PackageFixture): Promise<void> {
  const { request } = await requestLegalReview(s, f);
  await s.as("legalB");
  await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
  await s.as("committeeSecretary");
  await s.tx`select api.submit_to_authority(${f.pkg})`;
}

/** Two implementation owners; the package adopted by the lead's vote and decided by the CEO from FIRST_SOURCE. */
async function decided(s: OwnerScenario): Promise<{ f: PackageFixture; d1: string }> {
  await s.as("platformAdmin");
  for (const u of [USERS.financeEmployee, USERS.employeeB])
    await s.tx`select api.grant_role(${u}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner for the test')`;
  const f = await draftPackage(s, ic, caseB);
  expect(await voteOnPackage(s, f, decisive)).toBe("ADOPTED");
  await toAuthority(s, f);
  await s.as("committeeSecretary");
  const [d] = await decide(s, f, "APPROVE_AS_RECOMMENDED", FIRST_SOURCE, null);
  return { f, d1: d!.id };
}

/** The case manager opens the corrective item's action, owned by financeEmployee. */
async function openAction(s: Scenario, f: PackageFixture): Promise<string> {
  await s.as("caseManager");
  const [a] = await s.tx<{ id: string }[]>`
    select api.open_corrective_action(${f.corrective}, 'Synthetic: strengthen approval controls',
      'Synthetic: add a second approver to payments above the threshold.', ${USERS.financeEmployee},
      (now() at time zone 'Asia/Riyadh')::date + 5) as id`;
  return a!.id;
}

/** The lead's conflict comes to light and is upheld; the committee votes again without the lead and adopts; after a
 *  legal review the CEO decides round two from REPLACEMENT_SOURCES, approving everything or with `items`. Every action
 *  of the first decision is then frozen. Returns the replacement decision. */
async function supersede(s: Scenario, f: PackageFixture, items?: unknown): Promise<string> {
  await s.as("legal");
  const [c] = await s.tx<{ id: string }[]>`
    select api.raise_meeting_conflict(${f.meeting.participant.lead!}, 'Synthetic: the lead is related to the subject.') as id`;
  await s.as("committeeChair");
  await s.tx`select api.decide_meeting_conflict(${c!.id}, 'UPHELD', 'Synthetic: the relationship is confirmed.')`;
  await s.as("committeeSecretary");
  await s.tx`select api.resolve_conflict_taint(${f.sanction}, 'RE_VOTE', ${FIRM})`;
  await s.tx`select api.open_package_vote(${f.meeting.meeting}, ${f.pkg})`;
  const [vi] = await s.tx<{ id: string }[]>`
    select vi.id from committee.vote_item vi
    join decision.recommendation_package p on p.id = vi.package_id and vi.package_round = p.round_no
    where p.id = ${f.pkg}`;
  for (const u of ["committeeChair", "legal"] as const) {
    await s.as(u);
    await s.tx`select api.cast_vote(${vi!.id}, 'APPROVE', null)`;
  }
  await s.as("committeeSecretary");
  await s.tx`select api.close_vote_item(${vi!.id}, null)`;
  await s.tx`select api.record_package_adoption(${f.pkg})`;
  await toAuthority(s, f);
  await s.as("committeeSecretary");
  const [d2] = await decide(
    s,
    f,
    items ? "APPROVE_PARTIALLY" : "APPROVE_AS_RECOMMENDED",
    REPLACEMENT_SOURCES[0]!,
    REPLACEMENT_SOURCES.slice(1),
    items,
  );
  return d2!.id;
}

/** The disposition command's call, as SQL for a probe. */
function disposeSql(
  action: string,
  disposition: string,
  source: string,
  o: { owner?: string | null; due?: number | null } = {},
): string {
  const worded = disposition === "MODIFY" || disposition === REPLACE;
  const due =
    o.due === undefined || o.due === null
      ? "null::date"
      : `(now() at time zone 'Asia/Riyadh')::date + ${o.due}`;
  return `select api.dispose_superseded_corrective_action(${lit(action)}::uuid, ${lit(disposition)}, ${lit(source)}, ${lit(
    DISPOSAL,
  )}, ${lit(worded ? WORDING.title : null)}::text, ${lit(worded ? WORDING.description : null)}::text, ${lit(
    o.owner ?? null,
  )}::uuid, ${due})`;
}

/** The replacement decision's disposition, recorded by `as`. */
async function dispose(
  s: Scenario,
  action: string,
  disposition: string,
  o: { source?: string; owner?: UserKey; due?: number | null; as?: UserKey } = {},
): Promise<string> {
  await s.as(o.as ?? "caseManager");
  const [r] = await s.tx.unsafe<{ id: string }[]>(
    disposeSql(action, disposition, o.source ?? REPLACEMENT_SOURCES[0]!, {
      owner: o.owner ? USERS[o.owner] : null,
      due: o.due ?? null,
    }) + " as id",
  );
  return r!.id;
}

// ---- The sweep -----------------------------------------------------------------------------------------------------

interface Truth {
  actions: string[];
  /** The decision now in force that superseded each superseded decision (the chain followed). */
  final: (decision: string) => string;
  /** Each decision's primary document. */
  primary: Map<string, string>;
  /** Every active holder of CORRECTIVE_ACTION_OWN, as the list orders them, with the directory's names. */
  holders: Candidate[];
  /** The due date a replacement takes from the policy in force, or null. */
  defaultDue: string | null;
}

/** The ground truth, read as the table owner. */
async function truth(s: OwnerScenario): Promise<Truth> {
  await s.asOwner();
  const actions = (
    await s.tx<{ id: string }[]>`
      select id from decision.corrective_action where case_id = ${caseB} order by created_at, id`
  ).map((r) => r.id);
  const by = new Map(
    (
      await s.tx<{ decision_id: string; superseded_by: string }[]>`
        select decision_id, superseded_by from decision.authority_decision_supersession where case_id = ${caseB}`
    ).map((r) => [r.decision_id, r.superseded_by]),
  );
  const final = (decision: string) => {
    let d = decision;
    for (let i = 0; i < 100 && by.has(d); i++) d = by.get(d)!;
    return d;
  };
  const primary = new Map(
    (
      await s.tx<{ decision_id: string; reference: string }[]>`
        select x.decision_id, x.reference from decision.authority_decision_source x
        join decision.authority_decision d on d.id = x.decision_id
        where d.case_id = ${caseB} and x.position = 1`
    ).map((r) => [r.decision_id, r.reference]),
  );
  const holders = await s.tx<Candidate[]>`
    select u.id as user_id, u.display_name, u.display_name_ar from iam.user_profile u
    where u.status = 'ACTIVE' and exists (
      select 1 from iam.user_role_assignment a join iam.role_permission rp on rp.role_code = a.role_code
      where a.user_id = u.id and a.status = 'ACTIVE' and a.effective_from <= current_date
        and (a.effective_to is null or a.effective_to >= current_date)
        and rp.permission_code = 'CORRECTIVE_ACTION_OWN')
    order by u.display_name collate "C", u.id`;
  const [p] = await s.tx<{ d: string | null }[]>`
    select to_char((now() at time zone 'Asia/Riyadh')::date + p.default_due_days, 'YYYY-MM-DD') as d
    from decision.corrective_action_policy p
    where p.action_type = 'CORRECTIVE_ACTION' and p.effective_from <= now()
      and (p.effective_to is null or p.effective_to > now())
    order by p.effective_from desc limit 1`;
  return { actions, final, primary, holders: [...holders], defaultDue: p?.d ?? null };
}

interface Seen {
  list: Listed[] | null;
  views: Map<string, View | null>;
}

/** A1 and the view as `user` reads them, each checked against what the caller reads in the tables. */
async function read(s: OwnerScenario, user: UserKey, t: Truth, label: string): Promise<Seen> {
  await s.as(user);
  const seesCase = (await s.tx`select id from case_mgmt.case_record where id = ${caseB}`).length === 1;
  const views = new Map<string, View | null>();
  for (const a of t.actions) {
    const visible = (await s.tx`select id from decision.corrective_action where id = ${a}`).length === 1;
    const r = await attempt(s, (tx) => tx<{ v: View }[]>`select api.corrective_action_view(${a}) as v`);
    if (visible) expect(r.error, `${label}: ${user} reads the view of ${a}`).toBeUndefined();
    else expect(r.error, `${label}: ${user} gets NOT_FOUND for ${a}`).toMatch(/^CDF_NOT_FOUND/);
    const v = r.error === undefined ? r.value![0]!.v : null;
    views.set(a, v);
    if (!v) continue;
    // replacement: exactly while frozen, and only in the case team's origin.
    if (v.origin) {
      expect(v.origin.replacement === null, `${label}: ${user} replacement of ${a}`).toBe(
        v.origin.decision_block !== FROZEN,
      );
      if (v.origin.replacement) {
        const [src] = await s.tx<{ sources: Source[] }[]>`
          select coalesce(jsonb_agg(jsonb_build_object('position', x.position, 'reference', x.reference,
                   'is_primary', x.is_primary) order by x.position), '[]'::jsonb) as sources
          from decision.authority_decision_source x where x.decision_id = ${v.origin.replacement.decision_id}`;
        expect(v.origin.replacement.sources, `${label}: ${user} reads the sources of ${a}`).toEqual(
          src!.sources,
        );
      }
    } else {
      expect(JSON.stringify(v), `${label}: ${user} has no replacement on the card`).not.toContain(
        '"replacement"',
      );
    }
  }

  const list = await attempt(
    s,
    (tx) => tx<{ v: Listed[] }[]>`select api.case_corrective_actions(${caseB}) as v`,
  );
  if (!seesCase) {
    expect(list.error, `${label}: ${user} gets NOT_FOUND for the list`).toMatch(/^CDF_NOT_FOUND/);
    return { list: null, views };
  }
  expect(list.error, `${label}: ${user} reads the list`).toBeUndefined();
  const rows = list.value![0]!.v;
  const readable = (
    await s.tx<{ id: string }[]>`
      select id from decision.corrective_action where case_id = ${caseB} order by created_at, id`
  ).map((r) => r.id);
  expect(
    rows.map((r) => r.action_id),
    `${label}: ${user} lists the case's actions`,
  ).toEqual(readable);
  for (const row of rows) {
    const v = views.get(row.action_id)!;
    const governing = v.origin!.governing_decision_id;
    const [x] = await s.tx<{ at: string | null; by: string | null; of: string | null }[]>`
      select (select to_jsonb(y.superseded_at) #>> '{}' from decision.authority_decision_supersession y
              where y.decision_id = ${governing}::uuid) as at,
             (select y.replacement_action_id from decision.corrective_action_disposition y
              where y.action_id = ${row.action_id} and y.replacement_action_id is not null
              order by y.recorded_at desc, y.id desc limit 1) as by,
             (select y.action_id from decision.corrective_action_disposition y
              where y.replacement_action_id = ${row.action_id}
              order by y.recorded_at desc, y.id desc limit 1) as of`;
    const [dir] = await s.tx<{ display_name: string | null; display_name_ar: string | null }[]>`
      select display_name, display_name_ar from iam.user_profile where id = ${v.owner.accountable_user_id}::uuid`;
    expect(
      {
        ...row,
        superseded_at:
          row.superseded_at === null ? null : new Date(row.superseded_at as string).toISOString(),
      },
      `${label}: ${user} lists ${row.action_id} as the view and the tables give it`,
    ).toEqual({
      action_id: v.action_id,
      action_type: v.action_type,
      sequence_no: v.sequence_no,
      title: v.title,
      status: v.status,
      due_date: v.due_date,
      percent_complete: v.percent_complete,
      version_no: v.version_no,
      owner: {
        ...v.owner,
        display_name: dir?.display_name ?? null,
        display_name_ar: dir?.display_name_ar ?? null,
      },
      source: v.origin!.source,
      recommendation_item_id: v.origin!.recommendation_item_id,
      preliminary_proposal_id: v.origin!.preliminary_proposal_id,
      authority_decision_id: v.origin!.authority_decision_id,
      governing_decision_id: governing,
      decision_block: v.origin!.decision_block,
      superseded_at: x!.at === null ? null : new Date(x!.at).toISOString(),
      replaced_by_action_id: x!.by,
      replaces_action_id: x!.of,
      may_dispose: v.capabilities.may_dispose,
    });
  }
  return { list: rows, views };
}

/** What the disposition command answers `user` for action `a`, run and rolled back, against the view's answers. With
 *  `everyOwner`, a replacement is tried with every user as its owner; otherwise with the two implementation owners (the
 *  command checks an owner against the case, never the action, so one action per caller and state names everyone). */
async function commands(
  s: OwnerScenario,
  user: UserKey,
  a: string,
  v: View | null,
  t: Truth,
  label: string,
  everyOwner: boolean,
) {
  const r = v?.origin?.replacement ?? null;
  const may = v?.capabilities.may_dispose ?? false;
  const options = v?.origin?.disposition_options ?? [];
  const source = r?.sources[0]?.reference ?? "MEMO-PROBE-2096";
  const owners: UserKey[] = !may
    ? ["financeEmployee"]
    : everyOwner
      ? EVERYONE
      : ["financeEmployee", "employeeB"];
  const probes: Record<string, string> = {};
  for (const d of DISPOSITIONS) if (d !== REPLACE) probes[d] = disposeSql(a, d, source);
  for (const u of owners) probes[`owner:${u}`] = disposeSql(a, REPLACE, source, { owner: USERS[u], due: 10 });
  if (r) {
    for (const x of r.sources) probes[`source:${x.reference}`] = disposeSql(a, "WAIVE", x.reference);
    probes.superseded = disposeSql(a, "WAIVE", t.primary.get(v!.origin!.governing_decision_id!)!);
    probes.undated = disposeSql(a, REPLACE, source, { owner: USERS.financeEmployee });
  }
  const o = await outcomes(s, user, probes);
  const ok = (k: string) => o[k] === true;
  const nameOk = r?.may_name_owner ?? false;

  // Each disposition: accepted exactly when offered to this caller.
  for (const d of DISPOSITIONS) {
    const accepted = d === REPLACE ? owners.some((u) => ok(`owner:${u}`)) : ok(d);
    expect(accepted, `${label}: ${user} ${d} on ${a}`).toBe(
      may && options.includes(d) && (d !== REPLACE || nameOk),
    );
  }
  if (!r) return;
  expect(r.decision_id, `${label}: the replacement decision of ${a}`).toBe(
    t.final(v!.origin!.governing_decision_id!),
  );
  // Any listed document is accepted; the superseded decision's own is not.
  for (const x of r.sources)
    expect(ok(`source:${x.reference}`), `${label}: ${user} cites ${x.reference}`).toBe(may);
  if (may)
    expect(o.superseded, `${label}: ${user} cites the superseded decision`).toBe(
      "CDF_INVALID:source_document_reference",
    );
  expect(r.default_due_date, `${label}: the default due date of ${a}`).toBe(t.defaultDue);
  // may_name_owner: for a manager who may dispose, false exactly where the command refuses to let them name one.
  if (!may) expect(r.may_name_owner, `${label}: ${user} may not name an owner`).toBe(false);
  else if (options.includes(REPLACE))
    expect(r.may_name_owner, `${label}: ${user} may_name_owner on ${a}`).toBe(
      !owners.every((u) => o[`owner:${u}`] === "CDF_CONFLICT:RESTRICTED_CASE_AUTHORITY_REQUIRED"),
    );
  if (may && options.includes(REPLACE) && r.may_name_owner) {
    // The seat basis (ruling 1): every holder, as the directory names them; the command answers for the case gate.
    expect(r.owner_candidates, `${label}: ${user} owner candidates for ${a}`).toEqual(t.holders);
    for (const u of owners) {
      const listed = r.owner_candidates.some((c) => c.user_id === USERS[u]);
      if (ok(`owner:${u}`)) expect(listed, `${label}: ${u} is accepted, so listed`).toBe(true);
      else if (listed)
        expect(o[`owner:${u}`], `${label}: ${u} is listed and refused`).toBe("CDF_INVALID:owner_id");
    }
    expect(ok("owner:financeEmployee"), `${label}: the fixture's owner is eligible`).toBe(true);
    expect(o.undated, `${label}: ${user} replaces ${a} without a due date`).toBe(
      t.defaultDue === null ? "CDF_INVALID:due_date" : true,
    );
  } else {
    expect(r.owner_candidates, `${label}: ${user} gets no owner candidates for ${a}`).toEqual([]);
  }
}

/** Every caller in this state: reads, the commands' answers, and the earlier definitions side by side. */
async function sweep(
  s: OwnerScenario,
  label: string,
  callers: UserKey[] = CALLERS,
): Promise<Map<UserKey, Seen>> {
  const before = await ledger(s);
  const t = await truth(s);
  const seen = new Map<UserKey, Seen>();
  for (const user of callers) seen.set(user, await read(s, user, t, label));
  for (const user of callers) {
    // Every owner on the first action the caller may dispose of.
    let everyOwner = true;
    for (const a of t.actions) {
      const v = seen.get(user)!.views.get(a)!;
      const may = v?.capabilities.may_dispose ?? false;
      await commands(s, user, a, v, t, label, everyOwner && may);
      if (may) everyOwner = false;
    }
  }
  for (const user of callers) await sideBySide(s, user, t.actions, label);
  expect(await ledger(s), `${label}: nothing is written`).toBe(before);
  return seen;
}

/** The freezing and disposition events of the case's history since `mark`, oldest first, as each caller reads them:
 *  the ledger's events to whoever may see the case, as codes and times only; nothing to anyone else. */
async function history(s: OwnerScenario, mark: bigint, label: string, callers: UserKey[] = CALLERS) {
  await s.asOwner();
  const recorded = await s.tx<{ seq: string; action: string }[]>`
    select e.seq::text as seq, e.action from audit.audit_event e
    where e.case_id = ${caseB} and e.action = any(${EVENTS}) and e.seq > ${mark.toString()}::bigint order by e.seq`;
  for (const user of callers) {
    await s.as(user);
    const seesCase = (await s.tx`select id from case_mgmt.case_record where id = ${caseB}`).length === 1;
    const rows = madeSince(
      [...(await s.tx<HistoryRow[]>`select * from api.case_history(${caseB}, 500)`)],
      mark,
    )
      .filter((r) => EVENTS.includes(r.action))
      .reverse();
    if (!seesCase) {
      expect(rows, `${label}: ${user} reads no history`).toEqual([]);
      continue;
    }
    expect(
      rows.map((r) => [r.seq, r.action]),
      `${label}: ${user} reads every freezing and disposition`,
    ).toEqual(recorded.map((r) => [r.seq, r.action]));
    for (const r of rows)
      expect(
        [r.actor_id, r.actor_name, r.actor_name_ar, r.subject_name, r.subject_name_ar, r.reason, r.detail],
        `${label}: ${user} reads ${r.action} as a code and a time`,
      ).toEqual([null, null, null, null, null, null, null]);
  }
  return recorded.map((r) => r.action);
}

/** The view as `user` reads it. */
async function viewOf(s: Scenario, a: string, user: UserKey = "caseManager"): Promise<View> {
  await s.as(user);
  const [r] = await s.tx<{ v: View }[]>`select api.corrective_action_view(${a}) as v`;
  return r!.v;
}

/** A1 as `user` reads it, of case B unless another case is named. */
async function listOf(s: Scenario, user: UserKey = "caseManager", of: string = caseB): Promise<Listed[]> {
  await s.as(user);
  const [r] = await s.tx<{ v: Listed[] }[]>`select api.case_corrective_actions(${of}) as v`;
  return r!.v;
}

/** A list's rows by action (actions opened in one transaction share their creation time, so ids order them). */
const byId = (rows: Listed[]) => new Map(rows.map((r) => [r.action_id, r]));

describe("api.case_corrective_actions and api.corrective_action_view (migration 2096, ADR-058)", () => {
  it("before and after the decision is superseded, and through each disposition the replacement decision makes: each read is what the caller may read, and each answer is the command's", async () => {
    await ownerScenario(async (s) => {
      const mark = await ledgerMark();
      await install(s);
      const { f, d1 } = await decided(s);
      const [a1, a2, a3, a4] = [
        await openAction(s, f),
        await openAction(s, f),
        await openAction(s, f),
        await openAction(s, f),
      ];
      // Before the conflict comes to light the owner submits a2's completion; it awaits verification.
      await s.as("financeEmployee");
      await s.tx`select api.submit_corrective_action_completion(${a2!}, 'Synthetic: done.', 'SOP-DEMO-2096')`;

      // 1. The decision in force: nothing is frozen, nothing may be disposed of, and no replacement is shown.
      let seen = await sweep(s, "decided");
      expect(seen.get("caseManager")!.list!.map((r) => [r.decision_block, r.may_dispose])).toEqual(
        Array.from({ length: 4 }, () => [null, false]),
      );
      expect((await viewOf(s, a1!)).origin).toMatchObject({ governing_decision_id: d1, replacement: null });

      // 2. Superseded: every action is frozen; the case team is told against what a disposition is checked.
      const d2 = await supersede(s, f);
      seen = await sweep(s, "frozen");
      for (const user of ["caseManager", "grcDirector"] as const)
        expect(
          seen.get(user)!.list!.map((r) => [r.decision_block, r.may_dispose]),
          user,
        ).toEqual(Array.from({ length: 4 }, () => [FROZEN, true]));
      expect(seen.get("investigatorB")!.list!.map((r) => r.may_dispose)).toEqual([
        false,
        false,
        false,
        false,
      ]);
      expect(seen.get("financeEmployee")!.list).toBeNull();
      const replacement = {
        decision_id: d2,
        sources: REPLACEMENT_SOURCES.map((reference, i) => ({
          position: i + 1,
          reference,
          is_primary: i === 0,
        })),
        may_name_owner: true,
        // Employee Chi (financeEmployee) and Employee Phi (employeeB), in the order of their names.
        owner_candidates: [
          { user_id: USERS.financeEmployee, display_name: "Employee Chi", display_name_ar: "الموظف كاي" },
          { user_id: USERS.employeeB, display_name: "Employee Phi", display_name_ar: "الموظف فاي" },
        ],
        // SOURCE_REQUIRED: the seeded policy has no default, so a replacement names its due date.
        default_due_date: null,
      };
      expect((await viewOf(s, a1!)).origin!.replacement).toEqual(replacement);
      // The investigator reads the case's answer and may not act; the owner's card has no origin at all.
      expect((await viewOf(s, a1!, "investigatorB")).origin!.replacement).toEqual({
        ...replacement,
        may_name_owner: false,
        owner_candidates: [],
      });
      expect((await viewOf(s, a1!, "financeEmployee")).origin).toBeNull();
      expect(await history(s, mark, "frozen")).toEqual(
        Array.from({ length: 4 }, () => "CORRECTIVE_ACTION_FROZEN"),
      );

      // 3. An implementation owner below the case's classification is still listed (the seat basis); the command
      //    refuses them as owner, and the sweep checks it says only that.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'INTERNAL' where id = ${USERS.employeeB}`;
      await sweep(s, "an owner below the case's classification", [
        "caseManager",
        "grcDirector",
        "investigatorB",
      ]);

      // 4. Dispositions: a1 re-adopted from a document other than the primary one, a2 modified (back to the owner from
      //    verification), a3 waived.
      await dispose(s, a1!, "RE_ADOPT", { source: REPLACEMENT_SOURCES[2] });
      await dispose(s, a2!, "MODIFY");
      await dispose(s, a3!, "WAIVE");
      seen = await sweep(s, "three disposed of");
      const rows = byId(seen.get("caseManager")!.list!);
      expect([a1, a2, a3, a4].map((a) => [rows.get(a!)!.decision_block, rows.get(a!)!.may_dispose])).toEqual([
        [null, false],
        [null, false],
        ["WAIVED_BY_SUPERSEDING_DECISION", false],
        [FROZEN, true],
      ]);
      expect((await viewOf(s, a1!)).origin).toMatchObject({ governing_decision_id: d2, replacement: null });

      // 5. A policy with a default: the replacement takes it when no due date is given.
      await s.as("grcDirector");
      await s.tx`select api.set_corrective_action_policy('CORRECTIVE_ACTION', 30, 7, 3, 'NOTE_ONLY', now(), 'APPROVED',
        ${REASON}) as id`;
      await sweep(s, "a policy with a default", [
        "caseManager",
        "grcDirector",
        "investigatorB",
        "financeEmployee",
      ]);
      const due = (await viewOf(s, a4!)).origin!.replacement!.default_due_date;
      expect(due).not.toBeNull();
      await dispose(s, a4!, REPLACE, { owner: "financeEmployee" });
      const listed = byId(await listOf(s));
      expect(listed.size).toBe(5);
      const a5 = [...listed.values()].find((r) => r.replaces_action_id === a4)!;
      expect([listed.get(a4!)!.decision_block, listed.get(a4!)!.replaced_by_action_id]).toEqual([
        "REPLACED_BY_NEW_ACTION",
        a5.action_id,
      ]);
      expect([a5.due_date, a5.governing_decision_id, a5.decision_block]).toEqual([due, d2, null]);

      // 6. Everything disposed of: nothing is frozen, nothing may be disposed of again.
      seen = await sweep(s, "all disposed of");
      expect(seen.get("caseManager")!.list!.map((r) => r.may_dispose)).toEqual([
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(await history(s, mark, "all disposed of")).toEqual([
        ...Array.from({ length: 4 }, () => "CORRECTIVE_ACTION_FROZEN"),
        ...Array.from({ length: 4 }, () => "CORRECTIVE_ACTION_DISPOSED"),
      ]);

      // 7. CDF-227 (2090), kept: the events as 2030 wrote them, still on every database that ran it, reach the owner
      //    without the disposition's reason or the replacement decision's document; the case team reads them whole.
      await s.asOwner();
      await s.tx`
        insert into decision.corrective_action_event (action_id, case_id, event_type, actor_id, note, due_date,
          source_document_reference)
        values (${a2!}, ${caseB}, 'RETURNED', ${USERS.caseManager}, ${DISPOSAL}, null, null),
               (${a3!}, ${caseB}, 'WAIVED', ${USERS.caseManager}, ${DISPOSAL}, null, ${REPLACEMENT_SOURCES[0]!})`;
      await sweep(s, "events written before 2090", ["caseManager", "financeEmployee", "investigatorB"]);
      for (const a of [a1!, a2!, a3!, a4!, a5.action_id]) {
        const card = await viewOf(s, a, "financeEmployee");
        expect(card.origin, a).toBeNull();
        expect(
          leaves(card).filter(
            (x) =>
              typeof x === "string" &&
              (x.includes(DISPOSAL) || REPLACEMENT_SOURCES.some((r) => x.includes(r))),
          ),
          `the owner's card of ${a}`,
        ).toEqual([]);
      }
      expect((await viewOf(s, a3!)).events).toContainEqual(
        expect.objectContaining({
          event_type: "WAIVED",
          note: DISPOSAL,
          source_document_reference: REPLACEMENT_SOURCES[0],
        }),
      );
    });
  });

  it("the replacement decision does not approve the item: the action may only be waived, so no owner is offered", async () => {
    await ownerScenario(async (s) => {
      const mark = await ledgerMark();
      await install(s);
      const { f } = await decided(s);
      const a1 = await openAction(s, f);
      await supersede(s, f, [
        { item_id: f.sanction, outcome: "APPROVED" },
        { item_id: f.corrective, outcome: "REJECTED" },
      ]);
      await sweep(s, "not approved");
      const v = await viewOf(s, a1);
      expect(v.origin!.disposition_options).toEqual(["WAIVE"]);
      expect(v.origin!.replacement).toMatchObject({ may_name_owner: true, owner_candidates: [] });
      await dispose(s, a1, "WAIVE");
      await sweep(s, "waived", ["caseManager", "financeEmployee"]);
      expect((await listOf(s)).map((r) => r.decision_block)).toEqual(["WAIVED_BY_SUPERSEDING_DECISION"]);
      expect(await history(s, mark, "waived")).toEqual([
        "CORRECTIVE_ACTION_FROZEN",
        "CORRECTIVE_ACTION_DISPOSED",
      ]);
    });
  });

  it("a restricted case: a manager who is not its authority may dispose of the action but not replace it; once the case's authority owns the case, they may, and only they are offered owners, themselves included", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const { f } = await decided(s);
      // The GRC Director may own an action too: the list offers its caller like anyone else, as the command accepts.
      await s.as("platformAdmin");
      await s.tx`select api.grant_role(${USERS.grcDirector}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner for the test')`;
      const a1 = await openAction(s, f);
      await supersede(s, f);
      // The GRC Director restricts the case, keeping access through the restricting officer's grant.
      await s.as("grcDirector");
      await s.tx`select api.change_case_classification(${caseB}, 'RESTRICTED', true,
        'Synthetic: restricted for the test.')`;
      let seen = await sweep(s, "restricted, no owner");
      let v = seen.get("grcDirector")!.views.get(a1)!;
      expect(v.capabilities.may_dispose).toBe(true);
      expect(v.origin!.disposition_options).toContain(REPLACE);
      expect(v.origin!.replacement).toMatchObject({ may_name_owner: false, owner_candidates: [] });
      // The case's authority takes the case: they may name the owner now.
      await s.as("grcDirector");
      await s.tx`select api.assign_case(${caseB}, ${USERS.grcDirector}, 'CASE_OWNER', ${REASON})`;
      seen = await sweep(s, "restricted, owned by its authority");
      v = seen.get("grcDirector")!.views.get(a1)!;
      expect(v.origin!.replacement!.may_name_owner).toBe(true);
      // Employee Chi, Employee Phi and GRC Director Zeta, in the order of their names.
      expect(v.origin!.replacement!.owner_candidates.map((c) => c.user_id)).toEqual([
        USERS.financeEmployee,
        USERS.employeeB,
        USERS.grcDirector,
      ]);
      await dispose(s, a1, REPLACE, { owner: "employeeB", due: 20, as: "grcDirector" });
      await sweep(s, "restricted, replaced", ["grcDirector", "caseManager", "employeeB", "financeEmployee"]);
    });
  });

  it("refusals: whoever may not see the case, an unknown or missing id, and anonymous callers; the read is stable, a security definer with an empty search path, and executable by authenticated only", async () => {
    await ownerScenario(async (s) => {
      // A case with no corrective action lists none, and a case lists only its own: once case B has an action, case A,
      // which the case manager also sees, still lists none.
      expect(await listOf(s)).toEqual([]);
      const { f } = await decided(s);
      const a = await openAction(s, f);
      expect((await listOf(s)).map((r) => r.action_id)).toEqual([a]);
      expect(await listOf(s, "caseManager", caseA)).toEqual([]);
      for (const user of [
        "financeEmployee",
        "employeeB",
        "committeeSecretary",
        "platformAdmin",
        "revoked",
      ] as const) {
        await s.as(user);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.case_corrective_actions(${caseB})`);
      }
      await s.as("caseManager");
      for (const unknown of [randomUUID(), null])
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.case_corrective_actions(${unknown}::uuid)`,
        );
      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select api.case_corrective_actions(${caseB})`);
      await s.asOwner();
      expect(
        await s.tx`
          select p.provolatile as volatility, p.prosecdef as definer, p.proconfig as config,
                 has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
                 has_function_privilege('anon', p.oid, 'execute') as anon,
                 has_function_privilege('public', p.oid, 'execute') as everyone
          from pg_proc p where p.oid = 'api.case_corrective_actions(uuid)'::regprocedure`,
      ).toEqual([
        {
          volatility: "s",
          definer: true,
          config: ['search_path=""'],
          authenticated: true,
          anon: false,
          everyone: false,
        },
      ]);
    });
  });
});
