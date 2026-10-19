// UX redesign Phase 12, slice P12-8b, migration 2127 (ADR-063; Linear CDF-266, with CDF-259 and CDF-260): the
// Administration pages' capabilities, the caller's pages and three narrowings.
//
//   * api.my_admin_views gives every user in the directory exactly the pages api.my_areas (2045) counts for the
//     ADMINISTRATION area: the area is shown exactly when the list is not empty, and its default view is the list's
//     first page. Each page is listed exactly when that page's commands accept the caller.
//   * Each of the six capability reads answers exactly the seed users its page's commands accept on their caller check,
//     run and rolled back, and refuses everyone else as the commands do: FORBIDDEN, or UNAUTHENTICATED for a user who
//     is not active. Anonymous callers reach neither.
//   * Every flag is its command's answer, for each administrator and each state the command tells apart: a calendar day
//     ahead, today, past or withdrawn; a committee with and without a rule set open to revision; a referral-approval
//     delegation in force, scheduled, revoked or ended; an export purpose in use or legacy. Each list names every row
//     of its register, in the register's order.
//   * F6 (CDF-259): api.appoint_sector_member refuses the caller appointing themselves, as a member or as head, now or
//     later, and writes nothing; anyone else is still appointed.
//   * F8 (CDF-260): api.set_notification_rule refuses a rule that would start at or before a rule of the same key
//     (layer, template, committee, channel), and writes nothing; a later start still ends the rule before it; two
//     administrators scheduling one key take turns on the key's lock.
//   * F13: api.set_export_purpose, api.set_invitee_type_rule and api.set_sanction_rule take the version the caller read
//     and refuse any other, a null included, writing nothing; a success raises it by one and records it; a new purpose
//     is created only with no version, one administrator at a time; no signature without the check remains.
//   * The reads write nothing, take no lock and run no command: they are stable, security definer with an empty search
//     path, and executable by authenticated only.
// Every step runs through the api.* commands as `authenticated`, except three states no command makes, which the owner
// writes: a calendar day already past, a delegation already ended and a committee whose rule set has ended.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, admin, ownerScenario, scenario, type OwnerScenario, type UserKey } from "../support/db";
import { committeeIds } from "../support/committee";
import { outcomes } from "../support/capabilities";

type Tx = OwnerScenario["tx"];
type Answer = true | string;

const REASON = "Synthetic: administration capability test.";
const ALL = Object.keys(USERS) as UserKey[];

/** The pages that have a capability read, with it. The users page has none: it offers no form yet. */
const READS = {
  calendar: "admin_calendar_capabilities",
  committees: "admin_committee_capabilities",
  sectors: "admin_sector_capabilities",
  "notification-rules": "admin_notification_rule_capabilities",
  "export-policy": "admin_export_policy_capabilities",
  "corrective-action-policy": "admin_corrective_action_policy_capabilities",
} as const;
type Page = keyof typeof READS;
const PAGES = Object.keys(READS) as Page[];

let ic: string, gc: string, ops: string, fin: string;
beforeAll(async () => {
  ({ ic, gc } = await committeeIds());
  const sectors = await admin<{ code: string; id: string }[]>`
    select code, id from iam.sector where code in ('OPS', 'FIN')`;
  ops = sectors.find((r) => r.code === "OPS")!.id;
  fin = sectors.find((r) => r.code === "FIN")!.id;
});

/** A code no row has: tests never commit, so nothing they add is there the next time. */
const freshCode = (prefix: string) => `${prefix}${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;

/** A start after every version of a key already recorded, so that only the caller check can refuse it. */
const after = (table: string, where: string) =>
  `(select greatest(now(), max(effective_from)) + interval '1 day' from ${table} where ${where})`;

const NOTICE_KEY =
  "layer = 'EVENT_RULE' and template_code = 'MEETING_CANCELLED' and channel = 'EMAIL' and committee_id is null";

const ruleSetSql = (committee: string, kind: string) =>
  kind === "GRIEVANCE"
    ? `select api.set_committee_rule_set('${committee}', ${after("committee.rule_set", `committee_id = '${committee}'`)},
         'MAJORITY_ELIGIBLE', null, true, 3, true, 30, 'CHAIR', 'NO_DECISION', 'SOURCE_REQUIRED', '${REASON}')`
    : `select api.set_committee_rule_set('${committee}', ${after("committee.rule_set", `committee_id = '${committee}'`)},
         'FIXED_NUMBER', 1, true, 3, true, null, null, 'NO_DECISION', 'SOURCE_REQUIRED', '${REASON}')`;
const reviseSql = (committee: string) =>
  `select api.revise_committee_rule_set('${committee}', ${after("committee.rule_set", `committee_id = '${committee}'`)},
     '{"acting_chair_casting_vote": true}'::jsonb, 'SOURCE_REQUIRED', '${REASON}')`;
const weekPatternSql = () =>
  `select api.set_business_week_pattern(array[5, 6], ${after("config.business_week_pattern", "true")}, 'SOURCE_REQUIRED',
     '${REASON}')`;
const setDaySql = (date: string) =>
  `select api.set_business_calendar_day('${date}'::date, 'HOLIDAY', 'DEMO-CAL-2127', '${REASON}')`;
const withdrawSql = (day: string) => `select api.withdraw_business_calendar_day('${day}', '${REASON}')`;
const createSectorSql = () =>
  `select api.create_sector('${freshCode("S")}', 'Synthetic sector', 'قطاع تجريبي')`;
const revokeSql = (delegation: string) =>
  `select api.revoke_referral_delegation('${delegation}', '${REASON}')`;
const noticeRuleSql = () =>
  `select api.set_notification_rule('EVENT_RULE', 'MEETING_CANCELLED', null, 'EMAIL', true, ${after("notify.rule", NOTICE_KEY)},
     '${REASON}')`;
const exportRuleSql = () =>
  `select api.set_export_rule('${freshCode("SYN_")}', 'ANY', null, 'MINUTES', false, 'NONE', now() + interval '1 day',
     'SOURCE_REQUIRED', '${REASON}')`;
const purposeSql = (code: string, version: number | null) =>
  `select api.set_export_purpose('${code}', 'Synthetic purpose', 'غرض تجريبي', ${code === "OTHER"}, true, 500, '${REASON}',
     ${version === null ? "null" : version})`;
const policySql = () =>
  `select api.set_corrective_action_policy('GOVERNANCE_REMEDIATION', null, null, null, 'REFERENCE_REQUIRED',
     ${after("decision.corrective_action_policy", "action_type = 'GOVERNANCE_REMEDIATION'")}, 'SOURCE_REQUIRED', '${REASON}')`;

/** One command of each page with inputs it accepts, so that only its caller check can refuse it. */
const pageCommands = (): Record<Page, string> => ({
  calendar: weekPatternSql(),
  committees: ruleSetSql(ic, "INVESTIGATION"),
  sectors: createSectorSql(),
  "notification-rules": noticeRuleSql(),
  "export-policy": exportRuleSql(),
  "corrective-action-policy": policySql(),
});

/** The users page's two commands (USER_ADMIN, ROLE_ADMIN), on someone other than the caller. */
async function usersPageCommands(user: UserKey): Promise<Record<string, string>> {
  const target = USERS[user === "investigatorB" ? "investigatorA" : "investigatorB"];
  const [a] = await admin<{ id: string }[]>`
    select id from iam.user_role_assignment where user_id = ${target} and status = 'ACTIVE' limit 1`;
  return {
    set_user_status: `select api.set_user_status('${target}', 'ACTIVE', '${REASON}')`,
    revoke_role: `select api.revoke_role('${a!.id}', '${REASON}')`,
  };
}

/** Act as any user in the directory, as scenario's as() does for the seed's named users. */
async function asId(s: OwnerScenario, id: string): Promise<void> {
  await s.tx`reset role`;
  await s.tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: id, role: "authenticated" })}, true)`;
  await s.tx.unsafe("set local role authenticated");
}

