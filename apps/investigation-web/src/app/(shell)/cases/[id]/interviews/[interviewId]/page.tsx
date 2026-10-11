// Interview detail (CDF-60). Opening it records INTERVIEW_VIEWED (or a SECURITY denial); missing and
// invisible interviews are both 404. Forms appear only where the lifecycle and the viewer's case relationship
// allow them; every command is re-checked by the database.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  INTERVIEW_MODES,
  INTERVIEW_NOTICE_CHANNELS,
  INTERVIEW_RECORDING_EVIDENCE_TYPES,
  RIGHTS_ACK_METHODS,
  STATEMENT_ACK_METHODS,
  type InterviewAction,
} from "@cdf/contracts";
import {
  INTERVIEW_TRANSITIONS,
  evidenceDisplayNumber,
  interviewActionsFrom,
  interviewDisplayNumber,
  interviewSteps,
  interviewStepsOpen,
  transitionBlockers,
  type InterviewStep,
} from "@cdf/domain";
import { formatDateTime, isolate, type MessageKey } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFCommandForm,
  CDFDescriptionList,
  CDFField,
  CDFProgressTracker,
  classificationTone,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { evidenceService, interviewService, investigationService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { confirmation } from "../../../../confirmations";
import {
  acknowledgeStatementAction,
  addParticipantAction,
  issueNoticeAction,
  linkRecordingAction,
  recordConductedAction,
  recordRightsAction,
  recordStatementAction,
  scheduleAction,
  transitionInterviewAction,
} from "../actions";
import { interviewStatusTone } from "../status-tone";
import { evidenceItemHref } from "../../evidence-panel";
import { CaseWorkspace, loadCase } from "../../workspace";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or case content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.interviewDetail") };
}

const UUID = /^[0-9a-f-]{36}$/i;
// Interview refusals have their own codes; fall back to the shared ones.
const INTERVIEW_CODES = ["interviews.codes", "codes"] as const;

/** ISO instant → value for <input type="datetime-local"> in Riyadh time (UTC+3, no DST). */
function riyadhLocal(iso: string | null): string | undefined {
  if (!iso) return undefined;
  return new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 16);
}

