// Rebase PR-B, migration 2060 (ADR-042): the package-building read model (DEC-02; coordinator rulings 2026-10-14 12:08
// and 12:12; spec rebase/plan/PACKAGE_BUILDING_READ_MODEL_SPEC.md §5) and CDF-213. api.committee_scope_choices gives
// the committee's secretary what a package, a finding vote, a legal review or a sanction extract may name;
// api.committee_items_view gives the committee side and the case team what the items in front of the committee are
// about. Ids, codes, positions and categories: a subject's display name only under DISPLAY_NAME, which needs the
// owner's recorded decision (the DEC-02 label card is open, so ORDINAL is the default and names nobody). The reads never
// open the case: the case tables stay closed to the committee side (DEC-02). Every step runs through the api.*
// commands as `authenticated`; the owner connection only sets fixtures no application role may write and reads the
// ledger. N1 to N15 are the spec's numbered negative tests.
import { randomUUID } from "node:crypto";
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
import {
  IC_SEATS,
  REASON,
  committeeIds,
  openWithPresent,
  refer,
  scheduleMeeting,
  seat,
  type MeetingFixture,
} from "../support/committee";
import {
  DECISION_SEATS,
  DECISION_VOTERS,
  authorityRuleFor,
  caseFacts,
  closePackageVotes,
  type PackageFixture,
} from "../support/decision";
import { GRIEVANCE_SEATS } from "../support/grievance";
import { RATIONALE, concludeProceedings } from "../support/closure";

let caseA: string, caseB: string, caseExec: string, caseNumberB: string, ic: string, gc: string;

beforeAll(async () => {
  [caseA, caseB, caseExec] = await Promise.all([caseId("0001"), caseId("0002"), caseId("0003")]);
  ({ ic, gc } = await committeeIds());
  const [c] = await admin<
    { case_number: string }[]
  >`select case_number from case_mgmt.case_record where id = ${caseB}`;
  caseNumberB = c!.case_number;
});

const SIGMA = "Employee Sigma (synthetic)";
const OMEGA = "Employee Omega (synthetic)";
const ALLEGATION_TEXT = "Synthetic: unique-allegation-marker-2060 about the second subject.";
const FINDING_TEXT = "Synthetic: unique-rationale-marker-2060, the revised finding.";
const POLICY_REF = "POLICY-MARKER-2060";
const LAW_REF = "LAW-MARKER-2060";
/** Free text the reads never return: caseFacts' allegation and finding text and the markers above. */
const HIDDEN_TEXT = [
  "Synthetic: allegation against Employee Sigma.",
  "Synthetic: finding rationale text.",
  ALLEGATION_TEXT,
  FINDING_TEXT,
  POLICY_REF,
  LAW_REF,
];
/** Case columns and people fields; none is a key anywhere in either read. */
const CASE_CONTENT_KEYS = [
  "case_id",
  "case_number",
  "title",
  "summary",
  "rationale",
  "policy_reference",
  "law_reference",
  "person_id",
  "user_id",
  "department",
  "display_name",
  "person_type",
  "created_by",
  "recorded_by",
  "added_by",
  "evidence_id",
  "reporter_id",
  "justification",
  "reason",
];

interface Choice {
  subject_id: string;
  position: number;
  subject_category: string;
  label: string | null;
}
interface ScopeChoices {
  committee_proceeding_id: string;
  label_mode: string;
  subjects: Choice[];
  allegations: {
    allegation_id: string;
    position: number;
    category: string;
    status: string;
    subject_id: string | null;
  }[];
  findings: {
    finding_id: string;
    allegation_id: string;
    subject_id: string | null;
    proceeding_role: string;
    version_no: number;
    result: string;
    recorded_at: string;
  }[];
}
interface ItemsView {
  committee_proceeding_id: string;
  label_mode: string;
  packages: {
    package_id: string;
    status: string;
    items: {
      item_id: string;
      item_type: string;
      subjects: Choice[];
      allegations: { allegation_id: string; category: string }[];
    }[];
  }[];
  finding_votes: {
    vote_item_id: string;
    meeting_id: string;
    status: string;
    finding: {
      finding_id: string;
      version_no: number;
      is_current_version: boolean;
      result: string;
      proceeding_role: string;
      allegation: { allegation_id: string; category: string };
      subject: Choice | null;
    };
  }[];
}

