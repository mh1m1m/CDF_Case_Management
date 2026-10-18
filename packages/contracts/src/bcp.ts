/**
 * Business continuity workbook (ADR-027, ADR-034, migration 1960, owner Q&A Q100; the committee workbook BCP-C1,
 * migration 2110, ADR-047).
 * The templates are reference data: exchange.bcp_template_sheet and exchange.bcp_template_column hold the same lists,
 * and a database test keeps them equal.
 */

import type { SettingStatus } from "./export-requests";
import type { AccountName } from "./legal-reviews";

export const BCP_TEMPLATE_VERSION = "BCP-1" as const;

export const BCP_SHEET_KINDS = ["README", "CONTROL", "DATA", "PLATFORM_LOG"] as const;
export type BcpSheetKind = (typeof BCP_SHEET_KINDS)[number];

export const BCP_COLUMN_KINDS = [
  "ROW_KEY",
  "UUID",
  "REF",
  "DATETIME",
  "DATE",
  "EMAIL",
  "ENUM",
  "CODE",
  "TEXT",
  "VERSION",
] as const;
export type BcpColumnKind = (typeof BCP_COLUMN_KINDS)[number];

/** The object a row of an imported sheet becomes, through the command named. */
export const BCP_IMPORT_COMMANDS = {
  add_case_subject: "case_subject",
  add_allegation: "allegation",
  record_defence_response: "defence_response",
  open_corrective_action: "corrective_action",
  // BCP-C1 (migration 2110, ADR-047): a meeting held offline, and a conflict noted on paper raised by the secretary.
  record_offline_meeting: "meeting",
  raise_meeting_conflict: "meeting_conflict_concern",
} as const;
export type BcpImportCommand = keyof typeof BCP_IMPORT_COMMANDS;

export interface BcpColumn {
  code: string;
  kind: BcpColumnKind;
  required: boolean;
  /** TEXT only: the shortest trimmed value. */
  minLength?: number;
  maxLength: number;
  /** ENUM only. */
  allowed?: readonly string[];
}

export interface BcpSheet {
  code: string;
  kind: BcpSheetKind;
  /** Set on the sheets the template imports; every other DATA sheet is recorded only. */
  command?: BcpImportCommand;
  columns: readonly BcpColumn[];
}

const text = (code: string, minLength: number, maxLength: number, required = true): BcpColumn => ({
  code,
  kind: "TEXT",
  required,
  minLength,
  maxLength,
});

/** Every data row: its stable id, the platform object it is about (if any), and its offline provenance. */
const ROW_IDENTITY: readonly BcpColumn[] = [
  { code: "ROW_ID", kind: "ROW_KEY", required: true, maxLength: 64 },
  { code: "OBJECT_ID", kind: "UUID", required: false, maxLength: 36 },
  { code: "ORIGINAL_EVENT_AT", kind: "DATETIME", required: true, maxLength: 40 },
  { code: "RECORDED_OFFLINE_BY", kind: "EMAIL", required: true, maxLength: 254 },
];

/** A sheet a template records but does not import: what happened, and the platform object it concerns. */
const recorded = (code: string): BcpSheet => ({
  code,
  kind: "DATA",
  columns: [
    ...ROW_IDENTITY,
    { code: "REFERENCE_ID", kind: "UUID", required: false, maxLength: 36 },
    text("DETAILS", 3, 8000),
  ],
});

