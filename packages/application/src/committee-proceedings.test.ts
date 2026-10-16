// The committee proceeding service (Phase 12 P12-2c; ADR-056). The page is found only through the caller's own seats
// (the seat basis of 2085), so the case team gets the uniform not-found; R1 and the catalogue are read only for whoever
// builds packages now, by R2's own answers; each command validates before the gateway, and a refusal is recorded as
// COMMAND_DENIED with the command and outcome only, never the reason, description or proposed sanction. Who may act,
// and when, is the database's: tests/security/package-builder-and-invite-choices.spec.ts; the whole path is
// tests/integration/committee-proceedings.spec.ts.
import { describe, expect, it } from "vitest";
import type { SecurityEvent } from "@cdf/audit";
import type { CommitteeItemsView } from "@cdf/contracts";
import type { CommitteesGateway } from "./committees";
import {
  buildsPackages,
  createCommitteeProceedingsService,
  type CommitteeProceedingsGateway,
} from "./committee-proceedings";

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "12222222-2222-4222-8222-222222222222";
const PROCEEDING = "33333333-3333-4333-8333-333333333333";
const OTHER = "34444444-4444-4444-8444-444444444444";
const PACKAGE = "55555555-5555-4555-8555-555555555555";
const ITEM = "66666666-6666-4666-8666-666666666666";
const MEETING = "77777777-7777-4777-8777-777777777777";
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000003",
  requestId: "22222222-2222-4222-8222-222222222222",
};

const noPackage = {
  mayAddItem: false,
  maySubmitForVote: false,
  mayRecordAdoption: false,
  mayReturnToCommittee: false,
};
/** R2 with the caller's answers: may create a package, and a package that may (or may not) take items. */
function items(mayCreatePackage: boolean, mayAddItem?: boolean): CommitteeItemsView {
  return {
    committeeProceedingId: PROCEEDING,
    labelMode: "ORDINAL",
    capabilities: { mayCreatePackage },
    packages:
      mayAddItem === undefined
        ? []
        : [
            {
              packageId: PACKAGE,
              sequenceNo: 1,
              status: "DRAFT",
              roundNo: 1,
              voteGranularity: "ITEM",
              items: [],
              openVoteIn: [],
              capabilities: { ...noPackage, mayAddItem },
            },
          ],
    findingVotes: [],
  };
}
const scope = {
  committeeProceedingId: PROCEEDING,
  labelMode: "ORDINAL",
  subjects: [],
  allegations: [],
  findings: [],
};
const catalogue = [
  { code: "WARNING", versionNo: 1, sourceStatus: "SOURCE_REQUIRED", subjectCategories: ["EMPLOYEE"] },
];

