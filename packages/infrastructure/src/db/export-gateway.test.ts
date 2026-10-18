// The export request's read model mapping (UX redesign P12-6b-1; `api.export_request_view`, migration 2040). The
// gateway renames keys and decides nothing, so these pin what the page relies on: a capability or flag the database
// left out or null reads as false (fail closed), a list it left out is empty, timestamps are ISO instants, and the
// case stays null when the view gives none.
import { describe, expect, it } from "vitest";
import { toExportRequestView, type RawExportView } from "./export-gateway";

const REQUEST = "33333333-3333-4333-8333-333333333333";
const CASE = "11111111-1111-4111-8111-111111111111";
const REQUESTER = "a0000000-0000-4000-8000-000000000003";
const APPROVER = "a0000000-0000-4000-8000-000000000008";
const ITEM = "44444444-4444-4444-8444-444444444444";
const RECIPIENT = "55555555-5555-4555-8555-555555555555";
const APPROVAL = "66666666-6666-4666-8666-666666666666";
const HASH = "a".repeat(64);

const raw: RawExportView = {
  export_request_id: REQUEST,
  status: "SUBMITTED",
  format: "EMAIL",
  audience: "EXTERNAL",
  purpose: "REGULATORY_OR_EXTERNAL_AUTHORITY",
  external_party: "Regulator Alpha (synthetic)",
  justification: "Synthetic: the regulator asked for the case summary.",
  classification_at_submit: "CONFIDENTIAL",
  approvals_required: 2,
  authority_approval_required: false,
  matched_rules: ["EXTERNAL_CONFIDENTIAL"],
  preview_hash: HASH,
  previewed_at: "2026-10-18 12:00:00+03",
  submitted_hash: HASH,
  requested_by: REQUESTER,
  created_at: "2026-10-18 11:00:00+03",
  submitted_at: "2026-10-18 12:01:00+03",
  decided_at: null,
  generated_at: null,
  sent_at: null,
  cancelled_at: null,
  updated_at: "2026-10-18 12:30:00+03",
  row_version: 6,
  current: {
    hash: HASH,
    withheld: 0,
    refused_by_rule: false,
    approvals_required: 2,
    authority_approval_required: false,
    next_stage: 2,
    authority_consent_blocked: null,
  },
  items: [
    {
      item_id: ITEM,
      position: 1,
      object_type: "CASE_SUMMARY",
      object_id: CASE,
      added_by: REQUESTER,
      added_at: "2026-10-18 11:10:00+03",
      included: true,
    },
  ],
  recipients: [
    {
      recipient_id: RECIPIENT,
      kind: "EXTERNAL",
      user_id: null,
      email: "officer.alpha@example.test",
      added_by: REQUESTER,
      added_at: "2026-10-18 11:20:00+03",
    },
  ],
  approvals: [
    {
      approval_id: APPROVAL,
      stage: 1,
      approver_id: APPROVER,
      decision: "APPROVED",
      reason: "Synthetic: the summary is what the regulator needs.",
      decided_at: "2026-10-18 12:30:00+03",
    },
  ],
  authority_decision: null,
  case: { case_id: CASE, case_number: "CDF-DEMO-2026-0001" },
  capabilities: {
    may_add_item: false,
    may_add_recipient: false,
    may_preview: true,
    may_submit: false,
    may_approve: true,
    may_reject: true,
    may_authority_approve: false,
    may_authority_reject: false,
    may_generate: false,
    may_record_sent: false,
    may_cancel: false,
  },
};

describe("export request view mapping", () => {
  it("renames every key and writes timestamps as ISO instants", () => {
    const v = toExportRequestView(raw);
    expect(v).toMatchObject({
      requestId: REQUEST,
      status: "SUBMITTED",
      purpose: "REGULATORY_OR_EXTERNAL_AUTHORITY",
      classificationAtSubmit: "CONFIDENTIAL",
      approvalsRequired: 2,
      matchedRules: ["EXTERNAL_CONFIDENTIAL"],
      previewedAt: "2026-10-18T09:00:00.000Z",
      createdAt: "2026-10-18T08:00:00.000Z",
      submittedAt: "2026-10-18T09:01:00.000Z",
      decidedAt: null,
      updatedAt: "2026-10-18T09:30:00.000Z",
      current: { hash: HASH, withheld: 0, refusedByRule: false, nextStage: 2, authorityConsentBlocked: null },
      caseId: CASE,
      caseNumber: "CDF-DEMO-2026-0001",
      authorityDecision: null,
    });
    expect(v.items).toEqual([
      {
        itemId: ITEM,
        position: 1,
        objectType: "CASE_SUMMARY",
        objectId: CASE,
        addedBy: REQUESTER,
        addedAt: "2026-10-18T08:10:00.000Z",
        included: true,
      },
    ]);
    expect(v.recipients).toEqual([
      {
        recipientId: RECIPIENT,
        kind: "EXTERNAL",
        userId: null,
        email: "officer.alpha@example.test",
        addedBy: REQUESTER,
        addedAt: "2026-10-18T08:20:00.000Z",
      },
    ]);
    expect(v.approvals).toEqual([
      {
        approvalId: APPROVAL,
        stage: 1,
        approverId: APPROVER,
        decision: "APPROVED",
        reason: "Synthetic: the summary is what the regulator needs.",
        decidedAt: "2026-10-18T09:30:00.000Z",
      },
    ]);
    expect(v.capabilities).toEqual({
      mayAddItem: false,
      mayAddRecipient: false,
      mayPreview: true,
      maySubmit: false,
      mayApprove: true,
      mayReject: true,
      mayAuthorityApprove: false,
      mayAuthorityReject: false,
      mayGenerate: false,
      mayRecordSent: false,
      mayCancel: false,
    });
  });

  it("fails closed: null or missing flags are false, missing lists are empty, an unknown inclusion is withheld", () => {
    const v = toExportRequestView({
      ...raw,
      matched_rules: null,
      items: [{ ...raw.items[0]!, included: null }],
      recipients: null as never,
      approvals: null as never,
      case: { case_id: null, case_number: null },
      capabilities: { may_approve: null } as never,
    });
    expect(v.matchedRules).toEqual([]);
    expect(v.items[0]!.included).toBe(false);
    expect(v.recipients).toEqual([]);
    expect(v.approvals).toEqual([]);
    expect([v.caseId, v.caseNumber]).toEqual([null, null]);
    expect(Object.values(v.capabilities).every((f) => f === false)).toBe(true);
  });

  it("keeps the authority's decision apart from the approval stages", () => {
    const v = toExportRequestView({
      ...raw,
      authority_decision: {
        decided_by: APPROVER,
        decision: "REJECTED",
        reason: "Synthetic: not while the case is restricted.",
        decided_at: "2026-10-18 13:00:00+03",
      },
    });
    expect(v.authorityDecision).toEqual({
      decidedBy: APPROVER,
      decision: "REJECTED",
      reason: "Synthetic: not while the case is restricted.",
      decidedAt: "2026-10-18T10:00:00.000Z",
    });
    expect(v.approvals).toHaveLength(1);
  });
});
