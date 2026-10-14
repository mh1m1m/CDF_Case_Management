// Conflicts raised in one meeting (ADR-038, DEC-F04, DEC-AMB-010), as authz.can_view_meeting_concern shows them: who
// raised each one and why, the decision and any reversal. The decide and reverse forms appear only where the concern's
// own capabilities say so; the database decides again on submit. Reasons are committee content, shown whole.
import type { MeetingConcernView } from "@cdf/contracts";
import { formatDateTime, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFCard, CDFCommandForm, CDFField, CDFStatusBadge, inputClass, textareaClass } from "@cdf/ui";
import { confirmation } from "../../confirmations";
import { decideConcernAction, reverseConcernAction } from "./actions";

export interface MeetingNames {
  /** A participant's name, where the caller may see the roster. */
  participant: (participantId: string) => string | undefined;
  /** A person's name by user id, where they are on the roster the caller sees. */
  user: (userId: string) => string | undefined;
}

export function MeetingConcerns({
  t,
  meetingId,
  concerns,
  names,
  title,
}: {
  t: Translator;
  meetingId: string;
  concerns: MeetingConcernView[];
  names: MeetingNames;
  title?: string;
}) {
  const when = (iso: string) => isolate(formatDateTime(t.locale, iso));
  return (
    <CDFCard title={title ?? t("meetings.concernsTitle")} testId="meeting-concerns">
      {concerns.length === 0 ? (
        <p className="text-cdf-text-secondary" data-testid="no-concerns">
          {t("meetings.noConcerns")}
        </p>
      ) : (
        <ol className="grid gap-4" data-testid="concern-list">
          {concerns.map((c, i) => {
            const n = i + 1;
            const about = names.participant(c.participantId) ?? t("meetings.aParticipant");
            const aboutName = isolate(about);
            return (
              <li
                key={c.concernId}
                className="border-b border-cdf-border pb-4 last:border-0 last:pb-0"
                data-testid={`concern-${n}`}
              >
                <h3 className="flex flex-wrap items-center gap-2 font-semibold">
                  <span>{t("meetings.concernAbout", { name: aboutName })}</span>
                  <CDFStatusBadge domain="concern" status={c.status} testId={`concern-${n}-status`}>
                    {t(`meetings.concernStatus.${c.status}` as MessageKey)}
                  </CDFStatusBadge>
                </h3>
                <p className="mt-1 text-sm text-cdf-text-secondary">
                  {t("meetings.raisedBy", {
                    date: when(c.raisedAt),
                    who: isolate(
                      names.user(c.raisedBy) ?? t(`meetings.raisedAs.${c.raisedAs}` as MessageKey),
                    ),
                  })}
                </p>
                <p className="mt-2 text-sm font-semibold">{t("meetings.concernReason")}</p>
                <p className="whitespace-pre-wrap break-words" data-testid={`concern-${n}-reason`}>
                  <bdi dir="auto">{c.reason}</bdi>
                </p>
                {c.decidedAt && c.decidedBy && c.decidedAs ? (
                  <>
                    <p className="mt-2 text-sm text-cdf-text-secondary" data-testid={`concern-${n}-decided`}>
                      {t("meetings.decidedBy", {
                        date: when(c.decidedAt),
                        who: isolate(
                          names.user(c.decidedBy) ?? t(`meetings.decidedAs.${c.decidedAs}` as MessageKey),
                        ),
                      })}
                    </p>
                    {c.decisionReason ? (
                      <>
                        <p className="mt-1 text-sm font-semibold">{t("meetings.decisionReason")}</p>
                        <p className="whitespace-pre-wrap break-words">
                          <bdi dir="auto">{c.decisionReason}</bdi>
                        </p>
                      </>
                    ) : null}
                  </>
                ) : null}
                {c.reversal ? (
                  <>
                    <p className="mt-2 text-sm text-cdf-text-secondary" data-testid={`concern-${n}-reversed`}>
                      {t("meetings.reversedBy", {
                        date: when(c.reversal.reversedAt),
                        who: isolate(
                          names.user(c.reversal.reversedBy) ??
                            t(`meetings.decidedAs.${c.reversal.reversedAs}` as MessageKey),
                        ),
                      })}
                    </p>
                    <p className="mt-1 text-sm font-semibold">{t("meetings.reversalReason")}</p>
                    <p className="whitespace-pre-wrap break-words">
                      <bdi dir="auto">{c.reversal.reason}</bdi>
                    </p>
                  </>
                ) : null}

                {c.capabilities.mayDecide ? (
                  <div className="mt-3 border-t border-cdf-border pt-3" data-testid={`concern-${n}-decide`}>
                    <h4 className="mb-2 font-semibold">{t("meetings.decideTitle")}</h4>
                    <CDFCommandForm
                      action={decideConcernAction.bind(null, meetingId, c.concernId)}
                      locale={t.locale}
                      submitLabel={t("meetings.decide")}
                      submitName={t("meetings.decideName", { name: aboutName })}
                      variant="primary"
                      testId={`concern-${n}-decide-form`}
                      successMessage={t("meetings.decided")}
                      fieldLabels={{
                        decision: t("meetings.decisionLabel"),
                        reason: t("meetings.reasonLabel"),
                      }}
                      confirm={confirmation(t, "decideMeetingConcern")}
                    >
                      <CDFField id={`concern-${n}-decision`} label={t("meetings.decisionLabel")}>
                        <select
                          id={`concern-${n}-decision`}
                          name="decision"
                          className={inputClass}
                          defaultValue=""
                          required
                        >
                          <option value="" disabled>
                            {t("common.choose")}
                          </option>
                          <option value="UPHELD">{t("meetings.uphold")}</option>
                          <option value="DISMISSED">{t("meetings.dismiss")}</option>
                        </select>
                      </CDFField>
                      <CDFField
                        id={`concern-${n}-decide-reason`}
                        label={t("meetings.reasonLabel")}
                        hint={t("meetings.longReasonHint")}
                      >
                        <textarea
                          id={`concern-${n}-decide-reason`}
                          name="reason"
                          className={textareaClass}
                          aria-describedby={`concern-${n}-decide-reason-hint`}
                          minLength={10}
                          maxLength={2000}
                          required
                        />
                      </CDFField>
                    </CDFCommandForm>
                  </div>
                ) : null}

                {c.capabilities.mayReverse ? (
                  <details
                    className="mt-3 border-t border-cdf-border pt-3"
                    data-testid={`concern-${n}-reverse`}
                  >
                    <summary className="cursor-pointer font-semibold">{t("meetings.reverseTitle")}</summary>
                    <div className="mt-3">
                      <CDFCommandForm
                        action={reverseConcernAction.bind(null, meetingId, c.concernId)}
                        locale={t.locale}
                        submitLabel={t("meetings.reverse")}
                        submitName={t("meetings.reverseName", { name: aboutName })}
                        variant="secondary"
                        testId={`concern-${n}-reverse-form`}
                        successMessage={t("meetings.reversed")}
                        fieldLabels={{ reason: t("meetings.reasonLabel") }}
                        confirm={confirmation(t, "reverseMeetingConcern")}
                      >
                        <CDFField
                          id={`concern-${n}-reverse-reason`}
                          label={t("meetings.reasonLabel")}
                          hint={t("meetings.longReasonHint")}
                        >
                          <textarea
                            id={`concern-${n}-reverse-reason`}
                            name="reason"
                            className={textareaClass}
                            aria-describedby={`concern-${n}-reverse-reason-hint`}
                            minLength={10}
                            maxLength={2000}
                            required
                          />
                        </CDFField>
                      </CDFCommandForm>
                    </div>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </CDFCard>
  );
}
