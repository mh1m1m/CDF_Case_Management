// Business architecture rebase, migration 1940 (ADR-033; owner Q&A Q69, Q72; EPIC 12 corrective actions, CDF-203):
// corrective-action tracking. An action is opened only from an item the competent authority approved or modified;
// its owner sees the action and nothing of the case; someone else verifies completion; a waiver needs the authority's
// source document; a case does not close while an approved item has an outstanding or missing action; the policy is
// configurable and seeded empty (SOURCE_REQUIRED). Every step runs through the api.* commands as `authenticated`; the
// owner connection is used only for fixtures (clearance, a test-only permission, a past due date) and to read the
// outbox.
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, type OwnerScenario, type Scenario, type UserKey } from "../support/db";
import { REASON, committeeIds, preliminaryReferral, seat } from "../support/committee";
import { authorityRuleFor, draftPackage, voteOnPackage, type PackageFixture } from "../support/decision";

const TITLE = "Synthetic: strengthen approval controls";
const DESCRIPTION = "Synthetic: add a second approver to payments above the threshold.";
const NOTE = "Synthetic: progress note.";
const EVIDENCE = "SOP-DEMO-0001 rev 2";

let caseB: string, caseExec: string, ic: string;
beforeAll(async () => {
  [caseB, caseExec] = await Promise.all([caseId("0002"), caseId("0003")]);
  ({ ic } = await committeeIds());
});

/** The platform administrator gives each user the Implementation Owner role (audited, rolled back with the test). */
async function implementationOwners(s: Scenario, ...users: UserKey[]): Promise<Record<string, string>> {
  await s.as("platformAdmin");
  const assignments: Record<string, string> = {};
  for (const u of users) {
    const [r] = await s.tx<{ id: string }[]>`
      select api.grant_role(${USERS[u]}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner for the test') as id`;
    assignments[u] = r!.id;
  }
  return assignments;
}

interface Decided extends PackageFixture {
  remediation: string;
  decision: string;
}

/** A package on case 0002 with a corrective action and a governance remediation (the sanction withdrawn, so no legal
 *  review is needed), adopted and sent to the authority. `decide` false stops before the authority decides. */
async function decidedPackage(
  s: Scenario,
  outcome: "APPROVE_AS_RECOMMENDED" | "APPROVE_PARTIALLY" | null = "APPROVE_PARTIALLY",
): Promise<Decided> {
  const f = await draftPackage(s, ic, caseB);
  // DEC-F13 (migration 2030): the remediation needs an authority rule to be submitted.
  await authorityRuleFor(s, "GOVERNANCE_REMEDIATION");
  await s.as("committeeSecretary");
  const [rem] = await s.tx<{ id: string }[]>`
    select api.add_recommendation_item(${f.pkg}, 'GOVERNANCE_REMEDIATION', null, null,
      'Synthetic: revise the procurement procedure.', null, null) as id`;
  await s.tx`select api.withdraw_recommendation_item(${f.sanction}, ${REASON})`;
  await voteOnPackage(s, f);
  await s.as("committeeSecretary");
  await s.tx`select api.submit_to_authority(${f.pkg})`;
  if (outcome === null) return { ...f, remediation: rem!.id, decision: "" };
  const items =
    outcome === "APPROVE_PARTIALLY"
      ? [
          { item_id: f.corrective, outcome: "MODIFIED", modification: "Synthetic: within the quarter." },
          { item_id: rem!.id, outcome: "REJECTED" },
        ]
      : null;
  const [d] = await s.tx<{ id: string }[]>`
    select api.record_authority_decision(${f.pkg}, 'CEO', ${outcome}, now(),
      'Chief Executive (synthetic)', 'MEMO-DEMO-0101', ${items === null ? null : s.tx.json(items as never)}::jsonb, ${REASON}) as id`;
  return { ...f, remediation: rem!.id, decision: d!.id };
}

/** Round 1 goes to the authority and comes back; the remediation is withdrawn in the revision; round 2 is adopted and
 *  decided with `outcome`. */
async function secondRound(s: Scenario, outcome: "APPROVE_AS_RECOMMENDED" | "REJECT"): Promise<Decided> {
  const f = await decidedPackage(s, null);
  await s.as("committeeSecretary");
  await s.tx`select api.record_authority_decision(${f.pkg}, 'CEO', 'RETURN_TO_COMMITTEE', now(),
    'Chief Executive (synthetic)', 'MEMO-DEMO-0106', null, ${REASON})`;
  await s.tx`select api.withdraw_recommendation_item(${f.remediation}, ${REASON})`;
  expect(await voteOnPackage(s, f)).toBe("ADOPTED");
  await s.as("committeeSecretary");
  await s.tx`select api.submit_to_authority(${f.pkg})`;
  const [d] = await s.tx<{ id: string }[]>`
    select api.record_authority_decision(${f.pkg}, 'CEO', ${outcome}, now(),
      'Chief Executive (synthetic)', 'MEMO-DEMO-0107', null, ${REASON}) as id`;
  return { ...f, decision: d!.id };
}

async function open(
  s: Scenario,
  actor: UserKey,
  item: string,
  owner: UserKey | null,
  dueInDays: number | null = 30,
): Promise<string> {
  await s.as(actor);
  const [r] = await s.tx<{ id: string }[]>`
    select api.open_corrective_action(${item}, ${TITLE}, ${DESCRIPTION}, ${owner === null ? null : USERS[owner]},
      case when ${dueInDays}::int is null then null else (now() at time zone 'Asia/Riyadh')::date + ${dueInDays}::int end) as id`;
  return r!.id;
}

interface ActionRow {
  status: string;
  owner_id: string;
  percent_complete: number;
  sequence_no: number;
  authority_decision_id: string;
  verified_by: string | null;
  due_date: string;
}

async function action(s: OwnerScenario, id: string): Promise<ActionRow> {
  await s.asOwner();
  const [r] = await s.tx<ActionRow[]>`
    select status, owner_id, percent_complete, sequence_no, authority_decision_id, verified_by, due_date::text
    from decision.corrective_action where id = ${id}`;
  return r!;
}

const BY_ID = Object.fromEntries(Object.entries(USERS).map(([k, v]) => [v, k])) as Record<string, UserKey>;

async function notified(s: OwnerScenario, template: string, object: string): Promise<UserKey[]> {
  await s.asOwner();
  const rows = await s.tx<{ recipient_id: string }[]>`
    select distinct recipient_id from notify.outbox where template_code = ${template} and object_id = ${object}`;
  return rows.map((r) => BY_ID[r.recipient_id]!).sort();
}

/** In-app notices of a template on an object: one per event. */
async function inApp(s: OwnerScenario, template: string, object: string): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`
    select count(*)::int as n from notify.outbox
    where template_code = ${template} and object_id = ${object} and channel = 'IN_APP'`;
  return r!.n;
}

/** Every corrective-action notification (enqueued after `since`, when given) goes to someone who can open the action
 *  (N18, AGENT-09 review of 1920). */
async function recipientsSeeActions(s: OwnerScenario, since: string | null = null) {
  await s.asOwner();
  const rows = await s.tx<{ recipient_id: string; template_code: string; object_id: string }[]>`
    select recipient_id, template_code, object_id from notify.outbox
    where object_type = 'CORRECTIVE_ACTION' and (${since}::text is null or created_at > ${since}::text::timestamptz)`;
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    await s.as(BY_ID[r.recipient_id]!);
    const seen = await s.tx`select id from decision.corrective_action where id = ${r.object_id}`;
    expect(seen, `${BY_ID[r.recipient_id]} ${r.template_code}`).toHaveLength(1);
  }
  await s.asOwner();
}

