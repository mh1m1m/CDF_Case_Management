// Business architecture rebase, migration 2099 (CDF-247; ADR-045): findings of an allegation that has left the case.
// A subject correction is refused while an open allegation about the wrong subject carries any finding, as a split is,
// so no superseded allegation carries one (ADR-059). A finding of a withdrawn allegation stays with it (ADR-045 §2) but
// is put to no vote and no legal review, as the secretary's choices (R1, 2060) and CDF-213 already have it. Every step
// runs through the api.* commands as the acting user; the owner connection only reads.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, scenario, type OwnerScenario, type Scenario } from "../support/db";
import { committeeIds, openWithPresent, scheduleMeeting, seat } from "../support/committee";
import {
  DECISION_SEATS,
  DECISION_VOTERS,
  authorityRuleFor,
  caseFacts,
  voteOnPackage,
  type PackageFixture,
} from "../support/decision";

const REASON = "Synthetic: findings of a closed allegation test reason.";
const RATIONALE = "Synthetic: finding rationale text.";
let caseB: string, case4: string, ic: string;

beforeAll(async () => {
  [caseB, case4] = await Promise.all([caseId("0002"), caseId("0004")]);
  ({ ic } = await committeeIds());
});

/** The first column of the first row. */
const one = async (q: Promise<readonly Record<string, unknown>[]>): Promise<string> =>
  Object.values((await q)[0]!)[0] as string;

const correct = (tx: Scenario["tx"], wrong: string, right: string) =>
  tx`select api.correct_case_subject(${wrong}, ${right}, ${REASON}) as id`;

/** As the case manager on case 4: an investigation, the wrongly identified subject (linked to the employee portal
 *  account) and the correct one. */
async function correctionCase(s: Scenario) {
  await s.as("caseManager");
  const proceeding = await one(
    s.tx`select api.open_proceeding(${case4}, 'INVESTIGATION', null, ${REASON}) as id`,
  );
  const wrong = await one(
    s.tx`select api.add_case_subject(${case4}, 'Employee Rho (synthetic)', 'EMPLOYEE', null) as id`,
  );
  const right = await one(
    s.tx`select api.add_case_subject(${case4}, 'Employee Kappa (synthetic)', 'EMPLOYEE', null) as id`,
  );
  const link = await one(
    s.tx`select api.link_subject_portal_account(${wrong}, ${USERS.employee}, ${REASON}) as id`,
  );
  return { proceeding, wrong, right, link };
}

/** Nothing the correction would write was written: the allegation is open with no successor, the subject keeps its
 *  status, link and notice, and no correction or event exists. */
async function nothingCorrected(
  s: OwnerScenario,
  c: { wrong: string; link: string },
  allegation: string,
  notice: string,
): Promise<void> {
  await s.asOwner();
  expect(await s.tx`select status from case_mgmt.allegation where id = ${allegation}`).toEqual([
    { status: "OPEN" },
  ]);
  expect(
    await s.tx`select id from case_mgmt.allegation where supersedes_allegation_id = ${allegation}`,
  ).toEqual([]);
  expect(await s.tx`select status from case_mgmt.subject_status_event where subject_id = ${c.wrong}`).toEqual(
    [],
  );
  expect(await s.tx`select revoked_at from grievance.subject_portal_link where id = ${c.link}`).toEqual([
    { revoked_at: null },
  ]);
  expect(await s.tx`select status from grievance.defence_notice where id = ${notice}`).toEqual([
    { status: "ISSUED" },
  ]);
  expect(await s.tx`select id from case_mgmt.subject_correction where wrong_subject_id = ${c.wrong}`).toEqual(
    [],
  );
  expect(await s.tx`select id from case_mgmt.privacy_incident where case_id = ${case4}`).toEqual([]);
  expect(
    await s.tx`select seq from audit.audit_event
               where action = 'SUBJECT_CORRECTED' and metadata ->> 'wrong_subject_id' = ${c.wrong}`,
  ).toEqual([]);
}

