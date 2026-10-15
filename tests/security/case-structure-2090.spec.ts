// Business architecture rebase, migration 2090 (ADR-045): case structure and corrections. Ambiguity rows AMB-003,
// AMB-004, AMB-008, AMB-027, AMB-032, AMB-033, AMB-045, AMB-091, AMB-093 and AMB-223, with the register's tests
// T-AMB-002 (a link grants no access), T-AMB-003 (a split moves no evidence), T-AMB-014 (a corrected subject's former
// holder reaches no notice), T-AMB-023 (past snapshots stand) and T-AMB-054 (corrections to approved minutes). Nothing
// here rewrites a record: a link, a status, a successor row or an annotation is added, and no one gains a case, a
// notice or an item of evidence they could not already reach.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, admin, caseId, ownerScenario, scenario, type Scenario, type UserKey } from "../support/db";
import {
  IC_SEATS,
  committeeIds,
  openItem,
  openWithPresent,
  scheduleMeeting,
  seat,
  vote,
} from "../support/committee";
import { caseFacts, draftPackage } from "../support/decision";
import { defenceNotice, storeEvidence } from "../support/evidence";
import { closeAndArchive } from "../support/records";
import { setClosureAuthority } from "../support/closure";

const REASON = "Synthetic: case structure test reason.";
const OPS = "b0000000-0000-4000-8000-000000000001";
let caseA: string, caseB: string, case4: string, ic: string;

beforeAll(async () => {
  [caseA, caseB, case4] = await Promise.all([caseId("0001"), caseId("0002"), caseId("0004")]);
  ({ ic } = await committeeIds());
});

/** The first column of the first row. */
const one = async (q: Promise<readonly Record<string, unknown>[]>): Promise<string> =>
  Object.values((await q)[0]!)[0] as string;

/** The audit events of `action` on `objectId`, read with every branch (dpo). */
async function audited(s: Scenario, action: string, objectId: string) {
  await s.as("dpo");
  return s.tx<
    { category: string; case_id: string | null; reason: string | null; metadata: Record<string, unknown> }[]
  >`select category, case_id, reason, metadata from audit.audit_event
    where action = ${action} and object_id = ${objectId} order by seq`;
}

/** As the case manager: a subject on `caseId` and an open allegation against them. */
async function subjectWithAllegation(s: Scenario, caseId: string, label = "Employee Omega (synthetic)") {
  await s.as("caseManager");
  const subject = await one(s.tx`select api.add_case_subject(${caseId}, ${label}, 'EMPLOYEE', null) as id`);
  const allegation = await one(
    s.tx`select api.add_allegation(${caseId}, 'FRAUD', ${"Synthetic: allegation against " + label + "."},
      ${subject}, null, null) as id`,
  );
  return { subject, allegation };
}

describe("case links (AMB-003)", () => {
  it("T-AMB-002: a link grants no access; following it without access to the other case is NOT_FOUND, as for a missing case", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const link = await one(s.tx`select api.link_cases(${caseA}, ${caseB}, 'RELATED', ${REASON}) as id`);
      expect(await s.tx`select link_type from case_mgmt.case_link where id = ${link}`).toEqual([
        { link_type: "RELATED" },
      ]);
      // Case A's team cannot see case B: no link row, no case B, and every probe of B answers as for no case.
      for (const user of ["investigatorA", "lead"] as const) {
        await s.as(user);
        expect(await s.tx`select id from case_mgmt.case_link`).toEqual([]);
        expect(await s.tx`select id from case_mgmt.case_record where id = ${caseB}`).toEqual([]);
        expect(await s.tx`select * from api.case_history(${caseB}, 500)`).toEqual([]);
        for (const id of [link, randomUUID()]) {
          await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.end_case_link(${id}, ${REASON})`);
        }
        // The event on case A names the link type only, never the other case.
        const [e] = await s.tx<{ metadata: Record<string, unknown>; reason: string | null }[]>`
          select metadata, reason from audit.audit_event where action = 'CASE_LINKED' and object_id = ${link}`;
        expect(e).toEqual({ metadata: { link_type: "RELATED" }, reason: null });
      }
      // The lead edits case A, but linking it to a case the lead cannot see is NOT_FOUND, as for a random id.
      await s.as("lead");
      for (const target of [caseB, randomUUID()]) {
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.link_cases(${caseA}, ${target}, 'RELATED', ${REASON})`,
        );
      }
      // Case B's team cannot see case A: no link row either.
      await s.as("investigatorB");
      expect(await s.tx`select id from case_mgmt.case_link`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.case_record where id = ${caseA}`).toEqual([]);
    });
  });

  it("a link is typed, one of a type between two cases, one original per duplicate, ended once and never deleted", async () => {
    await ownerScenario(async (s) => {
      await s.as("investigatorA"); // on case A's team, not its lead
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.link_cases(${caseA}, ${case4}, 'RELATED', ${REASON})`,
      );
      await s.as("caseManager");
      const link = (b: string, type: string, a = caseB) =>
        s.tx`select api.link_cases(${a}, ${b}, ${type}, ${REASON}) as id`;
      await s.expectError("CDF_INVALID:linked_case_id", () => link(caseB, "RELATED"));
      for (const type of ["SPLIT_FROM", "MERGED_INTO", null]) {
        await s.expectError(
          "CDF_INVALID:link_type",
          (tx) => tx`select api.link_cases(${caseB}, ${caseA}, ${type}, ${REASON})`,
        );
      }
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) => tx`select api.link_cases(${caseB}, ${caseA}, 'RELATED', 'short')`,
      );
      const dup = await one(link(caseA, "DUPLICATE_OF"));
      await s.expectError("CDF_CONFLICT:LINK_EXISTS", () => link(caseA, "DUPLICATE_OF"));
      await s.expectError("CDF_CONFLICT:LINK_EXISTS", () => link(caseB, "DUPLICATE_OF", caseA));
      await s.expectError("CDF_CONFLICT:ALREADY_DUPLICATE", () => link(case4, "DUPLICATE_OF"));
      await one(link(caseA, "RELATED"));
      await s.expectError("CDF_INVALID:reason", (tx) => tx`select api.end_case_link(${dup}, 'short')`);
      await s.tx`select api.end_case_link(${dup}, ${REASON})`;
      await s.expectError("CDF_CONFLICT:LINK_ENDED", (tx) => tx`select api.end_case_link(${dup}, ${REASON})`);
      // Once ended, another original may be named; the ended link stays readable.
      await one(link(case4, "DUPLICATE_OF"));
      expect(
        await s.tx`select link_type, linked_case_id, ended_at is not null as ended from case_mgmt.case_link
                   where case_id = ${caseB} order by linked_at`,
      ).toEqual([
        { link_type: "DUPLICATE_OF", linked_case_id: caseA, ended: true },
        { link_type: "RELATED", linked_case_id: caseA, ended: false },
        { link_type: "DUPLICATE_OF", linked_case_id: case4, ended: false },
      ]);
      expect((await audited(s, "CASE_LINK_ENDED", dup)).map((e) => [e.metadata, e.reason])).toEqual([
        [{ link_type: "DUPLICATE_OF" }, null],
      ]);
      await s.asOwner();
      await s.expectError(
        `case link ${dup} can only be ended, once`,
        (tx) => tx`update case_mgmt.case_link set ended_at = now() where id = ${dup}`,
      );
      await s.expectError(
        "case_mgmt.case_link is append-only",
        (tx) => tx`delete from case_mgmt.case_link where id = ${dup}`,
      );
    });
  });

  it("a case closes as DUPLICATE only while it has an active DUPLICATE_OF link, on the direct path and on approval", async () => {
    await ownerScenario(async (s) => {
      await setClosureAuthority(s, "CASE_MANAGER");
      await s.as("caseManager");
      const close = (tx: Scenario["tx"], outcome = "DUPLICATE") =>
        tx`select api.close_case(${caseB}, ${outcome}, ${REASON}) as r`;
      await s.expectError("CDF_CONFLICT:DUPLICATE_LINK_REQUIRED", (tx) => close(tx));
      await s.tx`select api.link_cases(${caseB}, ${caseA}, 'RELATED', ${REASON})`;
      await s.expectError("CDF_CONFLICT:DUPLICATE_LINK_REQUIRED", (tx) => close(tx));
      // The request path: the lead's request needs the link when filed and again when approved.
      await s.tx`select api.assign_case(${caseB}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`;
      await s.as("lead");
      await s.expectError("CDF_CONFLICT:DUPLICATE_LINK_REQUIRED", (tx) => close(tx));
      await s.as("caseManager");
      const dup = await one(s.tx`select api.link_cases(${caseB}, ${case4}, 'DUPLICATE_OF', ${REASON}) as id`);
      await s.as("lead");
      expect(await one(close(s.tx))).toBe("AWAITING_APPROVAL");
      await s.as("caseManager");
      await s.tx`select api.end_case_link(${dup}, ${REASON})`;
      const request = await one(
        s.tx`select id from case_mgmt.case_closure_request where case_id = ${caseB} and status = 'AWAITING_APPROVAL'`,
      );
      await s.expectError(
        "CDF_CONFLICT:DUPLICATE_LINK_REQUIRED",
        (tx) => tx`select api.decide_case_closure(${request}, 'APPROVE', ${REASON})`,
      );
      await s.tx`select api.link_cases(${caseB}, ${case4}, 'DUPLICATE_OF', ${REASON})`;
      expect(await one(s.tx`select api.decide_case_closure(${request}, 'APPROVE', ${REASON}) as r`)).toBe(
        "CLOSED",
      );
    });
  });
});

