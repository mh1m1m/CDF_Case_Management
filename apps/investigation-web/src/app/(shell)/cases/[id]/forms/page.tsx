// The case's Forms tab (UX redesign S2g; audit §23.13, O11 §11.9.2; UX-068, UX-086, UX-128). Started forms are
// grouped by what each one needs from the viewer, using the database's own rules (the capabilities the form page
// uses; the commands re-check). A form returned to its preparer says so, with the reason first. Starting another
// form is one disclosure away, lists only the forms this viewer may start here, and asks before it creates a
// permanent record. The register of all 19 forms stays available on demand.
import type { Metadata } from "next";
import Link from "next/link";
import type { FormDefinitionListItem, FormInstanceListItem } from "@cdf/contracts";
import {
  FORM_TAB_GROUPS,
  formDisplayNumber,
  formNextStep,
  formTabGroup,
  formWaitingAction,
  type FormTabGroup,
} from "@cdf/domain";
import { formatDateTime, formatList, isolate, type MessageKey } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFCommandForm,
  CDFEmptyState,
  CDFField,
  CDFIdentifier,
  CDFMeta,
  CDFTable,
  classificationTone,
  inputClass,
} from "@cdf/ui";
import { formsService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { startFormAction } from "./actions";
import { statusTone } from "./form-fields";
import { CaseWorkspace, loadCase } from "../workspace";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or case content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.caseForms") };
}

const disclosure = "mb-6 rounded-cdf-lg border border-cdf-border bg-cdf-surface p-4 shadow-cdf";
// The browser's own disclosure marker stays (as elsewhere in the case pages), so a closed group reads as openable.
const summary = "min-h-11 cursor-pointer py-2 font-semibold";

