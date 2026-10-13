// Business architecture rebase, migration 2040 (owner Finalization Set, part 2): decision-notice delivery and the
// grievance window (DEC-F15, DEC-F16), the non-admission decider (DEC-F17), grievance scope, withdrawal, completion and
// contested items (AMB-139, AMB-140, AMB-141, AMB-143), and the fail-safe guards on sanctions and their execution
// (AMB-031, AMB-109, AMB-110, AMB-145, AMB-149). Every step runs through the api.* commands as `authenticated`; the
// owner connection is used only for fixtures (a notice issued in the past, synthetic severity ranks) and to read rows.
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, type OwnerScenario, type Scenario, type UserKey } from "../support/db";
import { REASON, committeeIds, seat } from "../support/committee";
import { decidedForSubjects } from "../support/decision";

const TEXT = "Synthetic: unique-notice-marker-2040 for the subject.";
const GROUNDS = "Synthetic: unique-grounds-marker-2040, the decision ignored my defence.";
const DELIVERY_REF = "HAND-DEMO-2040-unique-delivery-marker";

let caseB: string, ic: string, gc: string;
beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic, gc } = await committeeIds());
});

const GC_SEATS: [UserKey, string][] = [
  ["committee", "CHAIR"],
  ["committeeSecretary", "SECRETARY"],
  ["legal", "MEMBER"],
  ["investigatorA", "MEMBER"],
];

const decisionNotice = async (s: Scenario, subject: string, decision: string) => {
  await s.as("caseManager");
  const [n] = await s.tx<
    { id: string }[]
  >`select api.issue_decision_notice(${subject}, ${decision}, ${TEXT}) as id`;
  return n!.id;
};
async function recordDelivery(s: Scenario, notice: string, agoDays = 0): Promise<string | null> {
  await s.as("caseManager");
  const [r] = await s.tx<{ ends: string | null }[]>`
    select api.record_notice_delivery(${notice}, 'HAND_DELIVERY', now() - make_interval(days => ${agoDays}::int),
      ${DELIVERY_REF}) as ends`;
  return r!.ends;
}
const fileOnNotice = (s: Scenario, notice: string, items: string[] | null = null) =>
  s.tx<{ id: string }[]>`
    select api.file_grievance_on_decision_notice(${notice}, ${GROUNDS}, ${items}::uuid[]) as id`;

/** A DECISION notice issued `days` ago on the DELIVERY basis, not yet delivered (owner fixture: commands issue at now()). */
async function oldDeliveryNotice(
  s: OwnerScenario,
  subject: string,
  decision: string,
  days: number,
): Promise<string> {
  await s.asOwner();
  const [n] = await s.tx<{ id: string }[]>`
    insert into grievance.defence_notice (case_id, subject_id, sequence_no, notice_text, issued_by, issued_at, kind,
                                          authority_decision_id, grievance_rule_set_id, grievance_window_days,
                                          window_start_basis)
    select ${caseB}, ${subject}, 9, ${TEXT}, ${USERS.caseManager}, now() - make_interval(days => ${days}::int), 'DECISION',
           ${decision}, r.id, 30, 'DELIVERY'
    from committee.rule_set r where r.committee_id = ${gc} and r.effective_to is null
    returning id`;
  return n!.id;
}

/** A case B subject linked to `user`'s portal account; returns the subject and link. */
async function portalSubject(s: Scenario, user: UserKey, label: string) {
  await s.as("caseManager");
  const [subj] = await s.tx<{ id: string }[]>`
    select api.add_case_subject(${caseB}, ${label}, 'EMPLOYEE', null) as id`;
  const [l] = await s.tx<{ id: string }[]>`
    select api.link_subject_portal_account(${subj!.id}, ${USERS[user]}, ${REASON}) as id`;
  return { subject: subj!.id, link: l!.id };
}
async function file(s: Scenario, user: UserKey, link: string, contestedAgo = "0 days"): Promise<string> {
  await s.as(user);
  const [g] = await s.tx<{ id: string }[]>`
    select api.file_grievance(${link}, now() - ${contestedAgo}::interval, ${GROUNDS}) as id`;
  return g!.id;
}
const revise = async (s: Scenario, changes: Record<string, unknown>) => {
  await s.as("platformAdmin");
  await s.tx`select api.revise_committee_rule_set(${gc}, now(), ${s.tx.json(changes as never)}, 'APPROVED', ${REASON})`;
};

