// Business architecture rebase, migration 2120 (ADR-048; CDF-262): signed paper ballots. DEC-AMB-008 (the owner's
// decision on AMB-200, option B): "During an outage, substantive committee voting may use signed individual paper
// ballots. They are imported as provisional votes and must be confirmed by each relevant member through the platform
// after restoration before the vote becomes final. The Secretary may not cast APPROVE or REJECT on another member's
// behalf." Built on the coordinator's rulings of 2026-10-18 15:44 UTC on the four forks of 2120_DESIGN.md (F1 B′,
// F2 narrow, F3 importer only, F4 no notice). T-AMB-118 is pinned below. Every step runs through the api.* commands as
// `authenticated`; the owner connection only backdates the fixtures (the referral, the finding, the packages), reads
// the ballots, the votes and the ledger, and probes the table's integrity. Synthetic data only.
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
import {
  IC_SEATS,
  REASON,
  committeeIds,
  openWithPresent,
  refer,
  seat,
  type MeetingFixture,
} from "../support/committee";
import { caseFacts } from "../support/decision";
import { outcomes } from "../support/capabilities";
import {
  attestAll,
  commitRecord,
  commitThroughRecord,
  decideCall,
  declare,
  openRecord,
  submitRecord,
  uploadMinutes,
  userKey,
  type Declared,
} from "../support/committee-record";

type Tx = Scenario["tx"];

const SHA = "f".repeat(64);
const WB = "BCP-DEMO-C-0120";
const WHY = "Synthetic: resolved during the import review.";
/** The IC voters of IC_SEATS: the chair and the three members (the secretary never votes). */
const VOTERS: UserKey[] = ["committeeChair", "legal", "legalB", "lead"];

let caseB: string, ic: string;
const EMAIL: Record<string, string> = {};
beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
  const users = await admin<{ id: string; email: string }[]>`select id, email from iam.user_profile`;
  for (const [key, id] of Object.entries(USERS)) EMAIL[key] = users.find((u) => u.id === id)!.email;
});

interface Times {
  from: string;
  heldStart: string;
  /** When the paper ballots were signed: inside the meeting. */
  signed: string;
  heldEnd: string;
  /** After the meeting, still inside the offline window. */
  after: string;
  to: string;
}

