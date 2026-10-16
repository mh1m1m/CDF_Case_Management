// UX redesign Phase 12, slice P12-2c, migration 2086 (ADR-056; Linear CDF-222): the recommendation package builder and
// the meeting's invite list. api.committee_items_view (2060's read model R2) gains, for the caller, what the package
// commands would answer now; api.meeting_invite_choices lists the runner's candidates for one meeting on the bases the
// coordinator ruled (2026-10-15 00:23): the case's persons, the case team's active assignments and the legal reviewers
// of the proceeding's packages, never a directory.
//
// Two sweeps run in every state these tests build, for each caller:
//   * packages(): may_create_package, may_add_item, may_submit_for_vote, may_record_adoption, may_return_to_committee
//     and may_withdraw each equal what their command answers, run and rolled back; open_vote_in is exactly the meetings
//     where api.open_package_vote accepts the package; taint_resolutions is exactly the resolutions
//     api.resolve_conflict_taint accepts on the item. Every package of the proceeding is shown with its active items,
//     and no command accepts on a withdrawn item. Where the read is NOT_FOUND no package command accepts, except on a
//     proceeding that is no longer open (ADR-056, "Known limitations"). The read without 2086's keys equals 2060's,
//     installed from its migration text and run side by side.
//   * invites(): api.meeting_invite_choices refuses exactly as api.invite_to_meeting does. Otherwise it lists exactly
//     the case's persons, and the accounts on the ruled bases, that the command accepts for at least one role and that
//     no declared conflict or witness exclusion in a meeting of the proceeding narrows out, each with exactly the roles
//     the command accepts; no account outside the bases, even one the command accepts; in ORDINAL mode no name,
//     department, person type or account link of a case person; never the case id or number; one audit event with
//     counts only per call, and none on a refusal.
// Every step runs through the api.* commands as `authenticated`. The owner connection only installs 2060's definition,
// reads the ground truth, counts the ledger and sets two fixtures no command writes: the label policy (the DEC-02 card
// is open) and a catalogue version that ends while an item carries its code (a version ends only when the next one
// starts, and a new version starts now or later).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, type OwnerScenario, type Scenario, type UserKey } from "../support/db";
import {
  IC_SEATS,
  REASON,
  committeeIds,
  openWithPresent,
  refer,
  scheduleMeeting,
  seat,
  type MeetingFixture,
} from "../support/committee";
import {
  DECISION_SEATS,
  DECISION_VOTERS,
  authorityRuleFor,
  caseFacts,
  draftPackage,
  requestLegalReview,
  voteOnPackage,
  type PackageFixture,
} from "../support/decision";
import { outcomes } from "../support/capabilities";
import { concludeProceedings } from "../support/closure";

const FIRM = "Synthetic: the documented reasoning of the committee.";
const ADDED = "Synthetic: an item the capability probe adds.";
const DEFENCE = "Synthetic: you are invited to respond.";
const EXCLUSION = "Synthetic: the witness approached a member, for the invite test.";

let caseB: string, ic: string, gc: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic, gc } = await committeeIds());
});

const claims = (user: UserKey) => JSON.stringify({ sub: USERS[user], role: "authenticated" });

/** The rows of the audit ledger this scenario wrote so far (the owner reads its own transaction). */
async function ledger(s: OwnerScenario): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`
    select count(*)::int as n from audit.audit_event where request_id = current_setting('cdf.request_id')::uuid`;
  return r!.n;
}

/** This scenario's audit rows of `action`, oldest first. */
async function events(s: OwnerScenario, action: string) {
  await s.asOwner();
  return s.tx<
    {
      actor_id: string;
      case_id: string;
      category: string;
      outcome: string;
      object_type: string;
      object_id: string;
      reason: string | null;
      metadata: Record<string, unknown>;
    }[]
  >`select actor_id, case_id, category, outcome, object_type, object_id, reason, metadata
    from audit.audit_event where request_id = current_setting('cdf.request_id')::uuid and action = ${action}
    order by seq`;
}

// ---- M1: api.committee_items_view with the package capabilities ----------------------------------------------------

const PACKAGE_FLAGS = [
  "may_add_item",
  "may_record_adoption",
  "may_return_to_committee",
  "may_submit_for_vote",
];
const RESOLUTIONS = ["RE_VOTE", "CONFIRM"] as const;

interface ItemRow {
  item_id: string;
  item_type: string;
  capabilities: Record<string, unknown>;
  taint_resolutions: unknown;
}
interface PackageRow {
  package_id: string;
  sequence_no: number;
  status: string;
  round_no: number;
  items: ItemRow[];
  capabilities: Record<string, unknown>;
  open_vote_in: unknown;
}
interface ItemsView {
  committee_proceeding_id: string;
  label_mode: string;
  capabilities: Record<string, unknown>;
  packages: PackageRow[];
  finding_votes: unknown[];
}

/** The caller's R2, or null when it is NOT_FOUND to them. Every capability a boolean, every list a list. */
async function itemsView(s: OwnerScenario, user: UserKey, cp: string): Promise<ItemsView | null> {
  await s.as(user);
  let v: ItemsView | null = null;
  try {
    await s.tx.savepoint(async (sp) => {
      const [r] = await sp<{ v: ItemsView }[]>`select api.committee_items_view(${cp}) as v`;
      v = r!.v;
    });
  } catch (error) {
    if ((error as Error).message === "CDF_NOT_FOUND") return null;
    throw error;
  }
  const seen = v as ItemsView | null;
  if (seen) {
    expect(Object.keys(seen.capabilities), `${user}: the proceeding's capabilities`).toEqual([
      "may_create_package",
    ]);
    expect(typeof seen.capabilities.may_create_package, `${user} may_create_package`).toBe("boolean");
    for (const p of seen.packages) {
      expect(Object.keys(p.capabilities).sort(), `${user}: a package's capabilities`).toEqual(PACKAGE_FLAGS);
      for (const f of PACKAGE_FLAGS) expect(typeof p.capabilities[f], `${user} ${f}`).toBe("boolean");
      expect(Array.isArray(p.open_vote_in), `${user} open_vote_in`).toBe(true);
      for (const i of p.items) {
        expect(Object.keys(i.capabilities), `${user}: an item's capabilities`).toEqual(["may_withdraw"]);
        expect(typeof i.capabilities.may_withdraw, `${user} may_withdraw`).toBe("boolean");
        expect(Array.isArray(i.taint_resolutions), `${user} taint_resolutions`).toBe(true);
      }
    }
  }
  return seen;
}

/** R2 without the keys 2086 adds: what 2060's api.committee_items_view returned. Null stays null. */
function without2086(view: unknown): unknown {
  if (view === null || view === undefined) return view;
  const v = structuredClone(view) as Record<string, unknown> & { packages?: Record<string, unknown>[] };
  delete v.capabilities;
  for (const p of v.packages ?? []) {
    delete p.capabilities;
    delete p.open_vote_in;
    for (const i of (p.items as Record<string, unknown>[] | undefined) ?? []) {
      delete i.capabilities;
      delete i.taint_resolutions;
    }
  }
  return v;
}

const MIGRATIONS = "infrastructure/supabase/migrations";

/** 2060's api.committee_items_view, renamed into pg_temp so that it runs beside the live one in one transaction. */
function definition2060(): string {
  const text = readFileSync(`${MIGRATIONS}/20261007002060_case_closure_reopening_read_models.sql`, "utf8");
  const head = /create (?:or replace )?function api\.committee_items_view\(p_committee_proceeding_id uuid\)/;
  const start = text.search(head);
  const end = text.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error("api.committee_items_view not found in 2060");
  return text
    .slice(start, end + "\n$$;".length)
    .replace(head, "create function pg_temp.committee_items_view_2060(p_committee_proceeding_id uuid)");
}

/** Installs 2060's definition on the owner connection; the scenario's rollback removes it. */
async function install(s: OwnerScenario): Promise<void> {
  await s.asOwner();
  await s.tx.unsafe(definition2060());
}

