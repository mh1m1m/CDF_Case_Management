// Recording an authority's decision on a package (UX redesign Phase 12 P12-3a; ADR-057; N15, AMB-125 to AMB-133,
// DEC-AMB-003, DEC-AMB-013): a page of the proceeding's own for the committee's secretary, who records what the
// authority decided from its source document. It reads the seat basis and R2 only: the authority must still be to
// decide in the package's current round, and the outcomes offered are the ones the command accepts now (only a return to
// the committee while a conflict taint waits). Where a conflict remediation is open, the page says, in counts only, what
// completing the round would supersede and freeze (ruling 3). Anyone else gets the same 404 as a package that does not
// exist; the command checks everything again.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AUTHORITY_CONDITION_KINDS,
  AUTHORITY_TYPES,
  RECORDED_ITEM_OUTCOMES,
  SOURCE_SIGNATURES,
} from "@cdf/contracts";
import { isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFAlert,
  CDFBreadcrumbs,
  CDFCard,
  CDFCommandForm,
  CDFField,
  CDFFieldError,
  CDFPageHeader,
  CDFPurposeBanner,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { committeeProceedingsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { proceedingLabel } from "../../../../../../committees/proceeding-label";
import { actLabel, confirmation } from "../../../../../../confirmations";
import { LEGAL_CODES } from "../../../../../../legal-reviews/labels";
import { itemLabeller } from "../../../../../labels";
import { recordAuthorityDecisionAction } from "../../../../legal-actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or committee content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.authorityDecision") };
}

const UUID = /^[0-9a-f-]{36}$/i;
/** Rows offered for conditions: a decision takes up to twenty, and the form offers three at a time. */
const CONDITION_ROWS = 3;