async function times(s: OwnerScenario): Promise<Times> {
  await s.asOwner();
  const iso = (expr: string) => `to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const [r] = await s.tx.unsafe<Times[]>(
    `select ${iso("now() - interval '2 days'")} as "from",
            ${iso("now() - interval '2 days' + interval '1 hour'")} as "heldStart",
            ${iso("now() - interval '2 days' + interval '1 hour 30 minutes'")} as "signed",
            ${iso("now() - interval '2 days' + interval '3 hours'")} as "heldEnd",
            ${iso("now() - interval '2 days' + interval '4 hours'")} as "after",
            ${iso("now() - interval '1 day'")} as "to"`,
  );
  return r!;
}

interface Fixture {
  t: Times;
  cp: string;
  allegation: string;
  finding: string;
  /** Voted as a whole: one corrective action. */
  pkg: string;
  /** Voted item by item: two corrective actions. */
  itemPkg: string;
  items: string[];
}

/** The secretary drafts a package of `n` corrective actions and, unless `submit` is false, puts it to the vote. */
async function packageOf(
  s: Scenario,
  cp: string,
  granularity: "PACKAGE" | "ITEM",
  n: number,
  submit = true,
): Promise<{ pkg: string; items: string[] }> {
  await s.as("committeeSecretary");
  const [p] = await s.tx<
    { id: string }[]
  >`select api.create_recommendation_package(${cp}, ${granularity}) as id`;
  const items: string[] = [];
  for (let i = 1; i <= n; i++) {
    const [it] = await s.tx<{ id: string }[]>`
      select api.add_recommendation_item(${p!.id}, 'CORRECTIVE_ACTION', null, null,
        ${`Synthetic: corrective action ${i}.`}, null, null) as id`;
    items.push(it!.id);
  }
  if (submit) await s.tx`select api.submit_package_for_vote(${p!.id})`;
  return { pkg: p!.id, items };
}

/** Owner fixture: the referral, the finding and the packages moved three days back, before the meeting held on paper
 *  (a ballot's target must be what the meeting voted on). Leaves the owner acting. */
async function backdate(
  s: OwnerScenario,
  f: { cp: string; finding?: string; packages?: string[] },
): Promise<void> {
  await s.asOwner();
  await s.tx`alter table committee.committee_proceeding disable trigger committee_proceeding_protect`;
  await s.tx`update committee.committee_proceeding set referred_at = now() - interval '3 days' where id = ${f.cp}`;
  await s.tx`alter table committee.committee_proceeding enable trigger committee_proceeding_protect`;
  if (f.finding) {
    await s.tx`alter table case_mgmt.finding disable trigger no_update`;
    await s.tx`update case_mgmt.finding set recorded_at = now() - interval '3 days' where id = ${f.finding}`;
    await s.tx`alter table case_mgmt.finding enable trigger no_update`;
  }
  if (f.packages?.length) {
    await s.tx`alter table decision.recommendation_package disable trigger recommendation_package_protect`;
    await s.tx`update decision.recommendation_package
                  set created_at = now() - interval '3 days', updated_at = now() - interval '3 days'
                where id = any(${f.packages}::uuid[])`;
    await s.tx`alter table decision.recommendation_package enable trigger recommendation_package_protect`;
  }
}

/** IC seated (chair, secretary, legal, legalB, lead), case 0002 with a substantiated finding, referred to the IC from
 *  its investigation, two packages put to the vote, everything backdated before the meeting held on paper (unless
 *  `backdate` is false), and the secretary holding a registry entry for the proceeding. */
async function fixture(s: OwnerScenario, opts: { backdate?: boolean } = {}): Promise<Fixture> {
  const t = await times(s);
  await seat(s, ic, IC_SEATS);
  const facts = await caseFacts(s, caseB);
  const cp = await refer(s, ic, caseB, "caseManager", facts.proceeding);
  const whole = await packageOf(s, cp, "PACKAGE", 1);
  const byItem = await packageOf(s, cp, "ITEM", 2);
  if (opts.backdate ?? true) {
    await backdate(s, { cp, finding: facts.finding, packages: [whole.pkg, byItem.pkg] });
  } else {
    await backdate(s, { cp });
  }
  await s.as("platformAdmin");
  await s.tx`select api.authorize_committee_continuity_operator(${USERS.committeeSecretary}, ${cp}, 'BCP-AUTH-DEMO-C4',
               ${REASON})`;
  return {
    t,
    cp,
    allegation: facts.allegation,
    finding: facts.finding,
    pkg: whole.pkg,
    itemPkg: byItem.pkg,
    items: byItem.items,
  };
}

function control(t: Times, cp: string, version = "BCP-C2") {
  return {
    TEMPLATE_VERSION: version,
    WORKBOOK_ID: WB,
    COMMITTEE_PROCEEDING_ID: cp,
    COMMITTEE_CODE: "IC",
    OFFLINE_FROM: t.from,
    OFFLINE_TO: t.to,
    PREPARED_BY: EMAIL.committeeSecretary!,
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

const meetingRow = (t: Times) =>
  row("09_MEETINGS", 3, "BCP-M1", t.heldStart, {
    PURPOSE: "DELIBERATION",
    MODE: "IN_PERSON",
    LOCATION: "Meeting room (synthetic)",
    HELD_START: t.heldStart,
    HELD_END: t.heldEnd,
    PAPER_MINUTES_REFERENCE: "PAPER-MIN-DEMO-0120",
    REASON: "Synthetic: the committee met and voted on paper during the outage.",
  });

type Kind = "FINDING" | "PACKAGE" | "RECOMMENDATION_ITEM";

interface Ballot {
  voter: UserKey | string;
  kind: Kind | string;
  target: string;
  choice: string;
  at?: string;
  meetingRef?: string;
}

/** One 12_VOTES row per ballot, keyed BCP-V1, BCP-V2, … in order; `voter` is a user key or an email. */
const ballotRows = (t: Times, ballots: Ballot[]) =>
  ballots.map((b, i) =>
    row("12_VOTES", 3 + i, `BCP-V${i + 1}`, b.at ?? t.signed, {
      MEETING_REF: b.meetingRef ?? "BCP-M1",
      PARTICIPANT: EMAIL[b.voter] ?? b.voter,
      TARGET_KIND: b.kind,
      TARGET_ID: b.target,
      CHOICE: b.choice,
      BALLOT_REFERENCE: `PAPER-BALLOT-DEMO-${i + 1}`,
    }),
  );

/** The secretary stages a workbook (BCP-C2 by default) of the meeting held on paper and these ballots. */
async function stage(
  s: Scenario,
  f: Fixture,
  ballots: Ballot[],
  opts: { version?: string; extra?: unknown[] } = {},
): Promise<string> {
  await s.as("committeeSecretary");
  const rows = [meetingRow(f.t), ...ballotRows(f.t, ballots), ...(opts.extra ?? [])];
  const [b] = await s.tx<{ id: string }[]>`
    select api.stage_bcp_import(${s.tx.json(control(f.t, f.cp, opts.version) as never)}::jsonb, ${SHA},
                                ${s.tx.json(rows as never)}::jsonb) as id`;
  return b!.id;
}

interface StagedRow {
  row_key: string;
  state: string;
  detail: string | null;
  ballot: UserKey | null;
  subject_user_id: string | null;
}

/** The staged rows other than the meeting, in order (the importer's read). */
async function staged(s: Scenario, batch: string): Promise<StagedRow[]> {
  await s.as("committeeSecretary");
  const rows = await s.tx<
    {
      row_key: string;
      state: string;
      detail: string | null;
      ballot_user_id: string | null;
      subject_user_id: string | null;
    }[]
  >`
    select row_key, state, detail, ballot_user_id, subject_user_id from exchange.bcp_import_row
    where batch_id = ${batch} and sheet_code <> '09_MEETINGS' order by row_number`;
  return rows.map((r) => ({
    row_key: r.row_key,
    state: r.state,
    detail: r.detail,
    ballot: r.ballot_user_id ? userKey(r.ballot_user_id) : null,
    subject_user_id: r.subject_user_id,
  }));
}

/** The importer skips every row that is not NEW and previews: whether the dry run was clean, and each row's
 *  outcome by key. */
async function preview(
  s: Scenario,
  batch: string,
): Promise<{ clean: boolean; outcome: Record<string, string | null> }> {
  await s.as("committeeSecretary");
  const open = await s.tx<{ id: string }[]>`
    select id from exchange.bcp_import_row where batch_id = ${batch} and state in ('UNSUPPORTED', 'INVALID')`;
  for (const r of open) await s.tx`select api.resolve_bcp_row(${r.id}, 'SKIP', ${WHY})`;
  const [p] = await s.tx<
    { p: { clean: boolean; rows: { row_key: string; outcome: string | null }[] } }[]
  >`select api.preview_bcp_import(${batch}) as p`;
  return {
    clean: p!.p.clean,
    outcome: Object.fromEntries(p!.p.rows.map((r) => [r.row_key, r.outcome])),
  };
}

/** The meeting the committed workbook recorded, with its participants by user key (owner read). */
async function heldMeeting(s: OwnerScenario, f: Fixture, batch: string): Promise<MeetingFixture> {
  await s.asOwner();
  const [m] = await s.tx<{ id: string }[]>`
    select object_id as id from exchange.bcp_provenance where batch_id = ${batch} and sheet_code = '09_MEETINGS'`;
  const rows = await s.tx<{ id: string; user_id: string }[]>`
    select id, user_id from committee.meeting_participant where meeting_id = ${m!.id}`;
  const participant: Record<string, string> = {};
  for (const r of rows) participant[userKey(r.user_id)] = r.id;
  return { committeeProceeding: f.cp, meeting: m!.id, participant };
}

interface BallotRow {
  who: UserKey;
  target_kind: string;
  choice: string;
  status: string;
  vote_item_id: string | null;
  vote_id: string | null;
  package_round: number | null;
}

/** The meeting's ballots in workbook order (owner read: no application role reads the table). */
async function ballotsOf(s: OwnerScenario, meeting: string): Promise<BallotRow[]> {
  await s.asOwner();
  const rows = await s.tx<(Omit<BallotRow, "who"> & { user_id: string })[]>`
    select user_id, target_kind, choice, status, vote_item_id, vote_id, package_round
    from committee.offline_ballot where meeting_id = ${meeting} order by ballot_reference`;
  return rows.map(({ user_id, ...r }) => ({ who: userKey(user_id), ...r }));
}

interface ItemView {
  vote_item_id: string;
  status: string;
  my_ballot: { ballot_id: string; status: string; choice: string; ballot_reference: string } | null;
  offline_ballots: Record<string, number>;
  ballots_unconfirmed_for: string[];
  capabilities: Record<string, boolean>;
}
interface View {
  logistics: { held_offline: boolean; status: string };
  roster: { participant_id: string; capabilities: Record<string, boolean> }[] | null;
  deliberation: { vote_items: ItemView[] } | null;
}

async function view(s: Scenario, user: UserKey, meeting: string): Promise<View> {
  await s.as(user);
  const [r] = await s.tx<{ v: View }[]>`select api.meeting_view(${meeting}) as v`;
  return r!.v;
}

/** The ledger's events of the given actions since the start of the test's transaction, in order (owner read). */
async function ledger(s: OwnerScenario, actions: string[]) {
  await s.asOwner();
  return s.tx<{ action: string; object_type: string; actor_id: string; metadata: Record<string, unknown> }[]>`
    select action, object_type, actor_id, metadata from audit.audit_event
    where action = any(${actions}::text[]) and occurred_at >= now() order by seq`;
}

const CONFIRM = (item: string, choice: string) => `select api.confirm_offline_ballot('${item}', '${choice}')`;
const CAST = (item: string, choice: string) => `select api.cast_vote('${item}', '${choice}', null)`;

describe("T-AMB-118: a paper ballot is provisional until its member confirms it (DEC-AMB-008, F1 B′)", () => {
  it("imported PROVISIONAL with no vote; bound when its item opens; each member confirms their own on the choice they read; the item closes only then; the ledger carries no choice", async () => {
    await ownerScenario(async (s) => {
      const f = await fixture(s);
      const choice: Record<string, string> = {
        committeeChair: "APPROVE",
        legal: "APPROVE",
        legalB: "REJECT",
        lead: "ABSTAIN",
      };
      const batch = await stage(
        s,
        f,
        VOTERS.map((v) => ({ voter: v, kind: "PACKAGE", target: f.pkg, choice: choice[v]! })),
      );
      // Staged: each ballot names its voter, never as a conflict subject (R4, R9 are about conflicts).
      expect(await staged(s, batch)).toEqual(
        VOTERS.map((v, i) => ({
          row_key: `BCP-V${i + 1}`,
          state: "NEW",
          detail: null,
          ballot: v,
          subject_user_id: null,
        })),
      );
      expect(await preview(s, batch)).toEqual({
        clean: true,
        outcome: { "BCP-M1": "OK", "BCP-V1": "OK", "BCP-V2": "OK", "BCP-V3": "OK", "BCP-V4": "OK" },
      });
      const { counts } = await commitThroughRecord(s, batch);
      expect(counts).toMatchObject({ imported: 5 });
      const h = await heldMeeting(s, f, batch);

      // The commit wrote provisional ballots on the package's round, and no vote.
      const pending = VOTERS.map((v) => ({
        who: v,
        target_kind: "PACKAGE",
        choice: choice[v]!,
        status: "PROVISIONAL",
        vote_item_id: null,
        vote_id: null,
        package_round: 1,
      }));
      expect(await ballotsOf(s, h.meeting)).toEqual(pending);
      expect(
        await s.tx`select count(*)::int as n from committee.vote v join committee.vote_item vi on vi.id = v.vote_item_id
                   where vi.meeting_id = ${h.meeting}`,
      ).toEqual([{ n: 0 }]);
      await s.asOwner();
      const [prov] = await s.tx<{ object_type: string; n: number }[]>`
        select object_type, count(*)::int as n from exchange.bcp_provenance
        where batch_id = ${batch} and sheet_code = '12_VOTES' group by object_type`;
      expect(prov).toEqual({ object_type: "offline_ballot", n: 4 });

      // Online completion (2110 F3): the members declare, the secretary opens the meeting, records them present as the
      // attested roster shows, and opens the package's vote; the item binds the four ballots.
      await openWithPresent(s, h, VOTERS);
      await s.as("committeeSecretary");
      await s.tx`select api.open_package_vote(${h.meeting}, ${f.pkg})`;
      const [vi] = await s.tx<
        { id: string }[]
      >`select id from committee.vote_item where meeting_id = ${h.meeting}`;
      const item = vi!.id;
      expect((await ballotsOf(s, h.meeting)).map((b) => [b.who, b.status, b.vote_item_id])).toEqual(
        VOTERS.map((v) => [v, "PROVISIONAL", item]),
      );

      // F2: a meeting held offline takes no online vote; the flags say so.
      for (const v of VOTERS) {
        expect(await outcomes(s, v, { cast: CAST(item, "APPROVE") }), v).toEqual({
          cast: "CDF_CONFLICT:OFFLINE_BALLOT_ONLY",
        });
        const mine = (await view(s, v, h.meeting)).deliberation!.vote_items[0]!;
        expect(mine.capabilities, v).toMatchObject({
          may_vote: false,
          may_revise: false,
          may_confirm_ballot: true,
        });
        // Each member reads their own ballot, with its choice; the others' only as counts.
        expect(mine.my_ballot, v).toMatchObject({
          status: "PROVISIONAL",
          choice: choice[v],
          ballot_reference: `PAPER-BALLOT-DEMO-${VOTERS.indexOf(v) + 1}`,
        });
        expect(mine.offline_ballots).toEqual({ provisional: 4, confirmed: 0, superseded: 0, lapsed: 0 });
        expect(mine.ballots_unconfirmed_for).toEqual([]);
      }

      // The vote is not final while a counting member's ballot waits: here every member is present, so the votes are
      // outstanding (a member not present is BALLOTS_UNCONFIRMED, below).
      const runner = (await view(s, "committeeSecretary", h.meeting)).deliberation!.vote_items[0]!;
      expect(runner.my_ballot).toBeNull();
      expect(runner.capabilities.may_close).toBe(false);
      expect([...runner.ballots_unconfirmed_for].sort()).toEqual(VOTERS.map((v) => h.participant[v]!).sort());
      expect(
        await outcomes(s, "committeeSecretary", { close: `select api.close_vote_item('${item}', null)` }),
      ).toEqual({ close: "CDF_CONFLICT:VOTES_OUTSTANDING" });

      // A confirmation carries the choice the member read; another choice is refused and the ballot waits.
      expect(await outcomes(s, "legal", { other: CONFIRM(item, "REJECT") })).toEqual({
        other: "CDF_CONFLICT:BALLOT_CHOICE_MISMATCH",
      });
      for (const v of VOTERS) {
        await s.as(v);
        await s.tx`select api.confirm_offline_ballot(${item}, ${choice[v]!})`;
      }
      // Each confirmation is the member's own SELF vote, at the time the paper was signed.
      await s.asOwner();
      expect(
        await s.tx`select v.recorded_for, v.recorded_by, v.source, v.choice, v.reason,
                          v.original_event_at = (${f.t.signed}::text)::timestamptz as at_paper_time
                   from committee.vote v where v.vote_item_id = ${item} order by v.choice, v.recorded_for`,
      ).toEqual(
        VOTERS.map((v) => ({
          recorded_for: USERS[v],
          recorded_by: USERS[v],
          source: "SELF",
          choice: choice[v],
          reason: null,
          at_paper_time: true,
        })).sort(
          (a, b) =>
            String(a.choice).localeCompare(String(b.choice)) || a.recorded_for.localeCompare(b.recorded_for),
        ),
      );
      const settled = await ballotsOf(s, h.meeting);
      expect(settled.map((b) => [b.who, b.status, b.vote_id !== null])).toEqual(
        VOTERS.map((v) => [v, "CONFIRMED", true]),
      );
      expect(
        await outcomes(s, "legal", {
          again: CONFIRM(item, "APPROVE"),
          revise: `select api.revise_vote('${item}', 'REJECT', null)`,
        }),
      ).toEqual({ again: "CDF_CONFLICT:ALREADY_VOTED", revise: "CDF_CONFLICT:OFFLINE_BALLOT_ONLY" });
      const done = (await view(s, "legal", h.meeting)).deliberation!.vote_items[0]!;
      expect(done.capabilities).toMatchObject({ may_confirm_ballot: false, may_revise: false });
      expect(done.offline_ballots).toEqual({ provisional: 0, confirmed: 4, superseded: 0, lapsed: 0 });

      // Now final: two approvals, one rejection, one abstention.
      await s.as("committeeSecretary");
      expect(await s.tx`select api.close_vote_item(${item}, null) as r`).toEqual([{ r: "APPROVED" }]);

      // The ledger: the binding and each member's own confirmation, by ids and counts only.
      const events = await ledger(s, [
        "OFFLINE_BALLOTS_BOUND",
        "OFFLINE_BALLOT_CONFIRMED",
        "OFFLINE_BALLOT_SUPERSEDED",
        "OFFLINE_BALLOTS_LAPSED",
      ]);
      expect(events.map((e) => [e.action, e.actor_id])).toEqual([
        ["OFFLINE_BALLOTS_BOUND", USERS.committeeSecretary],
        ...VOTERS.map((v) => ["OFFLINE_BALLOT_CONFIRMED", USERS[v]]),
      ]);
      expect(events[0]!.metadata).toEqual({ meeting_id: h.meeting, ballots: 4 });
      for (const e of events.slice(1))
        expect(Object.keys(e.metadata).sort()).toEqual(["ballot_id", "meeting_id"]);
      // Q61: no ledger row of the test carries a ballot's choice or its paper reference.
      expect(
        await s.tx`select count(*)::int as n from audit.audit_event
                   where occurred_at >= now() and (metadata ? 'choice' or metadata::text like '%PAPER-BALLOT-DEMO%'
                                                   or coalesce(reason, '') like '%PAPER-BALLOT-DEMO%')`,
      ).toEqual([{ n: 0 }]);
    });
  });
});

/** Stages these ballots, previews clean, runs the record to commit and returns the meeting held on paper. */
async function committed(
  s: OwnerScenario,
  f: Fixture,
  ballots: Ballot[],
  declared: Partial<Record<UserKey, Declared>> = {},
): Promise<{ batch: string; h: MeetingFixture }> {
  const batch = await stage(s, f, ballots);
  const p = await preview(s, batch);
  if (!p.clean) throw new Error(`committed: preview not clean: ${JSON.stringify(p.outcome)}`);
  await commitThroughRecord(s, batch, declared);
  return { batch, h: await heldMeeting(s, f, batch) };
}

describe("the secretary has no path to a member's vote (DEC-AMB-008)", () => {
  it("never confirms, casts or records APPROVE or REJECT for a member; reads no ballot; a non-member cannot reach the item", async () => {
    await ownerScenario(async (s) => {
      const f = await fixture(s);
      const { h } = await committed(s, f, [
        { voter: "legal", kind: "PACKAGE", target: f.pkg, choice: "APPROVE" },
      ]);
      await openWithPresent(s, h, VOTERS);
      await s.as("committeeSecretary");
      await s.tx`select api.open_package_vote(${h.meeting}, ${f.pkg})`;
      const [vi] = await s.tx<
        { id: string }[]
      >`select id from committee.vote_item where meeting_id = ${h.meeting}`;
      const item = vi!.id;
      const legal = h.participant.legal!;
      expect(
        await outcomes(s, "committeeSecretary", {
          confirm: CONFIRM(item, "APPROVE"),
          cast: CAST(item, "APPROVE"),
          for_approve: `select api.record_vote_for_member('${item}', '${legal}', 'APPROVE', '${REASON}', null)`,
          for_reject: `select api.record_vote_for_member('${item}', '${legal}', 'REJECT', '${REASON}', null)`,
          // N6 is for a member not present; legal is present.
          for_absent: `select api.record_vote_for_member('${item}', '${legal}', 'ABSENT', '${REASON}', null)`,
        }),
      ).toEqual({
        confirm: "CDF_FORBIDDEN",
        cast: "CDF_FORBIDDEN",
        for_approve: "CDF_FORBIDDEN",
        for_reject: "CDF_FORBIDDEN",
        for_absent: "CDF_CONFLICT:MEMBER_PRESENT",
      });
      // A member without a ballot on the item has nothing to confirm; someone outside the meeting cannot see it.
      expect(await outcomes(s, "lead", { confirm: CONFIRM(item, "APPROVE") })).toEqual({
        confirm: "CDF_CONFLICT:NO_PROVISIONAL_BALLOT",
      });
      expect(await outcomes(s, "investigatorA", { confirm: CONFIRM(item, "APPROVE") })).toEqual({
        confirm: "CDF_NOT_FOUND",
      });
      // No application role reads or writes the table; its choice reaches its own member only, through the views.
      for (const user of ["committeeSecretary", "legal", "committeeChair"] as const) {
        await s.as(user);
        await s.expectError(
          "permission denied for table offline_ballot",
          (tx) => tx`select count(*) from committee.offline_ballot`,
        );
      }
      await s.asOwner();
      expect(
        await s.tx`select r.rolname, has_table_privilege(r.rolname, 'committee.offline_ballot', 'select, insert, update, delete') as any_grant
                   from pg_roles r where r.rolname in ('anon', 'authenticated', 'cdf_bff', 'cdf_portal') order by r.rolname`,
      ).toEqual([
        { rolname: "anon", any_grant: false },
        { rolname: "authenticated", any_grant: false },
        { rolname: "cdf_bff", any_grant: false },
        { rolname: "cdf_portal", any_grant: false },
      ]);
      for (const [user, mine] of [
        ["legal", { status: "PROVISIONAL", choice: "APPROVE" }],
        ["legalB", null],
        ["committeeSecretary", null],
      ] as const) {
        await s.as(user);
        const [r] = await s.tx<
          { v: { my_ballot: Record<string, unknown> | null; offline_ballots: unknown } }[]
        >`
          select api.vote_item_status(${item}) as v`;
        if (mine) expect(r!.v.my_ballot, user).toMatchObject(mine);
        else expect(r!.v.my_ballot, user).toBeNull();
        expect(r!.v.offline_ballots, user).toEqual({
          provisional: 1,
          confirmed: 0,
          superseded: 0,
          lapsed: 0,
        });
      }
    });
  });
});

describe("every bound ballot is settled by an act with a record before the vote is final", () => {
  it("BALLOTS_UNCONFIRMED holds the item while a counting member not present has a ballot; recusal and the secretary's N6 record supersede, confirmation confirms", async () => {
    await ownerScenario(async (s) => {
      const f = await fixture(s);
      const choice: Record<string, string> = {
        committeeChair: "APPROVE",
        legal: "APPROVE",
        legalB: "REJECT",
        lead: "REJECT",
      };
      const { h } = await committed(
        s,
        f,
        VOTERS.map((v) => ({ voter: v, kind: "PACKAGE", target: f.pkg, choice: choice[v]! })),
      );
      // Lead does not join the online completion.
      await openWithPresent(s, h, ["committeeChair", "legal", "legalB"]);
      await s.as("committeeSecretary");
      await s.tx`select api.open_package_vote(${h.meeting}, ${f.pkg})`;
      const [vi] = await s.tx<
        { id: string }[]
      >`select id from committee.vote_item where meeting_id = ${h.meeting}`;
      const item = vi!.id;
      for (const v of ["committeeChair", "legal"] as const) {
        await s.as(v);
        await s.tx`select api.confirm_offline_ballot(${item}, ${choice[v]!})`;
      }
      // LegalB recuses instead: their ballot is superseded by their own act.
      await s.as("legalB");
      await s.tx`select api.recuse_for_conflict(${item}, 'Synthetic: a conflict found after the meeting.')`;
      // Every present member has voted, but lead's ballot still waits.
      const close = { close: `select api.close_vote_item('${item}', null)` };
      expect(await outcomes(s, "committeeSecretary", close)).toEqual({
        close: "CDF_CONFLICT:BALLOTS_UNCONFIRMED",
      });
      let runner = (await view(s, "committeeSecretary", h.meeting)).deliberation!.vote_items[0]!;
      expect(runner.capabilities.may_close).toBe(false);
      expect(runner.ballots_unconfirmed_for).toEqual([h.participant.lead]);
      // Lead is not present, so lead does not reach the item's deliberation, let alone confirm; the secretary records N6
      // with its reason, never a choice.
      expect(await outcomes(s, "lead", { confirm: CONFIRM(item, "REJECT") })).toEqual({
        confirm: "CDF_NOT_FOUND",
      });
      await s.as("committeeSecretary");
      await s.tx`select api.record_vote_for_member(${item}, ${h.participant.lead!}, 'ABSENT',
                   'Synthetic: did not join the online completion.', null)`;
      runner = (await view(s, "committeeSecretary", h.meeting)).deliberation!.vote_items[0]!;
      expect(runner.capabilities.may_close).toBe(true);
      expect(runner.ballots_unconfirmed_for).toEqual([]);
      await s.as("committeeSecretary");
      expect(await s.tx`select api.close_vote_item(${item}, null) as r`).toEqual([{ r: "APPROVED" }]);

      expect((await ballotsOf(s, h.meeting)).map((b) => [b.who, b.status])).toEqual([
        ["committeeChair", "CONFIRMED"],
        ["legal", "CONFIRMED"],
        ["legalB", "SUPERSEDED"],
        ["lead", "SUPERSEDED"],
      ]);
      // The two paper rejections never counted: a recusal for conflict (excluded from the count) and an absence.
      expect(
        await s.tx`select approve_count, reject_count, excluded_count, absent_count from committee.vote_item where id = ${item}`,
      ).toEqual([{ approve_count: 2, reject_count: 0, excluded_count: 1, absent_count: 1 }]);
      const superseded = await ledger(s, ["OFFLINE_BALLOT_SUPERSEDED"]);
      expect(superseded.map((e) => [e.actor_id, e.metadata.source])).toEqual([
        [USERS.legalB, "SELF"],
        [USERS.committeeSecretary, "SECRETARY"],
      ]);
    });
  });

  it("a ballot whose member no longer counts never blocks and lapses with its item; one whose target never opens lapses with its meeting; neither counts", async () => {
    await ownerScenario(async (s) => {
      const f = await fixture(s);
      const { h } = await committed(s, f, [
        ...VOTERS.map((v) => ({ voter: v, kind: "PACKAGE", target: f.pkg, choice: "APPROVE" })),
        { voter: "legal", kind: "FINDING", target: f.finding, choice: "APPROVE" },
      ]);
      await openWithPresent(s, h, ["committeeChair", "legal", "legalB"]);
      await s.as("committeeSecretary");
      await s.tx`select api.open_package_vote(${h.meeting}, ${f.pkg})`;
      const [vi] = await s.tx<
        { id: string }[]
      >`select id from committee.vote_item where meeting_id = ${h.meeting}`;
      const item = vi!.id;
      for (const v of ["committeeChair", "legal", "legalB"] as const) {
        await s.as(v);
        await s.tx`select api.confirm_offline_ballot(${item}, 'APPROVE')`;
      }
      // Lead's seat ends: lead no longer counts, so the ballot no longer holds the item.
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(m.id, now(), ${REASON}) from committee.membership m
                 where m.user_id = ${USERS.lead} and m.committee_id = ${ic} and m.ended_at is null`;
      await s.as("committeeSecretary");
      expect(await s.tx`select api.close_vote_item(${item}, null) as r`).toEqual([{ r: "APPROVED" }]);
      // The finding's vote never opened in the meeting; the secretary closes it.
      await s.tx`select api.close_meeting(${h.meeting}, ${REASON})`;
      expect((await ballotsOf(s, h.meeting)).map((b) => [b.who, b.target_kind, b.status])).toEqual([
        ["committeeChair", "PACKAGE", "CONFIRMED"],
        ["legal", "PACKAGE", "CONFIRMED"],
        ["legalB", "PACKAGE", "CONFIRMED"],
        ["lead", "PACKAGE", "LAPSED"],
        ["legal", "FINDING", "LAPSED"],
      ]);
      expect(
        await s.tx`select approve_count, excluded_count from committee.vote_item where id = ${item}`,
      ).toEqual([{ approve_count: 3, excluded_count: 0 }]);
      const lapsed = await ledger(s, ["OFFLINE_BALLOTS_LAPSED"]);
      expect(lapsed.map((e) => [e.object_type, e.metadata.ballots])).toEqual([
        ["vote_item", 1],
        ["meeting", 1],
      ]);

      // Integrity: a ballot is never deleted, its content never changes, and a settled one never reopens.
      await s.asOwner();
      const [b] = await s.tx<{ id: string }[]>`
        select id from committee.offline_ballot where meeting_id = ${h.meeting} and status = 'LAPSED' limit 1`;
      const [c] = await s.tx<{ id: string }[]>`
        select id from committee.offline_ballot where meeting_id = ${h.meeting} and status = 'CONFIRMED' limit 1`;
      for (const [label, sql] of [
        ["delete", `delete from committee.offline_ballot where id = '${b!.id}'`],
        [
          "reopen",
          `update committee.offline_ballot set status = 'PROVISIONAL', settled_at = null where id = '${b!.id}'`,
        ],
        ["choice", `update committee.offline_ballot set choice = 'REJECT' where id = '${c!.id}'`],
        ["truncate", `truncate committee.offline_ballot`],
      ] as const) {
        await s
          .expectError("offline ballot", (tx) => tx.unsafe(sql))
          .catch((error: Error) => {
            throw new Error(`${label}: ${error.message}`);
          });
      }
    });
  });
});

