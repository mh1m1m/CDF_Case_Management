// Asking for an export of a case «طلب تصدير» (UX redesign Phase 12 P12-6b-1; ADR-026; DEC-F21, F1 of the P12-6b map):
// a page of the case's own. The case opens as every case page does (audited by api.open_case; a hidden case is the
// uniform 404), then the page mirrors the command's own checks, in its order: whoever may see the case, then
// EXPORT_REQUEST; anyone else gets the same 404. The purposes are the governed catalogue's active ones (DEC-F21), named
// in the reader's language. The request starts as a draft that only its requester sees; nothing leaves the platform
// until it is submitted, approved and generated, on its own page. The command checks everything again.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@cdf/authorization";
import { EXPORT_AUDIENCES, EXPORT_FORMATS, EXPORT_PURPOSES, type ExportPurposeEntry } from "@cdf/contracts";
import type { MessageKey, Translator } from "@cdf/i18n";
import {
  CDFCard,
  CDFCommandForm,
  CDFField,
  CDFFieldError,
  CDFPurposeBanner,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { exportService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { EXPORT_CODES, purposeName } from "../../../exports/labels";
import { CaseWorkspace, loadCase } from "../workspace";
import { requestExportAction } from "./actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or case content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.requestExport") };
}

const OFFERED: readonly string[] = EXPORT_PURPOSES;

export default async function RequestExportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, ctx, t, c } = await loadCase(id);
  if (!can(actor, "EXPORT_REQUEST")) notFound();
  // The catalogue's active purposes that a new request may name; a legacy purpose is never offered.
  const purposes = (await exportService().purposes(ctx)).filter(
    (p) => p.isActive && !p.isLegacy && OFFERED.includes(p.code),
  );

  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="overview" item={t("exports.requestBreadcrumb")}>
      <h2 className="mb-3 text-cdf-h2 font-semibold">{t("exports.requestPageTitle")}</h2>
      <CDFPurposeBanner
        title={t("exports.requestPurposeTitle")}
        purpose={t("exports.requestPurposeBody")}
        notShown={t("exports.requestPurposeNotShown")}
        testId="request-export-banner"
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <CDFCard title={t("exports.requestFormTitle")} testId="request-export">
            <RequestForm t={t} caseId={c.id} purposes={purposes} />
          </CDFCard>
        </div>
        <div className="min-w-0">
          <CDFCard title={t("exports.howTitle")} testId="request-export-how">
            <ol className="grid list-decimal gap-2 ps-5">
              {(["prepare", "preview", "approve", "send"] as const).map((k) => (
                <li key={k}>{t(`exports.how.${k}` as MessageKey)}</li>
              ))}
            </ol>
          </CDFCard>
        </div>
      </div>
    </CaseWorkspace>
  );
}

function RequestForm({
  t,
  caseId,
  purposes,
}: {
  t: Translator;
  caseId: string;
  purposes: readonly ExportPurposeEntry[];
}) {
  const provisional = purposes.some((p) => p.sourceStatus !== "APPROVED");
  return (
    <CDFCommandForm
      action={requestExportAction.bind(null, caseId)}
      locale={t.locale}
      submitLabel={t("exports.createRequest")}
      variant="primary"
      testId="request-export-form"
      codeSections={EXPORT_CODES}
      fieldLabels={{
        format: t("exports.formatLabel"),
        audience: t("exports.audienceLabel"),
        purpose: t("exports.purposeLabel"),
        externalParty: t("exports.externalPartyLabel"),
        justification: t("exports.justificationLabel"),
      }}
    >
      <fieldset className="mb-4">
        <legend className="mb-1 font-semibold">{t("exports.formatLabel")}</legend>
        {EXPORT_FORMATS.map((f) => (
          <div key={f} className="mb-2 flex items-start gap-2">
            <input
              id={`request-export-format-${f}`}
              type="radio"
              name="format"
              value={f}
              className="mt-1 size-5 shrink-0"
              required
              aria-describedby={`request-export-format-${f}-hint`}
              data-testid={`request-export-format-${f}`}
            />
            <div>
              <label htmlFor={`request-export-format-${f}`}>{t(`exports.format.${f}` as MessageKey)}</label>
              <p id={`request-export-format-${f}-hint`} className="text-sm text-cdf-text-secondary">
                {t(`exports.formatHint.${f}` as MessageKey)}
              </p>
            </div>
          </div>
        ))}
        <CDFFieldError id={`request-export-format-${EXPORT_FORMATS[0]}`} />
      </fieldset>
      <fieldset className="mb-4">
        <legend className="mb-1 font-semibold">{t("exports.audienceLabel")}</legend>
        {EXPORT_AUDIENCES.map((a) => (
          <div key={a} className="mb-2 flex items-start gap-2">
            <input
              id={`request-export-audience-${a}`}
              type="radio"
              name="audience"
              value={a}
              className="mt-1 size-5 shrink-0"
              required
              aria-describedby={`request-export-audience-${a}-hint`}
              data-testid={`request-export-audience-${a}`}
            />
            <div>
              <label htmlFor={`request-export-audience-${a}`}>
                {t(`exports.audience.${a}` as MessageKey)}
              </label>
              <p id={`request-export-audience-${a}-hint`} className="text-sm text-cdf-text-secondary">
                {t(`exports.audienceHint.${a}` as MessageKey)}
              </p>
            </div>
          </div>
        ))}
        <CDFFieldError id={`request-export-audience-${EXPORT_AUDIENCES[0]}`} />
      </fieldset>
      <CDFField
        id="request-export-purpose"
        label={t("exports.purposeLabel")}
        hint={t(provisional ? "exports.purposeHintProvisional" : "exports.purposeHint")}
        requiredLabel={t("common.required")}
      >
        <select
          id="request-export-purpose"
          name="purpose"
          className={inputClass}
          required
          defaultValue=""
          aria-describedby="request-export-purpose-hint"
          data-testid="request-export-purpose"
        >
          <option value="" disabled>
            {t("common.choose")}
          </option>
          {purposes.map((p) => (
            <option key={p.code} value={p.code}>
              {purposeName(t, p, p.code)}
            </option>
          ))}
        </select>
      </CDFField>
      <CDFField
        id="request-export-external-party"
        label={t("exports.externalPartyLabel")}
        hint={t("exports.externalPartyHint")}
        optionalLabel={t("exports.externalOnly")}
      >
        <input
          id="request-export-external-party"
          name="externalParty"
          dir="auto"
          className={inputClass}
          maxLength={200}
          aria-describedby="request-export-external-party-hint"
          data-testid="request-export-external-party"
        />
      </CDFField>
      <CDFField
        id="request-export-justification"
        label={t("exports.justificationLabel")}
        hint={t("exports.justificationHint")}
        optionalLabel={t("exports.sometimesRequired")}
      >
        <textarea
          id="request-export-justification"
          name="justification"
          className={textareaClass}
          maxLength={2000}
          aria-describedby="request-export-justification-hint"
          data-testid="request-export-justification"
        />
      </CDFField>
    </CDFCommandForm>
  );
}
