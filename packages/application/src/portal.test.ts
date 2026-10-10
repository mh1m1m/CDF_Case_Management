import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { createPortalService, PORTAL_ATTACHMENT_KIB_LIMIT } from "./portal";
import type { AttachmentDropbox, MalwareScanner, PortalGateway, RateLimiter, ScanResult } from "./ports";

// CDF-72 · ADR-015: the portal's attachment pipeline, end to end against fakes.
const bytes = (s: string) => new TextEncoder().encode(s);
const pdf = bytes("%PDF-1.7\n%synthetic attachment");
const creds = { reportRef: "WB-0123456789AB", secret: "ABCD-EFGH-JKMN-PQRS-TVWX", source: "REPORT" };
const ctx = { requestId: "00000000-0000-4000-8000-000000000001" };

function harness(
  opts: {
    enabled?: boolean;
    registered?: boolean;
    registerError?: Error;
    scan?: ScanResult["status"];
    putFails?: boolean;
    countOk?: boolean;
    bytesOk?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const gateway = {
    submitReport: async () => ({ reportRef: "x", receivedAt: "x" }),
    getReportStatus: async () => null,
    postReporterMessage: async () => true,
    registerAttachment: async (_c, ref, hmac, i) => {
      calls.push(`register:${ref}:${hmac}:${i.source}:${i.extension}:${i.contentType}:${i.sizeBytes}`);
      if (opts.registerError) throw opts.registerError;
      return opts.registered === false
        ? null
        : { attachmentId: "att-1", objectKey: "reports/r/attachments/att-1", displayName: "ATT-001.pdf" };
    },
    completeAttachment: async (_c, _r, _h, id, scanner) => {
      calls.push(`complete:${id}:${scanner}`);
      return true;
    },
    rejectAttachment: async (_c, _r, _h, id, reason, scan) => {
      calls.push(`reject:${id}:${reason}:${scan?.status ?? "-"}`);
      return true;
    },
  } satisfies PortalGateway;
  const rateLimiter: RateLimiter = {
    consume: async (bucket, limit) => {
      calls.push(`consume:${bucket.split(":")[0]}:${limit}`);
      return opts.countOk ?? true;
    },
    consumeAmount: async (bucket, amount, limit) => {
      calls.push(`consumeAmount:${bucket.split(":")[0]}:${amount}:${limit}`);
      return opts.bytesOk ?? true;
    },
  };
  const dropbox: AttachmentDropbox = {
    kind: "local-fs",
    putQuarantine: async (key) => {
      if (opts.putFails) throw new Error("disk full");
      calls.push(`put:${key}`);
    },
    promoteToVault: async (key) => {
      calls.push(`promote:${key}`);
    },
  };
  const scanner: MalwareScanner = {
    name: "fake-scanner",
    scan: async () => ({ status: opts.scan ?? "CLEAN", scanner: "fake-scanner" }),
  };
  const service = createPortalService({
    gateway,
    keys: { reportSecretHmac: async (s) => `hmac(${s})`, rateLimitKey: async (v) => `k${v.length}` },
    rateLimiter,
    attachments: opts.enabled === false ? undefined : { dropbox, scanner },
  });
  return { service, calls };
}

describe("portal attachment upload (CDF-72)", () => {
  it("runs limits, register, quarantine, scan, promote and complete in order; the file name never leaves", async () => {
    const { service, calls } = harness();
    const result = await service.uploadAttachment(ctx, "client", creds, {
      name: "Employee Alpha.pdf",
      bytes: pdf,
    });
    expect(result).toEqual({ ok: true, displayName: "ATT-001.pdf" });
    expect(calls).toEqual([
      "consume:portal_attachment:20",
      `consumeAmount:portal_attachment_kib:1:${PORTAL_ATTACHMENT_KIB_LIMIT.limit}`,
      `register:WB-0123456789AB:hmac(ABCD-EFGH-JKMN-PQRS-TVWX):REPORT:pdf:application/pdf:${pdf.length}`,
      "put:reports/r/attachments/att-1",
      "promote:reports/r/attachments/att-1",
      "complete:att-1:fake-scanner",
    ]);
    expect(calls.join(" ")).not.toContain("Alpha");
  });

  it("is off when no storage is configured", async () => {
    const { service, calls } = harness({ enabled: false });
    expect(service.attachmentsEnabled).toBe(false);
    expect(await service.uploadAttachment(ctx, "c", creds, { name: "a.pdf", bytes: pdf })).toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
    expect(calls).toEqual([]);
  });

  it("refuses a bad file before the database or storage is touched", async () => {
    const { service, calls } = harness();
    expect(await service.uploadAttachment(ctx, "c", creds, { name: "a.exe", bytes: pdf })).toEqual({
      ok: false,
      code: "INVALID_FILE",
      reason: "EXTENSION_NOT_ALLOWED",
    });
    expect(calls.filter((c) => !c.startsWith("consume:"))).toEqual([]);
  });

  it("answers wrong credentials and unknown reports with one code", async () => {
    const { service, calls } = harness({ registered: false });
    expect(await service.uploadAttachment(ctx, "c", creds, { name: "a.pdf", bytes: pdf })).toEqual({
      ok: false,
      code: "NOT_ACCEPTED",
    });
    expect(calls.some((c) => c.startsWith("put:"))).toBe(false);
    const malformed = harness();
    expect(
      await malformed.service.uploadAttachment(ctx, "c", { source: "REPORT" }, { name: "a.pdf", bytes: pdf }),
    ).toEqual({ ok: false, code: "NOT_ACCEPTED" });
  });

  it("enforces the count and byte limits at the boundary", async () => {
    await expect(
      harness({ countOk: false }).service.uploadAttachment(ctx, "c", creds, { name: "a.pdf", bytes: pdf }),
    ).rejects.toMatchObject({ kind: "RATE_LIMITED" });
    const bytesCapped = harness({ bytesOk: false });
    await expect(
      bytesCapped.service.uploadAttachment(ctx, "c", creds, { name: "a.pdf", bytes: pdf }),
    ).rejects.toMatchObject({ kind: "RATE_LIMITED" });
    expect(bytesCapped.calls.some((c) => c.startsWith("register:"))).toBe(false);
  });

  it("rejects infected and unscanned files and never promotes them", async () => {
    for (const [scan, reason] of [
      ["INFECTED", "MALWARE_DETECTED"],
      ["UNSCANNED", "SCAN_UNAVAILABLE"],
    ] as const) {
      const { service, calls } = harness({ scan });
      expect(await service.uploadAttachment(ctx, "c", creds, { name: "a.pdf", bytes: pdf })).toEqual({
        ok: false,
        code: "REJECTED",
      });
      expect(calls).toContain(`reject:att-1:${reason}:${scan}`);
      expect(calls.some((c) => c.startsWith("promote:") || c.startsWith("complete:"))).toBe(false);
    }
  });

  it("marks a storage failure rejected and reports the service unavailable", async () => {
    const { service, calls } = harness({ putFails: true });
    expect(await service.uploadAttachment(ctx, "c", creds, { name: "a.pdf", bytes: pdf })).toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
    expect(calls).toContain("reject:att-1:STORAGE_FAILURE:-");
  });

  it("maps per-report conflicts to reporter-facing codes", async () => {
    for (const [detail, code] of [
      ["ATTACHMENT_LIMIT", "LIMIT_REACHED"],
      ["DUPLICATE_ATTACHMENT", "DUPLICATE"],
      ["REPORT_CLOSED", "REPORT_CLOSED"],
    ] as const) {
      const { service } = harness({ registerError: new Error(`CDF_CONFLICT:${detail}`) });
      expect(await service.uploadAttachment(ctx, "c", creds, { name: "a.pdf", bytes: pdf })).toEqual({
        ok: false,
        code,
      });
    }
    const { service } = harness({ registerError: new Error("CDF_INVALID:size_bytes") });
    await expect(
      service.uploadAttachment(ctx, "c", creds, { name: "a.pdf", bytes: pdf }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
