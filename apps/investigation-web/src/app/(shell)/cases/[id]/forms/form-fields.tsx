// Renders a form definition's sections and fields (ADR-011). Editable inputs for drafts, plain values
// otherwise. Labels come from the definition in the active language; nothing is hard-coded.
import {
  FORM_TEXT_MAX,
  FORM_TEXTAREA_MAX,
  type FormData,
  type FormFieldDefinition,
  type FormSectionDefinition,
} from "@cdf/contracts";
import type { Translator } from "@cdf/i18n";
import { CDFBadge, CDFDescriptionList, CDFField, inputClass, textareaClass } from "@cdf/ui";

function optionLabel(field: FormFieldDefinition, value: string, locale: string) {
  const option = field.options.find((o) => o.value === value);
  return option ? (locale === "ar" ? option.labelAr : option.labelEn) : value;
}

export function statusTone(status: string) {
  return status === "APPROVED" || status === "REVIEWED"
    ? "success"
    : status === "PREPARED"
      ? "info"
      : status === "WITHDRAWN"
        ? "neutral"
        : "warning";
}

export function fieldLabel(field: FormFieldDefinition, locale: string) {
  return locale === "ar" ? field.labelAr : field.labelEn;
}

/** Field → label map for the CDFCommandForm error summary. */
export function fieldLabels(sections: FormSectionDefinition[], locale: string): Record<string, string> {
  return Object.fromEntries(sections.flatMap((s) => s.fields.map((f) => [f.name, fieldLabel(f, locale)])));
}

function displayValue(field: FormFieldDefinition, value: string | undefined, t: Translator) {
  if (value === undefined || value === "") return t("forms.notSet");
  if (field.type === "boolean") return value === "true" ? t("common.yes") : t("common.no");
  if (field.type === "select") return optionLabel(field, value, t.locale);
  return value;
}

function Input({
  field,
  value,
  hinted,
  t,
}: {
  field: FormFieldDefinition;
  value: string | undefined;
  /** The field shows a hint, which the control names as its description. */
  hinted: boolean;
  t: Translator;
}) {
  const id = `f-${field.name}`;
  // A draft may be saved with required fields still empty, so the browser's own `required` check would block the
  // save: the requirement is announced (aria-required) and enforced when the form is prepared (UX-069, CDF-58).
  const common = {
    id,
    name: field.name,
    className: inputClass,
    "aria-required": field.required || undefined,
    "aria-describedby": hinted ? `${id}-hint` : undefined,
    "data-testid": `field-${field.name}`,
  } as const;
  switch (field.type) {
    case "textarea":
      return (
        <textarea
          {...common}
          className={textareaClass}
          defaultValue={value ?? ""}
          maxLength={FORM_TEXTAREA_MAX}
        />
      );
    case "date":
      return <input {...common} type="date" defaultValue={value ?? ""} dir="ltr" />;
    case "number":
      return (
        <input
          {...common}
          type="text"
          inputMode="decimal"
          defaultValue={value ?? ""}
          dir="ltr"
          maxLength={24}
        />
      );
    // Keyed by the stored value: React never updates a select's default after mount, so a saved change would
    // otherwise snap back to the old value when the form resets after the save (UX-030, E04-02).
    case "boolean":
      return (
        <select key={value ?? ""} {...common} defaultValue={value ?? ""}>
          <option value="">{t("forms.select")}</option>
          <option value="true">{t("common.yes")}</option>
          <option value="false">{t("common.no")}</option>
        </select>
      );
    case "select":
      return (
        <select key={value ?? ""} {...common} defaultValue={value ?? ""}>
          <option value="">{t("forms.select")}</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {t.locale === "ar" ? o.labelAr : o.labelEn}
            </option>
          ))}
        </select>
      );
    default:
      return <input {...common} type="text" defaultValue={value ?? ""} maxLength={FORM_TEXT_MAX} />;
  }
}

export function FormFields({
  sections,
  data,
  editable,
  t,
}: {
  sections: FormSectionDefinition[];
  data: FormData;
  editable: boolean;
  t: Translator;
}) {
  return (
    <>
      {sections.map((section) => (
        <fieldset
          key={section.no}
          className="mb-6 border-t border-cdf-border pt-4"
          data-testid={`section-${section.no}`}
        >
          <legend className="px-1 font-semibold">
            {t.locale === "ar" ? section.titleAr : section.titleEn}
          </legend>
          {editable ? (
            section.fields.map((field) => {
              const hint = field.sensitive
                ? t("forms.sensitive")
                : ((t.locale === "ar" ? field.helpAr : field.helpEn) ?? undefined);
              // One convention across the product (CDF-58): "(Required)" or "(Optional)" after the label.
              return (
                <CDFField
                  key={field.name}
                  id={`f-${field.name}`}
                  label={fieldLabel(field, t.locale)}
                  hint={hint}
                  requiredLabel={field.required ? t("common.required") : undefined}
                  optionalLabel={field.required ? undefined : t("common.optional")}
                >
                  <Input field={field} value={data[field.name]} hinted={Boolean(hint)} t={t} />
                </CDFField>
              );
            })
          ) : (
            <CDFDescriptionList
              items={section.fields.map((field) => ({
                term: fieldLabel(field, t.locale),
                value: (
                  <span data-testid={`value-${field.name}`}>
                    {displayValue(field, data[field.name], t)}
                    {field.sensitive ? (
                      <>
                        {" "}
                        <CDFBadge tone="warning">{t("forms.sensitive")}</CDFBadge>
                      </>
                    ) : null}
                  </span>
                ),
              }))}
            />
          )}
        </fieldset>
      ))}
    </>
  );
}
