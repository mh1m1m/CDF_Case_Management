// Business architecture rebase, migration 2110 (ADR-047; CDF-252): the committee-proceeding continuity workbook
// (BCP-C1). The coordinator's rulings of 2026-10-17 (F1: the secretary imports by seat, no role permission added, plus
// the DEC-F30 registry entry; F3: 09_MEETINGS and 11_CONFLICTS import, 10_ATTENDANCE stays recorded only), the owner's
// decision on AMB-201 (F2: a committee workbook commits only through its official record, migration 2115) and AGENT-09's
// items R1 to R5 are each pinned here. Every step runs through the api.* commands as `authenticated`; the owner
// connection only backdates the referral (the outage came after the case reached the committee), forces an approval on
// a revoked workbook to probe the table's guard, adds registry fixtures 2040 shaped, reads the ledger and the outbox,
// and probes the internal helpers. Since 2115 a committee workbook commits through its official record
// (tests/support/committee-record.ts).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  USERS,
  admin,
  caseId,
  ownerScenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import { IC_SEATS, REASON, committeeIds, refer, seat } from "../support/committee";
import { commitThroughRecord } from "../support/committee-record";

type Tx = Scenario["tx"];

const SHA = "c".repeat(64);
const WB = "BCP-DEMO-C-0001";
const WHY = "Synthetic: resolved during the import review.";
const MARK = "unique-paper-conflict-marker";

let caseA: string, caseB: string, ic: string;
const EMAIL: Record<string, string> = {};
beforeAll(async () => {
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
  ({ ic } = await committeeIds());
  const users = await admin<{ id: string; email: string }[]>`select id, email from iam.user_profile`;
  for (const [key, id] of Object.entries(USERS)) EMAIL[key] = users.find((u) => u.id === id)!.email;
});

/** The transaction's clock as the ISO strings a workbook would hold. The proceeding is referred three days ago. */
interface Times {
  beforeReferral: string;
  earlyStart: string;
  earlyEnd: string;
  beforeFrom: string;
  from: string;
  heldStart: string;
  heldEnd: string;
  to: string;
  afterTo: string;
  future: string;
}

