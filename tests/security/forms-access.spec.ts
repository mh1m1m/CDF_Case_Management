// Phase 8 forms engine (ADR-011; §18–§21, §29, §45, §83): form instances follow case access, clearance and
// per-form role entitlement; preparing needs a working relationship with an active case; review and
// approval are separated duties; versions and events are append-only; audit carries hashes, never content.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "@cdf/domain";
import type { Tx } from "@cdf/infrastructure";
import { USERS, admin, caseId, scenario, type Scenario, type UserKey } from "../support/db";

let caseA: string, caseB: string;
beforeAll(async () => {
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
});

const MARKER = "SYNTHETIC-CONTENT-MARKER";
const EVIDENCE_REGISTER = {
  evidence_count: "3",
  evidence_scope: `Synthetic evidence register scope ${MARKER}`,
  chain_of_custody_status: "مكتملة",
  storage_confirmation: "true",
};
const COMMITTEE_FORMATION = {
  formation_reference: "CDF-DEMO-COMMITTEE-0001",
  formation_date: "2026-03-01",
  chair: "Committee Chair Xi",
  members: "Committee Member Epsilon\nCommittee Member Zeta",
  secretary: "Committee Secretary Nu",
  scope: `Synthetic committee scope ${MARKER}`,
  independence_confirmed: "true",
};

async function start(tx: Tx, target: string, code: string, classification = "CONFIDENTIAL"): Promise<string> {
  const [row] = await tx<
    { id: string }[]
  >`select api.start_form(${target}, ${code}, ${classification}::core.classification_level) as id`;
  return row!.id;
}
async function save(tx: Tx, instanceId: string, data: unknown) {
  const [row] = await tx<{ versionId: string; versionNo: number; contentHash: string }[]>`
    select o_version_id as "versionId", o_version_no as "versionNo", o_content_hash as "contentHash"
    from api.save_form_draft(${instanceId}, ${tx.json(data as never)})`;
  return row!;
}
const prepare = (tx: Tx, id: string) => tx`select api.prepare_form(${id})`;
const review = (tx: Tx, id: string, outcome: string, reason: string | null = null) =>
  tx`select api.review_form(${id}, ${outcome}, ${reason})`;
const approve = (tx: Tx, id: string, outcome: string, reason: string | null = null) =>
  tx`select api.approve_form(${id}, ${outcome}, ${reason})`;
const withdraw = (tx: Tx, id: string, reason: string) => tx`select api.withdraw_form(${id}, ${reason})`;
const open = async (tx: Tx, id: string) => {
  const [r] = await tx<{ ok: boolean }[]>`select api.open_form_instance(${id}) as ok`;
  return r!.ok;
};
const status = async (tx: Tx, id: string) => {
  const [r] = await tx<{ status: string }[]>`select status from forms.form_instance where id = ${id}`;
  return r?.status ?? null;
};
const visible = async (tx: Tx, id: string) => {
  const [r] = await tx<{ n: number }[]>`select count(*)::int as n from forms.form_instance where id = ${id}`;
  return r!.n;
};
const countRows = async (tx: Tx, table: "form_instance_version" | "form_event", id: string) => {
  const [r] = await tx<{ n: number }[]>`
    select count(*)::int as n from forms.${tx(table)} where instance_id = ${id}`;
  return r!.n;
};

/** An Evidence Register (WB-FRM-11) saved on case A by investigator A, inside the caller's scenario. */
async function evidenceRegisterOnCaseA(s: Scenario): Promise<string> {
  await s.as("investigatorA");
  const id = await start(s.tx, caseA, "WB-FRM-11");
  await save(s.tx, id, EVIDENCE_REGISTER);
  return id;
}

