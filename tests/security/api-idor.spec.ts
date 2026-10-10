// CDF-62 · §18–§21, §87, threats T01/T02/T03: broken access control and IDOR on every api.* command.
// Each command is called by people who cannot see the target case, with the UUIDs of real objects on it
// (case, report, assignment, grant, conflict, evidence item and version, reveal request). Every call must be
// refused exactly as if the object did not exist, and the catalog guard makes a new api.* function fail this
// file until it has an entry here.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { USERS, admin, caseId, scenario, type Scenario, type UserKey } from "../support/db";

interface Targets {
  case: string;
  report: string;
  assignment: string;
  grant: string;
  conflict: string;
  evidence: string;
  version: string;
  revealRequest: string;
}

type Outcome = "NOT_FOUND" | "EMPTY" | "FALSE";
interface Probe {
  fn: string;
  outcome: Outcome;
  call: (tx: Tx, t: Targets, self: string) => Promise<readonly Record<string, unknown>[]>;
}

const REASON = "Synthetic: security regression probe.";
const SHA = "c".repeat(64);

// One probe per object-scoped api.* function. The self id is the acting outsider, so "assign me" and
// "grant me" attempts are covered too.
const PROBES: Probe[] = [
  {
    fn: "assign_case",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.assign_case(${t.case}, ${self}, 'INVESTIGATOR', ${REASON})`,
  },
  {
    fn: "available_transitions",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.available_transitions(${t.case})`,
  },
  {
    fn: "change_case_classification",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.change_case_classification(${t.case}, 'INTERNAL'::core.classification_level, false, ${REASON})`,
  },
  {
    fn: "complete_evidence_version",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.complete_evidence_version(${t.version}, 'CLEAN', 'probe')`,
  },
  {
    fn: "create_case_from_report",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.create_case_from_report(${t.report}, 'Probe case (synthetic)', 'Synthetic probe summary text.', 'RESTRICTED'::core.classification_level, false)`,
  },
  {
    fn: "decide_conflict",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_conflict(${t.conflict}, 'CONFLICT_CLEARED', ${REASON})`,
  },
  {
    fn: "decide_identity_reveal",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_identity_reveal(${t.revealRequest}, true, ${REASON})`,
  },
  {
    fn: "declare_conflict",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.declare_conflict(${t.case}, false, ${REASON})`,
  },
  {
    fn: "end_assignment",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.end_assignment(${t.assignment}, ${REASON})`,
  },
  {
    fn: "grant_case_access",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.grant_case_access(${t.case}, ${self}, 'CASE', ${REASON}, null)`,
  },
  {
    fn: "list_identity_reveal_requests",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.list_identity_reveal_requests(${t.case})`,
  },
  { fn: "open_case", outcome: "FALSE", call: (tx, t) => tx`select api.open_case(${t.case}) as v` },
  {
    fn: "open_evidence_version",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.open_evidence_version(${t.version})`,
  },
  { fn: "open_report", outcome: "FALSE", call: (tx, t) => tx`select api.open_report(${t.report}) as v` },
  {
    fn: "reassign_case",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.reassign_case(${t.assignment}, ${self}, ${REASON})`,
  },
  {
    fn: "register_evidence_version",
    outcome: "NOT_FOUND",
    // A new version of someone else's item on someone else's case.
    call: (tx, t) =>
      tx`select * from api.register_evidence_version(${t.case}, ${t.evidence}, null, null, null, null, null, null,
        'probe.pdf', 'application/pdf', 1024, ${SHA})`,
  },
  {
    fn: "reject_evidence_version",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.reject_evidence_version(${t.version}, 'MALWARE_DETECTED', 'INFECTED', 'probe')`,
  },
  {
    fn: "reply_to_reporter",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.reply_to_reporter(${t.report}, 'Synthetic probe reply to the reporter.')`,
  },
  {
    fn: "request_identity_reveal",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.request_identity_reveal(${t.case}, ${REASON})`,
  },
  {
    fn: "resolve_reporter_identity",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select * from api.resolve_reporter_identity(${t.case}, ${REASON})`,
  },
  {
    fn: "revoke_case_access",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.revoke_case_access(${t.grant}, ${REASON})`,
  },
  {
    fn: "transition_case",
    outcome: "NOT_FOUND",
    // Try every transition the current state offers; none may be reachable by an outsider.
    call: async (tx, t) => {
      const codes = await tx<{ code: string }[]>`
        select d.code from workflow.workflow_transition_definition d
        join workflow.workflow_instance i on i.workflow_code = d.workflow_code and i.current_state = d.from_state
        where i.case_id = ${t.case}`;
      // An outsider cannot read the instance, so fall back to a plausible code: the result must not differ.
      const code = codes[0]?.code ?? "COMPLETE_SCREENING";
      return tx`select api.transition_case(${t.case}, ${code}, ${REASON})`;
    },
  },
  {
    fn: "triage_report",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.triage_report(${t.report}, 'OPEN_CASE', ${REASON}, null, null)`,
  },
  {
    fn: "update_case_details",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.update_case_details(${t.case}, 'Overwritten title (synthetic)', 'Overwritten summary (synthetic).', 'LOW', 1)`,
  },
];

