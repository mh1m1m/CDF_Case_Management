// UX redesign Phase 12, slice P12-2b, migration 2085 (ADR-055; Linear CDF-220): My Committees and the meeting's
// logistics. api.my_committees lists the committees where the caller holds a current seat; api.committee_view shows one
// of them with its proceedings on the seat basis, each with the committee as counts (DEC-F19) and whether the caller
// may schedule a meeting or add a member; api.meeting_view gains the answers for invitations, excluding a witness,
// accommodations, the secretary's path for an invitee without an account and the three activations.
//
// The coordinator's conditions of 2026-10-14 (15:05) are the assertions of two sweeps, which run in every state these
// tests build, for each caller:
//   * committees(): my_committees lists exactly the caller's current seats (authz.user_committee_seat), and
//     committee_view is NOT_FOUND without one; its proceedings are exactly those on the seat basis, which is
//     authz.can_view_committee_proceeding without its can_view_case branch; my_committees counts what committee_view
//     shows; the case is named only under authz.can_view_case_metadata; the snapshot is counts equal to the
//     proceeding's members, and no proceeding carries a person; each scheduling and amendment flag equals what its
//     command answers, run and rolled back, and no command accepts on a proceeding the page does not show.
//   * logistics(): each 2085 flag equals its command's answer for the meeting's runner on any row and for the caller on
//     their own row, and is false elsewhere, where the command refuses too; alternate_for and invitee_roles list
//     exactly what the commands accept; arrangements are what RLS lets the caller read; the view without 2085's keys
//     equals 2065's api.meeting_view, run side by side.
// Every step runs through the api.* commands as `authenticated`; the owner connection only installs 2065's definition,
// reads the ground truth and counts the ledger.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";
import {
  IC_SEATS,
  REASON,
  committeeIds,
  openItem,
  preliminaryReferral,
  refer,
  scheduleMeeting,
  seat,
  vote,
  type MeetingFixture,
} from "../support/committee";
import {
  MEETING_FLAGS_2085,
  ROSTER_FLAGS_2085,
  outcomes,
  without2085,
  without2120,
} from "../support/capabilities";
import { concludeProceedings } from "../support/closure";

const EXCLUSION = "Synthetic: the witness approached a member, for the logistics test.";
const ACCOMMODATION = "Synthetic: step-free access, for the logistics test.";
const EMERGENCY = "Synthetic: an urgent hearing, for the capability test.";
const CONCERN = "Synthetic: a concern raised by the logistics test.";

let caseB: string, caseExec: string, ic: string, gc: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  caseExec = await caseId("0003");
  ({ ic, gc } = await committeeIds());
});

const claims = (user: UserKey) => JSON.stringify({ sub: USERS[user], role: "authenticated" });
const SEAT_ORDER = [
  "CHAIR",
  "DEPUTY_CHAIR",
  "SECRETARY",
  "ALTERNATE_SECRETARY",
  "MEMBER",
  "ALTERNATE_MEMBER",
];

/** The rows of the audit ledger this scenario wrote so far (the owner reads its own transaction). */
async function ledger(s: OwnerScenario): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`
    select count(*)::int as n from audit.audit_event where request_id = current_setting('cdf.request_id')::uuid`;
  return r!.n;
}

/** The current membership of `user` on `committee`, ended now by the platform administrator. */
async function endSeat(s: OwnerScenario, committee: string, user: UserKey): Promise<void> {
  await s.asOwner();
  const [m] = await s.tx<{ id: string }[]>`
    select id from committee.membership where committee_id = ${committee} and user_id = ${USERS[user]} and ended_at is null`;
  await s.as("platformAdmin");
  await s.tx`select api.end_committee_membership(${m!.id}, now(), 'Synthetic: the seat ends for the test.')`;
}

// ---- R1 and R2: My Committees and one committee's page ------------------------------------------------------------

interface MyCommittee {
  committee_id: string;
  code: string;
  kind: string;
  is_active: boolean;
  seat: string;
  effective_from: string;
  effective_to: string | null;
  open_proceedings: number;
  active_meetings: number;
}
interface ProceedingRow {
  committee_proceeding_id: string;
  status: string;
  referred_at: string;
  closed_at: string | null;
  case: { case_id: string | null; case_number: string | null };
  rules: unknown;
  snapshot: Record<string, unknown> & { seats: Record<string, unknown>[] };
  meetings: { meeting_id: string; status: string }[];
  amendment_candidates: { membership_id: string; user_id: string; seat: string }[];
  capabilities: Record<string, boolean>;
}
interface CommitteeView {
  committee: Record<string, unknown>;
  my_seat: { seat: string; effective_from: string; effective_to: string | null };
  members: { user_id: string; seat: string }[];
  rules: unknown;
  proceedings: ProceedingRow[];
}

const PROCEEDING_FLAGS = ["may_amend_snapshot", "may_schedule_emergency_meeting", "may_schedule_meeting"];
const SNAPSHOT_KEYS = [
  "added_after_referral",
  "cleared",
  "firewall_restricted",
  "not_cleared",
  "seats",
  "voting",
];

async function myCommittees(s: OwnerScenario, user: UserKey): Promise<MyCommittee[]> {
  await s.as(user);
  const [r] = await s.tx<{ v: MyCommittee[] }[]>`select api.my_committees() as v`;
  expect(Array.isArray(r!.v), `${user}: My Committees is a list`).toBe(true);
  return r!.v;
}

/** The caller's page of `committee`, or null when it is NOT_FOUND to them. Every flag a boolean, every list a list. */
async function committeeView(
  s: OwnerScenario,
  user: UserKey,
  committee: string | null,
): Promise<CommitteeView | null> {
  await s.as(user);
  let v: CommitteeView | null = null;
  try {
    await s.tx.savepoint(async (sp) => {
      const [r] = await sp<{ v: CommitteeView }[]>`select api.committee_view(${committee}) as v`;
      v = r!.v;
    });
  } catch (error) {
    if ((error as Error).message === "CDF_NOT_FOUND") return null;
    throw error;
  }
  const seen = v as CommitteeView | null;
  expect(Array.isArray(seen!.members) && Array.isArray(seen!.proceedings), `${user}: lists`).toBe(true);
  for (const p of seen!.proceedings) {
    expect(Object.keys(p.capabilities).sort(), `${user} proceeding flags`).toEqual(PROCEEDING_FLAGS);
    for (const f of PROCEEDING_FLAGS) expect(typeof p.capabilities[f], `${user} ${f}`).toBe("boolean");
    expect(Array.isArray(p.meetings) && Array.isArray(p.amendment_candidates), `${user}: lists`).toBe(true);
    // DEC-F19: holders per seat and four totals, nothing else.
    expect(Object.keys(p.snapshot).sort(), `${user} snapshot`).toEqual(SNAPSHOT_KEYS);
    for (const x of p.snapshot.seats)
      expect(Object.keys(x).sort(), `${user} seat count`).toEqual(["count", "seat"]);
  }
  return seen;
}

interface ProceedingTruth {
  id: string;
  committee_id: string;
  case_id: string;
  case_number: string;
  status: string;
  seat_basis: boolean;
  case_view: boolean;
  visible: boolean;
  metadata: boolean;
}

/** The caller's current seats and what the predicates answer for them, on the owner connection with their claims. */
async function truth(
  s: OwnerScenario,
  user: UserKey,
): Promise<{ seat: Map<string, string>; proceedings: ProceedingTruth[] }> {
  await s.asOwner();
  await s.tx`select set_config('request.jwt.claims', ${claims(user)}, true)`;
  const seats = await s.tx<{ id: string; seat: string | null }[]>`
    select c.id, authz.user_committee_seat(${USERS[user]}, c.id, now()) as seat from committee.committee c`;
  const proceedings = await s.tx<ProceedingTruth[]>`
    select cp.id, cp.committee_id, cp.case_id, c.case_number, cp.status,
           committee.seat_basis_proceeding(cp.id) as seat_basis, authz.can_view_case(cp.case_id) as case_view,
           authz.can_view_committee_proceeding(cp.id) as visible, authz.can_view_case_metadata(cp.case_id) as metadata
    from committee.committee_proceeding cp join case_mgmt.case_record c on c.id = cp.case_id`;
  await s.asOwner();
  return {
    seat: new Map(seats.filter((r) => r.seat !== null).map((r) => [r.id, r.seat!] as const)),
    proceedings: [...proceedings],
  };
}

interface Member {
  id: string;
  committee_proceeding_id: string;
  seat: string;
  is_voting: boolean;
  case_gate_excluded: boolean;
  firewall_restricted: boolean;
}

/** DEC-F19's counts, from the proceeding's members and amendments as the owner reads them. */
function counted(members: Member[], amendments: number): unknown {
  const n = (f: (m: Member) => boolean) => members.filter(f).length;
  return {
    seats: SEAT_ORDER.filter((seat) => members.some((m) => m.seat === seat)).map((seat) => ({
      seat,
      count: n((m) => m.seat === seat),
    })),
    voting: n((m) => m.is_voting),
    cleared: n((m) => !m.case_gate_excluded),
    not_cleared: n((m) => m.case_gate_excluded),
    firewall_restricted: n((m) => m.firewall_restricted),
    added_after_referral: amendments,
  };
}

/**
 * R1 and R2 in the current state, for each caller (see the header). `mine` are the proceedings this test made: the
 * commands are probed on those only, so a database that keeps other proceedings (hosted DEV) costs no more probes,
 * while every other assertion covers every proceeding.
 */