describe("allegations: withdrawal and split (AMB-027)", () => {
  it("withdrawal is a status with a reason, never a delete; nothing new hangs off a withdrawn allegation", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      const proceeding = await one(
        s.tx`select api.open_proceeding(${caseB}, 'INVESTIGATION', null, ${REASON}) as id`,
      );
      const { subject, allegation } = await subjectWithAllegation(s, caseB);
      const withdraw = (tx: Scenario["tx"], id = allegation, reason = REASON) =>
        tx`select api.withdraw_allegation(${id}, ${reason})`;
      await s.as("investigatorA");
      for (const id of [allegation, randomUUID()])
        await s.expectError("CDF_NOT_FOUND", (tx) => withdraw(tx, id));
      await s.as("investigatorB"); // on the team, not its lead
      await s.expectError("CDF_FORBIDDEN", (tx) => withdraw(tx));
      await s.as("caseManager");
      await s.expectError("CDF_INVALID:reason", (tx) => withdraw(tx, allegation, "short"));
      await withdraw(s.tx);
      await s.expectError("CDF_CONFLICT:ALLEGATION_NOT_OPEN", (tx) => withdraw(tx));
      await s.expectError(
        "CDF_CONFLICT:ALLEGATION_NOT_OPEN",
        (tx) =>
          tx`select api.split_allegation(${allegation}, ${tx.json([
            { category: "FRAUD", description: "Synthetic: first part of it." },
            { category: "FRAUD", description: "Synthetic: second part of it." },
          ] as never)}::jsonb, ${REASON})`,
      );
      // The case team still reads it, with why and by whom.
      await s.as("investigatorB");
      expect(await s.tx`select status from case_mgmt.allegation where id = ${allegation}`).toEqual([
        { status: "WITHDRAWN" },
      ]);
      expect(
        await s.tx`select from_status, to_status, basis, reason, changed_by from case_mgmt.allegation_status_change
                   where allegation_id = ${allegation}`,
      ).toEqual([
        {
          from_status: "OPEN",
          to_status: "WITHDRAWN",
          basis: "WITHDRAWAL",
          reason: REASON,
          changed_by: USERS.caseManager,
        },
      ]);
      // Nothing new hangs off it: no finding, evidence link or notice item.
      await s.expectError(
        "CDF_CONFLICT:ALLEGATION_WITHDRAWN",
        (tx) =>
          tx`select api.record_finding(${allegation}, null, ${proceeding}, 'SUBSTANTIATED', 'Synthetic: finding rationale text.')`,
      );
      const v = await storeEvidence(s, "caseManager", caseB);
      await s.expectError(
        "CDF_CONFLICT:ALLEGATION_WITHDRAWN",
        (tx) => tx`select api.link_supporting_material(${v.evidenceId}, ${allegation}, null)`,
      );
      await s.expectError(
        "CDF_CONFLICT:ALLEGATION_WITHDRAWN",
        (tx) => tx`select api.issue_defence_notice(${subject}, 'Synthetic: you are invited to respond.',
          ${[allegation]}::uuid[], now() + interval '10 days')`,
      );
      expect(
        (await audited(s, "ALLEGATION_WITHDRAWN", allegation)).map((e) => [e.metadata, e.reason]),
      ).toEqual([[{ subject_id: subject }, null]]);
      // Even the table owner cannot reopen or rewrite it.
      await s.asOwner();
      await s.expectError(
        `allegation ${allegation} is closed or its content is immutable`,
        (tx) => tx`update case_mgmt.allegation set status = 'OPEN' where id = ${allegation}`,
      );
      await s.expectError(
        "case_mgmt.allegation_status_change is append-only",
        (tx) => tx`delete from case_mgmt.allegation_status_change where allegation_id = ${allegation}`,
      );
    });
  });

  it("an open allegation's content never changes; references may still be added", async () => {
    await ownerScenario(async (s) => {
      const { allegation } = await subjectWithAllegation(s, caseB);
      await s.asOwner();
      await s.expectError(
        `allegation ${allegation} is closed or its content is immutable`,
        (tx) =>
          tx`update case_mgmt.allegation set description = 'Synthetic: a rewritten allegation.' where id = ${allegation}`,
      );
      await s.tx`update case_mgmt.allegation set policy_reference = 'POL-DEMO-1' where id = ${allegation}`;
    });
  });

  it("a split creates successors with provenance, copies evidence links by reference and supersedes the original", async () => {
    await ownerScenario(async (s) => {
      const { subject, allegation } = await subjectWithAllegation(s, caseB);
      const other = await one(
        s.tx`select api.add_case_subject(${caseB}, 'Employee Psi (synthetic)', 'EMPLOYEE', null) as id`,
      );
      const v = await storeEvidence(s, "caseManager", caseB);
      await s.tx`select api.link_supporting_material(${v.evidenceId}, ${allegation}, null)`;
      const split = (tx: Scenario["tx"], parts: unknown, id = allegation) =>
        tx<
          { ids: string[] }[]
        >`select api.split_allegation(${id}, ${tx.json(parts as never)}::jsonb, ${REASON}) as ids`;
      const part = (category: string, extra: Record<string, unknown> = {}) => ({
        category,
        description: `Synthetic: the ${category.toLowerCase()} part of the allegation.`,
        ...extra,
      });
      await s.expectError("CDF_INVALID:parts", (tx) => split(tx, [part("FRAUD")]));
      await s.expectError("CDF_INVALID:parts", (tx) =>
        split(
          tx,
          Array.from({ length: 11 }, () => part("FRAUD")),
        ),
      );
      await s.expectError("CDF_INVALID:parts", (tx) => split(tx, { category: "FRAUD" }));
      await s.expectError("CDF_INVALID:parts", (tx) => split(tx, [part("FRAUD"), "FRAUD"]));
      await s.expectError("CDF_INVALID:category", (tx) => split(tx, [part("FRAUD"), part("fraud")]));
      await s.expectError("CDF_INVALID:description", (tx) =>
        split(tx, [part("FRAUD"), { category: "FRAUD", description: "short" }]),
      );
      await s.expectError("CDF_INVALID:subject_id", (tx) =>
        split(tx, [part("FRAUD"), part("FRAUD", { subject_id: randomUUID() })]),
      );
      await s.expectError("CDF_INVALID:policy_reference", (tx) =>
        split(tx, [part("FRAUD"), part("FRAUD", { policy_reference: "x".repeat(201) })]),
      );
      await s.as("investigatorA");
      await s.expectError("CDF_NOT_FOUND", (tx) => split(tx, [part("FRAUD"), part("BRIBERY")]));
      await s.as("caseManager");
      const [r] = await split(s.tx, [part("FRAUD"), part("CONFLICT_OF_INTEREST", { subject_id: other })]);
      const successors = r!.ids;
      expect(successors).toHaveLength(2);
      await s.as("investigatorB");
      expect(
        await s.tx`select category, subject_id, status, supersedes_allegation_id as supersedes from case_mgmt.allegation
                   where id = any (${successors}::uuid[]) order by array_position(${successors}::uuid[], id)`,
      ).toEqual([
        { category: "FRAUD", subject_id: subject, status: "OPEN", supersedes: allegation },
        { category: "CONFLICT_OF_INTEREST", subject_id: other, status: "OPEN", supersedes: allegation },
      ]);
      expect(await s.tx`select status from case_mgmt.allegation where id = ${allegation}`).toEqual([
        { status: "SUPERSEDED" },
      ]);
      expect(
        await s.tx`select basis from case_mgmt.allegation_status_change where allegation_id = ${allegation}`,
      ).toEqual([{ basis: "ALLEGATION_SPLIT" }]);
      // The evidence is linked by reference to each successor, and stays linked to the original.
      expect(
        await s.tx`select count(*)::int as n from case_mgmt.evidence_link
                   where evidence_id = ${v.evidenceId} and allegation_id = any (${[allegation, ...successors]}::uuid[])`,
      ).toEqual([{ n: 3 }]);
      expect(await s.tx`select count(*)::int as n from evidence.evidence where id = ${v.evidenceId}`).toEqual(
        [{ n: 1 }],
      );
      expect((await audited(s, "ALLEGATION_SPLIT", allegation)).map((e) => [e.metadata, e.reason])).toEqual([
        [{ successor_ids: successors }, null],
      ]);
      // A superseded allegation takes nothing new.
      await s.as("caseManager");
      const proceeding = await one(
        s.tx`select api.open_proceeding(${caseB}, 'INVESTIGATION', null, ${REASON}) as id`,
      );
      await s.as("investigatorB");
      await s.expectError(
        "CDF_CONFLICT:ALLEGATION_SUPERSEDED",
        (tx) =>
          tx`select api.record_finding(${allegation}, null, ${proceeding}, 'SUBSTANTIATED', 'Synthetic: finding rationale text.')`,
      );
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:ALLEGATION_NOT_OPEN", (tx) =>
        split(tx, [part("FRAUD"), part("BRIBERY")]),
      );
      await s.expectError(
        "CDF_CONFLICT:ALLEGATION_NOT_OPEN",
        (tx) => tx`select api.withdraw_allegation(${allegation}, ${REASON})`,
      );
    });
  });

  it("an allegation with findings is withdrawn but not split; one in a recommendation is neither", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:ALLEGATION_IN_RECOMMENDATION",
        (tx) => tx`select api.withdraw_allegation(${f.allegation}, ${REASON})`,
      );
      await s.expectError(
        "CDF_CONFLICT:ALLEGATION_IN_RECOMMENDATION",
        (tx) =>
          tx`select api.split_allegation(${f.allegation}, ${tx.json([
            { category: "FRAUD", description: "Synthetic: first part of it." },
            { category: "FRAUD", description: "Synthetic: second part of it." },
          ] as never)}::jsonb, ${REASON})`,
      );
    });
    await scenario(async (s) => {
      const facts = await caseFacts(s, case4);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:ALLEGATION_HAS_FINDINGS",
        (tx) =>
          tx`select api.split_allegation(${facts.allegation}, ${tx.json([
            { category: "FRAUD", description: "Synthetic: first part of it." },
            { category: "FRAUD", description: "Synthetic: second part of it." },
          ] as never)}::jsonb, ${REASON})`,
      );
      await s.tx`select api.withdraw_allegation(${facts.allegation}, ${REASON})`;
      // The finding stays with it.
      expect(await s.tx`select id from case_mgmt.finding where allegation_id = ${facts.allegation}`).toEqual([
        { id: facts.finding },
      ]);
    });
  });
});