export const BCP_TEMPLATE: readonly BcpSheet[] = [
  { code: "00_README", kind: "README", columns: [] },
  {
    code: "01_CONTROL",
    kind: "CONTROL",
    columns: [
      { code: "TEMPLATE_VERSION", kind: "VERSION", required: true, maxLength: 10 },
      { code: "WORKBOOK_ID", kind: "ROW_KEY", required: true, maxLength: 64 },
      { code: "CASE_ID", kind: "UUID", required: true, maxLength: 36 },
      text("CASE_NUMBER", 3, 60),
      { code: "OFFLINE_FROM", kind: "DATETIME", required: true, maxLength: 40 },
      { code: "OFFLINE_TO", kind: "DATETIME", required: false, maxLength: 40 },
      { code: "PREPARED_BY", kind: "EMAIL", required: true, maxLength: 254 },
    ],
  },
  recorded("02_CASE_MASTER"),
  recorded("03_SOURCE_REFERRAL"),
  recorded("04_PRELIMINARY_REVIEW"),
  {
    code: "05_SUBJECTS",
    kind: "DATA",
    command: "add_case_subject",
    columns: [
      ...ROW_IDENTITY,
      text("DISPLAY_LABEL", 2, 200),
      {
        code: "SUBJECT_CATEGORY",
        kind: "ENUM",
        required: true,
        maxLength: 40,
        allowed: ["EMPLOYEE", "CONTRACTOR", "OTHER_AUTHORIZED"],
      },
    ],
  },
  {
    code: "06_ALLEGATIONS",
    kind: "DATA",
    command: "add_allegation",
    columns: [
      ...ROW_IDENTITY,
      { code: "CATEGORY", kind: "CODE", required: true, maxLength: 40 },
      text("DESCRIPTION", 10, 8000),
      { code: "SUBJECT_REF", kind: "REF", required: false, maxLength: 64 },
      text("POLICY_REFERENCE", 2, 200, false),
      text("LAW_REFERENCE", 2, 200, false),
    ],
  },
  recorded("07_INVESTIGATION"),
  recorded("08_INVESTIGATION_COMMITTEE"),
  recorded("09_MEETINGS"),
  recorded("10_ATTENDANCE"),
  recorded("11_CONFLICTS"),
  recorded("12_VOTES"),
  recorded("13_EVIDENCE_INDEX"),
  recorded("14_RECOMMENDATIONS"),
  recorded("15_SANCTIONS"),
  recorded("16_LEGAL_REVIEW"),
  recorded("17_AUTHORITY_DECISION"),
  {
    code: "18_EMPLOYEE_NOTICE",
    kind: "DATA",
    command: "record_defence_response",
    columns: [
      ...ROW_IDENTITY,
      { code: "NOTICE_ID", kind: "UUID", required: true, maxLength: 36 },
      {
        code: "CHANNEL",
        kind: "ENUM",
        required: true,
        maxLength: 40,
        allowed: [
          "EMAIL",
          "PHYSICAL_SUBMISSION",
          "SECRETARY_ENTRY",
          "BCP_IMPORT",
          "OTHER_AUTHORIZED_CHANNEL",
        ],
      },
      { code: "ORIGINAL_SUBMISSION_DATE", kind: "DATETIME", required: true, maxLength: 40 },
      text("RESPONSE_TEXT", 10, 20000),
      text("ORIGINAL_DOCUMENT_REFERENCE", 3, 300),
    ],
  },
  recorded("19_GRIEVANCE"),
  recorded("20_GRIEVANCE_COMMITTEE"),
  {
    code: "21_CORRECTIVE_ACTIONS",
    kind: "DATA",
    command: "open_corrective_action",
    columns: [
      ...ROW_IDENTITY,
      { code: "RECOMMENDATION_ITEM_ID", kind: "UUID", required: true, maxLength: 36 },
      text("TITLE", 5, 200),
      text("DESCRIPTION", 10, 4000),
      { code: "OWNER", kind: "EMAIL", required: true, maxLength: 254 },
      { code: "DUE_DATE", kind: "DATE", required: false, maxLength: 10 },
    ],
  },
  recorded("22_DOCUMENT_INDEX"),
  recorded("23_STATUS_HISTORY"),
  recorded("24_TIMELINE"),
  recorded("25_RECORDS"),
  {
    code: "26_IMPORT_AUDIT",
    kind: "PLATFORM_LOG",
    columns: [
      { code: "BATCH_ID", kind: "UUID", required: false, maxLength: 36 },
      { code: "IMPORTED_AT", kind: "DATETIME", required: false, maxLength: 40 },
      { code: "IMPORTED_BY", kind: "EMAIL", required: false, maxLength: 254 },
      text("RESULT", 0, 200, false),
    ],
  },
];

