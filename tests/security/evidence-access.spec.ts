// §24–§27, ADR-006, threats T05/T10: evidence follows case access and clearance, content facts are
// validated by the database, versions are immutable, downloads are gated and audited.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { USERS, admin, caseId, scenario, type Scenario, type UserKey } from "../support/db";

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
  it("is limited to people who can view the case", async () => {
    await scenario(async (s) => {
      const reg = await storedOnCaseA(s);
      const matrix: [UserKey, number][] = [
        ["investigatorA", 1],
        ["lead", 1],
        ["caseManager", 1],
        ["grcDirector", 1],
        ["triage", 1], // TRIAGE grant: may see the item exists, cannot download (below)
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
      await s.as("triage"); // sees case A through a grant; no EVIDENCE_UPLOAD
      await s.expectError("CDF_FORBIDDEN", (tx) => register(tx, caseA));
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
      await s.as("triage");
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
        ["DENIED", true, true], // triage: visible case, no permission
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
