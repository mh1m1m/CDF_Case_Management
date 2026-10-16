// The legal review and authority service (Phase 12 P12-3a; ADR-057). L1 and the packet read are null, the uniform
// not-found recorded as ACCESS_DENIED, for whoever the database refuses; the reviewer's packet is read only after L1
// names it; L2 answers the command's refusal code for a CONFLICT and null for a refusal of the caller; each command
// validates before the gateway, and a refusal is recorded as COMMAND_DENIED with the command and outcome only, never
// the reason or the opinion. Who may act, and when, is the database's:
// tests/security/legal-review-and-authority-read-models.spec.ts; the whole path is tests/integration/legal-reviews.spec.ts.
import { describe, expect, it } from "vitest";
import type { SecurityEvent } from "@cdf/audit";
import type { LegalReviewChoices, LegalReviewView, PacketView } from "@cdf/contracts";
import { createLegalReviewsService, type LegalReviewsGateway } from "./legal-reviews";

const REQUEST = "11111111-1111-4111-8111-111111111111";
const PACKET = "12222222-2222-4222-8222-222222222222";
const PACKAGE = "33333333-3333-4333-8333-333333333333";
const REVIEWER = "44444444-4444-4444-8444-444444444444";
const FINDING = "55555555-5555-4555-8555-555555555555";
const MINUTES = "66666666-6666-4666-8666-666666666666";
const ITEM = "77777777-7777-4777-8777-777777777777";
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000003",
  requestId: "22222222-2222-4222-8222-222222222222",
};

const review = { requestId: REQUEST, packetId: PACKET, status: "ASSIGNED" } as unknown as LegalReviewView;
const packet = { packetId: PACKET, purpose: "LEGAL_REVIEW" } as unknown as PacketView;
const choices = { act: "REQUEST", restricted: false, reviewers: [] } as unknown as LegalReviewChoices;

/** Each read answers its value, or throws its refusal; `refusal` is every command's answer. */
function harness(
  o: {
    review?: string;
    packet?: string;
    choices?: string;
    refusal?: string;
    recordFails?: boolean;
  } = {},
) {
  const calls: unknown[][] = [];
  const events: SecurityEvent[] = [];
  const fail = (e: string | undefined) => {
    if (e) throw new Error(e);
  };
  const answer =
    (name: string, value: unknown = undefined) =>
    async (_: unknown, input: unknown) => {
      calls.push([name, input]);
      fail(o.refusal);
      return value;
    };
  const gateway: LegalReviewsGateway = {
    review: async (_, requestId) => {
      calls.push(["review", requestId]);
      fail(o.review);
      return review;
    },
    choices: async (_, packageId, act) => {
      calls.push(["choices", packageId, act]);
      fail(o.choices);
      return choices;
    },
    openPacket: async (_, packetId) => {
      calls.push(["openPacket", packetId]);
      fail(o.packet);
      return packet;
    },
    requestLegalReview: answer("requestLegalReview", REQUEST) as LegalReviewsGateway["requestLegalReview"],
    approveRestrictedLegalReview: answer(
      "approveRestrictedLegalReview",
      ITEM,
    ) as LegalReviewsGateway["approveRestrictedLegalReview"],
    cancelLegalReviewRequest: answer(
      "cancelLegalReviewRequest",
      ITEM,
    ) as LegalReviewsGateway["cancelLegalReviewRequest"],
    giveLegalOpinion: answer("giveLegalOpinion") as LegalReviewsGateway["giveLegalOpinion"],
    giveSupersedingLegalOpinion: answer(
      "giveSupersedingLegalOpinion",
      ITEM,
    ) as LegalReviewsGateway["giveSupersedingLegalOpinion"],
    submitToAuthority: answer("submitToAuthority", PACKET) as LegalReviewsGateway["submitToAuthority"],
    recordAuthorityDecision: answer(
      "recordAuthorityDecision",
      ITEM,
    ) as LegalReviewsGateway["recordAuthorityDecision"],
  };
  const service = createLegalReviewsService({
    gateway,
    securityEvents: {
      record: async (e) => {
        if (o.recordFails) throw new Error("sink down");
        events.push(e);
      },
    },
  });
  return { service, calls, events };
}

