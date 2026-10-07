"use client";
import { useState, useTransition } from "react";
import { useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { REPORT_CATEGORIES } from "@cdf/contracts";
import { createTranslator, type Locale, type MessageKey } from "@cdf/i18n";
import { CDFAlert, CDFCard, CDFField, buttonClass, fieldIds, inputClass, textareaClass } from "@cdf/ui";
import { submitReportSchema, type SubmitReport, type SubmitReportInput } from "@cdf/validation";
import { submitReportAction, type SubmitResult } from "./actions";
import { ReportReceipt } from "./report-receipt";

export function ReportForm({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [pending, startTransition] = useTransition();
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors },
  } = useForm<SubmitReportInput, unknown, SubmitReport>({
    // The schema's input type widens `identity` to unknown (validated only when identified); narrow it for the form.
    resolver: zodResolver(submitReportSchema) as unknown as Resolver<
      SubmitReportInput,
      unknown,
      SubmitReport
    >,
    defaultValues: {
      reporterMode: "ANONYMOUS",
      language: locale,
      identity: { preferredContact: "PORTAL_ONLY" },
    },
  });
  const mode = useWatch({ control, name: "reporterMode" });
  const err = (key: string | undefined) => (key ? t(key as MessageKey) : undefined);

  if (result?.status === "ok")
    return <ReportReceipt locale={locale} reportRef={result.reportRef} secret={result.secret} />;

  const onSubmit = handleSubmit((values) =>
    startTransition(async () => {
      const r = await submitReportAction(values);
      if (r.status === "invalid") {
        for (const [field, key] of Object.entries(r.fieldErrors)) setError(field as never, { message: key });
      }
      setResult(r);
    }),
  );

  const e = {
    category: err(errors.category?.message),
    subjectDescription: err(errors.subjectDescription?.message),
    description: err(errors.description?.message),
    incidentDate: err(errors.incidentDate?.message),
    location: err(errors.location?.message),
    fullName: err(errors.identity?.fullName?.message ?? errors.identity?.message),
    email: err(errors.identity?.email?.message),
    phone: err(errors.identity?.phone?.message),
    acknowledgement: err(errors.acknowledgement?.message),
  };

  return (
    <form onSubmit={onSubmit} noValidate data-testid="report-form">
      {result?.status === "error" ? (
        <CDFAlert tone="danger" testId="form-error">
          {t("errors.withReference", { message: t(`errors.${result.kind}` as MessageKey), ref: result.ref })}
        </CDFAlert>
      ) : null}
      {Object.values(errors).length > 0 ? <CDFAlert tone="danger">{t("errors.INVALID")}</CDFAlert> : null}

      <CDFCard>
        <CDFField id="category" label={t("portal.category")} error={e.category}>
          <select
            {...register("category")}
            aria-required="true"
            {...fieldIds("category", { error: e.category })}
            className={inputClass}
            defaultValue=""
          >
            <option value="" disabled>
              {t("portal.categoryPlaceholder")}
            </option>
            {REPORT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`category.${c}` as MessageKey)}
              </option>
            ))}
          </select>
        </CDFField>
        <CDFField
          id="subjectDescription"
          label={t("portal.subjectDescription")}
          hint={t("portal.subjectDescriptionHint")}
          optionalLabel={t("common.optional")}
          error={e.subjectDescription}
        >
          <input
            {...register("subjectDescription")}
            {...fieldIds("subjectDescription", { hint: "y", error: e.subjectDescription })}
            className={inputClass}
            autoComplete="off"
          />
        </CDFField>
        <CDFField
          id="description"
          label={t("portal.description")}
          hint={t("portal.descriptionHint")}
          error={e.description}
        >
          <textarea
            {...register("description")}
            aria-required="true"
            {...fieldIds("description", { hint: "y", error: e.description })}
            className={textareaClass}
            rows={8}
          />
        </CDFField>
        <div className="grid gap-4 sm:grid-cols-2">
          <CDFField
            id="incidentDate"
            label={t("portal.incidentDate")}
            optionalLabel={t("common.optional")}
            error={e.incidentDate}
          >
            <input
              type="date"
              {...register("incidentDate")}
              {...fieldIds("incidentDate", { error: e.incidentDate })}
              className={inputClass}
            />
          </CDFField>
          <CDFField
            id="location"
            label={t("portal.location")}
            optionalLabel={t("common.optional")}
            error={e.location}
          >
            <input
              {...register("location")}
              {...fieldIds("location", { error: e.location })}
              className={inputClass}
              autoComplete="off"
            />
          </CDFField>
        </div>
      </CDFCard>

      <CDFCard title={t("portal.reporterMode")}>
        <fieldset>
          <legend className="sr-only">{t("portal.reporterMode")}</legend>
          {(["ANONYMOUS", "IDENTIFIED"] as const).map((m) => (
            <label key={m} className="mb-3 flex items-start gap-3">
              <input
                type="radio"
                value={m}
                {...register("reporterMode")}
                className="mt-1 size-5"
                data-testid={`mode-${m.toLowerCase()}`}
              />
              <span>
                <span className="block font-semibold">
                  {t(m === "ANONYMOUS" ? "portal.modeAnonymous" : "portal.modeIdentified")}
                </span>
                <span className="block text-sm text-cdf-text-secondary">
                  {t(m === "ANONYMOUS" ? "portal.modeAnonymousHint" : "portal.modeIdentifiedHint")}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === "IDENTIFIED" ? (
          <div className="mt-2 border-t border-cdf-border pt-4">
            <CDFField id="fullName" label={t("portal.fullName")} error={e.fullName}>
              <input
                {...register("identity.fullName")}
                {...fieldIds("fullName", { error: e.fullName })}
                className={inputClass}
                autoComplete="name"
              />
            </CDFField>
            <div className="grid gap-4 sm:grid-cols-2">
              <CDFField id="email" label={t("portal.email")} error={e.email}>
                <input
                  type="email"
                  {...register("identity.email")}
                  {...fieldIds("email", { error: e.email })}
                  className={inputClass}
                  autoComplete="email"
                />
              </CDFField>
              <CDFField id="phone" label={t("portal.phone")} error={e.phone}>
                <input
                  type="tel"
                  {...register("identity.phone")}
                  {...fieldIds("phone", { error: e.phone })}
                  className={inputClass}
                  autoComplete="tel"
                  dir="ltr"
                />
              </CDFField>
            </div>
            <CDFField id="preferredContact" label={t("portal.preferredContact")}>
              <select {...register("identity.preferredContact")} id="preferredContact" className={inputClass}>
                <option value="PORTAL_ONLY">{t("portal.contactPortal")}</option>
                <option value="EMAIL">{t("portal.contactEmail")}</option>
                <option value="PHONE">{t("portal.contactPhone")}</option>
              </select>
            </CDFField>
          </div>
        ) : null}
      </CDFCard>

      <div className="mb-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            {...register("acknowledgement")}
            aria-required="true"
            {...fieldIds("acknowledgement", { error: e.acknowledgement })}
            className="mt-1 size-5"
          />
          <span>{t("portal.acknowledgement")}</span>
        </label>
        {e.acknowledgement ? (
          <p id="acknowledgement-error" className="mt-1 text-sm font-semibold text-cdf-danger">
            {e.acknowledgement}
          </p>
        ) : null}
      </div>
      <input type="hidden" {...register("language")} />
      <button type="submit" className={buttonClass("primary")} disabled={pending} data-testid="submit-report">
        {pending ? t("portal.submitting") : t("common.submit")}
      </button>
    </form>
  );
}
