// Business architecture rebase, migration 2030 (ADR-040): the owner's Finalization Set (DEC-F01 to DEC-F07) and the
// ambiguity rows it settles for committee meetings. The business calendar (DEC-F02, AMB-055); the acting chair and the
// casting vote (DEC-F03, AMB-040/044); the acting secretary (CON-007, AMB-042/050/066); alternate members
// (AMB-041/088); the snapshot amendment (AMB-038); seat end (AMB-039); the conflict decider cascade with an
// independent authority (DEC-F04, CON-006); abstentions and recusal (DEC-F01, AMB-043/077); vote revision, notes and
// secret ballots (AMB-081/082/083); objections to minutes (AMB-092); minimum notice (AMB-061); interpreters,
// confidentiality acknowledgements and accommodations (AMB-156/157/158); the cancellation notice of an excluded witness
// (DEC-F07). Every step runs through the api.* commands as `authenticated`; the owner connection is used only to read
// tables no role may read, for an outdated review window, and for a clearance fixture.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  USERS,
  caseId,
  ownerScenario,
  scenario,
  type OwnerScenario,
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
  vote,
  type MeetingFixture,
} from "../support/committee";

const ACT = "Synthetic: the seat holder is not available today.";

let caseB: string, ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
});

const VOTERS: UserKey[] = ["committeeChair", "legal", "legalB", "lead"];
/** As IC_SEATS, with lead as deputy chair. */
const DEPUTY_SEATS: [UserKey, string][] = IC_SEATS.map(([u, s]) => [u, u === "lead" ? "DEPUTY_CHAIR" : s]);

/** Changes the committee's rule set from now, before the referral snapshots it. */
async function rule(s: Scenario, changes: Record<string, unknown>): Promise<void> {
  await s.as("platformAdmin");
  await s.tx`select api.revise_committee_rule_set(${ic}, now(), ${s.tx.json(changes as never)}, 'SOURCE_REQUIRED', ${REASON})`;
}

async function ready(
  s: Scenario,
  present: UserKey[] = VOTERS,
  seats: [UserKey, string][] = IC_SEATS,
): Promise<MeetingFixture> {
  await seat(s, ic, seats);
  const f = await scheduleMeeting(s, ic, caseB);
  await openWithPresent(s, f, present);
  return f;
}

async function close(s: Scenario, item: string, as: UserKey = "committeeSecretary"): Promise<string> {
  await s.as(as);
  const [r] = await s.tx<{ r: string }[]>`select api.close_vote_item(${item}, null) as r`;
  return r!.r;
}

async function status(s: Scenario, user: UserKey, item: string) {
  await s.as(user);
  const [r] = await s.tx<{ v: StatusView }[]>`select api.vote_item_status(${item}) as v`;
  return r!.v;
}

interface StatusView {
  status: string;
  result: string | null;
  ballot_secrecy: string;
  voters: { user_id: string; choice: string | null; activated_alternate: boolean; replaced: boolean }[];
  notes: { participant_id: string | null; note: string }[] | null;
  tally: { eligible: number; present: number; approve: number; reject: number; abstain: number } | null;
}

async function auditMetadata(s: OwnerScenario, action: string) {
  await s.asOwner();
  return s.tx<{ actor_id: string; metadata: Record<string, unknown>; reason: string | null }[]>`
    select actor_id, metadata, reason from audit.audit_event where action = ${action} order by seq`;
}

