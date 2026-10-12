// CDF-62 · §29, §74, ADR-005, threat T09: no state-changing command can run without leaving its audit event
// in the same transaction, a refused command leaves no business event, and the application-facing security
// event command cannot be used to forge business history. The coverage guard makes a new state-changing
// api.* function fail this file until the walk below exercises it.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  USERS,
  admin,
  caseId,
  ownerScenario,
  reportId,
  scenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import { addShortRetentionClass, legalHoldTasks } from "../support/records";

let caseA: string, caseB: string;
let receivedReport: string, infoReport: string;
beforeAll(async () => {
  [caseA, caseB, receivedReport, infoReport] = await Promise.all([
    caseId("0001"),
    caseId("0002"),
    reportId("WB-SEED00000005"),
    reportId("WB-SEED00000006"),
  ]);
});

const REASON = "Synthetic: audit regression walk.";
// Forms engine (CDF-50): valid content for an investigation form and a committee form.
const FORM_DATA = {
  evidenceRegister: {
    evidence_count: "2",
    evidence_scope: "Synthetic: audit walk register.",
    chain_of_custody_status: "مكتملة",
    storage_confirmation: "true",
  },
  committeeFormation: {
    formation_reference: "CDF-DEMO-WALK-0001",
    formation_date: "2026-03-01",
    chair: "Committee Chair Xi",
    members: "Committee Member Epsilon",
    secretary: "Committee Secretary Nu",
    scope: "Synthetic: audit walk committee.",
    independence_confirmed: "true",
  },
};
// Read-only or event-only functions: they are not state-changing commands for this guard.
const NOT_STATE_CHANGING = new Set([
  "available_transitions",
  "list_identity_reveal_requests",
  "verify_audit_chain",
  "record_security_event",
  "open_case",
  "open_report",
  "open_evidence_version",
  "list_records",
  "verify_disposition_certificate",
  // CDF-73: reads of the caller's own work and the authorised catalogue; open_case_metadata records a view.
  "my_case_tasks",
  "my_work_summary",
  // S1 read models: the caller's own areas, work items and access basis (no object is opened).
  "my_areas",
  "my_work_items",
  "my_access",
  "open_case_metadata",
  "search_records_catalogue",
  "open_report_attachment",
  // DEC-01 (ADR-016): names of the people a restricted case may be handed to; opening the report is audited.
  "list_restricted_case_authorities",
  // Direct referral and preliminary review (migration 1880): the caller's next actions and approval queue.
  "referral_available_actions",
  "preliminary_approval_queue",
  // Committee meetings (migration 1890): who has voted, and choices only after close.
  "vote_item_status",
]);

interface Step {
  fn: string;
  actor: UserKey;
  run: (s: Scenario) => Promise<unknown>;
}

/** Runs one command under a fresh request id and returns the audit events that request produced. */
async function audited(s: Scenario, step: Step) {
  const requestId = randomUUID();
  await s.as(step.actor);
  await s.tx`select set_config('cdf.request_id', ${requestId}, true)`;
  const value = await step.run(s);
  await s.as("dpo"); // AUDIT_VIEW + SECURITY_EVENT_VIEW: reads every category
  const events = await s.tx<{ action: string; category: string; outcome: string; actor_id: string | null }[]>`
    select action, category, outcome, actor_id from audit.audit_event where request_id = ${requestId} order by seq`;
  return { value, events };
}

