// The business calendar's two forms (DEC-F02, migration 2030; UX redesign Phase 12 P12-8a, ADR-051's P12-8a
// amendment). The database re-checks every rule, including whether a date is in the past in Riyadh and whether a day
// or a later week already exists; error messages are i18n keys, never prose. A week is always recorded as
// SOURCE_REQUIRED (coordinator ruling F4, 2026-10-18): the form has no status field.
import { z } from "zod";
import {
  BALLOT_SECRECY,
  BUSINESS_CALENDAR_DAY_TYPES,
  CLASSIFICATION_LEVELS,
  COMMITTEE_KINDS,
  COMPLETION_EVIDENCE_RULES,
  CONFLICT_DECIDERS,
  CORRECTIVE_ACTION_TYPES,
  ESCALATION_RECIPIENT_KINDS,
  EXPORT_OBJECT_TYPES,
  EXPORT_RULE_ADD_ACTIONS,
  EXPORT_RULE_AUDIENCES,
  GRIEVANCE_DECIDERS,
  GRIEVANCE_WINDOW_BASES,
  NO_SUBSTANTIVE_VOTE_OUTCOMES,
  NOTIFICATION_CHANNELS,
  QUORUM_TYPES,
  SETTABLE_NOTIFICATION_LAYERS,
} from "@cdf/contracts";

const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, { message: min <= 1 ? "validation.required" : "validation.tooShort" })
    .max(max, { message: "validation.tooLong" });
const optionalText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: "validation.tooLong" })
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || v.length >= min, { message: "validation.tooShort" });
const calendarDate = z.iso.date({ message: "validation.invalid" });

/** A holiday, a CDF closure or a working day on a weekend, for one date from today (Riyadh). */
export const setBusinessCalendarDaySchema = z.object({
  calendarDate,
  dayType: z.enum(BUSINESS_CALENDAR_DAY_TYPES, { message: "validation.chooseOne" }),
  sourceReference: optionalText(3, 200),
  reason: text(5, 2000),
});

/** An ISO day of the week (1 Monday … 7 Sunday) as a form sends it; anything else is NaN, refused below. */
const isoDay = (v: unknown): number =>
  typeof v === "number"
    ? v
    : typeof v === "string" && /^[1-7]$/.test(v.trim())
      ? Number(v.trim())
      : Number.NaN;

/**
 * The days that are not working days, ticked one by one: distinct ISO days, at least one working day left. None
 * ticked is a seven-day working week, which the confirmation says before anything is recorded.
 */
const nonWorkingDays = z.preprocess(
  (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(isoDay) : [isoDay(v)]),
  z
    .array(z.any())
    .superRefine((days, ctx) => {
      if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7) || new Set(days).size !== days.length)
        ctx.addIssue({ code: "custom", message: "validation.invalid" });
      else if (days.length > 6) ctx.addIssue({ code: "custom", message: "validation.oneWorkingDay" });
    })
    .transform((days) => [...(days as number[])].sort((a, b) => a - b)),
);

/** The working week from the start of a date in Riyadh, which must be after today there. */
export const setBusinessWeekPatternSchema = z.object({
  nonWorkingDays,
  effectiveFrom: calendarDate,
  reason: text(5, 2000),
});

// ---- P12-8b (ADR-063; migration 2127): the Administration pages' row and page controls ---------------------------
// One schema per command, with the command's own lengths and shapes. The database answers everything else at submit:
// who may act, the row's state, a date already taken, a later version, the version read. A form never sends a source
// status: every change it makes is provisional, awaiting the CDF source, except the export purposes, whose command
// records the administrator's own catalogue entry (coordinator rulings on F4, 2026-10-18 12:27 and 21:17).

const uuid = z.uuid({ message: "validation.invalid" });
/** A checkbox the form sends as a boolean (formObject's booleans). */
const flag = z.boolean({ message: "validation.invalid" });
/** A governed code: capital letters, digits and underscores, starting with a letter (3 to 60 characters). */
const CODE = /^[A-Z][A-Z0-9_]{2,59}$/;
const code = z.string().trim().regex(CODE, { message: "validation.code" });