describe("subject status (AMB-032)", () => {
  it("only an IDENTIFIED subject receives a notice or a portal link; findings may still be recorded", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      const proceeding = await one(
        s.tx`select api.open_proceeding(${caseB}, 'INVESTIGATION', null, ${REASON}) as id`,
      );
      const { subject, allegation } = await subjectWithAllegation(
        s,
        caseB,
        "Unidentified person (synthetic)",
      );
      const record = (tx: Scenario["tx"], status: string | null, id = subject) =>
        tx`select api.record_subject_status(${id}, ${status}, ${REASON})`;
      const notice = (tx: Scenario["tx"]) =>
        tx`select api.issue_defence_notice(${subject}, 'Synthetic: you are invited to respond.',
          ${[allegation]}::uuid[], now() + interval '10 days') as id`;
      const link = (tx: Scenario["tx"]) =>
        tx`select api.link_subject_portal_account(${subject}, ${USERS.employee}, ${REASON}) as id`;

      await s.as("investigatorA");
      for (const id of [subject, randomUUID()]) {
        await s.expectError("CDF_NOT_FOUND", (tx) => record(tx, "UNIDENTIFIED", id));
      }
      await s.as("investigatorB");
      await s.expectError("CDF_FORBIDDEN", (tx) => record(tx, "UNIDENTIFIED"));
      await s.as("caseManager");
      for (const status of ["MISIDENTIFIED", "ALIVE", null]) {
        await s.expectError("CDF_INVALID:status", (tx) => record(tx, status));
      }
      await s.expectError("CDF_CONFLICT:SUBJECT_STATUS_UNCHANGED", (tx) => record(tx, "IDENTIFIED"));
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) => tx`select api.record_subject_status(${subject}, 'UNIDENTIFIED', 'short')`,
      );
      await record(s.tx, "UNIDENTIFIED");
      await s.expectError("CDF_CONFLICT:SUBJECT_STATUS_UNCHANGED", (tx) => record(tx, "UNIDENTIFIED"));
      // A placeholder: no notice, no portal link. Findings are still recorded for governance.
      await s.expectError("CDF_CONFLICT:SUBJECT_NOT_NOTIFIABLE", (tx) => notice(tx));
      await s.expectError("CDF_CONFLICT:SUBJECT_NOT_NOTIFIABLE", (tx) => link(tx));
      await s.as("investigatorB");
      await s.tx`select api.record_finding(${allegation}, null, ${proceeding}, 'INCONCLUSIVE', 'Synthetic: finding rationale text.')`;
      // Identified: the audited change back; a linked subject is a known person.
      await s.as("caseManager");
      await record(s.tx, "IDENTIFIED");
      await one(link(s.tx));
      await s.expectError("CDF_CONFLICT:SUBJECT_LINKED", (tx) => record(tx, "UNIDENTIFIED"));
      await one(notice(s.tx));
      // Untraceable: no new notice; the proceeding is suspended with the new reason.
      await record(s.tx, "UNTRACEABLE");
      await s.expectError("CDF_CONFLICT:SUBJECT_NOT_NOTIFIABLE", (tx) => notice(tx));
      await s.tx`select api.update_proceeding_state(${proceeding}, 'SUSPENDED', null, 'SUBJECT_UNTRACEABLE', ${REASON})`;
      expect(
        await s.tx`select status, suspension_reason from case_mgmt.proceeding where id = ${proceeding}`,
      ).toEqual([{ status: "SUSPENDED", suspension_reason: "SUBJECT_UNTRACEABLE" }]);

      await s.as("investigatorB");
      expect(
        await s.tx`select sequence_no, status, recorded_by from case_mgmt.subject_status_event
                   where subject_id = ${subject} order by sequence_no`,
      ).toEqual([
        { sequence_no: 1, status: "UNIDENTIFIED", recorded_by: USERS.caseManager },
        { sequence_no: 2, status: "IDENTIFIED", recorded_by: USERS.caseManager },
        { sequence_no: 3, status: "UNTRACEABLE", recorded_by: USERS.caseManager },
      ]);
      const events = await audited(s, "SUBJECT_STATUS_RECORDED", subject);
      expect(events.map((e) => [e.metadata.status, e.metadata.previous_status, e.reason])).toEqual([
        ["UNIDENTIFIED", "IDENTIFIED", null],
        ["IDENTIFIED", "UNIDENTIFIED", null],
        ["UNTRACEABLE", "IDENTIFIED", null],
      ]);
      await s.asOwner();
      await s.expectError(
        "case_mgmt.subject_status_event is append-only",
        (tx) =>
          tx`update case_mgmt.subject_status_event set status = 'IDENTIFIED' where subject_id = ${subject}`,
      );
    });
  });

  it("a DECEASED subject is named on no disciplinary sanction; the findings about them stand", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      await s.as("caseManager");
      await s.tx`select api.record_subject_status(${f.subject}, 'DECEASED', ${REASON})`;
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:SUBJECT_NOT_SANCTIONABLE",
        (tx) =>
          tx`select api.add_recommendation_item(${f.pkg}, 'DISCIPLINARY_SANCTION', 'WARNING', null,
            'Synthetic: a second written warning.', ${[f.subject]}::uuid[], ${[f.allegation]}::uuid[])`,
      );
      await s.as("investigatorB");
      expect(await s.tx`select id from case_mgmt.finding where id = ${f.finding}`).toEqual([
        { id: f.finding },
      ]);
    });
  });
});

