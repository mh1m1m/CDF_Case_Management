// One committee (UX redesign Phase 12 P12-2b; ADR-055; DEC-02, DEC-F19, DEC-22): a purpose route that reads
// api.committee_view and nothing of the case. Without a current seat on the committee it is the same 404 as an id that
// names no committee, and the refusal is recorded (ACCESS_DENIED). The proceedings are the ones the seat gives, never
// the case team's; a proceeding's committee is counts, never a person; the case is named only to whoever may see its
// metadata, and otherwise the page names the proceeding by a short reference that is never a key. Scheduling and
// adding a member show only where the command's own answer says the caller may (UX-116); each command checks again.
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  MEETING_MODES,
  MEETING_PURPOSES,
  type CommitteeProceedingSummary,
  type CommitteeRules,
  type CommitteeView,
  type RuleSourceStatus,
} from "@cdf/contracts";
import { proceedingShortRef } from "@cdf/domain";
import { formatDate, formatDateTime, formatDays, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFBadge,
  CDFBreadcrumbs,
  CDFCard,
  CDFCommandForm,
  CDFConfiguredValue,
  CDFDescriptionList,
  CDFField,
  CDFPageHeader,
  CDFPurposeBanner,
  CDFStatusBadge,
  inputClass,
  textareaClass,
  type CDFValueSource,
} from "@cdf/ui";
import { committeesService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { confirmation } from "../../confirmations";
import { participantName } from "../../meetings/meeting-labels";
import { amendProceedingSnapshotAction, scheduleMeetingAction } from "./actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or committee content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.committee") };
}

const UUID = /^[0-9a-f-]{36}$/i;

const RULE_SOURCE: Record<RuleSourceStatus, CDFValueSource> = {
  OWNER_DEFAULT: "OWNER_DEFAULT",
  SOURCE_REQUIRED: "SOURCE_REQUIRED",
  APPROVED: "CONFIGURED",
};

export default async function CommitteePage({ params }: { params: Promise<{ committeeId: string }> }) {
  const { committeeId } = await params;
  if (!UUID.test(committeeId)) notFound();
  const { ctx } = await requireActor();
  const t = await getTranslator();
  const v = await committeesService().committee(ctx, committeeId);
  if (!v) notFound();

  const name = t.code("committeeName", v.committee.code, "common.none");
  const open = v.proceedings.filter((p) => p.status === "OPEN");
  const closed = v.proceedings.filter((p) => p.status !== "OPEN");
  const unnamedCase = v.proceedings.some((p) => p.case.caseNumber === null);
  const card = (p: CommitteeProceedingSummary) => (
    <ProceedingCard key={p.committeeProceedingId} t={t} v={v} p={p} />
  );

  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={[{ label: t("shell.area.COMMITTEE"), href: "/committees" }, { label: name }]}
      />
      <CDFPageHeader
        title={name}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CDFBadge tone="info" testId="committee-my-seat">
              {t("committees.rowSeat", { seat: t.code("committeeSeat", v.mySeat.seat, "common.none") })}
            </CDFBadge>
            {v.committee.isActive ? null : (
              <CDFBadge tone="neutral" testId="committee-inactive">
                {t("committees.inactive")}
              </CDFBadge>
            )}
          </div>
        }
      />
      <CDFPurposeBanner
        title={t("committees.purposeTitle")}
        purpose={t("committees.purposeBody")}
        {...(unnamedCase ? { notShown: t("committees.purposeNoCase") } : {})}
        testId="committee-purpose-banner"
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="min-w-0" aria-labelledby="committee-proceedings-heading">
          <h2 id="committee-proceedings-heading" className="mb-3 text-lg font-semibold">
            {t("committees.proceedingsTitle")}
          </h2>
          {v.proceedings.length === 0 ? (
            <p className="text-cdf-text-secondary" data-testid="committee-no-proceedings">
              {t("committees.noProceedings")}
            </p>
          ) : null}
          {open.map(card)}
          {closed.length > 0 ? (
            <details className="mt-2" data-testid="committee-closed-proceedings">
              <summary className="cursor-pointer font-semibold">
                {t("committees.closedProceedings", { count: closed.length })}
              </summary>
              <div className="mt-3">{closed.map(card)}</div>
            </details>
          ) : null}
        </section>
        <div className="min-w-0">
          <SeatCard t={t} v={v} />
          <MembersCard t={t} v={v} />
          <CDFCard title={t("committees.rulesTitle")} testId="committee-rules">
            {v.rules ? (
              <>
                <p className="mb-3 text-sm text-cdf-text-secondary">{t("committees.rulesIntro")}</p>
                <RulesList t={t} rules={v.rules} missing={t("common.none")} testId="committee-rules-list" />
              </>
            ) : (
              <p className="text-cdf-text-secondary" data-testid="committee-no-rules">
                {t("committees.noRules")}
              </p>
            )}
          </CDFCard>
        </div>
      </div>
    </>
  );
}

