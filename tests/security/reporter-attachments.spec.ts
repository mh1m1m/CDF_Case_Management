// CDF-72 · ADR-015, Drive field 19, §22–§27, §40, threats T02/T05/T10/T21: reporter attachments on the public
// portal. Credentials never reveal whether a Report ID exists, limits hold per report and per client, nothing is
// overwritten or deleted, nothing is downloadable before a clean scan, visibility follows the report (intake
// rules before a case, authz.can_view_case after), and every command writes its audit event.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { admin, newReportRef, reportId, scenario, type Scenario, type UserKey } from "../support/db";

const INTAKE_REF = "WB-SEED00000005"; // RECEIVED, no case
const CASE_B_REF = "WB-SEED00000002"; // case CDF-DEMO-2026-0002 (investigatorB's case)
// Seed reports store sha256('unusable-seed-secret:' || ref) as their secret HMAC (seed 02), so tests can
// present it directly as p_secret_hmac without the portal's pepper.
const seedHmac = (ref: string) =>
  createHash("sha256").update(`unusable-seed-secret:${ref}`, "utf8").digest("hex");
const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");

let intakeReport: string;
beforeAll(async () => {
  intakeReport = await reportId(INTAKE_REF);
});

interface Registered {
  attachment_id: string;
  object_key: string;
  display_name: string;
}

async function register(
  tx: Tx,
  ref: string,
  opts: { hmac?: string; ext?: string; type?: string; size?: number; hash?: string; source?: string } = {},
): Promise<Registered[]> {
  return tx<Registered[]>`
    select * from public_api.register_report_attachment(${ref}, ${opts.hmac ?? seedHmac(ref)}, ${opts.source ?? "REPORT"},
      ${opts.ext ?? "pdf"}, ${opts.type ?? "application/pdf"}, ${opts.size ?? 2048}, ${opts.hash ?? sha(randomUUID())})`;
}

/** Registers and completes an attachment as the anonymous portal; returns its id. */
async function availableAttachment(s: Scenario, ref: string): Promise<string> {
  await s.as(null);
  const [row] = await register(s.tx, ref);
  const [done] = await s.tx<{ ok: boolean }[]>`
    select public_api.complete_report_attachment(${ref}, ${seedHmac(ref)}, ${row!.attachment_id}, 'CLEAN', 'test-scanner') as ok`;
  expect(done!.ok).toBe(true);
  return row!.attachment_id;
}

async function eventsSince(s: Scenario, seq: number) {
  await s.as("dpo");
  return s.tx<{ action: string; category: string; outcome: string; actor_type: string; metadata: unknown }[]>`
    select action, category, outcome, actor_type, metadata from audit.audit_event where seq > ${seq} order by seq`;
}
async function lastSeq(s: Scenario): Promise<number> {
  await s.as("dpo");
  const [row] = await s.tx<{ seq: string }[]>`select coalesce(max(seq), 0) as seq from audit.audit_event`;
  return Number(row!.seq);
}

async function open(s: Scenario, user: UserKey, id: string) {
  await s.as(user);
  return s.tx<
    { o_display_name: string; o_object_key: string }[]
  >`select * from api.open_report_attachment(${id})`;
}