/** R2's keys as 2060 returns them: 2086 adds the caller's capabilities beside them (ADR-056), pinned by its own spec. */
const KEYS_2086 = ["capabilities", "open_vote_in", "taint_resolutions"];
const keys2060 = (o: object) =>
  Object.keys(o)
    .filter((k) => !KEYS_2086.includes(k))
    .sort();

const scope = (tx: Scenario["tx"], cp: string | null) =>
  tx<{ v: ScopeChoices }[]>`select api.committee_scope_choices(${cp}) as v`;
const items = (tx: Scenario["tx"], cp: string | null) =>
  tx<{ v: ItemsView }[]>`select api.committee_items_view(${cp}) as v`;

async function scopeAs(s: Scenario, user: UserKey, cp: string): Promise<ScopeChoices> {
  await s.as(user);
  const [r] = await scope(s.tx, cp);
  return r!.v;
}
async function itemsAs(s: Scenario, user: UserKey, cp: string): Promise<ItemsView> {
  await s.as(user);
  const [r] = await items(s.tx, cp);
  return r!.v;
}

/** Both reads refuse `user` as if the proceeding did not exist. */
async function refused(s: Scenario, user: UserKey, cp: string): Promise<void> {
  await s.as(user);
  await s.expectError("CDF_NOT_FOUND", (tx) => items(tx, cp));
  await s.expectError("CDF_NOT_FOUND", (tx) => scope(tx, cp));
}

function keysDeep(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, keys));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      keysDeep(v, keys);
    }
  return keys;
}

/** No case column or people field as a key; none of the hidden text, no name, no case id or number. */
function expectNoCaseContent(v: object, extraHidden: string[] = []) {
  expect([...keysDeep(v)].filter((k) => CASE_CONTENT_KEYS.includes(k))).toEqual([]);
  const text = JSON.stringify(v);
  for (const hidden of [...HIDDEN_TEXT, SIGMA, OMEGA, caseB, caseNumberB, ...extraHidden]) {
    expect(text).not.toContain(hidden);
  }
}

async function ledger(s: OwnerScenario, action: string) {
  await s.asOwner();
  return s.tx<
    {
      actor_id: string;
      case_id: string;
      category: string;
      outcome: string;
      object_type: string;
      object_id: string;
      reason: string | null;
      metadata: Record<string, unknown>;
    }[]
  >`select actor_id, case_id, category, outcome, object_type, object_id, reason, metadata
    from audit.audit_event where action = ${action} order by seq`;
}

/** The owner's recorded decision on the DEC-02 label card adopts display names (test fixture; the card is open). */
async function displayNames(s: OwnerScenario): Promise<void> {
  await s.asOwner();
  await s.tx`update decision.committee_label_policy set effective_to = now() where effective_to is null`;
  await s.tx`insert into decision.committee_label_policy (effective_from, label_mode, owner_decision_reference)
             values (now(), 'DISPLAY_NAME', 'SYNTHETIC-TEST owner decision fixture')`;
}

interface Built extends PackageFixture {
  cp: string;
  omega: string;
  omegaAllegation: string;
  withdrawn: string;
  /** Version 2 of the referred investigation's finding: the current version. */
  current: string;
  /** A finding on the same allegation in a LEGAL_REVIEW proceeding, neither the committee's nor its parent. */
  sibling: string;
  elsewhere: string[];
}

/**
 * Case B with two subjects (Sigma, Omega), an allegation against each and a third one withdrawn, a referred
 * investigation whose finding has a second version, a legal review's finding, and a subject and allegation on case A.
 * Case B is referred to the seated Investigation Committee from the investigation; the voters are present at an open
 * deliberation and the secretary drafts a package: a sanction on Sigma and a case-wide corrective action.
 */
