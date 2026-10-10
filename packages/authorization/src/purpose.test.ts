// ADR-014 / CDF-73: the application mirror of purpose-bound access. The database suite
// (tests/security/authz-purpose-bound.spec.ts) proves the same rules against RLS and the commands.
import { describe, expect, it } from "vitest";
import { CASE_TASK_TYPES, type Permission, type RecordsState } from "@cdf/contracts";
import {
  ROLE_PERMISSIONS,
  canApplyLegalHold,
  canDiscoverCase,
  canManageDisposition,
  canManageRetention,
  canReleaseLegalHold,
  canRequestLegalHold,
  canReviewLegalHold,
  canViewCaseContent,
  canViewCaseMetadata,
  canViewRecordsCatalogue,
  type CaseAccessContext,
  type CaseTaskGrant,
} from "./index";

const NOW = new Date("2026-10-07T12:00:00Z");
const actor = (role: keyof typeof ROLE_PERMISSIONS) => ({
  permissions: [...ROLE_PERMISSIONS[role]] as Permission[],
  clearance: "CONFIDENTIAL" as const,
});
const records = actor("RECORDS_OFFICER");
const legal = actor("LEGAL_REVIEWER");
const grc = { ...actor("GRC_DIRECTOR"), clearance: "SECRET" as const };

const kase = (over: Partial<CaseAccessContext> = {}): CaseAccessContext => ({
  classification: "CONFIDENTIAL",
  isRestricted: false,
  recordsState: "ACTIVE",
  hasConflict: false,
  hasAssignment: false,
  hasGrant: false,
  hasBreakGlass: false,
  tasks: [],
  ...over,
});
const task = (taskType: CaseTaskGrant["taskType"], over: Partial<CaseTaskGrant> = {}): CaseTaskGrant => ({
  taskType,
  scope: CASE_TASK_TYPES.find((t) => t.code === taskType)!.allowedCapabilities,
  status: "OPEN",
  accessGrantedAt: new Date("2026-10-01T00:00:00Z"),
  expiresAt: new Date("2026-10-30T00:00:00Z"),
  ...over,
});

describe("role defaults (ADR-014)", () => {
  it("no role keeps the retired role-wide records view or a derived capability", () => {
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      expect(perms).not.toContain("RECORDS_VIEW");
      expect(perms).not.toContain("CASE_VIEW_METADATA");
      expect(perms).not.toContain("CASE_VIEW_CONTENT");
    }
  });

  it("records and legal roles never hold CASE_VIEW_ALL", () => {
    expect(ROLE_PERMISSIONS.RECORDS_OFFICER).not.toContain("CASE_VIEW_ALL");
    expect(ROLE_PERMISSIONS.LEGAL_REVIEWER).not.toContain("CASE_VIEW_ALL");
  });

  it("no task type confers case content", () => {
    for (const t of CASE_TASK_TYPES) {
      expect(t.allowedCapabilities).toContain("CASE_VIEW_METADATA");
      expect(t.allowedCapabilities).not.toContain("CASE_VIEW_CONTENT");
      expect(t.allowedCapabilities).not.toContain("EVIDENCE_DOWNLOAD");
      expect(t.allowedCapabilities).not.toContain("REPORTER_IDENTITY_REVEAL");
    }
  });
});