/** One definition's answer for the user whose claims are set: the read, or the error it raised. */
async function runAs(s: OwnerScenario, fn: string, cp: string): Promise<{ view?: unknown; error?: string }> {
  let view: unknown;
  try {
    await s.tx.savepoint(async (sp) => {
      const [r] = await sp.unsafe(`select ${fn}($1) as v`, [cp]);
      view = r!.v;
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  return { view };
}

/** AGENT-09: the live read without 2086's keys is 2060's, for this caller, in this state. */
async function sameAs2060(s: OwnerScenario, user: UserKey, cp: string): Promise<void> {
  await s.asOwner();
  await s.tx`select set_config('request.jwt.claims', ${claims(user)}, true)`;
  const before = await runAs(s, "pg_temp.committee_items_view_2060", cp);
  const after = await runAs(s, "api.committee_items_view", cp);
  expect(after.error, `${user}: the same refusal`).toBe(before.error);
  if (before.error === undefined)
    expect(without2086(after.view), `${user}: 2060's read`).toEqual(before.view);
}

/** Callers of the package sweep: the secretary, the chair, two members, a legal reviewer without a seat, the case
 *  team, the case manager, a platform administrator and a committee administrator without a seat. */
const PACKAGE_CALLERS: UserKey[] = [
  "committeeSecretary",
  "committeeChair",
  "legal",
  "lead",
  "legalB",
  "investigatorB",
  "caseManager",
  "platformAdmin",
  "grcDirector",
];

/** M1 in the proceeding's current state, for each caller (see the header). The votes are also probed in `others`,
 *  meetings of other proceedings, which open_vote_in never lists. */
async function packages(
  s: OwnerScenario,
  cp: string,
  callers: UserKey[] = PACKAGE_CALLERS,
  others: string[] = [],
): Promise<void> {
  await s.asOwner();
  const pkgs = await s.tx<{ id: string }[]>`
    select id from decision.recommendation_package where committee_proceeding_id = ${cp} order by sequence_no`;
  const items = await s.tx<{ id: string; package_id: string; status: string }[]>`
    select i.id, i.package_id, i.status from decision.recommendation_item i
    join decision.recommendation_package p on p.id = i.package_id
    where p.committee_proceeding_id = ${cp} order by i.added_at, i.id`;
  const meetings = await s.tx<{ id: string }[]>`
    select id from committee.meeting where committee_proceeding_id = ${cp} or id = any(${others}::uuid[])
    order by sequence_no, id`;
  const [proceeding] = await s.tx<{ status: string }[]>`
    select status from committee.committee_proceeding where id = ${cp}`;
  for (const user of callers) {
    const v = await itemsView(s, user, cp);
    const probes: Record<string, string> = {
      create: `select api.create_recommendation_package('${cp}', 'PACKAGE')`,
    };
    for (const p of pkgs) {
      probes[`add:${p.id}`] =
        `select api.add_recommendation_item('${p.id}', 'OTHER', null, null, '${ADDED}', null, null)`;
      probes[`submit:${p.id}`] = `select api.submit_package_for_vote('${p.id}')`;
      probes[`adopt:${p.id}`] = `select api.record_package_adoption('${p.id}')`;
      probes[`return:${p.id}`] = `select api.return_package_to_committee('${p.id}', '${REASON}')`;
      for (const m of meetings)
        probes[`open:${p.id}:${m.id}`] = `select api.open_package_vote('${m.id}', '${p.id}')`;
    }
    for (const i of items) {
      probes[`withdraw:${i.id}`] = `select api.withdraw_recommendation_item('${i.id}', '${REASON}')`;
      for (const r of RESOLUTIONS)
        probes[`${r}:${i.id}`] = `select api.resolve_conflict_taint('${i.id}', '${r}', '${FIRM}')`;
    }
    const o = await outcomes(s, user, probes);
    const a = (k: string) => o[k] === true;
    if (!v) {
      // NOT_FOUND: no package command accepts. A proceeding no longer open is NOT_FOUND to the committee side (2060),
      // while the package commands do not check the proceeding's status: the page offers less than they accept there,
      // never more (ADR-056). Creating a package is refused there too (PROCEEDING_CLOSED).
      const accepted = Object.keys(o).filter(a);
      if (proceeding!.status === "OPEN") expect(accepted, `${user}: nothing accepted, unseen`).toEqual([]);
      else expect(a("create"), `${user} creates a package on a closed proceeding`).toBe(false);
    } else {
      expect(v.capabilities.may_create_package, `${user} may_create_package`).toBe(a("create"));
      expect(
        v.packages.map((p) => p.package_id),
        `${user}: every package of the proceeding`,
      ).toEqual(pkgs.map((p) => p.id));
      for (const p of v.packages) {
        const id = p.package_id;
        expect(p.capabilities, `${user}: package ${p.sequence_no} (${p.status})`).toEqual({
          may_add_item: a(`add:${id}`),
          may_record_adoption: a(`adopt:${id}`),
          may_return_to_committee: a(`return:${id}`),
          may_submit_for_vote: a(`submit:${id}`),
        });
        expect(p.open_vote_in, `${user}: open_vote_in of package ${p.sequence_no}`).toEqual(
          meetings.map((m) => m.id).filter((m) => a(`open:${id}:${m}`)),
        );
        expect(
          p.items.map((i) => i.item_id),
          `${user}: the active items of package ${p.sequence_no}`,
        ).toEqual(items.filter((i) => i.package_id === id && i.status === "ACTIVE").map((i) => i.id));
        for (const i of p.items) {
          expect(i.capabilities.may_withdraw, `${user} may_withdraw ${i.item_type}`).toBe(
            a(`withdraw:${i.item_id}`),
          );
          expect(i.taint_resolutions, `${user} taint_resolutions ${i.item_type}`).toEqual(
            RESOLUTIONS.filter((r) => a(`${r}:${i.item_id}`)),
          );
        }
      }
    }
    // A withdrawn item is shown nowhere, and no command accepts on it.
    for (const i of items.filter((x) => x.status !== "ACTIVE")) {
      expect(a(`withdraw:${i.id}`), `${user} withdraws a withdrawn item`).toBe(false);
      for (const r of RESOLUTIONS) expect(a(`${r}:${i.id}`), `${user} ${r} on a withdrawn item`).toBe(false);
    }
    await sameAs2060(s, user, cp);
  }
}

/** The secretary's view of the proceeding's packages, by sequence number. */
async function secretaryPackages(s: OwnerScenario, cp: string): Promise<PackageRow[]> {
  return (await itemsView(s, "committeeSecretary", cp))!.packages;
}

/** Each listed member declares no conflict on their participant row of `meeting`. */
async function declareNone(s: OwnerScenario, meeting: string, users: UserKey[]): Promise<void> {
  await s.asOwner();
  const rows = await s.tx<{ id: string; user_id: string }[]>`
    select id, user_id from committee.meeting_participant where meeting_id = ${meeting}`;
  for (const u of users) {
    await s.as(u);
    await s.tx`select api.declare_meeting_conflict(${rows.find((r) => r.user_id === USERS[u])!.id}, 'NO_CONFLICT', null)`;
  }
}

/** The secretary schedules another deliberation of the proceeding; returns it. */
async function anotherMeeting(s: Scenario, cp: string, days = 2): Promise<string> {
  await s.as("committeeSecretary");
  const [m] = await s.tx<{ id: string }[]>`
    select api.schedule_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Meeting room (synthetic)', null,
      now() + make_interval(days => ${days}::int), now() + make_interval(days => ${days}::int, hours => 2),
      ${REASON}) as id`;
  return m!.id;
}

/** The current round's vote items of the package, in order. */
async function roundItems(s: OwnerScenario, pkg: string): Promise<string[]> {
  await s.asOwner();
  return (
    await s.tx<{ id: string }[]>`
      select vi.id from committee.vote_item vi
      join decision.recommendation_package p on p.id = vi.package_id and vi.package_round = p.round_no
      where p.id = ${pkg} order by vi.sequence_no`
  ).map((r) => r.id);
}

/** The secretary opens the package's vote in the meeting, each voter casts `choice` on every vote item of the round,
 *  and the secretary closes them. */
async function voteRound(
  s: OwnerScenario,
  meeting: string,
  pkg: string,
  choice = "APPROVE",
  voters: UserKey[] = DECISION_VOTERS,
): Promise<void> {
  await s.as("committeeSecretary");
  await s.tx`select api.open_package_vote(${meeting}, ${pkg})`;
  for (const vi of await roundItems(s, pkg)) {
    for (const u of voters) {
      await s.as(u);
      await s.tx`select api.cast_vote(${vi}, ${choice}, null)`;
    }
    await s.as("committeeSecretary");
    await s.tx`select api.close_vote_item(${vi}, null)`;
  }
}

/** Someone raises a conflict on the lead's participation in the meeting; the chair upholds it. Returns the concern. */
async function upheldOnLead(s: Scenario, m: MeetingFixture, raiser: UserKey = "legal"): Promise<string> {
  await s.as(raiser);
  const [c] = await s.tx<{ id: string }[]>`
    select api.raise_meeting_conflict(${m.participant.lead!}, 'Synthetic: the lead is related to the subject.') as id`;
  await s.as("committeeChair");
  await s.tx`select api.decide_meeting_conflict(${c!.id}, 'UPHELD', 'Synthetic: the relationship is confirmed.')`;
  return c!.id;
}

/** Chair and lead approve, legal rejects: the lead's vote decides. */
const decisive = (_target: string, voter: UserKey) => (voter === "legal" ? "REJECT" : "APPROVE");

/** The taint resolutions the caller is offered on every active item, package by package. */
const resolutions = async (s: OwnerScenario, cp: string, user: UserKey = "committeeSecretary") =>
  (await itemsView(s, user, cp))!.packages.flatMap((p) => p.items.map((i) => i.taint_resolutions));

/** Legal review by legalB, then submission to the authority and the CEO's decision, today. */
async function decided(s: Scenario, f: PackageFixture): Promise<void> {
  const { request } = await requestLegalReview(s, f);
  await s.as("legalB");
  await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
  await s.as("committeeSecretary");
  await s.tx`select api.submit_to_authority(${f.pkg})`;
  await s.tx`select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now(),
    'Authority (synthetic)', 'MEMO-DEMO-2086', null, ${REASON}, null::text, null::text, null::text, null::text[],
    null::jsonb)`;
}

/** The compliance manager is appointed the committee's conflict authority and reverses the upheld concern. */
async function reversed(s: Scenario, concern: string): Promise<void> {
  await s.as("platformAdmin");
  await s.tx`select api.appoint_conflict_authority(${ic}, ${USERS.complianceManager}, now(), null, 'DEMO-CA-2086',
    'SOURCE_REQUIRED', ${REASON})`;
  await s.as("complianceManager");
  await s.tx`select api.reverse_meeting_conflict_determination(${concern}, 'Synthetic: the relationship was not proven.')`;
}

/** investigatorA holds the Investigation Committee's alternate secretary seat, a seat that does not judge; with
 *  `team`, they are also an investigator on case B. */
async function alternateSecretary(s: Scenario, team: boolean): Promise<void> {
  await s.as("platformAdmin");
  await s.tx`select api.appoint_committee_member(${ic}, ${USERS.investigatorA}, 'ALTERNATE_SECRETARY',
    now() - interval '1 day', null, 'DEMO-APPT')`;
  if (team) {
    await s.as("caseManager");
    await s.tx`select api.assign_case(${caseB}, ${USERS.investigatorA}, 'INVESTIGATOR', ${REASON})`;
  }
}

/** The package sweep's callers and the alternate secretary. */
const WITH_ALTERNATE: UserKey[] = [...PACKAGE_CALLERS, "investigatorA"];

describe("api.committee_items_view: the package capabilities (migration 2086, ADR-056)", () => {
  it("through a package's life in PACKAGE granularity: create, add and withdraw, put to the committee, open the vote in the open meeting only, adopt, return and a second round; each capability is its command's answer", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      await seat(s, ic, DECISION_SEATS);
      await authorityRuleFor(s, "CORRECTIVE_ACTION");
      const facts = await caseFacts(s, caseB);
      await s.as("caseManager");
      await s.tx`select api.issue_defence_notice(${facts.subject}, ${DEFENCE}, ${[facts.allegation]}::uuid[],
        now() + interval '10 days')`;
      const f = await scheduleMeeting(s, ic, caseB);
      const cp = f.committeeProceeding;

      // 1. No package yet, the meeting scheduled: only the secretary may create one.
      await packages(s, cp);
      expect((await itemsView(s, "committeeSecretary", cp))!.capabilities.may_create_package).toBe(true);
      expect((await itemsView(s, "committeeChair", cp))!.capabilities.may_create_package).toBe(false);
      expect(await itemsView(s, "platformAdmin", cp)).toBeNull();

      // 2. An empty draft: items may be added; nothing to put to the committee yet.
      await openWithPresent(s, f, DECISION_VOTERS);
      await s.as("committeeSecretary");
      const [pkg] = await s.tx<{ id: string }[]>`
        select api.create_recommendation_package(${cp}, 'PACKAGE') as id`;
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[0]!.capabilities).toEqual({
        may_add_item: true,
        may_record_adoption: false,
        may_return_to_committee: false,
        may_submit_for_vote: false,
      });

      // 3. A sanction on the subject, a case-wide corrective action, and a third item withdrawn.
      await s.as("committeeSecretary");
      await s.tx`select api.add_recommendation_item(${pkg!.id}, 'DISCIPLINARY_SANCTION', 'WARNING', null,
        'Synthetic: written warning for Employee Sigma.', ${[facts.subject]}::uuid[], ${[facts.allegation]}::uuid[])`;
      await s.tx`select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null,
        'Synthetic: strengthen the approval controls.', null, null)`;
      const [other] = await s.tx<{ id: string }[]>`
        select api.add_recommendation_item(${pkg!.id}, 'OTHER', null, null, 'Synthetic: an item withdrawn later.',
          null, null) as id`;
      await s.tx`select api.withdraw_recommendation_item(${other!.id}, ${REASON})`;
      await packages(s, cp);
      const draft = (await secretaryPackages(s, cp))[0]!;
      expect(draft.capabilities.may_submit_for_vote).toBe(true);
      expect(draft.items.map((i) => i.capabilities.may_withdraw)).toEqual([true, true]);

      // 4. Put to the committee, with a second meeting scheduled: the vote opens in the open meeting only.
      await s.as("committeeSecretary");
      await s.tx`select api.submit_package_for_vote(${pkg!.id})`;
      await anotherMeeting(s, cp);
      await packages(s, cp);
      let voting = (await secretaryPackages(s, cp))[0]!;
      expect(voting.open_vote_in).toEqual([f.meeting]);
      expect(voting.capabilities).toEqual({
        may_add_item: false,
        may_record_adoption: false,
        may_return_to_committee: false,
        may_submit_for_vote: false,
      });
      expect(voting.items.map((i) => i.capabilities.may_withdraw)).toEqual([false, false]);
      expect((await itemsView(s, "committeeChair", cp))!.packages[0]!.open_vote_in).toEqual([]);

      //    A concern open about a witness who has not declared holds the vote; once the witness declares the
      //    conflict, it no longer does (committee.require_no_open_concern).
      await s.as("committeeSecretary");
      const [witness] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${f.meeting}, 'WITNESS', ${USERS.investigatorB}, null, true, ${REASON}) as id`;
      await s.as("legal");
      await s.tx`select api.raise_meeting_conflict(${witness!.id}, 'Synthetic: the witness reports to the subject.')`;
      await packages(s, cp, ["committeeSecretary", "committeeChair"]);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([]);
      await s.as("investigatorB");
      await s.tx`select api.declare_meeting_conflict(${witness!.id}, 'CONFLICT_DECLARED', ${REASON})`;
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([f.meeting]);

      // 5. The vote opened: no second vote in the round, and no adoption while it is open.
      await s.as("committeeSecretary");
      await s.tx`select api.open_package_vote(${f.meeting}, ${pkg!.id})`;
      await packages(s, cp);
      voting = (await secretaryPackages(s, cp))[0]!;
      expect(voting.open_vote_in).toEqual([]);
      expect(voting.capabilities.may_record_adoption).toBe(false);

      // 6. Cast and closed: the adoption.
      const [vi] = await roundItems(s, pkg!.id);
      for (const u of DECISION_VOTERS) {
        await s.as(u);
        await s.tx`select api.cast_vote(${vi!}, 'APPROVE', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi!}, null)`;
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[0]!.capabilities.may_record_adoption).toBe(true);

      // 7. Adopted: returned to the committee, then put to it again in round 2.
      await s.as("committeeSecretary");
      expect((await s.tx<{ s: string }[]>`select api.record_package_adoption(${pkg!.id}) as s`)[0]!.s).toBe(
        "ADOPTED",
      );
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[0]!.capabilities).toEqual({
        may_add_item: false,
        may_record_adoption: false,
        may_return_to_committee: true,
        may_submit_for_vote: false,
      });
      await s.as("committeeSecretary");
      await s.tx`select api.return_package_to_committee(${pkg!.id}, ${REASON})`;
      await packages(s, cp);
      await s.as("committeeSecretary");
      expect((await s.tx<{ r: number }[]>`select api.submit_package_for_vote(${pkg!.id}) as r`)[0]!.r).toBe(
        2,
      );
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([f.meeting]);
      //    The meeting closes: no vote opens in a meeting that is not open.
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      await packages(s, cp, ["committeeSecretary", "committeeChair"]);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([]);

      // 8. A second package whose only item is withdrawn: nothing to put to the committee (PACKAGE_EMPTY). Then the
      //    committee's proceeding concludes: the committee side no longer reads it, and the case team reads it with
      //    every capability false.
      await s.as("committeeSecretary");
      const [second] = await s.tx<{ id: string }[]>`
        select api.create_recommendation_package(${cp}, 'ITEM') as id`;
      const [only] = await s.tx<{ id: string }[]>`
        select api.add_recommendation_item(${second!.id}, 'OTHER', null, null, 'Synthetic: the only item, withdrawn.',
          null, null) as id`;
      await s.tx`select api.withdraw_recommendation_item(${only!.id}, ${REASON})`;
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[1]!.capabilities).toEqual({
        may_add_item: true,
        may_record_adoption: false,
        may_return_to_committee: false,
        may_submit_for_vote: false,
      });
      await s.asOwner();
      const [own] = await s.tx<{ proceeding_id: string }[]>`
        select proceeding_id from committee.committee_proceeding where id = ${cp}`;
      await s.as("caseManager");
      await s.tx`select api.close_proceeding(${own!.proceeding_id}, 'CONCLUDED', 'DECISION_RECORDED', ${REASON})`;
      await packages(s, cp);
      expect(await itemsView(s, "committeeSecretary", cp)).toBeNull();
      const team = (await itemsView(s, "investigatorB", cp))!;
      expect(team.capabilities.may_create_package).toBe(false);
      for (const p of team.packages) {
        expect(Object.values(p.capabilities).every((x) => x === false)).toBe(true);
        expect(p.open_vote_in).toEqual([]);
      }
    });
  });

  it("ITEM granularity: no vote opens without quorum or with a concern open; a dependency and an exclusivity group change nothing; all rejected goes back to DRAFT; a sanction waits for its defence notice", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      await seat(s, ic, DECISION_SEATS);
      await authorityRuleFor(s, "CORRECTIVE_ACTION");
      const facts = await caseFacts(s, caseB);
      const f = await scheduleMeeting(s, ic, caseB);
      const cp = f.committeeProceeding;
      // Nobody is present yet: no quorum.
      await openWithPresent(s, f, []);
      await s.as("committeeSecretary");
      const [pkg] = await s.tx<{ id: string }[]>`
        select api.create_recommendation_package(${cp}, 'ITEM') as id`;
      const [sanction] = await s.tx<{ id: string }[]>`
        select api.add_recommendation_item(${pkg!.id}, 'DISCIPLINARY_SANCTION', 'WARNING', null,
          'Synthetic: written warning for Employee Sigma.', ${[facts.subject]}::uuid[],
          ${[facts.allegation]}::uuid[]) as id`;
      const [corrective] = await s.tx<{ id: string }[]>`
        select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null,
          'Synthetic: strengthen the approval controls.', null, null, false, null, 'CONTROLS_A') as id`;
      await s.tx`select api.add_recommendation_item(${pkg!.id}, 'GOVERNANCE_REMEDIATION', null, null,
        'Synthetic: review the delegation matrix.', null, null, false, ${[corrective!.id]}::uuid[], 'CONTROLS_A')`;
      await s.tx`select api.submit_package_for_vote(${pkg!.id})`;
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([]);
      await s.expectError(
        "CDF_CONFLICT:NO_QUORUM",
        (tx) => tx`select api.open_package_vote(${f.meeting}, ${pkg!.id})`,
      );

      // The members declare and the chair arrives: one of three eligible is short of the majority.
      await declareNone(s, f.meeting, DECISION_VOTERS);
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${f.participant.committeeChair!}, 'PRESENT')`;
      await packages(s, cp, ["committeeSecretary", "committeeChair"]);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([]);
      // The others arrive: quorum.
      await s.as("committeeSecretary");
      for (const u of ["legal", "lead"] as const)
        await s.tx`select api.record_attendance(${f.participant[u]!}, 'PRESENT')`;
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([f.meeting]);

      // A concern open in another meeting of the proceeding does not hold this meeting's vote.
      const other = await anotherMeeting(s, cp);
      await s.asOwner();
      const [leadThere] = await s.tx<{ id: string }[]>`
        select id from committee.meeting_participant where meeting_id = ${other} and user_id = ${USERS.lead}`;
      await s.as("committeeSecretary");
      await s.tx`select api.raise_meeting_conflict(${leadThere!.id}, 'Synthetic: raised in the other meeting.')`;
      await packages(s, cp, ["committeeSecretary", "committeeChair"]);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([f.meeting]);

      // A concern about the lead is open: no vote opens until it is decided.
      await s.as("legal");
      const [concern] = await s.tx<{ id: string }[]>`
        select api.raise_meeting_conflict(${f.participant.lead!}, 'Synthetic: the lead knows the subject.') as id`;
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([]);
      await s.as("committeeChair");
      await s.tx`select api.decide_meeting_conflict(${concern!.id}, 'DISMISSED', 'Synthetic: no relationship found.')`;
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([f.meeting]);

      // Round 1: every item rejected. Recording the adoption returns the package to DRAFT, which nothing refuses.
      await s.as("committeeSecretary");
      await s.tx`select api.open_package_vote(${f.meeting}, ${pkg!.id})`;
      const round1 = await roundItems(s, pkg!.id);
      expect(round1).toHaveLength(3);
      for (const vi of round1) {
        for (const u of DECISION_VOTERS) {
          await s.as(u);
          await s.tx`select api.cast_vote(${vi}, 'REJECT', null)`;
        }
        await s.as("committeeSecretary");
        await packages(s, cp, ["committeeSecretary", "committeeChair"]);
        await s.as("committeeSecretary");
        await s.tx`select api.close_vote_item(${vi}, null)`;
      }
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[0]!.capabilities.may_record_adoption).toBe(true);
      await s.as("committeeSecretary");
      expect((await s.tx<{ s: string }[]>`select api.record_package_adoption(${pkg!.id}) as s`)[0]!.s).toBe(
        "DRAFT",
      );
      await packages(s, cp);

      // Round 2: the sanction approved without a defence notice to its subject (AMB-026): no adoption until it is
      // issued.
      await s.as("committeeSecretary");
      await s.tx`select api.submit_package_for_vote(${pkg!.id})`;
      await s.tx`select api.open_package_vote(${f.meeting}, ${pkg!.id})`;
      const round2 = await roundItems(s, pkg!.id);
      await s.asOwner();
      const targets = await s.tx<{ id: string; item: string }[]>`
        select id, recommendation_item_id as item from committee.vote_item where id = any(${round2}::uuid[])`;
      for (const vi of round2) {
        const choice = targets.find((t) => t.id === vi)!.item === sanction!.id ? "APPROVE" : "REJECT";
        for (const u of DECISION_VOTERS) {
          await s.as(u);
          await s.tx`select api.cast_vote(${vi}, ${choice}, null)`;
        }
        await s.as("committeeSecretary");
        await s.tx`select api.close_vote_item(${vi}, null)`;
      }
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[0]!.capabilities.may_record_adoption).toBe(false);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:DEFENCE_NOTICE_REQUIRED",
        (tx) => tx`select api.record_package_adoption(${pkg!.id})`,
      );
      await s.as("caseManager");
      await s.tx`select api.issue_defence_notice(${facts.subject}, ${DEFENCE}, ${[facts.allegation]}::uuid[],
        now() + interval '10 days')`;
      await packages(s, cp);
      expect((await secretaryPackages(s, cp))[0]!.capabilities.may_record_adoption).toBe(true);
    });
  });

  it("a quorum the rules leave unset still needs a member present (committee.require_quorum_at_opening)", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      await seat(s, ic, DECISION_SEATS);
      await s.as("platformAdmin");
      await s.tx`select api.set_committee_rule_set(${ic}, now(), 'CUSTOM', null, true, 3, true, null, null,
        'NO_DECISION', 'SOURCE_REQUIRED', ${REASON})`;
      const f = await scheduleMeeting(s, ic, caseB);
      const cp = f.committeeProceeding;
      await declareNone(s, f.meeting, DECISION_VOTERS);
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
      const [pkg] = await s.tx<{ id: string }[]>`
        select api.create_recommendation_package(${cp}, 'PACKAGE') as id`;
      await s.tx`select api.add_recommendation_item(${pkg!.id}, 'OTHER', null, null, 'Synthetic: an item to vote on.',
        null, null)`;
      await s.tx`select api.submit_package_for_vote(${pkg!.id})`;
      // Three eligible, nobody present.
      await packages(s, cp, ["committeeSecretary", "committeeChair"]);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([]);
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${f.participant.lead!}, 'PRESENT')`;
      await packages(s, cp, ["committeeSecretary", "committeeChair"]);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([f.meeting]);
    });
  });

  it("adoption: an approved sanction needs its catalogue version in force and its subjects' defence notices; nothing approved needs neither; a taint holds every package with an approved item (DEC-AMB-003, AMB-026)", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      await seat(s, ic, DECISION_SEATS);
      const facts = await caseFacts(s, caseB);
      const f = await scheduleMeeting(s, ic, caseB);
      const cp = f.committeeProceeding;
      await openWithPresent(s, f, DECISION_VOTERS);
      // Employee Sigma: a defence notice on the first allegation, and only a rights notice on a second. Employee Tau:
      // no allegation and no notice.
      const sigma = facts.subject;
      await s.as("caseManager");
      const [second] = await s.tx<{ id: string }[]>`
        select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: a second allegation against Employee Sigma.',
          ${sigma}, null, null) as id`;
      const [tau] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Employee Tau (synthetic)', 'EMPLOYEE', null) as id`;
      await s.tx`select api.issue_defence_notice(${sigma}, ${DEFENCE}, ${[facts.allegation]}::uuid[],
        now() + interval '10 days')`;
      await s.tx`select api.issue_rights_notice(${sigma}, 'Synthetic: your rights in the investigation.',
        ${[second!.id]}::uuid[])`;
      // A catalogue code whose version is in force while the item is added, and ends before the adoption (owner
      // fixture; see the header).
      await s.asOwner();
      await s.tx`insert into decision.sanction_catalogue (code, source_status)
                 values ('SYNTHETIC_ENDING', 'SOURCE_REQUIRED')`;
      await s.tx`insert into decision.sanction_catalogue_version (code, version_no, subject_categories, effective_from,
                   source_status)
                 values ('SYNTHETIC_ENDING', 1, array['EMPLOYEE'], now() - interval '1 day', 'SOURCE_REQUIRED')`;

      /** A PACKAGE-granularity package of items [type, sanction code, subjects, allegations]; returns their ids. */
      const build = async (items: [string, string | null, string[] | null, string[] | null][]) => {
        await s.as("committeeSecretary");
        const [p] = await s.tx<{ id: string }[]>`
          select api.create_recommendation_package(${cp}, 'PACKAGE') as id`;
        const ids: string[] = [];
        for (const [type, code, subjects, allegations] of items) {
          const [i] = await s.tx<{ id: string }[]>`
            select api.add_recommendation_item(${p!.id}, ${type}, ${code}, null,
              'Synthetic: an item of the adoption test.', ${subjects}::uuid[], ${allegations}::uuid[]) as id`;
          ids.push(i!.id);
        }
        return { pkg: p!.id, items: ids };
      };
      const sanction = (code: string, subject: string, allegations: string[] | null) =>
        ["DISCIPLINARY_SANCTION", code, [subject], allegations] as [
          string,
          string,
          string[],
          string[] | null,
        ];
      // 1. A sanction on Sigma's noticed allegation, and another item naming Tau: Tau's notice is not asked for.
      const k1 = await build([
        sanction("WARNING", sigma, [facts.allegation]),
        ["OTHER", null, [tau!.id], null],
      ]);
      // 2. A sanction naming no allegation: every allegation against Sigma, one with only a rights notice.
      const k2 = await build([sanction("WARNING", sigma, null)]);
      // 3. A sanction on Tau, who has no allegation and no defence notice.
      const k3 = await build([sanction("WARNING", tau!.id, null)]);
      // 4. A sanction whose catalogue version ends after the vote.
      const k4 = await build([sanction("SYNTHETIC_ENDING", sigma, [facts.allegation])]);
      // 5. As 1, with a sanction on Tau withdrawn.
      const k5 = await build([
        sanction("WARNING", sigma, [facts.allegation]),
        sanction("WARNING", tau!.id, null),
      ]);
      await s.as("committeeSecretary");
      await s.tx`select api.withdraw_recommendation_item(${k5.items[1]!}, ${REASON})`;
      // 6. One item, rejected.
      const k6 = await build([["OTHER", null, null, null]]);
      for (const k of [k1, k2, k3, k4, k5, k6]) {
        await s.as("committeeSecretary");
        await s.tx`select api.submit_package_for_vote(${k.pkg})`;
        await voteRound(s, f.meeting, k.pkg, k === k6 ? "REJECT" : "APPROVE");
      }
      await s.asOwner();
      await s.tx`update decision.sanction_catalogue_version set effective_to = now() where code = 'SYNTHETIC_ENDING'`;
      const adoptable = async () =>
        (await secretaryPackages(s, cp)).map((p) => p.capabilities.may_record_adoption);
      await packages(s, cp);
      expect(await adoptable()).toEqual([true, false, false, false, true, true]);
      await s.as("committeeSecretary");
      for (const [k, code] of [
        [k2, "DEFENCE_NOTICE_REQUIRED"],
        [k3, "DEFENCE_NOTICE_REQUIRED"],
        [k4, "SANCTION_NOT_IN_FORCE"],
      ] as const)
        await s.expectError(`CDF_CONFLICT:${code}`, (tx) => tx`select api.record_package_adoption(${k.pkg})`);

      // A conflict upheld on the lead, who voted on every package: only the package that approved nothing is
      // adopted (it goes back to DRAFT, which nothing refuses).
      await upheldOnLead(s, f);
      await packages(s, cp);
      expect(await adoptable()).toEqual([false, false, false, false, false, true]);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:TAINTED_BY_CONFLICT",
        (tx) => tx`select api.record_package_adoption(${k1.pkg})`,
      );
    });
  });

  it("returned by Legal or by the authority, a package is edited and put to the committee again; while with the authority a taint is only confirmed (PACKAGE_WITH_AUTHORITY)", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      const { request } = await requestLegalReview(s, f);
      await s.as("legalB");
      await s.tx`select api.give_legal_opinion(${request}, 'CONFLICTS',
        'Synthetic: the sanction conflicts with the policy.')`;
      await packages(s, cp);
      const returned = (await secretaryPackages(s, cp))[0]!;
      expect(returned.status).toBe("RETURNED_BY_LEGAL");
      expect(returned.capabilities).toEqual({
        may_add_item: true,
        may_record_adoption: false,
        may_return_to_committee: false,
        may_submit_for_vote: true,
      });
    });

    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      const { request } = await requestLegalReview(s, f);
      await s.as("legalB");
      await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await upheldOnLead(s, f.meeting);
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([["CONFIRM"], ["CONFIRM"]]);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:PACKAGE_WITH_AUTHORITY",
        (tx) => tx`select api.resolve_conflict_taint(${f.sanction}, 'RE_VOTE', ${FIRM})`,
      );
      await s.tx`select api.record_authority_decision(${f.pkg}, 'CEO', 'RETURN_TO_COMMITTEE', now(),
        'Authority (synthetic)', 'MEMO-DEMO-2086', null, ${REASON}, null::text, null::text, null::text, null::text[],
        null::jsonb)`;
      await packages(s, cp);
      const back = (await secretaryPackages(s, cp))[0]!;
      expect(back.status).toBe("RETURNED_BY_AUTHORITY");
      expect(back.capabilities).toEqual({
        may_add_item: true,
        may_record_adoption: false,
        may_return_to_committee: false,
        may_submit_for_vote: true,
      });
    });
  });

  it("another proceeding before the same committee: its meetings, its raisers and its open meeting count for nothing here", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      // Case A before the same committee, its meeting open with a quorum.
      const g = await scheduleMeeting(s, ic, await caseId("0001"));
      await openWithPresent(s, g, ["committeeChair", "legal"]);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_package_for_vote(${f.pkg})`;
      await packages(s, cp, PACKAGE_CALLERS, [g.meeting]);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([f.meeting.meeting]);
      await voteRound(s, f.meeting.meeting, f.pkg);
      await s.as("committeeSecretary");
      await s.tx`select api.record_package_adoption(${f.pkg})`;
      await requestLegalReview(s, f);
      // investigatorA, on case A's team, is excluded as a witness here.
      await s.as("committeeSecretary");
      const [w] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${f.meeting.meeting}, 'WITNESS', ${USERS.investigatorA}, null, false, ${REASON}) as id`;
      await s.tx`select api.exclude_meeting_witness(${w!.id}, ${EXCLUSION})`;
      // The secretary raised a concern about legal in case A's meeting (still open there); here the lead raises one
      // about legal, which the chair upholds.
      await s.tx`select api.raise_meeting_conflict(${g.participant.legal!}, 'Synthetic: raised in the other proceeding.')`;
      await s.as("lead");
      const [k] = await s.tx<{ id: string }[]>`
        select api.raise_meeting_conflict(${f.meeting.participant.legal!}, 'Synthetic: legal knows the subject.') as id`;
      await s.as("committeeChair");
      await s.tx`select api.decide_meeting_conflict(${k!.id}, 'UPHELD', 'Synthetic: the relationship is confirmed.')`;
      await packages(s, cp, PACKAGE_CALLERS, [g.meeting]);
      expect(await resolutions(s, cp)).toEqual([["CONFIRM"], ["CONFIRM"]]);
      // This proceeding's meeting closes: case A's open meeting is not where its taint is resolved.
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting.meeting}, ${REASON})`;
      await packages(s, cp, PACKAGE_CALLERS, [g.meeting]);
      expect(await resolutions(s, cp)).toEqual([[], []]);
      // Case A's invite list: neither this proceeding's legal reviewer nor its witness exclusion counts there.
      await invites(s, g.meeting);
      const list = await runnersList(s, g.meeting);
      expect(list.accounts.some((x) => x.user_id === USERS.legalB)).toBe(false);
      expect(list.accounts.some((x) => x.user_id === USERS.investigatorA)).toBe(true);
    });
  });

  it("the alternate secretary runs the packages but not a meeting they are not acting in; a conflict declared anywhere in the proceeding takes the packages from them; a proceeding no longer open takes no new package; a case no longer active takes nothing", async () => {
    // Not acting in the open meeting: no vote opens there and no taint is resolved for them, until it is handed over.
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      await alternateSecretary(s, false);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_package_for_vote(${f.pkg})`;
      await packages(s, cp, WITH_ALTERNATE);
      expect((await itemsView(s, "investigatorA", cp))!.packages[0]!.open_vote_in).toEqual([]);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([f.meeting.meeting]);
      await voteRound(s, f.meeting.meeting, f.pkg);
      await s.as("committeeSecretary");
      await s.tx`select api.record_package_adoption(${f.pkg})`;
      await upheldOnLead(s, f.meeting);
      await packages(s, cp, WITH_ALTERNATE);
      expect(await resolutions(s, cp, "investigatorA")).toEqual([[], []]);
      expect(await resolutions(s, cp)).toEqual([
        ["RE_VOTE", "CONFIRM"],
        ["RE_VOTE", "CONFIRM"],
      ]);
      await s.as("committeeSecretary");
      await s.tx`select api.activate_acting_secretary(${f.meeting.meeting}, ${REASON})`;
      await packages(s, cp, WITH_ALTERNATE);
      expect(await resolutions(s, cp, "investigatorA")).toEqual([
        ["RE_VOTE", "CONFIRM"],
        ["RE_VOTE", "CONFIRM"],
      ]);
    });

    // Acting secretary and on the case team: they declare a conflict as a witness in another meeting of the
    // proceeding, and still read the packages through the case, with nothing to do on them.
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      await alternateSecretary(s, true);
      await s.as("committeeSecretary");
      await s.tx`select api.activate_acting_secretary(${f.meeting.meeting}, ${REASON})`;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      await upheldOnLead(s, f.meeting);
      await s.as("committeeSecretary");
      const [second] = await s.tx<{ id: string }[]>`
        select api.create_recommendation_package(${cp}, 'PACKAGE') as id`;
      await s.tx`select api.add_recommendation_item(${second!.id}, 'OTHER', null, null,
        'Synthetic: an item of the second package.', null, null)`;
      await s.tx`select api.submit_package_for_vote(${second!.id})`;
      await packages(s, cp, WITH_ALTERNATE);
      let alternate = (await itemsView(s, "investigatorA", cp))!;
      expect(alternate.capabilities.may_create_package).toBe(true);
      expect(alternate.packages.map((p) => p.open_vote_in)).toEqual([[], [f.meeting.meeting]]);
      const next = await anotherMeeting(s, cp);
      await s.as("committeeSecretary");
      const [w] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${next}, 'WITNESS', ${USERS.investigatorA}, null, true, ${REASON}) as id`;
      await s.as("investigatorA");
      await s.tx`select api.declare_meeting_conflict(${w!.id}, 'CONFLICT_DECLARED', ${REASON})`;
      await packages(s, cp, WITH_ALTERNATE);
      alternate = (await itemsView(s, "investigatorA", cp))!;
      expect(alternate.capabilities.may_create_package).toBe(false);
      expect(alternate.packages.map((p) => p.open_vote_in)).toEqual([[], []]);
      expect(await resolutions(s, cp, "investigatorA")).toEqual([[], [], []]);
    });

    // On the case team: the committee's proceeding concludes, then the case is screened out.
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      await alternateSecretary(s, true);
      await s.asOwner();
      const [own] = await s.tx<{ proceeding_id: string }[]>`
        select proceeding_id from committee.committee_proceeding where id = ${cp}`;
      await s.as("caseManager");
      await s.tx`select api.close_proceeding(${own!.proceeding_id}, 'CONCLUDED', 'DECISION_RECORDED', ${REASON})`;
      await packages(s, cp, WITH_ALTERNATE);
      expect((await itemsView(s, "investigatorA", cp))!.capabilities.may_create_package).toBe(false);
      await concludeProceedings(s, caseB);
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', ${REASON})`;
      await packages(s, cp, WITH_ALTERNATE);
      for (const p of (await itemsView(s, "investigatorA", cp))!.packages)
        expect(Object.values(p.capabilities).every((x) => x === false)).toBe(true);
    });
  });
});

