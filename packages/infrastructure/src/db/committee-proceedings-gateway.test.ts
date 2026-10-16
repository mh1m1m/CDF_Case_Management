// The committee proceeding read models' mapping (Phase 12 P12-2c; ADR-056). The gateway renames keys and decides
// nothing, so these pin what the pages rely on: a capability the database left out or null reads as false (fail
// closed), a list it left out or null is empty, a position is a number, an item's flags come from
// api.recommendation_item_flags by item, and a subject is a position and a category with a label only where R1 or R2
// gave one (DISPLAY_NAME mode).
import { describe, expect, it } from "vitest";
import { toCommitteeItemsView, toCommitteeScopeChoices } from "./committee-proceedings-gateway";

type RawItems = Parameters<typeof toCommitteeItemsView>[0];
type RawScope = Parameters<typeof toCommitteeScopeChoices>[0];

const CP = "33333333-3333-4333-8333-333333333333";
const PKG = "55555555-5555-4555-8555-555555555555";
const ITEM = "66666666-6666-4666-8666-666666666666";
const ITEM2 = "67777777-7777-4777-8777-777777777777";
const M = "77777777-7777-4777-8777-777777777777";
const S = "88888888-8888-4888-8888-888888888888";
const A = "99999999-9999-4999-8999-999999999999";
const F = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VOTE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQ = "c1111111-1111-4111-8111-111111111111";
const U = "c2222222-2222-4222-8222-222222222222";
const PACKET = "c3333333-3333-4333-8333-333333333333";
const PACKET2 = "c4444444-4444-4444-8444-444444444444";
const REV = "c5555555-5555-4555-8555-555555555555";
const RULE = "c6666666-6666-4666-8666-666666666666";
const SUB = "c7777777-7777-4777-8777-777777777777";
const DEC = "c8888888-8888-4888-8888-888888888888";
const DEC2 = "c9999999-9999-4999-8999-999999999999";