async function build(s: OwnerScenario): Promise<Built> {
  await seat(s, ic, DECISION_SEATS);
  await authorityRuleFor(s, "CORRECTIVE_ACTION");
  const facts = await caseFacts(s, caseB);
  await s.as("caseManager");
  const [omega] = await s.tx<{ id: string }[]>`
    select api.add_case_subject(${caseB}, ${OMEGA}, 'CONTRACTOR', null) as id`;
  const [omegaAllegation] = await s.tx<{ id: string }[]>`
    select api.add_allegation(${caseB}, 'CONFLICT_OF_INTEREST', ${ALLEGATION_TEXT}, ${omega!.id}, ${POLICY_REF},
      ${LAW_REF}) as id`;
  const [withdrawn] = await s.tx<{ id: string }[]>`
    select api.add_allegation(${caseB}, 'BRIBERY', 'Synthetic: an allegation later withdrawn.', ${omega!.id}, null,
      null) as id`;
  // AMB-026: a sanction is adopted only after a defence notice on the allegation.
  await s.tx`select api.issue_defence_notice(${facts.subject}, 'Synthetic: you are invited to respond.',
    ${[facts.allegation]}::uuid[], now() + interval '10 days')`;
  const [legalReview] = await s.tx<{ id: string }[]>`
    select api.open_proceeding(${caseB}, 'LEGAL_REVIEW', null, ${REASON}) as id`;
  const [kappa] = await s.tx<{ id: string }[]>`
    select api.add_case_subject(${caseA}, 'Employee Kappa (synthetic)', 'EMPLOYEE', null) as id`;
  const [kappaAllegation] = await s.tx<{ id: string }[]>`
    select api.add_allegation(${caseA}, 'FRAUD', 'Synthetic: an allegation on another case.', ${kappa!.id}, null,
      null) as id`;
  await s.as("investigatorB");
  const [current] = await s.tx<{ id: string }[]>`
    select api.record_finding(${facts.allegation}, null, ${facts.proceeding}, 'PARTIALLY_SUBSTANTIATED',
      ${FINDING_TEXT}) as id`;
  const [sibling] = await s.tx<{ id: string }[]>`
    select api.record_finding(${facts.allegation}, null, ${legalReview!.id}, 'NOT_SUBSTANTIATED',
      'Synthetic: a finding of another proceeding.') as id`;
  // No api.* command withdraws an allegation on main (coordinator 12:12): the owner sets it, rolled back.
  await s.asOwner();
  await s.tx`update case_mgmt.allegation set status = 'WITHDRAWN' where id = ${withdrawn!.id}`;
  const meeting = await scheduleMeeting(s, ic, caseB, facts.proceeding);
  await openWithPresent(s, meeting, DECISION_VOTERS);
  await s.as("committeeSecretary");
  const [pkg] = await s.tx<{ id: string }[]>`
    select api.create_recommendation_package(${meeting.committeeProceeding}, 'PACKAGE') as id`;
  const [sanction] = await s.tx<{ id: string }[]>`
    select api.add_recommendation_item(${pkg!.id}, 'DISCIPLINARY_SANCTION', 'WARNING', null,
      'Synthetic: written warning for the first subject.', ${[facts.subject]}::uuid[], ${[facts.allegation]}::uuid[]) as id`;
  const [corrective] = await s.tx<{ id: string }[]>`
    select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null,
      'Synthetic: strengthen the approval controls.', null, null) as id`;
  return {
    ...facts,
    meeting,
    cp: meeting.committeeProceeding,
    pkg: pkg!.id,
    sanction: sanction!.id,
    corrective: corrective!.id,
    omega: omega!.id,
    omegaAllegation: omegaAllegation!.id,
    withdrawn: withdrawn!.id,
    current: current!.id,
    sibling: sibling!.id,
    elsewhere: [kappa!.id, kappaAllegation!.id],
  };
}

/** Participants of a meeting by user key. */
async function participants(s: OwnerScenario, meeting: string): Promise<Record<string, string>> {
  await s.asOwner();
  const rows = await s.tx<{ id: string; user_id: string }[]>`
    select id, user_id from committee.meeting_participant where meeting_id = ${meeting}`;
  const byUser = Object.fromEntries(Object.entries(USERS).map(([k, v]) => [v, k]));
  return Object.fromEntries(rows.map((r) => [byUser[r.user_id]!, r.id]));
}

