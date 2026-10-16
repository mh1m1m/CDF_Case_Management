// One committee meeting (UX redesign Phase 12 P12-2a to P12-2c; ADR-054 to ADR-056; DEC-02, ADR-016 D2): a purpose
// route that reads api.meeting_view and nothing of the case. A missing meeting and one the caller may not see are the
// same 404, and the refusal is recorded (ACCESS_DENIED). Each part shows only under its own read rule, and each action
// only where its command's own answer says the caller may take it (UX-116); every command checks again in the
// database. A caller with a current seat on the committee reaches the meeting from My Committees, and the breadcrumb
// says so; anyone else from My Work. P12-2c links the proceeding's page for a seat that gives the proceeding (the
// committee page lists it), and, for the runner, the invite and finding-vote pages: those read their choices only
// when opened, so this page, which re-renders while the meeting runs, records no read of them.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type {
  MeetingConcernsOnlyView,
  MeetingFullView,
  MeetingMinutesRef,
  VoteItemProgress,
} from "@cdf/contracts";
import { formatDateTime, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFAlert,
  CDFBadge,
  CDFBreadcrumbs,
  CDFCard,
  CDFCommandForm,
  CDFDescriptionList,
  CDFField,
  CDFIdentifier,
  CDFPageHeader,
  CDFPurposeBanner,
  CDFStatusBadge,
  CDFWorkflowGuide,
  textareaClass,
  type CDFProgressState,
} from "@cdf/ui";
import { committeesService, meetingsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { confirmation, type ConfirmAct } from "../../confirmations";
import { participantName } from "../meeting-labels";
import {
  activateActingChairAction,
  activateActingSecretaryAction,
  cancelMeetingAction,
  closeMeetingAction,
  generateMinutesAction,
  openMeetingAction,
} from "./actions";
import { MeetingConcerns, type MeetingNames } from "./concerns";
import { MeetingMyPart } from "./my-part";
import { MeetingParticipants } from "./participants";
import { MeetingVotes } from "./votes";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or meeting content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.meeting") };
}

const UUID = /^[0-9a-f-]{36}$/i;
const FINAL_MINUTES: readonly string[] = ["APPROVED", "DEEMED_APPROVED"];