describe("committee proceeding read model mapping", () => {
  it("R2 as a member reads it (2060's keys, no 2086 answers): every capability false and every list empty", () => {
    const raw = {
      committee_proceeding_id: CP,
      label_mode: "ORDINAL",
      packages: [
        {
          package_id: PKG,
          sequence_no: 1,
          status: "VOTING",
          round_no: 1,
          vote_granularity: "PACKAGE",
          items: [
            {
              item_id: ITEM,
              item_type: "CORRECTIVE_ACTION",
              sanction_code: null,
              proposed_sanction_text: null,
              verification_status: "NOT_APPLICABLE",
              description: "Synthetic: strengthen the approval controls.",
              case_wide: true,
              committee_result: null,
              requires_legal_justification: null,
              exclusivity_group: null,
              depends_on: null,
              subjects: null,
              allegations: null,
            },
          ],
        },
      ],
      finding_votes: null,
    } as unknown as RawItems;
    expect(toCommitteeItemsView(raw)).toEqual({
      committeeProceedingId: CP,
      labelMode: "ORDINAL",
      capabilities: { mayCreatePackage: false },
      packages: [
        {
          packageId: PKG,
          sequenceNo: 1,
          status: "VOTING",
          roundNo: 1,
          voteGranularity: "PACKAGE",
          items: [
            {
              itemId: ITEM,
              itemType: "CORRECTIVE_ACTION",
              sanctionCode: null,
              proposedSanctionText: null,
              verificationStatus: "NOT_APPLICABLE",
              description: "Synthetic: strengthen the approval controls.",
              caseWide: true,
              committeeResult: null,
              requiresLegalJustification: false,
              exclusivityGroup: null,
              dependsOn: [],
              subjects: [],
              allegations: [],
              flags: [],
              taintResolutions: [],
              capabilities: { mayWithdraw: false },
            },
          ],
          openVoteIn: [],
          capabilities: {
            mayAddItem: false,
            maySubmitForVote: false,
            mayRecordAdoption: false,
            mayReturnToCommittee: false,
            mayRequestLegalReview: false,
            maySubmitToAuthority: false,
            mayRecordAuthorityDecision: false,
          },
          // Before 2095 (or for a caller who runs no command): nothing to ask, submit or record, and empty halves.
          requestLegalReviewBlock: null,
          submitBlock: null,
          recordBlock: null,
          recordOutcomes: [],
          recordSupersedes: null,
          adoptedAt: null,
          decidedAt: null,
          legalReview: { required: false, requests: [] },
          authority: { rules: [], submissions: [], decisions: [], toDecide: [] },
        },
      ],
      findingVotes: [],
    });
  });

  it("R2 as the secretary reads it: the answers, the meetings a vote may open in, and each item's flags", () => {
    const raw = {
      committee_proceeding_id: CP,
      label_mode: "ORDINAL",
      capabilities: { may_create_package: true },
      packages: [
        {
          package_id: PKG,
          sequence_no: 2,
          status: "ADOPTED",
          round_no: 2,
          vote_granularity: "ITEM",
          items: [
            {
              item_id: ITEM,
              item_type: "DISCIPLINARY_SANCTION",
              sanction_code: "WARNING",
              proposed_sanction_text: null,
              verification_status: "CATALOGUE",
              description: "Synthetic: a written warning.",
              case_wide: false,
              committee_result: "APPROVED",
              requires_legal_justification: true,
              exclusivity_group: "SANCTION_OPTIONS",
              depends_on: [ITEM2],
              subjects: [{ subject_id: S, position: "2", subject_category: "EMPLOYEE", label: null }],
              allegations: [{ allegation_id: A, category: "FRAUD" }],
              capabilities: { may_withdraw: null },
              taint_resolutions: ["RE_VOTE", "CONFIRM"],
            },
            {
              item_id: ITEM2,
              item_type: "FINDING",
              sanction_code: null,
              proposed_sanction_text: null,
              verification_status: "NOT_APPLICABLE",
              description: "Synthetic: the finding stands.",
              case_wide: false,
              committee_result: "REJECTED",
              requires_legal_justification: false,
              exclusivity_group: null,
              depends_on: [],
              subjects: [],
              allegations: [],
              capabilities: { may_withdraw: true },
              taint_resolutions: [],
            },
          ],
          capabilities: {
            may_add_item: false,
            may_submit_for_vote: null,
            may_record_adoption: true,
            may_return_to_committee: true,
          },
          open_vote_in: [M],
        },
      ],
      finding_votes: [],
    } as unknown as RawItems;
    const v = toCommitteeItemsView(
      raw,
      new Map([[ITEM, ["TAINTED_BY_CONFLICT", "SANCTION_SOURCE_REQUIRED"]]]),
    );
    expect(v.capabilities).toEqual({ mayCreatePackage: true });
    const p = v.packages[0]!;
    expect([p.capabilities, p.openVoteIn]).toEqual([
      {
        mayAddItem: false,
        maySubmitForVote: false,
        mayRecordAdoption: true,
        mayReturnToCommittee: true,
        mayRequestLegalReview: false,
        maySubmitToAuthority: false,
        mayRecordAuthorityDecision: false,
      },
      [M],
    ]);
    expect(p.items[0]).toMatchObject({
      sanctionCode: "WARNING",
      requiresLegalJustification: true,
      exclusivityGroup: "SANCTION_OPTIONS",
      dependsOn: [ITEM2],
      subjects: [{ subjectId: S, position: 2, subjectCategory: "EMPLOYEE", label: null }],
      allegations: [{ allegationId: A, category: "FRAUD" }],
      flags: ["TAINTED_BY_CONFLICT", "SANCTION_SOURCE_REQUIRED"],
      taintResolutions: ["RE_VOTE", "CONFIRM"],
      capabilities: { mayWithdraw: false },
    });
    expect(p.items[1]).toMatchObject({
      flags: [],
      taintResolutions: [],
      capabilities: { mayWithdraw: true },
    });
  });

  it("R2's legal review and authority half (2095): requests, rules, submissions and decisions as the page reads them", () => {
    const raw = {
      committee_proceeding_id: CP,
      label_mode: "ORDINAL",
      capabilities: { may_create_package: false },
      packages: [
        {
          package_id: PKG,
          sequence_no: 1,
          status: "AWAITING_AUTHORITY",
          round_no: 2,
          vote_granularity: "PACKAGE",
          items: [],
          open_vote_in: [],
          capabilities: {
            may_add_item: false,
            may_submit_for_vote: false,
            may_record_adoption: false,
            may_return_to_committee: null,
            may_request_legal_review: false,
            may_submit_to_authority: false,
            may_record_authority_decision: true,
          },
          request_legal_review_block: "PACKAGE_NOT_ADOPTED",
          submit_block: "PACKAGE_NOT_ADOPTED",
          record_block: null,
          record_outcomes: ["APPROVE_AS_RECOMMENDED", "RETURN_TO_COMMITTEE"],
          record_supersedes: { decisions: "1", corrective_actions: 2 },
          adopted_at: "2026-10-01T09:00:00+03:00",
          decided_at: null,
          legal_review: {
            required: true,
            requests: [
              {
                request_id: REQ,
                package_round: 2,
                status: "OPINION_GIVEN",
                basis: "RULE",
                reason: "Synthetic: the rules require a review.",
                requested_at: "2026-10-01T10:00:00+03:00",
                reviewer: { user_id: U, display_name: "Legal Reviewer Delta", display_name_ar: null },
                opinion: "CONCURS_WITH_COMMENTS",
                opinion_text: "Synthetic: concur, with a note.",
                opinion_at: "2026-10-02T10:00:00+03:00",
                packet_id: PACKET,
                revisions: [
                  {
                    revision_id: REV,
                    revision_no: 2,
                    opinion: "CONCURS",
                    opinion_text: null,
                    given_at: "2026-10-03T10:00:00+03:00",
                  },
                ],
                cancellation: null,
                capabilities: { may_cancel: null },
              },
            ],
          },
          authority: {
            rules: [
              {
                item_type: "DISCIPLINARY_SANCTION",
                rule_id: RULE,
                authority_types: ["CEO"],
                source_status: "OWNER_DEFAULT",
                coverage: "OWNER_DEFAULT",
                setting_disagreement: null,
              },
            ],
            submissions: [
              {
                submission_id: SUB,
                package_round: 2,
                packet_id: PACKET2,
                basis: "SUBMISSION",
                submitted_at: "2026-10-04T10:00:00+03:00",
                requirements: [{ item_id: ITEM, authority_type: "CEO", rule_source_status: "OWNER_DEFAULT" }],
              },
            ],
            decisions: [
              {
                decision_id: DEC,
                package_round: 1,
                authority_type: "CEO",
                outcome: "APPROVE_PARTIALLY",
                decided_at: "2026-09-20T12:00:00+03:00",
                decided_by_label: "Synthetic: the CEO",
                recorded_at: "2026-09-21T09:00:00+03:00",
                reason: null,
                delegation_reference: null,
                source_signature: "UNSIGNED",
                unsigned_attestation: "Synthetic: attested by the secretary.",
                sources: [
                  { position: 1, reference: "DEMO-SRC-1", is_primary: true },
                  { position: 2, reference: "DEMO-SRC-2", is_primary: null },
                ],
                scope: [
                  { item_id: ITEM, item_outcome: "MODIFIED", modification: "Synthetic: a lighter sanction." },
                ],
                conditions: [
                  {
                    position: 1,
                    kind: "FOLLOW_UP_TASK",
                    item_id: null,
                    text: "Synthetic: report back.",
                    due_date: "2026-11-01",
                  },
                ],
                superseded: { superseded_by: DEC2, superseded_at: "2026-10-05T10:00:00+03:00" },
              },
            ],
            to_decide: [{ authority_type: "CEO", item_ids: [ITEM], completes_round: true }],
          },
        },
      ],
      finding_votes: [],
    } as unknown as RawItems;
    const p = toCommitteeItemsView(raw).packages[0]!;
    expect(p.capabilities).toEqual({
      mayAddItem: false,
      maySubmitForVote: false,
      mayRecordAdoption: false,
      mayReturnToCommittee: false,
      mayRequestLegalReview: false,
      maySubmitToAuthority: false,
      mayRecordAuthorityDecision: true,
    });
    expect([p.requestLegalReviewBlock, p.submitBlock, p.recordBlock]).toEqual([
      "PACKAGE_NOT_ADOPTED",
      "PACKAGE_NOT_ADOPTED",
      null,
    ]);
    expect(p.recordOutcomes).toEqual(["APPROVE_AS_RECOMMENDED", "RETURN_TO_COMMITTEE"]);
    // Counts only (ruling 3), as numbers whatever the database wrote.
    expect(p.recordSupersedes).toEqual({ decisions: 1, correctiveActions: 2 });
    expect([p.adoptedAt, p.decidedAt]).toEqual(["2026-10-01T06:00:00.000Z", null]);
    expect(p.legalReview).toEqual({
      required: true,
      requests: [
        {
          requestId: REQ,
          packageRound: 2,
          status: "OPINION_GIVEN",
          basis: "RULE",
          reason: "Synthetic: the rules require a review.",
          requestedAt: "2026-10-01T07:00:00.000Z",
          reviewer: { userId: U, displayName: "Legal Reviewer Delta", displayNameAr: null },
          opinion: "CONCURS_WITH_COMMENTS",
          opinionText: "Synthetic: concur, with a note.",
          opinionAt: "2026-10-02T07:00:00.000Z",
          packetId: PACKET,
          revisions: [
            {
              revisionId: REV,
              revisionNo: 2,
              opinion: "CONCURS",
              opinionText: null,
              givenAt: "2026-10-03T07:00:00.000Z",
            },
          ],
          cancellation: null,
          capabilities: { mayCancel: false },
        },
      ],
    });
    expect(p.authority).toEqual({
      rules: [
        {
          itemType: "DISCIPLINARY_SANCTION",
          ruleId: RULE,
          authorityTypes: ["CEO"],
          sourceStatus: "OWNER_DEFAULT",
          coverage: "OWNER_DEFAULT",
          settingDisagreement: false,
        },
      ],
      submissions: [
        {
          submissionId: SUB,
          packageRound: 2,
          packetId: PACKET2,
          basis: "SUBMISSION",
          submittedAt: "2026-10-04T07:00:00.000Z",
          requirements: [{ itemId: ITEM, authorityType: "CEO", ruleSourceStatus: "OWNER_DEFAULT" }],
        },
      ],
      decisions: [
        {
          decisionId: DEC,
          packageRound: 1,
          authorityType: "CEO",
          outcome: "APPROVE_PARTIALLY",
          decidedAt: "2026-09-20T09:00:00.000Z",
          decidedByLabel: "Synthetic: the CEO",
          recordedAt: "2026-09-21T06:00:00.000Z",
          reason: null,
          delegationReference: null,
          sourceSignature: "UNSIGNED",
          unsignedAttestation: "Synthetic: attested by the secretary.",
          sources: [
            { position: 1, reference: "DEMO-SRC-1", isPrimary: true },
            { position: 2, reference: "DEMO-SRC-2", isPrimary: false },
          ],
          scope: [{ itemId: ITEM, itemOutcome: "MODIFIED", modification: "Synthetic: a lighter sanction." }],
          conditions: [
            {
              position: 1,
              kind: "FOLLOW_UP_TASK",
              itemId: null,
              text: "Synthetic: report back.",
              dueDate: "2026-11-01",
            },
          ],
          superseded: { supersededBy: DEC2, supersededAt: "2026-10-05T07:00:00.000Z" },
        },
      ],
      toDecide: [{ authorityType: "CEO", itemIds: [ITEM], completesRound: true }],
    });
  });

  it("a vote on a finding is its result, the allegation's category and the subject, never the rationale", () => {
    const raw = {
      committee_proceeding_id: CP,
      label_mode: "DISPLAY_NAME",
      packages: [],
      finding_votes: [
        {
          vote_item_id: VOTE,
          meeting_id: M,
          sequence_no: 3,
          status: "OPEN",
          finding: {
            finding_id: F,
            version_no: 2,
            is_current_version: null,
            result: "SUBSTANTIATED",
            proceeding_role: "REFERRED",
            allegation: { allegation_id: A, category: "FRAUD" },
            subject: {
              subject_id: S,
              position: 1,
              subject_category: "CONTRACTOR",
              label: "Contractor Delta",
            },
            rationale: "Synthetic: never read by the gateway.",
          },
        },
        {
          vote_item_id: ITEM2,
          meeting_id: M,
          sequence_no: 4,
          status: "CLOSED",
          finding: {
            finding_id: F,
            version_no: 3,
            is_current_version: true,
            result: "INCONCLUSIVE",
            proceeding_role: "COMMITTEE",
            allegation: { allegation_id: A, category: "FRAUD" },
            subject: null,
          },
        },
      ],
    } as unknown as RawItems;
    const v = toCommitteeItemsView(raw);
    expect(v.findingVotes).toEqual([
      {
        voteItemId: VOTE,
        meetingId: M,
        sequenceNo: 3,
        status: "OPEN",
        finding: {
          findingId: F,
          versionNo: 2,
          isCurrentVersion: false,
          result: "SUBSTANTIATED",
          proceedingRole: "REFERRED",
          allegation: { allegationId: A, category: "FRAUD" },
          subject: { subjectId: S, position: 1, subjectCategory: "CONTRACTOR", label: "Contractor Delta" },
        },
      },
      {
        voteItemId: ITEM2,
        meetingId: M,
        sequenceNo: 4,
        status: "CLOSED",
        finding: {
          findingId: F,
          versionNo: 3,
          isCurrentVersion: true,
          result: "INCONCLUSIVE",
          proceedingRole: "COMMITTEE",
          allegation: { allegationId: A, category: "FRAUD" },
          subject: null,
        },
      },
    ]);
    expect(JSON.stringify(v)).not.toContain("rationale");
  });

  it("R1's choices: positions as numbers, a missing subject as null, times as instants and null lists empty", () => {
    expect(
      toCommitteeScopeChoices({
        committee_proceeding_id: CP,
        label_mode: "ORDINAL",
        subjects: null,
        allegations: null,
        findings: null,
      } as unknown as RawScope),
    ).toEqual({
      committeeProceedingId: CP,
      labelMode: "ORDINAL",
      subjects: [],
      allegations: [],
      findings: [],
    });
    const v = toCommitteeScopeChoices({
      committee_proceeding_id: CP,
      label_mode: "ORDINAL",
      subjects: [{ subject_id: S, position: "3", subject_category: "EMPLOYEE", label: null }],
      allegations: [{ allegation_id: A, position: "1", category: "FRAUD", status: "OPEN", subject_id: null }],
      findings: [
        {
          finding_id: F,
          allegation_id: A,
          subject_id: S,
          proceeding_role: "COMMITTEE",
          version_no: 1,
          result: "SUBSTANTIATED",
          recorded_at: "2026-10-14 09:30:00+03",
        },
      ],
    } as unknown as RawScope);
    expect(v.subjects).toEqual([{ subjectId: S, position: 3, subjectCategory: "EMPLOYEE", label: null }]);
    expect(v.allegations).toEqual([
      { allegationId: A, position: 1, category: "FRAUD", status: "OPEN", subjectId: null },
    ]);
    expect(v.findings).toEqual([
      {
        findingId: F,
        allegationId: A,
        subjectId: S,
        proceedingRole: "COMMITTEE",
        versionNo: 1,
        result: "SUBSTANTIATED",
        recordedAt: "2026-10-14T06:30:00.000Z",
      },
    ]);
  });
});