async function committees(s: OwnerScenario, callers: UserKey[], mine: string[]): Promise<void> {
  await s.asOwner();
  const all = await s.tx<{ id: string; code: string; kind: string; is_active: boolean }[]>`
    select id, code, kind, is_active from committee.committee`;
  const byCode = [...all].sort((a, b) => (a.code < b.code ? -1 : 1));
  const members = await s.tx<Member[]>`
    select id, committee_proceeding_id, seat, is_voting, case_gate_excluded, firewall_restricted
    from committee.proceeding_member`;
  const amendments = await s.tx<{ committee_proceeding_id: string; n: number }[]>`
    select committee_proceeding_id, count(*)::int as n from committee.proceeding_snapshot_amendment
    group by committee_proceeding_id`;
  const meetings = await s.tx<{ id: string; committee_proceeding_id: string }[]>`
    select id, committee_proceeding_id from committee.meeting`;
  const snapshots = await s.tx<{ id: string; rules: unknown }[]>`
    select id, rule_snapshot as rules from committee.committee_proceeding`;
  const memberships = await s.tx<
    { id: string; committee_id: string; user_id: string; seat: string; current: boolean }[]
  >`
    select m.id, m.committee_id, m.user_id, m.seat,
           m.effective_from <= now() and (m.effective_to is null or m.effective_to > now()) and u.status = 'ACTIVE'
             as current
    from committee.membership m join iam.user_profile u on u.id = m.user_id`;
  // The rules a referral would copy now (committee.open_committee_proceeding).
  const rules = await s.tx<{ committee_id: string; rules: unknown }[]>`
    select r.committee_id, to_jsonb(r) - array['id', 'committee_id', 'created_by', 'created_at', 'reason'] as rules
    from committee.rule_set r
    where r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())`;

  for (const user of callers) {
    const t = await truth(s, user);
    for (const p of t.proceedings) {
      expect(p.seat_basis || p.case_view, `${user}: the seat basis or the case, on ${p.id}`).toBe(p.visible);
    }
    const list = await myCommittees(s, user);
    expect(
      list.map((c) => c.committee_id),
      `${user}: My Committees`,
    ).toEqual(byCode.filter((c) => t.seat.has(c.id)).map((c) => c.id));

    const views = new Map<string, CommitteeView | null>();
    for (const c of byCode) {
      const v = await committeeView(s, user, c.id);
      views.set(c.id, v);
      const seat = t.seat.get(c.id);
      if (seat === undefined) {
        expect(v, `${user}: no seat on ${c.code}, NOT_FOUND`).toBeNull();
        continue;
      }
      expect(v, `${user}: a seat on ${c.code}`).not.toBeNull();
      const row = list.find((x) => x.committee_id === c.id)!;
      expect(row).toMatchObject({ code: c.code, kind: c.kind, is_active: c.is_active, seat });
      expect(v!.committee).toEqual({
        committee_id: c.id,
        code: c.code,
        kind: c.kind,
        is_active: c.is_active,
      });
      expect(v!.my_seat.seat).toBe(seat);
      // The registry: every current member, by seat.
      expect(v!.members.map((m) => `${m.user_id}:${m.seat}`).sort(), `${user}: ${c.code} members`).toEqual(
        memberships
          .filter((m) => m.committee_id === c.id && m.current)
          .map((m) => `${m.user_id}:${m.seat}`)
          .sort(),
      );
      expect(v!.rules, `${user}: ${c.code} rules`).toEqual(
        rules.find((r) => r.committee_id === c.id)?.rules ?? null,
      );
      // The proceedings: exactly those on the seat basis, never one seen only through the case.
      const basis = t.proceedings.filter((p) => p.committee_id === c.id && p.seat_basis);
      expect(
        v!.proceedings.map((p) => p.committee_proceeding_id).sort(),
        `${user}: ${c.code} proceedings`,
      ).toEqual(basis.map((p) => p.id).sort());
      expect(row.open_proceedings, `${user}: ${c.code} open proceedings`).toBe(
        v!.proceedings.filter((p) => p.status === "OPEN").length,
      );
      expect(row.active_meetings, `${user}: ${c.code} active meetings`).toBe(
        v!.proceedings
          .flatMap((p) => p.meetings)
          .filter((m) => m.status === "SCHEDULED" || m.status === "OPEN").length,
      );
      for (const p of v!.proceedings) {
        const g = basis.find((x) => x.id === p.committee_proceeding_id)!;
        expect(p.status).toBe(g.status);
        expect(p.case, `${user}: the case of ${g.id}`).toEqual(
          g.metadata
            ? { case_id: g.case_id, case_number: g.case_number }
            : { case_id: null, case_number: null },
        );
        expect(p.rules).toEqual(snapshots.find((x) => x.id === g.id)!.rules);
        const held = members.filter((m) => m.committee_proceeding_id === g.id);
        expect(p.snapshot, `${user}: the snapshot of ${g.id}`).toEqual(
          counted(held, amendments.find((a) => a.committee_proceeding_id === g.id)?.n ?? 0),
        );
        expect(p.meetings.map((m) => m.meeting_id).sort()).toEqual(
          meetings
            .filter((m) => m.committee_proceeding_id === g.id)
            .map((m) => m.id)
            .sort(),
        );
        // No person in a proceeding but the amendment's candidates: no user id, no snapshot row.
        const text = JSON.stringify({ ...p, amendment_candidates: [] });
        for (const id of [...Object.values(USERS), ...held.map((m) => m.id)])
          expect(text.includes(id), `${user}: a person in ${g.id}`).toBe(false);
      }
    }

    // The scheduling and amendment commands on this test's proceedings, run and rolled back.
    const probes: Record<string, string> = {};
    for (const p of mine) {
      const cp = t.proceedings.find((x) => x.id === p)!;
      probes[`${p}:schedule`] =
        `select api.schedule_meeting('${p}', 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
           now() + interval '61 days', now() + interval '61 days 1 hour', '${REASON}')`;
      probes[`${p}:emergency`] =
        `select api.schedule_emergency_meeting('${p}', 'HEARING', 'IN_PERSON', 'Room (synthetic)', null,
           now() + interval '1 hour', now() + interval '2 hours', '${REASON}', '${EMERGENCY}')`;
      probes[`${p}:amend:none`] =
        `select api.amend_proceeding_snapshot('${p}', '${randomUUID()}', '${REASON}')`;
      for (const m of memberships.filter((x) => x.committee_id === cp.committee_id))
        probes[`${p}:amend:${m.id}`] = `select api.amend_proceeding_snapshot('${p}', '${m.id}', '${REASON}')`;
    }
    const o = await outcomes(s, user, probes);
    for (const p of mine) {
      const cp = t.proceedings.find((x) => x.id === p)!;
      const ms = memberships.filter((x) => x.committee_id === cp.committee_id);
      const row = views.get(cp.committee_id)?.proceedings.find((x) => x.committee_proceeding_id === p);
      if (!row) {
        // No command accepts on a proceeding the page does not show.
        expect(o[`${p}:schedule`], `${user} schedules on ${p}, unseen`).not.toBe(true);
        expect(o[`${p}:emergency`], `${user} schedules an emergency on ${p}, unseen`).not.toBe(true);
        expect(o[`${p}:amend:none`], `${user} amends ${p}, unseen`).not.toBe("CDF_INVALID:membership_id");
        for (const m of ms) expect(o[`${p}:amend:${m.id}`], `${user} amends ${p}, unseen`).not.toBe(true);
        continue;
      }
      expect(row.capabilities.may_schedule_meeting, `${user} may_schedule_meeting`).toBe(
        o[`${p}:schedule`] === true,
      );
      expect(row.capabilities.may_schedule_emergency_meeting, `${user} may_schedule_emergency_meeting`).toBe(
        o[`${p}:emergency`] === true,
      );
      // Up to the member chosen: with an id that names no membership, the command reaches its member check.
      expect(row.capabilities.may_amend_snapshot, `${user} may_amend_snapshot`).toBe(
        o[`${p}:amend:none`] === "CDF_INVALID:membership_id",
      );
      const candidates = row.amendment_candidates.map((x) => x.membership_id).sort();
      if (row.capabilities.may_amend_snapshot) {
        // Every current member not in the snapshot, cleared for the case or not: the command answers
        // NOT_CLEARED_FOR_CASE at submit.
        expect(candidates, `${user} amendment_candidates`).toEqual(
          ms
            .filter((m) => [true, "CDF_CONFLICT:NOT_CLEARED_FOR_CASE"].includes(o[`${p}:amend:${m.id}`]!))
            .map((m) => m.id)
            .sort(),
        );
        for (const m of ms.filter((x) => !candidates.includes(x.id)))
          expect(["CDF_CONFLICT:ALREADY_IN_SNAPSHOT", "CDF_INVALID:membership_id"]).toContain(
            o[`${p}:amend:${m.id}`],
          );
      } else {
        expect(candidates, `${user} amendment_candidates`).toEqual([]);
        for (const m of ms) expect(o[`${p}:amend:${m.id}`], `${user} amends ${p}`).not.toBe(true);
      }
    }
  }
}

/** Callers of the committee sweeps: seats on IC and GC, the case team, an administrator and an inactive account. */
const COMMITTEE_CALLERS: UserKey[] = [
  "committeeSecretary",
  "committeeChair",
  "legal",
  "lead",
  "internalAudit",
  "committee",
  "employee",
  "investigatorA",
  "employeeB",
  "soc",
  "caseManager",
  "investigatorB",
  "platformAdmin",
  "revoked",
];

