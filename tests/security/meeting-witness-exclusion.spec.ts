// Business architecture rebase, migration 2010 (ADR-039; gap P11-G4, witness half; T3-B2.4-241, CRM-F118, S112):
// excluding a witness from a committee meeting. The secretary running the meeting excludes a WITNESS invitee once, with
// a reason that only the secretary and the members cleared for the deliberation read. The excluded witness no longer
// sees the meeting through their participation (coordinator ruling, SOURCE_REQUIRED); their participant row is never
// changed again and no concern is raised about them. Other witnesses, the members and the case team are unaffected.
// Every step runs through the api.* commands as `authenticated`; the owner connection only probes the tables.
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, type Scenario } from "../support/db";
import { IC_SEATS, REASON, committeeIds, openWithPresent, scheduleMeeting, seat } from "../support/committee";

const EXCLUSION = "Synthetic: unique-exclusion-marker-2010, the witness approached a member.";

let caseB: string, ic: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic } = await committeeIds());
});

const invite = async (s: Scenario, meeting: string, user: string | null, person: string | null = null) => {
  await s.as("committeeSecretary");
  const [r] = await s.tx<{ id: string }[]>`
    select api.invite_to_meeting(${meeting}, 'WITNESS', ${user}, ${person}, ${user !== null}, ${REASON}) as id`;
  return r!.id;
};
const exclude = (s: Scenario, participant: string, reason = EXCLUSION) =>
  s.tx<{ id: string }[]>`select api.exclude_meeting_witness(${participant}, ${reason}) as id`;

/** A second meeting of the same committee proceeding. */
async function another(s: Scenario, committeeProceeding: string): Promise<string> {
  await s.as("committeeSecretary");
  const [m] = await s.tx<{ id: string }[]>`
    select api.schedule_meeting(${committeeProceeding}, 'HEARING', 'IN_PERSON', 'Hearing room (synthetic)', null,
      now() + interval '2 days', now() + interval '2 days 2 hours', ${REASON}) as id`;
  return m!.id;
}

async function sees(s: Scenario, meeting: string): Promise<{ meeting: number; rows: number }> {
  const m = await s.tx`select id from committee.meeting where id = ${meeting}`;
  const p = await s.tx`select id from committee.meeting_participant where meeting_id = ${meeting}`;
  return { meeting: m.length, rows: p.length };
}

