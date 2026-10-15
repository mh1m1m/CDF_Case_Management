// UX redesign Phase 12, slice P12-2a, migration 2065 (ADR-054; Linear CDF-158): the meeting screen's capabilities.
// api.meeting_view gains, on each roster row, whether the caller may record that participant present, absent or
// excused for a conflict (api.record_attendance), excuse them (api.record_excused_absence) or raise a concern about
// them (api.raise_meeting_conflict); and on each vote item, whether the caller may revise their vote
// (api.revise_vote), recuse for a conflict (api.recuse_for_conflict) or note their vote (api.record_vote_note),
// whether they noted it, and the members for whom the runner may record a vote (api.record_vote_for_member).
//
// The coordinator's conditions of 2026-10-14 (11:53, 11:55) and AGENT-09's two clearance checks are the assertions of
// sweep(), which runs in every state these tests build, for each caller:
//   * each flag equals what its real command answers for that caller now, run and rolled back;
//   * a roster row's flags are computed for the meeting's runner on any row and on the caller's own row, and are false
//     on anyone else's (a member raises a concern from the meeting-level flag, and the command answers);
//   * every flag is a boolean and every list a list, never null or absent;
//   * the view equals migration 2030's api.meeting_view, run side by side, apart from the keys 2065 adds.
// Every step runs through the api.* commands as `authenticated`; the owner connection only installs the two
// definitions for the side-by-side run and counts the ledger.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";
import {
  IC_SEATS,
  REASON,
  committeeIds,
  openItem,
  openWithPresent,
  scheduleMeeting,
  seat,
  vote,
  type MeetingFixture,
} from "../support/committee";
import { concludeProceedings } from "../support/closure";
import { answers, without2085 } from "../support/capabilities";

const CONCERN = "Synthetic: a concern raised by the capability test.";
const NOTE = "Synthetic: a note on the vote, for the capability test.";
const EXCLUSION = "Synthetic: the witness approached a member, for the capability test.";

let caseB: string, ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
});

const ROSTER_FLAGS = [
  "may_raise_concern",
  "may_record_absent",
  "may_record_excused_absence",
  "may_record_excused_conflict",
  "may_record_present",
] as const;
type RosterFlag = (typeof ROSTER_FLAGS)[number];
type RosterFlags = Record<RosterFlag, boolean>;
const NONE: RosterFlags = {
  may_raise_concern: false,
  may_record_absent: false,
  may_record_excused_absence: false,
  may_record_excused_conflict: false,
  may_record_present: false,
};
/** The meeting-level flags 2065 narrows to their commands: CDF-212's ended seat and the excluded-witness trigger. */
const OWN_FLAGS = [
  "may_declare_conflict",
  "may_declare_no_conflict",
  "may_acknowledge_confidentiality",
] as const;
const ITEM_FLAGS = [
  "may_cast_casting_vote",
  "may_close",
  "may_record_note",
  "may_recuse_for_conflict",
  "may_revise",
  "may_vote",
];

interface Row {
  participant_id: string;
  user_id: string | null;
  capabilities: RosterFlags;
}
interface Item {
  vote_item_id: string;
  i_have_noted: boolean;
  record_vote_for: string[];
  capabilities: Record<string, boolean>;
}
interface View {
  roster?: Row[] | null;
  deliberation?: { vote_items: Item[] } | null;
  capabilities?: Record<string, boolean>;
}

/** Callers in every sweep: the runner, the chair, the voting members, the alternate and two outsiders. */
const CALLERS: UserKey[] = [
  "committeeSecretary",
  "committeeChair",
  "legal",
  "legalB",
  "lead",
  "committee",
  "caseManager",
  "platformAdmin",
];

// ---- api.meeting_view as 2030 and 2065 created it, side by side ---------------------------------------------------
const MIGRATIONS = "infrastructure/supabase/migrations";

