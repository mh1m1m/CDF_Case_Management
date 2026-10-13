// One form instance on its case (Phase 8; ADR-011). api.open_form_instance audits FORM_VIEWED or a SECURITY
// denial; invisible and missing instances are alike, and so is a form whose case the caller cannot open (it has the
// purpose view under My Work instead, S3).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { FormInstanceView } from "../form-instance-view";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or case content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.formInstance") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function FormInstancePage({
  params,
}: {
  params: Promise<{ id: string; instanceId: string }>;
}) {
  const { id, instanceId } = await params;
  if (!UUID.test(id) || !UUID.test(instanceId)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const f = await formsService().getInstance(ctx, instanceId);
  if (!f || f.caseId !== id) notFound();
  return <FormInstanceView f={f} t={t} userId={actor.userId} />;
}
