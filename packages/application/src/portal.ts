/**
 * Public whistleblowing portal use cases (§22, §23).
 */
import { REPORTER_ATTACHMENT_MAX_BYTES } from "@cdf/contracts";
import {
  checkReporterAttachment,
  generateReportRef,
  generateReporterSecret,
  isReportRef,
  normaliseReportRef,
  normaliseReporterSecret,
  REPORTER_SECRET_PATTERN,
} from "@cdf/domain";
import {
  reportAccessSchema,
  reportAttachmentUploadSchema,
  reporterMessageSchema,
  submitReportSchema,
  type ReportIdentity,
  type SubmitReport,
} from "@cdf/validation";
import { AppError, toAppError } from "./errors";
import type {
  AttachmentDropbox,
  KeyManagementProvider,
  MalwareScanner,
  PortalGateway,
  PortalReportStatus,
  RateLimiter,
  RequestContext,
} from "./ports";

export interface PortalDeps {
  gateway: PortalGateway;
  keys: KeyManagementProvider;
  rateLimiter: RateLimiter;
  /** Reporter attachments (ADR-015). Absent where no portal storage credential is configured: uploads are off. */
  attachments?: { dropbox: AttachmentDropbox; scanner: MalwareScanner };
}

/** Boundary limits per client fingerprint (hashed). Tuned for a demo, not for production traffic. */
export const PORTAL_LIMITS = {
  submit: { limit: 5, windowSeconds: 3600 },
  access: { limit: 30, windowSeconds: 900 },
  /** Attachment uploads by count (ADR-015). */
  attachment: { limit: 20, windowSeconds: 3600 },
} as const;

/** Attachment bytes per client, counted in KiB (40 MiB per hour; ADR-015). */
export const PORTAL_ATTACHMENT_KIB_LIMIT = { limit: 40_960, windowSeconds: 3600 } as const;

export interface AttachmentFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Outcome of one attachment upload. Credential problems are one code (NOT_ACCEPTED), whatever the cause,
 * so the answer never reveals whether a Report ID exists (§23).
 */
export type AttachmentUploadResult =
  | { ok: true; displayName: string }
  | {
      ok: false;
      code:
        | "INVALID_FILE"
        | "NOT_ACCEPTED"
        | "REPORT_CLOSED"
        | "LIMIT_REACHED"
        | "DUPLICATE"
        | "REJECTED"
        | "UNAVAILABLE";
      reason?: string;
    };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

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
    /** True when this deployment accepts reporter attachments (a storage credential is configured). */
    attachmentsEnabled: Boolean(deps.attachments),

    /**
     * Adds one file to a report (ADR-015): boundary limits by count and bytes, file checks, registration
     * (which authenticates the report), quarantine, scan, then promotion and completion or rejection.
     * The file name is used only to read the extension; it is never stored or logged.
     */
    async uploadAttachment(
      ctx: RequestContext,
      clientKey: string,
      raw: unknown,
      file: AttachmentFile,
    ): Promise<AttachmentUploadResult> {
      if (!deps.attachments) return { ok: false, code: "UNAVAILABLE" };
      const { dropbox, scanner } = deps.attachments;
      await limit("attachment", clientKey, ctx);
      const parsed = reportAttachmentUploadSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, code: "NOT_ACCEPTED" };

      const check = checkReporterAttachment(
        { fileName: file.name, size: file.bytes.length, bytes: file.bytes },
        REPORTER_ATTACHMENT_MAX_BYTES,
      );
      if (!check.ok) return { ok: false, code: "INVALID_FILE", reason: check.reason };

      const kib = Math.max(1, Math.ceil(file.bytes.length / 1024));
      const bytesBucket = `portal_attachment_kib:${await deps.keys.rateLimitKey(clientKey)}`;
      const { limit: maxKib, windowSeconds } = PORTAL_ATTACHMENT_KIB_LIMIT;
      if (!(await deps.rateLimiter.consumeAmount(bytesBucket, kib, maxKib, windowSeconds))) {
        throw new AppError("RATE_LIMITED", ctx.requestId);
      }

      const ref = normaliseReportRef(parsed.data.reportRef);
      const secretHmac = await deps.keys.reportSecretHmac(normaliseReporterSecret(parsed.data.secret));
      const sha256 = await sha256Hex(file.bytes);
      let registered;
      try {
        registered = await deps.gateway.registerAttachment(ctx, ref, secretHmac, {
          source: parsed.data.source,
          extension: check.extension,
          contentType: check.contentType,
          sizeBytes: file.bytes.length,
          sha256,
        });
      } catch (error) {
        const appError = toAppError(error, ctx.requestId);
        if (appError.kind === "CONFLICT") {
          if (appError.detail === "ATTACHMENT_LIMIT") return { ok: false, code: "LIMIT_REACHED" };
          if (appError.detail === "DUPLICATE_ATTACHMENT") return { ok: false, code: "DUPLICATE" };
          if (appError.detail === "REPORT_CLOSED") return { ok: false, code: "REPORT_CLOSED" };
        }
        throw appError;
      }
      if (!registered) return { ok: false, code: "NOT_ACCEPTED" };

      const reject = async (
        reasonCode: "MALWARE_DETECTED" | "SCAN_UNAVAILABLE" | "STORAGE_FAILURE",
        scan?: { status: "INFECTED" | "UNSCANNED"; scanner: string },
      ) => {
        try {
          await deps.gateway.rejectAttachment(
            ctx,
            ref,
            secretHmac,
            registered.attachmentId,
            reasonCode,
            scan,
          );
        } catch {
          // The row stays QUARANTINED, which is never downloadable; the audit trail shows the receipt.
        }
      };

      try {
        await dropbox.putQuarantine(registered.objectKey, file.bytes, check.contentType);
      } catch {
        await reject("STORAGE_FAILURE");
        return { ok: false, code: "UNAVAILABLE" };
      }
      let scan;
      try {
        scan = await scanner.scan(file.bytes, {
          contentType: check.contentType,
          objectKey: registered.objectKey,
        });
      } catch {
        scan = { status: "UNSCANNED" as const, scanner: scanner.name };
      }
      if (scan.status !== "CLEAN") {
        await reject(scan.status === "INFECTED" ? "MALWARE_DETECTED" : "SCAN_UNAVAILABLE", {
          status: scan.status,
          scanner: scan.scanner,
        });
        return { ok: false, code: "REJECTED" };
      }
      try {
        await dropbox.promoteToVault(registered.objectKey);
      } catch {
        await reject("STORAGE_FAILURE");
        return { ok: false, code: "UNAVAILABLE" };
      }
      try {
        if (
          !(await deps.gateway.completeAttachment(
            ctx,
            ref,
            secretHmac,
            registered.attachmentId,
            scan.scanner,
          ))
        )
          return { ok: false, code: "NOT_ACCEPTED" };
      } catch (error) {
        throw toAppError(error, ctx.requestId);
      }
      return { ok: true, displayName: registered.displayName };
    },

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
