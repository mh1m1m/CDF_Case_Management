// Migration 2098 (CDF-237; AMB-251, DEC-F17, ADR-040 §5 item 17): on a restricted case the Grievance Committee's
// chair decides admissibility only if they already work the case. 2040 put that condition into the decider's read path
// and notice (grievance.is_pending_decider) but not into api.decide_grievance_admissibility; 2098 adds it to the
// command and to its capability (may_decide), so the command, the read and the flag agree. The case is CONFIDENTIAL,
// so the chair (Committee Member Epsilon, CONFIDENTIAL) passes clearance, and only the restricted-case condition keeps
// them out. Synthetic data; every probe runs as `authenticated` and is rolled back.
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, ownerScenario, reportId, type OwnerScenario, type UserKey } from "../support/db";
import { REASON, committeeIds, seat } from "../support/committee";
import { outcomes } from "../support/capabilities";
import { GRIEVANCE_GROUNDS } from "../support/grievance";

let gc: string;

beforeAll(async () => {
  ({ gc } = await committeeIds());
});

const DECIDE = (g: string) => ({
  decide4: `select api.decide_grievance_admissibility('${g}', 'INADMISSIBLE', 'GC-DEMO-2098', '${REASON}')`,
  decide5: `select api.decide_grievance_admissibility('${g}', 'INADMISSIBLE', 'GC-DEMO-2098', '${REASON}', null)`,
});

/** A CONFIDENTIAL restricted case, owned by its Restricted Case Authority, the GRC Director. */
async function restrictedCase(s: OwnerScenario): Promise<string> {
  const report = await reportId("WB-SEED00000005");
  await s.as("triage");
  await s.tx`select api.triage_report(${report}, 'OPEN_CASE', ${REASON}, null, null)`;
  const [c] = await s.tx<{ id: string }[]>`
    select api.create_case_from_report(${report}, 'Restricted grievance probe', 'Synthetic restricted grievance probe.',
      'CONFIDENTIAL'::core.classification_level, true, ${USERS.grcDirector}::uuid) as id`;
  return c!.id;
}

