// EPIC 09 (CDF-60, ADR-012): statement hashes are computed by the database and cannot be supplied or
// changed; interview history is append-only; an approved interview is frozen; preparer, reviewer and
// approver are three people; every state change leaves exactly one audit event.
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { USERS, admin, caseId, scenario, type Scenario } from "../support/db";

let caseA: string;
let approvedA: string;
beforeAll(async () => {
  caseA = await caseId("0001");
  const [row] = await admin<{ id: string }[]>`
    select id from case_mgmt.interview where case_id = ${caseA} and status = 'APPROVED' order by sequence_no limit 1`;
  approvedA = row!.id;
});

class Rollback extends Error {}
/** Runs as the database owner inside a transaction that is always rolled back. */
async function asOwner(fn: (tx: Tx) => Promise<void>) {
  try {
    await admin.begin(async (tx) => {
      await fn(tx as unknown as Tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
async function ownerError(statement: (tx: Tx) => Promise<unknown>): Promise<string> {
  let message = "";
  await asOwner(async (tx) => {
    try {
      await statement(tx);
    } catch (error) {
      message = (error as Error).message;
    }
  });
  return message;
}

const SHA = (text: string) =>
  admin<{ h: string }[]>`select encode(sha256(convert_to(${text}, 'UTF8')), 'hex') as h`.then((r) => r[0]!.h);

/** A CONDUCTED witness interview on case A by investigator A, with one acknowledged statement. */
async function conducted(s: Scenario, panel?: { user: string; role: "INTERVIEWER" | "NOTE_TAKER" }) {
  await s.as("investigatorA");
  const [p] = await s.tx<{ id: string }[]>`
    select api.plan_interview(${caseA}, 'Synthetic integrity interview', null, 'WITNESS', 'Witness Kappa (synthetic)',
      null, 'CONFIDENTIAL'::core.classification_level) as id`;
  const id = p!.id;
  if (panel) await s.tx`select api.add_interview_participant(${id}, ${panel.user}, ${panel.role})`;
  await s.tx`select api.schedule_interview(${id}, now() - interval '2 hours', 60, 'PHONE', null)`;
  await s.tx`select api.issue_interview_notice(${id}, 'INVITATION', 'INTERNAL_EMAIL')`;
  await s.tx`select api.record_interview_rights(${id}, 'VERBAL_ON_RECORD', 'SYNTHETIC-RIGHTS-V1')`;
  await s.tx`select api.record_interview_conducted(${id}, now() - interval '2 hours', now() - interval '1 hour')`;
  const [v] = await s.tx<{ id: string; sha: string }[]>`
    select o_version_id as id, o_sha256 as sha from api.record_interview_statement(${id}, 'SYNTHETIC statement one.', 'en')`;
  await s.tx`select api.acknowledge_interview_statement(${v!.id}, 'ELECTRONIC_ACK', ${v!.sha})`;
  return { id, versionId: v!.id, sha: v!.sha };
}
const status = async (s: Scenario, id: string) => {
  const [r] = await s.tx<{ status: string }[]>`select status from case_mgmt.interview where id = ${id}`;
  return r!.status;
};

describe("statement integrity", () => {
  it("computes the hash in the database and ignores any supplied value", async () => {
    await scenario(async (s) => {
      const { versionId, sha } = await conducted(s);
      expect(sha).toBe(await SHA("SYNTHETIC statement one."));
      const [row] = await s.tx<{ content_sha256: string }[]>`
        select content_sha256 from case_mgmt.interview_statement_version where id = ${versionId}`;
      expect(row!.content_sha256).toBe(sha);
    });
    await asOwner(async (tx) => {
      const [i] = await tx<{ id: string; by: string }[]>`
        select interview_id as id, recorded_by as by from case_mgmt.interview_statement_version limit 1`;
      const [v] = await tx<{ sha: string }[]>`
        insert into case_mgmt.interview_statement_version (interview_id, version_no, content, language, content_sha256, recorded_by)
        values (${i!.id}, 99, 'SYNTHETIC forged', 'en', ${"f".repeat(64)}, ${i!.by}) returning content_sha256 as sha`;
      expect(v!.sha).toBe(await SHA("SYNTHETIC forged"));
    });
  });

  it("cannot be changed or removed, even by the database owner", async () => {
    // The seed holds rows in each of these, so every statement below reaches the trigger.
    for (const table of [
      "interview_statement_version",
      "interview_statement_ack",
      "interview_notice",
      "interview_participant",
    ]) {
      expect(await ownerError((tx) => tx.unsafe(`update case_mgmt.${table} set id = id`)), table).toContain(
        "append-only",
      );
      expect(await ownerError((tx) => tx.unsafe(`delete from case_mgmt.${table}`)), table).toContain(
        "append-only",
      );
    }
    for (const table of [
      "interview_statement_version",
      "interview_statement_ack",
      "interview_notice",
      "interview_participant",
      "interview_recording",
      "interview",
    ]) {
      expect(await ownerError((tx) => tx.unsafe(`truncate case_mgmt.${table} cascade`)), table).toContain(
        "append-only",
      );
    }
    const [triggers] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_trigger where tgrelid = 'case_mgmt.interview_recording'::regclass
        and tgname in ('interview_recording_no_update', 'interview_recording_no_delete')`;
    expect(triggers!.n).toBe(2);
    expect(
      await ownerError((tx) => tx`update case_mgmt.interview_statement_version set content = 'tampered'`),
    ).toContain("append-only");
    expect(await ownerError((tx) => tx`delete from case_mgmt.interview`)).toContain("append-only");
  });

  it("freezes an approved interview and its identity fields", async () => {
    expect(
      await ownerError((tx) => tx`update case_mgmt.interview set title = 'tampered' where id = ${approvedA}`),
    ).toContain("immutable once APPROVED");
    await scenario(async (s) => {
      const { id } = await conducted(s);
      await s.tx`reset role`;
      await s.expectError(
        "permission denied",
        (tx) => tx`update case_mgmt.interview set title = 'x' where id = ${id}`,
      );
    });
    const [planned] = await admin<{ id: string }[]>`
      select id from case_mgmt.interview where status = 'PLANNED' limit 1`;
    expect(
      await ownerError(
        (tx) =>
          tx`update case_mgmt.interview set interviewee_label = 'Someone else' where id = ${planned!.id}`,
      ),
    ).toContain("identity fields are immutable");
  });

  it("requires an acknowledgement of the current version and of its exact hash", async () => {
    await scenario(async (s) => {
      const { id, sha } = await conducted(s);
      // A corrected statement makes a new version; the old acknowledgement does not cover it.
      const [v2] = await s.tx<{ id: string; sha: string; no: number }[]>`
        select o_version_id as id, o_sha256 as sha, o_version_no as no
        from api.record_interview_statement(${id}, 'SYNTHETIC statement one, corrected.', 'en')`;
      expect(v2!.no).toBe(2);
      await s.expectError(
        "CDF_CONFLICT:STATEMENT_NOT_ACKNOWLEDGED",
        (tx) => tx`select api.transition_interview(${id}, 'PREPARE')`,
      );
      await s.expectError(
        "CDF_CONFLICT:STATEMENT_HASH_MISMATCH",
        (tx) => tx`select api.acknowledge_interview_statement(${v2!.id}, 'SIGNED_PAPER', ${sha})`,
      );
      await s.tx`select api.acknowledge_interview_statement(${v2!.id}, 'SIGNED_PAPER', ${v2!.sha})`;
      await s.expectError(
        "CDF_CONFLICT:STATEMENT_ALREADY_ACKNOWLEDGED",
        (tx) => tx`select api.acknowledge_interview_statement(${v2!.id}, 'SIGNED_PAPER', ${v2!.sha})`,
      );
      expect((await s.tx`select api.transition_interview(${id}, 'PREPARE') as s`)[0]!.s).toBe("PREPARED");
      // Nothing more can be recorded once prepared.
      await s.expectError(
        "CDF_CONFLICT:INTERVIEW_STATE",
        (tx) => tx`select * from api.record_interview_statement(${id}, 'SYNTHETIC late change', 'en')`,
      );
    });
  });
});

describe("interview lifecycle rules", () => {
  it("cannot be conducted without an invitation and acknowledged rights", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const [p] = await s.tx<{ id: string }[]>`
        select api.plan_interview(${caseA}, 'Synthetic', null, 'WITNESS', 'Witness Kappa', null,
          'CONFIDENTIAL'::core.classification_level) as id`;
      const id = p!.id;
      await s.expectError(
        "CDF_CONFLICT:INTERVIEW_STATE",
        (tx) => tx`select api.record_interview_conducted(${id}, now() - interval '1 hour', now())`,
      );
      await s.tx`select api.schedule_interview(${id}, now(), 30, 'PHONE', null)`;
      await s.expectError(
        "CDF_CONFLICT:NOTICE_NOT_ISSUED",
        (tx) => tx`select api.record_interview_conducted(${id}, now() - interval '1 hour', now())`,
      );
      await s.tx`select api.issue_interview_notice(${id}, 'INVITATION', 'IN_PERSON')`;
      await s.expectError(
        "CDF_CONFLICT:RIGHTS_NOT_ACKNOWLEDGED",
        (tx) => tx`select api.record_interview_conducted(${id}, now() - interval '1 hour', now())`,
      );
      // Only a panel interviewer records the rights; the case manager is not on this panel.
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:NOT_INTERVIEWER",
        (tx) => tx`select api.record_interview_rights(${id}, 'SIGNED_FORM', 'SYNTHETIC-RIGHTS-V1')`,
      );
    });
  });

  it("separates preparer, reviewer and approver", async () => {
    await scenario(async (s) => {
      const { id } = await conducted(s);
      // Investigator A prepares; investigators do not review or approve at all.
      await s.tx`select api.transition_interview(${id}, 'PREPARE')`;
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.transition_interview(${id}, 'REVIEW')`);
      // The lead reviews, so the lead cannot also approve.
      await s.as("lead");
      await s.tx`select api.transition_interview(${id}, 'REVIEW')`;
      await s.expectError(
        "CDF_CONFLICT:SEPARATION_OF_DUTIES",
        (tx) => tx`select api.transition_interview(${id}, 'APPROVE')`,
      );
      await s.as("caseManager");
      await s.tx`select api.transition_interview(${id}, 'APPROVE')`;
      expect(await status(s, id)).toBe("APPROVED");
      const [row] = await s.tx<{ p: string; r: string; a: string }[]>`
        select prepared_by as p, reviewed_by as r, approved_by as a from case_mgmt.interview where id = ${id}`;
      expect(row).toEqual({ p: USERS.investigatorA, r: USERS.lead, a: USERS.caseManager });
    });
    await scenario(async (s) => {
      // A preparer who is also a reviewer (the lead) still cannot review their own preparation.
      const { id } = await conducted(s, { user: USERS.lead, role: "INTERVIEWER" });
      await s.as("lead");
      await s.tx`select api.transition_interview(${id}, 'PREPARE')`;
      await s.expectError(
        "CDF_CONFLICT:SEPARATION_OF_DUTIES",
        (tx) => tx`select api.transition_interview(${id}, 'REVIEW')`,
      );
      await s.expectError(
        "CDF_CONFLICT:SEPARATION_OF_DUTIES",
        (tx) => tx`select api.transition_interview(${id}, 'RETURN', 'Synthetic: returning my own work')`,
      );
    });
    // The table itself refuses a row where one person both prepared and reviewed.
    const [planned] = await admin<{ id: string }[]>`
      select id from case_mgmt.interview where status = 'PLANNED' limit 1`;
    expect(
      await ownerError(
        (tx) => tx`update case_mgmt.interview set prepared_by = created_by, prepared_at = now(),
          reviewed_by = created_by, reviewed_at = now() where id = ${planned!.id}`,
      ),
    ).toContain("violates check constraint");
  });

  it("needs a reason to return or cancel, and cancels only before the interview", async () => {
    await scenario(async (s) => {
      const { id } = await conducted(s);
      await s.expectError(
        "CDF_CONFLICT:INTERVIEW_STATE",
        (tx) => tx`select api.transition_interview(${id}, 'CANCEL', 'Synthetic: witness unavailable')`,
      );
      await s.tx`select api.transition_interview(${id}, 'PREPARE')`;
      await s.as("lead");
      await s.expectError("CDF_INVALID:reason", (tx) => tx`select api.transition_interview(${id}, 'RETURN')`);
      await s.tx`select api.transition_interview(${id}, 'RETURN', 'Synthetic: add the second invoice batch')`;
      const [r] = await s.tx<{ status: string; prepared_by: string | null }[]>`
        select status, prepared_by from case_mgmt.interview where id = ${id}`;
      expect(r).toEqual({ status: "CONDUCTED", prepared_by: null });
    });
  });
});

describe("interview audit trail", () => {
  it("records exactly one business event per state change, with no statement text", async () => {
    await scenario(async (s) => {
      const { id, versionId } = await conducted(s, { user: USERS.lead, role: "NOTE_TAKER" });
      await s.tx`select api.transition_interview(${id}, 'PREPARE')`;
      await s.as("lead");
      await s.tx`select api.transition_interview(${id}, 'RETURN', 'Synthetic: add the second invoice batch')`;
      await s.as("investigatorA");
      await s.tx`select api.transition_interview(${id}, 'PREPARE')`;
      await s.as("lead");
      await s.tx`select api.transition_interview(${id}, 'REVIEW')`;
      await s.as("caseManager");
      await s.tx`select api.transition_interview(${id}, 'APPROVE')`;

      // A second interview is rescheduled and cancelled.
      await s.as("investigatorA");
      const [p] = await s.tx<{ id: string }[]>`
        select api.plan_interview(${caseA}, 'Synthetic', null, 'OTHER', 'Officer Zeta (synthetic)', null,
          'CONFIDENTIAL'::core.classification_level) as id`;
      await s.tx`select api.schedule_interview(${p!.id}, now() + interval '1 day', 30, 'PHONE', null)`;
      await s.tx`select api.schedule_interview(${p!.id}, now() + interval '2 days', 30, 'PHONE', null)`;
      await s.tx`select api.transition_interview(${p!.id}, 'CANCEL', 'Synthetic: no longer needed')`;

      await s.as("internalAudit");
      const events = await s.tx<
        { action: string; object: string; metadata: unknown; reason: string | null }[]
      >`
        select action, object_id as object, metadata, reason from audit.audit_event
        where object_id in (${id}, ${versionId}, ${p!.id}) order by seq`;
      expect(events.map((e) => e.action)).toEqual([
        "INTERVIEW_PLANNED",
        "INTERVIEW_PARTICIPANT_ADDED",
        "INTERVIEW_SCHEDULED",
        "INTERVIEW_NOTICE_ISSUED",
        "INTERVIEW_RIGHTS_ACKNOWLEDGED",
        "INTERVIEW_CONDUCTED",
        "INTERVIEW_STATEMENT_RECORDED",
        "INTERVIEW_STATEMENT_ACKNOWLEDGED",
        "INTERVIEW_PREPARED",
        "INTERVIEW_RETURNED",
        "INTERVIEW_PREPARED",
        "INTERVIEW_REVIEWED",
        "INTERVIEW_APPROVED",
        "INTERVIEW_PLANNED",
        "INTERVIEW_SCHEDULED",
        "INTERVIEW_RESCHEDULED",
        "INTERVIEW_CANCELLED",
      ]);
      expect(JSON.stringify(events)).not.toContain("SYNTHETIC statement one");
      const returned = events.find((e) => e.action === "INTERVIEW_RETURNED")!;
      expect(returned.reason).toBe("Synthetic: add the second invoice batch");
      expect(returned.metadata).toMatchObject({ from_status: "PREPARED", to_status: "CONDUCTED" });
      const recorded = events.find((e) => e.action === "INTERVIEW_STATEMENT_RECORDED")!;
      expect(recorded.object).toBe(versionId);
    });
  });
});
