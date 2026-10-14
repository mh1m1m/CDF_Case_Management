// Committee fixtures for the rebase security tests (migrations 1870, 1890 and 2030). Every call runs through the api.*
// commands as the acting user; nothing is inserted directly.
import { USERS, admin, type Scenario, type UserKey } from "./db";

export const REASON = "Synthetic: committee meeting test.";

export async function committeeIds(): Promise<{ ic: string; gc: string }> {
  const rows = await admin<{ code: string; id: string }[]>`select code, id from committee.committee`;
  return { ic: rows.find((r) => r.code === "IC")!.id, gc: rows.find((r) => r.code === "GC")!.id };
}

/** Appointment-reference prefix of the demo seats in infrastructure/supabase/seed/30_synthetic_committee_seats.sql. */
export const DEMO_SEAT_REFERENCE = "SEED-DEMO-COMMITTEE-";

/**
 * Ends the seeded demo seats on IC and GC inside the test's own transaction, which rolls back with it, so every test
 * starts with both committees unseated as before the demo seed. Each seat ends one second after it began, through
 * api.end_committee_membership as the platform admin, so it overlaps no seat a test appoints. Leaves the platform
 * admin acting; a no-op once the seats are ended.
 */
export async function unseatDemoSeats(s: Scenario): Promise<void> {
  await s.as("platformAdmin");
  await s.tx`
    select api.end_committee_membership(m.id, m.effective_from + interval '1 second',
      'Synthetic: the test starts with the committee unseated.')
    from committee.membership m
    where m.appointment_reference like ${DEMO_SEAT_REFERENCE + "%"} and m.ended_at is null
    order by m.id`;
}

/** Seats the given users on a committee from yesterday, as the platform admin, after ending the demo seats. */
export async function seat(s: Scenario, committeeId: string, seats: [UserKey, string][]): Promise<void> {
  await unseatDemoSeats(s);
  for (const [user, seatCode] of seats) {
    await s.tx`select api.appoint_committee_member(${committeeId}, ${USERS[user]}, ${seatCode}, now() - interval '1 day', null, 'DEMO-APPT')`;
  }
}

/** Chair, secretary and three voting members: legal, legalB and lead. */
export const IC_SEATS: [UserKey, string][] = [
  ["committeeChair", "CHAIR"],
  ["committeeSecretary", "SECRETARY"],
  ["legal", "MEMBER"],
  ["legalB", "MEMBER"],
  ["lead", "MEMBER"],
];

/**
 * AMB-018 (migration 2030): a case that did not arrive as a direct referral reaches the Investigation Committee only
 * after its preliminary review concluded REFERRED_TO_COMMITTEE with the approver's approval. The GRC Director prepares
 * the recommendation (no review step, Q15) and the GRC Sector Head approves it. On a restricted case the approver sees
 * nothing without an explicit grant (fail safe), so the case owner grants case access (a REVIEW grant is refused since
 * migration 2020, DEC-02) and revokes it afterwards. Does nothing when the case's latest approved recommendation
 * already refers it, or when the case is a direct referral.
 */
export async function preliminaryReferral(s: Scenario, caseId: string): Promise<void> {
  await s.as("grcDirector");
  const [c] = await s.tx<{ is_restricted: boolean; needed: boolean }[]>`
    select c.is_restricted,
           c.source_type not in ('DIRECT_REFERRAL', 'DIRECT_GRIEVANCE')
           and coalesce((select r.recommended_outcome from case_mgmt.preliminary_recommendation r
                         join case_mgmt.proceeding p on p.id = r.proceeding_id
                         where r.case_id = c.id and r.status = 'APPROVED'
                         order by r.approved_at desc, p.sequence_no desc, r.version_no desc limit 1), '')
               <> 'REFERRED_TO_COMMITTEE' as needed
    from case_mgmt.case_record c where c.id = ${caseId}`;
  if (!c) throw new Error("preliminaryReferral: the GRC Director cannot see the case");
  if (!c.needed) return;
  const [r] = await s.tx<{ id: string }[]>`
    select api.prepare_preliminary_recommendation(${caseId}, 'REFERRED_TO_COMMITTEE',
      'Synthetic: serious enough for the Investigation Committee.') as id`;
  let grant: string | undefined;
  if (c.is_restricted) {
    const [g] = await s.tx<{ id: string }[]>`
      select api.grant_case_access(${caseId}, ${USERS.grcSectorHead}, 'CASE', ${REASON}, null) as id`;
    grant = g!.id;
  }
  await s.as("grcSectorHead");
  await s.tx`select api.approve_preliminary_recommendation(${r!.id}, 'APPROVE', null, null)`;
  if (grant) {
    await s.as("grcDirector");
    await s.tx`select api.revoke_case_access(${grant}, ${REASON})`;
  }
}

