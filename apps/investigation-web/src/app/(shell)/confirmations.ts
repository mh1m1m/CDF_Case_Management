// Confirmation copy for controlled and irreversible acts (UX-031, O08 §08.6.4). The dialog only gates a command
// the user already chose; the database command and its rules are unchanged. All text comes from @cdf/i18n.
import type { MessageKey, Translator } from "@cdf/i18n";
import type { CDFConfirmation } from "@cdf/ui";

export type ConfirmAct =
  | "closeAtScreening"
  | "closeOutOfJurisdiction"
  | "closeCase"
  | "archiveCase"
  | "returnToJurisdiction"
  | "withdrawForm"
  | "cancelInterview"
  | "releaseHold"
  | "declareConflict"
  | "closeProceeding"
  | "referToCommittee"
  | "approveRestrictedReferral"
  // The committee's meeting and minutes (Phase 12 P12-2a, ADR-054).
  | "openMeeting"
  | "closeMeeting"
  | "cancelMeeting"
  | "declareMeetingConflict"
  | "raiseMeetingConcern"
  | "decideMeetingConcern"
  | "reverseMeetingConcern"
  | "openVoteItem"
  | "castVote"
  | "recuseForConflict"
  | "recordVoteNote"
  | "recordVoteForMember"
  | "closeVoteItem"
  | "castCastingVote"
  | "generateMinutes"
  | "reviewMinutes"
  | "remindReviewers"
  | "applyDeemedApproval"
  | "overruleObjection"
  // My Committees and the meeting's logistics (Phase 12 P12-2b, ADR-055).
  | "scheduleMeeting"
  | "amendProceedingSnapshot"
  | "excludeWitness"
  | "recordAccommodation"
  | "declareForParticipant"
  | "acknowledgeForParticipant"
  | "activateActingChair"
  | "activateActingSecretary"
  | "activateAlternateMember"
  // Recommendation packages, the meeting's invite and votes on findings (Phase 12 P12-2c, ADR-056).
  | "createRecommendationPackage"
  | "withdrawRecommendationItem"
  | "submitPackageForVote"
  | "openPackageVote"
  | "recordPackageAdoption"
  | "returnPackageToCommittee"
  | "resolveConflictTaint"
  | "inviteToMeeting"
  // Legal review and the authority's decision (Phase 12 P12-3a, ADR-057).
  | "requestLegalReview"
  | "cancelLegalReviewRequest"
  | "giveLegalOpinion"
  | "giveSupersedingLegalOpinion"
  | "submitToAuthority"
  | "recordAuthorityDecision"
  | "approveRestrictedLegalReview"
  // A corrective action under a superseded decision (Phase 12 P12-3b, ADR-058).
  | "disposeReAdopt"
  | "disposeModify"
  | "disposeWaive"
  | "disposeReplace"
  // The owner's completion, its verification and a reopening (Phase 12 P12-6a, ADR-058).
  | "submitActionCompletion"
  | "verifyActionCompletion"
  | "returnActionCompletion"
  | "reopenAction"
  // An export request (Phase 12 P12-6b-1, ADR-026).
  | "addExternalRecipient"
  | "submitExport"
  | "approveExport"
  | "rejectExport"
  | "consentToExport"
  | "refuseExport"
  | "generateExport"
  | "cancelExport"
  // A continuity workbook import (Phase 12 P12-6b-1, ADR-034).
  | "submitBcpImport"
  | "approveBcpImport"
  | "rejectBcpImport"
  | "applyBcpImport"
  | "cancelBcpImport"
  // The business calendar (Phase 12 P12-8a, ADR-051; DEC-F02).
  | "setBusinessCalendarDay"
  | "setBusinessWeekPattern"
  // The Administration pages' other forms (Phase 12 P12-8b, ADR-063).
  | "withdrawBusinessCalendarDay"
  | "createSector"
  | "revokeReferralDelegation"
  | "setNotificationRule"
  | "addExportRule"
  | "addExportPurpose"
  | "editExportPurpose"
  | "setCorrectiveActionPolicy"
  | "reviseCommitteeRuleSet";

