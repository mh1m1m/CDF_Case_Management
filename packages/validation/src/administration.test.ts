// The Administration forms' schemas (UX redesign Phase 12 P12-8a and P12-8b; ADR-051's P12-8a amendment, ADR-063;
// §45): the business calendar's (DEC-F02, migration 2030), and since P12-8b one per command of the other pages. The
// database decides every rule again, including whether a date is in the past in Riyadh, whether a day, a code or a
// later version already exists, and the version read (tests/integration/administration.spec.ts); here, what the form
// may send. No schema takes a source status. Messages are i18n keys.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  addExportPurposeSchema,
  addExportRuleSchema,
  CLEARABLE_RULE_KEYS,
  correctiveActionPolicyVersionSchema,
  createSectorSchema,
  DECIDED_RULE_KEYS,
  EDITABLE_RULE_KEYS,
  editExportPurposeSchema,
  GRIEVANCE_ONLY_RULE_KEYS,
  isDecidedRuleKey,
  isStrictestSafeguard,
  isTightenOnlyRuleKey,
  MAX_MINIMUM_NOTICE_DAYS,
  RULE_SET_REVISION_KEYS,
  reviseCommitteeRuleSetSchema,
  revokeReferralDelegationSchema,
  safeguardFloor,
  safeguardOffer,
  safeguardStrictness,
  setBusinessCalendarDaySchema,
  setBusinessWeekPatternSchema,
  setNotificationRuleSchema,
  TIGHTEN_ONLY_RULE_KEYS,
  withdrawBusinessCalendarDaySchema,
  type RuleSafeguards,
  type TightenOnlyRuleKey,
} from "./administration";
import { fieldErrors } from "./index";

/** What the form shows for a refused submit: each field's first message (`fieldErrors`, as the server action uses). */
const problems = (r: { success: true } | { success: false; error: z.ZodError }) =>
  r.success ? {} : fieldErrors(r.error);

const DAY = { calendarDate: "2027-01-03", dayType: "HOLIDAY", reason: "Synthetic: a demo holiday." };
const WEEK = { nonWorkingDays: ["5", "6"], effectiveFrom: "2027-01-03", reason: "Synthetic: a demo week." };

describe("a day in the business calendar", () => {
  it("takes each kind of day, with or without a source reference", () => {
    for (const dayType of ["HOLIDAY", "NON_WORKING_DAY", "WORKING_DAY"])
      expect(setBusinessCalendarDaySchema.parse({ ...DAY, dayType })).toEqual({
        ...DAY,
        dayType,
        sourceReference: undefined,
      });
    expect(
      setBusinessCalendarDaySchema.parse({
        ...DAY,
        sourceReference: "  CIRC-DEMO-2027-01  ",
        reason: "  Synthetic.  ",
      }),
    ).toEqual({ ...DAY, sourceReference: "CIRC-DEMO-2027-01", reason: "Synthetic." });
  });

  it("an empty source reference is no reference", () => {
    expect(
      setBusinessCalendarDaySchema.parse({ ...DAY, sourceReference: "   " }).sourceReference,
    ).toBeUndefined();
  });

  it("refuses what the command would refuse, field by field", () => {
    expect(problems(setBusinessCalendarDaySchema.safeParse({}))).toEqual({
      calendarDate: "validation.invalid",
      dayType: "validation.chooseOne",
      reason: "validation.invalid",
    });
    expect(problems(setBusinessCalendarDaySchema.safeParse({ ...DAY, calendarDate: "2027-02-30" }))).toEqual({
      calendarDate: "validation.invalid",
    });
    expect(
      problems(setBusinessCalendarDaySchema.safeParse({ ...DAY, calendarDate: "3 January 2027" })),
    ).toEqual({ calendarDate: "validation.invalid" });
    expect(problems(setBusinessCalendarDaySchema.safeParse({ ...DAY, dayType: "WEEKEND" }))).toEqual({
      dayType: "validation.chooseOne",
    });
    expect(problems(setBusinessCalendarDaySchema.safeParse({ ...DAY, sourceReference: "ab" }))).toEqual({
      sourceReference: "validation.tooShort",
    });
    expect(
      problems(setBusinessCalendarDaySchema.safeParse({ ...DAY, sourceReference: "x".repeat(201) })),
    ).toEqual({ sourceReference: "validation.tooLong" });
    expect(problems(setBusinessCalendarDaySchema.safeParse({ ...DAY, reason: " abcd " }))).toEqual({
      reason: "validation.tooShort",
    });
    expect(problems(setBusinessCalendarDaySchema.safeParse({ ...DAY, reason: "x".repeat(2001) }))).toEqual({
      reason: "validation.tooLong",
    });
  });
});

