// ADR-013 D4, D5, threats T25–T27, T29: legal holds are placed by one authorised person, released only
// by two different people, block destruction paths, and stay invisible to people without a hold permission.
// Test ids refer to architecture/threat-model/RECORDS_TEST_DEFINITIONS.md.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { caseId, ownerScenario, scenario, USERS, type Scenario } from "../support/db";
import {
  DECISION,
  giveTask,
  JUSTIFICATION,
  legalHoldTasks,
  placeHold,
  recordsState,
  releaseHold,
} from "../support/records";

let caseA: string, caseB: string, caseExec: string;
beforeAll(async () => {
  [caseA, caseB, caseExec] = await Promise.all([caseId("0001"), caseId("0002"), caseId("0003")]);
});

async function storedEvidence(
  s: Scenario,
  target: string,
  sha: string,
): Promise<{ evidenceId: string; versionId: string }> {
  const [row] = await s.tx<{ evidenceId: string; versionId: string }[]>`
    select o_evidence_id as "evidenceId", o_version_id as "versionId"
    from api.register_evidence_version(${target}, null, 'Synthetic ledger extract', null, 'DOCUMENT', 'Synthetic source', null,
      'CONFIDENTIAL'::core.classification_level, 'ledger.pdf', 'application/pdf', 2048, ${sha.repeat(64)})`;
  await s.tx`select api.complete_evidence_version(${row!.versionId}, 'CLEAN', 'test-scanner')`;
  return row!;
}

const holdCount = async (tx: Tx, target: string) => {
  const [r] = await tx<
    { n: number }[]
  >`select count(*)::int as n from records.legal_hold where case_id = ${target}`;
  return r!.n;
};

