// A package's legal review and the authority's decision (R2 with 2095's half; UX redesign Phase 12 P12-3a, ADR-057).
// Whoever reads the package reads where it stands after the adoption: each request for legal review with its opinion
// and later opinions, who decides each adopted item, each submission and each decision as recorded from its source
// document. The forms and links show only where their command would accept the caller now (UX-116), with the reason in
// words where the package is where the act is done but the command would refuse; the database decides again. The case
// team reads the same sections from the case's Proceedings tab, without any form.
import type { ReactNode } from "react";
import Link from "next/link";
import type {
  AuthorityDecisionView,
  AuthoritySubmissionView,
  PackageAuthorityRule,
  PackageLegalReviewRequest,
  RecommendationPackageView,
} from "@cdf/contracts";
import {
  formatDateTime,
  formatList,
  formatRecordDate,
  isolate,
  type MessageKey,
  type Translator,
} from "@cdf/i18n";
import {
  CDFBadge,
  CDFCommandForm,
  CDFConfiguredValue,
  CDFDescriptionList,
  CDFField,
  CDFRecordDate,
  CDFStatusBadge,
  textareaClass,
  type CDFValueSource,
} from "@cdf/ui";
import { actLabel, confirmation } from "../../confirmations";
import { LEGAL_CODES, accountName, codeText } from "../../legal-reviews/labels";
import { cancelLegalReviewAction, submitToAuthorityAction } from "./legal-actions";

const RULE_SOURCE: Record<PackageAuthorityRule["coverage"], CDFValueSource> = {
  OWNER_DEFAULT: "OWNER_DEFAULT",
  SOURCE_REQUIRED: "SOURCE_REQUIRED",
  APPROVED: "CONFIGURED",
  NO_RULE: "UNSET",
};

/** What the package sections share: who is reading, where the package's links go, and how an item is named. */
export interface PackageSectionProps {
  t: Translator;
  committeeProceedingId: string;
  pkg: RecommendationPackageView;
  /** The case side: no form and no link to the committee's own pages. */
  readOnly: boolean;
  /** Where a packet R2 names opens for this reader; null where none opens. */
  packetHref: ((packetId: string) => string) | null;
  /** "Item n · type" for an item of the package, or that it was withdrawn. */
  itemLabel: (itemId: string) => string;
}

const authorityName = (t: Translator, type: string) => t(`legalReviews.authorityType.${type}` as MessageKey);

/** The package's legal review: shown once the package is adopted, or while any request of any round exists. */
export function LegalReviewSection(props: PackageSectionProps) {
  const { t, committeeProceedingId, pkg, readOnly, packetHref } = props;
  const lr = pkg.legalReview;
  const now = pkg.status === "ADOPTED" || pkg.status === "IN_LEGAL_REVIEW";
  if (!now && lr.requests.length === 0) return null;
  const id = `package-${pkg.sequenceNo}-legal`;
  return (
    <section
      className="mt-4 border-t border-cdf-border pt-3"
      aria-labelledby={`${id}-title`}
      data-testid={id}
    >
      <h3 id={`${id}-title`} className="mb-1 font-semibold">
        {t("legalReviews.sectionTitle")}
      </h3>
      {now ? (
        <p className="mb-3 text-sm text-cdf-text-secondary" data-testid={`${id}-required`}>
          {lr.required ? t("legalReviews.requiredYes") : t("legalReviews.requiredNo")}
        </p>
      ) : null}
      {lr.requests.length > 0 ? (
        <ul className="mb-3 grid gap-4">
          {lr.requests.map((r, k) => (
            <RequestView
              key={r.requestId}
              t={t}
              id={`${id}-request-${k + 1}`}
              packageNo={pkg.sequenceNo}
              committeeProceedingId={committeeProceedingId}
              r={r}
              readOnly={readOnly}
              packetHref={packetHref}
            />
          ))}
        </ul>
      ) : null}
      {!readOnly && pkg.capabilities.mayRequestLegalReview ? (
        <p className="mb-2">
          <Link
            href={`/committee-proceedings/${committeeProceedingId}/packages/${pkg.packageId}/legal-review`}
            className="font-semibold underline underline-offset-4"
            data-testid={`${id}-ask`}
          >
            {t("legalReviews.askLink", { n: pkg.sequenceNo })}
          </Link>
        </p>
      ) : null}
      {!readOnly && pkg.requestLegalReviewBlock ? (
        <p className="text-sm" data-testid={`${id}-ask-blocked`}>
          {codeText(t, ["legalReviews.requestBlock", ...LEGAL_CODES], pkg.requestLegalReviewBlock)}
        </p>
      ) : null}
    </section>
  );
}

