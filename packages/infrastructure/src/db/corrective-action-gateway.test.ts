// The corrective-action read models' mapping (Phase 12 P12-3b; ADR-058, migration 2096). The gateway renames keys and
// decides nothing, so these pin what the pages rely on: a capability the database left out or null reads as false
// (fail closed), a list it left out or null is empty, timestamps are ISO instants and calendar dates stay as written,
// the case team's origin is null for anyone else, and the replacement is null unless the action is frozen. P12-6a:
// the history stays oldest first, and the policy asks for a reference unless the one in force says NOTE_ONLY.
import { describe, expect, it } from "vitest";
import { toCaseCorrectiveAction, toCorrectiveActionView } from "./corrective-action-gateway";

type RawCaseAction = Parameters<typeof toCaseCorrectiveAction>[0];
type RawView = Parameters<typeof toCorrectiveActionView>[0];

const ACTION = "11111111-1111-4111-8111-111111111111";
const NEW_ACTION = "12222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const FIRST = "44444444-4444-4444-8444-444444444444";
const SECOND = "45555555-5555-4555-8555-555555555555";
const OWNER = "a0000000-0000-4000-8000-000000000028";
const MANAGER = "a0000000-0000-4000-8000-000000000003";
const CASE = "66666666-6666-4666-8666-666666666666";
const DISPOSITION = "77777777-7777-4777-8777-777777777777";

const owner = {
  kind: "USER" as const,
  accountable_user_id: OWNER,
  sector: null,
  pool: null,
  external_party_label: null,
};

describe("A1: the case's corrective actions", () => {
  const raw: RawCaseAction = {
    action_id: ACTION,
    action_type: "CORRECTIVE_ACTION",
    sequence_no: 1,
    title: "Synthetic: approval controls",
    status: "IN_PROGRESS",
    due_date: "2026-12-31",
    percent_complete: 40,
    version_no: 1,
    owner: { ...owner, display_name: "Employee Chi", display_name_ar: null },
    source: "AUTHORITY_DECISION",
    recommendation_item_id: ITEM,
    preliminary_proposal_id: null,
    authority_decision_id: FIRST,
    governing_decision_id: FIRST,
    decision_block: "FROZEN_BY_SUPERSEDED_DECISION",
    superseded_at: "2026-10-15 12:00:00+03",
    replaced_by_action_id: null,
    replaces_action_id: null,
    may_dispose: true,
  };

  it("renames every key, keeps the calendar date and writes the supersession as an ISO instant", () => {
    expect(toCaseCorrectiveAction(raw)).toEqual({
      actionId: ACTION,
      actionType: "CORRECTIVE_ACTION",
      sequenceNo: 1,
      title: "Synthetic: approval controls",
      status: "IN_PROGRESS",
      dueDate: "2026-12-31",
      percentComplete: 40,
      versionNo: 1,
      owner: {
        kind: "USER",
        accountableUserId: OWNER,
        sector: null,
        pool: null,
        externalPartyLabel: null,
        displayName: "Employee Chi",
        displayNameAr: null,
      },
      source: "AUTHORITY_DECISION",
      recommendationItemId: ITEM,
      preliminaryProposalId: null,
      authorityDecisionId: FIRST,
      governingDecisionId: FIRST,
      decisionBlock: "FROZEN_BY_SUPERSEDED_DECISION",
      supersededAt: "2026-10-15T09:00:00.000Z",
      replacedByActionId: null,
      replacesActionId: null,
      mayDispose: true,
    });
  });

  it("reads a missing or null flag as false, and an action from a preliminary proposal with no decision", () => {
    const fromProposal = toCaseCorrectiveAction({
      ...raw,
      source: "PRELIMINARY_REVIEW",
      recommendation_item_id: null,
      preliminary_proposal_id: ITEM,
      authority_decision_id: null,
      governing_decision_id: null,
      decision_block: null,
      superseded_at: null,
      may_dispose: null as unknown as boolean,
      owner: {
        kind: "ORG_UNIT",
        accountable_user_id: OWNER,
        sector: { sector_id: CASE, code: "FIN", name_en: "Finance", name_ar: "المالية" },
        pool: null,
        external_party_label: null,
        display_name: null,
        display_name_ar: null,
      },
    });
    expect(fromProposal).toMatchObject({
      source: "PRELIMINARY_REVIEW",
      governingDecisionId: null,
      decisionBlock: null,
      supersededAt: null,
      mayDispose: false,
      owner: {
        kind: "ORG_UNIT",
        sector: { sectorId: CASE, code: "FIN", nameEn: "Finance", nameAr: "المالية" },
      },
    });
  });
});