describe("api.committee_items_view: resolving a conflict taint (DEC-AMB-003, DEC-AMB-013)", () => {
  it("a decisive taint after adoption: the secretary may only re-vote; once recorded, no taint is left and the package is a draft again", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f, decisive)).toBe("ADOPTED");
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([[], []]);
      await upheldOnLead(s, f.meeting);
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([["RE_VOTE"], ["RE_VOTE"]]);
      expect(await resolutions(s, cp, "committeeChair")).toEqual([[], []]);
      await s.as("committeeSecretary");
      await s.tx`select api.resolve_conflict_taint(${f.sanction}, 'RE_VOTE', ${FIRM})`;
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([[], []]);
      expect((await secretaryPackages(s, cp))[0]!.status).toBe("DRAFT");
    });
  });

  it("a taint the recount confirms: re-vote or confirm while a meeting of the proceeding is open; nothing while none is; the raiser never resolves", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      // The secretary raised a concern about legal, which the chair dismissed: that makes them no raiser about the
      // lead.
      await s.as("committeeSecretary");
      const [aboutLegal] = await s.tx<{ id: string }[]>`
        select api.raise_meeting_conflict(${f.meeting.participant.legal!}, 'Synthetic: legal may know the subject.') as id`;
      await s.as("committeeChair");
      await s.tx`select api.decide_meeting_conflict(${aboutLegal!.id}, 'DISMISSED', 'Synthetic: no relationship found.')`;
      await upheldOnLead(s, f.meeting);
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([
        ["RE_VOTE", "CONFIRM"],
        ["RE_VOTE", "CONFIRM"],
      ]);

      // The meeting closes: the resolution is the committee's, recorded in an open meeting of the proceeding.
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting.meeting}, ${REASON})`;
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([[], []]);
      const next = await anotherMeeting(s, cp);
      await declareNone(s, next, ["committeeChair", "legal"]);
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${next}, ${REASON})`;
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([
        ["RE_VOTE", "CONFIRM"],
        ["RE_VOTE", "CONFIRM"],
      ]);
      await s.as("committeeSecretary");
      await s.tx`select api.resolve_conflict_taint(${f.corrective}, 'CONFIRM', ${FIRM})`;
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([[], []]);
      expect((await secretaryPackages(s, cp))[0]!.status).toBe("ADOPTED");
    });

    // Whoever raised the conflict does not resolve it (FORBIDDEN): here the secretary.
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      await upheldOnLead(s, f.meeting, "committeeSecretary");
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([[], []]);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.resolve_conflict_taint(${f.sanction}, 'CONFIRM', ${FIRM})`,
      );
    });
  });

  it("with Legal: the taint may be confirmed but not re-voted (LEGAL_REVIEW_OPEN)", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      await requestLegalReview(s, f);
      await upheldOnLead(s, f.meeting);
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([["CONFIRM"], ["CONFIRM"]]);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:LEGAL_REVIEW_OPEN",
        (tx) => tx`select api.resolve_conflict_taint(${f.sanction}, 'RE_VOTE', ${FIRM})`,
      );
    });
  });

  it("after the authority decided (DEC-AMB-013): a decisive taint is re-voted, never confirmed, and the package goes back to the committee without the conflicted member; a taint the recount confirms is only confirmed", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f, decisive)).toBe("ADOPTED");
      await decided(s, f);
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([[], []]);
      const concern = await upheldOnLead(s, f.meeting);
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([["RE_VOTE"], ["RE_VOTE"]]);
      await s.as("committeeSecretary");
      await s.tx`select api.resolve_conflict_taint(${f.sanction}, 'RE_VOTE', ${FIRM})`;
      // Back with the committee in round 2: the vote opens without the lead, who is excluded from it.
      await packages(s, cp);
      const pkg = (await secretaryPackages(s, cp))[0]!;
      expect([pkg.status, pkg.round_no]).toEqual(["VOTING", 2]);
      expect(pkg.open_vote_in).toEqual([f.meeting.meeting]);

      // The determination on the lead is reversed, and in the next meeting they declare no conflict and attend. The
      // re-vote still leaves them out, so the chair alone is short of a quorum of the chair and legal.
      await reversed(s, concern);
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting.meeting}, ${REASON})`;
      const next = await anotherMeeting(s, cp);
      await declareNone(s, next, DECISION_VOTERS);
      await s.asOwner();
      const there = await s.tx<{ id: string; user_id: string }[]>`
        select id, user_id from committee.meeting_participant where meeting_id = ${next}`;
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${next}, ${REASON})`;
      for (const u of ["committeeChair", "lead"] as const)
        await s.tx`select api.record_attendance(${there.find((r) => r.user_id === USERS[u])!.id}, 'PRESENT')`;
      await packages(s, cp, ["committeeSecretary", "committeeChair", "lead"]);
      expect((await secretaryPackages(s, cp))[0]!.open_vote_in).toEqual([]);
    });

    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      await decided(s, f);
      await upheldOnLead(s, f.meeting);
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([["CONFIRM"], ["CONFIRM"]]);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:RESULT_UNCHANGED",
        (tx) => tx`select api.resolve_conflict_taint(${f.sanction}, 'RE_VOTE', ${FIRM})`,
      );
    });
  });

  it("ITEM granularity with a vote of the round still open: a taint on a closed vote is confirmed, not re-voted (VOTE_IN_PROGRESS)", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB, "ITEM");
      const cp = f.meeting.committeeProceeding;
      await s.as("committeeSecretary");
      await s.tx`select api.submit_package_for_vote(${f.pkg})`;
      await s.tx`select api.open_package_vote(${f.meeting.meeting}, ${f.pkg})`;
      const [first] = await roundItems(s, f.pkg);
      for (const u of DECISION_VOTERS) {
        await s.as(u);
        await s.tx`select api.cast_vote(${first!}, 'APPROVE', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${first!}, null)`;
      // The lead declares a conflict in another meeting of the proceeding: the closed vote is tainted.
      const next = await anotherMeeting(s, cp);
      await s.asOwner();
      const [leadThere] = await s.tx<{ id: string }[]>`
        select id from committee.meeting_participant where meeting_id = ${next} and user_id = ${USERS.lead}`;
      await s.as("lead");
      await s.tx`select api.declare_meeting_conflict(${leadThere!.id}, 'CONFLICT_DECLARED', ${REASON})`;
      await packages(s, cp);
      expect(await resolutions(s, cp)).toEqual([["CONFIRM"], []]);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:VOTE_IN_PROGRESS",
        (tx) => tx`select api.resolve_conflict_taint(${f.sanction}, 'RE_VOTE', ${FIRM})`,
      );
    });
  });

  it("a voter whose determination was reversed, now the alternate secretary acting in an open meeting, still does not resolve the taint their own vote left", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      await reversed(s, await upheldOnLead(s, f.meeting));
      // The lead leaves their member seat for the alternate secretary's.
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(m.id, now(), ${REASON}) from committee.membership m
                 where m.committee_id = ${ic} and m.user_id = ${USERS.lead} and m.ended_at is null`;
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.lead}, 'ALTERNATE_SECRETARY', now(), null,
        'DEMO-APPT')`;
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting.meeting}, ${REASON})`;
      const next = await anotherMeeting(s, cp);
      await declareNone(s, next, ["committeeChair", "legal"]);
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${next}, ${REASON})`;
      await s.tx`select api.activate_acting_secretary(${next}, ${REASON})`;
      await packages(s, cp);
      expect(await resolutions(s, cp, "lead")).toEqual([[], []]);
      expect(await resolutions(s, cp)).toEqual([
        ["RE_VOTE", "CONFIRM"],
        ["RE_VOTE", "CONFIRM"],
      ]);
    });
  });

  it("after the authority decided, item by item: a voter whose vote still taints the decided round, now the alternate secretary, re-votes no item, not even one their vote no longer taints (FORBIDDEN)", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const f = await draftPackage(s, ic, caseB, "ITEM");
      const cp = f.meeting.committeeProceeding;
      // The sanction passes two to one, the lead against; the corrective action passes unanimously.
      expect(
        await voteOnPackage(s, f, (target, voter) =>
          target === f.sanction && voter === "lead" ? "REJECT" : "APPROVE",
        ),
      ).toBe("ADOPTED");
      await decided(s, f);
      const concern = await upheldOnLead(s, f.meeting);
      // Without the lead both results stand. The secretary confirms the sanction's and leaves the corrective action's.
      expect(await resolutions(s, cp)).toEqual([["CONFIRM"], ["CONFIRM"]]);
      await s.as("committeeSecretary");
      await s.tx`select api.resolve_conflict_taint(${f.sanction}, 'CONFIRM', ${FIRM})`;
      expect(await resolutions(s, cp)).toEqual([[], ["CONFIRM"]]);

      // The determination on the lead is reversed, and the lead leaves their member seat for the alternate
      // secretary's, acting in the next meeting.
      await reversed(s, concern);
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(m.id, now(), ${REASON}) from committee.membership m
                 where m.committee_id = ${ic} and m.user_id = ${USERS.lead} and m.ended_at is null`;
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.lead}, 'ALTERNATE_SECRETARY', now(), null,
        'DEMO-APPT')`;
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting.meeting}, ${REASON})`;
      const next = await anotherMeeting(s, cp);
      await declareNone(s, next, ["committeeChair", "legal"]);
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${next}, ${REASON})`;
      await s.tx`select api.activate_acting_secretary(${next}, ${REASON})`;

      // Legal, whose vote decided the sanction, declares a conflict in a later meeting of the proceeding.
      const later = await anotherMeeting(s, cp, 3);
      await s.asOwner();
      const [legalThere] = await s.tx<{ id: string }[]>`
        select id from committee.meeting_participant where meeting_id = ${later} and user_id = ${USERS.legal}`;
      await s.as("legal");
      await s.tx`select api.declare_meeting_conflict(${legalThere!.id}, 'CONFLICT_DECLARED', ${REASON})`;
      await packages(s, cp);
      // The secretary may have the sanction voted again, without legal and the lead, whose votes taint the round.
      expect((await resolutions(s, cp))[0]).toEqual(["RE_VOTE"]);
      // The lead's vote no longer taints the sanction's vote, but it taints the round through the corrective action's:
      // they resolve neither.
      expect(await resolutions(s, cp, "lead")).toEqual([[], []]);
      await s.as("lead");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.resolve_conflict_taint(${f.sanction}, 'RE_VOTE', ${FIRM})`,
      );
    });
  });
});

