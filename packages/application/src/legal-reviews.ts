/**
 * Legal review and the authority's decision (UX redesign Phase 12 P12-3a; ADR-057, migrations 1900, 2030 and 2095).
 * The pages read the purpose read models only, never the case:
 *   - the assigned reviewer's request (L1, api.legal_review_view) and its packet (api.open_packet, the audited read);
 *   - what a legal review may be asked for, or approved with on a restricted case (L2, api.legal_review_choices), which
 *     the database records with counts only;
 *   - a packet the committee or the case team reads from R2 (api.open_packet).
 * The package's legal review and authority half arrive with R2 (api.committee_items_view), through the committee
 * proceedings service. Each command:
 *   1. validates input with the shared Zod schema (§45),
 *   2. pre-checks the opinion permission (LEGAL_OPINION_GIVE) with @cdf/authorization for the reviewer's two opinions,
 *      the permission their commands check (first enforcement point, §19); beyond it, who may act comes from the
 *      request's assignee, the package's secretary or the case's Restricted Case Authority, and the package's state,
 *      which only the database knows,
 *   3. runs the api.* command in the caller's security context (the authoritative check),
 *   4. maps failures to safe AppErrors and records refusals as COMMAND_DENIED SECURITY events (§30).
 * A request, packet or package the caller may not read is the uniform not-found, recorded as ACCESS_DENIED. Reasons,
 * opinions, decisions and packet content are case content: they are never logged.
 */