export default async function MeetingPage({ params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await params;
  if (!UUID.test(meetingId)) notFound();
  const { ctx } = await requireActor();
  const t = await getTranslator();
  const m = await meetingsService().meeting(ctx, meetingId);
  if (!m) notFound();
  if (m.view === "CONCERNS_ONLY") return <ConcernsOnly t={t} m={m} />;

  // Who has voted so far, on the votes still open; a refused read leaves the count out. Whether the caller holds a
  // seat on the committee now decides only where the breadcrumb leads (P12-2b).
  const open = m.deliberation?.voteItems.filter((v) => v.status === "OPEN") ?? [];
  const [reads, seats] = await Promise.all([
    Promise.all(open.map((v) => meetingsService().voteItemProgress(ctx, v.voteItemId))),
    committeesService().myCommittees(ctx),
  ]);
  const progress = new Map(
    reads.filter((p): p is VoteItemProgress => p !== null).map((p) => [p.voteItemId, p] as const),
  );
  const seated = seats.some((c) => c.committeeId === m.committee.committeeId);
  // The committee page's own read (unaudited, the seat basis): the proceeding's page opens only where it lists it.
  const committee = seated ? await committeesService().committee(ctx, m.committee.committeeId) : null;
  const proceedingHref = committee?.proceedings.some(
    (p) => p.committeeProceedingId === m.committeeProceedingId,
  )
    ? `/committee-proceedings/${m.committeeProceedingId}`
    : null;
  return <FullMeeting t={t} m={m} progress={progress} seated={seated} proceedingHref={proceedingHref} />;
}

function FullMeeting({
  t,
  m,
  progress,
  seated,
  proceedingHref,
}: {
  t: Translator;
  m: MeetingFullView;
  progress: ReadonlyMap<string, VoteItemProgress>;
  seated: boolean;
  /** The proceeding's page, where the caller's seat gives the proceeding (P12-2c). */
  proceedingHref: string | null;
}) {
  const L = m.logistics;
  const cap = m.capabilities;
  const n = L.sequenceNo;
  const committee = t.code("committeeName", m.committee.code, "common.none");
  const when = (iso: string) => isolate(formatDateTime(t.locale, iso));
  const roster = m.roster;
  const byParticipant = new Map(roster?.map((p) => [p.participantId, participantName(t, p)] as const) ?? []);
  const byUser = new Map(
    roster?.flatMap((p) => (p.userId ? [[p.userId, participantName(t, p)] as const] : [])) ?? [],
  );
  const names: MeetingNames = { participant: (id) => byParticipant.get(id), user: (id) => byUser.get(id) };
  const me = m.me;
  const conflicted = me?.coiStatus === "CONFLICT_DECLARED";
  const myActions = cap.mayDeclareConflict || cap.mayDeclareNoConflict || cap.mayAcknowledgeConfidentiality;
  const myPart = me ? <MeetingMyPart t={t} meetingId={m.meetingId} me={me} capabilities={cap} /> : null;

  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={
          seated
            ? [
                { label: t("shell.area.COMMITTEE"), href: "/committees" },
                { label: committee, href: `/committees/${m.committee.committeeId}` },
                { label: t("meetings.breadcrumb", { n }) },
              ]
            : [
                { label: t("shell.area.MY_WORK"), href: "/my-work" },
                { label: t("meetings.breadcrumb", { n }) },
              ]
        }
      />
      <CDFPageHeader
        title={t("meetings.title", { committee, n })}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {m.case.caseNumber ? (
              <span className="text-sm" data-testid="meeting-case">
                {t("meetings.caseLabel")} <CDFIdentifier>{m.case.caseNumber}</CDFIdentifier>
              </span>
            ) : null}
            <CDFStatusBadge domain="meeting" status={L.status} testId="meeting-status">
              {t(`meetings.status.${L.status}` as MessageKey)}
            </CDFStatusBadge>
            {L.isEmergency ? (
              <CDFBadge tone="warning" testId="meeting-emergency">
                {t("meetings.emergency")}
              </CDFBadge>
            ) : null}
          </div>
        }
      />
      <CDFPurposeBanner
        title={t("meetings.purposeTitle")}
        purpose={t("meetings.purposeBody")}
        {...(m.case.caseNumber ? {} : { notShown: t("meetings.purposeNoCase") })}
        testId="meeting-purpose-banner"
      />
      {proceedingHref ? (
        <p className="mb-4" data-testid="meeting-proceeding">
          <Link
            href={proceedingHref}
            className="font-semibold underline"
            data-testid="meeting-proceeding-link"
          >
            {t("committeeProceedings.proceedingLink")}
          </Link>
        </p>
      ) : null}
      {conflicted ? (
        // Rule 6: a declared conflict closes the deliberation and the votes to the caller, and the page says so.
        <CDFAlert tone="warning" title={t("meetings.conflictTitle")} testId="meeting-conflict-banner">
          <p>{t("meetings.conflictBody")}</p>
        </CDFAlert>
      ) : null}

      <MeetingGuide t={t} m={m} when={when} />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          {myActions ? myPart : null}
          {roster ? (
            <MeetingParticipants
              t={t}
              meetingId={m.meetingId}
              roster={roster}
              myParticipantId={me?.participantId ?? null}
              memberMayRaise={cap.mayRaiseConcern && !cap.canManage}
              inviteHref={cap.mayInvite ? `/meetings/${m.meetingId}/invite` : null}
            />
          ) : null}
          {m.deliberation ? (
            <MeetingVotes
              t={t}
              meetingId={m.meetingId}
              deliberation={m.deliberation}
              roster={roster}
              runner={cap.canManage}
              mayOpenVote={cap.mayOpenVote}
              progress={progress}
              findingVoteHref={
                cap.mayOpenVote && m.committee.kind === "INVESTIGATION"
                  ? `/meetings/${m.meetingId}/finding-vote`
                  : null
              }
              proceedingHref={proceedingHref}
            />
          ) : null}
          <MeetingConcerns t={t} meetingId={m.meetingId} concerns={m.concerns} names={names} />
          <MinutesCard t={t} m={m} when={when} />
        </div>
        <div className="min-w-0">
          {myActions ? null : myPart}
          <Arrangements t={t} m={m} when={when} />
          {m.actingRoles.length > 0 || cap.mayActivateActingChair || cap.mayActivateActingSecretary ? (
            <CDFCard title={t("meetings.actingTitle")} testId="meeting-acting">
              <ul className="grid gap-2 text-sm" data-testid="acting-roles">
                {m.actingRoles.map((a) => {
                  const basis = t(`meetings.actingBasis.${a.basis}` as MessageKey);
                  const replaced = a.replacesParticipantId
                    ? byParticipant.get(a.replacesParticipantId)
                    : undefined;
                  return (
                    <li key={a.actingRoleId}>
                      <p className="font-semibold">
                        {t(`meetings.actingRole.${a.actingRole}` as MessageKey)}
                        {byUser.get(a.userId) ? (
                          <>
                            : <bdi>{byUser.get(a.userId)}</bdi>
                          </>
                        ) : null}
                      </p>
                      <p>
                        {replaced
                          ? t("meetings.actingInPlaceOf", { name: isolate(replaced), basis })
                          : t("meetings.actingBecause", { basis })}
                      </p>
                    </li>
                  );
                })}
              </ul>
              {cap.mayActivateActingChair ? (
                <div className="mt-4 border-t border-cdf-border pt-3" data-testid="acting-chair">
                  <h3 className="mb-1 font-semibold">{t("meetings.actingChairTitle")}</h3>
                  <p className="mb-3 text-sm text-cdf-text-secondary">{t("meetings.actingChairIntro")}</p>
                  <ReasonForm
                    t={t}
                    id="acting-chair"
                    action={activateActingChairAction.bind(null, m.meetingId)}
                    submitLabel={t("meetings.activateActingChair")}
                    successMessage={t("meetings.actingChairActivated")}
                    variant="secondary"
                    confirmAct="activateActingChair"
                    long
                  />
                </div>
              ) : null}
              {cap.mayActivateActingSecretary ? (
                <div className="mt-4 border-t border-cdf-border pt-3" data-testid="acting-secretary">
                  <h3 className="mb-1 font-semibold">{t("meetings.actingSecretaryTitle")}</h3>
                  <p className="mb-3 text-sm text-cdf-text-secondary">{t("meetings.actingSecretaryIntro")}</p>
                  <ReasonForm
                    t={t}
                    id="acting-secretary"
                    action={activateActingSecretaryAction.bind(null, m.meetingId)}
                    submitLabel={t("meetings.activateActingSecretary")}
                    successMessage={t("meetings.actingSecretaryActivated")}
                    variant="secondary"
                    confirmAct="activateActingSecretary"
                    long
                  />
                </div>
              ) : null}
            </CDFCard>
          ) : null}
          {m.deliberation && m.deliberation.witnessExclusions.length > 0 ? (
            <CDFCard title={t("meetings.exclusionsTitle")} testId="meeting-exclusions">
              <ul className="grid gap-3 text-sm">
                {m.deliberation.witnessExclusions.map((x) => (
                  <li key={x.exclusionId}>
                    <p className="font-semibold">
                      <bdi>{byParticipant.get(x.participantId) ?? t("meetings.aParticipant")}</bdi>
                    </p>
                    <p className="text-cdf-text-secondary">
                      {t("meetings.excludedOn", { date: when(x.excludedAt) })}
                    </p>
                    <p className="whitespace-pre-wrap break-words">
                      <bdi dir="auto">{x.reason}</bdi>
                    </p>
                  </li>
                ))}
              </ul>
            </CDFCard>
          ) : null}
        </div>
      </div>
    </>
  );
}