/** The Grievance Committee approves one vote item in the admitted grievance's proceeding; returns the item. */
async function approvedGrievanceVote(s: Scenario, grievance: string): Promise<string> {
  await s.as("committeeSecretary");
  const [g] = await s.tx<{ cp: string }[]>`
    select committee_proceeding_id as cp from grievance.grievance where id = ${grievance}`;
  const [m] = await s.tx<{ id: string }[]>`
    select api.schedule_meeting(${g!.cp}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
      now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
  const parts = await s.tx<{ id: string; user_id: string }[]>`
    select id, user_id from committee.meeting_participant where meeting_id = ${m!.id} and is_voting`;
  const key = (id: string) => Object.entries(USERS).find(([, v]) => v === id)![0] as UserKey;
  for (const p of parts) {
    await s.as(key(p.user_id));
    await s.tx`select api.declare_meeting_conflict(${p.id}, 'NO_CONFLICT', null)`;
  }
  await s.as("committeeSecretary");
  await s.tx`select api.open_meeting(${m!.id}, ${REASON})`;
  for (const p of parts) await s.tx`select api.record_attendance(${p.id}, 'PRESENT')`;
  const [vi] = await s.tx<{ id: string }[]>`
    select api.open_vote_item(${m!.id}, 'OTHER', null, 'Grievance outcome (synthetic)') as id`;
  for (const p of parts) {
    await s.as(key(p.user_id));
    await s.tx`select api.cast_vote(${vi!.id}, 'APPROVE', null)`;
  }
  await s.as("committeeSecretary");
  await s.tx`select api.close_vote_item(${vi!.id}, null)`;
  return vi!.id;
}

describe("decision-notice delivery and the grievance window (DEC-F15, DEC-F16, AMB-137)", () => {
  it("T-AMB-081: window end = delivery + days; an undelivered notice has no running window", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      const n = await decisionNotice(s, f.sigma, f.decision);
      await s.asOwner();
      const [issued] = await s.tx<Record<string, unknown>[]>`
        select window_start_basis, grievance_window_starts_at, grievance_window_ends_at, grievance_window_days,
               delivered_at from grievance.defence_notice where id = ${n}`;
      expect(issued).toEqual({
        window_start_basis: "DELIVERY",
        grievance_window_starts_at: null,
        grievance_window_ends_at: null,
        grievance_window_days: 30,
        delivered_at: null,
      });

      // The subject sees no window yet, and may still file: accepted, and not late.
      await s.as("employee");
      const [mine] = await s.tx<{ n: Record<string, unknown>[] }[]>`select api.my_defence_notices() as n`;
      expect(mine!.n[0]).toMatchObject({
        notice_id: n,
        delivered_at: null,
        window_start_basis: "DELIVERY",
        grievance_window_ends_at: null,
      });

      // A rule change after issue does not change the basis (DEC-F16): the snapshot stays DELIVERY.
      await revise(s, { grievance_window_start_basis: "ISSUE", grievance_window_days: 10 });

      // Who records the delivery, and what is refused.
      await s.as("investigatorB");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.record_notice_delivery(${n}, 'HAND_DELIVERY', now(), ${DELIVERY_REF})`,
      );
      for (const u of ["investigatorA", "employee", "platformAdmin", "committeeSecretary"] as const) {
        await s.as(u);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.record_notice_delivery(${n}, 'HAND_DELIVERY', now(), ${DELIVERY_REF})`,
        );
      }
      await s.as("caseManager");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.record_notice_delivery(${"00000000-0000-4000-8000-000000000000"}, 'HAND_DELIVERY', now(), ${DELIVERY_REF})`,
      );
      await s.expectError(
        "CDF_INVALID:delivery_method",
        (tx) => tx`select api.record_notice_delivery(${n}, 'PIGEON', now(), ${DELIVERY_REF})`,
      );
      await s.expectError(
        "CDF_INVALID:delivered_at",
        (tx) =>
          tx`select api.record_notice_delivery(${n}, 'HAND_DELIVERY', now() + interval '1 hour', ${DELIVERY_REF})`,
      );
      await s.expectError(
        "CDF_INVALID:delivered_at",
        (tx) =>
          tx`select api.record_notice_delivery(${n}, 'HAND_DELIVERY', now() - interval '1 day', ${DELIVERY_REF})`,
      );
      await s.expectError(
        "CDF_INVALID:delivery_reference",
        (tx) => tx`select api.record_notice_delivery(${n}, 'HAND_DELIVERY', now(), 'x')`,
      );

      await s.as("employee");
      const [g] = await fileOnNotice(s, n);
      await s.asOwner();
      const [filed] = await s.tx<{ is_late: boolean; status: string; window_days: number }[]>`
        select is_late, status, window_days from grievance.grievance where id = ${g!.id}`;
      expect(filed).toEqual({ is_late: false, status: "RECEIVED", window_days: 30 });

      // Delivered now: the window runs 30 days from the delivery, set once.
      const ends = await recordDelivery(s, n);
      expect(ends).not.toBeNull();
      await s.expectError(
        "CDF_CONFLICT:ALREADY_DELIVERED",
        (tx) => tx`select api.record_notice_delivery(${n}, 'EMAIL', now(), ${DELIVERY_REF})`,
      );
      await s.asOwner();
      const [row] = await s.tx<Record<string, unknown>[]>`
        select delivery_method, (grievance_window_ends_at - delivered_at)::text as span,
               grievance_window_starts_at = delivered_at as starts_at_delivery, delivery_recorded_by
        from grievance.defence_notice where id = ${n}`;
      expect(row).toEqual({
        delivery_method: "HAND_DELIVERY",
        span: "30 days",
        starts_at_delivery: true,
        delivery_recorded_by: USERS.caseManager,
      });
      // Nothing rewrites a delivery or a started window, even the owner.
      await s.expectError(
        "defence notice",
        (tx) =>
          tx`update grievance.defence_notice set delivered_at = delivered_at - interval '1 minute' where id = ${n}`,
      );
      await s.expectError(
        "defence notice",
        (tx) =>
          tx`update grievance.defence_notice set grievance_window_ends_at = grievance_window_ends_at + interval '1 day' where id = ${n}`,
      );

      // Audit: ids, codes and dates; never the delivery reference, the notice text or the grounds.
      const events = await s.tx<{ action: string; metadata: Record<string, unknown> }[]>`
        select action, metadata from audit.audit_event where object_id = any(${[n, g!.id]}::text[]) order by seq`;
      const delivered = events.find((e) => e.action === "NOTICE_DELIVERY_RECORDED")!;
      expect(Object.keys(delivered.metadata).sort()).toEqual([
        "delivered_at",
        "delivery_method",
        "kind",
        "subject_id",
        "tasks_closed",
        "window_ends_at",
        "window_start_basis",
        "window_starts_at",
      ]);
      expect(events.find((e) => e.action === "GRIEVANCE_FILED")!.metadata).toMatchObject({
        is_late: false,
        window_started: false,
        authority_decision_id: f.decision,
      });
      expect(JSON.stringify(events)).not.toMatch(/unique-(notice|grounds|delivery)-marker/);
    });
  });

  it("a delivery recorded long after issue still runs the window from the delivery; a filing after it is late", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      const old = await oldDeliveryNotice(s, f.sigma, f.decision, 40);
      await recordDelivery(s, old, 35);
      await s.asOwner();
      const [row] = await s.tx<{ span: string; closed: boolean }[]>`
        select (grievance_window_ends_at - grievance_window_starts_at)::text as span, grievance_window_ends_at < now() as closed
        from grievance.defence_notice where id = ${old}`;
      expect(row).toEqual({ span: "30 days", closed: true });
      await s.as("employee");
      const [g] = await fileOnNotice(s, old);
      await s.asOwner();
      expect(await s.tx`select is_late from grievance.grievance where id = ${g!.id}`).toEqual([
        { is_late: true },
      ]);
    });
  });

  it("an ACKNOWLEDGEMENT-basis notice starts its window when the subject acknowledges it, not at delivery", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      await revise(s, { grievance_window_start_basis: "ACKNOWLEDGEMENT" });
      const n = await decisionNotice(s, f.sigma, f.decision);
      await recordDelivery(s, n);
      await s.asOwner();
      const window = () =>
        s.tx<{ basis: string; ends: string | null; from_ack: boolean | null }[]>`
          select window_start_basis as basis, grievance_window_ends_at as ends,
                 grievance_window_starts_at = acknowledged_at as from_ack
          from grievance.defence_notice where id = ${n}`;
      expect((await window())[0]).toMatchObject({ basis: "ACKNOWLEDGEMENT", ends: null });
      await s.as("employee");
      await s.tx`select api.acknowledge_defence_notice(${n})`;
      await s.asOwner();
      const [after] = await window();
      expect(after!.ends).not.toBeNull();
      expect(after!.from_ack).toBe(true);
    });
  });

  it("DEC-F16: the rule in force at the contested decision applies, falling back to the one at submission", async () => {
    await ownerScenario(async (s) => {
      const sigma = await portalSubject(s, "employee", "Employee Sigma (synthetic)");
      const tau = await portalSubject(s, "employeeB", "Employee Tau (synthetic)");
      const phi = await portalSubject(s, "financeEmployee", "Employee Phi (synthetic)");
      await revise(s, { grievance_window_days: 10, admissibility_decider: "CHAIR" });
      const earlier = await file(s, "employee", sigma.link, "2 days");
      const current = await file(s, "employeeB", tau.link);
      // Contested before any rule set existed: the rule at submission applies.
      await s.as("financeEmployee");
      const [ancient] = await s.tx<{ id: string }[]>`
        select api.file_grievance(${phi.link}, '2025-06-01T00:00:00Z'::timestamptz, ${GROUNDS}) as id`;
      await s.asOwner();
      const rows = await s.tx<
        { id: string; window_days: number; decider: string; rule_from: string; is_late: boolean }[]
      >`
        select g.id, g.window_days, g.admissibility_decider as decider, g.is_late,
               case when r.effective_to is null then 'CURRENT' else 'EARLIER' end as rule_from
        from grievance.grievance g join committee.rule_set r on r.id = g.rule_set_id
        where g.id = any(${[earlier, current, ancient!.id]}::uuid[])`;
      const by = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(by[earlier]).toMatchObject({
        window_days: 30,
        decider: "SECRETARY",
        rule_from: "EARLIER",
        is_late: false,
      });
      expect(by[current]).toMatchObject({
        window_days: 10,
        decider: "CHAIR",
        rule_from: "CURRENT",
        is_late: false,
      });
      expect(by[ancient!.id]).toMatchObject({ window_days: 10, rule_from: "CURRENT", is_late: true });
    });
  });
});

