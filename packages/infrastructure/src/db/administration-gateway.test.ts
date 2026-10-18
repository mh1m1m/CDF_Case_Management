// The Administration registers' two judgements made outside SQL (UX redesign Phase 12 P12-8a; ADR-051's P12-8a
// amendment). Whether a row is in force is read against the database's clock with `effective_to` exclusive, as every
// register stores it; and a working week starts at the beginning of its date in Riyadh, the instant
// api.set_business_week_pattern compares with now(). The registers themselves, against the database, are in
// tests/integration/administration.spec.ts.
import { describe, expect, it } from "vitest";
import { periodState, riyadhMidnight } from "./administration-gateway";

const NOW = "2026-10-18T12:00:00.000Z";

describe("whether a row is in force", () => {
  it("is in force from its start, inclusive, until its end, exclusive", () => {
    expect(periodState("2026-10-18T12:00:00.000Z", null, NOW)).toBe("IN_FORCE");
    expect(periodState("2026-01-01T00:00:00.000Z", "2026-10-18T12:00:00.001Z", NOW)).toBe("IN_FORCE");
    expect(periodState("2026-01-01T00:00:00.000Z", "2026-10-18T12:00:00.000Z", NOW)).toBe("ENDED");
    expect(periodState("2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", NOW)).toBe("ENDED");
  });

  it("starts later when its start is after now", () => {
    expect(periodState("2026-10-18T12:00:00.001Z", null, NOW)).toBe("SCHEDULED");
    expect(periodState("2027-01-01T00:00:00.000Z", "2027-02-01T00:00:00.000Z", NOW)).toBe("SCHEDULED");
  });

  it("reads PostgreSQL's text form of a timestamp, offset included, and a bare date as that day's start in UTC", () => {
    // 15:00 in Riyadh is 12:00 UTC: the same instant as now.
    expect(periodState("2026-10-18 15:00:00+03", null, NOW)).toBe("IN_FORCE");
    expect(periodState("2026-10-18 15:00:00.5+03", null, NOW)).toBe("SCHEDULED");
    expect(periodState("2026-10-01", "2026-10-18", NOW)).toBe("ENDED");
    expect(periodState("2026-10-01", "2026-10-19", NOW)).toBe("IN_FORCE");
  });
});

describe("the start of a date in Riyadh", () => {
  it("is 21:00 UTC the evening before, all year (Riyadh keeps UTC+3)", () => {
    for (const date of ["2026-01-01", "2026-03-29", "2026-07-01", "2026-10-25", "2028-02-29"]) {
      const start = new Date(riyadhMidnight(date));
      const before = new Date(`${date}T00:00:00Z`);
      before.setUTCHours(-3);
      expect(start.toISOString(), date).toBe(before.toISOString());
    }
    expect(new Date(riyadhMidnight("2027-01-03")).toISOString()).toBe("2027-01-02T21:00:00.000Z");
  });
});
