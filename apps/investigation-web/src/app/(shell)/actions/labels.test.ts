// How the corrective-action pages name what the read models give them, in both languages (UX redesign Phase 12 P12-3b
// and P12-6a; ADR-058). Every code the contracts declare for an action, its owner, its block, a disposition, an entry
// of its history and a kind of evidence has its message, and so does every refusal the disposition, report,
// verification and reopening commands and the closure step give these pages and every message their schemas give, so
// that a new code fails here rather than showing its key, or only the generic conflict, on the screen. A calendar date
// is that day; an owner is their kind and the accountable person's name where the page has it; an entry of the history
// names who recorded it only where that is the reader or the owner the page can name.
import { describe, expect, it } from "vitest";
import {
  ACTION_BLOCKS,
  ACTION_DISPOSITIONS,
  ACTION_EVENT_TYPES,
  ACTION_OWNER_KINDS,
  ACTION_SOURCES,
  CORRECTIVE_ACTION_STATUSES,
  CORRECTIVE_ACTION_TYPES,
  CORRECTIVE_EVIDENCE_TYPES,
  type ActionEvent,
  type ActionOrigin,
  type ActionOwner,
} from "@cdf/contracts";
import { createTranslator, messagesFor, type Locale, type MessageKey } from "@cdf/i18n";
import {
  disposeSupersededCorrectiveActionSchema,
  recordCorrectiveActionProgressSchema,
  reopenCorrectiveActionSchema,
  submitCorrectiveActionCompletionSchema,
  verifyCorrectiveActionSchema,
} from "@cdf/validation";
import { codeText } from "../legal-reviews/labels";
import {
  ACTION_CODES,
  DISPOSE_ACT,
  calendarDate,
  completionNeeds,
  withoutBlock,
  earlierVersions,
  eventText,
  eventWhen,
  evidenceText,
  governingKind,
  hasSubmitted,
  latestFirst,
  latestSubmission,
  nameOf,
  ownerText,
} from "./labels";

const LOCALES: Locale[] = ["ar", "en"];
const ID = "8f8c2a52-4f0e-4b5a-9a43-0f7f2c1d9e10";
const OTHER = "1d3c6f0a-2b7e-4c51-8e9a-5f2d0c4b7a13";

const sorted = (values: readonly string[]) => [...values].sort();