async function times(s: OwnerScenario): Promise<Times> {
  await s.asOwner();
  const iso = (expr: string) => `to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const [r] = await s.tx.unsafe<Times[]>(
    `select ${iso("now() - interval '4 days'")} as "beforeReferral",
            ${iso("now() - interval '3 days 2 hours'")} as "earlyStart",
            ${iso("now() - interval '3 days 1 hour'")} as "earlyEnd",
            ${iso("now() - interval '2 days 1 hour'")} as "beforeFrom",
            ${iso("now() - interval '2 days'")} as "from",
            ${iso("now() - interval '2 days' + interval '1 hour'")} as "heldStart",
            ${iso("now() - interval '2 days' + interval '3 hours'")} as "heldEnd",
            ${iso("now() - interval '1 day'")} as "to",
            ${iso("now() - interval '12 hours'")} as "afterTo",
            ${iso("now() + interval '1 day'")} as future`,
  );
  return r!;
}

/** Owner fixture: the case reached the committee three days ago, before the outage the workbook covers. */
async function backdate(s: OwnerScenario, cp: string) {
  await s.asOwner();
  await s.tx`alter table committee.committee_proceeding disable trigger committee_proceeding_protect`;
  await s.tx`update committee.committee_proceeding set referred_at = now() - interval '3 days' where id = ${cp}`;
  await s.tx`alter table committee.committee_proceeding enable trigger committee_proceeding_protect`;
}

async function authorize(s: Scenario, user: UserKey, cp: string): Promise<string> {
  await s.as("platformAdmin");
  const [r] = await s.tx<{ id: string }[]>`
    select api.authorize_committee_continuity_operator(${USERS[user]}, ${cp}, 'BCP-AUTH-DEMO-C1', ${REASON}) as id`;
  return r!.id;
}

/** IC seated (chair, secretary, legal, legalB, lead unless `seats`), case 0002 referred to it three days ago, and the
 *  secretary holding a registry entry for that proceeding unless `authorize` is false. */
async function proceeding(
  s: OwnerScenario,
  opts: { authorize?: boolean; seats?: [UserKey, string][] } = {},
): Promise<string> {
  await seat(s, ic, opts.seats ?? IC_SEATS);
  const cp = await refer(s, ic, caseB);
  await backdate(s, cp);
  if (opts.authorize ?? true) await authorize(s, "committeeSecretary", cp);
  return cp;
}

function control(t: Times, cp: string, extra: Record<string, string | undefined> = {}) {
  const c: Record<string, string | undefined> = {
    TEMPLATE_VERSION: "BCP-C1",
    WORKBOOK_ID: WB,
    COMMITTEE_PROCEEDING_ID: cp,
    COMMITTEE_CODE: "IC",
    OFFLINE_FROM: t.from,
    OFFLINE_TO: t.to,
    PREPARED_BY: EMAIL.committeeChair!,
    ...extra,
  };
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined));
}

function row(
  sheet: string,
  n: number,
  key: string,
  at: string,
  cells: Record<string, string>,
  by: UserKey = "committeeSecretary",
) {
  return {
    sheet,
    row_number: n,
    cells: { ROW_ID: key, ORIGINAL_EVENT_AT: at, RECORDED_OFFLINE_BY: EMAIL[by]!, ...cells },
    has_formula: false,
  };
}

const meetingRow = (t: Times, n: number, key: string, cells: Record<string, string> = {}) =>
  row("09_MEETINGS", n, key, t.heldStart, {
    PURPOSE: "DELIBERATION",
    MODE: "IN_PERSON",
    LOCATION: "Meeting room (synthetic)",
    HELD_START: t.heldStart,
    HELD_END: t.heldEnd,
    PAPER_MINUTES_REFERENCE: "PAPER-MIN-DEMO-0001",
    REASON: "Synthetic: the committee met on paper during the outage.",
    ...cells,
  });

const conflictRow = (t: Times, n: number, key: string, meetingRef: string, about: UserKey) =>
  row("11_CONFLICTS", n, key, t.heldStart, {
    MEETING_REF: meetingRef,
    PARTICIPANT: EMAIL[about]!,
    REASON: `Synthetic: a possible conflict noted on paper (${MARK}).`,
  });

const stageCall = (ctl: Record<string, unknown>, rows: unknown[]) => (tx: Tx) =>
  tx`select api.stage_bcp_import(${tx.json(ctl as never)}::jsonb, ${SHA}, ${tx.json(rows as never)}::jsonb)`;

async function stage(
  s: Scenario,
  ctl: Record<string, unknown>,
  rows: unknown[],
  actor: UserKey = "committeeSecretary",
): Promise<string> {
  await s.as(actor);
  const [r] = await s.tx<{ id: string }[]>`
    select api.stage_bcp_import(${s.tx.json(ctl as never)}::jsonb, ${SHA}, ${s.tx.json(rows as never)}::jsonb) as id`;
  return r!.id;
}

interface StagedRow {
  id: string;
  row_key: string | null;
  state: string;
  detail: string | null;
}

async function staged(s: Scenario, batch: string): Promise<Record<string, StagedRow>> {
  const list = await s.tx<StagedRow[]>`
    select id, row_key, state, detail from exchange.bcp_import_row where batch_id = ${batch}
    order by sheet_code, row_number`;
  return Object.fromEntries(list.map((r) => [r.row_key ?? r.id, r]));
}

const states = (rows: Record<string, StagedRow>) =>
  Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, [r.state, r.detail]]));

async function preview(s: Scenario, batch: string): Promise<{ hash: string; clean: boolean }> {
  const [r] = await s.tx<
    { p: { hash: string; clean: boolean } }[]
  >`select api.preview_bcp_import(${batch}) as p`;
  return r!.p;
}

const resolve = (s: Scenario, rowId: string, resolution: string) =>
  s.tx`select api.resolve_bcp_row(${rowId}, ${resolution}, ${WHY})`;

interface BatchView {
  scope: string;
  committee_proceeding_id: string | null;
  workbook_revoked: boolean;
  official_record_required: boolean;
  capabilities: Record<string, boolean>;
}

async function view(s: Scenario, batch: string): Promise<BatchView> {
  const [r] = await s.tx<{ v: BatchView }[]>`select api.bcp_import_batch_view(${batch}) as v`;
  return r!.v;
}

async function sees(s: Scenario, user: UserKey, batch: string): Promise<boolean> {
  await s.as(user);
  return (await s.tx`select id from exchange.bcp_import_batch where id = ${batch}`).length === 1;
}

/** Owner fixture: an approval forced onto a workbook, to show the table refuses it once the workbook is revoked. A
 *  committee workbook is approved only through its official record (2115). */
const simulateApproval = (tx: Tx, batch: string) =>
  tx`update exchange.bcp_import_batch
     set status = 'APPROVED', submitted_hash = exchange.bcp_batch_hash(id), submitted_at = now(),
         decided_by = ${USERS.committeeChair}, decided_at = now(),
         decision_reason = 'Synthetic: approval simulated for the test (official record not built).'
     where id = ${batch}`;

const revokeCall =
  (cp: string, workbook = WB) =>
  (tx: Tx) =>
    tx`select api.revoke_committee_bcp_workbook(${cp}, ${workbook}, 'INC-DEMO-2110', ${REASON})`;

describe("committee workbook: who imports it (F1, DEC-F30, R1, R5)", () => {
  it("R1: a committee registry entry is authorized by the continuity administrator, never for themselves, once, and only for a secretary of the open proceeding; the case path is unchanged", async () => {
    await ownerScenario(async (s) => {
      const cp = await proceeding(s, { authorize: false });
      const call = (user: string, target: string) => (tx: Tx) =>
        tx`select api.authorize_committee_continuity_operator(${user}, ${target}, 'BCP-AUTH-DEMO-C1', ${REASON})`;
      await s.as("caseManager");
      await s.expectError("CDF_FORBIDDEN", call(USERS.committeeSecretary, cp));
      await s.as("platformAdmin");
      await s.expectError("CDF_FORBIDDEN", call(USERS.platformAdmin, cp));
      await s.expectError("CDF_INVALID:user_id", call(USERS.revoked, cp));
      // One refusal whether the user holds no secretary seat or the proceeding is unknown: the administrator sees no
      // proceeding and learns nothing more of it.
      for (const user of ["legal", "committeeChair", "caseManager"] as const)
        await s.expectError("CDF_CONFLICT:OPERATOR_NOT_SECRETARY", call(USERS[user], cp));
      await s.expectError(
        "CDF_CONFLICT:OPERATOR_NOT_SECRETARY",
        call(USERS.committeeSecretary, randomUUID()),
      );
      const id = await authorize(s, "committeeSecretary", cp);
      await s.expectError("CDF_CONFLICT:ALREADY_AUTHORIZED", call(USERS.committeeSecretary, cp));
      // api.authorize_continuity_operator is as 2040 built: a CASE entry still needs BCP_IMPORT, which no secretary
      // holds (the ADR-034 §10 grant waits for 2160).
      await s.expectError(
        "CDF_CONFLICT:OPERATOR_LACKS_PERMISSION",
        (tx) =>
          tx`select api.authorize_continuity_operator(${USERS.committeeSecretary}, 'BCP-AUTH-DEMO-C2', ${REASON})`,
      );
      await s.asOwner();
      expect(
        await s.tx`select scope, committee_proceeding_id from exchange.bcp_continuity_operator where id = ${id}`,
      ).toEqual([{ scope: "COMMITTEE_PROCEEDING", committee_proceeding_id: cp }]);
      expect(
        await s.tx`select category, case_id, metadata from audit.audit_event
                   where action = 'BCP_OPERATOR_AUTHORIZED' and object_id = ${id}`,
      ).toEqual([
        {
          category: "ADMIN",
          case_id: null,
          metadata: {
            user_id: USERS.committeeSecretary,
            scope: "COMMITTEE_PROCEEDING",
            committee_proceeding_id: cp,
          },
        },
      ]);
      // The importer sees their own entry; the case team does not.
      await s.as("committeeSecretary");
      expect(await s.tx`select id from exchange.bcp_continuity_operator where id = ${id}`).toHaveLength(1);
      await s.as("caseManager");
      expect(await s.tx`select id from exchange.bcp_continuity_operator where id = ${id}`).toEqual([]);
    });
  });

  it("R1: a committee entry grants nothing outside its proceeding and nothing on a case workbook; a case entry grants nothing on a committee workbook; losing the entry stops the importer", async () => {
    await ownerScenario(async (s) => {
      const t = await times(s);
      const cp = await proceeding(s, { authorize: false });
      const rows = [meetingRow(t, 3, "BCP-M1")];
      // No entry: refused, though the secretary schedules meetings online.
      await s.as("committeeSecretary");
      await s.expectError("CDF_FORBIDDEN", stageCall(control(t, cp), rows));
      // A CASE entry, as 2040 builds them (owner fixture), does not satisfy a committee workbook.
      await s.asOwner();
      const [caseEntry] = await s.tx<{ id: string }[]>`
        insert into exchange.bcp_continuity_operator (user_id, authorization_reference, reason, authorized_by)
        values (${USERS.committeeSecretary}, 'BCP-AUTH-DEMO-CASE', 'Synthetic: a case-scope entry.', ${USERS.platformAdmin})
        returning id`;
      await s.as("committeeSecretary");
      await s.expectError("CDF_FORBIDDEN", stageCall(control(t, cp), rows));
      await s.as("platformAdmin");
      await s.tx`select api.revoke_continuity_operator(${caseEntry!.id}, ${REASON})`;

      const entry = await authorize(s, "committeeSecretary", cp);
      const batch = await stage(s, control(t, cp), rows);
      expect((await view(s, batch)).capabilities.may_preview).toBe(true);

      // Another proceeding of the same committee: the entry does not reach it.
      const cp2 = await refer(s, ic, caseA);
      await backdate(s, cp2);
      await s.as("committeeSecretary");
      await s.expectError("CDF_FORBIDDEN", stageCall(control(t, cp2), rows));
      await s.expectError("CDF_FORBIDDEN", revokeCall(cp2));

      // Probed on the owner connection: the committee entry is no case entry, so a case batch is refused at the table
      // for its holder; a case operator is no committee importer; a member holding an entry is no importer either.
      await s.asOwner();
      expect(await s.tx`select exchange.is_continuity_operator(${USERS.committeeSecretary}) as v`).toEqual([
        { v: false },
      ]);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`insert into exchange.bcp_import_batch (case_id, template_version, workbook_id, file_sha256, control,
               offline_from, prepared_by, imported_by)
             values (${caseB}, 'BCP-1', 'BCP-DEMO-C-CASE', ${SHA}, '{}'::jsonb, now() - interval '1 day',
               ${USERS.committeeChair}, ${USERS.committeeSecretary})`,
      );
      expect(await s.tx`select exchange.is_continuity_operator(${USERS.caseManager}) as v`).toEqual([
        { v: true },
      ]);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`insert into exchange.bcp_import_batch (case_id, template_version, workbook_id, file_sha256, control,
               offline_from, offline_to, prepared_by, imported_by, scope, committee_proceeding_id)
             values (${caseB}, 'BCP-C1', 'BCP-DEMO-C-CASEOP', ${SHA}, '{}'::jsonb, now() - interval '2 days',
               now() - interval '1 day', ${USERS.committeeChair}, ${USERS.caseManager}, 'COMMITTEE_PROCEEDING', ${cp})`,
      );
      await s.tx`insert into exchange.bcp_continuity_operator (user_id, authorization_reference, reason, authorized_by,
                   scope, committee_proceeding_id)
                 values (${USERS.legal}, 'BCP-AUTH-DEMO-MEMBER', 'Synthetic: an entry for a member.', ${USERS.platformAdmin},
                   'COMMITTEE_PROCEEDING', ${cp})`;
      expect(
        await s.tx`select exchange.bcp_committee_importer(${USERS.legal}, ${cp}) as member,
                          exchange.bcp_committee_importer(${USERS.committeeSecretary}, ${cp}) as secretary,
                          exchange.bcp_committee_importer(${USERS.committeeSecretary}, ${cp2}) as other`,
      ).toEqual([{ member: false, secretary: true, other: false }]);

      // Revoking the entry stops the importer at once: the batch is no longer theirs to see or work.
      await s.as("platformAdmin");
      await s.tx`select api.revoke_continuity_operator(${entry}, ${REASON})`;
      expect(await sees(s, "committeeSecretary", batch)).toBe(false);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.preview_bcp_import(${batch})`);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.cancel_bcp_import(${batch}, ${REASON})`);
    });
  });

  it("R5: an external account is never authorized, never prepares or records a committee workbook, and never imports or approves one", async () => {
    await ownerScenario(async (s) => {
      const t = await times(s);
      const cp = await proceeding(s, { seats: IC_SEATS.filter(([u]) => u !== "legalB") });
      await s.as("platformAdmin");
      await s.tx`select api.flag_external_counsel_account(${USERS.legalB}, 'ENG-DEMO-2110-0001', ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:OPERATOR_EXTERNAL",
        (tx) =>
          tx`select api.authorize_committee_continuity_operator(${USERS.legalB}, ${cp}, 'BCP-AUTH-DEMO-EXT', ${REASON})`,
      );
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_INVALID:PREPARED_BY",
        stageCall(control(t, cp, { PREPARED_BY: EMAIL.legalB }), []),
      );
      const batch = await stage(s, control(t, cp), [
        meetingRow(t, 3, "BCP-M1"),
        row(
          "10_ATTENDANCE",
          3,
          "BCP-T1",
          t.heldStart,
          { DETAILS: "Synthetic: recorded by counsel." },
          "legalB",
        ),
      ]);
      expect(states(await staged(s, batch))).toEqual({
        "BCP-M1": ["NEW", null],
        "BCP-T1": ["INVALID", "RECORDED_OFFLINE_BY"],
      });
      // Even holding a registry entry (owner fixture), an external account is no importer, and never an approver.
      await s.asOwner();
      await s.tx`insert into exchange.bcp_continuity_operator (user_id, authorization_reference, reason, authorized_by,
                   scope, committee_proceeding_id)
                 values (${USERS.legalB}, 'BCP-AUTH-DEMO-EXT', 'Synthetic: an entry for counsel.', ${USERS.platformAdmin},
                   'COMMITTEE_PROCEEDING', ${cp})`;
      expect(
        await s.tx`select exchange.bcp_committee_importer(${USERS.legalB}, ${cp}) as importer,
                          exchange.bcp_approver_excluded(${batch}, ${USERS.legalB}) as external,
                          exchange.bcp_approver_excluded(${batch}, ${USERS.lead}) as member`,
      ).toEqual([{ importer: false, external: true, member: false }]);
    });
  });
});

