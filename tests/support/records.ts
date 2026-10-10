// Fixtures for the records, retention and legal hold suites (ADR-013).
// Everything runs inside a rolled-back scenario; nothing persists in the seed.
import type { Tx } from "@cdf/infrastructure";
import { USERS, type OwnerScenario, type Scenario, type UserKey } from "./db";

export const JUSTIFICATION = "Synthetic: preservation required for a pending synthetic inquiry.";
export const DECISION = "Synthetic decision reason.";

export const PURPOSE = "Synthetic purpose for the records and legal suites.";

/**
 * Assigns a purpose-bound case task (ADR-014). Records and legal staff reach a case only through a task,
 * a catalogue scope, a case relationship or break-glass, so the records suites set one up explicitly.
 * Leaves the scenario acting as `by`.
 */
export async function giveTask(
  s: Scenario,
  caseId: string,
  user: UserKey,
  taskType: string,
  opts: { by?: UserKey; scope?: string[] | null; expiresAt?: Date | null } = {},
): Promise<string> {
  await s.as(opts.by ?? "caseManager");
  const [row] = await s.tx<{ id: string }[]>`
    select api.create_case_task(${caseId}, ${taskType}, ${USERS[user]}, ${PURPOSE},
      ${opts.scope ?? null}::text[], null, ${opts.expiresAt ?? null}::timestamptz) as id`;
  return row!.id;
}

/** Legal-hold tasks on one case: legal may apply and release, legalB may decide the release. */
export async function legalHoldTasks(
  s: Scenario,
  caseId: string,
  by: UserKey = "caseManager",
): Promise<void> {
  await giveTask(s, caseId, "legal", "LEGAL_HOLD_APPLICATION", { by });
  await giveTask(s, caseId, "legal", "LEGAL_HOLD_RELEASE", { by });
  await giveTask(s, caseId, "legalB", "LEGAL_HOLD_RELEASE", { by });
}

/** Closes a case at screening and archives it (case manager), so it enters the records lifecycle. */
export async function closeAndArchive(s: Scenario, caseId: string): Promise<void> {
  await s.as("caseManager");
  await s.tx`select api.transition_case(${caseId}, 'SCREEN_OUT', 'Synthetic: screened out for the records suite.')`;
  await s.tx`select api.transition_case(${caseId}, 'ARCHIVE_CASE')`;
}

/**
 * Adds a CONFIGURED class with a one-microsecond period. Test fixture only: shipped classes stay
 * SOURCE_REQUIRED, so without this no case can ever become eligible (REC-T25).
 */
export async function addShortRetentionClass(s: OwnerScenario): Promise<void> {
  await s.asOwner();
  await s.tx`insert into records.retention_class (code, name_en, name_ar, record_type, category, retention_period,
                trigger_event, disposition_action, source_reference, status, description)
             values ('TEST_SHORT_RETENTION', 'Test short retention', 'اختبار', 'CASE', 'TEMPORARY', interval '1 microsecond',
                'CASE_CLOSED', 'DESTROY', 'TEST FIXTURE: not a CDF value', 'CONFIGURED', 'Test fixture (rolled back).')`;
}

/** Archives the case, confirms the short class and refreshes eligibility as the records officer. */
export async function makeEligible(s: OwnerScenario, caseId: string): Promise<void> {
  await addShortRetentionClass(s);
  await closeAndArchive(s, caseId);
  await s.as("records");
  await s.tx`select api.assign_retention_class(${caseId}, 'TEST_SHORT_RETENTION')`;
  await s.tx`select api.refresh_disposition_eligibility()`;
}

export async function recordsState(
  tx: Tx,
  caseId: string,
): Promise<{ records_state: string; legal_hold_status: string }> {
  const [row] = await tx<{ records_state: string; legal_hold_status: string }[]>`
    select records_state, legal_hold_status from api.list_records(null, ${caseId})`;
  if (!row) throw new Error("case not visible in the records view");
  return row;
}

export async function placeHold(
  tx: Tx,
  caseId: string,
  opts: { scope?: string; evidenceId?: string | null; reason?: string; justification?: string } = {},
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    select api.place_legal_hold(${caseId}, ${opts.scope ?? "CASE"}, ${opts.evidenceId ?? null},
      ${opts.reason ?? "LITIGATION"}, ${opts.justification ?? JUSTIFICATION}, 'SYN-REF-001') as id`;
  return row!.id;
}

export async function releaseHold(s: Scenario, holdId: string): Promise<void> {
  await s.as("legal");
  const [req] = await s.tx<
    { id: string }[]
  >`select api.request_legal_hold_release(${holdId}, ${JUSTIFICATION}) as id`;
  await s.as("legalB");
  await s.tx`select api.decide_legal_hold_release(${req!.id}, true, ${DECISION})`;
}

export async function requestDisposition(tx: Tx, caseId: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`select api.request_disposition(${caseId}) as id`;
  return row!.id;
}
