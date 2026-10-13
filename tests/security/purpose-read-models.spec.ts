// Business architecture rebase, migration 2030 section 4 (ADR-040; DEC-02, DEC-F01, DEC-F04, DEC-F07;
// AMB-083; Phase 12 asks §6 (b), (c), (d)): purpose read models for a meeting and its minutes, the two meeting
// notifications, and the synthetic committee seats of the demo seed. The reads never open the case: each part follows
// the predicate of the table it comes from (logistics, own row, roster, deliberation, concern, minutes), the case is
// named only to whoever may see its metadata, and no individual choice or vote note ever appears. Every capability is
// checked against its command: offered, the command succeeds; withheld, the command refuses. The notifications carry
// ids only and reach exactly the decider of a raised conflict, or the members who may cast an opened vote. Every step
// runs through the api.* commands as `authenticated`; the owner connection only reads the outbox and sets fixtures.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  USERS,
  admin,
  caseId,
  ownerScenario,
  scenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import {
  DEMO_SEAT_REFERENCE,
  IC_SEATS,
  REASON,
  committeeIds,
  openItem,
  openWithPresent,
  preliminaryReferral,
  scheduleMeeting,
  seat,
  unseatDemoSeats,
  vote,
  type MeetingFixture,
} from "../support/committee";

const CONCERN = "Synthetic: unique-concern-marker-2036, reports to the subject.";
const DECISION = "Synthetic: unique-decision-marker-2036, the link is direct.";
const NOTE = "Synthetic: unique-note-marker-2036, a dissent.";
const TITLE = "Synthetic item unique-title-marker-2036";
const EXCLUSION = "Synthetic: unique-exclusion-marker-2036, the witness approached a member.";

let caseB: string, caseNumberB: string, caseText: string[], ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
  const [c] = await admin<{ case_number: string; title: string; summary: string | null }[]>`
    select case_number, title, summary from case_mgmt.case_record where id = ${caseB}`;
  caseNumberB = c!.case_number;
  caseText = [c!.title, c!.summary].filter((t): t is string => !!t && t.length > 8);
});

const VOTERS: UserKey[] = ["committeeChair", "legal", "legalB", "lead"];
/** As IC_SEATS, with lead as deputy chair. */
const DEPUTY_SEATS: [UserKey, string][] = IC_SEATS.map(([u, s]) => [u, u === "lead" ? "DEPUTY_CHAIR" : s]);
const BY_ID = Object.fromEntries(Object.entries(USERS).map(([k, v]) => [v, k])) as Record<string, UserKey>;

const TOP_KEYS = [
  "acting_roles",
  "capabilities",
  "case",
  "committee",
  "committee_proceeding_id",
  "concerns",
  "deliberation",
  "logistics",
  "me",
  "meeting_id",
  "minutes",
  "roster",
];
const MEETING_CAPABILITIES = [
  "can_manage",
  "may_acknowledge_confidentiality",
  "may_cancel",
  "may_close",
  "may_declare_conflict",
  "may_declare_no_conflict",
  "may_generate_minutes",
  "may_open",
  "may_open_vote",
  "may_raise_concern",
];
const MINUTES_KEYS = [
  "capabilities",
  "case",
  "deemed_approval_enabled",
  "finalised_at",
  "generated_at",
  "i_have_reviewed",
  "meeting",
  "meeting_id",
  "minutes_id",
  "narrative",
  "objection_rulings",
  "reminder_sent_at",
  "review_business_days",
  "review_due_at",
  "reviewer_count",
  "reviews",
  "snapshot",
  "status",
  "version_no",
];
/** Columns of case_mgmt.case_record that are case content: none may appear as a key anywhere in a read model. */
const CASE_CONTENT = [
  "case_type",
  "summary",
  "classification",
  "is_restricted",
  "source",
  "source_type",
  "source_report_id",
  "reporter_wb_id",
  "priority",
  "identity_reveal_requires_approval",
  "owner_id",
  "retention_class",
  "legal_hold_status",
  "records_state",
  "allegations",
  "subjects",
  "evidence",
];

type Caps = Record<string, boolean>;
interface MeetingView {
  meeting_id: string;
  committee_proceeding_id: string;
  committee: { committee_id: string; code: string; kind: string };
  case: { case_id: string | null; case_number: string | null };
  logistics: Record<string, unknown>;
  me: Record<string, unknown> | null;
  roster: { participant_id: string; user_id: string | null; display_name: string | null }[] | null;
  deliberation: {
    ballot_secrecy: string;
    quorum: Record<string, unknown> | null;
    vote_items: {
      vote_item_id: string;
      title: string;
      status: string;
      result: string | null;
      tally: Record<string, number> | null;
      i_have_voted: boolean;
      capabilities: Caps;
    }[];
    witness_exclusions: { participant_id: string; reason: string }[];
  } | null;
  concerns: {
    concern_id: string;
    status: string;
    reason: string;
    decided_as: string | null;
    reversal: unknown;
    capabilities: Caps;
  }[];
  acting_roles: unknown[];
  minutes: { minutes_id: string; version_no: number; status: string }[];
  capabilities: Caps;
}
interface MinutesView {
  minutes_id: string;
  status: string;
  case: { case_id: string | null; case_number: string | null };
  meeting: Record<string, unknown> | null;
  reviews: unknown[] | null;
  objection_rulings: { ruled_as: string }[] | null;
  i_have_reviewed: boolean | null;
  capabilities: Caps;
}

/** Every key at any depth, except inside the named opaque fields (the minutes snapshot). */
function keysDeep(value: unknown, opaque: string[] = []): Set<string> {
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, child] of Object.entries(v)) {
        keys.add(k);
        if (!opaque.includes(k)) walk(child);
      }
  };
  walk(value);
  return keys;
}

function expectBooleans(caps: Caps, where: string) {
  for (const [k, v] of Object.entries(caps)) expect(typeof v, `${where} ${k}`).toBe("boolean");
}

async function meetingView(s: Scenario, user: UserKey, meeting: string): Promise<MeetingView> {
  await s.as(user);
  const [r] = await s.tx<{ v: MeetingView }[]>`select api.meeting_view(${meeting}) as v`;
  const v = r!.v;
  expect(Object.keys(v).sort(), user).toEqual(TOP_KEYS);
  expect(Object.keys(v.capabilities).sort(), user).toEqual(MEETING_CAPABILITIES);
  expectBooleans(v.capabilities, user);
  for (const i of v.deliberation?.vote_items ?? []) expectBooleans(i.capabilities, `${user} vote item`);
  for (const c of v.concerns) expectBooleans(c.capabilities, `${user} concern`);
  return v;
}

