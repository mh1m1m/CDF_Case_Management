// Corrective action from preliminary review: fixtures for the migration 2070 tests (DEC-F41, AMB-021). Every step runs
// through the api.* commands as the acting user, except PRELIMINARY_CORRECTIVE_ACTION_TYPES, which is migration-managed
// (no application role writes config.setting) and is set on the owner connection, rolled back.
import { type OwnerScenario } from "./db";

/**
 * Sets PRELIMINARY_CORRECTIVE_ACTION_TYPES (AMB-021) to `value` with a synthetic source, or back to SOURCE_REQUIRED
 * with null. Test fixture only: the shipped setting stays SOURCE_REQUIRED until CDF configures it.
 */
export async function setPreliminaryCorrectiveTypes(s: OwnerScenario, value: string | null): Promise<void> {
  await s.asOwner();
  if (value === null) {
    await s.tx`update config.setting set value = null, status = 'SOURCE_REQUIRED', source_reference = null
               where key = 'PRELIMINARY_CORRECTIVE_ACTION_TYPES'`;
  } else {
    await s.tx`update config.setting set value = ${value}, status = 'CONFIGURED', source_reference = 'SYNTHETIC-TEST'
               where key = 'PRELIMINARY_CORRECTIVE_ACTION_TYPES'`;
  }
}
