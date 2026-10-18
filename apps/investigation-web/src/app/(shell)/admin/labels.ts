// How the Administration pages name what their registers give them (UX redesign Phase 12 P12-8a; ADR-051's P12-8a
// amendment). A person is the directory's name in the reader's language, read in the reader's own context, else "an
// account"; the reader is "you". A governed value says where it comes from, so a provisional default never reads as
// CDF policy, and a value nobody has set says "not configured yet", never a guess. Dates are Riyadh dates.
import type { AccountName, AdminPeriodState, AdminSourceStatus } from "@cdf/contracts";
import { formatDate, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import type { CDFValueSource } from "@cdf/ui";
import { accountName } from "../legal-reviews/labels";

/** The calendar commands' own refusals first, then the shared ones. */
export const ADMIN_CODES = ["admin.codes", "codes"] as const;

/** A person a register names: the reader is "you"; anyone the directory does not show the reader is "an account". */
export function personName(
  t: Translator,
  people: readonly AccountName[],
  userId: string | null,
  me: string,
): string {
  if (!userId) return "—";
  if (userId === me) return t("admin.you");
  const found = people.find((p) => p.userId === userId);
  return found ? accountName(t, found) : t("admin.anAccount");
}

/** Where a governed value comes from, in CDFConfiguredValue's terms. */
export const SOURCE: Readonly<Record<AdminSourceStatus, CDFValueSource>> = {
  OWNER_DEFAULT: "OWNER_DEFAULT",
  SOURCE_REQUIRED: "SOURCE_REQUIRED",
  APPROVED: "CONFIGURED",
};

/** The words for a source, as the case structure pages say them. */
export const sourceLabel = (t: Translator, s: AdminSourceStatus): string =>
  t(`caseStructure.ruleSource.${s}` as MessageKey);

/** A Riyadh date, isolated for a sentence. */
export const day = (t: Translator, value: string): string => isolate(formatDate(t.locale, value));

/** An effective-dated row's period: "From 1 Jan 2026", or "1 Jan 2026 to 31 Dec 2026". */
export function period(t: Translator, from: string, to: string | null): string {
  return to === null
    ? t("admin.periodFrom", { from: day(t, from) })
    : t("admin.periodBetween", { from: day(t, from), to: day(t, to) });
}

/** In force, starts later or ended: said in words, never by colour alone. */
export const stateLabel = (t: Translator, s: AdminPeriodState): string => t(`admin.state.${s}` as MessageKey);

/** A tone for the state's badge; the words carry the meaning. */
export const stateTone = (s: AdminPeriodState): "success" | "info" | "neutral" =>
  s === "IN_FORCE" ? "success" : s === "SCHEDULED" ? "info" : "neutral";

/** The calendar date `days` after a date (YYYY-MM-DD), by the calendar alone: no clock, no time zone. */
export function plusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