export default async function RecordAuthorityDecisionPage({
  params,
}: {
  params: Promise<{ committeeProceedingId: string; packageId: string; authorityType: string }>;
}) {
  const { committeeProceedingId, packageId, authorityType } = await params;
  if (
    !UUID.test(committeeProceedingId) ||
    !UUID.test(packageId) ||
    !(AUTHORITY_TYPES as readonly string[]).includes(authorityType)
  )
    notFound();
  const { ctx } = await requireActor();
  const t = await getTranslator();
  const v = await committeeProceedingsService().onSeat(ctx, committeeProceedingId);
  const pkg = v?.items.packages.find((p) => p.packageId === packageId);
  const toDecide = pkg?.authority.toDecide.find((d) => d.authorityType === authorityType);
  if (!v || !pkg || !toDecide || !pkg.capabilities.mayRecordAuthorityDecision) notFound();

  const committee = t.code("committeeName", v.committee.code, "common.none");
  const label = proceedingLabel(t, v.committee.code, v.proceeding);
  const proceedingHref = `/committee-proceedings/${committeeProceedingId}`;
  const authority = t(`legalReviews.authorityType.${authorityType}` as MessageKey);
  const itemLabel = itemLabeller(t, pkg);
  const n = pkg.sequenceNo;
  // Completing the round under an open conflict remediation supersedes the round it remedies (DEC-AMB-013).
  const supersedes = toDecide.completesRound ? pkg.recordSupersedes : null;
  const taintedOnly = pkg.recordOutcomes.length === 1 && pkg.recordOutcomes[0] === "RETURN_TO_COMMITTEE";
  const items = toDecide.itemIds;

  const fieldLabels: Record<string, string> = {
    outcome: t("legalReviews.outcomeLabel"),
    decidedAt: t("legalReviews.decidedAtLabel"),
    decidedByLabel: t("legalReviews.decidedByField"),
    sourceDocumentReference: t("legalReviews.sourceLabel"),
    sourceSignature: t("legalReviews.signatureField"),
    unsignedAttestation: t("legalReviews.attestationField"),
    delegationReference: t("legalReviews.delegationField"),
    additionalSourceReferences: t("legalReviews.moreSourcesField"),
    reason: t("meetings.reasonLabel"),
  };
  items.forEach((itemId, k) => {
    const item = isolate(itemLabel(itemId));
    fieldLabels[`itemOutcomes.${k}.outcome`] = t("legalReviews.itemOutcomeLabel", { item });
    fieldLabels[`itemOutcomes.${k}.modification`] = t("legalReviews.modificationLabel", { item });
  });
  for (let k = 0; k < CONDITION_ROWS; k++) {
    const row = t("legalReviews.conditionRow", { n: k + 1 });
    fieldLabels[`conditions.${k}.kind`] = `${row}: ${t("legalReviews.conditionKindField")}`;
    fieldLabels[`conditions.${k}.text`] = `${row}: ${t("legalReviews.conditionTextField")}`;
    fieldLabels[`conditions.${k}.itemId`] = `${row}: ${t("legalReviews.conditionItemField")}`;
    fieldLabels[`conditions.${k}.dueDate`] = `${row}: ${t("legalReviews.conditionDueField")}`;
  }

  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={[
          { label: t("shell.area.COMMITTEE"), href: "/committees" },
          { label: committee, href: `/committees/${v.committee.committeeId}` },
          { label, href: proceedingHref },
          { label: t("legalReviews.recordBreadcrumb") },
        ]}
      />
      <CDFPageHeader title={t("legalReviews.recordTitle", { n, authority })} />
      <CDFPurposeBanner
        title={t("legalReviews.recordPurposeTitle")}
        purpose={t("legalReviews.recordPurposeBody")}
        notShown={t("legalReviews.recordPurposeNotShown")}
        testId="record-purpose-banner"
      />

      <CDFCard title={t("legalReviews.scopeTitle")} testId="record-scope">
        <ul className="grid gap-1">
          {items.map((itemId) => (
            <li key={itemId}>{itemLabel(itemId)}</li>
          ))}
        </ul>
        {toDecide.completesRound ? (
          <p className="mt-2 text-sm text-cdf-text-secondary">{t("legalReviews.completesRound")}</p>
        ) : null}
      </CDFCard>

      {supersedes ? (
        <CDFAlert tone="warning" title={t("legalReviews.supersedesTitle")} testId="record-supersedes">
          <p>
            {t("legalReviews.supersedesBody", {
              decisions: supersedes.decisions,
              actions: supersedes.correctiveActions,
            })}
          </p>
        </CDFAlert>
      ) : null}
      {taintedOnly ? (
        <CDFAlert tone="info" testId="record-tainted-only">
          <p>{t("legalReviews.taintedOnly")}</p>
        </CDFAlert>
      ) : null}

      <CDFCard testId="record">
        <CDFCommandForm
          action={recordAuthorityDecisionAction.bind(null, committeeProceedingId, packageId, authorityType)}
          locale={t.locale}
          submitLabel={actLabel(t, "recordAuthorityDecision")}
          variant="primary"
          testId="record-form"
          successMessage={t("legalReviews.recorded")}
          codeSections={LEGAL_CODES}
          fieldLabels={fieldLabels}
          leaveWarning={t("common.leaveWarning")}
          confirm={confirmation(
            t,
            "recordAuthorityDecision",
            supersedes
              ? [
                  {
                    term: t("confirm.acts.recordAuthorityDecision.supersedes"),
                    value: String(supersedes.decisions),
                  },
                  {
                    term: t("confirm.acts.recordAuthorityDecision.frozen"),
                    value: String(supersedes.correctiveActions),
                  },
                ]
              : undefined,
          )}
        >
          <fieldset className="mb-4">
            <legend className="mb-1 font-semibold">{t("legalReviews.outcomeLabel")}</legend>
            {pkg.recordOutcomes.map((o) => (
              <div key={o} className="mb-2 flex items-start gap-2">
                <input
                  id={`record-outcome-${o}`}
                  type="radio"
                  name="outcome"
                  value={o}
                  className="mt-1 size-5"
                  required
                  aria-describedby={`record-outcome-${o}-hint`}
                  data-testid={`record-outcome-${o}`}
                />
                <div>
                  <label htmlFor={`record-outcome-${o}`}>
                    {t(`legalReviews.outcome.${o}` as MessageKey)}
                  </label>
                  <p id={`record-outcome-${o}-hint`} className="text-sm text-cdf-text-secondary">
                    {t(`legalReviews.outcomeHint.${o}` as MessageKey)}
                  </p>
                </div>
              </div>
            ))}
            <CDFFieldError id={`record-outcome-${pkg.recordOutcomes[0]}`} />
          </fieldset>

          {taintedOnly ? null : <ItemOutcomes t={t} items={items} itemLabel={itemLabel} />}

          <CDFField
            id="record-decided-at"
            label={t("legalReviews.decidedAtLabel")}
            hint={t("legalReviews.decidedAtHint")}
          >
            <input
              id="record-decided-at"
              name="decidedAt"
              type="datetime-local"
              className={inputClass}
              aria-describedby="record-decided-at-hint"
              required
              data-testid="record-decided-at"
            />
          </CDFField>
          <CDFField
            id="record-decided-by"
            label={t("legalReviews.decidedByField")}
            hint={t("legalReviews.decidedByHint")}
          >
            <input
              id="record-decided-by"
              name="decidedByLabel"
              dir="auto"
              className={inputClass}
              aria-describedby="record-decided-by-hint"
              minLength={3}
              maxLength={200}
              required
              data-testid="record-decided-by"
            />
          </CDFField>
          <CDFField
            id="record-source"
            label={t("legalReviews.sourceLabel")}
            hint={t("legalReviews.sourceHint")}
          >
            <input
              id="record-source"
              name="sourceDocumentReference"
              dir="auto"
              className={inputClass}
              aria-describedby="record-source-hint"
              minLength={3}
              maxLength={300}
              required
              data-testid="record-source"
            />
          </CDFField>
          <fieldset className="mb-4">
            <legend className="mb-1 font-semibold">{t("legalReviews.signatureField")}</legend>
            {(["", ...SOURCE_SIGNATURES] as const).map((s) => (
              <div key={s || "none"} className="mb-1 flex items-start gap-2">
                <input
                  id={`record-signature-${s || "none"}`}
                  type="radio"
                  name="sourceSignature"
                  value={s}
                  defaultChecked={s === ""}
                  className="mt-1 size-5"
                  data-testid={`record-signature-${s || "none"}`}
                />
                <label htmlFor={`record-signature-${s || "none"}`}>
                  {s ? t(`legalReviews.signature.${s}` as MessageKey) : t("legalReviews.signatureNotStated")}
                </label>
              </div>
            ))}
            <CDFFieldError id="record-signature-none" />
          </fieldset>
          <CDFField
            id="record-attestation"
            label={t("legalReviews.attestationField")}
            hint={t("legalReviews.attestationHint")}
            optionalLabel={t("common.optional")}
          >
            <textarea
              id="record-attestation"
              name="unsignedAttestation"
              className={textareaClass}
              aria-describedby="record-attestation-hint"
              maxLength={2000}
              data-testid="record-attestation"
            />
          </CDFField>
          <CDFField
            id="record-delegation"
            label={t("legalReviews.delegationField")}
            hint={t("legalReviews.delegationHint")}
            optionalLabel={t("common.optional")}
          >
            <input
              id="record-delegation"
              name="delegationReference"
              dir="auto"
              className={inputClass}
              aria-describedby="record-delegation-hint"
              maxLength={300}
            />
          </CDFField>
          <CDFField
            id="record-more-sources"
            label={t("legalReviews.moreSourcesField")}
            hint={t("legalReviews.moreSourcesHint")}
            optionalLabel={t("common.optional")}
          >
            <textarea
              id="record-more-sources"
              name="additionalSourceReferences"
              dir="auto"
              className={textareaClass}
              aria-describedby="record-more-sources-hint"
              maxLength={3500}
            />
          </CDFField>

          {taintedOnly ? null : <Conditions t={t} items={items} itemLabel={itemLabel} />}

          <CDFField
            id="record-reason"
            label={t("meetings.reasonLabel")}
            hint={t("legalReviews.recordReasonHint")}
            optionalLabel={t("common.optional")}
          >
            <textarea
              id="record-reason"
              name="reason"
              className={textareaClass}
              aria-describedby="record-reason-hint"
              maxLength={4000}
              data-testid="record-reason"
            />
          </CDFField>
        </CDFCommandForm>
      </CDFCard>
      <p>
        <Link href={proceedingHref} className="underline underline-offset-4" data-testid="record-back">
          {t("legalReviews.backToProceeding")}
        </Link>
      </p>
    </>
  );
}

