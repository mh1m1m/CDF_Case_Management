// Migration 2092 (CDF-236, ADR-059): a superseded allegation needs no defence notice at adoption, as a withdrawn one
// needs none; its successors are asked for as any live allegation. In every state, the package's may_record_adoption
// (2086, read by the committee secretary through api.committee_items_view) is what api.record_package_adoption answers
// (run and rolled back). SYNTHETIC: Employee Sigma and Employee Tau on demo case 0002.
import { beforeAll, describe, expect, it } from "vitest";
import { caseId, ownerScenario, type OwnerScenario } from "../support/db";
import {
  REASON,
  committeeIds,
  openWithPresent,
  scheduleMeeting,
  seat,
  type MeetingFixture,
} from "../support/committee";
import { DECISION_SEATS, DECISION_VOTERS, caseFacts } from "../support/decision";
import { outcomes } from "../support/capabilities";

const DEFENCE = "Synthetic: you are invited to respond.";
const SPLIT = "Synthetic: the allegation covers two separate matters.";
const REQUIRED = "CDF_CONFLICT:DEFENCE_NOTICE_REQUIRED";

let caseB: string, ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
});

/** The first column of the first row. */
const one = async (q: Promise<readonly Record<string, unknown>[]>): Promise<string> =>
  Object.values((await q)[0]!)[0] as string;

interface Facts {
  meeting: MeetingFixture;
  sigma: string;
  tau: string;
  /** Sigma's allegation with a finding and a defence notice. */
  noticed: string;
  /** Sigma's allegation with neither. */
  x: string;
}

/**
 * Employee Sigma on case 0002 with two allegations, `noticed` (a finding and a defence notice) and `x` (neither), and
 * Employee Tau with none; the Investigation Committee's meeting open with its voters present.
 */
async function facts(s: OwnerScenario): Promise<Facts> {
  await seat(s, ic, DECISION_SEATS);
  const f = await caseFacts(s, caseB);
  await notice(s, f.subject, [f.allegation]);
  await s.as("caseManager");
  const x = await one(
    s.tx`select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: a second allegation against Employee Sigma.',
      ${f.subject}, null, null) as id`,
  );
  const tau = await one(
    s.tx`select api.add_case_subject(${caseB}, 'Employee Tau (synthetic)', 'EMPLOYEE', null) as id`,
  );
  const meeting = await scheduleMeeting(s, ic, caseB);
  await openWithPresent(s, meeting, DECISION_VOTERS);
  return { meeting, sigma: f.subject, tau, noticed: f.allegation, x };
}

/**
 * A PACKAGE-granularity package of disciplinary sanctions, one per [subject, allegations] (null names none), put to
 * the committee and approved. Adoption is left to the test. Returns the package.
 */
async function approved(s: OwnerScenario, f: Facts, sanctions: [string, string[] | null][]): Promise<string> {
  await s.as("committeeSecretary");
  const pkg = await one(
    s.tx`select api.create_recommendation_package(${f.meeting.committeeProceeding}, 'PACKAGE') as id`,
  );
  for (const [subject, allegations] of sanctions) {
    await s.tx`select api.add_recommendation_item(${pkg}, 'DISCIPLINARY_SANCTION', 'WARNING', null,
      'Synthetic: a written warning.', ${[subject]}::uuid[], ${allegations}::uuid[])`;
  }
  await s.tx`select api.submit_package_for_vote(${pkg})`;
  await s.tx`select api.open_package_vote(${f.meeting.meeting}, ${pkg})`;
  const items = await s.tx<{ id: string }[]>`
    select vi.id from committee.vote_item vi
    join decision.recommendation_package p on p.id = vi.package_id and vi.package_round = p.round_no
    where p.id = ${pkg} order by vi.sequence_no`;
  for (const vi of items) {
    for (const u of DECISION_VOTERS) {
      await s.as(u);
      await s.tx`select api.cast_vote(${vi.id}, 'APPROVE', null)`;
    }
    await s.as("committeeSecretary");
    await s.tx`select api.close_vote_item(${vi.id}, null)`;
  }
  return pkg;
}

/**
 * The secretary's may_record_adoption for the package, and what api.record_package_adoption answers for them now (run
 * and rolled back): true, or the CDF_ error. Asserts the two agree.
 */
