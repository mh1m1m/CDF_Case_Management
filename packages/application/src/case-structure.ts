/**
 * The case structure for the case team (ADR-017 to ADR-019, migration 1870; UX redesign Phase 12 P12-1): proceedings,
 * subjects, allegations, versioned findings and referral to a committee. Reads go through RLS in the caller's security
 * context. Each command:
 *   1. validates input with the shared Zod schema (§45),
 *   2. needs no permission code: the rights come from the caller's relationship to the case, which only the
 *      database knows (authz.can_edit_case, authz.can_record_findings, the Restricted Case Authority for DEC-61),
 *   3. runs the api.* command in the caller's security context (the authoritative check),
 *   4. maps failures to safe AppErrors and records refusals as COMMAND_DENIED SECURITY events (§30).
 * Finding rationales and allegation text are case content: they are never logged.
 */
import type { CaseStructure, CommitteeReferralPreview } from "@cdf/contracts";
import type { SecurityEventSink } from "@cdf/audit";
import {
  addAllegationSchema,
  addCaseSubjectSchema,
  approveRestrictedReferralSchema,
  closeProceedingSchema,
  linkAllegationSubjectSchema,
  openProceedingSchema,
  recordFindingSchema,
  referCaseToCommitteeSchema,
  updateProceedingStateSchema,
} from "@cdf/validation";
import type { z } from "zod";
import { toAppError, type AppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { UserRequestContext } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

/** Port over the case-structure reads and the 1870 api.* commands (implemented in @cdf/infrastructure). */
export interface CaseStructureGateway {
  /** What RLS shows the caller on one case they can already open (the page has opened it). */
  structure(ctx: UserRequestContext, caseId: string): Promise<CaseStructure>;
  /** What a referral of the case to the committee would copy now, as counts (2045); the referral's own checks. */
  referralPreview(
    ctx: UserRequestContext,
    caseId: string,
    committeeId: string,
  ): Promise<CommitteeReferralPreview>;
  addSubject(ctx: UserRequestContext, input: In<typeof addCaseSubjectSchema>): Promise<string>;
  addAllegation(ctx: UserRequestContext, input: In<typeof addAllegationSchema>): Promise<string>;
  linkAllegationSubject(
    ctx: UserRequestContext,
    input: In<typeof linkAllegationSubjectSchema>,
  ): Promise<void>;
  recordFinding(ctx: UserRequestContext, input: In<typeof recordFindingSchema>): Promise<string>;
  openProceeding(ctx: UserRequestContext, input: In<typeof openProceedingSchema>): Promise<string>;
  updateProceedingState(
    ctx: UserRequestContext,
    input: In<typeof updateProceedingStateSchema>,
  ): Promise<void>;
  closeProceeding(ctx: UserRequestContext, input: In<typeof closeProceedingSchema>): Promise<void>;
  referToCommittee(ctx: UserRequestContext, input: In<typeof referCaseToCommitteeSchema>): Promise<string>;
  approveRestrictedReferral(
    ctx: UserRequestContext,
    input: In<typeof approveRestrictedReferralSchema>,
  ): Promise<string>;
}

export interface CaseStructureDeps {
  gateway: CaseStructureGateway;
  securityEvents: SecurityEventSink;
}

export function createCaseStructureService(deps: CaseStructureDeps) {
  const { gateway, securityEvents } = deps;

  async function recordDenial(ctx: UserRequestContext, command: string, error: AppError, objectId?: string) {
    if (error.kind !== "FORBIDDEN" && error.kind !== "NOT_FOUND") return;
    try {
      await securityEvents.record(
        {
          action: "COMMAND_DENIED",
          objectType: "command",
          objectId,
          metadata: { command, outcome: error.kind },
        },
        ctx,
      );
    } catch {
      // Recording must never mask the original denial.
    }
  }

  async function command<S extends z.ZodType, T>(
    ctx: UserRequestContext,
    name: string,
    schema: S,
    raw: unknown,
    run: (input: In<S>) => Promise<T>,
    objectId: (input: In<S>) => string,
  ): Promise<CommandResult<T>> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
    try {
      return { ok: true, value: await run(parsed.data) };
    } catch (cause) {
      const error = toAppError(cause, ctx.requestId);
      await recordDenial(ctx, name, error, objectId(parsed.data));
      return { ok: false, error };
    }
  }

  return {
    structure: async (ctx: UserRequestContext, caseId: string) => {
      try {
        return await gateway.structure(ctx, caseId);
      } catch (cause) {
        throw toAppError(cause, ctx.requestId);
      }
    },

    /**
     * The counts a referral would copy, for whoever may refer the case now; null when the database refuses (the
     * referral's own refusals: not visible, not editable, not active, no such committee). A read, so a refusal is
     * not a denied command: the page shows no preview, and the referral form, if any, gets the same answer.
     */
    referralPreview: async (
      ctx: UserRequestContext,
      caseId: string,
      committeeId: string,
    ): Promise<CommitteeReferralPreview | null> => {
      try {
        return await gateway.referralPreview(ctx, caseId, committeeId);
      } catch (cause) {
        const error = toAppError(cause, ctx.requestId);
        if (error.kind === "UNAVAILABLE" || error.kind === "UNAUTHENTICATED") throw error;
        return null;
      }
    },

    addSubject: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "add_case_subject",
        addCaseSubjectSchema,
        raw,
        (i) => gateway.addSubject(ctx, i),
        (i) => i.caseId,
      ),
    addAllegation: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "add_allegation",
        addAllegationSchema,
        raw,
        (i) => gateway.addAllegation(ctx, i),
        (i) => i.caseId,
      ),
    linkAllegationSubject: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "link_allegation_subject",
        linkAllegationSubjectSchema,
        raw,
        (i) => gateway.linkAllegationSubject(ctx, i),
        (i) => i.allegationId,
      ),
    recordFinding: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "record_finding",
        recordFindingSchema,
        raw,
        (i) => gateway.recordFinding(ctx, i),
        (i) => i.allegationId,
      ),
    openProceeding: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "open_proceeding",
        openProceedingSchema,
        raw,
        (i) => gateway.openProceeding(ctx, i),
        (i) => i.caseId,
      ),
    updateProceedingState: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "update_proceeding_state",
        updateProceedingStateSchema,
        raw,
        (i) => gateway.updateProceedingState(ctx, i),
        (i) => i.proceedingId,
      ),
    closeProceeding: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "close_proceeding",
        closeProceedingSchema,
        raw,
        (i) => gateway.closeProceeding(ctx, i),
        (i) => i.proceedingId,
      ),
    referToCommittee: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "refer_case_to_committee",
        referCaseToCommitteeSchema,
        raw,
        (i) => gateway.referToCommittee(ctx, i),
        (i) => i.caseId,
      ),
    approveRestrictedReferral: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "approve_restricted_committee_referral",
        approveRestrictedReferralSchema,
        raw,
        (i) => gateway.approveRestrictedReferral(ctx, i),
        (i) => i.caseId,
      ),
  };
}

export type CaseStructureService = ReturnType<typeof createCaseStructureService>;
