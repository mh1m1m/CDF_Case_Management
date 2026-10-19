// How the Administration pages name what their registers give them, in both languages (UX redesign Phase 12 P12-8a and
// P12-8b; ADR-051's P12-8a amendment, ADR-063). Every code the contracts declare for a register or a form's choices has
// its message, and only those, so that a new code fails here rather than showing its key on the screen; every refusal
// the pages' commands give has its own words, never only the generic one; and the helpers name a person, a period, a
// state and a source the way the pages say them: dates are Riyadh dates, and a provisional default never reads as
// configured.
import { describe, expect, it } from "vitest";
import {
  ADMIN_PERIOD_STATES,
  ADMIN_VIEWS,
  BUSINESS_CALENDAR_DAY_TYPES,
  COMPLETION_EVIDENCE_RULES,
  ESCALATION_RECIPIENT_KINDS,
  EXPORT_RULE_ACTIONS,
  EXPORT_RULE_AUDIENCES,
  GRIEVANCE_DECIDERS,
  GRIEVANCE_WINDOW_BASES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_RULE_LAYERS,
  NO_SUBSTANTIVE_VOTE_OUTCOMES,
  SEAT_CORRECTION_KINDS,
  SECTOR_POSITIONS,
  SETTING_STATUSES,
  type AccountName,
  type AdminSourceStatus,
} from "@cdf/contracts";
import { createTranslator, formatDate, isolate, messagesFor, type Locale, type MessageKey } from "@cdf/i18n";
import { refusalMessage } from "@cdf/ui";
import {
  ADMIN_CODES,
  SOURCE,
  period,
  personName,
  plusDays,
  riyadhDate,
  sourceLabel,
  stateLabel,
  stateTone,
} from "./labels";

const LOCALES: Locale[] = ["ar", "en"];
const ME = "a0000000-0000-4000-8000-000000000009";
const OTHER = "a0000000-0000-4000-8000-000000000003";
const GAMMA = "a0000000-0000-4000-8000-000000000004";
const UNSEEN = "a0000000-0000-4000-8000-000000000005";
const sorted = (values: readonly string[]) => [...values].sort();
const SOURCES: AdminSourceStatus[] = ["OWNER_DEFAULT", "SOURCE_REQUIRED", "APPROVED"];