/** The api.meeting_view a migration created, renamed into pg_temp so that both definitions run in one transaction. */
function definition(file: string, name: string): string {
  const text = readFileSync(`${MIGRATIONS}/${file}`, "utf8");
  const head = /create (?:or replace )?function api\.meeting_view\(p_meeting_id uuid\)/;
  const start = text.search(head);
  const end = text.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error(`api.meeting_view not found in ${file}`);
  return text
    .slice(start, end + "\n$$;".length)
    .replace(head, `create function pg_temp.${name}(p_meeting_id uuid)`);
}

/** Installs both definitions on the owner connection; the scenario's rollback removes them. */
async function install(s: OwnerScenario): Promise<void> {
  await s.asOwner();
  await s.tx.unsafe(
    definition("20261007002030_owner_decisions_committee_and_decisions.sql", "meeting_view_2030"),
  );
  await s.tx.unsafe(definition("20261007002065_meeting_screen_capabilities.sql", "meeting_view_2065"));
}

/** One definition's answer for the user whose claims are set: the view, or the error it raised. */
async function runAs(
  s: OwnerScenario,
  fn: string,
  meeting: string,
): Promise<{ view?: unknown; error?: string }> {
  let view: unknown;
  try {
    await s.tx.savepoint(async (sp) => {
      const [r] = await sp.unsafe(`select pg_temp.${fn}($1) as v`, [meeting]);
      view = r!.v;
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  return { view };
}

/** A 2065 view without the keys 2065 adds. */
function without2065(view: unknown): unknown {
  const v = structuredClone(view) as View;
  for (const r of v.roster ?? []) delete (r as Partial<Row>).capabilities;
  for (const i of v.deliberation?.vote_items ?? []) {
    const item = i as Partial<Item>;
    delete item.i_have_noted;
    delete item.record_vote_for;
    delete i.capabilities.may_revise;
    delete i.capabilities.may_recuse_for_conflict;
    delete i.capabilities.may_record_note;
  }
  return withoutNarrowed(v);
}

/** A view without the three meeting-level flags 2065 narrows; sameAs2030 checks those apart. */
function withoutNarrowed(view: unknown): View {
  const v = structuredClone(view) as View;
  for (const f of OWN_FLAGS) delete v.capabilities?.[f];
  return v;
}

/** AGENT-09: 2065's view is 2030's apart from the new keys, for this caller, in this state. True if a view (not a
 *  refusal) was compared. */
async function sameAs2030(s: OwnerScenario, user: UserKey, meeting: string): Promise<boolean> {
  await s.asOwner();
  await s.tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USERS[user], role: "authenticated" })}, true)`;
  const before = await runAs(s, "meeting_view_2030", meeting);
  const after = await runAs(s, "meeting_view_2065", meeting);
  expect(after.error, `${user}: the same refusal`).toBe(before.error);
  if (before.error !== undefined) return false;
  expect(without2065(after.view), `${user}: 2030's view`).toEqual(withoutNarrowed(before.view));
  // The three narrowed flags only ever turn true into false.
  for (const f of OWN_FLAGS) {
    if ((after.view as View).capabilities?.[f]) {
      expect((before.view as View).capabilities?.[f], `${user} ${f} only narrows`).toBe(true);
    }
  }
  return true;
}

// ---- The caller's view, and what the commands answer -------------------------------------------------------------

/**
 * The caller's view without the keys migration 2085 adds (its own spec tests those), or null when it is NOT_FOUND to
 * them. Every new key is a boolean or a list, never null.
 */