type Step = "SCHEDULED" | "OPEN" | "CLOSED" | "MINUTES";
const STEPS: readonly Step[] = ["SCHEDULED", "OPEN", "CLOSED", "MINUTES"];

/** The latest version of the minutes the caller may see (they come in version order). */
const latestMinutes = (m: MeetingFullView): MeetingMinutesRef | null => m.minutes.at(-1) ?? null;

/**
 * Where the meeting stands (ADR-030 §2): scheduled, open, closed, then its minutes final. Who acts next is a seat,
 * never a name; the caller's own line comes from the capabilities and their place in the meeting.
 */
function MeetingGuide({ t, m, when }: { t: Translator; m: MeetingFullView; when: (iso: string) => string }) {
  const L = m.logistics;
  const cap = m.capabilities;
  const latest = latestMinutes(m);
  const final = latest !== null && FINAL_MINUTES.includes(latest.status);
  const items = m.deliberation?.voteItems ?? [];

  const done: Step[] =
    L.status === "SCHEDULED"
      ? []
      : L.status === "OPEN" || L.status === "CANCELLED"
        ? ["SCHEDULED"]
        : final
          ? [...STEPS]
          : ["SCHEDULED", "OPEN", "CLOSED"];
  const current: Step | null =
    L.status === "SCHEDULED"
      ? "SCHEDULED"
      : L.status === "OPEN"
        ? "OPEN"
        : L.status === "CLOSED" && !final
          ? "MINUTES"
          : null;
  const state = (s: Step): CDFProgressState =>
    done.includes(s) ? "done" : s === current ? "current" : L.status === "CANCELLED" ? "skipped" : "upcoming";

  const closedOn = when(L.closedAt ?? L.scheduledStart);
  const now =
    L.status === "SCHEDULED"
      ? t("meetings.now.SCHEDULED", { date: when(L.scheduledStart) })
      : L.status === "OPEN"
        ? t("meetings.now.OPEN", { date: when(L.openedAt ?? L.scheduledStart) })
        : L.status === "CANCELLED"
          ? t("meetings.now.CANCELLED", { date: closedOn })
          : latest?.status === "IN_REVIEW"
            ? t("meetings.now.minutesInReview", { date: closedOn })
            : latest?.status === "CHANGES_REQUESTED"
              ? t("meetings.now.minutesChanges", { date: closedOn })
              : final
                ? t("meetings.now.minutesFinal", { date: closedOn })
                : t("meetings.now.CLOSED", { date: closedOn });
  const next =
    L.status === "CANCELLED" || final
      ? "none"
      : L.status === "OPEN"
        ? items.some((v) => v.status === "AWAITING_CASTING_VOTE")
          ? "castingVoter"
          : items.some((v) => v.status === "OPEN")
            ? "voters"
            : "secretary"
        : L.status === "CLOSED" && latest?.status === "IN_REVIEW"
          ? "reviewers"
          : "secretary";
  const me = m.me;
  const you = cap.canManage
    ? t("meetings.you.manage")
    : me?.coiStatus === "CONFLICT_DECLARED"
      ? t("meetings.you.conflicted")
      : me?.participantKind === "MEMBER"
        ? me.isVoting
          ? t("meetings.you.voting")
          : t("meetings.you.nonVoting")
        : me?.inviteeRole
          ? t("meetings.you.invitee", { role: t(`meetings.inviteeRole.${me.inviteeRole}` as MessageKey) })
          : t("meetings.you.reader");

  return (
    <CDFWorkflowGuide
      id="meeting-guide"
      testId="meeting-guide"
      title={t("meetings.guide.title")}
      trackerLabel={t("meetings.guide.tracker")}
      steps={STEPS.map((s) => ({ code: s, label: t(`meetings.steps.${s}` as MessageKey), state: state(s) }))}
      current={current}
      stateLabels={{
        done: t("cases.stepDone"),
        current: t("cases.stepCurrent"),
        upcoming: t("cases.stepUpcoming"),
        skipped: t("caseWorkspace.stepSkipped"),
      }}
      now={<span data-testid="meeting-now">{now}</span>}
      nextActor={<span data-testid="meeting-next">{t(`meetings.next.${next}` as MessageKey)}</span>}
      you={you}
      canAct={cap.mayOpen || cap.mayClose || cap.mayCancel}
      labels={{
        now: t("meetings.guide.now"),
        nextActor: t("meetings.guide.next"),
        you: t("meetings.guide.you"),
      }}
    >
      {cap.mayOpen ? (
        <div className="w-full">
          <ReasonForm
            t={t}
            id="open-meeting"
            action={openMeetingAction.bind(null, m.meetingId)}
            submitLabel={t("meetings.open")}
            successMessage={t("meetings.opened")}
            variant="primary"
            confirmAct="openMeeting"
          />
        </div>
      ) : null}
      {cap.mayClose ? (
        <div className="w-full">
          <ReasonForm
            t={t}
            id="close-meeting"
            action={closeMeetingAction.bind(null, m.meetingId)}
            submitLabel={t("meetings.close")}
            successMessage={t("meetings.closed")}
            variant="danger"
            confirmAct="closeMeeting"
          />
        </div>
      ) : null}
      {cap.mayCancel ? (
        // Cancelling is rare and final: one step away, then confirmed (UX-031).
        <details className="w-full border-t border-cdf-border pt-3" data-testid="cancel-meeting">
          <summary className="cursor-pointer font-semibold">{t("meetings.cancel")}</summary>
          <div className="mt-3">
            <ReasonForm
              t={t}
              id="cancel-meeting"
              action={cancelMeetingAction.bind(null, m.meetingId)}
              submitLabel={t("meetings.cancel")}
              successMessage={t("meetings.cancelled")}
              variant="danger"
              confirmAct="cancelMeeting"
            />
          </div>
        </details>
      ) : null}
    </CDFWorkflowGuide>
  );
}