describe("the Administration codes", () => {
  for (const locale of LOCALES) {
    it(`each code the contracts declare has its message, and only those, in ${locale}`, () => {
      const admin = messagesFor(locale).admin;
      const { label, ...views } = admin.views;
      expect(label.trim().length, "views.label").toBeGreaterThan(0);
      const sections: [string, object, readonly string[]][] = [
        ["views", views, ADMIN_VIEWS],
        ["state", admin.state, ADMIN_PERIOD_STATES],
        ["settingStatus", admin.settingStatus, SETTING_STATUSES],
        ["committees.correctionKind", admin.committees.correctionKind, SEAT_CORRECTION_KINDS],
        ["committees.decider", admin.committees.decider, GRIEVANCE_DECIDERS],
        ["committees.windowBasis", admin.committees.windowBasis, GRIEVANCE_WINDOW_BASES],
        [
          "committees.noSubstantiveVoteValue",
          admin.committees.noSubstantiveVoteValue,
          NO_SUBSTANTIVE_VOTE_OUTCOMES,
        ],
        ["sectors.positionValue", admin.sectors.positionValue, SECTOR_POSITIONS],
        ["notifications.channel", admin.notifications.channel, NOTIFICATION_CHANNELS],
        ["notifications.layer", admin.notifications.layer, NOTIFICATION_RULE_LAYERS],
        // What the notification page's table says for a template and a channel now: a mandatory rule, the event
        // rule's setting, or no rule in force.
        ["notifications.value", admin.notifications.value, ["ALWAYS", "ON", "OFF", "NO_RULE"]],
        ["exports.audience", admin.exports.audience, EXPORT_RULE_AUDIENCES],
        ["exports.action", admin.exports.action, EXPORT_RULE_ACTIONS],
        ["actions.completion", admin.actions.completion, COMPLETION_EVIDENCE_RULES],
        ["actions.recipient", admin.actions.recipient, ESCALATION_RECIPIENT_KINDS],
        // ISO days of the week, 1 Monday … 7 Sunday, as config.business_week_pattern stores them.
        ["calendar.isoDay", admin.calendar.isoDay, ["1", "2", "3", "4", "5", "6", "7"]],
        ["calendar.type", admin.calendar.type, BUSINESS_CALENDAR_DAY_TYPES],
        // The forms' choices (P12-8b).
        // Whose decision a committee rule the revision keeps follows (coordinator ruling of 2026-10-18 23:20).
        ["committees.decidedBy", admin.committees.decidedBy, ["OWNER", "RECORDED"]],
        ["committees.windowBasisOption", admin.committees.windowBasisOption, GRIEVANCE_WINDOW_BASES],
        ["actions.recipientOption", admin.actions.recipientOption, ESCALATION_RECIPIENT_KINDS],
        // A new purpose's own words for a code already in the catalogue (its form names no version).
        ["exports.addPurposeCodes", admin.exports.addPurposeCodes, ["STALE_VERSION"]],
      ];
      for (const [name, messages, codes] of sections) {
        expect(sorted(Object.keys(messages)), name).toEqual(sorted(codes));
        for (const [code, text] of Object.entries(messages))
          expect(typeof text === "string" && text.trim().length > 0, `${name}.${code}`).toBe(true);
      }
    });

    it(`the seven days of the week have seven different names, in ${locale}`, () => {
      const names = Object.values(messagesFor(locale).admin.calendar.isoDay);
      expect(new Set(names).size).toBe(7);
    });

    it(`each governed value's source has its words, in ${locale}`, () => {
      const t = createTranslator(locale);
      for (const s of SOURCES) expect(sourceLabel(t, s), s).not.toMatch(/^caseStructure\./);
      expect(new Set(SOURCES.map((s) => sourceLabel(t, s))).size).toBe(SOURCES.length);
    });
  }

  it("a provisional default or a missing source never reads as configured", () => {
    expect(SOURCE).toEqual({
      OWNER_DEFAULT: "OWNER_DEFAULT",
      SOURCE_REQUIRED: "SOURCE_REQUIRED",
      APPROVED: "CONFIGURED",
    });
  });
});

/**
 * What each Administration command answers besides FORBIDDEN and NOT_FOUND (which read as their class): its conflicts
 * and the fields it names when a value is invalid, as its final definition raises them (2030, 2040, 2127, 2128), and
 * the refusals the service and the gateway add (MANDATORY_NOTICE, RULE_CODE_EXISTS, LOOSER_*; coordinator ruling on
 * F4; DECIDED_OPTION, ruling of 2026-10-18 23:20; LOOSER_RULE_OPTION, ruling of 23:50).
 */
