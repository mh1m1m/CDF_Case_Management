// The proceeding's recommendation packages (read model R2 with 2086's capabilities; UX redesign Phase 12 P12-2c,
// ADR-056). Whoever may deliberate reads the packages, their items and each item's flags; each form shows only where
// its command would accept the caller now (UX-116), and the database decides again on submit. The builder offers only
// what R1 gives the committee's secretary: the case's subjects and allegations by position and category, never their
// text, and the sanction catalogue in force. An item's description is the secretary's text, which the committee's
// members read; voted item by item, it opens the item's vote, which the minutes record. After the adoption the card
// shows the package's legal review and the authority's decision (2095; P12-3a, ADR-057). The case team reads the same
// card from the case's Proceedings tab, read-only: no form, and no link to the committee's own pages.
import type { ReactNode } from "react";
import Link from "next/link";
import {
  RECOMMENDATION_ITEM_TYPES,
  VOTE_GRANULARITIES,
  isClosedAllegation,
  type CommitteeScopeChoices,
  type PackageItemView,
  type RecommendationPackageView,
  type SanctionCatalogueChoice,
} from "@cdf/contracts";
import { formatList, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCommandForm,
  CDFCard,
  CDFDescriptionList,
  CDFField,
  CDFFieldError,
  CDFStatusBadge,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { actLabel, confirmation } from "../../confirmations";
import {
  allegationCategory,
  allegationName,
  itemLabeller,
  sanctionName,
  sanctionOption,
  subjectName,
} from "../labels";
import { AuthoritySection, LegalReviewSection } from "./legal-authority";
import {
  addItemAction,
  createPackageAction,
  openPackageVoteAction,
  recordAdoptionAction,
  resolveTaintAction,
  returnToCommitteeAction,
  submitForVoteAction,
  withdrawItemAction,
} from "./actions";

/** The package commands' own refusals first, then the shared ones. */
const CODES = ["committeeProceedings.codes", "codes"] as const;

const itemTypeName = (t: Translator, type: string) =>
  t(`committeeProceedings.itemType.${type}` as MessageKey);

export function PackageCard({
  t,
  committeeProceedingId,
  pkg,
  scope,
  catalogue,
  meetingNo,
  readOnly = false,
  packetHref = null,
  footer,
}: {
  t: Translator;
  committeeProceedingId: string;
  pkg: RecommendationPackageView;
  /** R1, read only for whoever builds packages now; null for everyone else. */
  scope: CommitteeScopeChoices | null;
  catalogue: readonly SanctionCatalogueChoice[];
  /** The proceeding's meetings the caller may see, by id, with their number. */
  meetingNo: ReadonlyMap<string, number>;
  /** The case side (P12-3a): the package as R2 gives it to the case team, without any form. */
  readOnly?: boolean;
  /** Where a packet R2 names to the caller opens (P12-3a); null where none opens. */
  packetHref?: ((packetId: string) => string) | null;
  /** The case side's own act on the package, at the card's end (the restricted case's authority, P12-3a). */
  footer?: ReactNode;
}) {
  const n = pkg.sequenceNo;
  const id = `package-${n}`;
  const cap = pkg.capabilities;
  // Items are numbered in the read model's order (the order they were added); a withdrawn item is no longer listed.
  const itemNo = new Map(pkg.items.map((i, k) => [i.itemId, k + 1] as const));
  const sections = { t, committeeProceedingId, pkg, readOnly, packetHref, itemLabel: itemLabeller(t, pkg) };
  return (
    <CDFCard
      title={t("committeeProceedings.packageName", { n })}
      testId={id}
      actions={
        <CDFStatusBadge domain="recommendationPackage" status={pkg.status} testId={`${id}-status`}>
          {t(`committeeProceedings.packageStatus.${pkg.status}` as MessageKey)}
        </CDFStatusBadge>
      }
    >
      <p className="mb-1 text-sm" data-testid={`${id}-facts`}>
        {t("committeeProceedings.packageFacts", {
          granularity: t(`committeeProceedings.granularity.${pkg.voteGranularity}` as MessageKey),
          round: pkg.roundNo,
        })}
      </p>
      <p className="mb-4 text-sm text-cdf-text-secondary" data-testid={`${id}-status-note`}>
        {t(`committeeProceedings.statusNote.${pkg.status}` as MessageKey)}
      </p>

      <h3 className="mb-2 font-semibold">{t("committeeProceedings.itemsTitle")}</h3>
      {pkg.items.length === 0 ? (
        <p className="mb-3 text-cdf-text-secondary" data-testid={`${id}-no-items`}>
          {t("committeeProceedings.noItems")}
        </p>
      ) : (
        <ol className="grid gap-4" data-testid={`${id}-items`}>
          {pkg.items.map((item, k) => (
            <ItemView
              key={item.itemId}
              t={t}
              committeeProceedingId={committeeProceedingId}
              packageNo={n}
              n={k + 1}
              item={item}
              itemNo={itemNo}
              readOnly={readOnly}
            />
          ))}
        </ol>
      )}

      {/* R1 refusing the secretary (CDF-226) leaves the builder out: an item names only what R1 offers. */}
      {!readOnly && cap.mayAddItem && scope ? (
        <AddItemForm
          t={t}
          committeeProceedingId={committeeProceedingId}
          pkg={pkg}
          scope={scope}
          catalogue={catalogue}
          itemNo={itemNo}
        />
      ) : null}

      {!readOnly && cap.maySubmitForVote ? (
        <div className="mt-4 border-t border-cdf-border pt-3" data-testid={`${id}-submit`}>
          <h3 className="mb-1 font-semibold">{t("committeeProceedings.submitTitle")}</h3>
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("committeeProceedings.submitIntro")}</p>
          <CDFCommandForm
            action={submitForVoteAction.bind(null, committeeProceedingId, pkg.packageId)}
            locale={t.locale}
            submitLabel={actLabel(t, "submitPackageForVote")}
            submitName={t("committeeProceedings.submitName", { n })}
            variant="primary"
            testId={`${id}-submit-form`}
            successMessage={t("committeeProceedings.submitted")}
            codeSections={CODES}
            confirm={confirmation(t, "submitPackageForVote")}
          />
        </div>
      ) : null}

      {!readOnly && pkg.openVoteIn.length > 0 ? (
        <div className="mt-4 border-t border-cdf-border pt-3" data-testid={`${id}-open-vote`}>
          <h3 className="mb-1 font-semibold">{t("committeeProceedings.openVoteTitle")}</h3>
          <p className="mb-3 text-sm text-cdf-text-secondary">
            {t(`committeeProceedings.openVoteIntro.${pkg.voteGranularity}` as MessageKey)}
          </p>
          {pkg.openVoteIn.map((meetingId) => {
            const m = meetingNo.get(meetingId);
            return (
              <div key={meetingId} className="mb-3">
                {m ? (
                  <p className="mb-2 text-sm">
                    <Link href={`/meetings/${meetingId}`} className="underline">
                      {t("committees.meetingLink", { n: m })}
                    </Link>
                  </p>
                ) : null}
                <CDFCommandForm
                  action={openPackageVoteAction.bind(null, committeeProceedingId, pkg.packageId, meetingId)}
                  locale={t.locale}
                  submitLabel={actLabel(t, "openPackageVote")}
                  submitName={
                    m
                      ? t("committeeProceedings.openVoteInName", { n, meeting: m })
                      : t("committeeProceedings.openVoteName", { n })
                  }
                  variant="primary"
                  testId={`${id}-open-vote-form${m ? `-${m}` : ""}`}
                  successMessage={t("committeeProceedings.voteOpened")}
                  codeSections={CODES}
                  confirm={confirmation(t, "openPackageVote")}
                />
              </div>
            );
          })}
        </div>
      ) : null}

      {!readOnly && cap.mayRecordAdoption ? (
        <div className="mt-4 border-t border-cdf-border pt-3" data-testid={`${id}-adopt`}>
          <h3 className="mb-1 font-semibold">{t("committeeProceedings.adoptTitle")}</h3>
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("committeeProceedings.adoptIntro")}</p>
          <CDFCommandForm
            action={recordAdoptionAction.bind(null, committeeProceedingId, pkg.packageId)}
            locale={t.locale}
            submitLabel={actLabel(t, "recordPackageAdoption")}
            submitName={t("committeeProceedings.adoptName", { n })}
            variant="primary"
            testId={`${id}-adopt-form`}
            successMessage={t("committeeProceedings.adoptionRecorded")}
            codeSections={CODES}
            confirm={confirmation(t, "recordPackageAdoption")}
          />
        </div>
      ) : null}

      <LegalReviewSection {...sections} />
      <AuthoritySection {...sections} />

      {!readOnly && cap.mayReturnToCommittee ? (
        <details className="mt-4 border-t border-cdf-border pt-3" data-testid={`${id}-return`}>
          <summary className="cursor-pointer font-semibold">{t("committeeProceedings.returnTitle")}</summary>
          <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">{t("committeeProceedings.returnIntro")}</p>
          <CDFCommandForm
            action={returnToCommitteeAction.bind(null, committeeProceedingId, pkg.packageId)}
            locale={t.locale}
            submitLabel={actLabel(t, "returnPackageToCommittee")}
            submitName={t("committeeProceedings.returnName", { n })}
            variant="danger"
            testId={`${id}-return-form`}
            successMessage={t("committeeProceedings.returned")}
            codeSections={CODES}
            fieldLabels={{ reason: t("meetings.reasonLabel") }}
            confirm={confirmation(t, "returnPackageToCommittee")}
          >
            <CDFField
              id={`${id}-return-reason`}
              label={t("meetings.reasonLabel")}
              hint={t("committeeProceedings.returnReasonHint")}
            >
              <textarea
                id={`${id}-return-reason`}
                name="reason"
                className={textareaClass}
                aria-describedby={`${id}-return-reason-hint`}
                minLength={5}
                maxLength={2000}
                required
              />
            </CDFField>
          </CDFCommandForm>
        </details>
      ) : null}
      {footer}
    </CDFCard>
  );
}

