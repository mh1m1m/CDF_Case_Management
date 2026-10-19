/**
 * Administration (UX redesign Phase 12, slices P12-8a and P12-8b; ADR-051's P12-8a amendment, ADR-063). Each page is
 * one administrator's register: the service pre-checks that the caller's permissions open the page (`adminViews`, the
 * first enforcement point, §19), and the gateway asks the database before reading the register from tables whose
 * row-level security returns exactly that register (the second, authoritative). A page the caller may not open is the
 * uniform not-found (null), recorded as ACCESS_DENIED with the page's name only. Since P12-8b (migration 2127) the
 * list of pages comes from the database (`api.my_admin_views`, F3), and each page carries its capability read: which
 * of its controls the database would accept from the caller now.
 *
 * Each form runs one command with its own schema and the page's permission as the pre-check; the database decides
 * every input again. Five page rules narrow what a command would take (coordinator rulings on F4, 2026-10-18 21:17,
 * and of 23:20 and 23:50): a new export rule is for a new code only, never a new version of an existing one; a
 * mandatory notice takes no rule; a corrective-action policy's completion rule is never looser than a version in force
 * or scheduled; a committee's rules never change an option that follows a decision (`DECIDED_RULE_KEYS`); and a
 * committee's safeguards are kept or made stricter, never loosened (`TIGHTEN_ONLY_RULE_KEYS`). Every change
 * a form records is provisional (SOURCE_REQUIRED), awaiting the CDF source, except an export purpose, which its
 * command records as the administrator's own catalogue entry (DEC-F21). A refusal is recorded as COMMAND_DENIED with
 * the command and the outcome only, never the reason typed.
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
  CompletionEvidenceRule,
} from "@cdf/contracts";
import { adminViews, can, canAdministerExportPolicy } from "@cdf/authorization";
import type { SecurityEventSink } from "@cdf/audit";
import {
  addExportPurposeSchema,
  addExportRuleSchema,
  createSectorSchema,
  editExportPurposeSchema,
  EDITABLE_RULE_KEYS,
  isDecidedRuleKey,
  RULE_SET_REVISION_KEYS,
  reviseCommitteeRuleSetSchema,
  revokeReferralDelegationSchema,
  safeguardFloor,
  safeguardStrictness,
  setBusinessCalendarDaySchema,
  setBusinessWeekPatternSchema,
  correctiveActionPolicyVersionSchema,
  setNotificationRuleSchema,
  TIGHTEN_ONLY_RULE_KEYS,
  withdrawBusinessCalendarDaySchema,
  type RuleSafeguards,
  type RuleSetRevisionKey,
  type TightenOnlyRuleKey,
} from "@cdf/validation";
import type { z } from "zod";
import { AppError, toAppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { UserRequestContext } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

/** A corrective-action policy version's completion rule, as the completion command reads it (2040; DEC-F27). */
export interface CompletionRule {
  completionEvidence: CompletionEvidenceRule;
  /** Null: any kind in the catalogue, and none needed. */
  allowedEvidenceTypes: readonly string[] | null;
}

/**
 * Whether completing an action needs an evidence reference: `api.submit_corrective_action_completion`'s own
 * comparison (`completion_evidence is distinct from 'NOTE_ONLY'`).
 */
export const needsEvidenceReference = (rule: CompletionEvidenceRule): boolean => rule !== "NOTE_ONLY";

/**
 * Whether a reference of evidence kind `kind` is accepted: the completion command's own comparison (a listed kind,
 * or any kind where the version lists none).
 */
export const acceptsEvidenceKind = (kinds: readonly string[] | null, kind: string): boolean =>
  kinds === null || kinds.includes(kind);

/**
 * "Never looser" (coordinator ruling on F4, 2026-10-18 21:17): a new policy version may not accept a completion that a
 * version in force or scheduled refuses. A version that needs a reference is followed by one that does too; a version
 * that lists the kinds of evidence it accepts is followed by one that lists only kinds it accepts. Null when `next` is
 * never looser than any of `versions`, else the refusal's code.
 */
