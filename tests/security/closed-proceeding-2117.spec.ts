// Migration 2117 (Linear CDF-226; coordinator rulings of 2026-10-16 09:36 and 2026-10-18 15:44 UTC; ADR-057
// amendment): a committee proceeding that is no longer open freezes its recommendation packages and its meetings.
//
//   * The conclusion guard: api.close_proceeding refuses a committee proceeding while a vote is open, a package is in
//     its vote, adopted, in legal review or with the authority, a conflict after a vote is unresolved, or a meeting
//     held offline waits for its online completion; then it closes the open meetings and cancels the scheduled ones,
//     each with its own event, whether the proceeding is concluded or cancelled.
//   * Every package command (decision.lock_managed_package's eleven callers) and the three commands that do not take
//     that lock refuse PROCEEDING_CLOSED on a proceeding that is no longer open, concluded or cancelled. The states in
//     which each would otherwise accept can only exist on a proceeding closed before 2117 (the guard prevents them
//     now), so those tests close the proceeding as 1870's command did, as the table owner, inside a savepoint: the
//     same command is first shown to accept on the open proceeding, and to refuse once it is closed.
//   * The mirrors answer the same: the reviewer's read (L1), the legal review choices (L2, both acts), R2 for the
//     case team. The full flag == command sweeps on a closed proceeding are in the 2086 and 2095 specs.
// Every step runs through the api.* commands as `authenticated`, except those owner closures and the clearances the
// restricted case needs (no command writes them).
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, type OwnerScenario, type Scenario, type UserKey } from "../support/db";
import {
  REASON,
  closeAsBefore2117,
  committeeIds,
  preliminaryReferral,
  seat,
  type MeetingFixture,
} from "../support/committee";
import {
  authorityRuleFor,
  draftPackage,
  requestLegalReview,
  voteOnPackage,
  type PackageFixture,
} from "../support/decision";
import { outcomes } from "../support/capabilities";

const FIRM = "Synthetic: the documented reasoning of the committee.";
const MEMO = "MEMO-DEMO-2117";
const STATUSES = ["CONCLUDED", "CANCELLED"] as const;
type Closed = (typeof STATUSES)[number];
const CLOSED = "CDF_CONFLICT:PROCEEDING_CLOSED";

let caseB: string, caseExec: string, ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  caseExec = await caseId("0003");
  ({ ic } = await committeeIds());
});

const closeSql = (proceeding: string, status: Closed) =>
  `select api.close_proceeding('${proceeding}', '${status}', ${
    status === "CONCLUDED" ? "'DECISION_RECORDED'" : "null"
  }, '${REASON}')`;
const recordSql = (pkg: string) =>
  `select api.record_authority_decision('${pkg}', 'CEO', 'APPROVE_AS_RECOMMENDED', now(), 'Authority (synthetic)', '${MEMO}', null, '${REASON}')`;

/** The case proceeding behind a committee proceeding. */
async function proceedingOf(s: OwnerScenario, cp: string): Promise<string> {
  await s.asOwner();
  const [r] = await s.tx<{ id: string }[]>`
    select proceeding_id as id from committee.committee_proceeding where id = ${cp}`;
  return r!.id;
}

/** What closing the committee's proceeding answers the case manager now, concluded and cancelled (rolled back).
 *  Leaves the committee's secretary acting. */
async function closing(s: OwnerScenario, cp: string): Promise<Record<Closed, true | string>> {
  const proceeding = await proceedingOf(s, cp);
  const o = await outcomes(s, "caseManager", {
    CONCLUDED: closeSql(proceeding, "CONCLUDED"),
    CANCELLED: closeSql(proceeding, "CANCELLED"),
  });
  await s.as("committeeSecretary");
  return { CONCLUDED: o.CONCLUDED!, CANCELLED: o.CANCELLED! };
}

const both = (answer: true | string) => ({ CONCLUDED: answer, CANCELLED: answer });

class Undo extends Error {}