/** The proceeding's name on this page: its case where the caller may see it, otherwise a display-only reference. */
function proceedingLabel(t: Translator, code: string, p: CommitteeProceedingSummary): string {
  return p.case.caseNumber
    ? t("committees.proceedingOfCase", { number: isolate(p.case.caseNumber) })
    : t("committees.proceedingRef", { ref: isolate(proceedingShortRef(code, p.committeeProceedingId)) });
}

function ProceedingCard({ t, v, p }: { t: Translator; v: CommitteeView; p: CommitteeProceedingSummary }) {
  const id = `proceeding-${p.committeeProceedingId}`;
  const label = proceedingLabel(t, v.committee.code, p);
  const date = (iso: string) => isolate(formatDate(t.locale, iso));
  const cap = p.capabilities;
  return (
    <CDFCard
      title={label}
      testId={id}
      actions={
        <CDFStatusBadge domain="proceeding" status={p.status} testId={`${id}-status`}>
          {t(`proceedingStatus.${p.status}` as MessageKey)}
        </CDFStatusBadge>
      }
    >
      {p.case.caseNumber ? null : (
        <p className="mb-1 text-sm text-cdf-text-secondary" data-testid={`${id}-ref-note`}>
          {t("committees.refNote")}
        </p>
      )}
      <p className="mb-3 text-sm">
        {t("committees.referredOn", { date: date(p.referredAt) })}
        {p.closedAt ? ` ${t("committees.closedOn", { date: date(p.closedAt) })}` : null}
      </p>

      <h3 className="mb-2 font-semibold">{t("committees.meetingsTitle")}</h3>
      <MeetingList t={t} p={p} />

      {cap.mayScheduleMeeting || cap.mayScheduleEmergencyMeeting ? (
        <ScheduleForm t={t} committeeId={v.committee.committeeId} p={p} label={label} />
      ) : null}
      {cap.mayAmendSnapshot && p.amendmentCandidates.length > 0 ? (
        <AmendForm t={t} committeeId={v.committee.committeeId} p={p} label={label} />
      ) : null}

      <details className="mt-4 border-t border-cdf-border pt-3" data-testid={`${id}-committee`}>
        <summary className="cursor-pointer font-semibold">{t("committees.committeeTitle")}</summary>
        <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">{t("committees.committeeIntro")}</p>
        <CDFDescriptionList
          items={[
            ...p.snapshot.seats.map((x) => ({
              term: t.code("committeeSeat", x.seat, "common.none"),
              value: String(x.count),
            })),
            { term: t("caseStructure.voting"), value: String(p.snapshot.voting) },
            { term: t("committees.cleared"), value: String(p.snapshot.cleared) },
            { term: t("caseStructure.notCleared"), value: String(p.snapshot.notCleared) },
            ...(p.snapshot.firewallRestricted > 0
              ? [{ term: t("caseStructure.firewall"), value: String(p.snapshot.firewallRestricted) }]
              : []),
            ...(p.snapshot.addedAfterReferral > 0
              ? [{ term: t("committees.addedAfterReferral"), value: String(p.snapshot.addedAfterReferral) }]
              : []),
          ]}
        />
      </details>
      <details className="mt-3 border-t border-cdf-border pt-3" data-testid={`${id}-rules`}>
        <summary className="cursor-pointer font-semibold">{t("committees.proceedingRulesTitle")}</summary>
        <div className="mt-3">
          <RulesList t={t} rules={p.rules} missing={t("committees.notInCopy")} testId={`${id}-rules-list`} />
        </div>
      </details>
    </CDFCard>
  );
}

