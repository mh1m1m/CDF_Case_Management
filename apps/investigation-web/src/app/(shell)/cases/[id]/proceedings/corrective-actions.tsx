// The case's corrective actions, on the Proceedings tab (UX redesign Phase 12 P12-3b; ADR-058): A1 as the case team
// reads it, with why each action may not move (DEC-AMB-013's holds, DEC-AMB-014's freeze and the two ways a
// replacement decision ends an action) and when its decision was superseded. Codes, ids, dates and the owner's name
// only: no disposition's reason (R3). Each action opens on its own page (/actions/[actionId]), where a
// corrective-action manager records a frozen action's disposition; the link to do that shows only where A1 says the
// command would accept the caller now (may_dispose), and the page and the command check again.
import Link from "next/link";
import type { CaseCorrectiveAction } from "@cdf/contracts";
import { formatDate, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFBadge, CDFCard, CDFStatusBadge } from "@cdf/ui";
import { correctiveActionService, type RequestScope } from "@/server/container";
import { calendarDate, nameOf, ownerText } from "../../../actions/labels";

export async function CaseCorrectiveActions({
  t,
  ctx,
  caseId,
}: {
  t: Translator;
  ctx: RequestScope["ctx"];
  caseId: string;
}) {
  const rows = await correctiveActionService().caseActions(ctx, caseId);
  if (!rows || rows.length === 0) return null;
  return (
    <CDFCard title={t("correctiveActions.caseTitle")} testId="case-corrective-actions">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("correctiveActions.caseIntro")}</p>
      <ul className="grid gap-4">
        {rows.map((a) => (
          <ActionRow key={a.actionId} t={t} a={a} />
        ))}
      </ul>
    </CDFCard>
  );
}

function ActionRow({ t, a }: { t: Translator; a: CaseCorrectiveAction }) {
  const id = `case-action-${a.sequenceNo}`;
  return (
    <li
      className="border-b border-cdf-border pb-4 last:border-0 last:pb-0"
      data-testid={id}
      data-block={a.decisionBlock ?? ""}
    >
      <h3 className="flex flex-wrap items-center gap-2 font-semibold">
        <Link
          href={`/actions/${a.actionId}`}
          className="underline underline-offset-4"
          data-testid={`${id}-link`}
        >
          <bdi dir="auto">{a.title}</bdi>
        </Link>
        <CDFStatusBadge domain="correctiveAction" status={a.status} testId={`${id}-status`}>
          {t(`correctiveActions.status.${a.status}` as MessageKey)}
        </CDFStatusBadge>
        {a.decisionBlock ? (
          <CDFBadge
            tone={a.decisionBlock === "FROZEN_BY_SUPERSEDED_DECISION" ? "warning" : "neutral"}
            testId={`${id}-block`}
          >
            {t(`correctiveActions.block.${a.decisionBlock}` as MessageKey)}
          </CDFBadge>
        ) : null}
      </h3>
      <ul className="mt-1 grid gap-0.5 text-sm text-cdf-text-secondary">
        <li>
          {t("correctiveActions.ownerLabel")}: {ownerText(t, a.owner, nameOf(t, a.owner))}
        </li>
        <li>
          {t("correctiveActions.dueLabel")}: {calendarDate(t, a.dueDate)}
          {" · "}
          {t("correctiveActions.progressLabel")}:{" "}
          {t("correctiveActions.progress", { percent: a.percentComplete })}
        </li>
        <li>
          {t("correctiveActions.sourceLabel")}: {t(`correctiveActions.source.${a.source}` as MessageKey)}
        </li>
        {a.decisionBlock === "FROZEN_BY_SUPERSEDED_DECISION" && a.supersededAt ? (
          <li data-testid={`${id}-superseded-on`}>
            {t("correctiveActions.supersededOn", { date: isolate(formatDate(t.locale, a.supersededAt)) })}
          </li>
        ) : null}
      </ul>
      {a.mayDispose || a.replacedByActionId || a.replacesActionId ? (
        <ul className="mt-2 grid gap-1">
          {a.mayDispose ? (
            <li>
              <Link
                href={`/actions/${a.actionId}#dispose`}
                className="font-semibold underline underline-offset-4"
                data-testid={`${id}-dispose`}
              >
                {t("correctiveActions.disposeLink")}
              </Link>
            </li>
          ) : null}
          {a.replacedByActionId ? (
            <li>
              <Link
                href={`/actions/${a.replacedByActionId}`}
                className="underline underline-offset-4"
                data-testid={`${id}-replaced-by`}
              >
                {t("correctiveActions.replacedByLink")}
              </Link>
            </li>
          ) : null}
          {a.replacesActionId ? (
            <li>
              <Link
                href={`/actions/${a.replacesActionId}`}
                className="underline underline-offset-4"
                data-testid={`${id}-replaces`}
              >
                {t("correctiveActions.replacesLink")}
              </Link>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
