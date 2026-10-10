// The TypeScript mirrors used by the UI and BFF pre-checks must equal the database definitions,
// which are authoritative (ADR-006, ADR-007).
import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "@cdf/authorization";
import { PERMISSIONS } from "@cdf/contracts";
import { ALLOWED_CONTENT_TYPES, FORM_DEFINITIONS, FORM_ENTITLEMENTS } from "@cdf/domain";
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

  it("evidence content-type allow-list matches evidence.allowed_content_type", async () => {
    const rows = await admin<{ contentType: string; extensions: string[]; evidenceType: string }[]>`
      select content_type as "contentType", extensions, evidence_type as "evidenceType"
      from evidence.allowed_content_type order by content_type`;
    expect(rows).toEqual(
      [...ALLOWED_CONTENT_TYPES].sort((a, b) => a.contentType.localeCompare(b.contentType)),
    );
  });

  it("role permissions match iam.role_permission", async () => {
    const rows = await admin<{ role: string; perms: string[] }[]>`
      select r.code as role, coalesce(array_agg(rp.permission_code order by rp.permission_code) filter (where rp.permission_code is not null), '{}') as perms
      from iam.role r left join iam.role_permission rp on rp.role_code = r.code group by r.code order by r.code`;
    const fromDb = Object.fromEntries(rows.map((r) => [r.role, r.perms]));
    const fromTs = Object.fromEntries(Object.entries(ROLE_PERMISSIONS).map(([k, v]) => [k, [...v].sort()]));
    expect(fromDb).toEqual(fromTs);
  });

  it("form registry matches forms.form_definition and its current version", async () => {
    const rows = await admin<Record<string, unknown>[]>`
      select d.code, d.sequence_no as "sequenceNo", d.name_ar as "nameAr", d.name_en as "nameEn",
             d.purpose_ar as "purposeAr", d.purpose_en as "purposeEn", d.owner_role_hint as "ownerRoleHint",
             d.source_reference as "sourceReference", d.review_required as "reviewRequired",
             d.approval_required as "approvalRequired", d.repeatable, v.schema_hash as "schemaHash", v.schema as sections,
             v.version_no as "versionNo", d.is_enabled as "isEnabled"
      from forms.form_definition d join forms.form_definition_version v on v.id = d.current_version_id
      order by d.sequence_no`;
    expect(rows.map((r) => ({ ...r, versionNo: undefined, isEnabled: undefined }))).toEqual(
      FORM_DEFINITIONS.map((d) => ({ ...d, versionNo: undefined, isEnabled: undefined })),
    );
    expect(rows.every((r) => r.versionNo === 1 && r.isEnabled === true)).toBe(true);
    // Field rows are the flattened schema.
    const fields = await admin<{ code: string; name: string; fieldNo: number; sectionNo: number }[]>`
      select v.form_code as code, f.name, f.field_no as "fieldNo", f.section_no as "sectionNo"
      from forms.form_field_definition f join forms.form_definition_version v on v.id = f.version_id
      order by v.form_code, f.field_no`;
    const expected = FORM_DEFINITIONS.flatMap((d) =>
      d.sections.flatMap((s) =>
        s.fields.map((f) => ({ code: d.code, name: f.name, fieldNo: f.no, sectionNo: s.no })),
      ),
    ).sort((a, b) => a.code.localeCompare(b.code) || a.fieldNo - b.fieldNo);
    expect(fields).toEqual(expected);
  });

  it("form entitlements match forms.form_entitlement and imply the FORM_* permissions", async () => {
    const rows = await admin<{ formCode: string; roleCode: string; action: string; source: string }[]>`
      select form_code as "formCode", role_code as "roleCode", action, source
      from forms.form_entitlement order by form_code, action, role_code`;
    const key = (e: { formCode: string; action: string; roleCode: string }) =>
      `${e.formCode}|${e.action}|${e.roleCode}`;
    expect(rows).toEqual([...FORM_ENTITLEMENTS].sort((a, b) => key(a).localeCompare(key(b))));
    // Every role entitled to an action holds the matching permission in both mirrors.
    const permissionFor = {
      VIEW: "FORM_VIEW",
      PREPARE: "FORM_PREPARE",
      REVIEW: "FORM_REVIEW",
      APPROVE: "FORM_APPROVE",
    } as const;
    expect(Object.values(permissionFor).every((p) => (PERMISSIONS as readonly string[]).includes(p))).toBe(
      true,
    );
    for (const e of FORM_ENTITLEMENTS) {
      const perms = ROLE_PERMISSIONS[e.roleCode as keyof typeof ROLE_PERMISSIONS] as
        readonly string[] | undefined;
      expect(perms, `${e.roleCode} exists`).toBeDefined();
      expect(perms, key(e)).toContain(permissionFor[e.action]);
    }
  });
});
