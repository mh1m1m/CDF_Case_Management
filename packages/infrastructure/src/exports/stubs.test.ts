// Prototype export adapters (ADR-026): keys from the database only, write-once storage, synthetic delivery only.
import { describe, expect, it } from "vitest";
import type { ExportDocument } from "@cdf/contracts";
import { InMemoryExportStore, StubExportMailer, StubJsonExportRenderer } from "./stubs";

const KEY = "exports/44444444-4444-4444-8444-444444444444";
const doc: ExportDocument = {
  requestId: "33333333-3333-4333-8333-333333333333",
  caseId: "11111111-1111-4111-8111-111111111111",
  caseNumber: "CDF-DEMO-2026-0001",
  classification: "CONFIDENTIAL",
  format: "PDF",
  audience: "INTERNAL",
  purpose: "AUDIT",
  externalParty: null,
  items: [],
};

describe("export stubs", () => {
  it("renders canonical JSON and says so, whatever format was asked for", async () => {
    const file = await new StubJsonExportRenderer().render(doc);
    expect(file.contentType).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(file.body))).toEqual(doc);
  });

  it("stores under database keys only, and never overwrites", async () => {
    const store = new InMemoryExportStore();
    const file = await new StubJsonExportRenderer().render(doc);
    for (const bad of ["exports/../cases/x", "cases/44444444-4444-4444-8444-444444444444", `${KEY}/x`])
      await expect(store.put(bad, file)).rejects.toThrow("Invalid export storage key");
    await store.put(KEY, file);
    expect(store.has(KEY)).toBe(true);
    await expect(store.put(KEY, file)).rejects.toThrow("already used");
  });

  it("delivers to synthetic addresses only", async () => {
    const mailer = new StubExportMailer();
    const file = await new StubJsonExportRenderer().render(doc);
    expect(await mailer.send(["officer@regulator.example.com"], file)).toBe(false);
    expect(await mailer.send([], file)).toBe(false);
    expect(await mailer.send(["officer.alpha@example.test"], file)).toBe(true);
    expect(mailer.delivered).toEqual([{ to: ["officer.alpha@example.test"], fileName: file.fileName }]);
  });
});
