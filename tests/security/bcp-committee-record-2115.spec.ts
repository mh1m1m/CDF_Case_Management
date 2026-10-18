// Business architecture rebase, migration 2115 (ADR-061; CDF-254): the official record of a committee continuity
// workbook, built on the owner's decision on AMB-201 of 2026-10-17 ("Dual Institutional Record and Platform
// Attestation Model"), the coordinator's rulings of 19:13 UTC and AGENT-09's conditions (E5, E6, E7, R6, R7, R8). The
// owner decision's eighteen negative tests (§17) are each pinned below under their number. Every step runs through
// the api.* commands as `authenticated`; the owner connection only backdates the referral, adds the registry entry's
// fixtures, reads the ledger and the outbox, and probes the triggers. Synthetic data only.
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
import {
  MINUTES_SHA,
  RECORD_REASON,
  attestAll,
  attestCall,
  commitRecord,
  decideCall,
  declare,
  declareCall,
  declaration,
  meetingDate,
  openRecord,
  recordState,
  registerCall,
  submitHash,
  submitRecord,
  uploadMinutes,
  type OpenedRecord,
} from "../support/committee-record";

type Tx = Scenario["tx"];

const SHA = "e".repeat(64);
const WB = "BCP-DEMO-C-0115";
const WHY = "Synthetic: resolved during the import review.";
const MARK = "unique-record-reason-marker";

let caseB: string, ic: string;
const EMAIL: Record<string, string> = {};
beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
  const users = await admin<{ id: string; email: string }[]>`select id, email from iam.user_profile`;
  for (const [key, id] of Object.entries(USERS)) EMAIL[key] = users.find((u) => u.id === id)!.email;
});

/** The IC seats of the 2110 tests plus a deputy chair. */
const SEATS: [UserKey, string][] = [...IC_SEATS, ["investigatorA", "DEPUTY_CHAIR"]];

interface Times {
  from: string;
  heldStart: string;
  heldEnd: string;
  secondStart: string;
  secondEnd: string;
  to: string;
}

