// Business architecture rebase, migration 2040 item 13 (ADR-040; DEC-F09, DEC-F17, DEC-F24, DEC-F28; AGENT-09 pack 3
// R1-R4; Phase 12 asks (a), (b), (c)): purpose read models for a referral, a grievance, an export request, a corrective
// action and a continuity import batch; the admissibility decider's read path; and the content-free referral,
// preliminary-review and grievance-decision notices. Each read opens exactly to whoever passes the object's read
// predicate (anyone else, an unknown id or a revoked user gets NOT_FOUND), names the case only under its metadata
// predicate, and offers a capability exactly when its command, run by the same user at that moment, succeeds: every
// capability is checked against its command in a savepoint that is rolled back. The notices carry ids only and reach
// exactly the users who must act and may open the object. Every step runs through the api.* commands as
// `authenticated`; the owner connection only reads the outbox and sets fixtures (a restricted case).
import { randomUUID } from "node:crypto";
import type { Tx } from "@cdf/infrastructure";
import { beforeAll, describe, expect, it } from "vitest";
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
import { REASON, committeeIds, seat, unseatDemoSeats } from "../support/committee";
import { draftPackage, voteOnPackage } from "../support/decision";
import { GRIEVANCE_GROUNDS, GRIEVANCE_SEATS, approvedGrievanceVote } from "../support/grievance";

const OPS = "b0000000-0000-4000-8000-000000000001";
const FIN = "b0000000-0000-4000-8000-000000000002";
const SUMMARY = "Synthetic: unique-referral-marker-2040, a referral summary for the read model test.";
const ESC = "Synthetic: unique-escalation-marker-2040, the rejection misreads the scope.";
const OBJECTION = "Synthetic: unique-objection-marker-2040, the rejection misreads the facts.";
const SUPPLEMENT = "Synthetic: unique-supplement-marker-2040, the missing reference.";
const SHA = "a".repeat(64);
const BY_ID = Object.fromEntries(Object.entries(USERS).map(([k, v]) => [v, k])) as Record<string, UserKey>;

let caseA: string, caseB: string, caseExec: string, ic: string, gc: string, caseText: string[];

beforeAll(async () => {
  [caseA, caseB, caseExec] = await Promise.all([caseId("0001"), caseId("0002"), caseId("0003")]);
  ({ ic, gc } = await committeeIds());
  const rows = await admin<{ case_number: string; title: string; summary: string | null }[]>`
    select case_number, title, summary from case_mgmt.case_record where id in (${caseA}, ${caseB}, ${caseExec})`;
  caseText = rows.flatMap((c) => [c.title, c.summary]).filter((t): t is string => !!t && t.length > 8);
});

// ---- The harness ---------------------------------------------------------------------------------------------------

type Caps = Record<string, boolean>;
interface View {
  [key: string]: unknown;
  status?: string;
  capabilities: Caps;
  case: { case_id: string | null; case_number: string | null };
}
type Probe = (tx: Tx) => Promise<unknown>;
/** Each capability's command(s), or SKIP where the command cannot be probed at this step (said where used). */
type Probes = Record<string, Probe[] | "SKIP">;
type Offered = Record<string, string[] | "NOT_FOUND">;

interface Model {
  fn: string;
  view: (tx: Tx, id: string) => Promise<{ v: View }[]>;
  /** The object's read predicate, as its table's RLS applies it to the caller. */
  sees: (tx: Tx, id: string) => Promise<boolean>;
  keys: string[];
  caps: string[];
  /** Keys that must never appear at any depth. */
  never: string[];
}

/** Every key at any depth. */
function keysDeep(value: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, child] of Object.entries(v)) {
        keys.add(k);
        walk(child);
      }
  };
  walk(value);
  return keys;
}

class Undo extends Error {}

/** Runs a command in a savepoint that is always rolled back: "OK", or the CDF error it refused with. Any other error
 *  (a test mistake, a missing grant) fails the test. */
async function attempt(s: Scenario, run: Probe): Promise<string> {
  try {
    await s.tx.savepoint(async (sp) => {
      await run(sp as unknown as Tx);
      throw new Undo();
    });
  } catch (error) {
    if (error instanceof Undo) return "OK";
    const message = (error as Error).message;
    if (message.startsWith("CDF_")) return message;
    throw error;
  }
  throw new Error("the savepoint was not rolled back");
}

/** The read as `user`: NOT_FOUND exactly when the read predicate fails; otherwise the keys, booleans, no forbidden key
 *  and no case text. */
async function read(s: Scenario, m: Model, user: UserKey, id: string): Promise<View | null> {
  await s.as(user);
  const who = `${m.fn} ${user}`;
  if (!(await m.sees(s.tx, id))) {
    await s.expectError("CDF_NOT_FOUND", (tx) => m.view(tx, id));
    return null;
  }
  const [r] = await m.view(s.tx, id);
  const v = r!.v;
  expect(Object.keys(v).sort(), who).toEqual([...m.keys].sort());
  expect(Object.keys(v.capabilities).sort(), who).toEqual([...m.caps].sort());
  for (const [k, x] of Object.entries(v.capabilities)) expect(typeof x, `${who} ${k}`).toBe("boolean");
  expect(
    [...keysDeep(v)].filter((k) => m.never.includes(k)),
    who,
  ).toEqual([]);
  const text = JSON.stringify(v);
  for (const t of caseText) expect(text, who).not.toContain(t);
  return v;
}

/** The case object holds its id and number only, and only under authz.can_view_case_metadata. */
async function expectCase(s: Scenario, v: View, caseIdValue: string | null, who: string) {
  expect(Object.keys(v.case).sort(), who).toEqual(["case_id", "case_number"]);
  const [m] = caseIdValue
    ? await s.tx<{ ok: boolean }[]>`select authz.can_view_case_metadata(${caseIdValue}) as ok`
    : [{ ok: false }];
  if (m!.ok) {
    expect(v.case.case_id, who).toBe(caseIdValue);
    expect(v.case.case_number, who).toMatch(/^CDF-DEMO-/);
  } else expect(v.case, who).toEqual({ case_id: null, case_number: null });
}

/**
 * For each user: the read (or NOT_FOUND), the case object, and every capability against its command run now by the
 * same user. A user who gets NOT_FOUND must also be refused by every command. Returns the capabilities offered to each
 * user, to pin; `after` runs last for each user (the queue checks).
 */
async function matrix(
  s: Scenario,
  m: Model,
  id: string,
  caseIdValue: string | null,
  users: UserKey[],
  probes: (v: View | null) => Probes,
  after?: (v: View | null, user: UserKey) => Promise<void>,
): Promise<Offered> {
  const offered: Offered = {};
  const mismatches: string[] = [];
  for (const user of users) {
    const v = await read(s, m, user, id);
    const p = probes(v);
    expect(Object.keys(p).sort()).toEqual([...m.caps].sort());
    if (v) await expectCase(s, v, caseIdValue, `${m.fn} ${user}`);
    for (const [flag, list] of Object.entries(p)) {
      if (list === "SKIP") continue;
      for (const probe of list) {
        await s.as(user);
        const result = await attempt(s, probe);
        const expected = v ? v.capabilities[flag] : false;
        if (expected !== (result === "OK"))
          mismatches.push(`${user} ${flag}: ${v ? `offered=${expected}` : "NOT_FOUND"} command=${result}`);
      }
    }
    offered[user] = v
      ? Object.entries(v.capabilities)
          .filter(([, x]) => x)
          .map(([k]) => k)
          .sort()
      : "NOT_FOUND";
    if (after) await after(v, user);
  }
  expect(mismatches, m.fn).toEqual([]);
  return offered;
}

/** The expected matrix: the named users' capabilities, NOT_FOUND for every other user in `users`. */
const offeredTo = (users: UserKey[], seen: Partial<Record<UserKey, string[]>>): Offered =>
  Object.fromEntries(users.map((u) => [u, seen[u] ?? "NOT_FOUND"]));

/** Every outbox row of a template on an object: the 1920 columns, ids and the deep link only, the dedupe key
 *  `<prefix>:<id>:<recipient>:<channel>`, an email twin for each in-app row, no marker or case text, and each
 *  recipient able to open the object. Returns the in-app recipients by user key, one per notice. */
async function told(
  s: OwnerScenario,
  template: string,
  objectId: string,
  objectType: string,
  path: string,
  prefix: string,
  opens: (tx: Tx, id: string) => Promise<boolean>,
): Promise<string[]> {
  await s.asOwner();
  const rows = await s.tx<{ recipient_id: string; channel: string; row: Record<string, unknown> }[]>`
    select recipient_id, channel, to_jsonb(o) as row from notify.outbox o
    where template_code = ${template} and object_id = ${objectId} order by recipient_id, channel, created_at`;
  for (const r of rows) {
    expect(Object.keys(r.row).sort()).toEqual([
      "attempts",
      "channel",
      "created_at",
      "dedupe_key",
      "deep_link",
      "delivered_at",
      "id",
      "object_id",
      "object_type",
      // Migration 2110 (AMB-210): null on a live notice; a restore notice names its workbook row and the original time.
      "original_event_at",
      "read_at",
      "recipient_id",
      "restored_row_id",
      "status",
      "template_code",
    ]);
    expect(r.row).toMatchObject({
      object_type: objectType,
      deep_link: `${path}${objectId}`,
      restored_row_id: null,
      original_event_at: null,
    });
    expect(r.row.dedupe_key).toMatch(new RegExp(`^${prefix}:[0-9a-f-]{36}:${r.recipient_id}:${r.channel}$`));
    const text = JSON.stringify(r.row);
    for (const marker of [
      "unique-referral-marker",
      "unique-escalation-marker",
      "unique-objection-marker",
      "unique-grounds-marker",
      "unique-supplement-marker",
      "CDF-DEMO-",
      ...caseText,
    ])
      expect(text).not.toContain(marker);
  }
  const inApp = rows.filter((r) => r.channel === "IN_APP").map((r) => r.recipient_id);
  expect(rows.filter((r) => r.channel === "EMAIL").map((r) => r.recipient_id)).toEqual(inApp);
  for (const id of new Set(inApp)) {
    const user = BY_ID[id];
    expect(user, id).toBeDefined();
    await s.as(user!);
    expect(await opens(s.tx, objectId), `${template} ${user}`).toBe(true);
  }
  await s.asOwner();
  return inApp.map((id) => BY_ID[id] ?? id).sort();
}