async function view(s: OwnerScenario, user: UserKey, meeting: string): Promise<View | null> {
  await s.as(user);
  let v: View | null = null;
  try {
    await s.tx.savepoint(async (sp) => {
      const [r] = await sp<{ v: View }[]>`select api.meeting_view(${meeting}) as v`;
      v = r!.v;
    });
  } catch (error) {
    if ((error as Error).message === "CDF_NOT_FOUND") return null;
    throw error;
  }
  const seen = without2085(v as View | null);
  for (const r of seen?.roster ?? []) {
    expect(Object.keys(r.capabilities).sort(), `${user} roster row`).toEqual([...ROSTER_FLAGS]);
    for (const f of ROSTER_FLAGS) expect(typeof r.capabilities[f], `${user} ${f}`).toBe("boolean");
  }
  for (const i of seen?.deliberation?.vote_items ?? []) {
    expect(Object.keys(i.capabilities).sort(), `${user} vote item`).toEqual(ITEM_FLAGS);
    for (const f of ITEM_FLAGS) expect(typeof i.capabilities[f], `${user} ${f}`).toBe("boolean");
    expect(typeof i.i_have_noted, `${user} i_have_noted`).toBe("boolean");
    expect(Array.isArray(i.record_vote_for), `${user} record_vote_for`).toBe(true);
  }
  return seen;
}

interface Withheld {
  user: UserKey;
  participant: string;
}

/**
 * The checks above, in the meeting's current state, for each caller. The participants and vote items are the ones the
 * runner sees, which is all of them. Returns the concerns a caller's command would accept that their row flags
 * withhold: a member raising one about another participant (the meeting-level may_raise_concern offers it).
 */
async function sweep(
  s: OwnerScenario,
  meeting: string,
  callers: UserKey[] = CALLERS,
  runner: UserKey = "committeeSecretary",
): Promise<Withheld[]> {
  const all = (await view(s, runner, meeting))!;
  const participants = all.roster!.map((r) => r.participant_id);
  const items = (all.deliberation?.vote_items ?? []).map((i) => i.vote_item_id);
  const withheld: Withheld[] = [];
  for (const user of callers) {
    const v = await view(s, user, meeting);
    const [m] = await s.tx<{ runs: boolean }[]>`select authz.can_manage_meeting(${meeting}) as runs`;
    const runs = m!.runs;
    const probes: Record<string, string> = {};
    // The commands a participant runs on their own row (the meeting-level flags answer for them).
    const ownRow = all.roster!.find((r) => r.user_id === USERS[user]);
    if (ownRow) {
      const o = ownRow.participant_id;
      probes["own:may_declare_conflict"] =
        `select api.declare_meeting_conflict('${o}', 'CONFLICT_DECLARED', '${REASON}')`;
      probes["own:may_declare_no_conflict"] =
        `select api.declare_meeting_conflict('${o}', 'NO_CONFLICT', null)`;
      probes["own:may_acknowledge_confidentiality"] =
        `select api.acknowledge_meeting_confidentiality('${o}')`;
    }
    for (const p of participants) {
      probes[`${p}:may_record_present`] = `select api.record_attendance('${p}', 'PRESENT')`;
      probes[`${p}:may_record_absent`] = `select api.record_attendance('${p}', 'ABSENT')`;
      probes[`${p}:may_record_excused_conflict`] = `select api.record_attendance('${p}', 'EXCUSED_CONFLICT')`;
      probes[`${p}:may_record_excused_absence`] = `select api.record_excused_absence('${p}', '${REASON}')`;
      probes[`${p}:may_raise_concern`] = `select api.raise_meeting_conflict('${p}', '${CONCERN}')`;
    }
    for (const i of items) {
      // A revision must change the choice: one of two different choices is always a change.
      probes[`${i}:revise_abstain`] = `select api.revise_vote('${i}', 'ABSTAIN', null)`;
      probes[`${i}:revise_reject`] = `select api.revise_vote('${i}', 'REJECT', null)`;
      probes[`${i}:may_recuse_for_conflict`] = `select api.recuse_for_conflict('${i}', '${REASON}')`;
      probes[`${i}:may_record_note`] = `select api.record_vote_note('${i}', '${NOTE}', false)`;
      for (const p of participants)
        probes[`${i}:${p}:record_for`] =
          `select api.record_vote_for_member('${i}', '${p}', 'ABSENT', '${REASON}', null)`;
    }
    const a = await answers(s, user, probes);

    for (const p of participants) {
      const row = v?.roster?.find((r) => r.participant_id === p);
      const own = row?.user_id === USERS[user];
      for (const f of ROSTER_FLAGS) {
        const offered = row?.capabilities[f] ?? false;
        const accepted = a[`${p}:${f}`]!;
        if (runs || own) {
          expect(offered, `${user} ${f} on ${p}`).toBe(accepted);
        } else {
          expect(offered, `${user} sees no ${f} on another participant's row`).toBe(false);
          if (f === "may_raise_concern") {
            if (accepted) withheld.push({ user, participant: p });
          } else {
            expect(accepted, `${user} ${f} on ${p}: the runner's command`).toBe(false);
          }
        }
      }
    }
    for (const f of OWN_FLAGS) {
      expect(v?.capabilities?.[f] ?? false, `${user} ${f}`).toBe(ownRow ? a[`own:${f}`]! : false);
    }
    for (const i of items) {
      const item = v?.deliberation?.vote_items.find((x) => x.vote_item_id === i);
      const caps = item?.capabilities;
      expect(caps?.may_revise ?? false, `${user} may_revise`).toBe(
        a[`${i}:revise_abstain`]! || a[`${i}:revise_reject`]!,
      );
      expect(caps?.may_recuse_for_conflict ?? false, `${user} may_recuse_for_conflict`).toBe(
        a[`${i}:may_recuse_for_conflict`]!,
      );
      expect(caps?.may_record_note ?? false, `${user} may_record_note`).toBe(a[`${i}:may_record_note`]!);
      expect([...(item?.record_vote_for ?? [])].sort(), `${user} record_vote_for`).toEqual(
        participants.filter((p) => a[`${i}:${p}:record_for`]).sort(),
      );
    }
    const compared = await sameAs2030(s, user, meeting);
    if (user === runner) expect(compared, "the runner's view is compared, not only a refusal").toBe(true);
  }
  return withheld;
}

