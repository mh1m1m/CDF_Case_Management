// §24–§27, ADR-006, threats T05/T10: evidence follows the investigation team and clearance (DEC-09, migration 1850;
// the full role matrix is in evidence-need-to-know.spec.ts), content facts are validated by the database, versions are
// immutable, downloads are gated and audited.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { USERS, admin, caseId, ownerScenario, scenario, type Scenario, type UserKey } from "../support/db";
import { REASON_2050, newSha, storeEvidence, storeRendition } from "../support/evidence";

let caseA: string, caseB: string;
beforeAll(async () => {
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
});

const SHA = (c: string) => c.repeat(64);
interface Registered {
  evidenceId: string;
  versionId: string;
  versionNo: number;
  objectKey: string;
}
async function register(
  tx: Tx,
  target: string,
  opts: {
    evidenceId?: string | null;
    title?: string;
    classification?: string;
    fileName?: string;
    contentType?: string;
    size?: number;
    sha?: string;
  } = {},
): Promise<Registered> {
  const [row] = await tx<Registered[]>`
    select o_evidence_id as "evidenceId", o_version_id as "versionId", o_version_no as "versionNo", o_object_key as "objectKey"
    from api.register_evidence_version(${target}, ${opts.evidenceId ?? null}, ${opts.title ?? "Synthetic ledger extract"}, null,
      'DOCUMENT', 'Synthetic source', null, ${opts.classification ?? "CONFIDENTIAL"}::core.classification_level,
      ${opts.fileName ?? "ledger.pdf"}, ${opts.contentType ?? "application/pdf"}, ${opts.size ?? 2048}, ${opts.sha ?? SHA("a")})`;
  return row!;
}
const complete = (tx: Tx, versionId: string) =>
  tx`select api.complete_evidence_version(${versionId}, 'CLEAN', 'test-scanner')`;
const openCount = async (tx: Tx, versionId: string) => {
  const [r] = await tx<
    { n: number }[]
  >`select count(*)::int as n from api.open_evidence_version(${versionId})`;
  return r!.n;
};
/** 1 when the item is visible to the current actor, 0 otherwise (other tests may leave items on the seed cases). */
const visibleItems = async (tx: Tx, evidenceId: string) => {
  const [r] = await tx<
    { n: number }[]
  >`select count(*)::int as n from evidence.evidence where id = ${evidenceId}`;
  return r!.n;
};

/** Stored evidence on case A by investigator A, inside the caller's scenario. */
async function storedOnCaseA(s: Scenario): Promise<Registered> {
  await s.as("investigatorA");
  const reg = await register(s.tx, caseA);
  await complete(s.tx, reg.versionId);
  return reg;
}

