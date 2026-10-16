// A packet as it was made (api.open_packet, the audited read; UX redesign Phase 12 P12-3a, ADR-057): what the
// committee's secretary sent to a legal reviewer, or submitted to the authority. A packet stores its content when it
// is made and never changes, so it names the persons concerned as stored then, in every label mode: DEC-02 governs
// labels in lists and rosters, not packet content (the coordinator, 2026-10-15). Every page that shows a packet first
// reads a read model that names it to the caller, and the database records each opening (PACKET_VIEWED).
import type { ReactNode } from "react";
import type {
  PacketFinding,
  PacketMinutes,
  PacketOpinion,
  PacketRecommendationItem,
  PacketSubject,
  PacketView,
} from "@cdf/contracts";
import { formatList, formatRecordDate, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFClassificationBadge,
  CDFConfiguredValue,
  CDFDescriptionList,
  type CDFValueSource,
} from "@cdf/ui";
import { allegationCategory, sanctionName } from "../committee-proceedings/labels";

const RULE_SOURCE: Record<
  NonNullable<PacketRecommendationItem["authorityRuleSourceStatus"]>,
  CDFValueSource
> = {
  OWNER_DEFAULT: "OWNER_DEFAULT",
  SOURCE_REQUIRED: "SOURCE_REQUIRED",
  APPROVED: "CONFIGURED",
};

/** A person concerned as the packet stored them: the name stored then, else "a person concerned" and the category. */
function personConcerned(t: Translator, s: PacketSubject | undefined): string {
  if (s?.label) return s.label;
  const someone = t("legalReviews.packet.aPersonConcerned");
  return s ? `${someone} · ${t.code("subjectCategory", s.category, "common.none")}` : someone;
}

