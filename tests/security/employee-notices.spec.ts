// Business architecture rebase, migration 1990 (ADR-037; gap P11-G5; owner Q&A Q90, Q94; rebase prompt §53, §58):
// kinds of employee notice. A rights notice and a decision notice join the defence notice. Only a defence notice has
// a due date and takes a response. A decision notice concerns a competent-authority decision about the subject and
// starts the grievance window under the rule set in force when it is issued; a grievance filed on it is measured
// against that window and flagged late, never refused. Every step runs through the api.* commands as
// `authenticated`; the owner connection is used only for fixtures (a notice issued in the past) and to probe the
// table constraints.
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, scenario, type Scenario } from "../support/db";
import { REASON, committeeIds } from "../support/committee";
import { draftPackage, requestLegalReview, voteOnPackage, type PackageFixture } from "../support/decision";

const TEXT = "Synthetic: unique-notice-marker-1990 for the subject.";
const GROUNDS = "Synthetic: unique-grounds-marker-1990, the decision ignored my defence.";

let caseA: string, caseB: string, ic: string, gc: string;
beforeAll(async () => {
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
  ({ ic, gc } = await committeeIds());
});

interface Subjects {
  sigma: string;
  sigmaAllegation: string;
  tau: string;
  tauAllegation: string;
}

/** Employee Sigma (from the package fixture, linked to employee) and Employee Tau (linked to employeeB) on case B. */
async function linkSubjects(s: Scenario, sigma: string, sigmaAllegation: string): Promise<Subjects> {
  await s.as("caseManager");
  const [tau] = await s.tx<{ id: string }[]>`
    select api.add_case_subject(${caseB}, 'Employee Tau (synthetic)', 'EMPLOYEE', null) as id`;
  const [a] = await s.tx<{ id: string }[]>`
    select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: allegation against Employee Tau.', ${tau!.id}, null, null) as id`;
  await s.tx`select api.link_subject_portal_account(${sigma}, ${USERS.employee}, ${REASON})`;
  await s.tx`select api.link_subject_portal_account(${tau!.id}, ${USERS.employeeB}, ${REASON})`;
  return { sigma, sigmaAllegation, tau: tau!.id, tauAllegation: a!.id };
}

interface Decided extends PackageFixture, Subjects {
  decision: string;
}

/** A package on case B whose only item is a sanction on Employee Sigma (the case-wide corrective action withdrawn),
 *  adopted, reviewed by legal and decided by the CEO with `outcome`. Tau is not in the decision. */
async function decided(s: Scenario, outcome = "APPROVE_AS_RECOMMENDED"): Promise<Decided> {
  const f = await draftPackage(s, ic, caseB);
  const subjects = await linkSubjects(s, f.subject, f.allegation);
  await s.as("committeeSecretary");
  await s.tx`select api.withdraw_recommendation_item(${f.corrective}, ${REASON})`;
  await voteOnPackage(s, f);
  const { request } = await requestLegalReview(s, f);
  await s.as("legalB");
  await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
  await s.as("committeeSecretary");
  await s.tx`select api.submit_to_authority(${f.pkg})`;
  const [d] = await s.tx<{ id: string }[]>`
    select api.record_authority_decision(${f.pkg}, 'CEO', ${outcome}, now() - interval '1 hour',
      'Chief Executive (synthetic)', 'MEMO-DEMO-0190', null, ${REASON}) as id`;
  return { ...f, ...subjects, decision: d!.id };
}

/** Fixture: a Grievance Committee rule version whose window starts at ISSUE, in force from a second ago (owner insert,
 *  so a rule change at now() stays possible afterwards). */
async function issueBasisRule(s: Scenario): Promise<void> {
  await s.asOwner();
  await s.tx`
    with cur as (
      update committee.rule_set set effective_to = now() - interval '1 second'
      where committee_id = ${gc} and effective_to is null returning *)
    insert into committee.rule_set
    select (jsonb_populate_record(null::committee.rule_set, to_jsonb(cur) || jsonb_build_object(
      'id', gen_random_uuid(), 'effective_from', now() - interval '1 second', 'effective_to', null,
      'grievance_window_start_basis', 'ISSUE', 'source_status', 'APPROVED', 'reason', ${REASON}::text,
      'created_by', ${USERS.platformAdmin}::uuid))).*
    from cur`;
}

