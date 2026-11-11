// RestrictionLiftGateway over PostgreSQL (migration 2130, ADR-049; DEC-AMB-012 → C). Reads call only the read models
// api.restriction_lift_status and api.my_restriction_lift_approvals and the audited api.preview_restriction_lift; the
// gateway renames their keys, decides nothing and reads no case table. A flag the database left out or null reads as
// false (fail closed). Writes only call the 2130 commands, which take no user id. Every method runs in its own
// transaction under the caller's security context.
import type {
  RestrictionLiftApproval,
  RestrictionLiftPreview,
  RestrictionLiftPreviewResult,
  RestrictionLiftRequestView,
  RestrictionLiftStatusView,
} from "@cdf/contracts";
import type { RestrictionLiftGateway, UserRequestContext } from "@cdf/application";
import { withUserContext, type Sql, type Tx } from "./security-context";

type P<K extends keyof RestrictionLiftGateway> = Parameters<RestrictionLiftGateway[K]>[1];
type Stamp = string;

// ---- The read models' JSON, as the database writes it (snake_case; timestamps as text) -------------------------
export interface RawLiftPreview {
  classification: RestrictionLiftPreview["classification"];
  gates:
    | {
        gate: RestrictionLiftPreview["gates"][number]["gate"];
        users: number;
        roles: { role: string; users: number }[] | null;
      }[]
    | null;
  users_gaining: number | null;
  authority_approvals_ending: RestrictionLiftPreview["authorityApprovalsEnding"] | null;
}

interface RawLiftRequest {
  id: string;
  status: RestrictionLiftRequestView["status"];
  classification: RestrictionLiftRequestView["classification"];
  mine: boolean | null;
  reason: string | null;
  requested_at: Stamp;
  expires_at: Stamp;
  preview: RawLiftPreview;
  preview_hash: string;
  decided_at: Stamp | null;
  decision_reason: string | null;
  approval_preview_hash: string | null;
  approval_expires_at: Stamp | null;
  lifted_at: Stamp | null;
  ended_at: Stamp | null;
  lapsed: boolean | null;
  may_lift: boolean | null;
  lift_refusal: RestrictionLiftRequestView["liftRefusal"];
  may_withdraw: boolean | null;
  may_expire: boolean | null;
}

export interface RawLiftStatus {
  case_id: string;
  is_restricted: boolean;
  may_preview: boolean | null;
  may_request: boolean | null;
  request_refusal: RestrictionLiftStatusView["requestRefusal"];
  approver_role: string | null;
  request: RawLiftRequest | null;
}

export interface RawLiftApproval {
  id: string;
  status: RestrictionLiftApproval["status"];
  classification: RestrictionLiftApproval["classification"];
  reason: string;
  requested_at: Stamp;
  expires_at: Stamp;
  preview: RawLiftPreview;
  preview_hash: string;
  decided_by_me: boolean | null;
  approval_expires_at: Stamp | null;
  lapsed: boolean | null;
  may_decide: boolean | null;
  approve_refusal: RestrictionLiftApproval["approveRefusal"];
  may_expire: boolean | null;
}

const iso = (v: Stamp): string => new Date(v).toISOString();
const isoOrNull = (v: Stamp | null | undefined): string | null => (v ? iso(v) : null);
const yes = (v: boolean | null | undefined): boolean => v === true;

export function toLiftPreview(p: RawLiftPreview): RestrictionLiftPreview {
  return {
    classification: p.classification,
    gates: (p.gates ?? []).map((g) => ({
      gate: g.gate,
      users: g.users ?? 0,
      roles: (g.roles ?? []).map((r) => ({ role: r.role, users: r.users ?? 0 })),
    })),
    usersGaining: p.users_gaining ?? 0,
    authorityApprovalsEnding: p.authority_approvals_ending ?? [],
  };
}

