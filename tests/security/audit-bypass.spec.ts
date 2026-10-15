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
import { preliminaryReferral, unseatDemoSeats } from "../support/committee";
import { setClosureAuthority } from "../support/closure";
import { setPreliminaryCorrectiveTypes } from "../support/preliminary";
import {
  clearAsIs,
  defenceNotice,
  newSha,
  packetWith,
  setPacketPolicy,
  storeEvidence,
  type StoredVersion,
} from "../support/evidence";

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
  // Corrective action from preliminary review (migration 2070): the recommendation's proposals and capability flags.
  "preliminary_corrective_view",
  // Raised case conflicts (migration 2080): the caller's readable concerns and capability flags.
  "case_conflict_concerns",
  // Committee meetings (migration 1890): who has voted, and choices only after close.
  "vote_item_status",
  // Purpose read models of a meeting and its minutes (migration 2030 section 4): reads, like vote_item_status.
  "meeting_view",
  "minutes_view",
  // Employee defence (migration 1910): the subject's own notices.
  "my_defence_notices",
  // S2 read models (migration 1830): a case's history and access roster, read inside an audited case view.
  "case_history",
  "case_access_roster",
  // S2h (migration 1860): the shared retention queue; opening a record from it is audited by open_case_metadata.
  // The officers a case authority may route a retention review to: names only; the routing itself is
  // api.create_case_task, audited as CASE_TASK_ASSIGNED.
  "retention_review_queue",
  "list_retention_reviewers",
  // Migration 2030: which item types have an authority rule (administrators), and the flags on a package's items.
  "authority_rule_coverage",
  "recommendation_item_flags",
  // Migration 2040 (DEC-AMB-009): what the case team is shown about executing each decided sanction.
  "sanction_executability",
  // Migration 2040 (DEC-F24, T-AMB-112): the export policy administrator's configuration warnings (ids and counts).
  "export_approval_config_warnings",
  // Migration 2040 item 13: purpose read models and the caller's queues, reads like meeting_view.
  "referral_view",
  "referral_queue",
  "grievance_view",
  "grievance_queue",
  "export_request_view",
  "corrective_action_view",
  "bcp_import_batch_view",
  // Migration 2045 (P12-0b, ADR-051): what a committee referral would copy now, as counts; nothing is opened.
  "committee_referral_preview",
  // Migration 2050 (ADR-041): reads. The exclusion record and the leads' packet view show rows their readers can select
  // already; the subject's packet read and item opening, and the extract view, are audited as views (the opening also
  // records custody, like open_evidence_version).
  "evidence_exclusion_record",
  "defence_packet_view",
  "my_defence_packet",
  "open_defence_packet_item",
  "sanction_extract_view",
  "my_sanction_extract_approvals",
  // Migration 2060 (ADR-042): what a case viewer reads of closure (closures, requests; blockers and reopening requests
  // only for those who may act on them). Not audited: the closure and reopening commands are.
  "case_closure_view",
]);

/** Stages a two-row continuity workbook for case 0001, recorded offline by the lead investigator at the case's
 *  creation (ADR-034): a subject to import and a recorded-only row to skip. */
