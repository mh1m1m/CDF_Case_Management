// Business architecture rebase, migration 2100 (ADR-046): people and access. Ambiguity rows AMB-017, AMB-022, AMB-023,
// AMB-044, AMB-121 and AMB-205, with the register's tests T-AMB-022 (a deactivated committee receives no referral) and
// T-AMB-071 (an external counsel account reaches only its packet). T-AMB-007 (the urgent notification) is in
// notifications.spec.ts, T-AMB-010 (the delegation) in referral-preliminary.spec.ts and T-AMB-122 (a revoked workbook
// is never staged) in bcp-import.spec.ts, where the register places them.
// Nothing here widens anyone's access: each row narrows, records or flags, and the delegation of preliminary approval
// is recorded without conferring the delegator's authority (that half waits for 2160).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  USERS,
  caseId,
  ownerScenario,
  scenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import { IC_SEATS, committeeIds, refer, seat } from "../support/committee";
import { draftPackage, requestLegalReview, voteOnPackage } from "../support/decision";

const REASON = "Synthetic: people and access test reason.";
const DECISION = "BOARD-DEMO-2100-001";
const OPS = "b0000000-0000-4000-8000-000000000001";
let caseA: string, caseB: string, ic: string, gc: string;

beforeAll(async () => {
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
  ({ ic, gc } = await committeeIds());
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

describe("committee deactivation (AMB-044)", () => {
  const deactivate = (s: Scenario, committee: string, reference: string | null = DECISION) =>
    s.tx`select api.deactivate_committee(${committee}, ${reference}, ${REASON}) as id`;
  const reactivate = (s: Scenario, committee: string) =>
    s.tx`select api.reactivate_committee(${committee}, ${DECISION}, ${REASON}) as id`;
  const draftReferral = (s: Scenario) =>
    s.tx`select api.create_referral(${OPS}, 'Synthetic referral', 'Synthetic: a referral to a deactivated committee.',
      'FRAUD', 'INTERNAL'::core.classification_level) as id`;

  it("T-AMB-022: a deactivated committee opens no proceeding and receives no referral, on every path; deactivation names its decision, is kept, and is refused while work is open", async () => {
    await ownerScenario(async (s) => {
      // Only COMMITTEE_ADMIN, and only with the decision and a reason.
      for (const u of ["caseManager", "committeeChair", "dpo"] as UserKey[]) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", () => deactivate(s, ic));
      }
      await s.as("platformAdmin");
      await s.expectError("CDF_NOT_FOUND", () => deactivate(s, randomUUID()));
      await s.expectError("CDF_INVALID:decision_reference", () => deactivate(s, ic, null));
      await s.expectError("CDF_CONFLICT:COMMITTEE_ACTIVE", () => reactivate(s, ic));
      const change = await one(deactivate(s, ic));
      await s.expectError("CDF_CONFLICT:COMMITTEE_INACTIVE", () => deactivate(s, ic));

      // No referral: the case path, the direct-referral path and the table itself.
      await s.expectError("CDF_INVALID:committee_id", () => refer(s, ic, caseB));
      await s.as("sectorHead");
      await s.expectError("CDF_CONFLICT:NO_INVESTIGATION_COMMITTEE", () => draftReferral(s));
      await s.asOwner();
      const [rs] = await s.tx<{ id: string }[]>`
        select id from committee.rule_set where committee_id = ${ic} and effective_to is null`;
      await s.expectError(
        "CDF_CONFLICT:COMMITTEE_INACTIVE",
        (tx) =>
          tx`insert into committee.committee_proceeding (proceeding_id, case_id, committee_id, rule_set_id, rule_snapshot,
               referred_by)
             values (${randomUUID()}, ${caseB}, ${ic}, ${rs!.id}, '{}', ${USERS.caseManager})`,
      );
      await s.expectError(
        "CDF_CONFLICT:COMMITTEE_INACTIVE",
        (tx) =>
          tx`insert into intake.referral (referral_number, sector_id, committee_id, title, summary, allegation_category,
               classification, prepared_by)
             values ('REF-DEMO-2100-0001', ${OPS}, ${ic}, 'Synthetic referral', 'Synthetic: inserted at the table.',
               'FRAUD', 'INTERNAL', ${USERS.sectorHead})`,
      );

      // The change is kept, read by the registry's readers only, and audited without the reason.
      await s.as("caseManager");
      expect(await s.tx`select id from committee.committee_status_change`).toEqual([]);
      await s.as("grcDirector");
      expect(
        await s.tx`select is_active, decision_reference, changed_by from committee.committee_status_change`,
      ).toEqual([{ is_active: false, decision_reference: DECISION, changed_by: USERS.platformAdmin }]);
      expect(await audited(s, "COMMITTEE_DEACTIVATED", ic)).toEqual([
        {
          category: "ADMIN",
          case_id: null,
          reason: null,
          metadata: { status_change_id: change, committee_code: "IC" },
        },
      ]);
      await s.asOwner();
      await s.expectError(
        "committee.committee_status_change is append-only",
        (tx) => tx`update committee.committee_status_change set decision_reference = 'BOARD-DEMO-REWRITTEN'`,
      );

      // Reactivated after the reconstituting decision, it receives referrals again; with one open it is not
      // deactivated, and nothing is moved.
      await s.as("grcDirector");
      await one(reactivate(s, ic));
      await s.as("sectorHead");
      const referral = await one(draftReferral(s));
      await s.as("platformAdmin");
      await s.expectError("CDF_CONFLICT:COMMITTEE_HAS_OPEN_WORK", () => deactivate(s, ic));
      await s.as("sectorHead");
      await s.tx`select api.withdraw_referral(${referral}, ${REASON})`;
      await seat(s, ic, IC_SEATS);
      const proceeding = await refer(s, ic, caseB);
      await s.as("platformAdmin");
      await s.expectError("CDF_CONFLICT:COMMITTEE_HAS_OPEN_WORK", () => deactivate(s, ic));
      await s.asOwner();
      expect(await s.tx`select status from committee.committee_proceeding where id = ${proceeding}`).toEqual([
        { status: "OPEN" },
      ]);
      expect(
        await s.tx`select is_active from committee.committee_status_change where committee_id = ${ic} order by changed_at`,
      ).toEqual([{ is_active: false }, { is_active: true }]);
    });
  });

  it("a deactivated grievance committee receives no grievance, at the table too", async () => {
    await ownerScenario(async (s) => {
      await s.as("platformAdmin");
      await one(deactivate(s, gc));
      await s.asOwner();
      const [rs] = await s.tx<{ id: string }[]>`
        select id from committee.rule_set where committee_id = ${gc} and effective_to is null`;
      await s.expectError(
        "CDF_CONFLICT:COMMITTEE_INACTIVE",
        (tx) =>
          tx`insert into grievance.grievance (case_id, kind, grievant_label, channel, original_submission_date,
               contested_decision_date, grounds, original_document_reference, rule_set_id, window_days, is_late,
               admissibility_decider, recorded_by)
             values (${caseA}, 'LINKED', 'Employee Sigma (synthetic)', 'PHYSICAL_SUBMISSION', now(), now(),
               'Synthetic: grounds filed with a deactivated committee.', 'LETTER-DEMO-2100', ${rs!.id}, 30, false,
               'SECRETARY', ${USERS.committeeSecretary})`,
      );
    });
  });
});

describe("external counsel accounts (AMB-121)", () => {
  const ENGAGEMENT = "ENG-DEMO-2100-0001";
  const flag = (s: Scenario, user: string, engagement: string | null = ENGAGEMENT) =>
    s.tx`select api.flag_external_counsel_account(${user}, ${engagement}, ${REASON})`;
  const setEnabled = async (s: OwnerScenario, value: string) => {
    await s.asOwner();
    await s.tx`update config.setting set value = ${value}, source_reference = 'Synthetic: test engagement decision.'
               where key = 'EXTERNAL_COUNSEL_ENABLED'`;
  };
  /** What legalB reads: the packets, the case's own tables, the directory and its permissions. */
  async function reach(s: Scenario) {
    await s.as("legalB");
    const [r] = await s.tx<Record<string, unknown>[]>`
      select (select coalesce(array_agg(id order by id), '{}') from decision.packet) as packets,
             (select count(*)::int from case_mgmt.case_record) as cases,
             (select count(*)::int from case_mgmt.case_subject) as subjects,
             (select count(*)::int from case_mgmt.allegation) as allegations,
             (select count(*)::int from decision.recommendation_package) as packages,
             (select count(*)::int from committee.committee_proceeding) as proceedings,
             (select coalesce(array_agg(id order by id), '{}') from iam.user_profile) as directory,
             authz.has_permission('LEGAL_OPINION_GIVE') as opinion,
             authz.can_discover_case() as discovers,
             authz.has_permission('EVIDENCE_DOWNLOAD') as downloads,
             authz.has_permission('BREAK_GLASS_REQUEST') as breaks_glass`;
    return r!;
  }

  /** What api.legal_review_view says the two opinion commands would answer the caller now. */
  async function reviewerFlags(s: Scenario, request: string) {
    const [r] = await s.tx<
      {
        v: {
          capabilities: { may_give_opinion: boolean; may_give_superseding_opinion: boolean };
          opinion_block: string | null;
          superseding_opinion_block: string | null;
        };
      }[]
    >`select api.legal_review_view(${request}) as v`;
    const { capabilities, opinion_block, superseding_opinion_block } = r!.v;
    return { ...capabilities, opinion_block, superseding_opinion_block };
  }

  it("T-AMB-071: an external counsel account reaches only the packet assigned to it, and only while external counsel is enabled; it holds no other role, seat, position, assignment, grant or link", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");

      // Flagging: a role administrator, never their own account; only a legal reviewer holding nothing else.
      await s.as("caseManager");
      await s.expectError("CDF_FORBIDDEN", () => flag(s, USERS.legalB));
      await s.as("platformAdmin");
      await s.expectError("CDF_FORBIDDEN", () => flag(s, USERS.platformAdmin));
      await s.expectError("CDF_INVALID:user_id", () => flag(s, USERS.revoked));
      await s.expectError("CDF_INVALID:user_id", () => flag(s, randomUUID()));
      await s.expectError("CDF_INVALID:engagement_reference", () => flag(s, USERS.legalB, null));
      await s.expectError("CDF_CONFLICT:ROLES_NOT_ELIGIBLE", () => flag(s, USERS.caseManager));
      await s.expectError("CDF_CONFLICT:ACCOUNT_HOLDS_ACCESS", () => flag(s, USERS.legal));
      await flag(s, USERS.legalB);
      await s.expectError("CDF_CONFLICT:ALREADY_EXTERNAL", () => flag(s, USERS.legalB));

      // Disabled (the default): no permission, no packet, no colleague in the directory; not assignable to a review.
      expect(await reach(s)).toEqual({
        packets: [],
        cases: 0,
        subjects: 0,
        allegations: 0,
        packages: 0,
        proceedings: 0,
        directory: [USERS.legalB],
        opinion: false,
        discovers: false,
        downloads: false,
        breaks_glass: false,
      });
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select * from api.request_case_for_legal_hold('CDF-DEMO-2026-0002', 'Synthetic: a lookup.')`,
      );
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_INVALID:assigned_to",
        (tx) => tx`select api.request_legal_review(${f.pkg}, ${USERS.legalB}, ${REASON}, null, null)`,
      );

      // Enabled: the review is assigned to it; it reads that packet and gives its opinion, and nothing else.
      await setEnabled(s, "true");
      const { request, packet } = await requestLegalReview(s, f);
      expect(await reach(s)).toEqual({
        packets: [packet],
        cases: 0,
        subjects: 0,
        allegations: 0,
        packages: 0,
        proceedings: 0,
        directory: [USERS.legalB],
        opinion: true,
        discovers: false,
        downloads: false,
        breaks_glass: false,
      });
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select * from api.request_case_for_legal_hold('CDF-DEMO-2026-0002', 'Synthetic: a lookup.')`,
      );
      // Known limitation (ADR-046; CDF-231): My Work gates its legal-review row on the case, which an external account
      // never passes, so the assigned review is not listed even while enabled. It fails closed: the packet above is
      // reachable and nothing more is shown. CDF-231 turns this into the positive assertion.
      expect(
        await s.tx`select target_id from api.my_work_items() where category = 'LEGAL_REVIEW_ASSIGNED'`,
      ).toEqual([]);

      // Whatever the setting, nothing else is given to it, on any path.
      await s.asOwner();
      for (const insert of [
        (tx: Scenario["tx"]) =>
          tx`insert into iam.user_role_assignment (user_id, role_code, justification, granted_by)
             values (${USERS.legalB}, 'INVESTIGATOR', ${REASON}, ${USERS.platformAdmin})`,
        (tx: Scenario["tx"]) =>
          tx`insert into case_mgmt.case_assignment (case_id, user_id, assignment_role, reason, assigned_by)
             values (${caseB}, ${USERS.legalB}, 'INVESTIGATOR', ${REASON}, ${USERS.caseManager})`,
        (tx: Scenario["tx"]) =>
          tx`insert into case_mgmt.case_access_grant (case_id, user_id, scope, reason, granted_by)
             values (${caseB}, ${USERS.legalB}, 'CASE', ${REASON}, ${USERS.caseManager})`,
        (tx: Scenario["tx"]) =>
          tx`insert into committee.membership (committee_id, user_id, seat, effective_from, appointment_reference,
               appointed_by)
             values (${ic}, ${USERS.legalB}, 'ALTERNATE_MEMBER', now(), 'DEMO-APPT', ${USERS.platformAdmin})`,
        (tx: Scenario["tx"]) =>
          tx`insert into iam.sector_membership (sector_id, user_id, position, effective_from, appointment_reference)
             values (${OPS}, ${USERS.legalB}, 'MEMBER', now(), 'DEMO-APPT')`,
        (tx: Scenario["tx"]) =>
          tx`insert into grievance.subject_portal_link (case_id, subject_id, user_id, reason, linked_by)
             values (${caseB}, ${f.subject}, ${USERS.legalB}, ${REASON}, ${USERS.caseManager})`,
      ]) {
        await s.expectError("CDF_CONFLICT:EXTERNAL_ACCOUNT", insert);
      }
      await s.as("platformAdmin");
      await s.expectError(
        "CDF_CONFLICT:EXTERNAL_ACCOUNT",
        (tx) => tx`select api.grant_role(${USERS.legalB}, 'INVESTIGATOR', ${REASON})`,
      );

      // The reviewer's read model (2095) answers as each opinion command does: its mirrors take the packet gate too.
      await s.as("legalB");
      expect(await reviewerFlags(s, request)).toEqual({
        may_give_opinion: true,
        may_give_superseding_opinion: false,
        opinion_block: null,
        superseding_opinion_block: "OPINION_NOT_GIVEN",
      });
      await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
      expect(await reviewerFlags(s, request)).toEqual({
        may_give_opinion: false,
        may_give_superseding_opinion: true,
        opinion_block: "OPINION_ALREADY_GIVEN",
        superseding_opinion_block: null,
      });
      await s.tx`select api.give_superseding_legal_opinion(${request}, 'CONCURS_WITH_COMMENTS', ${REASON})`;

      // Disabled again: the packet is out of reach at once, and so is the read model.
      await setEnabled(s, "false");
      expect((await reach(s)).packets).toEqual([]);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`,
      );
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.give_superseding_legal_opinion(${request}, 'CONCURS', null)`,
      );
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.legal_review_view(${request})`);

      // The flag is kept, read by the account and role administrators, and audited without the reason.
      await s.as("caseManager");
      expect(await s.tx`select user_id from iam.external_account`).toEqual([]);
      await s.as("legalB");
      expect(await s.tx`select user_id, engagement_reference from iam.external_account`).toEqual([
        { user_id: USERS.legalB, engagement_reference: ENGAGEMENT },
      ]);
      expect(await audited(s, "EXTERNAL_COUNSEL_FLAGGED", USERS.legalB)).toEqual([
        { category: "ADMIN", case_id: null, reason: null, metadata: {} },
      ]);
      await s.asOwner();
      await s.expectError(
        "iam.external_account is append-only",
        (tx) => tx`delete from iam.external_account where user_id = ${USERS.legalB}`,
      );
    });
  });
  it("a current delegate of preliminary approval is not flagged, and a flagged account never becomes a delegate", async () => {
    await scenario(async (s) => {
      const delegateTo = (to: string) =>
        s.tx<{ id: string }[]>`
          select api.delegate_preliminary_approval(${to}, null, now() + interval '7 days', 'DEMO-DEL-2100', ${REASON}) as id`;
      await s.as("grcSectorHead");
      const [d] = await delegateTo(USERS.legalB);
      await s.as("platformAdmin");
      await s.expectError("CDF_CONFLICT:ACCOUNT_HOLDS_ACCESS", () => flag(s, USERS.legalB));
      await s.as("grcSectorHead");
      await s.tx`select api.revoke_preliminary_approval_delegation(${d!.id}, 'Synthetic: engagement starts.')`;
      await s.as("platformAdmin");
      await flag(s, USERS.legalB);
      await s.as("grcSectorHead");
      await s.expectError("CDF_INVALID:delegate_id", () => delegateTo(USERS.legalB));
    });
  });
});

describe("an external or technical expert (AMB-022)", () => {
  const task = (s: Scenario, o: { scope?: string[] | null; expires?: string | null } = {}) =>
    s.tx<{ id: string }[]>`
      select api.create_case_task(${caseB}, 'EXTERNAL_EXPERT', ${USERS.employeeB},
        'Synthetic: a technical opinion on the payment records.', ${o.scope ?? null}::text[], null,
        ${o.expires ?? null}::timestamptz) as id`;

  it("supports a review through a task only: the role holds no permission and the task gives the case's metadata for a limited time, never its content", async () => {
    await ownerScenario(async (s) => {
      // Only a holder of EXTERNAL_EXPERT takes the task.
      await s.as("caseManager");
      await s.expectError("CDF_INVALID:assigned_user_id", () => task(s));
      await s.as("platformAdmin");
      await s.tx`select api.grant_role(${USERS.employeeB}, 'EXTERNAL_EXPERT', ${REASON})`;
      await s.asOwner();
      expect(
        await s.tx`select count(*)::int as n from iam.role_permission where role_code = 'EXTERNAL_EXPERT'`,
      ).toEqual([{ n: 0 }]);

      // Metadata only, at most 30 days; the task type offers nothing else.
      await s.as("caseManager");
      await s.expectError("CDF_INVALID:scope", () =>
        task(s, { scope: ["CASE_VIEW_METADATA", "LEGAL_HOLD_REQUEST"] }),
      );
      await s.expectError("CDF_INVALID:expires_at", () => task(s, { expires: "2999-01-01T00:00:00Z" }));
      const id = await one(task(s));
      await s.asOwner();
      expect(
        await s.tx`select scope, expires_at <= now() + interval '7 days' as within from case_mgmt.case_task where id = ${id}`,
      ).toEqual([{ scope: ["CASE_VIEW_METADATA"], within: true }]);

      // The expert opens the task and sees the case's metadata; never its content, its subjects or its evidence.
      await s.as("employeeB");
      expect(await one(s.tx`select api.open_case_task(${id}) as ok`)).toBe(true);
      expect(
        await s.tx`select authz.can_view_case_metadata(${caseB}) as metadata, authz.can_view_case(${caseB}) as content,
                     authz.can_discover_case() as discovers`,
      ).toEqual([{ metadata: true, content: false, discovers: false }]);
      expect(await s.tx`select id from case_mgmt.case_subject where case_id = ${caseB}`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.allegation where case_id = ${caseB}`).toEqual([]);
    });
  });
});
