// Phase 12 P12-1 case structure (ADR-017 to ADR-019, migration 1870) through the real service, gateway, database,
// RLS and audit. Each test runs in one owner-connection transaction that is rolled back: the gateway runs its
// security context inside a savepoint of that transaction, exactly as it does on its own pool, so no proceeding,
// person, finding, committee seat or referral reaches the seed (the committee registry tests count committed seats,
// and the hosted DEV run uses the same database for every suite).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCaseStructureService, type CaseStructureService } from "@cdf/application";
import { STATUS_CODES } from "@cdf/contracts";
import { PostgresCaseStructureGateway, PostgresSecurityEventSink, type Sql } from "@cdf/infrastructure";
import { USERS, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";
import { committeeIds, preliminaryReferral, seat } from "../support/committee";

const REASON = "Synthetic: case structure test.";
const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });

/** The case structure service bound to the scenario's transaction (each call runs in a savepoint). */
function structureIn(s: OwnerScenario): CaseStructureService {
  const sql = {
    begin: (fn: (tx: unknown) => Promise<unknown>) => s.tx.savepoint(fn as never),
  } as unknown as Sql;
  return createCaseStructureService({
    gateway: new PostgresCaseStructureGateway(sql),
    securityEvents: new PostgresSecurityEventSink(sql),
  });
}

function outcome(r: { ok: boolean }): string {
  if (r.ok) return "ok";
  if ("error" in r) {
    const e = (r as { error: { kind: string; detail?: string } }).error;
    return e.detail ? `${e.kind}:${e.detail}` : e.kind;
  }
  return "fieldErrors";
}

function value<T>(r: { ok: boolean }): T {
  if (!r.ok) throw new Error(`expected ok, got ${outcome(r)}`);
  return (r as unknown as { value: T }).value;
}

async function denials(s: OwnerScenario, requestId: string): Promise<string[]> {
  await s.asOwner();
  const rows = await s.tx<{ command: string; outcome: string }[]>`
    select metadata->>'command' as command, metadata->>'outcome' as outcome from audit.audit_event
    where action = 'COMMAND_DENIED' and request_id = ${requestId}
    order by seq`;
  return rows.map((r) => `${r.command}:${r.outcome}`);
}

