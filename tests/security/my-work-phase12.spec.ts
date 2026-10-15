// UX redesign Phase 12, P12-0b (migration 2045; ADR-051; Linear CDF-211) · §18, §19, §21, §39, §40: the Phase 12 My
// Work kinds, the My Committees and widened Administration areas, what a committee referral would copy, and the 1870
// events in the case history.
//
// A My Work row never offers what its command refuses: every kind is checked against the command it leads to, run by
// each user in a savepoint that is rolled back, and the users who hold a row are pinned. Where the kind is meant to
// reach everyone the command accepts, the reverse holds too. A row carries ids, codes and dates only, and the case
// only under its metadata rule (DEC-22). The referral preview answers the referral command's own refusals first and
// then counts only: holders per seat and four totals, never an id, a name or a flag per seat (coordinator ruling,
// 2026-10-14). Every step runs through the api.* commands as `authenticated`; the owner connection only lists the seed
// users, reads what a step wrote and sets the fixtures named where used.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import {
  USERS,
  caseId,
  ledgerMark,
  madeSince,
  ownerScenario,
  scenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import {
  IC_SEATS,
  REASON,
  committeeIds,
  openItem,
  openWithPresent,
  preliminaryReferral,
  refer,
  scheduleMeeting,
  seat,
  unseatDemoSeats,
  vote,
} from "../support/committee";
import { caseFacts, draftPackage, requestLegalReview, voteOnPackage } from "../support/decision";
import { GRIEVANCE_GROUNDS, GRIEVANCE_SEATS, approvedGrievanceVote } from "../support/grievance";
import { closeAndArchive } from "../support/records";

const OPS = "b0000000-0000-4000-8000-000000000001";
const SUMMARY = "Synthetic: unique-referral-marker-2045, a referral summary for the My Work test.";
const SHA = "a".repeat(64);

let caseA: string, caseB: string, caseExec: string, ic: string, gc: string;
beforeAll(async () => {
  [caseA, caseB, caseExec] = await Promise.all([caseId("0001"), caseId("0002"), caseId("0003")]);
  ({ ic, gc } = await committeeIds());
});

// ---- The harness ---------------------------------------------------------------------------------------------------

interface Item {
  area: string;
  view: string;
  category: string;
  target_type: string;
  target_id: string;
  case_id: string | null;
  case_number: string | null;
  due_at: Date | null;
  due_source: string | null;
  since_at: Date | null;
  code: string | null;
  reason_codes: string[] | null;
}
type Probe = (tx: Tx) => Promise<unknown>;

/** Every seed user who can sign in. */
const ALL = (Object.keys(USERS) as UserKey[]).filter((u) => u !== "revoked");

async function rowsOf(s: Scenario, user: UserKey, target: string, category?: string): Promise<Item[]> {
  await s.as(user);
  const rows = await s.tx<Item[]>`select * from api.my_work_items() where target_id = ${target}`;
  return category ? rows.filter((r) => r.category === category) : rows;
}

class Undo extends Error {}

/** Runs a command in a savepoint that is always rolled back: "OK", or the CDF error it refused with. Any other error
 *  (a test mistake, a missing grant) fails the test. */
async function attempt(s: Scenario, run: Probe): Promise<string> {
  try {
    await s.tx.savepoint(async (sp) => {
      await run(sp as unknown as Tx);
      throw new Undo();
    });
  } catch (error) {
    if (error instanceof Undo) return "OK";
    const message = (error as Error).message;
    if (message.startsWith("CDF_")) return message;
    throw error;
  }
  throw new Error("the savepoint was not rolled back");
}

/**
 * For each user: their rows of `category` on `target` (at most one) and the command run now by the same user. A row
 * never offers a command that refuses (always checked); with `complete`, everyone the command accepts has the row.
 * Returns the users holding a row, to pin.
 */
async function agrees(
  s: Scenario,
  category: string,
  target: string,
  command: (user: UserKey) => Probe,
  complete = true,
  users: UserKey[] = ALL,
): Promise<UserKey[]> {
  const holders: UserKey[] = [];
  const wrong: string[] = [];
  for (const user of users) {
    const mine = await rowsOf(s, user, target, category);
    if (mine.length > 1) wrong.push(`${user}: ${mine.length} rows`);
    await s.as(user);
    const result = await attempt(s, command(user));
    if (mine.length && result !== "OK") wrong.push(`${user}: a row, but the command refused with ${result}`);
    if (complete && !mine.length && result === "OK") wrong.push(`${user}: no row, but the command accepts`);
    if (mine.length) holders.push(user);
  }
  expect(wrong, category).toEqual([]);
  return holders;
}

/** Every row of every user names a case only where that user may see the case's metadata, and its number with it. */
async function casesUnderMetadata(s: Scenario, users: UserKey[] = ALL): Promise<void> {
  const wrong: string[] = [];
  for (const user of users) {
    await s.as(user);
    for (const r of await s.tx<Item[]>`select * from api.my_work_items()`) {
      if ((r.case_id === null) !== (r.case_number === null))
        wrong.push(`${user} ${r.category}: id without number`);
      if (r.case_id === null) continue;
      const [m] = await s.tx<{ ok: boolean }[]>`select authz.can_view_case_metadata(${r.case_id}) as ok`;
      if (!m!.ok) wrong.push(`${user} ${r.category}: a case without metadata access`);
    }
  }
  expect(wrong).toEqual([]);
}

const one = async <T>(rows: Promise<T[]>): Promise<T> => (await rows)[0]!;

// ---- Areas ---------------------------------------------------------------------------------------------------------

interface Area {
  area_code: string;
  actionable_count: number;
  default_view: string;
}
const areasOf = async (s: Scenario, user: UserKey) => {
  await s.as(user);
  return s.tx<Area[]>`select * from api.my_areas()`;
};
const codesOf = async (s: Scenario, user: UserKey) => (await areasOf(s, user)).map((a) => a.area_code);

