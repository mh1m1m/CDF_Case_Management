// The meeting's participants (api.meeting_view roster, for callers who pass authz.can_view_meeting_roster). Each row's
// capabilities are computed for the meeting's runner and are false for anyone else (2065): only the runner records
// attendance or an excuse, or raises a conflict about a named row. A member raises one from the meeting-level
// capability and chooses the participant; the command answers for that participant.
import type { ReactNode } from "react";
import { RECORDABLE_ATTENDANCE, type MeetingParticipantView } from "@cdf/contracts";
import { isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFCard, CDFCommandForm, CDFField, inputClass, textareaClass } from "@cdf/ui";
import { confirmation } from "../../confirmations";
import { partLabel, participantName } from "../meeting-labels";
import { raiseConcernAction, recordAttendanceAction, recordExcusedAbsenceAction } from "./actions";

const ATTENDANCE_FLAG = {
  PRESENT: "mayRecordPresent",
  ABSENT: "mayRecordAbsent",
  EXCUSED_CONFLICT: "mayRecordExcusedConflict",
} as const;

export function MeetingParticipants({
  t,
  meetingId,
  roster,
  myParticipantId,
  memberMayRaise,
}: {
  t: Translator;
  meetingId: string;
  roster: MeetingParticipantView[];
  myParticipantId: string | null;
  /** The meeting-level may_raise_concern of a member who does not run the meeting. */
  memberMayRaise: boolean;
}) {
  // Whom a member may raise a conflict about, as far as the roster shows: never oneself, never someone who has
  // declared a conflict or needs no declaration. The command checks the rest (an open concern, an exclusion).
  const raisable = roster.filter(
    (p) => p.participantId !== myParticipantId && p.requiresCoi && p.coiStatus !== "CONFLICT_DECLARED",
  );
  return (
    <CDFCard title={t("meetings.participantsTitle")} testId="meeting-participants">
      <ul className="grid gap-3" data-testid="participant-list">
        {roster.map((p, i) => {
          const n = i + 1;
          const name = participantName(t, p);
          const mine = p.participantId === myParticipantId;
          const attendance = RECORDABLE_ATTENDANCE.filter((a) => p.capabilities[ATTENDANCE_FLAG[a]]);
          const any =
            attendance.length > 0 || p.capabilities.mayRecordExcusedAbsence || p.capabilities.mayRaiseConcern;
          return (
            <li
              key={p.participantId}
              className="border-b border-cdf-border pb-3 last:border-0 last:pb-0"
              data-testid={`participant-${n}`}
            >
              <p className="font-semibold">
                <bdi>{name}</bdi>
                {mine ? <span className="ms-1 font-normal">({t("meetings.youMark")})</span> : null}
              </p>
              <p className="text-sm text-cdf-text-secondary">
                {partLabel(t, p)}
                {p.participantKind === "MEMBER"
                  ? ` · ${p.isVoting ? t("meetings.voting") : t("meetings.nonVoting")}`
                  : null}
              </p>
              <p className="text-sm" data-testid={`participant-${n}-state`}>
                {t("meetings.coiValue", { status: t(`meetings.coi.${p.coiStatus}` as MessageKey) })} ·{" "}
                {t("meetings.attendanceValue", {
                  status: t(`meetings.attendance.${p.attendance}` as MessageKey),
                })}
              </p>
              {any ? (
                <details className="mt-2" data-testid={`participant-${n}-actions`}>
                  <summary className="cursor-pointer font-semibold">
                    {t("meetings.actionsFor", { name: isolate(name) })}
                  </summary>
                  <div className="mt-3 grid gap-4">
                    {attendance.length > 0 ? (
                      <CDFCommandForm
                        action={recordAttendanceAction.bind(null, meetingId, p.participantId)}
                        locale={t.locale}
                        submitLabel={t("meetings.recordAttendance")}
                        submitName={t("meetings.recordAttendanceName", { name: isolate(name) })}
                        variant="secondary"
                        testId={`participant-${n}-attendance-form`}
                        successMessage={t("meetings.attendanceRecorded")}
                        fieldLabels={{ attendance: t("meetings.attendanceLabel") }}
                      >
                        <CDFField id={`participant-${n}-attendance`} label={t("meetings.attendanceLabel")}>
                          <select
                            id={`participant-${n}-attendance`}
                            name="attendance"
                            className={inputClass}
                            defaultValue={attendance[0]}
                          >
                            {attendance.map((a) => (
                              <option key={a} value={a}>
                                {t(`meetings.attendance.${a}` as MessageKey)}
                              </option>
                            ))}
                          </select>
                        </CDFField>
                      </CDFCommandForm>
                    ) : null}
                    {p.capabilities.mayRecordExcusedAbsence ? (
                      <div className="border-t border-cdf-border pt-3">
                        <h4 className="mb-2 font-semibold">{t("meetings.excuseTitle")}</h4>
                        <CDFCommandForm
                          action={recordExcusedAbsenceAction.bind(null, meetingId, p.participantId)}
                          locale={t.locale}
                          submitLabel={t("meetings.excuse")}
                          submitName={t("meetings.excuseName", { name: isolate(name) })}
                          variant="secondary"
                          testId={`participant-${n}-excuse-form`}
                          successMessage={t("meetings.excused")}
                          fieldLabels={{ reason: t("meetings.reasonLabel") }}
                        >
                          <CDFField
                            id={`participant-${n}-excuse-reason`}
                            label={t("meetings.reasonLabel")}
                            hint={t("meetings.reasonHint")}
                          >
                            <textarea
                              id={`participant-${n}-excuse-reason`}
                              name="reason"
                              className={textareaClass}
                              aria-describedby={`participant-${n}-excuse-reason-hint`}
                              minLength={5}
                              maxLength={2000}
                              required
                            />
                          </CDFField>
                        </CDFCommandForm>
                      </div>
                    ) : null}
                    {p.capabilities.mayRaiseConcern ? (
                      <div className="border-t border-cdf-border pt-3">
                        <h4 className="mb-2 font-semibold">{t("meetings.raiseTitle")}</h4>
                        <p className="mb-2 text-sm text-cdf-text-secondary">{t("meetings.raiseIntro")}</p>
                        <RaiseForm
                          t={t}
                          meetingId={meetingId}
                          participantId={p.participantId}
                          idBase={`participant-${n}-raise`}
                          submitName={t("meetings.raiseName", { name: isolate(name) })}
                        />
                      </div>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>

      {memberMayRaise && raisable.length > 0 ? (
        <details className="mt-4 border-t border-cdf-border pt-3" data-testid="member-raise">
          <summary className="cursor-pointer font-semibold">{t("meetings.raiseTitle")}</summary>
          <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">{t("meetings.raiseIntro")}</p>
          <RaiseForm t={t} meetingId={meetingId} participantId={null} idBase="member-raise">
            <CDFField id="member-raise-participant" label={t("meetings.raiseAbout")}>
              <select
                id="member-raise-participant"
                name="participantId"
                className={inputClass}
                defaultValue=""
                required
              >
                <option value="" disabled>
                  {t("common.choose")}
                </option>
                {raisable.map((p) => (
                  <option key={p.participantId} value={p.participantId}>
                    {participantName(t, p)} · {partLabel(t, p)}
                  </option>
                ))}
              </select>
            </CDFField>
          </RaiseForm>
        </details>
      ) : null}
    </CDFCard>
  );
}

/** Raising a conflict: the participant is bound (a roster row) or chosen (a member's form, as the child). */
function RaiseForm({
  t,
  meetingId,
  participantId,
  idBase,
  submitName,
  children,
}: {
  t: Translator;
  meetingId: string;
  participantId: string | null;
  idBase: string;
  submitName?: string;
  children?: ReactNode;
}) {
  return (
    <CDFCommandForm
      action={raiseConcernAction.bind(null, meetingId, participantId)}
      locale={t.locale}
      submitLabel={t("meetings.raise")}
      {...(submitName ? { submitName } : {})}
      variant="secondary"
      testId={`${idBase}-form`}
      successMessage={t("meetings.raised")}
      fieldLabels={{ participantId: t("meetings.raiseAbout"), reason: t("meetings.reasonLabel") }}
      confirm={confirmation(t, "raiseMeetingConcern")}
    >
      {children}
      <CDFField id={`${idBase}-reason`} label={t("meetings.reasonLabel")} hint={t("meetings.longReasonHint")}>
        <textarea
          id={`${idBase}-reason`}
          name="reason"
          className={textareaClass}
          aria-describedby={`${idBase}-reason-hint`}
          minLength={10}
          maxLength={2000}
          required
        />
      </CDFField>
    </CDFCommandForm>
  );
}