export function looserCompletionRule(
  next: CompletionRule,
  versions: readonly CompletionRule[],
): "LOOSER_COMPLETION_EVIDENCE" | "LOOSER_EVIDENCE_TYPES" | null {
  if (
    versions.some(
      (v) => needsEvidenceReference(v.completionEvidence) && !needsEvidenceReference(next.completionEvidence),
    )
  )
    return "LOOSER_COMPLETION_EVIDENCE";
  const nextKinds = next.allowedEvidenceTypes;
  if (
    versions.some(
      (v) =>
        v.allowedEvidenceTypes !== null &&
        (nextKinds === null || nextKinds.some((k) => !acceptsEvidenceKind(v.allowedEvidenceTypes, k))),
    )
  )
    return "LOOSER_EVIDENCE_TYPES";
  return null;
}

/** A committee rule set version in force or scheduled, as the "never looser" check for safeguards reads it. */
export interface RuleSetSafeguards extends RuleSafeguards {
  /** The version open now (no end yet): the one a revision starts from, and whose values it carries. */
  open: boolean;
}

/**
 * "Never looser" for a committee's safeguards (coordinator ruling of 2026-10-18 23:50; `TIGHTEN_ONLY_RULE_KEYS`): each
 * safeguard of the new version, as sent or as carried from the version open now, is at least as strict as in every
 * version in force or scheduled. Null when it is, else the first safeguard that would be looser.
 */
export function looserRuleSafeguard(
  input: In<typeof reviseCommitteeRuleSetSchema>,
  versions: readonly RuleSetSafeguards[],
): TightenOnlyRuleKey | null {
  const open = versions.find((v) => v.open);
  for (const key of Object.keys(TIGHTEN_ONLY_RULE_KEYS) as TightenOnlyRuleKey[]) {
    const sent = input[key];
    const next = sent !== undefined ? sent : open?.[key];
    const floor = safeguardFloor(key, versions);
    // Nothing sent and no version open, or no version at all: the command refuses the revision itself (NO_RULE_SET),
    // or the caller (a caller who cannot see the committee reads no version).
    if (next === undefined || floor === undefined) continue;
    if (safeguardStrictness(key, next as RuleSafeguards[typeof key]) < safeguardStrictness(key, floor))
      return key;
  }
  return null;
}

/**
 * Port over the Administration registers. Each read throws `CDF_FORBIDDEN` unless the database says the caller holds
 * the page's permission (export policy: `authz.is_export_policy_admin()`, DEC-F24), so a refused page is never an
 * empty register. Each command throws what its database command refuses.
 */
export interface AdministrationGateway {
  /** `api.my_admin_views` (2127, F3): the Administration pages the database opens to the caller, in its order. */
  views(ctx: UserRequestContext): Promise<AdminView[]>;
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
  /** `api.withdraw_business_calendar_day`. */
  withdrawCalendarDay(
    ctx: UserRequestContext,
    input: In<typeof withdrawBusinessCalendarDaySchema>,
  ): Promise<void>;
  /** `api.create_sector`: the new sector's id. */
  createSector(ctx: UserRequestContext, input: In<typeof createSectorSchema>): Promise<string>;
  /** `api.revoke_referral_delegation`. */
  revokeDelegation(ctx: UserRequestContext, input: In<typeof revokeReferralDelegationSchema>): Promise<void>;
  /** `api.set_notification_rule`, from the start of the date in Riyadh: the new rule's id. */
  setNotificationRule(ctx: UserRequestContext, input: In<typeof setNotificationRuleSchema>): Promise<string>;
  /**
   * `api.set_export_rule` for a code with no rule yet, from the start of the date in Riyadh, as SOURCE_REQUIRED: the new
   * rule's id. Refuses `CDF_CONFLICT:RULE_CODE_EXISTS` for a code the register already has, under the command's own
   * lock on the code, so two administrators adding one code at once cannot make the second a new version of it.
   */
  addExportRule(ctx: UserRequestContext, input: In<typeof addExportRuleSchema>): Promise<string>;
  /** `api.set_export_purpose` with no version (a code not in the catalogue) or the version read (F13). */
  setExportPurpose(
    ctx: UserRequestContext,
    input: In<typeof addExportPurposeSchema> | In<typeof editExportPurposeSchema>,
  ): Promise<void>;
  /**
   * `api.set_corrective_action_policy` (12 arguments), from the start of the date in Riyadh, as SOURCE_REQUIRED: the
   * new version's id. First, under the command's own lock on the action type, `guard` is given the completion rules of
   * the type's versions in force or scheduled; a code it returns refuses the change (`CDF_CONFLICT:<code>`).
   */
  setCorrectiveActionPolicy(
    ctx: UserRequestContext,
    input: In<typeof correctiveActionPolicyVersionSchema>,
    guard: (versions: CompletionRule[]) => string | null,
  ): Promise<string>;
  /**
   * `api.revise_committee_rule_set` with the options changed (the command's names), from the start of the date in
   * Riyadh, as SOURCE_REQUIRED: the new version's id. First, under a lock on the committee's revisions, `guard` is
   * given the safeguards of the committee's versions in force or scheduled, the open one marked; a code it returns
   * refuses the change (`CDF_CONFLICT:<code>`).
   */
  reviseCommitteeRuleSet(
    ctx: UserRequestContext,
    input: { committeeId: string; effectiveFrom: string; changes: Record<string, unknown>; reason: string },
    guard: (versions: RuleSetSafeguards[]) => string | null,
  ): Promise<string>;
}

