"use client";
// CDFDecisionPanel (UX-019, UX-024; audit §15.5 "CDFApprovalDialog", RC-11 and PS-5/PS-7). One decision, made
// explicitly: no option is pre-selected, each option says what it will do, a reason is asked for when the
// outcome needs one, and nothing typed is lost when the server refuses the submit. The panel sits inside a
// command form, which owns the single primary submit, the error summary and the inline errors.
import { useId, useState, type ReactNode } from "react";
import { CDFFieldError } from "./field-errors";
import { textareaClass } from "./components";

export interface CDFDecisionOption {
  value: string;
  label: string;
  /** What happens if this option is chosen, in plain language: who is affected and whether it can be undone. */
  consequence: string;
  /** The reason field is shown, and required by the server, for this option. */
  requiresReason?: boolean;
  testId?: string;
}

export interface CDFDecisionReason {
  name: string;
  label: string;
  hint?: string;
  /** Visible "(Required)" text. */
  requiredLabel: string;
  minLength?: number;
  maxLength?: number;
  /** Show the reason for every option, not only those with `requiresReason`. */
  always?: boolean;
}

export function CDFDecisionPanel({
  id,
  name,
  legend,
  requiredLabel,
  options,
  notice,
  reason,
  testId,
}: {
  /** Control id of the first option; server field errors for `name` are reported against it. */
  id: string;
  name: string;
  legend: string;
  requiredLabel: string;
  options: CDFDecisionOption[];
  /** Shown before the options, for example who may not decide (separation of duties). */
  notice?: ReactNode;
  reason?: CDFDecisionReason;
  testId?: string;
}) {
  const [chosen, setChosen] = useState("");
  const noticeId = useId();
  const option = options.find((o) => o.value === chosen);
  const reasonShown = Boolean(reason && (reason.always || option?.requiresReason));
  const reasonId = `${id}-reason`;

  return (
    <div className="mb-4" data-testid={testId}>
      <fieldset aria-describedby={notice ? noticeId : undefined}>
        <legend className="mb-2 font-semibold">
          {legend}
          <span className="ms-2 text-sm font-normal text-cdf-text-secondary">({requiredLabel})</span>
        </legend>
        {notice ? (
          <div id={noticeId} className="mb-3 text-sm text-cdf-text-secondary">
            {notice}
          </div>
        ) : null}
        <CDFFieldError id={id} />
        <div className="grid gap-2">
          {options.map((o, i) => {
            const optionId = i === 0 ? id : `${id}-${i}`;
            return (
              <label
                key={o.value}
                htmlFor={optionId}
                className="grid min-h-11 cursor-pointer grid-cols-[auto_1fr] items-start gap-x-3 rounded-cdf-md border border-cdf-border bg-cdf-surface p-3 has-checked:border-s-4 has-checked:border-s-cdf-primary has-checked:bg-cdf-selected"
              >
                <input
                  type="radio"
                  id={optionId}
                  name={name}
                  value={o.value}
                  checked={chosen === o.value}
                  onChange={() => setChosen(o.value)}
                  aria-describedby={`${optionId}-consequence`}
                  className="row-span-2 mt-0.5 size-5"
                  data-testid={o.testId}
                />
                <span className="font-semibold">{o.label}</span>
                <span id={`${optionId}-consequence`} className="col-start-2 text-sm text-cdf-text-secondary">
                  {o.consequence}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {reason ? (
        // Kept mounted while hidden so text typed for one option survives switching options and refusals;
        // a disabled control is not submitted.
        <div className="mt-4" hidden={!reasonShown}>
          <label htmlFor={reasonId} className="mb-1 block font-semibold">
            {reason.label}
            <span className="ms-2 text-sm font-normal text-cdf-text-secondary">({reason.requiredLabel})</span>
          </label>
          {reason.hint ? (
            <p id={`${reasonId}-hint`} className="mb-1 text-sm text-cdf-text-secondary">
              {reason.hint}
            </p>
          ) : null}
          <textarea
            id={reasonId}
            name={reason.name}
            className={textareaClass}
            disabled={!reasonShown}
            required={reasonShown}
            minLength={reason.minLength}
            maxLength={reason.maxLength}
            aria-describedby={reason.hint ? `${reasonId}-hint` : undefined}
          />
          <CDFFieldError id={reasonId} />
        </div>
      ) : null}
    </div>
  );
}