/**
 * A whole number from a form field, within the command's bounds. Blank is missing: `required` fields refuse it, the
 * others are left unset (the command's "not set"). Null is a value the user emptied (`clearedFields`): missing too.
 */
const whole = (min: number, max: number) =>
  z
    .number({
      error: (issue) =>
        issue.input === undefined || issue.input === null ? "validation.required" : "validation.invalid",
    })
    .int({ message: "validation.invalid" })
    .min(min, { message: "validation.invalid" })
    .max(max, { message: "validation.invalid" });
const asNumber = (v: unknown) =>
  typeof v === "string" ? (v.trim() === "" ? undefined : Number(v.trim())) : v === null ? undefined : v;
const wholeNumber = (min: number, max: number) => z.preprocess(asNumber, whole(min, max));
const optionalWholeNumber = (min: number, max: number) => z.preprocess(asNumber, whole(min, max).optional());
/** "on" or "off" from a pair of radio buttons. */
const onOff = z.enum(["on", "off"], { message: "validation.chooseOne" }).transform((v) => v === "on");

// ---- Business calendar: withdraw a day (api.withdraw_business_calendar_day) --------------------------------------
/** Today or later in Riyadh, not withdrawn already: the database decides both. */
export const withdrawBusinessCalendarDaySchema = z.object({ dayId: uuid, reason: text(5, 2000) });

// ---- Sectors (api.create_sector, api.revoke_referral_delegation) -------------------------------------------------
/** A sector's code: capital letters, digits and underscores, starting with a letter (2 to 20 characters). */
const SECTOR_CODE = /^[A-Z][A-Z0-9_]{1,19}$/;
export const createSectorSchema = z.object({
  code: z.string().trim().regex(SECTOR_CODE, { message: "validation.sectorCode" }),
  nameEn: text(2, 120),
  nameAr: text(2, 120),
});
/** Active and not ended: the database decides. */
export const revokeReferralDelegationSchema = z.object({ delegationId: uuid, reason: text(5, 2000) });

// ---- Notification rules (api.set_notification_rule; F8 since 2127) ------------------------------------------------
/**
 * A platform-wide rule or a committee's default for one notice and channel, on or off, from the start of a date after
 * today in Riyadh. A committee default names its committee; a platform-wide rule names none.
 */
export const setNotificationRuleSchema = z
  .object({
    layer: z.enum(SETTABLE_NOTIFICATION_LAYERS, { message: "validation.chooseOne" }),
    templateCode: code,
    committeeId: uuid.optional(),
    channel: z.enum(NOTIFICATION_CHANNELS, { message: "validation.chooseOne" }),
    enabled: onOff,
    effectiveFrom: calendarDate,
    reason: text(5, 2000),
  })
  .superRefine((v, ctx) => {
    if (v.layer === "COMMITTEE_DEFAULT" && !v.committeeId)
      ctx.addIssue({ code: "custom", path: ["committeeId"], message: "validation.required" });
    if (v.layer === "EVENT_RULE" && v.committeeId)
      ctx.addIssue({ code: "custom", path: ["committeeId"], message: "validation.noCommittee" });
  });

// ---- Export policy (api.set_export_rule, api.set_export_purpose; F11, F13) ----------------------------------------
/**
 * A new rule for a new code: whom it applies to and what it does, from the start of a date after today. Never NONE
 * (EXPORT_RULE_ADD_ACTIONS): a rule this page adds only ever adds a requirement or a refusal.
 */
export const addExportRuleSchema = z.object({
  code,
  audience: z.enum(EXPORT_RULE_AUDIENCES, { message: "validation.chooseOne" }),
  minClassification: z.enum(CLASSIFICATION_LEVELS, { message: "validation.invalid" }).optional(),
  objectType: z.enum(EXPORT_OBJECT_TYPES, { message: "validation.invalid" }).optional(),
  restrictedOnly: flag,
  action: z.enum(EXPORT_RULE_ADD_ACTIONS, { message: "validation.chooseOne" }),
  effectiveFrom: calendarDate,
  reason: text(5, 2000),
});

