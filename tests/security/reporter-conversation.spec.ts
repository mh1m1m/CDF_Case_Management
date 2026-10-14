// UX redesign S2 (CDF-128; migration 1840; ADR-016 D4; DEC-06) · §19, §22, §29, §39: who holds the conversation
// with the reporter. Before a case exists, intake and triage read and answer it, as before. From case creation it
// belongs to the case: the case manager, the case's owner and lead investigator write; an assigned investigator
// writes only with a REPORTER_COMMUNICATE delegation, which lapses with the assignment; the GRC Director reads for
// oversight. Seeing the case is never enough: triage, committee, records, legal, administrators, internal audit,
// SOC and DPO get no thread. Delegations are audited, never deleted and never added after archiving.
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { closeAndArchive } from "../support/records";
import {
  USERS,
  caseId,
  ledgerMark,
  madeSince,
  ownerScenario,
  reportId,
  scenario,
  type Scenario,
  type UserKey,
} from "../support/db";

const REASON = "Synthetic: reporter conversation test.";
const REF_A = "WB-SEED00000001";
let caseA: string, caseB: string, reportA: string, reportSecret: string, preCase: string;
beforeAll(async () => {
  [caseA, caseB, reportA, reportSecret, preCase] = await Promise.all([
    caseId("0001"),
    caseId("0002"),
    reportId(REF_A),
    reportId("WB-SEED00000003"),
    reportId("WB-SEED00000006"),
  ]);
});

// The seed's report secrets are unusable outside the seed, but its HMAC is known (02_synthetic_cases.sql).
const seedHmac = (ref: string) =>
  createHash("sha256").update(`unusable-seed-secret:${ref}`, "utf8").digest("hex");

const messageCount = async (tx: Tx, report: string) =>
  Number(
    (
      await tx<{ n: string }[]>`select count(*) as n from intake.report_message where report_id = ${report}`
    )[0]!.n,
  );
const reply = (tx: Tx, report: string) =>
  tx`select api.reply_to_reporter(${report}, 'Synthetic reply to the reporter for the conversation suite.')`;
const delegate = async (tx: Tx, c: string, user: UserKey) =>
  (
    await tx<
      { id: string }[]
    >`select api.delegate_reporter_communication(${c}, ${USERS[user]}, ${REASON}) as id`
  )[0]!.id;
const endDelegation = (tx: Tx, id: string) => tx`select api.end_reporter_communication(${id}, ${REASON})`;

async function access(s: Scenario, user: UserKey, report: string) {
  await s.as(user);
  const [row] = await s.tx<{ read: boolean; send: boolean }[]>`
    select authz.can_read_reporter_conversation(${report}) as read, authz.can_message_reporter(${report}) as send`;
  return { ...row!, rows: await messageCount(s.tx, report) };
}