/**
 * A meeting command whose only field is its reason: 5 to 2,000 characters (open, close, cancel), or 10 to 2,000 for an
 * activation (`long`).
 */
function ReasonForm({
  t,
  id,
  action,
  submitLabel,
  successMessage,
  variant,
  confirmAct,
  long = false,
}: {
  t: Translator;
  id: string;
  action: Parameters<typeof CDFCommandForm>[0]["action"];
  submitLabel: string;
  successMessage: string;
  variant: "primary" | "secondary" | "danger";
  confirmAct: ConfirmAct;
  long?: boolean;
}) {
  return (
    <CDFCommandForm
      action={action}
      locale={t.locale}
      submitLabel={submitLabel}
      variant={variant}
      testId={`${id}-form`}
      successMessage={successMessage}
      fieldLabels={{ reason: t("meetings.reasonLabel") }}
      confirm={confirmation(t, confirmAct)}
    >
      <CDFField
        id={`${id}-reason`}
        label={t("meetings.reasonLabel")}
        hint={long ? t("meetings.longReasonHint") : t("meetings.reasonHint")}
      >
        <textarea
          id={`${id}-reason`}
          name="reason"
          className={textareaClass}
          aria-describedby={`${id}-reason-hint`}
          minLength={long ? 10 : 5}
          maxLength={2000}
          required
        />
      </CDFField>
    </CDFCommandForm>
  );
}