describe("areas: My Committees «لجاني» and the widened Administration (ADR-051)", () => {
  it("never more than five areas for any active seed user, the demo committee seats included", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const users = await s.tx<{ id: string; email: string }[]>`
        select id, email from iam.user_profile where status = 'ACTIVE' order by email`;
      expect(users.length).toBeGreaterThanOrEqual(32);
      // Whoever holds a current seat (the seven demo seats of seed 30 on a fresh database).
      const seated = (
        await s.tx<{ user_id: string }[]>`
          select distinct m.user_id from committee.membership m
           where authz.user_committee_seat(m.user_id, m.committee_id, now()) is not null`
      )
        .map((r) => r.user_id)
        .sort();
      expect(seated.length).toBeGreaterThan(0);
      const over: string[] = [];
      const committee: string[] = [];
      for (const u of users) {
        await s.tx`reset role`;
        await s.tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: u.id, role: "authenticated" })}, true)`;
        await s.tx.unsafe("set local role authenticated");
        const areas = (await s.tx<Area[]>`select * from api.my_areas()`).map((a) => a.area_code);
        if (areas.length > 5) over.push(`${u.email}: ${areas.join(",")}`);
        if (areas.includes("COMMITTEE")) committee.push(u.id);
      }
      expect(over).toEqual([]);
      expect(committee.sort()).toEqual(seated);
    });
  });

  it("a committee seat makes five for the GRC Director, never six", async () => {
    await scenario(async (s) => {
      await seat(s, ic, [...IC_SEATS, ["grcDirector", "MEMBER"]]);
      expect(await codesOf(s, "grcDirector")).toEqual([
        "MY_WORK",
        "CASES",
        "COMMITTEE",
        "RECORDS",
        "ADMINISTRATION",
      ]);
    });
  });

  it("My Committees follows the current seat: never a past seat, a proceeding membership alone or COMMITTEE_ADMIN", async () => {
    await ownerScenario(async (s) => {
      await unseatDemoSeats(s);
      for (const u of [
        "committeeChair",
        "legal",
        "complianceManager",
        "platformAdmin",
        "grcDirector",
      ] as const)
        expect(await codesOf(s, u), u).not.toContain("COMMITTEE");
      await seat(s, ic, IC_SEATS);
      for (const [u] of IC_SEATS) expect(await codesOf(s, u), u).toContain("COMMITTEE");
      // A referral snapshots the seats; then legal's seat ends. The snapshot row stays as history (AMB-039), and opens
      // nothing: no area and no work.
      const cp = await refer(s, ic, caseB);
      await s.asOwner();
      const [m] = await s.tx<{ id: string }[]>`
        select id from committee.membership where committee_id = ${ic} and user_id = ${USERS.legal} and ended_at is null`;
      const [pm] = await s.tx<{ n: number }[]>`
        select count(*)::int as n from committee.proceeding_member where committee_proceeding_id = ${cp} and user_id = ${USERS.legal}`;
      expect(pm!.n).toBe(1);
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(${m!.id}, now(), 'Synthetic: the seat ends for the test.')`;
      expect(await codesOf(s, "legal")).not.toContain("COMMITTEE");
      expect((await areasOf(s, "committeeChair")).find((a) => a.area_code === "COMMITTEE")).toMatchObject({
        default_view: "committees",
      });
      // COMMITTEE_ADMIN administers seats: Administration, never My Committees or a case.
      expect(await codesOf(s, "complianceManager")).toEqual(["MY_WORK", "ADMINISTRATION"]);
    });
  });

  it("Administration: the business administration permissions, the first page each may use, no count and no case", async () => {
    await ownerScenario(async (s) => {
      const admin_ = async (u: UserKey) =>
        (await areasOf(s, u)).find((a) => a.area_code === "ADMINISTRATION");
      expect(await admin_("platformAdmin")).toEqual({
        area_code: "ADMINISTRATION",
        actionable_count: 0,
        default_view: "users",
      });
      for (const u of ["complianceManager", "grcDirector", "grcDeputy"] as const)
        expect(await admin_(u), u).toEqual({
          area_code: "ADMINISTRATION",
          actionable_count: 0,
          default_view: "committees",
        });
      for (const u of ["caseManager", "intake", "legal", "records", "committee", "dpo", "soc"] as const)
        expect(await admin_(u), u).toBeUndefined();
      // Export policy shows only for whoever its commands accept (authz.is_export_policy_admin, 2040): an export
      // approver is never a policy administrator. Fixture: the intake officer's role gains the permission.
      await s.asOwner();
      await s.tx`insert into iam.role_permission (role_code, permission_code) values ('INTAKE_OFFICER', 'EXPORT_POLICY_ADMIN')`;
      expect(await admin_("intake")).toEqual({
        area_code: "ADMINISTRATION",
        actionable_count: 0,
        default_view: "export-policy",
      });
      await s.asOwner();
      await s.tx`insert into iam.role_permission (role_code, permission_code) values ('INTAKE_OFFICER', 'EXPORT_APPROVE')`;
      expect(await admin_("intake")).toBeUndefined();
      await s.asOwner();
      await s.tx`insert into iam.role_permission (role_code, permission_code)
                 values ('INTAKE_OFFICER', 'BUSINESS_CALENDAR_ADMIN')`;
      expect((await admin_("intake"))?.default_view).toBe("calendar");
      // Administration opens no case: the intake officer's areas are otherwise unchanged.
      expect(await codesOf(s, "intake")).toEqual(["MY_WORK", "INTAKE", "ADMINISTRATION"]);
    });
  });
});

// ---- Referrals and preliminary review ------------------------------------------------------------------------------

/** Seats a chair, a secretary and one voting member on the Investigation Committee (as referral-preliminary.spec). */
async function constitute(s: Scenario) {
  await unseatDemoSeats(s);
  for (const [user, seatCode] of [
    ["committeeChair", "CHAIR"],
    ["committeeSecretary", "SECRETARY"],
    ["committee", "MEMBER"],
  ] as const) {
    await s.tx`select api.appoint_committee_member(${ic}, ${USERS[user]}, ${seatCode}, now() - interval '1 day', null, 'DEMO-APPT')`;
  }
}

const QUEUE_CATEGORY: Record<string, string> = {
  SECTOR_DECISION: "REFERRAL_TO_APPROVE",
  SECRETARY_DECISION: "REFERRAL_TO_ACCEPT",
  ESCALATION_DECISION: "REFERRAL_ESCALATION_TO_DECIDE",
  COMPLETION: "REFERRAL_RETURNED",
};

/** Each user's referral rows on the referral are the referral queue's rows, by category; returns the holders. */
async function referralQueueAgrees(s: Scenario, id: string): Promise<Record<string, string>> {
  const held: Record<string, string> = {};
  for (const user of ALL) {
    await s.as(user);
    const queue = await s.tx<
      { awaiting: string }[]
    >`select awaiting from api.referral_queue() where referral_id = ${id}`;
    const rows = (await rowsOf(s, user, id)).filter((r) => r.target_type === "REFERRAL");
    expect(
      rows.map((r) => r.category),
      user,
    ).toEqual(queue.map((q) => QUEUE_CATEGORY[q.awaiting]));
    if (rows[0]) held[user] = rows[0].category;
  }
  return held;
}