describe("form visibility", () => {
  it("follows case access, clearance and the per-form role entitlement", async () => {
    await scenario(async (s) => {
      const id = await evidenceRegisterOnCaseA(s);
      // WB-FRM-11 is an investigation form: committee roles are not entitled to see it even with case access.
      const matrix: [UserKey, number][] = [
        ["investigatorA", 1],
        ["lead", 1],
        ["caseManager", 1],
        ["grcDirector", 1],
        ["grcDeputy", 1],
        ["triage", 1], // TRIAGE grant on case A and TRIAGE_OFFICER is entitled to view
        ["investigatorB", 0], // not assigned to case A
        ["committee", 0],
        ["committeeSecretary", 0], // COMMITTEE grant on case A, but no entitlement on WB-FRM-11
        ["committeeChair", 0],
        ["intake", 0], // RESTRICTED clearance, CONFIDENTIAL case
        ["platformAdmin", 0],
        ["internalAudit", 0],
        ["soc", 0],
        ["dpo", 0],
        ["revoked", 0],
      ];
      for (const [user, expected] of matrix) {
        await s.as(user);
        expect(await visible(s.tx, id), user).toBe(expected);
        expect(await countRows(s.tx, "form_instance_version", id), `${user} versions`).toBe(expected);
        expect(await countRows(s.tx, "form_event", id), `${user} events`).toBe(expected * 2);
      }
    });
  });

  it("is per form: a committee form is visible to committee roles and hidden from investigators", async () => {
    await scenario(async (s) => {
      await s.as("committeeSecretary");
      const id = await start(s.tx, caseA, "WB-FRM-13");
      await save(s.tx, id, COMMITTEE_FORMATION);
      const matrix: [UserKey, number][] = [
        ["committeeSecretary", 1],
        ["committeeChair", 1],
        ["caseManager", 1],
        ["grcDirector", 1],
        ["triage", 1],
        ["committee", 0], // entitled to view WB-FRM-13 but has no access to case A
        ["investigatorA", 0], // assigned to case A, not entitled to committee forms
        ["lead", 0],
      ];
      for (const [user, expected] of matrix) {
        await s.as(user);
        expect(await visible(s.tx, id), user).toBe(expected);
      }
    });
  });

  it("hides instances classified above the viewer's clearance even when the case is visible", async () => {
    await scenario(async (s) => {
      // Case B is RESTRICTED. Investigator B (assigned, CONFIDENTIAL clearance) files a CONFIDENTIAL form; the
      // intake officer (RESTRICTED clearance) is granted the case and may file a RESTRICTED one.
      await s.as("investigatorB");
      const confidential = await start(s.tx, caseB, "WB-FRM-11", "CONFIDENTIAL");
      await s.as("caseManager");
      await s.tx`select api.grant_case_access(${caseB}, ${USERS.intake}, 'CASE', 'Synthetic: clearance test', null)`;
      await s.as("intake");
      const [caseVisible] = await s.tx<{ ok: boolean }[]>`select authz.can_view_case(${caseB}) as ok`;
      expect(caseVisible!.ok).toBe(true);
      expect(await visible(s.tx, confidential)).toBe(0);
      expect(await open(s.tx, confidential)).toBe(false);
      const restricted = await start(s.tx, caseB, "WB-FRM-01", "RESTRICTED");
      expect(await visible(s.tx, restricted)).toBe(1);
      await s.as("caseManager");
      expect(await visible(s.tx, restricted)).toBe(1);
      await s.as("investigatorB"); // sees the case, but investigators are not entitled to intake forms
      expect(await visible(s.tx, restricted)).toBe(0);
    });
  });

  it("never exposes request correlation ids to application roles", async () => {
    await scenario(async (s) => {
      await evidenceRegisterOnCaseA(s);
      await s.expectError(
        "permission denied",
        (tx) => tx`select request_id from forms.form_instance_version`,
      );
      await s.expectError("permission denied", (tx) => tx`select request_id from forms.form_event`);
      const rows = await s.tx<{ table: string; cols: string[] }[]>`
        select table_name as "table", array_agg(column_name::text order by column_name) as cols
        from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'forms' and table_name in ('form_instance_version', 'form_event')
        group by table_name`;
      for (const r of rows) expect(r.cols, r.table).not.toContain("request_id");
    });
  });
});

