// Ending a seat or a position (UX redesign Phase 12 P12-8b; ADR-064, migration 2128): the form the committees and the
// sectors registers share. Only the rows the database says may be ended now are offered (may_end: the command would
// accept the caller, and the row has not been ended). The end is now, or the start of a date in Riyadh; an end dated
// before now is recorded only with its decree or source reference (the owner's decision F7 = B, 2026-10-19), which the
// command requires (CDF_INVALID:end_reference). The form says so and leaves that decision to the database, which also
// checks the date against the period and records the reference on the row, where it never changes.
import type { CommandFormState } from "@cdf/contracts";
import type { Translator } from "@cdf/i18n";
import { CDFCommandForm, CDFField, inputClass, textareaClass } from "@cdf/ui";
import { confirmation, type ConfirmAct } from "../confirmations";
import { ADMIN_CODES } from "./labels";

export interface EndableRow {
  membershipId: string;
  /** The row as the option names it: its holder, its seat or position and its period. */
  label: string;
}

export function EndForm({
  t,
  id,
  title,
  intro,
  rowLabel,
  rows,
  action,
  act,
  submitLabel,
  submitName,
  done,
}: {
  t: Translator;
  /** The form's test id, and the start of its controls' ids. */
  id: string;
  title: string;
  intro: string;
  rowLabel: string;
  /** The rows that may be ended now (`mayEnd`). */
  rows: readonly EndableRow[];
  action: (state: CommandFormState, form: FormData) => Promise<CommandFormState>;
  act: Extract<ConfirmAct, "endCommitteeMembership" | "endSectorMembership">;
  submitLabel: string;
  /** Names the committee or the sector, so each register's forms have their own accessible names. */
  submitName: string;
  done: string;
}) {
  return (
    <section className="mt-6 border-t border-cdf-border pt-4" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`} className="mb-2 font-semibold">
        {title}
      </h4>
      <p className="mb-3 text-sm text-cdf-text-secondary">{intro}</p>
      <CDFCommandForm
        action={action}
        locale={t.locale}
        submitLabel={submitLabel}
        submitName={submitName}
        variant="danger"
        testId={id}
        successMessage={done}
        leaveWarning={t("common.leaveWarning")}
        codeSections={ADMIN_CODES}
        fieldLabels={{
          membershipId: rowLabel,
          effectiveTo: t("admin.endsOn"),
          endReference: t("admin.endReferenceLabel"),
          reason: t("admin.endReason"),
        }}
        confirm={confirmation(t, act)}
      >
        <CDFField id={`${id}-row`} label={rowLabel} requiredLabel={t("common.required")}>
          <select id={`${id}-row`} name="membershipId" className={inputClass} defaultValue="" required>
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {rows.map((r) => (
              <option key={r.membershipId} value={r.membershipId}>
                {r.label}
              </option>
            ))}
          </select>
        </CDFField>
        <CDFField
          id={`${id}-to`}
          label={t("admin.endsOn")}
          hint={t("admin.endsOnHint")}
          optionalLabel={t("common.optional")}
        >
          <input
            id={`${id}-to`}
            name="effectiveTo"
            type="date"
            className={inputClass}
            aria-describedby={`${id}-to-hint`}
          />
        </CDFField>
        <CDFField
          id={`${id}-reference`}
          label={t("admin.endReferenceLabel")}
          hint={t("admin.endReferenceHint")}
          optionalLabel={t("admin.endReferenceMarker")}
        >
          <input
            id={`${id}-reference`}
            name="endReference"
            type="text"
            className={inputClass}
            aria-describedby={`${id}-reference-hint`}
            minLength={3}
            maxLength={200}
          />
        </CDFField>
        <CDFField
          id={`${id}-reason`}
          label={t("admin.endReason")}
          hint={t("admin.endReasonHint")}
          requiredLabel={t("common.required")}
        >
          <textarea
            id={`${id}-reason`}
            name="reason"
            className={textareaClass}
            aria-describedby={`${id}-reason-hint`}
            minLength={5}
            maxLength={2000}
            required
          />
        </CDFField>
      </CDFCommandForm>
    </section>
  );
}
