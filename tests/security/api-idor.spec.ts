// CDF-62 · §18–§21, §87, threats T01/T02/T03: broken access control and IDOR on every api.* command.
// Each command is called by people who cannot see the target case, with the UUIDs of real objects on it
// (case, report, assignment, grant, conflict, evidence item and version, reveal request, form instance). Every call must be
// refused exactly as if the object did not exist, and the catalog guard makes a new api.* function fail this
// file until it has an entry here.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
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
import {
  DECISION,
  JUSTIFICATION,
  legalHoldTasks,
  makeEligible,
  placeHold,
  requestDisposition,
} from "../support/records";
import { committeeIds } from "../support/committee";
import { draftPackage, requestLegalReview, voteOnPackage } from "../support/decision";

interface Targets {
  case: string;
  report: string;
  assignment: string;
  grant: string;
  conflict: string;
  evidence: string;
  version: string;
  revealRequest: string;
  // Purpose-bound access (CDF-73, ADR-014)
  task: string;
  holdRequest: string;
  breakGlass: string;
  interview: string;
  statementVersion: string;
  formInstance: string;
  attachment: string;
  // Business architecture rebase (ADR-017)
  allegation: string;
  proceeding: string;
  finding: string;
  // Preliminary review (migration 1880)
  recommendation: string;
}

type Outcome = "NOT_FOUND" | "EMPTY" | "FALSE";
interface Probe<T = Targets> {
  fn: string;
  outcome: Outcome;
  call: (tx: Tx, t: T, self: string) => Promise<readonly Record<string, unknown>[]>;
}

const REASON = "Synthetic: security regression probe.";
const SHA = "c".repeat(64);

// One probe per object-scoped api.* function. The self id is the acting outsider, so "assign me" and
// "grant me" attempts are covered too.
const PROBES: Probe[] = [
  {
    fn: "open_report_attachment",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.open_report_attachment(${t.attachment})`,
  },
  {
    fn: "approve_form",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.approve_form(${t.formInstance}, 'APPROVED', null)`,
  },
  {
    fn: "assign_case",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.assign_case(${t.case}, ${self}, 'INVESTIGATOR', ${REASON})`,
  },
  {
    fn: "available_transitions",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.available_transitions(${t.case})`,
  },
  {
    fn: "change_case_classification",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.change_case_classification(${t.case}, 'INTERNAL'::core.classification_level, false, ${REASON})`,
  },
  {
    fn: "complete_evidence_version",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.complete_evidence_version(${t.version}, 'CLEAN', 'probe')`,
  },
  {
    fn: "create_case_from_report",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.create_case_from_report(${t.report}, 'Probe case (synthetic)', 'Synthetic probe summary text.', 'RESTRICTED'::core.classification_level, false)`,
  },
  {
    // DEC-01 (ADR-016): the authority list is report-scoped, so an outsider learns nothing about the report.
    fn: "list_restricted_case_authorities",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select * from api.list_restricted_case_authorities(${t.report}, 'RESTRICTED'::core.classification_level)`,
  },
  {
    fn: "decide_conflict",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_conflict(${t.conflict}, 'CONFLICT_CLEARED', ${REASON})`,
  },
  {
    fn: "decide_identity_reveal",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_identity_reveal(${t.revealRequest}, true, ${REASON})`,
  },
  {
    fn: "declare_conflict",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.declare_conflict(${t.case}, false, ${REASON})`,
  },
  {
    fn: "end_assignment",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.end_assignment(${t.assignment}, ${REASON})`,
  },
  {
    fn: "grant_case_access",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.grant_case_access(${t.case}, ${self}, 'CASE', ${REASON}, null)`,
  },
  {
    fn: "list_identity_reveal_requests",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.list_identity_reveal_requests(${t.case})`,
  },
  { fn: "open_case", outcome: "FALSE", call: (tx, t) => tx`select api.open_case(${t.case}) as v` },
  {
    fn: "open_evidence_version",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.open_evidence_version(${t.version})`,
  },
  {
    fn: "open_form_instance",
    outcome: "FALSE",
    call: (tx, t) => tx`select api.open_form_instance(${t.formInstance}) as v`,
  },
  { fn: "open_report", outcome: "FALSE", call: (tx, t) => tx`select api.open_report(${t.report}) as v` },
  {
    fn: "prepare_form",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.prepare_form(${t.formInstance})`,
  },
  {
    fn: "reassign_case",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.reassign_case(${t.assignment}, ${self}, ${REASON})`,
  },
  {
    fn: "register_evidence_version",
    outcome: "NOT_FOUND",
    // A new version of someone else's item on someone else's case.
    call: (tx, t) =>
      tx`select * from api.register_evidence_version(${t.case}, ${t.evidence}, null, null, null, null, null, null,
        'probe.pdf', 'application/pdf', 1024, ${SHA})`,
  },
  {
    fn: "reject_evidence_version",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.reject_evidence_version(${t.version}, 'MALWARE_DETECTED', 'INFECTED', 'probe')`,
  },
  {
    fn: "reply_to_reporter",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.reply_to_reporter(${t.report}, 'Synthetic probe reply to the reporter.')`,
  },
  {
    fn: "request_identity_reveal",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.request_identity_reveal(${t.case}, ${REASON})`,
  },
  {
    fn: "resolve_reporter_identity",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select * from api.resolve_reporter_identity(${t.case}, ${REASON})`,
  },
  {
    fn: "review_form",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.review_form(${t.formInstance}, 'REVIEWED', null)`,
  },
  {
    fn: "revoke_case_access",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.revoke_case_access(${t.grant}, ${REASON})`,
  },
  {
    fn: "save_form_draft",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select * from api.save_form_draft(${t.formInstance}, '{}'::jsonb)`,
  },
  {
    fn: "start_form",
    outcome: "NOT_FOUND",
    // The lowest classification: the refusal must come from case visibility, never from the clearance check.
    call: (tx, t) => tx`select api.start_form(${t.case}, 'WB-FRM-11', 'INTERNAL'::core.classification_level)`,
  },
  {
    fn: "transition_case",
    outcome: "NOT_FOUND",
    // Try every transition the current state offers; none may be reachable by an outsider.
    call: async (tx, t) => {
      const codes = await tx<{ code: string }[]>`
        select d.code from workflow.workflow_transition_definition d
        join workflow.workflow_instance i on i.workflow_code = d.workflow_code and i.current_state = d.from_state
        where i.case_id = ${t.case}`;
      // An outsider cannot read the instance, so fall back to a plausible code: the result must not differ.
      const code = codes[0]?.code ?? "COMPLETE_SCREENING";
      return tx`select api.transition_case(${t.case}, ${code}, ${REASON})`;
    },
  },
  {
    fn: "triage_report",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.triage_report(${t.report}, 'OPEN_CASE', ${REASON}, null, null)`,
  },
  {
    fn: "update_case_details",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.update_case_details(${t.case}, 'Overwritten title (synthetic)', 'Overwritten summary (synthetic).', 'LOW', 1)`,
  },
  // Purpose-bound access (CDF-73, ADR-014): tasks, legal-hold requests and break-glass.
  {
    fn: "assign_legal_hold_request",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.assign_legal_hold_request(${t.holdRequest}, ${self})`,
  },
  {
    fn: "cancel_case_task",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.cancel_case_task(${t.task}, ${REASON})`,
  },
  {
    fn: "complete_case_task",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.complete_case_task(${t.task}, ${REASON})`,
  },
  {
    fn: "create_case_task",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.create_case_task(${t.case}, 'LEGAL_REVIEW', ${self}, ${REASON})`,
  },
  {
    fn: "decide_break_glass",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_break_glass(${t.breakGlass}, true, ${REASON})`,
  },
  {
    fn: "end_break_glass",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.end_break_glass(${t.breakGlass})`,
  },
  {
    fn: "open_case_metadata",
    outcome: "FALSE",
    call: (tx, t) => tx`select api.open_case_metadata(${t.case}) as v`,
  },
  { fn: "open_case_task", outcome: "FALSE", call: (tx, t) => tx`select api.open_case_task(${t.task}) as v` },
  {
    fn: "request_break_glass",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.request_break_glass(${t.case}, ${REASON}, 60)`,
  },
  {
    fn: "request_legal_hold",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.request_legal_hold(${t.case}, 'LITIGATION', ${REASON})`,
  },
  {
    fn: "review_break_glass",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.review_break_glass(${t.breakGlass}, 'APPROPRIATE', ${REASON})`,
  },
  {
    fn: "review_legal_hold_request",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.review_legal_hold_request(${t.holdRequest}, true, ${REASON})`,
  },
  // ---- Interviews (CDF-60, ADR-012) ------------------------------------------------------------------
  {
    fn: "plan_interview",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.plan_interview(${t.case}, 'Probe interview (synthetic)', null, 'WITNESS', 'Witness Probe', null,
        'RESTRICTED'::core.classification_level)`,
  },
  {
    fn: "add_interview_participant",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.add_interview_participant(${t.interview}, ${self}, 'INTERVIEWER')`,
  },
  {
    fn: "schedule_interview",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.schedule_interview(${t.interview}, now() + interval '2 days', 60, 'PHONE', null)`,
  },
  {
    fn: "issue_interview_notice",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.issue_interview_notice(${t.interview}, 'RESCHEDULE', 'INTERNAL_EMAIL')`,
  },
  {
    fn: "record_interview_rights",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.record_interview_rights(${t.interview}, 'SIGNED_FORM', 'PROBE-RIGHTS-V1')`,
  },
  {
    fn: "record_interview_conducted",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_interview_conducted(${t.interview}, now() - interval '1 hour', now())`,
  },
  {
    fn: "record_interview_statement",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select * from api.record_interview_statement(${t.interview}, 'Overwritten statement (synthetic).', 'en')`,
  },
  {
    fn: "acknowledge_interview_statement",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.acknowledge_interview_statement(${t.statementVersion}, 'ELECTRONIC_ACK', ${SHA})`,
  },
  {
    fn: "link_interview_recording",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.link_interview_recording(${t.interview}, ${t.evidence})`,
  },
  {
    fn: "transition_interview",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.transition_interview(${t.interview}, 'CANCEL', ${REASON})`,
  },
  {
    fn: "open_interview",
    outcome: "FALSE",
    call: (tx, t) => tx`select api.open_interview(${t.interview}) as v`,
  },
  // Business architecture rebase (ADR-017, ADR-018): case structure and referral to a committee.
  {
    fn: "open_proceeding",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.open_proceeding(${t.case}, 'INVESTIGATION', null, ${REASON})`,
  },
  {
    fn: "update_proceeding_state",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.update_proceeding_state(${t.proceeding}, 'IN_PROGRESS', null, null, ${REASON})`,
  },
  {
    fn: "close_proceeding",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.close_proceeding(${t.proceeding}, 'CANCELLED', null, ${REASON})`,
  },
  {
    fn: "add_case_subject",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.add_case_subject(${t.case}, 'Probe Subject (synthetic)', 'EMPLOYEE', null)`,
  },
  {
    fn: "add_allegation",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.add_allegation(${t.case}, 'FRAUD', 'Synthetic: probe allegation text.', null, null, null)`,
  },
  {
    fn: "link_allegation_subject",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.link_allegation_subject(${t.allegation}, ${randomUUID()}, null, null)`,
  },
  {
    fn: "record_finding",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_finding(${t.allegation}, null, ${t.proceeding}, 'INCONCLUSIVE', 'Synthetic: probe rationale.')`,
  },
  {
    fn: "link_supporting_material",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.link_supporting_material(${t.evidence}, ${t.allegation}, null)`,
  },
  {
    fn: "refer_case_to_committee",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.refer_case_to_committee(${t.case}, (select id from committee.committee where code = 'IC'), null, ${REASON})`,
  },
  {
    fn: "withdraw_form",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.withdraw_form(${t.formInstance}, ${REASON})`,
  },
  // DEC-61: the Restricted Case Authority's approval to refer a restricted case.
  {
    fn: "approve_restricted_committee_referral",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.approve_restricted_committee_referral(${t.case}, (select id from committee.committee where code = 'IC'), ${REASON})`,
  },
  // AGENT-09 G2 (migration 1910): the Restricted Case Authority's approval to record a linked grievance.
  {
    fn: "approve_restricted_grievance_recording",
    outcome: "NOT_FOUND",
    call: (tx, t, self) =>
      tx`select api.approve_restricted_grievance_recording(${t.case}, ${self}, ${REASON})`,
  },
  // Preliminary review (migration 1880).
  {
    fn: "prepare_preliminary_recommendation",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.prepare_preliminary_recommendation(${t.case}, 'NO_ACTION', 'Synthetic: probe rationale text.')`,
  },
  {
    fn: "review_preliminary_recommendation",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.review_preliminary_recommendation(${t.recommendation}, 'RETURN', array['OTHER'], 'Probe.')`,
  },
  {
    fn: "approve_preliminary_recommendation",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.approve_preliminary_recommendation(${t.recommendation}, 'APPROVE', null, null)`,
  },
];

