// T19 (forgotten security context), T13 (SQL injection), T18 (revoked subject) at the connection boundary.
import { describe, expect, it } from "vitest";
import { bff, caseId, portal, reportId, scenario } from "../support/db";

describe("security context boundary", () => {
  it("the BFF login without SET ROLE has no privileges at all (T19)", async () => {
    await expect(bff`select id from case_mgmt.case_record limit 1`).rejects.toThrow(/permission denied/);
    await expect(bff`select seq from audit.audit_event limit 1`).rejects.toThrow(/permission denied/);
    await expect(bff`select api.open_case(gen_random_uuid())`).rejects.toThrow(/permission denied/);
    await expect(portal`select public_api.get_report_status('x', 'y')`).rejects.toThrow(/permission denied/);
  });

  it("a forged or malformed subject claim fails closed (T18)", async () => {
    await scenario(async (s) => {
      await s.tx`set local role authenticated`;
      for (const claims of [
        '{"sub":"not-a-uuid"}',
        "garbage",
        '{"sub":"ffffffff-ffff-4fff-8fff-ffffffffffff"}',
      ]) {
        await s.tx`select set_config('request.jwt.claims', ${claims}, true)`;
        expect(await s.tx`select id from case_mgmt.case_record`).toEqual([]);
        await s.expectError("CDF_UNAUTHENTICATED", (tx) => tx`select api.open_case(gen_random_uuid())`);
      }
    });
  });
});

describe("SQL injection (T13)", () => {
  const payloads = ["'); drop table case_mgmt.case_record; --", "x' or '1'='1", "WB-SEED00000001' --"];

  it("treats hostile input as data in commands", async () => {
    const id = await reportId("WB-SEED00000005");
    await scenario(async (s) => {
      await s.as("intake");
      for (const p of payloads) await s.tx`select api.reply_to_reporter(${id}, ${p})`;
      const rows = await s.tx<
        { body: string }[]
      >`select body from intake.report_message where report_id = ${id} order by created_at desc limit 3`;
      expect(rows.map((r) => r.body).sort()).toEqual([...payloads].sort());
      expect(await s.tx`select 1 from case_mgmt.case_record limit 1`).toBeDefined();
    });
  });

  it("cannot widen a portal lookup", async () => {
    await portal.begin(async (tx) => {
      await tx`set local role anon`;
      for (const p of payloads) {
        const [row] = await tx`select public_api.get_report_status(${p}, ${p}) as s`;
        expect(row).toEqual({ s: null });
      }
    });
  });

  it("identifier lookups are parameterised UUIDs", async () => {
    const caseA = await caseId("0001");
    await scenario(async (s) => {
      await s.as("investigatorA");
      await s.expectError(
        "invalid input syntax for type uuid",
        (tx) => tx`select api.open_case(${`${caseA}' or 1=1 --`}::uuid)`,
      );
    });
  });
});
