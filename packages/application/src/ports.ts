/**
 * Ports (§6, §7). Implementations live only in @cdf/infrastructure, selected by configuration.
 */
import type {
  Actor,
  AttachmentSource,
  BcpWorkbook,
  AuditTimelineEntry,
  CaseAccessRosterEntry,
  CaseDetail,
  CaseDiscoveryResult,
  CaseListItem,
  CaseReporterView,
  EvidenceItem,
  EvidenceRejectionCode,
  EvidenceRestriction,
  ExportDelivery,
  ExportDocument,
  FormApprovalOutcome,
  FormData,
  FormDefinitionListItem,
  FormInstanceDetail,
  FormInstanceListItem,
  FormReviewOutcome,
  IntakeReportItem,
  LedgerEntry,
  MyAccessEntry,
  MyArea,
  MyCaseTask,
  MyWorkSummary,
  OutgoingNotification,
  PendingConflict,
  PublicReportStatus,
  RecordsCatalogueEntry,
  RetentionQueueEntry,
  ReportAttachmentItem,
  ReportDetail,
  ReportMessage,
  ReporterMode,
  RestrictedCaseAuthority,
  UserDirectoryEntry,
  UserRegisterEntry,
  WorkItem,
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
  /** Weighted variant (e.g. KiB uploaded): adds `amount` to the window and checks it against `limit`. */
  consumeAmount(bucket: string, amount: number, limit: number, windowSeconds: number): Promise<boolean>;
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

/**
 * The public portal's view of evidence storage (ADR-015): write-only. It can drop a reporter attachment
 * into quarantine and promote it after a clean scan, but it can never read an object back.
 * PRODUCTION_SUBSTITUTION_REQUIRED: an OSS RAM policy allowing PutObject/CopyObject on reports/ only.
 */
export type AttachmentDropbox = Pick<EvidenceStorage, "kind" | "putQuarantine" | "promoteToVault">;

export interface ScanResult {
  status: "CLEAN" | "INFECTED" | "UNSCANNED";
  scanner: string;
}

/** PRODUCTION_SUBSTITUTION_REQUIRED: CDF-approved malware scanning service (threat T10). */
export interface MalwareScanner {
  readonly name: string;
  scan(content: Uint8Array, hint: { contentType: string; objectKey: string }): Promise<ScanResult>;
}

export type WorkbookReadResult = { ok: true; workbook: BcpWorkbook } | { ok: false; code: string };

/**
 * Reads an uploaded continuity workbook (ADR-034 D3). The upload is untrusted: an implementation checks sizes and
 * entry counts before inflating, refuses DTDs, external entities, macros and embedded content, and returns every
 * cell as a string. A refusal carries a stable code, never file content.
 * PRODUCTION_SUBSTITUTION_REQUIRED: a vetted workbook reader in the CDF runtime.
 */
export interface WorkbookReader {
  readonly name: string;
  read(bytes: Uint8Array): WorkbookReadResult;
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
  /**
   * AMB-165: the content read back did not match the recorded SHA-256. The database blocks the version for every
   * reader, records custody and a SECURITY event, and tells the case owner (migration 2050).
   */
  reportIntegrityFailure(ctx: UserRequestContext, versionId: string, observedSha256: string): Promise<void>;
  /** DEC-09: limit an item to the case leads, or open it to the team again (audited in the database). */
  setRestriction(
    ctx: UserRequestContext,
    input: { caseId: string; evidenceId: string; restriction: EvidenceRestriction; reason: string },
  ): Promise<void>;
  /** Reporter attachments on a report the caller can view (CDF-72), quarantined and rejected ones included. */
  listReportAttachments(ctx: UserRequestContext, reportId: string): Promise<ReportAttachmentItem[]>;
  /** The reporter's files of every report behind a case, as far as the caller may see them (DEC-09). */
  listCaseReportAttachments(ctx: UserRequestContext, caseId: string): Promise<ReportAttachmentItem[]>;
  /** Download gate for an available reporter attachment; null when denied, missing or not yet scanned. */
  openReportAttachment(
    ctx: UserRequestContext,
    attachmentId: string,
  ): Promise<ReportAttachmentDownloadRecord | null>;
}

/** Storage facts for a reporter attachment the caller may download. Never leaves the server. */
export interface ReportAttachmentDownloadRecord {
  objectKey: string;
  displayName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  reportId: string;
}

export interface RegisteredReportAttachment {
  attachmentId: string;
  objectKey: string;
  displayName: string;
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
  listInstances(ctx: UserRequestContext, caseId: string): Promise<FormInstanceListItem[]>;
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
      restrictedAuthorityId?: string | undefined;
    },
  ): Promise<string>;
  listRestrictedCaseAuthorities(
    ctx: UserRequestContext,
    reportId: string,
    classification: string,
  ): Promise<RestrictedCaseAuthority[]>;
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
  // Case history and access roster (UX redesign S2, migration 1830): the database applies each event's audience.
  caseTimeline(ctx: UserRequestContext, caseId: string, limit?: number): Promise<AuditTimelineEntry[]>;
  caseAccessRoster(ctx: UserRequestContext, caseId: string): Promise<CaseAccessRosterEntry[]>;
  // The conversation with the reporter on a case (UX redesign S2, migration 1840, DEC-06).
  caseReporterView(ctx: UserRequestContext, caseId: string): Promise<CaseReporterView>;
  delegateReporterCommunication(
    ctx: UserRequestContext,
    input: { caseId: string; userId: string; reason: string },
  ): Promise<string>;
  endReporterCommunication(
    ctx: UserRequestContext,
    input: { caseId: string; delegationId: string; reason: string },
  ): Promise<void>;
  directory(ctx: UserRequestContext): Promise<UserDirectoryEntry[]>;
  // Purpose-bound records and legal access (ADR-014): authorised rows, counts and own work only.
  searchRecordsCatalogue(
    ctx: UserRequestContext,
    input: {
      caseNumber?: string;
      archiveStatus?: string;
      legalHoldStatus?: string;
      limit: number;
      offset: number;
    },
  ): Promise<{ total: number; items: RecordsCatalogueEntry[] }>;
  myCaseTasks(ctx: UserRequestContext): Promise<MyCaseTask[]>;
  myWorkSummary(ctx: UserRequestContext): Promise<MyWorkSummary>;
  // Shell read models (UX redesign S1, migration 1820): the caller's own areas, work and access basis.
  myAreas(ctx: UserRequestContext): Promise<MyArea[]>;
  myWorkItems(ctx: UserRequestContext): Promise<WorkItem[]>;
  /** S2h (migration 1860): archived cases the caller may classify, shared by every records officer who may. */
  retentionReviewQueue(ctx: UserRequestContext): Promise<RetentionQueueEntry[]>;
  myAccess(ctx: UserRequestContext): Promise<MyAccessEntry[]>;
  pendingConflicts(ctx: UserRequestContext, caseId: string): Promise<PendingConflict[]>;
  decideConflict(
    ctx: UserRequestContext,
    input: { conflictId: string; decision: string; reason: string },
  ): Promise<string>;
  // Read-only Oversight and Administration (S1). Row-level security decides every row.
  auditLedger(
    ctx: UserRequestContext,
    categories: readonly LedgerEntry["category"][],
    limit: number,
  ): Promise<LedgerEntry[]>;
  auditChainBreaks(ctx: UserRequestContext): Promise<number>;
  userRegister(ctx: UserRequestContext): Promise<UserRegisterEntry[]>;
  requestCaseForLegalHold(
    ctx: UserRequestContext,
    input: { caseReference: string; justification: string; reasonCode: string },
  ): Promise<CaseDiscoveryResult>;
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
  /** Null when the credentials do not match (indistinguishable from an unknown Report ID). */
  registerAttachment(
    ctx: RequestContext,
    reportRef: string,
    secretHmac: string,
    input: {
      source: AttachmentSource;
      extension: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
    },
  ): Promise<RegisteredReportAttachment | null>;
  completeAttachment(
    ctx: RequestContext,
    reportRef: string,
    secretHmac: string,
    attachmentId: string,
    scanner: string,
  ): Promise<boolean>;
  rejectAttachment(
    ctx: RequestContext,
    reportRef: string,
    secretHmac: string,
    attachmentId: string,
    reasonCode: EvidenceRejectionCode,
    scan?: { status: "INFECTED" | "UNSCANNED"; scanner: string },
  ): Promise<boolean>;
}

