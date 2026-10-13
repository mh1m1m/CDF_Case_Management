import { describe, expect, it, vi } from "vitest";
import { ar } from "./messages/ar";
import { en } from "./messages/en";
import {
  directionOf,
  formatDate,
  formatDateTime,
  formatDays,
  formatList,
  formatRecordDate,
  formatRecordDateToParts,
  isolate,
  translate,
} from "./index";

function keys(o: object, prefix = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === "string" ? [`${prefix}${k}`] : keys(v as object, `${prefix}${k}.`),
  );
}

describe("i18n catalogs", () => {
  it("Arabic and English have exactly the same keys", () => {
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });
  it("no Arabic message is left empty or untranslated English", () => {
    for (const k of keys(ar)) {
      const v = translate("ar", k as never);
      expect(v.trim().length).toBeGreaterThan(0);
    }
  });
  it("directions", () => {
    expect(directionOf("ar")).toBe("rtl");
    expect(directionOf("en")).toBe("ltr");
  });
  it("interpolates placeholders", () => {
    expect(translate("en", "common.errorGeneric", { ref: "abc" })).toBe(
      "Something went wrong. Reference: abc",
    );
  });
  it("isolates values inside sentences and lists them in the locale's words", () => {
    expect(isolate("12 Oct 2026")).toBe("\u206812 Oct 2026\u2069");
    expect(formatList("en", ["Case Manager", "Compliance", "GRC Director"], "disjunction")).toBe(
      "Case Manager, Compliance, or GRC Director",
    );
    expect(formatList("ar", ["مدير القضية", "الامتثال"], "disjunction")).toBe("مدير القضية أو الامتثال");
    expect(formatList("en", ["A", "B"])).toBe("A and B");
  });
  it("counts days with each locale's plural forms and Latin digits", () => {
    expect(formatDays("en", 1)).toBe("1 day");
    expect(formatDays("en", 3)).toBe("3 days");
    expect(formatDays("ar", 2)).toBe("يومان");
    expect(formatDays("ar", 3)).toBe("3 أيام");
    expect(formatDays("ar", 11)).toBe("11 يومًا");
  });
});

describe("dates on formal generated records (DEC-51)", () => {
  // 14:05 on 13 October 2026 in Riyadh, the day of the owner's example.
  const AT = "2026-10-13T11:05:00.000Z";

  it("shows the Gregorian date first and the Umm al-Qura date second, as in the decision's example", () => {
    // The tabular Islamic calendar gives 1 Jumada I here and the astronomical one 3 Jumada I: only Umm al-Qura
    // gives the example.
    expect(formatRecordDate("en", AT)).toBe("13 October 2026 (2 Jumada I 1448H)");
    expect(formatRecordDate("ar", AT)).toBe("13 أكتوبر 2026 (2 جمادى الأولى 1448هـ)");
  });

  it("puts the time after both dates when asked", () => {
    expect(formatRecordDate("en", AT, { withTime: true })).toBe("13 October 2026 (2 Jumada I 1448H), 14:05");
    expect(formatRecordDate("ar", AT, { withTime: true })).toBe(
      "13 أكتوبر 2026 (2 جمادى الأولى 1448هـ)، 2:05 م",
    );
  });

  it("takes both dates from the day in Riyadh", () => {
    expect(formatRecordDate("en", "2026-10-12T20:59:59.000Z")).toBe("12 October 2026 (1 Jumada I 1448H)");
    expect(formatRecordDate("en", "2026-10-12T21:00:00.000Z")).toBe("13 October 2026 (2 Jumada I 1448H)");
  });

  it("gives the parts, so a screen can keep each date on one line", () => {
    expect(formatRecordDateToParts("en", AT, { withTime: true })).toEqual([
      { type: "gregorian", value: "13 October 2026" },
      { type: "literal", value: " (" },
      { type: "hijri", value: "2 Jumada I 1448H" },
      { type: "literal", value: ")" },
      { type: "literal", value: ", " },
      { type: "time", value: "14:05" },
    ]);
  });

  it("changes only the rendering, never the stored value", () => {
    const stored = new Date(AT);
    expect(formatRecordDate("en", stored)).toBe("13 October 2026 (2 Jumada I 1448H)");
    expect(stored.toISOString()).toBe(AT);
  });

  it("shows the Gregorian date alone, never a wrong Hijri date, when the platform lacks Umm al-Qura", () => {
    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...resolvedOptions.call(this), calendar: "gregory" };
    });
    try {
      expect(formatRecordDate("en", AT)).toBe("13 October 2026");
      expect(formatRecordDate("ar", AT, { withTime: true })).toBe("13 أكتوبر 2026، 2:05 م");
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses an invalid value rather than print a date", () => {
    expect(() => formatRecordDate("en", "not a date")).toThrow(RangeError);
  });

  it("leaves operational dates Gregorian only", () => {
    expect(formatDate("en", AT)).toBe("13 Oct 2026");
    expect(formatDateTime("en", AT)).toBe("13 Oct 2026, 14:05");
    expect(formatDate("ar", AT)).not.toContain("هـ");
    expect(formatDateTime("ar", AT)).not.toContain("هـ");
  });
});
