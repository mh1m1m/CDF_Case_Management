// How the export pages name what api.export_request_view and the audited preview give them, in both languages (UX
// redesign Phase 12 P12-6b-1; ADR-026). Every code the contracts declare for an export has its message, and so does
// every refusal the export commands give these pages and every message their schemas give, so that a new code fails
// here rather than showing its key, or only the generic conflict, on the screen. The progress tracker follows the
// export's status; a person is "you", the directory's name, or "a user"; and the preview shows every field the
// database renders, in the reader's language where the catalogue names it, and nothing of a withheld item.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EXPORT_APPROVAL_OUTCOMES,
  EXPORT_AUDIENCES,
  EXPORT_FORMATS,
  EXPORT_OBJECT_TYPES,
  EXPORT_RULE_ACTIONS,
  EXPORT_SOURCE_STATUSES,
  EXPORT_STATUSES,
  type Actor,
  type ExportDocumentItem,
  type ExportRequestView,
  type ExportStatus,
  type Permission,
} from "@cdf/contracts";
import { createTranslator, messagesFor, type Locale, type MessageKey } from "@cdf/i18n";
import { refusalMessage } from "@cdf/ui";
import { addExportRecipientSchema, requestExportFormSchema } from "@cdf/validation";
import { ExportItemContent } from "./content";
import {
  EXPORT_CODES,
  currentStep,
  exportSteps,
  itemKind,
  mayOpenPreview,
  personName,
  purposeName,
  ruleName,
  sourceLabel,
  stepState,
} from "./labels";

const LOCALES: Locale[] = ["ar", "en"];
const ME = "8f8c2a52-4f0e-4b5a-9a43-0f7f2c1d9e10";
const OTHER = "1d3c6f0a-2b7e-4c51-8e9a-5f2d0c4b7a13";
const sorted = (values: readonly string[]) => [...values].sort();

describe("the export codes", () => {
  for (const locale of LOCALES) {
    it(`each code the contracts declare has its message, and only those, in ${locale}`, () => {
      const ex = messagesFor(locale).exports;
      const sections: [string, object, readonly string[]][] = [
        ["status", ex.status, EXPORT_STATUSES],
        ["format", ex.format, EXPORT_FORMATS],
        ["formatHint", ex.formatHint, EXPORT_FORMATS],
        ["audience", ex.audience, EXPORT_AUDIENCES],
        ["audienceHint", ex.audienceHint, EXPORT_AUDIENCES],
        // Each kind of item, and one the catalogue adds later.
        ["objectType", ex.objectType, [...EXPORT_OBJECT_TYPES, "OTHER"]],
        ["stageDecided", ex.stageDecided, EXPORT_APPROVAL_OUTCOMES],
        ["authorityDecided", ex.authorityDecided, EXPORT_APPROVAL_OUTCOMES],
        ["ruleAction", ex.ruleAction, EXPORT_RULE_ACTIONS],
        ["steps", ex.steps, ["PREPARE", "APPROVE", "GENERATE", "SEND"]],
        // case_mgmt.case_record.case_type, as exchange.render_item gives it.
        ["caseType", ex.caseType, ["WHISTLEBLOWING", "INTERNAL_REFERRAL", "OTHER"]],
      ];
      for (const [name, messages, codes] of sections) {
        expect(sorted(Object.keys(messages)), name).toEqual(sorted(codes));
        for (const [code, text] of Object.entries(messages))
          expect(typeof text === "string" && text.trim().length > 0, `${name}.${code}`).toBe(true);
      }
    });

    it(`a governed rule's or purpose's source has its words, in ${locale}`, () => {
      const t = createTranslator(locale);
      for (const s of EXPORT_SOURCE_STATUSES) expect(sourceLabel(t, s), s).not.toMatch(/^caseStructure\./);
    });

    it(`every field exchange.render_item gives the preview has its name, in ${locale}`, () => {
      const field = messagesFor(locale).exports.field as Record<string, string>;
      // 1930: the fields of each kind of item, and of the item snapshot inside a package and of a decided item.
      const rendered = [
        ...[
          "case_number",
          "case_type",
          "title",
          "summary",
          "classification",
          "priority",
          "opened_at",
          "closed_at",
        ],
        ...[
          "version_no",
          "result",
          "rationale",
          "recorded_at",
          "allegation_category",
          "subject",
          "label",
          "category",
        ],
        ...["sequence_no", "status", "round_no", "adopted_at", "decided_at", "items"],
        ...["item_type", "sanction_code", "proposed_sanction_text", "verification_status", "description"],
        ...["case_wide", "committee_result", "subjects", "subject_id", "allegations", "allegation_id"],
        ...["authority_type", "outcome", "decided_by_label", "source_document_reference", "package_round"],
        ...["item_id", "modification", "finalised_at", "narrative"],
      ];
      for (const f of rendered) expect(field[f]?.trim().length ?? 0, f).toBeGreaterThan(0);
    });
  }
});