// ---- Notifications (ADR-025, migration 1920) --------------------------------------------------
/**
 * Server-only access to the notification outbox, at the BFF login role (never `authenticated`). It sees recipient,
 * template and link only; never case content (§39, N18).
 */
export interface NotificationOutbox {
  claimEmailBatch(limit: number): Promise<OutgoingNotification[]>;
  recordEmailDelivery(id: string, delivered: boolean): Promise<"SENT" | "FAILED" | "PENDING">;
  /** Deadline reminders (defence responses due soon); idempotent. Returns how many were queued. */
  emitDueReminders(): Promise<number>;
}

/**
 * Delivers one email notification. PRODUCTION_SUBSTITUTION_REQUIRED: the prototype adapter is a stub; the CDF mail
 * relay and the corporate directory lookup of the recipient's address are a human decision (ADR-025).
 */
export interface NotificationSender {
  readonly kind: "stub-email";
  send(notification: OutgoingNotification): Promise<boolean>;
}

// ---- Export builder (ADR-026, migration 1930) ---------------------------------------------------
/** A rendered export file. */
export interface RenderedExport {
  body: Uint8Array;
  contentType: string;
  fileName: string;
}

/**
 * Turns an approved export document into a file. PRODUCTION_SUBSTITUTION_REQUIRED: the prototype renderer writes
 * canonical JSON; CDF document rendering (PDF/XLSX with classification banners) is a human decision.
 */
export interface ExportRenderer {
  readonly kind: "stub-json";
  render(document: ExportDocument): Promise<RenderedExport>;
}

/**
 * Private storage for generated exports, keyed by the database's random key (exports/<uuid>); never overwritten.
 * PRODUCTION_SUBSTITUTION_REQUIRED: a private Alibaba OSS export bucket with KMS encryption; the prototype keeps
 * files in memory.
 */
export interface ExportStore {
  readonly kind: "memory";
  put(storageKey: string, file: RenderedExport): Promise<void>;
}

/**
 * Delivers an EMAIL export. PRODUCTION_SUBSTITUTION_REQUIRED: the CDF mail relay with approved external domains;
 * the prototype stub delivers to synthetic @example.test addresses only and sends nothing.
 */
export interface ExportMailer {
  readonly kind: "stub-email";
  /** Internal recipients arrive by user id: resolving their address is the adapter's job (directory lookup). */
  send(to: readonly ExportDelivery[], file: RenderedExport): Promise<boolean>;
}
