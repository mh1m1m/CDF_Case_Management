"use server";
// The committee's legal review and authority commands (UX redesign Phase 12 P12-3a; ADR-057): asking for a legal review,
// cancelling a request, submitting the package to the authority and recording the authority's decision. Each goes
// through the legal reviews service, which validates with the shared schema and runs the api.* command in the caller's
// security context: the database decides who may act (the committee's secretary passing the case gate, not
// conflicted) and in which state. The ids are the ones R2 gave the page; a forged id meets the same command and its
// refusal. A command sent from a page of its own goes back to the proceeding once it is done.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { CommandResult } from "@cdf/application";
import { legalReviewsService, requireActor, type RequestScope } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

type Run = (
  service: ReturnType<typeof legalReviewsService>,
  ctx: RequestScope["ctx"],
) => Promise<CommandResult<unknown>>;

/**
 * Runs one command, then refreshes the proceeding's page, the reviewers' pages and the case pages that show the
 * package; with `back`, returns to the proceeding.
 */
async function onPackage(
  committeeProceedingId: string,
  form: FormData,
  run: Run,
  back = false,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await run(legalReviewsService(), ctx);
  if (result.ok) {
    const proceeding = `/committee-proceedings/${committeeProceedingId}`;
    revalidatePath(proceeding);
    revalidatePath("/legal-reviews/[requestId]", "page");
    revalidatePath("/cases/[id]/proceedings", "page");
    if (back) redirect(proceeding);
  }
  return toActionState(result, form);
}

/** The values of a field sent once per ticked box, without empties. */
const many = (form: FormData, name: string): string[] =>
  form.getAll(name).filter((v): v is string => typeof v === "string" && v !== "");

/** The form's single fields: every field but the repeated rows. */
const fields = (form: FormData, rows: string[]) =>
  Object.fromEntries(
    Object.entries(formObject(form)).filter(([k]) => !rows.some((r) => k.startsWith(`${r}.`))),
  );

/**
 * Repeated rows named `name.k.field`, as an array whose index is the row's place in the form (at most 100 rows), so
 * that an error on `name.k.field` shows next to that control. A row the form did not send is an empty row.
 */
function rows(form: FormData, name: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const pattern = new RegExp(`^${name}\\.(\\d{1,2})\\.(\\w+)$`);
  for (const [key, value] of form.entries()) {
    const m = pattern.exec(key);
    if (!m || typeof value !== "string") continue;
    const k = Number(m[1]);
    for (let j = out.length; j <= k; j++) out.push({});
    out[k]![m[2]!] = value;
  }
  return out;
}

export async function requestLegalReviewAction(
  committeeProceedingId: string,
  packageId: string,
  _: ActionState,
  form: FormData,
) {
  return onPackage(
    committeeProceedingId,
    form,
    (s, ctx) =>
      s.requestLegalReview(ctx, {
        ...formObject(form),
        findingIds: many(form, "findingIds"),
        minutesIds: many(form, "minutesIds"),
        packageId,
      }),
    true,
  );
}

export async function cancelLegalReviewAction(
  committeeProceedingId: string,
  requestId: string,
  _: ActionState,
  form: FormData,
) {
  return onPackage(committeeProceedingId, form, (s, ctx) =>
    s.cancelLegalReviewRequest(ctx, { ...formObject(form), requestId }),
  );
}

export async function submitToAuthorityAction(
  committeeProceedingId: string,
  packageId: string,
  _: ActionState,
  form: FormData,
) {
  return onPackage(committeeProceedingId, form, (s, ctx) => s.submitToAuthority(ctx, { packageId }));
}

export async function recordAuthorityDecisionAction(
  committeeProceedingId: string,
  packageId: string,
  authorityType: string,
  _: ActionState,
  form: FormData,
) {
  return onPackage(
    committeeProceedingId,
    form,
    (s, ctx) =>
      s.recordAuthorityDecision(ctx, {
        ...fields(form, ["itemOutcomes", "conditions"]),
        itemOutcomes: rows(form, "itemOutcomes"),
        conditions: rows(form, "conditions"),
        packageId,
        authorityType,
      }),
    true,
  );
}