describe("the secretary's choices (api.committee_scope_choices; spec §5 R1)", () => {
  it("N7, N8, N14: every subject, the allegations less the withdrawn, the current findings in scope; ids, codes and positions only; audited with counts", async () => {
    await ownerScenario(async (s) => {
      const b = await build(s);
      const v = await scopeAs(s, "committeeSecretary", b.cp);
      expect(Object.keys(v).sort()).toEqual([
        "allegations",
        "committee_proceeding_id",
        "findings",
        "label_mode",
        "subjects",
      ]);
      expect(v.committee_proceeding_id).toBe(b.cp);
      expect(v.label_mode).toBe("ORDINAL");
      // Positions follow the case's own order (subjects and allegations are append-only); a withdrawn allegation keeps
      // its place and is left out.
      await s.asOwner();
      const subjects = await s.tx<{ id: string; subject_category: string }[]>`
        select id, subject_category from case_mgmt.case_subject where case_id = ${caseB} order by added_at, id`;
      expect(subjects.map((r) => r.id).sort()).toEqual([b.subject, b.omega].sort());
      expect(v.subjects).toEqual(
        subjects.map((r, i) => ({
          subject_id: r.id,
          position: i + 1,
          subject_category: r.subject_category,
          label: null,
        })),
      );
      const allegations = await s.tx<
        { id: string; category: string; status: string; subject_id: string | null; description: string }[]
      >`select id, category, status, subject_id, description from case_mgmt.allegation
        where case_id = ${caseB} order by created_at, id`;
      expect(v.allegations).toEqual(
        allegations
          .map((a, i) => ({
            allegation_id: a.id,
            position: i + 1,
            category: a.category,
            status: a.status,
            subject_id: a.subject_id,
          }))
          .filter((a) => a.status !== "WITHDRAWN"),
      );
      expect(v.allegations.map((a) => a.allegation_id)).toEqual(
        expect.arrayContaining([b.allegation, b.omegaAllegation]),
      );
      // The current version of the referred investigation's finding only (on the allegation's subject): never the
      // superseded version, never another proceeding's finding (CDF-214's scope).
      expect(v.findings).toEqual([
        {
          finding_id: b.current,
          allegation_id: b.allegation,
          subject_id: b.subject,
          proceeding_role: "REFERRED",
          version_no: 2,
          result: "PARTIALLY_SUBSTANTIATED",
          recorded_at: expect.any(String),
        },
      ]);
      expectNoCaseContent(v, [
        b.finding,
        b.sibling,
        b.withdrawn,
        ...b.elsewhere,
        ...allegations.map((a) => a.description),
      ]);
      expect(keysDeep(v).has("description")).toBe(false);
      // Audited: one business event on the case, counts only.
      expect(await ledger(s, "COMMITTEE_SCOPE_VIEWED")).toEqual([
        {
          actor_id: USERS.committeeSecretary,
          case_id: caseB,
          category: "BUSINESS",
          outcome: "SUCCESS",
          object_type: "committee_proceeding",
          object_id: b.cp,
          reason: null,
          metadata: { subjects: 2, allegations: allegations.length - 1, findings: 1 },
        },
      ]);
    });
  });

  it("N1, N4, N6, N13, N14: members and the case team are refused; outsiders cannot tell the proceeding exists; refusals record no read", async () => {
    await ownerScenario(async (s) => {
      const b = await build(s);
      await s.as("caseManager");
      await s.tx`select api.link_subject_portal_account(${b.subject}, ${USERS.employee}, ${REASON})`;
      // Seated members and the case team: FORBIDDEN (the case team works in its case-homed tabs).
      for (const u of [
        "committeeChair",
        "legal",
        "lead",
        "caseManager",
        "investigatorB",
        "grcDirector",
        "triage",
      ] as UserKey[]) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", (tx) => scope(tx, b.cp));
      }
      // No seat (a global committee role, the platform and committee administrators, a legal reviewer), the subject's
      // portal account, other staff: NOT_FOUND on both reads, alike for a random id.
      for (const u of [
        "committee",
        "platformAdmin",
        "complianceManager",
        "legalB",
        "employee",
        "investigatorA",
        "intake",
        "internalAudit",
      ] as UserKey[]) {
        for (const id of [b.cp, randomUUID()]) await refused(s, u, id);
      }
      await s.as("committeeSecretary");
      for (const id of [randomUUID(), null]) {
        await s.expectError("CDF_NOT_FOUND", (tx) => scope(tx, id));
        await s.expectError("CDF_NOT_FOUND", (tx) => items(tx, id));
      }
      await s.as(null);
      await s.expectError("permission denied", (tx) => scope(tx, b.cp));
      await s.expectError("permission denied", (tx) => items(tx, b.cp));
      await s.asOwner();
      expect(
        await s.tx`select has_function_privilege('anon', 'api.committee_scope_choices(uuid)', 'execute') as r1,
                          has_function_privilege('anon', 'api.committee_items_view(uuid)', 'execute') as r2`,
      ).toEqual([{ r1: false, r2: false }]);
      expect(await ledger(s, "COMMITTEE_SCOPE_VIEWED")).toEqual([]);
      expect(await ledger(s, "COMMITTEE_ITEMS_VIEWED")).toEqual([]);
    });
  });

  it("N5, N2: only an open Investigation Committee proceeding of an active case; an Investigation Committee seat never probes the Grievance Committee", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, DECISION_SEATS);
      const cp = await refer(s, ic, caseB);
      // While the proceeding is open the case does not close (CON-022, migration 2060), so an open proceeding always has
      // an active case behind it.
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:OPEN_PROCEEDINGS",
        (tx) => tx`select api.close_case(${caseB}, 'NO_ACTION', ${RATIONALE})`,
      );
      await concludeProceedings(s, caseB);
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:PROCEEDING_CLOSED", (tx) => scope(tx, cp));
      // Concluded: the committee side keeps the adoption snapshot and the packets; the items read is the case team's.
      for (const u of ["lead", "committeeChair", "committeeSecretary"] as UserKey[]) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => items(tx, cp));
      }
      expect((await itemsAs(s, "caseManager", cp)).packages).toEqual([]);
      // The Grievance Committee builds no package.
      await seat(s, gc, GRIEVANCE_SEATS);
      const gcp = await refer(s, gc, caseA);
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:NOT_AN_INVESTIGATION_COMMITTEE", (tx) => scope(tx, gcp));
      // N2: the chair sits on the Investigation Committee only.
      await refused(s, "committeeChair", gcp);
    });
  });

  it("CDF-213 (migration 2060): an item never names a withdrawn allegation", async () => {
    await ownerScenario(async (s) => {
      const b = await build(s);
      await s.as("committeeSecretary");
      const add = (tx: Scenario["tx"], allegations: string[]) =>
        tx`select api.add_recommendation_item(${b.pkg}, 'CORRECTIVE_ACTION', null, null,
             'Synthetic: an item on the allegations.', null, ${allegations}::uuid[])`;
      await s.expectError("CDF_CONFLICT:ALLEGATION_WITHDRAWN", (tx) => add(tx, [b.withdrawn]));
      await s.expectError("CDF_CONFLICT:ALLEGATION_WITHDRAWN", (tx) =>
        add(tx, [b.omegaAllegation, b.withdrawn]),
      );
      await add(s.tx, [b.omegaAllegation]);
    });
  });
});

