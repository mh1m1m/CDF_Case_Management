// The official record of a committee continuity workbook (migration 2115, ADR-061; the owner's decision on AMB-201):
// the signed minutes (Layer 1) and the platform approval and attestations (Layer 2). Every step runs through the api.*
// commands as the acting user; nothing is inserted directly. Synthetic data only.
import { USERS, type OwnerScenario, type Scenario, type UserKey } from "./db";

export const MINUTES_SHA = "d".repeat(64);
export const MINUTES_TEMPLATE = "CDF-MINUTES-TEMPLATE-DEMO";
export const RECORD_REASON = "Synthetic: committee record test.";

const KEY_BY_ID = Object.fromEntries(Object.entries(USERS).map(([key, id]) => [id, key])) as Record<
  string,
  UserKey
>;

/** The user key of a seeded user id. */
export const userKey = (id: string): UserKey => KEY_BY_ID[id]!;

export interface Declared {
  attendance: "ATTENDED" | "ATTENDED_PART" | "ABSENT" | "RECUSED";
  joined_late?: boolean;
  left_early?: boolean;
  signature_visible?: boolean;
  signed_as_chair?: boolean;
}

export interface OpenedRecord {
  record: string;
  /** Roster line id by user key. */
  roster: Partial<Record<UserKey, string>>;
}

/** The importer opens the record of a staged committee workbook. */
export async function openRecord(
  s: Scenario,
  batch: string,
  importer: UserKey = "committeeSecretary",
): Promise<OpenedRecord> {
  await s.as(importer);
  const [r] = await s.tx<{ id: string }[]>`select api.open_committee_record(${batch}) as id`;
  const lines = await s.tx<{ id: string; user_id: string }[]>`
    select id, user_id from exchange.bcp_record_roster where record_id = ${r!.id}`;
  const roster: Partial<Record<UserKey, string>> = {};
  for (const l of lines) roster[userKey(l.user_id)] = l.id;
  return { record: r!.id, roster };
}

/** Every line ATTENDED with a visible signature unless overridden; `chairSigner` signed as chair (none if null). */
export function declaration(
  opened: OpenedRecord,
  overrides: Partial<Record<UserKey, Declared>> = {},
  chairSigner: UserKey | null = "committeeChair",
) {
  return Object.entries(opened.roster).map(([key, id]) => {
    const d: Declared = overrides[key as UserKey] ?? { attendance: "ATTENDED" };
    const visible = d.signature_visible ?? (d.attendance === "ATTENDED" || d.attendance === "ATTENDED_PART");
    return {
      roster_id: id,
      attendance: d.attendance,
      joined_late: d.joined_late ?? false,
      left_early: d.left_early ?? false,
      signature_visible: visible,
      signed_as_chair: d.signed_as_chair ?? key === chairSigner,
    };
  });
}

export const declareCall = (record: string, lines: unknown[]) => (tx: Scenario["tx"]) =>
  tx`select api.declare_committee_record_roster(${record}, ${tx.json(lines as never)}::jsonb)`;

/** The importer declares the roster from the signed minutes. */
export async function declare(
  s: Scenario,
  opened: OpenedRecord,
  overrides: Partial<Record<UserKey, Declared>> = {},
  chairSigner: UserKey | null = "committeeChair",
  importer: UserKey = "committeeSecretary",
): Promise<void> {
  await s.as(importer);
  await declareCall(opened.record, declaration(opened, overrides, chairSigner))(s.tx);
}

/** The Riyadh calendar day of the workbook's meeting (its one 09_MEETINGS row), as its importer reads it. */
export async function meetingDate(
  s: Scenario,
  batch: string,
  importer: UserKey = "committeeSecretary",
): Promise<string> {
  await s.as(importer);
  const [r] = await s.tx<{ d: string }[]>`
    select ((x.original_event_at at time zone 'Asia/Riyadh')::date)::text as d from exchange.bcp_import_row x
    where x.batch_id = ${batch} and x.sheet_code = '09_MEETINGS' and x.resolution = 'IMPORT'`;
  return r!.d;
}

export interface MinutesOptions {
  contentType?: string;
  fileName?: string;
  meetingDate?: string;
  sha256?: string;
  classification?: string;
}

export const registerCall =
  (record: string, date: string, o: MinutesOptions = {}) =>
  (tx: Scenario["tx"]) =>
    tx<{ o_document_id: string; o_version_no: number; o_object_key: string }[]>`
    select * from api.register_committee_record_document(${record}, ${o.fileName ?? "signed-minutes-demo.pdf"},
      ${o.contentType ?? "application/pdf"}, 2048, ${o.sha256 ?? MINUTES_SHA}, ${o.meetingDate ?? date}::date,
      ${MINUTES_TEMPLATE}, ${o.classification ?? "CONFIDENTIAL"}::core.classification_level)`;

/** Registers a version of the signed minutes, completes it (stored, scan CLEAN) and, unless `mark` is false, marks it
 *  as the signed official record. */
