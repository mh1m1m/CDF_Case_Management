// How the legal review and authority pages name what the read models give them, in both languages (UX redesign
// Phase 12 P12-3a; ADR-057). Every code the contracts declare for a request, an opinion, a rule, an authority and its
// decision has its message, and so does every refusal a read model or command gives these pages and every message the
// commands' schemas give, so that a new code fails here rather than showing its key, or only the generic conflict, on
// the screen. An account is its name in the viewer's language.
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_CONDITION_KINDS,
  AUTHORITY_ITEM_OUTCOMES,
  AUTHORITY_OUTCOMES,
  AUTHORITY_RULE_COVERAGES,
  AUTHORITY_TYPES,
  LEGAL_OPINIONS,
  LEGAL_REVIEW_BASES,
  LEGAL_REVIEW_STATUSES,
  PACKET_PURPOSES,
  SOURCE_SIGNATURES,
} from "@cdf/contracts";
import { createTranslator, messagesFor, type Locale, type MessageKey } from "@cdf/i18n";
import {
  approveRestrictedLegalReviewSchema,
  cancelLegalReviewRequestSchema,
  giveLegalOpinionSchema,
  recordAuthorityDecisionSchema,
  requestLegalReviewSchema,
} from "@cdf/validation";
import { itemLabeller } from "../committee-proceedings/labels";
import { LEGAL_CODES, accountName, codeText } from "./labels";

const LOCALES: Locale[] = ["ar", "en"];
const ID = "8f8c2a52-4f0e-4b5a-9a43-0f7f2c1d9e10";
const OTHER = "1d3c6f0a-2b7e-4c51-8e9a-5f2d0c4b7a13";

const sorted = (values: readonly string[]) => [...values].sort();

describe("the legal review and authority codes", () => {
  for (const locale of LOCALES) {
    it(`each code the contracts declare has its message, and only those, in ${locale}`, () => {
      const lr = messagesFor(locale).legalReviews;
      const sections: [string, object, readonly string[]][] = [
        ["status", lr.status, LEGAL_REVIEW_STATUSES],
        ["basis", lr.basis, LEGAL_REVIEW_BASES],
        ["opinion", lr.opinion, LEGAL_OPINIONS],
        ["opinionHint", lr.opinionHint, LEGAL_OPINIONS],
        ["authorityType", lr.authorityType, AUTHORITY_TYPES],
        ["outcome", lr.outcome, AUTHORITY_OUTCOMES],
        ["outcomeHint", lr.outcomeHint, AUTHORITY_OUTCOMES],
        ["itemOutcome", lr.itemOutcome, AUTHORITY_ITEM_OUTCOMES],
        ["conditionKind", lr.conditionKind, AUTHORITY_CONDITION_KINDS],
        ["signature", lr.signature, SOURCE_SIGNATURES],
        // A rule's source; NO_RULE is said by its own line (noRule).
        ["ruleSource", lr.ruleSource, AUTHORITY_RULE_COVERAGES.filter((c) => c !== "NO_RULE")],
        ["packet.purpose", lr.packet.purpose, PACKET_PURPOSES],
        // L2 offers approved and deemed-approved minutes only (2030's command accepts no other).
        ["minutesStatus", lr.minutesStatus, ["APPROVED", "DEEMED_APPROVED"]],
      ];
      for (const [name, messages, codes] of sections) {
        expect(sorted(Object.keys(messages)), name).toEqual(sorted(codes));
        for (const [code, text] of Object.entries(messages))
          expect(typeof text === "string" && text.trim().length > 0, `${name}.${code}`).toBe(true);
      }
    });
  }
});

