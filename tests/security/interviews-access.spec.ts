// EPIC 09 (CDF-60, ADR-012), §19/§22: interviews follow case access, need-to-know and clearance; writes go
// only through the api.* commands; the reporter is never named; denied opens are SECURITY events.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withUserContext, type Tx } from "@cdf/infrastructure";
import { USERS, admin, bff, caseId, scenario, type UserKey } from "../support/db";

let caseA: string, caseB: string, caseConflict: string;
let seededA: string, seededB: string;
beforeAll(async () => {
  [caseA, caseB, caseConflict] = await Promise.all([caseId("0001"), caseId("0002"), caseId("0004")]);
  const rows = await admin<{ id: string; case_id: string }[]>`
    select id, case_id from case_mgmt.interview where sequence_no = 1 and case_id in (${caseA}, ${caseB})`;
  seededA = rows.find((r) => r.case_id === caseA)!.id;
  seededB = rows.find((r) => r.case_id === caseB)!.id;
});

const TABLES = [
  "interview",
  "interview_participant",
  "interview_notice",
  "interview_statement_version",
  "interview_statement_ack",
] as const;
const visible = async (tx: Tx, id: string) => {
  const [r] = await tx<{ n: number }[]>`select count(*)::int as n from case_mgmt.interview where id = ${id}`;
  return r!.n;
};
const plan = (
  tx: Tx,
  caseTarget: string,
  kind = "WITNESS",
  label: string | null = "Witness Kappa (synthetic)",
) =>
  tx<{ id: string }[]>`
    select api.plan_interview(${caseTarget}, 'Synthetic interview', null, ${kind}, ${label}, null,
      'CONFIDENTIAL'::core.classification_level) as id`.then((r) => r[0]!.id);

