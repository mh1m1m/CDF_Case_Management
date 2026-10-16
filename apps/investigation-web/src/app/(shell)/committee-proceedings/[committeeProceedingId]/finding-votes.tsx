// The votes on findings in the proceeding's meetings that the caller may deliberate in (read model R2; UX redesign
// Phase 12 P12-2c, ADR-056). A finding is its result, the allegation's category and the subject's position and category
// (a name only in DISPLAY_NAME mode), never its rationale. The vote itself, its count and its result are on the
// meeting's page, under that page's own rules; this list links there.
import Link from "next/link";
import type { FindingVoteView } from "@cdf/contracts";
import type { MessageKey, Translator } from "@cdf/i18n";
import { CDFCard, CDFStatusBadge } from "@cdf/ui";
import { allegationCategory, subjectName } from "../labels";

export function FindingVotes({
  t,
  votes,
  meetingNo,
}: {
  t: Translator;
  votes: readonly FindingVoteView[];
  /** The proceeding's meetings the caller may see, by id, with their number. */
  meetingNo: ReadonlyMap<string, number>;
}) {
  return (
    <CDFCard title={t("committeeProceedings.findingVotesTitle")} testId="proceeding-finding-votes">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("committeeProceedings.findingVotesIntro")}</p>
      {votes.length === 0 ? (
        <p className="text-cdf-text-secondary" data-testid="proceeding-no-finding-votes">
          {t("committeeProceedings.noFindingVotes")}
        </p>
      ) : (
        <ul className="grid gap-3" data-testid="proceeding-finding-vote-list">
          {votes.map((v) => {
            const m = meetingNo.get(v.meetingId);
            const f = v.finding;
            const id = `finding-vote-${m ?? "x"}-${v.sequenceNo}`;
            return (
              <li
                key={v.voteItemId}
                className="border-b border-cdf-border pb-3 last:border-0 last:pb-0"
                data-testid={id}
              >
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  {m ? (
                    <Link href={`/meetings/${v.meetingId}`} className="underline">
                      {t("committeeProceedings.findingVoteIn", { meeting: m, n: v.sequenceNo })}
                    </Link>
                  ) : (
                    <span>{t("meetings.voteNumber", { n: v.sequenceNo })}</span>
                  )}
                  <CDFStatusBadge domain="voteItem" status={v.status} testId={`${id}-status`}>
                    {t(`meetings.voteStatus.${v.status}` as MessageKey)}
                  </CDFStatusBadge>
                </p>
                <p className="text-sm">
                  {t("committeeProceedings.findingLine", {
                    result: t.code("findingResult", f.result, "common.none"),
                    allegation: allegationCategory(t, f.allegation.category),
                  })}
                </p>
                <p className="text-sm">
                  {f.subject ? <bdi>{subjectName(t, f.subject)}</bdi> : t("caseStructure.wholeAllegation")}
                </p>
                <p className="text-sm text-cdf-text-secondary">
                  {t(`committeeProceedings.findingRole.${f.proceedingRole}` as MessageKey)} ·{" "}
                  {t("caseStructure.version", { n: f.versionNo })}
                  {f.isCurrentVersion ? null : ` · ${t("committeeProceedings.laterVersion")}`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </CDFCard>
  );
}