const VIEW_FNS = [
  "referral_view",
  "grievance_view",
  "export_request_view",
  "corrective_action_view",
  "bcp_import_batch_view",
] as const;

// ---- Referral ------------------------------------------------------------------------------------------------------

const REFERRAL: Model = {
  fn: "referral_view",
  view: (tx, id) => tx<{ v: View }[]>`select api.referral_view(${id}) as v`,
  sees: async (tx, id) => (await tx`select id from intake.referral where id = ${id}`).length === 1,
  keys: [
    "allegation_category",
    "capabilities",
    "case",
    "classification",
    "committee_id",
    "created_at",
    "decided_at",
    "decided_by",
    "delegation_id",
    "escalation",
    "events",
    "prepared_by",
    "reached_secretary_at",
    "referral_id",
    "referral_number",
    "row_version",
    "sector",
    "sector_approval_basis",
    "sector_approved_at",
    "sector_approved_by",
    "status",
    "submitted_at",
    "summary",
    "title",
    "updated_at",
  ],
  caps: [
    "may_accept",
    "may_comment",
    "may_decide_escalation",
    "may_escalate",
    "may_object",
    "may_reject",
    "may_resubmit",
    "may_return_for_completion",
    "may_sector_decide",
    "may_submit",
    "may_update",
    "may_withdraw",
  ],
  // R4: never the escalation target's reason, author or source.
  never: ["reason", "set_by", "source_reference", "source_status", "effective_from", "effective_to"],
};

const REFERRAL_USERS: UserKey[] = [
  "employee",
  "employeeB",
  "sectorHead",
  "financeEmployee",
  "committeeSecretary",
  "committeeChair",
  "committee",
  "caseManager",
  "grcDirector",
  "platformAdmin",
];

const referralProbes = (id: string) => (): Probes => ({
  may_update: [
    (tx) =>
      tx`select api.update_referral(${id}, 'Referral (synthetic)', ${SUMMARY}, 'FRAUD', 'RESTRICTED'::core.classification_level)`,
  ],
  may_submit: [(tx) => tx`select api.submit_referral(${id}, null)`],
  may_sector_decide: [
    (tx) => tx`select api.sector_decide_referral(${id}, 'APPROVE', null, null)`,
    (tx) => tx`select api.sector_decide_referral(${id}, 'RETURN', array['MISSING_DOCUMENTS'], null)`,
  ],
  may_accept: [
    (tx) => tx`select api.secretary_decide_referral(${id}, 'ACCEPT', null, null, ${USERS.caseManager})`,
  ],
  may_return_for_completion: [
    (tx) =>
      tx`select api.secretary_decide_referral(${id}, 'RETURN_FOR_COMPLETION', array['MISSING_INFORMATION'], null, null)`,
  ],
  may_reject: [
    (tx) => tx`select api.secretary_decide_referral(${id}, 'REJECT', array['OUT_OF_SCOPE'], null, null)`,
  ],
  may_resubmit: [(tx) => tx`select api.resubmit_referral(${id}, null)`],
  may_object: [(tx) => tx`select api.object_to_referral_rejection(${id}, ${OBJECTION})`],
  may_escalate: [(tx) => tx`select api.escalate_referral_rejection(${id}, ${ESC})`],
  may_decide_escalation: [
    (tx) => tx`select api.decide_referral_escalation(${id}, 'UPHOLD', array['OUT_OF_SCOPE'], null, null)`,
    (tx) => tx`select api.decide_referral_escalation(${id}, 'ACCEPT', null, null, ${USERS.caseManager})`,
  ],
  may_withdraw: [(tx) => tx`select api.withdraw_referral(${id}, ${REASON})`],
  may_comment: [(tx) => tx`select api.comment_on_referral(${id}, 'Synthetic: a comment on the referral.')`],
});

interface ReferralQueueRow {
  referral_id: string;
  awaiting: string;
  escalation_committee_id: string | null;
  escalation_committee_code: string | null;
  escalation_seat: string | null;
}

/** The queue holds the referral exactly when it awaits the user, as the view's capabilities say; the escalation target
 *  only on the target holder's row (R4). */
const referralQueueAgrees = (s: Scenario, id: string) => async (v: View | null, user: UserKey) => {
  await s.as(user);
  const rows = await s.tx<ReferralQueueRow[]>`select * from api.referral_queue() where referral_id = ${id}`;
  const c = v?.capabilities ?? {};
  const awaiting = c.may_sector_decide
    ? "SECTOR_DECISION"
    : c.may_accept
      ? "SECRETARY_DECISION"
      : c.may_decide_escalation
        ? "ESCALATION_DECISION"
        : v?.status === "RETURNED_FOR_COMPLETION" && c.may_submit
          ? "COMPLETION"
          : null;
  expect(
    rows.map((r) => r.awaiting),
    `referral_queue ${user}`,
  ).toEqual(awaiting ? [awaiting] : []);
  for (const r of rows)
    expect(
      [r.escalation_committee_id, r.escalation_committee_code, r.escalation_seat],
      `referral_queue ${user}`,
    ).toEqual(awaiting === "ESCALATION_DECISION" ? [ic, "IC", "CHAIR"] : [null, null, null]);
};

/** Seats a chair, a secretary and one voting member on the Investigation Committee (as referral-preliminary.spec). */
async function constitute(s: Scenario) {
  await unseatDemoSeats(s);
  for (const [user, seatCode] of [
    ["committeeChair", "CHAIR"],
    ["committeeSecretary", "SECRETARY"],
    ["committee", "MEMBER"],
  ] as const) {
    await s.tx`select api.appoint_committee_member(${ic}, ${USERS[user]}, ${seatCode}, now() - interval '1 day', null, 'DEMO-APPT')`;
  }
}

async function draftReferral(s: Scenario): Promise<string> {
  await s.as("employee");
  const [r] = await s.tx<{ id: string }[]>`
    select api.create_referral(${OPS}, 'Referral (synthetic)', ${SUMMARY}, 'FRAUD',
      'RESTRICTED'::core.classification_level) as id`;
  return r!.id;
}

const sectorApproves = async (s: Scenario, id: string) => {
  await s.as("sectorHead");
  await s.tx`select api.sector_decide_referral(${id}, 'APPROVE', null, null)`;
};
const secretaryRejects = async (s: Scenario, id: string) => {
  await s.as("committeeSecretary");
  await s.tx`select api.secretary_decide_referral(${id}, 'REJECT', array['OUT_OF_SCOPE'], null, null)`;
};

const referralOpens = async (tx: Tx, id: string) =>
  (await tx`select id from intake.referral where id = ${id}`).length === 1;

