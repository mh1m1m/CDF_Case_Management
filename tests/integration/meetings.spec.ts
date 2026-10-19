// Phase 12 P12-2a and P12-2b meeting and minutes screens (ADR-054 and ADR-055, migrations 2065 and 2085) through the
// real service, gateway, database, RLS and audit, the way the pages call them. Each test runs in one owner-connection transaction that is rolled back:
// the gateway runs its security context inside a savepoint of that transaction, exactly as it does on its own pool, so
// no seat, meeting, vote or minutes reaches the seed. Who may act is pinned by the security specs
// (meeting-screen-capabilities, committee-meetings, meeting-excuses-concerns); these pin that the screens' path carries
// it: the flags the pages show, the commands their forms send, and the uniform not-found and denial events.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createMeetingsService, type MeetingsService } from "@cdf/application";
import type { MeetingFullView, MeetingView } from "@cdf/contracts";
import { PostgresMeetingsGateway, PostgresSecurityEventSink, type Sql } from "@cdf/infrastructure";
import { USERS, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";
import {
  IC_SEATS,
  REASON,
  committeeIds,
  scheduleMeeting,
  seat,
  type MeetingFixture,
} from "../support/committee";

const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });
const VOTERS: UserKey[] = ["committeeChair", "legal", "legalB", "lead"];
const CONCERN = "Synthetic: the member reviewed this matter before, for the screen test.";

let caseB: string, ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
});

/** The meetings service bound to the scenario's transaction (each call runs in a savepoint). */
function meetingsIn(s: OwnerScenario): MeetingsService {
  const sql = {
    begin: (fn: (tx: unknown) => Promise<unknown>) => s.tx.savepoint(fn as never),
  } as unknown as Sql;
  return createMeetingsService({
    gateway: new PostgresMeetingsGateway(sql),
    securityEvents: new PostgresSecurityEventSink(sql),
  });
}

function outcome(r: { ok: boolean }): string {
  if (r.ok) return "ok";
  if ("error" in r) {
    const e = (r as { error: { kind: string; detail?: string } }).error;
    return e.detail ? `${e.kind}:${e.detail}` : e.kind;
  }
  return "fieldErrors";
}

function value<T>(r: { ok: boolean }): T {
  if (!r.ok) throw new Error(`expected ok, got ${outcome(r)}`);
  return (r as unknown as { value: T }).value;
}

function full(v: MeetingView | null): MeetingFullView {
  if (v?.view !== "FULL") throw new Error(`expected the full view, got ${v?.view ?? "null"}`);
  return v;
}

/** The security events one request recorded, read back on the owner connection. */
async function eventsOf(s: OwnerScenario, requestId: string) {
  await s.asOwner();
  return s.tx<{ action: string; object_type: string; object_id: string; metadata: Record<string, string> }[]>`
    select action, object_type, object_id, metadata from audit.audit_event
    where category = 'SECURITY' and request_id = ${requestId} order by seq`;
}

/** Seats the committee, refers case 0002 and schedules a deliberation; the voters declare and the secretary opens. */
async function openMeeting(s: OwnerScenario, ms: MeetingsService): Promise<MeetingFixture> {
  await seat(s, ic, IC_SEATS);
  const f = await scheduleMeeting(s, ic, caseB);
  for (const u of VOTERS) {
    const mine = full(await ms.meeting(ctxFor(u), f.meeting));
    expect(mine.me?.participantId, u).toBe(f.participant[u]);
    expect(mine.capabilities.mayDeclareNoConflict, u).toBe(true);
    const r = await ms.declareConflict(ctxFor(u), { participantId: f.participant[u], status: "NO_CONFLICT" });
    expect(outcome(r), u).toBe("ok");
  }
  const secretary = ctxFor("committeeSecretary");
  expect(outcome(await ms.openMeeting(secretary, { meetingId: f.meeting, reason: REASON }))).toBe("ok");
  for (const u of VOTERS) {
    const r = await ms.recordAttendance(secretary, {
      participantId: f.participant[u],
      attendance: "PRESENT",
    });
    expect(outcome(r), u).toBe("ok");
  }
  return f;
}

