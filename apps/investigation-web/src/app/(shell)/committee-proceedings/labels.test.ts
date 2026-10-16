// How the proceeding's pages name what the read models give them, in both languages (UX redesign Phase 12 P12-2c;
// ADR-056). Every code the contracts declare for a package, an item, a vote on a finding, a taint and an invite has its
// message, and so does every message the commands' schemas give, so that a new code fails here rather than showing its
// key on the screen. A subject is a position and a category until DISPLAY_NAME gives a name (DEC-02: ORDINAL until the
// owner answers); an allegation is a position and a category, never its text.
import { describe, expect, it } from "vitest";
import {
  ALLEGATION_STATUSES,
  CASE_PERSON_ROLES,
  COMMITTEE_ITEM_RESULTS,
  FINDING_PROCEEDING_ROLES,
  INVITE_BASES,
  MEETING_INVITEE_ROLES,
  RECOMMENDATION_ITEM_FLAGS,
  RECOMMENDATION_ITEM_TYPES,
  RECOMMENDATION_PACKAGE_STATUSES,
  TAINT_RESOLUTIONS,
  VOTE_GRANULARITIES,
  isClosedAllegation,
  type SanctionCatalogueChoice,
  type SubjectRef,
} from "@cdf/contracts";
import { createTranslator, isolate, messagesFor, type Locale, type MessageKey } from "@cdf/i18n";
import {
  addRecommendationItemSchema,
  createRecommendationPackageSchema,
  inviteToMeetingSchema,
  resolveConflictTaintSchema,
  returnPackageToCommitteeSchema,
} from "@cdf/validation";
import { actLabel, type ConfirmAct } from "../confirmations";
import { allegationCategory, allegationName, sanctionName, sanctionOption, subjectName } from "./labels";

const LOCALES: Locale[] = ["ar", "en"];
const ID = "8f8c2a52-4f0e-4b5a-9a43-0f7f2c1d9e10";
/** The sanction codes migration 1900 ships in decision.sanction_catalogue; their labels live in packages/i18n. */
const CATALOGUE = ["WARNING", "SALARY_DEDUCTION", "SUSPENSION", "DEMOTION", "TERMINATION"];

const sorted = (values: readonly string[]) => [...values].sort();

describe("the proceeding's codes", () => {
  for (const locale of LOCALES) {
    it(`each code the contracts declare has its message, and only those, in ${locale}`, () => {
      const cp = messagesFor(locale).committeeProceedings;
      const sections: [string, object, readonly string[]][] = [
        ["packageStatus", cp.packageStatus, RECOMMENDATION_PACKAGE_STATUSES],
        ["statusNote", cp.statusNote, RECOMMENDATION_PACKAGE_STATUSES],
        ["itemType", cp.itemType, RECOMMENDATION_ITEM_TYPES],
        ["itemResult", cp.itemResult, COMMITTEE_ITEM_RESULTS],
        ["flag", cp.flag, RECOMMENDATION_ITEM_FLAGS],
        ["granularity", cp.granularity, VOTE_GRANULARITIES],
        ["granularityHint", cp.granularityHint, VOTE_GRANULARITIES],
        ["openVoteIntro", cp.openVoteIntro, VOTE_GRANULARITIES],
        ["taintResolution", cp.taintResolution, TAINT_RESOLUTIONS],
        ["taintResolutionHint", cp.taintResolutionHint, TAINT_RESOLUTIONS],
        ["findingRole", cp.findingRole, FINDING_PROCEEDING_ROLES],
        ["inviteBasis", cp.inviteBasis, INVITE_BASES],
        ["casePersonRole", cp.casePersonRole, CASE_PERSON_ROLES],
        ["sanction", cp.sanction, CATALOGUE],
        ["meetings.inviteeRole", messagesFor(locale).meetings.inviteeRole, MEETING_INVITEE_ROLES],
      ];
      for (const [name, messages, codes] of sections) {
        expect(sorted(Object.keys(messages)), name).toEqual(sorted(codes));
        for (const [code, text] of Object.entries(messages))
          expect(typeof text === "string" && text.trim().length > 0, `${name}.${code}`).toBe(true);
      }
    });
  }
});