// Direct referral commands (migration 1880) take a referral or a delegation, never a case.
interface ReferralTargets {
  referral: string;
  delegation: string;
}

const REFERRAL_PROBES: Probe<ReferralTargets>[] = [
  {
    fn: "update_referral",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.update_referral(${t.referral}, 'Probe title', 'Synthetic: probe summary.', 'FRAUD', 'INTERNAL'::core.classification_level)`,
  },
  {
    fn: "submit_referral",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.submit_referral(${t.referral}, null)`,
  },
  {
    fn: "sector_decide_referral",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.sector_decide_referral(${t.referral}, 'APPROVE', null, null)`,
  },
  {
    fn: "secretary_decide_referral",
    outcome: "NOT_FOUND",
    call: (tx, t, self) =>
      tx`select api.secretary_decide_referral(${t.referral}, 'ACCEPT', null, null, ${self})`,
  },
  {
    fn: "resubmit_referral",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.resubmit_referral(${t.referral}, null)`,
  },
  {
    fn: "object_to_referral_rejection",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.object_to_referral_rejection(${t.referral}, 'Synthetic: probe objection.')`,
  },
  {
    fn: "withdraw_referral",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.withdraw_referral(${t.referral}, ${REASON})`,
  },
  {
    fn: "comment_on_referral",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.comment_on_referral(${t.referral}, 'Probe comment.')`,
  },
  {
    fn: "referral_available_actions",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.referral_available_actions(${t.referral})`,
  },
  {
    fn: "revoke_referral_delegation",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.revoke_referral_delegation(${t.delegation}, ${REASON})`,
  },
];

// Committee meeting commands (migration 1890) take a committee proceeding, a meeting, a participant, a vote item or
// minutes; never a case.
interface MeetingTargets {
  committeeProceeding: string;
  meeting: string;
  participant: string;
  voteItem: string;
  minutes: string;
}

const MEETING_PROBES: Probe<MeetingTargets>[] = [
  {
    fn: "schedule_meeting",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.schedule_meeting(${t.committeeProceeding}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
        now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON})`,
  },
  {
    fn: "invite_to_meeting",
    outcome: "NOT_FOUND",
    call: (tx, t, self) =>
      tx`select api.invite_to_meeting(${t.meeting}, 'EXPERT', ${self}, null, true, ${REASON})`,
  },
  {
    fn: "declare_meeting_conflict",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.declare_meeting_conflict(${t.participant}, 'NO_CONFLICT', null)`,
  },
  {
    fn: "open_meeting",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.open_meeting(${t.meeting}, ${REASON})`,
  },
  {
    fn: "record_attendance",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.record_attendance(${t.participant}, 'PRESENT')`,
  },
  {
    fn: "close_meeting",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.close_meeting(${t.meeting}, ${REASON})`,
  },
  {
    fn: "cancel_meeting",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.cancel_meeting(${t.meeting}, ${REASON})`,
  },
  {
    fn: "open_vote_item",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.open_vote_item(${t.meeting}, 'OTHER', null, 'Probe item')`,
  },
  {
    fn: "cast_vote",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.cast_vote(${t.voteItem}, 'APPROVE', null)`,
  },
  {
    fn: "record_vote_for_member",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_vote_for_member(${t.voteItem}, ${t.participant}, 'ABSENT', 'Synthetic: probe.', null)`,
  },
  {
    fn: "close_vote_item",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.close_vote_item(${t.voteItem}, null)`,
  },
  {
    fn: "cast_casting_vote",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.cast_casting_vote(${t.voteItem}, 'APPROVE', null)`,
  },
  {
    fn: "vote_item_status",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.vote_item_status(${t.voteItem})`,
  },
  {
    fn: "generate_minutes",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.generate_minutes(${t.meeting}, 'Synthetic probe narrative.')`,
  },
  {
    fn: "review_minutes",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.review_minutes(${t.minutes}, 'APPROVE', null)`,
  },
  {
    fn: "record_minutes_reminder",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.record_minutes_reminder(${t.minutes})`,
  },
  {
    fn: "apply_minutes_deemed_approval",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.apply_minutes_deemed_approval(${t.minutes})`,
  },
];

// Records, retention and legal hold commands (ADR-013) take their own objects: a hold, a release request,
// a disposition request and a certificate.
interface RecordsTargets {
  case: string;
  hold: string;
  release: string;
  disposition: string;
  certificate: string;
}

const RECORDS_PROBES: Probe<RecordsTargets>[] = [
  {
    fn: "assign_retention_class",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.assign_retention_class(${t.case}, 'TEST_SHORT_RETENTION')`,
  },
  {
    fn: "decide_disposition",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_disposition(${t.disposition}, false, ${REASON})`,
  },
  {
    fn: "decide_legal_hold_release",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_legal_hold_release(${t.release}, true, ${REASON})`,
  },
  {
    fn: "execute_disposition",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.execute_disposition(${t.disposition})`,
  },
  {
    fn: "list_records",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.list_records(null, ${t.case})`,
  },
  {
    fn: "place_legal_hold",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.place_legal_hold(${t.case}, 'CASE', null, 'LITIGATION', ${REASON + " Preserve."}, null)`,
  },
  {
    fn: "request_disposition",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.request_disposition(${t.case})`,
  },
  {
    fn: "request_legal_hold_release",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.request_legal_hold_release(${t.hold}, ${REASON + " Release."})`,
  },
  {
    fn: "verify_disposition_certificate",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.verify_disposition_certificate(${t.certificate})`,
  },
];

