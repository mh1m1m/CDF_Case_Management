// The Administration registers' two judgements made outside SQL (UX redesign Phase 12 P12-8a; ADR-051's P12-8a
// amendment). Whether a row is in force is read against the database's clock with `effective_to` exclusive, as every
// register stores it; and a working week starts at the beginning of its date in Riyadh, the instant
// api.set_business_week_pattern compares with now(). The registers themselves, against the database, are in
// tests/integration/administration.spec.ts. What the registers may read is pinned at the end.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { periodState, riyadhMidnight } from "./administration-gateway";

const SOURCE = readFileSync(new URL("./administration-gateway.ts", import.meta.url), "utf8");

const NOW = "2026-10-18T12:00:00.000Z";

describe("whether a row is in force", () => {
  it("is in force from its start, inclusive, until its end, exclusive", () => {
    expect(periodState("2026-10-18T12:00:00.000Z", null, NOW)).toBe("IN_FORCE");
    expect(periodState("2026-01-01T00:00:00.000Z", "2026-10-18T12:00:00.001Z", NOW)).toBe("IN_FORCE");
    expect(periodState("2026-01-01T00:00:00.000Z", "2026-10-18T12:00:00.000Z", NOW)).toBe("ENDED");
    expect(periodState("2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", NOW)).toBe("ENDED");
  });

  it("starts later when its start is after now", () => {
    expect(periodState("2026-10-18T12:00:00.001Z", null, NOW)).toBe("SCHEDULED");
    expect(periodState("2027-01-01T00:00:00.000Z", "2027-02-01T00:00:00.000Z", NOW)).toBe("SCHEDULED");
  });

  it("reads PostgreSQL's text form of a timestamp, offset included, and a bare date as that day's start in UTC", () => {
    // 15:00 in Riyadh is 12:00 UTC: the same instant as now.
    expect(periodState("2026-10-18 15:00:00+03", null, NOW)).toBe("IN_FORCE");
    expect(periodState("2026-10-18 15:00:00.5+03", null, NOW)).toBe("SCHEDULED");
    expect(periodState("2026-10-01", "2026-10-18", NOW)).toBe("ENDED");
    expect(periodState("2026-10-01", "2026-10-19", NOW)).toBe("IN_FORCE");
  });
});

describe("the start of a date in Riyadh", () => {
  it("is 21:00 UTC the evening before, all year (Riyadh keeps UTC+3)", () => {
    for (const date of ["2026-01-01", "2026-03-29", "2026-07-01", "2026-10-25", "2028-02-29"]) {
      const start = new Date(riyadhMidnight(date));
      const before = new Date(`${date}T00:00:00Z`);
      before.setUTCHours(-3);
      expect(start.toISOString(), date).toBe(before.toISOString());
    }
    expect(new Date(riyadhMidnight("2027-01-03")).toISOString()).toBe("2027-01-02T21:00:00.000Z");
  });
});

// Static guard (§21; the P12-8 domain map: no case content and no count derived from cases). The registers read
// configuration and registry tables only, the caller's list of pages (2127) and the role catalogue an escalation step
// names (P12-8b); reading any other table has to change this list on purpose.
describe("what the registers read", () => {
  it("reads only the registers' own tables and reads, never a case table", () => {
    const read = new Set([...SOURCE.matchAll(/\b(?:from|join)\s+([a-z_]+\.[a-z_]+)\b/g)].map((m) => m[1]));
    expect([...read].sort()).toEqual([
      "api.authority_rule_coverage",
      "api.my_admin_views",
      "committee.committee",
      "committee.committee_status_change",
      "committee.conflict_authority",
      "committee.membership",
      "committee.membership_correction",
      "committee.rule_set",
      "config.business_calendar_day",
      "config.business_week_pattern",
      "config.setting",
      "decision.corrective_action_escalation_step",
      "decision.corrective_action_policy",
      "decision.corrective_action_pool",
      "decision.corrective_action_pool_member",
      "decision.corrective_evidence_type",
      "exchange.approval_rule",
      "exchange.approved_external_domain",
      "exchange.export_approver_pool",
      "exchange.export_purpose",
      "iam.role",
      "iam.sector",
      "iam.sector_delegation",
      "iam.sector_membership",
      "notify.rule",
      "notify.template",
    ]);
  });

  it("calls only the pages' reads and the commands their forms run (P12-8b)", () => {
    const called = [...new Set([...SOURCE.matchAll(/\bapi\.([a-z_]+)\(/g)].map((m) => m[1]))].sort();
    // The caller's pages and each page's capabilities (2127), and two configuration reads (2030, 2040).
    const reads = [
      "my_admin_views",
      "admin_calendar_capabilities",
      "admin_committee_capabilities",
      "admin_corrective_action_policy_capabilities",
      "admin_export_policy_capabilities",
      "admin_notification_rule_capabilities",
      "admin_sector_capabilities",
      "authority_rule_coverage",
      "export_approval_config_warnings",
    ];
    // One command per form.
    const commands = [
      "create_sector",
      "end_committee_membership",
      "end_sector_membership",
      "revise_committee_rule_set",
      "revoke_referral_delegation",
      "set_business_calendar_day",
      "set_business_week_pattern",
      "set_corrective_action_policy",
      "set_export_purpose",
      "set_export_rule",
      "set_notification_rule",
      "withdraw_business_calendar_day",
    ];
    expect(called).toEqual([...reads, ...commands].sort());
  });

  it("never reads the number of proceedings a seat correction recorded, a count derived from cases (2090)", () => {
    expect(SOURCE).not.toMatch(/affected_proceedings/);
    // Every register is read column by column, never as a whole row.
    expect(SOURCE).not.toMatch(/select\s+\*|\b[a-z]\.\*/);
  });

  // The page rules checked against the register (coordinator rulings on F4, 2026-10-18 21:17, and of 23:50) read it
  // under a lock, in the command's own transaction, before the command: nothing can change between the check and it.
  it("checks the register under a lock before the command, in one transaction", () => {
    const steps: [string, string[]][] = [
      [
        "addExportRule",
        [
          "pg_advisory_xact_lock(hashtext('exchange.approval_rule:'",
          "from exchange.approval_rule r",
          "CDF_CONFLICT:RULE_CODE_EXISTS",
          "api.set_export_rule(",
        ],
      ],
      [
        "setCorrectiveActionPolicy",
        [
          "pg_advisory_xact_lock(hashtext('decision.corrective_action_policy:'",
          "from decision.corrective_action_policy p",
          "guard(",
          "api.set_corrective_action_policy(",
        ],
      ],
      [
        "reviseCommitteeRuleSet",
        [
          "pg_advisory_xact_lock(hashtext('committee.rule_set_revision:'",
          "from committee.rule_set r",
          "guard(",
          "api.revise_committee_rule_set(",
        ],
      ],
    ];
    for (const [method, order] of steps) {
      const start = SOURCE.indexOf(`\n  ${method}(`);
      const body = SOURCE.slice(start, SOURCE.indexOf("\n  }\n", start));
      expect(start, method).toBeGreaterThan(0);
      expect(body.match(/this\.run\(/g), method).toHaveLength(1);
      const at = order.map((step) => body.indexOf(step));
      expect(
        at.every((i) => i > 0),
        `${method}: ${JSON.stringify(at)}`,
      ).toBe(true);
      expect(at, method).toEqual([...at].sort((a, b) => a - b));
    }
  });
});