/**
 * For Approve partially and Modify: the decision on each item of the authority's scope, and how a modified item is
 * modified. Each row sends its item's id, so that the command checks the row against the scope.
 */
function ItemOutcomes({
  t,
  items,
  itemLabel,
}: {
  t: Translator;
  items: string[];
  itemLabel: (itemId: string) => string;
}) {
  return (
    <fieldset className="mb-4 rounded-cdf-md border border-cdf-border p-3" data-testid="record-items">
      <legend className="px-1 font-semibold">{t("legalReviews.itemOutcomesTitle")}</legend>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("legalReviews.itemOutcomesIntro")}</p>
      {items.map((itemId, k) => {
        const id = `record-item-${k}`;
        const item = itemLabel(itemId);
        return (
          <div
            key={itemId}
            className="mb-4 border-b border-cdf-border pb-3 last:mb-0 last:border-0 last:pb-0"
          >
            <input type="hidden" name={`itemOutcomes.${k}.itemId`} value={itemId} />
            <fieldset className="mb-2">
              <legend className="mb-1 font-semibold">
                {t("legalReviews.itemOutcomeLabel", { item: isolate(item) })}
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {RECORDED_ITEM_OUTCOMES.map((o) => (
                  <div key={o} className="flex items-start gap-2">
                    <input
                      id={`${id}-${o}`}
                      type="radio"
                      name={`itemOutcomes.${k}.outcome`}
                      value={o}
                      className="mt-1 size-5"
                      data-testid={`${id}-${o}`}
                    />
                    <label htmlFor={`${id}-${o}`}>{t(`legalReviews.itemOutcome.${o}` as MessageKey)}</label>
                  </div>
                ))}
              </div>
              <CDFFieldError id={`${id}-${RECORDED_ITEM_OUTCOMES[0]}`} />
            </fieldset>
            <CDFField
              id={`${id}-modification`}
              label={t("legalReviews.modificationLabel", { item: isolate(item) })}
              hint={t("legalReviews.modificationHint")}
              optionalLabel={t("common.optional")}
            >
              <textarea
                id={`${id}-modification`}
                name={`itemOutcomes.${k}.modification`}
                className={textareaClass}
                aria-describedby={`${id}-modification-hint`}
                maxLength={4000}
                data-testid={`${id}-modification`}
              />
            </CDFField>
          </div>
        );
      })}
    </fieldset>
  );
}