/** A subject's grievance on the case, handled by the GRC Deputy with the authority's approval, awaiting a decision. */
async function awaitingDecision(s: OwnerScenario, caseId: string): Promise<string> {
  await s.as("grcDirector");
  const [subj] = await s.tx<{ id: string }[]>`
    select api.add_case_subject(${caseId}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
  const [link] = await s.tx<{ id: string }[]>`
    select api.link_subject_portal_account(${subj!.id}, ${USERS.employee}, ${REASON}) as id`;
  await s.as("employee");
  const [g] = await s.tx<
    { id: string }[]
  >`select api.file_grievance(${link!.id}, now(), ${GRIEVANCE_GROUNDS}) as id`;
  await s.as("grcDirector");
  await s.tx`select api.approve_restricted_grievance_handling(${g!.id}, ${USERS.grcDeputy}, ${REASON})`;
  await s.as("grcDeputy");
  const [r] = await s.tx<{ r: string }[]>`
    select api.assess_grievance_admissibility(${g!.id}, 'INADMISSIBLE', null, ${REASON}) as r`;
  expect(r!.r).toBe("AWAITING_ADMISSIBILITY_DECISION");
  return g!.id;
}

/** The grievance as `user` reads it: NOT_FOUND, or its may_decide flag and the queue row's step. */
async function offered(s: OwnerScenario, user: UserKey, g: string) {
  await s.as(user);
  await s.tx`savepoint offered`;
  try {
    const [v] = await s.tx<{ v: { capabilities: { may_decide: boolean } } }[]>`
      select api.grievance_view(${g}) as v`;
    const queue = await s.tx<
      { awaiting: string }[]
    >`select awaiting from api.grievance_queue() where grievance_id = ${g}`;
    return { may_decide: v!.v.capabilities.may_decide, queue: queue.map((q) => q.awaiting) };
  } catch (error) {
    await s.tx`rollback to savepoint offered`;
    if (/CDF_NOT_FOUND/.test(String(error))) return "NOT_FOUND";
    throw error;
  }
}

/** What the gates other than the restricted-case condition answer for the chair, read as the table owner. */
async function chairGates(s: OwnerScenario, caseId: string) {
  await s.asOwner();
  const [r] = await s.tx<
    {
      seat: string;
      gate: boolean;
      took_part: boolean;
      views: boolean;
      restricted: boolean;
      decider: string;
    }[]
  >`
    select authz.user_committee_seat(${USERS.committee}, ${gc}, now()) as seat,
           authz.user_case_gate(${USERS.committee}, ${caseId}) as gate,
           coalesce(authz.participated_in_investigation_committee(${USERS.committee}, ${caseId}), false) as took_part,
           authz.user_can_view_case(${USERS.committee}, ${caseId}) as views,
           (select is_restricted from case_mgmt.case_record where id = ${caseId}) as restricted,
           (select grievance.pending_decider(g) from grievance.grievance g where g.case_id = ${caseId}) as decider`;
  return r!;
}

describe("the admissibility decider on a restricted case (CDF-237, migration 2098)", () => {
  it("T-AMB-151: a chair cleared for the case, with no conflict and no part in its Investigation Committee, who does not work the restricted case, cannot decide it (NOT_FOUND), and is offered nothing", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, [
        ["committee", "CHAIR"],
        ["grcDeputy", "SECRETARY"],
        ["grcSectorHead", "ALTERNATE_SECRETARY"],
        ["legal", "MEMBER"],
      ]);
      const restricted = await restrictedCase(s);
      const g = await awaitingDecision(s, restricted);
      // Only the restricted-case condition keeps the chair out: the seat, the case gate (active, cleared, no
      // conflict) and G3 all pass, and the decision is the chair's to take.
      expect(await chairGates(s, restricted)).toEqual({
        seat: "CHAIR",
        gate: true,
        took_part: false,
        views: false,
        restricted: true,
        decider: expect.stringMatching(/^(CHAIR|COMMITTEE)$/),
      });
      // Both overloads answer NOT_FOUND, as for a random id; the read and the queue agree, and nothing is recorded.
      expect(await outcomes(s, "committee", DECIDE(g))).toEqual({
        decide4: "CDF_NOT_FOUND",
        decide5: "CDF_NOT_FOUND",
      });
      expect(await offered(s, "committee", g)).toBe("NOT_FOUND");
      // The read gate already applies the condition (grievance.is_pending_decider); the flag behind it answers as the
      // command too, asked directly for the chair.
      await s.asOwner();
      await s.tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USERS.committee, role: "authenticated" })}, true)`;
      const [k] = await s.tx<{ may_decide: boolean }[]>`
        select (grievance.caller_capabilities(g) ->> 'may_decide')::boolean as may_decide
        from grievance.grievance g where g.id = ${g}`;
      expect(k!.may_decide).toBe(false);
      await s.asOwner();
      const [row] = await s.tx<{ status: string; decisions: number }[]>`
        select g.status, (select count(*)::int from grievance.admissibility_assessment a
                          where a.grievance_id = g.id and a.stage = 'DECISION') as decisions
        from grievance.grievance g where g.id = ${g}`;
      expect(row).toEqual({ status: "AWAITING_ADMISSIBILITY_DECISION", decisions: 0 });
    });
  });

  it("once the case's authority grants the chair the case, the chair reads it, is offered the decision and decides; the flag equals the command for every seat holder", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, [
        ["committee", "CHAIR"],
        ["grcDeputy", "SECRETARY"],
        ["grcSectorHead", "ALTERNATE_SECRETARY"],
        ["legal", "MEMBER"],
      ]);
      const restricted = await restrictedCase(s);
      const g = await awaitingDecision(s, restricted);
      const users: UserKey[] = [
        "committee",
        "legal",
        "grcDeputy",
        "grcSectorHead",
        "grcDirector",
        "caseManager",
      ];
      const flagEqualsCommand = async () => {
        for (const user of users) {
          const o = await outcomes(s, user, DECIDE(g));
          const v = await offered(s, user, g);
          const accepted = o.decide4 === true;
          expect(o.decide5 === true, `${user}: both overloads answer alike`).toBe(accepted);
          if (v === "NOT_FOUND")
            expect([user, o.decide4], `${user}: unseen`).toEqual([user, "CDF_NOT_FOUND"]);
          else {
            expect([user, v.may_decide], `${user}: may_decide == command`).toEqual([user, accepted]);
            expect([user, v.queue.includes("ADMISSIBILITY_DECISION")], `${user}: queue`).toEqual([
              user,
              accepted,
            ]);
          }
        }
      };
      await flagEqualsCommand();
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${restricted}, ${USERS.committee}, 'CASE', ${REASON}, null)`;
      expect((await chairGates(s, restricted)).views).toBe(true);
      expect(await offered(s, "committee", g)).toEqual({
        may_decide: true,
        queue: ["ADMISSIBILITY_DECISION"],
      });
      await flagEqualsCommand();
      await s.as("committee");
      const [r] = await s.tx<{ r: string }[]>`
        select api.decide_grievance_admissibility(${g}, 'INADMISSIBLE', 'GC-DEMO-2098', ${REASON}) as r`;
      expect(r!.r).toBe("INADMISSIBLE");
    });
  });
});
