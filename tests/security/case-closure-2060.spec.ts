// Rebase PR-B, migration 2060 (ADR-042): the case outcome and closure (DEC-F39, DEC-F40; AMB-146, AMB-212 to AMB-217;
// CON-022) and AGENT-09's three closure rulings (coordinator, 2026-10-14 22:19): R1, only a closure the commands record
// in this transaction lets a case leave ACTIVE once the closure authority is configured; R2, the closure blockers are
// shown only to those who may take the step; R3, the maker never decides, and a closure authority that is technical,
// PLATFORM_ADMIN, DB_ADMIN, unknown or held by nobody active reads as unset. Reopening (DEC-AMB-002, DEC-AMB-015) is
// tested in workflow-bypass (T-AMB-131), recommendations-authority (the decisive conflict) and records-disposition
// (REC-T27). CASE_CLOSURE_APPROVAL_RULE is SOURCE_REQUIRED; tests that need it set a synthetic value on the owner
// connection, rolled back.
import { beforeAll, describe, expect, it } from "vitest";
import {
  USERS,
  admin,
  caseId,
  ownerScenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import { REASON as COMMITTEE_REASON, closeAsBefore2117, committeeIds } from "../support/committee";
import {
  DECIDE_REASON,
  RATIONALE,
  closeWith,
  concludeProceedings,
  requestReopeningOnEvidence,
  setClosureAuthority,
} from "../support/closure";
import { decidedForSubjects, draftPackage, voteOnPackage } from "../support/decision";
import { decisionNotice, oldDeliveryNotice, recordDelivery } from "../support/grievance";

let caseA: string, caseB: string, ic: string, gc: string;

beforeAll(async () => {
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
  ({ ic, gc } = await committeeIds());
});

const close = (tx: Scenario["tx"], id: string, outcome: string | null = "NO_ACTION", rationale = RATIONALE) =>
  tx<{ r: string }[]>`select api.close_case(${id}, ${outcome}, ${rationale}) as r`;
const decide = (tx: Scenario["tx"], request: string, decision: string, reason = DECIDE_REASON) =>
  tx<{ r: string }[]>`select api.decide_case_closure(${request}, ${decision}, ${reason}) as r`;
const screenOut = (tx: Scenario["tx"], id: string) =>
  tx`select api.transition_case(${id}, 'SCREEN_OUT', 'Synthetic: screened out directly.')`;

interface ClosureView {
  records_state: string;
  closure_authority_configured: boolean;
  closure_blocks: string[] | null;
  closures: {
    closure_no: number;
    outcome_code: string;
    path: string;
    transition_code: string;
    closed_by: string;
  }[];
  closure_requests: { status: string; requested_by: string; decided_by: string | null }[];
  reopening_requests: { reason_type: string; status: string }[] | null;
}
async function view(s: Scenario, id: string): Promise<ClosureView> {
  const [r] = await s.tx<{ v: ClosureView }[]>`select api.case_closure_view(${id}) as v`;
  return r!.v;
}
async function state(s: OwnerScenario, id: string) {
  await s.asOwner();
  const [r] = await s.tx<{ records_state: string; current_state: string }[]>`
    select c.records_state, i.current_state from case_mgmt.case_record c
    join workflow.workflow_instance i on i.case_id = c.id where c.id = ${id}`;
  return r!;
}
async function events(s: OwnerScenario, id: string) {
  await s.asOwner();
  return s.tx<
    { action: string; actor_id: string; reason: string | null; metadata: Record<string, unknown> }[]
  >`
    select action, actor_id, reason, metadata from audit.audit_event
    where case_id = ${id} and action like 'CASE_CLOSURE_%' order by seq`;
}
async function pendingRequest(s: OwnerScenario, id: string): Promise<string> {
  await s.asOwner();
  const [r] = await s.tx<{ id: string }[]>`
    select id from case_mgmt.case_closure_request where case_id = ${id} and status = 'AWAITING_APPROVAL'`;
  return r!.id;
}
const SCREEN_OUT_REASONS = async (s: Scenario, id: string) => {
  const [t] = await s.tx<{ allowed: boolean; blocking_reasons: string[] }[]>`
    select allowed, blocking_reasons from api.available_transitions(${id}) where code = 'SCREEN_OUT'`;
  return t!;
};

/** AGENT-09 R2: case B's viewers without the closure entitlement learn only that they lack it, never that a grievance
 *  window is running or a decision is not final. */
async function expectNoBlockLeak(s: Scenario) {
  for (const user of ["investigatorB", "triage", "grcDirector"] as UserKey[]) {
    await s.as(user);
    expect(await SCREEN_OUT_REASONS(s, caseB), user).toEqual({
      allowed: false,
      blocking_reasons: ["MISSING_PERMISSION"],
    });
    expect((await view(s, caseB)).closure_blocks, user).toBeNull();
  }
}

describe("the case outcome catalogue and the settings (DEC-F39, AMB-212, AMB-214, AMB-216)", () => {
  it("outcomes are the CRM closure statuses' OUTCOME_CODE values, reference data nobody edits; the three settings are SOURCE_REQUIRED", async () => {
    const outcomes = await admin<{ code: string; is_active: boolean; in_catalogue: boolean }[]>`
      select o.code, o.is_active,
             exists (select 1 from config.status_code c where c.dimension = 'OUTCOME_CODE' and c.code = o.code) as in_catalogue
      from case_mgmt.case_outcome_code o order by o.code collate "C"`;
    expect(outcomes).toHaveLength(15);
    expect(outcomes.every((o) => o.in_catalogue)).toBe(true);
    expect(outcomes.filter((o) => !o.is_active).map((o) => o.code)).toEqual(["EMERGENCY_CLOSURE"]);
    const settings = await admin<{ key: string; value: string | null; status: string }[]>`
      select key, value, status from config.setting
      where key in ('CASE_CLOSURE_APPROVAL_RULE', 'CONDITIONAL_CLOSURE_AUTHORITY', 'CASE_OUTCOME_CATALOGUE')
      order by key collate "C"`;
    expect(settings).toEqual([
      { key: "CASE_CLOSURE_APPROVAL_RULE", value: null, status: "SOURCE_REQUIRED" },
      { key: "CASE_OUTCOME_CATALOGUE", value: null, status: "SOURCE_REQUIRED" },
      { key: "CONDITIONAL_CLOSURE_AUTHORITY", value: null, status: "SOURCE_REQUIRED" },
    ]);
    await ownerScenario(async (s) => {
      await s.as("platformAdmin");
      expect((await s.tx`select code from case_mgmt.case_outcome_code`).length).toBe(15);
      for (const run of [
        (tx: Scenario["tx"]) => tx`update case_mgmt.case_outcome_code set is_active = true`,
        (tx: Scenario["tx"]) =>
          tx`insert into case_mgmt.case_outcome_code (code, legacy_codes, is_active) values ('NO_ACTION', '{S053}', true)`,
        (tx: Scenario["tx"]) =>
          tx`update config.setting set status = 'CONFIGURED' where key = 'CASE_CLOSURE_APPROVAL_RULE'`,
      ]) {
        await s.expectError("permission denied", run);
      }
      await s.asOwner();
      await s.expectError(
        "",
        (tx) => tx`update case_mgmt.case_outcome_code set is_active = true where code = 'EMERGENCY_CLOSURE'`,
      );
      await s.expectError("", (tx) => tx`delete from case_mgmt.case_outcome_code where code = 'NO_ACTION'`);
    });
  });
});

describe("closing a case (DEC-F40) while the closure authority is SOURCE_REQUIRED", () => {
  it("T-AMB-127: the case manager closes with an outcome; nobody without the closure entitlement closes, on any path", async () => {
    await ownerScenario(async (s) => {
      // Who sees the case but holds no WORKFLOW_ADVANCE is refused; who cannot see it gets NOT_FOUND.
      for (const user of ["triage", "investigatorB", "grcDirector", "grcDeputy"] as UserKey[]) {
        await s.as(user);
        await s.expectError("CDF_FORBIDDEN", (tx) => close(tx, caseB));
        await s.expectError("CDF_", (tx) => screenOut(tx, caseB));
      }
      for (const user of [
        "investigatorA",
        "platformAdmin",
        "soc",
        "internalAudit",
        "committee",
      ] as UserKey[]) {
        await s.as(user);
        await s.expectError("CDF_NOT_FOUND", (tx) => close(tx, caseB));
      }
      // The outcome comes from the catalogue (an inactive one is refused), with a rationale.
      await s.as("caseManager");
      await s.expectError("CDF_INVALID:outcome_code", (tx) => close(tx, caseB, null));
      await s.expectError("CDF_INVALID:outcome_code", (tx) => close(tx, caseB, "SUBSTANTIATED"));
      await s.expectError("CDF_INVALID:outcome_code", (tx) => close(tx, caseB, "EMERGENCY_CLOSURE"));
      await s.expectError("CDF_INVALID:rationale", (tx) => close(tx, caseB, "NO_ACTION", "short"));
      // No step into CLOSURE from the investigation (the phase 9/10 steps are not enabled): fail closed.
      await s.expectError("CDF_CONFLICT:CASE_CLOSURE_APPROVAL_RULE_REQUIRED", (tx) => close(tx, caseA));
      expect(await close(s.tx, caseB, "OUT_OF_SCOPE")).toEqual([{ r: "CLOSED" }]);
      expect(await state(s, caseB)).toEqual({ records_state: "CLOSED", current_state: "CLOSURE" });
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:CASE_NOT_ACTIVE", (tx) => close(tx, caseB));
      const v = await view(s, caseB);
      expect(v.closure_authority_configured).toBe(false);
      expect(v.closures).toEqual([
        expect.objectContaining({
          closure_no: 1,
          outcome_code: "OUT_OF_SCOPE",
          path: "DIRECT",
          transition_code: "SCREEN_OUT",
          closed_by: USERS.caseManager,
          request_id: null,
        }),
      ]);
      expect(v.closure_requests).toEqual([]);
      // Audited with codes only; the rationale stays in the closure row.
      expect(await events(s, caseB)).toEqual([
        {
          action: "CASE_CLOSURE_RECORDED",
          actor_id: USERS.caseManager,
          reason: null,
          metadata: {
            closure_no: 1,
            outcome_code: "OUT_OF_SCOPE",
            path: "DIRECT",
            transition: "SCREEN_OUT",
            request_id: null,
          },
        },
      ]);
      // Nobody writes the records directly.
      await s.as("caseManager");
      await s.expectError(
        "permission denied",
        (tx) =>
          tx`insert into case_mgmt.case_closure (case_id, closure_no, outcome_code, rationale, path, transition_code, closed_by)
             values (${caseA}, 1, 'NO_ACTION', ${RATIONALE}, 'DIRECT', 'SCREEN_OUT', ${USERS.caseManager})`,
      );
      await s.expectError(
        "permission denied",
        (tx) =>
          tx`insert into case_mgmt.case_closure_request (case_id, outcome_code, rationale, requested_by)
             values (${caseA}, 'NO_ACTION', ${RATIONALE}, ${USERS.caseManager})`,
      );
      await s.asOwner();
      await s.expectError(
        "",
        (tx) => tx`update case_mgmt.case_closure set outcome_code = 'NO_ACTION' where case_id = ${caseB}`,
      );
      await s.expectError("", (tx) => tx`delete from case_mgmt.case_closure where case_id = ${caseB}`);
    });
  });
});

describe("closing with a closure authority configured (DEC-F40 maker/approver and returned closure)", () => {
  it("anyone else's closure is a request the authority returns or approves, every blocker re-checked; no other path closes", async () => {
    await ownerScenario(async (s) => {
      await setClosureAuthority(s, "GRC_DIRECTOR");
      expect(await closeWith(s, caseB, "NOT_SERIOUS")).toBe("AWAITING_APPROVAL");
      await s.expectError("CDF_CONFLICT:CLOSURE_REQUEST_PENDING", (tx) => close(tx, caseB));
      // AGENT-09 R1: the step itself is refused without a closure recorded by the commands in this transaction.
      await s.expectError("CDF_CONFLICT:CLOSURE_APPROVAL_REQUIRED", (tx) => screenOut(tx, caseB));
      expect(await SCREEN_OUT_REASONS(s, caseB)).toEqual({
        allowed: false,
        blocking_reasons: ["CLOSURE_APPROVAL_REQUIRED"],
      });
      const first = await pendingRequest(s, caseB);
      // Only the closure authority decides; the case manager and the investigator are refused.
      for (const user of ["caseManager", "investigatorB"] as UserKey[]) {
        await s.as(user);
        await s.expectError("CDF_FORBIDDEN", (tx) => decide(tx, first, "APPROVE"));
      }
      await s.as("grcDirector");
      await s.expectError("CDF_INVALID:decision", (tx) => decide(tx, first, "MAYBE"));
      await s.expectError("CDF_INVALID:reason", (tx) => decide(tx, first, "RETURN", "short"));
      expect(await decide(s.tx, first, "RETURN")).toEqual([{ r: "RETURNED" }]);
      await s.expectError("CDF_CONFLICT:REQUEST_NOT_PENDING", (tx) => decide(tx, first, "APPROVE"));
      expect(await state(s, caseB)).toEqual({ records_state: "ACTIVE", current_state: "SCREENING" });
      // Filed again and approved by the other holder: the case closes with the requested outcome.
      expect(await closeWith(s, caseB, "NOT_SERIOUS")).toBe("AWAITING_APPROVAL");
      const second = await pendingRequest(s, caseB);
      await s.as("grcDeputy");
      expect(await decide(s.tx, second, "APPROVE")).toEqual([{ r: "CLOSED" }]);
      expect(await state(s, caseB)).toEqual({ records_state: "CLOSED", current_state: "CLOSURE" });
      await s.as("caseManager");
      const v = await view(s, caseB);
      expect(v.closure_authority_configured).toBe(true);
      expect(v.closures).toEqual([
        expect.objectContaining({
          closure_no: 1,
          outcome_code: "NOT_SERIOUS",
          path: "APPROVED",
          request_id: second,
        }),
      ]);
      // Both requests carry this transaction's time here, so they are compared as a set.
      expect(v.closure_requests.map((r) => [r.status, r.requested_by, r.decided_by]).sort()).toEqual([
        ["APPROVED", USERS.caseManager, USERS.grcDeputy],
        ["RETURNED", USERS.caseManager, USERS.grcDirector],
      ]);
      // Audited with codes and ids; the rationale and the decision reasons stay in their rows.
      const ev = await events(s, caseB);
      expect(ev.map((e) => [e.action, e.actor_id])).toEqual([
        ["CASE_CLOSURE_REQUESTED", USERS.caseManager],
        ["CASE_CLOSURE_DECIDED", USERS.grcDirector],
        ["CASE_CLOSURE_REQUESTED", USERS.caseManager],
        ["CASE_CLOSURE_DECIDED", USERS.grcDeputy],
        ["CASE_CLOSURE_RECORDED", USERS.grcDeputy],
      ]);
      const text = JSON.stringify(ev);
      expect(text).not.toContain(RATIONALE);
      expect(text).not.toContain(DECIDE_REASON);
      // A request moves once, on the table too.
      await s.asOwner();
      await s.expectError(
        `case closure request ${first} is decided once`,
        (tx) => tx`update case_mgmt.case_closure_request set status = 'APPROVED' where id = ${first}`,
      );
    });
  });

  it("the closure authority closes directly; another holder of the closure entitlement files a request", async () => {
    await ownerScenario(async (s) => {
      await setClosureAuthority(s, "CASE_MANAGER");
      await s.as("caseManager");
      await s.tx`select api.assign_case(${caseB}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${RATIONALE})`;
      expect(await closeWith(s, caseB, "NO_ACTION", "lead")).toBe("AWAITING_APPROVAL");
      // The authority does not close over a pending request; it decides it.
      await s.expectError("CDF_CONFLICT:CLOSURE_REQUEST_PENDING", (tx) => close(tx, caseB));
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:CLOSURE_REQUEST_PENDING", (tx) => close(tx, caseB));
      const request = await pendingRequest(s, caseB);
      await s.as("caseManager");
      expect(await decide(s.tx, request, "RETURN")).toEqual([{ r: "RETURNED" }]);
      // Since 2090 (AMB-003) a DUPLICATE closure needs an active DUPLICATE_OF link to the original.
      await s.tx`select api.link_cases(${caseB}, ${caseA}, 'DUPLICATE_OF', 'Synthetic: same matter as case A.')`;
      expect(await closeWith(s, caseB, "DUPLICATE")).toBe("CLOSED");
      await s.as("caseManager");
      expect((await view(s, caseB)).closures).toEqual([
        expect.objectContaining({ outcome_code: "DUPLICATE", path: "DIRECT", closed_by: USERS.caseManager }),
      ]);
    });
  });

  it("AGENT-09 R3: the maker never decides their own request, approve or return, whatever role they hold by then", async () => {
    await ownerScenario(async (s) => {
      await setClosureAuthority(s, "GRC_DIRECTOR");
      expect(await closeWith(s, caseB)).toBe("AWAITING_APPROVAL");
      const request = await pendingRequest(s, caseB);
      // The maker becomes a closure authority after filing (owner fixture).
      await s.tx`insert into iam.user_role_assignment (user_id, role_code, justification)
                 values (${USERS.caseManager}, 'GRC_DIRECTOR', 'Synthetic: test fixture role.')`;
      await s.as("caseManager");
      for (const d of ["APPROVE", "RETURN"]) {
        await s.expectError("CDF_CONFLICT:REQUESTER_CANNOT_APPROVE", (tx) => decide(tx, request, d));
      }
      await s.asOwner();
      await s.expectError(
        'new row for relation "case_closure_request" violates check constraint',
        (tx) =>
          tx`update case_mgmt.case_closure_request
             set status = 'APPROVED', decided_by = requested_by, decided_at = now(), decision_reason = ${DECIDE_REASON}
             where id = ${request}`,
      );
      expect(await state(s, caseB)).toEqual({ records_state: "ACTIVE", current_state: "SCREENING" });
    });
  });

  it("AGENT-09 R3: a technical, PLATFORM_ADMIN, DB_ADMIN, unknown or unheld closure authority reads as unset (fail closed)", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      await screenOut(s.tx, caseB);
      // No active holder: end any assignment of HR_REVIEWER, and suspend the lead (the only LEAD_INVESTIGATOR).
      await s.asOwner();
      await s.tx`update iam.user_role_assignment set status = 'REVOKED', revoked_at = now(),
                   revocation_reason = 'Synthetic: no holder for the test.'
                 where role_code = 'HR_REVIEWER' and status = 'ACTIVE'`;
      await s.tx`update iam.user_profile set status = 'SUSPENDED' where id = ${USERS.lead}`;
      for (const role of [
        "PLATFORM_ADMIN",
        "DB_ADMIN",
        "SOC_ANALYST",
        "NO_SUCH_ROLE",
        "HR_REVIEWER",
        "LEAD_INVESTIGATOR",
      ]) {
        await setClosureAuthority(s, role);
        await s.as("caseManager");
        await s.expectError(
          "CDF_CONFLICT:CASE_CLOSURE_APPROVAL_RULE_REQUIRED",
          (tx) =>
            tx`select api.request_case_reopening(${caseB}, 'NEW_EVIDENCE', ${RATIONALE}, 'Synthetic: a further extract.',
               'DEMO-REF', null)`,
        );
        expect((await view(s, caseB)).closure_authority_configured, role).toBe(false);
      }
      // The same request goes through once a real authority is configured (the refusals above are not vacuous).
      await setClosureAuthority(s, "GRC_DIRECTOR");
      await requestReopeningOnEvidence(s, caseB);
      expect((await view(s, caseB)).closure_authority_configured).toBe(true);
    });
  });

  it("CDF-221 (migration 2070): a configured closure authority with nobody in force closes nothing on any path, mirroring reopening", async () => {
    await ownerScenario(async (s) => {
      // No active holder, as in R3 above.
      await s.asOwner();
      await s.tx`update iam.user_role_assignment set status = 'REVOKED', revoked_at = now(),
                   revocation_reason = 'Synthetic: no holder for the test.'
                 where role_code = 'HR_REVIEWER' and status = 'ACTIVE'`;
      await s.tx`update iam.user_profile set status = 'SUSPENDED' where id = ${USERS.lead}`;
      for (const role of [
        "PLATFORM_ADMIN",
        "DB_ADMIN",
        "SOC_ANALYST",
        "NO_SUCH_ROLE",
        "HR_REVIEWER",
        "LEAD_INVESTIGATOR",
      ]) {
        await setClosureAuthority(s, role);
        // Configured, but no authority in force: the case manager neither closes directly nor files a request.
        await s.as("caseManager");
        await s.expectError("CDF_CONFLICT:CASE_CLOSURE_APPROVAL_RULE_REQUIRED", (tx) => close(tx, caseB));
        await s.expectError("CDF_CONFLICT:CASE_CLOSURE_APPROVAL_RULE_REQUIRED", (tx) => screenOut(tx, caseB));
        expect(await SCREEN_OUT_REASONS(s, caseB), role).toEqual({
          allowed: false,
          blocking_reasons: ["CASE_CLOSURE_APPROVAL_RULE_REQUIRED"],
        });
        expect(await view(s, caseB), role).toMatchObject({
          records_state: "ACTIVE",
          closure_authority_configured: false,
          closure_requests: [],
          closures: [],
        });
        // AGENT-09 R2 still holds: who may not close learns only that, never the rule's state.
        await expectNoBlockLeak(s);
        // Who cannot see the case learns nothing either.
        await s.as("investigatorA");
        await s.expectError("CDF_NOT_FOUND", (tx) => close(tx, caseB));
      }
      expect(await state(s, caseB)).toEqual({ records_state: "ACTIVE", current_state: "SCREENING" });
      expect(await events(s, caseB)).toEqual([]);
      // The refusals are not vacuous: with a real authority the same closure is a request (and unset, the case manager
      // closes directly, T-AMB-127). A request already filed is not decided once the rule names nobody in force.
      await setClosureAuthority(s, "GRC_DIRECTOR");
      expect(await closeWith(s, caseB, "NOT_SERIOUS")).toBe("AWAITING_APPROVAL");
      const pending = await pendingRequest(s, caseB);
      await setClosureAuthority(s, "NO_SUCH_ROLE");
      await s.as("grcDirector");
      await s.expectError("CDF_CONFLICT:CASE_CLOSURE_APPROVAL_RULE_REQUIRED", (tx) =>
        decide(tx, pending, "APPROVE"),
      );
      expect(await state(s, caseB)).toEqual({ records_state: "ACTIVE", current_state: "SCREENING" });
    });
  });

  it("AGENT-09 R1: an earlier transaction's closure never opens the guard; no path but the commands closes", async () => {
    await ownerScenario(async (s) => {
      await setClosureAuthority(s, "GRC_DIRECTOR");
      // A closure row left by an earlier transaction (as one survives a reopening).
      await s.tx`insert into case_mgmt.case_closure (case_id, closure_no, outcome_code, rationale, path, transition_code,
                                                     closed_by, transaction_id)
                 values (${caseB}, 1, 'NO_ACTION', ${RATIONALE}, 'DIRECT', 'SCREEN_OUT', ${USERS.caseManager}, '1'::xid8)`;
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:CLOSURE_APPROVAL_REQUIRED", (tx) => screenOut(tx, caseB));
      // The guard is on the table: a direct write by the owner is refused too.
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:CLOSURE_APPROVAL_REQUIRED",
        (tx) => tx`update case_mgmt.case_record set records_state = 'CLOSED' where id = ${caseB}`,
      );
      // Through the commands it closes, numbered after the earlier closure.
      expect(await closeWith(s, caseB)).toBe("AWAITING_APPROVAL");
      const request = await pendingRequest(s, caseB);
      await s.as("grcDirector");
      expect(await decide(s.tx, request, "APPROVE")).toEqual([{ r: "CLOSED" }]);
      await s.asOwner();
      expect(
        await s.tx`select closure_no, path from case_mgmt.case_closure where case_id = ${caseB} order by closure_no`,
      ).toEqual([
        { closure_no: 1, path: "DIRECT" },
        { closure_no: 2, path: "APPROVED" },
      ]);
    });
  });
});