describe("meeting and minutes screens through the service (Phase 12 P12-2a)", () => {
  it("the secretary runs a meeting from opening to minutes; the members declare, vote and review", async () => {
    await ownerScenario(async (s) => {
      const ms = meetingsIn(s);
      const secretary = ctxFor("committeeSecretary");
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);

      // Scheduled: the secretary runs it, sees the roster with names, and may open it, nothing else yet.
      const scheduled = full(await ms.meeting(secretary, f.meeting));
      expect(scheduled.logistics.status).toBe("SCHEDULED");
      // The case is named only to whoever may see its metadata (as in 1820): the case team, not a seat by itself.
      expect(scheduled.case).toEqual({ caseId: null, caseNumber: null });
      const team = full(await ms.meeting(ctxFor("caseManager"), f.meeting));
      expect(team.case.caseId).toBe(caseB);
      expect(team.case.caseNumber).toMatch(/^CDF-DEMO-\d{4}-0002$/);
      // The case team reads the meeting and may do nothing in it.
      expect(Object.values(team.capabilities).every((flag) => flag === false)).toBe(true);
      expect(scheduled.capabilities).toMatchObject({
        canManage: true,
        mayOpen: true,
        mayClose: false,
        mayOpenVote: false,
        mayGenerateMinutes: false,
      });
      const members = scheduled.roster!.filter((r) => r.participantKind === "MEMBER");
      expect(members.map((r) => r.userId).sort()).toEqual(
        ["committeeChair", "committeeSecretary", "legal", "legalB", "lead"]
          .map((u) => USERS[u as UserKey])
          .sort(),
      );
      expect(members.every((r) => typeof r.displayName === "string" && r.displayName.length > 0)).toBe(true);
      // A member's own part offers only the declaration; the meeting is not theirs to open.
      const legalScheduled = full(await ms.meeting(ctxFor("legal"), f.meeting));
      expect(legalScheduled.capabilities).toMatchObject({
        canManage: false,
        mayOpen: false,
        mayDeclareConflict: true,
        mayDeclareNoConflict: true,
      });

      // Each voter declares, the secretary opens and records them present: through the screens' commands.
      for (const u of VOTERS) {
        const r = await ms.declareConflict(ctxFor(u), {
          participantId: f.participant[u],
          status: "NO_CONFLICT",
        });
        expect(outcome(r), u).toBe("ok");
      }
      expect(outcome(await ms.openMeeting(secretary, { meetingId: f.meeting, reason: REASON }))).toBe("ok");
      const opened = full(await ms.meeting(secretary, f.meeting));
      const legalRow = opened.roster!.find((r) => r.participantId === f.participant.legal)!;
      expect(legalRow.capabilities).toMatchObject({ mayRecordPresent: true, mayRecordAbsent: true });
      // On someone else's row a member has nothing to record (the meeting-level raise is theirs, ADR-054), and
      // no flag there is computed for them (2085 adds its own, false the same way).
      const asLegal = full(await ms.meeting(ctxFor("legal"), f.meeting));
      const leadRow = asLegal.roster!.find((r) => r.participantId === f.participant.lead)!;
      expect(leadRow.capabilities).toMatchObject({
        mayRecordPresent: false,
        mayRecordAbsent: false,
        mayRecordExcusedConflict: false,
        mayRecordExcusedAbsence: false,
        mayRaiseConcern: false,
      });
      expect(Object.values(leadRow.capabilities).every((flag) => flag === false)).toBe(true);
      for (const u of VOTERS) {
        const r = await ms.recordAttendance(secretary, {
          participantId: f.participant[u],
          attendance: "PRESENT",
        });
        expect(outcome(r), u).toBe("ok");
      }

      // A vote on other business: three approve, one rejects. Progress says who voted, never how.
      const item = value<string>(
        await ms.openVoteItem(secretary, { meetingId: f.meeting, title: "Recommendation (synthetic)" }),
      );
      const choices: [UserKey, string][] = [
        ["committeeChair", "APPROVE"],
        ["legal", "APPROVE"],
        ["legalB", "REJECT"],
      ];
      for (const [u, choice] of choices) {
        const mine = full(await ms.meeting(ctxFor(u), f.meeting));
        expect(mine.deliberation!.voteItems.find((v) => v.voteItemId === item)!.capabilities.mayVote, u).toBe(
          true,
        );
        expect(outcome(await ms.castVote(ctxFor(u), { voteItemId: item, choice })), u).toBe("ok");
      }
      const progress = await ms.voteItemProgress(secretary, item);
      expect(
        progress!.voters
          .filter((v) => v.hasVoted)
          .map((v) => v.userId)
          .sort(),
      ).toEqual([USERS.committeeChair, USERS.legal, USERS.legalB].sort());
      expect(progress!.voters.find((v) => v.userId === USERS.lead)!.hasVoted).toBe(false);
      expect(JSON.stringify(progress)).not.toMatch(/APPROVE|REJECT/);
      // Closing with a vote outstanding is the business answer, not a denial.
      const early = ctxFor("committeeSecretary");
      expect(outcome(await ms.closeVoteItem(early, { voteItemId: item, customQuorumAttested: false }))).toBe(
        "CONFLICT:VOTES_OUTSTANDING",
      );
      expect(await eventsOf(s, early.requestId)).toEqual([]);
      // A meeting held on the platform has no paper ballots (2120, ADR-048): nothing to confirm, and a member who
      // tries gets the business answer through the whole path.
      const unballoted = full(await ms.meeting(ctxFor("lead"), f.meeting));
      const unballotedItem = unballoted.deliberation!.voteItems.find((v) => v.voteItemId === item)!;
      expect([
        unballoted.logistics.heldOffline,
        unballotedItem.offlineBallots,
        unballotedItem.myBallot,
        unballotedItem.capabilities.mayConfirmBallot,
        unballotedItem.capabilities.mayDeclineBallot,
        unballotedItem.ballotsReleasableFor,
      ]).toEqual([false, { provisional: 0, confirmed: 0, superseded: 0, lapsed: 0 }, null, false, false, []]);
      expect(
        outcome(await ms.confirmOfflineBallot(ctxFor("lead"), { voteItemId: item, choice: "APPROVE" })),
      ).toBe("CONFLICT:NO_PROVISIONAL_BALLOT");
      // 2125 (ADR-062): nothing to decline either.
      expect(outcome(await ms.declineOfflineBallot(ctxFor("lead"), { voteItemId: item }))).toBe(
        "CONFLICT:NO_PROVISIONAL_BALLOT",
      );
      expect(outcome(await ms.castVote(ctxFor("lead"), { voteItemId: item, choice: "APPROVE" }))).toBe("ok");
      // A member who voted may revise while the item is open; the screen offers it.
      const leadView = full(await ms.meeting(ctxFor("lead"), f.meeting));
      const leadItem = leadView.deliberation!.voteItems.find((v) => v.voteItemId === item)!;
      expect([leadItem.iHaveVoted, leadItem.capabilities.mayRevise, leadItem.capabilities.mayVote]).toEqual([
        true,
        true,
        false,
      ]);
      expect(
        value<string>(await ms.closeVoteItem(secretary, { voteItemId: item, customQuorumAttested: false })),
      ).toBe("APPROVED");

      // Closed: the meeting may close, then the minutes are generated for review.
      const voted = full(await ms.meeting(secretary, f.meeting));
      expect(voted.deliberation!.voteItems.find((v) => v.voteItemId === item)).toMatchObject({
        status: "CLOSED",
        result: "APPROVED",
      });
      expect(voted.capabilities.mayClose).toBe(true);
      expect(outcome(await ms.closeMeeting(secretary, { meetingId: f.meeting, reason: REASON }))).toBe("ok");
      expect(full(await ms.meeting(secretary, f.meeting)).capabilities.mayGenerateMinutes).toBe(true);
      const minutes = value<string>(
        await ms.generateMinutes(secretary, {
          meetingId: f.meeting,
          narrative: "Synthetic minutes: the committee approved the recommendation.",
        }),
      );
      expect(full(await ms.meeting(secretary, f.meeting)).minutes).toEqual([
        expect.objectContaining({ minutesId: minutes, versionNo: 1, status: "IN_REVIEW" }),
      ]);

      // A member who sat reviews them; the record is the snapshot, with the result and counts, never a choice.
      const legal = ctxFor("legal");
      const before = await ms.minutes(legal, minutes);
      expect(before).toMatchObject({ status: "IN_REVIEW", iHaveReviewed: false });
      expect(before!.capabilities.mayReview).toBe(true);
      expect(before!.meeting?.meetingId).toBe(f.meeting);
      expect(before!.snapshot.voteItems).toEqual([
        expect.objectContaining({
          voteItemId: item,
          result: "APPROVED",
          tally: expect.objectContaining({ approve: 3, reject: 1 }),
        }),
      ]);
      expect(value<string>(await ms.reviewMinutes(legal, { minutesId: minutes, decision: "APPROVE" }))).toBe(
        "IN_REVIEW",
      );
      const after = await ms.minutes(ctxFor("legal"), minutes);
      expect([after!.iHaveReviewed, after!.capabilities.mayReview]).toEqual([true, false]);
      expect(after!.reviews).toEqual([
        expect.objectContaining({ reviewerId: USERS.legal, decision: "APPROVE" }),
      ]);
      // The secretary does not review the minutes they wrote.
      expect((await ms.minutes(secretary, minutes))!.capabilities.mayReview).toBe(false);
    });
  });

  it("a concern raised on the screen reaches its decider and not its subject; the chair decides it there", async () => {
    await ownerScenario(async (s) => {
      const ms = meetingsIn(s);
      const f = await openMeeting(s, ms);

      // Legal raises from the meeting-level form, naming the participant; the command answers.
      expect(full(await ms.meeting(ctxFor("legal"), f.meeting)).capabilities.mayRaiseConcern).toBe(true);
      const concern = value<string>(
        await ms.raiseConcern(ctxFor("legal"), { participantId: f.participant.lead, reason: CONCERN }),
      );
      const raised = (u: UserKey) => ms.meeting(ctxFor(u), f.meeting).then((v) => full(v).concerns);
      expect(await raised("legal")).toEqual([
        expect.objectContaining({
          concernId: concern,
          participantId: f.participant.lead,
          raisedBy: USERS.legal,
          status: "OPEN",
          capabilities: { mayDecide: false, mayReverse: false },
        }),
      ]);
      // The subject and the other members read none of it.
      for (const u of ["lead", "legalB"] as const) expect(await raised(u), u).toEqual([]);
      const [chairs] = await raised("committeeChair");
      expect(chairs?.capabilities).toEqual({ mayDecide: true, mayReverse: false });

      // The raiser cannot decide; the refusal is recorded with the command and outcome, never the reason.
      const legal = ctxFor("legal");
      const refused = await ms.decideConcern(legal, {
        concernId: concern,
        decision: "UPHELD",
        reason: CONCERN,
      });
      expect(outcome(refused)).toBe("FORBIDDEN");
      const events = await eventsOf(s, legal.requestId);
      expect(events).toEqual([
        {
          action: "COMMAND_DENIED",
          object_type: "command",
          object_id: concern,
          metadata: { command: "decide_meeting_conflict", outcome: "FORBIDDEN" },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("reviewed this matter");

      const decided = await ms.decideConcern(ctxFor("committeeChair"), {
        concernId: concern,
        decision: "DISMISSED",
        reason: "Synthetic: no direct link, for the screen test.",
      });
      expect(outcome(decided)).toBe("ok");
      expect(await raised("committeeChair")).toEqual([
        expect.objectContaining({
          concernId: concern,
          status: "DISMISSED",
          decidedBy: USERS.committeeChair,
          capabilities: { mayDecide: false, mayReverse: false },
        }),
      ]);
    });
  });

  it("whoever may not read a meeting gets the uniform not-found and an ACCESS_DENIED event; a refused command is COMMAND_DENIED", async () => {
    await ownerScenario(async (s) => {
      const ms = meetingsIn(s);
      const f = await openMeeting(s, ms);
      const item = value<string>(
        await ms.openVoteItem(ctxFor("committeeSecretary"), {
          meetingId: f.meeting,
          title: "Recommendation (synthetic)",
        }),
      );

      // PLATFORM_ADMIN never implies case content (§21): every read is the same not-found.
      for (const [read, run] of [
        ["meeting_view", (c: ReturnType<typeof ctxFor>) => ms.meeting(c, f.meeting)],
        ["vote_item_status", (c: ReturnType<typeof ctxFor>) => ms.voteItemProgress(c, item)],
      ] as const) {
        const admin = ctxFor("platformAdmin");
        expect(await run(admin), read).toBeNull();
        expect(await eventsOf(s, admin.requestId), read).toEqual([
          {
            action: "ACCESS_DENIED",
            object_type: read === "meeting_view" ? "meeting" : "vote_item",
            object_id: read === "meeting_view" ? f.meeting : item,
            metadata: { read },
          },
        ]);
      }
      // An id that names nothing reads exactly like one that is refused.
      const nothing = ctxFor("committeeSecretary");
      expect(await ms.meeting(nothing, randomUUID())).toBeNull();
      expect((await eventsOf(s, nothing.requestId)).map((e) => e.action)).toEqual(["ACCESS_DENIED"]);

      // A member does not run the meeting: the database refuses, the service records it without the reason.
      const legal = ctxFor("legal");
      const reason = "Synthetic: a closing reason that stays in the committee.";
      expect(outcome(await ms.closeMeeting(legal, { meetingId: f.meeting, reason }))).toBe("FORBIDDEN");
      const denied = await eventsOf(s, legal.requestId);
      expect(denied).toEqual([
        {
          action: "COMMAND_DENIED",
          object_type: "command",
          object_id: f.meeting,
          metadata: { command: "close_meeting", outcome: "FORBIDDEN" },
        },
      ]);
      expect(JSON.stringify(denied)).not.toContain("stays in the committee");
      // The secretary records nobody's vote choice for them: a substantive choice never reaches the database.
      const forMember = await ms.recordVoteForMember(ctxFor("committeeSecretary"), {
        voteItemId: item,
        participantId: f.participant.legal,
        choice: "APPROVE",
        reason: "Synthetic: on the member's behalf.",
      });
      expect(outcome(forMember)).toBe("fieldErrors");
    });
  });

  it("the meeting's logistics (P12-2b): the secretary's path for a witness without an account, an accommodation, exclusion and a handover", async () => {
    await ownerScenario(async (s) => {
      const ms = meetingsIn(s);
      // A person of case B without an account, added by the case manager, to invite as a witness.
      await s.as("caseManager");
      const [subject] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Witness Omega (synthetic)', 'EMPLOYEE', null) as id`;
      const [person] = await s.tx<{ person_id: string }[]>`
        select person_id from case_mgmt.case_subject where id = ${subject!.id}`;
      await seat(s, ic, [...IC_SEATS, ["employee", "ALTERNATE_SECRETARY"]]);
      const f = await scheduleMeeting(s, ic, caseB);
      // Inviting has no form until P12-2c: the invitation is made here through the command itself.
      await s.as("committeeSecretary");
      const [invited] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${f.meeting}, 'WITNESS', null, ${person!.person_id}, true, ${REASON}) as id`;
      const witness = invited!.id;
      const secretary = ctxFor("committeeSecretary");
      const rowOf = async (u: UserKey) =>
        full(await ms.meeting(ctxFor(u), f.meeting)).roster?.find((r) => r.participantId === witness);

      // The secretary answers for the person on their row (ADR-054 §5): declaration, acknowledgement, accommodation.
      expect((await rowOf("committeeSecretary"))?.capabilities).toMatchObject({
        mayDeclareConflict: true,
        mayDeclareNoConflict: true,
        mayAcknowledgeConfidentiality: true,
        mayRecordAccommodation: true,
        mayExcludeWitness: true,
      });
      expect(
        outcome(await ms.declareConflict(secretary, { participantId: witness, status: "NO_CONFLICT" })),
      ).toBe("ok");
      expect(outcome(await ms.acknowledgeConfidentiality(secretary, { participantId: witness }))).toBe("ok");
      const details = "Synthetic: step-free access, for the screen test.";
      value<string>(await ms.recordAccommodation(secretary, { participantId: witness, details }));
      expect((await rowOf("committeeSecretary"))?.arrangements).toEqual({
        confidentialityAcknowledged: true,
        accommodations: [expect.objectContaining({ details, source: "SECRETARY" })],
      });

      // A member reads the roster, never the witness's arrangements, and may record nothing for them; the refusal
      // carries no details (they may concern health, AMB-157).
      const member = await rowOf("legal");
      expect(member?.arrangements).toBeNull();
      expect(Object.values(member!.capabilities).every((flag) => flag === false)).toBe(true);
      const legal = ctxFor("legal");
      expect(outcome(await ms.recordAccommodation(legal, { participantId: witness, details }))).toBe(
        "FORBIDDEN",
      );
      const denied = await eventsOf(s, legal.requestId);
      expect(denied.map((e) => [e.action, e.metadata])).toEqual([
        ["COMMAND_DENIED", { command: "record_meeting_accommodation", outcome: "FORBIDDEN" }],
      ]);
      expect(JSON.stringify(denied)).not.toContain("step-free");

      // Excluded, the witness takes no further arrangement.
      value<string>(
        await ms.excludeWitness(secretary, {
          participantId: witness,
          reason: "Synthetic: heard and released, for the screen test.",
        }),
      );
      expect((await rowOf("committeeSecretary"))?.capabilities).toMatchObject({
        mayExcludeWitness: false,
        mayRecordAccommodation: false,
      });

      // The secretary hands the meeting over to the alternate secretary, once.
      expect(full(await ms.meeting(secretary, f.meeting)).capabilities.mayActivateActingSecretary).toBe(true);
      value<string>(
        await ms.activateActingSecretary(secretary, {
          meetingId: f.meeting,
          reason: "Synthetic: handing over, for the screen test.",
        }),
      );
      const after = full(await ms.meeting(secretary, f.meeting));
      expect(after.actingRoles).toEqual([
        expect.objectContaining({
          actingRole: "ACTING_SECRETARY",
          userId: USERS.employee,
          basis: "HANDOVER",
          activatedAs: "SECRETARY",
        }),
      ]);
      expect(after.capabilities.mayActivateActingSecretary).toBe(false);
    });
  });
});