export function toLiftStatus(s: RawLiftStatus): RestrictionLiftStatusView {
  const q = s.request;
  return {
    caseId: s.case_id,
    isRestricted: s.is_restricted,
    approverRole: s.approver_role ?? null,
    capabilities: { mayPreview: yes(s.may_preview), mayRequest: yes(s.may_request) },
    requestRefusal: s.request_refusal ?? null,
    request: q
      ? {
          id: q.id,
          status: q.status,
          classification: q.classification,
          mine: yes(q.mine),
          reason: q.reason ?? null,
          requestedAt: iso(q.requested_at),
          expiresAt: iso(q.expires_at),
          preview: toLiftPreview(q.preview),
          previewHash: q.preview_hash,
          decidedAt: isoOrNull(q.decided_at),
          decisionReason: q.decision_reason ?? null,
          approvalPreviewHash: q.approval_preview_hash ?? null,
          approvalExpiresAt: isoOrNull(q.approval_expires_at),
          liftedAt: isoOrNull(q.lifted_at),
          endedAt: isoOrNull(q.ended_at),
          lapsed: yes(q.lapsed),
          capabilities: {
            mayLift: yes(q.may_lift),
            mayWithdraw: yes(q.may_withdraw),
            mayExpire: yes(q.may_expire),
          },
          liftRefusal: q.lift_refusal ?? null,
        }
      : null,
  };
}

export function toLiftApprovals(rows: readonly RawLiftApproval[] | null): RestrictionLiftApproval[] {
  return (rows ?? []).map((q) => ({
    id: q.id,
    status: q.status,
    classification: q.classification,
    reason: q.reason,
    requestedAt: iso(q.requested_at),
    expiresAt: iso(q.expires_at),
    preview: toLiftPreview(q.preview),
    previewHash: q.preview_hash,
    decidedByMe: yes(q.decided_by_me),
    approvalExpiresAt: isoOrNull(q.approval_expires_at),
    lapsed: yes(q.lapsed),
    capabilities: { mayDecide: yes(q.may_decide), mayExpire: yes(q.may_expire) },
    approveRefusal: q.approve_refusal ?? null,
  }));
}

export class PostgresRestrictionLiftGateway implements RestrictionLiftGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  status(ctx: UserRequestContext, caseId: string): Promise<RestrictionLiftStatusView> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ v: RawLiftStatus }[]>`select api.restriction_lift_status(${caseId}::uuid) as v`;
      return toLiftStatus(r!.v);
    });
  }

  myApprovals(ctx: UserRequestContext): Promise<RestrictionLiftApproval[]> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<
        { v: RawLiftApproval[] | null }[]
      >`select api.my_restriction_lift_approvals() as v`;
      return toLiftApprovals(r?.v ?? null);
    });
  }

  preview(ctx: UserRequestContext, i: P<"preview">): Promise<RestrictionLiftPreviewResult> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ v: { preview: RawLiftPreview; preview_hash: string } }[]>`
        select api.preview_restriction_lift(${i.caseId}::uuid) as v`;
      return { preview: toLiftPreview(r!.v.preview), previewHash: r!.v.preview_hash };
    });
  }

  request(ctx: UserRequestContext, i: P<"request">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.request_restriction_lift(${i.caseId}::uuid, ${i.reason}, ${i.previewHash}) as id`;
      return r!.id;
    });
  }

  decide(ctx: UserRequestContext, i: P<"decide">): Promise<"APPROVED" | "REJECTED"> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ status: "APPROVED" | "REJECTED" }[]>`
        select api.decide_restriction_lift(${i.requestId}::uuid, ${i.decision}, ${i.reason}, ${i.previewHash})
          as status`;
      return r!.status;
    });
  }

  async lift(ctx: UserRequestContext, i: P<"lift">): Promise<void> {
    await this.run(ctx, (tx) => tx`select api.lift_case_restriction(${i.requestId}::uuid)`);
  }

  async expire(ctx: UserRequestContext, i: P<"expire">): Promise<void> {
    await this.run(ctx, (tx) => tx`select api.expire_restriction_lift(${i.requestId}::uuid)`);
  }

  async withdraw(ctx: UserRequestContext, i: P<"withdraw">): Promise<void> {
    await this.run(ctx, (tx) => tx`select api.withdraw_restriction_lift(${i.requestId}::uuid)`);
  }
}
