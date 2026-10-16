// Phase 12 P12-3a, legal review and the authority's decision (ADR-057, migration 2095) through the real services,
// gateways, database, RLS and audit, the way the pages call them. Each test runs in one owner-connection transaction
// that is rolled back: the gateways run their security context inside a savepoint of that transaction, exactly as they
// do on their own pool, so no request, opinion, packet or decision reaches the seed. Who may act, and what each answer
// is, is pinned by tests/security/legal-review-and-authority-read-models.spec.ts; these pin that the pages' path
// carries it: the package's legal review and authority half, the choices and reviewer's page they show, the packets
// they open, the commands their forms send, and the uniform not-found and denial events.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createCommitteeProceedingsService,
  createLegalReviewsService,
  type CommitteeProceedingsService,
  type LegalReviewChoicesResult,
  type LegalReviewsService,
} from "@cdf/application";
import type { CommitteeItemsView, LegalReviewChoices } from "@cdf/contracts";
import {
  PostgresCommitteeProceedingsGateway,
  PostgresCommitteesGateway,
  PostgresLegalReviewsGateway,
  PostgresSecurityEventSink,
  type Sql,
} from "@cdf/infrastructure";
import { USERS, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";
import {
  REASON,
  committeeIds,
  openWithPresent,
  preliminaryReferral,
  scheduleMeeting,
  seat,
} from "../support/committee";
import {
  DECISION_SEATS,
  DECISION_VOTERS,
  authorityRuleFor,
  caseFacts,
  voteOnPackage,
  type PackageFixture,
} from "../support/decision";

const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });
const SECRET = "Synthetic: text that stays with the committee";
const MEMO = "MEMO-DEMO-2095";

let caseB: string, caseExec: string, ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  caseExec = await caseId("0003");
  ({ ic } = await committeeIds());
});