export interface AdministrationDeps {
  gateway: AdministrationGateway;
  securityEvents: SecurityEventSink;
}

type PreCheck = (actor: Actor) => boolean;
const calendarAdmin: PreCheck = (a) => can(a, "BUSINESS_CALENDAR_ADMIN");
const sectorAdmin: PreCheck = (a) => can(a, "SECTOR_ADMIN");
const notificationAdmin: PreCheck = (a) => can(a, "NOTIFICATION_ADMIN");
const exportPolicyAdmin: PreCheck = (a) => canAdministerExportPolicy(a);
const policyAdmin: PreCheck = (a) => can(a, "CORRECTIVE_ACTION_POLICY_ADMIN");
const committeeAdmin: PreCheck = (a) => can(a, "COMMITTEE_ADMIN");

/**
 * The options a revision changes, by the command's names; null clears an option. Only the options the page may change
 * are ever named: an option that follows a decision never reaches the command from here, even if it reached this.
 */
export function ruleSetChanges(input: In<typeof reviseCommitteeRuleSetSchema>): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of EDITABLE_RULE_KEYS) {
    const value = input[key];
    if (value !== undefined) changes[RULE_SET_REVISION_KEYS[key]] = value;
  }
  return changes;
}

/** The options a revision names that follow a decision (coordinator ruling of 2026-10-18 23:20), whatever their value. */
export function decidedOptionsNamed(input: In<typeof reviseCommitteeRuleSetSchema>): RuleSetRevisionKey[] {
  return (Object.keys(RULE_SET_REVISION_KEYS) as RuleSetRevisionKey[]).filter(
    (key) => isDecidedRuleKey(key) && input[key] !== undefined,
  );
}

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
    allowed: PreCheck,
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
    if (!allowed(actor)) return deny(new AppError("FORBIDDEN", ctx.requestId));
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

    /** The Administration pages the database opens to the caller (F3): the frame's list and the landing's choice. */
    views: (ctx: UserRequestContext) => gateway.views(ctx),

    /** Records a holiday, a closure or a working day; one entry per date (a change is a withdrawal, then a new one). */
    setCalendarDay: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "set_business_calendar_day",
        setBusinessCalendarDaySchema,
        raw,
        calendarAdmin,
        (input) => gateway.setCalendarDay(ctx, input),
      ),
    /** Changes the working week from a later date; the week in force until then is given its end. */
    setWeekPattern: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "set_business_week_pattern",
        setBusinessWeekPatternSchema,
        raw,
        calendarAdmin,
        (input) => gateway.setWeekPattern(ctx, input),
      ),
    /** Withdraws a day from today on; the entry stays, with who withdrew it and why. */
    withdrawCalendarDay: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "withdraw_business_calendar_day",
        withdrawBusinessCalendarDaySchema,
        raw,
        calendarAdmin,
        (input) => gateway.withdrawCalendarDay(ctx, input),
      ),

    /** Creates a sector; its positions are appointed later (F5, F7). */
    createSector: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(ctx, actor, "create_sector", createSectorSchema, raw, sectorAdmin, (input) =>
        gateway.createSector(ctx, input),
      ),
    /** Revokes a delegated referral approval; the delegation stays on record, with who revoked it and why. */
    revokeDelegation: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "revoke_referral_delegation",
        revokeReferralDelegationSchema,
        raw,
        sectorAdmin,
        (input) => gateway.revokeDelegation(ctx, input),
      ),

    /**
     * Turns a notice on or off from a later date, platform-wide or as a committee's default. A mandatory notice is
     * always sent: no rule changes it, so none is taken (CONFLICT MANDATORY_NOTICE).
     */
    setNotificationRule: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "set_notification_rule",
        setNotificationRuleSchema,
        raw,
        notificationAdmin,
        async (input) => {
          const { templates } = await gateway.notificationRules(ctx);
          if (templates.find((t) => t.code === input.templateCode)?.isMandatory)
            throw new AppError("CONFLICT", ctx.requestId, "MANDATORY_NOTICE");
          return gateway.setNotificationRule(ctx, input);
        },
      ),

    /** Adds a rule for a new code; a code that has a rule keeps it (RULE_CODE_EXISTS). */
    addExportRule: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(ctx, actor, "set_export_rule", addExportRuleSchema, raw, exportPolicyAdmin, (input) =>
        gateway.addExportRule(ctx, input),
      ),
    /** Adds a purpose to the catalogue. A code already there is changed from its row (STALE_VERSION). */
    addExportPurpose: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(ctx, actor, "set_export_purpose", addExportPurposeSchema, raw, exportPolicyAdmin, (input) =>
        gateway.setExportPurpose(ctx, input),
      ),
    /** Changes a purpose at the version read (F13); a legacy purpose is refused by the command (LEGACY_PURPOSE). */
    editExportPurpose: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(ctx, actor, "set_export_purpose", editExportPurposeSchema, raw, exportPolicyAdmin, (input) =>
        gateway.setExportPurpose(ctx, input),
      ),

    /** A new version of an action type's policy from a later date, never looser than one in force or scheduled. */
    setCorrectiveActionPolicy: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "set_corrective_action_policy",
        correctiveActionPolicyVersionSchema,
        raw,
        policyAdmin,
        (input) =>
          gateway.setCorrectiveActionPolicy(ctx, input, (versions) => looserCompletionRule(input, versions)),
      ),

    /**
     * A new version of a committee's rules from a later date, with only the options changed. An option that follows
     * a decision is never changed here, whatever the value sent: the page shows it read-only, and a revision that names
     * one is refused before the command is asked (CONFLICT DECIDED_OPTION; coordinator rulings of 2026-10-18 23:20 and
     * 23:50). A safeguard is kept or made stricter, never loosened: in the command's transaction, before the command
     * is asked, a new version looser than one in force or scheduled is refused (CONFLICT LOOSER_RULE_OPTION; 23:50).
     */
    reviseCommitteeRuleSet: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "revise_committee_rule_set",
        reviseCommitteeRuleSetSchema,
        raw,
        committeeAdmin,
        async (input) => {
          if (decidedOptionsNamed(input).length > 0)
            throw new AppError("CONFLICT", ctx.requestId, "DECIDED_OPTION");
          const changes = ruleSetChanges(input);
          if (Object.keys(changes).length === 0) throw new AppError("INVALID", ctx.requestId, "changes");
          return gateway.reviseCommitteeRuleSet(
            ctx,
            {
              committeeId: input.committeeId,
              effectiveFrom: input.effectiveFrom,
              changes,
              reason: input.reason,
            },
            (versions) => (looserRuleSafeguard(input, versions) ? "LOOSER_RULE_OPTION" : null),
          );
        },
      ),
  };
}

export type AdministrationService = ReturnType<typeof createAdministrationService>;