const purposeFields = {
  nameEn: text(3, 200),
  nameAr: text(3, 200),
  requiresJustification: flag,
  isActive: flag,
  sortOrder: wholeNumber(1, 899),
  reason: text(5, 2000),
};
/**
 * A purpose for a code not in the catalogue (F11: the code is checked for its shape; the database judges the rest).
 * OTHER always needs a justification.
 */
export const addExportPurposeSchema = z
  .object({ code, ...purposeFields })
  .refine((v) => v.code !== "OTHER" || v.requiresJustification, {
    path: ["requiresJustification"],
    message: "validation.otherJustification",
  });
/** A purpose already in the catalogue, at the version read (F13): a change made since is refused, not overwritten. */
export const editExportPurposeSchema = z
  .object({ code, expectedVersion: z.coerce.number().int().positive(), ...purposeFields })
  .refine((v) => v.code !== "OTHER" || v.requiresJustification, {
    path: ["requiresJustification"],
    message: "validation.otherJustification",
  });

// ---- Corrective-action policy (api.set_corrective_action_policy, 12 arguments; DEC-F25 to DEC-F27) ---------------
const ESCALATION_STEP_ROWS = 10;
/** One escalation row as the form sends it: blank rows are dropped, a half-filled one is refused. */
const escalationStep = z
  .object({
    afterDaysOverdue: optionalWholeNumber(0, 365),
    recipientKind: z
      .enum(ESCALATION_RECIPIENT_KINDS, { message: "validation.chooseOne" })
      .optional()
      .or(z.literal("").transform(() => undefined)),
    roleCode: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : undefined)),
  })
  .superRefine((s, ctx) => {
    const blank =
      s.afterDaysOverdue === undefined && s.recipientKind === undefined && s.roleCode === undefined;
    if (blank) return;
    if (s.afterDaysOverdue === undefined)
      ctx.addIssue({ code: "custom", path: ["afterDaysOverdue"], message: "validation.required" });
    if (s.recipientKind === undefined)
      ctx.addIssue({ code: "custom", path: ["recipientKind"], message: "validation.chooseOne" });
    if (s.recipientKind === "ROLE" && !s.roleCode)
      ctx.addIssue({ code: "custom", path: ["roleCode"], message: "validation.chooseOne" });
    if (s.recipientKind !== "ROLE" && s.roleCode)
      ctx.addIssue({ code: "custom", path: ["roleCode"], message: "validation.noRole" });
    if (s.roleCode && !/^[A-Z][A-Z0-9_]{1,63}$/.test(s.roleCode))
      ctx.addIssue({ code: "custom", path: ["roleCode"], message: "validation.invalid" });
  });

/**
 * A new version of an action type's policy from the start of a date after today, always provisional (F4). The
 * evidence kinds are checked for their shape; the database judges whether each is in the catalogue and active. The
 * service then refuses a version whose completion evidence is looser than the version it follows (coordinator, F4).
 */
export const correctiveActionPolicyVersionSchema = z
  .object({
    actionType: z.enum(CORRECTIVE_ACTION_TYPES, { message: "validation.chooseOne" }),
    defaultDueDays: optionalWholeNumber(1, 730),
    reminderDaysBefore: optionalWholeNumber(1, 90),
    reminderRepeatDays: optionalWholeNumber(1, 90),
    overdueAfterDays: optionalWholeNumber(0, 365),
    escalateAfterDays: optionalWholeNumber(1, 365),
    completionEvidence: z.enum(COMPLETION_EVIDENCE_RULES, { message: "validation.chooseOne" }),
    /** None ticked: any active kind in the catalogue. */
    allowedEvidenceTypes: z
      .array(z.string().trim().regex(CODE, { message: "validation.invalid" }))
      .default([])
      .refine((v) => new Set(v).size === v.length, { message: "validation.invalid" }),
    escalationSteps: z
      .array(escalationStep)
      .max(ESCALATION_STEP_ROWS, { message: "validation.invalid" })
      .default([]),
    effectiveFrom: calendarDate,
    reason: text(5, 2000),
  })
  .superRefine((v, ctx) => {
    if (v.reminderRepeatDays !== undefined && v.reminderDaysBefore === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["reminderRepeatDays"],
        message: "validation.repeatNeedsReminder",
      });
  })
  .transform((v) => ({
    ...v,
    allowedEvidenceTypes: v.allowedEvidenceTypes.length > 0 ? v.allowedEvidenceTypes : null,
    escalationSteps: v.escalationSteps
      .filter((s) => s.afterDaysOverdue !== undefined && s.recipientKind !== undefined)
      .map((s) => ({
        afterDaysOverdue: s.afterDaysOverdue!,
        recipientKind: s.recipientKind!,
        roleCode: s.recipientKind === "ROLE" ? s.roleCode! : null,
      })),
  }));

