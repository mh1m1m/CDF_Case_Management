// Inviting someone to a committee meeting (UX redesign Phase 12 P12-2c; ADR-056; AMB-156, AMB-158): a page of its own
// for whoever runs the meeting, so that the meeting's page, which re-renders while the meeting runs, never reads the
// candidates. Only when api.meeting_view says the caller may invite does the page read api.meeting_invite_choices,
// which records the read with counts. The candidates are never a directory: the case team's active assignments and
// the legal reviewers of this proceeding's packages, as accounts, and the case's people, as persons (the secretary's
// path, ADR-054 §5), each with the roles api.invite_to_meeting would accept for them now. Anyone who may not invite
// gets the same 404 as a meeting that does not exist; the command checks everything again.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { InviteAccountChoice, InvitePersonChoice, MeetingInviteeRole } from "@cdf/contracts";
import { formatList, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFBreadcrumbs,
  CDFCard,
  CDFCommandForm,
  CDFField,
  CDFPageHeader,
  CDFPurposeBanner,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { committeesService, meetingsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { actLabel, confirmation } from "../../../confirmations";
import { inviteToMeetingAction } from "../actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or meeting content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.meetingInvite") };
}

const UUID = /^[0-9a-f-]{36}$/i;
const CODES = ["committeeProceedings.codes", "codes"] as const;

export default async function MeetingInvitePage({ params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await params;
  if (!UUID.test(meetingId)) notFound();
  const { ctx } = await requireActor();
  const t = await getTranslator();
  const m = await meetingsService().meeting(ctx, meetingId);
  if (!m || m.view !== "FULL" || !m.capabilities.mayInvite) notFound();
  const [choices, seats] = await Promise.all([
    meetingsService().inviteChoices(ctx, meetingId),
    committeesService().myCommittees(ctx),
  ]);
  if (!choices) notFound();

  const n = m.logistics.sequenceNo;
  const committee = t.code("committeeName", m.committee.code, "common.none");
  const seated = seats.some((c) => c.committeeId === m.committee.committeeId);
  const meetingHref = `/meetings/${meetingId}`;
  const count = choices.accounts.length + choices.persons.length;
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
          { label: t("committeeProceedings.inviteBreadcrumb") },
        ]}
      />
      <CDFPageHeader title={t("committeeProceedings.inviteTitle", { committee, n })} />
      <CDFPurposeBanner
        title={t("committeeProceedings.invitePurposeTitle")}
        purpose={t("committeeProceedings.invitePurposeBody")}
        notShown={t("committeeProceedings.invitePurposeNotShown")}
        testId="invite-purpose-banner"
      />
      {count === 0 ? (
        <p className="mb-6 text-cdf-text-secondary" data-testid="invite-none">
          {t("committeeProceedings.inviteNone")}
        </p>
      ) : null}
      {choices.accounts.length > 0 ? (
        <CDFCard title={t("committeeProceedings.inviteAccountsTitle")} testId="invite-accounts">
          <p className="mb-3 text-sm text-cdf-text-secondary">
            {t("committeeProceedings.inviteAccountsIntro")}
          </p>
          <ul className="grid gap-4">
            {choices.accounts.map((a, k) => (
              <AccountCandidate key={a.userId} t={t} meetingId={meetingId} a={a} k={k} />
            ))}
          </ul>
        </CDFCard>
      ) : null}
      {choices.persons.length > 0 ? (
        <CDFCard title={t("committeeProceedings.invitePersonsTitle")} testId="invite-persons">
          <p className="mb-3 text-sm text-cdf-text-secondary">
            {t("committeeProceedings.invitePersonsIntro")}
          </p>
          <ul className="grid gap-4">
            {choices.persons.map((p, k) => (
              <PersonCandidate key={p.personId} t={t} meetingId={meetingId} p={p} k={k} />
            ))}
          </ul>
        </CDFCard>
      ) : null}
    </>
  );
}

const accountName = (t: Translator, a: InviteAccountChoice) =>
  (t.locale === "ar" ? (a.displayNameAr ?? a.displayName) : (a.displayName ?? a.displayNameAr)) ??
  t("committeeProceedings.anAccount");

const personName = (t: Translator, p: InvitePersonChoice) =>
  p.label ?? t("committeeProceedings.personOrdinal", { n: p.position });