describe("binding: a vote item binds only the ballots on its own target in its own meeting", () => {
  it("an item of a package voted item by item binds that item's ballots; a finding's item binds the finding's; another item binds none", async () => {
    await ownerScenario(async (s) => {
      const f = await fixture(s);
      const { h } = await committed(s, f, [
        { voter: "legal", kind: "RECOMMENDATION_ITEM", target: f.items[0]!, choice: "APPROVE" },
        { voter: "lead", kind: "RECOMMENDATION_ITEM", target: f.items[1]!, choice: "REJECT" },
        { voter: "legal", kind: "FINDING", target: f.finding, choice: "ABSTAIN" },
      ]);
      await openWithPresent(s, h, VOTERS);
      await s.as("committeeSecretary");
      const [other] = await s.tx<{ id: string }[]>`
        select api.open_vote_item(${h.meeting}, 'OTHER', null, 'Procedural point (synthetic)') as id`;
      await s.tx`select api.open_package_vote(${h.meeting}, ${f.itemPkg})`;
      const [onFinding] = await s.tx<{ id: string }[]>`
        select api.open_vote_item(${h.meeting}, 'FINDING', ${f.finding}, 'Finding on the allegation (synthetic)') as id`;
      const byItem = Object.fromEntries(
        (
          await s.tx<{ id: string; recommendation_item_id: string | null }[]>`
            select id, recommendation_item_id from committee.vote_item
            where meeting_id = ${h.meeting} and recommendation_item_id is not null`
        ).map((r) => [r.recommendation_item_id!, r.id]),
      );
      expect((await ballotsOf(s, h.meeting)).map((b) => [b.who, b.target_kind, b.vote_item_id])).toEqual([
        ["legal", "RECOMMENDATION_ITEM", byItem[f.items[0]!]],
        ["lead", "RECOMMENDATION_ITEM", byItem[f.items[1]!]],
        ["legal", "FINDING", onFinding!.id],
      ]);
      // Legal reads their ballot on the item it binds, nowhere else, and may confirm only there.
      const items = (await view(s, "legal", h.meeting)).deliberation!.vote_items;
      const at = (id: string) => items.find((i) => i.vote_item_id === id)!;
      expect(at(other!.id).my_ballot).toBeNull();
      expect(at(other!.id).capabilities.may_confirm_ballot).toBe(false);
      expect(at(byItem[f.items[0]!]!).my_ballot).toMatchObject({ choice: "APPROVE" });
      expect(at(byItem[f.items[1]!]!).my_ballot).toBeNull();
      expect(at(byItem[f.items[1]!]!).capabilities.may_confirm_ballot).toBe(false);
      expect(at(onFinding!.id).my_ballot).toMatchObject({ choice: "ABSTAIN" });
      expect(
        await outcomes(s, "legal", {
          other: CONFIRM(other!.id, "APPROVE"),
          item: CONFIRM(byItem[f.items[0]!]!, "APPROVE"),
          finding: CONFIRM(onFinding!.id, "ABSTAIN"),
        }),
      ).toEqual({ other: "CDF_CONFLICT:NO_PROVISIONAL_BALLOT", item: true, finding: true });
    });
  });
});