/**
 * Runs `fn` with the committee proceeding closed (`status`) as before 2117 (closeAsBefore2117), inside a savepoint that
 * is then rolled back, so the next status starts from the same state.
 */
async function closedBefore2117<T>(
  s: OwnerScenario,
  cp: string,
  status: Closed,
  fn: () => Promise<T>,
): Promise<T> {
  let out: T | undefined;
  try {
    await s.tx.savepoint(async () => {
      await closeAsBefore2117(s, cp, status);
      out = await fn();
      throw new Undo();
    });
  } catch (error) {
    if (!(error instanceof Undo)) throw error;
  }
  return out as T;
}

/**
 * The probes each accept on the open proceeding, run as `user`; then, closed before 2117 either way, each refuses
 * PROCEEDING_CLOSED. Everything is rolled back.
 */
async function acceptsOnlyWhileOpen(
  s: OwnerScenario,
  cp: string,
  user: UserKey,
  probes: Record<string, string>,
): Promise<void> {
  const accepted = Object.fromEntries(Object.keys(probes).map((k) => [k, true]));
  const refused = Object.fromEntries(Object.keys(probes).map((k) => [k, CLOSED]));
  expect(await outcomes(s, user, probes), `${user}: accepted while the proceeding is open`).toEqual(accepted);
  for (const status of STATUSES)
    expect(
      await closedBefore2117(s, cp, status, () => outcomes(s, user, probes)),
      `${user}: refused on a ${status} proceeding`,
    ).toEqual(refused);
}

/** A conflict about `subject`'s participation, raised by `raiser` and upheld by the chair (DEC-F04). */
async function upheldOn(s: Scenario, m: MeetingFixture, subject: UserKey, raiser: UserKey): Promise<void> {
  await s.as(raiser);
  const [c] = await s.tx<{ id: string }[]>`
    select api.raise_meeting_conflict(${m.participant[subject]!}, 'Synthetic: the member is related to the subject.') as id`;
  await s.as("committeeChair");
  await s.tx`select api.decide_meeting_conflict(${c!.id}, 'UPHELD', 'Synthetic: the relationship is confirmed.')`;
}

/** legalB gives the opinion on the request. */
async function concur(s: Scenario, request: string): Promise<void> {
  await s.as("legalB");
  await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
}

/** The ledger rows this scenario wrote with `actions`, oldest first. */
async function events(s: OwnerScenario, actions: string[]) {
  await s.asOwner();
  return s.tx<
    {
      action: string;
      actor_id: string;
      object_type: string;
      object_id: string;
      reason: string | null;
      metadata: Record<string, unknown>;
    }[]
  >`select action, actor_id, object_type, object_id, reason, metadata from audit.audit_event
    where request_id = current_setting('cdf.request_id')::uuid and action = any (${actions})
    order by seq`;
}

