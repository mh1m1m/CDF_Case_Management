import { describe, expect, it } from "vitest";
import type { Actor } from "@cdf/contracts";
import type { SecurityEvent } from "@cdf/audit";
import { createEvidenceService } from "./evidence";
import type { EvidenceGateway, EvidenceStorage, MalwareScanner, ScanResult } from "./ports";

const CASE = "11111111-1111-4111-8111-111111111111";
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000004",
  requestId: "22222222-2222-4222-8222-222222222222",
};
const investigator: Actor = {
  userId: ctx.userId,
  email: "investigator.a@example.test",
  displayName: "Investigator Alpha",
  displayNameAr: "المحقق ألفا",
  roles: ["INVESTIGATOR"],
  permissions: ["CONFLICT_DECLARE", "EVIDENCE_UPLOAD", "EVIDENCE_DOWNLOAD"],
  clearance: "CONFIDENTIAL",
};
const pdf = new TextEncoder().encode("%PDF-1.7\n%synthetic invoice");
const meta = {
  caseId: CASE,
  title: "Invoice batch",
  evidenceType: "DOCUMENT",
  classification: "CONFIDENTIAL",
};

function harness(opts: { scan?: ScanResult["status"]; putFails?: boolean; promoteFails?: boolean } = {}) {
  const calls: string[] = [];
  const events: SecurityEvent[] = [];
  const gateway: EvidenceGateway = {
    listEvidence: async () => [],
    registerVersion: async (_c, i) => {
      calls.push(`register:${i.fileName}:${i.contentType}:${i.sizeBytes}:${i.sha256.slice(0, 8)}`);
      return { evidenceId: "e1", versionId: "v1", versionNo: 1, objectKey: "cases/x/evidence/e1/v1" };
    },
    completeVersion: async (_c, v, scanner) => {
      calls.push(`complete:${v}:${scanner}`);
    },
    rejectVersion: async (_c, v, reason, scan) => {
      calls.push(`reject:${v}:${reason}:${scan?.status ?? "-"}`);
    },
    openVersion: async (_c, v) =>
      v === "v1"
        ? {
            objectKey: "cases/x/evidence/e1/v1",
            fileName: "a.pdf",
            contentType: "application/pdf",
            sizeBytes: 3,
            sha256: "ab",
            evidenceId: "e1",
            caseId: CASE,
          }
        : null,
    listReportAttachments: async () => [],
    openReportAttachment: async () => null,
  };
  const storage: EvidenceStorage = {
    kind: "local-fs",
    putQuarantine: async (k) => {
      if (opts.putFails) throw new Error("disk full");
      calls.push(`put:${k}`);
    },
    promoteToVault: async (k) => {
      if (opts.promoteFails) throw new Error("link failed");
      calls.push(`promote:${k}`);
    },
    openReadStream: async () => new Blob([pdf]).stream() as ReadableStream<Uint8Array>,
    exists: async () => true,
  };
  const scanner: MalwareScanner = {
    name: "fake-scanner",
    scan: async () => ({ status: opts.scan ?? "CLEAN", scanner: "fake-scanner" }),
  };
  const service = createEvidenceService({
    gateway,
    storage,
    scanner,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events };
}

describe("evidence upload pipeline", () => {
  it("register → quarantine → scan → vault → complete, in that order, with the content hash", async () => {
    const { service, calls } = harness();
    const r = await service.upload(ctx, investigator, meta, { name: "invoice.pdf", bytes: pdf });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ evidenceId: "e1", versionId: "v1", versionNo: 1 });
    expect(r.value.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toEqual([
      `register:invoice.pdf:application/pdf:${pdf.length}:${r.value.sha256.slice(0, 8)}`,
      "put:cases/x/evidence/e1/v1",
      "promote:cases/x/evidence/e1/v1",
      "complete:v1:fake-scanner",
    ]);
  });

  it("rejects the version and reports MALWARE_DETECTED when the scanner flags the file", async () => {
    const { service, calls } = harness({ scan: "INFECTED" });
    const r = await service.upload(ctx, investigator, meta, { name: "invoice.pdf", bytes: pdf });
    expect(r.ok).toBe(false);
    if (r.ok || !("error" in r)) return;
    expect(r.error.kind).toBe("CONFLICT");
    expect(r.error.detail).toBe("MALWARE_DETECTED");
    expect(calls.at(-1)).toBe("reject:v1:MALWARE_DETECTED:INFECTED");
    expect(calls.some((c) => c.startsWith("promote:") || c.startsWith("complete:"))).toBe(false);
  });

  it("rejects with SCAN_UNAVAILABLE when the scanner cannot answer", async () => {
    const { service, calls } = harness({ scan: "UNSCANNED" });
    const r = await service.upload(ctx, investigator, meta, { name: "invoice.pdf", bytes: pdf });
    expect(!r.ok && "error" in r && r.error.detail).toBe("SCAN_UNAVAILABLE");
    expect(calls.at(-1)).toBe("reject:v1:SCAN_UNAVAILABLE:UNSCANNED");
  });

  it("rejects with STORAGE_FAILURE when quarantine or promotion fails and never completes", async () => {
    for (const opts of [{ putFails: true }, { promoteFails: true }]) {
      const { service, calls } = harness(opts);
      const r = await service.upload(ctx, investigator, meta, { name: "invoice.pdf", bytes: pdf });
      expect(!r.ok && "error" in r && r.error.kind).toBe("UNAVAILABLE");
      expect(calls.at(-1)).toBe("reject:v1:STORAGE_FAILURE:-");
      expect(calls.some((c) => c.startsWith("complete:"))).toBe(false);
    }
  });

  it("stops before any storage or database call for a disallowed file and records a security event", async () => {
    const { service, calls, events } = harness();
    const r = await service.upload(ctx, investigator, meta, {
      name: "payload.exe",
      bytes: new TextEncoder().encode("MZ"),
    });
    expect(!r.ok && "error" in r && r.error.detail).toBe("FILE_EXTENSION_NOT_ALLOWED");
    expect(calls).toEqual([]);
    expect(events).toEqual([
      {
        action: "VALIDATION_REJECTED",
        objectType: "evidence",
        objectId: CASE,
        metadata: { command: "upload_evidence", reason: "EXTENSION_NOT_ALLOWED", extension: "exe" },
      },
    ]);
  });

  it("refuses users without EVIDENCE_UPLOAD before touching the file", async () => {
    const { service, calls, events } = harness();
    const triage: Actor = {
      ...investigator,
      roles: ["TRIAGE_OFFICER"],
      permissions: ["INTAKE_VIEW", "CASE_CREATE"],
    };
    const r = await service.upload(ctx, triage, meta, { name: "invoice.pdf", bytes: pdf });
    expect(!r.ok && "error" in r && r.error.kind).toBe("FORBIDDEN");
    expect(calls).toEqual([]);
    expect(events[0]?.action).toBe("COMMAND_DENIED");
  });

  it("returns field errors for invalid metadata without touching the file", async () => {
    const { service, calls } = harness();
    const r = await service.upload(ctx, investigator, { caseId: CASE }, { name: "invoice.pdf", bytes: pdf });
    expect(!r.ok && "fieldErrors" in r).toBe(true);
    expect(calls).toEqual([]);
  });

  it("streams a download only when the database opened the version", async () => {
    const { service } = harness();
    const d = await service.openDownload(ctx, "v1");
    expect(d?.fileName).toBe("a.pdf");
    expect(await service.openDownload(ctx, "v2")).toBeNull();
  });
});
