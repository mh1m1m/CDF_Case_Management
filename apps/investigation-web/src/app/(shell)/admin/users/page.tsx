// Administration «إدارة المنصة» › Users, read only (UX redesign S1, RC-12; CDF-172). Directory columns and
// active roles; never case content or a count derived from cases (§21, G14). Changes arrive with dual control
// (DEC-12); until then users and roles change through migrations only. The other Administration pages this caller's
// permissions open are listed above the register (P12-8a).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminViews } from "@cdf/authorization";
import type { MessageKey } from "@cdf/i18n";
import { CDFTable } from "@cdf/ui";
import { investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { AdminFrame } from "../admin-frame";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("admin.usersTitle") };
}

export default async function AdminUsersPage() {
  const { actor, ctx } = await requireActor();
  if (!adminViews(actor).includes("users")) notFound();
  const t = await getTranslator();
  const users = await investigationService().userRegister(ctx, actor);
  return (
    <AdminFrame t={t} actor={actor} view="users" intro={t("admin.usersIntro")}>
      <CDFTable
        caption={t("admin.tableLabel")}
        testId="user-register"
        rows={users}
        rowKey={(u) => u.id}
        empty={t("admin.noRoles")}
        columns={[
          {
            header: t("admin.columns.name"),
            cell: (u) => <bdi>{t.locale === "ar" ? u.displayNameAr : u.displayName}</bdi>,
          },
          { header: t("admin.columns.email"), cell: (u) => <bdi dir="ltr">{u.email}</bdi> },
          {
            header: t("admin.columns.department"),
            cell: (u) => (u.department ? <bdi>{u.department}</bdi> : null),
          },
          { header: t("admin.columns.status"), cell: (u) => t(`admin.status.${u.status}` as MessageKey) },
          {
            header: t("admin.columns.roles"),
            cell: (u) =>
              u.roles.length
                ? u.roles.map((r) => t.code("role", r)).join(t.locale === "ar" ? "، " : ", ")
                : t("admin.noRoles"),
          },
        ]}
      />
    </AdminFrame>
  );
}
