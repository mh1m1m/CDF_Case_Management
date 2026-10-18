// Administration › Committees (UX redesign Phase 12 P12-8a; ADR-051's P12-8a amendment). The committee administrator's
// register: each committee's seats, corrections, rule-set versions, independent conflict authorities and changes of
// status, as recorded, and who decides each kind of recommendation (api.authority_rule_coverage). Read in the
// administrator's own context, after the database confirms COMMITTEE_ADMIN, from tables whose row-level security returns
// exactly this register; anyone else gets the uniform not-found, recorded as ACCESS_DENIED. Read only: appointment forms
// wait (coordinator ruling F5), and conflict authorities change only with dual control (DEC-12).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  COMMITTEE_SEATS,
  type AdminCommittee,
  type AdminCommitteesPage,
  type AdminPeriodState,
  type AdminRuleSet,
  type CommitteeRules,
  type PackageAuthorityRule,
} from "@cdf/contracts";
import { formatDays, formatList, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFBadge, CDFCard, CDFConfiguredValue, CDFIdentifier, CDFTable, type CDFValueSource } from "@cdf/ui";
import { administrationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { RulesList } from "../../committees/rules-list";
import { AdminFrame } from "../admin-frame";
import { SOURCE, day, period, personName, sourceLabel, stateLabel, stateTone } from "../labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("admin.views.committees") };
}

const STATE_ORDER: Record<AdminPeriodState, number> = { IN_FORCE: 0, SCHEDULED: 1, ENDED: 2 };

/** The committee's name where the platform has one (the registry's codes), else its code. */
function committeeName(t: Translator, code: string): string {
  const key = `committeeName.${code}`;
  const name = t(key as MessageKey);
  return name === key ? code : name;
}

export default async function AdminCommitteesRegister() {
  const { actor, ctx } = await requireActor();
  const page = await administrationService().committees(ctx, actor);
  if (!page) notFound();
  const t = await getTranslator();
  return (
    <AdminFrame t={t} actor={actor} view="committees" intro={t("admin.committees.intro")}>
      {page.committees.length === 0 ? (
        <p className="mb-6 text-cdf-text-secondary">{t("admin.committees.none")}</p>
      ) : null}
      {page.committees.map((c) => (
        <CommitteeCard key={c.committeeId} t={t} page={page} committee={c} me={actor.userId} />
      ))}
      <CoverageCard t={t} rules={page.coverage} />
      <p className="text-sm text-cdf-text-secondary" data-testid="admin-committees-later">
        {t("admin.committees.later")}
      </p>
    </AdminFrame>
  );
}

