// UX redesign Phase 12, slice P12-8b, migration 2128 (ADR-064; Linear CDF-269, under CDF-266): the owner's decision on
// backdated seats and positions (P12-8 F7, option B, 2026-10-19: "A past effective date is allowed only with a decree
// or source reference recorded on the row and an audit event (ids only), fail-closed otherwise"), and the
// Administration pages' seat and position flags.
//
//   * An end dated before now is refused without its decree or source reference (none, blank, under 3 or over 200
//     characters), after every check the end commands made before, and nothing is written. With it, the row keeps the
//     reference, and the command's own audit event names the row with ids and codes, never the reference. An end now or
//     later needs none; one given is checked and recorded.
//   * The reference is written with the end and never again: even the table owner cannot set it on a row that is not
//     ended, change or clear it on an ended one, or end a row in the past without it. The two registry triggers are
//     otherwise exactly as built.
//   * An appointment dated in the past already records its reference on the row and an audit event that carries
//     neither the reference nor a reason (1870, 1880, 2127): pinned here, unchanged.
//   * may_appoint per committee and per sector, and may_end per seat and per position, are their commands' answers for
//     every seed user and each state the commands tell apart: a seat or a position in force, scheduled, lapsed or
//     ended. Each list names every row of its register, in the register's order. Whoever holds one of the two
//     permissions alone gets exactly its page's flags.
//   * Each end command has one signature, the reference last; the two reads stay stable and security definer with an
//     empty search path, and take no lock, run no command and write nothing.
// Every step runs through the api.* commands as `authenticated`, except the owner's attempts on the tables, which the
// tables themselves must refuse.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, admin, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";
import { committeeIds } from "../support/committee";
import { outcomes } from "../support/capabilities";

type Answer = true | string;

const REASON = "Synthetic: seat and position end test.";
const REFERENCE = "DEMO-DECREE-2128";
const ALL = Object.keys(USERS) as UserKey[];
const COMMITTEE_ADMINS: UserKey[] = ["grcDirector", "platformAdmin", "grcDeputy", "complianceManager"];

let ic: string, gc: string, ops: string, fin: string;
beforeAll(async () => {
  ({ ic, gc } = await committeeIds());
  const sectors = await admin<{ code: string; id: string }[]>`
    select code, id from iam.sector where code in ('OPS', 'FIN')`;
  ops = sectors.find((r) => r.code === "OPS")!.id;
  fin = sectors.find((r) => r.code === "FIN")!.id;
});

interface AuditRow {
  object_type: string;
  object_id: string;
  outcome: string;
  actor_id: string;
  reason: string | null;
  metadata: Record<string, unknown>;
}

/** The audit ledger's rows written so far by this scenario (the owner reads its own transaction). */
async function ledger(s: OwnerScenario): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`
    select count(*)::int as n from audit.audit_event where request_id = current_setting('cdf.request_id')::uuid`;
  return r!.n;
}

/** This scenario's audit rows of one action, oldest first. */
async function events(s: OwnerScenario, action: string): Promise<AuditRow[]> {
  await s.asOwner();
  return s.tx<AuditRow[]>`
    select object_type, object_id, outcome, actor_id, reason, metadata from audit.audit_event
     where request_id = current_setting('cdf.request_id')::uuid and action = ${action} order by seq`;
}

/** A seat or position's end, its reason and its reference, as the owner reads them. */
async function endOf(s: OwnerScenario, table: string, id: string) {
  await s.asOwner();
  const [r] = await s.tx.unsafe<
    {
      effective_to: string | null;
      ended_at: string | null;
      ended_by: string | null;
      end_reason: string | null;
      end_reference: string | null;
    }[]
  >(
    `select effective_to::text, ended_at::text, ended_by, end_reason, end_reference from ${table} where id = $1`,
    [id],
  );
  return r!;
}

const OPEN = { effective_to: null, ended_at: null, ended_by: null, end_reason: null, end_reference: null };

/** A demo seat in force since the seed's start date, as the owner finds it. */
async function demoSeat(s: OwnerScenario, committee: string, seat: string) {
  await s.asOwner();
  const [m] = await s.tx<{ id: string; user_id: string }[]>`
    select id, user_id from committee.membership
     where committee_id = ${committee} and seat = ${seat} and ended_at is null and effective_to is null
     order by effective_from, id limit 1`;
  return m!;
}

/** A sector position in force, as the owner finds it. */
async function position(s: OwnerScenario, sector: string, user: UserKey) {
  await s.asOwner();
  const [m] = await s.tx<{ id: string }[]>`
    select id from iam.sector_membership
     where sector_id = ${sector} and user_id = ${USERS[user]} and ended_at is null`;
  return m!.id;
}