interface ConcernOnlyView {
  meeting_id: string;
  status: string;
  case: { case_id: string | null; case_number: string | null };
  concerns: MeetingView["concerns"];
}
const CONCERN_KEYS = [
  "capabilities",
  "concern_id",
  "decided_as",
  "decided_at",
  "decided_by",
  "decision_reason",
  "participant_id",
  "raised_as",
  "raised_at",
  "raised_by",
  "reason",
  "reversal",
  "status",
];
/** Every key the concern-only view may hold, at any depth: nothing of logistics, roster, votes or minutes. */
const CONCERN_ONLY_KEYS = new Set([
  "meeting_id",
  "status",
  "case",
  "case_id",
  "case_number",
  "concerns",
  ...CONCERN_KEYS,
  "may_decide",
  "may_reverse",
  "reversal_id",
  "reversed_by",
  "reversed_as",
  "reversed_at",
]);

/** The concern-only view (DEC-F04): the meeting's id and status, the case, and the concerns the caller may see. */
async function concernOnlyView(s: Scenario, user: UserKey, meeting: string): Promise<ConcernOnlyView> {
  await s.as(user);
  const [r] = await s.tx<{ v: ConcernOnlyView }[]>`select api.meeting_view(${meeting}) as v`;
  const v = r!.v;
  expect(Object.keys(v).sort(), user).toEqual(["case", "concerns", "meeting_id", "status"]);
  expect(
    [...keysDeep(v)].filter((k) => !CONCERN_ONLY_KEYS.has(k)),
    user,
  ).toEqual([]);
  for (const c of v.concerns) {
    expect(Object.keys(c).sort(), user).toEqual(CONCERN_KEYS);
    expect(Object.keys(c.capabilities).sort(), user).toEqual(["may_decide", "may_reverse"]);
    expectBooleans(c.capabilities, `${user} concern`);
  }
  expectNoCaseContent(v);
  // The case is named only under its metadata predicate, as in the full view.
  const [m] = await s.tx<{ ok: boolean }[]>`select authz.can_view_case_metadata(${caseB}) as ok`;
  expect(v.case, user).toEqual(
    m!.ok ? { case_id: caseB, case_number: caseNumberB } : { case_id: null, case_number: null },
  );
  return v;
}

async function minutesView(s: Scenario, user: UserKey, minutes: string): Promise<MinutesView> {
  await s.as(user);
  const [r] = await s.tx<{ v: MinutesView }[]>`select api.minutes_view(${minutes}) as v`;
  const v = r!.v;
  expect(Object.keys(v).sort(), user).toEqual(MINUTES_KEYS);
  expect(Object.keys(v.capabilities).sort(), user).toEqual([
    "may_apply_deemed_approval",
    "may_overrule_objection",
    "may_remind",
    "may_review",
  ]);
  expectBooleans(v.capabilities, user);
  return v;
}

