// The meeting's votes (api.meeting_view deliberation, for callers who pass authz.can_view_meeting_deliberation; a
// declared conflict closes it, rule 6). Counts and the result only, never how a member voted (AMB-083, rule 5). Who
// has voted so far comes from api.vote_item_status: a count for the roster's readers, the names of the members present
// who have not voted for the runner, who needs them to close the vote. Every form comes from the item's own
// capabilities or record_vote_for; the database decides again on submit. A vote on a finding opens from its own page and
// a recommendation package's from the proceeding's page (P12-2c, ADR-056); this card links them for the runner.
import Link from "next/link";
import {
  CASTING_VOTE_CHOICES,
  MEMBER_VOTE_CHOICES,
  RECORDED_FOR_MEMBER_CHOICES,
  type MeetingDeliberationView,
  type MeetingParticipantView,
  type MeetingVoteItemView,
  type VoteItemProgress,
} from "@cdf/contracts";
import { formatList, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFCard,
  CDFCommandForm,
  CDFDescriptionList,
  CDFField,
  CDFStatusBadge,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { confirmation } from "../../confirmations";
import { participantName } from "../meeting-labels";
import {
  castCastingVoteAction,
  castVoteAction,
  closeVoteItemAction,
  openVoteItemAction,
  recordVoteForMemberAction,
  recordVoteNoteAction,
  recuseForConflictAction,
  reviseVoteAction,
} from "./actions";

export function MeetingVotes({
  t,
  meetingId,
  deliberation,
  roster,
  runner,
  mayOpenVote,
  progress,
  findingVoteHref = null,
  proceedingHref = null,
}: {
  t: Translator;
  meetingId: string;
  deliberation: MeetingDeliberationView;
  roster: MeetingParticipantView[] | null;
  /** The caller runs the meeting (capabilities.canManage). */
  runner: boolean;
  mayOpenVote: boolean;
  /** api.vote_item_status for each open item the caller may read. */
  progress: ReadonlyMap<string, VoteItemProgress>;
  /** The finding-vote page, for whoever may open a vote in a meeting of the Investigation Committee. */
  findingVoteHref?: string | null;
  /** The proceeding's page, where a recommendation package is put to the vote. */
  proceedingHref?: string | null;
}) {
  const d = deliberation;
  const row = (participantId: string) => roster?.find((p) => p.participantId === participantId);
  const quorum = d.quorum;
  return (
    <CDFCard title={t("meetings.votesTitle")} testId="meeting-votes">
      <p className="mb-2 text-sm text-cdf-text-secondary" data-testid="ballot-secrecy">
        {t(`meetings.ballot.${d.ballotSecrecy}` as MessageKey)}
      </p>
      {quorum ? (
        <p className="mb-3" data-testid="quorum-line">
          {quorum.quorumType === "CUSTOM" || quorum.required === null
            ? t("meetings.quorumCustom", { present: quorum.present, eligible: quorum.eligible })
            : t("meetings.quorum", {
                present: quorum.present,
                eligible: quorum.eligible,
                required: quorum.required,
              })}
        </p>
      ) : null}
      {d.voteItems.length === 0 ? (
        <p className="text-cdf-text-secondary" data-testid="no-votes">
          {t("meetings.noVotes")}
        </p>
      ) : (
        <ol className="grid gap-4" data-testid="vote-list">
          {d.voteItems.map((v) => (
            <VoteItem
              key={v.voteItemId}
              t={t}
              meetingId={meetingId}
              v={v}
              customQuorum={quorum?.quorumType === "CUSTOM"}
              runner={runner}
              progress={progress.get(v.voteItemId) ?? null}
              row={row}
            />
          ))}
        </ol>
      )}

      {mayOpenVote ? (
        <details className="mt-4 border-t border-cdf-border pt-3" data-testid="open-vote">
          <summary className="cursor-pointer font-semibold">{t("meetings.openVoteTitle")}</summary>
          <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">{t("meetings.openVoteIntro")}</p>
          {findingVoteHref || proceedingHref ? (
            <ul className="mb-3 grid gap-1" data-testid="open-vote-elsewhere">
              {findingVoteHref ? (
                <li>
                  <Link href={findingVoteHref} className="underline" data-testid="open-finding-vote-link">
                    {t("committeeProceedings.findingVoteLink")}
                  </Link>
                </li>
              ) : null}
              {proceedingHref ? (
                <li>
                  <Link href={proceedingHref} className="underline" data-testid="open-package-vote-link">
                    {t("committeeProceedings.packageVoteLink")}
                  </Link>
                </li>
              ) : null}
            </ul>
          ) : null}
          <CDFCommandForm
            action={openVoteItemAction.bind(null, meetingId)}
            locale={t.locale}
            submitLabel={t("meetings.openVote")}
            variant="primary"
            testId="open-vote-form"
            successMessage={t("meetings.voteOpened")}
            fieldLabels={{ title: t("meetings.voteSubjectLabel") }}
            confirm={confirmation(t, "openVoteItem")}
          >
            <CDFField
              id="vote-title"
              label={t("meetings.voteSubjectLabel")}
              hint={t("meetings.voteSubjectHint")}
            >
              <input
                id="vote-title"
                name="title"
                className={inputClass}
                aria-describedby="vote-title-hint"
                minLength={3}
                maxLength={300}
                required
              />
            </CDFField>
          </CDFCommandForm>
        </details>
      ) : null}
    </CDFCard>
  );
}

function VoteItem({
  t,
  meetingId,
  v,
  customQuorum,
  runner,
  progress,
  row,
}: {
  t: Translator;
  meetingId: string;
  v: MeetingVoteItemView;
  customQuorum: boolean;
  runner: boolean;
  progress: VoteItemProgress | null;
  row: (participantId: string) => MeetingParticipantView | undefined;
}) {
  const n = v.sequenceNo;
  const id = `vote-${n}`;
  const cap = v.capabilities;
  // The members present who count and have no conflict, as api.close_vote_item counts them (VOTES_OUTSTANDING).
  const counting =
    progress?.voters.filter((x) => {
      const r = row(x.participantId);
      return !x.replaced && r?.attendance === "PRESENT" && r.coiStatus === "NO_CONFLICT";
    }) ?? [];
  const outstanding = counting.filter((x) => !x.hasVoted);
  const name = (participantId: string) => {
    const r = row(participantId);
    return r ? participantName(t, r) : t("meetings.aParticipant");
  };
  const tally = v.tally;
  return (
    <li className="border-b border-cdf-border pb-4 last:border-0 last:pb-0" data-testid={id}>
      <h3 className="flex flex-wrap items-center gap-2 font-semibold">
        <span>
          {t("meetings.voteNumber", { n })} · <bdi dir="auto">{v.title}</bdi>
        </span>
        <CDFStatusBadge domain="voteItem" status={v.status} testId={`${id}-status`}>
          {t(`meetings.voteStatus.${v.status}` as MessageKey)}
        </CDFStatusBadge>
      </h3>
      <p className="text-sm text-cdf-text-secondary">{t(`meetings.target.${v.targetType}` as MessageKey)}</p>
      {v.result ? (
        <p className="mt-1 font-semibold" data-testid={`${id}-result`}>
          {t("meetings.resultLine", { result: t(`meetings.result.${v.result}` as MessageKey) })}
        </p>
      ) : null}
      {v.decidedByCastingVote ? <p className="text-sm">{t("meetings.byCastingVote")}</p> : null}
      {tally ? (
        <div className="mt-2" data-testid={`${id}-tally`}>
          <h4 className="mb-1 text-sm font-semibold">{t("meetings.count.title")}</h4>
          <CDFDescriptionList
            items={[
              { term: t("meetings.count.eligible"), value: String(tally.eligible) },
              { term: t("meetings.count.present"), value: String(tally.present) },
              ...(tally.quorumRequired !== null
                ? [{ term: t("meetings.count.required"), value: String(tally.quorumRequired) }]
                : []),
              { term: t("meetings.count.approve"), value: String(tally.approve) },
              { term: t("meetings.count.reject"), value: String(tally.reject) },
              { term: t("meetings.count.abstain"), value: String(tally.abstain) },
              { term: t("meetings.count.recused"), value: String(tally.recused) },
              { term: t("meetings.count.absent"), value: String(tally.absent) },
              { term: t("meetings.count.unable"), value: String(tally.unable) },
              { term: t("meetings.count.excluded"), value: String(tally.excluded) },
            ]}
          />
        </div>
      ) : null}
      {v.status === "OPEN" && counting.length > 0 ? (
        <p className="mt-1 text-sm" data-testid={`${id}-progress`}>
          {t("meetings.progress", { voted: counting.length - outstanding.length, total: counting.length })}
        </p>
      ) : null}
      {v.status === "OPEN" && runner && outstanding.length > 0 ? (
        <p className="mt-1 text-sm" data-testid={`${id}-outstanding`}>
          {t("meetings.notYetVoted", {
            names: isolate(
              formatList(
                t.locale,
                outstanding.map((x) => name(x.participantId)),
              ),
            ),
          })}
        </p>
      ) : null}
      {v.iHaveVoted ? (
        <p className="mt-1 text-sm font-semibold" data-testid={`${id}-voted`}>
          {t("meetings.youVoted")}
        </p>
      ) : null}
      {v.iHaveNoted ? (
        <p className="mt-1 text-sm" data-testid={`${id}-noted`}>
          {t("meetings.youNoted")}
        </p>
      ) : null}

      {cap.mayCastCastingVote ? (
        <div className="mt-3 border-t border-cdf-border pt-3" data-testid={`${id}-casting`}>
          <h4 className="mb-1 font-semibold">{t("meetings.castingTitle")}</h4>
          <p className="mb-2 text-sm text-cdf-text-secondary">{t("meetings.castingIntro")}</p>
          <CDFCommandForm
            action={castCastingVoteAction.bind(null, meetingId, v.voteItemId)}
            locale={t.locale}
            submitLabel={t("meetings.castCasting")}
            submitName={t("meetings.castCastingName", { n })}
            variant="primary"
            testId={`${id}-casting-form`}
            successMessage={t("meetings.castingCast")}
            fieldLabels={{ choice: t("meetings.castingLabel"), reason: t("meetings.reasonLabel") }}
            confirm={confirmation(t, "castCastingVote")}
          >
            <ChoiceField
              t={t}
              id={`${id}-casting-choice`}
              label={t("meetings.castingLabel")}
              choices={CASTING_VOTE_CHOICES}
            />
            <OptionalReason t={t} id={`${id}-casting-reason`} />
          </CDFCommandForm>
        </div>
      ) : null}

      {cap.mayVote ? (
        <div className="mt-3 border-t border-cdf-border pt-3" data-testid={`${id}-cast`}>
          <CDFCommandForm
            action={castVoteAction.bind(null, meetingId, v.voteItemId)}
            locale={t.locale}
            submitLabel={t("meetings.cast")}
            submitName={t("meetings.castName", { n })}
            variant="primary"
            testId={`${id}-cast-form`}
            successMessage={t("meetings.voteCast")}
            fieldLabels={{ choice: t("meetings.choiceLabel"), reason: t("meetings.reasonLabel") }}
            confirm={confirmation(t, "castVote")}
          >
            <ChoiceField
              t={t}
              id={`${id}-choice`}
              label={t("meetings.choiceLabel")}
              choices={MEMBER_VOTE_CHOICES}
            />
            <OptionalReason t={t} id={`${id}-cast-reason`} />
          </CDFCommandForm>
        </div>
      ) : null}

      {cap.mayRevise ? (
        <details className="mt-3 border-t border-cdf-border pt-3" data-testid={`${id}-revise`}>
          <summary className="cursor-pointer font-semibold">{t("meetings.reviseTitle")}</summary>
          <div className="mt-3">
            <CDFCommandForm
              action={reviseVoteAction.bind(null, meetingId, v.voteItemId)}
              locale={t.locale}
              submitLabel={t("meetings.revise")}
              submitName={t("meetings.reviseName", { n })}
              variant="secondary"
              testId={`${id}-revise-form`}
              successMessage={t("meetings.revised")}
              fieldLabels={{ choice: t("meetings.choiceLabel"), reason: t("meetings.reasonLabel") }}
            >
              <ChoiceField
                t={t}
                id={`${id}-revise-choice`}
                label={t("meetings.choiceLabel")}
                choices={MEMBER_VOTE_CHOICES}
              />
              <OptionalReason t={t} id={`${id}-revise-reason`} />
            </CDFCommandForm>
          </div>
        </details>
      ) : null}

      {cap.mayRecuseForConflict ? (
        <details className="mt-3 border-t border-cdf-border pt-3" data-testid={`${id}-recuse`}>
          <summary className="cursor-pointer font-semibold">{t("meetings.recuseTitle")}</summary>
          <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">{t("meetings.recuseIntro")}</p>
          <CDFCommandForm
            action={recuseForConflictAction.bind(null, meetingId, v.voteItemId)}
            locale={t.locale}
            submitLabel={t("meetings.recuse")}
            submitName={t("meetings.recuseName", { n })}
            variant="danger"
            testId={`${id}-recuse-form`}
            successMessage={t("meetings.recusedDone")}
            fieldLabels={{ reason: t("meetings.reasonLabel") }}
            confirm={confirmation(t, "recuseForConflict")}
          >
            <CDFField
              id={`${id}-recuse-reason`}
              label={t("meetings.reasonLabel")}
              hint={t("meetings.reasonHint")}
            >
              <textarea
                id={`${id}-recuse-reason`}
                name="reason"
                className={textareaClass}
                aria-describedby={`${id}-recuse-reason-hint`}
                minLength={5}
                maxLength={2000}
                required
              />
            </CDFField>
          </CDFCommandForm>
        </details>
      ) : null}

      {cap.mayRecordNote ? (
        <details className="mt-3 border-t border-cdf-border pt-3" data-testid={`${id}-note`}>
          <summary className="cursor-pointer font-semibold">{t("meetings.noteTitle")}</summary>
          <div className="mt-3">
            <CDFCommandForm
              action={recordVoteNoteAction.bind(null, meetingId, v.voteItemId)}
              locale={t.locale}
              submitLabel={t("meetings.addNote")}
              submitName={t("meetings.addNoteName", { n })}
              variant="secondary"
              testId={`${id}-note-form`}
              successMessage={t("meetings.noted")}
              fieldLabels={{ note: t("meetings.noteLabel"), annexToMinutes: t("meetings.annexLabel") }}
              confirm={confirmation(t, "recordVoteNote")}
            >
              <CDFField id={`${id}-note-text`} label={t("meetings.noteLabel")} hint={t("meetings.noteHint")}>
                <textarea
                  id={`${id}-note-text`}
                  name="note"
                  className={textareaClass}
                  aria-describedby={`${id}-note-text-hint`}
                  minLength={10}
                  maxLength={4000}
                  required
                />
              </CDFField>
              <div className="mb-4">
                <div className="flex items-start gap-2">
                  <input
                    id={`${id}-note-annex`}
                    name="annexToMinutes"
                    type="checkbox"
                    className="mt-1 size-5"
                    aria-describedby={`${id}-note-annex-hint`}
                  />
                  <label htmlFor={`${id}-note-annex`} className="font-semibold">
                    {t("meetings.annexLabel")}
                  </label>
                </div>
                <p id={`${id}-note-annex-hint`} className="ms-7 text-sm text-cdf-text-secondary">
                  {t("meetings.annexHint")}
                </p>
              </div>
            </CDFCommandForm>
          </div>
        </details>
      ) : null}

      {v.recordVoteFor.length > 0 ? (
        <details className="mt-3 border-t border-cdf-border pt-3" data-testid={`${id}-record-for`}>
          <summary className="cursor-pointer font-semibold">{t("meetings.recordForTitle")}</summary>
          <div className="mt-3">
            <CDFCommandForm
              action={recordVoteForMemberAction.bind(null, meetingId, v.voteItemId)}
              locale={t.locale}
              submitLabel={t("meetings.recordFor")}
              submitName={t("meetings.recordForName", { n })}
              variant="secondary"
              testId={`${id}-record-for-form`}
              successMessage={t("meetings.recordedFor")}
              fieldLabels={{
                participantId: t("meetings.memberLabel"),
                choice: t("meetings.recordForChoiceLabel"),
                reason: t("meetings.reasonLabel"),
                originalEventAt: t("meetings.whenLabel"),
              }}
              confirm={confirmation(t, "recordVoteForMember")}
            >
              <CDFField id={`${id}-record-for-member`} label={t("meetings.memberLabel")}>
                <select
                  id={`${id}-record-for-member`}
                  name="participantId"
                  className={inputClass}
                  defaultValue=""
                  required
                >
                  <option value="" disabled>
                    {t("common.choose")}
                  </option>
                  {v.recordVoteFor.map((pid) => (
                    <option key={pid} value={pid}>
                      {name(pid)}
                    </option>
                  ))}
                </select>
              </CDFField>
              <ChoiceField
                t={t}
                id={`${id}-record-for-choice`}
                label={t("meetings.recordForChoiceLabel")}
                choices={RECORDED_FOR_MEMBER_CHOICES}
              />
              <CDFField
                id={`${id}-record-for-reason`}
                label={t("meetings.reasonLabel")}
                hint={t("meetings.reasonHint")}
              >
                <textarea
                  id={`${id}-record-for-reason`}
                  name="reason"
                  className={textareaClass}
                  aria-describedby={`${id}-record-for-reason-hint`}
                  minLength={5}
                  maxLength={2000}
                  required
                />
              </CDFField>
              <CDFField
                id={`${id}-record-for-when`}
                label={t("meetings.whenLabel")}
                hint={t("meetings.whenHint")}
                optionalLabel={t("common.optional")}
              >
                <input
                  id={`${id}-record-for-when`}
                  name="originalEventAt"
                  type="datetime-local"
                  dir="ltr"
                  className={inputClass}
                  aria-describedby={`${id}-record-for-when-hint`}
                />
              </CDFField>
            </CDFCommandForm>
          </div>
        </details>
      ) : null}

      {cap.mayClose ? (
        <div className="mt-3 border-t border-cdf-border pt-3" data-testid={`${id}-close`}>
          <h4 className="mb-2 font-semibold">{t("meetings.closeTitle")}</h4>
          <CDFCommandForm
            action={closeVoteItemAction.bind(null, meetingId, v.voteItemId)}
            locale={t.locale}
            submitLabel={t("meetings.closeVote")}
            submitName={t("meetings.closeVoteName", { n })}
            variant="danger"
            testId={`${id}-close-form`}
            successMessage={t("meetings.voteClosed")}
            fieldLabels={{ customQuorumAttested: t("meetings.attestLabel") }}
            confirm={confirmation(t, "closeVoteItem")}
          >
            {/* Under a CUSTOM quorum the secretary attests it; otherwise the command refuses an attestation. */}
            {customQuorum ? (
              <div className="mb-4">
                <div className="flex items-start gap-2">
                  <input
                    id={`${id}-attest`}
                    name="customQuorumAttested"
                    type="checkbox"
                    className="mt-1 size-5"
                    aria-describedby={`${id}-attest-hint`}
                    required
                  />
                  <label htmlFor={`${id}-attest`} className="font-semibold">
                    {t("meetings.attestLabel")}
                  </label>
                </div>
                <p id={`${id}-attest-hint`} className="ms-7 text-sm text-cdf-text-secondary">
                  {t("meetings.attestHint")}
                </p>
              </div>
            ) : null}
          </CDFCommandForm>
        </div>
      ) : null}
    </li>
  );
}

function ChoiceField({
  t,
  id,
  label,
  choices,
}: {
  t: Translator;
  id: string;
  label: string;
  choices: readonly string[];
}) {
  return (
    <CDFField id={id} label={label}>
      <select id={id} name="choice" className={inputClass} defaultValue="" required>
        <option value="" disabled>
          {t("common.choose")}
        </option>
        {choices.map((c) => (
          <option key={c} value={c}>
            {t(`meetings.choice.${c}` as MessageKey)}
          </option>
        ))}
      </select>
    </CDFField>
  );
}

function OptionalReason({ t, id }: { t: Translator; id: string }) {
  return (
    <CDFField
      id={id}
      label={t("meetings.reasonLabel")}
      hint={t("meetings.optionalReasonHint")}
      optionalLabel={t("common.optional")}
    >
      <textarea
        id={id}
        name="reason"
        className={textareaClass}
        aria-describedby={`${id}-hint`}
        maxLength={2000}
      />
    </CDFField>
  );
}