describe("the refusals the export pages explain", () => {
  /**
   * What the export commands answer (api.create_export_request, add_export_item, add_export_recipient,
   * submit_export_request, decide_export_request, decide_restricted_export, generate_export, cancel_export_request;
   * 1930 as 2040 leaves them), and the fields they name.
   */
  const refusals = [
    "ALREADY_ADDED",
    "ALREADY_DECIDED",
    "APPROVALS_CHANGED",
    "AUTHORITY_APPROVAL_NOT_REQUIRED",
    "AUTHORITY_APPROVAL_REQUIRED",
    "AWAITING_AUTHORITY_APPROVAL",
    "CASE_NOT_RESTRICTED",
    "CLASSIFICATION_MISMATCH",
    "FORMAT_HAS_NO_RECIPIENTS",
    "INTERNAL_AUDIENCE",
    "ITEMS_WITHHELD",
    "LEGACY_PURPOSE",
    "NOT_APPROVED",
    "NOT_CANCELLABLE",
    "NOT_DRAFT",
    "NOT_EMAIL",
    "NOT_GENERATED",
    "NOT_SUBMITTED",
    "NO_ITEMS",
    "NO_RECIPIENTS",
    "OTHER_REQUIRES_JUSTIFICATION",
    "PREVIEW_CHANGED",
    "RECIPIENT_NOT_ELIGIBLE",
    "REFUSED_BY_RULE",
    "REQUESTER_CANNOT_CONSENT",
    "TOO_MANY_ITEMS",
    "TOO_MANY_RECIPIENTS",
  ];
  const fields = ["email", "external_party", "justification", "purpose", "user_id", "decision", "reason"];

  for (const locale of LOCALES) {
    const t = createTranslator(locale);

    it(`each refusal of an export command has the export's own words, in ${locale}`, () => {
      for (const code of refusals) {
        expect(refusalMessage(t, "CONFLICT", code, EXPORT_CODES), code).toBe(
          t(`exports.codes.${code}` as MessageKey),
        );
        expect(refusalMessage(t, "CONFLICT", code, EXPORT_CODES), code).not.toBe(t("errors.CONFLICT"));
      }
      for (const field of fields)
        expect(refusalMessage(t, "INVALID", field, EXPORT_CODES), field).toBe(
          t(`exports.codes.${field}` as MessageKey),
        );
    });

    it(`a code nobody gave words to reads as the generic refusal, never as the code, in ${locale}`, () => {
      expect(refusalMessage(t, "CONFLICT", "SOMETHING_NEW", EXPORT_CODES)).toBe(t("errors.CONFLICT"));
    });
  }

  it("the request and recipient forms' own messages exist in both languages", () => {
    const external = requestExportFormSchema.safeParse({
      caseId: ME,
      format: "EMAIL",
      audience: "INTERNAL",
      purpose: "LEGAL_REVIEW",
    });
    const mismatch = addExportRecipientSchema.safeParse({
      requestId: ME,
      kind: "EXTERNAL",
      email: "witness.gamma@example.test",
      emailConfirmation: "witness.delta@example.test",
    });
    const messages = [external, mismatch].flatMap((r) =>
      r.success ? [] : r.error.issues.map((i) => i.message),
    );
    expect(messages).toEqual(
      expect.arrayContaining(["validation.emailExternalOnly", "validation.emailMismatch"]),
    );
    for (const locale of LOCALES) {
      const t = createTranslator(locale);
      for (const m of messages) expect(t(m as MessageKey), `${locale} ${m}`).not.toBe(m);
    }
  });
});