async function times(s: OwnerScenario): Promise<Times> {
  await s.asOwner();
  const iso = (expr: string) => `to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const [r] = await s.tx.unsafe<Times[]>(
    `select ${iso("now() - interval '2 days'")} as "from",
            ${iso("now() - interval '2 days' + interval '1 hour'")} as "heldStart",
            ${iso("now() - interval '2 days' + interval '3 hours'")} as "heldEnd",
            ${iso("now() - interval '2 days' + interval '5 hours'")} as "secondStart",
            ${iso("now() - interval '2 days' + interval '6 hours'")} as "secondEnd",
            ${iso("now() - interval '1 day'")} as "to"`,
  );
  return r!;
}

/** IC seated (chair, secretary, legal, legalB, lead, investigatorA as deputy chair unless `seats`), case 0002 referred
 *  three days ago, and the secretary holding a registry entry for that proceeding. */
async function proceeding(s: OwnerScenario, seats: [UserKey, string][] = SEATS): Promise<string> {
  await seat(s, ic, seats);
  const cp = await refer(s, ic, caseB);
  await s.asOwner();
  await s.tx`alter table committee.committee_proceeding disable trigger committee_proceeding_protect`;
  await s.tx`update committee.committee_proceeding set referred_at = now() - interval '3 days' where id = ${cp}`;
  await s.tx`alter table committee.committee_proceeding enable trigger committee_proceeding_protect`;
  await s.as("platformAdmin");
  await s.tx`select api.authorize_committee_continuity_operator(${USERS.committeeSecretary}, ${cp}, 'BCP-AUTH-DEMO-C2',
               ${REASON})`;
  return cp;
}

function control(t: Times, cp: string, extra: Record<string, string> = {}) {
  return {
    TEMPLATE_VERSION: "BCP-C1",
    WORKBOOK_ID: WB,
    COMMITTEE_PROCEEDING_ID: cp,
    COMMITTEE_CODE: "IC",
    OFFLINE_FROM: t.from,
    OFFLINE_TO: t.to,
    PREPARED_BY: EMAIL.committeeSecretary!,
    ...extra,
  };
}

function row(sheet: string, n: number, key: string, at: string, cells: Record<string, string>) {
  return {
    sheet,
    row_number: n,
    cells: { ROW_ID: key, ORIGINAL_EVENT_AT: at, RECORDED_OFFLINE_BY: EMAIL.committeeSecretary!, ...cells },
    has_formula: false,
  };
}

const meetingRow = (t: Times, n: number, key: string, cells: Record<string, string> = {}) =>
  row("09_MEETINGS", n, key, cells.HELD_START ?? t.heldStart, {
    PURPOSE: "DELIBERATION",
    MODE: "IN_PERSON",
    LOCATION: "Meeting room (synthetic)",
    HELD_START: t.heldStart,
    HELD_END: t.heldEnd,
    PAPER_MINUTES_REFERENCE: "PAPER-MIN-DEMO-0115",
    REASON: "Synthetic: the committee met on paper during the outage.",
    ...cells,
  });

const conflictRow = (t: Times, n: number, key: string, meetingRef: string, about: UserKey) =>
  row("11_CONFLICTS", n, key, t.heldStart, {
    MEETING_REF: meetingRef,
    PARTICIPANT: EMAIL[about]!,
    REASON: "Synthetic: a possible conflict noted on paper.",
  });

/** Stages, resolves and previews a committee workbook as the secretary. By default: one meeting held on paper, a
 *  paper-noted conflict about `subject` (legal) at it, and the attendance and vote sheets recorded only (skipped). */
async function workbook(
  s: OwnerScenario,
  opts: { rows?: (t: Times) => unknown[]; subject?: UserKey | null; seats?: [UserKey, string][] } = {},
): Promise<{ cp: string; batch: string; t: Times }> {
  const t = await times(s);
  const cp = await proceeding(s, opts.seats);
  const subject = opts.subject === undefined ? "legal" : opts.subject;
  const rows = opts.rows?.(t) ?? [
    meetingRow(t, 3, "BCP-M1"),
    row("10_ATTENDANCE", 3, "BCP-T1", t.heldStart, { DETAILS: "Synthetic: all members present on paper." }),
    ...(subject ? [conflictRow(t, 3, "BCP-K1", "BCP-M1", subject)] : []),
    row("12_VOTES", 3, "BCP-V1", t.heldStart, { DETAILS: "Synthetic: a vote taken on paper." }),
  ];
  await s.as("committeeSecretary");
  const [b] = await s.tx<{ id: string }[]>`
    select api.stage_bcp_import(${s.tx.json(control(t, cp) as never)}::jsonb, ${SHA},
                                ${s.tx.json(rows as never)}::jsonb) as id`;
  const batch = b!.id;
  const unsupported = await s.tx<{ id: string }[]>`
    select id from exchange.bcp_import_row where batch_id = ${batch} and state in ('UNSUPPORTED', 'INVALID')`;
  for (const r of unsupported) await s.tx`select api.resolve_bcp_row(${r.id}, 'SKIP', ${WHY})`;
  await s.tx`select api.preview_bcp_import(${batch})`;
  return { cp, batch, t };
}

/** A workbook with its record opened, the roster declared (defaults: everyone attended and signed, the chair signed as
 *  chair) and the signed minutes uploaded and marked. */
async function prepared(
  s: OwnerScenario,
  opts: Parameters<typeof workbook>[1] & {
    declared?: Parameters<typeof declare>[2];
    chairSigner?: UserKey | null;
  } = {},
): Promise<{ cp: string; batch: string; t: Times; opened: OpenedRecord; document: string }> {
  const w = await workbook(s, opts);
  const opened = await openRecord(s, w.batch);
  await declare(
    s,
    opened,
    opts.declared ?? {},
    opts.chairSigner === undefined ? "committeeChair" : opts.chairSigner,
  );
  const { document } = await uploadMinutes(s, w.batch, opened.record);
  return { ...w, opened, document };
}

/** What `user` reads of the record through its tables (row-level security; the role-shaped read models ship with
 *  the Section 13 screens). Leaves the session as `user`. */
async function reads(s: Scenario, user: UserKey, record: string) {
  await s.as(user);
  return {
    documents: await s.tx<{ version_no: number; status: string }[]>`
      select version_no, status from exchange.bcp_record_document where record_id = ${record} order by version_no`,
    roster: (
      await s.tx<{ user_id: string }[]>`
        select user_id from exchange.bcp_record_roster where record_id = ${record} order by user_id`
    ).map((l) => l.user_id),
    decisions: await s.tx<{ decision: string }[]>`
      select decision from exchange.bcp_record_decision where record_id = ${record}`,
    attestations: await s.tx<
      { user_id: string; action: string; discrepancy_code: string | null; reason: string | null }[]
    >`
      select user_id, action, discrepancy_code, reason from exchange.bcp_record_attestation where record_id = ${record}
      order by attested_at`,
    acting: await s.tx<{ id: string; deputy_user_id: string; basis: string }[]>`
      select id, deputy_user_id, basis from exchange.bcp_record_acting_chair where record_id = ${record}`,
  };
}

/** Line states by user key (owner read of the derived state). Leaves the session as the secretary. */
async function states(
  s: OwnerScenario,
  _batch: string,
  opened: OpenedRecord,
): Promise<Record<string, string>> {
  await s.asOwner();
  const lines = await s.tx<{ id: string; state: string }[]>`
    select l.id, exchange.bcp_record_line_state(l.id) as state from exchange.bcp_record_roster l
    where l.record_id = ${opened.record}`;
  await s.as("committeeSecretary");
  const byLine = Object.fromEntries(Object.entries(opened.roster).map(([k, id]) => [id, k]));
  return Object.fromEntries(lines.map((l) => [byLine[l.id]!, l.state]));
}

/** The record's open discrepancies (owner read of the derived reconciliation, attestations included). */
async function discrepancies(s: OwnerScenario, record: string) {
  await s.asOwner();
  return s.tx<{ code: string; roster_id: string | null }[]>`
    select code, roster_id from exchange.bcp_record_discrepancies(${record}, true) order by code, roster_id`;
}

/** The record's ledger entries (owner read), in order. */
async function recordEvents(s: OwnerScenario, batch: string) {
  await s.asOwner();
  return s.tx<
    {
      action: string;
      outcome: string;
      case_id: string | null;
      reason: string | null;
      metadata: Record<string, unknown>;
    }[]
  >`
    select action, outcome, case_id, reason, metadata from audit.audit_event
    where object_id = ${batch} or metadata ->> 'batch_id' = ${batch} order by seq`;
}

async function outbox(s: OwnerScenario, batch: string) {
  await s.asOwner();
  return s.tx<{ template_code: string; recipient_id: string }[]>`
    select distinct template_code, recipient_id from notify.outbox where object_id = ${batch}
    order by template_code, recipient_id`;
}

describe("the official record end to end (owner decision §1, §3, §5, §12, §14)", () => {
  it("signed minutes, the chair's approval and every attending eligible member's own attestation, reconciled, then READY_TO_COMMIT and COMMITTED with permanent links; no attendance and no vote is written", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened, document } = await prepared(s, {
        declared: { lead: { attendance: "ATTENDED_PART", left_early: true } },
      });
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.asOwner();
      expect(await s.tx`select status from exchange.bcp_import_batch where id = ${batch}`).toEqual([
        { status: "SUBMITTED" },
      ]);
      expect(await recordState(s, opened.record)).toEqual({ status: "PENDING_CHAIR_APPROVAL", revision: 1 });

      // The chair reviews the signed minutes against the workbook (§13) and approves.
      const chair = await reads(s, "committeeChair", opened.record);
      expect(chair.documents).toEqual([{ version_no: 1, status: "SIGNED_OFFICIAL_RECORD" }]);
      expect(chair.roster).toHaveLength(6);
      expect(
        await s.tx`select count(*)::int as n from exchange.bcp_import_row where batch_id = ${batch}`,
      ).toEqual([{ n: 4 }]);
      await s.tx`select * from api.open_committee_record_document(${document})`;
      expect((await decideCall(opened.record, 1, "APPROVE")(s.tx))[0]!.r).toBe(
        "PLATFORM_ATTESTATION_IN_PROGRESS",
      );

      expect(await states(s, batch, opened)).toEqual({
        committeeChair: "NOT_REQUIRED",
        committeeSecretary: "NOT_REQUIRED",
        investigatorA: "PENDING",
        legal: "PENDING",
        legalB: "PENDING",
        lead: "PENDING",
      });
      const attested = await attestAll(s, opened, 1);
      expect(attested.sort()).toEqual(["investigatorA", "lead", "legal", "legalB"]);
      await s.asOwner();
      expect(
        await s.tx`select user_id, scope, action from exchange.bcp_record_attestation where record_id = ${opened.record}
                   order by user_id`,
      ).toEqual(
        [
          { user_id: USERS.investigatorA, scope: "FULL", action: "ATTEST" },
          { user_id: USERS.lead, scope: "PARTIAL", action: "ATTEST" },
          { user_id: USERS.legal, scope: "OWN_PARTICIPATION", action: "ATTEST" },
          { user_id: USERS.legalB, scope: "FULL", action: "ATTEST" },
        ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
      );
      expect(await recordState(s, opened.record)).toEqual({ status: "READY_TO_COMMIT", revision: 1 });
      expect(
        await s.tx`select status, decided_by from exchange.bcp_import_batch where id = ${batch}`,
      ).toEqual([{ status: "APPROVED", decided_by: USERS.committeeChair }]);

      expect(await commitRecord(s, batch)).toMatchObject({ imported: 2, skipped: 2 });
      await s.asOwner();
      const [rec] = await s.tx<
        {
          status: string;
          meeting_id: string;
          signed_document_id: string;
          meeting_row_id: string;
          committed: boolean;
        }[]
      >`select status, meeting_id, signed_document_id, meeting_row_id, committed_at is not null as committed
        from exchange.bcp_committee_record where id = ${opened.record}`;
      expect(rec).toMatchObject({ status: "COMMITTED", signed_document_id: document, committed: true });
      const [prov] = await s.tx<{ row_id: string; object_id: string }[]>`
        select row_id, object_id from exchange.bcp_provenance where batch_id = ${batch} and sheet_code = '09_MEETINGS'`;
      expect(rec!.meeting_row_id).toBe(prov!.row_id);
      expect(rec!.meeting_id).toBe(prov!.object_id);
      expect(await s.tx`select status from exchange.bcp_import_batch where id = ${batch}`).toEqual([
        { status: "IMPORTED" },
      ]);
      // F3 stands: the record's attendance is a declaration on the record, never meeting attendance; no vote exists.
      expect(
        await s.tx`select distinct attendance from committee.meeting_participant where meeting_id = ${rec!.meeting_id}`,
      ).toEqual([{ attendance: "NOT_RECORDED" }]);
      expect(
        await s.tx`select count(*)::int as n from committee.vote_item where meeting_id = ${rec!.meeting_id}`,
      ).toEqual([{ n: 0 }]);

      // §14: each step its own event, in order; under no case; ids and codes only.
      const events = await recordEvents(s, batch);
      expect(events.map((e) => e.action)).toEqual([
        "BCP_IMPORT_STAGED",
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
        "OFFICIAL_MINUTES_OPENED",
        "CHAIR_APPROVED_IMPORTED_RECORD",
        "MEMBER_ATTESTED_IMPORTED_RECORD",
        "MEMBER_ATTESTED_IMPORTED_RECORD",
        "MEMBER_ATTESTED_IMPORTED_RECORD",
        "MEMBER_ATTESTED_IMPORTED_RECORD",
        "WORKBOOK_READY_TO_COMMIT",
        "BCP_ROW_IMPORTED",
        "BCP_ROW_IMPORTED",
        "BCP_IMPORT_COMPLETED",
        "COMMITTEE_WORKBOOK_COMMITTED",
      ]);
      for (const e of events) expect(e, e.action).toMatchObject({ case_id: null });
      expect(events.find((e) => e.action === "WORKBOOK_READY_TO_COMMIT")!.metadata).toMatchObject({
        approved_by: USERS.committeeChair,
        capacity: "CHAIR",
        attested: 4,
      });

      // Notices: ids only, to whoever acts next; the importer is told the workbook is ready (the batch's own notice).
      expect(await outbox(s, batch)).toEqual(
        [
          { template_code: "BCP_IMPORT_DECIDED", recipient_id: USERS.committeeSecretary },
          { template_code: "COMMITTEE_RECORD_APPROVAL_REQUESTED", recipient_id: USERS.committeeChair },
          ...(["investigatorA", "lead", "legal", "legalB"] as const).map((u) => ({
            template_code: "COMMITTEE_RECORD_ATTESTATION_REQUESTED",
            recipient_id: USERS[u],
          })),
        ].sort((a, b) => (a.template_code + a.recipient_id).localeCompare(b.template_code + b.recipient_id)),
      );
    });
  });
});

const submitCall = (batch: string, hash: string) => (tx: Tx) =>
  tx`select api.submit_bcp_import(${batch}, ${hash})`;
const applyCall = (batch: string, hash: string) => (tx: Tx) =>
  tx`select api.apply_bcp_import(${batch}, ${hash})`;
const markCall = (doc: string) => (tx: Tx) => tx`select api.mark_committee_minutes_signed(${doc})`;
const completeCall =
  (doc: string, scan = "CLEAN") =>
  (tx: Tx) =>
    tx`select api.complete_committee_record_document(${doc}, ${scan}, 'synthetic-scanner')`;
const openDocCall = (doc: string) => (tx: Tx) => tx`select * from api.open_committee_record_document(${doc})`;
const activateCall =
  (
    record: string,
    basis: string,
    reason = "Synthetic: the chair cannot act on this record.",
    to = "now() + interval '7 days'",
  ) =>
  (tx: Tx) =>
    tx.unsafe(`select api.activate_record_acting_chair($1, $2, $3, ${to}) as id`, [record, basis, reason]);
const endCall =
  (activation: string, reason = RECORD_REASON) =>
  (tx: Tx) =>
    tx`select api.end_record_acting_chair(${activation}, ${reason})`;
const returnCall =
  (record: string, reason = RECORD_REASON) =>
  (tx: Tx) =>
    tx`select api.return_committee_record(${record}, ${reason})`;

/** The secretary's submission's result after a failed reconciliation, with the codes the ledger recorded. */
async function failedCodes(s: OwnerScenario, batch: string): Promise<string[][]> {
  const events = await recordEvents(s, batch);
  return events
    .filter((e) => e.action === "SIGNATURE_RECONCILIATION_FAILED")
    .map((e) => [String(e.metadata.at), ...(e.metadata.codes as string[])]);
}

describe("Layer 1: only the final signed minutes count (§2, §3, §15)", () => {
  it("1, 10, 12: unsigned, draft or editable minutes never become the signed official record, and nothing on the platform stands in for them", async () => {
    await ownerScenario(async (s) => {
      const { cp, batch } = await workbook(s);
      await s.as("committeeSecretary");
      const h = await submitHash(s, batch);
      // 10: no record at all, so no submission (as 2110), whatever the platform holds.
      await s.expectError("CDF_CONFLICT:OFFICIAL_RECORD_REQUIRED", submitCall(batch, h));
      const opened = await openRecord(s, batch);
      await s.expectError(
        "CDF_CONFLICT:ALREADY_OPEN",
        (tx) => tx`select api.open_committee_record(${batch})`,
      );
      const date = await meetingDate(s, batch);

      // 12: an editable document, a path in the name, a malformed hash or a meeting not yet held is refused outright.
      await s.expectError(
        "CDF_INVALID:content_type",
        registerCall(opened.record, date, {
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          fileName: "minutes-demo.docx",
        }),
      );
      await s.expectError(
        "CDF_INVALID:content_type",
        registerCall(opened.record, date, { contentType: "text/plain" }),
      );
      await s.expectError(
        "CDF_INVALID:file_name",
        registerCall(opened.record, date, { fileName: "../minutes.pdf" }),
      );
      await s.expectError(
        "CDF_INVALID:sha256",
        registerCall(opened.record, date, { sha256: "D".repeat(64) }),
      );
      await s.expectError(
        "CDF_INVALID:meeting_date",
        registerCall(opened.record, date, { meetingDate: "2999-01-01" }),
      );

      // Registered, not yet stored and scanned: never opened, never marked.
      const [q] = await registerCall(opened.record, date)(s.tx);
      expect(q!.o_version_no).toBe(1);
      expect(q!.o_object_key).toBe(`committee-records/${cp}/${opened.record}/${q!.o_document_id}`);
      await s.expectError("CDF_CONFLICT:DOCUMENT_NOT_STORED", markCall(q!.o_document_id));
      await s.expectError("CDF_CONFLICT:DOCUMENT_NOT_STORED", openDocCall(q!.o_document_id));
      await s.expectError("CDF_INVALID:scan_status", completeCall(q!.o_document_id, "INFECTED"));
      await completeCall(q!.o_document_id)(s.tx);
      await s.expectError("CDF_CONFLICT:VERSION_NOT_QUARANTINED", completeCall(q!.o_document_id));

      // Stored but not shown to be the final signed record: the roster undeclared, an attending member's signature
      // not visible, or nobody signed as chair.
      await s.expectError("CDF_CONFLICT:ROSTER_NOT_DECLARED", markCall(q!.o_document_id));
      await declareCall(
        opened.record,
        declaration(opened, { legalB: { attendance: "ATTENDED", signature_visible: false } }),
      )(s.tx);
      await s.expectError("CDF_CONFLICT:MISSING_OFFICIAL_SIGNATURE", markCall(q!.o_document_id));
      await declareCall(opened.record, declaration(opened, {}, null))(s.tx);
      await s.expectError("CDF_CONFLICT:MISSING_OFFICIAL_SIGNATURE", markCall(q!.o_document_id));
      await declareCall(opened.record, declaration(opened))(s.tx);

      // 1: stored and declared but not marked: not submitted, not committed; and (10) no attestation or chair decision
      // happens without it.
      await s.expectError("CDF_CONFLICT:OFFICIAL_RECORD_REQUIRED", submitCall(batch, h));
      await s.expectError("CDF_CONFLICT:RECORD_NOT_READY", applyCall(batch, h));
      await s.as("legalB");
      await s.expectError("CDF_CONFLICT:ATTESTATION_NOT_OPEN", attestCall(opened.record, 1));
      await s.as("committeeChair");
      await s.expectError("CDF_CONFLICT:NOT_PENDING_APPROVAL", decideCall(opened.record, 1, "APPROVE"));

      await s.as("committeeSecretary");
      await markCall(q!.o_document_id)(s.tx);
      await s.expectError("CDF_CONFLICT:ALREADY_SIGNED", markCall(q!.o_document_id));
      await s.asOwner();
      expect(
        await s.tx`select status, sha256, source, document_type, content_type, uploaded_by, version_no,
                          signed_marked_by from exchange.bcp_record_document where record_id = ${opened.record}`,
      ).toEqual([
        {
          status: "SIGNED_OFFICIAL_RECORD",
          sha256: MINUTES_SHA,
          source: "OFFICIAL_SIGNED_MINUTES",
          document_type: "COMMITTEE_MINUTES",
          content_type: "application/pdf",
          uploaded_by: USERS.committeeSecretary,
          version_no: 1,
          signed_marked_by: USERS.committeeSecretary,
        },
      ]);
      // The version never changes and never goes away (§15).
      await s.expectError(
        "signed minutes version",
        (tx) =>
          tx`update exchange.bcp_record_document set sha256 = ${"f".repeat(64)} where record_id = ${opened.record}`,
      );
      await s.expectError(
        "signed minutes version",
        (tx) =>
          tx`update exchange.bcp_record_document set status = 'STORED' where record_id = ${opened.record}`,
      );
      await s.expectError(
        "committee record rows are never deleted",
        (tx) => tx`delete from exchange.bcp_record_document where record_id = ${opened.record}`,
      );
      // After submission the record is no longer the secretary's to change.
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.expectError(
        "CDF_CONFLICT:RECORD_NOT_EDITABLE",
        declareCall(opened.record, declaration(opened)),
      );
      await s.expectError("CDF_CONFLICT:RECORD_NOT_EDITABLE", registerCall(opened.record, date));
      expect((await recordEvents(s, batch)).map((e) => e.action)).toContain("OFFICIAL_MINUTES_MARKED_SIGNED");
    });
  });
});

describe("nobody acts for anyone else (§3, §7, §11)", () => {
  it("2, 3, 14, 15: the secretary never approves, nobody attests for another, and no administrator approves or attests through admin rights", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened, document } = await prepared(s);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");

      // 2: the importer is never the approver, on the record or on 2110's batch path.
      await s.as("committeeSecretary");
      await s.expectError("CDF_FORBIDDEN", decideCall(opened.record, 1, "APPROVE"));
      const h = await submitHash(s, batch);
      await s.expectError(
        "CDF_CONFLICT:OFFICIAL_RECORD_REQUIRED",
        (tx) => tx`select api.decide_bcp_import(${batch}, 'APPROVE', null, ${h})`,
      );
      await s.as("committeeChair");
      await decideCall(opened.record, 1, "APPROVE")(s.tx);

      // 3, 15: the attestation takes no user: whoever calls attests their own line, once; nobody writes the tables.
      await s.asOwner();
      const [sig] = await s.tx<{ args: string }[]>`
        select pg_get_function_identity_arguments('api.attest_committee_record'::regproc) as args`;
      expect(sig!.args).toBe(
        "p_record_id uuid, p_revision integer, p_action text, p_discrepancy_code text, p_reason text",
      );
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:NOT_REQUIRED", attestCall(opened.record, 1));
      for (const table of [
        "bcp_record_attestation",
        "bcp_record_decision",
        "bcp_record_roster",
        "bcp_committee_record",
      ])
        await s.expectError("permission denied", (tx) =>
          tx.unsafe(`delete from exchange.${table} where id is not null`),
        );
      await s.expectError(
        "permission denied",
        (tx) =>
          tx`insert into exchange.bcp_record_attestation (record_id, revision, roster_id, user_id, action, scope)
           values (${opened.record}, 1, ${opened.roster.legalB!}, ${USERS.legalB}, 'ATTEST', 'FULL')`,
      );
      await s.as("legalB");
      expect((await attestCall(opened.record, 1)(s.tx))[0]!.r).toBe("ATTESTED");
      await s.expectError("CDF_CONFLICT:NOT_REQUIRED", attestCall(opened.record, 1));
      await s.asOwner();
      expect(
        await s.tx`select user_id, roster_id from exchange.bcp_record_attestation where record_id = ${opened.record}`,
      ).toEqual([{ user_id: USERS.legalB, roster_id: opened.roster.legalB }]);

      // 14: platform and technical administrators, the case team and the GRC Director: nothing to see, nothing to do.
      for (const u of [
        "platformAdmin",
        "internalAudit",
        "soc",
        "dpo",
        "grcDirector",
        "caseManager",
      ] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", decideCall(opened.record, 1, "APPROVE"));
        await s.expectError("CDF_NOT_FOUND", attestCall(opened.record, 1));
        await s.expectError("CDF_NOT_FOUND", openDocCall(document));
        await s.expectError("CDF_NOT_FOUND", returnCall(opened.record));
        await s.expectError("CDF_NOT_FOUND", activateCall(opened.record, "UNAVAILABLE"));
        for (const table of [
          "bcp_committee_record",
          "bcp_record_roster",
          "bcp_record_document",
          "bcp_record_decision",
          "bcp_record_attestation",
          "bcp_record_acting_chair",
        ])
          expect(await s.tx.unsafe(`select id from exchange.${table}`), `${u} ${table}`).toEqual([]);
        expect(await s.tx`select id from exchange.bcp_import_batch where id = ${batch}`, u).toEqual([]);
      }
    });
  });

  it("§7: only the chair's or the deputy chair's seat line signs as chair, and an acting chair is only ever the deputy chair's line", async () => {
    await ownerScenario(async (s) => {
      const { batch } = await workbook(s);
      const opened = await openRecord(s, batch);
      for (const signer of ["committeeSecretary", "legal"] as const)
        await s.expectError(
          "CDF_INVALID:signed_as_chair",
          declareCall(opened.record, declaration(opened, {}, signer)),
        );
      await declareCall(opened.record, declaration(opened, {}, "investigatorA"))(s.tx);
      // No parameter names the appointee: the activation takes the deputy chair's seat line.
      await s.asOwner();
      const [sig] = await s.tx<{ args: string }[]>`
        select pg_get_function_identity_arguments('api.activate_record_acting_chair'::regproc) as args`;
      expect(sig!.args).toBe(
        "p_record_id uuid, p_basis text, p_reason text, p_effective_to timestamp with time zone",
      );
    });
  });
});

describe("both layers are needed (§3, §11, §16)", () => {
  it("4, 5, 9: no attestation before the chair approves, no commit on the chair's approval alone, and a paper signature is never a platform attestation", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened } = await prepared(s);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      const h = await submitHash(s, batch);

      // 5: members cannot attest, and nothing commits, before the chair's approval.
      for (const u of ["legal", "legalB", "lead", "investigatorA"] as const) {
        await s.as(u);
        await s.expectError("CDF_CONFLICT:ATTESTATION_NOT_OPEN", attestCall(opened.record, 1));
      }
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:RECORD_NOT_READY", applyCall(batch, h));
      await s.as("committeeChair");
      await s.expectError("CDF_CONFLICT:REVISION_CHANGED", decideCall(opened.record, 2, "APPROVE"));
      await decideCall(opened.record, 1, "APPROVE")(s.tx);
      await s.expectError("CDF_CONFLICT:NOT_PENDING_APPROVAL", decideCall(opened.record, 1, "APPROVE"));

      // 9: every signature was declared visible, yet no line is attested until its member acts.
      await s.asOwner();
      expect(await s.tx`select count(*)::int as n from exchange.bcp_record_attestation`).toEqual([{ n: 0 }]);
      expect(
        await s.tx`select bool_and(signature_visible) as all_signed from exchange.bcp_record_roster
                   where record_id = ${opened.record} and attendance = 'ATTENDED'`,
      ).toEqual([{ all_signed: true }]);
      expect(Object.values(await states(s, batch, opened)).filter((x) => x === "PENDING")).toHaveLength(4);

      // 4: the chair's approval alone commits nothing; nor do three of four attestations.
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:RECORD_NOT_READY", applyCall(batch, h));
      for (const u of ["legal", "legalB", "lead"] as const) {
        await s.as(u);
        await attestCall(opened.record, 1)(s.tx);
      }
      expect(await recordState(s, opened.record)).toEqual({
        status: "PLATFORM_ATTESTATION_IN_PROGRESS",
        revision: 1,
      });
      expect(await discrepancies(s, opened.record)).toEqual([
        { code: "MISSING_PLATFORM_ATTESTATION", roster_id: opened.roster.investigatorA },
      ]);
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:RECORD_NOT_READY", applyCall(batch, h));
      await s.as("investigatorA");
      await attestCall(opened.record, 1)(s.tx);
      expect(await commitRecord(s, batch)).toMatchObject({ imported: 2 });
    });
  });
});

describe("the deputy chair approves only as a formally activated acting chair (§4; E5)", () => {
  it("6: an absent chair: the deputy approves only once the secretary activates them for this record, with a derived basis, a reason and a period, never for themself; the activation lapses and ends", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened } = await prepared(s, {
        declared: { committeeChair: { attendance: "ABSENT" } },
        chairSigner: "investigatorA",
      });
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      // Nobody may approve yet, so nobody is asked.
      expect((await outbox(s, batch)).map((n) => n.template_code)).not.toContain(
        "COMMITTEE_RECORD_APPROVAL_REQUESTED",
      );
      for (const u of ["investigatorA", "committeeChair"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", decideCall(opened.record, 1, "APPROVE"));
      }
      // Only the importer activates, and never on a basis the record does not show.
      await s.as("investigatorA");
      await s.expectError("CDF_NOT_FOUND", activateCall(opened.record, "ABSENT"));
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:BASIS_NOT_SHOWN", activateCall(opened.record, "UNAVAILABLE"));
      await s.expectError("CDF_CONFLICT:BASIS_NOT_SHOWN", activateCall(opened.record, "CONFLICTED"));
      await s.expectError("CDF_INVALID:basis", activateCall(opened.record, "PERMANENT"));
      await s.expectError("CDF_INVALID:reason", activateCall(opened.record, "ABSENT", "short"));
      await s.expectError(
        "CDF_INVALID:effective_to",
        activateCall(opened.record, "ABSENT", undefined, "now() - interval '1 hour'"),
      );
      const [a] = await activateCall(
        opened.record,
        "ABSENT",
        `Synthetic: the chair was absent (${MARK}).`,
      )(s.tx);
      const activation = (a as unknown as { id: string }).id;
      await s.expectError("CDF_CONFLICT:ALREADY_ACTIVATED", activateCall(opened.record, "ABSENT"));
      expect((await reads(s, "committeeChair", opened.record)).acting).toEqual([
        { id: activation, deputy_user_id: USERS.investigatorA, basis: "ABSENT" },
      ]);
      expect((await reads(s, "legalB", opened.record)).acting).toEqual([]);

      // Lapsed (owner fixture: the period moved into the past), the deputy can no longer approve; activated again, they can.
      await s.asOwner();
      await s.tx`alter table exchange.bcp_record_acting_chair disable trigger protect`;
      await s.tx`update exchange.bcp_record_acting_chair set effective_from = now() - interval '2 days',
                   effective_to = now() - interval '1 day' where id = ${activation}`;
      await s.tx`alter table exchange.bcp_record_acting_chair enable trigger protect`;
      await s.as("investigatorA");
      await s.expectError("CDF_FORBIDDEN", decideCall(opened.record, 1, "APPROVE"));
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:NOT_ACTIVE", endCall(activation));
      const [b] = await activateCall(opened.record, "ABSENT")(s.tx);
      const second = (b as unknown as { id: string }).id;

      await s.as("investigatorA");
      expect((await decideCall(opened.record, 1, "APPROVE")(s.tx))[0]!.r).toBe(
        "PLATFORM_ATTESTATION_IN_PROGRESS",
      );
      await s.asOwner();
      expect(
        await s.tx`select capacity, decided_by, roster_id, acting_chair_id from exchange.bcp_record_decision
                   where record_id = ${opened.record}`,
      ).toEqual([
        {
          capacity: "ACTING_CHAIR",
          decided_by: USERS.investigatorA,
          roster_id: opened.roster.investigatorA,
          acting_chair_id: second,
        },
      ]);
      // Once approved, the activation stands for this revision.
      await s.as("committeeChair");
      await s.expectError("CDF_CONFLICT:ALREADY_APPROVED", endCall(second));
      expect(await states(s, batch, opened)).toMatchObject({
        committeeChair: "ABSENT",
        investigatorA: "NOT_REQUIRED",
        legal: "PENDING",
        legalB: "PENDING",
        lead: "PENDING",
      });
      await attestAll(s, opened, 1);
      await s.asOwner();
      expect(await recordState(s, opened.record)).toEqual({ status: "READY_TO_COMMIT", revision: 1 });
      expect(await s.tx`select decided_by from exchange.bcp_import_batch where id = ${batch}`).toEqual([
        { decided_by: USERS.investigatorA },
      ]);
      const events = await recordEvents(s, batch);
      expect(
        events.filter((e) => e.action === "RECORD_ACTING_CHAIR_ACTIVATED").map((e) => e.metadata.basis),
      ).toEqual(["ABSENT", "ABSENT"]);
      expect(events.find((e) => e.action === "WORKBOOK_READY_TO_COMMIT")!.metadata).toMatchObject({
        approved_by: USERS.investigatorA,
        capacity: "ACTING_CHAIR",
      });
      expect(JSON.stringify(events)).not.toContain(MARK);
      expect(await outbox(s, batch)).toEqual(
        expect.arrayContaining([
          { template_code: "COMMITTEE_RECORD_ACTING_CHAIR_ACTIVATED", recipient_id: USERS.committeeChair },
          { template_code: "COMMITTEE_RECORD_APPROVAL_REQUESTED", recipient_id: USERS.investigatorA },
        ]),
      );
    });
  });

  it("E5: an unavailable chair who attended: activation is stated with a reason, the chair or the secretary ends it before approval, and the chair's own attestation still gates commit", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened } = await prepared(s);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:CHAIR_AVAILABLE", activateCall(opened.record, "ABSENT"));
      const [a] = await activateCall(opened.record, "UNAVAILABLE")(s.tx);
      const activation = (a as unknown as { id: string }).id;
      // The chair no longer approves while it is in force; the deputy does.
      await s.as("committeeChair");
      await s.expectError("CDF_FORBIDDEN", decideCall(opened.record, 1, "APPROVE"));
      // Ended by the chair it replaced (or the secretary), never by the deputy or a member.
      await s.as("legalB");
      await s.expectError("CDF_NOT_FOUND", endCall(activation));
      await s.as("investigatorA");
      await s.expectError("CDF_FORBIDDEN", endCall(activation));
      await s.as("committeeChair");
      await endCall(activation)(s.tx);
      await s.expectError("CDF_CONFLICT:NOT_ACTIVE", endCall(activation));
      await s.as("investigatorA");
      await s.expectError("CDF_FORBIDDEN", decideCall(opened.record, 1, "APPROVE"));
      await s.as("committeeSecretary");
      await activateCall(opened.record, "UNAVAILABLE")(s.tx);
      await s.as("investigatorA");
      await decideCall(opened.record, 1, "APPROVE")(s.tx);

      expect(await states(s, batch, opened)).toMatchObject({
        committeeChair: "PENDING",
        investigatorA: "NOT_REQUIRED",
      });
      for (const u of ["legal", "legalB", "lead"] as const) {
        await s.as(u);
        await attestCall(opened.record, 1)(s.tx);
      }
      expect((await recordState(s, opened.record)).status).toBe("PLATFORM_ATTESTATION_IN_PROGRESS");
      expect(await discrepancies(s, opened.record)).toEqual([
        { code: "MISSING_PLATFORM_ATTESTATION", roster_id: opened.roster.committeeChair },
      ]);
      await s.as("committeeChair");
      await attestCall(opened.record, 1)(s.tx);
      await s.asOwner();
      expect(await recordState(s, opened.record)).toEqual({ status: "READY_TO_COMMIT", revision: 1 });
      const ended = (await recordEvents(s, batch)).filter((e) => e.action === "RECORD_ACTING_CHAIR_ENDED");
      expect(ended.map((e) => e.metadata)).toMatchObject([
        { ended_as: "CHAIR" },
        { ended_as: "CHAIR", by_act: "ATTEST" },
      ]);
      // The chair's own act shows the chair is available: the activation ended with it, and the approval stands.
      expect(
        await s.tx`select count(*)::int as n from exchange.bcp_record_acting_chair
                   where record_id = ${opened.record} and ended_at is null`,
      ).toEqual([{ n: 0 }]);
      expect(await commitRecord(s, batch)).toMatchObject({ imported: 2 });
    });
  });

  it("a conflicted chair: the record shows it, the chair cannot approve or read the signed file, and the deputy acts on the derived basis", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened, document } = await prepared(s, {
        subject: "committeeChair",
        declared: { committeeChair: { attendance: "RECUSED" } },
        chairSigner: "investigatorA",
      });
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.as("committeeChair");
      await s.expectError("CDF_FORBIDDEN", decideCall(opened.record, 1, "APPROVE"));
      await s.expectError("CDF_NOT_FOUND", openDocCall(document));
      expect((await reads(s, "committeeChair", opened.record)).documents).toEqual([]);
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:BASIS_NOT_SHOWN", activateCall(opened.record, "ABSENT"));
      await activateCall(opened.record, "CONFLICTED")(s.tx);
      await s.as("investigatorA");
      await decideCall(opened.record, 1, "APPROVE")(s.tx);
      expect(await states(s, batch, opened)).toMatchObject({
        committeeChair: "RECUSED",
        investigatorA: "NOT_REQUIRED",
      });
      await s.as("committeeChair");
      await s.expectError("CDF_CONFLICT:NOT_REQUIRED", attestCall(opened.record, 1));
    });
  });
});

describe("who attests, and for what (§5, §9; E6)", () => {
  it("7, 8: an absent or recused member is not asked; a conflict subject attests their own participation only, never reads the signed file and is never told why", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened, document } = await prepared(s, {
        declared: { legalB: { attendance: "ABSENT" }, lead: { attendance: "RECUSED" } },
      });
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.as("committeeChair");
      await decideCall(opened.record, 1, "APPROVE")(s.tx);
      expect(await states(s, batch, opened)).toEqual({
        committeeChair: "NOT_REQUIRED",
        committeeSecretary: "NOT_REQUIRED",
        investigatorA: "PENDING",
        legal: "PENDING",
        legalB: "ABSENT",
        lead: "RECUSED",
      });
      // 7 and the recused member: not required, not able.
      for (const u of ["legalB", "lead"] as const) {
        await s.as(u);
        await s.expectError("CDF_CONFLICT:NOT_REQUIRED", attestCall(opened.record, 1));
      }
      expect(
        (await outbox(s, batch)).filter((n) => n.template_code === "COMMITTEE_RECORD_ATTESTATION_REQUESTED"),
      ).toEqual(
        [
          { template_code: "COMMITTEE_RECORD_ATTESTATION_REQUESTED", recipient_id: USERS.investigatorA },
          { template_code: "COMMITTEE_RECORD_ATTESTATION_REQUESTED", recipient_id: USERS.legal },
        ].sort((x, y) => x.recipient_id.localeCompare(y.recipient_id)),
      );

      // 8: the subject of the paper-noted conflict sees their own line, never the file, the workbook rows or why.
      // (E6: the role-shaped view that never says why ships with the Section 13 screens; here, the tables.)
      const mine = await reads(s, "legal", opened.record);
      expect(mine).toEqual({
        documents: [],
        roster: [USERS.legal],
        decisions: [],
        attestations: [],
        acting: [],
      });
      await s.expectError("CDF_NOT_FOUND", openDocCall(document));
      expect(await s.tx`select id from exchange.bcp_record_document`).toEqual([]);
      expect(await s.tx`select id from exchange.bcp_import_row where batch_id = ${batch}`).toEqual([]);
      // They decline only on their own attendance, and attest only their own participation.
      await s.expectError(
        "CDF_INVALID:discrepancy_code",
        attestCall(opened.record, 1, "DECLINE", "SIGNATURE_MISMATCH", "Synthetic: not my signature."),
      );
      await s.expectError(
        "CDF_INVALID:discrepancy_code",
        attestCall(opened.record, 1, "DECLINE", "CONFLICT_SCOPE_MISMATCH", "Synthetic: the scope is wrong."),
      );
      await s.expectError(
        "CDF_INVALID:discrepancy_code",
        attestCall(opened.record, 1, "ATTEST", "ATTENDANCE_MISMATCH"),
      );
      await s.expectError(
        "CDF_INVALID:reason",
        attestCall(opened.record, 1, "DECLINE", "ATTENDANCE_MISMATCH", null),
      );
      await attestCall(opened.record, 1)(s.tx);
      await s.as("investigatorA");
      await attestCall(opened.record, 1)(s.tx);
      await s.asOwner();
      expect(
        await s.tx`select user_id, scope from exchange.bcp_record_attestation where record_id = ${opened.record}
                   order by user_id`,
      ).toEqual([
        { user_id: USERS.investigatorA, scope: "FULL" },
        { user_id: USERS.legal, scope: "OWN_PARTICIPATION" },
      ]);
      expect(await recordState(s, opened.record)).toEqual({ status: "READY_TO_COMMIT", revision: 1 });
    });
  });

  it("R9: the subject of a paper-noted conflict in the chair's seat oversees nothing: no activation, no decision, no other member's attestation and no reason, and they cannot end the activation that replaced them", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened } = await prepared(s, {
        subject: "committeeChair",
        chairSigner: "investigatorA",
      });
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.as("committeeSecretary");
      const [a] = await activateCall(
        opened.record,
        "CONFLICTED",
        `Synthetic: the chair is the subject of a conflict noted on paper (${MARK}).`,
      )(s.tx);
      const activation = (a as unknown as { id: string }).id;
      // Not an overseer, so the activation is not theirs to see or end (a conflict's subject never decides on it).
      await s.as("committeeChair");
      await s.expectError("CDF_NOT_FOUND", endCall(activation));
      await s.as("investigatorA");
      await decideCall(opened.record, 1, "APPROVE")(s.tx);
      await s.as("committeeChair");
      await attestCall(opened.record, 1)(s.tx);
      await s.as("legal");
      await attestCall(
        opened.record,
        1,
        "DECLINE",
        "CONFLICT_SCOPE_MISMATCH",
        `Synthetic: the conflict's scope is wrong (${MARK}).`,
      )(s.tx);
      await s.as("committeeSecretary");
      await returnCall(opened.record, `Synthetic: returned for correction (${MARK}).`)(s.tx);

      const mine = await reads(s, "committeeChair", opened.record);
      expect(mine).toEqual({
        documents: [],
        roster: [USERS.committeeChair],
        decisions: [],
        attestations: [
          { user_id: USERS.committeeChair, action: "ATTEST", discrepancy_code: null, reason: null },
        ],
        acting: [],
      });
      const reasons = await s.tx<{ reason: string | null }[]>`
        select reason from exchange.bcp_record_acting_chair where record_id = ${opened.record}
        union all select reason from exchange.bcp_record_decision where record_id = ${opened.record}
        union all select reason from exchange.bcp_record_attestation where record_id = ${opened.record}`;
      expect(reasons).toEqual([{ reason: null }]);
      expect(JSON.stringify(mine)).not.toContain(MARK);
      // The overseers who are not the subject still read all of it.
      for (const u of ["investigatorA", "committeeSecretary"] as const) {
        const theirs = await reads(s, u, opened.record);
        expect(theirs.acting.map((x) => x.basis)).toEqual(["CONFLICTED"]);
        expect(theirs.decisions.map((d) => d.decision).sort()).toEqual(["APPROVE", "RETURN"]);
        expect(theirs.attestations.find((x) => x.user_id === USERS.legal)?.reason).toContain(MARK);
      }
    });
  });

  it("R9: the subject of a paper-noted conflict in the deputy chair's seat oversees nothing either, and is never activated", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened } = await prepared(s, { subject: "investigatorA" });
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:NO_ELIGIBLE_DEPUTY",
        activateCall(opened.record, "UNAVAILABLE", `Synthetic: the chair is unavailable (${MARK}).`),
      );
      await s.as("committeeChair");
      await decideCall(opened.record, 1, "APPROVE")(s.tx);
      await s.as("investigatorA");
      await attestCall(opened.record, 1)(s.tx);
      await s.as("legal");
      await attestCall(
        opened.record,
        1,
        "DECLINE",
        "CONFLICT_SCOPE_MISMATCH",
        `Synthetic: the conflict's scope is wrong (${MARK}).`,
      )(s.tx);
      await s.as("committeeSecretary");
      await returnCall(opened.record, `Synthetic: returned for correction (${MARK}).`)(s.tx);

      const mine = await reads(s, "investigatorA", opened.record);
      expect(mine).toEqual({
        documents: [],
        roster: [USERS.investigatorA],
        decisions: [],
        attestations: [
          { user_id: USERS.investigatorA, action: "ATTEST", discrepancy_code: null, reason: null },
        ],
        acting: [],
      });
      expect(JSON.stringify(mine)).not.toContain(MARK);
      const theirs = await reads(s, "committeeChair", opened.record);
      expect(theirs.decisions.map((d) => d.decision).sort()).toEqual(["APPROVE", "RETURN"]);
      expect(theirs.attestations.find((x) => x.user_id === USERS.legal)?.reason).toContain(MARK);
      expect(theirs.roster).toHaveLength(Object.keys(opened.roster).length);
    });
  });

  it("§7: a line's capacity is its seat, not its person: one person holds one seat in a proceeding and one roster line, so a secretary seat never attests and a member seat always does", async () => {
    // If the seat model ever let one person hold a secretary seat and a member seat on the same committee, opening a
    // record would refuse the second line (fail closed) and this pin would fail, forcing the capacity rule to be
    // revisited: the member seat's line would be required and attested in that capacity only (coordinator, 21:01 UTC).
    const unique = async (table: string) =>
      (
        await admin<{ def: string }[]>`
          select pg_get_constraintdef(c.oid) as def from pg_constraint c
          where c.conrelid = ${table}::regclass and c.contype = 'u'
          order by pg_get_constraintdef(c.oid) collate "C"`
      ).map((r) => r.def);
    expect(await unique("committee.proceeding_member")).toContain(
      "UNIQUE (committee_proceeding_id, user_id)",
    );
    expect(await unique("exchange.bcp_record_roster")).toContain("UNIQUE (record_id, user_id)");
    const [fn] = await admin<{ src: string }[]>`
      select prosrc as src from pg_proc where oid = 'exchange.bcp_record_line_state(uuid)'::regprocedure`;
    expect(fn!.src).toContain(
      "if v_line.seat in ('SECRETARY', 'ALTERNATE_SECRETARY') then return 'NOT_REQUIRED'",
    );
  });
});