describe("committee workbook: not submitted before its official record (AMB-201 owner decision) and who sees it (D4)", () => {
  it("a committee workbook is never submitted before its official record exists, nobody approves it, and none submitted could be approved", async () => {
    await ownerScenario(async (s) => {
      // The superseded F2 default left no setting behind.
      await s.asOwner();
      expect(
        await s.tx`select key from config.setting where key = 'BCP_COMMITTEE_WORKBOOK_APPROVER'`,
      ).toEqual([]);

      const t = await times(s);
      const cp = await proceeding(s);
      const batch = await stage(s, control(t, cp), [meetingRow(t, 3, "BCP-M1")]);
      const p = await preview(s, batch);
      expect(p.clean).toBe(true);
      const v = await view(s, batch);
      expect(v).toMatchObject({
        scope: "COMMITTEE_PROCEEDING",
        committee_proceeding_id: cp,
        official_record_required: true,
      });
      expect(v.capabilities).toMatchObject({ may_preview: true, may_submit: false, may_cancel: true });
      await s.expectError(
        "CDF_CONFLICT:OFFICIAL_RECORD_REQUIRED",
        (tx) => tx`select api.submit_bcp_import(${batch}, ${p.hash})`,
      );
      // Clean, resolved and previewed: the refusal is the record, nothing else.
      await s.asOwner();
      expect(
        await s.tx`select status, submitted_at from exchange.bcp_import_batch where id = ${batch}`,
      ).toEqual([{ status: "STAGED", submitted_at: null }]);
      expect(await s.tx`select count(*)::int as n from exchange.bcp_eligible_approvers(${batch})`).toEqual([
        { n: 0 },
      ]);

      // The chair and deputy of the proceeding approve only through the official record (not built here), and the
      // case workbook's approvers never reach a committee one.
      const others: UserKey[] = [
        "committeeChair",
        "legal",
        "lead",
        "caseManager",
        "grcDirector",
        "internalAudit",
      ];
      for (const u of others) expect(await sees(s, u, batch), u).toBe(false);
      // Submitted anyway (owner fixture): still nobody can see or decide it.
      await s.asOwner();
      await s.tx`update exchange.bcp_import_batch
                 set status = 'SUBMITTED', submitted_hash = exchange.bcp_batch_hash(id), submitted_at = now()
                 where id = ${batch}`;
      expect(
        await s.tx`select count(*)::int as n from notify.outbox where object_id = ${batch}`,
        "nobody is asked to approve",
      ).toEqual([{ n: 0 }]);
      const h = (
        await s.tx<
          { h: string }[]
        >`select submitted_hash as h from exchange.bcp_import_batch where id = ${batch}`
      )[0]!.h;
      for (const u of ["committeeChair", "grcDirector", "caseManager"] as const) {
        await s.as(u);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.decide_bcp_import(${batch}, 'APPROVE', ${REASON}, ${h})`,
        );
      }
      // The one person who sees it is told why: a committee workbook is never decided on this path.
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:OFFICIAL_RECORD_REQUIRED",
        (tx) => tx`select api.decide_bcp_import(${batch}, 'APPROVE', ${REASON}, ${h})`,
      );
    });
  });

  it("D4: the case team and the case workbook's approvers see nothing of a committee workbook, in the tables or the ledger; a workbook id in one namespace never collides with the other", async () => {
    await ownerScenario(async (s) => {
      const t = await times(s);
      const cp = await proceeding(s);
      const batch = await stage(s, control(t, cp), [
        meetingRow(t, 3, "BCP-M1"),
        conflictRow(t, 3, "BCP-K1", "BCP-M1", "legal"),
      ]);
      await preview(s, batch);
      for (const u of ["caseManager", "grcDirector", "investigatorB", "committeeChair", "legal"] as const) {
        expect(await sees(s, u, batch), u).toBe(false);
        expect(await s.tx`select id from exchange.bcp_import_row where batch_id = ${batch}`, u).toEqual([]);
        expect(
          await s.tx`select seq from audit.audit_event where object_id = ${batch} or metadata ->> 'batch_id' = ${batch}`,
          u,
        ).toEqual([]);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.bcp_import_batch_view(${batch})`);
      }
      // The batch's events name the proceeding and no case.
      await s.asOwner();
      const events = await s.tx<{ action: string; case_id: string | null; scope: string | null }[]>`
        select action, case_id, metadata ->> 'scope' as scope from audit.audit_event
        where object_id = ${batch} or metadata ->> 'batch_id' = ${batch} order by seq`;
      expect(events.map((e) => e.action)).toEqual(["BCP_IMPORT_STAGED", "BCP_IMPORT_PREVIEWED"]);
      for (const e of events) expect(e).toMatchObject({ case_id: null, scope: "COMMITTEE_PROCEEDING" });

      // The case team stages and revokes a case workbook of the same id on the same case: no BATCH_OPEN, no
      // WORKBOOK_REVOKED on the committee's side, nothing learned of it.
      const [c] = await s.tx.unsafe<{ number: string; created: string }[]>(
        `select case_number as number,
                to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created
         from case_mgmt.case_record where id = $1`,
        [caseB],
      );
      const caseBatch = await stage(
        s,
        {
          TEMPLATE_VERSION: "BCP-1",
          WORKBOOK_ID: WB,
          CASE_ID: caseB,
          CASE_NUMBER: c!.number,
          OFFLINE_FROM: c!.created,
          PREPARED_BY: EMAIL.investigatorB!,
        },
        [
          row(
            "05_SUBJECTS",
            3,
            "BCP-S1",
            c!.created,
            { DISPLAY_LABEL: "Employee Omega (synthetic)", SUBJECT_CATEGORY: "EMPLOYEE" },
            "investigatorB",
          ),
        ],
        "caseManager",
      );
      await s.tx`select api.revoke_bcp_workbook(${caseB}, ${WB}, 'INC-DEMO-2110-CASE', ${REASON})`;
      expect(await sees(s, "caseManager", caseBatch)).toBe(true);
      await s.as("committeeSecretary");
      expect(await sees(s, "committeeSecretary", caseBatch)).toBe(false);
      expect((await view(s, batch)).workbook_revoked).toBe(false);
      expect(await s.tx`select id from exchange.bcp_workbook_revocation`).toEqual([]);
    });
  });
});