describe("migration 2117: the conclusion guard, then the meetings close with the proceeding (CDF-226)", () => {
  it("a committee proceeding leaves OPEN only once nothing of its work is in flight, concluded or cancelled; a draft package does not hold it", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await closing(s, cp), "a draft package").toEqual(both(true));

      await s.as("committeeSecretary");
      await s.tx`select api.submit_package_for_vote(${f.pkg})`;
      expect(await closing(s, cp), "put to the committee").toEqual(both("CDF_CONFLICT:PACKAGE_VOTING"));
      await s.tx`select api.open_package_vote(${f.meeting.meeting}, ${f.pkg})`;
      // An open vote is named first: the vote, then the package.
      expect(await closing(s, cp), "its vote open").toEqual(both("CDF_CONFLICT:VOTES_OPEN"));
      const [vi] = await s.tx<
        { id: string }[]
      >`select id from committee.vote_item where package_id = ${f.pkg}`;
      for (const u of ["committeeChair", "legal", "lead"] as const) {
        await s.as(u);
        await s.tx`select api.cast_vote(${vi!.id}, 'APPROVE', null)`;
      }
      expect(await closing(s, cp), "every vote cast, the item still open").toEqual(
        both("CDF_CONFLICT:VOTES_OPEN"),
      );
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi!.id}, null)`;
      expect(await closing(s, cp), "votes closed, adoption not recorded").toEqual(
        both("CDF_CONFLICT:PACKAGE_VOTING"),
      );
      await s.tx`select api.record_package_adoption(${f.pkg})`;
      expect(await closing(s, cp), "adopted").toEqual(both("CDF_CONFLICT:PACKAGE_ADOPTED"));
      const { request } = await requestLegalReview(s, f);
      expect(await closing(s, cp), "in legal review").toEqual(both("CDF_CONFLICT:LEGAL_REVIEW_OPEN"));
      await concur(s, request);
      expect(await closing(s, cp), "reviewed, not yet submitted").toEqual(
        both("CDF_CONFLICT:PACKAGE_ADOPTED"),
      );
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      expect(await closing(s, cp), "with the authority").toEqual(both("CDF_CONFLICT:PACKAGE_WITH_AUTHORITY"));
      await s.tx.unsafe(recordSql(f.pkg));
      await s.asOwner();
      expect(await s.tx`select status from decision.recommendation_package where id = ${f.pkg}`).toEqual([
        { status: "DECIDED" },
      ]);
      expect(await closing(s, cp), "decided").toEqual(both(true));
    });
  });

  it("an adopted package returned to the committee no longer holds the proceeding, and a legal review cancelled no longer does", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      const { request } = await requestLegalReview(s, f);
      expect(await closing(s, cp)).toEqual(both("CDF_CONFLICT:LEGAL_REVIEW_OPEN"));
      await s.as("committeeSecretary");
      await s.tx`select api.cancel_legal_review_request(${request}, 'Synthetic: the wrong reviewer was asked.')`;
      expect(await closing(s, cp)).toEqual(both("CDF_CONFLICT:PACKAGE_ADOPTED"));
      await s.tx`select api.return_package_to_committee(${f.pkg}, ${REASON})`;
      expect(await closing(s, cp)).toEqual(both(true));
    });
  });

  it("an unresolved conflict after the vote holds the proceeding (it needs an open meeting); the committee's resolution releases it", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      await concur(s, (await requestLegalReview(s, f)).request);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await s.tx.unsafe(recordSql(f.pkg));
      expect(await closing(s, cp), "decided").toEqual(both(true));
      // A conflict on the lead's participation, upheld after the decision: the decided package is tainted.
      await upheldOn(s, f.meeting, "lead", "legal");
      expect(await closing(s, cp), "tainted").toEqual(both("CDF_CONFLICT:TAINTED_BY_CONFLICT"));
      // Everyone approved, so the recount without the lead gives the same result: the committee confirms it.
      await s.as("committeeSecretary");
      await s.tx`select api.resolve_conflict_taint(${f.corrective}, 'CONFIRM', ${FIRM})`;
      expect(await closing(s, cp), "confirmed").toEqual(both(true));
    });
  });

  it("closing it closes the open meetings and cancels the scheduled ones, each with its own event and no reason, before the proceeding's own event", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      await s.as("committeeSecretary");
      const [later] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Meeting room (synthetic)', null,
          now() + interval '3 days', now() + interval '3 days 2 hours', ${REASON}) as id`;
      const [item] = await s.tx<{ id: string }[]>`
        select api.open_vote_item(${f.meeting.meeting}, 'OTHER', null, 'Recommendation (synthetic)') as id`;
      for (const u of ["committeeChair", "legal", "lead"] as const) {
        await s.as(u);
        await s.tx`select api.cast_vote(${item!.id}, 'APPROVE', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item!.id}, null)`;
      const proceeding = await proceedingOf(s, cp);
      await s.as("caseManager");
      await s.tx.unsafe(closeSql(proceeding, "CONCLUDED"));

      await s.asOwner();
      expect(
        await s.tx`select id, status, closed_by from committee.meeting where committee_proceeding_id = ${cp}
                   order by sequence_no`,
      ).toEqual([
        { id: f.meeting.meeting, status: "CLOSED", closed_by: USERS.caseManager },
        { id: later!.id, status: "CANCELLED", closed_by: USERS.caseManager },
      ]);
      expect(await s.tx`select status from committee.committee_proceeding where id = ${cp}`).toEqual([
        { status: "CONCLUDED" },
      ]);
      // The scenario's own fixtures closed other proceedings of the case before: only this closure's rows.
      const written = (await events(s, ["MEETING_CLOSED", "MEETING_CANCELLED", "PROCEEDING_CLOSED"])).filter(
        (e) => [f.meeting.meeting, later!.id, proceeding].includes(e.object_id),
      );
      expect(written.map((e) => [e.action, e.object_id, e.actor_id])).toEqual([
        ["MEETING_CLOSED", f.meeting.meeting, USERS.caseManager],
        ["MEETING_CANCELLED", later!.id, USERS.caseManager],
        ["PROCEEDING_CLOSED", proceeding, USERS.caseManager],
      ]);
      expect(written[0]).toMatchObject({
        reason: null,
        metadata: { proceeding_id: proceeding, vote_items: 1 },
      });
      expect(written[1]).toMatchObject({ reason: null, metadata: { proceeding_id: proceeding } });
      expect(written[2]!.reason).toBe(REASON);
      // The scheduled meeting's participants are told it is cancelled, as api.cancel_meeting tells them.
      expect(
        (
          await s.tx<{ n: number }[]>`
            select count(*)::int as n from notify.outbox
            where template_code = 'MEETING_CANCELLED' and object_id = ${later!.id}`
        )[0]!.n,
      ).toBeGreaterThan(0);
      // The closed meeting's minutes can still be generated.
      await s.as("committeeSecretary");
      await s.tx`select api.generate_minutes(${f.meeting.meeting}, 'Synthetic minutes narrative.')`;
    });
  });

  it("a cancelled proceeding cancels its scheduled meetings the same way, and nothing reopens", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      const proceeding = await proceedingOf(s, cp);
      await s.as("caseManager");
      await s.tx.unsafe(closeSql(proceeding, "CANCELLED"));
      await s.asOwner();
      expect(await s.tx`select status from committee.meeting where committee_proceeding_id = ${cp}`).toEqual([
        { status: "CLOSED" },
      ]);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:MEETING_NOT_SCHEDULED",
        (tx) => tx`select api.open_meeting(${f.meeting.meeting}, ${REASON})`,
      );
      await s.expectError(
        "CDF_CONFLICT:PROCEEDING_CLOSED",
        (
          tx,
        ) => tx`select api.schedule_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Meeting room (synthetic)', null,
          now() + interval '3 days', now() + interval '3 days 2 hours', ${REASON})`,
      );
      await s.expectError(
        "CDF_CONFLICT:PROCEEDING_CLOSED",
        (tx) => tx`select api.create_recommendation_package(${cp}, 'PACKAGE')`,
      );
    });
  });
});

