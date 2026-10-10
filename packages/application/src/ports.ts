/**
 * Ports (§6, §7). Implementations live only in @cdf/infrastructure, selected by configuration.
 */
import type {
  Actor,
  AuditTimelineEntry,
  CaseDetail,
  CaseListItem,
  EvidenceItem,
  EvidenceRejectionCode,
  FormApprovalOutcome,
  FormData,
  FormDefinitionListItem,
  FormInstanceDetail,
  FormInstanceSummary,
  FormReviewOutcome,
  IntakeReportItem,
  PublicReportStatus,
  ReportDetail,
  ReportMessage,
  ReporterMode,
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

/**
 * Private object storage for evidence content (ADR-006). Keys are random and immutable; there is no
 * overwrite and no delete on this port. Content is always streamed through the server after
 * authorization, never fetched by the browser (CLAUDE.md §3).
 * PRODUCTION_SUBSTITUTION_REQUIRED: Alibaba OSS with WORM retention and KMS server-side encryption.
 */
export interface EvidenceStorage {
  readonly kind: "local-fs" | "supabase";
  /** Exclusive create in the quarantine area; fails if the key already exists. */
  putQuarantine(objectKey: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Moves a scanned object from quarantine to the vault; fails if the vault key already exists. */
  promoteToVault(objectKey: string): Promise<void>;
  /** Streams a vault object. */
  openReadStream(objectKey: string): Promise<ReadableStream<Uint8Array>>;
  exists(objectKey: string): Promise<boolean>;
}

export interface ScanResult {
  status: "CLEAN" | "INFECTED" | "UNSCANNED";
  scanner: string;
}

/** PRODUCTION_SUBSTITUTION_REQUIRED: CDF-approved malware scanning service (threat T10). */
export interface MalwareScanner {
  readonly name: string;
  scan(content: Uint8Array, hint: { contentType: string; objectKey: string }): Promise<ScanResult>;
}

export interface RegisteredEvidenceVersion {
  evidenceId: string;
  versionId: string;
  versionNo: number;
  objectKey: string;
}

/** Storage facts for a version the caller may download. Never leaves the server. */
export interface EvidenceDownloadRecord {
  objectKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  evidenceId: string;
  caseId: string;
}

export interface EvidenceGateway {
  listEvidence(ctx: UserRequestContext, caseId: string): Promise<EvidenceItem[]>;
  registerVersion(
    ctx: UserRequestContext,
    input: {
      caseId: string;
      evidenceId?: string;
      title?: string;
      description?: string;
      evidenceType?: string;
      sourceDescription?: string;
      collectedAt?: string;
      classification?: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
    },
  ): Promise<RegisteredEvidenceVersion>;
  completeVersion(ctx: UserRequestContext, versionId: string, scanner: string): Promise<void>;
  rejectVersion(
    ctx: UserRequestContext,
    versionId: string,
    reasonCode: EvidenceRejectionCode,
    scan?: { status: "INFECTED" | "UNSCANNED"; scanner: string },
  ): Promise<void>;
  /** Records the download (custody + audit) and returns the storage facts, or null when denied/missing. */
  openVersion(ctx: UserRequestContext, versionId: string): Promise<EvidenceDownloadRecord | null>;
}

// ---- Forms engine (Phase 8; ADR-011) ---------------------------------------------------------
export interface SavedFormVersion {
  versionId: string;
  versionNo: number;
  contentHash: string;
}

export interface FormsGateway {
  /** The registry with the caller's right to start each form on this case (authz.can_prepare_form). */
  listDefinitions(ctx: UserRequestContext, caseId: string): Promise<FormDefinitionListItem[]>;
  listInstances(ctx: UserRequestContext, caseId: string): Promise<FormInstanceSummary[]>;
  /** Calls api.open_form_instance (audit) and returns the instance, or null when denied or missing. */
  getInstance(ctx: UserRequestContext, instanceId: string): Promise<FormInstanceDetail | null>;
  startForm(
    ctx: UserRequestContext,
    input: { caseId: string; formCode: string; classification: string },
  ): Promise<string>;
  saveDraft(ctx: UserRequestContext, instanceId: string, data: FormData): Promise<SavedFormVersion>;
  prepare(ctx: UserRequestContext, instanceId: string): Promise<void>;
  review(
    ctx: UserRequestContext,
    instanceId: string,
    outcome: FormReviewOutcome,
    reason?: string,
  ): Promise<void>;
  approve(
    ctx: UserRequestContext,
    instanceId: string,
    outcome: FormApprovalOutcome,
    reason?: string,
  ): Promise<void>;
  withdraw(ctx: UserRequestContext, instanceId: string, reason: string): Promise<void>;
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
      reporterMode: ReporterMode;
      relationship: string;
      relationshipOther?: string;
      category: string;
      categoryOther?: string;
      subjectDescription: string;
      description: string;
      incidentDate: string;
      /** HH:MM */
      incidentTime: string;
      location: string;
      willingToCooperate: boolean;
      language: "ar" | "en";
      /** Vault-bound only (snake_case keys of public_api.submit_report); absent for anonymous reports. */
      identity?: Record<string, string>;
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
