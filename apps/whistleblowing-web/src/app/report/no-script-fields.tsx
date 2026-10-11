// Identity fields for a browser without JavaScript (UX-002). Rendered only inside <noscript> by ReportForm, so
// the JavaScript path never shows or registers them. Plain named controls: the server reads them from the
// native POST and validates them per mode, as it does for the JavaScript path. Values are never pre-filled.
import { BIRTH_DATE_CALENDARS, CITIES, GENDERS, ID_TYPES } from "@cdf/contracts";
import type { Translator } from "@cdf/i18n";
import { CDFField, fieldIds, inputClass } from "@cdf/ui";

export function NoScriptIdentityFields({
  t,
  includeEmail,
  nationalities,
}: {
  t: Translator;
  /** False when the email-only field is already on the page (the server knows that mode was chosen). */
  includeEmail: boolean;
  nationalities: { code: string; name: string }[];
}) {
  const choose = (
    <option value="" disabled>
      {t("portal.choose")}
    </option>
  );
  const select = (id: string, label: string, options: { value: string; label: string }[]) => (
    <CDFField id={id} label={label}>
      <select name={`identity.${id}`} id={id} className={inputClass} defaultValue="">
        {choose}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </CDFField>
  );
  const text = (id: string, label: string, opts: { hint?: string; type?: string; ltr?: boolean } = {}) => (
    <CDFField id={id} label={label} hint={opts.hint}>
      <input
        name={`identity.${id}`}
        {...fieldIds(id, { hint: opts.hint })}
        type={opts.type ?? "text"}
        className={inputClass}
        autoComplete="off"
        dir={opts.ltr ? "ltr" : undefined}
      />
    </CDFField>
  );

  return (
    <div className="mt-2 border-t border-cdf-border pt-4" data-testid="noscript-identity-fields">
      <p className="mb-1 font-semibold">{t("portal.identityTitle")}</p>
      {includeEmail
        ? text("email", t("portal.email"), { hint: t("portal.noScript.emailHint"), type: "email", ltr: true })
        : null}
      <p className="mb-4 text-sm text-cdf-text-secondary">
        {t("portal.noScript.identityIntro")} {t("portal.identityNotice")}
      </p>
      <fieldset className="mb-2">
        <legend className="mb-2 block font-semibold">{t("portal.fullNameLegend")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {(["givenName", "fatherName", "grandfatherName", "familyName"] as const).map((part) => (
            <div key={part}>{text(part, t(`portal.${part}`))}</div>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        {select(
          "gender",
          t("portal.gender"),
          GENDERS.map((g) => ({ value: g, label: t(`portal.genderOption.${g}`) })),
        )}
        {select(
          "nationality",
          t("portal.nationality"),
          nationalities.map((n) => ({ value: n.code, label: n.name })),
        )}
      </div>
      <fieldset className="mb-4">
        <legend className="mb-1 block font-semibold">{t("portal.birthDateCalendar")}</legend>
        {BIRTH_DATE_CALENDARS.map((c) => (
          <label key={c} className="mb-3 flex items-start gap-3">
            <input
              type="radio"
              name="identity.birthDateCalendar"
              value={c}
              defaultChecked={c === "GREGORIAN"}
              className="mt-1 size-5"
            />
            <span className="font-semibold">{t(`portal.calendarOption.${c}`)}</span>
          </label>
        ))}
      </fieldset>
      {text("birthDate", t("portal.birthDate"), { hint: t("portal.birthDateHint"), ltr: true })}
      <div className="grid gap-4 sm:grid-cols-2">
        {select(
          "idType",
          t("portal.idType"),
          ID_TYPES.map((type) => ({ value: type, label: t(`portal.idTypeOption.${type}`) })),
        )}
        {text("idNumber", t("portal.idNumber"), { hint: t("portal.idNumberHint"), ltr: true })}
        {select(
          "city",
          t("portal.city"),
          CITIES.map((c) => ({ value: c, label: t(`portal.cityOption.${c}`) })),
        )}
        {text("phone", t("portal.mobile"), { type: "tel", ltr: true })}
      </div>
      <CDFField id="preferredContact" label={t("portal.preferredContact")}>
        <select
          name="identity.preferredContact"
          id="preferredContact"
          className={inputClass}
          defaultValue="PORTAL_ONLY"
        >
          <option value="PORTAL_ONLY">{t("portal.contactPortal")}</option>
          <option value="EMAIL">{t("portal.contactEmail")}</option>
          <option value="PHONE">{t("portal.contactPhone")}</option>
        </select>
      </CDFField>
    </div>
  );
}