// Recommendation, legal review and authority commands (migration 1900) take a committee proceeding, a meeting, a
// package, an item, a legal review request or a packet; never a case.
interface DecisionTargets {
  committeeProceeding: string;
  meeting: string;
  pkg: string;
  item: string;
  request: string;
  packet: string;
}

const DECISION_PROBES: Probe<DecisionTargets>[] = [
  {
    fn: "create_recommendation_package",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.create_recommendation_package(${t.committeeProceeding}, 'PACKAGE')`,
  },
  {
    fn: "add_recommendation_item",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.add_recommendation_item(${t.pkg}, 'OTHER', null, null, 'Probe recommendation text.', null, null)`,
  },
  {
    fn: "withdraw_recommendation_item",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.withdraw_recommendation_item(${t.item}, ${REASON})`,
  },
  {
    fn: "submit_package_for_vote",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.submit_package_for_vote(${t.pkg})`,
  },
  {
    fn: "open_package_vote",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.open_package_vote(${t.meeting}, ${t.pkg})`,
  },
  {
    fn: "record_package_adoption",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.record_package_adoption(${t.pkg})`,
  },
  {
    fn: "request_legal_review",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.request_legal_review(${t.pkg}, ${self}, ${REASON}, null, null)`,
  },
  {
    fn: "approve_restricted_legal_review",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.approve_restricted_legal_review(${t.pkg}, ${self}, ${REASON})`,
  },
  {
    fn: "open_packet",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.open_packet(${t.packet})`,
  },
  {
    fn: "give_legal_opinion",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.give_legal_opinion(${t.request}, 'CONCURS', null)`,
  },
  {
    fn: "submit_to_authority",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.submit_to_authority(${t.pkg})`,
  },
  {
    fn: "record_authority_decision",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_authority_decision(${t.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now(), 'Probe authority',
        'MEMO-PROBE-0001', null, null)`,
  },
];

// Employee defence and grievance commands (migration 1910) take a subject, a portal link, a defence notice or a
// grievance; never a case.
interface GrievanceTargets {
  subject: string;
  link: string;
  notice: string;
  grievance: string;
}

const GRIEVANCE_PROBES: Probe<GrievanceTargets>[] = [
  {
    fn: "link_subject_portal_account",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.link_subject_portal_account(${t.subject}, ${self}, ${REASON})`,
  },
  {
    fn: "revoke_subject_portal_link",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.revoke_subject_portal_link(${t.link}, ${REASON})`,
  },
  {
    fn: "issue_defence_notice",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.issue_defence_notice(${t.subject}, 'Probe notice text.', ${[randomUUID()]}::uuid[],
        now() + interval '10 days')`,
  },
  {
    fn: "acknowledge_defence_notice",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.acknowledge_defence_notice(${t.notice})`,
  },
  {
    fn: "submit_defence_response",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.submit_defence_response(${t.notice}, 'Probe response text.')`,
  },
  {
    fn: "record_defence_response",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_defence_response(${t.notice}, 'EMAIL', now(), 'Probe response text.', 'EMAIL-PROBE-0001')`,
  },
  {
    fn: "file_grievance",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.file_grievance(${t.link}, now() - interval '1 day', 'Probe grievance grounds.')`,
  },
  {
    fn: "assess_grievance_admissibility",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.assess_grievance_admissibility(${t.grievance}, 'ADMISSIBLE', null, ${REASON})`,
  },
  {
    fn: "decide_grievance_admissibility",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.decide_grievance_admissibility(${t.grievance}, 'ADMISSIBLE', null, ${REASON})`,
  },
  {
    fn: "record_grievance_outcome",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_grievance_outcome(${t.grievance}, ${["UPHOLD"]}::text[], null, ${randomUUID()}, 'Probe summary.')`,
  },
];

// Notification commands (migration 1920) take the caller's own notification; nobody else's is reachable.
interface NotificationTargets {
  notification: string;
}

