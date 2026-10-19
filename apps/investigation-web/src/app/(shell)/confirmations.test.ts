// Every confirmation has its whole copy in both languages (UX-031; Phase 12 consequence preview, ADR-030): a missing
// message would show its key in the dialog. The meeting and minutes acts (P12-2a, ADR-054), the committee and
// logistics acts (P12-2b, ADR-055), the package and invite acts (P12-2c, ADR-056), the legal review and authority
// acts (P12-3a, ADR-057), the corrective action's dispositions (P12-3b, ADR-058), its completion, verification and
// reopening (P12-6a, ADR-058), an export's and a continuity import's acts (P12-6b-1, ADR-026, ADR-034), the
// business calendar's (P12-8a, ADR-051) and the Administration pages' other forms (P12-8b, ADR-063) are listed so that
// a rename in the catalogue fails here, not on the screen.
import { describe, expect, it } from "vitest";
import { createTranslator, messagesFor, type Locale } from "@cdf/i18n";
import { confirmation, type ConfirmAct } from "./confirmations";

const MEETING_ACTS: ConfirmAct[] = [
  "openMeeting",
  "closeMeeting",
  "cancelMeeting",
  "declareMeetingConflict",
  "raiseMeetingConcern",
  "decideMeetingConcern",
  "reverseMeetingConcern",
  "openVoteItem",
  "castVote",
  "recuseForConflict",
  "recordVoteNote",
  "recordVoteForMember",
  "closeVoteItem",
  "castCastingVote",
  "generateMinutes",
  "reviewMinutes",
  "remindReviewers",
  "applyDeemedApproval",
  "overruleObjection",
  // My Committees and the meeting's logistics (P12-2b, ADR-055).
  "scheduleMeeting",
  "amendProceedingSnapshot",
  "excludeWitness",
  "recordAccommodation",
  "declareForParticipant",
  "acknowledgeForParticipant",
  "activateActingChair",
  "activateActingSecretary",
  "activateAlternateMember",
  // Recommendation packages, the meeting's invite and votes on findings (P12-2c, ADR-056).
  "createRecommendationPackage",
  "withdrawRecommendationItem",
  "submitPackageForVote",
  "openPackageVote",
  "recordPackageAdoption",
  "returnPackageToCommittee",
  "resolveConflictTaint",
  "inviteToMeeting",
  // Legal review and the authority's decision (P12-3a, ADR-057).
  "requestLegalReview",
  "cancelLegalReviewRequest",
  "giveLegalOpinion",
  "giveSupersedingLegalOpinion",
  "submitToAuthority",
  "recordAuthorityDecision",
  "approveRestrictedLegalReview",
  // A corrective action under a superseded decision (P12-3b, ADR-058).
  "disposeReAdopt",
  "disposeModify",
  "disposeWaive",
  "disposeReplace",
  // The owner's completion, its verification and a reopening (P12-6a, ADR-058).
  "submitActionCompletion",
  "verifyActionCompletion",
  "returnActionCompletion",
  "reopenAction",
  // An export request (P12-6b-1, ADR-026).
  "addExternalRecipient",
  "submitExport",
  "approveExport",
  "rejectExport",
  "consentToExport",
  "refuseExport",
  "generateExport",
  "cancelExport",
  // A continuity workbook import (P12-6b-1, ADR-034).
  "submitBcpImport",
  "approveBcpImport",
  "rejectBcpImport",
  "applyBcpImport",
  "cancelBcpImport",
  // The business calendar (P12-8a, ADR-051; DEC-F02).
  "setBusinessCalendarDay",
  "setBusinessWeekPattern",
  // The Administration pages' other forms (P12-8b, ADR-063).
  "withdrawBusinessCalendarDay",
  "createSector",
  "revokeReferralDelegation",
  "setNotificationRule",
  "addExportRule",
  "addExportPurpose",
  "editExportPurpose",
  "setCorrectiveActionPolicy",
  "reviseCommitteeRuleSet",
];

/** The Administration acts of P12-8b: none of their commands enqueues a notice (ADR-063). */
const ADMIN_FORM_ACTS: ConfirmAct[] = [
  "withdrawBusinessCalendarDay",
  "createSector",
  "revokeReferralDelegation",
  "setNotificationRule",
  "addExportRule",
  "addExportPurpose",
  "editExportPurpose",
  "setCorrectiveActionPolicy",
  "reviseCommitteeRuleSet",
];