describe("reconciliation blocks commit (§8, §11)", () => {
  it("11: a signatory shown absent or recused, a deputy signing for an available chair, or a member's decline blocks the record; codes only reach the ledger", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened } = await prepared(s, {
        declared: { legalB: { attendance: "ABSENT", signature_visible: true } },
      });
      // Signed while absent: refused at submission, audited, nothing moves.
      expect(await submitRecord(s, batch)).toBe("RECONCILIATION_FAILED");
      await s.asOwner();
      expect(await s.tx`select status from exchange.bcp_import_batch where id = ${batch}`).toEqual([
        { status: "STAGED" },
      ]);
      expect(await recordState(s, opened.record)).toEqual({ status: "DRAFT", revision: 1 });
      // A recused member shown as a signatory; the deputy signing for a chair who could act.
      await declare(s, opened, { lead: { attendance: "RECUSED", signature_visible: true } });
      expect(await submitRecord(s, batch)).toBe("RECONCILIATION_FAILED");
      await declare(s, opened, {}, "investigatorA");
      expect(await submitRecord(s, batch)).toBe("RECONCILIATION_FAILED");
      expect(await failedCodes(s, batch)).toEqual([
        ["SUBMISSION", "SIGNATURE_MISMATCH"],
        ["SUBMISSION", "CONFLICT_SCOPE_MISMATCH"],
        ["SUBMISSION", "SIGNATURE_MISMATCH"],
      ]);

      await declare(s, opened);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.as("committeeChair");
      await decideCall(opened.record, 1, "APPROVE")(s.tx);
      // A member declines: the record waits for correction however the others attest.
      await s.as("legalB");
      expect(
        (
          await attestCall(
            opened.record,
            1,
            "DECLINE",
            "ATTENDANCE_MISMATCH",
            `Synthetic: I left before the end (${MARK}).`,
          )(s.tx)
        )[0]!.r,
      ).toBe("DECLINED_WITH_REASON");
      for (const u of ["legal", "lead", "investigatorA"] as const) {
        await s.as(u);
        await attestCall(opened.record, 1)(s.tx);
      }
      await s.asOwner();
      expect(await recordState(s, opened.record)).toEqual({
        status: "PLATFORM_ATTESTATION_IN_PROGRESS",
        revision: 1,
      });
      expect((await failedCodes(s, batch)).at(-1)).toEqual(["ATTESTATION", "ATTENDANCE_MISMATCH"]);
      const h = await submitHash(s, batch);
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:RECORD_NOT_READY", applyCall(batch, h));
      // The decline and its reason reach the secretary and the chair; another member reads only their own line.
      for (const u of ["committeeSecretary", "committeeChair"] as const)
        expect(
          (await reads(s, u, opened.record)).attestations.filter((a) => a.action === "DECLINE"),
          u,
        ).toEqual([
          {
            user_id: USERS.legalB,
            action: "DECLINE",
            discrepancy_code: "ATTENDANCE_MISMATCH",
            reason: expect.stringContaining(MARK),
          },
        ]);
      const lead = await reads(s, "lead", opened.record);
      expect(lead.attestations.map((a) => a.user_id)).toEqual([USERS.lead]);
      expect(JSON.stringify(lead)).not.toContain(MARK);
      const events = await recordEvents(s, batch);
      expect(events.find((e) => e.action === "MEMBER_DECLINED_IMPORTED_RECORD")).toMatchObject({
        reason: null,
        metadata: expect.objectContaining({
          discrepancy_code: "ATTENDANCE_MISMATCH",
          roster_id: opened.roster.legalB,
        }),
      });
      expect(JSON.stringify(events)).not.toContain(MARK);
      expect(await outbox(s, batch)).toEqual(
        expect.arrayContaining([
          { template_code: "COMMITTEE_RECORD_RETURNED", recipient_id: USERS.committeeSecretary },
        ]),
      );
    });
  });
});