export async function uploadMinutes(
  s: Scenario,
  batch: string,
  record: string,
  o: MinutesOptions & { complete?: boolean; mark?: boolean } = {},
  importer: UserKey = "committeeSecretary",
): Promise<{ document: string; version: number; objectKey: string }> {
  const date = o.meetingDate ?? (await meetingDate(s, batch, importer));
  await s.as(importer);
  const [d] = await registerCall(record, date, o)(s.tx);
  if (o.complete ?? true) {
    await s.tx`select api.complete_committee_record_document(${d!.o_document_id}, 'CLEAN', 'synthetic-scanner')`;
    if (o.mark ?? true) await s.tx`select api.mark_committee_minutes_signed(${d!.o_document_id})`;
  }
  return { document: d!.o_document_id, version: d!.o_version_no, objectKey: d!.o_object_key };
}

/** The hash a submission carries: the preview's while STAGED, the submitted one after. */
export async function submitHash(s: Scenario, batch: string): Promise<string> {
  const [b] = await s.tx<{ h: string }[]>`
    select coalesce(submitted_hash, preview_hash) as h from exchange.bcp_import_batch where id = ${batch}`;
  return b!.h;
}

/** The importer submits the workbook with its record to the chair: SUBMITTED or RECONCILIATION_FAILED. */
export async function submitRecord(
  s: Scenario,
  batch: string,
  importer: UserKey = "committeeSecretary",
): Promise<string> {
  await s.as(importer);
  const h = await submitHash(s, batch);
  const [r] = await s.tx<{ r: string }[]>`select api.submit_bcp_import(${batch}, ${h}) as r`;
  return r!.r;
}

export const decideCall =
  (record: string, revision: number, decision: string, reason: string | null = null) =>
  (tx: Scenario["tx"]) =>
    tx<
      { r: string }[]
    >`select api.decide_committee_record(${record}, ${revision}, ${decision}, ${reason}) as r`;

export const attestCall =
  (
    record: string,
    revision: number,
    action = "ATTEST",
    code: string | null = null,
    reason: string | null = null,
  ) =>
  (tx: Scenario["tx"]) =>
    tx<
      { r: string }[]
    >`select api.attest_committee_record(${record}, ${revision}, ${action}, ${code}, ${reason}) as r`;

/** The current revision and status of a record (owner read). */
export async function recordState(
  s: Scenario,
  record: string,
): Promise<{ status: string; revision: number }> {
  const [r] = await s.tx<{ status: string; revision: number }[]>`
    select status, revision from exchange.bcp_committee_record where id = ${record}`;
  return r!;
}

/** While the record awaits attestations, each roster line still PENDING on the current revision attests as itself
 *  (owner read of the derived line states). Returns who attested. */
export async function attestAll(
  s: OwnerScenario,
  opened: OpenedRecord,
  revision: number,
): Promise<UserKey[]> {
  await s.asOwner();
  const pending = new Set(
    (
      await s.tx<{ id: string }[]>`
        select l.id from exchange.bcp_record_roster l
        join exchange.bcp_committee_record r on r.id = l.record_id
        where r.id = ${opened.record} and r.status = 'PLATFORM_ATTESTATION_IN_PROGRESS'
          and exchange.bcp_record_line_state(l.id) = 'PENDING'`
    ).map((l) => l.id),
  );
  const done: UserKey[] = [];
  for (const [key, line] of Object.entries(opened.roster) as [UserKey, string][]) {
    if (!pending.has(line)) continue;
    await s.as(key);
    await attestCall(opened.record, revision)(s.tx);
    done.push(key);
  }
  return done;
}

/** The importer commits a READY_TO_COMMIT workbook. */
export async function commitRecord(
  s: Scenario,
  batch: string,
  importer: UserKey = "committeeSecretary",
): Promise<Record<string, number>> {
  await s.as(importer);
  const h = await submitHash(s, batch);
  const [r] = await s.tx<{ c: Record<string, number> }[]>`select api.apply_bcp_import(${batch}, ${h}) as c`;
  return r!.c;
}

/** The whole flow on the defaults: record opened, every line attending with a visible signature and the chair signing,
 *  the minutes uploaded and marked, submitted, approved by the chair, every required line attesting, committed. */
export async function commitThroughRecord(
  s: OwnerScenario,
  batch: string,
  overrides: Partial<Record<UserKey, Declared>> = {},
): Promise<{ opened: OpenedRecord; document: string; counts: Record<string, number> }> {
  const opened = await openRecord(s, batch);
  await declare(s, opened, overrides);
  const { document } = await uploadMinutes(s, batch, opened.record);
  const submitted = await submitRecord(s, batch);
  if (submitted !== "SUBMITTED") throw new Error(`commitThroughRecord: submission returned ${submitted}`);
  await s.as("committeeChair");
  await decideCall(opened.record, 1, "APPROVE")(s.tx);
  await attestAll(s, opened, 1);
  const counts = await commitRecord(s, batch);
  return { opened, document, counts };
}