function CommitteeCard({
  t,
  page,
  committee: c,
  me,
}: {
  t: Translator;
  page: AdminCommitteesPage;
  committee: AdminCommittee;
  me: string;
}) {
  const name = committeeName(t, c.code);
  const who = (id: string | null) => personName(t, page.people, id, me);
  const seats = page.seats
    .filter((s) => s.committeeId === c.committeeId)
    .sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        COMMITTEE_SEATS.indexOf(a.seat) - COMMITTEE_SEATS.indexOf(b.seat) ||
        a.effectiveFrom.localeCompare(b.effectiveFrom),
    );
  const corrections = page.corrections.filter((x) => x.committeeId === c.committeeId);
  const versions = page.ruleSets.filter((r) => r.committeeId === c.committeeId);
  const current = versions.filter((r) => r.state !== "ENDED");
  const ended = versions.filter((r) => r.state === "ENDED").reverse();
  const authorities = page.authorities.filter((a) => a.committeeId === c.committeeId);
  const changes = page.statusChanges.filter((x) => x.committeeId === c.committeeId);
  const testId = `admin-committee-${c.code}`;
  return (
    <CDFCard
      title={name}
      testId={testId}
      actions={
        <CDFBadge tone={c.isActive ? "success" : "neutral"} testId={`${testId}-status`}>
          {t(c.isActive ? "admin.active" : "admin.inactive")}
        </CDFBadge>
      }
    >
      <section className="mb-6" aria-labelledby={`${testId}-seats`}>
        <h3 id={`${testId}-seats`} className="mb-2 font-semibold">
          {t("admin.committees.seatsTitle")}
        </h3>
        <CDFTable
          caption={t("admin.committees.seatsCaption", { committee: isolate(name) })}
          testId={`${testId}-seat-list`}
          rows={seats}
          rowKey={(s) => s.membershipId}
          empty={t("admin.committees.noSeats")}
          columns={[
            { header: t("admin.columns.holder"), cell: (s) => <bdi>{who(s.userId)}</bdi> },
            { header: t("admin.committees.seat"), cell: (s) => t(`committeeSeat.${s.seat}` as MessageKey) },
            { header: t("admin.columns.period"), cell: (s) => period(t, s.effectiveFrom, s.effectiveTo) },
            {
              header: t("admin.columns.state"),
              cell: (s) => <CDFBadge tone={stateTone(s.state)}>{stateLabel(t, s.state)}</CDFBadge>,
            },
            {
              header: t("admin.columns.reference"),
              cell: (s) => <bdi className="break-words">{s.appointmentReference}</bdi>,
            },
            {
              header: t("admin.columns.recorded"),
              cell: (s) => (
                <>
                  {t("admin.recordedBy", { name: isolate(who(s.appointedBy)), date: day(t, s.appointedAt) })}
                  {s.endedAt ? (
                    <p className="text-cdf-text-secondary">
                      {t("admin.committees.ended", {
                        name: isolate(who(s.endedBy)),
                        date: day(t, s.endedAt),
                      })}
                      {s.endReason ? (
                        <>
                          {" "}
                          <bdi>{s.endReason}</bdi>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </>
              ),
            },
          ]}
        />
      </section>

      <section className="mb-6" aria-labelledby={`${testId}-corrections`}>
        <h3 id={`${testId}-corrections`} className="mb-2 font-semibold">
          {t("admin.committees.correctionsTitle")}
        </h3>
        {corrections.length === 0 ? (
          <p className="text-cdf-text-secondary">{t("admin.committees.noCorrections")}</p>
        ) : (
          <ul className="grid gap-2" data-testid={`${testId}-corrections-list`}>
            {corrections.map((x) => {
              const seat = page.seats.find((s) => s.membershipId === x.membershipId);
              return (
                <li key={x.correctionId} className="rounded-cdf-md border border-cdf-border p-3">
                  <p className="font-semibold">
                    {t(`admin.committees.correctionKind.${x.kind}` as MessageKey)}
                    {seat ? (
                      <>
                        {" · "}
                        <bdi>{who(seat.userId)}</bdi>
                        {" · "}
                        {t(`committeeSeat.${seat.seat}` as MessageKey)}
                      </>
                    ) : null}
                  </p>
                  <p className="text-sm text-cdf-text-secondary">
                    {t("admin.recordedBy", {
                      name: isolate(who(x.correctedBy)),
                      date: day(t, x.correctedAt),
                    })}
                  </p>
                  <p className="whitespace-pre-wrap break-words">
                    <bdi>{x.reason}</bdi>
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mb-6" aria-labelledby={`${testId}-rules`}>
        <h3 id={`${testId}-rules`} className="mb-2 font-semibold">
          {t("admin.committees.rulesTitle")}
        </h3>
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.committees.rulesIntro")}</p>
        {current.length === 0 ? (
          <p className="text-cdf-text-secondary">{t("admin.committees.noRules")}</p>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          {current.map((r) => (
            <div
              key={r.ruleSetId}
              className="rounded-cdf-md border border-cdf-border p-3"
              data-testid={`${testId}-rules-${r.state === "IN_FORCE" ? "in-force" : r.ruleSetId}`}
              data-state={r.state}
            >
              <p className="mb-2 font-semibold">
                <CDFBadge tone={stateTone(r.state)}>{stateLabel(t, r.state)}</CDFBadge>
              </p>
              <RulesList
                t={t}
                rules={asRules(r)}
                missing={t("admin.notSet")}
                testId={`${testId}-rules-${r.ruleSetId}-list`}
                since={
                  r.state === "SCHEDULED"
                    ? t("admin.committees.startsOn", { date: day(t, r.effectiveFrom) })
                    : undefined
                }
                extra={extraRules(t, r, c.kind === "GRIEVANCE")}
              />
              {r.reason ? (
                <p className="mt-2 text-sm whitespace-pre-wrap break-words">
                  <span className="font-semibold">{t("admin.committees.versionReason")}</span>{" "}
                  <bdi>{r.reason}</bdi>
                </p>
              ) : null}
            </div>
          ))}
        </div>
        {ended.length > 0 ? (
          <details className="mt-3" data-testid={`${testId}-rules-ended`}>
            <summary className="cursor-pointer font-semibold">
              {t("admin.committees.endedVersions", { count: ended.length })}
            </summary>
            <ul className="mt-2 grid gap-2 text-sm">
              {ended.map((r) => (
                <li key={r.ruleSetId}>
                  {period(t, r.effectiveFrom, r.effectiveTo)} · {sourceLabel(t, r.sourceStatus)}
                  {r.reason ? (
                    <p className="text-cdf-text-secondary whitespace-pre-wrap break-words">
                      <bdi>{r.reason}</bdi>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="mb-6" aria-labelledby={`${testId}-authorities`}>
        <h3 id={`${testId}-authorities`} className="mb-2 font-semibold">
          {t("admin.committees.authoritiesTitle")}
        </h3>
        <p className="mb-2 text-sm text-cdf-text-secondary">{t("admin.committees.authoritiesIntro")}</p>
        <CDFTable
          caption={t("admin.committees.authoritiesCaption", { committee: isolate(name) })}
          testId={`${testId}-authority-list`}
          rows={authorities}
          rowKey={(a) => a.authorityId}
          empty={t("admin.committees.noAuthorities")}
          columns={[
            { header: t("admin.columns.holder"), cell: (a) => <bdi>{who(a.userId)}</bdi> },
            { header: t("admin.columns.period"), cell: (a) => period(t, a.effectiveFrom, a.effectiveTo) },
            {
              header: t("admin.columns.state"),
              cell: (a) => <CDFBadge tone={stateTone(a.state)}>{stateLabel(t, a.state)}</CDFBadge>,
            },
            {
              header: t("admin.columns.reference"),
              cell: (a) => <bdi className="break-words">{a.appointmentReference}</bdi>,
            },
            {
              header: t("admin.columns.source"),
              cell: (a) => (
                <CDFConfiguredValue
                  value=""
                  source={SOURCE[a.sourceStatus]}
                  sourceLabel={sourceLabel(t, a.sourceStatus)}
                />
              ),
            },
            {
              header: t("admin.columns.recorded"),
              cell: (a) =>
                t("admin.recordedBy", { name: isolate(who(a.appointedBy)), date: day(t, a.appointedAt) }),
            },
          ]}
        />
      </section>

      <section aria-labelledby={`${testId}-status-changes`}>
        <h3 id={`${testId}-status-changes`} className="mb-2 font-semibold">
          {t("admin.committees.statusTitle")}
        </h3>
        {changes.length === 0 ? (
          <p className="text-cdf-text-secondary">{t("admin.committees.noStatusChanges")}</p>
        ) : (
          <ul className="grid gap-2" data-testid={`${testId}-status-list`}>
            {changes.map((x) => (
              <li key={x.changeId} className="rounded-cdf-md border border-cdf-border p-3">
                <p className="font-semibold">
                  {t(x.isActive ? "admin.committees.reactivated" : "admin.committees.deactivated", {
                    name: isolate(who(x.changedBy)),
                    date: day(t, x.changedAt),
                  })}
                </p>
                <p className="text-sm">
                  {t("admin.committees.decisionReference")}{" "}
                  <CDFIdentifier>{x.decisionReference}</CDFIdentifier>
                </p>
                <p className="whitespace-pre-wrap break-words">
                  <bdi>{x.reason}</bdi>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </CDFCard>
  );
}

/** A registry version in the committee page's terms (every option is recorded in a version of the registry). */
function asRules(r: AdminRuleSet): CommitteeRules {
  return {
    quorumType: r.quorumType,
    quorumValue: r.quorumValue,
    castingVoteEnabled: r.castingVoteEnabled,
    actingChairCastingVote: r.actingChairCastingVote,
    ballotSecrecy: r.ballotSecrecy,
    voteRevisionAllowed: r.voteRevisionAllowed,
    dissentNoteAllowed: r.dissentNoteAllowed,
    minutesReviewBusinessDays: r.minutesReviewBusinessDays,
    deemedApprovalEnabled: r.deemedApprovalEnabled,
    minutesObjectionBlocksDeemed: r.minutesObjectionBlocksDeemed,
    minimumNoticeDays: r.minimumNoticeDays,
    conflictDecider: r.conflictDecider,
    sourceStatus: r.sourceStatus,
    effectiveFrom: r.effectiveFrom,
  };
}

/** The options only the registry shows: what an item no one votes on records, defence notices, and grievances. */
function extraRules(t: Translator, r: AdminRuleSet, grievance: boolean) {
  const notSet = t("admin.notSet");
  const days = (n: number | null) => (n === null ? notSet : formatDays(t.locale, n));
  const decider = (d: string | null) => (d ? t(`admin.committees.decider.${d}` as MessageKey) : notSet);
  const items = [
    {
      term: t("admin.committees.noSubstantiveVote"),
      value: t(`admin.committees.noSubstantiveVoteValue.${r.noSubstantiveVoteOutcome}` as MessageKey),
    },
    {
      term: t("admin.committees.defenceNoticeFirst"),
      value: t(r.sanctionRequiresDefenceNotice ? "common.yes" : "common.no"),
    },
  ];
  if (!grievance) return items;
  return [
    ...items,
    {
      term: t("admin.committees.grievanceWindow"),
      value:
        r.grievanceWindowDays !== null && r.grievanceWindowStartBasis
          ? t("admin.committees.windowFrom", {
              days: formatDays(t.locale, r.grievanceWindowDays),
              basis: t(`admin.committees.windowBasis.${r.grievanceWindowStartBasis}` as MessageKey),
            })
          : days(r.grievanceWindowDays),
    },
    { term: t("admin.committees.admissibilityDecider"), value: decider(r.admissibilityDecider) },
    { term: t("admin.committees.nonAdmissionDecider"), value: decider(r.nonAdmissionDecider) },
    { term: t("admin.committees.grievanceCompletion"), value: days(r.grievanceCompletionDays) },
  ];
}

const COVERAGE_SOURCE: Record<PackageAuthorityRule["coverage"], CDFValueSource> = {
  OWNER_DEFAULT: "OWNER_DEFAULT",
  SOURCE_REQUIRED: "SOURCE_REQUIRED",
  APPROVED: "CONFIGURED",
  NO_RULE: "UNSET",
};

/** Who decides each kind of recommendation (2030), and where no rule is in force: the package then cannot go. */
function CoverageCard({ t, rules }: { t: Translator; rules: PackageAuthorityRule[] }) {
  return (
    <CDFCard title={t("admin.committees.coverageTitle")} testId="admin-coverage">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.committees.coverageIntro")}</p>
      <ul className="grid gap-1 text-sm">
        {rules.map((r) => {
          const type = t(`committeeProceedings.itemType.${r.itemType}` as MessageKey);
          return (
            <li key={r.itemType} data-testid={`admin-coverage-${r.itemType}`} data-coverage={r.coverage}>
              {r.coverage === "NO_RULE" ? (
                t("legalReviews.noRule", { type })
              ) : (
                <CDFConfiguredValue
                  value={t("legalReviews.ruleLine", {
                    type,
                    authorities: formatList(
                      t.locale,
                      r.authorityTypes.map((x) => t(`legalReviews.authorityType.${x}` as MessageKey)),
                    ),
                  })}
                  source={COVERAGE_SOURCE[r.coverage]}
                  sourceLabel={t(`legalReviews.ruleSource.${r.coverage}` as MessageKey)}
                />
              )}
              {r.settingDisagreement ? (
                <p className="text-cdf-text-secondary">{t("legalReviews.settingDisagreement")}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </CDFCard>
  );
}