describe("api.referral_view and api.referral_queue (authz.can_view_referral; R4)", () => {
  it("T-AMB-104: outsiders, unknown ids and revoked users get NOT_FOUND and an empty queue; anonymous callers cannot call either", async () => {
    await scenario(async (s) => {
      await constitute(s);
      const id = await draftReferral(s);
      await s.tx`select api.submit_referral(${id}, null)`;
      for (const user of [
        "employeeB",
        "financeEmployee",
        "committeeSecretary",
        "grcDirector",
        "revoked",
      ] as const) {
        await s.as(user);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.referral_view(${id})`);
        expect(await s.tx`select * from api.referral_queue() where referral_id = ${id}`, user).toEqual([]);
      }
      await s.as("sectorHead");
      for (const unknown of [randomUUID(), null])
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.referral_view(${unknown}::uuid)`);
      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select api.referral_view(${id})`);
      await s.expectError("permission denied", (tx) => tx`select * from api.referral_queue()`);
    });
  });

  it("from draft to acceptance: the view opens exactly to who reads the referral, each capability matches its command, the queue agrees", async () => {
    await scenario(async (s) => {
      await constitute(s);
      const id = await draftReferral(s);
      const step = async (
        label: string,
        seen: Partial<Record<UserKey, string[]>>,
        caseIdValue: string | null = null,
      ) =>
        expect(
          await matrix(
            s,
            REFERRAL,
            id,
            caseIdValue,
            REFERRAL_USERS,
            referralProbes(id),
            referralQueueAgrees(s, id),
          ),
          label,
        ).toEqual(offeredTo(REFERRAL_USERS, seen));
      const PREPARER_EDITS = ["may_comment", "may_submit", "may_update", "may_withdraw"];
      // A draft is its preparer's alone.
      await step("DRAFT", { employee: PREPARER_EDITS });
      await s.as("employee");
      await s.tx`select api.submit_referral(${id}, null)`;
      // The head decides; the preparer may still withdraw; another sector member sees nothing.
      await step("SUBMITTED_TO_HEAD", {
        employee: ["may_comment", "may_withdraw"],
        sectorHead: ["may_comment", "may_sector_decide"],
      });
      await s.as("sectorHead");
      await s.tx`select api.sector_decide_referral(${id}, 'RETURN', array['MISSING_DOCUMENTS'], null)`;
      await step("DRAFT after the sector's return", {
        employee: PREPARER_EDITS,
        sectorHead: ["may_comment"],
      });
      await s.as("employee");
      await s.tx`select api.submit_referral(${id}, null)`;
      await sectorApproves(s, id);
      // The secretary decides; the chair and the members see nothing yet.
      await step("SUBMITTED_TO_SECRETARY", {
        employee: ["may_comment"],
        sectorHead: ["may_comment"],
        committeeSecretary: ["may_accept", "may_comment", "may_reject", "may_return_for_completion"],
      });
      await s.as("committeeSecretary");
      await s.tx`select api.secretary_decide_referral(${id}, 'RETURN_FOR_COMPLETION', array['MISSING_INFORMATION'], null, null)`;
      await step("RETURNED_FOR_COMPLETION", {
        employee: PREPARER_EDITS,
        sectorHead: ["may_comment"],
        committeeSecretary: ["may_comment"],
      });
      await s.as("employee");
      await s.tx`select api.submit_referral(${id}, null)`;
      await sectorApproves(s, id);
      await s.as("committeeSecretary");
      const [c] = await s.tx<{ id: string }[]>`
        select api.secretary_decide_referral(${id}, 'ACCEPT', null, null, ${USERS.caseManager}) as id`;
      // Accepted: the new case's team reads it too (its owner, and the GRC Director who sees every case), and the case
      // is named to whoever sees its metadata.
      await step(
        "ACCEPTED",
        {
          employee: ["may_comment"],
          sectorHead: ["may_comment"],
          committeeSecretary: ["may_comment"],
          caseManager: ["may_comment"],
          grcDirector: ["may_comment"],
        },
        c!.id,
      );
    });
  });

  it("DEC-F09 and R4: rejection, objection and escalation; the escalation shows the target's committee and seat only", async () => {
    await scenario(async (s) => {
      await constitute(s);
      const id = await draftReferral(s);
      await s.tx`select api.submit_referral(${id}, null)`;
      await sectorApproves(s, id);
      const step = async (label: string, seen: Partial<Record<UserKey, string[]>>) =>
        expect(
          await matrix(s, REFERRAL, id, null, REFERRAL_USERS, referralProbes(id), referralQueueAgrees(s, id)),
          label,
        ).toEqual(offeredTo(REFERRAL_USERS, seen));
      const PREPARER_AFTER_REJECTION = ["may_comment", "may_resubmit", "may_update", "may_withdraw"];
      const READ_ONLY = ["may_comment"];
      await secretaryRejects(s, id);
      // One rejection: resubmission or objection, never escalation; never an objection by the preparer.
      await step("REJECTED once", {
        employee: PREPARER_AFTER_REJECTION,
        sectorHead: ["may_comment", "may_object", "may_resubmit"],
        committeeSecretary: READ_ONLY,
      });
      await s.as("sectorHead");
      await s.tx`select api.object_to_referral_rejection(${id}, ${OBJECTION})`;
      // An objection goes back to the secretary, who may accept or reject it but not return it for completion.
      await step("OBJECTED", {
        employee: READ_ONLY,
        sectorHead: READ_ONLY,
        committeeSecretary: ["may_accept", "may_comment", "may_reject"],
      });
      await secretaryRejects(s, id);
      // The repeated rejection offers the escalation (DEC-F09); a rejected objection is not objected to again.
      await step("REJECTED after the objection", {
        employee: PREPARER_AFTER_REJECTION,
        sectorHead: ["may_comment", "may_escalate", "may_resubmit"],
        committeeSecretary: READ_ONLY,
      });
      await s.as("employee");
      await s.tx`select api.resubmit_referral(${id}, null)`;
      await sectorApproves(s, id);
      await secretaryRejects(s, id);
      await step("REJECTED again", {
        employee: PREPARER_AFTER_REJECTION,
        sectorHead: ["may_comment", "may_escalate", "may_object", "may_resubmit"],
        committeeSecretary: READ_ONLY,
      });
      await s.as("sectorHead");
      await s.tx`select api.escalate_referral_rejection(${id}, ${ESC})`;
      // Only the holder of the target seat (the IC Chair, owner default) reads and decides it; a member does not.
      await step("ESCALATED", {
        employee: READ_ONLY,
        sectorHead: READ_ONLY,
        committeeSecretary: READ_ONLY,
        committeeChair: ["may_comment", "may_decide_escalation"],
      });
      // R4: the target's committee and seat; nothing of its reason, author or source, by key or by text.
      const [target] = await admin<{ reason: string; source_reference: string }[]>`
        select reason, source_reference from intake.referral_escalation_target where effective_to is null`;
      for (const user of ["committeeChair", "sectorHead", "employee", "committeeSecretary"] as const) {
        const v = (await read(s, REFERRAL, user, id))!;
        expect(Object.keys(v.escalation as object).sort(), user).toEqual([
          "committee_code",
          "committee_id",
          "escalated_at",
          "seat",
        ]);
        expect(v.escalation, user).toMatchObject({ committee_id: ic, committee_code: "IC", seat: "CHAIR" });
        expect(JSON.stringify(v), user).not.toContain(target!.reason);
        expect(JSON.stringify(v), user).not.toContain(target!.source_reference);
        // The table itself stays COMMITTEE_ADMIN's (R4).
        expect(await s.tx`select id from intake.referral_escalation_target`, user).toEqual([]);
      }
      await s.as("committeeChair");
      await s.tx`select api.decide_referral_escalation(${id}, 'UPHOLD', array['OUT_OF_SCOPE'], null, null)`;
      // One escalation per rejection; resubmission is never capped.
      await step("REJECTED, escalation upheld", {
        employee: PREPARER_AFTER_REJECTION,
        sectorHead: ["may_comment", "may_resubmit"],
        committeeSecretary: READ_ONLY,
        committeeChair: READ_ONLY,
      });
    });
  });
});

// ---- Grievance -----------------------------------------------------------------------------------------------------

const GRIEVANCE: Model = {
  fn: "grievance_view",
  view: (tx, id) => tx<{ v: View }[]>`select api.grievance_view(${id}) as v`,
  sees: async (tx, id) => (await tx`select id from grievance.grievance where id = ${id}`).length === 1,
  keys: [
    "admissibility_decider",
    "assessments",
    "capabilities",
    "case",
    "channel",
    "committee_proceeding_id",
    "completion_requests",
    "contested_authority_decision_id",
    "contested_decision_date",
    "contested_decision_relationship",
    "contested_items",
    "decision_notice_id",
    "grievant",
    "grievance_id",
    "grounds",
    "is_late",
    "kind",
    "new_evidence_description",
    "new_evidence_reference",
    "non_admission_decider",
    "original_document_reference",
    "original_submission_date",
    "outcome",
    "pending_decider",
    "reconsideration_of",
    "recorded_at",
    "recorded_by",
    "row_version",
    "rule_set_id",
    "status",
    "updated_at",
    "window_days",
    "withdrawal",
  ],
  caps: [
    "may_assess",
    "may_complete",
    "may_decide",
    "may_file_reconsideration",
    "may_record_outcome",
    "may_record_reconsideration",
    "may_request_completion",
    "may_withdraw",
  ],
  never: ["protected_identity", "reporter_wb_id", "identity"],
};

const GRIEVANCE_USERS: UserKey[] = [
  "committeeSecretary",
  "committee",
  "legal",
  "investigatorA",
  "employee",
  "employeeB",
  "caseManager",
  "grcDirector",
  "platformAdmin",
];

const grievanceProbes =
  (g: string, vote: () => string | null = () => null) =>
  (): Probes => ({
    may_assess: [
      (tx) => tx`select api.assess_grievance_admissibility(${g}, 'ADMISSIBLE', null, ${REASON})`,
      (tx) => tx`select api.assess_grievance_admissibility(${g}, 'INADMISSIBLE', null, ${REASON})`,
    ],
    may_request_completion: [(tx) => tx`select api.request_grievance_completion(${g}, ${REASON})`],
    may_complete: [(tx) => tx`select api.complete_grievance(${g}, ${SUPPLEMENT})`],
    may_decide: [
      (tx) => tx`select api.decide_grievance_admissibility(${g}, 'INADMISSIBLE', 'GC-DEMO-2040', ${REASON})`,
      (tx) => tx`select api.decide_grievance_admissibility(${g}, 'ADMISSIBLE', 'GC-DEMO-2040', ${REASON})`,
    ],
    may_withdraw: [(tx) => tx`select api.withdraw_grievance(${g}, ${REASON})`],
    may_record_outcome: [
      (tx) =>
        tx`select api.record_grievance_outcome(${g}, ${["UPHOLD"]}::text[], null, ${vote() ?? randomUUID()}::uuid,
          'Synthetic: the grievance outcome.')`,
    ],
    may_file_reconsideration: [
      (tx) =>
        tx`select api.file_grievance_reconsideration(${g}, ${GRIEVANCE_GROUNDS},
          'Synthetic: new evidence description.', 'EVIDENCE-DEMO-2040')`,
    ],
    may_record_reconsideration: [
      (tx) =>
        tx`select api.record_grievance_reconsideration(${g}, 'EMAIL', now(), ${GRIEVANCE_GROUNDS}, 'EMAIL-DEMO-2040',
          'Synthetic: new evidence description.', 'EVIDENCE-DEMO-2040')`,
    ],
  });

interface GrievanceQueueRow {
  grievance_id: string;
  awaiting: string;
  case_id: string | null;
  case_number: string | null;
}

const grievanceQueueAgrees = (s: Scenario, g: string) => async (v: View | null, user: UserKey) => {
  await s.as(user);
  const rows = await s.tx<GrievanceQueueRow[]>`select * from api.grievance_queue() where grievance_id = ${g}`;
  const c = v?.capabilities ?? {};
  const awaiting = c.may_decide
    ? "ADMISSIBILITY_DECISION"
    : c.may_assess
      ? "ASSESSMENT"
      : c.may_record_outcome
        ? "OUTCOME"
        : null;
  expect(
    rows.map((r) => r.awaiting),
    `grievance_queue ${user}`,
  ).toEqual(awaiting ? [awaiting] : []);
  for (const r of rows)
    expect([r.case_id, r.case_number !== null], `grievance_queue ${user}`).toEqual(
      v!.case.case_id ? [v!.case.case_id, true] : [null, false],
    );
};

/** A case B subject linked to `user`'s portal account; returns the portal link. */
async function portalLink(
  s: Scenario,
  user: UserKey,
  label: string,
  onCase = caseB,
  by: UserKey = "caseManager",
) {
  await s.as(by);
  const [subj] = await s.tx<{ id: string }[]>`
    select api.add_case_subject(${onCase}, ${label}, 'EMPLOYEE', null) as id`;
  const [l] = await s.tx<{ id: string }[]>`
    select api.link_subject_portal_account(${subj!.id}, ${USERS[user]}, ${REASON}) as id`;
  return l!.id;
}
async function fileGrievance(s: Scenario, user: UserKey, link: string): Promise<string> {
  await s.as(user);
  const [g] = await s.tx<{ id: string }[]>`
    select api.file_grievance(${link}, now(), ${GRIEVANCE_GROUNDS}) as id`;
  return g!.id;
}
const reviseGc = async (s: Scenario, changes: Record<string, unknown>) => {
  await s.as("platformAdmin");
  await s.tx`select api.revise_committee_rule_set(${gc}, now(), ${s.tx.json(changes as never)}, 'APPROVED', ${REASON})`;
};
const assess = async (s: Scenario, g: string, assessment: string, by: UserKey = "committeeSecretary") => {
  await s.as(by);
  const [r] = await s.tx<{ r: string }[]>`
    select api.assess_grievance_admissibility(${g}, ${assessment}, null, ${REASON}) as r`;
  return r!.r;
};
const grievanceOpens = async (tx: Tx, id: string) =>
  (await tx`select id from grievance.grievance where id = ${id}`).length === 1;
const decisionNotices = (s: OwnerScenario, g: string) =>
  told(
    s,
    "GRIEVANCE_ADMISSIBILITY_DECISION_REQUESTED",
    g,
    "GRIEVANCE",
    "/grievances/",
    "grievance-decision",
    grievanceOpens,
  );

/** What a user reads of a grievance through the tables themselves. */
async function grievanceRows(s: Scenario, user: UserKey, g: string) {
  await s.as(user);
  const count = async (table: string) =>
    (
      await s.tx<{ n: number }[]>`
        select count(*)::int as n from ${s.tx("grievance." + table)} where ${s.tx(table === "grievance" ? "id" : "grievance_id")} = ${g}`
    )[0]!.n;
  return {
    grievance: await count("grievance"),
    admissibility_assessment: await count("admissibility_assessment"),
    completion_request: await count("completion_request"),
    grievance_supplement: await count("grievance_supplement"),
    case: (await s.tx`select id from case_mgmt.case_record where id = ${caseB}`).length,
  };
}

describe("api.grievance_view and api.grievance_queue (authz.can_view_grievance, or the decider)", () => {
  it("T-AMB-104: outsiders, unknown ids and revoked users get NOT_FOUND and an empty queue; anonymous callers cannot call either", async () => {
    await scenario(async (s) => {
      await seat(s, gc, GRIEVANCE_SEATS);
      const g = await fileGrievance(
        s,
        "employee",
        await portalLink(s, "employee", "Employee Sigma (synthetic)"),
      );
      for (const user of ["employeeB", "legal", "investigatorA", "platformAdmin", "revoked"] as const) {
        await s.as(user);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.grievance_view(${g})`);
        expect(await s.tx`select * from api.grievance_queue() where grievance_id = ${g}`, user).toEqual([]);
      }
      await s.as("committeeSecretary");
      for (const unknown of [randomUUID(), null])
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.grievance_view(${unknown}::uuid)`);
      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select api.grievance_view(${g})`);
      await s.expectError("permission denied", (tx) => tx`select * from api.grievance_queue()`);
    });
  });

  it("from filing to the outcome: each capability matches its command and the queue agrees", async () => {
    await scenario(async (s) => {
      await seat(s, gc, GRIEVANCE_SEATS);
      await reviseGc(s, { grievance_completion_days: 5 });
      const g = await fileGrievance(
        s,
        "employee",
        await portalLink(s, "employee", "Employee Sigma (synthetic)"),
      );
      let vote: string | null = null;
      const step = async (label: string, seen: Partial<Record<UserKey, string[]>>) =>
        expect(
          await matrix(
            s,
            GRIEVANCE,
            g,
            caseB,
            GRIEVANCE_USERS,
            grievanceProbes(g, () => vote),
            grievanceQueueAgrees(s, g),
          ),
          label,
        ).toEqual(offeredTo(GRIEVANCE_USERS, seen));
      // The case team (its owner, the GRC Director) reads a grievance on the case and acts on none of it.
      const CASE_TEAM = { caseManager: [], grcDirector: [] };
      // Received: the handling secretary assesses or asks for completion; the grievant may withdraw. The committee's
      // chair and members read nothing yet.
      await step("RECEIVED", {
        ...CASE_TEAM,
        committeeSecretary: ["may_assess", "may_request_completion"],
        employee: ["may_withdraw"],
      });
      await s.as("committeeSecretary");
      await s.tx`select api.request_grievance_completion(${g}, ${REASON})`;
      await step("RECEIVED, completion requested", {
        ...CASE_TEAM,
        committeeSecretary: [],
        employee: ["may_complete", "may_withdraw"],
      });
      await s.as("employee");
      await s.tx`select api.complete_grievance(${g}, ${SUPPLEMENT})`;
      expect(await assess(s, g, "INADMISSIBLE")).toBe("AWAITING_ADMISSIBILITY_DECISION");
      // DEC-F17: the committee decides the non-admission; the chair records it; every seated decider reads it.
      await step("AWAITING_ADMISSIBILITY_DECISION", {
        ...CASE_TEAM,
        committeeSecretary: [],
        committee: ["may_decide"],
        legal: [],
        investigatorA: [],
        employee: ["may_withdraw"],
      });
      await s.as("committee");
      await s.tx`select api.decide_grievance_admissibility(${g}, 'ADMISSIBLE', 'GC-DEMO-2040', ${REASON})`;
      // Admitted: the committee now reads it through its proceeding (1910).
      const ADMITTED = {
        ...CASE_TEAM,
        committeeSecretary: [],
        committee: [],
        legal: [],
        investigatorA: [],
        employee: ["may_withdraw"],
      };
      await step("ADMITTED", ADMITTED);
      vote = await approvedGrievanceVote(s, g);
      await step("ADMITTED, approved vote", { ...ADMITTED, committeeSecretary: ["may_record_outcome"] });
      await s.as("committeeSecretary");
      await s.tx`select api.record_grievance_outcome(${g}, ${["UPHOLD"]}::text[], null, ${vote}, 'Synthetic: the grievance outcome.')`;
      vote = null;
      // Decided: one reconsideration, filed by the grievant or recorded by the secretary (DEC-AMB-001).
      await step("DECIDED", {
        ...ADMITTED,
        committeeSecretary: ["may_record_reconsideration"],
        employee: ["may_file_reconsideration"],
      });
    });
  });
});