async function read<T>(s: OwnerScenario, user: UserKey, fn: string): Promise<T> {
  await s.as(user);
  const [r] = await s.tx.unsafe<{ v: T }[]>(`select api.${fn}() as v`);
  return r!.v;
}

async function views(s: OwnerScenario, user: UserKey): Promise<string[]> {
  await s.as(user);
  return (await s.tx<{ view_code: string }[]>`select view_code from api.my_admin_views()`).map(
    (r) => r.view_code,
  );
}

/** The audit ledger's rows written so far by this scenario (the owner reads its own transaction). */
async function ledger(s: OwnerScenario): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`
    select count(*)::int as n from audit.audit_event where request_id = current_setting('cdf.request_id')::uuid`;
  return r!.n;
}

/** The newest audit row of an action in this scenario, as the owner reads it. */
async function lastEvent(s: OwnerScenario, action: string): Promise<Record<string, unknown> | undefined> {
  await s.asOwner();
  const [r] = await s.tx<{ metadata: Record<string, unknown> }[]>`
    select metadata from audit.audit_event
     where request_id = current_setting('cdf.request_id')::uuid and action = ${action} order by seq desc limit 1`;
  return r?.metadata;
}

/** The id the query returns. */
async function one(query: PromiseLike<readonly { id: string }[]>): Promise<string> {
  const [r] = await query;
  return r!.id;
}

/** Whether session `pid` waits on the lock a command takes with pg_advisory_xact_lock(hashtext(key)); pg_locks shows
 *  its bigint key in two halves. */
