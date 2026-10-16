// Phase 12 P12-3b, corrective actions under a superseded decision (ADR-058, migration 2096) through the real service,
// gateway, database, RLS and audit, the way the pages call them. Each test runs in one owner-connection transaction
// that is rolled back: the gateway runs its security context inside a savepoint of that transaction, exactly as it does
// on its own pool, so no action, decision or disposition reaches the seed. Who may act, and what each answer is, is
// pinned by tests/security/superseded-decision-corrective-actions.spec.ts; these pin that the pages' path carries it:
// the case's list and the action's page as the service maps them, the disposition as its form sends it, and the
// uniform not-found and denial events.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createCorrectiveActionService,
  createInvestigationService,
  type CorrectiveActionService,
} from "@cdf/application";
import type { Actor } from "@cdf/contracts";
import {
  PostgresCorrectiveActionGateway,
  PostgresInvestigationGateway,
  PostgresSecurityEventSink,
  type Sql,
} from "@cdf/infrastructure";
import { USERS, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";
import { committeeIds } from "../support/committee";
import { draftPackage, requestLegalReview, voteOnPackage, type PackageFixture } from "../support/decision";

const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });
const FIRST_SOURCE = "MEMO-DEMO-2096-INT-01";
const REPLACEMENT_SOURCES = ["MEMO-DEMO-2096-INT-02", "MEMO-DEMO-2096-INT-03"];
const DECIDED = "Synthetic: the CEO's decision, for the integration check.";
/** A manager's reason for a disposition: recorded with it, never read back (R3). */
const SECRET = "Synthetic: why the manager decided, which stays with the disposition";
const ACTION = {
  title: "Synthetic: strengthen approval controls",
  description: "Synthetic: add a second approver to payments above the threshold.",
};
const MODIFIED = {
  title: "Synthetic: a second approver above the threshold",
  description: "Synthetic: payments above the threshold need a second approver from Finance.",
};

let caseB: string, ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
});