describe("the admissibility decider's read path (DEC-F17, Phase 12 ask (a))", () => {
  it("T-AMB-087, T-AMB-105: under the default COMMITTEE rule each seated decider is told, ids only, and reads the grievance and its assessment until the decision", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GRIEVANCE_SEATS);
      const g = await fileGrievance(
        s,
        "employee",
        await portalLink(s, "employee", "Employee Sigma (synthetic)"),
      );
      const other = await fileGrievance(
        s,
        "employeeB",
        await portalLink(s, "employeeB", "Employee Tau (synthetic)"),
      );
      const NOTHING = {
        grievance: 0,
        admissibility_assessment: 0,
        completion_request: 0,
        grievance_supplement: 0,
        case: 0,
      };
      const DECIDER = { ...NOTHING, grievance: 1, admissibility_assessment: 1 };
      // Before the assessment a member reads nothing and nobody is asked.
      expect(await grievanceRows(s, "legal", g)).toEqual(NOTHING);
      expect(await decisionNotices(s, g)).toEqual([]);
      expect(await assess(s, g, "INADMISSIBLE")).toBe("AWAITING_ADMISSIBILITY_DECISION");
      // The chair and both members are asked (the secretary already decided as far as they may); each reads the
      // grievance and its assessment, never the case.
      expect(await decisionNotices(s, g)).toEqual(["committee", "investigatorA", "legal"]);
      for (const user of ["committee", "legal", "investigatorA", "committeeSecretary"] as const)
        expect(await grievanceRows(s, user, g), user).toEqual(DECIDER);
      const legalView = (await read(s, GRIEVANCE, "legal", g))!;
      expect(legalView).toMatchObject({
        pending_decider: "COMMITTEE",
        withdrawal: null,
        outcome: null,
        case: { case_id: null, case_number: null },
      });
      expect(legalView.assessments).toEqual([
        expect.objectContaining({
          stage: "SECRETARY_ASSESSMENT",
          assessment: "INADMISSIBLE",
          decided_by_role: null,
        }),
      ]);
      // The grievant: their own grievance only, never its assessment; another subject reads nothing.
      expect(await grievanceRows(s, "employee", g)).toEqual({ ...NOTHING, grievance: 1 });
      expect(await grievanceRows(s, "employeeB", g)).toEqual(NOTHING);
      // The grievant reads only their own grievance, never its assessment or who decides.
      const own = (await read(s, GRIEVANCE, "employee", g))!;
      expect(own).toMatchObject({ assessments: null, pending_decider: null });
      await s.as("employee");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.grievance_view(${other})`);
      // The read ends with the decision.
      await s.as("committee");
      await s.tx`select api.decide_grievance_admissibility(${g}, 'INADMISSIBLE', 'GC-DEMO-2040', ${REASON})`;
      for (const user of ["committee", "legal", "investigatorA"] as const) {
        expect(await grievanceRows(s, user, g), user).toEqual(NOTHING);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.grievance_view(${g})`);
      }
      // Asked once, when it started to wait; the decision asks nobody again. The earlier notice's link now opens to
      // NOT_FOUND for the deciders, like any object they no longer read.
      await s.asOwner();
      expect(
        await s.tx`select count(*)::int as n from notify.outbox
                   where template_code = 'GRIEVANCE_ADMISSIBILITY_DECISION_REQUESTED' and object_id = ${g}
                     and channel = 'IN_APP'`,
      ).toEqual([{ n: 3 }]);
    });
  });

  it("under the CHAIR rule a member who is not the decider reads nothing and is not told", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GRIEVANCE_SEATS);
      await reviseGc(s, { non_admission_decider: "CHAIR" });
      const g = await fileGrievance(
        s,
        "employee",
        await portalLink(s, "employee", "Employee Sigma (synthetic)"),
      );
      expect(await assess(s, g, "INADMISSIBLE")).toBe("AWAITING_ADMISSIBILITY_DECISION");
      expect(await decisionNotices(s, g)).toEqual(["committee"]);
      expect(await grievanceRows(s, "committee", g)).toMatchObject({
        grievance: 1,
        admissibility_assessment: 1,
      });
      for (const user of ["legal", "investigatorA"] as const)
        expect(await grievanceRows(s, user, g), user).toMatchObject({
          grievance: 0,
          admissibility_assessment: 0,
        });
      expect(
        await matrix(s, GRIEVANCE, g, caseB, GRIEVANCE_USERS, grievanceProbes(g), grievanceQueueAgrees(s, g)),
      ).toEqual(
        offeredTo(GRIEVANCE_USERS, {
          committeeSecretary: [],
          committee: ["may_decide"],
          employee: ["may_withdraw"],
          caseManager: [],
          grcDirector: [],
        }),
      );
    });
  });

  it("an EXTERNAL decision is recorded by reference only: no platform read and no notice for the committee", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GRIEVANCE_SEATS);
      await reviseGc(s, { non_admission_decider: "EXTERNAL" });
      const g = await fileGrievance(
        s,
        "employee",
        await portalLink(s, "employee", "Employee Sigma (synthetic)"),
      );
      expect(await assess(s, g, "INADMISSIBLE")).toBe("AWAITING_ADMISSIBILITY_DECISION");
      expect(await decisionNotices(s, g)).toEqual([]);
      // The handling secretary records the external decision by its reference; the committee reads nothing.
      expect(
        await matrix(s, GRIEVANCE, g, caseB, GRIEVANCE_USERS, grievanceProbes(g), grievanceQueueAgrees(s, g)),
      ).toEqual(
        offeredTo(GRIEVANCE_USERS, {
          committeeSecretary: ["may_decide"],
          employee: ["may_withdraw"],
          caseManager: [],
          grcDirector: [],
        }),
      );
    });
  });

  it("T-AMB-106: on a restricted case no seat holder who cannot already see the case is told or reads it (fail closed)", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, [
        ["committee", "CHAIR"],
        ["grcDeputy", "SECRETARY"],
        ["grcSectorHead", "ALTERNATE_SECRETARY"],
        ["legal", "MEMBER"],
      ]);
      const link = await portalLink(s, "employee", "Employee Sigma (synthetic)", caseExec, "grcDirector");
      const g = await fileGrievance(s, "employee", link);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_grievance_handling(${g}, ${USERS.grcDeputy}, ${REASON})`;
      expect(await assess(s, g, "INADMISSIBLE", "grcDeputy")).toBe("AWAITING_ADMISSIBILITY_DECISION");
      // Neither the chair nor the member works the restricted case: neither is asked, reads it, or may decide it.
      expect(await decisionNotices(s, g)).toEqual([]);
      for (const user of ["committee", "legal"] as const) {
        expect(await grievanceRows(s, user, g), user).toMatchObject({
          grievance: 0,
          admissibility_assessment: 0,
        });
        await s.as(user);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.grievance_view(${g})`);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) =>
            tx`select api.decide_grievance_admissibility(${g}, 'INADMISSIBLE', 'GC-DEMO-2040', ${REASON})`,
        );
      }
    });
  });
});