describe("interview visibility", () => {
  it("is limited to the case team with need-to-know", async () => {
    await scenario(async (s) => {
      const matrix: [UserKey, number][] = [
        ["investigatorA", 1],
        ["lead", 1],
        ["caseManager", 1],
        ["grcDirector", 1],
        ["triage", 0], // a TRIAGE-scope grant sees the case, not its interviews
        ["intake", 0],
        ["investigatorB", 0],
        ["committee", 0],
        ["platformAdmin", 0],
        ["internalAudit", 0],
        ["soc", 0],
        ["dpo", 0],
        ["revoked", 0],
      ];
      for (const [user, expected] of matrix) {
        await s.as(user);
        expect(await visible(s.tx, seededA), user).toBe(expected);
        for (const t of TABLES.slice(1)) {
          const [r] = await s.tx.unsafe<{ n: number }[]>(
            `select count(*)::int as n from case_mgmt.${t} where interview_id = $1`,
            [seededA],
          );
          if (expected === 0) expect(r!.n, `${user} ${t}`).toBe(0);
        }
      }
    });
  });

  it("is withheld from case members without the clearance for the interview", async () => {
    await scenario(async (s) => {
      // A SECRET interview on the CONFIDENTIAL case A: the SECRET-cleared director, assigned for the test,
      // sees it; the CONFIDENTIAL-cleared case team does not.
      await s.as("caseManager");
      await s.tx`select api.assign_case(${caseA}, ${USERS.grcDirector}, 'CASE_OWNER', 'Synthetic: specialist oversight')`;
      await s.as("grcDirector");
      await s.tx`select api.declare_conflict(${caseA}, false, 'Synthetic: no relationship with the parties.')`;
      const [row] = await s.tx<{ id: string }[]>`
        select api.plan_interview(${caseA}, 'Synthetic sensitive interview', null, 'WITNESS', 'Witness Sigma (synthetic)',
          null, 'SECRET'::core.classification_level) as id`;
      expect(await visible(s.tx, row!.id)).toBe(1);
      for (const user of ["investigatorA", "lead", "caseManager"] as const) {
        await s.as(user);
        expect(await visible(s.tx, row!.id), user).toBe(0);
        const [p] = await s.tx<{ n: number }[]>`
          select count(*)::int as n from case_mgmt.interview_participant where interview_id = ${row!.id}`;
        expect(p!.n, user).toBe(0);
      }
      // Nobody can plan above their own clearance.
      await s.as("lead");
      await s.expectError(
        "CDF_INVALID:classification",
        (tx) => tx`select api.plan_interview(${caseA}, 'Synthetic', null, 'WITNESS', 'Witness Kappa', null,
          'SECRET'::core.classification_level)`,
      );
    });
  });

  it("is withdrawn the moment a conflict is declared", async () => {
    await scenario(async (s) => {
      await s.as("investigatorB");
      const id = await plan(s.tx, caseConflict);
      expect(await visible(s.tx, id)).toBe(1);
      await s.tx`select api.declare_conflict(${caseConflict}, true, 'Synthetic: related to the witness')`;
      expect(await visible(s.tx, id)).toBe(0);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.schedule_interview(${id}, now(), 30, 'PHONE', null)`,
      );
    });
  });

  it("has no write path but the api commands", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      for (const t of TABLES) {
        await s.expectError("permission denied", (tx) =>
          tx.unsafe(`update case_mgmt.${t} set id = id where false`),
        );
        await s.expectError("permission denied", (tx) => tx.unsafe(`delete from case_mgmt.${t} where false`));
      }
      await s.expectError(
        "permission denied",
        (tx) => tx`insert into case_mgmt.interview_recording default values`,
      );
      await s.expectError(
        "permission denied",
        (tx) => tx`select case_mgmt.lock_visible_interview(${seededA})`,
      );
    });
  });
});

describe("interview commands", () => {
  it("refuse outsiders, viewers without a working role, and anonymous callers", async () => {
    await scenario(async (s) => {
      for (const user of ["investigatorB", "committee", "platformAdmin"] as const) {
        await s.as(user);
        await s.expectError("CDF_NOT_FOUND", (tx) => plan(tx, caseA));
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.transition_interview(${seededA}, 'CANCEL', 'Synthetic reason text')`,
        );
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select * from api.record_interview_statement(${seededA}, 'x', 'en')`,
        );
      }
      await s.as("revoked");
      await s.expectError("CDF_UNAUTHENTICATED", (tx) => plan(tx, caseA));
      // Triage sees the case but has no working role on it.
      await s.as("triage");
      await s.expectError("CDF_FORBIDDEN", (tx) => plan(tx, caseA));
      await s.as(null);
      await s.expectError("permission denied", (tx) => plan(tx, caseA));
    });
  });

  it("never take a name for the reporter, and the reporter is reachable only through the portal", async () => {
    await scenario(async (s) => {
      await s.as("investigatorB");
      await s.expectError("CDF_INVALID:interviewee_label", (tx) =>
        plan(tx, caseB, "REPORTER", "Reporter Gamma"),
      );
      await s.expectError(
        "CDF_INVALID:case_person_id",
        (tx) =>
          tx`select api.plan_interview(${caseB}, 'Synthetic', null, 'REPORTER', null, gen_random_uuid(),
          'RESTRICTED'::core.classification_level)`,
      );
      await s.as("investigatorB");
      await s.tx`select api.schedule_interview(${seededB}, now() + interval '8 days', 45, 'PHONE', null)`;
      await s.expectError(
        "CDF_INVALID:channel",
        (tx) => tx`select api.issue_interview_notice(${seededB}, 'RESCHEDULE', 'INTERNAL_EMAIL')`,
      );
      const [row] = await s.tx<{ label: string | null; person: string | null }[]>`
        select interviewee_label as label, case_person_id as person from case_mgmt.interview where id = ${seededB}`;
      expect(row).toEqual({ label: null, person: null });
    });
    const [id] = await admin<{ wb: string }[]>`
      select r.reporter_wb_id::text as wb from case_mgmt.case_record r where r.id = ${caseB}`;
    expect(id!.wb).toBeTruthy();
  });

  it("only admit cleared case members to the panel", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const id = await plan(s.tx, caseA);
      await s.expectError(
        "CDF_CONFLICT:PARTICIPANT_INELIGIBLE",
        (tx) => tx`select api.add_interview_participant(${id}, ${USERS.investigatorB}, 'INTERVIEWER')`,
      );
      await s.tx`select api.add_interview_participant(${id}, ${USERS.lead}, 'NOTE_TAKER')`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_PARTICIPANT",
        (tx) => tx`select api.add_interview_participant(${id}, ${USERS.lead}, 'INTERVIEWER')`,
      );
      await s.expectError(
        "CDF_INVALID:participant_role",
        (tx) => tx`select api.add_interview_participant(${id}, ${USERS.caseManager}, 'LEAD_INTERVIEWER')`,
      );
    });
  });
});

describe("interview access recording", () => {
  it("records views as business events and denials as security events", async () => {
    // Committed (not rolled back) so the ledger can be read back; opening changes nothing else.
    const open = (user: UserKey, id: string) =>
      withUserContext(bff, { userId: USERS[user], requestId: randomUUID() }, async (tx) => {
        const [r] = await tx<{ ok: boolean }[]>`select api.open_interview(${id}) as ok`;
        return r!.ok;
      });
    const missing = randomUUID();
    const [last] = await admin<
      { seq: string }[]
    >`select coalesce(max(seq), 0)::text as seq from audit.audit_event`;
    expect(await open("lead", seededA)).toBe(true);
    expect(await open("investigatorB", seededA)).toBe(false);
    expect(await open("investigatorB", missing)).toBe(false);
    const events = await admin<{ action: string; category: string; actor: string; object: string }[]>`
      select action, category, actor_id::text as actor, object_id as object from audit.audit_event
      where seq > ${last!.seq}::bigint and object_type = 'interview' order by seq`;
    expect(events).toEqual([
      { action: "INTERVIEW_VIEWED", category: "BUSINESS", actor: USERS.lead, object: seededA },
      {
        action: "INTERVIEW_ACCESS_DENIED",
        category: "SECURITY",
        actor: USERS.investigatorB,
        object: seededA,
      },
      {
        action: "INTERVIEW_ACCESS_DENIED",
        category: "SECURITY",
        actor: USERS.investigatorB,
        object: missing,
      },
    ]);
  });
});