// ---- M2: api.meeting_invite_choices -----------------------------------------------------------------------------

const ROLES = ["WITNESS", "EXPERT", "LEGAL", "INFORMATION_PROVIDER", "SUBJECT", "INTERPRETER"];
const PERSON_KEYS = ["case_roles", "invitee_roles", "label", "person_id", "position"];
const ACCOUNT_KEYS = ["bases", "display_name", "display_name_ar", "invitee_roles", "user_id"];

interface InvitePerson {
  person_id: string;
  position: number;
  case_roles: string[];
  label: string | null;
  invitee_roles: string[];
}
interface InviteAccount {
  user_id: string;
  display_name: string;
  display_name_ar: string | null;
  bases: string[];
  invitee_roles: string[];
}
interface InviteChoices {
  meeting_id: string;
  label_mode: string;
  persons: InvitePerson[];
  accounts: InviteAccount[];
}

/** Callers of the invite sweep: the runner, the chair, members, a legal reviewer, the case team, the case manager,
 *  administrators and an inactive account. */
const INVITE_CALLERS: UserKey[] = [
  "committeeSecretary",
  "committeeChair",
  "legal",
  "lead",
  "legalB",
  "investigatorB",
  "caseManager",
  "platformAdmin",
  "grcDirector",
  "revoked",
];
/** Accounts on no basis, probed beside the candidates: the command may accept them; the list never shows them. */
const OUTSIDERS: UserKey[] = ["caseManager", "investigatorA", "employee", "grcDeputy"];