type StepCase = Pick<ExportRequestView, "status" | "format" | "submittedAt" | "decidedAt">;
const at = "2026-10-18T09:00:00Z";
const step = (status: ExportStatus, over: Partial<StepCase> = {}): StepCase => ({
  status,
  format: "EMAIL",
  submittedAt: status === "DRAFT" ? null : at,
  decidedAt: ["APPROVED", "GENERATED", "SENT", "REJECTED"].includes(status) ? at : null,
  ...over,
});
const states = (v: StepCase) => Object.fromEntries(exportSteps(v).map((s) => [s, stepState(v, s)]));

describe("where an export stands", () => {
  it("an email export is prepared, approved, generated and sent; a file is not sent", () => {
    expect(exportSteps({ format: "EMAIL" })).toEqual(["PREPARE", "APPROVE", "GENERATE", "SEND"]);
    expect(exportSteps({ format: "PDF" })).toEqual(["PREPARE", "APPROVE", "GENERATE"]);
    expect(exportSteps({ format: "XLSX" })).toEqual(["PREPARE", "APPROVE", "GENERATE"]);
  });

  it("each status has the step that waits now, and the steps before it are done", () => {
    expect(currentStep(step("DRAFT"))).toBe("PREPARE");
    expect(currentStep(step("SUBMITTED"))).toBe("APPROVE");
    expect(currentStep(step("APPROVED"))).toBe("GENERATE");
    expect(currentStep(step("GENERATED"))).toBe("SEND");
    expect(currentStep(step("SENT"))).toBeNull();
    // A file's path ends once it is generated.
    expect(currentStep(step("GENERATED", { format: "PDF" }))).toBeNull();
    expect(states(step("APPROVED"))).toEqual({
      PREPARE: "done",
      APPROVE: "done",
      GENERATE: "current",
      SEND: "upcoming",
    });
    expect(states(step("SENT"))).toEqual({
      PREPARE: "done",
      APPROVE: "done",
      GENERATE: "done",
      SEND: "done",
    });
  });

  it("a rejection or a cancellation ends it where it was, and the steps it never took are skipped", () => {
    expect(currentStep(step("REJECTED"))).toBeNull();
    expect(states(step("REJECTED"))).toEqual({
      PREPARE: "done",
      APPROVE: "skipped",
      GENERATE: "skipped",
      SEND: "skipped",
    });
    expect(states(step("CANCELLED", { submittedAt: null }))).toEqual({
      PREPARE: "skipped",
      APPROVE: "skipped",
      GENERATE: "skipped",
      SEND: "skipped",
    });
    expect(states(step("CANCELLED", { decidedAt: at }))).toEqual({
      PREPARE: "done",
      APPROVE: "done",
      GENERATE: "skipped",
      SEND: "skipped",
    });
  });
});

describe("names on the export pages", () => {
  const people = [{ userId: OTHER, displayName: "Investigator Beta", displayNameAr: "المحقق بيتا" }];

  it("the reader is you; anyone else is the directory's name in the reader's language, or a user", () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale);
      expect(personName(t, people, ME, ME)).toBe(t("exports.youName"));
      expect(personName(t, people, OTHER, ME)).toBe(locale === "ar" ? "المحقق بيتا" : "Investigator Beta");
      expect(personName(t, [], OTHER, ME)).toBe(t("exports.anAccount"));
    }
  });

  it("a purpose is the catalogue's name in the reader's language; one the catalogue no longer has keeps its code", () => {
    const purpose = {
      code: "REGULATORY_OR_EXTERNAL_AUTHORITY",
      nameEn: "Regulatory or external authority",
      nameAr: "جهة تنظيمية أو خارجية",
      requiresJustification: false,
      isActive: true,
      isLegacy: false,
      sourceStatus: "SOURCE_REQUIRED" as const,
    };
    expect(purposeName(createTranslator("en"), purpose, purpose.code)).toBe(
      "Regulatory or external authority",
    );
    expect(purposeName(createTranslator("ar"), purpose, purpose.code)).toBe("جهة تنظيمية أو خارجية");
    expect(purposeName(createTranslator("en"), null, "LEGACY_CODE")).toBe("LEGACY_CODE");
  });

  it("a rule is named where the catalogue names it, else by its code; an item by its kind", () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale);
      expect(ruleName(t, "RESTRICTED_CASE")).toBe(t("exports.rule.RESTRICTED_CASE"));
      expect(ruleName(t, "A_RULE_ADDED_LATER")).toBe("A_RULE_ADDED_LATER");
      expect(itemKind(t, { objectType: "MINUTES" })).toBe(t("exports.objectType.MINUTES"));
    }
  });

  it("the preview link is offered to a requester, an approver or a restricted case's authority only", () => {
    const actor = (permissions: Permission[]): Actor => ({
      userId: ME,
      email: "investigator.beta@example.test",
      displayName: "Investigator Beta",
      displayNameAr: "المحقق بيتا",
      roles: [],
      permissions,
      clearance: "CONFIDENTIAL",
    });
    for (const p of [
      "EXPORT_REQUEST",
      "EXPORT_APPROVE",
      "EXPORT_SECOND_APPROVE",
      "RESTRICTED_CASE_AUTHORITY",
    ] as Permission[])
      expect(mayOpenPreview(actor([p])), p).toBe(true);
    expect(mayOpenPreview(actor(["CASE_READ" as Permission]))).toBe(false);
    expect(mayOpenPreview(actor([]))).toBe(false);
  });
});