describe("api.my_committees and api.committee_view (migration 2085, ADR-055)", () => {
  it("follow the caller's current seats and the seat basis through a referral, an amendment, an ended seat and the case leaving ACTIVE; a view writes nothing", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, [
        ...IC_SEATS,
        ["internalAudit", "MEMBER"], // INTERNAL clearance: case B is RESTRICTED, so excluded at referral
        ["committee", "ALTERNATE_MEMBER"],
        ["employee", "ALTERNATE_SECRETARY"],
      ]);
      await seat(s, gc, [
        ["investigatorA", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["employeeB", "MEMBER"],
      ]);

      // No proceeding yet: each seat holder sees their committees, nobody else sees any.
      await committees(s, COMMITTEE_CALLERS, []);
      expect(await myCommittees(s, "committeeSecretary")).toEqual([
        expect.objectContaining({ code: "GC", seat: "SECRETARY", open_proceedings: 0, active_meetings: 0 }),
        expect.objectContaining({ code: "IC", seat: "SECRETARY", open_proceedings: 0, active_meetings: 0 }),
      ]);
      for (const u of ["caseManager", "investigatorB", "platformAdmin", "revoked"] as const) {
        expect(await myCommittees(s, u), u).toEqual([]);
        expect(await committeeView(s, u, ic), u).toBeNull();
      }
      // The same NOT_FOUND for an id that names no committee, or none.
      expect(await committeeView(s, "committeeSecretary", randomUUID())).toBeNull();
      expect(await committeeView(s, "committeeSecretary", null)).toBeNull();

      const f = await scheduleMeeting(s, ic, caseB);
      const cp = f.committeeProceeding;
      await committees(s, COMMITTEE_CALLERS, [cp]);
      expect(await myCommittees(s, "legal")).toEqual([
        expect.objectContaining({ code: "IC", seat: "MEMBER", open_proceedings: 1, active_meetings: 1 }),
      ]);
      // Excluded from the case at referral: the committee, and neither the proceeding nor a count of it.
      expect(await myCommittees(s, "internalAudit")).toEqual([
        expect.objectContaining({ code: "IC", open_proceedings: 0, active_meetings: 0 }),
      ]);
      expect((await committeeView(s, "internalAudit", ic))!.proceedings).toEqual([]);
      // The case team sees the proceeding through the case (RLS) and has no committee page.
      await s.as("caseManager");
      expect(await s.tx`select id from committee.committee_proceeding where id = ${cp}`).toHaveLength(1);
      expect(await committeeView(s, "caseManager", ic)).toBeNull();
      const secretary = (await committeeView(s, "committeeSecretary", ic))!.proceedings[0]!;
      expect(secretary.capabilities).toEqual({
        may_schedule_meeting: true,
        may_schedule_emergency_meeting: true,
        may_amend_snapshot: true,
      });
      expect(secretary.amendment_candidates).toEqual([]);
      expect(secretary.snapshot).toEqual({
        seats: [
          { seat: "CHAIR", count: 1 },
          { seat: "SECRETARY", count: 1 },
          { seat: "ALTERNATE_SECRETARY", count: 1 },
          { seat: "MEMBER", count: 4 },
          { seat: "ALTERNATE_MEMBER", count: 1 },
        ],
        voting: 4,
        cleared: 7,
        not_cleared: 1,
        firewall_restricted: 0,
        added_after_referral: 0,
      });
      // A member schedules nothing and adds nobody.
      expect((await committeeView(s, "legal", ic))!.proceedings[0]!.capabilities).toEqual({
        may_schedule_meeting: false,
        may_schedule_emergency_meeting: false,
        may_amend_snapshot: false,
      });

      // Two members seated after the referral (AMB-038): one cleared for the case, one not (soc: INTERNAL clearance).
      // Both are candidates; the command answers for the clearance at submit.
      await seat(s, ic, [
        ["employeeB", "MEMBER"],
        ["soc", "MEMBER"],
      ]);
      await committees(s, COMMITTEE_CALLERS, [cp]);
      await s.asOwner();
      const added = await s.tx<{ id: string; user_id: string }[]>`
        select id, user_id from committee.membership
        where committee_id = ${ic} and user_id in (${USERS.employeeB}, ${USERS.soc})`;
      const membershipOf = (u: UserKey) => added.find((m) => m.user_id === USERS[u])!.id;
      expect(
        (await committeeView(s, "committeeSecretary", ic))!.proceedings[0]!.amendment_candidates.map(
          (c) => c.membership_id,
        ).sort(),
      ).toEqual([membershipOf("employeeB"), membershipOf("soc")].sort());
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:NOT_CLEARED_FOR_CASE",
        (tx) => tx`select api.amend_proceeding_snapshot(${cp}, ${membershipOf("soc")}, ${REASON})`,
      );
      await s.tx`select api.amend_proceeding_snapshot(${cp}, ${membershipOf("employeeB")}, ${REASON})`;
      await committees(s, COMMITTEE_CALLERS, [cp]);
      expect(await myCommittees(s, "employeeB")).toEqual([
        expect.objectContaining({ code: "GC", seat: "MEMBER", open_proceedings: 0 }),
        expect.objectContaining({ code: "IC", seat: "MEMBER", open_proceedings: 1, active_meetings: 1 }),
      ]);
      expect((await committeeView(s, "employeeB", ic))!.proceedings[0]!.snapshot).toMatchObject({
        added_after_referral: 1,
      });
      // soc holds a seat and is not cleared for the case: the committee, without its proceeding.
      expect((await committeeView(s, "soc", ic))!.proceedings).toEqual([]);

      // Cleared after the referral, a member excluded at referral still does not see the proceeding: the snapshot
      // decides, and the amendment refuses them (ALREADY_IN_SNAPSHOT).
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET' where id = ${USERS.internalAudit}`;
      // The seat basis only, never the case (the coordinator's condition): the case manager, seated after the referral
      // and not added, sees the proceeding through the case (RLS) and not on their committee page.
      await seat(s, ic, [["caseManager", "MEMBER"]]);
      await committees(s, COMMITTEE_CALLERS, [cp]);
      expect((await committeeView(s, "internalAudit", ic))!.proceedings).toEqual([]);
      await s.as("caseManager");
      expect(await s.tx`select id from committee.committee_proceeding where id = ${cp}`).toHaveLength(1);
      expect(await myCommittees(s, "caseManager")).toEqual([
        expect.objectContaining({ code: "IC", seat: "MEMBER", open_proceedings: 0, active_meetings: 0 }),
      ]);
      expect((await committeeView(s, "caseManager", ic))!.proceedings).toEqual([]);

      // A suspended account holds no seat (authz.user_committee_seat): no committee, the page NOT_FOUND, and neither a
      // member on the page nor a candidate for the amendment.
      await s.asOwner();
      await s.tx`update iam.user_profile set status = 'SUSPENDED' where id in (${USERS.soc}, ${USERS.committee})`;
      await committees(s, COMMITTEE_CALLERS, [cp]);
      expect(await myCommittees(s, "committee")).toEqual([]);
      expect(await committeeView(s, "soc", ic)).toBeNull();
      const page = (await committeeView(s, "committeeSecretary", ic))!;
      expect(page.members.map((m) => m.user_id)).not.toContain(USERS.soc);
      expect(page.proceedings[0]!.amendment_candidates.map((c) => c.user_id)).not.toContain(USERS.soc);

      // A member whose clearance drops below the case's leaves the seat basis (the case gate), and so does the alternate
      // secretary: the committee, without the proceeding.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'INTERNAL' where id in (${USERS.legal}, ${USERS.employee})`;
      await committees(s, COMMITTEE_CALLERS, [cp]);
      for (const u of ["legal", "employee"] as const)
        expect((await committeeView(s, u, ic))!.proceedings, u).toEqual([]);

      // An ended seat: no committee, and the page is NOT_FOUND.
      await endSeat(s, ic, "lead");
      await committees(s, COMMITTEE_CALLERS, [cp]);
      expect(await myCommittees(s, "lead")).toEqual([]);
      expect(await committeeView(s, "lead", ic)).toBeNull();

      // A cancelled meeting stays on the page and is no longer counted as active.
      await s.as("committeeSecretary");
      await s.tx`select api.cancel_meeting(${f.meeting}, ${REASON})`;
      await committees(s, COMMITTEE_CALLERS, [cp]);
      expect(await myCommittees(s, "committeeSecretary")).toEqual([
        expect.objectContaining({ code: "GC", active_meetings: 0 }),
        expect.objectContaining({ code: "IC", open_proceedings: 1, active_meetings: 0 }),
      ]);
      expect((await committeeView(s, "committeeSecretary", ic))!.proceedings[0]!.meetings).toEqual([
        expect.objectContaining({ meeting_id: f.meeting, status: "CANCELLED" }),
      ]);

      // A view writes nothing: no audit row, so no ledger sequence number either.
      const written = await ledger(s);
      expect(written).toBeGreaterThan(0);
      for (const u of COMMITTEE_CALLERS) {
        await myCommittees(s, u);
        await committeeView(s, u, ic);
      }
      expect(await ledger(s)).toBe(written);

      // The case leaves ACTIVE: nothing is scheduled or amended any more (CASE_NOT_ACTIVE). It closes with no
      // proceeding open (CON-022, migration 2060).
      await concludeProceedings(s, caseB);
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', ${REASON})`;
      await committees(s, COMMITTEE_CALLERS, [cp]);
      for (const p of (await committeeView(s, "committeeSecretary", ic))!.proceedings)
        expect(p.capabilities).toEqual({
          may_schedule_meeting: false,
          may_schedule_emergency_meeting: false,
          may_amend_snapshot: false,
        });
    });
  });

  it("a member not cleared for a restricted case sees neither its proceeding nor a count of it; the restricted proceeding is not amended without the authority's approval", async () => {
    await ownerScenario(async (s) => {
      // As recommendations-authority.spec (W2): the secretary cleared for the SECRET case.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET' where id = ${USERS.committeeSecretary}`;
      await seat(s, ic, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["grcDeputy", "MEMBER"], // SECRET clearance
        ["legal", "MEMBER"],
        ["internalAudit", "MEMBER"],
      ]);
      const b = await refer(s, ic, caseB);
      await preliminaryReferral(s, caseExec);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`;
      const [x] = await s.tx<{ id: string }[]>`
        select api.refer_case_to_committee(${caseExec}, ${ic}, null, ${REASON}) as id`;
      const exec = x!.id;
      const callers: UserKey[] = [
        "committeeSecretary",
        "committeeChair",
        "grcDeputy",
        "legal",
        "internalAudit",
        "grcDirector",
        "caseManager",
      ];
      await committees(s, callers, [b, exec]);
      for (const u of ["committeeChair", "legal"] as const) {
        expect(await myCommittees(s, u), u).toEqual([
          expect.objectContaining({ code: "IC", open_proceedings: 1 }),
        ]);
        expect(
          (await committeeView(s, u, ic))!.proceedings.map((p) => p.committee_proceeding_id),
          u,
        ).toEqual([b]);
      }
      expect(await myCommittees(s, "internalAudit")).toEqual([
        expect.objectContaining({ code: "IC", open_proceedings: 0 }),
      ]);
      for (const u of ["committeeSecretary", "grcDeputy"] as const)
        expect(await myCommittees(s, u), u).toEqual([
          expect.objectContaining({ code: "IC", open_proceedings: 2 }),
        ]);
      // The case owner sees the restricted proceeding through the case, and has no committee page.
      expect(await myCommittees(s, "grcDirector")).toEqual([]);
      expect(await committeeView(s, "grcDirector", ic)).toBeNull();

      // An alternate secretary seated after the referral is in neither snapshot and sees the proceedings through the
      // secretary's seat, each under the case gate: case B, not the SECRET case (CONFIDENTIAL clearance).
      await seat(s, ic, [["employee", "ALTERNATE_SECRETARY"]]);
      callers.push("employee");
      await committees(s, callers, [b, exec]);
      expect(
        (await committeeView(s, "employee", ic))!.proceedings.map((p) => p.committee_proceeding_id),
      ).toEqual([b]);

      // The restricted proceeding: a meeting may be scheduled; the snapshot is amended only with the authority's
      // approval, which is not built yet (AUTHORITY_APPROVAL_REQUIRED, fail closed).
      const restricted = (await committeeView(s, "committeeSecretary", ic))!.proceedings.find(
        (p) => p.committee_proceeding_id === exec,
      )!;
      expect(restricted.capabilities).toEqual({
        may_schedule_meeting: true,
        may_schedule_emergency_meeting: true,
        may_amend_snapshot: false,
      });
      expect(restricted.amendment_candidates).toEqual([]);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:AUTHORITY_APPROVAL_REQUIRED",
        (tx) => tx`select api.amend_proceeding_snapshot(${exec}, ${randomUUID()}, ${REASON})`,
      );
      // Snapshot counts as copied: the chair, legal and internalAudit were not cleared for it.
      expect(restricted.snapshot).toMatchObject({ voting: 1, cleared: 2, not_cleared: 3 });

      // A meeting on the restricted proceeding is listed under it, for those who see it, and under no other.
      await s.as("committeeSecretary");
      const [xm] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${exec}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '61 days', now() + interval '61 days 1 hour', ${REASON}) as id`;
      await committees(s, callers, [b, exec]);
      const meetingsOf = async (u: UserKey) =>
        Object.fromEntries(
          (await committeeView(s, u, ic))!.proceedings.map((p) => [
            p.committee_proceeding_id,
            p.meetings.map((m) => m.meeting_id),
          ]),
        );
      expect(await meetingsOf("committeeSecretary")).toEqual({ [b]: [], [exec]: [xm!.id] });
      expect(await meetingsOf("legal")).toEqual({ [b]: [] });

      // The proceeding on case B is cancelled: still on the page, no longer counted as open, and nothing is scheduled
      // or amended on it any more (PROCEEDING_CLOSED).
      await s.asOwner();
      const [pb] = await s.tx<{ proceeding_id: string }[]>`
        select proceeding_id from committee.committee_proceeding where id = ${b}`;
      await s.as("caseManager");
      await s.tx`select api.close_proceeding(${pb!.proceeding_id}, 'CANCELLED', null, ${REASON})`;
      await committees(s, callers, [b, exec]);
      const cancelled = (await committeeView(s, "legal", ic))!.proceedings;
      expect(cancelled.map((p) => [p.committee_proceeding_id, p.status])).toEqual([[b, "CANCELLED"]]);
      expect(await myCommittees(s, "legal")).toEqual([
        expect.objectContaining({ code: "IC", open_proceedings: 0 }),
      ]);
      expect(
        (await committeeView(s, "committeeSecretary", ic))!.proceedings.find(
          (p) => p.committee_proceeding_id === b,
        )!.capabilities,
      ).toEqual({
        may_schedule_meeting: false,
        may_schedule_emergency_meeting: false,
        may_amend_snapshot: false,
      });
    });
  });
});

