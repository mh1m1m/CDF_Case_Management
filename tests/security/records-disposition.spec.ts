// ADR-013 D2, D3, D6, D7, threats T28–T30: retention is computed from SOURCE_REQUIRED classes (so nothing
// is eligible until CDF supplies values), disposition needs two different people, any hold stops it, and
// execution is logical only: the case disappears from case roles and a hashed certificate is issued.
// Test ids refer to architecture/threat-model/RECORDS_TEST_DEFINITIONS.md.
import { beforeAll, describe, expect, it } from "vitest";
import { caseId, ownerScenario, scenario, USERS, type Scenario } from "../support/db";
import {
  DECISION,
  JUSTIFICATION,
  closeAndArchive,
  makeEligible,
  placeHold,
  recordsState,
  requestDisposition,
} from "../support/records";

let caseB: string, caseExec: string;
beforeAll(async () => {
  [caseB, caseExec] = await Promise.all([caseId("0002"), caseId("0003")]);
});

/** Investigator B (assigned to case B) stores one evidence version while the case is still active. */
async function evidenceOnCaseB(s: Scenario): Promise<{ versionId: string }> {
  await s.as("investigatorB");
  const [row] = await s.tx<{ versionId: string }[]>`
    select o_version_id as "versionId"
    from api.register_evidence_version(${caseB}, null, 'Synthetic tender sheet', null, 'DOCUMENT', 'Synthetic source', null,
      'RESTRICTED'::core.classification_level, 'tender.pdf', 'application/pdf', 1024, ${"6".repeat(64)})`;
  await s.tx`select api.complete_evidence_version(${row!.versionId}, 'CLEAN', 'test-scanner')`;
  return row!;
}

const currentSchedule = (s: Scenario) =>
  s.tx<
    { retention_class: string; trigger_event: string; trigger_at: Date | null; retain_until: Date | null }[]
  >`
    select retention_class, trigger_event, trigger_at, retain_until
    from records.retention_schedule where case_id = ${caseB} and superseded_at is null`;

