// The business calendar's two forms (DEC-F02, migration 2030; UX redesign Phase 12 P12-8a, ADR-051's P12-8a
// amendment). The database re-checks every rule, including whether a date is in the past in Riyadh and whether a day
// or a later week already exists; error messages are i18n keys, never prose. A week is always recorded as
// SOURCE_REQUIRED (coordinator ruling F4, 2026-10-18): the form has no status field.
import { z } from "zod";
import { BUSINESS_CALENDAR_DAY_TYPES } from "@cdf/contracts";

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