describe("active cases (§3)", () => {
  it("an unassigned records officer or legal reviewer sees nothing", () => {
    for (const who of [records, legal]) {
      expect(canViewCaseMetadata(who, kase(), NOW)).toBe(false);
      expect(canViewCaseContent(who, kase())).toBe(false);
      expect(canApplyLegalHold(who, kase(), NOW)).toBe(false);
    }
  });

  it("a legal-hold task gives metadata and hold authority, never content", () => {
    const c = kase({ tasks: [task("LEGAL_HOLD_ASSESSMENT")] });
    expect(canViewCaseMetadata(legal, c, NOW)).toBe(true);
    expect(canReviewLegalHold(legal, c, NOW)).toBe(true);
    expect(canApplyLegalHold(legal, c, NOW)).toBe(true);
    expect(canReleaseLegalHold(legal, c, NOW)).toBe(false);
    expect(canViewCaseContent(legal, c)).toBe(false);
  });

  it("task access ends at completion, cancellation, expiry, or with a narrowed scope", () => {
    for (const t of [
      task("LEGAL_HOLD_ASSESSMENT", { status: "COMPLETED" }),
      task("LEGAL_HOLD_ASSESSMENT", { status: "CANCELLED" }),
      task("LEGAL_HOLD_ASSESSMENT", { status: "EXPIRED" }),
      task("LEGAL_HOLD_ASSESSMENT", { expiresAt: new Date("2026-10-07T11:59:59Z") }),
      task("LEGAL_HOLD_ASSESSMENT", { accessGrantedAt: new Date("2026-10-08T00:00:00Z") }),
    ]) {
      expect(canViewCaseMetadata(legal, kase({ tasks: [t] }), NOW)).toBe(false);
    }
    const narrow = kase({ tasks: [task("LEGAL_HOLD_ASSESSMENT", { scope: ["CASE_VIEW_METADATA"] })] });
    expect(canViewCaseMetadata(legal, narrow, NOW)).toBe(true);
    expect(canApplyLegalHold(legal, narrow, NOW)).toBe(false);
  });

  it("a task needs the role permission too (RBAC ∧ task)", () => {
    const c = kase({ tasks: [task("LEGAL_HOLD_ASSESSMENT")] });
    expect(canReviewLegalHold(records, c, NOW)).toBe(false);
  });

  it("clearance and conflict override any task", () => {
    expect(
      canViewCaseMetadata(legal, kase({ classification: "SECRET", tasks: [task("LEGAL_REVIEW")] }), NOW),
    ).toBe(false);
    expect(canViewCaseMetadata(legal, kase({ hasConflict: true, tasks: [task("LEGAL_REVIEW")] }), NOW)).toBe(
      false,
    );
  });

  it("a case relationship still gives content (legal reviewer with a grant)", () => {
    expect(canViewCaseContent(legal, kase({ hasGrant: true }))).toBe(true);
    expect(canRequestLegalHold(legal, kase({ hasGrant: true }), NOW)).toBe(true);
  });
});

describe("closed and archived cases (§7, §8)", () => {
  const closedStates: RecordsState[] = [
    "CLOSED",
    "ARCHIVED",
    "RETENTION",
    "DISPOSITION_ELIGIBLE",
    "DISPOSED",
  ];

  it("records officers see catalogue metadata of non-restricted closed cases and can administer them", () => {
    for (const recordsState of closedStates) {
      expect(canViewRecordsCatalogue(records, kase({ recordsState }), NOW)).toBe(true);
      expect(canViewCaseContent(records, kase({ recordsState }))).toBe(false);
    }
    expect(canManageRetention(records, kase({ recordsState: "ARCHIVED" }), NOW)).toBe(true);
    expect(canManageDisposition(records, kase({ recordsState: "DISPOSITION_ELIGIBLE" }), NOW)).toBe(true);
  });

  it("legal reviewers do not see unrelated archived cases", () => {
    for (const recordsState of closedStates) {
      expect(canViewCaseMetadata(legal, kase({ recordsState }), NOW)).toBe(false);
    }
  });

  it("restricted cases stay hidden at every lifecycle state unless a task or relationship exists (§9)", () => {
    for (const recordsState of closedStates) {
      const c = kase({ recordsState, isRestricted: true });
      expect(canViewCaseMetadata(records, c, NOW)).toBe(false);
      expect(canViewCaseMetadata(legal, c, NOW)).toBe(false);
      expect(canManageRetention(records, c, NOW)).toBe(false);
    }
    const tasked = kase({ recordsState: "ARCHIVED", isRestricted: true, tasks: [task("RETENTION_REVIEW")] });
    expect(canViewCaseMetadata(records, tasked, NOW)).toBe(true);
    expect(canManageRetention(records, tasked, NOW)).toBe(true);
    expect(canManageDisposition(records, tasked, NOW)).toBe(false);
  });

  it("GRC keeps its existing access (regression)", () => {
    expect(canViewCaseContent(grc, kase())).toBe(true);
    expect(canViewCaseContent(grc, kase({ isRestricted: true }))).toBe(false);
    expect(canViewCaseContent(grc, kase({ isRestricted: true, hasAssignment: true }))).toBe(true);
  });
});

describe("discovery (§6)", () => {
  it("only CASE_DISCOVER holders may use the controlled lookup", () => {
    expect(canDiscoverCase(legal)).toBe(true);
    expect(canDiscoverCase(records)).toBe(true);
    expect(canDiscoverCase(actor("INVESTIGATOR"))).toBe(false);
    expect(canDiscoverCase(null)).toBe(false);
  });
});
