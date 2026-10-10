// PortalGateway over PostgreSQL. The portal login (cdf_portal) can only become anon and call public_api.*.
import type { PortalGateway, PortalReportStatus, RequestContext } from "@cdf/application";
import { withAnonContext, type Sql } from "./security-context";

export class PostgresPortalGateway implements PortalGateway {
  constructor(private readonly sql: Sql) {}

  submitReport(ctx: RequestContext, i: Parameters<PortalGateway["submitReport"]>[1]) {
    return withAnonContext(this.sql, ctx.requestId, async (tx) => {
      const identity = i.identity
        ? tx.json(
            Object.fromEntries(Object.entries(i.identity).filter(([, v]) => v !== undefined)) as Record<
              string,
              string
            >,
          )
        : null;
      const [row] = await tx<{ reportRef: string; receivedAt: Date }[]>`
        select report_ref as "reportRef", received_at as "receivedAt"
        from public_api.submit_report(${i.reportRef}, ${i.secretHmac}, ${i.reporterMode}, ${i.relationship},
          ${i.relationshipOther ?? null}, ${i.category}, ${i.categoryOther ?? null}, ${i.subjectDescription},
          ${i.description}, ${i.incidentDate}, ${i.incidentTime}, ${i.location}, ${i.willingToCooperate},
          ${i.language}, ${identity})`;
      return { reportRef: row!.reportRef, receivedAt: new Date(row!.receivedAt).toISOString() };
    });
  }

  getReportStatus(ctx: RequestContext, reportRef: string, secretHmac: string) {
    return withAnonContext(this.sql, ctx.requestId, async (tx) => {
      const [row] = await tx<
        { s: Record<string, unknown> | null }[]
      >`select public_api.get_report_status(${reportRef}, ${secretHmac}) as s`;
      const s = row?.s;
      if (!s) return null;
      return {
        reportRef: s.report_ref,
        status: s.status,
        receivedAt: s.received_at,
        statusChangedAt: s.status_changed_at,
        canReply: s.can_reply,
        messages: ((s.messages as Record<string, string>[]) ?? []).map((m) => ({
          direction: m.direction,
          body: m.body,
          createdAt: m.created_at,
        })),
      } as PortalReportStatus;
    });
  }

  postReporterMessage(ctx: RequestContext, reportRef: string, secretHmac: string, body: string) {
    return withAnonContext(this.sql, ctx.requestId, async (tx) => {
      const [row] = await tx<
        { ok: boolean }[]
      >`select public_api.post_reporter_message(${reportRef}, ${secretHmac}, ${body}) as ok`;
      return row?.ok === true;
    });
  }
}