describe("excluding a witness from a meeting (migration 2010, P11-G4, ADR-039)", () => {
  it("the secretary excludes a witness with a reason; the witness loses the meeting, nobody else does", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const g = await another(s, f.committeeProceeding);
      const w = await invite(s, f.meeting, USERS.employeeB);
      const other = await invite(s, f.meeting, USERS.financeEmployee);
      await invite(s, g, USERS.employeeB);
      await s.as("committeeSecretary");
      const [expert] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${f.meeting}, 'EXPERT', ${USERS.investigatorA}, null, false, ${REASON}) as id`;
      await s.as("employeeB");
      expect(await sees(s, f.meeting)).toEqual({ meeting: 1, rows: 1 });
      await s.tx`select api.declare_meeting_conflict(${w}, 'NO_CONFLICT', null)`;

      // Only the secretary running the meeting excludes; outsiders learn nothing.
      for (const u of ["committeeChair", "legal", "caseManager", "employeeB", "financeEmployee"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", () => exclude(s, w));
      }
      for (const u of ["employee", "platformAdmin", "internalAudit"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", () => exclude(s, w));
      }
      await s.as("revoked");
      await s.expectError("CDF_UNAUTHENTICATED", () => exclude(s, w));
      await s.as(null);
      await s.expectError("permission denied", () => exclude(s, w));

      // A witness only: a member seat and an expert are not covered.
      await s.as("committeeSecretary");
      await s.expectError("CDF_INVALID:participant", () => exclude(s, f.participant.legal!));
      await s.expectError("CDF_INVALID:participant", () => exclude(s, expert!.id));
      await s.expectError("CDF_INVALID:reason", () => exclude(s, w, "too short"));

      await s.asOwner();
      const [before] =
        await s.tx`select to_jsonb(mp) as row from committee.meeting_participant mp where id = ${w}`;
      await s.as("committeeSecretary");
      const [x] = await exclude(s, w);
      await s.expectError("CDF_CONFLICT:ALREADY_EXCLUDED", () => exclude(s, w));

      // The exclusion never changes the participant row.
      await s.asOwner();
      const [after] =
        await s.tx`select to_jsonb(mp) as row from committee.meeting_participant mp where id = ${w}`;
      expect(after).toEqual(before);

      // The excluded witness no longer sees this meeting, their row or the exclusion; their other meeting stays.
      await s.as("employeeB");
      expect(await sees(s, f.meeting)).toEqual({ meeting: 0, rows: 0 });
      expect(await s.tx`select id from committee.witness_exclusion`).toEqual([]);
      expect(await sees(s, g)).toEqual({ meeting: 1, rows: 1 });
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.declare_meeting_conflict(${w}, 'CONFLICT_DECLARED', 'Synthetic: late declaration.')`,
      );
      // Another witness, the case team and the members are unaffected.
      await s.as("financeEmployee");
      expect(await sees(s, f.meeting)).toEqual({ meeting: 1, rows: 1 });
      await s.as("caseManager");
      expect((await sees(s, f.meeting)).meeting).toBe(1);
      await s.as("legal");
      expect((await sees(s, f.meeting)).meeting).toBe(1);

      // The reason: the secretary and the members cleared for the deliberation.
      await openWithPresent(s, f, ["committeeChair", "legal", "legalB", "lead"]);
      await s.as("committeeSecretary");
      expect(await s.tx`select id, reason from committee.witness_exclusion`).toEqual([
        { id: x!.id, reason: EXCLUSION },
      ]);
      for (const u of ["committeeChair", "legal"] as const) {
        await s.as(u);
        expect(await s.tx`select id from committee.witness_exclusion`, u).toEqual([{ id: x!.id }]);
      }
      for (const u of [
        "caseManager",
        "financeEmployee",
        "investigatorA",
        "employeeB",
        "platformAdmin",
      ] as const) {
        await s.as(u);
        expect(await s.tx`select id from committee.witness_exclusion`, u).toEqual([]);
      }

      // The row is final: no attendance, excuse or concern for the excluded witness.
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:WITNESS_EXCLUDED",
        (tx) => tx`select api.record_attendance(${w}, 'PRESENT')`,
      );
      await s.expectError(
        "CDF_CONFLICT:WITNESS_EXCLUDED",
        (tx) => tx`select api.record_excused_absence(${w}, 'Synthetic: travelling.')`,
      );
      await s.as("legal");
      await s.expectError(
        "CDF_CONFLICT:WITNESS_EXCLUDED",
        (tx) => tx`select api.raise_meeting_conflict(${w}, 'Synthetic: a concern about the witness.')`,
      );
      // The other witness declares and attends as usual.
      await s.as("financeEmployee");
      await s.tx`select api.declare_meeting_conflict(${other}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${other}, 'PRESENT')`;

      // The ledger has the fact with ids only; append-only for the owner too.
      await s.asOwner();
      const events = await s.tx<{ object_type: string; reason: string | null; metadata: unknown }[]>`
        select object_type, reason, metadata from audit.audit_event where action = 'WITNESS_EXCLUDED' and object_id = ${x!.id}`;
      expect(events).toEqual([
        {
          object_type: "witness_exclusion",
          reason: null,
          metadata: { meeting_id: f.meeting, participant_id: w },
        },
      ]);
      const all = await s.tx`select reason, metadata from audit.audit_event where case_id = ${caseB}`;
      expect(JSON.stringify(all)).not.toMatch(/unique-exclusion-marker/);
      await s.expectError(
        "",
        (tx) =>
          tx`update committee.witness_exclusion set reason = 'Synthetic: changed reason.' where id = ${x!.id}`,
      );
      await s.expectError("", (tx) => tx`delete from committee.witness_exclusion where id = ${x!.id}`);
      await s.expectError(
        "",
        (tx) => tx`update committee.meeting_participant set attendance = 'ABSENT' where id = ${w}`,
      );
    });
  });

  it("a concern about the witness is decided first; a witness without an account; the meeting and case must be live", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const w = await invite(s, f.meeting, USERS.employeeB);
      // A person on the case with no account.
      await s.as("caseManager");
      await s.tx`select api.add_case_subject(${caseB}, 'Witness Gamma (synthetic)', 'OTHER_AUTHORIZED', null)`;
      await s.asOwner();
      const [person] = await s.tx<{ person_id: string }[]>`
        select person_id from case_mgmt.case_person where case_id = ${caseB} order by added_at desc limit 1`;
      const anon = await invite(s, f.meeting, null, person!.person_id);
      await openWithPresent(s, f, ["committeeChair", "legal", "legalB", "lead"]);

      await s.as("legal");
      const [k] = await s.tx<{ id: string }[]>`
        select api.raise_meeting_conflict(${w}, 'Synthetic: the witness reports to a member.') as id`;
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:CONCERN_OPEN", () => exclude(s, w));
      await s.as("committeeChair");
      await s.tx`select api.decide_meeting_conflict(${k!.id}, 'DISMISSED', 'Synthetic: no link found.')`;
      await s.as("committeeSecretary");
      await exclude(s, w);

      // A witness without an account: excluded the same way; the meeting is unaffected for everyone else.
      await exclude(s, anon);
      await s.as("legal");
      expect((await sees(s, f.meeting)).meeting).toBe(1);

      // A closed meeting excludes nobody.
      const w2 = await invite(s, f.meeting, USERS.financeEmployee);
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      await s.expectError("CDF_CONFLICT:MEETING_NOT_ACTIVE", () => exclude(s, w2));

      // Nor does a meeting whose case is no longer active.
      const g = await another(s, f.committeeProceeding);
      const w3 = await invite(s, g, USERS.financeEmployee);
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', ${REASON})`;
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:CASE_NOT_ACTIVE", () => exclude(s, w3));
    });
  });

  it("the catalogue follows: S112 and T3-B2.4-241 are delivered; the evidence half of P11-G4 stays open", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      const statuses = await s.tx<
        { catalogue: string; target_event_state: string; gap_ref: string | null }[]
      >`
        select catalogue, target_event_state, gap_ref from config.legacy_status_map
        where legacy_code = 'S112' order by catalogue collate "C"`;
      expect(statuses).toEqual([
        { catalogue: "CRM_STATUS_DRIVE_150", target_event_state: "IMPLEMENTED", gap_ref: null },
        { catalogue: "CRM_STATUS_D_140", target_event_state: "IMPLEMENTED", gap_ref: null },
      ]);
      const [form] = await s.tx<{ merge_target: string; gap_ref: string | null }[]>`
        select merge_target, gap_ref from config.legacy_form_map where legacy_id = 'T3-B2.4-241'`;
      expect(form!.gap_ref).toBeNull();
      expect(form!.merge_target).toMatch(/^api\.exclude_meeting_witness /);
      const open = await s.tx<{ id: string }[]>`
        select legacy_id as id from config.legacy_form_map where gap_ref = 'P11-G4'
        union all select legacy_code from config.legacy_status_map where gap_ref = 'P11-G4'`;
      expect(open.map((r) => r.id).sort()).toEqual(["S083", "S083", "T3-B2.3-112", "T3-B2.3-144"]);
      const [mod] = await s.tx<{ commands: string[]; delivered_in: string[] }[]>`
        select commands, delivered_in from config.target_module where code = 'MEETING_WITNESSES'`;
      expect(mod!.commands).toContain("api.exclude_meeting_witness");
      expect(mod!.delivered_in).toContain("2010");
    });
  });
});
