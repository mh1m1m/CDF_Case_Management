// UX-003 (CRITICAL) · DEC-01 (ADR-016 D1) · §19, §21, §22: a restricted case opened from a triaged report
// names an eligible restricted-case authority, who becomes its accountable owner in the same transaction.
// Nobody else (the initiator included) can see the case until the authority staffs it; an ineligible,
// unknown or missing authority leaves nothing behind; the hand-over is audited with the creation.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  USERS,
  admin,
  caseId,
  ownerScenario,
  reportId,
  scenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";

const REASON = "Synthetic: restricted-case authority test.";
const TITLE = "Restricted probe case (synthetic)";
const SUMMARY = "Synthetic restricted probe summary.";
let report: string;
beforeAll(async () => {
  report = await reportId("WB-SEED00000005");
});

/** Triage accepts the seed report so a case can be opened from it. */
async function accepted(s: Scenario) {
  await s.as("triage");
  await s.tx`select api.triage_report(${report}, 'OPEN_CASE', ${REASON}, null, null)`;
}

async function createRestricted(s: Scenario, authority: string | null, classification = "CONFIDENTIAL") {
  const [row] = await s.tx<{ id: string }[]>`
    select api.create_case_from_report(${report}, ${TITLE}, ${SUMMARY},
      ${classification}::core.classification_level, true, ${authority}::uuid) as id`;
  return row!.id;
}

async function canView(s: Scenario, user: UserKey, caseId: string): Promise<boolean> {
  await s.as(user);
  const [row] = await s.tx<{ v: boolean }[]>`select authz.can_view_case(${caseId}) as v`;
  return row!.v;
}

/** Owner-side facts about the new case: its access rows, owner and audit trail. */
async function facts(s: OwnerScenario, caseId: string) {
  await s.asOwner();
  const [c] = await s.tx<{ isRestricted: boolean; ownerId: string | null; classification: string }[]>`
    select is_restricted as "isRestricted", owner_id as "ownerId", classification::text as classification
    from case_mgmt.case_record where id = ${caseId}`;
  const assignments = await s.tx<{ userId: string; role: string }[]>`
    select user_id as "userId", assignment_role as role from case_mgmt.case_assignment
    where case_id = ${caseId} and status = 'ACTIVE'`;
  const grants = await s.tx<{ userId: string }[]>`
    select user_id as "userId" from case_mgmt.case_access_grant where case_id = ${caseId}`;
  const events = await s.tx<{ action: string; actorId: string; metadata: Record<string, unknown> }[]>`
    select action, actor_id as "actorId", metadata from audit.audit_event where case_id = ${caseId} order by seq`;
  return { case: c!, assignments, grants, events };
}