describe("A2: one corrective action", () => {
  const card = {
    action_id: ACTION,
    action_type: "CORRECTIVE_ACTION" as const,
    sequence_no: 1,
    title: "Synthetic: approval controls",
    description: "Synthetic: a second approver above the threshold.",
    status: "OPEN" as const,
    due_date: "2026-12-31",
    percent_complete: 0,
    created_at: "2026-10-01 10:00:00+03",
    completion_submitted_at: null,
    completed_at: null,
    waived_at: null,
    updated_at: "2026-10-02 10:00:00+03",
    version_no: 2,
    versions: [
      {
        version_no: 1,
        title: "Synthetic: approval controls",
        description: "Synthetic: the first wording.",
        recorded_by: MANAGER,
        recorded_at: "2026-10-01 10:00:00+03",
      },
    ],
    owner,
    case: { case_id: null, case_number: null },
    policy: { completion_evidence: "REFERENCE_REQUIRED" as const, allowed_evidence_types: null },
    events: [],
  };
  const none = {
    may_record_progress: false,
    may_submit_completion: false,
    may_verify: false,
    may_reopen: false,
    may_waive: false,
    may_dispose: false,
    may_change_due_date: false,
    may_assign_owner: false,
    may_set_owner_kind: false,
    may_set_shared_owner_kind: false,
  };

  it("gives an owner outside the case team the card only: no origin, no case, every capability false", () => {
    const v = toCorrectiveActionView({ ...card, origin: null, capabilities: none } as RawView);
    expect(v.origin).toBeNull();
    expect(v.case).toEqual({ caseId: null, caseNumber: null });
    expect(Object.values(v.capabilities).every((x) => x === false)).toBe(true);
    expect(v.versions).toEqual([
      {
        versionNo: 1,
        title: "Synthetic: approval controls",
        description: "Synthetic: the first wording.",
        recordedBy: MANAGER,
        recordedAt: "2026-10-01T07:00:00.000Z",
      },
    ]);
    expect(v.createdAt).toBe("2026-10-01T07:00:00.000Z");
  });

  it("gives the case team the origin, and while frozen what a disposition is checked against", () => {
    const v = toCorrectiveActionView({
      ...card,
      case: { case_id: CASE, case_number: "CDF-DEMO-2026-0001" },
      origin: {
        recommendation_item_id: ITEM,
        authority_decision_id: FIRST,
        source: "AUTHORITY_DECISION",
        preliminary_proposal_id: null,
        governing_decision_id: FIRST,
        decision_block: "FROZEN_BY_SUPERSEDED_DECISION",
        dispositions: null,
        disposition_options: ["RE_ADOPT", "MODIFY", "WAIVE", "REPLACE_WITH_NEW_ACTION"],
        replacement: {
          decision_id: SECOND,
          sources: [
            { position: 1, reference: "MEMO-DEMO-2096-02", is_primary: true },
            { position: 2, reference: "MEMO-DEMO-2096-03", is_primary: null as unknown as boolean },
          ],
          may_name_owner: null as unknown as boolean,
          owner_candidates: [{ user_id: OWNER, display_name: "Employee Chi", display_name_ar: null }],
          default_due_date: null,
        },
      },
      capabilities: { ...none, may_dispose: true },
    });
    expect(v.case).toEqual({ caseId: CASE, caseNumber: "CDF-DEMO-2026-0001" });
    expect(v.origin).toMatchObject({
      decisionBlock: "FROZEN_BY_SUPERSEDED_DECISION",
      dispositions: [],
      dispositionOptions: ["RE_ADOPT", "MODIFY", "WAIVE", "REPLACE_WITH_NEW_ACTION"],
      replacement: {
        decisionId: SECOND,
        sources: [
          { position: 1, reference: "MEMO-DEMO-2096-02", isPrimary: true },
          { position: 2, reference: "MEMO-DEMO-2096-03", isPrimary: false },
        ],
        mayNameOwner: false,
        ownerCandidates: [{ userId: OWNER, displayName: "Employee Chi", displayNameAr: null }],
        defaultDueDate: null,
      },
    });
    expect(v.capabilities.mayDispose).toBe(true);
  });

  it("keeps each disposition's link to a replacement action, and no replacement once disposed", () => {
    const v = toCorrectiveActionView({
      ...card,
      status: "WAIVED",
      waived_at: "2026-10-15 13:00:00+03",
      origin: {
        recommendation_item_id: ITEM,
        authority_decision_id: FIRST,
        source: "AUTHORITY_DECISION",
        preliminary_proposal_id: null,
        governing_decision_id: FIRST,
        decision_block: "REPLACED_BY_NEW_ACTION",
        dispositions: [
          {
            disposition_id: DISPOSITION,
            disposition: "REPLACE_WITH_NEW_ACTION",
            superseded_decision_id: FIRST,
            replacement_decision_id: SECOND,
            prior_status: "OPEN",
            source_document_reference: "MEMO-DEMO-2096-02",
            revised_version_no: null,
            replacement_action_id: NEW_ACTION,
            recorded_by: MANAGER,
            recorded_at: "2026-10-15 13:00:00+03",
          },
        ],
        disposition_options: null,
        replacement: null,
      },
      capabilities: none,
    });
    expect(v.waivedAt).toBe("2026-10-15T10:00:00.000Z");
    expect(v.origin?.replacement).toBeNull();
    expect(v.origin?.dispositionOptions).toEqual([]);
    expect(v.origin?.dispositions).toEqual([
      {
        dispositionId: DISPOSITION,
        disposition: "REPLACE_WITH_NEW_ACTION",
        supersededDecisionId: FIRST,
        replacementDecisionId: SECOND,
        priorStatus: "OPEN",
        sourceDocumentReference: "MEMO-DEMO-2096-02",
        revisedVersionNo: null,
        replacementActionId: NEW_ACTION,
        recordedBy: MANAGER,
        recordedAt: "2026-10-15T10:00:00.000Z",
      },
    ]);
  });
  it("keeps the history oldest first, as ISO instants, with calendar due dates and nulls where nothing was given", () => {
    const v = toCorrectiveActionView({
      ...card,
      origin: null,
      capabilities: none,
      events: [
        {
          event_id: FIRST,
          event_type: "OPENED",
          actor_id: MANAGER,
          note: null,
          evidence_reference: null,
          evidence_type: null,
          percent_complete: null,
          due_date: "2026-12-31",
          created_at: "2026-10-01 10:00:00.123456+03",
        },
        {
          event_id: SECOND,
          event_type: "COMPLETION_SUBMITTED",
          actor_id: OWNER,
          note: "Synthetic: the second approver is in place.",
          evidence_reference: "DOC-DEMO-2026-0007",
          evidence_type: "REVISED_PROCEDURE",
          percent_complete: undefined as unknown as null,
          due_date: undefined as unknown as null,
          created_at: "2026-10-03 09:30:00+03",
        },
      ],
    });
    expect(v.events).toEqual([
      {
        eventId: FIRST,
        eventType: "OPENED",
        actorId: MANAGER,
        note: null,
        evidenceReference: null,
        evidenceType: null,
        percentComplete: null,
        dueDate: "2026-12-31",
        createdAt: "2026-10-01T07:00:00.123Z",
      },
      {
        eventId: SECOND,
        eventType: "COMPLETION_SUBMITTED",
        actorId: OWNER,
        note: "Synthetic: the second approver is in place.",
        evidenceReference: "DOC-DEMO-2026-0007",
        evidenceType: "REVISED_PROCEDURE",
        percentComplete: null,
        dueDate: null,
        createdAt: "2026-10-03T06:30:00.000Z",
      },
    ]);
  });

  it("reads a missing history as empty, and asks for a reference unless the policy in force says NOTE_ONLY", () => {
    const base = { ...card, origin: null, capabilities: none };
    const missing = toCorrectiveActionView({ ...base, events: null });
    expect(missing.events).toEqual([]);
    expect(missing.policy).toEqual({ completionEvidence: "REFERENCE_REQUIRED", allowedEvidenceTypes: null });
    // No policy in force: api.submit_corrective_action_completion asks for a reference, so the page does too.
    expect(toCorrectiveActionView({ ...base, policy: null }).policy).toEqual({
      completionEvidence: "REFERENCE_REQUIRED",
      allowedEvidenceTypes: null,
    });
    expect(
      toCorrectiveActionView({ ...base, policy: { completion_evidence: null, allowed_evidence_types: null } })
        .policy.completionEvidence,
    ).toBe("REFERENCE_REQUIRED");
    expect(
      toCorrectiveActionView({
        ...base,
        policy: {
          completion_evidence: "NOTE_ONLY",
          allowed_evidence_types: ["DOCUMENT", "CONTROL_EVIDENCE"],
        },
      }).policy,
    ).toEqual({ completionEvidence: "NOTE_ONLY", allowedEvidenceTypes: ["DOCUMENT", "CONTROL_EVIDENCE"] });
  });
});