describe("case structure (Phase 12 P12-1)", () => {
  it("the case team names a person, ties the allegation, opens a proceeding and records versioned findings", async () => {
    const case1 = await caseId("0001");
    await ownerScenario(async (s) => {
      const cs = structureIn(s);
      const manager = ctxFor("caseManager");
      const before = await cs.structure(manager, case1);
      expect(before.proceedings).toEqual([]);
      expect(before.subjects).toEqual([]);
      const allegation = before.allegations[0]!;
      expect(allegation.subjectId).toBeNull();

      const proceeding = value<string>(
        await cs.openProceeding(manager, { caseId: case1, proceedingType: "INVESTIGATION", reason: REASON }),
      );
      const subject = value<string>(
        await cs.addSubject(manager, {
          caseId: case1,
          displayLabel: "Employee Kappa (synthetic)",
          subjectCategory: "EMPLOYEE",
        }),
      );
      expect(
        outcome(
          await cs.linkAllegationSubject(manager, {
            allegationId: allegation.id,
            subjectId: subject,
            policyReference: "Code of Conduct art. 7 (synthetic)",
            lawReference: "",
          }),
        ),
      ).toBe("ok");
      const second = value<string>(
        await cs.addAllegation(manager, {
          caseId: case1,
          category: "POLICY_BREACH",
          description: "Synthetic: the approval step was skipped.",
          subjectId: subject,
          policyReference: "",
          lawReference: "Synthetic law art. 9",
        }),
      );

      // Investigator Alpha is on the team: findings, not editing. No person given: the allegation's own subject.
      const investigator = ctxFor("investigatorA");
      for (const result of ["SUBSTANTIATED", "PARTIALLY_SUBSTANTIATED"]) {
        expect(
          outcome(
            await cs.recordFinding(investigator, {
              allegationId: allegation.id,
              subjectId: "",
              proceedingId: proceeding,
              result,
              rationale: "Synthetic: the records support it in part.",
            }),
          ),
        ).toBe("ok");
      }

      const after = await cs.structure(investigator, case1);
      expect(after.proceedings).toEqual([
        expect.objectContaining({
          id: proceeding,
          sequenceNo: 1,
          proceedingType: "INVESTIGATION",
          status: "OPEN",
          closedAt: null,
        }),
      ]);
      expect(after.subjects).toEqual([
        expect.objectContaining({
          id: subject,
          displayName: "Employee Kappa (synthetic)",
          subjectCategory: "EMPLOYEE",
        }),
      ]);
      expect(after.allegations.find((a) => a.id === allegation.id)).toMatchObject({
        subjectId: subject,
        policyReference: "Code of Conduct art. 7 (synthetic)",
        lawReference: null,
      });
      expect(after.allegations.find((a) => a.id === second)).toMatchObject({
        category: "POLICY_BREACH",
        subjectId: subject,
        policyReference: null,
        lawReference: "Synthetic law art. 9",
      });
      expect(after.findings.map((f) => [f.versionNo, f.result, f.subjectId, f.proceedingId])).toEqual([
        [1, "SUBSTANTIATED", subject, proceeding],
        [2, "PARTIALLY_SUBSTANTIATED", subject, proceeding],
      ]);
      expect(after.findings[0]!.recordedByName).toBe("Investigator Alpha");
      expect(after.findingsVisible).toBe(true);
      expect(after.canRecordFindings).toBe(true);
      expect(after.committees.map((c) => c.code)).toEqual(["GC", "IC"]);
      expect(after.committeeProceedings).toEqual([]);
      // The status catalogue comes from the database, and this version knows every active code it offers.
      for (const d of Object.keys(STATUS_CODES) as (keyof typeof STATUS_CODES)[]) {
        expect(after.statusCodes[d].length).toBeGreaterThan(0);
        expect(STATUS_CODES[d]).toEqual(expect.arrayContaining(after.statusCodes[d]));
      }

      // Every write was audited in its own request.
      await s.asOwner();
      const actions = await s.tx<{ action: string }[]>`
        select action from audit.audit_event
        where case_id = ${case1} and request_id in ${s.tx([manager.requestId, investigator.requestId])}
        order by occurred_at, seq`;
      expect(actions.map((a) => a.action)).toEqual([
        "PROCEEDING_OPENED",
        "CASE_SUBJECT_ADDED",
        "ALLEGATION_SUBJECT_LINKED",
        "ALLEGATION_ADDED",
        "FINDING_RECORDED",
        "FINDING_RECORDED",
      ]);
    });
  });

  it("proceeding states, closing and the one-open rule come back as safe errors; schemas refuse early", async () => {
    const case1 = await caseId("0001");
    await ownerScenario(async (s) => {
      const cs = structureIn(s);
      const manager = ctxFor("caseManager");
      const proceeding = value<string>(
        await cs.openProceeding(manager, { caseId: case1, proceedingType: "INVESTIGATION", reason: REASON }),
      );
      expect(
        outcome(
          await cs.openProceeding(manager, {
            caseId: case1,
            proceedingType: "INVESTIGATION",
            reason: REASON,
          }),
        ),
      ).toBe("CONFLICT:PROCEEDING_ALREADY_OPEN");
      // Corrective actions may run in parallel.
      expect(
        outcome(
          await cs.openProceeding(manager, {
            caseId: case1,
            proceedingType: "CORRECTIVE_ACTION",
            parentProceedingId: proceeding,
            reason: REASON,
          }),
        ),
      ).toBe("ok");
      // A committee proceeding opens only from a referral.
      expect(
        outcome(
          await cs.openProceeding(manager, {
            caseId: case1,
            proceedingType: "COMMITTEE_INVESTIGATION",
            reason: REASON,
          }),
        ),
      ).toBe("fieldErrors");

      const suspension = STATUS_CODES.SUSPENSION_REASON[0];
      expect(
        outcome(
          await cs.updateProceedingState(manager, {
            proceedingId: proceeding,
            status: "SUSPENDED",
            suspensionReason: suspension,
            waitingReason: "",
            reason: REASON,
          }),
        ),
      ).toBe("ok");
      expect(
        outcome(
          await cs.updateProceedingState(manager, {
            proceedingId: proceeding,
            status: "IN_PROGRESS",
            suspensionReason: suspension,
            reason: REASON,
          }),
        ),
      ).toBe("fieldErrors");

      // Concluded needs an outcome; DEC-F10 outcomes are not offered; a parent with an open child stays open.
      const close = (status: string, outcomeCode = "") =>
        cs.closeProceeding(manager, { proceedingId: proceeding, status, outcomeCode, reason: REASON });
      expect(outcome(await close("CONCLUDED"))).toBe("fieldErrors");
      expect(outcome(await close("CONCLUDED", "NOT_FEASIBLE"))).toBe("fieldErrors");
      expect(outcome(await close("CANCELLED"))).toBe("CONFLICT:OPEN_CHILD_PROCEEDINGS");

      const after = await cs.structure(manager, case1);
      expect(after.proceedings.find((p) => p.id === proceeding)).toMatchObject({
        status: "SUSPENDED",
        suspensionReason: suspension,
        waitingReason: null,
      });
      const child = after.proceedings.find((p) => p.proceedingType === "CORRECTIVE_ACTION")!;
      expect(child.parentProceedingId).toBe(proceeding);
      expect(
        outcome(
          await cs.closeProceeding(manager, { proceedingId: child.id, status: "CANCELLED", reason: REASON }),
        ),
      ).toBe("ok");
      expect(outcome(await close("CANCELLED"))).toBe("ok");
      expect(outcome(await close("CANCELLED"))).toBe("CONFLICT:PROCEEDING_CLOSED");

      // No finding in a closed proceeding.
      expect(
        outcome(
          await cs.recordFinding(ctxFor("investigatorA"), {
            allegationId: after.allegations[0]!.id,
            proceedingId: proceeding,
            result: "SUBSTANTIATED",
            rationale: "Synthetic: too late for this proceeding.",
          }),
        ),
      ).toBe("INVALID:proceeding_id");
    });
  });

  it("a team member who does not edit is refused, an outsider gets not-found, and both are recorded", async () => {
    const case1 = await caseId("0001");
    await ownerScenario(async (s) => {
      const cs = structureIn(s);
      const investigator = ctxFor("investigatorA");
      expect(
        outcome(
          await cs.addSubject(investigator, {
            caseId: case1,
            displayLabel: "Employee Lambda (synthetic)",
            subjectCategory: "EMPLOYEE",
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(
        outcome(
          await cs.openProceeding(investigator, {
            caseId: case1,
            proceedingType: "INVESTIGATION",
            reason: REASON,
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(await denials(s, investigator.requestId)).toEqual([
        "add_case_subject:FORBIDDEN",
        "open_proceeding:FORBIDDEN",
      ]);

      // The SOC analyst has no access to the case: the same answer as a case that does not exist.
      const outsider = ctxFor("soc");
      const allegation = (await cs.structure(ctxFor("caseManager"), case1)).allegations[0]!;
      expect(
        outcome(
          await cs.addAllegation(outsider, {
            caseId: case1,
            category: "POLICY_BREACH",
            description: "Synthetic: should never be stored.",
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(
        outcome(
          await cs.recordFinding(outsider, {
            allegationId: allegation.id,
            proceedingId: randomUUID(),
            result: "SUBSTANTIATED",
            rationale: "Synthetic: should never be stored.",
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(
        outcome(
          await cs.addAllegation(outsider, {
            caseId: randomUUID(),
            category: "POLICY_BREACH",
            description: "Synthetic: a case that does not exist.",
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(await denials(s, outsider.requestId)).toEqual([
        "add_allegation:NOT_FOUND",
        "record_finding:NOT_FOUND",
        "add_allegation:NOT_FOUND",
      ]);
      // Nothing about the case reaches them through the read either.
      const seen = await cs.structure(outsider, case1);
      expect(seen).toMatchObject({
        proceedings: [],
        subjects: [],
        allegations: [],
        findings: [],
        committeeProceedings: [],
        referralApprovals: [],
        findingsVisible: false,
        canRecordFindings: false,
      });
    });
  });

  it("a restricted case is referred only after its authority approves, once; the committee arrives as counts", async () => {
    const case3 = await caseId("0003"); // SECRET, restricted, owned by the GRC Director (an eligible authority)
    const case1 = await caseId("0001");
    const { ic } = await committeeIds();
    await ownerScenario(async (s) => {
      // Chair and secretary are cleared to CONFIDENTIAL only; the GRC Deputy (SECRET) sits as a member.
      await seat(s, ic, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["grcDeputy", "MEMBER"],
      ]);
      const cs = structureIn(s);
      const owner = ctxFor("grcDirector");
      const refer = () => cs.referToCommittee(owner, { caseId: case3, committeeId: ic, reason: REASON });
      expect(outcome(await refer())).toBe("CONFLICT:AUTHORITY_APPROVAL_REQUIRED");

      // Someone who cannot see the case cannot approve it; a case that is not restricted needs no approval.
      expect(
        outcome(
          await cs.approveRestrictedReferral(ctxFor("caseManager"), {
            caseId: case3,
            committeeId: ic,
            reason: REASON,
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(
        outcome(
          await cs.approveRestrictedReferral(ctxFor("caseManager"), {
            caseId: case1,
            committeeId: ic,
            reason: REASON,
          }),
        ),
      ).toBe("CONFLICT:CASE_NOT_RESTRICTED");

      const approval = value<string>(
        await cs.approveRestrictedReferral(owner, { caseId: case3, committeeId: ic, reason: REASON }),
      );
      expect(
        outcome(
          await cs.approveRestrictedReferral(owner, { caseId: case3, committeeId: ic, reason: REASON }),
        ),
      ).toBe("CONFLICT:APPROVAL_ALREADY_PENDING");
      const pending = await cs.structure(owner, case3);
      expect(pending.referralApprovals).toEqual([
        expect.objectContaining({
          id: approval,
          committeeId: ic,
          approvedByName: "GRC Director Zeta",
          usedAt: null,
          committeeProceedingId: null,
        }),
      ]);

      // The approval alone does not refer the case: its preliminary review has not referred it (AMB-018, 2030).
      expect(pending.preliminaryReferral).toBe("AWAITED");
      expect(outcome(await refer())).toBe("CONFLICT:PRELIMINARY_REFERRAL_REQUIRED");
      await preliminaryReferral(s, case3);
      expect((await cs.structure(owner, case3)).preliminaryReferral).toBe("REFERRED");

      const committeeProceeding = value<string>(await refer());
      // The approval is used up: a second referral would need a new one.
      const after = await cs.structure(owner, case3);
      expect(after.referralApprovals[0]).toMatchObject({ committeeProceedingId: committeeProceeding });
      expect(after.referralApprovals[0]!.usedAt).not.toBeNull();
      expect(after.proceedings).toEqual([
        expect.objectContaining({
          sequenceNo: 1,
          proceedingType: "PRELIMINARY_REVIEW",
          status: "CONCLUDED",
          outcomeCode: "REFERRED_TO_COMMITTEE",
        }),
        expect.objectContaining({ sequenceNo: 2, proceedingType: "COMMITTEE_INVESTIGATION", status: "OPEN" }),
      ]);

      await s.asOwner();
      const [rule] = await s.tx<
        {
          quorumType: string;
          quorumValue: number | null;
          castingVoteEnabled: boolean;
          minutesReviewBusinessDays: number;
          deemedApprovalEnabled: boolean;
          sourceStatus: string;
        }[]
      >`
        select quorum_type as "quorumType", quorum_value::float as "quorumValue",
               casting_vote_enabled as "castingVoteEnabled",
               minutes_review_business_days as "minutesReviewBusinessDays",
               deemed_approval_enabled as "deemedApprovalEnabled", source_status as "sourceStatus"
        from committee.rule_set where committee_id = ${ic} and effective_from <= now()
          and (effective_to is null or effective_to > now())`;
      expect(after.committeeProceedings).toEqual([
        {
          id: committeeProceeding,
          proceedingId: after.proceedings[1]!.id,
          committeeId: ic,
          status: "OPEN",
          referredAt: expect.any(String),
          rules: rule,
          seats: [
            { seat: "CHAIR", count: 1 },
            { seat: "SECRETARY", count: 1 },
            { seat: "MEMBER", count: 1 },
          ],
          voting: 1,
          firewallRestricted: 0,
          // Not cleared for a SECRET case (DEC-F19): recorded, with no access, and counted, never named.
          notCleared: 2,
        },
      ]);
      const text = JSON.stringify(after);
      for (const member of ["committeeChair", "committeeSecretary", "grcDeputy"] as const)
        expect(text).not.toContain(USERS[member]);
    });
  });

  it("the read says what the preliminary review leaves for the referral, as the database decides it (AMB-018)", async () => {
    const case1 = await caseId("0001");
    const { ic } = await committeeIds();
    await ownerScenario(async (s) => {
      await seat(s, ic, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["legal", "MEMBER"],
      ]);
      const cs = structureIn(s);
      const manager = ctxFor("caseManager");
      const refer = () => cs.referToCommittee(manager, { caseId: case1, committeeId: ic, reason: REASON });
      const read = async () => (await cs.structure(manager, case1)).preliminaryReferral;

      // No preliminary review yet: the referral waits for it, and the database refuses it.
      expect(await read()).toBe("AWAITED");
      expect(outcome(await refer())).toBe("CONFLICT:PRELIMINARY_REFERRAL_REQUIRED");

      // An approved recommendation with another outcome does not refer the case either.
      await s.as("grcDirector");
      const [other] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${case1}, 'NOT_SERIOUS',
          'Synthetic: not serious enough for the committee.') as id`;
      await s.as("grcSectorHead");
      await s.tx`select api.approve_preliminary_recommendation(${other!.id}, 'APPROVE', null, null)`;
      expect(await read()).toBe("AWAITED");
      expect(outcome(await refer())).toBe("CONFLICT:PRELIMINARY_REFERRAL_REQUIRED");

      // Once the latest approved recommendation refers the case, the read and the database agree.
      await preliminaryReferral(s, case1);
      expect(await read()).toBe("REFERRED");
      expect(outcome(await refer())).toBe("ok");
    });
  });

  it("a direct referral or grievance needs no preliminary review (AMB-018, Q4, Q41)", async () => {
    const case1 = await caseId("0001");
    const { ic } = await committeeIds();
    await ownerScenario(async (s) => {
      await seat(s, ic, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["legal", "MEMBER"],
      ]);
      // Test setup only, rolled back with the test: the table owner records the case as a direct referral.
      await s.asOwner();
      await s.tx`update case_mgmt.case_record set source_type = 'DIRECT_REFERRAL' where id = ${case1}`;
      const cs = structureIn(s);
      const manager = ctxFor("caseManager");
      expect((await cs.structure(manager, case1)).preliminaryReferral).toBe("NOT_REQUIRED");
      expect(
        outcome(await cs.referToCommittee(manager, { caseId: case1, committeeId: ic, reason: REASON })),
      ).toBe("ok");
      // Nothing about it reaches someone who cannot see the case.
      expect((await cs.structure(ctxFor("soc"), case1)).preliminaryReferral).toBe("AWAITED");
    });
  });
});
