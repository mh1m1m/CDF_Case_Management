"use server";
// The reviewer's commands (UX redesign Phase 12 P12-3a; ADR-057): the opinion, and a later opinion beside it (AMB-117).
// Each goes through the legal reviews service, which validates with the shared schema and runs the api.* command in
// the caller's security context: the database decides that the caller is the request's reviewer, still holds the
// opinion permission, is cleared for the case, and that the request and the package are in the state the command
// needs. The request's id is the one L1 gave the page; a forged id meets the same command and its refusal.
import { revalidatePath } from "next/cache";
import type { CommandResult } from "@cdf/application";
import { legalReviewsService, requireActor, type RequestScope } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

type Run = (
  service: ReturnType<typeof legalReviewsService>,
  ctx: RequestScope["ctx"],
  raw: Record<string, unknown>,
) => Promise<CommandResult<unknown>>;

async function onRequest(requestId: string, form: FormData, run: Run): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await run(legalReviewsService(), ctx, { ...formObject(form), requestId });
  if (result.ok) {
    revalidatePath(`/legal-reviews/${requestId}`);
    // An opinion moves the package on: the committee's and the case's pages show it.
    revalidatePath("/committee-proceedings/[committeeProceedingId]", "page");
  }
  return toActionState(result, form);
}

export async function giveOpinionAction(requestId: string, _: ActionState, form: FormData) {
  return onRequest(requestId, form, (s, ctx, raw) => s.giveLegalOpinion(ctx, raw));
}

export async function giveSupersedingOpinionAction(requestId: string, _: ActionState, form: FormData) {
  return onRequest(requestId, form, (s, ctx, raw) => s.giveSupersedingLegalOpinion(ctx, raw));
}