/** The outbox's clock (rows carry clock_timestamp()), to check only what is enqueued from here on. */
async function mark(s: OwnerScenario): Promise<string> {
  await s.asOwner();
  const [r] = await s.tx<{ t: string }[]>`select clock_timestamp()::text as t`;
  return r!.t;
}

/** A declared conflict on case 0002: the user fails the case gate from now on. */
async function conflicted(s: OwnerScenario, user: UserKey) {
  await s.asOwner();
  await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
             values (${caseB}, ${USERS[user]}, 'CONFLICT_DECLARED', 'Synthetic declared conflict')`;
}

async function audited(s: OwnerScenario, objectId: string): Promise<string[]> {
  await s.asOwner();
  const rows = await s.tx<{ action: string }[]>`
    select action from audit.audit_event where object_type = 'corrective_action' and object_id = ${objectId}
    order by seq`;
  return rows.map((r) => r.action);
}

/** The scheduler's reminder run. The BFF login role runs it in production (notifications.spec.ts covers who may);
 *  here the function's owner calls it, since the owner cannot assume cdf_bff on a Supabase stack. */
async function emitReminders(s: OwnerScenario): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`select notify.emit_due_reminders() as n`;
  return r!.n;
}

const progress = (s: Scenario, id: string, percent: number, note: string | null = NOTE) =>
  s.tx`select api.record_corrective_action_progress(${id}, ${percent}, ${note})`;
const submit = (s: Scenario, id: string, reference: string | null = EVIDENCE) =>
  s.tx`select api.submit_corrective_action_completion(${id}, 'Synthetic: the control is in place.', ${reference})`;
const verify = async (s: Scenario, id: string, decision: string, note: string | null = null) => {
  const [r] = await s.tx<{ status: string }[]>`
    select api.verify_corrective_action(${id}, ${decision}, ${note}) as status`;
  return r!.status;
};

describe("opening corrective actions (ADR-033, Q72)", () => {
  it("opens actions only from items the authority approved or modified, with an eligible owner and a due date", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "financeEmployee");
      const f = await decidedPackage(s, null);
      // Adopted by the committee but not yet decided by the authority.
      await s.expectError("CDF_CONFLICT:ITEM_NOT_APPROVED", () =>
        open(s, "caseManager", f.corrective, "financeEmployee"),
      );
      await s.as("committeeSecretary");
      const [d] = await s.tx<{ id: string }[]>`
        select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_PARTIALLY', now(),
          'Chief Executive (synthetic)', 'MEMO-DEMO-0101', ${s.tx.json([
            { item_id: f.corrective, outcome: "MODIFIED", modification: "Synthetic: within the quarter." },
            { item_id: f.remediation, outcome: "REJECTED" },
          ] as never)}::jsonb, ${REASON}) as id`;
      // The rejected item and the withdrawn sanction have nothing to execute.
      for (const item of [f.remediation, f.sanction]) {
        await s.expectError("CDF_CONFLICT:ITEM_NOT_APPROVED", () =>
          open(s, "caseManager", item, "financeEmployee"),
        );
      }
      // The case team without CORRECTIVE_ACTION_MANAGE, and people who cannot see the case.
      await s.expectError("CDF_FORBIDDEN", () => open(s, "investigatorB", f.corrective, "financeEmployee"));
      for (const u of ["committee", "financeEmployee", "platformAdmin", "committeeSecretary"] as const) {
        await s.expectError("CDF_NOT_FOUND", () => open(s, u, f.corrective, "financeEmployee"));
      }
      // The owner holds CORRECTIVE_ACTION_OWN and passes the case gate.
      await s.expectError("CDF_INVALID:owner_id", () => open(s, "caseManager", f.corrective, "employeeB"));
      await s.expectError("CDF_INVALID:owner_id", () => open(s, "caseManager", f.corrective, null));
      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseB}, ${USERS.employeeB}, 'CONFLICT_DECLARED', 'Synthetic declared conflict')`;
      await implementationOwners(s, "employeeB");
      await s.expectError("CDF_INVALID:owner_id", () => open(s, "caseManager", f.corrective, "employeeB"));
      // A due date is given (no default period is seeded) and is not in the past; the wording is required.
      await s.expectError("CDF_INVALID:due_date", () =>
        open(s, "caseManager", f.corrective, "financeEmployee", null),
      );
      await s.expectError("CDF_INVALID:due_date", () =>
        open(s, "caseManager", f.corrective, "financeEmployee", -1),
      );
      await s.as("caseManager");
      await s.expectError(
        "CDF_INVALID:title",
        (tx) =>
          tx`select api.open_corrective_action(${f.corrective}, 'x', ${DESCRIPTION}, ${USERS.financeEmployee}, (now() at time zone 'Asia/Riyadh')::date + 5)`,
      );

      const first = await open(s, "caseManager", f.corrective, "financeEmployee", 0);
      const second = await open(s, "grcDirector", f.corrective, "financeEmployee");
      expect(await action(s, first)).toMatchObject({
        status: "OPEN",
        sequence_no: 1,
        percent_complete: 0,
        owner_id: USERS.financeEmployee,
        authority_decision_id: d!.id,
      });
      expect((await action(s, second)).sequence_no).toBe(2);
      expect(await notified(s, "CORRECTIVE_ACTION_ASSIGNED", first)).toEqual(["financeEmployee"]);
      expect(await audited(s, first)).toEqual(["CORRECTIVE_ACTION_OPENED"]);
      const [event] = await s.tx<{ event_type: string; owner_id: string; actor_id: string }[]>`
        select event_type, owner_id, actor_id from decision.corrective_action_event where action_id = ${first}`;
      expect(event).toEqual({
        event_type: "OPENED",
        owner_id: USERS.financeEmployee,
        actor_id: USERS.caseManager,
      });
    });
  });

  it("approving the whole package executes only actionable items the committee adopted", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "financeEmployee");
      // Item-level votes: the committee rejects the remediation; an OTHER item is adopted but is not actionable.
      const f = await draftPackage(s, ic, caseB, "ITEM");
      // DEC-F13 (migration 2030): the adopted OTHER item needs an authority rule to be submitted.
      await authorityRuleFor(s, "OTHER");
      await s.as("committeeSecretary");
      const [rem] = await s.tx<{ id: string }[]>`
        select api.add_recommendation_item(${f.pkg}, 'GOVERNANCE_REMEDIATION', null, null,
          'Synthetic: revise the procurement procedure.', null, null) as id`;
      const [other] = await s.tx<{ id: string }[]>`
        select api.add_recommendation_item(${f.pkg}, 'OTHER', null, null, 'Synthetic: brief the board.', null, null) as id`;
      await s.tx`select api.withdraw_recommendation_item(${f.sanction}, ${REASON})`;
      await voteOnPackage(s, f, (target) => (target === rem!.id ? "REJECT" : "APPROVE"));
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await s.tx`select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED',
        now(), 'Chief Executive (synthetic)', 'MEMO-DEMO-0104', null, ${REASON})`;
      for (const item of [rem!.id, other!.id]) {
        await s.expectError("CDF_CONFLICT:ITEM_NOT_APPROVED", () =>
          open(s, "caseManager", item, "financeEmployee"),
        );
      }
      await open(s, "caseManager", f.corrective, "financeEmployee");
      await s.asOwner();
      const rows = await s.tx<{ action_type: string }[]>`select action_type from decision.corrective_action`;
      expect(rows).toEqual([{ action_type: "CORRECTIVE_ACTION" }]);
    });
  });
});

