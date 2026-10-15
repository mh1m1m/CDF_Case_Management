// Words for the meeting and minutes pages (UX redesign Phase 12 P12-2a; ADR-054): names, seats and roles from what
// the read models give, never looked up anywhere else. A participant without an account (a person on the case) has no
// name here: the read model does not carry case people's names.
import type { CommitteeSeat, MeetingInviteeRole } from "@cdf/contracts";
import type { MessageKey, Translator } from "@cdf/i18n";

export interface Named {
  displayName: string | null;
  displayNameAr: string | null;
}

/** A participant's name in the page's language, or the words for a participant without an account. */
export function participantName(t: Translator, p: Named): string {
  const name = t.locale === "ar" && p.displayNameAr ? p.displayNameAr : p.displayName;
  return name ?? t("meetings.unnamed");
}

/** The seat a member holds, or the role an invitee was invited for. */
export function partLabel(
  t: Translator,
  p: { seat: CommitteeSeat | null; inviteeRole: MeetingInviteeRole | null },
): string {
  if (p.seat) return t(`committeeSeat.${p.seat}` as MessageKey);
  if (p.inviteeRole) return t(`meetings.inviteeRole.${p.inviteeRole}` as MessageKey);
  return "—";
}
