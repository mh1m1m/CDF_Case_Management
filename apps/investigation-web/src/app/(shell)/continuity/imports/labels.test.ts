// How the continuity import page names what api.bcp_import_batch_view gives it, in both languages (UX redesign Phase 12
// P12-6b-1; ADR-034). Every code the contracts declare for a batch and its rows has its message, every data sheet of
// both templates has its name, every reason the database gives a row has its words, and so does every refusal the
// continuity commands give the page, so that a new code fails here rather than showing its key, or only the generic
// conflict, on the screen. The progress tracker follows the batch's status; a row's dry-run result never shows the
// command's code; and a person is "you", the directory's name, or "a user".
import { describe, expect, it } from "vitest";
import {
  BCP_BATCH_SCOPES,
  BCP_BATCH_STATUSES,
  BCP_COMMITTEE_BALLOT_TEMPLATE,
  BCP_COMMITTEE_TEMPLATE,
  BCP_RESOLUTIONS,
  BCP_ROW_STATES,
  BCP_TEMPLATE,
  type BcpBatchStatus,
  type BcpImportBatchView,
} from "@cdf/contracts";
import { createTranslator, messagesFor, type Locale, type MessageKey } from "@cdf/i18n";
import { refusalMessage } from "@cdf/ui";
import {
  BCP_CODES,
  BCP_STEPS,
  columnName,
  currentStep,
  detailText,
  outcomeText,
  personName,
  sheetName,
  stepState,
  throughOfficialRecord,
  unresolved,
} from "./labels";

const LOCALES: Locale[] = ["ar", "en"];
const ME = "8f8c2a52-4f0e-4b5a-9a43-0f7f2c1d9e10";
const OTHER = "1d3c6f0a-2b7e-4c51-8e9a-5f2d0c4b7a13";
const sorted = (values: readonly string[]) => [...values].sort();

/** Every template the importer can stage (the case's, the committee's, and the committee's with paper ballots). */
const TEMPLATES = [...BCP_TEMPLATE, ...BCP_COMMITTEE_TEMPLATE, ...BCP_COMMITTEE_BALLOT_TEMPLATE];

/** The data sheets of every template: the ones whose rows are staged and listed. */
const DATA_SHEETS = [
  ...new Set(TEMPLATES.filter((s) => s.kind !== "README" && s.kind !== "CONTROL").map((s) => s.code)),
];

describe("the continuity import codes", () => {
  for (const locale of LOCALES) {
    it(`each code the contracts declare has its message, and only those, in ${locale}`, () => {
      const ci = messagesFor(locale).continuityImports;
      const sections: [string, object, readonly string[]][] = [
        ["status", ci.status, BCP_BATCH_STATUSES],
        ["state", ci.state, BCP_ROW_STATES],
        ["resolution", ci.resolution, BCP_RESOLUTIONS],
        ["template", ci.template, BCP_BATCH_SCOPES],
        ["steps", ci.steps, BCP_STEPS],
        ["sheet", ci.sheet, DATA_SHEETS],
        // What the page says after each command that moves the batch on.
        ["done", ci.done, ["submitted", "approved", "rejected", "imported", "cancelled"]],
      ];
      for (const [name, messages, codes] of sections) {
        expect(sorted(Object.keys(messages)), name).toEqual(sorted(codes));
        for (const [code, text] of Object.entries(messages))
          expect(typeof text === "string" && text.trim().length > 0, `${name}.${code}`).toBe(true);
      }
    });

    it(`each sheet is named in the reader's language; one added later keeps its code, in ${locale}`, () => {
      const t = createTranslator(locale);
      for (const code of DATA_SHEETS) expect(sheetName(t, code), code).not.toBe(code);
      expect(sheetName(t, "27_LATER")).toBe("27_LATER");
    });
  }
});