describe("form start gate", () => {
  it("needs the permission, the entitlement and a working relationship with a visible active case", async () => {
    await scenario(async (s) => {
      await s.as("triage"); // TRIAGE grant on case A; TRIAGE_OFFICER prepares intake forms
      expect(await start(s.tx, caseA, "WB-FRM-01")).toMatch(/^[0-9a-f-]{36}$/);
      await s.as("investigatorA"); // assigned investigator; the baseline gives investigators no committee forms
      await s.expectError("CDF_FORBIDDEN", (tx) => start(tx, caseA, "WB-FRM-13")); // committee form
      await s.as("lead");
      expect(await start(s.tx, caseA, "WB-FRM-11")).toMatch(/^[0-9a-f-]{36}$/);
      await s.as("grcDirector"); // sees every case, but GRC reviews and approves; it does not prepare
      await s.expectError("CDF_FORBIDDEN", (tx) => start(tx, caseA, "WB-FRM-11"));
      await s.as("committee"); // entitled to view committee forms, no case access
      await s.expectError("CDF_NOT_FOUND", (tx) => start(tx, caseA, "WB-FRM-13"));
      await s.as("investigatorB");
      await s.expectError("CDF_NOT_FOUND", (tx) => start(tx, caseA, "WB-FRM-11"));
      await s.expectError("CDF_NOT_FOUND", (tx) => start(tx, randomUUID(), "WB-FRM-11"));
      await s.as("revoked"); // an inactive profile is no actor at all
      await s.expectError("CDF_UNAUTHENTICATED", (tx) => start(tx, caseA, "WB-FRM-11"));
      await s.as(null); // anon has no usage on the api schema at all
      await s.expectError("permission denied", (tx) => start(tx, caseA, "WB-FRM-11"));
    });
  });

  it("treats an AUDIT-scope grant and a committee seat as read-only relationships", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.tx`select api.grant_case_access(${caseB}, ${USERS.intake}, 'AUDIT', 'Synthetic: audit scope test', null)`;
      await s.as("intake"); // INTAKE_OFFICER may prepare WB-FRM-01 in general, but only sees case B for audit
      const [caseVisible] = await s.tx<{ ok: boolean }[]>`select authz.can_view_case(${caseB}) as ok`;
      expect(caseVisible!.ok).toBe(true);
      await s.expectError("CDF_FORBIDDEN", (tx) => start(tx, caseB, "WB-FRM-01", "RESTRICTED"));
      await s.as("committeeSecretary"); // COMMITTEE grant: may prepare committee forms, not investigation ones
      expect(await start(s.tx, caseA, "WB-FRM-13")).toMatch(/^[0-9a-f-]{36}$/);
      await s.expectError("CDF_FORBIDDEN", (tx) => start(tx, caseA, "WB-FRM-11"));
    });
  });

  it("rejects unknown forms and classifications outside the case floor and the actor's clearance", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA"); // CONFIDENTIAL clearance on a CONFIDENTIAL case
      await s.expectError("CDF_INVALID:form_code", (tx) => start(tx, caseA, "WB-FRM-99"));
      await s.expectError("CDF_INVALID:classification", (tx) => start(tx, caseA, "WB-FRM-11", "RESTRICTED"));
      await s.expectError("CDF_INVALID:classification", (tx) => start(tx, caseA, "WB-FRM-11", "SECRET"));
      expect(await start(s.tx, caseA, "WB-FRM-11", "CONFIDENTIAL")).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});

describe("form data validation in the database", () => {
  it("rejects unknown keys, wrong shapes, bad options, bad dates and oversized or control-character text", async () => {
    await scenario(async (s) => {
      await s.as("committeeSecretary");
      const id = await start(s.tx, caseA, "WB-FRM-13");
      await s.expectError("CDF_INVALID:data", (tx) => save(tx, id, { not_a_field: "x" }));
      await s.expectError("CDF_INVALID:data", (tx) => save(tx, id, ["chair"]));
      await s.expectError("CDF_INVALID:chair", (tx) => save(tx, id, { chair: 42 }));
      await s.expectError("CDF_INVALID:formation_date", (tx) =>
        save(tx, id, { formation_date: "2026-02-30" }),
      );
      await s.expectError("CDF_INVALID:formation_date", (tx) =>
        save(tx, id, { formation_date: "01/03/2026" }),
      );
      await s.expectError("CDF_INVALID:independence_confirmed", (tx) =>
        save(tx, id, { independence_confirmed: "yes" }),
      );
      await s.expectError("CDF_INVALID:chair", (tx) => save(tx, id, { chair: "a".repeat(501) }));
      await s.expectError("CDF_INVALID:chair", (tx) => save(tx, id, { chair: "line\nbreak" }));
      await s.expectError("CDF_INVALID:members", (tx) => save(tx, id, { members: "m".repeat(4001) }));
      expect((await save(s.tx, id, { members: "one\ntwo\tthree" })).versionNo).toBe(1);
      await s.as("investigatorA");
      const register = await start(s.tx, caseA, "WB-FRM-11");
      await s.expectError("CDF_INVALID:chain_of_custody_status", (tx) =>
        save(tx, register, { chain_of_custody_status: "سليمة" }),
      );
      await s.expectError("CDF_INVALID:evidence_count", (tx) =>
        save(tx, register, { evidence_count: "three" }),
      );
      await s.expectError("CDF_INVALID:evidence_count", (tx) =>
        save(tx, register, { evidence_count: "1e3" }),
      );
      expect((await save(s.tx, register, { evidence_count: "-2.5" })).versionNo).toBe(1);
    });
  });

  it("stores canonical content whose hash the database can recompute", async () => {
    await scenario(async (s) => {
      const id = await evidenceRegisterOnCaseA(s);
      const [row] = await s.tx<
        { data: Record<string, string>; hash: string; recomputed: string; canonical: string }[]
      >`
        select v.data, v.content_hash as hash,
               forms.content_hash(i.form_code, dv.schema_hash, v.data) as recomputed,
               forms.canonical_json(v.data) as canonical
        from forms.form_instance i
        join forms.form_instance_version v on v.id = i.current_version_id
        join forms.form_definition_version dv on dv.id = i.definition_version_id
        where i.id = ${id}`;
      expect(row!.recomputed).toBe(row!.hash);
      expect(row!.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row!.data).toEqual(EVIDENCE_REGISTER);
      // The database and @cdf/domain agree on the canonical text (sorted keys, JSON escaping), so a client
      // can verify a stored hash without trusting the server.
      expect(row!.canonical).toBe(canonicalJson(EVIDENCE_REGISTER));
    });
  });
});

