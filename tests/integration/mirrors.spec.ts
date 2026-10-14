// The TypeScript mirrors used by the UI and BFF pre-checks must equal the database definitions,
// which are authoritative (ADR-006, ADR-007).
import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "@cdf/authorization";
import {
  ATTENDANCE_STATUSES,
  CASE_TASK_TYPES,
  CONFLICT_DECIDERS,
  EMPLOYEE_NOTICE_KINDS,
  EXPORT_PURPOSES,
  EXPORT_PURPOSES_LEGACY,
  EXPORT_PURPOSES_REQUIRING_JUSTIFICATION,
  MEETING_CONFLICT_CONCERN_STATUSES,
  NOTIFICATION_TEMPLATES,
  PERMISSIONS,
  PRELIMINARY_OUTCOMES,
  PRELIMINARY_OUTCOMES_NOT_ENABLED,
  REFERRAL_EVENT_TYPES,
  REFERRAL_STATUSES,
  STATUS_CODES,
} from "@cdf/contracts";
import { ALLOWED_CONTENT_TYPES, FORM_DEFINITIONS, FORM_ENTITLEMENTS } from "@cdf/domain";
import { messagesFor, type Messages } from "@cdf/i18n";
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

  it("role names in both languages match iam.role (UX redesign S1: user menu and My access)", async () => {
    const rows = await admin<{ code: string; nameEn: string; nameAr: string }[]>`
      select code, name_en as "nameEn", name_ar as "nameAr" from iam.role order by code`;
    expect(rows).toEqual(
      Object.keys(messagesFor("en").role)
        .sort()
        .map((code) => ({
          code,
          nameEn: messagesFor("en").role[code as keyof Messages["role"]],
          nameAr: messagesFor("ar").role[code as keyof Messages["role"]],
        })),
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

  it("case task types match case_mgmt.case_task_type (ADR-014)", async () => {
    const rows = await admin`
      select code, category, allowed_capabilities as "allowedCapabilities", eligible_roles as "eligibleRoles",
             requires_closed as "requiresClosed"
      from case_mgmt.case_task_type order by code collate "C"`;
    expect(rows).toEqual([...CASE_TASK_TYPES].map((t) => ({ ...t })));
  });

  it("proceeding reason and outcome codes match config.status_code (ADR-029)", async () => {
    const rows = await admin<{ dimension: string; codes: string[] }[]>`
      select dimension, array_agg(code order by code collate "C") as codes
      from config.status_code where is_active group by dimension order by dimension collate "C"`;
    const fromTs = Object.entries(STATUS_CODES)
      .map(([dimension, codes]) => ({ dimension, codes: [...codes].sort() }))
      .sort((a, b) => (a.dimension < b.dimension ? -1 : 1));
    expect(rows).toEqual(fromTs);
  });

  it("preliminary outcomes match the recommendation's check and are all active outcome codes (1880, 1980)", async () => {
    const [row] = await admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'preliminary_recommendation_recommended_outcome_check'
        and conrelid = 'case_mgmt.preliminary_recommendation'::regclass`;
    const fromCheck = [...row!.def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(fromCheck).toEqual([...PRELIMINARY_OUTCOMES].sort());
    for (const code of PRELIMINARY_OUTCOMES) expect(STATUS_CODES.OUTCOME_CODE, code).toContain(code);
  });

  it("preliminary outcomes not enabled are exactly the INACTIVE catalogue values (DEC-F10, 2040)", async () => {
    const rows = await admin<{ value: string }[]>`
      select value from config.status_dimension_value
      where dimension = 'PRELIMINARY_OUTCOME' and state = 'INACTIVE' order by value collate "C"`;
    expect(rows.map((r) => r.value)).toEqual([...PRELIMINARY_OUTCOMES_NOT_ENABLED].sort());
  });

  it("referral statuses and event types match the referral's checks (1880, DEC-F09 2040)", async () => {
    const defs = await admin<{ conname: string; def: string }[]>`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where (conrelid, conname) in (('intake.referral'::regclass, 'referral_status_check'),
                                    ('intake.referral_event'::regclass, 'referral_event_event_type_check'))
      order by conname collate "C"`;
    const codes = (name: string) =>
      [...defs.find((d) => d.conname === name)!.def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(codes("referral_status_check")).toEqual([...REFERRAL_STATUSES].sort());
    expect(codes("referral_event_event_type_check")).toEqual([...REFERRAL_EVENT_TYPES].sort());
  });

  it("employee notice kinds match the notice's kind check (1990)", async () => {
    const [row] = await admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'defence_notice_kind_check' and conrelid = 'grievance.defence_notice'::regclass`;
    const fromCheck = [...row!.def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(fromCheck).toEqual([...EMPLOYEE_NOTICE_KINDS].sort());
  });

  it("meeting attendance, raised-conflict statuses and conflict deciders match their checks (1890, 2000)", async () => {
    const checks: [string, string, readonly string[]][] = [
      ["meeting_participant_attendance_check", "committee.meeting_participant", ATTENDANCE_STATUSES],
      [
        "meeting_conflict_concern_status_check",
        "committee.meeting_conflict_concern",
        MEETING_CONFLICT_CONCERN_STATUSES,
      ],
      ["rule_set_conflict_decider_check", "committee.rule_set", CONFLICT_DECIDERS],
    ];
    for (const [name, table, mirror] of checks) {
      const [row] = await admin<{ def: string }[]>`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = ${name} and conrelid = ${table}::regclass`;
      const fromCheck = [...row!.def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]).sort();
      expect(fromCheck, name).toEqual([...mirror].sort());
    }
  });

  it("notification templates match notify.template, and each has wording in both languages (ADR-025)", async () => {
    const rows = await admin<{ code: string }[]>`select code from notify.template order by code collate "C"`;
    expect(rows.map((r) => r.code)).toEqual([...NOTIFICATION_TEMPLATES].sort());
    for (const locale of ["en", "ar"] as const) {
      const wording = messagesFor(locale).notificationTemplate as Record<string, string>;
      for (const code of NOTIFICATION_TEMPLATES) expect(wording[code], `${locale} ${code}`).toBeTruthy();
    }
  });

  it("export purposes match the governed catalogue exchange.export_purpose (DEC-F21, 2040)", async () => {
    const rows = await admin<
      { code: string; isActive: boolean; isLegacy: boolean; requiresJustification: boolean }[]
    >`
      select code, is_active as "isActive", is_legacy as "isLegacy", requires_justification as "requiresJustification"
      from exchange.export_purpose order by sort_order`;
    expect(rows.filter((r) => r.isActive).map((r) => r.code)).toEqual([...EXPORT_PURPOSES]);
    expect(rows.filter((r) => r.isLegacy).map((r) => r.code)).toEqual([...EXPORT_PURPOSES_LEGACY]);
    expect(rows.filter((r) => r.requiresJustification).map((r) => r.code)).toEqual([
      ...EXPORT_PURPOSES_REQUIRING_JUSTIFICATION,
    ]);
  });

  it("permission codes match iam.permission", async () => {
    const rows = await admin<{ code: string }[]>`select code from iam.permission order by code collate "C"`;
    expect(rows.map((r) => r.code)).toEqual([...PERMISSIONS].sort());
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
