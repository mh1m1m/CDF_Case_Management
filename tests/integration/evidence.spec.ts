// Second vertical slice (Phase 7): upload → quarantine → scan → vault → download, through the real
// application service, adapters, database, RLS and audit. Uses the local filesystem adapter in a
// temporary directory and the mock scanner (both PRODUCTION_SUBSTITUTION_REQUIRED).
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvidenceService, createInvestigationService, type EvidenceService } from "@cdf/application";
import type { Actor } from "@cdf/contracts";
import {
  EICAR_TEST_SIGNATURE,
  LocalFilesystemEvidenceStorage,
  MockMalwareScanner,
  PostgresEvidenceGateway,
  PostgresInvestigationGateway,
  PostgresSecurityEventSink,
} from "@cdf/infrastructure";
import { USERS, admin, bff, caseId, type UserKey } from "../support/db";

let root: string;
let evidence: EvidenceService;
let caseA: string;
const investigation = createInvestigationService({
  gateway: new PostgresInvestigationGateway(bff),
  securityEvents: new PostgresSecurityEventSink(bff),
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cdf-evidence-it-"));
  evidence = createEvidenceService({
    gateway: new PostgresEvidenceGateway(bff),
    storage: new LocalFilesystemEvidenceStorage({ rootDir: root, environment: "test", isVercel: false }),
    scanner: new MockMalwareScanner(),
    securityEvents: new PostgresSecurityEventSink(bff),
  });
  caseA = await caseId("0001");
});
afterAll(() => rm(root, { recursive: true, force: true }));

const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });
async function actor(user: UserKey): Promise<Actor> {
  const a = await investigation.loadActor(ctxFor(user));
  if (!a) throw new Error(`no actor for ${user}`);
  return a;
}
async function readAll(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const c of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
  return Buffer.concat(chunks);
}

