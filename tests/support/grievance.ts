// Decision-notice and grievance fixtures for the migration 2040 security tests (DEC-F15, DEC-AMB-001, -004, -011).
// Every step runs through the api.* commands as the acting user, except oldDeliveryNotice, which back-dates a notice
// on the owner connection because commands always issue at now().
import type { Tx } from "@cdf/infrastructure";
import { USERS, type OwnerScenario, type Scenario, type UserKey } from "./db";
import { REASON } from "./committee";

export const NOTICE_TEXT = "Synthetic: unique-notice-marker-2040 for the subject.";
export const GRIEVANCE_GROUNDS = "Synthetic: unique-grounds-marker-2040, the decision ignored my defence.";
export const DELIVERY_REF = "HAND-DEMO-2040-unique-delivery-marker";

/** The Grievance Committee seats used by the 2040 grievance tests. */
export const GRIEVANCE_SEATS: [UserKey, string][] = [
  ["committee", "CHAIR"],
  ["committeeSecretary", "SECRETARY"],
  ["legal", "MEMBER"],
  ["investigatorA", "MEMBER"],
];

/** The case manager issues the DECISION notice of `decision` to `subject`; returns the notice. */
export async function decisionNotice(s: Scenario, subject: string, decision: string): Promise<string> {
  await s.as("caseManager");
  const [n] = await s.tx<{ id: string }[]>`
    select api.issue_decision_notice(${subject}, ${decision}, ${NOTICE_TEXT}) as id`;
  return n!.id;
}

/** The case manager records the hand delivery of `notice`, `agoDays` ago; returns the grievance window end. */
export async function recordDelivery(s: Scenario, notice: string, agoDays = 0): Promise<string | null> {
  await s.as("caseManager");
  const [r] = await s.tx<{ ends: string | null }[]>`
    select api.record_notice_delivery(${notice}, 'HAND_DELIVERY', now() - make_interval(days => ${agoDays}::int),
      ${DELIVERY_REF}) as ends`;
  return r!.ends;
}

/** The acting subject files a grievance on `notice`, naming contested items or none (the whole decision). */
export const fileOnNotice = (s: Scenario, notice: string, items: string[] | null = null) =>
  s.tx<{ id: string }[]>`
    select api.file_grievance_on_decision_notice(${notice}, ${GRIEVANCE_GROUNDS}, ${items}::uuid[]) as id`;

/** A DECISION notice issued `days` ago on the DELIVERY basis, not yet delivered (owner fixture: commands issue at
 *  now()). */
export async function oldDeliveryNotice(
  s: OwnerScenario,
  caseId: string,
  grievanceCommittee: string,
  subject: string,
  decision: string,
  days: number,
): Promise<string> {
  await s.asOwner();
  const [n] = await s.tx<{ id: string }[]>`
    insert into grievance.defence_notice (case_id, subject_id, sequence_no, notice_text, issued_by, issued_at, kind,
                                          authority_decision_id, grievance_rule_set_id, grievance_window_days,
                                          window_start_basis)
    select ${caseId}, ${subject}, 9, ${NOTICE_TEXT}, ${USERS.caseManager}, now() - make_interval(days => ${days}::int),
           'DECISION', ${decision}, r.id, 30, 'DELIVERY'
    from committee.rule_set r where r.committee_id = ${grievanceCommittee} and r.effective_to is null
    returning id`;
  return n!.id;
}

/** The Grievance Committee approves one vote item in the admitted grievance's proceeding; returns the item. */
export async function approvedGrievanceVote(s: Scenario, grievance: string): Promise<string> {
  await s.as("committeeSecretary");
  const [g] = await s.tx<{ cp: string }[]>`
    select committee_proceeding_id as cp from grievance.grievance where id = ${grievance}`;
  const [m] = await s.tx<{ id: string }[]>`
    select api.schedule_meeting(${g!.cp}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
      now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
  const parts = await s.tx<{ id: string; user_id: string }[]>`
    select id, user_id from committee.meeting_participant where meeting_id = ${m!.id} and is_voting`;
  const key = (id: string) => Object.entries(USERS).find(([, v]) => v === id)![0] as UserKey;
  for (const p of parts) {
    await s.as(key(p.user_id));
    await s.tx`select api.declare_meeting_conflict(${p.id}, 'NO_CONFLICT', null)`;
  }
  await s.as("committeeSecretary");
  await s.tx`select api.open_meeting(${m!.id}, ${REASON})`;
  for (const p of parts) await s.tx`select api.record_attendance(${p.id}, 'PRESENT')`;
  const [vi] = await s.tx<{ id: string }[]>`
    select api.open_vote_item(${m!.id}, 'OTHER', null, 'Grievance outcome (synthetic)') as id`;
  for (const p of parts) {
    await s.as(key(p.user_id));
    await s.tx`select api.cast_vote(${vi!.id}, 'APPROVE', null)`;
  }
  await s.as("committeeSecretary");
  await s.tx`select api.close_vote_item(${vi!.id}, null)`;
  return vi!.id;
}

/** The platform administrator (COMMITTEE_ADMIN) configures a sanction type (DEC-AMB-004, DEC-AMB-011). Synthetic
 *  values for the test only: the catalogue's configuration is SOURCE_REQUIRED. */
export async function setSanctionRule(
  s: Scenario,
  code: string,
  rank: number | null,
  irreversible: boolean,
  rule: "SUSPEND_UNTIL_RESOLVED" | "PROCEED",
): Promise<string> {
  await s.as("platformAdmin");
  const [r] = await s.tx<{ id: string }[]>`
    select api.set_sanction_rule(${code}, ${rank}::int, ${irreversible}, ${rule}, 'SOURCE_REQUIRED',
      'Synthetic: sanction rule for the test only.',
      (select row_version from decision.sanction_catalogue where code = ${code})) as id`;
  return r!.id;
}

/** The case manager records the execution of `item` on `subject`, effective `from` ago. */
export const executeSanction = (s: Scenario, item: string, subject: string, from = "0 days") =>
  s.tx`select api.record_sanction_execution(${item}, ${subject}, now() - ${from}::interval, 'HR-DEMO-2040') as id`;

class Undo extends Error {}

/** Runs `fn` in a savepoint and rolls it back afterwards, so one fixture can show several successful alternatives. */
export async function thenUndo(s: Scenario, fn: (tx: Tx) => Promise<unknown>): Promise<void> {
  try {
    await s.tx.savepoint(async (sp) => {
      await fn(sp as unknown as Tx);
      throw new Undo();
    });
  } catch (error) {
    if (!(error instanceof Undo)) throw error;
  }
}

/** The case manager concludes a decided grievance's committee proceeding, so that a later grievance on the case can be
 *  admitted (one open GRIEVANCE proceeding per case, migration 1870). */
export async function concludeGrievanceProceeding(s: Scenario, grievance: string): Promise<void> {
  await s.as("caseManager");
  const [p] = await s.tx<{ id: string }[]>`
    select cp.proceeding_id as id from grievance.grievance g
    join committee.committee_proceeding cp on cp.id = g.committee_proceeding_id where g.id = ${grievance}`;
  await s.tx`select api.close_proceeding(${p!.id}, 'CONCLUDED', 'DECISION_RECORDED', ${REASON})`;
}