describe("correcting a wrongly identified subject (AMB-033)", () => {
  it("T-AMB-014: afterwards the wrongly identified person gets NOT_FOUND on every notice; a privacy incident is recorded with ids and counts only", async () => {
    await ownerScenario(async (s) => {
      const n = await defenceNotice(s, caseB, "caseManager", "employee", "Employee Sigma (synthetic)");
      const v = await storeEvidence(s, "caseManager", caseB);
      await s.tx`select api.link_supporting_material(${v.evidenceId}, ${n.allegation}, null)`;
      await s.as("employee");
      const [before] = await s.tx<{ n: unknown[] }[]>`select api.my_defence_notices() as n`;
      expect(before!.n).toHaveLength(1);
      await s.tx`select api.acknowledge_defence_notice(${n.notice})`;

      await s.as("caseManager");
      const right = await one(
        s.tx`select api.add_case_subject(${caseB}, 'Employee Kappa (synthetic)', 'EMPLOYEE', null) as id`,
      );
      const otherCase = await one(
        s.tx`select api.add_case_subject(${case4}, 'Employee Kappa (synthetic)', 'EMPLOYEE', null) as id`,
      );
      const correct = (tx: Scenario["tx"], wrong: string, to: string | null, reason = REASON) =>
        tx`select api.correct_case_subject(${wrong}, ${to}, ${reason}) as id`;
      for (const to of [null, n.subject, otherCase, randomUUID()]) {
        await s.expectError("CDF_INVALID:correct_subject_id", (tx) => correct(tx, n.subject, to));
      }
      await s.expectError("CDF_INVALID:reason", (tx) => correct(tx, n.subject, right, "short"));
      for (const user of ["investigatorA", "employee"] as const) {
        await s.as(user);
        for (const id of [n.subject, randomUUID()]) {
          await s.expectError("CDF_NOT_FOUND", (tx) => correct(tx, id, right));
        }
      }
      await s.as("investigatorB");
      await s.expectError("CDF_FORBIDDEN", (tx) => correct(tx, n.subject, right));

      await s.as("caseManager");
      const correction = await one(correct(s.tx, n.subject, right));

      // T-AMB-014: every notice path answers the former holder as for a notice that does not exist.
      await s.as("employee");
      const [after] = await s.tx<{ n: unknown[] }[]>`select api.my_defence_notices() as n`;
      expect(after!.n).toEqual([]);
      for (const table of [
        "grievance.defence_notice",
        "grievance.subject_portal_link",
        "case_mgmt.case_subject",
        "case_mgmt.allegation",
        "case_mgmt.privacy_incident",
        "case_mgmt.subject_correction",
      ]) {
        expect(await s.tx`select id from ${s.tx(table)}`, table).toEqual([]);
      }
      expect(await s.tx`select id from case_mgmt.case_record where id = ${caseB}`).toEqual([]);
      for (const id of [n.notice, randomUUID()]) {
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.acknowledge_defence_notice(${id})`);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.submit_defence_response(${id}, 'Synthetic: my response to the allegation.')`,
        );
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.my_defence_packet(${id})`);
      }

      // The records: a new subject link, nothing rewritten.
      await s.as("caseManager");
      expect(
        await s.tx`select status, closed_at is not null as closed from grievance.defence_notice where id = ${n.notice}`,
      ).toEqual([{ status: "WITHDRAWN", closed: true }]);
      expect(
        await s.tx`select revoked_by, revoked_at is not null as revoked from grievance.subject_portal_link
                   where subject_id = ${n.subject}`,
      ).toEqual([{ revoked_by: USERS.caseManager, revoked: true }]);
      expect(
        await s.tx`select status from case_mgmt.subject_status_event where subject_id = ${n.subject} order by sequence_no`,
      ).toEqual([{ status: "MISIDENTIFIED" }]);
      expect(await s.tx`select status from case_mgmt.allegation where id = ${n.allegation}`).toEqual([
        { status: "SUPERSEDED" },
      ]);
      const [successor] = await s.tx<{ id: string; subject_id: string; description: string }[]>`
        select id, subject_id, description from case_mgmt.allegation where supersedes_allegation_id = ${n.allegation}`;
      expect(successor).toMatchObject({
        subject_id: right,
        description: "Synthetic: allegation against Employee Sigma (synthetic).",
      });
      expect(
        await s.tx`select evidence_id from case_mgmt.evidence_link where allegation_id = ${successor!.id}`,
      ).toEqual([{ evidence_id: v.evidenceId }]);
      expect(
        await s.tx`select wrong_subject_id, correct_subject_id, links_revoked, notices_withdrawn, allegations_superseded
                   from case_mgmt.subject_correction where id = ${correction}`,
      ).toEqual([
        {
          wrong_subject_id: n.subject,
          correct_subject_id: right,
          links_revoked: 1,
          notices_withdrawn: 1,
          allegations_superseded: 1,
        },
      ]);

      // The privacy incident: ids and counts only; security monitoring and the case team read it, no one else.
      const incident = (user: UserKey) =>
        s.as(user).then(() => s.tx<{ id: string }[]>`select id from case_mgmt.privacy_incident`);
      const [row] = await s.tx<{ id: string; kind: string; notices_sent: number }[]>`
        select id, kind, notices_sent from case_mgmt.privacy_incident where correction_id = ${correction}`;
      expect(row).toMatchObject({ kind: "NOTICE_TO_MISIDENTIFIED_SUBJECT", notices_sent: 1 });
      for (const user of ["caseManager", "investigatorB", "dpo", "soc"] as const) {
        expect(await incident(user), user).toEqual([{ id: row!.id }]);
      }
      for (const user of ["investigatorA", "internalAudit", "platformAdmin", "employee"] as const) {
        expect(await incident(user), user).toEqual([]);
      }
      const [e] = await audited(s, "PRIVACY_INCIDENT_RECORDED", row!.id);
      expect(e).toEqual({
        category: "SECURITY",
        case_id: caseB,
        reason: null,
        metadata: { kind: "NOTICE_TO_MISIDENTIFIED_SUBJECT", correction_id: correction, notices_sent: 1 },
      });
      const [c] = await audited(s, "SUBJECT_CORRECTED", correction);
      expect(c!.reason).toBeNull();
      expect(Object.keys(c!.metadata).sort()).toEqual([
        "allegations_superseded",
        "correct_subject_id",
        "links_revoked",
        "notices_withdrawn",
        "privacy_incident",
        "wrong_subject_id",
      ]);
      // No event of the correction carries a name, a label or narrative text.
      const texts = await s.tx<{ t: string }[]>`
        select metadata::text || coalesce(reason, '') as t from audit.audit_event
        where request_id = current_setting('cdf.request_id')::uuid
          and action in ('SUBJECT_CORRECTED', 'PRIVACY_INCIDENT_RECORDED', 'SUBJECT_PORTAL_UNLINKED',
                         'EMPLOYEE_NOTICE_WITHDRAWN')`;
      expect(texts.length).toBeGreaterThan(0);
      for (const { t } of texts) expect(t).not.toMatch(/Sigma|Kappa|Synthetic/);

      // The former holder stays conflicted on the case, so the revoked link never opens it to them.
      await s.asOwner();
      expect(
        await s.tx`select authz.has_conflict(${caseB}, ${USERS.employee}) as conflicted,
                          authz.user_case_gate(${USERS.employee}, ${caseB}) as gate`,
      ).toEqual([{ conflicted: true, gate: false }]);

      // MISIDENTIFIED is final.
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:SUBJECT_MISIDENTIFIED", (tx) => correct(tx, n.subject, right));
      await s.expectError(
        "CDF_CONFLICT:SUBJECT_MISIDENTIFIED",
        (tx) => tx`select api.record_subject_status(${n.subject}, 'IDENTIFIED', ${REASON})`,
      );
      await s.expectError(
        "CDF_CONFLICT:SUBJECT_MISIDENTIFIED",
        (tx) =>
          tx`select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: a new allegation.', ${n.subject}, null, null)`,
      );
      await s.expectError(
        "CDF_CONFLICT:SUBJECT_NOT_NOTIFIABLE",
        (tx) => tx`select api.link_subject_portal_account(${n.subject}, ${USERS.employeeB}, ${REASON})`,
      );
      const third = await one(
        s.tx`select api.add_case_subject(${caseB}, 'Employee Tau (synthetic)', 'EMPLOYEE', null) as id`,
      );
      await s.expectError("CDF_INVALID:correct_subject_id", (tx) => correct(tx, third, n.subject));
      await s.asOwner();
      await s.expectError(
        "case_mgmt.privacy_incident is append-only",
        (tx) => tx`delete from case_mgmt.privacy_incident where id = ${row!.id}`,
      );
    });
  });

  it("a correction is refused while findings name the wrong subject; one with no notice sent records no incident", async () => {
    await scenario(async (s) => {
      const facts = await caseFacts(s, case4);
      await s.as("caseManager");
      const right = await one(
        s.tx`select api.add_case_subject(${case4}, 'Employee Kappa (synthetic)', 'EMPLOYEE', null) as id`,
      );
      await s.expectError(
        "CDF_CONFLICT:SUBJECT_HAS_FINDINGS",
        (tx) => tx`select api.correct_case_subject(${facts.subject}, ${right}, ${REASON})`,
      );
      const { subject } = await subjectWithAllegation(s, case4, "Employee Rho (synthetic)");
      const correction = await one(
        s.tx`select api.correct_case_subject(${subject}, ${right}, ${REASON}) as id`,
      );
      expect(
        await s.tx`select links_revoked, notices_withdrawn, allegations_superseded from case_mgmt.subject_correction
                   where id = ${correction}`,
      ).toEqual([{ links_revoked: 0, notices_withdrawn: 0, allegations_superseded: 1 }]);
      expect(
        await s.tx`select id from case_mgmt.privacy_incident where correction_id = ${correction}`,
      ).toEqual([]);
    });
  });
});