// ---- Committee rules (api.revise_committee_rule_set) -------------------------------------------------------------
// Only the revision is offered: each of the two permanent committees (one per kind) has had a version open since 1870,
// and a version ends only when the next one starts, so `api.set_committee_rule_set`'s case (a committee with none)
// never arises. The revision also carries the 2030 options the setter cannot name.

/**
 * A number the form may clear (a quorum value, a minimum notice, a completion period). The action sends null for a
 * field the user emptied and nothing for a field left as it was (`clearedFields`): null clears the option.
 */
const clearable = (inner: z.ZodType<number>) =>
  z.preprocess(
    (v) => (v === null ? null : typeof v === "string" ? (v.trim() === "" ? null : Number(v.trim())) : v),
    inner.nullable().optional(),
  );
const clearableWhole = (min: number, max: number) => clearable(whole(min, max));
/**
 * A number a revision may change but never clear (the minutes review, the grievance window): a field the user emptied
 * comes as null and is refused as missing, never read as unchanged.
 */
const keptWholeNumber = (min: number, max: number) =>
  z.preprocess((v) => (v === null ? null : asNumber(v)), whole(min, max).optional());
const clearableDecimal = clearable(
  z.number({ message: "validation.invalid" }).finite({ message: "validation.invalid" }),
);

/** The options a revision may change, as the command names them (`api.revise_committee_rule_set`, 2030). */
export const RULE_SET_REVISION_KEYS = {
  quorumType: "quorum_type",
  quorumValue: "quorum_value",
  castingVoteEnabled: "casting_vote_enabled",
  minutesReviewBusinessDays: "minutes_review_business_days",
  deemedApprovalEnabled: "deemed_approval_enabled",
  noSubstantiveVoteOutcome: "no_substantive_vote_outcome",
  conflictDecider: "conflict_decider",
  actingChairCastingVote: "acting_chair_casting_vote",
  voteRevisionAllowed: "vote_revision_allowed",
  ballotSecrecy: "ballot_secrecy",
  minimumNoticeDays: "minimum_notice_days",
  minutesObjectionBlocksDeemed: "minutes_objection_blocks_deemed",
  sanctionRequiresDefenceNotice: "sanction_requires_defence_notice",
  dissentNoteAllowed: "dissent_note_allowed",
  grievanceWindowDays: "grievance_window_days",
  admissibilityDecider: "admissibility_decider",
  grievanceWindowStartBasis: "grievance_window_start_basis",
  nonAdmissionDecider: "non_admission_decider",
  grievanceCompletionDays: "grievance_completion_days",
} as const;
export type RuleSetRevisionKey = keyof typeof RULE_SET_REVISION_KEYS;
/** The options only a grievance committee has (the command refuses them for any other, `grievance_rules`). */
export const GRIEVANCE_ONLY_RULE_KEYS: readonly RuleSetRevisionKey[] = [
  "grievanceWindowDays",
  "admissibilityDecider",
  "grievanceWindowStartBasis",
  "nonAdmissionDecider",
  "grievanceCompletionDays",
];
/** The options a revision may clear: each is "not set" when empty. Emptying any other is refused as missing. */
export const CLEARABLE_RULE_KEYS: readonly RuleSetRevisionKey[] = [
  "quorumValue",
  "minimumNoticeDays",
  "grievanceCompletionDays",
];