describe("migration 2117: every package command refuses on a proceeding that is no longer open", () => {
  it("through the command path: a draft package on a concluded or a cancelled proceeding takes no item, no withdrawal and no submission", async () => {
    for (const status of STATUSES)
      await ownerScenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        const cp = f.meeting.committeeProceeding;
        const proceeding = await proceedingOf(s, cp);
        const probes = {
          add: `select api.add_recommendation_item('${f.pkg}', 'OTHER', null, null, 'Synthetic: one more recommendation.', null, null)`,
          withdraw: `select api.withdraw_recommendation_item('${f.corrective}', '${REASON}')`,
          submit: `select api.submit_package_for_vote('${f.pkg}')`,
        };
        expect(await outcomes(s, "committeeSecretary", probes)).toEqual({
          add: true,
          withdraw: true,
          submit: true,
        });
        await s.as("caseManager");
        await s.tx.unsafe(closeSql(proceeding, status));
        expect(await outcomes(s, "committeeSecretary", probes), status).toEqual({
          add: CLOSED,
          withdraw: CLOSED,
          submit: CLOSED,
        });
        // Anyone else is refused as before: NOT_FOUND or FORBIDDEN, never more.
        for (const u of ["committeeChair", "caseManager", "investigatorB", "platformAdmin"] as const)
          for (const v of Object.values(await outcomes(s, u, probes)))
            expect(["CDF_NOT_FOUND", "CDF_FORBIDDEN"], `${u} ${status}`).toContain(v);
      });
  });

  it("closed before 2117, concluded or cancelled: each package command refuses in the state where it accepts on the open proceeding", async () => {
    await ownerScenario(async (s) => {
      const f: PackageFixture = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      // In its committee vote, the vote not yet opened (the meeting stays open: 1870 left meetings as they were).
      await s.as("committeeSecretary");
      await s.tx`select api.submit_package_for_vote(${f.pkg})`;
      await acceptsOnlyWhileOpen(s, cp, "committeeSecretary", {
        open_package_vote: `select api.open_package_vote('${f.meeting.meeting}', '${f.pkg}')`,
      });
      // The votes closed, the adoption not recorded.
      await s.tx`select api.open_package_vote(${f.meeting.meeting}, ${f.pkg})`;
      const [vi] = await s.tx<
        { id: string }[]
      >`select id from committee.vote_item where package_id = ${f.pkg}`;
      for (const u of ["committeeChair", "legal", "lead"] as const) {
        await s.as(u);
        await s.tx`select api.cast_vote(${vi!.id}, 'APPROVE', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi!.id}, null)`;
      await acceptsOnlyWhileOpen(s, cp, "committeeSecretary", {
        record_package_adoption: `select api.record_package_adoption('${f.pkg}')`,
      });
      // Adopted.
      await s.tx`select api.record_package_adoption(${f.pkg})`;
      await acceptsOnlyWhileOpen(s, cp, "committeeSecretary", {
        request_legal_review: `select api.request_legal_review('${f.pkg}', '${USERS.legalB}', '${REASON}', array['${f.finding}']::uuid[], null)`,
        return_package_to_committee: `select api.return_package_to_committee('${f.pkg}', '${REASON}')`,
      });
      // In legal review.
      const { request } = await requestLegalReview(s, f);
      await acceptsOnlyWhileOpen(s, cp, "committeeSecretary", {
        cancel_legal_review_request: `select api.cancel_legal_review_request('${request}', '${REASON}')`,
      });
      await acceptsOnlyWhileOpen(s, cp, "legalB", {
        give_legal_opinion: `select api.give_legal_opinion('${request}', 'CONCURS', null)`,
      });
      // Reviewed.
      await concur(s, request);
      await acceptsOnlyWhileOpen(s, cp, "legalB", {
        give_superseding_legal_opinion: `select api.give_superseding_legal_opinion('${request}', 'CONCURS_WITH_COMMENTS', 'Synthetic: a later comment on the package.')`,
      });
      await acceptsOnlyWhileOpen(s, cp, "committeeSecretary", {
        submit_to_authority: `select api.submit_to_authority('${f.pkg}')`,
      });
      // With the authority (the case ADR-057's known limitation pinned as accepted until 2117).
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await acceptsOnlyWhileOpen(s, cp, "committeeSecretary", {
        record_authority_decision: recordSql(f.pkg),
      });
      // Decided, then tainted: the committee's resolution, in the meeting that 1870 left open.
      await s.tx.unsafe(recordSql(f.pkg));
      await upheldOn(s, f.meeting, "lead", "legal");
      await acceptsOnlyWhileOpen(s, cp, "committeeSecretary", {
        resolve_conflict_taint: `select api.resolve_conflict_taint('${f.corrective}', 'CONFIRM', '${FIRM}')`,
      });
    });
  });

  it("closed before 2117: a draft package's add, withdraw and submit refuse too, so all eleven callers of the lock are covered", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      await acceptsOnlyWhileOpen(s, f.meeting.committeeProceeding, "committeeSecretary", {
        add_recommendation_item: `select api.add_recommendation_item('${f.pkg}', 'OTHER', null, null, 'Synthetic: one more recommendation.', null, null)`,
        withdraw_recommendation_item: `select api.withdraw_recommendation_item('${f.corrective}', '${REASON}')`,
        submit_package_for_vote: `select api.submit_package_for_vote('${f.pkg}')`,
      });
    });
  });

  it("closed before 2117: the restricted case's authority neither approves a legal review nor reads the choices to approve one (L2 APPROVE)", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET'
                 where id in (${USERS.committeeSecretary}, ${USERS.legalB})`;
      await seat(s, ic, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["grcDeputy", "MEMBER"],
      ]);
      await authorityRuleFor(s, "CORRECTIVE_ACTION");
      await preliminaryReferral(s, caseExec);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`;
      const [cp] = await s.tx<{ id: string }[]>`
        select api.refer_case_to_committee(${caseExec}, ${ic}, null, ${REASON}) as id`;
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp!.id}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      const [part] = await s.tx<{ id: string }[]>`
        select id from committee.meeting_participant where meeting_id = ${m!.id} and user_id = ${USERS.grcDeputy}`;
      await s.as("grcDeputy");
      await s.tx`select api.declare_meeting_conflict(${part!.id}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${m!.id}, ${REASON})`;
      await s.tx`select api.record_attendance(${part!.id}, 'PRESENT')`;
      const [pkg] = await s.tx<{ id: string }[]>`
        select api.create_recommendation_package(${cp!.id}, 'PACKAGE') as id`;
      await s.tx`select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null,
        'Synthetic: tighten the approval controls.', null, null)`;
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
      await acceptsOnlyWhileOpen(s, cp!.id, "grcDirector", {
        approve_restricted_legal_review: `select api.approve_restricted_legal_review('${pkg!.id}', '${USERS.legalB}', null, null, '${REASON}')`,
        legal_review_choices_approve: `select api.legal_review_choices('${pkg!.id}', 'APPROVE')`,
      });
    });
  });
});

