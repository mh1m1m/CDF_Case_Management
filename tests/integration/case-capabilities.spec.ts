// UX redesign S2e (UX-116; audit §22, E12-F7): what a viewer may do on a case comes from the database's own rules
// (authz.can_edit_case, can_assign_case, can_upload_evidence, can_conduct/review/approve_interviews), read with
// the case through the real service, gateway and database. No case page re-implements those rules any more.
// The commands still check them again; this only decides which controls a page offers.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createInvestigationService } from "@cdf/application";
import type { CaseCapabilities } from "@cdf/contracts";
import { PostgresInvestigationGateway, PostgresSecurityEventSink } from "@cdf/infrastructure";
import { USERS, bff, caseId, type UserKey } from "../support/db";

const service = createInvestigationService({
  gateway: new PostgresInvestigationGateway(bff),
  securityEvents: new PostgresSecurityEventSink(bff),
});
const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });

let caseA: string;
beforeAll(async () => {
  caseA = await caseId("0001");
});

const NONE = {
  edit: false,
  assign: false,
  uploadEvidence: false,
  conductInterviews: false,
  reviewInterviews: false,
  approveInterviews: false,
};

describe("case capabilities come from the database (UX-116)", () => {
  it("match each seed role's relationship to case 0001", async () => {
    const expected: Partial<Record<UserKey, Partial<CaseCapabilities>>> = {
      // The lead edits through the assignment alone; before S2e the page hid "Edit details" from them.
      lead: {
        edit: true,
        assign: true,
        uploadEvidence: true,
        conductInterviews: true,
        reviewInterviews: true,
        approveInterviews: true,
        classifications: ["CONFIDENTIAL"],
      },
      investigatorA: {
        ...NONE,
        uploadEvidence: true,
        conductInterviews: true,
        classifications: ["CONFIDENTIAL"],
      },
      caseManager: {
        edit: true,
        assign: true,
        uploadEvidence: true,
        conductInterviews: true,
        reviewInterviews: true,
        approveInterviews: true,
      },
      // Manages the team by role, but neither edits nor works the evidence or interviews without an assignment.
      grcDirector: { ...NONE, assign: true, classifications: ["CONFIDENTIAL", "SECRET"] },
      triage: NONE,
      committeeChair: NONE,
    };
    for (const [user, can] of Object.entries(expected) as [UserKey, Partial<CaseCapabilities>][]) {
      const c = await service.getCase(ctxFor(user), caseA);
      expect(c, user).not.toBeNull();
      expect(c!.can, user).toMatchObject(can);
    }
  });

  it("gives nothing to someone who cannot see the case", async () => {
    expect(await service.getCase(ctxFor("investigatorB"), caseA)).toBeNull();
  });
});

describe("no case page re-implements an authorization rule", () => {
  const root = join(import.meta.dirname, "..", "..");
  const pages = join(root, "apps/investigation-web/src/app/(shell)/cases");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });

  it("reads edit, team, upload, interview and classification rights from the case, not from roles", () => {
    const files = sources(pages);
    expect(files.length).toBeGreaterThan(10);
    const mirrors = files.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      const found = [
        /can\(actor, "(CASE_EDIT_ALL|CASE_ASSIGN|EVIDENCE_UPLOAD|CASE_VIEW_ALL|RESTRICTED_CASE_GRANT)"\)/g,
        /CLASSIFICATION_LEVELS\.indexOf/g,
        /actor\.clearance/g,
        // The caller's own assignment roles used as a rule ("am I the lead here?").
        /a\.userId === actor\.userId\s*&&/g,
      ].flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
      return found.map((m) => `${relative(root, f)}: ${m}`);
    });
    expect(mirrors).toEqual([]);
  });
});