describe("corrections are new versions on a new revision (§3, §7, §15; R6)", () => {
  it("17, R6: a returned record is corrected by a new linked version, reconciled again, and approved again on the new revision; a version is never completed after submission and completion bumps nothing", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened, document: v1 } = await prepared(s);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      // The chair returns it for correction: a new revision; the batch stays as submitted.
      await s.as("committeeChair");
      await s.expectError("CDF_INVALID:reason", decideCall(opened.record, 1, "RETURN"));
      expect(
        (await decideCall(opened.record, 1, "RETURN", "Synthetic: the wrong page was scanned.")(s.tx))[0]!.r,
      ).toBe("RETURNED");
      await s.asOwner();
      expect(await recordState(s, opened.record)).toEqual({ status: "RETURNED", revision: 2 });
      expect(await s.tx`select status from exchange.bcp_import_batch where id = ${batch}`).toEqual([
        { status: "SUBMITTED" },
      ]);

      // A second version dated another day: stored, it makes the source ambiguous; marked, it fails the date.
      await s.as("committeeSecretary");
      const date = await meetingDate(s, batch);
      const dayBefore = (await s.tx<{ d: string }[]>`select (${date}::date - 1)::text as d`)[0]!.d;
      const v2 = await uploadMinutes(s, batch, opened.record, { meetingDate: dayBefore, mark: false });
      expect(v2.version).toBe(2);
      expect(await submitRecord(s, batch)).toBe("RECONCILIATION_FAILED");
      await s.expectError("CDF_CONFLICT:ALREADY_SIGNED", markCall(v1));
      await markCall(v2.document)(s.tx);
      expect(await submitRecord(s, batch)).toBe("RECONCILIATION_FAILED");
      // A third version, correctly dated, marked: submitted again on revision 2.
      const v3 = await uploadMinutes(s, batch, opened.record);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.asOwner();
      expect(
        await s.tx`select version_no, status, supersedes_id from exchange.bcp_record_document
                   where record_id = ${opened.record} order by version_no`,
      ).toEqual([
        { version_no: 1, status: "SIGNED_OFFICIAL_RECORD", supersedes_id: null },
        { version_no: 2, status: "SIGNED_OFFICIAL_RECORD", supersedes_id: v1 },
        { version_no: 3, status: "SIGNED_OFFICIAL_RECORD", supersedes_id: v2.document },
      ]);
      expect(
        await s.tx`select signed_document_id from exchange.bcp_committee_record where id = ${opened.record}`,
      ).toEqual([{ signed_document_id: v3.document }]);
      expect(await failedCodes(s, batch)).toEqual([
        ["SUBMISSION", "DOCUMENT_VERSION_MISMATCH"],
        ["SUBMISSION", "DOCUMENT_VERSION_MISMATCH"],
      ]);

      // A stale decision is refused; the secretary returns it once more and registers a fourth version, still
      // quarantined when the record is submitted again.
      await s.as("committeeChair");
      await s.expectError("CDF_CONFLICT:REVISION_CHANGED", decideCall(opened.record, 1, "APPROVE"));
      await s.as("committeeSecretary");
      await returnCall(opened.record)(s.tx);
      const v4 = await uploadMinutes(s, batch, opened.record, { complete: false });
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.asOwner();
      expect(await recordState(s, opened.record)).toEqual({ status: "PENDING_CHAIR_APPROVAL", revision: 3 });
      // R6: that version cannot be completed while the record is with the chair or the members; nothing moves.
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:RECORD_NOT_EDITABLE", completeCall(v4.document));
      await s.asOwner();
      expect(await recordState(s, opened.record)).toEqual({ status: "PENDING_CHAIR_APPROVAL", revision: 3 });
      expect(await s.tx`select status from exchange.bcp_record_document where id = ${v4.document}`).toEqual([
        { status: "QUARANTINED" },
      ]);
      await s.as("committeeChair");
      await decideCall(opened.record, 3, "RETURN", "Synthetic: a newer scan exists.")(s.tx);
      // After the return it completes, and completion still moves no revision.
      await s.as("committeeSecretary");
      await completeCall(v4.document)(s.tx);
      await s.asOwner();
      expect(await recordState(s, opened.record)).toEqual({ status: "RETURNED", revision: 4 });
      await s.as("committeeSecretary");
      await markCall(v4.document)(s.tx);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.as("committeeChair");
      await decideCall(opened.record, 4, "APPROVE")(s.tx);
      // E7: an attestation given for a revision that a return has replaced is refused.
      await s.as("legal");
      await s.expectError("CDF_CONFLICT:REVISION_CHANGED", attestCall(opened.record, 3));
      await attestAll(s, opened, 4);
      expect(await commitRecord(s, batch)).toMatchObject({ imported: 2 });

      const actions = (await recordEvents(s, batch)).map((e) => e.action);
      expect(actions.filter((a) => a === "BCP_IMPORT_SUBMITTED")).toHaveLength(1);
      expect(actions.filter((a) => a === "COMMITTEE_RECORD_SUBMITTED")).toHaveLength(4);
      expect(actions.filter((a) => a.startsWith("OFFICIAL_MINUTES_"))).toEqual([
        "OFFICIAL_MINUTES_REGISTERED",
        "OFFICIAL_MINUTES_UPLOADED",
        "OFFICIAL_MINUTES_MARKED_SIGNED",
        "OFFICIAL_MINUTES_REGISTERED",
        "OFFICIAL_MINUTES_VERSIONED",
        "OFFICIAL_MINUTES_MARKED_SIGNED",
        "OFFICIAL_MINUTES_REGISTERED",
        "OFFICIAL_MINUTES_VERSIONED",
        "OFFICIAL_MINUTES_MARKED_SIGNED",
        "OFFICIAL_MINUTES_REGISTERED",
        "OFFICIAL_MINUTES_VERSIONED",
        "OFFICIAL_MINUTES_MARKED_SIGNED",
      ]);
      expect(actions).toEqual(
        expect.arrayContaining([
          "CHAIR_RETURNED_IMPORTED_RECORD",
          "COMMITTEE_RECORD_RETURNED",
          "COMMITTEE_WORKBOOK_COMMITTED",
        ]),
      );
    });
  });

  it("16: a committed record and its signed minutes can never be changed, replaced, returned or removed", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened, document } = await prepared(s);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.as("committeeChair");
      await decideCall(opened.record, 1, "APPROVE")(s.tx);
      await attestAll(s, opened, 1);
      await commitRecord(s, batch);
      await s.as("committeeSecretary");
      const date = await meetingDate(s, batch);
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:RECORD_NOT_EDITABLE", registerCall(opened.record, date));
      await s.expectError("CDF_CONFLICT:RECORD_NOT_EDITABLE", markCall(document));
      await s.expectError(
        "CDF_CONFLICT:RECORD_NOT_EDITABLE",
        declareCall(opened.record, declaration(opened)),
      );
      await s.expectError("CDF_CONFLICT:NOT_RETURNABLE", returnCall(opened.record));
      await s.expectError(
        "CDF_CONFLICT:NOT_OPEN",
        (tx) => tx`select api.cancel_bcp_import(${batch}, ${RECORD_REASON})`,
      );
      // Not even the table owner rewrites it.
      await s.asOwner();
      await s.expectError(
        "signed minutes version",
        (tx) =>
          tx`update exchange.bcp_record_document set object_key = 'committee-records/x' where id = ${document}`,
      );
      await s.expectError(
        "committee record",
        (tx) => tx`update exchange.bcp_committee_record set status = 'RETURNED' where id = ${opened.record}`,
      );
      await s.expectError(
        "roster line",
        (tx) =>
          tx`update exchange.bcp_record_roster set signature_visible = false where record_id = ${opened.record}`,
      );
      await s.expectError(
        "committee record evidence is append-only",
        (tx) =>
          tx`update exchange.bcp_record_attestation set action = 'DECLINE' where record_id = ${opened.record}`,
      );
      await s.expectError(
        "committee record evidence is append-only",
        (tx) =>
          tx`update exchange.bcp_record_decision set decision = 'REJECT' where record_id = ${opened.record}`,
      );
      for (const table of [
        "bcp_committee_record",
        "bcp_record_roster",
        "bcp_record_document",
        "bcp_record_decision",
        "bcp_record_attestation",
      ])
        await s.expectError("committee record rows are never deleted", (tx) =>
          tx.unsafe(`delete from exchange.${table} where id is not null`),
        );
      for (const table of ["bcp_record_decision", "bcp_record_attestation"])
        await s.expectError("committee record rows are never deleted", (tx) =>
          tx.unsafe(`truncate exchange.${table}`),
        );
      expect(
        await s.tx`select count(*)::int as n from exchange.bcp_record_document where id = ${document}
                   and status = 'SIGNED_OFFICIAL_RECORD'`,
      ).toEqual([{ n: 1 }]);
    });
  });
});