describe("placing a legal hold", () => {
  it("REC-T01: a legal reviewer places a case hold; flag, history and audit land in the same transaction", async () => {
    await scenario(async (s) => {
      await legalHoldTasks(s, caseA);
      await s.as("legal");
      const holdId = await placeHold(s.tx, caseA);
      const [hold] = await s.tx<{ status: string; hold_number: string; placed_by: string }[]>`
        select status, hold_number, placed_by from records.legal_hold where id = ${holdId}`;
      expect(hold).toMatchObject({ status: "ACTIVE", placed_by: USERS.legal });
      expect(hold!.hold_number).toMatch(/^CDF-HOLD-\d{4}-\d{4,5}$/);
      expect((await recordsState(s.tx, caseA)).legal_hold_status).toBe("ACTIVE");
      const events = await s.tx<{ event_type: string; audit_event_id: string }[]>`
        select event_type, audit_event_id from records.legal_hold_event where hold_id = ${holdId}`;
      expect(events.map((e) => e.event_type)).toEqual(["PLACED"]);

      await s.as("internalAudit");
      const [audit] = await s.tx<{ event_id: string; reason: string; metadata: Record<string, unknown> }[]>`
        select event_id, reason, metadata from audit.audit_event where action = 'LEGAL_HOLD_PLACED' and object_id = ${holdId}`;
      expect(audit!.event_id).toBe(events[0]!.audit_event_id);
      expect(audit!.reason).toBe("LITIGATION");
      expect(audit!.metadata).toMatchObject({ scope_type: "CASE", reason_code: "LITIGATION" });
      expect(JSON.stringify(audit)).not.toContain("preservation");
    });
  });

  it("REC-T02, T03, T06, T13: people without LEGAL_HOLD_APPLY cannot place one", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA"); // assigned to case A, can see it
      await s.expectError("CDF_FORBIDDEN", (tx) => placeHold(tx, caseA));
      await s.as("platformAdmin");
      await s.expectError("CDF_NOT_FOUND", (tx) => placeHold(tx, caseA));
      await s.as("revoked");
      await s.expectError("CDF_UNAUTHENTICATED", (tx) => placeHold(tx, caseA));
      await s.as("legal");
      expect(await holdCount(s.tx, caseA)).toBe(0);
    });
  });

  it("REC-T04: a declared conflict removes the ability to place a hold", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseA}, ${USERS.legal}, 'CONFLICT_DECLARED', 'Synthetic conflict')`;
      await s.as("legal");
      await s.expectError("CDF_NOT_FOUND", (tx) => placeHold(tx, caseA));
    });
  });

  it("REC-T05: a restricted case without assignment or grant is indistinguishable from a missing one", async () => {
    await scenario(async (s) => {
      await s.as("legal");
      await s.expectError("CDF_NOT_FOUND", (tx) => placeHold(tx, caseExec));
      await s.expectError("CDF_NOT_FOUND", (tx) => placeHold(tx, randomUUID()));
    });
  });

  it("REC-T07: no application role writes records tables directly", async () => {
    await scenario(async (s) => {
      await s.as("legal");
      await s.expectError(
        "permission denied",
        (
          tx,
        ) => tx`insert into records.legal_hold (hold_number, scope_type, case_id, reason_code, justification, placed_by)
                   values ('CDF-HOLD-2026-9999', 'CASE', ${caseA}, 'OTHER', ${JUSTIFICATION}, ${USERS.legal})`,
      );
      await s.expectError("permission denied", (tx) => tx`update records.legal_hold set status = 'RELEASED'`);
      await s.expectError("permission denied", (tx) => tx`delete from records.legal_hold_event`);
      await s.expectError(
        "permission denied",
        (tx) => tx`update records.retention_class set status = 'CONFIGURED'`,
      );
      await s.expectError("permission denied", (tx) => tx`select * from records.number_counter`);
    });
  });

  it("REC-T08, T09: an evidence-item hold is scoped to an item of the same case; input is validated", async () => {
    await ownerScenario(async (s) => {
      await legalHoldTasks(s, caseA);
      await s.as("investigatorA");
      const ev = await storedEvidence(s, caseA, "1");
      await s.as("investigatorB");
      const other = await storedEvidence(s, caseB, "2");
      await s.as("legal");
      await s.expectError("CDF_INVALID:justification", (tx) =>
        placeHold(tx, caseA, { justification: "short" }),
      );
      await s.expectError("CDF_INVALID:evidence_id", (tx) =>
        placeHold(tx, caseA, { scope: "EVIDENCE_ITEM", evidenceId: other.evidenceId }),
      );
      await s.expectError("CDF_INVALID:evidence_id", (tx) =>
        placeHold(tx, caseA, { scope: "EVIDENCE_ITEM" }),
      );
      await s.expectError("CDF_INVALID:reason_code", (tx) => placeHold(tx, caseA, { reason: "BECAUSE" }));
      await placeHold(s.tx, caseA, { scope: "EVIDENCE_ITEM", evidenceId: ev.evidenceId });
      expect((await recordsState(s.tx, caseA)).legal_hold_status).toBe("ACTIVE");
      await s.asOwner();
      const [r] = await s.tx<{ item: boolean; other: boolean }[]>`
        select records.has_active_hold(${caseA}, ${ev.evidenceId}) as item,
               records.has_active_hold(${caseB}, ${other.evidenceId}) as other`;
      expect(r).toEqual({ item: true, other: false });
    });
  });
});

describe("releasing a legal hold", () => {
  it("REC-T10: two different people release it; the flag clears and every step is audited", async () => {
    await scenario(async (s) => {
      await legalHoldTasks(s, caseA);
      await s.as("legal");
      const holdId = await placeHold(s.tx, caseA);
      await releaseHold(s, holdId);
      const [hold] = await s.tx<
        { status: string }[]
      >`select status from records.legal_hold where id = ${holdId}`;
      expect(hold!.status).toBe("RELEASED");
      expect((await recordsState(s.tx, caseA)).legal_hold_status).toBe("NONE");
      const events = await s.tx<{ event_type: string }[]>`
        select event_type from records.legal_hold_event where hold_id = ${holdId} order by seq`;
      expect(events.map((e) => e.event_type)).toEqual(["PLACED", "RELEASE_REQUESTED", "RELEASE_APPROVED"]);
      await s.as("internalAudit");
      const audit = await s.tx<{ action: string }[]>`
        select action from audit.audit_event where case_id = ${caseA} and action like 'LEGAL_HOLD_%' order by seq`;
      expect(audit.map((a) => a.action)).toEqual([
        "LEGAL_HOLD_PLACED",
        "LEGAL_HOLD_RELEASE_REQUESTED",
        "LEGAL_HOLD_RELEASED",
      ]);
    });
  });

  it("REC-T11, T13: the requester cannot approve their own release, and records officers cannot release", async () => {
    await scenario(async (s) => {
      await legalHoldTasks(s, caseA);
      await giveTask(s, caseA, "records", "LEGAL_HOLD_APPLICATION");
      await s.as("records");
      const holdId = await placeHold(s.tx, caseA);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.request_legal_hold_release(${holdId}, ${JUSTIFICATION})`,
      );
      await s.as("legal");
      const [req] = await s.tx<
        { id: string }[]
      >`select api.request_legal_hold_release(${holdId}, ${JUSTIFICATION}) as id`;
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_legal_hold_release(${req!.id}, true, ${DECISION})`,
      );
      const [hold] = await s.tx<
        { status: string }[]
      >`select status from records.legal_hold where id = ${holdId}`;
      expect(hold!.status).toBe("RELEASE_PENDING");
      expect((await recordsState(s.tx, caseA)).legal_hold_status).toBe("ACTIVE");
    });
  });

  it("REC-T14: the flag stays until the last hold on the case is released", async () => {
    await scenario(async (s) => {
      await legalHoldTasks(s, caseA);
      await s.as("legal");
      const first = await placeHold(s.tx, caseA);
      const second = await placeHold(s.tx, caseA, { reason: "AUDIT" });
      await releaseHold(s, first);
      expect((await recordsState(s.tx, caseA)).legal_hold_status).toBe("ACTIVE");
      await releaseHold(s, second);
      expect((await recordsState(s.tx, caseA)).legal_hold_status).toBe("NONE");
    });
  });

  it("REC-T15: a rejected release puts the hold back to ACTIVE and allows a new request", async () => {
    await scenario(async (s) => {
      await legalHoldTasks(s, caseA);
      await s.as("legal");
      const holdId = await placeHold(s.tx, caseA);
      const [req] = await s.tx<
        { id: string }[]
      >`select api.request_legal_hold_release(${holdId}, ${JUSTIFICATION}) as id`;
      await s.as("legalB");
      await s.tx`select api.decide_legal_hold_release(${req!.id}, false, ${DECISION})`;
      await s.expectError(
        "CDF_CONFLICT:RELEASE_NOT_PENDING",
        (tx) => tx`select api.decide_legal_hold_release(${req!.id}, true, ${DECISION})`,
      );
      const [hold] = await s.tx<
        { status: string }[]
      >`select status from records.legal_hold where id = ${holdId}`;
      expect(hold!.status).toBe("ACTIVE");
      await s.as("legal");
      await s.tx`select api.request_legal_hold_release(${holdId}, ${JUSTIFICATION})`;
      await s.as("internalAudit");
      const [rej] = await s.tx<{ reason: string }[]>`
        select reason from audit.audit_event where action = 'LEGAL_HOLD_RELEASE_REJECTED' and object_id = ${req!.id}`;
      expect(rej!.reason).toBe("REJECTED");
    });
  });
});

describe("hold and record immutability", () => {
  it("REC-T16, T22: released holds, decided releases and protected records cannot be changed or deleted, owner included", async () => {
    await ownerScenario(async (s) => {
      await legalHoldTasks(s, caseA);
      await s.as("legal");
      const holdId = await placeHold(s.tx, caseA);
      await releaseHold(s, holdId);
      await s.asOwner();
      await s.expectError(
        "legal hold",
        (tx) => tx`update records.legal_hold set status = 'ACTIVE' where id = ${holdId}`,
      );
      await s.expectError(
        "legal hold release",
        (tx) =>
          tx`update records.legal_hold_release set decision_reason = 'changed' where hold_id = ${holdId}`,
      );
      for (const table of [
        "records.legal_hold",
        "records.legal_hold_release",
        "records.legal_hold_event",
        "records.retention_class",
        "records.retention_schedule",
        "records.disposition_request",
        "records.disposition_certificate",
        "case_mgmt.case_record",
      ]) {
        await s.expectError(`${table} is a protected record`, (tx) => tx.unsafe(`truncate ${table} cascade`));
      }
      // Row-level delete guards fire on tables that hold rows in this scenario.
      for (const table of [
        "records.legal_hold",
        "records.legal_hold_release",
        "records.legal_hold_event",
        "records.retention_class",
        "case_mgmt.case_record",
      ]) {
        await s.expectError(`${table} is a protected record`, (tx) => tx.unsafe(`delete from ${table}`));
      }
      await s.expectError(
        "records.legal_hold_event is a protected record",
        (tx) => tx`update records.legal_hold_event set actor_id = ${USERS.legal}`,
      );
    });
  });

  it("REC-T23: evidence under hold keeps its status, classification and available current version", async () => {
    await ownerScenario(async (s) => {
      await legalHoldTasks(s, caseA);
      await s.as("investigatorA");
      const ev = await storedEvidence(s, caseA, "3");
      await s.as("legal");
      await placeHold(s.tx, caseA, { scope: "EVIDENCE_ITEM", evidenceId: ev.evidenceId });
      await s.asOwner();
      await s.expectError(
        "evidence",
        (tx) => tx`update evidence.evidence set status = 'REJECTED' where id = ${ev.evidenceId}`,
      );
      await s.expectError(
        "evidence",
        (tx) => tx`update evidence.evidence set classification = 'INTERNAL' where id = ${ev.evidenceId}`,
      );
      await s.expectError(
        "evidence",
        (tx) => tx`update evidence.evidence set current_version_id = null where id = ${ev.evidenceId}`,
      );
      // Raising the classification is preservation, not destruction: allowed.
      await s.tx`update evidence.evidence set classification = 'SECRET' where id = ${ev.evidenceId}`;
    });
  });

  it("REC-T24: a hold preserves but does not freeze an active investigation", async () => {
    await scenario(async (s) => {
      await legalHoldTasks(s, caseA);
      await s.as("investigatorA");
      const ev = await storedEvidence(s, caseA, "4");
      await s.as("legal");
      await placeHold(s.tx, caseA);
      await s.as("investigatorA");
      const [next] = await s.tx<{ versionId: string }[]>`
        select o_version_id as "versionId" from api.register_evidence_version(${caseA}, ${ev.evidenceId}, 'Synthetic ledger extract', null, 'DOCUMENT',
          'Synthetic source', null, 'CONFIDENTIAL'::core.classification_level, 'ledger-v2.pdf', 'application/pdf', 4096,
          ${"5".repeat(64)})`;
      await s.tx`select api.complete_evidence_version(${next!.versionId}, 'CLEAN', 'test-scanner')`;
      const versions = await s.tx<{ status: string }[]>`
        select status from evidence.evidence_version where evidence_id = ${ev.evidenceId} order by version_no`;
      expect(versions.map((v) => v.status)).toEqual(["AVAILABLE", "AVAILABLE"]);
    });
  });
});

describe("hold visibility", () => {
  it("REC-T47: case staff without a hold permission see the flag, not the hold", async () => {
    await scenario(async (s) => {
      await legalHoldTasks(s, caseA);
      await s.as("legal");
      await placeHold(s.tx, caseA);
      await s.as("investigatorA");
      expect(await holdCount(s.tx, caseA)).toBe(0);
      const [c] = await s.tx<{ legal_hold_status: string }[]>`
        select legal_hold_status from case_mgmt.case_overview where id = ${caseA}`;
      expect(c!.legal_hold_status).toBe("ACTIVE");
      await s.as("grcDirector");
      expect(await holdCount(s.tx, caseA)).toBe(1);
    });
  });

  it("REC-T41: records events carry codes and ids, never the justification", async () => {
    await scenario(async (s) => {
      await legalHoldTasks(s, caseA);
      await s.as("legal");
      const holdId = await placeHold(s.tx, caseA);
      await releaseHold(s, holdId);
      await s.as("internalAudit");
      const rows = await s.tx<{ reason: string | null; metadata: unknown }[]>`
        select reason, metadata from audit.audit_event where case_id = ${caseA} and action like 'LEGAL_HOLD_%'`;
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(JSON.stringify(r)).not.toMatch(/Synthetic/);
      }
    });
  });
});
