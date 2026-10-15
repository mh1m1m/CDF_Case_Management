"use server";
// The restricted case's authority approving a legal review of an adopted package (UX redesign Phase 12 P12-3a;
// ADR-057; DEC-62, DEC-F20). The legal reviews service validates with the shared schema and runs
// api.approve_restricted_legal_review in the caller's security context: the database decides that the caller is the
// case owner, the case restricted and active, the package adopted, and that no review of the round is open or already
// approved. The package's id is the one the case's read model gave the page; a forged id meets the same command.
import { revalidatePath } from "next/cache";
import { legalReviewsService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

/** The values of a field sent once per ticked box, without empties. */
const many = (form: FormData, name: string): string[] =>
  form.getAll(name).filter((v): v is string => typeof v === "string" && v !== "");

export async function approveLegalReviewAction(
  caseId: string,
  packageId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await legalReviewsService().approveRestrictedLegalReview(ctx, {
    ...formObject(form),
    findingIds: many(form, "findingIds"),
    minutesIds: many(form, "minutesIds"),
    packageId,
  });
  if (result.ok) {
    revalidatePath(`/cases/${caseId}`, "layout");
    revalidatePath("/committee-proceedings/[committeeProceedingId]", "page");
  }
  return toActionState(result, form);
}