describe("the working week", () => {
  it("reads the ticked days as distinct sorted ISO days", () => {
    expect(
      setBusinessWeekPatternSchema.parse({ ...WEEK, nonWorkingDays: ["6", " 5 "] }).nonWorkingDays,
    ).toEqual([5, 6]);
    expect(setBusinessWeekPatternSchema.parse({ ...WEEK, nonWorkingDays: "7" }).nonWorkingDays).toEqual([7]);
    expect(
      setBusinessWeekPatternSchema.parse({ ...WEEK, nonWorkingDays: [1, 2, 3, 4, 5, 6] }).nonWorkingDays,
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("none ticked is a seven-day working week, which the confirmation says before anything is recorded", () => {
    const { nonWorkingDays: _, ...rest } = WEEK;
    expect(setBusinessWeekPatternSchema.parse(rest).nonWorkingDays).toEqual([]);
    expect(setBusinessWeekPatternSchema.parse({ ...WEEK, nonWorkingDays: [] }).nonWorkingDays).toEqual([]);
  });

  it("leaves at least one working day", () => {
    expect(
      problems(
        setBusinessWeekPatternSchema.safeParse({
          ...WEEK,
          nonWorkingDays: ["1", "2", "3", "4", "5", "6", "7"],
        }),
      ),
    ).toEqual({ nonWorkingDays: "validation.oneWorkingDay" });
  });

  it("refuses a day that is not an ISO day of the week, or one ticked twice", () => {
    for (const nonWorkingDays of [["0"], ["8"], ["Friday"], ["5", "5"], ["1.5"], [""], [null]])
      expect(
        problems(setBusinessWeekPatternSchema.safeParse({ ...WEEK, nonWorkingDays })),
        String(nonWorkingDays),
      ).toEqual({ nonWorkingDays: "validation.invalid" });
  });

  it("needs a start date and a reason; it carries no source status (coordinator ruling F4)", () => {
    expect(problems(setBusinessWeekPatternSchema.safeParse({ nonWorkingDays: ["5"] }))).toEqual({
      effectiveFrom: "validation.invalid",
      reason: "validation.invalid",
    });
    expect(
      problems(setBusinessWeekPatternSchema.safeParse({ ...WEEK, effectiveFrom: "2027-13-01" })),
    ).toEqual({ effectiveFrom: "validation.invalid" });
    const parsed = setBusinessWeekPatternSchema.parse({ ...WEEK, sourceStatus: "APPROVED" });
    expect(parsed).not.toHaveProperty("sourceStatus");
  });
});

// ---- P12-8b (ADR-063) --------------------------------------------------------------------------------------------

const ID = "66666666-6666-4666-8666-666666666666";
const REASON = "Synthetic: a demo reason.";
const FROM = "2027-01-03";

describe("withdrawing a day and revoking a delegation", () => {
  it("name the row by its id and always say why", () => {
    expect(withdrawBusinessCalendarDaySchema.parse({ dayId: ID, reason: ` ${REASON} ` })).toEqual({
      dayId: ID,
      reason: REASON,
    });
    expect(revokeReferralDelegationSchema.parse({ delegationId: ID, reason: REASON })).toEqual({
      delegationId: ID,
      reason: REASON,
    });
    expect(
      problems(withdrawBusinessCalendarDaySchema.safeParse({ dayId: "CDF-DEMO-1", reason: "abc" })),
    ).toEqual({
      dayId: "validation.invalid",
      reason: "validation.tooShort",
    });
    expect(problems(revokeReferralDelegationSchema.safeParse({ delegationId: ID }))).toEqual({
      reason: "validation.invalid",
    });
  });
});

describe("a new sector", () => {
  const SECTOR = { code: "DEMO_SECTOR", nameEn: "Demo sector", nameAr: "قطاع تجريبي" };

  it("takes the command's code shape: a capital letter, then capitals, digits or underscores, 2 to 20 in all", () => {
    for (const code of ["AB", "A1", "DEMO_SECTOR", "A".repeat(20)])
      expect(createSectorSchema.parse({ ...SECTOR, code }).code, code).toBe(code);
    expect(createSectorSchema.parse({ ...SECTOR, code: " DEMO " }).code).toBe("DEMO");
    for (const code of ["A", "1A", "_A", "demo", "DEMO-SECTOR", "A".repeat(21), "ÄB"])
      expect(problems(createSectorSchema.safeParse({ ...SECTOR, code })), code).toEqual({
        code: "validation.sectorCode",
      });
  });

  it("needs both names, 2 to 120 characters each, and takes nothing else", () => {
    expect(
      problems(createSectorSchema.safeParse({ ...SECTOR, nameEn: "A", nameAr: "x".repeat(121) })),
    ).toEqual({
      nameEn: "validation.tooShort",
      nameAr: "validation.tooLong",
    });
    expect(createSectorSchema.parse({ ...SECTOR, isActive: false, headId: ID })).toEqual(SECTOR);
  });
});

describe("a notice rule", () => {
  const RULE = {
    layer: "EVENT_RULE",
    templateCode: "MEETING_SCHEDULED",
    channel: "IN_APP",
    enabled: "on",
    effectiveFrom: FROM,
    reason: REASON,
  };

  it("is on or off for one notice and channel, platform-wide or as a committee's default", () => {
    expect(setNotificationRuleSchema.parse(RULE)).toEqual({ ...RULE, enabled: true, committeeId: undefined });
    expect(setNotificationRuleSchema.parse({ ...RULE, enabled: "off" }).enabled).toBe(false);
    expect(
      setNotificationRuleSchema.parse({ ...RULE, layer: "COMMITTEE_DEFAULT", committeeId: ID }).committeeId,
    ).toBe(ID);
  });

  it("never sets the mandatory layer, and needs a choice for on or off", () => {
    expect(problems(setNotificationRuleSchema.safeParse({ ...RULE, layer: "SYSTEM_MANDATORY" }))).toEqual({
      layer: "validation.chooseOne",
    });
    for (const enabled of [undefined, "", "yes", true])
      expect(problems(setNotificationRuleSchema.safeParse({ ...RULE, enabled })), String(enabled)).toEqual({
        enabled: "validation.chooseOne",
      });
  });

  it("refuses a notice code of the wrong shape, an unknown channel and a date that is not a date", () => {
    expect(
      problems(
        setNotificationRuleSchema.safeParse({
          ...RULE,
          templateCode: "meeting",
          channel: "SMS",
          effectiveFrom: "soon",
        }),
      ),
    ).toEqual({
      templateCode: "validation.code",
      channel: "validation.chooseOne",
      effectiveFrom: "validation.invalid",
    });
  });
});

describe("a new export rule", () => {
  const RULE = {
    code: "DEMO_RULE",
    audience: "EXTERNAL",
    restrictedOnly: false,
    action: "REQUIRE_SECOND_APPROVAL",
    effectiveFrom: FROM,
    reason: REASON,
  };

  it("names whom it applies to and what it does; classification and content are optional", () => {
    expect(addExportRuleSchema.parse(RULE)).toEqual({
      ...RULE,
      minClassification: undefined,
      objectType: undefined,
    });
    expect(
      addExportRuleSchema.parse({ ...RULE, minClassification: "CONFIDENTIAL", objectType: "MINUTES" }),
    ).toMatchObject({ minClassification: "CONFIDENTIAL", objectType: "MINUTES" });
  });

  it("never takes NONE, or a source status", () => {
    expect(problems(addExportRuleSchema.safeParse({ ...RULE, action: "NONE" }))).toEqual({
      action: "validation.chooseOne",
    });
    expect(addExportRuleSchema.parse({ ...RULE, sourceStatus: "APPROVED" })).not.toHaveProperty(
      "sourceStatus",
    );
  });

  it("refuses a code of the wrong shape, an unknown classification or content, and a missing restricted choice", () => {
    const { restrictedOnly: _, ...rest } = RULE;
    expect(
      problems(
        addExportRuleSchema.safeParse({
          ...rest,
          code: "AB",
          minClassification: "TOP",
          objectType: "EVIDENCE",
        }),
      ),
    ).toEqual({
      code: "validation.code",
      minClassification: "validation.invalid",
      objectType: "validation.invalid",
      restrictedOnly: "validation.invalid",
    });
  });
});

describe("an export purpose", () => {
  const PURPOSE = {
    code: "DEMO_PURPOSE",
    nameEn: "Demo purpose",
    nameAr: "غرض تجريبي",
    requiresJustification: true,
    isActive: false,
    sortOrder: "90",
    reason: REASON,
  };

  it("a new one names no version; a change names the version read (F13)", () => {
    expect(addExportPurposeSchema.parse({ ...PURPOSE, expectedVersion: "3" })).toEqual({
      ...PURPOSE,
      sortOrder: 90,
    });
    expect(editExportPurposeSchema.parse({ ...PURPOSE, expectedVersion: "3" })).toEqual({
      ...PURPOSE,
      sortOrder: 90,
      expectedVersion: 3,
    });
    for (const expectedVersion of [undefined, "0", "-1", "1.5", "x"])
      expect(
        problems(editExportPurposeSchema.safeParse({ ...PURPOSE, expectedVersion })),
        String(expectedVersion),
      ).toHaveProperty("expectedVersion");
  });

  it("keeps its place in the list from 1 to 899, and takes no source status", () => {
    for (const sortOrder of ["0", "900", "1.5", ""])
      expect(problems(addExportPurposeSchema.safeParse({ ...PURPOSE, sortOrder })), sortOrder).toHaveProperty(
        "sortOrder",
      );
    const parsed = addExportPurposeSchema.parse({
      ...PURPOSE,
      sourceStatus: "SOURCE_REQUIRED",
      isLegacy: true,
    });
    expect(parsed).not.toHaveProperty("sourceStatus");
    expect(parsed).not.toHaveProperty("isLegacy");
  });
});

describe("a corrective-action policy version", () => {
  const POLICY = {
    actionType: "GOVERNANCE_REMEDIATION",
    completionEvidence: "REFERENCE_REQUIRED",
    effectiveFrom: FROM,
    reason: REASON,
  };

  it("keeps each period within the command's bounds, and leaves an empty one unset", () => {
    expect(
      correctiveActionPolicyVersionSchema.parse({
        ...POLICY,
        defaultDueDays: "730",
        reminderDaysBefore: "",
        overdueAfterDays: "0",
      }),
    ).toMatchObject({ defaultDueDays: 730, reminderDaysBefore: undefined, overdueAfterDays: 0 });
    expect(
      problems(
        correctiveActionPolicyVersionSchema.safeParse({
          ...POLICY,
          defaultDueDays: "731",
          reminderDaysBefore: "0",
          reminderRepeatDays: "91",
          overdueAfterDays: "-1",
          escalateAfterDays: "366",
        }),
      ),
    ).toEqual({
      defaultDueDays: "validation.invalid",
      reminderDaysBefore: "validation.invalid",
      reminderRepeatDays: "validation.invalid",
      overdueAfterDays: "validation.invalid",
      escalateAfterDays: "validation.invalid",
    });
  });

  it("lists each kind of evidence once, at most ten further steps, and no source status", () => {
    expect(
      problems(
        correctiveActionPolicyVersionSchema.safeParse({
          ...POLICY,
          allowedEvidenceTypes: ["DOC_REF", "DOC_REF"],
        }),
      ),
    ).toEqual({ allowedEvidenceTypes: "validation.invalid" });
    const step = { afterDaysOverdue: "1", recipientKind: "OWNER" };
    expect(
      problems(
        correctiveActionPolicyVersionSchema.safeParse({
          ...POLICY,
          escalationSteps: Array.from({ length: 11 }, () => step),
        }),
      ),
    ).toEqual({ escalationSteps: "validation.invalid" });
    expect(
      correctiveActionPolicyVersionSchema.parse({ ...POLICY, sourceStatus: "APPROVED" }),
    ).not.toHaveProperty("sourceStatus");
  });
});

describe("a new version of a committee's rules", () => {
  const BASE = { committeeId: ID, committeeKind: "GRIEVANCE", effectiveFrom: FROM, reason: REASON };

  it("names every option the command takes but its one fixed rule, and its grievance-only options (2030)", () => {
    // api.revise_committee_rule_set's v_allowed, less decision_rule, which has one value (SIMPLE_MAJORITY_SUBSTANTIVE).
    expect(Object.values(RULE_SET_REVISION_KEYS).sort()).toEqual(
      [
        "quorum_type",
        "quorum_value",
        "casting_vote_enabled",
        "minutes_review_business_days",
        "deemed_approval_enabled",
        "no_substantive_vote_outcome",
        "conflict_decider",
        "acting_chair_casting_vote",
        "vote_revision_allowed",
        "ballot_secrecy",
        "minimum_notice_days",
        "minutes_objection_blocks_deemed",
        "sanction_requires_defence_notice",
        "grievance_window_days",
        "admissibility_decider",
        "grievance_window_start_basis",
        "non_admission_decider",
        "grievance_completion_days",
        "dissent_note_allowed",
      ].sort(),
    );
    // Its v_grievance_only.
    expect(GRIEVANCE_ONLY_RULE_KEYS.map((k) => RULE_SET_REVISION_KEYS[k])).toEqual([
      "grievance_window_days",
      "admissibility_decider",
      "grievance_window_start_basis",
      "non_admission_decider",
      "grievance_completion_days",
    ]);
    // The options it lets be null in a new version.
    expect(CLEARABLE_RULE_KEYS).toEqual(["quorumValue", "minimumNoticeDays", "grievanceCompletionDays"]);
  });

  it("reads on and off as booleans, and an option left out as unchanged", () => {
    const parsed = reviseCommitteeRuleSetSchema.parse({
      ...BASE,
      castingVoteEnabled: "on",
      dissentNoteAllowed: "off",
    });
    expect(parsed).toMatchObject({ castingVoteEnabled: true, dissentNoteAllowed: false });
    expect(parsed.voteRevisionAllowed).toBeUndefined();
    expect(parsed.minutesReviewBusinessDays).toBeUndefined();
  });

  it("an emptied option it may clear becomes null; an emptied option it may not clear is missing", () => {
    expect(
      reviseCommitteeRuleSetSchema.parse({
        ...BASE,
        quorumValue: "",
        minimumNoticeDays: null,
        grievanceCompletionDays: " ",
      }),
    ).toMatchObject({ quorumValue: null, minimumNoticeDays: null, grievanceCompletionDays: null });
    expect(
      problems(
        reviseCommitteeRuleSetSchema.safeParse({
          ...BASE,
          minutesReviewBusinessDays: null,
          grievanceWindowDays: null,
        }),
      ),
    ).toEqual({
      minutesReviewBusinessDays: "validation.required",
      grievanceWindowDays: "validation.required",
    });
  });

  it("keeps each number within the command's bounds", () => {
    expect(
      problems(
        reviseCommitteeRuleSetSchema.safeParse({
          ...BASE,
          minutesReviewBusinessDays: "31",
          minimumNoticeDays: "61",
          grievanceWindowDays: "0",
          grievanceCompletionDays: "91",
        }),
      ),
    ).toEqual({
      minutesReviewBusinessDays: "validation.invalid",
      minimumNoticeDays: "validation.invalid",
      grievanceWindowDays: "validation.invalid",
      grievanceCompletionDays: "validation.invalid",
    });
  });

  it("refuses a value the command does not know, and takes no source status", () => {
    expect(
      problems(
        reviseCommitteeRuleSetSchema.safeParse({
          ...BASE,
          ballotSecrecy: "OPEN",
          conflictDecider: "DEPUTY_CHAIR",
          admissibilityDecider: "LEGAL",
          grievanceWindowStartBasis: "FILING",
        }),
      ),
    ).toEqual({
      ballotSecrecy: "validation.chooseOne",
      conflictDecider: "validation.chooseOne",
      admissibilityDecider: "validation.chooseOne",
      grievanceWindowStartBasis: "validation.chooseOne",
    });
    expect(reviseCommitteeRuleSetSchema.parse({ ...BASE, sourceStatus: "APPROVED" })).not.toHaveProperty(
      "sourceStatus",
    );
  });
});

// Coordinator ruling of 2026-10-18 23:20: the options whose value follows a decision are shown read-only and never
// changed on the page. The command is not narrowed; the service refuses a revision that names one (application tests).
describe("the options a committee's rules keep as decided", () => {
  it("names the ruling's own decisions, each with its reference", () => {
    expect({
      actingChairCastingVote: DECIDED_RULE_KEYS.actingChairCastingVote,
      conflictDecider: DECIDED_RULE_KEYS.conflictDecider,
      grievanceWindowDays: DECIDED_RULE_KEYS.grievanceWindowDays,
      grievanceWindowStartBasis: DECIDED_RULE_KEYS.grievanceWindowStartBasis,
      nonAdmissionDecider: DECIDED_RULE_KEYS.nonAdmissionDecider,
    }).toEqual({
      actingChairCastingVote: { ref: "DEC-F03", by: "OWNER" },
      conflictDecider: { ref: "DEC-F04", by: "OWNER" },
      grievanceWindowDays: { ref: "DEC-F14", by: "OWNER" },
      grievanceWindowStartBasis: { ref: "DEC-F15", by: "OWNER" },
      nonAdmissionDecider: { ref: "DEC-F17", by: "OWNER" },
    });
  });

  it("keeps as decided the five options the coordinator confirmed on 2026-10-18 23:50: DEC-F01, DEC-F17, Q51, Q98 and AMB-076", () => {
    expect({
      quorumType: DECIDED_RULE_KEYS.quorumType,
      quorumValue: DECIDED_RULE_KEYS.quorumValue,
      castingVoteEnabled: DECIDED_RULE_KEYS.castingVoteEnabled,
      minutesReviewBusinessDays: DECIDED_RULE_KEYS.minutesReviewBusinessDays,
      deemedApprovalEnabled: DECIDED_RULE_KEYS.deemedApprovalEnabled,
      admissibilityDecider: DECIDED_RULE_KEYS.admissibilityDecider,
      noSubstantiveVoteOutcome: DECIDED_RULE_KEYS.noSubstantiveVoteOutcome,
    }).toEqual({
      quorumType: { ref: "Q51", by: "OWNER" },
      quorumValue: { ref: "Q51", by: "OWNER" },
      castingVoteEnabled: { ref: "DEC-F01", by: "OWNER" },
      minutesReviewBusinessDays: { ref: "Q98", by: "OWNER" },
      deemedApprovalEnabled: { ref: "Q98", by: "OWNER" },
      admissibilityDecider: { ref: "DEC-F17", by: "OWNER" },
      noSubstantiveVoteOutcome: { ref: "AMB-076", by: "RECORDED" },
    });
    expect(Object.keys(DECIDED_RULE_KEYS)).toHaveLength(12);
  });

  it("leaves editable only the options the ambiguity register makes configurable, and every option is one or the other", () => {
    // AMB-026, 061, 081, 082, 083, 092 and 141 (R3 configurable, or R4 awaiting the CDF source).
    expect([...EDITABLE_RULE_KEYS].sort()).toEqual(
      [
        "ballotSecrecy",
        "dissentNoteAllowed",
        "grievanceCompletionDays",
        "minimumNoticeDays",
        "minutesObjectionBlocksDeemed",
        "sanctionRequiresDefenceNotice",
        "voteRevisionAllowed",
      ].sort(),
    );
    expect([...Object.keys(DECIDED_RULE_KEYS), ...EDITABLE_RULE_KEYS].sort()).toEqual(
      Object.keys(RULE_SET_REVISION_KEYS).sort(),
    );
    for (const key of EDITABLE_RULE_KEYS) expect(isDecidedRuleKey(key), key).toBe(false);
    for (const key of Object.keys(DECIDED_RULE_KEYS)) expect(isDecidedRuleKey(key), key).toBe(true);
    // A name the command does not take, or one every object inherits, is not a decided option.
    for (const key of ["decisionRule", "toString", "__proto__", "constructor"])
      expect(isDecidedRuleKey(key), key).toBe(false);
  });
});

// Coordinator ruling of 2026-10-18 23:50: a safeguard is kept or made stricter on the page, never loosened. The service
// refuses a looser value (application tests); here, which options are safeguards, their order and what the page offers.
describe("a committee's safeguards", () => {
  const ALL_ON: RuleSafeguards = {
    minimumNoticeDays: 5,
    ballotSecrecy: "COMMITTEE_AFTER_CLOSE",
    minutesObjectionBlocksDeemed: true,
    sanctionRequiresDefenceNotice: true,
  };

  it("are the two the ruling names and the two this page reads into it, each an option the page may change", () => {
    expect(TIGHTEN_ONLY_RULE_KEYS).toEqual({
      // Listed for a ruling: short notice can exclude members (AMB-061); a secret ballot keeps choices hidden (AMB-083).
      minimumNoticeDays: { ref: "AMB-061" },
      ballotSecrecy: { ref: "AMB-083" },
      // The ruling's own.
      minutesObjectionBlocksDeemed: { ref: "AMB-092" },
      sanctionRequiresDefenceNotice: { ref: "AMB-026" },
    });
    for (const key of Object.keys(TIGHTEN_ONLY_RULE_KEYS)) {
      expect(EDITABLE_RULE_KEYS, key).toContain(key);
      expect(isTightenOnlyRuleKey(key), key).toBe(true);
    }
    // Vote revision (AMB-081), dissent notes (AMB-082) and the time to complete a grievance (AMB-141) stay free.
    for (const key of ["voteRevisionAllowed", "dissentNoteAllowed", "grievanceCompletionDays"])
      expect(isTightenOnlyRuleKey(key), key).toBe(false);
    for (const key of [...Object.keys(DECIDED_RULE_KEYS), "toString", "__proto__", "constructor"])
      expect(isTightenOnlyRuleKey(key), key).toBe(false);
  });

  it("order their values from loosest to strictest, and know the strictest", () => {
    const ORDER: { [K in TightenOnlyRuleKey]: RuleSafeguards[K][] } = {
      minimumNoticeDays: [null, 0, 1, 30, 59, MAX_MINIMUM_NOTICE_DAYS],
      ballotSecrecy: ["COMMITTEE_AFTER_CLOSE", "SECRET_BALLOT"],
      minutesObjectionBlocksDeemed: [false, true],
      sanctionRequiresDefenceNotice: [false, true],
    };
    expect(MAX_MINIMUM_NOTICE_DAYS).toBe(60);
    for (const key of Object.keys(ORDER) as TightenOnlyRuleKey[]) {
      const values = ORDER[key] as RuleSafeguards[TightenOnlyRuleKey][];
      const strictness = values.map((v) => safeguardStrictness(key, v));
      expect(strictness, key).toEqual([...strictness].sort((a, b) => a - b));
      expect(new Set(strictness).size, key).toBe(values.length);
      expect(
        values.map((v) => isStrictestSafeguard(key, v)),
        key,
      ).toEqual(values.map((_, i) => i === values.length - 1));
    }
    // The longest notice is the most the schema takes.
    expect(
      problems(
        reviseCommitteeRuleSetSchema.safeParse({
          committeeId: "88888888-8888-4888-8888-888888888888",
          committeeKind: "INVESTIGATION",
          effectiveFrom: "2027-01-03",
          reason: "Synthetic: a demo reason.",
          minimumNoticeDays: String(MAX_MINIMUM_NOTICE_DAYS + 1),
        }),
      ),
    ).toHaveProperty("minimumNoticeDays");
  });

  it("take their floor from the strictest version in force or scheduled", () => {
    expect(safeguardFloor("minimumNoticeDays", [])).toBeUndefined();
    expect(
      safeguardFloor("minimumNoticeDays", [
        { ...ALL_ON, minimumNoticeDays: null },
        { ...ALL_ON, minimumNoticeDays: 7 },
        { ...ALL_ON, minimumNoticeDays: 3 },
      ]),
    ).toBe(7);
    expect(safeguardFloor("minimumNoticeDays", [{ ...ALL_ON, minimumNoticeDays: null }])).toBeNull();
    expect(
      safeguardFloor("ballotSecrecy", [ALL_ON, { ...ALL_ON, ballotSecrecy: "SECRET_BALLOT" }, ALL_ON]),
    ).toBe("SECRET_BALLOT");
    expect(
      safeguardFloor("sanctionRequiresDefenceNotice", [
        { ...ALL_ON, sanctionRequiresDefenceNotice: false },
        ALL_ON,
      ]),
    ).toBe(true);
  });

  it("are offered from their floor up, kept where the floor is the strictest, and the floor is sent where the open version is looser", () => {
    // Open now as in force: nothing is sent unless changed.
    expect(safeguardOffer("minimumNoticeDays", ALL_ON, [ALL_ON])).toEqual({
      floor: 5,
      keptOnly: false,
      sendFloor: false,
    });
    expect(safeguardOffer("ballotSecrecy", ALL_ON, [ALL_ON])).toEqual({
      floor: "COMMITTEE_AFTER_CLOSE",
      keptOnly: false,
      sendFloor: false,
    });
    for (const key of ["minutesObjectionBlocksDeemed", "sanctionRequiresDefenceNotice"] as const)
      expect(safeguardOffer(key, ALL_ON, [ALL_ON]), key).toEqual({
        floor: true,
        keptOnly: true,
        sendFloor: false,
      });
    expect(
      safeguardOffer(
        "sanctionRequiresDefenceNotice",
        { ...ALL_ON, sanctionRequiresDefenceNotice: false },
        [],
      ),
    ).toEqual({ floor: false, keptOnly: false, sendFloor: false });
    // The version open now (starting later, recorded before this page) is looser than the one in force: the floor is
    // the one in force's, and it is sent.
    const open = { ...ALL_ON, minimumNoticeDays: 2, sanctionRequiresDefenceNotice: false };
    expect(safeguardOffer("minimumNoticeDays", open, [ALL_ON, open])).toEqual({
      floor: 5,
      keptOnly: false,
      sendFloor: true,
    });
    expect(safeguardOffer("sanctionRequiresDefenceNotice", open, [ALL_ON, open])).toEqual({
      floor: true,
      keptOnly: true,
      sendFloor: true,
    });
    expect(
      safeguardOffer("minimumNoticeDays", { ...ALL_ON, minimumNoticeDays: MAX_MINIMUM_NOTICE_DAYS }, []),
    ).toEqual({ floor: MAX_MINIMUM_NOTICE_DAYS, keptOnly: true, sendFloor: false });
  });
});
