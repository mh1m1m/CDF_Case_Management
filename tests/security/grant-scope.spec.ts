// S3 purpose-bound grant scope (UX redesign; ADR-016 D2 and D3; DEC-02 and DEC-03 approved 2026-10-11;
// migration 20261007002020). A grant opens the case file only within its purpose: CASE and AUDIT always, TRIAGE only
// before hand-over, COMMITTEE and REVIEW never. Hand-over ends triage access in the same transaction. Legacy committee
// and review grants are narrowed to the in-flight form instances their holders work on (interim path (a)), never
// the case. Every test talks to the database as the BFF does, so the rules hold even when the UI is bypassed.
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import {
  USERS,
  caseId,
  ownerScenario,
  scenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";

let caseA: string, caseB: string, caseExec: string, caseD: string;
beforeAll(async () => {
  [caseA, caseB, caseExec, caseD] = await Promise.all([
    caseId("0001"),
    caseId("0002"),
    caseId("0003"),
    caseId("0004"),
  ]);
});

const COMMITTEE_FORMATION = {
  formation_reference: "CDF-DEMO-COMMITTEE-0002",
  formation_date: "2026-03-01",
  chair: "Committee Chair Xi",
  members: "Committee Member Epsilon",
  secretary: "Committee Secretary Nu",
  scope: "Synthetic committee scope for the grant-scope suite.",
  independence_confirmed: "true",
};
const REASON = "Synthetic: grant scope suite.";

async function start(tx: Tx, target: string, code: string): Promise<string> {
  const [row] = await tx<
    { id: string }[]
  >`select api.start_form(${target}, ${code}, 'CONFIDENTIAL'::core.classification_level) as id`;
  return row!.id;
}
const save = (tx: Tx, id: string, data: unknown) =>
  tx`select * from api.save_form_draft(${id}, ${tx.json(data as never)})`;
const prepare = (tx: Tx, id: string) => tx`select api.prepare_form(${id})`;
/** api.open_case and api.open_form_instance answer false for anything the caller may not open (the BFF's 404). */
async function openCase(tx: Tx, id: string): Promise<boolean> {
  const [r] = await tx<{ ok: boolean }[]>`select api.open_case(${id}) as ok`;
  return r!.ok;
}
async function openForm(tx: Tx, id: string): Promise<boolean> {
  const [r] = await tx<{ ok: boolean }[]>`select api.open_form_instance(${id}) as ok`;
  return r!.ok;
}

/** The form instances of a case the caller can see, by id. */
async function formsSeen(tx: Tx, target: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`select id from forms.form_instance where case_id = ${target}`;
  return rows.map((r) => r.id).sort();
}

/** Everything of a case's file the caller can read, as row counts. */
async function caseFile(tx: Tx, target: string) {
  const [r] = await tx<Record<string, number>[]>`
    select (select count(*)::int from case_mgmt.case_record where id = ${target}) as "case",
           (select count(*)::int from case_mgmt.allegation where case_id = ${target}) as allegations,
           (select count(*)::int from case_mgmt.case_assignment where case_id = ${target}) as team,
           (select count(*)::int from case_mgmt.case_access_grant where case_id = ${target}) as grants,
           (select count(*)::int from evidence.evidence where case_id = ${target}) as evidence,
           (select count(*)::int from case_mgmt.interview where case_id = ${target}) as interviews,
           (select count(*)::int from case_mgmt.finding where case_id = ${target}) as findings,
           (select count(*)::int from case_mgmt.proceeding where case_id = ${target}) as proceedings`;
  return r!;
}
const NOTHING = {
  case: 0,
  allegations: 0,
  team: 0,
  grants: 0,
  evidence: 0,
  interviews: 0,
  findings: 0,
  proceedings: 0,
};

/** The case file is closed to the caller: the uniform not-found, and no row of it is readable. */
async function expectNoCaseFile(s: Scenario, user: UserKey, target: string) {
  await s.as(user);
  expect(await openCase(s.tx, target), user).toBe(false);
  expect(await caseFile(s.tx, target), user).toEqual(NOTHING);
}

/**
 * A grant made before S3, which no command can create today: inserted as the table owner (TRIAGE directly; COMMITTEE
 * and REVIEW through a CASE row whose scope is then rewritten, since the insert guard refuses those scopes).
 */
async function legacyGrant(s: OwnerScenario, target: string, user: UserKey, scope: string): Promise<string> {
  await s.asOwner();
  const [g] = await s.tx<{ id: string }[]>`
    insert into case_mgmt.case_access_grant (case_id, user_id, scope, reason, granted_by)
    values (${target}, ${USERS[user]}, ${scope === "TRIAGE" ? "TRIAGE" : "CASE"}, 'Synthetic: grant made before S3',
            ${USERS.grcDirector})
    returning id`;
  if (scope !== "TRIAGE")
    await s.tx`update case_mgmt.case_access_grant set scope = ${scope} where id = ${g!.id}`;
  return g!.id;
}

async function reconcile(s: OwnerScenario): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`select case_mgmt.reconcile_grant_scope() as n`;
  return r!.n;
}