describe("retention schedule", () => {
  it("REC-T25: shipped classes are SOURCE_REQUIRED, so a case never becomes eligible", async () => {
    await scenario(async (s) => {
      await closeAndArchive(s, caseB);
      await s.as("records");
      expect((await recordsState(s.tx, caseB)).records_state).toBe("ARCHIVED");
      const [atClosure] = await currentSchedule(s);
      expect(atClosure).toMatchObject({
        retention_class: "UNASSIGNED",
        trigger_event: "CASE_CLOSED",
        retain_until: null,
      });
      await s.tx`select api.assign_retention_class(${caseB}, 'WB_CASE_NOT_INVESTIGATED')`;
      await s.tx`select api.refresh_disposition_eligibility()`;
      expect((await recordsState(s.tx, caseB)).records_state).toBe("RETENTION");
      const [after] = await currentSchedule(s);
      expect(after).toMatchObject({ retention_class: "WB_CASE_NOT_INVESTIGATED", retain_until: null });
      expect(after!.trigger_at).not.toBeNull();
      const classes = await s.tx<{ status: string }[]>`select distinct status from records.retention_class`;
      expect(classes).toEqual([{ status: "SOURCE_REQUIRED" }]);
    });
  });

  it("REC-T26: a configured class whose period has elapsed makes the case eligible, audited", async () => {
    await ownerScenario(async (s) => {
      await makeEligible(s, caseB);
      expect((await recordsState(s.tx, caseB)).records_state).toBe("DISPOSITION_ELIGIBLE");
      await s.as("internalAudit");
      const actions = await s.tx<{ action: string }[]>`
        select action from audit.audit_event
        where case_id = ${caseB} and (action like 'RETENTION_%' or action like 'DISPOSITION_%') order by seq`;
      expect(actions.map((a) => a.action)).toEqual([
        "RETENTION_SCHEDULE_COMPUTED",
        "RETENTION_CLASS_ASSIGNED",
        "RETENTION_SCHEDULE_SUPERSEDED",
        "RETENTION_SCHEDULE_COMPUTED",
        "DISPOSITION_ELIGIBLE_MARKED",
      ]);
    });
  });

  it("REC-T27: reopening a closed case supersedes its schedule instead of editing it", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      await s.tx`update workflow.workflow_transition_definition set is_enabled = true where code = 'REOPEN_CASE'`;
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', 'Synthetic: screened out for the records suite.')`;
      await s.tx`select api.transition_case(${caseB}, 'REOPEN_CASE', 'Synthetic: new information received.')`;
      await s.asOwner();
      const rows = await s.tx<{ superseded_reason: string | null }[]>`
        select superseded_reason from records.retention_schedule where case_id = ${caseB}`;
      expect(rows).toEqual([{ superseded_reason: "REOPENED" }]);
      await s.expectError(
        "retention schedule",
        (tx) => tx`update records.retention_schedule set superseded_at = null where case_id = ${caseB}`,
      );
    });
  });

  it("REC-T28, T29: only records officers assign classes; a CONFIGURED class needs its source", async () => {
    await ownerScenario(async (s) => {
      await closeAndArchive(s, caseB);
      await s.as("investigatorB"); // assigned to case B, no RECORDS_VIEW
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.assign_retention_class(${caseB}, 'WB_CASE_INVESTIGATED')`,
      );
      await s.as("legal"); // RECORDS_VIEW without RETENTION_CLASS_ASSIGN
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.assign_retention_class(${caseB}, 'WB_CASE_INVESTIGATED')`,
      );
      await s.as("records");
      await s.expectError(
        "CDF_INVALID:retention_class",
        (tx) => tx`select api.assign_retention_class(${caseB}, 'UNASSIGNED')`,
      );
      await s.asOwner();
      await s.expectError(
        "new row for relation",
        (
          tx,
        ) => tx`insert into records.retention_class (code, name_en, name_ar, record_type, category, retention_period,
                     trigger_event, disposition_action, status, description)
                   values ('NO_SOURCE', 'x', 'x', 'CASE', 'TEMPORARY', interval '1 year', 'CASE_CLOSED', 'DESTROY',
                     'CONFIGURED', 'missing source')`,
      );
    });
  });

  it("freezes case content once archived", async () => {
    await scenario(async (s) => {
      await closeAndArchive(s, caseB);
      await s.expectError(
        "CDF_CONFLICT:RECORDS_READ_ONLY",
        (tx) =>
          tx`select api.update_case_details(c.id, 'Changed title (synthetic)', c.summary, c.priority, c.row_version)
           from case_mgmt.case_record c where c.id = ${caseB}`,
      );
    });
  });

  it("CDF-74: an archived case gains no new assignment, access grant or identity-reveal request", async () => {
    await scenario(async (s) => {
      await closeAndArchive(s, caseB);
      await s.expectError(
        "CDF_CONFLICT:RECORDS_READ_ONLY",
        (tx) =>
          tx`select api.assign_case(${caseB}, ${USERS.investigatorA}, 'INVESTIGATOR', 'Synthetic: late assignment')`,
      );
      await s.expectError(
        "CDF_CONFLICT:RECORDS_READ_ONLY",
        (tx) =>
          tx`select api.grant_case_access(${caseB}, ${USERS.legal}, 'REVIEW', 'Synthetic: late review')`,
      );
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:RECORDS_READ_ONLY",
        (tx) => tx`select api.request_identity_reveal(${caseB}, ${JUSTIFICATION})`,
      );
    });
  });

  it("CDF-75: case-linked tables reject DELETE and TRUNCATE for the owner too", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      for (const table of [
        "intake.report",
        "intake.report_message",
        "intake.report_triage",
        "case_mgmt.allegation",
        "case_mgmt.case_assignment",
        "case_mgmt.case_access_grant",
        "case_mgmt.conflict_check",
        "workflow.workflow_instance",
        "workflow.workflow_transition_event",
        "protected_identity.reporter_identity",
      ]) {
        await s.expectError(`${table} is a protected record`, (tx) => tx.unsafe(`delete from ${table}`));
        await s.expectError(`${table} is a protected record`, (tx) => tx.unsafe(`truncate ${table} cascade`));
      }
    });
  });
});