// ---- Export request ------------------------------------------------------------------------------------------------

const EXPORT: Model = {
  fn: "export_request_view",
  view: (tx, id) => tx<{ v: View }[]>`select api.export_request_view(${id}) as v`,
  sees: async (tx, id) => (await tx`select id from exchange.export_request where id = ${id}`).length === 1,
  keys: [
    "approvals",
    "approvals_required",
    "audience",
    "authority_approval_required",
    "authority_decision",
    "cancelled_at",
    "capabilities",
    "case",
    "classification_at_submit",
    "created_at",
    "current",
    "decided_at",
    "export_request_id",
    "external_party",
    "format",
    "generated_at",
    "items",
    "justification",
    "matched_rules",
    "preview_hash",
    "previewed_at",
    "purpose",
    "recipients",
    "requested_by",
    "row_version",
    "sent_at",
    "status",
    "submitted_at",
    "submitted_hash",
    "updated_at",
  ],
  caps: [
    "may_add_item",
    "may_add_recipient",
    "may_approve",
    "may_authority_approve",
    "may_authority_reject",
    "may_cancel",
    "may_generate",
    "may_preview",
    "may_record_sent",
    "may_reject",
    "may_submit",
  ],
  // Never the generated file or the document itself.
  never: ["storage_key", "document", "content", "deliver_to"],
};

const EXPORT_USERS: UserKey[] = [
  "caseManager",
  "grcDirector",
  "grcDeputy",
  "lead",
  "investigatorA",
  "committee",
  "platformAdmin",
];

const exportProbes =
  (r: string, onCase: string, classification: string, addItem: boolean) =>
  (v: View | null): Probes => ({
    // The case summary can be added once: after that, the add is not probed (a second add is ALREADY_ADDED).
    may_add_item: addItem
      ? [(tx) => tx`select api.add_export_item(${r}, 'CASE_SUMMARY', ${onCase})`]
      : "SKIP",
    may_add_recipient: [
      (tx) => tx`select api.add_export_recipient(${r}, 'EXTERNAL', null, 'officer.beta@example.test')`,
    ],
    may_preview: [(tx) => tx`select api.preview_export(${r})`],
    may_submit: [
      (tx) =>
        tx`select api.submit_export(${r}, ${(v?.preview_hash as string | null) ?? SHA}, ${classification}::core.classification_level)`,
    ],
    may_approve: [
      (tx) =>
        tx`select api.decide_export(${r}, 'APPROVE', ${REASON}, ${(v?.submitted_hash as string | null) ?? SHA})`,
    ],
    may_reject: [
      (tx) =>
        tx`select api.decide_export(${r}, 'REJECT', ${REASON}, ${(v?.submitted_hash as string | null) ?? SHA})`,
    ],
    may_authority_approve: [
      (tx) =>
        tx`select api.decide_restricted_export(${r}, 'APPROVE', ${REASON}, ${(v?.submitted_hash as string | null) ?? SHA})`,
    ],
    may_authority_reject: [
      (tx) =>
        tx`select api.decide_restricted_export(${r}, 'REJECT', ${REASON}, ${(v?.submitted_hash as string | null) ?? SHA})`,
    ],
    may_generate: [(tx) => tx`select api.generate_export(${r})`],
    may_record_sent: [(tx) => tx`select api.record_export_sent(${r})`],
    may_cancel: [(tx) => tx`select api.cancel_export(${r}, ${REASON})`],
  });

describe("api.export_request_view (authz.can_view_export; DEC-F24)", () => {
  it("outsiders, unknown ids and revoked users get NOT_FOUND; anonymous callers cannot call it", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const [r] = await s.tx<{ id: string }[]>`
        select api.create_export_request(${caseB}, 'PDF', 'INTERNAL', 'REGULATORY_OR_EXTERNAL_AUTHORITY', null, null) as id`;
      for (const user of ["investigatorA", "committee", "platformAdmin", "lead", "revoked"] as const) {
        await s.as(user);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.export_request_view(${r!.id})`);
      }
      await s.as("caseManager");
      for (const unknown of [randomUUID(), null])
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.export_request_view(${unknown}::uuid)`);
      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select api.export_request_view(${r!.id})`);
    });
  });

  it("T-AMB-113 (DEC-F24): the requester is never offered an approval; each capability matches its command to the record of sending", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const [r] = await s.tx<{ id: string }[]>`
        select api.create_export_request(${caseB}, 'EMAIL', 'EXTERNAL', 'REGULATORY_OR_EXTERNAL_AUTHORITY',
          'Regulator Alpha (synthetic)', 'Synthetic: the regulator asked for the case summary.') as id`;
      const id = r!.id;
      const step = async (label: string, seen: Partial<Record<UserKey, string[]>>, addItem = false) =>
        expect(
          await matrix(s, EXPORT, id, caseB, EXPORT_USERS, exportProbes(id, caseB, "RESTRICTED", addItem)),
          label,
        ).toEqual(offeredTo(EXPORT_USERS, seen));
      // A draft is the requester's alone: the approvers see it once submitted.
      await step(
        "DRAFT empty",
        { caseManager: ["may_add_item", "may_add_recipient", "may_cancel", "may_preview"] },
        true,
      );
      await s.as("caseManager");
      await s.tx`select api.add_export_item(${id}, 'CASE_SUMMARY', ${caseB})`;
      await s.tx`select api.add_export_recipient(${id}, 'EXTERNAL', null, 'officer.alpha@example.test')`;
      const [p] = await s.tx<{ h: string }[]>`select api.preview_export(${id}) ->> 'hash' as h`;
      // The case summary is in: adding it again is ALREADY_ADDED, so the add is not probed from here (still offered
      // while the draft holds fewer than 50 items).
      await step("DRAFT previewed", {
        caseManager: ["may_add_item", "may_add_recipient", "may_cancel", "may_preview", "may_submit"],
      });
      await s.as("caseManager");
      await s.tx`select api.submit_export(${id}, ${p!.h}, 'RESTRICTED'::core.classification_level)`;
      // DEC-F24: the requester holds EXPORT_APPROVE and is still never offered an approval; two others are.
      await step("SUBMITTED", {
        caseManager: ["may_cancel", "may_preview"],
        grcDirector: ["may_approve", "may_preview", "may_reject"],
        grcDeputy: ["may_approve", "may_preview", "may_reject"],
      });
      await s.as("caseManager");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_export(${id}, 'APPROVE', ${REASON}, ${p!.h})`,
      );
      const v = (await read(s, EXPORT, "caseManager", id))!;
      expect(v.current).toEqual({
        hash: p!.h,
        withheld: 0,
        refused_by_rule: false,
        approvals_required: 1,
        authority_approval_required: false,
        next_stage: 1,
        authority_consent_blocked: null,
      });
      expect(v.submitted_hash).toBe(p!.h);
      await s.as("grcDirector");
      await s.tx`select api.decide_export(${id}, 'APPROVE', ${REASON}, ${p!.h})`;
      // One stage was needed: approved, the requester generates; nobody approves again.
      await step("APPROVED", {
        caseManager: ["may_cancel", "may_generate", "may_preview"],
        grcDirector: ["may_preview"],
        grcDeputy: ["may_preview"],
      });
      await s.as("caseManager");
      await s.tx`select api.generate_export(${id})`;
      await step("GENERATED", {
        caseManager: ["may_preview", "may_record_sent"],
        grcDirector: ["may_preview"],
        grcDeputy: ["may_preview"],
      });
      await s.as("caseManager");
      await s.tx`select api.record_export_sent(${id})`;
      await step("SENT", {
        caseManager: ["may_preview"],
        grcDirector: ["may_preview"],
        grcDeputy: ["may_preview"],
      });
    });
  });

  it("a restricted case: only its Restricted Case Authority is offered the authority's decision, and the command agrees", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${caseExec}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      await s.as("grcDeputy");
      const [r] = await s.tx<{ id: string }[]>`
        select api.create_export_request(${caseExec}, 'PDF', 'INTERNAL', 'REGULATORY_OR_EXTERNAL_AUTHORITY', null, null) as id`;
      await s.tx`select api.add_export_item(${r!.id}, 'CASE_SUMMARY', ${caseExec})`;
      const [p] = await s.tx<{ h: string }[]>`select api.preview_export(${r!.id}) ->> 'hash' as h`;
      await s.tx`select api.submit_export(${r!.id}, ${p!.h}, 'SECRET'::core.classification_level)`;
      const users: UserKey[] = ["grcDeputy", "grcDirector", "caseManager", "lead", "platformAdmin"];
      // The case owner, as its Restricted Case Authority, decides for the authority and may give the stage; the
      // requester is offered neither (DEC-F23, DEC-F24); nobody else sees it.
      expect(
        await matrix(s, EXPORT, r!.id, caseExec, users, exportProbes(r!.id, caseExec, "SECRET", false)),
      ).toEqual(
        offeredTo(users, {
          grcDeputy: ["may_cancel", "may_preview"],
          grcDirector: [
            "may_approve",
            "may_authority_approve",
            "may_authority_reject",
            "may_preview",
            "may_reject",
          ],
        }),
      );
      await s.as("grcDirector");
      await s.tx`select api.decide_restricted_export(${r!.id}, 'APPROVE', ${REASON}, ${p!.h})`;
      // The authority decides once.
      expect(
        await matrix(s, EXPORT, r!.id, caseExec, users, exportProbes(r!.id, caseExec, "SECRET", false)),
      ).toEqual(
        offeredTo(users, {
          grcDeputy: ["may_cancel", "may_preview"],
          grcDirector: ["may_approve", "may_preview", "may_reject"],
        }),
      );
    });
  });

  it("CDF-208: the case's authority is never offered consent to an export they requested; the view says why it waits", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${caseExec}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      const [r] = await s.tx<{ id: string }[]>`
        select api.create_export_request(${caseExec}, 'PDF', 'INTERNAL', 'REGULATORY_OR_EXTERNAL_AUTHORITY', null, null) as id`;
      await s.tx`select api.add_export_item(${r!.id}, 'CASE_SUMMARY', ${caseExec})`;
      const [p] = await s.tx<{ h: string }[]>`select api.preview_export(${r!.id}) ->> 'hash' as h`;
      await s.tx`select api.submit_export(${r!.id}, ${p!.h}, 'SECRET'::core.classification_level)`;
      const users: UserKey[] = ["grcDeputy", "grcDirector", "caseManager", "lead", "platformAdmin"];
      // The requester (the case's owner and authority) is offered neither the stage nor the consent; the deputy, who
      // can view the case, is offered the stage.
      expect(
        await matrix(s, EXPORT, r!.id, caseExec, users, exportProbes(r!.id, caseExec, "SECRET", false)),
      ).toEqual(
        offeredTo(users, {
          grcDirector: ["may_cancel", "may_preview"],
          grcDeputy: ["may_approve", "may_preview", "may_reject"],
        }),
      );
      for (const u of ["grcDirector", "grcDeputy"] as const) {
        const v = (await read(s, EXPORT, u, r!.id))!;
        expect((v.current as Record<string, unknown>).authority_consent_blocked, u).toBe(
          "REQUESTER_IS_CASE_AUTHORITY",
        );
      }
    });
  });
});