/** Whose decision an option follows: the owner's, or a decision the ambiguity register records as not configurable. */
export type RuleDecisionKind = "OWNER" | "RECORDED";

/**
 * The options whose value follows a decision (coordinator ruling of 2026-10-18 23:20): the page shows each read-only,
 * with the decision it follows, and never sends it, so a new version keeps it as it is. The service refuses a revision
 * that names one, whatever its value, before the command is asked (`DECIDED_OPTION`). `api.revise_committee_rule_set`
 * itself is not narrowed: the page gates stricter than the command (ruling of 12:27).
 *
 * DEC-F03, F04, F14, F15 and F17 are the 23:20 ruling's own. The other five were confirmed by the coordinator's ruling
 * of 2026-10-18 23:50: DEC-F01 (the chair's casting vote) and DEC-F17 (who decides admissibility) are owner decisions;
 * Q51 (the quorum's kind and value) and Q98 (the minutes review period and deemed approval) are REBASE v1.0 answers,
 * which rank with owner decisions here; AMB-076 (what an item no one votes on records) is recorded as not configurable.
 */
export const DECIDED_RULE_KEYS = {
  quorumType: { ref: "Q51", by: "OWNER" },
  quorumValue: { ref: "Q51", by: "OWNER" },
  castingVoteEnabled: { ref: "DEC-F01", by: "OWNER" },
  minutesReviewBusinessDays: { ref: "Q98", by: "OWNER" },
  deemedApprovalEnabled: { ref: "Q98", by: "OWNER" },
  noSubstantiveVoteOutcome: { ref: "AMB-076", by: "RECORDED" },
  conflictDecider: { ref: "DEC-F04", by: "OWNER" },
  actingChairCastingVote: { ref: "DEC-F03", by: "OWNER" },
  grievanceWindowDays: { ref: "DEC-F14", by: "OWNER" },
  admissibilityDecider: { ref: "DEC-F17", by: "OWNER" },
  grievanceWindowStartBasis: { ref: "DEC-F15", by: "OWNER" },
  nonAdmissionDecider: { ref: "DEC-F17", by: "OWNER" },
} as const satisfies Partial<Record<RuleSetRevisionKey, { ref: string; by: RuleDecisionKind }>>;
export type DecidedRuleKey = keyof typeof DECIDED_RULE_KEYS;

/** Whether an option follows a decision, and so is never changed on the page. */
export function isDecidedRuleKey(key: string): key is DecidedRuleKey {
  return Object.hasOwn(DECIDED_RULE_KEYS, key);
}

/** The options the page's revision may change: every other option the command takes. */
export const EDITABLE_RULE_KEYS: readonly RuleSetRevisionKey[] = (
  Object.keys(RULE_SET_REVISION_KEYS) as RuleSetRevisionKey[]
).filter((k) => !isDecidedRuleKey(k));

/**
 * The editable options that are safeguards (coordinator ruling of 2026-10-18 23:50): one of their values blocks an act
 * or withholds a disclosure to protect someone, so moving away from it is a widening, which waits for the CDF source
 * and dual control (2160). A revision may keep each or make it stricter, never looser: the new version carries each at
 * least as strict as every version in force or scheduled. The service checks it in the command's transaction, before
 * the command is asked (`LOOSER_RULE_OPTION`); `api.revise_committee_rule_set` itself is not narrowed.
 *
 * AMB-026 (a sanction needs a defence notice) and AMB-092 (an open objection blocks deemed approval) are the ruling's
 * own. AMB-061 (the minimum notice: short notice can exclude members and invalidate quorum) and AMB-083 (a secret ballot
 * keeps individual choices from the committee for good) are this page's reading of the ruling's last sentence, listed
 * for a ruling. Vote revision (AMB-081), dissent notes (AMB-082) and the time to complete a grievance (AMB-141) block
 * nothing in order to protect someone, so they stay freely editable.
 */