const NOTIFICATION_PROBES: Probe<NotificationTargets>[] = [
  {
    fn: "mark_notification_read",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.mark_notification_read(${t.notification})`,
  },
];

// Functions that take no case-scoped object: covered by permission tests below and elsewhere.
// Committee registry maintenance (ADR-019) needs COMMITTEE_ADMIN and touches no case: refused as FORBIDDEN.
const ADMIN_COMMANDS = [
  "grant_role",
  "revoke_role",
  "set_user_status",
  "appoint_committee_member",
  "end_committee_membership",
  "set_committee_rule_set",
  // Recommendation authority rules (migration 1900): COMMITTEE_ADMIN only, no case.
  "set_action_authority_rule",
  // Notification rules (migration 1920): NOTIFICATION_ADMIN only, no recipient or case.
  "set_notification_rule",
  // Sector registry (migration 1880): SECTOR_ADMIN only, no referral or case.
  "create_sector",
  "appoint_sector_member",
  "end_sector_membership",
];
// Sector-scoped: refused unless the caller holds a current position in the sector (head, for delegation).
// Covered in referral-preliminary.spec.ts.
const SECTOR_COMMANDS = ["create_referral", "delegate_referral_approval"];
// The caller's own tasks and counts, the authorised catalogue search, the exact-number lookup (a case number,
// never a UUID; PBA-T16 to T18) and task housekeeping take no object id (CDF-73).
const GLOBAL_COMMANDS = [
  "record_security_event",
  "verify_audit_chain",
  "refresh_disposition_eligibility",
  "expire_case_tasks",
  "my_case_tasks",
  "my_work_summary",
  // S1 read models (migration 1820): the caller's own areas, work items and access basis.
  "my_areas",
  "my_work_items",
  "my_access",
  "request_case_for_legal_hold",
  "search_records_catalogue",
  // Migration 1880: the caller's purpose-bound approval queue.
  "preliminary_approval_queue",
  // Migration 1910: the caller's own defence notices; a grievance recorded by case number (never a UUID), refused
  // unless the caller is the Grievance Committee Secretary and answering an unknown and an uncleared number alike
  // (grievance-defence.spec.ts).
  "my_defence_notices",
  "record_grievance",
  // Migration 1920: the caller's own notification preferences.
  "set_notification_preference",
];

let caseA: string, caseB: string, caseExec: string;
beforeAll(async () => {
  [caseA, caseB, caseExec] = await Promise.all([caseId("0001"), caseId("0002"), caseId("0003")]);
});

async function seedObjects(caseNo: string) {
  const [row] = await admin<{ report: string; reportRef: string; assignment: string; grant: string }[]>`
    select (select r.id from intake.report r where r.case_id = c.id limit 1) as report,
           (select r.report_ref from intake.report r where r.case_id = c.id limit 1) as "reportRef",
           (select a.id from case_mgmt.case_assignment a where a.case_id = c.id and a.status = 'ACTIVE' limit 1) as assignment,
           (select g.id from case_mgmt.case_access_grant g where g.case_id = c.id and g.status = 'ACTIVE' limit 1) as "grant"
    from case_mgmt.case_record c where c.case_number like ${"CDF-DEMO-%-" + caseNo}`;
  if (!row?.report || !row.assignment || !row.grant) throw new Error(`seed objects for ${caseNo} missing`);
  return row;
}

/**
 * A clean reporter attachment (CDF-72) on the case's source report, added through the anonymous portal
 * commands. Seed reports store sha256('unusable-seed-secret:' || ref) as their secret HMAC (seed 02).
 */
async function reporterAttachment(s: Scenario, reportRef: string): Promise<string> {
  const hmac = createHash("sha256").update(`unusable-seed-secret:${reportRef}`, "utf8").digest("hex");
  await s.as(null);
  const [a] = await s.tx<{ id: string }[]>`
    select attachment_id as id from public_api.register_report_attachment(${reportRef}, ${hmac}, 'REPORT', 'pdf',
      'application/pdf', 2048, ${createHash("sha256").update(randomUUID()).digest("hex")})`;
  await s.tx`select public_api.complete_report_attachment(${reportRef}, ${hmac}, ${a!.id}, 'CLEAN', 'probe')`;
  return a!.id;
}

/**
 * Creates, inside the scenario, the objects only an insider can create: an evidence item and version, a form
 * instance, an identity reveal request and a conflict declaration. `uploader` must be able to upload on the
 * case and `formPreparer` to prepare an investigation form on it. No seed role can prepare a form on the
 * restricted SECRET case (GRC has no FORM_PREPARE), so without a preparer the form probes use a random id.
 */
async function insiderObjects(
  s: Scenario,
  target: string,
  uploader: UserKey,
  revealer: UserKey,
  declarer: UserKey,
  classification = "RESTRICTED",
  formPreparer?: UserKey,
): Promise<
  Pick<
    Targets,
    "evidence" | "version" | "revealRequest" | "conflict" | "interview" | "statementVersion" | "formInstance"
  >
> {
  await s.as(uploader);
  const [ev] = await s.tx<{ evidence: string; version: string }[]>`
    select o_evidence_id as evidence, o_version_id as version
    from api.register_evidence_version(${target}, null, 'Probe ledger (synthetic)', null, 'DOCUMENT', 'Synthetic source',
      null, ${classification}::core.classification_level, 'ledger.pdf', 'application/pdf', 2048, ${"d".repeat(64)})`;
  // A conducted interview with one statement version (CDF-60), by the same insider.
  const [iv] = await s.tx<{ id: string }[]>`
    select api.plan_interview(${target}, 'Probe interview (synthetic)', null, 'WITNESS', 'Witness Probe (synthetic)', null,
      ${classification}::core.classification_level) as id`;
  await s.tx`select api.schedule_interview(${iv!.id}, now() - interval '2 hours', 60, 'PHONE', null)`;
  await s.tx`select api.issue_interview_notice(${iv!.id}, 'INVITATION', 'INTERNAL_EMAIL')`;
  await s.tx`select api.record_interview_rights(${iv!.id}, 'SIGNED_FORM', 'PROBE-RIGHTS-V1')`;
  await s.tx`select api.record_interview_conducted(${iv!.id}, now() - interval '2 hours', now() - interval '1 hour')`;
  const [sv] = await s.tx<{ id: string }[]>`
    select o_version_id as id from api.record_interview_statement(${iv!.id}, 'Probe statement (synthetic).', 'en')`;
  let formInstance: string = randomUUID();
  if (formPreparer) {
    await s.as(formPreparer);
    const [f] = await s.tx<
      { id: string }[]
    >`select api.start_form(${target}, 'WB-FRM-11', ${classification}::core.classification_level) as id`;
    formInstance = f!.id;
  }
  await s.as(revealer);
  const [rr] = await s.tx<
    { id: string }[]
  >`select api.request_identity_reveal(${target}, 'Synthetic: need to contact the reporter for documents.') as id`;
  // Declared last: a declared conflict removes the declarer's own access.
  await s.as(declarer);
  const [k] = await s.tx<
    { id: string }[]
  >`select api.declare_conflict(${target}, true, 'Synthetic: probe conflict declaration.') as id`;
  return {
    evidence: ev!.evidence,
    version: ev!.version,
    revealRequest: rr!.id,
    conflict: k!.id,
    interview: iv!.id,
    statementVersion: sv!.id,
    formInstance,
  };
}

/**
 * CDF-73 objects on the target: a legal-review task, a legal-hold request and, where the case allows it, a
 * break-glass request. Break-glass never reaches a restricted case (ADR-014 D5), so on the executive case the
 * probe gets a random id, which must give the same answer anyway.
 */
async function purposeObjects(
  s: Scenario,
  target: string,
  authority: UserKey,
  assignee: UserKey,
  withBreakGlass: boolean,
): Promise<Pick<Targets, "task" | "holdRequest" | "breakGlass">> {
  await s.as(authority);
  const [task] = await s.tx<{ id: string }[]>`
    select api.create_case_task(${target}, ${assignee === "legal" ? "LEGAL_REVIEW" : "LEGAL_HOLD_APPLICATION"},
      ${USERS[assignee]}, 'Synthetic: probe task purpose.') as id`;
  const [req] = await s.tx<
    { id: string }[]
  >`select api.request_legal_hold(${target}, 'LITIGATION', 'Synthetic: probe hold request justification.') as id`;
  let breakGlass: string = randomUUID();
  if (withBreakGlass) {
    await s.as(assignee);
    const [bg] = await s.tx<{ id: string }[]>`
      select api.request_break_glass(${target}, 'Synthetic: probe break-glass justification.', 60) as id`;
    breakGlass = bg!.id;
  }
  return { task: task!.id, holdRequest: req!.id, breakGlass };
}

/**
 * Rebase objects on the target (ADR-017): an investigation proceeding, an allegation and a finding, made by
 * someone who may edit the case. Created before the insider objects, whose conflict declaration ends access.
 */
async function domainObjects(
  s: Scenario,
  target: string,
  editor: UserKey,
  preparer: UserKey,
): Promise<Pick<Targets, "allegation" | "proceeding" | "finding" | "recommendation">> {
  await s.as(editor);
  const [p] = await s.tx<{ id: string }[]>`
    select api.open_proceeding(${target}, 'INVESTIGATION', null, 'Synthetic: probe proceeding.') as id`;
  const [a] = await s.tx<{ id: string }[]>`
    select api.add_allegation(${target}, 'FRAUD', 'Synthetic: probe allegation text.', null, null, null) as id`;
  const [f] = await s.tx<{ id: string }[]>`
    select api.record_finding(${a!.id}, null, ${p!.id}, 'INCONCLUSIVE', 'Synthetic: probe finding rationale.') as id`;
  await s.as(preparer);
  const [r] = await s.tx<{ id: string }[]>`
    select api.prepare_preliminary_recommendation(${target}, 'NO_ACTION', 'Synthetic: probe recommendation.') as id`;
  return { allegation: a!.id, proceeding: p!.id, finding: f!.id, recommendation: r!.id };
}

async function outcomeOf<T>(s: Scenario, probe: Probe<T>, t: T, self: string): Promise<string> {
  let result: readonly Record<string, unknown>[] | undefined;
  let error: string | undefined;
  try {
    await s.tx.savepoint(async (sp) => {
      result = await probe.call(sp as unknown as Tx, t, self);
    });
  } catch (e) {
    error = (e as Error).message;
  }
  if (error !== undefined) return error.startsWith("CDF_NOT_FOUND") ? "NOT_FOUND" : `ERROR ${error}`;
  if (result!.length === 0) return "EMPTY";
  const values = Object.values(result![0]!);
  if (result!.length === 1 && values.length === 1 && values[0] === false) return "FALSE";
  return `RESULT ${JSON.stringify(result).slice(0, 200)}`;
}

const randomTargets = (): Targets => ({
  case: randomUUID(),
  report: randomUUID(),
  assignment: randomUUID(),
  grant: randomUUID(),
  conflict: randomUUID(),
  evidence: randomUUID(),
  version: randomUUID(),
  revealRequest: randomUUID(),
  task: randomUUID(),
  holdRequest: randomUUID(),
  breakGlass: randomUUID(),
  interview: randomUUID(),
  statementVersion: randomUUID(),
  formInstance: randomUUID(),
  attachment: randomUUID(),
  allegation: randomUUID(),
  proceeding: randomUUID(),
  finding: randomUUID(),
  recommendation: randomUUID(),
});

describe("catalog guard", () => {
  it("every api.* function executable by authenticated has an IDOR probe or is a named non-object command", async () => {
    const rows = await admin<{ name: string }[]>`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      order by 1`;
    const covered = new Set([
      ...PROBES.map((p) => p.fn),
      ...RECORDS_PROBES.map((p) => p.fn),
      ...REFERRAL_PROBES.map((p) => p.fn),
      ...MEETING_PROBES.map((p) => p.fn),
      ...DECISION_PROBES.map((p) => p.fn),
      ...GRIEVANCE_PROBES.map((p) => p.fn),
      ...NOTIFICATION_PROBES.map((p) => p.fn),
      ...ADMIN_COMMANDS,
      ...SECTOR_COMMANDS,
      ...GLOBAL_COMMANDS,
    ]);
    expect(rows.map((r) => r.name).filter((n) => !covered.has(n))).toEqual([]);
    expect([...covered].filter((n) => !rows.some((r) => r.name === n))).toEqual([]);
  });
});

describe("IDOR: outsiders get the same answer for real objects as for random UUIDs", () => {
  // [actor, case it cannot see]: a peer investigator, people with no case role, and the case manager and a
  // GRC director (CASE_VIEW_ALL, RESTRICTED_CASE_GRANT) against a restricted SECRET case.
  const OUTSIDERS: [UserKey, "B" | "EXEC"][] = [
    ["investigatorA", "B"],
    ["committee", "B"],
    ["intake", "B"],
    ["platformAdmin", "B"],
    ["internalAudit", "B"],
    ["soc", "B"],
    ["dpo", "B"],
    ["caseManager", "EXEC"],
    ["grcDeputy", "EXEC"],
    ["triage", "EXEC"], // holds a TRIAGE grant on the case but lacks the clearance
    ["investigatorB", "EXEC"],
  ];

  it.each(OUTSIDERS)("%s against case %s", async (actor, which) => {
    const target = which === "B" ? caseB : caseExec;
    const seeded = await seedObjects(which === "B" ? "0002" : "0003");
    await scenario(async (s) => {
      // Before the insider objects: their conflict declaration removes the declarer's own access.
      const purpose =
        which === "B"
          ? await purposeObjects(s, target, "caseManager", "legal", true)
          : await purposeObjects(s, target, "grcDirector", "grcDirector", false);
      const domain =
        which === "B"
          ? await domainObjects(s, target, "caseManager", "investigatorB")
          : await domainObjects(s, target, "grcDirector", "grcDirector");
      const inside =
        which === "B"
          ? await insiderObjects(
              s,
              target,
              "investigatorB",
              "grcDirector",
              "investigatorB",
              "RESTRICTED",
              "investigatorB",
            )
          : await insiderObjects(s, target, "grcDirector", "grcDirector", "grcDirector", "SECRET");
      const attachment = await reporterAttachment(s, seeded.reportRef);
      const real: Targets = { case: target, ...seeded, ...inside, ...purpose, ...domain, attachment };
      await s.as(actor);
      const self = USERS[actor];
      const mismatches: string[] = [];
      for (const probe of PROBES) {
        const onReal = await outcomeOf(s, probe, real, self);
        const onRandom = await outcomeOf(s, probe, randomTargets(), self);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);

      // The refused calls left no business trace: every audit event this actor caused is a SECURITY denial.
      await s.as("dpo");
      const events = await s.tx<{ action: string; category: string; outcome: string }[]>`
        select action, category, outcome from audit.audit_event
        where actor_id = ${self} and request_id = nullif(current_setting('cdf.request_id', true), '')::uuid`;
      expect(events.filter((e) => e.category !== "SECURITY" || e.outcome !== "DENIED")).toEqual([]);
    });
  });

  it("an insider gets real answers from the same probes (the probes are not vacuous)", async () => {
    await scenario(async (s) => {
      await s.as("investigatorB");
      const [opened] = await s.tx<{ v: boolean }[]>`select api.open_case(${caseB}) as v`;
      expect(opened!.v).toBe(true);
      expect((await s.tx`select * from api.available_transitions(${caseB})`).length).toBeGreaterThan(0);
      const [form] = await s.tx<
        { id: string }[]
      >`select api.start_form(${caseB}, 'WB-FRM-11', 'RESTRICTED'::core.classification_level) as id`;
      const [formOpened] = await s.tx<{ v: boolean }[]>`select api.open_form_instance(${form!.id}) as v`;
      expect(formOpened!.v).toBe(true);
      await s.as("grcDirector");
      const [exec] = await s.tx<{ v: boolean }[]>`select api.open_case(${caseExec}) as v`;
      expect(exec!.v).toBe(true);
      // CDF-73: the task assignee opens their own task, and the requester can end their own break-glass.
      const purpose = await purposeObjects(s, caseB, "caseManager", "legal", true);
      await s.as("legal");
      const [task] = await s.tx<{ v: boolean }[]>`select api.open_case_task(${purpose.task}) as v`;
      expect(task!.v).toBe(true);
      await s.expectError(
        "CDF_CONFLICT:BREAK_GLASS_NOT_ACTIVE",
        (tx) => tx`select api.end_break_glass(${purpose.breakGlass})`,
      );
    });
  });
});

const randomRecordsTargets = (): RecordsTargets => ({
  case: randomUUID(),
  hold: randomUUID(),
  release: randomUUID(),
  disposition: randomUUID(),
  certificate: randomUUID(),
});

/**
 * Takes case B through the whole records lifecycle inside the scenario: a hold placed and released by two
 * legal reviewers, then closure, archive, a short CONFIGURED class (test fixture), a disposition request,
 * approval by the GRC director and logical execution with a certificate.
 */
async function disposedCaseB(s: OwnerScenario, target: string): Promise<RecordsTargets> {
  await legalHoldTasks(s, target); // ADR-014: legal acts on a case through its hold tasks (CDF-73)
  await s.as("legal");
  const hold = await placeHold(s.tx, target);
  const [rel] = await s.tx<
    { id: string }[]
  >`select api.request_legal_hold_release(${hold}, ${JUSTIFICATION}) as id`;
  await s.as("legalB");
  await s.tx`select api.decide_legal_hold_release(${rel!.id}, true, ${DECISION})`;
  await makeEligible(s, target);
  const disposition = await requestDisposition(s.tx, target);
  await s.as("grcDirector");
  await s.tx`select api.decide_disposition(${disposition}, true, ${DECISION})`;
  await s.as("records");
  const [cert] = await s.tx<{ id: string }[]>`select api.execute_disposition(${disposition}) as id`;
  return { case: target, hold, release: rel!.id, disposition, certificate: cert!.id };
}

async function probeRecords(s: Scenario, actor: UserKey, real: RecordsTargets): Promise<string[]> {
  await s.as(actor);
  // A fresh request id, so the trace check below sees only the probes, not the fixture's own steps.
  await s.tx`select set_config('cdf.request_id', ${randomUUID()}, true)`;
  const mismatches: string[] = [];
  for (const probe of RECORDS_PROBES) {
    const onReal = await outcomeOf(s, probe, real, USERS[actor]);
    const onRandom = await outcomeOf(s, probe, randomRecordsTargets(), USERS[actor]);
    if (onReal !== probe.outcome || onRandom !== probe.outcome)
      mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
  }
  return mismatches;
}

describe("IDOR: records commands give outsiders the same answer for real objects as for random UUIDs", () => {
  // Everyone without records visibility of case B: case roles (a disposed case is gone for them, REC-T37),
  // roles without records permissions, and internal audit (RECORDS_VIEW, but cleared below RESTRICTED).
  const RECORDS_OUTSIDERS: UserKey[] = [
    "investigatorA",
    "investigatorB",
    "lead",
    "caseManager",
    "triage",
    "intake",
    "committee",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
  ];

  it.each(RECORDS_OUTSIDERS)(
    "%s against disposed case B and its hold, release, request and certificate",
    async (actor) => {
      await ownerScenario(async (s) => {
        const real = await disposedCaseB(s, caseB);
        expect(await probeRecords(s, actor, real)).toEqual([]);
        await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.refresh_disposition_eligibility()`);

        await s.as("dpo");
        const events = await s.tx<{ category: string; outcome: string }[]>`
        select category, outcome from audit.audit_event
        where actor_id = ${USERS[actor]} and request_id = nullif(current_setting('cdf.request_id', true), '')::uuid`;
        expect(events.filter((e) => e.category !== "SECURITY" || e.outcome !== "DENIED")).toEqual([]);
      });
    },
  );

  it.each<UserKey>(["records", "recordsB", "legal", "legalB"])(
    "%s against a hold on the restricted SECRET case (no assignment, clearance below SECRET)",
    async (actor) => {
      await scenario(async (s) => {
        // A disposition can never reach the live executive case, so those two ids stay random here;
        // REC-T05 and REC-T46 cover the restricted case in the records view.
        await s.as("grcDirector");
        const hold = await placeHold(s.tx, caseExec);
        const [rel] = await s.tx<
          { id: string }[]
        >`select api.request_legal_hold_release(${hold}, ${JUSTIFICATION}) as id`;
        const real = { ...randomRecordsTargets(), case: caseExec, hold, release: rel!.id };
        expect(await probeRecords(s, actor, real)).toEqual([]);
      });
    },
  );

  it("records staff get real answers from the same probes (the probes are not vacuous)", async () => {
    await ownerScenario(async (s) => {
      const real = await disposedCaseB(s, caseB);
      await s.as("internalAudit");
      expect(await s.tx`select * from api.list_records(null, ${caseB})`).toEqual([]);
      await s.as("legal");
      const rows = await s.tx<{ records_state: string }[]>`select * from api.list_records(null, ${caseB})`;
      expect(rows.map((r) => r.records_state)).toEqual(["DISPOSED"]);
      const [ok] = await s.tx<
        { v: boolean }[]
      >`select api.verify_disposition_certificate(${real.certificate}) as v`;
      expect(ok!.v).toBe(true);
      await s.expectError(
        "CDF_CONFLICT:HOLD_NOT_ACTIVE",
        (tx) => tx`select api.request_legal_hold_release(${real.hold}, ${JUSTIFICATION})`,
      );
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:REQUEST_NOT_PENDING",
        (tx) => tx`select api.decide_disposition(${real.disposition}, false, ${DECISION})`,
      );
    });
  });

  it("a revoked user gets nothing from any records probe", async () => {
    await ownerScenario(async (s) => {
      const real = await disposedCaseB(s, caseB);
      await s.as("revoked");
      const leaks: string[] = [];
      for (const probe of RECORDS_PROBES) {
        const got = await outcomeOf(s, probe, real, USERS.revoked);
        if (!["EMPTY", "FALSE", "NOT_FOUND"].includes(got) && !got.startsWith("ERROR CDF_UNAUTHENTICATED"))
          leaks.push(`${probe.fn}: ${got}`);
      }
      expect(leaks).toEqual([]);
    });
  });
});

