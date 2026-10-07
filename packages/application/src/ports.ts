/**
 * Ports (§6, §7). Implementations live only in @cdf/infrastructure, selected by configuration.
 */
import type {
  Actor,
  AuditTimelineEntry,
  CaseDetail,
  CaseListItem,
  IntakeReportItem,
  PublicReportStatus,
  ReportDetail,
  ReportMessage,
  UserDirectoryEntry,
} from "@cdf/contracts";

export interface RequestContext {
  requestId: string;
}
export interface UserRequestContext extends RequestContext {
  userId: string;
}

// ---- Identity -------------------------------------------------------------------------------
export interface IdentitySession {
  /** Identity-provider subject; maps to iam.user_profile.id. */
  subject: string;
  issuedAt: number;
}

/**
 * Authenticates staff. Supabase Auth in the prototype, the CDF corporate IdP in production.
 * PRODUCTION_SUBSTITUTION_REQUIRED.
 */
export interface IdentityProvider {
  readonly kind: "supabase" | "local-dev";
  signIn(email: string, password: string): Promise<IdentitySession | null>;
  currentSession(): Promise<IdentitySession | null>;
  signOut(): Promise<void>;
}

// ---- Keys, rate limits, storage, scanning ----------------------------------------------------
/** PRODUCTION_SUBSTITUTION_REQUIRED: Alibaba Cloud KMS / HSM-backed HMAC keys. */
export interface KeyManagementProvider {
  /** HMAC-SHA256 of a reporter secret with the server-side pepper, hex encoded. */
  reportSecretHmac(secret: string): Promise<string>;
  /** Keyed hash for rate-limit bucket keys so raw client identifiers are never stored (T21). */
  rateLimitKey(value: string): Promise<string>;
}

/** PRODUCTION_SUBSTITUTION_REQUIRED: WAF / API gateway rate limiting. */
export interface RateLimiter {
  consume(bucket: string, limit: number, windowSeconds: number): Promise<boolean>;
}

/** Phase 7. PRODUCTION_SUBSTITUTION_REQUIRED: Alibaba OSS with KMS encryption. */
export interface EvidenceStorage {
  createUploadTarget(input: {
    caseId: string;
    fileName: string;
    contentType: string;
    size: number;
  }): Promise<{
    objectKey: string;
    uploadUrl: string;
    expiresAt: string;
  }>;
  createDownloadUrl(objectKey: string): Promise<string>;
}

/** Phase 7. PRODUCTION_SUBSTITUTION_REQUIRED: CDF-approved malware scanning service. */
export interface MalwareScanner {
  scan(objectKey: string): Promise<"CLEAN" | "INFECTED" | "UNSCANNED">;
}

// ---- Data gateways (implemented over the per-transaction security context) --------------------
export interface InvestigationGateway {
  loadActor(ctx: UserRequestContext): Promise<Actor | null>;
  listIntakeReports(ctx: UserRequestContext): Promise<IntakeReportItem[]>;
  getReport(ctx: UserRequestContext, reportId: string): Promise<ReportDetail | null>;
  triageReport(
    ctx: UserRequestContext,
    input: { reportId: string; outcome: string; reason: string; referredTo?: string; duplicateOf?: string },
  ): Promise<string>;
  replyToReporter(ctx: UserRequestContext, input: { reportId: string; body: string }): Promise<string>;
  createCaseFromReport(
    ctx: UserRequestContext,
    input: {
      reportId: string;
      title: string;
      summary: string;
      classification: string;
      isRestricted: boolean;
    },
  ): Promise<string>;
  listCases(ctx: UserRequestContext): Promise<CaseListItem[]>;
  getCase(ctx: UserRequestContext, caseId: string): Promise<CaseDetail | null>;
  updateCaseDetails(
    ctx: UserRequestContext,
    input: { caseId: string; title: string; summary: string; priority?: string; expectedVersion: number },
  ): Promise<number>;
  assignCase(
    ctx: UserRequestContext,
    input: { caseId: string; userId: string; assignmentRole: string; reason: string },
  ): Promise<string>;
  declareConflict(
    ctx: UserRequestContext,
    input: { caseId: string; hasConflict: boolean; declaration: string },
  ): Promise<string>;
  transitionCase(
    ctx: UserRequestContext,
    input: { caseId: string; transitionCode: string; reason?: string },
  ): Promise<string>;
  caseTimeline(ctx: UserRequestContext, caseId: string): Promise<AuditTimelineEntry[]>;
  directory(ctx: UserRequestContext): Promise<UserDirectoryEntry[]>;
}

export interface PortalReportStatus {
  reportRef: string;
  status: PublicReportStatus;
  receivedAt: string;
  statusChangedAt: string;
  canReply: boolean;
  messages: ReportMessage[];
}

export interface PortalGateway {
  submitReport(
    ctx: RequestContext,
    input: {
      reportRef: string;
      secretHmac: string;
      category: string;
      subjectDescription?: string;
      description: string;
      incidentDate?: string;
      location?: string;
      language: "ar" | "en";
      identity?: { full_name?: string; email?: string; phone?: string; preferred_contact: string };
    },
  ): Promise<{ reportRef: string; receivedAt: string }>;
  getReportStatus(
    ctx: RequestContext,
    reportRef: string,
    secretHmac: string,
  ): Promise<PortalReportStatus | null>;
  postReporterMessage(
    ctx: RequestContext,
    reportRef: string,
    secretHmac: string,
    body: string,
  ): Promise<boolean>;
}