// ---- Corrective action ---------------------------------------------------------------------------------------------

const ACTION: Model = {
  fn: "corrective_action_view",
  view: (tx, id) => tx<{ v: View }[]>`select api.corrective_action_view(${id}) as v`,
  sees: async (tx, id) => (await tx`select id from decision.corrective_action where id = ${id}`).length === 1,
  keys: [
    "action_id",
    "action_type",
    "capabilities",
    "case",
    "completed_at",
    "completion_submitted_at",
    "created_at",
    "created_by",
    "description",
    "due_date",
    "events",
    "origin",
    "owner",
    "percent_complete",
    "policy",
    "row_version",
    "sequence_no",
    "status",
    "title",
    "updated_at",
    "verified_by",
    "version_no",
    "versions",
    "waived_at",
  ],
  caps: [
    "may_assign_owner",
    "may_change_due_date",
    "may_dispose",
    "may_record_progress",
    "may_reopen",
    "may_set_owner_kind",
    "may_set_shared_owner_kind",
    "may_submit_completion",
    "may_verify",
    "may_waive",
  ],
  // R3: never the pool's author or reason; never the case's content.
  never: ["created_by_pool", "reason", "summary", "allegations", "subjects", "evidence", "findings"],
};

const ACTION_USERS: UserKey[] = [
  "caseManager",
  "financeEmployee",
  "employeeB",
  "employee",
  "grcDirector",
  "investigatorA",
  "committeeSecretary",
  "platformAdmin",
];

const actionProbes =
  (a: string, newOwner: UserKey = "employeeB") =>
  (): Probes => ({
    may_record_progress: [
      (tx) => tx`select api.record_corrective_action_progress(${a}, 40, 'Synthetic: progress note.')`,
    ],
    may_submit_completion: [
      (tx) => tx`select api.submit_corrective_action_completion(${a}, 'Synthetic: done.', 'SOP-DEMO-2040')`,
    ],
    may_verify: [(tx) => tx`select api.verify_corrective_action(${a}, 'VERIFIED', null)`],
    may_reopen: [(tx) => tx`select api.reopen_corrective_action(${a}, ${REASON})`],
    may_waive: [(tx) => tx`select api.waive_corrective_action(${a}, 'MEMO-DEMO-2040', ${REASON})`],
    // DEC-AMB-014: only an action of a superseded decision, from a source of the replacement decision.
    may_dispose: [
      (tx) =>
        tx`select api.dispose_superseded_corrective_action(${a}, 'WAIVE', 'MEMO-DEMO-2040', ${REASON}, null, null,
          null, null)`,
    ],
    may_change_due_date: [
      (tx) => tx`select api.change_corrective_action_due_date(${a}, current_date + 60, ${REASON})`,
    ],
    may_assign_owner: [
      (tx) => tx`select api.assign_corrective_action_owner(${a}, ${USERS[newOwner]}, ${REASON})`,
    ],
    may_set_owner_kind: [
      (tx) =>
        tx`select api.set_corrective_action_owner_kind(${a}, 'EXTERNAL_PARTY', null, null, 'Vendor Alpha (synthetic)', ${REASON})`,
    ],
    may_set_shared_owner_kind: [
      (tx) =>
        tx`select api.set_corrective_action_owner_kind(${a}, 'ORG_UNIT', ${FIN}::uuid, null, null, ${REASON})`,
    ],
  });

/** An open corrective action on case B owned by financeEmployee (as api-idor.spec); employee and employeeB are
 *  implementation owners too. */
async function openAction(s: Scenario): Promise<{ action: string; item: string; decision: string }> {
  await s.as("platformAdmin");
  for (const u of [USERS.financeEmployee, USERS.employeeB, USERS.employee])
    await s.tx`select api.grant_role(${u}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner for the test')`;
  const f = await draftPackage(s, ic, caseB);
  await s.as("committeeSecretary");
  await s.tx`select api.withdraw_recommendation_item(${f.sanction}, ${REASON})`;
  await voteOnPackage(s, f);
  await s.as("committeeSecretary");
  await s.tx`select api.submit_to_authority(${f.pkg})`;
  const [d] = await s.tx<{ id: string }[]>`
    select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now(),
      'Chief Executive (synthetic)', 'MEMO-DEMO-2040', null, null) as id`;
  await s.as("caseManager");
  const [a] = await s.tx<{ id: string }[]>`
    select api.open_corrective_action(${f.corrective}, 'Synthetic: strengthen controls',
      'Synthetic: add a second approver.', ${USERS.financeEmployee}, current_date + 30) as id`;
  return { action: a!.id, item: f.corrective, decision: d!.id };
}