describe("the corrective-action codes", () => {
  for (const locale of LOCALES) {
    it(`each code the contracts declare has its message, and only those, in ${locale}`, () => {
      const ca = messagesFor(locale).correctiveActions;
      const sections: [string, object, readonly string[]][] = [
        ["status", ca.status, CORRECTIVE_ACTION_STATUSES],
        ["type", ca.type, CORRECTIVE_ACTION_TYPES],
        ["source", ca.source, ACTION_SOURCES],
        // Each kind, and the person the page cannot name.
        ["owner", ca.owner, [...ACTION_OWNER_KINDS, "person"]],
        ["block", ca.block, ACTION_BLOCKS],
        ["blockBody", ca.blockBody, ACTION_BLOCKS],
        ["disposition", ca.disposition, ACTION_DISPOSITIONS],
        ["dispositionHint", ca.dispositionHint, ACTION_DISPOSITIONS],
        ["governing", ca.governing, ["ORIGINAL", "REPLACEMENT", "NONE"]],
        // Each entry of the history, and an opening or a due date change that names its date (P12-6a).
        ["event", ca.event, [...ACTION_EVENT_TYPES, "OPENED_DUE", "DUE_DATE_CHANGED_TO", "PROGRESS_AT"]],
        ["evidenceType", ca.evidenceType, CORRECTIVE_EVIDENCE_TYPES],
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
  /** What api.dispose_superseded_corrective_action answers (2030 as 2090 leaves it), and the fields it names. */
  const dispose = [
    "NOT_SUPERSEDED",
    "ALREADY_DISPOSED",
    "ITEM_NOT_APPROVED",
    "ACTION_CLOSED",
    "RESTRICTED_CASE_AUTHORITY_REQUIRED",
    "CASE_NOT_ACTIVE",
    "disposition",
    "source_document_reference",
    "reason",
    "title",
    "description",
    "owner_id",
    "due_date",
  ];
  /**
   * What the owner's report, the verification and a reopening answer (api.record_corrective_action_progress,
   * the four-argument api.submit_corrective_action_completion, api.verify_corrective_action and
   * api.reopen_corrective_action, 1940 and 2040; the freeze trigger's block codes, 2030), and the fields they name.
   * The block codes share one sentence, which never says why: the case team reads why on the page; no one else does.
   */
  const report = [
    "ACTION_NOT_ACTIVE",
    "NOT_PENDING_VERIFICATION",
    "NOT_COMPLETED",
    "CASE_NOT_ACTIVE",
    "ACTION_BLOCKED",
    ...ACTION_BLOCKS,
    "percent_complete",
    "note",
    "evidence_reference",
    "evidence_type",
    "decision",
    "reason",
  ];
  /** Why a step out of ACTIVE is refused (case_mgmt.closure_blocks, 2070; the closure rule, 2060), on the overview. */
  const closure = [
    "CONFLICT_REMEDIATION_OPEN",
    "TAINTED_BY_CONFLICT",
    "FROZEN_BY_SUPERSEDED_DECISION",
    "CORRECTIVE_ACTIONS_OUTSTANDING",
    "OPEN_PROCEEDINGS",
    "GRIEVANCE_WINDOW_OPEN",
    "DECISION_NOT_FINAL",
    "CLOSURE_APPROVAL_REQUIRED",
    "CASE_CLOSURE_APPROVAL_RULE_REQUIRED",
  ];

  for (const locale of LOCALES) {
    const t = createTranslator(locale);
    const generic = t("errors.CONFLICT");

    it(`each refusal the disposition form shows has its own words, in ${locale}`, () => {
      for (const code of dispose) {
        expect(codeText(t, ACTION_CODES, code), code).not.toBe(generic);
        expect(codeText(t, ACTION_CODES, code), code).toBe(
          t(`correctiveActions.codes.${code}` as MessageKey),
        );
      }
    });

    it(`each refusal the report, verify and reopen forms show has its own words, in ${locale}`, () => {
      for (const code of report) {
        expect(codeText(t, ACTION_CODES, code), code).not.toBe(generic);
        expect(codeText(t, ACTION_CODES, code), code).toBe(
          t(`correctiveActions.codes.${code}` as MessageKey),
        );
      }
      // One sentence for every block code: the words never say which one held the action.
      expect(
        new Set(["ACTION_BLOCKED", ...ACTION_BLOCKS].map((b) => codeText(t, ACTION_CODES, b))).size,
      ).toBe(1);
    });

    it(`each reason the closure step is refused for has its words, in ${locale}`, () => {
      for (const code of closure) expect(t.code("codes", code, "errors.CONFLICT"), code).not.toBe(generic);
    });

    it(`a code nobody gave words to reads as the generic conflict, never as the code, in ${locale}`, () => {
      expect(codeText(t, ACTION_CODES, "SOMETHING_NEW")).toBe(generic);
    });
  }
});

describe("the disposition schema's messages", () => {
  const base = {
    actionId: ID,
    sourceDocumentReference: "MEMO-DEMO-2096-02",
    reason: "Synthetic: the replacement decision says so.",
  };
  const reword = { title: "Synthetic: a new title", description: "Synthetic: what the action now requires." };
  // Each check the schema makes, refused once; and each disposition as the form sends it, accepted.
  const refused = [
    disposeSupersededCorrectiveActionSchema.safeParse({ ...base, disposition: "CARRY_FORWARD" }),
    disposeSupersededCorrectiveActionSchema.safeParse({ ...base, disposition: "RE_ADOPT", reason: "abc" }),
    disposeSupersededCorrectiveActionSchema.safeParse({
      ...base,
      disposition: "WAIVE",
      sourceDocumentReference: "x".repeat(301),
    }),
    disposeSupersededCorrectiveActionSchema.safeParse({ ...base, disposition: "RE_ADOPT", ...reword }),
    disposeSupersededCorrectiveActionSchema.safeParse({
      ...base,
      disposition: "WAIVE",
      dueDate: "2099-01-01",
    }),
    disposeSupersededCorrectiveActionSchema.safeParse({ ...base, disposition: "MODIFY" }),
    disposeSupersededCorrectiveActionSchema.safeParse({
      ...base,
      disposition: "MODIFY",
      ...reword,
      ownerId: ID,
    }),
    disposeSupersededCorrectiveActionSchema.safeParse({
      ...base,
      disposition: "REPLACE_WITH_NEW_ACTION",
      ...reword,
    }),
    disposeSupersededCorrectiveActionSchema.safeParse({
      ...base,
      disposition: "REPLACE_WITH_NEW_ACTION",
      ...reword,
      ownerId: OTHER,
      dueDate: "1 Jan 2099",
    }),
  ];
  const keys = [...new Set(refused.flatMap((r) => r.error?.issues.map((i) => i.message) ?? []))];

  it("refuses each mismatch between a disposition and its fields", () => {
    for (const r of refused) expect(r.success).toBe(false);
    expect(keys.length).toBeGreaterThan(0);
  });

  it("accepts each disposition with the fields its form sends", () => {
    for (const parsed of [
      { ...base, disposition: "RE_ADOPT" },
      { ...base, disposition: "WAIVE" },
      { ...base, disposition: "MODIFY", ...reword },
      { ...base, disposition: "MODIFY", ...reword, dueDate: "2099-01-01" },
      { ...base, disposition: "REPLACE_WITH_NEW_ACTION", ...reword, ownerId: OTHER },
      { ...base, disposition: "REPLACE_WITH_NEW_ACTION", ...reword, ownerId: OTHER, dueDate: "2099-01-01" },
    ])
      expect(disposeSupersededCorrectiveActionSchema.safeParse(parsed).success, parsed.disposition).toBe(
        true,
      );
  });

  for (const locale of LOCALES) {
    it(`each message has its words in ${locale}`, () => {
      const t = createTranslator(locale);
      for (const key of keys) expect(t(key as MessageKey), key).not.toBe(key);
    });
  }
});

describe("the report, verify and reopen schemas' messages", () => {
  const keys = [
    ...new Set(
      [
        recordCorrectiveActionProgressSchema.safeParse({ actionId: "1", percentComplete: "", note: "" }),
        recordCorrectiveActionProgressSchema.safeParse({
          actionId: ID,
          percentComplete: "101",
          note: "x".repeat(4001),
        }),
        submitCorrectiveActionCompletionSchema.safeParse({
          actionId: ID,
          note: "abc",
          evidenceType: "DOCUMENT",
        }),
        submitCorrectiveActionCompletionSchema.safeParse({
          actionId: ID,
          note: "Synthetic.",
          evidenceReference: "ab",
        }),
        verifyCorrectiveActionSchema.safeParse({ actionId: ID, decision: "RETURNED" }),
        verifyCorrectiveActionSchema.safeParse({ actionId: ID }),
        reopenCorrectiveActionSchema.safeParse({ actionId: ID, reason: "abc" }),
      ].flatMap((r) => r.error?.issues.map((i) => i.message) ?? []),
    ),
  ];

  it("gives the form a message for each problem", () => {
    expect(keys).toEqual(
      expect.arrayContaining([
        "validation.invalid",
        "validation.required",
        "validation.tooShort",
        "validation.tooLong",
      ]),
    );
  });

  for (const locale of LOCALES) {
    it(`each message has its words in ${locale}`, () => {
      const t = createTranslator(locale);
      for (const key of keys) expect(t(key as MessageKey), key).not.toBe(key);
    });
  }
});

describe("labels", () => {
  const en = createTranslator("en");
  const ar = createTranslator("ar");
  const user: ActionOwner = {
    kind: "USER",
    accountableUserId: ID,
    sector: null,
    pool: null,
    externalPartyLabel: null,
  };

  it("a calendar date is that day in the viewer's language", () => {
    expect(calendarDate(en, "2026-12-31")).toContain("2026");
    expect(calendarDate(en, "2026-12-31")).toContain("31");
    expect(calendarDate(ar, "2026-12-31")).not.toBe(calendarDate(en, "2026-12-31"));
  });

  it("a name is the viewer's language's, else the other, else none", () => {
    const chi = { displayName: "Employee Chi", displayNameAr: "الموظف تشي" };
    expect(nameOf(en, chi)).toBe("Employee Chi");
    expect(nameOf(ar, chi)).toBe("الموظف تشي");
    expect(nameOf(ar, { ...chi, displayNameAr: null })).toBe("Employee Chi");
    expect(nameOf(en, { displayName: null, displayNameAr: null })).toBeNull();
    expect(nameOf(en, null)).toBeNull();
  });

  it("an owner is their kind and the accountable person, or a named person the page cannot name", () => {
    expect(ownerText(en, user, "Employee Chi")).toContain("Employee Chi");
    expect(ownerText(en, user, null)).toContain(en("correctiveActions.owner.person"));
    const unit = ownerText(
      ar,
      {
        ...user,
        kind: "ORG_UNIT",
        sector: { sectorId: OTHER, code: "FIN", nameEn: "Finance", nameAr: "المالية" },
      },
      "الموظف تشي",
    );
    expect(unit).toContain("المالية");
    expect(unit).toContain("الموظف تشي");
    expect(
      ownerText(en, { ...user, kind: "SHARED_POOL", pool: { code: "P1", name: "Synthetic pool" } }, null),
    ).toContain("Synthetic pool");
    expect(
      ownerText(
        en,
        { ...user, kind: "EXTERNAL_PARTY", externalPartyLabel: "Synthetic Contractor" },
        "Employee Chi",
      ),
    ).toContain("Synthetic Contractor");
  });

  it("the decision an action carries out now: the one it was opened under, a replacement, or none", () => {
    const o = (governing: string | null, original: string | null) =>
      ({ governingDecisionId: governing, authorityDecisionId: original }) as ActionOrigin;
    expect(governingKind(o(ID, ID))).toBe("ORIGINAL");
    expect(governingKind(o(OTHER, ID))).toBe("REPLACEMENT");
    expect(governingKind(o(null, null))).toBe("NONE");
  });

  it("earlier wordings are those before the one the action carries, latest first", () => {
    const version = (n: number) => ({
      versionNo: n,
      title: `Synthetic: wording ${n}`,
      description: "Synthetic: a wording.",
      recordedBy: ID,
      recordedAt: "2026-10-15T10:00:00.000Z",
    });
    expect(earlierVersions({ versionNo: 1, versions: [] })).toEqual([]);
    expect(
      earlierVersions({ versionNo: 3, versions: [version(1), version(2), version(3)] }).map(
        (v) => v.versionNo,
      ),
    ).toEqual([2, 1]);
  });

  it("each disposition confirms with its own act, whose verb labels its button", () => {
    for (const d of ACTION_DISPOSITIONS) {
      const key = `confirm.acts.${DISPOSE_ACT[d]}.action`;
      expect(en(key as MessageKey), d).not.toBe(key);
      expect(ar(key as MessageKey), d).not.toBe(key);
    }
  });
  const event = (over: Partial<ActionEvent>): ActionEvent => ({
    eventId: OTHER,
    eventType: "PROGRESS",
    actorId: ID,
    note: null,
    evidenceReference: null,
    evidenceType: null,
    percentComplete: null,
    dueDate: null,
    createdAt: "2026-10-15T10:00:00.000Z",
    ...over,
  });

  it("an entry of the history says what happened: the percentage, the due date it set, or what was decided", () => {
    expect(eventText(en, event({ percentComplete: 40 }))).toBe(
      en("correctiveActions.event.PROGRESS_AT", { percent: 40 }),
    );
    expect(eventText(en, event({}))).toBe(en("correctiveActions.event.PROGRESS"));
    expect(eventText(en, event({ eventType: "OPENED", dueDate: "2026-12-31" }))).toContain("2026");
    expect(eventText(en, event({ eventType: "OPENED" }))).toBe(en("correctiveActions.event.OPENED"));
    expect(eventText(ar, event({ eventType: "DUE_DATE_CHANGED", dueDate: "2026-12-31" }))).toBe(
      ar("correctiveActions.event.DUE_DATE_CHANGED_TO", { date: calendarDate(ar, "2026-12-31") }),
    );
    expect(eventText(en, event({ eventType: "DUE_DATE_CHANGED" }))).toBe(
      en("correctiveActions.event.DUE_DATE_CHANGED"),
    );
    for (const type of ACTION_EVENT_TYPES)
      for (const t of [en, ar]) {
        const text = eventText(t, event({ eventType: type }));
        expect(text, type).not.toContain("correctiveActions.");
        expect(text.trim().length, type).toBeGreaterThan(0);
      }
  });

  it("an entry names who recorded it only where that is the reader or the owner the page can name", () => {
    const owner = { userId: OTHER, name: "Employee Chi" };
    expect(eventWhen(en, event({ actorId: ID }), ID, owner)).toContain("by you");
    expect(eventWhen(en, event({ actorId: OTHER }), ID, owner)).toContain("Employee Chi");
    // Anyone else, or an owner the page cannot name, stays unnamed: A2 gives an id, never a name.
    const third = "5e1f8a20-3c4d-4b6e-9f70-1a2b3c4d5e6f";
    for (const when of [
      eventWhen(en, event({ actorId: third }), ID, owner),
      eventWhen(en, event({ actorId: OTHER }), ID, { userId: OTHER, name: null }),
      eventWhen(en, event({ actorId: OTHER }), ID, { userId: null, name: "Employee Chi" }),
    ]) {
      expect(when).not.toContain("Employee Chi");
      expect(when).not.toContain(third);
      expect(when).not.toContain(OTHER);
    }
  });

  it("a completion's evidence is its reference and, where given, its kind; none without a reference", () => {
    expect(evidenceText(en, event({}))).toBeNull();
    expect(evidenceText(en, event({ evidenceReference: "DOC-DEMO-2026-0007" }))).toContain(
      "DOC-DEMO-2026-0007",
    );
    const typed = evidenceText(
      ar,
      event({ evidenceReference: "DOC-DEMO-2026-0007", evidenceType: "DOCUMENT" }),
    );
    expect(typed).toContain("DOC-DEMO-2026-0007");
    expect(typed).toContain(ar("correctiveActions.evidenceType.DOCUMENT"));
  });

  it("the history is listed latest first, and the verifier decides on the latest completion submitted", () => {
    const opened = event({ eventId: "e1", eventType: "OPENED" });
    const first = event({ eventId: "e2", eventType: "COMPLETION_SUBMITTED", actorId: OTHER });
    const returned = event({ eventId: "e3", eventType: "RETURNED", actorId: ID });
    const second = event({ eventId: "e4", eventType: "COMPLETION_SUBMITTED", actorId: OTHER });
    const events = [opened, first, returned, second];
    expect(latestFirst(events).map((e) => e.eventId)).toEqual(["e4", "e3", "e2", "e1"]);
    expect(events.map((e) => e.eventId)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(latestSubmission(events)?.eventId).toBe("e4");
    expect(latestSubmission([opened, returned])).toBeNull();
    expect(hasSubmitted(events, OTHER)).toBe(true);
    expect(hasSubmitted(events, ID)).toBe(false);
  });

  it("a completion needs what the policy in force asks: a reference unless a note alone will do, and a listed kind", () => {
    expect(completionNeeds({ completionEvidence: "REFERENCE_REQUIRED", allowedEvidenceTypes: null })).toEqual(
      {
        reference: true,
        type: false,
        types: CORRECTIVE_EVIDENCE_TYPES,
      },
    );
    expect(
      completionNeeds({
        completionEvidence: "NOTE_ONLY",
        allowedEvidenceTypes: ["DOCUMENT", "CONTROL_EVIDENCE"],
      }),
    ).toEqual({ reference: false, type: true, types: ["DOCUMENT", "CONTROL_EVIDENCE"] });
  });
  it("no answer names the block that held the action: each of the five leaves as ACTION_BLOCKED", () => {
    for (const block of ACTION_BLOCKS)
      expect(withoutBlock({ status: "error", kind: "CONFLICT", detail: block, ref: "r" }), block).toEqual({
        status: "error",
        kind: "CONFLICT",
        detail: "ACTION_BLOCKED",
        ref: "r",
      });
    // Every other answer is left as it is.
    for (const state of [
      { status: "ok" },
      { status: "error", kind: "CONFLICT", detail: "NOT_PENDING_VERIFICATION", ref: "r" },
      { status: "error", kind: "FORBIDDEN", ref: "r" },
      { status: "invalid", fieldErrors: { note: "validation.tooShort" } },
    ])
      expect(withoutBlock(state)).toEqual(state);
  });
});
