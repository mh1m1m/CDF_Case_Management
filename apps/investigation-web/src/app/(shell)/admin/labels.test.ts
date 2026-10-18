// How the Administration pages name what their registers give them, in both languages (UX redesign Phase 12 P12-8a;
// ADR-051's P12-8a amendment). Every code the contracts declare for a register has its message, and only those, so
// that a new code fails here rather than showing its key on the screen; every refusal the business calendar's two
// commands give has the calendar's own words, never only the generic one; and the helpers name a person, a period, a
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

describe("the refusals the business calendar's forms explain", () => {
  /** What api.set_business_calendar_day and api.set_business_week_pattern answer besides FORBIDDEN (2030). */
  const conflicts = ["CALENDAR_DAY_EXISTS", "PATTERN_SCHEDULED"];
  const fields = [
    "calendar_date",
    "day_type",
    "source_reference",
    "reason",
    "effective_from",
    "non_working_isodow",
    "source_status",
  ];

  for (const locale of LOCALES) {
    const t = createTranslator(locale);

    it(`each refusal has the calendar's own words, never only the generic one, in ${locale}`, () => {
      for (const code of conflicts) {
        expect(refusalMessage(t, "CONFLICT", code, ADMIN_CODES), code).toBe(
          t(`admin.codes.${code}` as MessageKey),
        );
        expect(refusalMessage(t, "CONFLICT", code, ADMIN_CODES), code).not.toBe(t("errors.CONFLICT"));
      }
      for (const field of fields) {
        expect(refusalMessage(t, "INVALID", field, ADMIN_CODES), field).toBe(
          t(`admin.codes.${field}` as MessageKey),
        );
        expect(refusalMessage(t, "INVALID", field, ADMIN_CODES), field).not.toBe(t("errors.INVALID"));
      }
      expect(Object.keys(messagesFor(locale).admin.codes).sort()).toEqual([...conflicts, ...fields].sort());
    });

    it(`a refusal nobody gave words to reads as its class, never as the code, in ${locale}`, () => {
      expect(refusalMessage(t, "CONFLICT", "SOMETHING_NEW", ADMIN_CODES)).toBe(t("errors.CONFLICT"));
      expect(refusalMessage(t, "FORBIDDEN", undefined, ADMIN_CODES)).toBe(t("errors.FORBIDDEN"));
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
