"use client";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useForm, useWatch, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  BIRTH_DATE_CALENDARS,
  CITIES,
  GENDERS,
  ID_TYPES,
  NATIONALITIES,
  RELATIONSHIPS_TO_FUND,
  REPORT_CATEGORIES,
  REPORTER_MODES,
} from "@cdf/contracts";
import { createTranslator, type Locale, type MessageKey } from "@cdf/i18n";
import { CDFAlert, CDFCard, CDFField, buttonClass, fieldIds, inputClass, textareaClass } from "@cdf/ui";
import { submitReportSchema, type SubmitReport, type SubmitReportInput } from "@cdf/validation";
import { submitReportAction, type SubmitResult } from "./actions";
import { ReportReceipt } from "./report-receipt";

const MODE_LABELS = {
  ANONYMOUS: ["portal.modeAnonymous", "portal.modeAnonymousHint"],
  EMAIL_ONLY: ["portal.modeEmailOnly", "portal.modeEmailOnlyHint"],
  IDENTIFIED: ["portal.modeIdentified", "portal.modeIdentifiedHint"],
} as const satisfies Record<(typeof REPORTER_MODES)[number], readonly [MessageKey, MessageKey]>;

/** Field set from the Drive whistleblowing requirements report (CDF-63); numbers refer to its table. */
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
    // The schema's input type widens `identity` to unknown (validated per mode); narrow it for the form.
    resolver: zodResolver(submitReportSchema) as unknown as Resolver<
      SubmitReportInput,
      unknown,
      SubmitReport
    >,
    defaultValues: {
      reporterMode: "ANONYMOUS",
      language: locale,
      identity: { preferredContact: "PORTAL_ONLY", birthDateCalendar: "GREGORIAN" },
    },
  });
  const mode = useWatch({ control, name: "reporterMode" });
  const relationship = useWatch({ control, name: "relationship" });
  const category = useWatch({ control, name: "category" });
  const err = (key: string | undefined) => (key ? t(key as MessageKey) : undefined);

  const nationalities = useMemo(() => {
    const names = new Intl.DisplayNames([locale], { type: "region" });
    return NATIONALITIES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) =>
      a.name.localeCompare(b.name, locale),
    );
  }, [locale]);

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

  const id = errors.identity;
  const e = {
    relationship: err(errors.relationship?.message),
    relationshipOther: err(errors.relationshipOther?.message),
    category: err(errors.category?.message),
    categoryOther: err(errors.categoryOther?.message),
    subjectDescription: err(errors.subjectDescription?.message),
    description: err(errors.description?.message),
    incidentDate: err(errors.incidentDate?.message),
    incidentTime: err(errors.incidentTime?.message),
    location: err(errors.location?.message),
    willingToCooperate: err(errors.willingToCooperate?.message),
    givenName: err(id?.givenName?.message),
    fatherName: err(id?.fatherName?.message),
    grandfatherName: err(id?.grandfatherName?.message),
    familyName: err(id?.familyName?.message),
    gender: err(id?.gender?.message),
    birthDate: err(id?.birthDate?.message ?? id?.birthDateCalendar?.message),
    idType: err(id?.idType?.message),
    idNumber: err(id?.idNumber?.message),
    city: err(id?.city?.message),
    nationality: err(id?.nationality?.message),
    phone: err(id?.phone?.message),
    email: err(id?.email?.message),
    acknowledgement: err(errors.acknowledgement?.message),
  };

  const choose = (
    <option value="" disabled>
      {t("portal.choose")}
    </option>
  );

  /** Radio group with a visible legend; errors are announced through the fieldset description. */
  const radioGroup = (
    name: "reporterMode" | "willingToCooperate" | "identity.birthDateCalendar",
    legend: string,
    options: { value: string; label: string; hint?: string; testId?: string }[],
    opts: { hint?: string; error?: string; srOnlyLegend?: boolean } = {},
  ): ReactNode => {
    const groupId = name.replace(".", "-");
    const describedBy =
      [opts.hint ? `${groupId}-hint` : null, opts.error ? `${groupId}-error` : null]
        .filter(Boolean)
        .join(" ") || undefined;
    return (
      <fieldset className="mb-4" aria-describedby={describedBy} data-testid={`group-${groupId}`}>
        <legend className={opts.srOnlyLegend ? "sr-only" : "mb-1 block font-semibold"}>{legend}</legend>
        {opts.hint ? (
          <p id={`${groupId}-hint`} className="mb-2 text-sm text-cdf-text-secondary">
            {opts.hint}
          </p>
        ) : null}
        {options.map((o) => (
          <label key={o.value} className="mb-3 flex items-start gap-3">
            <input
              type="radio"
              value={o.value}
              {...register(name)}
              className="mt-1 size-5"
              data-testid={o.testId}
            />
            <span>
              <span className="block font-semibold">{o.label}</span>
              {o.hint ? <span className="block text-sm text-cdf-text-secondary">{o.hint}</span> : null}
            </span>
          </label>
        ))}
        {opts.error ? (
          <p id={`${groupId}-error`} className="mt-1 text-sm font-semibold text-cdf-danger">
            {opts.error}
          </p>
        ) : null}
      </fieldset>
    );
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
        {/* Fields 1–2 */}
        <CDFField id="relationship" label={t("portal.relationship")} error={e.relationship}>
          <select
            {...register("relationship")}
            {...fieldIds("relationship", { error: e.relationship })}
            className={inputClass}
            defaultValue=""
          >
            {choose}
            {RELATIONSHIPS_TO_FUND.map((r) => (
              <option key={r} value={r}>
                {t(`portal.relationshipOption.${r}` as MessageKey)}
              </option>
            ))}
          </select>
        </CDFField>
        {relationship === "OTHER" ? (
          <CDFField
            id="relationshipOther"
            label={t("portal.relationshipOther")}
            optionalLabel={t("common.optional")}
            error={e.relationshipOther}
          >
            <textarea
              {...register("relationshipOther")}
              {...fieldIds("relationshipOther", { error: e.relationshipOther })}
              className={textareaClass}
              rows={3}
            />
          </CDFField>
        ) : null}
      </CDFCard>

      <CDFCard>
        {/* Fields 13–14 */}
        <CDFField id="category" label={t("portal.violationType")} error={e.category}>
          <select
            {...register("category")}
            {...fieldIds("category", { error: e.category })}
            className={inputClass}
            defaultValue=""
          >
            {choose}
            {REPORT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`category.${c}` as MessageKey)}
              </option>
            ))}
          </select>
        </CDFField>
        {category === "OTHER" ? (
          <CDFField
            id="categoryOther"
            label={t("portal.categoryOther")}
            optionalLabel={t("common.optional")}
            error={e.categoryOther}
          >
            <textarea
              {...register("categoryOther")}
              {...fieldIds("categoryOther", { error: e.categoryOther })}
              className={textareaClass}
              rows={3}
            />
          </CDFField>
        ) : null}
        {/* Field 15 */}
        <CDFField
          id="description"
          label={t("portal.description")}
          hint={t("portal.descriptionHint")}
          error={e.description}
        >
          <textarea
            {...register("description")}
            {...fieldIds("description", { hint: "y", error: e.description })}
            className={textareaClass}
            rows={8}
          />
        </CDFField>
        {/* Field 16 */}
        <p id="incidentWhen-hint" className="mb-1 text-sm text-cdf-text-secondary">
          {t("portal.incidentWhenHint")}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <CDFField id="incidentDate" label={t("portal.incidentDate")} error={e.incidentDate}>
            <input
              type="date"
              {...register("incidentDate")}
              {...fieldIds("incidentDate", { error: e.incidentDate })}
              aria-describedby={["incidentWhen-hint", e.incidentDate ? "incidentDate-error" : null]
                .filter(Boolean)
                .join(" ")}
              className={inputClass}
            />
          </CDFField>
          <CDFField id="incidentTime" label={t("portal.incidentTime")} error={e.incidentTime}>
            <input
              type="time"
              {...register("incidentTime")}
              {...fieldIds("incidentTime", { error: e.incidentTime })}
              className={inputClass}
            />
          </CDFField>
        </div>
        {/* Field 17 */}
        <CDFField
          id="location"
          label={t("portal.locationEntity")}
          hint={t("portal.locationEntityHint")}
          error={e.location}
        >
          <input
            {...register("location")}
            {...fieldIds("location", { hint: "y", error: e.location })}
            className={inputClass}
            autoComplete="off"
          />
        </CDFField>
        {/* Field 18 */}
        <CDFField
          id="subjectDescription"
          label={t("portal.personsReported")}
          hint={t("portal.personsReportedHint")}
          error={e.subjectDescription}
        >
          <input
            {...register("subjectDescription")}
            {...fieldIds("subjectDescription", { hint: "y", error: e.subjectDescription })}
            className={inputClass}
            autoComplete="off"
          />
        </CDFField>
        {/* Field 19: deferred until the intake attachment pipeline exists (CDF-72). */}
        <CDFAlert tone="info" testId="attachments-unavailable">
          {t("portal.attachmentsUnavailable")}
        </CDFAlert>
      </CDFCard>

      <CDFCard title={t("portal.reporterMode")}>
        {/* Field 3 */}
        {radioGroup(
          "reporterMode",
          t("portal.reporterMode"),
          REPORTER_MODES.map((m) => ({
            value: m,
            label: t(MODE_LABELS[m][0]),
            hint: t(MODE_LABELS[m][1]),
            testId: `mode-${m.toLowerCase().replace("_", "-")}`,
          })),
          { srOnlyLegend: true },
        )}

        {mode === "EMAIL_ONLY" ? (
          <div className="mt-2 border-t border-cdf-border pt-4" data-testid="email-only-fields">
            <CDFField id="email" label={t("portal.email")} hint={t("portal.emailOnlyHint")} error={e.email}>
              <input
                type="email"
                {...register("identity.email")}
                {...fieldIds("email", { hint: "y", error: e.email })}
                className={inputClass}
                autoComplete="email"
                dir="ltr"
              />
            </CDFField>
          </div>
        ) : null}

        {mode === "IDENTIFIED" ? (
          <div className="mt-2 border-t border-cdf-border pt-4" data-testid="identified-fields">
            <p className="mb-4 text-sm text-cdf-text-secondary">{t("portal.identityNotice")}</p>
            {/* Field 4 */}
            <fieldset className="mb-2">
              <legend className="mb-2 block font-semibold">{t("portal.fullNameLegend")}</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {(["givenName", "fatherName", "grandfatherName", "familyName"] as const).map((part) => (
                  <CDFField key={part} id={part} label={t(`portal.${part}`)} error={e[part]}>
                    <input
                      {...register(`identity.${part}`)}
                      {...fieldIds(part, { error: e[part] })}
                      className={inputClass}
                      autoComplete={
                        part === "givenName" ? "given-name" : part === "familyName" ? "family-name" : "off"
                      }
                    />
                  </CDFField>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Field 5 */}
              <CDFField id="gender" label={t("portal.gender")} error={e.gender}>
                <select
                  {...register("identity.gender")}
                  {...fieldIds("gender", { error: e.gender })}
                  className={inputClass}
                  defaultValue=""
                >
                  {choose}
                  {GENDERS.map((g) => (
                    <option key={g} value={g}>
                      {t(`portal.genderOption.${g}`)}
                    </option>
                  ))}
                </select>
              </CDFField>
              {/* Field 10 */}
              <CDFField id="nationality" label={t("portal.nationality")} error={e.nationality}>
                <select
                  {...register("identity.nationality")}
                  {...fieldIds("nationality", { error: e.nationality })}
                  className={inputClass}
                  defaultValue=""
                >
                  {choose}
                  {nationalities.map((n) => (
                    <option key={n.code} value={n.code}>
                      {n.name}
                    </option>
                  ))}
                </select>
              </CDFField>
            </div>
            {/* Field 6 */}
            {radioGroup(
              "identity.birthDateCalendar",
              t("portal.birthDateCalendar"),
              BIRTH_DATE_CALENDARS.map((c) => ({
                value: c,
                label: t(`portal.calendarOption.${c}`),
                testId: `calendar-${c.toLowerCase()}`,
              })),
            )}
            <CDFField
              id="birthDate"
              label={t("portal.birthDate")}
              hint={t("portal.birthDateHint")}
              error={e.birthDate}
            >
              <input
                {...register("identity.birthDate")}
                {...fieldIds("birthDate", { hint: "y", error: e.birthDate })}
                className={inputClass}
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                autoComplete="off"
                dir="ltr"
              />
            </CDFField>
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Field 7 */}
              <CDFField id="idType" label={t("portal.idType")} error={e.idType}>
                <select
                  {...register("identity.idType")}
                  {...fieldIds("idType", { error: e.idType })}
                  className={inputClass}
                  defaultValue=""
                >
                  {choose}
                  {ID_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`portal.idTypeOption.${type}`)}
                    </option>
                  ))}
                </select>
              </CDFField>
              {/* Field 8 */}
              <CDFField
                id="idNumber"
                label={t("portal.idNumber")}
                hint={t("portal.idNumberHint")}
                error={e.idNumber}
              >
                <input
                  {...register("identity.idNumber")}
                  {...fieldIds("idNumber", { hint: "y", error: e.idNumber })}
                  className={inputClass}
                  autoComplete="off"
                  dir="ltr"
                />
              </CDFField>
              {/* Field 9 */}
              <CDFField id="city" label={t("portal.city")} error={e.city}>
                <select
                  {...register("identity.city")}
                  {...fieldIds("city", { error: e.city })}
                  className={inputClass}
                  defaultValue=""
                >
                  {choose}
                  {CITIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`portal.cityOption.${c}`)}
                    </option>
                  ))}
                </select>
              </CDFField>
              {/* Field 11 */}
              <CDFField id="phone" label={t("portal.mobile")} error={e.phone}>
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
            {/* Field 12 */}
            <CDFField id="email" label={t("portal.email")} error={e.email}>
              <input
                type="email"
                {...register("identity.email")}
                {...fieldIds("email", { error: e.email })}
                className={inputClass}
                autoComplete="email"
                dir="ltr"
              />
            </CDFField>
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

      <CDFCard>
        {/* Field 20 */}
        {radioGroup(
          "willingToCooperate",
          t("portal.cooperation"),
          [
            { value: "YES", label: t("portal.cooperateYes"), testId: "cooperate-yes" },
            { value: "NO", label: t("portal.cooperateNo"), testId: "cooperate-no" },
          ],
          { hint: t("portal.cooperationHint"), error: e.willingToCooperate },
        )}
      </CDFCard>

      {/* Field 21 */}
      <div className="mb-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            {...register("acknowledgement")}
            {...fieldIds("acknowledgement", { error: e.acknowledgement })}
            className="mt-1 size-5"
          />
          <span>{t("portal.policyAcknowledgement")}</span>
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
