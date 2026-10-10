// §29, §74, ADR-005: the audit ledger is append-only and tamper-evident.
import { describe, expect, it } from "vitest";
import { admin, scenario, type UserKey } from "../support/db";

describe("audit ledger immutability", () => {
  it.each<UserKey>(["internalAudit", "soc", "platformAdmin", "grcDirector"])(
    "%s cannot modify audit events",
    async (user) => {
      await scenario(async (s) => {
        await s.as(user);
        await s.expectError("permission denied", (tx) => tx`update audit.audit_event set reason = 'edited'`);
        await s.expectError("permission denied", (tx) => tx`delete from audit.audit_event`);
        await s.expectError("permission denied", (tx) => tx`truncate audit.audit_event`);
        await s.expectError(
          "permission denied",
          (tx) =>
            tx`insert into audit.audit_event (event_id, occurred_at, actor_type, action, category, outcome, event_hash)
           values (gen_random_uuid(), now(), 'SYSTEM', 'FORGED', 'BUSINESS', 'SUCCESS', repeat('0', 64))`,
        );
        await s.expectError(
          "permission denied",
          (tx) =>
            tx`select audit.record_event('FORGED', 'BUSINESS', 'SUCCESS', null, null, null, null, '{}'::jsonb)`,
        );
      });
    },
  );

  it("rejects UPDATE, DELETE and TRUNCATE even for the table owner", async () => {
    for (const statement of [
      "update audit.audit_event set reason = 'x'",
      "delete from audit.audit_event",
      "truncate audit.audit_event",
    ]) {
      // Should a statement ever get through, the throw still rolls it back: these suites also run against
      // hosted DEV (CDF-32), whose ledger must survive a failing test.
      await expect(
        admin.begin(async (tx) => {
          await tx.unsafe(statement);
          throw new Error(`not rejected: ${statement}`);
        }),
      ).rejects.toThrow(/append-only/);
    }
  });

  it("the seeded chain verifies", async () => {
    expect(await admin`select * from audit.verify_chain()`).toEqual([]);
  });

  it("detects tampering (trigger bypassed by a superuser inside a rolled-back transaction)", async () => {
    let broken: readonly unknown[] = [];
    await admin
      .begin(async (tx) => {
        await tx`alter table audit.audit_event disable trigger audit_event_no_update`;
        await tx`update audit.audit_event set reason = 'tampered' where seq = (select min(seq) + 3 from audit.audit_event)`;
        broken = await tx`select * from audit.verify_chain()`;
        throw new Error("rollback");
      })
      .catch(() => undefined);
    expect(broken).toHaveLength(1);
    expect(await admin`select * from audit.verify_chain()`).toEqual([]);
  });

  it("chain verification is available only to audit and security roles", async () => {
    await scenario(async (s) => {
      await s.as("internalAudit");
      expect(await s.tx`select * from api.verify_audit_chain()`).toEqual([]);
      await s.as("investigatorA");
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select * from api.verify_audit_chain()`);
    });
  });

  it("commands record actor, roles and request id; denials recorded by the BFF are SECURITY events", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.tx`select api.update_case_details(id, title, summary, 'LOW', row_version) from case_mgmt.case_record where case_number like '%-0002'`;
      await s.tx`select api.record_security_event('COMMAND_DENIED', 'case_record', 'synthetic', '{"command":"assign_case"}'::jsonb)`;
      await s.as("internalAudit");
      const [business] = await s.tx<{ actor_id: string; actor_roles: string[]; request_id: string | null }[]>`
        select actor_id, actor_roles, request_id from audit.audit_event where action = 'CASE_UPDATED' order by seq desc limit 1`;
      expect(business).toMatchObject({
        actor_id: "a0000000-0000-4000-8000-000000000003",
        actor_roles: ["CASE_MANAGER"],
      });
      expect(business!.request_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await s.tx`select 1 from audit.audit_event where category = 'SECURITY'`).toEqual([]); // audit role: no SECURITY events
      await s.as("soc");
      const security =
        await s.tx`select action, outcome from audit.audit_event where action = 'COMMAND_DENIED' and object_id = 'synthetic'`;
      expect(security).toEqual([{ action: "COMMAND_DENIED", outcome: "DENIED" }]);
    });
  });
});
