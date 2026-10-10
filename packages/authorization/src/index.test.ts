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

  it("gives technical and oversight roles no form access (§21, ADR-011)", () => {
    for (const role of [
      "PLATFORM_ADMIN",
      "DB_ADMIN",
      "SOC_ANALYST",
      "INTERNAL_AUDIT",
      "PRIVACY_DPO",
      "RECORDS_OFFICER",
      "REFERRER",
    ] as const) {
      expect(ROLE_PERMISSIONS[role].filter((p) => p.startsWith("FORM_"))).toEqual([]);
    }
  });

  it("only GRC holds identity reveal", () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, p]) => p.includes("REPORTER_IDENTITY_REVEAL"))
      .map(([r]) => r);
    expect(holders).toEqual(["GRC_DIRECTOR"]);
  });

  it("never gives administrators or SOC records authority (ADR-013 D9)", () => {
    const recordsAuthority = [
      "RETENTION_CLASS_ASSIGN",
      "LEGAL_HOLD_APPLY",
      "LEGAL_HOLD_RELEASE",
      "DISPOSITION_REQUEST",
      "DISPOSITION_APPROVE",
    ];
    for (const role of ["PLATFORM_ADMIN", "DB_ADMIN", "SOC_ANALYST", "INTERNAL_AUDIT"] as const) {
      expect(ROLE_PERMISSIONS[role].filter((p) => recordsAuthority.includes(p))).toEqual([]);
    }
  });

  it("splits disposition request and approval across roles", () => {
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      expect(perms.includes("DISPOSITION_REQUEST") && perms.includes("DISPOSITION_APPROVE")).toBe(false);
    }
  });

  it("unions and de-duplicates permissions", () => {
    expect(permissionsForRoles(["INVESTIGATOR", "LEAD_INVESTIGATOR"])).toEqual([
      "CASE_ASSIGN",
      "CONFLICT_DECLARE",
      "EVIDENCE_DOWNLOAD",
      "EVIDENCE_UPLOAD",
      "FORM_PREPARE",
      "FORM_REVIEW",
      "FORM_VIEW",
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