async function adoption(s: OwnerScenario, f: Facts, pkg: string): Promise<true | string> {
  await s.as("committeeSecretary");
  const [r] = await s.tx<
    { v: { packages: { package_id: string; capabilities: Record<string, boolean> }[] } }[]
  >`
    select api.committee_items_view(${f.meeting.committeeProceeding}) as v`;
  const flag = r!.v.packages.find((p) => p.package_id === pkg)!.capabilities.may_record_adoption;
  const answer = (
    await outcomes(s, "committeeSecretary", { adopt: `select api.record_package_adoption('${pkg}')` })
  ).adopt!;
  expect(flag, `may_record_adoption against the command's ${String(answer)}`).toBe(answer === true);
  return answer;
}

/** The secretary records the adoption; returns the package status. */
async function adopt(s: OwnerScenario, pkg: string): Promise<string> {
  await s.as("committeeSecretary");
  return one(s.tx`select api.record_package_adoption(${pkg}) as status`);
}

/** As the case manager: a defence notice to `subject` on `allegations`. */
async function notice(s: OwnerScenario, subject: string, allegations: string[]): Promise<void> {
  await s.as("caseManager");
  await s.tx`select api.issue_defence_notice(${subject}, ${DEFENCE}, ${allegations}::uuid[],
    now() + interval '10 days')`;
}

/** As the case manager: `allegation` split into two successors, on the subjects given (null keeps the original's). */
async function split(
  s: OwnerScenario,
  allegation: string,
  subjects: [string | null, string | null] = [null, null],
): Promise<[string, string]> {
  await s.as("caseManager");
  const parts = subjects.map((subject, n) => ({
    category: "FRAUD",
    description: `Synthetic: part ${n + 1} of the split allegation.`,
    ...(subject ? { subject_id: subject } : {}),
  }));
  const [r] = await s.tx<{ ids: string[] }[]>`
    select api.split_allegation(${allegation}, ${s.tx.json(parts as never)}::jsonb, ${SPLIT}) as ids`;
  return [r!.ids[0]!, r!.ids[1]!];
}

/** As the case manager: a new open allegation against `subject`. */
async function allegation(s: OwnerScenario, subject: string): Promise<string> {
  await s.as("caseManager");
  return one(
    s.tx`select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: a further allegation.', ${subject}, null, null) as id`,
  );
}