describe("My Work: referrals and the preliminary review", () => {
  it("a referral reaches exactly whom it awaits, with its code and the reasons it came back for (AMB-250)", async () => {
    await ownerScenario(async (s) => {
      await constitute(s);
      await s.as("employee");
      const id = (
        await one(
          s.tx<{ id: string }[]>`
            select api.create_referral(${OPS}, 'Referral (synthetic)', ${SUMMARY}, 'FRAUD',
              'RESTRICTED'::core.classification_level) as id`,
        )
      ).id;
      expect(await referralQueueAgrees(s, id)).toEqual({}); // a draft is nobody's work yet
      await s.as("employee");
      await s.tx`select api.submit_referral(${id}, null)`;

      // The sector head decides.
      expect(await referralQueueAgrees(s, id)).toEqual({ sectorHead: "REFERRAL_TO_APPROVE" });
      expect(
        await agrees(
          s,
          "REFERRAL_TO_APPROVE",
          id,
          () => (tx) => tx`select api.sector_decide_referral(${id}, 'APPROVE', null, null)`,
        ),
      ).toEqual(["sectorHead"]);

      // Returned to draft by the sector: its preparer, with the sector's reasons.
      await s.as("sectorHead");
      await s.tx`select api.sector_decide_referral(${id}, 'RETURN', array['MISSING_DOCUMENTS'], null)`;
      expect(
        await agrees(s, "REFERRAL_RETURNED", id, () => (tx) => tx`select api.submit_referral(${id}, null)`),
      ).toEqual(["employee"]);
      const [returned] = await rowsOf(s, "employee", id, "REFERRAL_RETURNED");
      expect(returned).toMatchObject({
        area: "MY_WORK",
        view: "NEEDS_ACTION",
        target_type: "REFERRAL",
        case_id: null,
        case_number: null,
        due_at: null,
        due_source: null,
        code: "SECTOR_RETURNED",
        reason_codes: ["MISSING_DOCUMENTS"],
      });

      // At the secretary: committee work for the current IC secretary, with the referral's status.
      await s.as("employee");
      await s.tx`select api.submit_referral(${id}, null)`;
      await s.as("sectorHead");
      await s.tx`select api.sector_decide_referral(${id}, 'APPROVE', null, null)`;
      expect(await referralQueueAgrees(s, id)).toEqual({ committeeSecretary: "REFERRAL_TO_ACCEPT" });
      const [atSecretary] = await rowsOf(s, "committeeSecretary", id, "REFERRAL_TO_ACCEPT");
      await s.asOwner();
      const [status] = await s.tx<{ status: string }[]>`select status from intake.referral where id = ${id}`;
      expect(atSecretary).toMatchObject({ area: "COMMITTEE", code: status!.status, reason_codes: null });

      // Returned for completion: the preparer again, with the secretary's reasons and the event that returned it.
      await s.as("committeeSecretary");
      await s.tx`select api.secretary_decide_referral(${id}, 'RETURN_FOR_COMPLETION', array['MISSING_INFORMATION'], null, null)`;
      expect(await referralQueueAgrees(s, id)).toEqual({ employee: "REFERRAL_RETURNED" });
      await s.asOwner();
      const [ev] = await s.tx<{ event_type: string }[]>`
        select event_type from intake.referral_event
        where referral_id = ${id} and event_type not in ('COMMENTED', 'UPDATED')
        order by occurred_at desc, id desc limit 1`;
      expect(await rowsOf(s, "employee", id, "REFERRAL_RETURNED")).toEqual([
        expect.objectContaining({ code: ev!.event_type, reason_codes: ["MISSING_INFORMATION"] }),
      ]);
      await casesUnderMetadata(s, ["employee", "sectorHead", "committeeSecretary", "committeeChair"]);
    });
  });

  it("an escalation reaches the holder of the target seat, as committee work (DEC-F09)", async () => {
    await scenario(async (s) => {
      await constitute(s);
      await s.as("employee");
      const id = (
        await one(
          s.tx<{ id: string }[]>`
            select api.create_referral(${OPS}, 'Referral (synthetic)', ${SUMMARY}, 'FRAUD',
              'RESTRICTED'::core.classification_level) as id`,
        )
      ).id;
      await s.tx`select api.submit_referral(${id}, null)`;
      const sectorApproves = async () => {
        await s.as("sectorHead");
        await s.tx`select api.sector_decide_referral(${id}, 'APPROVE', null, null)`;
      };
      const secretaryRejects = async () => {
        await s.as("committeeSecretary");
        await s.tx`select api.secretary_decide_referral(${id}, 'REJECT', array['OUT_OF_SCOPE'], null, null)`;
      };
      await sectorApproves();
      await secretaryRejects();
      await s.as("sectorHead");
      await s.tx`select api.object_to_referral_rejection(${id}, 'Synthetic: the rejection misreads the facts.')`;
      await secretaryRejects();
      await s.as("sectorHead");
      await s.tx`select api.escalate_referral_rejection(${id}, 'Synthetic: the rejection misreads the scope.')`;
      expect(await referralQueueAgrees(s, id)).toEqual({ committeeChair: "REFERRAL_ESCALATION_TO_DECIDE" });
      expect(
        await agrees(
          s,
          "REFERRAL_ESCALATION_TO_DECIDE",
          id,
          () => (tx) =>
            tx`select api.decide_referral_escalation(${id}, 'UPHOLD', array['OUT_OF_SCOPE'], null, null)`,
        ),
      ).toEqual(["committeeChair"]);
      expect(await rowsOf(s, "committeeChair", id)).toEqual([
        expect.objectContaining({ area: "COMMITTEE", code: null, reason_codes: null }),
      ]);
    });
  });

  it("a preliminary recommendation: to review, then to approve, and back to its preparer with the reasons", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const r = (
        await one(
          s.tx<{ id: string }[]>`
            select api.prepare_preliminary_recommendation(${caseA}, 'INVESTIGATION_WARRANTED',
              'Synthetic: grounds to investigate.') as id`,
        )
      ).id;
      // Reviewed by a holder of PRELIMINARY_REVIEW who sees the case, never by its preparer.
      expect(
        await agrees(
          s,
          "PRELIMINARY_TO_REVIEW",
          r,
          () => (tx) => tx`select api.review_preliminary_recommendation(${r}, 'ENDORSE', null, null)`,
        ),
      ).toEqual(["grcDirector", "grcDeputy"]);
      expect(await rowsOf(s, "grcDirector", r, "PRELIMINARY_TO_REVIEW")).toEqual([
        expect.objectContaining({ area: "CASES", target_type: "PRELIMINARY_REVIEW", case_id: caseA }),
      ]);

      // Returned with structured reasons: its preparer prepares the next version.
      await s.as("grcDirector");
      await s.tx`select api.review_preliminary_recommendation(${r}, 'RETURN', array['RECOMMENDATION_INCOMPLETE'], null)`;
      // Anyone entitled may prepare a next version; the returned work is its preparer's (AMB-250).
      expect(
        await agrees(
          s,
          "PRELIMINARY_RETURNED",
          r,
          () => (tx) =>
            tx`select api.prepare_preliminary_recommendation(${caseA}, 'NO_ACTION', 'Synthetic: revised after return.')`,
          false,
        ),
      ).toEqual(["investigatorA"]);
      expect(await rowsOf(s, "investigatorA", r, "PRELIMINARY_RETURNED")).toEqual([
        expect.objectContaining({ reason_codes: ["RECOMMENDATION_INCOMPLETE"], code: null }),
      ]);
      // The next version, by anyone, ends it.
      await s.as("lead");
      const r2 = (
        await one(
          s.tx<{ id: string }[]>`
            select api.prepare_preliminary_recommendation(${caseA}, 'INVESTIGATION_WARRANTED',
              'Synthetic: revised by the lead.') as id`,
        )
      ).id;
      expect(await rowsOf(s, "investigatorA", r, "PRELIMINARY_RETURNED")).toEqual([]);

      // Endorsed: the approver, who never sees the case, never by the preparer or the reviewer.
      await s.as("grcDirector");
      await s.tx`select api.review_preliminary_recommendation(${r2}, 'ENDORSE', null, null)`;
      expect(
        await agrees(
          s,
          "PRELIMINARY_TO_APPROVE",
          r2,
          () => (tx) => tx`select api.approve_preliminary_recommendation(${r2}, 'APPROVE', null, null)`,
        ),
      ).toEqual(["grcSectorHead"]);
      // Purpose-bound (1880): the approver's row names no case, and lives in My Work.
      expect(await rowsOf(s, "grcSectorHead", r2)).toEqual([
        expect.objectContaining({ area: "MY_WORK", case_id: null, case_number: null }),
      ]);
      await casesUnderMetadata(s, ["grcSectorHead", "grcDirector", "investigatorA", "lead"]);
    });
  });
});

// ---- Committee work ------------------------------------------------------------------------------------------------

