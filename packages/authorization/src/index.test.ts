import { describe, expect, it } from "vitest";
import { ROLES, type MyArea, type Role } from "@cdf/contracts";
import {
  ROLE_PERMISSIONS,
  areaPermitted,
  navigationFor,
  permissionsForRoles,
  shellAreas,
  withinClearance,
} from "./index";

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
      "BCP_IMPORT",
      "CASE_ASSIGN",
      "CONFLICT_DECLARE",
      "EVIDENCE_DOWNLOAD",
      "EVIDENCE_UPLOAD",
      "EXPORT_REQUEST",
      "FORM_PREPARE",
      "FORM_REVIEW",
      "FORM_VIEW",
      "LEGAL_HOLD_REQUEST",
      "PRELIMINARY_PREPARE",
      "WORKFLOW_ADVANCE",
    ]);
  });

  it("derives navigation from permissions", () => {
    expect(navigationFor({ permissions: permissionsForRoles(["PLATFORM_ADMIN"]) })).toEqual({
      intake: false,
      cases: false,
      audit: false,
      myWork: false,
      recordsCatalogue: false,
      administration: true,
    });
  });

  it("compares clearance", () => {
    expect(withinClearance({ clearance: "CONFIDENTIAL" }, "SECRET")).toBe(false);
  });
});

describe("shell areas (UX redesign S1, audit §20.4)", () => {
  const area = (a: MyArea["area"]): MyArea => ({ area: a, actionableCount: 0, defaultView: "x" });
  const actorOf = (...roles: Role[]) => ({ permissions: permissionsForRoles(roles) });

  it("keeps the fixed order and drops duplicates", () => {
    const got = shellAreas(actorOf("CASE_MANAGER"), [
      area("RECORDS"),
      area("CASES"),
      area("MY_WORK"),
      area("CASES"),
    ]);
    expect(got.map((a) => a.area)).toEqual(["MY_WORK", "CASES", "RECORDS"]);
  });

  it("never shows Oversight or Administration without their permission, whatever the database says", () => {
    expect(shellAreas(actorOf("INVESTIGATOR"), [area("OVERSIGHT"), area("ADMINISTRATION")])).toEqual([]);
    expect(areaPermitted(actorOf("PLATFORM_ADMIN"), "ADMINISTRATION")).toBe(true);
    expect(areaPermitted(actorOf("PLATFORM_ADMIN"), "INTAKE")).toBe(false);
  });

  it("has no Committee or Reporting area before S5 and S6", () => {
    for (const role of ROLES) {
      expect(areaPermitted(actorOf(role), "COMMITTEE")).toBe(false);
      expect(areaPermitted(actorOf(role), "REPORTING")).toBe(false);
    }
  });

  it("lets an assignment alone open My Work and Cases (the database decides the relationship)", () => {
    expect(areaPermitted({ permissions: [] }, "MY_WORK")).toBe(true);
    expect(areaPermitted({ permissions: [] }, "CASES")).toBe(true);
    expect(areaPermitted({ permissions: [] }, "RECORDS")).toBe(false);
  });
});
