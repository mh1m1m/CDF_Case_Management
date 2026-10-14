// One version of a meeting's minutes (UX redesign Phase 12 P12-2a; ADR-054; DEC-02, ADR-016 D2): a purpose route that
// reads api.minutes_view, and api.meeting_view for names only when the caller may see the meeting. A missing version
// and one the caller may not see are the same 404, and the refusal is recorded (ACCESS_DENIED). Minutes are a formal
// record, so their dates show Gregorian and Hijri (DEC-51). Counts and results only, never how a member voted
// (AMB-083); every action comes from the version's own capabilities and is checked again by its command.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { MeetingParticipantView, MinutesView } from "@cdf/contracts";
import { formatRecordDate, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFBreadcrumbs,
  CDFCard,
  CDFCommandForm,
  CDFConfiguredValue,
  CDFDescriptionList,
  CDFField,
  CDFIdentifier,
  CDFPageHeader,
  CDFPurposeBanner,
  CDFRecordDate,
  CDFStatusBadge,
  CDFWorkflowGuide,
  textareaClass,
  type CDFProgressState,
} from "@cdf/ui";
import { meetingsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { confirmation } from "../../confirmations";
import { partLabel, participantName } from "../../meetings/meeting-labels";
import {
  applyDeemedApprovalAction,
  overruleObjectionAction,
  remindReviewersAction,
  reviewMinutesAction,
} from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.minutes") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function MinutesPage({ params }: { params: Promise<{ minutesId: string }> }) {
  const { minutesId } = await params;
  if (!UUID.test(minutesId)) notFound();
  const { ctx } = await requireActor();
  const t = await getTranslator();
  const mi = await meetingsService().minutes(ctx, minutesId);
  if (!mi) notFound();
  // Names come from the meeting's roster, read only when the caller may see the meeting (the same predicate).
  const meeting = mi.meeting ? await meetingsService().meeting(ctx, mi.meetingId) : null;
  const roster = meeting?.view === "FULL" ? meeting.roster : null;
  return <Minutes t={t} mi={mi} roster={roster} />;
}