function Arrangements({ t, m, when }: { t: Translator; m: MeetingFullView; when: (iso: string) => string }) {
  const L = m.logistics;
  const link = L.onlineUrl;
  return (
    <CDFCard title={t("meetings.arrangementsTitle")} testId="meeting-arrangements">
      <CDFDescriptionList
        stacked
        items={[
          {
            term: t("meetings.when"),
            value: L.scheduledEnd
              ? t("meetings.timeRange", { start: when(L.scheduledStart), end: when(L.scheduledEnd) })
              : when(L.scheduledStart),
          },
          { term: t("meetings.how"), value: t(`meetings.mode.${L.mode}` as MessageKey) },
          ...(L.location ? [{ term: t("meetings.where"), value: <bdi dir="auto">{L.location}</bdi> }] : []),
          ...(link
            ? [
                {
                  term: t("meetings.onlineLink"),
                  // Only an https link is a link; anything else stays text (never a javascript: or data: URL).
                  value: link.startsWith("https://") ? (
                    <a
                      href={link}
                      rel="noopener noreferrer"
                      dir="ltr"
                      className="break-all underline underline-offset-4"
                      data-testid="meeting-link"
                    >
                      {link}
                    </a>
                  ) : (
                    <bdi dir="ltr" className="break-all">
                      {link}
                    </bdi>
                  ),
                },
              ]
            : []),
          { term: t("meetings.meetingKind"), value: t(`meetings.kind.${L.purpose}` as MessageKey) },
          ...(L.openedAt ? [{ term: t("meetings.openedAt"), value: when(L.openedAt) }] : []),
          ...(L.status === "CLOSED" && L.closedAt
            ? [{ term: t("meetings.closedAt"), value: when(L.closedAt) }]
            : []),
        ]}
      />
    </CDFCard>
  );
}