describe("closure readiness on every path (CON-022, AMB-146, AMB-213, AMB-214)", () => {
  it("T-AMB-129 and AGENT-09 R2: no conditional closure exists; an open proceeding blocks every path, and only those who may close see why", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      await s.tx`select api.open_proceeding(${caseB}, 'INVESTIGATION', null, ${RATIONALE})`;
      await s.expectError("CDF_CONFLICT:OPEN_PROCEEDINGS", (tx) => close(tx, caseB));
      await s.expectError("CDF_CONFLICT:OPEN_PROCEEDINGS", (tx) => screenOut(tx, caseB));
      expect(await SCREEN_OUT_REASONS(s, caseB)).toEqual({
        allowed: false,
        blocking_reasons: ["OPEN_PROCEEDINGS"],
      });
      expect((await view(s, caseB)).closure_blocks).toEqual(["OPEN_PROCEEDINGS"]);
      // R2: viewers without the closure entitlement are told only that they lack it; the blockers are not computed.
      for (const user of ["investigatorB", "triage", "grcDirector"] as UserKey[]) {
        await s.as(user);
        expect(await SCREEN_OUT_REASONS(s, caseB), user).toEqual({
          allowed: false,
          blocking_reasons: ["MISSING_PERMISSION"],
        });
        const v = await view(s, caseB);
        expect(v.closure_blocks, user).toBeNull();
        expect(v.reopening_requests, user).toEqual(user === "grcDirector" ? [] : null);
      }
      // AMB-214: CONDITIONAL_CLOSURE_AUTHORITY is SOURCE_REQUIRED and nothing reads it: the owner's direct write is
      // refused by the same guard.
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:OPEN_PROCEEDINGS",
        (tx) => tx`update case_mgmt.case_record set records_state = 'CLOSED' where id = ${caseB}`,
      );
      const [setting] = await s.tx<{ status: string }[]>`
        select status from config.setting where key = 'CONDITIONAL_CLOSURE_AUTHORITY'`;
      expect(setting!.status).toBe("SOURCE_REQUIRED");
      // Once the proceeding is concluded, the case closes.
      await concludeProceedings(s, caseB);
      expect(await closeWith(s, caseB)).toBe("CLOSED");
    });
  });

  it("T-AMB-128: closure is refused while a decision notice's grievance window has not started or is open; it closes once the window has ended", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      await concludeProceedings(s, caseB);
      const notice = await decisionNotice(s, f.sigma, f.decision);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:GRIEVANCE_WINDOW_OPEN", (tx) => close(tx, caseB));
      await recordDelivery(s, notice);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:GRIEVANCE_WINDOW_OPEN", (tx) => close(tx, caseB));
      await s.expectError("CDF_CONFLICT:GRIEVANCE_WINDOW_OPEN", (tx) => screenOut(tx, caseB));
      expect((await view(s, caseB)).closure_blocks).toEqual(["GRIEVANCE_WINDOW_OPEN"]);
      expect((await SCREEN_OUT_REASONS(s, caseB)).blocking_reasons).toEqual(["GRIEVANCE_WINDOW_OPEN"]);
      await expectNoBlockLeak(s);
    });
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      await concludeProceedings(s, caseB);
      // A notice issued 40 days ago and delivered 35 days ago: its 30-day window ended five days ago.
      const old = await oldDeliveryNotice(s, caseB, gc, f.sigma, f.decision, 40);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:GRIEVANCE_WINDOW_OPEN", (tx) => close(tx, caseB));
      await recordDelivery(s, old, 35);
      expect(await closeWith(s, caseB, "REGULATORY_ACTION")).toBe("CLOSED");
    });
  });

  it("T-AMB-086: closure is refused while the decision is not final (a package between the vote and the authority)", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      // From migration 2117 the committee's proceeding cannot conclude while its package is adopted and not yet sent on;
      // one closed before 2117 can, and closure readiness still refuses the case then.
      const cp = f.meeting.committeeProceeding;
      await s.asOwner();
      const [own] = await s.tx<{ proceeding_id: string }[]>`
        select proceeding_id from committee.committee_proceeding where id = ${cp}`;
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:PACKAGE_ADOPTED",
        (tx) =>
          tx`select api.close_proceeding(${own!.proceeding_id}, 'CONCLUDED', 'DECISION_RECORDED', ${COMMITTEE_REASON})`,
      );
      await closeAsBefore2117(s, cp, "CONCLUDED");
      await concludeProceedings(s, caseB);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:DECISION_NOT_FINAL", (tx) => close(tx, caseB));
      await s.expectError("CDF_CONFLICT:DECISION_NOT_FINAL", (tx) => screenOut(tx, caseB));
      expect((await view(s, caseB)).closure_blocks).toEqual(["DECISION_NOT_FINAL"]);
      expect((await SCREEN_OUT_REASONS(s, caseB)).blocking_reasons).toEqual(["DECISION_NOT_FINAL"]);
      await expectNoBlockLeak(s);
    });
  });
});