/** Acts that move work forward rather than close, end or remove something: their confirm button is not red. */
const FORWARD_ACTS: ReadonlySet<ConfirmAct> = new Set([
  "openMeeting",
  "raiseMeetingConcern",
  "decideMeetingConcern",
  "reverseMeetingConcern",
  "openVoteItem",
  "castVote",
  "recordVoteNote",
  "recordVoteForMember",
  "castCastingVote",
  "generateMinutes",
  "reviewMinutes",
  "remindReviewers",
  "scheduleMeeting",
  "amendProceedingSnapshot",
  "recordAccommodation",
  "acknowledgeForParticipant",
  "activateActingChair",
  "activateActingSecretary",
  "activateAlternateMember",
  "createRecommendationPackage",
  "submitPackageForVote",
  "openPackageVote",
  "recordPackageAdoption",
  "resolveConflictTaint",
  "inviteToMeeting",
  "requestLegalReview",
  "giveLegalOpinion",
  "giveSupersedingLegalOpinion",
  "submitToAuthority",
  "recordAuthorityDecision",
  "approveRestrictedLegalReview",
  // The action carries on under the replacement decision; waiving or replacing it ends it.
  "disposeReAdopt",
  "disposeModify",
  // A completion goes forward to its verifier and, verified, ends the action's work; returning or reopening it sends
  // the work back.
  "submitActionCompletion",
  "verifyActionCompletion",
  // An export or an import goes forward to its approvers, is approved, and is sent or applied; a rejection, a refusal
  // or a cancellation ends it.
  "addExternalRecipient",
  "submitExport",
  "approveExport",
  "consentToExport",
  "generateExport",
  "submitBcpImport",
  "approveBcpImport",
  "applyBcpImport",
  // Recording a day or a working week sets the calendar up; neither ends or removes anything.
  "setBusinessCalendarDay",
  "setBusinessWeekPattern",
  // Adding a sector, a rule, a purpose or a version of a policy or of a committee's rules records something new; nothing
  // already recorded is removed. Withdrawing a calendar entry or revoking a delegation ends something, so those stay red.
  "createSector",
  "setNotificationRule",
  "addExportRule",
  "addExportPurpose",
  "editExportPurpose",
  "setCorrectiveActionPolicy",
  "reviseCommitteeRuleSet",
]);

/** Case transitions that close, archive or return a case. Any other step into Closure or Archive also confirms. */
const CASE_TRANSITIONS: Readonly<Record<string, ConfirmAct>> = {
  SCREEN_OUT: "closeAtScreening",
  OUT_OF_JURISDICTION: "closeOutOfJurisdiction",
  ARCHIVE_CASE: "archiveCase",
  REJECT_INVESTIGATION: "returnToJurisdiction",
};

export function transitionAct(code: string, toState: string): ConfirmAct | null {
  return (
    CASE_TRANSITIONS[code] ??
    (toState === "ARCHIVE" ? "archiveCase" : toState === "CLOSURE" ? "closeCase" : null)
  );
}

/** The verb that labels the act's trigger and its confirm button. */
export const actLabel = (t: Translator, act: ConfirmAct) => t(`confirm.acts.${act}.action` as MessageKey);

export function confirmation(
  t: Translator,
  act: ConfirmAct,
  facts?: CDFConfirmation["facts"],
): CDFConfirmation {
  const part = (name: string) => t(`confirm.acts.${act}.${name}` as MessageKey);
  // "Who is told" only where the act's copy says it (Phase 12 consequence preview, ADR-030).
  const notifiedKey = `confirm.acts.${act}.notified`;
  const notified = t(notifiedKey as MessageKey);
  // "Cancel" next to "Cancel interview" or "Cancel meeting" would be ambiguous, so those dialogs name what is kept.
  const dismissKey = `confirm.acts.${act}.dismiss`;
  const dismiss = t(dismissKey as MessageKey);
  return {
    title: part("title"),
    whatHappens: part("body"),
    undo: part("undo"),
    affected: part("affected"),
    ...(notified !== notifiedKey ? { notified } : {}),
    ...(facts?.length ? { facts } : {}),
    confirmLabel: actLabel(t, act),
    cancelLabel: dismiss !== dismissKey ? dismiss : t("confirm.cancel"),
    ...(FORWARD_ACTS.has(act) ? { tone: "primary" as const } : {}),
    labels: {
      whatHappens: t("confirm.whatHappens"),
      undo: t("confirm.canUndo"),
      affected: t("confirm.whoAffected"),
      notified: t("confirm.whoNotified"),
    },
  };
}