describe("F2: a meeting held offline (coordinator ruling, narrow)", () => {
  it("a member is recorded present only as the attested roster shows them attending (OFFLINE_ROSTER_MISMATCH); the flag follows the command", async () => {
    await ownerScenario(async (s) => {
      const f = await fixture(s);
      const { h } = await committed(
        s,
        f,
        [{ voter: "legal", kind: "PACKAGE", target: f.pkg, choice: "APPROVE" }],
        { lead: { attendance: "ABSENT" } },
      );
      for (const v of ["committeeChair", "legal", "lead"] as const) {
        await s.as(v);
        await s.tx`select api.declare_meeting_conflict(${h.participant[v]!}, 'NO_CONFLICT', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${h.meeting}, ${REASON})`;
      const v = await view(s, "committeeSecretary", h.meeting);
      expect(v.logistics.held_offline).toBe(true);
      const flag = (user: UserKey) =>
        v.roster!.find((r) => r.participant_id === h.participant[user])!.capabilities.may_record_present;
      const present = (user: UserKey) => `select api.record_attendance('${h.participant[user]}', 'PRESENT')`;
      const answered = await outcomes(s, "committeeSecretary", {
        lead: present("lead"),
        legal: present("legal"),
      });
      expect(answered).toEqual({ lead: "CDF_CONFLICT:OFFLINE_ROSTER_MISMATCH", legal: true });
      expect({ lead: flag("lead"), legal: flag("legal") }).toEqual({ lead: false, legal: true });
      // Recorded absent stays open to them.
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${h.participant.lead!}, 'ABSENT')`;
    });
  });

  it("a meeting not held offline is unchanged: members cast and revise online, and nothing binds", async () => {
    await ownerScenario(async (s) => {
      const f = await fixture(s);
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${f.cp}, 'DELIBERATION', 'IN_PERSON', 'Meeting room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 2 hours', ${REASON}) as id`;
      const rows = await s.tx<{ id: string; user_id: string }[]>`
        select id, user_id from committee.meeting_participant where meeting_id = ${m!.id}`;
      const participant: Record<string, string> = {};
      for (const r of rows) participant[userKey(r.user_id)] = r.id;
      await openWithPresent(s, { committeeProceeding: f.cp, meeting: m!.id, participant }, VOTERS);
      await s.as("committeeSecretary");
      await s.tx`select api.open_package_vote(${m!.id}, ${f.pkg})`;
      const [vi] = await s.tx<
        { id: string }[]
      >`select id from committee.vote_item where meeting_id = ${m!.id}`;
      const mine = (await view(s, "legal", m!.id)).deliberation!.vote_items[0]!;
      expect(mine.capabilities).toMatchObject({ may_vote: true, may_confirm_ballot: false });
      expect(mine.my_ballot).toBeNull();
      expect(
        await outcomes(s, "legal", { cast: CAST(vi!.id, "APPROVE"), confirm: CONFIRM(vi!.id, "APPROVE") }),
      ).toEqual({ cast: true, confirm: "CDF_CONFLICT:NO_PROVISIONAL_BALLOT" });
    });
  });
});