describe("migration 2117: the reads answer as the commands do on a proceeding closed before 2117", () => {
  it("the reviewer's read (L1) gives neither opinion and names PROCEEDING_CLOSED; L2 REQUEST refuses with it; R2 gives the case team no capability", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      const cp = f.meeting.committeeProceeding;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      const review = async (request: string) => {
        await s.as("legalB");
        const [r] = await s.tx<
          {
            v: {
              capabilities: { may_give_opinion: boolean; may_give_superseding_opinion: boolean };
              opinion_block: string | null;
              superseding_opinion_block: string | null;
            };
          }[]
        >`select api.legal_review_view(${request}) as v`;
        return r!.v;
      };
      const choicesRequest = async () => {
        const o = await outcomes(s, "committeeSecretary", {
          request: `select api.legal_review_choices('${f.pkg}', 'REQUEST')`,
        });
        return o.request;
      };
      const teamCapabilities = async () => {
        await s.as("investigatorB");
        const [r] = await s.tx<{ v: { packages: { capabilities: Record<string, boolean> }[] } }[]>`
          select api.committee_items_view(${cp}) as v`;
        return r!.v.packages.map((p) => Object.values(p.capabilities).some(Boolean));
      };
      expect(await choicesRequest(), "L2 REQUEST while open").toBe(true);
      for (const status of STATUSES)
        await closedBefore2117(s, cp, status, async () => {
          expect(await choicesRequest(), `L2 REQUEST, ${status}`).toBe(CLOSED);
          expect(await teamCapabilities(), `R2 for the case team, ${status}`).toEqual([false]);
        });

      const { request } = await requestLegalReview(s, f);
      expect(await review(request)).toMatchObject({
        capabilities: { may_give_opinion: true },
        opinion_block: null,
      });
      for (const status of STATUSES)
        await closedBefore2117(s, cp, status, async () => {
          expect(await review(request), status).toMatchObject({
            capabilities: { may_give_opinion: false, may_give_superseding_opinion: false },
            opinion_block: "PROCEEDING_CLOSED",
          });
        });
      await concur(s, request);
      expect((await review(request)).capabilities.may_give_superseding_opinion).toBe(true);
      for (const status of STATUSES)
        await closedBefore2117(s, cp, status, async () => {
          expect(await review(request), status).toMatchObject({
            capabilities: { may_give_opinion: false, may_give_superseding_opinion: false },
            superseding_opinion_block: "PROCEEDING_CLOSED",
          });
        });
    });
  });
});