describe("the refusals the pages explain", () => {
  /** What each read model's block can hold (2095's decision.*_refusal helpers, less what R2 never passes on). */
  const blocks: [string, readonly string[]][] = [
    [
      "legalReviews.requestBlock",
      ["LEGAL_REVIEW_OPEN", "TAINTED_BY_CONFLICT", "AUTHORITY_APPROVAL_REQUIRED", "CASE_NOT_ACTIVE"],
    ],
    [
      "legalReviews.submitBlock",
      ["LEGAL_REVIEW_REQUIRED", "TAINTED_BY_CONFLICT", "AUTHORITY_RULE_MISSING", "CASE_NOT_ACTIVE"],
    ],
    ["legalReviews.recordBlock", ["AUTHORITY_RULE_MISSING", "CASE_NOT_ACTIVE"]],
    [
      "legalReviews.opinionBlock",
      [
        "FORBIDDEN",
        "REQUEST_CANCELLED",
        "OPINION_ALREADY_GIVEN",
        "OPINION_NOT_GIVEN",
        "PACKAGE_NOT_ADOPTED",
        "TAINTED_BY_CONFLICT",
      ],
    ],
  ];
  /** What the commands answer the forms with (2030's, 2060's and 2095's codes, and the fields they name). */
  const commands = [
    "PACKAGE_NOT_ADOPTED",
    "LEGAL_REVIEW_OPEN",
    "TAINTED_BY_CONFLICT",
    "AUTHORITY_APPROVAL_REQUIRED",
    "AUTHORITY_APPROVAL_SCOPE_EXCEEDED",
    "APPROVAL_ALREADY_PENDING",
    "CASE_NOT_RESTRICTED",
    "CASE_NOT_ACTIVE",
    "REQUEST_CANCELLED",
    "OPINION_ALREADY_GIVEN",
    "OPINION_NOT_GIVEN",
    "LEGAL_REVIEW_NOT_OPEN",
    "LEGAL_REVIEW_REQUIRED",
    "AUTHORITY_RULE_MISSING",
    "PACKAGE_NOT_AWAITING_AUTHORITY",
    "AUTHORITY_TYPE_MISMATCH",
    "AUTHORITY_ALREADY_DECIDED",
    "EXCLUSIVITY_GROUP_VIOLATION",
    "assigned_to",
    "reviewer_id",
    "finding_ids",
    "minutes_ids",
    "opinion",
    "opinion_text",
    "authority_type",
    "outcome",
    "decided_at",
    "decided_by_label",
    "source_document_reference",
    "source_signature",
    "unsigned_attestation",
    "delegation_reference",
    "additional_source_references",
    "item_outcomes",
    "modification",
    "conditions",
    "reason",
  ];

  for (const locale of LOCALES) {
    const t = createTranslator(locale);
    const generic = t("errors.CONFLICT");

    it(`each block has its own words, never the generic conflict, in ${locale}`, () => {
      for (const [section, codes] of blocks)
        for (const code of codes)
          expect(codeText(t, [section, ...LEGAL_CODES], code), `${section}.${code}`).not.toBe(generic);
    });

    it(`each refusal a form shows has its words, in ${locale}`, () => {
      for (const code of commands) expect(codeText(t, LEGAL_CODES, code), code).not.toBe(generic);
    });

    it(`a code nobody gave words to reads as the generic conflict, never as the code, in ${locale}`, () => {
      expect(codeText(t, LEGAL_CODES, "SOMETHING_NEW")).toBe(generic);
      // The page's own words win over the command's.
      expect(codeText(t, ["legalReviews.opinionBlock", ...LEGAL_CODES], "TAINTED_BY_CONFLICT")).toBe(
        t("legalReviews.opinionBlock.TAINTED_BY_CONFLICT"),
      );
      expect(codeText(t, LEGAL_CODES, "TAINTED_BY_CONFLICT")).toBe(
        t("legalReviews.codes.TAINTED_BY_CONFLICT"),
      );
    });
  }
});