describe("the official record gates every ballot (2115; ADR-061 amendment)", () => {
  it("a ballot of a member the signed minutes do not show attending is BALLOT_WITHOUT_ATTENDANCE and the record does not reconcile; attending part of the meeting is enough", async () => {
    await ownerScenario(async (s) => {
      const f = await fixture(s);
      const batch = await stage(s, f, [
        { voter: "legal", kind: "PACKAGE", target: f.pkg, choice: "APPROVE" },
        { voter: "lead", kind: "PACKAGE", target: f.pkg, choice: "REJECT" },
      ]);
      expect((await preview(s, batch)).clean).toBe(true);
      const opened = await openRecord(s, batch);
      await declare(s, opened, {
        lead: { attendance: "ABSENT" },
        legal: { attendance: "ATTENDED_PART", left_early: true },
      });
      await uploadMinutes(s, batch, opened.record);
      expect(await submitRecord(s, batch)).toBe("RECONCILIATION_FAILED");
      await s.asOwner();
      expect(
        await s.tx`select code, roster_id from exchange.bcp_record_discrepancies(${opened.record}, false)
                   where code = 'BALLOT_WITHOUT_ATTENDANCE'`,
      ).toEqual([{ code: "BALLOT_WITHOUT_ATTENDANCE", roster_id: opened.roster.lead }]);
      // Corrected from the signed minutes (lead attended), it reconciles and goes to the chair.
      await declare(s, opened, { legal: { attendance: "ATTENDED_PART", left_early: true } });
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
    });
  });

  it("F3: before the commit the workbook's ballots are its importer's only; the chair approving the record reads them as a count", async () => {
    await ownerScenario(async (s) => {
      const f = await fixture(s);
      const batch = await stage(
        s,
        f,
        VOTERS.map((v) => ({ voter: v, kind: "PACKAGE", target: f.pkg, choice: "APPROVE" })),
      );
      await preview(s, batch);
      const opened = await openRecord(s, batch);
      await declare(s, opened);
      await uploadMinutes(s, batch, opened.record);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      const read = async (user: UserKey) => {
        await s.as(user);
        const rows = await s.tx<{ sheet_code: string }[]>`
          select sheet_code from exchange.bcp_import_row where batch_id = ${batch} order by row_number, sheet_code`;
        const [v] = await s.tx<
          { v: { rows: { sheet_code: string }[]; counts: { rows: number; ballots: number } } }[]
        >`
          select api.bcp_import_batch_view(${batch}) as v`;
        return {
          table: rows.filter((r) => r.sheet_code === "12_VOTES").length,
          view: v!.v.rows.filter((r) => r.sheet_code === "12_VOTES").length,
          counts: { rows: v!.v.counts.rows, ballots: v!.v.counts.ballots },
        };
      };
      expect(await read("committeeSecretary")).toEqual({
        table: 4,
        view: 4,
        counts: { rows: 5, ballots: 4 },
      });
      expect(await read("committeeChair")).toEqual({ table: 0, view: 0, counts: { rows: 5, ballots: 4 } });
      // A member reads no ballot row, their own included (their view is Section 13's, with the record).
      await s.as("legal");
      expect(
        await s.tx`select count(*)::int as n from exchange.bcp_import_row where batch_id = ${batch} and sheet_code = '12_VOTES'`,
      ).toEqual([{ n: 0 }]);
      // After the commit, a ballot's provenance is its member's and the meeting runner's.
      await s.as("committeeChair");
      await decideCall(opened.record, 1, "APPROVE")(s.tx);
      await attestAll(s, opened, 1);
      await commitRecord(s, batch);
      const provenance = async (user: UserKey) => {
        await s.as(user);
        return (
          await s.tx<{ row_key: string }[]>`
            select row_key from exchange.bcp_provenance where batch_id = ${batch} and sheet_code = '12_VOTES'
            order by row_key`
        ).map((r) => r.row_key);
      };
      expect(await provenance("committeeSecretary")).toEqual(["BCP-V1", "BCP-V2", "BCP-V3", "BCP-V4"]);
      expect(await provenance("legal")).toEqual(["BCP-V2"]);
      expect(await provenance("lead")).toEqual(["BCP-V4"]);
      expect(await provenance("investigatorA")).toEqual([]);
    });
  });
});

