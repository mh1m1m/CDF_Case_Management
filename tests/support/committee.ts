// Committee fixtures for the rebase security tests (migrations 1870 and 1890). Every call runs through the api.*
// commands as the acting user; nothing is inserted directly.
import { USERS, admin, type Scenario, type UserKey } from "./db";

export const REASON = "Synthetic: committee meeting test.";

export async function committeeIds(): Promise<{ ic: string; gc: string }> {
  const rows = await admin<{ code: string; id: string }[]>`select code, id from committee.committee`;
  return { ic: rows.find((r) => r.code === "IC")!.id, gc: rows.find((r) => r.code === "GC")!.id };
}

/** Seats the given users on a committee from yesterday, as the platform admin. */
export async function seat(s: Scenario, committeeId: string, seats: [UserKey, string][]): Promise<void> {
  await s.as("platformAdmin");
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

export async function refer(s: Scenario, committeeId: string, caseId: string, by: UserKey = "caseManager") {
  await s.as(by);
  const [cp] = await s.tx<{ id: string }[]>`
    select api.refer_case_to_committee(${caseId}, ${committeeId}, null, ${REASON}) as id`;
  return cp!.id;
}

export interface MeetingFixture {
  committeeProceeding: string;
  meeting: string;
  participant: Record<string, string>;
}

/** Refers the case, schedules an in-person deliberation and returns its participants by user key. */
export async function scheduleMeeting(
  s: Scenario,
  committeeId: string,
  caseId: string,
): Promise<MeetingFixture> {
  const committeeProceeding = await refer(s, committeeId, caseId);
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