function AccountCandidate({
  t,
  meetingId,
  a,
  k,
}: {
  t: Translator;
  meetingId: string;
  a: InviteAccountChoice;
  k: number;
}) {
  const id = `invite-account-${k}`;
  const name = accountName(t, a);
  return (
    <li className="border-b border-cdf-border pb-4 last:border-0 last:pb-0" data-testid={id}>
      <h3 className="font-semibold">
        <bdi>{name}</bdi>
      </h3>
      <p className="mb-2 text-sm text-cdf-text-secondary">
        {formatList(
          t.locale,
          a.bases.map((b) => t(`committeeProceedings.inviteBasis.${b}` as MessageKey)),
        )}
      </p>
      <InviteForm
        t={t}
        id={id}
        meetingId={meetingId}
        invitee={`account:${a.userId}`}
        name={name}
        roles={a.inviteeRoles}
      />
    </li>
  );
}

function PersonCandidate({
  t,
  meetingId,
  p,
  k,
}: {
  t: Translator;
  meetingId: string;
  p: InvitePersonChoice;
  k: number;
}) {
  const id = `invite-person-${k}`;
  const name = personName(t, p);
  return (
    <li className="border-b border-cdf-border pb-4 last:border-0 last:pb-0" data-testid={id}>
      <h3 className="font-semibold">
        <bdi>{name}</bdi>
      </h3>
      {p.caseRoles.length > 0 ? (
        <p className="mb-2 text-sm text-cdf-text-secondary">
          {formatList(
            t.locale,
            p.caseRoles.map((r) => t(`committeeProceedings.casePersonRole.${r}` as MessageKey)),
          )}
        </p>
      ) : null}
      <InviteForm
        t={t}
        id={id}
        meetingId={meetingId}
        invitee={`person:${p.personId}`}
        name={name}
        roles={p.inviteeRoles}
      />
    </li>
  );
}

/** The roles the command would accept for this candidate now; none, and the candidate is listed without a form. */
function InviteForm({
  t,
  id,
  meetingId,
  invitee,
  name,
  roles,
}: {
  t: Translator;
  id: string;
  meetingId: string;
  invitee: string;
  name: string;
  roles: readonly MeetingInviteeRole[];
}) {
  if (roles.length === 0)
    return (
      <p className="text-sm text-cdf-text-secondary" data-testid={`${id}-no-roles`}>
        {t("committeeProceedings.inviteNoRoles")}
      </p>
    );
  return (
    <details data-testid={`${id}-invite`}>
      <summary className="cursor-pointer font-semibold">{t("committeeProceedings.inviteSummary")}</summary>
      <div className="mt-3">
        <CDFCommandForm
          action={inviteToMeetingAction.bind(null, meetingId, invitee)}
          locale={t.locale}
          submitLabel={actLabel(t, "inviteToMeeting")}
          submitName={t("committeeProceedings.inviteName", { name: isolate(name) })}
          variant="primary"
          testId={`${id}-form`}
          successMessage={t("committeeProceedings.invited")}
          codeSections={CODES}
          fieldLabels={{
            inviteeRole: t("committeeProceedings.inviteRoleLabel"),
            requiresCoi: t("committeeProceedings.requiresCoiLabel"),
            reason: t("meetings.reasonLabel"),
          }}
          confirm={confirmation(t, "inviteToMeeting")}
        >
          <CDFField id={`${id}-role`} label={t("committeeProceedings.inviteRoleLabel")}>
            <select
              id={`${id}-role`}
              name="inviteeRole"
              className={inputClass}
              defaultValue={roles.length === 1 ? roles[0] : ""}
              required
              data-testid={`${id}-role`}
            >
              {roles.length === 1 ? null : (
                <option value="" disabled>
                  {t("common.choose")}
                </option>
              )}
              {roles.map((r) => (
                <option key={r} value={r}>
                  {t(`meetings.inviteeRole.${r}` as MessageKey)}
                </option>
              ))}
            </select>
          </CDFField>
          <div className="mb-4">
            <div className="flex items-start gap-2">
              <input
                id={`${id}-coi`}
                name="requiresCoi"
                type="checkbox"
                className="mt-1 size-5"
                defaultChecked
                aria-describedby={`${id}-coi-hint`}
                data-testid={`${id}-coi`}
              />
              <label htmlFor={`${id}-coi`} className="font-semibold">
                {t("committeeProceedings.requiresCoiLabel")}
              </label>
            </div>
            <p id={`${id}-coi-hint`} className="ms-7 text-sm text-cdf-text-secondary">
              {t("committeeProceedings.requiresCoiHint")}
            </p>
          </div>
          <CDFField
            id={`${id}-reason`}
            label={t("meetings.reasonLabel")}
            hint={t("committeeProceedings.inviteReasonHint")}
          >
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
        </CDFCommandForm>
      </div>
    </details>
  );
}