describe("a subject correction while the wrong subject's open allegations carry findings (2099, ADR-045 §4)", () => {
  it("refused with ALLEGATION_HAS_FINDINGS when a finding on their open allegation names nobody; nothing is written", async () => {
    await ownerScenario(async (s) => {
      const c = await correctionCase(s);
      // Recorded before the allegation had a subject, so the finding names nobody; the subject is linked afterwards.
      const allegation = await one(
        s.tx`select api.add_allegation(${case4}, 'FRAUD', 'Synthetic: an allegation recorded before its subject was known.',
          null, null, null) as id`,
      );
      await s.as("investigatorB");
      const finding = await one(
        s.tx`select api.record_finding(${allegation}, null, ${c.proceeding}, 'SUBSTANTIATED', ${RATIONALE}) as id`,
      );
      await s.as("caseManager");
      await s.tx`select api.link_allegation_subject(${allegation}, ${c.wrong}, null, null)`;
      const notice = await one(
        s.tx`select api.issue_defence_notice(${c.wrong}, 'Synthetic: you are invited to respond.',
          ${[allegation]}::uuid[], now() + interval '10 days') as id`,
      );
      expect(await s.tx`select subject_id from case_mgmt.finding where id = ${finding}`).toEqual([
        { subject_id: null },
      ]);

      await s.expectError("CDF_CONFLICT:ALLEGATION_HAS_FINDINGS", (tx) => correct(tx, c.wrong, c.right));
      await nothingCorrected(s, c, allegation, notice);
    });
  });

  it("refused when a finding on their open allegation names another subject; SUBJECT_HAS_FINDINGS is still answered first", async () => {
    await ownerScenario(async (s) => {
      const c = await correctionCase(s);
      const other = await one(
        s.tx`select api.add_case_subject(${case4}, 'Employee Tau (synthetic)', 'EMPLOYEE', null) as id`,
      );
      const allegation = await one(
        s.tx`select api.add_allegation(${case4}, 'FRAUD', 'Synthetic: an allegation against the first subject.',
          ${c.wrong}, null, null) as id`,
      );
      const notice = await one(
        s.tx`select api.issue_defence_notice(${c.wrong}, 'Synthetic: you are invited to respond.',
          ${[allegation]}::uuid[], now() + interval '10 days') as id`,
      );
      await s.as("investigatorB");
      await s.tx`select api.record_finding(${allegation}, ${other}, ${c.proceeding}, 'NOT_SUBSTANTIATED', ${RATIONALE})`;

      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:ALLEGATION_HAS_FINDINGS", (tx) => correct(tx, c.wrong, c.right));
      await nothingCorrected(s, c, allegation, notice);
      // The finding names the other subject: correcting them is refused as before 2099.
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:SUBJECT_HAS_FINDINGS", (tx) => correct(tx, other, c.right));
      // A finding naming the wrong subject on their own open allegation meets both conditions; the older code answers.
      await s.as("investigatorB");
      await s.tx`select api.record_finding(${allegation}, null, ${c.proceeding}, 'SUBSTANTIATED', ${RATIONALE})`;
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:SUBJECT_HAS_FINDINGS", (tx) => correct(tx, c.wrong, c.right));
    });
  });

  it("accepted once the allegation carrying the finding is withdrawn: it stays WITHDRAWN with its finding, and only open allegations are superseded", async () => {
    await scenario(async (s) => {
      const c = await correctionCase(s);
      const allegation = await one(
        s.tx`select api.add_allegation(${case4}, 'FRAUD', 'Synthetic: an allegation recorded before its subject was known.',
          null, null, null) as id`,
      );
      await s.as("investigatorB");
      const finding = await one(
        s.tx`select api.record_finding(${allegation}, null, ${c.proceeding}, 'SUBSTANTIATED', ${RATIONALE}) as id`,
      );
      await s.as("caseManager");
      await s.tx`select api.link_allegation_subject(${allegation}, ${c.wrong}, null, null)`;
      const open = await one(
        s.tx`select api.add_allegation(${case4}, 'BRIBERY', 'Synthetic: a second allegation, without findings.',
          ${c.wrong}, null, null) as id`,
      );
      await s.expectError("CDF_CONFLICT:ALLEGATION_HAS_FINDINGS", (tx) => correct(tx, c.wrong, c.right));
      await s.tx`select api.withdraw_allegation(${allegation}, ${REASON})`;
      const correction = await one(correct(s.tx, c.wrong, c.right));
      expect(
        await s.tx`select allegations_superseded from case_mgmt.subject_correction where id = ${correction}`,
      ).toEqual([{ allegations_superseded: 1 }]);
      expect(
        await s.tx`select id, status from case_mgmt.allegation where id in (${allegation}, ${open}) order by status`,
      ).toEqual([
        { id: open, status: "SUPERSEDED" },
        { id: allegation, status: "WITHDRAWN" },
      ]);
      expect(await s.tx`select allegation_id from case_mgmt.finding where id = ${finding}`).toEqual([
        { allegation_id: allegation },
      ]);
      // No superseded allegation of the case carries a finding.
      expect(
        await s.tx`select f.id from case_mgmt.finding f join case_mgmt.allegation a on a.id = f.allegation_id
                   where a.case_id = ${case4} and a.status = 'SUPERSEDED'`,
      ).toEqual([]);
    });
  });
});

interface Built extends PackageFixture {
  withdrawn: string;
  /** The finding on the withdrawn allegation, recorded in the referred investigation: in the committee's scope. */
  withdrawnFinding: string;
}

/** Case B: the referred investigation's finding on Sigma's allegation, and a second allegation against Sigma whose
 *  finding was recorded before it was withdrawn. The voters are present at an open deliberation of the seated
 *  Investigation Committee and the secretary drafts a package: a sanction on Sigma and a case-wide corrective action. */