describe("credentials: a wrong secret is indistinguishable from an unknown Report ID", () => {
  it("returns nothing for both, records the same security event and stores nothing", async () => {
    await scenario(async (s) => {
      const before = await lastSeq(s);
      await s.as(null);
      const wrong = await register(s.tx, INTAKE_REF, { hmac: "0".repeat(64) });
      const unknown = await register(s.tx, newReportRef(), { hmac: "0".repeat(64) });
      expect(wrong).toEqual([]);
      expect(unknown).toEqual([]);
      for (const fn of ["complete_report_attachment", "reject_report_attachment"]) {
        const args = fn === "complete_report_attachment" ? "'CLEAN', 'x'" : "'SCAN_UNAVAILABLE', null, null";
        const [a] = await s.tx.unsafe<{ ok: boolean }[]>(
          `select public_api.${fn}($1, $2, $3, ${args}) as ok`,
          [INTAKE_REF, "0".repeat(64), randomUUID()],
        );
        expect(a!.ok, fn).toBe(false);
      }
      const events = await eventsSince(s, before);
      expect(events.map((e) => [e.action, e.category, e.outcome, e.actor_type])).toEqual(
        Array(4).fill(["REPORT_ACCESS_FAILED", "SECURITY", "DENIED", "ANONYMOUS_REPORTER"]),
      );
      // The intake team sees every attachment of this pre-case report through RLS: none was stored.
      await s.as("intake");
      const [count] = await s.tx<{ n: number }[]>`
        select count(*)::int as n from intake.report_attachment where report_id = ${intakeReport}`;
      expect(count!.n).toBe(0);
    });
  });

  it("an attachment of another report is answered like a missing one", async () => {
    await scenario(async (s) => {
      await s.as(null);
      const [other] = await register(s.tx, CASE_B_REF);
      const [ok] = await s.tx<{ ok: boolean }[]>`
        select public_api.complete_report_attachment(${INTAKE_REF}, ${seedHmac(INTAKE_REF)}, ${other!.attachment_id}, 'CLEAN', 'x') as ok`;
      expect(ok!.ok).toBe(false);
      const [no] = await s.tx<{ ok: boolean }[]>`
        select public_api.reject_report_attachment(${INTAKE_REF}, ${seedHmac(INTAKE_REF)}, ${other!.attachment_id}, 'STORAGE_FAILURE') as ok`;
      expect(no!.ok).toBe(false);
    });
  });
});

describe("registration re-validates every fact (third layer, §45)", () => {
  const cases: [string, Parameters<typeof register>[2], string][] = [
    ["extension not matching the type", { ext: "exe", type: "application/pdf" }, "CDF_INVALID:content_type"],
    ["type not on the allow-list", { ext: "html", type: "text/html" }, "CDF_INVALID:content_type"],
    ["file over 4 MiB", { size: 4_194_305 }, "CDF_INVALID:size_bytes"],
    ["empty file", { size: 0 }, "CDF_INVALID:size_bytes"],
    ["malformed hash", { hash: "xyz" }, "CDF_INVALID:sha256"],
    ["unknown source", { source: "EMAIL" }, "CDF_INVALID:source"],
  ];
  it.each(cases)("refuses %s", async (_name, opts, error) => {
    await scenario(async (s) => {
      await s.as(null);
      await s.expectError(error, (tx) => register(tx, INTAKE_REF, opts));
    });
  });

  it("generates the object key and display name; nothing user-controlled reaches either", async () => {
    await scenario(async (s) => {
      await s.as(null);
      const [a] = await register(s.tx, INTAKE_REF, { ext: "PNG", type: "image/png" });
      expect(a!.object_key).toBe(`reports/${intakeReport}/attachments/${a!.attachment_id}`);
      expect(a!.display_name).toBe("ATT-001.png");
      const [b] = await register(s.tx, INTAKE_REF, { source: "FOLLOW_UP" });
      expect(b!.display_name).toBe("ATT-002.pdf");
    });
  });
});

