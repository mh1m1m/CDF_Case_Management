// ADR-013 D5, RECORDS_RETENTION §4 (CDF-69 batch 4): once a case leaves ACTIVE its forms and interviews are
// part of the frozen record. Every forms and interviews command that would change content succeeds on an
// active case (checked first, then rolled back), is refused once the case is archived, and is refused as if
// the case did not exist once it is disposed. Reads stay available to case roles until disposal.
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { USERS, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";
import { DECISION, closeAndArchive, makeEligible, requestDisposition } from "../support/records";

let caseB: string;
beforeAll(async () => {
  caseB = await caseId("0002");
});

const REASON = "Synthetic: records freeze probe.";
const REGISTER = {
  evidence_count: "1",
  evidence_scope: "Synthetic evidence register scope",
  chain_of_custody_status: "مكتملة",
  storage_confirmation: "true",
};
const CANCELLATION = {
  missing_information: "Synthetic missing information.",
  completion_attempts: "Synthetic completion attempts.",
  cancellation_basis: "Synthetic cancellation basis.",
  decision_date: "2026-03-01",
};

interface Fixtures {
  draft: string;
  prepared: string;
  reviewed: string;
  planned: string;
  scheduled: string;
  noticed: string;
  rights: string;
  conducted: string;
  statement: { version: string; sha: string };
  acknowledged: string;
  preparedInterview: string;
  reviewedInterview: string;
  evidence: string;
}

const one = async <T>(q: Promise<readonly T[]>): Promise<T> => (await q)[0]!;

async function startForm(tx: Tx, code: string, data: unknown): Promise<string> {
  const { id } = await one(
    tx<
      { id: string }[]
    >`select api.start_form(${caseB}, ${code}, 'CONFIDENTIAL'::core.classification_level) as id`,
  );
  await tx`select * from api.save_form_draft(${id}, ${tx.json(data as never)})`;
  return id;
}

/** Interviews on case B by its investigator, advanced to the requested stage. */
async function interviewAt(s: OwnerScenario, stage: number) {
  await s.as("investigatorB");
  const { id } = await one(
    s.tx<{ id: string }[]>`select api.plan_interview(${caseB}, 'Synthetic records interview', null, 'WITNESS',
      'Witness Kappa (synthetic)', null, 'CONFIDENTIAL'::core.classification_level) as id`,
  );
  const steps = [
    () => s.tx`select api.schedule_interview(${id}, now() - interval '2 hours', 60, 'PHONE', null)`,
    () => s.tx`select api.issue_interview_notice(${id}, 'INVITATION', 'INTERNAL_EMAIL')`,
    () => s.tx`select api.record_interview_rights(${id}, 'VERBAL_ON_RECORD', 'SYNTHETIC-RIGHTS-V1')`,
    () =>
      s.tx`select api.record_interview_conducted(${id}, now() - interval '2 hours', now() - interval '1 hour')`,
  ];
  for (const step of steps.slice(0, stage)) await step();
  return id;
}

async function fixtures(s: OwnerScenario): Promise<Fixtures> {
  await s.as("investigatorB");
  const draft = await startForm(s.tx, "WB-FRM-11", REGISTER);
  const prepared = await startForm(s.tx, "WB-FRM-11", REGISTER);
  await s.tx`select api.prepare_form(${prepared})`;
  await s.as("caseManager");
  const reviewed = await startForm(s.tx, "WB-FRM-04", CANCELLATION);
  await s.tx`select api.prepare_form(${reviewed})`;
  await s.as("grcDirector");
  await s.tx`select api.review_form(${reviewed}, 'REVIEWED', null)`;

  const planned = await interviewAt(s, 0);
  const scheduled = await interviewAt(s, 1);
  const noticed = await interviewAt(s, 2);
  const rights = await interviewAt(s, 3);
  const conducted = await interviewAt(s, 4);
  const withStatement = await interviewAt(s, 4);
  const v = await one(
    s.tx<{ version: string; sha: string }[]>`select o_version_id as version, o_sha256 as sha
      from api.record_interview_statement(${withStatement}, 'SYNTHETIC statement.', 'en')`,
  );
  const acknowledged = await interviewAt(s, 4);
  const a = await one(
    s.tx<{ version: string; sha: string }[]>`select o_version_id as version, o_sha256 as sha
      from api.record_interview_statement(${acknowledged}, 'SYNTHETIC statement.', 'en')`,
  );
  await s.tx`select api.acknowledge_interview_statement(${a.version}, 'ELECTRONIC_ACK', ${a.sha})`;
  const preparedInterview = await interviewAt(s, 4);
  const p = await one(
    s.tx<{ version: string; sha: string }[]>`select o_version_id as version, o_sha256 as sha
      from api.record_interview_statement(${preparedInterview}, 'SYNTHETIC statement.', 'en')`,
  );
  await s.tx`select api.acknowledge_interview_statement(${p.version}, 'ELECTRONIC_ACK', ${p.sha})`;
  await s.tx`select api.transition_interview(${preparedInterview}, 'PREPARE', null)`;
  const reviewedInterview = await interviewAt(s, 4);
  const r = await one(
    s.tx<{ version: string; sha: string }[]>`select o_version_id as version, o_sha256 as sha
      from api.record_interview_statement(${reviewedInterview}, 'SYNTHETIC statement.', 'en')`,
  );
  await s.tx`select api.acknowledge_interview_statement(${r.version}, 'ELECTRONIC_ACK', ${r.sha})`;
  await s.tx`select api.transition_interview(${reviewedInterview}, 'PREPARE', null)`;
  // A lead on the case reviews, so the case manager (CASE_EDIT_ALL) can approve as a third person.
  await s.as("caseManager");
  await s.tx`select api.assign_case(${caseB}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`;
  await s.as("lead");
  await s.tx`select api.transition_interview(${reviewedInterview}, 'REVIEW', null)`;

  await s.as("investigatorB");
  const ev = await one(
    s.tx<{ evidence: string; version: string }[]>`select o_evidence_id as evidence, o_version_id as version
      from api.register_evidence_version(${caseB}, null, 'Synthetic interview recording', null, 'DOCUMENT',
        'Synthetic source', null, 'CONFIDENTIAL'::core.classification_level, 'rec.pdf', 'application/pdf', 512,
        ${"a".repeat(64)})`,
  );
  await s.tx`select api.complete_evidence_version(${ev.version}, 'CLEAN', 'records-scanner')`;

  return {
    draft,
    prepared,
    reviewed,
    planned,
    scheduled,
    noticed,
    rights,
    conducted,
    statement: v,
    acknowledged,
    preparedInterview,
    reviewedInterview,
    evidence: ev.evidence,
  };
}

interface Command {
  fn: string;
  actor: UserKey;
  call: (tx: Tx, f: Fixtures) => Promise<unknown>;
}

// One entry per forms and interviews command that changes content (ADR-011, ADR-012).
const COMMANDS: Command[] = [
  {
    fn: "start_form",
    actor: "investigatorB",
    call: (tx) => tx`select api.start_form(${caseB}, 'WB-FRM-11', 'CONFIDENTIAL'::core.classification_level)`,
  },
  {
    fn: "save_form_draft",
    actor: "investigatorB",
    call: (tx, f) =>
      tx`select * from api.save_form_draft(${f.draft}, ${tx.json({ ...REGISTER, evidence_count: "2" } as never)})`,
  },
  { fn: "prepare_form", actor: "investigatorB", call: (tx, f) => tx`select api.prepare_form(${f.draft})` },
  {
    fn: "withdraw_form",
    actor: "investigatorB",
    call: (tx, f) => tx`select api.withdraw_form(${f.draft}, ${REASON})`,
  },
  {
    fn: "review_form",
    actor: "caseManager",
    call: (tx, f) => tx`select api.review_form(${f.prepared}, 'REVIEWED', null)`,
  },
  {
    fn: "approve_form",
    actor: "grcDeputy",
    call: (tx, f) => tx`select api.approve_form(${f.reviewed}, 'APPROVED', null)`,
  },
  {
    fn: "plan_interview",
    actor: "investigatorB",
    call: (tx) => tx`select api.plan_interview(${caseB}, 'Synthetic late interview', null, 'WITNESS',
      'Witness Kappa (synthetic)', null, 'CONFIDENTIAL'::core.classification_level)`,
  },
  {
    fn: "add_interview_participant",
    actor: "investigatorB",
    call: (tx, f) =>
      tx`select api.add_interview_participant(${f.planned}, ${USERS.caseManager}, 'NOTE_TAKER')`,
  },
  {
    fn: "schedule_interview",
    actor: "investigatorB",
    call: (tx, f) =>
      tx`select api.schedule_interview(${f.planned}, now() + interval '1 day', 60, 'PHONE', null)`,
  },
  {
    fn: "issue_interview_notice",
    actor: "investigatorB",
    call: (tx, f) => tx`select api.issue_interview_notice(${f.scheduled}, 'INVITATION', 'INTERNAL_EMAIL')`,
  },
  {
    fn: "record_interview_rights",
    actor: "investigatorB",
    call: (tx, f) =>
      tx`select api.record_interview_rights(${f.noticed}, 'VERBAL_ON_RECORD', 'SYNTHETIC-RIGHTS-V1')`,
  },
  {
    fn: "record_interview_conducted",
    actor: "investigatorB",
    call: (tx, f) =>
      tx`select api.record_interview_conducted(${f.rights}, now() - interval '2 hours', now() - interval '1 hour')`,
  },
  {
    fn: "record_interview_statement",
    actor: "investigatorB",
    call: (tx, f) =>
      tx`select * from api.record_interview_statement(${f.conducted}, 'SYNTHETIC late statement.', 'en')`,
  },
  {
    fn: "acknowledge_interview_statement",
    actor: "investigatorB",
    call: (tx, f) =>
      tx`select api.acknowledge_interview_statement(${f.statement.version}, 'ELECTRONIC_ACK', ${f.statement.sha})`,
  },
  {
    fn: "link_interview_recording",
    actor: "investigatorB",
    call: (tx, f) => tx`select api.link_interview_recording(${f.conducted}, ${f.evidence})`,
  },
  {
    fn: "transition_interview:PREPARE",
    actor: "investigatorB",
    call: (tx, f) => tx`select api.transition_interview(${f.acknowledged}, 'PREPARE', null)`,
  },
  {
    fn: "transition_interview:CANCEL",
    actor: "investigatorB",
    call: (tx, f) => tx`select api.transition_interview(${f.planned}, 'CANCEL', ${REASON})`,
  },
  {
    fn: "transition_interview:REVIEW",
    actor: "caseManager",
    call: (tx, f) => tx`select api.transition_interview(${f.preparedInterview}, 'REVIEW', null)`,
  },
  {
    fn: "transition_interview:RETURN",
    actor: "caseManager",
    call: (tx, f) => tx`select api.transition_interview(${f.preparedInterview}, 'RETURN', ${REASON})`,
  },
  {
    fn: "transition_interview:APPROVE",
    actor: "caseManager",
    call: (tx, f) => tx`select api.transition_interview(${f.reviewedInterview}, 'APPROVE', null)`,
  },
];

/** Runs the command as its actor in a savepoint and returns the CDF error prefix, or "OK"; never keeps changes. */
async function attempt(s: OwnerScenario, c: Command, f: Fixtures): Promise<string> {
  await s.as(c.actor);
  let outcome = "OK";
  try {
    await s.tx.savepoint(async (sp) => {
      await c.call(sp as unknown as Tx, f);
      throw new Error("ROLLBACK_PROBE");
    });
  } catch (error) {
    const message = (error as Error).message;
    if (message !== "ROLLBACK_PROBE") outcome = message.split(":")[0]!;
  }
  return outcome;
}

async function outcomes(s: OwnerScenario, f: Fixtures): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const c of COMMANDS) result[c.fn] = await attempt(s, c, f);
  return result;
}