describe("after case creation the conversation belongs to the case (DEC-06)", () => {
  // Case A (0001): the case manager and the lead write, the GRC Director and deputy read, nobody else.
  const SEND: UserKey[] = ["caseManager", "lead"];
  const READ: UserKey[] = ["grcDirector", "grcDeputy"];
  // On the case team or with case access, but not correspondents: the thread stays closed to them.
  const ON_CASE: UserKey[] = ["investigatorA"];
  const OUTSIDE: UserKey[] = [
    // S3 (ADR-016 D2, D3): triage's grant ended at hand-over, and the committee roles open no case.
    "triage",
    "committeeSecretary",
    "committeeChair",
    "intake",
    "investigatorB",
    "committee",
    "platformAdmin",
    "internalAudit",
    "soc",
    "dpo",
    "records",
    "legal",
    "revoked",
  ];

  it("the case manager and the lead read and write", async () => {
    await scenario(async (s) => {
      for (const user of SEND)
        expect(await access(s, user, reportA), user).toEqual({ read: true, send: true, rows: 2 });
      for (const user of SEND) {
        await s.as(user);
        await reply(s.tx, reportA);
      }
      expect(await messageCount(s.tx, reportA)).toBe(4);
    });
  });

  it("the GRC Director reads for oversight and cannot write", async () => {
    await scenario(async (s) => {
      for (const user of READ) {
        expect(await access(s, user, reportA), user).toEqual({ read: true, send: false, rows: 2 });
        await s.expectError("CDF_FORBIDDEN", (tx) => reply(tx, reportA));
      }
    });
  });

  it("seeing the case is not enough: an investigator on the case gets no thread", async () => {
    await scenario(async (s) => {
      for (const user of ON_CASE) {
        await s.as(user);
        const [v] = await s.tx<{ ok: boolean }[]>`select authz.can_view_case(${caseA}) as ok`;
        expect(v!.ok, `${user} sees the case`).toBe(true);
        expect(await access(s, user, reportA), user).toEqual({ read: false, send: false, rows: 0 });
        await s.expectError("CDF_FORBIDDEN", (tx) => reply(tx, reportA));
      }
    });
  });

  it("without case access the report does not exist, and administrators and oversight roles get nothing", async () => {
    await scenario(async (s) => {
      for (const user of OUTSIDE) {
        expect(await access(s, user, reportA), user).toEqual({ read: false, send: false, rows: 0 });
        await s.expectError(user === "revoked" ? "CDF_" : "CDF_NOT_FOUND", (tx) => reply(tx, reportA));
      }
    });
  });

  it("a restricted case's conversation is its owner's: no case manager or deputy without named access", async () => {
    await scenario(async (s) => {
      expect(await access(s, "grcDirector", reportSecret)).toEqual({ read: true, send: true, rows: 0 });
      await reply(s.tx, reportSecret);
      for (const user of ["caseManager", "grcDeputy", "lead"] as const) {
        expect(await access(s, user, reportSecret), user).toEqual({ read: false, send: false, rows: 0 });
        await s.expectError("CDF_NOT_FOUND", (tx) => reply(tx, reportSecret));
      }
    });
  });

  it("before a case nothing changes: intake and triage read and answer, case roles do not see the report", async () => {
    await scenario(async (s) => {
      for (const user of ["intake", "triage"] as const)
        expect(await access(s, user, preCase), user).toEqual({ read: true, send: true, rows: 1 });
      for (const user of ["intake", "triage"] as const) {
        await s.as(user);
        await reply(s.tx, preCase);
      }
      for (const user of ["caseManager", "lead", "grcDirector", "investigatorA"] as const) {
        expect(await access(s, user, preCase), user).toEqual({ read: false, send: false, rows: 0 });
        await s.expectError("CDF_NOT_FOUND", (tx) => reply(tx, preCase));
      }
    });
  });

  it("no path reads the vault: the rules and commands never touch protected identity", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const rows = await s.tx<{ name: string; body: string }[]>`
        select p.proname as name, p.prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where (n.nspname, p.proname) in (('authz', 'is_reporter_correspondent'), ('authz', 'can_message_reporter'),
               ('authz', 'can_read_reporter_conversation'), ('api', 'reply_to_reporter'),
               ('api', 'delegate_reporter_communication'), ('api', 'end_reporter_communication'))`;
      expect(rows).toHaveLength(6);
      for (const r of rows) expect(r.body, r.name).not.toMatch(/protected_identity|identity_vault|vault\./i);
    });
  });
});

