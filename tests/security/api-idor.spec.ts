// CDF-62 · §18–§21, §87, threats T01/T02/T03: broken access control and IDOR on every api.* command.
// Each command is called by people who cannot see the target case, with the UUIDs of real objects on it
// (case, report, assignment, grant, conflict, evidence item and version, reveal request, form instance). Every call must be
// refused exactly as if the object did not exist, and the catalog guard makes a new api.* function fail this
// file until it has an entry here.
import { createHash, randomUUID } from "node:crypto";
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
  interview: string;
  statementVersion: string;
  formInstance: string;
  attachment: string;
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
    fn: "open_report_attachment",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.open_report_attachment(${t.attachment})`,
  },
  {
    fn: "approve_form",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.approve_form(${t.formInstance}, 'APPROVED', null)`,
  },
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
  {
    fn: "open_form_instance",
    outcome: "FALSE",
    call: (tx, t) => tx`select api.open_form_instance(${t.formInstance}) as v`,
  },
  { fn: "open_report", outcome: "FALSE", call: (tx, t) => tx`select api.open_report(${t.report}) as v` },
  {
    fn: "prepare_form",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.prepare_form(${t.formInstance})`,
  },
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
    fn: "review_form",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.review_form(${t.formInstance}, 'REVIEWED', null)`,
  },
  {
    fn: "revoke_case_access",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.revoke_case_access(${t.grant}, ${REASON})`,
  },
  {
    fn: "save_form_draft",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select * from api.save_form_draft(${t.formInstance}, '{}'::jsonb)`,
  },
  {
    fn: "start_form",
    outcome: "NOT_FOUND",
    // The lowest classification: the refusal must come from case visibility, never from the clearance check.
    call: (tx, t) => tx`select api.start_form(${t.case}, 'WB-FRM-11', 'INTERNAL'::core.classification_level)`,
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
  // ---- Interviews (CDF-60, ADR-012) ------------------------------------------------------------------
  {
    fn: "plan_interview",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.plan_interview(${t.case}, 'Probe interview (synthetic)', null, 'WITNESS', 'Witness Probe', null,
        'RESTRICTED'::core.classification_level)`,
  },
  {
    fn: "add_interview_participant",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.add_interview_participant(${t.interview}, ${self}, 'INTERVIEWER')`,
  },
  {
    fn: "schedule_interview",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.schedule_interview(${t.interview}, now() + interval '2 days', 60, 'PHONE', null)`,
  },
  {
    fn: "issue_interview_notice",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.issue_interview_notice(${t.interview}, 'RESCHEDULE', 'INTERNAL_EMAIL')`,
  },
  {
    fn: "record_interview_rights",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.record_interview_rights(${t.interview}, 'SIGNED_FORM', 'PROBE-RIGHTS-V1')`,
  },
  {
    fn: "record_interview_conducted",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_interview_conducted(${t.interview}, now() - interval '1 hour', now())`,
  },
  {
    fn: "record_interview_statement",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select * from api.record_interview_statement(${t.interview}, 'Overwritten statement (synthetic).', 'en')`,
  },
  {
    fn: "acknowledge_interview_statement",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.acknowledge_interview_statement(${t.statementVersion}, 'ELECTRONIC_ACK', ${SHA})`,
  },
  {
    fn: "link_interview_recording",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.link_interview_recording(${t.interview}, ${t.evidence})`,
  },
  {
    fn: "transition_interview",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.transition_interview(${t.interview}, 'CANCEL', ${REASON})`,
  },
  {
    fn: "open_interview",
    outcome: "FALSE",
    call: (tx, t) => tx`select api.open_interview(${t.interview}) as v`,
  },
  {
    fn: "withdraw_form",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.withdraw_form(${t.formInstance}, ${REASON})`,
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
  const [row] = await admin<{ report: string; reportRef: string; assignment: string; grant: string }[]>`
    select (select r.id from intake.report r where r.case_id = c.id limit 1) as report,
           (select r.report_ref from intake.report r where r.case_id = c.id limit 1) as "reportRef",
           (select a.id from case_mgmt.case_assignment a where a.case_id = c.id and a.status = 'ACTIVE' limit 1) as assignment,
           (select g.id from case_mgmt.case_access_grant g where g.case_id = c.id and g.status = 'ACTIVE' limit 1) as "grant"
    from case_mgmt.case_record c where c.case_number like ${"CDF-DEMO-%-" + caseNo}`;
  if (!row?.report || !row.assignment || !row.grant) throw new Error(`seed objects for ${caseNo} missing`);
  return row;
}

/**
 * A clean reporter attachment (CDF-72) on the case's source report, added through the anonymous portal
 * commands. Seed reports store sha256('unusable-seed-secret:' || ref) as their secret HMAC (seed 02).
 */
async function reporterAttachment(s: Scenario, reportRef: string): Promise<string> {
  const hmac = createHash("sha256").update(`unusable-seed-secret:${reportRef}`, "utf8").digest("hex");
  await s.as(null);
  const [a] = await s.tx<{ id: string }[]>`
    select attachment_id as id from public_api.register_report_attachment(${reportRef}, ${hmac}, 'REPORT', 'pdf',
      'application/pdf', 2048, ${createHash("sha256").update(randomUUID()).digest("hex")})`;
  await s.tx`select public_api.complete_report_attachment(${reportRef}, ${hmac}, ${a!.id}, 'CLEAN', 'probe')`;
  return a!.id;
}

/**
 * Creates, inside the scenario, the objects only an insider can create: an evidence item and version, a form
 * instance, an identity reveal request and a conflict declaration. `uploader` must be able to upload on the
 * case and `formPreparer` to prepare an investigation form on it. No seed role can prepare a form on the
 * restricted SECRET case (GRC has no FORM_PREPARE), so without a preparer the form probes use a random id.
 */
async function insiderObjects(
  s: Scenario,
  target: string,
  uploader: UserKey,
  revealer: UserKey,
  declarer: UserKey,
  classification = "RESTRICTED",
  formPreparer?: UserKey,
): Promise<
  Pick<
    Targets,
    "evidence" | "version" | "revealRequest" | "conflict" | "interview" | "statementVersion" | "formInstance"
  >
> {
  await s.as(uploader);
  const [ev] = await s.tx<{ evidence: string; version: string }[]>`
    select o_evidence_id as evidence, o_version_id as version
    from api.register_evidence_version(${target}, null, 'Probe ledger (synthetic)', null, 'DOCUMENT', 'Synthetic source',
      null, ${classification}::core.classification_level, 'ledger.pdf', 'application/pdf', 2048, ${"d".repeat(64)})`;
  // A conducted interview with one statement version (CDF-60), by the same insider.
  const [iv] = await s.tx<{ id: string }[]>`
    select api.plan_interview(${target}, 'Probe interview (synthetic)', null, 'WITNESS', 'Witness Probe (synthetic)', null,
      ${classification}::core.classification_level) as id`;
  await s.tx`select api.schedule_interview(${iv!.id}, now() - interval '2 hours', 60, 'PHONE', null)`;
  await s.tx`select api.issue_interview_notice(${iv!.id}, 'INVITATION', 'INTERNAL_EMAIL')`;
  await s.tx`select api.record_interview_rights(${iv!.id}, 'SIGNED_FORM', 'PROBE-RIGHTS-V1')`;
  await s.tx`select api.record_interview_conducted(${iv!.id}, now() - interval '2 hours', now() - interval '1 hour')`;
  const [sv] = await s.tx<{ id: string }[]>`
    select o_version_id as id from api.record_interview_statement(${iv!.id}, 'Probe statement (synthetic).', 'en')`;
  let formInstance: string = randomUUID();
  if (formPreparer) {
    await s.as(formPreparer);
    const [f] = await s.tx<
      { id: string }[]
    >`select api.start_form(${target}, 'WB-FRM-11', ${classification}::core.classification_level) as id`;
    formInstance = f!.id;
  }
  await s.as(revealer);
  const [rr] = await s.tx<
    { id: string }[]
  >`select api.request_identity_reveal(${target}, 'Synthetic: need to contact the reporter for documents.') as id`;
  // Declared last: a declared conflict removes the declarer's own access.
  await s.as(declarer);
  const [k] = await s.tx<
    { id: string }[]
  >`select api.declare_conflict(${target}, true, 'Synthetic: probe conflict declaration.') as id`;
  return {
    evidence: ev!.evidence,
    version: ev!.version,
    revealRequest: rr!.id,
    conflict: k!.id,
    interview: iv!.id,
    statementVersion: sv!.id,
    formInstance,
  };
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
  interview: randomUUID(),
  statementVersion: randomUUID(),
  formInstance: randomUUID(),
  attachment: randomUUID(),
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
          ? await insiderObjects(
              s,
              target,
              "investigatorB",
              "grcDirector",
              "investigatorB",
              "RESTRICTED",
              "investigatorB",
            )
          : await insiderObjects(s, target, "grcDirector", "grcDirector", "grcDirector", "SECRET");
      const attachment = await reporterAttachment(s, seeded.reportRef);
      const real: Targets = { case: target, ...seeded, ...inside, attachment };
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
      const [form] = await s.tx<
        { id: string }[]
      >`select api.start_form(${caseB}, 'WB-FRM-11', 'RESTRICTED'::core.classification_level) as id`;
      const [formOpened] = await s.tx<{ v: boolean }[]>`select api.open_form_instance(${form!.id}) as v`;
      expect(formOpened!.v).toBe(true);
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
      const [ev] = await s.tx<{ evidence: string; version: string }[]>`
        select o_evidence_id as evidence, o_version_id as version from api.register_evidence_version(${caseB}, null, 'Case B item (synthetic)', null,
          'DOCUMENT', 'Synthetic source', null, 'RESTRICTED'::core.classification_level, 'b.pdf', 'application/pdf', 100, ${"e".repeat(64)})`;
      await s.as("investigatorA");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select * from api.register_evidence_version(${caseA}, ${ev!.evidence}, null, null, null, null, null, null,
            'swap.pdf', 'application/pdf', 100, ${"f".repeat(64)})`,
      );
      // Linking case B's evidence as a recording of a case A interview is refused, not re-homed (CDF-60),
      // with the same answer as for an evidence id that does not exist.
      await s.as("investigatorB");
      await s.tx`select api.complete_evidence_version(${ev!.version}, 'CLEAN', 'probe-scanner')`;
      await s.as("investigatorA");
      const [iv] = await s.tx<{ id: string }[]>`
        select api.plan_interview(${caseA}, 'Swap interview (synthetic)', null, 'WITNESS', 'Witness Swap (synthetic)', null,
          'CONFIDENTIAL'::core.classification_level) as id`;
      await s.tx`select api.schedule_interview(${iv!.id}, now() - interval '2 hours', 60, 'PHONE', null)`;
      await s.tx`select api.issue_interview_notice(${iv!.id}, 'INVITATION', 'INTERNAL_EMAIL')`;
      await s.tx`select api.record_interview_rights(${iv!.id}, 'SIGNED_FORM', 'PROBE-RIGHTS-V1')`;
      await s.tx`select api.record_interview_conducted(${iv!.id}, now() - interval '2 hours', now() - interval '1 hour')`;
      await s.expectError(
        "CDF_INVALID:evidence_id",
        (tx) => tx`select api.link_interview_recording(${iv!.id}, ${ev!.evidence})`,
      );
      await s.expectError(
        "CDF_INVALID:evidence_id",
        (tx) => tx`select api.link_interview_recording(${iv!.id}, ${randomUUID()})`,
      );
      // And case B's seeded reporter interview is unreachable from case A's team.
      const [reporterInterview] = await admin<{ id: string }[]>`
        select id from case_mgmt.interview where case_id = ${caseB} and interviewee_kind = 'REPORTER' limit 1`;
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.transition_interview(${reporterInterview!.id}, 'CANCEL', ${REASON})`,
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
      const inside = await insiderObjects(
        s,
        caseB,
        "investigatorB",
        "grcDirector",
        "investigatorB",
        "RESTRICTED",
        "investigatorB",
      );
      const attachment = await reporterAttachment(s, seeded.reportRef);
      await s.as("revoked");
      const leaks: string[] = [];
      for (const probe of PROBES) {
        const got = await outcomeOf(
          s,
          probe,
          { case: caseB, ...seeded, ...inside, attachment },
          USERS.revoked,
        );
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