describe("staging and commit check each ballot (fail closed)", () => {
  it("staging: a voting member of the proceeding (never a secretary seat), a target of the proceeding in the form its vote takes, one ballot per member per target; BCP-C1 is unchanged (DEC-35)", async () => {
    await ownerScenario(async (s) => {
      const f = await fixture(s);
      const batch = await stage(s, f, [
        { voter: "committeeSecretary", kind: "PACKAGE", target: f.pkg, choice: "APPROVE" },
        { voter: "nobody.synthetic@example.test", kind: "PACKAGE", target: f.pkg, choice: "APPROVE" },
        { voter: "investigatorA", kind: "PACKAGE", target: f.pkg, choice: "APPROVE" },
        {
          voter: "legal",
          kind: "PACKAGE",
          target: "00000000-0000-4000-8000-000000000120",
          choice: "APPROVE",
        },
        { voter: "legal", kind: "PACKAGE", target: f.itemPkg, choice: "APPROVE" },
        { voter: "legal", kind: "RECOMMENDATION_ITEM", target: f.pkg, choice: "APPROVE" },
        { voter: "legal", kind: "FINDING", target: f.allegation, choice: "APPROVE" },
        { voter: "legal", kind: "FINDING", target: f.finding, choice: "APPROVE" },
        { voter: "legal", kind: "FINDING", target: f.finding, choice: "REJECT" },
        { voter: "legal", kind: "RECOMMENDATION_ITEM", target: f.items[0]!, choice: "ABSENT" },
        { voter: "legal", kind: "OTHER", target: f.items[0]!, choice: "APPROVE" },
        { voter: "legal", kind: "RECOMMENDATION_ITEM", target: f.items[0]!, choice: "RECUSED" },
      ]);
      expect((await staged(s, batch)).map((r) => [r.row_key, r.state, r.detail, r.ballot])).toEqual([
        ["BCP-V1", "INVALID", "PARTICIPANT", null],
        ["BCP-V2", "INVALID", "PARTICIPANT", null],
        ["BCP-V3", "INVALID", "PARTICIPANT", null],
        ["BCP-V4", "INVALID", "TARGET_ID", "legal"],
        ["BCP-V5", "INVALID", "TARGET_ID", "legal"],
        ["BCP-V6", "INVALID", "TARGET_ID", "legal"],
        ["BCP-V7", "INVALID", "TARGET_ID", "legal"],
        ["BCP-V8", "NEW", null, "legal"],
        ["BCP-V9", "INVALID", "DUPLICATE_BALLOT", "legal"],
        ["BCP-V10", "INVALID", "CHOICE", "legal"],
        ["BCP-V11", "INVALID", "TARGET_KIND", "legal"],
        ["BCP-V12", "NEW", null, "legal"],
      ]);

      // BCP-C1's 12_VOTES is recorded only, as built: no voter, nothing to import.
      await s.tx`select api.cancel_bcp_import(${batch}, ${REASON})`;
      const old = await stage(s, f, [], {
        version: "BCP-C1",
        extra: [row("12_VOTES", 3, "BCP-V1", f.t.signed, { DETAILS: "Synthetic: a vote taken on paper." })],
      });
      expect((await staged(s, old)).map((r) => [r.row_key, r.state, r.ballot])).toEqual([
        ["BCP-V1", "UNSUPPORTED", null],
      ]);
    });
  });

  it("commit (and its dry run): the ballot was signed while the meeting was held, and its target is still what the meeting voted on", async () => {
    await ownerScenario(async (s) => {
      const f = await fixture(s);
      // A package still in draft; a package put to the vote after the meeting began; a finding recorded after it.
      const draft = await packageOf(s, f.cp, "PACKAGE", 1, false);
      const late = await packageOf(s, f.cp, "PACKAGE", 1);
      await backdate(s, { cp: f.cp, packages: [draft.pkg] });
      await s.as("investigatorB");
      const [lateFinding] = await s.tx<{ id: string }[]>`
        select api.record_finding(${f.allegation}, null,
          (select proceeding_id from case_mgmt.finding where id = ${f.finding}), 'NOT_SUBSTANTIATED',
          'Synthetic: finding revised after the meeting.') as id`;
      // The ITEM package's vote opened online in another meeting before the import.
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${f.cp}, 'DELIBERATION', 'IN_PERSON', 'Meeting room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 2 hours', ${REASON}) as id`;
      const rows = await s.tx<{ id: string; user_id: string }[]>`
        select id, user_id from committee.meeting_participant where meeting_id = ${m!.id}`;
      const participant: Record<string, string> = {};
      for (const r of rows) participant[userKey(r.user_id)] = r.id;
      await openWithPresent(s, { committeeProceeding: f.cp, meeting: m!.id, participant }, VOTERS);
      await s.as("committeeSecretary");
      await s.tx`select api.open_package_vote(${m!.id}, ${f.itemPkg})`;

      const batch = await stage(s, f, [
        { voter: "legal", kind: "PACKAGE", target: f.pkg, choice: "APPROVE" },
        { voter: "legal", kind: "FINDING", target: lateFinding!.id, choice: "APPROVE", at: f.t.after },
        { voter: "legalB", kind: "PACKAGE", target: draft.pkg, choice: "APPROVE" },
        { voter: "lead", kind: "PACKAGE", target: late.pkg, choice: "APPROVE" },
        { voter: "lead", kind: "FINDING", target: lateFinding!.id, choice: "APPROVE" },
        { voter: "legalB", kind: "RECOMMENDATION_ITEM", target: f.items[0]!, choice: "APPROVE" },
        { voter: "lead", kind: "PACKAGE", target: f.pkg, choice: "APPROVE", meetingRef: "BCP-M9" },
        // The first finding was superseded by the revision: no longer current.
        { voter: "committeeChair", kind: "FINDING", target: f.finding, choice: "APPROVE" },
      ]);
      expect((await staged(s, batch)).map((r) => [r.row_key, r.state, r.detail])).toEqual([
        ["BCP-V1", "NEW", null],
        ["BCP-V2", "NEW", null],
        ["BCP-V3", "NEW", null],
        ["BCP-V4", "NEW", null],
        ["BCP-V5", "NEW", null],
        ["BCP-V6", "NEW", null],
        ["BCP-V7", "NEW", null],
        ["BCP-V8", "INVALID", "TARGET_ID"],
      ]);
      expect(await preview(s, batch)).toEqual({
        clean: false,
        outcome: {
          "BCP-M1": "OK",
          "BCP-V1": "OK",
          "BCP-V2": "CDF_INVALID:ORIGINAL_EVENT_AT",
          "BCP-V3": "CDF_CONFLICT:PACKAGE_NOT_VOTING",
          "BCP-V4": "CDF_CONFLICT:TARGET_CHANGED",
          "BCP-V5": "CDF_CONFLICT:TARGET_CHANGED",
          "BCP-V6": "CDF_CONFLICT:VOTE_ALREADY_OPENED",
          "BCP-V7": "CDF_INVALID:MEETING_REF",
          "BCP-V8": null,
        },
      });
    });
  });

  it("the commit re-checks every ballot: a target changed after the record was approved refuses the whole commit", async () => {
    await ownerScenario(async (s) => {
      const f = await fixture(s);
      const batch = await stage(s, f, [
        { voter: "legal", kind: "FINDING", target: f.finding, choice: "APPROVE" },
      ]);
      expect((await preview(s, batch)).clean).toBe(true);
      const opened = await openRecord(s, batch);
      await declare(s, opened);
      await uploadMinutes(s, batch, opened.record);
      expect(await submitRecord(s, batch)).toBe("SUBMITTED");
      await s.as("committeeChair");
      await decideCall(opened.record, 1, "APPROVE")(s.tx);
      await attestAll(s, opened, 1);
      // The finding is revised before the commit: the ballot's target is no longer current.
      await s.as("investigatorB");
      await s.tx`select api.record_finding(${f.allegation}, null,
        (select proceeding_id from case_mgmt.finding where id = ${f.finding}), 'NOT_SUBSTANTIATED',
        'Synthetic: finding revised before the commit.')`;
      await s.as("committeeSecretary");
      const [h] = await s.tx<
        { h: string }[]
      >`select submitted_hash as h from exchange.bcp_import_batch where id = ${batch}`;
      await s.expectError(
        "CDF_CONFLICT:BCP_ROW_FAILED:BCP-V1:CDF_INVALID:TARGET_ID",
        (tx: Tx) => tx`select api.apply_bcp_import(${batch}, ${h!.h})`,
      );
    });
  });
});
