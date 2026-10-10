import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROLES } from "@cdf/contracts";
import {
  FORM_DEFINITIONS,
  FORM_ENTITLEMENTS,
  FORM_FIELD_NAME_PATTERN,
  canonicalJson,
  fieldsOf,
  formContentHash,
  formDisplayNumber,
  formFinalStatus,
  formSchemaHash,
  getFormDefinition,
  isFormEntitled,
  validateFormData,
} from "./forms";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("WB-FRM registry", () => {
  it("holds the 19 baseline forms in order with 184 fields", () => {
    expect(FORM_DEFINITIONS.map((d) => d.code)).toEqual(
      Array.from({ length: 19 }, (_, i) => `WB-FRM-${String(i + 1).padStart(2, "0")}`),
    );
    expect(FORM_DEFINITIONS.map((d) => d.sequenceNo)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
    expect(FORM_DEFINITIONS.reduce((n, d) => n + fieldsOf(d.sections).length, 0)).toBe(184);
  });

  it("has well-formed, unique field names and options only on select fields", () => {
    for (const d of FORM_DEFINITIONS) {
      const names = fieldsOf(d.sections).map((f) => f.name);
      expect(new Set(names).size, d.code).toBe(names.length);
      for (const f of fieldsOf(d.sections)) {
        expect(f.name, `${d.code}.${f.name}`).toMatch(FORM_FIELD_NAME_PATTERN);
        expect(f.options.length > 0, `${d.code}.${f.name}`).toBe(f.type === "select");
        expect(f.labelAr.length, `${d.code}.${f.name}`).toBeGreaterThan(0);
        expect(f.labelEn.length, `${d.code}.${f.name}`).toBeGreaterThan(0);
      }
    }
  });

  it("stores the hash of each definition's canonical schema", async () => {
    for (const d of FORM_DEFINITIONS) {
      expect(await formSchemaHash(d.sections), d.code).toBe(d.schemaHash);
      expect(d.schemaHash).toBe(sha(canonicalJson(d.sections)));
    }
  });

  it("never requires approval without review", () => {
    for (const d of FORM_DEFINITIONS) if (d.approvalRequired) expect(d.reviewRequired, d.code).toBe(true);
  });

  it("entitles only known roles and forms, and gives every reviewer and approver read access", () => {
    for (const e of FORM_ENTITLEMENTS) {
      expect(ROLES, e.roleCode).toContain(e.roleCode);
      expect(getFormDefinition(e.formCode), e.formCode).toBeDefined();
      if (e.action !== "VIEW")
        expect(isFormEntitled([e.roleCode], e.formCode, "VIEW"), `${e.formCode} ${e.roleCode}`).toBe(true);
    }
    for (const d of FORM_DEFINITIONS) {
      if (d.reviewRequired)
        expect(
          FORM_ENTITLEMENTS.some((e) => e.formCode === d.code && e.action === "REVIEW"),
          d.code,
        ).toBe(true);
      if (d.approvalRequired)
        expect(
          FORM_ENTITLEMENTS.some((e) => e.formCode === d.code && e.action === "APPROVE"),
          d.code,
        ).toBe(true);
      expect(
        FORM_ENTITLEMENTS.some((e) => e.formCode === d.code && e.action === "PREPARE"),
        d.code,
      ).toBe(true);
    }
  });

  it("keeps technical and oversight roles out of every form (§21)", () => {
    for (const role of [
      "PLATFORM_ADMIN",
      "DB_ADMIN",
      "SOC_ANALYST",
      "INTERNAL_AUDIT",
      "PRIVACY_DPO",
      "RECORDS_OFFICER",
    ]) {
      expect(FORM_ENTITLEMENTS.filter((e) => e.roleCode === role)).toEqual([]);
    }
  });

  it("answers entitlement questions from the matrix", () => {
    expect(isFormEntitled(["INVESTIGATOR"], "WB-FRM-11", "PREPARE")).toBe(true);
    expect(isFormEntitled(["INVESTIGATOR"], "WB-FRM-13", "VIEW")).toBe(false);
    expect(isFormEntitled(["COMMITTEE_SECRETARY"], "WB-FRM-13", "PREPARE")).toBe(true);
    expect(isFormEntitled(["COMMITTEE_MEMBER"], "WB-FRM-13", "PREPARE")).toBe(false);
    expect(isFormEntitled(["COMMITTEE_CHAIR"], "WB-FRM-13", "APPROVE")).toBe(true);
    for (const d of FORM_DEFINITIONS)
      expect(isFormEntitled(["GRC_DIRECTOR"], d.code, "VIEW"), d.code).toBe(true);
  });
});

describe("form lifecycle helpers", () => {
  it("derives the completing status", () => {
    expect(formFinalStatus({ reviewRequired: false, approvalRequired: false })).toBe("PREPARED");
    expect(formFinalStatus({ reviewRequired: true, approvalRequired: false })).toBe("REVIEWED");
    expect(formFinalStatus({ reviewRequired: true, approvalRequired: true })).toBe("APPROVED");
  });
  it("formats display numbers", () => {
    expect(formDisplayNumber("WB-FRM-11", 2)).toBe("WB-FRM-11 #2");
  });
});

describe("canonical JSON and content hash", () => {
  it("sorts keys, keeps arrays in order and escapes like JSON", () => {
    expect(canonicalJson({ b: "2", a: 'x"y\n', c: ["z", { k: "v", a: null }] })).toBe(
      '{"a":"x\\"y\\n","b":"2","c":["z",{"a":null,"k":"v"}]}',
    );
    expect(canonicalJson({})).toBe("{}");
  });

  it("hashes form code, schema hash and canonical data", async () => {
    const data = { evidence_scope: "ملاحظة\tsynthetic", evidence_count: "3" };
    const expected = sha(`WB-FRM-11:${"ab".repeat(32)}:${canonicalJson(data)}`);
    expect(await formContentHash("WB-FRM-11", "ab".repeat(32), data)).toBe(expected);
    // Key order of the input never matters.
    expect(
      await formContentHash("WB-FRM-11", "ab".repeat(32), {
        evidence_count: "3",
        evidence_scope: "ملاحظة\tsynthetic",
      }),
    ).toBe(expected);
  });
});

describe("validateFormData", () => {
  const def = getFormDefinition("WB-FRM-11")!;
  const committee = getFormDefinition("WB-FRM-13")!;
  const custody = fieldsOf(def.sections).find((f) => f.name === "chain_of_custody_status")!;

  it("drops empty values and accepts a partial draft in lenient mode", () => {
    const r = validateFormData(
      def.sections,
      { evidence_count: "3", evidence_scope: "", review_notes: "  " },
      false,
    );
    expect(r).toEqual({ ok: true, data: { evidence_count: "3" } });
  });

  it("requires every required field in strict mode", () => {
    const r = validateFormData(def.sections, { evidence_count: "3" }, true);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues.map((i) => i.field)).toEqual([
        "evidence_scope",
        "chain_of_custody_status",
        "storage_confirmation",
      ]);
  });

  it("rejects unknown keys and non-string values", () => {
    const r = validateFormData(def.sections, { nope: "x", evidence_count: 3 }, false);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues).toEqual([
        { field: "nope", code: "unknownField" },
        { field: "evidence_count", code: "invalid" },
      ]);
  });

  it("checks each field type", () => {
    const issues = (data: Record<string, unknown>, sections = def.sections) => {
      const r = validateFormData(sections, data, false);
      return r.ok ? [] : r.issues;
    };
    expect(issues({ evidence_count: "12.5" })).toEqual([]);
    expect(issues({ evidence_count: "abc" })).toEqual([{ field: "evidence_count", code: "invalid" }]);
    expect(issues({ chain_of_custody_status: custody.options[0]!.value })).toEqual([]);
    expect(issues({ chain_of_custody_status: "not an option" })).toEqual([
      { field: "chain_of_custody_status", code: "invalid" },
    ]);
    expect(issues({ storage_confirmation: "true" })).toEqual([]);
    expect(issues({ storage_confirmation: "yes" })).toEqual([
      { field: "storage_confirmation", code: "invalid" },
    ]);
    expect(issues({ evidence_scope: "line 1\nline 2\ttab" })).toEqual([]);
    expect(issues({ evidence_scope: "bad\u0001char" })).toEqual([
      { field: "evidence_scope", code: "invalid" },
    ]);
    expect(issues({ evidence_scope: "x".repeat(4001) })).toEqual([
      { field: "evidence_scope", code: "tooLong" },
    ]);
    expect(issues({ formation_date: "2026-09-30" }, committee.sections)).toEqual([]);
    expect(issues({ formation_date: "2026-02-30" }, committee.sections)).toEqual([
      { field: "formation_date", code: "invalid" },
    ]);
    expect(issues({ formation_date: "30/09/2026" }, committee.sections)).toEqual([
      { field: "formation_date", code: "invalid" },
    ]);
    expect(issues({ chair: "a\nb" }, committee.sections)).toEqual([{ field: "chair", code: "invalid" }]);
    expect(issues({ chair: "x".repeat(501) }, committee.sections)).toEqual([
      { field: "chair", code: "tooLong" },
    ]);
  });
});