// Functions that take no case-scoped object: covered by permission tests below and elsewhere.
const ADMIN_COMMANDS = ["grant_role", "revoke_role", "set_user_status"];
const GLOBAL_COMMANDS = ["record_security_event", "verify_audit_chain"];

let caseA: string, caseB: string, caseExec: string;
beforeAll(async () => {
  [caseA, caseB, caseExec] = await Promise.all([caseId("0001"), caseId("0002"), caseId("0003")]);
});

async function seedObjects(caseNo: string) {
  const [row] = await admin<{ report: string; assignment: string; grant: string }[]>`
    select (select r.id from intake.report r where r.case_id = c.id limit 1) as report,
           (select a.id from case_mgmt.case_assignment a where a.case_id = c.id and a.status = 'ACTIVE' limit 1) as assignment,
           (select g.id from case_mgmt.case_access_grant g where g.case_id = c.id and g.status = 'ACTIVE' limit 1) as "grant"
    from case_mgmt.case_record c where c.case_number like ${"CDF-DEMO-%-" + caseNo}`;
  if (!row?.report || !row.assignment || !row.grant) throw new Error(`seed objects for ${caseNo} missing`);
  return row;
}

/**
 * Creates, inside the scenario, the objects only an insider can create: an evidence item and version, an
 * identity reveal request and a conflict declaration. `uploader` must be able to upload on the case.
 */
async function insiderObjects(
  s: Scenario,
  target: string,
  uploader: UserKey,
  revealer: UserKey,
  declarer: UserKey,
  classification = "RESTRICTED",
): Promise<Pick<Targets, "evidence" | "version" | "revealRequest" | "conflict">> {
  await s.as(uploader);
  const [ev] = await s.tx<{ evidence: string; version: string }[]>`
    select o_evidence_id as evidence, o_version_id as version
    from api.register_evidence_version(${target}, null, 'Probe ledger (synthetic)', null, 'DOCUMENT', 'Synthetic source',
      null, ${classification}::core.classification_level, 'ledger.pdf', 'application/pdf', 2048, ${"d".repeat(64)})`;
  await s.as(revealer);
  const [rr] = await s.tx<
    { id: string }[]
  >`select api.request_identity_reveal(${target}, 'Synthetic: need to contact the reporter for documents.') as id`;
  // Declared last: a declared conflict removes the declarer's own access.
  await s.as(declarer);
  const [k] = await s.tx<
    { id: string }[]
  >`select api.declare_conflict(${target}, true, 'Synthetic: probe conflict declaration.') as id`;
  return { evidence: ev!.evidence, version: ev!.version, revealRequest: rr!.id, conflict: k!.id };
}