export const TIGHTEN_ONLY_RULE_KEYS = {
  minimumNoticeDays: { ref: "AMB-061" },
  ballotSecrecy: { ref: "AMB-083" },
  minutesObjectionBlocksDeemed: { ref: "AMB-092" },
  sanctionRequiresDefenceNotice: { ref: "AMB-026" },
} as const satisfies Partial<Record<RuleSetRevisionKey, { ref: string }>>;
export type TightenOnlyRuleKey = keyof typeof TIGHTEN_ONLY_RULE_KEYS;

/** Whether an option is a safeguard, kept or made stricter on the page and never loosened. */
export function isTightenOnlyRuleKey(key: string): key is TightenOnlyRuleKey {
  return Object.hasOwn(TIGHTEN_ONLY_RULE_KEYS, key);
}

/** A version's safeguards, as the rule set records them. */
export interface RuleSafeguards {
  /** Null: no minimum is enforced. */
  minimumNoticeDays: number | null;
  ballotSecrecy: (typeof BALLOT_SECRECY)[number];
  minutesObjectionBlocksDeemed: boolean;
  sanctionRequiresDefenceNotice: boolean;
}

/** The longest minimum notice the command takes, in days: the strictest notice. */
export const MAX_MINIMUM_NOTICE_DAYS = 60;

/**
 * How strict a safeguard's value is: a higher number is stricter. A minimum notice not set enforces nothing, the
 * loosest; a longer notice is stricter than a shorter one. A secret ballot is stricter than choices the committee sees
 * after close. A guard that is on is stricter than one that is off.
 */
export function safeguardStrictness<K extends TightenOnlyRuleKey>(key: K, value: RuleSafeguards[K]): number {
  switch (key) {
    case "minimumNoticeDays":
      return value === null ? -1 : (value as number);
    case "ballotSecrecy":
      return value === "SECRET_BALLOT" ? 1 : 0;
    default:
      return value === true ? 1 : 0;
  }
}

/** Whether a safeguard is as strict as the command lets it be, so a revision can only keep it. */
export function isStrictestSafeguard<K extends TightenOnlyRuleKey>(
  key: K,
  value: RuleSafeguards[K],
): boolean {
  const strictest: RuleSafeguards = {
    minimumNoticeDays: MAX_MINIMUM_NOTICE_DAYS,
    ballotSecrecy: "SECRET_BALLOT",
    minutesObjectionBlocksDeemed: true,
    sanctionRequiresDefenceNotice: true,
  };
  return safeguardStrictness(key, value) >= safeguardStrictness(key, strictest[key]);
}

/**
 * A safeguard's floor: its strictest value among the versions given (those in force or scheduled), below which no new
 * version may go. Undefined when no version is given.
 */
export function safeguardFloor<K extends TightenOnlyRuleKey>(
  key: K,
  versions: readonly RuleSafeguards[],
): RuleSafeguards[K] | undefined {
  let floor: RuleSafeguards[K] | undefined;
  for (const version of versions) {
    const value = version[key] as RuleSafeguards[K];
    if (floor === undefined || safeguardStrictness(key, value) > safeguardStrictness(key, floor))
      floor = value;
  }
  return floor;
}

/** What the page offers for one safeguard on a new version. */
export interface SafeguardOffer<K extends TightenOnlyRuleKey> {
  /** The strictest value in force or scheduled: no value below it is offered. */
  floor: RuleSafeguards[K];
  /** The floor is already the strictest value the command takes, so the safeguard can only be kept. */
  keptOnly: boolean;
  /**
   * The version open now is looser than a version in force or scheduled (possible only for a version recorded before
   * this page), so the floor is always sent: the new version never carries the looser value.
   */
  sendFloor: boolean;
}

/**
 * What the page offers for a safeguard (coordinator ruling of 2026-10-18 23:50), from the version open now and the
 * versions in force or scheduled, the set the service checks the revision against.
 */