describe("the preview's document", () => {
  const render = (locale: Locale, item: ExportDocumentItem) =>
    renderToStaticMarkup(h(ExportItemContent, { t: createTranslator(locale), item }));

  const summary: ExportDocumentItem = {
    position: 1,
    objectType: "CASE_SUMMARY",
    objectId: ME,
    included: true,
    content: {
      case_number: "CDF-DEMO-2026-0001",
      case_type: "WHISTLEBLOWING",
      title: "Synthetic: procurement concern",
      summary: "Synthetic summary for the demo.",
      classification: "CONFIDENTIAL",
      priority: "HIGH",
      opened_at: "2026-10-01T08:00:00Z",
      closed_at: null,
    },
  };

  it("shows every field it renders, named and with its coded values in the reader's language", () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale);
      const html = render(locale, summary);
      for (const field of Object.keys(summary.content!))
        expect(html, field).toContain(`data-field="${field}"`);
      expect(html).toContain(t("exports.field.case_type"));
      expect(html).toContain(t("exports.caseType.WHISTLEBLOWING"));
      expect(html).toContain(t("classification.CONFIDENTIAL"));
      expect(html).toContain("CDF-DEMO-2026-0001");
      expect(html).toContain(t("exports.itemHeading", { n: 1, kind: t("exports.objectType.CASE_SUMMARY") }));
      expect(html).not.toContain("WHISTLEBLOWING<");
    }
  });

  it("names a person's category and an allegation's category from their own sections", () => {
    const t = createTranslator("en");
    const html = render("en", {
      position: 2,
      objectType: "FINDING",
      objectId: OTHER,
      included: true,
      content: {
        version_no: 1,
        result: "SUBSTANTIATED",
        allegation_category: "CONFLICT_OF_INTEREST",
        subject: { label: "Employee Alpha", category: "EMPLOYEE" },
      },
    });
    expect(html).toContain(t("subjectCategory.EMPLOYEE"));
    expect(html).toContain(t("category.CONFLICT_OF_INTEREST" as MessageKey));
    expect(html).toContain("Employee Alpha");
  });

  it("an identifier as long as a UUID wraps anywhere, so a phone never scrolls sideways; a case number stays whole", () => {
    const html = render("en", {
      position: 3,
      objectType: "RECOMMENDATION_PACKAGE",
      objectId: OTHER,
      included: true,
      content: {
        case_number: "CDF-DEMO-2026-0001",
        allegation_id: OTHER,
        source_document_reference: "REF-123",
      },
    });
    const cell = (field: string) =>
      new RegExp(`data-field="${field}"[\\s\\S]*?<bdi[^>]*class="([^"]*)"`).exec(html)?.[1];
    expect(cell("allegation_id")).toContain("break-all");
    expect(cell("source_document_reference")).toContain("break-all");
    expect(cell("case_number")).toContain("whitespace-nowrap");
  });

  it("a withheld item keeps its place and shows nothing of its content", () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale);
      const html = render(locale, { ...summary, included: false, content: null });
      expect(html).toContain('data-included="false"');
      expect(html).toContain(t("exports.withheldContent"));
      expect(html).not.toContain("data-field=");
    }
  });
});