export default async function CaseFormsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, ctx, t, c } = await loadCase(id);
  const [definitions, instances] = await Promise.all([
    formsService().listDefinitions(ctx, id),
    formsService().listInstances(ctx, id),
  ]);
  const name = (x: { nameAr: string; nameEn: string }) => (t.locale === "ar" ? x.nameAr : x.nameEn);
  const purpose = (d: FormDefinitionListItem) => (t.locale === "ar" ? d.purposeAr : d.purposeEn);
  const when = (iso: string) => isolate(formatDateTime(t.locale, iso));
  // From the case's level up to the caller's clearance, read with the case (UX-116).
  const levels = c.can.classifications;
  const level = (l: string) => t(`classification.${l}` as MessageKey);
  const startable = definitions.filter((d) => d.canStart && d.isEnabled);
  const group = Object.fromEntries(
    FORM_TAB_GROUPS.map((g) => [g, instances.filter((i) => formTabGroup(i) === g)]),
  ) as Record<FormTabGroup, FormInstanceListItem[]>;

  const nextLine = (i: FormInstanceListItem): string | null => {
    const step = formNextStep(i.status, i.finalStatus);
    if (!step) return null;
    const stepText = t(`forms.tab.next.${step}` as MessageKey);
    if (step === "PREPARE" && i.capabilities.canSave) return t("forms.tab.nextYou", { step: stepText });
    const roles = i.nextRoles.map((r) => t(`role.${r}` as MessageKey));
    const line = roles.length
      ? t("forms.tab.nextBy", { step: stepText, roles: isolate(formatList(t.locale, roles, "disjunction")) })
      : stepText;
    // Separation of duties, as the commands enforce it: say it, so a preparer is not left wondering.
    if (step === "REVIEW") return t("forms.tab.notPreparer", { line });
    return step === "APPROVE" ? t("forms.tab.notPreparerOrReviewer", { line }) : line;
  };

  const row = (i: FormInstanceListItem) => {
    const formName = t.locale === "ar" ? i.formNameAr : i.formNameEn;
    const act = formWaitingAction(i);
    const next = act ? null : nextLine(i);
    return (
      <li
        key={i.id}
        data-testid={`form-row-${i.formCode}-${i.instanceNo}`}
        className="grid gap-1 rounded-cdf-md border border-cdf-border p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {/* One link per form; when it waits for the viewer, the link names the act (UX-128). */}
          <Link
            href={`/cases/${c.id}/forms/${i.id}`}
            className="font-semibold underline underline-offset-4"
            data-testid={`form-instance-${i.formCode}-${i.instanceNo}`}
          >
            {act
              ? t("forms.tab.actOn", { act: t(`forms.tab.act.${act}` as MessageKey), name: formName })
              : formName}
          </Link>
          <span className="flex flex-wrap gap-2">
            <CDFBadge tone={statusTone(i.status)}>{t(`formStatus.${i.status}` as MessageKey)}</CDFBadge>
            <CDFBadge tone={classificationTone(i.classification)}>{level(i.classification)}</CDFBadge>
          </span>
        </div>
        <CDFMeta
          parts={[
            {
              key: "number",
              value: <CDFIdentifier>{formDisplayNumber(i.formCode, i.instanceNo)}</CDFIdentifier>,
            },
            {
              key: "version",
              value: i.currentVersionNo
                ? t("forms.tab.version", { no: i.currentVersionNo })
                : t("forms.tab.noVersion"),
            },
            {
              key: "by",
              value:
                i.preparedByName && i.preparedAt
                  ? t("forms.tab.preparedBy", { name: isolate(i.preparedByName), date: when(i.preparedAt) })
                  : t("forms.tab.startedBy", {
                      name: isolate(i.createdByName ?? "—"),
                      date: when(i.createdAt),
                    }),
            },
          ]}
        />
        {i.returned ? (
          // The reason first (audit §23.3): what to change, then who asked and when.
          <div className="text-sm" data-testid="form-returned">
            <p>
              <span className="font-semibold">
                {i.returned.toMe ? t("forms.tab.returnedToYou") : t("forms.tab.returnedForChanges")}
              </span>
              {i.returned.reason ? (
                <>
                  {": "}
                  <q className="break-words">
                    <bdi>{i.returned.reason}</bdi>
                  </q>
                </>
              ) : null}
            </p>
            <p className="text-cdf-text-secondary">
              {t("forms.tab.returnedBy", {
                name: isolate(i.returned.byName ?? "—"),
                date: when(i.returned.at),
              })}
            </p>
          </div>
        ) : null}
        {next ? (
          <p className="text-sm" data-testid="form-next">
            {next}
          </p>
        ) : null}
      </li>
    );
  };
  const list = (items: FormInstanceListItem[], testId: string) => (
    <ul className="grid gap-3" data-testid={testId}>
      {items.map(row)}
    </ul>
  );
  const titled = (key: MessageKey, n: number) => `${t(key)} (${n})`;

  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="forms">
      <p className="mb-4 max-w-prose text-cdf-text-secondary">{t("forms.intro")}</p>

      {startable.length > 0 ? (
        <details className={disclosure} data-testid="start-another-form">
          <summary className={summary}>{t("forms.tab.startOpen")}</summary>
          <p className="mt-2 text-sm text-cdf-text-secondary">{t("forms.tab.startIntro")}</p>
          <ul className="mt-3 grid gap-4">
            {startable.map((d) => (
              <li
                key={d.code}
                data-testid={`start-option-${d.code}`}
                className="grid gap-1 border-t border-cdf-border pt-3"
              >
                <h3 className="font-semibold">
                  {name(d)}{" "}
                  <span className="text-sm font-normal text-cdf-text-secondary">
                    <CDFIdentifier>{d.code}</CDFIdentifier>
                  </span>
                </h3>
                <p className="max-w-prose text-sm">{purpose(d)}</p>
                <p className="mb-2 text-sm text-cdf-text-secondary">
                  {d.approvalRequired
                    ? t("forms.tab.startApproved")
                    : d.reviewRequired
                      ? t("forms.tab.startReviewed")
                      : t("forms.tab.startNoReview")}
                </p>
                <CDFCommandForm
                  action={startFormAction.bind(null, c.id, d.code)}
                  locale={t.locale}
                  submitLabel={t("forms.tab.startButton")}
                  submitName={t("forms.tab.startName", { name: name(d) })}
                  variant="secondary"
                  testId={`start-${d.code}`}
                  fieldLabels={{ classification: t("forms.classification") }}
                  confirm={{
                    title: t("forms.tab.confirmTitle", { name: name(d) }),
                    whatHappens: t("forms.tab.confirmWhat"),
                    undo: t("forms.tab.confirmUndo"),
                    affected: t("forms.tab.confirmAffected"),
                    confirmLabel: t("forms.tab.confirmButton"),
                    cancelLabel: t("confirm.cancel"),
                    labels: {
                      whatHappens: t("confirm.whatHappens"),
                      undo: t("confirm.canUndo"),
                      affected: t("confirm.whoAffected"),
                    },
                    tone: "primary",
                  }}
                >
                  {levels.length > 1 ? (
                    <CDFField
                      id={`classification-${d.code}`}
                      label={t("forms.classification")}
                      hint={t("forms.tab.classificationHint")}
                    >
                      <select
                        id={`classification-${d.code}`}
                        name="classification"
                        className={inputClass}
                        defaultValue={c.classification}
                        aria-describedby={`classification-${d.code}-hint`}
                      >
                        {levels.map((l) => (
                          <option key={l} value={l}>
                            {level(l)}
                          </option>
                        ))}
                      </select>
                    </CDFField>
                  ) : (
                    <>
                      <input type="hidden" name="classification" value={c.classification} />
                      <p className="mb-3 text-sm">
                        {t("forms.tab.fromCase", { level: level(c.classification) })}
                      </p>
                    </>
                  )}
                </CDFCommandForm>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {instances.length === 0 ? (
        // Says nothing about forms the viewer cannot see (§40).
        <CDFEmptyState title={t("forms.tab.empty")} testId="forms-empty" />
      ) : (
        <>
          <CDFCard title={titled("forms.tab.waiting", group.WAITING.length)} testId="forms-waiting">
            {group.WAITING.length ? (
              list(group.WAITING, "forms-waiting-list")
            ) : (
              <p className="text-cdf-text-secondary">{t("forms.tab.nothingWaiting")}</p>
            )}
          </CDFCard>
          {group.IN_PROGRESS.length ? (
            <CDFCard
              title={titled("forms.tab.inProgress", group.IN_PROGRESS.length)}
              testId="forms-in-progress"
            >
              {list(group.IN_PROGRESS, "forms-in-progress-list")}
            </CDFCard>
          ) : null}
          {group.COMPLETED.length ? (
            <details className={disclosure} data-testid="forms-completed">
              <summary className={summary}>{titled("forms.tab.completed", group.COMPLETED.length)}</summary>
              <div className="mt-3">{list(group.COMPLETED, "forms-completed-list")}</div>
            </details>
          ) : null}
          {group.WITHDRAWN.length ? (
            <details className={disclosure} data-testid="forms-withdrawn">
              <summary className={summary}>{titled("forms.tab.withdrawn", group.WITHDRAWN.length)}</summary>
              <div className="mt-3">{list(group.WITHDRAWN, "forms-withdrawn-list")}</div>
            </details>
          ) : null}
        </>
      )}

      <details className={disclosure} data-testid="form-registry">
        <summary className={summary}>{titled("forms.tab.register", definitions.length)}</summary>
        <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">{t("forms.tab.registerIntro")}</p>
        <CDFTable<FormDefinitionListItem>
          caption={t("forms.tab.register")}
          testId="form-registry-table"
          rows={definitions}
          rowKey={(d) => d.code}
          empty={t("common.none")}
          columns={[
            {
              header: t("forms.code"),
              cell: (d) => (
                <span className="font-semibold" data-testid={`form-def-${d.code}`}>
                  <CDFIdentifier>{d.code}</CDFIdentifier>
                </span>
              ),
            },
            {
              header: t("forms.name"),
              cell: (d) => (
                <>
                  <span className="font-semibold">{name(d)}</span>
                  <br />
                  <span className="text-cdf-text-secondary">{purpose(d)}</span>
                </>
              ),
            },
            { header: t("forms.owner"), cell: (d) => t(`formOwner.${d.ownerRoleHint}` as MessageKey) },
            {
              header: t("forms.colReview"),
              cell: (d) => (d.reviewRequired ? t("forms.required") : t("forms.notRequired")),
            },
            {
              header: t("forms.colApproval"),
              cell: (d) => (d.approvalRequired ? t("forms.required") : t("forms.notRequired")),
            },
          ]}
        />
      </details>
    </CaseWorkspace>
  );
}