async function outcomeOf(s: Scenario, probe: Probe, t: Targets, self: string): Promise<string> {
  let result: readonly Record<string, unknown>[] | undefined;
  let error: string | undefined;
  try {
    await s.tx.savepoint(async (sp) => {
      result = await probe.call(sp as unknown as Tx, t, self);
    });
  } catch (e) {
    error = (e as Error).message;
  }
  if (error !== undefined) return error.startsWith("CDF_NOT_FOUND") ? "NOT_FOUND" : `ERROR ${error}`;
  if (result!.length === 0) return "EMPTY";
  const values = Object.values(result![0]!);
  if (result!.length === 1 && values.length === 1 && values[0] === false) return "FALSE";
  return `RESULT ${JSON.stringify(result).slice(0, 200)}`;
}

const randomTargets = (): Targets => ({
  case: randomUUID(),
  report: randomUUID(),
  assignment: randomUUID(),
  grant: randomUUID(),
  conflict: randomUUID(),
  evidence: randomUUID(),
  version: randomUUID(),
  revealRequest: randomUUID(),
});

describe("catalog guard", () => {
  it("every api.* function executable by authenticated has an IDOR probe or is a named non-object command", async () => {
    const rows = await admin<{ name: string }[]>`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      order by 1`;
    const covered = new Set([...PROBES.map((p) => p.fn), ...ADMIN_COMMANDS, ...GLOBAL_COMMANDS]);
    expect(rows.map((r) => r.name).filter((n) => !covered.has(n))).toEqual([]);
    expect([...covered].filter((n) => !rows.some((r) => r.name === n))).toEqual([]);
  });
});

describe("IDOR: outsiders get the same answer for real objects as for random UUIDs", () => {
  // [actor, case it cannot see]: a peer investigator, people with no case role, and the case manager and a
  // GRC director (CASE_VIEW_ALL, RESTRICTED_CASE_GRANT) against a restricted SECRET case.
  const OUTSIDERS: [UserKey, "B" | "EXEC"][] = [
    ["investigatorA", "B"],
    ["committee", "B"],
    ["intake", "B"],
    ["platformAdmin", "B"],
    ["internalAudit", "B"],
    ["soc", "B"],
    ["dpo", "B"],
    ["caseManager", "EXEC"],
    ["grcDeputy", "EXEC"],
    ["triage", "EXEC"], // holds a TRIAGE grant on the case but lacks the clearance
    ["investigatorB", "EXEC"],
  ];

  it.each(OUTSIDERS)("%s against case %s", async (actor, which) => {
    const target = which === "B" ? caseB : caseExec;
    const seeded = await seedObjects(which === "B" ? "0002" : "0003");
    await scenario(async (s) => {
      const inside =
        which === "B"
          ? await insiderObjects(s, target, "investigatorB", "grcDirector", "investigatorB")
          : await insiderObjects(s, target, "grcDirector", "grcDirector", "grcDirector", "SECRET");
      const real: Targets = { case: target, ...seeded, ...inside };
      await s.as(actor);
      const self = USERS[actor];
      const mismatches: string[] = [];
      for (const probe of PROBES) {
        const onReal = await outcomeOf(s, probe, real, self);
        const onRandom = await outcomeOf(s, probe, randomTargets(), self);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);

      // The refused calls left no business trace: every audit event this actor caused is a SECURITY denial.
      await s.as("dpo");
      const events = await s.tx<{ action: string; category: string; outcome: string }[]>`
        select action, category, outcome from audit.audit_event
        where actor_id = ${self} and request_id = nullif(current_setting('cdf.request_id', true), '')::uuid`;
      expect(events.filter((e) => e.category !== "SECURITY" || e.outcome !== "DENIED")).toEqual([]);
    });
  });

  it("an insider gets real answers from the same probes (the probes are not vacuous)", async () => {
    await scenario(async (s) => {
      await s.as("investigatorB");
      const [opened] = await s.tx<{ v: boolean }[]>`select api.open_case(${caseB}) as v`;
      expect(opened!.v).toBe(true);
      expect((await s.tx`select * from api.available_transitions(${caseB})`).length).toBeGreaterThan(0);
      await s.as("grcDirector");
      const [exec] = await s.tx<{ v: boolean }[]>`select api.open_case(${caseExec}) as v`;
      expect(exec!.v).toBe(true);
    });
  });
});

