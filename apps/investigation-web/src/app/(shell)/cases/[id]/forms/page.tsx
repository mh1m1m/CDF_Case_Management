// Forms on a case (Phase 8; ADR-011): the started instances and the WB-FRM registry with a start control
// for every form the database would let this user prepare (hidden ≠ forbidden: api.start_form re-checks).
import type { Metadata } from "next";
import Link from "next/link";
import { CLASSIFICATION_LEVELS, type FormDefinitionListItem, type FormInstanceSummary } from "@cdf/contracts";
import { formDisplayNumber } from "@cdf/domain";
import { formatDateTime, type MessageKey } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFCommandForm,
  CDFField,
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

export default async function CaseFormsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, ctx, t, c } = await loadCase(id);
  const [definitions, instances] = await Promise.all([
    formsService().listDefinitions(ctx, id),
    formsService().listInstances(ctx, id),
  ]);
  const name = (x: { nameAr: string; nameEn: string }) => (t.locale === "ar" ? x.nameAr : x.nameEn);
  const levels = CLASSIFICATION_LEVELS.filter(
    (l) =>
      CLASSIFICATION_LEVELS.indexOf(l) >= CLASSIFICATION_LEVELS.indexOf(c.classification) &&
      CLASSIFICATION_LEVELS.indexOf(l) <= CLASSIFICATION_LEVELS.indexOf(actor.clearance),
  );

  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="forms">
      <p className="mb-4 text-cdf-text-secondary">{t("forms.intro")}</p>
      <CDFCard title={t("forms.instances")} testId="form-instances">
        <CDFTable<FormInstanceSummary>
          caption={t("forms.instances")}
          testId="form-instances-table"
          rows={instances}
          rowKey={(i) => i.id}
          empty={t("forms.noInstances")}
          columns={[
            {
              header: t("forms.number"),
              cell: (i) => (
                <Link
                  href={`/cases/${c.id}/forms/${i.id}`}
                  className="font-semibold underline underline-offset-4"
                  dir="ltr"
                  data-testid={`form-instance-${i.formCode}-${i.instanceNo}`}
                >
                  {formDisplayNumber(i.formCode, i.instanceNo)}
                </Link>
              ),
            },
            { header: t("forms.name"), cell: (i) => (t.locale === "ar" ? i.formNameAr : i.formNameEn) },
            {
              header: t("forms.status"),
              cell: (i) => (
                <CDFBadge tone={statusTone(i.status)}>{t(`formStatus.${i.status}` as MessageKey)}</CDFBadge>
              ),
            },
            {
              header: t("forms.classification"),
              cell: (i) => (
                <CDFBadge tone={classificationTone(i.classification)}>
                  {t(`classification.${i.classification}` as MessageKey)}
                </CDFBadge>
              ),
            },
            {
              header: t("forms.version"),
              cell: (i) =>
                i.currentVersionNo ? (
                  <span dir="ltr">
                    v{i.currentVersionNo} · <code className="text-xs">{i.contentHash?.slice(0, 12)}…</code>
                  </span>
                ) : (
                  "—"
                ),
            },
            {
              header: t("forms.by"),
              cell: (i) => `${i.createdByName ?? "—"} · ${formatDateTime(t.locale, i.updatedAt)}`,
            },
          ]}
        />
      </CDFCard>

      <CDFCard title={t("forms.registry")} testId="form-registry">
        <CDFTable<FormDefinitionListItem>
          caption={t("forms.registry")}
          testId="form-registry-table"
          rows={definitions}
          rowKey={(d) => d.code}
          empty={t("common.none")}
          columns={[
            {
              header: t("forms.code"),
              cell: (d) => (
                <span dir="ltr" className="font-semibold" data-testid={`form-def-${d.code}`}>
                  {d.code}
                </span>
              ),
            },
            {
              header: t("forms.name"),
              cell: (d) => (
                <>
                  <span className="font-semibold">{name(d)}</span>
                  <br />
                  <span className="text-cdf-text-secondary">
                    {t.locale === "ar" ? d.purposeAr : d.purposeEn}
                  </span>
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
            {
              header: t("forms.start"),
              cell: (d) =>
                d.canStart && d.isEnabled ? (
                  <CDFCommandForm
                    action={startFormAction.bind(null, c.id, d.code)}
                    locale={t.locale}
                    submitLabel={t("forms.start")}
                    variant="secondary"
                    testId={`start-${d.code}`}
                    fieldLabels={{ classification: t("forms.classification") }}
                  >
                    <CDFField id={`classification-${d.code}`} label={t("forms.classification")}>
                      <select
                        id={`classification-${d.code}`}
                        name="classification"
                        className={inputClass}
                        defaultValue={c.classification}
                      >
                        {levels.map((l) => (
                          <option key={l} value={l}>
                            {t(`classification.${l}` as MessageKey)}
                          </option>
                        ))}
                      </select>
                    </CDFField>
                  </CDFCommandForm>
                ) : (
                  "—"
                ),
            },
          ]}
        />
      </CDFCard>
    </CaseWorkspace>
  );
}