describe("migration 2117: helpers and grants", () => {
  it("the two new helpers are internal; the replaced functions keep their owners and grants; the commands hold the proceeding row before writing", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const rows = await s.tx<{ name: string; definer: boolean; volatile: string; granted: boolean }[]>`
        select p.proname as name, p.prosecdef as definer, p.provolatile as volatile,
               has_function_privilege('authenticated', p.oid, 'execute')
                 or has_function_privilege('anon', p.oid, 'execute') as granted
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'decision'
          and p.proname in ('package_proceeding_open', 'require_package_proceeding_open', 'lock_managed_package',
                            'managed_package_refusal', 'manages_package', 'legal_opinion_refusal',
                            'superseding_opinion_refusal')
        order by p.proname`;
      expect(rows).toEqual([
        { name: "legal_opinion_refusal", definer: false, volatile: "s", granted: false },
        { name: "lock_managed_package", definer: false, volatile: "v", granted: false },
        { name: "managed_package_refusal", definer: false, volatile: "s", granted: false },
        { name: "manages_package", definer: false, volatile: "s", granted: false },
        { name: "package_proceeding_open", definer: false, volatile: "s", granted: false },
        { name: "require_package_proceeding_open", definer: false, volatile: "v", granted: false },
        { name: "superseding_opinion_refusal", definer: false, volatile: "s", granted: false },
      ]);
      const commands = await s.tx<
        { name: string; args: number; granted: boolean; anon: boolean; src: string }[]
      >`
        select p.proname as name, p.pronargs::int as args,
               has_function_privilege('authenticated', p.oid, 'execute') as granted,
               has_function_privilege('anon', p.oid, 'execute') as anon, p.prosrc as src
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'api'
          and p.proname in ('approve_restricted_legal_review', 'give_legal_opinion', 'give_superseding_legal_opinion',
                            'close_proceeding', 'legal_review_choices')
        order by p.proname, p.pronargs`;
      expect(commands.map((c) => [c.name, c.args, c.granted, c.anon])).toEqual([
        ["approve_restricted_legal_review", 3, true, false],
        ["approve_restricted_legal_review", 5, true, false],
        ["close_proceeding", 4, true, false],
        ["give_legal_opinion", 3, true, false],
        ["give_superseding_legal_opinion", 3, true, false],
        ["legal_review_choices", 2, true, false],
      ]);
      for (const c of commands.filter((x) => x.name.startsWith("give_") || x.args === 5))
        expect(c.src, c.name).toContain("decision.require_package_proceeding_open(");
      // 1900's signature only hands over to the five-argument command, so it refuses as that one does.
      expect(commands.find((c) => c.args === 3 && c.name.startsWith("approve_"))!.src).toContain(
        "return api.approve_restricted_legal_review(p_package_id, p_reviewer_id, '{}'::uuid[], '{}'::uuid[], p_reason);",
      );
      // close_proceeding locks the meetings, then the committee row, before it checks anything in flight.
      const close = commands.find((c) => c.name === "close_proceeding")!.src;
      const at = (needle: string) => close.indexOf(needle);
      expect(at("for update of m")).toBeGreaterThan(0);
      expect(at("for update of m")).toBeLessThan(at("cp.proceeding_id = v_p.id for update"));
      expect(at("cp.proceeding_id = v_p.id for update")).toBeLessThan(at("'VOTES_OPEN'"));
      const [lock] = await s.tx<{ src: string }[]>`
        select prosrc as src from pg_proc where oid = 'decision.require_package_proceeding_open(uuid)'::regprocedure`;
      expect(lock!.src).toMatch(/for share/);
    });
  });
});