describe("My Work: meetings, declarations, conflicts, votes and minutes follow the current seat (AMB-047, AMB-039)", () => {
  it("a scheduled meeting: attendance and the declaration each participant owes, for seated participants only", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const declare = (user: UserKey) => (tx: Tx) =>
        tx`select api.declare_meeting_conflict(${f.participant[user] ?? f.participant.committeeChair!}, 'NO_CONFLICT', null)`;
      const owe = await agrees(s, "COI_TO_DECLARE", f.meeting, declare);
      expect(owe.sort()).toEqual(["committeeChair", "committeeSecretary", "lead", "legal", "legalB"].sort());
      for (const u of owe)
        expect(await rowsOf(s, u, f.meeting, "COI_TO_DECLARE"), u).toEqual([
          expect.objectContaining({ area: "COMMITTEE", view: "NEEDS_ACTION", target_type: "MEETING" }),
        ]);

      // Attendance is information, not a command: every participant who still takes part, due at the start.
      await s.asOwner();
      const [m] = await s.tx<{ scheduled_start: Date }[]>`
        select scheduled_start from committee.meeting where id = ${f.meeting}`;
      const attending: UserKey[] = [];
      for (const u of ALL) {
        const rows = await rowsOf(s, u, f.meeting, "MEETING_TO_ATTEND");
        if (rows.length) attending.push(u);
        for (const r of rows)
          expect(r, u).toMatchObject({
            area: "COMMITTEE",
            view: "DUE_SOON",
            due_at: m!.scheduled_start,
            due_source: "SCHEDULE",
          });
      }
      expect(attending.sort()).toEqual(
        ["committeeChair", "committeeSecretary", "lead", "legal", "legalB"].sort(),
      );
      // The case team sees the meeting without sitting in it: no work.
      expect(await rowsOf(s, "caseManager", f.meeting)).toEqual([]);

      // legalB's seat ends: from then on no meeting, no declaration and no area (AMB-039, AMB-047).
      await s.asOwner();
      const [mb] = await s.tx<{ id: string }[]>`
        select id from committee.membership where committee_id = ${ic} and user_id = ${USERS.legalB} and ended_at is null`;
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(${mb!.id}, now(), 'Synthetic: the seat ends for the test.')`;
      expect(await rowsOf(s, "legalB", f.meeting)).toEqual([]);
      expect(await codesOf(s, "legalB")).not.toContain("COMMITTEE");
      // The 2030 command still takes a declaration from a participant whose seat ended (a declaration is never
      // harmful); My Work no longer offers it, so the check runs one way only.
      expect(await agrees(s, "COI_TO_DECLARE", f.meeting, declare, false)).not.toContain("legalB");

      // Declared: the declaration is no longer owed.
      await s.as("legal");
      await s.tx`select api.declare_meeting_conflict(${f.participant.legal!}, 'NO_CONFLICT', null)`;
      expect(await rowsOf(s, "legal", f.meeting, "COI_TO_DECLARE")).toEqual([]);
    });
  });

  it("a raised conflict goes to its decider; an open vote to each present voter who has not voted", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await openWithPresent(s, f, ["committeeChair", "legal", "legalB", "lead"]);
      await s.as("legal");
      const k = (
        await one(
          s.tx<{ id: string }[]>`
            select api.raise_meeting_conflict(${f.participant.lead!}, 'Synthetic: works for the subject''s unit.') as id`,
        )
      ).id;
      expect(
        await agrees(
          s,
          "CONFLICT_CONCERN_TO_DECIDE",
          f.meeting,
          () => (tx) =>
            tx`select api.decide_meeting_conflict(${k}, 'DISMISSED', 'Synthetic: decided on the record.')`,
        ),
      ).toEqual(["committeeChair"]);
      expect(await rowsOf(s, "committeeChair", f.meeting, "CONFLICT_CONCERN_TO_DECIDE")).toEqual([
        expect.objectContaining({ area: "COMMITTEE", code: "CHAIR" }),
      ]);
      await s.as("committeeChair");
      await s.tx`select api.decide_meeting_conflict(${k}, 'DISMISSED', 'Synthetic: decided on the record.')`;

      const item = await openItem(s, f.meeting);
      const cast = () => (tx: Tx) => tx`select api.cast_vote(${item}, 'APPROVE', null)`;
      expect((await agrees(s, "VOTE_OPEN", f.meeting, cast)).sort()).toEqual(
        ["committeeChair", "lead", "legal", "legalB"].sort(),
      );
      await vote(s, "legal", item, "APPROVE");
      expect(await agrees(s, "VOTE_OPEN", f.meeting, cast)).not.toContain("legal");
      await casesUnderMetadata(s, [
        "committeeChair",
        "legal",
        "legalB",
        "lead",
        "committeeSecretary",
        "caseManager",
      ]);
    });
  });

  it("minutes in review reach each reviewer who has not reviewed, due at the end of the review period", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const voters: UserKey[] = ["committeeChair", "legal", "legalB", "lead"];
      const f = await scheduleMeeting(s, ic, caseB);
      await openWithPresent(s, f, voters);
      const item = await openItem(s, f.meeting);
      for (const u of voters) await vote(s, u, item, "APPROVE");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item}, null)`;
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      const minutes = (
        await one(
          s.tx<
            { id: string }[]
          >`select api.generate_minutes(${f.meeting}, 'Synthetic minutes narrative.') as id`,
        )
      ).id;
      const review = () => (tx: Tx) => tx`select api.review_minutes(${minutes}, 'APPROVE', null)`;
      expect((await agrees(s, "MINUTES_TO_REVIEW", minutes, review)).sort()).toEqual([...voters].sort());
      await s.asOwner();
      const [mi] = await s.tx<{ review_due_at: Date | null }[]>`
        select review_due_at from committee.minutes where id = ${minutes}`;
      expect(await rowsOf(s, "legal", minutes)).toEqual([
        expect.objectContaining({
          area: "COMMITTEE",
          target_type: "MINUTES",
          due_at: mi!.review_due_at,
          due_source: mi!.review_due_at === null ? null : "MINUTES_REVIEW",
        }),
      ]);
      await s.as("legal");
      await s.tx`select api.review_minutes(${minutes}, 'APPROVE', null)`;
      expect(await agrees(s, "MINUTES_TO_REVIEW", minutes, review)).not.toContain("legal");
    });
  });
});

// ---- Decisions, notices and grievances -----------------------------------------------------------------------------