describe("evidence slice", () => {
  const pdf = Buffer.from(`%PDF-1.7\n% synthetic evidence ${randomUUID()}\n`);
  const sha = createHash("sha256").update(pdf).digest("hex");
  const meta = {
    caseId: "",
    title: "Synthetic invoice batch",
    evidenceType: "DOCUMENT",
    classification: "CONFIDENTIAL",
    sourceDescription: "Finance shared drive (synthetic)",
  };

  it("stores a clean file, lists it with its hash and streams it back to an authorised downloader", async () => {
    const a = await actor("investigatorA");
    const r = await evidence.upload(
      ctxFor("investigatorA"),
      a,
      { ...meta, caseId: caseA },
      { name: "invoices.pdf", bytes: pdf },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.sha256).toBe(sha);

    const items = await evidence.listEvidence(ctxFor("lead"), caseA);
    const item = items.find((i) => i.id === r.value.evidenceId)!;
    expect(item).toMatchObject({ status: "AVAILABLE", title: meta.title, classification: "CONFIDENTIAL" });
    expect(item.currentVersion).toMatchObject({
      versionNo: 1,
      originalFileName: "invoices.pdf",
      contentType: "application/pdf",
      sizeBytes: pdf.length,
      sha256: sha,
      status: "AVAILABLE",
      scanStatus: "CLEAN",
    });
    expect(item.custody.map((c) => c.eventType)).toEqual(["RECEIVED", "STORED"]);

    const download = await evidence.openDownload(ctxFor("lead"), r.value.versionId);
    expect(download).not.toBeNull();
    expect(download!.fileName).toBe("invoices.pdf");
    const body = await readAll(download!.stream);
    expect(body.equals(pdf)).toBe(true);
    expect(createHash("sha256").update(body).digest("hex")).toBe(download!.sha256);

    // An outsider and a viewer without the permission get nothing, and the denial is on record.
    expect(await evidence.openDownload(ctxFor("investigatorB"), r.value.versionId)).toBeNull();
    expect(await evidence.openDownload(ctxFor("triage"), r.value.versionId)).toBeNull();
    const denials = await admin<{ n: number }[]>`
      select count(*)::int as n from audit.audit_event where action = 'EVIDENCE_ACCESS_DENIED' and object_id = ${r.value.versionId}`;
    expect(denials[0]!.n).toBe(2);
    const after = await evidence.listEvidence(ctxFor("investigatorA"), caseA);
    expect(after.find((i) => i.id === item.id)!.custody.map((c) => c.eventType)).toEqual([
      "RECEIVED",
      "STORED",
      "DOWNLOADED",
    ]);
  });

  it("rejects the EICAR test file at the scanner and leaves the rejected version on record", async () => {
    const a = await actor("investigatorA");
    const r = await evidence.upload(
      ctxFor("investigatorA"),
      a,
      { ...meta, caseId: caseA, title: "Suspicious attachment" },
      { name: "attachment.txt", bytes: new TextEncoder().encode(EICAR_TEST_SIGNATURE) },
    );
    expect(!r.ok && "error" in r && `${r.error.kind}:${r.error.detail}`).toBe("CONFLICT:MALWARE_DETECTED");
    const items = await evidence.listEvidence(ctxFor("investigatorA"), caseA);
    const item = items.find((i) => i.title === "Suspicious attachment" && i.status === "REJECTED")!;
    expect(item.currentVersion).toBeNull();
    expect(item.versions[0]).toMatchObject({
      status: "REJECTED",
      scanStatus: "INFECTED",
      rejectionCode: "MALWARE_DETECTED",
    });
    const events = await admin<{ action: string; category: string }[]>`
      select action, category from audit.audit_event where object_id = ${item.versions[0]!.id} order by seq`;
    expect(events).toEqual([
      { action: "EVIDENCE_RECEIVED", category: "BUSINESS" },
      { action: "EVIDENCE_REJECTED", category: "BUSINESS" },
      { action: "MALWARE_DETECTED", category: "SECURITY" },
    ]);
  });

  it("adds versions to an item, refusing an identical file", async () => {
    const a = await actor("investigatorA");
    const first = await evidence.upload(
      ctxFor("investigatorA"),
      a,
      { ...meta, caseId: caseA, title: "Versioned memo" },
      { name: "memo.txt", bytes: Buffer.from("synthetic memo v1") },
    );
    if (!first.ok) throw new Error(JSON.stringify(first));
    const dup = await evidence.upload(
      ctxFor("investigatorA"),
      a,
      { caseId: caseA, evidenceId: first.value.evidenceId },
      { name: "memo.txt", bytes: Buffer.from("synthetic memo v1") },
    );
    expect(!dup.ok && "error" in dup && dup.error.detail).toBe("DUPLICATE_VERSION");
    const second = await evidence.upload(
      ctxFor("investigatorA"),
      a,
      { caseId: caseA, evidenceId: first.value.evidenceId },
      { name: "memo-v2.txt", bytes: Buffer.from("synthetic memo v2") },
    );
    expect(second.ok && second.value.versionNo).toBe(2);
    const item = (await evidence.listEvidence(ctxFor("investigatorA"), caseA)).find(
      (i) => i.id === first.value.evidenceId,
    )!;
    expect(item.currentVersion?.versionNo).toBe(2);
    expect(item.versions.map((v) => v.status)).toEqual(["AVAILABLE", "AVAILABLE"]);
    // Earlier versions stay downloadable and intact.
    const v1 = await evidence.openDownload(ctxFor("investigatorA"), first.value.versionId);
    expect((await readAll(v1!.stream)).toString()).toBe("synthetic memo v1");
  });

  it("refuses disallowed files before any storage or database write", async () => {
    const a = await actor("investigatorA");
    const before = (await evidence.listEvidence(ctxFor("investigatorA"), caseA)).length;
    const r = await evidence.upload(
      ctxFor("investigatorA"),
      a,
      { ...meta, caseId: caseA },
      { name: "payload.pdf", bytes: Buffer.from("MZ\u0000\u0001 not a pdf") },
    );
    expect(!r.ok && "error" in r && r.error.detail).toBe("FILE_CONTENT_MISMATCH");
    expect((await evidence.listEvidence(ctxFor("investigatorA"), caseA)).length).toBe(before);
  });
});