/** No case content: the case object holds its id and number only, no key names a case column, no case text. */
function expectNoCaseContent(v: object, opaque: string[] = []) {
  expect(Object.keys((v as { case: object }).case).sort()).toEqual(["case_id", "case_number"]);
  expect([...keysDeep(v, opaque)].filter((k) => CASE_CONTENT.includes(k))).toEqual([]);
  for (const t of caseText) expect(JSON.stringify(v)).not.toContain(t);
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

/** Changes the committee's rule set from now, before the referral snapshots it. */
async function rule(s: Scenario, changes: Record<string, unknown>): Promise<void> {
  await s.as("platformAdmin");
  await s.tx`select api.revise_committee_rule_set(${ic}, now(), ${s.tx.json(changes as never)}, 'SOURCE_REQUIRED', ${REASON})`;
}

async function invite(s: Scenario, meeting: string, user: string): Promise<string> {
  await s.as("committeeSecretary");
  const [r] = await s.tx<{ id: string }[]>`
    select api.invite_to_meeting(${meeting}, 'WITNESS', ${user}, null, true, ${REASON}) as id`;
  return r!.id;
}

const raise = async (tx: Scenario["tx"], participant: string) =>
  (await tx<{ id: string }[]>`select api.raise_meeting_conflict(${participant}, ${CONCERN}) as id`)[0]!.id;
const decide = (tx: Scenario["tx"], concern: string, decision: string) =>
  tx`select api.decide_meeting_conflict(${concern}, ${decision}, ${DECISION})`;
const reverse = (tx: Scenario["tx"], concern: string) =>
  tx`select api.reverse_meeting_conflict_determination(${concern}, 'Synthetic: the determination was wrong.')`;

async function closeAndGenerate(s: Scenario, f: MeetingFixture): Promise<string> {
  await s.as("committeeSecretary");
  await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
  const [mi] = await s.tx<{ id: string }[]>`
    select api.generate_minutes(${f.meeting}, 'Synthetic minutes for the read model test.') as id`;
  return mi!.id;
}

describe("api.meeting_view: each part under its own predicate (DEC-02)", () => {
  it("outsiders, unknown ids and revoked users get NOT_FOUND; anonymous callers cannot call it", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      for (const u of [
        "investigatorA",
        "platformAdmin",
        "employee",
        "internalAudit",
        "dpo",
        "revoked",
      ] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.meeting_view(${f.meeting})`);
      }
      await s.as("committeeSecretary");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.meeting_view(${randomUUID()})`);
      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select api.meeting_view(${f.meeting})`);
    });
  });

  it("a witness sees the logistics and their own row; a member the roster, and the deliberation once cleared", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const w = await invite(s, f.meeting, USERS.employeeB);

      const wv = await meetingView(s, "employeeB", f.meeting);
      expect(wv.logistics).toMatchObject({
        status: "SCHEDULED",
        purpose: "DELIBERATION",
        mode: "IN_PERSON",
        location: "Meeting room (synthetic)",
        online_url: null,
      });
      expect(wv.logistics).not.toHaveProperty("emergency_reason");
      expect(wv.me).toMatchObject({
        participant_id: w,
        participant_kind: "INVITEE",
        invitee_role: "WITNESS",
        coi_status: "PENDING",
        confidentiality_ack_required: true,
        confidentiality_acknowledged: false,
      });
      expect(wv).toMatchObject({
        roster: null,
        deliberation: null,
        concerns: [],
        acting_roles: [],
        minutes: [],
        case: { case_id: null, case_number: null },
        committee: { committee_id: ic, code: "IC", kind: "INVESTIGATION" },
      });

      // A member who has not declared yet: the roster, not the deliberation.
      let lv = await meetingView(s, "legal", f.meeting);
      expect(lv.roster!.map((r) => r.participant_id).sort()).toEqual(
        [...Object.values(f.participant), w].sort(),
      );
      expect(lv.roster!.find((r) => r.participant_id === w)!.display_name).toBe("Employee Phi");
      expect(lv.deliberation).toBeNull();
      expect(lv.case).toEqual({ case_id: null, case_number: null });
      await s.tx`select api.declare_meeting_conflict(${f.participant.legal!}, 'NO_CONFLICT', null)`;
      lv = await meetingView(s, "legal", f.meeting);
      expect(lv.deliberation).toMatchObject({
        ballot_secrecy: "COMMITTEE_AFTER_CLOSE",
        quorum: { quorum_type: "MAJORITY_ELIGIBLE", eligible: 1, present: 0 },
        vote_items: [],
        witness_exclusions: [],
      });

      // The case team: the roster and the case number; no deliberation, no place, nothing to run.
      const cm = await meetingView(s, "caseManager", f.meeting);
      expect(cm.case).toEqual({ case_id: caseB, case_number: caseNumberB });
      expect(cm).toMatchObject({ me: null, deliberation: null });
      expect(cm.roster).toHaveLength(lv.roster!.length);
      expect(Object.values(cm.capabilities).every((c) => c === false)).toBe(true);

      const sv = await meetingView(s, "committeeSecretary", f.meeting);
      for (const v of [wv, lv, cm, sv]) expectNoCaseContent(v);
    });
  });

  it("an excluded witness loses the meeting and its minutes; the deliberation shows the exclusion and its reason", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const w = await invite(s, f.meeting, USERS.employeeB);
      await openWithPresent(s, f, VOTERS);
      await s.as("committeeSecretary");
      await s.tx`select api.exclude_meeting_witness(${w}, ${EXCLUSION})`;
      await s.as("employeeB");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.meeting_view(${f.meeting})`);
      for (const u of ["committeeSecretary", "legal"] as const) {
        const v = await meetingView(s, u, f.meeting);
        expect(v.deliberation!.witness_exclusions).toEqual([
          expect.objectContaining({ participant_id: w, reason: EXCLUSION }),
        ]);
      }
      // The case team runs no deliberation: no reason.
      expect(JSON.stringify(await meetingView(s, "caseManager", f.meeting))).not.toContain(
        "unique-exclusion-marker-2036",
      );
      const minutes = await closeAndGenerate(s, f);
      await s.as("employeeB");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.minutes_view(${minutes})`);
    });
  });

  it("a concern reaches the raiser, the secretary and the decider, never its subject; may_decide matches the command", async () => {
    await scenario(async (s) => {
      const f = await ready(s);
      await s.as("legal");
      const k = await raise(s.tx, f.participant.legalB!);

      // The subject, a member who neither raised nor decides, and the case team see no concern.
      for (const u of ["legalB", "lead", "caseManager"] as const) {
        expect((await meetingView(s, u, f.meeting)).concerns, u).toEqual([]);
      }
      const raiser = await meetingView(s, "legal", f.meeting);
      expect(raiser.concerns).toEqual([
        expect.objectContaining({
          concern_id: k,
          participant_id: f.participant.legalB,
          reason: CONCERN,
          status: "OPEN",
          reversal: null,
          capabilities: { may_decide: false, may_reverse: false },
        }),
      ]);
      await s.expectError("CDF_FORBIDDEN", (tx) => decide(tx, k, "DISMISSED"));

      // The secretary sees it, may not decide it, and may not open a vote while it is open.
      const sec = await meetingView(s, "committeeSecretary", f.meeting);
      expect(sec.concerns[0]!.capabilities).toEqual({ may_decide: false, may_reverse: false });
      expect(sec.capabilities.may_open_vote).toBe(false);
      await s.expectError("CDF_FORBIDDEN", (tx) => decide(tx, k, "DISMISSED"));
      await s.expectError(
        "CDF_CONFLICT:CONFLICT_CONCERN_OPEN",
        (tx) => tx`select api.open_vote_item(${f.meeting}, 'OTHER', null, ${TITLE})`,
      );

      // The chair decides (DEC-F04).
      const chair = await meetingView(s, "committeeChair", f.meeting);
      expect(chair.concerns[0]!.capabilities).toEqual({ may_decide: true, may_reverse: false });
      await decide(s.tx, k, "DISMISSED");
      const decided = await meetingView(s, "committeeChair", f.meeting);
      expect(decided.concerns[0]).toMatchObject({ status: "DISMISSED", decision_reason: DECISION });
      expect(decided.concerns[0]!.capabilities.may_decide).toBe(false);
      await s.expectError("CDF_CONFLICT:NOTHING_TO_DECIDE", (tx) => decide(tx, k, "UPHELD"));

      expect((await meetingView(s, "committeeSecretary", f.meeting)).capabilities.may_open_vote).toBe(true);
      await openItem(s, f.meeting, TITLE);
      expect((await meetingView(s, "legalB", f.meeting)).concerns).toEqual([]);
    });
  });

  it("an upheld concern is reversible by the next decider only (DEC-AMB-010); may_reverse matches the command", async () => {
    await scenario(async (s) => {
      const f = await ready(s, VOTERS, DEPUTY_SEATS);
      await s.as("legal");
      const k = await raise(s.tx, f.participant.legalB!);
      await s.as("committeeChair");
      await decide(s.tx, k, "UPHELD");

      const chair = await meetingView(s, "committeeChair", f.meeting);
      expect(chair.concerns[0]!.capabilities).toEqual({ may_decide: false, may_reverse: false });
      await s.expectError("CDF_FORBIDDEN", (tx) => reverse(tx, k));
      // The deputy, who could not decide it, sees it as its next decider and may reverse it.
      const deputy = await meetingView(s, "lead", f.meeting);
      expect(deputy.concerns[0]).toMatchObject({
        status: "UPHELD",
        reversal: null,
        capabilities: { may_decide: false, may_reverse: true },
      });
      await reverse(s.tx, k);
      const after = await meetingView(s, "lead", f.meeting);
      expect(after.concerns[0]).toMatchObject({
        reversal: expect.objectContaining({ reversed_as: "DEPUTY_CHAIR", reversed_by: USERS.lead }),
        capabilities: { may_decide: false, may_reverse: false },
      });
      await s.expectError("CDF_CONFLICT:ALREADY_REVERSED", (tx) => reverse(tx, k));
      // The subject still learns nothing of it.
      expect((await meetingView(s, "legalB", f.meeting)).concerns).toEqual([]);
    });
  });

  it("running the meeting: open, cancel, close and minutes are offered exactly when their commands accept", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      // The chair does not run the meeting.
      const chair = await meetingView(s, "committeeChair", f.meeting);
      expect(Object.entries(chair.capabilities).filter(([, v]) => v)).toEqual([
        ["may_declare_conflict", true],
        ["may_declare_no_conflict", true],
      ]);
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.open_meeting(${f.meeting}, ${REASON})`);
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.cancel_meeting(${f.meeting}, ${REASON})`);

      let v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v.capabilities).toMatchObject({
        can_manage: true,
        may_open: true,
        may_cancel: true,
        may_close: false,
        may_open_vote: false,
        may_generate_minutes: false,
      });
      await s.expectError(
        "CDF_CONFLICT:MEETING_NOT_OPEN",
        (tx) => tx`select api.close_meeting(${f.meeting}, ${REASON})`,
      );
      await s.expectError(
        "CDF_CONFLICT:MEETING_NOT_OPEN",
        (tx) => tx`select api.open_vote_item(${f.meeting}, 'OTHER', null, ${TITLE})`,
      );
      await openWithPresent(s, f, VOTERS);
      v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v.capabilities).toMatchObject({
        may_open: false,
        may_cancel: false,
        may_close: true,
        may_open_vote: true,
      });
      await s.expectError(
        "CDF_CONFLICT:MEETING_NOT_SCHEDULED",
        (tx) => tx`select api.open_meeting(${f.meeting}, ${REASON})`,
      );
      await s.expectError(
        "CDF_CONFLICT:MEETING_NOT_SCHEDULED",
        (tx) => tx`select api.cancel_meeting(${f.meeting}, ${REASON})`,
      );

      const item = await openItem(s, f.meeting, TITLE);
      v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v.capabilities.may_close).toBe(false);
      await s.expectError(
        "CDF_CONFLICT:VOTES_OPEN",
        (tx) => tx`select api.close_meeting(${f.meeting}, ${REASON})`,
      );
      for (const u of VOTERS) await vote(s, u, item, "APPROVE");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item}, null)`;
      v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v.capabilities).toMatchObject({ may_close: true, may_generate_minutes: false });
      await s.expectError(
        "CDF_CONFLICT:MEETING_NOT_CLOSED",
        (tx) => tx`select api.generate_minutes(${f.meeting}, 'Synthetic minutes, too early.')`,
      );
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v.capabilities).toMatchObject({
        may_close: false,
        may_open_vote: false,
        may_generate_minutes: true,
      });
      await s.tx`select api.generate_minutes(${f.meeting}, 'Synthetic minutes for the capability test.')`;
      v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v.capabilities.may_generate_minutes).toBe(false);
      expect(v.minutes).toEqual([expect.objectContaining({ version_no: 1, status: "IN_REVIEW" })]);
      await s.expectError(
        "CDF_CONFLICT:MINUTES_EXIST",
        (tx) => tx`select api.generate_minutes(${f.meeting}, 'Synthetic minutes, a second time.')`,
      );
    });
  });

  it("a vote is offered only with quorum (AMB-067)", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      for (const u of VOTERS) {
        await s.as(u);
        await s.tx`select api.declare_meeting_conflict(${f.participant[u]!}, 'NO_CONFLICT', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
      await s.tx`select api.record_attendance(${f.participant.committeeChair!}, 'PRESENT')`;
      let v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v.deliberation!.quorum).toEqual({
        quorum_type: "MAJORITY_ELIGIBLE",
        eligible: 4,
        present: 1,
        required: 3,
      });
      expect(v.capabilities.may_open_vote).toBe(false);
      await s.expectError(
        "CDF_CONFLICT:NO_QUORUM",
        (tx) => tx`select api.open_vote_item(${f.meeting}, 'OTHER', null, ${TITLE})`,
      );
      for (const u of ["legal", "legalB"] as const) {
        await s.tx`select api.record_attendance(${f.participant[u]!}, 'PRESENT')`;
      }
      v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v.capabilities.may_open_vote).toBe(true);
      await s.tx`select api.open_vote_item(${f.meeting}, 'OTHER', null, ${TITLE})`;
    });
  });

  it("the caller's own row: confidentiality, declarations and raising a concern match their commands", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const w = await invite(s, f.meeting, USERS.employeeB);
      let v = await meetingView(s, "employeeB", f.meeting);
      expect(v.capabilities).toMatchObject({
        may_acknowledge_confidentiality: true,
        may_declare_conflict: true,
        may_declare_no_conflict: true,
        may_raise_concern: false,
      });
      await s.expectError("CDF_FORBIDDEN", (tx) => raise(tx, f.participant.legal!));
      await s.tx`select api.acknowledge_meeting_confidentiality(${w})`;
      await s.tx`select api.declare_meeting_conflict(${w}, 'NO_CONFLICT', null)`;
      v = await meetingView(s, "employeeB", f.meeting);
      expect(v.me).toMatchObject({ coi_status: "NO_CONFLICT", confidentiality_acknowledged: true });
      expect(v.capabilities).toMatchObject({
        may_acknowledge_confidentiality: false,
        may_declare_no_conflict: false,
        may_declare_conflict: true,
      });
      await s.expectError(
        "CDF_CONFLICT:ALREADY_ACKNOWLEDGED",
        (tx) => tx`select api.acknowledge_meeting_confidentiality(${w})`,
      );
      await s.expectError(
        "CDF_CONFLICT:COI_ALREADY_DECLARED",
        (tx) => tx`select api.declare_meeting_conflict(${w}, 'NO_CONFLICT', null)`,
      );

      // A member raises a concern only once cleared themselves.
      v = await meetingView(s, "legal", f.meeting);
      expect(v.capabilities.may_raise_concern).toBe(false);
      await s.expectError("CDF_FORBIDDEN", (tx) => raise(tx, w));
      await s.tx`select api.declare_meeting_conflict(${f.participant.legal!}, 'NO_CONFLICT', null)`;
      v = await meetingView(s, "legal", f.meeting);
      expect(v.capabilities.may_raise_concern).toBe(true);
      await raise(s.tx, w);

      // A member who declared a conflict: no further declaration, no deliberation, no concern to raise.
      await s.as("lead");
      await s.tx`select api.declare_meeting_conflict(${f.participant.lead!}, 'CONFLICT_DECLARED', 'Synthetic: related.')`;
      v = await meetingView(s, "lead", f.meeting);
      expect(v.deliberation).toBeNull();
      expect(v.capabilities).toMatchObject({
        may_declare_conflict: false,
        may_declare_no_conflict: false,
        may_raise_concern: false,
      });
      await s.expectError(
        "CDF_CONFLICT:COI_ALREADY_DECLARED",
        (tx) =>
          tx`select api.declare_meeting_conflict(${f.participant.lead!}, 'CONFLICT_DECLARED', 'Synthetic: again.')`,
      );
      await s.expectError("CDF_FORBIDDEN", (tx) => raise(tx, f.participant.legalB!));
    });
  });
});

describe("api.meeting_view: votes without choices (DEC-F01, DEC-F03, AMB-083)", () => {
  it("under a secret ballot the view shows status and tally, never a choice or who wrote a note", async () => {
    await scenario(async (s) => {
      await rule(s, { ballot_secrecy: "SECRET_BALLOT" });
      const f = await ready(s);
      const item = await openItem(s, f.meeting, TITLE);
      let v = await meetingView(s, "legal", f.meeting);
      expect(v.deliberation!.vote_items).toEqual([
        expect.objectContaining({
          vote_item_id: item,
          title: TITLE,
          status: "OPEN",
          tally: null,
          i_have_voted: false,
          capabilities: { may_vote: true, may_close: false, may_cast_casting_vote: false },
        }),
      ]);
      await s.tx`select api.cast_vote(${item}, 'REJECT', null)`;
      await s.tx`select api.record_vote_note(${item}, ${NOTE}, true)`;
      v = await meetingView(s, "legal", f.meeting);
      expect(v.deliberation!.vote_items[0]).toMatchObject({
        i_have_voted: true,
        capabilities: { may_vote: false },
      });
      await s.expectError(
        "CDF_CONFLICT:ALREADY_VOTED",
        (tx) => tx`select api.cast_vote(${item}, 'APPROVE', null)`,
      );

      // The secretary never votes, and closes only once every present member has voted.
      v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v.deliberation!.vote_items[0]!.capabilities).toEqual({
        may_vote: false,
        may_close: false,
        may_cast_casting_vote: false,
      });
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.cast_vote(${item}, 'APPROVE', null)`);
      await s.expectError(
        "CDF_CONFLICT:VOTES_OUTSTANDING",
        (tx) => tx`select api.close_vote_item(${item}, null)`,
      );
      for (const u of ["legalB", "lead", "committeeChair"] as const) await vote(s, u, item, "APPROVE");
      v = await meetingView(s, "committeeSecretary", f.meeting);
      expect(v.deliberation!.vote_items[0]!.capabilities.may_close).toBe(true);
      await s.tx`select api.close_vote_item(${item}, null)`;

      for (const u of ["committeeSecretary", "committeeChair", "legal"] as const) {
        const after = await meetingView(s, u, f.meeting);
        expect(after.deliberation!.ballot_secrecy).toBe("SECRET_BALLOT");
        expect(after.deliberation!.vote_items[0]).toMatchObject({
          status: "CLOSED",
          result: "APPROVED",
          tally: expect.objectContaining({ approve: 3, reject: 1 }),
        });
        const keys = keysDeep(after);
        for (const k of ["choice", "choices", "note", "notes", "voters", "casting_vote"]) {
          expect(keys.has(k), `${u} ${k}`).toBe(false);
        }
        expect(JSON.stringify(after)).not.toContain("unique-note-marker-2036");
        expect(JSON.stringify(after)).not.toContain('"REJECT"');
      }
    });
  });

  it("only the casting voter is offered the casting vote on a tie, and the view never shows a choice", async () => {
    await scenario(async (s) => {
      const f = await ready(s);
      const item = await openItem(s, f.meeting, TITLE);
      await vote(s, "committeeChair", item, "APPROVE");
      await vote(s, "legal", item, "APPROVE");
      await vote(s, "legalB", item, "REJECT");
      await vote(s, "lead", item, "REJECT");
      await s.as("committeeSecretary");
      const [r] = await s.tx<{ r: string }[]>`select api.close_vote_item(${item}, null) as r`;
      expect(r!.r).toBe("AWAITING_CASTING_VOTE");
      for (const u of ["legal", "committeeSecretary"] as const) {
        const v = await meetingView(s, u, f.meeting);
        expect(v.deliberation!.vote_items[0]!.capabilities.may_cast_casting_vote, u).toBe(false);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.cast_casting_vote(${item}, 'APPROVE', null)`,
        );
      }
      const chair = await meetingView(s, "committeeChair", f.meeting);
      expect(chair.deliberation!.vote_items[0]!.capabilities.may_cast_casting_vote).toBe(true);
      await s.tx`select api.cast_casting_vote(${item}, 'APPROVE', null)`;
      const after = await meetingView(s, "committeeChair", f.meeting);
      expect(after.deliberation!.vote_items[0]).toMatchObject({
        status: "CLOSED",
        result: "APPROVED",
        decided_by_casting_vote: true,
        capabilities: { may_cast_casting_vote: false },
      });
      expect(keysDeep(after).has("choice")).toBe(false);
      await s.expectError(
        "CDF_CONFLICT:NOT_A_TIE",
        (tx) => tx`select api.cast_casting_vote(${item}, 'APPROVE', null)`,
      );
    });
  });
});

describe("api.minutes_view: the minutes_read predicate and the review commands", () => {
  it("outsiders and the case team get NOT_FOUND while the minutes are in review; reviewers, secretary and chair see their own actions", async () => {
    await scenario(async (s) => {
      const f = await ready(s);
      const id = await closeAndGenerate(s, f);
      for (const u of ["investigatorA", "platformAdmin", "employee", "caseManager", "revoked"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.minutes_view(${id})`);
      }
      await s.as("committeeSecretary");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.minutes_view(${randomUUID()})`);
      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select api.minutes_view(${id})`);

      // A reviewer reviews once.
      let v = await minutesView(s, "legal", id);
      expect(v).toMatchObject({
        status: "IN_REVIEW",
        i_have_reviewed: false,
        reviews: [],
        objection_rulings: [],
        case: { case_id: null, case_number: null },
        capabilities: {
          may_review: true,
          may_remind: false,
          may_apply_deemed_approval: false,
          may_overrule_objection: false,
        },
      });
      expect(v.meeting).toMatchObject({ meeting_id: f.meeting, status: "CLOSED" });
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.record_minutes_reminder(${id})`);
      await s.tx`select api.review_minutes(${id}, 'APPROVE', null)`;
      v = await minutesView(s, "legal", id);
      expect(v).toMatchObject({ i_have_reviewed: true, capabilities: { may_review: false } });
      await s.expectError(
        "CDF_CONFLICT:ALREADY_REVIEWED",
        (tx) => tx`select api.review_minutes(${id}, 'APPROVE', null)`,
      );

      // The secretary reminds, never reviews; deemed approval waits for the reminder and the window.
      v = await minutesView(s, "committeeSecretary", id);
      expect(v.capabilities).toEqual({
        may_review: false,
        may_remind: true,
        may_apply_deemed_approval: false,
        may_overrule_objection: false,
      });
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.review_minutes(${id}, 'APPROVE', null)`);
      await s.expectError(
        "CDF_CONFLICT:REMINDER_NOT_SENT",
        (tx) => tx`select api.apply_minutes_deemed_approval(${id})`,
      );
      await s.tx`select api.record_minutes_reminder(${id})`;
      v = await minutesView(s, "committeeSecretary", id);
      expect(v.capabilities).toMatchObject({ may_remind: false, may_apply_deemed_approval: false });
      await s.expectError(
        "CDF_CONFLICT:REMINDER_ALREADY_SENT",
        (tx) => tx`select api.record_minutes_reminder(${id})`,
      );
      await s.expectError(
        "CDF_CONFLICT:REVIEW_WINDOW_OPEN",
        (tx) => tx`select api.apply_minutes_deemed_approval(${id})`,
      );

      // An objection: the chair overrules it, nobody else (AMB-092).
      await s.as("legalB");
      await s.tx`select api.review_minutes(${id}, 'REQUEST_CHANGES', 'Synthetic: unique-comment-marker-2036.')`;
      v = await minutesView(s, "legal", id);
      expect(v.reviews).toHaveLength(2);
      expect(v.capabilities.may_overrule_objection).toBe(false);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.overrule_minutes_objection(${id}, 'Synthetic: the objection is out of scope.')`,
      );
      v = await minutesView(s, "committeeSecretary", id);
      expect(v.capabilities).toMatchObject({
        may_apply_deemed_approval: false,
        may_overrule_objection: false,
      });
      await s.expectError(
        "CDF_CONFLICT:OBJECTION_OPEN",
        (tx) => tx`select api.apply_minutes_deemed_approval(${id})`,
      );
      v = await minutesView(s, "committeeChair", id);
      expect(v.capabilities).toMatchObject({ may_overrule_objection: true, may_review: false });
      await s.expectError(
        "CDF_CONFLICT:MINUTES_NOT_IN_REVIEW",
        (tx) => tx`select api.review_minutes(${id}, 'APPROVE', null)`,
      );
      await s.tx`select api.overrule_minutes_objection(${id}, 'Synthetic: the objection is out of scope.')`;
      v = await minutesView(s, "committeeChair", id);
      expect(v).toMatchObject({
        status: "IN_REVIEW",
        capabilities: { may_overrule_objection: false, may_review: true },
      });
      expect(v.objection_rulings).toEqual([expect.objectContaining({ ruled_as: "CHAIR" })]);
      await s.expectError(
        "CDF_CONFLICT:NO_OBJECTION",
        (tx) => tx`select api.overrule_minutes_objection(${id}, 'Synthetic: the objection is out of scope.')`,
      );
      for (const u of ["legal", "committeeChair"] as const)
        expectNoCaseContent(await minutesView(s, u, id), ["snapshot"]);
    });
  });

  it("approved minutes reach the case team without reviews or rulings; the case number only with case metadata", async () => {
    await scenario(async (s) => {
      const f = await ready(s);
      const id = await closeAndGenerate(s, f);
      for (const u of VOTERS) {
        await s.as(u);
        await s.tx`select api.review_minutes(${id}, 'APPROVE', null)`;
      }
      const cm = await minutesView(s, "caseManager", id);
      expect(cm).toMatchObject({
        status: "APPROVED",
        reviews: null,
        objection_rulings: null,
        i_have_reviewed: null,
        case: { case_id: caseB, case_number: caseNumberB },
      });
      expect(Object.values(cm.capabilities).every((c) => c === false)).toBe(true);
      expect(cm.meeting).toMatchObject({ meeting_id: f.meeting });
      const member = await minutesView(s, "legal", id);
      expect(member).toMatchObject({ case: { case_id: null, case_number: null }, i_have_reviewed: true });
      expect(member.reviews).toHaveLength(4);
      for (const v of [cm, member]) expectNoCaseContent(v, ["snapshot"]);
      await s.as("investigatorA");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.minutes_view(${id})`);
    });
  });
});