/** The caller's invite choices, or the refusal; savepointed, so a refusal leaves the transaction usable. */
async function inviteChoices(
  s: OwnerScenario,
  user: UserKey,
  meeting: string,
): Promise<{ v: InviteChoices | null; error: string | null }> {
  await s.as(user);
  let v: InviteChoices | null = null;
  let error: string | null = null;
  try {
    await s.tx.savepoint(async (sp) => {
      const [r] = await sp<{ v: InviteChoices }[]>`select api.meeting_invite_choices(${meeting}) as v`;
      v = r!.v;
    });
  } catch (e) {
    error = (e as Error).message;
    if (!error.startsWith("CDF_")) throw e;
  }
  return { v, error };
}

const byName = (
  a: { display_name: string; user_id: string },
  b: { display_name: string; user_id: string },
) =>
  a.display_name < b.display_name
    ? -1
    : a.display_name > b.display_name
      ? 1
      : a.user_id < b.user_id
        ? -1
        : a.user_id > b.user_id
          ? 1
          : 0;

/** M2 for `meeting` in its current state, for each caller (see the header). */
async function invites(
  s: OwnerScenario,
  meeting: string,
  callers: UserKey[] = INVITE_CALLERS,
): Promise<void> {
  await s.asOwner();
  const [m] = await s.tx<{ case_id: string; case_number: string; cp: string; mode: string }[]>`
    select m.case_id, c.case_number, m.committee_proceeding_id as cp, decision.committee_label_mode() as mode
    from committee.meeting m join case_mgmt.case_record c on c.id = m.case_id where m.id = ${meeting}`;
  const { case_id: caseOf, case_number: caseNumber, cp, mode } = m!;
  // The case's persons in the order they joined the case: their position.
  const persons = await s.tx<
    {
      person_id: string;
      case_roles: string[];
      display_name: string;
      department: string | null;
      user_id: string | null;
    }[]
  >`
    select x.person_id, x.case_roles, pe.display_name, pe.department, pe.user_id
    from (select cp.person_id, array_agg(distinct cp.role order by cp.role) as case_roles, min(cp.added_at) as first
          from case_mgmt.case_person cp where cp.case_id = ${caseOf} group by cp.person_id) x
    join case_mgmt.person pe on pe.id = x.person_id
    order by x.first, x.person_id`;
  // The ruled bases: the case team's active assignments and the legal reviewers of the proceeding's packages.
  const bases = await s.tx<{ user_id: string; display_name: string; bases: string[] }[]>`
    select y.user_id, u.display_name, array_agg(distinct y.basis order by y.basis) as bases
    from (select a.user_id, 'CASE_TEAM' as basis from case_mgmt.case_assignment a
          where a.case_id = ${caseOf} and a.status = 'ACTIVE'
            and a.assignment_role in ('CASE_OWNER', 'LEAD_INVESTIGATOR', 'INVESTIGATOR')
          union all
          select r.assigned_to, 'LEGAL_REVIEW' from decision.legal_review_request r
          join decision.recommendation_package p on p.id = r.package_id
          where p.committee_proceeding_id = ${cp} and r.status <> 'CANCELLED') y
    join iam.user_profile u on u.id = y.user_id
    group by y.user_id, u.display_name`;
  // The coordinator's narrowings (2026-10-15 00:23): a conflict that counts, or a witness exclusion, in a meeting of
  // the proceeding.
  const narrowed = new Set(
    (
      await s.tx<{ id: string }[]>`
        select coalesce(mp.person_id, mp.user_id) as id from committee.meeting_participant mp
        join committee.meeting om on om.id = mp.meeting_id
        where om.committee_proceeding_id = ${cp}
          and ((mp.coi_status = 'CONFLICT_DECLARED' and committee.conflict_counts(mp.id))
               or exists (select 1 from committee.witness_exclusion w where w.participant_id = mp.id))`
    ).map((r) => r.id),
  );
  const accounts = [
    ...bases.map((b) => b.user_id),
    ...OUTSIDERS.map((u) => USERS[u] as string).filter((u) => !bases.some((b) => b.user_id === u)),
  ];

  for (const user of callers) {
    const before = await ledger(s);
    const { v, error } = await inviteChoices(s, user, meeting);
    const written = (await ledger(s)) - before;
    const probes: Record<string, string> = {};
    for (const p of persons)
      for (const r of ROLES)
        probes[`${p.person_id}:${r}`] =
          `select api.invite_to_meeting('${meeting}', '${r}', null, '${p.person_id}', ${r === "INTERPRETER"}, '${REASON}')`;
    for (const u of accounts)
      for (const r of ROLES)
        probes[`${u}:${r}`] =
          `select api.invite_to_meeting('${meeting}', '${r}', '${u}', null, ${r === "INTERPRETER"}, '${REASON}')`;
    const o = await outcomes(s, user, probes);
    const accepted = (id: string) => ROLES.filter((r) => o[`${id}:${r}`] === true);

    if (error !== null) {
      // Refused as the command refuses, before any choice of invitee: every probe gives the same answer.
      expect(v, `${user}: nothing listed`).toBeNull();
      expect(written, `${user}: a refusal writes nothing`).toBe(0);
      for (const [k, out] of Object.entries(o))
        expect(out, `${user} ${k}: the command's refusal`).toBe(error);
      continue;
    }
    const view = v!;
    expect(Object.keys(view).sort(), `${user}: the read's keys`).toEqual([
      "accounts",
      "label_mode",
      "meeting_id",
      "persons",
    ]);
    expect([view.meeting_id, view.label_mode], `${user}: the meeting and the label mode`).toEqual([
      meeting,
      mode,
    ]);

    // Persons: exactly those the command accepts for a role and no narrowing excludes, in position order.
    const listedPersons = persons
      .map((p, i) => ({ ...p, position: i + 1 }))
      .filter((p) => !narrowed.has(p.person_id) && accepted(p.person_id).length > 0);
    expect(
      view.persons.map((p) => p.person_id),
      `${user}: the persons listed`,
    ).toEqual(listedPersons.map((p) => p.person_id));
    for (const p of view.persons) {
      const e = listedPersons.find((x) => x.person_id === p.person_id)!;
      expect(Object.keys(p).sort(), `${user}: a person's keys`).toEqual(PERSON_KEYS);
      expect(p, `${user}: person ${e.position}`).toEqual({
        person_id: e.person_id,
        position: e.position,
        case_roles: e.case_roles,
        label: mode === "DISPLAY_NAME" ? e.display_name : null,
        invitee_roles: accepted(e.person_id),
      });
    }

    // Accounts: only the bases; exactly those the command accepts for a role and no narrowing excludes, by name.
    const listedAccounts = bases
      .filter((b) => !narrowed.has(b.user_id) && accepted(b.user_id).length > 0)
      .sort(byName);
    expect(
      view.accounts.map((x) => x.user_id),
      `${user}: the accounts listed`,
    ).toEqual(listedAccounts.map((b) => b.user_id));
    for (const x of view.accounts) {
      expect(Object.keys(x).sort(), `${user}: an account's keys`).toEqual(ACCOUNT_KEYS);
      expect(x.bases, `${user}: the bases of ${x.display_name}`).toEqual(
        bases.find((b) => b.user_id === x.user_id)!.bases,
      );
      expect(x.invitee_roles, `${user}: the roles of ${x.display_name}`).toEqual(accepted(x.user_id));
    }
    for (const u of OUTSIDERS)
      if (!bases.some((b) => b.user_id === USERS[u]))
        expect(
          view.accounts.some((x) => x.user_id === USERS[u]),
          `${user}: ${u} is on no basis`,
        ).toBe(false);

    // Never the case; in ORDINAL mode nothing that names a case person or links them to an account.
    const text = JSON.stringify(view);
    expect(text, `${user}: the case id`).not.toContain(caseOf);
    expect(text, `${user}: the case number`).not.toContain(caseNumber);
    for (const p of persons) {
      if (mode !== "DISPLAY_NAME") expect(text, `${user}: a person's name`).not.toContain(p.display_name);
      if (p.department) expect(text, `${user}: a person's department`).not.toContain(p.department);
      if (p.user_id && !view.accounts.some((x) => x.user_id === p.user_id))
        expect(text, `${user}: a person's account`).not.toContain(p.user_id);
    }

    // One audit event, with counts only.
    expect(written, `${user}: one ledger row`).toBe(1);
    const ev = (await events(s, "MEETING_INVITE_CHOICES_VIEWED")).at(-1)!;
    expect(ev, `${user}: the audit event`).toMatchObject({
      actor_id: USERS[user],
      case_id: caseOf,
      category: "BUSINESS",
      outcome: "SUCCESS",
      object_type: "meeting",
      object_id: meeting,
      reason: null,
    });
    expect(ev.metadata, `${user}: counts only`).toEqual({
      persons: view.persons.length,
      accounts: view.accounts.length,
      case_team: view.accounts.filter((x) => x.bases.includes("CASE_TEAM")).length,
      legal_review: view.accounts.filter((x) => x.bases.includes("LEGAL_REVIEW")).length,
    });
  }
}

