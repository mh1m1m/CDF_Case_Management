import { describe, expect, it } from "vitest";
import type { MyArea, WorkItem } from "@cdf/contracts";
import { safeReturnPath } from "./return-path";
import { areaHref, areaOfPath, itemHref, landingFor } from "./work-routes";

const area = (a: MyArea["area"], defaultView = "x"): MyArea => ({ area: a, actionableCount: 0, defaultView });
const item = (over: Partial<WorkItem>): WorkItem => ({
  area: "CASES",
  view: "NEEDS_ACTION",
  category: "MY_CASE",
  targetType: "CASE",
  targetId: "t",
  caseId: null,
  caseNumber: null,
  dueAt: null,
  dueSource: null,
  sinceAt: null,
  ...over,
});

describe("landing (audit §20.6): by where the work is, never by role name", () => {
  it("sends an account with no area to /no-workspace", () => {
    expect(landingFor([])).toBe("/no-workspace");
  });
  it("sends records-only work to Records and everyone else with My Work to My Work", () => {
    expect(landingFor([area("MY_WORK"), area("RECORDS", "my-tasks")])).toBe("/records");
    expect(landingFor([area("MY_WORK"), area("RECORDS", "legal-holds")])).toBe("/my-work");
    expect(landingFor([area("MY_WORK"), area("CASES"), area("RECORDS", "my-tasks")])).toBe("/my-work");
    expect(landingFor([area("MY_WORK"), area("INTAKE")])).toBe("/my-work");
  });
  it("sends oversight and administration accounts to their area's default view", () => {
    expect(landingFor([area("OVERSIGHT", "security-events")])).toBe("/oversight?view=security-events");
    expect(landingFor([area("OVERSIGHT", "ledger")])).toBe("/oversight?view=ledger");
    expect(landingFor([area("ADMINISTRATION", "users")])).toBe("/admin/users");
  });
});

describe("routes", () => {
  it("maps areas and paths both ways", () => {
    expect(areaHref(area("RECORDS", "legal-holds"))).toBe("/records/legal-holds");
    expect(areaHref(area("CASES", "my-cases"))).toBe("/cases");
    expect(areaOfPath("/cases/abc/forms")).toBe("CASES");
    expect(areaOfPath("/admin/users")).toBe("ADMINISTRATION");
    expect(areaOfPath("/settings/access")).toBeUndefined();
  });
  it("leads each item to the page where its work is done", () => {
    expect(itemHref(item({ targetType: "REPORT", category: "NEW_REPORT", targetId: "r" }))).toBe("/intake/r");
    expect(
      itemHref(item({ targetType: "REPORT", category: "REPORTER_REPLIED", targetId: "r", caseId: "c" })),
    ).toBe("/cases/c");
    expect(itemHref(item({ targetType: "CONFLICT", targetId: "k", caseId: "c" }))).toBe(
      "/cases/c#conflict-decisions",
    );
    expect(itemHref(item({ targetType: "FORM_INSTANCE", targetId: "f", caseId: "c" }))).toBe(
      "/cases/c/forms/f",
    );
    expect(itemHref(item({ targetType: "CASE_TASK", targetId: "t", caseId: "c" }))).toBe("/records/c");
    expect(itemHref(item({ targetType: "HOLD_REQUEST", targetId: "h", caseId: "c" }))).toBe(
      "/records/legal-holds",
    );
  });
});

describe("return path after sign-in (DEC-20)", () => {
  it("keeps a same-site path and a plain query", () => {
    expect(safeReturnPath("/cases/0b6c2f4e-1111-4222-8333-444455556666")).toBe(
      "/cases/0b6c2f4e-1111-4222-8333-444455556666",
    );
    expect(safeReturnPath("/my-work?view=due-soon")).toBe("/my-work?view=due-soon");
  });
  it("refuses every other target", () => {
    for (const bad of [
      "https://evil.example.test/",
      "//evil.example.test",
      "/\\evil.example.test",
      "/%2F%2Fevil.example.test",
      "/cases/../../x",
      "/cases#frag",
      "/cases?next=https://evil.example.test",
      "javascript:alert(1)",
      "/login",
      "/login?next=/cases",
      "/locale",
      " /cases",
      "/cases\n",
      "",
      "/" + "a".repeat(600),
      undefined,
      ["/cases"],
    ])
      expect(safeReturnPath(bad), String(bad)).toBe("/");
  });
});
