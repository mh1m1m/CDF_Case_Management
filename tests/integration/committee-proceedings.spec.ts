// Phase 12 P12-2c, the proceeding before the committee, the meeting's invite and votes on findings (ADR-056, migration
// 2086) through the real services, gateways, database, RLS and audit, the way the pages call them. Each test runs in
// one owner-connection transaction that is rolled back: the gateways run their security context inside a savepoint of
// that transaction, exactly as they do on their own pool, so no seat, package, invitation or vote reaches the seed.
// Who may act, and what each answer is, is pinned by tests/security/package-builder-and-invite-choices.spec.ts; these
// pin that the pages' path carries it: the packages, answers, choices and candidates the pages show, the commands
// their forms send, and the uniform not-found and denial events.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createCommitteeProceedingsService,
  createMeetingsService,
  type CommitteeProceedingsService,
  type MeetingsService,
} from "@cdf/application";
import {
  isClosedAllegation,
  type CommitteeProceedingPage,
  type MeetingFullView,
  type MeetingView,
} from "@cdf/contracts";
import {
  PostgresCommitteeProceedingsGateway,
  PostgresCommitteesGateway,
  PostgresMeetingsGateway,
  PostgresSecurityEventSink,
  type Sql,
} from "@cdf/infrastructure";
import { USERS, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";
import {
  committeeIds,
  openWithPresent,
  scheduleMeeting,
  seat,
  vote,
  type MeetingFixture,
} from "../support/committee";
import {
  DECISION_SEATS,
  DECISION_VOTERS,
  authorityRuleFor,
  caseFacts,
  type CaseFacts,
} from "../support/decision";

const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });
const SECRET = "Synthetic: text that stays in the committee";

let caseB: string, ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
});