const onKeyLock =
  (key: string) =>
  async (pid: number): Promise<boolean> => {
    const [r] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_locks l
       where l.pid = ${pid} and l.locktype = 'advisory' and not l.granted and l.objsubid = 1
         and ((l.classid::bigint << 32) | l.objid::bigint) = hashtext(${key})::bigint`;
    return r!.n === 1;
  };

/** Whether session `pid` waits while locking a row of `table` for update, before it has written to the table: it holds
 *  the table's ROW SHARE lock (select ... for update) and not its ROW EXCLUSIVE lock (insert, update). */
const onRowLock =
  (table: string) =>
  async (pid: number): Promise<boolean> => {
    const [r] = await admin<{ waiting: boolean; modes: string[] }[]>`
      select exists (select 1 from pg_locks w where w.pid = ${pid} and not w.granted) as waiting,
             coalesce(array_agg(l.mode::text order by l.mode) filter (where l.granted), '{}') as modes
        from pg_locks l where l.pid = ${pid} and l.locktype = 'relation' and l.relation = ${table}::regclass`;
    return r!.waiting && r!.modes.includes("RowShareLock") && !r!.modes.includes("RowExclusiveLock");
  };

/** Two platform administrators at once: `first` runs in one session, which stays open while `second` runs in another.
 *  Says whether `second` was seen waiting as `waits` describes, and what it returned once `first` was undone. Both
 *  sessions are rolled back. */
async function contend(
  first: string,
  second: string,
  waits: (pid: number) => Promise<boolean>,
): Promise<{ waited: boolean; result: unknown }> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const ran = new Promise<void>((r) => (started = r));
  const holder = scenario(async (s) => {
    await s.as("platformAdmin");
    await s.tx.unsafe(first);
    started();
    await held;
  });
  let waited = false;
  let result: unknown;
  let other: Promise<void> = Promise.resolve();
  try {
    await Promise.race([ran, holder]);
    let pid = 0;
    let known!: () => void;
    const identified = new Promise<void>((r) => (known = r));
    other = scenario(async (s) => {
      await s.as("platformAdmin");
      const [me] = await s.tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      pid = me!.pid;
      known();
      result = await s.tx.unsafe(second);
    });
    await Promise.race([identified, other]);
    for (let i = 0; i < 100 && !waited; i++) {
      waited = await waits(pid);
      if (!waited) await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    release();
    await holder;
  }
  await other;
  return { waited, result };
}

// ---- The pages -------------------------------------------------------------------------------------------------------

describe("api.my_admin_views and the six capability reads (migration 2127, ADR-063)", () => {
  it("every user in the directory: the pages are api.my_areas' Administration area, in its order; a user who is not active has none, and anonymous callers cannot ask", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const users = await s.tx<{ id: string; active: boolean }[]>`
        select id, status = 'ACTIVE' as active from iam.user_profile order by id`;
      const got = new Map<string, string[]>();
      for (const u of users) {
        await asId(s, u.id);
        const list = (await s.tx<{ view_code: string }[]>`select view_code from api.my_admin_views()`).map(
          (r) => r.view_code,
        );
        const area = await s.tx<{ default_view: string }[]>`
          select default_view from api.my_areas() where area_code = 'ADMINISTRATION'`;
        expect(list.length > 0, `${u.id}: listed pages exactly when the area is shown`).toBe(
          area.length === 1,
        );
        if (area.length === 1)
          expect(list[0], `${u.id}: the area's default view`).toBe(area[0]!.default_view);
        if (!u.active) expect(list, `${u.id} is not active`).toEqual([]);
        got.set(u.id, list);
      }
      // The seed's administrators; every other user in the directory has no page.
      const administrators: Partial<Record<UserKey, string[]>> = {
        complianceManager: ["committees"],
        grcDeputy: ["committees", "corrective-action-policy"],
        grcDirector: ["committees", "corrective-action-policy"],
        platformAdmin: ["users", "committees", "sectors", "notification-rules", "export-policy", "calendar"],
      };
      for (const [key, list] of Object.entries(administrators))
        expect(got.get(USERS[key as UserKey])).toEqual(list);
      const ids = new Set(Object.keys(administrators).map((k) => USERS[k as UserKey] as string));
      for (const [id, list] of got) if (!ids.has(id)) expect(list, id).toEqual([]);

      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select * from api.my_admin_views()`);
      for (const p of PAGES)
        await s.expectError("permission denied", (tx) => tx.unsafe(`select api.${READS[p]}()`));
    });
  });

  it("every seed user: a page's read answers exactly when that page's commands accept the caller, and the page is listed exactly then; the read refuses everyone else as the commands do", async () => {
    await ownerScenario(async (s) => {
      const holders = Object.fromEntries(PAGES.map((p) => [p, [] as UserKey[]])) as Record<Page, UserKey[]>;
      const usersPage: UserKey[] = [];
      for (const user of ALL) {
        const commands = pageCommands();
        const people = await usersPageCommands(user);
        const o = await outcomes(s, user, {
          ...Object.fromEntries(PAGES.map((p) => [`read:${p}`, `select api.${READS[p]}()`])),
          ...Object.fromEntries(PAGES.map((p) => [`command:${p}`, commands[p]])),
          ...people,
        });
        const listed = await views(s, user);
        for (const p of PAGES) {
          expect(o[`read:${p}`], `${user}: ${p}'s read answers as its command`).toBe(o[`command:${p}`]);
          expect(listed.includes(p), `${user}: ${p} listed`).toBe(o[`command:${p}`] === true);
          if (o[`read:${p}`] === true) holders[p].push(user);
        }
        const peopleAdmin = o.set_user_status === true || o.revoke_role === true;
        expect(listed.includes("users"), `${user}: users listed`).toBe(peopleAdmin);
        if (peopleAdmin) usersPage.push(user);
        if (user === "revoked") for (const p of PAGES) expect(o[`read:${p}`]).toBe("CDF_UNAUTHENTICATED");
        else for (const p of PAGES) expect([true, "CDF_FORBIDDEN"]).toContain(o[`read:${p}`]);
      }
      expect(holders).toEqual({
        calendar: ["platformAdmin"],
        committees: ["grcDirector", "platformAdmin", "grcDeputy", "complianceManager"],
        sectors: ["platformAdmin"],
        "notification-rules": ["platformAdmin"],
        // DEC-F24: a policy administrator who approves no export; the GRC director approves exports.
        "export-policy": ["platformAdmin"],
        "corrective-action-policy": ["grcDirector", "grcDeputy"],
      });
      expect(usersPage).toEqual(["platformAdmin"]);
    });
  });

  it("one administration permission at a time: whoever holds it alone is given exactly its page, its read and its commands", async () => {
    // The seed gives five of these permissions only to the platform administrator, so a page or a read on the wrong
    // one would answer the same there. Here the intake officer, who holds none, holds each alone through a synthetic
    // role, and every page, read and command is asked again.
    const PAGE_OF: Record<string, string> = {
      USER_ADMIN: "users",
      ROLE_ADMIN: "users",
      COMMITTEE_ADMIN: "committees",
      SECTOR_ADMIN: "sectors",
      NOTIFICATION_ADMIN: "notification-rules",
      EXPORT_POLICY_ADMIN: "export-policy",
      CORRECTIVE_ACTION_POLICY_ADMIN: "corrective-action-policy",
      BUSINESS_CALENDAR_ADMIN: "calendar",
    };
    await ownerScenario(async (s) => {
      expect(await views(s, "intake"), "the intake officer holds no page").toEqual([]);
      for (const [permission, page] of Object.entries(PAGE_OF)) {
        await s.asOwner();
        const role = `SYN_ONLY_${permission}`;
        await s.tx`insert into iam.role (code, name_en, name_ar, description)
                   values (${role}, 'Synthetic role', 'دور تجريبي', 'Synthetic: one permission for the test only.')`;
        await s.tx`insert into iam.role_permission (role_code, permission_code) values (${role}, ${permission})`;
        const [grant] = await s.tx<{ id: string }[]>`
          insert into iam.user_role_assignment (user_id, role_code, justification)
          values (${USERS.intake}, ${role}, 'Synthetic: test only.') returning id`;
        const commands = pageCommands();
        const o = await outcomes(s, "intake", {
          ...Object.fromEntries(PAGES.map((p) => [`read:${p}`, `select api.${READS[p]}()`])),
          ...Object.fromEntries(PAGES.map((p) => [`command:${p}`, commands[p]])),
          ...(await usersPageCommands("intake")),
        });
        for (const p of PAGES) {
          expect(o[`command:${p}`], `${permission}: ${p}'s command`).toBe(
            p === page ? true : "CDF_FORBIDDEN",
          );
          expect(o[`read:${p}`], `${permission}: ${p}'s read answers as its command`).toBe(o[`command:${p}`]);
        }
        expect(
          o.set_user_status === true || o.revoke_role === true,
          `${permission}: the users page's commands`,
        ).toBe(page === "users");
        expect(await views(s, "intake"), `${permission}: the pages`).toEqual([page]);
        const area = await s.tx<{ default_view: string }[]>`
          select default_view from api.my_areas() where area_code = 'ADMINISTRATION'`;
        expect(area, `${permission}: the area's default view`).toEqual([{ default_view: page }]);
        await s.asOwner();
        await s.tx`delete from iam.user_role_assignment where id = ${grant!.id}`;
      }
    });
  });
});

// ---- Each flag is its command's answer ---------------------------------------------------------------------------------

/** Each flag of a read against what its command answers now for the same caller, run and rolled back. */
function expectFlag(label: string, flag: unknown, answer: Answer | undefined): void {
  expect(typeof flag, `${label}: a boolean`).toBe("boolean");
  expect(flag, `${label}: ${String(answer)}`).toBe(answer === true);
}

interface CalendarCaps {
  may_set_day: boolean;
  may_set_week_pattern: boolean;
  days: { day_id: string; may_withdraw: boolean }[];
}