describe("the non-admission decider (DEC-F17, AMB-148, CON-004)", () => {
  it("T-AMB-087: a Secretary-only non-admission is refused under the default rule; the committee decides it", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GC_SEATS);
      const sigma = await portalSubject(s, "employee", "Employee Sigma (synthetic)");
      const tau = await portalSubject(s, "employeeB", "Employee Tau (synthetic)");
      const g = await file(s, "employee", sigma.link);
      const admitted = await file(s, "employeeB", tau.link);
      await s.asOwner();
      expect(
        await s.tx`select admissibility_decider, non_admission_decider from grievance.grievance where id = ${g}`,
      ).toEqual([{ admissibility_decider: "SECRETARY", non_admission_decider: "COMMITTEE" }]);

      // The secretary's non-admission is only an assessment: the grievance waits for the committee.
      await s.as("committeeSecretary");
      const [r] = await s.tx<{ r: string }[]>`
        select api.assess_grievance_admissibility(${g}, 'INADMISSIBLE', null, ${REASON}) as r`;
      expect(r!.r).toBe("AWAITING_ADMISSIBILITY_DECISION");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.decide_grievance_admissibility(${g}, 'INADMISSIBLE', 'GC-DEMO-2040', ${REASON})`,
      );
      // An admission stays the secretary's under the default rule.
      const [a] = await s.tx<{ r: string }[]>`
        select api.assess_grievance_admissibility(${admitted}, 'ADMISSIBLE', null, ${REASON}) as r`;
      expect(a!.r).toBe("ADMITTED");

      await s.as("investigatorA");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.decide_grievance_admissibility(${g}, 'INADMISSIBLE', 'GC-DEMO-2040', ${REASON})`,
      );
      await s.as("committee");
      await s.expectError(
        "CDF_INVALID:decision_reference",
        (tx) => tx`select api.decide_grievance_admissibility(${g}, 'INADMISSIBLE', null, ${REASON})`,
      );
      const [d] = await s.tx<{ r: string }[]>`
        select api.decide_grievance_admissibility(${g}, 'INADMISSIBLE', 'GC-DEMO-2040', ${REASON}) as r`;
      expect(d!.r).toBe("INADMISSIBLE");
      await s.asOwner();
      expect(
        await s.tx`select stage, decided_by_role from grievance.admissibility_assessment where grievance_id = ${g}
                   order by recorded_at`,
      ).toEqual([
        { stage: "SECRETARY_ASSESSMENT", decided_by_role: null },
        { stage: "DECISION", decided_by_role: "COMMITTEE" },
      ]);
    });
  });

  it("an EXTERNAL non-admission is recorded by the secretary with the external decision's reference", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GC_SEATS);
      await revise(s, { non_admission_decider: "EXTERNAL" });
      const sigma = await portalSubject(s, "employee", "Employee Sigma (synthetic)");
      const g = await file(s, "employee", sigma.link);
      await s.as("committeeSecretary");
      await s.tx`select api.assess_grievance_admissibility(${g}, 'INADMISSIBLE', null, ${REASON})`;
      await s.as("committee");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.decide_grievance_admissibility(${g}, 'INADMISSIBLE', 'EXT-DEMO-2040', ${REASON})`,
      );
      await s.as("employee");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.decide_grievance_admissibility(${g}, 'INADMISSIBLE', 'EXT-DEMO-2040', ${REASON})`,
      );
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_INVALID:decision_reference",
        (tx) => tx`select api.decide_grievance_admissibility(${g}, 'INADMISSIBLE', null, ${REASON})`,
      );
      const [d] = await s.tx<{ r: string }[]>`
        select api.decide_grievance_admissibility(${g}, 'INADMISSIBLE', 'EXT-DEMO-2040', ${REASON}) as r`;
      expect(d!.r).toBe("INADMISSIBLE");
      await s.asOwner();
      expect(
        await s.tx`select decided_by_role, decision_reference from grievance.admissibility_assessment
                   where grievance_id = ${g} and stage = 'DECISION'`,
      ).toEqual([{ decided_by_role: "EXTERNAL", decision_reference: "EXT-DEMO-2040" }]);
      // Even the owner cannot record an external decision without its reference.
      await s.expectError(
        "new row for relation",
        (
          tx,
        ) => tx`insert into grievance.admissibility_assessment (grievance_id, stage, assessment, decided_by_role,
                     reason, recorded_by)
                   values (${g}, 'DECISION', 'INADMISSIBLE', 'EXTERNAL', ${REASON}, ${USERS.committeeSecretary})`,
      );
    });
  });
});