describe("splitting a case (AMB-004)", () => {
  it("T-AMB-003: the new case references its source, carries the team and the chosen allegations, and no evidence", async () => {
    await ownerScenario(async (s) => {
      const first = await subjectWithAllegation(s, caseB, "Employee Omega (synthetic)");
      const second = await subjectWithAllegation(s, caseB, "Employee Psi (synthetic)");
      const v = await storeEvidence(s, "caseManager", caseB);
      await s.tx`select api.link_supporting_material(${v.evidenceId}, ${second.allegation}, null)`;
      const split = (tx: Scenario["tx"], ids: string[] | null, id = caseB) =>
        tx`select api.split_case(${id}, ${ids}::uuid[], 'Split case (synthetic)', 'Synthetic: the supplier matter.',
          ${REASON}) as id`;

      await s.as("investigatorA");
      for (const id of [caseB, randomUUID()]) {
        await s.expectError("CDF_NOT_FOUND", (tx) => split(tx, [second.allegation], id));
      }
      await s.as("investigatorB"); // on the team, not its lead
      await s.expectError("CDF_FORBIDDEN", (tx) => split(tx, [second.allegation]));
      await s.as("caseManager");
      for (const ids of [null, [], [second.allegation, second.allegation], [randomUUID()]]) {
        await s.expectError("CDF_INVALID:allegation_ids", (tx) => split(tx, ids));
      }
      const open = await s.tx<{ id: string }[]>`
        select id from case_mgmt.allegation where case_id = ${caseB} and status = 'OPEN'`;
      expect(open.map((r) => r.id)).toEqual(expect.arrayContaining([first.allegation, second.allegation]));
      await s.expectError("CDF_CONFLICT:SPLIT_LEAVES_NOTHING", (tx) =>
        split(
          tx,
          open.map((r) => r.id),
        ),
      );
      const created = await one(split(s.tx, [second.allegation]));

      // The new case: same classification and restriction, a SPLIT_FROM link, registered.
      expect(
        await s.tx`select c.classification, c.is_restricted, c.case_number like 'CDF-DEMO-%' as demo, i.current_state
                   from case_mgmt.case_record c join workflow.workflow_instance i on i.case_id = c.id
                   where c.id = ${created}`,
      ).toEqual([
        { classification: "RESTRICTED", is_restricted: false, demo: true, current_state: "REGISTERED" },
      ]);
      expect(
        await s.tx`select link_type, linked_case_id from case_mgmt.case_link where case_id = ${created}`,
      ).toEqual([{ link_type: "SPLIT_FROM", linked_case_id: caseB }]);
      expect(
        await s.tx`select user_id, assignment_role from case_mgmt.case_assignment
                   where case_id = ${created} and status = 'ACTIVE'`,
      ).toEqual([{ user_id: USERS.investigatorB, assignment_role: "INVESTIGATOR" }]);
      const [moved] = await s.tx<{ id: string; subject_id: string; supersedes: string }[]>`
        select id, subject_id, supersedes_allegation_id as supersedes from case_mgmt.allegation where case_id = ${created}`;
      expect(moved!.supersedes).toBe(second.allegation);
      expect(moved!.subject_id).not.toBe(second.subject);
      expect(
        await s.tx`select s.case_id from case_mgmt.case_subject s where s.id = ${moved!.subject_id}`,
      ).toEqual([{ case_id: created }]);
      expect(await s.tx`select status from case_mgmt.allegation where id = ${second.allegation}`).toEqual([
        { status: "SUPERSEDED" },
      ]);
      // No evidence, evidence link, notice, portal link, grant or reporter channel moved.
      for (const table of [
        "evidence.evidence",
        "case_mgmt.evidence_link",
        "grievance.defence_notice",
        "grievance.subject_portal_link",
        "case_mgmt.case_access_grant",
      ]) {
        expect(await s.tx`select id from ${s.tx(table)} where case_id = ${created}`, table).toEqual([]);
      }
      expect(await s.tx`select reporter_wb_id from case_mgmt.case_record where id = ${created}`).toEqual([
        { reporter_wb_id: null },
      ]);
      expect(
        (
          await audited(
            s,
            "CASE_SPLIT",
            await one(s.tx`select id from case_mgmt.case_link where case_id = ${created}`),
          )
        ).map((e) => [e.case_id, e.metadata, e.reason]),
      ).toEqual([
        [caseB, { allegations_moved: 1, assignments_carried: 1, assignments_not_carried: 0 }, null],
      ]);

      // A lead assigned only to the new case sees nothing of the source: not the case, its evidence or the link.
      await s.as("caseManager");
      await s.tx`select api.assign_case(${created}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`;
      await s.as("lead");
      expect(await s.tx`select id from case_mgmt.case_record where id in (${caseB}, ${created})`).toEqual([
        { id: created },
      ]);
      expect(await s.tx`select id from evidence.evidence where id = ${v.evidenceId}`).toEqual([]);
      expect(
        await s.tx`select id from case_mgmt.evidence_link where case_id in (${caseB}, ${created})`,
      ).toEqual([]);
      expect(await s.tx`select id from case_mgmt.case_link`).toEqual([]);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.link_cases(${created}, ${caseB}, 'RELATED', ${REASON})`,
      );

      // A split link never ends.
      await s.as("caseManager");
      const splitLink = await one(s.tx`select id from case_mgmt.case_link where case_id = ${created}`);
      await s.expectError(
        "CDF_CONFLICT:LINK_NOT_ENDABLE",
        (tx) => tx`select api.end_case_link(${splitLink}, ${REASON})`,
      );
    });
  });

  it("a conflict on one case of a split family is a conflict on every case of it, both ways", async () => {
    await ownerScenario(async (s) => {
      await subjectWithAllegation(s, caseB, "Employee Omega (synthetic)");
      const second = await subjectWithAllegation(s, caseB, "Employee Psi (synthetic)");
      const created = await one(
        s.tx`select api.split_case(${caseB}, ${[second.allegation]}::uuid[], 'Split case (synthetic)',
          'Synthetic: the supplier matter.', ${REASON}) as id`,
      );
      // The GRC deputy declares a conflict on the source; the new case refuses them too.
      await s.as("grcDeputy");
      await s.tx`select api.declare_conflict(${caseB}, true, 'Synthetic: declared on the source case.')`;
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:ASSIGNEE_HAS_CONFLICT",
        (tx) => tx`select api.assign_case(${created}, ${USERS.grcDeputy}, 'INVESTIGATOR', ${REASON})`,
      );
      // The lead declares one on the new case; the source refuses them.
      await s.tx`select api.assign_case(${created}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`;
      await s.as("lead");
      await s.tx`select api.declare_conflict(${created}, true, 'Synthetic: declared on the split case.')`;
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:ASSIGNEE_HAS_CONFLICT",
        (tx) => tx`select api.assign_case(${caseB}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`,
      );
      await s.asOwner();
      expect(
        await s.tx`select authz.has_conflict(${caseB}, ${USERS.lead}) as source,
                          authz.has_conflict(${created}, ${USERS.grcDeputy}) as split,
                          authz.has_conflict(${caseA}, ${USERS.lead}) as unrelated`,
      ).toEqual([{ source: true, split: true, unrelated: false }]);
    });
  });

  it("a team member whose account is not active is not carried to the new case", async () => {
    await ownerScenario(async (s) => {
      await subjectWithAllegation(s, caseB, "Employee Omega (synthetic)");
      const second = await subjectWithAllegation(s, caseB, "Employee Psi (synthetic)");
      await s.as("platformAdmin");
      await s.tx`select api.set_user_status(${USERS.investigatorB}, 'SUSPENDED'::core.record_status, ${REASON})`;
      await s.as("caseManager");
      const created = await one(
        s.tx`select api.split_case(${caseB}, ${[second.allegation]}::uuid[], 'Split case (synthetic)',
          'Synthetic: the supplier matter.', ${REASON}) as id`,
      );
      expect(await s.tx`select user_id from case_mgmt.case_assignment where case_id = ${created}`).toEqual(
        [],
      );
      expect(
        await s.tx`select user_id from case_mgmt.case_assignment where case_id = ${caseB} and status = 'ACTIVE'`,
      ).toEqual([{ user_id: USERS.investigatorB }]);
      await s.as("dpo");
      expect(
        await s.tx`select metadata from audit.audit_event where action = 'CASE_SPLIT' and case_id = ${caseB}`,
      ).toEqual([{ metadata: { allegations_moved: 1, assignments_carried: 0, assignments_not_carried: 1 } }]);
    });
  });

  it("only someone who may create cases splits one; the allegations must be open and free of findings", async () => {
    await scenario(async (s) => {
      // Case A's lead edits case A but may not create cases.
      await s.as("lead");
      const [a] = await s.tx<
        { id: string }[]
      >`select id from case_mgmt.allegation where case_id = ${caseA} limit 1`;
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.split_case(${caseA}, ${a ? [a.id] : [randomUUID()]}::uuid[], 'Split case (synthetic)',
            'Synthetic: the supplier matter.', ${REASON})`,
      );
      const facts = await caseFacts(s, case4);
      await subjectWithAllegation(s, case4);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:ALLEGATION_HAS_FINDINGS",
        (tx) =>
          tx`select api.split_case(${case4}, ${[facts.allegation]}::uuid[], 'Split case (synthetic)',
            'Synthetic: the supplier matter.', ${REASON})`,
      );
    });
  });
});

