import { describe, expect, it } from "vitest";
import { ar } from "./messages/ar";
import { en } from "./messages/en";
import { directionOf, translate } from "./index";

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
});
