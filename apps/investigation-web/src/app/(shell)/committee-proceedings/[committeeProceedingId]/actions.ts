"use server";
// The proceeding page's commands (UX redesign Phase 12 P12-2c; ADR-056): building a recommendation package, putting it
// to the committee, opening its vote, recording the adoption, returning it to the committee and resolving a conflict
// taint. Each goes through the committee proceedings service, which validates with the shared schema and runs the
// api.* command in the caller's security context: the database decides who may act and in which state. The ids are
// the ones the read models gave the page; a forged id meets the same command and its refusal.
import { revalidatePath } from "next/cache";
import type { CommandResult } from "@cdf/application";
import { committeeProceedingsService, requireActor, type RequestScope } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

type Run = (
  service: ReturnType<typeof committeeProceedingsService>,
  ctx: RequestScope["ctx"],
  raw: Record<string, unknown>,
) => Promise<CommandResult<unknown>>;

/**
 * Runs one command with the form's fields and the page's ids (the ids win), then refreshes the proceeding's page, the
 * committee pages (a package changes nothing there, but a vote opened changes a meeting) and the meetings.
 */
async function onProceeding(
  committeeProceedingId: string,
  form: FormData,
  ids: Record<string, string>,
  run: Run,
  extra: Record<string, unknown> = {},
  booleans: string[] = [],
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await run(committeeProceedingsService(), ctx, {
    ...formObject(form, booleans),
    ...extra,
    ...ids,
  });
  if (result.ok) {
    revalidatePath(`/committee-proceedings/${committeeProceedingId}`);
    revalidatePath("/meetings/[meetingId]", "page");
  }
  return toActionState(result, form);
}

/** The values of a field sent once per ticked box, without empties. */
const many = (form: FormData, name: string): string[] =>
  form.getAll(name).filter((v): v is string => typeof v === "string" && v !== "");

export async function createPackageAction(committeeProceedingId: string, _: ActionState, form: FormData) {
  return onProceeding(committeeProceedingId, form, { committeeProceedingId }, (s, ctx, raw) =>
    s.createPackage(ctx, raw),
  );
}

export async function addItemAction(
  committeeProceedingId: string,
  packageId: string,
  _: ActionState,
  form: FormData,
) {
  return onProceeding(
    committeeProceedingId,
    form,
    { packageId },
    (s, ctx, raw) => s.addItem(ctx, raw),
    {
      subjectIds: many(form, "subjectIds"),
      allegationIds: many(form, "allegationIds"),
      dependsOnItemIds: many(form, "dependsOnItemIds"),
    },
    ["requiresLegalJustification"],
  );
}

export async function withdrawItemAction(
  committeeProceedingId: string,
  itemId: string,
  _: ActionState,
  form: FormData,
) {
  return onProceeding(committeeProceedingId, form, { itemId }, (s, ctx, raw) => s.withdrawItem(ctx, raw));
}

export async function submitForVoteAction(
  committeeProceedingId: string,
  packageId: string,
  _: ActionState,
  form: FormData,
) {
  return onProceeding(committeeProceedingId, form, { packageId }, (s, ctx, raw) => s.submitForVote(ctx, raw));
}

export async function openPackageVoteAction(
  committeeProceedingId: string,
  packageId: string,
  meetingId: string,
  _: ActionState,
  form: FormData,
) {
  return onProceeding(committeeProceedingId, form, { packageId, meetingId }, (s, ctx, raw) =>
    s.openPackageVote(ctx, raw),
  );
}

export async function recordAdoptionAction(
  committeeProceedingId: string,
  packageId: string,
  _: ActionState,
  form: FormData,
) {
  return onProceeding(committeeProceedingId, form, { packageId }, (s, ctx, raw) =>
    s.recordAdoption(ctx, raw),
  );
}

export async function returnToCommitteeAction(
  committeeProceedingId: string,
  packageId: string,
  _: ActionState,
  form: FormData,
) {
  return onProceeding(committeeProceedingId, form, { packageId }, (s, ctx, raw) =>
    s.returnToCommittee(ctx, raw),
  );
}

export async function resolveTaintAction(
  committeeProceedingId: string,
  itemId: string,
  _: ActionState,
  form: FormData,
) {
  return onProceeding(committeeProceedingId, form, { itemId }, (s, ctx, raw) => s.resolveTaint(ctx, raw));
}