/** A person of case B without an account, added by the case manager as a subject; returns the subject and person. */
async function person(s: OwnerScenario, label: string): Promise<{ subject: string; person: string }> {
  await s.as("caseManager");
  const [sub] = await s.tx<{ id: string }[]>`
    select api.add_case_subject(${caseB}, ${label}, 'EMPLOYEE', null) as id`;
  await s.asOwner();
  const [row] = await s.tx<{ person_id: string }[]>`
    select person_id from case_mgmt.case_subject where id = ${sub!.id}`;
  return { subject: sub!.id, person: row!.person_id };
}

/** The owner's recorded decision on the DEC-02 label card adopts display names (test fixture; the card is open). */
async function displayNames(s: OwnerScenario): Promise<void> {
  await s.asOwner();
  await s.tx`update decision.committee_label_policy set effective_to = now() where effective_to is null`;
  await s.tx`insert into decision.committee_label_policy (effective_from, label_mode, owner_decision_reference)
             values (now(), 'DISPLAY_NAME', 'SYNTHETIC-TEST owner decision fixture')`;
}

/** The runner's (committeeSecretary's) list. */
async function runnersList(s: OwnerScenario, meeting: string): Promise<InviteChoices> {
  const { v, error } = await inviteChoices(s, "committeeSecretary", meeting);
  expect(error).toBeNull();
  return v!;
}