describe("REPORTER_COMMUNICATE delegations", () => {
  it("whoever manages the team lets an assigned investigator write, and ends it; both are audited", async () => {
    await ownerScenario(async (s) => {
      await s.as("lead");
      const id = await delegate(s.tx, caseA, "investigatorA");
      expect(await access(s, "investigatorA", reportA)).toEqual({ read: true, send: true, rows: 2 });
      await reply(s.tx, reportA);
      // The delegate sees its own delegation; others on the case without team management see none.
      const own = await s.tx<{ id: string }[]>`select id from case_mgmt.reporter_communication_delegation`;
      expect(own.map((r) => r.id)).toEqual([id]);
      for (const user of ["committeeChair", "triage", "investigatorB", "platformAdmin"] as const) {
        await s.as(user);
        expect(await s.tx`select id from case_mgmt.reporter_communication_delegation`, user).toEqual([]);
      }

      await s.as("caseManager");
      await endDelegation(s.tx, id);
      expect(await access(s, "investigatorA", reportA)).toEqual({ read: false, send: false, rows: 0 });
      await s.expectError("CDF_FORBIDDEN", (tx) => reply(tx, reportA));

      await s.asOwner();
      const events = await s.tx<
        { action: string; actor_id: string; reason: string; metadata: { user_id: string } }[]
      >`
        select action, actor_id, reason, metadata from audit.audit_event
         where object_type = 'reporter_communication_delegation' and object_id = ${id} order by seq`;
      expect(events.map((e) => [e.action, e.actor_id, e.reason, e.metadata.user_id])).toEqual([
        ["REPORTER_COMMUNICATION_DELEGATED", USERS.lead, REASON, USERS.investigatorA],
        ["REPORTER_COMMUNICATION_ENDED", USERS.caseManager, REASON, USERS.investigatorA],
      ]);
    });
  });

  it("refuses everyone who does not manage the team, and anything but an investigator on the case", async () => {
    await scenario(async (s) => {
      // Not on the case: the case does not exist. Since S3 that includes triage after hand-over and the committee.
      for (const user of [
        "investigatorB",
        "intake",
        "platformAdmin",
        "records",
        "triage",
        "committeeChair",
        "committeeSecretary",
      ] as const) {
        await s.as(user);
        await s.expectError("CDF_NOT_FOUND", (tx) => delegate(tx, caseA, "investigatorA"));
      }
      // On the case without managing its team (an investigator cannot delegate to itself). Since S3 a CASE grant
      // stands in for the committee's former case reach.
      await s.as("caseManager");
      await s.tx`select api.grant_case_access(${caseA}, ${USERS.committee}, 'CASE', 'Synthetic: case access', null)`;
      for (const user of ["investigatorA", "committee"] as const) {
        await s.as(user);
        await s.expectError("CDF_FORBIDDEN", (tx) => delegate(tx, caseA, "investigatorA"));
      }
      await s.as("lead");
      // Only an investigator assigned to this case; the lead and the manager hold the conversation already.
      await s.expectError("CDF_INVALID:userId", (tx) => delegate(tx, caseA, "investigatorB"));
      await s.expectError("CDF_INVALID:userId", (tx) => delegate(tx, caseA, "lead"));
      await s.expectError("CDF_INVALID:userId", (tx) => delegate(tx, caseA, "committeeChair"));
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) => tx`select api.delegate_reporter_communication(${caseA}, ${USERS.investigatorA}, 'short')`,
      );
      const id = await delegate(s.tx, caseA, "investigatorA");
      await s.expectError("CDF_CONFLICT:ALREADY_DELEGATED", (tx) => delegate(tx, caseA, "investigatorA"));
      // Ending: the same rule, then once only.
      for (const user of ["investigatorA", "committee"] as const) {
        await s.as(user);
        await s.expectError("CDF_FORBIDDEN", (tx) => endDelegation(tx, id));
      }
      await s.as("investigatorB");
      await s.expectError("CDF_NOT_FOUND", (tx) => endDelegation(tx, id));
      await s.as("lead");
      await s.expectError("CDF_NOT_FOUND", (tx) => endDelegation(tx, "00000000-0000-4000-8000-000000000000"));
      await endDelegation(s.tx, id);
      await s.expectError("CDF_CONFLICT:DELEGATION_ENDED", (tx) => endDelegation(tx, id));
    });
  });

  it("lapses with the assignment, audited, and a later assignment does not revive it", async () => {
    await ownerScenario(async (s) => {
      await s.as("lead");
      const id = await delegate(s.tx, caseA, "investigatorA");
      await s.as("caseManager");
      const [a] = await s.tx<{ id: string }[]>`
        select id from case_mgmt.case_assignment
         where case_id = ${caseA} and user_id = ${USERS.investigatorA} and status = 'ACTIVE'`;
      await s.tx`select api.end_assignment(${a!.id}, ${REASON})`;
      const [d] = await s.tx<{ ended_by: string; end_reason: string }[]>`
        select ended_by, end_reason from case_mgmt.reporter_communication_delegation where id = ${id}`;
      expect(d).toEqual({
        ended_by: USERS.caseManager,
        end_reason: "The investigator's assignment on this case ended.",
      });

      await s.tx`select api.assign_case(${caseA}, ${USERS.investigatorA}, 'INVESTIGATOR', ${REASON})`;
      expect(await access(s, "investigatorA", reportA)).toEqual({ read: false, send: false, rows: 0 });
      await s.expectError("CDF_FORBIDDEN", (tx) => reply(tx, reportA));

      await s.asOwner();
      const [ev] = await s.tx<{ actor_id: string; metadata: { user_id: string; assignment_id: string } }[]>`
        select actor_id, metadata from audit.audit_event
         where action = 'REPORTER_COMMUNICATION_ENDED' and object_id = ${id}`;
      expect(ev).toEqual({
        actor_id: USERS.caseManager,
        metadata: { user_id: USERS.investigatorA, assignment_id: a!.id },
      });
    });
  });

  it("no application role writes the table; nobody deletes a delegation; none is added once archived", async () => {
    await scenario(async (s) => {
      await s.as("lead");
      await s.expectError(
        "permission denied",
        (
          tx,
        ) => tx`insert into case_mgmt.reporter_communication_delegation (case_id, user_id, reason, delegated_by)
                   values (${caseA}, ${USERS.investigatorA}, ${REASON}, ${USERS.lead})`,
      );
      await s.expectError(
        "permission denied",
        (tx) => tx`update case_mgmt.reporter_communication_delegation set ended_at = now()`,
      );
      await s.expectError(
        "permission denied",
        (tx) => tx`delete from case_mgmt.reporter_communication_delegation`,
      );
    });
    await ownerScenario(async (s) => {
      await s.as("lead");
      const id = await delegate(s.tx, caseA, "investigatorA");
      await s.asOwner();
      await s.expectError(
        "case_mgmt.reporter_communication_delegation is a protected record",
        (tx) => tx`delete from case_mgmt.reporter_communication_delegation where id = ${id}`,
      );
      await s.expectError(
        "case_mgmt.reporter_communication_delegation is a protected record",
        (tx) => tx`truncate case_mgmt.reporter_communication_delegation`,
      );
    });
    await scenario(async (s) => {
      await closeAndArchive(s, caseB);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:RECORDS_READ_ONLY", (tx) => delegate(tx, caseB, "investigatorB"));
    });
  });
});

