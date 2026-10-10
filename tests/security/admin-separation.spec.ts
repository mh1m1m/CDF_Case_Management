// §21: administration, audit and security monitoring never imply access to case content.
import { describe, expect, it } from "vitest";
import { USERS, caseId, scenario } from "../support/db";

describe("administrative separation", () => {
  it("platform admin manages roles but sees no case content, reports or audit", async () => {
    await scenario(async (s) => {
      await s.as("platformAdmin");
      expect(await s.tx`select id from case_mgmt.case_record`).toEqual([]);
      expect(await s.tx`select id from intake.report`).toEqual([]);
      expect(await s.tx`select seq from audit.audit_event`).toEqual([]);
      const grants =
        await s.tx`select role_code from iam.user_role_assignment where user_id = ${USERS.committee}`;
      expect(grants).toEqual([{ role_code: "COMMITTEE_MEMBER" }]);
    });
  });

  it("platform admin cannot elevate themselves, and a self-granted role would not help anyway", async () => {
    await scenario(async (s) => {
      await s.as("platformAdmin");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.grant_role(${USERS.platformAdmin}, 'CASE_MANAGER', 'Synthetic: self elevation')`,
      );
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.set_user_status(${USERS.platformAdmin}, 'ACTIVE', 'Synthetic: self status')`,
      );
    });
  });

  it("role grants are audited as ADMIN events and take effect immediately", async () => {
    const caseA = await caseId("0001");
    await scenario(async (s) => {
      await s.as("platformAdmin");
      await s.tx`select api.grant_role(${USERS.committee}, 'CASE_MANAGER', 'Synthetic: temporary cover')`;
      await s.as("committee");
      expect(await s.tx`select id from case_mgmt.case_record where id = ${caseA}`).toHaveLength(1);
      await s.as("internalAudit");
      const events = await s.tx`select action, category from audit.audit_event where action = 'ROLE_GRANTED'`;
      expect(events).toEqual([{ action: "ROLE_GRANTED", category: "ADMIN" }]);
    });
  });

  it("suspending a user removes all access in the next transaction", async () => {
    await scenario(async (s) => {
      await s.as("platformAdmin");
      await s.tx`select api.set_user_status(${USERS.investigatorA}, 'SUSPENDED', 'Synthetic: access review')`;
      await s.as("investigatorA");
      expect(await s.tx`select id from case_mgmt.case_record`).toEqual([]);
      await s.expectError("CDF_UNAUTHENTICATED", (tx) => tx`select api.open_case(gen_random_uuid())`);
    });
  });

  it("non-admins cannot grant roles", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.grant_role(${USERS.investigatorA}, 'GRC_DIRECTOR', 'Synthetic: not allowed')`,
      );
    });
  });

  it("internal audit reads business and admin audit metadata but no case content", async () => {
    await scenario(async (s) => {
      await s.as("internalAudit");
      expect(await s.tx`select id from case_mgmt.case_record`).toEqual([]);
      const categories = await s.tx<
        { category: string }[]
      >`select distinct category from audit.audit_event order by 1`;
      expect(categories.map((c) => c.category)).toEqual(["BUSINESS"]);
    });
  });

  it("SOC analysts read only SECURITY events", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      await s.tx`select api.open_case(gen_random_uuid())`;
      await s.as("soc");
      const categories = await s.tx<{ category: string }[]>`select distinct category from audit.audit_event`;
      expect(categories.map((c) => c.category)).toEqual(["SECURITY"]);
      expect(await s.tx`select id from case_mgmt.case_record`).toEqual([]);
    });
  });
});
