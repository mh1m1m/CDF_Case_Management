"use server";
// The commands on a continuity import's page (UX redesign Phase 12 P12-6b-1; ADR-034). Each goes through the
// continuity import service, which validates with the shared schema, pre-checks the role permission and runs the
// api.* command in the caller's security context: the database decides that the caller imports this batch or may
// approve it, its status, the separate approver, the revoked workbook and the hash an approval and the import are
// bound to. The batch's id is the one the view gave the page, and each hash is the one the page showed; a forged id or
// hash meets the same command and its refusal. Nothing here returns a cell or a row about anyone to the browser.
// A command that moves the batch on sends the caller back to its page, which says what changed (its form is gone by
// then); skipping a row and the dry run answer in their own form, which stays.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { CommandResult } from "@cdf/application";
import { bcpImportService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

/** After the command: the batch's page and My Work are read again, then the form gets its answer. */
function answer<T>(batchId: string, form: FormData, result: CommandResult<T>): ActionState {
  if (result.ok) {
    revalidatePath(`/continuity/imports/${batchId}`);
    revalidatePath("/my-work");
  }
  return toActionState(result, form);
}

/** What the batch's page says after a command that moved it on. */
type BcpDone = "submitted" | "approved" | "rejected" | "imported" | "cancelled";

function leave(batchId: string, done: BcpDone): never {
  revalidatePath(`/continuity/imports/${batchId}`);
  revalidatePath("/my-work");
  redirect(`/continuity/imports/${batchId}?done=${done}`);
}

/** Skips the row the importer chose, with their reason; the other resolutions wait for their options read (F4). */
export async function skipRowAction(batchId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await bcpImportService().resolve(ctx, actor, { ...formObject(form), resolution: "SKIP" });
  return answer(batchId, form, result);
}

/** The importer's dry run of the real commands, always rolled back; while staged, the preview a submission needs. */
export async function dryRunAction(batchId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await bcpImportService().preview(ctx, actor, { batchId });
  return answer(batchId, form, result);
}

/** Submits the batch as its last clean dry run left it (the hash the page showed). Only SUBMITTED says so: a committee
 *  workbook whose official record does not reconcile answers otherwise (2115) and stays as it was, which the page,
 *  read again, shows. */
export async function submitBcpAction(batchId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await bcpImportService().submit(ctx, actor, { ...formObject(form), batchId });
  if (result.ok) {
    if (result.value === "SUBMITTED") leave(batchId, "submitted");
    revalidatePath(`/continuity/imports/${batchId}`);
    redirect(`/continuity/imports/${batchId}`);
  }
  return toActionState(result, form);
}

/** An approver's decision on the batch as submitted (the submitted hash the page showed), with its reason. */
export async function decideBcpAction(batchId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await bcpImportService().decide(ctx, actor, { ...formObject(form), batchId });
  if (result.ok) leave(batchId, result.value === "APPROVED" ? "approved" : "rejected");
  return toActionState(result, form);
}

/** Imports the approved rows in one transaction, or none of them. */
export async function applyBcpAction(batchId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await bcpImportService().apply(ctx, actor, { ...formObject(form), batchId });
  if (result.ok) leave(batchId, "imported");
  return toActionState(result, form);
}

export async function cancelBcpAction(batchId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await bcpImportService().cancel(ctx, actor, { ...formObject(form), batchId });
  if (result.ok) leave(batchId, "cancelled");
  return toActionState(result, form);
}