describe("history and My Work follow the conversation's rule", () => {
  const MESSAGE_EVENTS = ["REPORT_MESSAGE_SENT", "REPORTER_MESSAGE_RECEIVED"];
  const actions = async (s: Scenario, user: UserKey, since = 0n) => {
    await s.as(user);
    return madeSince(
      await s.tx<{ seq: string; action: string }[]>`select seq, action from api.case_history(${caseA}, 500)`,
      since,
    ).map((r) => r.action);
  };

  it("message events reach the conversation's readers only; delegations reach those who manage the team and the delegate", async () => {
    await scenario(async (s) => {
      // The reporter writes and the lead answers here, so the message events are the newest whatever the case's
      // history holds (ledgerMark).
      const mark = await ledgerMark();
      await s.as(null);
      const [posted] = await s.tx<{ ok: boolean }[]>`
        select public_api.post_reporter_message(${REF_A}, ${seedHmac(REF_A)}, 'SYNTHETIC: one more detail.') as ok`;
      expect(posted!.ok).toBe(true);
      await s.as("lead");
      await reply(s.tx, reportA);
      for (const user of ["caseManager", "lead", "grcDirector"] as const)
        expect(await actions(s, user, mark), user).toEqual(expect.arrayContaining(MESSAGE_EVENTS));
      for (const user of ["investigatorA", "triage", "committeeSecretary", "committeeChair"] as const) {
        const seen = await actions(s, user);
        for (const a of MESSAGE_EVENTS) expect(seen, user).not.toContain(a);
      }

      await s.as("lead");
      await delegate(s.tx, caseA, "investigatorA");
      for (const user of ["lead", "caseManager", "investigatorA"] as const)
        expect(await actions(s, user), user).toContain("REPORTER_COMMUNICATION_DELEGATED");
      // Now a correspondent, the delegate sees the message events too.
      expect(await actions(s, "investigatorA", mark)).toEqual(expect.arrayContaining(MESSAGE_EVENTS));
      for (const user of ["triage", "committeeChair"] as const)
        expect(await actions(s, user), user).not.toContain("REPORTER_COMMUNICATION_DELEGATED");

      await s.as("lead");
      const [row] = await s.tx<{ subject_name: string; reason: string }[]>`
        select subject_name, reason from api.case_history(${caseA}, 500)
         where action = 'REPORTER_COMMUNICATION_DELEGATED'`;
      expect(row).toEqual({ subject_name: "Investigator Alpha", reason: REASON });
    });
  });

  it("'the reporter replied' goes to those who may answer, never to the rest of the case team", async () => {
    await scenario(async (s) => {
      await s.as(null);
      const [posted] = await s.tx<{ ok: boolean }[]>`
        select public_api.post_reporter_message(${REF_A}, ${seedHmac(REF_A)}, 'SYNTHETIC: one more detail.') as ok`;
      expect(posted!.ok).toBe(true);
      const replied = async (user: UserKey) => {
        await s.as(user);
        return s.tx<{ area: string; case_id: string | null }[]>`
          select area, case_id from api.my_work_items()
           where category = 'REPORTER_REPLIED' and target_id = ${reportA}`;
      };
      for (const user of ["caseManager", "lead"] as const)
        expect(await replied(user), user).toEqual([{ area: "CASES", case_id: caseA }]);
      for (const user of ["investigatorA", "triage", "intake", "grcDirector", "committeeChair"] as const)
        expect(await replied(user), user).toEqual([]);
      await s.as("lead");
      await delegate(s.tx, caseA, "investigatorA");
      expect(await replied("investigatorA")).toEqual([{ area: "CASES", case_id: caseA }]);
    });
  });
});