describe("every state-changing command writes its audit event in the same transaction", () => {
  it("walks every state-changing api.* command and finds a SUCCESS event by the actor for each", async () => {
    const catalog = await admin<{ name: string }[]>`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and has_function_privilege('authenticated', p.oid, 'EXECUTE')`;
    const mustCover = catalog.map((r) => r.name).filter((n) => !NOT_STATE_CHANGING.has(n));

    const ids: Record<string, string> = {};
    const one = async (s: Scenario, q: Promise<readonly Record<string, unknown>[]>) => {
      const rows = await q;
      return Object.values(rows[0] ?? {})[0] as string;
    };
    const steps: Step[] = [
      {
        fn: "triage_report",
        actor: "triage",
        run: (s) => s.tx`select api.triage_report(${receivedReport}, 'OPEN_CASE', ${REASON}, null, null)`,
      },
      {
        fn: "create_case_from_report",
        actor: "triage",
        run: async (s) =>
          (ids.case = await one(
            s,
            s.tx`select api.create_case_from_report(${receivedReport}, 'Audit walk case (synthetic)', 'Synthetic audit walk summary.', 'RESTRICTED'::core.classification_level, false) as id`,
          )),
      },
      {
        fn: "transition_case",
        actor: "triage",
        run: (s) => s.tx`select api.transition_case(${ids.case!}, 'START_SCREENING', null)`,
      },
      {
        fn: "update_case_details",
        actor: "caseManager",
        run: async (s) => {
          const [c] = await s.tx<
            { v: number }[]
          >`select row_version as v from case_mgmt.case_record where id = ${caseA}`;
          return s.tx`select api.update_case_details(${caseA}, 'Duplicate invoice approvals (synthetic)', 'Synthetic summary, edited.', 'HIGH', ${c!.v})`;
        },
      },
      {
        fn: "change_case_classification",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.change_case_classification(${caseB}, 'CONFIDENTIAL'::core.classification_level, false, ${REASON})`,
      },
      {
        fn: "assign_case",
        actor: "caseManager",
        run: async (s) =>
          (ids.assignment = await one(
            s,
            s.tx`select api.assign_case(${caseB}, ${USERS.investigatorA}, 'INVESTIGATOR', ${REASON}) as id`,
          )),
      },
      {
        fn: "reassign_case",
        actor: "caseManager",
        run: async (s) =>
          (ids.reassigned = await one(
            s,
            s.tx`select api.reassign_case(${ids.assignment!}, ${USERS.lead}, ${REASON}) as id`,
          )),
      },
      {
        fn: "end_assignment",
        actor: "caseManager",
        run: (s) => s.tx`select api.end_assignment(${ids.reassigned!}, ${REASON})`,
      },
      {
        fn: "grant_case_access",
        actor: "caseManager",
        run: async (s) =>
          (ids.grant = await one(
            s,
            s.tx`select api.grant_case_access(${caseB}, ${USERS.committee}, 'COMMITTEE', ${REASON}, null) as id`,
          )),
      },
      {
        fn: "revoke_case_access",
        actor: "caseManager",
        run: (s) => s.tx`select api.revoke_case_access(${ids.grant!}, ${REASON})`,
      },
      {
        fn: "declare_conflict",
        actor: "grcDeputy", // declaring ends one's own assignments, so not the case's investigator
        run: async (s) =>
          (ids.conflict = await one(
            s,
            s.tx`select api.declare_conflict(${caseB}, true, 'Synthetic: audit walk declaration.') as id`,
          )),
      },
      {
        fn: "decide_conflict",
        actor: "caseManager",
        run: (s) => s.tx`select api.decide_conflict(${ids.conflict!}, 'CONFLICT_CLEARED', ${REASON})`,
      },
      {
        fn: "reply_to_reporter",
        actor: "intake",
        run: (s) =>
          s.tx`select api.reply_to_reporter(${infoReport}, 'Synthetic follow-up question for the reporter.')`,
      },
      {
        fn: "request_identity_reveal",
        actor: "grcDirector",
        run: async (s) =>
          (ids.reveal = await one(
            s,
            s.tx`select api.request_identity_reveal(${caseB}, 'Synthetic: need to contact the reporter for documents.') as id`,
          )),
      },
      {
        fn: "decide_identity_reveal",
        actor: "grcDeputy",
        run: (s) => s.tx`select api.decide_identity_reveal(${ids.reveal!}, true, ${REASON})`,
      },
      {
        fn: "resolve_reporter_identity",
        actor: "grcDirector",
        run: (s) =>
          s.tx`select * from api.resolve_reporter_identity(${caseB}, 'Synthetic: need to contact the reporter for documents.')`,
      },
      {
        fn: "register_evidence_version",
        actor: "investigatorB",
        run: async (s) => {
          const [r] = await s.tx<{ v: string }[]>`
            select o_version_id as v from api.register_evidence_version(${caseB}, null, 'Audit walk item (synthetic)', null,
              'DOCUMENT', 'Synthetic source', null, 'CONFIDENTIAL'::core.classification_level, 'walk.pdf', 'application/pdf', 512, ${"1".repeat(64)})`;
          return (ids.version = r!.v);
        },
      },
      {
        fn: "complete_evidence_version",
        actor: "investigatorB",
        run: (s) => s.tx`select api.complete_evidence_version(${ids.version!}, 'CLEAN', 'walk-scanner')`,
      },
      {
        fn: "reject_evidence_version",
        actor: "investigatorB",
        run: async (s) => {
          const [r] = await s.tx<{ v: string }[]>`
            select o_version_id as v from api.register_evidence_version(${caseB}, null, 'Audit walk item 2 (synthetic)', null,
              'DOCUMENT', 'Synthetic source', null, 'CONFIDENTIAL'::core.classification_level, 'walk2.pdf', 'application/pdf', 512, ${"2".repeat(64)})`;
          return s.tx`select api.reject_evidence_version(${r!.v}, 'MALWARE_DETECTED', 'INFECTED', 'walk-scanner')`;
        },
      },
      // Purpose-bound access (CDF-73, ADR-014) on case A, which the case manager can see.
      {
        fn: "create_case_task",
        actor: "caseManager",
        run: async (s) =>
          (ids.task = await one(
            s,
            s.tx`select api.create_case_task(${caseA}, 'LEGAL_REVIEW', ${USERS.legal}, 'Synthetic: audit walk legal review.') as id`,
          )),
      },
      {
        fn: "open_case_task",
        actor: "legal",
        run: (s) => s.tx`select api.open_case_task(${ids.task!})`,
      },
      {
        fn: "request_break_glass",
        actor: "legal",
        run: async (s) =>
          (ids.breakGlass = await one(
            s,
            s.tx`select api.request_break_glass(${caseA}, 'Synthetic: audit walk break-glass reason.', 30) as id`,
          )),
      },
      {
        fn: "decide_break_glass",
        actor: "grcDirector",
        run: (s) => s.tx`select api.decide_break_glass(${ids.breakGlass!}, true, ${REASON})`,
      },
      {
        fn: "end_break_glass",
        actor: "legal",
        run: (s) => s.tx`select api.end_break_glass(${ids.breakGlass!})`,
      },
      {
        fn: "review_break_glass",
        actor: "grcDeputy", // neither the requester nor the approver (CDF-78)
        run: (s) => s.tx`select api.review_break_glass(${ids.breakGlass!}, 'APPROPRIATE', ${REASON})`,
      },
      {
        fn: "complete_case_task",
        actor: "legal",
        run: (s) => s.tx`select api.complete_case_task(${ids.task!}, ${REASON})`,
      },
      {
        fn: "cancel_case_task",
        actor: "caseManager",
        run: async (s) => {
          const id = await one(
            s,
            s.tx`select api.create_case_task(${caseA}, 'LEGAL_REVIEW', ${USERS.legalB}, 'Synthetic: audit walk task to cancel.') as id`,
          );
          return s.tx`select api.cancel_case_task(${id}, ${REASON})`;
        },
      },
      {
        fn: "expire_case_tasks", // the lapsed task is inserted before the walk
        actor: "caseManager",
        run: (s) => s.tx`select api.expire_case_tasks()`,
      },
      {
        fn: "request_legal_hold",
        actor: "caseManager",
        run: async (s) =>
          (ids.holdRequest = await one(
            s,
            s.tx`select api.request_legal_hold(${caseA}, 'LITIGATION', 'Synthetic: audit walk hold request.') as id`,
          )),
      },
      {
        fn: "assign_legal_hold_request",
        actor: "caseManager",
        run: (s) => s.tx`select api.assign_legal_hold_request(${ids.holdRequest!}, ${USERS.legal})`,
      },
      {
        fn: "review_legal_hold_request",
        actor: "legal",
        run: (s) => s.tx`select api.review_legal_hold_request(${ids.holdRequest!}, false, ${REASON})`,
      },
      {
        fn: "request_case_for_legal_hold",
        actor: "records", // not used by the committed integration lookups, so never rate limited here
        run: async (s) => {
          const [c] = await admin<
            { n: string }[]
          >`select case_number as n from case_mgmt.case_record where id = ${caseA}`;
          return s.tx`select * from api.request_case_for_legal_hold(${c!.n}, 'Synthetic: audit walk controlled lookup.')`;
        },
      },
      // ---- Interviews (CDF-60, ADR-012): one interview on case A carried from plan to prepared -----------
      {
        fn: "plan_interview",
        actor: "investigatorA",
        run: async (s) =>
          (ids.interview = await one(
            s,
            s.tx`select api.plan_interview(${caseA}, 'Audit walk interview (synthetic)', null, 'WITNESS',
              'Witness Walk (synthetic)', null, 'CONFIDENTIAL'::core.classification_level) as id`,
          )),
      },
      {
        fn: "add_interview_participant",
        actor: "investigatorA",
        run: (s) =>
          s.tx`select api.add_interview_participant(${ids.interview!}, ${USERS.lead}, 'NOTE_TAKER')`,
      },
      {
        fn: "schedule_interview",
        actor: "investigatorA",
        run: (s) =>
          s.tx`select api.schedule_interview(${ids.interview!}, now() - interval '2 hours', 60, 'IN_PERSON', null)`,
      },
      {
        fn: "issue_interview_notice",
        actor: "investigatorA",
        run: (s) =>
          s.tx`select api.issue_interview_notice(${ids.interview!}, 'INVITATION', 'INTERNAL_EMAIL')`,
      },
      {
        fn: "record_interview_rights",
        actor: "investigatorA",
        run: (s) =>
          s.tx`select api.record_interview_rights(${ids.interview!}, 'SIGNED_FORM', 'SYNTHETIC-RIGHTS-V1')`,
      },
      {
        fn: "record_interview_conducted",
        actor: "investigatorA",
        run: (s) =>
          s.tx`select api.record_interview_conducted(${ids.interview!}, now() - interval '2 hours', now() - interval '1 hour')`,
      },
      {
        fn: "record_interview_statement",
        actor: "investigatorA",
        run: async (s) => {
          const [v] = await s.tx<{ id: string; sha: string }[]>`
            select o_version_id as id, o_sha256 as sha
            from api.record_interview_statement(${ids.interview!}, 'Synthetic audit walk statement.', 'en')`;
          ids.statement = v!.id;
          return (ids.statementSha = v!.sha);
        },
      },
      {
        fn: "acknowledge_interview_statement",
        actor: "investigatorA",
        run: (s) =>
          s.tx`select api.acknowledge_interview_statement(${ids.statement!}, 'SIGNED_PAPER', ${ids.statementSha!})`,
      },
      {
        fn: "link_interview_recording",
        actor: "investigatorA",
        run: async (s) => {
          const [r] = await s.tx<{ v: string; e: string }[]>`
            select o_version_id as v, o_evidence_id as e from api.register_evidence_version(${caseA}, null,
              'Audit walk recording (synthetic)', null, 'DOCUMENT', 'Synthetic source', null,
              'CONFIDENTIAL'::core.classification_level, 'statement.pdf', 'application/pdf', 512, ${"3".repeat(64)})`;
          await s.tx`select api.complete_evidence_version(${r!.v}, 'CLEAN', 'walk-scanner')`;
          return s.tx`select api.link_interview_recording(${ids.interview!}, ${r!.e})`;
        },
      },
      {
        fn: "transition_interview",
        actor: "investigatorA",
        run: (s) => s.tx`select api.transition_interview(${ids.interview!}, 'PREPARE')`,
      },
      {
        fn: "open_interview",
        actor: "lead",
        run: (s) => s.tx`select api.open_interview(${ids.interview!})`,
      },
      // Business architecture rebase (ADR-017 to ADR-019): a proceeding with a subject, allegation, finding and
      // supporting material on case A; the committee registry; a referral that snapshots the committee.
      {
        fn: "open_proceeding",
        actor: "caseManager",
        run: async (s) =>
          (ids.proceeding = await one(
            s,
            s.tx`select api.open_proceeding(${caseA}, 'INVESTIGATION', null, ${REASON}) as id`,
          )),
      },
      {
        fn: "update_proceeding_state",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.update_proceeding_state(${ids.proceeding!}, 'IN_PROGRESS', 'DOCUMENTS', null, ${REASON})`,
      },
      {
        fn: "add_case_subject",
        actor: "caseManager",
        run: async (s) =>
          (ids.subject = await one(
            s,
            s.tx`select api.add_case_subject(${caseA}, 'Employee Omicron (synthetic)', 'EMPLOYEE', null) as id`,
          )),
      },
      {
        fn: "add_allegation",
        actor: "caseManager",
        run: async (s) =>
          (ids.allegation = await one(
            s,
            s.tx`select api.add_allegation(${caseA}, 'CONFLICT_OF_INTEREST', 'Synthetic: second allegation for the walk.',
              ${ids.subject!}, 'POL-DEMO-01', null) as id`,
          )),
      },
      {
        fn: "link_allegation_subject",
        actor: "caseManager",
        run: async (s) => {
          const [a] = await admin<{ id: string }[]>`
            select id from case_mgmt.allegation where case_id = ${caseA} and subject_id is null order by created_at limit 1`;
          return s.tx`select api.link_allegation_subject(${a!.id}, ${ids.subject!}, null, 'LAW-DEMO-01')`;
        },
      },
      {
        fn: "record_finding",
        actor: "investigatorA",
        run: async (s) =>
          (ids.finding = await one(
            s,
            s.tx`select api.record_finding(${ids.allegation!}, null, ${ids.proceeding!}, 'SUBSTANTIATED',
              'Synthetic: the walk finding rationale.') as id`,
          )),
      },
      {
        fn: "link_supporting_material",
        actor: "investigatorA",
        run: async (s) => {
          const [r] = await s.tx<{ v: string; e: string }[]>`
            select o_version_id as v, o_evidence_id as e from api.register_evidence_version(${caseA}, null,
              'Audit walk support (synthetic)', null, 'DOCUMENT', 'Synthetic source', null,
              'CONFIDENTIAL'::core.classification_level, 'support.pdf', 'application/pdf', 512, ${"4".repeat(64)})`;
          await s.tx`select api.complete_evidence_version(${r!.v}, 'CLEAN', 'walk-scanner')`;
          return s.tx`select api.link_supporting_material(${r!.e}, null, ${ids.finding!})`;
        },
      },
      {
        fn: "appoint_committee_member",
        actor: "platformAdmin",
        run: async (s) => {
          const [ic] = await admin<{ id: string }[]>`select id from committee.committee where code = 'IC'`;
          ids.committee = ic!.id;
          await s.tx`select api.appoint_committee_member(${ic!.id}, ${USERS.committeeChair}, 'CHAIR', now(), null, 'DEMO-APPT-01')`;
          await s.tx`select api.appoint_committee_member(${ic!.id}, ${USERS.committeeSecretary}, 'SECRETARY', now(), null, 'DEMO-APPT-02')`;
          return (ids.membership = await one(
            s,
            s.tx`select api.appoint_committee_member(${ic!.id}, ${USERS.committee}, 'MEMBER', now(), null, 'DEMO-APPT-03') as id`,
          ));
        },
      },
      {
        fn: "set_committee_rule_set",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.set_committee_rule_set(${ids.committee!}, now(), 'FIXED_NUMBER', 2, true, 3, true, null, null,
            'NO_DECISION', 'SOURCE_REQUIRED', ${REASON})`,
      },
      {
        fn: "refer_case_to_committee",
        actor: "caseManager",
        run: async (s) =>
          (ids.committeeProceeding = await one(
            s,
            s.tx`select api.refer_case_to_committee(${caseA}, ${ids.committee!}, ${ids.proceeding!}, ${REASON}) as id`,
          )),
      },
      {
        fn: "end_committee_membership",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.end_committee_membership(${ids.membership!}, now() + interval '1 day', ${REASON})`,
      },
      // Committee meeting (migration 1890): chair and member declare, attend and vote; a tie goes to the chair's
      // casting vote; the secretary records a non-substantive vote; minutes are reviewed and deemed approved.
      {
        fn: "schedule_meeting",
        actor: "committeeSecretary",
        run: async (s) => {
          ids.meeting = await one(
            s,
            s.tx`select api.schedule_meeting(${ids.committeeProceeding!}, 'DELIBERATION', 'HYBRID', 'Room (synthetic)',
              'https://meet.example.test/walk', now() + interval '1 day', now() + interval '1 day 2 hours', ${REASON}) as id`,
          );
          const rows = await s.tx<{ id: string; user_id: string }[]>`
            select id, user_id from committee.meeting_participant where meeting_id = ${ids.meeting}`;
          ids.chairSeat = rows.find((r) => r.user_id === USERS.committeeChair)!.id;
          ids.memberSeat = rows.find((r) => r.user_id === USERS.committee)!.id;
          return ids.meeting;
        },
      },
      {
        fn: "invite_to_meeting",
        actor: "committeeSecretary",
        run: (s) =>
          s.tx`select api.invite_to_meeting(${ids.meeting!}, 'EXPERT', ${USERS.lead}, null, false, ${REASON})`,
      },
      {
        fn: "declare_meeting_conflict",
        actor: "committee",
        run: (s) => s.tx`select api.declare_meeting_conflict(${ids.memberSeat!}, 'NO_CONFLICT', null)`,
      },
      {
        fn: "declare_meeting_conflict",
        actor: "committeeChair",
        run: (s) => s.tx`select api.declare_meeting_conflict(${ids.chairSeat!}, 'NO_CONFLICT', null)`,
      },
      {
        fn: "open_meeting",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.open_meeting(${ids.meeting!}, ${REASON})`,
      },
      {
        fn: "record_attendance",
        actor: "committeeSecretary",
        run: async (s) => {
          await s.tx`select api.record_attendance(${ids.chairSeat!}, 'PRESENT')`;
          return s.tx`select api.record_attendance(${ids.memberSeat!}, 'PRESENT')`;
        },
      },
      {
        fn: "open_vote_item",
        actor: "committeeSecretary",
        run: async (s) =>
          (ids.voteItem = await one(
            s,
            s.tx`select api.open_vote_item(${ids.meeting!}, 'OTHER', null, 'Walk recommendation (synthetic)') as id`,
          )),
      },
      {
        fn: "cast_vote",
        actor: "committee",
        run: (s) => s.tx`select api.cast_vote(${ids.voteItem!}, 'APPROVE', null)`,
      },
      {
        fn: "cast_vote",
        actor: "committeeChair",
        run: (s) => s.tx`select api.cast_vote(${ids.voteItem!}, 'REJECT', null)`,
      },
      {
        fn: "close_vote_item",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.close_vote_item(${ids.voteItem!}, null)`,
      },
      {
        fn: "cast_casting_vote",
        actor: "committeeChair",
        run: (s) =>
          s.tx`select api.cast_casting_vote(${ids.voteItem!}, 'APPROVE', 'Synthetic: casting vote.')`,
      },
      {
        fn: "record_vote_for_member",
        actor: "committeeSecretary",
        run: async (s) => {
          // Only for a member who is not present (AGENT-09 V1b); attendance changes only between vote items.
          await s.tx`select api.record_attendance(${ids.memberSeat!}, 'ABSENT')`;
          const item = await one(
            s,
            s.tx`select api.open_vote_item(${ids.meeting!}, 'OTHER', null, 'Walk second item (synthetic)') as id`,
          );
          return s.tx`select api.record_vote_for_member(${item}, ${ids.memberSeat!}, 'UNABLE_TO_VOTE',
            'Synthetic: connection lost.', null)`;
        },
      },
      {
        fn: "cast_vote",
        actor: "committeeChair",
        run: (s) => s.tx`
          select api.cast_vote((select id from committee.vote_item where meeting_id = ${ids.meeting!} and sequence_no = 2),
            'APPROVE', null)`,
      },
      {
        fn: "close_vote_item",
        actor: "committeeSecretary",
        run: async (s) => {
          const r = await s.tx`
            select api.close_vote_item((select id from committee.vote_item where meeting_id = ${ids.meeting!} and sequence_no = 2), null)`;
          // The member is back for the end of the meeting, so they review the minutes.
          await s.tx`select api.record_attendance(${ids.memberSeat!}, 'PRESENT')`;
          return r;
        },
      },
      // Recommendation package (migration 1900): drafted, voted and adopted in the open meeting, reviewed by Legal,
      // sent to the authority and decided.
      {
        fn: "set_action_authority_rule",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.set_action_authority_rule('CORRECTIVE_ACTION', 'DELEGATED_EXECUTIVE', now(), 'SOURCE_REQUIRED', ${REASON})`,
      },
      {
        fn: "create_recommendation_package",
        actor: "committeeSecretary",
        run: async (s) =>
          (ids.pkg = await one(
            s,
            s.tx`select api.create_recommendation_package(${ids.committeeProceeding!}, 'PACKAGE') as id`,
          )),
      },
      {
        fn: "add_recommendation_item",
        actor: "committeeSecretary",
        run: async (s) => {
          ids.recItem = await one(
            s,
            s.tx`select api.add_recommendation_item(${ids.pkg!}, 'OTHER', null, null, 'Synthetic: walk recommendation.', null, null) as id`,
          );
          return s.tx`select api.add_recommendation_item(${ids.pkg!}, 'CORRECTIVE_ACTION', null, null,
            'Synthetic: walk corrective action.', null, null)`;
        },
      },
      {
        fn: "withdraw_recommendation_item",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.withdraw_recommendation_item(${ids.recItem!}, ${REASON})`,
      },
      {
        fn: "submit_package_for_vote",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.submit_package_for_vote(${ids.pkg!})`,
      },
      {
        fn: "open_package_vote",
        actor: "committeeSecretary",
        run: async (s) => {
          const r = await s.tx`select api.open_package_vote(${ids.meeting!}, ${ids.pkg!})`;
          ids.pkgVote = await one(s, s.tx`select id from committee.vote_item where package_id = ${ids.pkg!}`);
          return r;
        },
      },
      {
        fn: "cast_vote",
        actor: "committee",
        run: (s) => s.tx`select api.cast_vote(${ids.pkgVote!}, 'APPROVE', null)`,
      },
      {
        fn: "cast_vote",
        actor: "committeeChair",
        run: (s) => s.tx`select api.cast_vote(${ids.pkgVote!}, 'APPROVE', null)`,
      },
      {
        fn: "close_vote_item",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.close_vote_item(${ids.pkgVote!}, null)`,
      },
      {
        fn: "record_package_adoption",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.record_package_adoption(${ids.pkg!})`,
      },
      {
        fn: "request_legal_review",
        actor: "committeeSecretary",
        run: async (s) => {
          ids.legalRequest = await one(
            s,
            s.tx`select api.request_legal_review(${ids.pkg!}, ${USERS.legalB}, ${REASON}, null, null) as id`,
          );
          ids.packet = await one(
            s,
            s.tx`select id from decision.packet where legal_review_request_id = ${ids.legalRequest}`,
          );
          return ids.legalRequest;
        },
      },
      {
        fn: "open_packet",
        actor: "legalB",
        run: (s) => s.tx`select api.open_packet(${ids.packet!})`,
      },
      {
        fn: "give_legal_opinion",
        actor: "legalB",
        run: (s) => s.tx`select api.give_legal_opinion(${ids.legalRequest!}, 'CONCURS', null)`,
      },
      {
        fn: "submit_to_authority",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.submit_to_authority(${ids.pkg!})`,
      },
      {
        fn: "record_authority_decision",
        actor: "committeeSecretary",
        run: (s) =>
          s.tx`select api.record_authority_decision(${ids.pkg!}, 'DELEGATED_EXECUTIVE', 'APPROVE_AS_RECOMMENDED',
            now() - interval '1 hour', 'Delegated executive (synthetic)', 'MEMO-DEMO-WALK', null, ${REASON})`,
      },
      {
        fn: "close_meeting",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.close_meeting(${ids.meeting!}, ${REASON})`,
      },
      {
        fn: "generate_minutes",
        actor: "committeeSecretary",
        run: async (s) =>
          (ids.minutes = await one(
            s,
            s.tx`select api.generate_minutes(${ids.meeting!}, 'Synthetic minutes narrative for the walk.') as id`,
          )),
      },
      {
        fn: "review_minutes",
        actor: "committee",
        run: (s) => s.tx`select api.review_minutes(${ids.minutes!}, 'APPROVE', null)`,
      },
      {
        fn: "record_minutes_reminder",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.record_minutes_reminder(${ids.minutes!})`,
      },
      {
        fn: "apply_minutes_deemed_approval",
        actor: "committeeSecretary",
        run: async (s) => {
          // Fixture: the review window has passed (the owner may only shorten it).
          await (s as OwnerScenario).asOwner();
          await s.tx`update committee.minutes set review_due_at = now() - interval '1 minute' where id = ${ids.minutes!}`;
          await s.as("committeeSecretary");
          return s.tx`select api.apply_minutes_deemed_approval(${ids.minutes!})`;
        },
      },
      {
        fn: "cancel_meeting",
        actor: "committeeSecretary",
        run: async (s) => {
          const m = await one(
            s,
            s.tx`select api.schedule_meeting(${ids.committeeProceeding!}, 'HEARING', 'IN_PERSON', 'Room (synthetic)', null,
              now() + interval '3 days', now() + interval '3 days 1 hour', ${REASON}) as id`,
          );
          return s.tx`select api.cancel_meeting(${m}, ${REASON})`;
        },
      },
      {
        // DEC-61: the restricted SECRET case's owner approves its referral to the Investigation Committee.
        fn: "approve_restricted_committee_referral",
        actor: "grcDirector",
        run: async (s) => {
          const exec = await caseId("0003");
          return s.tx`select api.approve_restricted_committee_referral(${exec}, ${ids.committee!}, ${REASON})`;
        },
      },
      {
        // AGENT-09 W2: a legal review on the restricted case needs its authority's approval naming the reviewer.
        // Fixture: the secretary, the chair, the member and the reviewer are cleared to SECRET (the rule in force needs
        // two present); the approved referral is used.
        fn: "approve_restricted_legal_review",
        actor: "grcDirector",
        run: async (s) => {
          const exec = await caseId("0003");
          await (s as OwnerScenario).asOwner();
          await s.tx`update iam.user_profile set clearance = 'SECRET'
                     where id in (${USERS.committeeSecretary}, ${USERS.committeeChair}, ${USERS.committee}, ${USERS.legalB})`;
          await s.as("grcDirector");
          const cp = await one(
            s,
            s.tx`select api.refer_case_to_committee(${exec}, ${ids.committee!}, null, ${REASON}) as id`,
          );
          await s.as("committeeSecretary");
          const m = await one(
            s,
            s.tx`select api.schedule_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
              now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`,
          );
          const seats = await s.tx<{ id: string; user_id: string }[]>`
            select id, user_id from committee.meeting_participant where meeting_id = ${m} and is_voting`;
          for (const [user, key] of [
            [USERS.committee, "committee"],
            [USERS.committeeChair, "committeeChair"],
          ] as const) {
            await s.as(key);
            await s.tx`select api.declare_meeting_conflict(${seats.find((r) => r.user_id === user)!.id}, 'NO_CONFLICT', null)`;
          }
          await s.as("committeeSecretary");
          await s.tx`select api.open_meeting(${m}, ${REASON})`;
          for (const r of seats) await s.tx`select api.record_attendance(${r.id}, 'PRESENT')`;
          const pkg = await one(s, s.tx`select api.create_recommendation_package(${cp}, 'PACKAGE') as id`);
          await s.tx`select api.add_recommendation_item(${pkg}, 'OTHER', null, null, 'Synthetic: restricted walk item.', null, null)`;
          await s.tx`select api.submit_package_for_vote(${pkg})`;
          await s.tx`select api.open_package_vote(${m}, ${pkg})`;
          const vi = await one(s, s.tx`select id from committee.vote_item where package_id = ${pkg}`);
          for (const key of ["committee", "committeeChair"] as const) {
            await s.as(key);
            await s.tx`select api.cast_vote(${vi}, 'APPROVE', null)`;
          }
          await s.as("committeeSecretary");
          await s.tx`select api.close_vote_item(${vi}, null)`;
          await s.tx`select api.record_package_adoption(${pkg})`;
          await s.as("grcDirector");
          return s.tx`select api.approve_restricted_legal_review(${pkg}, ${USERS.legalB}, ${REASON})`;
        },
      },
      {
        fn: "close_proceeding",
        actor: "caseManager",
        run: async (s) => {
          const [p] = await s.tx<{ id: string }[]>`
            select api.open_proceeding(${caseA}, 'CORRECTIVE_ACTION', null, ${REASON}) as id`;
          return s.tx`select api.close_proceeding(${p!.id}, 'CONCLUDED', 'CORRECTIVE_ACTION', ${REASON})`;
        },
      },
      // Direct referral (migration 1880): a sector with a head, members and a delegate; a referral approved by the
      // delegate, rejected, objected to and accepted (a case with a committee proceeding); a second referral
      // rejected, resubmitted and withdrawn.
      {
        fn: "create_sector",
        actor: "platformAdmin",
        run: async (s) =>
          (ids.sector = await one(
            s,
            s.tx`select api.create_sector('WLK', 'Walk Sector (synthetic)', 'قطاع التجربة (تجريبي)') as id`,
          )),
      },
      {
        fn: "appoint_sector_member",
        actor: "platformAdmin",
        run: async (s) => {
          for (const [user, position] of [
            ["employee", "MEMBER"],
            ["sectorHead", "HEAD"],
            ["employeeB", "MEMBER"],
          ] as const) {
            await s.tx`select api.appoint_sector_member(${ids.sector!}, ${USERS[user]}, ${position}, now(), null, 'DEMO-SECTOR-APPT')`;
          }
          return (ids.sectorMembership = await one(
            s,
            s.tx`select api.appoint_sector_member(${ids.sector!}, ${USERS.financeEmployee}, 'MEMBER', now(), null, 'DEMO-SECTOR-APPT') as id`,
          ));
        },
      },
      {
        fn: "delegate_referral_approval",
        actor: "sectorHead",
        run: async (s) =>
          (ids.delegation = await one(
            s,
            s.tx`select api.delegate_referral_approval(${ids.sector!}, ${USERS.employeeB}, now(), now() + interval '7 days',
              'DEMO-DELEGATION-01', ${REASON}) as id`,
          )),
      },
      {
        fn: "create_referral",
        actor: "employee",
        run: async (s) =>
          (ids.referral = await one(
            s,
            s.tx`select api.create_referral(${ids.sector!}, 'Walk referral (synthetic)', 'Synthetic: referral summary for the walk.',
              'FRAUD', 'RESTRICTED'::core.classification_level) as id`,
          )),
      },
      {
        fn: "update_referral",
        actor: "employee",
        run: (s) =>
          s.tx`select api.update_referral(${ids.referral!}, 'Walk referral (synthetic)', 'Synthetic: referral summary, edited.',
            'FRAUD', 'RESTRICTED'::core.classification_level)`,
      },
      {
        fn: "submit_referral",
        actor: "employee",
        run: (s) => s.tx`select api.submit_referral(${ids.referral!}, null)`,
      },
      {
        fn: "sector_decide_referral",
        actor: "employeeB",
        run: (s) => s.tx`select api.sector_decide_referral(${ids.referral!}, 'APPROVE', null, null)`,
      },
      {
        fn: "secretary_decide_referral",
        actor: "committeeSecretary",
        run: (s) =>
          s.tx`select api.secretary_decide_referral(${ids.referral!}, 'REJECT', array['MISSING_DOCUMENTS'], null, null)`,
      },
      {
        fn: "object_to_referral_rejection",
        actor: "sectorHead",
        run: (s) =>
          s.tx`select api.object_to_referral_rejection(${ids.referral!}, 'Synthetic: the documents were attached.')`,
      },
      {
        fn: "secretary_decide_referral",
        actor: "committeeSecretary",
        run: (s) =>
          s.tx`select api.secretary_decide_referral(${ids.referral!}, 'ACCEPT', null, null, ${USERS.caseManager})`,
      },
      {
        fn: "comment_on_referral",
        actor: "committeeSecretary",
        run: (s) =>
          s.tx`select api.comment_on_referral(${ids.referral!}, 'Synthetic: accepted, see the case.')`,
      },
      {
        fn: "resubmit_referral",
        actor: "employee",
        run: async (s) => {
          ids.referral2 = await one(
            s,
            s.tx`select api.create_referral(${ids.sector!}, 'Second walk referral (synthetic)', 'Synthetic: second referral summary.',
              'MISCONDUCT', 'RESTRICTED'::core.classification_level) as id`,
          );
          await s.tx`select api.submit_referral(${ids.referral2!}, null)`;
          await s.as("sectorHead");
          await s.tx`select api.sector_decide_referral(${ids.referral2!}, 'APPROVE', null, null)`;
          await s.as("committeeSecretary");
          await s.tx`select api.secretary_decide_referral(${ids.referral2!}, 'REJECT', array['OUT_OF_SCOPE'], null, null)`;
          await s.as("employee");
          return s.tx`select api.resubmit_referral(${ids.referral2!}, null)`;
        },
      },
      {
        fn: "withdraw_referral",
        actor: "employee",
        run: (s) => s.tx`select api.withdraw_referral(${ids.referral2!}, ${REASON})`,
      },
      {
        fn: "revoke_referral_delegation",
        actor: "sectorHead",
        run: (s) => s.tx`select api.revoke_referral_delegation(${ids.delegation!}, ${REASON})`,
      },
      {
        fn: "end_sector_membership",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.end_sector_membership(${ids.sectorMembership!}, now() + interval '1 day', ${REASON})`,
      },
      // Preliminary review (migration 1880): prepared by the assigned investigator, endorsed by the GRC Director,
      // approved by the GRC Sector Head.
      {
        fn: "prepare_preliminary_recommendation",
        actor: "investigatorA",
        run: async (s) =>
          (ids.recommendation = await one(
            s,
            s.tx`select api.prepare_preliminary_recommendation(${caseA}, 'INVESTIGATION_WARRANTED',
              'Synthetic: the walk recommendation rationale.') as id`,
          )),
      },
      {
        fn: "review_preliminary_recommendation",
        actor: "grcDirector",
        run: (s) =>
          s.tx`select api.review_preliminary_recommendation(${ids.recommendation!}, 'ENDORSE', null, null)`,
      },
      {
        fn: "approve_preliminary_recommendation",
        actor: "grcSectorHead",
        run: (s) =>
          s.tx`select api.approve_preliminary_recommendation(${ids.recommendation!}, 'APPROVE', null, null)`,
      },
      // Forms engine (CDF-50): an investigation form through save, prepare and review (its final state), a
      // committee form through review and approval by three different people, a draft withdrawn, and the
      // audited open of an instance.
      {
        fn: "start_form",
        actor: "investigatorA",
        run: async (s) =>
          (ids.form = await one(
            s,
            s.tx`select api.start_form(${caseA}, 'WB-FRM-11', 'CONFIDENTIAL'::core.classification_level) as id`,
          )),
      },
      {
        fn: "save_form_draft",
        actor: "investigatorA",
        run: (s) =>
          s.tx`select * from api.save_form_draft(${ids.form!}, ${s.tx.json(FORM_DATA.evidenceRegister)})`,
      },
      {
        fn: "prepare_form",
        actor: "investigatorA",
        run: (s) => s.tx`select api.prepare_form(${ids.form!})`,
      },
      {
        fn: "review_form",
        actor: "lead",
        run: (s) => s.tx`select api.review_form(${ids.form!}, 'REVIEWED', null)`,
      },
      {
        fn: "open_form_instance",
        actor: "lead",
        run: (s) => s.tx`select api.open_form_instance(${ids.form!})`,
      },
      {
        fn: "start_form",
        actor: "committeeSecretary",
        run: async (s) =>
          (ids.committeeForm = await one(
            s,
            s.tx`select api.start_form(${caseA}, 'WB-FRM-13', 'CONFIDENTIAL'::core.classification_level) as id`,
          )),
      },
      {
        fn: "save_form_draft",
        actor: "committeeSecretary",
        run: (s) =>
          s.tx`select * from api.save_form_draft(${ids.committeeForm!}, ${s.tx.json(FORM_DATA.committeeFormation)})`,
      },
      {
        fn: "prepare_form",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.prepare_form(${ids.committeeForm!})`,
      },
      {
        fn: "review_form",
        actor: "committeeChair",
        run: (s) => s.tx`select api.review_form(${ids.committeeForm!}, 'REVIEWED', null)`,
      },
      {
        fn: "approve_form",
        actor: "grcDirector",
        run: (s) => s.tx`select api.approve_form(${ids.committeeForm!}, 'APPROVED', null)`,
      },
      {
        fn: "start_form",
        actor: "investigatorA",
        run: async (s) =>
          (ids.draftForm = await one(
            s,
            s.tx`select api.start_form(${caseA}, 'WB-FRM-11', 'CONFIDENTIAL'::core.classification_level) as id`,
          )),
      },
      {
        fn: "withdraw_form",
        actor: "investigatorA",
        run: (s) => s.tx`select api.withdraw_form(${ids.draftForm!}, ${REASON})`,
      },
      {
        fn: "grant_role",
        actor: "platformAdmin",
        run: async (s) =>
          (ids.role = await one(
            s,
            s.tx`select api.grant_role(${USERS.committee}, 'LEGAL_REVIEWER', ${REASON}, null) as id`,
          )),
      },
      {
        fn: "revoke_role",
        actor: "platformAdmin",
        run: (s) => s.tx`select api.revoke_role(${ids.role!}, ${REASON})`,
      },
      {
        fn: "set_user_status",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.set_user_status(${USERS.investigatorB}, 'SUSPENDED'::core.record_status, ${REASON})`,
      },
      // Records lifecycle on the walk case (ADR-013): close, archive, hold and release, class, eligibility,
      // request, approval by someone else, logical execution. The class fixture is added before the walk.
      {
        fn: "transition_case",
        actor: "caseManager",
        run: (s) => s.tx`select api.transition_case(${ids.case!}, 'SCREEN_OUT', ${REASON})`,
      },
      {
        fn: "transition_case",
        actor: "caseManager",
        run: (s) => s.tx`select api.transition_case(${ids.case!}, 'ARCHIVE_CASE', null)`,
      },
      {
        // ADR-014 (CDF-73): legal reviewers act on a case through hold tasks, not role-wide visibility.
        fn: "create_case_task",
        actor: "grcDirector",
        run: (s) => legalHoldTasks(s, ids.case!, "grcDirector"),
      },
      {
        fn: "place_legal_hold",
        actor: "legal",
        run: async (s) =>
          (ids.hold = await one(
            s,
            s.tx`select api.place_legal_hold(${ids.case!}, 'CASE', null, 'LITIGATION', 'Synthetic: preservation for the audit walk.', null) as id`,
          )),
      },
      {
        fn: "request_legal_hold_release",
        actor: "legal",
        run: async (s) =>
          (ids.release = await one(
            s,
            s.tx`select api.request_legal_hold_release(${ids.hold!}, 'Synthetic: the walk inquiry has concluded.') as id`,
          )),
      },
      {
        fn: "decide_legal_hold_release",
        actor: "legalB",
        run: (s) => s.tx`select api.decide_legal_hold_release(${ids.release!}, true, ${REASON})`,
      },
      {
        fn: "assign_retention_class",
        actor: "records",
        run: (s) => s.tx`select api.assign_retention_class(${ids.case!}, 'TEST_SHORT_RETENTION')`,
      },
      {
        fn: "refresh_disposition_eligibility",
        actor: "records",
        run: (s) => s.tx`select api.refresh_disposition_eligibility()`,
      },
      {
        fn: "request_disposition",
        actor: "records",
        run: async (s) =>
          (ids.disposition = await one(s, s.tx`select api.request_disposition(${ids.case!}) as id`)),
      },
      {
        fn: "decide_disposition",
        actor: "grcDirector",
        run: (s) => s.tx`select api.decide_disposition(${ids.disposition!}, true, ${REASON})`,
      },
      {
        fn: "execute_disposition",
        actor: "records",
        run: (s) => s.tx`select api.execute_disposition(${ids.disposition!})`,
      },
    ];

    expect(mustCover.filter((fn) => !steps.some((st) => st.fn === fn)).sort()).toEqual([]);

    // Owner connection only for fixtures (the CONFIGURED class, a lapsed task); every step runs as `authenticated`.
    await ownerScenario(async (s) => {
      await addShortRetentionClass(s);
      // A task whose access window has already lapsed, for expire_case_tasks (CDF-73): the commands refuse
      // to create one, and now() is fixed for the whole transaction.
      await s.asOwner();
      await s.tx`
        insert into case_mgmt.case_task (case_id, task_type, assigned_user_id, assigned_role, purpose, scope, created_by,
                                         access_granted_at, expires_at)
        values (${caseA}, 'LEGAL_HOLD_RELEASE', ${USERS.legalB}, 'LEGAL_REVIEWER', 'Synthetic: lapsed audit walk task.',
                array['CASE_VIEW_METADATA'], ${USERS.caseManager}, now() - interval '2 days', now() - interval '1 day')`;
      const missing: string[] = [];
      for (const step of steps) {
        const { events } = await audited(s, step);
        // Identity-vault commands are deliberately SECURITY-category events, hidden from the case team (V-4).
        // Break-glass is likewise recorded as SECURITY events (ADR-014 D5).
        const category = /identity|break_glass/.test(step.fn) ? "SECURITY" : "BUSINESS_OR_ADMIN";
        const ok = events.some(
          (e) =>
            e.outcome === "SUCCESS" &&
            e.actor_id === USERS[step.actor] &&
            (category === "SECURITY" ? e.category === "SECURITY" : e.category !== "SECURITY"),
        );
        if (!ok) missing.push(`${step.fn}: ${JSON.stringify(events)}`);
      }
      expect(missing).toEqual([]);
      // The walk leaves a valid chain.
      await s.as("internalAudit");
      expect(await s.tx`select * from api.verify_audit_chain()`).toEqual([]);
    });
  });
});

describe("refused commands leave no business trace", () => {
  it("a command that fails after its checks pass rolls back its business event with it", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const requestId = randomUUID();
      await s.tx`select set_config('cdf.request_id', ${requestId}, true)`;
      // Stale row version: the command reaches its conflict check and must abort atomically.
      await s.expectError(
        "CDF_CONFLICT:STALE_VERSION",
        (tx) =>
          tx`select api.update_case_details(${caseA}, 'Stale write (synthetic)', 'Synthetic.', 'LOW', -1)`,
      );
      await s.expectError(
        "CDF_CONFLICT:ALREADY_ASSIGNED",
        (tx) => tx`select api.assign_case(${caseB}, ${USERS.investigatorB}, 'INVESTIGATOR', ${REASON})`,
      );
      await s.as("dpo");
      expect(await s.tx`select action from audit.audit_event where request_id = ${requestId}`).toEqual([]);
    });
  });
});

describe("the security event command cannot forge history", () => {
  it.each<UserKey>(["investigatorA", "caseManager", "grcDirector", "platformAdmin"])(
    "%s can only record DENIED SECURITY events from the fixed list",
    async (user) => {
      await scenario(async (s) => {
        await s.as(user);
        for (const action of [
          "CASE_VIEWED",
          "EVIDENCE_DOWNLOADED",
          "CASE_CLOSED",
          "ROLE_GRANTED",
          "IDENTITY_RESOLVED",
          "",
        ]) {
          await s.expectError(
            "CDF_INVALID:action",
            (tx) => tx`select api.record_security_event(${action}, 'case_record', ${caseA}, '{}'::jsonb)`,
          );
        }
        await s.expectError(
          "CDF_INVALID:metadata",
          (tx) =>
            tx`select api.record_security_event('ACCESS_DENIED', 'case_record', ${caseA}, ${JSON.stringify({ pad: "x".repeat(3000) })}::jsonb)`,
        );
        const requestId = randomUUID();
        await s.tx`select set_config('cdf.request_id', ${requestId}, true)`;
        await s.tx`select api.record_security_event('ACCESS_DENIED', 'case_record', ${caseA}, '{}'::jsonb)`;
        await s.as("dpo");
        const events = await s.tx<
          { category: string; outcome: string; case_id: string | null; actor_id: string }[]
        >`
          select category, outcome, case_id, actor_id from audit.audit_event where request_id = ${requestId}`;
        // Never a business event, never attached to a case's history, always attributed to the caller.
        expect(events).toEqual([
          { category: "SECURITY", outcome: "DENIED", case_id: null, actor_id: USERS[user] },
        ]);
      });
    },
  );

  it("anonymous callers cannot record security events through the investigation API", async () => {
    await scenario(async (s) => {
      await s.as(null);
      await s.expectError(
        "permission denied",
        (tx) => tx`select api.record_security_event('ACCESS_DENIED', 'case_record', ${caseA}, '{}'::jsonb)`,
      );
    });
  });
});

describe("audit internals are not reachable", () => {
  it.each<UserKey>(["internalAudit", "soc", "dpo", "grcDirector"])(
    "%s cannot call the hashing and verification internals directly",
    async (user) => {
      await scenario(async (s) => {
        await s.as(user);
        await s.expectError("permission denied", (tx) => tx`select audit.verify_chain()`);
        await s.expectError("permission denied", (tx) => tx`select audit.compute_hash('0', 'x')`);
        await s.expectError(
          "permission denied",
          (tx) =>
            tx`select case_mgmt.end_assignment_internal(${randomUUID()}, ${USERS[user]}, 'x', 'CASE_UNASSIGNED')`,
        );
      });
    },
  );

  it("authenticated can execute exactly the documented helper functions outside api", async () => {
    const rows = await admin<{ fn: string }[]>`
      select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('audit', 'authz', 'workflow', 'case_mgmt', 'committee', 'core', 'evidence', 'forms', 'intake', 'iam', 'protected_identity', 'public_api', 'records', 'config', 'decision')
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      order by 1`;
    // Predicates about the caller only (used by RLS policies), the forms engine's pure hashing helpers
    // (ADR-011: canonical JSON, content hash and terminal status read no data) and the shared rate limiter.
    // CDF-73 (ADR-014) adds the purpose-bound predicates; each answers for the caller only.
    expect(rows.map((r) => r.fn)).toEqual([
      "authz.can_apply_legal_hold",
      "authz.can_approve_disposition",
      "authz.can_approve_form",
      "authz.can_approve_interviews",
      "authz.can_assign_case",
      "authz.can_conduct_interviews",
      "authz.can_discover_case",
      "authz.can_download_evidence",
      "authz.can_edit_case",
      "authz.can_manage_disposition",
      "authz.can_manage_meeting",
      "authz.can_manage_recommendation_package",
      "authz.can_manage_retention",
      "authz.can_prepare_form",
      "authz.can_record_findings",
      "authz.can_release_legal_hold",
      "authz.can_request_disposition",
      "authz.can_request_legal_hold",
      "authz.can_reveal_whistleblower_identity",
      "authz.can_review_form",
      "authz.can_review_interviews",
      "authz.can_review_legal_hold",
      "authz.can_upload_evidence",
      "authz.can_view_case",
      "authz.can_view_case_content",
      "authz.can_view_case_metadata",
      "authz.can_view_committee_proceeding",
      "authz.can_view_committee_registry",
      "authz.can_view_evidence",
      "authz.can_view_form_instance",
      "authz.can_view_interview",
      "authz.can_view_meeting",
      "authz.can_view_meeting_deliberation",
      "authz.can_view_meeting_roster",
      "authz.can_view_packet",
      "authz.can_view_preliminary_recommendation",
      "authz.can_view_proceeding",
      "authz.can_view_recommendation_package",
      "authz.can_view_records",
      "authz.can_view_records_catalogue",
      "authz.can_view_referral",
      "authz.can_view_report",
      "authz.can_view_sector_roster",
      "authz.current_clearance",
      "authz.current_roles",
      "authz.current_subject",
      "authz.current_user_id",
      "authz.form_entitled",
      "authz.has_permission",
      "authz.in_records_catalogue_scope",
      "authz.is_committee_secretary",
      "authz.task_grants",
      "forms.canonical_json",
      "forms.content_hash",
      "forms.terminal_status",
      "public_api.consume_rate_limit",
      "records.catalogue_rows",
      "records.hold_request_rows",
    ]);
  });
});
