// Business architecture rebase, migration 2000 (ADR-038; gap P11-G6; owner Q&A Q41–Q44, Q47, Q49, Q51; DEC-30):
// excused attendance and conflicts raised by another participant of a committee meeting. The secretary records a
// justified absence with a reason that only the secretary and the participant read; an excused participant is not
// present. A cleared member or the secretary raises another participant's conflict; until it is decided no vote item
// opens; the decider named by the rule snapshot (the chair, the deputy chair when the chair is involved, or the
// secretary) upholds it, which makes the subject conflicted exactly as a declaration would, or dismisses it. The raiser
// and the subject never decide, and nobody decides when nobody holds the role. Every step runs through the api.*
// commands as `authenticated`; the owner connection is used only for a rule-set fixture and to probe the tables.
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
  scheduleMeeting,
  seat,
  type MeetingFixture,
} from "../support/committee";

const EXCUSE = "Synthetic: unique-excuse-marker-2000, medical appointment.";
const CONCERN = "Synthetic: unique-concern-marker-2000, works for the subject's unit.";
const DECISION = "Synthetic: unique-decision-marker-2000, the link is direct.";

let caseB: string, ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
});

const VOTERS: UserKey[] = ["committeeChair", "legal", "legalB", "lead"];
/** As IC_SEATS, with lead as deputy chair. */
const DEPUTY_SEATS: [UserKey, string][] = IC_SEATS.map(([u, s]) => [u, u === "lead" ? "DEPUTY_CHAIR" : s]);

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

const excuse = (s: Scenario, participant: string, reason = EXCUSE) =>
  s.tx<{ id: string }[]>`select api.record_excused_absence(${participant}, ${reason}) as id`;
const raise = (s: Scenario, participant: string, reason = CONCERN) =>
  s.tx<{ id: string }[]>`select api.raise_meeting_conflict(${participant}, ${reason}) as id`;
const decide = (s: Scenario, concern: string, decision: string, reason = DECISION) =>
  s.tx`select api.decide_meeting_conflict(${concern}, ${decision}, ${reason})`;

/** Every listed member votes APPROVE and the secretary closes the item. */
async function voteAndClose(s: Scenario, item: string, voters: UserKey[] = VOTERS): Promise<void> {
  for (const u of voters) {
    await s.as(u);
    await s.tx`select api.cast_vote(${item}, 'APPROVE', null)`;
  }
  await s.as("committeeSecretary");
  await s.tx`select api.close_vote_item(${item}, null)`;
}

async function participant(s: Scenario, id: string) {
  const [r] = await s.tx<{ coi_status: string; attendance: string }[]>`
    select coi_status, attendance from committee.meeting_participant where id = ${id}`;
  return r!;
}

async function concernsSeenBy(s: Scenario, user: UserKey): Promise<string[]> {
  await s.as(user);
  const rows = await s.tx<
    { id: string }[]
  >`select id from committee.meeting_conflict_concern order by raised_at`;
  return rows.map((r) => r.id);
}

