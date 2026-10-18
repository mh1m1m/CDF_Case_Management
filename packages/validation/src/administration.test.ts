// The business calendar's two schemas (DEC-F02, migration 2030; UX redesign Phase 12 P12-8a, ADR-051's P12-8a
// amendment, §45). The database decides every rule again, including whether a date is in the past in Riyadh and
// whether a day or a later week already exists (tests/integration/administration.spec.ts); here, what the form may
// send. Messages are i18n keys.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { setBusinessCalendarDaySchema, setBusinessWeekPatternSchema } from "./administration";
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