/** The pages' services bound to the scenario's transaction (each call runs in a savepoint). */
function servicesIn(s: OwnerScenario): {
  proceedings: CommitteeProceedingsService;
  legal: LegalReviewsService;
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
    legal: createLegalReviewsService({ gateway: new PostgresLegalReviewsGateway(sql), securityEvents }),
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

function chosen(r: LegalReviewChoicesResult | null): LegalReviewChoices {
  if (!r?.ok) throw new Error(`expected the choices, got ${r ? r.code : "the not-found"}`);
  return r.choices;
}

/** The package as the secretary's page reads it: the seat basis and R2. */
async function onSeat(p: CommitteeProceedingsService, user: UserKey, cp: string, pkg: string) {
  const v = await p.onSeat(ctxFor(user), cp);
  const found = v?.items.packages.find((x) => x.packageId === pkg);
  if (!found) throw new Error(`expected ${user} to read the package on their seat`);
  return found;
}

/** The package as the case's Proceedings tab reads it: R2 alone, through the case. */
async function onCase(p: CommitteeProceedingsService, user: UserKey, cp: string, pkg: string) {
  const v: CommitteeItemsView | null = await p.items(ctxFor(user), cp);
  return v?.packages.find((x) => x.packageId === pkg) ?? null;
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

/** The transaction's own now(), as the record form sends a time no later than the database's. */
async function now(s: OwnerScenario): Promise<string> {
  await s.asOwner();
  const [r] = await s.tx<{ at: Date }[]>`select now() as at`;
  return r!.at.toISOString();
}

/**
 * A package of the investigation committee adopted with both items (a sanction and a case-wide corrective action), as
 * in draftPackage, but referred from the case's investigation proceeding so that its finding is the committee's to
 * send (L2 lists the committee's scope).
 */
async function adopted(s: OwnerScenario): Promise<PackageFixture & { cp: string }> {
  await seat(s, ic, DECISION_SEATS);
  await authorityRuleFor(s, "CORRECTIVE_ACTION");
  const facts = await caseFacts(s, caseB);
  await s.as("caseManager");
  await s.tx`select api.issue_defence_notice(${facts.subject}, 'Synthetic: you are invited to respond.',
    ${[facts.allegation]}::uuid[], now() + interval '10 days')`;
  const meeting = await scheduleMeeting(s, ic, caseB, facts.proceeding);
  await openWithPresent(s, meeting, DECISION_VOTERS);
  await s.as("committeeSecretary");
  const [pkg] = await s.tx<{ id: string }[]>`
    select api.create_recommendation_package(${meeting.committeeProceeding}, 'PACKAGE') as id`;
  const [sanction] = await s.tx<{ id: string }[]>`
    select api.add_recommendation_item(${pkg!.id}, 'DISCIPLINARY_SANCTION', 'WARNING', null,
      'Synthetic: written warning for Employee Sigma.', ${[facts.subject]}::uuid[], ${[facts.allegation]}::uuid[]) as id`;
  const [corrective] = await s.tx<{ id: string }[]>`
    select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null,
      'Synthetic: strengthen the approval controls.', null, null) as id`;
  const f = { ...facts, meeting, pkg: pkg!.id, sanction: sanction!.id, corrective: corrective!.id };
  expect(await voteOnPackage(s, f)).toBe("ADOPTED");
  return { ...f, cp: meeting.committeeProceeding };
}

describe("legal review and the authority's decision through the service (Phase 12 P12-3a)", () => {
  it("the secretary asks for a review from the page's choices; the reviewer reads the request and its packet, gives an opinion and a later one", async () => {
    await ownerScenario(async (s) => {
      const { proceedings, legal } = servicesIn(s);
      const f = await adopted(s);
      const secretary = ctxFor("committeeSecretary");

      // The package's legal review half: nothing asked yet, and the secretary may ask.
      const before = await onSeat(proceedings, "committeeSecretary", f.cp, f.pkg);
      expect([
        before.status,
        before.capabilities.mayRequestLegalReview,
        before.requestLegalReviewBlock,
      ]).toEqual(["ADOPTED", true, null]);
      expect(before.legalReview.requests).toEqual([]);

      // The ask page's choices (L2, recorded with counts only): every holder of the opinion permission but the
      // secretary, the committee's finding, and the adopted items the packet carries besides.
      const choices = chosen(await legal.choices(secretary, f.pkg, "REQUEST"));
      expect([choices.act, choices.restricted, choices.package.packageId]).toEqual(["REQUEST", false, f.pkg]);
      expect(choices.reviewers.map((r) => r.userId)).toContain(USERS.legalB);
      expect(choices.reviewers.map((r) => r.userId)).not.toContain(USERS.committeeSecretary);
      expect(choices.findings.map((x) => x.findingId)).toEqual([f.finding]);
      expect(choices.items.map((i) => i.itemId).sort()).toEqual([f.sanction, f.corrective].sort());

      // The ask form as it sends its fields.
      const request = value<string>(
        await legal.requestLegalReview(secretary, {
          packageId: f.pkg,
          assignedTo: USERS.legalB,
          findingIds: [f.finding],
          minutesIds: [],
          reason: `${SECRET}: the reason for asking.`,
        }),
      );
      const asked = await onSeat(proceedings, "committeeSecretary", f.cp, f.pkg);
      expect(asked.status).toBe("IN_LEGAL_REVIEW");
      expect(
        asked.legalReview.requests.map((r) => [r.requestId, r.status, r.reviewer.userId, r.capabilities]),
      ).toEqual([[request, "ASSIGNED", USERS.legalB, { mayCancel: true }]]);
      const packetId = asked.legalReview.requests[0]!.packetId!;
      expect(packetId).toBeTruthy();

      // The packet as the committee reads it: the adopted items, then the finding, each as stored; the person concerned
      // by the name stored when the packet was made (ruling 4).
      const sent = await legal.packet(secretary, packetId);
      expect([sent?.purpose, sent?.items.map((i) => i.kind)]).toEqual([
        "LEGAL_REVIEW",
        ["RECOMMENDATION_ITEM", "RECOMMENDATION_ITEM", "FINDING"],
      ]);
      const sanction = sent!.items.find((i) => i.sourceId === f.sanction);
      expect(sanction?.kind === "RECOMMENDATION_ITEM" && sanction.subjects.map((x) => x.label)).toEqual([
        "Employee Sigma (synthetic)",
      ]);

      // The reviewer's page: the request, what the secretary wrote, and the opinion form.
      const reviewer = ctxFor("legalB");
      const review = await legal.review(reviewer, request);
      expect(review).toMatchObject({
        requestId: request,
        packageRound: 1,
        status: "ASSIGNED",
        reason: `${SECRET}: the reason for asking.`,
        requestedBy: { userId: USERS.committeeSecretary },
        opinion: null,
        revisions: [],
        packetId,
        capabilities: { mayGiveOpinion: true, mayGiveSupersedingOpinion: false },
        opinionBlock: null,
      });
      const opened = await legal.reviewPacket(reviewer, request);
      expect([opened?.review.requestId, opened?.packet.packetId]).toEqual([request, packetId]);

      // The opinion form, then the later opinion's.
      expect(
        outcome(
          await legal.giveLegalOpinion(reviewer, {
            requestId: request,
            opinion: "CONCURS_WITH_COMMENTS",
            opinionText: `${SECRET}: the reviewer's comment.`,
          }),
        ),
      ).toBe("ok");
      const given = await legal.review(reviewer, request);
      expect(given).toMatchObject({
        status: "OPINION_GIVEN",
        opinion: "CONCURS_WITH_COMMENTS",
        opinionText: `${SECRET}: the reviewer's comment.`,
        capabilities: { mayGiveOpinion: false, mayGiveSupersedingOpinion: true },
        supersedingOpinionBlock: null,
      });
      expect(given?.opinionAt).toBeTruthy();
      const revision = value<string>(
        await legal.giveSupersedingLegalOpinion(reviewer, {
          requestId: request,
          opinion: "CONCURS",
          opinionText: "",
        }),
      );
      const later = await legal.review(reviewer, request);
      expect(later?.revisions.map((r) => [r.revisionId, r.revisionNo, r.opinion, r.opinionText])).toEqual([
        [revision, 2, "CONCURS", null],
      ]);

      // Back on the committee's page: adopted again with the opinion, the request answered and no longer cancellable.
      const answered = await onSeat(proceedings, "committeeSecretary", f.cp, f.pkg);
      expect(answered.status).toBe("ADOPTED");
      expect(
        answered.legalReview.requests.map((r) => [r.status, r.opinion, r.revisions.length, r.capabilities]),
      ).toEqual([["OPINION_GIVEN", "CONCURS_WITH_COMMENTS", 1, { mayCancel: false }]]);

      // Every read was recorded, with counts and codes only: no reason or opinion reaches the ledger.
      const reads = [
        ...(await eventsOf(s, secretary.requestId, "BUSINESS")),
        ...(await eventsOf(s, reviewer.requestId, "BUSINESS")),
      ].filter((e) => e.action.endsWith("_VIEWED"));
      // L1 records nothing (the reviewer's packet is the audited read).
      expect(new Set(reads.map((e) => e.action))).toEqual(
        new Set(["LEGAL_REVIEW_CHOICES_VIEWED", "PACKET_VIEWED"]),
      );
      expect(JSON.stringify(reads)).not.toContain("Synthetic");
      expect([
        ...(await eventsOf(s, secretary.requestId)),
        ...(await eventsOf(s, reviewer.requestId)),
      ]).toEqual([]);
    });
  });

  it("the secretary submits to the authority and records its decision from the record form; the case team reads it all through the case", async () => {
    await ownerScenario(async (s) => {
      const { proceedings, legal } = servicesIn(s);
      const f = await adopted(s);
      const secretary = ctxFor("committeeSecretary");
      const request = value<string>(
        await legal.requestLegalReview(secretary, {
          packageId: f.pkg,
          assignedTo: USERS.legalB,
          findingIds: [f.finding],
          minutesIds: [],
          reason: `${SECRET}: the reason for asking.`,
        }),
      );
      expect(
        outcome(await legal.giveLegalOpinion(ctxFor("legalB"), { requestId: request, opinion: "CONCURS" })),
      ).toBe("ok");

      // Submit: the rules in force for both item types, then the package as submitted.
      const ready = await onSeat(proceedings, "committeeSecretary", f.cp, f.pkg);
      expect([ready.capabilities.maySubmitToAuthority, ready.submitBlock]).toEqual([true, null]);
      expect(ready.authority.rules.map((r) => r.itemType).sort()).toEqual([
        "CORRECTIVE_ACTION",
        "DISCIPLINARY_SANCTION",
      ]);
      const submitted = value<string>(await legal.submitToAuthority(secretary, { packageId: f.pkg }));
      const waiting = await onSeat(proceedings, "committeeSecretary", f.cp, f.pkg);
      expect(waiting.status).toBe("AWAITING_AUTHORITY");
      expect(waiting.authority.submissions.map((x) => [x.packageRound, x.packetId, x.basis])).toEqual([
        [1, submitted, "SUBMISSION"],
      ]);
      // The corrective action's rule names the sanction's authority (the fixture), so one authority decides both.
      expect(waiting.authority.toDecide).toHaveLength(1);
      const { authorityType, itemIds, completesRound } = waiting.authority.toDecide[0]!;
      expect([itemIds.slice().sort(), completesRound]).toEqual([[f.sanction, f.corrective].sort(), true]);
      expect(waiting.capabilities.mayRecordAuthorityDecision).toBe(true);
      expect(waiting.recordOutcomes).toContain("APPROVE_AS_RECOMMENDED");
      expect(waiting.recordSupersedes).toBeNull();

      // The package as submitted carries the adopted items and the opinion.
      const asSubmitted = await legal.packet(secretary, submitted);
      expect([asSubmitted?.purpose, asSubmitted?.items.map((i) => i.kind)]).toEqual([
        "AUTHORITY_DECISION",
        ["RECOMMENDATION_ITEM", "RECOMMENDATION_ITEM", "LEGAL_OPINION"],
      ]);

      // The record form as it sends its fields: two further sources (a blank line left out), the first condition row
      // filled and the other two empty, the signature stated, no delegation.
      const decidedAt = await now(s);
      const decision = value<string>(
        await legal.recordAuthorityDecision(secretary, {
          packageId: f.pkg,
          authorityType,
          outcome: "APPROVE_AS_RECOMMENDED",
          decidedAt,
          decidedByLabel: "Chief Executive (synthetic)",
          sourceDocumentReference: MEMO,
          sourceSignature: "SIGNED",
          additionalSourceReferences: `${MEMO}-A\n\n${MEMO}-B`,
          itemOutcomes: [],
          conditions: [
            {
              kind: "FOLLOW_UP_TASK",
              itemId: f.corrective,
              text: `${SECRET}: confirm the controls.`,
              dueDate: "2026-12-31",
            },
            { kind: "", itemId: "", text: "", dueDate: "" },
            { kind: "", itemId: "", text: "", dueDate: "" },
          ],
          reason: `${SECRET}: the authority's reason.`,
        }),
      );
      const decided = await onSeat(proceedings, "committeeSecretary", f.cp, f.pkg);
      expect([
        decided.status,
        decided.capabilities.mayRecordAuthorityDecision,
        decided.authority.toDecide,
      ]).toEqual(["DECIDED", false, []]);
      const [d] = decided.authority.decisions;
      expect(d).toMatchObject({
        decisionId: decision,
        packageRound: 1,
        authorityType,
        outcome: "APPROVE_AS_RECOMMENDED",
        decidedByLabel: "Chief Executive (synthetic)",
        sourceSignature: "SIGNED",
        unsignedAttestation: null,
        delegationReference: null,
        reason: `${SECRET}: the authority's reason.`,
        superseded: null,
      });
      expect(new Date(d!.decidedAt).getTime()).toBe(new Date(decidedAt).getTime());
      expect(d!.sources).toEqual([
        { position: 1, reference: MEMO, isPrimary: true },
        { position: 2, reference: `${MEMO}-A`, isPrimary: false },
        { position: 3, reference: `${MEMO}-B`, isPrimary: false },
      ]);
      expect(d!.conditions).toEqual([
        {
          position: 1,
          kind: "FOLLOW_UP_TASK",
          itemId: f.corrective,
          text: `${SECRET}: confirm the controls.`,
          dueDate: "2026-12-31",
        },
      ]);
      expect(d!.scope.map((x) => x.itemOutcome)).toEqual(["APPROVED", "APPROVED"]);

      // The case's Proceedings tab: the case team read the same package, every command answer false, and open both
      // packets from the case.
      const team = await onCase(proceedings, "caseManager", f.cp, f.pkg);
      expect(team?.status).toBe("DECIDED");
      expect(Object.values(team!.capabilities).every((x) => x === false)).toBe(true);
      expect(team!.legalReview.requests.map((r) => [r.requestId, r.packetId, r.capabilities])).toEqual([
        [request, expect.any(String), { mayCancel: false }],
      ]);
      expect(team!.authority.decisions.map((x) => x.decisionId)).toEqual([decision]);
      const caseManager = ctxFor("caseManager");
      expect((await legal.packet(caseManager, submitted))?.packetId).toBe(submitted);
      expect((await legal.packet(caseManager, team!.legalReview.requests[0]!.packetId!))?.purpose).toBe(
        "LEGAL_REVIEW",
      );
      // No committee page for the case team: the seat basis gives them none.
      expect(await proceedings.onSeat(caseManager, f.cp)).toBeNull();

      // The reviewer's purpose ends with the decision (AMB-119), after a grace period that is none by default
      // (PURPOSE_ACCESS_GRACE_DAYS 0, AMB-229): their page is the uniform not-found from now on.
      expect(await legal.review(ctxFor("legalB"), request)).toBeNull();
    });
  });

  it("anyone but the assigned reviewer, a cancelled request and a forged id get the uniform not-found; a member's commands are refused and recorded", async () => {
    await ownerScenario(async (s) => {
      const { proceedings, legal } = servicesIn(s);
      const f = await adopted(s);
      const secretary = ctxFor("committeeSecretary");
      const request = value<string>(
        await legal.requestLegalReview(secretary, {
          packageId: f.pkg,
          assignedTo: USERS.legalB,
          findingIds: [],
          minutesIds: [],
          reason: `${SECRET}: the reason for asking.`,
        }),
      );
      const packetId = (await onSeat(proceedings, "committeeSecretary", f.cp, f.pkg)).legalReview.requests[0]!
        .packetId!;

      // A member who also holds the opinion permission, the secretary, the case team and a platform administrator: no
      // reviewer's page, each refusal recorded as ACCESS_DENIED on the request with the read's name only.
      for (const user of ["legal", "committeeSecretary", "caseManager", "platformAdmin"] as UserKey[]) {
        const ctx = ctxFor(user);
        expect(await legal.review(ctx, request), user).toBeNull();
        expect(await legal.reviewPacket(ctx, request), user).toBeNull();
        expect(await eventsOf(s, ctx.requestId), user).toEqual([
          {
            action: "ACCESS_DENIED",
            object_type: "legal_review_request",
            object_id: request,
            metadata: expect.objectContaining({ read: "legal_review_view" }),
          },
          {
            action: "ACCESS_DENIED",
            object_type: "legal_review_request",
            object_id: request,
            metadata: expect.objectContaining({ read: "legal_review_view" }),
          },
        ]);
      }
      // A forged id: the same answer.
      expect(await legal.review(ctxFor("legalB"), randomUUID())).toBeNull();

      // A platform administrator reads no packet, no choices and no committee page.
      const admin = ctxFor("platformAdmin");
      expect(await legal.packet(admin, packetId)).toBeNull();
      expect(await legal.choices(admin, f.pkg, "REQUEST")).toBeNull();
      expect(await proceedings.onSeat(admin, f.cp)).toBeNull();
      expect((await eventsOf(s, admin.requestId)).map((e) => [e.action, e.object_type])).toEqual([
        ["ACCESS_DENIED", "packet"],
        ["ACCESS_DENIED", "recommendation_package"],
        ["ACCESS_DENIED", "committee_proceeding"],
      ]);

      // A member's commands meet the database's refusal, recorded with the command and outcome only.
      const member = ctxFor("legal");
      expect(
        outcome(
          await legal.cancelLegalReviewRequest(member, {
            requestId: request,
            reason: `${SECRET}: a member's.`,
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(outcome(await legal.submitToAuthority(member, { packageId: f.pkg }))).toBe("FORBIDDEN");
      const denied = await eventsOf(s, member.requestId);
      expect(denied.map((e) => [e.action, e.object_type, e.object_id, e.metadata.command])).toEqual([
        ["COMMAND_DENIED", "command", request, "cancel_legal_review_request"],
        ["COMMAND_DENIED", "command", f.pkg, "submit_to_authority"],
      ]);
      expect(JSON.stringify(denied)).not.toContain("Synthetic");

      // While a review is open the ask page explains the command's refusal; it is not a security event.
      const open = await legal.choices(secretary, f.pkg, "REQUEST");
      expect(open).toEqual({ ok: false, code: "PACKAGE_NOT_ADOPTED" });
      expect(await eventsOf(s, secretary.requestId)).toEqual([]);

      // The secretary cancels the request from the package's card: the reviewer's page and packet close at once.
      expect(
        outcome(
          await legal.cancelLegalReviewRequest(secretary, {
            requestId: request,
            reason: `${SECRET}: the wrong reviewer was asked.`,
          }),
        ),
      ).toBe("ok");
      const reviewer = ctxFor("legalB");
      expect(await legal.review(reviewer, request)).toBeNull();
      expect(await legal.packet(reviewer, packetId)).toBeNull();
      const cancelled = await onSeat(proceedings, "committeeSecretary", f.cp, f.pkg);
      expect(cancelled.legalReview.requests.map((r) => [r.status, r.cancellation?.reason])).toEqual([
        ["CANCELLED", `${SECRET}: the wrong reviewer was asked.`],
      ]);
      expect(cancelled.capabilities.mayRequestLegalReview).toBe(true);
    });
  });

  it("a restricted case: the case owner approves from the case's approval page, then the secretary's request takes exactly the approval's reviewer", async () => {
    await ownerScenario(async (s) => {
      const { proceedings, legal } = servicesIn(s);
      // The restricted SECRET case 0003 (owner grcDirector), referred after its preliminary review and its authority's
      // approval; a cleared member adopts a corrective action. The owner connection only raises clearances.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET'
                 where id in (${USERS.committeeSecretary}, ${USERS.legalB})`;
      await seat(s, ic, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["grcDeputy", "MEMBER"],
      ]);
      await authorityRuleFor(s, "CORRECTIVE_ACTION");
      await preliminaryReferral(s, caseExec);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`;
      const [cp] = await s.tx<{ id: string }[]>`
        select api.refer_case_to_committee(${caseExec}, ${ic}, null, ${REASON}) as id`;
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp!.id}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      const [part] = await s.tx<{ id: string }[]>`
        select id from committee.meeting_participant where meeting_id = ${m!.id} and user_id = ${USERS.grcDeputy}`;
      await s.as("grcDeputy");
      await s.tx`select api.declare_meeting_conflict(${part!.id}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${m!.id}, ${REASON})`;
      await s.tx`select api.record_attendance(${part!.id}, 'PRESENT')`;
      const [pkg] = await s.tx<{ id: string }[]>`
        select api.create_recommendation_package(${cp!.id}, 'PACKAGE') as id`;
      await s.tx`select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null,
        'Synthetic: tighten the approval controls.', null, null)`;
      await s.tx`select api.submit_package_for_vote(${pkg!.id})`;
      await s.tx`select api.open_package_vote(${m!.id}, ${pkg!.id})`;
      const [vi] = await s.tx<{ id: string }[]>`
        select id from committee.vote_item where package_id = ${pkg!.id}`;
      await s.as("grcDeputy");
      await s.tx`select api.cast_vote(${vi!.id}, 'APPROVE', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi!.id}, null)`;
      await s.tx`select api.record_package_adoption(${pkg!.id})`;

      // The secretary's page says why they may not ask yet, and the ask page's choices give the command's code.
      const waiting = await onSeat(proceedings, "committeeSecretary", cp!.id, pkg!.id);
      expect([waiting.capabilities.mayRequestLegalReview, waiting.requestLegalReviewBlock]).toEqual([
        false,
        "AUTHORITY_APPROVAL_REQUIRED",
      ]);
      const secretary = ctxFor("committeeSecretary");
      expect(await legal.choices(secretary, pkg!.id, "REQUEST")).toEqual({
        ok: false,
        code: "AUTHORITY_APPROVAL_REQUIRED",
      });

      // The case's Proceedings tab shows the case owner the package; the approval page gives them the choices.
      expect((await onCase(proceedings, "grcDirector", cp!.id, pkg!.id))?.status).toBe("ADOPTED");
      const owner = ctxFor("grcDirector");
      const approve = chosen(await legal.choices(owner, pkg!.id, "APPROVE"));
      expect([approve.act, approve.restricted]).toEqual(["APPROVE", true]);
      expect(approve.reviewers.map((r) => r.userId)).toContain(USERS.legalB);
      // Nobody else approves: the secretary and a member get the command's refusal or the not-found.
      for (const user of ["committeeSecretary", "grcDeputy"] as UserKey[])
        expect(await legal.choices(ctxFor(user), pkg!.id, "APPROVE"), user).toBeNull();

      // The approval form as it sends its fields; then the page explains that one approval waits at a time.
      value<string>(
        await legal.approveRestrictedLegalReview(owner, {
          packageId: pkg!.id,
          reviewerId: USERS.legalB,
          findingIds: [],
          minutesIds: [],
          reason: `${SECRET}: the case authority's reason.`,
        }),
      );
      expect(await legal.choices(owner, pkg!.id, "APPROVE")).toEqual({
        ok: false,
        code: "APPROVAL_ALREADY_PENDING",
      });

      // The secretary's choices now: exactly the approval's reviewer, and never the approval's reason (ruling 2).
      const asked = chosen(await legal.choices(secretary, pkg!.id, "REQUEST"));
      expect([asked.restricted, asked.reviewers.map((r) => r.userId), asked.findings, asked.minutes]).toEqual(
        [true, [USERS.legalB], [], []],
      );
      expect(JSON.stringify(asked)).not.toContain("case authority's reason");
      // Another reviewer than the approval's is refused by the command.
      expect(
        outcome(
          await legal.requestLegalReview(secretary, {
            packageId: pkg!.id,
            assignedTo: USERS.legal,
            findingIds: [],
            minutesIds: [],
            reason: `${SECRET}: the reason for asking.`,
          }),
        ),
      ).toBe("INVALID:assigned_to");
      const request = value<string>(
        await legal.requestLegalReview(secretary, {
          packageId: pkg!.id,
          assignedTo: USERS.legalB,
          findingIds: [],
          minutesIds: [],
          reason: `${SECRET}: the reason for asking.`,
        }),
      );
      expect((await legal.review(ctxFor("legalB"), request))?.capabilities.mayGiveOpinion).toBe(true);
    });
  });
});