const all = (value: string) => Object.fromEntries(COMMANDS.map((c) => [c.fn, value]));

async function contentCounts(s: OwnerScenario) {
  await s.asOwner();
  return one(
    s.tx<{ forms: number; versions: number; interviews: number; statements: number; events: number }[]>`
    select (select count(*)::int from forms.form_instance where case_id = ${caseB}) as forms,
           (select count(*)::int from forms.form_instance_version v join forms.form_instance i on i.id = v.instance_id
             where i.case_id = ${caseB}) as versions,
           (select count(*)::int from case_mgmt.interview where case_id = ${caseB}) as interviews,
           (select count(*)::int from case_mgmt.interview_statement_version v join case_mgmt.interview i on i.id = v.interview_id
             where i.case_id = ${caseB}) as statements,
           (select count(*)::int from audit.audit_event where case_id = ${caseB} and category = 'BUSINESS') as events`,
  );
}

describe("forms and interviews follow the records lifecycle", () => {
  it("every content command works on the active case (the probes are not vacuous)", async () => {
    await ownerScenario(async (s) => {
      const f = await fixtures(s);
      expect(await outcomes(s, f)).toEqual(all("OK"));
    });
  });

  it("an archived case refuses every forms and interviews content command; reads still work", async () => {
    await ownerScenario(async (s) => {
      const f = await fixtures(s);
      await closeAndArchive(s, caseB);
      const before = await contentCounts(s);
      expect(await outcomes(s, f)).toEqual(all("CDF_FORBIDDEN"));
      expect(await contentCounts(s)).toEqual(before);

      await s.as("investigatorB");
      expect((await one(s.tx<{ v: boolean }[]>`select api.open_form_instance(${f.draft}) as v`)).v).toBe(
        true,
      );
      expect((await one(s.tx<{ v: boolean }[]>`select api.open_interview(${f.conducted}) as v`)).v).toBe(
        true,
      );
    });
  });

  it("a disposed case answers every forms and interviews command as if it did not exist", async () => {
    await ownerScenario(async (s) => {
      const f = await fixtures(s);
      await makeEligible(s, caseB);
      const disposition = await requestDisposition(s.tx, caseB);
      await s.as("grcDirector");
      await s.tx`select api.decide_disposition(${disposition}, true, ${DECISION})`;
      await s.as("records");
      await s.tx`select api.execute_disposition(${disposition})`;
      const before = await contentCounts(s);
      expect(await outcomes(s, f)).toEqual(all("CDF_NOT_FOUND"));
      expect(await contentCounts(s)).toEqual(before);

      await s.as("investigatorB");
      expect((await one(s.tx<{ v: boolean }[]>`select api.open_form_instance(${f.draft}) as v`)).v).toBe(
        false,
      );
      expect((await one(s.tx<{ v: boolean }[]>`select api.open_interview(${f.conducted}) as v`)).v).toBe(
        false,
      );
    });
  });
});
