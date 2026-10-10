/**
 * Purpose-bound, task-scoped and lifecycle-aware access (ADR-014, CDF-73): application mirror.
 *
 * Mirrors the authz.* predicates of migration 20261007001700. Defense in depth only: the database
 * (RLS + authz.* + api.* commands) enforces the same rules independently, whatever the UI does.
 *
 * Each purpose has its own function. There is deliberately no single "can view case" that answers
 * for every lifecycle purpose, and no rule of the form "role X sees all cases".
 */
import type {
  Actor,
  CaseTaskStatus,
  CaseTaskType,
  Classification,
  Permission,
  RecordsState,
} from "@cdf/contracts";
import { CASE_TASK_TYPES } from "@cdf/contracts";
import { can, withinClearance } from "./index";

/** A task assigned to the actor on the case being evaluated. */
export interface CaseTaskGrant {
  taskType: CaseTaskType;
  scope: readonly Permission[];
  status: CaseTaskStatus;
  accessGrantedAt: Date;
  expiresAt: Date;
}

/** Everything the decision needs about one case and the actor's relationships to it. */
export interface CaseAccessContext {
  classification: Classification;
  isRestricted: boolean;
  recordsState: RecordsState;
  /** Declared or confirmed conflict of interest of the actor on this case. */
  hasConflict: boolean;
  hasAssignment: boolean;
  hasGrant: boolean;
  /** Approved, unexpired break-glass access of the actor on this case. */
  hasBreakGlass: boolean;
  tasks: readonly CaseTaskGrant[];
}

type Subject = Pick<Actor, "permissions" | "clearance">;

function gate(actor: Subject, c: CaseAccessContext): boolean {
  return withinClearance(actor, c.classification) && !c.hasConflict;
}

function activeTask(t: CaseTaskGrant, now: Date): boolean {
  return (t.status === "OPEN" || t.status === "IN_PROGRESS") && t.accessGrantedAt <= now && t.expiresAt > now;
}

/** authz.user_task_grants: an active task whose scope holds the capability, and (except metadata) the role permission. */
export function taskGrants(
  actor: Subject,
  c: CaseAccessContext,
  capability: Permission,
  now: Date = new Date(),
): boolean {
  if (!gate(actor, c)) return false;
  if (capability !== "CASE_VIEW_METADATA" && !can(actor, capability)) return false;
  return c.tasks.some((t) => activeTask(t, now) && t.scope.includes(capability));
}

/** authz.user_records_catalogue_scope: post-closure, non-restricted, within clearance, no conflict. */
export function inRecordsCatalogueScope(actor: Subject, c: CaseAccessContext): boolean {
  return (
    can(actor, "ARCHIVE_RECORD_VIEW") && gate(actor, c) && c.recordsState !== "ACTIVE" && !c.isRestricted
  );
}

/** Controlled exact-match lookup only; never browsing or wildcard search (§6). */
export function canDiscoverCase(actor: Subject | null | undefined): boolean {
  return !!actor && can(actor, "CASE_DISCOVER");
}

/** Case content: explicit relationship or break-glass. Tasks and the catalogue never confer content. */
export function canViewCaseContent(actor: Subject, c: CaseAccessContext): boolean {
  if (c.recordsState === "DISPOSED" || !gate(actor, c)) return false;
  return (!c.isRestricted && can(actor, "CASE_VIEW_ALL")) || c.hasAssignment || c.hasGrant || c.hasBreakGlass;
}

/** Minimum metadata: content access OR catalogue scope OR a task (§13). */
export function canViewCaseMetadata(actor: Subject, c: CaseAccessContext, now: Date = new Date()): boolean {
  return (
    canViewCaseContent(actor, c) ||
    inRecordsCatalogueScope(actor, c) ||
    taskGrants(actor, c, "CASE_VIEW_METADATA", now)
  );
}

export const canViewRecordsCatalogue = canViewCaseMetadata;

export function canManageRetention(actor: Subject, c: CaseAccessContext, now: Date = new Date()): boolean {
  return (
    can(actor, "RETENTION_CLASS_ASSIGN") &&
    ((inRecordsCatalogueScope(actor, c) && can(actor, "ARCHIVE_RECORD_ADMINISTER")) ||
      taskGrants(actor, c, "RETENTION_TASK_EXECUTE", now))
  );
}

/** Requesting and executing disposition (approval is canApproveDisposition). */
export function canManageDisposition(actor: Subject, c: CaseAccessContext, now: Date = new Date()): boolean {
  return (
    can(actor, "DISPOSITION_REQUEST") &&
    ((inRecordsCatalogueScope(actor, c) && can(actor, "ARCHIVE_RECORD_ADMINISTER")) ||
      taskGrants(actor, c, "DISPOSITION_TASK_EXECUTE", now))
  );
}

export function canApproveDisposition(actor: Subject, c: CaseAccessContext, now: Date = new Date()): boolean {
  return (
    can(actor, "DISPOSITION_APPROVE") &&
    (canViewCaseContent(actor, c) ||
      inRecordsCatalogueScope(actor, c) ||
      taskGrants(actor, c, "DISPOSITION_TASK_VIEW", now))
  );
}

export function canRequestLegalHold(actor: Subject, c: CaseAccessContext, now: Date = new Date()): boolean {
  return (
    can(actor, "LEGAL_HOLD_REQUEST") &&
    c.recordsState !== "DISPOSED" &&
    (canViewCaseContent(actor, c) ||
      inRecordsCatalogueScope(actor, c) ||
      taskGrants(actor, c, "LEGAL_HOLD_REQUEST", now))
  );
}

export function canReviewLegalHold(actor: Subject, c: CaseAccessContext, now: Date = new Date()): boolean {
  return (
    can(actor, "LEGAL_HOLD_REVIEW") &&
    (canViewCaseContent(actor, c) || taskGrants(actor, c, "LEGAL_HOLD_REVIEW", now))
  );
}

export function canApplyLegalHold(actor: Subject, c: CaseAccessContext, now: Date = new Date()): boolean {
  return (
    can(actor, "LEGAL_HOLD_APPLY") &&
    !c.hasConflict &&
    c.recordsState !== "DISPOSED" &&
    (canViewCaseContent(actor, c) ||
      inRecordsCatalogueScope(actor, c) ||
      taskGrants(actor, c, "LEGAL_HOLD_APPLY", now))
  );
}

export function canReleaseLegalHold(actor: Subject, c: CaseAccessContext, now: Date = new Date()): boolean {
  return (
    can(actor, "LEGAL_HOLD_RELEASE") &&
    !c.hasConflict &&
    (canViewCaseContent(actor, c) ||
      inRecordsCatalogueScope(actor, c) ||
      taskGrants(actor, c, "LEGAL_HOLD_RELEASE", now))
  );
}

/** The capabilities a task type may confer; always a subset that excludes case content. */
export function taskTypeCapabilities(taskType: CaseTaskType): readonly Permission[] {
  return CASE_TASK_TYPES.find((t) => t.code === taskType)?.allowedCapabilities ?? [];
}
