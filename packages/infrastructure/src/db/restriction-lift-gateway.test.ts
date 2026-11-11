// The restriction-lift read models' mapping (migration 2130, ADR-049). The gateway renames keys and decides nothing, so
// these pin what a page relies on: a flag the database left out or null reads as false (fail closed), the refusal
// codes pass through unchanged, and the preview is counts and role codes only. Synthetic data only.
import { describe, expect, it } from "vitest";
import { toLiftApprovals, toLiftPreview, toLiftStatus, type RawLiftStatus } from "./restriction-lift-gateway";

const CASE = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const HASH = "c".repeat(64);
const AT = "2026-10-19 09:30:00+03";
const rawPreview = {
  classification: "CONFIDENTIAL" as const,
  gates: [
    {
      gate: "CASE_VIEW_ALL" as const,
      users: 2,
      roles: [
        { role: "CASE_MANAGER", users: 1 },
        { role: "GRC_DIRECTOR", users: 1 },
      ],
    },
    { gate: "BREAK_GLASS_REQUEST" as const, users: 0, roles: null },
  ],
  users_gaining: 2,
  authority_approvals_ending: ["EXPORT_CONSENT" as const],
};

describe("restriction-lift read model mapping", () => {
  it("the preview keeps counts and role codes; a null list is empty and a missing count is zero", () => {
    expect(toLiftPreview(rawPreview)).toEqual({
      classification: "CONFIDENTIAL",
      gates: [
        {
          gate: "CASE_VIEW_ALL",
          users: 2,
          roles: [
            { role: "CASE_MANAGER", users: 1 },
            { role: "GRC_DIRECTOR", users: 1 },
          ],
        },
        { gate: "BREAK_GLASS_REQUEST", users: 0, roles: [] },
      ],
      usersGaining: 2,
      authorityApprovalsEnding: ["EXPORT_CONSENT"],
    });
    expect(
      toLiftPreview({
        classification: "SECRET",
        gates: null,
        users_gaining: null,
        authority_approvals_ending: null,
      }),
    ).toEqual({ classification: "SECRET", gates: [], usersGaining: 0, authorityApprovalsEnding: [] });
  });

  it("the authority's status: refusal codes pass through, missing flags read as false, times become ISO", () => {
    const raw = {
      case_id: CASE,
      is_restricted: true,
      may_preview: true,
      may_request: false,
      request_refusal: "LIFT_APPROVER_NOT_CONFIGURED",
      approver_role: null,
      request: null,
    } as RawLiftStatus;
    expect(toLiftStatus(raw)).toEqual({
      caseId: CASE,
      isRestricted: true,
      approverRole: null,
      capabilities: { mayPreview: true, mayRequest: false },
      requestRefusal: "LIFT_APPROVER_NOT_CONFIGURED",
      request: null,
    });
    const withRequest = toLiftStatus({
      ...raw,
      may_preview: null,
      may_request: null,
      request_refusal: "LIFT_ALREADY_REQUESTED",
      approver_role: "GRC_DIRECTOR",
      request: {
        id: REQUEST,
        status: "APPROVED",
        classification: "CONFIDENTIAL",
        mine: true,
        reason: "Synthetic: the restriction is no longer needed.",
        requested_at: AT,
        expires_at: AT,
        preview: rawPreview,
        preview_hash: HASH,
        decided_at: AT,
        decision_reason: null,
        approval_preview_hash: HASH,
        approval_expires_at: AT,
        lifted_at: null,
        ended_at: null,
        lapsed: null,
        may_lift: null,
        lift_refusal: "PREVIEW_CHANGED",
        may_withdraw: true,
        may_expire: false,
      },
    } as unknown as RawLiftStatus);
    expect(withRequest.capabilities).toEqual({ mayPreview: false, mayRequest: false });
    expect(withRequest.request).toMatchObject({
      id: REQUEST,
      status: "APPROVED",
      mine: true,
      requestedAt: "2026-10-19T06:30:00.000Z",
      approvalExpiresAt: "2026-10-19T06:30:00.000Z",
      liftedAt: null,
      lapsed: false,
      capabilities: { mayLift: false, mayWithdraw: true, mayExpire: false },
      liftRefusal: "PREVIEW_CHANGED",
    });
  });

  it("the approver's queue: no case id or case number reaches the page, and flags fail closed", () => {
    expect(toLiftApprovals(null)).toEqual([]);
    const [row] = toLiftApprovals([
      {
        id: REQUEST,
        status: "PENDING",
        classification: "CONFIDENTIAL",
        reason: "Synthetic: the restriction is no longer needed.",
        requested_at: AT,
        expires_at: AT,
        preview: rawPreview,
        preview_hash: HASH,
        decided_by_me: null,
        approval_expires_at: null,
        lapsed: false,
        may_decide: null,
        approve_refusal: "RESTRICTED_APPROVALS_PENDING",
        may_expire: undefined as unknown as null,
      },
    ]);
    expect(row).toMatchObject({
      id: REQUEST,
      decidedByMe: false,
      approvalExpiresAt: null,
      capabilities: { mayDecide: false, mayExpire: false },
      approveRefusal: "RESTRICTED_APPROVALS_PENDING",
    });
    expect(Object.keys(row!)).not.toContain("caseId");
    expect(JSON.stringify(row)).not.toContain(CASE);
  });
});