async function calendarSweep(s: OwnerScenario, user: UserKey): Promise<Record<string, Answer>> {
  const caps = await read<CalendarCaps>(s, user, "admin_calendar_capabilities");
  await s.asOwner();
  const days = await s.tx<{ id: string }[]>`
    select id from config.business_calendar_day order by calendar_date, recorded_at, id`;
  const [free] = await s.tx<{ d: string }[]>`
    select g::date::text as d
      from generate_series((now() at time zone 'Asia/Riyadh')::date + 30, (now() at time zone 'Asia/Riyadh')::date + 800,
                           interval '1 day') g
     where not exists (select 1 from config.business_calendar_day c where c.calendar_date = g::date and c.withdrawn_at is null)
     order by g limit 1`;
  const o = await outcomes(s, user, {
    set_day: setDaySql(free!.d),
    set_week_pattern: weekPatternSql(),
    ...Object.fromEntries(days.map((d) => [d.id, withdrawSql(d.id)])),
  });
  expectFlag(`${user}: may_set_day`, caps.may_set_day, o.set_day);
  expectFlag(`${user}: may_set_week_pattern`, caps.may_set_week_pattern, o.set_week_pattern);
  expect(
    caps.days.map((d) => d.day_id),
    "every day of the calendar, in its order",
  ).toEqual(days.map((d) => d.id));
  for (const d of caps.days) expectFlag(`${user}: may_withdraw ${d.day_id}`, d.may_withdraw, o[d.day_id]);
  return o;
}

interface CommitteeCaps {
  committees: { committee_id: string; may_set_rule_set: boolean; may_revise_rule_set: boolean }[];
}

async function committeeSweep(s: OwnerScenario, user: UserKey): Promise<Record<string, Answer>> {
  const caps = await read<CommitteeCaps>(s, user, "admin_committee_capabilities");
  await s.asOwner();
  const committees = await s.tx<{ id: string; kind: string }[]>`
    select id, kind from committee.committee order by code collate "C", id`;
  const o = await outcomes(s, user, {
    ...Object.fromEntries(committees.map((c) => [`set:${c.id}`, ruleSetSql(c.id, c.kind)])),
    ...Object.fromEntries(committees.map((c) => [`revise:${c.id}`, reviseSql(c.id)])),
  });
  expect(
    caps.committees.map((c) => c.committee_id),
    "every committee, in code order",
  ).toEqual(committees.map((c) => c.id));
  for (const c of caps.committees) {
    expectFlag(`${user}: may_set_rule_set ${c.committee_id}`, c.may_set_rule_set, o[`set:${c.committee_id}`]);
    expectFlag(
      `${user}: may_revise_rule_set ${c.committee_id}`,
      c.may_revise_rule_set,
      o[`revise:${c.committee_id}`],
    );
  }
  return o;
}

interface SectorCaps {
  may_create_sector: boolean;
  delegations: { delegation_id: string; may_revoke: boolean }[];
}

async function sectorSweep(s: OwnerScenario, user: UserKey): Promise<Record<string, Answer>> {
  const caps = await read<SectorCaps>(s, user, "admin_sector_capabilities");
  await s.asOwner();
  const delegations = await s.tx<{ id: string }[]>`
    select id from iam.sector_delegation order by sector_id, effective_from, id`;
  const o = await outcomes(s, user, {
    create_sector: createSectorSql(),
    ...Object.fromEntries(delegations.map((d) => [d.id, revokeSql(d.id)])),
  });
  expectFlag(`${user}: may_create_sector`, caps.may_create_sector, o.create_sector);
  expect(
    caps.delegations.map((d) => d.delegation_id),
    "every delegation, in its order",
  ).toEqual(delegations.map((d) => d.id));
  for (const d of caps.delegations)
    expectFlag(`${user}: may_revoke ${d.delegation_id}`, d.may_revoke, o[d.delegation_id]);
  return o;
}

interface ExportCaps {
  may_set_rule: boolean;
  may_add_purpose: boolean;
  purposes: { code: string; may_set: boolean }[];
}

async function exportSweep(s: OwnerScenario, user: UserKey): Promise<Record<string, Answer>> {
  const caps = await read<ExportCaps>(s, user, "admin_export_policy_capabilities");
  await s.asOwner();
  const purposes = await s.tx<{ code: string; version: number }[]>`
    select code, row_version as version from exchange.export_purpose order by is_legacy, sort_order, code collate "C"`;
  const o = await outcomes(s, user, {
    set_rule: exportRuleSql(),
    add_purpose: purposeSql(freshCode("SYN_"), null),
    ...Object.fromEntries(purposes.map((p) => [`purpose:${p.code}`, purposeSql(p.code, p.version)])),
  });
  expectFlag(`${user}: may_set_rule`, caps.may_set_rule, o.set_rule);
  expectFlag(`${user}: may_add_purpose`, caps.may_add_purpose, o.add_purpose);
  expect(
    caps.purposes.map((p) => p.code),
    "every purpose, in the catalogue's order",
  ).toEqual(purposes.map((p) => p.code));
  for (const p of caps.purposes) expectFlag(`${user}: may_set ${p.code}`, p.may_set, o[`purpose:${p.code}`]);
  return o;
}