const REFUSALS: Record<string, { conflicts: string[]; fields: string[] }> = {
  set_business_calendar_day: {
    conflicts: ["CALENDAR_DAY_EXISTS"],
    fields: ["calendar_date", "day_type", "source_reference", "reason"],
  },
  set_business_week_pattern: {
    conflicts: ["PATTERN_SCHEDULED"],
    fields: ["effective_from", "non_working_isodow", "source_status", "reason"],
  },
  withdraw_business_calendar_day: {
    conflicts: ["CALENDAR_DAY_WITHDRAWN", "CALENDAR_DAY_PAST"],
    fields: ["reason"],
  },
  create_sector: { conflicts: ["SECTOR_CODE_TAKEN"], fields: ["code", "name_en", "name_ar"] },
  revoke_referral_delegation: { conflicts: ["DELEGATION_NOT_ACTIVE"], fields: ["reason"] },
  set_notification_rule: {
    conflicts: ["LATER_RULE_EXISTS", "MANDATORY_NOTICE"],
    fields: ["layer", "template_code", "committee_id", "channel", "enabled", "effective_from", "reason"],
  },
  set_export_rule: {
    conflicts: ["RULE_CODE_EXISTS", "LATER_RULE_EXISTS"],
    fields: [
      "code",
      "audience",
      "object_type",
      "restricted_only",
      "action",
      "effective_from",
      "source_status",
      "reason",
    ],
  },
  set_export_purpose: {
    conflicts: ["STALE_VERSION", "LEGACY_PURPOSE", "OTHER_REQUIRES_JUSTIFICATION"],
    fields: ["code", "name_en", "name_ar", "requires_justification", "is_active", "sort_order", "reason"],
  },
  set_corrective_action_policy: {
    conflicts: ["LATER_POLICY_EXISTS", "LOOSER_COMPLETION_EVIDENCE", "LOOSER_EVIDENCE_TYPES"],
    fields: [
      "action_type",
      "default_due_days",
      "reminder_days_before",
      "reminder_repeat_days",
      "overdue_after_days",
      "escalate_after_days",
      "completion_evidence",
      "allowed_evidence_types",
      "escalation_steps",
      "effective_from",
      "source_status",
      "reason",
    ],
  },
  revise_committee_rule_set: {
    conflicts: ["RULE_SET_SCHEDULED", "NO_RULE_SET", "DECIDED_OPTION", "LOOSER_RULE_OPTION"],
    fields: [
      "effective_from",
      "changes",
      "grievance_rules",
      "quorum",
      "minutes_review_business_days",
      "minimum_notice_days",
      "no_substantive_vote_outcome",
      "conflict_decider",
      "decision_rule",
      "ballot_secrecy",
      "grievance_window_days",
      "grievance_window_start_basis",
      "admissibility_decider",
      "non_admission_decider",
      "grievance_completion_days",
      "source_status",
      "reason",
    ],
  },
  // 2128 (the owner's decision F7 = B): an end dated before now needs its reference, checked when given.
  end_committee_membership: {
    conflicts: ["MEMBERSHIP_ENDED"],
    fields: ["effective_to", "reason", "end_reference"],
  },
  end_sector_membership: {
    conflicts: ["MEMBERSHIP_ALREADY_ENDED"],
    fields: ["effective_to", "reason", "end_reference"],
  },
};

describe("the refusals the Administration forms explain", () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale);

    it(`each refusal has its own words, never only the generic one, in ${locale}`, () => {
      for (const [command, { conflicts, fields }] of Object.entries(REFUSALS)) {
        for (const code of conflicts) {
          expect(refusalMessage(t, "CONFLICT", code, ADMIN_CODES), `${command} ${code}`).toBe(
            t(`admin.codes.${code}` as MessageKey),
          );
          expect(refusalMessage(t, "CONFLICT", code, ADMIN_CODES), `${command} ${code}`).not.toBe(
            t("errors.CONFLICT"),
          );
        }
        for (const field of fields) {
          expect(refusalMessage(t, "INVALID", field, ADMIN_CODES), `${command} ${field}`).toBe(
            t(`admin.codes.${field}` as MessageKey),
          );
          expect(refusalMessage(t, "INVALID", field, ADMIN_CODES), `${command} ${field}`).not.toBe(
            t("errors.INVALID"),
          );
        }
      }
      const all = Object.values(REFUSALS).flatMap(({ conflicts, fields }) => [...conflicts, ...fields]);
      expect(Object.keys(messagesFor(locale).admin.codes).sort()).toEqual([...new Set(all)].sort());
    });

    it(`a new purpose's code already in the catalogue says so, not that the page is out of date, in ${locale}`, () => {
      expect(
        refusalMessage(t, "CONFLICT", "STALE_VERSION", ["admin.exports.addPurposeCodes", ...ADMIN_CODES]),
      ).toBe(t("admin.exports.addPurposeCodes.STALE_VERSION"));
      expect(t("admin.exports.addPurposeCodes.STALE_VERSION")).not.toBe(t("admin.codes.STALE_VERSION"));
    });

    it(`a refusal nobody gave words to reads as its class, never as the code, in ${locale}`, () => {
      expect(refusalMessage(t, "CONFLICT", "SOMETHING_NEW", ADMIN_CODES)).toBe(t("errors.CONFLICT"));
      expect(refusalMessage(t, "FORBIDDEN", undefined, ADMIN_CODES)).toBe(t("errors.FORBIDDEN"));
      expect(refusalMessage(t, "NOT_FOUND", undefined, ADMIN_CODES)).toBe(t("errors.NOT_FOUND"));
    });
  }
});

