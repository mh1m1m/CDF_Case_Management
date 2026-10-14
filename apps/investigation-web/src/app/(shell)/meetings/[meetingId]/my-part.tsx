// The caller's own place in the meeting (api.meeting_view me): their seat or invited role, their declaration,
// attendance and confidentiality acknowledgement, and the two things a participant does for themself. The declaration
// offers only the statuses the meeting-level capabilities allow (2065 narrowed them to the command's checks: an ended
// seat or an excluded witness declares nothing); a declared conflict is confirmed first because it ends one's part.
// P12-2b (2085, ADR-055): the caller's own accommodations, which an invitee reads here because they see no roster,
// and recording one while the meeting is active.
import type { MeetingCapabilities, MeetingSelfView } from "@cdf/contracts";
import type { MessageKey, Translator } from "@cdf/i18n";
import { CDFCard, CDFCommandForm, CDFDescriptionList, CDFField, textareaClass } from "@cdf/ui";
import { confirmation } from "../../confirmations";
import { AccommodationForm, AccommodationList } from "./accommodations";
import { acknowledgeConfidentialityAction, declareConflictAction } from "./actions";

export function MeetingMyPart({
  t,
  meetingId,
  me,
  capabilities: cap,
}: {
  t: Translator;
  meetingId: string;
  me: MeetingSelfView;
  capabilities: MeetingCapabilities;
}) {
  const statuses = [
    ...(cap.mayDeclareNoConflict ? (["NO_CONFLICT"] as const) : []),
    ...(cap.mayDeclareConflict ? (["CONFLICT_DECLARED"] as const) : []),
  ];
  const facts: { term: string; value: string }[] = [
    ...(me.seat ? [{ term: t("meetings.mySeat"), value: t(`committeeSeat.${me.seat}` as MessageKey) }] : []),
    ...(me.inviteeRole
      ? [
          {
            term: t("meetings.myInvitedAs"),
            value: t(`meetings.inviteeRole.${me.inviteeRole}` as MessageKey),
          },
        ]
      : []),
    ...(me.participantKind === "MEMBER"
      ? [
          {
            term: t("meetings.myVote"),
            value: me.isVoting ? t("meetings.withVote") : t("meetings.withoutVote"),
          },
        ]
      : []),
    ...(me.requiresCoi
      ? [{ term: t("meetings.myCoi"), value: t(`meetings.coi.${me.coiStatus}` as MessageKey) }]
      : []),
    { term: t("meetings.myAttendance"), value: t(`meetings.attendance.${me.attendance}` as MessageKey) },
    ...(me.confidentialityAckRequired
      ? [
          {
            term: t("meetings.myConfidentiality"),
            value: me.confidentialityAcknowledged
              ? t("meetings.acknowledgedValue")
              : t("meetings.notAcknowledgedValue"),
          },
        ]
      : []),
  ];
  return (
    <CDFCard title={t("meetings.myPartTitle")} testId="meeting-my-part">
      <div data-testid="my-part-facts">
        <CDFDescriptionList items={facts} />
      </div>

      {statuses.length > 0 ? (
        <div className="mt-4 border-t border-cdf-border pt-3" data-testid="declare">
          <h3 className="mb-1 font-semibold">{t("meetings.declareTitle")}</h3>
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("meetings.declareIntro")}</p>
          <CDFCommandForm
            action={declareConflictAction.bind(null, meetingId, me.participantId)}
            locale={t.locale}
            submitLabel={t("meetings.declare")}
            variant="primary"
            testId="declare-form"
            successMessage={t("meetings.declared")}
            fieldLabels={{ status: t("meetings.declareStatusLabel"), reason: t("meetings.reasonLabel") }}
            confirm={{
              ...confirmation(t, "declareMeetingConflict"),
              when: { field: "status", equals: "CONFLICT_DECLARED" },
            }}
          >
            <fieldset className="mb-4">
              <legend className="mb-1 font-semibold">{t("meetings.declareStatusLabel")}</legend>
              {statuses.map((s) => (
                <div key={s} className="mb-1 flex items-start gap-2">
                  <input
                    id={`declare-${s}`}
                    type="radio"
                    name="status"
                    value={s}
                    className="mt-1 size-5"
                    required
                    data-testid={`declare-${s}`}
                  />
                  <label htmlFor={`declare-${s}`}>
                    {s === "NO_CONFLICT" ? t("meetings.declareNoConflict") : t("meetings.declareConflict")}
                  </label>
                </div>
              ))}
            </fieldset>
            <CDFField
              id="declare-reason"
              label={t("meetings.reasonLabel")}
              hint={t("meetings.declareReasonHint")}
              optionalLabel={t("common.optional")}
            >
              <textarea
                id="declare-reason"
                name="reason"
                className={textareaClass}
                aria-describedby="declare-reason-hint"
                minLength={5}
                maxLength={2000}
              />
            </CDFField>
          </CDFCommandForm>
        </div>
      ) : null}

      {cap.mayAcknowledgeConfidentiality ? (
        <div className="mt-4 border-t border-cdf-border pt-3" data-testid="acknowledge">
          <h3 className="mb-1 font-semibold">{t("meetings.ackTitle")}</h3>
          <p className="mb-3 text-sm">{t("meetings.ackBody")}</p>
          <CDFCommandForm
            action={acknowledgeConfidentialityAction.bind(null, meetingId, me.participantId)}
            locale={t.locale}
            submitLabel={t("meetings.acknowledge")}
            variant="primary"
            testId="acknowledge-form"
            successMessage={t("meetings.acknowledged")}
          />
        </div>
      ) : null}

      {me.accommodations.length > 0 || cap.mayRecordAccommodation ? (
        <div className="mt-4 border-t border-cdf-border pt-3" data-testid="my-accommodations">
          <h3 className="mb-1 font-semibold">{t("meetings.myAccommodationsTitle")}</h3>
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("meetings.accommodationsIntro")}</p>
          {me.accommodations.length > 0 ? (
            <AccommodationList t={t} items={me.accommodations} testId="my-accommodation-list" />
          ) : (
            <p className="text-sm text-cdf-text-secondary" data-testid="my-no-accommodations">
              {t("meetings.noAccommodations")}
            </p>
          )}
          {cap.mayRecordAccommodation ? (
            <div className="mt-3">
              <AccommodationForm
                t={t}
                meetingId={meetingId}
                participantId={me.participantId}
                idBase="my-accommodation"
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </CDFCard>
  );
}
