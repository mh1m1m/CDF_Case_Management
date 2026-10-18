// Export forms (ADR-026; UX redesign P12-6b-1). AMB-187: an external address is typed twice and both must be the same
// address as the database keeps it. F11: the submit form echoes the requester's own preview classification and needs
// their confirmation. F9: while internal recipients wait for their candidate read, the case page's request form makes
// no email export to internal recipients. The database re-checks everything (tests/security/export.spec.ts).
import { describe, expect, it } from "vitest";
import {
  addExportRecipientSchema,
  createExportRequestSchema,
  requestExportFormSchema,
  submitExportFormSchema,
  submitExportSchema,
} from "./exports";

const REQUEST = "33333333-3333-4333-8333-333333333333";
const CASE = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => [i.path.join("."), i.message]);

describe("AMB-187: an external recipient is typed twice", () => {
  const external = (email: unknown, emailConfirmation: unknown) =>
    addExportRecipientSchema.safeParse({ requestId: REQUEST, kind: "EXTERNAL", email, emailConfirmation });

  it("accepts the same address in both fields, compared as the database keeps it (trimmed, lower case)", () => {
    const r = external(" Officer.Alpha@Example.test ", "officer.alpha@example.TEST");
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      requestId: REQUEST,
      kind: "EXTERNAL",
      email: "officer.alpha@example.test",
      emailConfirmation: "officer.alpha@example.test",
    });
  });

  it("refuses one wrong character, a missing confirmation and a blank one", () => {
    expect(issues(external("officer.alpha@example.test", "officer.alpah@example.test"))).toEqual([
      ["emailConfirmation", "validation.emailMismatch"],
    ]);
    expect(issues(external("officer.alpha@example.test", undefined))).toEqual([
      ["emailConfirmation", "validation.required"],
    ]);
    expect(issues(external("officer.alpha@example.test", "   "))).toEqual([
      ["emailConfirmation", "validation.required"],
    ]);
  });

  it("still refuses an address outside the synthetic domain, whatever the confirmation says", () => {
    expect(issues(external("officer@regulator.example.com", "officer@regulator.example.com"))).toEqual([
      ["email", "validation.email"],
    ]);
    expect(issues(external(undefined, "officer.alpha@example.test"))).toContainEqual([
      "email",
      "validation.required",
    ]);
  });

  it("leaves an internal recipient as it was: one account id, no confirmation", () => {
    expect(
      addExportRecipientSchema.safeParse({
        requestId: REQUEST,
        kind: "INTERNAL",
        userId: "a0000000-0000-4000-8000-000000000004",
      }).success,
    ).toBe(true);
  });
});

describe("F11: the submit form confirms the classification the requester's own preview shows", () => {
  const base = { requestId: REQUEST, previewHash: HASH, classification: "CONFIDENTIAL" };

  it("needs the confirmation; the command's own schema is unchanged", () => {
    expect(submitExportFormSchema.safeParse({ ...base, classificationConfirmed: true }).success).toBe(true);
    expect(issues(submitExportFormSchema.safeParse({ ...base, classificationConfirmed: false }))).toEqual([
      ["classificationConfirmed", "validation.acknowledgementRequired"],
    ]);
    expect(issues(submitExportFormSchema.safeParse(base))).toEqual([
      ["classificationConfirmed", "validation.acknowledgementRequired"],
    ]);
    expect(submitExportSchema.safeParse(base).success).toBe(true);
  });
});

describe("F9: the case page's request form", () => {
  const request = (format: string, audience: string, extra: Record<string, string> = {}) => ({
    caseId: CASE,
    format,
    audience,
    purpose: "LEGAL_REVIEW",
    ...extra,
  });
  const external = {
    externalParty: "Regulator Alpha (synthetic)",
    justification: "Synthetic: the regulator asked for the case summary.",
  };

  it("makes no email export to internal recipients, which the command alone would accept", () => {
    expect(createExportRequestSchema.safeParse(request("EMAIL", "INTERNAL")).success).toBe(true);
    expect(issues(requestExportFormSchema.safeParse(request("EMAIL", "INTERNAL")))).toEqual([
      ["format", "validation.emailExternalOnly"],
    ]);
  });

  it("narrows nothing else", () => {
    for (const r of [
      request("PDF", "INTERNAL"),
      request("XLSX", "INTERNAL"),
      request("EMAIL", "EXTERNAL", external),
      request("PDF", "EXTERNAL", external),
    ])
      expect(requestExportFormSchema.safeParse(r).success, `${r.format} ${r.audience}`).toBe(true);
    expect(issues(requestExportFormSchema.safeParse(request("EMAIL", "EXTERNAL")))).toEqual(
      issues(createExportRequestSchema.safeParse(request("EMAIL", "EXTERNAL"))),
    );
  });
});