describe("restricted cases (§10)", () => {
  it("13: the signed minutes stay invisible to anyone who does not pass the case's gate today, and uploading them grants nothing", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened, document } = await prepared(s);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      // The case is restricted and classified above one member's clearance (owner fixture).
      await s.asOwner();
      await s.tx`update case_mgmt.case_record set is_restricted = true, classification = 'CONFIDENTIAL' where id = ${caseB}`;
      await s.tx`update iam.user_profile set clearance = 'RESTRICTED' where id = ${USERS.legalB}`;
      for (const u of ["legalB", "grcDirector", "caseManager", "grcSectorHead"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", openDocCall(document));
        await s.expectError("CDF_NOT_FOUND", attestCall(opened.record, 1));
        expect(await s.tx`select id from exchange.bcp_record_document`, u).toEqual([]);
        expect(await s.tx`select id from exchange.bcp_committee_record`, u).toEqual([]);
      }
      // Those cleared keep reading it, through the audited path only.
      await s.as("committeeChair");
      expect(await s.tx`select o_sha256 from api.open_committee_record_document(${document})`).toEqual([
        { o_sha256: MINUTES_SHA },
      ]);
      await decideCall(opened.record, 1, "APPROVE")(s.tx);
      expect(await states(s, batch, opened)).toMatchObject({ legalB: "INELIGIBLE" });
      // Nothing in the record flow gave anyone a seat, a grant or a proceeding line.
      await s.asOwner();
      expect(
        await s.tx`select count(*)::int as n from committee.proceeding_member pm
                   join committee.committee_proceeding cp on cp.id = pm.committee_proceeding_id
                   where cp.case_id = ${caseB}`,
      ).toEqual([{ n: 6 }]);
      const opens = (await recordEvents(s, batch)).filter((e) => e.action === "OFFICIAL_MINUTES_OPENED");
      expect(opens).toHaveLength(1);
    });
  });
});