describe("api.corrective_action_view (authz.can_view_corrective_action; R2, R3)", () => {
  it("outsiders, unknown ids and revoked users get NOT_FOUND; anonymous callers cannot call it", async () => {
    await scenario(async (s) => {
      const { action } = await openAction(s);
      for (const user of [
        "investigatorA",
        "employeeB",
        "committeeSecretary",
        "platformAdmin",
        "revoked",
      ] as const) {
        await s.as(user);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.corrective_action_view(${action})`);
      }
      await s.as("caseManager");
      for (const unknown of [randomUUID(), null])
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.corrective_action_view(${unknown}::uuid)`);
      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select api.corrective_action_view(${action})`);
    });
  });

  it("the owner sees the card, never the case or the decision it executes; each capability matches its command", async () => {
    await scenario(async (s) => {
      const { action, item, decision } = await openAction(s);
      const step = async (label: string, seen: Partial<Record<UserKey, string[]>>) =>
        expect(await matrix(s, ACTION, action, caseB, ACTION_USERS, actionProbes(action)), label).toEqual(
          offeredTo(ACTION_USERS, seen),
        );
      const MANAGE = [
        "may_assign_owner",
        "may_change_due_date",
        "may_set_owner_kind",
        "may_set_shared_owner_kind",
      ];
      // The managers who see the case manage it; its owner acts on it; other implementation owners see nothing.
      await step("OPEN", {
        caseManager: MANAGE,
        grcDirector: MANAGE,
        financeEmployee: ["may_record_progress", "may_submit_completion"],
      });
      const card = (await read(s, ACTION, "financeEmployee", action))!;
      expect(card.origin).toBeNull();
      expect(card.case).toEqual({ case_id: null, case_number: null });
      expect(await s.tx`select id from case_mgmt.case_record where id = ${caseB}`).toEqual([]);
      const team = (await read(s, ACTION, "caseManager", action))!;
      expect(team.origin).toEqual({
        // Migration 2070 (ADR-043): where the action comes from.
        source: "AUTHORITY_DECISION",
        preliminary_proposal_id: null,
        recommendation_item_id: item,
        authority_decision_id: decision,
        governing_decision_id: decision,
        decision_block: null,
        dispositions: [],
        disposition_options: [],
        // Migration 2096 (ADR-058): the replacement decision, only while the action is frozen.
        replacement: null,
      });
      await s.as("financeEmployee");
      await s.tx`select api.record_corrective_action_progress(${action}, 50, 'Synthetic: progress note.')`;
      await s.tx`select api.submit_corrective_action_completion(${action}, 'Synthetic: done.', 'SOP-DEMO-2040')`;
      // Someone other than the owner verifies.
      await step("PENDING_VERIFICATION", {
        caseManager: ["may_change_due_date", "may_verify"],
        grcDirector: ["may_change_due_date", "may_verify"],
        financeEmployee: [],
      });
      await s.as("caseManager");
      await s.tx`select api.verify_corrective_action(${action}, 'VERIFIED', null)`;
      await step("COMPLETED", {
        caseManager: ["may_reopen"],
        grcDirector: ["may_reopen"],
        financeEmployee: [],
      });
    });
  });

  it("R3: a pool shows its code and name only, and its members act for the action as the command allows", async () => {
    await scenario(async (s) => {
      const { action } = await openAction(s);
      await s.as("grcDirector");
      const [pool] = await s.tx<{ id: string }[]>`
        select api.create_corrective_action_pool('POOL_DEMO_2040', 'Synthetic pool', ${REASON}) as id`;
      await s.tx`select api.set_corrective_action_pool_member(${pool!.id}, ${USERS.employee}, true, ${REASON})`;
      await s.as("caseManager");
      await s.tx`select api.set_corrective_action_owner_kind(${action}, 'SHARED_POOL', null, ${pool!.id}::uuid, null, ${REASON})`;
      const v = (await read(s, ACTION, "employee", action))!;
      expect((v.owner as { pool: unknown }).pool).toEqual({ code: "POOL_DEMO_2040", name: "Synthetic pool" });
      expect(Object.keys(v.owner as object).sort()).toEqual([
        "accountable_user_id",
        "external_party_label",
        "kind",
        "pool",
        "sector",
      ]);
      // The pool member acts for the action (decision.acts_for_action), as does the accountable user; a non-member
      // implementation owner still sees nothing.
      const MANAGE = [
        "may_assign_owner",
        "may_change_due_date",
        "may_set_owner_kind",
        "may_set_shared_owner_kind",
      ];
      expect(await matrix(s, ACTION, action, caseB, ACTION_USERS, actionProbes(action, "employeeB"))).toEqual(
        offeredTo(ACTION_USERS, {
          caseManager: MANAGE,
          grcDirector: MANAGE,
          financeEmployee: ["may_record_progress", "may_submit_completion"],
          employee: ["may_record_progress", "may_submit_completion"],
        }),
      );
    });
  });

  it("R2: on a restricted case a unit or pool owner is never offered, and the command refuses it", async () => {
    await ownerScenario(async (s) => {
      const { action } = await openAction(s);
      // The case becomes restricted, owned and staffed by its Restricted Case Authority (owner fixture, as
      // corrective-actions.spec R2).
      await s.asOwner();
      await s.tx`update case_mgmt.case_record set is_restricted = true, owner_id = ${USERS.grcDirector} where id = ${caseB}`;
      await s.tx`insert into case_mgmt.case_assignment (case_id, user_id, assignment_role, reason, assigned_by)
                 values (${caseB}, ${USERS.grcDirector}, 'CASE_OWNER', ${REASON}, ${USERS.grcDirector})`;
      const v = (await read(s, ACTION, "grcDirector", action))!;
      expect(v.capabilities).toMatchObject({ may_set_owner_kind: true, may_set_shared_owner_kind: false });
      await s.expectError(
        "CDF_CONFLICT:RESTRICTED_CASE_OWNER_KIND",
        (tx) =>
          tx`select api.set_corrective_action_owner_kind(${action}, 'ORG_UNIT', ${FIN}::uuid, null, null, ${REASON})`,
      );
      // The authority names users and external parties only; the accountable user still acts; the case manager, no
      // longer on the restricted case's team, sees nothing.
      const users: UserKey[] = ["grcDirector", "caseManager", "financeEmployee"];
      expect(await matrix(s, ACTION, action, caseB, users, actionProbes(action))).toEqual(
        offeredTo(users, {
          grcDirector: ["may_assign_owner", "may_change_due_date", "may_set_owner_kind"],
          financeEmployee: ["may_record_progress", "may_submit_completion"],
        }),
      );
    });
  });
});

// ---- Continuity import ---------------------------------------------------------------------------------------------

const BATCH: Model = {
  fn: "bcp_import_batch_view",
  view: (tx, id) => tx<{ v: View }[]>`select api.bcp_import_batch_view(${id}) as v`,
  sees: async (tx, id) => (await tx`select id from exchange.bcp_import_batch where id = ${id}`).length === 1,
  keys: [
    "applied_at",
    "batch_id",
    "cancelled_at",
    "capabilities",
    "case",
    // Migration 2110 (ADR-047): the proceeding of a committee workbook; null for a case workbook.
    "committee_proceeding_id",
    "counts",
    "created_at",
    "current_hash",
    "decided_at",
    "decided_by",
    "decision_reason",
    "file_sha256",
    "imported_by",
    "offline_from",
    "offline_to",
    // Migration 2110 (ADR-047): a committee workbook waits for its official record (owner decision on AMB-201).
    "official_record_required",
    "preview_clean",
    "preview_hash",
    "previewed_at",
    "prepared_by",
    "row_version",
    "rows",
    // Migration 2110 (ADR-047): CASE or COMMITTEE_PROCEEDING.
    "scope",
    "status",
    "submitted_at",
    "submitted_hash",
    "template_version",
    "updated_at",
    "workbook_id",
    // Migration 2100 (AMB-205): whether the workbook was revoked as lost; may_approve follows it.
    "workbook_revoked",
  ],
  caps: [
    "may_apply",
    "may_approve",
    "may_cancel",
    "may_decide",
    "may_preview",
    "may_resolve_rows",
    "may_submit",
  ],
  // Never the cells or the workbook's control block.
  never: ["cells", "control", "payload_hash", "DISPLAY_LABEL"],
};

const BATCH_USERS: UserKey[] = [
  "caseManager",
  "grcDirector",
  "grcDeputy",
  "lead",
  "investigatorB",
  "investigatorA",
  "platformAdmin",
];

const batchProbes =
  (b: string, row: string) =>
  (v: View | null): Probes => ({
    may_resolve_rows: [(tx) => tx`select api.resolve_bcp_row(${row}, 'SKIP', ${REASON})`],
    may_preview: [(tx) => tx`select api.preview_bcp_import(${b})`],
    may_submit: [
      (tx) => tx`select api.submit_bcp_import(${b}, ${(v?.preview_hash as string | null) ?? SHA})`,
    ],
    may_decide: [
      (tx) =>
        tx`select api.decide_bcp_import(${b}, 'APPROVE', ${REASON}, ${(v?.submitted_hash as string | null) ?? SHA})`,
      (tx) =>
        tx`select api.decide_bcp_import(${b}, 'REJECT', ${REASON}, ${(v?.submitted_hash as string | null) ?? SHA})`,
    ],
    may_approve: [
      (tx) =>
        tx`select api.decide_bcp_import(${b}, 'APPROVE', ${REASON}, ${(v?.submitted_hash as string | null) ?? SHA})`,
    ],
    may_apply: [
      (tx) => tx`select api.apply_bcp_import(${b}, ${(v?.submitted_hash as string | null) ?? SHA})`,
    ],
    may_cancel: [(tx) => tx`select api.cancel_bcp_import(${b}, ${REASON})`],
  });

/** A staged batch on case 0002 by the case manager (the continuity operator), prepared and recorded offline by
 *  investigator B (as api-idor.spec). */
async function stageBatch(s: Scenario): Promise<{ batch: string; row: string }> {
  await s.as("caseManager");
  const [b] = await s.tx<{ id: string }[]>`
    with c as (
      select id, case_number, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
      from case_mgmt.case_record where id = ${caseB}
    )
    select api.stage_bcp_import(
      jsonb_build_object('TEMPLATE_VERSION', 'BCP-1', 'WORKBOOK_ID', 'BCP-DEMO-2040', 'CASE_ID', c.id::text,
                         'CASE_NUMBER', c.case_number, 'OFFLINE_FROM', c.at, 'PREPARED_BY', 'investigator.b@example.test'),
      ${SHA},
      jsonb_build_array(jsonb_build_object('sheet', '05_SUBJECTS', 'row_number', 3, 'has_formula', false, 'cells',
        jsonb_build_object('ROW_ID', 'BCP-RM1', 'ORIGINAL_EVENT_AT', c.at, 'RECORDED_OFFLINE_BY', 'investigator.b@example.test',
                           'DISPLAY_LABEL', 'Employee unique-cell-marker-2040 (synthetic)', 'SUBJECT_CATEGORY', 'EMPLOYEE')))) as id
    from c`;
  const [row] = await s.tx<
    { id: string }[]
  >`select id from exchange.bcp_import_row where batch_id = ${b!.id}`;
  return { batch: b!.id, row: row!.id };
}

describe("api.bcp_import_batch_view (authz.can_view_bcp_import)", () => {
  it("outsiders, unknown ids and revoked users get NOT_FOUND; anonymous callers cannot call it", async () => {
    await scenario(async (s) => {
      const { batch } = await stageBatch(s);
      for (const user of ["investigatorA", "committee", "platformAdmin", "revoked"] as const) {
        await s.as(user);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.bcp_import_batch_view(${batch})`);
      }
      await s.as("caseManager");
      for (const unknown of [randomUUID(), null])
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.bcp_import_batch_view(${unknown}::uuid)`);
      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select api.bcp_import_batch_view(${batch})`);
    });
  });

  it("the operator and the approver: row metadata, never the cells; each capability matches its command", async () => {
    await scenario(async (s) => {
      const { batch, row } = await stageBatch(s);
      const step = async (label: string, seen: Partial<Record<UserKey, string[]>>) =>
        expect(await matrix(s, BATCH, batch, caseB, BATCH_USERS, batchProbes(batch, row)), label).toEqual(
          offeredTo(BATCH_USERS, seen),
        );
      // Staged: the importing operator alone; the approvers see it once submitted; the offline recorder and another
      // BCP_IMPORT holder who is not the operator see nothing.
      await step("STAGED", { caseManager: ["may_cancel", "may_preview", "may_resolve_rows"] });
      const v = (await read(s, BATCH, "caseManager", batch))!;
      expect(JSON.stringify(v)).not.toContain("unique-cell-marker");
      expect(v.counts).toEqual({ rows: 1, unresolved: 0, by_state: { NEW: 1 } });
      expect(v.rows).toEqual([
        expect.objectContaining({
          row_id: row,
          sheet_code: "05_SUBJECTS",
          state: "NEW",
          resolution: "IMPORT",
          may_resolve: true,
        }),
      ]);
      await s.as("caseManager");
      const [p] = await s.tx<{ h: string }[]>`select api.preview_bcp_import(${batch}) ->> 'hash' as h`;
      await step("STAGED previewed", {
        caseManager: ["may_cancel", "may_preview", "may_resolve_rows", "may_submit"],
      });
      await s.as("caseManager");
      await s.tx`select api.submit_bcp_import(${batch}, ${p!.h})`;
      // Submitted: an approver who neither imported, prepared nor recorded it decides.
      await step("SUBMITTED", {
        caseManager: ["may_cancel", "may_preview"],
        grcDirector: ["may_approve", "may_decide"],
        grcDeputy: ["may_approve", "may_decide"],
      });
      await s.as("grcDirector");
      await s.tx`select api.decide_bcp_import(${batch}, 'APPROVE', ${REASON}, ${p!.h})`;
      await step("APPROVED", {
        caseManager: ["may_apply", "may_cancel", "may_preview"],
        grcDirector: [],
        grcDeputy: [],
      });
      await s.as("caseManager");
      await s.tx`select api.apply_bcp_import(${batch}, ${p!.h})`;
      await step("IMPORTED", { caseManager: ["may_preview"], grcDirector: [], grcDeputy: [] });
    });
  });
});

