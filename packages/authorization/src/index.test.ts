import { describe, expect, it } from "vitest";
import { ROLES } from "@cdf/contracts";
import { ROLE_PERMISSIONS, navigationFor, permissionsForRoles, withinClearance } from "./index";

describe("role permission mirror", () => {
  it("covers every role", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
  });

  it("never gives administrators case content permissions (§21)", () => {
    for (const role of ["PLATFORM_ADMIN", "DB_ADMIN", "SOC_ANALYST", "INTERNAL_AUDIT"] as const) {
      const perms = ROLE_PERMISSIONS[role];
      expect(
        perms.filter((p) => p.startsWith("CASE_") || p === "REPORTER_IDENTITY_REVEAL" || p === "INTAKE_VIEW"),
      ).toEqual([]);
    }
  });

  it("only GRC holds identity reveal", () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, p]) => p.includes("REPORTER_IDENTITY_REVEAL"))
      .map(([r]) => r);
    expect(holders).toEqual(["GRC_DIRECTOR"]);
  });

  it("unions and de-duplicates permissions", () => {
    expect(permissionsForRoles(["INVESTIGATOR", "LEAD_INVESTIGATOR"])).toEqual([
      "CASE_ASSIGN",
      "CONFLICT_DECLARE",
      "WORKFLOW_ADVANCE",
    ]);
  });

  it("derives navigation from permissions", () => {
    expect(navigationFor({ permissions: permissionsForRoles(["PLATFORM_ADMIN"]) })).toEqual({
      intake: false,
      cases: false,
      audit: false,
      administration: true,
    });
  });

  it("compares clearance", () => {
    expect(withinClearance({ clearance: "CONFIDENTIAL" }, "SECRET")).toBe(false);
  });
});