/** One request: who reviews it and why it was asked, its opinion and later opinions, or its cancellation. */
function RequestView({
  t,
  id,
  packageNo,
  committeeProceedingId,
  r,
  readOnly,
  packetHref,
}: {
  t: Translator;
  id: string;
  packageNo: number;
  committeeProceedingId: string;
  r: PackageLegalReviewRequest;
  readOnly: boolean;
  packetHref: ((packetId: string) => string) | null;
}) {
  const at = (iso: string) => isolate(formatDateTime(t.locale, iso));
  const terms: { term: string; value: ReactNode }[] = [
    { term: t("legalReviews.basisLabel"), value: t(`legalReviews.basis.${r.basis}` as MessageKey) },
    { term: t("legalReviews.askedOnLabel"), value: formatDateTime(t.locale, r.requestedAt) },
    { term: t("legalReviews.reasonTitle"), value: <bdi dir="auto">{r.reason}</bdi> },
  ];
  if (r.opinion)
    terms.push({
      term: t("legalReviews.opinionTitle"),
      value: (
        <span data-testid={`${id}-opinion`}>
          {t(`legalReviews.opinion.${r.opinion}` as MessageKey)}
          {r.opinionAt ? ` · ${t("legalReviews.givenOn", { date: at(r.opinionAt) })}` : null}
          {r.opinionText ? (
            <>
              {"\n"}
              <bdi dir="auto">{r.opinionText}</bdi>
            </>
          ) : null}
        </span>
      ),
    });
  for (const v of r.revisions)
    terms.push({
      term: t("legalReviews.laterOpinion", { n: v.revisionNo - 1 }),
      value: (
        <span data-testid={`${id}-revision-${v.revisionNo - 1}`}>
          {t(`legalReviews.opinion.${v.opinion}` as MessageKey)} ·{" "}
          {t("legalReviews.givenOn", { date: at(v.givenAt) })}
          {v.opinionText ? (
            <>
              {"\n"}
              <bdi dir="auto">{v.opinionText}</bdi>
            </>
          ) : null}
        </span>
      ),
    });
  if (r.cancellation)
    terms.push({
      term: t("legalReviews.cancellationLabel"),
      value: (
        <span data-testid={`${id}-cancellation`}>
          {t("legalReviews.cancelledOn", { date: at(r.cancellation.cancelledAt) })}
          {"\n"}
          <bdi dir="auto">{r.cancellation.reason}</bdi>
        </span>
      ),
    });

  return (
    <li className="rounded-cdf-md border border-cdf-border p-3" data-testid={id}>
      <h4 className="mb-2 flex flex-wrap items-center gap-2 font-semibold">
        <span>
          {t("legalReviews.requestName", {
            round: r.packageRound,
            reviewer: isolate(accountName(t, r.reviewer)),
          })}
        </span>
        <CDFStatusBadge domain="legalReview" status={r.status} testId={`${id}-status`}>
          {t(`legalReviews.status.${r.status}` as MessageKey)}
        </CDFStatusBadge>
      </h4>
      <CDFDescriptionList items={terms} />
      {r.packetId && packetHref ? (
        <p className="mt-2">
          <Link
            href={packetHref(r.packetId)}
            className="underline underline-offset-4"
            data-testid={`${id}-packet`}
          >
            {t("legalReviews.sentPacketLink", { round: r.packageRound })}
          </Link>
        </p>
      ) : null}
      {!readOnly && r.capabilities.mayCancel ? (
        <details className="mt-3 border-t border-cdf-border pt-3" data-testid={`${id}-cancel`}>
          <summary className="cursor-pointer font-semibold">{t("legalReviews.cancelTitle")}</summary>
          <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">{t("legalReviews.cancelIntro")}</p>
          <CDFCommandForm
            action={cancelLegalReviewAction.bind(null, committeeProceedingId, r.requestId)}
            locale={t.locale}
            submitLabel={actLabel(t, "cancelLegalReviewRequest")}
            submitName={t("legalReviews.cancelName", { n: packageNo, round: r.packageRound })}
            variant="danger"
            testId={`${id}-cancel-form`}
            successMessage={t("legalReviews.cancelled")}
            codeSections={LEGAL_CODES}
            fieldLabels={{ reason: t("meetings.reasonLabel") }}
            confirm={confirmation(t, "cancelLegalReviewRequest")}
          >
            <CDFField
              id={`${id}-cancel-reason`}
              label={t("meetings.reasonLabel")}
              hint={t("legalReviews.cancelReasonHint")}
            >
              <textarea
                id={`${id}-cancel-reason`}
                name="reason"
                className={textareaClass}
                aria-describedby={`${id}-cancel-reason-hint`}
                minLength={5}
                maxLength={2000}
                required
              />
            </CDFField>
          </CDFCommandForm>
        </details>
      ) : null}
    </li>
  );
}

