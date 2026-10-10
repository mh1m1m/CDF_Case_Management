"use server";
// Interview server actions (CDF-60). Each validates through the application service, which re-validates and
// lets the database decide; nothing here trusts a hidden field for authorization.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { CommandResult } from "@cdf/application";
import { interviewService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

/** Like toActionState, but keeps the interviews.* validation keys so the form can show specific messages. */
function toInterviewState(result: CommandResult<unknown>): ActionState {
  if (!result.ok && "fieldErrors" in result) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.fieldErrors.issues) {
      const key = issue.path.join(".");
      if (key in fieldErrors) continue;
      fieldErrors[key] =
        issue.message.startsWith("validation.") || issue.message.startsWith("interviews.validation.")
          ? issue.message
          : "validation.invalid";
    }
    return { status: "invalid", fieldErrors };
  }
  return toActionState(result);
}

const detailPath = (caseId: string, interviewId: string) => `/cases/${caseId}/interviews/${interviewId}`;

export async function planInterviewAction(
  caseId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await interviewService().plan(ctx, { ...formObject(form), caseId });
  if (result.ok) redirect(detailPath(caseId, result.value));
  return toInterviewState(result);
}

/** Commands on one interview share this shape: form fields + the interview id from the route. */
type InterviewCommand =
  "addParticipant" | "schedule" | "issueNotice" | "recordRights" | "recordConducted" | "linkRecording";

async function onInterview(
  name: InterviewCommand,
  caseId: string,
  interviewId: string,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result: CommandResult<unknown> = await interviewService()[name](ctx, {
    ...formObject(form),
    interviewId,
  });
  if (result.ok) revalidatePath(detailPath(caseId, interviewId));
  return toInterviewState(result);
}

export async function addParticipantAction(
  caseId: string,
  interviewId: string,
  _: ActionState,
  form: FormData,
) {
  return onInterview("addParticipant", caseId, interviewId, form);
}
export async function scheduleAction(caseId: string, interviewId: string, _: ActionState, form: FormData) {
  return onInterview("schedule", caseId, interviewId, form);
}
export async function issueNoticeAction(caseId: string, interviewId: string, _: ActionState, form: FormData) {
  return onInterview("issueNotice", caseId, interviewId, form);
}
export async function recordRightsAction(
  caseId: string,
  interviewId: string,
  _: ActionState,
  form: FormData,
) {
  return onInterview("recordRights", caseId, interviewId, form);
}
export async function recordConductedAction(
  caseId: string,
  interviewId: string,
  _: ActionState,
  form: FormData,
) {
  return onInterview("recordConducted", caseId, interviewId, form);
}
export async function linkRecordingAction(
  caseId: string,
  interviewId: string,
  _: ActionState,
  form: FormData,
) {
  return onInterview("linkRecording", caseId, interviewId, form);
}

/** Saves a statement version; the success message carries the database-computed SHA-256. */
export async function recordStatementAction(
  caseId: string,
  interviewId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  // Statement text is taken verbatim (formObject would drop nothing, but keep whitespace semantics explicit).
  const result = await interviewService().recordStatement(ctx, {
    interviewId,
    content: typeof form.get("content") === "string" ? form.get("content") : "",
    language: form.get("language"),
  });
  if (result.ok) {
    revalidatePath(detailPath(caseId, interviewId));
    return { status: "ok", message: result.value.sha256 };
  }
  return toInterviewState(result);
}

export async function acknowledgeStatementAction(
  caseId: string,
  interviewId: string,
  versionId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await interviewService().acknowledgeStatement(ctx, { ...formObject(form), versionId });
  if (result.ok) revalidatePath(detailPath(caseId, interviewId));
  return toInterviewState(result);
}

export async function transitionInterviewAction(
  caseId: string,
  interviewId: string,
  action: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await interviewService().transition(ctx, actor, {
    ...formObject(form),
    interviewId,
    action,
  });
  if (result.ok) revalidatePath(detailPath(caseId, interviewId));
  return toInterviewState(result);
}