describe("how a register names a person", () => {
  const people: AccountName[] = [
    { userId: OTHER, displayName: "Investigator Beta", displayNameAr: "المحقق بيتا" },
    { userId: GAMMA, displayName: "Witness Gamma", displayNameAr: null },
  ];

  for (const locale of LOCALES) {
    const t = createTranslator(locale);

    it(`the reader is "you", others by the directory's name, anyone else "an account", in ${locale}`, () => {
      expect(personName(t, people, ME, ME)).toBe(t("admin.you"));
      expect(personName(t, people, OTHER, ME)).toBe(locale === "ar" ? "المحقق بيتا" : "Investigator Beta");
      expect(personName(t, people, UNSEEN, ME)).toBe(t("admin.anAccount"));
      expect(personName(t, people, null, ME)).toBe("—");
    });
  }

  it("a name the directory has in one language only is shown in that language", () => {
    expect(personName(createTranslator("ar"), people, GAMMA, ME)).toBe("Witness Gamma");
  });
});

describe("how a register says a period and a state", () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale);

    it(`a period is said from its Riyadh dates, open or closed, in ${locale}`, () => {
      // 21:00 UTC is midnight in Riyadh: the row starts on the 18th there.
      const from = "2026-10-17T21:00:00Z";
      const to = "2027-01-01T00:00:00Z";
      const riyadh = (v: string) => isolate(formatDate(locale, v));
      expect(period(t, from, null)).toBe(t("admin.periodFrom", { from: riyadh(from) }));
      expect(period(t, from, to)).toBe(t("admin.periodBetween", { from: riyadh(from), to: riyadh(to) }));
      expect(formatDate(locale, from)).toBe(formatDate(locale, "2026-10-18T12:00:00Z"));
      expect(period(t, from, null)).not.toContain("2026-10-17");
    });

    it(`each state is said in words, in ${locale}`, () => {
      const words = ADMIN_PERIOD_STATES.map((s) => stateLabel(t, s));
      for (const [i, w] of words.entries()) expect(w, ADMIN_PERIOD_STATES[i]).not.toMatch(/^admin\./);
      expect(new Set(words).size).toBe(ADMIN_PERIOD_STATES.length);
    });
  }

  it("a state's tone only adds to its words", () => {
    expect(ADMIN_PERIOD_STATES.map(stateTone)).toEqual(["success", "info", "neutral"]);
  });
});

describe("the calendar date after a date", () => {
  it("counts calendar days, across a month, a year and a leap day", () => {
    expect(plusDays("2026-10-18", 0)).toBe("2026-10-18");
    expect(plusDays("2026-10-18", 1)).toBe("2026-10-19");
    expect(plusDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(plusDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(plusDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(plusDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(plusDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(plusDays("2026-10-18", 60)).toBe("2026-12-17");
    expect(plusDays("2026-11-01", -1)).toBe("2026-10-31");
  });
});

describe("the Riyadh date of a moment", () => {
  it("is the date in Riyadh, which is three hours ahead of UTC all year", () => {
    expect(riyadhDate("2026-10-18T20:59:59Z")).toBe("2026-10-18");
    expect(riyadhDate("2026-10-18T21:00:00Z")).toBe("2026-10-19");
    expect(riyadhDate("2026-12-31T21:30:00Z")).toBe("2027-01-01");
    expect(riyadhDate("2027-06-30T12:00:00+00:00")).toBe("2027-06-30");
    expect(riyadhDate("2026-10-19T00:00:00+03:00")).toBe("2026-10-19");
  });
});
