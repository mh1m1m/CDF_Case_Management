// The legal review read models' mapping (Phase 12 P12-3a; ADR-057). The gateway renames keys and decides nothing, so
// these pin what the pages rely on: a capability the database left out or null reads as false (fail closed), a list it
// left out or null is empty, timestamps are ISO instants, a position is a number, and a packet item reads the snapshot
// keys of both 1900 and 2030 (a packet made before 2030 names one required authority and no rule, and an opinion
// snapshotted then is the first and was never superseded). A subject in a packet keeps the name stored when the packet
// was made (the coordinator's ruling 4); the gateway never looks one up.
import { describe, expect, it } from "vitest";
import { toLegalReviewChoices, toLegalReviewView, toPacketItem, toPacketView } from "./legal-reviews-gateway";

type RawReview = Parameters<typeof toLegalReviewView>[0];
type RawChoices = Parameters<typeof toLegalReviewChoices>[0];
type RawPacket = Parameters<typeof toPacketView>[0];
type RawPacketItem = Parameters<typeof toPacketItem>[0];

const REQ = "11111111-1111-4111-8111-111111111111";
const PACKET = "12222222-2222-4222-8222-222222222222";
const PKG = "33333333-3333-4333-8333-333333333333";
const CP = "34444444-4444-4444-8444-444444444444";
const U = "44444444-4444-4444-8444-444444444444";
const U2 = "45555555-5555-4555-8555-555555555555";
const REV = "55555555-5555-4555-8555-555555555555";
const ITEM = "66666666-6666-4666-8666-666666666666";
const ITEM2 = "67777777-7777-4777-8777-777777777777";
const F = "77777777-7777-4777-8777-777777777777";
const A = "88888888-8888-4888-8888-888888888888";
const S = "99999999-9999-4999-8999-999999999999";
const MIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("L1: the assigned reviewer's request", () => {
  const raw: RawReview = {
    request_id: REQ,
    package_round: 2,
    status: "OPINION_GIVEN",
    basis: "SECRETARY_ELECTED",
    reason: "Synthetic: the secretary's reason.",
    requested_at: "2026-10-01 10:00:00+03",
    requested_by: { user_id: U, display_name: "Secretary Beta", display_name_ar: null },
    opinion: "CONCURS_WITH_COMMENTS",
    opinion_text: "Synthetic: an opinion.",
    opinion_at: "2026-10-02 10:00:00+03",
    revisions: [
      {
        revision_id: REV,
        revision_no: 2,
        opinion: "CONFLICTS",
        opinion_text: "Synthetic: a later opinion.",
        given_at: "2026-10-03 10:00:00+03",
      },
    ],
    packet_id: PACKET,
    capabilities: { may_give_opinion: false, may_give_superseding_opinion: true },
    opinion_block: "OPINION_ALREADY_GIVEN",
    superseding_opinion_block: null,
  };

  it("renames every key and writes timestamps as ISO instants", () => {
    expect(toLegalReviewView(raw)).toEqual({
      requestId: REQ,
      packageRound: 2,
      status: "OPINION_GIVEN",
      basis: "SECRETARY_ELECTED",
      reason: "Synthetic: the secretary's reason.",
      requestedAt: "2026-10-01T07:00:00.000Z",
      requestedBy: { userId: U, displayName: "Secretary Beta", displayNameAr: null },
      opinion: "CONCURS_WITH_COMMENTS",
      opinionText: "Synthetic: an opinion.",
      opinionAt: "2026-10-02T07:00:00.000Z",
      revisions: [
        {
          revisionId: REV,
          revisionNo: 2,
          opinion: "CONFLICTS",
          opinionText: "Synthetic: a later opinion.",
          givenAt: "2026-10-03T07:00:00.000Z",
        },
      ],
      packetId: PACKET,
      capabilities: { mayGiveOpinion: false, mayGiveSupersedingOpinion: true },
      opinionBlock: "OPINION_ALREADY_GIVEN",
      supersedingOpinionBlock: null,
    });
  });

  it("an assigned request with nothing given: no opinion, no revisions, and missing capabilities are false", () => {
    const v = toLegalReviewView({
      ...raw,
      status: "ASSIGNED",
      requested_by: null,
      opinion: null,
      opinion_text: null,
      opinion_at: null,
      revisions: null,
      capabilities: null,
      opinion_block: null,
      superseding_opinion_block: "OPINION_NOT_GIVEN",
    });
    expect(v).toMatchObject({
      requestedBy: null,
      opinion: null,
      opinionText: null,
      opinionAt: null,
      revisions: [],
      capabilities: { mayGiveOpinion: false, mayGiveSupersedingOpinion: false },
      opinionBlock: null,
      supersedingOpinionBlock: "OPINION_NOT_GIVEN",
    });
    expect(
      toLegalReviewView({
        ...raw,
        capabilities: { may_give_opinion: null },
      }).capabilities,
    ).toEqual({ mayGiveOpinion: false, mayGiveSupersedingOpinion: false });
  });
});