describe("votes stay individual and secret (§6, §13)", () => {
  it("18: the record creates no vote, a vote sheet never imports, and a member sees only their own line while attesting", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened } = await prepared(s);
      await s.as("committeeSecretary");
      const [vote] = await s.tx<{ id: string }[]>`
        select id from exchange.bcp_import_row where batch_id = ${batch} and sheet_code = '12_VOTES'`;
      await s.expectError(
        "CDF_CONFLICT:RESOLUTION_NOT_ALLOWED",
        (tx) => tx`select api.resolve_bcp_row(${vote!.id}, 'IMPORT', ${WHY})`,
      );
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.as("committeeChair");
      await decideCall(opened.record, 1, "APPROVE")(s.tx);
      await s.as("legal");
      await attestCall(opened.record, 1)(s.tx);
      for (const u of ["legalB", "lead"] as const) {
        const v = await reads(s, u, opened.record);
        expect(v).toEqual({
          documents: [{ version_no: 1, status: "SIGNED_OFFICIAL_RECORD" }],
          roster: [USERS[u]],
          decisions: [],
          attestations: [],
          acting: [],
        });
        expect(JSON.stringify(await s.tx`select * from exchange.bcp_committee_record`)).not.toMatch(
          /vote|ballot/i,
        );
      }
      await attestAll(s, opened, 1);
      await commitRecord(s, batch);
      await s.asOwner();
      const [rec] = await s.tx<{ meeting_id: string }[]>`
        select meeting_id from exchange.bcp_committee_record where id = ${opened.record}`;
      expect(
        await s.tx`select (select count(*)::int from committee.vote_item where meeting_id = ${rec!.meeting_id}) as items,
                          (select count(*)::int from committee.vote v join committee.vote_item i on i.id = v.vote_item_id
                           where i.meeting_id = ${rec!.meeting_id}) as votes`,
      ).toEqual([{ items: 0, votes: 0 }]);
    });
  });
});

