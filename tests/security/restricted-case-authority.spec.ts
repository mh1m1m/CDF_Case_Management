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
import { outcomes } from "../support/capabilities";

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

describe("reclassification never lifts a restriction; only the two-person lift does (CDF-206, AMB-234, DEC-AMB-012, 2130)", () => {
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

  it("T-AMB-145: only the two-person lift writes is_restricted besides reclassification, and no application role may update it directly", async () => {
    const writers = await admin<{ fn: string }[]>`
      select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prokind = 'f' and n.nspname not in ('pg_catalog', 'information_schema')
        and pg_get_functiondef(p.oid) ~ 'is_restricted\\s*=' order by 1`;
    // Condition (b) (AGENT-09, 012-C): exactly one new writer, the lift (2130), beside the reclassification that refuses
    // true → false.
    expect(writers.map((w) => w.fn)).toEqual(["api.change_case_classification", "api.lift_case_restriction"]);
    const updaters = await admin<{ grantee: string }[]>`
      select grantee from information_schema.column_privileges
      where table_schema = 'case_mgmt' and table_name = 'case_record' and column_name = 'is_restricted'
        and privilege_type = 'UPDATE' and grantee in ('anon', 'authenticated', 'service_role', 'cdf_bff', 'cdf_portal')`;
    expect(updaters).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2130 (ADR-049): the two-person lift. DEC-AMB-012 → C (Fady, 2026-10-13); AGENT-09's conditions 012-C (a)–(f); the
// coordinator's ruling of 2026-10-19 01:42 UTC on the nine design points.
// ---------------------------------------------------------------------------------------------------------------------
const LIFT_REASON = "Synthetic: the restriction is no longer needed.";
const DECISION_REASON = "Synthetic: the preview and the reason were checked.";
const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const GATES = [
  "CASE_VIEW_ALL",
  "BREAK_GLASS_REQUEST",
  "ARCHIVE_RECORD_VIEW",
  "PRELIMINARY_APPROVE",
  "LEGAL_HOLD_REQUEST",
  "GRIEVANCE_COMMITTEE_SECRETARY",
];

interface LiftPreview {
  classification: string;
  gates: { gate: string; users: number; roles: { role: string; users: number }[] }[];
  users_gaining: number;
  authority_approvals_ending: string[];
}
interface LiftQueueRow {
  id: string;
  status: string;
  reason: string;
  preview: LiftPreview;
  preview_hash: string;
  may_decide: boolean;
  approve_refusal: string | null;
  may_expire: boolean;
  lapsed: boolean;
  [key: string]: unknown;
}
interface LiftStatus {
  is_restricted: boolean;
  may_preview: boolean;
  may_request: boolean;
  request_refusal: string | null;
  approver_role: string | null;
  request: null | {
    id: string;
    status: string;
    lapsed: boolean;
    may_lift: boolean;
    lift_refusal: string | null;
    may_withdraw: boolean;
    may_expire: boolean;
    [key: string]: unknown;
  };
}

/** The second approver's role (null: SOURCE_REQUIRED, unset) and the window, as a migration would set them. */
async function liftSettings(s: OwnerScenario, role: string | null, windowHours = "24") {
  await s.asOwner();
  await s.tx`update config.setting
             set value = ${role}, status = ${role === null ? "SOURCE_REQUIRED" : "CONFIGURED"},
                 source_reference = ${role === null ? null : "Synthetic: test Delegation of Authority"}
             where key = 'RESTRICTION_LIFT_SECOND_APPROVER'`;
  await s.tx`update config.setting set value = ${windowHours} where key = 'RESTRICTION_LIFT_WINDOW_HOURS'`;
}

/** A fresh restricted CONFIDENTIAL case whose authority is the GRC Director; GRC_DIRECTOR gives the second approval,
 *  so the GRC Deputy is the one independent approver. */
async function liftableCase(s: OwnerScenario, role: string | null = "GRC_DIRECTOR"): Promise<string> {
  await liftSettings(s, role);
  await accepted(s);
  return createRestricted(s, USERS.grcDirector);
}

async function previewLift(s: OwnerScenario, user: UserKey, caseId: string) {
  await s.as(user);
  const [r] = await s.tx<{ p: { preview: LiftPreview; preview_hash: string } }[]>`
    select api.preview_restriction_lift(${caseId}) as p`;
  return r!.p;
}

async function requestLift(s: OwnerScenario, caseId: string): Promise<string> {
  const p = await previewLift(s, "grcDirector", caseId);
  const [r] = await s.tx<{ id: string }[]>`
    select api.request_restriction_lift(${caseId}, ${LIFT_REASON}, ${p.preview_hash}) as id`;
  return r!.id;
}

async function liftQueue(s: OwnerScenario, user: UserKey): Promise<LiftQueueRow[]> {
  await s.as(user);
  const [r] = await s.tx<{ q: LiftQueueRow[] }[]>`select api.my_restriction_lift_approvals() as q`;
  return r!.q;
}

async function liftStatus(s: OwnerScenario, user: UserKey, caseId: string): Promise<LiftStatus> {
  await s.as(user);
  const [r] = await s.tx<{ v: LiftStatus }[]>`select api.restriction_lift_status(${caseId}) as v`;
  return r!.v;
}

/** The approver decides on the preview their queue shows. */
async function decideLift(s: OwnerScenario, user: UserKey, request: string, decision = "APPROVE") {
  const row = (await liftQueue(s, user)).find((q) => q.id === request)!;
  const [r] = await s.tx<{ v: string }[]>`
    select api.decide_restriction_lift(${request}, ${decision}, ${DECISION_REASON}, ${row.preview_hash}) as v`;
  return r!.v;
}

const DECIDE = (request: string, hash: string, decision = "APPROVE") =>
  `select api.decide_restriction_lift('${request}', '${decision}', '${DECISION_REASON}', '${hash}')`;
const LIFT = (request: string) => `select api.lift_case_restriction('${request}')`;
const EXPIRE = (request: string) => `select api.expire_restriction_lift('${request}')`;
const WITHDRAW = (request: string) => `select api.withdraw_restriction_lift('${request}')`;
const REQUEST = (caseId: string, hash: string) =>
  `select api.request_restriction_lift('${caseId}', '${LIFT_REASON}', '${hash}')`;

/** Everyone who can open the case now (owner-side). */
async function viewers(s: OwnerScenario, caseId: string): Promise<string[]> {
  await s.asOwner();
  const rows = await s.tx<{ id: string }[]>`
    select u.id from iam.user_profile u where authz.user_can_view_case(u.id, ${caseId}) order by u.id`;
  return rows.map((r) => r.id);
}

/** Owner fixture: move a request's clock (the integrity trigger is off for the fixture only). */
async function age(s: OwnerScenario, request: string, column: "request" | "approval") {
  await s.asOwner();
  await s.tx`alter table case_mgmt.restriction_lift_request disable trigger restriction_lift_request_protect`;
  if (column === "request") {
    await s.tx`update case_mgmt.restriction_lift_request
               set requested_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = ${request}`;
  } else {
    await s.tx`update case_mgmt.restriction_lift_request
               set decided_at = now() - interval '2 days', approval_expires_at = now() - interval '1 day'
               where id = ${request}`;
  }
  await s.tx`alter table case_mgmt.restriction_lift_request enable trigger restriction_lift_request_protect`;
}

describe("the two-person lift of a restricted case (2130, ADR-049; DEC-AMB-012 C; T-AMB-145)", () => {
  it("T-AMB-145: the authority previews and requests, an independent approver approves that preview, and the authority lifts it; counts and role codes only, ids-only ledger and notices", async () => {
    await ownerScenario(async (s) => {
      const c = await liftableCase(s);
      const before = await viewers(s, c);
      expect(before).toEqual([USERS.grcDirector]);

      const p = await previewLift(s, "grcDirector", c);
      expect(Object.keys(p.preview).sort()).toEqual([
        "authority_approvals_ending",
        "classification",
        "gates",
        "users_gaining",
      ]);
      expect(p.preview.classification).toBe("CONFIDENTIAL");
      expect(p.preview.gates.map((g) => g.gate)).toEqual(GATES);
      // Who would gain the case file: the Case Manager and the GRC Deputy, as counts by role code.
      expect(p.preview.gates[0]).toEqual({
        gate: "CASE_VIEW_ALL",
        users: 2,
        roles: [
          { role: "CASE_MANAGER", users: 1 },
          { role: "GRC_DIRECTOR", users: 1 },
        ],
      });
      expect(p.preview.users_gaining).toBeGreaterThanOrEqual(2);
      // No names, user ids, case id or case number: counts and role codes only (condition d).
      expect(JSON.stringify(p)).not.toMatch(UUID_TEXT);
      expect(JSON.stringify(p)).not.toMatch(/CDF-(DEMO|CASE)-/);
      expect(JSON.stringify(p)).not.toMatch(/Zeta|Gamma|Mu\b/);

      expect(await liftStatus(s, "grcDirector", c)).toMatchObject({
        is_restricted: true,
        may_preview: true,
        may_request: true,
        request_refusal: null,
        approver_role: "GRC_DIRECTOR",
        request: null,
      });
      const [r] = await s.tx<{ id: string }[]>`
        select api.request_restriction_lift(${c}, ${LIFT_REASON}, ${p.preview_hash}) as id`;
      const request = r!.id;

      // The approver's queue: the reason and the preview, never the case id or number (DEC-22).
      const queue = await liftQueue(s, "grcDeputy");
      expect(queue).toHaveLength(1);
      expect(Object.keys(queue[0]!).sort()).toEqual([
        "approval_expires_at",
        "approve_refusal",
        "classification",
        "decided_by_me",
        "expires_at",
        "id",
        "lapsed",
        "may_decide",
        "may_expire",
        "preview",
        "preview_hash",
        "reason",
        "requested_at",
        "status",
      ]);
      expect(queue[0]).toMatchObject({
        id: request,
        status: "PENDING",
        classification: "CONFIDENTIAL",
        reason: LIFT_REASON,
        preview: p.preview,
        preview_hash: p.preview_hash,
        may_decide: true,
        approve_refusal: null,
        may_expire: false,
      });
      expect(JSON.stringify(queue)).not.toContain(c);
      expect(await decideLift(s, "grcDeputy", request)).toBe("APPROVED");
      // Approving gives the approver nothing on the case.
      expect(await canView(s, "grcDeputy", c)).toBe(false);

      // Reclassification still refuses true → false after the approval (condition a).
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:RESTRICTION_LIFT_NOT_DECIDED",
        (tx) =>
          tx`select api.change_case_classification(${c}, 'CONFIDENTIAL'::core.classification_level, false, ${LIFT_REASON})`,
      );
      const ready = await liftStatus(s, "grcDirector", c);
      expect(ready.request).toMatchObject({
        id: request,
        status: "APPROVED",
        may_lift: true,
        lift_refusal: null,
      });
      expect(ready).toMatchObject({ may_request: false, request_refusal: "LIFT_ALREADY_REQUESTED" });

      await s.tx`select api.lift_case_restriction(${request})`;
      const f = await facts(s, c);
      expect(f.case.isRestricted).toBe(false);
      // Exactly the population the CASE_VIEW_ALL gate previewed now opens the case.
      const gained = (await viewers(s, c)).filter((u) => !before.includes(u));
      expect(gained.sort()).toEqual([USERS.caseManager, USERS.grcDeputy].sort());
      // The approval is consumed with the lift: a replay is refused.
      expect(await outcomes(s, "grcDirector", { replay: LIFT(request) })).toEqual({
        replay: "CDF_CONFLICT:APPROVAL_CONSUMED",
      });

      // The ledger: ids, decision codes, the hash and the classification; never a reason (condition e).
      const lift = f.events.filter((e) => e.action.startsWith("RESTRICTION_LIFT"));
      expect(lift.map((e) => e.action)).toEqual([
        "RESTRICTION_LIFT_PREVIEWED",
        "RESTRICTION_LIFT_REQUESTED",
        "RESTRICTION_LIFT_APPROVED",
        "RESTRICTION_LIFTED",
      ]);
      expect(lift.map((e) => e.actorId)).toEqual([
        USERS.grcDirector,
        USERS.grcDirector,
        USERS.grcDeputy,
        USERS.grcDirector,
      ]);
      expect(lift[3]!.metadata).toEqual({
        classification: "CONFIDENTIAL",
        approved_by: USERS.grcDeputy,
        preview_hash: p.preview_hash,
        restricted_from: true,
        restricted_to: false,
      });
      await s.asOwner();
      const [withReason] = await s.tx<{ reasons: number }[]>`
        select count(*)::int as reasons from audit.audit_event
        where case_id = ${c} and action like 'RESTRICTION_LIFT%' and reason is not null`;
      expect(withReason!.reasons).toBe(0);
      expect(JSON.stringify(lift)).not.toContain("Synthetic:");

      // Notices: the approver is asked, the requester is told; ids and the deep link only.
      const notices = await s.tx<
        { template_code: string; recipient_id: string; row: Record<string, unknown> }[]
      >`
        select template_code, recipient_id, to_jsonb(o) as row from notify.outbox o
        where object_id = ${request} order by template_code, channel`;
      expect(notices.map((n) => [n.template_code, n.recipient_id, n.row.channel])).toEqual([
        ["RESTRICTION_LIFT_APPROVAL_REQUESTED", USERS.grcDeputy, "EMAIL"],
        ["RESTRICTION_LIFT_APPROVAL_REQUESTED", USERS.grcDeputy, "IN_APP"],
        ["RESTRICTION_LIFT_DECIDED", USERS.grcDirector, "EMAIL"],
        ["RESTRICTION_LIFT_DECIDED", USERS.grcDirector, "IN_APP"],
      ]);
      for (const n of notices) {
        expect(n.row).toMatchObject({
          object_type: "RESTRICTION_LIFT",
          deep_link: `/restriction-lifts/${request}`,
        });
        expect(JSON.stringify(n.row)).not.toContain("Synthetic:");
      }
    });
  });

  it("T-AMB-145: nothing can be requested until the second approver's role is configured and in force (SOURCE_REQUIRED), within a valid window, with an independent approver", async () => {
    await ownerScenario(async (s) => {
      const c = await liftableCase(s, null);
      const hash = (await previewLift(s, "grcDirector", c)).preview_hash;
      const refused = async (code: string) => {
        expect(await outcomes(s, "grcDirector", { request: REQUEST(c, hash) })).toEqual({
          request: `CDF_CONFLICT:${code}`,
        });
        expect(await liftStatus(s, "grcDirector", c)).toMatchObject({
          may_request: false,
          request_refusal: code,
        });
      };
      // Unset (the default): no lift.
      await refused("LIFT_APPROVER_NOT_CONFIGURED");
      expect((await liftStatus(s, "grcDirector", c)).approver_role).toBeNull();
      // A technical or administrative role, an unknown code, or a role nobody holds reads as unset (§21).
      for (const role of ["PLATFORM_ADMIN", "DB_ADMIN", "SOC_ANALYST", "NO_SUCH_ROLE", "COMPLIANCE"]) {
        await liftSettings(s, role);
        await refused("LIFT_APPROVER_NOT_CONFIGURED");
      }
      // A window that is not a whole number of hours from 1 to 720.
      for (const hours of ["0", "721", "abc", "1.5"]) {
        await liftSettings(s, "GRC_DIRECTOR", hours);
        await refused("LIFT_WINDOW_MISCONFIGURED");
      }
      // The only other holder of the role is on the case team: nobody independent could approve.
      await liftSettings(s, "GRC_DIRECTOR");
      await s.tx`insert into case_mgmt.case_assignment (case_id, user_id, assignment_role, reason, assigned_by)
                 values (${c}, ${USERS.grcDeputy}, 'REVIEWER', 'Synthetic: on the team.', ${USERS.grcDirector})`;
      await refused("NO_ELIGIBLE_APPROVER");
      // A role whose holder is not cleared for the case: the seed SECRET case and a CONFIDENTIAL approver.
      const exec = await caseId("0003");
      await liftSettings(s, "COMPLIANCE_SECTION_MANAGER");
      const secret = (await previewLift(s, "grcDirector", exec)).preview_hash;
      expect(await outcomes(s, "grcDirector", { request: REQUEST(exec, secret) })).toEqual({
        request: "CDF_CONFLICT:NO_ELIGIBLE_APPROVER",
      });
      await s.asOwner();
      expect(await s.tx`select id from case_mgmt.restriction_lift_request`).toEqual([]);
    });
  });

  it("T-AMB-145: no user approves their own second approval; the case's authority never approves; the approver decides once and never lifts; a handover leaves the request unusable", async () => {
    await ownerScenario(async (s) => {
      const c = await liftableCase(s);
      const request = await requestLift(s, c);
      const hash = (await liftQueue(s, "grcDeputy"))[0]!.preview_hash;
      // The requester (the case's authority, who holds the approver role too) is not in the queue and is refused.
      expect(await liftQueue(s, "grcDirector")).toEqual([]);
      expect(
        await outcomes(s, "grcDirector", {
          approve: DECIDE(request, hash),
          reject: DECIDE(request, hash, "REJECT"),
        }),
      ).toEqual({
        approve: "CDF_CONFLICT:REQUESTER_CANNOT_APPROVE",
        reject: "CDF_CONFLICT:REQUESTER_CANNOT_APPROVE",
      });
      expect(await outcomes(s, "grcDirector", { lift: LIFT(request) })).toEqual({
        lift: "CDF_CONFLICT:NOT_APPROVED",
      });
      // The approver decides once and never lifts or withdraws.
      expect(await decideLift(s, "grcDeputy", request)).toBe("APPROVED");
      expect(
        await outcomes(s, "grcDeputy", {
          again: DECIDE(request, hash),
          reject: DECIDE(request, hash, "REJECT"),
          lift: LIFT(request),
          withdraw: WITHDRAW(request),
        }),
      ).toEqual({
        again: "CDF_CONFLICT:ALREADY_DECIDED",
        reject: "CDF_CONFLICT:ALREADY_DECIDED",
        lift: "CDF_FORBIDDEN",
        withdraw: "CDF_FORBIDDEN",
      });
      await s.as("grcDirector");
      await s.tx`select api.withdraw_restriction_lift(${request})`;

      // A handover: the GRC Deputy becomes the case's owner and authority.
      const second = await requestLift(s, c);
      await s.asOwner();
      const [owner] = await s.tx<{ id: string }[]>`
        select id from case_mgmt.case_assignment where case_id = ${c} and assignment_role = 'CASE_OWNER' and status = 'ACTIVE'`;
      await s.as("grcDirector");
      await s.tx`select api.reassign_case(${owner!.id}, ${USERS.grcDeputy}, 'Synthetic: authority handover.')`;
      // The new authority never gives the second approval, and cannot lift a request they did not make.
      expect(await outcomes(s, "grcDeputy", { approve: DECIDE(second, hash), lift: LIFT(second) })).toEqual({
        approve: "CDF_CONFLICT:RCA_CANNOT_APPROVE",
        lift: "CDF_FORBIDDEN",
      });
      expect((await liftStatus(s, "grcDeputy", c)).request).toMatchObject({
        id: second,
        may_lift: false,
        lift_refusal: "FORBIDDEN",
        may_withdraw: false,
      });
      // The former authority, now holding only the approver role, still never approves their own request, and no
      // longer lifts it; they may withdraw it.
      expect(await outcomes(s, "grcDirector", { approve: DECIDE(second, hash), lift: LIFT(second) })).toEqual(
        { approve: "CDF_CONFLICT:REQUESTER_CANNOT_APPROVE", lift: "CDF_FORBIDDEN" },
      );
      // Owner fixture: the new owner's assignment ends. Off the team and holding the role, the case's owner is still
      // never an approver.
      await s.asOwner();
      await s.tx`update case_mgmt.case_assignment set status = 'ENDED', ended_at = now()
                 where case_id = ${c} and user_id = ${USERS.grcDeputy} and status = 'ACTIVE'`;
      expect(await liftQueue(s, "grcDeputy")).toEqual([]);
      expect(await outcomes(s, "grcDeputy", { approve: DECIDE(second, hash) })).toEqual({
        approve: "CDF_NOT_FOUND",
      });
      await s.as("grcDirector");
      await s.tx`select api.withdraw_restriction_lift(${second})`;
      const f = await facts(s, c);
      expect(f.case.isRestricted).toBe(true);
      expect(f.events.filter((e) => e.action === "RESTRICTION_LIFT_WITHDRAWN").map((e) => e.actorId)).toEqual(
        [USERS.grcDirector, USERS.grcDirector],
      );
    });
  });

  it("T-AMB-145: the second approver must be cleared, unconflicted and off the case team, when deciding and again at the lift", async () => {
    await ownerScenario(async (s) => {
      const c = await liftableCase(s);
      const request = await requestLift(s, c);
      const hash = (await liftQueue(s, "grcDeputy"))[0]!.preview_hash;
      // Clearance below the case's classification: not an approver, NOT_FOUND.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'RESTRICTED' where id = ${USERS.grcDeputy}`;
      expect(await liftQueue(s, "grcDeputy")).toEqual([]);
      expect(await outcomes(s, "grcDeputy", { approve: DECIDE(request, hash) })).toEqual({
        approve: "CDF_NOT_FOUND",
      });
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET' where id = ${USERS.grcDeputy}`;
      // On the case team.
      const [team] = await s.tx<{ id: string }[]>`
        insert into case_mgmt.case_assignment (case_id, user_id, assignment_role, reason, assigned_by)
        values (${c}, ${USERS.grcDeputy}, 'REVIEWER', 'Synthetic: on the team.', ${USERS.grcDirector}) returning id`;
      expect(await liftQueue(s, "grcDeputy")).toEqual([]);
      expect(await outcomes(s, "grcDeputy", { approve: DECIDE(request, hash) })).toEqual({
        approve: "CDF_NOT_FOUND",
      });
      await s.asOwner();
      await s.tx`update case_mgmt.case_assignment set status = 'ENDED', ended_at = now() where id = ${team!.id}`;
      // A declared conflict on the case.
      const [conflict] = await s.tx<{ id: string }[]>`
        insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
        values (${c}, ${USERS.grcDeputy}, 'CONFLICT_DECLARED', 'Synthetic: a declared conflict.') returning id`;
      expect(await liftQueue(s, "grcDeputy")).toEqual([]);
      expect(await outcomes(s, "grcDeputy", { approve: DECIDE(request, hash) })).toEqual({
        approve: "CDF_NOT_FOUND",
      });
      await s.asOwner();
      await s.tx`update case_mgmt.conflict_check set is_current = false where id = ${conflict!.id}`;

      // Eligible again: the approval is given; then the approver declares a conflict before the lift (condition c).
      expect(await decideLift(s, "grcDeputy", request)).toBe("APPROVED");
      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${c}, ${USERS.grcDeputy}, 'CONFLICT_DECLARED', 'Synthetic: declared after approving.')`;
      expect(await outcomes(s, "grcDirector", { lift: LIFT(request) })).toEqual({
        lift: "CDF_CONFLICT:APPROVER_NOT_ELIGIBLE",
      });
      expect((await liftStatus(s, "grcDirector", c)).request).toMatchObject({
        may_lift: false,
        lift_refusal: "APPROVER_NOT_ELIGIBLE",
      });
      expect((await facts(s, c)).case.isRestricted).toBe(true);
    });
  });

  it("T-AMB-145: a request and an approval lapse, are expired with an audit event, and an approval is used once", async () => {
    await ownerScenario(async (s) => {
      const c = await liftableCase(s);
      const request = await requestLift(s, c);
      expect(await outcomes(s, "grcDirector", { expire: EXPIRE(request) })).toEqual({
        expire: "CDF_CONFLICT:NOT_LAPSED",
      });
      expect(await decideLift(s, "grcDeputy", request)).toBe("APPROVED");
      // The approval lapses unused.
      await age(s, request, "approval");
      expect(await outcomes(s, "grcDirector", { lift: LIFT(request) })).toEqual({
        lift: "CDF_CONFLICT:APPROVAL_LAPSED",
      });
      expect((await liftStatus(s, "grcDirector", c)).request).toMatchObject({
        lapsed: true,
        may_lift: false,
        lift_refusal: "APPROVAL_LAPSED",
        may_expire: true,
      });
      expect((await liftQueue(s, "grcDeputy"))[0]).toMatchObject({
        lapsed: true,
        may_expire: true,
        may_decide: false,
      });
      await s.as("grcDeputy");
      await s.tx`select api.expire_restriction_lift(${request})`;
      expect(
        await outcomes(s, "grcDirector", {
          again: EXPIRE(request),
          lift: LIFT(request),
          withdraw: WITHDRAW(request),
        }),
      ).toEqual({
        again: "CDF_CONFLICT:REQUEST_CLOSED",
        lift: "CDF_CONFLICT:NOT_APPROVED",
        withdraw: "CDF_CONFLICT:REQUEST_CLOSED",
      });

      // A pending request lapses too; the approver is refused, and the next request ends it first.
      const pending = await requestLift(s, c);
      await age(s, pending, "request");
      const hash = (await liftQueue(s, "grcDeputy"))[0]!.preview_hash;
      expect(await outcomes(s, "grcDeputy", { approve: DECIDE(pending, hash) })).toEqual({
        approve: "CDF_CONFLICT:REQUEST_LAPSED",
      });
      expect(await liftStatus(s, "grcDirector", c)).toMatchObject({
        may_request: true,
        request_refusal: null,
      });
      const fresh = await requestLift(s, c);
      await s.asOwner();
      const states = await s.tx<{ id: string; status: string; ended_by: string | null }[]>`
        select id, status, ended_by from case_mgmt.restriction_lift_request where case_id = ${c}
        order by requested_at, status`;
      expect(states).toEqual([
        { id: pending, status: "EXPIRED", ended_by: USERS.grcDirector },
        { id: request, status: "EXPIRED", ended_by: USERS.grcDeputy },
        { id: fresh, status: "PENDING", ended_by: null },
      ]);

      // Used once: lifted, restricted again, and the consumed approval lifts nothing.
      expect(await decideLift(s, "grcDeputy", fresh)).toBe("APPROVED");
      await s.as("grcDirector");
      await s.tx`select api.lift_case_restriction(${fresh})`;
      await s.tx`select api.change_case_classification(${c}, 'CONFIDENTIAL'::core.classification_level, true, ${LIFT_REASON})`;
      expect(await outcomes(s, "grcDirector", { reuse: LIFT(fresh) })).toEqual({
        reuse: "CDF_CONFLICT:APPROVAL_CONSUMED",
      });
      const f = await facts(s, c);
      expect(f.case.isRestricted).toBe(true);
      expect(f.events.filter((e) => e.action === "RESTRICTION_LIFT_EXPIRED").map((e) => e.metadata)).toEqual([
        expect.objectContaining({ classification: "CONFIDENTIAL", approved: true }),
        expect.objectContaining({ classification: "CONFIDENTIAL", approved: false }),
      ]);
    });
  });

  it("T-AMB-145: an export waiting for the authority's consent blocks the request, the approval and the lift (nothing stranded)", async () => {
    await ownerScenario(async (s) => {
      const c = await liftableCase(s);
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${c}, ${USERS.caseManager}, 'CASE', ${REASON})`;
      // The staffed Case Manager submits an internal export of the case; it waits for the authority's consent.
      const exportAwaiting = async () => {
        await s.as("caseManager");
        const [q] = await s.tx<{ id: string }[]>`
          select api.create_export_request(${c}, 'PDF', 'INTERNAL', 'INTERNAL_MANAGEMENT_REVIEW', null, null) as id`;
        await s.tx`select api.add_export_item(${q!.id}, 'CASE_SUMMARY', ${c})`;
        const [p] = await s.tx<{ p: { hash: string } }[]>`select api.preview_export(${q!.id}) as p`;
        await s.tx`select api.submit_export(${q!.id}, ${p!.p.hash}, 'CONFIDENTIAL'::core.classification_level)`;
        return q!.id;
      };
      const consent = async (exportId: string, decision: string) => {
        await s.as("grcDirector");
        const [p] = await s.tx<{ p: { hash: string } }[]>`select api.preview_export(${exportId}) as p`;
        await s.tx`select api.decide_restricted_export(${exportId}, ${decision}, ${REASON}, ${p!.p.hash})`;
      };
      const first = await exportAwaiting();
      const hash = (await previewLift(s, "grcDirector", c)).preview_hash;
      expect(await outcomes(s, "grcDirector", { request: REQUEST(c, hash) })).toEqual({
        request: "CDF_CONFLICT:RESTRICTED_APPROVALS_PENDING",
      });
      expect(await liftStatus(s, "grcDirector", c)).toMatchObject({
        may_request: false,
        request_refusal: "RESTRICTED_APPROVALS_PENDING",
      });
      await consent(first, "APPROVE");
      const request = await requestLift(s, c);
      // Another export waits: the approval is refused (a rejection is not).
      const second = await exportAwaiting();
      const row = (await liftQueue(s, "grcDeputy"))[0]!;
      expect(row).toMatchObject({ may_decide: true, approve_refusal: "RESTRICTED_APPROVALS_PENDING" });
      expect(await outcomes(s, "grcDeputy", { approve: DECIDE(request, row.preview_hash) })).toEqual({
        approve: "CDF_CONFLICT:RESTRICTED_APPROVALS_PENDING",
      });
      await consent(second, "REJECT");
      expect(await decideLift(s, "grcDeputy", request)).toBe("APPROVED");
      // And again before the lift.
      const third = await exportAwaiting();
      expect(await outcomes(s, "grcDirector", { lift: LIFT(request) })).toEqual({
        lift: "CDF_CONFLICT:RESTRICTED_APPROVALS_PENDING",
      });
      await consent(third, "REJECT");
      await s.as("grcDirector");
      await s.tx`select api.lift_case_restriction(${request})`;
      expect((await facts(s, c)).case.isRestricted).toBe(false);
    });
  });

  it("T-AMB-145: the preview is bound at the request, the approval and the lift (PREVIEW_CHANGED)", async () => {
    await ownerScenario(async (s) => {
      const c = await liftableCase(s);
      expect(await outcomes(s, "grcDirector", { request: REQUEST(c, "0".repeat(64)) })).toEqual({
        request: "CDF_CONFLICT:PREVIEW_CHANGED",
      });
      const request = await requestLift(s, c);
      // Someone new would gain the case: a CASE_VIEW_ALL role for Investigator Beta.
      const grantRole = async () => {
        await s.asOwner();
        const [a] = await s.tx<{ id: string }[]>`
          insert into iam.user_role_assignment (user_id, role_code, justification)
          values (${USERS.investigatorB}, 'CASE_MANAGER', 'Synthetic: preview probe.') returning id`;
        return a!.id;
      };
      const endRole = async (id: string) => {
        await s.asOwner();
        await s.tx`update iam.user_role_assignment set status = 'REVOKED', revoked_at = now() where id = ${id}`;
      };
      let role = await grantRole();
      const row = (await liftQueue(s, "grcDeputy"))[0]!;
      expect(row).toMatchObject({ approve_refusal: "PREVIEW_CHANGED" });
      expect(await outcomes(s, "grcDeputy", { approve: DECIDE(request, row.preview_hash) })).toEqual({
        approve: "CDF_CONFLICT:PREVIEW_CHANGED",
      });
      await endRole(role);
      expect(await decideLift(s, "grcDeputy", request)).toBe("APPROVED");
      role = await grantRole();
      expect(await outcomes(s, "grcDirector", { lift: LIFT(request) })).toEqual({
        lift: "CDF_CONFLICT:PREVIEW_CHANGED",
      });
      expect((await liftStatus(s, "grcDirector", c)).request).toMatchObject({
        lift_refusal: "PREVIEW_CHANGED",
      });
      // The requester withdraws the unusable approval and may ask again on the new preview.
      await s.as("grcDirector");
      await s.tx`select api.withdraw_restriction_lift(${request})`;
      expect(await liftStatus(s, "grcDirector", c)).toMatchObject({ may_request: true });
      await endRole(role);
    });
  });

  it("T-AMB-145: request ids answer NOT_FOUND outside the request, the case's commands answer NOT_FOUND or FORBIDDEN outside its authority, and nobody else lifts", async () => {
    await ownerScenario(async (s) => {
      const c = await liftableCase(s);
      const request = await requestLift(s, c);
      const hash = (await liftQueue(s, "grcDeputy"))[0]!.preview_hash;
      const stranger = randomUUID();
      const byRequest = (id: string) => ({
        decide: DECIDE(id, hash),
        lift: LIFT(id),
        expire: EXPIRE(id),
        withdraw: WITHDRAW(id),
      });
      const byCase = {
        preview: `select api.preview_restriction_lift('${c}')`,
        request: REQUEST(c, hash),
        status: `select api.restriction_lift_status('${c}')`,
      };
      const all = (v: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, v]));
      // Someone who cannot see the case.
      expect(await outcomes(s, "investigatorA", { ...byRequest(request), ...byCase })).toEqual(
        all("CDF_NOT_FOUND", ["decide", "lift", "expire", "withdraw", "preview", "request", "status"]),
      );
      expect(await outcomes(s, "investigatorA", byRequest(stranger))).toEqual(
        all("CDF_NOT_FOUND", ["decide", "lift", "expire", "withdraw"]),
      );
      // A staffed Case Manager: sees the case, may reclassify it, but is not its authority (lift without permission).
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${c}, ${USERS.caseManager}, 'CASE', ${REASON})`;
      expect(await outcomes(s, "caseManager", { ...byRequest(request), ...byCase })).toEqual({
        ...all("CDF_NOT_FOUND", ["decide", "lift", "expire", "withdraw"]),
        ...all("CDF_FORBIDDEN", ["preview", "request", "status"]),
      });
      expect(await liftQueue(s, "caseManager")).toEqual([]);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:RESTRICTION_LIFT_NOT_DECIDED",
        (tx) =>
          tx`select api.change_case_classification(${c}, 'CONFIDENTIAL'::core.classification_level, false, ${LIFT_REASON})`,
      );
      // The authority's random id is NOT_FOUND too.
      expect(await outcomes(s, "grcDirector", byRequest(stranger))).toEqual(
        all("CDF_NOT_FOUND", ["decide", "lift", "expire", "withdraw"]),
      );
    });
  });

  it("the request table moves forward only, is never deleted, and no application role reads or writes it", async () => {
    await ownerScenario(async (s) => {
      const c = await liftableCase(s);
      const request = await requestLift(s, c);
      await s.as("grcDirector");
      await s.expectError("permission denied", (tx) => tx`select id from case_mgmt.restriction_lift_request`);
      await s.expectError(
        "permission denied",
        (tx) => tx`update case_mgmt.restriction_lift_request set status = 'WITHDRAWN' where id = ${request}`,
      );
      await s.asOwner();
      await s.expectError(
        "restriction lift request",
        (tx) =>
          tx`update case_mgmt.restriction_lift_request set reason = 'Synthetic: rewritten.' where id = ${request}`,
      );
      expect(await decideLift(s, "grcDeputy", request)).toBe("APPROVED");
      await s.asOwner();
      await s.expectError(
        "restriction lift request",
        (tx) => tx`update case_mgmt.restriction_lift_request set status = 'PENDING' where id = ${request}`,
      );
      await s.expectError(
        "restriction lift request",
        (tx) =>
          tx`update case_mgmt.restriction_lift_request set status = 'LIFTED', lifted_by = ${USERS.grcDirector},
               lifted_at = now(), decision_reason = 'Synthetic: changed too.' where id = ${request}`,
      );
      await s.expectError(
        "case_mgmt.restriction_lift_request is append-only",
        (tx) => tx`delete from case_mgmt.restriction_lift_request where id = ${request}`,
      );
      // No user approves their own request, whatever writes the row.
      await s.expectError(
        "new row for relation",
        (tx) =>
          tx`insert into case_mgmt.restriction_lift_request (case_id, classification, requested_by, reason, preview,
               preview_hash, expires_at, status, decided_by, decided_at, decision_reason)
             values (${c}, 'CONFIDENTIAL', ${USERS.grcDirector}, 'Synthetic: probe.', '{}', ${"a".repeat(64)},
               now() + interval '1 hour', 'REJECTED', ${USERS.grcDirector}, now(), 'Synthetic: probe.')`,
      );
    });
  });
});