const flagsOn = (v: View | null, participant: string) =>
  v?.roster?.find((r) => r.participant_id === participant)?.capabilities;
const itemOf = (v: View | null, item: string) =>
  v?.deliberation?.vote_items.find((i) => i.vote_item_id === item);

async function invite(
  s: OwnerScenario,
  meeting: string,
  user: UserKey,
  requiresCoi: boolean,
): Promise<string> {
  await s.as("committeeSecretary");
  const [r] = await s.tx<{ id: string }[]>`
    select api.invite_to_meeting(${meeting}, 'WITNESS', ${USERS[user]}, null, ${requiresCoi}, ${REASON}) as id`;
  return r!.id;
}

async function declare(s: OwnerScenario, f: MeetingFixture, users: UserKey[]): Promise<void> {
  for (const u of users) {
    await s.as(u);
    await s.tx`select api.declare_meeting_conflict(${f.participant[u]!}, 'NO_CONFLICT', null)`;
  }
}

/** The rows of the audit ledger this scenario wrote so far (the owner reads its own transaction). */
async function ledger(s: OwnerScenario): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`
    select count(*)::int as n from audit.audit_event where request_id = current_setting('cdf.request_id')::uuid`;
  return r!.n;
}

describe("api.meeting_view roster capabilities (migration 2065, ADR-054)", () => {
  it("attendance and excuses follow api.record_attendance and api.record_excused_absence, for the runner only; a view writes nothing", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const P = f.participant;

      // Scheduled: nothing to record yet.
      await sweep(s, f.meeting);
      let v = await view(s, "committeeSecretary", f.meeting);
      for (const p of [P.legal!, P.lead!, P.committeeSecretary!])
        expect(flagsOn(v, p)).toMatchObject({
          may_record_present: false,
          may_record_absent: false,
          may_record_excused_conflict: false,
          may_record_excused_absence: false,
        });

      // Open: legal and the chair declared no conflict, the lead a conflict, legalB nothing yet.
      await declare(s, f, ["legal", "committeeChair"]);
      await s.as("lead");
      await s.tx`select api.declare_meeting_conflict(${P.lead!}, 'CONFLICT_DECLARED', ${REASON})`;
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
      await sweep(s, f.meeting);
      v = await view(s, "committeeSecretary", f.meeting);
      expect(flagsOn(v, P.legal!)).toEqual({
        may_record_present: true,
        may_record_absent: true,
        may_record_excused_conflict: false,
        may_record_excused_absence: true,
        may_raise_concern: true,
      });
      expect(flagsOn(v, P.lead!)).toEqual({ ...NONE, may_record_excused_conflict: true });
      expect(flagsOn(v, P.legalB!)).toEqual({
        ...NONE,
        may_record_absent: true,
        may_record_excused_absence: true,
        may_raise_concern: true,
      });
      // The chair and legal see the roster, and no flag on any row of it (coordinator, 11:55).
      for (const u of ["committeeChair", "legal"] as const) {
        const theirs = await view(s, u, f.meeting);
        expect(theirs!.roster!.length).toBe(v!.roster!.length);
        for (const r of theirs!.roster!) expect(r.capabilities, u).toEqual(NONE);
      }

      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${P.legal!}, 'PRESENT')`;
      await s.tx`select api.record_attendance(${P.committeeChair!}, 'PRESENT')`;
      await s.tx`select api.record_attendance(${P.lead!}, 'EXCUSED_CONFLICT')`;
      await s.tx`select api.record_excused_absence(${P.legalB!}, ${REASON})`;
      await sweep(s, f.meeting);
      v = await view(s, "committeeSecretary", f.meeting);
      expect(flagsOn(v, P.legalB!)).toMatchObject({
        may_record_excused_absence: false,
        may_record_absent: true,
      });

      // A vote in progress freezes attendance (VOTE_IN_PROGRESS).
      const item = await openItem(s, f.meeting);
      await sweep(s, f.meeting);
      v = await view(s, "committeeSecretary", f.meeting);
      for (const r of v!.roster!) expect(r.capabilities, r.participant_id).toEqual(NONE);
      await vote(s, "legal", item, "APPROVE");
      await vote(s, "committeeChair", item, "APPROVE");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item}, null)`;
      await sweep(s, f.meeting);

      // A view writes nothing: no audit row, so no ledger sequence number either.
      const written = await ledger(s);
      expect(written).toBeGreaterThan(0);
      for (const u of CALLERS) await view(s, u, f.meeting);
      expect(await ledger(s)).toBe(written);

      // The case leaves ACTIVE: committee.lock_managed_meeting refuses everything (CASE_NOT_ACTIVE). It closes with no
      // proceeding open (CON-022, migration 2060).
      await concludeProceedings(s, caseB);
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', ${REASON})`;
      await sweep(s, f.meeting);
      v = await view(s, "committeeSecretary", f.meeting);
      for (const r of v!.roster!) expect(r.capabilities, r.participant_id).toEqual(NONE);
    });
  });

  it("a replaced member, an ended seat, a witness who has not acknowledged and an excluded witness are never offered present", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      await seat(s, ic, [...IC_SEATS, ["committee", "ALTERNATE_MEMBER"]]);
      const f = await scheduleMeeting(s, ic, caseB);
      const P = f.participant;
      const witness = await invite(s, f.meeting, "employeeB", false);
      const excluded = await invite(s, f.meeting, "financeEmployee", true);
      const callers: UserKey[] = [...CALLERS, "employeeB", "financeEmployee"];
      await declare(s, f, ["committeeChair", "legal", "legalB", "lead", "committee"]);
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
      await s.tx`select api.record_attendance(${P.legalB!}, 'ABSENT')`;
      await s.tx`select api.activate_alternate_member(${P.committee!}, ${P.legalB!}, ${REASON})`;
      await sweep(s, f.meeting, callers);
      let v = await view(s, "committeeSecretary", f.meeting);
      // REPLACED_BY_ALTERNATE; CONFIDENTIALITY_ACK_REQUIRED (a witness needs no declaration here, only the
      // acknowledgement).
      expect(flagsOn(v, P.legalB!)).toMatchObject({ may_record_present: false, may_record_absent: true });
      expect(flagsOn(v, witness)).toMatchObject({ may_record_present: false, may_record_absent: true });
      expect(flagsOn(v, P.committee!)).toMatchObject({ may_record_present: true });

      await s.as("employeeB");
      await s.tx`select api.acknowledge_meeting_confidentiality(${witness})`;
      await sweep(s, f.meeting, callers);
      v = await view(s, "committeeSecretary", f.meeting);
      expect(flagsOn(v, witness)).toMatchObject({ may_record_present: true, may_raise_concern: false });

      // An excluded witness's row is final (2010): nothing is offered on it.
      await s.as("committeeSecretary");
      await s.tx`select api.exclude_meeting_witness(${excluded}, ${EXCLUSION})`;
      await sweep(s, f.meeting, callers);
      v = await view(s, "committeeSecretary", f.meeting);
      expect(flagsOn(v, excluded)).toEqual(NONE);

      // legal's seat ends: never present again (SEAT_ENDED), still recorded absent.
      await s.asOwner();
      const [m] = await s.tx<{ id: string }[]>`
        select id from committee.membership where committee_id = ${ic} and user_id = ${USERS.legal} and ended_at is null`;
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(${m!.id}, now(), 'Synthetic: the seat ends for the test.')`;
      await sweep(s, f.meeting, callers);
      v = await view(s, "committeeSecretary", f.meeting);
      expect(flagsOn(v, P.legal!)).toMatchObject({ may_record_present: false, may_record_absent: true });
    });
  });

  it("a concern: the runner's row flag follows api.raise_meeting_conflict; a member's rows show none and the meeting-level flag stands", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const P = f.participant;
      const witness = await invite(s, f.meeting, "employeeB", false);
      await declare(s, f, ["committeeChair", "legal"]);
      let withheld = await sweep(s, f.meeting);
      let v = await view(s, "committeeSecretary", f.meeting);
      expect(flagsOn(v, P.lead!)!.may_raise_concern).toBe(true);
      expect(flagsOn(v, P.legal!)!.may_raise_concern).toBe(true);
      // COI_NOT_REQUIRED; OWN_CONFLICT.
      expect(flagsOn(v, witness)!.may_raise_concern).toBe(false);
      expect(flagsOn(v, P.committeeSecretary!)!.may_raise_concern).toBe(false);
      // legal may raise one about the lead: the command accepts, the row shows nothing, the meeting-level flag offers.
      expect(withheld).toContainEqual({ user: "legal", participant: P.lead! });
      const legal = await view(s, "legal", f.meeting);
      expect(flagsOn(legal, P.lead!)!.may_raise_concern).toBe(false);
      expect(legal!.capabilities!.may_raise_concern).toBe(true);
      // The lead has not declared: no member's command accepts from them, and they see no flag.
      expect(withheld.filter((w) => w.user === "lead")).toEqual([]);

      await s.as("legal");
      await s.tx`select api.raise_meeting_conflict(${P.lead!}, ${CONCERN})`;
      withheld = await sweep(s, f.meeting);
      v = await view(s, "committeeSecretary", f.meeting);
      // CONCERN_OPEN.
      expect(flagsOn(v, P.lead!)!.may_raise_concern).toBe(false);
      expect(withheld).not.toContainEqual({ user: "legal", participant: P.lead! });

      // A declared conflict is never raised again (COI_ALREADY_DECLARED).
      await s.as("legalB");
      await s.tx`select api.declare_meeting_conflict(${P.legalB!}, 'CONFLICT_DECLARED', ${REASON})`;
      await sweep(s, f.meeting);
      v = await view(s, "committeeSecretary", f.meeting);
      expect(flagsOn(v, P.legalB!)!.may_raise_concern).toBe(false);
    });
  });
});

describe("api.meeting_view declaration flags (migration 2065, CDF-212)", () => {
  it("a member whose seat has ended declares nothing, and an excluded witness who still sees the meeting neither declares nor acknowledges; 2030's flags offered both", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const P = f.participant;
      // The case manager sees the meeting through the case, and is also invited as a witness who must declare.
      const witness = await invite(s, f.meeting, "caseManager", true);
      await declare(s, f, ["committeeChair", "legal", "legalB", "lead"]);
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
      await sweep(s, f.meeting);
      expect((await view(s, "caseManager", f.meeting))!.capabilities).toMatchObject({
        may_declare_conflict: true,
        may_declare_no_conflict: true,
        may_acknowledge_confidentiality: true,
      });
      expect((await view(s, "legal", f.meeting))!.capabilities).toMatchObject({
        may_declare_conflict: true,
        may_declare_no_conflict: false,
      });

      // Excluded (2010): the case manager still sees the meeting through the case, and is offered nothing on it.
      await s.as("committeeSecretary");
      await s.tx`select api.exclude_meeting_witness(${witness}, ${EXCLUSION})`;
      await sweep(s, f.meeting);
      expect((await view(s, "caseManager", f.meeting))!.capabilities).toMatchObject({
        may_declare_conflict: false,
        may_declare_no_conflict: false,
        may_acknowledge_confidentiality: false,
      });
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:WITNESS_EXCLUDED",
        (tx) => tx`select api.declare_meeting_conflict(${witness}, 'NO_CONFLICT', null)`,
      );
      await s.expectError(
        "CDF_CONFLICT:WITNESS_EXCLUDED",
        (tx) => tx`select api.acknowledge_meeting_confidentiality(${witness})`,
      );

      // legal's seat ends: api.declare_meeting_conflict refuses them (2050, CDF-212), and the flags say so.
      await s.asOwner();
      const [m] = await s.tx<{ id: string }[]>`
        select id from committee.membership where committee_id = ${ic} and user_id = ${USERS.legal} and ended_at is null`;
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(${m!.id}, now(), 'Synthetic: the seat ends for the test.')`;
      await sweep(s, f.meeting);
      expect((await view(s, "legal", f.meeting))!.capabilities).toMatchObject({
        may_declare_conflict: false,
        may_declare_no_conflict: false,
      });
      await s.as("legal");
      await s.expectError(
        "CDF_CONFLICT:SEAT_ENDED",
        (tx) => tx`select api.declare_meeting_conflict(${P.legal!}, 'CONFLICT_DECLARED', ${REASON})`,
      );

      // 2030's view offered each of them: the narrowing is 2065's.
      const offered2030 = [
        ["caseManager", "may_declare_conflict"],
        ["caseManager", "may_acknowledge_confidentiality"],
        ["legal", "may_declare_conflict"],
      ] as const;
      for (const [user, flag] of offered2030) {
        await s.asOwner();
        await s.tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USERS[user], role: "authenticated" })}, true)`;
        const before = await runAs(s, "meeting_view_2030", f.meeting);
        expect((before.view as View).capabilities![flag], `2030: ${user} ${flag}`).toBe(true);
      }
    });
  });
});

describe("api.meeting_view vote item capabilities (migration 2065, AMB-077, AMB-081, AMB-082)", () => {
  it("revise, recuse and note follow their commands through a vote, a revision, a note, a recusal and the close", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await openWithPresent(s, f, ["committeeChair", "legal", "legalB", "lead"]);
      const item = await openItem(s, f.meeting);
      await sweep(s, f.meeting);
      const caps = async (u: UserKey) => itemOf(await view(s, u, f.meeting), item);
      expect((await caps("legal"))!.capabilities).toMatchObject({
        may_vote: true,
        may_revise: false,
        may_recuse_for_conflict: true,
        may_record_note: false,
      });
      expect((await caps("committeeSecretary"))!.capabilities).toMatchObject({
        may_revise: false,
        may_recuse_for_conflict: false,
        may_record_note: false,
      });

      await vote(s, "legal", item, "REJECT");
      await sweep(s, f.meeting);
      expect((await caps("legal"))!.capabilities).toMatchObject({
        may_vote: false,
        may_revise: true,
        may_recuse_for_conflict: false,
        may_record_note: true,
      });
      await s.as("legal");
      await s.tx`select api.revise_vote(${item}, 'APPROVE', null)`;
      await sweep(s, f.meeting);
      expect((await caps("legal"))!.capabilities.may_revise).toBe(true);
      await s.tx`select api.record_vote_note(${item}, ${NOTE}, true)`;
      await sweep(s, f.meeting);
      expect(await caps("legal")).toMatchObject({
        i_have_noted: true,
        capabilities: { may_record_note: false },
      });
      for (const u of ["committeeChair", "committeeSecretary", "legalB"] as const)
        expect((await caps(u))!.i_have_noted, u).toBe(false);

      // legalB recuses for a conflict on the item (AMB-077): the recusal is their vote, and the declaration takes them
      // out of the deliberation for the rest of the meeting, so they see no item to act on.
      await s.as("legalB");
      await s.tx`select api.recuse_for_conflict(${item}, ${REASON})`;
      await sweep(s, f.meeting);
      expect(await caps("legalB")).toBeUndefined();

      await vote(s, "committeeChair", item, "APPROVE");
      await vote(s, "lead", item, "APPROVE");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item}, null)`;
      // Closed: no revision, no recusal; a note is still taken while the meeting is open.
      await sweep(s, f.meeting);
      expect((await caps("committeeChair"))!.capabilities).toMatchObject({
        may_revise: false,
        may_recuse_for_conflict: false,
        may_record_note: true,
      });

      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      await sweep(s, f.meeting);
      for (const u of ["committeeChair", "lead"] as const)
        expect((await caps(u))!.capabilities, u).toMatchObject({ may_record_note: false });
    });
  });

  it("with revision and notes switched off in the rule snapshot, neither is offered and neither command accepts", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      await s.as("platformAdmin");
      await s.tx`select api.revise_committee_rule_set(${ic}, now(),
        ${s.tx.json({ vote_revision_allowed: false, dissent_note_allowed: false } as never)}, 'SOURCE_REQUIRED',
        ${REASON})`;
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await openWithPresent(s, f, ["committeeChair", "legal", "legalB", "lead"]);
      const item = await openItem(s, f.meeting);
      await vote(s, "legal", item, "REJECT");
      await sweep(s, f.meeting);
      expect(itemOf(await view(s, "legal", f.meeting), item)!.capabilities).toMatchObject({
        may_revise: false,
        may_record_note: false,
      });
    });
  });

  it("record_vote_for lists exactly the members api.record_vote_for_member would accept, for the runner only", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const P = f.participant;
      await openWithPresent(s, f, ["committeeChair", "legal", "lead"]);
      const item = await openItem(s, f.meeting);
      await sweep(s, f.meeting);
      expect(itemOf(await view(s, "committeeSecretary", f.meeting), item)!.record_vote_for).toEqual([
        P.legalB!,
      ]);
      for (const u of ["committeeChair", "legal", "lead"] as const)
        expect(itemOf(await view(s, u, f.meeting), item)!.record_vote_for, u).toEqual([]);
      // legalB, who has not declared, sees no deliberation at all.
      expect(itemOf(await view(s, "legalB", f.meeting), item)).toBeUndefined();

      await s.as("committeeSecretary");
      await s.tx`select api.record_vote_for_member(${item}, ${P.legalB!}, 'ABSENT', ${REASON}, null)`;
      await sweep(s, f.meeting);
      expect(itemOf(await view(s, "committeeSecretary", f.meeting), item)!.record_vote_for).toEqual([]);

      for (const u of ["committeeChair", "legal", "lead"] as const) await vote(s, u, item, "APPROVE");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item}, null)`;
      await sweep(s, f.meeting);
    });
  });
});
