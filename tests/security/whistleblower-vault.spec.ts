// §22, ADR-004: reporter identity is held only in protected_identity and is resolved only through a
// justified, dual-controlled, audited command. Investigators never see it.
import { beforeAll, describe, expect, it } from "vitest";
import { admin, caseId, scenario, type UserKey } from "../support/db";

let caseB: string; // identified reporter (Reporter Gamma, synthetic)
let caseA: string; // anonymous reporter
beforeAll(async () => {
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
});

const JUSTIFICATION = "Synthetic: need to contact the reporter about tender documents.";

describe("identity vault", () => {
  it.each<UserKey>([
    "investigatorA",
    "investigatorB",
    "caseManager",
    "grcDirector",
    "platformAdmin",
    "internalAudit",
    "dpo",
  ])("%s cannot read the vault directly", async (user) => {
    await scenario(async (s) => {
      await s.as(user);
      await s.expectError(
        "permission denied",
        (tx) => tx`select * from protected_identity.reporter_identity`,
      );
      await s.expectError("permission denied", (tx) => tx`select * from protected_identity.reveal_request`);
    });
  });

  it("report and case rows carry only the opaque WB-ID, never identity fields", async () => {
    const columns = await admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema in ('intake', 'case_mgmt') and column_name ~ '(full_name|email|phone|national_id)'`;
    expect(columns).toEqual([]);
    const [c] = await admin<
      { reporter_wb_id: string }[]
    >`select reporter_wb_id from case_mgmt.case_record where id = ${caseB}`;
    expect(c!.reporter_wb_id).toMatch(/^WBID-[0-9A-F]{16}$/);
  });

  it("an assigned investigator without the reveal permission is refused", async () => {
    await scenario(async (s) => {
      await s.as("investigatorB");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.request_identity_reveal(${caseB}, ${JUSTIFICATION})`,
      );
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select * from api.resolve_reporter_identity(${caseB}, ${JUSTIFICATION})`,
      );
    });
  });

  it("requires an approved request before resolution", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:APPROVED_REVEAL_REQUEST_REQUIRED",
        (tx) => tx`select * from api.resolve_reporter_identity(${caseB}, ${JUSTIFICATION})`,
      );
    });
  });

  it("enforces dual control: the requester cannot approve their own request", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      const [r] = await s.tx<
        { id: string }[]
      >`select api.request_identity_reveal(${caseB}, ${JUSTIFICATION}) as id`;
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_identity_reveal(${r!.id}, true, 'Synthetic: approving myself')`,
      );
    });
  });

  it("resolves identity once after approval by a second officer, and audits without identity values", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      const [r] = await s.tx<
        { id: string }[]
      >`select api.request_identity_reveal(${caseB}, ${JUSTIFICATION}) as id`;
      await s.as("grcDeputy");
      await s.tx`select api.decide_identity_reveal(${r!.id}, true, 'Synthetic: justified, proportionate request')`;
      await s.as("grcDirector");
      const identity = await s.tx`select * from api.resolve_reporter_identity(${caseB}, ${JUSTIFICATION})`;
      expect(identity).toHaveLength(1);
      expect(identity[0]).toMatchObject({
        full_name: "Reporter Gamma (synthetic)",
        email: "reporter.gamma@example.test",
      });

      // Single use: a second resolution needs a new approval.
      await s.expectError(
        "CDF_CONFLICT:APPROVED_REVEAL_REQUEST_REQUIRED",
        (tx) => tx`select * from api.resolve_reporter_identity(${caseB}, ${JUSTIFICATION})`,
      );

      await s.as("soc");
      const events = await s.tx<{ action: string; category: string; metadata: unknown; reason: string }[]>`
        select action, category, metadata, reason from audit.audit_event
        where case_id = ${caseB} and action like 'IDENTITY_REVEAL%' or (case_id = ${caseB} and action = 'REPORTER_IDENTITY_REVEALED')
        order by seq`;
      expect(events.map((e) => e.action)).toEqual([
        "IDENTITY_REVEAL_REQUESTED",
        "IDENTITY_REVEAL_APPROVED",
        "REPORTER_IDENTITY_REVEALED",
      ]);
      expect(events.every((e) => e.category === "SECURITY")).toBe(true);
      expect(JSON.stringify(events)).not.toMatch(/Reporter Gamma|reporter\.gamma/);
    });
  });

  it("identity reveal events are not visible to the case team", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      await s.tx`select api.request_identity_reveal(${caseB}, ${JUSTIFICATION})`;
      await s.as("investigatorB");
      const rows = await s.tx`select action from audit.audit_event where action like 'IDENTITY%'`;
      expect(rows).toEqual([]);
    });
  });

  it("an anonymous report has no identity to resolve", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:NO_IDENTITY_ON_FILE",
        (tx) => tx`select * from api.resolve_reporter_identity(${caseA}, ${JUSTIFICATION})`,
      );
    });
  });

  it("the audit ledger never contains seeded identity values", async () => {
    const rows =
      await admin`select seq from audit.audit_event where metadata::text ~* 'reporter gamma|reporter\\.gamma' or reason ~* 'reporter\\.gamma'`;
    expect(rows).toEqual([]);
  });
});
