// Legal review and the authority's decision (migrations 1900 and 2030; UX redesign Phase 12 P12-3a, ADR-057). One
// schema per command; the database re-checks every rule, including who may act, in which state, and that the reviewer,
// findings, minutes, authority and items chosen are ones the command accepts. The lengths and pairings follow the
// commands' own checks, so a mistake shows field by field before the database is asked. Error messages are i18n keys,
// never prose.
import { z } from "zod";
import {
  AUTHORITY_CONDITION_KINDS,
  AUTHORITY_OUTCOMES,
  AUTHORITY_TYPES,
  CONDITIONAL_AUTHORITY_OUTCOMES,
  ITEMISED_AUTHORITY_OUTCOMES,
  LEGAL_OPINIONS,
  RECORDED_ITEM_OUTCOMES,
  SOURCE_SIGNATURES,
  type AuthorityConditionKind,
  type RecordedItemOutcome,
} from "@cdf/contracts";

const uuid = z.uuid({ message: "validation.invalid" });
/** An id chosen from a list of radio buttons: "choose one" when none is. */
const chosenId = z.uuid({ message: "validation.chooseOne" });
const requiredText = (min: number, max: number) =>
  z
    .string({ message: "validation.required" })
    .trim()
    .min(1, { message: "validation.required", abort: true })
    .min(min, { message: "validation.tooShort" })
    .max(max, { message: "validation.tooLong" });
const optionalText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: "validation.tooLong" })
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || v.length >= min, { message: "validation.tooShort" });
const choice = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values, { message: "validation.required" });
/** Ids chosen with checkboxes: each once (the command refuses a repeat). */
const idList = z
  .array(uuid)
  .default([])
  .refine((ids) => new Set(ids).size === ids.length, { message: "validation.invalid" });
/** A field of a repeated row, checked with its row: trimmed, absent when empty. */
const rowText = z
  .string()
  .optional()
  .transform((v) => v?.trim() || undefined);

