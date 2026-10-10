// RecordsGateway over PostgreSQL (CDF-71; ADR-013, ADR-014). Reads go through RLS or the definer read
// functions (api.list_records, which returns lifecycle metadata only); writes only call the api.* records
// commands. Capabilities come from the authz.* predicates, so the UI offers exactly what the database allows.
import type {
  DispositionCertificateView,
  DispositionRequestInfo,
  LegalHoldInfo,
  LegalHoldRequestInfo,
  RecordCapabilities,
  RecordDetail,
  RetentionClassOption,
} from "@cdf/contracts";
import type { RecordsGateway, UserRequestContext } from "@cdf/application";
import { withUserContext, type Sql, type Tx } from "./security-context";

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

type RequestRow = Omit<LegalHoldRequestInfo, "requestedAt" | "reviewedAt"> & {
  requestedAt: Date;
  reviewedAt: Date | null;
};

/**
 * The case id and number come from api.list_records, which answers only when the caller may see the
 * case's metadata; a controlled-lookup requester therefore sees neither until a reviewer is assigned (CDF-79).
 */
const REQUEST_COLUMNS = (tx: Tx, userId: string) => tx`
  v.case_id as "caseId", v.case_number as "caseNumber", r.id, r.origin, r.reason_code as "reasonCode",
  r.status, r.requested_by = ${userId} as "requestedByMe", r.assigned_reviewer is not distinct from ${userId}::uuid as "assignedToMe",
  r.requested_at as "requestedAt", r.reviewed_at as "reviewedAt"`;

const toRequest = (r: RequestRow): LegalHoldRequestInfo => ({
  ...r,
  requestedAt: iso(r.requestedAt)!,
  reviewedAt: iso(r.reviewedAt),
});