/** The seeded confidentiality acknowledgement of each invitee type. */
const ACKNOWLEDGES: Record<string, boolean> = {
  WITNESS: true,
  EXPERT: true,
  LEGAL: false,
  INFORMATION_PROVIDER: false,
  SUBJECT: false,
  INTERPRETER: true,
};

/** Exactly `roles` are enabled, as the committee administrator sets them. */
async function enableOnly(s: Scenario, roles: string[]): Promise<void> {
  await s.as("platformAdmin");
  for (const r of ROLES)
    await s.tx`select api.set_invitee_type_rule(${r}, ${roles.includes(r)}, ${ACKNOWLEDGES[r]!}, null,
      'SOURCE_REQUIRED', ${REASON})`;
}

describe("api.meeting_invite_choices (migration 2086, ADR-056)", () => {
  it("lists the case's persons and the ruled bases only, each with the roles the command accepts; a conflict or a witness exclusion in the proceeding narrows them out; ORDINAL names nobody", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      const meeting = f.meeting.meeting;
      await s.asOwner();
      const [sigma] = await s.tx<{ person_id: string }[]>`
        select person_id from case_mgmt.case_subject where id = ${f.subject}`;

      // 1. The case's one person, and the case team: investigatorB. Never a directory: the case manager, whom the
      //    command accepts, is on no basis, nor is a reviewer of the case or an investigator whose assignment ended.
      await s.as("caseManager");
      await s.tx`select api.assign_case(${caseB}, ${USERS.grcDirector}, 'REVIEWER', ${REASON})`;
      const [ended] = await s.tx<{ id: string }[]>`
        select api.assign_case(${caseB}, ${USERS.investigatorA}, 'INVESTIGATOR', ${REASON}) as id`;
      await s.tx`select api.end_assignment(${ended!.id}, ${REASON})`;
      await invites(s, meeting);
      let list = await runnersList(s, meeting);
      expect(list.label_mode).toBe("ORDINAL");
      expect(list.persons).toEqual([
        {
          person_id: sigma!.person_id,
          position: 1,
          case_roles: ["SUBJECT"],
          label: null,
          invitee_roles: ["WITNESS", "EXPERT", "INFORMATION_PROVIDER", "SUBJECT"],
        },
      ]);
      expect(list.accounts.map((x) => [x.user_id, x.bases, x.invitee_roles])).toEqual([
        [USERS.investigatorB, ["CASE_TEAM"], ["WITNESS", "EXPERT", "LEGAL", "INFORMATION_PROVIDER"]],
      ]);
      expect(
        (
          await outcomes(s, "committeeSecretary", {
            cm: `select api.invite_to_meeting('${meeting}', 'WITNESS', '${USERS.caseManager}', null, false, '${REASON}')`,
          })
        ).cm,
      ).toBe(true);
      await s.as("committeeSecretary");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.meeting_invite_choices(${randomUUID()})`);

      // 2. Two more persons, one linked to a portal account; the witness invited leaves the list.
      const omega = await person(s, "Witness Omega (synthetic)");
      const tau = await person(s, "Employee Tau (synthetic)");
      await s.as("caseManager");
      await s.tx`select api.link_subject_portal_account(${tau.subject}, ${USERS.employee}, ${REASON})`;
      await s.as("committeeSecretary");
      const [omegaIn] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${meeting}, 'WITNESS', null, ${omega.person}, true, ${REASON}) as id`;
      await invites(s, meeting);
      // Positions follow the order the persons joined the case (here one transaction, so the tie-break by id).
      list = await runnersList(s, meeting);
      expect(list.persons.map((p) => p.person_id).sort()).toEqual([sigma!.person_id, tau.person].sort());
      expect(list.persons.some((p) => p.person_id === omega.person)).toBe(false);

      // 3. The package adopted and with Legal: legalB joins the list on the legal review basis.
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      const { request } = await requestLegalReview(s, f);
      await invites(s, meeting);
      list = await runnersList(s, meeting);
      expect(new Map(list.accounts.map((x) => [x.user_id, x.bases]))).toEqual(
        new Map([
          [USERS.investigatorB, ["CASE_TEAM"]],
          [USERS.legalB, ["LEGAL_REVIEW"]],
        ]),
      );

      // 4. The case manager takes the case; they, investigatorB and a third person are invited, and leave the list.
      //    investigatorB declares a conflict, a conflict is upheld on the person, and the case manager and the first
      //    witness are excluded. In the proceeding's next meeting none of them is listed, though none is in it; the
      //    other persons and legalB are. Once the determination on the person is reversed, it is listed again.
      await s.as("caseManager");
      await s.tx`select api.assign_case(${caseB}, ${USERS.caseManager}, 'CASE_OWNER', ${REASON})`;
      const kappa = await person(s, "Witness Kappa (synthetic)");
      await s.as("committeeSecretary");
      const witness = async (user: string | null, who: string | null, coi: boolean) =>
        (
          await s.tx<{ id: string }[]>`
            select api.invite_to_meeting(${meeting}, 'WITNESS', ${user}::uuid, ${who}::uuid, ${coi}, ${REASON}) as id`
        )[0]!.id;
      const ibIn = await witness(USERS.investigatorB, null, true);
      const cmIn = await witness(USERS.caseManager, null, false);
      const kappaIn = await witness(null, kappa.person, true);
      await invites(s, meeting);
      list = await runnersList(s, meeting);
      expect(list.persons.map((p) => p.person_id).sort()).toEqual([sigma!.person_id, tau.person].sort());
      expect(list.accounts.map((x) => x.user_id)).toEqual([USERS.legalB]);
      await s.as("investigatorB");
      await s.tx`select api.declare_meeting_conflict(${ibIn}, 'CONFLICT_DECLARED', ${REASON})`;
      await s.as("legal");
      const [onKappa] = await s.tx<{ id: string }[]>`
        select api.raise_meeting_conflict(${kappaIn}, 'Synthetic: the witness is related to the subject.') as id`;
      await s.as("committeeChair");
      await s.tx`select api.decide_meeting_conflict(${onKappa!.id}, 'UPHELD', 'Synthetic: the relationship is confirmed.')`;
      await s.as("committeeSecretary");
      await s.tx`select api.exclude_meeting_witness(${omegaIn!.id}, ${EXCLUSION})`;
      await s.tx`select api.exclude_meeting_witness(${cmIn}, ${EXCLUSION})`;
      const next = await anotherMeeting(s, f.meeting.committeeProceeding);
      await invites(s, next);
      list = await runnersList(s, next);
      expect(list.persons.map((p) => p.person_id).sort()).toEqual([sigma!.person_id, tau.person].sort());
      expect(list.accounts.map((x) => x.user_id)).toEqual([USERS.legalB]);
      await reversed(s, onKappa!.id);
      await invites(s, next, ["committeeSecretary", "committeeChair"]);
      list = await runnersList(s, next);
      expect(list.persons.map((p) => p.person_id).sort()).toEqual(
        [sigma!.person_id, tau.person, kappa.person].sort(),
      );

      // 5. Invitee types: an interpreter enabled (with a conflict declaration), the expert type disabled.
      await s.as("platformAdmin");
      await s.tx`select api.set_invitee_type_rule('INTERPRETER', true, true, null, 'SOURCE_REQUIRED', ${REASON})`;
      await s.tx`select api.set_invitee_type_rule('EXPERT', false, true, null, 'OWNER_DEFAULT', ${REASON})`;
      await invites(s, next);
      list = await runnersList(s, next);
      for (const p of list.persons)
        expect(p.invitee_roles).toEqual(["WITNESS", "INFORMATION_PROVIDER", "SUBJECT", "INTERPRETER"]);
      expect(list.accounts[0]!.invitee_roles).toEqual([
        "WITNESS",
        "LEGAL",
        "INFORMATION_PROVIDER",
        "INTERPRETER",
      ]);
      //    With no role an account may take, no account is listed; with none a person may take, no person.
      await enableOnly(s, ["SUBJECT"]);
      await invites(s, next, ["committeeSecretary"]);
      expect((await runnersList(s, next)).accounts).toEqual([]);
      await enableOnly(s, ["LEGAL"]);
      await invites(s, next, ["committeeSecretary"]);
      expect((await runnersList(s, next)).persons).toEqual([]);
      await enableOnly(s, ["WITNESS", "LEGAL", "INFORMATION_PROVIDER", "SUBJECT", "INTERPRETER"]);
      //    legalB suspended fails the case gate; their review cancelled leaves them on no basis.
      await s.as("platformAdmin");
      await s.tx`select api.set_user_status(${USERS.legalB}, 'SUSPENDED', 'Synthetic: access review, invite test.')`;
      await invites(s, next, ["committeeSecretary"]);
      expect((await runnersList(s, next)).accounts).toEqual([]);
      await s.as("platformAdmin");
      await s.tx`select api.set_user_status(${USERS.legalB}, 'ACTIVE', 'Synthetic: access review, invite test.')`;
      await s.as("committeeSecretary");
      await s.tx`select api.cancel_legal_review_request(${request}, ${REASON})`;
      await invites(s, next, ["committeeSecretary"]);
      expect((await runnersList(s, next)).accounts).toEqual([]);

      // 6. DISPLAY_NAME, once the owner's decision is recorded (a fixture here: the DEC-02 card is open): the
      //    persons carry their names, and nothing else changes.
      await displayNames(s);
      await invites(s, next, ["committeeSecretary", "committeeChair"]);
      list = await runnersList(s, next);
      expect(list.label_mode).toBe("DISPLAY_NAME");
      expect(list.persons.map((p) => p.label).sort()).toEqual([
        "Employee Sigma (synthetic)",
        "Employee Tau (synthetic)",
        "Witness Kappa (synthetic)",
      ]);

      // 7. The next meeting cancelled: MEETING_NOT_ACTIVE, as the command answers.
      await s.as("committeeSecretary");
      await s.tx`select api.cancel_meeting(${next}, ${REASON})`;
      await invites(s, next);
      expect((await inviteChoices(s, "committeeSecretary", next)).error).toBe(
        "CDF_CONFLICT:MEETING_NOT_ACTIVE",
      );
    });
  });

  it("a firewall-restricted member of the grievance proceeding, on the case team, is offered only the roles the command accepts (WITNESS, EXPERT, INFORMATION_PROVIDER), and every account role in the Investigation Committee's proceeding; neither proceeding's narrowings count in the other", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      // grcDeputy joins the Investigation Committee's proceeding of case B after its meeting was scheduled, so is not
      // in that meeting; voting there makes them firewall-restricted on the Grievance Committee's proceeding. They own
      // the case.
      await seat(s, ic, IC_SEATS);
      const icm = await scheduleMeeting(s, ic, caseB);
      await s.as("platformAdmin");
      const [membership] = await s.tx<{ id: string }[]>`
        select api.appoint_committee_member(${ic}, ${USERS.grcDeputy}, 'MEMBER', now() - interval '1 day', null,
          'DEMO-APPT') as id`;
      await s.as("committeeSecretary");
      await s.tx`select api.amend_proceeding_snapshot(${icm.committeeProceeding}, ${membership!.id}, ${REASON})`;
      await seat(s, gc, [
        ["committee", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["investigatorA", "MEMBER"],
        ["grcDeputy", "MEMBER"],
      ]);
      const cp = await refer(s, gc, caseB);
      await s.as("caseManager");
      await s.tx`select api.assign_case(${caseB}, ${USERS.grcDeputy}, 'CASE_OWNER', ${REASON})`;
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp}, 'HEARING', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      await s.asOwner();
      const [pm] = await s.tx<{ firewall_restricted: boolean }[]>`
        select firewall_restricted from committee.proceeding_member
        where committee_proceeding_id = ${cp} and user_id = ${USERS.grcDeputy}`;
      expect(pm!.firewall_restricted).toBe(true);
      const GRIEVANCE: UserKey[] = [
        "committeeSecretary",
        "committee",
        "investigatorA",
        "grcDeputy",
        "investigatorB",
      ];
      await invites(s, m!.id, GRIEVANCE);
      const list = await runnersList(s, m!.id);
      expect(list.accounts.find((x) => x.user_id === USERS.grcDeputy)?.invitee_roles).toEqual([
        "WITNESS",
        "EXPERT",
        "INFORMATION_PROVIDER",
      ]);

      // A person and investigatorB are excluded as witnesses from the grievance hearing.
      const omega = await person(s, "Witness Omega (synthetic)");
      await s.as("committeeSecretary");
      for (const [user, who] of [
        [USERS.investigatorB, null],
        [null, omega.person],
      ] as const) {
        const [w] = await s.tx<{ id: string }[]>`
          select api.invite_to_meeting(${m!.id}, 'WITNESS', ${user}::uuid, ${who}::uuid, false, ${REASON}) as id`;
        await s.tx`select api.exclude_meeting_witness(${w!.id}, ${EXCLUSION})`;
      }
      // In the Investigation Committee's meeting grcDeputy is not restricted, and both are listed.
      await invites(s, icm.meeting, ["committeeSecretary", "committeeChair", "grcDeputy", "investigatorB"]);
      const inIc = await runnersList(s, icm.meeting);
      expect(inIc.accounts.find((x) => x.user_id === USERS.grcDeputy)?.invitee_roles).toEqual([
        "WITNESS",
        "EXPERT",
        "LEGAL",
        "INFORMATION_PROVIDER",
      ]);
      expect(inIc.accounts.some((x) => x.user_id === USERS.investigatorB)).toBe(true);
      expect(inIc.persons.some((p) => p.person_id === omega.person)).toBe(true);

      // The Grievance Committee takes no recommendation package (NOT_AN_INVESTIGATION_COMMITTEE).
      await packages(s, cp, GRIEVANCE);
      expect((await itemsView(s, "committeeSecretary", cp))!.capabilities.may_create_package).toBe(false);
    });
  });

  it("refuses as the command does once the case leaves ACTIVE", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await person(s, "Employee Sigma (synthetic)");
      await invites(s, f.meeting);
      await concludeProceedings(s, caseB);
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', ${REASON})`;
      await invites(s, f.meeting);
      expect((await inviteChoices(s, "committeeSecretary", f.meeting)).error).not.toBeNull();
    });
  });
});