/**
 * The committee-proceeding workbook (migration 2110, ADR-047; AMB-201 without votes). One committee proceeding,
 * imported by its committee secretary with a registry entry for that proceeding (DEC-F30); the control row names the
 * proceeding and its committee, and the offline window is closed. 09_MEETINGS records a meeting already held inside
 * the window; 11_CONFLICTS raises a conflict noted on paper, as the secretary. 10_ATTENDANCE, 12_VOTES and
 * 22_DOCUMENT_INDEX are recorded only. A committee workbook is not submitted until its official signed record exists
 * (owner decision on AMB-201; CONFLICT:OFFICIAL_RECORD_REQUIRED).
 */
export const BCP_COMMITTEE_TEMPLATE_VERSION = "BCP-C1" as const;

export const BCP_COMMITTEE_TEMPLATE: readonly BcpSheet[] = [
  { code: "00_README", kind: "README", columns: [] },
  {
    code: "01_CONTROL",
    kind: "CONTROL",
    columns: [
      { code: "TEMPLATE_VERSION", kind: "VERSION", required: true, maxLength: 10 },
      { code: "WORKBOOK_ID", kind: "ROW_KEY", required: true, maxLength: 64 },
      { code: "COMMITTEE_PROCEEDING_ID", kind: "UUID", required: true, maxLength: 36 },
      text("COMMITTEE_CODE", 2, 20),
      { code: "OFFLINE_FROM", kind: "DATETIME", required: true, maxLength: 40 },
      { code: "OFFLINE_TO", kind: "DATETIME", required: true, maxLength: 40 },
      { code: "PREPARED_BY", kind: "EMAIL", required: true, maxLength: 254 },
    ],
  },
  {
    code: "09_MEETINGS",
    kind: "DATA",
    command: "record_offline_meeting",
    columns: [
      ...ROW_IDENTITY,
      { code: "PURPOSE", kind: "ENUM", required: true, maxLength: 40, allowed: ["DELIBERATION", "HEARING"] },
      {
        code: "MODE",
        kind: "ENUM",
        required: true,
        maxLength: 40,
        allowed: ["IN_PERSON", "TEAMS", "HYBRID"],
      },
      text("LOCATION", 2, 200, false),
      text("ONLINE_URL", 12, 500, false),
      { code: "HELD_START", kind: "DATETIME", required: true, maxLength: 40 },
      { code: "HELD_END", kind: "DATETIME", required: true, maxLength: 40 },
      text("PAPER_MINUTES_REFERENCE", 3, 300),
      text("REASON", 5, 2000),
    ],
  },
  recorded("10_ATTENDANCE"),
  {
    code: "11_CONFLICTS",
    kind: "DATA",
    command: "raise_meeting_conflict",
    columns: [
      ...ROW_IDENTITY,
      { code: "MEETING_REF", kind: "REF", required: true, maxLength: 64 },
      { code: "PARTICIPANT", kind: "EMAIL", required: true, maxLength: 254 },
      text("REASON", 10, 2000),
    ],
  },
  recorded("12_VOTES"),
  recorded("22_DOCUMENT_INDEX"),
  {
    code: "26_IMPORT_AUDIT",
    kind: "PLATFORM_LOG",
    columns: [
      { code: "BATCH_ID", kind: "UUID", required: false, maxLength: 36 },
      { code: "IMPORTED_AT", kind: "DATETIME", required: false, maxLength: 40 },
      { code: "IMPORTED_BY", kind: "EMAIL", required: false, maxLength: 254 },
      text("RESULT", 0, 200, false),
    ],
  },
];

