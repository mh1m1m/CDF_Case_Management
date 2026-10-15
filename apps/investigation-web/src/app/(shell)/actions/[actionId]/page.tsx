// A corrective action «إجراء تصحيحي» (UX redesign Phase 12 P12-3b; ADR-058; DEC-AMB-014): a purpose route that reads
// api.corrective_action_view (A2). Whoever may see the action reads its card: the wording it carries now and every
// earlier one, its status, owner and due date, and nothing of the case. The case team also reads where it comes from
// and why it may not move, and their own list of the case's actions (A1) names its owner. While the decision it
// carries out is superseded, a corrective-action manager of the case records here what the replacement decision
// decides of it: one form for each disposition the command would accept now (A2's disposition_options and
// may_dispose, UX-116), each citing one of the replacement decision's own source documents; the command checks
// again. Anyone else, and an id that names nothing, gets the same 404, and the refusal is recorded (ACCESS_DENIED). A
// disposition's reason is never shown back (R3). The owner's own controls on their card come with P12-6.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  REWORDING_DISPOSITIONS,
  type ActionBlock,
  type ActionDisposition,
  type ActionOrigin,
  type ActionReplacement,
  type CaseCorrectiveAction,
  type CorrectiveActionView,
} from "@cdf/contracts";
import { formatDate, formatDateTime, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFAlert,
  CDFBreadcrumbs,
  CDFCard,
  CDFCommandForm,
  CDFDescriptionList,
  CDFField,
  CDFIdentifier,
  CDFPageHeader,
  CDFPurposeBanner,
  CDFStatusBadge,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { correctiveActionService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { actLabel, confirmation } from "../../confirmations";
import { accountName } from "../../legal-reviews/labels";
import {
  ACTION_CODES,
  DISPOSE_ACT,
  calendarDate,
  earlierVersions,
  governingKind,
  nameOf,
  ownerText,
} from "../labels";
import { disposeAction } from "./actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never the action's wording or a case number. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.correctiveAction") };
}

const UUID = /^[0-9a-f-]{36}$/i;

/** Blocks that still hold the action, which a reader should act on; the other two are final and only explain. */
const HOLDING: readonly ActionBlock[] = [
  "TAINTED_BY_CONFLICT",
  "CONFLICT_REMEDIATION_OPEN",
  "FROZEN_BY_SUPERSEDED_DECISION",
];