describe("grievance scope, withdrawal, completion and contested items (AMB-139, -140, -141, -143)", () => {
  it("T-AMB-083: a second grievance on a different decision is accepted; a second on the same decision is refused", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      // Fixture: a later decision on the same package (the authority revisiting it), so Sigma has two decisions.
      await s.asOwner();
      const [d2] = await s.tx<{ id: string }[]>`
        insert into decision.authority_decision (package_id, case_id, package_round, authority_type, outcome, decided_at,
                                                 decided_by_label, source_document_reference, recorded_by)
        select package_id, case_id, package_round, authority_type, outcome, now() - interval '30 minutes',
               decided_by_label, 'MEMO-DEMO-2040-B', recorded_by
        from decision.authority_decision where id = ${f.decision} returning id`;
      const n1 = await decisionNotice(s, f.sigma, f.decision);
      const n2 = await decisionNotice(s, f.sigma, d2!.id);
      await s.as("employee");
      const [g1] = await fileOnNotice(s, n1);
      await s.expectError("CDF_CONFLICT:GRIEVANCE_OPEN", () => fileOnNotice(s, n1));
      const [g2] = await fileOnNotice(s, n2);
      expect(g2!.id).not.toBe(g1!.id);
      // A portal grievance naming no decision cannot be told apart from either: refused while any is open (fail-safe).
      const [link] = await s.tx<
        { id: string }[]
      >`select id from grievance.subject_portal_link where subject_id = ${f.sigma}`;
      await s.expectError(
        "CDF_CONFLICT:GRIEVANCE_OPEN",
        (tx) => tx`select api.file_grievance(${link!.id}, now() - interval '1 hour', ${GROUNDS})`,
      );
      await s.asOwner();
      expect(
        (
          await s.tx<{ d: string }[]>`
            select contested_authority_decision_id as d from grievance.grievance where grievant_subject_id = ${f.sigma}`
        )
          .map((r) => r.d)
          .sort(),
      ).toEqual([f.decision, d2!.id].sort());
    });
  });

  it("AMB-143: a grievance names contested items of the decision, and only those", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      const n = await decisionNotice(s, f.sigma, f.decision);
      await s.as("employee");
      for (const items of [
        [f.corrective],
        [f.sanction, f.sanction],
        ["00000000-0000-4000-8000-000000000000"],
      ]) {
        await s.expectError("CDF_INVALID:item_ids", () => fileOnNotice(s, n, items));
      }
      const [g] = await fileOnNotice(s, n, [f.sanction]);
      expect(await s.tx`select grievance_id, item_id from grievance.contested_item`).toEqual([
        { grievance_id: g!.id, item_id: f.sanction },
      ]);
      await s.as("employeeB");
      expect(await s.tx`select item_id from grievance.contested_item`).toEqual([]);
      await s.asOwner();
      await s.expectError(
        "grievance.contested_item is append-only",
        (tx) => tx`delete from grievance.contested_item where grievance_id = ${g!.id}`,
      );
    });
  });

  it("AMB-140: the grievant withdraws before the outcome; the window is not reopened", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GC_SEATS);
      const f = await decidedForSubjects(s, ic, caseB);
      const old = await oldDeliveryNotice(s, f.sigma, f.decision, 40);
      await recordDelivery(s, old, 35);
      await s.as("employee");
      const [g] = await fileOnNotice(s, old);
      await s.expectError("CDF_INVALID:reason", (tx) => tx`select api.withdraw_grievance(${g!.id}, 'short')`);
      await s.as("committeeSecretary");
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.withdraw_grievance(${g!.id}, ${REASON})`);
      await s.as("employeeB");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.withdraw_grievance(${g!.id}, ${REASON})`);
      await s.as("employee");
      const [w] = await s.tx<{ r: string }[]>`select api.withdraw_grievance(${g!.id}, ${REASON}) as r`;
      expect(w!.r).toBe("WITHDRAWN");
      await s.expectError(
        "CDF_CONFLICT:GRIEVANCE_NOT_OPEN",
        (tx) => tx`select api.withdraw_grievance(${g!.id}, ${REASON})`,
      );
      // Filing again is measured against the same, already closed window.
      const [again] = await fileOnNotice(s, old);
      await s.asOwner();
      expect(await s.tx`select is_late from grievance.grievance where id = ${again!.id}`).toEqual([
        { is_late: true },
      ]);
      // An admitted grievance may be withdrawn too; it keeps its committee proceeding.
      await s.as("committeeSecretary");
      await s.tx`select api.assess_grievance_admissibility(${again!.id}, 'ADMISSIBLE', null, ${REASON})`;
      await s.as("employee");
      await s.tx`select api.withdraw_grievance(${again!.id}, ${REASON})`;
      await s.asOwner();
      expect(
        await s.tx`select status, committee_proceeding_id is not null as kept from grievance.grievance where id = ${again!.id}`,
      ).toEqual([{ status: "WITHDRAWN", kept: true }]);
      const events = await s.tx<{ metadata: Record<string, unknown>; reason: string | null }[]>`
        select metadata, reason from audit.audit_event where action = 'GRIEVANCE_WITHDRAWN' order by seq`;
      expect(events.map((e) => e.metadata)).toEqual([
        { previous_status: "RECEIVED" },
        { previous_status: "ADMITTED" },
      ]);
      expect(events.every((e) => e.reason === null)).toBe(true);
    });
  });

  it("AMB-141: completion is requested with the configured period only; the original filing date stands", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GC_SEATS);
      const sigma = await portalSubject(s, "employee", "Employee Sigma (synthetic)");
      const tau = await portalSubject(s, "employeeB", "Employee Tau (synthetic)");
      const unset = await file(s, "employeeB", tau.link);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:COMPLETION_PERIOD_SOURCE_REQUIRED",
        (tx) => tx`select api.request_grievance_completion(${unset}, ${REASON})`,
      );
      await revise(s, { grievance_completion_days: 5 });
      const g = await file(s, "employee", sigma.link);
      await s.as("caseManager");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.request_grievance_completion(${g}, ${REASON})`,
      );
      await s.as("investigatorA");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.request_grievance_completion(${g}, ${REASON})`,
      );
      await s.as("committeeSecretary");
      await s.tx`select api.request_grievance_completion(${g}, ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:COMPLETION_PENDING",
        (tx) => tx`select api.request_grievance_completion(${g}, ${REASON})`,
      );
      await s.expectError(
        "CDF_CONFLICT:COMPLETION_PENDING",
        (tx) => tx`select api.assess_grievance_admissibility(${g}, 'ADMISSIBLE', null, ${REASON})`,
      );
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.complete_grievance(${g}, 'Synthetic: the secretary cannot complete it.')`,
      );
      await s.as("employeeB");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.complete_grievance(${g}, 'Synthetic: not my grievance to complete.')`,
      );
      await s.as("employee");
      const [due] = await s.tx<{ span: string }[]>`
        select (due_at - requested_at)::text as span from grievance.completion_request where grievance_id = ${g}`;
      expect(due!.span).toBe("5 days");
      await s.tx`select api.complete_grievance(${g}, 'Synthetic: the missing decision reference is attached.')`;
      await s.expectError(
        "CDF_CONFLICT:NO_COMPLETION_REQUEST",
        (tx) => tx`select api.complete_grievance(${g}, 'Synthetic: a second completion.')`,
      );
      await s.asOwner();
      const [row] = await s.tx<{ same: boolean; late: boolean }[]>`
        select g.original_submission_date = g.recorded_at as same, x.is_late as late
        from grievance.grievance g join grievance.grievance_supplement x on x.grievance_id = g.id where g.id = ${g}`;
      expect(row).toEqual({ same: true, late: false });
      await s.as("committeeSecretary");
      await s.tx`select api.assess_grievance_admissibility(${g}, 'ADMISSIBLE', null, ${REASON})`;
    });
  });
});

describe("sanction execution guards (AMB-031, AMB-109, AMB-110) and grievance outcomes (AMB-145, AMB-149)", () => {
  const execute = (s: Scenario, item: string, subject: string, from = "0 days") =>
    s.tx`select api.record_sanction_execution(${item}, ${subject}, now() - ${from}::interval, 'HR-DEMO-2040') as id`;

  it("T-AMB-062: execution never shows a sanction effective before the decision notice is delivered", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:DECISION_NOT_DELIVERED", () => execute(s, f.sanction, f.sigma));
      const n = await decisionNotice(s, f.sigma, f.decision);
      await s.expectError("CDF_CONFLICT:DECISION_NOT_DELIVERED", () => execute(s, f.sanction, f.sigma));
      await recordDelivery(s, n);
      await s.expectError("CDF_CONFLICT:EFFECTIVE_BEFORE_DELIVERY", () =>
        execute(s, f.sanction, f.sigma, "1 day"),
      );
      await s.expectError("CDF_INVALID:item_id", () => execute(s, f.sanction, f.tau));
      await s.expectError("CDF_INVALID:item_id", () => execute(s, f.corrective, f.sigma));
      await s.as("investigatorB");
      await s.expectError("CDF_FORBIDDEN", () => execute(s, f.sanction, f.sigma));
      for (const u of ["investigatorA", "platformAdmin", "employee"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", () => execute(s, f.sanction, f.sigma));
      }
      await s.as("caseManager");
      await execute(s, f.sanction, f.sigma);
      await s.expectError("CDF_CONFLICT:ALREADY_EXECUTED", () => execute(s, f.sanction, f.sigma));
      await s.asOwner();
      expect(
        await s.tx`select decision_notice_id, authority_decision_id from decision.sanction_execution where item_id = ${f.sanction}`,
      ).toEqual([{ decision_notice_id: n, authority_decision_id: f.decision }]);
      await s.expectError(
        "decision.sanction_execution is append-only",
        (tx) => tx`update decision.sanction_execution set effective_from = now() - interval '9 days'`,
      );
    });
  });

  it("T-AMB-063: an irreversible sanction is not executable while the grievance window is open", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      await s.asOwner();
      expect(
        await s.tx`select code from decision.sanction_catalogue where is_irreversible order by code`,
      ).toEqual([{ code: "TERMINATION" }]);
      // Fixture: the WARNING of this package is treated as irreversible for the test.
      await s.tx`update decision.sanction_catalogue set is_irreversible = true where code = 'WARNING'`;
      const n = await decisionNotice(s, f.sigma, f.decision);
      await recordDelivery(s, n);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:GRIEVANCE_WINDOW_OPEN", () => execute(s, f.sanction, f.sigma));
      await s.asOwner();
      await s.tx`update decision.sanction_catalogue set is_irreversible = false where code = 'WARNING'`;
      await s.as("caseManager");
      await execute(s, f.sanction, f.sigma);
    });
  });

  it("T-AMB-063: an irreversible sanction is not executable while a grievance on it is open, even after the window", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      await s.asOwner();
      await s.tx`update decision.sanction_catalogue set is_irreversible = true where code = 'WARNING'`;
      const old = await oldDeliveryNotice(s, f.sigma, f.decision, 40);
      await recordDelivery(s, old, 35);
      await s.as("employee");
      const [g] = await fileOnNotice(s, old);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:GRIEVANCE_OPEN", () => execute(s, f.sanction, f.sigma));
      await s.as("employee");
      await s.tx`select api.withdraw_grievance(${g!.id}, ${REASON})`;
      await s.as("caseManager");
      await execute(s, f.sanction, f.sigma);
    });
  });

  it("T-AMB-013: a subject who left employment keeps findings; execution needs an explicit authority decision", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      const flag = (subject: string, on = "current_date") =>
        s.tx`select api.flag_subject_left_employment(${subject},
          ${on === "current_date" ? null : on}::date, 'HR-DEMO-LEFT-2040') as id`;
      await s.as("investigatorB");
      await s.expectError("CDF_FORBIDDEN", () => flag(f.sigma));
      await s.as("investigatorA");
      await s.expectError("CDF_NOT_FOUND", () => flag(f.sigma));
      await s.as("caseManager");
      await s.expectError("CDF_INVALID:left_on", () => flag(f.sigma));
      await s.expectError("CDF_INVALID:left_on", () => flag(f.sigma, "2999-01-01"));
      await flag(f.sigma, "2026-09-30");
      await s.expectError("CDF_CONFLICT:ALREADY_FLAGGED", () => flag(f.sigma, "2026-09-30"));
      const n = await decisionNotice(s, f.sigma, f.decision);
      await recordDelivery(s, n);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:SUBJECT_LEFT_EMPLOYMENT", () => execute(s, f.sanction, f.sigma));
      await s.asOwner();
      expect(await s.tx`select id from case_mgmt.finding where id = ${f.finding}`).toEqual([
        { id: f.finding },
      ]);

      const authorize = () =>
        s.tx`select api.authorize_sanction_execution(${f.sanction}, ${f.sigma}, 'CEO', 'MEMO-DEMO-LEFT-2040', ${REASON}) as id`;
      for (const u of ["investigatorA", "platformAdmin"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", () => authorize());
      }
      for (const u of ["caseManager", "committeeChair"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", () => authorize());
      }
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_INVALID:authority_type",
        (tx) =>
          tx`select api.authorize_sanction_execution(${f.sanction}, ${f.sigma}, 'NOBODY', 'MEMO-DEMO-LEFT-2040', ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:item_id",
        (tx) =>
          tx`select api.authorize_sanction_execution(${f.sanction}, ${f.tau}, 'CEO', 'MEMO-DEMO-LEFT-2040', ${REASON})`,
      );
      await authorize();
      await s.expectError("CDF_CONFLICT:ALREADY_AUTHORIZED", () => authorize());
      await s.as("caseManager");
      await execute(s, f.sanction, f.sigma);
    });
  });

  it("T-AMB-088 and T-AMB-085: MODIFY never substitutes a more severe or unranked sanction; a decided decision takes no further grievance", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GC_SEATS);
      const f = await decidedForSubjects(s, ic, caseB);
      const n = await decisionNotice(s, f.sigma, f.decision);
      await recordDelivery(s, n);
      await s.as("employee");
      const [g] = await fileOnNotice(s, n, [f.sanction]);
      await s.as("committeeSecretary");
      await s.tx`select api.assess_grievance_admissibility(${g!.id}, 'ADMISSIBLE', null, ${REASON})`;
      const vi = await approvedGrievanceVote(s, g!.id);
      // Fixture: synthetic severity ranks for the test only (the catalogue's ranks are SOURCE_REQUIRED).
      await s.asOwner();
      expect(
        await s.tx`select count(*)::int as n from decision.sanction_catalogue where severity_rank is not null`,
      ).toEqual([{ n: 0 }]);
      await s.tx`update decision.sanction_catalogue set severity_rank = case code when 'SALARY_DEDUCTION' then 1
                   when 'WARNING' then 2 when 'TERMINATION' then 5 end
                 where code in ('SALARY_DEDUCTION', 'WARNING', 'TERMINATION')`;
      const outcome = (outcomes: string[], subs: unknown) =>
        s.tx`select api.record_grievance_outcome(${g!.id}, ${outcomes}::text[], null, ${vi},
          'Synthetic: outcome summary for the grievance.', ${subs === null ? null : s.tx.json(subs as never)}) as id`;
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:SANCTION_MORE_SEVERE", () =>
        outcome(["MODIFY"], [{ item_id: f.sanction, sanction_code: "TERMINATION" }]),
      );
      await s.expectError("CDF_CONFLICT:SANCTION_SEVERITY_UNKNOWN", () =>
        outcome(["MODIFY"], [{ item_id: f.sanction, sanction_code: "SUSPENSION" }]),
      );
      await s.expectError("CDF_INVALID:substitutions", () =>
        outcome(["UPHOLD"], [{ item_id: f.sanction, sanction_code: "SALARY_DEDUCTION" }]),
      );
      await s.expectError("CDF_INVALID:substitutions", () =>
        outcome(["MODIFY"], [{ item_id: f.corrective, sanction_code: "SALARY_DEDUCTION" }]),
      );
      await s.expectError("CDF_INVALID:substitutions", () =>
        outcome(["MODIFY"], [{ item_id: "not-a-uuid", sanction_code: "SALARY_DEDUCTION" }]),
      );
      await s.as("employee");
      await s.expectError("CDF_FORBIDDEN", () =>
        outcome(["MODIFY"], [{ item_id: f.sanction, sanction_code: "SALARY_DEDUCTION" }]),
      );
      await s.as("committeeSecretary");
      await outcome(["MODIFY"], [{ item_id: f.sanction, sanction_code: "SALARY_DEDUCTION" }]);
      await s.asOwner();
      expect(
        await s.tx`select original_sanction_code, substitute_sanction_code from grievance.outcome_substitution
                   where grievance_id = ${g!.id}`,
      ).toEqual([{ original_sanction_code: "WARNING", substitute_sanction_code: "SALARY_DEDUCTION" }]);

      // T-AMB-085: the decision's grievance is decided; a further one is refused until the owner rules (DEC-AMB-001).
      await s.as("employee");
      await s.expectError("CDF_CONFLICT:GRIEVANCE_ALREADY_DECIDED", () => fileOnNotice(s, n));
    });
  });
});