describe("My Work: legal review, notices and grievances", () => {
  it("a legal review reaches its assigned reviewer while they may give the opinion", async () => {
    await scenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      await voteOnPackage(s, f);
      const { request } = await requestLegalReview(s, f);
      expect(
        await agrees(
          s,
          "LEGAL_REVIEW_ASSIGNED",
          request,
          () => (tx) => tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`,
        ),
      ).toEqual(["legalB"]);
      await s.as("legalB");
      await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
      expect(await rowsOf(s, "legalB", request)).toEqual([]);
    });
  });

  it("a subject's notices reach the linked employee only: to acknowledge, and a defence due by its date", async () => {
    await ownerScenario(async (s) => {
      const facts = await caseFacts(s, caseB);
      await s.as("caseManager");
      await s.tx`select api.link_subject_portal_account(${facts.subject}, ${USERS.employee}, ${REASON})`;
      const rights = (
        await one(
          s.tx<{ id: string }[]>`
            select api.issue_rights_notice(${facts.subject}, 'Synthetic: your rights in this matter.',
              ${[facts.allegation]}::uuid[]) as id`,
        )
      ).id;
      expect(
        await agrees(
          s,
          "NOTICE_TO_ACKNOWLEDGE",
          rights,
          () => (tx) => tx`select api.acknowledge_defence_notice(${rights})`,
        ),
      ).toEqual(["employee"]);
      expect(await rowsOf(s, "employee", rights)).toEqual([
        expect.objectContaining({
          area: "MY_WORK",
          target_type: "DEFENCE_NOTICE",
          code: "RIGHTS",
          case_id: null,
        }),
      ]);

      await s.as("caseManager");
      const defence = (
        await one(
          s.tx<{ id: string }[]>`
            select api.issue_defence_notice(${facts.subject}, 'Synthetic: you are invited to respond.',
              ${[facts.allegation]}::uuid[], now() + interval '10 days') as id`,
        )
      ).id;
      expect(
        await agrees(
          s,
          "DEFENCE_DUE",
          defence,
          () => (tx) =>
            tx`select api.submit_defence_response(${defence}, 'Synthetic: my response to the allegation.')`,
        ),
      ).toEqual(["employee"]);
      await s.asOwner();
      const [n] = await s.tx<
        { due_at: Date }[]
      >`select due_at from grievance.defence_notice where id = ${defence}`;
      expect(await rowsOf(s, "employee", defence)).toEqual([
        expect.objectContaining({
          category: "DEFENCE_DUE",
          due_at: n!.due_at,
          due_source: "NOTICE",
          code: null,
        }),
      ]);
      // Linked to the subject's portal account only: a colleague linked to nothing, and the case team, get nothing.
      for (const u of ["employeeB", "caseManager", "investigatorB"] as const)
        expect(await rowsOf(s, u, defence), u).toEqual([]);
    });
  });

  it("grievance rows are the grievance queue's, as committee work for the seated", async () => {
    await scenario(async (s) => {
      await seat(s, gc, GRIEVANCE_SEATS);
      await s.as("caseManager");
      const subject = (
        await one(
          s.tx<{ id: string }[]>`
            select api.add_case_subject(${caseB}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`,
        )
      ).id;
      const link = (
        await one(
          s.tx<
            { id: string }[]
          >`select api.link_subject_portal_account(${subject}, ${USERS.employee}, ${REASON}) as id`,
        )
      ).id;
      await s.as("employee");
      const g = (
        await one(
          s.tx<{ id: string }[]>`select api.file_grievance(${link}, now(), ${GRIEVANCE_GROUNDS}) as id`,
        )
      ).id;
      const CATEGORY: Record<string, string> = {
        ASSESSMENT: "GRIEVANCE_RECEIVED",
        ADMISSIBILITY_DECISION: "ADMISSIBILITY_TO_DECIDE",
        OUTCOME: "GRIEVANCE_OUTCOME_TO_RECORD",
      };
      const queueAgrees = async () => {
        const held: Record<string, string> = {};
        for (const user of ALL) {
          await s.as(user);
          const queue = await s.tx<{ awaiting: string; kind: string }[]>`
            select awaiting, kind from api.grievance_queue() where grievance_id = ${g}`;
          const rows = (await rowsOf(s, user, g)).filter((r) => Object.values(CATEGORY).includes(r.category));
          expect(
            rows.map((r) => [r.category, r.code, r.area]),
            user,
          ).toEqual(queue.map((q) => [CATEGORY[q.awaiting], q.kind, "COMMITTEE"]));
          if (rows[0]) held[user] = rows[0].category;
        }
        return held;
      };
      expect(await queueAgrees()).toEqual({ committeeSecretary: "GRIEVANCE_RECEIVED" });
      await s.as("committeeSecretary");
      await s.tx`select api.assess_grievance_admissibility(${g}, 'INADMISSIBLE', null, ${REASON})`;
      expect(await queueAgrees()).toEqual({ committee: "ADMISSIBILITY_TO_DECIDE" });
      await s.as("committee");
      await s.tx`select api.decide_grievance_admissibility(${g}, 'ADMISSIBLE', 'GC-DEMO-2045', ${REASON})`;
      expect(await queueAgrees()).toEqual({});
      await approvedGrievanceVote(s, g);
      expect(await queueAgrees()).toEqual({ committeeSecretary: "GRIEVANCE_OUTCOME_TO_RECORD" });
      await casesUnderMetadata(s, ["employee", "committeeSecretary", "committee", "legal", "investigatorA"]);
    });
  });
});

// ---- Restricted Case Authority approvals ---------------------------------------------------------------------------

describe("My Work: the Restricted Case Authority's approvals reach the case owner as its authority only", () => {
  it("an export's consent, never on the authority's own request (CDF-208), beside the stage approvals", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${caseExec}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      const submitted = async (by: UserKey) => {
        await s.as(by);
        const r = (
          await one(
            s.tx<{ id: string }[]>`
              select api.create_export_request(${caseExec}, 'PDF', 'INTERNAL', 'REGULATORY_OR_EXTERNAL_AUTHORITY',
                null, null) as id`,
          )
        ).id;
        await s.tx`select api.add_export_item(${r}, 'CASE_SUMMARY', ${caseExec})`;
        const { h } = await one(s.tx<{ h: string }[]>`select api.preview_export(${r}) ->> 'hash' as h`);
        await s.tx`select api.submit_export(${r}, ${h}, 'SECRET'::core.classification_level)`;
        return { r, h };
      };
      const byDeputy = await submitted("grcDeputy");
      const consent = (x: { r: string; h: string }) => () => (tx: Tx) =>
        tx`select api.decide_restricted_export(${x.r}, 'APPROVE', ${REASON}, ${x.h})`;
      const stage = (x: { r: string; h: string }) => () => (tx: Tx) =>
        tx`select api.decide_export(${x.r}, 'APPROVE', ${REASON}, ${x.h})`;
      expect(await agrees(s, "RESTRICTED_APPROVAL", byDeputy.r, consent(byDeputy))).toEqual(["grcDirector"]);
      expect(await rowsOf(s, "grcDirector", byDeputy.r, "RESTRICTED_APPROVAL")).toEqual([
        expect.objectContaining({ area: "CASES", target_type: "EXPORT", code: "EXPORT", case_id: caseExec }),
      ]);
      expect(await agrees(s, "EXPORT_TO_APPROVE", byDeputy.r, stage(byDeputy))).toEqual(["grcDirector"]);
      // Consent given once: the consent is no longer work; the stage still is.
      await s.as("grcDirector");
      await s.tx`select api.decide_restricted_export(${byDeputy.r}, 'APPROVE', ${REASON}, ${byDeputy.h})`;
      expect(await agrees(s, "RESTRICTED_APPROVAL", byDeputy.r, consent(byDeputy))).toEqual([]);

      // CDF-208: the authority's own request waits for no consent of theirs; the deputy approves the stage.
      const byDirector = await submitted("grcDirector");
      expect(await agrees(s, "RESTRICTED_APPROVAL", byDirector.r, consent(byDirector))).toEqual([]);
      expect(await agrees(s, "EXPORT_TO_APPROVE", byDirector.r, stage(byDirector))).toEqual(["grcDeputy"]);
    });
  });

  it("a restricted case's legal review approval, naming an eligible reviewer (DEC-F20)", async () => {
    await ownerScenario(async (s) => {
      // Fixture as recommendations-authority.spec (W2): the secretary and the reviewer cleared for the SECRET case.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET'
                 where id in (${USERS.committeeSecretary}, ${USERS.legalB})`;
      await seat(s, ic, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["grcDeputy", "MEMBER"],
      ]);
      await preliminaryReferral(s, caseExec);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`;
      const cp = (
        await one(
          s.tx<
            { id: string }[]
          >`select api.refer_case_to_committee(${caseExec}, ${ic}, null, ${REASON}) as id`,
        )
      ).id;
      await s.as("committeeSecretary");
      const m = (
        await one(
          s.tx<{ id: string }[]>`
            select api.schedule_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
              now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`,
        )
      ).id;
      const p = (
        await one(
          s.tx<{ id: string }[]>`
            select id from committee.meeting_participant where meeting_id = ${m} and user_id = ${USERS.grcDeputy}`,
        )
      ).id;
      await s.as("grcDeputy");
      await s.tx`select api.declare_meeting_conflict(${p}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${m}, ${REASON})`;
      await s.tx`select api.record_attendance(${p}, 'PRESENT')`;
      const pkg = (
        await one(s.tx<{ id: string }[]>`select api.create_recommendation_package(${cp}, 'PACKAGE') as id`)
      ).id;
      await s.tx`select api.add_recommendation_item(${pkg}, 'CORRECTIVE_ACTION', null, null,
                   'Synthetic: tighten the approval controls.', null, null)`;
      await s.tx`select api.submit_package_for_vote(${pkg})`;
      await s.tx`select api.open_package_vote(${m}, ${pkg})`;
      const vi = (
        await one(s.tx<{ id: string }[]>`select id from committee.vote_item where package_id = ${pkg}`)
      ).id;
      await s.as("grcDeputy");
      await s.tx`select api.cast_vote(${vi}, 'APPROVE', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi}, null)`;
      await s.tx`select api.record_package_adoption(${pkg})`;
      await s.asOwner();
      const [{ required }] = (await s.tx`select decision.legal_review_required(${pkg}) as required`) as [
        { required: boolean },
      ];
      const approve = () => (tx: Tx) =>
        tx`select api.approve_restricted_legal_review(${pkg}, ${USERS.legalB}, ${REASON})`;
      // Work only where the package's rules require the review; the command is checked either way.
      const holders = await agrees(s, "RESTRICTED_APPROVAL", pkg, approve, required);
      expect(holders).toEqual(required ? ["grcDirector"] : []);
      if (required)
        expect(await rowsOf(s, "grcDirector", pkg)).toEqual([
          expect.objectContaining({ target_type: "RECOMMENDATION_PACKAGE", code: "LEGAL_REVIEW" }),
        ]);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_legal_review(${pkg}, ${USERS.legalB}, ${REASON})`;
      expect(await rowsOf(s, "grcDirector", pkg, "RESTRICTED_APPROVAL")).toEqual([]);
    });
  });

  it("a grievance no current secretary may handle, while one could be named (G2b)", async () => {
    await scenario(async (s) => {
      await seat(s, gc, [
        ["committee", "CHAIR"],
        ["grcDeputy", "SECRETARY"],
        ["legal", "MEMBER"],
      ]);
      await s.as("grcDirector");
      const subject = (
        await one(
          s.tx<{ id: string }[]>`
            select api.add_case_subject(${caseExec}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`,
        )
      ).id;
      const link = (
        await one(
          s.tx<
            { id: string }[]
          >`select api.link_subject_portal_account(${subject}, ${USERS.employee}, ${REASON}) as id`,
        )
      ).id;
      await s.as("employee");
      const g = (
        await one(
          s.tx<{ id: string }[]>`select api.file_grievance(${link}, now(), ${GRIEVANCE_GROUNDS}) as id`,
        )
      ).id;
      const approve = () => (tx: Tx) =>
        tx`select api.approve_restricted_grievance_handling(${g}, ${USERS.grcDeputy}, ${REASON})`;
      expect(await agrees(s, "RESTRICTED_APPROVAL", g, approve)).toEqual(["grcDirector"]);
      expect(await rowsOf(s, "grcDirector", g, "RESTRICTED_APPROVAL")).toEqual([
        expect.objectContaining({ target_type: "GRIEVANCE", code: "GRIEVANCE_HANDLING", area: "CASES" }),
      ]);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_grievance_handling(${g}, ${USERS.grcDeputy}, ${REASON})`;
      expect(await agrees(s, "RESTRICTED_APPROVAL", g, approve)).toEqual([]);
      // The named secretary now handles it, as committee work.
      expect(await rowsOf(s, "grcDeputy", g)).toEqual([
        expect.objectContaining({ category: "GRIEVANCE_RECEIVED", area: "COMMITTEE" }),
      ]);
    });
  });
});

// ---- Exports, corrective actions and continuity imports ------------------------------------------------------------

describe("My Work: exports, corrective actions and continuity imports", () => {
  it("an export stage reaches exactly the eligible approvers, never the requester or an earlier approver (DEC-F24)", async () => {
    await scenario(async (s) => {
      // An external e-mail export of a CONFIDENTIAL case: two stages (EXTERNAL_CONFIDENTIAL, as export.spec) and no
      // Restricted Case Authority consent before them.
      await s.as("lead");
      const r = (
        await one(
          s.tx<{ id: string }[]>`
            select api.create_export_request(${caseA}, 'EMAIL', 'EXTERNAL', 'REGULATORY_OR_EXTERNAL_AUTHORITY',
              'Regulator Alpha (synthetic)', 'Synthetic: the regulator asked for the case summary in writing.') as id`,
        )
      ).id;
      await s.tx`select api.add_export_item(${r}, 'CASE_SUMMARY', ${caseA})`;
      await s.tx`select api.add_export_recipient(${r}, 'EXTERNAL', null, 'officer.alpha@example.test')`;
      const { h } = await one(s.tx<{ h: string }[]>`select api.preview_export(${r}) ->> 'hash' as h`);
      const decide = () => (tx: Tx) => tx`select api.decide_export(${r}, 'APPROVE', ${REASON}, ${h})`;
      expect(await agrees(s, "EXPORT_TO_APPROVE", r, decide)).toEqual([]); // a draft
      await s.as("lead");
      await s.tx`select api.submit_export(${r}, ${h}, 'CONFIDENTIAL'::core.classification_level)`;
      expect(await agrees(s, "EXPORT_TO_APPROVE", r, decide)).toEqual([
        "caseManager",
        "grcDirector",
        "grcDeputy",
      ]);
      expect(await rowsOf(s, "grcDirector", r)).toEqual([
        expect.objectContaining({ area: "CASES", target_type: "EXPORT", case_id: caseA, due_at: null }),
      ]);
      await s.as("grcDirector");
      await s.tx`select api.decide_export(${r}, 'APPROVE', ${REASON}, ${h})`;
      // The second stage: its own permission (EXPORT_SECOND_APPROVE), never the first approver.
      expect(await agrees(s, "EXPORT_TO_APPROVE", r, decide)).toEqual(["grcDeputy"]);
      await s.as("grcDeputy");
      await s.tx`select api.decide_export(${r}, 'APPROVE', ${REASON}, ${h})`;
      expect(await agrees(s, "EXPORT_TO_APPROVE", r, decide)).toEqual([]);
    });
  });

  it("a corrective action: its owner acts, a manager who is neither owner nor submitter verifies, a return comes back", async () => {
    await scenario(async (s) => {
      await s.as("platformAdmin");
      await s.tx`select api.grant_role(${USERS.financeEmployee}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner for the test')`;
      const f = await draftPackage(s, ic, caseB);
      await s.as("committeeSecretary");
      await s.tx`select api.withdraw_recommendation_item(${f.sanction}, ${REASON})`;
      await voteOnPackage(s, f);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await s.tx`select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now(),
        'Chief Executive (synthetic)', 'MEMO-DEMO-2045', null, null)`;
      await s.as("caseManager");
      const a = (
        await one(
          s.tx<{ id: string; due: string }[]>`
            select api.open_corrective_action(${f.corrective}, 'Synthetic: strengthen controls',
              'Synthetic: add a second approver.', ${USERS.financeEmployee}, current_date + 30) as id`,
        )
      ).id;
      const progress = () => (tx: Tx) =>
        tx`select api.record_corrective_action_progress(${a}, 10, 'Synthetic: progress note.')`;
      expect(await agrees(s, "ACTION_ASSIGNED", a, progress)).toEqual(["financeEmployee"]);
      // The owner outside the case team: the card, never the case (R2).
      const [card] = await rowsOf(s, "financeEmployee", a);
      expect(card).toMatchObject({
        area: "MY_WORK",
        target_type: "CORRECTIVE_ACTION",
        case_id: null,
        case_number: null,
        due_source: "ACTION",
        code: "CORRECTIVE_ACTION",
      });
      expect(card!.due_at).not.toBeNull();

      await s.as("financeEmployee");
      await s.tx`select api.submit_corrective_action_completion(${a}, 'Synthetic: the control is in place.', 'SOP-DEMO-2045')`;
      const verify = () => (tx: Tx) => tx`select api.verify_corrective_action(${a}, 'VERIFIED', null)`;
      expect(await agrees(s, "ACTION_TO_VERIFY", a, verify)).toEqual([
        "caseManager",
        "grcDirector",
        "grcDeputy",
      ]);
      expect(await rowsOf(s, "financeEmployee", a)).toEqual([]);
      await s.as("caseManager");
      await s.tx`select api.verify_corrective_action(${a}, 'RETURNED', 'Synthetic: attach the revised SOP.')`;
      expect(await agrees(s, "ACTION_RETURNED", a, progress)).toEqual(["financeEmployee"]);
      expect(await agrees(s, "ACTION_ASSIGNED", a, progress, false)).toEqual([]);
      // Nothing is frozen here: no disposition is anyone's work (recommendations-authority.spec covers a frozen one).
      expect(await agrees(s, "ACTION_TO_DISPOSE", a, () => (tx) => tx`select 1`, false)).toEqual([]);
      await casesUnderMetadata(s, ["financeEmployee", "caseManager", "grcDirector", "employee"]);
    });
  });

  it("a continuity import is decided by an approver who neither imported, prepared nor recorded it", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const b = (
        await one(
          s.tx<{ id: string }[]>`
            with c as (
              select id, case_number, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
              from case_mgmt.case_record where id = ${caseB}
            )
            select api.stage_bcp_import(
              jsonb_build_object('TEMPLATE_VERSION', 'BCP-1', 'WORKBOOK_ID', 'BCP-DEMO-2045', 'CASE_ID', c.id::text,
                                 'CASE_NUMBER', c.case_number, 'OFFLINE_FROM', c.at,
                                 'PREPARED_BY', 'investigator.b@example.test'),
              ${SHA},
              jsonb_build_array(jsonb_build_object('sheet', '05_SUBJECTS', 'row_number', 3, 'has_formula', false, 'cells',
                jsonb_build_object('ROW_ID', 'BCP-MW1', 'ORIGINAL_EVENT_AT', c.at,
                                   'RECORDED_OFFLINE_BY', 'investigator.b@example.test',
                                   'DISPLAY_LABEL', 'Employee Upsilon (synthetic)', 'SUBJECT_CATEGORY', 'EMPLOYEE')))) as id
            from c`,
        )
      ).id;
      const { h } = await one(s.tx<{ h: string }[]>`select api.preview_bcp_import(${b}) ->> 'hash' as h`);
      const decide = () => (tx: Tx) => tx`select api.decide_bcp_import(${b}, 'APPROVE', ${REASON}, ${h})`;
      expect(await agrees(s, "IMPORT_TO_APPROVE", b, decide)).toEqual([]); // staged
      await s.as("caseManager");
      await s.tx`select api.submit_bcp_import(${b}, ${h})`;
      expect(await agrees(s, "IMPORT_TO_APPROVE", b, decide)).toEqual(["grcDirector", "grcDeputy"]);
      expect(await rowsOf(s, "grcDirector", b)).toEqual([
        expect.objectContaining({ area: "CASES", target_type: "BCP_IMPORT", case_id: caseB }),
      ]);
    });
  });
});