describe("the business calendar (DEC-F02, AMB-055, migration 2030)", () => {
  it("holidays move due dates; only the calendar admin records them, never for a past day", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const [before] = await s.tx<{ d1: string; due: Date }[]>`
        select ((committee.add_business_days(now(), 1) at time zone 'Asia/Riyadh')::date)::text as d1,
               committee.add_business_days(now(), 3) as due`;

      for (const u of ["committeeSecretary", "caseManager", "dpo"] as const) {
        await s.as(u);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.set_business_calendar_day(${before!.d1}::date, 'HOLIDAY', null, ${REASON})`,
        );
      }
      await s.as("platformAdmin");
      await s.expectError(
        "CDF_INVALID:calendar_date",
        (tx) =>
          tx`select api.set_business_calendar_day(((now() at time zone 'Asia/Riyadh')::date - 1), 'HOLIDAY', null, ${REASON})`,
      );
      const [day] = await s.tx<{ id: string }[]>`
        select api.set_business_calendar_day(${before!.d1}::date, 'HOLIDAY', 'DEMO-CAL-01', ${REASON}) as id`;
      await s.expectError(
        "CDF_CONFLICT:CALENDAR_DAY_EXISTS",
        (tx) =>
          tx`select api.set_business_calendar_day(${before!.d1}::date, 'NON_WORKING_DAY', null, ${REASON})`,
      );
      // No direct write, even for the calendar admin.
      await s.expectError(
        "permission denied",
        (tx) => tx`update config.business_calendar_day set day_type = 'WORKING_DAY' where id = ${day!.id}`,
      );

      // The holiday is skipped: three business days now end one business day later.
      await s.asOwner();
      const [after] = await s.tx<{ due: Date; open: boolean }[]>`
        select committee.add_business_days(now(), 3) as due, config.is_business_day(${before!.d1}::date) as open`;
      expect(after!.open).toBe(false);
      expect(after!.due.getTime()).toBeGreaterThan(before!.due.getTime());

      // Minutes generated now take their review window from the calendar.
      const f = await ready(s);
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      const [mi] = await s.tx<{ id: string }[]>`
        select api.generate_minutes(${f.meeting}, 'Synthetic minutes for the calendar test.') as id`;
      await s.asOwner();
      const [due] = await s.tx<{ ok: boolean }[]>`
        select review_due_at = committee.add_business_days(now(), review_business_days) as ok
        from committee.minutes where id = ${mi!.id}`;
      expect(due!.ok).toBe(true);

      // Every signed-in user reads the calendar; a withdrawal is once only.
      await s.as("employee");
      expect(await s.tx`select id from config.business_calendar_day where id = ${day!.id}`).toHaveLength(1);
      await s.as("platformAdmin");
      await s.tx`select api.withdraw_business_calendar_day(${day!.id}, ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:CALENDAR_DAY_WITHDRAWN",
        (tx) => tx`select api.withdraw_business_calendar_day(${day!.id}, ${REASON})`,
      );
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.withdraw_business_calendar_day(${randomUUID()}, ${REASON})`,
      );
      await s.asOwner();
      const [back] = await s.tx<
        { open: boolean }[]
      >`select config.is_business_day(${before!.d1}::date) as open`;
      expect(back!.open).toBe(true);

      // The week pattern changes only from a future date, with at least one working day.
      await s.as("platformAdmin");
      await s.expectError(
        "CDF_INVALID:effective_from",
        (tx) =>
          tx`select api.set_business_week_pattern(array[5, 6], now() - interval '1 day', 'SOURCE_REQUIRED', ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:non_working_isodow",
        (tx) =>
          tx`select api.set_business_week_pattern(array[1, 2, 3, 4, 5, 6, 7], now() + interval '1 day', 'SOURCE_REQUIRED', ${REASON})`,
      );
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.set_business_week_pattern(array[5, 6], now() + interval '1 day', 'SOURCE_REQUIRED', ${REASON})`,
      );
    });
  });

  it("a working day recorded on a weekend counts as a business day", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const [fri] = await s.tx<{ d: string }[]>`
        select d::text from generate_series((now() at time zone 'Asia/Riyadh')::date + 1,
                                            (now() at time zone 'Asia/Riyadh')::date + 7, interval '1 day') g(d)
        where extract(isodow from d) = 5`;
      await s.as("platformAdmin");
      await s.tx`select api.set_business_calendar_day(${fri!.d}::date, 'WORKING_DAY', 'DEMO-CAL-02', ${REASON})`;
      await s.asOwner();
      const [r] = await s.tx<{ open: boolean }[]>`select config.is_business_day(${fri!.d}::date) as open`;
      expect(r!.open).toBe(true);
    });
  });
});

describe("acting chair and the casting vote (DEC-F03, AMB-040/044, migration 2030)", () => {
  it("the secretary activates the deputy for an absent chair; the deputy casts only when the rule grants it", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s, ["legal", "legalB", "lead"], DEPUTY_SEATS);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:CHAIR_AVAILABLE",
        (tx) => tx`select api.activate_acting_chair(${f.meeting}, ${ACT})`,
      );
      await s.tx`select api.record_attendance(${f.participant.committeeChair!}, 'ABSENT')`;
      for (const u of ["lead", "legal", "committeeChair", "caseManager"] as const) {
        await s.as(u);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.activate_acting_chair(${f.meeting}, ${ACT})`,
        );
      }
      await s.as("employee");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.activate_acting_chair(${f.meeting}, ${ACT})`,
      );
      await s.as("committeeSecretary");
      await s.tx`select api.activate_acting_chair(${f.meeting}, ${ACT})`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_ACTIVATED",
        (tx) => tx`select api.activate_acting_chair(${f.meeting}, ${ACT})`,
      );
      await s.asOwner();
      expect(
        await s.tx`select acting_role, user_id, basis, activated_as from committee.meeting_acting_role
                   where meeting_id = ${f.meeting}`,
      ).toEqual([
        { acting_role: "ACTING_CHAIR", user_id: USERS.lead, basis: "ABSENT", activated_as: "SECRETARY" },
      ]);

      // A tie: the rule in force does not grant the acting chair the casting vote (DEC-F03 default).
      const item = await openItem(s, f.meeting);
      await vote(s, "legal", item, "APPROVE");
      await vote(s, "legalB", item, "REJECT");
      await vote(s, "lead", item, "ABSTAIN");
      expect(await close(s, item)).toBe("TIED");
      for (const u of ["lead", "committeeSecretary"] as const) {
        await s.as(u);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.cast_casting_vote(${item}, 'APPROVE', null)`,
        );
      }
    });
  });

  it("with the rule granting it the acting chair breaks a tie; a returning chair takes precedence", async () => {
    await ownerScenario(async (s) => {
      await rule(s, { acting_chair_casting_vote: true });
      const f = await ready(s, ["legal", "legalB", "lead"], DEPUTY_SEATS);
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${f.participant.committeeChair!}, 'ABSENT')`;
      await s.tx`select api.activate_acting_chair(${f.meeting}, ${ACT})`;

      const first = await openItem(s, f.meeting, "First tie (synthetic)");
      await vote(s, "legal", first, "APPROVE");
      await vote(s, "legalB", first, "REJECT");
      await vote(s, "lead", first, "ABSTAIN");
      expect(await close(s, first)).toBe("AWAITING_CASTING_VOTE");
      await s.as("lead");
      expect(
        (await s.tx<{ r: string }[]>`select api.cast_casting_vote(${first}, 'APPROVE', null) as r`)[0]!.r,
      ).toBe("APPROVED");
      const cast = await auditMetadata(s, "CASTING_VOTE_CAST");
      expect(cast.map((e) => [e.actor_id, e.metadata.cast_as])).toEqual([[USERS.lead, "ACTING_CHAIR"]]);

      // The chair returns between items and holds the casting vote again.
      await s.as("committeeChair");
      await s.tx`select api.declare_meeting_conflict(${f.participant.committeeChair!}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${f.participant.committeeChair!}, 'PRESENT')`;
      const second = await openItem(s, f.meeting, "Second tie (synthetic)");
      await vote(s, "legal", second, "APPROVE");
      await vote(s, "legalB", second, "REJECT");
      await vote(s, "lead", second, "ABSTAIN");
      await vote(s, "committeeChair", second, "ABSTAIN");
      expect(await close(s, second)).toBe("AWAITING_CASTING_VOTE");
      await s.as("lead");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.cast_casting_vote(${second}, 'APPROVE', null)`,
      );
      await s.as("committeeChair");
      expect(
        (await s.tx<{ r: string }[]>`select api.cast_casting_vote(${second}, 'REJECT', null) as r`)[0]!.r,
      ).toBe("REJECTED");
    });
  });

  it("without a deputy chair in the meeting nobody acts for the chair (fail closed)", async () => {
    await scenario(async (s) => {
      const f = await ready(s, ["legal", "legalB", "lead"]);
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${f.participant.committeeChair!}, 'ABSENT')`;
      await s.expectError(
        "CDF_CONFLICT:NO_ELIGIBLE_DEPUTY",
        (tx) => tx`select api.activate_acting_chair(${f.meeting}, ${ACT})`,
      );
    });
  });
});

describe("acting secretary (CON-007, AMB-042/050/066, migration 2030)", () => {
  it("the alternate secretary runs a meeting only once activated for it", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await s.as("committeeChair");
      await s.tx`select api.declare_meeting_conflict(${f.participant.committeeChair!}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.declare_meeting_conflict(${f.participant.committeeSecretary!}, 'CONFLICT_DECLARED', 'Synthetic: related to a party.')`;
      // The conflicted secretary no longer runs the meeting; there is no alternate yet.
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.open_meeting(${f.meeting}, ${REASON})`);
      await s.as("committeeChair");
      await s.expectError(
        "CDF_CONFLICT:NO_ELIGIBLE_ALTERNATE",
        (tx) => tx`select api.activate_acting_secretary(${f.meeting}, ${ACT})`,
      );

      await seat(s, ic, [["investigatorB", "ALTERNATE_SECRETARY"]]);
      await s.as("investigatorB");
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.open_meeting(${f.meeting}, ${REASON})`);
      for (const u of ["legal", "investigatorB"] as const) {
        await s.as(u);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.activate_acting_secretary(${f.meeting}, ${ACT})`,
        );
      }
      await s.as("committeeChair");
      await s.tx`select api.activate_acting_secretary(${f.meeting}, ${ACT})`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_ACTIVATED",
        (tx) => tx`select api.activate_acting_secretary(${f.meeting}, ${ACT})`,
      );
      const [row] =
        await s.tx`select acting_role, user_id, basis, activated_as from committee.meeting_acting_role
                               where meeting_id = ${f.meeting}`;
      expect(row).toEqual({
        acting_role: "ACTING_SECRETARY",
        user_id: USERS.investigatorB,
        basis: "CONFLICTED",
        activated_as: "CHAIR",
      });
      await s.as("investigatorB");
      await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
      await s.tx`select api.record_attendance(${f.participant.committeeChair!}, 'PRESENT')`;
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.record_attendance(${f.participant.committeeChair!}, 'ABSENT')`,
      );
    });
  });
});

describe("alternate members (AMB-041/088, migration 2030)", () => {
  it("an alternate votes in place of an absent member; the replaced member is not counted or recorded present", async () => {
    await scenario(async (s) => {
      const f = await ready(
        s,
        ["committeeChair", "legal", "lead", "committee"],
        [...IC_SEATS, ["committee", "ALTERNATE_MEMBER"]],
      );
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${f.participant.legalB!}, 'ABSENT')`;
      await s.expectError(
        "CDF_INVALID:replaces_participant_id",
        (tx) =>
          tx`select api.activate_alternate_member(${f.participant.committee!}, ${f.participant.committeeChair!}, ${ACT})`,
      );
      await s.expectError(
        "CDF_INVALID:alternate_participant_id",
        (tx) =>
          tx`select api.activate_alternate_member(${f.participant.lead!}, ${f.participant.legalB!}, ${ACT})`,
      );
      await s.expectError(
        "CDF_CONFLICT:MEMBER_AVAILABLE",
        (tx) =>
          tx`select api.activate_alternate_member(${f.participant.committee!}, ${f.participant.legal!}, ${ACT})`,
      );
      await s.as("legal");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.activate_alternate_member(${f.participant.committee!}, ${f.participant.legalB!}, ${ACT})`,
      );
      await s.as("committeeSecretary");
      await s.tx`select api.activate_alternate_member(${f.participant.committee!}, ${f.participant.legalB!}, ${ACT})`;
      await s.expectError(
        "CDF_CONFLICT:ALTERNATE_ALREADY_ACTIVE",
        (tx) =>
          tx`select api.activate_alternate_member(${f.participant.committee!}, ${f.participant.lead!}, ${ACT})`,
      );

      // The replaced member returns: still not present, and casts nothing.
      await s.as("legalB");
      await s.tx`select api.declare_meeting_conflict(${f.participant.legalB!}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:REPLACED_BY_ALTERNATE",
        (tx) => tx`select api.record_attendance(${f.participant.legalB!}, 'PRESENT')`,
      );
      const item = await openItem(s, f.meeting);
      await s.as("legalB");
      await s.expectError(
        "CDF_CONFLICT:REPLACED_BY_ALTERNATE",
        (tx) => tx`select api.cast_vote(${item}, 'APPROVE', null)`,
      );
      for (const u of ["committeeChair", "legal", "lead", "committee"] as const)
        await vote(s, u, item, "APPROVE");
      expect(await close(s, item)).toBe("APPROVED");
      const v = await status(s, "committeeSecretary", item);
      expect(v.tally).toMatchObject({ eligible: 4, present: 4, approve: 4 });
      expect(v.voters.find((r) => r.user_id === USERS.committee)).toMatchObject({
        activated_alternate: true,
      });
      expect(v.voters.find((r) => r.user_id === USERS.legalB)).toMatchObject({ replaced: true });
    });
  });
});