/** Owner fixture: the proceeding's referral moved `days` back, so a meeting held on paper since then fits (2110 R2). */
export async function backdateReferral(s: OwnerScenario, proceeding: string, days = 3): Promise<void> {
  await s.asOwner();
  await s.tx`alter table committee.committee_proceeding disable trigger committee_proceeding_protect`;
  await s.tx`update committee.committee_proceeding set referred_at = now() - make_interval(days => ${days})
             where id = ${proceeding}`;
  await s.tx`alter table committee.committee_proceeding enable trigger committee_proceeding_protect`;
}

/** A signed paper ballot of the meeting (BCP-C2, migration 2120): the member, the target and the choice. */
export interface PaperBallot {
  voter: UserKey;
  kind: "FINDING" | "PACKAGE" | "RECOMMENDATION_ITEM";
  target: string;
  choice: string;
}

/** The importer (a registry entry for the proceeding) stages, resolves and previews a committee workbook of one
 *  meeting held on paper two days ago; the referral is backdated first. With `ballots`, the workbook is a BCP-C2
 *  one carrying them, signed half an hour into the meeting (their targets must predate it). Returns the batch and
 *  its preview hash. */
export async function stageOneMeetingWorkbook(
  s: OwnerScenario,
  proceeding: string,
  workbookId: string,
  committeeCode = "IC",
  importer: UserKey = "committeeSecretary",
  ballots: PaperBallot[] = [],
): Promise<{ batch: string; hash: string }> {
  await backdateReferral(s, proceeding);
  const iso = (expr: string) => `to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const [t] = await s.tx.unsafe<
    { from: string; start: string; signed: string; end: string; to: string; email: string }[]
  >(
    `select ${iso("now() - interval '2 days'")} as "from",
            ${iso("now() - interval '2 days' + interval '1 hour'")} as "start",
            ${iso("now() - interval '2 days' + interval '1 hour 30 minutes'")} as "signed",
            ${iso("now() - interval '2 days' + interval '3 hours'")} as "end",
            ${iso("now() - interval '1 day'")} as "to",
            (select email from iam.user_profile where id = $1) as email`,
    [USERS[importer]],
  );
  const voters = await s.tx<{ id: string; email: string }[]>`
    select id, email from iam.user_profile where id = any(${ballots.map((b) => USERS[b.voter])}::uuid[])`;
  const control = {
    TEMPLATE_VERSION: ballots.length ? "BCP-C2" : "BCP-C1",
    WORKBOOK_ID: workbookId,
    COMMITTEE_PROCEEDING_ID: proceeding,
    COMMITTEE_CODE: committeeCode,
    OFFLINE_FROM: t!.from,
    OFFLINE_TO: t!.to,
    PREPARED_BY: t!.email,
  };
  const rows = [
    {
      sheet: "09_MEETINGS",
      row_number: 3,
      has_formula: false,
      cells: {
        ROW_ID: "BCP-M1",
        ORIGINAL_EVENT_AT: t!.start,
        RECORDED_OFFLINE_BY: t!.email,
        PURPOSE: "DELIBERATION",
        MODE: "IN_PERSON",
        LOCATION: "Meeting room (synthetic)",
        HELD_START: t!.start,
        HELD_END: t!.end,
        PAPER_MINUTES_REFERENCE: "PAPER-MIN-DEMO-0001",
        REASON: "Synthetic: the committee met on paper during the outage.",
      },
    },
    ...ballots.map((b, i) => ({
      sheet: "12_VOTES",
      row_number: 3 + i,
      has_formula: false,
      cells: {
        ROW_ID: `BCP-V${i + 1}`,
        ORIGINAL_EVENT_AT: t!.signed,
        RECORDED_OFFLINE_BY: t!.email,
        MEETING_REF: "BCP-M1",
        PARTICIPANT: voters.find((v) => v.id === USERS[b.voter])!.email,
        TARGET_KIND: b.kind,
        TARGET_ID: b.target,
        CHOICE: b.choice,
        BALLOT_REFERENCE: `PAPER-BALLOT-DEMO-${i + 1}`,
      },
    })),
  ];
  await s.as(importer);
  const [b] = await s.tx<{ id: string }[]>`
    select api.stage_bcp_import(${s.tx.json(control as never)}::jsonb, ${"7".repeat(64)},
                                ${s.tx.json(rows as never)}::jsonb) as id`;
  const open = await s.tx<{ id: string }[]>`
    select id from exchange.bcp_import_row where batch_id = ${b!.id} and state in ('UNSUPPORTED', 'INVALID')`;
  for (const r of open) await s.tx`select api.resolve_bcp_row(${r.id}, 'SKIP', ${RECORD_REASON})`;
  const [p] = await s.tx<{ h: string }[]>`select api.preview_bcp_import(${b!.id}) ->> 'hash' as h`;
  return { batch: b!.id, hash: p!.h };
}
