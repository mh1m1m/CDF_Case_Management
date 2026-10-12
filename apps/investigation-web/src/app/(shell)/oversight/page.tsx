// Oversight «الرقابة», read only (UX redesign S1, RC-12; CDF-171). The audit ledger for AUDIT_VIEW and security
// events for SECURITY_EVENT_VIEW, as metadata only: no reason, details, object id or case id (DEC-11), and no
// case content (§21). The database's audit_event_read policy decides every row.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@cdf/authorization";
import type { OversightView } from "@cdf/contracts";
import type { MessageKey } from "@cdf/i18n";
import { LEDGER_PAGE } from "@cdf/application";
import { CDFAlert, CDFDateTime, CDFIdentifier, CDFPageHeader, CDFTable, CDFViewTabs } from "@cdf/ui";
import { investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("oversight.title") };
}

export default async function OversightPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { actor, ctx } = await requireActor();
  const views = (
    [
      ["ledger", can(actor, "AUDIT_VIEW")],
      ["security-events", can(actor, "SECURITY_EVENT_VIEW")],
    ] as const
  )
    .filter(([, ok]) => ok)
    .map(([v]) => v as OversightView);
  if (views.length === 0) notFound();
  const raw = (await searchParams).view;
  const view = views.find((v) => v === raw) ?? views[0]!;
  const t = await getTranslator();
  const service = investigationService();
  const [rows, breaks] = await Promise.all([
    service.auditLedger(ctx, actor, view),
    service.auditChainBreaks(ctx, actor),
  ]);

  return (
    <>
      <CDFPageHeader title={t("oversight.title")} intro={t("oversight.ledgerIntro")} />
      <p
        className="mb-4 rounded-cdf-md border border-cdf-border bg-cdf-surface-subtle px-3 py-2 text-sm"
        data-testid="no-case-content"
      >
        {t("shell.noCaseContent")}
      </p>
      {views.length > 1 ? (
        <CDFViewTabs
          label={t("oversight.views")}
          current={view}
          items={views.map((v) => ({
            key: v,
            href: `/oversight?view=${v}`,
            label: t(`oversight.view.${v}` as MessageKey),
          }))}
        />
      ) : null}
      {breaks === 0 ? (
        <CDFAlert tone="success">{t("oversight.chainOk")}</CDFAlert>
      ) : breaks !== null ? (
        <CDFAlert tone="danger">{t("oversight.chainBroken", { ref: ctx.requestId })}</CDFAlert>
      ) : null}
      <p className="my-3 text-sm text-cdf-text-secondary">{t("oversight.latest", { count: LEDGER_PAGE })}</p>
      <CDFTable
        caption={t(`oversight.view.${view}` as MessageKey)}
        testId="ledger-table"
        rows={rows}
        rowKey={(r) => String(r.seq)}
        empty={t("oversight.empty")}
        columns={[
          { header: t("oversight.columns.seq"), cell: (r) => <CDFIdentifier>{r.seq}</CDFIdentifier> },
          {
            header: t("oversight.columns.time"),
            cell: (r) => <CDFDateTime value={r.occurredAt} locale={t.locale} />,
          },
          {
            header: t("oversight.columns.action"),
            cell: (r) => t.code("auditAction", r.action, "oversight.columns.action"),
          },
          {
            header: t("oversight.columns.category"),
            cell: (r) => t(`oversight.category.${r.category}` as MessageKey),
          },
          {
            header: t("oversight.columns.actor"),
            cell: (r) =>
              r.actorRoles.length
                ? r.actorRoles.map((role) => t.code("role", role)).join(t.locale === "ar" ? "، " : ", ")
                : t("oversight.actorSystem"),
          },
          {
            header: t("oversight.columns.object"),
            cell: (r) => (r.objectType ? <CDFIdentifier>{r.objectType}</CDFIdentifier> : null),
          },
          {
            header: t("oversight.columns.outcome"),
            cell: (r) => t.code("oversight.outcome", r.outcome, "oversight.columns.outcome"),
          },
        ]}
      />
    </>
  );
}
