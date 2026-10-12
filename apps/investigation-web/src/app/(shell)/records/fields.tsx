// Field groups shared by the records forms. Plain inputs inside CDFCommandForm; the shared Zod schemas validate
// them on the server and the api.* commands validate them again (§45).
import { LEGAL_HOLD_REASON_CODES } from "@cdf/contracts";
import type { MessageKey, Translator } from "@cdf/i18n";
import { CDFField, CDFFieldError, inputClass, textareaClass } from "@cdf/ui";

/** Reason code + justification (+ optional authority reference) for hold placement and hold requests. */
export function HoldReasonFields({
  id,
  t,
  authority = false,
}: {
  id: string;
  t: Translator;
  authority?: boolean;
}) {
  return (
    <>
      <CDFField id={`${id}-reason`} label={t("records.reasonLabel")} requiredLabel={t("common.required")}>
        <select
          id={`${id}-reason`}
          name="reasonCode"
          className={inputClass}
          defaultValue="LITIGATION"
          required
        >
          {LEGAL_HOLD_REASON_CODES.map((r) => (
            <option key={r} value={r}>
              {t(`records.reasonCode.${r}` as MessageKey)}
            </option>
          ))}
        </select>
      </CDFField>
      <CDFField
        id={`${id}-justification`}
        label={t("records.justificationLabel")}
        hint={t("records.justificationHint")}
        requiredLabel={t("common.required")}
      >
        <textarea
          id={`${id}-justification`}
          name="justification"
          className={textareaClass}
          aria-describedby={`${id}-justification-hint`}
          required
          minLength={20}
          maxLength={2000}
        />
      </CDFField>
      {authority ? (
        <CDFField
          id={`${id}-authority`}
          label={t("records.authorityLabel")}
          hint={t("records.authorityHint")}
        >
          <input
            id={`${id}-authority`}
            name="authorityReference"
            className={inputClass}
            aria-describedby={`${id}-authority-hint`}
            maxLength={200}
          />
        </CDFField>
      ) : null}
    </>
  );
}

/**
 * A two-way decision (radio group with a legend) and its reason. Nothing is pre-selected (UX-019): an unanswered
 * decision is refused with a field error, which the first option carries.
 */
export function DecisionFields({
  id,
  t,
  name,
  yes,
  no,
}: {
  id: string;
  t: Translator;
  name: string;
  yes: { value: string; label: string };
  no: { value: string; label: string };
}) {
  return (
    <>
      <fieldset className="mb-3" id={`${id}-decision`}>
        <legend className="mb-1 font-semibold">{t("records.decisionLabel")}</legend>
        {[yes, no].map((o) => (
          <label key={o.value} className="mb-2 flex items-center gap-2">
            <input
              id={`${id}-${o.value.toLowerCase()}`}
              type="radio"
              name={name}
              value={o.value}
              required
              className="size-5"
              data-testid={`${id}-${o.value.toLowerCase()}`}
            />{" "}
            {o.label}
          </label>
        ))}
        <CDFFieldError id={`${id}-${yes.value.toLowerCase()}`} />
      </fieldset>
      <CDFField
        id={`${id}-reason`}
        label={t("records.decisionReasonLabel")}
        hint={t("records.decisionReasonHint")}
        requiredLabel={t("common.required")}
      >
        <textarea
          id={`${id}-reason`}
          name="reason"
          className={textareaClass}
          aria-describedby={`${id}-reason-hint`}
          required
          minLength={10}
          maxLength={2000}
        />
      </CDFField>
    </>
  );
}