describe("referral submission versions (AMB-008)", () => {
  it("each submission keeps what was submitted, numbered per referral; nothing is overwritten", async () => {
    await ownerScenario(async (s) => {
      await s.as("employee");
      const id = await one(
        s.tx`select api.create_referral(${OPS}, 'Referral (synthetic)', 'Synthetic: the first summary.', 'FRAUD',
          'RESTRICTED'::core.classification_level) as id`,
      );
      expect(await s.tx`select id from intake.referral_submission where referral_id = ${id}`).toEqual([]);
      await s.tx`select api.submit_referral(${id}, null)`;
      await s.as("sectorHead");
      await s.tx`select api.sector_decide_referral(${id}, 'RETURN', array['MISSING_DOCUMENTS'], 'Attach the synthetic invoice.')`;
      await s.as("employee");
      await s.tx`select api.update_referral(${id}, 'Referral, revised (synthetic)', 'Synthetic: the second summary.',
        'FRAUD', 'INTERNAL'::core.classification_level)`;
      await s.tx`select api.submit_referral(${id}, null)`;
      const versions = await s.tx`
        select version_no, title, summary, classification, submitted_by from intake.referral_submission
        where referral_id = ${id} order by version_no`;
      expect(versions).toEqual([
        {
          version_no: 1,
          title: "Referral (synthetic)",
          summary: "Synthetic: the first summary.",
          classification: "RESTRICTED",
          submitted_by: USERS.employee,
        },
        {
          version_no: 2,
          title: "Referral, revised (synthetic)",
          summary: "Synthetic: the second summary.",
          classification: "INTERNAL",
          submitted_by: USERS.employee,
        },
      ]);
      // Read as the referral is read: the preparer and the sector head, not another sector or the case team.
      await s.as("sectorHead");
      expect(
        await s.tx`select version_no from intake.referral_submission where referral_id = ${id}`,
      ).toHaveLength(2);
      for (const user of ["financeEmployee", "investigatorA", "caseManager"] as const) {
        await s.as(user);
        expect(await s.tx`select id from intake.referral_submission`, user).toEqual([]);
      }
      await s.asOwner();
      await s.expectError(
        "intake.referral_submission is append-only",
        (tx) =>
          tx`update intake.referral_submission set summary = 'Rewritten summary text' where referral_id = ${id}`,
      );
    });
  });
});