describe("opening: rounds and withdrawn items (AGENT-09 early look on 1940)", () => {
  it("a withdrawn item is never executed, even with its earlier committee result", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "financeEmployee");
      const f = await secondRound(s, "APPROVE_AS_RECOMMENDED");
      // The remediation was adopted in round 1 and withdrawn before round 2: it keeps its round-1 committee result,
      // but is no longer part of what the authority approved.
      await s.asOwner();
      const [rem] = await s.tx<{ status: string; committee_result: string }[]>`
        select status, committee_result from decision.recommendation_item where id = ${f.remediation}`;
      expect(rem).toEqual({ status: "WITHDRAWN", committee_result: "APPROVED" });
      await s.expectError("CDF_CONFLICT:ITEM_NOT_APPROVED", () =>
        open(s, "caseManager", f.remediation, "financeEmployee"),
      );
      const id = await open(s, "caseManager", f.corrective, "financeEmployee");
      expect((await action(s, id)).authority_decision_id).toBe(f.decision);
    });
  });

  it("only the decision on the package's current round counts", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "financeEmployee");
      const f = await secondRound(s, "REJECT");
      await s.expectError("CDF_CONFLICT:ITEM_NOT_APPROVED", () =>
        open(s, "caseManager", f.corrective, "financeEmployee"),
      );
      // Test fixture only (no command records an approval in a round that is later reopened): an approving decision
      // on round 1 does not count once the package is on round 2.
      await s.asOwner();
      await s.tx`insert into decision.authority_decision (package_id, case_id, package_round, authority_type, outcome,
                   decided_at, decided_by_label, source_document_reference, recorded_by)
                 values (${f.pkg}, ${caseB}, 1, 'CEO', 'APPROVE_AS_RECOMMENDED', now() - interval '2 hours',
                         'Chief Executive (synthetic)', 'MEMO-DEMO-0108', ${USERS.committeeSecretary})`;
      await s.expectError("CDF_CONFLICT:ITEM_NOT_APPROVED", () =>
        open(s, "caseManager", f.corrective, "financeEmployee"),
      );
    });
  });
});

describe("the owner's view (CDF-73 option D: purpose-bound)", () => {
  it("the owner sees their own action and its history, never the case, and loses it with the role or the case gate", async () => {
    await ownerScenario(async (s) => {
      const roles = await implementationOwners(s, "financeEmployee", "employeeB");
      const f = await decidedPackage(s);
      const id = await open(s, "caseManager", f.corrective, "financeEmployee");
      const visible = async (u: UserKey) => {
        await s.as(u);
        return {
          action: (await s.tx`select id from decision.corrective_action`).length,
          events: (await s.tx`select id from decision.corrective_action_event`).length,
        };
      };
      expect(await visible("financeEmployee")).toEqual({ action: 1, events: 1 });
      // Nothing of the case, the package, the item or the decision.
      await s.as("financeEmployee");
      for (const table of [
        "case_mgmt.case_record",
        "decision.recommendation_package",
        "decision.recommendation_item",
        "decision.authority_decision",
      ]) {
        expect(await s.tx`select id from ${s.tx(table)}`, table).toEqual([]);
      }
      // Another implementation owner, an outsider and the oversight roles see nothing.
      for (const u of ["employeeB", "committee", "platformAdmin", "internalAudit", "dpo"] as const) {
        expect(await visible(u), u).toEqual({ action: 0, events: 0 });
      }
      // The case team sees it.
      for (const u of ["caseManager", "investigatorB", "grcDirector"] as const) {
        expect(await visible(u), u).toEqual({ action: 1, events: 1 });
      }
      // Losing the role removes the action.
      await s.as("platformAdmin");
      await s.tx`select api.revoke_role(${roles.financeEmployee!}, 'Synthetic: no longer an owner.')`;
      expect(await visible("financeEmployee")).toEqual({ action: 0, events: 0 });
      await s.expectError("CDF_NOT_FOUND", () => progress(s, id, 10));
      await implementationOwners(s, "financeEmployee");
      expect(await visible("financeEmployee")).toEqual({ action: 1, events: 1 });
      // Losing the clearance, or a conflict, removes it too.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'INTERNAL' where id = ${USERS.financeEmployee}`;
      expect(await visible("financeEmployee")).toEqual({ action: 0, events: 0 });
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'CONFIDENTIAL' where id = ${USERS.financeEmployee}`;
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseB}, ${USERS.financeEmployee}, 'CONFLICT_DECLARED', 'Synthetic declared conflict')`;
      expect(await visible("financeEmployee")).toEqual({ action: 0, events: 0 });
      await s.expectError("CDF_NOT_FOUND", () => progress(s, id, 10));
    });
  });
});

describe("reporting, verification and reopening", () => {
  it("the owner reports and submits; someone else verifies; a return and a reopen go back to the owner", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "financeEmployee");
      const f = await decidedPackage(s);
      const id = await open(s, "caseManager", f.corrective, "financeEmployee");
      // Only the owner reports.
      for (const u of ["caseManager", "grcDirector"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", () => progress(s, id, 10));
        await s.expectError("CDF_FORBIDDEN", () => submit(s, id));
      }
      await s.as("financeEmployee");
      await s.expectError("CDF_INVALID:percent_complete", () => progress(s, id, 101));
      await s.expectError("CDF_INVALID:note", () => progress(s, id, 10, " "));
      await progress(s, id, 40);
      expect(await action(s, id)).toMatchObject({ status: "IN_PROGRESS", percent_complete: 40 });
      // The seeded placeholder asks for an evidence reference (the strictest setting until the policy is sourced).
      await s.as("financeEmployee");
      await s.expectError("CDF_INVALID:evidence_reference", () => submit(s, id, null));
      await submit(s, id);
      expect(await action(s, id)).toMatchObject({ status: "PENDING_VERIFICATION", percent_complete: 100 });
      expect(await notified(s, "CORRECTIVE_ACTION_SUBMITTED", id)).toEqual([
        "caseManager",
        "grcDeputy",
        "grcDirector",
      ]);
      await s.as("financeEmployee");
      await s.expectError("CDF_CONFLICT:ACTION_NOT_ACTIVE", () => progress(s, id, 50));
      await s.expectError("CDF_FORBIDDEN", () => verify(s, id, "VERIFIED"));
      // The case team without CORRECTIVE_ACTION_MANAGE does not verify either.
      await s.as("investigatorB");
      await s.expectError("CDF_FORBIDDEN", () => verify(s, id, "VERIFIED"));
      // A return needs a note and goes back to the owner.
      await s.as("caseManager");
      await s.expectError("CDF_INVALID:decision", () => verify(s, id, "APPROVED"));
      await s.expectError("CDF_INVALID:note", () => verify(s, id, "RETURNED"));
      expect(await verify(s, id, "RETURNED", "Synthetic: attach the revised SOP.")).toBe("IN_PROGRESS");
      expect(await notified(s, "CORRECTIVE_ACTION_RETURNED", id)).toEqual(["financeEmployee"]);
      await s.as("financeEmployee");
      await submit(s, id);
      await s.as("grcDirector");
      expect(await verify(s, id, "VERIFIED")).toBe("COMPLETED");
      expect(await action(s, id)).toMatchObject({ status: "COMPLETED", verified_by: USERS.grcDirector });
      await s.as("grcDirector");
      await s.expectError("CDF_CONFLICT:NOT_PENDING_VERIFICATION", () => verify(s, id, "VERIFIED"));
      // A completed action whose effect was not achieved is reopened (re-execution).
      await s.as("financeEmployee");
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.reopen_corrective_action(${id}, ${REASON})`);
      await s.as("caseManager");
      await s.tx`select api.reopen_corrective_action(${id}, ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:NOT_COMPLETED",
        (tx) => tx`select api.reopen_corrective_action(${id}, ${REASON})`,
      );
      expect(await action(s, id)).toMatchObject({ status: "IN_PROGRESS", verified_by: null });
      expect(await notified(s, "CORRECTIVE_ACTION_RETURNED", id)).toEqual(["financeEmployee"]);
      expect(await inApp(s, "CORRECTIVE_ACTION_RETURNED", id)).toBe(2); // the return and the reopening
      expect(await audited(s, id)).toEqual([
        "CORRECTIVE_ACTION_OPENED",
        "CORRECTIVE_ACTION_PROGRESS_RECORDED",
        "CORRECTIVE_ACTION_COMPLETION_SUBMITTED",
        "CORRECTIVE_ACTION_RETURNED",
        "CORRECTIVE_ACTION_COMPLETION_SUBMITTED",
        "CORRECTIVE_ACTION_VERIFIED",
        "CORRECTIVE_ACTION_REOPENED",
      ]);
      await recipientsSeeActions(s);
    });
  });

  it("whoever owned or submitted an action never verifies it, even as a manager", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "caseManager", "financeEmployee");
      const f = await decidedPackage(s);
      // The case manager is named owner and submits; only another manager verifies.
      const id = await open(s, "grcDirector", f.corrective, "caseManager");
      await s.as("caseManager");
      await submit(s, id);
      expect(await notified(s, "CORRECTIVE_ACTION_SUBMITTED", id)).toEqual(["grcDeputy", "grcDirector"]);
      await s.as("caseManager");
      await s.expectError("CDF_FORBIDDEN", () => verify(s, id, "VERIFIED"));
      await s.as("grcDirector");
      expect(await verify(s, id, "RETURNED", "Synthetic: hand it to Finance.")).toBe("IN_PROGRESS");
      await s.tx`select api.assign_corrective_action_owner(${id}, ${USERS.financeEmployee}, ${REASON})`;
      await s.as("financeEmployee");
      await submit(s, id);
      // The case manager submitted it once: they still may not verify it.
      await s.as("caseManager");
      await s.expectError("CDF_FORBIDDEN", () => verify(s, id, "VERIFIED"));
      await s.as("grcDirector");
      expect(await verify(s, id, "VERIFIED")).toBe("COMPLETED");
      // The database refuses an owner as verifier even from the owner connection.
      await s.asOwner();
      await s.expectError(
        "new row for relation",
        (tx) => tx`update decision.corrective_action set verified_by = owner_id where id = ${id}`,
      );
    });
  });
});