// ---- R3: api.meeting_view's logistics ------------------------------------------------------------------------------

const ROSTER_FLAGS_2065 = [
  "may_raise_concern",
  "may_record_absent",
  "may_record_excused_absence",
  "may_record_excused_conflict",
  "may_record_present",
];
const ROSTER_FLAGS = [...ROSTER_FLAGS_2065, ...ROSTER_FLAGS_2085].sort();
/** The 2085 roster flags that are each one command on the row's participant, and that command. */
const ROW_COMMANDS: Record<string, (p: string) => string> = {
  may_exclude_witness: (p) => `select api.exclude_meeting_witness('${p}', '${EXCLUSION}')`,
  may_record_accommodation: (p) => `select api.record_meeting_accommodation('${p}', '${ACCOMMODATION}')`,
  may_declare_conflict: (p) =>
    `select api.declare_meeting_conflict('${p}', 'CONFLICT_DECLARED', '${REASON}')`,
  may_declare_no_conflict: (p) => `select api.declare_meeting_conflict('${p}', 'NO_CONFLICT', null)`,
  may_acknowledge_confidentiality: (p) => `select api.acknowledge_meeting_confidentiality('${p}')`,
};
/** The meeting-level flags that answer for the caller's own row (2065's three and 2085's accommodation). */
const OWN_FLAGS = [
  "may_acknowledge_confidentiality",
  "may_declare_conflict",
  "may_declare_no_conflict",
  "may_record_accommodation",
];
const ROLES = ["WITNESS", "EXPERT", "LEGAL", "INFORMATION_PROVIDER", "SUBJECT", "INTERPRETER"];
/** Never invited: the user each invitation probe names. */
const PROBE_INVITEE: UserKey = "financeEmployee";

interface Accommodation {
  accommodation_id: string;
  details: string;
  source: string;
  recorded_at: string;
}
interface Row {
  participant_id: string;
  user_id: string | null;
  seat: string | null;
  alternate_for: string[];
  arrangements: { confidentiality_acknowledged: boolean; accommodations: Accommodation[] } | null;
  capabilities: Record<string, boolean>;
}
interface MeetingView {
  me?: { participant_id: string; accommodations: Accommodation[] } | null;
  roster?: Row[] | null;
  capabilities?: Record<string, boolean>;
  invitee_roles?: { invitee_role: string; confidentiality_ack_required: boolean; source_status: string }[];
}

/** The caller's view, or null when it is NOT_FOUND to them. Every new key is a boolean or a list, never null. */
async function meetingView(s: OwnerScenario, user: UserKey, meeting: string): Promise<MeetingView | null> {
  await s.as(user);
  let v: MeetingView | null = null;
  try {
    await s.tx.savepoint(async (sp) => {
      const [r] = await sp<{ v: MeetingView }[]>`select api.meeting_view(${meeting}) as v`;
      v = r!.v;
    });
  } catch (error) {
    if ((error as Error).message === "CDF_NOT_FOUND") return null;
    throw error;
  }
  const seen = v as MeetingView | null;
  for (const r of seen?.roster ?? []) {
    expect(Object.keys(r.capabilities).sort(), `${user} roster row`).toEqual(ROSTER_FLAGS);
    for (const f of ROSTER_FLAGS) expect(typeof r.capabilities[f], `${user} ${f}`).toBe("boolean");
    expect(Array.isArray(r.alternate_for), `${user} alternate_for`).toBe(true);
    if (r.arrangements !== null) {
      expect(typeof r.arrangements.confidentiality_acknowledged, `${user} arrangements`).toBe("boolean");
      expect(Array.isArray(r.arrangements.accommodations), `${user} arrangements`).toBe(true);
    }
  }
  if (seen?.capabilities) {
    for (const f of MEETING_FLAGS_2085) expect(typeof seen.capabilities[f], `${user} ${f}`).toBe("boolean");
    expect(Array.isArray(seen.invitee_roles), `${user} invitee_roles`).toBe(true);
  }
  if (seen?.me) expect(Array.isArray(seen.me.accommodations), `${user} me.accommodations`).toBe(true);
  return seen;
}

// ---- 2065's api.meeting_view, side by side ---------------------------------------------------------------------------
const MIGRATIONS = "infrastructure/supabase/migrations";

/** 2065's api.meeting_view, renamed into pg_temp so that it runs beside the live one in one transaction. */
function definition2065(): string {
  const text = readFileSync(`${MIGRATIONS}/20261007002065_meeting_screen_capabilities.sql`, "utf8");
  const head = /create (?:or replace )?function api\.meeting_view\(p_meeting_id uuid\)/;
  const start = text.search(head);
  const end = text.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error("api.meeting_view not found in 2065");
  return text
    .slice(start, end + "\n$$;".length)
    .replace(head, "create function pg_temp.meeting_view_2065(p_meeting_id uuid)");
}

/** Installs 2065's definition on the owner connection; the scenario's rollback removes it. */
async function install(s: OwnerScenario): Promise<void> {
  await s.asOwner();
  await s.tx.unsafe(definition2065());
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
      const [r] = await sp.unsafe(`select ${fn}($1) as v`, [meeting]);
      view = r!.v;
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  return { view };
}

/** AGENT-09: the live view without 2085's keys is 2065's, for this caller, in this state. */
async function sameAs2065(s: OwnerScenario, user: UserKey, meeting: string): Promise<void> {
  await s.asOwner();
  await s.tx`select set_config('request.jwt.claims', ${claims(user)}, true)`;
  const before = await runAs(s, "pg_temp.meeting_view_2065", meeting);
  const after = await runAs(s, "api.meeting_view", meeting);
  expect(after.error, `${user}: the same refusal`).toBe(before.error);
  if (before.error === undefined)
    expect(without2085(without2120(after.view)), `${user}: 2065's view`).toEqual(before.view);
}

/** Callers of the meeting sweeps: the runner, the chair, a member, the deputy, the alternates, a witness with an
 *  account, the case team and an administrator. */
const MEETING_CALLERS: UserKey[] = [
  "committeeSecretary",
  "committeeChair",
  "legal",
  "investigatorA",
  "committee",
  "employee",
  "employeeB",
  "caseManager",
  "platformAdmin",
];

/**
 * R3 in the meeting's current state, for each caller (see the header). The participants are the ones the runner sees,
 * which is all of them; `subject` is a person of the case never invited, for the SUBJECT invitation probe.
 */
