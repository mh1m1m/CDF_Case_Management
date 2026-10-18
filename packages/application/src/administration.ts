/**
 * Administration (UX redesign Phase 12, slice P12-8a; ADR-051's P12-8a amendment). Each page is one administrator's
 * register: the service pre-checks that the caller's permissions open the page (`adminViews`, the first enforcement
 * point, §19), and the gateway asks the database the page's own permission before reading the register from tables
 * whose row-level security returns exactly that register (the second, authoritative). A page the caller may not open
 * is the uniform not-found (null), recorded as ACCESS_DENIED with the page's name only.
 *
 * The business calendar's two forms run `api.set_business_calendar_day` and `api.set_business_week_pattern` (DEC-F02)
 * with the shared schema and a BUSINESS_CALENDAR_ADMIN pre-check; the database decides every input again. A refusal is
 * recorded as COMMAND_DENIED with the command and the outcome only, never the reason typed.
 */
import type {
  Actor,
  AdminCalendarPage,
  AdminCommitteesPage,
  AdminCorrectiveActionPolicyPage,
  AdminExportPolicyPage,
  AdminNotificationRulesPage,
  AdminSectorsPage,
  AdminView,
  Permission,
} from "@cdf/contracts";
import { adminViews, can } from "@cdf/authorization";
import type { SecurityEventSink } from "@cdf/audit";
import { setBusinessCalendarDaySchema, setBusinessWeekPatternSchema } from "@cdf/validation";
import type { z } from "zod";
import { AppError, toAppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { UserRequestContext } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

/**
 * Port over the Administration registers. Each read throws `CDF_FORBIDDEN` unless the database says the caller holds
 * the page's permission (export policy: `authz.is_export_policy_admin()`, DEC-F24), so a refused page is never an
 * empty register.
 */
export interface AdministrationGateway {
  committees(ctx: UserRequestContext): Promise<AdminCommitteesPage>;
  sectors(ctx: UserRequestContext): Promise<AdminSectorsPage>;
  notificationRules(ctx: UserRequestContext): Promise<AdminNotificationRulesPage>;
  exportPolicy(ctx: UserRequestContext): Promise<AdminExportPolicyPage>;
  correctiveActionPolicy(ctx: UserRequestContext): Promise<AdminCorrectiveActionPolicyPage>;
  calendar(ctx: UserRequestContext): Promise<AdminCalendarPage>;
  /** `api.set_business_calendar_day`: the new day's id. */
  setCalendarDay(ctx: UserRequestContext, input: In<typeof setBusinessCalendarDaySchema>): Promise<string>;
  /** `api.set_business_week_pattern`, from the start of the date in Riyadh, as SOURCE_REQUIRED: the new week's id. */
  setWeekPattern(ctx: UserRequestContext, input: In<typeof setBusinessWeekPatternSchema>): Promise<string>;
}

export interface AdministrationDeps {
  gateway: AdministrationGateway;
  securityEvents: SecurityEventSink;
}

const CALENDAR: readonly Permission[] = ["BUSINESS_CALENDAR_ADMIN"];

export function createAdministrationService(deps: AdministrationDeps) {
  const { gateway, securityEvents } = deps;

  async function recordSecurityEvent(
    ctx: UserRequestContext,
    action: "ACCESS_DENIED" | "COMMAND_DENIED",
    objectType: string,
    objectId: string | undefined,
    metadata: Record<string, string>,
  ) {
    try {
      await securityEvents.record({ action, objectType, objectId, metadata }, ctx);
    } catch {
      // Recording must never mask the original outcome.
    }
  }

  /** A page the caller may not open is the uniform not-found (null), recorded as ACCESS_DENIED. */
  async function read<T>(
    ctx: UserRequestContext,
    actor: Actor,
    view: AdminView,
    run: () => Promise<T>,
  ): Promise<T | null> {
    const denied = () =>
      recordSecurityEvent(ctx, "ACCESS_DENIED", "administration", view, { read: view }).then(() => null);
    if (!adminViews(actor).includes(view)) return denied();
    try {
      return await run();
    } catch (cause) {
      const error = toAppError(cause, ctx.requestId);
      if (error.kind !== "NOT_FOUND" && error.kind !== "FORBIDDEN") throw error;
      return denied();
    }
  }

  async function command<S extends z.ZodType, T>(
    ctx: UserRequestContext,
    actor: Actor,
    name: string,
    schema: S,
    raw: unknown,
    permissions: readonly Permission[],
    run: (input: z.output<S>) => Promise<T>,
  ): Promise<CommandResult<T>> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
    const deny = async (error: AppError): Promise<CommandResult<T>> => {
      if (error.kind === "FORBIDDEN" || error.kind === "NOT_FOUND")
        await recordSecurityEvent(ctx, "COMMAND_DENIED", "command", undefined, {
          command: name,
          outcome: error.kind,
        });
      return { ok: false, error };
    };
    if (!permissions.some((p) => can(actor, p))) return deny(new AppError("FORBIDDEN", ctx.requestId));
    try {
      return { ok: true, value: await run(parsed.data) };
    } catch (cause) {
      return deny(toAppError(cause, ctx.requestId));
    }
  }

  return {
    committees: (ctx: UserRequestContext, actor: Actor) =>
      read(ctx, actor, "committees", () => gateway.committees(ctx)),
    sectors: (ctx: UserRequestContext, actor: Actor) =>
      read(ctx, actor, "sectors", () => gateway.sectors(ctx)),
    notificationRules: (ctx: UserRequestContext, actor: Actor) =>
      read(ctx, actor, "notification-rules", () => gateway.notificationRules(ctx)),
    exportPolicy: (ctx: UserRequestContext, actor: Actor) =>
      read(ctx, actor, "export-policy", () => gateway.exportPolicy(ctx)),
    correctiveActionPolicy: (ctx: UserRequestContext, actor: Actor) =>
      read(ctx, actor, "corrective-action-policy", () => gateway.correctiveActionPolicy(ctx)),
    calendar: (ctx: UserRequestContext, actor: Actor) =>
      read(ctx, actor, "calendar", () => gateway.calendar(ctx)),

    /** Records a holiday, a closure or a working day; one entry per date (a change is a withdrawal, then a new one). */
    setCalendarDay: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(ctx, actor, "set_business_calendar_day", setBusinessCalendarDaySchema, raw, CALENDAR, (input) =>
        gateway.setCalendarDay(ctx, input),
      ),

    /** Changes the working week from a later date; the week in force until then is given its end. */
    setWeekPattern: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(ctx, actor, "set_business_week_pattern", setBusinessWeekPatternSchema, raw, CALENDAR, (input) =>
        gateway.setWeekPattern(ctx, input),
      ),
  };
}

export type AdministrationService = ReturnType<typeof createAdministrationService>;
