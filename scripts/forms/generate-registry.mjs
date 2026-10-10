#!/usr/bin/env node
// Generates the WB-FRM form registry from the baseline catalogue (Phase 8, CDF-50, ADR-011).
//
//   node scripts/forms/generate-registry.mjs
//
// Inputs
//   baseline/extracted/baseline-domain.json   the 19 WB-FRM definitions and role entitlements of the
//                                             offline baseline (reference only, authority level 6)
//   scripts/forms/labels.en.json              English renderings of every Arabic string in the catalogue
//
// Outputs (both committed; CI compares the TypeScript mirror with the database)
//   packages/domain/src/forms/registry.generated.ts          definitions, sections, fields, entitlements
//   infrastructure/supabase/migrations/20261007001110_form_definitions_seed.sql   version 1 of each form
//
// A shipped migration is immutable (CLAUDE.md §6). Once 20261007001110 has been applied anywhere beyond a
// local database, changes to a form must become a new form_definition_version in a NEW migration; this
// script then needs a target path for that migration instead of overwriting the seed.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const baseline = JSON.parse(
  readFileSync(join(root, "baseline", "extracted", "baseline-domain.json"), "utf8"),
);
const labels = JSON.parse(readFileSync(join(root, "scripts", "forms", "labels.en.json"), "utf8"));

const FIELD_TYPES = new Set(["text", "textarea", "date", "select", "boolean", "number"]);
const NAME = /^[a-z][a-z0-9_]{1,63}$/;

/** Baseline role → platform role(s) (BASELINE_ANALYSIS §5.3). Roles without a platform counterpart are skipped. */
const ROLE_MAP = {
  COMPLIANCE_OFFICER: ["INTAKE_OFFICER", "TRIAGE_OFFICER"],
  COMPLIANCE_MANAGER: ["CASE_MANAGER", "COMPLIANCE"],
  // Owner-by-assignment is enforced by case access (authz.can_view_case), not by form entitlement.
  CASE_OWNER: ["CASE_MANAGER"],
  INVESTIGATOR: ["INVESTIGATOR"],
  SENIOR_INVESTIGATOR: ["LEAD_INVESTIGATOR"],
  INVESTIGATION_COMMITTEE_SECRETARY: ["COMMITTEE_SECRETARY"],
  INVESTIGATION_COMMITTEE_CHAIR: ["COMMITTEE_CHAIR"],
  INVESTIGATION_COMMITTEE_MEMBER: ["COMMITTEE_MEMBER"],
  DECISION_AUTHORITY: ["DECISION_AUTHORITY"],
  IMPLEMENTATION_OWNER: ["IMPLEMENTATION_OWNER"],
  // SUBJECT_EMPLOYEE is a case person, not a platform role; GRIEVANCE_COMMITTEE_* belong to a later phase.
};

/** Reviewer roles per owning function (DERIVED: review is a second pair of eyes from the owner's line). */
const REVIEWERS = {
  COMPLIANCE_INTAKE: ["CASE_MANAGER", "COMPLIANCE", "GRC_DIRECTOR"],
  INVESTIGATOR: ["LEAD_INVESTIGATOR", "CASE_MANAGER", "GRC_DIRECTOR"],
  COMMITTEE_SECRETARY: ["COMMITTEE_CHAIR", "GRC_DIRECTOR"],
};

/** Approver roles per form (SOURCE_REQUIRED: the governing procedure names the authority; confirm with CDF). */
const APPROVERS = {
  "WB-FRM-04": ["GRC_DIRECTOR"],
  "WB-FRM-09": ["GRC_DIRECTOR"],
  "WB-FRM-10": ["GRC_DIRECTOR"],
  "WB-FRM-13": ["COMMITTEE_CHAIR", "GRC_DIRECTOR"],
  "WB-FRM-14": ["COMMITTEE_CHAIR", "GRC_DIRECTOR"],
  "WB-FRM-15": ["COMMITTEE_CHAIR", "GRC_DIRECTOR"],
  "WB-FRM-16": ["DECISION_AUTHORITY", "GRC_DIRECTOR"],
  "WB-FRM-18": ["DECISION_AUTHORITY", "GRC_DIRECTOR"],
};

/** Legal and HR reviewers read the findings-to-decision forms by grant (DERIVED). */
const LEGAL_HR_VIEW = ["WB-FRM-12", "WB-FRM-15", "WB-FRM-16", "WB-FRM-17", "WB-FRM-18"];