describe("L2: what a legal review may be asked for or approved with", () => {
  it("renames every key; a position is a number and a subject has a label only where L2 gave one", () => {
    const raw: RawChoices = {
      act: "REQUEST",
      package: {
        package_id: PKG,
        committee_proceeding_id: CP,
        sequence_no: 1,
        round_no: 2,
        status: "ADOPTED",
      },
      label_mode: "ORDINAL",
      restricted: true,
      items: [{ item_id: ITEM, item_type: "DISCIPLINARY_SANCTION", sanction_code: "WARNING" }],
      reviewers: [{ user_id: U2, display_name: null, display_name_ar: "مراجع قانوني دلتا" }],
      findings: [
        {
          finding_id: F,
          version_no: 3,
          result: "SUBSTANTIATED",
          proceeding_role: "COMMITTEE",
          allegation: { allegation_id: A, position: "2", category: "MISCONDUCT" },
          subject: { subject_id: S, position: "1", subject_category: "EMPLOYEE", label: null },
        },
      ],
      minutes: [
        {
          minutes_id: MIN,
          meeting_id: MEET,
          meeting_sequence_no: 4,
          version_no: 1,
          status: "APPROVED",
          finalised_at: "2026-10-01 12:00:00+03",
        },
      ],
    } as unknown as RawChoices;
    expect(toLegalReviewChoices(raw)).toEqual({
      act: "REQUEST",
      package: { packageId: PKG, committeeProceedingId: CP, sequenceNo: 1, roundNo: 2, status: "ADOPTED" },
      labelMode: "ORDINAL",
      restricted: true,
      items: [{ itemId: ITEM, itemType: "DISCIPLINARY_SANCTION", sanctionCode: "WARNING" }],
      reviewers: [{ userId: U2, displayName: null, displayNameAr: "مراجع قانوني دلتا" }],
      findings: [
        {
          findingId: F,
          versionNo: 3,
          result: "SUBSTANTIATED",
          proceedingRole: "COMMITTEE",
          allegation: { allegationId: A, position: 2, category: "MISCONDUCT" },
          subject: { subjectId: S, position: 1, subjectCategory: "EMPLOYEE", label: null },
        },
      ],
      minutes: [
        {
          minutesId: MIN,
          meetingId: MEET,
          meetingSequenceNo: 4,
          versionNo: 1,
          status: "APPROVED",
          finalisedAt: "2026-10-01T09:00:00.000Z",
        },
      ],
    });
  });

  it("lists the database left out or null are empty, and restricted is false unless it said true", () => {
    const v = toLegalReviewChoices({
      act: "APPROVE",
      package: {
        package_id: PKG,
        committee_proceeding_id: CP,
        sequence_no: 1,
        round_no: 1,
        status: "ADOPTED",
      },
      label_mode: "DISPLAY_NAME",
      restricted: null,
      items: null,
      reviewers: null,
      findings: null,
      minutes: null,
    });
    expect([v.restricted, v.items, v.reviewers, v.findings, v.minutes]).toEqual([false, [], [], [], []]);
  });
});