describe("each flag is its command's answer (migration 2127)", () => {
  it("the calendar: setting a day and a week, and withdrawing a day ahead, today's, a past one and a withdrawn one", async () => {
    await ownerScenario(async (s) => {
      await s.as("platformAdmin");
      const [d] = await s.tx<{ today: string; taken: boolean }[]>`
        select (now() at time zone 'Asia/Riyadh')::date::text as today,
               exists (select 1 from config.business_calendar_day c
                        where c.calendar_date = (now() at time zone 'Asia/Riyadh')::date and c.withdrawn_at is null) as taken`;
      const [ahead, withdrawn] = (
        await s.tx<{ d: string }[]>`
          select g::date::text as d
            from generate_series((now() at time zone 'Asia/Riyadh')::date + 40,
                                 (now() at time zone 'Asia/Riyadh')::date + 800, interval '1 day') g
           where not exists (select 1 from config.business_calendar_day c
                              where c.calendar_date = g::date and c.withdrawn_at is null)
           order by g limit 2`
      ).map((r) => r.d);
      const days: Record<string, string> = {};
      days.ahead = await one(
        s.tx`select api.set_business_calendar_day(${ahead!}::date, 'HOLIDAY', 'DEMO-CAL-2127', ${REASON}) as id`,
      );
      days.withdrawn = await one(
        s.tx`select api.set_business_calendar_day(${withdrawn!}::date, 'NON_WORKING_DAY', null, ${REASON}) as id`,
      );
      await s.tx`select api.withdraw_business_calendar_day(${days.withdrawn}, ${REASON})`;
      if (!d!.taken)
        days.today = await one(
          s.tx`select api.set_business_calendar_day(${d!.today}::date, 'WORKING_DAY', null, ${REASON}) as id`,
        );
      // No command records a day already past (its date may not be before today in Riyadh).
      await s.asOwner();
      days.past = await one(
        s.tx`insert into config.business_calendar_day (calendar_date, day_type, reason, recorded_by)
             values ((now() at time zone 'Asia/Riyadh')::date - 3, 'HOLIDAY', ${REASON}, ${USERS.platformAdmin})
             returning id`,
      );
      const before = await ledger(s);
      const o = await calendarSweep(s, "platformAdmin");
      expect(await ledger(s), "the read and the rolled-back commands write nothing").toBe(before);
      expect(o.set_day).toBe(true);
      expect(o.set_week_pattern).toBe(true);
      expect(o[days.ahead]).toBe(true);
      if (days.today) expect(o[days.today]).toBe(true);
      expect(o[days.past]).toBe("CDF_CONFLICT:CALENDAR_DAY_PAST");
      expect(o[days.withdrawn]).toBe("CDF_CONFLICT:CALENDAR_DAY_WITHDRAWN");
    });
  });

  it("the committees: each committee administrator, each committee; and a committee whose rule set has ended may be given one but not revised", async () => {
    await ownerScenario(async (s) => {
      for (const user of ["platformAdmin", "grcDirector", "grcDeputy", "complianceManager"] as const) {
        const o = await committeeSweep(s, user);
        for (const c of [ic, gc]) {
          expect(o[`set:${c}`], `${user}: set ${c}`).toBe(true);
          expect(o[`revise:${c}`], `${user}: revise ${c}`).toBe(true);
        }
      }
      // No command ends a rule set without the next one: the owner gives the open version an end, as the table's
      // trigger allows once.
      await s.asOwner();
      await s.tx`update committee.rule_set set effective_to = now() + interval '1 day'
                  where committee_id = ${ic} and effective_to is null`;
      const before = await ledger(s);
      const o = await committeeSweep(s, "platformAdmin");
      expect(await ledger(s)).toBe(before);
      expect(o[`set:${ic}`]).toBe(true);
      expect(o[`revise:${ic}`]).toBe("CDF_CONFLICT:NO_RULE_SET");
      expect(o[`revise:${gc}`]).toBe(true);
    });
  });

  it("the sectors: creating a sector, and revoking a delegation in force, scheduled, revoked or ended; the head who delegated may revoke but this page's read is not theirs", async () => {
    await ownerScenario(async (s) => {
      await s.as("sectorHead");
      const d: Record<string, string> = {};
      d.inForce = await one(
        s.tx`select api.delegate_referral_approval(${ops}, ${USERS.employeeB}, now(), now() + interval '7 days',
               'DEMO-DELEGATION-2127', ${REASON}) as id`,
      );
      d.scheduled = await one(
        s.tx`select api.delegate_referral_approval(${ops}, ${USERS.employeeB}, now() + interval '200 days',
               now() + interval '210 days', 'DEMO-DELEGATION-2127', ${REASON}) as id`,
      );
      d.revoked = await one(
        s.tx`select api.delegate_referral_approval(${ops}, ${USERS.employeeB}, now() + interval '220 days',
               now() + interval '230 days', 'DEMO-DELEGATION-2127', ${REASON}) as id`,
      );
      await s.tx`select api.revoke_referral_delegation(${d.revoked}, ${REASON})`;
      // No command records a delegation that has already ended (it may not start before now).
      await s.asOwner();
      d.ended = await one(
        s.tx`insert into iam.sector_delegation (sector_id, delegator_id, delegate_id, scope, effective_from, effective_to,
                                                evidence_reference, reason)
             values (${ops}, ${USERS.sectorHead}, ${USERS.employee}, 'REFERRAL_APPROVAL', now() - interval '10 days',
                     now() - interval '1 day', 'DEMO-DELEGATION-2127', ${REASON})
             returning id`,
      );
      const before = await ledger(s);
      const o = await sectorSweep(s, "platformAdmin");
      expect(await ledger(s)).toBe(before);
      expect(o.create_sector).toBe(true);
      expect(o[d.inForce]).toBe(true);
      expect(o[d.scheduled]).toBe(true);
      expect(o[d.revoked]).toBe("CDF_CONFLICT:DELEGATION_NOT_ACTIVE");
      expect(o[d.ended]).toBe("CDF_CONFLICT:DELEGATION_NOT_ACTIVE");
      // The head revokes their own delegation elsewhere: the Administration read is for sector administrators.
      const head = await outcomes(s, "sectorHead", {
        read: "select api.admin_sector_capabilities()",
        revoke: revokeSql(d.inForce),
      });
      expect(head).toEqual({ read: "CDF_FORBIDDEN", revoke: true });
    });
  });

  it("the notification rules, the export policy and the corrective-action policy: each administrator's flags, each export purpose in use or legacy", async () => {
    await ownerScenario(async (s) => {
      const before = await ledger(s);
      const notices = await read<{ may_set_rule: boolean }>(
        s,
        "platformAdmin",
        "admin_notification_rule_capabilities",
      );
      const n = await outcomes(s, "platformAdmin", { set_rule: noticeRuleSql() });
      expect(notices).toEqual({ may_set_rule: true });
      expectFlag("may_set_rule", notices.may_set_rule, n.set_rule);

      const o = await exportSweep(s, "platformAdmin");
      expect(o.set_rule).toBe(true);
      expect(o.add_purpose).toBe(true);
      await s.asOwner();
      const purposes = await s.tx<{ code: string; legacy: boolean }[]>`
        select code, is_legacy as legacy from exchange.export_purpose`;
      expect(purposes.some((p) => p.legacy) && purposes.some((p) => !p.legacy)).toBe(true);
      for (const p of purposes)
        expect(o[`purpose:${p.code}`], p.code).toBe(p.legacy ? "CDF_CONFLICT:LEGACY_PURPOSE" : true);

      for (const user of ["grcDirector", "grcDeputy"] as const) {
        const policy = await read<{ may_set_policy: boolean }>(
          s,
          user,
          "admin_corrective_action_policy_capabilities",
        );
        const p = await outcomes(s, user, { set_policy: policySql() });
        expect(policy).toEqual({ may_set_policy: true });
        expectFlag(`${user}: may_set_policy`, policy.may_set_policy, p.set_policy);
      }
      expect(await ledger(s), "the reads and the rolled-back commands write nothing").toBe(before);
    });
  });
});

// ---- F6, F8 and F13 ------------------------------------------------------------------------------------------------------