describe("cross-case object substitution", () => {
  it("an insider on case A cannot act on case B's objects by passing them to commands", async () => {
    const seeded = await seedObjects("0002");
    await scenario(async (s) => {
      // The lead of case A may assign, end and reassign assignments on case A only.
      await s.as("lead");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.end_assignment(${seeded.assignment}, ${REASON})`,
      );
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.reassign_case(${seeded.assignment}, ${USERS.investigatorA}, ${REASON})`,
      );
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.revoke_case_access(${seeded.grant}, ${REASON})`,
      );
      // Registering on case A but naming an evidence item from case B is refused, not silently re-homed.
      await s.as("investigatorB");
      const [ev] = await s.tx<{ evidence: string }[]>`
        select o_evidence_id as evidence from api.register_evidence_version(${caseB}, null, 'Case B item (synthetic)', null,
          'DOCUMENT', 'Synthetic source', null, 'RESTRICTED'::core.classification_level, 'b.pdf', 'application/pdf', 100, ${"e".repeat(64)})`;
      await s.as("investigatorA");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select * from api.register_evidence_version(${caseA}, ${ev!.evidence}, null, null, null, null, null, null,
            'swap.pdf', 'application/pdf', 100, ${"f".repeat(64)})`,
      );
    });
  });
});

describe("non-object commands", () => {
  const NON_ADMINS: UserKey[] = [
    "intake",
    "triage",
    "caseManager",
    "investigatorA",
    "lead",
    "committee",
    "grcDirector",
    "internalAudit",
    "soc",
    "dpo",
  ];

  it.each(NON_ADMINS)("%s cannot use user or role administration commands", async (actor) => {
    const [assignment] = await admin<{ id: string }[]>`
      select id from iam.user_role_assignment where user_id = ${USERS.investigatorB} and status = 'ACTIVE' limit 1`;
    await scenario(async (s) => {
      await s.as(actor);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.grant_role(${USERS.committee}, 'GRC_DIRECTOR', ${REASON}, null)`,
      );
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.grant_role(${USERS[actor]}, 'PLATFORM_ADMIN', ${REASON}, null)`,
      );
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.revoke_role(${assignment!.id}, ${REASON})`);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.set_user_status(${USERS.investigatorB}, 'SUSPENDED'::core.record_status, ${REASON})`,
      );
    });
  });

  it("a revoked user gets nothing from any probe, even on a case they were assigned to", async () => {
    const seeded = await seedObjects("0002");
    await scenario(async (s) => {
      const inside = await insiderObjects(s, caseB, "investigatorB", "grcDirector", "investigatorB");
      await s.as("revoked");
      const leaks: string[] = [];
      for (const probe of PROBES) {
        const got = await outcomeOf(s, probe, { case: caseB, ...seeded, ...inside }, USERS.revoked);
        if (!["EMPTY", "FALSE", "NOT_FOUND"].includes(got) && !got.startsWith("ERROR CDF_UNAUTHENTICATED"))
          leaks.push(`${probe.fn}: ${got}`);
      }
      expect(leaks).toEqual([]);
    });
  });

  it("anonymous callers can use no api.* command", async () => {
    const fns = await admin<{ sig: string; args: number }[]>`
      select p.oid::regprocedure::text as sig, p.pronargs::int as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and has_function_privilege('authenticated', p.oid, 'EXECUTE')`;
    await scenario(async (s) => {
      await s.as(null);
      for (const f of fns) {
        const name = f.sig.slice(0, f.sig.indexOf("("));
        const nulls = Array.from({ length: f.args }, () => "null").join(", ");
        await s.expectError("permission denied", (tx) => tx.unsafe(`select ${name}(${nulls})`));
      }
    });
  });
});