describe("api.open_packet: a packet's stored content", () => {
  const recommendation1900 = {
    item_type: "DISCIPLINARY_SANCTION",
    sanction_code: null,
    proposed_sanction_text: "Synthetic proposed sanction",
    verification_status: "PROPOSED_UNVERIFIED",
    description: "Synthetic: the item's description.",
    case_wide: false,
    committee_result: "APPROVED",
    subjects: [{ subject_id: S, label: "Employee Alpha", category: "EMPLOYEE" }],
    allegations: [{ allegation_id: A, category: "MISCONDUCT" }],
  };

  it("an item for legal review as 1900 stored it: no rule, no authority, no dependencies", () => {
    const item = toPacketItem({
      position: 1,
      kind: "RECOMMENDATION_ITEM",
      source_id: ITEM,
      snapshot: recommendation1900,
    });
    expect(item).toEqual({
      kind: "RECOMMENDATION_ITEM",
      position: 1,
      sourceId: ITEM,
      itemType: "DISCIPLINARY_SANCTION",
      sanctionCode: null,
      proposedSanctionText: "Synthetic proposed sanction",
      verificationStatus: "PROPOSED_UNVERIFIED",
      description: "Synthetic: the item's description.",
      caseWide: false,
      committeeResult: "APPROVED",
      // The name stored when the packet was made, whatever the proceeding's label mode is now.
      subjects: [{ subjectId: S, label: "Employee Alpha", category: "EMPLOYEE" }],
      allegations: [{ allegationId: A, category: "MISCONDUCT" }],
      requiresLegalJustification: false,
      exclusivityGroup: null,
      dependsOn: [],
      requiredAuthorities: [],
      authorityRuleSourceStatus: null,
    });
  });

  it("an item submitted before 2030 names its one required authority", () => {
    const item = toPacketItem({
      position: 1,
      kind: "RECOMMENDATION_ITEM",
      source_id: ITEM,
      snapshot: { ...recommendation1900, required_authority: "CEO" },
    });
    expect(item).toMatchObject({ requiredAuthorities: ["CEO"], authorityRuleSourceStatus: null });
  });

  it("an item submitted since 2030: every required authority, the rule's source status and the 2030 extras", () => {
    const item = toPacketItem({
      position: 2,
      kind: "RECOMMENDATION_ITEM",
      source_id: ITEM2,
      snapshot: {
        ...recommendation1900,
        case_wide: true,
        committee_result: null,
        subjects: [],
        requires_legal_justification: true,
        exclusivity_group: "G1",
        depends_on: [ITEM, 7, null],
        catalogue_version_id: "ignored",
        required_authority: "BOARD",
        required_authorities: ["BOARD", "CEO"],
        authority_rule_id: "ignored",
        authority_rule_source_status: "SOURCE_REQUIRED",
      },
    });
    expect(item).toMatchObject({
      caseWide: true,
      committeeResult: null,
      subjects: [],
      requiresLegalJustification: true,
      exclusivityGroup: "G1",
      dependsOn: [ITEM],
      requiredAuthorities: ["BOARD", "CEO"],
      authorityRuleSourceStatus: "SOURCE_REQUIRED",
    });
    expect(Object.keys(item)).not.toContain("authorityRuleId");
  });

  it("a finding, approved minutes and their votes as stored", () => {
    expect(
      toPacketItem({
        position: 3,
        kind: "FINDING",
        source_id: F,
        snapshot: {
          result: "SUBSTANTIATED",
          rationale: "Synthetic: the rationale.",
          version_no: "2",
          allegation_id: A,
          allegation_category: "MISCONDUCT",
          subject_id: null,
        },
      }),
    ).toEqual({
      kind: "FINDING",
      position: 3,
      sourceId: F,
      result: "SUBSTANTIATED",
      rationale: "Synthetic: the rationale.",
      versionNo: 2,
      allegationId: A,
      allegationCategory: "MISCONDUCT",
      subjectId: null,
    });
    expect(
      toPacketItem({
        position: 4,
        kind: "MINUTES",
        source_id: MIN,
        snapshot: {
          version_no: 1,
          status: "APPROVED",
          narrative: "Synthetic: the minutes.",
          vote_items: [
            {
              sequence_no: 1,
              target_type: "PACKAGE",
              title: "Package 1",
              result: "APPROVED",
              decided_by_casting_vote: true,
              approve: 2,
              reject: "2",
              abstain: 0,
              eligible: 5,
            },
          ],
        },
      }),
    ).toEqual({
      kind: "MINUTES",
      position: 4,
      sourceId: MIN,
      versionNo: 1,
      status: "APPROVED",
      narrative: "Synthetic: the minutes.",
      voteItems: [
        {
          sequenceNo: 1,
          targetType: "PACKAGE",
          title: "Package 1",
          result: "APPROVED",
          decidedByCastingVote: true,
          approve: 2,
          reject: 2,
          abstain: 0,
        },
      ],
    });
  });

  it("minutes without votes, and a snapshot the database left null, still read", () => {
    expect(
      toPacketItem({
        position: 1,
        kind: "MINUTES",
        source_id: MIN,
        snapshot: { version_no: 1, status: "APPROVED", narrative: "N", vote_items: null },
      }),
    ).toMatchObject({ voteItems: [] });
    expect(toPacketItem({ position: 1, kind: "FINDING", source_id: F, snapshot: null })).toMatchObject({
      rationale: "",
      versionNo: 1,
      allegationId: "",
      subjectId: null,
    });
  });

  it("an opinion snapshotted before 2030 is the first and never superseded; since 2030 it says which", () => {
    expect(
      toPacketItem({
        position: 5,
        kind: "LEGAL_OPINION",
        source_id: REQ,
        snapshot: { opinion: "CONCURS", opinion_text: null, package_round: 1, basis: "RULE" },
      }),
    ).toEqual({
      kind: "LEGAL_OPINION",
      position: 5,
      sourceId: REQ,
      opinion: "CONCURS",
      opinionText: null,
      packageRound: 1,
      revisionNo: 1,
      superseded: false,
    });
    expect(
      toPacketItem({
        position: 6,
        kind: "LEGAL_OPINION",
        source_id: OP,
        snapshot: {
          opinion: "CONFLICTS",
          opinion_text: "Synthetic: a later opinion.",
          package_round: 2,
          request_id: REQ,
          revision_no: 2,
          superseded: true,
        },
      }),
    ).toMatchObject({ revisionNo: 2, superseded: true, packageRound: 2 });
  });

  it("the packet: ISO creation time, items in the database's order, none when it listed none", () => {
    const items: RawPacketItem[] = [
      { position: 1, kind: "RECOMMENDATION_ITEM", source_id: ITEM, snapshot: recommendation1900 },
      {
        position: 2,
        kind: "LEGAL_OPINION",
        source_id: REQ,
        snapshot: { opinion: "CONCURS", package_round: 1 },
      },
    ];
    const raw: RawPacket = {
      packet_id: PACKET,
      purpose: "AUTHORITY_DECISION",
      classification: "CONFIDENTIAL",
      created_at: "2026-10-04 10:00:00+03",
      items,
    };
    const v = toPacketView(raw);
    expect([v.packetId, v.purpose, v.classification, v.createdAt]).toEqual([
      PACKET,
      "AUTHORITY_DECISION",
      "CONFIDENTIAL",
      "2026-10-04T07:00:00.000Z",
    ]);
    expect(v.items.map((i) => [i.position, i.kind])).toEqual([
      [1, "RECOMMENDATION_ITEM"],
      [2, "LEGAL_OPINION"],
    ]);
    expect(toPacketView({ ...raw, items: null }).items).toEqual([]);
  });
});
