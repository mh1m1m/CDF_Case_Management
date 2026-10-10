// Interview detail (CDF-60). Opening it records INTERVIEW_VIEWED (or a SECURITY denial); missing and
// invisible interviews are both 404. Forms appear only where the lifecycle and the viewer's case relationship
// allow them; every command is re-checked by the database.
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@cdf/authorization";
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
  interviewStepsOpen,
  transitionBlockers,
} from "@cdf/domain";
import { formatDateTime, type MessageKey } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFDescriptionList,
  CDFField,
  CDFPageHeader,
  classificationTone,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { evidenceService, interviewService, investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { AppNav } from "../../../../app-nav";
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
import { InterviewForm } from "../interview-form";
import { interviewStatusTone } from "../status-tone";

const UUID = /^[0-9a-f-]{36}$/i;

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
  if (!UUID.test(id) || !UUID.test(interviewId)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const c = await investigationService().getCase(ctx, id);
  if (!c) notFound();
  const i = await interviewService().getInterview(ctx, interviewId);
  if (!i || i.caseId !== c.id) notFound();

  // UI mirrors of authz.can_conduct/review/approve_interviews; the database decides (§19).
  const mine = (roles: string[]) =>
    c.assignments.some((a) => a.userId === actor.userId && roles.includes(a.assignmentRole));
  const active = c.recordsState === "ACTIVE";
  const canConduct =
    active && (can(actor, "CASE_EDIT_ALL") || mine(["CASE_OWNER", "LEAD_INVESTIGATOR", "INVESTIGATOR"]));
  const canReview =
    active && (can(actor, "CASE_EDIT_ALL") || mine(["CASE_OWNER", "LEAD_INVESTIGATOR", "REVIEWER"]));
  const canApprove = active && (can(actor, "CASE_EDIT_ALL") || mine(["CASE_OWNER", "LEAD_INVESTIGATOR"]));
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
  const current = i.statements.find((s) => s.id === i.currentStatementVersionId) ?? null;
  const name = (n: { displayName: string; displayNameAr?: string }) =>
    t.locale === "ar" && n.displayNameAr ? n.displayNameAr : n.displayName;
  const nameOf = (userId: string | null) => {
    if (!userId) return "—";
    const p = i.participants.find((x) => x.userId === userId);
    return p ? name(p) : (c.assignments.find((a) => a.userId === userId)?.displayName ?? "—");
  };
  const when = (iso: string | null) => (iso ? formatDateTime(t.locale, iso) : "—");
  const number = interviewDisplayNumber(i.sequenceNo);
  const reporter = i.intervieweeKind === "REPORTER";

  return (
    <>
      <AppNav actor={actor} t={t} current="cases" />
      <CDFPageHeader
        title={`${c.caseNumber} · ${number} · ${i.title}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CDFBadge tone={classificationTone(i.classification)}>
              {t(`classification.${i.classification}` as MessageKey)}
            </CDFBadge>
            <CDFBadge tone={interviewStatusTone(i.status)} testId="interview-status">
              {t(`interviews.statusName.${i.status}` as MessageKey)}
            </CDFBadge>
            <Link
              href={`/cases/${c.id}/interviews`}
              className="font-semibold underline underline-offset-4"
              data-testid="back-to-interviews"
            >
              {t("interviews.title")}
            </Link>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
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
          </CDFCard>

          {canConduct && open.schedule ? (
            <CDFCard title={t("interviews.scheduleTitle")} testId="schedule-card">
              <InterviewForm
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
              </InterviewForm>
            </CDFCard>
          ) : null}

          <CDFCard title={t("interviews.noticesTitle")} testId="notices-card">
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
                      name: n.issuedByName ?? "—",
                    })}
                  </li>
                ))}
              </ul>
            )}
            {canConduct && open.notice ? (
              <div className="mt-3 border-t border-cdf-border pt-3">
                <InterviewForm
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
                      {INTERVIEW_NOTICE_CHANNELS.filter((ch) => (ch === "PORTAL_MESSAGE") === reporter).map(
                        (ch) => (
                          <option key={ch} value={ch}>
                            {t(`interviews.channel.${ch}` as MessageKey)}
                          </option>
                        ),
                      )}
                    </select>
                  </CDFField>
                </InterviewForm>
              </div>
            ) : null}
          </CDFCard>

          <CDFCard title={t("interviews.rightsTitle")} testId="rights-card">
            <p className="mb-2 text-sm text-cdf-text-secondary">{t("interviews.rightsIntro")}</p>
            <p className="mb-3 font-semibold" data-testid="rights-status">
              {i.rightsAckMethod
                ? t("interviews.rightsRecorded", {
                    method: t(`interviews.rightsMethod.${i.rightsAckMethod}` as MessageKey),
                    version: i.rightsNoticeVersion ?? "—",
                    when: when(i.rightsAcknowledgedAt),
                  })
                : t("interviews.rightsNotRecorded")}
            </p>
            {canConduct && interviewer && open.rights && !i.rightsAckMethod ? (
              <InterviewForm
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
              </InterviewForm>
            ) : null}
          </CDFCard>

          <CDFCard title={t("interviews.conductTitle")} testId="conduct-card">
            <p className="mb-3 font-semibold" data-testid="conduct-status">
              {i.conductedStartedAt
                ? t("interviews.conducted", {
                    from: when(i.conductedStartedAt),
                    to: when(i.conductedEndedAt),
                  })
                : t("interviews.conductNotRecorded")}
            </p>
            {canConduct && interviewer && open.conduct ? (
              <InterviewForm
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
              </InterviewForm>
            ) : null}
          </CDFCard>

          <CDFCard title={t("interviews.statementTitle")} testId="statement-card">
            <p className="mb-3 text-sm text-cdf-text-secondary">{t("interviews.statementIntro")}</p>
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
                        name: s.recordedByName ?? "—",
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
                            name: s.acknowledgement.recordedByName ?? "—",
                            when: when(s.acknowledgement.recordedAt),
                          })
                        : t("interviews.ackNone")}
                    </p>
                  </li>
                ))}
              </ol>
            )}
            {canConduct && onPanel && open.statement ? (
              <div className="border-t border-cdf-border pt-3">
                <InterviewForm
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
                </InterviewForm>
              </div>
            ) : null}
            {canConduct && onPanel && open.acknowledge && current && !current.acknowledgement ? (
              <div className="mt-3 border-t border-cdf-border pt-3">
                <h3 className="mb-2 font-semibold">{t("interviews.ackTitle")}</h3>
                <InterviewForm
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
                </InterviewForm>
              </div>
            ) : null}
          </CDFCard>

          <CDFCard title={t("interviews.recordingsTitle")} testId="recordings-card">
            <p className="mb-3 text-sm text-cdf-text-secondary">{t("interviews.recordingsIntro")}</p>
            {i.recordings.length === 0 ? (
              <p className="text-cdf-text-secondary">{t("interviews.noRecordings")}</p>
            ) : (
              <ul className="mb-3 list-disc ps-5 text-sm" data-testid="recording-list">
                {i.recordings.map((r) => (
                  <li key={r.id}>
                    <span dir="ltr">{evidenceDisplayNumber(r.evidenceSequenceNo)}</span> · {r.evidenceTitle} ·{" "}
                    {t.code("evidenceType", r.evidenceType, "common.none")} · {r.linkedByName ?? "—"} ·{" "}
                    {when(r.linkedAt)}
                  </li>
                ))}
              </ul>
            )}
            {canConduct && open.linkRecording ? (
              linkable.length === 0 ? (
                <p className="text-sm text-cdf-text-secondary">{t("interviews.noLinkable")}</p>
              ) : (
                <InterviewForm
                  action={linkRecordingAction.bind(null, c.id, i.id)}
                  locale={t.locale}
                  submitLabel={t("interviews.link")}
                  testId="recording-form"
                  successMessage={t("interviews.saved")}
                  fieldLabels={{ evidenceId: t("interviews.evidenceLabel") }}
                >
                  <CDFField id="evidenceId" label={t("interviews.evidenceLabel")}>
                    <select id="evidenceId" name="evidenceId" className={inputClass} defaultValue="" required>
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
                </InterviewForm>
              )
            ) : null}
          </CDFCard>
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
              <div className="border-t border-cdf-border pt-3">
                <h3 className="mb-2 font-semibold">{t("interviews.addParticipantTitle")}</h3>
                <InterviewForm
                  action={addParticipantAction.bind(null, c.id, i.id)}
                  locale={t.locale}
                  submitLabel={t("interviews.add")}
                  testId="participant-form"
                  successMessage={t("interviews.saved")}
                  fieldLabels={{ userId: t("interviews.person"), participantRole: t("interviews.roleLabel") }}
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
                </InterviewForm>
              </div>
            ) : null}
          </CDFCard>

          <CDFCard title={t("interviews.lifecycleTitle")} testId="lifecycle-card">
            <CDFDescriptionList
              items={[
                {
                  term: t("interviews.preparedBy"),
                  value: i.preparedBy ? `${nameOf(i.preparedBy)} · ${when(i.preparedAt)}` : "—",
                },
                {
                  term: t("interviews.reviewedBy"),
                  value: i.reviewedBy ? `${nameOf(i.reviewedBy)} · ${when(i.reviewedAt)}` : "—",
                },
                {
                  term: t("interviews.approvedBy"),
                  value: i.approvedBy ? `${nameOf(i.approvedBy)} · ${when(i.approvedAt)}` : "—",
                },
              ]}
            />
            {actions.length === 0 ? (
              <p className="mt-3 text-sm text-cdf-text-secondary">{t("interviews.noActions")}</p>
            ) : (
              <ul className="mt-3">
                {actions.map((a) => {
                  const blockers = transitionBlockers(i, a, actor.userId);
                  return (
                    <li
                      key={a}
                      className="mb-4 border-t border-cdf-border pt-3"
                      data-testid={`interview-action-${a}`}
                    >
                      <p className="mb-2 font-semibold">{t(`interviews.action.${a}` as MessageKey)}</p>
                      {blockers.length ? (
                        <ul
                          className="list-disc ps-5 text-sm text-cdf-text-secondary"
                          data-testid={`blocked-${a}`}
                        >
                          {blockers.map((b) => (
                            <li key={b}>{t.code("interviews.codes", b, "errors.CONFLICT")}</li>
                          ))}
                        </ul>
                      ) : (
                        <InterviewForm
                          action={transitionInterviewAction.bind(null, c.id, i.id, a)}
                          locale={t.locale}
                          submitLabel={t(`interviews.action.${a}` as MessageKey)}
                          variant={a === "CANCEL" ? "danger" : a === "APPROVE" ? "primary" : "secondary"}
                          fieldLabels={{ reason: t("interviews.reasonLabel") }}
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
                        </InterviewForm>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CDFCard>
        </div>
      </div>
    </>
  );
}