/** The page's services bound to the scenario's transaction (each call runs in a savepoint). */
function servicesIn(s: OwnerScenario): {
  actions: CorrectiveActionService;
  actor: (user: UserKey) => Promise<Actor>;
} {
  const sql = {
    begin: (fn: (tx: unknown) => Promise<unknown>) => s.tx.savepoint(fn as never),
  } as unknown as Sql;
  const securityEvents = new PostgresSecurityEventSink(sql);
  const investigation = createInvestigationService({
    gateway: new PostgresInvestigationGateway(sql),
    securityEvents,
  });
  return {
    actions: createCorrectiveActionService({
      gateway: new PostgresCorrectiveActionGateway(sql),
      securityEvents,
    }),
    actor: async (user) => {
      const a = await investigation.loadActor(ctxFor(user));
      if (!a) throw new Error(`no actor for ${user}`);
      return a;
    },
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

/** The SECURITY events one request recorded, read back on the owner connection. */
async function eventsOf(s: OwnerScenario, requestId: string) {
  await s.asOwner();
  return s.tx<
    { action: string; object_type: string; object_id: string; metadata: Record<string, unknown> }[]
  >`
    select action, object_type, object_id, metadata from audit.audit_event
    where category = 'SECURITY' and request_id = ${requestId} order by seq`;
}

/** Legal review by legalB, then the secretary submits the package to the authority. */
async function toAuthority(s: OwnerScenario, f: PackageFixture): Promise<void> {
  const { request } = await requestLegalReview(s, f);
  await s.as("legalB");
  await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
  await s.as("committeeSecretary");
  await s.tx`select api.submit_to_authority(${f.pkg})`;
}

/** The secretary records the CEO's approval from these documents, the first one primary. */
async function decided(s: OwnerScenario, f: PackageFixture, sources: string[]): Promise<void> {
  await s.as("committeeSecretary");
  await s.tx`
    select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now(), 'Authority (synthetic)',
      ${sources[0]!}, null::jsonb, ${DECIDED}, null::text, null::text, null::text,
      ${sources.length > 1 ? sources.slice(1) : null}::text[], null::jsonb)`;
}

/**
 * A corrective action frozen by a superseded decision, as the security spec builds it: the lead's vote decides the
 * package (the legal member rejects), the CEO approves it and the case manager opens the action for financeEmployee;
 * the lead's conflict is then upheld, the committee votes again without the lead, and the CEO approves again from
 * REPLACEMENT_SOURCES. Returns the action's id.
 */
async function frozenAction(s: OwnerScenario): Promise<string> {
  await s.as("platformAdmin");
  await s.tx`select api.grant_role(${USERS.financeEmployee}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner for the test')`;
  const f = await draftPackage(s, ic, caseB);
  expect(await voteOnPackage(s, f, (_t, voter) => (voter === "legal" ? "REJECT" : "APPROVE"))).toBe(
    "ADOPTED",
  );
  await toAuthority(s, f);
  await decided(s, f, [FIRST_SOURCE]);
  await s.as("caseManager");
  const [a] = await s.tx<{ id: string }[]>`
    select api.open_corrective_action(${f.corrective}, ${ACTION.title}, ${ACTION.description},
      ${USERS.financeEmployee}, (now() at time zone 'Asia/Riyadh')::date + 5) as id`;
  await s.as("legal");
  const [c] = await s.tx<{ id: string }[]>`
    select api.raise_meeting_conflict(${f.meeting.participant.lead!}, 'Synthetic: the lead is related to the subject.') as id`;
  await s.as("committeeChair");
  await s.tx`select api.decide_meeting_conflict(${c!.id}, 'UPHELD', 'Synthetic: the relationship is confirmed.')`;
  await s.as("committeeSecretary");
  await s.tx`select api.resolve_conflict_taint(${f.sanction}, 'RE_VOTE', 'Synthetic: the committee votes again without the lead.')`;
  await s.tx`select api.open_package_vote(${f.meeting.meeting}, ${f.pkg})`;
  const [vi] = await s.tx<{ id: string }[]>`
    select vi.id from committee.vote_item vi
    join decision.recommendation_package p on p.id = vi.package_id and vi.package_round = p.round_no
    where p.id = ${f.pkg}`;
  for (const u of ["committeeChair", "legal"] as const) {
    await s.as(u);
    await s.tx`select api.cast_vote(${vi!.id}, 'APPROVE', null)`;
  }
  await s.as("committeeSecretary");
  await s.tx`select api.close_vote_item(${vi!.id}, null)`;
  await s.tx`select api.record_package_adoption(${f.pkg})`;
  await toAuthority(s, f);
  await decided(s, f, REPLACEMENT_SOURCES);
  return a!.id;
}

describe("corrective actions under a superseded decision through the service (Phase 12 P12-3b)", () => {
  it("the case team reads the frozen action on the case and on its page; a manager modifies it from a replacement document, and nothing reads the reason back", async () => {
    await ownerScenario(async (s) => {
      const { actions, actor } = servicesIn(s);
      const action = await frozenAction(s);
      const manager = await actor("caseManager");

      // The case's list (A1), as the Proceedings tab and the closure step read it.
      const row = (await actions.caseActions(ctxFor("caseManager"), caseB))?.find(
        (r) => r.actionId === action,
      );
      expect([
        row?.decisionBlock,
        row?.mayDispose,
        row?.owner.accountableUserId,
        row?.owner.displayName,
        row?.title,
      ]).toEqual([
        "FROZEN_BY_SUPERSEDED_DECISION",
        true,
        USERS.financeEmployee,
        "Employee Chi",
        ACTION.title,
      ]);
      expect(row?.supersededAt).toEqual(expect.any(String));

      // The action's page (A2): the replacement decision's documents, the owners a replacement may name.
      const v = await actions.view(ctxFor("caseManager"), action);
      expect(v?.capabilities.mayDispose).toBe(true);
      expect(v?.origin?.decisionBlock).toBe("FROZEN_BY_SUPERSEDED_DECISION");
      expect(v?.origin?.dispositionOptions).toEqual([
        "RE_ADOPT",
        "MODIFY",
        "WAIVE",
        "REPLACE_WITH_NEW_ACTION",
      ]);
      expect(v?.origin?.replacement?.sources.map((x) => [x.reference, x.isPrimary])).toEqual([
        [REPLACEMENT_SOURCES[0], true],
        [REPLACEMENT_SOURCES[1], false],
      ]);
      expect(v?.origin?.replacement?.mayNameOwner).toBe(true);
      expect(v?.origin?.replacement?.ownerCandidates.map((c) => c.userId)).toContain(USERS.financeEmployee);
      expect(v?.origin?.replacement?.defaultDueDate).toBeNull();

      // The superseded decision's own document is refused; an input refusal records no denial.
      const wrong = ctxFor("caseManager");
      expect(
        outcome(
          await actions.dispose(wrong, manager, {
            actionId: action,
            disposition: "RE_ADOPT",
            sourceDocumentReference: FIRST_SOURCE,
            reason: SECRET,
          }),
        ),
      ).toBe("INVALID:source_document_reference");
      expect(await eventsOf(s, wrong.requestId)).toEqual([]);

      // The modification as its form sends it: the second document, new wording, no due date (the action keeps its own).
      expect(
        outcome(
          await actions.dispose(ctxFor("caseManager"), manager, {
            actionId: action,
            disposition: "MODIFY",
            sourceDocumentReference: REPLACEMENT_SOURCES[1],
            reason: SECRET,
            ...MODIFIED,
          }),
        ),
      ).toBe("ok");
      const after = await actions.view(ctxFor("caseManager"), action);
      expect([
        after?.versionNo,
        after?.title,
        after?.origin?.decisionBlock,
        after?.capabilities.mayDispose,
      ]).toEqual([2, MODIFIED.title, null, false]);
      expect(after?.versions.find((x) => x.versionNo === 1)?.title).toBe(ACTION.title);
      expect(
        after?.origin?.dispositions.map((d) => [
          d.disposition,
          d.sourceDocumentReference,
          d.revisedVersionNo,
        ]),
      ).toEqual([["MODIFY", REPLACEMENT_SOURCES[1], 2]]);
      expect(after?.origin?.governingDecisionId).toBe(after?.origin?.dispositions[0]?.replacementDecisionId);
      const listed = await actions.caseActions(ctxFor("caseManager"), caseB);
      expect(listed?.find((r) => r.actionId === action)?.decisionBlock).toBeNull();
      expect(JSON.stringify([after, listed])).not.toContain(SECRET);

      // The replacement decision decides each action once: the action now carries out that decision.
      expect(
        outcome(
          await actions.dispose(ctxFor("caseManager"), manager, {
            actionId: action,
            disposition: "WAIVE",
            sourceDocumentReference: REPLACEMENT_SOURCES[0],
            reason: SECRET,
          }),
        ),
      ).toBe("CONFLICT:NOT_SUPERSEDED");
    });
  });

  it("the owner reads the card alone; anyone else, and an id that names nothing, get the uniform not-found recorded as ACCESS_DENIED; a refused disposition is COMMAND_DENIED with its outcome only", async () => {
    await ownerScenario(async (s) => {
      const { actions, actor } = servicesIn(s);
      const action = await frozenAction(s);

      // The owner: the card, nothing of the case, and no list of the case's actions.
      const card = await actions.view(ctxFor("financeEmployee"), action);
      expect([card?.title, card?.origin, card?.case, card?.capabilities.mayDispose]).toEqual([
        ACTION.title,
        null,
        { caseId: null, caseNumber: null },
        false,
      ]);
      const ownerList = ctxFor("financeEmployee");
      expect(await actions.caseActions(ownerList, caseB)).toBeNull();
      expect(await eventsOf(s, ownerList.requestId)).toEqual([
        {
          action: "ACCESS_DENIED",
          object_type: "case",
          object_id: caseB,
          metadata: { read: "case_corrective_actions" },
        },
      ]);

      // Someone with nothing to do with the case, the committee's secretary, and an id that names nothing.
      const nothing = randomUUID();
      for (const [user, id] of [
        ["records", action],
        ["committeeSecretary", action],
        ["caseManager", nothing],
      ] as const) {
        const ctx = ctxFor(user);
        expect(await actions.view(ctx, id), user).toBeNull();
        expect(await eventsOf(s, ctx.requestId), user).toEqual([
          {
            action: "ACCESS_DENIED",
            object_type: "corrective_action",
            object_id: id,
            metadata: { read: "corrective_action_view" },
          },
        ]);
      }

      // A disposition by someone without the permission, and of an action that does not exist.
      const form = {
        disposition: "RE_ADOPT",
        sourceDocumentReference: REPLACEMENT_SOURCES[0],
        reason: SECRET,
      };
      for (const [user, id, expected] of [
        ["investigatorA", action, "FORBIDDEN"],
        ["caseManager", nothing, "NOT_FOUND"],
      ] as const) {
        const ctx = ctxFor(user);
        expect(outcome(await actions.dispose(ctx, await actor(user), { ...form, actionId: id })), user).toBe(
          expected,
        );
        expect(await eventsOf(s, ctx.requestId), user).toEqual([
          {
            action: "COMMAND_DENIED",
            object_type: "command",
            object_id: id,
            metadata: { command: "dispose_superseded_corrective_action", outcome: expected },
          },
        ]);
      }
      // Still frozen: nothing was disposed of.
      expect((await actions.view(ctxFor("caseManager"), action))?.origin?.decisionBlock).toBe(
        "FROZEN_BY_SUPERSEDED_DECISION",
      );
    });
  });
});
