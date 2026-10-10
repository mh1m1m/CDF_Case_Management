// Records officer queue and "my work" (CDF-71; ADR-013, ADR-014). The catalogue lists only rows the database
// returns for the caller's catalogue scope, and the counts are the caller's own work: never a list or count
// of all investigations (§17, §18). Navigation hides the page from others; this page refuses them too.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, navigationFor } from "@cdf/authorization";
import { RECORDS_STATES, type MyCaseTask, type RecordsCatalogueEntry } from "@cdf/contracts";
import { formatDate, formatDateTime, type MessageKey } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFDescriptionList,
  CDFField,
  CDFPageHeader,
  CDFTable,
  buttonClass,
  classificationTone,
  inputClass,
} from "@cdf/ui";
import { investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { ActionForm } from "../action-form";
import { AppNav } from "../app-nav";
import { refreshEligibilityAction } from "./actions";
import { LegalHoldBadge, RecordsStateBadge } from "./badges";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.records") };
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function RecordsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { actor, ctx } = await requireActor();
  const nav = navigationFor(actor);
  if (!nav.recordsCatalogue && !nav.myWork) notFound();
  const t = await getTranslator();
  const service = investigationService();
  const sp = await searchParams;
  const filters = {
    caseNumber: one(sp.caseNumber),
    archiveStatus: one(sp.state),
    legalHoldStatus: one(sp.hold),
  };

  const [catalogue, summary, tasks] = await Promise.all([
    nav.recordsCatalogue ? service.searchRecordsCatalogue(ctx, actor, filters) : Promise.resolve(null),
    nav.myWork ? service.myWorkSummary(ctx) : Promise.resolve(null),
    nav.myWork ? service.myCaseTasks(ctx) : Promise.resolve([]),
  ]);
  const caseLink = (caseId: string, caseNumber: string, testId: string) => (
    <Link
      href={`/records/${caseId}`}
      dir="ltr"
      className="font-semibold underline underline-offset-4"
      data-testid={testId}
      aria-label={t("records.openRecord", { number: caseNumber })}
    >
      {caseNumber}
    </Link>
  );

  return (
    <>
      <AppNav actor={actor} t={t} current="records" />
      <CDFPageHeader
        title={t("records.title")}
        intro={t("records.intro")}
        actions={
          <Link
            href="/records/legal-holds"
            className={buttonClass("secondary")}
            data-testid="legal-holds-link"
          >
            {t("records.legalHoldsLink")}
          </Link>
        }
      />

      {summary ? (
        <CDFCard title={t("records.myWorkTitle")} testId="my-work-card">
          <CDFDescriptionList
            items={(Object.keys(summary) as (keyof typeof summary)[]).map((k) => ({
              term: t(`records.summary.${k}` as MessageKey),
              value: <span data-testid={`my-work-${k}`}>{summary[k]}</span>,
            }))}
          />
          <h3 className="mb-2 mt-4 font-semibold">{t("records.tasksTitle")}</h3>
          <CDFTable<MyCaseTask>
            caption={t("records.tasksTitle")}
            testId="my-tasks-table"
            rows={tasks}
            rowKey={(r) => r.taskId}
            empty={t("records.tasksEmpty")}
            columns={[
              {
                header: t("records.caseNumber"),
                cell: (r) =>
                  r.caseNumber
                    ? caseLink(r.caseId, r.caseNumber, `task-case-${r.taskId}`)
                    : t("records.caseHidden"),
              },
              { header: t("records.taskType"), cell: (r) => t.code("records.taskTypeName", r.taskType) },
              { header: t("records.taskStatus"), cell: (r) => t.code("records.taskStatusName", r.status) },
              { header: t("records.taskExpires"), cell: (r) => formatDateTime(t.locale, r.expiresAt) },
            ]}
          />
        </CDFCard>
      ) : null}

      {catalogue ? (
        <CDFCard title={t("records.catalogueTitle")} testId="catalogue-card">
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("records.catalogueIntro")}</p>
          {/* A GET form: filters are in the URL and the database filters every row again (§40). */}
          <form method="get" className="mb-4 grid gap-x-4 sm:grid-cols-3" data-testid="catalogue-search">
            <CDFField
              id="caseNumber"
              label={t("records.searchCaseNumber")}
              hint={t("records.searchCaseNumberHint")}
            >
              <input
                id="caseNumber"
                name="caseNumber"
                dir="ltr"
                defaultValue={filters.caseNumber ?? ""}
                className={inputClass}
                maxLength={20}
                pattern="[A-Za-z0-9-]*"
                aria-describedby="caseNumber-hint"
              />
            </CDFField>
            <CDFField id="state" label={t("records.searchState")}>
              <select
                id="state"
                name="state"
                defaultValue={filters.archiveStatus ?? ""}
                className={inputClass}
              >
                <option value="">{t("records.any")}</option>
                {RECORDS_STATES.filter((s) => s !== "ACTIVE").map((s) => (
                  <option key={s} value={s}>
                    {t(`records.state.${s}` as MessageKey)}
                  </option>
                ))}
              </select>
            </CDFField>
            <CDFField id="hold" label={t("records.searchHold")}>
              <select
                id="hold"
                name="hold"
                defaultValue={filters.legalHoldStatus ?? ""}
                className={inputClass}
              >
                <option value="">{t("records.any")}</option>
                <option value="ACTIVE">{t("records.holdStatus.ACTIVE")}</option>
                <option value="NONE">{t("records.holdStatus.NONE")}</option>
              </select>
            </CDFField>
            <div>
              <button
                type="submit"
                className={buttonClass("secondary")}
                data-testid="catalogue-search-submit"
              >
                {t("records.search")}
              </button>
            </div>
          </form>
          {catalogue.ok ? (
            <>
              <p className="mb-2 text-sm" data-testid="catalogue-total">
                {t("records.total", { count: catalogue.value.total })}
              </p>
              <CDFTable<RecordsCatalogueEntry>
                caption={t("records.catalogueTitle")}
                testId="catalogue-table"
                rows={catalogue.value.items}
                rowKey={(r) => r.caseId}
                empty={t("records.catalogueEmpty")}
                columns={[
                  {
                    header: t("records.caseNumber"),
                    cell: (r) => caseLink(r.caseId, r.caseNumber, `record-${r.caseNumber}`),
                  },
                  {
                    header: t("records.classification"),
                    cell: (r) => (
                      <CDFBadge tone={classificationTone(r.classification)}>
                        {t(`classification.${r.classification}` as MessageKey)}
                      </CDFBadge>
                    ),
                  },
                  {
                    header: t("records.recordsState"),
                    cell: (r) => <RecordsStateBadge state={r.archiveStatus} t={t} />,
                  },
                  {
                    header: t("records.legalHold"),
                    cell: (r) => (
                      <LegalHoldBadge
                        status={r.legalHoldStatus}
                        t={t}
                        testId={`record-hold-${r.caseNumber}`}
                      />
                    ),
                  },
                  {
                    header: t("records.retentionClass"),
                    cell: (r) => <span dir="ltr">{r.retentionClass}</span>,
                  },
                  {
                    header: t("records.closed"),
                    cell: (r) => (r.closedDate ? formatDate(t.locale, r.closedDate) : t("records.notSet")),
                  },
                  {
                    header: t("records.retainUntil"),
                    cell: (r) =>
                      r.retentionEndDate ? formatDate(t.locale, r.retentionEndDate) : t("records.notSet"),
                  },
                ]}
              />
            </>
          ) : (
            <p className="text-cdf-text-secondary" data-testid="catalogue-invalid">
              {t("errors.INVALID")}
            </p>
          )}
        </CDFCard>
      ) : null}

      {can(actor, "DISPOSITION_REQUEST") ? (
        <CDFCard title={t("records.refreshTitle")} testId="refresh-card">
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("records.refreshIntro")}</p>
          <ActionForm
            action={refreshEligibilityAction}
            locale={t.locale}
            submitLabel={t("records.refresh")}
            variant="secondary"
            testId="refresh-eligibility-form"
            successMessage={t("records.refreshDone")}
          />
        </CDFCard>
      ) : null}
    </>
  );
}