describe("a grant opens the case file only within its purpose (DEC-02, DEC-03)", () => {
  it("COMMITTEE, REVIEW and post-hand-over TRIAGE grants open nothing, even before reconciliation", async () => {
    await ownerScenario(async (s) => {
      await legacyGrant(s, caseA, "committeeChair", "COMMITTEE");
      await legacyGrant(s, caseA, "legal", "REVIEW");
      await legacyGrant(s, caseA, "triage", "TRIAGE"); // case A is past hand-over (INVESTIGATION)
      for (const user of ["committeeChair", "legal", "triage"] as const) {
        await expectNoCaseFile(s, user, caseA);
        expect(await formsSeen(s.tx, caseA), user).toEqual([]);
      }
      // A CASE grant opens the file; so does TRIAGE while the case is still in the triage stages.
      await s.as("caseManager");
      await s.tx`select api.grant_case_access(${caseA}, ${USERS.committee}, 'CASE', ${REASON}, null)`;
      await s.as("committee");
      expect((await caseFile(s.tx, caseA)).case).toBe(1);
      await s.as("triage");
      expect((await caseFile(s.tx, caseD)).case).toBe(1); // case D is REGISTERED: before hand-over
    });
  });

  it("refuses new COMMITTEE and REVIEW grants, in the command and at the table", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      for (const scope of ["COMMITTEE", "REVIEW", "TRIAGE", "ANYTHING"])
        await s.expectError(
          "CDF_INVALID:scope",
          (tx) =>
            tx`select api.grant_case_access(${caseA}, ${USERS.committeeChair}, ${scope}, ${REASON}, null)`,
        );
      // Defence in depth: not even the table owner can insert one.
      await s.asOwner();
      for (const scope of ["COMMITTEE", "REVIEW"])
        await s.expectError(
          "CDF_INVALID:scope",
          (tx) => tx`
            insert into case_mgmt.case_access_grant (case_id, user_id, scope, reason, granted_by)
            values (${caseA}, ${USERS.committeeChair}, ${scope}, 'Synthetic: refused', ${USERS.grcDirector})`,
        );
    });
  });

  it("shows findings only with a case-file basis: never through a TRIAGE grant", async () => {
    await ownerScenario(async (s) => {
      // A finding on case D, which triage still sees through its TRIAGE grant (the case is before hand-over).
      await s.asOwner();
      const [p] = await s.tx<{ id: string }[]>`
        select (case_mgmt.insert_proceeding(${caseD}, 'PRELIMINARY_REVIEW', null, ${USERS.grcDirector})).id as id`;
      await s.tx`
        insert into case_mgmt.finding (case_id, allegation_id, proceeding_id, version_no, result, rationale, recorded_by)
        select ${caseD}, a.id, ${p!.id}, 1, 'INCONCLUSIVE', 'Synthetic: finding for the scope suite.', ${USERS.grcDirector}
          from case_mgmt.allegation a where a.case_id = ${caseD} limit 1`;
      await s.as("triage");
      const triage = await caseFile(s.tx, caseD);
      expect(triage.case).toBe(1);
      expect(triage.findings).toBe(0);
      for (const user of ["caseManager", "investigatorB", "grcDirector"] as const) {
        await s.as(user);
        expect((await caseFile(s.tx, caseD)).findings, user).toBe(1);
      }
    });
  });
});

