// The meeting's participants (api.meeting_view roster, for callers who pass authz.can_view_meeting_roster). Each row's
// capabilities are computed for the meeting's runner and are false for anyone else (2065): only the runner records
// attendance or an excuse, or raises a conflict about a named row. A member raises one from the meeting-level
// capability and chooses the participant; the command answers for that participant. P12-2b (2085, ADR-055) adds the
// runner's logistics on a row: excluding a witness, an accommodation, an alternate sitting for a member, and, for a
// participant without an account, the declaration and acknowledgement the secretary records for them (ADR-054 §5).
// A row's arrangements (the acknowledgement and accommodations) come only to the runner; the caller's own are in their
// part of the meeting.
import type { ReactNode } from "react";
import Link from "next/link";
import { RECORDABLE_ATTENDANCE, type MeetingParticipantView } from "@cdf/contracts";
import { isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFCard, CDFCommandForm, CDFField, inputClass, textareaClass } from "@cdf/ui";
import { actLabel, confirmation } from "../../confirmations";
import { partLabel, participantName } from "../meeting-labels";
import { AccommodationForm, AccommodationList } from "./accommodations";
import {
  acknowledgeConfidentialityAction,
  activateAlternateMemberAction,
  declareConflictAction,
  excludeWitnessAction,
  raiseConcernAction,
  recordAttendanceAction,
  recordExcusedAbsenceAction,
} from "./actions";

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
  inviteHref = null,
}: {
  t: Translator;
  meetingId: string;
  roster: MeetingParticipantView[];
  myParticipantId: string | null;
  /** The meeting-level may_raise_concern of a member who does not run the meeting. */
  memberMayRaise: boolean;
  /** The invite page, where api.meeting_view says the caller may invite (P12-2c). */
  inviteHref?: string | null;
}) {
  // Whom a member may raise a conflict about, as far as the roster shows: never oneself, never someone who has
  // declared a conflict or needs no declaration. The command checks the rest (an open concern, an exclusion).
  const raisable = roster.filter(
    (p) => p.participantId !== myParticipantId && p.requiresCoi && p.coiStatus !== "CONFLICT_DECLARED",
  );
  const nameOf = new Map(roster.map((p) => [p.participantId, participantName(t, p)] as const));
  return (
    <CDFCard title={t("meetings.participantsTitle")} testId="meeting-participants">
      <ul className="grid gap-3" data-testid="participant-list">
        {roster.map((p, i) => {
          const n = i + 1;
          const name = participantName(t, p);
          const mine = p.participantId === myParticipantId;
          const c = p.capabilities;
          const attendance = RECORDABLE_ATTENDANCE.filter((a) => c[ATTENDANCE_FLAG[a]]);
          // The caller's own declaration, acknowledgement and accommodations are in their part of the meeting; on a
          // row without an account these are the secretary's path.
          const onBehalf = !mine && p.userId === null;
          const declareFor = onBehalf
            ? [
                ...(c.mayDeclareNoConflict ? (["NO_CONFLICT"] as const) : []),
                ...(c.mayDeclareConflict ? (["CONFLICT_DECLARED"] as const) : []),
              ]
            : [];
          const acknowledgeFor = onBehalf && c.mayAcknowledgeConfidentiality;
          const accommodate = !mine && c.mayRecordAccommodation;
          const any =
            attendance.length > 0 ||
            c.mayRecordExcusedAbsence ||
            c.mayRaiseConcern ||
            c.mayExcludeWitness ||
            accommodate ||
            declareFor.length > 0 ||
            acknowledgeFor ||
            c.mayActivateAlternate;
          const arrangements = mine ? null : p.arrangements;
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
                {arrangements?.confidentialityAcknowledged
                  ? ` · ${t("meetings.acknowledgedConfidentiality")}`
                  : null}
              </p>
              {arrangements && arrangements.accommodations.length > 0 ? (
                <div className="mt-2">
                  <AccommodationList
                    t={t}
                    items={arrangements.accommodations}
                    testId={`participant-${n}-accommodations`}
                  />
                </div>
              ) : null}
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
                    {c.mayRecordExcusedAbsence ? (
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
                    {c.mayRaiseConcern ? (
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
                    {declareFor.length > 0 || acknowledgeFor ? (
                      <OnBehalf
                        t={t}
                        meetingId={meetingId}
                        participantId={p.participantId}
                        idBase={`participant-${n}`}
                        name={name}
                        statuses={declareFor}
                        acknowledge={acknowledgeFor}
                      />
                    ) : null}
                    {accommodate ? (
                      <div className="border-t border-cdf-border pt-3">
                        <h4 className="mb-1 font-semibold">{t("meetings.accommodationsTitle")}</h4>
                        <p className="mb-3 text-sm text-cdf-text-secondary">
                          {t("meetings.accommodationsIntro")}
                        </p>
                        <AccommodationForm
                          t={t}
                          meetingId={meetingId}
                          participantId={p.participantId}
                          idBase={`participant-${n}-accommodation`}
                          submitName={t("meetings.recordAccommodationName", { name: isolate(name) })}
                        />
                      </div>
                    ) : null}
                    {c.mayActivateAlternate ? (
                      <div className="border-t border-cdf-border pt-3">
                        <h4 className="mb-1 font-semibold">{t("meetings.alternateTitle")}</h4>
                        <p className="mb-3 text-sm text-cdf-text-secondary">{t("meetings.alternateIntro")}</p>
                        <CDFCommandForm
                          action={activateAlternateMemberAction.bind(null, meetingId, p.participantId)}
                          locale={t.locale}
                          submitLabel={t("meetings.activateAlternate")}
                          submitName={t("meetings.activateAlternateName", { name: isolate(name) })}
                          variant="secondary"
                          testId={`participant-${n}-alternate-form`}
                          successMessage={t("meetings.alternateActivated")}
                          fieldLabels={{
                            replacesParticipantId: t("meetings.alternateFor"),
                            reason: t("meetings.reasonLabel"),
                          }}
                          confirm={confirmation(t, "activateAlternateMember")}
                        >
                          <CDFField id={`participant-${n}-alternate-for`} label={t("meetings.alternateFor")}>
                            <select
                              id={`participant-${n}-alternate-for`}
                              name="replacesParticipantId"
                              className={inputClass}
                              defaultValue=""
                              required
                            >
                              <option value="" disabled>
                                {t("common.choose")}
                              </option>
                              {p.alternateFor.map((id) => (
                                <option key={id} value={id}>
                                  {nameOf.get(id) ?? t("meetings.aParticipant")}
                                </option>
                              ))}
                            </select>
                          </CDFField>
                          <ReasonField t={t} id={`participant-${n}-alternate-reason`} />
                        </CDFCommandForm>
                      </div>
                    ) : null}
                    {c.mayExcludeWitness ? (
                      // Excluding is final for this meeting: the last action on the row, and confirmed (UX-031).
                      <div className="border-t border-cdf-border pt-3">
                        <h4 className="mb-1 font-semibold">{t("meetings.excludeTitle")}</h4>
                        <p className="mb-3 text-sm text-cdf-text-secondary">{t("meetings.excludeIntro")}</p>
                        <CDFCommandForm
                          action={excludeWitnessAction.bind(null, meetingId, p.participantId)}
                          locale={t.locale}
                          submitLabel={t("meetings.exclude")}
                          submitName={t("meetings.excludeName", { name: isolate(name) })}
                          variant="danger"
                          testId={`participant-${n}-exclude-form`}
                          successMessage={t("meetings.witnessExcluded")}
                          fieldLabels={{ reason: t("meetings.reasonLabel") }}
                          confirm={confirmation(t, "excludeWitness")}
                        >
                          <ReasonField t={t} id={`participant-${n}-exclude-reason`} />
                        </CDFCommandForm>
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

      {inviteHref ? (
        <div className="mt-4 border-t border-cdf-border pt-3" data-testid="meeting-invite">
          <p className="mb-1 text-sm text-cdf-text-secondary">{t("committeeProceedings.inviteIntroLink")}</p>
          <Link href={inviteHref} className="font-semibold underline" data-testid="meeting-invite-link">
            {t("committeeProceedings.inviteLink")}
          </Link>
        </div>
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

/** A reason of 10 to 2,000 characters: an exclusion, an activation. */
function ReasonField({ t, id }: { t: Translator; id: string }) {
  return (
    <CDFField id={id} label={t("meetings.reasonLabel")} hint={t("meetings.longReasonHint")}>
      <textarea
        id={id}
        name="reason"
        className={textareaClass}
        aria-describedby={`${id}-hint`}
        minLength={10}
        maxLength={2000}
        required
      />
    </CDFField>
  );
}

/**
 * The secretary's path for a participant without an account (ADR-054 §5): the declaration they made and their
 * undertaking of confidentiality, recorded by the meeting's runner. Each command records SECRETARY as the source.
 */
function OnBehalf({
  t,
  meetingId,
  participantId,
  idBase,
  name,
  statuses,
  acknowledge,
}: {
  t: Translator;
  meetingId: string;
  participantId: string;
  idBase: string;
  name: string;
  statuses: readonly ("NO_CONFLICT" | "CONFLICT_DECLARED")[];
  acknowledge: boolean;
}) {
  return (
    <div className="border-t border-cdf-border pt-3" data-testid={`${idBase}-on-behalf`}>
      <h4 className="mb-1 font-semibold">{t("meetings.forParticipantTitle")}</h4>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("meetings.forParticipantIntro")}</p>
      {statuses.length > 0 ? (
        <CDFCommandForm
          action={declareConflictAction.bind(null, meetingId, participantId)}
          locale={t.locale}
          submitLabel={actLabel(t, "declareForParticipant")}
          submitName={t("meetings.declareForName", { name: isolate(name) })}
          variant="secondary"
          testId={`${idBase}-declare-for-form`}
          successMessage={t("meetings.declared")}
          fieldLabels={{ status: t("meetings.declareForStatusLabel"), reason: t("meetings.reasonLabel") }}
          confirm={{
            ...confirmation(t, "declareForParticipant"),
            when: { field: "status", equals: "CONFLICT_DECLARED" },
          }}
        >
          <fieldset className="mb-4">
            <legend className="mb-1 font-semibold">{t("meetings.declareForStatusLabel")}</legend>
            {statuses.map((s) => (
              <div key={s} className="mb-1 flex items-start gap-2">
                <input
                  id={`${idBase}-declare-for-${s}`}
                  type="radio"
                  name="status"
                  value={s}
                  className="mt-1 size-5"
                  required
                  data-testid={`${idBase}-declare-for-${s}`}
                />
                <label htmlFor={`${idBase}-declare-for-${s}`}>
                  {s === "NO_CONFLICT"
                    ? t("meetings.declareForNoConflict")
                    : t("meetings.declareForConflict")}
                </label>
              </div>
            ))}
          </fieldset>
          <CDFField
            id={`${idBase}-declare-for-reason`}
            label={t("meetings.reasonLabel")}
            hint={t("meetings.declareForReasonHint")}
            optionalLabel={t("common.optional")}
          >
            <textarea
              id={`${idBase}-declare-for-reason`}
              name="reason"
              className={textareaClass}
              aria-describedby={`${idBase}-declare-for-reason-hint`}
              minLength={5}
              maxLength={2000}
            />
          </CDFField>
        </CDFCommandForm>
      ) : null}
      {acknowledge ? (
        <div className={statuses.length > 0 ? "mt-4" : undefined}>
          <p className="mb-3 text-sm">{t("meetings.acknowledgeFor")}</p>
          <CDFCommandForm
            action={acknowledgeConfidentialityAction.bind(null, meetingId, participantId)}
            locale={t.locale}
            submitLabel={actLabel(t, "acknowledgeForParticipant")}
            submitName={t("meetings.acknowledgeForName", { name: isolate(name) })}
            variant="secondary"
            testId={`${idBase}-acknowledge-for-form`}
            successMessage={t("meetings.acknowledged")}
            confirm={confirmation(t, "acknowledgeForParticipant")}
          />
        </div>
      ) : null}
    </div>
  );
}
