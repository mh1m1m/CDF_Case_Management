// Phase 11 form and status catalogue (migration 1970, ADR-035; §18, §21, §87): the seven config tables are
// read-only reference data. Any ACTIVE user may read them (they hold catalogue names and target mappings,
// never case content); a revoked user and the anonymous portal role see nothing; no application role can
// write them, so the mapping changes only by migration.
import { describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { portalScenario, scenario } from "../support/db";

const TABLES = [
  "legacy_catalogue",
  "legacy_form_map",
  "legacy_status_map",
  "status_dimension",
  "status_dimension_value",
  "target_class",
  "target_module",
] as const;

const count = async (tx: Tx, table: string) => {
  const [r] = await tx<{ n: number }[]>`select count(*)::int as n from config.${tx(table)}`;
  return r!.n;
};

describe("reference catalogue access", () => {
  it("any active user reads every table, including a platform administrator; a revoked user reads nothing", async () => {
    await scenario(async (s) => {
      for (const user of ["investigatorA", "platformAdmin", "employee"] as const) {
        await s.as(user);
        for (const t of TABLES) expect(await count(s.tx, t), `${user} ${t}`).toBeGreaterThan(0);
      }
      await s.as("revoked");
      for (const t of TABLES) expect(await count(s.tx, t), `revoked ${t}`).toBe(0);
    });
  });

  it("no application role can insert, update or delete a row", async () => {
    await scenario(async (s) => {
      await s.as("platformAdmin");
      await s.expectError(
        "permission denied",
        (tx) => tx`insert into config.target_class (code, description, required_data, generated_output)
                   values ('SYNTHETIC_CLASS', 'x', 'x', 'x')`,
      );
      await s.expectError(
        "permission denied",
        (tx) => tx`update config.legacy_form_map set disposition = 'RETIRE', target_class = 'RETIRED'
                   where legacy_id = 'WB-FRM-01'`,
      );
      await s.expectError(
        "permission denied",
        (tx) =>
          tx`update config.status_dimension_value set state = 'PLANNED' where dimension = 'OUTCOME_CODE'`,
      );
      for (const t of TABLES)
        await s.expectError("permission denied", (tx) => tx`delete from config.${tx(t)}`);
      await s.as("grcDirector");
      await s.expectError(
        "permission denied",
        (tx) => tx`update config.legacy_status_map set target_event_state = 'IMPLEMENTED'`,
      );
    });
  });

  it("the anonymous role cannot read any table, on the BFF or the portal connection", async () => {
    await scenario(async (s) => {
      await s.as(null);
      for (const t of TABLES) await s.expectError("permission denied", (tx) => count(tx, t));
    });
    await portalScenario(async (tx) => {
      for (const t of TABLES) {
        let message = "";
        await tx.savepoint((sp) => count(sp as unknown as Tx, t)).catch((e: Error) => (message = e.message));
        expect(message, t).toMatch(/^permission denied/);
      }
    });
  });
});