describe("per-report limits and duplicates", () => {
  it("accepts at most 10 live files per report", async () => {
    await scenario(async (s) => {
      await s.as(null);
      for (let i = 0; i < 10; i++) await register(s.tx, INTAKE_REF);
      await s.expectError("CDF_CONFLICT:ATTACHMENT_LIMIT", (tx) => register(tx, INTAKE_REF));
    });
  });

  it("accepts at most 20 MiB of live files per report, and a rejected file frees its share", async () => {
    await scenario(async (s) => {
      await s.as(null);
      const rows: Registered[] = [];
      for (let i = 0; i < 5; i++) rows.push(...(await register(s.tx, INTAKE_REF, { size: 4_194_304 })));
      await s.expectError("CDF_CONFLICT:ATTACHMENT_LIMIT", (tx) => register(tx, INTAKE_REF, { size: 1 }));
      await s.tx`select public_api.reject_report_attachment(${INTAKE_REF}, ${seedHmac(INTAKE_REF)}, ${rows[0]!.attachment_id}, 'SCAN_UNAVAILABLE', 'UNSCANNED', 'x')`;
      expect(await register(s.tx, INTAKE_REF, { size: 1 })).toHaveLength(1);
    });
  });

  it("refuses the same content twice on one report", async () => {
    await scenario(async (s) => {
      await s.as(null);
      const hash = sha("same content");
      await register(s.tx, INTAKE_REF, { hash });
      await s.expectError("CDF_CONFLICT:DUPLICATE_ATTACHMENT", (tx) => register(tx, INTAKE_REF, { hash }));
    });
  });

  it("refuses uploads to a closed report", async () => {
    await scenario(async (s) => {
      await s.as("triage");
      await s.tx`select api.triage_report(${intakeReport}, 'CLOSE_NO_ACTION', 'Synthetic: closing for the attachment test.', null, null)`;
      await s.as(null);
      await s.expectError("CDF_CONFLICT:REPORT_CLOSED", (tx) => register(tx, INTAKE_REF));
    });
  });
});

describe("rate limits by count and by bytes", () => {
  it("consume_rate_limit_amount adds the amount and refuses past the limit", async () => {
    await scenario(async (s) => {
      await s.as(null);
      const bucket = `portal_attachment_kib:${randomUUID().replaceAll("-", "")}`;
      const take = async (amount: number) =>
        (
          await s.tx<
            { ok: boolean }[]
          >`select public_api.consume_rate_limit_amount(${bucket}, ${amount}, 40960, 3600) as ok`
        )[0]!.ok;
      expect(await take(4096)).toBe(true);
      expect(await take(36864)).toBe(true); // exactly at the limit
      expect(await take(1)).toBe(false);
      await s.expectError(
        "CDF_INVALID:rate_limit",
        (tx) => tx`select public_api.consume_rate_limit_amount(${bucket}, 0, 10, 60)`,
      );
      await s.expectError(
        "CDF_INVALID:rate_limit",
        (tx) => tx`select public_api.consume_rate_limit_amount(${bucket}, -5, 10, 60)`,
      );
    });
  });

  it("consume_rate_limit_amount refuses every bucket but the portal's byte bucket", async () => {
    await scenario(async (s) => {
      await s.as(null);
      // A byte budget on a report's failed-access counter would lock a known Report ID in one call.
      const lockout = `report_fail:${createHash("sha256").update(INTAKE_REF).digest("hex")}`;
      for (const bucket of [
        lockout,
        "portal_submit:abc",
        "portal_attachment_kib:",
        "portal_attachment_kib:a b",
      ])
        await s.expectError(
          "CDF_INVALID:rate_limit_bucket",
          (tx) => tx`select public_api.consume_rate_limit_amount(${bucket}, 1048576, 104857600, 900)`,
        );
    });
  });
});

