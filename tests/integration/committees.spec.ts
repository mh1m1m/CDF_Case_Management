// Phase 12 P12-2b My Committees and the committee's page (ADR-055, migration 2085) through the real service, gateway,
// database, RLS and audit, the way the pages call them. Each test runs in one owner-connection transaction that is
// rolled back: the gateway runs its security context inside a savepoint of that transaction, exactly as it does on its
// own pool, so no seat, proceeding or meeting reaches the seed. Who may act, and what each flag answers, is pinned by
// tests/security/my-committees-and-meeting-logistics.spec.ts; these pin that the pages' path carries it: the rows and
// flags the pages show, the commands their forms send, and the uniform not-found and denial events.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createCommitteesService, type CommitteesService } from "@cdf/application";
import type { CommitteeView } from "@cdf/contracts";
import { PostgresCommitteesGateway, PostgresSecurityEventSink, type Sql } from "@cdf/infrastructure";
import { USERS, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";
import { IC_SEATS, REASON, committeeIds, refer, seat } from "../support/committee";

const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (fromNow: number) => new Date(Date.now() + fromNow).toISOString();

let caseB: string, ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
});

/** The committees service bound to the scenario's transaction (each call runs in a savepoint). */
function committeesIn(s: OwnerScenario): CommitteesService {
  const sql = {
    begin: (fn: (tx: unknown) => Promise<unknown>) => s.tx.savepoint(fn as never),
  } as unknown as Sql;
  return createCommitteesService({
    gateway: new PostgresCommitteesGateway(sql),
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

function seen(v: CommitteeView | null): CommitteeView {
  if (!v) throw new Error("expected the committee view, got the not-found");
  return v;
}

/** The security events one request recorded, read back on the owner connection. */
async function eventsOf(s: OwnerScenario, requestId: string) {
  await s.asOwner();
  return s.tx<{ action: string; object_type: string; object_id: string; metadata: Record<string, string> }[]>`
    select action, object_type, object_id, metadata from audit.audit_event
    where category = 'SECURITY' and request_id = ${requestId} order by seq`;
}

/** A form's fields for a meeting in a room, as the committee page sends them. */
const inRoom = (committeeProceedingId: string, start: number) => ({
  committeeProceedingId,
  purpose: "DELIBERATION",
  mode: "IN_PERSON",
  location: "Meeting room (synthetic)",
  scheduledStart: at(start),
  scheduledEnd: at(start + HOUR),
  reason: REASON,
});

describe("My Committees and the committee page through the service (Phase 12 P12-2b)", () => {
  it("the secretary schedules within the notice the proceeding copied, or on the emergency path; a member may not", async () => {
    await ownerScenario(async (s) => {
      const cs = committeesIn(s);
      // The committee's rule now asks five days' notice; the referral copies it.
      await s.as("platformAdmin");
      await s.tx`select api.revise_committee_rule_set(${ic}, now(), ${s.tx.json({ minimum_notice_days: 5 } as never)},
        'SOURCE_REQUIRED', ${REASON})`;
      await seat(s, ic, IC_SEATS);
      const secretary = ctxFor("committeeSecretary");
      // The committee's other proceedings (a database the browser specs used has some) count too: compare with them.
      const [base] = await cs.myCommittees(secretary);
      const cp = await refer(s, ic, caseB);

      expect(await cs.myCommittees(secretary)).toEqual([
        expect.objectContaining({
          code: "IC",
          seat: "SECRETARY",
          openProceedings: base!.openProceedings + 1,
          activeMeetings: base!.activeMeetings,
        }),
      ]);
      const before = seen(await cs.committee(secretary, ic));
      expect(before.mySeat.seat).toBe("SECRETARY");
      expect(before.members.map((m) => m.seat)).toEqual(["CHAIR", "SECRETARY", "MEMBER", "MEMBER", "MEMBER"]);
      expect(before.members.every((m) => typeof m.displayName === "string" && m.displayName.length > 0)).toBe(
        true,
      );
      expect(before.rules?.minimumNoticeDays).toBe(5);
      // The newest referral comes first among the open ones.
      const p = before.proceedings[0];
      expect(p).toMatchObject({
        committeeProceedingId: cp,
        status: "OPEN",
        // The case is named only to whoever may see its metadata: a seat by itself does not.
        case: { caseId: null, caseNumber: null },
        meetings: [],
        amendmentCandidates: [],
        capabilities: { mayScheduleMeeting: true, mayScheduleEmergencyMeeting: true, mayAmendSnapshot: true },
      });
      expect(p!.rules.minimumNoticeDays).toBe(5);
      // DEC-F19: the committee as counts, never a person.
      expect(p!.snapshot).toEqual({
        seats: [
          { seat: "CHAIR", count: 1 },
          { seat: "SECRETARY", count: 1 },
          { seat: "MEMBER", count: 3 },
        ],
        voting: 4,
        cleared: 5,
        notCleared: 0,
        firewallRestricted: 0,
        addedAfterReferral: 0,
      });

      // Within the notice the command answers NOTICE_TOO_SHORT, a business answer and not a security event.
      const early = ctxFor("committeeSecretary");
      expect(outcome(await cs.scheduleMeeting(early, inRoom(cp, DAY)))).toBe("CONFLICT:NOTICE_TOO_SHORT");
      expect(await eventsOf(s, early.requestId)).toEqual([]);
      const later = value<string>(
        await cs.scheduleMeeting(secretary, {
          ...inRoom(cp, 6 * DAY),
          mode: "HYBRID",
          onlineUrl: "https://meet.example.test/synthetic-committee",
        }),
      );
      const urgent = value<string>(
        await cs.scheduleEmergencyMeeting(secretary, {
          ...inRoom(cp, 2 * HOUR),
          emergencyReason: "Synthetic: an urgent decision is needed.",
        }),
      );

      const after = seen(await cs.committee(secretary, ic));
      const ours = (v: CommitteeView) => v.proceedings.find((x) => x.committeeProceedingId === cp);
      expect(ours(after)!.meetings.map((m) => [m.meetingId, m.mode, m.isEmergency, m.status])).toEqual([
        [urgent, "IN_PERSON", true, "SCHEDULED"],
        [later, "HYBRID", false, "SCHEDULED"],
      ]);
      expect(await cs.myCommittees(secretary)).toEqual([
        expect.objectContaining({
          code: "IC",
          openProceedings: base!.openProceedings + 1,
          activeMeetings: base!.activeMeetings + 2,
        }),
      ]);

      // A member sees the committee, its proceeding and its meetings, and may schedule nothing. The member's
      // proceedings are the ones they sit in: this referral's, and none from before their seat.
      const legal = ctxFor("legal");
      expect(await cs.myCommittees(legal)).toEqual([
        expect.objectContaining({ code: "IC", seat: "MEMBER", openProceedings: 1, activeMeetings: 2 }),
      ]);
      const member = seen(await cs.committee(legal, ic));
      expect(member.proceedings.map((x) => x.committeeProceedingId)).toEqual([cp]);
      expect(ours(member)!.meetings).toHaveLength(2);
      expect(ours(member)!.capabilities).toEqual({
        mayScheduleMeeting: false,
        mayScheduleEmergencyMeeting: false,
        mayAmendSnapshot: false,
      });
      expect(ours(member)!.amendmentCandidates).toEqual([]);
      const reason = "Synthetic: a scheduling reason that stays in the committee.";
      expect(outcome(await cs.scheduleMeeting(legal, { ...inRoom(cp, 7 * DAY), reason }))).toBe("FORBIDDEN");
      const denied = await eventsOf(s, legal.requestId);
      expect(denied).toEqual([
        {
          action: "COMMAND_DENIED",
          object_type: "command",
          object_id: cp,
          metadata: { command: "schedule_meeting", outcome: "FORBIDDEN" },
        },
      ]);
      expect(JSON.stringify(denied)).not.toContain("stays in the committee");
    });
  });

  it("the secretary adds a member appointed after referral from the candidates the page lists", async () => {
    await ownerScenario(async (s) => {
      const cs = committeesIn(s);
      await seat(
        s,
        ic,
        IC_SEATS.filter(([u]) => u !== "legalB"),
      );
      const cp = await refer(s, ic, caseB);
      await s.as("platformAdmin");
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.legalB}, 'MEMBER', now() - interval '1 hour', null,
        'DEMO-APPT-LATER')`;
      const secretary = ctxFor("committeeSecretary");

      const ours = (v: CommitteeView) => v.proceedings.find((x) => x.committeeProceedingId === cp);
      const p = ours(seen(await cs.committee(secretary, ic)));
      expect(p!.amendmentCandidates).toEqual([
        expect.objectContaining({ userId: USERS.legalB, seat: "MEMBER", displayName: expect.any(String) }),
      ]);
      // Only whoever may amend sees a candidate: the newly appointed member is not in the proceeding, so it is not
      // on their page at all.
      expect(ours(seen(await cs.committee(ctxFor("legalB"), ic)))).toBeUndefined();

      const membership = p!.amendmentCandidates[0]!.membershipId;
      expect(
        outcome(
          await cs.amendProceedingSnapshot(secretary, {
            committeeProceedingId: cp,
            membershipId: membership,
            reason: "Synthetic: appointed after the referral.",
          }),
        ),
      ).toBe("ok");
      const amended = ours(seen(await cs.committee(secretary, ic)));
      expect(amended!.amendmentCandidates).toEqual([]);
      expect(amended!.snapshot).toMatchObject({ addedAfterReferral: 1, voting: 4 });
      expect(amended!.snapshot.seats).toContainEqual({ seat: "MEMBER", count: 3 });
    });
  });

  it("without a current seat there is no committee: the uniform not-found and an ACCESS_DENIED event", async () => {
    await ownerScenario(async (s) => {
      const cs = committeesIn(s);
      await seat(s, ic, IC_SEATS);
      await refer(s, ic, caseB);

      // The case team sees the case and never the committee's page; PLATFORM_ADMIN implies no seat (§21).
      for (const user of ["caseManager", "platformAdmin"] as const) {
        expect(await cs.myCommittees(ctxFor(user)), user).toEqual([]);
        const c = ctxFor(user);
        expect(await cs.committee(c, ic), user).toBeNull();
        expect(await eventsOf(s, c.requestId), user).toEqual([
          {
            action: "ACCESS_DENIED",
            object_type: "committee",
            object_id: ic,
            metadata: { read: "committee_view" },
          },
        ]);
      }
      // An id that names nothing reads exactly like one that is refused.
      const nothing = ctxFor("committeeSecretary");
      expect(await cs.committee(nothing, randomUUID())).toBeNull();
      expect((await eventsOf(s, nothing.requestId)).map((e) => e.action)).toEqual(["ACCESS_DENIED"]);

      // An ended seat is no seat: the member's committee goes from both pages.
      await s.as("platformAdmin");
      await s.tx`
        select api.end_committee_membership(m.id, now(), ${REASON})
        from committee.membership m
        where m.committee_id = ${ic} and m.user_id = ${USERS.legal} and m.ended_at is null`;
      expect(await cs.myCommittees(ctxFor("legal"))).toEqual([]);
      expect(await cs.committee(ctxFor("legal"), ic)).toBeNull();
    });
  });
});
