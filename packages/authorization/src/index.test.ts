import { describe, expect, it } from "vitest";
import { ADMIN_VIEWS, ROLES, type MyArea, type Permission, type Role } from "@cdf/contracts";
import {
  ROLE_PERMISSIONS,
  adminViews,
  areaPermitted,
  canAdministerExportPolicy,
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

  it("has no Reporting area before S6", () => {
    for (const role of ROLES) expect(areaPermitted(actorOf(role), "REPORTING")).toBe(false);
  });

  it("lets an assignment alone open My Work and Cases (the database decides the relationship)", () => {
    expect(areaPermitted({ permissions: [] }, "MY_WORK")).toBe(true);
    expect(areaPermitted({ permissions: [] }, "CASES")).toBe(true);
    expect(areaPermitted({ permissions: [] }, "RECORDS")).toBe(false);
  });

  it("shows My Committees only where the database lists a seat, never from a role (P12-2b, AMB-047)", () => {
    // A seat alone opens the area: no permission is needed, and none is enough.
    expect(areaPermitted({ permissions: [] }, "COMMITTEE")).toBe(true);
    expect(shellAreas({ permissions: [] }, [area("COMMITTEE")]).map((a) => a.area)).toEqual(["COMMITTEE"]);
    for (const role of [
      "COMMITTEE_CHAIR",
      "COMMITTEE_SECRETARY",
      "COMMITTEE_MEMBER",
      "PLATFORM_ADMIN",
    ] as const)
      expect(shellAreas(actorOf(role), [area("MY_WORK")]).map((a) => a.area)).toEqual(["MY_WORK"]);
  });
});

describe("export policy administration (DEC-F24, migration 2040)", () => {
  it("is separate from export approval: an approver never administers export policy, whatever the grant", () => {
    const actorOf = (...roles: Role[]) => ({ permissions: permissionsForRoles(roles) });
    expect(canAdministerExportPolicy(actorOf("PLATFORM_ADMIN"))).toBe(true);
    expect(ROLE_PERMISSIONS.GRC_DIRECTOR).toContain("EXPORT_POLICY_ADMIN"); // the 1930 grant, kept and inert
    expect(canAdministerExportPolicy(actorOf("GRC_DIRECTOR"))).toBe(false);
    expect(canAdministerExportPolicy(actorOf("PLATFORM_ADMIN", "CASE_MANAGER"))).toBe(false);
    expect(canAdministerExportPolicy(actorOf("CASE_MANAGER"))).toBe(false);
    expect(canAdministerExportPolicy(null)).toBe(false);
  });
});

describe("Administration pages (UX redesign P12-8a; ADR-051's P12-8a amendment)", () => {
  const holding = (...permissions: Permission[]) => ({ permissions });
  const roles = (...r: Role[]) => ({ permissions: permissionsForRoles(r) });
  /** Each page and the permission that opens it, as 2045's api.my_areas gates the area. */
  const OPENS: [Permission, (typeof ADMIN_VIEWS)[number]][] = [
    ["USER_ADMIN", "users"],
    ["ROLE_ADMIN", "users"],
    ["COMMITTEE_ADMIN", "committees"],
    ["SECTOR_ADMIN", "sectors"],
    ["NOTIFICATION_ADMIN", "notification-rules"],
    ["EXPORT_POLICY_ADMIN", "export-policy"],
    ["CORRECTIVE_ACTION_POLICY_ADMIN", "corrective-action-policy"],
    ["BUSINESS_CALENDAR_ADMIN", "calendar"],
  ];

  it("opens each page to the holder of its own permission, and the area with it", () => {
    for (const [permission, view] of OPENS) {
      expect(adminViews(holding(permission)), permission).toEqual([view]);
      expect(areaPermitted(holding(permission), "ADMINISTRATION"), permission).toBe(true);
      expect(navigationFor(holding(permission)).administration, permission).toBe(true);
    }
  });

  it("lists the pages in the order api.my_areas picks the area's default view from", () => {
    const all = OPENS.map(([p]) => p).reverse();
    expect(adminViews(holding(...all))).toEqual([...ADMIN_VIEWS]);
    expect(
      adminViews(holding("BUSINESS_CALENDAR_ADMIN", "USER_ADMIN", "CORRECTIVE_ACTION_POLICY_ADMIN")),
    ).toEqual(["users", "corrective-action-policy", "calendar"]);
  });

  it("never opens export policy to an export approver (DEC-F24), as authz.is_export_policy_admin()", () => {
    for (const approval of ["EXPORT_APPROVE", "EXPORT_SECOND_APPROVE"] as const) {
      expect(adminViews(holding("EXPORT_POLICY_ADMIN", approval))).toEqual([]);
      expect(areaPermitted(holding("EXPORT_POLICY_ADMIN", approval), "ADMINISTRATION")).toBe(false);
    }
  });

  it("opens nothing, and no area, without an administrator's permission", () => {
    expect(adminViews(null)).toEqual([]);
    expect(adminViews(undefined)).toEqual([]);
    expect(adminViews(holding("CASE_VIEW_ALL", "EXPORT_APPROVE", "AUDIT_VIEW"))).toEqual([]);
    expect(areaPermitted(holding(), "ADMINISTRATION")).toBe(false);
    expect(navigationFor(holding()).administration).toBe(false);
  });

  it("gives each seeded role the pages its permissions open, and every other role none", () => {
    const expected: Partial<Record<Role, string[]>> = {
      PLATFORM_ADMIN: ["users", "committees", "sectors", "notification-rules", "export-policy", "calendar"],
      // GRC_DIRECTOR holds EXPORT_POLICY_ADMIN from 1930, inert beside its export approval (DEC-F24).
      GRC_DIRECTOR: ["committees", "corrective-action-policy"],
      COMPLIANCE_SECTION_MANAGER: ["committees"],
    };
    for (const role of ROLES) expect(adminViews(roles(role)), role).toEqual(expected[role] ?? []);
  });
});