async function logistics(
  s: OwnerScenario,
  meeting: string,
  subject: string,
  callers: UserKey[] = MEETING_CALLERS,
  runner: UserKey = "committeeSecretary",
): Promise<void> {
  const rows = (await meetingView(s, runner, meeting))!.roster!;
  const participants = rows.map((r) => r.participant_id);
  await s.asOwner();
  const enabled = await s.tx<
    { invitee_role: string; confidentiality_ack_required: boolean; source_status: string }[]
  >`
    select invitee_role, confidentiality_ack_required, source_status from committee.invitee_type_rule where enabled`;
  for (const user of callers) {
    const v = await meetingView(s, user, meeting);
    const [m] = await s.tx<{ runs: boolean }[]>`select authz.can_manage_meeting(${meeting}) as runs`;
    const runs = m!.runs;
    const probes: Record<string, string> = {};
    for (const p of participants) {
      for (const [f, sql] of Object.entries(ROW_COMMANDS)) probes[`${p}:${f}`] = sql(p);
      // An alternate member against every row; any other row against one, which the command refuses (INVALID).
      const alternate = rows.find((r) => r.participant_id === p)!.seat === "ALTERNATE_MEMBER";
      for (const r of alternate ? participants : participants.slice(0, 1))
        probes[`${p}:${r}:alternate`] = `select api.activate_alternate_member('${p}', '${r}', '${REASON}')`;
    }
    for (const role of ROLES)
      probes[`invite:${role}`] =
        role === "SUBJECT"
          ? `select api.invite_to_meeting('${meeting}', 'SUBJECT', null, '${subject}', false, '${REASON}')`
          : `select api.invite_to_meeting('${meeting}', '${role}', '${USERS[PROBE_INVITEE]}', null,
               ${role === "INTERPRETER"}, '${REASON}')`;
    probes.acting_chair = `select api.activate_acting_chair('${meeting}', '${REASON}')`;
    probes.acting_secretary = `select api.activate_acting_secretary('${meeting}', '${REASON}')`;
    const o = await outcomes(s, user, probes);
    const a = (k: string) => o[k] === true;
    // What RLS lets the caller read (confidentiality_ack_read, meeting_accommodation_read); outcomes() left them acting.
    const acks = await s.tx<{ participant_id: string }[]>`
      select participant_id from committee.confidentiality_ack where meeting_id = ${meeting}`;
    const accs = await s.tx<{ participant_id: string; a: Accommodation }[]>`
      select participant_id, jsonb_build_object('accommodation_id', id, 'details', details, 'source', source,
                                                'recorded_at', recorded_at) as a
      from committee.meeting_accommodation where meeting_id = ${meeting} order by recorded_at, id`;
    const arrangementsOf = (p: string) => ({
      confidentiality_acknowledged: acks.some((x) => x.participant_id === p),
      accommodations: accs.filter((x) => x.participant_id === p).map((x) => x.a),
    });

    const own = rows.find((r) => r.user_id === USERS[user]);
    for (const p of participants) {
      const row = v?.roster?.find((r) => r.participant_id === p);
      const mine = own?.participant_id === p;
      for (const f of Object.keys(ROW_COMMANDS)) {
        const offered = row?.capabilities[f] ?? false;
        if (row && (runs || mine)) {
          expect(offered, `${user} ${f} on ${p}`).toBe(a(`${p}:${f}`));
        } else {
          expect(offered, `${user} sees no ${f} on ${p}`).toBe(false);
          // The caller's own row without a roster is answered by the meeting-level flags below.
          if (!mine) expect(a(`${p}:${f}`), `${user} ${f} on ${p}: the runner's command`).toBe(false);
        }
      }
      const replaces = participants.filter((r) => a(`${p}:${r}:alternate`));
      if (row && runs) {
        expect([...row.alternate_for].sort(), `${user} alternate_for ${p}`).toEqual([...replaces].sort());
        expect(row.capabilities.may_activate_alternate, `${user} may_activate_alternate ${p}`).toBe(
          replaces.length > 0,
        );
      } else {
        expect(row?.alternate_for ?? [], `${user} alternate_for ${p}`).toEqual([]);
        expect(row?.capabilities.may_activate_alternate ?? false, `${user} may_activate_alternate`).toBe(
          false,
        );
        expect(replaces, `${user} activates an alternate`).toEqual([]);
      }
      if (row && (runs || mine)) {
        expect(row.arrangements, `${user} arrangements of ${p}`).toEqual(arrangementsOf(p));
      } else {
        if (row) expect(row.arrangements, `${user} arrangements of ${p}`).toBeNull();
        if (!mine)
          expect(arrangementsOf(p), `${user}: RLS shows nothing of ${p} either`).toEqual({
            confidentiality_acknowledged: false,
            accommodations: [],
          });
      }
    }

    if (v?.capabilities) {
      const caps = v.capabilities;
      // The caller's own row, roster or not: the meeting-level flags equal its commands, and its row flags.
      for (const f of OWN_FLAGS) {
        expect(caps[f], `${user} ${f} on their own row`).toBe(own ? a(`${own.participant_id}:${f}`) : false);
        const row = v.roster?.find((r) => r.participant_id === own?.participant_id);
        if (row) expect(row.capabilities[f], `${user} ${f}: the row and the meeting agree`).toBe(caps[f]);
      }
      if (v.me)
        expect(v.me.accommodations, `${user} me.accommodations`).toEqual(
          arrangementsOf(v.me.participant_id).accommodations,
        );
      expect(caps.may_invite, `${user} may_invite`).toBe(ROLES.some((r) => a(`invite:${r}`)));
      expect(
        v.invitee_roles!.map((r) => r.invitee_role),
        `${user} invitee_roles`,
      ).toEqual(ROLES.filter((r) => a(`invite:${r}`)));
      for (const r of v.invitee_roles!)
        expect(r, `${user}: the rule of ${r.invitee_role}`).toEqual(
          enabled.find((x) => x.invitee_role === r.invitee_role),
        );
      expect(caps.may_activate_acting_chair, `${user} may_activate_acting_chair`).toBe(a("acting_chair"));
      expect(caps.may_activate_acting_secretary, `${user} may_activate_acting_secretary`).toBe(
        a("acting_secretary"),
      );
    } else {
      // NOT_FOUND (or the concern-only view): no command accepts.
      expect(
        Object.keys(o).filter((k) => a(k)),
        `${user}: nothing accepted without the meeting`,
      ).toEqual([]);
    }
    await sameAs2065(s, user, meeting);
  }
}

const flagsOn = (v: MeetingView | null, participant: string) =>
  v?.roster?.find((r) => r.participant_id === participant)?.capabilities;
const rowOf = (v: MeetingView | null, participant: string) =>
  v?.roster?.find((r) => r.participant_id === participant);
const NONE_2085 = Object.fromEntries(ROSTER_FLAGS_2085.map((f) => [f, false]));

/** IC_SEATS with investigatorA as deputy chair, committee as alternate member and employee as alternate secretary. */
const LOGISTICS_SEATS: [UserKey, string][] = [
  ...IC_SEATS,
  ["investigatorA", "DEPUTY_CHAIR"],
  ["committee", "ALTERNATE_MEMBER"],
  ["employee", "ALTERNATE_SECRETARY"],
];

/** Two people of case B without an account, added by the case manager: a witness to invite and a subject never
 *  invited (the SUBJECT probe). */
async function people(s: OwnerScenario): Promise<{ witness: string; subject: string }> {
  await s.as("caseManager");
  const person = async (label: string) => {
    const [sub] = await s.tx<{ id: string }[]>`
      select api.add_case_subject(${caseB}, ${label}, 'EMPLOYEE', null) as id`;
    const [p] = await s.tx<{ person_id: string }[]>`
      select person_id from case_mgmt.case_subject where id = ${sub!.id}`;
    return p!.person_id;
  };
  return {
    witness: await person("Witness Omega (synthetic)"),
    subject: await person("Employee Sigma (synthetic)"),
  };
}

async function declare(
  s: OwnerScenario,
  f: MeetingFixture,
  users: UserKey[],
  status = "NO_CONFLICT",
): Promise<void> {
  for (const u of users) {
    await s.as(u);
    await s.tx`select api.declare_meeting_conflict(${f.participant[u]!}, ${status}, ${status === "NO_CONFLICT" ? null : REASON})`;
  }
}

/**
 * The logistics tests' meeting: the committee seated, the meeting scheduled and three witnesses invited by the
 * secretary: an employee with an account, a person of the case without one, and the case manager.
 */
async function invited(s: OwnerScenario): Promise<{
  f: MeetingFixture;
  subject: string;
  userWitness: string;
  personWitness: string;
  caseWitness: string;
}> {
  await install(s);
  const { witness: person, subject } = await people(s);
  await seat(s, ic, LOGISTICS_SEATS);
  const f = await scheduleMeeting(s, ic, caseB);
  await s.as("committeeSecretary");
  const [w] = await s.tx<{ id: string }[]>`
    select api.invite_to_meeting(${f.meeting}, 'WITNESS', ${USERS.employeeB}, null, true, ${REASON}) as id`;
  const [pw] = await s.tx<{ id: string }[]>`
    select api.invite_to_meeting(${f.meeting}, 'WITNESS', null, ${person}, true, ${REASON}) as id`;
  // The case manager, who sees the meeting through the case, is invited as a witness too.
  const [cw] = await s.tx<{ id: string }[]>`
    select api.invite_to_meeting(${f.meeting}, 'WITNESS', ${USERS.caseManager}, null, true, ${REASON}) as id`;
  return { f, subject, userWitness: w!.id, personWitness: pw!.id, caseWitness: cw!.id };
}

/** The secretary records for the person; the witness records their own accommodation, the secretary another. */
async function recorded(s: OwnerScenario, userWitness: string, personWitness: string): Promise<void> {
  await s.as("committeeSecretary");
  await s.tx`select api.declare_meeting_conflict(${personWitness}, 'NO_CONFLICT', null)`;
  await s.tx`select api.acknowledge_meeting_confidentiality(${personWitness})`;
  await s.tx`select api.record_meeting_accommodation(${userWitness}, ${ACCOMMODATION})`;
  await s.tx`select api.record_meeting_accommodation(${personWitness}, ${ACCOMMODATION})`;
  await s.as("employeeB");
  await s.tx`select api.record_meeting_accommodation(${userWitness}, 'Synthetic: a quiet waiting room.')`;
}

