/**
 * Public whistleblowing portal use cases (§22, §23).
 */
import {
  generateReportRef,
  generateReporterSecret,
  isReportRef,
  normaliseReportRef,
  normaliseReporterSecret,
  REPORTER_SECRET_PATTERN,
} from "@cdf/domain";
import {
  reportAccessSchema,
  reporterMessageSchema,
  submitReportSchema,
  type ReportIdentity,
  type SubmitReport,
} from "@cdf/validation";
import { AppError, toAppError } from "./errors";
import type {
  KeyManagementProvider,
  PortalGateway,
  PortalReportStatus,
  RateLimiter,
  RequestContext,
} from "./ports";

export interface PortalDeps {
  gateway: PortalGateway;
  keys: KeyManagementProvider;
  rateLimiter: RateLimiter;
}

/** Boundary limits per client fingerprint (hashed). Tuned for a demo, not for production traffic. */
export const PORTAL_LIMITS = {
  submit: { limit: 5, windowSeconds: 3600 },
  access: { limit: 30, windowSeconds: 900 },
} as const;

/** Maps the validated identity to the vault payload of public_api.submit_report; nothing for anonymous. */
export function vaultIdentity(input: SubmitReport): Record<string, string> | undefined {
  if (input.reporterMode === "ANONYMOUS" || !input.identity) return undefined;
  if (input.reporterMode === "EMAIL_ONLY") return { email: input.identity.email };
  const i = input.identity as ReportIdentity;
  return {
    given_name: i.givenName,
    father_name: i.fatherName,
    grandfather_name: i.grandfatherName,
    family_name: i.familyName,
    gender: i.gender,
    birth_date: i.birthDate,
    birth_date_calendar: i.birthDateCalendar,
    id_type: i.idType,
    id_number: i.idNumber,
    city: i.city,
    nationality: i.nationality,
    phone: i.phone,
    email: i.email,
    preferred_contact: i.preferredContact,
  };
}

export function createPortalService(deps: PortalDeps) {
  async function limit(kind: keyof typeof PORTAL_LIMITS, clientKey: string, ctx: RequestContext) {
    const { limit: max, windowSeconds } = PORTAL_LIMITS[kind];
    const bucket = `portal_${kind}:${await deps.keys.rateLimitKey(clientKey)}`;
    if (!(await deps.rateLimiter.consume(bucket, max, windowSeconds))) {
      throw new AppError("RATE_LIMITED", ctx.requestId);
    }
  }

  return {
    /**
     * Submits a report. Returns the Report ID and the one-time secret; the secret is shown once and
     * never stored or logged.
     */
    async submitReport(ctx: RequestContext, clientKey: string, raw: unknown) {
      const parsed = submitReportSchema.safeParse(raw);
      if (!parsed.success) return { ok: false as const, issues: parsed.error };
      await limit("submit", clientKey, ctx);
      const input = parsed.data;
      const secret = generateReporterSecret();
      const secretHmac = await deps.keys.reportSecretHmac(secret);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await deps.gateway.submitReport(ctx, {
            reportRef: generateReportRef(),
            secretHmac,
            reporterMode: input.reporterMode,
            relationship: input.relationship,
            relationshipOther: input.relationshipOther,
            category: input.category,
            categoryOther: input.categoryOther,
            subjectDescription: input.subjectDescription,
            description: input.description,
            incidentDate: input.incidentDate,
            incidentTime: input.incidentTime,
            location: input.location,
            willingToCooperate: input.willingToCooperate === "YES",
            language: input.language,
            identity: vaultIdentity(input),
          });
          return { ok: true as const, reportRef: result.reportRef, secret, receivedAt: result.receivedAt };
        } catch (error) {
          const appError = toAppError(error, ctx.requestId);
          if (appError.kind === "CONFLICT" && appError.detail === "REF_COLLISION") continue;
          throw appError;
        }
      }
      throw new AppError("UNAVAILABLE", ctx.requestId);
    },

    /** Returns null for any credential problem; callers must show one generic message (§23). */
    async getStatus(
      ctx: RequestContext,
      clientKey: string,
      raw: unknown,
    ): Promise<PortalReportStatus | null> {
      const parsed = reportAccessSchema.safeParse(raw);
      await limit("access", clientKey, ctx);
      if (!parsed.success) return null;
      const ref = normaliseReportRef(parsed.data.reportRef);
      const secret = normaliseReporterSecret(parsed.data.secret);
      if (!isReportRef(ref) || !REPORTER_SECRET_PATTERN.test(secret)) {
        // Still consult the database so malformed and wrong credentials cost the same and are recorded.
        await deps.gateway.getReportStatus(ctx, ref, await deps.keys.reportSecretHmac(secret || "-"));
        return null;
      }
      try {
        return await deps.gateway.getReportStatus(ctx, ref, await deps.keys.reportSecretHmac(secret));
      } catch (error) {
        throw toAppError(error, ctx.requestId);
      }
    },

    async postMessage(ctx: RequestContext, clientKey: string, raw: unknown): Promise<boolean> {
      const parsed = reporterMessageSchema.safeParse(raw);
      await limit("access", clientKey, ctx);
      if (!parsed.success) return false;
      const ref = normaliseReportRef(parsed.data.reportRef);
      const secret = normaliseReporterSecret(parsed.data.secret);
      try {
        return await deps.gateway.postReporterMessage(
          ctx,
          ref,
          await deps.keys.reportSecretHmac(secret),
          parsed.data.body,
        );
      } catch (error) {
        throw toAppError(error, ctx.requestId);
      }
    },
  };
}
export type PortalService = ReturnType<typeof createPortalService>;
