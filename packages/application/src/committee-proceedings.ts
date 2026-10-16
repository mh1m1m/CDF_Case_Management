/**
 * The proceeding before the committee (UX redesign Phase 12 P12-2c; ADR-056, migrations 2060 and 2086). The page reads
 * the purpose read models only, never the case:
 *   - the proceeding as the caller's seat gives it (api.my_committees and api.committee_view, the seat basis of 2085):
 *     the case team, who see a proceeding through the case, get no committee page for it;
 *   - its packages and finding votes (read model R2, api.committee_items_view), with each package command's answer
 *     for the caller now (2086), and each item's flags (api.recommendation_item_flags);
 *   - for whoever builds packages now, the choices (R1, api.committee_scope_choices) and the sanction catalogue.
 * Each command:
 *   1. validates input with the shared Zod schema (§45),
 *   2. needs no permission code: who may act comes from the caller's seat, the package's state and the meeting's,
 *      which only the database knows (the committee's secretary passing the case gate, not conflicted),
 *   3. runs the api.* command in the caller's security context (the authoritative check),
 *   4. maps failures to safe AppErrors and records refusals as COMMAND_DENIED SECURITY events (§30).
 * A proceeding the seat does not give is the uniform not-found, recorded as ACCESS_DENIED. Reasons, descriptions and
 * proposed sanctions are committee content: they are never logged.
 */
