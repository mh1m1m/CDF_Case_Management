"use client";
import { useId, useState } from "react";
import { CDFAlert, CDFField, inputClass } from "@cdf/ui";

export interface RestrictedCaseFieldsProps {
  /** Classifications the initiator may set: at or above the report's, at or below their own clearance. */
  classifications: { value: string; label: string }[];
  defaultClassification: string;
  /** Eligible accountable authorities per classification (DEC-01); names only. */
  authorities: Record<string, { userId: string; name: string }[]>;
  labels: {
    classification: string;
    restricted: string;
    restrictedHint: string;
    authority: string;
    authorityHint: string;
    choose: string;
    none: string;
    /** Contains "{name}". */
    consequence: string;
    consequencePending: string;
    required: string;
  };
}

/**
 * Classification and restricted handling for "Open a case" (DEC-01, ADR-016 D1). Restricted handling needs an
 * explicitly chosen, eligible accountable authority; nothing is pre-selected, and the access consequence is
 * stated before the user submits. The database re-checks eligibility, clearance and the classification.
 */
export function RestrictedCaseFields(props: RestrictedCaseFieldsProps) {
  const { labels } = props;
  const [classification, setClassification] = useState(props.defaultClassification);
  const [restricted, setRestricted] = useState(false);
  const [authorityId, setAuthorityId] = useState("");
  const hintId = useId();
  const candidates = props.authorities[classification] ?? [];
  const chosen = candidates.find((c) => c.userId === authorityId);

  return (
    <>
      <CDFField id="classification" label={labels.classification}>
        <select
          id="classification"
          name="classification"
          className={inputClass}
          value={classification}
          onChange={(e) => {
            setClassification(e.target.value);
            // A different classification can change who is eligible; never carry a choice across silently.
            setAuthorityId("");
          }}
        >
          {props.classifications.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </CDFField>
      <div className="mb-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="isRestricted"
            className="mt-1 size-5"
            checked={restricted}
            aria-describedby={hintId}
            onChange={(e) => {
              setRestricted(e.target.checked);
              if (!e.target.checked) setAuthorityId("");
            }}
            data-testid="restricted-toggle"
          />
          <span>{labels.restricted}</span>
        </label>
        <p id={hintId} className="ms-8 mt-1 text-sm text-cdf-text-secondary">
          {labels.restrictedHint}
        </p>
      </div>
      {restricted ? (
        <div className="mb-4 border-s-4 border-cdf-border ps-4" data-testid="restricted-authority-section">
          {candidates.length === 0 ? (
            <CDFAlert tone="warning" testId="restricted-authority-none">
              {labels.none}
            </CDFAlert>
          ) : (
            <CDFField
              id="restrictedAuthorityId"
              label={labels.authority}
              hint={labels.authorityHint}
              requiredLabel={labels.required}
            >
              <select
                id="restrictedAuthorityId"
                name="restrictedAuthorityId"
                className={inputClass}
                value={authorityId}
                required
                aria-describedby="restrictedAuthorityId-hint"
                onChange={(e) => setAuthorityId(e.target.value)}
                data-testid="restricted-authority"
              >
                <option value="">{labels.choose}</option>
                {candidates.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {c.name}
                  </option>
                ))}
              </select>
            </CDFField>
          )}
          <p aria-live="polite" className="text-sm" data-testid="restricted-consequence">
            {chosen ? labels.consequence.replace("{name}", chosen.name) : labels.consequencePending}
          </p>
        </div>
      ) : null}
    </>
  );
}