describe("the reviewer's page and the packets", () => {
  it("L1 for the assignee; null and an ACCESS_DENIED event for anyone the database refuses", async () => {
    expect(await harness().service.review(ctx, REQUEST)).toBe(review);
    for (const refusal of ["CDF_NOT_FOUND", "CDF_FORBIDDEN"]) {
      const { service, events } = harness({ review: refusal });
      expect(await service.review(ctx, REQUEST), refusal).toBeNull();
      expect(events, refusal).toEqual([
        {
          action: "ACCESS_DENIED",
          objectType: "legal_review_request",
          objectId: REQUEST,
          metadata: { read: "legal_review_view" },
        },
      ]);
    }
  });

  it("the reviewer's packet is the one L1 names, read through the audited packet read", async () => {
    const { service, calls, events } = harness();
    expect(await service.reviewPacket(ctx, REQUEST)).toEqual({ review, packet });
    expect(calls).toEqual([
      ["review", REQUEST],
      ["openPacket", PACKET],
    ]);
    expect(events).toEqual([]);
  });

  it("no packet is read for a request L1 refuses (another reviewer, a cancelled request, a member)", async () => {
    const { service, calls, events } = harness({ review: "CDF_NOT_FOUND" });
    expect(await service.reviewPacket(ctx, REQUEST)).toBeNull();
    expect(calls).toEqual([["review", REQUEST]]);
    expect(events.map((e) => e.objectType)).toEqual(["legal_review_request"]);
  });

  it("a packet the database refuses after L1 (closed meanwhile) is null and recorded on the packet", async () => {
    const { service, events } = harness({ packet: "CDF_NOT_FOUND" });
    expect(await service.reviewPacket(ctx, REQUEST)).toBeNull();
    expect(events).toEqual([
      { action: "ACCESS_DENIED", objectType: "packet", objectId: PACKET, metadata: { read: "open_packet" } },
    ]);
  });

  it("a packet R2 named is read alone; a refusal is null and an ACCESS_DENIED event", async () => {
    expect(await harness().service.packet(ctx, PACKET)).toBe(packet);
    const { service, events } = harness({ packet: "CDF_FORBIDDEN" });
    expect(await service.packet(ctx, PACKET)).toBeNull();
    expect(events).toEqual([
      { action: "ACCESS_DENIED", objectType: "packet", objectId: PACKET, metadata: { read: "open_packet" } },
    ]);
  });

  it("any other failure surfaces as a safe error, and a sink failure never masks the refusal", async () => {
    await expect(harness({ review: "connection reset" }).service.review(ctx, REQUEST)).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
    await expect(
      harness({ packet: "connection reset" }).service.reviewPacket(ctx, REQUEST),
    ).rejects.toMatchObject({ kind: "UNAVAILABLE" });
    await expect(harness({ packet: "CDF_CONFLICT:X" }).service.packet(ctx, PACKET)).rejects.toMatchObject({
      kind: "CONFLICT",
    });
    const { service, events } = harness({ review: "CDF_NOT_FOUND", recordFails: true });
    expect(await service.review(ctx, REQUEST)).toBeNull();
    expect(events).toEqual([]);
  });
});

describe("L2: what a legal review may be asked for or approved with", () => {
  it("asks for the act given and answers the choices", async () => {
    const { service, calls } = harness();
    expect(await service.choices(ctx, PACKAGE, "APPROVE")).toEqual({ ok: true, choices });
    expect(calls).toEqual([["choices", PACKAGE, "APPROVE"]]);
  });

  it("the command's refusal code for a CONFLICT, which the page explains, and no security event", async () => {
    for (const code of ["LEGAL_REVIEW_OPEN", "TAINTED_BY_CONFLICT", "APPROVAL_ALREADY_PENDING"]) {
      const { service, events } = harness({ choices: `CDF_CONFLICT:${code}` });
      expect(await service.choices(ctx, PACKAGE, "REQUEST"), code).toEqual({ ok: false, code });
      expect(events, code).toEqual([]);
    }
  });

  it("null and an ACCESS_DENIED event on the package for whoever the database refuses", async () => {
    for (const refusal of ["CDF_NOT_FOUND", "CDF_FORBIDDEN"]) {
      const { service, events } = harness({ choices: refusal });
      expect(await service.choices(ctx, PACKAGE, "REQUEST"), refusal).toBeNull();
      expect(events, refusal).toEqual([
        {
          action: "ACCESS_DENIED",
          objectType: "recommendation_package",
          objectId: PACKAGE,
          metadata: { read: "legal_review_choices" },
        },
      ]);
    }
    await expect(
      harness({ choices: "connection reset" }).service.choices(ctx, PACKAGE, "REQUEST"),
    ).rejects.toMatchObject({ kind: "UNAVAILABLE" });
  });
});