describe("evidence visibility", () => {
  it("is limited to the investigation team on the case (DEC-09)", async () => {
    await scenario(async (s) => {
      const reg = await storedOnCaseA(s);
      const matrix: [UserKey, number][] = [
        ["investigatorA", 1],
        ["lead", 1],
        ["caseManager", 1],
        ["grcDirector", 0], // sees the case (CASE_VIEW_ALL), is not the team: evidence through a packet only (S5)
        ["triage", 0], // its TRIAGE grant ended at hand-over (S3, DEC-03); before it, the reporter's files only
        ["investigatorB", 0],
        ["committee", 0],
        ["platformAdmin", 0],
        ["internalAudit", 0],
        ["soc", 0],
        ["dpo", 0],
        ["revoked", 0],
      ];
      for (const [user, expected] of matrix) {
        await s.as(user);
        expect(await visibleItems(s.tx, reg.evidenceId), user).toBe(expected);
        const versions = await s.tx<
          { id: string }[]
        >`select id from evidence.evidence_version where evidence_id = ${reg.evidenceId}`;
        expect(versions.length, `${user} versions`).toBe(expected);
        const custody = await s.tx<
          { id: string }[]
        >`select id from evidence.custody_event where evidence_id = ${reg.evidenceId}`;
        expect(custody.length, `${user} custody`).toBe(expected === 1 ? 2 : 0);
      }
    });
  });

  it("hides items classified above the viewer's clearance even when the case is visible", async () => {
    await scenario(async (s) => {
      // Case B is RESTRICTED; the case manager (CONFIDENTIAL clearance, CASE_EDIT_ALL) files CONFIDENTIAL evidence
      // and grants the intake officer (RESTRICTED clearance) access to the case.
      await s.as("caseManager");
      const reg = await register(s.tx, caseB, { classification: "CONFIDENTIAL" });
      await complete(s.tx, reg.versionId);
      await s.tx`select api.grant_case_access(${caseB}, ${USERS.intake}, 'CASE', 'Synthetic: clearance test', null)`;
      await s.as("investigatorB"); // assigned, CONFIDENTIAL clearance
      expect(await visibleItems(s.tx, reg.evidenceId)).toBe(1);
      await s.as("intake"); // CASE grant on case B but RESTRICTED clearance
      const [caseVisible] = await s.tx<{ ok: boolean }[]>`select authz.can_view_case(${caseB}) as ok`;
      expect(caseVisible!.ok).toBe(true);
      expect(await visibleItems(s.tx, reg.evidenceId)).toBe(0);
      expect(await openCount(s.tx, reg.versionId)).toBe(0);
    });
  });

  it("never exposes the storage key to application roles", async () => {
    await scenario(async (s) => {
      await storedOnCaseA(s);
      await s.expectError("permission denied", (tx) => tx`select object_key from evidence.evidence_version`);
      await s.expectError("permission denied", (tx) => tx`select request_id from evidence.evidence_version`);
      const [cols] = await s.tx<{ cols: string[] }[]>`
        select array_agg(column_name::text order by column_name) as cols from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'evidence' and table_name = 'evidence_version'`;
      expect(cols!.cols).not.toContain("object_key");
      expect(cols!.cols).not.toContain("request_id");
    });
  });
});