describe("committee workbook: what it imports (AMB-201, F3, R2, R4, AMB-210)", () => {
  it("R2: 09_MEETINGS stages only a meeting that has ended, inside the offline window and after the referral; the notice rule is skipped only on the import path", async () => {
    await ownerScenario(async (s) => {
      const t = await times(s);
      const cp = await proceeding(s);
      const batch = await stage(s, control(t, cp), [
        meetingRow(t, 3, "BCP-M1"),
        meetingRow(t, 4, "BCP-M2", { HELD_END: t.future }),
        meetingRow(t, 5, "BCP-M3", { HELD_START: t.beforeFrom }),
        meetingRow(t, 6, "BCP-M4", { HELD_END: t.afterTo }),
        meetingRow(t, 7, "BCP-M5", { HELD_END: t.heldStart }),
      ]);
      expect(states(await staged(s, batch))).toEqual({
        "BCP-M1": ["NEW", null],
        "BCP-M2": ["INVALID", "HELD_END"],
        "BCP-M3": ["INVALID", "HELD_START"],
        "BCP-M4": ["INVALID", "HELD_END"],
        "BCP-M5": ["INVALID", "HELD_END"],
      });
      // A window that opens before the referral still imports no meeting held before the case reached the committee.
      const early = await stage(
        s,
        control(t, cp, { WORKBOOK_ID: "BCP-DEMO-C-0002", OFFLINE_FROM: t.beforeReferral }),
        [meetingRow(t, 3, "BCP-M6", { HELD_START: t.earlyStart, HELD_END: t.earlyEnd })],
      );
      expect(states(await staged(s, early))).toEqual({ "BCP-M6": ["INVALID", "HELD_START"] });

      // The import's own helper is not callable, and the online commands take no parameter or flag that skips the
      // notice rule.
      await s.as("committeeSecretary");
      await s.expectError(
        "permission denied",
        (tx) =>
          tx`select exchange.bcp_record_offline_meeting(null::exchange.bcp_import_batch, 'DELIBERATION', 'IN_PERSON',
               'Meeting room (synthetic)', null, now() - interval '2 days', now() - interval '1 day',
               'PAPER-MIN-DEMO-0002', ${REASON})`,
      );
      await s.asOwner();
      const sigs = await s.tx<{ f: string; n: number; args: string }[]>`
        select p.oid::regproc::text as f, p.pronargs::int as n, pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p
        where p.oid in ('api.schedule_meeting'::regproc, 'api.schedule_emergency_meeting'::regproc,
                        'committee.insert_meeting'::regproc)
        order by 1`;
      expect(sigs.map((x) => [x.f, x.n])).toEqual([
        ["api.schedule_emergency_meeting", 9],
        ["api.schedule_meeting", 8],
        ["committee.insert_meeting", 9],
      ]);
      for (const x of sigs) expect(x.args).not.toMatch(/held|offline|notice|skip|bcp/i);
      // The table keeps it too: a meeting marked held offline must have ended when it was recorded, and is never an
      // emergency.
      await s.expectError(
        'new row for relation "meeting" violates check constraint',
        (tx) =>
          tx`insert into committee.meeting (committee_proceeding_id, case_id, sequence_no, purpose, mode, location,
               scheduled_start, scheduled_end, scheduled_by, held_offline, paper_minutes_reference)
             values (${cp}, ${caseB}, 99, 'DELIBERATION', 'IN_PERSON', 'Meeting room (synthetic)',
               now() + interval '1 hour', now() + interval '2 hours', ${USERS.committeeSecretary}, true,
               'PAPER-MIN-DEMO-0099')`,
      );
    });
  });

  it("F3, R4, AMB-210: a committed committee workbook records the meeting held offline and raises the paper-noted conflict as the secretary; it records no attendance, confirms no conflict, and sends only restore notices", async () => {
    await ownerScenario(async (s) => {
      const t = await times(s);
      const cp = await proceeding(s);
      // Prepared by a member (the chair approves the official record, so the chair did not prepare it).
      const batch = await stage(s, control(t, cp, { PREPARED_BY: EMAIL.lead }), [
        meetingRow(t, 3, "BCP-M1"),
        row("10_ATTENDANCE", 3, "BCP-T1", t.heldStart, {
          DETAILS: "Synthetic: all members present on paper.",
        }),
        conflictRow(t, 3, "BCP-K1", "BCP-M1", "legal"),
        conflictRow(t, 4, "BCP-K2", "BCP-M1", "committeeSecretary"),
        conflictRow(t, 5, "BCP-K3", "BCP-M1", "employee"),
        row("12_VOTES", 3, "BCP-V1", t.heldStart, { DETAILS: "Synthetic: a vote taken on paper." }),
      ]);
      const r = await staged(s, batch);
      // One's own conflict is declared, never raised (OWN_CONFLICT); a conflict is raised only about a member of the
      // proceeding (PARTICIPANT); attendance and votes are recorded only.
      expect(states(r)).toEqual({
        "BCP-M1": ["NEW", null],
        "BCP-T1": ["UNSUPPORTED", null],
        "BCP-K1": ["NEW", null],
        "BCP-K2": ["INVALID", "OWN_CONFLICT"],
        "BCP-K3": ["INVALID", "PARTICIPANT"],
        "BCP-V1": ["UNSUPPORTED", null],
      });
      await s.expectError(
        "CDF_CONFLICT:RESOLUTION_NOT_ALLOWED",
        (tx) => tx`select api.resolve_bcp_row(${r["BCP-T1"]!.id}, 'IMPORT', ${WHY})`,
      );
      for (const k of ["BCP-T1", "BCP-K2", "BCP-K3", "BCP-V1"]) await resolve(s, r[k]!.id, "SKIP");
      expect((await preview(s, batch)).clean).toBe(true);

      // R4: the subject is kept on the row; they never read it and never approve the batch.
      await s.asOwner();
      expect(
        await s.tx`select row_key, subject_user_id from exchange.bcp_import_row
                   where batch_id = ${batch} and sheet_code = '11_CONFLICTS' order by row_number`,
      ).toEqual([
        { row_key: "BCP-K1", subject_user_id: USERS.legal },
        { row_key: "BCP-K2", subject_user_id: null },
        { row_key: "BCP-K3", subject_user_id: null },
      ]);
      expect(
        await s.tx`select exchange.bcp_approver_excluded(${batch}, ${USERS.legal}) as subject,
                          exchange.bcp_approver_excluded(${batch}, ${USERS.lead}) as preparer,
                          exchange.bcp_approver_excluded(${batch}, ${USERS.committeeSecretary}) as importer,
                          exchange.bcp_approver_excluded(${batch}, ${USERS.committeeChair}) as member`,
      ).toEqual([{ subject: true, preparer: true, importer: true, member: false }]);
      const [policy] = await s.tx<{ qual: string }[]>`
        select qual from pg_policies where schemaname = 'exchange' and policyname = 'bcp_import_row_read'`;
      expect(policy!.qual).toContain("subject_user_id IS DISTINCT FROM authz.current_user_id()");

      // Committed through its official record (2115): signed minutes, the chair's approval, each member's attestation.
      expect((await commitThroughRecord(s, batch)).counts).toMatchObject({ imported: 2, skipped: 4 });

      await s.asOwner();
      const prov = await s.tx<{ sheet_code: string; object_id: string; committee_proceeding_id: string }[]>`
        select sheet_code, object_id, committee_proceeding_id from exchange.bcp_provenance where batch_id = ${batch}
        order by sheet_code, row_key`;
      expect(prov.map((p) => [p.sheet_code, p.committee_proceeding_id])).toEqual([
        ["09_MEETINGS", cp],
        ["11_CONFLICTS", cp],
      ]);
      const meeting = prov[0]!.object_id;
      const concern = prov[1]!.object_id;
      expect(
        await s.tx`select status, held_offline, paper_minutes_reference, is_emergency, scheduled_by,
                          scheduled_start = ${t.heldStart}::text::timestamptz as start_kept,
                          scheduled_end = ${t.heldEnd}::text::timestamptz as end_kept
                   from committee.meeting where id = ${meeting}`,
      ).toEqual([
        {
          status: "SCHEDULED",
          held_offline: true,
          paper_minutes_reference: "PAPER-MIN-DEMO-0001",
          is_emergency: false,
          scheduled_by: USERS.committeeSecretary,
          start_kept: true,
          end_kept: true,
        },
      ]);
      // No attendance and no confirmed conflict: every participant is still to declare, nobody is recorded present,
      // and the raised conflict waits for the online decision (DEC-F04).
      expect(
        await s.tx`select distinct coi_status, attendance from committee.meeting_participant where meeting_id = ${meeting}`,
      ).toEqual([{ coi_status: "PENDING", attendance: "NOT_RECORDED" }]);
      expect(
        await s.tx`select count(*)::int as n from committee.meeting_conflict where meeting_id = ${meeting}`,
      ).toEqual([{ n: 0 }]);
      expect(
        await s.tx`select c.status, c.raised_as, c.raised_by, p.user_id as about
                   from committee.meeting_conflict_concern c
                   join committee.meeting_participant p on p.id = c.participant_id where c.id = ${concern}`,
      ).toEqual([
        { status: "OPEN", raised_as: "SECRETARY", raised_by: USERS.committeeSecretary, about: USERS.legal },
      ]);

      // AMB-210: the imported meeting's invitations are restore notices naming their row. On the fresh meeting every
      // member is still to declare, so nobody can decide BCP-K1 yet and no decision request goes out (as online).
      const notes = await s.tx<{ template_code: string; restored_row_id: string | null; dated: boolean }[]>`
        select template_code, restored_row_id, original_event_at is not null as dated from notify.outbox
        where object_id in (${meeting}, ${concern}) order by template_code`;
      expect(notes.length).toBeGreaterThan(0);
      for (const n of notes)
        expect(n).toEqual({
          template_code: "MEETING_INVITATION",
          restored_row_id: r["BCP-M1"]!.id,
          dated: true,
        });
      // (A paper-noted conflict about a meeting held online is no longer part of a committee workbook: one record
      // covers one meeting, 2115 E1. The restore marker on a mandatory decision request is pinned on the case path in
      // bcp-import.spec.ts.)
      // No sweep reminds anyone of a past meeting that is still SCHEDULED.
      await s.tx`select notify.emit_due_reminders()`;
      expect(
        await s.tx`select count(*)::int as n from notify.outbox where object_id in (${meeting}, ${concern})`,
      ).toEqual([{ n: notes.length }]);

      // The ledger: the batch's events under no case, the meeting under its case as any meeting, and the paper-noted
      // reason nowhere (it stays in the concern row).
      const events = await s.tx<
        { action: string; case_id: string | null; reason: string | null; metadata: unknown }[]
      >`
        select action, case_id, reason, metadata from audit.audit_event
        where object_id in (${batch}, ${meeting}, ${concern}) or metadata ->> 'batch_id' = ${batch} order by seq`;
      expect(events.map((e) => e.action)).toEqual([
        "BCP_IMPORT_STAGED",
        "BCP_IMPORT_ROW_RESOLVED",
        "BCP_IMPORT_ROW_RESOLVED",
        "BCP_IMPORT_ROW_RESOLVED",
        "BCP_IMPORT_ROW_RESOLVED",
        "BCP_IMPORT_PREVIEWED",
        "COMMITTEE_RECORD_OPENED",
        "COMMITTEE_RECORD_ROSTER_DECLARED",
        "OFFICIAL_MINUTES_REGISTERED",
        "OFFICIAL_MINUTES_UPLOADED",
        "OFFICIAL_MINUTES_MARKED_SIGNED",
        "BCP_IMPORT_SUBMITTED",
        "COMMITTEE_RECORD_SUBMITTED",
        "CHAIR_APPROVED_IMPORTED_RECORD",
        "MEMBER_ATTESTED_IMPORTED_RECORD",
        "MEMBER_ATTESTED_IMPORTED_RECORD",
        "MEMBER_ATTESTED_IMPORTED_RECORD",
        "WORKBOOK_READY_TO_COMMIT",
        "MEETING_RECORDED_OFFLINE",
        "BCP_ROW_IMPORTED",
        "MEETING_CONFLICT_RAISED",
        "BCP_ROW_IMPORTED",
        "BCP_IMPORT_COMPLETED",
        "COMMITTEE_WORKBOOK_COMMITTED",
      ]);
      for (const e of events.filter((x) => x.action.startsWith("BCP_")))
        expect(e, e.action).toMatchObject({
          case_id: null,
          metadata: expect.objectContaining({ scope: "COMMITTEE_PROCEEDING" }),
        });
      expect(events.find((e) => e.action === "MEETING_RECORDED_OFFLINE")).toMatchObject({
        case_id: caseB,
        metadata: expect.objectContaining({ held_offline: true, committee_proceeding_id: cp }),
      });
      expect(events.find((e) => e.action === "MEETING_CONFLICT_RAISED")).toMatchObject({ reason: null });
      expect(JSON.stringify(events)).not.toContain(MARK);
      expect(JSON.stringify(events)).not.toContain(EMAIL.legal!);

      // Provenance follows the object: the importer reads both; the member it is about reads the meeting's, never
      // the concern's; the case team reads the meeting's as it reads the meeting.
      const provSeen = async (u: UserKey) => {
        await s.as(u);
        const list = await s.tx<{ sheet_code: string }[]>`
          select sheet_code from exchange.bcp_provenance where batch_id = ${batch} order by sheet_code`;
        return list.map((x) => x.sheet_code);
      };
      expect(await provSeen("committeeSecretary")).toEqual(["09_MEETINGS", "11_CONFLICTS"]);
      expect(await provSeen("legal")).toEqual(["09_MEETINGS"]);
      expect(await provSeen("caseManager")).toEqual(["09_MEETINGS"]);

      // Re-import is idempotent in the proceeding's namespace.
      const again = await stage(s, control(t, cp), [
        meetingRow(t, 3, "BCP-M1"),
        conflictRow(t, 3, "BCP-K1", "BCP-M1", "legal"),
      ]);
      expect(states(await staged(s, again))).toEqual({
        "BCP-M1": ["ALREADY_IMPORTED", null],
        "BCP-K1": ["ALREADY_IMPORTED", null],
      });
    });
  });
});