export class PostgresRecordsGateway implements RecordsGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  getRecord(ctx: UserRequestContext, caseId: string): Promise<RecordDetail | null> {
    return this.run(ctx, async (tx) => {
      // Audits RECORDS_CASE_METADATA_VIEWED, or CASE_ACCESS_DENIED for an invisible or missing case.
      const [opened] = await tx<{ ok: boolean }[]>`select api.open_case_metadata(${caseId}) as ok`;
      if (!opened?.ok) return null;
      const [row] = await tx<
        (Omit<
          RecordDetail,
          "closedAt" | "retainUntil" | "capabilities" | "dispositionRequests" | "holds" | "holdRequests"
        > & {
          closedAt: Date | null;
          retainUntil: Date | null;
        })[]
      >`
        select case_id as "caseId", case_number as "caseNumber", case_type as "caseType", classification,
               records_state as "recordsState", retention_class as "retentionClass",
               retention_class_status as "retentionClassStatus", legal_hold_status as "legalHoldStatus",
               closed_at as "closedAt", retain_until as "retainUntil", certificate_id as "certificateId"
        from api.list_records(null, ${caseId})`;
      if (!row) return null;
      const [capabilities] = await tx<RecordCapabilities[]>`
        select authz.can_manage_retention(${caseId}) as "manageRetention",
               authz.can_manage_disposition(${caseId}) as "manageDisposition",
               authz.can_approve_disposition(${caseId}) as "approveDisposition",
               authz.can_apply_legal_hold(${caseId}) as "applyLegalHold",
               authz.can_release_legal_hold(${caseId}) as "releaseLegalHold",
               authz.can_request_legal_hold(${caseId}) as "requestLegalHold"`;
      const requests = await tx<
        (Omit<DispositionRequestInfo, "requestedAt" | "decidedAt"> & {
          requestedAt: Date;
          decidedAt: Date | null;
        })[]
      >`
        select id, status, requested_by = ${ctx.userId} as "requestedByMe", requested_at as "requestedAt",
               decided_at as "decidedAt"
        from records.disposition_request where case_id = ${caseId} order by requested_at desc`;
      const holds = await tx<
        (Omit<LegalHoldInfo, "placedAt" | "releasedAt" | "pendingRelease"> & {
          placedAt: Date;
          releasedAt: Date | null;
          releaseId: string | null;
          releaseByMe: boolean | null;
          releaseAt: Date | null;
        })[]
      >`
        select h.id, h.hold_number as "holdNumber", h.scope_type as "scopeType", h.reason_code as "reasonCode",
               h.status, h.placed_at as "placedAt", h.released_at as "releasedAt",
               rel.id as "releaseId", rel.requested_by = ${ctx.userId} as "releaseByMe", rel.requested_at as "releaseAt"
        from records.legal_hold h
        left join records.legal_hold_release rel on rel.hold_id = h.id and rel.status = 'PENDING'
        where h.case_id = ${caseId} order by h.placed_at desc`;
      const holdRequests = await tx<RequestRow[]>`
        select ${REQUEST_COLUMNS(tx, ctx.userId)}
        from records.legal_hold_request_view r
        left join lateral (
          select l.case_id, l.case_number from api.list_records(null, r.case_id) l where r.case_id is not null
        ) v on true
        where r.case_id = ${caseId} order by r.requested_at desc`;
      return {
        ...row,
        closedAt: iso(row.closedAt),
        retainUntil: iso(row.retainUntil),
        capabilities: capabilities!,
        dispositionRequests: requests.map((r) => ({
          ...r,
          requestedAt: iso(r.requestedAt)!,
          decidedAt: iso(r.decidedAt),
        })),
        holds: holds.map(({ releaseId, releaseByMe, releaseAt, ...h }) => ({
          ...h,
          placedAt: iso(h.placedAt)!,
          releasedAt: iso(h.releasedAt),
          pendingRelease: releaseId
            ? { id: releaseId, requestedByMe: releaseByMe === true, requestedAt: iso(releaseAt)! }
            : null,
        })),
        holdRequests: holdRequests.map(toRequest),
      };
    });
  }

  listRetentionClasses(ctx: UserRequestContext): Promise<RetentionClassOption[]> {
    return this.run(ctx, (tx) =>
      tx<RetentionClassOption[]>`
        select code, name_en as "nameEn", name_ar as "nameAr", status
        from records.retention_class where record_type = 'CASE' and code <> 'UNASSIGNED' order by code`.then(
        (r) => [...r],
      ),
    );
  }

  listHoldRequests(ctx: UserRequestContext): Promise<LegalHoldRequestInfo[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<RequestRow[]>`
        select ${REQUEST_COLUMNS(tx, ctx.userId)}
        from records.legal_hold_request_view r
        left join lateral (
          select l.case_id, l.case_number from api.list_records(null, r.case_id) l where r.case_id is not null
        ) v on true
        order by r.requested_at desc
        limit 200`;
      return rows.map(toRequest);
    });
  }

  getCertificate(ctx: UserRequestContext, certificateId: string): Promise<DispositionCertificateView | null> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<
        (Omit<
          DispositionCertificateView,
          "triggerAt" | "retainUntil" | "requestedAt" | "approvedAt" | "issuedAt" | "verified"
        > & { triggerAt: Date; retainUntil: Date; requestedAt: Date; approvedAt: Date; issuedAt: Date })[]
      >`
        select id, certificate_number as "certificateNumber", case_number as "caseNumber",
               retention_class as "retentionClass", trigger_event as "triggerEvent", trigger_at as "triggerAt",
               retain_until as "retainUntil", requested_at as "requestedAt", approved_at as "approvedAt",
               issued_at as "issuedAt", disposition_action as "dispositionAction", execution_mode as "executionMode",
               active_holds_found as "activeHoldsFound",
               jsonb_array_length(evidence_manifest)::int as "evidenceVersions",
               certificate_hash as "certificateHash"
        from records.disposition_certificate where id = ${certificateId}`;
      if (!row) return null;
      const [check] = await tx<
        { ok: boolean }[]
      >`select api.verify_disposition_certificate(${certificateId}) as ok`;
      return {
        ...row,
        triggerAt: iso(row.triggerAt)!,
        retainUntil: iso(row.retainUntil)!,
        requestedAt: iso(row.requestedAt)!,
        approvedAt: iso(row.approvedAt)!,
        issuedAt: iso(row.issuedAt)!,
        verified: check?.ok === true,
      };
    });
  }

  async assignRetentionClass(
    ctx: UserRequestContext,
    i: { caseId: string; retentionClass: string },
  ): Promise<void> {
    await this.run(ctx, (tx) => tx`select api.assign_retention_class(${i.caseId}, ${i.retentionClass})`);
  }

  placeLegalHold(
    ctx: UserRequestContext,
    i: { caseId: string; reasonCode: string; justification: string; authorityReference?: string | undefined },
  ): Promise<string> {
    return this.id(
      ctx,
      (tx) => tx`select api.place_legal_hold(${i.caseId}, 'CASE', null, ${i.reasonCode}, ${i.justification},
                                             ${i.authorityReference ?? null}) as id`,
    );
  }

  requestHoldRelease(ctx: UserRequestContext, i: { holdId: string; justification: string }): Promise<string> {
    return this.id(
      ctx,
      (tx) => tx`select api.request_legal_hold_release(${i.holdId}, ${i.justification}) as id`,
    );
  }

  async decideHoldRelease(
    ctx: UserRequestContext,
    i: { releaseId: string; approve: boolean; reason: string },
  ): Promise<void> {
    await this.run(
      ctx,
      (tx) => tx`select api.decide_legal_hold_release(${i.releaseId}, ${i.approve}, ${i.reason})`,
    );
  }

  requestLegalHold(
    ctx: UserRequestContext,
    i: { caseId: string; reasonCode: string; justification: string },
  ): Promise<string> {
    return this.id(
      ctx,
      (tx) => tx`select api.request_legal_hold(${i.caseId}, ${i.reasonCode}, ${i.justification}) as id`,
    );
  }

  assignHoldRequest(ctx: UserRequestContext, i: { requestId: string; reviewerId: string }): Promise<string> {
    return this.id(
      ctx,
      (tx) => tx`select api.assign_legal_hold_request(${i.requestId}, ${i.reviewerId}) as id`,
    );
  }

  async reviewHoldRequest(
    ctx: UserRequestContext,
    i: { requestId: string; apply: boolean; reason: string },
  ): Promise<void> {
    await this.run(
      ctx,
      (tx) => tx`select api.review_legal_hold_request(${i.requestId}, ${i.apply}, ${i.reason})`,
    );
  }

  refreshEligibility(ctx: UserRequestContext): Promise<number> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ n: number }[]>`select api.refresh_disposition_eligibility() as n`;
      return Number(row?.n ?? 0);
    });
  }

  requestDisposition(ctx: UserRequestContext, i: { caseId: string }): Promise<string> {
    return this.id(ctx, (tx) => tx`select api.request_disposition(${i.caseId}) as id`);
  }

  async decideDisposition(
    ctx: UserRequestContext,
    i: { requestId: string; approve: boolean; reason: string },
  ): Promise<void> {
    await this.run(ctx, (tx) => tx`select api.decide_disposition(${i.requestId}, ${i.approve}, ${i.reason})`);
  }

  executeDisposition(ctx: UserRequestContext, i: { requestId: string }): Promise<string> {
    return this.id(ctx, (tx) => tx`select api.execute_disposition(${i.requestId}) as id`);
  }

  /** Runs a command that returns one uuid, selected `as id`. */
  private id(
    ctx: UserRequestContext,
    fn: (tx: Tx) => Promise<readonly Record<string, unknown>[]>,
  ): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [row] = await fn(tx);
      return String(row!.id);
    });
  }
}