/** The proceeding's meetings the caller may see, in the read model's order; each opens the meeting's page. */
function MeetingList({ t, p }: { t: Translator; p: CommitteeProceedingSummary }) {
  if (p.meetings.length === 0)
    return (
      <p
        className="text-sm text-cdf-text-secondary"
        data-testid={`proceeding-${p.committeeProceedingId}-no-meetings`}
      >
        {t("committees.noMeetings")}
      </p>
    );
  const when = (iso: string) => isolate(formatDateTime(t.locale, iso));
  return (
    <ul className="grid gap-2" aria-label={t("committees.meetingsLabel")}>
      {p.meetings.map((m) => (
        <li
          key={m.meetingId}
          className="grid gap-1 rounded-cdf-md border border-cdf-border p-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4"
          data-testid={`meeting-row-${m.meetingId}`}
        >
          <div className="grid gap-0.5">
            <Link
              href={`/meetings/${m.meetingId}`}
              className="font-semibold underline underline-offset-4"
              data-testid={`meeting-link-${m.meetingId}`}
            >
              {t("committees.meetingLink", { n: m.sequenceNo })}
            </Link>
            <span className="text-sm text-cdf-text-secondary">
              {t("committees.meetingDetail", {
                kind: t(`meetings.kind.${m.purpose}` as MessageKey),
                mode: t(`meetings.mode.${m.mode}` as MessageKey),
              })}
            </span>
            <span className="text-sm">
              {m.scheduledEnd
                ? t("meetings.timeRange", { start: when(m.scheduledStart), end: when(m.scheduledEnd) })
                : when(m.scheduledStart)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CDFStatusBadge domain="meeting" status={m.status} testId={`meeting-row-${m.meetingId}-status`}>
              {t(`meetings.status.${m.status}` as MessageKey)}
            </CDFStatusBadge>
            {m.isEmergency ? (
              <CDFBadge tone="warning" testId={`meeting-row-${m.meetingId}-emergency`}>
                {t("meetings.emergency")}
              </CDFBadge>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Scheduling, for whoever the command would accept now up to the time chosen: the form states the proceeding's
 * minimum notice, which the command checks against that time. The emergency box sends the emergency command instead,
 * which records the meeting as one with its reason (AMB-061).
 */
function ScheduleForm({
  t,
  committeeId,
  p,
  label,
}: {
  t: Translator;
  committeeId: string;
  p: CommitteeProceedingSummary;
  label: string;
}) {
  const id = `schedule-${p.committeeProceedingId}`;
  const notice = p.rules.minimumNoticeDays;
  return (
    <details className="mt-4 border-t border-cdf-border pt-3" data-testid={id}>
      <summary className="cursor-pointer font-semibold">{t("committees.scheduleTitle")}</summary>
      <p className="mt-2 text-sm text-cdf-text-secondary">{t("committees.scheduleIntro")}</p>
      <p className="mb-3 text-sm font-semibold" data-testid={`${id}-notice`}>
        {notice === null
          ? t("committees.noNoticeRule")
          : t("committees.noticeRule", { days: formatDays(t.locale, notice) })}
      </p>
      <CDFCommandForm
        action={scheduleMeetingAction.bind(null, committeeId, p.committeeProceedingId)}
        locale={t.locale}
        submitLabel={t("committees.schedule")}
        submitName={t("committees.scheduleName", { ref: label })}
        variant="primary"
        testId={`${id}-form`}
        successMessage={t("committees.scheduled")}
        leaveWarning={t("common.leaveWarning")}
        fieldLabels={{
          purpose: t("meetings.meetingKind"),
          mode: t("meetings.how"),
          location: t("meetings.where"),
          onlineUrl: t("meetings.onlineLink"),
          scheduledStart: t("committees.startLabel"),
          scheduledEnd: t("committees.endLabel"),
          reason: t("meetings.reasonLabel"),
          emergencyReason: t("committees.emergencyReasonLabel"),
        }}
        confirm={confirmation(t, "scheduleMeeting")}
      >
        <CDFField id={`${id}-purpose`} label={t("meetings.meetingKind")}>
          <select
            id={`${id}-purpose`}
            name="purpose"
            className={inputClass}
            defaultValue="DELIBERATION"
            required
          >
            {MEETING_PURPOSES.map((v) => (
              <option key={v} value={v}>
                {t(`meetings.kind.${v}` as MessageKey)}
              </option>
            ))}
          </select>
        </CDFField>
        <CDFField id={`${id}-mode`} label={t("meetings.how")}>
          <select id={`${id}-mode`} name="mode" className={inputClass} defaultValue="IN_PERSON" required>
            {MEETING_MODES.map((v) => (
              <option key={v} value={v}>
                {t(`meetings.mode.${v}` as MessageKey)}
              </option>
            ))}
          </select>
        </CDFField>
        <CDFField
          id={`${id}-location`}
          label={t("meetings.where")}
          hint={t("committees.locationHint")}
          optionalLabel={t("common.optional")}
        >
          <input
            id={`${id}-location`}
            name="location"
            type="text"
            className={inputClass}
            aria-describedby={`${id}-location-hint`}
            maxLength={200}
          />
        </CDFField>
        <CDFField
          id={`${id}-link`}
          label={t("meetings.onlineLink")}
          hint={t("committees.linkHint")}
          optionalLabel={t("common.optional")}
        >
          <input
            id={`${id}-link`}
            name="onlineUrl"
            type="url"
            inputMode="url"
            dir="ltr"
            className={inputClass}
            aria-describedby={`${id}-link-hint`}
            maxLength={500}
          />
        </CDFField>
        <CDFField id={`${id}-start`} label={t("committees.startLabel")}>
          <input
            id={`${id}-start`}
            name="scheduledStart"
            type="datetime-local"
            dir="ltr"
            className={inputClass}
            required
          />
        </CDFField>
        <CDFField id={`${id}-end`} label={t("committees.endLabel")}>
          <input
            id={`${id}-end`}
            name="scheduledEnd"
            type="datetime-local"
            dir="ltr"
            className={inputClass}
            required
          />
        </CDFField>
        <CDFField id={`${id}-reason`} label={t("meetings.reasonLabel")} hint={t("meetings.reasonHint")}>
          <textarea
            id={`${id}-reason`}
            name="reason"
            className={textareaClass}
            aria-describedby={`${id}-reason-hint`}
            minLength={5}
            maxLength={2000}
            required
          />
        </CDFField>
        {p.capabilities.mayScheduleEmergencyMeeting ? (
          <fieldset className="mb-4 rounded-cdf-md border border-cdf-border p-3">
            <legend className="px-1 font-semibold">{t("meetings.emergency")}</legend>
            <div className="mb-3 flex items-start gap-2">
              <input
                id={`${id}-emergency`}
                name="emergency"
                type="checkbox"
                className="mt-1 size-5"
                data-testid={`${id}-emergency`}
              />
              <label htmlFor={`${id}-emergency`}>{t("committees.emergencyLabel")}</label>
            </div>
            <CDFField
              id={`${id}-emergency-reason`}
              label={t("committees.emergencyReasonLabel")}
              hint={t("committees.emergencyReasonHint")}
            >
              <textarea
                id={`${id}-emergency-reason`}
                name="emergencyReason"
                className={textareaClass}
                aria-describedby={`${id}-emergency-reason-hint`}
                maxLength={2000}
              />
            </CDFField>
          </fieldset>
        ) : null}
      </CDFCommandForm>
    </details>
  );
}

/**
 * Adding a member appointed after the referral (AMB-038), for whoever the command would accept up to the member chosen.
 * The candidates are not filtered by clearance: the command answers NOT_CLEARED_FOR_CASE when it runs (DEC-F19).
 */
function AmendForm({
  t,
  committeeId,
  p,
  label,
}: {
  t: Translator;
  committeeId: string;
  p: CommitteeProceedingSummary;
  label: string;
}) {
  const id = `amend-${p.committeeProceedingId}`;
  return (
    <details className="mt-4 border-t border-cdf-border pt-3" data-testid={id}>
      <summary className="cursor-pointer font-semibold">{t("committees.amendTitle")}</summary>
      <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">{t("committees.amendIntro")}</p>
      <CDFCommandForm
        action={amendProceedingSnapshotAction.bind(null, committeeId, p.committeeProceedingId)}
        locale={t.locale}
        submitLabel={t("committees.amend")}
        submitName={t("committees.amendName", { ref: label })}
        variant="secondary"
        testId={`${id}-form`}
        successMessage={t("committees.amended")}
        codeSections={["committees.codes", "codes"]}
        fieldLabels={{ membershipId: t("committees.memberLabel"), reason: t("meetings.reasonLabel") }}
        confirm={confirmation(t, "amendProceedingSnapshot")}
      >
        <CDFField id={`${id}-member`} label={t("committees.memberLabel")}>
          <select id={`${id}-member`} name="membershipId" className={inputClass} defaultValue="" required>
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {p.amendmentCandidates.map((c) => (
              <option key={c.membershipId} value={c.membershipId}>
                {t("committees.candidate", {
                  name: participantName(t, c),
                  seat: t.code("committeeSeat", c.seat, "common.none"),
                  date: formatDate(t.locale, c.effectiveFrom),
                })}
              </option>
            ))}
          </select>
        </CDFField>
        <CDFField id={`${id}-reason`} label={t("meetings.reasonLabel")} hint={t("meetings.longReasonHint")}>
          <textarea
            id={`${id}-reason`}
            name="reason"
            className={textareaClass}
            aria-describedby={`${id}-reason-hint`}
            minLength={10}
            maxLength={2000}
            required
          />
        </CDFField>
      </CDFCommandForm>
    </details>
  );
}

function SeatCard({ t, v }: { t: Translator; v: CommitteeView }) {
  const s = v.mySeat;
  return (
    <CDFCard title={t("committees.yourSeatTitle")} testId="committee-seat">
      <CDFDescriptionList
        stacked
        items={[
          { term: t("committees.seatLabel"), value: t.code("committeeSeat", s.seat, "common.none") },
          { term: t("committees.sinceLabel"), value: formatDate(t.locale, s.effectiveFrom) },
          {
            term: t("committees.untilLabel"),
            value: s.effectiveTo ? formatDate(t.locale, s.effectiveTo) : t("committees.noEnd"),
          },
        ]}
      />
    </CDFCard>
  );
}

/** The current members by name and seat: what the committee registry already shows any seat holder. */
function MembersCard({ t, v }: { t: Translator; v: CommitteeView }) {
  return (
    <CDFCard title={t("committees.membersTitle")} testId="committee-members">
      <ul className="grid gap-2 text-sm" aria-label={t("committees.membersLabel")}>
        {v.members.map((m, i) => (
          <li key={`${m.userId}-${m.seat}`} data-testid={`committee-member-${i + 1}`}>
            <span className="font-semibold">
              <bdi>{participantName(t, m)}</bdi>
            </span>
            <span className="text-cdf-text-secondary">
              {" · "}
              {t.code("committeeSeat", m.seat, "common.none")}
            </span>
          </li>
        ))}
      </ul>
    </CDFCard>
  );
}

/**
 * A rule set as the committee holds it now, or as a proceeding copied it at referral (rule 7: a configured rule, never
 * presented as CDF policy, so its source is said). A copy taken before a rule existed lacks it: `missing` says so.
 */
function RulesList({
  t,
  rules: r,
  missing,
  testId,
}: {
  t: Translator;
  rules: CommitteeRules;
  missing: string;
  testId: string;
}) {
  const yesNo = (v: boolean | null) => (v === null ? missing : v ? t("common.yes") : t("common.no"));
  const items: { term: string; value: ReactNode }[] = [
    {
      term: t("caseStructure.quorum"),
      value: t(`quorumType.${r.quorumType}` as MessageKey, { value: r.quorumValue ?? "—" }),
    },
    {
      term: t("committees.minimumNotice"),
      value:
        r.minimumNoticeDays === null ? t("committees.noNotice") : formatDays(t.locale, r.minimumNoticeDays),
    },
    { term: t("caseStructure.castingVote"), value: yesNo(r.castingVoteEnabled) },
    { term: t("committees.actingChairCastingVote"), value: yesNo(r.actingChairCastingVote) },
    {
      term: t("committees.ballot"),
      value: r.ballotSecrecy ? t(`committees.ballotValue.${r.ballotSecrecy}` as MessageKey) : missing,
    },
    { term: t("committees.voteRevision"), value: yesNo(r.voteRevisionAllowed) },
    { term: t("committees.dissentNote"), value: yesNo(r.dissentNoteAllowed) },
    {
      term: t("caseStructure.minutesReview"),
      value:
        r.minutesReviewBusinessDays === null
          ? missing
          : t("caseStructure.minutesDays", { days: r.minutesReviewBusinessDays }),
    },
    { term: t("caseStructure.deemedApproval"), value: yesNo(r.deemedApprovalEnabled) },
    { term: t("committees.objectionBlocksDeemed"), value: yesNo(r.minutesObjectionBlocksDeemed) },
    {
      term: t("committees.conflictDecider"),
      value: r.conflictDecider
        ? t(`committees.conflictDeciderValue.${r.conflictDecider}` as MessageKey)
        : missing,
    },
  ];
  return (
    <div data-testid={testId}>
      {r.sourceStatus || r.effectiveFrom ? (
        <p className="mb-2 text-sm">
          {r.sourceStatus ? (
            <CDFConfiguredValue
              value={
                r.effectiveFrom
                  ? t("committees.inForceSince", { date: isolate(formatDate(t.locale, r.effectiveFrom)) })
                  : ""
              }
              source={RULE_SOURCE[r.sourceStatus]}
              sourceLabel={t(`caseStructure.ruleSource.${r.sourceStatus}` as MessageKey)}
              testId={`${testId}-source`}
            />
          ) : (
            t("committees.inForceSince", { date: isolate(formatDate(t.locale, r.effectiveFrom!)) })
          )}
        </p>
      ) : null}
      <CDFDescriptionList stacked items={items} />
    </div>
  );
}