/** Refers the case; to the Investigation Committee after its preliminary review referred it (AMB-018). */
export async function refer(
  s: Scenario,
  committeeId: string,
  caseId: string,
  by: UserKey = "caseManager",
  parentProceeding: string | null = null,
) {
  await unseatDemoSeats(s);
  const [k] = await admin<{ kind: string }[]>`select kind from committee.committee where id = ${committeeId}`;
  if (k?.kind === "INVESTIGATION") await preliminaryReferral(s, caseId);
  await s.as(by);
  const [cp] = await s.tx<{ id: string }[]>`
    select api.refer_case_to_committee(${caseId}, ${committeeId}, ${parentProceeding}, ${REASON}) as id`;
  return cp!.id;
}

export interface MeetingFixture {
  committeeProceeding: string;
  meeting: string;
  participant: Record<string, string>;
}

/** Refers the case (from `parentProceeding`, if given), schedules an in-person deliberation and returns its
 *  participants by user key. */
export async function scheduleMeeting(
  s: Scenario,
  committeeId: string,
  caseId: string,
  parentProceeding: string | null = null,
): Promise<MeetingFixture> {
  const committeeProceeding = await refer(s, committeeId, caseId, "caseManager", parentProceeding);
  await s.as("committeeSecretary");
  const [m] = await s.tx<{ id: string }[]>`
    select api.schedule_meeting(${committeeProceeding}, 'DELIBERATION', 'IN_PERSON', 'Meeting room (synthetic)', null,
      now() + interval '1 day', now() + interval '1 day 2 hours', ${REASON}) as id`;
  const rows = await s.tx<{ id: string; user_id: string }[]>`
    select id, user_id from committee.meeting_participant where meeting_id = ${m!.id}`;
  const byUser = Object.fromEntries(Object.entries(USERS).map(([key, id]) => [id, key] as const)) as Record<
    string,
    string
  >;
  const participant: Record<string, string> = {};
  for (const r of rows) participant[byUser[r.user_id]!] = r.id;
  return { committeeProceeding, meeting: m!.id, participant };
}

/** Each listed member declares no conflict; the secretary opens the meeting and records them present. */
export async function openWithPresent(s: Scenario, f: MeetingFixture, present: UserKey[]): Promise<void> {
  for (const user of present) {
    await s.as(user);
    await s.tx`select api.declare_meeting_conflict(${f.participant[user]!}, 'NO_CONFLICT', null)`;
  }
  await s.as("committeeSecretary");
  await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
  for (const user of present) {
    await s.tx`select api.record_attendance(${f.participant[user]!}, 'PRESENT')`;
  }
}

export async function openItem(
  s: Scenario,
  meeting: string,
  title = "Recommendation (synthetic)",
): Promise<string> {
  await s.as("committeeSecretary");
  const [v] = await s.tx<
    { id: string }[]
  >`select api.open_vote_item(${meeting}, 'OTHER', null, ${title}) as id`;
  return v!.id;
}

export async function vote(s: Scenario, user: UserKey, item: string, choice: string): Promise<void> {
  await s.as(user);
  await s.tx`select api.cast_vote(${item}, ${choice}, null)`;
}