describe("the legal review and authority schemas' messages", () => {
  const request = { packageId: ID, assignedTo: ID, reason: "Synthetic: a reason." };
  const decision = {
    packageId: ID,
    authorityType: "CEO",
    outcome: "APPROVE_AS_RECOMMENDED",
    decidedAt: "2026-10-01T10:00",
    decidedByLabel: "Chief Executive (synthetic)",
    sourceDocumentReference: "MEMO-DEMO-0001",
  };
  // Each check the schemas make, refused once.
  const refused = [
    requestLegalReviewSchema.safeParse({ ...request, assignedTo: "" }),
    requestLegalReviewSchema.safeParse({ ...request, reason: " " }),
    requestLegalReviewSchema.safeParse({ ...request, reason: "abc" }),
    requestLegalReviewSchema.safeParse({ ...request, findingIds: [ID, ID] }),
    approveRestrictedLegalReviewSchema.safeParse({ packageId: ID, reviewerId: ID, reason: "x".repeat(2001) }),
    cancelLegalReviewRequestSchema.safeParse({ requestId: "x", reason: "Synthetic: a reason." }),
    giveLegalOpinionSchema.safeParse({ requestId: ID, opinion: "CONFLICTS" }),
    recordAuthorityDecisionSchema.safeParse({ ...decision, decidedAt: "2999-01-01T10:00" }),
    recordAuthorityDecisionSchema.safeParse({ ...decision, sourceSignature: "UNSIGNED" }),
    recordAuthorityDecisionSchema.safeParse({
      ...decision,
      unsignedAttestation: "Synthetic: an attestation.",
    }),
    recordAuthorityDecisionSchema.safeParse({ ...decision, additionalSourceReferences: "MEMO-DEMO-0001" }),
    recordAuthorityDecisionSchema.safeParse({
      ...decision,
      outcome: "MODIFY",
      itemOutcomes: [
        { itemId: ID, outcome: "MODIFIED" },
        { itemId: OTHER, outcome: "APPROVED", modification: "Synthetic: changed." },
      ],
    }),
    recordAuthorityDecisionSchema.safeParse({
      ...decision,
      outcome: "REJECT",
      conditions: [{ kind: "FREE_TEXT", text: "Synthetic: a condition." }],
    }),
  ];
  const keys = [...new Set(refused.flatMap((r) => r.error?.issues.map((i) => i.message) ?? []))];

  it("refuse with each of the commands' checks", () => {
    expect(sorted(keys)).toEqual([
      "validation.attestationRequired",
      "validation.chooseOne",
      "validation.futureDate",
      "validation.invalid",
      "validation.modificationRequired",
      "validation.noAttestation",
      "validation.noConditions",
      "validation.noModification",
      "validation.opinionTextRequired",
      "validation.required",
      "validation.sources",
      "validation.tooLong",
      "validation.tooShort",
    ]);
  });

  for (const locale of LOCALES) {
    it(`each has its words in ${locale}`, () => {
      const t = createTranslator(locale);
      for (const key of keys) expect(t(key as MessageKey), key).not.toBe(key);
    });
  }
});

describe("labels", () => {
  const en = createTranslator("en");
  const ar = createTranslator("ar");

  it("an account is its name in the viewer's language, else the other, else a user", () => {
    const pi = { userId: ID, displayName: "Legal Reviewer Pi", displayNameAr: "المراجع القانوني باي" };
    expect(accountName(en, pi)).toBe("Legal Reviewer Pi");
    expect(accountName(ar, pi)).toBe("المراجع القانوني باي");
    expect(accountName(ar, { ...pi, displayNameAr: null })).toBe("Legal Reviewer Pi");
    expect(accountName(en, { ...pi, displayName: null })).toBe("المراجع القانوني باي");
    expect(accountName(en, { userId: ID, displayName: null, displayNameAr: null })).toBe(
      en("committeeProceedings.anAccount"),
    );
  });

  it("an item of a decision is its number and type in the package's order, or that it was withdrawn", () => {
    const pkg = {
      items: [
        { itemId: ID, itemType: "DISCIPLINARY_SANCTION" },
        { itemId: OTHER, itemType: "CORRECTIVE_ACTION" },
      ],
    } as Parameters<typeof itemLabeller>[1];
    const label = itemLabeller(en, pkg);
    expect(label(ID)).toBe(`Item 1 · ${en("committeeProceedings.itemType.DISCIPLINARY_SANCTION")}`);
    expect(label(OTHER)).toBe(`Item 2 · ${en("committeeProceedings.itemType.CORRECTIVE_ACTION")}`);
    expect(label("a-withdrawn-item")).toBe(en("committeeProceedings.withdrawnItem"));
    expect(itemLabeller(ar, pkg)(ID)).toBe(
      `${ar("committeeProceedings.itemNumber", { n: 1 })} · ${ar("committeeProceedings.itemType.DISCIPLINARY_SANCTION")}`,
    );
  });
});