describe("what is wrong with a row", () => {
  /**
   * What api.stage_bcp_import writes as a row's detail (2110): a formula, the first column that breaks its rule (any
   * column code), a duplicate row id, an event or recorder the batch cannot hold, a committee meeting's times, a
   * participant who is not a member, the importer's own conflict, and why a row conflicts with the platform.
   */
  const reasons = [
    "FORMULA",
    "DUPLICATE_ROW_ID",
    "ORIGINAL_EVENT_AT",
    "RECORDED_OFFLINE_BY",
    "HELD_START",
    "HELD_END",
    "PARTICIPANT",
    "OWN_CONFLICT",
    "CHANGED_SINCE_IMPORT",
    "EXISTING_OBJECT",
    // A paper ballot's row (2120): the same member twice on the same vote.
    "DUPLICATE_BALLOT",
  ];

  for (const locale of LOCALES) {
    const t = createTranslator(locale);

    it(`each reason the database gives has its own words, in ${locale}`, () => {
      for (const r of reasons) {
        expect(detailText(t, r), r).toBe(t(`continuityImports.detail.${r}` as MessageKey));
        expect(detailText(t, r), r).not.toContain(r);
      }
    });

    it(`a column that breaks its rule is named by its label, in ${locale}`, () => {
      const columns = TEMPLATES.flatMap((s) => s.columns.map((c) => c.code));
      for (const c of columns) {
        if (reasons.includes(c)) continue;
        expect(columnName(t, c), c).not.toBe(c);
        expect(detailText(t, c), c).toBe(t("continuityImports.detail.COLUMN", { column: columnName(t, c) }));
      }
      // A column added later keeps its code inside the same sentence.
      expect(detailText(t, "NEW_COLUMN")).toBe(
        t("continuityImports.detail.COLUMN", { column: "NEW_COLUMN" }),
      );
    });
  }
});

describe("a row's dry-run result", () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale);
    const refused = (reason: string) => t("continuityImports.outcome.refused", { reason });

    it(`is OK, or the refusal's words, never the command's code, in ${locale}`, () => {
      expect(outcomeText(t, "OK")).toBe(t("continuityImports.outcome.OK"));
      expect(outcomeText(t, "CDF_CONFLICT:CASE_NOT_ACTIVE")).toBe(
        refused(refusalMessage(t, "CONFLICT", "CASE_NOT_ACTIVE", BCP_CODES)),
      );
      // Only the first part of a detail names the reason; the rest stays on the server.
      expect(outcomeText(t, "CDF_INVALID:SUBJECT_REF:extra")).toBe(
        refused(refusalMessage(t, "INVALID", "SUBJECT_REF", BCP_CODES)),
      );
      expect(outcomeText(t, "CDF_FORBIDDEN")).toBe(refused(t("errors.FORBIDDEN")));
      // An unexpected error, or anything else, reads as the generic conflict.
      for (const other of ["CDF_ERROR", "CDF_SOMETHING:ELSE", "garbage"]) {
        expect(outcomeText(t, other), other).toBe(refused(t("errors.CONFLICT")));
        expect(outcomeText(t, other), other).not.toContain("SOMETHING");
      }
    });
  }
});

describe("the refusals the continuity import page explains", () => {
  /** What the continuity commands answer the page (api.resolve_bcp_row, preview, submit, decide, apply, cancel; 2110). */
  const refusals = [
    "NOT_STAGED",
    "NOTHING_TO_RESOLVE",
    "RESOLUTION_NOT_SUPPORTED",
    "RESOLUTION_NOT_ALLOWED",
    "OFFICIAL_RECORD_REQUIRED",
    "ROWS_UNRESOLVED",
    "PREVIEW_CHANGED",
    "DRY_RUN_FAILED",
    "NOT_SUBMITTED",
    "NOT_APPROVED",
    "NOT_OPEN",
    "WORKBOOK_REVOKED",
    // The import service's one code for a row that failed while applying (the row and its code stay on the server).
    "BCP_ROW_FAILED",
    // A paper ballot's row in the dry run (2120): what it was cast on is no longer what the meeting voted on.
    "TARGET_CHANGED",
    "PACKAGE_NOT_VOTING",
    "VOTE_ALREADY_OPENED",
  ];
  const fields = ["resolution", "decision", "reason", "rowId"];

  for (const locale of LOCALES) {
    const t = createTranslator(locale);

    it(`each refusal has the page's own words, in ${locale}`, () => {
      for (const code of refusals) {
        expect(refusalMessage(t, "CONFLICT", code, BCP_CODES), code).toBe(
          t(`continuityImports.codes.${code}` as MessageKey),
        );
        expect(refusalMessage(t, "CONFLICT", code, BCP_CODES), code).not.toBe(t("errors.CONFLICT"));
      }
      for (const field of fields)
        expect(refusalMessage(t, "INVALID", field, BCP_CODES), field).toBe(
          t(`continuityImports.codes.${field}` as MessageKey),
        );
    });
  }
});