describe("managing actions", () => {
  it("managers reassign the owner and move the due date; each change is told to the owner", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "financeEmployee", "employeeB");
      const f = await decidedPackage(s);
      const id = await open(s, "caseManager", f.corrective, "financeEmployee");
      const assign = (owner: string) =>
        s.tx`select api.assign_corrective_action_owner(${id}, ${owner}, ${REASON})`;
      const due = (days: number) =>
        s.tx`select api.change_corrective_action_due_date(${id}, (now() at time zone 'Asia/Riyadh')::date + ${days}::int, ${REASON})`;
      await s.as("financeEmployee");
      await s.expectError("CDF_FORBIDDEN", () => assign(USERS.employeeB));
      await s.expectError("CDF_FORBIDDEN", () => due(40));
      await s.as("investigatorB");
      await s.expectError("CDF_FORBIDDEN", () => assign(USERS.employeeB));
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:SAME_OWNER", () => assign(USERS.financeEmployee));
      await s.expectError("CDF_INVALID:owner_id", () => assign(USERS.employee));
      await assign(USERS.employeeB);
      expect(await notified(s, "CORRECTIVE_ACTION_ASSIGNED", id)).toEqual(["employeeB", "financeEmployee"]);
      await s.as("financeEmployee");
      expect(await s.tx`select id from decision.corrective_action`).toEqual([]);
      await s.as("employeeB");
      expect(await s.tx`select id from decision.corrective_action`).toHaveLength(1);
      await s.as("caseManager");
      await s.expectError("CDF_INVALID:due_date", () => due(-1));
      await s.expectError("CDF_INVALID:due_date", () => due(30));
      await due(45);
      expect(await notified(s, "CORRECTIVE_ACTION_CHANGED", id)).toEqual(["employeeB"]);
      await s.asOwner();
      const events = await s.tx<{ event_type: string }[]>`
        select event_type from decision.corrective_action_event where action_id = ${id} order by created_at`;
      expect(events.map((e) => e.event_type)).toEqual(["OPENED", "OWNER_CHANGED", "DUE_DATE_CHANGED"]);
      expect(await audited(s, id)).toEqual([
        "CORRECTIVE_ACTION_OPENED",
        "CORRECTIVE_ACTION_OWNER_CHANGED",
        "CORRECTIVE_ACTION_DUE_DATE_CHANGED",
      ]);
    });
  });

  it("an owner who can no longer open the action is told nothing more about it (AGENT-09 L1)", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "financeEmployee", "employeeB");
      const f = await decidedPackage(s);
      const pending = await open(s, "caseManager", f.corrective, "financeEmployee");
      const done = await open(s, "caseManager", f.corrective, "financeEmployee");
      await s.as("financeEmployee");
      await submit(s, pending);
      await submit(s, done);
      await s.as("grcDirector");
      expect(await verify(s, done, "VERIFIED")).toBe("COMPLETED");
      // A conflict arises: the owner fails the case gate and no longer sees either action.
      await conflicted(s, "financeEmployee");
      // Test fixture only: the Delegation of Authority will name the waiver holder (SOURCE_REQUIRED).
      await s.tx`insert into iam.role_permission (role_code, permission_code)
                 values ('GRC_DIRECTOR', 'CORRECTIVE_ACTION_WAIVE')`;
      const since = await mark(s);
      await s.as("financeEmployee");
      expect(await s.tx`select id from decision.corrective_action`).toEqual([]);
      // The managers carry on: a due-date change, a return, a reopening and a waiver are recorded, not told to the
      // conflicted owner; the reassigned action goes to its new owner.
      await s.as("caseManager");
      await s.tx`select api.change_corrective_action_due_date(${pending}, (now() at time zone 'Asia/Riyadh')::date + 40, ${REASON})`;
      expect(await verify(s, pending, "RETURNED", "Synthetic: attach the revised SOP.")).toBe("IN_PROGRESS");
      await s.tx`select api.reopen_corrective_action(${done}, ${REASON})`;
      await s.tx`select api.assign_corrective_action_owner(${done}, ${USERS.employeeB}, ${REASON})`;
      await s.as("grcDirector");
      await s.tx`select api.waive_corrective_action(${pending}, 'MEMO-DEMO-0105', ${REASON})`;
      for (const id of [pending, done]) {
        expect(await notified(s, "CORRECTIVE_ACTION_CHANGED", id)).toEqual([]);
        expect(await notified(s, "CORRECTIVE_ACTION_RETURNED", id)).toEqual([]);
      }
      expect(await notified(s, "CORRECTIVE_ACTION_ASSIGNED", done)).toEqual(["employeeB", "financeEmployee"]);
      expect(await audited(s, pending)).toEqual([
        "CORRECTIVE_ACTION_OPENED",
        "CORRECTIVE_ACTION_COMPLETION_SUBMITTED",
        "CORRECTIVE_ACTION_DUE_DATE_CHANGED",
        "CORRECTIVE_ACTION_RETURNED",
        "CORRECTIVE_ACTION_WAIVED",
      ]);
      await recipientsSeeActions(s, since);
    });
  });

  it("on a restricted case only its Restricted Case Authority names or changes the owner (DEC-61/62 precedent)", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "financeEmployee", "employeeB");
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET'
                 where id in (${USERS.committeeSecretary}, ${USERS.financeEmployee}, ${USERS.employeeB})`;
      await seat(s, ic, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["grcDeputy", "MEMBER"],
      ]);
      await preliminaryReferral(s, caseExec); // AMB-018 (migration 2030)
      await authorityRuleFor(s, "CORRECTIVE_ACTION"); // DEC-F13 (migration 2030)
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`;
      const [cp] = await s.tx<{ id: string }[]>`
        select api.refer_case_to_committee(${caseExec}, ${ic}, null, ${REASON}) as id`;
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp!.id}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      const [p] = await s.tx<{ id: string }[]>`
        select id from committee.meeting_participant where meeting_id = ${m!.id} and user_id = ${USERS.grcDeputy}`;
      await s.as("grcDeputy");
      await s.tx`select api.declare_meeting_conflict(${p!.id}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${m!.id}, ${REASON})`;
      await s.tx`select api.record_attendance(${p!.id}, 'PRESENT')`;
      const [pkg] = await s.tx<{ id: string }[]>`
        select api.create_recommendation_package(${cp!.id}, 'PACKAGE') as id`;
      const [item] = await s.tx<{ id: string }[]>`
        select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null,
          'Synthetic: tighten the approval controls.', null, null) as id`;
      await s.tx`select api.submit_package_for_vote(${pkg!.id})`;
      await s.tx`select api.open_package_vote(${m!.id}, ${pkg!.id})`;
      const [vi] = await s.tx<
        { id: string }[]
      >`select id from committee.vote_item where package_id = ${pkg!.id}`;
      await s.as("grcDeputy");
      await s.tx`select api.cast_vote(${vi!.id}, 'APPROVE', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi!.id}, null)`;
      await s.tx`select api.record_package_adoption(${pkg!.id})`;
      await s.tx`select api.submit_to_authority(${pkg!.id})`;
      await s.tx`select api.record_authority_decision(${pkg!.id}, 'CEO', 'APPROVE_AS_RECOMMENDED',
        now(), 'Chief Executive (synthetic)', 'MEMO-DEMO-0102', null, ${REASON})`;

      // The case manager cannot see the restricted case; the deputy can with a case grant, and still may not name
      // an owner; the case's owner and Restricted Case Authority may.
      await s.expectError("CDF_NOT_FOUND", () => open(s, "caseManager", item!.id, "financeEmployee"));
      await s.expectError("CDF_NOT_FOUND", () => open(s, "grcDeputy", item!.id, "financeEmployee"));
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${caseExec}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      await s.expectError("CDF_CONFLICT:RESTRICTED_CASE_AUTHORITY_REQUIRED", () =>
        open(s, "grcDeputy", item!.id, "financeEmployee"),
      );
      const id = await open(s, "grcDirector", item!.id, "financeEmployee");
      await recipientsSeeActions(s);
      await s.as("grcDeputy");
      await s.expectError(
        "CDF_CONFLICT:RESTRICTED_CASE_AUTHORITY_REQUIRED",
        (tx) => tx`select api.assign_corrective_action_owner(${id}, ${USERS.employeeB}, ${REASON})`,
      );
      // Other management stays with the managers who can see the case.
      await s.tx`select api.change_corrective_action_due_date(${id}, (now() at time zone 'Asia/Riyadh')::date + 60, ${REASON})`;
      await s.as("grcDirector");
      await s.tx`select api.assign_corrective_action_owner(${id}, ${USERS.employeeB}, ${REASON})`;
      // An owner below the case's classification is not eligible.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'CONFIDENTIAL' where id = ${USERS.financeEmployee}`;
      await s.as("grcDirector");
      await s.expectError(
        "CDF_INVALID:owner_id",
        (tx) => tx`select api.assign_corrective_action_owner(${id}, ${USERS.financeEmployee}, ${REASON})`,
      );
      await s.as("employeeB");
      await progress(s, id, 20);
      await submit(s, id);
      // Only managers who can see the restricted case are asked to verify; the case manager cannot see it.
      expect(await notified(s, "CORRECTIVE_ACTION_SUBMITTED", id)).toEqual(["grcDeputy", "grcDirector"]);
    });
  });
});

