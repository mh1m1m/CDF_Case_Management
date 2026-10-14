// Case closure and reopening fixtures for the migration 2060 tests (DEC-F39, DEC-F40, DEC-AMB-002, DEC-AMB-015).
// Every step runs through the api.* commands as the acting user, except the closure authority setting, which is
// migration-managed (no application role writes config.setting) and is set on the owner connection, rolled back.
import { type OwnerScenario, type Scenario } from "./db";
import { REASON } from "./committee";

export const RATIONALE = "Synthetic: closure rationale for the 2060 tests.";
export const JUSTIFICATION_2060 = "Synthetic: reopening justification for the 2060 tests.";
export const DECIDE_REASON = "Synthetic: closure authority decision reason.";

/**
 * Sets CASE_CLOSURE_APPROVAL_RULE (AMB-212) to `role` with a synthetic source, or back to SOURCE_REQUIRED with null.
 * Test fixture only: the shipped setting stays SOURCE_REQUIRED until CDF confirms its Delegation of Authority.
 */
export async function setClosureAuthority(s: OwnerScenario, role: string | null): Promise<void> {
  await s.asOwner();
  if (role === null) {
    await s.tx`update config.setting set value = null, status = 'SOURCE_REQUIRED', source_reference = null
               where key = 'CASE_CLOSURE_APPROVAL_RULE'`;
  } else {
    await s.tx`update config.setting set value = ${role}, status = 'CONFIGURED', source_reference = 'SYNTHETIC-TEST'
               where key = 'CASE_CLOSURE_APPROVAL_RULE'`;
  }
}

/**
 * CON-022, AMB-213 (migration 2060): a case closes only with no proceeding open. The case manager concludes every open
 * proceeding of the case, children (a committee referred from an investigation) before their parents.
 */
export async function concludeProceedings(s: Scenario, caseId: string): Promise<void> {
  await s.as("caseManager");
  const open = await s.tx<{ id: string }[]>`
    select p.id from case_mgmt.proceeding p
    where p.case_id = ${caseId} and p.status not in ('CONCLUDED', 'CANCELLED')
    order by (p.parent_proceeding_id is null), p.id`;
  for (const p of open) {
    await s.tx`select api.close_proceeding(${p.id}, 'CONCLUDED', 'DECISION_RECORDED', ${REASON})`;
  }
}

/** `user` closes the case with `outcome` through api.close_case; returns CLOSED or AWAITING_APPROVAL. */
export async function closeWith(
  s: Scenario,
  caseId: string,
  outcome = "NO_ACTION",
  user: Parameters<Scenario["as"]>[0] = "caseManager",
): Promise<string> {
  await s.as(user);
  const [r] = await s.tx<{ r: string }[]>`select api.close_case(${caseId}, ${outcome}, ${RATIONALE}) as r`;
  return r!.r;
}

/** `user` asks to reopen the closed case on new evidence; returns the request id. */
export async function requestReopeningOnEvidence(
  s: Scenario,
  caseId: string,
  user: Parameters<Scenario["as"]>[0] = "caseManager",
): Promise<string> {
  await s.as(user);
  const [r] = await s.tx<{ id: string }[]>`
    select api.request_case_reopening(${caseId}, 'NEW_EVIDENCE', ${JUSTIFICATION_2060},
      'Synthetic: a further ledger extract received after closure.', 'DEMO-EVIDENCE-REF-2060', null) as id`;
  return r!.id;
}
