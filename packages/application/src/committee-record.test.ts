// The committee record service (migration 2115, ADR-061): schema first, the database decides who may act, refusals
// recorded with codes only, and the signed minutes through the evidence pattern (R7). Synthetic data only.
import { describe, expect, it } from "vitest";
import type { SecurityEvent } from "@cdf/audit";
import { createCommitteeRecordService, type CommitteeRecordGateway } from "./committee-record";
import type { EvidenceStorage, MalwareScanner, ScanResult } from "./ports";

const ctx = {
  userId: "a0000000-0000-4000-8000-000000000015",
  requestId: "22222222-2222-4222-8222-222222222222",
};
const BATCH = "11111111-1111-4111-8111-111111111111";
const RECORD = "33333333-3333-4333-8333-333333333333";
const HIDDEN = "44444444-4444-4444-8444-444444444444";
const DOCUMENT = "55555555-5555-4555-8555-555555555555";
const LINE = "66666666-6666-4666-8666-666666666666";
const KEY = `committee-records/${BATCH}/${RECORD}/${DOCUMENT}`;
const pdf = new TextEncoder().encode("%PDF-1.7\n%synthetic signed minutes");
const meta = {
  recordId: RECORD,
  meetingDate: "2026-01-15",
  templateReference: "CDF-MINUTES-TEMPLATE-DEMO",
  classification: "CONFIDENTIAL",
};

