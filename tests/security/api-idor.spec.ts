// CDF-62 · §18–§21, §87, threats T01/T02/T03: broken access control and IDOR on every api.* command.
// Each command is called by people who cannot see the target case, with the UUIDs of real objects on it
// (case, report, assignment, grant, conflict, evidence item and version, reveal request, form instance). Every call must be
// refused exactly as if the object did not exist, and the catalog guard makes a new api.* function fail this
// file until it has an entry here.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import {
  USERS,
  admin,
  caseId,
  ownerScenario,
  scenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import {
  DECISION,
  JUSTIFICATION,
  legalHoldTasks,
  makeEligible,
  placeHold,
  requestDisposition,
} from "../support/records";

interface Targets {
  case: string;
  report: string;
  assignment: string;
  grant: string;
  conflict: string;
  evidence: string;
  version: string;
  revealRequest: string;
  // Purpose-bound access (CDF-73, ADR-014)
  task: string;
  holdRequest: string;
  breakGlass: string;
  interview: string;
  statementVersion: string;
  formInstance: string;
  attachment: string;
}

type Outcome = "NOT_FOUND" | "EMPTY" | "FALSE";
interface Probe<T = Targets> {
  fn: string;
  outcome: Outcome;
  call: (tx: Tx, t: T, self: string) => Promise<readonly Record<string, unknown>[]>;
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
  // Purpose-bound access (CDF-73, ADR-014): tasks, legal-hold requests and break-glass.
  {
    fn: "assign_legal_hold_request",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.assign_legal_hold_request(${t.holdRequest}, ${self})`,
  },
  {
    fn: "cancel_case_task",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.cancel_case_task(${t.task}, ${REASON})`,
  },
  {
    fn: "complete_case_task",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.complete_case_task(${t.task}, ${REASON})`,
  },
  {
    fn: "create_case_task",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.create_case_task(${t.case}, 'LEGAL_REVIEW', ${self}, ${REASON})`,
  },
  {
    fn: "decide_break_glass",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_break_glass(${t.breakGlass}, true, ${REASON})`,
  },
  {
    fn: "end_break_glass",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.end_break_glass(${t.breakGlass})`,
  },
  {
    fn: "open_case_metadata",
    outcome: "FALSE",
    call: (tx, t) => tx`select api.open_case_metadata(${t.case}) as v`,
  },
  { fn: "open_case_task", outcome: "FALSE", call: (tx, t) => tx`select api.open_case_task(${t.task}) as v` },
  {
    fn: "request_break_glass",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.request_break_glass(${t.case}, ${REASON}, 60)`,
  },
  {
    fn: "request_legal_hold",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.request_legal_hold(${t.case}, 'LITIGATION', ${REASON})`,
  },
  {
    fn: "review_break_glass",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.review_break_glass(${t.breakGlass}, 'APPROPRIATE', ${REASON})`,
  },
  {
    fn: "review_legal_hold_request",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.review_legal_hold_request(${t.holdRequest}, true, ${REASON})`,
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

// Records, retention and legal hold commands (ADR-013) take their own objects: a hold, a release request,
// a disposition request and a certificate.
interface RecordsTargets {
  case: string;
  hold: string;
  release: string;
  disposition: string;
  certificate: string;
}

const RECORDS_PROBES: Probe<RecordsTargets>[] = [
  {
    fn: "assign_retention_class",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.assign_retention_class(${t.case}, 'TEST_SHORT_RETENTION')`,
  },
  {
    fn: "decide_disposition",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_disposition(${t.disposition}, false, ${REASON})`,
  },
  {
    fn: "decide_legal_hold_release",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_legal_hold_release(${t.release}, true, ${REASON})`,
  },
  {
    fn: "execute_disposition",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.execute_disposition(${t.disposition})`,
  },
  {
    fn: "list_records",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.list_records(null, ${t.case})`,
  },
  {
    fn: "place_legal_hold",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.place_legal_hold(${t.case}, 'CASE', null, 'LITIGATION', ${REASON + " Preserve."}, null)`,
  },
  {
    fn: "request_disposition",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.request_disposition(${t.case})`,
  },
  {
    fn: "request_legal_hold_release",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.request_legal_hold_release(${t.hold}, ${REASON + " Release."})`,
  },
  {
    fn: "verify_disposition_certificate",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.verify_disposition_certificate(${t.certificate})`,
  },
];

// Functions that take no case-scoped object: covered by permission tests below and elsewhere.
const ADMIN_COMMANDS = ["grant_role", "revoke_role", "set_user_status"];
// The caller's own tasks and counts, the authorised catalogue search, the exact-number lookup (a case number,
// never a UUID; PBA-T16 to T18) and task housekeeping take no object id (CDF-73).
const GLOBAL_COMMANDS = [
  "record_security_event",
  "verify_audit_chain",
  "refresh_disposition_eligibility",
  "expire_case_tasks",
  "my_case_tasks",
  "my_work_summary",
  "request_case_for_legal_hold",
  "search_records_catalogue",
];

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

/**
 * CDF-73 objects on the target: a legal-review task, a legal-hold request and, where the case allows it, a
 * break-glass request. Break-glass never reaches a restricted case (ADR-014 D5), so on the executive case the
 * probe gets a random id, which must give the same answer anyway.
 */
async function purposeObjects(
  s: Scenario,
  target: string,
  authority: UserKey,
  assignee: UserKey,
  withBreakGlass: boolean,
): Promise<Pick<Targets, "task" | "holdRequest" | "breakGlass">> {
  await s.as(authority);
  const [task] = await s.tx<{ id: string }[]>`
    select api.create_case_task(${target}, ${assignee === "legal" ? "LEGAL_REVIEW" : "LEGAL_HOLD_APPLICATION"},
      ${USERS[assignee]}, 'Synthetic: probe task purpose.') as id`;
  const [req] = await s.tx<
    { id: string }[]
  >`select api.request_legal_hold(${target}, 'LITIGATION', 'Synthetic: probe hold request justification.') as id`;
  let breakGlass: string = randomUUID();
  if (withBreakGlass) {
    await s.as(assignee);
    const [bg] = await s.tx<{ id: string }[]>`
      select api.request_break_glass(${target}, 'Synthetic: probe break-glass justification.', 60) as id`;
    breakGlass = bg!.id;
  }
  return { task: task!.id, holdRequest: req!.id, breakGlass };
}

async function outcomeOf<T>(s: Scenario, probe: Probe<T>, t: T, self: string): Promise<string> {
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
  task: randomUUID(),
  holdRequest: randomUUID(),
  breakGlass: randomUUID(),
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
    const covered = new Set([
      ...PROBES.map((p) => p.fn),
      ...RECORDS_PROBES.map((p) => p.fn),
      ...ADMIN_COMMANDS,
      ...GLOBAL_COMMANDS,
    ]);
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
      // Before the insider objects: their conflict declaration removes the declarer's own access.
      const purpose =
        which === "B"
          ? await purposeObjects(s, target, "caseManager", "legal", true)
          : await purposeObjects(s, target, "grcDirector", "grcDirector", false);
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
      const real: Targets = { case: target, ...seeded, ...inside, ...purpose, attachment };
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
      // CDF-73: the task assignee opens their own task, and the requester can end their own break-glass.
      const purpose = await purposeObjects(s, caseB, "caseManager", "legal", true);
      await s.as("legal");
      const [task] = await s.tx<{ v: boolean }[]>`select api.open_case_task(${purpose.task}) as v`;
      expect(task!.v).toBe(true);
      await s.expectError(
        "CDF_CONFLICT:BREAK_GLASS_NOT_ACTIVE",
        (tx) => tx`select api.end_break_glass(${purpose.breakGlass})`,
      );
    });
  });
});

const randomRecordsTargets = (): RecordsTargets => ({
  case: randomUUID(),
  hold: randomUUID(),
  release: randomUUID(),
  disposition: randomUUID(),
  certificate: randomUUID(),
});

/**
 * Takes case B through the whole records lifecycle inside the scenario: a hold placed and released by two
 * legal reviewers, then closure, archive, a short CONFIGURED class (test fixture), a disposition request,
 * approval by the GRC director and logical execution with a certificate.
 */
async function disposedCaseB(s: OwnerScenario, target: string): Promise<RecordsTargets> {
  await legalHoldTasks(s, target); // ADR-014: legal acts on a case through its hold tasks (CDF-73)
  await s.as("legal");
  const hold = await placeHold(s.tx, target);
  const [rel] = await s.tx<
    { id: string }[]
  >`select api.request_legal_hold_release(${hold}, ${JUSTIFICATION}) as id`;
  await s.as("legalB");
  await s.tx`select api.decide_legal_hold_release(${rel!.id}, true, ${DECISION})`;
  await makeEligible(s, target);
  const disposition = await requestDisposition(s.tx, target);
  await s.as("grcDirector");
  await s.tx`select api.decide_disposition(${disposition}, true, ${DECISION})`;
  await s.as("records");
  const [cert] = await s.tx<{ id: string }[]>`select api.execute_disposition(${disposition}) as id`;
  return { case: target, hold, release: rel!.id, disposition, certificate: cert!.id };
}

async function probeRecords(s: Scenario, actor: UserKey, real: RecordsTargets): Promise<string[]> {
  await s.as(actor);
  // A fresh request id, so the trace check below sees only the probes, not the fixture's own steps.
  await s.tx`select set_config('cdf.request_id', ${randomUUID()}, true)`;
  const mismatches: string[] = [];
  for (const probe of RECORDS_PROBES) {
    const onReal = await outcomeOf(s, probe, real, USERS[actor]);
    const onRandom = await outcomeOf(s, probe, randomRecordsTargets(), USERS[actor]);
    if (onReal !== probe.outcome || onRandom !== probe.outcome)
      mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
  }
  return mismatches;
}

describe("IDOR: records commands give outsiders the same answer for real objects as for random UUIDs", () => {
  // Everyone without records visibility of case B: case roles (a disposed case is gone for them, REC-T37),
  // roles without records permissions, and internal audit (RECORDS_VIEW, but cleared below RESTRICTED).
  const RECORDS_OUTSIDERS: UserKey[] = [
    "investigatorA",
    "investigatorB",
    "lead",
    "caseManager",
    "triage",
    "intake",
    "committee",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
  ];

  it.each(RECORDS_OUTSIDERS)(
    "%s against disposed case B and its hold, release, request and certificate",
    async (actor) => {
      await ownerScenario(async (s) => {
        const real = await disposedCaseB(s, caseB);
        expect(await probeRecords(s, actor, real)).toEqual([]);
        await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.refresh_disposition_eligibility()`);

        await s.as("dpo");
        const events = await s.tx<{ category: string; outcome: string }[]>`
        select category, outcome from audit.audit_event
        where actor_id = ${USERS[actor]} and request_id = nullif(current_setting('cdf.request_id', true), '')::uuid`;
        expect(events.filter((e) => e.category !== "SECURITY" || e.outcome !== "DENIED")).toEqual([]);
      });
    },
  );

  it.each<UserKey>(["records", "recordsB", "legal", "legalB"])(
    "%s against a hold on the restricted SECRET case (no assignment, clearance below SECRET)",
    async (actor) => {
      await scenario(async (s) => {
        // A disposition can never reach the live executive case, so those two ids stay random here;
        // REC-T05 and REC-T46 cover the restricted case in the records view.
        await s.as("grcDirector");
        const hold = await placeHold(s.tx, caseExec);
        const [rel] = await s.tx<
          { id: string }[]
        >`select api.request_legal_hold_release(${hold}, ${JUSTIFICATION}) as id`;
        const real = { ...randomRecordsTargets(), case: caseExec, hold, release: rel!.id };
        expect(await probeRecords(s, actor, real)).toEqual([]);
      });
    },
  );

  it("records staff get real answers from the same probes (the probes are not vacuous)", async () => {
    await ownerScenario(async (s) => {
      const real = await disposedCaseB(s, caseB);
      await s.as("internalAudit");
      expect(await s.tx`select * from api.list_records(null, ${caseB})`).toEqual([]);
      await s.as("legal");
      const rows = await s.tx<{ records_state: string }[]>`select * from api.list_records(null, ${caseB})`;
      expect(rows.map((r) => r.records_state)).toEqual(["DISPOSED"]);
      const [ok] = await s.tx<
        { v: boolean }[]
      >`select api.verify_disposition_certificate(${real.certificate}) as v`;
      expect(ok!.v).toBe(true);
      await s.expectError(
        "CDF_CONFLICT:HOLD_NOT_ACTIVE",
        (tx) => tx`select api.request_legal_hold_release(${real.hold}, ${JUSTIFICATION})`,
      );
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:REQUEST_NOT_PENDING",
        (tx) => tx`select api.decide_disposition(${real.disposition}, false, ${DECISION})`,
      );
    });
  });

  it("a revoked user gets nothing from any records probe", async () => {
    await ownerScenario(async (s) => {
      const real = await disposedCaseB(s, caseB);
      await s.as("revoked");
      const leaks: string[] = [];
      for (const probe of RECORDS_PROBES) {
        const got = await outcomeOf(s, probe, real, USERS.revoked);
        if (!["EMPTY", "FALSE", "NOT_FOUND"].includes(got) && !got.startsWith("ERROR CDF_UNAUTHENTICATED"))
          leaks.push(`${probe.fn}: ${got}`);
      }
      expect(leaks).toEqual([]);
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
      const purpose = await purposeObjects(s, caseB, "caseManager", "legal", true);
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
          { case: caseB, ...seeded, ...inside, ...purpose, attachment },
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