/** Each committee's page lists `proceedings`; a committee in `refused` answers NOT_FOUND (a seat ending meanwhile). */
function harness(
  o: {
    seats?: string[];
    proceedings?: Record<string, string[]>;
    refused?: string[];
    items?: CommitteeItemsView | string;
    scope?: string;
    refusal?: string;
    committeesFail?: string;
  } = {},
) {
  const calls: unknown[][] = [];
  const events: SecurityEvent[] = [];
  const fail = (e: string | undefined) => {
    if (e) throw new Error(e);
  };
  const committees = {
    myCommittees: async () => {
      calls.push(["myCommittees"]);
      fail(o.committeesFail);
      return (o.seats ?? [C1]).map((committeeId) => ({ committeeId }));
    },
    committeeView: async (_: unknown, committeeId: string) => {
      calls.push(["committeeView", committeeId]);
      if (o.refused?.includes(committeeId)) throw new Error("CDF_NOT_FOUND");
      return {
        committee: { committeeId, code: "IC", kind: "INVESTIGATION", isActive: true },
        mySeat: { seat: "SECRETARY" },
        proceedings: (o.proceedings?.[committeeId] ?? [PROCEEDING]).map((committeeProceedingId) => ({
          committeeProceedingId,
        })),
      };
    },
  } as unknown as CommitteesGateway;
  const answer =
    (name: string, value: unknown = undefined) =>
    async (_: unknown, input?: unknown) => {
      calls.push(input === undefined ? [name] : [name, input]);
      fail(o.refusal);
      return value;
    };
  const gateway = {
    itemsView: async (_: unknown, id: string) => {
      calls.push(["itemsView", id]);
      if (typeof o.items === "string") throw new Error(o.items);
      return o.items ?? items(false);
    },
    scopeChoices: async (_: unknown, id: string) => {
      calls.push(["scopeChoices", id]);
      fail(o.scope);
      return scope;
    },
    sanctionCatalogue: async () => {
      calls.push(["sanctionCatalogue"]);
      return catalogue;
    },
    createPackage: answer("createPackage", PACKAGE),
    addItem: answer("addItem", ITEM),
    withdrawItem: answer("withdrawItem"),
    submitForVote: answer("submitForVote", 2),
    openPackageVote: answer("openPackageVote", 3),
    recordAdoption: answer("recordAdoption", "ADOPTED"),
    returnToCommittee: answer("returnToCommittee", ITEM),
    resolveTaint: answer("resolveTaint", ITEM),
  } as unknown as CommitteeProceedingsGateway;
  const service = createCommitteeProceedingsService({
    committees,
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events };
}

describe("committee proceeding page", () => {
  it("a proceeding none of the caller's seats lists is null and an ACCESS_DENIED event, and nothing else is read", async () => {
    const { service, calls, events } = harness({ proceedings: { [C1]: [OTHER] } });
    expect(await service.proceeding(ctx, PROCEEDING)).toBeNull();
    expect(calls).toEqual([["myCommittees"], ["committeeView", C1]]);
    expect(events).toEqual([
      {
        action: "ACCESS_DENIED",
        objectType: "committee_proceeding",
        objectId: PROCEEDING,
        metadata: { read: "committee_proceeding" },
      },
    ]);
    // No seat at all (the case team, a platform administrator): the same answer.
    const none = harness({ seats: [] });
    expect(await none.service.proceeding(ctx, PROCEEDING)).toBeNull();
    expect(none.events.map((e) => e.action)).toEqual(["ACCESS_DENIED"]);
  });

  it("a committee page refused meanwhile is skipped, and the next seat may list the proceeding", async () => {
    const { service, events } = harness({ seats: [C1, C2], refused: [C1] });
    const page = await service.proceeding(ctx, PROCEEDING);
    expect(page?.committee).toEqual({ committeeId: C2, code: "IC", kind: "INVESTIGATION" });
    expect(page?.mySeat).toBe("SECRETARY");
    expect(events).toEqual([]);
  });

  it("whoever builds no package reads R2 only: no choices and no catalogue", async () => {
    const { service, calls } = harness({ items: items(false, false) });
    const page = await service.proceeding(ctx, PROCEEDING);
    expect(page).toMatchObject({ scope: null, catalogue: [] });
    expect(page?.items?.packages).toHaveLength(1);
    expect(calls.map((c) => c[0])).toEqual(["myCommittees", "committeeView", "itemsView"]);
  });

  it("R2 refusing a seat holder (a conflict declared in one of its meetings) shows the proceeding without packages", async () => {
    const { service, calls, events } = harness({ items: "CDF_NOT_FOUND" });
    expect(await service.proceeding(ctx, PROCEEDING)).toMatchObject({
      items: null,
      scope: null,
      catalogue: [],
    });
    expect(calls.map((c) => c[0])).not.toContain("scopeChoices");
    expect(events).toEqual([]);
  });

  it("whoever may create a package reads R1; the catalogue only once a package may take items", async () => {
    const creates = harness({ items: items(true) });
    expect(await creates.service.proceeding(ctx, PROCEEDING)).toMatchObject({ scope, catalogue: [] });
    expect(creates.calls.map((c) => c[0])).not.toContain("sanctionCatalogue");

    const adds = harness({ items: items(false, true) });
    expect(await adds.service.proceeding(ctx, PROCEEDING)).toMatchObject({ scope, catalogue });
    expect(adds.calls.slice(-2)).toEqual([["scopeChoices", PROCEEDING], ["sanctionCatalogue"]]);
  });

  it("R1 refusing the builder (a closed proceeding, CDF-226) leaves the builder out", async () => {
    for (const refusal of ["CDF_NOT_FOUND", "CDF_FORBIDDEN", "CDF_CONFLICT:CASE_NOT_ACTIVE"]) {
      const { service, calls, events } = harness({ items: items(true, true), scope: refusal });
      expect(await service.proceeding(ctx, PROCEEDING), refusal).toMatchObject({
        scope: null,
        catalogue: [],
      });
      expect(calls.map((c) => c[0])).not.toContain("sanctionCatalogue");
      expect(events).toEqual([]);
    }
  });

  it("any other failure surfaces as a safe error", async () => {
    await expect(
      harness({ committeesFail: "connection reset" }).service.proceeding(ctx, PROCEEDING),
    ).rejects.toMatchObject({ kind: "UNAVAILABLE" });
    await expect(
      harness({ items: "connection reset" }).service.proceeding(ctx, PROCEEDING),
    ).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
    await expect(
      harness({ items: items(true), scope: "connection reset" }).service.proceeding(ctx, PROCEEDING),
    ).rejects.toMatchObject({ kind: "UNAVAILABLE" });
  });

  it("R1 alone, for a vote on a finding, is null for whoever the database refuses", async () => {
    expect(await harness().service.scopeChoices(ctx, PROCEEDING)).toEqual(scope);
    for (const refusal of ["CDF_NOT_FOUND", "CDF_FORBIDDEN", "CDF_CONFLICT:PROCEEDING_NOT_OPEN"]) {
      expect(await harness({ scope: refusal }).service.scopeChoices(ctx, PROCEEDING), refusal).toBeNull();
    }
    await expect(
      harness({ scope: "connection reset" }).service.scopeChoices(ctx, PROCEEDING),
    ).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
  });

  it("builds packages by R2's own answers", () => {
    expect(buildsPackages(null)).toBe(false);
    expect(buildsPackages(items(false))).toBe(false);
    expect(buildsPackages(items(false, false))).toBe(false);
    expect(buildsPackages(items(true))).toBe(true);
    expect(buildsPackages(items(false, true))).toBe(true);
  });
});

describe("package commands", () => {
  const reason = "Synthetic: a reason that must stay in the committee.";
  const description = "Synthetic: a description that must stay in the committee.";
  const item = {
    packageId: PACKAGE,
    itemType: "DISCIPLINARY_SANCTION",
    proposedSanctionText: "Synthetic proposed sanction",
    description,
    subjectIds: [ITEM],
    requiresLegalJustification: false,
  };

  it("validates before the gateway: a malformed command never reaches the database", async () => {
    const { service, calls } = harness();
    const r = await service.addItem(ctx, { ...item, subjectIds: [] });
    expect(r.ok === false && "fieldErrors" in r).toBe(true);
    const t = await service.resolveTaint(ctx, { itemId: ITEM, resolution: "IGNORE", reason });
    expect(t.ok === false && "fieldErrors" in t).toBe(true);
    const c = await service.createPackage(ctx, {
      committeeProceedingId: PROCEEDING,
      voteGranularity: "BOTH",
    });
    expect(c.ok === false && "fieldErrors" in c).toBe(true);
    expect(calls).toEqual([]);
  });

  it("passes the parsed command to the gateway and returns its answer", async () => {
    const { service, calls, events } = harness();
    expect(await service.addItem(ctx, { ...item, exclusivityGroup: "" })).toEqual({ ok: true, value: ITEM });
    expect(await service.openPackageVote(ctx, { meetingId: MEETING, packageId: PACKAGE })).toEqual({
      ok: true,
      value: 3,
    });
    expect(calls).toEqual([
      [
        "addItem",
        {
          ...item,
          sanctionCode: undefined,
          exclusivityGroup: undefined,
          allegationIds: [],
          dependsOnItemIds: [],
        },
      ],
      ["openPackageVote", { meetingId: MEETING, packageId: PACKAGE }],
    ]);
    expect(events).toEqual([]);
  });

  it("names each command as the database does, on its object, and never logs a reason or a description", async () => {
    const cases: [string, string, (s: ReturnType<typeof harness>["service"]) => Promise<unknown>][] = [
      [
        "create_recommendation_package",
        PROCEEDING,
        (s) => s.createPackage(ctx, { committeeProceedingId: PROCEEDING, voteGranularity: "PACKAGE" }),
      ],
      ["add_recommendation_item", PACKAGE, (s) => s.addItem(ctx, item)],
      ["withdraw_recommendation_item", ITEM, (s) => s.withdrawItem(ctx, { itemId: ITEM, reason })],
      ["submit_package_for_vote", PACKAGE, (s) => s.submitForVote(ctx, { packageId: PACKAGE })],
      [
        "open_package_vote",
        PACKAGE,
        (s) => s.openPackageVote(ctx, { meetingId: MEETING, packageId: PACKAGE }),
      ],
      ["record_package_adoption", PACKAGE, (s) => s.recordAdoption(ctx, { packageId: PACKAGE })],
      [
        "return_package_to_committee",
        PACKAGE,
        (s) => s.returnToCommittee(ctx, { packageId: PACKAGE, reason }),
      ],
      [
        "resolve_conflict_taint",
        ITEM,
        (s) => s.resolveTaint(ctx, { itemId: ITEM, resolution: "RE_VOTE", reason }),
      ],
    ];
    for (const [command, objectId, run] of cases) {
      const { service, events } = harness({ refusal: "CDF_FORBIDDEN" });
      const r = (await run(service)) as { ok: boolean; error?: { kind: string } };
      expect(r.ok === false && r.error?.kind, command).toBe("FORBIDDEN");
      expect(events, command).toEqual([
        {
          action: "COMMAND_DENIED",
          objectType: "command",
          objectId,
          metadata: { command, outcome: "FORBIDDEN" },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("Synthetic");
    }
  });

  it("a business conflict comes back with its code and is not a security event", async () => {
    const { service, events } = harness({ refusal: "CDF_CONFLICT:RESULT_MAY_CHANGE" });
    const r = await service.resolveTaint(ctx, { itemId: ITEM, resolution: "CONFIRM", reason });
    expect(r.ok === false && "error" in r && [r.error.kind, r.error.detail]).toEqual([
      "CONFLICT",
      "RESULT_MAY_CHANGE",
    ]);
    expect(events).toEqual([]);
  });
});
