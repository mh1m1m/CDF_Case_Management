// The two-person lift of a case's restricted status (migration 2130, ADR-049; DEC-AMB-012 → C). One schema per
// command; no schema takes a user id (the actor comes from the session, T-AMB-142). The database re-checks every rule:
// who may act, the request's state, the windows and the preview. Error messages are i18n keys, never prose.
import { z } from "zod";
import { RESTRICTION_LIFT_DECISIONS } from "@cdf/contracts";

const uuid = z.uuid({ message: "validation.invalid" });
/** The reason the commands keep on the request (5 to 2000 characters, as `api._require_text`). */
const reason = z
  .string({ message: "validation.required" })
  .trim()
  .min(1, { message: "validation.required", abort: true })
  .min(5, { message: "validation.tooShort" })
  .max(2000, { message: "validation.tooLong" });
/** The SHA-256 of the preview the caller was shown; the database refuses any other (PREVIEW_CHANGED). */
const previewHash = z
  .string({ message: "validation.required" })
  .regex(/^[0-9a-f]{64}$/, { message: "validation.invalid" });

/** api.preview_restriction_lift and api.restriction_lift_status take the case. */
export const restrictionLiftCaseSchema = z.object({ caseId: uuid });

/** The case's authority asks for the lift on the preview they were shown. */
export const requestRestrictionLiftSchema = z.object({ caseId: uuid, reason, previewHash });

/** The second approver decides on the preview they were shown; a reason either way. */
export const decideRestrictionLiftSchema = z.object({
  requestId: uuid,
  decision: z.enum(RESTRICTION_LIFT_DECISIONS, { message: "validation.required" }),
  reason,
  previewHash,
});

/** api.lift_case_restriction, api.expire_restriction_lift and api.withdraw_restriction_lift take the request. */
export const restrictionLiftRequestSchema = z.object({ requestId: uuid });