describe("IDOR: referral commands give outsiders the same answer for real objects as for random UUIDs", () => {
  // A referral submitted to the Operations head and a delegation from the head to the preparer. Outsiders: another
  // Operations member, a Finance member, case staff, committee people without a seat, oversight roles and the
  // preliminary-review roles. (SECTOR_ADMIN may revoke delegations, so the platform admin is tested apart.)
  const OUTSIDERS: UserKey[] = [
    "employeeB",
    "financeEmployee",
    "investigatorA",
    "caseManager",
    "grcDirector",
    "committee",
    "committeeSecretary",
    "internalAudit",
    "dpo",
    "complianceManager",
    "grcSectorHead",
  ];
  const OPS = "b0000000-0000-4000-8000-000000000001";

  it.each(OUTSIDERS)("%s", async (actor) => {
    await scenario(async (s) => {
      await s.as("sectorHead");
      const [d] = await s.tx<{ id: string }[]>`
        select api.delegate_referral_approval(${OPS}, ${USERS.employee}, now(), now() + interval '7 days',
          'DEMO-DELEGATION-PROBE', 'Synthetic: probe delegation.') as id`;
      await s.as("employee");
      const [r] = await s.tx<{ id: string }[]>`
        select api.create_referral(${OPS}, 'Probe referral (synthetic)', 'Synthetic: probe referral summary.', 'FRAUD',
          'RESTRICTED'::core.classification_level) as id`;
      await s.tx`select api.submit_referral(${r!.id}, null)`;
      await s.as(actor);
      const real: ReferralTargets = { referral: r!.id, delegation: d!.id };
      const random: ReferralTargets = { referral: randomUUID(), delegation: randomUUID() };
      const mismatches: string[] = [];
      for (const probe of REFERRAL_PROBES) {
        const onReal = await outcomeOf(s, probe, real, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      expect(await s.tx`select id from intake.referral`).toEqual([]);
      expect(await s.tx`select id from intake.referral_event`).toEqual([]);
    });
  });
});

describe("IDOR: committee meeting objects (migration 1890)", () => {
  // Nobody here holds a seat on the proceeding or a place in the meeting. The case team (case manager) sees the
  // meeting's logistics but not its deliberation, so it is covered by the meeting spec, not listed here.
  const OUTSIDERS: UserKey[] = [
    "investigatorA",
    "committee", // a global COMMITTEE_MEMBER role, no seat
    "intake",
    "platformAdmin", // COMMITTEE_ADMIN maintains the registry, sees no proceeding
    "internalAudit",
    "soc",
    "dpo",
    "grcSectorHead",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    await scenario(async (s) => {
      await s.as("platformAdmin");
      const [ic] = await s.tx<{ id: string }[]>`select id from committee.committee where code = 'IC'`;
      for (const [user, seatCode] of [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["legal", "MEMBER"],
      ] as const) {
        await s.tx`select api.appoint_committee_member(${ic!.id}, ${USERS[user]}, ${seatCode}, now() - interval '1 day', null, 'DEMO-APPT')`;
      }
      await s.as("caseManager");
      const [cp] = await s.tx<{ id: string }[]>`
        select api.refer_case_to_committee(${caseB}, ${ic!.id}, null, ${REASON}) as id`;
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp!.id}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      const [p] = await s.tx<{ id: string }[]>`
        select id from committee.meeting_participant where meeting_id = ${m!.id} and user_id = ${USERS.legal}`;
      await s.as("legal");
      await s.tx`select api.declare_meeting_conflict(${p!.id}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${m!.id}, ${REASON})`;
      await s.tx`select api.record_attendance(${p!.id}, 'PRESENT')`;
      const [v] = await s.tx<
        { id: string }[]
      >`select api.open_vote_item(${m!.id}, 'OTHER', null, 'Probe item') as id`;
      // A second meeting, closed with nobody present, so its minutes are final at once.
      const [m2] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp!.id}, 'HEARING', 'TEAMS', null, 'https://meet.example.test/probe',
          now() + interval '2 days', now() + interval '2 days 1 hour', ${REASON}) as id`;
      await s.tx`select api.open_meeting(${m2!.id}, ${REASON})`;
      await s.tx`select api.close_meeting(${m2!.id}, ${REASON})`;
      const [mi] = await s.tx<
        { id: string }[]
      >`select api.generate_minutes(${m2!.id}, 'Synthetic probe minutes.') as id`;

      await s.as(actor);
      const real: MeetingTargets = {
        committeeProceeding: cp!.id,
        meeting: m!.id,
        participant: p!.id,
        voteItem: v!.id,
        minutes: mi!.id,
      };
      const random: MeetingTargets = {
        committeeProceeding: randomUUID(),
        meeting: randomUUID(),
        participant: randomUUID(),
        voteItem: randomUUID(),
        minutes: randomUUID(),
      };
      const mismatches: string[] = [];
      for (const probe of MEETING_PROBES) {
        const onReal = await outcomeOf(s, probe, real, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      for (const table of [
        "meeting",
        "meeting_participant",
        "meeting_conflict",
        "vote_item",
        "minutes",
        "minutes_review",
      ]) {
        expect(await s.tx`select id from ${s.tx("committee." + table)}`, table).toEqual([]);
      }
    });
  });
});

describe("IDOR: recommendation, legal review and authority objects (migration 1900)", () => {
  // Nobody here sits on the proceeding, is assigned the legal review or works the case. legalB (the assigned
  // reviewer) and the case team are covered by recommendations-authority.spec.ts.
  const OUTSIDERS: UserKey[] = [
    "investigatorA",
    "committee",
    "intake",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
    "grcSectorHead",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    await scenario(async (s) => {
      const { ic } = await committeeIds();
      const f = await draftPackage(s, ic, await caseId("0002"));
      await voteOnPackage(s, f);
      const { request, packet } = await requestLegalReview(s, f);
      await s.as(actor);
      const real: DecisionTargets = {
        committeeProceeding: f.meeting.committeeProceeding,
        meeting: f.meeting.meeting,
        pkg: f.pkg,
        item: f.sanction,
        request,
        packet,
      };
      const random: DecisionTargets = {
        committeeProceeding: randomUUID(),
        meeting: randomUUID(),
        pkg: randomUUID(),
        item: randomUUID(),
        request: randomUUID(),
        packet: randomUUID(),
      };
      const mismatches: string[] = [];
      for (const probe of DECISION_PROBES) {
        const onReal = await outcomeOf(s, probe, real, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      for (const table of [
        "recommendation_package",
        "recommendation_item",
        "legal_review_request",
        "packet",
        "packet_item",
        "authority_decision",
      ]) {
        expect(await s.tx`select id from ${s.tx("decision." + table)}`, table).toEqual([]);
      }
    });
  });
});

describe("IDOR: employee defence and grievance objects (migration 1910)", () => {
  // None of these works case 0002, sits on the Grievance Committee, is the linked subject or filed the grievance.
  // The case team, the subject and the secretary are covered by grievance-defence.spec.ts.
  const OUTSIDERS: UserKey[] = [
    "investigatorA",
    "committee",
    "employeeB",
    "intake",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
    "grcSectorHead",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const [subj] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
      const [link] = await s.tx<{ id: string }[]>`
        select api.link_subject_portal_account(${subj!.id}, ${USERS.employee}, ${REASON}) as id`;
      const [allegation] = await s.tx<{ id: string }[]>`
        select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: allegation against Employee Sigma.', ${subj!.id},
          null, null) as id`;
      const [notice] = await s.tx<{ id: string }[]>`
        select api.issue_defence_notice(${subj!.id}, 'Synthetic: you are invited to respond.',
          ${[allegation!.id]}::uuid[], now() + interval '10 days') as id`;
      await s.as("employee");
      const [grievance] = await s.tx<{ id: string }[]>`
        select api.file_grievance(${link!.id}, now() - interval '1 day', 'Synthetic: grievance grounds.') as id`;
      await s.as(actor);
      const real: GrievanceTargets = {
        subject: subj!.id,
        link: link!.id,
        notice: notice!.id,
        grievance: grievance!.id,
      };
      const random: GrievanceTargets = {
        subject: randomUUID(),
        link: randomUUID(),
        notice: randomUUID(),
        grievance: randomUUID(),
      };
      const mismatches: string[] = [];
      for (const probe of GRIEVANCE_PROBES) {
        const onReal = await outcomeOf(s, probe, real, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      expect(await s.tx`select * from api.my_defence_notices()`).toEqual([{ my_defence_notices: [] }]);
      for (const table of [
        "subject_portal_link",
        "defence_notice",
        "defence_notice_item",
        "defence_response",
        "grievance",
        "admissibility_assessment",
        "grievance_outcome",
      ]) {
        expect(await s.tx`select id from ${s.tx("grievance." + table)}`, table).toEqual([]);
      }
    });
  });
});

describe("IDOR: notifications (migration 1920)", () => {
  // legal's seat notification; every other user is an outsider to it.
  const OUTSIDERS: UserKey[] = [
    "committeeChair",
    "committeeSecretary",
    "platformAdmin",
    "dpo",
    "internalAudit",
    "soc",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    await scenario(async (s) => {
      const { ic } = await committeeIds();
      await s.as("platformAdmin");
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.legal}, 'MEMBER', now(), null, 'DEMO-APPT')`;
      await s.as("legal");
      const [n] = await s.tx<{ id: string }[]>`select id from notify.outbox limit 1`;
      await s.as(actor);
      const mismatches: string[] = [];
      for (const probe of NOTIFICATION_PROBES) {
        const onReal = await outcomeOf(s, probe, { notification: n!.id }, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, { notification: randomUUID() }, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      expect(await s.tx`select id from notify.outbox where recipient_id = ${USERS.legal}`).toEqual([]);
    });
  });
});