/** One active item: what it recommends, about whom, its flags, and the secretary's forms for it. */
function ItemView({
  t,
  committeeProceedingId,
  packageNo,
  n,
  item,
  itemNo,
  readOnly,
}: {
  t: Translator;
  committeeProceedingId: string;
  packageNo: number;
  n: number;
  item: PackageItemView;
  itemNo: ReadonlyMap<string, number>;
  readOnly: boolean;
}) {
  const id = `package-${packageNo}-item-${n}`;
  const list = (values: string[]) => formatList(t.locale, values.map(isolate));
  const terms: { term: string; value: ReactNode }[] = [];
  if (item.itemType === "DISCIPLINARY_SANCTION") {
    terms.push({
      term: t("committeeProceedings.sanctionLabel"),
      value: item.sanctionCode ? (
        sanctionName(t, item.sanctionCode)
      ) : (
        <bdi dir="auto">{item.proposedSanctionText}</bdi>
      ),
    });
  }
  if (item.caseWide)
    terms.push({ term: t("committeeProceedings.scopeLabel"), value: t("committeeProceedings.caseWide") });
  if (item.subjects.length > 0)
    terms.push({
      term: t("committeeProceedings.subjectsLabel"),
      value: list(item.subjects.map((s) => subjectName(t, s))),
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

  return (
    <li className="border-b border-cdf-border pb-4 last:border-0 last:pb-0" data-testid={id}>
      <h4 className="flex flex-wrap items-center gap-2 font-semibold">
        <span>
          {t("committeeProceedings.itemNumber", { n })} · {itemTypeName(t, item.itemType)}
        </span>
        {item.committeeResult ? (
          <CDFBadge
            tone={item.committeeResult === "APPROVED" ? "success" : "neutral"}
            testId={`${id}-result`}
          >
            {t(`committeeProceedings.itemResult.${item.committeeResult}` as MessageKey)}
          </CDFBadge>
        ) : null}
      </h4>
      <p className="mt-1 mb-2 whitespace-pre-wrap break-words" data-testid={`${id}-description`}>
        <bdi dir="auto">{item.description}</bdi>
      </p>
      {terms.length > 0 ? <CDFDescriptionList items={terms} /> : null}
      {item.flags.length > 0 ? (
        <ul
          className="mt-2 flex flex-wrap gap-2"
          aria-label={t("committeeProceedings.flagsLabel")}
          data-testid={`${id}-flags`}
        >
          {item.flags.map((f) => (
            <li key={f}>
              <CDFBadge tone="warning" testId={`${id}-flag-${f}`}>
                {t(`committeeProceedings.flag.${f}` as MessageKey)}
              </CDFBadge>
            </li>
          ))}
        </ul>
      ) : null}

      {!readOnly && item.taintResolutions.length > 0 ? (
        <div className="mt-3 border-t border-cdf-border pt-3" data-testid={`${id}-taint`}>
          <h5 className="mb-1 font-semibold">{t("committeeProceedings.taintTitle")}</h5>
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("committeeProceedings.taintIntro")}</p>
          <CDFCommandForm
            action={resolveTaintAction.bind(null, committeeProceedingId, item.itemId)}
            locale={t.locale}
            submitLabel={actLabel(t, "resolveConflictTaint")}
            submitName={t("committeeProceedings.taintName", { n })}
            variant="primary"
            testId={`${id}-taint-form`}
            successMessage={t("committeeProceedings.taintResolved")}
            codeSections={CODES}
            fieldLabels={{
              resolution: t("committeeProceedings.taintResolutionLabel"),
              reason: t("meetings.reasonLabel"),
            }}
            confirm={confirmation(t, "resolveConflictTaint")}
          >
            <fieldset className="mb-4">
              <legend className="mb-1 font-semibold">{t("committeeProceedings.taintResolutionLabel")}</legend>
              {item.taintResolutions.map((r) => (
                <div key={r} className="mb-1 flex items-start gap-2">
                  <input
                    id={`${id}-taint-${r}`}
                    type="radio"
                    name="resolution"
                    value={r}
                    className="mt-1 size-5"
                    required
                    aria-describedby={`${id}-taint-${r}-hint`}
                    data-testid={`${id}-taint-${r}`}
                  />
                  <div>
                    <label htmlFor={`${id}-taint-${r}`}>
                      {t(`committeeProceedings.taintResolution.${r}` as MessageKey)}
                    </label>
                    <p id={`${id}-taint-${r}-hint`} className="text-sm text-cdf-text-secondary">
                      {t(`committeeProceedings.taintResolutionHint.${r}` as MessageKey)}
                    </p>
                  </div>
                </div>
              ))}
              <CDFFieldError id={`${id}-taint-${item.taintResolutions[0]}`} />
            </fieldset>
            <CDFField
              id={`${id}-taint-reason`}
              label={t("meetings.reasonLabel")}
              hint={t("committeeProceedings.taintReasonHint")}
            >
              <textarea
                id={`${id}-taint-reason`}
                name="reason"
                className={textareaClass}
                aria-describedby={`${id}-taint-reason-hint`}
                minLength={10}
                maxLength={2000}
                required
              />
            </CDFField>
          </CDFCommandForm>
        </div>
      ) : null}

      {!readOnly && item.capabilities.mayWithdraw ? (
        <details className="mt-3 border-t border-cdf-border pt-3" data-testid={`${id}-withdraw`}>
          <summary className="cursor-pointer font-semibold">
            {t("committeeProceedings.withdrawTitle")}
          </summary>
          <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">
            {t("committeeProceedings.withdrawIntro")}
          </p>
          <CDFCommandForm
            action={withdrawItemAction.bind(null, committeeProceedingId, item.itemId)}
            locale={t.locale}
            submitLabel={actLabel(t, "withdrawRecommendationItem")}
            submitName={t("committeeProceedings.withdrawName", { n })}
            variant="danger"
            testId={`${id}-withdraw-form`}
            successMessage={t("committeeProceedings.withdrawn")}
            codeSections={CODES}
            fieldLabels={{ reason: t("meetings.reasonLabel") }}
            confirm={confirmation(t, "withdrawRecommendationItem")}
          >
            <CDFField
              id={`${id}-withdraw-reason`}
              label={t("meetings.reasonLabel")}
              hint={t("committeeProceedings.withdrawReasonHint")}
            >
              <textarea
                id={`${id}-withdraw-reason`}
                name="reason"
                className={textareaClass}
                aria-describedby={`${id}-withdraw-reason-hint`}
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

/** Checkboxes sending one value per ticked box; a server error on the field shows under the first box. */
export function Checks({
  id,
  name,
  legend,
  hint,
  empty,
  options,
}: {
  id: string;
  name: string;
  legend: string;
  hint?: string;
  empty: string;
  options: { value: string; label: string }[];
}) {
  return (
    <fieldset className="mb-3" aria-describedby={hint ? `${id}-hint` : undefined} data-testid={id}>
      <legend className="mb-1 font-semibold">{legend}</legend>
      {hint ? (
        <p id={`${id}-hint`} className="mb-2 text-sm text-cdf-text-secondary">
          {hint}
        </p>
      ) : null}
      {options.length === 0 ? (
        <p className="text-sm text-cdf-text-secondary">{empty}</p>
      ) : (
        options.map((o, k) => (
          <div key={o.value} className="mb-1 flex items-start gap-2">
            <input
              id={`${id}-${k}`}
              type="checkbox"
              name={name}
              value={o.value}
              className="mt-1 size-5"
              data-testid={`${id}-${k}`}
            />
            <label htmlFor={`${id}-${k}`}>
              <bdi>{o.label}</bdi>
            </label>
          </div>
        ))
      )}
      {options.length > 0 ? <CDFFieldError id={`${id}-0`} /> : null}
    </fieldset>
  );
}

/**
 * Adding an item, for the committee's secretary while the package can change (`may_add_item`, 2086). The choices are
 * R1's: the case's subjects, its allegations that are neither withdrawn nor superseded (the command refuses those,
 * CDF-238) and the package's
 * items; the sanction catalogue is the codes in force, each marked provisional until its basis is approved.
 */
function AddItemForm({
  t,
  committeeProceedingId,
  pkg,
  scope,
  catalogue,
  itemNo,
}: {
  t: Translator;
  committeeProceedingId: string;
  pkg: RecommendationPackageView;
  scope: CommitteeScopeChoices;
  catalogue: readonly SanctionCatalogueChoice[];
  itemNo: ReadonlyMap<string, number>;
}) {
  const id = `package-${pkg.sequenceNo}-add`;
  const subjects = new Map(scope.subjects.map((s) => [s.subjectId, s] as const));
  const allegations = scope.allegations.filter((a) => !isClosedAllegation(a.status));
  return (
    <details className="mt-4 border-t border-cdf-border pt-3" data-testid={id}>
      <summary className="cursor-pointer font-semibold">{t("committeeProceedings.addItemTitle")}</summary>
      <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">{t("committeeProceedings.addItemIntro")}</p>
      <CDFCommandForm
        action={addItemAction.bind(null, committeeProceedingId, pkg.packageId)}
        locale={t.locale}
        submitLabel={t("committeeProceedings.addItem")}
        submitName={t("committeeProceedings.addItemName", { n: pkg.sequenceNo })}
        variant="primary"
        testId={`${id}-form`}
        successMessage={t("committeeProceedings.itemAdded")}
        codeSections={CODES}
        fieldLabels={{
          itemType: t("committeeProceedings.itemTypeLabel"),
          sanctionCode: t("committeeProceedings.sanctionCodeLabel"),
          proposedSanctionText: t("committeeProceedings.proposedSanctionLabel"),
          description: t("committeeProceedings.descriptionLabel"),
          subjectIds: t("committeeProceedings.subjectsLabel"),
          allegationIds: t("committeeProceedings.allegationsLabel"),
          dependsOnItemIds: t("committeeProceedings.dependsOnLabel"),
          exclusivityGroup: t("committeeProceedings.groupLabel"),
          requiresLegalJustification: t("committeeProceedings.legalJustificationLabel"),
        }}
      >
        <CDFField id={`${id}-type`} label={t("committeeProceedings.itemTypeLabel")}>
          <select
            id={`${id}-type`}
            name="itemType"
            className={inputClass}
            defaultValue=""
            required
            data-testid={`${id}-type`}
          >
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {RECOMMENDATION_ITEM_TYPES.map((x) => (
              <option key={x} value={x}>
                {itemTypeName(t, x)}
              </option>
            ))}
          </select>
        </CDFField>

        <fieldset className="mb-4 rounded-cdf-md border border-cdf-border p-3">
          <legend className="px-1 font-semibold">{t("committeeProceedings.sanctionTitle")}</legend>
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("committeeProceedings.sanctionIntro")}</p>
          <CDFField
            id={`${id}-code`}
            label={t("committeeProceedings.sanctionCodeLabel")}
            optionalLabel={t("common.optional")}
          >
            <select
              id={`${id}-code`}
              name="sanctionCode"
              className={inputClass}
              defaultValue=""
              data-testid={`${id}-code`}
            >
              <option value="">{t("committeeProceedings.noCode")}</option>
              {catalogue.map((s) => (
                <option key={s.code} value={s.code}>
                  {sanctionOption(t, s)}
                </option>
              ))}
            </select>
          </CDFField>
          <CDFField
            id={`${id}-proposed`}
            label={t("committeeProceedings.proposedSanctionLabel")}
            hint={t("committeeProceedings.proposedSanctionHint")}
            optionalLabel={t("common.optional")}
          >
            <textarea
              id={`${id}-proposed`}
              name="proposedSanctionText"
              className={textareaClass}
              aria-describedby={`${id}-proposed-hint`}
              maxLength={500}
            />
          </CDFField>
        </fieldset>

        <CDFField
          id={`${id}-description`}
          label={t("committeeProceedings.descriptionLabel")}
          hint={t("committeeProceedings.descriptionHint")}
        >
          <textarea
            id={`${id}-description`}
            name="description"
            className={textareaClass}
            aria-describedby={`${id}-description-hint`}
            minLength={10}
            maxLength={4000}
            required
          />
        </CDFField>

        <fieldset className="mb-4 rounded-cdf-md border border-cdf-border p-3">
          <legend className="px-1 font-semibold">{t("committeeProceedings.aboutTitle")}</legend>
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("committeeProceedings.aboutIntro")}</p>
          <Checks
            id={`${id}-subject`}
            name="subjectIds"
            legend={t("committeeProceedings.subjectsLabel")}
            empty={t("committeeProceedings.noSubjects")}
            options={scope.subjects.map((s) => ({ value: s.subjectId, label: subjectName(t, s) }))}
          />
          <Checks
            id={`${id}-allegation`}
            name="allegationIds"
            legend={t("committeeProceedings.allegationsLabel")}
            empty={t("committeeProceedings.noAllegations")}
            options={allegations.map((a) => {
              const about = a.subjectId ? subjects.get(a.subjectId) : undefined;
              return {
                value: a.allegationId,
                label: about
                  ? t("committeeProceedings.allegationAbout", {
                      allegation: allegationName(t, a),
                      subject: isolate(subjectName(t, about)),
                    })
                  : allegationName(t, a),
              };
            })}
          />
        </fieldset>

        {pkg.items.length > 0 ? (
          <Checks
            id={`${id}-depends`}
            name="dependsOnItemIds"
            legend={t("committeeProceedings.dependsOnLabel")}
            hint={t("committeeProceedings.dependsOnHint")}
            empty=""
            options={pkg.items.map((i) => ({
              value: i.itemId,
              label: `${t("committeeProceedings.itemNumber", { n: itemNo.get(i.itemId) ?? 0 })} · ${itemTypeName(t, i.itemType)}`,
            }))}
          />
        ) : null}

        <CDFField
          id={`${id}-group`}
          label={t("committeeProceedings.groupLabel")}
          hint={t("committeeProceedings.groupHint")}
          optionalLabel={t("common.optional")}
        >
          <input
            id={`${id}-group`}
            name="exclusivityGroup"
            dir="ltr"
            className={inputClass}
            aria-describedby={`${id}-group-hint`}
            maxLength={60}
            autoCapitalize="characters"
            spellCheck={false}
          />
        </CDFField>

        <div className="mb-4">
          <div className="flex items-start gap-2">
            <input
              id={`${id}-legal`}
              name="requiresLegalJustification"
              type="checkbox"
              className="mt-1 size-5"
              aria-describedby={`${id}-legal-hint`}
              data-testid={`${id}-legal`}
            />
            <label htmlFor={`${id}-legal`} className="font-semibold">
              {t("committeeProceedings.legalJustificationLabel")}
            </label>
          </div>
          <p id={`${id}-legal-hint`} className="ms-7 text-sm text-cdf-text-secondary">
            {t("committeeProceedings.legalJustificationHint")}
          </p>
        </div>
      </CDFCommandForm>
    </details>
  );
}

/**
 * Creating a package, for the committee's secretary while the proceeding is open and the case active
 * (`may_create_package`, 2086). How it is voted is chosen once: as a whole, or item by item.
 */
export function CreatePackageForm({
  t,
  committeeProceedingId,
  label,
}: {
  t: Translator;
  committeeProceedingId: string;
  label: string;
}) {
  const id = "create-package";
  return (
    <details className="mb-6 rounded-cdf-lg border border-cdf-border bg-cdf-surface p-4" data-testid={id}>
      <summary className="cursor-pointer font-semibold">{t("committeeProceedings.createTitle")}</summary>
      <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">{t("committeeProceedings.createIntro")}</p>
      <CDFCommandForm
        action={createPackageAction.bind(null, committeeProceedingId)}
        locale={t.locale}
        submitLabel={actLabel(t, "createRecommendationPackage")}
        submitName={t("committeeProceedings.createName", { ref: isolate(label) })}
        variant="primary"
        testId={`${id}-form`}
        successMessage={t("committeeProceedings.created")}
        codeSections={CODES}
        fieldLabels={{ voteGranularity: t("committeeProceedings.granularityLabel") }}
        confirm={confirmation(t, "createRecommendationPackage")}
      >
        <fieldset className="mb-4">
          <legend className="mb-1 font-semibold">{t("committeeProceedings.granularityLabel")}</legend>
          {VOTE_GRANULARITIES.map((g) => (
            <div key={g} className="mb-2 flex items-start gap-2">
              <input
                id={`${id}-${g}`}
                type="radio"
                name="voteGranularity"
                value={g}
                className="mt-1 size-5"
                required
                aria-describedby={`${id}-${g}-hint`}
                data-testid={`${id}-${g}`}
              />
              <div>
                <label htmlFor={`${id}-${g}`}>
                  {t(`committeeProceedings.granularity.${g}` as MessageKey)}
                </label>
                <p id={`${id}-${g}-hint`} className="text-sm text-cdf-text-secondary">
                  {t(`committeeProceedings.granularityHint.${g}` as MessageKey)}
                </p>
              </div>
            </div>
          ))}
          <CDFFieldError id={`${id}-${VOTE_GRANULARITIES[0]}`} />
        </fieldset>
      </CDFCommandForm>
    </details>
  );
}
