// A participant's accommodations (UX redesign Phase 12 P12-2b; ADR-055; AMB-157): support they need to take part. The
// details may concern health, so the read model gives them only to the participant themself and to whoever runs the
// meeting (meeting_accommodation_read), and the page shows what it is given and nothing more. Each one is kept as
// written; a change is a new one.
import type { MeetingAccommodationView } from "@cdf/contracts";
import { formatDateTime, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFCommandForm, CDFField, textareaClass } from "@cdf/ui";
import { confirmation } from "../../confirmations";
import { recordAccommodationAction } from "./actions";

export function AccommodationList({
  t,
  items,
  testId,
}: {
  t: Translator;
  items: readonly MeetingAccommodationView[];
  testId: string;
}) {
  const when = (iso: string) => isolate(formatDateTime(t.locale, iso));
  return (
    <ul className="grid gap-2 text-sm" aria-label={t("meetings.accommodationsTitle")} data-testid={testId}>
      {items.map((a, i) => (
        <li key={a.accommodationId} data-testid={`${testId}-${i + 1}`}>
          <p className="whitespace-pre-wrap break-words">
            <bdi dir="auto">{a.details}</bdi>
          </p>
          <p className="text-cdf-text-secondary">
            {t("meetings.accommodationRecordedOn", {
              source: t(`meetings.accommodationSource.${a.source}` as MessageKey),
              date: when(a.recordedAt),
            })}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Recording one, for oneself or, by whoever runs the meeting, for the participant named. */
export function AccommodationForm({
  t,
  meetingId,
  participantId,
  idBase,
  submitName,
}: {
  t: Translator;
  meetingId: string;
  participantId: string;
  idBase: string;
  submitName?: string;
}) {
  return (
    <CDFCommandForm
      action={recordAccommodationAction.bind(null, meetingId, participantId)}
      locale={t.locale}
      submitLabel={t("meetings.recordAccommodation")}
      {...(submitName ? { submitName } : {})}
      variant="secondary"
      testId={`${idBase}-form`}
      successMessage={t("meetings.accommodationRecorded")}
      leaveWarning={t("common.leaveWarning")}
      fieldLabels={{ details: t("meetings.accommodationLabel") }}
      confirm={confirmation(t, "recordAccommodation")}
    >
      <CDFField
        id={`${idBase}-details`}
        label={t("meetings.accommodationLabel")}
        hint={t("meetings.accommodationHint")}
      >
        <textarea
          id={`${idBase}-details`}
          name="details"
          className={textareaClass}
          aria-describedby={`${idBase}-details-hint`}
          minLength={5}
          maxLength={2000}
          required
        />
      </CDFField>
    </CDFCommandForm>
  );
}
