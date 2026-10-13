// The purpose view of one form (UX redesign S3; ADR-016 D2, interim path (a)): a form kept for the caller's part of
// the work when committee and review grants stopped opening cases. It shows the form and the steps the database
// allows on it, under My Work, and never the case. api.open_form_instance audits FORM_VIEWED or a SECURITY denial;
// invisible and missing forms are alike. A caller who can open the case is sent to the form on its case.
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { formsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { FormInstanceView } from "../../../cases/[id]/forms/form-instance-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.formInstance") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function PurposeFormPage({ params }: { params: Promise<{ instanceId: string }> }) {
  const { instanceId } = await params;
  if (!UUID.test(instanceId)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const f = await formsService().getInstance(ctx, instanceId);
  if (!f) notFound();
  if (f.caseId) redirect(`/cases/${f.caseId}/forms/${f.id}`);
  return <FormInstanceView f={f} t={t} userId={actor.userId} />;
}