describe("adoption after an allegation is superseded (CDF-236, migration 2092)", () => {
  it("an allegation split after the vote: the original needs no notice and can take none; each successor needs its own", async () => {
    await ownerScenario(async (s) => {
      const f = await facts(s);
      const pkg = await approved(s, f, [[f.sigma, null]]);
      expect(await adoption(s, f, pkg)).toBe(REQUIRED); // x is live and has no notice
      const [x1, x2] = await split(s, f.x);
      await s.asOwner();
      expect(await s.tx`select status from case_mgmt.allegation where id = ${f.x}`).toEqual([
        { status: "SUPERSEDED" },
      ]);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:ALLEGATION_SUPERSEDED",
        (tx) =>
          tx`select api.issue_defence_notice(${f.sigma}, ${DEFENCE}, ${[f.x]}::uuid[], now() + interval '10 days')`,
      );
      expect(await adoption(s, f, pkg)).toBe(REQUIRED); // neither successor has a notice
      await notice(s, f.sigma, [x1]);
      expect(await adoption(s, f, pkg)).toBe(REQUIRED); // x2 still has none
      await notice(s, f.sigma, [x2]);
      expect(await adoption(s, f, pkg)).toBe(true);
      expect(await adopt(s, pkg)).toBe("ADOPTED");
    });
  });

  it("a live allegation without a notice still refuses, whatever was superseded", async () => {
    await ownerScenario(async (s) => {
      const f = await facts(s);
      const [x1, x2] = await split(s, f.x);
      await notice(s, f.sigma, [x1, x2]);
      const z = await allegation(s, f.sigma);
      const pkg = await approved(s, f, [[f.sigma, null]]);
      expect(await adoption(s, f, pkg)).toBe(REQUIRED);
      await s.as("committeeSecretary");
      await s.expectError(REQUIRED, (tx) => tx`select api.record_package_adoption(${pkg})`);
      await notice(s, f.sigma, [z]);
      expect(await adoption(s, f, pkg)).toBe(true);
      expect(await adopt(s, pkg)).toBe("ADOPTED");
    });
  });

  it("a successor split onto another subject is asked for on that subject's sanction, not on the original's", async () => {
    // Sigma's sanction: x2 is Tau's, so Sigma needs a notice on x1 only.
    await ownerScenario(async (s) => {
      const f = await facts(s);
      const [x1] = await split(s, f.x, [null, f.tau]);
      const pkg = await approved(s, f, [[f.sigma, null]]);
      expect(await adoption(s, f, pkg)).toBe(REQUIRED);
      await notice(s, f.sigma, [x1]);
      expect(await adoption(s, f, pkg)).toBe(true);
      expect(await adopt(s, pkg)).toBe("ADOPTED");
    });
    // Tau's sanction: x2 needs Tau's notice.
    await ownerScenario(async (s) => {
      const f = await facts(s);
      const [, x2] = await split(s, f.x, [null, f.tau]);
      const pkg = await approved(s, f, [[f.tau, null]]);
      expect(await adoption(s, f, pkg)).toBe(REQUIRED);
      await notice(s, f.tau, [x2]);
      expect(await adoption(s, f, pkg)).toBe(true);
      expect(await adopt(s, pkg)).toBe("ADOPTED");
    });
  });

  it("a case split: the allegation moved to the new case is not asked for on the source's sanction", async () => {
    await ownerScenario(async (s) => {
      const f = await facts(s);
      const pkg = await approved(s, f, [[f.sigma, null]]);
      expect(await adoption(s, f, pkg)).toBe(REQUIRED);
      await s.as("caseManager");
      const created = await one(
        s.tx`select api.split_case(${caseB}, ${[f.x]}::uuid[], 'Split case (synthetic)',
          'Synthetic: the supplier matter.', ${SPLIT}) as id`,
      );
      await s.asOwner();
      expect(
        await s.tx`select a.status, a.case_id from case_mgmt.allegation a where a.id = ${f.x}
                   union all
                   select a.status, a.case_id from case_mgmt.allegation a where a.supersedes_allegation_id = ${f.x}`,
      ).toEqual([
        { status: "SUPERSEDED", case_id: caseB },
        { status: "OPEN", case_id: created },
      ]);
      expect(await adoption(s, f, pkg)).toBe(true);
      expect(await adopt(s, pkg)).toBe("ADOPTED");
    });
  });

  it("a subject whose allegations are all superseded or withdrawn still needs a defence notice", async () => {
    await ownerScenario(async (s) => {
      const f = await facts(s);
      const t = await allegation(s, f.tau);
      const [t1, t2] = await split(s, t);
      await s.as("caseManager");
      for (const id of [t1, t2]) await s.tx`select api.withdraw_allegation(${id}, ${SPLIT})`;
      const pkg = await approved(s, f, [[f.tau, null]]);
      expect(await adoption(s, f, pkg)).toBe(REQUIRED);
      await s.as("committeeSecretary");
      await s.expectError(REQUIRED, (tx) => tx`select api.record_package_adoption(${pkg})`);
    });
  });

  it("items naming allegations answer as before: only the named successor counts, and a named allegation is never split", async () => {
    await ownerScenario(async (s) => {
      const f = await facts(s);
      const [x1] = await split(s, f.x);
      const pkg = await approved(s, f, [[f.sigma, [x1]]]);
      expect(await adoption(s, f, pkg)).toBe(REQUIRED);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:ALLEGATION_IN_RECOMMENDATION",
        (tx) =>
          tx`select api.split_allegation(${x1}, ${tx.json([
            { category: "FRAUD", description: "Synthetic: part one of a named allegation." },
            { category: "FRAUD", description: "Synthetic: part two of a named allegation." },
          ] as never)}::jsonb, ${SPLIT})`,
      );
      await notice(s, f.sigma, [x1]); // x2 is not named, so it is not asked for
      expect(await adoption(s, f, pkg)).toBe(true);
      expect(await adopt(s, pkg)).toBe("ADOPTED");
    });
  });

  it("with the committee's notice rule off, the split path adopts without any successor notice (unchanged)", async () => {
    await ownerScenario(async (s) => {
      await s.as("platformAdmin");
      await s.tx`select api.revise_committee_rule_set(${ic}, now(),
        ${s.tx.json({ sanction_requires_defence_notice: false })}, 'SOURCE_REQUIRED', ${REASON})`;
      const f = await facts(s);
      await split(s, f.x);
      const pkg = await approved(s, f, [[f.sigma, null]]);
      expect(await adoption(s, f, pkg)).toBe(true);
      expect(await adopt(s, pkg)).toBe("ADOPTED");
    });
  });
});