describe("waiver (N15 pattern)", () => {
  it("needs the waive permission, which no role holds yet, and the authority's source document; it is final", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "financeEmployee");
      const f = await decidedPackage(s);
      const id = await open(s, "caseManager", f.corrective, "financeEmployee");
      const waive = (reference: string | null) =>
        s.tx`select api.waive_corrective_action(${id}, ${reference}, ${REASON})`;
      for (const u of ["grcDirector", "caseManager", "financeEmployee"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", () => waive("MEMO-DEMO-0103"));
      }
      // Test fixture only: the Delegation of Authority will name the holder (SOURCE_REQUIRED).
      await s.asOwner();
      await s.tx`insert into iam.role_permission (role_code, permission_code)
                 values ('GRC_DIRECTOR', 'CORRECTIVE_ACTION_WAIVE')`;
      await s.as("grcDirector");
      await s.expectError("CDF_INVALID:source_document_reference", () => waive(null));
      await s.expectError("CDF_INVALID:source_document_reference", () => waive(" "));
      await waive("MEMO-DEMO-0103");
      expect(await action(s, id)).toMatchObject({ status: "WAIVED" });
      expect(await notified(s, "CORRECTIVE_ACTION_CHANGED", id)).toEqual(["financeEmployee"]);
      await s.as("grcDirector");
      await s.expectError("CDF_CONFLICT:ACTION_CLOSED", () => waive("MEMO-DEMO-0104"));
      await s.as("financeEmployee");
      await s.expectError("CDF_CONFLICT:ACTION_NOT_ACTIVE", () => progress(s, id, 10));
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:ACTION_NOT_ACTIVE",
        (tx) => tx`select api.assign_corrective_action_owner(${id}, ${USERS.caseManager}, ${REASON})`,
      );
      await s.expectError(
        "CDF_CONFLICT:NOT_COMPLETED",
        (tx) => tx`select api.reopen_corrective_action(${id}, ${REASON})`,
      );
      await s.asOwner();
      const [e] = await s.tx<{ source_document_reference: string }[]>`
        select source_document_reference from decision.corrective_action_event
        where action_id = ${id} and event_type = 'WAIVED'`;
      expect(e!.source_document_reference).toBe("MEMO-DEMO-0103");
      await s.expectError(
        "corrective action",
        (tx) => tx`update decision.corrective_action set status = 'OPEN', waived_at = null where id = ${id}`,
      );
    });
  });
});

describe("case closure (EPIC 12)", () => {
  it("a case does not close while an approved corrective item has an outstanding or missing action", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "financeEmployee");
      const f = await decidedPackage(s);
      const close = () =>
        s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', 'Synthetic: closing after the decision.')`;
      await s.as("caseManager");
      // The approved corrective item has no action yet (the rejected remediation needs none).
      await s.expectError("CDF_CONFLICT:CORRECTIVE_ACTIONS_OUTSTANDING", close);
      const id = await open(s, "caseManager", f.corrective, "financeEmployee");
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:CORRECTIVE_ACTIONS_OUTSTANDING", close);
      await s.as("financeEmployee");
      await submit(s, id);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:CORRECTIVE_ACTIONS_OUTSTANDING", close);
      await s.as("grcDirector");
      await verify(s, id, "VERIFIED");
      await s.as("caseManager");
      await close();
      await s.asOwner();
      const [c] = await s.tx<{ records_state: string }[]>`
        select records_state from case_mgmt.case_record where id = ${caseB}`;
      expect(c!.records_state).toBe("CLOSED");
      // A closed case's actions are no longer reopened or reassigned.
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:CASE_NOT_ACTIVE",
        (tx) => tx`select api.reopen_corrective_action(${id}, ${REASON})`,
      );
    });
  });
});