describe("the proceeding snapshot and seats (AMB-038, AMB-039, migration 2030)", () => {
  it("a member appointed after the referral joins later meetings only by the secretary's recorded amendment", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const cp = await refer(s, ic, caseB);
      await s.as("platformAdmin");
      const [ms] = await s.tx<{ id: string }[]>`
        select api.appoint_committee_member(${ic}, ${USERS.committee}, 'MEMBER', now(), null, 'DEMO-APPT') as id`;
      const [notCleared] = await s.tx<{ id: string }[]>`
        select api.appoint_committee_member(${ic}, ${USERS.internalAudit}, 'MEMBER', now(), null, 'DEMO-APPT') as id`;
      await s.as("committee");
      expect(await s.tx`select id from committee.committee_proceeding where id = ${cp}`).toHaveLength(0);

      const amend = (membership: string) => (tx: Scenario["tx"]) =>
        tx`select api.amend_proceeding_snapshot(${cp}, ${membership}, 'Synthetic: appointed after the referral.')`;
      for (const u of ["legal", "committeeChair", "caseManager"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", amend(ms!.id));
      }
      await s.as("employee");
      await s.expectError("CDF_NOT_FOUND", amend(ms!.id));
      await s.as("committeeSecretary");
      await s.expectError("CDF_INVALID:membership_id", amend(randomUUID()));
      await s.expectError("CDF_CONFLICT:NOT_CLEARED_FOR_CASE", amend(notCleared!.id));
      await amend(ms!.id)(s.tx);
      await s.expectError("CDF_CONFLICT:ALREADY_IN_SNAPSHOT", amend(ms!.id));
      const amended = await auditMetadata(s, "PROCEEDING_SNAPSHOT_AMENDED");
      expect(amended.map((e) => e.metadata.is_voting)).toEqual([true]);

      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      expect(
        await s.tx`select seat, is_voting from committee.meeting_participant
                   where meeting_id = ${m!.id} and user_id = ${USERS.committee}`,
      ).toEqual([{ seat: "MEMBER", is_voting: true }]);
      await s.as("committee");
      expect(await s.tx`select id from committee.committee_proceeding where id = ${cp}`).toHaveLength(1);
    });
  });

  it("an amendment on a restricted case needs its authority's approval, which is not built: refused", async () => {
    await ownerScenario(async (s) => {
      const exec = await caseId("0003");
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET'
                 where id in (${USERS.committeeSecretary}, ${USERS.committeeChair}, ${USERS.legal}, ${USERS.committee})`;
      await seat(s, ic, IC_SEATS);
      await preliminaryReferral(s, exec);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_committee_referral(${exec}, ${ic}, ${REASON})`;
      const [cp] = await s.tx<
        { id: string }[]
      >`select api.refer_case_to_committee(${exec}, ${ic}, null, ${REASON}) as id`;
      await s.as("platformAdmin");
      const [ms] = await s.tx<{ id: string }[]>`
        select api.appoint_committee_member(${ic}, ${USERS.committee}, 'MEMBER', now(), null, 'DEMO-APPT') as id`;
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:AUTHORITY_APPROVAL_REQUIRED",
        (tx) =>
          tx`select api.amend_proceeding_snapshot(${cp!.id}, ${ms!.id}, 'Synthetic: appointed after the referral.')`,
      );
    });
  });

  it("a member whose seat ends loses the proceeding's meetings and votes at once", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s);
      await s.asOwner();
      const [ms] = await s.tx<{ id: string }[]>`
        select id from committee.membership where committee_id = ${ic} and user_id = ${USERS.legalB} and effective_to is null`;
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(${ms!.id}, now(), ${REASON})`;

      const item = await openItem(s, f.meeting);
      await s.as("legalB");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.cast_vote(${item}, 'APPROVE', null)`);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.vote_item_status(${item})`);
      expect(
        await s.tx`select id from committee.committee_proceeding where id = ${f.committeeProceeding}`,
      ).toHaveLength(0);
      for (const u of ["committeeChair", "legal", "lead"] as const) await vote(s, u, item, "APPROVE");
      expect(await close(s, item)).toBe("APPROVED");
      expect((await status(s, "committeeSecretary", item)).tally).toMatchObject({ eligible: 3, present: 3 });

      await s.as("committeeSecretary");
      const [m2] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${f.committeeProceeding}, 'HEARING', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '2 days', now() + interval '2 days 1 hour', ${REASON}) as id`;
      expect(
        await s.tx`select id from committee.meeting_participant where meeting_id = ${m2!.id} and user_id = ${USERS.legalB}`,
      ).toEqual([]);
    });
  });
});

