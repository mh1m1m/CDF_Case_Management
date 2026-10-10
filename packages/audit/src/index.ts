/**
 * Audit and security-event vocabulary (§29, §30) and the SecurityEventSink port.
 *
 * Business events are written by the database command functions in the same transaction as the change.
 * The application writes only SECURITY events for denials it observes (a denied command's own transaction
 * rolls back, so the denial must be recorded separately).
 * PRODUCTION_SUBSTITUTION_REQUIRED: production forwards SECURITY events to Alibaba SLS / the CDF SIEM.
 */

/** Actions the application may record; mirrors the allow-list in api.record_security_event. */
export const SECURITY_EVENT_ACTIONS = [
  "ACCESS_DENIED",
  "COMMAND_DENIED",
  "SESSION_REJECTED",
  "VALIDATION_REJECTED",
] as const;
export type SecurityEventAction = (typeof SECURITY_EVENT_ACTIONS)[number];

export interface SecurityEvent {
  action: SecurityEventAction;
  objectType?: string;
  objectId?: string;
  /** Small, non-sensitive context. Never identities, credentials, free text or evidence (§83). */
  metadata?: Record<string, string | number | boolean | null>;
}

export interface SecurityEventSink {
  record(event: SecurityEvent, context: { userId: string | null; requestId: string }): Promise<void>;
}

/** Keys that must never appear in event metadata. Enforced by sinks before writing. */
const FORBIDDEN_METADATA_KEY = /(name|email|phone|password|secret|token|identity|description|body|content)/i;

export function assertSafeMetadata(metadata: SecurityEvent["metadata"]): void {
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (FORBIDDEN_METADATA_KEY.test(key)) throw new Error(`Unsafe security-event metadata key: ${key}`);
    if (typeof value === "string" && value.length > 120)
      throw new Error(`Security-event metadata value too long: ${key}`);
  }
}

/** Business audit actions shown on the case timeline, with i18n keys. */
export const TIMELINE_ACTIONS = [
  "CASE_CREATED",
  "CASE_VIEWED",
  "CASE_UPDATED",
  "CASE_ASSIGNED",
  "CASE_UNASSIGNED",
  "CASE_REASSIGNED",
  "CASE_ACCESS_GRANTED",
  "CASE_ACCESS_REVOKED",
  "CLASSIFICATION_CHANGED",
  "CONFLICT_DECLARED",
  "CONFLICT_DECIDED",
  "WORKFLOW_TRANSITION",
  "CASE_CLOSED",
  "CASE_REOPENED",
  "REPORT_MESSAGE_SENT",
  "REPORTER_MESSAGE_RECEIVED",
  "EVIDENCE_RECEIVED",
  "EVIDENCE_STORED",
  "EVIDENCE_REJECTED",
  "EVIDENCE_DOWNLOADED",
  "FORM_STARTED",
  "FORM_SAVED",
  "FORM_PREPARED",
  "FORM_REVIEWED",
  "FORM_RETURNED",
  "FORM_APPROVED",
  "FORM_WITHDRAWN",
  "FORM_VIEWED",
] as const;
