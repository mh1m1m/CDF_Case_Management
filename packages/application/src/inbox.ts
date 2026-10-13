/**
 * The caller's own in-app notifications and notification settings (UX redesign S4; ADR-025, migration 1920).
 * Reads go through RLS, which returns only the caller's own in-app rows and their own mutes. Each command:
 *   1. validates input with the shared Zod schema (§45),
 *   2. needs no permission: every signed-in user manages their own notifications, and the database decides the rest
 *      (another user's notification answers NOT_FOUND; a mandatory template cannot be muted),
 *   3. runs the api.* command in the caller's security context (the authoritative check),
 *   4. maps failures to safe AppErrors and records refusals as COMMAND_DENIED SECURITY events (§30).
 * A notification carries a template code, ids and a link only (§39, N18); nothing here reads or logs content.
 */
import type { InboxNotification, NotificationSetting } from "@cdf/contracts";
import type { SecurityEventSink } from "@cdf/audit";
import { markNotificationReadSchema, setNotificationPreferencesSchema } from "@cdf/validation";
import type { z } from "zod";
import { toAppError, type AppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { UserRequestContext } from "./ports";

/** The newest notifications shown at once; older ones stay in the outbox. */
export const INBOX_PAGE = 100;

/** Port over the caller's notify.* rows and the api.* notification commands (implemented in @cdf/infrastructure). */
export interface InboxGateway {
  /** The caller's own in-app notifications, newest first. */
  list(ctx: UserRequestContext, limit: number): Promise<InboxNotification[]>;
  unreadCount(ctx: UserRequestContext): Promise<number>;
  /** Every template on both channels, with the platform-wide rule and the caller's own mute. */
  settings(ctx: UserRequestContext): Promise<NotificationSetting[]>;
  markRead(ctx: UserRequestContext, notificationId: string): Promise<void>;
  /** All changes in one transaction: a refused change leaves every setting as it was. */
  setPreferences(
    ctx: UserRequestContext,
    changes: z.output<typeof setNotificationPreferencesSchema>["changes"],
  ): Promise<void>;
}

export interface InboxDeps {
  gateway: InboxGateway;
  securityEvents: SecurityEventSink;
}

export function createInboxService(deps: InboxDeps) {
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
    run: (input: z.output<S>) => Promise<T>,
    objectId: (input: z.output<S>) => string | undefined,
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

  async function query<T>(ctx: UserRequestContext, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      throw toAppError(cause, ctx.requestId);
    }
  }

  return {
    list: (ctx: UserRequestContext, limit = INBOX_PAGE) => query(ctx, () => gateway.list(ctx, limit)),
    unreadCount: (ctx: UserRequestContext) => query(ctx, () => gateway.unreadCount(ctx)),
    settings: (ctx: UserRequestContext) => query(ctx, () => gateway.settings(ctx)),

    markRead: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "mark_notification_read",
        markNotificationReadSchema,
        raw,
        (i) => gateway.markRead(ctx, i.notificationId),
        (i) => i.notificationId,
      ),

    setPreferences: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "set_notification_preference",
        setNotificationPreferencesSchema,
        raw,
        (i) => gateway.setPreferences(ctx, i.changes),
        () => undefined,
      ),
  };
}

export type InboxService = ReturnType<typeof createInboxService>;