describe("evidence upload gate", () => {
  it("requires the permission and a working assignment or edit rights on an active, visible case", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.tx`select api.grant_case_access(${caseA}, ${USERS.dpo}, 'AUDIT', 'Synthetic: audit scope', null)`;
      await s.as("dpo"); // sees case A through an AUDIT grant; no EVIDENCE_UPLOAD
      await s.expectError("CDF_FORBIDDEN", (tx) => register(tx, caseA));
      await s.as("triage"); // its TRIAGE grant ended when case A was handed over (S3, DEC-03)
      await s.expectError("CDF_NOT_FOUND", (tx) => register(tx, caseA));
      await s.as("grcDirector"); // has EVIDENCE_UPLOAD and sees the case, but is neither assigned nor an editor
      await s.expectError("CDF_FORBIDDEN", (tx) => register(tx, caseA));
      await s.as("investigatorB"); // cannot see case A at all
      await s.expectError("CDF_NOT_FOUND", (tx) => register(tx, caseA));
      await s.expectError("CDF_NOT_FOUND", (tx) => register(tx, randomUUID()));
      await s.as("committee");
      await s.expectError("CDF_NOT_FOUND", (tx) => register(tx, caseA));
      await s.as("caseManager"); // CASE_EDIT_ALL
      expect((await register(s.tx, caseA)).versionNo).toBe(1);
      await s.as("lead"); // assigned LEAD_INVESTIGATOR
      expect((await register(s.tx, caseA, { sha: SHA("b") })).versionNo).toBe(1);
    });
  });

  it("validates the file facts a third time in the database", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      await s.expectError("CDF_INVALID:content_type", (tx) =>
        register(tx, caseA, { fileName: "tool.exe", contentType: "application/x-msdownload" }),
      );
      await s.expectError("CDF_INVALID:content_type", (tx) =>
        register(tx, caseA, { contentType: "text/html" }),
      );
      await s.expectError("CDF_INVALID:size_bytes", (tx) => register(tx, caseA, { size: 0 }));
      await s.expectError("CDF_INVALID:size_bytes", (tx) => register(tx, caseA, { size: 26_214_401 }));
      await s.expectError("CDF_INVALID:sha256", (tx) => register(tx, caseA, { sha: "not-a-hash" }));
      await s.expectError("CDF_INVALID:file_name", (tx) =>
        register(tx, caseA, { fileName: "../../etc/passwd" }),
      );
      await s.expectError("CDF_INVALID:file_name", (tx) => register(tx, caseA, { fileName: "a\\b.pdf" }));
      await s.expectError("CDF_INVALID:title", (tx) => register(tx, caseA, { title: "ab" }));
      // Case A is CONFIDENTIAL; investigator A's clearance is CONFIDENTIAL.
      await s.expectError("CDF_INVALID:classification", (tx) =>
        register(tx, caseA, { classification: "RESTRICTED" }),
      );
      await s.expectError("CDF_INVALID:classification", (tx) =>
        register(tx, caseA, { classification: "SECRET" }),
      );
    });
  });

  it("lets only the uploader complete or reject a version, exactly once", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const reg = await register(s.tx, caseA);
      await s.as("lead");
      await s.expectError("CDF_FORBIDDEN", (tx) => complete(tx, reg.versionId));
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.reject_evidence_version(${reg.versionId}, 'STORAGE_FAILURE')`,
      );
      await s.as("investigatorB");
      await s.expectError("CDF_NOT_FOUND", (tx) => complete(tx, reg.versionId));
      await s.as("investigatorA");
      await s.expectError(
        "CDF_INVALID:scan_status",
        (tx) => tx`select api.complete_evidence_version(${reg.versionId}, 'INFECTED', 'x')`,
      );
      await complete(s.tx, reg.versionId);
      await s.expectError("CDF_CONFLICT:VERSION_NOT_QUARANTINED", (tx) => complete(tx, reg.versionId));
      await s.expectError(
        "CDF_CONFLICT:VERSION_NOT_QUARANTINED",
        (tx) => tx`select api.reject_evidence_version(${reg.versionId}, 'STORAGE_FAILURE')`,
      );
    });
  });

  it("keeps one live copy of the same content per item and allows a retry after rejection", async () => {
    await scenario(async (s) => {
      const reg = await storedOnCaseA(s);
      await s.expectError("CDF_CONFLICT:DUPLICATE_VERSION", (tx) =>
        register(tx, caseA, { evidenceId: reg.evidenceId, fileName: "ledger-v2.pdf" }),
      );
      const v2 = await register(s.tx, caseA, {
        evidenceId: reg.evidenceId,
        fileName: "ledger-v2.pdf",
        sha: SHA("c"),
      });
      expect(v2.versionNo).toBe(2);
      await s.tx`select api.reject_evidence_version(${v2.versionId}, 'MALWARE_DETECTED', 'INFECTED', 'test-scanner')`;
      const v3 = await register(s.tx, caseA, {
        evidenceId: reg.evidenceId,
        fileName: "ledger-v2.pdf",
        sha: SHA("c"),
      });
      expect(v3.versionNo).toBe(3);
      const [item] = await s.tx<{ status: string; current: string }[]>`
        select status, current_version_id as current from evidence.evidence where id = ${reg.evidenceId}`;
      expect(item).toEqual({ status: "AVAILABLE", current: reg.versionId });
    });
  });
});

describe("evidence download gate", () => {
  it("returns nothing and records a SECURITY event for viewers without the permission and for outsiders", async () => {
    await scenario(async (s) => {
      const reg = await storedOnCaseA(s);
      await s.as("grcDirector"); // sees the case, is not the investigation team (DEC-09)
      expect(await openCount(s.tx, reg.versionId)).toBe(0);
      await s.as("investigatorB");
      expect(await openCount(s.tx, reg.versionId)).toBe(0);
      expect(await openCount(s.tx, randomUUID())).toBe(0);
      await s.as("soc");
      const events = await s.tx<
        { outcome: string; meta: { target_exists: boolean; case_visible: boolean | null } }[]
      >`
        select outcome, metadata as meta from audit.audit_event
        where action = 'EVIDENCE_ACCESS_DENIED' and object_id = ${reg.versionId} order by seq`;
      expect(events.map((e) => [e.outcome, e.meta.target_exists, e.meta.case_visible])).toEqual([
        ["DENIED", true, true], // GRC director: visible case, not the team
        ["DENIED", true, false], // investigator B: invisible case
      ]);
    });
  });

  it("refuses quarantined and rejected versions even for the uploader", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const reg = await register(s.tx, caseA);
      expect(await openCount(s.tx, reg.versionId)).toBe(0);
      await s.tx`select api.reject_evidence_version(${reg.versionId}, 'STORAGE_FAILURE')`;
      expect(await openCount(s.tx, reg.versionId)).toBe(0);
    });
  });

  it("records custody and audit for every permitted download", async () => {
    await scenario(async (s) => {
      const reg = await storedOnCaseA(s);
      await s.as("lead");
      expect(await openCount(s.tx, reg.versionId)).toBe(1);
      expect(await openCount(s.tx, reg.versionId)).toBe(1);
      const custody = await s.tx<{ event_type: string; actor_id: string }[]>`
        select event_type, actor_id from evidence.custody_event where version_id = ${reg.versionId} order by seq`;
      expect(custody.map((c) => c.event_type)).toEqual(["RECEIVED", "STORED", "DOWNLOADED", "DOWNLOADED"]);
      expect(custody.at(-1)!.actor_id).toBe(USERS.lead);
      const audit = await s.tx<{ action: string }[]>`
        select action from audit.audit_event where case_id = ${caseA} and object_id = ${reg.versionId} order by seq`;
      expect(audit.map((a) => a.action)).toEqual([
        "EVIDENCE_RECEIVED",
        "EVIDENCE_STORED",
        "EVIDENCE_DOWNLOADED",
        "EVIDENCE_DOWNLOADED",
      ]);
    });
  });
});

describe("evidence integrity", () => {
  it("denies direct writes to application roles", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.expectError(
        "permission denied",
        (tx) =>
          tx`insert into evidence.evidence (case_id, sequence_no, title, evidence_type, classification, created_by)
              values (${caseA}, 99, 'direct', 'OTHER', 'CONFIDENTIAL', ${USERS.caseManager})`,
      );
      await s.expectError(
        "permission denied",
        (tx) => tx`update evidence.evidence_version set status = 'AVAILABLE'`,
      );
      await s.expectError("permission denied", (tx) => tx`delete from evidence.custody_event`);
      await s.expectError(
        "permission denied",
        (tx) => tx`update evidence.allowed_content_type set extensions = '{exe}'`,
      );
    });
  });

  it("rejects overwrite and delete of stored versions and custody events for the owner too", async () => {
    class Rollback extends Error {}
    await admin
      .begin(async (tx) => {
        await tx`select set_config('cdf.request_id', ${randomUUID()}, true)`;
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USERS.investigatorA, role: "authenticated" })}, true)`;
        const reg = await register(tx as unknown as Tx, caseA);
        await complete(tx as unknown as Tx, reg.versionId);
        const expectError = async (pattern: RegExp, run: () => Promise<unknown>) => {
          let message = "";
          try {
            await tx.savepoint(async () => {
              await run();
            });
          } catch (e) {
            message = (e as Error).message;
          }
          expect(message).toMatch(pattern);
        };
        await expectError(
          /immutable once AVAILABLE/,
          () => tx`update evidence.evidence_version set sha256 = ${SHA("0")} where id = ${reg.versionId}`,
        );
        await expectError(
          /immutable once AVAILABLE/,
          () =>
            tx`update evidence.evidence_version set status = 'REJECTED', rejection_code = 'STORAGE_FAILURE' where id = ${reg.versionId}`,
        );
        await expectError(
          /append-only/,
          () => tx`delete from evidence.evidence_version where id = ${reg.versionId}`,
        );
        await expectError(
          /append-only/,
          () => tx`delete from evidence.evidence where id = ${reg.evidenceId}`,
        );
        await expectError(
          /append-only/,
          () =>
            tx`update evidence.custody_event set event_type = 'STORED' where version_id = ${reg.versionId}`,
        );
        await expectError(
          /append-only/,
          () => tx`delete from evidence.custody_event where version_id = ${reg.versionId}`,
        );
        await expectError(/append-only/, () => tx`truncate evidence.custody_event`);
        // A quarantined version may change only its outcome, never its content facts.
        const q = await register(tx as unknown as Tx, caseA, { sha: SHA("d") });
        await expectError(
          /content fields are immutable/,
          () => tx`update evidence.evidence_version set size_bytes = 1 where id = ${q.versionId}`,
        );
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
  });

  it("writes audit events without file names or content and keeps the chain intact", async () => {
    await scenario(async (s) => {
      const reg = await storedOnCaseA(s);
      await s.as("internalAudit");
      const rows = await s.tx<{ action: string; metadata: Record<string, unknown>; case_id: string }[]>`
        select action, metadata, case_id from audit.audit_event where object_id = ${reg.versionId} order by seq`;
      expect(rows.map((r) => r.action)).toEqual(["EVIDENCE_RECEIVED", "EVIDENCE_STORED"]);
      for (const r of rows) {
        expect(r.case_id).toBe(caseA);
        expect(JSON.stringify(r.metadata)).not.toContain("ledger.pdf");
        expect(r.metadata).toMatchObject({ evidence_id: reg.evidenceId, version_no: 1 });
      }
      const [chain] = await s.tx<{ n: number }[]>`select count(*)::int as n from api.verify_audit_chain()`;
      expect(chain!.n).toBe(0);
    });
  });
});