describe("narrowings (migration 2127): F6, F8 and F13", () => {
  it("F6 (CDF-259): a sector administrator does not appoint themselves, as a member or as head, now or later; nothing is written, and anyone else is still appointed", async () => {
    await ownerScenario(async (s) => {
      const before = await ledger(s);
      await s.as("platformAdmin");
      // OPS has a head and members; FIN has no head. The refusal comes before any other position rule.
      for (const [sector, position, from] of [
        [ops, "MEMBER", "now()"],
        [ops, "HEAD", "now()"],
        [fin, "HEAD", "now()"],
        [fin, "MEMBER", "now() + interval '30 days'"],
      ] as const)
        await s.expectError("CDF_CONFLICT:SELF_APPOINTMENT", (tx) =>
          tx.unsafe(`select api.appoint_sector_member('${sector}', '${USERS.platformAdmin}', '${position}', ${from}, null,
                       'DEMO-SECTOR-2127')`),
        );
      expect(await ledger(s), "nothing is recorded").toBe(before);
      await s.asOwner();
      expect(
        await s.tx`select id from iam.sector_membership where user_id = ${USERS.platformAdmin}`,
        "no position is written",
      ).toEqual([]);
      // Only the caller's own appointment is refused: the same administrator appoints someone else as head.
      await s.as("platformAdmin");
      await s.tx`select api.appoint_sector_member(${fin}, ${USERS.grcSectorHead}, 'HEAD', now(), null, 'DEMO-SECTOR-2127')`;
      expect(await lastEvent(s, "SECTOR_MEMBER_APPOINTED")).toMatchObject({
        sector_id: fin,
        user_id: USERS.grcSectorHead,
        position: "HEAD",
      });
    });
  });

  it("F8 (CDF-260): a notification rule may not start at or before a rule of its key, in force or scheduled; nothing is written; a later start still ends the rule before it, and other keys are their own", async () => {
    await ownerScenario(async (s) => {
      type Key = { layer: string; committee: string | null; channel: string };
      type Row = { from: number | null; to: number | null; enabled: boolean };
      const at = (tx: Tx, key: Key, base: string, days: number, enabled = true) =>
        tx`select api.set_notification_rule(${key.layer}, 'MEETING_CANCELLED', ${key.committee}::uuid, ${key.channel},
             ${enabled}, ${base}::timestamptz + make_interval(days => ${days}::int), ${REASON}) as id`;
      /** The key's rules, their start and end as days from base (a start before base as null). */
      const rows = (key: Key, base: string) =>
        s.tx<Row[]>`
          select case when r.effective_from >= ${base}::timestamptz
                      then extract(day from r.effective_from - ${base}::timestamptz)::int end as "from",
                 case when r.effective_to is not null
                      then extract(day from r.effective_to - ${base}::timestamptz)::int end as "to",
                 r.enabled
            from notify.rule r
           where r.layer = ${key.layer} and r.template_code = 'MEETING_CANCELLED' and r.channel = ${key.channel}
             and r.committee_id is not distinct from ${key.committee}::uuid
           order by r.effective_from`;
      /** Now, or the latest start of the key if later: the rules a test adds come after every rule already there. */
      const baseOf = async (key: Key) => {
        const [r] = await s.tx<{ base: string }[]>`
          select greatest(now(), max(r.effective_from))::text as base from notify.rule r
           where r.layer = ${key.layer} and r.template_code = 'MEETING_CANCELLED' and r.channel = ${key.channel}
             and r.committee_id is not distinct from ${key.committee}::uuid`;
        return r!.base;
      };

      await s.as("platformAdmin");
      const email: Key = { layer: "EVENT_RULE", committee: null, channel: "EMAIL" };
      const base = await baseOf(email);
      const prior = await rows(email, base);
      const open = prior.at(-1)!;
      expect(open.to, "the key has a rule in force or scheduled").toBeNull();
      await at(s.tx, email, base, 10, false);
      const scheduled = await rows(email, base);
      expect(scheduled).toEqual([
        ...prior.slice(0, -1),
        { ...open, to: 10 },
        { from: 10, to: null, enabled: false },
      ]);

      const before = await ledger(s);
      await s.as("platformAdmin");
      for (const days of [5, 10])
        await s.expectError("CDF_CONFLICT:LATER_RULE_EXISTS", (tx) => at(tx, email, base, days));
      expect(await ledger(s), "nothing is recorded").toBe(before);
      await s.as("platformAdmin");
      expect(await rows(email, base), "nothing is written").toEqual(scheduled);
      await at(s.tx, email, base, 15);
      expect(await rows(email, base)).toEqual([
        ...prior.slice(0, -1),
        { ...open, to: 10 },
        { from: 10, to: 15, enabled: false },
        { from: 15, to: null, enabled: true },
      ]);

      // Another channel, and a committee's own default, are other keys.
      const inApp: Key = { layer: "EVENT_RULE", committee: null, channel: "IN_APP" };
      await at(s.tx, inApp, await baseOf(inApp), 5);
      const icDefault: Key = { layer: "COMMITTEE_DEFAULT", committee: ic, channel: "IN_APP" };
      const gcDefault: Key = { layer: "COMMITTEE_DEFAULT", committee: gc, channel: "IN_APP" };
      const icBase = await baseOf(icDefault);
      await at(s.tx, icDefault, icBase, 10);
      await s.expectError("CDF_CONFLICT:LATER_RULE_EXISTS", (tx) => at(tx, icDefault, icBase, 5));
      await at(s.tx, gcDefault, await baseOf(gcDefault), 5);

      // The caller and input checks come first, as built.
      await s.expectError("CDF_INVALID:effective_from", (tx) => at(tx, email, "2026-01-02T00:00:00Z", 0));
      await s.as("grcDirector");
      await s.expectError("CDF_FORBIDDEN", (tx) => at(tx, email, base, 5));
    });
  });

  it("F8: two administrators scheduling the same key at once: the second waits on the first's lock on the key, and schedules once the first is undone", async () => {
    const [b] = await admin.unsafe<{ base: string }[]>(
      `select greatest(now(), max(effective_from))::text as base from notify.rule where ${NOTICE_KEY}`,
    );
    const call = (days: number) =>
      `select api.set_notification_rule('EVENT_RULE', 'MEETING_CANCELLED', null, 'EMAIL', true,
         '${b!.base}'::timestamptz + make_interval(days => ${days}), '${REASON}') is not null as set`;
    const { waited, result } = await contend(
      call(10),
      call(20),
      onKeyLock("notify.rule:EVENT_RULE:MEETING_CANCELLED:-:EMAIL"),
    );
    // Without the lock, the second would not see the first's rule, would wait on the rule the first ends instead, and
    // would then break the one open rule per key (rule_open) once the first is kept.
    expect(waited, "the second waits on the lock on the key").toBe(true);
    expect(result).toEqual([{ set: true }]);
  });

  it("F13: an export purpose is changed only from the version read, a null included; a success raises it and records it; a new purpose is added only with none", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const [p] = await s.tx<{ version: number }[]>`
        select row_version as version from exchange.export_purpose where code = 'LEGAL_REVIEW'`;
      const v = p!.version;
      const set = (
        tx: Tx,
        code: string,
        version: number | null,
        sortOrder = 500,
        justification = code === "OTHER",
      ) =>
        tx`select api.set_export_purpose(${code}, 'Synthetic purpose', 'غرض تجريبي', ${justification}, true, ${sortOrder},
             ${REASON}, ${version}::int) as code`;

      await s.as("platformAdmin");
      await set(s.tx, "LEGAL_REVIEW", v);
      expect(await lastEvent(s, "EXPORT_PURPOSE_SET")).toMatchObject({ created: false, row_version: v + 1 });
      const before = await ledger(s);
      const [row] = await s.tx`select * from exchange.export_purpose where code = 'LEGAL_REVIEW'`;
      expect(row).toMatchObject({ row_version: v + 1, name_en: "Synthetic purpose", sort_order: 500 });
      await s.as("platformAdmin");
      for (const stale of [v, null, v + 2])
        await s.expectError("CDF_CONFLICT:STALE_VERSION", (tx) => set(tx, "LEGAL_REVIEW", stale, 400));
      expect(await ledger(s), "nothing is recorded").toBe(before);
      expect(await s.tx`select * from exchange.export_purpose where code = 'LEGAL_REVIEW'`).toEqual([row]);

      // A new code: only with no version, and then from version 1.
      await s.as("platformAdmin");
      const code = freshCode("SYN_");
      await s.expectError("CDF_CONFLICT:STALE_VERSION", (tx) => set(tx, code, 1));
      await s.asOwner();
      expect(await s.tx`select code from exchange.export_purpose where code = ${code}`).toEqual([]);
      await s.as("platformAdmin");
      await set(s.tx, code, null);
      expect(await lastEvent(s, "EXPORT_PURPOSE_SET")).toMatchObject({ created: true, row_version: 1 });
      await s.as("platformAdmin");
      await s.expectError("CDF_CONFLICT:STALE_VERSION", (tx) => set(tx, code, null));
      await set(s.tx, code, 1);
      expect(await lastEvent(s, "EXPORT_PURPOSE_SET")).toMatchObject({ created: false, row_version: 2 });

      // The order of the checks: the inputs, then a legacy purpose (whatever the version), then the version, then
      // OTHER's justification.
      await s.as("platformAdmin");
      await s.expectError("CDF_INVALID:sort_order", (tx) => set(tx, "LEGAL_REVIEW", v, 950));
      for (const version of [1, null, 99])
        await s.expectError("CDF_CONFLICT:LEGACY_PURPOSE", (tx) => set(tx, "AUDIT", version));
      const [other] = await s.tx<{ version: number }[]>`
        select row_version as version from exchange.export_purpose where code = 'OTHER'`;
      await s.expectError("CDF_CONFLICT:STALE_VERSION", (tx) =>
        set(tx, "OTHER", other!.version + 1, 500, false),
      );
      await s.expectError("CDF_CONFLICT:OTHER_REQUIRES_JUSTIFICATION", (tx) =>
        set(tx, "OTHER", other!.version, 500, false),
      );
    });
  });

  it("F13: two administrators adding the same new purpose at once: the second waits on the first's lock on the code, not on the row it would overwrite, and adds it once the first is undone", async () => {
    const code = freshCode("SYN_");
    const call = `select api.set_export_purpose('${code}', 'Synthetic purpose', 'غرض تجريبي', false, true, 500, '${REASON}', null) as code`;
    const { waited, result } = await contend(call, call, onKeyLock(`exchange.export_purpose:${code}`));
    // Without the lock, the second would find no row, wait on the first's insert instead, and then overwrite the
    // purpose the first added without having seen it.
    expect(waited, "the second waits on the lock on the code").toBe(true);
    // The first was undone, so the code was new again when the second read the catalogue.
    expect(result).toEqual([{ code }]);
  });

  it("F13: an invitee type is changed only from the version read; a change made in between is never overwritten", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const [r] = await s.tx<{ version: number }[]>`
        select row_version as version from committee.invitee_type_rule where invitee_role = 'INTERPRETER'`;
      const v = r!.version;
      const set = (tx: Tx, version: number | null, enabled: boolean | null = true, role = "INTERPRETER") =>
        tx`select api.set_invitee_type_rule(${role}, ${enabled}::boolean, true, null, 'SOURCE_REQUIRED', ${REASON},
             ${version}::int)`;

      // Two committee administrators read version v; the first enables the type.
      await s.as("complianceManager");
      await set(s.tx, v, true);
      expect(await lastEvent(s, "INVITEE_TYPE_RULE_CHANGED")).toMatchObject({
        enabled: true,
        row_version: v + 1,
      });
      const before = await ledger(s);
      const [row] = await s.tx`select * from committee.invitee_type_rule where invitee_role = 'INTERPRETER'`;
      expect(row).toMatchObject({ row_version: v + 1, enabled: true });
      // The second, from the version they read, would undo it unseen: refused, and so is a null or a version never read.
      await s.as("platformAdmin");
      for (const stale of [v, null, v + 2])
        await s.expectError("CDF_CONFLICT:STALE_VERSION", (tx) => set(tx, stale, false));
      expect(await ledger(s), "nothing is recorded").toBe(before);
      expect(
        await s.tx`select * from committee.invitee_type_rule where invitee_role = 'INTERPRETER'`,
      ).toEqual([row]);
      // From the version now in place it goes through.
      await s.as("platformAdmin");
      await set(s.tx, v + 1, false);
      expect(await lastEvent(s, "INVITEE_TYPE_RULE_CHANGED")).toMatchObject({
        enabled: false,
        row_version: v + 2,
      });

      // The order of the checks: an unknown type, then the version, then the inputs.
      await s.as("platformAdmin");
      await s.expectError("CDF_INVALID:invitee_role", (tx) => set(tx, v + 2, true, "ASTROLOGER"));
      await s.expectError("CDF_CONFLICT:STALE_VERSION", (tx) => set(tx, v, null));
      await s.expectError("CDF_INVALID:enabled", (tx) => set(tx, v + 2, null));
    });
  });

  it("F13: a sanction rule is changed only from the version read; a refusal writes no change row", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const [r] = await s.tx<{ version: number }[]>`
        select row_version as version from decision.sanction_catalogue where code = 'WARNING'`;
      const v = r!.version;
      const changes = async () => {
        await s.asOwner();
        const [c] = await s.tx<{ n: number }[]>`
          select count(*)::int as n from decision.sanction_rule_change where sanction_code = 'WARNING'`;
        return c!.n;
      };
      const set = (tx: Tx, version: number | null, code = "WARNING") =>
        tx`select api.set_sanction_rule(${code}, null, false, 'PROCEED', 'SOURCE_REQUIRED', ${REASON}, ${version}::int)`;

      const before = await changes();
      await s.as("platformAdmin");
      await set(s.tx, v);
      expect(await changes()).toBe(before + 1);
      expect(await lastEvent(s, "SANCTION_RULE_SET")).toMatchObject({ row_version: v + 1 });
      const recorded = await ledger(s);
      await s.as("platformAdmin");
      for (const stale of [v, null, v + 2])
        await s.expectError("CDF_CONFLICT:STALE_VERSION", (tx) => set(tx, stale));
      expect(await changes(), "no change row").toBe(before + 1);
      expect(await ledger(s), "nothing is recorded").toBe(recorded);
      expect(await s.tx`select row_version from decision.sanction_catalogue where code = 'WARNING'`).toEqual([
        { row_version: v + 1 },
      ]);
      // Another committee administrator, from the version now in place.
      await s.as("grcDirector");
      await set(s.tx, v + 1);
      expect(await lastEvent(s, "SANCTION_RULE_SET")).toMatchObject({ row_version: v + 2 });
      await s.as("grcDirector");
      await s.expectError("CDF_INVALID:code", (tx) => set(tx, 1, "NO_SUCH_SANCTION"));
    });
  });

  it("F13: two administrators changing the same invitee type or sanction rule at once: the second waits on the row before it reads the version, and changes it once the first is undone", async () => {
    // The second must wait in its select ... for update, before the version check: a change that only waited at its
    // update would pass the check on the version the first was replacing, and overwrite the first's change once kept.
    const [r] = await admin<{ invitee: number; sanction: number }[]>`
      select (select row_version from committee.invitee_type_rule where invitee_role = 'INTERPRETER') as invitee,
             (select row_version from decision.sanction_catalogue where code = 'WARNING') as sanction`;
    const invitee = `select true as done from api.set_invitee_type_rule('INTERPRETER', true, true, null, 'SOURCE_REQUIRED',
      '${REASON}', ${r!.invitee})`;
    const sanction = `select api.set_sanction_rule('WARNING', null, false, 'PROCEED', 'SOURCE_REQUIRED', '${REASON}',
      ${r!.sanction}) is not null as done`;
    for (const [call, table] of [
      [invitee, "committee.invitee_type_rule"],
      [sanction, "decision.sanction_catalogue"],
    ] as const) {
      const { waited, result } = await contend(call, call, onRowLock(table));
      expect(waited, `${table}: the second waits on the row before it reads the version`).toBe(true);
      expect(result, `${table}: the first was undone, so the version read is current again`).toEqual([
        { done: true },
      ]);
    }
  });
});