function Minutes({
  t,
  mi,
  roster,
}: {
  t: Translator;
  mi: MinutesView;
  roster: MeetingParticipantView[] | null;
}) {
  const n = mi.snapshot.meeting.sequenceNo;
  const at = (iso: string, testId?: string) => (
    <CDFRecordDate value={iso} locale={t.locale} withTime {...(testId ? { testId } : {})} />
  );
  const byParticipant = new Map(roster?.map((p) => [p.participantId, participantName(t, p)] as const) ?? []);
  const byUser = new Map(
    roster?.flatMap((p) => (p.userId ? [[p.userId, participantName(t, p)] as const] : [])) ?? [],
  );
  const s = mi.snapshot;
  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={[
          { label: t("shell.area.MY_WORK"), href: "/my-work" },
          mi.meeting
            ? { label: t("meetings.breadcrumb", { n }), href: `/meetings/${mi.meeting.meetingId}` }
            : { label: t("meetings.breadcrumb", { n }) },
          { label: t("minutes.breadcrumb", { n: mi.versionNo }) },
        ]}
      />
      <CDFPageHeader
        title={t("minutes.title", { n })}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {mi.case.caseNumber ? (
              <span className="text-sm" data-testid="minutes-case">
                {t("meetings.caseLabel")} <CDFIdentifier>{mi.case.caseNumber}</CDFIdentifier>
              </span>
            ) : null}
            <span className="text-sm" data-testid="minutes-version">
              {t("minutes.version", { n: mi.versionNo })}
            </span>
            <CDFStatusBadge domain="minutes" status={mi.status} testId="minutes-status">
              {t(`minutes.status.${mi.status}` as MessageKey)}
            </CDFStatusBadge>
            {mi.meeting ? (
              <Link
                href={`/meetings/${mi.meeting.meetingId}`}
                className="font-semibold underline underline-offset-4"
                data-testid="to-meeting"
              >
                {t("minutes.toMeeting")}
              </Link>
            ) : null}
          </div>
        }
      />
      <CDFPurposeBanner
        title={t("minutes.purposeTitle")}
        purpose={t("minutes.purposeBody")}
        {...(mi.case.caseNumber ? {} : { notShown: t("meetings.purposeNoCase") })}
        testId="minutes-purpose-banner"
      />

      <MinutesGuide t={t} mi={mi} />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <CDFCard title={t("minutes.narrativeTitle")} testId="minutes-narrative">
            <p className="whitespace-pre-wrap break-words">
              <bdi dir="auto">{mi.narrative}</bdi>
            </p>
          </CDFCard>

          <CDFCard title={t("minutes.recordTitle")} testId="minutes-record">
            <p className="mb-3 text-sm text-cdf-text-secondary">{t("minutes.recordIntro")}</p>

            <h3 className="mb-2 font-semibold">{t("minutes.participantsTitle")}</h3>
            <ul className="mb-4 grid gap-2 text-sm" data-testid="minutes-participants">
              {s.participants.map((p) => (
                <li key={p.participantId}>
                  <span className="font-semibold">
                    <bdi>{byParticipant.get(p.participantId) ?? partLabel(t, p)}</bdi>
                  </span>
                  {byParticipant.has(p.participantId) ? ` · ${partLabel(t, p)}` : null} ·{" "}
                  {t("meetings.coiValue", { status: t(`meetings.coi.${p.coiStatus}` as MessageKey) })} ·{" "}
                  {t("meetings.attendanceValue", {
                    status: t(`meetings.attendance.${p.attendance}` as MessageKey),
                  })}
                </li>
              ))}
            </ul>

            {s.actingRoles.length > 0 ? (
              <>
                <h3 className="mb-2 font-semibold">{t("minutes.actingTitle")}</h3>
                <ul className="mb-4 grid gap-2 text-sm" data-testid="minutes-acting">
                  {s.actingRoles.map((a) => {
                    const basis = t(`meetings.actingBasis.${a.basis}` as MessageKey);
                    const who = byParticipant.get(a.participantId);
                    const replaced = a.replacesParticipantId
                      ? byParticipant.get(a.replacesParticipantId)
                      : undefined;
                    return (
                      <li key={`${a.actingRole}-${a.participantId}`}>
                        <span className="font-semibold">
                          {t(`meetings.actingRole.${a.actingRole}` as MessageKey)}
                          {who ? (
                            <>
                              : <bdi>{who}</bdi>
                            </>
                          ) : null}
                        </span>{" "}
                        ·{" "}
                        {replaced
                          ? t("meetings.actingInPlaceOf", { name: isolate(replaced), basis })
                          : t("meetings.actingBecause", { basis })}
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}

            <h3 className="mb-2 font-semibold">{t("minutes.votesTitle")}</h3>
            {s.voteItems.length === 0 ? (
              <p className="mb-4 text-sm text-cdf-text-secondary">{t("meetings.noVotes")}</p>
            ) : (
              <ol className="mb-4 grid gap-3" data-testid="minutes-votes">
                {s.voteItems.map((v) => (
                  <li key={v.voteItemId} data-testid={`minutes-vote-${v.sequenceNo}`}>
                    <p className="font-semibold">
                      {t("meetings.voteNumber", { n: v.sequenceNo })} · <bdi dir="auto">{v.title}</bdi>
                    </p>
                    <p className="text-sm text-cdf-text-secondary">
                      {t(`meetings.target.${v.targetType}` as MessageKey)}
                    </p>
                    {v.result ? (
                      <p className="text-sm font-semibold">
                        {t("meetings.resultLine", { result: t(`meetings.result.${v.result}` as MessageKey) })}
                      </p>
                    ) : null}
                    {v.decidedByCastingVote ? <p className="text-sm">{t("meetings.byCastingVote")}</p> : null}
                    <div className="mt-1 text-sm">
                      <CDFDescriptionList
                        items={[
                          { term: t("meetings.count.eligible"), value: String(v.tally.eligible) },
                          { term: t("meetings.count.present"), value: String(v.tally.present) },
                          ...(v.tally.quorumRequired !== null
                            ? [{ term: t("meetings.count.required"), value: String(v.tally.quorumRequired) }]
                            : []),
                          { term: t("meetings.count.approve"), value: String(v.tally.approve) },
                          { term: t("meetings.count.reject"), value: String(v.tally.reject) },
                          { term: t("meetings.count.abstain"), value: String(v.tally.abstain) },
                          { term: t("meetings.count.recused"), value: String(v.tally.recused) },
                          { term: t("meetings.count.absent"), value: String(v.tally.absent) },
                          { term: t("meetings.count.unable"), value: String(v.tally.unable) },
                          { term: t("meetings.count.excluded"), value: String(v.tally.excluded) },
                        ]}
                      />
                    </div>
                  </li>
                ))}
              </ol>
            )}

            {s.annexedNotes.length > 0 ? (
              <>
                <h3 className="mb-2 font-semibold">{t("minutes.notesTitle")}</h3>
                <ul className="grid gap-3 text-sm" data-testid="minutes-notes">
                  {s.annexedNotes.map((x, i) => {
                    const item = s.voteItems.find((v) => v.voteItemId === x.voteItemId);
                    const by = x.participantId ? byParticipant.get(x.participantId) : undefined;
                    return (
                      <li key={i}>
                        <p className="font-semibold">
                          {item ? `${t("meetings.voteNumber", { n: item.sequenceNo })} · ` : null}
                          {x.participantId === null
                            ? t("minutes.noteAnonymous")
                            : t("minutes.noteBy", { name: isolate(by ?? t("meetings.aParticipant")) })}
                        </p>
                        <p className="whitespace-pre-wrap break-words">
                          <bdi dir="auto">{x.note}</bdi>
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
          </CDFCard>
        </div>

        <div className="min-w-0">
          <CDFCard title={t("minutes.factsTitle")} testId="minutes-facts">
            <CDFDescriptionList
              stacked
              items={[
                { term: t("minutes.generatedAt"), value: at(mi.generatedAt, "minutes-generated-at") },
                { term: t("minutes.reviewers"), value: String(mi.reviewerCount) },
                { term: t("minutes.reviewDue"), value: at(mi.reviewDueAt, "minutes-review-due") },
                {
                  term: t("minutes.reviewPeriod"),
                  // Rule 7: the committee's configured rule, never presented as CDF policy.
                  value: (
                    <CDFConfiguredValue
                      value={t("minutes.reviewPeriodValue", { days: mi.reviewBusinessDays })}
                      source="CONFIGURED"
                      sourceLabel={t("minutes.reviewPeriodSource")}
                      testId="minutes-review-period"
                    />
                  ),
                },
                {
                  term: t("minutes.ifNotReviewed"),
                  value: mi.deemedApprovalEnabled ? t("minutes.deemedOn") : t("minutes.deemedOff"),
                },
                ...(mi.reminderSentAt
                  ? [
                      {
                        term: t("minutes.reminderSent"),
                        value: at(mi.reminderSentAt, "minutes-reminder-sent"),
                      },
                    ]
                  : []),
                ...(mi.finalisedAt
                  ? [{ term: t("minutes.finalisedAt"), value: at(mi.finalisedAt, "minutes-finalised-at") }]
                  : []),
              ]}
            />
          </CDFCard>

          {mi.reviews ? (
            <CDFCard title={t("minutes.reviewsTitle")} testId="minutes-reviews">
              {mi.reviews.length === 0 ? (
                <p className="text-cdf-text-secondary">{t("minutes.noReviews")}</p>
              ) : (
                <ul className="grid gap-3 text-sm">
                  {mi.reviews.map((r) => (
                    <li key={`${r.reviewerId}-${r.reviewedAt}`}>
                      <p className="font-semibold">
                        <bdi>{byUser.get(r.reviewerId) ?? t("meetings.aParticipant")}</bdi> ·{" "}
                        {t(`minutes.decision.${r.decision}` as MessageKey)}
                      </p>
                      <p className="text-cdf-text-secondary">{at(r.reviewedAt)}</p>
                      {r.comment ? (
                        <p className="whitespace-pre-wrap break-words">
                          <bdi dir="auto">{r.comment}</bdi>
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CDFCard>
          ) : null}

          {mi.objectionRulings && mi.objectionRulings.length > 0 ? (
            <CDFCard title={t("minutes.rulingsTitle")} testId="minutes-rulings">
              <ul className="grid gap-3 text-sm">
                {mi.objectionRulings.map((o) => (
                  <li key={o.rulingId}>
                    <p className="font-semibold">
                      {t(`minutes.ruledAs.${o.ruledAs}` as MessageKey)}
                      {byUser.get(o.ruledBy) ? (
                        <>
                          : <bdi>{byUser.get(o.ruledBy)}</bdi>
                        </>
                      ) : null}
                    </p>
                    <p className="text-cdf-text-secondary">{at(o.ruledAt)}</p>
                    <p className="whitespace-pre-wrap break-words">
                      <bdi dir="auto">{o.reason}</bdi>
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

type Step = "GENERATED" | "REVIEW" | "FINAL";
const STEPS: readonly Step[] = ["GENERATED", "REVIEW", "FINAL"];

/** Where this version stands: generated, in review, final (or replaced by a later version). */
function MinutesGuide({ t, mi }: { t: Translator; mi: MinutesView }) {
  const cap = mi.capabilities;
  const final = mi.status === "APPROVED" || mi.status === "DEEMED_APPROVED";
  const current: Step | null =
    mi.status === "IN_REVIEW" || mi.status === "CHANGES_REQUESTED" ? "REVIEW" : null;
  const state = (s: Step): CDFProgressState =>
    s === "GENERATED" || final
      ? "done"
      : s === current
        ? "current"
        : mi.status === "SUPERSEDED"
          ? "skipped"
          : "upcoming";
  const date = (iso: string | null) => isolate(formatRecordDate(t.locale, iso ?? mi.generatedAt));
  const now =
    mi.status === "IN_REVIEW"
      ? t("minutes.now.IN_REVIEW", { date: date(mi.reviewDueAt) })
      : mi.status === "APPROVED"
        ? t("minutes.now.APPROVED", { date: date(mi.finalisedAt) })
        : mi.status === "DEEMED_APPROVED"
          ? t("minutes.now.DEEMED_APPROVED", { date: date(mi.finalisedAt) })
          : t(`minutes.now.${mi.status}` as MessageKey);
  const next =
    mi.status === "IN_REVIEW" ? "reviewers" : mi.status === "CHANGES_REQUESTED" ? "chairOrSecretary" : "none";
  const you = cap.mayReview
    ? t("minutes.you.review")
    : mi.iHaveReviewed
      ? t("minutes.you.reviewed")
      : cap.mayOverruleObjection
        ? t("minutes.you.chair")
        : cap.mayRemind || cap.mayApplyDeemedApproval
          ? t("minutes.you.manage")
          : t("minutes.you.reader");
  const meetingId = mi.meetingId;

  return (
    <CDFWorkflowGuide
      id="minutes-guide"
      testId="minutes-guide"
      title={t("minutes.guide.title")}
      trackerLabel={t("minutes.guide.tracker")}
      steps={STEPS.map((s) => ({ code: s, label: t(`minutes.steps.${s}` as MessageKey), state: state(s) }))}
      current={current}
      stateLabels={{
        done: t("cases.stepDone"),
        current: t("cases.stepCurrent"),
        upcoming: t("cases.stepUpcoming"),
        skipped: t("caseWorkspace.stepSkipped"),
      }}
      now={<span data-testid="minutes-now">{now}</span>}
      nextActor={<span data-testid="minutes-next">{t(`minutes.next.${next}` as MessageKey)}</span>}
      you={you}
      canAct={cap.mayReview || cap.mayRemind || cap.mayApplyDeemedApproval || cap.mayOverruleObjection}
      labels={{
        now: t("minutes.guide.now"),
        nextActor: t("minutes.guide.next"),
        you: t("minutes.guide.you"),
      }}
    >
      {cap.mayReview ? (
        <div className="w-full" data-testid="minutes-review">
          <h3 className="mb-2 font-semibold">{t("minutes.reviewTitle")}</h3>
          <CDFCommandForm
            action={reviewMinutesAction.bind(null, mi.minutesId, meetingId)}
            locale={t.locale}
            submitLabel={t("minutes.submitReview")}
            variant="primary"
            testId="minutes-review-form"
            successMessage={t("minutes.reviewed")}
            fieldLabels={{ decision: t("minutes.decisionLabel"), comment: t("minutes.commentLabel") }}
            confirm={confirmation(t, "reviewMinutes")}
          >
            <fieldset className="mb-4">
              <legend className="mb-1 font-semibold">{t("minutes.decisionLabel")}</legend>
              {(["APPROVE", "REQUEST_CHANGES"] as const).map((d) => (
                <div key={d} className="mb-1 flex items-start gap-2">
                  <input
                    id={`review-${d}`}
                    type="radio"
                    name="decision"
                    value={d}
                    className="mt-1 size-5"
                    required
                    data-testid={`review-${d}`}
                  />
                  <label htmlFor={`review-${d}`}>
                    {d === "APPROVE" ? t("minutes.approve") : t("minutes.requestChanges")}
                  </label>
                </div>
              ))}
            </fieldset>
            <CDFField
              id="review-comment"
              label={t("minutes.commentLabel")}
              hint={t("minutes.commentHint")}
              optionalLabel={t("common.optional")}
            >
              <textarea
                id="review-comment"
                name="comment"
                className={textareaClass}
                aria-describedby="review-comment-hint"
                minLength={5}
                maxLength={4000}
              />
            </CDFField>
          </CDFCommandForm>
        </div>
      ) : null}
      {cap.mayRemind ? (
        <div className="w-full" data-testid="minutes-remind">
          <h3 className="mb-1 font-semibold">{t("minutes.remindTitle")}</h3>
          <p className="mb-2 text-sm text-cdf-text-secondary">{t("minutes.remindIntro")}</p>
          <CDFCommandForm
            action={remindReviewersAction.bind(null, mi.minutesId, meetingId)}
            locale={t.locale}
            submitLabel={t("minutes.remind")}
            variant="secondary"
            testId="minutes-remind-form"
            successMessage={t("minutes.reminded")}
            confirm={confirmation(t, "remindReviewers")}
          />
        </div>
      ) : null}
      {cap.mayApplyDeemedApproval ? (
        <div className="w-full" data-testid="minutes-deemed">
          <h3 className="mb-1 font-semibold">{t("minutes.deemedTitle")}</h3>
          <p className="mb-2 text-sm text-cdf-text-secondary">{t("minutes.deemedIntro")}</p>
          <CDFCommandForm
            action={applyDeemedApprovalAction.bind(null, mi.minutesId, meetingId)}
            locale={t.locale}
            submitLabel={t("minutes.deemed")}
            variant="danger"
            testId="minutes-deemed-form"
            successMessage={t("minutes.deemedDone")}
            confirm={confirmation(t, "applyDeemedApproval")}
          />
        </div>
      ) : null}
      {cap.mayOverruleObjection ? (
        <div className="w-full" data-testid="minutes-overrule">
          <h3 className="mb-1 font-semibold">{t("minutes.overruleTitle")}</h3>
          <p className="mb-2 text-sm text-cdf-text-secondary">{t("minutes.overruleIntro")}</p>
          <CDFCommandForm
            action={overruleObjectionAction.bind(null, mi.minutesId, meetingId)}
            locale={t.locale}
            submitLabel={t("minutes.overrule")}
            variant="danger"
            testId="minutes-overrule-form"
            successMessage={t("minutes.overruled")}
            fieldLabels={{ reason: t("meetings.reasonLabel") }}
            confirm={confirmation(t, "overruleObjection")}
          >
            <CDFField
              id="overrule-reason"
              label={t("meetings.reasonLabel")}
              hint={t("meetings.longReasonHint")}
            >
              <textarea
                id="overrule-reason"
                name="reason"
                className={textareaClass}
                aria-describedby="overrule-reason-hint"
                minLength={10}
                maxLength={2000}
                required
              />
            </CDFField>
          </CDFCommandForm>
        </div>
      ) : null}
    </CDFWorkflowGuide>
  );
}