describe("confirmations", () => {
  const acts = Object.keys(messagesFor("en").confirm.acts) as ConfirmAct[];

  it("lists every meeting and minutes act in the catalogue", () => {
    expect(acts).toEqual(expect.arrayContaining(MEETING_ACTS));
  });

  for (const locale of ["ar", "en"] as Locale[]) {
    it(`each act has its title, consequences, undo, who is affected and its button in ${locale}`, () => {
      const t = createTranslator(locale);
      for (const act of acts) {
        const c = confirmation(t, act);
        for (const text of [c.title, c.whatHappens, c.undo, c.affected, c.confirmLabel, c.cancelLabel]) {
          expect(text, `${locale} ${act}`).not.toMatch(/^confirm\./);
          expect(text.trim().length, `${locale} ${act}`).toBeGreaterThan(0);
        }
        if (c.notified !== undefined) expect(c.notified, `${locale} ${act}`).not.toMatch(/^confirm\./);
      }
    });
  }

  it("a meeting notice is said wherever one is sent, and moving work forward is not shown as danger", () => {
    const t = createTranslator("en");
    // The acts whose commands notify someone (the notification engine, 2030 section 4.3, and 1920).
    for (const act of [
      "cancelMeeting",
      "raiseMeetingConcern",
      "openVoteItem",
      "generateMinutes",
      "remindReviewers",
      "scheduleMeeting",
      // P12-2c: a package's vote tells the members who may cast it; an invited account is told it is invited.
      "openPackageVote",
      "inviteToMeeting",
      // P12-3a: the reviewer of a new request is told it is assigned to them (1920, legal_review_request_notify).
      "requestLegalReview",
      // P12-3b: the owner hears their action changed, and a new action's owner that it is assigned (2090).
      "disposeModify",
      "disposeWaive",
      "disposeReplace",
      // P12-6a: a completion goes to the case's corrective-action managers; a return or a reopening to the owner
      // (1940, 2040).
      "submitActionCompletion",
      "returnActionCompletion",
      "reopenAction",
      // P12-6b-1: a submission asks its approvers, a decision tells the requester or importer (1930, 1960), and
      // generating sends the export to its recipients; applying an import generates its restore notices (AMB-210).
      "submitExport",
      "approveExport",
      "rejectExport",
      "consentToExport",
      "refuseExport",
      "generateExport",
      "submitBcpImport",
      "approveBcpImport",
      "rejectBcpImport",
      "applyBcpImport",
    ]) {
      expect(confirmation(t, act as ConfirmAct).notified, act).not.toMatch(/^No one/);
    }
    // The other package commands notify no one (2030 section 4.3 sends no notice for them).
    for (const act of [
      "createRecommendationPackage",
      "withdrawRecommendationItem",
      "submitPackageForVote",
      "recordPackageAdoption",
      "returnPackageToCommittee",
      "resolveConflictTaint",
      // Nor do the legal review and authority commands but the request (1920 notifies only a new request).
      "cancelLegalReviewRequest",
      "giveLegalOpinion",
      "giveSupersedingLegalOpinion",
      "submitToAuthority",
      "recordAuthorityDecision",
      "approveRestrictedLegalReview",
      // Re-adopting an action changes nothing its owner sees, so no one is told (2090).
      "disposeReAdopt",
      // A verified completion tells no one (1940).
      "verifyActionCompletion",
      // Nor does adding an address to a draft export, or cancelling an export or an import (1930, 1960).
      "addExternalRecipient",
      "cancelExport",
      "cancelBcpImport",
      // Nor does recording a day or a working week in the business calendar (2030 sends no notice for them).
      "setBusinessCalendarDay",
      "setBusinessWeekPattern",
      // Nor does any other Administration form (P12-8b): their commands write no notice.
      ...ADMIN_FORM_ACTS,
    ] as ConfirmAct[]) {
      expect(confirmation(t, act).notified, act).toMatch(/^No one/);
    }
    expect(confirmation(t, "withdrawRecommendationItem").tone).toBeUndefined();
    expect(confirmation(t, "returnPackageToCommittee").tone).toBeUndefined();
    expect(confirmation(t, "openPackageVote").tone).toBe("primary");
    // Adding a member after referral sends no invitation: they join the meetings scheduled from then on (2085).
    expect(confirmation(t, "amendProceedingSnapshot").notified).toMatch(/^No one/);
    expect(confirmation(t, "scheduleMeeting").tone).toBe("primary");
    expect(confirmation(t, "excludeWitness").tone).toBeUndefined();
    expect(confirmation(t, "castVote").tone).toBe("primary");
    expect(confirmation(t, "cancelMeeting").tone).toBeUndefined();
    expect(confirmation(t, "cancelMeeting").cancelLabel).toBe("Keep meeting");
    // Cancelling a request is not shown as moving work forward, and its dialog names what is kept.
    expect(confirmation(t, "cancelLegalReviewRequest").tone).toBeUndefined();
    expect(confirmation(t, "cancelLegalReviewRequest").cancelLabel).toBe("Keep the request");
    for (const act of [
      "requestLegalReview",
      "giveLegalOpinion",
      "giveSupersedingLegalOpinion",
      "submitToAuthority",
      "recordAuthorityDecision",
      "approveRestrictedLegalReview",
      "disposeReAdopt",
      "disposeModify",
      "submitActionCompletion",
      "verifyActionCompletion",
      "addExternalRecipient",
      "submitExport",
      "approveExport",
      "consentToExport",
      "generateExport",
      "submitBcpImport",
      "approveBcpImport",
      "applyBcpImport",
      "setBusinessCalendarDay",
      "setBusinessWeekPattern",
      // Adding a sector, a rule, a purpose or a version records something new and removes nothing (P12-8b).
      "createSector",
      "setNotificationRule",
      "addExportRule",
      "addExportPurpose",
      "editExportPurpose",
      "setCorrectiveActionPolicy",
      "reviseCommitteeRuleSet",
    ] as ConfirmAct[])
      expect(confirmation(t, act).tone, act).toBe("primary");
    // Waiving an action, or replacing it with a new one, ends it: not shown as moving work forward. Nor is sending a
    // completion back to the owner, or reopening a completed action.
    for (const act of [
      "disposeWaive",
      "disposeReplace",
      "returnActionCompletion",
      "reopenAction",
      // Rejecting, refusing or cancelling an export or an import ends it.
      "rejectExport",
      "refuseExport",
      "cancelExport",
      "rejectBcpImport",
      "cancelBcpImport",
      // Withdrawing a calendar entry or revoking a delegation ends it (P12-8b).
      "withdrawBusinessCalendarDay",
      "revokeReferralDelegation",
    ] as ConfirmAct[])
      expect(confirmation(t, act).tone, act).toBeUndefined();
    expect(confirmation(t, "cancelExport").cancelLabel).toBe("Keep the request");
    expect(confirmation(t, "cancelBcpImport").cancelLabel).toBe("Keep the import");
  });
});
