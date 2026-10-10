// The TypeScript mirrors used by the UI and BFF pre-checks must equal the database definitions,
// which are authoritative (ADR-006, ADR-007).
import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "@cdf/authorization";
import { STATES, TRANSITIONS } from "@cdf/workflow";
import { admin } from "../support/db";

describe("mirrors", () => {
  it("workflow states match workflow.workflow_state", async () => {
    const rows = await admin`
      select code, name_en as "nameEn", name_ar as "nameAr", sequence, is_initial as "isInitial",
             is_terminal as "isTerminal", records_state as "recordsState"
      from workflow.workflow_state where workflow_code = 'CDF_CASE_V1' order by sequence`;
    expect(rows).toEqual(STATES);
  });

  it("workflow transitions match workflow.workflow_transition_definition", async () => {
    const rows = await admin`
      select code, from_state as "from", to_state as "to", required_permission as "requiredPermission",
             reason_required as "reasonRequired", approval_required as "approvalRequired",
             required_conditions as "requiredConditions", is_system as "isSystem", is_enabled as "isEnabled",
             enabled_in_phase as "enabledInPhase"
      from workflow.workflow_transition_definition where workflow_code = 'CDF_CASE_V1' order by code`;
    expect(rows).toEqual([...TRANSITIONS].sort((a, b) => a.code.localeCompare(b.code)));
  });

  it("role permissions match iam.role_permission", async () => {
    const rows = await admin<{ role: string; perms: string[] }[]>`
      select r.code as role, coalesce(array_agg(rp.permission_code order by rp.permission_code) filter (where rp.permission_code is not null), '{}') as perms
      from iam.role r left join iam.role_permission rp on rp.role_code = r.code group by r.code order by r.code`;
    const fromDb = Object.fromEntries(rows.map((r) => [r.role, r.perms]));
    const fromTs = Object.fromEntries(Object.entries(ROLE_PERMISSIONS).map(([k, v]) => [k, [...v].sort()]));
    expect(fromDb).toEqual(fromTs);
  });
});