export const BCP_TEMPLATE_VERSIONS = [BCP_TEMPLATE_VERSION, BCP_COMMITTEE_TEMPLATE_VERSION] as const;
export type BcpTemplateVersion = (typeof BCP_TEMPLATE_VERSIONS)[number];
export const BCP_TEMPLATES: Readonly<Record<BcpTemplateVersion, readonly BcpSheet[]>> = {
  [BCP_TEMPLATE_VERSION]: BCP_TEMPLATE,
  [BCP_COMMITTEE_TEMPLATE_VERSION]: BCP_COMMITTEE_TEMPLATE,
};

/** What a batch covers (migration 2110): one case (BCP-1) or one committee proceeding (BCP-C1). */
export const BCP_BATCH_SCOPES = ["CASE", "COMMITTEE_PROCEEDING"] as const;
export type BcpBatchScope = (typeof BCP_BATCH_SCOPES)[number];

/** Row 1 of a data sheet holds the column codes, row 2 their labels; data starts here. */
export const BCP_FIRST_DATA_ROW = 3;
/** Upper bounds the application and the database both enforce. */
export const BCP_MAX_ROWS = 2000;
export const BCP_MAX_CELL_LENGTH = 20000;
/** The largest workbook file accepted; checked before the file is scanned or read. */
export const BCP_MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;

export const BCP_BATCH_STATUSES = [
  "STAGED",
  "SUBMITTED",
  "APPROVED",
  "IMPORTED",
  "REJECTED",
  "CANCELLED",
] as const;
export type BcpBatchStatus = (typeof BCP_BATCH_STATUSES)[number];
export const BCP_ROW_STATES = ["NEW", "CONFLICT", "ALREADY_IMPORTED", "UNSUPPORTED", "INVALID"] as const;
export type BcpRowState = (typeof BCP_ROW_STATES)[number];
/** USE_OFFLINE, MERGE and NEW_VERSION are named by the owner's playbook; no BCP-1 command can apply them. */
export const BCP_RESOLUTIONS = [
  "IMPORT",
  "SKIP",
  "KEEP_PLATFORM",
  "USE_OFFLINE",
  "MERGE",
  "NEW_VERSION",
] as const;
export type BcpResolution = (typeof BCP_RESOLUTIONS)[number];
export const BCP_IMPORT_DECISIONS = ["APPROVE", "REJECT"] as const;
export type BcpImportDecision = (typeof BCP_IMPORT_DECISIONS)[number];
export const BCP_PROVENANCE_MARKERS = ["RECORDED_OFFLINE", "IMPORTED_LATER"] as const;

/** One non-empty data row as the reader found it: cells are strings until the database validates them. */
export interface BcpStagedRowInput {
  sheet: string;
  row_number: number;
  cells: Record<string, string>;
  has_formula: boolean;
}

export interface BcpPreviewRow {
  id: string;
  sheet: string;
  row_number: number;
  row_key: string | null;
  state: BcpRowState;
  detail: string | null;
  resolution: BcpResolution | null;
  outcome: string | null;
}

export interface BcpPreview {
  hash: string;
  clean: boolean;
  status: BcpBatchStatus;
  rows: BcpPreviewRow[];
}

export interface BcpImportCounts {
  imported: number;
  skipped: number;
  kept: number;
  already_imported: number;
}

/** A workbook as the reader returns it: every cell a string, formula cells flagged, empty cells left out. */
export interface BcpWorkbookCell {
  /** 1-based column (A = 1). */
  column: number;
  value: string;
  formula: boolean;
}

export interface BcpWorkbookRow {
  /** 1-based row number as in the sheet. */
  row: number;
  cells: BcpWorkbookCell[];
}

export interface BcpWorkbookSheet {
  name: string;
  rows: BcpWorkbookRow[];
}

export interface BcpWorkbook {
  sheets: BcpWorkbookSheet[];
}