// The logistics sweep runs in three parts, each from the same invitations and, where it needs them, the same records,
// so that each part stays inside the 30 s per-test limit (the debt crosswalk's §5 watch item); every check of the
// single test they replace is kept, in the same state.
describe("api.meeting_view logistics (migration 2085, ADR-055)", () => {
  it("invitations, the secretary's path for an invitee without an account and accommodations follow their commands; arrangements are what RLS shows", async () => {
    await ownerScenario(async (s) => {
      const { f, subject, userWitness, personWitness } = await invited(s);
      const P = f.participant;
      await logistics(s, f.meeting, subject);
      let v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v!.capabilities).toMatchObject({ may_invite: true });
      expect(v!.invitee_roles!.map((r) => r.invitee_role)).toEqual([
        "WITNESS",
        "EXPERT",
        "LEGAL",
        "INFORMATION_PROVIDER",
        "SUBJECT",
      ]);
      // The secretary's path (ADR-054 §5): for the person without an account, never for a user.
      expect(flagsOn(v, personWitness)).toMatchObject({
        may_declare_conflict: true,
        may_declare_no_conflict: true,
        may_acknowledge_confidentiality: true,
        may_record_accommodation: true,
        may_exclude_witness: true,
      });
      expect(flagsOn(v, userWitness)).toMatchObject({
        may_declare_conflict: false,
        may_declare_no_conflict: false,
        may_acknowledge_confidentiality: false,
        may_record_accommodation: true,
        may_exclude_witness: true,
      });
      // Nobody but the secretary excludes a witness or records for another.
      expect(flagsOn(v, P.legal!)).toMatchObject({ may_exclude_witness: false, may_declare_conflict: false });
      // The witness with an account sees no roster: their own row's flags are the meeting's.
      const theirs = await meetingView(s, "employeeB", f.meeting);
      expect(theirs!.roster).toBeNull();
      expect(theirs!.capabilities).toMatchObject({
        may_record_accommodation: true,
        may_declare_conflict: true,
        may_acknowledge_confidentiality: true,
        may_invite: false,
        may_activate_acting_chair: false,
        may_activate_acting_secretary: false,
      });
      expect(theirs!.invitee_roles).toEqual([]);

      await recorded(s, userWitness, personWitness);
      await logistics(s, f.meeting, subject);
      v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(flagsOn(v, personWitness)).toMatchObject({
        may_declare_conflict: true,
        may_declare_no_conflict: false,
        may_acknowledge_confidentiality: false,
      });
      expect(rowOf(v, personWitness)!.arrangements).toMatchObject({ confidentiality_acknowledged: true });
      expect(rowOf(v, userWitness)!.arrangements!.accommodations.map((x) => x.source)).toEqual([
        "SECRETARY",
        "SELF",
      ]);
      expect((await meetingView(s, "employeeB", f.meeting))!.me!.accommodations.map((x) => x.source)).toEqual(
        ["SECRETARY", "SELF"],
      );
      // A member reads the roster, and nobody's arrangements but their own.
      for (const r of (await meetingView(s, "legal", f.meeting))!.roster!)
        expect(r.arrangements === null, r.participant_id).toBe(r.user_id !== USERS.legal);
    });
  });

  it("a concern about a witness leaves them in until it is decided; an excluded witness is offered nothing on a row the runner still reads; a view writes nothing", async () => {
    await ownerScenario(async (s) => {
      const { f, subject, userWitness, personWitness, caseWitness } = await invited(s);
      await recorded(s, userWitness, personWitness);

      // A concern about the witness with an account is open: not excluded until it is decided (CONCERN_OPEN).
      await declare(s, f, ["legal"]);
      await s.as("legal");
      await s.tx`select api.raise_meeting_conflict(${userWitness}, ${CONCERN})`;
      await logistics(s, f.meeting, subject);
      expect(
        flagsOn(await meetingView(s, "committeeSecretary", f.meeting), userWitness)!.may_exclude_witness,
      ).toBe(false);

      // The person and the case manager are excluded: nothing more on their rows (2010, 2030), which the runner still
      // reads. The case manager still sees the meeting through the case, and records nothing on their own row either.
      expect((await meetingView(s, "caseManager", f.meeting))!.capabilities).toMatchObject({
        may_record_accommodation: true,
      });
      await s.as("committeeSecretary");
      await s.tx`select api.exclude_meeting_witness(${personWitness}, ${EXCLUSION})`;
      await s.tx`select api.exclude_meeting_witness(${caseWitness}, ${EXCLUSION})`;
      await logistics(s, f.meeting, subject);
      const v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(flagsOn(v, personWitness)).toMatchObject(NONE_2085);
      expect(flagsOn(v, caseWitness)).toMatchObject(NONE_2085);
      expect(rowOf(v, personWitness)!.arrangements).toMatchObject({ confidentiality_acknowledged: true });
      expect((await meetingView(s, "caseManager", f.meeting))!.capabilities).toMatchObject({
        may_record_accommodation: false,
        may_declare_conflict: false,
        may_acknowledge_confidentiality: false,
      });
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:WITNESS_EXCLUDED",
        (tx) => tx`select api.record_meeting_accommodation(${caseWitness}, ${ACCOMMODATION})`,
      );

      // A view writes nothing: no audit row, so no ledger sequence number either.
      const written = await ledger(s);
      for (const u of MEETING_CALLERS) await meetingView(s, u, f.meeting);
      expect(await ledger(s)).toBe(written);
    });
  });

  it("the invitee-type rule and the meeting's close: may_invite and invitee_roles follow their commands (INVITEE_TYPE_DISABLED, MEETING_NOT_ACTIVE)", async () => {
    await ownerScenario(async (s) => {
      const { f, subject, userWitness, personWitness, caseWitness } = await invited(s);
      await recorded(s, userWitness, personWitness);
      // The concern and the two exclusions of the test before, so this one starts where that one ends.
      await declare(s, f, ["legal"]);
      await s.as("legal");
      await s.tx`select api.raise_meeting_conflict(${userWitness}, ${CONCERN})`;
      await s.as("committeeSecretary");
      await s.tx`select api.exclude_meeting_witness(${personWitness}, ${EXCLUSION})`;
      await s.tx`select api.exclude_meeting_witness(${caseWitness}, ${EXCLUSION})`;

      // The rule enables the interpreter, then no type at all: may_invite and invitee_roles follow
      // (INVITEE_TYPE_DISABLED). Synthetic rule values for the test only.
      await s.as("platformAdmin");
      await s.tx`select api.set_invitee_type_rule('INTERPRETER', true, true, null, 'SOURCE_REQUIRED', ${REASON})`;
      await logistics(s, f.meeting, subject);
      expect(
        (await meetingView(s, "committeeSecretary", f.meeting))!.invitee_roles!.map((r) => r.invitee_role),
      ).toContain("INTERPRETER");
      await s.as("platformAdmin");
      for (const role of ROLES)
        await s.tx`select api.set_invitee_type_rule(${role}, false, true, null, 'SOURCE_REQUIRED', ${REASON})`;
      await logistics(s, f.meeting, subject);
      let v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v!.capabilities!.may_invite).toBe(false);
      expect(v!.invitee_roles).toEqual([]);

      // A role is enabled again, then the meeting closes: no longer active, nothing is offered (MEETING_NOT_ACTIVE).
      await s.as("platformAdmin");
      await s.tx`select api.set_invitee_type_rule('WITNESS', true, true, null, 'SOURCE_REQUIRED', ${REASON})`;
      await logistics(s, f.meeting, subject);
      expect((await meetingView(s, "committeeSecretary", f.meeting))!.capabilities!.may_invite).toBe(true);
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      await logistics(s, f.meeting, subject);
      v = await meetingView(s, "committeeSecretary", f.meeting);
      for (const r of v!.roster!) expect(r.capabilities, r.participant_id).toMatchObject(NONE_2085);
      expect(v!.capabilities).toMatchObject({
        may_invite: false,
        may_record_accommodation: false,
        may_activate_acting_chair: false,
        may_activate_acting_secretary: false,
      });
    });
  });

  it("when the case leaves ACTIVE, the runner's commands that need an active case stop; the secretary's path and accommodations follow their commands, which do not", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const { witness: person, subject } = await people(s);
      await seat(s, ic, LOGISTICS_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await s.as("committeeSecretary");
      const [pw] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${f.meeting}, 'WITNESS', null, ${person}, true, ${REASON}) as id`;
      await s.tx`select api.invite_to_meeting(${f.meeting}, 'WITNESS', ${USERS.employeeB}, null, true, ${REASON})`;
      // The chair is conflicted and the deputy is not: every runner's command would accept while the case is active.
      await declare(s, f, ["committeeChair"], "CONFLICT_DECLARED");
      await declare(s, f, ["investigatorA"]);
      await logistics(s, f.meeting, subject);
      expect((await meetingView(s, "committeeSecretary", f.meeting))!.capabilities).toMatchObject({
        can_manage: true,
        may_invite: true,
        may_activate_acting_chair: true,
        may_activate_acting_secretary: true,
      });
      // The case closes with no proceeding open (CON-022, migration 2060); the meeting stays scheduled.
      await concludeProceedings(s, caseB);
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', ${REASON})`;
      await logistics(s, f.meeting, subject);
      const v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v!.capabilities).toMatchObject({
        can_manage: false,
        may_invite: false,
        may_activate_acting_chair: false,
        may_activate_acting_secretary: false,
      });
      expect(flagsOn(v, pw!.id)).toMatchObject({ may_exclude_witness: false });
    });
  });

  it("a member who declared a conflict in an earlier meeting of the proceeding may declare it again, never none (PRIOR_CONFLICT_DECLARED)", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const { subject } = await people(s);
      await seat(s, ic, LOGISTICS_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await declare(s, f, ["legal"], "CONFLICT_DECLARED");
      await s.as("committeeSecretary");
      const [m2] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${f.committeeProceeding}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '3 days', now() + interval '3 days 1 hour', ${REASON}) as id`;
      await logistics(s, m2!.id, subject);
      expect((await meetingView(s, "legal", m2!.id))!.capabilities).toMatchObject({
        may_declare_conflict: true,
        may_declare_no_conflict: false,
      });
    });
  });

  it("the acting chair and the acting secretary are offered exactly when their commands accept", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const { subject } = await people(s);
      await seat(s, ic, LOGISTICS_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const callers = MEETING_CALLERS.filter((u) => u !== "employeeB");
      const caps = async (u: UserKey) => (await meetingView(s, u, f.meeting))!.capabilities!;

      // The chair has not declared: available (CHAIR_AVAILABLE). The secretary may hand over to the alternate.
      await logistics(s, f.meeting, subject, callers);
      expect(await caps("committeeSecretary")).toMatchObject({
        may_activate_acting_chair: false,
        may_activate_acting_secretary: true,
      });
      // The alternate secretary does not activate themself, nor does the chair before declaring.
      expect((await caps("employee")).may_activate_acting_secretary).toBe(false);
      expect((await caps("committeeChair")).may_activate_acting_secretary).toBe(false);

      // The chair declares a conflict; the deputy has not declared yet (NO_ELIGIBLE_DEPUTY).
      await declare(s, f, ["committeeChair"], "CONFLICT_DECLARED");
      await logistics(s, f.meeting, subject, callers);
      expect((await caps("committeeSecretary")).may_activate_acting_chair).toBe(false);

      // The deputy declares no conflict: the runner may activate them, nobody else may.
      await declare(s, f, ["investigatorA"]);
      await logistics(s, f.meeting, subject, callers);
      expect((await caps("committeeSecretary")).may_activate_acting_chair).toBe(true);
      expect((await caps("investigatorA")).may_activate_acting_chair).toBe(false);

      // Activated (ALREADY_ACTIVATED). The acting chair may now hand the secretary's place to the alternate.
      await s.as("committeeSecretary");
      await s.tx`select api.activate_acting_chair(${f.meeting}, ${REASON})`;
      await logistics(s, f.meeting, subject, callers);
      expect((await caps("committeeSecretary")).may_activate_acting_chair).toBe(false);
      expect((await caps("investigatorA")).may_activate_acting_secretary).toBe(true);

      // The acting chair activates the acting secretary, who now runs the meeting (ALREADY_ACTIVATED for everyone).
      await s.as("investigatorA");
      await s.tx`select api.activate_acting_secretary(${f.meeting}, ${REASON})`;
      await logistics(s, f.meeting, subject, callers);
      await logistics(s, f.meeting, subject, ["employee"], "employee");
      for (const u of ["committeeSecretary", "investigatorA", "employee"] as const)
        expect((await caps(u)).may_activate_acting_secretary, u).toBe(false);
      expect((await caps("employee")).can_manage).toBe(true);
    });
  });

  it("an acting secretary needs an eligible alternate (seated, cleared, no conflict in the meeting); a conflicted secretary still hands over", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const { subject } = await people(s);
      await seat(s, ic, [...IC_SEATS, ["investigatorA", "DEPUTY_CHAIR"]]);
      const f = await scheduleMeeting(s, ic, caseB);
      const callers: UserKey[] = ["committeeSecretary", "committeeChair", "legal", "employee", "employeeB"];
      const caps = async (u: UserKey) => (await meetingView(s, u, f.meeting))!.capabilities!;

      // No alternate secretary seated (NO_ELIGIBLE_ALTERNATE).
      await logistics(s, f.meeting, subject, callers);
      expect((await caps("committeeSecretary")).may_activate_acting_secretary).toBe(false);

      // One seated after the referral, so not in the meeting: the secretary may hand over.
      await seat(s, ic, [["employee", "ALTERNATE_SECRETARY"]]);
      await logistics(s, f.meeting, subject, callers);
      expect((await caps("committeeSecretary")).may_activate_acting_secretary).toBe(true);

      // The alternate's seat ended twelve hours ago: nobody to hand over to (NO_ELIGIBLE_ALTERNATE). Appointed again
      // six hours ago: eligible again.
      await s.asOwner();
      const [alt] = await s.tx<{ id: string }[]>`
        select id from committee.membership
        where committee_id = ${ic} and user_id = ${USERS.employee} and ended_at is null`;
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(${alt!.id}, now() - interval '12 hours',
        'Synthetic: the seat ends for the test.')`;
      await logistics(s, f.meeting, subject, callers);
      expect((await caps("committeeSecretary")).may_activate_acting_secretary).toBe(false);
      await s.as("platformAdmin");
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.employee}, 'ALTERNATE_SECRETARY',
        now() - interval '6 hours', null, 'DEMO-APPT')`;
      await logistics(s, f.meeting, subject, callers);
      expect((await caps("committeeSecretary")).may_activate_acting_secretary).toBe(true);

      // Invited to this meeting, the alternate declares a conflict in it: no longer eligible (NO_ELIGIBLE_ALTERNATE).
      await s.as("committeeSecretary");
      const [inv] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${f.meeting}, 'EXPERT', ${USERS.employee}, null, true, ${REASON}) as id`;
      await s.as("employee");
      await s.tx`select api.declare_meeting_conflict(${inv!.id}, 'CONFLICT_DECLARED', ${REASON})`;
      await logistics(s, f.meeting, subject, callers);
      expect((await caps("committeeSecretary")).may_activate_acting_secretary).toBe(false);

      // The seat passes to a second alternate, after the referral: the secretary may hand over again.
      await endSeat(s, ic, "employee");
      await s.as("platformAdmin");
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.employeeB}, 'ALTERNATE_SECRETARY', now(), null,
        'DEMO-APPT')`;
      await logistics(s, f.meeting, subject, callers);
      expect((await caps("committeeSecretary")).may_activate_acting_secretary).toBe(true);

      // The secretary declares a conflict: they no longer run the meeting, and may still hand over (CONFLICTED).
      await s.as("committeeSecretary");
      await s.tx`select api.declare_meeting_conflict(${f.participant.committeeSecretary!}, 'CONFLICT_DECLARED', ${REASON})`;
      await logistics(s, f.meeting, subject, callers);
      expect(await caps("committeeSecretary")).toMatchObject({
        can_manage: false,
        may_activate_acting_secretary: true,
      });

      // The second alternate is no longer cleared for the case (owner fixture: their clearance drops below the case's).
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'INTERNAL' where id = ${USERS.employeeB}`;
      await logistics(
        s,
        f.meeting,
        subject,
        callers.filter((u) => u !== "employeeB"),
      );
      expect((await caps("committeeSecretary")).may_activate_acting_secretary).toBe(false);
    });
  });

  it("an absent, excused or ineligible chair: the acting chair follows the basis the command derives, with an eligible deputy; neither acting role during a vote", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const { subject } = await people(s);
      await seat(s, ic, [
        ...IC_SEATS,
        ["investigatorA", "DEPUTY_CHAIR"],
        ["employee", "ALTERNATE_SECRETARY"],
      ]);
      const f = await scheduleMeeting(s, ic, caseB);
      const P = f.participant;
      const callers: UserKey[] = [
        "committeeSecretary",
        "committeeChair",
        "investigatorA",
        "legal",
        "employee",
      ];
      const actingChair = async () =>
        (await meetingView(s, "committeeSecretary", f.meeting))!.capabilities!.may_activate_acting_chair;
      await declare(s, f, ["committeeChair", "investigatorA", "legal", "legalB", "lead"]);
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
      for (const u of ["investigatorA", "legal", "legalB", "lead"] as const)
        await s.tx`select api.record_attendance(${P[u]!}, 'PRESENT')`;
      await s.tx`select api.record_attendance(${P.committeeChair!}, 'ABSENT')`;
      await logistics(s, f.meeting, subject, callers);
      expect(await actingChair()).toBe(true);

      // Excused, the chair is absent too (ABSENT).
      await s.as("committeeSecretary");
      await s.tx`select api.record_excused_absence(${P.committeeChair!}, ${REASON})`;
      await logistics(s, f.meeting, subject, callers);
      expect(await actingChair()).toBe(true);

      // A vote in progress (VOTE_IN_PROGRESS), for the acting secretary as well.
      const item = await openItem(s, f.meeting);
      await logistics(s, f.meeting, subject, callers);
      expect(await meetingView(s, "committeeSecretary", f.meeting)).toMatchObject({
        capabilities: { may_activate_acting_chair: false, may_activate_acting_secretary: false },
      });
      for (const u of ["investigatorA", "legal", "legalB", "lead"] as const)
        await vote(s, u, item, "APPROVE");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item}, null)`;

      // The chair is present: available (CHAIR_AVAILABLE).
      await s.tx`select api.record_attendance(${P.committeeChair!}, 'PRESENT')`;
      await logistics(s, f.meeting, subject, callers);
      expect(await actingChair()).toBe(false);

      // Present but no longer cleared for the case (INELIGIBLE; owner fixture), then cleared again.
      await s.asOwner();
      const [c] = await s.tx<{ clearance: string }[]>`
        select clearance::text from iam.user_profile where id = ${USERS.committeeChair}`;
      await s.tx`update iam.user_profile set clearance = 'INTERNAL' where id = ${USERS.committeeChair}`;
      await logistics(s, f.meeting, subject, callers);
      expect(await actingChair()).toBe(true);
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = ${c!.clearance} where id = ${USERS.committeeChair}`;

      // The chair's seat ends (INELIGIBLE).
      await endSeat(s, ic, "committeeChair");
      await logistics(s, f.meeting, subject, callers);
      expect(await actingChair()).toBe(true);

      // The deputy is recorded absent: nobody may act as chair (NO_ELIGIBLE_DEPUTY).
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${P.investigatorA!}, 'ABSENT')`;
      await logistics(s, f.meeting, subject, callers);
      expect(await actingChair()).toBe(false);

      // Present again, then the deputy's own seat ends: no longer counted as a voter (NO_ELIGIBLE_DEPUTY).
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${P.investigatorA!}, 'PRESENT')`;
      await logistics(s, f.meeting, subject, callers);
      expect(await actingChair()).toBe(true);
      await endSeat(s, ic, "investigatorA");
      await logistics(s, f.meeting, subject, callers);
      expect(await actingChair()).toBe(false);
    });
  });

  it("a runner who sits in the meeting as deputy chair or alternate member is never offered to activate themself", async () => {
    // The deputy chair becomes the committee's secretary after the referral: they run the meeting they sit in as deputy.
    await ownerScenario(async (s) => {
      await install(s);
      const { subject } = await people(s);
      await seat(s, ic, [...IC_SEATS, ["investigatorA", "DEPUTY_CHAIR"]]);
      const f = await scheduleMeeting(s, ic, caseB);
      await endSeat(s, ic, "committeeSecretary");
      await endSeat(s, ic, "investigatorA");
      await s.as("platformAdmin");
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.investigatorA}, 'SECRETARY', now(), null,
        'DEMO-APPT')`;
      await declare(s, f, ["committeeChair"], "CONFLICT_DECLARED");
      await declare(s, f, ["investigatorA", "legal"]);
      await logistics(s, f.meeting, subject, ["investigatorA", "committeeChair", "legal"], "investigatorA");
      // The command would make them acting chair, which meeting_acting_role refuses: nobody activates themself.
      expect((await meetingView(s, "investigatorA", f.meeting))!.capabilities).toMatchObject({
        can_manage: true,
        may_activate_acting_chair: false,
      });
    });
    // The alternate member becomes the committee's secretary: they run the meeting and replace nobody themself.
    await ownerScenario(async (s) => {
      await install(s);
      const { subject } = await people(s);
      await seat(s, ic, [...IC_SEATS, ["committee", "ALTERNATE_MEMBER"]]);
      const f = await scheduleMeeting(s, ic, caseB);
      const P = f.participant;
      await declare(s, f, ["committeeChair", "legal", "legalB", "lead", "committee"]);
      await endSeat(s, ic, "committeeSecretary");
      await endSeat(s, ic, "committee");
      await s.as("platformAdmin");
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.committee}, 'SECRETARY', now(), null, 'DEMO-APPT')`;
      await s.as("committee");
      await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
      await s.tx`select api.record_attendance(${P.legalB!}, 'ABSENT')`;
      await logistics(s, f.meeting, subject, ["committee", "committeeChair", "legal"], "committee");
      expect(rowOf(await meetingView(s, "committee", f.meeting), P.committee!)!.alternate_for).toEqual([]);
    });
  });

  it("alternate_for lists exactly the members api.activate_alternate_member would replace now, for the runner only", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const { subject } = await people(s);
      await seat(s, ic, [...IC_SEATS, ["committee", "ALTERNATE_MEMBER"], ["employee", "ALTERNATE_MEMBER"]]);
      const f = await scheduleMeeting(s, ic, caseB);
      const P = f.participant;
      const callers: UserKey[] = ["committeeSecretary", "committeeChair", "legal", "committee", "employee"];
      const alternates = async () => {
        const v = await meetingView(s, "committeeSecretary", f.meeting);
        return {
          committee: rowOf(v, P.committee!)!.alternate_for,
          employee: rowOf(v, P.employee!)!.alternate_for,
        };
      };

      // Scheduled: alternates are activated only in an open meeting (MEETING_NOT_OPEN), even with the lead conflicted.
      await declare(s, f, ["committeeChair", "legal", "legalB", "committee"]);
      await declare(s, f, ["lead"], "CONFLICT_DECLARED");
      await logistics(s, f.meeting, subject, callers);
      expect(await alternates()).toEqual({ committee: [], employee: [] });

      // Open: the conflicted lead may be replaced; every other member is available (MEMBER_AVAILABLE).
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
      await logistics(s, f.meeting, subject, callers);
      expect(await alternates()).toEqual({ committee: [P.lead!], employee: [] });

      // legalB is absent too. The second alternate has not declared (COI_NOT_CLEARED).
      await s.tx`select api.record_attendance(${P.legalB!}, 'ABSENT')`;
      await logistics(s, f.meeting, subject, callers);
      expect((await alternates()).committee.sort()).toEqual([P.legalB!, P.lead!].sort());
      expect((await alternates()).employee).toEqual([]);
      // Nobody but the runner is offered one, the alternate included.
      expect(rowOf(await meetingView(s, "committee", f.meeting), P.committee!)!.alternate_for).toEqual([]);

      // legalB's absence is excused: still replaced, on the absence basis.
      await s.as("committeeSecretary");
      await s.tx`select api.record_excused_absence(${P.legalB!}, ${REASON})`;
      await logistics(s, f.meeting, subject, callers);
      expect((await alternates()).committee.sort()).toEqual([P.legalB!, P.lead!].sort());

      // The chair is absent: a voting member without a MEMBER seat, never replaced by an alternate (INVALID).
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${P.committeeChair!}, 'ABSENT')`;
      await logistics(s, f.meeting, subject, callers);
      expect((await alternates()).committee.sort()).toEqual([P.legalB!, P.lead!].sort());

      // A vote in progress (VOTE_IN_PROGRESS).
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${P.committeeChair!}, 'PRESENT')`;
      await s.tx`select api.record_attendance(${P.legal!}, 'PRESENT')`;
      const item = await openItem(s, f.meeting);
      await logistics(s, f.meeting, subject, callers);
      expect(await alternates()).toEqual({ committee: [], employee: [] });
      for (const u of ["committeeChair", "legal"] as const) await vote(s, u, item, "APPROVE");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item}, null)`;

      // The first alternate replaces legalB (ALTERNATE_ALREADY_ACTIVE, ALREADY_REPLACED); the second declares.
      await s.tx`select api.activate_alternate_member(${P.committee!}, ${P.legalB!}, ${REASON})`;
      await declare(s, f, ["employee"]);
      await logistics(s, f.meeting, subject, callers);
      expect(await alternates()).toEqual({ committee: [], employee: [P.lead!] });

      // The second alternate's clearance drops below the case's (ALTERNATE_INELIGIBLE), and is restored.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'INTERNAL' where id = ${USERS.employee}`;
      await logistics(s, f.meeting, subject, callers);
      expect((await alternates()).employee).toEqual([]);
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'CONFIDENTIAL' where id = ${USERS.employee}`;

      // legal's clearance drops while present (INELIGIBLE), and is restored.
      await s.tx`update iam.user_profile set clearance = 'INTERNAL' where id = ${USERS.legal}`;
      await logistics(s, f.meeting, subject, callers);
      expect((await alternates()).employee.sort()).toEqual([P.legal!, P.lead!].sort());
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'CONFIDENTIAL' where id = ${USERS.legal}`;
      await logistics(s, f.meeting, subject, callers);
      expect((await alternates()).employee).toEqual([P.lead!]);

      // legal's seat ends (INELIGIBLE), although present.
      await endSeat(s, ic, "legal");
      await logistics(
        s,
        f.meeting,
        subject,
        callers.filter((u) => u !== "legal"),
      );
      expect((await alternates()).employee.sort()).toEqual([P.legal!, P.lead!].sort());

      // The second alternate's own seat ends (ALTERNATE_INELIGIBLE).
      await endSeat(s, ic, "employee");
      await logistics(s, f.meeting, subject, ["committeeSecretary", "committeeChair", "committee"]);
      expect((await alternates()).employee).toEqual([]);
    });
  });

  it("on a grievance, an alternate who sat on the case's Investigation Committee replaces nobody (FIREWALL_RESTRICTED); may_invite leaves the firewalled member's role to the command", async () => {
    await ownerScenario(async (s) => {
      await install(s);
      const { subject } = await people(s);
      await seat(s, ic, IC_SEATS); // legal and lead vote on the Investigation Committee
      await seat(s, gc, [
        ["committee", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["investigatorA", "MEMBER"],
        ["employee", "MEMBER"],
        ["lead", "MEMBER"], // firewall-restricted on the grievance, not in its meetings
        ["legal", "ALTERNATE_MEMBER"],
        ["employeeB", "ALTERNATE_MEMBER"],
      ]);
      const icp = await refer(s, ic, caseB);
      const cp = await refer(s, gc, caseB);
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp}, 'HEARING', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      const meeting = m!.id;
      const parts = await s.tx<{ id: string; user_id: string }[]>`
        select id, user_id from committee.meeting_participant where meeting_id = ${meeting}`;
      const p = (u: UserKey) => parts.find((x) => x.user_id === USERS[u])!.id;
      expect(parts.some((x) => x.user_id === USERS.lead)).toBe(false);
      for (const u of ["committee", "investigatorA", "employee", "legal", "employeeB"] as const) {
        await s.as(u);
        await s.tx`select api.declare_meeting_conflict(${p(u)}, 'NO_CONFLICT', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${meeting}, ${REASON})`;
      await s.tx`select api.record_attendance(${p("employee")}, 'ABSENT')`;
      const callers: UserKey[] = ["committeeSecretary", "committee", "legal", "employeeB", "lead"];
      await logistics(s, meeting, subject, callers);
      // The committee page counts the firewall-restricted member, who still sees the proceeding on their seat.
      await committees(s, callers, [icp, cp]);
      expect(
        (await committeeView(s, "lead", gc))!.proceedings.find((x) => x.committee_proceeding_id === cp)!
          .snapshot,
      ).toMatchObject({ firewall_restricted: 1 });
      const v = await meetingView(s, "committeeSecretary", meeting);
      expect(rowOf(v, p("legal"))!.alternate_for).toEqual([]);
      expect(rowOf(v, p("employeeB"))!.alternate_for).toEqual([p("employee")]);
      await s.expectError(
        "CDF_CONFLICT:FIREWALL_RESTRICTED",
        (tx) => tx`select api.activate_alternate_member(${p("legal")}, ${p("employee")}, ${REASON})`,
      );
      // Inviting is offered; which role the firewall-restricted member may take is the command's to answer.
      expect(v!.capabilities!.may_invite).toBe(true);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.invite_to_meeting(${meeting}, 'LEGAL', ${USERS.lead}, null, true, ${REASON})`,
      );
      await s.tx`select api.invite_to_meeting(${meeting}, 'WITNESS', ${USERS.lead}, null, true, ${REASON})`;
    });
  });
});