async function build(s: Scenario): Promise<Built> {
  await seat(s, ic, DECISION_SEATS);
  await authorityRuleFor(s, "CORRECTIVE_ACTION");
  const facts = await caseFacts(s, caseB);
  await s.as("caseManager");
  const withdrawn = await one(
    s.tx`select api.add_allegation(${caseB}, 'BRIBERY', 'Synthetic: an allegation later withdrawn.', ${facts.subject},
      null, null) as id`,
  );
  await s.as("investigatorB");
  const withdrawnFinding = await one(
    s.tx`select api.record_finding(${withdrawn}, null, ${facts.proceeding}, 'NOT_SUBSTANTIATED', ${RATIONALE}) as id`,
  );
  await s.as("caseManager");
  await s.tx`select api.withdraw_allegation(${withdrawn}, ${REASON})`;
  // AMB-026: a sanction is adopted only after a defence notice on the allegation.
  await s.tx`select api.issue_defence_notice(${facts.subject}, 'Synthetic: you are invited to respond.',
    ${[facts.allegation]}::uuid[], now() + interval '10 days')`;
  const meeting = await scheduleMeeting(s, ic, caseB, facts.proceeding);
  await openWithPresent(s, meeting, DECISION_VOTERS);
  await s.as("committeeSecretary");
  const pkg = await one(
    s.tx`select api.create_recommendation_package(${meeting.committeeProceeding}, 'PACKAGE') as id`,
  );
  const sanction = await one(
    s.tx`select api.add_recommendation_item(${pkg}, 'DISCIPLINARY_SANCTION', 'WARNING', null,
      'Synthetic: written warning for Employee Sigma.', ${[facts.subject]}::uuid[], ${[facts.allegation]}::uuid[]) as id`,
  );
  const corrective = await one(
    s.tx`select api.add_recommendation_item(${pkg}, 'CORRECTIVE_ACTION', null, null,
      'Synthetic: strengthen the approval controls.', null, null) as id`,
  );
  return { ...facts, meeting, pkg, sanction, corrective, withdrawn, withdrawnFinding };
}

describe("a withdrawn allegation's finding is put to no vote and no legal review (2099, CDF-213)", () => {
  it("api.open_vote_item refuses it with ALLEGATION_WITHDRAWN; every finding the secretary's choices (R1) list opens a vote", async () => {
    await scenario(async (s) => {
      const b = await build(s);
      await s.as("committeeSecretary");
      const open = (tx: Scenario["tx"], finding: string) =>
        tx`select api.open_vote_item(${b.meeting.meeting}, 'FINDING', ${finding}, 'Finding vote (synthetic)') as id`;
      await s.expectError("CDF_CONFLICT:ALLEGATION_WITHDRAWN", (tx) => open(tx, b.withdrawnFinding));
      await s.expectError("CDF_INVALID:finding_id", (tx) => open(tx, randomUUID()));
      // Flag == command: R1 leaves the finding out, and each finding it lists is accepted.
      const [r] = await s.tx<{ v: { findings: { finding_id: string }[] } }[]>`
        select api.committee_scope_choices(${b.meeting.committeeProceeding}) as v`;
      const listed = r!.v.findings.map((f) => f.finding_id);
      expect(listed).toEqual([b.finding]);
      for (const finding of listed) await open(s.tx, finding);
      expect(
        await s.tx`select finding_id from committee.vote_item where meeting_id = ${b.meeting.meeting}
                   and target_type = 'FINDING'`,
      ).toEqual([{ finding_id: b.finding }]);
    });
  });

  it("api.request_legal_review refuses finding_ids that include it; without it the request goes through", async () => {
    await scenario(async (s) => {
      const b = await build(s);
      await voteOnPackage(s, b);
      await s.as("committeeSecretary");
      const ask = (tx: Scenario["tx"], ids: string[]) =>
        tx`select api.request_legal_review(${b.pkg}, ${USERS.legalB}, ${REASON}, ${ids}::uuid[], null) as id`;
      for (const ids of [[b.withdrawnFinding], [b.finding, b.withdrawnFinding]]) {
        await s.expectError("CDF_CONFLICT:ALLEGATION_WITHDRAWN", (tx) => ask(tx, ids));
      }
      // The INVALID check is still answered first.
      await s.expectError("CDF_INVALID:finding_ids", (tx) => ask(tx, [b.withdrawnFinding, randomUUID()]));
      const request = await one(ask(s.tx, [b.finding]));
      await s.as("legalB");
      expect(
        await s.tx`select pi.source_id from decision.packet_item pi join decision.packet k on k.id = pi.packet_id
                   where k.legal_review_request_id = ${request} and pi.item_kind = 'FINDING'`,
      ).toEqual([{ source_id: b.finding }]);
    });
  });
});