describe("one meeting per record (E1)", () => {
  it("a workbook reconstructing two meetings, or raising a conflict about a meeting held online, never opens a record, and a second meeting restored after opening is refused at submission", async () => {
    await ownerScenario(async (s) => {
      const { batch, t } = await workbook(s, {
        rows: (t) => [
          meetingRow(t, 3, "BCP-M1"),
          meetingRow(t, 4, "BCP-M2", { HELD_START: t.secondStart, HELD_END: t.secondEnd }),
        ],
      });
      // Refused at opening: two meetings are two workbooks.
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:ONE_MEETING_PER_RECORD",
        (tx) => tx`select api.open_committee_record(${batch})`,
      );
      await s.asOwner();
      expect(await s.tx`select id from exchange.bcp_committee_record where batch_id = ${batch}`).toEqual([]);

      // With the second meeting set aside the record opens; restoring it before submission is refused there.
      await s.as("committeeSecretary");
      const [m2] = await s.tx<{ id: string }[]>`
        select id from exchange.bcp_import_row where batch_id = ${batch} and row_key = 'BCP-M2'`;
      await s.tx`select api.resolve_bcp_row(${m2!.id}, 'SKIP', ${WHY})`;
      const opened = await openRecord(s, batch);
      await declare(s, opened);
      await s.asOwner();
      const d = (
        await s.tx<{ d: string }[]>`
        select ((${t.heldStart}::timestamptz) at time zone 'Asia/Riyadh')::date::text as d`
      )[0]!.d;
      await uploadMinutes(s, batch, opened.record, { meetingDate: d });
      await s.as("committeeSecretary");
      await s.tx`select api.resolve_bcp_row(${m2!.id}, 'IMPORT', ${WHY})`;
      await s.tx`select api.preview_bcp_import(${batch})`;
      await s.asOwner();
      expect(
        await s.tx`select exchange.bcp_record_meeting_row(${opened.record}) as row`,
        "two meetings: no single meeting row",
      ).toEqual([{ row: null }]);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:ONE_MEETING_PER_RECORD",
        submitCall(batch, await submitHash(s, batch)),
      );
      // Cancelling the workbook cancels its record.
      await s.tx`select api.cancel_bcp_import(${batch}, ${RECORD_REASON})`;
      await s.asOwner();
      expect(await recordState(s, opened.record)).toMatchObject({ status: "CANCELLED" });

      // A conflict noted on paper about a meeting the committee holds online: no record opens.
      await s.as("committeeSecretary");
      const [online] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(m.committee_proceeding_id, 'DELIBERATION', 'IN_PERSON', 'Meeting room (synthetic)',
          null, now() + interval '1 day', now() + interval '1 day 2 hours', ${REASON}) as id
        from exchange.bcp_import_batch m where m.id = ${batch}`;
      const [b2] = await s.tx<{ id: string }[]>`
        select api.stage_bcp_import(${s.tx.json(control(t, (await s.tx<{ cp: string }[]>`select committee_proceeding_id as cp from exchange.bcp_import_batch where id = ${batch}`)[0]!.cp, { WORKBOOK_ID: "BCP-DEMO-C-0116" }) as never)}::jsonb,
          ${SHA}, ${s.tx.json([meetingRow(t, 3, "BCP-M1"), conflictRow(t, 3, "BCP-K9", online!.id, "legal")] as never)}::jsonb) as id`;
      await s.expectError(
        "CDF_CONFLICT:ONE_MEETING_PER_RECORD",
        (tx) => tx`select api.open_committee_record(${b2!.id})`,
      );
    });
  });
});

describe("rejection (§3, §13)", () => {
  it("the chair rejects with a reason that stays in the record; the workbook is rejected and goes no further", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened } = await prepared(s);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.as("committeeChair");
      await s.expectError("CDF_INVALID:decision", decideCall(opened.record, 1, "DEEMED_ATTESTED"));
      await s.expectError("CDF_INVALID:reason", decideCall(opened.record, 1, "REJECT"));
      await decideCall(opened.record, 1, "REJECT", `Synthetic: not this meeting (${MARK}).`)(s.tx);
      await s.asOwner();
      expect(await recordState(s, opened.record)).toEqual({ status: "REJECTED", revision: 1 });
      expect(
        await s.tx`select status, decided_by from exchange.bcp_import_batch where id = ${batch}`,
      ).toEqual([{ status: "REJECTED", decided_by: USERS.committeeChair }]);
      const events = await recordEvents(s, batch);
      expect(events.map((e) => e.action)).toContain("CHAIR_REJECTED_IMPORTED_RECORD");
      expect(JSON.stringify(events)).not.toContain(MARK);
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:RECORD_NOT_EDITABLE", submitCall(batch, await submitHash(s, batch)));
      await s.expectError("CDF_CONFLICT:RECORD_NOT_READY", applyCall(batch, await submitHash(s, batch)));
      await s.expectError("CDF_CONFLICT:NOT_RETURNABLE", returnCall(opened.record));
    });
  });
});

describe("E7 and R8: locking, and nobody outside the record", () => {
  it("E7: every record command locks the workbook and the record before it reads a state or a revision", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const fns = await s.tx<{ name: string; src: string }[]>`
        select p.proname as name, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'api' and p.proname in ('open_committee_record', 'declare_committee_record_roster',
          'register_committee_record_document', 'complete_committee_record_document', 'mark_committee_minutes_signed',
          'activate_record_acting_chair', 'end_record_acting_chair', 'decide_committee_record',
          'return_committee_record', 'attest_committee_record', 'submit_bcp_import', 'apply_bcp_import',
          'cancel_bcp_import')
        order by 1`;
      expect(fns).toHaveLength(13);
      for (const f of fns) {
        const lock = f.src.indexOf("exchange.lock_bcp_");
        expect(lock, f.name).toBeGreaterThan(0);
        for (const probe of [".status", ".revision", "revision"]) {
          const at = f.src.indexOf(probe);
          if (at >= 0) expect(at, `${f.name} reads ${probe} before locking`).toBeGreaterThan(lock);
        }
      }
    });
  });

  it("R8: an unknown id is NOT_FOUND everywhere; a member cannot take the importer's steps; an external account and a former deputy are out", async () => {
    await ownerScenario(async (s) => {
      const { batch, opened, document } = await prepared(s);
      const ghost = randomUUID();
      await s.as("committeeSecretary");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.open_committee_record(${ghost})`);
      await s.expectError("CDF_NOT_FOUND", declareCall(ghost, []));
      await s.expectError("CDF_NOT_FOUND", registerCall(ghost, "2026-01-01"));
      await s.expectError("CDF_NOT_FOUND", completeCall(ghost));
      await s.expectError("CDF_NOT_FOUND", markCall(ghost));
      await s.expectError("CDF_NOT_FOUND", openDocCall(ghost));
      await s.expectError("CDF_NOT_FOUND", activateCall(ghost, "ABSENT"));
      await s.expectError("CDF_NOT_FOUND", endCall(ghost));
      await s.expectError("CDF_NOT_FOUND", decideCall(ghost, 1, "APPROVE"));
      await s.expectError("CDF_NOT_FOUND", returnCall(ghost));
      await s.expectError("CDF_NOT_FOUND", attestCall(ghost, 1));
      // A member of the roster reads the record but never takes the importer's steps.
      await s.as("lead");
      await s.expectError("CDF_NOT_FOUND", declareCall(opened.record, declaration(opened)));
      await s.expectError("CDF_NOT_FOUND", markCall(document));
      await s.expectError("CDF_NOT_FOUND", returnCall(opened.record));
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.open_committee_record(${batch})`);
      // The deputy's seat ends: no longer on the record, never activated.
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(m.id, now(), ${REASON}) from committee.membership m
                 where m.user_id = ${USERS.investigatorA} and m.ended_at is null`;
      await s.as("investigatorA");
      expect(await s.tx`select id from exchange.bcp_committee_record`).toEqual([]);
      expect(await s.tx`select id from exchange.bcp_record_roster`).toEqual([]);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      expect(await states(s, batch, opened)).toMatchObject({ investigatorA: "INELIGIBLE" });
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:CHAIR_AVAILABLE", activateCall(opened.record, "ABSENT"));
      // An external account is never a reader of the record. A seated member cannot be flagged (2100 refuses it), so
      // the owner records the flag directly to prove the record's own check.
      await s.asOwner();
      await s.tx`insert into iam.external_account (user_id, engagement_reference, reason, flagged_by)
                 values (${USERS.legalB}, 'ENG-DEMO-2115-0001', 'Synthetic: counsel engaged.', ${USERS.platformAdmin})`;
      await s.as("legalB");
      await s.expectError("CDF_NOT_FOUND", openDocCall(document));
      expect(await s.tx`select id from exchange.bcp_committee_record`).toEqual([]);
    });
  });
});