export default async function CorrectiveActionPage({ params }: { params: Promise<{ actionId: string }> }) {
  const { actionId } = await params;
  if (!UUID.test(actionId)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const service = correctiveActionService();
  const v = await service.view(ctx, actionId);
  if (!v) notFound();
  const o = v.origin;
  // The case team reads the case; their list of its actions names the owner and says when the decision was
  // superseded. Anyone else reads the card alone, and sees their own name where the action is theirs.
  const caseId = o ? v.case.caseId : null;
  const row: CaseCorrectiveAction | null = caseId
    ? ((await service.caseActions(ctx, caseId))?.find((r) => r.actionId === v.actionId) ?? null)
    : null;
  const ownerName = row
    ? nameOf(t, row.owner)
    : v.owner.accountableUserId === actor.userId
      ? nameOf(t, { displayName: actor.displayName, displayNameAr: actor.displayNameAr ?? null })
      : null;

  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={
          caseId && v.case.caseNumber
            ? [
                { label: t("shell.area.CASES"), href: "/cases" },
                { label: <CDFIdentifier>{v.case.caseNumber}</CDFIdentifier>, href: `/cases/${caseId}` },
                { label: t("caseWorkspace.tabs.proceedings"), href: `/cases/${caseId}/proceedings` },
                { label: t("correctiveActions.breadcrumb") },
              ]
            : [
                { label: t("shell.area.MY_WORK"), href: "/my-work" },
                { label: t("correctiveActions.breadcrumb") },
              ]
        }
      />
      <CDFPageHeader
        title={t("pageTitles.correctiveAction")}
        actions={
          <CDFStatusBadge domain="correctiveAction" status={v.status} testId="action-status">
            {t(`correctiveActions.status.${v.status}` as MessageKey)}
          </CDFStatusBadge>
        }
      />
      {o ? (
        <CDFPurposeBanner
          title={t("correctiveActions.purposeTitle")}
          purpose={t("correctiveActions.purposeBody")}
          notShown={t("correctiveActions.purposeNotShown")}
          testId="action-purpose-banner"
        />
      ) : (
        <CDFPurposeBanner
          title={t("correctiveActions.cardPurposeTitle")}
          purpose={t("correctiveActions.cardPurposeBody")}
          notShown={t("correctiveActions.cardPurposeNotShown")}
          testId="action-purpose-banner"
        />
      )}
      {o?.decisionBlock ? <BlockNotice t={t} block={o.decisionBlock} row={row} /> : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <ActionCard t={t} v={v} ownerName={ownerName} />
          {o ? <Origin t={t} o={o} row={row} /> : null}
          {o && o.dispositions.length > 0 ? <Dispositions t={t} o={o} /> : null}
        </div>
        {/* The case's action list links here (#dispose) for a manager who may record the disposition. */}
        <div id="dispose" className="min-w-0 scroll-mt-4">
          {o ? <Dispose t={t} v={v} o={o} caseId={caseId} /> : null}
        </div>
      </div>
    </>
  );
}

/** Why the action may not move, to the case team only: what holds it, or how the replacement decision ended it. */
function BlockNotice({
  t,
  block,
  row,
}: {
  t: Translator;
  block: ActionBlock;
  row: CaseCorrectiveAction | null;
}) {
  return (
    <div data-testid="action-block" data-block={block}>
      <CDFAlert
        tone={HOLDING.includes(block) ? "warning" : "info"}
        title={t(`correctiveActions.block.${block}` as MessageKey)}
      >
        <p>{t(`correctiveActions.blockBody.${block}` as MessageKey)}</p>
        {block === "FROZEN_BY_SUPERSEDED_DECISION" && row?.supersededAt ? (
          <p className="mt-1" data-testid="action-superseded-on">
            {t("correctiveActions.supersededOn", { date: isolate(formatDate(t.locale, row.supersededAt)) })}
          </p>
        ) : null}
      </CDFAlert>
    </div>
  );
}

/** The card every viewer of the action reads: its wording now and before, where it stands, who answers for it. */
function ActionCard({
  t,
  v,
  ownerName,
}: {
  t: Translator;
  v: CorrectiveActionView;
  ownerName: string | null;
}) {
  const earlier = earlierVersions(v);
  const terms = [
    {
      term: t("correctiveActions.descriptionLabel"),
      value: (
        <bdi dir="auto" data-testid="action-description">
          {v.description}
        </bdi>
      ),
    },
    {
      term: t("correctiveActions.typeLabel"),
      value: t(`correctiveActions.type.${v.actionType}` as MessageKey),
    },
    {
      term: t("correctiveActions.ownerLabel"),
      value: <span data-testid="action-owner">{ownerText(t, v.owner, ownerName)}</span>,
    },
    {
      term: t("correctiveActions.dueLabel"),
      value: <span data-testid="action-due">{calendarDate(t, v.dueDate)}</span>,
    },
    {
      term: t("correctiveActions.progressLabel"),
      value: t("correctiveActions.progress", { percent: v.percentComplete }),
    },
    { term: t("correctiveActions.createdLabel"), value: isolate(formatDate(t.locale, v.createdAt)) },
  ];
  if (v.versionNo > 1)
    terms.push({
      term: t("correctiveActions.versionLabel"),
      value: <span data-testid="action-version">{t("correctiveActions.version", { n: v.versionNo })}</span>,
    });
  return (
    <CDFCard title={t("correctiveActions.cardTitle")} testId="action-card">
      <p className="mb-3 text-lg font-semibold">
        <bdi dir="auto" data-testid="action-title">
          {v.title}
        </bdi>
      </p>
      <CDFDescriptionList items={terms} />
      {earlier.length > 0 ? (
        <section className="mt-4 border-t border-cdf-border pt-3" aria-labelledby="action-earlier-title">
          <h3 id="action-earlier-title" className="mb-2 font-semibold">
            {t("correctiveActions.earlierTitle")}
          </h3>
          <ol className="grid gap-3" data-testid="action-earlier">
            {earlier.map((x) => (
              <li key={x.versionNo} data-testid={`action-version-${x.versionNo}`}>
                <p className="text-sm text-cdf-text-secondary">
                  {t("correctiveActions.versionRecorded", {
                    n: x.versionNo,
                    date: isolate(formatDateTime(t.locale, x.recordedAt)),
                  })}
                </p>
                <p className="font-semibold">
                  <bdi dir="auto">{x.title}</bdi>
                </p>
                <p className="whitespace-pre-wrap break-words">
                  <bdi dir="auto">{x.description}</bdi>
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </CDFCard>
  );
}

/** Where the action comes from and the decision it carries out now, with the actions it replaced or that replaced it. */
function Origin({ t, o, row }: { t: Translator; o: ActionOrigin; row: CaseCorrectiveAction | null }) {
  const links: { href: string; label: string; testId: string }[] = [];
  if (row?.replacesActionId)
    links.push({
      href: `/actions/${row.replacesActionId}`,
      label: t("correctiveActions.replacesLink"),
      testId: "action-replaces",
    });
  if (row?.replacedByActionId)
    links.push({
      href: `/actions/${row.replacedByActionId}`,
      label: t("correctiveActions.replacedByLink"),
      testId: "action-replaced-by",
    });
  return (
    <CDFCard title={t("correctiveActions.originTitle")} testId="action-origin">
      <CDFDescriptionList
        items={[
          {
            term: t("correctiveActions.sourceLabel"),
            value: t(`correctiveActions.source.${o.source}` as MessageKey),
          },
          {
            term: t("correctiveActions.governingLabel"),
            value: (
              <span data-testid="action-governing">
                {t(`correctiveActions.governing.${governingKind(o)}` as MessageKey)}
              </span>
            ),
          },
        ]}
      />
      {links.length > 0 ? (
        <ul className="mt-3 grid gap-1">
          {links.map((l) => (
            <li key={l.testId}>
              <Link href={l.href} className="underline underline-offset-4" data-testid={l.testId}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </CDFCard>
  );
}

/** What each replacement decision decided of the action, as recorded; never the reason given (R3). */
function Dispositions({ t, o }: { t: Translator; o: ActionOrigin }) {
  return (
    <CDFCard title={t("correctiveActions.dispositionsTitle")} testId="action-dispositions">
      <ol className="grid gap-4">
        {o.dispositions.map((d, k) => {
          const terms = [
            {
              term: t("correctiveActions.citedLabel"),
              value: <bdi dir="auto">{d.sourceDocumentReference}</bdi>,
            },
            {
              term: t("correctiveActions.priorStatusLabel"),
              value: t(`correctiveActions.status.${d.priorStatus}` as MessageKey),
            },
          ];
          if (d.revisedVersionNo !== null)
            terms.push({
              term: t("correctiveActions.versionLabel"),
              value: t("correctiveActions.revisedVersion", { n: d.revisedVersionNo }),
            });
          return (
            <li
              key={d.dispositionId}
              className="border-b border-cdf-border pb-4 last:border-0 last:pb-0"
              data-testid={`action-disposition-${k + 1}`}
              data-disposition={d.disposition}
            >
              <h3 className="mb-2 font-semibold">
                {t("correctiveActions.dispositionName", {
                  disposition: t(`correctiveActions.disposition.${d.disposition}` as MessageKey),
                  date: isolate(formatDateTime(t.locale, d.recordedAt)),
                })}
              </h3>
              <CDFDescriptionList items={terms} />
              {d.replacementActionId ? (
                <p className="mt-2">
                  <Link
                    href={`/actions/${d.replacementActionId}`}
                    className="font-semibold underline underline-offset-4"
                    data-testid={`action-disposition-${k + 1}-new-action`}
                  >
                    {t("correctiveActions.newActionLink")}
                  </Link>
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </CDFCard>
  );
}

/**
 * The replacement decision's disposition, for a corrective-action manager of the case while the action is frozen: one
 * form for each disposition A2 offers (the command's own checks, in its order). A replacement needs an owner the
 * caller may name: on a restricted case only its authority names one, so for anyone else the option says why it
 * cannot be taken from their account instead of offering a form the command would refuse.
 */
function Dispose({
  t,
  v,
  o,
  caseId,
}: {
  t: Translator;
  v: CorrectiveActionView;
  o: ActionOrigin;
  caseId: string | null;
}) {
  const r = o.replacement;
  if (!v.capabilities.mayDispose || !r || o.dispositionOptions.length === 0)
    return o.decisionBlock === "FROZEN_BY_SUPERSEDED_DECISION" ? (
      <CDFAlert tone="info" title={t("correctiveActions.disposeTitle")} testId="action-dispose-not-yours">
        <p>{t("correctiveActions.managerOnly")}</p>
      </CDFAlert>
    ) : null;
  const options = o.dispositionOptions;
  return (
    <CDFCard title={t("correctiveActions.disposeTitle")} testId="action-dispose">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("correctiveActions.disposeIntro")}</p>
      {options.length === 1 && options[0] === "WAIVE" ? (
        <p className="mb-3 text-sm" data-testid="action-dispose-only-waive">
          {t("correctiveActions.onlyWaive")}
        </p>
      ) : null}
      {options.map((d) => (
        <details
          key={d}
          className="border-t border-cdf-border pt-3 pb-3"
          data-testid={`dispose-${d}`}
          open={options.length === 1}
        >
          <summary className="cursor-pointer font-semibold">
            {t(`correctiveActions.disposition.${d}` as MessageKey)}
          </summary>
          <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">
            {t(`correctiveActions.dispositionHint.${d}` as MessageKey)}
          </p>
          {d === "REPLACE_WITH_NEW_ACTION" && !r.mayNameOwner ? (
            <p className="text-sm" data-testid="dispose-replace-authority">
              {t("correctiveActions.replaceNeedsAuthority")}
            </p>
          ) : d === "REPLACE_WITH_NEW_ACTION" && r.ownerCandidates.length === 0 ? (
            <p className="text-sm" data-testid="dispose-replace-no-owners">
              {t("correctiveActions.noOwners")}
            </p>
          ) : (
            <DisposeForm t={t} v={v} r={r} d={d} caseId={caseId} />
          )}
        </details>
      ))}
    </CDFCard>
  );
}

function DisposeForm({
  t,
  v,
  r,
  d,
  caseId,
}: {
  t: Translator;
  v: CorrectiveActionView;
  r: ActionReplacement;
  d: ActionDisposition;
  caseId: string | null;
}) {
  const id = `dispose-${d}`;
  const act = DISPOSE_ACT[d];
  const rewords = REWORDING_DISPOSITIONS.includes(d);
  const replaces = d === "REPLACE_WITH_NEW_ACTION";
  // MODIFY keeps the action's own due date without one; a replacement takes the policy's default, or needs one.
  const dueHint = replaces
    ? r.defaultDueDate
      ? t("correctiveActions.replaceDueHint", { date: calendarDate(t, r.defaultDueDate) })
      : t("correctiveActions.replaceDueRequired")
    : t("correctiveActions.modifyDueHint", { date: calendarDate(t, v.dueDate) });
  const dueRequired = replaces && !r.defaultDueDate;
  return (
    <CDFCommandForm
      action={disposeAction.bind(null, v.actionId, caseId)}
      locale={t.locale}
      submitLabel={actLabel(t, act)}
      variant={d === "WAIVE" || replaces ? "danger" : "primary"}
      testId={`${id}-form`}
      successMessage={t("correctiveActions.disposed")}
      codeSections={ACTION_CODES}
      fieldLabels={{
        disposition: t("correctiveActions.disposeTitle"),
        sourceDocumentReference: t("correctiveActions.documentLabel"),
        reason: t("correctiveActions.reasonLabel"),
        title: t("correctiveActions.newTitleLabel"),
        description: t("correctiveActions.newDescriptionLabel"),
        ownerId: t("correctiveActions.newOwnerLabel"),
        dueDate: t("correctiveActions.dueDateLabel"),
      }}
      confirm={confirmation(t, act)}
    >
      <input type="hidden" name="disposition" value={d} />
      <CDFField
        id={`${id}-document`}
        label={t("correctiveActions.documentLabel")}
        hint={t("correctiveActions.documentHint")}
        requiredLabel={t("common.required")}
      >
        <select
          id={`${id}-document`}
          name="sourceDocumentReference"
          className={inputClass}
          required
          defaultValue={r.sources.length === 1 ? r.sources[0]!.reference : ""}
          aria-describedby={`${id}-document-hint`}
          data-testid={`${id}-document`}
        >
          <option value="" disabled>
            {t("common.choose")}
          </option>
          {r.sources.map((s) => (
            <option key={s.position} value={s.reference}>
              {s.isPrimary ? t("correctiveActions.primaryDocument", { reference: s.reference }) : s.reference}
            </option>
          ))}
        </select>
      </CDFField>
      {rewords ? (
        <>
          <CDFField
            id={`${id}-title`}
            label={t("correctiveActions.newTitleLabel")}
            hint={t("correctiveActions.newTitleHint")}
            requiredLabel={t("common.required")}
          >
            <input
              id={`${id}-title`}
              name="title"
              className={inputClass}
              required
              minLength={5}
              maxLength={200}
              defaultValue={d === "MODIFY" ? v.title : undefined}
              aria-describedby={`${id}-title-hint`}
              data-testid={`${id}-title`}
            />
          </CDFField>
          <CDFField
            id={`${id}-description`}
            label={t("correctiveActions.newDescriptionLabel")}
            hint={t("correctiveActions.newDescriptionHint")}
            requiredLabel={t("common.required")}
          >
            <textarea
              id={`${id}-description`}
              name="description"
              className={textareaClass}
              required
              minLength={10}
              maxLength={4000}
              defaultValue={d === "MODIFY" ? v.description : undefined}
              aria-describedby={`${id}-description-hint`}
              data-testid={`${id}-description`}
            />
          </CDFField>
        </>
      ) : null}
      {replaces ? (
        <CDFField
          id={`${id}-owner`}
          label={t("correctiveActions.newOwnerLabel")}
          hint={t("correctiveActions.newOwnerHint")}
          requiredLabel={t("common.required")}
        >
          <select
            id={`${id}-owner`}
            name="ownerId"
            className={inputClass}
            required
            defaultValue=""
            aria-describedby={`${id}-owner-hint`}
            data-testid={`${id}-owner`}
          >
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {r.ownerCandidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {accountName(t, c)}
              </option>
            ))}
          </select>
        </CDFField>
      ) : null}
      {rewords ? (
        <CDFField
          id={`${id}-due`}
          label={t("correctiveActions.dueDateLabel")}
          hint={dueHint}
          {...(dueRequired
            ? { requiredLabel: t("common.required") }
            : { optionalLabel: t("common.optional") })}
        >
          <input
            id={`${id}-due`}
            name="dueDate"
            type="date"
            className={inputClass}
            dir="ltr"
            required={dueRequired}
            aria-describedby={`${id}-due-hint`}
            data-testid={`${id}-due`}
          />
        </CDFField>
      ) : null}
      <CDFField
        id={`${id}-reason`}
        label={t("correctiveActions.reasonLabel")}
        hint={t("correctiveActions.reasonHint")}
        requiredLabel={t("common.required")}
      >
        <textarea
          id={`${id}-reason`}
          name="reason"
          className={textareaClass}
          required
          minLength={5}
          maxLength={2000}
          aria-describedby={`${id}-reason-hint`}
          data-testid={`${id}-reason`}
        />
      </CDFField>
    </CDFCommandForm>
  );
}