describe("a lost committee workbook is revoked (AMB-205 in the proceeding's namespace)", () => {
  it("its importer revokes it; nobody else can; it then goes no further and is never staged again; a case revocation never touches it", async () => {
    await ownerScenario(async (s) => {
      const t = await times(s);
      const cp = await proceeding(s);
      const batch = await stage(s, control(t, cp), [meetingRow(t, 3, "BCP-M1")]);
      await preview(s, batch);
      // The case team and the chair see the proceeding but do not import its workbook; an unknown proceeding is
      // NOT_FOUND.
      for (const u of ["caseManager", "committeeChair"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", revokeCall(cp));
      }
      await s.as("committeeSecretary");
      await s.expectError("CDF_NOT_FOUND", revokeCall(randomUUID()));
      await s.expectError("CDF_INVALID:workbook_id", revokeCall(cp, "not a workbook"));

      const id = (
        await s.tx<{ id: string }[]>`
        select api.revoke_committee_bcp_workbook(${cp}, ${WB}, 'INC-DEMO-2110', ${REASON}) as id`
      )[0]!.id;
      await s.expectError("CDF_CONFLICT:WORKBOOK_REVOKED", revokeCall(cp));
      const v = await view(s, batch);
      expect(v.workbook_revoked).toBe(true);
      expect(v.capabilities).toMatchObject({ may_submit: false, may_apply: false, may_cancel: true });
      // Approved anyway (owner fixture): the table refuses it, on every path.
      await s.asOwner();
      await s.expectError("CDF_CONFLICT:WORKBOOK_REVOKED", (tx) => simulateApproval(tx, batch));
      await s.as("committeeSecretary");
      await s.tx`select api.cancel_bcp_import(${batch}, ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:WORKBOOK_REVOKED",
        stageCall(control(t, cp), [meetingRow(t, 3, "BCP-M1")]),
      );

      // Who reads the revocation: its importer, not the case team; the case's own revocations stay theirs.
      expect(await s.tx`select id from exchange.bcp_workbook_revocation`).toEqual([{ id }]);
      await s.as("caseManager");
      expect(await s.tx`select id from exchange.bcp_workbook_revocation`).toEqual([]);
      // The ledger: the business event under no case, the security event for monitoring; ids and counts only.
      await s.asOwner();
      expect(
        await s.tx`select action, category, case_id, metadata from audit.audit_event where object_id = ${id} order by seq`,
      ).toEqual([
        {
          action: "BCP_WORKBOOK_REVOCATION_RECORDED",
          category: "BUSINESS",
          case_id: null,
          metadata: { open_batches: 1, scope: "COMMITTEE_PROCEEDING", committee_proceeding_id: cp },
        },
        {
          action: "BCP_WORKBOOK_REVOKED",
          category: "SECURITY",
          case_id: null,
          metadata: { open_batches: 1, scope: "COMMITTEE_PROCEEDING", committee_proceeding_id: cp },
        },
      ]);
    });
  });
});
