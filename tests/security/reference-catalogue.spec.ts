// Phase 11 form and status catalogue (migration 1970, ADR-035; §18, §21, §87): the seven config tables are
// read-only reference data. Any ACTIVE user may read them (they hold catalogue names and target mappings,
// never case content); a revoked user and the anonymous portal role see nothing; no application role can
// write them, so the mapping changes only by migration.
import { describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { USERS, ownerScenario, portalScenario, scenario } from "../support/db";

const TABLES = [
  "legacy_catalogue",
  "legacy_form_map",
  "legacy_status_map",
  "status_dimension",
  "status_dimension_value",
  "target_class",
  "target_module",
  // Migration 2040: the conflict register (DEC-F32, DEC-F33) and the form-retirement criteria (DEC-F34).
  "status_code_conflict",
  "form_retirement_criterion",
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

describe("owner decisions DEC-F32, DEC-F33 and DEC-F34 (migration 2040)", () => {
  it("DEC-F32: the ten conflicting status codes are registered, none chosen by order; DEC-F33 resolves S099 as LEGAL_HOLD", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const conflicted = await s.tx<{ code: string }[]>`
        select distinct legacy_code as code from config.legacy_status_map where code_conflict order by 1`;
      const register = await s.tx<
        {
          code: string;
          status: string;
          resolved_catalogue: string | null;
          resolved_meaning: string | null;
          decision_reference: string | null;
        }[]
      >`select code, status, resolved_catalogue, resolved_meaning, decision_reference
        from config.status_code_conflict order by code`;
      expect(register.map((r) => r.code)).toEqual(conflicted.map((r) => r.code));
      expect(register.map((r) => r.code)).toEqual([
        "S021",
        "S022",
        "S023",
        "S025",
        "S026",
        "S027",
        "S028",
        "S030",
        "S099",
        "S100",
      ]);
      expect(register.filter((r) => r.status === "RESOLVED")).toEqual([
        {
          code: "S099",
          status: "RESOLVED",
          resolved_catalogue: "CRM_STATUS_D_140",
          resolved_meaning: "LEGAL_HOLD",
          decision_reference: "DEC-F33",
        },
      ]);
      expect(
        register.filter((r) => r.status === "SOURCE_REQUIRED" && r.resolved_catalogue === null),
      ).toHaveLength(9);
      // The resolved reading is the owner catalogue's legal hold; both readings stay in the map.
      expect(
        await s.tx`select catalogue, target_dimension, target_value from config.legacy_status_map
                   where legacy_code = 'S099' order by catalogue collate "C"`,
      ).toEqual([
        {
          catalogue: "CRM_STATUS_DRIVE_150",
          target_dimension: "QUALITY_REVIEW",
          target_value: "IMPACT_ASSESSMENT",
        },
        { catalogue: "CRM_STATUS_D_140", target_dimension: "LEGAL_HOLD_STATUS", target_value: "ACTIVE" },
      ]);
    });
    // Reference data: not even the owner rewrites a resolution in place (a new migration records a new decision).
    await ownerScenario(async (s) => {
      await s.asOwner();
      await s.expectError(
        "config.status_code_conflict is append-only",
        (
          tx,
        ) => tx`update config.status_code_conflict set status = 'RESOLVED', resolved_catalogue = 'CRM_STATUS_DRIVE_150',
                     resolved_meaning = 'HEARING', decision_reference = 'DEC-F99' where code = 'S021'`,
      );
      await s.expectError(
        "new row for relation",
        (tx) => tx`insert into config.status_code_conflict (code, status, notes)
                   values ('S001', 'RESOLVED', 'Synthetic: resolved without a decision.')`,
      );
    });
  });

  it("DEC-F34: no WB-FRM form is retired until all five criteria are met; none is retirable today", async () => {
    await ownerScenario(async (s) => {
      await s.as("investigatorA");
      expect(
        (
          await s.tx<{ code: string }[]>`select code from config.form_retirement_criterion order by position`
        ).map((r) => r.code),
      ).toEqual([
        "REPLACEMENT_DOMAIN_OBJECT",
        "HISTORICAL_MAPPING",
        "GENERATED_EQUIVALENT",
        "MIGRATION_REPORTING_COMPATIBILITY",
        "NO_ACTIVE_WORKFLOW_DEPENDENCY",
      ]);
      expect(await s.tx`select id from config.form_retirement_check`).toEqual([]);
      expect(await s.tx`select code from forms.form_definition where not is_enabled`).toEqual([]);
      await s.expectError(
        "permission denied",
        (
          tx,
        ) => tx`insert into config.form_retirement_check (form_code, criterion_code, met, evidence_reference)
                   values ('WB-FRM-01', 'HISTORICAL_MAPPING', true, 'SYNTHETIC-REF')`,
      );
      // Whatever path disables a form, the database refuses it while any criterion is unmet.
      await s.asOwner();
      const disable = () =>
        s.tx`update forms.form_definition set is_enabled = false where code = 'WB-FRM-01'`;
      await s.expectError("CDF_CONFLICT:FORM_RETIREMENT_CRITERIA_UNMET", () => disable());
      // Four of five (synthetic assessments for the test only) are not enough; a met criterion needs evidence.
      await s.expectError(
        "new row for relation",
        (tx) => tx`insert into config.form_retirement_check (form_code, criterion_code, met)
                   values ('WB-FRM-01', 'HISTORICAL_MAPPING', true)`,
      );
      await s.tx`insert into config.form_retirement_check (form_code, criterion_code, met, evidence_reference, assessed_by)
                 select 'WB-FRM-01', code, true, 'SYNTHETIC-DEMO-REF', ${USERS.platformAdmin}
                 from config.form_retirement_criterion where position <= 4`;
      await s.expectError("CDF_CONFLICT:FORM_RETIREMENT_CRITERIA_UNMET", () => disable());
      // A later assessment that the fifth is unmet still blocks; once it is met, the form may be retired.
      await s.tx`insert into config.form_retirement_check (form_code, criterion_code, met, assessed_by)
                 values ('WB-FRM-01', 'NO_ACTIVE_WORKFLOW_DEPENDENCY', false, ${USERS.platformAdmin})`;
      await s.expectError("CDF_CONFLICT:FORM_RETIREMENT_CRITERIA_UNMET", () => disable());
      await s.tx`insert into config.form_retirement_check (form_code, criterion_code, met, evidence_reference,
                                                         assessed_by, assessed_at)
                 values ('WB-FRM-01', 'NO_ACTIVE_WORKFLOW_DEPENDENCY', true, 'SYNTHETIC-DEMO-REF',
                         ${USERS.platformAdmin}, now() + interval '1 second')`;
      await disable();
      // Another form is untouched by WB-FRM-01's assessments.
      await s.expectError(
        "CDF_CONFLICT:FORM_RETIREMENT_CRITERIA_UNMET",
        (tx) => tx`update forms.form_definition set is_enabled = false where code = 'WB-FRM-02'`,
      );
    });
  });
});