describe("what the items in front of the committee are about (api.committee_items_view; spec §5 R2)", () => {
  it("N7, N9, N11, N14: by position and category under the ORDINAL default, never a name; the reads open nothing (DEC-02)", async () => {
    await ownerScenario(async (s) => {
      const b = await build(s);
      await s.as("committeeSecretary");
      const [fv] = await s.tx<{ id: string }[]>`
        select api.open_vote_item(${b.meeting.meeting}, 'FINDING', ${b.current}, 'Finding on the first allegation (synthetic)') as id`;
      await s.asOwner();
      const [pos] = await s.tx<{ n: number }[]>`
        select count(*)::int as n from case_mgmt.case_subject o, case_mgmt.case_subject s
        where s.id = ${b.subject} and o.case_id = s.case_id and (o.added_at, o.id) <= (s.added_at, s.id)`;
      const sigma = { subject_id: b.subject, position: pos!.n, subject_category: "EMPLOYEE", label: null };
      const readers: UserKey[] = ["committeeSecretary", "committeeChair", "legal", "lead", "caseManager"];
      for (const u of readers) {
        const v = await itemsAs(s, u, b.cp);
        expect(keys2060(v), u).toEqual([
          "committee_proceeding_id",
          "finding_votes",
          "label_mode",
          "packages",
        ]);
        expect(v.label_mode).toBe("ORDINAL");
        expect(v.packages.map((p) => [p.package_id, p.status])).toEqual([[b.pkg, "DRAFT"]]);
        const [sanction, corrective] = v.packages[0]!.items;
        expect(keys2060(sanction!)).toEqual([
          "allegations",
          "case_wide",
          "committee_result",
          "depends_on",
          "description",
          "exclusivity_group",
          "item_id",
          "item_type",
          "proposed_sanction_text",
          "requires_legal_justification",
          "sanction_code",
          "subjects",
          "verification_status",
        ]);
        expect([sanction!.item_id, sanction!.item_type]).toEqual([b.sanction, "DISCIPLINARY_SANCTION"]);
        expect(sanction!.subjects).toEqual([sigma]);
        expect(sanction!.allegations).toEqual([{ allegation_id: b.allegation, category: "FRAUD" }]);
        expect([corrective!.item_id, corrective!.subjects, corrective!.allegations]).toEqual([
          b.corrective,
          [],
          [],
        ]);
        // A FINDING vote shows to those who deliberate in its meeting; the case team works from the case.
        expect(v.finding_votes, u).toEqual(
          u === "caseManager"
            ? []
            : [
                {
                  vote_item_id: fv!.id,
                  meeting_id: b.meeting.meeting,
                  sequence_no: expect.any(Number),
                  status: "OPEN",
                  finding: {
                    finding_id: b.current,
                    version_no: 2,
                    is_current_version: true,
                    result: "PARTIALLY_SUBSTANTIATED",
                    proceeding_role: "REFERRED",
                    allegation: { allegation_id: b.allegation, category: "FRAUD" },
                    subject: sigma,
                  },
                },
              ],
        );
        expectNoCaseContent(v, [b.finding, b.sibling, ...b.elsewhere]);
      }
      // Put to the committee: still no name under ORDINAL.
      await s.as("committeeSecretary");
      await s.tx`select api.submit_package_for_vote(${b.pkg})`;
      for (const u of ["lead", "committeeSecretary"] as UserKey[]) {
        const v = await itemsAs(s, u, b.cp);
        expect(v.packages[0]!.items[0]!.subjects).toEqual([sigma]);
        expectNoCaseContent(v);
      }
      // Audited: one business event per read, counts only.
      const ev = await ledger(s, "COMMITTEE_ITEMS_VIEWED");
      expect(ev.map((e) => [e.actor_id, e.metadata])).toEqual([
        ...readers.map((u) => [USERS[u], { packages: 1, finding_votes: u === "caseManager" ? 0 : 1 }]),
        [USERS.lead, { packages: 1, finding_votes: 1 }],
        [USERS.committeeSecretary, { packages: 1, finding_votes: 1 }],
      ]);
      for (const e of ev) {
        expect(e).toMatchObject({
          case_id: caseB,
          category: "BUSINESS",
          outcome: "SUCCESS",
          object_type: "committee_proceeding",
          object_id: b.cp,
          reason: null,
        });
      }
      // N11, DEC-02 regression: after the reads the committee side still reads no case table and cannot open the case.
      await s.asOwner();
      const people = (
        await s.tx<
          { person_id: string }[]
        >`select person_id from case_mgmt.case_subject where case_id = ${caseB}`
      ).map((r) => r.person_id);
      for (const u of ["committeeSecretary", "committeeChair", "legal", "lead"] as UserKey[]) {
        await s.as(u);
        expect(await s.tx`select id from case_mgmt.case_record where id = ${caseB}`, u).toEqual([]);
        expect(await s.tx`select id from case_mgmt.case_subject where case_id = ${caseB}`, u).toEqual([]);
        expect(await s.tx`select id from case_mgmt.person where id = any(${people}::uuid[])`, u).toEqual([]);
        expect(await s.tx`select id from case_mgmt.allegation where case_id = ${caseB}`, u).toEqual([]);
        expect(await s.tx`select id from case_mgmt.finding where case_id = ${caseB}`, u).toEqual([]);
        expect(await s.tx`select api.open_case(${caseB}) as ok`, u).toEqual([{ ok: false }]);
      }
    });
  });

  it("N9, N15, N13: under DISPLAY_NAME a member sees no name on a DRAFT package, then the adoption snapshot's own; the legal reviewer reads neither", async () => {
    await ownerScenario(async (s) => {
      const b = await build(s);
      await displayNames(s);
      const sigmaLabel = (v: ItemsView) => v.packages[0]!.items[0]!.subjects[0]!.label;
      // DRAFT, never put to the committee: the seated members get no name; the secretary and the case team do.
      expect(sigmaLabel(await itemsAs(s, "lead", b.cp))).toBeNull();
      expect(sigmaLabel(await itemsAs(s, "committeeChair", b.cp))).toBeNull();
      expect(sigmaLabel(await itemsAs(s, "committeeSecretary", b.cp))).toBe(SIGMA);
      expect(sigmaLabel(await itemsAs(s, "caseManager", b.cp))).toBe(SIGMA);
      const choices = await scopeAs(s, "committeeSecretary", b.cp);
      expect(choices.label_mode).toBe("DISPLAY_NAME");
      expect(choices.subjects.map((x) => x.label).sort()).toEqual([OMEGA, SIGMA].sort());
      // Put to the committee, the members see the name.
      await closePackageVotes(s, b);
      expect(sigmaLabel(await itemsAs(s, "lead", b.cp))).toBe(SIGMA);
      // N15: after adoption the live labels equal the adoption snapshot's.
      await s.as("committeeSecretary");
      expect(await s.tx`select api.record_package_adoption(${b.pkg}) as status`).toEqual([
        { status: "ADOPTED" },
      ]);
      const live = await itemsAs(s, "lead", b.cp);
      await s.asOwner();
      const snaps = await s.tx<
        {
          item_id: string;
          snapshot: {
            subjects: { subject_id: string; label: string; category: string }[];
            allegations: { allegation_id: string; category: string }[];
          };
        }[]
      >`select item_id, snapshot from decision.item_adoption where package_id = ${b.pkg}`;
      expect(snaps.map((r) => r.item_id).sort()).toEqual([b.sanction, b.corrective].sort());
      for (const snap of snaps) {
        const item = live.packages[0]!.items.find((i) => i.item_id === snap.item_id)!;
        expect(
          item.subjects.map((x) => ({
            subject_id: x.subject_id,
            label: x.label,
            category: x.subject_category,
          })),
        ).toEqual(snap.snapshot.subjects);
        expect(item.allegations).toEqual(snap.snapshot.allegations);
      }
      // The assigned legal reviewer holds no seat: neither read.
      await s.as("committeeSecretary");
      await s.tx`select api.request_legal_review(${b.pkg}, ${USERS.legalB}, ${REASON}, ${[b.current]}::uuid[], null)`;
      await refused(s, "legalB", b.cp);
    });
  });

  it("the label mode is migration-managed: ORDINAL by default; DISPLAY_NAME needs the owner's recorded decision; no application role writes it", async () => {
    await ownerScenario(async (s) => {
      await s.as("platformAdmin");
      expect(
        await s.tx`select label_mode, owner_decision_reference, effective_to from decision.committee_label_policy`,
      ).toEqual([{ label_mode: "ORDINAL", owner_decision_reference: null, effective_to: null }]);
      await s.expectError(
        "permission denied",
        (
          tx,
        ) => tx`insert into decision.committee_label_policy (effective_from, label_mode, owner_decision_reference)
                   values (now(), 'DISPLAY_NAME', 'SYNTHETIC-TEST')`,
      );
      await s.expectError(
        "permission denied",
        (tx) => tx`update decision.committee_label_policy set effective_to = now()`,
      );
      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select id from decision.committee_label_policy`);
      await s.asOwner();
      await s.expectError(
        'new row for relation "committee_label_policy" violates check constraint',
        (
          tx,
        ) => tx`insert into decision.committee_label_policy (effective_from, label_mode, owner_decision_reference)
                   values (now(), 'DISPLAY_NAME', null)`,
      );
      await s.expectError(
        "committee label policy",
        (tx) => tx`update decision.committee_label_policy
                   set label_mode = 'DISPLAY_NAME', owner_decision_reference = 'SYNTHETIC-TEST'`,
      );
      await s.expectError(
        "decision.committee_label_policy is append-only",
        (tx) => tx`delete from decision.committee_label_policy`,
      );
      // A row is given an end once.
      await s.tx`update decision.committee_label_policy set effective_to = now() + interval '1 day'`;
      await s.expectError(
        "committee label policy",
        (tx) => tx`update decision.committee_label_policy set effective_to = now() + interval '2 days'`,
      );
      expect(await s.tx`select decision.committee_label_mode() as m`).toEqual([{ m: "ORDINAL" }]);
    });
  });
});

describe("who reads, at once (spec §5 N2, N3, N10, N12)", () => {
  it("N1, N2: a seat excluded at referral, ended, no longer cleared or conflicted with the case reads nothing from that moment", async () => {
    await ownerScenario(async (s) => {
      // legal is under-cleared for case B (RESTRICTED) when the referral snapshots the seats, and cleared again after.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'INTERNAL' where id = ${USERS.legal}`;
      await seat(s, ic, IC_SEATS);
      const cp = await refer(s, ic, caseB);
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'CONFIDENTIAL' where id = ${USERS.legal}`;
      expect(
        await s.tx`select case_gate_excluded from committee.proceeding_member
                   where committee_proceeding_id = ${cp} and user_id = ${USERS.legal}`,
      ).toEqual([{ case_gate_excluded: true }]);
      // The others read now, so the refusals below are not vacuous.
      for (const u of ["committeeChair", "legalB", "lead", "committeeSecretary"] as UserKey[]) {
        expect((await itemsAs(s, u, cp)).packages, u).toEqual([]);
      }
      await refused(s, "legal", cp);
      await refused(s, "committee", cp);
      // legalB's seat ends (AMB-039).
      await s.asOwner();
      const [m] = await s.tx<{ id: string }[]>`
        select id from committee.membership where committee_id = ${ic} and user_id = ${USERS.legalB} and ended_at is null`;
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(${m!.id}, now(), ${REASON})`;
      await refused(s, "legalB", cp);
      // lead's clearance drops below the case's.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'INTERNAL' where id = ${USERS.lead}`;
      await refused(s, "lead", cp);
      // The chair declares a conflict with the case after the snapshot.
      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseB}, ${USERS.committeeChair}, 'CONFLICT_DECLARED', 'Synthetic conflict')`;
      await refused(s, "committeeChair", cp);
      expect((await scopeAs(s, "committeeSecretary", cp)).committee_proceeding_id).toBe(cp);
    });
  });

  it("N3, N10: a meeting conflict in the proceeding closes both reads; a FINDING vote shows only to those who deliberate in its meeting", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, DECISION_SEATS);
      const facts = await caseFacts(s, caseB);
      const first = await scheduleMeeting(s, ic, caseB, facts.proceeding);
      const cp = first.committeeProceeding;
      await openWithPresent(s, first, DECISION_VOTERS);
      const openFindingVote = async (meeting: string) => {
        await s.as("committeeSecretary");
        const [v] = await s.tx<{ id: string }[]>`
          select api.open_vote_item(${meeting}, 'FINDING', ${facts.finding}, 'Finding on the allegation (synthetic)') as id`;
        return v!.id;
      };
      const v1 = await openFindingVote(first.meeting);
      // A second deliberation, open with the chair and legal; lead has not declared (PENDING).
      await s.as("committeeSecretary");
      const [m2] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Meeting room (synthetic)', null,
          now() + interval '2 days', now() + interval '2 days 2 hours', ${REASON}) as id`;
      const second: MeetingFixture = {
        committeeProceeding: cp,
        meeting: m2!.id,
        participant: await participants(s, m2!.id),
      };
      await openWithPresent(s, second, ["committeeChair", "legal"]);
      const v2 = await openFindingVote(second.meeting);
      const votes = async (u: UserKey) => (await itemsAs(s, u, cp)).finding_votes.map((v) => v.vote_item_id);
      expect(await votes("committeeChair")).toEqual([v1, v2]);
      expect(await votes("committeeSecretary")).toEqual([v1, v2]);
      expect(await votes("lead")).toEqual([v1]);
      // lead declares a conflict in the second meeting: the proceeding's items are closed to them (a member has no
      // choices either way).
      await s.as("lead");
      await s.tx`select api.declare_meeting_conflict(${second.participant.lead!}, 'CONFLICT_DECLARED', 'Synthetic: related party.')`;
      await s.expectError("CDF_NOT_FOUND", (tx) => items(tx, cp));
      await s.expectError("CDF_FORBIDDEN", (tx) => scope(tx, cp));
      // The secretary declares one: no choices (FORBIDDEN, as for create_recommendation_package) and no items.
      await s.as("committeeSecretary");
      await s.tx`select api.declare_meeting_conflict(${first.participant.committeeSecretary!}, 'CONFLICT_DECLARED', 'Synthetic: related party.')`;
      await s.expectError("CDF_FORBIDDEN", (tx) => scope(tx, cp));
      await s.expectError("CDF_NOT_FOUND", (tx) => items(tx, cp));
      expect(await votes("committeeChair")).toEqual([v1, v2]);
    });
  });

  it("N12: on a restricted case only a seat cleared for it reads, once the case authority approved the referral (DEC-F19)", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET'
                 where id in (${USERS.committeeChair}, ${USERS.committeeSecretary}, ${USERS.lead})`;
      await seat(s, ic, DECISION_SEATS);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`;
      const cp = await refer(s, ic, caseExec, "grcDirector");
      for (const u of ["lead", "committeeChair", "committeeSecretary", "grcDirector"] as UserKey[]) {
        expect((await itemsAs(s, u, cp)).committee_proceeding_id, u).toBe(cp);
      }
      expect((await scopeAs(s, "committeeSecretary", cp)).subjects).toEqual(expect.any(Array));
      // legal holds the seat but is cleared only to CONFIDENTIAL; the case manager has no access to the case.
      await refused(s, "legal", cp);
      await refused(s, "caseManager", cp);
    });
  });
});