/** Conditions attached to an approving decision (AMB-133): a row left empty adds nothing. */
function Conditions({
  t,
  items,
  itemLabel,
}: {
  t: Translator;
  items: string[];
  itemLabel: (itemId: string) => string;
}) {
  return (
    <fieldset className="mb-4 rounded-cdf-md border border-cdf-border p-3" data-testid="record-conditions">
      <legend className="px-1 font-semibold">{t("legalReviews.conditionsTitle")}</legend>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("legalReviews.conditionsIntro")}</p>
      {Array.from({ length: CONDITION_ROWS }, (_, k) => {
        const id = `record-condition-${k}`;
        return (
          <fieldset
            key={k}
            className="mb-4 border-b border-cdf-border pb-3 last:mb-0 last:border-0 last:pb-0"
          >
            <legend className="mb-2 font-semibold">{t("legalReviews.conditionRow", { n: k + 1 })}</legend>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <CDFField id={`${id}-kind`} label={t("legalReviews.conditionKindField")}>
                <select
                  id={`${id}-kind`}
                  name={`conditions.${k}.kind`}
                  className={inputClass}
                  defaultValue=""
                  data-testid={`${id}-kind`}
                >
                  <option value="">{t("legalReviews.conditionNone")}</option>
                  {AUTHORITY_CONDITION_KINDS.map((c) => (
                    <option key={c} value={c}>
                      {t(`legalReviews.conditionKind.${c}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </CDFField>
              <CDFField id={`${id}-item`} label={t("legalReviews.conditionItemField")}>
                <select
                  id={`${id}-item`}
                  name={`conditions.${k}.itemId`}
                  className={inputClass}
                  defaultValue=""
                  data-testid={`${id}-item`}
                >
                  <option value="">{t("legalReviews.conditionItemNone")}</option>
                  {items.map((itemId) => (
                    <option key={itemId} value={itemId}>
                      {itemLabel(itemId)}
                    </option>
                  ))}
                </select>
              </CDFField>
            </div>
            <CDFField
              id={`${id}-text`}
              label={t("legalReviews.conditionTextField")}
              hint={t("legalReviews.conditionTextHint")}
            >
              <textarea
                id={`${id}-text`}
                name={`conditions.${k}.text`}
                className={textareaClass}
                aria-describedby={`${id}-text-hint`}
                maxLength={2000}
                data-testid={`${id}-text`}
              />
            </CDFField>
            <CDFField
              id={`${id}-due`}
              label={t("legalReviews.conditionDueField")}
              optionalLabel={t("common.optional")}
            >
              <input
                id={`${id}-due`}
                name={`conditions.${k}.dueDate`}
                type="date"
                className={inputClass}
                data-testid={`${id}-due`}
              />
            </CDFField>
          </fieldset>
        );
      })}
    </fieldset>
  );
}