describe("meeting notifications: ids only, to exactly who may act (ADR-025, DEC-F04, DEC-F01)", () => {
  /** In-app recipients of a template for one dedupe prefix, by user key; every row also has an email twin. */
  async function recipients(s: OwnerScenario, template: string, dedupe: string): Promise<string[]> {
    await s.asOwner();
    const rows = await s.tx<{ recipient_id: string; channel: string; row: Record<string, unknown> }[]>`
      select recipient_id, channel, to_jsonb(o) as row from notify.outbox o
      where template_code = ${template} and dedupe_key like ${dedupe + ":%"} order by recipient_id, channel`;
    for (const r of rows) {
      expect(Object.keys(r.row).sort()).toEqual([
        "attempts",
        "channel",
        "created_at",
        "dedupe_key",
        "deep_link",
        "delivered_at",
        "id",
        "object_id",
        "object_type",
        "read_at",
        "recipient_id",
        "status",
        "template_code",
      ]);
      expect(r.row).toMatchObject({ object_type: "MEETING" });
      expect(r.row.deep_link).toBe(`/meetings/${r.row.object_id}`);
      expect(r.row.dedupe_key).toBe(`${dedupe}:${r.recipient_id}:${r.channel}`);
      const text = JSON.stringify(r.row);
      for (const marker of ["unique-concern-marker", "unique-title-marker", caseNumberB]) {
        expect(text).not.toContain(marker);
      }
    }
    const inApp = rows.filter((r) => r.channel === "IN_APP").map((r) => r.recipient_id);
    expect(rows.filter((r) => r.channel === "EMAIL").map((r) => r.recipient_id)).toEqual(inApp);
    return inApp.map((id) => BY_ID[id] ?? id).sort();
  }

  async function seesMeeting(s: OwnerScenario, user: UserKey, meeting: string) {
    await s.as(user);
    return (await s.tx`select id from committee.meeting where id = ${meeting}`).length === 1;
  }

  it("a raised conflict notifies the chair alone, under the CHAIR rule", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s);
      await s.as("legal");
      const k = await raise(s.tx, f.participant.legalB!);
      // Finding the decider evaluates the rule as each candidate; the raiser's own context is restored.
      expect(await s.tx`select authz.current_user_id() as id`).toEqual([{ id: USERS.legal }]);
      expect(await recipients(s, "MEETING_CONFLICT_DECISION_REQUESTED", `meeting-concern:${k}`)).toEqual([
        "committeeChair",
      ]);
      const [row] = await s.tx<{ object_id: string }[]>`
        select object_id from notify.outbox where dedupe_key like ${`meeting-concern:${k}:%`} limit 1`;
      expect(row!.object_id).toBe(f.meeting);
      expect(await seesMeeting(s, "committeeChair", f.meeting)).toBe(true);
      // The recipient is the one the command accepts.
      await decide(s.tx, k, "DISMISSED");
    });
  });

  it("when the chair is the subject or conflicted, the deputy is notified; never the raiser, the subject or the conflicted", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s, VOTERS, DEPUTY_SEATS);
      await s.as("legal");
      const k1 = await raise(s.tx, f.participant.committeeChair!);
      expect(await recipients(s, "MEETING_CONFLICT_DECISION_REQUESTED", `meeting-concern:${k1}`)).toEqual([
        "lead",
      ]);
      await s.as("lead");
      await decide(s.tx, k1, "UPHELD");
      // The chair is now conflicted: a later concern goes to the deputy again, not to the chair.
      await s.as("legalB");
      const k2 = await raise(s.tx, f.participant.legal!);
      expect(await recipients(s, "MEETING_CONFLICT_DECISION_REQUESTED", `meeting-concern:${k2}`)).toEqual([
        "lead",
      ]);
    });
  });

  it("under the SECRETARY rule the secretary running the meeting is notified", async () => {
    await ownerScenario(async (s) => {
      await rule(s, { conflict_decider: "SECRETARY" });
      const f = await ready(s);
      await s.as("legal");
      const k = await raise(s.tx, f.participant.legalB!);
      expect(await recipients(s, "MEETING_CONFLICT_DECISION_REQUESTED", `meeting-concern:${k}`)).toEqual([
        "committeeSecretary",
      ]);
      await s.as("committeeSecretary");
      await decide(s.tx, k, "DISMISSED");
    });
  });

  /** DEPUTY_SEATS with the deputy conflicted: a concern about the chair has no decider in the meeting. */
  async function noDeciderInMeeting(s: OwnerScenario): Promise<MeetingFixture> {
    const f = await ready(s, ["committeeChair", "legal", "legalB"], DEPUTY_SEATS);
    await s.as("lead");
    await s.tx`select api.declare_meeting_conflict(${f.participant.lead!}, 'CONFLICT_DECLARED', 'Synthetic: related.')`;
    return f;
  }
  const appointAuthority = (s: Scenario, user: UserKey) =>
    s.tx`select api.appoint_conflict_authority(${ic}, ${USERS[user]}, now(), null, 'DEMO-CA-2036', 'SOURCE_REQUIRED', ${REASON})`;

  it("when neither chair nor deputy can decide, the committee's conflict authority is notified and its link opens the concern-only view", async () => {
    await ownerScenario(async (s) => {
      const f = await noDeciderInMeeting(s);
      await s.as("platformAdmin");
      await appointAuthority(s, "complianceManager");
      await s.as("legal");
      const k = await raise(s.tx, f.participant.committeeChair!);
      expect(await recipients(s, "MEETING_CONFLICT_DECISION_REQUESTED", `meeting-concern:${k}`)).toEqual([
        "complianceManager",
      ]);
      // The authority has no seat and is not in the meeting: it may not see the meeting (2030, DEC-F04), only the
      // concern. Its deep link opens the concern-only view: no logistics, roster, votes, acting roles, exclusions or
      // minutes, and may_decide offered.
      await s.as("complianceManager");
      expect(await s.tx`select authz.can_view_meeting(${f.meeting}) as ok`).toEqual([{ ok: false }]);
      expect(await s.tx`select id from committee.meeting where id = ${f.meeting}`).toEqual([]);
      expect(await s.tx`select id from committee.meeting_conflict_concern`).toEqual([{ id: k }]);
      const v = await concernOnlyView(s, "complianceManager", f.meeting);
      expect(v).toMatchObject({ meeting_id: f.meeting, status: "OPEN" });
      expect(v.concerns.map((c) => [c.concern_id, c.status, c.reason, c.capabilities])).toEqual([
        [k, "OPEN", CONCERN, { may_decide: true, may_reverse: false }],
      ]);
      // Offered, the command accepts; decided, nothing more is offered.
      await decide(s.tx, k, "DISMISSED");
      const after = await concernOnlyView(s, "complianceManager", f.meeting);
      expect(after.concerns.map((c) => [c.concern_id, c.status, c.decided_as, c.capabilities])).toEqual([
        [k, "DISMISSED", "CONFLICT_AUTHORITY", { may_decide: false, may_reverse: false }],
      ]);
    });
  });

  it("the concern-only view opens to nobody else: an outsider and the concern's subject get NOT_FOUND", async () => {
    await ownerScenario(async (s) => {
      const f = await noDeciderInMeeting(s);
      await s.as("platformAdmin");
      await appointAuthority(s, "complianceManager");
      await s.as("legal");
      const k = await raise(s.tx, f.participant.committeeChair!);
      for (const u of [
        "investigatorA",
        "platformAdmin",
        "employee",
        "internalAudit",
        "dpo",
        "revoked",
      ] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.meeting_view(${f.meeting})`);
      }
      // The subject, while in the meeting, has the full view, without the concern about them.
      const full = await meetingView(s, "committeeChair", f.meeting);
      expect(full.concerns).toEqual([]);
      // Once the subject loses the meeting (a case conflict: the case gate fails), the concern about them does not
      // open the concern-only view: they never pass authz.can_view_meeting_concern for it.
      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseB}, ${USERS.committeeChair}, 'CONFLICT_DECLARED', 'Synthetic declared conflict')`;
      await s.as("committeeChair");
      expect(await s.tx`select id from committee.meeting_conflict_concern where id = ${k}`).toEqual([]);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.meeting_view(${f.meeting})`);
      // The authority keeps its view.
      const v = await concernOnlyView(s, "complianceManager", f.meeting);
      expect(v.concerns.map((c) => c.concern_id)).toEqual([k]);
    });
  });

  it("a deputy seated after the referral, outside the meeting, reverses through the concern-only view (DEC-AMB-010)", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s);
      await s.as("legal");
      const k = await raise(s.tx, f.participant.legalB!);
      await s.as("committeeChair");
      await decide(s.tx, k, "UPHELD");
      // Seated now, the deputy is no member of this proceeding and cannot see the meeting, but is the concern's
      // next decider: the concern-only view offers the reversal, and the command accepts it.
      await s.as("platformAdmin");
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.committee}, 'DEPUTY_CHAIR', now(), null, 'DEMO-DEPUTY-2036')`;
      await s.as("committee");
      expect(await s.tx`select authz.can_view_meeting(${f.meeting}) as ok`).toEqual([{ ok: false }]);
      const v = await concernOnlyView(s, "committee", f.meeting);
      expect(v.concerns.map((c) => [c.concern_id, c.status, c.capabilities])).toEqual([
        [k, "UPHELD", { may_decide: false, may_reverse: true }],
      ]);
      await reverse(s.tx, k);
      const after = await concernOnlyView(s, "committee", f.meeting);
      expect(after.concerns.map((c) => [c.concern_id, c.capabilities])).toEqual([
        [k, { may_decide: false, may_reverse: false }],
      ]);
      expect(after.concerns[0]!.reversal).toMatchObject({
        reversed_by: USERS.committee,
        reversed_as: "DEPUTY_CHAIR",
      });
    });
  });

  it("an authority not cleared for the case is told nothing, and nobody else is (fail closed)", async () => {
    await ownerScenario(async (s) => {
      const f = await noDeciderInMeeting(s);
      await s.as("platformAdmin");
      await appointAuthority(s, "internalAudit");
      await s.as("legal");
      const k = await raise(s.tx, f.participant.committeeChair!);
      expect(await recipients(s, "MEETING_CONFLICT_DECISION_REQUESTED", `meeting-concern:${k}`)).toEqual([]);
      await s.as("internalAudit");
      await s.expectError("CDF_NOT_FOUND", (tx) => decide(tx, k, "DISMISSED"));
    });
  });

  it("an opened vote notifies the present, cleared voting members who have not voted, and nobody else", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const w = await invite(s, f.meeting, USERS.employeeB);
      await s.as("employeeB");
      await s.tx`select api.declare_meeting_conflict(${w}, 'NO_CONFLICT', null)`;
      await openWithPresent(s, f, ["committeeChair", "legal", "legalB"]);
      // lead declares a conflict; legalB is no longer cleared for the case.
      await s.as("lead");
      await s.tx`select api.declare_meeting_conflict(${f.participant.lead!}, 'CONFLICT_DECLARED', 'Synthetic: related.')`;
      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseB}, ${USERS.legalB}, 'CONFLICT_DECLARED', 'Synthetic declared conflict')`;
      const item = await openItem(s, f.meeting, TITLE);
      expect(await recipients(s, "MEETING_VOTE_OPENED", `meeting-vote:${item}`)).toEqual([
        "committeeChair",
        "legal",
      ]);
      for (const u of ["committeeChair", "legal"] as const) {
        expect(await seesMeeting(s, u, f.meeting), u).toBe(true);
        const v = await meetingView(s, u, f.meeting);
        expect(v.deliberation!.vote_items[0]!.capabilities.may_vote, u).toBe(true);
      }
      // Who was not notified may not vote.
      for (const [u, refusal] of [
        ["lead", "CDF_NOT_FOUND"],
        ["legalB", "CDF_NOT_FOUND"],
        ["employeeB", "CDF_NOT_FOUND"],
        ["committeeSecretary", "CDF_FORBIDDEN"],
      ] as const) {
        await s.as(u);
        await s.expectError(refusal, (tx) => tx`select api.cast_vote(${item}, 'APPROVE', null)`);
      }
    });
  });
});

describe("synthetic committee seats (seed 30)", () => {
  it("the demo seats are held by demo-only users; a test starts with IC and GC unseated inside its transaction", async () => {
    const rows = await admin<{ code: string; seat: string; user_id: string; current: boolean }[]>`
      select c.code, m.seat, m.user_id,
             m.ended_at is null and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now()) as current
      from committee.membership m join committee.committee c on c.id = m.committee_id
      where m.appointment_reference like ${DEMO_SEAT_REFERENCE + "%"} order by c.code, m.seat`;
    expect(rows.map((r) => `${r.code}:${r.seat}`)).toEqual([
      "GC:CHAIR",
      "GC:SECRETARY",
      "IC:CHAIR",
      "IC:DEPUTY_CHAIR",
      "IC:MEMBER",
      "IC:MEMBER",
      "IC:SECRETARY",
    ]);
    expect(rows.every((r) => r.current)).toBe(true);
    const testUsers = new Set<string>(Object.values(USERS));
    expect(rows.filter((r) => testUsers.has(r.user_id))).toEqual([]);

    // Seated as seeded, the Investigation Committee takes a referral (the demo needs no appointment first), once the
    // case's preliminary review referred it (AMB-018).
    await scenario(async (s) => {
      await preliminaryReferral(s, caseB);
      await s.as("caseManager");
      const [cp] = await s.tx<{ id: string }[]>`
        select api.refer_case_to_committee(${caseB}, ${ic}, null, ${REASON}) as id`;
      expect(cp!.id).toBeTruthy();
    });
    // The fixture ends every demo seat inside the test's transaction; nothing of it outlives the test.
    await scenario(async (s) => {
      await preliminaryReferral(s, caseB);
      await unseatDemoSeats(s);
      expect(
        await s.tx`select id from committee.membership
                   where ended_at is null and (effective_to is null or effective_to > now())`,
      ).toEqual([]);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:COMMITTEE_NOT_CONSTITUTED",
        (tx) => tx`select api.refer_case_to_committee(${caseB}, ${ic}, null, ${REASON})`,
      );
    });
    const [after] = await admin<{ n: number }[]>`
      select count(*)::int as n from committee.membership
      where appointment_reference like ${DEMO_SEAT_REFERENCE + "%"} and ended_at is null`;
    expect(after!.n).toBe(7);
  });
});