describe("hand-over ends triage access in the same transaction (DEC-03)", () => {
  async function triageGrant(tx: Tx, target: string) {
    const [g] = await tx<
      { id: string; status: string; revoked_at: Date | null; effective_to: Date | null }[]
    >`
      select id, status, revoked_at, effective_to from case_mgmt.case_access_grant
       where case_id = ${target} and user_id = ${USERS.triage} and scope = 'TRIAGE'
       order by granted_at desc limit 1`;
    return g!;
  }
  async function revokedEvents(tx: Tx, grantId: string) {
    return tx<{ actor_id: string | null; actor_type: string; metadata: Record<string, string> }[]>`
      select actor_id, actor_type, metadata from audit.audit_event
       where action = 'CASE_ACCESS_REVOKED' and object_id = ${grantId}`;
  }

  it("COMPLETE_TRIAGE ends the grant, audited once, and triage loses the case file", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const before = await triageGrant(s.tx, caseD);
      expect(before.status).toBe("ACTIVE");
      await s.as("triage");
      expect((await caseFile(s.tx, caseD)).case).toBe(1);
      await s.tx`select api.transition_case(${caseD}, 'START_SCREENING', null)`;
      await s.tx`select api.transition_case(${caseD}, 'COMPLETE_SCREENING', null)`;
      await s.as("caseManager");
      await s.tx`select api.update_case_details(${caseD}, c.title, c.summary, 'HIGH', c.row_version)
                   from case_mgmt.case_record c where c.id = ${caseD}`;
      await s.tx`select api.declare_conflict(${caseD}, false, 'Synthetic: no relationship with the parties.')`;
      await s.tx`select api.transition_case(${caseD}, 'CLEAR_CONFLICT_CHECK', null)`;
      // Still in the triage stages: the grant holds.
      await s.as("triage");
      expect((await caseFile(s.tx, caseD)).case).toBe(1);
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseD}, 'COMPLETE_TRIAGE', null)`;

      await expectNoCaseFile(s, "triage", caseD);
      expect(await formsSeen(s.tx, caseD)).toEqual([]);
      await s.asOwner();
      const after = await triageGrant(s.tx, caseD);
      // Ended, never deleted: same row, REVOKED with its time; the original period stays on the row.
      expect(after.id).toBe(before.id);
      expect(after.status).toBe("REVOKED");
      expect(after.revoked_at).not.toBeNull();
      expect(after.effective_to).toEqual(before.effective_to);
      const events = await revokedEvents(s.tx, before.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.actor_id).toBe(USERS.caseManager);
      expect(events[0]!.metadata).toMatchObject({
        basis: "HANDOVER",
        transition: "COMPLETE_TRIAGE",
        scope: "TRIAGE",
        user_id: USERS.triage,
      });
    });
  });

  it("SCREEN_OUT is a hand-over too: closing at screening ends triage access", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const before = await triageGrant(s.tx, caseB); // case B is in SCREENING
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', 'Synthetic: screened out for the scope suite.')`;
      await expectNoCaseFile(s, "triage", caseB);
      await s.asOwner();
      expect((await triageGrant(s.tx, caseB)).status).toBe("REVOKED");
      const events = await revokedEvents(s.tx, before.id);
      expect(events.map((e) => e.metadata.transition)).toEqual(["SCREEN_OUT"]);
    });
  });

  it("hands a restricted case over only to a receiving owner who can open it", async () => {
    await ownerScenario(async (s) => {
      // Case 0003 is restricted and SECRET. Remove its owner and the director's CASE grant, and let a case manager
      // cleared for it act through a TRIAGE grant only (the director holds no workflow permission): nobody would
      // receive the case.
      await s.asOwner();
      await s.tx`update case_mgmt.case_assignment set status = 'ENDED', ended_at = now(), ended_by = ${USERS.grcDirector},
                   end_reason = 'Synthetic: owner removed for the suite' where case_id = ${caseExec}`;
      await s.tx`update case_mgmt.case_access_grant set status = 'REVOKED', revoked_at = now(),
                   revoked_by = ${USERS.grcDirector}, revocation_reason = 'Synthetic: removed for the suite'
                 where case_id = ${caseExec} and scope = 'CASE'`;
      await s.tx`update iam.user_profile set clearance = 'SECRET' where id = ${USERS.caseManager}`;
      await legacyGrant(s, caseExec, "caseManager", "TRIAGE");
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseExec}, 'START_SCREENING', null)`;
      const screenOut = (tx: Tx) =>
        tx`select api.transition_case(${caseExec}, 'SCREEN_OUT', 'Synthetic: screened out for the scope suite.')`;
      await s.expectError("CDF_CONFLICT:HANDOVER_NO_RECEIVING_OWNER", screenOut);
      // A CASE grant to someone the case gate refuses (CONFIDENTIAL clearance, SECRET case) is no receiving owner.
      await legacyGrant(s, caseExec, "lead", "CASE");
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:HANDOVER_NO_RECEIVING_OWNER", screenOut);
      // A cleared receiving owner: the hand-over goes through and every TRIAGE grant on the case ends.
      await legacyGrant(s, caseExec, "grcDeputy", "CASE");
      await s.as("caseManager");
      await screenOut(s.tx);
      await s.asOwner();
      const [left] = await s.tx<{ n: number }[]>`
        select count(*)::int as n from case_mgmt.case_access_grant
         where case_id = ${caseExec} and scope = 'TRIAGE' and status = 'ACTIVE'`;
      expect(left!.n).toBe(0);
      await expectNoCaseFile(s, "caseManager", caseExec);
      await s.as("grcDeputy");
      expect((await caseFile(s.tx, caseExec)).case).toBe(1);
    });
  });
});

describe("reconciliation narrows legacy grants to in-flight forms, never the case (DEC-02, path (a))", () => {
  /**
   * Forms on case A, made by the people who prepare them, as they would have been before S3. Other suites leave
   * committed forms on the seed cases, so assertions look only at these (`mine`).
   */
  async function formsOnCaseA(s: OwnerScenario) {
    await s.as("caseManager");
    const f13prepared = await start(s.tx, caseA, "WB-FRM-13");
    await save(s.tx, f13prepared, COMMITTEE_FORMATION);
    await prepare(s.tx, f13prepared);
    const f13draft = await start(s.tx, caseA, "WB-FRM-13");
    const f15draft = await start(s.tx, caseA, "WB-FRM-15");
    const f15withdrawn = await start(s.tx, caseA, "WB-FRM-15");
    await s.tx`select api.withdraw_form(${f15withdrawn}, 'Synthetic: started by mistake.')`;
    await s.as("investigatorA");
    const f12 = await start(s.tx, caseA, "WB-FRM-12");
    const f11 = await start(s.tx, caseA, "WB-FRM-11"); // investigation form: no committee or legal entitlement
    const all = [f13prepared, f13draft, f15draft, f15withdrawn, f12, f11];
    const mine = (ids: string[]) => ids.filter((id) => all.includes(id)).sort();
    return { f13prepared, f13draft, f15draft, f15withdrawn, f12, f11, mine };
  }

  it("ends every over-purpose grant with a report row and a SYSTEM audit event, once", async () => {
    await ownerScenario(async (s) => {
      const f = await formsOnCaseA(s);
      const grants = {
        chair: await legacyGrant(s, caseA, "committeeChair", "COMMITTEE"),
        secretary: await legacyGrant(s, caseA, "committeeSecretary", "COMMITTEE"),
        legal: await legacyGrant(s, caseA, "legal", "REVIEW"),
        // A SECRET case: nothing on it is within the member's CONFIDENTIAL clearance, so nothing is kept.
        member: await legacyGrant(s, caseExec, "committee", "COMMITTEE"),
        triage: await legacyGrant(s, caseA, "triage", "TRIAGE"), // case A is past hand-over
      };
      const ids = Object.values(grants);
      expect(await reconcile(s)).toBe(ids.length);

      const report = await s.tx<
        { grant_id: string; outcome: string; kept: number; before_status: string; after_status: string }[]
      >`select grant_id, outcome, form_instances_kept as kept, before_status, after_status
          from case_mgmt.grant_scope_reconciliation where grant_id in ${s.tx(ids)}`;
      const byGrant = Object.fromEntries(report.map((r) => [r.grant_id, r]));
      const kept = await s.tx<{ grant: string; instance: string }[]>`
        select source_grant_id as grant, instance_id as instance
          from case_mgmt.form_instance_access where source_grant_id in ${s.tx(ids)}`;
      const keptFor = (g: string) => kept.filter((k) => k.grant === g).map((k) => k.instance);
      // Each holder keeps the in-flight forms its roles may view: never the withdrawn one, never the investigation
      // form, never a form outside its entitlement.
      expect(f.mine(keptFor(grants.chair))).toEqual(f.mine([f.f13prepared, f.f13draft, f.f15draft]));
      expect(f.mine(keptFor(grants.secretary))).toEqual(f.mine([f.f13prepared, f.f13draft]));
      expect(f.mine(keptFor(grants.legal))).toEqual(f.mine([f.f12, f.f15draft]));
      expect(keptFor(grants.member)).toEqual([]);
      expect(keptFor(grants.triage)).toEqual([]);
      // The report counts exactly what was kept, and names the outcome by it.
      expect(report).toHaveLength(ids.length);
      for (const r of report) {
        expect([r.before_status, r.after_status]).toEqual(["ACTIVE", "REVOKED"]);
        expect(r.kept).toBe(keptFor(r.grant_id).length);
        expect(r.outcome).toBe(r.kept > 0 ? "NARROWED_TO_FORM_INSTANCES" : "ENDED");
      }
      expect([grants.member, grants.triage].map((g) => byGrant[g]!.outcome)).toEqual(["ENDED", "ENDED"]);

      // Ended, never deleted; one SYSTEM CASE_ACCESS_REVOKED event per grant, codes and ids only.
      const rows = await s.tx<
        { id: string; status: string; revoked_at: Date | null; revoked_by: string | null }[]
      >`
        select id, status, revoked_at, revoked_by from case_mgmt.case_access_grant where id in ${s.tx(ids)}`;
      expect(rows).toHaveLength(ids.length);
      for (const g of rows)
        expect([g.status, g.revoked_at !== null, g.revoked_by]).toEqual(["REVOKED", true, null]);
      const events = await s.tx<{ object_id: string; actor_type: string; basis: string; event_id: string }[]>`
        select e.object_id, e.actor_type, e.metadata ->> 'basis' as basis, e.event_id
          from audit.audit_event e where e.action = 'CASE_ACCESS_REVOKED' and e.object_id in ${s.tx(ids)}`;
      expect(events.map((e) => e.object_id).sort()).toEqual([...ids].sort());
      for (const e of events)
        expect([e.actor_type, e.basis]).toEqual(["SYSTEM", "GRANT_SCOPE_RECONCILIATION"]);
      const [linked] = await s.tx<{ n: number }[]>`
        select count(*)::int as n from case_mgmt.grant_scope_reconciliation r
          join audit.audit_event e on e.event_id = r.audit_event_id and e.object_id = r.grant_id::text
         where r.grant_id in ${s.tx(ids)}`;
      expect(linked!.n).toBe(ids.length);

      // Idempotent: a second run finds nothing.
      expect(await reconcile(s)).toBe(0);
    });
  });

  it("lets each holder do exactly their part on a kept form, and nothing else of the case", async () => {
    await ownerScenario(async (s) => {
      const f = await formsOnCaseA(s);
      await legacyGrant(s, caseA, "committeeChair", "COMMITTEE");
      await legacyGrant(s, caseA, "committeeSecretary", "COMMITTEE");
      await legacyGrant(s, caseA, "legal", "REVIEW");
      await reconcile(s);

      // The case file stays closed to all three, whatever they keep.
      for (const user of ["committeeChair", "committeeSecretary", "legal"] as const)
        await expectNoCaseFile(s, user, caseA);

      // The chair sees the committee forms it may view (13, 15), reviews the prepared one, and opens nothing else.
      await s.as("committeeChair");
      expect(f.mine(await formsSeen(s.tx, caseA))).toEqual([f.f13prepared, f.f13draft, f.f15draft].sort());
      for (const other of [f.f11, f.f12, f.f15withdrawn]) expect(await openForm(s.tx, other)).toBe(false);
      await s.tx`select api.review_form(${f.f13prepared}, 'REVIEWED', null)`;
      await s.expectError("CDF_FORBIDDEN", (tx) => save(tx, f.f13draft, COMMITTEE_FORMATION)); // not a preparer
      await s.expectError("CDF_NOT_FOUND", (tx) => start(tx, caseA, "WB-FRM-13")); // starting stays case-level

      // The secretary completes and prepares the kept draft (13 only; 15 is not theirs to view).
      await s.as("committeeSecretary");
      expect(f.mine(await formsSeen(s.tx, caseA))).toEqual([f.f13prepared, f.f13draft].sort());
      await save(s.tx, f.f13draft, COMMITTEE_FORMATION);
      await prepare(s.tx, f.f13draft);
      await s.expectError("CDF_NOT_FOUND", (tx) => save(tx, f.f15draft, {}));
      await s.expectError("CDF_NOT_FOUND", (tx) => start(tx, caseA, "WB-FRM-14"));

      // The legal reviewer reads its forms (12, 15) and changes nothing.
      await s.as("legal");
      expect(f.mine(await formsSeen(s.tx, caseA))).toEqual([f.f12, f.f15draft].sort());
      await s.expectError("CDF_FORBIDDEN", (tx) => save(tx, f.f12, {}));
      await s.expectError("CDF_FORBIDDEN", (tx) => save(tx, f.f15draft, {}));

      // Access ends by itself: the approved form leaves the chair and the secretary; the withdrawn draft leaves
      // the chair and the legal reviewer.
      await s.as("grcDirector");
      await s.tx`select api.approve_form(${f.f13prepared}, 'APPROVED', null)`;
      await s.as("caseManager");
      await s.tx`select api.withdraw_form(${f.f15draft}, 'Synthetic: no longer needed.')`;
      await s.as("committeeChair");
      expect(f.mine(await formsSeen(s.tx, caseA))).toEqual([f.f13draft]);
      await s.as("committeeSecretary");
      expect(f.mine(await formsSeen(s.tx, caseA))).toEqual([f.f13draft]);
      await s.as("legal");
      expect(f.mine(await formsSeen(s.tx, caseA))).toEqual([f.f12]);
    });
  });

  it("keeps nothing past the case gate: a conflict closes the kept forms too", async () => {
    await ownerScenario(async (s) => {
      const f = await formsOnCaseA(s);
      await legacyGrant(s, caseA, "committeeChair", "COMMITTEE");
      await reconcile(s);
      await s.as("committeeChair");
      expect(f.mine(await formsSeen(s.tx, caseA))).toHaveLength(3);
      // A confirmed conflict of the chair on case A (a fixture: without the case the chair cannot declare one) closes
      // the kept forms; the rows stay (DEC-F38: suspend, not delete).
      await s.asOwner();
      await s.tx`
        insert into case_mgmt.conflict_check (case_id, user_id, status, declaration, decided_by, decided_at, decision_reason)
        values (${caseA}, ${USERS.committeeChair}, 'CONFLICT_CONFIRMED', 'Synthetic: related to a party.',
                ${USERS.caseManager}, now(), 'Synthetic: confirmed.')`;
      await s.as("committeeChair");
      expect(await formsSeen(s.tx, caseA)).toEqual([]);
      expect(await openForm(s.tx, f.f13prepared)).toBe(false);
      await s.asOwner();
      const rows = await s.tx<{ instance_id: string }[]>`
        select instance_id from case_mgmt.form_instance_access where user_id = ${USERS.committeeChair}`;
      expect(f.mine(rows.map((r) => r.instance_id))).toHaveLength(3); // kept rows stay as the record
    });
  });

  it("keeps the narrowed access and its report immutable and unreadable to application roles", async () => {
    await ownerScenario(async (s) => {
      await formsOnCaseA(s);
      await legacyGrant(s, caseA, "committeeChair", "COMMITTEE");
      await reconcile(s);
      await s.asOwner();
      for (const table of ["form_instance_access", "grant_scope_reconciliation"] as const) {
        await s.expectError("case_mgmt." + table, (tx) => tx`update case_mgmt.${tx(table)} set id = id`);
        await s.expectError("case_mgmt." + table, (tx) => tx`delete from case_mgmt.${tx(table)}`);
      }
      for (const user of ["committeeChair", "grcDirector", "platformAdmin"] as const) {
        await s.as(user);
        for (const table of ["form_instance_access", "grant_scope_reconciliation"] as const)
          await s.expectError("permission denied", (tx) => tx`select count(*) from case_mgmt.${tx(table)}`);
        await s.expectError("permission denied", (tx) => tx`select case_mgmt.reconcile_grant_scope()`);
      }
    });
  });

  it("shows kept forms in My Work, My access and the case roster, without naming the case", async () => {
    await ownerScenario(async (s) => {
      const f = await formsOnCaseA(s);
      await legacyGrant(s, caseA, "committeeChair", "COMMITTEE");
      await legacyGrant(s, caseA, "committeeSecretary", "COMMITTEE");
      await reconcile(s);

      await s.as("committeeChair");
      const chairWork = await s.tx<
        { area: string; category: string; target_id: string; case_id: string | null }[]
      >`
        select area, category, target_id, case_id from api.my_work_items() where target_type = 'FORM_INSTANCE'`;
      const ours = (rows: { target_id: string }[]) => rows.filter((r) => f.mine([r.target_id]).length > 0);
      expect(ours(chairWork)).toEqual([
        { area: "MY_WORK", category: "FORM_TO_REVIEW", target_id: f.f13prepared, case_id: null },
      ]);
      // Whatever else is listed is never an item that names the case.
      expect(chairWork.every((r) => r.case_id === null && r.area === "MY_WORK")).toBe(true);
      // One row per kept form, coded '<form code>:<instance no>'.
      const numbers = await s.tx<{ id: string; code: string }[]>`
        select id, form_code || ':' || instance_no as code from forms.form_instance where case_id = ${caseA}`;
      const code = (id: string) => numbers.find((n) => n.id === id)!.code;
      const ourCodes = new Set(f.mine(numbers.map((n) => n.id)).map(code));
      const chairAccess = await s.tx<
        { basis: string; code: string; case_id: string | null; target_id: string | null }[]
      >`select basis, code, case_id, target_id from api.my_access()`;
      const formRows = chairAccess.filter((r) => r.basis !== "CLEARANCE" && r.basis !== "ROLE");
      expect(formRows.every((r) => r.basis === "FORM_ACCESS" && r.case_id === null)).toBe(true);
      // Each kept form's row leads to that form; no other row carries a target.
      expect(chairAccess.filter((r) => r.basis !== "FORM_ACCESS").every((r) => r.target_id === null)).toBe(
        true,
      );
      const ourAccess = formRows.filter((r) => ourCodes.has(r.code));
      expect(ourAccess.sort((a, b) => (a.code < b.code ? -1 : 1))).toEqual([
        ...[f.f13prepared, f.f13draft, f.f15draft]
          .map((id) => ({ basis: "FORM_ACCESS", code: code(id), case_id: null, target_id: id }))
          .sort((a, b) => (a.code < b.code ? -1 : 1)),
      ]);
      const chairAreas = await s.tx<{ area_code: string }[]>`select area_code from api.my_areas()`;
      expect(chairAreas.map((a) => a.area_code)).toEqual(["MY_WORK"]);

      await s.as("committeeSecretary");
      const secretaryWork = await s.tx<{ category: string; target_id: string }[]>`
        select category, target_id from api.my_work_items() where target_type = 'FORM_INSTANCE'`;
      expect(ours(secretaryWork)).toEqual([{ category: "FORM_TO_COMPLETE", target_id: f.f13draft }]);

      // Those who manage the team see the form-scoped access on the roster; the holder has no roster at all.
      await s.as("caseManager");
      const roster = await s.tx<{ user_id: string; relationship: string; code: string; status: string }[]>`
        select user_id, relationship, code, status from api.case_access_roster(${caseA})
         where relationship = 'FORM_ACCESS' order by user_id, code`;
      const who = (id: string) => (id === USERS.committeeChair ? "chair" : "secretary");
      const ourRoster = roster.filter((r) => ourCodes.has(r.code));
      expect(ourRoster.map((r) => `${who(r.user_id)}:${r.code}:${r.status}`).sort()).toEqual(
        [
          `chair:${code(f.f13prepared)}:ACTIVE`,
          `chair:${code(f.f13draft)}:ACTIVE`,
          `chair:${code(f.f15draft)}:ACTIVE`,
          `secretary:${code(f.f13prepared)}:ACTIVE`,
          `secretary:${code(f.f13draft)}:ACTIVE`,
        ].sort(),
      );
      await s.as("committeeChair");
      expect(await s.tx`select * from api.case_access_roster(${caseA})`).toHaveLength(0);
    });
  });
});

describe("reassignment ends the outgoing investigator's access (AMB-013, T-AMB-005)", () => {
  it("gives the former investigator the uniform not-found on case, evidence and drafts; drafts stay", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const draft = await start(s.tx, caseA, "WB-FRM-11");
      const seen = await caseFile(s.tx, caseA);
      expect(seen.case).toBe(1);
      expect(seen.interviews).toBeGreaterThan(0);
      await s.as("caseManager");
      const [a] = await s.tx<{ id: string }[]>`
        select id from case_mgmt.case_assignment
         where case_id = ${caseA} and user_id = ${USERS.investigatorA} and status = 'ACTIVE'`;
      await s.tx`select api.reassign_case(${a!.id}, ${USERS.investigatorB}, 'Synthetic: workload rebalanced.')`;

      await expectNoCaseFile(s, "investigatorA", caseA);
      expect(await formsSeen(s.tx, caseA)).toEqual([]);
      expect(await openForm(s.tx, draft)).toBe(false);
      await s.expectError("CDF_NOT_FOUND", (tx) => save(tx, draft, {}));
      // The draft stays with the case: the incoming investigator continues it.
      await s.as("investigatorB");
      expect(await formsSeen(s.tx, caseA)).toContain(draft);
      await save(s.tx, draft, { evidence_count: "1" });
    });
  });

  it("leaves an independent relationship in place: a CASE grant survives the reassignment", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.tx`select api.grant_case_access(${caseA}, ${USERS.investigatorA}, 'CASE', ${REASON}, null)`;
      const [a] = await s.tx<{ id: string }[]>`
        select id from case_mgmt.case_assignment
         where case_id = ${caseA} and user_id = ${USERS.investigatorA} and status = 'ACTIVE'`;
      await s.tx`select api.reassign_case(${a!.id}, ${USERS.investigatorB}, 'Synthetic: workload rebalanced.')`;
      await s.as("investigatorA");
      expect((await caseFile(s.tx, caseA)).case).toBe(1);
    });
  });
});