describe("disposition", () => {
  it("REC-T30, T38, T40: request, approval by someone else and logical execution with a verifiable certificate", async () => {
    await ownerScenario(async (s) => {
      const ev = await evidenceOnCaseB(s);
      await makeEligible(s, caseB);
      const reqId = await requestDisposition(s.tx, caseB);
      expect((await recordsState(s.tx, caseB)).records_state).toBe("DISPOSITION_PENDING");
      await s.as("grcDirector");
      await s.tx`select api.decide_disposition(${reqId}, true, ${DECISION})`;
      await s.as("records");
      const [cert] = await s.tx<{ id: string }[]>`select api.execute_disposition(${reqId}) as id`;
      expect((await recordsState(s.tx, caseB)).records_state).toBe("DISPOSED");

      const [c] = await s.tx<Record<string, unknown>[]>`
        select certificate_number, requested_by, approved_by, executed_by, active_holds_found, execution_mode,
               disposition_action, evidence_manifest, audit_event_id, audit_event_hash, certificate_hash
        from records.disposition_certificate where id = ${cert!.id}`;
      expect(c).toMatchObject({
        requested_by: USERS.records,
        approved_by: USERS.grcDirector,
        executed_by: USERS.records,
        active_holds_found: 0,
        execution_mode: "LOGICAL_ONLY",
        disposition_action: "DESTROY",
      });
      expect(c!.certificate_number).toMatch(/^CDF-DISP-\d{4}-\d{4,5}$/);
      expect(c!.evidence_manifest).toEqual([
        expect.objectContaining({ version_id: ev.versionId, sha256: "6".repeat(64) }),
      ]);
      expect(JSON.stringify(c!.evidence_manifest)).not.toContain("tender.pdf");
      const [ok] = await s.tx<
        { ok: boolean }[]
      >`select api.verify_disposition_certificate(${cert!.id}) as ok`;
      expect(ok!.ok).toBe(true);

      // The records view exposes metadata only.
      const [view] = await s.tx<Record<string, unknown>[]>`select * from api.list_records(null, ${caseB})`;
      expect(view).toMatchObject({ records_state: "DISPOSED", certificate_id: cert!.id });
      expect(Object.keys(view!)).not.toContain("title");
      expect(Object.keys(view!)).not.toContain("summary");

      await s.as("internalAudit");
      const [exec] = await s.tx<{ event_id: string; event_hash: string }[]>`
        select event_id, event_hash from audit.audit_event where action = 'DISPOSITION_EXECUTED' and case_id = ${caseB}`;
      expect(exec).toEqual({ event_id: c!.audit_event_id, event_hash: c!.audit_event_hash });
      const [chain] = await s.tx<{ n: number }[]>`select count(*)::int as n from api.verify_audit_chain()`;
      expect(chain!.n).toBe(0);

      // Tampering with a stored certificate is detectable (and blocked by the trigger for every role).
      await s.asOwner();
      await s.expectError(
        "records.disposition_certificate is a protected record",
        (tx) =>
          tx`update records.disposition_certificate set case_number = 'CDF-DEMO-2026-9999' where id = ${cert!.id}`,
      );
      await s.expectError(
        "records.disposition_certificate is a protected record",
        (tx) => tx`delete from records.disposition_certificate where id = ${cert!.id}`,
      );
      await s.expectError(
        "records.disposition_request is a protected record",
        (tx) => tx`delete from records.disposition_request where id = ${reqId}`,
      );
      await s.expectError(
        "records.retention_schedule is a protected record",
        (tx) => tx`delete from records.retention_schedule where case_id = ${caseB}`,
      );
    });
  });

  it("REC-T31, T32: the requester and records officers cannot approve", async () => {
    await ownerScenario(async (s) => {
      await makeEligible(s, caseB);
      const reqId = await requestDisposition(s.tx, caseB);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_disposition(${reqId}, true, ${DECISION})`,
      );
      await s.as("recordsB");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_disposition(${reqId}, true, ${DECISION})`,
      );
      await s.as("platformAdmin");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.decide_disposition(${reqId}, true, ${DECISION})`,
      );
      // The table enforces dual control too, whoever writes.
      await s.asOwner();
      await s.expectError(
        "new row for relation",
        (
          tx,
        ) => tx`update records.disposition_request set status = 'APPROVED', decided_by = requested_by, decided_at = now()
                   where id = ${reqId}`,
      );
    });
  });

  it("REC-T33, T34: requests need an eligible case, execution needs an approval", async () => {
    await ownerScenario(async (s) => {
      await closeAndArchive(s, caseB);
      await s.as("records");
      await s.tx`select api.assign_retention_class(${caseB}, 'WB_CASE_NOT_INVESTIGATED')`;
      await s.expectError("CDF_CONFLICT:NOT_ELIGIBLE", (tx) => requestDisposition(tx, caseB));
    });
    await ownerScenario(async (s) => {
      await makeEligible(s, caseB);
      const reqId = await requestDisposition(s.tx, caseB);
      await s.expectError(
        "CDF_CONFLICT:REQUEST_NOT_APPROVED",
        (tx) => tx`select api.execute_disposition(${reqId})`,
      );
    });
  });

  it("REC-T35: rejection returns the case to RETENTION; the reason stays in the request, the audit gets a code", async () => {
    await ownerScenario(async (s) => {
      await makeEligible(s, caseB);
      const reqId = await requestDisposition(s.tx, caseB);
      await s.as("grcDirector");
      await s.tx`select api.decide_disposition(${reqId}, false, ${DECISION})`;
      expect((await recordsState(s.tx, caseB)).records_state).toBe("RETENTION");
      const [req] = await s.tx<{ status: string; decision_reason: string }[]>`
        select status, decision_reason from records.disposition_request where id = ${reqId}`;
      expect(req).toEqual({ status: "REJECTED", decision_reason: DECISION });
      await s.as("internalAudit");
      const [audit] = await s.tx<{ reason: string }[]>`
        select reason from audit.audit_event where action = 'DISPOSITION_REJECTED' and object_id = ${reqId}`;
      expect(audit!.reason).toBe("REJECTED");
    });
  });

  it("REC-T37, T39, T45: a disposed case is gone for case roles and terminal for every command", async () => {
    await ownerScenario(async (s) => {
      const ev = await evidenceOnCaseB(s);
      await makeEligible(s, caseB);
      const reqId = await requestDisposition(s.tx, caseB);
      await s.as("grcDirector");
      await s.tx`select api.decide_disposition(${reqId}, true, ${DECISION})`;
      await s.tx`select api.execute_disposition(${reqId})`;

      for (const user of ["investigatorB", "caseManager", "grcDirector"] as const) {
        await s.as(user);
        const [opened] = await s.tx<{ ok: boolean }[]>`select api.open_case(${caseB}) as ok`;
        expect(opened!.ok).toBe(false);
        const listed = await s.tx`select 1 from case_mgmt.case_overview where id = ${caseB}`;
        expect(listed).toHaveLength(0);
        const files = await s.tx`select * from api.open_evidence_version(${ev.versionId})`;
        expect(files).toHaveLength(0);
      }
      await s.as("legal"); // authz.can_apply_legal_hold is false for a disposed case
      await s.expectError("CDF_FORBIDDEN", (tx) => placeHold(tx, caseB));
      await s.as("records");
      await s.expectError("CDF_CONFLICT:RECORDS_DISPOSED", (tx) => requestDisposition(tx, caseB));
      await s.expectError(
        "CDF_CONFLICT:RECORDS_STATE",
        (tx) => tx`select api.assign_retention_class(${caseB}, 'WB_CASE_INVESTIGATED')`,
      );
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:RECORDS_DISPOSED",
        (tx) => tx`update case_mgmt.case_record set records_state = 'RETENTION' where id = ${caseB}`,
      );
    });
  });

  it("REC-T45, T46: the records view never opens case content or restricted cases", async () => {
    await scenario(async (s) => {
      await s.as("records");
      const [opened] = await s.tx<{ ok: boolean }[]>`select api.open_case(${caseB}) as ok`;
      expect(opened!.ok).toBe(false);
      expect(await s.tx`select 1 from case_mgmt.case_overview`).toHaveLength(0);
      const ids = (await s.tx<{ case_id: string }[]>`select case_id from api.list_records()`).map(
        (r) => r.case_id,
      );
      expect(ids).toContain(caseB);
      expect(ids).not.toContain(caseExec);
    });
  });
});

describe("legal hold against disposition", () => {
  it("REC-T17: an elapsed case under hold is not marked eligible", async () => {
    await ownerScenario(async (s) => {
      await s.as("legal");
      await placeHold(s.tx, caseB);
      await makeEligible(s, caseB);
      expect(await recordsState(s.tx, caseB)).toEqual({
        records_state: "RETENTION",
        legal_hold_status: "ACTIVE",
      });
    });
  });

  it("REC-T18, T19: a hold moves an eligible or pending case back to RETENTION and blocks the request", async () => {
    await ownerScenario(async (s) => {
      await makeEligible(s, caseB);
      await s.as("legal");
      await placeHold(s.tx, caseB);
      expect((await recordsState(s.tx, caseB)).records_state).toBe("RETENTION");
    });
    await ownerScenario(async (s) => {
      await makeEligible(s, caseB);
      const reqId = await requestDisposition(s.tx, caseB);
      await s.as("legal");
      await placeHold(s.tx, caseB);
      await s.as("records");
      expect((await recordsState(s.tx, caseB)).records_state).toBe("RETENTION");
      const [req] = await s.tx<
        { status: string }[]
      >`select status from records.disposition_request where id = ${reqId}`;
      expect(req!.status).toBe("BLOCKED_BY_HOLD");
      await s.as("internalAudit");
      const [audit] = await s.tx<{ outcome: string; reason: string }[]>`
        select outcome, reason from audit.audit_event where action = 'DISPOSITION_BLOCKED_BY_HOLD' and object_id = ${reqId}`;
      expect(audit).toEqual({ outcome: "DENIED", reason: "LEGAL_HOLD_ACTIVE" });
    });
  });

  it("REC-T20: a hold placed after approval stops execution; no certificate, not disposed", async () => {
    await ownerScenario(async (s) => {
      await makeEligible(s, caseB);
      const reqId = await requestDisposition(s.tx, caseB);
      await s.as("grcDirector");
      await s.tx`select api.decide_disposition(${reqId}, true, ${DECISION})`;
      await s.as("legal");
      await placeHold(s.tx, caseB);
      await s.as("records");
      await s.expectError(
        "CDF_CONFLICT:LEGAL_HOLD_ACTIVE",
        (tx) => tx`select api.execute_disposition(${reqId})`,
      );
      expect((await recordsState(s.tx, caseB)).records_state).toBe("RETENTION");
      expect(await s.tx`select 1 from records.disposition_certificate where case_id = ${caseB}`).toHaveLength(
        0,
      );
    });
  });

  it("REC-T12: a hold with a pending release still blocks a disposition request", async () => {
    await ownerScenario(async (s) => {
      await makeEligible(s, caseB);
      await s.as("legal");
      const holdId = await placeHold(s.tx, caseB);
      await s.tx`select api.request_legal_hold_release(${holdId}, ${JUSTIFICATION})`;
      await s.as("records");
      await s.expectError("CDF_CONFLICT:LEGAL_HOLD_ACTIVE", (tx) => requestDisposition(tx, caseB));
    });
  });
});