import type {
  CommitteeItemsView,
  CommitteeProceedingPage,
  CommitteeScopeChoices,
  SanctionCatalogueChoice,
} from "@cdf/contracts";
import type { SecurityEventSink } from "@cdf/audit";
import {
  addRecommendationItemSchema,
  createRecommendationPackageSchema,
  openPackageVoteSchema,
  recordPackageAdoptionSchema,
  resolveConflictTaintSchema,
  returnPackageToCommitteeSchema,
  submitPackageForVoteSchema,
  withdrawRecommendationItemSchema,
} from "@cdf/validation";
import type { z } from "zod";
import type { CommitteesGateway } from "./committees";
import { AppError, toAppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { UserRequestContext } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

/** Port over R1, R2, the item flags, the catalogue and the package commands (implemented in @cdf/infrastructure). */
export interface CommitteeProceedingsGateway {
  /** R2, with each item's flags. */
  itemsView(ctx: UserRequestContext, committeeProceedingId: string): Promise<CommitteeItemsView>;
  /** R1. */
  scopeChoices(ctx: UserRequestContext, committeeProceedingId: string): Promise<CommitteeScopeChoices>;
  /** The active sanction codes with the catalogue version in force (reference data). */
  sanctionCatalogue(ctx: UserRequestContext): Promise<SanctionCatalogueChoice[]>;
  /** The new package's id. */
  createPackage(
    ctx: UserRequestContext,
    input: In<typeof createRecommendationPackageSchema>,
  ): Promise<string>;
  /** The new item's id. */
  addItem(ctx: UserRequestContext, input: In<typeof addRecommendationItemSchema>): Promise<string>;
  withdrawItem(ctx: UserRequestContext, input: In<typeof withdrawRecommendationItemSchema>): Promise<void>;
  /** The round the package is put to the vote in. */
  submitForVote(ctx: UserRequestContext, input: In<typeof submitPackageForVoteSchema>): Promise<number>;
  /** How many vote items opened (one, or one per item). */
  openPackageVote(ctx: UserRequestContext, input: In<typeof openPackageVoteSchema>): Promise<number>;
  /** ADOPTED, or DRAFT when the committee approved no item. */
  recordAdoption(ctx: UserRequestContext, input: In<typeof recordPackageAdoptionSchema>): Promise<string>;
  /** The return's id. */
  returnToCommittee(
    ctx: UserRequestContext,
    input: In<typeof returnPackageToCommitteeSchema>,
  ): Promise<string>;
  /** The resolution's id. */
  resolveTaint(ctx: UserRequestContext, input: In<typeof resolveConflictTaintSchema>): Promise<string>;
}

export interface CommitteeProceedingsDeps {
  /** The seat basis: My Committees and the committee page's read models (P12-2b). */
  committees: CommitteesGateway;
  gateway: CommitteeProceedingsGateway;
  securityEvents: SecurityEventSink;
}

/** Whether the caller builds packages now, by the commands' own answers in R2. */
export function buildsPackages(items: CommitteeItemsView | null): boolean {
  return (
    items !== null &&
    (items.capabilities.mayCreatePackage || items.packages.some((p) => p.capabilities.mayAddItem))
  );
}

export function createCommitteeProceedingsService(deps: CommitteeProceedingsDeps) {
  const { committees, gateway, securityEvents } = deps;

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

  /** A part of the page the database may refuse: null for a refusal of these kinds, any other failure thrown. */
  async function part<T>(
    ctx: UserRequestContext,
    refusals: readonly string[],
    run: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await run();
    } catch (cause) {
      const error = toAppError(cause, ctx.requestId);
      if (!refusals.includes(error.kind)) throw error;
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
  ): Promise<CommandResult<T>> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
    try {
      return { ok: true, value: await run(parsed.data) };
    } catch (cause) {
      const error = toAppError(cause, ctx.requestId);
      await recordDenial(ctx, "COMMAND_DENIED", "command", name, error, objectId(parsed.data));
      return { ok: false, error };
    }
  }

  return {
    /**
     * The proceeding page, or null (the uniform 404, recorded as ACCESS_DENIED) unless one of the caller's committees
     * lists the proceeding on their seat. R2 refuses a seat holder who declared a conflict in one of its meetings: the
     * page then shows the proceeding without its packages. R1 and the catalogue are read only for whoever builds
     * packages now; R1 refusing them (a closed proceeding, CDF-226) leaves the builder out.
     */
    proceeding: async (
      ctx: UserRequestContext,
      committeeProceedingId: string,
    ): Promise<CommitteeProceedingPage | null> => {
      let found: Pick<CommitteeProceedingPage, "committee" | "mySeat" | "proceeding"> | null = null;
      try {
        for (const c of await committees.myCommittees(ctx)) {
          const view = await part(ctx, ["NOT_FOUND"], () => committees.committeeView(ctx, c.committeeId));
          const p = view?.proceedings.find((x) => x.committeeProceedingId === committeeProceedingId);
          if (view && p) {
            found = {
              committee: {
                committeeId: view.committee.committeeId,
                code: view.committee.code,
                kind: view.committee.kind,
              },
              mySeat: view.mySeat.seat,
              proceeding: p,
            };
            break;
          }
        }
      } catch (cause) {
        throw toAppError(cause, ctx.requestId);
      }
      if (!found) {
        await recordDenial(
          ctx,
          "ACCESS_DENIED",
          "committee_proceeding",
          "committee_proceeding",
          new AppError("NOT_FOUND", ctx.requestId),
          committeeProceedingId,
        );
        return null;
      }
      const items = await part(ctx, ["NOT_FOUND"], () => gateway.itemsView(ctx, committeeProceedingId));
      const builds = buildsPackages(items);
      const scope = builds
        ? await part(ctx, ["NOT_FOUND", "FORBIDDEN", "CONFLICT"], () =>
            gateway.scopeChoices(ctx, committeeProceedingId),
          )
        : null;
      const adds = scope !== null && (items?.packages.some((p) => p.capabilities.mayAddItem) ?? false);
      const catalogue = adds ? await gateway.sanctionCatalogue(ctx) : [];
      return { ...found, items, scope, catalogue };
    },

    /**
     * R1 alone, for the meeting's finding vote: null when the database refuses the caller (anyone but the committee's
     * secretary, a closed proceeding, an inactive case).
     */
    scopeChoices: (ctx: UserRequestContext, committeeProceedingId: string) =>
      part(ctx, ["NOT_FOUND", "FORBIDDEN", "CONFLICT"], () =>
        gateway.scopeChoices(ctx, committeeProceedingId),
      ),

    createPackage: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "create_recommendation_package",
        createRecommendationPackageSchema,
        raw,
        (i) => gateway.createPackage(ctx, i),
        (i) => i.committeeProceedingId,
      ),
    addItem: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "add_recommendation_item",
        addRecommendationItemSchema,
        raw,
        (i) => gateway.addItem(ctx, i),
        (i) => i.packageId,
      ),
    withdrawItem: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "withdraw_recommendation_item",
        withdrawRecommendationItemSchema,
        raw,
        (i) => gateway.withdrawItem(ctx, i),
        (i) => i.itemId,
      ),
    submitForVote: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "submit_package_for_vote",
        submitPackageForVoteSchema,
        raw,
        (i) => gateway.submitForVote(ctx, i),
        (i) => i.packageId,
      ),
    openPackageVote: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "open_package_vote",
        openPackageVoteSchema,
        raw,
        (i) => gateway.openPackageVote(ctx, i),
        (i) => i.packageId,
      ),
    recordAdoption: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "record_package_adoption",
        recordPackageAdoptionSchema,
        raw,
        (i) => gateway.recordAdoption(ctx, i),
        (i) => i.packageId,
      ),
    returnToCommittee: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "return_package_to_committee",
        returnPackageToCommitteeSchema,
        raw,
        (i) => gateway.returnToCommittee(ctx, i),
        (i) => i.packageId,
      ),
    resolveTaint: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "resolve_conflict_taint",
        resolveConflictTaintSchema,
        raw,
        (i) => gateway.resolveTaint(ctx, i),
        (i) => i.itemId,
      ),
  };
}

export type CommitteeProceedingsService = ReturnType<typeof createCommitteeProceedingsService>;