// ---- The functions themselves ---------------------------------------------------------------------------------------------

describe("the functions of migration 2127", () => {
  const NEW_READS = ["my_admin_views", ...PAGES.map((p) => READS[p])].sort();
  const COMMANDS = [
    "set_business_calendar_day",
    "set_business_week_pattern",
    "withdraw_business_calendar_day",
    "set_committee_rule_set",
    "revise_committee_rule_set",
    "create_sector",
    "revoke_referral_delegation",
    "set_notification_rule",
    "set_export_rule",
    "set_export_purpose",
    "set_corrective_action_policy",
  ];

  it("the reads are stable, security definer with an empty search path, executable by authenticated only, and take no lock, run no command and open no subtransaction", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const rows = await s.tx<
        {
          name: string;
          volatile: string;
          definer: boolean;
          config: string[];
          args: string;
          authenticated: boolean;
          anon: boolean;
          everyone: boolean;
          src: string;
        }[]
      >`select p.proname as name, p.provolatile as volatile, p.prosecdef as definer, p.proconfig as config,
               pg_get_function_identity_arguments(p.oid) as args, p.prosrc as src,
               has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
               has_function_privilege('anon', p.oid, 'execute') as anon,
               has_function_privilege('public', p.oid, 'execute') as everyone
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'api' and p.proname = any(${NEW_READS})
         order by p.proname collate "C"`;
      expect(
        rows.map((r) => [
          r.name,
          r.volatile,
          r.definer,
          r.config,
          r.args,
          r.authenticated,
          r.anon,
          r.everyone,
        ]),
      ).toEqual(NEW_READS.map((n) => [n, "s", true, ['search_path=""'], "", true, false, false]));
      for (const r of rows) {
        const code = r.src.replace(/--[^\n]*/g, "");
        expect(code, `${r.name}: no subtransaction`).not.toMatch(/\bexception\b/i);
        expect(code, `${r.name}: no row lock`).not.toMatch(/\bfor (update|share)\b/i);
        expect(code, `${r.name}: no advisory lock`).not.toMatch(/pg_advisory/i);
        expect(code, `${r.name}: no lock helper`).not.toMatch(/\block_(committee|sector)\b/i);
        for (const c of COMMANDS) expect(code, `${r.name} runs ${c}`).not.toContain(`api.${c}(`);
      }
    });
  });

  it("the three commands with a version have one signature each, the version read last; the replaced commands keep theirs", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const rows = await s.tx<
        { name: string; args: string; authenticated: boolean; anon: boolean; everyone: boolean }[]
      >`
        select p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
               has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
               has_function_privilege('anon', p.oid, 'execute') as anon,
               has_function_privilege('public', p.oid, 'execute') as everyone
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'api' and p.proname in ('set_export_purpose', 'set_invitee_type_rule', 'set_sanction_rule',
                                                     'appoint_sector_member', 'set_notification_rule')
         order by p.proname collate "C", 2`;
      expect(rows).toEqual([
        {
          name: "appoint_sector_member",
          args: "p_sector_id uuid, p_user_id uuid, p_position text, p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_appointment_reference text",
          authenticated: true,
          anon: false,
          everyone: false,
        },
        {
          name: "set_export_purpose",
          args: "p_code text, p_name_en text, p_name_ar text, p_requires_justification boolean, p_is_active boolean, p_sort_order integer, p_reason text, p_expected_version integer",
          authenticated: true,
          anon: false,
          everyone: false,
        },
        {
          name: "set_invitee_type_rule",
          args: "p_invitee_role text, p_enabled boolean, p_confidentiality_ack_required boolean, p_wording_reference text, p_source_status text, p_reason text, p_expected_version integer",
          authenticated: true,
          anon: false,
          everyone: false,
        },
        {
          name: "set_notification_rule",
          args: "p_layer text, p_template_code text, p_committee_id uuid, p_channel text, p_enabled boolean, p_effective_from timestamp with time zone, p_reason text",
          authenticated: true,
          anon: false,
          everyone: false,
        },
        {
          name: "set_sanction_rule",
          args: "p_code text, p_severity_rank integer, p_is_irreversible boolean, p_grievance_execution_rule text, p_source_status text, p_reason text, p_expected_version integer",
          authenticated: true,
          anon: false,
          everyone: false,
        },
      ]);
    });
  });
});