export function safeguardOffer<K extends TightenOnlyRuleKey>(
  key: K,
  open: RuleSafeguards,
  versions: readonly RuleSafeguards[],
): SafeguardOffer<K> {
  const floor = safeguardFloor(key, [open, ...versions]) as RuleSafeguards[K];
  return {
    floor,
    keptOnly: isStrictestSafeguard(key, floor),
    sendFloor: safeguardStrictness(key, open[key] as RuleSafeguards[K]) < safeguardStrictness(key, floor),
  };
}

/**
 * A revision of the version open now (`api.revise_committee_rule_set`): only the options the administrator changed
 * (the form sends no other, CDFCommandForm `changedOnly`), from the start of a date after today, always provisional
 * (F4). The command checks every value of the new version again, the unchanged ones included: a quorum kind left with
 * a value it does not take is refused there.
 */
export const reviseCommitteeRuleSetSchema = z
  .object({
    committeeId: uuid,
    committeeKind: z.enum(COMMITTEE_KINDS, { message: "validation.invalid" }),
    effectiveFrom: calendarDate,
    reason: text(5, 2000),
    quorumType: z.enum(QUORUM_TYPES, { message: "validation.chooseOne" }).optional(),
    quorumValue: clearableDecimal,
    castingVoteEnabled: onOff.optional(),
    minutesReviewBusinessDays: keptWholeNumber(1, 30),
    deemedApprovalEnabled: onOff.optional(),
    noSubstantiveVoteOutcome: z
      .enum(NO_SUBSTANTIVE_VOTE_OUTCOMES, { message: "validation.chooseOne" })
      .optional(),
    conflictDecider: z.enum(CONFLICT_DECIDERS, { message: "validation.chooseOne" }).optional(),
    actingChairCastingVote: onOff.optional(),
    voteRevisionAllowed: onOff.optional(),
    ballotSecrecy: z.enum(BALLOT_SECRECY, { message: "validation.chooseOne" }).optional(),
    minimumNoticeDays: clearableWhole(0, MAX_MINIMUM_NOTICE_DAYS),
    minutesObjectionBlocksDeemed: onOff.optional(),
    sanctionRequiresDefenceNotice: onOff.optional(),
    dissentNoteAllowed: onOff.optional(),
    grievanceWindowDays: keptWholeNumber(1, 365),
    admissibilityDecider: z.enum(GRIEVANCE_DECIDERS, { message: "validation.chooseOne" }).optional(),
    grievanceWindowStartBasis: z.enum(GRIEVANCE_WINDOW_BASES, { message: "validation.chooseOne" }).optional(),
    nonAdmissionDecider: z.enum(GRIEVANCE_DECIDERS, { message: "validation.chooseOne" }).optional(),
    grievanceCompletionDays: clearableWhole(1, 90),
  })
  .superRefine((v, ctx) => {
    if (v.committeeKind !== "GRIEVANCE")
      for (const k of GRIEVANCE_ONLY_RULE_KEYS)
        if (v[k] !== undefined)
          ctx.addIssue({ code: "custom", path: [k], message: "validation.grievanceOnly" });
    // The quorum, when both halves are sent: the command's own rule (INVALID quorum).
    const value = v.quorumValue;
    if (v.quorumType === "FIXED_NUMBER" && value !== undefined) {
      if (value === null)
        ctx.addIssue({ code: "custom", path: ["quorumValue"], message: "validation.required" });
      else if (!Number.isInteger(value) || value < 1)
        ctx.addIssue({ code: "custom", path: ["quorumValue"], message: "validation.quorumNumber" });
    } else if (v.quorumType === "PERCENTAGE" && value !== undefined) {
      if (value === null)
        ctx.addIssue({ code: "custom", path: ["quorumValue"], message: "validation.required" });
      else if (value <= 0 || value > 100)
        ctx.addIssue({ code: "custom", path: ["quorumValue"], message: "validation.quorumPercentage" });
    } else if (
      (v.quorumType === "MAJORITY_ELIGIBLE" || v.quorumType === "CUSTOM") &&
      typeof value === "number"
    )
      ctx.addIssue({ code: "custom", path: ["quorumValue"], message: "validation.noQuorumValue" });
  });