export default async function InterviewDetailPage({
  params,
}: {
  params: Promise<{ id: string; interviewId: string }>;
}) {
  const { id, interviewId } = await params;
  if (!UUID.test(interviewId)) notFound();
  const { actor, ctx, t, c } = await loadCase(id);
  const i = await interviewService().getInterview(ctx, interviewId);
  if (!i || i.caseId !== c.id) notFound();

  // authz.can_conduct/review/approve_interviews, read with the case (UX-116); every command checks again.
  const { conductInterviews: canConduct, reviewInterviews: canReview, approveInterviews: canApprove } = c.can;
  const onPanel = i.participants.some((p) => p.userId === actor.userId);
  const interviewer = i.participants.some(
    (p) => p.userId === actor.userId && p.participantRole !== "NOTE_TAKER",
  );
  const open = interviewStepsOpen(i.status);
  const allowedFor = (a: InterviewAction) =>
    a === "PREPARE" || a === "CANCEL" ? canConduct : a === "APPROVE" ? canApprove : canReview;
  const actions = interviewActionsFrom(i.status).filter(allowedFor);

  const [directory, evidence] = await Promise.all([
    canConduct && open.addParticipant ? investigationService().directory(ctx) : Promise.resolve([]),
    canConduct && open.linkRecording ? evidenceService().listEvidence(ctx, c.id) : Promise.resolve([]),
  ]);
  const linkable = evidence.filter(
    (e) =>
      e.status === "AVAILABLE" &&
      (INTERVIEW_RECORDING_EVIDENCE_TYPES as readonly string[]).includes(e.evidenceType) &&
      !i.recordings.some((r) => r.evidenceId === e.id),
  );
  // RLS lists a recording only with its evidence item, which only the team sees (DEC-09); link it to the item's page.
  const register = c.evidenceAccess === "TEAM" || c.evidenceAccess === "LEADS";
  const current = i.statements.find((s) => s.id === i.currentStatementVersionId) ?? null;
  const name = (n: { displayName: string; displayNameAr?: string }) =>
    t.locale === "ar" && n.displayNameAr ? n.displayNameAr : n.displayName;
  // Names, dates and references sit inside translated sentences: each is a direction isolate (FSI…PDI), so a
  // Latin name or reference never reorders an Arabic date around it (CDF-68).
  const when = (iso: string | null) => (iso ? isolate(formatDateTime(t.locale, iso)) : "—");
  /** A panel member's name in the page's language; anyone else by the name read with the interview. */
  const byName = (userId: string | null, fallback: string | null) => {
    const p = i.participants.find((x) => x.userId === userId);
    return isolate(p ? name(p) : (fallback ?? "—"));
  };
  const number = interviewDisplayNumber(i.sequenceNo);
  const reporter = i.intervieweeKind === "REPORTER";

  // The steps in order with one current step (UX-033): only that step's forms are open. Completed steps are
  // read-only below it; later steps show only in the stepper. Every command re-checks in the database.
  const steps = interviewSteps(i);
  const now = steps.find((s) => s.state === "current")?.step ?? null;
  const stepName = (step: InterviewStep) => t(`interviews.steps.name.${step}` as MessageKey);
  /** Who may take a step, by role and never by name; shown when the viewer cannot take it. */
  const who = (step: InterviewStep) => (
    <p className="text-sm text-cdf-text-secondary" data-testid="step-who">
      {t(`interviews.steps.who.${step}` as MessageKey)}
    </p>
  );
  const canTake: Record<InterviewStep, boolean> = {
    SCHEDULE: canConduct && open.schedule,
    INVITE: canConduct && open.notice,
    RIGHTS: canConduct && interviewer && open.rights && !i.rightsAckMethod,
    CONDUCT: canConduct && interviewer && open.conduct,
    STATEMENT: canConduct && onPanel && open.statement,
    PREPARE: actions.includes("PREPARE"),
    REVIEW: actions.includes("REVIEW"),
    APPROVE: actions.includes("APPROVE"),
  };

  const scheduleForm = (
    <CDFCommandForm
      codeSections={INTERVIEW_CODES}
      variant="secondary"
      action={scheduleAction.bind(null, c.id, i.id)}
      locale={t.locale}
      submitLabel={t("interviews.saveSchedule")}
      testId="schedule-form"
      successMessage={t("interviews.saved")}
      fieldLabels={{
        scheduledStart: t("interviews.scheduledStartLabel"),
        durationMinutes: t("interviews.durationLabel"),
        mode: t("interviews.modeLabel"),
        location: t("interviews.locationLabel"),
      }}
    >
      <CDFField id="scheduledStart" label={t("interviews.scheduledStartLabel")}>
        <input
          id="scheduledStart"
          name="scheduledStart"
          type="datetime-local"
          dir="ltr"
          className={inputClass}
          defaultValue={riyadhLocal(i.scheduledStart)}
          required
        />
      </CDFField>
      <CDFField id="durationMinutes" label={t("interviews.durationLabel")}>
        <input
          id="durationMinutes"
          name="durationMinutes"
          type="number"
          min={15}
          max={480}
          step={5}
          dir="ltr"
          className={inputClass}
          defaultValue={i.durationMinutes ?? 60}
          required
        />
      </CDFField>
      <CDFField id="mode" label={t("interviews.modeLabel")}>
        <select id="mode" name="mode" className={inputClass} defaultValue={i.mode ?? "IN_PERSON"}>
          {INTERVIEW_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`interviews.modeName.${m}` as MessageKey)}
            </option>
          ))}
        </select>
      </CDFField>
      <CDFField
        id="location"
        label={t("interviews.locationLabel")}
        hint={t("interviews.locationHint")}
        optionalLabel={t("common.optional")}
      >
        <input
          id="location"
          name="location"
          className={inputClass}
          maxLength={200}
          defaultValue={i.location ?? ""}
          aria-describedby="location-hint"
        />
      </CDFField>
    </CDFCommandForm>
  );
  const noticeList = (
    <>
      {i.notices.length === 0 ? (
        <p className="text-cdf-text-secondary">{t("interviews.noNotices")}</p>
      ) : (
        <ul className="mb-3 list-disc ps-5 text-sm" data-testid="notice-list">
          {i.notices.map((n) => (
            <li key={n.id}>
              {t("interviews.noticeLine", {
                type: t(`interviews.noticeType.${n.noticeType}` as MessageKey),
                channel: t(`interviews.channel.${n.channel}` as MessageKey),
                when: when(n.scheduledStart),
                name: isolate(n.issuedByName ?? "—"),
              })}
            </li>
          ))}
        </ul>
      )}
    </>
  );
  const noticeForm = (
    <CDFCommandForm
      codeSections={INTERVIEW_CODES}
      variant="secondary"
      action={issueNoticeAction.bind(null, c.id, i.id)}
      locale={t.locale}
      submitLabel={t("interviews.issueNotice")}
      testId="notice-form"
      successMessage={t("interviews.saved")}
      fieldLabels={{
        noticeType: t("interviews.noticeTypeLabel"),
        channel: t("interviews.channelLabel"),
      }}
    >
      <CDFField id="noticeType" label={t("interviews.noticeTypeLabel")}>
        <select
          id="noticeType"
          name="noticeType"
          className={inputClass}
          defaultValue={i.notices.length ? "RESCHEDULE" : "INVITATION"}
        >
          {(["INVITATION", "RESCHEDULE"] as const).map((n) => (
            <option key={n} value={n}>
              {t(`interviews.noticeType.${n}` as MessageKey)}
            </option>
          ))}
        </select>
      </CDFField>
      <CDFField
        id="channel"
        label={t("interviews.channelLabel")}
        hint={reporter ? t("interviews.noticeReporterHint") : undefined}
      >
        <select
          id="channel"
          name="channel"
          className={inputClass}
          aria-describedby={reporter ? "channel-hint" : undefined}
        >
          {INTERVIEW_NOTICE_CHANNELS.filter((ch) => (ch === "PORTAL_MESSAGE") === reporter).map((ch) => (
            <option key={ch} value={ch}>
              {t(`interviews.channel.${ch}` as MessageKey)}
            </option>
          ))}
        </select>
      </CDFField>
    </CDFCommandForm>
  );
  const rightsStatus = (
    <p className="mb-3 font-semibold" data-testid="rights-status">
      {i.rightsAckMethod
        ? t("interviews.rightsRecorded", {
            method: t(`interviews.rightsMethod.${i.rightsAckMethod}` as MessageKey),
            version: isolate(i.rightsNoticeVersion ?? "—"),
            when: when(i.rightsAcknowledgedAt),
          })
        : t("interviews.rightsNotRecorded")}
    </p>
  );
  const conductStatus = (
    <p className="mb-3 font-semibold" data-testid="conduct-status">
      {i.conductedStartedAt
        ? t("interviews.conducted", {
            from: when(i.conductedStartedAt),
            to: when(i.conductedEndedAt),
          })
        : t("interviews.conductNotRecorded")}
    </p>
  );
  const statementVersions = (
    <>
      {i.statements.length === 0 ? (
        <p className="text-cdf-text-secondary">{t("interviews.noStatement")}</p>
      ) : (
        <ol className="mb-3" data-testid="statement-versions">
          {[...i.statements].reverse().map((s) => (
            <li
              key={s.id}
              className="mb-4 border-b border-cdf-border pb-4 last:border-0"
              data-testid={`statement-v${s.versionNo}`}
            >
              <p className="mb-1 font-semibold">
                {t("interviews.version", { no: s.versionNo })}{" "}
                {s.id === i.currentStatementVersionId ? (
                  <CDFBadge tone="info">{t("interviews.current")}</CDFBadge>
                ) : null}{" "}
                <span className="text-sm font-normal text-cdf-text-secondary">
                  {t(`interviews.language.${s.language}` as MessageKey)}
                </span>
              </p>
              <p
                className="whitespace-pre-wrap break-words"
                lang={s.language}
                dir={s.language === "ar" ? "rtl" : "ltr"}
              >
                {s.content}
              </p>
              <p className="mt-1 text-sm text-cdf-text-secondary">
                {t("interviews.recordedBy", {
                  name: isolate(s.recordedByName ?? "—"),
                  when: when(s.recordedAt),
                })}
              </p>
              <code
                className="block break-all text-xs"
                dir="ltr"
                data-testid={`statement-sha-v${s.versionNo}`}
              >
                {t("interviews.sha256")}: {s.contentSha256}
              </code>
              <p className="mt-1 text-sm" data-testid={`statement-ack-v${s.versionNo}`}>
                {s.acknowledgement
                  ? t("interviews.ackLine", {
                      method: t(`interviews.ackMethod.${s.acknowledgement.method}` as MessageKey),
                      name: isolate(s.acknowledgement.recordedByName ?? "—"),
                      when: when(s.acknowledgement.recordedAt),
                    })
                  : t("interviews.ackNone")}
              </p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
  const statementForm = (
    <CDFCommandForm
      codeSections={INTERVIEW_CODES}
      variant="secondary"
      action={recordStatementAction.bind(null, c.id, i.id)}
      locale={t.locale}
      submitLabel={t("interviews.saveStatement")}
      testId="statement-form"
      successMessage={t("interviews.statementSaved")}
      fieldLabels={{
        content: t("interviews.contentLabel"),
        language: t("interviews.languageLabel"),
      }}
    >
      <CDFField id="statementContent" label={t("interviews.contentLabel")}>
        <textarea
          id="statementContent"
          name="content"
          className={textareaClass}
          maxLength={50000}
          defaultValue={current?.content ?? ""}
          required
        />
      </CDFField>
      <CDFField id="statementLanguage" label={t("interviews.languageLabel")}>
        <select
          id="statementLanguage"
          name="language"
          className={inputClass}
          defaultValue={current?.language ?? t.locale}
        >
          {(["ar", "en"] as const).map((l) => (
            <option key={l} value={l}>
              {t(`interviews.language.${l}` as MessageKey)}
            </option>
          ))}
        </select>
      </CDFField>
    </CDFCommandForm>
  );
  const actionItem = (a: InterviewAction) => {
    const blockers = transitionBlockers(i, a, actor.userId);
    return (
      <li key={a} className="mb-4 border-t border-cdf-border pt-3" data-testid={`interview-action-${a}`}>
        <p className="mb-2 font-semibold">{t(`interviews.action.${a}` as MessageKey)}</p>
        {blockers.length ? (
          <ul className="list-disc ps-5 text-sm text-cdf-text-secondary" data-testid={`blocked-${a}`}>
            {blockers.map((b) => (
              <li key={b}>{t.code("interviews.codes", b, "errors.CONFLICT")}</li>
            ))}
          </ul>
        ) : (
          <CDFCommandForm
            codeSections={INTERVIEW_CODES}
            action={transitionInterviewAction.bind(null, c.id, i.id, a)}
            locale={t.locale}
            submitLabel={t(`interviews.action.${a}` as MessageKey)}
            variant={a === "CANCEL" ? "danger" : a === "APPROVE" ? "primary" : "secondary"}
            fieldLabels={{ reason: t("interviews.reasonLabel") }}
            // UX-031: cancelling is final, so it is confirmed first.
            confirm={a === "CANCEL" ? confirmation(t, "cancelInterview") : undefined}
          >
            {INTERVIEW_TRANSITIONS[a].reasonRequired ? (
              <CDFField
                id={`reason-${a}`}
                label={t("interviews.reasonLabel")}
                hint={t("interviews.reasonHint")}
              >
                <textarea
                  id={`reason-${a}`}
                  name="reason"
                  className={textareaClass}
                  aria-describedby={`reason-${a}-hint`}
                  minLength={10}
                  required
                />
              </CDFField>
            ) : null}
          </CDFCommandForm>
        )}
      </li>
    );
  };
  // Returning and cancelling are not steps: they stay with the review record.
  const sideActions = actions.filter((a) => a === "RETURN" || a === "CANCEL");

  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="interviews" item={<bdi dir="ltr">{number}</bdi>}>
      {/* The case header is the page's h1; the interview is this tab's item (audit §22.1). */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-cdf-h2 font-semibold">
          <bdi dir="ltr">{number}</bdi> · <bdi dir="auto">{i.title}</bdi>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <CDFBadge tone={classificationTone(i.classification)}>
            {t(`classification.${i.classification}` as MessageKey)}
          </CDFBadge>
          <CDFBadge tone={interviewStatusTone(i.status)} testId="interview-status">
            {t(`interviews.statusName.${i.status}` as MessageKey)}
          </CDFBadge>
        </div>
      </div>
      <CDFProgressTracker
        label={t("interviews.steps.label")}
        current={now}
        testId="interview-steps"
        stateLabels={{
          done: t("cases.stepDone"),
          current: t("cases.stepCurrent"),
          upcoming: t("cases.stepUpcoming"),
          skipped: t("caseWorkspace.stepSkipped"),
        }}
        steps={steps.map((s) => ({ code: s.step, label: stepName(s.step), state: s.state }))}
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          {now ? (
            <CDFCard title={t("interviews.steps.now", { step: stepName(now) })} testId="current-step">
              <div data-step={now}>
                {now === "SCHEDULE" ? (canTake.SCHEDULE ? scheduleForm : who(now)) : null}
                {now === "INVITE" ? (
                  <>
                    {noticeList}
                    {canTake.INVITE ? <div className="mt-3">{noticeForm}</div> : who(now)}
                  </>
                ) : null}
                {now === "RIGHTS" ? (
                  <>
                    <p className="mb-2 text-sm text-cdf-text-secondary">{t("interviews.rightsIntro")}</p>
                    {rightsStatus}
                    {canTake.RIGHTS ? (
                      <CDFCommandForm
                        codeSections={INTERVIEW_CODES}
                        variant="secondary"
                        action={recordRightsAction.bind(null, c.id, i.id)}
                        locale={t.locale}
                        submitLabel={t("interviews.recordRights")}
                        testId="rights-form"
                        fieldLabels={{
                          method: t("interviews.rightsMethodLabel"),
                          noticeVersion: t("interviews.rightsVersionLabel"),
                        }}
                      >
                        <CDFField id="rightsMethod" label={t("interviews.rightsMethodLabel")}>
                          <select id="rightsMethod" name="method" className={inputClass}>
                            {RIGHTS_ACK_METHODS.map((m) => (
                              <option key={m} value={m}>
                                {t(`interviews.rightsMethod.${m}` as MessageKey)}
                              </option>
                            ))}
                          </select>
                        </CDFField>
                        <CDFField
                          id="noticeVersion"
                          label={t("interviews.rightsVersionLabel")}
                          hint={t("interviews.rightsVersionHint")}
                        >
                          <input
                            id="noticeVersion"
                            name="noticeVersion"
                            dir="ltr"
                            className={inputClass}
                            defaultValue="SYNTHETIC-RIGHTS-V1"
                            aria-describedby="noticeVersion-hint"
                            required
                          />
                        </CDFField>
                      </CDFCommandForm>
                    ) : (
                      who(now)
                    )}
                  </>
                ) : null}
                {now === "CONDUCT" ? (
                  <>
                    {conductStatus}
                    {canTake.CONDUCT ? (
                      <CDFCommandForm
                        codeSections={INTERVIEW_CODES}
                        variant="secondary"
                        action={recordConductedAction.bind(null, c.id, i.id)}
                        locale={t.locale}
                        submitLabel={t("interviews.recordConducted")}
                        testId="conduct-form"
                        fieldLabels={{
                          startedAt: t("interviews.startedAtLabel"),
                          endedAt: t("interviews.endedAtLabel"),
                        }}
                      >
                        <CDFField id="startedAt" label={t("interviews.startedAtLabel")}>
                          <input
                            id="startedAt"
                            name="startedAt"
                            type="datetime-local"
                            dir="ltr"
                            className={inputClass}
                            required
                          />
                        </CDFField>
                        <CDFField id="endedAt" label={t("interviews.endedAtLabel")}>
                          <input
                            id="endedAt"
                            name="endedAt"
                            type="datetime-local"
                            dir="ltr"
                            className={inputClass}
                            required
                          />
                        </CDFField>
                      </CDFCommandForm>
                    ) : (
                      who(now)
                    )}
                  </>
                ) : null}
                {now === "STATEMENT" ? (
                  <>
                    <p className="mb-3 text-sm text-cdf-text-secondary">{t("interviews.statementIntro")}</p>
                    {statementVersions}
                    {canTake.STATEMENT ? (
                      <div className="border-t border-cdf-border pt-3">{statementForm}</div>
                    ) : (
                      who(now)
                    )}
                    {canTake.STATEMENT && open.acknowledge && current && !current.acknowledgement ? (
                      <div className="mt-3 border-t border-cdf-border pt-3">
                        <h3 className="mb-2 font-semibold">{t("interviews.ackTitle")}</h3>
                        <CDFCommandForm
                          codeSections={INTERVIEW_CODES}
                          variant="secondary"
                          action={acknowledgeStatementAction.bind(null, c.id, i.id, current.id)}
                          locale={t.locale}
                          submitLabel={t("interviews.acknowledge")}
                          testId="ack-form"
                          fieldLabels={{
                            method: t("interviews.ackMethodLabel"),
                            attestedSha256: t("interviews.attestedLabel"),
                          }}
                        >
                          <CDFField id="ackMethod" label={t("interviews.ackMethodLabel")}>
                            <select id="ackMethod" name="method" className={inputClass}>
                              {STATEMENT_ACK_METHODS.map((m) => (
                                <option key={m} value={m}>
                                  {t(`interviews.ackMethod.${m}` as MessageKey)}
                                </option>
                              ))}
                            </select>
                          </CDFField>
                          <CDFField
                            id="attestedSha256"
                            label={t("interviews.attestedLabel")}
                            hint={t("interviews.attestedHint")}
                          >
                            <input
                              id="attestedSha256"
                              name="attestedSha256"
                              dir="ltr"
                              className={inputClass}
                              defaultValue={current.contentSha256}
                              aria-describedby="attestedSha256-hint"
                              required
                            />
                          </CDFField>
                        </CDFCommandForm>
                      </div>
                    ) : null}
                  </>
                ) : null}
                {now === "PREPARE" || now === "REVIEW" || now === "APPROVE" ? (
                  canTake[now] ? (
                    <ul>{actionItem(now)}</ul>
                  ) : (
                    who(now)
                  )
                ) : null}
              </div>
            </CDFCard>
          ) : null}

          <CDFCard title={t("interviews.overview")} testId="interview-overview">
            <CDFDescriptionList
              items={[
                {
                  term: t("interviews.interviewee"),
                  value: (
                    <span data-testid="interviewee">
                      {reporter ? t("interviews.reporterProtected") : (i.intervieweeLabel ?? "—")} ·{" "}
                      {t(`interviews.kind.${i.intervieweeKind}` as MessageKey)}
                    </span>
                  ),
                },
                { term: t("interviews.purpose"), value: i.purpose ?? "—" },
                {
                  term: t("interviews.scheduled"),
                  value: i.scheduledStart ? when(i.scheduledStart) : t("interviews.notScheduled"),
                },
                {
                  term: t("interviews.mode"),
                  value: i.mode ? t(`interviews.modeName.${i.mode}` as MessageKey) : "—",
                },
                { term: t("interviews.location"), value: i.location ?? "—" },
                {
                  term: t("interviews.duration"),
                  value: i.durationMinutes
                    ? t("interviews.durationValue", { minutes: i.durationMinutes })
                    : "—",
                },
              ]}
            />
            {reporter ? (
              <p className="mt-3 text-sm text-cdf-text-secondary">{t("interviews.reporterHint")}</p>
            ) : null}
            {/* A scheduled interview can still move: a new date, then a rescheduling notice. */}
            {canTake.SCHEDULE && now !== "SCHEDULE" ? (
              <details className="mt-3 border-t border-cdf-border pt-3" data-testid="reschedule">
                <summary className="cursor-pointer font-semibold">
                  {now === "INVITE" ? t("interviews.steps.changeDate") : t("interviews.steps.changeSchedule")}
                </summary>
                <div className="mt-3">{scheduleForm}</div>
                {canTake.INVITE && now !== "INVITE" ? (
                  <div className="mt-3 border-t border-cdf-border pt-3">{noticeForm}</div>
                ) : null}
              </details>
            ) : null}
          </CDFCard>

          {/* What is on record, read-only, in the order it happened. */}
          {now !== "INVITE" && i.notices.length > 0 ? (
            <CDFCard title={t("interviews.noticesTitle")} testId="notices-card">
              {noticeList}
            </CDFCard>
          ) : null}
          {now !== "RIGHTS" && i.rightsAckMethod ? (
            <CDFCard title={t("interviews.rightsTitle")} testId="rights-card">
              {rightsStatus}
            </CDFCard>
          ) : null}
          {now !== "CONDUCT" && i.conductedStartedAt ? (
            <CDFCard title={t("interviews.conductTitle")} testId="conduct-card">
              {conductStatus}
            </CDFCard>
          ) : null}
          {now !== "STATEMENT" && i.statements.length > 0 ? (
            <CDFCard title={t("interviews.statementTitle")} testId="statement-card">
              {statementVersions}
              {canTake.STATEMENT ? (
                <details className="border-t border-cdf-border pt-3">
                  <summary className="cursor-pointer font-semibold">
                    {t("interviews.steps.newStatementVersion")}
                  </summary>
                  <div className="mt-3">{statementForm}</div>
                </details>
              ) : null}
            </CDFCard>
          ) : null}
          {i.recordings.length > 0 || i.conductedStartedAt ? (
            <CDFCard title={t("interviews.recordingsTitle")} testId="recordings-card">
              <p className="mb-3 text-sm text-cdf-text-secondary">{t("interviews.recordingsIntro")}</p>
              {i.recordings.length === 0 ? (
                <p className="text-cdf-text-secondary">{t("interviews.noRecordings")}</p>
              ) : (
                <ul className="mb-3 list-disc ps-5 text-sm" data-testid="recording-list">
                  {i.recordings.map((r) => (
                    <li key={r.id}>
                      {register ? (
                        <a
                          href={evidenceItemHref(c.id, r.evidenceId)}
                          dir="ltr"
                          className="underline underline-offset-4"
                          data-testid={`recording-evidence-${r.evidenceSequenceNo}`}
                        >
                          {evidenceDisplayNumber(r.evidenceSequenceNo)}
                        </a>
                      ) : (
                        <span dir="ltr">{evidenceDisplayNumber(r.evidenceSequenceNo)}</span>
                      )}{" "}
                      · {r.evidenceTitle} · {t.code("evidenceType", r.evidenceType, "common.none")} ·{" "}
                      {isolate(r.linkedByName ?? "—")} · {when(r.linkedAt)}
                    </li>
                  ))}
                </ul>
              )}
              {canConduct && open.linkRecording ? (
                linkable.length === 0 ? (
                  <p className="text-sm text-cdf-text-secondary">{t("interviews.noLinkable")}</p>
                ) : (
                  <CDFCommandForm
                    codeSections={INTERVIEW_CODES}
                    variant="secondary"
                    action={linkRecordingAction.bind(null, c.id, i.id)}
                    locale={t.locale}
                    submitLabel={t("interviews.link")}
                    testId="recording-form"
                    successMessage={t("interviews.saved")}
                    fieldLabels={{ evidenceId: t("interviews.evidenceLabel") }}
                  >
                    <CDFField id="evidenceId" label={t("interviews.evidenceLabel")}>
                      <select
                        id="evidenceId"
                        name="evidenceId"
                        className={inputClass}
                        defaultValue=""
                        required
                      >
                        <option value="" disabled>
                          {t("interviews.chooseEvidence")}
                        </option>
                        {linkable.map((e) => (
                          <option key={e.id} value={e.id}>
                            {evidenceDisplayNumber(e.sequenceNo)} · {e.title}
                          </option>
                        ))}
                      </select>
                    </CDFField>
                  </CDFCommandForm>
                )
              ) : null}
            </CDFCard>
          ) : null}
        </div>

        <div className="min-w-0">
          <CDFCard title={t("interviews.participantsTitle")} testId="panel-card">
            <ul className="mb-3" data-testid="panel-list">
              {i.participants.map((p) => (
                <li key={p.id} className="mb-1">
                  <span className="font-semibold">{name(p)}</span> ·{" "}
                  {t(`interviews.role.${p.participantRole}` as MessageKey)}
                </li>
              ))}
            </ul>
            {canConduct && open.addParticipant ? (
              <details className="border-t border-cdf-border pt-3">
                <summary className="cursor-pointer font-semibold">
                  {t("interviews.addParticipantTitle")}
                </summary>
                <div className="mt-3">
                  <CDFCommandForm
                    codeSections={INTERVIEW_CODES}
                    variant="secondary"
                    action={addParticipantAction.bind(null, c.id, i.id)}
                    locale={t.locale}
                    submitLabel={t("interviews.add")}
                    testId="participant-form"
                    successMessage={t("interviews.saved")}
                    fieldLabels={{
                      userId: t("interviews.person"),
                      participantRole: t("interviews.roleLabel"),
                    }}
                  >
                    <CDFField id="participantUser" label={t("interviews.person")}>
                      <select
                        id="participantUser"
                        name="userId"
                        className={inputClass}
                        defaultValue=""
                        required
                      >
                        <option value="" disabled>
                          {t("interviews.choosePerson")}
                        </option>
                        {directory
                          .filter((u) => !i.participants.some((p) => p.userId === u.id))
                          .map((u) => (
                            <option key={u.id} value={u.id}>
                              {name(u)}
                            </option>
                          ))}
                      </select>
                    </CDFField>
                    <CDFField id="participantRole" label={t("interviews.roleLabel")}>
                      <select
                        id="participantRole"
                        name="participantRole"
                        className={inputClass}
                        defaultValue="INTERVIEWER"
                      >
                        {(["INTERVIEWER", "NOTE_TAKER"] as const).map((r) => (
                          <option key={r} value={r}>
                            {t(`interviews.role.${r}` as MessageKey)}
                          </option>
                        ))}
                      </select>
                    </CDFField>
                  </CDFCommandForm>
                </div>
              </details>
            ) : null}
          </CDFCard>

          <CDFCard title={t("interviews.lifecycleTitle")} testId="lifecycle-card">
            <CDFDescriptionList
              items={[
                {
                  term: t("interviews.preparedBy"),
                  value: i.preparedBy
                    ? `${byName(i.preparedBy, i.preparedByName)} · ${when(i.preparedAt)}`
                    : "—",
                },
                {
                  term: t("interviews.reviewedBy"),
                  value: i.reviewedBy
                    ? `${byName(i.reviewedBy, i.reviewedByName)} · ${when(i.reviewedAt)}`
                    : "—",
                },
                {
                  term: t("interviews.approvedBy"),
                  value: i.approvedBy
                    ? `${byName(i.approvedBy, i.approvedByName)} · ${when(i.approvedAt)}`
                    : "—",
                },
              ]}
            />
            {actions.length === 0 ? (
              <p className="mt-3 text-sm text-cdf-text-secondary">{t("interviews.noActions")}</p>
            ) : sideActions.length > 0 ? (
              <ul className="mt-3">
                {sideActions.includes("RETURN") ? actionItem("RETURN") : null}
                {/* Cancelling is rare and final: one step away, then confirmed (UX-031). */}
                {sideActions.includes("CANCEL") ? (
                  <li className="border-t border-cdf-border pt-3">
                    <details data-testid="cancel-interview">
                      <summary className="cursor-pointer font-semibold">
                        {t("interviews.action.CANCEL")}
                      </summary>
                      <ul className="mt-3">{actionItem("CANCEL")}</ul>
                    </details>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </CDFCard>
        </div>
      </div>
    </CaseWorkspace>
  );
}