describe("excused attendance and raised conflicts (migration 2000, P11-G6, ADR-038)", () => {
  it("the secretary records a justified absence with a reason; it is not presence, and the reason stays private", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s, ["committeeChair", "legal", "legalB"]);
      // A member who has not declared yet raises nothing (fail safe until the declaration).
      await s.as("lead");
      await s.expectError("CDF_FORBIDDEN", () => raise(s, f.participant.legal!));
      await s.tx`select api.declare_meeting_conflict(${f.participant.lead!}, 'NO_CONFLICT', null)`;

      // Only the secretary running the meeting records it; outsiders learn nothing.
      // The case team sees the meeting (1890) without running it.
      for (const u of ["legal", "committeeChair", "lead", "caseManager"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", () => excuse(s, f.participant.lead!));
      }
      for (const u of ["investigatorA", "platformAdmin", "employee"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", () => excuse(s, f.participant.lead!));
      }
      await s.as("revoked");
      await s.expectError("CDF_UNAUTHENTICATED", () => excuse(s, f.participant.lead!));
      await s.as(null);
      await s.expectError("permission denied", () => excuse(s, f.participant.lead!));

      await s.as("committeeSecretary");
      await s.expectError("CDF_INVALID:reason", () => excuse(s, f.participant.lead!, "abc"));
      const [e] = await excuse(s, f.participant.lead!);
      expect(await participant(s, f.participant.lead!)).toEqual({
        coi_status: "NO_CONFLICT",
        attendance: "EXCUSED",
      });
      await s.expectError("CDF_CONFLICT:ALREADY_EXCUSED", () => excuse(s, f.participant.lead!));

      // An excused member is not present: no vote, and the quorum counts them as absent (Q51).
      const item = await openItem(s, f.meeting);
      await s.expectError("CDF_CONFLICT:VOTE_IN_PROGRESS", () => excuse(s, f.participant.legalB!));
      await s.as("lead");
      await s.expectError(
        "CDF_CONFLICT:NOT_PRESENT",
        (tx) => tx`select api.cast_vote(${item}, 'APPROVE', null)`,
      );
      await voteAndClose(s, item, ["committeeChair", "legal", "legalB"]);
      const [counts] = await s.tx<{ eligible_count: number; present_count: number }[]>`
        select eligible_count, present_count from committee.vote_item where id = ${item}`;
      expect(counts).toEqual({ eligible_count: 4, present_count: 3 });

      // A declared conflict is never an excuse; the excused participant may still arrive.
      await s.as("legal");
      await s.tx`select api.declare_meeting_conflict(${f.participant.legal!}, 'CONFLICT_DECLARED', 'Synthetic: related.')`;
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:CONFLICT_DECLARED", () => excuse(s, f.participant.legal!));
      await s.tx`select api.record_attendance(${f.participant.lead!}, 'PRESENT')`;
      expect((await participant(s, f.participant.lead!)).attendance).toBe("PRESENT");

      // The reason: the secretary and the participant read it; other members and outsiders do not.
      await s.as("committeeSecretary");
      expect(await s.tx`select id, reason from committee.attendance_excuse`).toEqual([
        { id: e!.id, reason: EXCUSE },
      ]);
      await s.as("lead");
      expect(await s.tx`select id from committee.attendance_excuse`).toEqual([{ id: e!.id }]);
      for (const u of [
        "committeeChair",
        "legalB",
        "investigatorA",
        "platformAdmin",
        "internalAudit",
      ] as const) {
        await s.as(u);
        expect(await s.tx`select id from committee.attendance_excuse`, u).toEqual([]);
      }

      // The ledger has the fact, never the reason.
      await s.asOwner();
      const events = await s.tx<{ metadata: Record<string, unknown> }[]>`
        select metadata from audit.audit_event
        where action = 'ATTENDANCE_RECORDED' and object_id = ${f.participant.lead!} order by seq`;
      expect(events.map((x) => x.metadata)).toEqual([
        { meeting_id: f.meeting, from: "NOT_RECORDED", to: "EXCUSED", excuse_id: e!.id },
        { meeting_id: f.meeting, from: "EXCUSED", to: "PRESENT" },
      ]);
      const all = await s.tx`select reason, metadata from audit.audit_event where case_id = ${caseB}`;
      expect(JSON.stringify(all)).not.toMatch(/unique-excuse-marker/);

      // Append-only, and the shape holds for the owner too.
      await s.expectError(
        "",
        (tx) => tx`update committee.attendance_excuse set reason = 'Synthetic: changed.' where id = ${e!.id}`,
      );
      await s.expectError("", (tx) => tx`delete from committee.attendance_excuse where id = ${e!.id}`);
      await s.expectError(
        "",
        (tx) =>
          tx`update committee.meeting_participant set attendance = 'EXCUSED' where id = ${f.participant.legal!}`,
      );
    });
  });

  it("a raised conflict stops votes until the chair decides; upheld, the subject is conflicted as by a declaration", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s);

      // Who may raise: a cleared member or the secretary, never about themself; outsiders learn nothing.
      await s.as("lead");
      await s.expectError("CDF_CONFLICT:OWN_CONFLICT", () => raise(s, f.participant.lead!));
      for (const u of ["investigatorA", "platformAdmin", "employee"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", () => raise(s, f.participant.lead!));
      }
      // The case team sees the meeting without sitting in it.
      await s.as("caseManager");
      await s.expectError("CDF_FORBIDDEN", () => raise(s, f.participant.lead!));
      await s.as("revoked");
      await s.expectError("CDF_UNAUTHENTICATED", () => raise(s, f.participant.lead!));
      await s.as(null);
      await s.expectError("permission denied", () => raise(s, f.participant.lead!));
      await s.as("legal");
      await s.expectError("CDF_INVALID:reason", () => raise(s, f.participant.lead!, "too short"));
      const [k] = await raise(s, f.participant.lead!);
      await s.as("legalB");
      await s.expectError("CDF_CONFLICT:CONCERN_OPEN", () => raise(s, f.participant.lead!));

      // An invitee who need not declare cannot be the subject of a concern.
      await s.as("committeeSecretary");
      const [expert] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${f.meeting}, 'EXPERT', ${USERS.caseManager}, null, false, ${REASON}) as id`;
      await s.expectError("CDF_CONFLICT:COI_NOT_REQUIRED", () => raise(s, expert!.id));

      // The raiser, the secretary and the decider read it; the subject and the other members do not.
      expect(await concernsSeenBy(s, "legal")).toEqual([k!.id]);
      expect(await concernsSeenBy(s, "committeeSecretary")).toEqual([k!.id]);
      expect(await concernsSeenBy(s, "committeeChair")).toEqual([k!.id]);
      for (const u of ["lead", "legalB", "investigatorA", "platformAdmin", "internalAudit"] as const) {
        expect(await concernsSeenBy(s, u), u).toEqual([]);
      }

      // Work waits: no vote item opens while it is open.
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:CONFLICT_CONCERN_OPEN",
        (tx) => tx`select api.open_vote_item(${f.meeting}, 'OTHER', null, 'Recommendation (synthetic)')`,
      );

      // Only the chair decides here (rule snapshot CHAIR): not the raiser, the subject, the secretary or a member.
      await s.as("legal");
      await s.expectError("CDF_FORBIDDEN", () => decide(s, k!.id, "UPHELD"));
      await s.as("committeeSecretary");
      await s.expectError("CDF_FORBIDDEN", () => decide(s, k!.id, "UPHELD"));
      for (const u of ["lead", "legalB", "investigatorA", "platformAdmin"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", () => decide(s, k!.id, "UPHELD"));
      }
      await s.as("committeeChair");
      await s.expectError("CDF_INVALID:decision", () => decide(s, k!.id, "MAYBE"));
      await s.expectError("CDF_INVALID:reason", () => decide(s, k!.id, "UPHELD", "short"));
      await decide(s, k!.id, "UPHELD");
      await s.expectError("CDF_CONFLICT:NOTHING_TO_DECIDE", () => decide(s, k!.id, "DISMISSED"));

      // Upheld: conflicted for the meeting exactly as a declaration (Q42–Q44).
      await s.as("committeeSecretary");
      expect(await participant(s, f.participant.lead!)).toEqual({
        coi_status: "CONFLICT_DECLARED",
        attendance: "EXCUSED_CONFLICT",
      });
      const decl = await s.tx<{ declared_by: string; source: string; status: string }[]>`
        select declared_by, source, status from committee.meeting_conflict
        where participant_id = ${f.participant.lead!} order by declared_at`;
      expect(decl).toEqual([
        { declared_by: USERS.lead, source: "SELF", status: "NO_CONFLICT" },
        { declared_by: USERS.committeeChair, source: "DECISION", status: "CONFLICT_DECLARED" },
      ]);
      const [row] = await s.tx<
        { status: string; decided_by: string; decided_as: string; raised_as: string }[]
      >`
        select status, decided_by, decided_as, raised_as from committee.meeting_conflict_concern where id = ${k!.id}`;
      expect(row).toEqual({
        status: "UPHELD",
        decided_by: USERS.committeeChair,
        decided_as: "CHAIR",
        raised_as: "MEMBER",
      });
      await s.as("legal");
      await s.expectError("CDF_CONFLICT:COI_ALREADY_DECLARED", () => raise(s, f.participant.lead!));

      // The vote opens; the subject neither votes nor counts.
      const item = await openItem(s, f.meeting);
      await s.as("lead");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.cast_vote(${item}, 'APPROVE', null)`);
      await voteAndClose(s, item, ["committeeChair", "legal", "legalB"]);
      const [counts] = await s.tx<{ eligible_count: number; present_count: number; result: string }[]>`
        select eligible_count, present_count, result from committee.vote_item where id = ${item}`;
      expect(counts).toEqual({ eligible_count: 3, present_count: 3, result: "APPROVED" });

      // As for a declaration, a later meeting of the proceeding takes no NO_CONFLICT from the subject.
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      const [m2] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${f.committeeProceeding}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '3 days', now() + interval '3 days 1 hour', ${REASON}) as id`;
      const [p2] = await s.tx<{ id: string }[]>`
        select id from committee.meeting_participant where meeting_id = ${m2!.id} and user_id = ${USERS.lead}`;
      await s.as("lead");
      await s.expectError(
        "CDF_CONFLICT:PRIOR_CONFLICT_DECLARED",
        (tx) => tx`select api.declare_meeting_conflict(${p2!.id}, 'NO_CONFLICT', null)`,
      );

      // The ledger has the facts and codes, never a reason.
      await s.asOwner();
      const events = await s.tx<{ action: string; object_type: string; metadata: Record<string, unknown> }[]>`
        select action, object_type, metadata from audit.audit_event
        where action in ('MEETING_CONFLICT_RAISED', 'MEETING_CONFLICT_DECIDED')
           or (action = 'COI_DECLARED' and object_id = ${f.participant.lead!})
        order by seq`;
      expect(events).toEqual([
        {
          action: "COI_DECLARED",
          object_type: "meeting_participant",
          metadata: {
            meeting_id: f.meeting,
            status: "NO_CONFLICT",
            source: "SELF",
            participant_kind: "MEMBER",
          },
        },
        {
          action: "MEETING_CONFLICT_RAISED",
          object_type: "meeting_conflict_concern",
          metadata: {
            meeting_id: f.meeting,
            participant_id: f.participant.lead,
            participant_kind: "MEMBER",
            raised_as: "MEMBER",
          },
        },
        {
          action: "MEETING_CONFLICT_DECIDED",
          object_type: "meeting_conflict_concern",
          metadata: {
            meeting_id: f.meeting,
            participant_id: f.participant.lead,
            decision: "UPHELD",
            decided_as: "CHAIR",
          },
        },
        {
          action: "COI_DECLARED",
          object_type: "meeting_participant",
          metadata: {
            meeting_id: f.meeting,
            status: "CONFLICT_DECLARED",
            source: "DECISION",
            participant_kind: "MEMBER",
          },
        },
      ]);
      const all = await s.tx`select reason, metadata from audit.audit_event where case_id = ${caseB}`;
      expect(JSON.stringify(all)).not.toMatch(/unique-(concern|decision)-marker/);
    });
  });

  it("dismissed changes nothing; nothing is raised or decided mid-vote; the deputy chair decides only when the chair is involved", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s, VOTERS, DEPUTY_SEATS);

      // Not while a vote is in progress.
      const item = await openItem(s, f.meeting);
      await s.as("legal");
      await s.expectError("CDF_CONFLICT:VOTE_IN_PROGRESS", () => raise(s, f.participant.legalB!));
      await voteAndClose(s, item);

      // The chair is not involved: the chair decides, the deputy chair does not even see it.
      await s.as("legal");
      const [k1] = await raise(s, f.participant.legalB!);
      expect(await concernsSeenBy(s, "lead")).toEqual([]);
      await s.as("lead");
      await s.expectError("CDF_NOT_FOUND", () => decide(s, k1!.id, "DISMISSED"));
      await s.as("committeeChair");
      await decide(s, k1!.id, "DISMISSED");
      expect(await participant(s, f.participant.legalB!)).toEqual({
        coi_status: "NO_CONFLICT",
        attendance: "PRESENT",
      });
      await voteAndClose(s, await openItem(s, f.meeting, "Second item (synthetic)"));

      // The chair is the subject: the deputy chair decides; the chair cannot.
      await s.as("legal");
      const [k2] = await raise(s, f.participant.committeeChair!);
      await s.as("committeeChair");
      await s.expectError("CDF_NOT_FOUND", () => decide(s, k2!.id, "DISMISSED"));
      await s.as("lead");
      await decide(s, k2!.id, "DISMISSED");

      // The chair raised it: the deputy chair decides; the chair, who reads it, cannot.
      await s.as("committeeChair");
      const [k3] = await raise(s, f.participant.legal!);
      await s.expectError("CDF_FORBIDDEN", () => decide(s, k3!.id, "DISMISSED"));
      await s.as("lead");
      await decide(s, k3!.id, "DISMISSED");

      await s.asOwner();
      const rows = await s.tx<{ id: string; status: string; decided_as: string }[]>`
        select id, status, decided_as from committee.meeting_conflict_concern where meeting_id = ${f.meeting}
        order by raised_at`;
      expect(rows).toEqual([
        { id: k1!.id, status: "DISMISSED", decided_as: "CHAIR" },
        { id: k2!.id, status: "DISMISSED", decided_as: "DEPUTY_CHAIR" },
        { id: k3!.id, status: "DISMISSED", decided_as: "DEPUTY_CHAIR" },
      ]);

      // The chair raised it about the deputy chair: nobody holds the role, so nobody decides (fail closed) and the
      // votes wait, until the subject declares the conflict themself.
      await s.as("committeeChair");
      const [k4] = await raise(s, f.participant.lead!);
      for (const u of ["committeeChair", "committeeSecretary"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", () => decide(s, k4!.id, "UPHELD"));
      }
      for (const u of ["lead", "legal", "legalB"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", () => decide(s, k4!.id, "UPHELD"));
      }
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:CONFLICT_CONCERN_OPEN",
        (tx) => tx`select api.open_vote_item(${f.meeting}, 'OTHER', null, 'Blocked (synthetic)')`,
      );
      await s.as("lead");
      await s.tx`select api.declare_meeting_conflict(${f.participant.lead!}, 'CONFLICT_DECLARED', 'Synthetic: I agree.')`;
      await openItem(s, f.meeting, "Third item (synthetic)");
    });
  });

  // DEC-F04 (migration 2030, ADR-040) replaced the fail-closed rule of 2000: when the chair
  // cannot decide, the deputy chair stands in, then the configured independent authority.
  it("a chair with a declared conflict does not decide; the deputy chair stands in (DEC-F04)", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s, ["legal", "legalB", "lead"], DEPUTY_SEATS);
      await s.as("committeeChair");
      await s.tx`select api.declare_meeting_conflict(${f.participant.committeeChair!}, 'CONFLICT_DECLARED', 'Synthetic: related.')`;
      await s.as("legal");
      const [k] = await raise(s, f.participant.legalB!);
      await s.as("committeeChair");
      await s.expectError("CDF_NOT_FOUND", () => decide(s, k!.id, "UPHELD"));
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:CONFLICT_CONCERN_OPEN",
        (tx) => tx`select api.open_vote_item(${f.meeting}, 'OTHER', null, 'Blocked (synthetic)')`,
      );
      expect(await concernsSeenBy(s, "lead")).toEqual([k!.id]);
      await s.as("lead");
      await decide(s, k!.id, "DISMISSED");
      await s.asOwner();
      const [row] = await s.tx<{ decided_as: string; decided_by: string }[]>`
        select decided_as, decided_by from committee.meeting_conflict_concern where id = ${k!.id}`;
      expect(row).toEqual({ decided_as: "DEPUTY_CHAIR", decided_by: USERS.lead });
    });
  });

  it("whoever loses case access mid-meeting reads no concern and neither raises nor decides", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s);
      await s.as("legal");
      const [k] = await raise(s, f.participant.lead!);
      expect(await concernsSeenBy(s, "committeeChair")).toEqual([k!.id]);

      // A case conflict recorded for the chair (the decider), the raiser and another member.
      await s.asOwner();
      for (const u of ["committeeChair", "legal", "legalB"] as const) {
        await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                   values (${caseB}, ${USERS[u]}, 'CONFLICT_DECLARED', 'Synthetic declared conflict')`;
      }
      for (const u of ["committeeChair", "legal", "legalB"] as const) {
        expect(await concernsSeenBy(s, u)).toEqual([]);
        await s.expectError("CDF_NOT_FOUND", () => decide(s, k!.id, "UPHELD"));
      }
      await s.as("legalB");
      await s.expectError("CDF_NOT_FOUND", () => raise(s, f.participant.committeeChair!));
      expect(await concernsSeenBy(s, "committeeSecretary")).toEqual([k!.id]);
    });
  });

  it("a concern about the secretary running the meeting is hidden from that secretary; the chair decides it", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s);
      await s.as("legal");
      const [k] = await raise(s, f.participant.committeeSecretary!);
      expect(await concernsSeenBy(s, "committeeSecretary")).toEqual([]);
      for (const d of ["UPHELD", "DISMISSED"]) {
        await s.expectError("CDF_NOT_FOUND", () => decide(s, k!.id, d));
      }
      // The secretary still runs the meeting, and no vote opens while the concern is open.
      await s.expectError(
        "CDF_CONFLICT:CONFLICT_CONCERN_OPEN",
        (tx) => tx`select api.open_vote_item(${f.meeting}, 'OTHER', null, 'Blocked (synthetic)')`,
      );
      expect(await concernsSeenBy(s, "committeeChair")).toEqual([k!.id]);
      await decide(s, k!.id, "DISMISSED");
      expect(await concernsSeenBy(s, "committeeSecretary")).toEqual([]);
      expect(await concernsSeenBy(s, "legal")).toEqual([k!.id]);
    });
  });

  it("a rule set naming the secretary: the secretary decides, unless they raised it", async () => {
    await ownerScenario(async (s) => {
      // Fixture: the rule set in force names the secretary (no command sets it yet; SOURCE_REQUIRED).
      await s.asOwner();
      await s.tx`update committee.rule_set set effective_to = now() where committee_id = ${ic} and effective_to is null`;
      await s.tx`
        insert into committee.rule_set (committee_id, effective_from, quorum_type, casting_vote_enabled,
          minutes_review_business_days, deemed_approval_enabled, conflict_decider, source_status, reason, created_by)
        values (${ic}, now(), 'MAJORITY_ELIGIBLE', true, 3, true, 'SECRETARY', 'SOURCE_REQUIRED', ${REASON}, ${USERS.platformAdmin})`;
      const f = await ready(s);
      const [snap] = await s.tx<{ d: string }[]>`
        select rule_snapshot->>'conflict_decider' as d from committee.committee_proceeding where id = ${f.committeeProceeding}`;
      expect(snap!.d).toBe("SECRETARY");

      await s.as("legal");
      const [k1] = await raise(s, f.participant.lead!);
      await s.as("committeeChair");
      await s.expectError("CDF_NOT_FOUND", () => decide(s, k1!.id, "UPHELD"));
      await s.as("committeeSecretary");
      await decide(s, k1!.id, "DISMISSED");

      // The secretary raised it: no other secretary runs the meeting, so nobody decides.
      const [k2] = await raise(s, f.participant.legal!);
      await s.expectError("CDF_FORBIDDEN", () => decide(s, k2!.id, "UPHELD"));
      await s.as("committeeChair");
      await s.expectError("CDF_NOT_FOUND", () => decide(s, k2!.id, "UPHELD"));

      // A concern about the only secretary: hidden from them, and nobody decides (fail closed).
      await s.as("legal");
      const [k3] = await raise(s, f.participant.committeeSecretary!);
      for (const u of ["committeeSecretary", "committeeChair"] as const) {
        expect(await concernsSeenBy(s, u)).not.toContain(k3!.id);
        await s.expectError("CDF_NOT_FOUND", () => decide(s, k3!.id, "UPHELD"));
      }

      await s.asOwner();
      const rows = await s.tx<{ raised_as: string; status: string; decided_as: string | null }[]>`
        select raised_as, status, decided_as from committee.meeting_conflict_concern where meeting_id = ${f.meeting}
        order by raised_at`;
      expect(rows).toEqual([
        { raised_as: "MEMBER", status: "DISMISSED", decided_as: "SECRETARY" },
        { raised_as: "SECRETARY", status: "OPEN", decided_as: null },
        { raised_as: "MEMBER", status: "OPEN", decided_as: null },
      ]);
    });
  });

  it("a concern is decided once and never rewritten; the meeting and the case must be live", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s);
      await s.as("legal");
      const [k] = await raise(s, f.participant.lead!);
      await s.as("committeeChair");
      await decide(s, k!.id, "DISMISSED");

      await s.asOwner();
      await s.expectError(
        "",
        (tx) => tx`update committee.meeting_conflict_concern set status = 'UPHELD' where id = ${k!.id}`,
      );
      await s.expectError("", (tx) => tx`delete from committee.meeting_conflict_concern where id = ${k!.id}`);
      await s.expectError(
        "",
        (tx) => tx`update committee.rule_set set conflict_decider = 'SECRETARY' where committee_id = ${ic}`,
      );
      await s.expectError(
        "",
        (
          tx,
        ) => tx`insert into committee.rule_set (committee_id, effective_from, quorum_type, casting_vote_enabled,
            minutes_review_business_days, deemed_approval_enabled, conflict_decider, source_status)
          values (${ic}, now() + interval '10 years', 'MAJORITY_ELIGIBLE', true, 3, true, 'COMMITTEE', 'OWNER_DEFAULT')`,
      );
      // The raiser never decides, even for the owner.
      await s.as("legal");
      const [k2] = await raise(s, f.participant.legalB!);
      await s.asOwner();
      await s.expectError(
        "",
        (tx) => tx`update committee.meeting_conflict_concern
          set status = 'DISMISSED', decided_by = raised_by, decided_as = 'CHAIR', decision_reason = ${DECISION}, decided_at = now()
          where id = ${k2!.id}`,
      );

      // A subject who declares the conflict themself no longer holds the votes up; the decision waits for the vote,
      // and upholding then adds nothing to a declaration that is already final.
      await s.as("legalB");
      await s.tx`select api.declare_meeting_conflict(${f.participant.legalB!}, 'CONFLICT_DECLARED', 'Synthetic: related.')`;
      const item = await openItem(s, f.meeting);
      await s.as("committeeChair");
      await s.expectError("CDF_CONFLICT:VOTE_IN_PROGRESS", () => decide(s, k2!.id, "UPHELD"));
      await voteAndClose(s, item, ["committeeChair", "legal", "lead"]);
      await s.as("committeeChair");
      await decide(s, k2!.id, "UPHELD");
      await s.as("committeeSecretary");
      const decl = await s.tx<{ source: string; status: string }[]>`
        select source, status from committee.meeting_conflict where participant_id = ${f.participant.legalB!}
        order by declared_at`;
      expect(decl).toEqual([
        { source: "SELF", status: "NO_CONFLICT" },
        { source: "SELF", status: "CONFLICT_DECLARED" },
      ]);

      // A meeting that is closed takes no concern and no decision.
      await s.as("legal");
      const [k3] = await raise(s, f.participant.lead!);
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      await s.as("committeeChair");
      await s.expectError("CDF_CONFLICT:MEETING_NOT_ACTIVE", () => decide(s, k3!.id, "DISMISSED"));
      await s.as("legal");
      await s.expectError("CDF_CONFLICT:MEETING_NOT_ACTIVE", () => raise(s, f.participant.committeeChair!));

      // Nor does a case that is no longer active.
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', ${REASON})`;
      await s.as("legal");
      await s.expectError("CDF_CONFLICT:CASE_NOT_ACTIVE", () => raise(s, f.participant.committeeChair!));
      await s.as("committeeChair");
      await s.expectError("CDF_CONFLICT:CASE_NOT_ACTIVE", () => decide(s, k3!.id, "DISMISSED"));
    });
  });

  it("the catalogue follows: P11-G6 is closed, T3-B1.2-050's case half is P11-G7, and the modules record 2000", async () => {
    await scenario(async (s) => {
      await s.as("committeeChair");
      const forms = await s.tx<{ legacy_id: string; merge_target: string; gap_ref: string | null }[]>`
        select legacy_id, merge_target, gap_ref from config.legacy_form_map
        where legacy_id in ('T7-B1.2-048', 'T3-B1.2-050') order by legacy_id`;
      expect(forms.map((r) => [r.legacy_id, r.gap_ref])).toEqual([
        ["T3-B1.2-050", "P11-G7"],
        ["T7-B1.2-048", null],
      ]);
      expect(forms[0]!.merge_target).toContain("api.raise_meeting_conflict + api.decide_meeting_conflict");
      expect(forms[1]!.merge_target).toContain("api.record_excused_absence");
      const [refs] = await s.tx<{ n: number }[]>`
        select (select count(*) from config.legacy_form_map where gap_ref = 'P11-G6')
             + (select count(*) from config.legacy_status_map where gap_ref = 'P11-G6') as n`;
      expect(Number(refs!.n)).toBe(0);
      const modules = await s.tx<{ code: string; commands: string[]; delivered_in: string[] }[]>`
        select code, commands, delivered_in from config.target_module
        where code in ('MEETING', 'MEETING_HEARING', 'MEETING_COI') order by code`;
      for (const m of modules) expect(m.delivered_in, m.code).toContain("2000");
      expect(modules.find((m) => m.code === "MEETING_COI")!.commands).toEqual([
        "api.declare_meeting_conflict",
        "api.raise_meeting_conflict",
        "api.decide_meeting_conflict",
      ]);
      expect(modules.find((m) => m.code === "MEETING_HEARING")!.commands).toContain(
        "api.record_excused_absence",
      );
      expect(modules.find((m) => m.code === "MEETING")!.commands).toContain("api.record_excused_absence");
    });
  });
});