const en = (ar) => {
  const value = labels[ar];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing English label for: ${ar}`);
  return value;
};

// ---- Definitions ---------------------------------------------------------------------------------------
const definitions = baseline.forms.order.map((code, index) => {
  const entry = baseline.forms.catalog[code];
  if (!/^WB-FRM-\d{2}$/.test(code)) throw new Error(`unexpected form code ${code}`);
  let fieldNo = 0;
  const names = new Set();
  const sections = entry.sections.map((section, sIndex) => ({
    no: sIndex + 1,
    titleAr: section.title,
    titleEn: en(section.title),
    fields: section.fields.map((f) => {
      if (!NAME.test(f.name)) throw new Error(`${code}: field name ${f.name} is not a valid identifier`);
      if (names.has(f.name)) throw new Error(`${code}: duplicate field ${f.name}`);
      names.add(f.name);
      if (!FIELD_TYPES.has(f.type)) throw new Error(`${code}.${f.name}: unknown type ${f.type}`);
      if ((f.type === "select") !== f.options?.length > 0)
        throw new Error(`${code}.${f.name}: select fields need options and only select fields may have them`);
      fieldNo += 1;
      return {
        no: fieldNo,
        name: f.name,
        labelAr: f.label,
        labelEn: en(f.label),
        type: f.type,
        required: Boolean(f.required),
        options: (f.options ?? []).map((o) => ({ value: o, labelAr: o, labelEn: en(o) })),
        helpAr: f.help ?? null,
        helpEn: f.help ? en(f.help) : null,
        sensitive: Boolean(f.sensitive),
      };
    }),
  }));
  if (entry.approval_required && !entry.review_required)
    throw new Error(`${code}: approval without review is not supported by the lifecycle`);
  return {
    code,
    sequenceNo: index + 1,
    nameAr: entry.name,
    nameEn: en(entry.name),
    purposeAr: entry.purpose,
    purposeEn: en(entry.purpose),
    ownerRoleHint: entry.owner,
    sourceReference: entry.source,
    reviewRequired: Boolean(entry.review_required),
    approvalRequired: Boolean(entry.approval_required),
    // No form is a per-case singleton until the governing procedure says so (SOURCE_REQUIRED).
    repeatable: true,
    schemaHash: sha256(canonicalJson(sections)),
    sections,
  };
});

// ---- Entitlements ----------------------------------------------------------------------------------------
const entitlements = new Map(); // key → { formCode, roleCode, action, source }
const add = (formCode, roleCode, action, source) => {
  const key = `${formCode}|${roleCode}|${action}`;
  if (!entitlements.has(key)) entitlements.set(key, { formCode, roleCode, action, source });
};
for (const d of definitions) {
  const base = baseline.formEntitlements[d.code];
  for (const role of base.view)
    for (const mapped of ROLE_MAP[role] ?? []) add(d.code, mapped, "VIEW", "BASELINE");
  for (const role of base.edit)
    for (const mapped of ROLE_MAP[role] ?? []) add(d.code, mapped, "PREPARE", "BASELINE");
  add(d.code, "GRC_DIRECTOR", "VIEW", "DERIVED");
  if (d.reviewRequired) for (const role of REVIEWERS[d.ownerRoleHint]) add(d.code, role, "REVIEW", "DERIVED");
  if (d.approvalRequired)
    for (const role of APPROVERS[d.code] ?? []) add(d.code, role, "APPROVE", "SOURCE_REQUIRED");
  if (d.approvalRequired && !(APPROVERS[d.code]?.length > 0))
    throw new Error(`${d.code}: no approver configured`);
  if (LEGAL_HR_VIEW.includes(d.code))
    for (const role of ["LEGAL_REVIEWER", "HR_REVIEWER"]) add(d.code, role, "VIEW", "DERIVED");
}
// Anyone who may prepare, review or approve a form may also view it.
for (const e of [...entitlements.values()])
  if (e.action !== "VIEW") add(e.formCode, e.roleCode, "VIEW", "DERIVED");
const ACTION_ORDER = { VIEW: 0, PREPARE: 1, REVIEW: 2, APPROVE: 3 };
const entitlementRows = [...entitlements.values()].sort(
  (a, b) =>
    a.formCode.localeCompare(b.formCode) ||
    a.roleCode.localeCompare(b.roleCode) ||
    ACTION_ORDER[a.action] - ACTION_ORDER[b.action],
);

// Role → FORM_* permissions implied by the entitlements (hand-copied into migration 1100 and
// packages/authorization; tests/integration/mirrors.spec.ts checks the three agree).
const rolePermissions = {};
for (const e of entitlementRows) (rolePermissions[e.roleCode] ??= new Set()).add(`FORM_${e.action}`);

// ---- TypeScript mirror -------------------------------------------------------------------------------------
const ts = `// GENERATED by scripts/forms/generate-registry.mjs from baseline/extracted/baseline-domain.json and
// scripts/forms/labels.en.json. Do not edit by hand; re-run the generator (ADR-011).
// English strings are machine-assisted translations of the baseline's Arabic (TRANSLATION_REVIEW_PENDING).
import type { FormDefinition, FormEntitlement } from "@cdf/contracts";

export const FORM_DEFINITIONS: readonly FormDefinition[] = ${JSON.stringify(definitions, null, 2)};

export const FORM_ENTITLEMENTS: readonly FormEntitlement[] = ${JSON.stringify(entitlementRows, null, 2)};
`;
writeFileSync(join(root, "packages", "domain", "src", "forms", "registry.generated.ts"), ts);

// ---- Seed migration ----------------------------------------------------------------------------------------
const q = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const b = (v) => (v ? "true" : "false");
let sql = `-- =============================================================================
-- 1110 WB-FRM form registry, version 1 (Phase 8, CDF-50; ADR-011)
-- GENERATED by scripts/forms/generate-registry.mjs. Do not edit by hand.
--
-- Reference data: the 19 baseline forms as data (definition, published version with its schema hash,
-- relational field definitions used by forms.validate_data, and role entitlements). English strings are
-- machine-assisted translations of the baseline's Arabic (TRANSLATION_REVIEW_PENDING). Entitlement sources:
--   BASELINE         the baseline's view/edit matrix mapped to platform roles (BASELINE_ANALYSIS §5.3)
--   DERIVED          reviewers from the owning function and read access for reviewers/approvers and GRC
--   SOURCE_REQUIRED  approving authorities, to be confirmed against the governing procedure
-- =============================================================================

insert into forms.form_definition
  (code, sequence_no, name_ar, name_en, purpose_ar, purpose_en, owner_role_hint, source_reference, review_required, approval_required, repeatable)
values
`;
sql += definitions
  .map(
    (d) =>
      `  (${q(d.code)}, ${d.sequenceNo}, ${q(d.nameAr)}, ${q(d.nameEn)}, ${q(d.purposeAr)}, ${q(d.purposeEn)}, ${q(d.ownerRoleHint)}, ${q(d.sourceReference)}, ${b(d.reviewRequired)}, ${b(d.approvalRequired)}, ${b(d.repeatable)})`,
  )
  .join(",\n");
sql += ";\n\n";
for (const d of definitions) {
  sql += `-- ${d.code} ${d.nameEn}\n`;
  sql += `insert into forms.form_definition_version (id, form_code, version_no, schema, schema_hash) values\n`;
  sql += `  (${q(versionId(d.code))}, ${q(d.code)}, 1, ${q(JSON.stringify(d.sections))}::jsonb, ${q(d.schemaHash)});\n`;
  sql += `insert into forms.form_field_definition\n  (version_id, section_no, section_title_ar, section_title_en, field_no, name, label_ar, label_en, field_type, required, options, help_ar, help_en, sensitive)\nvalues\n`;
  const rows = [];
  for (const s of d.sections)
    for (const f of s.fields)
      rows.push(
        `  (${q(versionId(d.code))}, ${s.no}, ${q(s.titleAr)}, ${q(s.titleEn)}, ${f.no}, ${q(f.name)}, ${q(f.labelAr)}, ${q(f.labelEn)}, ${q(f.type)}, ${b(f.required)}, ${q(JSON.stringify(f.options))}::jsonb, ${q(f.helpAr)}, ${q(f.helpEn)}, ${b(f.sensitive)})`,
      );
  sql += rows.join(",\n") + ";\n\n";
}
sql += `update forms.form_definition d set current_version_id = v.id\n  from forms.form_definition_version v where v.form_code = d.code and v.version_no = 1;\n\n`;
sql += `insert into forms.form_entitlement (form_code, role_code, action, source) values\n`;
sql += entitlementRows
  .map((e) => `  (${q(e.formCode)}, ${q(e.roleCode)}, ${q(e.action)}, ${q(e.source)})`)
  .join(",\n");
sql += `;\n\n-- Every form has a current version and every approval form an approver.\ndo $$\nbegin\n`;
sql += `  if exists (select 1 from forms.form_definition where current_version_id is null) then raise exception 'form without a version'; end if;\n`;
sql += `  if exists (select 1 from forms.form_definition d where d.approval_required and not exists (select 1 from forms.form_entitlement e where e.form_code = d.code and e.action = 'APPROVE')) then raise exception 'approval form without approver'; end if;\n`;
sql += `  if exists (select 1 from forms.form_definition d where d.review_required and not exists (select 1 from forms.form_entitlement e where e.form_code = d.code and e.action = 'REVIEW')) then raise exception 'review form without reviewer'; end if;\nend;\n$$;\n`;
writeFileSync(
  join(root, "infrastructure", "supabase", "migrations", "20261007001110_form_definitions_seed.sql"),
  sql,
);

const fieldCount = definitions.reduce((n, d) => n + d.sections.reduce((m, s) => m + s.fields.length, 0), 0);
console.log(`✓ ${definitions.length} forms, ${fieldCount} fields, ${entitlementRows.length} entitlements`);
console.log("Role → FORM_* permissions implied by the entitlements:");
for (const [role, perms] of Object.entries(rolePermissions).sort())
  console.log(`  ${role}: ${[...perms].sort().join(", ")}`);

// ---- helpers ------------------------------------------------------------------------------------------------
/** Deterministic version ids (UUIDv5-like, derived from the form code) so re-generation is stable. */
function versionId(code) {
  const h = createHash("sha256").update(`cdf-form-version-1:${code}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
/** Canonical JSON: object keys sorted (code-unit order), arrays in order, no whitespace. Mirrors @cdf/domain canonicalJson. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
