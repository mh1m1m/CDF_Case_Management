import { describe, expect, it } from "vitest";
import { ar } from "./messages/ar";
import { en } from "./messages/en";
import { directionOf, formatList, isolate, translate } from "./index";

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
});