const rightsNotice = (s: Scenario, subject: string, allegations: string[]) =>
  s.tx<{ id: string }[]>`select api.issue_rights_notice(${subject}, ${TEXT}, ${allegations}::uuid[]) as id`;
const decisionNotice = (s: Scenario, subject: string, decision: string) =>
  s.tx<{ id: string }[]>`select api.issue_decision_notice(${subject}, ${decision}, ${TEXT}) as id`;

interface MyNotice {
  notice_id: string;
  sequence_no: number;
  kind: string;
  due_at: string | null;
  grievance_window_ends_at: string | null;
  status: string;
  items: unknown[];
}
async function myNotices(s: Scenario): Promise<MyNotice[]> {
  const [r] = await s.tx<{ n: MyNotice[] }[]>`select api.my_defence_notices() as n`;
  return r!.n;
}
async function myInApp(
  s: Scenario,
): Promise<{ template_code: string; object_id: string; deep_link: string }[]> {
  return s.tx<{ template_code: string; object_id: string; deep_link: string }[]>`
    select template_code, object_id, deep_link from notify.outbox where channel = 'IN_APP' order by created_at, template_code`;
}

describe("kinds of employee notice (migration 1990, P11-G5, ADR-037)", () => {
  it("a rights notice tells the subject their rights, is acknowledged, and takes no response", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      const [subject] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
      const [allegation] = await s.tx<{ id: string }[]>`
        select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: allegation against Employee Sigma.', ${subject!.id},
          null, null) as id`;
      const ids = await linkSubjects(s, subject!.id, allegation!.id);

      // The scope may be withheld at the start: no allegation is allowed; any allegation shown is the subject's own.
      await s.as("caseManager");
      const [bare] = await rightsNotice(s, ids.sigma, []);
      const [scoped] = await rightsNotice(s, ids.sigma, [ids.sigmaAllegation]);
      await s.expectError("CDF_INVALID:allegation_ids", () =>
        rightsNotice(s, ids.sigma, [ids.tauAllegation]),
      );
      await s.expectError("CDF_INVALID:allegation_ids", () =>
        rightsNotice(s, ids.sigma, [ids.sigmaAllegation, ids.sigmaAllegation]),
      );
      await s.expectError(
        "CDF_INVALID:notice_text",
        (tx) => tx`select api.issue_rights_notice(${ids.sigma}, 'short', null)`,
      );
      // People who see the case without editing it, and people who cannot see it, cannot issue one.
      await s.as("investigatorB");
      await s.expectError("CDF_FORBIDDEN", () => rightsNotice(s, ids.sigma, []));
      for (const u of ["investigatorA", "employee", "platformAdmin"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", () => rightsNotice(s, ids.sigma, []));
      }
      await s.as("revoked");
      await s.expectError("CDF_UNAUTHENTICATED", () => rightsNotice(s, ids.sigma, []));
      await s.as(null);
      await s.expectError("permission denied", () => rightsNotice(s, ids.sigma, []));

      // A defence notice is unchanged: a DEFENCE notice with its due date.
      await s.as("caseManager");
      const [defence] = await s.tx<{ id: string }[]>`
        select api.issue_defence_notice(${ids.sigma}, 'Synthetic: you are invited to respond.',
          ${[ids.sigmaAllegation]}::uuid[], now() + interval '10 days') as id`;
      const rows = await s.tx<{ id: string; kind: string; has_due: boolean; sequence_no: number }[]>`
        select id, kind, due_at is not null as has_due, sequence_no from grievance.defence_notice
        where subject_id = ${ids.sigma} order by sequence_no`;
      expect(rows).toEqual([
        { id: bare!.id, kind: "RIGHTS", has_due: false, sequence_no: 1 },
        { id: scoped!.id, kind: "RIGHTS", has_due: false, sequence_no: 2 },
        { id: defence!.id, kind: "DEFENCE", has_due: true, sequence_no: 3 },
      ]);

      // The subject sees their own notices with their kind; the other subject sees none of them.
      await s.as("employee");
      // Notices issued in one transaction share issued_at, so the list is put in sequence order here.
      const mine = (await myNotices(s)).sort((a, b) => a.sequence_no - b.sequence_no);
      expect(mine.map((n) => [n.kind, n.due_at === null, n.items.length])).toEqual([
        ["RIGHTS", true, 0],
        ["RIGHTS", true, 1],
        ["DEFENCE", false, 1],
      ]);
      expect(mine.every((n) => n.grievance_window_ends_at === null)).toBe(true);
      await s.tx`select api.acknowledge_defence_notice(${scoped!.id})`;
      // Only a defence notice takes a response, whichever path records it.
      await s.expectError(
        "CDF_CONFLICT:NOT_A_DEFENCE_NOTICE",
        (tx) =>
          tx`select api.submit_defence_response(${scoped!.id}, 'Synthetic: my response to a rights notice.')`,
      );
      await s.expectError(
        "CDF_CONFLICT:NOT_A_DEFENCE_NOTICE",
        (tx) =>
          tx`select api.submit_defence_response(${bare!.id}, 'Synthetic: my response to a rights notice.')`,
      );
      await s.tx`select api.submit_defence_response(${defence!.id}, 'Synthetic: my response to the defence notice.')`;
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:NOT_A_DEFENCE_NOTICE",
        (tx) => tx`select api.record_defence_response(${bare!.id}, 'EMAIL', now(),
          'Synthetic: a reply received by email.', 'EMAIL-DEMO-1990')`,
      );
      const after = await s.tx<{ id: string; status: string }[]>`
        select n.id, n.status from grievance.defence_notice n where n.subject_id = ${ids.sigma} order by n.sequence_no`;
      expect(after.map((n) => n.status)).toEqual(["ISSUED", "ACKNOWLEDGED", "RESPONDED"]);
      expect(await s.tx`select notice_id from grievance.defence_response`).toEqual([
        { notice_id: defence!.id },
      ]);
      await s.as("employeeB");
      expect(await myNotices(s)).toEqual([]);
      expect(await s.tx`select id from grievance.defence_notice`).toEqual([]);

      // Notified through the portal link, by kind, with ids only.
      await s.as("employee");
      expect(await myInApp(s)).toEqual([
        ...[bare!.id, scoped!.id].map((id) => ({
          template_code: "RIGHTS_NOTICE_ISSUED",
          object_id: id,
          deep_link: `/my-defence/${id}`,
        })),
        {
          template_code: "DEFENCE_NOTICE_ISSUED",
          object_id: defence!.id,
          deep_link: `/my-defence/${defence!.id}`,
        },
      ]);
      await s.as("employeeB");
      expect(await myInApp(s)).toEqual([]);

      // Audit: ids and counts, never the notice text.
      await s.asOwner();
      const events = await s.tx<
        { action: string; metadata: Record<string, unknown>; reason: string | null }[]
      >`
        select action, metadata, reason from audit.audit_event
        where object_type = 'defence_notice' and object_id = any(${[bare!.id, scoped!.id]}::text[]) order by seq`;
      expect(events.map((e) => [e.action, e.metadata])).toEqual([
        ["RIGHTS_NOTICE_ISSUED", { subject_id: ids.sigma, sequence_no: 1, allegations: 0 }],
        ["RIGHTS_NOTICE_ISSUED", { subject_id: ids.sigma, sequence_no: 2, allegations: 1 }],
        ["DEFENCE_NOTICE_ACKNOWLEDGED", {}],
      ]);
      expect(JSON.stringify(events)).not.toContain("unique-notice-marker");
    });
  });

  it("a decision notice concerns the subject, starts the grievance window and is grieved against that window (Q94)", async () => {
    await ownerScenario(async (s) => {
      const f = await decided(s);
      await s.asOwner();
      // Fixture (2040, DEC-F15): an ISSUE-basis rule, so the window starts at issue as 1990 built it. Under the default
      // DELIVERY basis it waits for the delivery instead (T-AMB-081, migration 2040 suite).
      await issueBasisRule(s);
      const [rule] = await s.tx<{ id: string }[]>`
        select id from committee.rule_set where committee_id = ${gc} and effective_to is null`;

      // The decision must be on the subject's case and concern them; a decision elsewhere answers like none at all.
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:SUBJECT_NOT_IN_DECISION", () => decisionNotice(s, f.tau, f.decision));
      await s.expectError("CDF_INVALID:authority_decision_id", () =>
        decisionNotice(s, f.sigma, "00000000-0000-4000-8000-000000000000"),
      );
      const [other] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseA}, 'Employee Upsilon (synthetic)', 'EMPLOYEE', null) as id`;
      await s.expectError("CDF_INVALID:authority_decision_id", () =>
        decisionNotice(s, other!.id, f.decision),
      );
      await s.as("investigatorB");
      await s.expectError("CDF_FORBIDDEN", () => decisionNotice(s, f.sigma, f.decision));
      for (const u of ["investigatorA", "employee", "employeeB", "platformAdmin"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", () => decisionNotice(s, f.sigma, f.decision));
      }
      await s.as("revoked");
      await s.expectError("CDF_UNAUTHENTICATED", () => decisionNotice(s, f.sigma, f.decision));

      // Whoever may issue a defence notice issues it; once per subject and decision. The committee secretary does not
      // see the case, so, as for a defence notice, the command answers as if the subject did not exist.
      await s.as("committeeSecretary");
      await s.expectError("CDF_NOT_FOUND", () => decisionNotice(s, f.sigma, f.decision));
      await s.as("caseManager");
      const [n] = await decisionNotice(s, f.sigma, f.decision);
      await s.expectError("CDF_CONFLICT:ALREADY_NOTIFIED", () => decisionNotice(s, f.sigma, f.decision));
      const [row] = await s.tx<
        {
          kind: string;
          due_at: string | null;
          authority_decision_id: string;
          grievance_rule_set_id: string;
          grievance_window_days: number;
          window_from_issue: string;
        }[]
      >`
        select kind, due_at, authority_decision_id, grievance_rule_set_id, grievance_window_days,
               (grievance_window_ends_at - issued_at)::text as window_from_issue
        from grievance.defence_notice where id = ${n!.id}`;
      expect(row).toEqual({
        kind: "DECISION",
        due_at: null,
        authority_decision_id: f.decision,
        grievance_rule_set_id: rule!.id,
        grievance_window_days: 30,
        window_from_issue: "30 days",
      });

      // A later rule change does not move a window already started.
      await s.as("platformAdmin");
      await s.tx`select api.set_committee_rule_set(${gc}, now(), 'MAJORITY_ELIGIBLE', null, true, 3, true, 10, 'CHAIR',
                   'NO_DECISION', 'APPROVED', ${REASON})`;

      // The subject sees the kind and the end of the window, acknowledges, and cannot respond to it.
      await s.as("employee");
      const [mine] = await myNotices(s);
      expect(mine).toMatchObject({ notice_id: n!.id, kind: "DECISION", due_at: null, status: "ISSUED" });
      expect(mine!.grievance_window_ends_at).not.toBeNull();
      expect(await myInApp(s)).toEqual([
        { template_code: "DECISION_NOTICE_ISSUED", object_id: n!.id, deep_link: `/my-defence/${n!.id}` },
      ]);
      await s.tx`select api.acknowledge_defence_notice(${n!.id})`;
      await s.expectError(
        "CDF_CONFLICT:NOT_A_DEFENCE_NOTICE",
        (tx) => tx`select api.submit_defence_response(${n!.id}, 'Synthetic: a response to a decision.')`,
      );

      // Only the subject behind the notice files on it; anyone else meets NOT_FOUND.
      for (const u of ["employeeB", "caseManager", "committeeSecretary", "platformAdmin"] as const) {
        await s.as(u);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.file_grievance_on_decision_notice(${n!.id}, ${GROUNDS})`,
        );
      }
      await s.as("employee");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.file_grievance_on_decision_notice(${"00000000-0000-4000-8000-000000000000"}, ${GROUNDS})`,
      );
      const [g] = await s.tx<{ id: string }[]>`
        select api.file_grievance_on_decision_notice(${n!.id}, ${GROUNDS}) as id`;
      await s.expectError(
        "CDF_CONFLICT:GRIEVANCE_OPEN",
        (tx) => tx`select api.file_grievance_on_decision_notice(${n!.id}, ${GROUNDS})`,
      );
      expect(await s.tx`select id from grievance.grievance`).toEqual([{ id: g!.id }]);
      await s.asOwner();
      const [grievance] = await s.tx<
        {
          kind: string;
          channel: string;
          grievant_subject_id: string;
          decision_notice_id: string;
          rule_set_id: string;
          window_days: number;
          is_late: boolean;
          admissibility_decider: string;
          status: string;
          contested_is_decision: boolean;
        }[]
      >`
        select g.kind, g.channel, g.grievant_subject_id, g.decision_notice_id, g.rule_set_id, g.window_days, g.is_late,
               g.admissibility_decider, g.status,
               g.contested_decision_date = (select d.decided_at from decision.authority_decision d
                                            where d.id = ${f.decision}) as contested_is_decision
        from grievance.grievance g where g.id = ${g!.id}`;
      expect(grievance).toEqual({
        kind: "LINKED",
        channel: "EMPLOYEE_PORTAL",
        grievant_subject_id: f.sigma,
        decision_notice_id: n!.id,
        rule_set_id: rule!.id,
        window_days: 30,
        is_late: false,
        admissibility_decider: "SECRETARY",
        status: "RECEIVED",
        contested_is_decision: true,
      });

      // Audit: ids, codes and dates only; neither the notice text nor the grounds.
      const [issued] = await s.tx<{ action: string; metadata: Record<string, unknown> }[]>`
        select action, metadata from audit.audit_event where object_type = 'defence_notice' and object_id = ${n!.id}
          and action = 'DECISION_NOTICE_ISSUED'`;
      expect(Object.keys(issued!.metadata).sort()).toEqual([
        "authority_decision_id",
        "rule_set_id",
        "sequence_no",
        "subject_id",
        "window_days",
        "window_ends_at",
      ]);
      expect(issued!.metadata).toMatchObject({
        authority_decision_id: f.decision,
        rule_set_id: rule!.id,
        window_days: 30,
      });
      const [filed] = await s.tx<{ metadata: Record<string, unknown>; reason: string | null }[]>`
        select metadata, reason from audit.audit_event where object_type = 'grievance' and object_id = ${g!.id}
          and action = 'GRIEVANCE_FILED'`;
      expect(filed!.metadata).toMatchObject({
        kind: "LINKED",
        channel: "EMPLOYEE_PORTAL",
        is_late: false,
        window_days: 30,
        rule_set_id: rule!.id,
        decision_notice_id: n!.id,
      });
      const all = await s.tx`select reason, metadata from audit.audit_event
        where object_id = any(${[n!.id, g!.id]}::text[])`;
      expect(JSON.stringify(all)).not.toMatch(/unique-(notice|grounds)-marker/);
    });
  });

  it("a grievance after the window is flagged late and still received; a filing needs a decision notice", async () => {
    await ownerScenario(async (s) => {
      const f = await decided(s);
      await s.as("caseManager");
      const [rights] = await rightsNotice(s, f.sigma, []);
      // Fixture: a decision notice issued 40 days ago under the 30-day rule (the commands only issue at now()).
      await s.asOwner();
      const [old] = await s.tx<{ id: string }[]>`
        insert into grievance.defence_notice (case_id, subject_id, sequence_no, notice_text, issued_by, issued_at, kind,
                                              authority_decision_id, grievance_rule_set_id, grievance_window_days,
                                              grievance_window_ends_at)
        select ${caseB}, ${f.sigma}, 9, ${TEXT}, ${USERS.caseManager}, now() - interval '40 days', 'DECISION', ${f.decision},
               r.id, 30, now() - interval '10 days'
        from committee.rule_set r where r.committee_id = ${gc} and r.effective_to is null
        returning id`;
      await s.as("employee");
      await s.expectError(
        "CDF_CONFLICT:NOT_A_DECISION_NOTICE",
        (tx) => tx`select api.file_grievance_on_decision_notice(${rights!.id}, ${GROUNDS})`,
      );
      const [g] = await s.tx<{ id: string }[]>`
        select api.file_grievance_on_decision_notice(${old!.id}, ${GROUNDS}) as id`;
      const [row] = await s.tx<{ is_late: boolean; status: string; window_days: number }[]>`
        select is_late, status, window_days from grievance.grievance where id = ${g!.id}`;
      expect(row).toEqual({ is_late: true, status: "RECEIVED", window_days: 30 });
    });
  });

  it("a decision that returns the package to the committee is not notified", async () => {
    await ownerScenario(async (s) => {
      const f = await decided(s, "RETURN_TO_COMMITTEE");
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:DECISION_NOT_FINAL", () => decisionNotice(s, f.sigma, f.decision));
    });
  });

  it("each kind keeps its shape whatever writes it, a kind never changes, and a closed case takes no notice", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      const [subject] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
      const [n] = await rightsNotice(s, subject!.id, []);
      await s.asOwner();
      const insert = (kind: string, due: boolean) =>
        s.tx`insert into grievance.defence_notice (case_id, subject_id, sequence_no, notice_text, due_at, issued_by, kind)
             values (${caseB}, ${subject!.id}, 7, ${TEXT}, ${due ? new Date(Date.now() + 86400_000) : null},
                     ${USERS.caseManager}, ${kind})`;
      await s.expectError("new row for relation", () => insert("RIGHTS", true));
      await s.expectError("new row for relation", () => insert("DEFENCE", false));
      await s.expectError("new row for relation", () => insert("DECISION", false)); // no decision, no window
      await s.expectError("new row for relation", () => insert("NOTICE", false));
      await s.expectError(
        "defence notice",
        (tx) => tx`update grievance.defence_notice set kind = 'DEFENCE' where id = ${n!.id}`,
      );
      await s.expectError(
        "new row for relation",
        (tx) =>
          tx`update grievance.defence_notice set status = 'RESPONDED', closed_at = now() where id = ${n!.id}`,
      );
      // Only a LINKED grievance names a decision notice.
      await s.expectError(
        "new row for relation",
        (
          tx,
        ) => tx`insert into grievance.grievance (case_id, kind, grievant_label, channel, original_submission_date,
                     contested_decision_date, grounds, original_document_reference, rule_set_id, window_days, is_late,
                     admissibility_decider, recorded_by, decision_notice_id)
                   select ${caseB}, 'STANDALONE', 'Employee Sigma (synthetic)', 'EMAIL', now(), now(), ${GROUNDS},
                     'EMAIL-DEMO-1990', r.id, 30, false, 'SECRETARY', ${USERS.committeeSecretary}, ${n!.id}
                   from committee.rule_set r where r.committee_id = ${gc} and r.effective_to is null`,
      );
      // A case that has left ACTIVE takes no new notice of any kind.
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', 'Synthetic: screened out for the notice suite.')`;
      await s.expectError("CDF_CONFLICT:CASE_NOT_ACTIVE", () => rightsNotice(s, subject!.id, []));
    });
  });

  it("the catalogue follows: S092 is the rights notice, P11-G5 is closed and the modules record 1990", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const statuses = await s.tx<{ target_event: string; gap_ref: string | null }[]>`
        select target_event, gap_ref from config.legacy_status_map where legacy_code = 'S092' order by catalogue`;
      expect(statuses).toEqual([
        { target_event: "RIGHTS_NOTICE_ISSUED", gap_ref: null },
        { target_event: "RIGHTS_NOTICE_ISSUED", gap_ref: null },
      ]);
      const refs = await s.tx`
        select legacy_id from config.legacy_form_map where gap_ref = 'P11-G5'
        union all select legacy_code from config.legacy_status_map where gap_ref = 'P11-G5'`;
      expect(refs).toEqual([]);
      const modules = await s.tx<{ code: string; commands: string[]; delivered_in: string[] }[]>`
        select code, commands, delivered_in from config.target_module
        where code in ('EMPLOYEE_NOTICE', 'GRIEVANCE_SUBMISSION') order by code`;
      expect(modules).toEqual([
        {
          code: "EMPLOYEE_NOTICE",
          commands: [
            "api.issue_defence_notice",
            "api.acknowledge_defence_notice",
            "api.my_defence_notices",
            "api.issue_rights_notice",
            "api.issue_decision_notice",
          ],
          delivered_in: ["1910", "1990"],
        },
        {
          code: "GRIEVANCE_SUBMISSION",
          commands: ["api.file_grievance", "api.record_grievance", "api.file_grievance_on_decision_notice"],
          delivered_in: ["1910", "1990"],
        },
      ]);
    });
  });
});