describe("policy (SOURCE_REQUIRED, configurable)", () => {
  const setPolicy = (
    s: Scenario,
    due: number | null,
    reminder: number | null,
    escalate: number | null,
    evidence = "NOTE_ONLY",
    from: "now" | "yesterday" = "now",
  ) =>
    s.tx`select api.set_corrective_action_policy('CORRECTIVE_ACTION', ${due}::int, ${reminder}::int, ${escalate}::int,
      ${evidence}, case when ${from} = 'yesterday' then now() - interval '1 day' else now() end, 'APPROVED',
      ${REASON}) as id`;

  it("is seeded empty: no default due period, no reminder, no escalation, evidence reference required", async () => {
    await ownerScenario(async (s) => {
      await s.as("financeEmployee");
      const rows = await s.tx<Record<string, unknown>[]>`
        select action_type, default_due_days, reminder_days_before, escalate_after_days, completion_evidence,
               source_status, created_by
        from decision.corrective_action_policy order by action_type`;
      expect(rows).toEqual(
        ["CORRECTIVE_ACTION", "GOVERNANCE_REMEDIATION"].map((t) => ({
          action_type: t,
          default_due_days: null,
          reminder_days_before: null,
          escalate_after_days: null,
          completion_evidence: "REFERENCE_REQUIRED",
          source_status: "SOURCE_REQUIRED",
          created_by: null,
        })),
      );
      // With the placeholders, nothing is ever reminded or escalated, even for an action long overdue.
      await implementationOwners(s, "financeEmployee");
      const f = await decidedPackage(s);
      const id = await open(s, "caseManager", f.corrective, "financeEmployee", 0);
      await s.asOwner();
      await s.tx`update decision.corrective_action set due_date = due_date - 400 where id = ${id}`;
      await emitReminders(s);
      expect(await notified(s, "CORRECTIVE_ACTION_DUE", id)).toEqual([]);
      expect(await notified(s, "CORRECTIVE_ACTION_OVERDUE", id)).toEqual([]);
    });
  });

  it("only the policy administrator changes it, effective-dated; due periods, evidence and reminders follow it", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      await s.expectError("CDF_FORBIDDEN", () => setPolicy(s, 30, 7, 3));
      await s.as("grcDirector");
      await s.expectError("CDF_INVALID:default_due_days", () => setPolicy(s, 0, 7, 3));
      await s.expectError("CDF_INVALID:reminder_days_before", () => setPolicy(s, 30, 91, 3));
      await s.expectError("CDF_INVALID:escalate_after_days", () => setPolicy(s, 30, 7, 366));
      await s.expectError("CDF_INVALID:completion_evidence", () => setPolicy(s, 30, 7, 3, "NONE"));
      await s.expectError("CDF_INVALID:effective_from", () =>
        setPolicy(s, 30, 7, 3, "NOTE_ONLY", "yesterday"),
      );
      await setPolicy(s, 30, 7, 3);
      await s.expectError("CDF_CONFLICT:LATER_POLICY_EXISTS", () => setPolicy(s, 20, 7, 3));
      await s.asOwner();
      const [audit] = await s.tx<{ action: string; actor_id: string }[]>`
        select action, actor_id from audit.audit_event where action = 'CORRECTIVE_ACTION_POLICY_SET'`;
      expect(audit).toEqual({ action: "CORRECTIVE_ACTION_POLICY_SET", actor_id: USERS.grcDirector });
      await s.expectError(
        "corrective-action policy",
        (tx) =>
          tx`update decision.corrective_action_policy set default_due_days = 5 where created_by is not null`,
      );

      await implementationOwners(s, "financeEmployee", "employeeB");
      const f = await decidedPackage(s, "APPROVE_AS_RECOMMENDED");
      // No due date given: the policy's default period applies (CORRECTIVE_ACTION only; the remediation has none).
      const byDefault = await open(s, "caseManager", f.corrective, "financeEmployee", null);
      await s.asOwner();
      const [expected] = await s.tx<
        { d: string }[]
      >`select ((now() at time zone 'Asia/Riyadh')::date + 30)::text as d`;
      expect((await action(s, byDefault)).due_date).toBe(expected!.d);
      await s.expectError("CDF_INVALID:due_date", () =>
        open(s, "caseManager", f.remediation, "financeEmployee", null),
      );
      // NOTE_ONLY: completion without a reference.
      await s.as("financeEmployee");
      await submit(s, byDefault, null);
      // Reminder 7 days before the due date to the owner, once; escalation 3 days after it to the owner and the
      // managers who can see the case, once.
      const soon = await open(s, "caseManager", f.corrective, "financeEmployee", 5);
      const notYet = await open(s, "caseManager", f.corrective, "financeEmployee", 8);
      const late = await open(s, "caseManager", f.corrective, "employeeB", 0);
      const later = await open(s, "caseManager", f.corrective, "employeeB", 0);
      await s.asOwner();
      await s.tx`update decision.corrective_action set due_date = due_date - 4 where id = ${late}`;
      await s.tx`update decision.corrective_action set due_date = due_date - 3 where id = ${later}`;
      expect(await emitReminders(s)).toBe(2);
      expect(await emitReminders(s)).toBe(0);
      expect(await notified(s, "CORRECTIVE_ACTION_DUE", soon)).toEqual(["financeEmployee"]);
      expect(await notified(s, "CORRECTIVE_ACTION_DUE", notYet)).toEqual([]);
      expect(await notified(s, "CORRECTIVE_ACTION_DUE", late)).toEqual([]);
      expect(await notified(s, "CORRECTIVE_ACTION_OVERDUE", late)).toEqual([
        "caseManager",
        "employeeB",
        "grcDeputy",
        "grcDirector",
      ]);
      // Exactly at the escalation threshold: not yet; and a submitted action is not chased.
      expect(await notified(s, "CORRECTIVE_ACTION_OVERDUE", later)).toEqual([]);
      expect(await notified(s, "CORRECTIVE_ACTION_DUE", byDefault)).toEqual([]);
      await recipientsSeeActions(s);
      // An owner who has lost the case gate is not reminded (AGENT-09 early look on 1940).
      const quiet = await open(s, "caseManager", f.corrective, "financeEmployee", 6);
      await conflicted(s, "financeEmployee");
      expect(await emitReminders(s)).toBe(0);
      expect(await notified(s, "CORRECTIVE_ACTION_DUE", quiet)).toEqual([]);
    });
  });
});

describe("integrity", () => {
  it("history is append-only and an action keeps its origin and wording", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "financeEmployee");
      const f = await decidedPackage(s);
      const id = await open(s, "caseManager", f.corrective, "financeEmployee");
      await s.asOwner();
      await s.expectError(
        "decision.corrective_action_event is append-only",
        (tx) => tx`update decision.corrective_action_event set note = 'Synthetic: rewritten.'`,
      );
      await s.expectError(
        "decision.corrective_action_event is append-only",
        (tx) => tx`delete from decision.corrective_action_event`,
      );
      await s.expectError(
        "decision.corrective_action is append-only",
        (tx) => tx`delete from decision.corrective_action where id = ${id}`,
      );
      for (const change of [
        "title = 'Synthetic: a different action'",
        `recommendation_item_id = '${f.remediation}'`,
        "created_by = owner_id",
      ]) {
        await s.expectError("corrective action", (tx) =>
          tx.unsafe(`update decision.corrective_action set ${change} where id = '${id}'`),
        );
      }
      // Application roles have no write grants.
      await s.as("caseManager");
      await s.expectError(
        "permission denied",
        (tx) => tx`update decision.corrective_action set due_date = due_date + 1 where id = ${id}`,
      );
      await s.expectError(
        "permission denied",
        (tx) =>
          tx`insert into decision.corrective_action_event (action_id, case_id, event_type, actor_id)
             values (${id}, ${caseB}, 'VERIFIED', ${USERS.caseManager})`,
      );
    });
  });
});