// ---- Notices -------------------------------------------------------------------------------------------------------

describe("referral and preliminary-review notices: ids only, to exactly who must act (ADR-025, Phase 12 ask (c))", () => {
  const referralNotices = (s: OwnerScenario, template: string, id: string, prefix: string) =>
    told(s, template, id, "REFERRAL", "/referrals/", prefix, referralOpens);

  it("T-AMB-105: a referral step tells the next actor: the sector's approvers, the preparer, the secretaries, the escalation target", async () => {
    await ownerScenario(async (s) => {
      await constitute(s);
      // An active delegate approves for the head too (Q4).
      await s.as("sectorHead");
      await s.tx`select api.delegate_referral_approval(${OPS}, ${USERS.employeeB}, now(), now() + interval '10 days',
        'DEMO-DEL-2040', ${REASON})`;
      const id = await draftReferral(s);
      await s.tx`select api.submit_referral(${id}, null)`;
      // The head and the active delegate; never the preparer or another member.
      expect(await referralNotices(s, "REFERRAL_SUBMITTED_TO_HEAD", id, "referral-head")).toEqual([
        "employeeB",
        "sectorHead",
      ]);
      await s.as("sectorHead");
      await s.tx`select api.sector_decide_referral(${id}, 'RETURN', array['MISSING_DOCUMENTS'], null)`;
      expect(await referralNotices(s, "REFERRAL_RETURNED", id, "referral-returned")).toEqual(["employee"]);
      await s.as("employee");
      await s.tx`select api.submit_referral(${id}, null)`;
      await sectorApproves(s, id);
      // The secretary; never the chair or a member.
      expect(await referralNotices(s, "REFERRAL_SUBMITTED_TO_SECRETARY", id, "referral-secretary")).toEqual([
        "committeeSecretary",
      ]);
      await secretaryRejects(s, id);
      await s.as("employee");
      await s.tx`select api.resubmit_referral(${id}, null)`;
      await sectorApproves(s, id);
      await secretaryRejects(s, id);
      await s.as("sectorHead");
      await s.tx`select api.escalate_referral_rejection(${id}, ${ESC})`;
      // The holder of the target seat only (DEC-F09).
      expect(await referralNotices(s, "REFERRAL_ESCALATED", id, "referral-escalated")).toEqual([
        "committeeChair",
      ]);
      // One notice per step: three submissions to the sector, two approvals to the secretary.
      expect(await referralNotices(s, "REFERRAL_SUBMITTED_TO_HEAD", id, "referral-head")).toEqual([
        "employeeB",
        "employeeB",
        "employeeB",
        "sectorHead",
        "sectorHead",
        "sectorHead",
      ]);
      expect(await referralNotices(s, "REFERRAL_SUBMITTED_TO_SECRETARY", id, "referral-secretary")).toEqual([
        "committeeSecretary",
        "committeeSecretary",
      ]);
    });
  });

  const preliminaryOpens = async (tx: Tx, id: string) =>
    (await tx`select id from case_mgmt.preliminary_recommendation where id = ${id}`).length === 1;
  const preliminaryNotices = (s: OwnerScenario, template: string, id: string, prefix: string) =>
    told(s, template, id, "PRELIMINARY_REVIEW", "/preliminary-reviews/", prefix, preliminaryOpens);

  it("T-AMB-147: a preliminary recommendation tells its reviewers, then its approver, and its preparer when returned; never the preparer otherwise", async () => {
    await ownerScenario(async (s) => {
      await s.as("investigatorA");
      const [r] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseA}, 'OUT_OF_SCOPE', 'Synthetic: outside the mandate.') as id`;
      // The PRELIMINARY_REVIEW holders who see the case; never the preparer.
      expect(
        await preliminaryNotices(s, "PRELIMINARY_REVIEW_REQUESTED", r!.id, "preliminary-review"),
      ).toEqual(["grcDeputy", "grcDirector"]);
      await s.as("grcDirector");
      await s.tx`select api.review_preliminary_recommendation(${r!.id}, 'RETURN', array['RECOMMENDATION_INCOMPLETE'], null)`;
      expect(await preliminaryNotices(s, "PRELIMINARY_RETURNED", r!.id, "preliminary-returned")).toEqual([
        "investigatorA",
      ]);
      await s.as("investigatorA");
      const [r2] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseA}, 'INVESTIGATION_WARRANTED', 'Synthetic: revised.') as id`;
      await s.as("grcDirector");
      await s.tx`select api.review_preliminary_recommendation(${r2!.id}, 'ENDORSE', null, null)`;
      // The approver (GRC Sector Head); never the preparer or the reviewer.
      expect(
        await preliminaryNotices(s, "PRELIMINARY_APPROVAL_REQUESTED", r2!.id, "preliminary-approval"),
      ).toEqual(["grcSectorHead"]);
      await s.as("grcSectorHead");
      await s.tx`select api.approve_preliminary_recommendation(${r2!.id}, 'RETURN', array['INSUFFICIENT_EVIDENCE'], null)`;
      expect(await preliminaryNotices(s, "PRELIMINARY_RETURNED", r2!.id, "preliminary-returned")).toEqual([
        "investigatorA",
      ]);
    });
  });

  it("T-AMB-106: a restricted case's recommendation tells no approver who cannot see it (fail closed)", async () => {
    await ownerScenario(async (s) => {
      await s.as("grcDirector");
      const [r] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseExec}, 'NO_ACTION', 'Synthetic: restricted case review.') as id`;
      // The GRC Sector Head sees nothing on a restricted case without a grant (1880): nobody is told.
      expect(
        await preliminaryNotices(s, "PRELIMINARY_APPROVAL_REQUESTED", r!.id, "preliminary-approval"),
      ).toEqual([]);
    });
  });
});

// ---- Grants --------------------------------------------------------------------------------------------------------

describe("item 13 grants: the reads are definer functions; the user-id rules and helpers are internal (R1)", () => {
  it("every read is SECURITY DEFINER with an empty search path, executable by authenticated only", async () => {
    const rows = await admin<
      { name: string; definer: boolean; config: string[] | null; auth: boolean; anon: boolean }[]
    >`
      select p.proname as name, p.prosecdef as definer, p.proconfig as config,
             has_function_privilege('authenticated', p.oid, 'execute') as auth,
             has_function_privilege('anon', p.oid, 'execute') as anon
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and p.proname = any(${[...VIEW_FNS, "referral_queue", "grievance_queue"]})
      order by p.proname`;
    expect(rows.map((r) => r.name)).toEqual([...VIEW_FNS, "referral_queue", "grievance_queue"].sort());
    for (const r of rows)
      expect(r, r.name).toMatchObject({ definer: true, config: ['search_path=""'], auth: true, anon: false });
  });

  it("no application role may call the user-id rules, the capability helpers or the notice triggers", async () => {
    const rows = await admin<{ fn: string; auth: boolean; anon: boolean; pub: boolean }[]>`
      select p.oid::regprocedure::text as fn,
             has_function_privilege('authenticated', p.oid, 'execute') as auth,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('public', p.oid, 'execute') as pub
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname, p.proname) in (('intake', 'user_can_view_referral'),
                                       ('case_mgmt', 'user_can_view_preliminary_recommendation'),
                                       ('grievance', 'is_pending_decider'),
                                       ('intake', 'caller_referral_capabilities'),
                                       ('grievance', 'caller_capabilities'),
                                       ('notify', 'on_grievance_awaiting_decision'),
                                       ('notify', 'on_referral_event'),
                                       ('notify', 'on_preliminary_recommendation'))
      order by 1`;
    expect(rows).toHaveLength(8);
    for (const r of rows) expect(r, r.fn).toMatchObject({ auth: false, anon: false, pub: false });
    const [decider] = await admin<{ auth: boolean; anon: boolean }[]>`
      select has_function_privilege('authenticated', 'authz.is_grievance_decider(uuid)', 'execute') as auth,
             has_function_privilege('anon', 'authz.is_grievance_decider(uuid)', 'execute') as anon`;
    expect(decider).toEqual({ auth: true, anon: false });
  });
});