const endSeat = (id: string, to: string, reference?: string | null) =>
  reference === undefined
    ? `select api.end_committee_membership('${id}', ${to}, '${REASON}')`
    : `select api.end_committee_membership('${id}', ${to}, '${REASON}', ${reference === null ? "null" : `'${reference}'`})`;
const endPosition = (id: string, to: string, reference?: string | null) =>
  reference === undefined
    ? `select api.end_sector_membership('${id}', ${to}, '${REASON}')`
    : `select api.end_sector_membership('${id}', ${to}, '${REASON}', ${reference === null ? "null" : `'${reference}'`})`;

/** Every way of leaving out the reference: none, null, empty, blank, too short, too long. */
const MISSING: (string | null | undefined)[] = [undefined, null, "", "   ", "ab", "x".repeat(201)];

// ---- F7 = B: a past end carries its reference -------------------------------------------------------------------------

describe("F7 = B: an end dated in the past carries its decree or source reference (migration 2128, ADR-064)", () => {
  it("a seat: an end before now is refused without its reference, and nothing is written; with it, the seat ends, the row keeps the reference and the audit event names the row with ids only", async () => {
    await ownerScenario(async (s) => {
      const seat = await demoSeat(s, ic, "MEMBER");
      const before = await ledger(s);
      await s.as("platformAdmin");
      for (const reference of MISSING)
        await s.expectError("CDF_INVALID:end_reference", (tx) =>
          tx.unsafe(endSeat(seat.id, "now() - interval '10 days'", reference)),
        );
      // The boundary: one microsecond before now is the past.
      await s.expectError("CDF_INVALID:end_reference", (tx) =>
        tx.unsafe(endSeat(seat.id, "now() - interval '1 microsecond'")),
      );
      expect(await endOf(s, "committee.membership", seat.id)).toEqual(OPEN);
      expect(await ledger(s), "a refusal writes nothing").toBe(before);

      await s.as("platformAdmin");
      await s.tx.unsafe(endSeat(seat.id, "now() - interval '10 days'", `  ${REFERENCE} `));
      await s.asOwner();
      const [ended] = await s.tx<
        { dated: boolean; recorded_now: boolean; ended_by: string; end_reference: string }[]
      >`
        select effective_to = now() - interval '10 days' as dated, ended_at = now() as recorded_now, ended_by,
               end_reference
          from committee.membership where id = ${seat.id}`;
      expect(ended).toEqual({
        dated: true,
        recorded_now: true,
        ended_by: USERS.platformAdmin,
        end_reference: REFERENCE,
      });
      const [event, ...more] = await events(s, "COMMITTEE_MEMBERSHIP_ENDED");
      expect(more).toEqual([]);
      expect(event).toMatchObject({
        object_type: "committee_membership",
        object_id: seat.id,
        outcome: "SUCCESS",
        actor_id: USERS.platformAdmin,
        reason: REASON,
      });
      expect(Object.keys(event!.metadata).sort()).toEqual([
        "committee_id",
        "effective_to",
        "seat",
        "user_id",
      ]);
      expect(event!.metadata).toMatchObject({ committee_id: ic, user_id: seat.user_id, seat: "MEMBER" });
      expect(JSON.stringify(event), "the reference is on the row, never in the ledger").not.toContain(
        REFERENCE,
      );
    });
  });

  it("a position: the same, and no end date still means now, which needs no reference", async () => {
    await ownerScenario(async (s) => {
      const member = await position(s, ops, "employee");
      const before = await ledger(s);
      await s.as("platformAdmin");
      for (const reference of MISSING)
        await s.expectError("CDF_INVALID:end_reference", (tx) =>
          tx.unsafe(endPosition(member, "now() - interval '10 days'", reference)),
        );
      await s.expectError("CDF_INVALID:end_reference", (tx) =>
        tx.unsafe(endPosition(member, "now() - interval '1 microsecond'")),
      );
      expect(await endOf(s, "iam.sector_membership", member)).toEqual(OPEN);
      expect(await ledger(s), "a refusal writes nothing").toBe(before);

      await s.as("platformAdmin");
      await s.tx.unsafe(endPosition(member, "now() - interval '10 days'", `${REFERENCE}  `));
      await s.asOwner();
      const [ended] = await s.tx<{ dated: boolean; recorded_now: boolean; end_reference: string }[]>`
        select effective_to = now() - interval '10 days' as dated, ended_at = now() as recorded_now, end_reference
          from iam.sector_membership where id = ${member}`;
      expect(ended).toEqual({ dated: true, recorded_now: true, end_reference: REFERENCE });
      const [event, ...more] = await events(s, "SECTOR_MEMBERSHIP_ENDED");
      expect(more).toEqual([]);
      expect(event).toMatchObject({
        object_type: "sector_membership",
        object_id: member,
        outcome: "SUCCESS",
        reason: REASON,
      });
      expect(Object.keys(event!.metadata).sort()).toEqual([
        "effective_to",
        "position",
        "sector_id",
        "user_id",
      ]);
      expect(event!.metadata).toMatchObject({ sector_id: ops, user_id: USERS.employee, position: "MEMBER" });
      expect(JSON.stringify(event), "the reference is on the row, never in the ledger").not.toContain(
        REFERENCE,
      );

      // No end date: the position ends now, with no reference.
      const other = await position(s, ops, "employeeB");
      await s.as("platformAdmin");
      await s.tx.unsafe(endPosition(other, "null"));
      await s.asOwner();
      const [now] = await s.tx<{ at_now: boolean; end_reference: string | null }[]>`
        select effective_to = now() and ended_at = now() as at_now, end_reference
          from iam.sector_membership where id = ${other}`;
      expect(now).toEqual({ at_now: true, end_reference: null });
    });
  });

  it("an end now or later needs no reference; a reference given with one is checked and recorded", async () => {
    await ownerScenario(async (s) => {
      const chair = await demoSeat(s, gc, "CHAIR");
      const secretary = await demoSeat(s, gc, "SECRETARY");
      const head = await position(s, ops, "sectorHead");
      const finance = await position(s, fin, "financeEmployee");
      await s.as("platformAdmin");
      await s.tx.unsafe(endSeat(chair.id, "now()"));
      await s.tx.unsafe(endPosition(head, "now() + interval '1 day'"));
      for (const reference of ["", "   ", "ab", "x".repeat(201)]) {
        await s.expectError("CDF_INVALID:end_reference", (tx) =>
          tx.unsafe(endSeat(secretary.id, "now() + interval '1 day'", reference)),
        );
        await s.expectError("CDF_INVALID:end_reference", (tx) =>
          tx.unsafe(endPosition(finance, "now()", reference)),
        );
      }
      expect(await endOf(s, "committee.membership", secretary.id)).toEqual(OPEN);
      expect(await endOf(s, "iam.sector_membership", finance)).toEqual(OPEN);
      await s.as("platformAdmin");
      await s.tx.unsafe(endSeat(secretary.id, "now() + interval '1 day'", REFERENCE));
      await s.tx.unsafe(endPosition(finance, "now()", REFERENCE));
      expect((await endOf(s, "committee.membership", chair.id)).end_reference).toBeNull();
      expect((await endOf(s, "iam.sector_membership", head)).end_reference).toBeNull();
      expect((await endOf(s, "committee.membership", secretary.id)).end_reference).toBe(REFERENCE);
      expect((await endOf(s, "iam.sector_membership", finance)).end_reference).toBe(REFERENCE);
    });
  });

  it("the reference is asked last: the caller, the row, an end already recorded, the date and the reason are answered first, as built", async () => {
    await ownerScenario(async (s) => {
      const seat = await demoSeat(s, ic, "CHAIR");
      const ended = await demoSeat(s, ic, "SECRETARY");
      const member = await position(s, ops, "employee");
      const gone = await position(s, ops, "employeeB");
      await s.as("platformAdmin");
      await s.tx.unsafe(endSeat(ended.id, "now()"));
      await s.tx.unsafe(endPosition(gone, "null"));
      const past = "now() - interval '1 day'";
      const answers = async (user: UserKey) =>
        outcomes(s, user, {
          seat: endSeat(seat.id, past),
          seatUnknown: endSeat(randomUUID(), past),
          seatEnded: endSeat(ended.id, past),
          seatBeforeStart: endSeat(seat.id, "'2025-12-31T00:00:00Z'::timestamptz"),
          seatShortReason: `select api.end_committee_membership('${seat.id}', ${past}, 'abc')`,
          position: endPosition(member, past),
          positionUnknown: endPosition(randomUUID(), past),
          positionEnded: endPosition(gone, past),
          positionBeforeStart: endPosition(member, "'2025-12-31T00:00:00Z'::timestamptz"),
          positionShortReason: `select api.end_sector_membership('${member}', ${past}, 'abc')`,
        });
      expect(await answers("platformAdmin")).toEqual({
        seat: "CDF_INVALID:end_reference",
        seatUnknown: "CDF_NOT_FOUND",
        seatEnded: "CDF_CONFLICT:MEMBERSHIP_ENDED",
        seatBeforeStart: "CDF_INVALID:effective_to",
        seatShortReason: "CDF_INVALID:reason",
        position: "CDF_INVALID:end_reference",
        positionUnknown: "CDF_NOT_FOUND",
        positionEnded: "CDF_CONFLICT:MEMBERSHIP_ALREADY_ENDED",
        positionBeforeStart: "CDF_INVALID:effective_to",
        positionShortReason: "CDF_INVALID:reason",
      });
      // A committee administrator who is not a sector administrator, and someone who is neither.
      const director = await answers("grcDirector");
      expect(director.seat).toBe("CDF_INVALID:end_reference");
      for (const key of [
        "position",
        "positionUnknown",
        "positionEnded",
        "positionBeforeStart",
        "positionShortReason",
      ])
        expect(director[key], key).toBe("CDF_FORBIDDEN");
      for (const answer of Object.values(await answers("intake"))) expect(answer).toBe("CDF_FORBIDDEN");
      for (const answer of Object.values(await answers("revoked")))
        expect(answer).toBe("CDF_UNAUTHENTICATED");
    });
  });

  it("the reference is written with the end and never again: the table owner can neither set it on a row that is not ended, change or clear it on an ended one, nor end a row in the past without it", async () => {
    await ownerScenario(async (s) => {
      const open = await demoSeat(s, ic, "DEPUTY_CHAIR");
      const ended = await demoSeat(s, ic, "MEMBER");
      const openPosition = await position(s, ops, "sectorHead");
      const endedPosition = await position(s, ops, "employee");
      await s.as("platformAdmin");
      await s.tx.unsafe(endSeat(ended.id, "now() - interval '3 days'", REFERENCE));
      await s.tx.unsafe(endPosition(endedPosition, "now() - interval '3 days'", REFERENCE));
      await s.asOwner();

      const tables = [
        {
          table: "committee.membership",
          relation: "membership",
          open: open.id,
          ended: ended.id,
          label: "membership",
        },
        {
          table: "iam.sector_membership",
          relation: "sector_membership",
          open: openPosition,
          ended: endedPosition,
          label: "sector membership",
        },
      ];
      for (const t of tables) {
        await s.expectError(
          `new row for relation "${t.relation}" violates check constraint "${t.relation}_end_reference_on_end"`,
          (tx) => tx.unsafe(`update ${t.table} set end_reference = 'DEMO-OTHER' where id = $1`, [t.open]),
        );
        await s.expectError(
          `new row for relation "${t.relation}" violates check constraint "${t.relation}_past_end_has_reference"`,
          (tx) =>
            tx.unsafe(
              `update ${t.table} set effective_to = now() - interval '1 day', ended_by = $2, ended_at = now(),
                      end_reason = $3
                where id = $1`,
              [t.open, USERS.platformAdmin, REASON],
            ),
        );
        for (const change of ["end_reference = 'DEMO-OTHER'", "end_reference = null"])
          await s.expectError(`${t.label} ${t.ended} can only be ended earlier, once`, (tx) =>
            tx.unsafe(`update ${t.table} set ${change} where id = $1`, [t.ended]),
          );
        await s.expectError(
          `new row for relation "${t.relation}" violates check constraint "${t.relation}_end_reference_check"`,
          (tx) =>
            tx.unsafe(
              `update ${t.table} set effective_to = now() - interval '1 day', ended_by = $2, ended_at = now(),
                      end_reason = $3, end_reference = 'ab'
                where id = $1`,
              [t.open, USERS.platformAdmin, REASON],
            ),
        );
      }
      // Nor insert a row already ended in the past without it.
      await s.expectError(
        'new row for relation "membership" violates check constraint "membership_past_end_has_reference"',
        (tx) => tx`
          insert into committee.membership (committee_id, user_id, seat, effective_from, effective_to,
                                            appointment_reference, appointed_by, ended_by, ended_at, end_reason)
          values (${gc}, ${USERS.investigatorA}, 'MEMBER', now() - interval '10 days', now() - interval '1 day',
                  'DEMO-APPT', ${USERS.platformAdmin}, ${USERS.platformAdmin}, now(), ${REASON})`,
      );
      await s.expectError(
        'new row for relation "sector_membership" violates check constraint "sector_membership_past_end_has_reference"',
        (tx) => tx`
          insert into iam.sector_membership (sector_id, user_id, position, effective_from, effective_to,
                                             appointment_reference, appointed_by, ended_by, ended_at, end_reason)
          values (${fin}, ${USERS.investigatorA}, 'MEMBER', now() - interval '10 days', now() - interval '1 day',
                  'DEMO-APPT', ${USERS.platformAdmin}, ${USERS.platformAdmin}, now(), ${REASON})`,
      );
      // Ending with the reference is what the commands do; the owner may do the same.
      await s.tx`update committee.membership
                    set effective_to = now() - interval '1 day', ended_by = ${USERS.platformAdmin}, ended_at = now(),
                        end_reason = ${REASON}, end_reference = ${REFERENCE}
                  where id = ${open.id}`;
      expect((await endOf(s, "committee.membership", open.id)).end_reference).toBe(REFERENCE);
    });
  });

  it("the two registry triggers are as built apart from the reference: every other rule of 1870 and 1880 is unchanged", async () => {
    // The live function bodies, comments and spacing aside, are the built ones with end_reference added to the
    // columns the update that ends a seat or a position may set, and nothing else.
    const built = (file: string, fn: string) => {
      const sql = readFileSync(`infrastructure/supabase/migrations/${file}`, "utf8");
      const start = sql.indexOf(`create function ${fn}()`);
      expect(start, `${fn} in ${file}`).toBeGreaterThan(0);
      const open = sql.indexOf("as $$", start) + "as $$".length;
      return sql.slice(open, sql.indexOf("$$;", open));
    };
    const code = (src: string) =>
      src
        .replace(/--[^\n]*/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const live = await admin<{ name: string; src: string }[]>`
      select n.nspname || '.' || p.proname as name, p.prosrc as src
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname, p.proname) in (('committee', 'protect_registry'), ('iam', 'protect_sector_registry'))
       order by 1`;
    const expected = {
      "committee.protect_registry": built(
        "20261007001870_core_domain_committee_registry.sql",
        "committee.protect_registry",
      ),
      "iam.protect_sector_registry": built(
        "20261007001880_direct_referral_preliminary_review.sql",
        "iam.protect_sector_registry",
      ),
    };
    expect(live.map((r) => r.name)).toEqual(Object.keys(expected));
    for (const r of live) {
      const was = expected[r.name as keyof typeof expected];
      expect(
        was.split("'end_reason']").length - 1,
        `${r.name}: the two arrays of the membership branch`,
      ).toBe(2);
      expect(code(r.src), r.name).toBe(
        code(was.replaceAll("'end_reason']", "'end_reason', 'end_reference']")),
      );
    }
  });

  it("an appointment dated in the past already records its reference on the row and an audit event with ids and codes only, as built", async () => {
    await ownerScenario(async (s) => {
      await s.as("platformAdmin");
      for (const reference of [null, "", "ab", "x".repeat(201)]) {
        await s.expectError(
          "CDF_INVALID:appointment_reference",
          (tx) =>
            tx`select api.appoint_committee_member(${ic}, ${USERS.investigatorA}, 'MEMBER', now() - interval '30 days',
               null, ${reference})`,
        );
        await s.expectError(
          "CDF_INVALID:appointment_reference",
          (tx) =>
            tx`select api.appoint_sector_member(${fin}, ${USERS.investigatorA}, 'MEMBER', now() - interval '30 days',
               null, ${reference})`,
        );
      }
      const [seat] = await s.tx<{ id: string }[]>`
        select api.appoint_committee_member(${ic}, ${USERS.investigatorA}, 'MEMBER', now() - interval '30 days', null,
          ${REFERENCE}) as id`;
      const [member] = await s.tx<{ id: string }[]>`
        select api.appoint_sector_member(${fin}, ${USERS.investigatorA}, 'MEMBER', now() - interval '30 days', null,
          ${REFERENCE}) as id`;
      await s.asOwner();
      const [row] = await s.tx<{ reference: string }[]>`
        select appointment_reference as reference from committee.membership where id = ${seat!.id}`;
      const [prow] = await s.tx<{ reference: string }[]>`
        select appointment_reference as reference from iam.sector_membership where id = ${member!.id}`;
      expect([row!.reference, prow!.reference]).toEqual([REFERENCE, REFERENCE]);
      const [appointed] = await events(s, "COMMITTEE_MEMBER_APPOINTED");
      const [positioned] = await events(s, "SECTOR_MEMBER_APPOINTED");
      expect(appointed).toMatchObject({ object_id: seat!.id, reason: null, outcome: "SUCCESS" });
      expect(positioned).toMatchObject({ object_id: member!.id, reason: null, outcome: "SUCCESS" });
      expect(Object.keys(appointed!.metadata).sort()).toEqual([
        "committee_id",
        "effective_from",
        "effective_to",
        "seat",
        "user_id",
      ]);
      expect(Object.keys(positioned!.metadata).sort()).toEqual([
        "effective_from",
        "effective_to",
        "position",
        "sector_id",
        "user_id",
      ]);
      expect(JSON.stringify([appointed, positioned])).not.toContain(REFERENCE);
    });
  });
});

// ---- The flags ---------------------------------------------------------------------------------------------------------

/** Each flag of a read against what its command answers now for the same caller, run and rolled back. */
function expectFlag(label: string, flag: unknown, answer: Answer | undefined): void {
  expect(typeof flag, `${label}: a boolean`).toBe("boolean");
  expect(flag, `${label}: ${String(answer)}`).toBe(answer === true);
}

interface CommitteeCaps {
  committees: {
    committee_id: string;
    may_set_rule_set: boolean;
    may_revise_rule_set: boolean;
    may_appoint: boolean;
    seats: { membership_id: string; may_end: boolean }[];
  }[];
}

interface SectorCaps {
  may_create_sector: boolean;
  sectors: {
    sector_id: string;
    may_appoint: boolean;
    positions: { membership_id: string; may_end: boolean }[];
  }[];
  delegations: { delegation_id: string; may_revoke: boolean }[];
}

/** An end each command accepts on its input checks: after the start, not after the end already set, with a reference. */
const acceptedEnd = (table: string, id: string) =>
  `(select least(coalesce(m.effective_to, 'infinity'::timestamptz), greatest(now(), m.effective_from + interval '1 second'))
      from ${table} m where m.id = '${id}')`;

/** Appointing someone no seat or position stands in the way of, far ahead, so only the caller and the row can refuse. */
const appointSeat = (committee: string) =>
  `select api.appoint_committee_member('${committee}', '${USERS.investigatorA}', 'MEMBER', now() + interval '400 days',
     null, '${REFERENCE}')`;
const appointPosition = (sector: string) =>
  `select api.appoint_sector_member('${sector}', '${USERS.investigatorA}', 'MEMBER', now() + interval '400 days', null,
     '${REFERENCE}')`;

/** The committees and their seats, in the read's order, as the owner reads them. */
async function seatRegister(s: OwnerScenario) {
  await s.asOwner();
  const committees = await s.tx<
    { id: string }[]
  >`select id from committee.committee order by code collate "C", id`;
  const seats = await s.tx<{ id: string; committee_id: string }[]>`
    select id, committee_id from committee.membership order by effective_from, id`;
  return committees.map((c) => ({
    id: c.id,
    seats: seats.filter((m) => m.committee_id === c.id).map((m) => m.id),
  }));
}

async function positionRegister(s: OwnerScenario) {
  await s.asOwner();
  const sectors = await s.tx<{ id: string }[]>`select id from iam.sector order by code collate "C", id`;
  const positions = await s.tx<{ id: string; sector_id: string }[]>`
    select id, sector_id from iam.sector_membership order by effective_from, id`;
  return sectors.map((c) => ({
    id: c.id,
    positions: positions.filter((m) => m.sector_id === c.id).map((m) => m.id),
  }));
}

/** One caller's committee read against the appointment and end commands; returns whether the read answered. */
async function committeeSweep(s: OwnerScenario, user: UserKey): Promise<Answer> {
  const register = await seatRegister(s);
  const o = await outcomes(s, user, {
    read: "select api.admin_committee_capabilities()",
    ...Object.fromEntries(register.map((c) => [`appoint:${c.id}`, appointSeat(c.id)])),
    ...Object.fromEntries(
      register.flatMap((c) =>
        c.seats.map((m) => [`end:${m}`, endSeat(m, acceptedEnd("committee.membership", m), REFERENCE)]),
      ),
    ),
  });
  if (o.read !== true) {
    for (const [key, answer] of Object.entries(o)) expect(answer, `${user}: ${key}`).toBe(o.read);
    return o.read!;
  }
  await s.as(user);
  const [r] = await s.tx<{ v: CommitteeCaps }[]>`select api.admin_committee_capabilities() as v`;
  const caps = r!.v;
  expect(
    caps.committees.map((c) => [c.committee_id, c.seats.map((m) => m.membership_id)]),
    `${user}: every committee and each of its seats, in order`,
  ).toEqual(register.map((c) => [c.id, c.seats]));
  for (const c of caps.committees) {
    expectFlag(`${user}: may_appoint ${c.committee_id}`, c.may_appoint, o[`appoint:${c.committee_id}`]);
    for (const m of c.seats)
      expectFlag(`${user}: may_end ${m.membership_id}`, m.may_end, o[`end:${m.membership_id}`]);
  }
  return true;
}

async function sectorSweep(s: OwnerScenario, user: UserKey): Promise<Answer> {
  const register = await positionRegister(s);
  const o = await outcomes(s, user, {
    read: "select api.admin_sector_capabilities()",
    ...Object.fromEntries(register.map((c) => [`appoint:${c.id}`, appointPosition(c.id)])),
    ...Object.fromEntries(
      register.flatMap((c) =>
        c.positions.map((m) => [
          `end:${m}`,
          endPosition(m, acceptedEnd("iam.sector_membership", m), REFERENCE),
        ]),
      ),
    ),
  });
  if (o.read !== true) {
    for (const [key, answer] of Object.entries(o)) expect(answer, `${user}: ${key}`).toBe(o.read);
    return o.read!;
  }
  await s.as(user);
  const [r] = await s.tx<{ v: SectorCaps }[]>`select api.admin_sector_capabilities() as v`;
  const caps = r!.v;
  expect(
    caps.sectors.map((c) => [c.sector_id, c.positions.map((m) => m.membership_id)]),
    `${user}: every sector and each of its positions, in order`,
  ).toEqual(register.map((c) => [c.id, c.positions]));
  for (const c of caps.sectors) {
    expectFlag(`${user}: may_appoint ${c.sector_id}`, c.may_appoint, o[`appoint:${c.sector_id}`]);
    for (const m of c.positions)
      expectFlag(`${user}: may_end ${m.membership_id}`, m.may_end, o[`end:${m.membership_id}`]);
  }
  return true;
}

describe("the seat and position flags are their commands' answers (migration 2128)", () => {
  it("every seed user: may_appoint per committee and may_end per seat, for seats in force, scheduled, lapsed and ended; everyone else is refused as the commands refuse them", async () => {
    await ownerScenario(async (s) => {
      await s.as("platformAdmin");
      const [scheduled] = await s.tx<{ id: string }[]>`
        select api.appoint_committee_member(${ic}, ${USERS.investigatorB}, 'MEMBER', now() + interval '30 days',
          now() + interval '60 days', ${REFERENCE}) as id`;
      const [lapsed] = await s.tx<{ id: string }[]>`
        select api.appoint_committee_member(${gc}, ${USERS.lead}, 'MEMBER', now() - interval '30 days',
          now() - interval '10 days', ${REFERENCE}) as id`;
      const [ended] = await s.tx<{ id: string }[]>`
        select api.appoint_committee_member(${gc}, ${USERS.legal}, 'MEMBER', now() - interval '5 days', null,
          ${REFERENCE}) as id`;
      await s.tx.unsafe(endSeat(ended!.id, "now()"));
      const before = await ledger(s);
      const holders: UserKey[] = [];
      for (const user of ALL) {
        const answer = await committeeSweep(s, user);
        if (answer === true) holders.push(user);
        else
          expect([user, answer]).toEqual([
            user,
            user === "revoked" ? "CDF_UNAUTHENTICATED" : "CDF_FORBIDDEN",
          ]);
      }
      expect(holders).toEqual(COMMITTEE_ADMINS);
      expect(await ledger(s), "reading and probing write nothing").toBe(before);
      // The states the end command tells apart, as one administrator's answers.
      const o = await outcomes(s, "platformAdmin", {
        scheduled: endSeat(scheduled!.id, acceptedEnd("committee.membership", scheduled!.id), REFERENCE),
        lapsed: endSeat(lapsed!.id, acceptedEnd("committee.membership", lapsed!.id), REFERENCE),
        lapsedNoReference: endSeat(lapsed!.id, acceptedEnd("committee.membership", lapsed!.id)),
        ended: endSeat(ended!.id, acceptedEnd("committee.membership", ended!.id), REFERENCE),
      });
      expect(o).toEqual({
        scheduled: true,
        // A seat whose term has run out may still be ended earlier, in the past, with its reference.
        lapsed: true,
        lapsedNoReference: "CDF_INVALID:end_reference",
        ended: "CDF_CONFLICT:MEMBERSHIP_ENDED",
      });
    });
  });

  it("every seed user: may_appoint per sector and may_end per position, likewise", async () => {
    await ownerScenario(async (s) => {
      await s.as("platformAdmin");
      await s.tx`select api.appoint_sector_member(${fin}, ${USERS.investigatorB}, 'MEMBER', now() + interval '30 days',
                   now() + interval '60 days', ${REFERENCE})`;
      await s.tx`select api.appoint_sector_member(${ops}, ${USERS.lead}, 'MEMBER', now() - interval '30 days',
                   now() - interval '10 days', ${REFERENCE})`;
      const [created] = await s.tx<{ id: string }[]>`
        select api.create_sector('SYN2128', 'Synthetic sector', 'قطاع تجريبي') as id`;
      const finance = await position(s, fin, "financeEmployee");
      await s.as("platformAdmin");
      await s.tx.unsafe(endPosition(finance, "null"));
      const before = await ledger(s);
      const holders: UserKey[] = [];
      for (const user of ALL) {
        const answer = await sectorSweep(s, user);
        if (answer === true) holders.push(user);
        else
          expect([user, answer]).toEqual([
            user,
            user === "revoked" ? "CDF_UNAUTHENTICATED" : "CDF_FORBIDDEN",
          ]);
      }
      expect(holders).toEqual(["platformAdmin"]);
      expect(await ledger(s), "reading and probing write nothing").toBe(before);
      // A sector with no position yet is listed, with an empty list.
      await s.as("platformAdmin");
      const [r] = await s.tx<{ v: SectorCaps }[]>`select api.admin_sector_capabilities() as v`;
      expect(r!.v.sectors.find((x) => x.sector_id === created!.id)).toEqual({
        sector_id: created!.id,
        may_appoint: true,
        positions: [],
      });
    });
  });

  it("one permission alone: COMMITTEE_ADMIN gives the committee flags and no sector read, SECTOR_ADMIN the sector flags and no committee read", async () => {
    await ownerScenario(async (s) => {
      for (const permission of ["COMMITTEE_ADMIN", "SECTOR_ADMIN"]) {
        await s.asOwner();
        const role = `SYN_ONLY_${permission}`;
        await s.tx`insert into iam.role (code, name_en, name_ar, description)
                   values (${role}, 'Synthetic role', 'دور تجريبي', 'Synthetic: one permission for the test only.')`;
        await s.tx`insert into iam.role_permission (role_code, permission_code) values (${role}, ${permission})`;
        const [grant] = await s.tx<{ id: string }[]>`
          insert into iam.user_role_assignment (user_id, role_code, justification)
          values (${USERS.intake}, ${role}, 'Synthetic: test only.') returning id`;
        const committees = await committeeSweep(s, "intake");
        const sectors = await sectorSweep(s, "intake");
        expect([permission, committees, sectors]).toEqual(
          permission === "COMMITTEE_ADMIN"
            ? [permission, true, "CDF_FORBIDDEN"]
            : [permission, "CDF_FORBIDDEN", true],
        );
        await s.asOwner();
        await s.tx`delete from iam.user_role_assignment where id = ${grant!.id}`;
      }
    });
  });
});

// ---- The functions -----------------------------------------------------------------------------------------------------

describe("the functions of migration 2128", () => {
  it("each end command has one signature, the reference last with no reference by default; the appointment commands keep theirs; all are executable by authenticated only", async () => {
    const rows = await admin<
      { name: string; args: string; authenticated: boolean; anon: boolean; everyone: boolean }[]
    >`
      select p.proname as name, pg_get_function_arguments(p.oid) as args,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('public', p.oid, 'execute') as everyone
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'api' and p.proname in ('end_committee_membership', 'end_sector_membership',
                                                   'appoint_committee_member', 'appoint_sector_member')
       order by p.proname collate "C", 2`;
    const grant = { authenticated: true, anon: false, everyone: false };
    expect(rows).toEqual([
      {
        name: "appoint_committee_member",
        args: "p_committee_id uuid, p_user_id uuid, p_seat text, p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_appointment_reference text",
        ...grant,
      },
      {
        name: "appoint_sector_member",
        args: "p_sector_id uuid, p_user_id uuid, p_position text, p_effective_from timestamp with time zone, p_effective_to timestamp with time zone, p_appointment_reference text",
        ...grant,
      },
      {
        name: "end_committee_membership",
        args: "p_membership_id uuid, p_effective_to timestamp with time zone, p_reason text, p_end_reference text DEFAULT NULL::text",
        ...grant,
      },
      {
        name: "end_sector_membership",
        args: "p_membership_id uuid, p_effective_to timestamp with time zone, p_reason text, p_end_reference text DEFAULT NULL::text",
        ...grant,
      },
    ]);
  });

  it("the two reads stay stable and security definer with an empty search path, and take no lock, run no command and open no subtransaction", async () => {
    const rows = await admin<
      { name: string; volatile: string; definer: boolean; config: string[]; src: string }[]
    >`
      select p.proname as name, p.provolatile as volatile, p.prosecdef as definer, p.proconfig as config, p.prosrc as src
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'api' and p.proname in ('admin_committee_capabilities', 'admin_sector_capabilities')
       order by p.proname collate "C"`;
    expect(rows.map((r) => [r.name, r.volatile, r.definer, r.config])).toEqual([
      ["admin_committee_capabilities", "s", true, ['search_path=""']],
      ["admin_sector_capabilities", "s", true, ['search_path=""']],
    ]);
    for (const r of rows) {
      const code = r.src.replace(/--[^\n]*/g, "");
      expect(code, `${r.name}: no subtransaction`).not.toMatch(/\bexception\b/i);
      expect(code, `${r.name}: no row lock`).not.toMatch(/\bfor (update|share)\b/i);
      expect(code, `${r.name}: no advisory lock`).not.toMatch(/pg_advisory/i);
      expect(code, `${r.name}: no lock helper`).not.toMatch(/\block_(committee|sector)\b/i);
      for (const c of [
        "appoint_committee_member",
        "end_committee_membership",
        "appoint_sector_member",
        "end_sector_membership",
      ])
        expect(code, `${r.name} runs ${c}`).not.toContain(`api.${c}(`);
    }
  });
});