/** A datetime-local or ISO value as a Date; a local value is Riyadh time (UTC+3, no daylight saving). */
const asInstant = (v: string): Date =>
  new Date(/([zZ]|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}${v.length === 16 ? ":00" : ""}+03:00`);

/** Where a text's length falls outside min..max, the key that says so; undefined when it fits. */
function lengthIssue(text: string, min: number, max: number): string | undefined {
  if (text.length < min) return "validation.tooShort";
  if (text.length > max) return "validation.tooLong";
  return undefined;
}

// ---- Asking for a legal review (api.request_legal_review), approving one on a restricted case
//      (api.approve_restricted_legal_review), cancelling a request (api.cancel_legal_review_request) ---------------
/**
 * The reviewer from the list (the command answers INVALID for one it does not accept: the caller, someone without the
 * opinion permission, someone not cleared for the case), the findings and approved minutes the packet carries besides
 * the adopted items, and the reason (5 to 2000 characters). On a restricted case the request names exactly the
 * approval's reviewer and no more than its findings and minutes (AUTHORITY_APPROVAL_SCOPE_EXCEEDED otherwise).
 */
export const requestLegalReviewSchema = z.object({
  packageId: uuid,
  assignedTo: chosenId,
  findingIds: idList,
  minutesIds: idList,
  reason: requiredText(5, 2000),
});
/** DEC-62, DEC-F20: the case owner as its Restricted Case Authority approves one review of the round, single use. */
export const approveRestrictedLegalReviewSchema = z.object({
  packageId: uuid,
  reviewerId: chosenId,
  findingIds: idList,
  minutesIds: idList,
  reason: requiredText(5, 2000),
});
/** AMB-115: the reviewer's packet closes at once; a replacement is a new request (and, restricted, a new approval). */
export const cancelLegalReviewRequestSchema = z.object({ requestId: uuid, reason: requiredText(5, 2000) });

// ---- The opinion (api.give_legal_opinion, api.give_superseding_legal_opinion) ------------------------------------
/** CONCURS may stand alone; any other opinion gives its text (10 to 8000 characters), and text given is never empty. */
const opinionSchema = z
  .object({
    requestId: uuid,
    opinion: z.enum(LEGAL_OPINIONS, { message: "validation.chooseOne" }),
    opinionText: optionalText(10, 8000),
  })
  .superRefine((v, ctx) => {
    if (v.opinion !== "CONCURS" && !v.opinionText)
      ctx.addIssue({ code: "custom", message: "validation.opinionTextRequired", path: ["opinionText"] });
  });
export const giveLegalOpinionSchema = opinionSchema;
/** AMB-117: a later opinion on the same request, kept beside every earlier one; CONFLICTS returns the package. */
export const giveSupersedingLegalOpinionSchema = opinionSchema;

// ---- The authority (api.submit_to_authority, api.record_authority_decision) ---------------------------------------
export const submitToAuthoritySchema = z.object({ packageId: uuid });

/** Further source documents, one reference per line (AMB-130): blank lines are left out. */
const sourceLines = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean),
  );

const ITEMISED: readonly string[] = ITEMISED_AUTHORITY_OUTCOMES;
const CONDITIONAL: readonly string[] = CONDITIONAL_AUTHORITY_OUTCOMES;
const ITEM_OUTCOMES: readonly string[] = RECORDED_ITEM_OUTCOMES;
const CONDITION_KINDS: readonly string[] = AUTHORITY_CONDITION_KINDS;

type ConditionRow = { kind?: string; text?: string; itemId?: string; dueDate?: string };
const isUsed = (c: ConditionRow) => Boolean(c.kind || c.text || c.itemId || c.dueDate);

/**
 * The authority's decision, recorded by the committee's secretary from its source document (N15), with
 * api.record_authority_decision's checks:
 *   - an authority still to decide (AUTHORITY_TYPE_MISMATCH, AUTHORITY_ALREADY_DECIDED otherwise) and an outcome;
 *   - when the authority decided: never in the future, and not on a day before the adoption (AMB-131; the command
 *     checks that day in Riyadh);
 *   - who decided (3 to 200 characters) and the primary source document (3 to 300);
 *   - whether the source is signed: unsigned only with the secretary's attestation (AMB-129, 10 to 2000);
 *   - a delegation reference if the authority acted by delegation (AMB-125, 3 to 300);
 *   - up to ten further sources, each 3 to 300 characters, none repeated and none the primary one (AMB-130);
 *   - for APPROVE_PARTIALLY and MODIFY, one outcome per item of the authority's scope (a MODIFIED item says how, 5 to
 *     4000 characters), and only then;
 *   - conditions (up to twenty, each a kind and 5 to 2000 characters of text, optionally an item of the scope and a
 *     due date) only with an approving outcome (AMB-133);
 *   - an optional reason (5 to 4000).
 * Item outcomes and condition rows are named by their place in the form (`itemOutcomes.0.outcome`,
 * `conditions.0.text`), so an error shows next to its field. While a conflict taint waits for the committee only
 * RETURN_TO_COMMITTEE is accepted (DEC-AMB-003), and an authority approves at most one item of an exclusivity group
 * (EXCLUSIVITY_GROUP_VIOLATION): the command answers both.
 */
export const recordAuthorityDecisionSchema = z
  .object({
    packageId: uuid,
    authorityType: choice(AUTHORITY_TYPES),
    outcome: z.enum(AUTHORITY_OUTCOMES, { message: "validation.chooseOne" }),
    decidedAt: z
      .string({ message: "validation.required" })
      .trim()
      .min(1, { message: "validation.required", abort: true })
      .transform((v, ctx) => {
        const d = asInstant(v);
        if (Number.isNaN(d.getTime())) {
          ctx.addIssue({ code: "custom", message: "validation.invalid" });
          return z.NEVER;
        }
        if (d.getTime() > Date.now()) {
          ctx.addIssue({ code: "custom", message: "validation.futureDate" });
          return z.NEVER;
        }
        return d.toISOString();
      }),
    decidedByLabel: requiredText(3, 200),
    sourceDocumentReference: requiredText(3, 300),
    sourceSignature: z.enum(SOURCE_SIGNATURES, { message: "validation.invalid" }).optional(),
    unsignedAttestation: optionalText(10, 2000),
    delegationReference: optionalText(3, 300),
    additionalSourceReferences: sourceLines,
    itemOutcomes: z.array(z.object({ itemId: uuid, outcome: rowText, modification: rowText })).default([]),
    conditions: z
      .array(z.object({ kind: rowText, text: rowText, itemId: rowText, dueDate: rowText }))
      .default([]),
    reason: optionalText(5, 4000),
  })
  .superRefine((v, ctx) => {
    if (v.sourceSignature === "UNSIGNED" && !v.unsignedAttestation)
      ctx.addIssue({
        code: "custom",
        message: "validation.attestationRequired",
        path: ["unsignedAttestation"],
      });
    if (v.sourceSignature !== "UNSIGNED" && v.unsignedAttestation)
      ctx.addIssue({ code: "custom", message: "validation.noAttestation", path: ["unsignedAttestation"] });

    const sources = v.additionalSourceReferences;
    if (
      sources.length > 10 ||
      sources.some((s) => lengthIssue(s, 3, 300) || s === v.sourceDocumentReference) ||
      new Set(sources).size !== sources.length
    )
      ctx.addIssue({ code: "custom", message: "validation.sources", path: ["additionalSourceReferences"] });

    if (ITEMISED.includes(v.outcome))
      v.itemOutcomes.forEach((o, k) => {
        if (!o.outcome || !ITEM_OUTCOMES.includes(o.outcome)) {
          ctx.addIssue({
            code: "custom",
            message: "validation.chooseOne",
            path: ["itemOutcomes", k, "outcome"],
          });
          return;
        }
        if (o.outcome === "MODIFIED") {
          const problem = o.modification
            ? lengthIssue(o.modification, 5, 4000)
            : "validation.modificationRequired";
          if (problem)
            ctx.addIssue({ code: "custom", message: problem, path: ["itemOutcomes", k, "modification"] });
        } else if (o.modification) {
          ctx.addIssue({
            code: "custom",
            message: "validation.noModification",
            path: ["itemOutcomes", k, "modification"],
          });
        }
      });

    const used = v.conditions.flatMap((c, k) => (isUsed(c) ? [{ c, k }] : []));
    if (used.length > 0 && !CONDITIONAL.includes(v.outcome)) {
      ctx.addIssue({
        code: "custom",
        message: "validation.noConditions",
        path: ["conditions", used[0]!.k, "kind"],
      });
      return;
    }
    if (used.length > 20)
      ctx.addIssue({ code: "custom", message: "validation.tooLong", path: ["conditions", 20, "kind"] });
    for (const { c, k } of used) {
      if (!c.kind || !CONDITION_KINDS.includes(c.kind))
        ctx.addIssue({ code: "custom", message: "validation.chooseOne", path: ["conditions", k, "kind"] });
      const problem = c.text ? lengthIssue(c.text, 5, 2000) : "validation.required";
      if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["conditions", k, "text"] });
      if (c.itemId && !uuid.safeParse(c.itemId).success)
        ctx.addIssue({ code: "custom", message: "validation.invalid", path: ["conditions", k, "itemId"] });
      if (c.dueDate && !z.iso.date().safeParse(c.dueDate).success)
        ctx.addIssue({ code: "custom", message: "validation.invalid", path: ["conditions", k, "dueDate"] });
    }
  })
  .transform(({ itemOutcomes, conditions, ...v }) => {
    const used = conditions.filter(isUsed);
    return {
      ...v,
      // Sent only for the outcomes decided item by item: the command refuses them with any other.
      itemOutcomes: ITEMISED.includes(v.outcome)
        ? itemOutcomes.map((o) => ({
            itemId: o.itemId,
            outcome: o.outcome as RecordedItemOutcome,
            modification: o.outcome === "MODIFIED" ? o.modification : undefined,
          }))
        : undefined,
      // The command takes one to twenty conditions, or none at all.
      conditions:
        used.length > 0
          ? used.map((c) => ({
              kind: c.kind as AuthorityConditionKind,
              text: c.text!,
              itemId: c.itemId,
              dueDate: c.dueDate,
            }))
          : undefined,
    };
  });