async function sha(bytes: Uint8Array) {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function harness(
  opts: { scan?: ScanResult["status"]; putFails?: boolean; stored?: Uint8Array; sha256?: string } = {},
) {
  const calls: string[] = [];
  const events: SecurityEvent[] = [];
  const fail = (id: string) => {
    if (id === HIDDEN) throw new Error("CDF_NOT_FOUND");
  };
  const gateway: CommitteeRecordGateway = {
    open: async (_c, i) => {
      fail(i.batchId);
      calls.push(`open:${i.batchId}`);
      return RECORD;
    },
    declareRoster: async (_c, i) => {
      fail(i.recordId);
      calls.push(`declare:${i.lines.length}`);
    },
    registerDocument: async (_c, i) => {
      fail(i.recordId);
      calls.push(`register:${i.fileName}:${i.contentType}:${i.sizeBytes}:${i.meetingDate}`);
      return { documentId: DOCUMENT, versionNo: 1, objectKey: KEY };
    },
    completeDocument: async (_c, id, scanner) => {
      calls.push(`complete:${id}:${scanner}`);
    },
    markSigned: async (_c, i) => {
      fail(i.documentId);
      calls.push(`mark:${i.documentId}`);
    },
    openDocument: async (_c, id) => {
      fail(id);
      if (id !== DOCUMENT) throw new Error("CDF_CONFLICT:DOCUMENT_NOT_STORED");
      return {
        objectKey: KEY,
        contentType: "application/pdf",
        fileName: "signed-minutes.pdf",
        sizeBytes: pdf.length,
        sha256: opts.sha256 ?? (await sha(pdf)),
      };
    },
    activateActingChair: async (_c, i) => {
      calls.push(`activate:${i.basis}`);
      return "act-1";
    },
    endActingChair: async (_c, i) => {
      calls.push(`end:${i.activationId}`);
    },
    decide: async (_c, i) => {
      if (i.recordId === HIDDEN) throw new Error("CDF_FORBIDDEN");
      calls.push(`decide:${i.revision}:${i.decision}`);
      return "PLATFORM_ATTESTATION_IN_PROGRESS";
    },
    returnRecord: async (_c, i) => {
      calls.push(`return:${i.recordId}`);
    },
    attest: async (_c, i) => {
      calls.push(`attest:${i.revision}:${i.action}:${i.discrepancyCode ?? "-"}`);
      return i.action === "ATTEST" ? "ATTESTED" : "DECLINED_WITH_REASON";
    },
  };
  const storage: EvidenceStorage = {
    kind: "local-fs",
    putQuarantine: async (k) => {
      if (opts.putFails) throw new Error("disk full");
      calls.push(`put:${k}`);
    },
    promoteToVault: async (k) => {
      calls.push(`promote:${k}`);
    },
    openReadStream: async () => new Blob([(opts.stored ?? pdf) as Uint8Array<ArrayBuffer>]).stream(),
    exists: async () => true,
  };
  const scanner: MalwareScanner = {
    name: "synthetic-scanner",
    scan: async () => ({ status: opts.scan ?? "CLEAN", scanner: "synthetic-scanner" }),
  };
  const service = createCommitteeRecordService({
    gateway,
    storage,
    scanner,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events };
}

describe("uploading the signed minutes (Layer 1, R7)", () => {
  it("checks, registers, quarantines, scans, promotes and completes, in that order", async () => {
    const { service, calls, events } = harness();
    const r = await service.uploadMinutes(ctx, meta, { name: "signed-minutes.pdf", bytes: pdf });
    expect(r).toEqual({ ok: true, value: { documentId: DOCUMENT, versionNo: 1, sha256: await sha(pdf) } });
    expect(calls).toEqual([
      `register:signed-minutes.pdf:application/pdf:${pdf.length}:2026-01-15`,
      `put:${KEY}`,
      `promote:${KEY}`,
      `complete:${DOCUMENT}:synthetic-scanner`,
    ]);
    expect(events).toEqual([]);
  });

  it("refuses an editable document, a mismatched file and an empty one before the database, with a code only", async () => {
    for (const [name, bytes, reason] of [
      ["minutes.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "TYPE_NOT_ALLOWED"],
      ["minutes.pdf", new TextEncoder().encode("not a pdf"), "CONTENT_MISMATCH"],
      ["minutes.pdf", new Uint8Array(), "EMPTY"],
    ] as const) {
      const { service, calls, events } = harness();
      const r = await service.uploadMinutes(ctx, meta, { name, bytes });
      expect(r.ok).toBe(false);
      expect(calls).toEqual([]);
      expect(events).toEqual([
        {
          action: "VALIDATION_REJECTED",
          objectType: "bcp_committee_record",
          objectId: RECORD,
          metadata: { command: "register_committee_record_document", reason },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("minutes.");
    }
  });

  it("leaves an infected or unscanned version QUARANTINED: never promoted, never completed", async () => {
    for (const scan of ["INFECTED", "UNSCANNED"] as const) {
      const { service, calls, events } = harness({ scan });
      const r = await service.uploadMinutes(ctx, meta, { name: "signed-minutes.pdf", bytes: pdf });
      expect(r.ok).toBe(false);
      expect(calls.some((c) => c.startsWith("promote") || c.startsWith("complete"))).toBe(false);
      expect(events.map((e) => e.metadata?.reason)).toEqual(scan === "INFECTED" ? ["MALWARE_DETECTED"] : []);
    }
  });

  it("a storage failure is UNAVAILABLE and completes nothing", async () => {
    const { service, calls } = harness({ putFails: true });
    const r = await service.uploadMinutes(ctx, meta, { name: "signed-minutes.pdf", bytes: pdf });
    expect(r.ok).toBe(false);
    expect(r.ok === false && "error" in r && r.error.kind).toBe("UNAVAILABLE");
    expect(calls.filter((c) => c.startsWith("complete"))).toEqual([]);
  });

  it("a meeting date in the future or a missing classification never reaches the database", async () => {
    const { service, calls } = harness();
    for (const bad of [
      { ...meta, meetingDate: "2999-01-01" },
      { ...meta, classification: undefined },
    ]) {
      expect((await service.uploadMinutes(ctx, bad, { name: "signed-minutes.pdf", bytes: pdf })).ok).toBe(
        false,
      );
    }
    expect(calls).toEqual([]);
  });
});

describe("opening the signed minutes", () => {
  it("serves stored content that matches its SHA-256", async () => {
    const { service } = harness();
    const d = await service.openMinutes(ctx, DOCUMENT);
    expect(d).toMatchObject({
      fileName: "signed-minutes.pdf",
      contentType: "application/pdf",
      sizeBytes: pdf.length,
    });
  });

  it("never serves content that no longer matches; records the mismatch with a code only", async () => {
    const { service, events } = harness({ stored: new TextEncoder().encode("%PDF-1.7\n%altered") });
    await expect(service.openMinutes(ctx, DOCUMENT)).rejects.toMatchObject({ kind: "UNAVAILABLE" });
    expect(events).toEqual([
      {
        action: "VALIDATION_REJECTED",
        objectType: "bcp_record_document",
        objectId: DOCUMENT,
        metadata: { command: "open_committee_record_document", reason: "INTEGRITY_FAILED" },
      },
    ]);
  });

  it("is null alike for a hidden version, a version not stored and a malformed id", async () => {
    const { service, events } = harness();
    expect(await service.openMinutes(ctx, HIDDEN)).toBeNull();
    expect(await service.openMinutes(ctx, LINE)).toBeNull();
    expect(await service.openMinutes(ctx, "not-a-uuid")).toBeNull();
    expect(events.map((e) => e.action)).toEqual(["ACCESS_DENIED"]);
  });
});

describe("commands: schema first, the database decides who acts", () => {
  it("a record the caller cannot see is the uniform not-found, recorded as a denial", async () => {
    const { service, events } = harness();
    const r = await service.open(ctx, { batchId: HIDDEN });
    expect(r.ok).toBe(false);
    expect(events.map((e) => [e.action, e.metadata])).toEqual([
      ["COMMAND_DENIED", { command: "open_committee_record", outcome: "NOT_FOUND" }],
    ]);
  });

  it("the roster declaration: attendance in part needs a late join or early leave; one chair signature at most", async () => {
    const { service, calls } = harness();
    const line = {
      rosterId: LINE,
      attendance: "ATTENDED",
      joinedLate: false,
      leftEarly: false,
      signatureVisible: true,
      signedAsChair: true,
    };
    expect((await service.declareRoster(ctx, { recordId: RECORD, lines: [line] })).ok).toBe(true);
    for (const lines of [
      [{ ...line, attendance: "ATTENDED_PART" }],
      [{ ...line, signatureVisible: false }],
      [line, { ...line, rosterId: "77777777-7777-4777-8777-777777777777" }],
      [line, line],
      [],
    ]) {
      expect((await service.declareRoster(ctx, { recordId: RECORD, lines })).ok).toBe(false);
    }
    expect(calls).toEqual(["declare:1"]);
  });

  it("the chair's decision: RETURN and REJECT need a reason, APPROVE does not; a refused decider is recorded", async () => {
    const { service, calls, events } = harness();
    expect((await service.decide(ctx, { recordId: RECORD, revision: "1", decision: "APPROVE" })).ok).toBe(
      true,
    );
    expect((await service.decide(ctx, { recordId: RECORD, revision: 1, decision: "RETURN" })).ok).toBe(false);
    expect((await service.decide(ctx, { recordId: RECORD, revision: 0, decision: "APPROVE" })).ok).toBe(
      false,
    );
    expect((await service.decide(ctx, { recordId: HIDDEN, revision: 1, decision: "APPROVE" })).ok).toBe(
      false,
    );
    expect(calls).toEqual(["decide:1:APPROVE"]);
    expect(events.map((e) => e.metadata)).toEqual([
      { command: "decide_committee_record", outcome: "FORBIDDEN" },
    ]);
  });

  it("an attestation names no user; a decline needs a code and a reason, an attestation neither", async () => {
    const { service, calls } = harness();
    expect((await service.attest(ctx, { recordId: RECORD, revision: 2, action: "ATTEST" })).ok).toBe(true);
    const decline = {
      recordId: RECORD,
      revision: 2,
      action: "DECLINE",
      discrepancyCode: "ATTENDANCE_MISMATCH",
      reason: "Synthetic: I left before the end.",
    };
    expect((await service.attest(ctx, decline)).ok).toBe(true);
    for (const bad of [
      { ...decline, reason: undefined },
      { ...decline, discrepancyCode: undefined },
      { ...decline, discrepancyCode: "MISSING_PLATFORM_ATTESTATION" },
      { recordId: RECORD, revision: 2, action: "ATTEST", discrepancyCode: "SIGNATURE_MISMATCH" },
    ]) {
      expect((await service.attest(ctx, bad)).ok).toBe(false);
    }
    expect(calls).toEqual(["attest:2:ATTEST:-", "attest:2:DECLINE:ATTENDANCE_MISMATCH"]);
  });

  it("an acting chair needs a basis, a reason of ten characters and an end in the future", async () => {
    const { service, calls } = harness();
    const ok = {
      recordId: RECORD,
      basis: "UNAVAILABLE",
      reason: "Synthetic: the chair is travelling.",
      effectiveTo: new Date(Date.now() + 86_400_000).toISOString(),
    };
    expect((await service.activateActingChair(ctx, ok)).ok).toBe(true);
    for (const bad of [
      { ...ok, basis: "DEEMED" },
      { ...ok, reason: "short" },
      { ...ok, effectiveTo: new Date(Date.now() - 1000).toISOString() },
    ]) {
      expect((await service.activateActingChair(ctx, bad)).ok).toBe(false);
    }
    expect(calls).toEqual(["activate:UNAVAILABLE"]);
  });
});