export function PacketContent({ t, packet }: { t: Translator; packet: PacketView }) {
  const items = packet.items.filter((i): i is PacketRecommendationItem => i.kind === "RECOMMENDATION_ITEM");
  const findings = packet.items.filter((i): i is PacketFinding => i.kind === "FINDING");
  const minutes = packet.items.filter((i): i is PacketMinutes => i.kind === "MINUTES");
  const opinions = packet.items.filter((i): i is PacketOpinion => i.kind === "LEGAL_OPINION");
  // The persons concerned as the items stored them: a finding names its person through them.
  const subjects = new Map<string, PacketSubject>();
  for (const i of items)
    for (const s of i.subjects) if (!subjects.has(s.subjectId)) subjects.set(s.subjectId, s);
  // Items are numbered in the packet's order, which is the package's.
  const itemNo = new Map(items.map((i, k) => [i.sourceId, k + 1] as const));
  return (
    <>
      <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="packet-facts">
        <span>{t(`legalReviews.packet.purpose.${packet.purpose}` as MessageKey)}</span>
        <span aria-hidden="true">·</span>
        <span>
          {t("legalReviews.packet.madeOn", {
            date: isolate(formatRecordDate(t.locale, packet.createdAt, { withTime: true })),
          })}
        </span>
        <CDFClassificationBadge
          level={packet.classification}
          label={`${t("legalReviews.packet.classificationLabel")}: ${t.code("classification", packet.classification, "common.none")}`}
          testId="packet-classification"
        />
      </p>

      <CDFCard title={t("legalReviews.packet.itemsTitle")} testId="packet-items">
        {items.length === 0 ? (
          <p className="text-cdf-text-secondary">{t("legalReviews.packet.noItems")}</p>
        ) : (
          <ol className="grid gap-4">
            {items.map((item, k) => (
              <PacketItemView key={item.sourceId} t={t} n={k + 1} item={item} itemNo={itemNo} />
            ))}
          </ol>
        )}
      </CDFCard>

      {findings.length > 0 ? (
        <CDFCard title={t("legalReviews.packet.findingsTitle")} testId="packet-findings">
          <ol className="grid gap-4">
            {findings.map((f, k) => {
              const allegation = allegationCategory(t, f.allegationCategory);
              return (
                <li
                  key={f.sourceId}
                  className="border-b border-cdf-border pb-4 last:border-0 last:pb-0"
                  data-testid={`packet-finding-${k + 1}`}
                >
                  <h3 className="font-semibold">
                    {t("legalReviews.packet.finding", {
                      n: k + 1,
                      result: t.code("findingResult", f.result, "common.none"),
                    })}
                  </h3>
                  <p className="text-sm">
                    {f.subjectId
                      ? t("legalReviews.packet.findingAbout", {
                          allegation,
                          subject: isolate(personConcerned(t, subjects.get(f.subjectId))),
                        })
                      : allegation}
                  </p>
                  <p className="mb-2 text-sm text-cdf-text-secondary">
                    {t("legalReviews.packet.version", { n: f.versionNo })}
                  </p>
                  <h4 className="font-semibold">{t("legalReviews.packet.reasonsTitle")}</h4>
                  <p className="whitespace-pre-wrap break-words">
                    <bdi dir="auto">{f.rationale}</bdi>
                  </p>
                </li>
              );
            })}
          </ol>
        </CDFCard>
      ) : null}

      {minutes.length > 0 ? (
        <CDFCard title={t("legalReviews.packet.minutesTitle")} testId="packet-minutes">
          <ol className="grid gap-4">
            {minutes.map((m, k) => (
              <li
                key={m.sourceId}
                className="border-b border-cdf-border pb-4 last:border-0 last:pb-0"
                data-testid={`packet-minutes-${k + 1}`}
              >
                <h3 className="font-semibold">
                  {t("legalReviews.packet.minutes", { n: k + 1, version: m.versionNo })}
                </h3>
                <p className="mb-2 text-sm text-cdf-text-secondary">
                  {t.code("minutes.status", m.status, "common.none")}
                </p>
                <h4 className="font-semibold">{t("legalReviews.packet.narrativeTitle")}</h4>
                <p className="mb-2 whitespace-pre-wrap break-words">
                  <bdi dir="auto">{m.narrative}</bdi>
                </p>
                {m.voteItems.length > 0 ? (
                  <>
                    <h4 className="font-semibold">{t("legalReviews.packet.votesTitle")}</h4>
                    <ul className="grid gap-2">
                      {m.voteItems.map((v) => (
                        <li key={v.sequenceNo} className="text-sm">
                          <p className="break-words">
                            {t("legalReviews.packet.voteLine", {
                              n: v.sequenceNo,
                              title: isolate(v.title),
                              result: v.result
                                ? t.code("meetings.result", v.result, "common.none")
                                : t("legalReviews.packet.noResult"),
                            })}
                          </p>
                          <p className="text-cdf-text-secondary">
                            {t("legalReviews.packet.voteCounts", {
                              approve: v.approve,
                              reject: v.reject,
                              abstain: v.abstain,
                            })}
                            {v.decidedByCastingVote ? ` · ${t("legalReviews.packet.castingVote")}` : null}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </li>
            ))}
          </ol>
        </CDFCard>
      ) : null}

      {opinions.length > 0 ? (
        <CDFCard title={t("legalReviews.packet.opinionsTitle")} testId="packet-opinions">
          <ol className="grid gap-4">
            {opinions.map((o, k) => {
              const opinion = t(`legalReviews.opinion.${o.opinion}` as MessageKey);
              return (
                <li
                  key={o.sourceId}
                  className="border-b border-cdf-border pb-4 last:border-0 last:pb-0"
                  data-testid={`packet-opinion-${k + 1}`}
                  data-superseded={o.superseded ? "true" : "false"}
                >
                  <h3 className="flex flex-wrap items-center gap-2 font-semibold">
                    <span>
                      {o.revisionNo > 1
                        ? t("legalReviews.packet.revisionLine", {
                            round: o.packageRound,
                            n: o.revisionNo - 1,
                            opinion,
                          })
                        : t("legalReviews.packet.opinionLine", { round: o.packageRound, opinion })}
                    </span>
                    {o.superseded ? (
                      <CDFBadge tone="neutral">{t("legalReviews.packet.supersededBadge")}</CDFBadge>
                    ) : null}
                  </h3>
                  {o.opinionText ? (
                    <p className="mt-1 whitespace-pre-wrap break-words">
                      <bdi dir="auto">{o.opinionText}</bdi>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </CDFCard>
      ) : null}
    </>
  );
}

/** One adopted item as stored: what it recommends, about whom, and for the authority, who decides it. */
function PacketItemView({
  t,
  n,
  item,
  itemNo,
}: {
  t: Translator;
  n: number;
  item: PacketRecommendationItem;
  itemNo: ReadonlyMap<string, number>;
}) {
  const id = `packet-item-${n}`;
  const list = (values: string[]) => formatList(t.locale, values.map(isolate));
  const terms: { term: string; value: ReactNode }[] = [];
  if (item.sanctionCode || item.proposedSanctionText)
    terms.push({
      term: t("committeeProceedings.sanctionLabel"),
      value: item.sanctionCode ? (
        sanctionName(t, item.sanctionCode)
      ) : (
        <span className="inline-flex flex-wrap items-center gap-2">
          <bdi dir="auto">{item.proposedSanctionText}</bdi>
          {item.verificationStatus === "PROPOSED_UNVERIFIED" ? (
            <CDFBadge tone="warning" testId={`${id}-not-verified`}>
              {t("legalReviews.packet.notVerified")}
            </CDFBadge>
          ) : null}
        </span>
      ),
    });
  if (item.caseWide)
    terms.push({ term: t("committeeProceedings.scopeLabel"), value: t("committeeProceedings.caseWide") });
  if (item.subjects.length > 0)
    terms.push({
      term: t("committeeProceedings.subjectsLabel"),
      value: (
        <span data-testid={`${id}-subjects`}>{list(item.subjects.map((s) => personConcerned(t, s)))}</span>
      ),
    });
  if (item.allegations.length > 0)
    terms.push({
      term: t("committeeProceedings.allegationsLabel"),
      value: list(item.allegations.map((a) => allegationCategory(t, a.category))),
    });
  if (item.dependsOn.length > 0)
    terms.push({
      term: t("committeeProceedings.dependsOnLabel"),
      value: list(
        item.dependsOn.map((d) => {
          const k = itemNo.get(d);
          return k ? t("committeeProceedings.itemNumber", { n: k }) : t("committeeProceedings.withdrawnItem");
        }),
      ),
    });
  if (item.exclusivityGroup)
    terms.push({
      term: t("committeeProceedings.groupLabel"),
      value: <bdi dir="ltr">{item.exclusivityGroup}</bdi>,
    });
  if (item.requiresLegalJustification)
    terms.push({ term: t("committeeProceedings.legalTerm"), value: t("committeeProceedings.legalRequired") });
  // A packet for the authority stores who decides each item, and how settled the rule was then.
  if (item.requiredAuthorities.length > 0) {
    const who = list(item.requiredAuthorities.map((a) => t(`legalReviews.authorityType.${a}` as MessageKey)));
    const source = item.authorityRuleSourceStatus;
    terms.push({
      term: t("legalReviews.packet.decidedBy"),
      value: source ? (
        <CDFConfiguredValue
          value={who}
          source={RULE_SOURCE[source]}
          sourceLabel={t(`legalReviews.ruleSource.${source}` as MessageKey)}
          testId={`${id}-authority`}
        />
      ) : (
        who
      ),
    });
  }

  return (
    <li className="border-b border-cdf-border pb-4 last:border-0 last:pb-0" data-testid={id}>
      <h3 className="flex flex-wrap items-center gap-2 font-semibold">
        <span>
          {t("committeeProceedings.itemNumber", { n })} ·{" "}
          {t(`committeeProceedings.itemType.${item.itemType}` as MessageKey)}
        </span>
        {item.committeeResult ? (
          <CDFBadge
            tone={item.committeeResult === "APPROVED" ? "success" : "neutral"}
            testId={`${id}-result`}
          >
            {t(`committeeProceedings.itemResult.${item.committeeResult}` as MessageKey)}
          </CDFBadge>
        ) : null}
      </h3>
      <p className="mt-1 mb-2 whitespace-pre-wrap break-words" data-testid={`${id}-description`}>
        <bdi dir="auto">{item.description}</bdi>
      </p>
      {terms.length > 0 ? <CDFDescriptionList items={terms} /> : null}
    </li>
  );
}