describe("owner decisions DEC-F26, DEC-F27 and DEC-F28 (migration 2040)", () => {
  const OPS_SECTOR = "b0000000-0000-4000-8000-000000000001";
  const FIN_SECTOR = "b0000000-0000-4000-8000-000000000002"; // financeEmployee is a member
  /** The 2040 policy command (12 arguments): `extra` are the cadence, overdue threshold, evidence types and steps. */
  const setPolicy2040 = (
    s: Scenario,
    evidence: string,
    reminder: number | null,
    extra: { repeat?: number | null; overdue?: number | null; types?: string[] | null; steps?: unknown },
  ) =>
    s.tx`select api.set_corrective_action_policy('CORRECTIVE_ACTION', 30, ${reminder}::int, null::int, ${evidence},
      now(), 'APPROVED', ${REASON}, ${extra.repeat ?? null}::int, ${extra.overdue ?? null}::int,
      ${extra.types ?? null}::text[], ${extra.steps === undefined ? null : s.tx.json(extra.steps as never)}::jsonb) as id`;
  const backdate = async (s: OwnerScenario, id: string, days: number) => {
    await s.asOwner();
    await s.tx`update decision.corrective_action set due_date = (now() at time zone 'Asia/Riyadh')::date - ${days}::int
               where id = ${id}`;
  };

  it("DEC-F26: cadence, overdue threshold and escalation steps are off until configured; every recipient passes the case gate", async () => {
    await ownerScenario(async (s) => {
      await s.as("grcDirector");
      await s.expectError("CDF_INVALID:reminder_repeat_days", () =>
        setPolicy2040(s, "NOTE_ONLY", null, { repeat: 2 }),
      );
      await s.expectError("CDF_INVALID:overdue_after_days", () =>
        setPolicy2040(s, "NOTE_ONLY", 7, { overdue: 366 }),
      );
      for (const steps of [
        [{ after_days_overdue: 2, recipient_kind: "ROLE" }],
        [{ after_days_overdue: 2, recipient_kind: "ROLE", role_code: "NO_SUCH_ROLE" }],
        [{ after_days_overdue: 2, recipient_kind: "OWNER", role_code: "INVESTIGATOR" }],
        [{ after_days_overdue: 400, recipient_kind: "OWNER" }],
        [{ after_days_overdue: 2, recipient_kind: "EVERYONE" }],
        { after_days_overdue: 2, recipient_kind: "OWNER" },
      ]) {
        await s.expectError("CDF_INVALID:escalation_steps", () =>
          setPolicy2040(s, "NOTE_ONLY", 7, { steps }),
        );
      }
      await s.as("caseManager");
      await s.expectError("CDF_FORBIDDEN", () => setPolicy2040(s, "NOTE_ONLY", 7, { repeat: 2 }));
      await s.as("grcDirector");
      const [p] = await setPolicy2040(s, "NOTE_ONLY", 7, {
        repeat: 2,
        overdue: 1,
        steps: [
          { after_days_overdue: 2, recipient_kind: "ROLE", role_code: "INVESTIGATOR" },
          { after_days_overdue: 5, recipient_kind: "CASE_MANAGERS" },
        ],
      });
      // A version's steps are written with it and never change.
      await s.asOwner();
      await s.expectError(
        "decision.corrective_action_escalation_step is append-only",
        (tx) => tx`update decision.corrective_action_escalation_step set after_days_overdue = 0`,
      );
      expect(
        await s.tx`select step_no, after_days_overdue, recipient_kind, role_code
                   from decision.corrective_action_escalation_step where policy_id = ${(p as { id: string }).id}
                   order by step_no`,
      ).toEqual([
        { step_no: 1, after_days_overdue: 2, recipient_kind: "ROLE", role_code: "INVESTIGATOR" },
        { step_no: 2, after_days_overdue: 5, recipient_kind: "CASE_MANAGERS", role_code: null },
      ]);

      await implementationOwners(s, "financeEmployee", "employeeB");
      const f = await decidedPackage(s, "APPROVE_AS_RECOMMENDED");
      const soon = await open(s, "caseManager", f.corrective, "financeEmployee", 5);
      const step1 = await open(s, "caseManager", f.corrective, "employeeB", 0);
      const step2 = await open(s, "caseManager", f.corrective, "employeeB", 0);
      await backdate(s, step1, 3);
      await backdate(s, step2, 6);
      const since = await mark(s);
      expect(await emitReminders(s)).toBeGreaterThan(0);
      expect(await emitReminders(s)).toBe(0);
      expect(await notified(s, "CORRECTIVE_ACTION_DUE", soon)).toEqual(["financeEmployee"]);
      // Overdue past the threshold: the owner. Step 1 (2 days): the INVESTIGATOR role holders who can see the case,
      // so Investigator Beta (case 0002) and never Investigator Alpha. Step 2 (5 days): the case's action managers.
      expect(await notified(s, "CORRECTIVE_ACTION_OVERDUE", step1)).toEqual(["employeeB", "investigatorB"]);
      expect(await notified(s, "CORRECTIVE_ACTION_OVERDUE", step2)).toEqual([
        "caseManager",
        "employeeB",
        "grcDeputy",
        "grcDirector",
        "investigatorB",
      ]);
      await recipientsSeeActions(s, since);
      // The due-soon reminder repeats every 2 days until the due date (the first one is backdated to show it).
      await s.asOwner();
      await s.tx`alter table notify.outbox disable trigger user`;
      await s.tx`update notify.outbox set created_at = created_at - interval '3 days' where object_id = ${soon}`;
      await s.tx`alter table notify.outbox enable trigger user`;
      expect(await emitReminders(s)).toBe(1);
      expect(await emitReminders(s)).toBe(0);
      expect(await inApp(s, "CORRECTIVE_ACTION_DUE", soon)).toBe(2);
      // A role holder who loses the case gate is not told: Investigator Beta declares a conflict.
      const quiet = await open(s, "caseManager", f.corrective, "employeeB", 0);
      await backdate(s, quiet, 3);
      await conflicted(s, "investigatorB");
      await emitReminders(s);
      expect(await notified(s, "CORRECTIVE_ACTION_OVERDUE", quiet)).toEqual(["employeeB"]);
    });
  });

  it("DEC-F27: completion evidence names a catalogue type, one the policy allows when it lists them", async () => {
    await ownerScenario(async (s) => {
      await s.as("grcDirector");
      for (const types of [[], ["DOCUMENT", "DOCUMENT"], ["NO_SUCH_TYPE"]]) {
        await s.expectError("CDF_INVALID:allowed_evidence_types", () =>
          setPolicy2040(s, "REFERENCE_REQUIRED", null, { types }),
        );
      }
      await implementationOwners(s, "financeEmployee");
      const f = await decidedPackage(s, "APPROVE_AS_RECOMMENDED");
      // No list (as seeded): a type is optional, but must be a catalogue type and needs a reference.
      const free = await open(s, "caseManager", f.corrective, "financeEmployee");
      await s.as("financeEmployee");
      await s.expectError(
        "CDF_INVALID:evidence_type",
        (tx) =>
          tx`select api.submit_corrective_action_completion(${free}, 'Synthetic: done.', ${EVIDENCE}, 'NO_SUCH_TYPE')`,
      );
      await s.tx`select api.submit_corrective_action_completion(${free}, 'Synthetic: done.', ${EVIDENCE}, 'TRAINING_EVIDENCE')`;
      // A list: a reference needs one of the listed types.
      await s.as("grcDirector");
      await setPolicy2040(s, "REFERENCE_REQUIRED", null, { types: ["DOCUMENT", "REVISED_PROCEDURE"] });
      const listed = await open(s, "caseManager", f.corrective, "financeEmployee");
      await s.as("financeEmployee");
      for (const type of [null, "TRAINING_EVIDENCE"]) {
        await s.expectError(
          "CDF_INVALID:evidence_type",
          (tx) =>
            tx`select api.submit_corrective_action_completion(${listed}, 'Synthetic: done.', ${EVIDENCE}, ${type})`,
        );
      }
      await s.expectError("CDF_INVALID:evidence_type", () => submit(s, listed));
      await s.expectError(
        "CDF_INVALID:evidence_reference",
        (tx) =>
          tx`select api.submit_corrective_action_completion(${listed}, 'Synthetic: done.', null, 'DOCUMENT')`,
      );
      await s.tx`select api.submit_corrective_action_completion(${listed}, 'Synthetic: done.', ${EVIDENCE}, 'REVISED_PROCEDURE')`;
      await s.asOwner();
      expect(
        await s.tx`select action_id, evidence_type from decision.corrective_action_event
                   where event_type = 'COMPLETION_SUBMITTED' and action_id in (${free}, ${listed})
                   order by evidence_type collate "C"`,
      ).toEqual([
        { action_id: listed, evidence_type: "REVISED_PROCEDURE" },
        { action_id: free, evidence_type: "TRAINING_EVIDENCE" },
      ]);
      const [audit] = await s.tx<{ type: string }[]>`
        select metadata->>'evidence_type' as type from audit.audit_event
        where action = 'CORRECTIVE_ACTION_COMPLETION_SUBMITTED' and object_id = ${listed}`;
      expect(audit!.type).toBe("REVISED_PROCEDURE");
      await s.expectError(
        "decision.corrective_evidence_type is append-only",
        (tx) => tx`delete from decision.corrective_evidence_type where code = 'DOCUMENT'`,
      );
    });
  });

  it("DEC-F28: a unit, a pool or an external party may own an action; an accountable user stays and every person acting passes the case gate", async () => {
    await ownerScenario(async (s) => {
      await implementationOwners(s, "financeEmployee", "employeeB", "employee");
      // Pools: the policy administrator only; members need CORRECTIVE_ACTION_OWN.
      await s.as("caseManager");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.create_corrective_action_pool('POOL_DEMO', 'Synthetic pool', ${REASON})`,
      );
      await s.as("grcDirector");
      await s.expectError(
        "CDF_INVALID:code",
        (tx) => tx`select api.create_corrective_action_pool('pool', 'Synthetic pool', ${REASON})`,
      );
      const [pool] = await s.tx<{ id: string }[]>`
        select api.create_corrective_action_pool('POOL_DEMO', 'Synthetic pool', ${REASON}) as id`;
      await s.expectError(
        "CDF_INVALID:user_id",
        (tx) =>
          tx`select api.set_corrective_action_pool_member(${pool!.id}, ${USERS.committee}, true, ${REASON})`,
      );
      await s.tx`select api.set_corrective_action_pool_member(${pool!.id}, ${USERS.employee}, true, ${REASON})`;
      await s.tx`select api.set_corrective_action_pool_member(${pool!.id}, ${USERS.financeEmployee}, true, ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_MEMBER",
        (tx) =>
          tx`select api.set_corrective_action_pool_member(${pool!.id}, ${USERS.employee}, true, ${REASON})`,
      );

      const f = await decidedPackage(s, "APPROVE_AS_RECOMMENDED");
      const id = await open(s, "caseManager", f.corrective, "employeeB");
      const kind = (k: string, sector: string | null, p: string | null, label: string | null) =>
        s.tx`select api.set_corrective_action_owner_kind(${id}, ${k}, ${sector}::uuid, ${p}::uuid, ${label}, ${REASON})`;
      const sees = async (u: UserKey) => {
        await s.as(u);
        return (await s.tx`select id from decision.corrective_action where id = ${id}`).length === 1;
      };
      // Only a manager changes the kind, with a matching shape.
      await s.as("employeeB");
      await s.expectError("CDF_FORBIDDEN", () => kind("SHARED_POOL", null, pool!.id, null));
      await s.as("caseManager");
      await s.expectError("CDF_INVALID:owner_kind", () => kind("TEAM", null, null, null));
      await s.expectError("CDF_INVALID:pool_id", () => kind("SHARED_POOL", null, null, null));
      await s.expectError("CDF_INVALID:sector_id", () => kind("ORG_UNIT", null, null, null));
      await s.expectError("CDF_INVALID:sector_id", () => kind("SHARED_POOL", OPS_SECTOR, pool!.id, null));
      await s.expectError("CDF_INVALID:external_party_label", () => kind("EXTERNAL_PARTY", null, null, null));
      expect(await sees("employee")).toBe(false);

      // A shared pool: its eligible member acts; the accountable owner stays.
      await s.as("caseManager");
      await kind("SHARED_POOL", null, pool!.id, null);
      for (const u of ["employee", "financeEmployee", "employeeB"] as const)
        expect(await sees(u), u).toBe(true);
      await s.as("employee");
      await progress(s, id, 20);
      // A member without the case gate neither sees nor acts.
      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseB}, ${USERS.employee}, 'CONFLICT_DECLARED', 'Synthetic declared conflict')`;
      expect(await sees("employee")).toBe(false);
      await s.expectError("CDF_NOT_FOUND", () => progress(s, id, 30));
      // A removed member loses it.
      await s.as("grcDirector");
      await s.tx`select api.set_corrective_action_pool_member(${pool!.id}, ${USERS.financeEmployee}, false, ${REASON})`;
      expect(await sees("financeEmployee")).toBe(false);

      // An organisational unit: its current members with the role act (Finance: financeEmployee).
      await s.as("caseManager");
      await kind("ORG_UNIT", FIN_SECTOR, null, null);
      expect(await sees("financeEmployee")).toBe(true);
      await s.as("financeEmployee");
      await progress(s, id, 40);
      // An external party: only the accountable owner acts for it inside the platform.
      await s.as("caseManager");
      await kind("EXTERNAL_PARTY", null, null, "Synthetic external contractor");
      expect(await sees("financeEmployee")).toBe(false);
      await s.as("employeeB");
      await progress(s, id, 60);
      await s.asOwner();
      const [row] = await s.tx<Record<string, unknown>[]>`
        select owner_kind, owner_id, owner_sector_id, owner_pool_id, external_party_label
        from decision.corrective_action where id = ${id}`;
      expect(row).toEqual({
        owner_kind: "EXTERNAL_PARTY",
        owner_id: USERS.employeeB,
        owner_sector_id: null,
        owner_pool_id: null,
        external_party_label: "Synthetic external contractor",
      });
      const kinds = await s.tx<{ kind: string; accountable: string }[]>`
        select metadata->>'owner_kind' as kind, metadata->>'accountable_owner_id' as accountable from audit.audit_event
        where action = 'CORRECTIVE_ACTION_OWNER_KIND_CHANGED' and object_id = ${id} order by seq`;
      expect(kinds).toEqual(
        ["SHARED_POOL", "ORG_UNIT", "EXTERNAL_PARTY"].map((k) => ({ kind: k, accountable: USERS.employeeB })),
      );
      await s.expectError(
        "pool membership",
        (tx) => tx`update decision.corrective_action_pool_member set reason = 'Synthetic: rewritten reason.'`,
      );
    });
  });
});