describe("form lifecycle", () => {
  it("prepare locks a validated version; review by a different entitled person makes WB-FRM-11 final", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const id = await start(s.tx, caseA, "WB-FRM-11");
      await s.expectError("CDF_CONFLICT:FORM_EMPTY", (tx) => prepare(tx, id));
      const v1 = await save(s.tx, id, { evidence_scope: "partial" });
      expect(v1.versionNo).toBe(1);
      expect((await save(s.tx, id, { evidence_scope: "partial" })).versionId).toBe(v1.versionId); // idempotent
      // Strict validation at prepare time reports the first missing required field.
      await s.expectError("CDF_INVALID:chain_of_custody_status", (tx) => prepare(tx, id));
      const v2 = await save(s.tx, id, EVIDENCE_REGISTER);
      expect(v2.versionNo).toBe(2);
      await prepare(s.tx, id);
      expect(await status(s.tx, id)).toBe("PREPARED");
      await s.expectError("CDF_CONFLICT:FORM_NOT_DRAFT", (tx) =>
        save(tx, id, { evidence_scope: "late edit" }),
      );
      await s.expectError("CDF_CONFLICT:FORM_NOT_DRAFT", (tx) => prepare(tx, id));
      // The preparer cannot review (no FORM_REVIEW); an entitled reviewer who is not the preparer can.
      await s.expectError("CDF_FORBIDDEN", (tx) => review(tx, id, "REVIEWED"));
      await s.as("committeeChair"); // FORM_REVIEW, but not entitled to this form and cannot even see it
      await s.expectError("CDF_NOT_FOUND", (tx) => review(tx, id, "REVIEWED"));
      await s.as("lead");
      await s.expectError("CDF_INVALID:outcome", (tx) => review(tx, id, "APPROVED"));
      await review(s.tx, id, "REVIEWED");
      expect(await status(s.tx, id)).toBe("REVIEWED");
      // WB-FRM-11 needs no approval, so REVIEWED is final: nothing further can happen to it.
      await s.as("grcDirector");
      await s.expectError("CDF_FORBIDDEN", (tx) => approve(tx, id, "APPROVED"));
      await s.as("investigatorA");
      await s.expectError("CDF_CONFLICT:FORM_FINAL", (tx) => withdraw(tx, id, "Synthetic: too late"));
      await s.expectError("CDF_CONFLICT:FORM_NOT_DRAFT", (tx) => save(tx, id, EVIDENCE_REGISTER));
      const events = await s.tx<
        { event_type: string; from_status: string | null; to_status: string; actor_id: string }[]
      >`
        select event_type, from_status, to_status, actor_id from forms.form_event where instance_id = ${id} order by seq`;
      expect(events.map((e) => [e.event_type, e.from_status, e.to_status])).toEqual([
        ["CREATED", null, "DRAFT"],
        ["SAVED", "DRAFT", "DRAFT"],
        ["SAVED", "DRAFT", "DRAFT"],
        ["PREPARED", "DRAFT", "PREPARED"],
        ["REVIEWED", "PREPARED", "REVIEWED"],
      ]);
      expect(events.at(-1)!.actor_id).toBe(USERS.lead);
      const [inst] = await s.tx<{ prepared_version_id: string; prepared_by: string; reviewed_by: string }[]>`
        select prepared_version_id, prepared_by, reviewed_by from forms.form_instance where id = ${id}`;
      expect(inst).toEqual({
        prepared_version_id: v2.versionId,
        prepared_by: USERS.investigatorA,
        reviewed_by: USERS.lead,
      });
    });
  });

  it("separates preparer, reviewer and approver on an approval form and returns it to draft on demand", async () => {
    await scenario(async (s) => {
      await s.as("committeeSecretary");
      const id = await start(s.tx, caseA, "WB-FRM-13");
      await save(s.tx, id, COMMITTEE_FORMATION);
      await prepare(s.tx, id);
      await s.expectError("CDF_FORBIDDEN", (tx) => review(tx, id, "REVIEWED")); // secretary has no FORM_REVIEW
      await s.as("committeeChair");
      await s.expectError("CDF_CONFLICT:FORM_NOT_REVIEWED", (tx) => approve(tx, id, "APPROVED")); // not yet reviewed
      await review(s.tx, id, "REVIEWED");
      expect(await status(s.tx, id)).toBe("REVIEWED");
      // The chair reviewed, so the chair may not also approve.
      await s.expectError("CDF_CONFLICT:FORM_SEPARATION_OF_DUTIES", (tx) => approve(tx, id, "APPROVED"));
      await s.as("grcDirector");
      await s.expectError("CDF_INVALID:reason", (tx) => approve(tx, id, "RETURNED"));
      await s.expectError("CDF_INVALID:reason", (tx) => approve(tx, id, "RETURNED", "too short"));
      await approve(s.tx, id, "RETURNED", "Synthetic: membership list incomplete");
      expect(await status(s.tx, id)).toBe("DRAFT");
      const [cleared] = await s.tx<{ prepared_by: string | null; reviewed_by: string | null }[]>`
        select prepared_by, reviewed_by from forms.form_instance where id = ${id}`;
      expect(cleared).toEqual({ prepared_by: null, reviewed_by: null });
      // Second round: amend, prepare, review, approve by three different people.
      await s.as("committeeSecretary");
      const v2 = await save(s.tx, id, { ...COMMITTEE_FORMATION, members: "Epsilon\nZeta\nEta" });
      expect(v2.versionNo).toBe(2);
      await prepare(s.tx, id);
      await s.as("committeeChair");
      await review(s.tx, id, "REVIEWED");
      await s.as("grcDirector");
      await approve(s.tx, id, "APPROVED");
      expect(await status(s.tx, id)).toBe("APPROVED");
      await s.expectError("CDF_CONFLICT:FORM_NOT_REVIEWED", (tx) => approve(tx, id, "APPROVED"));
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:FORM_NOT_DRAFT", (tx) => save(tx, id, COMMITTEE_FORMATION));
      await s.expectError("CDF_CONFLICT:FORM_FINAL", (tx) => withdraw(tx, id, "Synthetic: too late"));
      const events = await s.tx<{ event_type: string; reason: string | null }[]>`
        select event_type, reason from forms.form_event where instance_id = ${id} order by seq`;
      expect(events.map((e) => e.event_type)).toEqual([
        "CREATED",
        "SAVED",
        "PREPARED",
        "REVIEWED",
        "RETURNED",
        "SAVED",
        "PREPARED",
        "REVIEWED",
        "APPROVED",
      ]);
      expect(events[4]!.reason).toBe("Synthetic: membership list incomplete");
    });
  });

  it("lets a preparer withdraw an unfinished form once, with a reason, and nothing else afterwards", async () => {
    await scenario(async (s) => {
      const id = await evidenceRegisterOnCaseA(s);
      await s.as("lead");
      await s.expectError("CDF_INVALID:reason", (tx) => withdraw(tx, id, "nah"));
      await s.as("grcDirector"); // can see the instance, has no FORM_PREPARE
      await s.expectError("CDF_FORBIDDEN", (tx) => withdraw(tx, id, "Synthetic: not mine"));
      await s.as("investigatorB");
      await s.expectError("CDF_NOT_FOUND", (tx) => withdraw(tx, id, "Synthetic: not visible"));
      await s.as("investigatorA");
      await withdraw(s.tx, id, "Synthetic: opened by mistake");
      expect(await status(s.tx, id)).toBe("WITHDRAWN");
      await s.expectError("CDF_CONFLICT:FORM_FINAL", (tx) => withdraw(tx, id, "Synthetic: again"));
      await s.expectError("CDF_CONFLICT:FORM_NOT_DRAFT", (tx) => save(tx, id, EVIDENCE_REGISTER));
      await s.expectError("CDF_CONFLICT:FORM_NOT_DRAFT", (tx) => prepare(tx, id));
      // A withdrawn instance keeps its history and the case can start a fresh one with the next number.
      expect(await countRows(s.tx, "form_instance_version", id)).toBe(1);
      const next = await start(s.tx, caseA, "WB-FRM-11");
      const [nos] = await s.tx<{ a: number; b: number }[]>`
        select (select instance_no from forms.form_instance where id = ${id}) as a,
               (select instance_no from forms.form_instance where id = ${next}) as b`;
      expect(nos!.b).toBe(nos!.a + 1);
    });
  });
});

