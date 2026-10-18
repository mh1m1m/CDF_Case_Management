// A committee's rule set in words (Phase 12 P12-2b, ADR-055; P12-8a). The committee page shows the rules in force and
// a proceeding's copy of them; the administrator's committee register shows every version, with the options only the
// registry needs (`extra`). A configured rule is never presented as CDF policy, so its source is always said.
import type { ReactNode } from "react";
import type { CommitteeRules, RuleSourceStatus } from "@cdf/contracts";
import { formatDate, formatDays, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFConfiguredValue, CDFDescriptionList, type CDFValueSource } from "@cdf/ui";

export const RULE_SOURCE: Record<RuleSourceStatus, CDFValueSource> = {
  OWNER_DEFAULT: "OWNER_DEFAULT",
  SOURCE_REQUIRED: "SOURCE_REQUIRED",
  APPROVED: "CONFIGURED",
};

/**
 * A rule set as the committee holds it now, or as a proceeding copied it at referral (rule 7: a configured rule, never
 * presented as CDF policy, so its source is said). A copy taken before a rule existed lacks it: `missing` says so.
 * `since` replaces the "in force since" line, for a version that is not in force.
 */
export function RulesList({
  t,
  rules: r,
  missing,
  testId,
  since,
  extra = [],
}: {
  t: Translator;
  rules: CommitteeRules;
  missing: string;
  testId: string;
  since?: string;
  extra?: { term: string; value: ReactNode }[];
}) {
  const yesNo = (v: boolean | null) => (v === null ? missing : v ? t("common.yes") : t("common.no"));
  const items: { term: string; value: ReactNode }[] = [
    {
      term: t("caseStructure.quorum"),
      value: t(`quorumType.${r.quorumType}` as MessageKey, { value: r.quorumValue ?? "—" }),
    },
    {
      term: t("committees.minimumNotice"),
      value:
        r.minimumNoticeDays === null ? t("committees.noNotice") : formatDays(t.locale, r.minimumNoticeDays),
    },
    { term: t("caseStructure.castingVote"), value: yesNo(r.castingVoteEnabled) },
    { term: t("committees.actingChairCastingVote"), value: yesNo(r.actingChairCastingVote) },
    {
      term: t("committees.ballot"),
      value: r.ballotSecrecy ? t(`committees.ballotValue.${r.ballotSecrecy}` as MessageKey) : missing,
    },
    { term: t("committees.voteRevision"), value: yesNo(r.voteRevisionAllowed) },
    { term: t("committees.dissentNote"), value: yesNo(r.dissentNoteAllowed) },
    {
      term: t("caseStructure.minutesReview"),
      value:
        r.minutesReviewBusinessDays === null
          ? missing
          : t("caseStructure.minutesDays", { days: r.minutesReviewBusinessDays }),
    },
    { term: t("caseStructure.deemedApproval"), value: yesNo(r.deemedApprovalEnabled) },
    { term: t("committees.objectionBlocksDeemed"), value: yesNo(r.minutesObjectionBlocksDeemed) },
    {
      term: t("committees.conflictDecider"),
      value: r.conflictDecider
        ? t(`committees.conflictDeciderValue.${r.conflictDecider}` as MessageKey)
        : missing,
    },
    ...extra,
  ];
  const when =
    since ??
    (r.effectiveFrom
      ? t("committees.inForceSince", { date: isolate(formatDate(t.locale, r.effectiveFrom)) })
      : "");
  return (
    <div data-testid={testId}>
      {r.sourceStatus || when ? (
        <p className="mb-2 text-sm">
          {r.sourceStatus ? (
            <CDFConfiguredValue
              value={when}
              source={RULE_SOURCE[r.sourceStatus]}
              sourceLabel={t(`caseStructure.ruleSource.${r.sourceStatus}` as MessageKey)}
              testId={`${testId}-source`}
            />
          ) : (
            when
          )}
        </p>
      ) : null}
      <CDFDescriptionList stacked items={items} />
    </div>
  );
}