describe("legal review and authority commands", () => {
  const reason = "Synthetic: a reason that must stay in the committee.";
  const opinionText = "Synthetic: an opinion that must stay with the reviewer.";
  const request = {
    packageId: PACKAGE,
    assignedTo: REVIEWER,
    findingIds: [FINDING],
    minutesIds: [MINUTES],
    reason,
  };
  const decision = {
    packageId: PACKAGE,
    authorityType: "CEO",
    outcome: "APPROVE_AS_RECOMMENDED",
    decidedAt: "2026-10-01T10:00",
    decidedByLabel: "Synthetic Authority Alpha",
    sourceDocumentReference: "SYN-DOC-0001",
    reason,
  };

  it("validates before the gateway: a malformed command never reaches the database", async () => {
    const { service, calls } = harness();
    const results = [
      await service.requestLegalReview(ctx, { ...request, assignedTo: "" }),
      await service.approveRestrictedLegalReview(ctx, {
        ...request,
        reviewerId: REVIEWER,
        findingIds: [FINDING, FINDING],
      }),
      await service.cancelLegalReviewRequest(ctx, { requestId: REQUEST, reason: "no" }),
      await service.giveLegalOpinion(ctx, { requestId: REQUEST, opinion: "CONCURS_WITH_COMMENTS" }),
      await service.giveSupersedingLegalOpinion(ctx, { requestId: REQUEST, opinion: "MAYBE" }),
      await service.submitToAuthority(ctx, { packageId: "not-an-id" }),
      await service.recordAuthorityDecision(ctx, { ...decision, decidedAt: "2999-01-01T10:00" }),
    ];
    for (const r of results) expect(r.ok === false && "fieldErrors" in r).toBe(true);
    expect(calls).toEqual([]);
  });

  it("passes the parsed command to the gateway and returns its answer", async () => {
    const { service, calls, events } = harness();
    expect(await service.requestLegalReview(ctx, request)).toEqual({ ok: true, value: REQUEST });
    expect(
      await service.giveLegalOpinion(ctx, { requestId: REQUEST, opinion: "CONCURS", opinionText: "" }),
    ).toEqual({ ok: true, value: undefined });
    expect(await service.recordAuthorityDecision(ctx, decision)).toEqual({ ok: true, value: ITEM });
    expect(calls).toEqual([
      ["requestLegalReview", request],
      ["giveLegalOpinion", { requestId: REQUEST, opinion: "CONCURS", opinionText: undefined }],
      [
        "recordAuthorityDecision",
        {
          ...decision,
          decidedAt: "2026-10-01T07:00:00.000Z",
          sourceSignature: undefined,
          unsignedAttestation: undefined,
          delegationReference: undefined,
          additionalSourceReferences: [],
          itemOutcomes: undefined,
          conditions: undefined,
        },
      ],
    ]);
    expect(events).toEqual([]);
  });

  it("names each command as the database does, on its object, and never logs a reason or an opinion", async () => {
    const opinion = { requestId: REQUEST, opinion: "CONCURS_WITH_COMMENTS", opinionText };
    const cases: [string, string, (s: ReturnType<typeof harness>["service"]) => Promise<unknown>][] = [
      ["request_legal_review", PACKAGE, (s) => s.requestLegalReview(ctx, request)],
      [
        "approve_restricted_legal_review",
        PACKAGE,
        (s) => s.approveRestrictedLegalReview(ctx, { ...request, reviewerId: REVIEWER }),
      ],
      [
        "cancel_legal_review_request",
        REQUEST,
        (s) => s.cancelLegalReviewRequest(ctx, { requestId: REQUEST, reason }),
      ],
      ["give_legal_opinion", REQUEST, (s) => s.giveLegalOpinion(ctx, opinion)],
      ["give_superseding_legal_opinion", REQUEST, (s) => s.giveSupersedingLegalOpinion(ctx, opinion)],
      ["submit_to_authority", PACKAGE, (s) => s.submitToAuthority(ctx, { packageId: PACKAGE })],
      ["record_authority_decision", PACKAGE, (s) => s.recordAuthorityDecision(ctx, decision)],
    ];
    for (const refusal of ["CDF_FORBIDDEN", "CDF_NOT_FOUND"]) {
      const outcome = refusal.slice(4);
      for (const [command, objectId, run] of cases) {
        const { service, events } = harness({ refusal });
        const r = (await run(service)) as { ok: boolean; error?: { kind: string } };
        expect(r.ok === false && r.error?.kind, command).toBe(outcome);
        expect(events, command).toEqual([
          {
            action: "COMMAND_DENIED",
            objectType: "command",
            objectId,
            metadata: { command, outcome },
          },
        ]);
        expect(JSON.stringify(events)).not.toContain("Synthetic");
      }
    }
  });

  it("a business conflict comes back with its code and is not a security event", async () => {
    const { service, events } = harness({ refusal: "CDF_CONFLICT:AUTHORITY_ALREADY_DECIDED" });
    const r = await service.recordAuthorityDecision(ctx, decision);
    expect(r.ok === false && "error" in r && [r.error.kind, r.error.detail]).toEqual([
      "CONFLICT",
      "AUTHORITY_ALREADY_DECIDED",
    ]);
    expect(events).toEqual([]);
  });
});