describe("cross-case object substitution", () => {
  it("an insider on case A cannot act on case B's objects by passing them to commands", async () => {
    const seeded = await seedObjects("0002");
    await scenario(async (s) => {
      // The lead of case A may assign, end and reassign assignments on case A only.
      await s.as("lead");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.end_assignment(${seeded.assignment}, ${REASON})`,
      );
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.reassign_case(${seeded.assignment}, ${USERS.investigatorA}, ${REASON})`,
      );
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.revoke_case_access(${seeded.grant}, ${REASON})`,
      );
      // Registering on case A but naming an evidence item from case B is refused, not silently re-homed.
      await s.as("investigatorB");
      const [ev] = await s.tx<{ evidence: string; version: string }[]>`
        select o_evidence_id as evidence, o_version_id as version from api.register_evidence_version(${caseB}, null, 'Case B item (synthetic)', null,
          'DOCUMENT', 'Synthetic source', null, 'RESTRICTED'::core.classification_level, 'b.pdf', 'application/pdf', 100, ${"e".repeat(64)})`;
      await s.as("investigatorA");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select * from api.register_evidence_version(${caseA}, ${ev!.evidence}, null, null, null, null, null, null,
            'swap.pdf', 'application/pdf', 100, ${"f".repeat(64)})`,
      );
      // Linking case B's evidence as a recording of a case A interview is refused, not re-homed (CDF-60),
      // with the same answer as for an evidence id that does not exist.
      await s.as("investigatorB");
      await s.tx`select api.complete_evidence_version(${ev!.version}, 'CLEAN', 'probe-scanner')`;
      await s.as("investigatorA");
      const [iv] = await s.tx<{ id: string }[]>`
        select api.plan_interview(${caseA}, 'Swap interview (synthetic)', null, 'WITNESS', 'Witness Swap (synthetic)', null,
          'CONFIDENTIAL'::core.classification_level) as id`;
      await s.tx`select api.schedule_interview(${iv!.id}, now() - interval '2 hours', 60, 'PHONE', null)`;
      await s.tx`select api.issue_interview_notice(${iv!.id}, 'INVITATION', 'INTERNAL_EMAIL')`;
      await s.tx`select api.record_interview_rights(${iv!.id}, 'SIGNED_FORM', 'PROBE-RIGHTS-V1')`;
      await s.tx`select api.record_interview_conducted(${iv!.id}, now() - interval '2 hours', now() - interval '1 hour')`;
      await s.expectError(
        "CDF_INVALID:evidence_id",
        (tx) => tx`select api.link_interview_recording(${iv!.id}, ${ev!.evidence})`,
      );
      await s.expectError(
        "CDF_INVALID:evidence_id",
        (tx) => tx`select api.link_interview_recording(${iv!.id}, ${randomUUID()})`,
      );
      // And case B's seeded reporter interview is unreachable from case A's team.
      const [reporterInterview] = await admin<{ id: string }[]>`
        select id from case_mgmt.interview where case_id = ${caseB} and interviewee_kind = 'REPORTER' limit 1`;
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.transition_interview(${reporterInterview!.id}, 'CANCEL', ${REASON})`,
      );
    });
  });
});

describe("non-object commands", () => {
  const NON_ADMINS: UserKey[] = [
    "intake",
    "triage",
    "caseManager",
    "investigatorA",
    "lead",
    "committee",
    "grcDirector",
    "internalAudit",
    "soc",
    "dpo",
  ];

  it.each(NON_ADMINS)("%s cannot use user or role administration commands", async (actor) => {
    const [assignment] = await admin<{ id: string }[]>`
      select id from iam.user_role_assignment where user_id = ${USERS.investigatorB} and status = 'ACTIVE' limit 1`;
    await scenario(async (s) => {
      await s.as(actor);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.grant_role(${USERS.committee}, 'GRC_DIRECTOR', ${REASON}, null)`,
      );
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.grant_role(${USERS[actor]}, 'PLATFORM_ADMIN', ${REASON}, null)`,
      );
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.revoke_role(${assignment!.id}, ${REASON})`);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.set_user_status(${USERS.investigatorB}, 'SUSPENDED'::core.record_status, ${REASON})`,
      );
    });
  });

  it("a revoked user gets nothing from any probe, even on a case they were assigned to", async () => {
    const seeded = await seedObjects("0002");
    await scenario(async (s) => {
      const purpose = await purposeObjects(s, caseB, "caseManager", "legal", true);
      const domain = await domainObjects(s, caseB, "caseManager", "investigatorB");
      const inside = await insiderObjects(
        s,
        caseB,
        "investigatorB",
        "grcDirector",
        "investigatorB",
        "RESTRICTED",
        "investigatorB",
      );
      const attachment = await reporterAttachment(s, seeded.reportRef);
      await s.as("revoked");
      const leaks: string[] = [];
      for (const probe of PROBES) {
        const got = await outcomeOf(
          s,
          probe,
          { case: caseB, ...seeded, ...inside, ...purpose, ...domain, attachment },
          USERS.revoked,
        );
        if (!["EMPTY", "FALSE", "NOT_FOUND"].includes(got) && !got.startsWith("ERROR CDF_UNAUTHENTICATED"))
          leaks.push(`${probe.fn}: ${got}`);
      }
      expect(leaks).toEqual([]);
    });
  });

  it("anonymous callers can use no api.* command", async () => {
    const fns = await admin<{ sig: string; args: number }[]>`
      select p.oid::regprocedure::text as sig, p.pronargs::int as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and has_function_privilege('authenticated', p.oid, 'EXECUTE')`;
    await scenario(async (s) => {
      await s.as(null);
      for (const f of fns) {
        const name = f.sig.slice(0, f.sig.indexOf("("));
        const nulls = Array.from({ length: f.args }, () => "null").join(", ");
        await s.expectError("permission denied", (tx) => tx.unsafe(`select ${name}(${nulls})`));
      }
    });
  });
});