describe("an upheld conflict and its reversal (T-AMB-032, DEC-F38, DEC-AMB-010, migration 2030)", () => {
  const raiseAbout = (s: Scenario, participant: string) =>
    s.tx<
      { id: string }[]
    >`select api.raise_meeting_conflict(${participant}, 'Synthetic: a concern about a member.') as id`;
  const decideAs = (tx: Scenario["tx"], concern: string, decision: string) =>
    tx`select api.decide_meeting_conflict(${concern}, ${decision}, 'Synthetic: decided on the record.')`;
  const reverse =
    (concern: string, reason = "Synthetic: the link was misread; no conflict.") =>
    (tx: Scenario["tx"]) =>
      tx`select api.reverse_meeting_conflict_determination(${concern}, ${reason})`;

  async function auditMetadata(s: OwnerScenario, action: string) {
    await s.asOwner();
    return s.tx<{ actor_id: string; metadata: Record<string, unknown>; reason: string | null }[]>`
      select actor_id, metadata, reason from audit.audit_event where action = ${action} order by seq`;
  }

  async function laterMeeting(s: Scenario, f: MeetingFixture, user: UserKey): Promise<string> {
    await s.as("committeeSecretary");
    const [m2] = await s.tx<{ id: string }[]>`
      select api.schedule_meeting(${f.committeeProceeding}, 'HEARING', 'IN_PERSON', 'Room (synthetic)', null,
        now() + interval '2 days', now() + interval '2 days 1 hour', ${REASON}) as id`;
    const [p] = await s.tx<{ id: string }[]>`
      select id from committee.meeting_participant where meeting_id = ${m2!.id} and user_id = ${USERS[user]}`;
    return p!.id;
  }

  it("holds for the proceeding until the next decider reverses it; the reversal is prospective only", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s, VOTERS, DEPUTY_SEATS);
      await s.as("legal");
      const [dismissed] = await raiseAbout(s, f.participant.lead!);
      await s.as("committeeChair");
      await decideAs(s.tx, dismissed!.id, "DISMISSED");
      await s.as("legal");
      const [k] = await raiseAbout(s, f.participant.legalB!);
      await s.as("committeeChair");
      await decideAs(s.tx, k!.id, "UPHELD");

      // A later meeting of the same proceeding: no "no conflict" while the determination stands.
      const p2 = await laterMeeting(s, f, "legalB");
      await s.as("legalB");
      await s.expectError(
        "CDF_CONFLICT:PRIOR_CONFLICT_DECLARED",
        (tx) => tx`select api.declare_meeting_conflict(${p2}, 'NO_CONFLICT', null)`,
      );

      // Only the next decider in the DEC-F04 order: never the subject, the raiser, the deciding chair or the secretary.
      for (const u of ["legalB", "employee", "investigatorA"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", reverse(k!.id));
      }
      for (const u of ["legal", "committeeChair", "committeeSecretary"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", reverse(k!.id));
      }
      await s.as("legal");
      await s.expectError("CDF_CONFLICT:NOT_UPHELD", reverse(dismissed!.id));
      await s.as("lead");
      await s.expectError("CDF_INVALID:reason", reverse(k!.id, "short"));
      await reverse(k!.id)(s.tx);
      await s.expectError("CDF_CONFLICT:ALREADY_REVERSED", reverse(k!.id));

      // Later meetings only: the member declares again there; the meeting of the determination keeps them conflicted.
      await s.as("legalB");
      await s.tx`select api.declare_meeting_conflict(${p2}, 'NO_CONFLICT', null)`;
      await s.asOwner();
      expect(
        await s.tx`select coi_status from committee.meeting_participant where id = ${f.participant.legalB!}`,
      ).toEqual([{ coi_status: "CONFLICT_DECLARED" }]);
      const reversed = await auditMetadata(s, "MEETING_CONFLICT_REVERSED");
      expect(
        reversed.map((e) => [e.actor_id, e.metadata.reversed_as, e.metadata.decided_as, e.reason]),
      ).toEqual([[USERS.lead, "DEPUTY_CHAIR", "CHAIR", null]]);
      // The subject still reads neither the concern nor its reversal.
      await s.as("legalB");
      expect(await s.tx`select id from committee.meeting_conflict_reversal`).toEqual([]);
      expect(await s.tx`select id from committee.meeting_conflict_concern`).toEqual([]);
    });
  });

  it("with no eligible decider after the original one, nobody reverses (fail closed) until an authority is appointed", async () => {
    await scenario(async (s) => {
      const f = await ready(s, VOTERS, DEPUTY_SEATS);
      await s.as("committeeChair");
      await s.tx`select api.declare_meeting_conflict(${f.participant.committeeChair!}, 'CONFLICT_DECLARED', 'Synthetic: related.')`;
      await s.as("legal");
      const [k] = await raiseAbout(s, f.participant.legalB!);
      await s.as("lead");
      await decideAs(s.tx, k!.id, "UPHELD");
      for (const u of ["lead", "committeeChair", "legal"] as const) {
        await s.as(u);
        await s.expectError(u === "committeeChair" ? "CDF_NOT_FOUND" : "CDF_FORBIDDEN", reverse(k!.id));
      }
      await s.as("platformAdmin");
      await s.tx`select api.appoint_conflict_authority(${ic}, ${USERS.complianceManager}, now(), null, 'DEMO-CA-03', 'SOURCE_REQUIRED', ${REASON})`;
      await s.as("complianceManager");
      await reverse(k!.id)(s.tx);
      expect(
        await s.tx`select reversed_as from committee.meeting_conflict_reversal where concern_id = ${k!.id}`,
      ).toEqual([{ reversed_as: "CONFLICT_AUTHORITY" }]);
    });
  });

  it("reversing one upheld concern never clears a conflict that rests on another (AGENT-09 early look, note a)", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s, VOTERS, DEPUTY_SEATS);
      await s.as("legal");
      const [k] = await raiseAbout(s, f.participant.legalB!);
      await s.as("committeeChair");
      await decideAs(s.tx, k!.id, "UPHELD");
      // Today no second concern is raised about a conflicted member (COI_ALREADY_DECLARED). Should that change, the
      // conflict written by a second upheld concern still counts after the first is reversed.
      await s.asOwner();
      const [k2] = await s.tx<{ id: string }[]>`
        insert into committee.meeting_conflict_concern
          (meeting_id, participant_id, raised_by, raised_as, reason, status, decided_by, decided_as, decision_reason, decided_at)
        values (${f.meeting}, ${f.participant.legalB!}, ${USERS.committeeSecretary}, 'SECRETARY',
                'Synthetic: a second concern.', 'UPHELD', ${USERS.committeeChair}, 'CHAIR',
                'Synthetic: decided on the record.', now())
        returning id`;
      const conflictRow =
        (participant: string, source: string, concern: string | null) => (tx: Scenario["tx"]) =>
          tx`insert into committee.meeting_conflict (meeting_id, participant_id, status, declared_by, source, reason, concern_id)
           values (${f.meeting}, ${participant}, 'CONFLICT_DECLARED', ${USERS.committeeChair}, ${source},
                   'Synthetic: decided on the record.', ${concern})`;
      // A conflict row names a concern only when it is a decision, only that concern's subject, and always when it is one.
      await s.expectError("insert or update on table", conflictRow(f.participant.lead!, "DECISION", k2!.id));
      await s.expectError("new row for relation", conflictRow(f.participant.legalB!, "SELF", k2!.id));
      await s.expectError("new row for relation", conflictRow(f.participant.legalB!, "DECISION", null));
      await conflictRow(f.participant.legalB!, "DECISION", k2!.id)(s.tx);

      await s.as("lead");
      await reverse(k!.id)(s.tx);
      const p2 = await laterMeeting(s, f, "legalB");
      await s.as("legalB");
      await s.expectError(
        "CDF_CONFLICT:PRIOR_CONFLICT_DECLARED",
        (tx) => tx`select api.declare_meeting_conflict(${p2}, 'NO_CONFLICT', null)`,
      );
    });
  });
});