describe("CDF-212: a member whose seat has ended declares nothing (migration 2050)", () => {
  it("a declaration needs a current seat, as a vote and attendance do; the participant row and the ledger stay as they were", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      // A member whose seat is current declares (control).
      await s.as("legal");
      await s.tx`select api.declare_meeting_conflict(${f.participant.legal!}, 'NO_CONFLICT', null)`;
      await s.asOwner();
      const [ms] = await s.tx<{ id: string }[]>`
        select id from committee.membership where committee_id = ${ic} and user_id = ${USERS.legalB} and effective_to is null`;
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(${ms!.id}, now(), ${REASON})`;
      await s.as("legalB");
      await s.expectError(
        "CDF_CONFLICT:SEAT_ENDED",
        (tx) => tx`select api.declare_meeting_conflict(${f.participant.legalB!}, 'NO_CONFLICT', null)`,
      );
      await s.expectError(
        "CDF_CONFLICT:SEAT_ENDED",
        (tx) =>
          tx`select api.declare_meeting_conflict(${f.participant.legalB!}, 'CONFLICT_DECLARED', 'Synthetic: related to a party.')`,
      );
      await s.asOwner();
      expect(
        await s.tx`select coi_status from committee.meeting_participant where id = ${f.participant.legalB!}`,
      ).toEqual([{ coi_status: "PENDING" }]);
      expect(
        await s.tx`select id from committee.meeting_conflict where participant_id = ${f.participant.legalB!}`,
      ).toEqual([]);
      expect(
        await s.tx`select seq from audit.audit_event where action = 'COI_DECLARED' and object_id = ${f.participant.legalB!}`,
      ).toEqual([]);
    });
  });
});

describe("raised conflicts: the decider cascade (DEC-F04, CON-006, migration 2030)", () => {
  const raise = (s: Scenario, participant: string) =>
    s.tx<
      { id: string }[]
    >`select api.raise_meeting_conflict(${participant}, 'Synthetic: a concern about the chair.') as id`;
  const decide = (tx: Scenario["tx"], concern: string) =>
    tx`select api.decide_meeting_conflict(${concern}, 'UPHELD', 'Synthetic: the link is direct.')`;

  it("when neither the chair nor the deputy can decide, the committee's independent authority does", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s, ["committeeChair", "legal", "legalB"], DEPUTY_SEATS);
      await s.as("lead");
      await s.tx`select api.declare_meeting_conflict(${f.participant.lead!}, 'CONFLICT_DECLARED', 'Synthetic: related.')`;
      await s.as("legal");
      const [k] = await raise(s, f.participant.committeeChair!);
      // No authority yet: nobody decides and no vote opens (fail closed).
      for (const u of ["committeeChair", "lead", "legalB", "complianceManager"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => decide(tx, k!.id));
      }
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:CONFLICT_CONCERN_OPEN",
        (tx) => tx`select api.open_vote_item(${f.meeting}, 'OTHER', null, 'Blocked (synthetic)')`,
      );

      const appoint = (user: string) => (tx: Scenario["tx"]) =>
        tx`select api.appoint_conflict_authority(${ic}, ${user}, now(), null, 'DEMO-CA-01', 'SOURCE_REQUIRED', ${REASON})`;
      await s.as("committeeSecretary");
      await s.expectError("CDF_FORBIDDEN", appoint(USERS.complianceManager));
      await s.as("platformAdmin");
      await s.expectError("CDF_CONFLICT:SELF_APPOINTMENT", appoint(USERS.platformAdmin));
      await s.expectError("CDF_CONFLICT:AUTHORITY_NOT_INDEPENDENT", appoint(USERS.legal));
      await appoint(USERS.complianceManager)(s.tx);
      await s.expectError("CDF_CONFLICT:AUTHORITY_OVERLAP", appoint(USERS.grcDirector));

      await s.as("complianceManager");
      expect(await s.tx`select id from committee.meeting_conflict_concern`).toEqual([{ id: k!.id }]);
      await decide(s.tx, k!.id);
      await s.asOwner();
      expect(
        await s.tx`select decided_as, decided_by from committee.meeting_conflict_concern where id = ${k!.id}`,
      ).toEqual([{ decided_as: "CONFLICT_AUTHORITY", decided_by: USERS.complianceManager }]);
      // The authority sees nothing else of the meeting.
      await s.as("complianceManager");
      expect(await s.tx`select id from committee.vote_item where meeting_id = ${f.meeting}`).toEqual([]);
    });
  });

  it("an authority not cleared for the case, or no longer in force, does not decide", async () => {
    await scenario(async (s) => {
      const f = await ready(s, ["committeeChair", "legal", "legalB"], DEPUTY_SEATS);
      await s.as("lead");
      await s.tx`select api.declare_meeting_conflict(${f.participant.lead!}, 'CONFLICT_DECLARED', 'Synthetic: related.')`;
      await s.as("platformAdmin");
      const [a] = await s.tx<{ id: string }[]>`
        select api.appoint_conflict_authority(${ic}, ${USERS.internalAudit}, now(), null, 'DEMO-CA-02', 'SOURCE_REQUIRED', ${REASON}) as id`;
      await s.as("legal");
      const [k] = await raise(s, f.participant.committeeChair!);
      await s.as("internalAudit");
      await s.expectError("CDF_NOT_FOUND", (tx) => decide(tx, k!.id));
      await s.as("platformAdmin");
      await s.tx`select api.end_conflict_authority(${a!.id}, now() + interval '1 minute', ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:AUTHORITY_ENDED",
        (tx) => tx`select api.end_conflict_authority(${a!.id}, now() + interval '1 minute', ${REASON})`,
      );
    });
  });
});