describe("ambiguity register: no API deletes an evidence object (CDF-205, ADR-013 D7)", () => {
  it("T-AMB-101: neither storage adapter offers a delete, and the only removal is the transient quarantine copy", async () => {
    const { readFileSync } = await import("node:fs");
    const { LocalFilesystemEvidenceStorage, SupabaseEvidenceStorage } = await import("@cdf/infrastructure");
    for (const adapter of [LocalFilesystemEvidenceStorage, SupabaseEvidenceStorage]) {
      const methods = Object.getOwnPropertyNames(adapter.prototype);
      expect(
        methods.filter((m) => /delete|remove|destroy|purge|unlink|erase|overwrite|replace/i.test(m)),
        adapter.name,
      ).toEqual([]);
    }
    // Source check: a removal or unlink only ever names the quarantine copy, after it reached the vault.
    const supabase = readFileSync("packages/infrastructure/src/storage/supabase.ts", "utf8");
    const removals = supabase.split("\n").filter((l) => /\.remove\(/.test(l));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatch(/from\(QUARANTINE_BUCKET\)\.remove\(\[key\]\)/);
    const local = readFileSync("packages/infrastructure/src/storage/local-fs.ts", "utf8");
    const unlinks = local.split("\n").filter((l) => /\b(unlink|rm|rmdir)\(/.test(l));
    expect(unlinks.map((l) => l.trim())).toEqual(["await unlink(source);"]);
    expect(local).toMatch(/const source = this\.path\(QUARANTINE_BUCKET, objectKey\);/);
  });

  it("T-AMB-101: no application role may delete a stored object row, whatever the bucket", async () => {
    await scenario(async (s) => {
      for (const user of ["investigatorA", "lead", "caseManager", "grcDirector", "platformAdmin"] as const) {
        await s.as(user);
        await s.tx
          .savepoint(async (sp) => {
            const deleted = await sp`delete from storage.objects returning id`.catch((e: Error) => e.message);
            // Either the role has no privilege, RLS (with no policy) hides every row, or (Supabase CLI stack) the
            // storage schema's own delete guard refuses the statement: nothing is deleted.
            expect(typeof deleted === "string" ? deleted : deleted.length, user).toSatisfy(
              (v: unknown) =>
                v === 0 ||
                (typeof v === "string" &&
                  (v.startsWith("permission denied") ||
                    v ===
                      "Direct deletion from storage tables is not allowed. Use the Storage API instead.")),
            );
            throw new Error("rollback");
          })
          .catch((e: Error) => {
            if (e.message !== "rollback") throw e;
          });
      }
    });
  });
});

describe("ambiguity register: custody exceptions, integrity and renditions (migration 2050, ADR-041)", () => {
  it("T-AMB-097: a custody exception cannot be removed once recorded; an external transfer names its reference", async () => {
    await ownerScenario(async (s) => {
      const v = await storeEvidence(s, "investigatorA", caseA);
      await s.as("investigatorA");
      await s.expectError(
        "CDF_INVALID:external_reference",
        (tx) => tx`select api.record_custody_exception(${v.evidenceId}, ${v.versionId}, 'EXTERNAL_TRANSFER',
                     'Synthetic: sent to the examiner by courier.', null)`,
      );
      await s.expectError(
        "CDF_INVALID:kind",
        (tx) =>
          tx`select api.record_custody_exception(${v.evidenceId}, null, 'DOWNLOADED', ${REASON_2050}, null)`,
      );
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) =>
          tx`select api.record_custody_exception(${v.evidenceId}, null, 'CUSTODY_EXCEPTION', 'short', null)`,
      );
      const [x] = await s.tx<{ id: string }[]>`
        select api.record_custody_exception(${v.evidenceId}, ${v.versionId}, 'CUSTODY_EXCEPTION',
          'Synthetic: unique-custody-marker-2050, seal found broken on receipt.', null) as id`;
      const [t] = await s.tx<{ id: string }[]>`
        select api.record_custody_exception(${v.evidenceId}, ${v.versionId}, 'EXTERNAL_TRANSFER',
          'Synthetic: sent for forensic examination.', 'EXT-DEMO-0001') as id`;
      expect(
        await s.tx`select event_type from evidence.custody_event where evidence_id = ${v.evidenceId} order by seq`,
      ).toEqual([
        { event_type: "RECEIVED" },
        { event_type: "STORED" },
        { event_type: "CUSTODY_EXCEPTION" },
        { event_type: "EXTERNAL_TRANSFER" },
      ]);
      expect(
        await s.tx`select kind, external_reference from evidence.custody_exception where id = ${t!.id}`,
      ).toEqual([{ kind: "EXTERNAL_TRANSFER", external_reference: "EXT-DEMO-0001" }]);
      // Outside the team the item is not found; the reason stays out of the ledger.
      for (const u of ["investigatorB", "committee", "grcDirector", "platformAdmin"] as const) {
        await s.as(u);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) =>
            tx`select api.record_custody_exception(${v.evidenceId}, null, 'CUSTODY_EXCEPTION', ${REASON_2050}, null)`,
        );
        expect(
          await s.tx`select id from evidence.custody_exception where evidence_id = ${v.evidenceId}`,
          u,
        ).toEqual([]);
      }
      // No application role writes the table, and no one, the owner included, changes or removes a row.
      await s.as("caseManager");
      await s.expectError(
        "permission denied",
        (tx) => tx`delete from evidence.custody_exception where id = ${x!.id}`,
      );
      await s.expectError(
        "permission denied",
        (tx) =>
          tx`update evidence.custody_exception set reason = 'Synthetic: rewritten.' where id = ${x!.id}`,
      );
      await s.asOwner();
      await s.expectError(
        "evidence.custody_exception is append-only",
        (tx) =>
          tx`update evidence.custody_exception set reason = 'Synthetic: rewritten.' where id = ${x!.id}`,
      );
      await s.expectError(
        "evidence.custody_exception is append-only",
        (tx) => tx`delete from evidence.custody_exception where id = ${x!.id}`,
      );
      await s.expectError(
        "evidence.custody_exception is append-only",
        (tx) => tx`truncate evidence.custody_exception`,
      );
      await s.expectError(
        "evidence.custody_event is append-only",
        (tx) =>
          tx`delete from evidence.custody_event where evidence_id = ${v.evidenceId} and event_type = 'CUSTODY_EXCEPTION'`,
      );
      // A forged row must point at its own custody event (same item, version, kind and case).
      const [received] = await s.tx<{ id: string }[]>`
        select id from evidence.custody_event where evidence_id = ${v.evidenceId} and event_type = 'RECEIVED'`;
      await s.expectError(
        "CDF_INVALID:custody_event_id",
        (
          tx,
        ) => tx`insert into evidence.custody_exception (evidence_id, version_id, case_id, kind, reason, custody_event_id,
                     recorded_by)
                   values (${v.evidenceId}, ${v.versionId}, ${caseA}, 'CUSTODY_EXCEPTION', 'Synthetic: forged row.',
                     ${received!.id}, ${USERS.investigatorA})`,
      );
      const audit = await s.tx<{ reason: string | null; metadata: Record<string, unknown> }[]>`
        select reason, metadata from audit.audit_event
        where action = 'EVIDENCE_CUSTODY_EXCEPTION_RECORDED' and object_id in (${x!.id}, ${t!.id})`;
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toContain("unique-custody-marker-2050");
      expect(audit.every((a) => a.reason === null)).toBe(true);
    });
  });

  it("T-AMB-098: once a hash mismatch is reported, nobody gets the version, and the case owner is told", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      await s.tx`select api.assign_case(${caseA}, ${USERS.caseManager}, 'CASE_OWNER', ${REASON_2050})`;
      const v = await storeEvidence(s, "investigatorA", caseA);
      // Only a reader who may download the version reports it; a well-formed, different hash only.
      for (const u of ["investigatorB", "committee", "grcDirector"] as const) {
        await s.as(u);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.report_evidence_integrity_failure(${v.versionId}, ${newSha()})`,
        );
      }
      await s.as("investigatorA");
      await s.expectError(
        "CDF_INVALID:observed_sha256",
        (tx) => tx`select api.report_evidence_integrity_failure(${v.versionId}, 'not-a-hash')`,
      );
      await s.expectError(
        "CDF_CONFLICT:HASH_MATCHES",
        (tx) => tx`select api.report_evidence_integrity_failure(${v.versionId}, ${v.sha256})`,
      );
      expect(await openCount(s.tx, v.versionId)).toBe(1);
      const observed = newSha();
      await s.tx`select api.report_evidence_integrity_failure(${v.versionId}, ${observed})`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_REPORTED",
        (tx) => tx`select api.report_evidence_integrity_failure(${v.versionId}, ${newSha()})`,
      );
      // Nobody gets it from now on, the uploader and the case manager included, and no rendition is made from it.
      for (const u of ["investigatorA", "lead", "caseManager"] as const) {
        await s.as(u);
        expect(await openCount(s.tx, v.versionId), u).toBe(0);
      }
      await s.as("lead");
      await s.expectError(
        "CDF_CONFLICT:INTEGRITY_FAILED",
        (tx) =>
          tx`select * from api.register_evidence_rendition(${v.versionId}, 'r.pdf', 'application/pdf', 10, ${newSha()})`,
      );
      // The version row itself never changes; the failure is its own record, kept with a custody event.
      await s.asOwner();
      expect(
        await s.tx`select status, sha256 from evidence.evidence_version where id = ${v.versionId}`,
      ).toEqual([{ status: "AVAILABLE", sha256: v.sha256 }]);
      expect(
        await s.tx`select expected_sha256, observed_sha256 from evidence.integrity_failure where version_id = ${v.versionId}`,
      ).toEqual([{ expected_sha256: v.sha256, observed_sha256: observed }]);
      await s.expectError(
        "evidence.integrity_failure is append-only",
        (tx) => tx`delete from evidence.integrity_failure where version_id = ${v.versionId}`,
      );
      const security = await s.tx<{ action: string; outcome: string; metadata: Record<string, unknown> }[]>`
        select action, outcome, metadata from audit.audit_event
        where category = 'SECURITY' and object_id = ${v.versionId} order by seq`;
      expect(security[0]).toMatchObject({ action: "EVIDENCE_INTEGRITY_FAILED", outcome: "FAILURE" });
      const denials = security.filter((e) => e.action === "EVIDENCE_ACCESS_DENIED");
      expect(denials).toHaveLength(3);
      expect(denials.every((d) => d.metadata.integrity_failed === true)).toBe(true);
      expect(
        await s.tx`select recipient_id, object_type, object_id from notify.outbox
                   where template_code = 'EVIDENCE_INTEGRITY_FAILED' and channel = 'IN_APP'
                     and dedupe_key like ${"evidence-integrity:" + v.versionId + ":%"}`,
      ).toEqual([{ recipient_id: USERS.caseManager, object_type: "CASE", object_id: caseA }]);
    });
  });

  it("T-AMB-100: a redacted rendition never changes or replaces the original", async () => {
    await ownerScenario(async (s) => {
      const v = await storeEvidence(s, "investigatorA", caseA);
      // Only an evidence lead makes a rendition (DEC-09).
      await s.as("investigatorA");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select * from api.register_evidence_rendition(${v.versionId}, 'r.pdf', 'application/pdf', 10, ${newSha()})`,
      );
      await s.as("investigatorB");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select * from api.register_evidence_rendition(${v.versionId}, 'r.pdf', 'application/pdf', 10, ${newSha()})`,
      );
      const r = await storeRendition(s, "lead", v.versionId);
      await s.as("investigatorA");
      expect(await s.tx`select current_version_id from evidence.evidence where id = ${v.evidenceId}`).toEqual(
        [{ current_version_id: v.versionId }],
      );
      expect(
        await s.tx`select id, version_no, rendition, derived_from_version_id, sha256, status from evidence.evidence_version
                   where evidence_id = ${v.evidenceId} order by version_no`,
      ).toEqual([
        {
          id: v.versionId,
          version_no: 1,
          rendition: "ORIGINAL",
          derived_from_version_id: null,
          sha256: v.sha256,
          status: "AVAILABLE",
        },
        {
          id: r.versionId,
          version_no: 2,
          rendition: "REDACTED",
          derived_from_version_id: v.versionId,
          sha256: r.sha256,
          status: "AVAILABLE",
        },
      ]);
      // A new original after the rendition still becomes current; a rendition is never current.
      const v2 = await storeEvidence(s, "investigatorA", caseA, { evidenceId: v.evidenceId });
      expect(await s.tx`select current_version_id from evidence.evidence where id = ${v.evidenceId}`).toEqual(
        [{ current_version_id: v2.versionId }],
      );
      // No rendition of a rendition; a forged row must name an original of the same item.
      await s.as("lead");
      await s.expectError(
        "CDF_CONFLICT:NOT_AN_ORIGINAL",
        (tx) =>
          tx`select * from api.register_evidence_rendition(${r.versionId}, 'r2.pdf', 'application/pdf', 10, ${newSha()})`,
      );
      const other = await storeEvidence(s, "investigatorA", caseA);
      await s.asOwner();
      for (const source of [r.versionId, other.versionId]) {
        await s.expectError(
          "CDF_CONFLICT:RENDITION_SOURCE_INVALID",
          (
            tx,
          ) => tx`insert into evidence.evidence_version (evidence_id, version_no, object_key, original_file_name,
                       content_type, size_bytes, sha256, uploaded_by, rendition, derived_from_version_id)
                     values (${v.evidenceId}, 9, ${"cases/" + caseA + "/evidence/" + v.evidenceId + "/" + randomUUID()},
                       'f.pdf', 'application/pdf', 10, ${newSha()}, ${USERS.lead}, 'REDACTED', ${source})`,
        );
      }
      // The original's content facts stay immutable, the rendition's too.
      await s.expectError(
        `evidence version ${v.versionId} is immutable once AVAILABLE`,
        (tx) => tx`update evidence.evidence_version set sha256 = ${newSha()} where id = ${v.versionId}`,
      );
      await s.expectError(
        `evidence version ${r.versionId} is immutable once AVAILABLE`,
        (tx) => tx`update evidence.evidence_version set derived_from_version_id = null, rendition = 'ORIGINAL'
                   where id = ${r.versionId}`,
      );
    });
  });
});
