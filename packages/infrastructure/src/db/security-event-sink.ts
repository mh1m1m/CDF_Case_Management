// SecurityEventSink over PostgreSQL (api.record_security_event), in its own transaction so a denial
// survives the rollback of the command that was denied.
// PRODUCTION_SUBSTITUTION_REQUIRED: production also forwards to Alibaba SLS / the CDF SIEM.
import { assertSafeMetadata, type SecurityEvent, type SecurityEventSink } from "@cdf/audit";
import { withUserContext, type Sql } from "./security-context";

export class PostgresSecurityEventSink implements SecurityEventSink {
  constructor(private readonly sql: Sql) {}

  async record(event: SecurityEvent, ctx: { userId: string | null; requestId: string }): Promise<void> {
    assertSafeMetadata(event.metadata);
    if (!ctx.userId) return; // anonymous denials are recorded by public_api itself
    await withUserContext(this.sql, { userId: ctx.userId, requestId: ctx.requestId }, async (tx) => {
      await tx`select api.record_security_event(${event.action}, ${event.objectType ?? null}, ${event.objectId ?? null},
        ${tx.json((event.metadata ?? {}) as Record<string, string>)})`;
    });
  }
}