type StepCase = Pick<BcpImportBatchView, "status" | "submittedAt" | "decidedAt">;
const at = "2026-10-18T09:00:00Z";
const step = (status: BcpBatchStatus, over: Partial<StepCase> = {}): StepCase => ({
  status,
  submittedAt: status === "STAGED" ? null : at,
  decidedAt: ["APPROVED", "IMPORTED", "REJECTED"].includes(status) ? at : null,
  ...over,
});
const states = (v: StepCase) => Object.fromEntries(BCP_STEPS.map((s) => [s, stepState(v, s)]));

describe("where an import stands", () => {
  it("each status has the step that waits now, and the steps before it are done", () => {
    expect(currentStep(step("STAGED"))).toBe("PREPARE");
    expect(currentStep(step("SUBMITTED"))).toBe("APPROVE");
    expect(currentStep(step("APPROVED"))).toBe("IMPORT");
    expect(currentStep(step("IMPORTED"))).toBeNull();
    expect(states(step("SUBMITTED"))).toEqual({ PREPARE: "done", APPROVE: "current", IMPORT: "upcoming" });
    expect(states(step("IMPORTED"))).toEqual({ PREPARE: "done", APPROVE: "done", IMPORT: "done" });
  });

  it("a rejection or a cancellation ends it where it was, and the steps it never took are skipped", () => {
    expect(currentStep(step("REJECTED"))).toBeNull();
    expect(states(step("REJECTED"))).toEqual({ PREPARE: "done", APPROVE: "skipped", IMPORT: "skipped" });
    // Cancelled while staged, after its submission, or once approved.
    expect(states(step("CANCELLED", { submittedAt: null }))).toEqual({
      PREPARE: "skipped",
      APPROVE: "skipped",
      IMPORT: "skipped",
    });
    expect(states(step("CANCELLED"))).toEqual({
      PREPARE: "done",
      APPROVE: "skipped",
      IMPORT: "skipped",
    });
    expect(states(step("CANCELLED", { submittedAt: at, decidedAt: at }))).toEqual({
      PREPARE: "done",
      APPROVE: "done",
      IMPORT: "skipped",
    });
  });

  it("a row needs a decision until it has one, unless it was imported before", () => {
    expect(unresolved({ resolution: null, state: "CONFLICT" })).toBe(true);
    expect(unresolved({ resolution: null, state: "INVALID" })).toBe(true);
    expect(unresolved({ resolution: null, state: "UNSUPPORTED" })).toBe(true);
    expect(unresolved({ resolution: null, state: "ALREADY_IMPORTED" })).toBe(false);
    expect(unresolved({ resolution: "IMPORT", state: "NEW" })).toBe(false);
    expect(unresolved({ resolution: "SKIP", state: "CONFLICT" })).toBe(false);
  });

  it("a committee workbook goes on only through its official record until it is imported or ends; a case one never", () => {
    const open: BcpBatchStatus[] = ["STAGED", "SUBMITTED", "APPROVED"];
    for (const status of BCP_BATCH_STATUSES) {
      expect(throughOfficialRecord({ officialRecordRequired: true, status })).toBe(open.includes(status));
      expect(throughOfficialRecord({ officialRecordRequired: false, status })).toBe(false);
    }
  });
});

describe("names on the continuity import page", () => {
  it("the reader is you; anyone else is the directory's name in the reader's language, or a user", () => {
    const people = [{ userId: OTHER, displayName: "Investigator Beta", displayNameAr: "المحقق بيتا" }];
    for (const locale of LOCALES) {
      const t = createTranslator(locale);
      expect(personName(t, people, ME, ME)).toBe(t("continuityImports.youName"));
      expect(personName(t, people, OTHER, ME)).toBe(locale === "ar" ? "المحقق بيتا" : "Investigator Beta");
      expect(personName(t, [], OTHER, ME)).toBe(t("continuityImports.anAccount"));
    }
  });
});