describe("committee membership corrections (AMB-045)", () => {
  it("T-AMB-023: a correction is an annotation with a reason; past proceeding snapshots stay as taken", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      await scheduleMeeting(s, ic, caseB); // refers case B: the proceeding snapshots its members
      await s.asOwner();
      const [m] = await s.tx<{ id: string }[]>`
        select id from committee.membership where committee_id = ${ic} and user_id = ${USERS.legal} and ended_at is null`;
      const snapshot = async () => {
        await s.asOwner();
        return s.tx`select * from committee.proceeding_member order by id`;
      };
      const before = await snapshot();
      expect(before.some((r) => r.membership_id === m!.id)).toBe(true);

      const annotate = (
        tx: Scenario["tx"],
        id: string,
        kind: string | null = "WRONG_REFERENCE",
        reason = REASON,
      ) => tx`select api.annotate_committee_membership(${id}, ${kind}, ${reason}) as id`;
      for (const user of ["committeeSecretary", "legal", "caseManager"] as const) {
        await s.as(user);
        await s.expectError("CDF_FORBIDDEN", (tx) => annotate(tx, m!.id));
      }
      await s.as("platformAdmin");
      await s.expectError("CDF_NOT_FOUND", (tx) => annotate(tx, randomUUID()));
      for (const kind of ["WRONG_NAME", null]) {
        await s.expectError("CDF_INVALID:kind", (tx) => annotate(tx, m!.id, kind));
      }
      await s.expectError("CDF_INVALID:reason", (tx) => annotate(tx, m!.id, "WRONG_REFERENCE", "short"));
      const correction = await one(annotate(s.tx, m!.id));
      expect(
        await s.tx`select kind, affected_proceedings, corrected_by from committee.membership_correction where id = ${correction}`,
      ).toEqual([{ kind: "WRONG_REFERENCE", affected_proceedings: 1, corrected_by: USERS.platformAdmin }]);
      expect(await snapshot()).toEqual(before);
      // An overlap is still refused by the appointment command (1870).
      await s.as("platformAdmin");
      await s.expectError(
        "CDF_CONFLICT",
        (tx) =>
          tx`select api.appoint_committee_member(${ic}, ${USERS.legal}, 'MEMBER', now() - interval '1 hour', null, 'DEMO-APPT-2')`,
      );
      // No one corrects the record of their own seat.
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.grcDirector}, 'MEMBER', now() - interval '1 day', null, 'DEMO-APPT')`;
      const [own] = await s.tx<{ id: string }[]>`
        select id from committee.membership where committee_id = ${ic} and user_id = ${USERS.grcDirector} and ended_at is null`;
      await s.as("grcDirector");
      await s.expectError("CDF_CONFLICT:SELF_CORRECTION", (tx) => annotate(tx, own!.id));
      // Read with the registry: committee administrators and seat holders, not the case team.
      await s.as("legal");
      expect(await s.tx`select id from committee.membership_correction`).toEqual([{ id: correction }]);
      for (const user of ["investigatorB", "caseManager"] as const) {
        await s.as(user);
        expect(await s.tx`select id from committee.membership_correction`, user).toEqual([]);
      }
      const [e] = await audited(s, "COMMITTEE_MEMBERSHIP_ANNOTATED", m!.id);
      expect(e).toMatchObject({ category: "ADMIN", case_id: null, reason: null });
      await s.asOwner();
      await s.expectError(
        "committee.membership_correction is append-only",
        (tx) => tx`update committee.membership_correction set kind = 'OTHER' where id = ${correction}`,
      );
    });
  });
});

describe("minutes: revised versions and corrections (AMB-091, AMB-093)", () => {
  const VOTERS: UserKey[] = ["committeeChair", "legal", "legalB", "lead"];

  /** IC seated, case B referred, a closed meeting with the four voters present; returns the meeting. */
  async function closedMeeting(s: Scenario) {
    await seat(s, ic, IC_SEATS);
    const f = await scheduleMeeting(s, ic, caseB);
    await openWithPresent(s, f, VOTERS);
    const item = await openItem(s, f.meeting);
    for (const u of VOTERS) await vote(s, u, item, "APPROVE");
    await s.as("committeeSecretary");
    await s.tx`select api.close_vote_item(${item}, null)`;
    await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
    return f.meeting;
  }

  async function approvedMinutes(s: Scenario, meeting: string) {
    await s.as("committeeSecretary");
    const minutes = await one(
      s.tx`select api.generate_minutes(${meeting}, 'Synthetic minutes narrative, approved.') as id`,
    );
    for (const u of VOTERS) {
      await s.as(u);
      await s.tx`select api.review_minutes(${minutes}, 'APPROVE', null)`;
    }
    return minutes;
  }

  it("AMB-091: a revised version restarts review for every attending member; earlier versions are kept", async () => {
    await scenario(async (s) => {
      const meeting = await closedMeeting(s);
      await s.as("committeeSecretary");
      const v1 = await one(
        s.tx`select api.generate_minutes(${meeting}, 'Synthetic minutes, version one.') as id`,
      );
      await s.as("legal");
      await s.tx`select api.review_minutes(${v1}, 'APPROVE', null)`;
      await s.as("lead");
      await s.tx`select api.review_minutes(${v1}, 'REQUEST_CHANGES', 'Synthetic: correct the attendance note.')`;
      await s.as("committeeSecretary");
      const v2 = await one(
        s.tx`select api.generate_minutes(${meeting}, 'Synthetic minutes, version two.') as id`,
      );
      // legal approved v1, but v2 waits on legal too: three approvals leave it in review.
      for (const u of ["committeeChair", "legalB", "lead"] as const) {
        await s.as(u);
        await s.tx`select api.review_minutes(${v2}, 'APPROVE', null)`;
      }
      await s.as("committeeSecretary");
      expect(await s.tx`select status from committee.minutes where id = ${v2}`).toEqual([
        { status: "IN_REVIEW" },
      ]);
      await s.as("legal");
      await s.tx`select api.review_minutes(${v2}, 'APPROVE', null)`;
      await s.as("committeeSecretary");
      expect(
        await s.tx`select version_no, status, narrative from committee.minutes where meeting_id = ${meeting}
                   order by version_no`,
      ).toEqual([
        { version_no: 1, status: "SUPERSEDED", narrative: "Synthetic minutes, version one." },
        { version_no: 2, status: "APPROVED", narrative: "Synthetic minutes, version two." },
      ]);
    });
  });

  it("T-AMB-054: approved minutes are corrected by a reviewed correction; the approved version stays", async () => {
    await scenario(async (s) => {
      const meeting = await closedMeeting(s);
      await s.as("committeeSecretary");
      const pending = await one(
        s.tx`select api.generate_minutes(${meeting}, 'Synthetic minutes narrative, approved.') as id`,
      );
      const propose = (
        tx: Scenario["tx"],
        minutes: string,
        text = "Synthetic: item two was approved, not noted.",
      ) => tx`select api.propose_minutes_correction(${minutes}, ${text}, ${REASON}) as id`;
      await s.expectError("CDF_CONFLICT:MINUTES_NOT_APPROVED", (tx) => propose(tx, pending));
      for (const u of VOTERS) {
        await s.as(u);
        await s.tx`select api.review_minutes(${pending}, 'APPROVE', null)`;
      }
      const minutes = pending;
      await s.as("committeeSecretary");
      const [approved] = await s.tx`select * from committee.minutes where id = ${minutes}`;

      for (const user of ["legal", "caseManager"] as const) {
        await s.as(user);
        await s.expectError(user === "legal" ? "CDF_FORBIDDEN" : "CDF_NOT_FOUND", (tx) =>
          propose(tx, minutes),
        );
      }
      for (const user of ["investigatorA", "employee"] as const) {
        await s.as(user);
        for (const id of [minutes, randomUUID()])
          await s.expectError("CDF_NOT_FOUND", (tx) => propose(tx, id));
      }
      await s.as("committeeSecretary");
      await s.expectError("CDF_INVALID:correction_text", (tx) => propose(tx, minutes, "short"));
      const first = await one(propose(s.tx, minutes));
      await s.expectError("CDF_CONFLICT:CORRECTION_IN_REVIEW", (tx) => propose(tx, minutes));
      expect(
        await s.tx`select sequence_no, reviewer_count, status from committee.minutes_correction where id = ${first}`,
      ).toEqual([{ sequence_no: 1, reviewer_count: 4, status: "IN_REVIEW" }]);

      const review = (
        tx: Scenario["tx"],
        id: string,
        decision: string | null,
        comment: string | null = null,
      ) => tx<{ r: string }[]>`select api.review_minutes_correction(${id}, ${decision}, ${comment}) as r`;
      // The secretary does not review; outsiders get NOT_FOUND.
      await s.expectError("CDF_FORBIDDEN", (tx) => review(tx, first, "APPROVE"));
      for (const user of ["investigatorA", "caseManager"] as const) {
        await s.as(user);
        for (const id of [first, randomUUID()])
          await s.expectError("CDF_NOT_FOUND", (tx) => review(tx, id, "APPROVE"));
      }
      // While in review the case team does not see it.
      await s.as("caseManager");
      expect(await s.tx`select id from committee.minutes_correction`).toEqual([]);
      await s.as("legal");
      await s.expectError("CDF_INVALID:decision", (tx) => review(tx, first, "ABSTAIN"));
      await s.expectError("CDF_INVALID:comment", (tx) => review(tx, first, "REJECT"));
      expect((await review(s.tx, first, "APPROVE"))[0]!.r).toBe("IN_REVIEW");
      await s.expectError("CDF_CONFLICT:ALREADY_REVIEWED", (tx) => review(tx, first, "APPROVE"));
      await s.as("lead");
      expect((await review(s.tx, first, "REJECT", "Synthetic: the item was only noted."))[0]!.r).toBe(
        "REJECTED",
      );
      await s.as("committeeChair");
      await s.expectError("CDF_CONFLICT:CORRECTION_NOT_IN_REVIEW", (tx) => review(tx, first, "APPROVE"));

      // A second correction, approved by every reviewer.
      await s.as("committeeSecretary");
      const second = await one(propose(s.tx, minutes, "Synthetic: item two was approved unanimously."));
      const results: string[] = [];
      for (const u of VOTERS) {
        await s.as(u);
        results.push((await review(s.tx, second, "APPROVE"))[0]!.r);
      }
      expect(results).toEqual(["IN_REVIEW", "IN_REVIEW", "IN_REVIEW", "APPROVED"]);
      // The approved version never changed; the case team reads the approved correction only.
      await s.as("committeeSecretary");
      expect(await s.tx`select * from committee.minutes where id = ${minutes}`).toEqual([approved]);
      await s.as("caseManager");
      expect(await s.tx`select sequence_no, status from committee.minutes_correction`).toEqual([
        { sequence_no: 2, status: "APPROVED" },
      ]);
      expect(await s.tx`select id from committee.minutes_correction_review`).toEqual([]);
      await s.as("dpo");
      expect(
        await s.tx`select metadata->>'decision' as d, reason from audit.audit_event
                   where action = 'MINUTES_CORRECTION_REVIEWED' and object_id = ${first} order by seq`,
      ).toEqual([
        { d: "APPROVE", reason: null },
        { d: "REJECT", reason: null },
      ]);
    });
  });

  it("decided corrections and reviews are immutable, even to the table owner", async () => {
    await ownerScenario(async (s) => {
      const meeting = await closedMeeting(s);
      const minutes = await approvedMinutes(s, meeting);
      await s.as("committeeSecretary");
      const id = await one(
        s.tx`select api.propose_minutes_correction(${minutes}, 'Synthetic: item two was approved.', ${REASON}) as id`,
      );
      await s.as("legal");
      await s.tx`select api.review_minutes_correction(${id}, 'REJECT', 'Synthetic: not what was decided.')`;
      await s.asOwner();
      await s.expectError(
        `minutes correction ${id} is decided once and its content is immutable`,
        (tx) => tx`update committee.minutes_correction set status = 'APPROVED' where id = ${id}`,
      );
      await s.expectError(
        "committee.minutes_correction_review is append-only",
        (tx) =>
          tx`update committee.minutes_correction_review set decision = 'APPROVE' where correction_id = ${id}`,
      );
    });
  });
});

describe("annotations on records past ACTIVE (AMB-223)", () => {
  it("records staff in catalogue scope annotate a closed or archived record; the original stays", async () => {
    await ownerScenario(async (s) => {
      const annotate = (tx: Scenario["tx"], id: string, kind: string | null = "CASE_RECORD", text = REASON) =>
        tx`select api.annotate_archived_record(${id}, ${kind}, 'Synthetic: the closure date was recorded a day late.', ${text}) as id`;
      // While ACTIVE: the records officer cannot see the case; the case manager can, but does not administer records.
      await s.as("records");
      for (const id of [caseB, randomUUID()]) await s.expectError("CDF_NOT_FOUND", (tx) => annotate(tx, id));
      await s.as("caseManager");
      await s.expectError("CDF_FORBIDDEN", (tx) => annotate(tx, caseB));

      await closeAndArchive(s, caseB);
      await s.asOwner();
      const [original] = await s.tx`select * from case_mgmt.case_record where id = ${caseB}`;
      await s.as("caseManager");
      await s.expectError("CDF_FORBIDDEN", (tx) => annotate(tx, caseB));
      await s.as("grcDirector"); // ARCHIVE_RECORD_VIEW without ARCHIVE_RECORD_ADMINISTER
      await s.expectError("CDF_FORBIDDEN", (tx) => annotate(tx, caseB));
      await s.as("investigatorA");
      await s.expectError("CDF_NOT_FOUND", (tx) => annotate(tx, caseB));
      await s.as("records");
      for (const kind of ["SUBJECT", null]) {
        await s.expectError("CDF_INVALID:target_kind", (tx) => annotate(tx, caseB, kind));
      }
      await s.expectError("CDF_INVALID:reason", (tx) => annotate(tx, caseB, "CASE_RECORD", "short"));
      const id = await one(annotate(s.tx, caseB));
      expect(
        await s.tx`select sequence_no, target_kind, records_state, annotated_by from records.record_annotation where id = ${id}`,
      ).toEqual([
        {
          sequence_no: 1,
          target_kind: "CASE_RECORD",
          records_state: "ARCHIVED",
          annotated_by: USERS.records,
        },
      ]);
      await s.asOwner();
      expect(await s.tx`select * from case_mgmt.case_record where id = ${caseB}`).toEqual([original]);
      // Read as the record is read; not by someone outside it.
      for (const [user, n] of [
        ["recordsB", 1],
        ["caseManager", 1],
        ["investigatorA", 0],
      ] as const) {
        await s.as(user);
        expect(await s.tx`select id from records.record_annotation`, user).toHaveLength(n);
      }
      const [e] = await audited(s, "RECORD_ANNOTATED", id);
      expect(e).toEqual({
        category: "BUSINESS",
        case_id: caseB,
        reason: null,
        metadata: { target_kind: "CASE_RECORD", records_state: "ARCHIVED" },
      });
      // A disposed record takes no annotation.
      await s.asOwner();
      await s.tx`update case_mgmt.case_record set records_state = 'DISPOSED' where id = ${caseB}`;
      await s.as("records");
      await s.expectError("CDF_CONFLICT:RECORD_DISPOSED", (tx) => annotate(tx, caseB));
      await s.asOwner();
      await s.expectError(
        "records.record_annotation is append-only",
        (tx) => tx`update records.record_annotation set annotation = 'Rewritten annotation' where id = ${id}`,
      );
    });
  });
});

describe("helpers stay internal (2090)", () => {
  it("no application role executes the new helper or trigger functions", async () => {
    const rows = await admin<{ fn: string }[]>`
      select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname, p.proname) in (('case_mgmt', 'protect_case_link'), ('case_mgmt', 'guard_duplicate_closure'),
             ('case_mgmt', 'subject_status'), ('case_mgmt', 'append_subject_status'),
             ('case_mgmt', 'guard_subject_notifiable'), ('decision', 'guard_item_subject_status'),
             ('case_mgmt', 'protect_allegation'), ('case_mgmt', 'guard_allegation_active'),
             ('case_mgmt', 'successor_allegation'), ('case_mgmt', 'close_allegation'),
             ('case_mgmt', 'allegation_change_block'), ('case_mgmt', 'split_family'),
             ('intake', 'snapshot_referral_submission'), ('committee', 'protect_minutes_correction'))
        and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
             or has_function_privilege('anon', p.oid, 'EXECUTE'))`;
    expect(rows).toEqual([]);
  });
});
