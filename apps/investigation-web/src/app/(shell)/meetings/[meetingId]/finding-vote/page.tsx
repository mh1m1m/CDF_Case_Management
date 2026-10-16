// Opening a vote on a finding (UX redesign Phase 12 P12-2c; ADR-056; CDF-214): a page of its own for whoever runs an
// open meeting of the Investigation Committee, so that the meeting's page, which re-renders while the meeting runs,
// never reads the committee's choices. Only when api.meeting_view says the caller may open a vote does the page read
// R1 (api.committee_scope_choices, recorded with counts) for the findings the committee may act on: each current
// version recorded in the committee proceeding or in the one it was referred from, shown by result, the allegation's
// position and category, and the subject's position and category, never the rationale. R1 answers only the
// committee's secretary; anyone else who runs the meeting is told the choices are not available to them. Anyone who
// may not open a vote gets the same 404 as a meeting that does not exist; the command checks everything again.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CommitteeScopeChoices, FindingChoice } from "@cdf/contracts";
import { isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFAlert,
  CDFBreadcrumbs,
  CDFCard,
  CDFCommandForm,
  CDFField,
  CDFPageHeader,
  CDFPurposeBanner,
  inputClass,
} from "@cdf/ui";
import {
  committeeProceedingsService,
  committeesService,
  meetingsService,
  requireActor,
} from "@/server/container";
import { getTranslator } from "@/server/locale";
import { actLabel, confirmation } from "../../../confirmations";
import { allegationName, subjectName } from "../../../committee-proceedings/labels";
import { openFindingVoteAction } from "../actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or meeting content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.findingVote") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function FindingVotePage({ params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await params;
  if (!UUID.test(meetingId)) notFound();
  const { ctx } = await requireActor();
  const t = await getTranslator();
  const m = await meetingsService().meeting(ctx, meetingId);
  // A vote on a finding is the Investigation Committee's (api.open_vote_item takes FINDING in its meetings only).
  if (!m || m.view !== "FULL" || !m.capabilities.mayOpenVote || m.committee.kind !== "INVESTIGATION")
    notFound();
  const [scope, seats] = await Promise.all([
    committeeProceedingsService().scopeChoices(ctx, m.committeeProceedingId),
    committeesService().myCommittees(ctx),
  ]);

  const n = m.logistics.sequenceNo;
  const committee = t.code("committeeName", m.committee.code, "common.none");
  const seated = seats.some((c) => c.committeeId === m.committee.committeeId);
  const meetingHref = `/meetings/${meetingId}`;
  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={[
          ...(seated
            ? [
                { label: t("shell.area.COMMITTEE"), href: "/committees" },
                { label: committee, href: `/committees/${m.committee.committeeId}` },
              ]
            : [{ label: t("shell.area.MY_WORK"), href: "/my-work" }]),
          { label: t("meetings.breadcrumb", { n }), href: meetingHref },
          { label: t("committeeProceedings.findingVoteBreadcrumb") },
        ]}
      />
      <CDFPageHeader title={t("committeeProceedings.findingVoteTitle", { committee, n })} />
      <CDFPurposeBanner
        title={t("committeeProceedings.findingVotePurposeTitle")}
        purpose={t("committeeProceedings.findingVotePurposeBody")}
        notShown={t("committeeProceedings.findingVotePurposeNotShown")}
        testId="finding-vote-purpose-banner"
      />
      {scope ? (
        <FindingVoteForm t={t} meetingId={meetingId} scope={scope} n={n} />
      ) : (
        <CDFAlert
          tone="info"
          title={t("committeeProceedings.findingChoicesHiddenTitle")}
          testId="finding-choices-hidden"
        >
          <p>{t("committeeProceedings.findingChoicesHiddenBody")}</p>
        </CDFAlert>
      )}
      <p className="mt-2">
        <Link href={meetingHref} className="underline" data-testid="finding-vote-back">
          {t("committeeProceedings.backToMeeting", { n })}
        </Link>
      </p>
    </>
  );
}

/** "Substantiated · Allegation 2 · Fraud · Person 1 · Employee · version 3": what the committee votes on, never why. */
function findingLabel(t: Translator, scope: CommitteeScopeChoices, f: FindingChoice): string {
  const allegation = scope.allegations.find((a) => a.allegationId === f.allegationId);
  const subject = f.subjectId ? scope.subjects.find((s) => s.subjectId === f.subjectId) : undefined;
  return t("committeeProceedings.findingOption", {
    result: t.code("findingResult", f.result, "common.none"),
    allegation: allegation ? allegationName(t, allegation) : t("committeeProceedings.anAllegation"),
    subject: subject ? isolate(subjectName(t, subject)) : t("caseStructure.wholeAllegation"),
    version: f.versionNo,
    where: t(`committeeProceedings.findingRole.${f.proceedingRole}` as MessageKey),
  });
}

function FindingVoteForm({
  t,
  meetingId,
  scope,
  n,
}: {
  t: Translator;
  meetingId: string;
  scope: CommitteeScopeChoices;
  n: number;
}) {
  if (scope.findings.length === 0)
    return (
      <p className="mb-4 text-cdf-text-secondary" data-testid="finding-vote-none">
        {t("committeeProceedings.noFindingChoices")}
      </p>
    );
  return (
    <CDFCard title={t("committeeProceedings.findingVoteFormTitle")} testId="finding-vote">
      <CDFCommandForm
        action={openFindingVoteAction.bind(null, meetingId)}
        locale={t.locale}
        submitLabel={actLabel(t, "openVoteItem")}
        submitName={t("committeeProceedings.openFindingVoteName", { n })}
        variant="primary"
        testId="finding-vote-form"
        codeSections={["committeeProceedings.codes", "codes"]}
        fieldLabels={{
          findingId: t("committeeProceedings.findingLabel"),
          title: t("meetings.voteSubjectLabel"),
        }}
        confirm={confirmation(t, "openVoteItem")}
      >
        <CDFField
          id="finding-vote-finding"
          label={t("committeeProceedings.findingLabel")}
          hint={t("committeeProceedings.findingHint")}
        >
          <select
            id="finding-vote-finding"
            name="findingId"
            className={inputClass}
            defaultValue=""
            aria-describedby="finding-vote-finding-hint"
            required
            data-testid="finding-vote-finding"
          >
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {scope.findings.map((f) => (
              <option key={f.findingId} value={f.findingId}>
                {findingLabel(t, scope, f)}
              </option>
            ))}
          </select>
        </CDFField>
        <CDFField
          id="finding-vote-title"
          label={t("meetings.voteSubjectLabel")}
          hint={t("committeeProceedings.findingTitleHint")}
        >
          <input
            id="finding-vote-title"
            name="title"
            className={inputClass}
            aria-describedby="finding-vote-title-hint"
            minLength={3}
            maxLength={300}
            required
            data-testid="finding-vote-title"
          />
        </CDFField>
      </CDFCommandForm>
    </CDFCard>
  );
}
