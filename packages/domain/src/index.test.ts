import { describe, expect, it } from "vitest";
import {
  REPORTER_SECRET_PATTERN,
  clearanceCovers,
  generateReportRef,
  generateReporterSecret,
  isReportRef,
  normaliseReportRef,
  normaliseReporterSecret,
} from "./index";

describe("report references", () => {
  it("generates valid, distinct references", () => {
    const refs = new Set(Array.from({ length: 1000 }, () => generateReportRef()));
    expect(refs.size).toBe(1000);
    for (const r of refs) expect(isReportRef(r)).toBe(true);
  });

  it("never uses ambiguous letters", () => {
    for (let i = 0; i < 200; i++) expect(generateReportRef()).not.toMatch(/[ILOU]/);
  });

  it("normalises typed input", () => {
    expect(normaliseReportRef(" wb-abcdefghjkm0 ")).toBe("WB-ABCDEFGHJKM0");
    expect(normaliseReportRef("wb-0o1il0000000")).toBe("WB-001110000000");
  });
});

describe("reporter secrets", () => {
  it("are 100-bit grouped Crockford strings", () => {
    const s = generateReporterSecret();
    expect(s).toMatch(REPORTER_SECRET_PATTERN);
  });

  it("normalise spacing, case and ambiguous letters", () => {
    expect(normaliseReporterSecret("abcd efgh-jkmn pqrs tvwo")).toBe("ABCD-EFGH-JKMN-PQRS-TVW0");
  });
});

describe("clearance", () => {
  it("orders INTERNAL < RESTRICTED < CONFIDENTIAL < SECRET", () => {
    expect(clearanceCovers("SECRET", "CONFIDENTIAL")).toBe(true);
    expect(clearanceCovers("CONFIDENTIAL", "SECRET")).toBe(false);
    expect(clearanceCovers("RESTRICTED", "RESTRICTED")).toBe(true);
  });
});