/** A staged batch as its importer sees it, or an approver once it is submitted (authz.can_view_bcp_import). */
export interface BcpImportBatch {
  id: string;
  /** For a committee workbook, the proceeding's case: its importer sees the proceeding, never the case. */
  caseId: string;
  scope: BcpBatchScope;
  /** Set exactly when the scope is COMMITTEE_PROCEEDING. */
  committeeProceedingId: string | null;
  workbookId: string;
  templateVersion: string;
  status: BcpBatchStatus;
  importedBy: string;
  previewHash: string | null;
  previewClean: boolean;
  /** The hash an approval and the import are bound to. */
  submittedHash: string | null;
  createdAt: string;
  submittedAt: string | null;
  decidedAt: string | null;
}

/**
 * One row of a batch as `api.bcp_import_batch_view` returns it (UX redesign P12-6b-1): metadata only, never the cells,
 * and never a row about the reader (R4, 2110). `detail` names the problem of an INVALID row (a column code, or FORMULA,
 * DUPLICATE_ROW_ID and the like) or of a CONFLICT row (CHANGED_SINCE_IMPORT, EXISTING_OBJECT); `outcome` is the last
 * dry run's: OK, or the refusal code its command gave.
 */
export interface BcpImportRowView {
  rowId: string;
  sheetCode: string;
  rowNumber: number;
  rowKey: string | null;
  state: BcpRowState;
  detail: string | null;
  resolution: BcpResolution | null;
  resolutionReason: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  outcome: string | null;
  originalEventAt: string | null;
  recordedOfflineBy: string | null;
  purgedAt: string | null;
  /** `api.resolve_bcp_row` with SKIP, for this row and this caller now (2110:1615); other resolutions wait (F4). */
  maySkip: boolean;
}

/** Each flag is its command's own answer for the caller now (2110:1625-1646). */
export interface BcpImportBatchCapabilities {
  mayResolveRows: boolean;
  /** The importer's dry run (audited; while STAGED it stores the preview the submission is bound to). */
  mayPreview: boolean;
  maySubmit: boolean;
  /** APPROVE or REJECT. */
  mayDecide: boolean;
  /** APPROVE only: closed once the workbook is revoked as lost (AMB-205); REJECT stays open. */
  mayApprove: boolean;
  mayApply: boolean;
  mayCancel: boolean;
}

/** `api.bcp_import_batch_view` (2040, 2100, final 2110): NOT_FOUND unless `authz.can_view_bcp_import`. */
export interface BcpImportBatchView {
  batchId: string;
  templateVersion: string;
  workbookId: string;
  scope: BcpBatchScope;
  committeeProceedingId: string | null;
  fileSha256: string;
  offlineFrom: string;
  offlineTo: string | null;
  preparedBy: string;
  status: BcpBatchStatus;
  previewHash: string | null;
  previewedAt: string | null;
  previewClean: boolean;
  submittedHash: string | null;
  importedBy: string;
  decidedBy: string | null;
  decisionReason: string | null;
  createdAt: string;
  submittedAt: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
  rowVersion: number;
  currentHash: string;
  /** AMB-205: the workbook was reported lost; only a rejection or a cancellation remains. */
  workbookRevoked: boolean;
  /** A committee workbook (2110): it is submitted and imported only through its official record (ADR-061). */
  officialRecordRequired: boolean;
  counts: { rows: number; unresolved: number; byState: Partial<Record<BcpRowState, number>> };
  rows: BcpImportRowView[];
  /** Under case metadata only. */
  caseId: string | null;
  caseNumber: string | null;
  capabilities: BcpImportBatchCapabilities;
}

/** What the batch's page reads, in one transaction: the view, the names of the accounts it names, and the setting
 *  that says how long staged cells are kept once the import ends (DEC-F31: SOURCE_REQUIRED, nothing is cleared). */
export interface BcpImportBatchPage {
  view: BcpImportBatchView;
  people: AccountName[];
  stagingRetention: SettingStatus;
}
