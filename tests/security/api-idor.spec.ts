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
import {
  IC_SEATS,
  committeeIds,
  openItem,
  openWithPresent,
  preliminaryReferral,
  refer,
  scheduleMeeting,
  seat,
  unseatDemoSeats,
  vote,
} from "../support/committee";
import { draftPackage, requestLegalReview, voteOnPackage } from "../support/decision";
import { openRecord, stageOneMeetingWorkbook, uploadMinutes } from "../support/committee-record";

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
  // Reporter conversation (DEC-06, migration 1840)
  reporterDelegation: string;
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
  // Migration 2040 (DEC-AMB-009): what the case team is shown about executing each decided sanction.
  {
    fn: "sanction_executability",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.sanction_executability(${t.case})`,
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
  // S2 read models (migration 1830): no rows without the caller's own case access, as for a missing case.
  {
    fn: "case_access_roster",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.case_access_roster(${t.case})`,
  },
  // S2h (migration 1860): the officers a retention review may be routed to, refused as for a missing case.
  {
    fn: "list_retention_reviewers",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select * from api.list_retention_reviewers(${t.case})`,
  },
  {
    fn: "case_history",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.case_history(${t.case}, 500)`,
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
  // DEC-06 (migration 1840): delegating the reporter conversation, to oneself or anyone, and ending a delegation.
  {
    fn: "delegate_reporter_communication",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.delegate_reporter_communication(${t.case}, ${self}, ${REASON})`,
  },
  {
    fn: "end_reporter_communication",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.end_reporter_communication(${t.reporterDelegation}, ${REASON})`,
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
  // Migration 2050 (ADR-041): exclusion, custody exceptions, renditions and integrity reports on an item or version.
  {
    fn: "exclude_evidence",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.exclude_evidence(${t.evidence}, ${REASON})`,
  },
  {
    fn: "record_custody_exception",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_custody_exception(${t.evidence}, ${t.version}, 'EXTERNAL_TRANSFER', ${REASON}, 'EXT-PROBE-1')`,
  },
  {
    fn: "register_evidence_rendition",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select * from api.register_evidence_rendition(${t.version}, 'probe.pdf', 'application/pdf', 10, ${SHA})`,
  },
  {
    fn: "report_evidence_integrity_failure",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.report_evidence_integrity_failure(${t.version}, ${SHA})`,
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
    // DEC-09 (migration 1850): an item outside the caller's need-to-know is not found.
    fn: "set_evidence_restriction",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.set_evidence_restriction(${t.evidence}, 'LEADS', ${REASON})`,
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
  // Migration 2045 (P12-0b, ADR-051): what that referral would copy, behind the referral command's own checks.
  {
    fn: "committee_referral_preview",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.committee_referral_preview(${t.case}, (select id from committee.committee where code = 'IC'))`,
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
  // Escalation after a repeated rejection (migration 2040, DEC-F09).
  {
    fn: "escalate_referral_rejection",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.escalate_referral_rejection(${t.referral}, 'Synthetic: probe escalation text.')`,
  },
  {
    fn: "decide_referral_escalation",
    outcome: "NOT_FOUND",
    call: (tx, t, self) =>
      tx`select api.decide_referral_escalation(${t.referral}, 'ACCEPT', null, null, ${self})`,
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
  // Migration 2040 item 13: the purpose read model, NOT_FOUND unless authz.can_view_referral.
  {
    fn: "referral_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.referral_view(${t.referral})`,
  },
  {
    fn: "revoke_referral_delegation",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.revoke_referral_delegation(${t.delegation}, ${REASON})`,
  },
];

// Committee meeting commands (migration 1890) take a committee proceeding, a meeting, a participant, a vote item,
// minutes or a raised conflict (2000); never a case.
interface MeetingTargets {
  committee: string;
  committeeProceeding: string;
  meeting: string;
  participant: string;
  voteItem: string;
  minutes: string;
  concern: string;
  witness: string;
}

const MEETING_PROBES: Probe<MeetingTargets>[] = [
  {
    fn: "schedule_meeting",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.schedule_meeting(${t.committeeProceeding}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
        now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON})`,
  },
  // Migration 2110 (ADR-047): a lost committee workbook is revoked in its proceeding's namespace.
  {
    fn: "revoke_committee_bcp_workbook",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.revoke_committee_bcp_workbook(${t.committeeProceeding}, 'BCP-PROBE-2110', 'INC-DEMO-2110', ${REASON})`,
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
    fn: "record_excused_absence",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.record_excused_absence(${t.participant}, ${REASON})`,
  },
  {
    fn: "raise_meeting_conflict",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.raise_meeting_conflict(${t.participant}, ${REASON})`,
  },
  {
    fn: "decide_meeting_conflict",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_meeting_conflict(${t.concern}, 'UPHELD', ${REASON})`,
  },
  {
    fn: "exclude_meeting_witness",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.exclude_meeting_witness(${t.witness}, ${REASON})`,
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
    // Migration 2120 (ADR-048): a member's confirmation of their own paper ballot.
    fn: "confirm_offline_ballot",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.confirm_offline_ballot(${t.voteItem}, 'APPROVE')`,
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
  // Purpose read models (migration 2030 section 4).
  {
    fn: "meeting_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.meeting_view(${t.meeting})`,
  },
  {
    fn: "minutes_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.minutes_view(${t.minutes})`,
  },
  // Migration 2085 (ADR-055): the committee page, NOT_FOUND without a current seat on the committee, as for a random id.
  {
    fn: "committee_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.committee_view(${t.committee})`,
  },
  // Migration 2086 (ADR-056): the runner's invite list, NOT_FOUND to whoever cannot see the meeting, as for a random id.
  {
    fn: "meeting_invite_choices",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.meeting_invite_choices(${t.meeting})`,
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
  // The owner's Finalization Set (migration 2030, ADR-040): acting roles, alternates, the snapshot amendment,
  // emergency meetings, invitee acknowledgements and accommodations, vote revisions, recusals, notes and the
  // minutes objection ruling.
  {
    fn: "activate_acting_chair",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.activate_acting_chair(${t.meeting}, ${REASON})`,
  },
  {
    fn: "activate_acting_secretary",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.activate_acting_secretary(${t.meeting}, ${REASON})`,
  },
  {
    fn: "activate_alternate_member",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.activate_alternate_member(${t.participant}, ${t.participant}, ${REASON})`,
  },
  {
    fn: "amend_proceeding_snapshot",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.amend_proceeding_snapshot(${t.committeeProceeding}, ${t.participant}, ${REASON})`,
  },
  {
    fn: "schedule_emergency_meeting",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.schedule_emergency_meeting(${t.committeeProceeding}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)',
        null, now() + interval '2 hours', now() + interval '3 hours', ${REASON}, 'Synthetic: probe emergency.')`,
  },
  {
    fn: "acknowledge_meeting_confidentiality",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.acknowledge_meeting_confidentiality(${t.witness})`,
  },
  {
    fn: "record_meeting_accommodation",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_meeting_accommodation(${t.participant}, 'Synthetic: probe accommodation.')`,
  },
  {
    fn: "revise_vote",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.revise_vote(${t.voteItem}, 'REJECT', ${REASON})`,
  },
  {
    fn: "recuse_for_conflict",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.recuse_for_conflict(${t.voteItem}, ${REASON})`,
  },
  {
    fn: "record_vote_note",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.record_vote_note(${t.voteItem}, 'Synthetic: probe note.', false)`,
  },
  {
    fn: "reverse_meeting_conflict_determination",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.reverse_meeting_conflict_determination(${t.concern}, ${REASON})`,
  },
  {
    fn: "overrule_minutes_objection",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.overrule_minutes_objection(${t.minutes}, ${REASON})`,
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
  // Migration 2030: return before submission, item flags, cancelling a request, a superseding opinion.
  {
    fn: "return_package_to_committee",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.return_package_to_committee(${t.pkg}, ${REASON})`,
  },
  {
    fn: "recommendation_item_flags",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select * from api.recommendation_item_flags(${t.pkg})`,
  },
  {
    fn: "cancel_legal_review_request",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.cancel_legal_review_request(${t.request}, ${REASON})`,
  },
  {
    fn: "give_superseding_legal_opinion",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.give_superseding_legal_opinion(${t.request}, 'CONCURS', null)`,
  },
  // DEC-AMB-003 (owner, 2026-10-13): the committee's resolution of a tainted item.
  {
    fn: "resolve_conflict_taint",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.resolve_conflict_taint(${t.item}, 'CONFIRM', 'Probe resolution reason.')`,
  },
  // Migration 2040: executing a decided sanction (AMB-109; DEC-AMB-004, DEC-AMB-009, DEC-AMB-011).
  {
    fn: "record_sanction_execution",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_sanction_execution(${t.item}, ${randomUUID()}, now(), 'HR-PROBE-0001')`,
  },
  // Migration 2095 (ADR-057): the assigned reviewer's request, and the choices for asking for or approving a legal
  // review, NOT_FOUND to whoever cannot see them, as for a random id.
  {
    fn: "legal_review_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.legal_review_view(${t.request})`,
  },
  {
    fn: "legal_review_choices",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.legal_review_choices(${t.pkg}, 'REQUEST')`,
  },
  {
    fn: "legal_review_choices",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.legal_review_choices(${t.pkg}, 'APPROVE')`,
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
  // Migration 2040 item 13: the purpose read model, NOT_FOUND unless authz.can_view_grievance or the decider it awaits.
  {
    fn: "grievance_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.grievance_view(${t.grievance})`,
  },
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
  // Kinds of employee notice (migration 1990, ADR-037): a rights or decision notice to a subject, and the subject's
  // grievance on a decision notice.
  {
    fn: "issue_rights_notice",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.issue_rights_notice(${t.subject}, 'Probe notice text.', null)`,
  },
  {
    fn: "issue_decision_notice",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.issue_decision_notice(${t.subject}, ${randomUUID()}, 'Probe notice text.')`,
  },
  {
    fn: "file_grievance_on_decision_notice",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.file_grievance_on_decision_notice(${t.notice}, 'Probe grievance grounds.')`,
  },
  // AGENT-09 G2b (migration 1910): the Restricted Case Authority names a secretary to handle a received grievance.
  {
    fn: "approve_restricted_grievance_handling",
    outcome: "NOT_FOUND",
    call: (tx, t, self) =>
      tx`select api.approve_restricted_grievance_handling(${t.grievance}, ${self}, ${REASON})`,
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
  // Migration 2040: notice delivery and deadline changes (DEC-F15, DEC-F18), the grievant's withdrawal and completion
  // (AMB-140, AMB-141), the one reconsideration on new evidence by either path (DEC-AMB-001), and a subject who left
  // employment (DEC-AMB-009).
  {
    fn: "record_notice_delivery",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_notice_delivery(${t.notice}, 'HAND_DELIVERY', now(), 'HAND-PROBE-0001')`,
  },
  {
    fn: "change_defence_deadline",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.change_defence_deadline(${t.notice}, 'EXTENSION', now() + interval '20 days', ${REASON})`,
  },
  {
    fn: "withdraw_grievance",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.withdraw_grievance(${t.grievance}, ${REASON})`,
  },
  {
    fn: "request_grievance_completion",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.request_grievance_completion(${t.grievance}, ${REASON})`,
  },
  {
    fn: "complete_grievance",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.complete_grievance(${t.grievance}, 'Probe supplement text.')`,
  },
  {
    fn: "file_grievance_reconsideration",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.file_grievance_reconsideration(${t.grievance}, 'Probe grievance grounds.',
        'Probe new evidence description.', 'EVIDENCE-PROBE-0001')`,
  },
  {
    fn: "record_grievance_reconsideration",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_grievance_reconsideration(${t.grievance}, 'EMAIL', now(), 'Probe grievance grounds.',
        'LETTER-PROBE-0001', 'Probe new evidence description.', 'EVIDENCE-PROBE-0001')`,
  },
  {
    fn: "flag_subject_left_employment",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.flag_subject_left_employment(${t.subject}, current_date, 'HR-PROBE-0001')`,
  },
  {
    fn: "record_employment_execution_statement",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_employment_execution_statement(${t.subject}, 'WARNING', 'HR-PROBE-0001', ${REASON})`,
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

// Export builder commands (migration 1930) take a case (creation) or an export request; never content.
interface ExportTargets {
  case: string;
  request: string;
}

const EXPORT_PROBES: Probe<ExportTargets>[] = [
  {
    fn: "create_export_request",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.create_export_request(${t.case}, 'PDF', 'INTERNAL', 'INTERNAL_MANAGEMENT_REVIEW', null, null)`,
  },
  {
    fn: "add_export_item",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.add_export_item(${t.request}, 'CASE_SUMMARY', ${t.case})`,
  },
  {
    fn: "add_export_recipient",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.add_export_recipient(${t.request}, 'INTERNAL', ${self}, null)`,
  },
  {
    fn: "preview_export",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.preview_export(${t.request})`,
  },
  {
    fn: "submit_export",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.submit_export(${t.request}, ${SHA}, 'RESTRICTED'::core.classification_level)`,
  },
  {
    fn: "decide_export",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_export(${t.request}, 'APPROVE', ${REASON}, ${SHA})`,
  },
  {
    fn: "decide_restricted_export",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_restricted_export(${t.request}, 'APPROVE', ${REASON}, ${SHA})`,
  },
  {
    fn: "generate_export",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.generate_export(${t.request})`,
  },
  {
    fn: "record_export_sent",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.record_export_sent(${t.request})`,
  },
  {
    fn: "cancel_export",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.cancel_export(${t.request}, ${REASON})`,
  },
  // Migration 2040 item 13: the purpose read model, NOT_FOUND unless authz.can_view_export.
  {
    fn: "export_request_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.export_request_view(${t.request})`,
  },
];

// Corrective-action commands (migration 1940) take an approved recommendation item or an action; the case's list of
// them (migration 2096) takes the case.
interface CorrectiveActionTargets {
  item: string;
  action: string;
  case: string;
}

const CORRECTIVE_ACTION_PROBES: Probe<CorrectiveActionTargets>[] = [
  {
    fn: "open_corrective_action",
    outcome: "NOT_FOUND",
    call: (tx, t, self) =>
      tx`select api.open_corrective_action(${t.item}, 'Probe corrective action', 'Probe corrective action text.',
        ${self}, current_date + 30)`,
  },
  {
    fn: "assign_corrective_action_owner",
    outcome: "NOT_FOUND",
    call: (tx, t, self) => tx`select api.assign_corrective_action_owner(${t.action}, ${self}, ${REASON})`,
  },
  {
    fn: "change_corrective_action_due_date",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.change_corrective_action_due_date(${t.action}, current_date + 60, ${REASON})`,
  },
  {
    fn: "record_corrective_action_progress",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.record_corrective_action_progress(${t.action}, 50, ${REASON})`,
  },
  {
    fn: "submit_corrective_action_completion",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.submit_corrective_action_completion(${t.action}, ${REASON}, 'PROBE-REF')`,
  },
  {
    fn: "verify_corrective_action",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.verify_corrective_action(${t.action}, 'VERIFIED', null)`,
  },
  {
    fn: "reopen_corrective_action",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.reopen_corrective_action(${t.action}, ${REASON})`,
  },
  {
    fn: "waive_corrective_action",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.waive_corrective_action(${t.action}, 'MEMO-PROBE-0001', ${REASON})`,
  },
  // Migration 2030 (DEC-AMB-014): the replacement decision's disposition of a frozen action.
  {
    fn: "dispose_superseded_corrective_action",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.dispose_superseded_corrective_action(${t.action}, 'WAIVE', 'MEMO-PROBE-0001', ${REASON}, null, null,
        null, null)`,
  },
  // Migration 2040 (DEC-F28): a unit, pool or external party owns the action.
  {
    fn: "set_corrective_action_owner_kind",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.set_corrective_action_owner_kind(${t.action}, 'EXTERNAL_PARTY', null, null, 'Probe party', ${REASON})`,
  },
  // Migration 2040 item 13: the purpose read model, NOT_FOUND unless authz.can_view_corrective_action.
  {
    fn: "corrective_action_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.corrective_action_view(${t.action})`,
  },
  // Migration 2096 (P12-3b, ADR-058): the case's corrective actions, NOT_FOUND unless authz.can_view_case.
  {
    fn: "case_corrective_actions",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.case_corrective_actions(${t.case})`,
  },
];

// Continuity workbook import (migration 1960): staging names a case in the workbook's control sheet; every other
// command takes a batch or one of its rows.
interface BcpTargets {
  case: string;
  caseNumber: string;
  batch: string;
  row: string;
}

const BCP_PROBES: Probe<BcpTargets>[] = [
  {
    fn: "stage_bcp_import",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.stage_bcp_import(
        jsonb_build_object('TEMPLATE_VERSION', 'BCP-1', 'WORKBOOK_ID', 'BCP-PROBE-1', 'CASE_ID', ${t.case}::text,
                           'CASE_NUMBER', ${t.caseNumber}::text, 'OFFLINE_FROM', '2026-01-01T00:00:00Z',
                           'PREPARED_BY', 'lead@example.test'),
        ${SHA}, '[]'::jsonb)`,
  },
  {
    fn: "resolve_bcp_row",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.resolve_bcp_row(${t.row}, 'SKIP', ${REASON})`,
  },
  {
    fn: "preview_bcp_import",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.preview_bcp_import(${t.batch})`,
  },
  {
    fn: "submit_bcp_import",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.submit_bcp_import(${t.batch}, ${SHA})`,
  },
  {
    fn: "decide_bcp_import",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_bcp_import(${t.batch}, 'APPROVE', ${REASON}, ${SHA})`,
  },
  {
    fn: "apply_bcp_import",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.apply_bcp_import(${t.batch}, ${SHA})`,
  },
  {
    fn: "cancel_bcp_import",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.cancel_bcp_import(${t.batch}, ${REASON})`,
  },
  // Migration 2040 item 13: the purpose read model, NOT_FOUND unless authz.can_view_bcp_import.
  {
    fn: "bcp_import_batch_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.bcp_import_batch_view(${t.batch})`,
  },
];

// Migration 2115 (ADR-061): the official record of a committee workbook. Every command takes the batch, the record,
// one version of its signed minutes or an acting-chair activation; each is NOT_FOUND unless the caller is the importer
// or a roster member who counts now (authz.can_view_committee_record), whatever their other roles.
interface RecordTargets {
  batch: string;
  record: string;
  document: string;
  activation: string;
}

const RECORD_2115_PROBES: Probe<RecordTargets>[] = [
  {
    fn: "open_committee_record",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.open_committee_record(${t.batch})`,
  },
  {
    fn: "declare_committee_record_roster",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.declare_committee_record_roster(${t.record}, '[]'::jsonb)`,
  },
  {
    fn: "register_committee_record_document",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select * from api.register_committee_record_document(${t.record}, 'probe.pdf', 'application/pdf', 1024,
        ${SHA}, current_date - 1, 'CDF-MINUTES-TEMPLATE-DEMO', 'CONFIDENTIAL'::core.classification_level)`,
  },
  {
    fn: "complete_committee_record_document",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.complete_committee_record_document(${t.document}, 'CLEAN', 'probe-scanner')`,
  },
  {
    fn: "mark_committee_minutes_signed",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.mark_committee_minutes_signed(${t.document})`,
  },
  {
    fn: "open_committee_record_document",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select * from api.open_committee_record_document(${t.document})`,
  },
  {
    fn: "activate_record_acting_chair",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.activate_record_acting_chair(${t.record}, 'UNAVAILABLE', 'Synthetic: probe activation reason.',
        now() + interval '1 day')`,
  },
  {
    fn: "end_record_acting_chair",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.end_record_acting_chair(${t.activation}, ${REASON})`,
  },
  {
    fn: "decide_committee_record",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_committee_record(${t.record}, 1, 'APPROVE', null)`,
  },
  {
    fn: "return_committee_record",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.return_committee_record(${t.record}, ${REASON})`,
  },
  {
    fn: "attest_committee_record",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.attest_committee_record(${t.record}, 1, 'ATTEST', null, null)`,
  },
];

// Migration 2050 (ADR-041): the exclusion record, the Defence Packet and the prior-sanctions extract.
interface EvidenceHalfTargets {
  exclusion: string;
  notice: string;
  packet: string;
  item: string;
  version: string;
  committeeProceeding: string;
  subject: string;
  extract: string;
  row: string;
}

const EVIDENCE_HALF_PROBES: Probe<EvidenceHalfTargets>[] = [
  {
    fn: "evidence_exclusion_record",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.evidence_exclusion_record(${t.exclusion})`,
  },
  {
    fn: "create_defence_packet",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.create_defence_packet(${t.notice})`,
  },
  {
    fn: "add_defence_packet_item",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.add_defence_packet_item(${t.packet}, ${t.version})`,
  },
  {
    fn: "review_defence_packet_item",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.review_defence_packet_item(${t.item}, 'WITHHELD', null, null, ${["REPORTER"]}::text[], ${REASON})`,
  },
  {
    fn: "submit_defence_packet",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.submit_defence_packet(${t.packet})`,
  },
  {
    fn: "decide_restricted_defence_packet",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_restricted_defence_packet(${t.packet}, 'APPROVE', ${REASON})`,
  },
  {
    fn: "withdraw_defence_packet",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.withdraw_defence_packet(${t.packet}, ${REASON})`,
  },
  {
    fn: "defence_packet_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.defence_packet_view(${t.packet})`,
  },
  {
    fn: "my_defence_packet",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.my_defence_packet(${t.notice})`,
  },
  {
    fn: "open_defence_packet_item",
    outcome: "EMPTY",
    call: (tx, t) => tx`select * from api.open_defence_packet_item(${t.item})`,
  },
  {
    fn: "request_sanction_extract",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.request_sanction_extract(${t.committeeProceeding}, ${t.subject}, ${REASON})`,
  },
  {
    fn: "sanction_extract_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.sanction_extract_view(${t.extract})`,
  },
  {
    fn: "decide_sanction_extract_row",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_sanction_extract_row(${t.row}, 'APPROVE', ${REASON})`,
  },
];

interface ClosureTargets {
  case: string;
  closureRequest: string;
  closedCase: string;
  reopeningRequest: string;
  committeeProceeding: string;
  packet: string;
}

// Migration 2060 (ADR-042): closure and reopening, the package-building read models and the packet approval read.
const CLOSURE_2060_PROBES: Probe<ClosureTargets>[] = [
  {
    fn: "close_case",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.close_case(${t.case}, 'NO_ACTION', ${REASON})`,
  },
  {
    fn: "decide_case_closure",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_case_closure(${t.closureRequest}, 'APPROVE', ${REASON})`,
  },
  {
    fn: "case_closure_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.case_closure_view(${t.case})`,
  },
  {
    fn: "request_case_reopening",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.request_case_reopening(${t.closedCase}, 'NEW_EVIDENCE', ${REASON}, ${REASON}, 'DEMO-REF', null)`,
  },
  {
    fn: "decide_case_reopening",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_case_reopening(${t.reopeningRequest}, 'APPROVE', ${REASON})`,
  },
  {
    fn: "committee_scope_choices",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.committee_scope_choices(${t.committeeProceeding})`,
  },
  {
    fn: "committee_items_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.committee_items_view(${t.committeeProceeding})`,
  },
  {
    fn: "defence_packet_approval_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.defence_packet_approval_view(${t.packet})`,
  },
];

// Migration 2070 (ADR-043, DEC-F41): a corrective action from preliminary review takes a preliminary recommendation or
// one of its proposals; never a case.
interface PreliminaryCorrectiveTargets {
  recommendation: string;
  proposal: string;
}

const PRELIMINARY_2070_PROBES: Probe<PreliminaryCorrectiveTargets>[] = [
  {
    fn: "propose_preliminary_corrective_action",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.propose_preliminary_corrective_action(${t.recommendation}, 'CORRECTIVE_ACTION', ${REASON})`,
  },
  {
    fn: "record_preliminary_authority_decision",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.record_preliminary_authority_decision(${t.proposal}, 'CEO', 'APPROVED', now(),
        'Probe authority label', 'MEMO-PROBE-2070', ${REASON})`,
  },
  {
    fn: "open_preliminary_corrective_action",
    outcome: "NOT_FOUND",
    call: (tx, t, self) =>
      tx`select api.open_preliminary_corrective_action(${t.proposal}, 'Probe corrective action',
        'Probe corrective action text.', ${self}, current_date + 30)`,
  },
  {
    fn: "preliminary_corrective_view",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.preliminary_corrective_view(${t.recommendation})`,
  },
];

// Migration 2080 (ADR-044, P11-G7): a raised case conflict takes a case or a concern.
interface CaseConflictTargets {
  case: string;
  concern: string;
}

const CASE_CONFLICT_2080_PROBES: Probe<CaseConflictTargets>[] = [
  {
    fn: "raise_case_conflict",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.raise_case_conflict(${t.case}, ${"a0000000-0000-4000-8000-000000000014"}, ${REASON})`,
  },
  {
    fn: "decide_case_conflict",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.decide_case_conflict(${t.concern}, 'UPHELD', ${REASON})`,
  },
  {
    fn: "case_conflict_concerns",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.case_conflict_concerns(${t.case})`,
  },
];

// Migration 2090 (ADR-045): case structure and corrections take a case, a case link, an allegation, a subject, a
// minutes version or a minutes correction.
interface CaseStructureTargets {
  case: string;
  link: string;
  allegation: string;
  subject: string;
  minutes: string;
  correction: string;
}

const CASE_STRUCTURE_2090_PROBES: Probe<CaseStructureTargets>[] = [
  {
    fn: "link_cases",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.link_cases(${t.case}, ${t.case}, 'RELATED', ${REASON})`,
  },
  {
    fn: "end_case_link",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.end_case_link(${t.link}, ${REASON})`,
  },
  {
    fn: "record_subject_status",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.record_subject_status(${t.subject}, 'UNTRACEABLE', ${REASON})`,
  },
  {
    fn: "withdraw_allegation",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.withdraw_allegation(${t.allegation}, ${REASON})`,
  },
  {
    fn: "split_allegation",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.split_allegation(${t.allegation}, ${tx.json([
        { category: "FRAUD", description: "Synthetic: probe part one." },
        { category: "FRAUD", description: "Synthetic: probe part two." },
      ] as never)}::jsonb, ${REASON})`,
  },
  {
    fn: "correct_case_subject",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.correct_case_subject(${t.subject}, ${t.subject}, ${REASON})`,
  },
  {
    fn: "split_case",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.split_case(${t.case}, ${[t.allegation]}::uuid[], 'Probe split (synthetic)',
        'Synthetic probe summary text.', ${REASON})`,
  },
  {
    fn: "propose_minutes_correction",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.propose_minutes_correction(${t.minutes}, 'Synthetic: probe correction text.', ${REASON})`,
  },
  {
    fn: "review_minutes_correction",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.review_minutes_correction(${t.correction}, 'APPROVE', null)`,
  },
  {
    fn: "annotate_archived_record",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.annotate_archived_record(${t.case}, 'CASE_RECORD', 'Synthetic: probe annotation text.', ${REASON})`,
  },
];

// Migration 2100 (ADR-046): people and access take a case (a lost workbook, an urgent flag) or a delegation of
// preliminary approval.
interface PeopleAccessTargets {
  case: string;
  delegation: string;
}

const PEOPLE_ACCESS_2100_PROBES: Probe<PeopleAccessTargets>[] = [
  {
    fn: "revoke_bcp_workbook",
    outcome: "NOT_FOUND",
    call: (tx, t) =>
      tx`select api.revoke_bcp_workbook(${t.case}, 'BCP-PROBE-2100', 'INC-DEMO-2100', ${REASON})`,
  },
  {
    fn: "flag_case_urgent",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.flag_case_urgent(${t.case}, ${REASON})`,
  },
  {
    fn: "clear_case_urgent",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.clear_case_urgent(${t.case}, ${REASON})`,
  },
  {
    fn: "revoke_preliminary_approval_delegation",
    outcome: "NOT_FOUND",
    call: (tx, t) => tx`select api.revoke_preliminary_approval_delegation(${t.delegation}, ${REASON})`,
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
  // Rule-set options of the owner's Finalization Set (migration 2030): COMMITTEE_ADMIN only, no case.
  "revise_committee_rule_set",
  // Recommendation authority rules (migration 1900): COMMITTEE_ADMIN only, no case.
  "set_action_authority_rule",
  // Sanction catalogue versions, legal-review rules and authority-rule coverage (migration 2030): COMMITTEE_ADMIN
  // only, no case (recommendations-authority.spec.ts).
  "set_sanction_catalogue_entry",
  "set_legal_review_rule",
  "authority_rule_coverage",
  // Notification rules (migration 1920): NOTIFICATION_ADMIN only, no recipient or case.
  "set_notification_rule",
  // Export approval rules (migration 1930): EXPORT_POLICY_ADMIN only, no export or case. Migration 2040 (DEC-F21,
  // DEC-F24): the purpose catalogue, the approver pools and the configuration warnings (ids and counts), for a policy
  // administrator who approves no export.
  "set_export_rule",
  "set_export_purpose",
  "add_export_approver",
  "revoke_export_approver",
  "export_approval_config_warnings",
  // Continuity-workbook operator registry (migration 2040, DEC-F30): BCP_CONTINUITY_ADMIN only, no batch or case.
  "authorize_continuity_operator",
  "revoke_continuity_operator",
  // Migration 2110 (ADR-047): a registry entry for one committee proceeding; BCP_CONTINUITY_ADMIN only, which sees no
  // proceeding: one refusal code whether the proceeding is unknown, closed or the user holds no secretary seat.
  "authorize_committee_continuity_operator",
  // Corrective-action policy (migration 1940): CORRECTIVE_ACTION_POLICY_ADMIN only, no action or case; its shared
  // owner pools (migration 2040, DEC-F28) likewise.
  "set_corrective_action_policy",
  "create_corrective_action_pool",
  "set_corrective_action_pool_member",
  // Sanction catalogue rules (migration 2040; DEC-AMB-004, DEC-AMB-011): COMMITTEE_ADMIN only, no case.
  "set_sanction_rule",
  // Referral escalation target (migration 2040, DEC-F09): COMMITTEE_ADMIN only, no referral or case.
  "set_referral_escalation_target",
  // Sector registry (migration 1880): SECTOR_ADMIN only, no referral or case.
  "create_sector",
  "appoint_sector_member",
  "end_sector_membership",
  // Migration 2030 (ADR-040): the business calendar (BUSINESS_CALENDAR_ADMIN), invitee-type rules and the
  // independent conflict authority (COMMITTEE_ADMIN); none takes a case or a meeting.
  "set_business_calendar_day",
  "withdraw_business_calendar_day",
  "set_business_week_pattern",
  "set_invitee_type_rule",
  "appoint_conflict_authority",
  "end_conflict_authority",
  // A correction to a committee seat (migration 2090, AMB-045): COMMITTEE_ADMIN only, an annotation with no case.
  "annotate_committee_membership",
  // Migration 2100 (ADR-046): deactivating or reactivating a committee (COMMITTEE_ADMIN), flagging an external counsel
  // account (ROLE_ADMIN) and delegating preliminary approval (PRELIMINARY_APPROVE) take a committee or a person, never
  // a case (people-access-2100.spec.ts, referral-preliminary.spec.ts).
  "deactivate_committee",
  "reactivate_committee",
  "flag_external_counsel_account",
  "delegate_preliminary_approval",
  // Migration 2127 (ADR-063): the Administration pages' capability reads take no argument and name no case; each is
  // refused (FORBIDDEN) to whoever does not hold its page's permission (administration-capabilities-2127.spec.ts).
  "admin_calendar_capabilities",
  "admin_committee_capabilities",
  "admin_sector_capabilities",
  "admin_notification_rule_capabilities",
  "admin_export_policy_capabilities",
  "admin_corrective_action_policy_capabilities",
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
  // S2h (migration 1860): the shared retention queue, rows the caller may classify (ADR-016 D8).
  "retention_review_queue",
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
  // Migration 2040 item 13: the referrals and grievances awaiting the caller, each row under its object's read rule
  // (purpose-read-models-2040.spec.ts).
  "referral_queue",
  "grievance_queue",
  // Migration 2050: the sanction extract rows awaiting the caller as a restricted source case's authority.
  "my_sanction_extract_approvals",
  // Migration 2085 (ADR-055): the committees where the caller holds a current seat.
  "my_committees",
  // Migration 2127 (ADR-063): the caller's own Administration pages.
  "my_admin_views",
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

/**
 * A REPORTER_COMMUNICATE delegation (DEC-06) on case B: the case manager lets the assigned investigator write to
 * the reporter. The executive case has no investigator to delegate to, so its probe gets a random id.
 */
async function reporterDelegation(s: Scenario, which: "B" | "EXEC", target: string): Promise<string> {
  if (which === "EXEC") return randomUUID();
  await s.as("caseManager");
  const [d] = await s.tx<{ id: string }[]>`
    select api.delegate_reporter_communication(${target}, ${USERS.investigatorB}, ${REASON}) as id`;
  return d!.id;
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
  reporterDelegation: randomUUID(),
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
      ...EXPORT_PROBES.map((p) => p.fn),
      ...CORRECTIVE_ACTION_PROBES.map((p) => p.fn),
      ...BCP_PROBES.map((p) => p.fn),
      ...RECORD_2115_PROBES.map((p) => p.fn),
      ...EVIDENCE_HALF_PROBES.map((p) => p.fn),
      ...CLOSURE_2060_PROBES.map((p) => p.fn),
      ...PRELIMINARY_2070_PROBES.map((p) => p.fn),
      ...CASE_CONFLICT_2080_PROBES.map((p) => p.fn),
      ...CASE_STRUCTURE_2090_PROBES.map((p) => p.fn),
      ...PEOPLE_ACCESS_2100_PROBES.map((p) => p.fn),
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
      // Before the insider objects too: the investigator's conflict declaration removes its case access.
      const delegation = await reporterDelegation(s, which, target);
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
      const real: Targets = {
        case: target,
        ...seeded,
        ...inside,
        ...purpose,
        ...domain,
        attachment,
        reporterDelegation: delegation,
      };
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
    "committeeChair", // the owner-default escalation target (DEC-F09), with nothing escalated
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
      await unseatDemoSeats(s);
      await s.as("platformAdmin");
      const [ic] = await s.tx<{ id: string }[]>`select id from committee.committee where code = 'IC'`;
      for (const [user, seatCode] of [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["legal", "MEMBER"],
      ] as const) {
        await s.tx`select api.appoint_committee_member(${ic!.id}, ${USERS[user]}, ${seatCode}, now() - interval '1 day', null, 'DEMO-APPT')`;
      }
      await preliminaryReferral(s, caseB); // AMB-018 (migration 2030)
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
      // A justified absence and a raised conflict there (migration 2000), left open.
      const m2Seats = await s.tx<{ id: string; user_id: string }[]>`
        select id, user_id from committee.meeting_participant where meeting_id = ${m2!.id}`;
      await s.tx`select api.record_excused_absence(${m2Seats.find((r) => r.user_id === USERS.committeeChair)!.id}, ${REASON})`;
      const [k] = await s.tx<{ id: string }[]>`
        select api.raise_meeting_conflict(${m2Seats.find((r) => r.user_id === USERS.legal)!.id}, ${REASON}) as id`;
      // An excluded witness there (migration 2010).
      const [w] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${m2!.id}, 'WITNESS', ${USERS.employeeB}, null, false, ${REASON}) as id`;
      await s.tx`select api.exclude_meeting_witness(${w!.id}, ${REASON})`;
      await s.tx`select api.close_meeting(${m2!.id}, ${REASON})`;
      const [mi] = await s.tx<
        { id: string }[]
      >`select api.generate_minutes(${m2!.id}, 'Synthetic probe minutes.') as id`;

      await s.as(actor);
      const real: MeetingTargets = {
        committee: ic!.id,
        committeeProceeding: cp!.id,
        meeting: m!.id,
        participant: p!.id,
        voteItem: v!.id,
        minutes: mi!.id,
        concern: k!.id,
        witness: w!.id,
      };
      const random: MeetingTargets = {
        committee: randomUUID(),
        committeeProceeding: randomUUID(),
        meeting: randomUUID(),
        participant: randomUUID(),
        voteItem: randomUUID(),
        minutes: randomUUID(),
        concern: randomUUID(),
        witness: randomUUID(),
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
        "attendance_excuse",
        "meeting_conflict_concern",
        "witness_exclusion",
        "meeting_acting_role",
        "proceeding_snapshot_amendment",
        "minutes_objection_ruling",
        "confidentiality_ack",
        "meeting_accommodation",
        "meeting_conflict_reversal",
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

describe("IDOR: export requests (migration 1930)", () => {
  // case manager's submitted external export of case 0002 (RESTRICTED). None of these can see case 0002 with an
  // approval permission; investigatorA, the committee member and intake also lack EXPORT_* entirely.
  const OUTSIDERS: UserKey[] = [
    "investigatorA",
    "lead",
    "committee",
    "intake",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
    "legal",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const [r] = await s.tx<{ id: string }[]>`
        select api.create_export_request(${caseB}, 'EMAIL', 'EXTERNAL', 'REGULATORY_OR_EXTERNAL_AUTHORITY', 'Regulator Alpha (synthetic)',
          'Synthetic: the regulator asked for the case summary.') as id`;
      await s.tx`select api.add_export_item(${r!.id}, 'CASE_SUMMARY', ${caseB})`;
      await s.tx`select api.add_export_recipient(${r!.id}, 'EXTERNAL', null, 'officer.alpha@example.test')`;
      const [p] = await s.tx<{ h: string }[]>`select api.preview_export(${r!.id}) ->> 'hash' as h`;
      await s.tx`select api.submit_export(${r!.id}, ${p!.h}, 'RESTRICTED'::core.classification_level)`;
      await s.as(actor);
      const real: ExportTargets = { case: caseB, request: r!.id };
      const random: ExportTargets = { case: randomUUID(), request: randomUUID() };
      const mismatches: string[] = [];
      for (const probe of EXPORT_PROBES) {
        const onReal = await outcomeOf(s, probe, real, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      for (const table of [
        "export_request",
        "export_item",
        "export_recipient",
        "export_approval",
        "restricted_export_approval",
      ]) {
        expect(await s.tx`select id from ${s.tx("exchange." + table)}`, table).toEqual([]);
      }
    });
  });
});

describe("IDOR: corrective actions (migration 1940)", () => {
  // An action on case 0002 owned by financeEmployee. None of these can see case 0002 or owns the action; employeeB
  // holds IMPLEMENTATION_OWNER too, and the committee secretary prepared the package the action comes from.
  const OUTSIDERS: UserKey[] = [
    "investigatorA",
    "committee",
    "committeeSecretary",
    "employeeB",
    "intake",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
    "legal",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    await scenario(async (s) => {
      await s.as("platformAdmin");
      for (const u of [USERS.financeEmployee, USERS.employeeB]) {
        await s.tx`select api.grant_role(${u}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner probe')`;
      }
      const { ic } = await committeeIds();
      const f = await draftPackage(s, ic, caseB);
      await s.as("committeeSecretary");
      await s.tx`select api.withdraw_recommendation_item(${f.sanction}, ${REASON})`;
      await voteOnPackage(s, f);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await s.tx`select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now(),
        'Chief Executive (synthetic)', 'MEMO-PROBE-0002', null, null)`;
      await s.as("caseManager");
      const [a] = await s.tx<{ id: string }[]>`
        select api.open_corrective_action(${f.corrective}, 'Synthetic: strengthen controls',
          'Synthetic: add a second approver.', ${USERS.financeEmployee}, current_date + 30) as id`;
      await s.as(actor);
      const real: CorrectiveActionTargets = { item: f.corrective, action: a!.id, case: caseB };
      const random: CorrectiveActionTargets = {
        item: randomUUID(),
        action: randomUUID(),
        case: randomUUID(),
      };
      const mismatches: string[] = [];
      for (const probe of CORRECTIVE_ACTION_PROBES) {
        const onReal = await outcomeOf(s, probe, real, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      for (const table of ["corrective_action", "corrective_action_event"]) {
        expect(await s.tx`select id from ${s.tx("decision." + table)}`, table).toEqual([]);
      }
    });
  });
});

describe("IDOR: continuity workbook imports (migration 1960)", () => {
  // A submitted batch on case 0002 staged by the case manager, prepared and recorded offline by investigator B. None of
  // these can see case 0002; the committee secretary and platform administrator hold other governance roles.
  const OUTSIDERS: UserKey[] = [
    "investigatorA",
    "committee",
    "committeeSecretary",
    "employeeB",
    "intake",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
    "legal",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const [b] = await s.tx<{ id: string; number: string }[]>`
        with c as (
          select id, case_number, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
          from case_mgmt.case_record where id = ${caseB}
        )
        select api.stage_bcp_import(
          jsonb_build_object('TEMPLATE_VERSION', 'BCP-1', 'WORKBOOK_ID', 'BCP-PROBE-2', 'CASE_ID', c.id::text,
                             'CASE_NUMBER', c.case_number, 'OFFLINE_FROM', c.at, 'PREPARED_BY', 'investigator.b@example.test'),
          ${SHA},
          jsonb_build_array(jsonb_build_object('sheet', '05_SUBJECTS', 'row_number', 3, 'has_formula', false, 'cells',
            jsonb_build_object('ROW_ID', 'BCP-PS1', 'ORIGINAL_EVENT_AT', c.at, 'RECORDED_OFFLINE_BY', 'investigator.b@example.test',
                               'DISPLAY_LABEL', 'Employee Probe (synthetic)', 'SUBJECT_CATEGORY', 'EMPLOYEE')))) as id,
          c.case_number as number
        from c`;
      const [row] = await s.tx<
        { id: string }[]
      >`select id from exchange.bcp_import_row where batch_id = ${b!.id}`;
      const [p] = await s.tx<{ h: string }[]>`select api.preview_bcp_import(${b!.id}) ->> 'hash' as h`;
      await s.tx`select api.submit_bcp_import(${b!.id}, ${p!.h})`;
      await s.as(actor);
      const real: BcpTargets = { case: caseB, caseNumber: b!.number, batch: b!.id, row: row!.id };
      const random: BcpTargets = {
        case: randomUUID(),
        caseNumber: "CDF-DEMO-2026-9999",
        batch: randomUUID(),
        row: randomUUID(),
      };
      const mismatches: string[] = [];
      for (const probe of BCP_PROBES) {
        const onReal = await outcomeOf(s, probe, real, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      for (const table of ["bcp_import_batch", "bcp_import_row", "bcp_provenance"]) {
        expect(await s.tx`select id from ${s.tx("exchange." + table)}`, table).toEqual([]);
      }
    });
  });
});

describe("IDOR: the official record of a committee workbook (migration 2115)", () => {
  // The Investigation Committee (IC seats, investigator A as deputy chair) on case 0002's referral: the secretary's
  // workbook of one meeting held on paper, its record declared, its minutes stored and marked, the deputy activated as
  // acting chair and the record submitted. None of these sits on the IC or imported it: a BCP approver and GRC
  // director, the case manager, the case's investigator, governance, audit, security, privacy and portal roles.
  const OUTSIDERS: UserKey[] = [
    "grcDirector",
    "caseManager",
    "investigatorB",
    "committee",
    "triage",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
    "employeeB",
    "intake",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    const { ic } = await committeeIds();
    await ownerScenario(async (s) => {
      await seat(s, ic, [...IC_SEATS, ["investigatorA", "DEPUTY_CHAIR"]]);
      const cp = await refer(s, ic, caseB);
      await s.as("platformAdmin");
      await s.tx`select api.authorize_committee_continuity_operator(${USERS.committeeSecretary}, ${cp},
                   'BCP-AUTH-PROBE-2115', ${REASON})`;
      const { batch, hash } = await stageOneMeetingWorkbook(s, cp, "BCP-PROBE-2115");
      const opened = await openRecord(s, batch);
      const lines = await s.tx<{ id: string; seat: string }[]>`
        select id, seat from exchange.bcp_record_roster where record_id = ${opened.record}`;
      await s.tx`select api.declare_committee_record_roster(${opened.record}, ${s.tx.json(
        lines.map((l) => ({
          roster_id: l.id,
          attendance: "ATTENDED",
          joined_late: false,
          left_early: false,
          signature_visible: true,
          signed_as_chair: l.seat === "CHAIR",
        })) as never,
      )}::jsonb)`;
      const { document } = await uploadMinutes(s, batch, opened.record);
      const [a] = await s.tx<{ id: string }[]>`
        select api.activate_record_acting_chair(${opened.record}, 'UNAVAILABLE',
          'Synthetic: the chair cannot review the record this week.', now() + interval '2 days') as id`;
      await s.tx`select api.submit_bcp_import(${batch}, ${hash})`;
      await s.as(actor);
      const real: RecordTargets = { batch, record: opened.record, document, activation: a!.id };
      const random: RecordTargets = {
        batch: randomUUID(),
        record: randomUUID(),
        document: randomUUID(),
        activation: randomUUID(),
      };
      const mismatches: string[] = [];
      for (const probe of RECORD_2115_PROBES) {
        const onReal = await outcomeOf(s, probe, real, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      for (const table of [
        "bcp_committee_record",
        "bcp_record_roster",
        "bcp_record_document",
        "bcp_record_decision",
        "bcp_record_attestation",
        "bcp_record_acting_chair",
        "bcp_import_batch",
        "bcp_import_row",
      ]) {
        expect(await s.tx`select id from ${s.tx("exchange." + table)}`, table).toEqual([]);
      }
    });
  });
});

describe("IDOR: exclusion records, Defence Packets and sanction extracts (migration 2050)", () => {
  // On case 0004 (investigator B; investigator A declared a conflict): an excluded item, and a released Defence Packet
  // for a subject linked to employee's portal account. Case 0004 is also referred to the Investigation Committee, whose
  // secretary asked for the subject's prior sanctions; the one from case B, restricted, awaits the GRC Director. None
  // of these sees case 0004, holds a seat or is the subject.
  const OUTSIDERS: UserKey[] = [
    "investigatorA",
    "committee",
    "employeeB",
    "intake",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    const ev = await import("../support/evidence");
    const case4 = await caseId("0004");
    const { ic, gc } = await committeeIds();
    await ownerScenario(async (s) => {
      await ev.setPacketPolicy(s);
      // The lead investigates case 0004 from before its referral: since migration 2080 (AMB-053) a member sitting on
      // an open committee proceeding of a case is not assigned to investigate it.
      await s.as("caseManager");
      await s.tx`select api.assign_case(${case4}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`;
      const p = await ev.priorFinalSanction(s, { ic, gc, caseB, requestingCase: case4 }, true);
      const extract = await ev.requestExtract(s, p);
      await s.asOwner();
      const [row] = await s.tx<{ id: string }[]>`
        select id from decision.sanction_extract_row where extract_id = ${extract}`;
      const kept = await ev.storeEvidence(s, "investigatorB", case4);
      const dropped = await ev.storeEvidence(s, "investigatorB", case4);
      await s.as("lead");
      const [x] = await s.tx<{ id: string }[]>`
        select api.exclude_evidence(${dropped.evidenceId}, ${REASON}) as id`;
      const n = await ev.defenceNotice(s, case4);
      const { packet, items } = await ev.packetWith(s, "lead", n.notice, [kept.versionId]);
      await ev.clearAsIs(s, "caseManager", items[0]!);
      await s.as("lead");
      await s.tx`select api.submit_defence_packet(${packet})`;

      await s.as(actor);
      const real: EvidenceHalfTargets = {
        exclusion: x!.id,
        notice: n.notice,
        packet,
        item: items[0]!,
        version: kept.versionId,
        committeeProceeding: p.committeeProceeding,
        subject: p.requestingSubject,
        extract,
        row: row!.id,
      };
      const random: EvidenceHalfTargets = {
        exclusion: randomUUID(),
        notice: randomUUID(),
        packet: randomUUID(),
        item: randomUUID(),
        version: randomUUID(),
        committeeProceeding: randomUUID(),
        subject: randomUUID(),
        extract: randomUUID(),
        row: randomUUID(),
      };
      const mismatches: string[] = [];
      for (const probe of EVIDENCE_HALF_PROBES) {
        const onReal = await outcomeOf(s, probe, real, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      expect(await s.tx`select api.my_sanction_extract_approvals() as v`).toEqual([{ v: [] }]);
      for (const table of [
        "evidence.exclusion",
        "grievance.defence_packet",
        "grievance.defence_packet_item",
        "grievance.defence_packet_review",
      ]) {
        expect(await s.tx`select id from ${s.tx(table)}`, table).toEqual([]);
      }
    });
  });
});

describe("IDOR: closure, reopening and the package-building read models (migration 2060)", () => {
  // With a synthetic closure authority (GRC_DIRECTOR): a closure request pending on case B, which is also referred to
  // the Investigation Committee; case 0004 closed by the authority's approval, with a reopening request pending; a
  // draft Defence Packet on case B. None of these sees case B or 0004, holds a seat or is the subject.
  const OUTSIDERS: UserKey[] = [
    "investigatorA",
    "committee",
    "employeeB",
    "intake",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    const ev = await import("../support/evidence");
    const cl = await import("../support/closure");
    const cm = await import("../support/committee");
    const case4 = await caseId("0004");
    const { ic } = await committeeIds();
    await ownerScenario(async (s) => {
      await cl.setClosureAuthority(s, "GRC_DIRECTOR");
      expect(await cl.closeWith(s, caseB)).toBe("AWAITING_APPROVAL");
      await s.as("caseManager");
      await s.tx`select api.transition_case(${case4}, 'START_SCREENING', null)`;
      expect(await cl.closeWith(s, case4)).toBe("AWAITING_APPROVAL");
      await s.asOwner();
      const requests = await s.tx<{ id: string; case_id: string }[]>`
        select id, case_id from case_mgmt.case_closure_request where status = 'AWAITING_APPROVAL'`;
      const closureRequest = requests.find((r) => r.case_id === caseB)!.id;
      await s.as("grcDirector");
      await s.tx`select api.decide_case_closure(${requests.find((r) => r.case_id === case4)!.id}, 'APPROVE', ${REASON})`;
      const reopeningRequest = await cl.requestReopeningOnEvidence(s, case4);
      await cm.seat(s, ic, cm.IC_SEATS);
      const cp = await cm.refer(s, ic, caseB);
      await ev.setPacketPolicy(s);
      const n = await ev.defenceNotice(s, caseB);
      const v = await ev.storeEvidence(s, "investigatorB", caseB);
      const { packet } = await ev.packetWith(s, "caseManager", n.notice, [v.versionId]);

      await s.as(actor);
      const real: ClosureTargets = {
        case: caseB,
        closureRequest,
        closedCase: case4,
        reopeningRequest,
        committeeProceeding: cp,
        packet,
      };
      const random: ClosureTargets = {
        case: randomUUID(),
        closureRequest: randomUUID(),
        closedCase: randomUUID(),
        reopeningRequest: randomUUID(),
        committeeProceeding: randomUUID(),
        packet: randomUUID(),
      };
      const mismatches: string[] = [];
      for (const probe of CLOSURE_2060_PROBES) {
        const onReal = await outcomeOf(s, probe, real, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      for (const table of ["case_mgmt.case_closure_request", "case_mgmt.case_closure"]) {
        expect(await s.tx`select id from ${s.tx(table)}`, table).toEqual([]);
      }
      // Reopening requests have no reader at all: they are read through api.case_closure_view only.
      await s.expectError("permission denied", (tx) => tx`select id from case_mgmt.case_reopening_request`);
      // Nothing moved: both requests are still pending, case B is active and 0004 closed.
      await s.asOwner();
      expect(
        await s.tx`select status from case_mgmt.case_closure_request where id = ${closureRequest}
                   union all select status from case_mgmt.case_reopening_request where id = ${reopeningRequest}`,
      ).toEqual([{ status: "AWAITING_APPROVAL" }, { status: "AWAITING_APPROVAL" }]);
      expect(
        await s.tx`select records_state from case_mgmt.case_record where id in (${caseB}, ${case4})
                   order by records_state`,
      ).toEqual([{ records_state: "ACTIVE" }, { records_state: "CLOSED" }]);
    });
  });
});

describe("IDOR: corrective action from preliminary review (migration 2070)", () => {
  // Under a synthetic PRELIMINARY_CORRECTIVE_ACTION_TYPES and authority rule: investigator B's NOT_SERIOUS
  // recommendation on case B, approved, with two corrective-action proposals, one approved by its authority (an action
  // could open from it) and one still awaiting its authority. None of these sees case B.
  const OUTSIDERS: UserKey[] = [
    "investigatorA",
    "committee",
    "employeeB",
    "intake",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    const { authorityRuleFor } = await import("../support/decision");
    const { setPreliminaryCorrectiveTypes } = await import("../support/preliminary");
    await ownerScenario(async (s) => {
      await setPreliminaryCorrectiveTypes(s, "CORRECTIVE_ACTION");
      await authorityRuleFor(s, "CORRECTIVE_ACTION");
      await s.as("investigatorB");
      const [r] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseB}, 'NOT_SERIOUS', ${REASON}) as id`;
      const proposals: string[] = [];
      for (let i = 0; i < 2; i++) {
        const [p] = await s.tx<{ id: string }[]>`
          select api.propose_preliminary_corrective_action(${r!.id}, 'CORRECTIVE_ACTION', ${REASON}) as id`;
        proposals.push(p!.id);
      }
      await s.as("grcDirector");
      await s.tx`select api.review_preliminary_recommendation(${r!.id}, 'ENDORSE', null, null)`;
      await s.as("grcSectorHead");
      await s.tx`select api.approve_preliminary_recommendation(${r!.id}, 'APPROVE', null, null)`;
      await s.as("caseManager");
      const [q] = await s.tx<{ authority_type: string }[]>`
        select authority_type from decision.preliminary_authority_requirement where proposal_id = ${proposals[0]!}`;
      await s.tx`select api.record_preliminary_authority_decision(${proposals[0]!}, ${q!.authority_type}, 'APPROVED',
        now(), 'Chief Executive (synthetic)', 'MEMO-PROBE-2070', ${REASON})`;

      await s.as(actor);
      const mismatches: string[] = [];
      for (const [label, proposal] of [
        ["approved", proposals[0]!],
        ["awaiting", proposals[1]!],
      ] as const) {
        const real: PreliminaryCorrectiveTargets = { recommendation: r!.id, proposal };
        const random: PreliminaryCorrectiveTargets = { recommendation: randomUUID(), proposal: randomUUID() };
        for (const probe of PRELIMINARY_2070_PROBES) {
          const onReal = await outcomeOf(s, probe, real, USERS[actor]);
          const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
          if (onReal !== probe.outcome || onRandom !== probe.outcome)
            mismatches.push(
              `${probe.fn} (${label}): real=${onReal} random=${onRandom} expected=${probe.outcome}`,
            );
        }
      }
      expect(mismatches).toEqual([]);
      for (const table of [
        "case_mgmt.preliminary_corrective_proposal",
        "decision.preliminary_authority_requirement",
        "decision.preliminary_authority_decision",
        "decision.corrective_action",
      ]) {
        expect(await s.tx`select case_id from ${s.tx(table)}`, table).toEqual([]);
      }
      // Nothing moved: one decision, no action, and no further proposal.
      await s.asOwner();
      expect(
        await s.tx`select (select count(*)::int from case_mgmt.preliminary_corrective_proposal) as proposals,
                          (select count(*)::int from decision.preliminary_authority_decision) as decisions,
                          (select count(*)::int from decision.corrective_action
                           where preliminary_proposal_id is not null) as actions`,
      ).toEqual([{ proposals: 2, decisions: 1, actions: 0 }]);
    });
  });
});

describe("IDOR: raised case conflicts (migration 2080)", () => {
  // On case B: investigator B raised a conflict about the GRC deputy, and the case manager one about investigator B
  // that the GRC Director upheld (so investigator B no longer sees case B either). None of these sees case B.
  const OUTSIDERS: UserKey[] = [
    "investigatorA",
    "committee",
    "employeeB",
    "intake",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    await ownerScenario(async (s) => {
      await s.as("investigatorB");
      const [open] = await s.tx<{ id: string }[]>`
        select api.raise_case_conflict(${caseB}, ${USERS.grcDeputy}, ${REASON}) as id`;
      await s.as("caseManager");
      const [upheld] = await s.tx<{ id: string }[]>`
        select api.raise_case_conflict(${caseB}, ${USERS.investigatorB}, ${REASON}) as id`;
      await s.as("grcDirector");
      await s.tx`select api.decide_case_conflict(${upheld!.id}, 'UPHELD', ${REASON})`;

      await s.as(actor);
      const mismatches: string[] = [];
      for (const [label, concern] of [
        ["open", open!.id],
        ["upheld", upheld!.id],
      ] as const) {
        const real: CaseConflictTargets = { case: caseB, concern };
        const random: CaseConflictTargets = { case: randomUUID(), concern: randomUUID() };
        for (const probe of CASE_CONFLICT_2080_PROBES) {
          const onReal = await outcomeOf(s, probe, real, USERS[actor]);
          const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
          if (onReal !== probe.outcome || onRandom !== probe.outcome)
            mismatches.push(
              `${probe.fn} (${label}): real=${onReal} random=${onRandom} expected=${probe.outcome}`,
            );
        }
      }
      expect(mismatches).toEqual([]);
      expect(await s.tx`select case_id from case_mgmt.case_conflict_concern`).toEqual([]);
      // Nothing moved: the open concern is still open and nothing else was raised.
      await s.asOwner();
      expect(
        await s.tx`select status, count(*)::int as n from case_mgmt.case_conflict_concern group by status
                   order by status`,
      ).toEqual([
        { status: "OPEN", n: 1 },
        { status: "UPHELD", n: 1 },
      ]);
    });
  });
});

describe("IDOR: case structure and corrections (migration 2090)", () => {
  // On case B: a RELATED link to case 0004, a subject with an open allegation, and the Investigation Committee's
  // approved minutes of a closed meeting with a correction in review. None of these sees case B.
  const OUTSIDERS: UserKey[] = [
    "investigatorA",
    "committee",
    "employeeB",
    "intake",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
  ];
  const VOTERS: UserKey[] = ["committeeChair", "legal", "legalB", "lead"];

  it.each(OUTSIDERS)("%s", async (actor) => {
    const { ic } = await committeeIds();
    await ownerScenario(async (s) => {
      const one = async (q: Promise<readonly Record<string, unknown>[]>) =>
        Object.values((await q)[0]!)[0] as string;
      await s.as("caseManager");
      const link = await one(
        s.tx`select api.link_cases(${caseB}, ${await caseId("0004")}, 'RELATED', ${REASON}) as id`,
      );
      const subject = await one(
        s.tx`select api.add_case_subject(${caseB}, 'Employee Omega (synthetic)', 'EMPLOYEE', null) as id`,
      );
      const allegation = await one(
        s.tx`select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: allegation against Employee Omega.',
          ${subject}, null, null) as id`,
      );
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await openWithPresent(s, f, VOTERS);
      const item = await openItem(s, f.meeting);
      for (const u of VOTERS) await vote(s, u, item, "APPROVE");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item}, null)`;
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      const minutes = await one(
        s.tx`select api.generate_minutes(${f.meeting}, 'Synthetic minutes narrative for the probe.') as id`,
      );
      for (const u of VOTERS) {
        await s.as(u);
        await s.tx`select api.review_minutes(${minutes}, 'APPROVE', null)`;
      }
      await s.as("committeeSecretary");
      const correction = await one(
        s.tx`select api.propose_minutes_correction(${minutes}, 'Synthetic: item one was approved.', ${REASON}) as id`,
      );

      await s.as(actor);
      const real: CaseStructureTargets = { case: caseB, link, allegation, subject, minutes, correction };
      const random: CaseStructureTargets = {
        case: randomUUID(),
        link: randomUUID(),
        allegation: randomUUID(),
        subject: randomUUID(),
        minutes: randomUUID(),
        correction: randomUUID(),
      };
      const mismatches: string[] = [];
      for (const probe of CASE_STRUCTURE_2090_PROBES) {
        const onReal = await outcomeOf(s, probe, real, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      for (const table of [
        "case_mgmt.case_link",
        "case_mgmt.subject_status_event",
        "case_mgmt.allegation_status_change",
        "case_mgmt.subject_correction",
        "case_mgmt.privacy_incident",
        "committee.minutes_correction",
        "records.record_annotation",
      ]) {
        expect(await s.tx`select id from ${s.tx(table)}`, table).toEqual([]);
      }
      // Nothing moved: the link is active, the allegation open, the subject identified, the correction unreviewed.
      await s.asOwner();
      expect(
        await s.tx`select (select count(*)::int from case_mgmt.case_link where ended_at is null) as links,
                          (select status from case_mgmt.allegation where id = ${allegation}) as allegation,
                          case_mgmt.subject_status(${subject}) as subject,
                          (select status from committee.minutes_correction where id = ${correction}) as correction,
                          (select count(*)::int from committee.minutes_correction_review) as reviews,
                          (select count(*)::int from records.record_annotation) as annotations`,
      ).toEqual([
        {
          links: 1,
          allegation: "OPEN",
          subject: "IDENTIFIED",
          correction: "IN_REVIEW",
          reviews: 0,
          annotations: 0,
        },
      ]);
    });
  });
});

describe("IDOR: people and access (migration 2100)", () => {
  // Case B flagged urgent by its investigator, and the GRC Sector Head's delegation to the GRC Deputy. None of these
  // sees case B or is party to the delegation (a role administrator is, so the platform admin is not an outsider).
  const OUTSIDERS: UserKey[] = [
    "investigatorA",
    "committee",
    "employeeB",
    "intake",
    "internalAudit",
    "soc",
    "dpo",
  ];

  it.each(OUTSIDERS)("%s", async (actor) => {
    await scenario(async (s) => {
      await s.as("investigatorB");
      await s.tx`select api.flag_case_urgent(${caseB}, ${REASON})`;
      await s.as("grcSectorHead");
      const [d] = await s.tx<{ id: string }[]>`
        select api.delegate_preliminary_approval(${USERS.grcDeputy}, null, now() + interval '7 days', 'DEMO-DEL-2100',
          ${REASON}) as id`;

      await s.as(actor);
      const real: PeopleAccessTargets = { case: caseB, delegation: d!.id };
      const random: PeopleAccessTargets = { case: randomUUID(), delegation: randomUUID() };
      const mismatches: string[] = [];
      for (const probe of PEOPLE_ACCESS_2100_PROBES) {
        const onReal = await outcomeOf(s, probe, real, USERS[actor]);
        const onRandom = await outcomeOf(s, probe, random, USERS[actor]);
        if (onReal !== probe.outcome || onRandom !== probe.outcome)
          mismatches.push(`${probe.fn}: real=${onReal} random=${onRandom} expected=${probe.outcome}`);
      }
      expect(mismatches).toEqual([]);
      for (const table of [
        "case_mgmt.case_urgent_flag",
        "iam.preliminary_approval_delegation",
        "exchange.bcp_workbook_revocation",
      ]) {
        expect(await s.tx`select id from ${s.tx(table)}`, table).toEqual([]);
      }
      // Nothing moved: the flag is still raised, the delegation unrevoked, no workbook revoked.
      await s.as("investigatorB");
      expect(
        await s.tx`select (select count(*)::int from case_mgmt.case_urgent_flag where cleared_at is null) as flags,
                          (select count(*)::int from exchange.bcp_workbook_revocation) as revocations`,
      ).toEqual([{ flags: 1, revocations: 0 }]);
      await s.as("grcSectorHead");
      expect(await s.tx`select revoked_at from iam.preliminary_approval_delegation`).toEqual([
        { revoked_at: null },
      ]);
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
      const delegation = await reporterDelegation(s, "B", caseB);
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
          {
            case: caseB,
            ...seeded,
            ...inside,
            ...purpose,
            ...domain,
            attachment,
            reporterDelegation: delegation,
          },
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

describe("CDF-205 T-AMB-142 (AMB-231): no api.* function accepts an acting-as user id", () => {
  // The only user ids a command takes are the people it acts on (grantee, appointee, assignee, owner,
  // delegate, reviewer). Who is acting always comes from the session (api._actor() / authz.current_user_id()).
  const TARGET_USER_ARGS = [
    "p_assigned_to",
    "p_assigned_user_id",
    "p_authority_id", // api.end_conflict_authority (2030): the appointment row ended, not a user; the actor is derived
    "p_case_owner_id",
    "p_delegate_id",
    "p_new_user_id",
    "p_owner_id",
    "p_recorder_id",
    "p_restricted_authority_id",
    "p_reviewer_id",
    "p_secretary_id",
    "p_subject_user_id", // api.raise_case_conflict (2080): the person the concern is about; the raiser is derived
    "p_user_id",
  ];

  async function inputArgs() {
    return admin<{ fn: string; arg: string; type: string; src: string }[]>`
      select n.nspname || '.' || p.proname as fn, a.name as arg, format_type(a.type, null) as type, p.prosrc as src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
           unnest(p.proargnames, coalesce(p.proallargtypes, p.proargtypes::oid[]),
                  coalesce(p.proargmodes, array_fill('i'::"char", array[cardinality(p.proargnames)])))
             as a(name, type, mode)
      where n.nspname in ('api', 'public_api') and p.proargnames is not null and a.mode in ('i', 'b')
      order by 1, 2`;
  }

  it("no argument names an actor, caller, impersonated or on-behalf-of user", async () => {
    const args = await inputArgs();
    expect(args.length).toBeGreaterThan(100);
    const unnamed = await admin`
      select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('api', 'public_api') and p.pronargs > 0 and p.proargnames is null`;
    expect(unnamed).toEqual([]); // every argument is named, so the name check below sees all of them
    const actingAs =
      /^p_(actor|acting|act_as|as_user|as_|on_behalf|behalf|caller|impersonat|current_user|me$|self|session_user)|_by(_id)?$/;
    expect(args.filter((a) => actingAs.test(a.arg)).map((a) => `${a.fn}(${a.arg})`)).toEqual([]);
  });

  it("the user ids commands accept are the pinned target arguments, and each such command derives its actor itself", async () => {
    const args = await inputArgs();
    const userLike =
      /(user|owner|delegate|recorder|reviewer|secretary|authority_id|assigned_to|actor|caller)/;
    const uuidUserArgs = [
      ...new Set(args.filter((a) => a.type === "uuid" && userLike.test(a.arg)).map((a) => a.arg)),
    ].sort();
    // A new user-id argument fails here until someone confirms it names a target, not the actor.
    expect(uuidUserArgs).toEqual(TARGET_USER_ARGS);
    const withTarget = [...new Set(args.filter((a) => TARGET_USER_ARGS.includes(a.arg)).map((a) => a.fn))];
    expect(withTarget.length).toBeGreaterThan(20);
    const deriving = /api\._actor\(\)|authz\.current_user_id\(\)/;
    const blind = withTarget.filter((fn) => !args.some((a) => a.fn === fn && deriving.test(a.src)));
    expect(blind).toEqual([]);
  });

  it("passing someone else's id as the target never makes them the actor", async () => {
    const target = await caseId("0001");
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      const [g] = await s.tx<{ id: string }[]>`
        select api.grant_case_access(${target}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null) as id`;
      await s.asOwner();
      const [grant] = await s.tx<{ user_id: string; granted_by: string }[]>`
        select user_id, granted_by from case_mgmt.case_access_grant where id = ${g!.id}`;
      expect(grant).toEqual({ user_id: USERS.grcDeputy, granted_by: USERS.caseManager });
      const events = await s.tx<{ actor_id: string }[]>`
        select actor_id from audit.audit_event where action = 'CASE_ACCESS_GRANTED' and object_id = ${g!.id}`;
      expect(events).toEqual([{ actor_id: USERS.caseManager }]);
      // Naming the case manager as the target does not lend their authority to an investigator.
      await s.as("investigatorA");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.grant_case_access(${target}, ${USERS.caseManager}, 'CASE', ${REASON}, null)`,
      );
    });
  });
});
