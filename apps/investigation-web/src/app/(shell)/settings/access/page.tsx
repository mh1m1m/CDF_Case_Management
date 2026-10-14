// My access «صلاحياتي» (UX redesign S1, RC-12; CDF-172; DEC-10: everyone sees their own basis). Why the caller
// can see what they see, and until when. Only the caller's own rows; case numbers only where the caller may
// see the case's metadata; nothing from the identity vault.
import type { Metadata } from "next";
import Link from "next/link";
import type { MyAccessEntry } from "@cdf/contracts";
import type { MessageKey, Translator } from "@cdf/i18n";
import { CDFDateTime, CDFIdentifier, CDFPageHeader, CDFTable } from "@cdf/ui";
import { investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { formAccessLabel } from "../../access-labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("myAccess.title") };
}

function what(t: Translator, r: MyAccessEntry): string {
  switch (r.basis) {
    case "CLEARANCE":
      return t.code("classification", r.code);
    case "ROLE":
      return t.code("role", r.code);
    case "ASSIGNMENT":
      return t.code("assignmentRole", r.code);
    case "GRANT":
      return t.code("myAccess.grantScope", r.code);
    case "FORM_ACCESS":
      return formAccessLabel(t, r.code);
    case "TASK":
      return t.code("records.taskTypeName", r.code, "records.taskType");
    case "BREAK_GLASS":
      return t.code("myAccess.breakGlassStatus", r.code);
  }
}

export default async function MyAccessPage() {
  const { ctx } = await requireActor();
  const t = await getTranslator();
  const rows = await investigationService().myAccess(ctx);
  return (
    <>
      <CDFPageHeader title={t("myAccess.title")} intro={t("myAccess.intro")} />
      <CDFTable
        caption={t("myAccess.tableLabel")}
        testId="my-access-table"
        rows={rows}
        rowKey={(r) => `${r.basis}:${r.code}:${r.caseId ?? ""}:${r.targetId ?? ""}:${r.sinceAt ?? ""}`}
        empty={t("myAccess.intro")}
        columns={[
          { header: t("myAccess.columns.basis"), cell: (r) => t(`myAccess.basis.${r.basis}` as MessageKey) },
          {
            header: t("myAccess.columns.what"),
            // A kept form leads to its own page (S3, ADR-016 D2): the case is not named, so the form tells it apart.
            cell: (r) =>
              r.basis === "FORM_ACCESS" && r.targetId ? (
                <Link
                  href={`/my-work/forms/${r.targetId}`}
                  className="underline underline-offset-4"
                  data-testid={`my-access-form-${r.targetId}`}
                >
                  {what(t, r)}
                </Link>
              ) : (
                what(t, r)
              ),
          },
          {
            header: t("myAccess.columns.case"),
            cell: (r) => (r.caseNumber ? <CDFIdentifier>{r.caseNumber}</CDFIdentifier> : null),
          },
          {
            header: t("myAccess.columns.since"),
            cell: (r) => (r.sinceAt ? <CDFDateTime value={r.sinceAt} locale={t.locale} dateOnly /> : null),
          },
          {
            header: t("myAccess.columns.until"),
            cell: (r) =>
              r.basis === "CLEARANCE" ? null : r.untilAt ? (
                <CDFDateTime value={r.untilAt} locale={t.locale} />
              ) : (
                t("myAccess.noEnd")
              ),
          },
        ]}
      />
    </>
  );
}
