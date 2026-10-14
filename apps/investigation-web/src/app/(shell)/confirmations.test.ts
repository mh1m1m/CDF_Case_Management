// Every confirmation has its whole copy in both languages (UX-031; Phase 12 consequence preview, ADR-030): a missing
// message would show its key in the dialog. The meeting and minutes acts (P12-2a, ADR-054) are listed so that a
// rename in the catalogue fails here, not on the screen.
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
    ]) {
      expect(confirmation(t, act as ConfirmAct).notified, act).not.toMatch(/^No one/);
    }
    expect(confirmation(t, "castVote").tone).toBe("primary");
    expect(confirmation(t, "cancelMeeting").tone).toBeUndefined();
    expect(confirmation(t, "cancelMeeting").cancelLabel).toBe("Keep meeting");
  });
});