describe("a closed allegation (CDF-238)", () => {
  it("withdrawn and superseded by a correction are closed; every other status is open", () => {
    expect(ALLEGATION_STATUSES.filter(isClosedAllegation)).toEqual(["WITHDRAWN", "SUPERSEDED"]);
    expect(isClosedAllegation("OPEN")).toBe(false);
    // A status a newer database adds is not closed until this version knows it: the database still refuses.
    expect(isClosedAllegation("SOMETHING_NEW")).toBe(false);
  });

  for (const locale of LOCALES) {
    it(`each allegation status has its label on the case's Allegations tab, and only those, in ${locale}`, () => {
      const labels = messagesFor(locale).caseWorkspace.allegationStatus;
      expect(sorted(Object.keys(labels))).toEqual(sorted(ALLEGATION_STATUSES));
      for (const [code, text] of Object.entries(labels))
        expect(typeof text === "string" && text.trim().length > 0, code).toBe(true);
    });
  }
});

describe("the package and invite schemas' messages", () => {
  /** A disciplinary sanction from the catalogue, about one subject, as the builder sends it. */
  const sanction = {
    packageId: ID,
    itemType: "DISCIPLINARY_SANCTION",
    sanctionCode: "WARNING",
    description: "Synthetic: a written warning.",
    subjectIds: [ID],
    requiresLegalJustification: false,
  };
  const invite = { meetingId: ID, requiresCoi: false, reason: "Synthetic: an invitee." };
  // Each length, code and pairing the commands check, refused once.
  const refused = [
    createRecommendationPackageSchema.safeParse({ committeeProceedingId: "x", voteGranularity: "BOTH" }),
    returnPackageToCommitteeSchema.safeParse({ packageId: ID, reason: "abc" }),
    returnPackageToCommitteeSchema.safeParse({ packageId: ID, reason: "x".repeat(2001) }),
    addRecommendationItemSchema.safeParse({ ...sanction, sanctionCode: "warning" }),
    addRecommendationItemSchema.safeParse({ ...sanction, proposedSanctionText: "A synthetic fine" }),
    addRecommendationItemSchema.safeParse({ ...sanction, sanctionCode: undefined }),
    addRecommendationItemSchema.safeParse({ ...sanction, subjectIds: [] }),
    addRecommendationItemSchema.safeParse({ ...sanction, itemType: "OTHER", subjectIds: [] }),
    resolveConflictTaintSchema.safeParse({ itemId: ID, resolution: "CONFIRM", reason: " " }),
    inviteToMeetingSchema.safeParse({ ...invite, inviteeRole: "INTERPRETER", invitee: `person:${ID}` }),
    inviteToMeetingSchema.safeParse({ ...invite, inviteeRole: "LEGAL", invitee: `person:${ID}` }),
    inviteToMeetingSchema.safeParse({ ...invite, inviteeRole: "SUBJECT", invitee: `account:${ID}` }),
  ];
  const keys = [...new Set(refused.flatMap((r) => r.error?.issues.map((i) => i.message) ?? []))];

  it("refuse with each of the commands' checks", () => {
    expect(sorted(keys)).toEqual([
      "validation.code",
      "validation.interpreterCoi",
      "validation.invalid",
      "validation.legalNeedsAccount",
      "validation.noSanction",
      "validation.oneSanction",
      "validation.required",
      "validation.sanctionRequired",
      "validation.subjectNeedsPerson",
      "validation.subjectRequired",
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
  const subject: SubjectRef = { subjectId: ID, position: 2, subjectCategory: "EMPLOYEE", label: null };

  it("a subject is its position and category until DISPLAY_NAME gives a name (DEC-02)", () => {
    expect(subjectName(en, subject)).toBe("Person concerned 2 · Employee");
    expect(subjectName(ar, subject)).toBe("المشكو في حقه 2 · موظف");
    expect(subjectName(en, { ...subject, label: "Employee Sigma" })).toBe("Employee Sigma");
    // A category a newer database adds has no label yet: the subject still reads as their position.
    const added = { ...subject, subjectCategory: "VISITOR" } as unknown as SubjectRef;
    expect(subjectName(en, added)).toBe("Person concerned 2 · None");
  });

  it("an allegation is its position and category, never its text", () => {
    expect(allegationName(en, { position: 3, category: "FRAUD" })).toBe("Allegation 3 · Fraud");
    expect(allegationName(ar, { position: 3, category: "FRAUD" })).toBe("الادعاء 3 · احتيال");
    expect(allegationCategory(en, "FRAUD")).toBe("Fraud");
    expect(allegationCategory(ar, "UNLISTED")).toBe("لا يوجد");
  });

  it("a sanction code is its label, or the code itself when the catalogue adds one later", () => {
    expect(sanctionName(en, "WARNING")).toBe("Warning");
    expect(sanctionName(ar, "SUSPENSION")).toBe(messagesFor("ar").committeeProceedings.sanction.SUSPENSION);
    expect(sanctionName(en, "COMMUNITY_SERVICE")).toBe("COMMUNITY_SERVICE");
  });

  it("the builder marks a provisional code and one with no version in force", () => {
    const warning: SanctionCatalogueChoice = {
      code: "WARNING",
      versionNo: 1,
      sourceStatus: "APPROVED",
      subjectCategories: ["EMPLOYEE"],
    };
    expect(sanctionOption(en, warning)).toBe("Warning");
    expect(sanctionOption(en, { ...warning, sourceStatus: "SOURCE_REQUIRED" })).toBe(
      en("committeeProceedings.sanctionProvisional", { sanction: isolate("Warning") }),
    );
    expect(sanctionOption(ar, { ...warning, versionNo: null })).toBe(
      ar("committeeProceedings.sanctionNotInForce", { sanction: isolate(sanctionName(ar, "WARNING")) }),
    );
    // No version in force wins: the adoption would be refused whatever the basis.
    expect(sanctionOption(en, { ...warning, versionNo: null, sourceStatus: "SOURCE_REQUIRED" })).toContain(
      "no version in force",
    );
  });
});

describe("the package forms' accessible names", () => {
  /** Each form's button: the act whose verb it shows, and the name that tells one package's form from another's. */
  const forms: [ConfirmAct | "addItem", string, Record<string, unknown>][] = [
    ["createRecommendationPackage", "createName", { ref: "IC-3F9A2C1B" }],
    ["addItem", "addItemName", { n: 2 }],
    ["submitPackageForVote", "submitName", { n: 2 }],
    ["openPackageVote", "openVoteName", { n: 2 }],
    ["openPackageVote", "openVoteInName", { n: 2, meeting: 3 }],
    ["recordPackageAdoption", "adoptName", { n: 2 }],
    ["returnPackageToCommittee", "returnName", { n: 2 }],
    ["withdrawRecommendationItem", "withdrawName", { n: 2 }],
    ["resolveConflictTaint", "taintName", { n: 2 }],
  ];

  for (const locale of LOCALES) {
    it(`each starts with its visible label, in ${locale} (WCAG 2.5.3)`, () => {
      const t = createTranslator(locale);
      for (const [act, key, params] of forms) {
        const visible = act === "addItem" ? t("committeeProceedings.addItem") : actLabel(t, act);
        const name = t(`committeeProceedings.${key}` as MessageKey, params as never);
        expect(name.startsWith(visible), `${key}: "${name}" starts with "${visible}"`).toBe(true);
        expect(name.length, key).toBeGreaterThan(visible.length);
      }
    });
  }
});
