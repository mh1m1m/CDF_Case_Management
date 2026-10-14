"use server";
// Case structure commands (Phase 12 P12-1; migration 1870). Bound ids come back from the browser, so the shared
// schema checks them and the database decides who may act (authz.can_edit_case, authz.can_record_findings, the
// Restricted Case Authority for DEC-61).
import { revalidatePath } from "next/cache";
import { caseStructureService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

const done = (caseId: string) => revalidatePath(`/cases/${caseId}`, "layout");

export async function addSubjectAction(caseId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await caseStructureService().addSubject(ctx, { ...formObject(form), caseId });
  if (result.ok) done(caseId);
  return toActionState(result, form);
}

export async function addAllegationAction(
  caseId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await caseStructureService().addAllegation(ctx, { ...formObject(form), caseId });
  if (result.ok) done(caseId);
  return toActionState(result, form);
}

export async function linkAllegationSubjectAction(
  caseId: string,
  allegationId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await caseStructureService().linkAllegationSubject(ctx, {
    ...formObject(form),
    allegationId,
  });
  if (result.ok) done(caseId);
  return toActionState(result, form);
}

export async function recordFindingAction(
  caseId: string,
  allegationId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await caseStructureService().recordFinding(ctx, { ...formObject(form), allegationId });
  if (result.ok) done(caseId);
  return toActionState(result, form);
}

export async function openProceedingAction(
  caseId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await caseStructureService().openProceeding(ctx, { ...formObject(form), caseId });
  if (result.ok) done(caseId);
  return toActionState(result, form);
}

export async function updateProceedingStateAction(
  caseId: string,
  proceedingId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await caseStructureService().updateProceedingState(ctx, {
    ...formObject(form),
    proceedingId,
  });
  if (result.ok) done(caseId);
  return toActionState(result, form);
}

export async function closeProceedingAction(
  caseId: string,
  proceedingId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await caseStructureService().closeProceeding(ctx, { ...formObject(form), proceedingId });
  if (result.ok) done(caseId);
  return toActionState(result, form);
}

export async function referToCommitteeAction(
  caseId: string,
  committeeId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await caseStructureService().referToCommittee(ctx, {
    ...formObject(form),
    caseId,
    committeeId,
  });
  if (result.ok) done(caseId);
  return toActionState(result, form);
}

export async function approveRestrictedReferralAction(
  caseId: string,
  committeeId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await caseStructureService().approveRestrictedReferral(ctx, {
    ...formObject(form),
    caseId,
    committeeId,
  });
  if (result.ok) done(caseId);
  return toActionState(result, form);
}
