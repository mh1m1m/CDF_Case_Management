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
          },
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
      { mayAddItem: false, maySubmitForVote: false, mayRecordAdoption: true, mayReturnToCommittee: true },
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