/** The pages' services bound to the scenario's transaction (each call runs in a savepoint). */
function servicesIn(s: OwnerScenario): {
  proceedings: CommitteeProceedingsService;
  meetings: MeetingsService;
} {
  const sql = {
    begin: (fn: (tx: unknown) => Promise<unknown>) => s.tx.savepoint(fn as never),
  } as unknown as Sql;
  const securityEvents = new PostgresSecurityEventSink(sql);
  return {
    proceedings: createCommitteeProceedingsService({
      committees: new PostgresCommitteesGateway(sql),
      gateway: new PostgresCommitteeProceedingsGateway(sql),
      securityEvents,
    }),
    meetings: createMeetingsService({ gateway: new PostgresMeetingsGateway(sql), securityEvents }),
  };
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

function page(p: CommitteeProceedingPage | null): CommitteeProceedingPage {
  if (!p) throw new Error("expected the proceeding page, got the not-found");
  return p;
}

function full(v: MeetingView | null): MeetingFullView {
  if (v?.view !== "FULL") throw new Error(`expected the full view, got ${v?.view ?? "null"}`);
  return v;
}

/** The audit events one request recorded, read back on the owner connection. */
async function eventsOf(s: OwnerScenario, requestId: string, category = "SECURITY") {
  await s.asOwner();
  return s.tx<
    { action: string; object_type: string; object_id: string; metadata: Record<string, unknown> }[]
  >`
    select action, object_type, object_id, metadata from audit.audit_event
    where category = ${category} and request_id = ${requestId} order by seq`;
}

/** The committee seated, the case's facts referred from their proceeding (so its finding is the committee's to act
 *  on), the subject's defence notice issued, and a meeting open with the voters present. */
async function proceedingWithMeeting(
  s: OwnerScenario,
): Promise<CaseFacts & { m: MeetingFixture; cp: string }> {
  await seat(s, ic, DECISION_SEATS);
  await authorityRuleFor(s, "CORRECTIVE_ACTION");
  const facts = await caseFacts(s, caseB);
  await s.as("caseManager");
  await s.tx`select api.issue_defence_notice(${facts.subject}, 'Synthetic: you are invited to respond.',
    ${[facts.allegation]}::uuid[], now() + interval '10 days')`;
  const m = await scheduleMeeting(s, ic, caseB, facts.proceeding);
  await openWithPresent(s, m, DECISION_VOTERS);
  return { ...facts, m, cp: m.committeeProceeding };
}

describe("the proceeding before the committee through the service (Phase 12 P12-2c)", () => {
  it("the secretary builds a package from the page's choices, puts it to the committee, opens its vote and records the adoption", async () => {
    await ownerScenario(async (s) => {
      const { proceedings, meetings } = servicesIn(s);
      const f = await proceedingWithMeeting(s);
      const secretary = ctxFor("committeeSecretary");

      // No package yet: the secretary may create one and reads the choices; no catalogue until a package takes items.
      const first = page(await proceedings.proceeding(secretary, f.cp));
      expect([first.committee, first.mySeat]).toEqual([
        { committeeId: ic, code: "IC", kind: "INVESTIGATION" },
        "SECRETARY",
      ]);
      expect(first.items?.capabilities).toEqual({ mayCreatePackage: true });
      expect(first.items?.packages).toEqual([]);
      expect(first.scope?.labelMode).toBe("ORDINAL");
      expect(first.scope?.subjects).toEqual([
        { subjectId: f.subject, position: 1, subjectCategory: "EMPLOYEE", label: null },
      ]);
      // The case's allegations not withdrawn, by position; ours was added last.
      const allegations = first.scope?.allegations ?? [];
      expect(allegations.at(-1)).toEqual({
        allegationId: f.allegation,
        position: allegations.length,
        category: "FRAUD",
        status: "OPEN",
        subjectId: f.subject,
      });
      expect(first.scope?.findings.map((x) => [x.findingId, x.result, x.proceedingRole])).toEqual([
        [f.finding, "SUBSTANTIATED", "REFERRED"],
      ]);
      expect(first.catalogue).toEqual([]);

      const pkg = value<string>(
        await proceedings.createPackage(secretary, { committeeProceedingId: f.cp, voteGranularity: "ITEM" }),
      );
      const draft = page(await proceedings.proceeding(secretary, f.cp));
      expect(
        draft.items?.packages.map((p) => [p.packageId, p.status, p.voteGranularity, p.capabilities]),
      ).toEqual([
        [
          pkg,
          "DRAFT",
          "ITEM",
          {
            mayAddItem: true,
            maySubmitForVote: false,
            mayRecordAdoption: false,
            mayReturnToCommittee: false,
            mayRequestLegalReview: false,
            maySubmitToAuthority: false,
            mayRecordAuthorityDecision: false,
          },
        ],
      ]);
      // The catalogue as the builder offers it: each code with its version in force, provisional until approved.
      expect(draft.catalogue.map((c) => [c.code, c.versionNo, c.sourceStatus])).toEqual([
        ["DEMOTION", 1, "SOURCE_REQUIRED"],
        ["SALARY_DEDUCTION", 1, "SOURCE_REQUIRED"],
        ["SUSPENSION", 1, "SOURCE_REQUIRED"],
        ["TERMINATION", 1, "SOURCE_REQUIRED"],
        ["WARNING", 1, "SOURCE_REQUIRED"],
      ]);

      // The builder's two forms, as they send their fields.
      const sanction = value<string>(
        await proceedings.addItem(secretary, {
          packageId: pkg,
          itemType: "DISCIPLINARY_SANCTION",
          sanctionCode: "WARNING",
          description: "Synthetic: written warning for the person concerned.",
          subjectIds: [f.subject],
          allegationIds: [f.allegation],
          requiresLegalJustification: false,
        }),
      );
      const corrective = value<string>(
        await proceedings.addItem(secretary, {
          packageId: pkg,
          itemType: "CORRECTIVE_ACTION",
          description: "Synthetic: strengthen the approval controls.",
          requiresLegalJustification: true,
        }),
      );
      const built = page(await proceedings.proceeding(secretary, f.cp)).items!.packages[0]!;
      expect(built.capabilities.maySubmitForVote).toBe(true);
      expect(
        built.items.map((i) => [i.itemId, i.caseWide, i.subjects.map((x) => x.position), i.flags]),
      ).toEqual([
        [sanction, false, [1], ["SANCTION_SOURCE_REQUIRED"]],
        [corrective, true, [], []],
      ]);
      expect(built.items.every((i) => i.capabilities.mayWithdraw)).toBe(true);

      // Put to the committee, the vote opens in the open meeting only, one vote item per item.
      expect(value<number>(await proceedings.submitForVote(secretary, { packageId: pkg }))).toBe(1);
      const voting = page(await proceedings.proceeding(secretary, f.cp)).items!.packages[0]!;
      expect([voting.status, voting.openVoteIn, voting.capabilities.mayAddItem]).toEqual([
        "VOTING",
        [f.m.meeting],
        false,
      ]);
      expect(
        value<number>(
          await proceedings.openPackageVote(secretary, { meetingId: f.m.meeting, packageId: pkg }),
        ),
      ).toBe(2);
      await s.as("committeeSecretary");
      const items = await s.tx<{ id: string }[]>`
        select id from committee.vote_item where package_id = ${pkg} order by sequence_no`;
      for (const { id } of items) {
        for (const voter of DECISION_VOTERS) await vote(s, voter, id, "APPROVE");
        expect(
          value<string>(
            await meetings.closeVoteItem(secretary, { voteItemId: id, customQuorumAttested: false }),
          ),
        ).toBe("APPROVED");
      }
      const closed = page(await proceedings.proceeding(secretary, f.cp)).items!.packages[0]!;
      expect(closed.capabilities.mayRecordAdoption).toBe(true);
      expect(value<string>(await proceedings.recordAdoption(secretary, { packageId: pkg }))).toBe("ADOPTED");

      const adopted = page(await proceedings.proceeding(secretary, f.cp)).items!.packages[0]!;
      expect([adopted.status, adopted.items.map((i) => i.committeeResult)]).toEqual([
        "ADOPTED",
        ["APPROVED", "APPROVED"],
      ]);
      expect(adopted.capabilities).toMatchObject({ mayAddItem: false, mayRecordAdoption: false });

      // Each view of the page is audited with counts only; the items' words never reach the ledger.
      const viewed = await eventsOf(s, secretary.requestId, "BUSINESS");
      expect(viewed.filter((e) => e.action === "COMMITTEE_ITEMS_VIEWED").length).toBeGreaterThan(0);
      expect(JSON.stringify(viewed.filter((e) => e.action.endsWith("_VIEWED")))).not.toContain("Synthetic");
    });
  });

  it("the builder leaves out an allegation a correction superseded, and the command refuses it (CDF-238)", async () => {
    await ownerScenario(async (s) => {
      const { proceedings } = servicesIn(s);
      const f = await proceedingWithMeeting(s);
      const secretary = ctxFor("committeeSecretary");
      // A second allegation about the same person, with no finding, which a correction splits (2090, ADR-045).
      await s.as("caseManager");
      const [added] = await s.tx<{ id: string }[]>`
        select api.add_allegation(${caseB}, 'POLICY_BREACH', 'Synthetic: two separate matters in one allegation.',
          ${f.subject}, null, null) as id`;
      const [split] = await s.tx<{ ids: string[] }[]>`
        select api.split_allegation(${added!.id}, ${s.tx.json([
          { category: "POLICY_BREACH", description: "Synthetic: the first of the two matters." },
          { category: "FRAUD", description: "Synthetic: the second of the two matters." },
        ] as never)}::jsonb, 'Synthetic: the allegation covers two separate matters.') as ids`;

      // R1 still lists it with its status; the builder offers its successors and leaves it out, as a withdrawn one.
      const scope = page(await proceedings.proceeding(secretary, f.cp)).scope!;
      expect(scope.allegations.find((a) => a.allegationId === added!.id)?.status).toBe("SUPERSEDED");
      const offered = scope.allegations
        .filter((a) => !isClosedAllegation(a.status))
        .map((a) => a.allegationId);
      expect(offered).not.toContain(added!.id);
      expect(offered).toEqual(expect.arrayContaining([f.allegation, ...split!.ids]));

      // What the builder no longer offers, the command refuses anyway.
      const pkg = value<string>(
        await proceedings.createPackage(secretary, { committeeProceedingId: f.cp, voteGranularity: "ITEM" }),
      );
      const item = (allegationId: string) =>
        proceedings.addItem(secretary, {
          packageId: pkg,
          itemType: "DISCIPLINARY_SANCTION",
          sanctionCode: "WARNING",
          description: "Synthetic: written warning for the person concerned.",
          subjectIds: [f.subject],
          allegationIds: [allegationId],
          requiresLegalJustification: false,
        });
      expect(outcome(await item(added!.id))).toBe("CONFLICT:ALLEGATION_SUPERSEDED");
      expect(outcome(await item(split!.ids[0]!))).toBe("ok");
    });
  });

  it("a member reads the packages with no form; the case team, a platform administrator and an unknown id get the uniform not-found", async () => {
    await ownerScenario(async (s) => {
      const { proceedings } = servicesIn(s);
      const f = await proceedingWithMeeting(s);
      const pkg = value<string>(
        await proceedings.createPackage(ctxFor("committeeSecretary"), {
          committeeProceedingId: f.cp,
          voteGranularity: "PACKAGE",
        }),
      );

      const member = page(await proceedings.proceeding(ctxFor("legal"), f.cp));
      expect(member.mySeat).toBe("MEMBER");
      expect(member.items?.capabilities).toEqual({ mayCreatePackage: false });
      expect(member.items?.packages.map((p) => [p.packageId, p.capabilities, p.openVoteIn])).toEqual([
        [
          pkg,
          {
            mayAddItem: false,
            maySubmitForVote: false,
            mayRecordAdoption: false,
            mayReturnToCommittee: false,
            mayRequestLegalReview: false,
            maySubmitToAuthority: false,
            mayRecordAuthorityDecision: false,
          },
          [],
        ],
      ]);
      // R1 and the catalogue are the builder's: a member reads neither.
      expect([member.scope, member.catalogue]).toEqual([null, []]);
      const legal = ctxFor("legal");
      expect(await proceedings.scopeChoices(legal, f.cp)).toBeNull();
      expect(
        outcome(
          await proceedings.returnToCommittee(legal, {
            packageId: pkg,
            reason: `${SECRET}: a member's attempt.`,
          }),
        ),
      ).toBe("FORBIDDEN");
      const denied = await eventsOf(s, legal.requestId);
      expect(denied).toEqual([
        {
          action: "COMMAND_DENIED",
          object_type: "command",
          object_id: pkg,
          metadata: { command: "return_package_to_committee", outcome: "FORBIDDEN" },
        },
      ]);
      expect(JSON.stringify(denied)).not.toContain(SECRET);

      // The case team sees the proceeding through the case and never on a committee page; PLATFORM_ADMIN implies no
      // seat (§21). An id that names nothing reads exactly like one that is refused.
      for (const [user, id] of [
        ["caseManager", f.cp],
        ["investigatorB", f.cp],
        ["platformAdmin", f.cp],
        ["committeeSecretary", randomUUID()],
      ] as const) {
        const c = ctxFor(user);
        expect(await proceedings.proceeding(c, id), user).toBeNull();
        expect(await eventsOf(s, c.requestId), user).toEqual([
          {
            action: "ACCESS_DENIED",
            object_type: "committee_proceeding",
            object_id: id,
            metadata: { read: "committee_proceeding" },
          },
        ]);
      }
    });
  });

  it("the invite list holds the case's person and the case team, never a directory; an invitation leaves it and reaches the roster", async () => {
    await ownerScenario(async (s) => {
      const { meetings } = servicesIn(s);
      const f = await proceedingWithMeeting(s);
      await s.asOwner();
      const [sigma] = await s.tx<{ person_id: string }[]>`
        select person_id from case_mgmt.case_subject where id = ${f.subject}`;
      const secretary = ctxFor("committeeSecretary");

      const list = await meetings.inviteChoices(secretary, f.m.meeting);
      expect(list?.labelMode).toBe("ORDINAL");
      expect(list?.persons).toEqual([
        {
          personId: sigma!.person_id,
          position: 1,
          caseRoles: ["SUBJECT"],
          label: null,
          inviteeRoles: ["WITNESS", "EXPERT", "INFORMATION_PROVIDER", "SUBJECT"],
        },
      ]);
      expect(list?.accounts.map((a) => [a.userId, a.bases, a.inviteeRoles])).toEqual([
        [USERS.investigatorB, ["CASE_TEAM"], ["WITNESS", "EXPERT", "LEGAL", "INFORMATION_PROVIDER"]],
      ]);
      expect(typeof list?.accounts[0]?.displayName).toBe("string");

      // The investigator as an expert, by account; the person concerned as the person, so no name reaches the roster.
      const expert = value<string>(
        await meetings.inviteToMeeting(secretary, {
          meetingId: f.m.meeting,
          inviteeRole: "EXPERT",
          invitee: `account:${USERS.investigatorB}`,
          requiresCoi: true,
          reason: "Synthetic: the investigator presents the findings.",
        }),
      );
      const subject = value<string>(
        await meetings.inviteToMeeting(secretary, {
          meetingId: f.m.meeting,
          inviteeRole: "SUBJECT",
          invitee: `person:${sigma!.person_id}`,
          requiresCoi: false,
          reason: "Synthetic: the person concerned is heard.",
        }),
      );
      const roster = full(await meetings.meeting(secretary, f.m.meeting)).roster ?? [];
      const row = (id: string) => roster.find((r) => r.participantId === id);
      expect([row(expert)?.participantKind, row(expert)?.inviteeRole, row(expert)?.userId]).toEqual([
        "INVITEE",
        "EXPERT",
        USERS.investigatorB,
      ]);
      expect([row(subject)?.inviteeRole, row(subject)?.userId, row(subject)?.displayName]).toEqual([
        "SUBJECT",
        null,
        null,
      ]);
      expect(await meetings.inviteChoices(secretary, f.m.meeting)).toMatchObject({
        persons: [],
        accounts: [],
      });

      // A member does not run the meeting: no list, and no invitation.
      const legal = ctxFor("legal");
      expect(await meetings.inviteChoices(legal, f.m.meeting)).toBeNull();
      expect(
        outcome(
          await meetings.inviteToMeeting(legal, {
            meetingId: f.m.meeting,
            inviteeRole: "WITNESS",
            invitee: `account:${USERS.investigatorA}`,
            requiresCoi: true,
            reason: `${SECRET}: a member's attempt.`,
          }),
        ),
      ).toBe("FORBIDDEN");
      const denied = await eventsOf(s, legal.requestId);
      expect(denied.map((e) => [e.action, e.object_id, e.metadata])).toEqual([
        ["ACCESS_DENIED", f.m.meeting, { read: "meeting_invite_choices" }],
        ["COMMAND_DENIED", f.m.meeting, { command: "invite_to_meeting", outcome: "FORBIDDEN" }],
      ]);
      expect(JSON.stringify(denied)).not.toContain(SECRET);
    });
  });

  it("a vote on a finding opens on a finding the committee may act on, and members see what it is about, never why", async () => {
    await ownerScenario(async (s) => {
      const { proceedings, meetings } = servicesIn(s);
      const f = await proceedingWithMeeting(s);
      const secretary = ctxFor("committeeSecretary");

      expect((await proceedings.scopeChoices(secretary, f.cp))?.findings.map((x) => x.findingId)).toEqual([
        f.finding,
      ]);
      const item = value<string>(
        await meetings.openVoteItem(secretary, {
          meetingId: f.m.meeting,
          targetType: "FINDING",
          findingId: f.finding,
          title: "Synthetic: does the committee accept the finding?",
        }),
      );
      // A finding the committee may not act on (here, none at all) is refused as the command's input.
      expect(
        outcome(
          await meetings.openVoteItem(secretary, {
            meetingId: f.m.meeting,
            targetType: "FINDING",
            findingId: randomUUID(),
            title: "Synthetic: an unknown finding.",
          }),
        ),
      ).toBe("INVALID:finding_id");

      const member = page(await proceedings.proceeding(ctxFor("lead"), f.cp));
      expect(member.items?.findingVotes).toEqual([
        {
          voteItemId: item,
          meetingId: f.m.meeting,
          sequenceNo: 1,
          status: "OPEN",
          finding: {
            findingId: f.finding,
            versionNo: 1,
            isCurrentVersion: true,
            result: "SUBSTANTIATED",
            proceedingRole: "REFERRED",
            allegation: { allegationId: f.allegation, category: "FRAUD" },
            subject: { subjectId: f.subject, position: 1, subjectCategory: "EMPLOYEE", label: null },
          },
        },
      ]);
      expect(JSON.stringify(member)).not.toContain("rationale");
      expect(JSON.stringify(member)).not.toContain("Synthetic: finding rationale text.");
    });
  });
});
