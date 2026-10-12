/**
 * Business continuity workbook (ADR-027, ADR-034, migration 1960, owner Q&A Q100).
 * The template is reference data: exchange.bcp_template_sheet and exchange.bcp_template_column hold the same list,
 * and a database test keeps the two equal.
 */

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
  /** Set on the sheets BCP-1 imports; every other DATA sheet is recorded only. */
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

/** A sheet BCP-1 records but does not import: what happened, and the platform object it concerns. */
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

/** Row 1 of a data sheet holds the column codes, row 2 their labels; data starts here. */
export const BCP_FIRST_DATA_ROW = 3;
/** Upper bounds the application and the database both enforce. */
export const BCP_MAX_ROWS = 2000;
export const BCP_MAX_CELL_LENGTH = 20000;

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