// ---- The referral preview ------------------------------------------------------------------------------------------

const preview = (tx: Tx, caseIdValue: string | null, committee: string | null) =>
  tx<
    { p: Record<string, unknown> }[]
  >`select api.committee_referral_preview(${caseIdValue}::uuid, ${committee}::uuid) as p`;

/** The referral command's own refusals before it reads the committee (case_mgmt.lock_editable_case, the committee). */
const GATE = ["CDF_NOT_FOUND", "CDF_FORBIDDEN", "CDF_CONFLICT:CASE_NOT_ACTIVE", "CDF_INVALID:committee_id"];

describe("api.committee_referral_preview: what a referral would copy, as counts (DEC-F19; coordinator ruling 2026-10-14)", () => {
  it("(1) behind the referral command's own checks: each user's answer is the command's, until the command reads the committee", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const answers: Record<string, string> = {};
      for (const target of [caseA, caseB, caseExec]) {
        for (const user of ALL) {
          await s.as(user);
          const p = await attempt(s, (tx) => preview(tx, target, ic));
          const c = await attempt(
            s,
            (tx) => tx`select api.refer_case_to_committee(${target}, ${ic}, null, ${REASON})`,
          );
          if (p === "OK") expect(GATE, `${user} on ${target}: ${c}`).not.toContain(c);
          else expect(c, `${user} on ${target}`).toBe(p);
          if (target === caseB) answers[user] = p;
        }
      }
      // On case B only its editor may refer; the people who see it without editing it are refused as FORBIDDEN.
      expect(
        Object.entries(answers)
          .filter(([, a]) => a === "OK")
          .map(([u]) => u),
      ).toEqual(["caseManager"]);
      expect(
        Object.entries(answers)
          .filter(([, a]) => a === "CDF_FORBIDDEN")
          .map(([u]) => u)
          .sort(),
      ).toEqual(["grcDeputy", "grcDirector", "investigatorB", "triage"]);
    });
  });

  it("(2) an outsider, a team member who may not edit, an unknown case, an inactive committee and a case that is not active are refused", async () => {
    await ownerScenario(async (s) => {
      // Non-team actors: as for a case that does not exist.
      for (const u of ["investigatorA", "committee", "platformAdmin", "internalAudit", "employee"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => preview(tx, caseB, ic));
      }
      await s.as("caseManager");
      await s.expectError("CDF_NOT_FOUND", (tx) => preview(tx, caseExec, ic)); // over their clearance, restricted
      for (const unknown of [randomUUID(), null])
        await s.expectError("CDF_NOT_FOUND", (tx) => preview(tx, unknown, ic));
      // Unauthorised: they see the case, and may not refer it.
      for (const u of ["investigatorB", "grcDirector", "triage"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", (tx) => preview(tx, caseB, ic));
      }
      await s.as("caseManager");
      await s.expectError("CDF_INVALID:committee_id", (tx) => preview(tx, caseB, randomUUID()));
      await s.expectError("CDF_INVALID:committee_id", (tx) => preview(tx, caseB, null));
      await s.asOwner();
      await s.tx`update committee.committee set is_active = false where id = ${gc}`;
      await s.as("caseManager");
      await s.expectError("CDF_INVALID:committee_id", (tx) => preview(tx, caseB, gc));
      await closeAndArchive(s, caseB);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:CASE_NOT_ACTIVE", (tx) => preview(tx, caseB, ic));
      await s.as(null);
      await s.expectError("permission denied", (tx) => preview(tx, caseA, ic));
    });
  });

  it("(3) counts per seat and four totals only: no id, name or per-seat flag; they match what the referral copies", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, [...IC_SEATS, ["investigatorB", "ALTERNATE_MEMBER"]]);
      // legalB has a declared conflict on the case (fixture as committee-access.spec): still seated, not cleared, and
      // copied as excluded. investigatorB, case B's investigator, sits as an alternate: since migration 2080 (AMB-053)
      // a seat that judges is not cleared for a case its holder investigated, so is copied as excluded too.
      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseB}, ${USERS.legalB}, 'CONFLICT_DECLARED', 'Synthetic conflict')`;
      await s.as("caseManager");
      const { p } = await one(preview(s.tx, caseB, ic));
      expect(p).toEqual({
        seats: [
          { seat: "CHAIR", count: 1 },
          { seat: "SECRETARY", count: 1 },
          { seat: "MEMBER", count: 3 },
          { seat: "ALTERNATE_MEMBER", count: 1 },
        ],
        voting: 3,
        cleared: 4,
        not_cleared: 2,
        firewall_restricted: 0,
      });
      // AGENT-09 (3): the result and each seat element have exactly these keys; nothing per seat but its count.
      expect(Object.keys(p).sort()).toEqual([
        "cleared",
        "firewall_restricted",
        "not_cleared",
        "seats",
        "voting",
      ]);
      for (const e of p.seats as Record<string, unknown>[])
        expect(Object.keys(e).sort()).toEqual(["count", "seat"]);
      const text = JSON.stringify(p);
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      await s.asOwner();
      for (const n of await s.tx<{ display_name: string; email: string }[]>`
        select display_name, email from iam.user_profile`) {
        expect(text).not.toContain(n.display_name);
        expect(text).not.toContain(n.email);
      }

      // The referral copies exactly that: its snapshot and its audit totals.
      await preliminaryReferral(s, caseB);
      await s.as("caseManager");
      const cp = (
        await one(
          s.tx<{ id: string }[]>`select api.refer_case_to_committee(${caseB}, ${ic}, null, ${REASON}) as id`,
        )
      ).id;
      await s.asOwner();
      const seats = await s.tx<{ seat: string; count: number }[]>`
        select seat, count(*)::int as count from committee.proceeding_member where committee_proceeding_id = ${cp}
        group by seat order by array_position(array['CHAIR', 'DEPUTY_CHAIR', 'SECRETARY', 'ALTERNATE_SECRETARY',
          'MEMBER', 'ALTERNATE_MEMBER'], seat)`;
      expect(seats).toEqual(p.seats);
      const [{ m }] = (await s.tx`
        select metadata as m from audit.audit_event
        where action = 'COMMITTEE_PROCEEDING_OPENED' and object_id = ${cp}::text`) as [
        { m: Record<string, unknown> },
      ];
      expect([m.voting_members, m.firewall_restricted_members, m.case_gate_excluded_members]).toEqual([
        p.voting,
        p.firewall_restricted,
        p.not_cleared,
      ]);
    });
  });

  it("a grievance referral counts the members who sat on the case's Investigation Committee as firewall restricted", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      await refer(s, ic, caseB);
      // legal and lead voted on the IC proceeding of case B; both now also hold Grievance Committee seats.
      await s.as("platformAdmin");
      for (const [u, seatCode] of [
        ["committee", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["legal", "MEMBER"],
        ["lead", "MEMBER"],
        ["investigatorA", "MEMBER"],
      ] as const)
        await s.tx`select api.appoint_committee_member(${gc}, ${USERS[u]}, ${seatCode}, now() - interval '1 day', null, 'DEMO-APPT')`;
      await s.as("caseManager");
      const { p } = await one(preview(s.tx, caseB, gc));
      expect(p).toEqual({
        seats: [
          { seat: "CHAIR", count: 1 },
          { seat: "SECRETARY", count: 1 },
          { seat: "MEMBER", count: 3 },
        ],
        voting: 2,
        cleared: 5,
        not_cleared: 0,
        firewall_restricted: 2,
      });
    });
  });
});

// ---- Case history: the 1870 events ---------------------------------------------------------------------------------

interface HistoryRow {
  seq: string;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  subject_name: string | null;
  reason: string | null;
  detail: unknown;
}
const EVENTS_1870 = [
  "PROCEEDING_OPENED",
  "PROCEEDING_STATE_CHANGED",
  "PROCEEDING_CLOSED",
  "COMMITTEE_PROCEEDING_OPENED",
  "CASE_SUBJECT_ADDED",
  "ALLEGATION_ADDED",
  "ALLEGATION_SUBJECT_LINKED",
  "FINDING_RECORDED",
  "EVIDENCE_LINKED",
  "RESTRICTED_COMMITTEE_REFERRAL_APPROVED",
];
/**
 * The 1870 events of a case's history that the user reads. With `mark`, only the events the test made after it: on a
 * database that keeps records from run to run (hosted DEV, CDF-32 §4.10) a case's older events can be anyone's.
 */
async function eventsOf(s: Scenario, user: UserKey, target: string, mark?: bigint): Promise<HistoryRow[]> {
  await s.as(user);
  const rows = (await s.tx<HistoryRow[]>`select * from api.case_history(${target}, 500)`).filter((r) =>
    EVENTS_1870.includes(r.action),
  );
  return mark === undefined ? rows : madeSince(rows, mark);
}
const actionsOf = async (s: Scenario, user: UserKey, target: string, mark: bigint) =>
  [...new Set((await eventsOf(s, user, target, mark)).map((r) => r.action))].sort();

describe("case history: the 1870 events, as codes and times, to whoever may read each object (coordinator, 13:24 and 13:25)", () => {
  it("proceedings, people, allegations and findings: the case's readers, findings only with a case-file basis", async () => {
    await scenario(async (s) => {
      const mark = await ledgerMark();
      const facts = await caseFacts(s, caseB);
      await s.as("caseManager");
      const other = (
        await one(
          s.tx<{ id: string }[]>`
            select api.add_case_subject(${caseB}, 'Employee Omega (synthetic)', 'EMPLOYEE', null) as id`,
        )
      ).id;
      // An allegation recorded without a subject, linked to one afterwards (an allegation has one subject).
      const later = (
        await one(
          s.tx<{ id: string }[]>`
            select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: an allegation whose subject is linked later.',
              null, null, null) as id`,
        )
      ).id;
      await s.tx`select api.link_allegation_subject(${later}, ${other}, null, null)`;
      await s.tx`select api.update_proceeding_state(${facts.proceeding}, 'IN_PROGRESS', 'DOCUMENTS', null, ${REASON})`;
      await s.tx`select api.close_proceeding(${facts.proceeding}, 'CANCELLED', null, ${REASON})`;
      const structure = [
        "ALLEGATION_ADDED",
        "ALLEGATION_SUBJECT_LINKED",
        "CASE_SUBJECT_ADDED",
        "PROCEEDING_CLOSED",
        "PROCEEDING_OPENED",
        "PROCEEDING_STATE_CHANGED",
      ];
      for (const u of ["caseManager", "investigatorB", "grcDirector", "grcDeputy"] as const)
        expect(await actionsOf(s, u, caseB, mark), u).toEqual([...structure, "FINDING_RECORDED"].sort());
      // A TRIAGE grantee before hand-over reads the case and its structure, never its findings (2020).
      expect(await actionsOf(s, "triage", caseB, mark)).toEqual(structure);
      // Codes and times only: no actor, reason, person or detail, on any of these events in the case's history.
      for (const r of await eventsOf(s, "caseManager", caseB))
        expect(r, r.action).toMatchObject({
          actor_id: null,
          actor_name: null,
          subject_name: null,
          reason: null,
          detail: null,
        });
      for (const u of ["investigatorA", "committee", "platformAdmin", "internalAudit"] as const)
        expect(await eventsOf(s, u, caseB), u).toEqual([]);
    });
  });

  it("a committee referral: its proceeding events to the case's readers, the restricted approval to the case's authority only", async () => {
    await ownerScenario(async (s) => {
      const mark = await ledgerMark();
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET' where id = ${USERS.committeeSecretary}`;
      await seat(s, ic, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["grcDeputy", "MEMBER"],
      ]);
      await preliminaryReferral(s, caseExec);
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${caseExec}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      await s.tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`;
      await s.tx`select api.refer_case_to_committee(${caseExec}, ${ic}, null, ${REASON})`;
      const referral = ["COMMITTEE_PROCEEDING_OPENED", "PROCEEDING_OPENED"];
      expect(await actionsOf(s, "grcDirector", caseExec, mark)).toEqual(
        [...referral, "PROCEEDING_CLOSED", "RESTRICTED_COMMITTEE_REFERRAL_APPROVED"].sort(),
      );
      // A CASE grant reads the case and the referral, never the authority's approval.
      expect(await actionsOf(s, "grcDeputy", caseExec, mark)).toEqual(
        [...referral, "PROCEEDING_CLOSED"].sort(),
      );
      // The committee's secretary reads the proceeding, not the case history.
      expect(await eventsOf(s, "committeeSecretary", caseExec)).toEqual([]);
      for (const r of await eventsOf(s, "grcDirector", caseExec))
        expect(r, r.action).toMatchObject({ actor_id: null, reason: null, detail: null });
    });
  });

  it("an evidence link, only to whoever may see the linked item (DEC-09)", async () => {
    await scenario(async (s) => {
      const mark = await ledgerMark();
      await s.as("caseManager");
      await s.tx`select api.open_proceeding(${caseA}, 'INVESTIGATION', null, ${REASON})`;
      const subject = (
        await one(
          s.tx<{ id: string }[]>`
            select api.add_case_subject(${caseA}, 'Employee Kappa (synthetic)', 'EMPLOYEE', null) as id`,
        )
      ).id;
      const allegation = (
        await one(
          s.tx<{ id: string }[]>`
            select api.add_allegation(${caseA}, 'FRAUD', 'Synthetic: allegation against Employee Kappa.', ${subject},
              null, null) as id`,
        )
      ).id;
      const evidence = (
        await one(
          s.tx<
            { id: string }[]
          >`select id from evidence.evidence where case_id = ${caseA} order by sequence_no limit 1`,
        )
      ).id;
      await s.as("lead");
      await s.tx`select api.set_evidence_restriction(${evidence}, 'LEADS', ${REASON})`;
      await s.tx`select api.link_supporting_material(${evidence}, ${allegation}, null)`;
      const linked = async (u: UserKey) => (await actionsOf(s, u, caseA, mark)).includes("EVIDENCE_LINKED");
      expect(await linked("lead")).toBe(true);
      expect(await linked("caseManager")).toBe(true);
      // The investigator is on the team and does not see a LEADS item, nor its link.
      expect(await linked("investigatorA")).toBe(false);
      expect(await actionsOf(s, "investigatorA", caseA, mark)).toContain("ALLEGATION_ADDED");
    });
  });
});