/**
 * Who decides, the submissions and the decisions: shown once there is any of them. Who decides is the rule in force
 * for each adopted item type, as a submission would snapshot it now, so it shows until the package goes to the
 * authority; after that each submission says what it required of whom.
 */
export function AuthoritySection(props: PackageSectionProps) {
  const { t, committeeProceedingId, pkg, readOnly, packetHref, itemLabel } = props;
  const a = pkg.authority;
  const beforeSubmission = pkg.status === "ADOPTED" || pkg.status === "IN_LEGAL_REVIEW";
  const rules = beforeSubmission ? a.rules : [];
  const submits = !readOnly && pkg.capabilities.maySubmitToAuthority;
  const submitBlock = !readOnly ? pkg.submitBlock : null;
  const recordBlock = !readOnly ? pkg.recordBlock : null;
  if (
    rules.length === 0 &&
    a.submissions.length === 0 &&
    a.decisions.length === 0 &&
    a.toDecide.length === 0 &&
    !submits &&
    !submitBlock
  )
    return null;
  const id = `package-${pkg.sequenceNo}-authority`;
  const n = pkg.sequenceNo;
  const items = (ids: string[]) =>
    formatList(
      t.locale,
      ids.map((i) => isolate(itemLabel(i))),
    );
  return (
    <section
      className="mt-4 border-t border-cdf-border pt-3"
      aria-labelledby={`${id}-title`}
      data-testid={id}
    >
      <h3 id={`${id}-title`} className="mb-2 font-semibold">
        {t("legalReviews.authorityTitle")}
      </h3>

      {rules.length > 0 ? (
        <div className="mb-3" data-testid={`${id}-rules`}>
          <h4 className="mb-1 font-semibold">{t("legalReviews.rulesTitle")}</h4>
          <ul className="grid gap-1 text-sm">
            {rules.map((r) => {
              const type = t(`committeeProceedings.itemType.${r.itemType}` as MessageKey);
              return (
                <li key={r.itemType} data-testid={`${id}-rule-${r.itemType}`} data-coverage={r.coverage}>
                  {r.coverage === "NO_RULE" ? (
                    t("legalReviews.noRule", { type })
                  ) : (
                    <CDFConfiguredValue
                      value={t("legalReviews.ruleLine", {
                        type,
                        authorities: formatList(
                          t.locale,
                          r.authorityTypes.map((x) => authorityName(t, x)),
                        ),
                      })}
                      source={RULE_SOURCE[r.coverage]}
                      sourceLabel={t(`legalReviews.ruleSource.${r.coverage}` as MessageKey)}
                    />
                  )}
                  {r.settingDisagreement ? (
                    <p className="text-cdf-text-secondary" data-testid={`${id}-rule-${r.itemType}-setting`}>
                      {t("legalReviews.settingDisagreement")}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {submits ? (
        <div className="mb-3" data-testid={`${id}-submit`}>
          <h4 className="mb-1 font-semibold">{t("legalReviews.submitTitle")}</h4>
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("legalReviews.submitIntro")}</p>
          <CDFCommandForm
            action={submitToAuthorityAction.bind(null, committeeProceedingId, pkg.packageId)}
            locale={t.locale}
            submitLabel={actLabel(t, "submitToAuthority")}
            submitName={t("legalReviews.submitName", { n })}
            variant="primary"
            testId={`${id}-submit-form`}
            successMessage={t("legalReviews.submitted")}
            codeSections={LEGAL_CODES}
            confirm={confirmation(t, "submitToAuthority")}
          />
        </div>
      ) : null}
      {submitBlock ? (
        <p className="mb-3 text-sm" data-testid={`${id}-submit-blocked`}>
          {codeText(t, ["legalReviews.submitBlock", ...LEGAL_CODES], submitBlock)}
        </p>
      ) : null}

      {a.submissions.length > 0 ? (
        <div className="mb-3" data-testid={`${id}-submissions`}>
          <h4 className="mb-1 font-semibold">{t("legalReviews.submissionsTitle")}</h4>
          <ul className="grid gap-3">
            {a.submissions.map((s, k) => (
              <SubmissionView
                key={s.submissionId}
                t={t}
                id={`${id}-submission-${k + 1}`}
                s={s}
                packetHref={packetHref}
                itemLabel={itemLabel}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {a.toDecide.length > 0 ? (
        <div className="mb-3" data-testid={`${id}-to-decide`}>
          <h4 className="mb-1 font-semibold">{t("legalReviews.toDecideTitle")}</h4>
          <ul className="grid gap-2">
            {a.toDecide.map((d) => (
              <li key={d.authorityType} data-testid={`${id}-to-decide-${d.authorityType}`}>
                <p>
                  {t("legalReviews.toDecideLine", {
                    authority: authorityName(t, d.authorityType),
                    items: items(d.itemIds),
                  })}
                </p>
                {d.completesRound ? (
                  <p className="text-sm text-cdf-text-secondary">{t("legalReviews.completesRound")}</p>
                ) : null}
                {!readOnly && pkg.capabilities.mayRecordAuthorityDecision ? (
                  <Link
                    href={`/committee-proceedings/${committeeProceedingId}/packages/${pkg.packageId}/decision/${d.authorityType}`}
                    className="font-semibold underline underline-offset-4"
                    data-testid={`${id}-record-${d.authorityType}`}
                  >
                    {t("legalReviews.recordLink", { authority: authorityName(t, d.authorityType) })}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {recordBlock ? (
        <p className="mb-3 text-sm" data-testid={`${id}-record-blocked`}>
          {codeText(t, ["legalReviews.recordBlock", ...LEGAL_CODES], recordBlock)}
        </p>
      ) : null}

      {a.decisions.length > 0 ? (
        <div data-testid={`${id}-decisions`}>
          <h4 className="mb-1 font-semibold">{t("legalReviews.decisionsTitle")}</h4>
          <ul className="grid gap-3">
            {a.decisions.map((d, k) => (
              <DecisionView
                key={d.decisionId}
                t={t}
                id={`${id}-decision-${k + 1}`}
                d={d}
                itemLabel={itemLabel}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** A round as submitted: when, what it required of whom, and the package as submitted. */
function SubmissionView({
  t,
  id,
  s,
  packetHref,
  itemLabel,
}: {
  t: Translator;
  id: string;
  s: AuthoritySubmissionView;
  packetHref: ((packetId: string) => string) | null;
  itemLabel: (itemId: string) => string;
}) {
  // The requirements, one line per item: the authorities its rule required, and how settled the rule was.
  const byItem = new Map<string, AuthoritySubmissionView["requirements"]>();
  for (const r of s.requirements) byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), r]);
  return (
    <li className="rounded-cdf-md border border-cdf-border p-3" data-testid={id}>
      <p className="font-semibold">
        {t("legalReviews.submissionLine", {
          round: s.packageRound,
          date: isolate(formatDateTime(t.locale, s.submittedAt)),
        })}
      </p>
      {s.basis === "BACKFILL" ? (
        <p className="text-sm text-cdf-text-secondary" data-testid={`${id}-backfilled`}>
          {t("legalReviews.backfilled")}
        </p>
      ) : null}
      <ul className="mt-2 grid gap-1 text-sm">
        {[...byItem].map(([itemId, reqs]) => {
          const source = reqs[0]!.ruleSourceStatus;
          return (
            <li key={itemId}>
              <CDFConfiguredValue
                value={t("legalReviews.requirementLine", {
                  item: isolate(itemLabel(itemId)),
                  authority: formatList(
                    t.locale,
                    reqs.map((r) => authorityName(t, r.authorityType)),
                  ),
                })}
                source={RULE_SOURCE[source]}
                sourceLabel={t(`legalReviews.ruleSource.${source}` as MessageKey)}
              />
            </li>
          );
        })}
      </ul>
      {s.packetId && packetHref ? (
        <p className="mt-2">
          <Link
            href={packetHref(s.packetId)}
            className="underline underline-offset-4"
            data-testid={`${id}-packet`}
          >
            {t("legalReviews.submittedPacketLink", { round: s.packageRound })}
          </Link>
        </p>
      ) : null}
    </li>
  );
}

/** A decision as recorded from its source documents (N15): a formal record, so its dates show Gregorian and Hijri. */
function DecisionView({
  t,
  id,
  d,
  itemLabel,
}: {
  t: Translator;
  id: string;
  d: AuthorityDecisionView;
  itemLabel: (itemId: string) => string;
}) {
  const terms: { term: string; value: ReactNode }[] = [
    {
      term: t("legalReviews.decidedOnLabel"),
      value: <CDFRecordDate value={d.decidedAt} locale={t.locale} withTime testId={`${id}-decided-at`} />,
    },
    { term: t("legalReviews.decidedByLabel"), value: <bdi dir="auto">{d.decidedByLabel}</bdi> },
    {
      term: t("legalReviews.recordedOnLabel"),
      value: <CDFRecordDate value={d.recordedAt} locale={t.locale} withTime />,
    },
  ];
  if (d.sources.length > 0)
    terms.push({
      term: t("legalReviews.sourcesLabel"),
      value: (
        <ul>
          {d.sources.map((s) => (
            <li key={s.position}>
              {s.isPrimary ? (
                t("legalReviews.primarySource", { reference: isolate(s.reference) })
              ) : (
                <bdi dir="auto">{s.reference}</bdi>
              )}
            </li>
          ))}
        </ul>
      ),
    });
  if (d.sourceSignature)
    terms.push({
      term: t("legalReviews.signatureLabel"),
      value: t(`legalReviews.signature.${d.sourceSignature}` as MessageKey),
    });
  if (d.unsignedAttestation)
    terms.push({
      term: t("legalReviews.attestationLabel"),
      value: <bdi dir="auto">{d.unsignedAttestation}</bdi>,
    });
  if (d.delegationReference)
    terms.push({
      term: t("legalReviews.delegationLabel"),
      value: <bdi dir="auto">{d.delegationReference}</bdi>,
    });
  if (d.scope.length > 0)
    terms.push({
      term: t("legalReviews.scopeLabel"),
      value: (
        <ul data-testid={`${id}-scope`}>
          {d.scope.map((s) => (
            <li key={s.itemId}>
              {t("legalReviews.scopeLine", {
                item: isolate(itemLabel(s.itemId)),
                outcome: t(`legalReviews.itemOutcome.${s.itemOutcome}` as MessageKey),
              })}
              {s.modification ? (
                <>
                  {"\n"}
                  <bdi dir="auto">{s.modification}</bdi>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ),
    });
  if (d.conditions.length > 0)
    terms.push({
      term: t("legalReviews.conditionsLabel"),
      value: (
        <ul className="grid gap-1" data-testid={`${id}-conditions`}>
          {d.conditions.map((c) => (
            <li key={c.position}>
              {t("legalReviews.conditionLine", {
                kind: t(`legalReviews.conditionKind.${c.kind}` as MessageKey),
                text: isolate(c.text),
              })}
              {c.itemId
                ? ` · ${t("legalReviews.conditionOn", { item: isolate(itemLabel(c.itemId)) })}`
                : null}
              {c.dueDate
                ? ` · ${t("legalReviews.conditionDue", { date: isolate(formatRecordDate(t.locale, `${c.dueDate}T12:00:00+03:00`)) })}`
                : null}
            </li>
          ))}
        </ul>
      ),
    });
  if (d.reason)
    terms.push({ term: t("legalReviews.decisionReasonLabel"), value: <bdi dir="auto">{d.reason}</bdi> });

  return (
    <li
      className="rounded-cdf-md border border-cdf-border p-3"
      data-testid={id}
      data-superseded={d.superseded ? "true" : "false"}
    >
      <h5 className="mb-2 flex flex-wrap items-center gap-2 font-semibold">
        <span>
          {t("legalReviews.decisionName", {
            authority: authorityName(t, d.authorityType),
            round: d.packageRound,
            outcome: t(`legalReviews.outcome.${d.outcome}` as MessageKey),
          })}
        </span>
        {d.superseded ? <CDFBadge tone="neutral">{t("legalReviews.supersededBadge")}</CDFBadge> : null}
      </h5>
      <CDFDescriptionList items={terms} />
      {d.superseded ? (
        <p className="mt-2 text-sm text-cdf-text-secondary" data-testid={`${id}-superseded`}>
          {t("legalReviews.supersededOn", {
            date: isolate(formatRecordDate(t.locale, d.superseded.supersededAt)),
          })}
        </p>
      ) : null}
    </li>
  );
}