describe("votes: abstention, recusal, revision, notes, secrecy (DEC-F01, AMB-043/077/081/082/083)", () => {
  it("abstentions count neither way: a simple majority of substantive votes decides", async () => {
    await scenario(async (s) => {
      const f = await ready(s);
      const item = await openItem(s, f.meeting);
      await vote(s, "legal", item, "APPROVE");
      await vote(s, "legalB", item, "APPROVE");
      await vote(s, "lead", item, "REJECT");
      await vote(s, "committeeChair", item, "ABSTAIN");
      expect(await close(s, item)).toBe("APPROVED");
    });
  });

  it("a member recuses for a conflict on an item and leaves the deliberation for the rest of the meeting", async () => {
    await scenario(async (s) => {
      const f = await ready(s);
      const item = await openItem(s, f.meeting);
      await vote(s, "legal", item, "APPROVE");
      await s.as("legal");
      await s.expectError(
        "CDF_CONFLICT:ALREADY_VOTED",
        (tx) => tx`select api.recuse_for_conflict(${item}, 'Synthetic: related to a party.')`,
      );
      await s.as("lead");
      await s.expectError("CDF_INVALID:reason", (tx) => tx`select api.recuse_for_conflict(${item}, 'no')`);
      await s.tx`select api.recuse_for_conflict(${item}, 'Synthetic: related to a party.')`;
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.vote_item_status(${item})`);
      await s.as("committeeSecretary");
      expect(
        await s.tx`select coi_status, attendance from committee.meeting_participant where id = ${f.participant.lead!}`,
      ).toEqual([{ coi_status: "CONFLICT_DECLARED", attendance: "EXCUSED_CONFLICT" }]);
      await vote(s, "legalB", item, "APPROVE");
      await vote(s, "committeeChair", item, "REJECT");
      expect(await close(s, item)).toBe("APPROVED");
      expect((await status(s, "committeeSecretary", item)).tally).toMatchObject({ eligible: 3, present: 3 });
      const later = await openItem(s, f.meeting, "Later item (synthetic)");
      await s.as("lead");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.cast_vote(${later}, 'APPROVE', null)`);
    });
  });

  it("a member revises their own open vote; the last choice counts and the ledger never records it", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s);
      const item = await openItem(s, f.meeting);
      await s.as("legalB");
      await s.expectError(
        "CDF_CONFLICT:NOT_VOTED",
        (tx) => tx`select api.revise_vote(${item}, 'REJECT', null)`,
      );
      await vote(s, "legal", item, "APPROVE");
      await s.as("legal");
      await s.tx`select api.revise_vote(${item}, 'REJECT', 'Synthetic: reconsidered.')`;
      await s.expectError(
        "CDF_CONFLICT:VOTE_UNCHANGED",
        (tx) => tx`select api.revise_vote(${item}, 'REJECT', null)`,
      );
      await s.expectError("permission denied", (tx) => tx`select id from committee.vote_revision`);
      for (const u of ["legalB", "lead", "committeeChair"] as const) await vote(s, u, item, "APPROVE");
      expect(await close(s, item)).toBe("APPROVED");
      await s.as("legal");
      await s.expectError(
        "CDF_CONFLICT:VOTE_NOT_OPEN",
        (tx) => tx`select api.revise_vote(${item}, 'APPROVE', null)`,
      );
      const v = await status(s, "legalB", item);
      expect(v.tally).toMatchObject({ approve: 3, reject: 1 });
      expect(v.voters.find((r) => r.user_id === USERS.legal)!.choice).toBe("REJECT");
      const revised = await auditMetadata(s, "VOTE_REVISED");
      expect(revised).toHaveLength(1);
      expect(Object.keys(revised[0]!.metadata).sort()).toEqual(["meeting_id", "revision_no"]);
      expect(revised[0]!.reason).toBeNull();
    });
  });

  it("revisions and notes follow the rule snapshot", async () => {
    await scenario(async (s) => {
      await rule(s, { vote_revision_allowed: false, dissent_note_allowed: false });
      const f = await ready(s);
      const item = await openItem(s, f.meeting);
      await vote(s, "legal", item, "APPROVE");
      await s.as("legal");
      await s.expectError(
        "CDF_CONFLICT:VOTE_REVISION_NOT_ALLOWED",
        (tx) => tx`select api.revise_vote(${item}, 'REJECT', null)`,
      );
      await s.expectError(
        "CDF_CONFLICT:VOTE_NOTE_NOT_ALLOWED",
        (tx) => tx`select api.record_vote_note(${item}, 'Synthetic: a dissent note.', false)`,
      );
    });
  });

  it("a member's note is read by the committee after close and annexed to the minutes only on request", async () => {
    await scenario(async (s) => {
      const f = await ready(s);
      const item = await openItem(s, f.meeting);
      await s.as("legalB");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.record_vote_note(${item}, 'Synthetic: a note before voting.', false)`,
      );
      await vote(s, "legal", item, "REJECT");
      await s.as("legal");
      await s.tx`select api.record_vote_note(${item}, 'Synthetic: annexed dissent note.', true)`;
      await s.expectError(
        "CDF_CONFLICT:VOTE_NOTE_EXISTS",
        (tx) => tx`select api.record_vote_note(${item}, 'Synthetic: a second note.', false)`,
      );
      await vote(s, "legalB", item, "APPROVE");
      await s.as("legalB");
      await s.tx`select api.record_vote_note(${item}, 'Synthetic: a note kept out of the minutes.', false)`;
      expect((await status(s, "lead", item)).notes).toBeNull();
      for (const u of ["lead", "committeeChair"] as const) await vote(s, u, item, "APPROVE");
      await close(s, item);
      const notes = (await status(s, "lead", item)).notes!;
      expect(notes.map((n) => [n.participant_id, n.note])).toEqual([
        [f.participant.legal, "Synthetic: annexed dissent note."],
        [f.participant.legalB, "Synthetic: a note kept out of the minutes."],
      ]);
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      const [mi] = await s.tx<{ id: string }[]>`
        select api.generate_minutes(${f.meeting}, 'Synthetic minutes with an annexed note.') as id`;
      const [snap] = await s.tx<{ notes: { participant_id: string; note: string }[] }[]>`
        select snapshot->'annexed_notes' as notes from committee.minutes where id = ${mi!.id}`;
      expect(snap!.notes.map((n) => [n.participant_id, n.note])).toEqual([
        [f.participant.legal, "Synthetic: annexed dissent note."],
      ]);
      // An invitee reads no vote at all.
      await s.as("committeeSecretary");
      const [m2] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${f.committeeProceeding}, 'HEARING', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '2 days', now() + interval '2 days 1 hour', ${REASON}) as id`;
      await s.tx`select api.invite_to_meeting(${m2!.id}, 'EXPERT', ${USERS.caseManager}, null, false, ${REASON})`;
      await s.as("caseManager");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.vote_item_status(${item})`);
    });
  });

  it("under a secret ballot nobody reads individual choices, nor who wrote a note", async () => {
    await scenario(async (s) => {
      await rule(s, { ballot_secrecy: "SECRET_BALLOT" });
      const f = await ready(s);
      const item = await openItem(s, f.meeting);
      await vote(s, "legal", item, "REJECT");
      await s.as("legal");
      await s.tx`select api.record_vote_note(${item}, 'Synthetic: a secret dissent note.', true)`;
      for (const u of ["legalB", "lead", "committeeChair"] as const) await vote(s, u, item, "APPROVE");
      await close(s, item);
      for (const u of ["committeeSecretary", "committeeChair", "legal"] as const) {
        const v = await status(s, u, item);
        expect(v.ballot_secrecy).toBe("SECRET_BALLOT");
        expect(v.voters.map((r) => r.choice)).toEqual([null, null, null, null]);
        expect(v.notes!.map((n) => n.participant_id)).toEqual([null]);
        expect(v.tally).toMatchObject({ approve: 3, reject: 1 });
      }
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      const [mi] = await s.tx<{ id: string }[]>`
        select api.generate_minutes(${f.meeting}, 'Synthetic minutes of a secret ballot.') as id`;
      const [snap] = await s.tx<{ notes: { participant_id: string | null }[] }[]>`
        select snapshot->'annexed_notes' as notes from committee.minutes where id = ${mi!.id}`;
      expect(snap!.notes.map((n) => n.participant_id)).toEqual([null]);
    });
  });
});

describe("minutes objections (AMB-092, migration 2030)", () => {
  async function minutesWithObjection(s: OwnerScenario) {
    const f = await ready(s);
    await s.as("committeeSecretary");
    await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
    const [mi] = await s.tx<{ id: string }[]>`
      select api.generate_minutes(${f.meeting}, 'Synthetic minutes for the objection test.') as id`;
    await s.tx`select api.record_minutes_reminder(${mi!.id})`;
    await s.as("legal");
    await s.tx`select api.review_minutes(${mi!.id}, 'REQUEST_CHANGES', 'Synthetic: item two is wrong.')`;
    await s.asOwner();
    await s.tx`update committee.minutes set review_due_at = now() - interval '1 minute' where id = ${mi!.id}`;
    return mi!.id;
  }

  it("an objection blocks deemed approval until the chair overrules it with a reason", async () => {
    await ownerScenario(async (s) => {
      const mi = await minutesWithObjection(s);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:OBJECTION_OPEN",
        (tx) => tx`select api.apply_minutes_deemed_approval(${mi})`,
      );
      const overrule = (tx: Scenario["tx"]) =>
        tx`select api.overrule_minutes_objection(${mi}, 'Synthetic: item two is recorded correctly.')`;
      for (const u of ["committeeSecretary", "legal", "lead"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", overrule);
      }
      await s.as("committeeChair");
      await overrule(s.tx);
      await s.expectError("CDF_CONFLICT:NO_OBJECTION", overrule);
      await s.as("committeeSecretary");
      expect((await s.tx<{ r: string }[]>`select api.apply_minutes_deemed_approval(${mi}) as r`)[0]!.r).toBe(
        "DEEMED_APPROVED",
      );
      const deemed = await auditMetadata(s, "MINUTES_DEEMED_APPROVED");
      expect(deemed.map((e) => e.metadata.over_objection)).toEqual([false]);
    });
  });

  it("where the rule says an objection does not block, the minutes are deemed approved over it", async () => {
    await ownerScenario(async (s) => {
      await rule(s, { minutes_objection_blocks_deemed: false });
      const mi = await minutesWithObjection(s);
      await s.as("committeeSecretary");
      expect((await s.tx<{ r: string }[]>`select api.apply_minutes_deemed_approval(${mi}) as r`)[0]!.r).toBe(
        "DEEMED_APPROVED",
      );
      const deemed = await auditMetadata(s, "MINUTES_DEEMED_APPROVED");
      expect(deemed.map((e) => e.metadata.over_objection)).toEqual([true]);
    });
  });
});

describe("notice, invitees and the cancellation notice (AMB-061, AMB-156/157/158, DEC-F07)", () => {
  it("a meeting at shorter notice than the rule's minimum needs the emergency path with a reason", async () => {
    await scenario(async (s) => {
      await rule(s, { minimum_notice_days: 5 });
      await seat(s, ic, IC_SEATS);
      const cp = await refer(s, ic, caseB);
      await s.as("committeeSecretary");
      const schedule = (days: number) => (tx: Scenario["tx"]) =>
        tx`select api.schedule_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + make_interval(days => ${days}), now() + make_interval(days => ${days}) + interval '1 hour', ${REASON})`;
      await s.expectError("CDF_CONFLICT:NOTICE_TOO_SHORT", schedule(1));
      await schedule(6)(s.tx);
      await s.expectError(
        "CDF_INVALID:emergency_reason",
        (
          tx,
        ) => tx`select api.schedule_emergency_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '2 hours', now() + interval '3 hours', ${REASON}, null)`,
      );
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_emergency_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '2 hours', now() + interval '3 hours', ${REASON}, 'Synthetic: an urgent decision is needed.') as id`;
      expect(
        await s.tx`select is_emergency, minimum_notice_days from committee.meeting where id = ${m!.id}`,
      ).toEqual([{ is_emergency: true, minimum_notice_days: 5 }]);
      await s.as("legal");
      await s.expectError(
        "CDF_FORBIDDEN",
        (
          tx,
        ) => tx`select api.schedule_emergency_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '2 hours', now() + interval '3 hours', ${REASON}, 'Synthetic: an urgent decision is needed.')`,
      );
    });
  });

  it("interpreters only once enabled; witnesses acknowledge confidentiality before attending; accommodations stay private", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      // An interpreter always declares conflicts (AMB-156); false is refused for them.
      const invite = (role: string, user: string) => (tx: Scenario["tx"]) =>
        tx<
          { id: string }[]
        >`select api.invite_to_meeting(${f.meeting}, ${role}, ${user}, null, ${role === "INTERPRETER"}, ${REASON}) as id`;
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:INVITEE_TYPE_DISABLED", invite("INTERPRETER", USERS.employee));
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.set_invitee_type_rule('INTERPRETER', true, true, null, 'SOURCE_REQUIRED', ${REASON})`,
      );
      await s.as("platformAdmin");
      await s.tx`select api.set_invitee_type_rule('INTERPRETER', true, true, null, 'SOURCE_REQUIRED', ${REASON})`;
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_INVALID:requires_coi",
        (tx) =>
          tx`select api.invite_to_meeting(${f.meeting}, 'INTERPRETER', ${USERS.employee}, null, false, ${REASON})`,
      );
      const [interpreter] = await invite("INTERPRETER", USERS.employee)(s.tx);
      const [witness] = await invite("WITNESS", USERS.employeeB)(s.tx);
      const [adviser] = await invite("LEGAL", USERS.caseManager)(s.tx);
      expect(
        await s.tx`select invitee_role, requires_coi, confidentiality_ack_required from committee.meeting_participant
                   where id in (${interpreter!.id}, ${witness!.id}, ${adviser!.id}) order by invitee_role collate "C"`,
      ).toEqual([
        { invitee_role: "INTERPRETER", requires_coi: true, confidentiality_ack_required: true },
        { invitee_role: "LEGAL", requires_coi: false, confidentiality_ack_required: false },
        { invitee_role: "WITNESS", requires_coi: false, confidentiality_ack_required: true },
      ]);

      await openWithPresent(s, f, VOTERS);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:CONFIDENTIALITY_ACK_REQUIRED",
        (tx) => tx`select api.record_attendance(${witness!.id}, 'PRESENT')`,
      );
      await s.as("employee");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.acknowledge_meeting_confidentiality(${witness!.id})`,
      );
      await s.as("employeeB");
      await s.tx`select api.acknowledge_meeting_confidentiality(${witness!.id})`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_ACKNOWLEDGED",
        (tx) => tx`select api.acknowledge_meeting_confidentiality(${witness!.id})`,
      );
      await s.tx`select api.record_meeting_accommodation(${witness!.id}, 'Synthetic: step-free access.')`;
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:ACK_NOT_REQUIRED",
        (tx) => tx`select api.acknowledge_meeting_confidentiality(${adviser!.id})`,
      );
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${witness!.id}, 'PRESENT')`;

      // The accommodation: the participant and the secretary running the meeting, nobody else.
      for (const [u, n] of [
        ["employeeB", 1],
        ["committeeSecretary", 1],
        ["legal", 0],
        ["committeeChair", 0],
        ["employee", 0],
        ["caseManager", 0],
      ] as const) {
        await s.as(u);
        expect(await s.tx`select id from committee.meeting_accommodation`, u).toHaveLength(n);
      }
    });
  });

  it("an excluded witness is not sent the meeting's cancellation (DEC-F07)", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await s.as("committeeSecretary");
      const [w] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${f.meeting}, 'WITNESS', ${USERS.employeeB}, null, false, ${REASON}) as id`;
      await s.tx`select api.exclude_meeting_witness(${w!.id}, 'Synthetic: excluded for the walk.')`;
      await s.tx`select api.cancel_meeting(${f.meeting}, ${REASON})`;
      await s.asOwner();
      const recipients = (
        await s.tx<{ recipient_id: string }[]>`
          select distinct recipient_id from notify.outbox
          where template_code = 'MEETING_CANCELLED' and object_id = ${f.meeting}`
      ).map((r) => r.recipient_id);
      expect(recipients).not.toContain(USERS.employeeB);
      expect(recipients).toContain(USERS.legal);
    });
  });
});