import type {
  Actor,
  LegalReviewAct,
  LegalReviewChoices,
  LegalReviewView,
  PacketView,
  Permission,
} from "@cdf/contracts";
import { can } from "@cdf/authorization";
import type { SecurityEventSink } from "@cdf/audit";
import {
  approveRestrictedLegalReviewSchema,
  cancelLegalReviewRequestSchema,
  giveLegalOpinionSchema,
  giveSupersedingLegalOpinionSchema,
  recordAuthorityDecisionSchema,
  requestLegalReviewSchema,
  submitToAuthoritySchema,
} from "@cdf/validation";
import type { z } from "zod";
import { AppError, toAppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { UserRequestContext } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

/** Port over L1, L2, the packet read and the legal review and authority commands (implemented in @cdf/infrastructure). */
export interface LegalReviewsGateway {
  /** L1: the assigned reviewer's request while its packet is theirs to read. */
  review(ctx: UserRequestContext, requestId: string): Promise<LegalReviewView>;
  /** L2: recorded with counts only; a refusal raises the command's code. */
  choices(ctx: UserRequestContext, packageId: string, act: LegalReviewAct): Promise<LegalReviewChoices>;
  /** api.open_packet: the packet's stored content, recorded (PACKET_VIEWED). */
  openPacket(ctx: UserRequestContext, packetId: string): Promise<PacketView>;
  /** The new request's id. */
  requestLegalReview(ctx: UserRequestContext, input: In<typeof requestLegalReviewSchema>): Promise<string>;
  /** The approval's id. */
  approveRestrictedLegalReview(
    ctx: UserRequestContext,
    input: In<typeof approveRestrictedLegalReviewSchema>,
  ): Promise<string>;
  /** The cancellation's id. */
  cancelLegalReviewRequest(
    ctx: UserRequestContext,
    input: In<typeof cancelLegalReviewRequestSchema>,
  ): Promise<string>;
  giveLegalOpinion(ctx: UserRequestContext, input: In<typeof giveLegalOpinionSchema>): Promise<void>;
  /** The revision's id. */
  giveSupersedingLegalOpinion(
    ctx: UserRequestContext,
    input: In<typeof giveSupersedingLegalOpinionSchema>,
  ): Promise<string>;
  /** The packet's id: the package as submitted. */
  submitToAuthority(ctx: UserRequestContext, input: In<typeof submitToAuthoritySchema>): Promise<string>;
  /** The decision's id. */
  recordAuthorityDecision(
    ctx: UserRequestContext,
    input: In<typeof recordAuthorityDecisionSchema>,
  ): Promise<string>;
}

export interface LegalReviewsDeps {
  gateway: LegalReviewsGateway;
  securityEvents: SecurityEventSink;
}

/**
 * L2's answer: the choices, or the code the command would refuse with now (LEGAL_REVIEW_OPEN, TAINTED_BY_CONFLICT,
 * AUTHORITY_APPROVAL_REQUIRED, APPROVAL_ALREADY_PENDING and the like), which the page explains.
 */
export type LegalReviewChoicesResult =
  { ok: true; choices: LegalReviewChoices } | { ok: false; code: string };

/** The permission api.give_legal_opinion and api.give_superseding_legal_opinion check (migrations 1900 and 2030). */
const OPINION: Permission = "LEGAL_OPINION_GIVE";

export function createLegalReviewsService(deps: LegalReviewsDeps) {
  const { gateway, securityEvents } = deps;

  async function recordDenial(
    ctx: UserRequestContext,
    action: "ACCESS_DENIED" | "COMMAND_DENIED",
    objectType: string,
    name: string,
    error: AppError,
    objectId?: string,
  ) {
    if (error.kind !== "FORBIDDEN" && error.kind !== "NOT_FOUND") return;
    try {
      await securityEvents.record(
        {
          action,
          objectType,
          objectId,
          metadata: action === "COMMAND_DENIED" ? { command: name, outcome: error.kind } : { read: name },
        },
        ctx,
      );
    } catch {
      // Recording must never mask the original denial.
    }
  }

  /** A read the database may refuse: null for NOT_FOUND or FORBIDDEN, recorded as ACCESS_DENIED; anything else thrown. */
  async function read<T>(
    ctx: UserRequestContext,
    objectType: string,
    name: string,
    objectId: string,
    run: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await run();
    } catch (cause) {
      const error = toAppError(cause, ctx.requestId);
      if (error.kind !== "NOT_FOUND" && error.kind !== "FORBIDDEN") throw error;
      await recordDenial(ctx, "ACCESS_DENIED", objectType, name, error, objectId);
      return null;
    }
  }

  async function command<S extends z.ZodType, T>(
    ctx: UserRequestContext,
    name: string,
    schema: S,
    raw: unknown,
    run: (input: In<S>) => Promise<T>,
    objectId: (input: In<S>) => string,
    gate?: { actor: Actor; permission: Permission },
  ): Promise<CommandResult<T>> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
    if (gate && !can(gate.actor, gate.permission)) {
      const error = new AppError("FORBIDDEN", ctx.requestId);
      await recordDenial(ctx, "COMMAND_DENIED", "command", name, error, objectId(parsed.data));
      return { ok: false, error };
    }
    try {
      return { ok: true, value: await run(parsed.data) };
    } catch (cause) {
      const error = toAppError(cause, ctx.requestId);
      await recordDenial(ctx, "COMMAND_DENIED", "command", name, error, objectId(parsed.data));
      return { ok: false, error };
    }
  }

  return {
    /** The reviewer's page: L1, or null (the uniform 404) for anyone but the assignee while the packet is theirs. */
    review: (ctx: UserRequestContext, requestId: string): Promise<LegalReviewView | null> =>
      read(ctx, "legal_review_request", "legal_review_view", requestId, () => gateway.review(ctx, requestId)),

    /** The reviewer's packet: L1, then the packet it names (recorded as PACKET_VIEWED); null as for the request. */
    reviewPacket: async (
      ctx: UserRequestContext,
      requestId: string,
    ): Promise<{ review: LegalReviewView; packet: PacketView } | null> => {
      const review = await read(ctx, "legal_review_request", "legal_review_view", requestId, () =>
        gateway.review(ctx, requestId),
      );
      if (!review) return null;
      const packet = await read(ctx, "packet", "open_packet", review.packetId, () =>
        gateway.openPacket(ctx, review.packetId),
      );
      return packet ? { review, packet } : null;
    },

    /**
     * A packet R2 named to the caller (a review's packet, or the package as submitted to the authority): null when the
     * database refuses it. The page checks first that R2 names it, so that it is shown under the right package.
     */
    packet: (ctx: UserRequestContext, packetId: string): Promise<PacketView | null> =>
      read(ctx, "packet", "open_packet", packetId, () => gateway.openPacket(ctx, packetId)),

    /**
     * L2 for asking for a review (the committee's secretary) or approving one (the restricted case's authority): null
     * for NOT_FOUND or FORBIDDEN (the uniform 404, recorded), the command's refusal code for a CONFLICT.
     */
    choices: async (
      ctx: UserRequestContext,
      packageId: string,
      act: LegalReviewAct,
    ): Promise<LegalReviewChoicesResult | null> => {
      try {
        return { ok: true, choices: await gateway.choices(ctx, packageId, act) };
      } catch (cause) {
        const error = toAppError(cause, ctx.requestId);
        if (error.kind === "CONFLICT") return { ok: false, code: error.detail ?? "CONFLICT" };
        if (error.kind !== "NOT_FOUND" && error.kind !== "FORBIDDEN") throw error;
        await recordDenial(
          ctx,
          "ACCESS_DENIED",
          "recommendation_package",
          "legal_review_choices",
          error,
          packageId,
        );
        return null;
      }
    },

    requestLegalReview: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "request_legal_review",
        requestLegalReviewSchema,
        raw,
        (i) => gateway.requestLegalReview(ctx, i),
        (i) => i.packageId,
      ),
    approveRestrictedLegalReview: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "approve_restricted_legal_review",
        approveRestrictedLegalReviewSchema,
        raw,
        (i) => gateway.approveRestrictedLegalReview(ctx, i),
        (i) => i.packageId,
      ),
    cancelLegalReviewRequest: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "cancel_legal_review_request",
        cancelLegalReviewRequestSchema,
        raw,
        (i) => gateway.cancelLegalReviewRequest(ctx, i),
        (i) => i.requestId,
      ),
    giveLegalOpinion: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        "give_legal_opinion",
        giveLegalOpinionSchema,
        raw,
        (i) => gateway.giveLegalOpinion(ctx, i),
        (i) => i.requestId,
        { actor, permission: OPINION },
      ),
    giveSupersedingLegalOpinion: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        "give_superseding_legal_opinion",
        giveSupersedingLegalOpinionSchema,
        raw,
        (i) => gateway.giveSupersedingLegalOpinion(ctx, i),
        (i) => i.requestId,
        { actor, permission: OPINION },
      ),
    submitToAuthority: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "submit_to_authority",
        submitToAuthoritySchema,
        raw,
        (i) => gateway.submitToAuthority(ctx, i),
        (i) => i.packageId,
      ),
    recordAuthorityDecision: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "record_authority_decision",
        recordAuthorityDecisionSchema,
        raw,
        (i) => gateway.recordAuthorityDecision(ctx, i),
        (i) => i.packageId,
      ),
  };
}

export type LegalReviewsService = ReturnType<typeof createLegalReviewsService>;
