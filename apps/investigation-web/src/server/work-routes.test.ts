import { describe, expect, it } from "vitest";
import type { MyArea, WorkItem } from "@cdf/contracts";
import { safeLocaleReturnPath, safeReturnPath } from "./return-path";
import { areaHref, areaOfPath, daysSince, itemHref, landingFor, notificationHref } from "./work-routes";

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
  code: null,
  reasonCodes: null,
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
    ).toBe("/cases/c/reporter");
    expect(itemHref(item({ targetType: "CONFLICT", targetId: "k", caseId: "c" }))).toBe(
      "/cases/c/people#conflict-decisions",
    );
    expect(itemHref(item({ targetType: "FORM_INSTANCE", targetId: "f", caseId: "c" }))).toBe(
      "/cases/c/forms/f",
    );
    // S3 (ADR-016 D2): a form held by form-scoped access opens in the purpose view, even if the case is named.
    for (const caseId of [null, "c"])
      expect(itemHref(item({ area: "MY_WORK", targetType: "FORM_INSTANCE", targetId: "f", caseId }))).toBe(
        "/my-work/forms/f",
      );
    expect(itemHref(item({ targetType: "CASE_TASK", targetId: "t", caseId: "c" }))).toBe("/records/c");
    expect(itemHref(item({ targetType: "HOLD_REQUEST", targetId: "h", caseId: "c" }))).toBe(
      "/records/legal-holds",
    );
    expect(
      itemHref(
        item({ category: "RETENTION_CLASSIFICATION", targetType: "RECORD", targetId: "c", caseId: "c" }),
      ),
    ).toBe("/records/c#retention");
    expect(
      itemHref(item({ category: "RETENTION_TO_ROUTE", targetType: "RECORD", targetId: "c", caseId: "c" })),
    ).toBe("/records/c#route-retention");
  });
  it("opens a Phase 12 purpose item nowhere until its page ships, then on that page (migration 2045)", () => {
    const roots = {
      REFERRAL: "/referrals",
      PRELIMINARY_REVIEW: "/preliminary-reviews",
      MEETING: "/meetings",
      MINUTES: "/minutes",
      LEGAL_REVIEW: "/legal-reviews",
      DEFENCE_NOTICE: "/my-defence",
      GRIEVANCE: "/grievances",
      EXPORT: "/exports",
      CORRECTIVE_ACTION: "/actions",
      BCP_IMPORT: "/continuity/imports",
    } as const;
    const all = Object.values(roots);
    for (const [targetType, root] of Object.entries(roots) as [keyof typeof roots, string][]) {
      const i = item({ area: "MY_WORK", targetType, targetId: "x", caseId: "c" });
      expect(itemHref(i), targetType).toBeNull();
      expect(itemHref(i, [root]), targetType).toBe(`${root}/x`);
      expect(
        itemHref(
          i,
          all.filter((r) => r !== root),
        ),
        targetType,
      ).toBeNull();
    }
    // A restricted case's approval of a recommendation package has no page of its own yet (P12-3).
    expect(
      itemHref(item({ targetType: "RECOMMENDATION_PACKAGE", targetId: "x", caseId: "c" }), all),
    ).toBeNull();
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

describe("return path after a language switch", () => {
  it("keeps the page and its view, the sign-in page included", () => {
    expect(safeLocaleReturnPath("/my-work?view=due-soon")).toBe("/my-work?view=due-soon");
    expect(safeLocaleReturnPath("/login?next=%2Fcases%2Fabc")).toBe("/login?next=%2Fcases%2Fabc");
  });
  it("refuses other origins and the switch itself", () => {
    for (const bad of ["//evil.example.test", "https://evil.example.test/", "/locale?to=ar", "/\\x", null])
      expect(safeLocaleReturnPath(bad), String(bad)).toBe("/");
  });
});

describe("age in a queue (ADR-016 D8)", () => {
  it("counts whole days and never goes below zero", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    expect(daysSince("2026-10-12T00:00:00Z", now)).toBe(0);
    expect(daysSince("2026-10-11T11:59:59Z", now)).toBe(1);
    expect(daysSince("2026-10-01T12:00:00Z", now)).toBe(11);
    expect(daysSince("2026-10-13T00:00:00Z", now)).toBe(0);
  });
});

describe("notification links (UX redesign S4)", () => {
  const id = "0b1f6f2e-6c7a-4d39-9d5e-1f6c2f0d9a11";
  it("links nowhere while the page has not shipped", () => {
    expect(notificationHref({ deepLink: `/committees/${id}` })).toBeNull();
  });
  it("links to a live root only, and only to an id-only path", () => {
    expect(notificationHref({ deepLink: `/committees/${id}` }, ["/committees"])).toBe(`/committees/${id}`);
    expect(notificationHref({ deepLink: `/committees-x/${id}` }, ["/committees"])).toBeNull();
    expect(notificationHref({ deepLink: `/continuity/imports/${id}` }, ["/continuity/imports"])).toBe(
      `/continuity/imports/${id}`,
    );
    for (const bad of [
      `//evil.example/${id}`,
      `/committees/${id}?x=1`,
      `https://evil.example/committees/${id}`,
      "",
    ])
      expect(notificationHref({ deepLink: bad }, ["/committees"]), bad).toBeNull();
  });
});