describe("eligible authorities (DEC-01 step 2)", () => {
  it("lists only eligible authorities, by name only", async () => {
    await scenario(async (s) => {
      await accepted(s);
      const rows = await s.tx<Record<string, unknown>[]>`
        select * from api.list_restricted_case_authorities(${report}, 'CONFIDENTIAL'::core.classification_level)`;
      expect(rows.map((r) => r.user_id).sort()).toEqual([USERS.grcDirector, USERS.grcDeputy].sort());
      // No email, department or clearance: the choice needs a name and nothing more of the directory.
      expect(Object.keys(rows[0]!).sort()).toEqual(["display_name", "display_name_ar", "user_id"]);
    });
  });

  it("refuses callers who cannot open a case from the report, and classifications above their clearance", async () => {
    await scenario(async (s) => {
      await accepted(s);
      const list = (classification: string) => (tx: Scenario["tx"]) =>
        tx`select * from api.list_restricted_case_authorities(${report}, ${classification}::core.classification_level)`;
      await s.as("investigatorA"); // cannot see the report at all
      await s.expectError("CDF_NOT_FOUND", list("CONFIDENTIAL"));
      await s.as("intake"); // sees the report, may not open a case
      await s.expectError("CDF_FORBIDDEN", list("CONFIDENTIAL"));
      await s.as("triage"); // CONFIDENTIAL clearance
      await s.expectError("CDF_INVALID:classification", list("SECRET"));
      // A random report id gets the same answer as a hidden one.
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select * from api.list_restricted_case_authorities(${randomUUID()}, 'CONFIDENTIAL'::core.classification_level)`,
      );
    });
  });
});

describe("one transaction creates, restricts, assigns, hands over and audits (DEC-01 step 5)", () => {
  it("makes the named authority the only person with access, and records the hand-over", async () => {
    await ownerScenario(async (s) => {
      await accepted(s);
      const caseId = await createRestricted(s, USERS.grcDirector);
      const f = await facts(s, caseId);
      expect(f.case).toEqual({
        isRestricted: true,
        ownerId: USERS.grcDirector,
        classification: "CONFIDENTIAL",
      });
      // Minimum access basis: one CASE_OWNER assignment for the authority, no access grant for anyone.
      expect(f.assignments).toEqual([{ userId: USERS.grcDirector, role: "CASE_OWNER" }]);
      expect(f.grants).toEqual([]);
      const actions = f.events.map((e) => e.action);
      expect(actions).toEqual(expect.arrayContaining(["CASE_CREATED", "CASE_ASSIGNED", "CASE_HANDED_OVER"]));
      expect(actions).not.toContain("CASE_ACCESS_GRANTED");
      const handover = f.events.find((e) => e.action === "CASE_HANDED_OVER")!;
      expect(handover.actorId).toBe(USERS.triage);
      expect(handover.metadata).toMatchObject({
        from_user_id: USERS.triage,
        to_user_id: USERS.grcDirector,
        basis: "RESTRICTED_AT_CREATION",
        initiator_access: "NONE",
      });
    });
  });

  it("the authority can reach and staff the case; nobody else can see it, the initiator included", async () => {
    await scenario(async (s) => {
      await accepted(s);
      const caseId = await createRestricted(s, USERS.grcDirector);
      expect(await canView(s, "grcDirector", caseId)).toBe(true);
      const [opened] = await s.tx<{ v: boolean }[]>`select api.open_case(${caseId}) as v`;
      expect(opened!.v).toBe(true);

      const others: UserKey[] = [
        "triage", // the initiator: handed over, no residual TRIAGE grant (DEC-03)
        "grcDeputy", // also eligible, but not named
        "caseManager", // CASE_VIEW_ALL never reaches restricted cases
        "intake",
        "investigatorA",
        "lead",
        "committee",
        "committeeSecretary",
        "legal",
        "records",
        "platformAdmin", // PLATFORM_ADMIN never implies case content (§21)
        "internalAudit",
        "soc",
        "dpo",
      ];
      const leaks: string[] = [];
      for (const user of others) if (await canView(s, user, caseId)) leaks.push(user);
      expect(leaks).toEqual([]);
      // The source report now follows the case: the initiator can no longer open it either.
      await s.as("triage");
      const [r] = await s.tx<{ v: boolean }[]>`select authz.can_view_report(${report}) as v`;
      expect(r!.v).toBe(false);

      // The authority staffs the case through the ordinary command, which makes the case reachable to the team.
      await s.as("grcDirector");
      await s.tx`select api.assign_case(${caseId}, ${USERS.investigatorA}, 'INVESTIGATOR', ${REASON})`;
      expect(await canView(s, "investigatorA", caseId)).toBe(true);
      expect(await canView(s, "investigatorB", caseId)).toBe(false);
    });
  });
});

describe("fails safely, with no orphan (DEC-01)", () => {
  it("refuses a missing, ineligible, inactive or unknown authority with the same answer, and writes nothing", async () => {
    await ownerScenario(async (s) => {
      await accepted(s);
      const attempts: (string | null)[] = [
        null,
        USERS.caseManager, // may own cases, but holds no RESTRICTED_CASE_AUTHORITY
        USERS.investigatorA,
        USERS.triage, // the initiator, not eligible
        USERS.revoked,
        randomUUID(),
      ];
      for (const authority of attempts)
        await s.expectError(
          "CDF_INVALID:restricted_authority_id",
          (tx) =>
            tx`select api.create_case_from_report(${report}, ${TITLE}, ${SUMMARY},
            'CONFIDENTIAL'::core.classification_level, true, ${authority}::uuid)`,
        );
      await s.asOwner();
      const [left] = await s.tx<{ cases: number; status: string }[]>`
        select (select count(*)::int from case_mgmt.case_record where source_report_id = ${report}) as cases,
               (select status from intake.report where id = ${report}) as status`;
      expect(left).toEqual({ cases: 0, status: "ACCEPTED" });
    });
  });

  it("refuses an authority whose clearance is below the classification", async () => {
    await ownerScenario(async (s) => {
      // Fixture no application role may create: a GRC director cleared only to RESTRICTED.
      await s.asOwner();
      const lowCleared = randomUUID();
      await s.tx`insert into iam.user_profile (id, email, display_name, display_name_ar, department, status, clearance)
        values (${lowCleared}, ${`grc.low.${lowCleared.slice(0, 8)}@example.test`}, 'GRC Director Rho', 'مدير الحوكمة رو',
                'GRC (synthetic)', 'ACTIVE', 'RESTRICTED')`;
      await s.tx`insert into iam.user_role_assignment (user_id, role_code, justification, source_reference, status)
        values (${lowCleared}, 'GRC_DIRECTOR', 'Synthetic test fixture', 'TEST', 'ACTIVE')`;
      await accepted(s);
      const listed = await s.tx<{ user_id: string }[]>`
        select user_id from api.list_restricted_case_authorities(${report}, 'CONFIDENTIAL'::core.classification_level)`;
      expect(listed.map((r) => r.user_id)).not.toContain(lowCleared);
      await s.expectError(
        "CDF_INVALID:restricted_authority_id",
        (tx) =>
          tx`select api.create_case_from_report(${report}, ${TITLE}, ${SUMMARY},
          'CONFIDENTIAL'::core.classification_level, true, ${lowCleared}::uuid)`,
      );
    });
  });

  it("keeps classification at or below the initiator's clearance", async () => {
    await scenario(async (s) => {
      await accepted(s);
      await s.expectError(
        "CDF_INVALID:classification",
        (tx) =>
          tx`select api.create_case_from_report(${report}, ${TITLE}, ${SUMMARY},
          'SECRET'::core.classification_level, true, ${USERS.grcDirector}::uuid)`,
      );
    });
  });

  it("refuses an authority on a case that is not restricted", async () => {
    await scenario(async (s) => {
      await accepted(s);
      await s.expectError(
        "CDF_INVALID:restricted_authority_id",
        (tx) =>
          tx`select api.create_case_from_report(${report}, ${TITLE}, ${SUMMARY},
          'CONFIDENTIAL'::core.classification_level, false, ${USERS.grcDirector}::uuid)`,
      );
    });
  });
});

describe("no identity exposure (§22)", () => {
  it("the authority gets the case, not the reporter's identity", async () => {
    await scenario(async (s) => {
      await accepted(s);
      const caseId = await createRestricted(s, USERS.grcDirector);
      await s.as("grcDirector");
      // The vault stays unreachable; resolution still needs the approved, justified reveal flow.
      await s.expectError(
        "permission denied",
        (tx) => tx`select count(*) from protected_identity.reporter_identity`,
      );
      await s.expectError("CDF_", (tx) => tx`select api.resolve_reporter_identity(${caseId}, ${REASON})`);
    });
  });
});

describe("ordinary cases are unchanged until grant scope lands (S3)", () => {
  it("a non-restricted case still gives the initiator the TRIAGE grant", async () => {
    await ownerScenario(async (s) => {
      await accepted(s);
      const [row] = await s.tx<{ id: string }[]>`
        select api.create_case_from_report(${report}, ${TITLE}, ${SUMMARY},
          'CONFIDENTIAL'::core.classification_level, false) as id`;
      const f = await facts(s, row!.id);
      expect(f.case.isRestricted).toBe(false);
      expect(f.grants).toEqual([{ userId: USERS.triage }]);
      expect(f.events.map((e) => e.action)).not.toContain("CASE_HANDED_OVER");
    });
  });
});

describe("ambiguity register: clearance changes (CDF-205)", () => {
  it("T-AMB-148: lowering a staffed user's clearance removes their restricted access at once", async () => {
    await ownerScenario(async (s) => {
      await accepted(s);
      const caseId = await createRestricted(s, USERS.grcDirector);
      await s.as("grcDirector");
      await s.tx`select api.assign_case(${caseId}, ${USERS.investigatorA}, 'INVESTIGATOR', ${REASON})`;
      expect(await canView(s, "investigatorA", caseId)).toBe(true);
      expect((await s.tx`select id from case_mgmt.case_record where id = ${caseId}`).length).toBe(1);

      // The directory lowers the investigator's clearance below the case's classification (no session, no cache).
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'RESTRICTED' where id = ${USERS.investigatorA}`;
      expect(await canView(s, "investigatorA", caseId)).toBe(false);
      expect(await s.tx`select id from case_mgmt.case_record where id = ${caseId}`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.allegation where case_id = ${caseId}`).toEqual([]);
      const [opened] = await s.tx<{ v: boolean }[]>`select api.open_case(${caseId}) as v`;
      expect(opened!.v).toBe(false); // an audited denial, as for any case the user cannot see

      // The same holds for the authority who owns the case.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'RESTRICTED' where id = ${USERS.grcDirector}`;
      expect(await canView(s, "grcDirector", caseId)).toBe(false);
    });
  });
});

describe("lifting a restriction is not decided, so nobody can (CDF-206, AMB-234, DEC-AMB-012)", () => {
  const LEVEL = "Synthetic: reclassification within the restricted case.";

  it("T-AMB-145: a staffed Case Manager cannot lift the restriction, by false or by null", async () => {
    await ownerScenario(async (s) => {
      await accepted(s);
      const caseId = await createRestricted(s, USERS.grcDirector);
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${caseId}, ${USERS.caseManager}, 'CASE', ${REASON})`;
      await s.as("caseManager");
      expect(
        (await s.tx<{ p: boolean }[]>`select authz.has_permission('RESTRICTED_CASE_GRANT') as p`)[0]!.p,
      ).toBe(false);
      await s.expectError(
        "CDF_CONFLICT:RESTRICTION_LIFT_NOT_DECIDED",
        (tx) =>
          tx`select api.change_case_classification(${caseId}, 'CONFIDENTIAL'::core.classification_level, false, ${LEVEL})`,
      );
      // Null means "keep": the level changes, the restriction stays.
      await s.tx`select api.change_case_classification(${caseId}, 'RESTRICTED'::core.classification_level, null, ${LEVEL})`;
      const f = await facts(s, caseId);
      expect(f.case).toMatchObject({ isRestricted: true, classification: "RESTRICTED" });
      expect(f.events.filter((e) => e.action === "CLASSIFICATION_CHANGED").map((e) => e.metadata)).toEqual([
        expect.objectContaining({ restricted_from: true, restricted_to: true }),
      ]);
      // CASE_VIEW_ALL still does not reach it.
      expect(await canView(s, "grcDeputy", caseId)).toBe(false);
    });
  });

  it("T-AMB-145: the restricted-case authority who owns the case cannot lift it either", async () => {
    await ownerScenario(async (s) => {
      const exec = await caseId("0003"); // seed restricted SECRET case, owned by the GRC Director
      await s.as("grcDirector");
      expect(
        (await s.tx<{ p: boolean }[]>`select authz.has_permission('RESTRICTED_CASE_GRANT') as p`)[0]!.p,
      ).toBe(true);
      await s.expectError(
        "CDF_CONFLICT:RESTRICTION_LIFT_NOT_DECIDED",
        (tx) =>
          tx`select api.change_case_classification(${exec}, 'SECRET'::core.classification_level, false, ${LEVEL})`,
      );
      await s.tx`select api.change_case_classification(${exec}, 'SECRET'::core.classification_level, null, ${LEVEL})`;
      await s.asOwner();
      const [c] = await s.tx<
        { is_restricted: boolean }[]
      >`select is_restricted from case_mgmt.case_record where id = ${exec}`;
      expect(c!.is_restricted).toBe(true);
      expect(await canView(s, "caseManager", exec)).toBe(false);
    });
  });

  it("restricting still needs RESTRICTED_CASE_GRANT, and a non-restricted case keeps its status on null", async () => {
    await ownerScenario(async (s) => {
      const open = await caseId("0004");
      await s.as("caseManager");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.change_case_classification(${open}, 'CONFIDENTIAL'::core.classification_level, true, ${LEVEL})`,
      );
      await s.tx`select api.change_case_classification(${open}, 'CONFIDENTIAL'::core.classification_level, null, ${LEVEL})`;
      await s.asOwner();
      expect(
        (
          await s.tx<
            { r: boolean }[]
          >`select is_restricted as r from case_mgmt.case_record where id = ${open}`
        )[0]!.r,
      ).toBe(false);
      await s.as("grcDirector");
      await s.tx`select api.change_case_classification(${open}, 'CONFIDENTIAL'::core.classification_level, true, ${LEVEL})`;
      await s.asOwner();
      expect(
        (
          await s.tx<
            { r: boolean }[]
          >`select is_restricted as r from case_mgmt.case_record where id = ${open}`
        )[0]!.r,
      ).toBe(true);
      expect(await canView(s, "caseManager", open)).toBe(false);
    });
  });

  it("T-AMB-145: no other function writes is_restricted, and no application role may update it directly", async () => {
    const writers = await admin<{ fn: string }[]>`
      select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prokind = 'f' and n.nspname not in ('pg_catalog', 'information_schema')
        and pg_get_functiondef(p.oid) ~ 'is_restricted\\s*=' order by 1`;
    expect(writers.map((w) => w.fn)).toEqual(["api.change_case_classification"]);
    const updaters = await admin<{ grantee: string }[]>`
      select grantee from information_schema.column_privileges
      where table_schema = 'case_mgmt' and table_name = 'case_record' and column_name = 'is_restricted'
        and privilege_type = 'UPDATE' and grantee in ('anon', 'authenticated', 'service_role', 'cdf_bff', 'cdf_portal')`;
    expect(updaters).toEqual([]);
  });
});