function stageWalkWorkbook(s: Scenario, workbookId: string) {
  return s.tx`
    with c as (
      select id, case_number, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
      from case_mgmt.case_record where id = ${caseA}
    )
    select api.stage_bcp_import(
      jsonb_build_object('TEMPLATE_VERSION', 'BCP-1', 'WORKBOOK_ID', ${workbookId}::text, 'CASE_ID', c.id::text,
                         'CASE_NUMBER', c.case_number, 'OFFLINE_FROM', c.at, 'PREPARED_BY', 'lead@example.test'),
      repeat('a', 64),
      jsonb_build_array(
        jsonb_build_object('sheet', '05_SUBJECTS', 'row_number', 3, 'has_formula', false, 'cells',
          jsonb_build_object('ROW_ID', 'BCP-WS1', 'ORIGINAL_EVENT_AT', c.at, 'RECORDED_OFFLINE_BY', 'lead@example.test',
                             'DISPLAY_LABEL', 'Employee Walk (synthetic)', 'SUBJECT_CATEGORY', 'EMPLOYEE')),
        jsonb_build_object('sheet', '02_CASE_MASTER', 'row_number', 3, 'has_formula', false, 'cells',
          jsonb_build_object('ROW_ID', 'BCP-WC1', 'ORIGINAL_EVENT_AT', c.at, 'RECORDED_OFFLINE_BY', 'lead@example.test',
                             'DETAILS', 'Synthetic: noted during the outage.')))) as id
    from c`;
}

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
    /** Runs a step's fixture under a request id of its own, so only the command's own events count for the step. */
    const apart = async <T>(s: Scenario, fixture: () => Promise<T>, actor: UserKey): Promise<T> => {
      const [r] = await s.tx<{ id: string }[]>`select current_setting('cdf.request_id') as id`;
      await s.tx`select set_config('cdf.request_id', ${randomUUID()}, true)`;
      const value = await fixture();
      await s.tx`select set_config('cdf.request_id', ${r!.id}, true)`;
      await s.as(actor);
      return value;
    };
    const stored: Record<string, StoredVersion> = {};
    /** The seated Grievance Committee approves one vote item in the admitted grievance's proceeding. */
    const grievanceVote = async (s: Scenario, grievance: string) => {
      const cp = await one(
        s,
        s.tx`select committee_proceeding_id from grievance.grievance where id = ${grievance}`,
      );
      const m = await one(
        s,
        s.tx`select api.schedule_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`,
      );
      const seats = await s.tx<{ id: string; user_id: string }[]>`
        select id, user_id from committee.meeting_participant where meeting_id = ${m} and is_voting`;
      for (const key of ["legal", "legalB"] as const) {
        await s.as(key);
        await s.tx`select api.declare_meeting_conflict(${seats.find((r) => r.user_id === USERS[key])!.id}, 'NO_CONFLICT', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${m}, ${REASON})`;
      for (const r of seats) await s.tx`select api.record_attendance(${r.id}, 'PRESENT')`;
      const vi = await one(
        s,
        s.tx`select api.open_vote_item(${m}, 'OTHER', null, 'Grievance outcome (synthetic)') as id`,
      );
      for (const key of ["legal", "legalB"] as const) {
        await s.as(key);
        await s.tx`select api.cast_vote(${vi}, 'APPROVE', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi}, null)`;
      return vi;
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
            s.tx`select api.grant_case_access(${caseB}, ${USERS.committee}, 'CASE', ${REASON}, null) as id`,
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
      // P11-G7 (migration 2080): case B's investigator raises a conflict about the GRC deputy; the case manager
      // dismisses it (an upheld one would end the deputy's purposes on case B).
      {
        fn: "raise_case_conflict",
        actor: "investigatorB",
        run: async (s) =>
          (ids.caseConflict = await one(
            s,
            s.tx`select api.raise_case_conflict(${caseB}, ${USERS.grcDeputy}, 'Synthetic: audit walk concern.') as id`,
          )),
      },
      {
        fn: "decide_case_conflict",
        actor: "caseManager",
        run: (s) => s.tx`select api.decide_case_conflict(${ids.caseConflict!}, 'DISMISSED', ${REASON})`,
      },
      {
        fn: "reply_to_reporter",
        actor: "intake",
        run: (s) =>
          s.tx`select api.reply_to_reporter(${infoReport}, 'Synthetic follow-up question for the reporter.')`,
      },
      // DEC-06 (migration 1840): the case manager lets case B's investigator write to the reporter, then ends it.
      {
        fn: "delegate_reporter_communication",
        actor: "caseManager",
        run: async (s) =>
          (ids.delegation = await one(
            s,
            s.tx`select api.delegate_reporter_communication(${caseB}, ${USERS.investigatorB}, ${REASON}) as id`,
          )),
      },
      {
        fn: "end_reporter_communication",
        actor: "caseManager",
        run: (s) => s.tx`select api.end_reporter_communication(${ids.delegation!}, ${REASON})`,
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
          const [r] = await s.tx<{ v: string; e: string }[]>`
            select o_version_id as v, o_evidence_id as e from api.register_evidence_version(${caseB}, null, 'Audit walk item (synthetic)', null,
              'DOCUMENT', 'Synthetic source', null, 'CONFIDENTIAL'::core.classification_level, 'walk.pdf', 'application/pdf', 512, ${"1".repeat(64)})`;
          ids.evidence = r!.e;
          return (ids.version = r!.v);
        },
      },
      {
        fn: "complete_evidence_version",
        actor: "investigatorB",
        run: (s) => s.tx`select api.complete_evidence_version(${ids.version!}, 'CLEAN', 'walk-scanner')`,
      },
      // DEC-09 (migration 1850): the case manager limits the item to the case leads.
      {
        fn: "set_evidence_restriction",
        actor: "caseManager",
        run: (s) => s.tx`select api.set_evidence_restriction(${ids.evidence!}, 'LEADS', ${REASON})`,
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
          s.tx`select api.set_committee_rule_set(${ids.committee!}, now(), 'FIXED_NUMBER', 1, true, 3, true, null, null,
            'NO_DECISION', 'SOURCE_REQUIRED', ${REASON})`,
      },
      {
        fn: "revise_committee_rule_set",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.revise_committee_rule_set(${ids.committee!}, now() + interval '1 day',
            ${s.tx.json({ acting_chair_casting_vote: true })}, 'SOURCE_REQUIRED', ${REASON})`,
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
      // Excused attendance and a raised conflict (migration 2000), between vote items; the concern is dismissed so
      // the package vote below can open.
      {
        fn: "record_excused_absence",
        actor: "committeeSecretary",
        run: async (s) => {
          const [expert] = await s.tx<{ id: string }[]>`
            select id from committee.meeting_participant where meeting_id = ${ids.meeting!} and user_id = ${USERS.lead}`;
          return s.tx`select api.record_excused_absence(${expert!.id}, 'Synthetic: travelling.')`;
        },
      },
      {
        fn: "raise_meeting_conflict",
        actor: "committeeSecretary",
        run: async (s) =>
          (ids.concern = await one(
            s,
            s.tx`select api.raise_meeting_conflict(${ids.memberSeat!}, 'Synthetic: walk concern raised.') as id`,
          )),
      },
      {
        fn: "decide_meeting_conflict",
        actor: "committeeChair",
        run: (s) =>
          s.tx`select api.decide_meeting_conflict(${ids.concern!}, 'DISMISSED', 'Synthetic: walk concern dismissed.')`,
      },
      // A witness invited and excluded (migration 2010).
      {
        fn: "exclude_meeting_witness",
        actor: "committeeSecretary",
        run: async (s) => {
          const witness = await one(
            s,
            s.tx`select api.invite_to_meeting(${ids.meeting!}, 'WITNESS', ${USERS.employeeB}, null, false, ${REASON}) as id`,
          );
          return s.tx`select api.exclude_meeting_witness(${witness}, 'Synthetic: walk witness excluded.')`;
        },
      },
      // Recommendation package (migration 1900): drafted, voted and adopted in the open meeting, reviewed by Legal,
      // sent to the authority and decided.
      {
        // The walk package holds a corrective action and (2040) a sanction: both types name the authority that decides
        // it (DEC-F13, 2030: no item type without a rule).
        fn: "set_action_authority_rule",
        actor: "platformAdmin",
        run: async (s) => {
          await s.tx`select api.set_action_authority_rule('CORRECTIVE_ACTION', 'DELEGATED_EXECUTIVE', now(), 'SOURCE_REQUIRED', ${REASON})`;
          return s.tx`select api.set_action_authority_rule('DISCIPLINARY_SANCTION', 'DELEGATED_EXECUTIVE', now(), 'SOURCE_REQUIRED', ${REASON})`;
        },
      },
      // Migration 2030: a sanction catalogue version (DEC-F11) and a legal-review rule (DEC-F12), both from tomorrow.
      {
        fn: "set_sanction_catalogue_entry",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.set_sanction_catalogue_entry('WARNING', null, null, null, 'SOURCE_REQUIRED',
            array['EMPLOYEE']::text[], null, now() + interval '1 day', 'SOURCE_REQUIRED', null, ${REASON})`,
      },
      {
        fn: "set_legal_review_rule",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.set_legal_review_rule('INVESTIGATION', 'ITEM_TYPE', 'GOVERNANCE_REMEDIATION', 'REQUIRED',
            now() + interval '1 day', 'SOURCE_REQUIRED', ${REASON})`,
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
          // Migration 2040: a sanction on the walk subject, executed later in the walk (DEC-AMB-004, -009). Its
          // adoption needs a defence notice to the subject on the allegation (AMB-026, 2030): fixture, as the case
          // manager.
          await s.as("caseManager");
          await s.tx`select api.issue_defence_notice(${ids.subject!}, 'Synthetic: walk notice (before adoption).',
            ${[ids.allegation!]}::uuid[], now() + interval '10 days')`;
          await s.as("committeeSecretary");
          ids.sanctionItem = await one(
            s,
            s.tx`select api.add_recommendation_item(${ids.pkg!}, 'DISCIPLINARY_SANCTION', 'WARNING', null,
              'Synthetic: walk written warning.', ${[ids.subject!]}::uuid[], ${[ids.allegation!]}::uuid[]) as id`,
          );
          return (ids.correctiveItem = await one(
            s,
            s.tx`select api.add_recommendation_item(${ids.pkg!}, 'CORRECTIVE_ACTION', null, null,
              'Synthetic: walk corrective action.', null, null) as id`,
          ));
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
        // AMB-115 (migration 2030): a request sent to the wrong reviewer is cancelled before the real one.
        fn: "cancel_legal_review_request",
        actor: "committeeSecretary",
        run: async (s) => {
          const r = await one(
            s,
            s.tx`select api.request_legal_review(${ids.pkg!}, ${USERS.legalB}, ${REASON}, null, null) as id`,
          );
          return s.tx`select api.cancel_legal_review_request(${r}, ${REASON})`;
        },
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
        // AMB-117 (migration 2030): a superseding opinion in the same round, before submission.
        fn: "give_superseding_legal_opinion",
        actor: "legalB",
        run: (s) =>
          s.tx`select api.give_superseding_legal_opinion(${ids.legalRequest!}, 'CONCURS_WITH_COMMENTS',
            'Synthetic: the walk opinion, with a comment.')`,
      },
      {
        fn: "submit_to_authority",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.submit_to_authority(${ids.pkg!})`,
      },
      {
        fn: "record_authority_decision",
        actor: "committeeSecretary",
        run: async (s) =>
          (ids.decision = await one(
            s,
            s.tx`select api.record_authority_decision(${ids.pkg!}, 'DELEGATED_EXECUTIVE', 'APPROVE_AS_RECOMMENDED',
              now(), 'Delegated executive (synthetic)', 'MEMO-DEMO-WALK', null, ${REASON}) as id`,
          )),
      },
      // Corrective actions (migration 1940): opened from the approved item, run by the case manager, reported by
      // its owner (financeEmployee, then employeeB; both given IMPLEMENTATION_OWNER before the walk), verified,
      // reopened and waived.
      {
        fn: "set_corrective_action_policy",
        actor: "grcDirector",
        run: (s) =>
          s.tx`select api.set_corrective_action_policy('GOVERNANCE_REMEDIATION', null, null, null, 'REFERENCE_REQUIRED',
            now(), 'SOURCE_REQUIRED', ${REASON})`,
      },
      {
        fn: "open_corrective_action",
        actor: "caseManager",
        run: async (s) =>
          (ids.correctiveAction = await one(
            s,
            s.tx`select api.open_corrective_action(${ids.correctiveItem!}, 'Synthetic: walk action',
              'Synthetic: walk corrective action text.', ${USERS.financeEmployee}, current_date + 30) as id`,
          )),
      },
      {
        fn: "assign_corrective_action_owner",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.assign_corrective_action_owner(${ids.correctiveAction!}, ${USERS.employeeB}, ${REASON})`,
      },
      {
        fn: "change_corrective_action_due_date",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.change_corrective_action_due_date(${ids.correctiveAction!}, current_date + 45, ${REASON})`,
      },
      // Migration 2040 (DEC-F28): a shared pool of eligible users owns the action; employeeB stays accountable.
      {
        fn: "create_corrective_action_pool",
        actor: "grcDirector",
        run: async (s) =>
          (ids.pool = await one(
            s,
            s.tx`select api.create_corrective_action_pool('WALK_POOL', 'Walk pool (synthetic)', ${REASON}) as id`,
          )),
      },
      {
        fn: "set_corrective_action_pool_member",
        actor: "grcDirector",
        run: (s) =>
          s.tx`select api.set_corrective_action_pool_member(${ids.pool!}, ${USERS.financeEmployee}, true, ${REASON})`,
      },
      {
        fn: "set_corrective_action_owner_kind",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.set_corrective_action_owner_kind(${ids.correctiveAction!}, 'SHARED_POOL', null, ${ids.pool!},
            null, ${REASON})`,
      },
      {
        fn: "record_corrective_action_progress",
        actor: "employeeB",
        run: (s) =>
          s.tx`select api.record_corrective_action_progress(${ids.correctiveAction!}, 50, ${REASON})`,
      },
      {
        fn: "submit_corrective_action_completion",
        actor: "employeeB",
        run: (s) =>
          s.tx`select api.submit_corrective_action_completion(${ids.correctiveAction!}, ${REASON}, 'SOP-DEMO-WALK')`,
      },
      {
        fn: "verify_corrective_action",
        actor: "caseManager",
        run: (s) => s.tx`select api.verify_corrective_action(${ids.correctiveAction!}, 'VERIFIED', null)`,
      },
      {
        fn: "reopen_corrective_action",
        actor: "caseManager",
        run: (s) => s.tx`select api.reopen_corrective_action(${ids.correctiveAction!}, ${REASON})`,
      },
      {
        fn: "waive_corrective_action",
        actor: "grcDirector",
        run: (s) =>
          s.tx`select api.waive_corrective_action(${ids.correctiveAction!}, 'MEMO-DEMO-WALK-2', ${REASON})`,
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
      // AMB-093 (migration 2090): the secretary proposes a correction to the deemed-approved minutes; a member who
      // attended reviews it. The approved version never changes.
      {
        fn: "propose_minutes_correction",
        actor: "committeeSecretary",
        run: async (s) =>
          (ids.minutesCorrection = await one(
            s,
            s.tx`select api.propose_minutes_correction(${ids.minutes!}, 'Synthetic: the walk item was approved.',
              ${REASON}) as id`,
          )),
      },
      {
        fn: "review_minutes_correction",
        actor: "committee",
        run: (s) => s.tx`select api.review_minutes_correction(${ids.minutesCorrection!}, 'APPROVE', null)`,
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
        // Fixture: the secretary, the chair, the member and the reviewer are cleared to SECRET (both voting seats are
        // recorded present); the approved referral is used.
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
          ids.restrictedPkg = pkg;
          ids.restrictedMeeting = m;
          await s.as("grcDirector");
          return s.tx`select api.approve_restricted_legal_review(${pkg}, ${USERS.legalB}, ${REASON})`;
        },
      },
      // The owner's Finalization Set (migration 2030, ADR-040): the business calendar, an invitee-type rule and the
      // independent conflict authority; then, on the walk's proceeding, a member added after the referral, an
      // emergency meeting with a witness who acknowledges confidentiality and asks for an accommodation, an acting
      // chair, an alternate member and an acting secretary, a revised vote with a note, a recusal, and a minutes
      // objection overruled by the chair.
      {
        fn: "set_business_week_pattern",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.set_business_week_pattern(array[5, 6], now() + interval '30 days', 'SOURCE_REQUIRED', ${REASON})`,
      },
      {
        fn: "set_business_calendar_day",
        actor: "platformAdmin",
        run: async (s) =>
          (ids.calendarDay = await one(
            s,
            s.tx`select api.set_business_calendar_day(((now() at time zone 'Asia/Riyadh')::date + 40), 'HOLIDAY',
              'DEMO-CAL-01', ${REASON}) as id`,
          )),
      },
      {
        fn: "withdraw_business_calendar_day",
        actor: "platformAdmin",
        run: (s) => s.tx`select api.withdraw_business_calendar_day(${ids.calendarDay!}, ${REASON})`,
      },
      {
        fn: "set_invitee_type_rule",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.set_invitee_type_rule('INTERPRETER', true, true, null, 'SOURCE_REQUIRED', ${REASON})`,
      },
      {
        fn: "appoint_conflict_authority",
        actor: "platformAdmin",
        run: async (s) =>
          (ids.conflictAuthority = await one(
            s,
            s.tx`select api.appoint_conflict_authority(${ids.committee!}, ${USERS.complianceManager}, now(), null,
              'DEMO-CA-01', 'SOURCE_REQUIRED', ${REASON}) as id`,
          )),
      },
      {
        fn: "end_conflict_authority",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.end_conflict_authority(${ids.conflictAuthority!}, now() + interval '30 days', ${REASON})`,
      },
      {
        fn: "amend_proceeding_snapshot",
        actor: "committeeSecretary",
        run: async (s) => {
          // Fixture: a deputy chair, an alternate member and an alternate secretary appointed after the referral (none
          // sits on the Grievance Committee below, so its firewall is unaffected). The alternate is not case A's lead
          // investigator: since migration 2080 (AMB-053) the amendment refuses a member who investigated the case.
          await s.as("platformAdmin");
          const deputy = await one(
            s,
            s.tx`select api.appoint_committee_member(${ids.committee!}, ${USERS.investigatorB}, 'DEPUTY_CHAIR', now(), null, 'DEMO-APPT-04') as id`,
          );
          const alternate = await one(
            s,
            s.tx`select api.appoint_committee_member(${ids.committee!}, ${USERS.triage}, 'ALTERNATE_MEMBER', now(), null, 'DEMO-APPT-05') as id`,
          );
          await s.tx`select api.appoint_committee_member(${ids.committee!}, ${USERS.grcDeputy}, 'ALTERNATE_SECRETARY', now(), null, 'DEMO-APPT-06')`;
          await s.as("committeeSecretary");
          await s.tx`select api.amend_proceeding_snapshot(${ids.committeeProceeding!}, ${deputy}, 'Synthetic: deputy chair appointed after the referral.')`;
          return s.tx`select api.amend_proceeding_snapshot(${ids.committeeProceeding!}, ${alternate}, 'Synthetic: alternate member appointed after the referral.')`;
        },
      },
      {
        fn: "schedule_emergency_meeting",
        actor: "committeeSecretary",
        run: async (s) => {
          ids.meeting2 = await one(
            s,
            s.tx`select api.schedule_emergency_meeting(${ids.committeeProceeding!}, 'DELIBERATION', 'IN_PERSON',
              'Room (synthetic)', null, now() + interval '1 hour', now() + interval '2 hours', ${REASON},
              'Synthetic: urgent walk meeting.') as id`,
          );
          const rows = await s.tx<{ id: string; user_id: string }[]>`
            select id, user_id from committee.meeting_participant where meeting_id = ${ids.meeting2}`;
          for (const [key, user] of [
            ["m2Chair", USERS.committeeChair],
            ["m2Member", USERS.committee],
            ["m2Deputy", USERS.investigatorB],
            ["m2Alternate", USERS.triage],
          ] as const) {
            ids[key] = rows.find((r) => r.user_id === user)!.id;
          }
          return ids.meeting2;
        },
      },
      {
        fn: "acknowledge_meeting_confidentiality",
        actor: "employeeB",
        run: async (s) => {
          await s.as("committeeSecretary");
          ids.m2Witness = await one(
            s,
            s.tx`select api.invite_to_meeting(${ids.meeting2!}, 'WITNESS', ${USERS.employeeB}, null, false, ${REASON}) as id`,
          );
          await s.as("employeeB");
          return s.tx`select api.acknowledge_meeting_confidentiality(${ids.m2Witness!})`;
        },
      },
      {
        fn: "record_meeting_accommodation",
        actor: "employeeB",
        run: (s) =>
          s.tx`select api.record_meeting_accommodation(${ids.m2Witness!}, 'Synthetic: step-free access requested.')`,
      },
      {
        fn: "activate_acting_chair",
        actor: "committeeSecretary",
        run: async (s) => {
          // Fixture: everyone declares; the meeting opens with the chair and the member recorded absent.
          for (const [key, seatKey] of [
            ["committeeChair", "m2Chair"],
            ["committee", "m2Member"],
            ["investigatorB", "m2Deputy"],
            ["triage", "m2Alternate"],
          ] as const) {
            await s.as(key);
            await s.tx`select api.declare_meeting_conflict(${ids[seatKey]!}, 'NO_CONFLICT', null)`;
          }
          await s.as("committeeSecretary");
          await s.tx`select api.open_meeting(${ids.meeting2!}, ${REASON})`;
          await s.tx`select api.record_attendance(${ids.m2Deputy!}, 'PRESENT')`;
          await s.tx`select api.record_attendance(${ids.m2Alternate!}, 'PRESENT')`;
          await s.tx`select api.record_attendance(${ids.m2Chair!}, 'ABSENT')`;
          await s.tx`select api.record_attendance(${ids.m2Member!}, 'ABSENT')`;
          return s.tx`select api.activate_acting_chair(${ids.meeting2!}, 'Synthetic: the chair is absent today.')`;
        },
      },
      {
        // DEC-AMB-010: a concern about the absent member, upheld by the deputy chair (the chair is absent) and
        // reversed by the next decider, the committee's independent authority.
        fn: "reverse_meeting_conflict_determination",
        actor: "complianceManager",
        run: async (s) => {
          await s.as("committeeSecretary");
          const concern = await one(
            s,
            s.tx`select api.raise_meeting_conflict(${ids.m2Member!}, 'Synthetic: walk concern to be upheld.') as id`,
          );
          await s.as("investigatorB");
          await s.tx`select api.decide_meeting_conflict(${concern}, 'UPHELD', 'Synthetic: walk concern upheld.')`;
          await s.as("complianceManager");
          return s.tx`select api.reverse_meeting_conflict_determination(${concern}, 'Synthetic: walk determination reversed.')`;
        },
      },
      {
        fn: "activate_alternate_member",
        actor: "committeeSecretary",
        run: (s) =>
          s.tx`select api.activate_alternate_member(${ids.m2Alternate!}, ${ids.m2Member!}, 'Synthetic: the member is absent today.')`,
      },
      {
        fn: "activate_acting_secretary",
        actor: "committeeSecretary",
        run: async (s) => {
          const handover = await s.tx`select api.activate_acting_secretary(${ids.meeting2!},
            'Synthetic: handing over for the rest of the meeting.')`;
          // DEC-AMB-003: the member whose upheld concern was just reversed voted on the walk package, which the
          // authority has decided. The reversal does not clear that taint. The acting secretary records the committee's
          // confirmation (the result stands without the member); the seated secretary raised a concern about the
          // member earlier, so may not.
          await s.as("grcDeputy");
          await s.tx`select api.resolve_conflict_taint(${ids.correctiveItem!}, 'CONFIRM',
            'Synthetic: the result stands without the member.')`;
          return handover;
        },
      },
      {
        fn: "revise_vote",
        actor: "investigatorB",
        run: async (s) => {
          await s.as("grcDeputy");
          ids.m2Item = await one(
            s,
            s.tx`select api.open_vote_item(${ids.meeting2!}, 'OTHER', null, 'Walk emergency item (synthetic)') as id`,
          );
          await s.as("investigatorB");
          await s.tx`select api.cast_vote(${ids.m2Item!}, 'APPROVE', null)`;
          return s.tx`select api.revise_vote(${ids.m2Item!}, 'REJECT', 'Synthetic: reconsidered.')`;
        },
      },
      {
        fn: "record_vote_note",
        actor: "investigatorB",
        run: (s) =>
          s.tx`select api.record_vote_note(${ids.m2Item!}, 'Synthetic: a dissent note for the minutes.', true)`,
      },
      {
        fn: "recuse_for_conflict",
        actor: "triage",
        run: async (s) => {
          await s.tx`select api.cast_vote(${ids.m2Item!}, 'APPROVE', null)`;
          await s.as("grcDeputy");
          await s.tx`select api.close_vote_item(${ids.m2Item!}, null)`;
          // The chair is back for the second item.
          await s.tx`select api.record_attendance(${ids.m2Chair!}, 'PRESENT')`;
          ids.m2Item2 = await one(
            s,
            s.tx`select api.open_vote_item(${ids.meeting2!}, 'OTHER', null, 'Walk second emergency item (synthetic)') as id`,
          );
          await s.as("triage");
          return s.tx`select api.recuse_for_conflict(${ids.m2Item2!}, 'Synthetic: related to a party.')`;
        },
      },
      {
        fn: "overrule_minutes_objection",
        actor: "committeeChair",
        run: async (s) => {
          for (const key of ["committeeChair", "investigatorB"] as const) {
            await s.as(key);
            await s.tx`select api.cast_vote(${ids.m2Item2!}, 'APPROVE', null)`;
          }
          await s.as("grcDeputy");
          await s.tx`select api.close_vote_item(${ids.m2Item2!}, null)`;
          await s.tx`select api.close_meeting(${ids.meeting2!}, ${REASON})`;
          const minutes = await one(
            s,
            s.tx`select api.generate_minutes(${ids.meeting2!}, 'Synthetic minutes of the emergency meeting.') as id`,
          );
          await s.as("investigatorB");
          await s.tx`select api.review_minutes(${minutes}, 'REQUEST_CHANGES', 'Synthetic: please correct item two.')`;
          await s.as("committeeChair");
          return s.tx`select api.overrule_minutes_objection(${minutes}, 'Synthetic: the minutes record item two correctly.')`;
        },
      },
      {
        // AMB-108 (migration 2030): before submission the secretary returns the adopted package to the committee.
        fn: "return_package_to_committee",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.return_package_to_committee(${ids.restrictedPkg!}, ${REASON})`,
      },
      {
        // DEC-AMB-003 (owner, 2026-10-13): a member who voted declares a conflict after the vote; the rule in force needs
        // two present, so the result could change without them and the committee takes the vote again.
        fn: "resolve_conflict_taint",
        actor: "committeeSecretary",
        run: async (s) => {
          const p = await one(
            s,
            s.tx`select id from committee.meeting_participant
                 where meeting_id = ${ids.restrictedMeeting!} and user_id = ${USERS.committee}`,
          );
          const item = await one(
            s,
            s.tx`select id from decision.recommendation_item where package_id = ${ids.restrictedPkg!}`,
          );
          await s.as("committee");
          await s.tx`select api.declare_meeting_conflict(${p}, 'CONFLICT_DECLARED', 'Synthetic: walk conflict after the vote.')`;
          await s.as("committeeSecretary");
          return s.tx`select api.resolve_conflict_taint(${item}, 'RE_VOTE', 'Synthetic: the vote is taken again.')`;
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
      // Migration 2040 (DEC-F09): a third referral rejected twice is escalated to the Investigation Committee Chair
      // (owner default), who upholds the rejection; then COMMITTEE_ADMIN restates the target.
      {
        fn: "escalate_referral_rejection",
        actor: "sectorHead",
        run: async (s) => {
          await s.as("employee");
          ids.referral3 = await one(
            s,
            s.tx`select api.create_referral(${ids.sector!}, 'Third walk referral (synthetic)', 'Synthetic: third referral summary.',
              'FRAUD', 'RESTRICTED'::core.classification_level) as id`,
          );
          await s.tx`select api.submit_referral(${ids.referral3!}, null)`;
          for (let round = 0; round < 2; round += 1) {
            if (round > 0) {
              await s.as("employee");
              await s.tx`select api.resubmit_referral(${ids.referral3!}, null)`;
            }
            await s.as("sectorHead");
            await s.tx`select api.sector_decide_referral(${ids.referral3!}, 'APPROVE', null, null)`;
            await s.as("committeeSecretary");
            await s.tx`select api.secretary_decide_referral(${ids.referral3!}, 'REJECT', array['OUT_OF_SCOPE'], null, null)`;
          }
          await s.as("sectorHead");
          return s.tx`select api.escalate_referral_rejection(${ids.referral3!}, 'Synthetic: the rejection misreads the scope.')`;
        },
      },
      {
        fn: "decide_referral_escalation",
        actor: "committeeChair",
        run: (s) =>
          s.tx`select api.decide_referral_escalation(${ids.referral3!}, 'UPHOLD', array['OUT_OF_SCOPE'], null, null)`,
      },
      {
        fn: "set_referral_escalation_target",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.set_referral_escalation_target((select id from committee.committee where code = 'IC'), 'CHAIR',
            now(), 'DEMO-DEC-F09', ${REASON})`,
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
      // DEC-F41 (migration 2070): a corrective action from preliminary review. A second recommendation on case A keeps
      // the matter with Compliance (NOT_SERIOUS); its preparer proposes a corrective action under a synthetic
      // PRELIMINARY_CORRECTIVE_ACTION_TYPES; once endorsed and approved (fixtures), a corrective-action manager records
      // the required authority's decision and opens the action.
      {
        fn: "propose_preliminary_corrective_action",
        actor: "investigatorA",
        run: async (s) => {
          ids.correctiveRecommendation = await apart(
            s,
            async () => {
              await setPreliminaryCorrectiveTypes(s as OwnerScenario, "CORRECTIVE_ACTION");
              await s.as("investigatorA");
              return one(
                s,
                s.tx`select api.prepare_preliminary_recommendation(${caseA}, 'NOT_SERIOUS',
                  'Synthetic: the walk recommendation keeps the matter with Compliance.') as id`,
              );
            },
            "investigatorA",
          );
          return (ids.preliminaryProposal = await one(
            s,
            s.tx`select api.propose_preliminary_corrective_action(${ids.correctiveRecommendation}, 'CORRECTIVE_ACTION',
              'Synthetic: the walk corrective-action proposal.') as id`,
          ));
        },
      },
      {
        fn: "record_preliminary_authority_decision",
        actor: "caseManager",
        run: async (s) => {
          const authority = await apart(
            s,
            async () => {
              await s.as("grcDirector");
              await s.tx`select api.review_preliminary_recommendation(${ids.correctiveRecommendation!}, 'ENDORSE', null, null)`;
              await s.as("grcSectorHead");
              await s.tx`select api.approve_preliminary_recommendation(${ids.correctiveRecommendation!}, 'APPROVE', null, null)`;
              await s.as("caseManager");
              return one(
                s,
                s.tx`select authority_type from decision.preliminary_authority_requirement
                     where proposal_id = ${ids.preliminaryProposal!}`,
              );
            },
            "caseManager",
          );
          return s.tx`select api.record_preliminary_authority_decision(${ids.preliminaryProposal!}, ${authority},
            'APPROVED', now(), 'Delegated executive (synthetic)', 'MEMO-WALK-2070', ${REASON})`;
        },
      },
      {
        fn: "open_preliminary_corrective_action",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.open_preliminary_corrective_action(${ids.preliminaryProposal!}, 'Synthetic: walk preliminary action',
            'Synthetic: add a second approver for the walk.', ${USERS.financeEmployee}, current_date + 30)`,
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
      // Since S3 (ADR-016 D2) a committee seat opens no case: the committee form runs on a CASE grant.
      {
        fn: "grant_case_access",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.grant_case_access(${caseA}, ${USERS.committeeSecretary}, 'CASE', ${REASON}, null)`,
      },
      {
        fn: "grant_case_access",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.grant_case_access(${caseA}, ${USERS.committeeChair}, 'CASE', ${REASON}, null)`,
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
      // Closure (migration 2060, DEC-F40) with a synthetic closure authority (GRC_DIRECTOR; the setting is
      // SOURCE_REQUIRED and migration-managed, so the owner fixture sets it): the case manager's closure is a request
      // the GRC director approves. A reopening request is then rejected, so the case stays closed for the records steps.
      {
        fn: "close_case",
        actor: "caseManager",
        run: async (s) => {
          await apart(s, () => setClosureAuthority(s as OwnerScenario, "GRC_DIRECTOR"), "caseManager");
          return s.tx`select api.close_case(${ids.case!}, 'NO_ACTION', ${REASON})`;
        },
      },
      {
        fn: "decide_case_closure",
        actor: "grcDirector",
        run: async (s) => {
          const request = await one(
            s,
            s.tx`select id from case_mgmt.case_closure_request where case_id = ${ids.case!} and status = 'AWAITING_APPROVAL'`,
          );
          return s.tx`select api.decide_case_closure(${request}, 'APPROVE', ${REASON})`;
        },
      },
      {
        fn: "request_case_reopening",
        actor: "caseManager",
        run: async (s) =>
          (ids.reopening = await one(
            s,
            s.tx`select api.request_case_reopening(${ids.case!}, 'NEW_EVIDENCE', ${REASON},
              'Synthetic: a further extract received after closure.', 'DEMO-WALK-REF', null) as id`,
          )),
      },
      {
        fn: "decide_case_reopening",
        actor: "grcDirector",
        run: (s) => s.tx`select api.decide_case_reopening(${ids.reopening!}, 'REJECT', ${REASON})`,
      },
      {
        fn: "transition_case",
        actor: "caseManager",
        run: (s) => s.tx`select api.transition_case(${ids.case!}, 'ARCHIVE_CASE', null)`,
      },
      // AMB-223 (migration 2090): records staff annotate the archived record; the original stays.
      {
        fn: "annotate_archived_record",
        actor: "records",
        run: (s) =>
          s.tx`select api.annotate_archived_record(${ids.case!}, 'CASE_CLOSURE', 'Synthetic: the closure note names the wrong week.',
            ${REASON})`,
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
      // Notifications (migration 1920): a rule, a preference and a read mark.
      {
        fn: "set_notification_rule",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.set_notification_rule('EVENT_RULE', 'MEETING_CANCELLED', null, 'EMAIL', true, now(), ${REASON})`,
      },
      {
        fn: "set_notification_preference",
        actor: "legal",
        run: (s) => s.tx`select api.set_notification_preference('COMMITTEE_SEAT_ENDED', 'IN_APP', true)`,
      },
      {
        fn: "mark_notification_read",
        actor: "committeeChair",
        run: async (s) => {
          const n = await one(s, s.tx`select id from notify.outbox where read_at is null limit 1`);
          return s.tx`select api.mark_notification_read(${n})`;
        },
      },
      // Employee defence and grievance (migration 1910): the walk subject is linked to employee's portal account,
      // answers one notice through the portal and one on paper, and files a grievance the Grievance Committee
      // admits and decides; a standalone grievance under a CHAIR rule is decided by the chair.
      {
        fn: "link_subject_portal_account",
        actor: "caseManager",
        run: async (s) =>
          (ids.portalLink = await one(
            s,
            s.tx`select api.link_subject_portal_account(${ids.subject!}, ${USERS.employee}, ${REASON}) as id`,
          )),
      },
      {
        fn: "issue_defence_notice",
        actor: "caseManager",
        run: async (s) => {
          ids.notice2 = await one(
            s,
            s.tx`select api.issue_defence_notice(${ids.subject!}, 'Synthetic: walk notice (paper reply).',
              ${[ids.allegation!]}::uuid[], now() + interval '10 days') as id`,
          );
          return (ids.notice = await one(
            s,
            s.tx`select api.issue_defence_notice(${ids.subject!}, 'Synthetic: walk notice.',
              ${[ids.allegation!]}::uuid[], now() + interval '10 days') as id`,
          ));
        },
      },
      {
        fn: "acknowledge_defence_notice",
        actor: "employee",
        run: (s) => s.tx`select api.acknowledge_defence_notice(${ids.notice!})`,
      },
      {
        fn: "submit_defence_response",
        actor: "employee",
        run: (s) => s.tx`select api.submit_defence_response(${ids.notice!}, 'Synthetic: my walk response.')`,
      },
      {
        fn: "record_defence_response",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.record_defence_response(${ids.notice2!}, 'EMAIL', now(),
            'Synthetic: walk response received by email.', 'EMAIL-DEMO-WALK')`,
      },
      // Migration 2040 (DEC-F18): a third notice's period is extended.
      {
        fn: "change_defence_deadline",
        actor: "caseManager",
        run: async (s) => {
          const n = await one(
            s,
            s.tx`select api.issue_defence_notice(${ids.subject!}, 'Synthetic: walk notice (extended).',
              ${[ids.allegation!]}::uuid[], now() + interval '10 days') as id`,
          );
          return s.tx`select api.change_defence_deadline(${n}, 'EXTENSION', now() + interval '20 days', ${REASON})`;
        },
      },
      // Kinds of employee notice (migration 1990): a rights notice to the walk subject; a decision notice of the
      // walk's authority decision (its corrective action applies to the whole case) to a second subject linked to
      // the same employee, who grieves it from the portal.
      {
        fn: "issue_rights_notice",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.issue_rights_notice(${ids.subject!}, 'Synthetic: walk rights notice.', ${[ids.allegation!]}::uuid[])`,
      },
      {
        fn: "issue_decision_notice",
        actor: "caseManager",
        run: async (s) => {
          // Fixture (2040, AMB-141): a Grievance Committee rule version with a completion period (SOURCE_REQUIRED in
          // the seed), in force from a second ago so later rule changes in the walk are not refused as scheduled.
          await (s as OwnerScenario).asOwner();
          await s.tx`
            with cur as (
              update committee.rule_set r set effective_to = now() - interval '1 second'
              from committee.committee c
              where c.id = r.committee_id and c.kind = 'GRIEVANCE' and r.effective_to is null returning r.*)
            insert into committee.rule_set
            select (jsonb_populate_record(null::committee.rule_set, to_jsonb(cur) || jsonb_build_object(
              'id', gen_random_uuid(), 'effective_from', now() - interval '1 second', 'effective_to', null,
              'grievance_completion_days', 10, 'source_status', 'APPROVED', 'reason', ${REASON}::text,
              'created_by', ${USERS.platformAdmin}::uuid))).*
            from cur`;
          await s.as("caseManager");
          ids.subject2 = await one(
            s,
            s.tx`select api.add_case_subject(${caseA}, 'Employee Omicron Two (synthetic)', 'EMPLOYEE', null) as id`,
          );
          await s.tx`select api.link_subject_portal_account(${ids.subject2}, ${USERS.employee}, ${REASON})`;
          return (ids.decisionNotice = await one(
            s,
            s.tx`select api.issue_decision_notice(${ids.subject2}, ${ids.decision!}, 'Synthetic: walk decision notice.') as id`,
          ));
        },
      },
      {
        fn: "file_grievance_on_decision_notice",
        actor: "employee",
        run: async (s) =>
          (ids.dnGrievance = await one(
            s,
            s.tx`select api.file_grievance_on_decision_notice(${ids.decisionNotice!},
              'Synthetic: walk grievance on the decision notice.') as id`,
          )),
      },
      // Migration 2040: the walk subject's decision notice is delivered and its sanction executed after the subject
      // left employment, under a statement for its type (DEC-F15, AMB-109; DEC-AMB-004, -009 (owner, 2026-10-13)).
      {
        fn: "record_notice_delivery",
        actor: "caseManager",
        run: async (s) => {
          const n = await one(
            s,
            s.tx`select api.issue_decision_notice(${ids.subject!}, ${ids.decision!}, 'Synthetic: walk sanction notice.') as id`,
          );
          return s.tx`select api.record_notice_delivery(${n}, 'HAND_DELIVERY', now(), 'HAND-DEMO-WALK')`;
        },
      },
      {
        fn: "set_sanction_rule",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.set_sanction_rule('WARNING', null, false, 'PROCEED', 'SOURCE_REQUIRED', ${REASON})`,
      },
      {
        fn: "flag_subject_left_employment",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.flag_subject_left_employment(${ids.subject!}, current_date, 'HR-DEMO-WALK')`,
      },
      {
        fn: "record_employment_execution_statement",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.record_employment_execution_statement(${ids.subject!}, 'WARNING', 'HR-DEMO-WALK-2', ${REASON})`,
      },
      {
        fn: "record_sanction_execution",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.record_sanction_execution(${ids.sanctionItem!}, ${ids.subject!}, now(), 'HR-DEMO-WALK-3')`,
      },
      {
        fn: "file_grievance",
        actor: "employee",
        run: async (s) =>
          (ids.grievance = await one(
            s,
            s.tx`select api.file_grievance(${ids.portalLink!}, now() - interval '1 day',
              'Synthetic: walk grievance grounds.') as id`,
          )),
      },
      {
        fn: "revoke_subject_portal_link",
        actor: "caseManager",
        run: (s) => s.tx`select api.revoke_subject_portal_link(${ids.portalLink!}, ${REASON})`,
      },
      {
        // Fixture: the Grievance Committee is seated with members who took no part in the case's investigation (N9).
        fn: "assess_grievance_admissibility",
        actor: "committeeSecretary",
        run: async (s) => {
          const [gc] = await admin<
            { id: string }[]
          >`select id from committee.committee where kind = 'GRIEVANCE'`;
          ids.gc = gc!.id;
          await s.as("platformAdmin");
          for (const [user, seat] of [
            ["legal", "CHAIR"],
            ["committeeSecretary", "SECRETARY"],
            ["legalB", "MEMBER"],
          ] as const) {
            await s.tx`select api.appoint_committee_member(${ids.gc}, ${USERS[user]}, ${seat}, now(), null, 'DEMO-APPT-GC')`;
          }
          await s.as("committeeSecretary");
          return s.tx`select api.assess_grievance_admissibility(${ids.grievance!}, 'ADMISSIBLE', null, ${REASON})`;
        },
      },
      // Migration 2040 (AMB-141): the decision-notice grievance is completed on request.
      {
        fn: "request_grievance_completion",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.request_grievance_completion(${ids.dnGrievance!}, ${REASON})`,
      },
      {
        fn: "complete_grievance",
        actor: "employee",
        run: (s) =>
          s.tx`select api.complete_grievance(${ids.dnGrievance!}, 'Synthetic: the walk grievance supplement.')`,
      },
      {
        // G2: the restricted case's owner names the GC secretary (cleared to SECRET earlier in the walk), who then
        // records a linked grievance on it.
        fn: "approve_restricted_grievance_recording",
        actor: "grcDirector",
        run: async (s) => {
          const exec = await caseId("0003");
          const r =
            await s.tx`select api.approve_restricted_grievance_recording(${exec}, ${USERS.committeeSecretary}, ${REASON})`;
          const [c] = await admin<
            { n: string }[]
          >`select case_number as n from case_mgmt.case_record where id = ${exec}`;
          await s.as("committeeSecretary");
          ids.restrictedGrievance = await one(
            s,
            s.tx`select api.record_grievance('LINKED', ${c!.n}, 'Employee Psi (synthetic)', null, null, null, 'EMAIL',
              now(), now() - interval '2 days', 'Synthetic: walk restricted grievance.', 'EMAIL-DEMO-WALK3') as id`,
          );
          return r;
        },
      },
      {
        // G2b: the owner names a second, cleared secretary to handle that grievance.
        fn: "approve_restricted_grievance_handling",
        actor: "grcDirector",
        run: async (s) => {
          await s.as("platformAdmin");
          await s.tx`select api.appoint_committee_member(${ids.gc!}, ${USERS.grcDeputy}, 'ALTERNATE_SECRETARY', now(), null,
            'DEMO-APPT-GC')`;
          await s.as("grcDirector");
          return s.tx`select api.approve_restricted_grievance_handling(${ids.restrictedGrievance!}, ${USERS.grcDeputy},
            ${REASON})`;
        },
      },
      {
        fn: "record_grievance_outcome",
        actor: "committeeSecretary",
        run: async (s) => {
          const vi = await grievanceVote(s, ids.grievance!);
          return s.tx`select api.record_grievance_outcome(${ids.grievance!}, ${["UPHOLD"]}::text[], null, ${vi},
            'Synthetic: the walk grievance outcome.')`;
        },
      },
      // Migration 2040, DEC-AMB-001 (owner, 2026-10-13): the one reconsideration of a decided grievance, recorded by
      // the Secretary (then withdrawn by the grievant, AMB-140) and filed through the portal on new evidence.
      {
        fn: "record_grievance_reconsideration",
        actor: "committeeSecretary",
        run: async (s) =>
          (ids.reconsideration = await one(
            s,
            s.tx`select api.record_grievance_reconsideration(${ids.grievance!}, 'EMAIL', now(),
              'Synthetic: walk reconsideration grounds.', 'EMAIL-DEMO-WALK4',
              'Synthetic: walk new evidence description.', 'EVIDENCE-DEMO-WALK') as id`,
          )),
      },
      {
        fn: "withdraw_grievance",
        actor: "employee",
        run: (s) => s.tx`select api.withdraw_grievance(${ids.reconsideration!}, ${REASON})`,
      },
      {
        fn: "file_grievance_reconsideration",
        actor: "employee",
        run: async (s) => {
          // Fixture: the walk grievance's proceeding is concluded, and the decision-notice grievance is admitted and
          // decided, so that it can be reconsidered.
          await s.as("caseManager");
          const p = await one(
            s,
            s.tx`select cp.proceeding_id from grievance.grievance g
                 join committee.committee_proceeding cp on cp.id = g.committee_proceeding_id where g.id = ${ids.grievance!}`,
          );
          await s.tx`select api.close_proceeding(${p}, 'CONCLUDED', 'DECISION_RECORDED', ${REASON})`;
          await s.as("committeeSecretary");
          await s.tx`select api.assess_grievance_admissibility(${ids.dnGrievance!}, 'ADMISSIBLE', null, ${REASON})`;
          const vi = await grievanceVote(s, ids.dnGrievance!);
          await s.tx`select api.record_grievance_outcome(${ids.dnGrievance!}, ${["UPHOLD"]}::text[], null, ${vi},
            'Synthetic: the walk decision-notice grievance outcome.')`;
          await s.as("employee");
          return s.tx`select api.file_grievance_reconsideration(${ids.dnGrievance!},
            'Synthetic: walk reconsideration grounds.', 'Synthetic: walk new evidence description.',
            'EVIDENCE-DEMO-WALK-2')`;
        },
      },
      {
        // Fixture: a CHAIR rule in force from now (Q93), so the standalone grievance waits for the chair.
        fn: "record_grievance",
        actor: "committeeSecretary",
        run: async (s) => {
          await s.as("platformAdmin");
          await s.tx`select api.set_committee_rule_set(${ids.gc!}, now(), 'MAJORITY_ELIGIBLE', null, true, 3, true, 30,
            'CHAIR', 'NO_DECISION', 'SOURCE_REQUIRED', ${REASON})`;
          await s.as("committeeSecretary");
          return (ids.grievance2 = await one(
            s,
            s.tx`select api.record_grievance('STANDALONE', null, 'Employee Phi (synthetic)', 'Walk grievance (synthetic)',
              'CONFIDENTIAL'::core.classification_level, ${USERS.caseManager}, 'EMAIL', now(), now(),
              'Synthetic: walk standalone grievance.', 'EMAIL-DEMO-WALK2') as id`,
          ));
        },
      },
      {
        fn: "decide_grievance_admissibility",
        actor: "legal",
        run: async (s) => {
          await s.as("committeeSecretary");
          await s.tx`select api.assess_grievance_admissibility(${ids.grievance2!}, 'INADMISSIBLE', null, ${REASON})`;
          await s.as("legal");
          // 2040 (DEC-F17): a non-admission is the committee's, recorded by the chair with its reference.
          return s.tx`select api.decide_grievance_admissibility(${ids.grievance2!}, 'INADMISSIBLE', 'GC-DEMO-WALK', ${REASON})`;
        },
      },
      // Export builder (migration 1930): an external email export of case A's summary, approved, generated and
      // sent; a second draft is cancelled. The walk rule is switched off (NONE) and matches nothing.
      // 2040 (DEC-F24): the platform administrator holds export policy; an approver (grcDirector) no longer may.
      {
        fn: "set_export_rule",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.set_export_rule('WALK_RULE', 'ANY', null, 'MINUTES', false, 'NONE', now(), 'SOURCE_REQUIRED', ${REASON})`,
      },
      {
        fn: "set_export_purpose",
        actor: "platformAdmin",
        run: (s) =>
          s.tx`select api.set_export_purpose('WALK_PURPOSE', 'Walk purpose (synthetic)', 'غرض تجريبي', false, false, 99,
            ${REASON})`,
      },
      {
        fn: "add_export_approver",
        actor: "platformAdmin",
        run: async (s) =>
          (ids.exportApprover = await one(
            s,
            s.tx`select api.add_export_approver(${USERS.grcDeputy}, 2, ${REASON}) as id`,
          )),
      },
      {
        fn: "revoke_export_approver",
        actor: "platformAdmin",
        // The stage-2 pool stays in use and empty until the deputy is added again (fixture for decide_export below).
        run: async (s) => {
          await s.tx`select api.revoke_export_approver(${ids.exportApprover!}, ${REASON})`;
          return s.tx`select api.add_export_approver(${USERS.grcDeputy}, 2, ${REASON})`;
        },
      },
      {
        fn: "create_export_request",
        actor: "caseManager",
        run: async (s) =>
          (ids.exportRequest = await one(
            s,
            s.tx`select api.create_export_request(${caseA}, 'EMAIL', 'EXTERNAL', 'REGULATORY_OR_EXTERNAL_AUTHORITY',
              'Regulator Alpha (synthetic)', 'Synthetic: the regulator asked for the case summary.') as id`,
          )),
      },
      {
        fn: "add_export_item",
        actor: "caseManager",
        run: (s) => s.tx`select api.add_export_item(${ids.exportRequest!}, 'CASE_SUMMARY', ${caseA})`,
      },
      {
        fn: "add_export_recipient",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.add_export_recipient(${ids.exportRequest!}, 'EXTERNAL', null, 'walk.officer@example.test')`,
      },
      {
        fn: "preview_export",
        actor: "caseManager",
        run: async (s) =>
          (ids.exportHash = await one(
            s,
            s.tx`select api.preview_export(${ids.exportRequest!}) ->> 'hash' as h`,
          )),
      },
      {
        fn: "submit_export",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.submit_export(${ids.exportRequest!}, ${ids.exportHash!},
            (select classification from case_mgmt.case_record where id = ${caseA}))`,
      },
      {
        fn: "decide_export",
        actor: "grcDirector",
        run: (s) =>
          s.tx`select api.decide_export(${ids.exportRequest!}, 'APPROVE', ${REASON}, ${ids.exportHash!})`,
      },
      {
        fn: "generate_export",
        actor: "caseManager",
        run: async (s) => {
          // Fixture: a second approval when the case's classification rule asks for one.
          const status = await one(
            s,
            s.tx`select status from exchange.export_request where id = ${ids.exportRequest!}`,
          );
          if (status === "SUBMITTED") {
            await s.as("grcDeputy");
            await s.tx`select api.decide_export(${ids.exportRequest!}, 'APPROVE', ${REASON}, ${ids.exportHash!})`;
            await s.as("caseManager");
          }
          return s.tx`select api.generate_export(${ids.exportRequest!})`;
        },
      },
      {
        fn: "record_export_sent",
        actor: "caseManager",
        run: (s) => s.tx`select api.record_export_sent(${ids.exportRequest!})`,
      },
      {
        fn: "cancel_export",
        actor: "caseManager",
        run: async (s) => {
          const draft = await one(
            s,
            s.tx`select api.create_export_request(${caseA}, 'PDF', 'INTERNAL', 'INTERNAL_MANAGEMENT_REVIEW', null, null) as id`,
          );
          return s.tx`select api.cancel_export(${draft}, ${REASON})`;
        },
      },
      {
        fn: "decide_restricted_export",
        actor: "grcDirector",
        run: async (s) => {
          // Fixture: a teammate granted case 0003 exports its summary internally; grcDirector, its owner and
          // Restricted Case Authority, consents (never to their own request: CDF-208).
          const exec = await caseId("0003");
          await s.tx`select api.grant_case_access(${exec}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
          await s.as("grcDeputy");
          const request = await one(
            s,
            s.tx`select api.create_export_request(${exec}, 'PDF', 'INTERNAL', 'INTERNAL_MANAGEMENT_REVIEW', null, null) as id`,
          );
          await s.tx`select api.add_export_item(${request}, 'CASE_SUMMARY', ${exec})`;
          const hash = await one(s, s.tx`select api.preview_export(${request}) ->> 'hash' as h`);
          await s.tx`select api.submit_export(${request}, ${hash},
            (select classification from case_mgmt.case_record where id = ${exec}))`;
          await s.as("grcDirector");
          return s.tx`select api.decide_restricted_export(${request}, 'APPROVE', ${REASON}, ${hash})`;
        },
      },
      // Migration 2040 (DEC-F30): the continuity-operator registry; the case manager is the seeded operator.
      {
        fn: "authorize_continuity_operator",
        actor: "platformAdmin",
        run: async (s) =>
          (ids.bcpOperator = await one(
            s,
            s.tx`select api.authorize_continuity_operator(${USERS.lead}, 'BCP-AUTH-WALK', ${REASON}) as id`,
          )),
      },
      {
        fn: "revoke_continuity_operator",
        actor: "platformAdmin",
        run: (s) => s.tx`select api.revoke_continuity_operator(${ids.bcpOperator!}, ${REASON})`,
      },
      // Continuity workbook import (migration 1960, ADR-034): a subject recorded offline and a recorded-only row.
      {
        fn: "stage_bcp_import",
        actor: "caseManager",
        run: async (s) => (ids.bcpBatch = await one(s, stageWalkWorkbook(s, "BCP-WALK-1"))),
      },
      {
        fn: "resolve_bcp_row",
        actor: "caseManager",
        run: async (s) => {
          const unsupported = await one(
            s,
            s.tx`select id from exchange.bcp_import_row where batch_id = ${ids.bcpBatch!} and state = 'UNSUPPORTED'`,
          );
          return s.tx`select api.resolve_bcp_row(${unsupported}, 'SKIP', 'Synthetic: entered online after the outage.')`;
        },
      },
      {
        fn: "preview_bcp_import",
        actor: "caseManager",
        run: async (s) =>
          (ids.bcpHash = await one(s, s.tx`select api.preview_bcp_import(${ids.bcpBatch!}) ->> 'hash' as h`)),
      },
      {
        fn: "submit_bcp_import",
        actor: "caseManager",
        run: (s) => s.tx`select api.submit_bcp_import(${ids.bcpBatch!}, ${ids.bcpHash!})`,
      },
      {
        fn: "decide_bcp_import",
        actor: "grcDirector",
        run: (s) =>
          s.tx`select api.decide_bcp_import(${ids.bcpBatch!}, 'APPROVE', ${REASON}, ${ids.bcpHash!})`,
      },
      {
        fn: "apply_bcp_import",
        actor: "caseManager",
        run: (s) => s.tx`select api.apply_bcp_import(${ids.bcpBatch!}, ${ids.bcpHash!})`,
      },
      {
        fn: "cancel_bcp_import",
        actor: "caseManager",
        run: async (s) => {
          const batch = await one(s, stageWalkWorkbook(s, "BCP-WALK-2"));
          return s.tx`select api.cancel_bcp_import(${batch}, ${REASON})`;
        },
      },
      {
        // DEC-AMB-013/014 (owner, 2026-10-13): a second walk package on the walk proceeding, decided on the decisive vote
        // of a member added for it; that member then declares a conflict, the committee votes again without them, the
        // authority decides again, and the case manager records the replacement decision's disposition of the action
        // the first decision opened (fixture: every step before the disposition, through the api.* commands). The
        // member is absent and the alternate not called: their votes would be tainted by the concern upheld and
        // reversed above (DEC-AMB-010) and by the alternate's recusal.
        fn: "dispose_superseded_corrective_action",
        actor: "caseManager",
        run: async (s) => {
          await s.as("platformAdmin");
          const added = await one(
            s,
            s.tx`select api.appoint_committee_member(${ids.committee!}, ${USERS.legal}, 'MEMBER', now(), null,
              'DEMO-APPT-07') as id`,
          );
          await s.as("committeeSecretary");
          await s.tx`select api.amend_proceeding_snapshot(${ids.committeeProceeding!}, ${added},
            'Synthetic: a member appointed for the second walk package.')`;
          const m = await one(
            s,
            s.tx`select api.schedule_meeting(${ids.committeeProceeding!}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)',
              null, now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`,
          );
          const rows = await s.tx<{ id: string; user_id: string }[]>`
            select id, user_id from committee.meeting_participant where meeting_id = ${m}`;
          const seat = (u: UserKey) => rows.find((r) => r.user_id === USERS[u])!.id;
          for (const u of ["committeeChair", "committee", "legal"] as const) {
            await s.as(u);
            await s.tx`select api.declare_meeting_conflict(${seat(u)}, 'NO_CONFLICT', null)`;
          }
          await s.as("committeeSecretary");
          await s.tx`select api.open_meeting(${m}, ${REASON})`;
          for (const u of ["committeeChair", "legal"] as const) {
            await s.tx`select api.record_attendance(${seat(u)}, 'PRESENT')`;
          }
          await s.tx`select api.record_attendance(${seat("committee")}, 'ABSENT')`;
          const pkg = await one(
            s,
            s.tx`select api.create_recommendation_package(${ids.committeeProceeding!}, 'PACKAGE') as id`,
          );
          const item = await one(
            s,
            s.tx`select api.add_recommendation_item(${pkg}, 'CORRECTIVE_ACTION', null, null,
              'Synthetic: second walk corrective action.', null, null) as id`,
          );
          await s.tx`select api.submit_package_for_vote(${pkg})`;
          // One round: the package vote, adoption, legal review and the authority's decision citing `source`.
          const round = async (choices: [UserKey, string][], source: string) => {
            await s.as("committeeSecretary");
            await s.tx`select api.open_package_vote(${m}, ${pkg})`;
            const vi = await one(
              s,
              s.tx`select vi.id from committee.vote_item vi
                   join decision.recommendation_package p on p.id = vi.package_id and vi.package_round = p.round_no
                   where p.id = ${pkg}`,
            );
            for (const [u, choice] of choices) {
              await s.as(u);
              await s.tx`select api.cast_vote(${vi}, ${choice}, null)`;
            }
            await s.as("committeeSecretary");
            await s.tx`select api.close_vote_item(${vi}, null)`;
            await s.tx`select api.record_package_adoption(${pkg})`;
            const request = await one(
              s,
              s.tx`select api.request_legal_review(${pkg}, ${USERS.legalB}, ${REASON}, null, null) as id`,
            );
            await s.as("legalB");
            await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
            await s.as("committeeSecretary");
            await s.tx`select api.submit_to_authority(${pkg})`;
            return one(
              s,
              s.tx`select api.record_authority_decision(${pkg}, 'DELEGATED_EXECUTIVE', 'APPROVE_AS_RECOMMENDED', now(),
                'Delegated executive (synthetic)', ${source}, null, ${REASON}) as id`,
            );
          };
          await round(
            [
              ["legal", "APPROVE"],
              ["committeeChair", "ABSTAIN"],
            ],
            "MEMO-DEMO-WALK-D1",
          );
          await s.as("caseManager");
          const action = await one(
            s,
            s.tx`select api.open_corrective_action(${item}, 'Synthetic: second walk action',
              'Synthetic: second walk corrective action text.', ${USERS.financeEmployee}, current_date + 30) as id`,
          );
          await s.as("legal");
          await s.tx`select api.declare_meeting_conflict(${seat("legal")}, 'CONFLICT_DECLARED',
            'Synthetic: walk conflict found after the decision.')`;
          await s.as("committeeSecretary");
          await s.tx`select api.resolve_conflict_taint(${item}, 'RE_VOTE', 'Synthetic: the vote is taken again.')`;
          await round([["committeeChair", "APPROVE"]], "MEMO-DEMO-WALK-D2");
          await s.as("caseManager");
          return s.tx`select api.dispose_superseded_corrective_action(${action}, 'RE_ADOPT', 'MEMO-DEMO-WALK-D2',
            ${REASON}, null, null, null, null)`;
        },
      },
      // Migration 2050 (ADR-041), on case 0004: the lead investigator becomes its second evidence lead, beside the case
      // manager (investigator B is suspended by now); the Defence Packet policy records a synthetic
      // LEGAL_PRIVILEGE_RULE (owner fixture, rolled back).
      {
        fn: "exclude_evidence",
        actor: "lead",
        run: async (s) => {
          const case4 = await apart(
            s,
            async () => {
              const c = await caseId("0004");
              ids.case4 = c;
              await setPacketPolicy(s as OwnerScenario);
              await s.as("caseManager");
              await s.tx`select api.assign_case(${c}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`;
              stored.kept = await storeEvidence(s, "caseManager", c);
              stored.dropped = await storeEvidence(s, "caseManager", c);
              stored.failed = await storeEvidence(s, "caseManager", c);
              return c;
            },
            "lead",
          );
          expect(case4).toBe(ids.case4);
          return s.tx`select api.exclude_evidence(${stored.dropped!.evidenceId}, ${REASON})`;
        },
      },
      {
        fn: "record_custody_exception",
        actor: "caseManager",
        run: (s) =>
          s.tx`select api.record_custody_exception(${stored.kept!.evidenceId}, ${stored.kept!.versionId},
            'EXTERNAL_TRANSFER', ${REASON}, 'EXT-DEMO-WALK')`,
      },
      // The case manager makes the redacted rendition; the lead, who neither chose the item nor made the rendition,
      // clears it (CDF-217(1), migration 2060).
      {
        fn: "register_evidence_rendition",
        actor: "caseManager",
        run: async (s) => {
          const [r] = await s.tx<{ v: string }[]>`
            select o_version_id as v from api.register_evidence_rendition(${stored.kept!.versionId}, 'walk-redacted.pdf',
              'application/pdf', 256, ${newSha()})`;
          ids.rendition = r!.v;
          await apart(
            s,
            () => s.tx`select api.complete_evidence_version(${ids.rendition!}, 'CLEAN', 'walk-scanner')`,
            "caseManager",
          );
          return r;
        },
      },
      {
        fn: "report_evidence_integrity_failure",
        actor: "lead",
        run: (s) =>
          s.tx`select api.report_evidence_integrity_failure(${stored.failed!.versionId}, ${newSha()})`,
      },
      {
        fn: "create_defence_packet",
        actor: "caseManager",
        run: async (s) => {
          const n = await apart(
            s,
            () => defenceNotice(s, ids.case4!, "caseManager", "employeeB"),
            "caseManager",
          );
          return (ids.defencePacket = await one(
            s,
            s.tx`select api.create_defence_packet(${n.notice}) as id`,
          ));
        },
      },
      {
        fn: "add_defence_packet_item",
        actor: "caseManager",
        run: async (s) =>
          (ids.defenceItem = await one(
            s,
            s.tx`select api.add_defence_packet_item(${ids.defencePacket!}, ${stored.kept!.versionId}) as id`,
          )),
      },
      {
        fn: "review_defence_packet_item",
        actor: "lead",
        run: (s) =>
          s.tx`select api.review_defence_packet_item(${ids.defenceItem!}, 'CLEARED_REDACTED', ${ids.rendition!},
            'Walk item (redacted)', ${[
              "REPORTER",
              "WITNESS",
              "CONFIDENTIALITY",
              "PRIVILEGE",
              "RESTRICTED_INFORMATION",
              "OTHER_PROTECTED",
            ]}::text[], null)`,
      },
      {
        fn: "submit_defence_packet",
        actor: "caseManager",
        run: (s) => s.tx`select api.submit_defence_packet(${ids.defencePacket!})`,
      },
      {
        fn: "withdraw_defence_packet",
        actor: "caseManager",
        run: (s) => s.tx`select api.withdraw_defence_packet(${ids.defencePacket!}, ${REASON})`,
      },
      // A restricted case's packet (case 0003): its Restricted Case Authority reads what it approves (CDF-218(1),
      // migration 2060), then decides it.
      {
        fn: "defence_packet_approval_view",
        actor: "grcDirector",
        run: async (s) => {
          ids.restrictedPacket = await apart(
            s,
            async () => {
              const exec = await caseId("0003");
              await (s as OwnerScenario).asOwner();
              await s.tx`update iam.user_profile set clearance = 'SECRET' where id in (${USERS.lead}, ${USERS.employeeB})`;
              await s.as("grcDirector");
              await s.tx`select api.assign_case(${exec}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`;
              const n = await defenceNotice(
                s,
                exec,
                "grcDirector",
                "employeeB",
                "Employee Upsilon (synthetic)",
              );
              const v = await storeEvidence(s, "grcDirector", exec, { classification: "SECRET" });
              const k = await packetWith(s, "lead", n.notice, [v.versionId]);
              await clearAsIs(s, "grcDirector", k.items[0]!);
              await s.as("lead");
              await s.tx`select api.submit_defence_packet(${k.packet})`;
              return k.packet;
            },
            "grcDirector",
          );
          return s.tx`select api.defence_packet_approval_view(${ids.restrictedPacket!})`;
        },
      },
      {
        fn: "decide_restricted_defence_packet",
        actor: "grcDirector",
        run: (s) =>
          s.tx`select api.decide_restricted_defence_packet(${ids.restrictedPacket!}, 'APPROVE', ${REASON})`,
      },
      // The prior-sanctions extract: the committee secretary asks for the walk subject's prior final sanctions.
      {
        fn: "request_sanction_extract",
        actor: "committeeSecretary",
        run: async (s) =>
          (ids.extract = await one(
            s,
            s.tx`select api.request_sanction_extract(${ids.committeeProceeding!}, ${ids.subject!}, ${REASON}) as id`,
          )),
      },
      // The package-building read models (DEC-02, migration 2060): the secretary's choices and the items in front of
      // the committee, both audited with counts.
      {
        fn: "committee_scope_choices",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.committee_scope_choices(${ids.committeeProceeding!})`,
      },
      {
        fn: "committee_items_view",
        actor: "committeeSecretary",
        run: (s) => s.tx`select api.committee_items_view(${ids.committeeProceeding!})`,
      },
      // A row from the restricted case 0003 awaiting its authority (owner fixture: the walk has no final sanction there).
      {
        fn: "decide_sanction_extract_row",
        actor: "grcDirector",
        run: async (s) => {
          const row = await apart(
            s,
            async () => {
              await (s as OwnerScenario).asOwner();
              const exec = await caseId("0003");
              return one(
                s,
                s.tx`insert into decision.sanction_extract_row (extract_id, position, source_execution_id, source_case_id,
                       source_classification, source_restricted, sanction_code, decided_on, effective_from, status)
                     select ${ids.extract!}, 99, x.id, ${exec}, 'SECRET', true, 'WARNING', current_date - 40,
                            current_date - 2, 'AWAITING_AUTHORITY'
                     from decision.sanction_execution x order by x.recorded_at desc limit 1
                     returning id`,
              );
            },
            "grcDirector",
          );
          return s.tx`select api.decide_sanction_extract_row(${row}, 'APPROVE', ${REASON})`;
        },
      },
      // Case structure and corrections (migration 2090, ADR-045), on case 0004 by the case manager: a link, ended; a
      // subject's status; an allegation withdrawn and one split; a wrongly identified subject corrected; the case split.
      {
        fn: "link_cases",
        actor: "caseManager",
        run: async (s) =>
          (ids.caseLink = await one(
            s,
            s.tx`select api.link_cases(${ids.case4!}, ${caseA}, 'RELATED', ${REASON}) as id`,
          )),
      },
      {
        fn: "end_case_link",
        actor: "caseManager",
        run: (s) => s.tx`select api.end_case_link(${ids.caseLink!}, ${REASON})`,
      },
      {
        fn: "record_subject_status",
        actor: "caseManager",
        run: async (s) => {
          const subject = await apart(
            s,
            () =>
              one(
                s,
                s.tx`select api.add_case_subject(${ids.case4!}, 'Unidentified person (walk)', 'EMPLOYEE', null) as id`,
              ),
            "caseManager",
          );
          return s.tx`select api.record_subject_status(${subject}, 'UNIDENTIFIED', ${REASON})`;
        },
      },
      {
        fn: "withdraw_allegation",
        actor: "caseManager",
        run: async (s) => {
          const a = await apart(
            s,
            () =>
              one(
                s,
                s.tx`select api.add_allegation(${ids.case4!}, 'FRAUD', 'Synthetic: walk allegation to withdraw.', null, null, null) as id`,
              ),
            "caseManager",
          );
          return s.tx`select api.withdraw_allegation(${a}, ${REASON})`;
        },
      },
      {
        fn: "split_allegation",
        actor: "caseManager",
        run: async (s) => {
          const a = await apart(
            s,
            () =>
              one(
                s,
                s.tx`select api.add_allegation(${ids.case4!}, 'FRAUD', 'Synthetic: walk allegation to split.', null, null, null) as id`,
              ),
            "caseManager",
          );
          return s.tx`select api.split_allegation(${a}, ${s.tx.json([
            { category: "FRAUD", description: "Synthetic: the walk invoice part." },
            { category: "BRIBERY", description: "Synthetic: the walk gift part." },
          ] as never)}::jsonb, ${REASON})`;
        },
      },
      {
        fn: "correct_case_subject",
        actor: "caseManager",
        run: async (s) => {
          const [wrong, right] = await apart(
            s,
            async () => {
              const w = await one(
                s,
                s.tx`select api.add_case_subject(${ids.case4!}, 'Employee Wrong (walk)', 'EMPLOYEE', null) as id`,
              );
              await s.tx`select api.add_allegation(${ids.case4!}, 'FRAUD', 'Synthetic: walk allegation, wrong person.', ${w}, null, null)`;
              const r = await one(
                s,
                s.tx`select api.add_case_subject(${ids.case4!}, 'Employee Right (walk)', 'EMPLOYEE', null) as id`,
              );
              return [w, r];
            },
            "caseManager",
          );
          return s.tx`select api.correct_case_subject(${wrong}, ${right}, ${REASON})`;
        },
      },
      {
        fn: "split_case",
        actor: "caseManager",
        run: async (s) => {
          const a = await apart(
            s,
            () =>
              one(
                s,
                s.tx`select api.add_allegation(${ids.case4!}, 'FRAUD', 'Synthetic: walk allegation to move.', null, null, null) as id`,
              ),
            "caseManager",
          );
          return s.tx`select api.split_case(${ids.case4!}, ${[a]}::uuid[], 'Walk split case (synthetic)',
            'Synthetic: the matter split from case 0004.', ${REASON})`;
        },
      },
      // A correction to a committee seat (AMB-045) is an annotation by a committee administrator.
      {
        fn: "annotate_committee_membership",
        actor: "platformAdmin",
        run: async (s) => {
          const m = await one(
            s,
            s.tx`select id from committee.membership where user_id <> ${USERS.platformAdmin}
                 order by effective_from desc, id limit 1`,
          );
          return s.tx`select api.annotate_committee_membership(${m}, 'WRONG_REFERENCE', ${REASON})`;
        },
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
      // Corrective-action owners, and the waiver permission no role holds yet (SOURCE_REQUIRED; rolled back).
      await s.tx`insert into iam.role_permission (role_code, permission_code)
                 values ('GRC_DIRECTOR', 'CORRECTIVE_ACTION_WAIVE')`;
      await s.as("platformAdmin");
      for (const u of [USERS.financeEmployee, USERS.employeeB]) {
        await s.tx`select api.grant_role(${u}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner for the walk')`;
      }
      // IC and GC start unseated, as before the demo seats of seed 30 (fixture, outside every step's request id).
      await unseatDemoSeats(s);
      // AMB-018 (migration 2030): cases 0001 and 0003 reach the Investigation Committee after their preliminary
      // review referred them.
      await preliminaryReferral(s, caseA);
      await preliminaryReferral(s, await caseId("0003"));
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
      where n.nspname in ('audit', 'authz', 'workflow', 'case_mgmt', 'committee', 'core', 'evidence', 'forms', 'intake', 'iam', 'protected_identity', 'public_api', 'records', 'config', 'decision', 'grievance', 'notify', 'exchange')
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
      "authz.can_handle_grievance",
      "authz.can_manage_defence",
      "authz.can_manage_disposition",
      "authz.can_manage_meeting",
      "authz.can_manage_recommendation_package",
      "authz.can_manage_retention",
      "authz.can_message_reporter",
      "authz.can_prepare_form",
      "authz.can_prepare_form_instance",
      "authz.can_read_reporter_conversation",
      "authz.can_record_findings",
      "authz.can_release_legal_hold",
      "authz.can_request_disposition",
      "authz.can_request_legal_hold",
      "authz.can_reveal_whistleblower_identity",
      "authz.can_review_form",
      "authz.can_review_interviews",
      "authz.can_review_legal_hold",
      "authz.can_route_retention_review",
      "authz.can_upload_evidence",
      "authz.can_view_bcp_import",
      "authz.can_view_bcp_provenance",
      "authz.can_view_case",
      "authz.can_view_case_conflict_concern",
      "authz.can_view_case_content",
      "authz.can_view_case_metadata",
      "authz.can_view_committee_proceeding",
      "authz.can_view_committee_registry",
      "authz.can_view_corrective_action",
      "authz.can_view_evidence",
      "authz.can_view_export",
      "authz.can_view_form_instance",
      "authz.can_view_grievance",
      "authz.can_view_grievance_assessment",
      "authz.can_view_interview",
      "authz.can_view_meeting",
      "authz.can_view_meeting_concern",
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
      "authz.can_view_report_files",
      "authz.can_view_sector_roster",
      "authz.corrective_event_withheld",
      "authz.current_clearance",
      "authz.current_roles",
      "authz.current_subject",
      "authz.current_user_id",
      "authz.form_entitled",
      "authz.has_case_file_basis",
      "authz.has_permission",
      "authz.in_records_catalogue_scope",
      "authz.is_committee_secretary",
      "authz.is_evidence_lead",
      "authz.is_evidence_team",
      // Migration 2040 (DEC-F24): whether the caller administers export policy (and approves no export).
      "authz.is_export_policy_admin",
      // Migration 2040 item 13 (DEC-F17): whether the caller is the admissibility decider a grievance awaits.
      "authz.is_grievance_decider",
      "authz.is_portal_subject",
      "authz.is_reporter_correspondent",
      "authz.meeting_concern_decider_seat",
      "authz.task_grants",
      // Migration 2030: the rows of decision.sanction_catalogue_entry (codes and governed fields; a basis only once
      // APPROVED), for any signed-in caller.
      "decision.sanction_catalogue_rows",
      "forms.canonical_json",
      "forms.content_hash",
      "forms.terminal_status",
      "public_api.consume_rate_limit",
      "records.catalogue_rows",
      "records.hold_request_rows",
    ]);
  });
});