/** Runs as the table owner (the migration role) in a transaction that is always rolled back. */
async function asOwner(
  fn: (tx: Tx, expectError: (pattern: RegExp, run: () => Promise<unknown>) => Promise<void>) => Promise<void>,
) {
  class Rollback extends Error {}
  await admin
    .begin(async (tx) => {
      await tx`select set_config('cdf.request_id', ${randomUUID()}, true)`;
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
      await fn(tx as unknown as Tx, expectError);
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

describe("no overwrite, no delete", () => {
  it("rejects delete and truncate for the owner too, and any change once stored", async () => {
    await asOwner(async (tx, expectError) => {
      const [a] = await register(tx, INTAKE_REF);
      await tx`select public_api.complete_report_attachment(${INTAKE_REF}, ${seedHmac(INTAKE_REF)}, ${a!.attachment_id}, 'CLEAN', 'x')`;
      await expectError(
        /cannot be deleted/,
        () => tx`delete from intake.report_attachment where id = ${a!.attachment_id}`,
      );
      await expectError(/cannot be deleted/, () => tx`truncate intake.report_attachment`);
      await expectError(
        /immutable once AVAILABLE/,
        () =>
          tx`update intake.report_attachment set status = 'REJECTED', rejection_code = 'STORAGE_FAILURE', stored_at = null where id = ${a!.attachment_id}`,
      );
    });
  });

  it("content fields are immutable even while quarantined, and a stored file cannot be completed again", async () => {
    await asOwner(async (tx, expectError) => {
      const [a] = await register(tx, INTAKE_REF);
      await expectError(
        /content fields are immutable/,
        () =>
          tx`update intake.report_attachment set object_key = ${`reports/${intakeReport}/attachments/${randomUUID()}`} where id = ${a!.attachment_id}`,
      );
      await expectError(
        /content fields are immutable/,
        () =>
          tx`update intake.report_attachment set sha256 = ${"a".repeat(64)} where id = ${a!.attachment_id}`,
      );
    });
    await scenario(async (s) => {
      await s.as(null);
      const [a] = await register(s.tx, INTAKE_REF);
      await s.tx`select public_api.complete_report_attachment(${INTAKE_REF}, ${seedHmac(INTAKE_REF)}, ${a!.attachment_id}, 'CLEAN', 'x')`;
      await s.expectError(
        "CDF_CONFLICT:ATTACHMENT_NOT_QUARANTINED",
        (tx) =>
          tx`select public_api.complete_report_attachment(${INTAKE_REF}, ${seedHmac(INTAKE_REF)}, ${a!.attachment_id}, 'CLEAN', 'x')`,
      );
      const [b] = await register(s.tx, INTAKE_REF);
      await s.expectError(
        "CDF_INVALID:scan_status",
        (tx) =>
          tx`select public_api.complete_report_attachment(${INTAKE_REF}, ${seedHmac(INTAKE_REF)}, ${b!.attachment_id}, 'INFECTED', 'x')`,
      );
    });
  });

  it("no application role can write the table directly or read object keys", async () => {
    await scenario(async (s) => {
      for (const user of [null, "intake", "platformAdmin"] as (UserKey | null)[]) {
        await s.as(user);
        await s.expectError(
          "permission denied",
          (tx) =>
            tx`insert into intake.report_attachment (report_id, sequence_no, source, object_key, file_extension, content_type, size_bytes, sha256)
             values (${intakeReport}, 99, 'REPORT', ${`reports/${intakeReport}/attachments/${randomUUID()}`}, 'pdf', 'application/pdf', 1, ${"b".repeat(64)})`,
        );
      }
      await s.as("intake");
      await s.expectError("permission denied", (tx) => tx`select object_key from intake.report_attachment`);
      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select id from intake.report_attachment`);
    });
  });
});

describe("download gate: clean scan first, then report visibility", () => {
  it("a quarantined or rejected file cannot be downloaded, even by the intake team", async () => {
    await scenario(async (s) => {
      await s.as(null);
      const [q] = await register(s.tx, INTAKE_REF);
      const [r] = await register(s.tx, INTAKE_REF);
      await s.tx`select public_api.reject_report_attachment(${INTAKE_REF}, ${seedHmac(INTAKE_REF)}, ${r!.attachment_id}, 'MALWARE_DETECTED', 'INFECTED', 'x')`;
      const before = await lastSeq(s);
      expect(await open(s, "intake", q!.attachment_id)).toEqual([]);
      expect(await open(s, "intake", r!.attachment_id)).toEqual([]);
      const events = await eventsSince(s, before);
      expect(events.map((e) => [e.action, e.category, e.outcome])).toEqual(
        Array(2).fill(["REPORT_ATTACHMENT_ACCESS_DENIED", "SECURITY", "DENIED"]),
      );
      // The intake team still sees both rows, with their state, so nothing is silently lost.
      await s.as("intake");
      const rows = await s.tx<{ status: string }[]>`
        select status from intake.report_attachment where report_id = ${intakeReport} order by sequence_no`;
      expect(rows.map((x) => x.status)).toEqual(["QUARANTINED", "REJECTED"]);
    });
  });

  it("before a case: the intake team may list and download; case teams and administrators may not", async () => {
    await scenario(async (s) => {
      const id = await availableAttachment(s, INTAKE_REF);
      const [got] = await open(s, "intake", id);
      expect(got!.o_display_name).toBe("ATT-001.pdf");
      expect(got!.o_object_key).toBe(`reports/${intakeReport}/attachments/${id}`);
      for (const user of [
        "investigatorA",
        "platformAdmin",
        "internalAudit",
        "soc",
        "committee",
      ] as UserKey[]) {
        expect(await open(s, user, id), user).toEqual([]);
        await s.as(user);
        expect(await s.tx`select id from intake.report_attachment where id = ${id}`, user).toEqual([]);
      }
    });
  });

  it("after a case: visibility is the case's (authz.can_view_case); the intake team loses access", async () => {
    await scenario(async (s) => {
      const id = await availableAttachment(s, CASE_B_REF);
      expect(await open(s, "investigatorB", id)).toHaveLength(1);
      for (const user of ["investigatorA", "intake", "platformAdmin", "committee"] as UserKey[]) {
        expect(await open(s, user, id), user).toEqual([]);
        await s.as(user);
        expect(await s.tx`select id from intake.report_attachment where id = ${id}`, user).toEqual([]);
      }
    });
  });

  it("a random id and a hidden attachment get the same answer", async () => {
    await scenario(async (s) => {
      const id = await availableAttachment(s, CASE_B_REF);
      expect(await open(s, "investigatorA", id)).toEqual(await open(s, "investigatorA", randomUUID()));
    });
  });
});

describe("every command writes its audit event in the same transaction", () => {
  it("received, stored, rejected (with a malware security event) and downloaded; no file names or identity", async () => {
    await scenario(async (s) => {
      const before = await lastSeq(s);
      const stored = await availableAttachment(s, INTAKE_REF);
      await s.as(null);
      const [bad] = await register(s.tx, INTAKE_REF, { source: "FOLLOW_UP" });
      await s.tx`select public_api.reject_report_attachment(${INTAKE_REF}, ${seedHmac(INTAKE_REF)}, ${bad!.attachment_id}, 'MALWARE_DETECTED', 'INFECTED', 'mock')`;
      await open(s, "intake", stored);
      const events = await eventsSince(s, before);
      expect(events.map((e) => [e.action, e.category, e.outcome, e.actor_type])).toEqual([
        ["REPORT_ATTACHMENT_RECEIVED", "BUSINESS", "SUCCESS", "ANONYMOUS_REPORTER"],
        ["REPORT_ATTACHMENT_STORED", "BUSINESS", "SUCCESS", "ANONYMOUS_REPORTER"],
        ["REPORT_ATTACHMENT_RECEIVED", "BUSINESS", "SUCCESS", "ANONYMOUS_REPORTER"],
        ["REPORT_ATTACHMENT_REJECTED", "BUSINESS", "FAILURE", "ANONYMOUS_REPORTER"],
        ["MALWARE_DETECTED", "SECURITY", "FAILURE", "ANONYMOUS_REPORTER"],
        ["REPORT_ATTACHMENT_DOWNLOADED", "BUSINESS", "SUCCESS", "USER"],
      ]);
      for (const e of events) {
        const text = JSON.stringify(e.metadata);
        expect(text).not.toMatch(/file_name|object_key|reports\//);
      }
    });
  });

  it("a refused registration leaves no business event", async () => {
    await scenario(async (s) => {
      const before = await lastSeq(s);
      await s.as(null);
      await s.expectError("CDF_INVALID:size_bytes", (tx) => register(tx, INTAKE_REF, { size: 0 }));
      const events = await eventsSince(s, before);
      expect(events.filter((e) => e.category === "BUSINESS")).toEqual([]);
    });
  });
});