function MinutesCard({ t, m, when }: { t: Translator; m: MeetingFullView; when: (iso: string) => string }) {
  return (
    <CDFCard title={t("meetings.minutesTitle")} testId="meeting-minutes">
      {m.minutes.length === 0 ? (
        <p className="text-cdf-text-secondary" data-testid="no-minutes">
          {t("meetings.noMinutes")}
        </p>
      ) : (
        <ul className="grid gap-2" data-testid="minutes-list">
          {[...m.minutes].reverse().map((v) => (
            <li key={v.minutesId} className="flex flex-wrap items-center gap-2">
              <Link
                href={`/minutes/${v.minutesId}`}
                className="font-semibold underline underline-offset-4"
                data-testid={`minutes-v${v.versionNo}`}
              >
                {t("meetings.minutesVersion", { n: v.versionNo })}
              </Link>
              <CDFStatusBadge domain="minutes" status={v.status} testId={`minutes-v${v.versionNo}-status`}>
                {t(`minutes.status.${v.status}` as MessageKey)}
              </CDFStatusBadge>
              <span className="text-sm text-cdf-text-secondary">{when(v.generatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {m.capabilities.mayGenerateMinutes ? (
        <div className="mt-4 border-t border-cdf-border pt-3" data-testid="generate-minutes">
          <h3 className="mb-1 font-semibold">{t("meetings.generateTitle")}</h3>
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("meetings.generateIntro")}</p>
          <CDFCommandForm
            action={generateMinutesAction.bind(null, m.meetingId)}
            locale={t.locale}
            submitLabel={t("meetings.generate")}
            variant="primary"
            testId="generate-minutes-form"
            successMessage={t("meetings.generated")}
            leaveWarning={t("common.leaveWarning")}
            fieldLabels={{ narrative: t("meetings.narrativeLabel") }}
            confirm={confirmation(t, "generateMinutes")}
          >
            <CDFField
              id="minutes-narrative"
              label={t("meetings.narrativeLabel")}
              hint={t("meetings.narrativeHint")}
            >
              <textarea
                id="minutes-narrative"
                name="narrative"
                className={`${textareaClass} min-h-48`}
                aria-describedby="minutes-narrative-hint"
                minLength={10}
                maxLength={20000}
                required
              />
            </CDFField>
          </CDFCommandForm>
        </div>
      ) : null}
    </CDFCard>
  );
}

/**
 * The concern-only view: a caller who may not see the meeting but may see one of its concerns (the committee's
 * conflict authority, or a seated deputy who reverses one). Only those concerns; nothing else of the meeting.
 */
function ConcernsOnly({ t, m }: { t: Translator; m: MeetingConcernsOnlyView }) {
  const none = () => undefined;
  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={[
          { label: t("shell.area.MY_WORK"), href: "/my-work" },
          { label: t("meetings.concernsOnlyHeading") },
        ]}
      />
      <CDFPageHeader
        title={t("meetings.concernsOnlyHeading")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {m.case.caseNumber ? (
              <span className="text-sm" data-testid="meeting-case">
                {t("meetings.caseLabel")} <CDFIdentifier>{m.case.caseNumber}</CDFIdentifier>
              </span>
            ) : null}
            <CDFStatusBadge domain="meeting" status={m.status} testId="meeting-status">
              {t(`meetings.status.${m.status}` as MessageKey)}
            </CDFStatusBadge>
          </div>
        }
      />
      <CDFPurposeBanner
        title={t("meetings.purposeTitle")}
        purpose={t("meetings.concernsOnlyBody")}
        {...(m.case.caseNumber ? {} : { notShown: t("meetings.purposeNoCase") })}
        testId="meeting-purpose-banner"
      />
      <MeetingConcerns
        t={t}
        meetingId={m.meetingId}
        concerns={m.concerns}
        names={{ participant: none, user: none }}
      />
    </>
  );
}