describe("form access audit", () => {
  it("records FORM_VIEWED for permitted opens and a SECURITY denial for everyone else", async () => {
    await scenario(async (s) => {
      const id = await evidenceRegisterOnCaseA(s);
      await s.as("lead");
      expect(await open(s.tx, id)).toBe(true);
      await s.as("committeeChair"); // case visible through the COMMITTEE grant, form not entitled
      expect(await open(s.tx, id)).toBe(false);
      await s.as("investigatorB");
      expect(await open(s.tx, id)).toBe(false);
      expect(await open(s.tx, randomUUID())).toBe(false);
      await s.as("soc");
      const denials = await s.tx<
        {
          outcome: string;
          category: string;
          meta: { target_exists: boolean; case_visible: boolean | null };
        }[]
      >`
        select outcome, category, metadata as meta from audit.audit_event
        where action = 'FORM_ACCESS_DENIED' and object_id = ${id} order by seq`;
      expect(denials.map((d) => [d.category, d.outcome, d.meta.target_exists, d.meta.case_visible])).toEqual([
        ["SECURITY", "DENIED", true, true],
        ["SECURITY", "DENIED", true, false],
      ]);
      await s.as("internalAudit");
      const viewed = await s.tx<{ actor_id: string; case_id: string }[]>`
        select actor_id, case_id from audit.audit_event where action = 'FORM_VIEWED' and object_id = ${id}`;
      expect(viewed).toEqual([{ actor_id: USERS.lead, case_id: caseA }]);
    });
  });

  it("keeps form content out of the audit ledger and the chain intact", async () => {
    await scenario(async (s) => {
      const id = await evidenceRegisterOnCaseA(s);
      await prepare(s.tx, id);
      await s.as("lead");
      await review(s.tx, id, "REVIEWED");
      await s.as("internalAudit");
      const rows = await s.tx<{ action: string; reason: string | null; metadata: Record<string, unknown> }[]>`
        select action, reason, metadata from audit.audit_event where object_id = ${id} order by seq`;
      expect(rows.map((r) => r.action)).toEqual([
        "FORM_STARTED",
        "FORM_SAVED",
        "FORM_PREPARED",
        "FORM_REVIEWED",
      ]);
      for (const r of rows) {
        const text = JSON.stringify(r.metadata) + (r.reason ?? "");
        expect(text, r.action).not.toContain(MARKER);
        expect(text, r.action).not.toContain("مكتملة");
        expect(r.metadata).toMatchObject({ form_code: "WB-FRM-11", instance_no: expect.any(Number) });
      }
      expect(rows[1]!.metadata).toMatchObject({
        version_no: 1,
        content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const [chain] = await s.tx<{ n: number }[]>`select count(*)::int as n from api.verify_audit_chain()`;
      expect(chain!.n).toBe(0);
    });
  });
});

describe("form integrity", () => {
  it("denies direct writes to application roles", async () => {
    await scenario(async (s) => {
      const id = await evidenceRegisterOnCaseA(s);
      await s.as("caseManager");
      await s.expectError(
        "permission denied",
        (
          tx,
        ) => tx`insert into forms.form_instance (case_id, form_code, definition_version_id, instance_no, classification, created_by)
              select ${caseA}, 'WB-FRM-11', current_version_id, 99, 'CONFIDENTIAL', ${USERS.caseManager}
              from forms.form_definition where code = 'WB-FRM-11'`,
      );
      await s.expectError(
        "permission denied",
        (tx) => tx`update forms.form_instance set status = 'APPROVED' where id = ${id}`,
      );
      await s.expectError(
        "permission denied",
        (tx) => tx`update forms.form_instance_version set data = '{}'::jsonb`,
      );
      await s.expectError("permission denied", (tx) => tx`delete from forms.form_event`);
      await s.expectError(
        "permission denied",
        (tx) => tx`update forms.form_definition set is_enabled = false`,
      );
      await s.expectError("permission denied", (tx) => tx`delete from forms.form_entitlement`);
      await s.expectError(
        "permission denied",
        (tx) =>
          tx`insert into forms.form_entitlement (form_code, role_code, action, source) values ('WB-FRM-11', 'COMMITTEE_MEMBER', 'VIEW', 'DERIVED')`,
      );
    });
  });

  it("rejects edits and deletes of versions, events, instances and final forms for the owner too", async () => {
    class Rollback extends Error {}
    await admin
      .begin(async (tx) => {
        await tx`select set_config('cdf.request_id', ${randomUUID()}, true)`;
        const asUser = (user: UserKey) =>
          tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USERS[user], role: "authenticated" })}, true)`;
        await asUser("investigatorA");
        const id = await start(tx as unknown as Tx, caseA, "WB-FRM-11");
        const v = await save(tx as unknown as Tx, id, EVIDENCE_REGISTER);
        const expectError = async (pattern: RegExp, run: () => Promise<unknown>) => {
          let message = "";
          try {
            await tx.savepoint(async () => {
              await run();
            });
          } catch (e) {
            message = (e as Error).message;
          }
          expect(message).toMatch(pattern);
        };
        await expectError(
          /append-only/,
          () => tx`update forms.form_instance_version set data = '{}'::jsonb where id = ${v.versionId}`,
        );
        await expectError(
          /append-only/,
          () => tx`delete from forms.form_instance_version where id = ${v.versionId}`,
        );
        await expectError(
          /append-only/,
          () => tx`update forms.form_event set reason = 'x' where instance_id = ${id}`,
        );
        await expectError(/append-only/, () => tx`delete from forms.form_event where instance_id = ${id}`);
        await expectError(/append-only/, () => tx`delete from forms.form_instance where id = ${id}`);
        await expectError(/append-only/, () => tx`truncate forms.form_event`);
        await expectError(
          /identity fields are immutable/,
          () => tx`update forms.form_instance set case_id = ${caseB} where id = ${id}`,
        );
        await expectError(
          /identity fields are immutable/,
          () => tx`update forms.form_instance set instance_no = 77 where id = ${id}`,
        );
        // Once final, not even the owner can change the row.
        await prepare(tx as unknown as Tx, id);
        await asUser("lead");
        await review(tx as unknown as Tx, id, "REVIEWED");
        await expectError(
          /is final/,
          () => tx`update forms.form_instance set status = 'DRAFT' where id = ${id}`,
        );
        await expectError(
          /is final/,
          () => tx`update forms.form_instance set updated_at = now() where id = ${id}`,
        );
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
  });

  it("ships every forms table with RLS enabled and no write grants to application roles", async () => {
    const tables = await admin<{ name: string; rls: boolean; forced: boolean }[]>`
      select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'forms' and c.relkind = 'r' order by c.relname`;
    expect(tables.map((t) => t.name)).toEqual([
      "form_definition",
      "form_definition_version",
      "form_entitlement",
      "form_event",
      "form_field_definition",
      "form_instance",
      "form_instance_version",
    ]);
    for (const t of tables) expect(t.rls, t.name).toBe(true);
    const writes = await admin<{ table: string; grantee: string; privilege: string }[]>`
      select table_name as "table", grantee, privilege_type as privilege from information_schema.role_table_grants
      where table_schema = 'forms' and grantee in ('anon', 'authenticated', 'cdf_bff', 'cdf_portal')
        and privilege_type <> 'SELECT'`;
    expect(writes).toEqual([]);
    const anonReads = await admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants where table_schema = 'forms' and grantee = 'anon'`;
    expect(anonReads[0]!.n).toBe(0);
  });
});
